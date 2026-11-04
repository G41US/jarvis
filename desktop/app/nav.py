"""
nav.py - Jarvis navigation. Works anywhere in the world, no API keys.

  Geocoding : OpenStreetMap Nominatim (Photon as a fallback) - any country, any language.
  Routing   : Valhalla (public FOSSGIS server): turn-by-turn text in many languages for car, bike,
              walking and scooter. If it is down, the OSRM public servers are used and Jarvis writes
              the instructions itself.
  Map       : drawn by the page (OpenFreeMap tiles). See NAV.md.

There is no live traffic in these free services, so times are road-speed estimates.
This module has no dependency on server.py, so it can be tested on its own.
"""
import math
import re
import threading
import time

NAV_DEFAULTS = {
    "valhalla_url": "https://valhalla1.openstreetmap.de/route",
    "osrm_urls": {
        "auto": "https://routing.openstreetmap.de/routed-car",
        "bicycle": "https://routing.openstreetmap.de/routed-bike",
        "pedestrian": "https://routing.openstreetmap.de/routed-foot",
    },
    "osrm_car_backup": "https://router.project-osrm.org",
    "nominatim_url": "https://nominatim.openstreetmap.org",
    "photon_url": "https://photon.komoot.io",
    "user_agent": "JarvisNavigation/1.0 (personal use)",
    "units": "auto",              # auto | miles | km
    "language": "en-US",          # language of the written/spoken instructions (Valhalla codes)
    "timeout_s": 12,
    "max_points": 12,
    "near_box_deg": 0.6,          # ~65 km: places inside this box around you are preferred
}

MODES = ("auto", "bicycle", "pedestrian", "motor_scooter")
MILES_COUNTRIES = {"us", "gb", "lr", "mm"}     # roads signed in miles
METERS_PER_MILE = 1609.344
FEET_PER_METER = 3.28084


# ----------------------------------------------------------------- geometry
def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def compass(b):
    names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
    return names[int(((b % 360) + 22.5) // 45) % 8]


def decode_polyline(s, precision=6):
    """Google/Valhalla/OSRM encoded polyline -> [(lat, lon), ...]."""
    coords = []
    index = lat = lng = 0
    factor = 10 ** precision
    n = len(s)
    while index < n:
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append((lat / factor, lng / factor))
    return coords


def encode_polyline(points, precision=6):
    out = []
    factor = 10 ** precision
    plat = plng = 0
    for lat, lng in points:
        ilat, ilng = int(round(lat * factor)), int(round(lng * factor))
        for v in (ilat - plat, ilng - plng):
            v = ~(v << 1) if v < 0 else (v << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return "".join(out)


# ---------------------------------------------------------------- formatting
def resolve_units(setting, country_code):
    s = (setting or "auto").lower()
    if s in ("miles", "mi", "imperial"):
        return "miles"
    if s in ("km", "kilometers", "kilometres", "metric"):
        return "km"
    return "miles" if (country_code or "").lower() in MILES_COUNTRIES else "km"


def fmt_distance(m, units="miles", short=False):
    """Spoken or short form: '400 feet' / '400 ft', '0.4 miles' / '0.4 mi', '1.2 kilometers' / '1.2 km'."""
    m = max(0.0, float(m))
    if units == "miles":
        ft = m * FEET_PER_METER
        if ft < 1000:
            v = max(50, int(round(ft / 50.0)) * 50) if ft >= 25 else max(10, int(round(ft / 10.0)) * 10)
            return f"{v} ft" if short else f"{v} feet"
        mi = m / METERS_PER_MILE
        if mi >= 10:
            v = f"{int(round(mi))}"
        else:
            v = f"{mi:.1f}"
            if v.endswith(".0"):
                v = v[:-2]
        one = v == "1"
        return f"{v} mi" if short else f"{v} mile{'' if one else 's'}"
    if m < 1000:
        v = max(50, int(round(m / 50.0)) * 50) if m >= 25 else max(10, int(round(m / 10.0)) * 10)
        return f"{v} m" if short else f"{v} meters"
    km = m / 1000.0
    if km >= 10:
        v = f"{int(round(km))}"
    else:
        v = f"{km:.1f}"
        if v.endswith(".0"):
            v = v[:-2]
    one = v == "1"
    return f"{v} km" if short else f"{v} kilometer{'' if one else 's'}"


def fmt_duration(s):
    s = max(0, int(round(s)))
    if s < 90:
        return "about a minute" if s >= 45 else "under a minute"
    mins = int(round(s / 60.0))
    if mins < 60:
        return f"{mins} minutes"
    h, mm = divmod(mins, 60)
    return f"{h} hour{'s' if h != 1 else ''}" + (f" {mm} minutes" if mm else "")


def clock(ts):
    return time.strftime("%I:%M %p", time.localtime(ts)).lstrip("0")


# ------------------------------------------------------------ maneuver icons
_VALHALLA_ICONS = {
    0: "straight", 1: "depart", 2: "depart", 3: "depart", 4: "arrive", 5: "arrive_right", 6: "arrive_left",
    7: "straight", 8: "straight", 9: "slight_right", 10: "right", 11: "sharp_right", 12: "uturn",
    13: "uturn_left", 14: "sharp_left", 15: "left", 16: "slight_left", 17: "straight", 18: "exit_right",
    19: "exit_left", 20: "exit_right", 21: "exit_left", 22: "straight", 23: "fork_right", 24: "fork_left",
    25: "merge", 26: "roundabout", 27: "roundabout", 28: "ferry", 29: "ferry", 37: "merge", 38: "merge",
}


def valhalla_icon(t):
    return _VALHALLA_ICONS.get(int(t), "straight")


def _osrm_icon(mtype, mod):
    mod = (mod or "").lower()
    if mtype == "depart":
        return "depart"
    if mtype == "arrive":
        return {"left": "arrive_left", "right": "arrive_right"}.get(mod, "arrive")
    if mtype in ("roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary"):
        return "roundabout"
    if mtype == "merge":
        return "merge"
    if mtype == "fork":
        return "fork_left" if "left" in mod else "fork_right" if "right" in mod else "straight"
    if mtype in ("off ramp",):
        return "exit_left" if "left" in mod else "exit_right"
    if mtype in ("on ramp",):
        return {"left": "slight_left", "slight left": "slight_left", "right": "slight_right",
                "slight right": "slight_right"}.get(mod, "straight")
    return {"uturn": "uturn", "sharp right": "sharp_right", "right": "right", "slight right": "slight_right",
            "straight": "straight", "slight left": "slight_left", "left": "left",
            "sharp left": "sharp_left"}.get(mod, "straight")


_ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]


def _osrm_text(step, first):
    """Instruction text for an OSRM step (OSRM gives maneuver data, not sentences)."""
    m = step.get("maneuver") or {}
    t, mod = m.get("type", ""), (m.get("modifier") or "").lower()
    name = (step.get("name") or "").strip() or (step.get("ref") or "").strip()
    onto = f" onto {name}" if name else ""
    on = f" on {name}" if name else ""
    if t == "depart" or first:
        b = m.get("bearing_after")
        return f"Head {compass(b)}{on}." if b is not None else f"Head out{on}."
    if t == "arrive":
        side = " on your left" if mod == "left" else " on your right" if mod == "right" else ""
        return f"You have arrived at your destination{side}."
    if t in ("roundabout", "rotary"):
        ex = m.get("exit")
        word = _ORD[ex] if isinstance(ex, int) and 0 < ex < len(_ORD) else ""
        return (f"Enter the roundabout and take the {word} exit{onto}." if word
                else f"Enter the roundabout and exit{onto}.")
    if t == "roundabout turn":
        return f"At the roundabout, turn {mod or 'ahead'}{onto}."
    if t in ("exit roundabout", "exit rotary"):
        return f"Exit the roundabout{onto}."
    if t == "merge":
        return f"Merge {mod}{onto}.".replace("merge straight", "Merge")
    if t == "on ramp":
        return f"Take the ramp{onto}."
    if t == "off ramp":
        return f"Take the exit{' ' + mod if mod and mod != 'straight' else ''}{onto}."
    if t == "fork":
        return f"Keep {'left' if 'left' in mod else 'right' if 'right' in mod else 'straight'} at the fork{onto}."
    if t == "end of road":
        return f"At the end of the road, turn {mod}{onto}."
    if mod == "uturn":
        return f"Make a U-turn{onto}."
    if t in ("new name", "continue") and mod in ("", "straight"):
        return f"Continue{onto}."
    if t in ("turn", "continue", "new name") and mod:
        return f"Turn {mod}{onto}." if mod != "straight" else f"Continue{onto}."
    return f"Continue{onto}."


# --------------------------------------------------------------- navigator
class Navigator:
    def __init__(self, cfg=None, http=None):
        self.cfg = dict(NAV_DEFAULTS)
        self.cfg.update(cfg or {})
        self._http_fn = http            # callable(url, params=None, body=None) -> dict | None   (tests inject this)
        self._lock = threading.Lock()
        self._last_call = 0.0
        self._rev_cache = {}
        self.last_error = ""

    # ---- network
    def _http(self, url, params=None, body=None):
        if self._http_fn:
            return self._http_fn(url, params, body)
        import requests
        try:
            headers = {"User-Agent": self.cfg["user_agent"], "Accept-Language": self.cfg.get("language", "en")}
            if body is not None:
                r = requests.post(url, json=body, headers=headers, timeout=self.cfg["timeout_s"])
            else:
                r = requests.get(url, params=params, headers=headers, timeout=self.cfg["timeout_s"])
            try:
                return r.json()
            except Exception:
                return None
        except Exception as e:
            self.last_error = f"{type(e).__name__}"
            print(f"[NAV] http fail {url.split('?')[0]}: {type(e).__name__}")
            return None

    def _throttle(self):
        """Nominatim's policy is one request per second."""
        with self._lock:
            wait = 1.1 - (time.time() - self._last_call)
            if wait > 0 and not self._http_fn:
                time.sleep(wait)
            self._last_call = time.time()

    # ---- geocoding (worldwide)
    @staticmethod
    def _parse_latlon(text):
        m = re.fullmatch(r"\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*", text or "")
        if m:
            la, lo = float(m.group(1)), float(m.group(2))
            if -90 <= la <= 90 and -180 <= lo <= 180:
                return la, lo
        return None

    def _hit(self, r):
        a = r.get("address") or {}
        town = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or a.get("county") or ""
        area = ", ".join(x for x in (town, a.get("state") or a.get("region") or "") if x)
        street = f"{a.get('house_number', '')} {a.get('road', '')}".strip()
        name = r.get("name") or ""
        disp = r.get("display_name", "")
        return {"lat": float(r["lat"]), "lon": float(r["lon"]), "display": disp,
                "short": name or street or (disp.split(",")[0].strip() if disp else ""),
                "area": area, "country_code": (a.get("country_code") or "").lower()}

    def geocode(self, text, near=None):
        """text -> {'lat','lon','display','short','area','country_code','distance_km'} or None.
        `near` = (lat, lon): matches around you win (so 'Main Street' means YOUR Main Street),
        and a far-away match is reported with its distance instead of silently accepted."""
        text = re.sub(r"\s+", " ", (text or "")).strip()
        if not text:
            return None
        ll = self._parse_latlon(text)
        if ll:
            rev = self.reverse(*ll) or {}
            return {"lat": ll[0], "lon": ll[1], "display": rev.get("display", text), "short": rev.get("short") or text,
                    "area": rev.get("area", ""), "country_code": rev.get("country_code", ""), "distance_km": None}
        has_num = bool(re.search(r"\d", text))
        base = self.cfg["nominatim_url"] + "/search"
        tries = []
        if near:
            d = float(self.cfg["near_box_deg"])
            vb = f"{near[1] - d},{near[0] + d},{near[1] + d},{near[0] - d}"
            tries.append({"q": text, "viewbox": vb, "bounded": 1})
        tries.append({"q": text})
        hits = []
        for extra in tries:
            params = {"format": "jsonv2", "limit": 1 if (has_num or not near) else 8, "addressdetails": 1}
            params.update(extra)
            self._throttle()
            res = self._http(base, params)
            if isinstance(res, list) and res:
                hits = [self._hit(r) for r in res if "lat" in r and "lon" in r]
                if hits:
                    break
        if not hits:
            params = {"q": text, "limit": 1}
            if near:
                params.update(lat=near[0], lon=near[1])
            res = self._http(self.cfg["photon_url"] + "/api/", params)
            feats = (res or {}).get("features") or [] if isinstance(res, dict) else []
            for f in feats[:1]:
                lon, lat = f["geometry"]["coordinates"]
                p = f.get("properties") or {}
                disp = ", ".join(x for x in [p.get("name"), p.get("street"), p.get("city"), p.get("state"),
                                             p.get("country")] if x)
                hits.append({"lat": float(lat), "lon": float(lon), "display": disp or text,
                             "short": p.get("name") or f"{p.get('housenumber', '')} {p.get('street', '')}".strip() or text,
                             "area": ", ".join(x for x in (p.get("city"), p.get("state")) if x),
                             "country_code": (p.get("countrycode") or "").lower()})
        if not hits:
            return None
        if near:
            for h in hits:
                h["distance_km"] = haversine_m(near[0], near[1], h["lat"], h["lon"]) / 1000.0
            hits.sort(key=lambda h: h["distance_km"])
        best = hits[0]
        best.setdefault("distance_km", None)
        return best

    def reverse(self, lat, lon):
        key = (round(lat, 3), round(lon, 3))
        if key in self._rev_cache:
            return self._rev_cache[key]
        self._throttle()
        res = self._http(self.cfg["nominatim_url"] + "/reverse",
                         {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18, "addressdetails": 1})
        if not isinstance(res, dict) or "lat" not in res:
            return None
        h = self._hit(res)
        h["short"] = (f"{(res.get('address') or {}).get('house_number', '')} {(res.get('address') or {}).get('road', '')}".strip()
                      or res.get("name") or h["short"])
        self._rev_cache[key] = h
        return h

    # ---- routing
    def route(self, points, mode="auto", units="km", language=None, avoid=()):
        """points = [(lat, lon), ...] (first = start). Returns a normalised route dict or {'ok': False, 'error': ...}.
        shape = [[lat, lon], ...]; each step has begin/end indexes into shape, so the page can follow it."""
        pts = [(float(a), float(b)) for a, b in points]
        if len(pts) < 2:
            return {"ok": False, "error": "I need a start and a destination."}
        if len(pts) > int(self.cfg["max_points"]):
            return {"ok": False, "error": f"That is more than {self.cfg['max_points']} stops."}
        mode = mode if mode in MODES else "auto"
        lang = language or self.cfg.get("language") or "en-US"
        err = ""
        r = self._valhalla(pts, mode, units, lang, avoid)
        if r.get("ok"):
            return r
        err = r.get("error", "")
        if r.get("hard"):                      # the server understood and said no (no road, too far): don't try OSRM
            return {"ok": False, "error": err}
        o = self._osrm(pts, mode, units, avoid)
        if o.get("ok"):
            return o
        return {"ok": False, "error": err or o.get("error") or "The routing service isn't reachable right now."}

    def _valhalla(self, pts, mode, units, lang, avoid):
        body = {"locations": [{"lat": la, "lon": lo} for la, lo in pts], "costing": mode,
                "directions_options": {"units": "miles" if units == "miles" else "kilometers", "language": lang},
                "id": "jarvis"}
        co = {}
        if "highways" in avoid:
            co["use_highways"] = 0.0
        if "tolls" in avoid:
            co["use_tolls"] = 0.0
        if "ferries" in avoid:
            co["use_ferry"] = 0.0
        if co and mode in ("auto", "motor_scooter"):
            body["costing_options"] = {mode: co}
        data = self._http(self.cfg["valhalla_url"], None, body)
        if not isinstance(data, dict):
            return {"ok": False, "error": ""}
        if "trip" not in data:
            msg = str(data.get("error") or "")
            code = data.get("error_code")
            if code in (154, 153) or "exceeds" in msg.lower():
                return {"ok": False, "hard": True,
                        "error": "That's farther than the free routing service allows. I can open it in Google or Apple Maps instead."}
            if code in (442, 443, 171, 170) or "no path" in msg.lower() or "no suitable edges" in msg.lower():
                return {"ok": False, "hard": True,
                        "error": f"I couldn't find a {self._mode_word(mode)} route between those places."}
            return {"ok": False, "error": ""}
        try:
            return self._parse_valhalla(data["trip"], pts, mode, units, lang)
        except Exception as e:
            print(f"[NAV] valhalla parse: {type(e).__name__}: {e}")
            return {"ok": False, "error": ""}

    @staticmethod
    def _mode_word(mode):
        return {"auto": "driving", "bicycle": "cycling", "pedestrian": "walking", "motor_scooter": "scooter"}.get(mode, mode)

    def _parse_valhalla(self, trip, pts, mode, units, lang):
        to_m = METERS_PER_MILE if (trip.get("units") or units) in ("miles", "mi") else 1000.0
        shape, steps, legs = [], [], []
        for li, leg in enumerate(trip["legs"]):
            lp = decode_polyline(leg["shape"], 6)
            off = len(shape) - 1 if shape else 0
            shape.extend(lp[1:] if shape else lp)
            first = len(steps)
            for m in leg.get("maneuvers", []):
                street = ", ".join(m.get("street_names") or [])
                steps.append({
                    "i": len(steps), "type": int(m.get("type", 0)), "icon": valhalla_icon(m.get("type", 0)),
                    "text": m.get("instruction", ""),
                    "say": m.get("verbal_pre_transition_instruction") or m.get("instruction", ""),
                    "alert": m.get("verbal_transition_alert_instruction", ""),
                    "after": m.get("verbal_post_transition_instruction", ""),
                    "street": street, "dist_m": round(float(m.get("length", 0)) * to_m, 1),
                    "time_s": round(float(m.get("time", 0)), 1),
                    "begin": off + int(m.get("begin_shape_index", 0)), "end": off + int(m.get("end_shape_index", 0)),
                    "leg": li, "exit": m.get("roundabout_exit_count")})
            ls = leg.get("summary") or {}
            legs.append({"dist_m": round(float(ls.get("length", 0)) * to_m, 1), "time_s": round(float(ls.get("time", 0)), 1),
                         "first_step": first, "last_step": len(steps) - 1, "end_index": len(shape) - 1})
        s = trip.get("summary") or {}
        return self._finish({"provider": "valhalla"}, shape, steps, legs, pts, mode, units, lang,
                            float(s.get("length", 0)) * to_m, float(s.get("time", 0)))

    def _osrm(self, pts, mode, units, avoid):
        base = self.cfg["osrm_urls"].get(mode if mode in ("bicycle", "pedestrian") else "auto")
        bases = [base]
        if mode in ("auto", "motor_scooter"):
            bases.append(self.cfg["osrm_car_backup"])
        coords = ";".join(f"{lo:.6f},{la:.6f}" for la, lo in pts)
        params = {"overview": "full", "geometries": "polyline6", "steps": "true", "alternatives": "false"}
        ex = [c for c, k in (("motorway", "highways"), ("toll", "tolls"), ("ferry", "ferries")) if k in avoid]
        if ex and mode in ("auto", "motor_scooter"):
            params["exclude"] = ",".join(ex)
        for b in bases:
            data = self._http(f"{b}/route/v1/driving/{coords}", params)
            if isinstance(data, dict) and data.get("code") == "Ok" and data.get("routes"):
                try:
                    return self._parse_osrm(data["routes"][0], pts, mode, units)
                except Exception as e:
                    print(f"[NAV] osrm parse: {type(e).__name__}: {e}")
            elif isinstance(data, dict) and data.get("code") == "NoRoute":
                return {"ok": False, "error": f"I couldn't find a {self._mode_word(mode)} route between those places."}
        return {"ok": False, "error": ""}

    def _parse_osrm(self, rt, pts, mode, units):
        shape, steps, legs = [], [], []
        for li, leg in enumerate(rt["legs"]):
            first = len(steps)
            for si, st in enumerate(leg["steps"]):
                g = decode_polyline(st["geometry"], 6) if st.get("geometry") else []
                if (st.get("maneuver") or {}).get("type") == "arrive" and shape:
                    g = []                                  # arrival sits on the last point already drawn
                if shape and g and abs(shape[-1][0] - g[0][0]) < 1e-7 and abs(shape[-1][1] - g[0][1]) < 1e-7:
                    g = g[1:]
                begin = max(0, len(shape) - 1) if shape else 0
                shape.extend(g)
                m = st.get("maneuver") or {}
                mtype, mod = m.get("type", ""), m.get("modifier", "")
                text = _osrm_text(st, first=(li == 0 and si == 0))
                is_last = (mtype == "arrive")
                steps.append({
                    "i": len(steps), "type": 0, "icon": _osrm_icon(mtype, mod), "text": text, "say": text,
                    "alert": "", "after": "", "street": (st.get("name") or st.get("ref") or ""),
                    "dist_m": round(float(st.get("distance", 0)), 1), "time_s": round(float(st.get("duration", 0)), 1),
                    "begin": begin, "end": max(begin, len(shape) - 1), "leg": li, "exit": m.get("exit")})
                if is_last:
                    steps[-1]["begin"] = steps[-1]["end"] = max(0, len(shape) - 1)
            legs.append({"dist_m": round(float(leg.get("distance", 0)), 1), "time_s": round(float(leg.get("duration", 0)), 1),
                         "first_step": first, "last_step": len(steps) - 1, "end_index": max(0, len(shape) - 1)})
        return self._finish({"provider": "osrm"}, shape, steps, legs, pts, mode, units, "en-US",
                            float(rt.get("distance", 0)), float(rt.get("duration", 0)))

    def _finish(self, base, shape, steps, legs, pts, mode, units, lang, dist_m, time_s):
        if len(shape) < 2:
            raise ValueError("empty shape")
        lats = [p[0] for p in shape]
        lons = [p[1] for p in shape]
        out = dict(base)
        out.update({
            "ok": True, "mode": mode, "units": units, "language": lang,
            "distance_m": round(dist_m, 1), "time_s": round(time_s, 1),
            "shape": [[round(a, 5), round(b, 5)] for a, b in shape],
            "steps": steps, "legs": legs,
            "bbox": [min(lons), min(lats), max(lons), max(lats)],
            "waypoints": [{"lat": a, "lon": b} for a, b in pts],
            "created": time.time()})
        return out

    # ---- spoken summary
    @staticmethod
    def spoken_summary(route, label, now=None):
        now = now or time.time()
        units = route.get("units", "miles")
        arrive = clock(now + route["time_s"])
        first = next((s for s in route["steps"] if not s["icon"].startswith("arrive")), None)
        txt = (f"Navigating to {label}. {fmt_duration(route['time_s'])} and "
               f"{fmt_distance(route['distance_m'], units)}, arriving about {arrive}.")
        if first and first.get("say"):
            txt += " " + first["say"]
        return txt
