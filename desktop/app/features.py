"""The ideas from the videos, for the PC Jarvis: a live globe, a day planner, a recap, gesture control and system gauges.
server.py calls install(globals()) once; everything here reaches the server only through what it hands over."""
import datetime, json, math, os, re, sqlite3, threading, time
from contextlib import closing

import psutil

TEX_DIR = os.path.join("models", "globe")
_JSON = {}                 # url -> (fetched at, data): the feeds change slowly, so a few minutes' cache keeps answers instant
_LAST = {"suggest": []}    # the plan's suggested slots, kept until he says "lock it in"


def _json(url, ttl=300, params=None):
    import requests
    key = url + json.dumps(params or {}, sort_keys=True)
    hit = _JSON.get(key)
    if hit and time.time() - hit[0] < ttl: return hit[1]
    data = requests.get(url, params=params, timeout=10, headers={"User-Agent": "Jarvis/1.0"}).json()
    _JSON[key] = (time.time(), data)
    return data


def _km(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def _ago(ts):
    m = int((time.time() - ts) / 60)
    if m < 60: return f"{m} min ago"
    if m < 48 * 60: return f"{m // 60} h ago"
    return f"{m // 1440} days ago"


# ============================================================
# TIME WORDS -> datetime (planner)
# ============================================================
_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_MONTHS = r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b"
_PARTS = {"noon": "12:00", "midday": "12:00", "midnight": "00:00", "morning": "9:00", "afternoon": "15:00",
          "evening": "18:00", "tonight": "20:00", "night": "20:00"}


def parse_when(text, now=None):
    """'tomorrow at 3', 'friday 9am', 'in 30 minutes', 'tonight', 'November 5 at 2:30pm' -> datetime, or None."""
    from dateutil import parser as dp
    now = now or datetime.datetime.now()
    t = " " + (text or "").lower().strip() + " "
    m = re.search(r"\bin (\d+|an?|half an?) ?(minute|min|hour|hr|day)s?\b", t)
    if m:
        n = {"a": 1, "an": 1, "half a": 0.5, "half an": 0.5}.get(m.group(1)) or float(m.group(1))
        unit = {"minute": 60, "min": 60, "hour": 3600, "hr": 3600, "day": 86400}[m.group(2)]
        return (now + datetime.timedelta(seconds=n * unit)).replace(second=0, microsecond=0)
    day = None
    if "tomorrow" in t: day = now.date() + datetime.timedelta(days=1); t = t.replace("tomorrow", " ")
    elif re.search(r"\b(today|tonight)\b", t): day = now.date(); t = t.replace("today", " ")
    else:
        for i, w in enumerate(_WEEKDAYS):
            if re.search(rf"\b{w}\b", t):
                ahead = (i - now.weekday()) % 7
                if ahead == 0 and "next" in t: ahead = 7
                day = now.date() + datetime.timedelta(days=ahead); t = re.sub(rf"\b(next |this |on )?{w}\b", " ", t)
                break
    has_time = bool(re.search(r"\d\s*(:\d\d|[ap]\.?m\b)", t) or re.search(r"\bat \d", t))
    if not has_time:
        for word, hhmm in _PARTS.items():
            if re.search(rf"\b{word}\b", t): t = re.sub(rf"\b(this |at |in the )?{word}\b", f" {hhmm} ", t); has_time = True; break
    # a bare 'at 3' is an hour, not the 3rd: afternoon for 1-7, as people mean it
    t = re.sub(r"\bat (\d{1,2})\b(?!\s*(:|\d|[ap]\.?m))", lambda g: f" {int(g.group(1)) + (12 if 1 <= int(g.group(1)) <= 7 else 0)}:00 ", t)
    t = re.sub(r"\b(at|on|next|this|the|for)\b", " ", t)
    base = datetime.datetime.combine(day or now.date(), datetime.time(9, 0))
    if not t.strip(): return base if day else None
    try: dt = dp.parse(t, fuzzy=True, default=base)
    except (ValueError, OverflowError): return base if day else None
    if not has_time and not day and not re.search(_MONTHS, t) and not re.search(r"\d", t): return None
    if day is None and not re.search(_MONTHS, t) and dt < now: dt += datetime.timedelta(days=1)
    return dt.replace(second=0, microsecond=0)


def free_slots(busy, start, end, min_minutes=20):
    """Gaps of at least min_minutes between start and end (timestamps), around the busy (start, end) pairs."""
    start = math.ceil(start / 900) * 900                      # from the next quarter hour
    out, cur = [], start
    for s, e in sorted(busy):
        if e <= cur: continue
        if s - cur >= min_minutes * 60: out.append((cur, min(s, end)))
        cur = max(cur, e)
        if cur >= end: break
    if end - cur >= min_minutes * 60: out.append((cur, end))
    return [(s, e) for s, e in out if e - s >= min_minutes * 60]


def _hm(ts): return datetime.datetime.fromtimestamp(ts).strftime("%I:%M %p").lstrip("0")


def install(ns):
    tool, broadcast, app, DB = ns["tool"], ns["_broadcast_ws"], ns["app"], ns["DB_PATH"]
    from fastapi.responses import FileResponse, Response
    import asyncio

    def db(): return closing(sqlite3.connect(DB))
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, start REAL, end REAL)")
        c.execute("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, created REAL, done_at REAL)")
        c.commit()

    def send(kind, payload): broadcast(f"{kind}:" + json.dumps(payload))

    # ============================================================
    # GLOBE
    # ============================================================
    _labels = {}
    def labels():
        if not _labels:
            try:
                with open(os.path.join(TEX_DIR, "labels.json"), encoding="utf-8") as f: _labels.update(json.load(f))
            except Exception as e: print(f"[GLOBE] labels: {type(e).__name__}")
        return _labels

    def place_of(name):
        """(lat, lon, label, kind): countries and states from the map's own label points (centred properly), anything else geocoded."""
        if not name: return None
        key = name.lower().strip().removeprefix("the ")
        for kind in ("countries", "states"):
            for p in labels().get(kind, []):
                if p["n"].lower() == key: return (p["lat"], p["lon"], p["n"], "country" if kind == "countries" else "state")
        loc = ns["_lookup_location"](name)
        if not loc: return None
        fc = loc.get("feature_code") or ""
        kind = "country" if fc.startswith("PCL") else "state" if fc in ("ADM1", "ADMD") else "city"
        return (loc["latitude"], loc["longitude"], loc.get("name") or name, kind)

    ZOOM = {"country": 2.4, "state": 1.75, "city": 1.3}      # camera distance in Earth radii for each kind of place
    globe_at = {"label": ""}                                  # the place the globe last flew to

    def quakes(place=None):
        feed = "2.5_week" if place else "2.5_day"
        d = _json(f"https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson")
        qs = [{"lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0], "mag": round(f["properties"]["mag"], 1),
               "label": f["properties"]["place"] or "Unknown", "t": f["properties"]["time"] / 1000}
              for f in d["features"] if f["properties"].get("mag") is not None]
        where = place_of(place) if place else None
        if where: qs = [q for q in qs if _km(where[0], where[1], q["lat"], q["lon"]) < 1500]
        qs.sort(key=lambda q: -q["mag"])
        return qs, where

    def storms():
        d = _json("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH", params={"eventlist": "TC"}, ttl=900)
        out = []
        for f in d.get("features", []):
            p = f["properties"]
            if str(p.get("iscurrent")).lower() != "true": continue
            out.append({"lon": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1], "label": p.get("eventname", "Storm"),
                        "sev": (p.get("severitydata") or {}).get("severitytext", ""), "alert": p.get("alertlevel", "")})
        return out

    def iss_track():
        now = int(time.time())
        pts = _json("https://api.wheretheiss.at/v1/satellites/25544/positions",
                    params={"timestamps": ",".join(str(now + k * 600) for k in range(-4, 6)), "units": "kilometers"}, ttl=60)
        return [{"lat": p["latitude"], "lon": p["longitude"], "t": p["timestamp"]} for p in pts]

    def aurora():
        d = _json("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", ttl=900)
        pts = [[lon if lon <= 180 else lon - 360, lat, v] for lon, lat, v in d["coordinates"] if v >= 8]
        north = max((v for _, lat, v in pts if lat > 0), default=0); south = max((v for _, lat, v in pts if lat < 0), default=0)
        edge = min((abs(lat) for _, lat, v in pts if lat > 0 and v >= 20), default=None)
        return pts, north, south, edge, d.get("Forecast Time", "")

    @tool("globe", "Show the live 3D Earth instead of the face. Country and state borders and names are drawn on it. action: show, hide, "
          "satellite (yesterday's real satellite photo), holo (hologram look), earthquakes, storms (hurricanes, typhoons, cyclones), "
          "iss (the space station's orbit), aurora, focus (fly to a place), zoom (fly in close: to the place if given, else closer where it's looking), "
          "zoom_out (back to the whole Earth), night (the dark side with city lights), distance (how far place is from place2, drawn as an arc). "
          "place: for focus/zoom/distance or 'earthquakes near X'.",
          {"action": {"type": "string", "enum": ["show", "hide", "satellite", "holo", "earthquakes", "storms", "iss", "aurora", "focus", "zoom", "zoom_out", "night", "distance"]},
           "place": {"type": "string"}, "place2": {"type": "string"}}, ["action"])
    def _globe(action: str, place: str = "", place2: str = ""):
        a = (action or "show").lower().strip()
        if a == "hide": globe_at["label"] = ""; send("globe", {"cmd": "hide"}); return "Globe away."
        if a in ("show", "holo", "satellite"):
            send("globe", {"cmd": "show", "mode": "sat" if a == "satellite" else "holo"})
            return "Today's satellite view, sir." if a == "satellite" else "The Earth, sir."
        if a == "night":
            send("globe", {"cmd": "show", "night": True}); return "The night side, sir. Those lights are the cities."
        if a == "distance":
            if not place2 and re.search(r"\s(?:and|to)\s", place or ""): place, place2 = re.split(r"\s+(?:and|to)\s+", place, maxsplit=1)
            p1, p2 = place_of(place), place_of(place2)
            if not p1 or not p2: return f"I couldn't find {place if not p1 else place2}."
            km = round(_km(p1[0], p1[1], p2[0], p2[1]))
            send("globe", {"cmd": "show", "measure": {"a": {"lat": p1[0], "lon": p1[1], "label": p1[2]}, "b": {"lat": p2[0], "lon": p2[1], "label": p2[2]}, "km": km}})
            globe_at["label"] = ""
            return f"{p1[2]} to {p2[2]}: {km:,} kilometres, about {round(km * 0.621371):,} miles, as the crow flies."
        if a == "zoom_out":
            globe_at["label"] = ""; send("globe", {"cmd": "show", "fly": {"dist": 5.6}}); return "The whole Earth."
        place = re.sub(r"\d+\s*(%|percent|times|x)?|\b(more|closer|than this|further|further in|in)\b", "", place or "", flags=re.I).strip(" ,.")   # "Abuja 1000%"
        if a == "zoom" and not place:
            send("globe", {"cmd": "show", "fly": {"scale": 0.4}}); return "Closer."
        if a in ("focus", "zoom"):
            w = place_of(place)
            if not w: return f"I couldn't find {place}."
            if a == "zoom" and w[2] == globe_at["label"]:      # "zoom in more on Abuja" while already over Abuja: closer still, not the same view again
                send("globe", {"cmd": "show", "fly": {"lat": w[0], "lon": w[1], "scale": 0.4, "label": w[2]}}); return f"Closer on {w[2]}."
            dist = ZOOM[w[3]] if a == "zoom" else max(ZOOM[w[3]], 2.4 if w[3] == "country" else 1.9)
            send("globe", {"cmd": "show", "fly": {"lat": w[0], "lon": w[1], "dist": dist, "label": w[2], "kind": w[3], "zoom": a == "zoom"}})
            globe_at["label"] = w[2]
            return f"{w[2]}, sir."
        if a == "earthquakes":
            qs, where = quakes(place)
            focus = {"lat": where[0], "lon": where[1], "label": where[2]} if where else (
                {"lat": qs[0]["lat"], "lon": qs[0]["lon"], "label": qs[0]["label"]} if qs else None)
            rows = [{"k": f"M{q['mag']}", "v": q["label"], "s": _ago(q["t"])} for q in qs[:6]]
            send("globe", {"cmd": "show", "layer": "quakes", "focus": focus,
                           "points": [{"lat": q["lat"], "lon": q["lon"], "size": q["mag"], "label": f"M{q['mag']}"} for q in qs[:300]],
                           "card": {"title": "Earthquakes", "sub": (f"Near {where[2]} · 7 days" if where else "Last 24 hours · M2.5+"), "rows": rows}})
            span = "this week" if place else "in the last day"
            if not qs: return f"No earthquakes above magnitude two and a half {('near ' + (where[2] if where else place)) if place else ''} {span}."
            top = qs[0]
            return (f"{len(qs)} earthquakes above magnitude 2.5 {('near ' + where[2] + ' ') if where else ''}{span}. "
                    f"Strongest: magnitude {top['mag']}, {top['label']}, {_ago(top['t'])}.")
        if a == "storms":
            ss = storms()
            send("globe", {"cmd": "show", "layer": "storms", "focus": ({"lat": ss[0]["lat"], "lon": ss[0]["lon"], "label": ss[0]["label"]} if ss else None),
                           "points": [{"lat": s["lat"], "lon": s["lon"], "size": 6, "label": s["label"], "tone": "storm"} for s in ss],
                           "card": {"title": "Tropical storms", "sub": "Active now · GDACS", "rows": [{"k": s["label"], "v": s["sev"], "s": s["alert"]} for s in ss]
                                    or [{"k": "Clear", "v": "No active tropical cyclones", "s": ""}]}})
            if not ss: return "No active tropical storms anywhere right now."
            return f"{len(ss)} active: " + "; ".join(f"{s['label']}, {s['sev']}" for s in ss) + "."
        if a == "iss":
            tr = iss_track(); cur = min(tr, key=lambda p: abs(p["t"] - time.time()))
            send("globe", {"cmd": "show", "layer": "iss", "line": tr, "focus": {"lat": cur["lat"], "lon": cur["lon"], "label": "ISS"},
                           "card": {"title": "International Space Station", "sub": "Live · 420 km up · 27,600 km/h",
                                    "rows": [{"k": "Lat", "v": f"{cur['lat']:.1f}°", "s": ""}, {"k": "Lon", "v": f"{cur['lon']:.1f}°", "s": ""}]}})
            return f"The space station is over latitude {cur['lat']:.0f}, longitude {cur['lon']:.0f}, circling every ninety-two minutes."
        if a == "aurora":
            pts, north, south, edge, when = aurora()
            send("globe", {"cmd": "show", "layer": "aurora", "focus": {"lat": 66, "lon": -100, "label": ""},
                           "points": [{"lat": lat, "lon": lon, "size": v} for lon, lat, v in pts],
                           "card": {"title": "Aurora forecast", "sub": "NOAA OVATION · next hour",
                                    "rows": [{"k": "North", "v": f"{north}% peak", "s": ""}, {"k": "South", "v": f"{south}% peak", "s": ""}]
                                    + ([{"k": "Edge", "v": f"down to {edge:.0f}° N", "s": ""}] if edge else [])}})
            return f"Aurora chance peaks at {north} percent in the north and {south} in the south" + (f", reaching down to about {edge:.0f} degrees north." if edge else ".")
        return "I can show the globe, satellite view, earthquakes, storms, the space station or the aurora."

    def ensure_tex(kind):
        os.makedirs(TEX_DIR, exist_ok=True)
        if kind == "sat":     # yesterday's whole-Earth VIIRS photo (today's isn't finished yet; VIIRS's wide swath leaves almost no gaps)
            day = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
            path, layer, extra = os.path.join(TEX_DIR, f"sat-{day}.jpg"), "VIIRS_SNPP_CorrectedReflectance_TrueColor", f"&TIME={day}"
        elif kind == "night": path, layer, extra = os.path.join(TEX_DIR, "night.jpg"), "VIIRS_Black_Marble", ""     # NASA's Earth at night: city lights
        else: path, layer, extra = os.path.join(TEX_DIR, "blue.jpg"), "BlueMarble_ShadedRelief_Bathymetry", ""
        if not os.path.exists(path):
            import requests
            r = requests.get("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1"
                             f"&LAYERS={layer}&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=4096&HEIGHT=2048&FORMAT=image/jpeg{extra}", timeout=60)
            if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"): return None
            with open(path + ".part", "wb") as f: f.write(r.content)
            os.replace(path + ".part", path)
            for old in os.listdir(TEX_DIR):    # keep one day of satellite photos
                if old.startswith("sat-") and old != os.path.basename(path): os.remove(os.path.join(TEX_DIR, old))
        return path

    def ensure_patch(kind, w, s, e, n):
        """A sharp picture of just the area he's zoomed into (Blue Marble ~500 m, or yesterday's VIIRS photo ~250 m), cached."""
        w, e = max(-180.0, w), min(180.0, e); s, n = max(-90.0, s), min(90.0, n)
        if e - w < 0.05 or n - s < 0.05: return None
        d = os.path.join(TEX_DIR, "patch"); os.makedirs(d, exist_ok=True)
        day = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        layer, extra = (("VIIRS_SNPP_CorrectedReflectance_TrueColor", f"&TIME={day}") if kind == "sat" else ("BlueMarble_ShadedRelief_Bathymetry", ""))
        path = os.path.join(d, f"{kind}{'-' + day if kind == 'sat' else ''}_{w:.2f}_{s:.2f}_{e:.2f}_{n:.2f}.jpg")
        if not os.path.exists(path):
            import requests
            W = 2048; H = max(64, min(2048, round(W * (n - s) / (e - w))))
            r = requests.get("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1"
                             f"&LAYERS={layer}&STYLES=&SRS=EPSG:4326&BBOX={w},{s},{e},{n}&WIDTH={W}&HEIGHT={H}&FORMAT=image/jpeg{extra}", timeout=40)
            if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"): return None
            with open(path + ".part", "wb") as f: f.write(r.content)
            os.replace(path + ".part", path)
            files = sorted((os.path.join(d, x) for x in os.listdir(d)), key=os.path.getmtime)
            for old in files[:-150]: os.remove(old)          # keep the cache to the last 150 views
        return path

    @app.get("/globe/patch")
    async def globe_patch(kind: str = "blue", w: float = 0, s: float = 0, e: float = 1, n: float = 1):
        try: path = await asyncio.to_thread(ensure_patch, "sat" if kind == "sat" else "blue", w, s, e, n)
        except Exception as ex:          # no internet just now: the globe keeps its normal picture (one line in the log, not a traceback)
            print(f"[GLOBE] close-up picture unavailable: {type(ex).__name__}"); path = None
        if not path: return Response(status_code=502)
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    @app.get("/globe/tex/{kind}")
    async def globe_tex(kind: str):
        try: path = await asyncio.to_thread(ensure_tex, kind if kind in ("sat", "night") else "blue")
        except Exception as ex: print(f"[GLOBE] picture unavailable: {type(ex).__name__}"); path = None
        if not path: return Response(status_code=502)
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    @app.get("/globe/iss")
    async def globe_iss():
        return await asyncio.to_thread(lambda: _json("https://api.wheretheiss.at/v1/satellites/25544", ttl=4))

    @app.get("/hud_extra.js")
    async def hud_extra_js():
        return FileResponse(os.path.join(ns.get("_PROJECT_DIR", "."), "hud_extra.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})

    @app.get("/xray.js")
    async def xray_js():
        return FileResponse(os.path.join(ns.get("_PROJECT_DIR", "."), "xray.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})

    # ============================================================
    # DAY PLANNER (local: Google Calendar isn't connected on this PC)
    # ============================================================
    def day_bounds(d):
        s = datetime.datetime.combine(d, datetime.time.min).timestamp(); return s, s + 86400

    def events_on(d):
        s, e = day_bounds(d)
        with db() as c: return c.execute("SELECT id, title, start, end FROM events WHERE start < ? AND end > ? ORDER BY start", (e, s)).fetchall()

    def open_tasks():
        with db() as c: return c.execute("SELECT id, text, created FROM tasks WHERE done_at IS NULL ORDER BY created").fetchall()

    def find_event(title):
        with db() as c:
            rows = c.execute("SELECT id, title, start, end FROM events WHERE title LIKE ? ORDER BY (start < ?), start",
                             (f"%{(title or '').strip()}%", time.time())).fetchall()
        return rows[0] if rows else None

    def show_day(d, suggest=(), title=None):
        today = d == datetime.date.today()
        rows = [{"t": _hm(s), "ts": s, "title": ti, "end": _hm(e), "kind": "event", "past": e < time.time()} for _, ti, s, e in events_on(d)]
        rows += [{"t": _hm(s), "ts": s, "title": ti, "end": _hm(e), "kind": "suggest"} for ti, s, e in suggest]
        rows.sort(key=lambda r: r["ts"])
        start_today = day_bounds(datetime.date.today())[0]
        dodged = [{"title": tx, "age": _ago(cr)} for _, tx, cr in open_tasks() if cr < start_today]
        tasks = [tx for _, tx, cr in open_tasks() if cr >= start_today]
        label = title or ("Today" if today else d.strftime("%A, %B %d").replace(" 0", " "))
        cards = [{"kind": "list", "title": label, "rows": [{"t": r["t"], "title": r["title"], "sub": ("suggested" if r["kind"] == "suggest" else f"until {r['end']}"),
                                                             "tone": "suggest" if r["kind"] == "suggest" else ("past" if r.get("past") else "")} for r in rows],
                  "empty": "Nothing scheduled."}]
        if today and dodged: cards.append({"kind": "list", "title": "Dodged", "tone": "warn", "rows": [{"t": "", "title": x["title"], "sub": x["age"]} for x in dodged]})
        if today and tasks: cards.append({"kind": "list", "title": "Tasks", "rows": [{"t": "", "title": x, "sub": ""} for x in tasks]})
        panels(label, cards)

    @tool("schedule", "The user's own calendar on this PC. action: add, move, cancel, list (a day), accept (lock in the suggested plan). "
          "when / new_when: the user's words for the time, e.g. 'tomorrow at 3pm'. minutes: length, default 60.",
          {"action": {"type": "string", "enum": ["add", "move", "cancel", "list", "accept"]}, "title": {"type": "string"},
           "when": {"type": "string"}, "new_when": {"type": "string"}, "minutes": {"type": "number"}}, ["action"])
    def _schedule(action: str, title: str = "", when: str = "", new_when: str = "", minutes: float = 60):
        a = (action or "list").lower()
        if a == "accept":
            sug = _LAST["suggest"]
            if not sug: return "There's no suggested plan to lock in. Ask me to plan your day first."
            with db() as c:
                c.executemany("INSERT INTO events (title, start, end) VALUES (?, ?, ?)", sug); c.commit()
            _LAST["suggest"] = []; show_day(datetime.date.today())
            return "Locked in: " + "; ".join(f"{ti} at {_hm(s)}" for ti, s, _ in sug) + "."
        if a == "list":
            d = (parse_when(when) or datetime.datetime.now()).date() if when else datetime.date.today()
            evs = events_on(d); show_day(d)
            label = "today" if d == datetime.date.today() else d.strftime("%A")
            return f"Nothing scheduled {label}." if not evs else f"{label.capitalize()}: " + "; ".join(f"{_hm(s)} {ti}" for _, ti, s, _ in evs) + "."
        if a == "add":
            dt = parse_when(when)
            if not dt: return f"When should I put {title or 'it'}? I couldn't read '{when}'."
            s = dt.timestamp(); e = s + max(5, float(minutes or 60)) * 60
            clash = [ti for _, ti, s2, e2 in events_on(dt.date()) if s2 < e and e2 > s]
            with db() as c: c.execute("INSERT INTO events (title, start, end) VALUES (?, ?, ?)", (title or "Event", s, e)); c.commit()
            show_day(dt.date())
            return f"{title or 'Event'} set for {dt.strftime('%A at %I:%M %p').replace(' 0', ' ')}." + (f" It overlaps {', '.join(clash)}." if clash else "")
        ev = find_event(title)
        if not ev: return f"I can't find '{title}' on your calendar."
        eid, ti, s, e = ev
        if a == "cancel":
            with db() as c: c.execute("DELETE FROM events WHERE id=?", (eid,)); c.commit()
            show_day(datetime.date.fromtimestamp(s)); return f"Cancelled {ti}."
        if a == "move":
            dt = parse_when(new_when or when)
            if not dt: return f"Move {ti} to when?"
            ns_, ne = dt.timestamp(), dt.timestamp() + (e - s)
            with db() as c: c.execute("UPDATE events SET start=?, end=? WHERE id=?", (ns_, ne, eid)); c.commit()
            show_day(dt.date()); return f"{ti} moved to {dt.strftime('%A at %I:%M %p').replace(' 0', ' ')}."
        return "I can add, move, cancel or list events."

    @tool("todo", "The user's task list. action: add, done, drop (delete without doing), list.",
          {"action": {"type": "string", "enum": ["add", "done", "drop", "list"]}, "text": {"type": "string"}}, ["action"])
    def _todo(action: str, text: str = ""):
        a = (action or "list").lower()
        if a == "add":
            with db() as c: c.execute("INSERT INTO tasks (text, created) VALUES (?, ?)", (text.strip(), time.time())); c.commit()
            show_day(datetime.date.today()); return f"Added: {text.strip()}."
        if a in ("done", "drop"):
            with db() as c:
                row = c.execute("SELECT id, text FROM tasks WHERE done_at IS NULL AND text LIKE ? ORDER BY created", (f"%{text.strip()}%",)).fetchone()
                if not row: return f"No open task matching '{text}'."
                if a == "done": c.execute("UPDATE tasks SET done_at=? WHERE id=?", (time.time(), row[0]))
                else: c.execute("DELETE FROM tasks WHERE id=?", (row[0],))
                c.commit()
            show_day(datetime.date.today()); return f"{'Done' if a == 'done' else 'Dropped'}: {row[1]}."
        ts = open_tasks(); show_day(datetime.date.today())
        return "No open tasks." if not ts else f"{len(ts)} open: " + "; ".join(tx for _, tx, _ in ts) + "."

    @tool("plan_my_day", "Plan or organise the user's day: today's schedule, open tasks, tasks dodged from earlier days, free time, "
          "and suggested slots for the tasks. Use for 'plan my day', 'organise my calendar', 'what's my day look like'.")
    def _plan_my_day():
        today, now = datetime.date.today(), time.time()
        evs = events_on(today)
        s, _ = day_bounds(today)
        free = free_slots([(a, b) for _, _, a, b in evs], max(now, s + 8 * 3600), s + 21 * 3600)
        ts = open_tasks(); dodged = [(tx, cr) for _, tx, cr in ts if cr < s]
        sug, fi = [], [list(f) for f in free]
        for _, tx, _ in ts[:4]:                  # oldest first: the dodged ones go in early
            slot = next((f for f in fi if f[1] - f[0] >= 1800), None)
            if not slot: break
            sug.append((tx, slot[0], slot[0] + 1800)); slot[0] += 1800 + 900
        _LAST["suggest"] = sug
        show_day(today, sug, "Your day")
        parts = [("Schedule: " + "; ".join(f"{_hm(a)} {ti}" for _, ti, a, _ in evs)) if evs else "Nothing scheduled today."]
        if free: parts.append("Free: " + ", ".join(f"{_hm(a)} to {_hm(b)}" for a, b in free[:4]))
        if dodged: parts.append("Dodged from earlier days: " + "; ".join(f"{tx} ({_ago(cr)})" for tx, cr in dodged))
        if sug: parts.append("Suggested slots (not saved until he says lock it in): " + "; ".join(f"{tx} at {_hm(a)}" for tx, a, _ in sug))
        elif not ts: parts.append("No open tasks.")
        return ". ".join(parts) + ". Summarise in two or three sentences, dry wit about anything dodged, and offer to lock in the suggestions."

    # Google Calendar isn't set up on this PC: 'what's on my calendar' reads the local one instead of saying it isn't connected
    reg, cal, orig = ns["_TOOL_REGISTRY"], ns.get("_calendar"), ns["_TOOL_REGISTRY"].get("get_calendar")
    if orig and cal:
        reg["get_calendar"] = lambda day="today": orig(day) if cal() is not None else _schedule("list", when=day or "today")

    # ============================================================
    # RECAP
    # ============================================================
    def sysnow():
        b = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
        return {"cpu": psutil.cpu_percent(None), "ram": psutil.virtual_memory().percent,
                "bat": round(b.percent) if b else None, "plug": bool(b.power_plugged) if b else None}

    @app.get("/sysstats")
    async def sysstats(): return sysnow()

    @tool("recap", "A recap dashboard of the user's day in numbers: schedule, tasks done and dodged, reminders, Bitcoin and Solana, "
          "weather, the PC's health and how much he's used Jarvis today. Use for 'recap', 'give me the numbers', 'how's my day going'.")
    def _recap():
        today = datetime.date.today(); s, e = day_bounds(today); now = time.time()
        evs = events_on(today); left = [x for x in evs if x[2] > now]
        with db() as c:
            done = c.execute("SELECT COUNT(*) FROM tasks WHERE done_at >= ?", (s,)).fetchone()[0]
            rem = c.execute("SELECT COUNT(*) FROM reminders WHERE fired=0").fetchone()[0]
            asked = c.execute("SELECT COUNT(*) FROM messages WHERE role='user' AND ts >= datetime(?, 'unixepoch')", (s,)).fetchone()[0]
        ts = open_tasks(); dodged = sum(1 for _, _, cr in ts if cr < s)
        tiles = [{"label": "Events left", "value": str(len(left)), "sub": (f"next {_hm(left[0][2])} · {left[0][1]}" if left else f"{len(evs)} today")},
                 {"label": "Tasks done", "value": str(done), "sub": f"{len(ts)} open" + (f" · {dodged} dodged" if dodged else "")},
                 {"label": "Reminders", "value": str(rem), "sub": "pending"},
                 {"label": "Asked Jarvis", "value": str(asked), "sub": "times today"}]
        spoken = [f"{len(left)} events left today", f"{done} tasks done, {len(ts)} open" + (f", {dodged} dodged from earlier" if dodged else ""),
                  f"{rem} reminders pending", f"you've asked me {asked} things today"]
        try:
            px = _json("https://api.coingecko.com/api/v3/simple/price", params={"ids": "bitcoin,solana", "vs_currencies": "usd", "include_24hr_change": "true"}, ttl=120)
            for cid, sym in (("bitcoin", "BTC"), ("solana", "SOL")):
                p, ch = px[cid]["usd"], px[cid].get("usd_24h_change") or 0
                tiles.append({"label": sym, "value": f"${p:,.0f}" if p >= 1000 else f"${p:,.2f}", "sub": f"{'▲' if ch >= 0 else '▼'} {abs(ch):.1f}% 24h", "tone": "up" if ch >= 0 else "down"})
                spoken.append(f"{sym} {p:,.0f} dollars, {'up' if ch >= 0 else 'down'} {abs(ch):.1f} percent")
        except Exception as ex: print(f"[RECAP] crypto: {type(ex).__name__}")
        wx = (ns.get("_AMBIENT") or {}).get("weather")
        if wx: spoken.append(f"{wx['f']} degrees and {wx['desc'].lower()} outside")
        sy = sysnow(); spoken.append(f"the PC at {sy['cpu']:.0f} percent CPU" + (f", battery {sy['bat']}" if sy["bat"] is not None else ""))
        panels("Recap", [{"kind": "stat", "label": x["label"], "value": x["value"], "sub": x["sub"], "tone": x.get("tone", "")} for x in tiles])
        return "; ".join(spoken) + ". Read the highlights in two or three sentences, not every number."

    # ============================================================
    # GESTURES (hand tracking runs in the page; the server only switches it)
    # ============================================================
    @tool("gesture_mode", "Hand-gesture control. It already switches itself on whenever panels, the globe or a card are showing; "
          "on = keep it on all the time, off = stop it switching itself on (remembered).",
          {"on": {"type": "boolean"}}, ["on"])
    def _gesture_mode(on: bool = True):
        on = on if isinstance(on, bool) else str(on).lower() not in ("false", "off", "0", "no")
        send("gesture", {"on": on})
        return ("Gesture control on, and staying on. Pinch to open, pinch and drag to spin, swipe to turn, swipe down to close." if on
                else "Gesture control off. It won't switch itself on until you ask again.")

    import logging        # the page asks for these every few seconds: keep them out of the log so real lines stay readable
    class _Quiet(logging.Filter):
        def filter(self, r): return not any(p in r.getMessage() for p in ('"GET /sysstats', '"GET /ambient', '"POST /nav/position'))
    logging.getLogger("uvicorn.access").addFilter(_Quiet())
    # ============================================================
    # HOLO PANELS: results fly out of the screen as 3D panels around an orb (hud_extra.js); his hands pick them
    # ============================================================
    from urllib.parse import urlparse
    import ipaddress, socket

    def ddgs():
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
        return DDGS()

    def host_of(u):
        try: return urlparse(u).netloc.replace("www.", "")
        except Exception: return ""

    turn = ns.get("_TURN") or {"id": 0, "panels": 0}
    def panels(title, items):
        """Panels for this question: they join the ring already showing this question's results, or start a new one."""
        if not items: return
        turn["panels"] = turn.get("panels", 0) + len(items)
        send("panels", {"title": title, "items": items[:10], "turn": turn.get("id", 0)})

    @tool("search_web", "Search the web.", {"query": {"type": "string"}}, ["query"])
    def _search_web(query: str):
        with ddgs() as d: results = list(d.text(query, max_results=5))
        if not results: return "No results found."
        panels(query, [{"title": r.get("title", ""), "text": (r.get("body") or "")[:260], "source": host_of(r.get("href", ""))} for r in results])
        return "\n".join(f"- {r['title']}: {r['body'][:200]}" for r in results[:3])

    @tool("news_headlines", "Get top news headlines.", {"topic": {"type": "string"}})
    def _news_headlines(topic: str = ""):
        import requests, urllib.parse, xml.etree.ElementTree as ET
        url = (f"https://news.google.com/rss/search?q={urllib.parse.quote(topic)}&hl=en-US&gl=US&ceid=US:en" if topic
               else "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en")
        items = ET.fromstring(requests.get(url, timeout=8).content).findall(".//item")[:6]
        if not items: return "No headlines."
        heads = []
        for it in items:
            t = it.findtext("title") or ""; src = it.findtext("source") or ""
            if " - " in t: t, src2 = t.rsplit(" - ", 1); src = src or src2
            heads.append({"title": t, "text": "", "source": src})
        panels(topic or "Headlines", heads)
        return "Top headlines: " + ". ".join(h["title"] for h in heads[:5]) + "."

    @tool("show_images", "Show pictures of something as floating panels on screen (products, places, people's work, anything visual).",
          {"query": {"type": "string"}}, ["query"])
    def _show_images(query: str):
        with ddgs() as d: res = list(d.images(query, max_results=8, safesearch="moderate"))
        items = [{"title": r.get("title", "")[:80], "image": r.get("thumbnail") or r.get("image"), "source": r.get("source") or host_of(r.get("url", ""))}
                 for r in res if r.get("thumbnail") or r.get("image")]
        if not items: return f"I couldn't find pictures of {query}."
        panels(query, items[:6])
        return f"Here are {min(6, len(items))} pictures of {query}, sir."

    @tool("holo", "The ring of floating panels on screen. action: on (3D mode: the screen becomes a window that follows his head), off, "
          "clear (put the panels / floating cards away and show his face again), select (bring panel n forward), back (return it to the ring), next / previous (turn the ring one panel).",
          {"action": {"type": "string", "enum": ["on", "off", "clear", "select", "back", "next", "previous"]}, "n": {"type": "number"}}, ["action"])
    def _holo(action: str, n: float = 0):
        send("holo", {"cmd": action, "n": int(n or 0)})
        return {"on": "3D mode on. Lean around, sir.", "off": "3D mode off.", "clear": "Cleared.",
                "select": f"Panel {int(n or 0)}.", "back": "Back in the ring.", "next": "Next.", "previous": "Back one."}.get(action, "Done.")

    # ---- LIVE FEEDS: YouTube live streams on screen as a wall of up to 4 windows (news channels, city webcams, NASA) ----
    YT_HEAD = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
               "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+1; SOCS=CAI"}
    CHANNELS = {"sky news": "SkyNews", "al jazeera": "aljazeeraenglish", "aljazeera": "aljazeeraenglish", "dw": "dwnews",
                "france 24": "France24_en", "france24": "France24_en", "nasa": "NASA", "earthcam": "EarthCam"}
    NEWS = ["SkyNews", "aljazeeraenglish", "dwnews", "France24_en"]
    NAMES = {"SkyNews": "Sky News", "aljazeeraenglish": "Al Jazeera English", "dwnews": "DW News", "France24_en": "France 24",
             "NASA": "NASA", "EarthCam": "EarthCam"}
    _live = {}   # cache key -> (time, result): a channel keeps the same stream for hours

    def runs(t): return "".join(r.get("text", "") for r in (t or {}).get("runs", []))

    def yt_page(url):
        import requests
        return requests.get(url, headers=YT_HEAD, timeout=10).text

    def embeddable(vid):
        """YouTube's oEmbed answers 401 for streams whose owner forbids showing them inside other apps."""
        import requests
        try: return requests.get("https://www.youtube.com/oembed", params={"format": "json", "url": f"https://www.youtube.com/watch?v={vid}"},
                                 headers=YT_HEAD, timeout=6).status_code == 200
        except Exception: return True   # can't tell: try it

    def channel_live(handle):
        """The stream a channel is broadcasting now, from its Live tab: the round-the-clock one if it runs several. None if nothing's on air."""
        hit = _live.get(handle)
        if hit and time.time() - hit[0] < 600: return hit[1]
        h = yt_page(f"https://www.youtube.com/@{handle}/streams")
        m = re.search(r"var ytInitialData = (\{.*?\});</script>", h, re.S)
        on = []
        def walk(o):
            if isinstance(o, dict):
                v = o.get("lockupViewModel")
                if v and v.get("contentId"):
                    if "BADGE_STYLE_LIVE" in json.dumps(v.get("contentImage", {})):
                        on.append((v["contentId"], v.get("metadata", {}).get("lockupMetadataViewModel", {}).get("title", {}).get("content", "")))
                    return
                v = o.get("videoRenderer")          # the older page layout
                if v and v.get("videoId"):
                    if '"LIVE"' in json.dumps(v.get("thumbnailOverlays", [])): on.append((v["videoId"], runs(v.get("title"))))
                    return
                for x in o.values(): walk(x)
            elif isinstance(o, list):
                for x in o: walk(x)
        if m:
            try: walk(json.loads(m.group(1)))
            except ValueError: pass
        on.sort(key=lambda v: not re.search(r"24/7|live ?stream|watch .*live|news now|\| live|english .{0,3} live", v[1], re.I))
        vid = next((v for v, _ in on[:4] if embeddable(v)), None)
        out = {"id": vid, "title": NAMES.get(handle, handle) + " · live"} if vid else None
        _live[handle] = (time.time(), out)
        return out

    # News from around the world, one station per panel in the ring (the one in front plays): UK, Qatar, Germany, France,
    # India, Singapore, Australia, the US. All checked to allow playing inside other apps.
    WORLD = ["SkyNews", "aljazeeraenglish", "dwnews", "France24_en", "WION", "ChannelNewsAsia", "abcnewsaustralia", "NBCNews"]
    NAMES.update({"WION": "WION", "ChannelNewsAsia": "CNA", "abcnewsaustralia": "ABC News Australia", "NBCNews": "NBC News"})
    CHANNELS.update({"wion": "WION", "cna": "ChannelNewsAsia", "channel news asia": "ChannelNewsAsia",
                     "abc australia": "abcnewsaustralia", "nbc": "NBCNews"})
    WHERE = {"SkyNews": "United Kingdom", "aljazeeraenglish": "Qatar", "dwnews": "Germany", "France24_en": "France",
             "WION": "India", "ChannelNewsAsia": "Singapore", "abcnewsaustralia": "Australia", "NBCNews": "United States", "NASA": "Space", "EarthCam": ""}

    def news_ring(handles, title):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex: found = list(ex.map(lambda h: (h, channel_live(h)), handles))
        items = [{"kind": "video", "video": f["id"], "title": NAMES.get(h, h), "source": "live" + (" · " + WHERE[h] if WHERE.get(h) else ""),
                  "image": f"https://i.ytimg.com/vi/{f['id']}/hqdefault_live.jpg"} for h, f in found if f]
        if items: panels(title, items)
        return items

    # Webcams: Windy's network of real public cameras (the place's latest picture and today's timelapse; live video where the camera
    # streams). Needs a free Windy key, built in from the WINDY_KEY secret (or WINDY_KEY in .env).
    def windy_key():
        k = os.environ.get("WINDY_KEY", "").strip()
        if k: return k
        import sys
        for d in (getattr(sys, "_MEIPASS", ""), os.path.dirname(os.path.abspath(__file__))):
            p = os.path.join(d, "windy_key")
            if d and os.path.exists(p): return open(p, encoding="utf-8").read().strip()
        return ""

    REGIONS = {"east coast": "New York", "west coast": "Los Angeles", "midwest": "Chicago", "the south": "Atlanta", "new england": "Boston",
               "usa": "United States", "us": "United States", "america": "United States", "uk": "United Kingdom", "britain": "United Kingdom",
               "uae": "United Arab Emirates", "middle east": "Dubai", "europe": "Paris", "west africa": "Lagos", "east africa": "Nairobi",
               "the alps": "Zermatt", "caribbean": "Jamaica", "scandinavia": "Stockholm", "south east asia": "Bangkok", "southeast asia": "Bangkok"}

    def where_is(place):
        """A region the map can't place ("East Coast USA", "somewhere in Europe"): a well-known city in it, or the country it names."""
        p = re.sub(r"[^a-z ]", " ", place.lower())
        for k, v in sorted(REGIONS.items(), key=lambda kv: -len(kv[0])):
            if re.search(rf"\b{k}\b", p): return v
        parts = [w for w in re.split(r"\s+(?:in|of|near|around)\s+|,", place) if w.strip()]
        return parts[-1].strip() if len(parts) > 1 else place

    def webcams(place, n=8):
        import requests
        key = windy_key()
        if not key: return None
        base = {"include": "images,location,player", "limit": 50, "sortKey": "popularity", "sortDirection": "desc", "lang": "en"}
        if not place:
            tries = [{}]                 # nowhere named: the world's most-watched cameras (the streaming ones come first below)
        else:
            alias = where_is(place) if re.fullmatch(r"(the )?(usa|us|u\.s\.a?\.?|america|uk|britain|uae)", place.strip().lower()) else place
            loc = ns["_lookup_location"](alias) or ns["_lookup_location"](where_is(place))     # "USA" alone found a town called Usa in Japan
            if not loc: return []
            fc, cc = loc.get("feature_code") or "", (loc.get("country_code") or "").upper()
            tries = ([{"countries": cc}] if fc.startswith("PCL") and cc else []) + \
                    [{"nearby": f"{loc['latitude']:.4f},{loc['longitude']:.4f},{r}"} for r in (30, 120, 250)]
        for extra in tries:
            r = requests.get("https://api.windy.com/webcams/api/v3/webcams", params={**base, **extra}, headers={"x-windy-api-key": key}, timeout=10)
            if r.status_code in (401, 403): print(f"[CAMS] Windy refused the key ({r.status_code})"); return None
            cams = [w for w in r.json().get("webcams", []) if w.get("status") == "active"]
            cams.sort(key=lambda w: not (w.get("player") or {}).get("live"))       # cameras that stream go first
            out = []
            for w in cams:
                pl, wid = w.get("player") or {}, w.get("webcamId")
                src = pl.get("live") or pl.get("day") or (f"https://webcams.windy.com/webcams/public/embed/player/{wid}/day" if wid else "")
                if not src.startswith("https://webcams.windy.com/"): continue
                loc_ = w.get("location") or {}
                img = ((w.get("images") or {}).get("current") or {}).get("preview") or ""
                out.append({"src": src, "live": bool(pl.get("live")), "title": (w.get("title") or loc_.get("city") or "Webcam")[:70],
                            "where": ", ".join(x for x in (loc_.get("city"), loc_.get("country")) if x)[:50], "image": img})
                if len(out) == n: break
            if out: return out
        return []

    @tool("show_public_cam", "Show live feeds on screen as panels in the ring (the one in front plays, 'next' turns to the next). Webcams of a place ('cameras in Paris', 'live cam of Lagos', 'webcams in Times Square'), "
          "world news ('live news', 'news from around the world': live news stations as panels, the front one plays, 'next' turns to the next), "
          "one station ('Sky News live', 'DW News live', 'Al Jazeera live'), or NASA live. No place ('show me live cameras'): location '' gives "
          "popular webcams worldwide. action close puts the feeds, cameras or news away.",
          {"location": {"type": "string", "description": "a place, a news channel, 'news' or 'nasa'"},
           "action": {"type": "string", "enum": ["show", "close"]}}, ["location"])
    def _live_feeds(location: str = "", action: str = "show"):
        if action == "close": send("feeds", {"cmd": "close"}); send("holo", {"cmd": "clear"}); return "Feeds closed."
        q = (location or "").strip(); ql = q.lower()
        # "live cameras available", "some webcams": no place in it
        place = re.sub(r"\b(live|public|web)?\s*(cams?|cameras?|webcams?|feeds?)\b|\b(available|anywhere|any|some|popular|around the world|in the world|the)\b",
                       "", ql).strip(" ,.?")
        try:
            if any(k in ql for k in CHANNELS):
                handle = next(v for k, v in CHANNELS.items() if k in ql)
                items = news_ring([handle], q.title())
                return f"{NAMES.get(handle, handle)}, live." if items else f"{NAMES.get(handle, handle)} isn't live right now."
            if re.search(r"\bnews\b|\b(stations?|channels?)\b", ql):
                items = news_ring(WORLD, "World news")
                if not items: return "I couldn't get the news stations just now."
                return (f"{len(items)} news stations from around the world. {items[0]['title']} is playing; say next for the next one.")
            cams = webcams(q if place else "")
        except Exception as e:
            print(f"[FEEDS] {type(e).__name__}: {e}"); return "I couldn't reach the live feeds just now."
        if cams is None: return "Webcams aren't set up in this copy of Jarvis yet (it needs a Windy key)."
        if not cams: return f"Windy's network has no public webcams in or near {q} right now (it only covers cameras people have shared with it)."
        # in the ring like the news: the camera in front plays, "next" turns to the next one
        panels(f"Webcams: {q.title() if place else 'around the world'}", [{"kind": "video", "cam": c["src"], "live": c["live"], "title": c["title"],
                                          "source": ("live" if c["live"] else "timelapse") + (" · " + c["where"] if c["where"] else ""),
                                          **({"image": c["image"]} if c["image"].startswith("https://") else {})} for c in cams])
        live = sum(c["live"] for c in cams)
        return (f"{len(cams)} webcam{'s' if len(cams) > 1 else ''} " + (f"of {q}" if place else "from around the world") + (f", {live} streaming live" if live else ", each showing its latest picture and today's timelapse")
                + ". Say next for the next camera, or close them when you're done.")

    # ---- MUSIC: YouTube Music's catalogue, played in a small now-playing card (no account). Songs come first, then videos;
    # after the song, its radio (similar songs) keeps playing. The page plays them and tells us what's on (/music/state). ----
    YTM = "https://music.youtube.com/youtubei/v1/"
    YTM_CTX = {"client": {"clientName": "WEB_REMIX", "clientVersion": "1.20251015.03.00", "hl": "en"}}
    music_now = {"title": "", "artist": "", "playing": False, "error": "", "mode": ""}

    def ytm(endpoint, body):
        import requests
        return requests.post(YTM + endpoint + "?prettyPrint=false", json={"context": YTM_CTX, **body}, timeout=10,
                             headers={**YT_HEAD, "Origin": "https://music.youtube.com", "Content-Type": "application/json"}).json()

    def tidy(title):      # "Rema - Charm (Official Music Video)" -> "Rema - Charm", for the card and for saying it
        return re.sub(r"\s*[\(\[][^)\]]*\b(lyrics?|official|video|audio|visuali[sz]er|hd|4k)\b[^)\]]*[\)\]]", "", title, flags=re.I).strip()[:90]

    def words(t): return set(re.findall(r"[a-z0-9']+", (t or "").lower()))

    def ytm_search(query):
        """Search results as tracks, songs before videos (podcasts, artists and playlists left out)."""
        songs, videos = [], []
        def add(vid, title, sub):
            kind, _, rest = sub.partition(" • ")
            if not vid or kind not in ("Song", "Video"): return
            artist = rest.split(" • ")[0]
            (songs if kind == "Song" else videos).append({"id": vid, "title": tidy(title), "artist": artist[:60]})
        def walk(o):
            if isinstance(o, dict):
                m = o.get("musicResponsiveListItemRenderer")
                if m:
                    cols = [runs(c["musicResponsiveListItemFlexColumnRenderer"]["text"]) for c in m.get("flexColumns", [])]
                    if len(cols) >= 2: add((m.get("playlistItemData") or {}).get("videoId"), cols[0], cols[1])
                    return
                m = o.get("musicCardShelfRenderer")      # the "top result"
                if m:
                    ids = [r.get("navigationEndpoint", {}).get("watchEndpoint", {}).get("videoId") for r in m.get("title", {}).get("runs", [])]
                    add(next((i for i in ids if i), None), runs(m.get("title")), runs(m.get("subtitle")))
                for v in o.values(): walk(v)
            elif isinstance(o, list):
                for v in o: walk(v)
        walk(ytm("search", {"query": query}))
        odd = re.compile(r"\b(cover|instrumental|type beat|karaoke|sped up|slowed|8d|nightcore|reaction|tutorial|mix|compilation|nonstop|playlist|"
                         r"hours?|top \d+|full album)\b", re.I)      # (and an hour-long mix isn't "a song")
        if not odd.search(query):           # the real song before covers and mixes of it
            songs.sort(key=lambda t: bool(odd.search(t["title"]))); videos.sort(key=lambda t: bool(odd.search(t["title"])))
        return songs, videos

    def first_track(query):
        """The song asked for, with every upload of it found: labels often block their audio-only 'song' from playing inside other
        apps while their music video (or a lyric video) is allowed, so the page tries them in turn. Videos first for that reason."""
        songs, videos = ytm_search(query)
        top = (songs + videos)[:1]
        if not top: return None
        t = dict(top[0]); name = words(t["title"]) - {"feat", "ft", "the", "a"}
        same = [v["id"] for v in videos if name and name <= words(v["title"])] + [s_["id"] for s_ in songs if name and name <= words(s_["title"])]
        t["ids"] = list(dict.fromkeys(same + [t["id"]]))[:5]
        return t

    def ytm_radio(vid):
        """The song's radio: up to 24 similar ones, the way YouTube Music plays on after a song. Each with its music-video version too."""
        out = []
        def item(p): return {"id": p["videoId"], "title": tidy(runs(p.get("title"))), "artist": runs(p.get("longBylineText")).split(" • ")[0][:60]}
        def walk(o):
            if isinstance(o, dict):
                w = o.get("playlistPanelVideoWrapperRenderer")       # a song that also has a music video
                if w:
                    p = (w.get("primaryRenderer") or {}).get("playlistPanelVideoRenderer") or {}
                    alt = [((c.get("counterpartRenderer") or {}).get("playlistPanelVideoRenderer") or {}).get("videoId") for c in w.get("counterpart") or []]
                    if p.get("videoId"): out.append({**item(p), "ids": [i for i in alt if i] + [p["videoId"]]})
                    return
                p = o.get("playlistPanelVideoRenderer")
                if p and p.get("videoId"): out.append({**item(p), "ids": [p["videoId"]]}); return
                for v in o.values(): walk(v)
            elif isinstance(o, list):
                for v in o: walk(v)
        try: walk(ytm("next", {"videoId": vid, "playlistId": "RDAMVM" + vid, "isAudioOnly": True}))
        except Exception as e: print(f"[MUSIC] radio: {type(e).__name__}: {e}")
        seen = set(); return [t for t in out if not (t["id"] in seen or seen.add(t["id"]))][:25]

    def yt_search_ids(q, n=4):
        """Plain YouTube search (lyric videos, official audio): the last try for a song whose own uploads won't play inside Jarvis."""
        from urllib.parse import quote_plus
        h = yt_page("https://www.youtube.com/results?search_query=" + quote_plus(q))
        return list(dict.fromkeys(re.findall(r'"videoRenderer":\{"videoId":"([\w-]{11})"', h)))[:n]

    # Plan B: when YouTube won't let its player work inside Jarvis at all (every upload of a song refused), the song opens in a small
    # YouTube Music window instead. It plays on into its radio by itself; pause/next/previous go to it as media keys, stop closes it.
    def open_ytm_window(vid):
        if music_now.get("mode") == "window": close_ytm_window(); time.sleep(0.6)
        open_app_window(f"https://music.youtube.com/watch?v={vid}&list=RDAMVM{vid}")
        music_now.update(mode="window", playing=True, error="")
        print(f"[MUSIC] playing {vid} in a YouTube Music window")

    def close_ytm_window():
        if sys_win(): ns["_window_control"]("close", "youtube music")

    def sys_win():
        import platform
        return platform.system() == "Windows"

    def window_cmd(a):
        if a == "stop": close_ytm_window(); music_now.update(mode="", playing=False, title=""); return "Music off."
        if not sys_win(): return "The YouTube Music window has its own buttons."
        key = {"pause": "play_pause", "resume": "play_pause", "next": "next", "previous": "previous", "louder": "volume_up", "quieter": "volume_down"}.get(a)
        if not key: return "Done."
        ns["_press"](ns["_VK"][key], 4 if key.startswith("volume") else 1)
        return {"pause": "Paused.", "resume": "Resuming.", "next": "Next one.", "previous": "Going back.", "louder": "Louder.", "quieter": "Quieter."}[a]

    @app.post("/music/window")
    async def music_window(payload: dict):
        vid = str(payload.get("id", ""))
        if not re.fullmatch(r"[\w-]{11}", vid): return {"ok": False}
        await asyncio.to_thread(open_ytm_window, vid)
        return {"ok": True}

    # ---- SPOTIFY for people with Premium: Jarvis finds the song with its own Spotify app (app-only access, so Spotify's 5-user limit
    # doesn't apply), and Spotify's own player inside Jarvis plays it for whoever is signed in to Spotify in Jarvis's window. ----
    SP = {"token": "", "until": 0.0}
    CONFIG, save_config = ns["CONFIG"], ns["save_config"]

    def spotify_keys():
        cid, sec = os.environ.get("SPOTIFY_CLIENT_ID", "").strip(), os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()
        if cid and sec: return cid, sec
        import sys
        for d in (getattr(sys, "_MEIPASS", ""), os.path.dirname(os.path.abspath(__file__))):
            p = os.path.join(d, "spotify_client.json")       # written by the build from the SPOTIFY_CLIENT_ID / _SECRET secrets
            if d and os.path.exists(p):
                with open(p, encoding="utf-8") as f: j = json.load(f)
                return j.get("id", ""), j.get("secret", "")
        return "", ""

    def spotify_get(path, params):
        import requests, base64
        if time.time() > SP["until"]:
            cid, sec = spotify_keys()
            if not cid: return None
            r = requests.post("https://accounts.spotify.com/api/token", data={"grant_type": "client_credentials"}, timeout=10,
                              headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{sec}".encode()).decode()})
            r.raise_for_status(); j = r.json()
            SP.update(token=j["access_token"], until=time.time() + int(j.get("expires_in", 3600)) - 60)
        return requests.get("https://api.spotify.com/v1/" + path, params=params, timeout=10, headers={"Authorization": "Bearer " + SP["token"]}).json()

    def spotify_track(q):
        items = (((spotify_get("search", {"q": q[:200], "type": "track", "limit": 5}) or {}).get("tracks") or {}).get("items")) or []
        if not items: return None
        t = items[0]
        return {"sp": t["uri"], "title": t["name"][:90], "artist": ", ".join(a["name"] for a in t.get("artists", [])[:2])[:60]}

    @app.get("/music/sp")
    async def music_sp(q: str = ""):
        try: t = await asyncio.to_thread(spotify_track, q)
        except Exception as e: print(f"[SPOTIFY] search: {type(e).__name__}: {e}"); t = None
        return {"uri": (t or {}).get("sp", "")}

    def open_app_window(url, size="460,620"):
        """A window of Jarvis's own browser (same profile: what you sign in to there, Jarvis's players see too)."""
        import subprocess, webbrowser
        exe, prof = os.environ.get("JARVIS_BROWSER", ""), os.environ.get("JARVIS_BROWSER_PROFILE", "")
        if exe and os.path.exists(exe):
            subprocess.Popen([exe, f"--app={url}", *([f"--user-data-dir={prof}"] if prof else []), f"--window-size={size}", "--window-position=40,60"])
        else: webbrowser.open(url)

    @tool("connect_spotify", "Spotify for people with Spotify Premium: action connect (opens Spotify's sign-in in Jarvis's window; after that "
          "'play X' plays on Spotify), disconnect (back to YouTube Music), status.",
          {"action": {"type": "string", "enum": ["connect", "disconnect", "status"]}}, ["action"])
    def _connect_spotify(action: str = "connect"):
        a = (action or "connect").lower()
        if not spotify_keys()[0]: return "Spotify isn't set up in this copy of Jarvis."
        if a == "status":
            return "Music plays from Spotify." if CONFIG.get("music_source") == "spotify" else "Music plays from YouTube Music. Say connect Spotify to switch."
        if a == "disconnect":
            CONFIG["music_source"] = "youtube"; save_config(CONFIG); return "Back to YouTube Music for songs."
        open_app_window("https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F", "520,720")
        CONFIG["music_source"] = "spotify"; save_config(CONFIG); music_now.update(sp_off=False)
        return ("Spotify's sign-in is open. Sign in with your Premium account, then close that window. "
                "After that, songs play from Spotify.")

    @tool("play_music", "The music player (YouTube Music, plays inside Jarvis). action play with a query (a song, an artist, a mood, a genre: "
          "'play Adele', 'play some jazz'); with no query it plays popular songs. Also pause, resume, next, previous, stop "
          "('stop the music', 'close the player'), louder, quieter, now_playing ('what's playing'). Spell artists the way they're known "
          "(they said 'Bilie Eyelash' -> 'Billie Eilish', 'Ed Sharon' -> 'Ed Sheeran').",
          {"action": {"type": "string", "enum": ["play", "pause", "resume", "next", "previous", "stop", "louder", "quieter", "now_playing"]},
           "query": {"type": "string", "description": "what to play, for play"}}, ["action"])
    def _music(action: str = "play", query: str = ""):
        a = (action or "play").lower().strip()
        if a == "now_playing":
            if music_now.get("error"): return music_now["error"]
            if not music_now["title"]: return "Nothing's playing."
            return f"{'Playing' if music_now['playing'] else 'Paused on'} {music_now['title']}" + (f" by {music_now['artist']}." if music_now["artist"] else ".")
        if a != "play" and music_now.get("mode") == "window": return window_cmd(a)
        if a in ("louder", "quieter") and music_now.get("src") == "spotify" and sys_win():     # Spotify's player has no volume of its own
            ns["_press"](ns["_VK"]["volume_up" if a == "louder" else "volume_down"], 4); return "Louder." if a == "louder" else "Quieter."
        if a != "play":
            send("music", {"cmd": a})
            return {"pause": "Paused.", "resume": "Resuming.", "next": "Next one.", "previous": "Going back.", "stop": "Music off.",
                    "louder": "Louder.", "quieter": "Quieter."}.get(a, "Done.")
        q = (query or "").strip()
        if not q and music_now["title"]: send("music", {"cmd": "resume"}); return "Resuming."
        q = q or "popular songs this week"
        on_sp = re.search(r"\bon spotify\b|\bspotify\b", q, re.I)
        q = re.sub(r"\s*\b(on|from|in)?\s*spotify\b", "", q, flags=re.I).strip() or "popular songs this week"
        if spotify_keys()[0] and not music_now.get("sp_off") and (on_sp or CONFIG.get("music_source") == "spotify"):
            try: first = spotify_track(q)
            except Exception as e: print(f"[SPOTIFY] {type(e).__name__}: {e}"); first = None
            if first:
                music_now.update(error="", src="spotify")
                send("music", {"cmd": "play", "src": "sp", "queue": [first]})
                def more_sp():           # similar songs: YouTube Music's radio for it, each found on Spotify by the page as it comes up
                    try:
                        y = first_track(f"{first['title']} {first['artist']}")
                        rest = [{"title": t["title"], "artist": t["artist"]} for t in (ytm_radio(y["id"]) if y else [])][1:]
                        if rest: send("music", {"cmd": "append", "queue": rest})
                    except Exception as e: print(f"[SPOTIFY] similar songs: {type(e).__name__}: {e}")
                threading.Thread(target=more_sp, daemon=True).start()
                return f"Playing {first['title']}" + (f" by {first['artist']}" if first["artist"] else "") + " on Spotify."
        music_now.update(src="youtube")
        try: first = first_track(q)
        except Exception as e:
            print(f"[MUSIC] {type(e).__name__}: {e}"); return "I couldn't reach YouTube Music just now."
        if not first: return f"I couldn't find {q} on YouTube Music."
        music_now.update(error="")
        if music_now.get("mode") == "window":                   # the player inside Jarvis didn't work earlier this run: straight to the window
            open_ytm_window(first["id"])
            return f"Playing {first['title']}" + (f" by {first['artist']}" if first["artist"] else "") + " in YouTube Music."
        send("music", {"cmd": "play", "queue": [first]})       # it starts now; the similar songs follow a moment later
        def more():
            rest = [t for t in ytm_radio(first["id"]) if t["id"] != first["id"]]
            if rest: send("music", {"cmd": "append", "queue": rest})
        threading.Thread(target=more, daemon=True).start()
        return f"Playing {first['title']}" + (f" by {first['artist']}" if first["artist"] else "") + "."

    @app.get("/music/alt")
    async def music_alt(q: str = ""):
        """Other uploads of a song none of whose own versions would play here."""
        try: return {"ids": await asyncio.to_thread(yt_search_ids, q[:120] + " lyrics")}
        except Exception as e: print(f"[MUSIC] alt: {type(e).__name__}: {e}"); return {"ids": []}

    @app.post("/music/state")
    async def music_state(payload: dict):
        if payload.get("preview"):        # Spotify only played a 30 s preview: not signed in (or not Premium) in Jarvis's window
            print("[SPOTIFY] previews only (not signed in to Premium here): YouTube Music for the rest of this run")
            music_now.update(sp_off=True)
            q = f"{payload.get('title', '')} {payload.get('artist', '')}".strip()
            if q: threading.Thread(target=_music, args=("play", q), daemon=True).start()
            return {"ok": True}
        if payload.get("code") is not None:           # why the player inside Jarvis refused a video (101/150: owner blocks it, 153: config)
            print(f"[MUSIC] player error {payload.get('code')} on {str(payload.get('id', ''))[:11]}"); return {"ok": True}
        music_now.update(title=str(payload.get("title", ""))[:120], artist=str(payload.get("artist", ""))[:80], playing=bool(payload.get("playing")),
                         error=str(payload.get("error", ""))[:200])
        if music_now["error"]: print(f"[MUSIC] {music_now['error']}")
        return {"ok": True}

    def public_url(u):
        """Only fetch pictures from the open internet (no localhost or home-network addresses)."""
        p = urlparse(u)
        if p.scheme not in ("http", "https") or not p.hostname: return False
        try: return all(ipaddress.ip_address(a[4][0]).is_global for a in socket.getaddrinfo(p.hostname, None))
        except Exception: return False

    # ---- HOLO DESK: what its panels show (news with pictures, the weather here, unread email), and the voice command for it ----
    def desk_news():
        res = []
        for q in ("world news", "breaking news", "news"):        # "top news today" finds nothing on DuckDuckGo
            try:
                with ddgs() as d: res = list(d.news(q, max_results=12))
            except Exception: res = []
            if res: break
        out = []
        for r in res:
            when = 0
            try: when = int(datetime.datetime.fromisoformat(str(r.get("date", "")).replace("Z", "+00:00")).timestamp())
            except Exception: pass
            out.append({"title": r.get("title", "")[:160], "body": (r.get("body") or "")[:700], "source": r.get("source") or host_of(r.get("url", "")),
                        "image": r.get("image") or "", "when": when})
        return {"items": out}

    def desk_weather():
        import requests
        d = requests.get("https://wttr.in/?format=j1", timeout=8).json()
        c, area = d["current_condition"][0], (d.get("nearest_area") or [{}])[0]
        place = ", ".join(x[0]["value"] for x in (area.get("areaName"), area.get("country")) if x)
        now_h = datetime.datetime.now().hour
        hours = []
        for day in d.get("weather", [])[:2]:
            for h in day.get("hourly", []):
                hh = int(h.get("time", "0")) // 100
                if day is d["weather"][0] and hh <= now_h: continue
                hours.append({"t": h["tempC"], "at": f"{hh:02d}:00"})
        days = [{"day": datetime.date.fromisoformat(w["date"]).strftime("%a"), "hi": w["maxtempC"], "lo": w["mintempC"]} for w in d.get("weather", [])[:3]]
        return {"temp": c["temp_C"], "feels": c["FeelsLikeC"], "desc": c["weatherDesc"][0]["value"].strip(), "humidity": c["humidity"],
                "wind": c["windspeedKmph"], "place": place, "hours": hours[:6], "days": days}

    def desk_email(one=""):
        svc = ns["_google_service"]("gmail", "v1")
        if svc is None: return {"error": "Gmail isn't connected. Say 'connect my Google account' first."}
        if one:
            if not re.fullmatch(r"[0-9a-fA-F]{6,32}", one): return {"error": "Unknown email."}
            m = svc.users().messages().get(userId="me", id=one, format="full").execute()
            h = {x["name"].lower(): x["value"] for x in m.get("payload", {}).get("headers", [])}
            def text_of(part):
                import base64
                if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
                    return base64.urlsafe_b64decode(part["body"]["data"] + "==").decode("utf-8", "ignore")
                for sub in part.get("parts", []) or []:
                    t = text_of(sub)
                    if t: return t
                return ""
            return {"subject": h.get("subject", ""), "from": re.sub(r"\s*<.*?>", "", h.get("from", "")).strip('" '),
                    "text": ns["_clean_mail_text"](text_of(m.get("payload", {})) or m.get("snippet", ""))[:3000]}
        res = svc.users().messages().list(userId="me", q="is:unread in:inbox", maxResults=15).execute().get("messages", [])
        heads = {}
        def got(rid, m, err):
            if err is None: heads[rid] = (m.get("snippet", ""), {x["name"].lower(): x["value"] for x in m.get("payload", {}).get("headers", [])})
        if res:
            batch = svc.new_batch_http_request(callback=got)
            for r in res: batch.add(svc.users().messages().get(userId="me", id=r["id"], format="metadata", metadataHeaders=["From", "Subject", "Date"]), request_id=r["id"])
            batch.execute()
        items = []
        for r in res:
            snip, h = heads.get(r["id"], ("", {}))
            when = 0
            try:
                import email.utils
                when = int(email.utils.parsedate_to_datetime(h.get("date", "")).timestamp())
            except Exception: pass
            items.append({"id": r["id"], "title": h.get("subject", "(no subject)"), "source": re.sub(r"\s*<.*?>", "", h.get("from", "")).strip('" '), "body": snip, "when": when})
        return {"items": items}

    @app.get("/desk/data")
    async def desk_data(kind: str, id: str = ""):
        fn = {"news": desk_news, "weather": desk_weather, "email": desk_email, "email_one": lambda: desk_email(id)}.get(kind)
        if not fn: return {"error": "Unknown panel."}
        try: return await asyncio.to_thread(fn)
        except Exception as e: print(f"[DESK] {kind}: {type(e).__name__}: {e}"); return {"error": "Couldn't load that just now."}

    @app.post("/desk/open")
    async def desk_open(payload: dict):
        """The desk's Globe and Cameras buttons: those are the big views, so the desk makes way for them."""
        k = payload.get("kind")
        if k == "globe": send("globe", {"cmd": "show", "fly": {"dist": 5.6}})
        elif k == "cams": await asyncio.to_thread(ns["_TOOL_REGISTRY"]["show_public_cam"], "", "show")
        return {"ok": True}

    # ------------------------------------------------------------------ X-RAY MIRROR (xray.js): anatomy drawn on him, and real camera readings
    vitals_now = {"at": 0}
    @app.post("/xray/vitals")
    async def xray_vitals(d: dict):
        vitals_now.update({k: d.get(k) for k in ("pulse", "breath", "blinks", "perclos", "tired", "posture")}, at=time.time())
        return {"ok": True}

    LAYERS = ("skull", "brain", "muscles", "eyes", "hands", "labels")
    @tool("xray_mirror", "The X-ray mirror: the camera as a mirror with a labelled skull, brain, muscles, eyes and hand bones drawn on him in real time "
          "(a model fitted to his face, not his real insides). action: open, close, show (turn layers on: layer=skull|brain|muscles|eyes|hands|labels), "
          "hide (turn a layer off), part (part=all|left|right|top|lower: which part of the head), see_through (amount 0-100).",
          {"action": {"type": "string", "enum": ["open", "close", "show", "hide", "part", "see_through"]}, "layer": {"type": "string"},
           "part": {"type": "string", "enum": ["all", "left", "right", "top", "lower"]}, "amount": {"type": "number"}}, ["action"])
    def _xray(action: str, layer: str = "", part: str = "", amount: float = 60):
        a = (action or "open").lower()
        if a == "close": send("xray", {"cmd": "close"}); return "Back to normal."
        if a == "open": send("xray", {"cmd": "open"}); return "X-ray mirror. Labels, layers and your readings are on the right."
        if a in ("show", "hide"):
            ls = [l for l in LAYERS if l in (layer or "").lower()] or (list(LAYERS[:5]) if "everything" in (layer or "").lower() or "all" in (layer or "").lower() else [])
            if not ls: return "Layers: skull, brain, muscles, eyes, hands, labels."
            send("xray", {"cmd": "open", "opt": {l: a == "show" for l in ls}}); return ("Showing " if a == "show" else "Hiding ") + " and ".join(ls) + "."
        if a == "part": send("xray", {"cmd": "open", "opt": {"cut": part or "all"}}); return {"all": "The whole head.", "left": "Left half.", "right": "Right half.", "top": "Top of the head.", "lower": "Lower face."}.get(part or "all", "Done.")
        if a == "see_through": send("xray", {"cmd": "open", "opt": {"see": max(0, min(100, float(amount))) / 100}}); return f"See-through at {int(amount)} percent."
        return "I can open or close the X-ray mirror, show or hide layers, pick part of the head, or change how see-through it is."

    @tool("vitals", "Readings from the camera, not a medical device: pulse (from tiny colour changes in his face), breathing rate, blinks, tiredness "
          "and posture. action: measure (opens the X-ray mirror and starts; about 20 seconds sitting still), read (the latest numbers), "
          "posture_on (keep an eye on his posture in the background and say when he slouches), posture_off.",
          {"action": {"type": "string", "enum": ["measure", "read", "posture_on", "posture_off"]}}, ["action"])
    def _vitals(action: str = "read"):
        a = (action or "read").lower()
        if a == "measure": send("xray", {"cmd": "open"}); return "Sit still and face the camera in good light for about twenty seconds. Your readings appear on the right."
        if a == "posture_on": send("xray", {"cmd": "watch", "on": True}); return "I'll keep an eye on your posture and say if you slouch for more than half a minute."
        if a == "posture_off": send("xray", {"cmd": "watch", "on": False}); return "Posture watch off."
        v = vitals_now
        if time.time() - v.get("at", 0) > 600: return "I have no recent readings. Say 'measure my pulse' and sit still in front of the camera."
        parts = [f"pulse about {v['pulse']} beats a minute" if v.get("pulse") else "", f"breathing {v['breath']} a minute" if v.get("breath") else "",
                 f"blinking {v['blinks']} times a minute" if v.get("blinks") else "", f"you look {v['tired']}" if v.get("tired") else "",
                 f"posture {v['posture']}" if v.get("posture") else ""]
        said = ", ".join(p for p in parts if p)
        return (said[0].upper() + said[1:] + ". Rough camera readings, not medical ones.") if said else "Still measuring. Sit still for a few more seconds."

    @tool("holo_desk", "The holo desk (mirror mode): the camera fills the screen like a mirror and panels float around him, moved with his hands. "
          "action open (optionally with panel: news, weather, clock, email, music), add (another panel), clear (put the panels away), close (leave it).",
          {"action": {"type": "string", "enum": ["open", "add", "clear", "close"]}, "panel": {"type": "string", "enum": ["news", "weather", "clock", "email", "music"]}}, ["action"])
    def _holo_desk(action: str = "open", panel: str = ""):
        a = (action or "open").lower()
        if a == "close": send("desk", {"cmd": "close"}); return "Desk closed."
        if a == "clear": send("desk", {"cmd": "clear"}); return "Cleared."
        send("desk", {"cmd": "open", **({"panel": panel} if panel else {})})
        return ("Holo desk is open. Pinch a panel to move it, pinch its cross to close it, and hold an open hand still for the menu."
                if a == "open" else f"{(panel or 'Panel').title()}, on the desk.")

    @app.get("/holo/img")
    async def holo_img(u: str):
        """Pictures are fetched here so the page can paint them onto 3D panels (a browser won't let WebGL use another site's image)."""
        def get():
            import requests
            if not public_url(u): return None
            r = requests.get(u, timeout=8, stream=True, headers={"User-Agent": "Mozilla/5.0"})
            ct = r.headers.get("content-type", "")
            if r.status_code != 200 or not ct.startswith("image/"): return None
            data = r.raw.read(4_000_001, decode_content=True)
            return (data, ct) if len(data) <= 4_000_000 else None
        got = await asyncio.to_thread(get)
        if not got: return Response(status_code=404)
        return Response(got[0], media_type=got[1], headers={"Cache-Control": "max-age=86400"})

    # ---- every other answer as a 3D panel: the result of each tool he asks for, and long explanations ----
    import re as _re
    OWN = {"show_public_cam", "search_web", "news_headlines", "show_images", "globe", "holo", "gesture_mode", "plan_my_day", "recap", "schedule", "todo", "get_calendar"}
    NICE = {"get_time": "Time", "time_until": "Countdown", "set_timer": "Timer", "set_reminder": "Reminder", "list_reminders": "Reminders",
            "remember": "Remembered", "recall": "Memory", "list_memories": "Memories", "take_note": "Note", "read_notes": "Notes",
            "translate": "Translation", "spotify_now_playing": "Now playing", "query_documents": "Your documents", "fetch_page": "Page",
            "flip_coin": "Coin", "roll_dice": "Dice", "where_am_i": "Location", "navigation_status": "Trip", "morning_briefing": "Briefing",
            "list_preferences": "Preferences", "list_files": "Files", "search_files": "Files", "read_file": "File", "list_documents": "Documents"}
    SHOW = set(NICE) | {"gmail", "get_weather", "crypto_price", "currency_convert", "calculate", "wikipedia", "system_info"}

    def wiki_card(query, extract):
        import requests
        img, title = None, query.title()
        try:
            j = requests.get("https://en.wikipedia.org/api/rest_v1/page/summary/" + query.replace(" ", "_"), timeout=5,
                             headers={"User-Agent": "Jarvis/1.0 (personal assistant)"}).json()      # Wikipedia refuses requests with no name
            img = (j.get("originalimage") or j.get("thumbnail") or {}).get("source"); title = j.get("title") or title
        except Exception: pass
        cards = [{"kind": "note", "title": title, "text": extract, "source": "wikipedia"}]
        if img: cards.insert(0, {"title": title, "image": img, "source": "wikipedia"})
        return cards

    def tool_cards(name, args, result):
        r = str(result or "").strip()
        if not r or name in OWN or name not in SHOW or r.lower().startswith(("couldn't", "tool ", "unknown")): return None
        if name == "get_weather":
            m = _re.search(r"^(.*?):\s*(.*?),\s*(-?\d+) degrees Celsius,\s*feels like (-?\d+),\s*humidity (\d+)", r)
            if m: return [{"kind": "stat", "label": m.group(1), "value": f"{m.group(3)}°C", "sub": f"{m.group(2)} · feels {m.group(4)}° · humidity {m.group(5)}%"}]
        if name == "crypto_price":
            m = _re.search(r"^(\w+) is (\$[\d,]+(?:\.\d+)?),\s*(up|down) ([\d.]+)", r)
            if m:
                v = m.group(2).split(".")[0] if len(m.group(2)) > 8 else m.group(2)
                return [{"kind": "stat", "label": m.group(1), "value": v, "sub": f"{'▲' if m.group(3) == 'up' else '▼'} {m.group(4)}% in 24h", "tone": m.group(3)}]
        if name == "currency_convert":
            m = _re.search(r"^([\d,.]+ \w+) is about ([\d,.]+) (\w+)", r)
            if m: return [{"kind": "stat", "label": m.group(1), "value": m.group(2), "sub": m.group(3)}]
        if name == "calculate":
            return [{"kind": "stat", "label": str(args.get("expression", "")), "value": r[:18], "sub": ""}]
        if name == "system_info":
            m = _re.search(r"CPU at ([\d.]+) percent, RAM at ([\d.]+)", r)
            if m: return [{"kind": "stat", "label": "CPU", "value": f"{float(m.group(1)):.0f}%", "sub": ""}, {"kind": "stat", "label": "RAM", "value": f"{float(m.group(2)):.0f}%", "sub": ""}]
        if name == "get_time":
            m = _re.search(r"\d{1,2}:\d\d\s*[AP]M", r)
            if m: return [{"kind": "stat", "label": str(args.get("location") or args.get("city") or "Time").title(), "value": m.group(0), "sub": r.replace(m.group(0), "").strip(" ,.")[:60]}]
        if name == "wikipedia": return wiki_card(str(args.get("query", "")), r)
        if name == "gmail":     # "check my email": the list on screen too, numbered like he'll say it ("read number 2")
            rows = _re.findall(r"^(\d+)\. (.*?): (.*)$", r, _re.M)
            if rows: return [{"kind": "list", "title": "Unread email" if r.startswith("Unread") else "Email",
                              "rows": [{"t": n, "title": subj[:90], "sub": who[:60]} for n, who, subj in rows]}]
            m = _re.match(r"Email from (.*?), subject: (.*?)\. (.*?)(\n\(|$)", r, _re.S)
            if m: return [{"kind": "note", "title": m.group(2)[:80], "text": m.group(3)[:900], "source": m.group(1)[:60]}]
            return None
        return [{"kind": "note", "title": NICE.get(name, name.replace("_", " ").title()), "text": r[:700], "source": ""}]

    def on_tool(name, args, result):
        def go():
            cards = tool_cards(name, args or {}, result)
            if cards: panels(NICE.get(name, name), cards)
        threading.Thread(target=go, daemon=True).start()      # never hold up his answer for a picture

    def on_reply(question, answer):
        # an explanation with nothing else on screen gets a panel of its own; short replies stay as subtitles
        if turn.get("panels", 0) or len(answer) < 240: return
        q = _re.sub(r"^(hey |ok )?jarvis[,\s]*", "", question.strip(), flags=_re.I)
        panels(q, [{"kind": "note", "title": (q[:1].upper() + q[1:])[:70], "text": answer[:900], "source": "jarvis"}])

    if "_PANEL_HOOKS" in ns: ns["_PANEL_HOOKS"].update(tool=on_tool, reply=on_reply)

    # search_web and news_headlines were re-registered above: keep one schema per tool name (Groq rejects duplicates)
    if "_TOOL_SCHEMAS" in ns:
        last = {sc["function"]["name"]: sc for sc in ns["_TOOL_SCHEMAS"]}
        if not ns.get("SPOTIFY_READY"):     # not set up on this PC: hide the Spotify tools, so "play X" goes to the music player
            last = {k: v for k, v in last.items() if not k.startswith("spotify_")}
        ns["_TOOL_SCHEMAS"][:] = list(last.values())
    print("[FEATURES] globe, planner, recap, gestures, holo panels ready")
