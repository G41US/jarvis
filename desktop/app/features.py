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
          "zoom_out (back to the whole Earth). place: for focus/zoom or 'earthquakes near X'.",
          {"action": {"type": "string", "enum": ["show", "hide", "satellite", "holo", "earthquakes", "storms", "iss", "aurora", "focus", "zoom", "zoom_out"]},
           "place": {"type": "string"}}, ["action"])
    def _globe(action: str, place: str = ""):
        a = (action or "show").lower().strip()
        if a == "hide": send("globe", {"cmd": "hide"}); return "Globe away."
        if a in ("show", "holo", "satellite"):
            send("globe", {"cmd": "show", "mode": "sat" if a == "satellite" else "holo"})
            return "Today's satellite view, sir." if a == "satellite" else "The Earth, sir."
        if a == "zoom_out":
            send("globe", {"cmd": "show", "fly": {"dist": 5.6}}); return "The whole Earth."
        if a == "zoom" and not place:
            send("globe", {"cmd": "show", "fly": {"scale": 0.5}}); return "Closer."
        if a in ("focus", "zoom"):
            w = place_of(place)
            if not w: return f"I couldn't find {place}."
            dist = ZOOM[w[3]] if a == "zoom" else max(ZOOM[w[3]], 2.4 if w[3] == "country" else 1.9)
            send("globe", {"cmd": "show", "fly": {"lat": w[0], "lon": w[1], "dist": dist, "label": w[2]}})
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
        path = await asyncio.to_thread(ensure_patch, "sat" if kind == "sat" else "blue", w, s, e, n)
        if not path: return Response(status_code=502)
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    @app.get("/globe/tex/{kind}")
    async def globe_tex(kind: str):
        path = await asyncio.to_thread(ensure_tex, "sat" if kind == "sat" else "blue")
        if not path: return Response(status_code=502)
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    @app.get("/globe/iss")
    async def globe_iss():
        return await asyncio.to_thread(lambda: _json("https://api.wheretheiss.at/v1/satellites/25544", ttl=4))

    @app.get("/hud_extra.js")
    async def hud_extra_js():
        return FileResponse(os.path.join(ns.get("_PROJECT_DIR", "."), "hud_extra.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})

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
          "clear (put the panels away), select (bring panel n forward), back (return it to the ring), next / previous (turn the ring one panel).",
          {"action": {"type": "string", "enum": ["on", "off", "clear", "select", "back", "next", "previous"]}, "n": {"type": "number"}}, ["action"])
    def _holo(action: str, n: float = 0):
        send("holo", {"cmd": action, "n": int(n or 0)})
        return {"on": "3D mode on. Lean around, sir.", "off": "3D mode off.", "clear": "Cleared.",
                "select": f"Panel {int(n or 0)}.", "back": "Back in the ring.", "next": "Next.", "previous": "Back one."}.get(action, "Done.")

    def public_url(u):
        """Only fetch pictures from the open internet (no localhost or home-network addresses)."""
        p = urlparse(u)
        if p.scheme not in ("http", "https") or not p.hostname: return False
        try: return all(ipaddress.ip_address(a[4][0]).is_global for a in socket.getaddrinfo(p.hostname, None))
        except Exception: return False

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
    OWN = {"search_web", "news_headlines", "show_images", "globe", "holo", "gesture_mode", "plan_my_day", "recap", "schedule", "todo", "get_calendar"}
    NICE = {"get_time": "Time", "time_until": "Countdown", "set_timer": "Timer", "set_reminder": "Reminder", "list_reminders": "Reminders",
            "remember": "Remembered", "recall": "Memory", "list_memories": "Memories", "take_note": "Note", "read_notes": "Notes",
            "translate": "Translation", "spotify_now_playing": "Now playing", "query_documents": "Your documents", "fetch_page": "Page",
            "flip_coin": "Coin", "roll_dice": "Dice", "where_am_i": "Location", "navigation_status": "Trip", "morning_briefing": "Briefing",
            "list_preferences": "Preferences", "list_files": "Files", "search_files": "Files", "read_file": "File", "list_documents": "Documents"}
    SHOW = set(NICE) | {"get_weather", "crypto_price", "currency_convert", "calculate", "wikipedia", "system_info"}

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
        ns["_TOOL_SCHEMAS"][:] = list(last.values())
    print("[FEATURES] globe, planner, recap, gestures, holo panels ready")
