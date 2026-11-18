"""Jarvis's streaming studio, for the PC Jarvis: he drives OBS (scenes, sources, going live), designs the stream overlays himself
(starting soon with a countdown, the gameplay frame with a wanted-stars goal, mission-passed alerts and a radio, be right back,
ending), and tells the community on Discord and Telegram. server.py calls install(globals()) once.

Setup on the user's side, all optional (Jarvis says what's missing when asked to do something that needs it):
  OBS:      OBS > Tools > WebSocket Server Settings > Enable. If a password is set there, OBS_PASSWORD=... in .env.
  Discord:  Server settings > Integrations > Webhooks > New webhook > Copy URL  ->  DISCORD_WEBHOOK_URL=... in .env
  Telegram: @BotFather > /newbot -> TELEGRAM_BOT_TOKEN=...; add the bot to the group; TELEGRAM_CHAT_ID=... (Jarvis can find it)
"""
import base64, hashlib, html, json, os, re, sys, threading, time, uuid

OVERLAY_DIR = "overlays"          # in Jarvis's data folder (the server runs from there)
PORT = int(os.environ.get("JARVIS_PORT") or 8000)

# ============================================================
# OBS (obs-websocket 5, built into OBS 28 and later)
# ============================================================
class ObsError(Exception): pass

class Obs:
    """A tiny obs-websocket v5 client: connect, identify (with the password if OBS asks for one), then request/response."""
    def __init__(self):
        self.ws = None; self.lock = threading.Lock()

    def _cfg(self):
        return (os.environ.get("OBS_HOST") or "127.0.0.1", int(os.environ.get("OBS_PORT") or 4455), os.environ.get("OBS_PASSWORD") or "")

    def _connect(self):
        from websockets.sync.client import connect
        host, port, pw = self._cfg()
        try: ws = connect(f"ws://{host}:{port}", open_timeout=3, close_timeout=1, max_size=None)
        except Exception as e: raise ObsError("not_running") from e
        hello = json.loads(ws.recv(timeout=3))
        ident = {"rpcVersion": 1, "eventSubscriptions": 0}
        auth = (hello.get("d") or {}).get("authentication")
        if auth:
            if not pw: ws.close(); raise ObsError("needs_password")
            secret = base64.b64encode(hashlib.sha256((pw + auth["salt"]).encode()).digest()).decode()
            ident["authentication"] = base64.b64encode(hashlib.sha256((secret + auth["challenge"]).encode()).digest()).decode()
        ws.send(json.dumps({"op": 1, "d": ident}))
        try: msg = json.loads(ws.recv(timeout=3))
        except Exception as e: raise ObsError("wrong_password") from e      # OBS closes the line on a bad password
        if msg.get("op") != 2: ws.close(); raise ObsError("wrong_password")
        self.ws = ws

    def call(self, rtype, data=None):
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.ws is None: self._connect()
                    rid = uuid.uuid4().hex[:12]
                    self.ws.send(json.dumps({"op": 6, "d": {"requestType": rtype, "requestId": rid, "requestData": data or {}}}))
                    deadline = time.time() + 8
                    while time.time() < deadline:
                        msg = json.loads(self.ws.recv(timeout=max(0.1, deadline - time.time())))
                        d = msg.get("d") or {}
                        if msg.get("op") == 7 and d.get("requestId") == rid:
                            st = d.get("requestStatus") or {}
                            if not st.get("result"): raise ObsError(st.get("comment") or f"OBS refused {rtype} (code {st.get('code')})")
                            return d.get("responseData") or {}
                    raise ObsError("timeout")
                except ObsError as e:
                    if str(e) in ("not_running", "needs_password", "wrong_password") or attempt == 2: raise
                    # an OBS-side refusal ("scene already exists") is a real answer, not a dead line
                    if str(e) != "timeout": raise
                    self._drop()
                except Exception:
                    self._drop()
                    if attempt == 2: raise ObsError("not_running")

    def _drop(self):
        try: self.ws and self.ws.close()
        except Exception: pass
        self.ws = None

OBS = Obs()

def obs_problem(e):
    """What to tell him when OBS can't be reached, in words he can act on."""
    e = str(e)
    if e == "not_running":
        return ("OBS isn't answering. Open OBS, then Tools, WebSocket Server Settings, tick Enable WebSocket server. "
                "If you set a password there, put OBS_PASSWORD equals that password in Jarvis's dot env file.")
    if e == "needs_password": return "OBS wants a password. Put OBS_PASSWORD equals your WebSocket password in Jarvis's dot env file."
    if e == "wrong_password": return "OBS turned down the password. Check OBS_PASSWORD in the dot env file matches OBS's WebSocket settings."
    return f"OBS said: {e}"

WIN = sys.platform == "win32"
SOURCE_KINDS = {     # what he says -> (OBS input kind on Windows, on Mac)
    "game":    ("game_capture", "screen_capture"),
    "screen":  ("monitor_capture", "screen_capture"),
    "display": ("monitor_capture", "screen_capture"),
    "window":  ("window_capture", "screen_capture"),
    "camera":  ("dshow_input", "av_capture_input_v2"),
    "webcam":  ("dshow_input", "av_capture_input_v2"),
    "mic":     ("wasapi_input_capture", "coreaudio_input_capture"),
    "desktop_audio": ("wasapi_output_capture", "coreaudio_output_capture"),
}

# ============================================================
# OVERLAYS
# ============================================================
THEMES = {   # name -> (main, accent, glow, dark, background gradient)
    "vice":    ("#ff4fa3", "#ffb347", "#3ee6e0", "#1a0b2e", "linear-gradient(160deg,#2b0f4c 0%,#c2337a 45%,#ff8a3d 75%,#ffd36e 100%)"),
    "neon":    ("#00e5ff", "#ff2bd6", "#7cff6b", "#05060f", "linear-gradient(160deg,#05060f 0%,#13104a 50%,#2a0a3d 100%)"),
    "gold":    ("#ffcc4d", "#ffffff", "#ffb000", "#0c0a05", "linear-gradient(160deg,#0c0a05 0%,#2a2010 60%,#4a3510 100%)"),
    "crimson": ("#ff3b3b", "#ffffff", "#ff7a00", "#0d0303", "linear-gradient(160deg,#0d0303 0%,#3a0808 60%,#6b0f0f 100%)"),
    "ice":     ("#7fd8ff", "#ffffff", "#b3a1ff", "#04121f", "linear-gradient(160deg,#04121f 0%,#0b3350 60%,#1d5f86 100%)"),
}
THEME_WORDS = [(r"vice|miami|gta|sunset|retro|80s|synthwave|pink", "vice"), (r"neon|cyber|tron|futur", "neon"),
               (r"gold|luxury|royal|black and gold", "gold"), (r"red|crimson|blood|horror|fire", "crimson"),
               (r"ice|blue|frost|winter|clean", "ice")]

def pick_theme(words):
    w = (words or "").lower()
    if w in THEMES: return w
    for pat, name in THEME_WORDS:
        if re.search(pat, w): return name
    return "neon"

STATE = {"alert": None, "goal": None, "now_playing": "", "countdown_end": 0, "setup": {}}

_BASE_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;overflow:hidden;font-family:'Impact','Arial Black','Segoe UI',sans-serif;color:#fff}
.glow{text-shadow:0 0 18px var(--glow),0 0 42px var(--main)}
.pill{display:inline-flex;align-items:center;gap:14px;padding:10px 26px;border-radius:999px;background:rgba(0,0,0,.45);
 border:2px solid var(--main);font-family:'Segoe UI','Arial',sans-serif;font-weight:700;font-size:28px;letter-spacing:1px}
.socials{display:flex;gap:18px;flex-wrap:wrap}
@keyframes drift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes pop{0%{transform:translate(-50%,-140%) scale(.6);opacity:0}12%{transform:translate(-50%,0) scale(1.08);opacity:1}
 18%{transform:translate(-50%,0) scale(1)}85%{opacity:1}100%{transform:translate(-50%,-140%);opacity:0}}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
"""

_STATE_JS = """
let last=null,alertId=null;
function fmt(s){s=Math.max(0,Math.round(s));const m=Math.floor(s/60),x=s%60;return String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')}
async function tick(){
 try{const r=await fetch('/overlay_state',{cache:'no-store'});last=await r.json();}catch(e){}
 if(!last)return;
 const cd=document.getElementById('cd');
 if(cd){const left=(last.countdown_end||0)-Date.now()/1000;cd.textContent=left>0?fmt(left):'LIVE NOW';}
 const g=document.getElementById('goal');
 if(g){if(last.goal){g.style.display='flex';const n=Math.max(1,Math.min(10,last.goal.target||5)),c=Math.min(n,last.goal.current||0);
   document.getElementById('stars').innerHTML=Array.from({length:n},(_,i)=>'<span class="'+(i<c?'on':'off')+'">\\u2605</span>').join('');
   document.getElementById('goal-label').textContent=(last.goal.label||'GOAL')+'  '+c+'/'+n;}else g.style.display='none';}
 const np=document.getElementById('np');
 if(np){if(last.now_playing){np.style.display='flex';document.getElementById('np-text').textContent=last.now_playing;}else np.style.display='none';}
 const al=document.getElementById('alert');
 if(al&&last.alert&&last.alert.id!==alertId){alertId=last.alert.id;
   document.getElementById('al-title').textContent=last.alert.title;document.getElementById('al-sub').textContent=last.alert.sub||'';
   al.style.animation='none';void al.offsetWidth;al.style.animation='pop 6s ease forwards';}
}
tick();setInterval(tick,1000);
"""

def _vars(theme):
    main, accent, glow, dark, bg = THEMES[theme]
    return f":root{{--main:{main};--accent:{accent};--glow:{glow};--dark:{dark}}}", bg

def _socials_html(socials):
    items = [s.strip() for s in re.split(r"[,;\n]|\band\b", socials or "") if s.strip()]
    return "".join(f'<span class="pill">{html.escape(s)}</span>' for s in items[:6])

def _bg_css(bg, image):
    if image: return f"background:url('{html.escape(image)}') center/cover no-repeat,{bg};"
    return f"background:{bg};background-size:300% 300%;animation:drift 18s ease infinite;"

def page_full(kind, theme, title, subtitle, socials, image=""):
    """Starting soon / be right back / ending: full-screen scenes."""
    root, bg = _vars(theme)
    top = {"starting": "STARTING IN", "brb": "BE RIGHT BACK", "ending": "THANKS FOR WATCHING"}[kind]
    countdown = '<div class="cd glow" id="cd">--:--</div>' if kind == "starting" else ""
    big = html.escape(title or "")
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{root}{_BASE_CSS}
body{{{_bg_css(bg, image)}}}
.shade{{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 60%,rgba(0,0,0,0) 0%,rgba(0,0,0,.55) 75%)}}
.wrap{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center}}
.top{{font-size:46px;letter-spacing:12px;color:var(--accent)}}
.title{{font-size:150px;line-height:.95;letter-spacing:4px;max-width:1700px;animation:pulse 4s ease-in-out infinite}}
.sub{{font-size:54px;letter-spacing:10px;color:var(--main);font-style:italic}}
.cd{{font-size:120px;letter-spacing:8px;font-family:'Consolas','Courier New',monospace;font-weight:700}}
.bar{{position:absolute;left:0;right:0;bottom:46px;display:flex;justify-content:center}}
</style></head><body><div class="shade"></div><div class="wrap">
<div class="top">{top}</div><div class="title glow">{big}</div><div class="sub">{html.escape(subtitle or "")}</div>{countdown}
</div><div class="bar"><div class="socials">{_socials_html(socials)}</div></div>
<script>{_STATE_JS}</script></body></html>"""

def page_frame(theme, title, socials):
    """The gameplay overlay: transparent, laid over the game. Border, camera box, wanted-stars goal, alerts, radio, socials."""
    root, _ = _vars(theme)
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{root}{_BASE_CSS}
body{{background:transparent}}
.frame{{position:absolute;inset:10px;border:4px solid var(--main);border-radius:18px;box-shadow:0 0 24px var(--main),inset 0 0 24px rgba(0,0,0,.4)}}
.cam{{position:absolute;left:40px;bottom:120px;width:420px;height:250px;border:4px solid var(--accent);border-radius:14px;box-shadow:0 0 18px var(--accent)}}
.tag{{position:absolute;left:40px;bottom:380px;font-size:30px;letter-spacing:3px;background:var(--main);color:#000;padding:4px 16px;border-radius:8px}}
#goal{{position:absolute;right:40px;top:36px;display:none;flex-direction:column;align-items:flex-end;gap:4px}}
#stars{{font-size:64px;letter-spacing:6px}} #stars .on{{color:var(--accent);text-shadow:0 0 14px var(--accent)}} #stars .off{{color:rgba(255,255,255,.22)}}
#goal-label{{font-size:28px;letter-spacing:4px;background:rgba(0,0,0,.55);padding:4px 14px;border-radius:8px}}
#alert{{position:absolute;left:50%;top:140px;transform:translate(-50%,-140%);opacity:0;text-align:center}}
#al-title{{font-size:120px;letter-spacing:6px;color:var(--accent);text-shadow:0 0 6px #000,0 0 30px var(--accent),4px 4px 0 #000}}
#al-sub{{font-size:44px;font-family:'Segoe UI',sans-serif;font-weight:800;text-shadow:2px 2px 0 #000}}
#np{{position:absolute;right:40px;bottom:46px;display:none;align-items:center;gap:14px}}
#np .pill{{border-color:var(--glow)}}
.socials{{position:absolute;left:40px;bottom:46px}}
.name{{position:absolute;left:40px;top:36px;font-size:40px;letter-spacing:4px}}
</style></head><body><div class="frame"></div>
<div class="name glow">{html.escape(title or "")}</div>
<div class="tag">LIVE</div><div class="cam"></div>
<div id="goal"><div id="stars"></div><div id="goal-label"></div></div>
<div id="alert"><div id="al-title"></div><div id="al-sub"></div></div>
<div id="np"><span class="pill">&#128251; <span id="np-text"></span></span></div>
<div class="socials">{_socials_html(socials)}</div>
<script>{_STATE_JS}</script></body></html>"""

def save_overlay(name, page):
    os.makedirs(OVERLAY_DIR, exist_ok=True)
    safe = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-") or "overlay"
    with open(os.path.join(OVERLAY_DIR, safe + ".html"), "w", encoding="utf-8") as f: f.write(page)
    return safe, f"http://127.0.0.1:{PORT}/overlay/{safe}"

def save_state():
    try:
        os.makedirs(OVERLAY_DIR, exist_ok=True)
        with open(os.path.join(OVERLAY_DIR, "state.json"), "w", encoding="utf-8") as f: json.dump(STATE, f)
    except Exception as e: print(f"[STUDIO] state: {e}")

def load_state():
    try:
        with open(os.path.join(OVERLAY_DIR, "state.json"), encoding="utf-8") as f: STATE.update(json.load(f))
    except Exception: pass

# ============================================================
# DISCORD + TELEGRAM
# ============================================================
def post_discord(text):
    import requests
    url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not url: return False, ("Discord isn't connected. In your server: Server Settings, Integrations, Webhooks, New Webhook, Copy URL, "
                               "then put DISCORD_WEBHOOK_URL equals that link in Jarvis's dot env file.")
    r = requests.post(url, json={"content": text[:1990], "allowed_mentions": {"parse": ["everyone"]}}, timeout=10)
    return (r.status_code in (200, 204)), ("" if r.status_code in (200, 204) else f"Discord said {r.status_code}.")

def telegram_chat_ids():
    """Groups and chats the bot has seen lately (after it's added to a group, someone says anything there)."""
    import requests
    tok = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not tok: return []
    r = requests.get(f"https://api.telegram.org/bot{tok}/getUpdates", timeout=10).json()
    seen = {}
    for u in r.get("result", []):
        m = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
        c = m.get("chat") or {}
        if c.get("id"): seen[c["id"]] = c.get("title") or c.get("username") or c.get("first_name") or str(c["id"])
    return list(seen.items())

def post_telegram(text):
    import requests
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not tok: return False, ("Telegram isn't connected. Message BotFather on Telegram, send slash newbot, and put TELEGRAM_BOT_TOKEN equals the token "
                               "in Jarvis's dot env file. Then add the bot to your group.")
    if not chat:
        ids = telegram_chat_ids()
        if len(ids) == 1: chat = str(ids[0][0])
        elif ids: return False, ("Which Telegram chat? I can see " + ", ".join(f"{n} ({i})" for i, n in ids[:5]) +
                                 ". Put TELEGRAM_CHAT_ID equals the right number in the dot env file.")
        else: return False, "Add the bot to your Telegram group and say anything there, so I can find the group."
    r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage", json={"chat_id": chat, "text": text[:4000]}, timeout=10).json()
    return bool(r.get("ok")), ("" if r.get("ok") else f"Telegram said: {r.get('description', 'no')}.")

# ============================================================
# INSTALL
# ============================================================
STUDIO_WORDS = (r"\b(obs|stream\w*|go(ing)? live|live ?stream|twitch|kick|youtube live|scenes?|overlays?|starting soon|brb|be right back|"
                r"sub(scriber)? goal|wanted stars|follow(er)? goal|mission passed|alerts?|radio|now playing on stream|"
                r"discord|telegram|announce\w*|tell (the|my|our) (gang|community|server|group|followers|chat)|let (everyone|them|the gang) know)\b")

def install(ns):
    tool, app = ns["tool"], ns["app"]
    from fastapi.responses import FileResponse, JSONResponse, Response
    load_state()

    @app.get("/overlay_state")
    async def overlay_state(): return JSONResponse(STATE, headers={"Cache-Control": "no-store"})

    @app.get("/overlay/{name}")
    async def overlay_page(name: str):
        safe = re.sub(r"[^a-z0-9_-]+", "-", name.lower())
        p = os.path.join(OVERLAY_DIR, safe + ".html")
        if not os.path.exists(p): return Response("No such overlay yet.", status_code=404)
        return FileResponse(p, media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.get("/overlay_image")
    async def overlay_image(path: str):
        """A background picture from his own PC, for the full-screen scenes (images only)."""
        if not re.search(r"\.(png|jpe?g|webp|gif)$", path, re.I) or not os.path.isfile(path): return Response(status_code=404)
        return FileResponse(path)

    def image_ref(bg):
        bg = (bg or "").strip().strip('"')
        if not bg: return ""
        if re.match(r"https?://", bg): return bg
        if os.path.isfile(bg): from urllib.parse import quote; return f"/overlay_image?path={quote(bg)}"
        return ""

    def add_browser(scene, name, url, w=1920, h=1080):
        try: OBS.call("CreateInput", {"sceneName": scene, "inputName": name, "inputKind": "browser_source",
                                      "inputSettings": {"url": url, "width": w, "height": h, "reroute_audio": False, "shutdown": False},
                                      "sceneItemEnabled": True})
        except ObsError as e:
            if "already exists" not in str(e).lower(): raise
            OBS.call("SetInputSettings", {"inputName": name, "inputSettings": {"url": url, "width": w, "height": h}})
            try: OBS.call("CreateSceneItem", {"sceneName": scene, "sourceName": name})
            except ObsError: pass

    def add_capture(scene, what, name=None):
        kind = SOURCE_KINDS.get(what, SOURCE_KINDS["screen"])[0 if WIN else 1]
        name = name or {"game": "Game", "screen": "Screen", "display": "Screen", "window": "Window", "camera": "Camera",
                        "webcam": "Camera", "mic": "Mic", "desktop_audio": "Desktop Audio"}.get(what, what.title())
        settings = {"capture_mode": "any_fullscreen"} if kind == "game_capture" else {}
        try: OBS.call("CreateInput", {"sceneName": scene, "inputName": name, "inputKind": kind, "inputSettings": settings, "sceneItemEnabled": True})
        except ObsError as e:
            if "already exists" not in str(e).lower(): raise
            try: OBS.call("CreateSceneItem", {"sceneName": scene, "sourceName": name})
            except ObsError: pass
        return name

    def ensure_scene(name):
        try: OBS.call("CreateScene", {"sceneName": name})
        except ObsError as e:
            if "already exists" not in str(e).lower(): raise

    def send_back(scene, item_name):
        """Put a capture under the overlay (OBS stacks new items on top)."""
        try:
            sid = OBS.call("GetSceneItemId", {"sceneName": scene, "sourceName": item_name})["sceneItemId"]
            OBS.call("SetSceneItemIndex", {"sceneName": scene, "sceneItemId": sid, "sceneItemIndex": 0})
        except Exception: pass

    @tool("stream_studio",
          "Set up a whole live stream in one go: Jarvis designs the overlays (starting soon with countdown, gameplay frame with a "
          "wanted-stars goal, alerts and a radio, be right back, ending) and builds the scenes in OBS. Use for 'prepare my stream', "
          "'set up the stream', 'make scenes for the stream', 'we need designs for the stream'.",
          {"title": {"type": "string", "description": "The big title, e.g. 'DEXTER x GTA 6'"},
           "subtitle": {"type": "string", "description": "e.g. 'MARATHON STREAM'"},
           "theme": {"type": "string", "description": "Look and colours in his words: vice city / neon / gold / red / ice"},
           "socials": {"type": "string", "description": "Handles to show, comma separated, e.g. 'twitch.tv/dexter, @dexter on TikTok'"},
           "countdown_minutes": {"type": "integer", "description": "Starting-soon countdown length, default 5"},
           "goal_label": {"type": "string", "description": "e.g. 'SUB GOAL'"},
           "goal_target": {"type": "integer", "description": "How many stars/subs the goal needs, default 5"},
           "background": {"type": "string", "description": "Optional picture for the full-screen scenes: a file path on this PC or a web link"}},
          ["title"])
    def stream_studio(title, subtitle="", theme="", socials="", countdown_minutes=5, goal_label="SUB GOAL", goal_target=5, background=""):
        th = pick_theme(theme or title)
        img = image_ref(background)
        urls = {}
        for kind, label in (("starting", "Starting Soon"), ("brb", "Be Right Back"), ("ending", "Ending")):
            _, urls[label] = save_overlay(f"jarvis-{kind}", page_full(kind, th, title, subtitle, socials, img))
        _, urls["Gameplay"] = save_overlay("jarvis-gameplay", page_frame(th, title, socials))
        STATE["countdown_end"] = time.time() + 60 * max(0, int(countdown_minutes or 0))
        STATE["goal"] = {"label": (goal_label or "SUB GOAL").upper(), "current": 0, "target": int(goal_target or 5)}
        STATE["setup"] = {"title": title, "subtitle": subtitle, "theme": th, "socials": socials, "background": background}
        save_state()
        try:
            for label, url in urls.items():
                ensure_scene(label)
                if label == "Gameplay":
                    cap = add_capture(label, "game")
                    add_browser(label, "Jarvis Gameplay Overlay", url)
                    send_back(label, cap)
                else: add_browser(label, f"Jarvis {label}", url)
            OBS.call("SetCurrentProgramScene", {"sceneName": "Starting Soon"})
            done = ("Done in OBS: Starting Soon with a " + str(countdown_minutes or 5) + " minute countdown, Gameplay with your "
                    "game, a wanted-stars " + (goal_label or "sub goal").lower() + ", alerts and a radio, plus Be Right Back and Ending. "
                    "Starting Soon is on screen now.")
        except ObsError as e:
            done = ("The designs are ready, but " + obs_problem(e) + " Then say 'build the scenes' and I'll put them in. Or add them "
                    "yourself as browser sources: " + ", ".join(f"{k} {v}" for k, v in urls.items()) + ".")
        return done + " (Offer next, as a question: tell the community on Discord and Telegram, or go live.)"

    @tool("obs",
          "Control OBS. Actions: status, list_scenes, switch_scene (name), add_source (scene, source: game/screen/window/camera/mic/desktop_audio), "
          "mute / unmute (name), start_stream, stop_stream, start_recording, stop_recording, build_scenes (puts the overlays made "
          "earlier into OBS). Going live or ending a stream needs confirmed=true: only after he said yes to it just now.",
          {"action": {"type": "string"}, "name": {"type": "string"}, "scene": {"type": "string"}, "source": {"type": "string"},
           "confirmed": {"type": "boolean"}}, ["action"])
    def obs(action, name="", scene="", source="", confirmed=False):
        a = re.sub(r"[^a-z_]", "", (action or "").lower().replace(" ", "_"))
        try:
            if a in ("start_stream", "go_live", "stop_stream", "end_stream") and not confirmed:
                return ("Ask him first, in one short question, whether to " + ("go live now" if "start" in a or "live" in a else "end the stream") +
                        ". Only call again with confirmed=true after he says yes.")
            if a == "status":
                st = OBS.call("GetStreamStatus"); rec = OBS.call("GetRecordStatus"); cur = OBS.call("GetCurrentProgramScene")
                return (f"On scene {cur.get('currentProgramSceneName') or cur.get('sceneName')}. " +
                        ("Live for " + st.get("outputTimecode", "")[:8] + ". " if st.get("outputActive") else "Not live. ") +
                        ("Recording." if rec.get("outputActive") else "Not recording."))
            if a == "list_scenes":
                return "Scenes: " + ", ".join(s["sceneName"] for s in reversed(OBS.call("GetSceneList").get("scenes", [])))
            if a in ("switch_scene", "scene", "switch"):
                names = [s["sceneName"] for s in OBS.call("GetSceneList").get("scenes", [])]
                want = (name or scene).lower()
                hit = next((n for n in names if n.lower() == want), None) or next((n for n in names if want and want in n.lower()), None)
                if not hit: return "No scene like that. I have " + ", ".join(names) + "."
                OBS.call("SetCurrentProgramScene", {"sceneName": hit}); return f"{hit} is on screen."
            if a == "add_source":
                sc = scene or OBS.call("GetCurrentProgramScene").get("currentProgramSceneName")
                n = add_capture(sc, (source or name or "screen").lower().replace(" ", "_"))
                return f"Added {n} to {sc}." + (" Pick the camera in its settings in OBS if it shows the wrong one." if "cam" in (source or name) else "")
            if a in ("mute", "unmute"):
                OBS.call("SetInputMute", {"inputName": name or "Mic", "inputMuted": a == "mute"}); return f"{name or 'Mic'} {a}d."
            if a in ("start_stream", "go_live"): OBS.call("StartStream"); return "We're live."
            if a in ("stop_stream", "end_stream"): OBS.call("StopStream"); return "Stream ended."
            if a == "start_recording": OBS.call("StartRecord"); return "Recording."
            if a == "stop_recording": OBS.call("StopRecord"); return "Recording stopped and saved."
            if a == "build_scenes":
                s = STATE.get("setup") or {}
                if not s.get("title"): return "There's no stream design yet. Tell me the title and look you want."
                return stream_studio(s["title"], s.get("subtitle", ""), s.get("theme", ""), s.get("socials", ""), 5, (STATE.get("goal") or {}).get("label", "SUB GOAL"),
                                     (STATE.get("goal") or {}).get("target", 5), s.get("background", ""))
            return "OBS actions: status, list_scenes, switch_scene, add_source, mute, unmute, start_stream, stop_stream, start_recording, stop_recording, build_scenes."
        except ObsError as e: return obs_problem(e)

    @tool("overlay",
          "Change the live overlays while streaming. Actions: alert (title, sub: e.g. 'MISSION PASSED' / 'new follower: Sam'), "
          "goal (current, target, label: the wanted stars), add_star, radio (text: what's playing; empty hides it), "
          "countdown (minutes), restyle (theme and/or title, subtitle, socials: redraws every overlay).",
          {"action": {"type": "string"}, "title": {"type": "string"}, "sub": {"type": "string"}, "current": {"type": "integer"},
           "target": {"type": "integer"}, "label": {"type": "string"}, "text": {"type": "string"}, "minutes": {"type": "integer"},
           "theme": {"type": "string"}, "subtitle": {"type": "string"}, "socials": {"type": "string"}}, ["action"])
    def overlay(action, title="", sub="", current=None, target=None, label="", text="", minutes=None, theme="", subtitle="", socials=""):
        a = (action or "").lower().strip()
        if a == "alert":
            STATE["alert"] = {"id": uuid.uuid4().hex[:8], "title": (title or "MISSION PASSED").upper(), "sub": sub, "t": time.time()}
            save_state(); return "Alert's on screen."
        if a in ("goal", "add_star"):
            g = STATE.get("goal") or {"label": "SUB GOAL", "current": 0, "target": 5}
            if a == "add_star": g["current"] = g.get("current", 0) + 1
            if current is not None: g["current"] = int(current)
            if target is not None: g["target"] = int(target)
            if label: g["label"] = label.upper()
            STATE["goal"] = g; save_state()
            return f"{g['label'].title()} at {g['current']} of {g['target']}."
        if a == "radio":
            STATE["now_playing"] = text; save_state(); return "Radio updated." if text else "Radio hidden."
        if a == "countdown":
            STATE["countdown_end"] = time.time() + 60 * int(minutes or 5); save_state(); return f"Countdown reset to {int(minutes or 5)} minutes."
        if a == "restyle":
            s = STATE.get("setup") or {}
            if not (s.get("title") or title): return "There's no stream design yet. Tell me the title and look you want."
            th = pick_theme(theme or s.get("theme", "")); t = title or s.get("title", ""); sb = subtitle or s.get("subtitle", ""); so = socials or s.get("socials", "")
            img = image_ref(s.get("background", ""))
            for kind in ("starting", "brb", "ending"): save_overlay(f"jarvis-{kind}", page_full(kind, th, t, sb, so, img))
            save_overlay("jarvis-gameplay", page_frame(th, t, so))
            STATE["setup"] = {**s, "title": t, "subtitle": sb, "theme": th, "socials": so}; save_state()
            try:      # OBS caches pages: make every Jarvis overlay reload
                for src in ("Jarvis Starting Soon", "Jarvis Be Right Back", "Jarvis Ending", "Jarvis Gameplay Overlay"):
                    try: OBS.call("PressInputPropertiesButton", {"inputName": src, "propertyName": "refreshnocache"})
                    except ObsError: pass
            except Exception: pass
            return f"Restyled: {th} look, title {t}."
        return "Overlay actions: alert, goal, add_star, radio, countdown, restyle."

    @tool("announce",
          "Post a message to his Discord server and/or Telegram group (stream going live, news for the community). where: discord, "
          "telegram or both. First read him the exact message and ask; call with confirmed=true only after he says yes to it.",
          {"message": {"type": "string"}, "where": {"type": "string"}, "confirmed": {"type": "boolean"}}, ["message"])
    def announce(message, where="both", confirmed=False):
        w = (where or "both").lower()
        targets = [t for t in ("discord", "telegram") if t in w] or ["discord", "telegram"]
        if not confirmed:
            return ("Read him this exact message and ask if it should go to " + " and ".join(t.title() for t in targets) +
                    f": {message!r}. Only call again with confirmed=true once he says yes.")
        out = []
        for t in targets:
            try: ok, why = post_discord(message) if t == "discord" else post_telegram(message)
            except Exception as e: ok, why = False, f"{t.title()} couldn't be reached ({type(e).__name__})."
            out.append(f"Sent to {t.title()}." if ok else why)
        return " ".join(out)

    # these words mean a studio job: give the brain the studio tools, and treat the line as a request
    ns["_TOOL_GROUPS"].append((STUDIO_WORDS, ("stream_studio", "obs", "overlay", "announce")))
    _needs = ns["_needs_tool"]
    ns["_needs_tool"] = lambda text: bool(re.search(STUDIO_WORDS, (text or "").lower())) or _needs(text)
    print("[STUDIO] ready: OBS, overlays, Discord and Telegram")
