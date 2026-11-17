"""Jarvis's mind with a scripted language model: a mission runs its steps quietly and reports back, a correction becomes
a lesson, asking about news in a place makes it something to follow. Run: python3 tests/mind_agent_test.py"""
import json, os, sqlite3, sys, tempfile, threading, time, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "desktop", "app"))
os.chdir(tempfile.mkdtemp())
import mind
mind.MISSION_PAUSE = 0

db = "jarvis.db"
with sqlite3.connect(db) as c:
    c.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, ts TEXT)")
    c.execute("CREATE TABLE events (title TEXT, start REAL)"); c.execute("CREATE TABLE tasks (text TEXT, done_at REAL)")
    c.execute("INSERT INTO messages (role, content, ts) VALUES ('user', 'news in Germany', datetime('now', '-10 minutes'))")

def fake_groq(**kw):
    sysmsg = kw["messages"][0]["content"]
    if "research mission" in sysmsg:
        steps = kw["messages"][1]["content"].count("\n1. ") + kw["messages"][1]["content"].count("\n2. ")
        out = ({"thought": "look it up", "tool": "search_web", "input": "best budget laptops 2026"} if steps == 0 else
               {"tool": "finish", "result": "Get the ThinkPad E14: best keyboard and battery for the money.", "summary": "The ThinkPad E14 wins."})
    elif "corrected you" in sysmsg: out = {"lesson": "When he asks about a place, give news for that exact place."}
    else: out = {}
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=json.dumps(out)))])

REG, sent, notes, screen = {}, [], [], []
def tool(name, desc, props=None, req=None):
    def deco(fn): REG[name] = fn; return fn
    return deco
quiet = threading.local()
def broadcast(msg):
    if getattr(quiet, "on", False): return
    (sent if msg.startswith("proactive:") else screen).append(msg)
def search_web(query): broadcast("panels:" + query); return "- ThinkPad E14 review: great keyboard"
REG.update(search_web=search_web, take_note=lambda text: notes.append(text) or "Note saved.")
def exec_tool(name, raw): return str(REG[name](**json.loads(raw)))
ns = {"PROACTIVE_ENABLED": True, "CONFIG": {"mind_camera": False}, "_MIND": {}, "_groq_create": fake_groq, "_groq_usable": lambda: True,
      "DB_PATH": db, "tool": tool, "_broadcast_ws": broadcast, "_QUIET": quiet, "secrets": __import__("secrets"), "_TOOL_REGISTRY": REG,
      "_exec_tool": exec_tool, "db_get_memories": lambda n: ["Lives in Lagos"], "conversation": [{}], "build_system_prompt": lambda: "",
      "_build_briefing_text": lambda: ("Morning.", False), "save_config": lambda c: None}
mind.install(ns)

print(REG["mission"](action="start", goal="the best budget laptop", by="tonight"))
for _ in range(100):
    if notes: break
    time.sleep(0.05)
assert notes and "ThinkPad" in notes[0], notes
assert screen == [], screen                               # the mission's search didn't pop panels
assert "ThinkPad" in REG["mission"](action="report")
time.sleep(0.1)
assert any("ThinkPad E14 wins" in m for m in sent), sent   # he's "present" (idle 0 off Windows) and not mid-conversation
assert REG["mission"](action="start", goal="") == "What should I work on?"

ns["_MIND"]["heard"]("No, I said France not Germany")
for _ in range(100):
    if "France" in REG["lessons"](action="list"): break
    time.sleep(0.05)
assert "exact place" in REG["lessons"](action="list")
assert "exact place" in ns["_MIND"]["prompt"]()
REG["lessons"](action="forget", text="all"); assert "Nothing yet" in REG["lessons"](action="list")

ns["_MIND"]["heard"]("What's happening in France?")
assert "France" in ns["_MIND"]["prompt"]()
print("mind agent OK")
