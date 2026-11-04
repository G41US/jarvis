"""
delivery.py - Jarvis delivery copilot.

What it does
------------
Takes the orders YOU tell Jarvis about (by voice, typing, or a screen read of an
offer), stacks up to four of them, and finds the stop order with the best
overall result: shortest total time, no late drop-offs, food not sitting in the
bag. It also tells you whether a new offer is worth taking.

What it deliberately does NOT do
--------------------------------
DoorDash, Uber Eats and Grubhub give drivers no API, and automating their driver
apps breaks their terms (it can get an account deactivated). So Jarvis never logs
into those apps or taps accept for you. You accept in the app; Jarvis plans.

Data sources (all free, no keys)
--------------------------------
* Geocoding : OpenStreetMap Nominatim, Photon as fallback.
* Drive times: OSRM public server. It has NO live traffic, so a traffic_factor
               (default 1.15) is applied. If OSRM is down, Jarvis falls back to
               straight-line distance x detour factor and says the numbers are
               estimates.

This module has no dependency on server.py so it can be tested on its own.
"""
import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from contextlib import closing

MAX_STACK = 4
METERS_PER_MILE = 1609.344

DEFAULTS = {
    # Towns Jarvis tries, in order, when an address has no town/state in it.
    "areas": [],
    "country_codes": "",          # "" = anywhere in the world; e.g. "us" or "ng,gh" to restrict
    # Time spent at each kind of stop (seconds).
    "pickup_dwell_s": 150,
    "same_stop_dwell_s": 30,      # second order picked up at the same restaurant
    "drop_dwell_s": 120,
    # Food freshness. Past fresh_limit the plan is penalised; past hard_limit heavily.
    "fresh_limit_min": 20,
    "hard_limit_min": 35,
    # Penalty weights (1 second late costs this many "seconds of driving").
    "late_weight": 3.0,
    "cold_weight": 1.0,
    "hard_weight": 4.0,
    # Customer promise when the offer doesn't say: minutes after you accepted it.
    "default_deadline_min": 45,
    # OSRM has no live traffic; scale its times up a little.
    "traffic_factor": 1.15,
    "fallback_kmh": 40.0,
    "detour_factor": 1.35,
    # Offer evaluation thresholds. Tune to your own costs (gas, wear, taxes).
    "min_per_mile": 1.50,         # per mile, or per kilometer when units are km
    "currency": "$",              # symbol used when Jarvis talks about money, e.g. "$", "£", "€", "₦"
    "units": "auto",              # auto (from where you are) | miles | km
    "min_per_hour": 18.0,
    "osrm_url": "https://router.project-osrm.org",
    "user_agent": "JarvisDeliveryCopilot/1.0 (personal use)",
}

PLATFORM_ALIASES = {
    "doordash": "DoorDash", "door dash": "DoorDash", "dd": "DoorDash", "dasher": "DoorDash",
    "ubereats": "Uber Eats", "uber eats": "Uber Eats", "uber": "Uber Eats",
    "grubhub": "Grubhub", "grub hub": "Grubhub",
    "instacart": "Instacart", "shipt": "Shipt", "spark": "Spark",
}


def normalize_platform(p):
    k = (p or "").strip().lower()
    if not k:
        return "DoorDash"
    return PLATFORM_ALIASES.get(k, k.title())


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def clock(ts):
    return time.strftime("%I:%M %p", time.localtime(ts)).lstrip("0")


def short_addr(a):
    return (a or "").split(",")[0].strip() or "the address"


def tidy_addr(a):
    """'100 elm st' -> '100 Elm St' (leaves '3rd' alone)."""
    a = re.sub(r"\s+", " ", (a or "")).strip()
    return " ".join(w if (w[:1].isdigit() or w.isupper()) else w.capitalize() for w in a.split(" "))


def _looks_complete(text):
    """True when the address already names a town/state or zip, so we shouldn't add one."""
    t = text.strip()
    if re.search(r"\b\d{5}(-\d{4})?\b", t):
        return True
    if re.search(r",\s*[A-Za-z .'-]+,\s*[A-Za-z]{2}\b", t):
        return True
    if re.search(r",\s*(KY|OH|WV|VA|TN|IN|Kentucky|Ohio|West Virginia)\b", t, re.I):
        return True
    return t.count(",") >= 2          # "12 Allen Avenue, Ikeja, Lagos" already names the town


class Copilot:
    def __init__(self, db_path, cfg=None, broadcast=None, http_get=None, matrix_fn=None):
        self.db_path = db_path
        self.cfg = dict(DEFAULTS)
        self.cfg.update(cfg or {})
        self.broadcast = broadcast or (lambda msg: None)
        self._http_get_fn = http_get          # injectable for tests
        self._matrix_fn = matrix_fn           # injectable for tests
        self._geo_lock = threading.Lock()
        self._last_geo_call = 0.0
        self._matrix_cache = {}
        self._last_plan = None
        u = str(self.cfg.get("units", "auto")).lower()
        self.units = "km" if u in ("km", "kilometers", "kilometres", "metric") else "miles"
        self._units_fixed = u in ("miles", "mi", "km", "kilometers", "kilometres", "metric")
        self._init_db()

    # ------------------------------------------------------- units / money
    @property
    def unit_m(self):
        return 1000.0 if self.units == "km" else METERS_PER_MILE

    @property
    def unit_word(self):
        return "kilometers" if self.units == "km" else "miles"

    @property
    def unit_short(self):
        return "km" if self.units == "km" else "mi"

    def set_units(self, units):
        """Server calls this once it knows the country. Ignored when the config pins the units."""
        if self._units_fixed:
            return
        self.units = "km" if units == "km" else "miles"
        self._last_plan = None

    def money(self, v, decimals=2):
        return f"{self.cfg.get('currency', '$')}{float(v):.{decimals}f}"

    # ------------------------------------------------------------------ db
    def _init_db(self):
        with closing(sqlite3.connect(self.db_path)) as c:
            c.execute("""CREATE TABLE IF NOT EXISTS delivery_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, restaurant TEXT,
                pickup_addr TEXT, pickup_lat REAL, pickup_lon REAL,
                drop_addr TEXT, drop_lat REAL, drop_lon REAL,
                payout REAL DEFAULT 0, ready_at REAL, deadline_at REAL,
                status TEXT DEFAULT 'active', picked_at REAL, created_at REAL)""")
            c.execute("CREATE TABLE IF NOT EXISTS delivery_state (k TEXT PRIMARY KEY, v TEXT)")
            c.execute("""CREATE TABLE IF NOT EXISTS geo_cache (
                q TEXT PRIMARY KEY, lat REAL, lon REAL, display TEXT, ts REAL)""")
            # Earnings log. Holds NO customer address, by design.
            c.execute("""CREATE TABLE IF NOT EXISTS delivery_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, restaurant TEXT,
                payout REAL, accepted_at REAL, delivered_at REAL)""")
            c.commit()

    def _get_state(self, k, default=None):
        with closing(sqlite3.connect(self.db_path)) as c:
            r = c.execute("SELECT v FROM delivery_state WHERE k=?", (k,)).fetchone()
        if not r:
            return default
        try:
            return json.loads(r[0])
        except Exception:
            return default

    def _set_state(self, k, v):
        with closing(sqlite3.connect(self.db_path)) as c:
            if v is None:
                c.execute("DELETE FROM delivery_state WHERE k=?", (k,))
            else:
                c.execute("INSERT OR REPLACE INTO delivery_state (k, v) VALUES (?, ?)", (k, json.dumps(v)))
            c.commit()

    def active_orders(self):
        with closing(sqlite3.connect(self.db_path)) as c:
            c.row_factory = sqlite3.Row
            rows = c.execute("SELECT * FROM delivery_orders WHERE status IN ('active','picked') ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    def has_active(self):
        return len(self.active_orders()) > 0

    # ----------------------------------------------------------- geocoding
    def _http_get(self, url, params):
        if self._http_get_fn:
            return self._http_get_fn(url, params)
        import requests
        try:
            r = requests.get(url, params=params, timeout=8,
                             headers={"User-Agent": self.cfg["user_agent"]})
            if r.status_code == 200:
                return r.json()
        except Exception as e:
            print(f"[DELIVERY] http fail {url}: {type(e).__name__}")
        return None

    def _throttle(self):
        # Nominatim's usage policy: at most one request per second.
        with self._geo_lock:
            wait = 1.1 - (time.time() - self._last_geo_call)
            if wait > 0 and not self._http_get_fn:
                time.sleep(wait)
            self._last_geo_call = time.time()

    def _viewbox(self):
        loc = self._get_state("loc")
        if not loc:
            return None
        d = 0.25  # roughly 25 km each way
        return f"{loc['lon'] - d},{loc['lat'] + d},{loc['lon'] + d},{loc['lat'] - d}"

    def _nominatim(self, q):
        params = {"q": q, "format": "jsonv2", "limit": 1, "addressdetails": 1}
        if self.cfg.get("country_codes"):
            params["countrycodes"] = self.cfg["country_codes"]
        vb = self._viewbox()
        if vb:
            params["viewbox"] = vb
        self._throttle()
        res = self._http_get("https://nominatim.openstreetmap.org/search", params)
        if res:
            r = res[0]
            a = r.get("address") or {}
            town = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or a.get("county") or ""
            area = f"{town}, {a.get('state', '')}".strip(", ")
            street = f"{a.get('house_number', '')} {a.get('road', '')}".strip()
            return {"lat": float(r["lat"]), "lon": float(r["lon"]),
                    "display": r.get("display_name", q), "area": area, "short": street}
        return None

    def _photon(self, q):
        params = {"q": q, "limit": 1}
        loc = self._get_state("loc")
        if loc:
            params.update(lat=loc["lat"], lon=loc["lon"])
        res = self._http_get("https://photon.komoot.io/api/", params)
        feats = (res or {}).get("features") or []
        if feats:
            f = feats[0]
            lon, lat = f["geometry"]["coordinates"]
            p = f.get("properties") or {}
            disp = ", ".join(x for x in [p.get("name"), p.get("street"), p.get("city"), p.get("state")] if x)
            return {"lat": float(lat), "lon": float(lon), "display": disp or q,
                    "area": f"{p.get('city', '')}, {p.get('state', '')}".strip(", "),
                    "short": f"{p.get('housenumber', '')} {p.get('street', '')}".strip()}
        return None

    def _candidates(self, text):
        if _looks_complete(text):
            return [text]
        cur = self._get_state("area")
        areas = [cur] if cur else list(self.cfg["areas"])       # where you are now beats the static list
        return [f"{text}, {a}" for a in areas] + [text]

    def geocode(self, text, cache=True):
        """Returns {'lat','lon','display','area'} or None. Customer addresses pass cache=False."""
        text = re.sub(r"\s+", " ", (text or "")).strip()
        if not text:
            return None
        key = text.lower()
        use_cache = cache and bool(re.search(r"\d", text))   # chains without a street number vary by location
        if use_cache:
            with closing(sqlite3.connect(self.db_path)) as c:
                r = c.execute("SELECT lat, lon, display FROM geo_cache WHERE q=?", (key,)).fetchone()
            if r:
                return {"lat": r[0], "lon": r[1], "display": r[2], "area": "", "short": short_addr(r[2])}
        cands = self._candidates(text)
        hit = None
        for q in cands:
            hit = self._nominatim(q)
            if hit:
                break
        if not hit:
            for q in cands[:2]:
                hit = self._photon(q)
                if hit:
                    break
        if hit and use_cache:
            with closing(sqlite3.connect(self.db_path)) as c:
                c.execute("INSERT OR REPLACE INTO geo_cache (q, lat, lon, display, ts) VALUES (?,?,?,?,?)",
                          (key, hit["lat"], hit["lon"], hit["display"], time.time()))
                c.commit()
        return hit

    # -------------------------------------------------------------- routing
    def matrix(self, pts):
        """pts = [(lat, lon), ...] -> (durations_s, distances_m, source). Never raises."""
        if self._matrix_fn:
            return self._matrix_fn(pts)
        key = tuple((round(a, 5), round(b, 5)) for a, b in pts)
        hit = self._matrix_cache.get(key)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        n = len(pts)
        tf = float(self.cfg["traffic_factor"])
        D = [[0.0] * n for _ in range(n)]
        M = [[0.0] * n for _ in range(n)]
        source = "osrm"
        coords = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in pts)
        data = self._http_get(f"{self.cfg['osrm_url']}/table/v1/driving/{coords}",
                              {"annotations": "duration,distance"})
        ok = bool(data and data.get("code") == "Ok" and data.get("durations") and data.get("distances"))
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                d = m = None
                if ok:
                    d = data["durations"][i][j]
                    m = data["distances"][i][j]
                if d is None or m is None:
                    source = "estimate"
                    straight = haversine_m(pts[i][0], pts[i][1], pts[j][0], pts[j][1])
                    m = straight * float(self.cfg["detour_factor"])
                    d = m / (float(self.cfg["fallback_kmh"]) * 1000.0 / 3600.0)
                D[i][j] = d * tf
                M[i][j] = m
        result = (D, M, source)
        self._matrix_cache[key] = (time.time(), result)
        return result

    # ------------------------------------------------------------ optimizer
    def solve(self, orders, start, now):
        """
        Exhaustive search over every stop order that puts each pickup before its
        drop-off (at most 2520 orders for four orders), scored by:
          total time + late_weight * lateness + cold_weight * food-over-fresh-limit
          + hard_weight * food-over-hard-limit
        Exhaustive means the answer is the true optimum for the model, not a heuristic.
        """
        cfg = self.cfg
        nodes = []
        for oi, o in enumerate(orders):
            if o["status"] == "active":
                nodes.append({"kind": "pickup", "oi": oi, "lat": o["pickup_lat"], "lon": o["pickup_lon"]})
            nodes.append({"kind": "drop", "oi": oi, "lat": o["drop_lat"], "lon": o["drop_lon"]})
        N = len(nodes)
        pts = ([(start["lat"], start["lon"])] if start else []) + [(n["lat"], n["lon"]) for n in nodes]
        off = 1 if start else 0
        D, M, source = self.matrix(pts)
        for k, n in enumerate(nodes):
            n["mi"] = k + off
        pick_node = {n["oi"]: k for k, n in enumerate(nodes) if n["kind"] == "pickup"}

        fresh = cfg["fresh_limit_min"] * 60
        hard = cfg["hard_limit_min"] * 60
        pd, sd, dd = cfg["pickup_dwell_s"], cfg["same_stop_dwell_s"], cfg["drop_dwell_s"]

        def deadline_of(o):
            if o.get("deadline_at"):
                return o["deadline_at"]
            return (o.get("created_at") or now) + cfg["default_deadline_min"] * 60

        def evaluate(seq, detail=False):
            t = now
            prev_mi = 0 if start else None
            prev_node = None
            picked_at = {oi: o.get("picked_at") or now for oi, o in enumerate(orders)}
            dist = 0.0
            pen = 0.0
            late_total = 0.0
            rows = []
            for k in seq:
                n = nodes[k]
                if prev_mi is None:
                    leg_s = leg_m = 0.0
                else:
                    leg_s, leg_m = D[prev_mi][n["mi"]], M[prev_mi][n["mi"]]
                t += leg_s
                dist += leg_m
                arrive = t
                wait = 0.0
                late = 0.0
                age = None
                slack = None
                o = orders[n["oi"]]
                if n["kind"] == "pickup":
                    ready = o.get("ready_at") or now
                    wait = max(0.0, ready - t)
                    t += wait
                    same = (prev_node is not None and prev_node["kind"] == "pickup"
                            and haversine_m(prev_node["lat"], prev_node["lon"], n["lat"], n["lon"]) < 60)
                    t += sd if same else pd
                    picked_at[n["oi"]] = t
                else:
                    t += dd
                    age = t - picked_at[n["oi"]]
                    late = max(0.0, t - deadline_of(o))
                    slack = deadline_of(o) - t
                    late_total += late
                    pen += cfg["late_weight"] * late
                    pen += cfg["cold_weight"] * max(0.0, age - fresh)
                    pen += cfg["hard_weight"] * max(0.0, age - hard)
                if detail:
                    rows.append({"k": k, "arrive": arrive, "wait_s": wait, "done": t,
                                 "leg_s": leg_s, "leg_m": leg_m, "late_s": late, "age_s": age, "slack_s": slack})
                prev_mi, prev_node = n["mi"], n
            cost = (t - now) + pen
            return cost, t, dist, late_total, rows

        def gen(seq, used):
            if len(seq) == N:
                yield list(seq)
                return
            for k in range(N):
                if k in used:
                    continue
                nd = nodes[k]
                if nd["kind"] == "drop" and nd["oi"] in pick_node and pick_node[nd["oi"]] not in used:
                    continue
                used.add(k)
                seq.append(k)
                yield from gen(seq, used)
                seq.pop()
                used.discard(k)

        best_seq, best_cost = None, float("inf")
        for seq in gen([], set()):
            cost = evaluate(seq)[0]
            if cost < best_cost - 1e-9:
                best_cost, best_seq = cost, seq
        cost, t_end, dist, late_total, rows = evaluate(best_seq, detail=True)

        # Baseline: do it in the order the orders came in (all pickups, then all drops).
        naive = [k for k, n in enumerate(nodes) if n["kind"] == "pickup"] + \
                [k for k, n in enumerate(nodes) if n["kind"] == "drop"]
        n_cost, n_end, n_dist, n_late, _ = evaluate(naive)

        stops = []
        for i, r in enumerate(rows):
            n = nodes[r["k"]]
            o = orders[n["oi"]]
            is_pick = n["kind"] == "pickup"
            addr = o["pickup_addr"] if is_pick else o["drop_addr"]
            stops.append({
                "seq": i + 1, "kind": n["kind"], "order_id": o.get("id"),
                "platform": o["platform"], "restaurant": o["restaurant"],
                "label": (f"Pick up at {o['restaurant']}" if is_pick
                          else f"Drop off {o['restaurant']} order"),
                "addr": addr, "short_addr": short_addr(addr),
                "lat": n["lat"], "lon": n["lon"],
                "eta_ts": r["arrive"], "eta_clock": clock(r["arrive"]),
                "mins": max(0, int(round((r["arrive"] - now) / 60.0))),
                "wait_min": int(round(r["wait_s"] / 60.0)),
                "leg_min": round(r["leg_s"] / 60.0, 1),
                "leg_mi": round(r["leg_m"] / self.unit_m, 1),
                "late_min": int(round(r["late_s"] / 60.0)),
                "food_age_min": None if r["age_s"] is None else int(round(r["age_s"] / 60.0)),
            })
            # ETA range (the map service has no live traffic, so late is likelier than early) and on-time risk.
            el = max(0.0, r["arrive"] - now)
            spread = max(60.0, 0.15 * el)
            stops[-1]["eta_lo"] = clock(r["arrive"] - 0.6 * spread)
            stops[-1]["eta_hi"] = clock(r["arrive"] + 1.6 * spread)
            stops[-1]["mins_lo"] = max(0, int(round((el - 0.6 * spread) / 60.0)))
            stops[-1]["mins_hi"] = int(round((el + 1.6 * spread) / 60.0))
            if not is_pick:
                slack_min = r["slack_s"] / 60.0
                margin = (1.6 * spread) / 60.0          # how much later than planned it could plausibly run
                stops[-1]["slack_min"] = int(round(slack_min))
                stops[-1]["risk"] = ("high" if slack_min < 0.5 * margin else
                                     "medium" if slack_min < 1.5 * margin + 2 else "low")
        payout = sum(float(o.get("payout") or 0) for o in orders)
        total_s = t_end - now
        miles = dist / self.unit_m
        plan = {
            "ok": True, "source": source, "generated_at": now,
            "orders": len(orders), "stops": stops,
            "total_min": int(round(total_s / 60.0)), "total_s": total_s,
            "total_miles": round(miles, 1), "payout": round(payout, 2),
            "currency": self.cfg.get("currency", "$"), "unit": self.unit_short, "unit_word": self.unit_word,
            "per_hour": round(payout / (total_s / 3600.0), 2) if total_s > 60 and payout else 0.0,
            "per_mile": round(payout / miles, 2) if miles > 0.05 and payout else 0.0,
            "late_total_s": late_total,
            "naive_total_min": int(round((n_end - now) / 60.0)),
            "naive_late_min": int(round(n_late / 60.0)),
            "best_late_min": int(round(late_total / 60.0)),
            "saved_min": max(0, int(round((n_end - t_end) / 60.0))),          # real clock time saved
            "late_avoided_min": max(0, int(round((n_late - late_total) / 60.0))),
            "cold_avoided": n_cost - cost > 600 and n_end - t_end < 60,
            "start": start,
            "warnings": [],
        }
        for s in stops:
            if s["kind"] == "drop" and s["late_min"] >= 2:
                plan["warnings"].append(f"{s['restaurant']} order will be about {s['late_min']} minutes late.")
            if s["kind"] == "drop" and s["food_age_min"] and s["food_age_min"] > cfg["fresh_limit_min"]:
                plan["warnings"].append(f"{s['restaurant']} food will sit in the bag about {s['food_age_min']} minutes.")
            if s["kind"] == "pickup" and s["wait_min"] >= 3:
                plan["warnings"].append(f"Expect to wait about {s['wait_min']} minutes at {s['restaurant']}.")
        if source == "estimate":
            plan["warnings"].append("Map service unreachable, so times are straight-line estimates.")
        order_rank = {"low": 0, "medium": 1, "high": 2}
        risks = [s["risk"] for s in stops if s.get("risk")]
        plan["risk"] = max(risks, key=lambda x: order_rank[x]) if risks else "low"
        plan["total_min_lo"] = max(0, int(round(total_s / 60.0 - 0.6 * max(1.0, 0.15 * total_s / 60.0))))
        plan["total_min_hi"] = int(round(total_s / 60.0 + 1.6 * max(1.0, 0.15 * total_s / 60.0)))
        plan["no_start"] = start is None
        plan["nav_url"] = self._nav_url(stops, start)
        return plan

    @staticmethod
    def _nav_url(stops, start):
        if not stops:
            return ""
        pts = [f"{s['lat']:.6f},{s['lon']:.6f}" for s in stops]
        q = {"api": "1", "travelmode": "driving", "destination": pts[-1]}
        if len(pts) > 1:
            q["waypoints"] = "|".join(pts[:-1])
        if start:
            q["origin"] = f"{start['lat']:.6f},{start['lon']:.6f}"
        return "https://www.google.com/maps/dir/?" + urllib.parse.urlencode(q, safe=",|")

    # --------------------------------------------------------------- public
    @staticmethod
    def _sig(orders):
        return tuple((o["id"], o["status"]) for o in orders)

    def plan(self, now=None):
        now = now or time.time()
        orders = self.active_orders()
        if not orders:
            self._last_plan = None
            return {"ok": False, "error": "No active orders."}
        plan = self.solve(orders, self._get_state("loc"), now)
        self._last_plan = (self._sig(orders), plan)
        return plan

    def push(self, plan=None):
        """Send the current plan to the browser panel."""
        try:
            if plan is None:
                plan = self.plan()
            slim = plan if plan.get("ok") else {}
            self.broadcast("route:" + json.dumps(slim))
        except Exception as e:
            print(f"[DELIVERY] push fail: {e}")

    def set_location(self, text):
        g = self.geocode(text, cache=False)
        if not g:
            return None
        self._set_state("loc", {"lat": g["lat"], "lon": g["lon"], "label": short_addr(text)})
        if g.get("area"):
            self._set_state("area", g["area"])
        return g

    def add_order(self, restaurant, dropoff, pickup="", payout=0.0, platform="",
                  ready_in_min=0.0, within_min=0.0, now=None):
        now = now or time.time()
        restaurant = (restaurant or "").strip() or "the restaurant"
        if len(self.active_orders()) >= MAX_STACK:
            return {"ok": False, "error": f"Stack is full at {MAX_STACK} orders. Finish one first."}
        p = self.geocode(pickup or restaurant)
        if not p:
            return {"ok": False, "error": f"Couldn't find {pickup or restaurant}. Give me its street address."}
        d = self.geocode(dropoff, cache=False)
        if not d:
            return {"ok": False, "error": f"Couldn't find the drop-off {dropoff}. Give me the street number and street."}
        try:
            payout = max(0.0, float(payout or 0))
        except Exception:
            payout = 0.0
        ready_at = now + max(0.0, float(ready_in_min or 0)) * 60
        deadline_at = (now + float(within_min) * 60) if within_min and float(within_min) > 0 else None
        with closing(sqlite3.connect(self.db_path)) as c:
            cur = c.execute(
                "INSERT INTO delivery_orders (platform, restaurant, pickup_addr, pickup_lat, pickup_lon,"
                " drop_addr, drop_lat, drop_lon, payout, ready_at, deadline_at, status, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?)",
                (normalize_platform(platform), restaurant, self._pickup_label(pickup, p, restaurant),
                 p["lat"], p["lon"], tidy_addr(dropoff), d["lat"], d["lon"],
                 payout, ready_at, deadline_at, now))
            oid = cur.lastrowid
            c.commit()
        return {"ok": True, "id": oid, "restaurant": restaurant,
                "pickup": self._pickup_label(pickup, p, restaurant), "dropoff": tidy_addr(dropoff),
                "count": len(self.active_orders())}

    @staticmethod
    def _pickup_label(pickup, geo, restaurant):
        return tidy_addr(pickup) if pickup else (geo.get("short") or restaurant)

    def _find_order(self, ref):
        orders = self.active_orders()
        ref = (str(ref) if ref is not None else "").strip().lower()
        if not ref:
            return None
        if ref.isdigit():
            for o in orders:
                if o["id"] == int(ref):
                    return o
        for o in orders:
            if ref in o["restaurant"].lower():
                return o
        return None

    def remove_order(self, ref):
        o = self._find_order(ref)
        if not o:
            return None
        with closing(sqlite3.connect(self.db_path)) as c:
            c.execute("DELETE FROM delivery_orders WHERE id=?", (o["id"],))
            c.commit()
        return o

    def clear(self):
        with closing(sqlite3.connect(self.db_path)) as c:
            n = c.execute("DELETE FROM delivery_orders").rowcount
            c.commit()
        self._last_plan = None
        return n

    def complete_next(self, ref="", kind="", now=None):
        """
        Mark a stop done and return a dict.
          * no ref  : the next planned stop (or the next planned stop of `kind`)
          * ref     : that order's current stop
          * kind='drop' on an order never marked picked up counts the pickup too
        """
        now = now or time.time()
        orders = self.active_orders()
        if not orders:
            return {"ok": False, "error": "No active orders."}
        kind = (kind or "").strip().lower()
        if ref:
            order = self._find_order(ref)
            if not order:
                return {"ok": False, "error": f"No active order matching {ref}."}
            if kind == "pickup" and order["status"] == "picked":
                return {"ok": False, "error": f"{order['restaurant']} is already marked as picked up."}
            stop_kind = kind or ("pickup" if order["status"] == "active" else "drop")
            lp = self._last_plan
            st = None
            if lp and lp[0] == self._sig(orders):
                st = next((x for x in lp[1].get("stops", [])
                           if x["order_id"] == order["id"] and x["kind"] == stop_kind), None)
            leg_mi = (st or {}).get("leg_mi") or 0.0
        else:
            lp = self._last_plan
            if lp and lp[0] == self._sig(orders) and lp[1].get("stops"):
                stops = lp[1]["stops"]
            else:
                stops = self.plan(now)["stops"]
            stop = next((s for s in stops if not kind or s["kind"] == kind), None)
            if stop is None:
                return {"ok": False, "error": f"Nothing left to {'pick up' if kind == 'pickup' else 'drop off'}."}
            order = next(o for o in orders if o["id"] == stop["order_id"])
            stop_kind = stop["kind"]
            leg_mi = stop.get("leg_mi") or 0.0
        oid = order["id"]
        lat, lon, addr = ((order["pickup_lat"], order["pickup_lon"], order["pickup_addr"]) if stop_kind == "pickup"
                          else (order["drop_lat"], order["drop_lon"], order["drop_addr"]))
        self._set_state("loc", {"lat": lat, "lon": lon, "label": short_addr(addr)})
        if leg_mi:                                   # shift mileage: driving to this stop
            day = time.strftime("%Y-%m-%d", time.localtime(now))
            cur = self._get_state("shift_miles") or {}
            base = cur.get("mi", 0.0) if cur.get("day") == day else 0.0
            self._set_state("shift_miles", {"day": day, "mi": round(base + float(leg_mi), 2)})
        with closing(sqlite3.connect(self.db_path)) as c:
            if stop_kind == "pickup":
                c.execute("UPDATE delivery_orders SET status='picked', picked_at=? WHERE id=?", (now, oid))
                msg = {"kind": "pickup", "restaurant": order["restaurant"]}
            else:
                c.execute("INSERT INTO delivery_log (platform, restaurant, payout, accepted_at, delivered_at)"
                          " VALUES (?,?,?,?,?)",
                          (order["platform"], order["restaurant"], order["payout"], order["created_at"], now))
                c.execute("DELETE FROM delivery_orders WHERE id=?", (oid,))   # customer address is gone
                msg = {"kind": "drop", "restaurant": order["restaurant"], "payout": order["payout"]}
            c.commit()
        self._last_plan = None
        msg["ok"] = True
        return msg

    def earnings(self, now=None):
        now = now or time.time()
        lt = time.localtime(now)
        midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
        with closing(sqlite3.connect(self.db_path)) as c:
            rows = c.execute("SELECT payout, accepted_at, delivered_at, platform FROM delivery_log"
                             " WHERE delivered_at>=?", (midnight,)).fetchall()
        if not rows:
            return {"count": 0, "total": 0.0, "per_hour": 0.0, "by_platform": {}, "miles": 0.0,
                    "hours": 0.0, "per_mile": 0.0}
        total = sum(r[0] or 0 for r in rows)
        span_h = max(0.0, (max(r[2] for r in rows) - min(r[1] for r in rows)) / 3600.0)
        by = {}
        for r in rows:
            by[r[3]] = round(by.get(r[3], 0) + (r[0] or 0), 2)
        cur = self._get_state("shift_miles") or {}
        miles = cur.get("mi", 0.0) if cur.get("day") == time.strftime("%Y-%m-%d", lt) else 0.0
        return {"count": len(rows), "total": round(total, 2),
                "per_hour": round(total / span_h, 2) if span_h > 0.1 else 0.0, "by_platform": by,
                "miles": round(miles, 1), "hours": round(span_h, 1),
                "per_mile": round(total / miles, 2) if miles > 0.5 else 0.0}

    def evaluate_offer(self, restaurant, dropoff, pickup="", payout=0.0, platform="",
                       ready_in_min=0.0, now=None):
        """Compare the plan with and without a not-yet-accepted offer."""
        now = now or time.time()
        orders = self.active_orders()
        if len(orders) >= MAX_STACK:
            return {"ok": False, "error": f"Stack is already full at {MAX_STACK} orders."}
        p = self.geocode(pickup or restaurant)
        d = self.geocode(dropoff, cache=False) if dropoff else None
        if not p:
            return {"ok": False, "error": f"Couldn't find {pickup or restaurant}."}
        if not d:
            return {"ok": False, "error": "I need a drop-off address or at least the street to judge this offer."}
        try:
            payout = max(0.0, float(payout or 0))
        except Exception:
            payout = 0.0
        hypo = {"id": -1, "platform": normalize_platform(platform), "restaurant": restaurant or "New offer",
                "pickup_addr": self._pickup_label(pickup, p, restaurant), "pickup_lat": p["lat"], "pickup_lon": p["lon"],
                "drop_addr": tidy_addr(dropoff), "drop_lat": d["lat"], "drop_lon": d["lon"],
                "payout": payout, "ready_at": now + max(0.0, float(ready_in_min or 0)) * 60,
                "deadline_at": None, "status": "active", "picked_at": None, "created_at": now}
        start = self._get_state("loc")
        base = self.solve(orders, start, now) if orders else None
        withp = self.solve(orders + [hypo], start, now)
        extra_s = withp["total_s"] - (base["total_s"] if base else 0)
        extra_mi = withp["total_miles"] - (base["total_miles"] if base else 0)
        extra_late = (withp["late_total_s"] - (base["late_total_s"] if base else 0)) / 60.0
        out = {"ok": True, "plan": withp, "extra_min": int(round(extra_s / 60.0)),
               "extra_miles": round(extra_mi, 1), "payout": payout, "extra_late_min": int(round(extra_late)),
               "per_hour": 0.0, "per_mile": 0.0,
               "risk": withp.get("risk", "low"), "risk_before": (base or {}).get("risk", "low")}
        if payout > 0 and extra_s > 60:
            out["per_hour"] = round(payout / (extra_s / 3600.0), 2)
        if payout > 0 and extra_mi > 0.05:
            out["per_mile"] = round(payout / extra_mi, 2)
        ok_hr = out["per_hour"] >= self.cfg["min_per_hour"]
        ok_mi = out["per_mile"] >= self.cfg["min_per_mile"]
        if payout <= 0:
            out["verdict"] = "unknown"
        elif extra_late >= 3:
            out["verdict"] = "decline"
        elif ok_hr and ok_mi:
            out["verdict"] = "take"
        elif ok_hr or ok_mi:
            out["verdict"] = "marginal"
        else:
            out["verdict"] = "decline"
        if out["verdict"] == "take" and out["risk"] == "high":
            out["verdict"] = "marginal"          # good money, but too likely to run late
        return out

    # -------------------------------------------------------------- speech
    def spoken_plan(self, plan):
        if not plan.get("ok"):
            return plan.get("error", "No plan.")
        parts = []
        for s in plan["stops"]:
            if s["kind"] == "pickup":
                parts.append(f"{s['seq']}, pick up {s['restaurant']}, {s['eta_clock']}")
            else:
                parts.append(f"{s['seq']}, drop {s['short_addr']}, {s['eta_clock']}")
        txt = (f"Best route for {plan['orders']} order{'s' if plan['orders'] != 1 else ''}: "
               + "; ".join(parts) + f". About {plan['total_min']} minutes and {plan['total_miles']} {self.unit_word}")
        if plan["payout"]:
            txt += f", {self.money(plan['payout'])} total"
            if plan["per_hour"]:
                txt += f", roughly {self.money(plan['per_hour'], 0)} an hour"
        txt += "."
        if plan.get("total_min_hi"):
            txt += f" Expect {plan['total_min_lo']} to {plan['total_min_hi']} minutes. On-time risk is {plan['risk']}."
        if plan["saved_min"] >= 2:
            txt += f" That saves about {plan['saved_min']} minutes of driving over taking them in the order you got them."
        if plan.get("late_avoided_min", 0) >= 3:
            txt += f" It also avoids about {plan['late_avoided_min']} minutes of lateness."
        elif plan.get("cold_avoided"):
            txt += " It also keeps the food from sitting in the bag."
        if plan["warnings"]:
            txt += " Heads up: " + " ".join(plan["warnings"][:3])
        if plan.get("no_start") and not getattr(self, "_warned_no_start", False):
            self._warned_no_start = True
            txt += " I don't know where you are, so I assumed you're at the first pickup. Tell me your address for exact times."
        return txt

    @staticmethod
    def _arrive(s):
        if s["mins"] <= 0:
            return f"You're there by {s['eta_clock']}."
        if s.get("mins_hi", 0) > s["mins"] + 1:
            return f"Arrive about {s['eta_clock']}, {s['mins_lo']} to {s['mins_hi']} minutes."
        return f"Arrive about {s['eta_clock']}, {s['mins']} minute{'s' if s['mins'] != 1 else ''}."

    def spoken_next(self, plan):
        if not plan.get("ok"):
            return plan.get("error", "No active orders.")
        s = plan["stops"][0]
        if s["kind"] == "pickup":
            txt = f"Next, pick up {s['restaurant']} at {s['short_addr']}. " + self._arrive(s)
            if s["wait_min"] >= 2:
                txt += f" Food won't be ready for about {s['wait_min']} more minutes after you arrive."
        else:
            txt = f"Next, drop off the {s['restaurant']} order at {s['short_addr']}. " + self._arrive(s)
        if len(plan["stops"]) > 1:
            n = plan["stops"][1]
            txt += f" After that, {'pick up ' + n['restaurant'] if n['kind'] == 'pickup' else 'drop at ' + n['short_addr']}."
        return txt

    def spoken_orders(self):
        orders = self.active_orders()
        if not orders:
            return "No active orders."
        bits = []
        for o in orders:
            st = "picked up" if o["status"] == "picked" else "waiting for pickup"
            pay = f", {self.money(o['payout'])}" if o["payout"] else ""
            bits.append(f"{o['id']}, {o['restaurant']} on {o['platform']} to {short_addr(o['drop_addr'])}{pay}, {st}")
        return f"{len(orders)} active: " + "; ".join(bits) + "."
