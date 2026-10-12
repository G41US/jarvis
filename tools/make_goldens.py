"""Run the ORIGINAL Python engines on fixed inputs and save their outputs. The JS ports must reproduce them exactly.
Usage: TZ=UTC python3 tools/make_goldens.py <path-to-jarvis-python-project> > tests/golden.json"""
import json, os, sys, tempfile, time
proj = sys.argv[1]
sys.path.insert(0, proj); sys.path.insert(0, os.path.join(proj, "tests"))
import nav, delivery as dv
from test_nav import vresp, A, B, C, D
from test_delivery import fake_http, fake_matrix, PLACES

G = {}
# ---- formatting
dist_in = [0, 7, 24, 26, 120, 300, 380, 520, 999, 1000, 1500, 1609, 2414, 8000, 16093, 30000, 160934, 25, 75, 125, 175]
G["fmt_distance"] = [[m, u, s, nav.fmt_distance(m, u, s)] for m in dist_in for u in ("miles", "km") for s in (False, True)]
G["fmt_duration"] = [[s, nav.fmt_duration(s)] for s in (0, 10, 44, 45, 89, 90, 119, 150, 600, 3599, 3600, 3660, 7260, 86400)]
G["compass"] = [[b, nav.compass(b)] for b in (0, 22, 23, 45, 90, 180, 270, 337, 359, 360, -10)]
G["units"] = [[s, c, nav.resolve_units(s, c)] for s in ("auto", "miles", "km") for c in ("us", "gb", "ng", "")]
pts = [(51.5074, -0.1278), (-33.8688, 151.2093), (35.6762, 139.6503), (0.0, 0.0), (-1.25, -78.5)]
G["polyline"] = nav.encode_polyline(pts, 6)
G["polyline_decoded"] = nav.decode_polyline(G["polyline"], 6)

# ---- fixtures for the Navigator
val = vresp([[A, B, C], [C, D]], "miles")
G["valhalla_fixture"] = val
class Rec:
    calls = []
def http_val(url, params, body): Rec.calls.append((url, body)); return val
n = nav.Navigator({}, http=http_val)
r = n.route([A, C, D], "auto", "miles", avoid=["tolls"])
r.pop("created", None)
G["valhalla_route"] = r
G["valhalla_body"] = Rec.calls[0][1]
G["summary"] = nav.Navigator.spoken_summary({**r, "created": 0}, "Test Place", now=1760000000)

osrm = {"code": "Ok", "routes": [{"distance": 2000.0, "duration": 300.0, "legs": [{"distance": 2000.0, "duration": 300.0, "steps": [
    {"geometry": nav.encode_polyline([A, B], 6), "distance": 1100.0, "duration": 150.0, "name": "Oak Street", "maneuver": {"type": "depart", "bearing_after": 0, "modifier": ""}},
    {"geometry": nav.encode_polyline([B, C], 6), "distance": 900.0, "duration": 150.0, "name": "Elm Road", "maneuver": {"type": "turn", "modifier": "right"}},
    {"geometry": nav.encode_polyline([C, C], 6), "distance": 0.0, "duration": 0.0, "name": "", "maneuver": {"type": "arrive", "modifier": "right"}}]}]}]}
G["osrm_fixture"] = osrm
def http_osrm(url, params, body):
    if "valhalla" in url: return None
    return osrm
n = nav.Navigator({}, http=http_osrm)
r = n.route([A, C], "auto", "km")
r.pop("created", None)
G["osrm_route"] = r

# ---- delivery scenario at a fixed time
NOW = 1760000000.0
f = tempfile.NamedTemporaryFile(suffix=".db", delete=False); f.close()
msgs = []
c = dv.Copilot(f.name, {"currency": "$"}, broadcast=msgs.append, http_get=fake_http, matrix_fn=fake_matrix)
out = {}
c._set_state("loc", {"lat": 38.6410, "lon": -83.7580, "label": "home base"})
a1 = c.add_order("Taco Bell", "100 elm st", "", 9, "doordash", 0, 0, now=NOW)
a2 = c.add_order("Pizza Hut", "300 pine st", "", 12, "ubereats", 6, 0, now=NOW)
a3 = c.add_order("Subway", "200 oak st", "", 8, "grubhub", 0, 25, now=NOW)
out["adds"] = [a1, a2, a3]
p = c.plan(NOW); out["plan"] = p; out["spoken_plan"] = c.spoken_plan(p); out["spoken_next"] = c.spoken_next(p); out["spoken_orders"] = c.spoken_orders()
ev = c.evaluate_offer("Subway", "400 main st", "", 14, "doordash", 0, now=NOW); out["offer"] = {k: v for k, v in ev.items() if k != "plan"}; out["offer_plan_total"] = ev["plan"]["total_min"]
ev2 = c.evaluate_offer("Subway", "500 far rd", "", 4, "doordash", 0, now=NOW); out["offer_far"] = {k: v for k, v in ev2.items() if k != "plan"}
steps = []
t = NOW + 300
for i in range(6):
    r = c.complete_next("", "", now=t); steps.append(r)
    if not c.has_active(): break
    t += 400
out["completes"] = steps
out["earnings"] = c.earnings(now=t)
out["after_state_loc"] = c._get_state("loc")
G["delivery"] = out
G["delivery_now"] = NOW
print(json.dumps(G, indent=1, default=str))
