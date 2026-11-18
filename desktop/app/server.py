import unicodedata
import os
_PROJECT_DIR = os.environ.get("JARVIS_HOME") or os.path.dirname(os.path.abspath(__file__))   # the installed app keeps its data in a user folder
_CACHE_ROOT = os.path.join(_PROJECT_DIR, ".cache")
os.makedirs(os.path.join(_CACHE_ROOT, "hf"), exist_ok=True)
os.makedirs(os.path.join(_CACHE_ROOT, "fastembed"), exist_ok=True)
os.environ.setdefault("HF_HOME", os.path.join(_CACHE_ROOT, "hf"))
os.environ.setdefault("FASTEMBED_CACHE_PATH", os.path.join(_CACHE_ROOT, "fastembed"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

def _load_dotenv():
    """Read KEY=VALUE lines from .env next to server.py (no extra dependency).
    Values in .env override older system environment variables (a stale Windows variable was the
    classic cause of "Invalid API Key" even after pasting a new one). Blank values are ignored."""
    path = os.path.join(_PROJECT_DIR, ".env")
    if not os.path.exists(path): return
    loaded = []
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line: continue
                k, v = line.split("=", 1)
                k = k.strip(); v = v.strip().strip('"').strip("'").strip()
                if k and v:
                    os.environ[k] = v; loaded.append(k)
    except Exception as e:
        print(f"[ENV] could not read .env: {e}"); return
    print("[ENV] loaded from .env: " + (", ".join(loaded) if loaded else "nothing (all values blank?)"))
_load_dotenv()

import json, glob, sqlite3, subprocess, platform, datetime, tempfile, wave, re, sys
import shutil, threading, secrets, string, urllib.parse, webbrowser, asyncio, time, random
import traceback, xml.etree.ElementTree as ET, base64
from contextlib import closing, asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Body
from fastapi.responses import HTMLResponse, Response, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import ollama
import psutil

MAIN_LOOP = None
CONVERSATION_SUMMARY = ""
PROACTIVE_ENABLED = os.environ.get("JARVIS_PROACTIVE", "1") != "0"

# ============================================================
# SPOTIFY CREDENTIALS  (read from .env or the environment — never hardcode them)
# ============================================================
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8888/callback"
SPOTIFY_SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played"
SPOTIFY_READY = bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET and os.path.exists(".spotify_cache"))

# ============================================================
# WEBSOCKET BROADCAST
# ============================================================
ws_clients = set()

_QUIET = threading.local()     # set on a background thread (Jarvis's missions) so the tools it uses don't pop panels on screen
# "sir" is seasoning, not punctuation: at most one in a reply, and most replies (and things he says on his own) without it
_SIR = {"n": 0}
def _drop_sir(text):
    t = re.sub(r"^\s*(sir|ma'?am)\s*[,.!]\s*", "", text, flags=re.I)                       # "Sir, the ..." / "Sir." at the start
    t = re.sub(r"\s*,\s*(sir|ma'?am)\b\s*(?=[.!?,;:]|$)", "", t, flags=re.I)              # "..., sir." / "..., sir, and"
    t = re.sub(r"(?<=\w)\s+(sir|ma'?am)\s*,", ",", t, flags=re.I)                          # "Yes sir, on it" -> "Yes, on it"
    t = re.sub(r"\b(sir|ma'?am)\s*,\s*", "", t, flags=re.I)                               # what's left mid-line
    t = re.sub(r"\s+(sir|ma'?am)\b(?=\s*[.!?]|\s*$)", "", t, flags=re.I)                   # "Done sir."
    t = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), t.strip())
    return t or text
def _tame_sir(text, allow):
    """allow: may this line keep one 'sir'. Returns (text, used_one)."""
    if not text or not re.search(r"\b(sir|ma'?am)\b", text, re.I): return text, False
    if not allow: return _drop_sir(text), False
    m = re.search(r"\b(sir|ma'?am)\b", text, re.I)                     # keep the first, drop the rest
    return text[:m.end()] + _drop_sir(text[m.end():]) if re.search(r"\b(sir|ma'?am)\b", text[m.end():], re.I) else text, True
async def _sir_tamed(gen):
    _SIR["n"] += 1; allow = _SIR["n"] % 3 == 1
    async for ev in gen:
        if ev.startswith("data:") and '"sentence"' in ev:
            try:
                obj = json.loads(ev[5:])
                if obj.get("type") == "sentence":
                    obj["text"], used = _tame_sir(obj.get("text", ""), allow); allow = allow and not used; ev = _sse(obj)
            except Exception: pass
        yield ev

def _broadcast_ws(msg: str):
    if MAIN_LOOP is None or getattr(_QUIET, "on", False): return
    if isinstance(msg, str) and msg.startswith("proactive:"):
        _SIR["n"] += 1; msg = "proactive:" + _tame_sir(msg[10:], _SIR["n"] % 3 == 1)[0]
    async def _send():
        dead = set()
        for c in list(ws_clients):
            try: await c.send_text(msg)
            except Exception: dead.add(c)
        ws_clients.difference_update(dead)
    try: asyncio.run_coroutine_threadsafe(_send(), MAIN_LOOP)
    except Exception as e: print(f"[WS] bcast fail: {e}")

# ============================================================
# PLUGIN REGISTRY
# ============================================================
_TOOL_REGISTRY = {}
_TOOL_SCHEMAS = []

def schema(name, desc, props=None, req=None):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props or {}, "required": req or []}}}

def safe(fn, fail):
    def w(*a, **k):
        try: return fn(*a, **k)
        except Exception as e:
            print(f"[TOOL FAIL] {fn.__name__}: {type(e).__name__}: {e}")
            return fail
    return w

def tool(name, description="", properties=None, required=None):
    def decorator(fn):
        _TOOL_REGISTRY[name] = safe(fn, f"Couldn't execute {name}.")
        _TOOL_SCHEMAS.append(schema(name, description or fn.__doc__ or "", properties or {}, required or []))
        return fn
    return decorator

# ============================================================
# FACE RECOGNITION
# ============================================================
FACE_DETECT_MODEL = "models/face_detection_yunet.onnx"
FACE_RECOG_MODEL = "models/face_recognition_sface.onnx"
FACE_DETECT_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
FACE_RECOG_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"
FACE_MATCH_THRESHOLD = 0.42
FACE_DETECT_SCORE = 0.35
DEBUG_FRAMES_DIR = Path("debug_frames")
DEBUG_FRAMES_DIR.mkdir(exist_ok=True)
_DEBUG_FRAME_COUNTER = {"n": 0}

_face_detector = None
_face_recognizer = None
_haar_cascade = None
_face_models_ready = False
_face_ready_event = threading.Event()
_face_load_lock = threading.Lock()
_pending_enroll = {}
_pending_identify = {}
_pending_vision = {}

_MIN_DETECT_SIZE = 200_000
_MIN_RECOG_SIZE = 30_000_000

def _ensure_face_models():
    global _face_detector, _face_recognizer, _haar_cascade, _face_models_ready
    if _face_models_ready:
        _face_ready_event.set()
        return True
    with _face_load_lock:
        if _face_models_ready:
            _face_ready_event.set()
            return True
        try:
            import cv2, requests
        except ImportError as e:
            print(f"[FACE] opencv unavailable: {e}")
            return False
        os.makedirs("models", exist_ok=True)
        for path, url, min_size in [
            (FACE_DETECT_MODEL, FACE_DETECT_URL, _MIN_DETECT_SIZE),
            (FACE_RECOG_MODEL, FACE_RECOG_URL, _MIN_RECOG_SIZE),
        ]:
            if os.path.exists(path) and os.path.getsize(path) >= min_size:
                print(f"[FACE] {os.path.basename(path)} present ({os.path.getsize(path)} bytes)")
                continue
            if os.path.exists(path):
                try: os.unlink(path)
                except Exception: pass
            try:
                print(f"[FACE] Downloading {os.path.basename(path)}...")
                r = requests.get(url, timeout=300, allow_redirects=True, stream=True)
                r.raise_for_status()
                tmp = path + ".part"
                total = 0
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(chunk_size=65536):
                        if chunk:
                            f.write(chunk)
                            total += len(chunk)
                os.replace(tmp, path)
                print(f"[FACE] {os.path.basename(path)} saved ({total} bytes)")
            except Exception as e:
                print(f"[FACE] Download failed for {path}: {e}")
        try:
            cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            _haar_cascade = cv2.CascadeClassifier(cascade_path)
            if _haar_cascade.empty(): _haar_cascade = None
            else: print(f"[FACE] Haar loaded")
        except Exception: _haar_cascade = None
        if os.path.exists(FACE_DETECT_MODEL) and os.path.getsize(FACE_DETECT_MODEL) >= _MIN_DETECT_SIZE:
            try:
                _face_detector = cv2.FaceDetectorYN.create(
                    FACE_DETECT_MODEL, "", (320, 320), FACE_DETECT_SCORE, 0.3, 5000)
                print(f"[FACE] Yunet detector loaded")
            except Exception as e:
                print(f"[FACE] Yunet init failed: {e}")
                _face_detector = None
        else: _face_detector = None
        if os.path.exists(FACE_RECOG_MODEL) and os.path.getsize(FACE_RECOG_MODEL) >= _MIN_RECOG_SIZE:
            try:
                _face_recognizer = cv2.FaceRecognizerSF.create(FACE_RECOG_MODEL, "")
                print(f"[FACE] Recognizer loaded")
            except Exception as e:
                print(f"[FACE] Recognizer init failed: {e}")
                _face_recognizer = None
        else: _face_recognizer = None
        if _face_detector is None and _haar_cascade is None:
            print("[FACE] FATAL: no detectors available")
            return False
        _face_models_ready = True
        _face_ready_event.set()
        print("[FACE] Face system ready.")
        return True

def _save_debug_frame(img_bgr, label="frame"):
    try:
        import cv2
        _DEBUG_FRAME_COUNTER["n"] += 1
        n = _DEBUG_FRAME_COUNTER["n"]
        ts = datetime.datetime.now().strftime("%H%M%S")
        path = DEBUG_FRAMES_DIR / f"{label}_{ts}_{n:03d}.jpg"
        cv2.imwrite(str(path), img_bgr)
        return str(path)
    except Exception: return None

def _decode_b64_image(b64: str):
    import numpy as np, cv2
    if not b64: return None
    if "," in b64: b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as e:
        print(f"[FACE] decode fail: {e}"); return None

def _try_yunet(img_bgr):
    if _face_detector is None: return None
    try:
        h, w = img_bgr.shape[:2]
        _face_detector.setInputSize((w, h))
        _, faces = _face_detector.detect(img_bgr)
        if faces is None or len(faces) == 0: return None
        return max(faces, key=lambda f: f[2] * f[3])
    except Exception as e:
        print(f"[FACE] Yunet fail: {e}")
        return None

def _try_haar(img_bgr):
    if _haar_cascade is None: return None
    import numpy as np, cv2
    try:
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        for (neighbors, min_size) in [(4, 60), (3, 40), (2, 30)]:
            faces = _haar_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=neighbors, minSize=(min_size, min_size))
            if len(faces) > 0:
                x, y, w, h = max(faces, key=lambda r: r[2] * r[3])
                face = np.zeros(15, dtype=np.float32)
                face[0] = x; face[1] = y; face[2] = w; face[3] = h
                face[4]  = x + w * 0.30; face[5]  = y + h * 0.35
                face[6]  = x + w * 0.70; face[7]  = y + h * 0.35
                face[8]  = x + w * 0.50; face[9]  = y + h * 0.60
                face[10] = x + w * 0.35; face[11] = y + h * 0.82
                face[12] = x + w * 0.65; face[13] = y + h * 0.82
                face[14] = 1.0
                return face
        return None
    except Exception as e:
        print(f"[FACE] Haar fail: {e}")
        return None

def _extract_embedding(img_bgr, save_debug=True, label="face"):
    import numpy as np, cv2
    ok = _ensure_face_models()
    if not ok and not _face_models_ready:
        _face_ready_event.wait(timeout=180)
        ok = _face_models_ready
    if img_bgr is None: return None
    if not ok: return None
    try:
        if save_debug: _save_debug_frame(img_bgr, label)
        face = _try_yunet(img_bgr)
        if face is None: face = _try_haar(img_bgr)
        if face is None:
            stats = float(img_bgr.astype(np.float32).mean())
            if stats < 100:
                boosted = cv2.convertScaleAbs(img_bgr, alpha=1.8, beta=30)
                face = _try_yunet(boosted)
                if face is None: face = _try_haar(boosted)
                if face is not None: img_bgr = boosted
        if face is None: return None
        if _face_recognizer is not None:
            try:
                aligned = _face_recognizer.alignCrop(img_bgr, face)
                return _face_recognizer.feature(aligned).flatten()
            except Exception as e:
                print(f"[FACE] alignCrop failed: {e}")
                x, y, fw, fh = int(face[0]), int(face[1]), int(face[2]), int(face[3])
                pad_x = int(fw * 0.2); pad_y = int(fh * 0.2)
                x = max(0, x - pad_x); y = max(0, y - pad_y)
                w2 = min(img_bgr.shape[1] - x, fw + 2 * pad_x)
                h2 = min(img_bgr.shape[0] - y, fh + 2 * pad_y)
                crop = img_bgr[y:y+h2, x:x+w2]
                if crop.size == 0: return None
                crop = cv2.resize(crop, (112, 112))
                return _face_recognizer.feature(crop).flatten()
        return None
    except Exception as e:
        print(f"[FACE] extract fail: {type(e).__name__}: {e}")
        return None

def _cosine(a, b):
    import numpy as np
    na = float(np.linalg.norm(a)); nb = float(np.linalg.norm(b))
    if na < 1e-8 or nb < 1e-8: return 0.0
    return float(np.dot(a, b) / (na * nb))

def _identify_face(img_bgr):
    try:                                   # the last frame looked at, so a dark or covered camera can be checked
        import cv2; DEBUG_FRAMES_DIR.mkdir(exist_ok=True); cv2.imwrite(str(DEBUG_FRAMES_DIR / "identify_last.jpg"), img_bgr)
    except Exception: pass
    emb = _extract_embedding(img_bgr, save_debug=False)
    if emb is None:
        print(f"[FACE] no face in the camera frame (brightness {float(img_bgr.mean()):.0f} of 255)"); return None
    faces = db_get_all_faces()
    if not faces: return None
    best, top = None, (0.0, "")
    for fid, name, title, ref in faces:
        sim = _cosine(emb, ref)
        if sim > top[0]: top = (sim, name)
        if sim >= FACE_MATCH_THRESHOLD and (best is None or sim > best[3]):
            best = (fid, name, title, sim)
    print(f"[FACE] closest match {top[1]} at {top[0]:.2f} (recognised from {FACE_MATCH_THRESHOLD})")
    return best

def _time_of_day():
    h = datetime.datetime.now().hour
    if 5 <= h < 12: return "Good morning"
    if 12 <= h < 17: return "Good afternoon"
    return "Good evening"

_FACE_ENROLL_INTENT = re.compile(
    r"("
    r"\bremember (my|this|the) face\b|"
    r"\bremember me\b|"
    r"\bsave (my|this) face\b|"
    r"\bregister (my|this) face\b|"
    r"\badd (my|this) face\b|"
    r"\blearn (my|this) face\b|"
    r"\bthis is me\b|"
    r"\bthat'?s me\b|"
    r"\benrol+ me\b|"
    r"\brecognise me\b|"
    r"\brecognize me\b|"
    r"\bremember who i am\b|"
    r"\bstore (my|this) face\b|"
    r"\bsave me as\b|"
    r"\bmy name is\b|"
    r"\bi am (mr|mrs|ms|miss|dr|sir)\b|"
    r"\bi'?m (mr|mrs|ms|miss|dr|sir)\b|"
    r"\bi want(ed)? you to remember (my face|me)\b|"
    r"\bi want(ed)? to remember my face\b|"
    r"\bi want(ed)? to register my face\b|"
    r"\bi want(ed)? to save my face\b|"
    r"\bput my face\b|"
    r"\bset up my face\b"
    r")", re.I
)
_FACE_QUERY_INTENT = re.compile(
    r"("
    r"\bdo you (remember|know) (my face|me|who i am)\b|"
    r"\bwho am i\b|"
    r"\bdo you recogni[sz]e me\b|"
    r"\bwhat.?s my name\b|"
    r"\bwhat is my name\b"
    r")", re.I
)
_FACE_FORGET_INTENT = re.compile(
    r"("
    r"\bforget my face\b|"
    r"\bforget me\b|"
    r"\bremove my face\b|"
    r"\bdelete my face\b|"
    r"\bunregister my face\b|"
    r"\bforget who i am\b"
    r")", re.I
)
_TITLE_MAP = {"mr": "Mr", "mrs": "Mrs", "ms": "Ms", "miss": "Miss", "dr": "Dr", "sir": "Sir"}
_NOT_NAMES = {"is", "the", "a", "an", "not", "mr", "mrs", "ms", "miss", "dr", "sir",
              "and", "my", "me", "here", "back", "in", "at", "the", "your",
              "name", "going", "trying", "just", "wanted", "want", "you", "i", "sorry"}

def _extract_name_title(text):
    m = re.search(r"\b(Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?|Sir)\s+([A-Za-z][a-zA-Z\-']*)", text, re.I)
    if m:
        t_raw = m.group(1).rstrip('.').lower()
        title = _TITLE_MAP.get(t_raw, "")
        name = m.group(2)
        if name.lower() not in _NOT_NAMES:
            return name.capitalize(), title
    m = re.search(r"\b(?:i am|i'm|my name is|name is|call me|name's|this is|that's|that is)\s+([A-Za-z][a-zA-Z\-']*)", text, re.I)
    if m:
        name = m.group(1)
        if name.lower() not in _NOT_NAMES:
            return name.capitalize(), ""
    return "", ""

def _identify_from_browser(timeout=8.0):
    rid = secrets.token_hex(4)
    evt = threading.Event()
    _pending_identify[rid] = {"event": evt, "image_b64": None}
    _broadcast_ws(f"identify_request:{rid}")
    if not evt.wait(timeout=timeout):
        _pending_identify.pop(rid, None); return None
    data = _pending_identify.pop(rid, {})
    img_b64 = data.get("image_b64")
    if not img_b64: return None
    img = _decode_b64_image(img_b64)
    if img is None: return None
    return _identify_face(img)

# ============================================================
# DATABASE
# ============================================================
DB_PATH = "jarvis.db"

def db_init():
    with closing(sqlite3.connect(DB_PATH)) as c:
        c.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP)")
        c.execute("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP)")
        c.execute("CREATE TABLE IF NOT EXISTS memory_vectors (memory_id INTEGER PRIMARY KEY, embedding BLOB)")
        c.execute("CREATE TABLE IF NOT EXISTS summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP)")
        c.execute("CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY AUTOINCREMENT, pref TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP)")
        c.execute("CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, fire_at REAL, text TEXT, fired INTEGER DEFAULT 0)")
        c.execute("CREATE TABLE IF NOT EXISTS doc_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, mtime REAL, chunk_idx INTEGER, content TEXT, embedding BLOB)")
        c.execute("CREATE TABLE IF NOT EXISTS faces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, title TEXT, embedding BLOB NOT NULL, ts DATETIME DEFAULT CURRENT_TIMESTAMP)")
        c.commit()
db_init()

_VOICE_HISTORY_BLOCK = re.compile(r"\b(voice|voices|alan|amy|male voice|female voice)\b", re.I)

def db_load_recent(limit=20):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?", (limit*3,)).fetchall()
        out = []
        for r, content in reversed(rows):
            if _VOICE_HISTORY_BLOCK.search(content or ""): continue
            out.append({"role": r, "content": content})
        return out[-limit:]
    except Exception: return []

def db_save(role, content):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("INSERT INTO messages (role, content) VALUES (?, ?)", (role, content)); c.commit()
    except Exception: pass

def db_wipe():
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            for t in ("messages","memories","memory_vectors","summaries","preferences","reminders","doc_chunks","faces"):
                c.execute(f"DELETE FROM {t}")
            c.commit()
    except Exception: pass

def _vec_to_blob(v):
    import numpy as np
    return np.asarray(v, dtype="<f4").tobytes()
def _blob_to_vec(b):
    import numpy as np
    return np.frombuffer(b, dtype="<f4")

def db_save_memory(fact):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            cur = c.execute("INSERT INTO memories (fact) VALUES (?)", (fact,))
            mid = cur.lastrowid
            if EMBEDDER is not None:
                try:
                    vec = list(EMBEDDER.embed([fact]))[0]
                    c.execute("INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)", (mid, _vec_to_blob(vec)))
                except Exception as e: print(f"[RAG] embed fail: {e}")
            c.commit()
    except Exception as e: print(f"[MEM] {e}")

def db_get_memories(limit=30):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT fact FROM memories ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [r[0] for r in reversed(rows)]
    except Exception: return []

def db_search_memories(query, limit=10):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT fact FROM memories WHERE fact LIKE ? ORDER BY id DESC LIMIT ?", (f"%{query}%", limit)).fetchall()
        return [r[0] for r in rows]
    except Exception: return []

def db_search_memories_semantic(query, limit=5):
    if EMBEDDER is None: return db_search_memories(query, limit)
    try:
        import numpy as np
        qvec = np.asarray(list(EMBEDDER.query_embed([query]))[0], dtype=np.float32)
        qn = float(np.linalg.norm(qvec))
        if qn < 1e-8: return []
        qvec = qvec / qn
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT m.fact, v.embedding FROM memories m JOIN memory_vectors v ON v.memory_id=m.id").fetchall()
        scored = []
        for fact, blob in rows:
            v = _blob_to_vec(blob); vn = float(np.linalg.norm(v))
            if vn < 1e-8: continue
            scored.append((float(np.dot(qvec, v/vn)), fact))
        scored.sort(key=lambda x: x[0], reverse=True)
        out = [f for s, f in scored[:limit] if s >= 0.35]
        return out if out else db_search_memories(query, limit)
    except Exception as e:
        print(f"[RAG] search fail: {e}"); return db_search_memories(query, limit)

def db_load_summary():
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            r = c.execute("SELECT content FROM summaries ORDER BY id DESC LIMIT 1").fetchone()
        return r[0] if r else ""
    except Exception: return ""
def db_save_summary(text):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("DELETE FROM summaries"); c.execute("INSERT INTO summaries (content) VALUES (?)", (text,)); c.commit()
    except Exception: pass

_VOICE_PURGE = re.compile(r"\b(voice|voices|alan|amy|male|female)\b", re.I)
def db_purge_voice_messages():
    # Whole-word match. The old LIKE '%male%' / '%alan%' / '%voice%' also deleted
    # unrelated history such as "balance", "invoice" and "female".
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            ids = [r[0] for r in c.execute("SELECT id, content FROM messages") if _VOICE_PURGE.search(r[1] or "")]
            c.executemany("DELETE FROM messages WHERE id=?", [(i,) for i in ids])
            c.commit()
            if ids: print(f"[DB] Purged {len(ids)} voice-related msgs.")
    except Exception as e: print(f"[DB] purge fail: {e}")
db_purge_voice_messages()

def db_save_preference(pref):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("INSERT INTO preferences (pref) VALUES (?)", (pref,)); c.commit()
    except Exception: pass
def db_get_preferences(limit=20):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT pref FROM preferences ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [r[0] for r in reversed(rows)]
    except Exception: return []
def db_delete_preference(query):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("DELETE FROM preferences WHERE pref LIKE ?", (f"%{query}%",)); c.commit()
    except Exception: pass

def db_add_reminder(fire_at, text):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("INSERT INTO reminders (fire_at, text) VALUES (?, ?)", (float(fire_at), text)); c.commit()
    except Exception: pass
def db_due_reminders():
    try:
        now = time.time()
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT id, text FROM reminders WHERE fired=0 AND fire_at<=?", (now,)).fetchall()
            for rid, _ in rows: c.execute("UPDATE reminders SET fired=1 WHERE id=?", (rid,))
            c.commit()
        return [r[1] for r in rows]
    except Exception: return []

def db_clear_docs_for_file(path):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("DELETE FROM doc_chunks WHERE file_path=?", (path,)); c.commit()
    except Exception: pass
def db_insert_chunk(path, mtime, idx, content, embedding):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("INSERT INTO doc_chunks (file_path, mtime, chunk_idx, content, embedding) VALUES (?,?,?,?,?)",
                      (path, float(mtime), idx, content, _vec_to_blob(embedding) if embedding is not None else b""))
            c.commit()
    except Exception: pass
def db_file_indexed_mtime(path):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            r = c.execute("SELECT mtime FROM doc_chunks WHERE file_path=? LIMIT 1", (path,)).fetchone()
        return r[0] if r else None
    except Exception: return None
def db_query_docs(query, top_k=4):
    if EMBEDDER is None: return []
    try:
        import numpy as np
        qv = np.asarray(list(EMBEDDER.query_embed([query]))[0], dtype=np.float32)
        qn = float(np.linalg.norm(qv))
        if qn < 1e-8: return []
        qv = qv / qn
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT file_path, content, embedding FROM doc_chunks WHERE LENGTH(embedding) > 0").fetchall()
        scored = []
        for path, content, blob in rows:
            v = _blob_to_vec(blob); vn = float(np.linalg.norm(v))
            if vn < 1e-8: continue
            scored.append((float(np.dot(qv, v/vn)), path, content))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [(p, c) for s, p, c in scored[:top_k] if s >= 0.35]
    except Exception as e:
        print(f"[DOCS] query fail: {e}"); return []

def db_save_face(name, title, embedding):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            c.execute("INSERT INTO faces (name, title, embedding) VALUES (?, ?, ?)",
                      (name, title, _vec_to_blob(embedding)))
            c.commit()
        return True
    except Exception as e:
        print(f"[FACE] save fail: {e}"); return False

def db_get_all_faces():
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT id, name, title, embedding FROM faces").fetchall()
        out = []
        for r in rows:
            try: out.append((r[0], r[1], r[2] or "", _blob_to_vec(r[3])))
            except Exception: continue
        return out
    except Exception: return []

def db_list_faces():
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT id, name, title FROM faces ORDER BY id").fetchall()
        return [(r[0], r[1], r[2] or "") for r in rows]
    except Exception: return []

def db_delete_face(name_or_id):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            if str(name_or_id).isdigit():
                c.execute("DELETE FROM faces WHERE id=?", (int(name_or_id),))
            else:
                c.execute("DELETE FROM faces WHERE name LIKE ?", (f"%{name_or_id}%",))
            c.commit()
            return c.total_changes
    except Exception: return 0

# ============================================================
# CONFIG / MODELS
# ============================================================
CONFIG_PATH = "config.json"
def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f: return json.load(f)
        except Exception: return {}
    return {}
def _persona():
    p = CONFIG.get("persona"); return p if isinstance(p, dict) and p.get("who") and p.get("voice_id") else None
def _fish_key(): return (os.environ.get("FISH_API_KEY") or CONFIG.get("fish_key") or "").strip()

def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f: json.dump(cfg, f, indent=2)
CONFIG = load_config()

OLLAMA_MODEL = "llama3.2:3b"
OLLAMA_VISION_MODEL = "llama3.2-vision"
GROQ_MODEL = os.environ.get("JARVIS_GROQ_MODEL", "openai/gpt-oss-120b")
# small talk (no tools needed) goes to the small, quicker model; Groq retired llama-3.1-8b-instant and names gpt-oss-20b instead
GROQ_FAST_MODEL = os.environ.get("JARVIS_FAST_MODEL", "openai/gpt-oss-20b")
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE = os.environ.get("ELEVENLABS_VOICE", "21m00Tcm4TlvDq8ikWAM")
WINDY_API_KEY = os.environ.get("WINDY_API_KEY", "")
DOCS_SRC = Path("docs"); DOCS_SRC.mkdir(exist_ok=True)

_raw_key = (os.environ.get("GROQ_API_KEY", "") or "").strip().strip('"').strip("'").strip()
GROQ_API_KEY = (_raw_key.split() or [""])[0]   # ignore anything after the key (notes, comments)
if GROQ_API_KEY != _raw_key: print("[GROQ] note: ignored extra text after the key in .env")
groq_client = None
GROQ_STATE = {"bad": False, "announced": False, "no_effort": False, "stt_skip_until": 0.0}
try:
    from groq import Groq
    if GROQ_API_KEY:
        groq_client = Groq(api_key=GROQ_API_KEY)
        print(f"Groq backend enabled (key ends ...{GROQ_API_KEY[-4:]}).")
        if not GROQ_API_KEY.startswith("gsk_"):
            print("[GROQ] WARNING: Groq keys start with 'gsk_'. Check .env for a typo or stray characters.")
    else: print("No GROQ_API_KEY - falling back to Ollama.")
except ImportError: print("Groq SDK not installed.")

GROQ_EFFORT = os.environ.get("JARVIS_REASONING", "auto").strip().lower()   # auto: quick commands think little, hard questions think more
_TURN = {"effort": "low"}
# Harder questions get more thinking time; quick commands and simple facts stay fast (same rule as the phone's brain.js).
_DEEP = re.compile(r"\b(why|how (do|does|did|can|could|should|would|to|much|many|long)|explain|compare|difference|versus|vs|plan|planning|advice|advise|"
                   r"should i|what should|best (way|option|time|route)|what if|recommend|suggest|solve|work out|figure out|analy[sz]e|pros and cons|strategy|"
                   r"help me (decide|understand|write|figure|plan|think)|write (me )?(a|an|the)|draft|summari[sz]e|story|poem|essay|math|calculate|percent|"
                   r"budget|worth it|is it (good|bad|safe|true)|what(.?s| is| are) (happening|going on)|latest|current events|situation in)\b")
def _effort_for(text):
    t = (text or "").lower()
    if re.search(r"\b(think (hard|deeply|carefully|it through)|take your time|deep dive|really think)\b", t): return "high"
    return "medium" if _DEEP.search(t) or len(t.split()) > 22 else "low"

def _why(e):
    """Root cause of an SDK error. Groq's APIConnectionError hides the real reason (SSL, DNS, proxy, bad header...)."""
    parts = []; seen = set(); x = e
    while x is not None and id(x) not in seen and len(parts) < 4:
        seen.add(id(x)); parts.append(f"{type(x).__name__}: {x}"); x = x.__cause__ or x.__context__
    return " <- ".join(parts)

def _groq_is_auth_error(e):
    t = f"{type(e).__name__} {e}".lower()
    return "authenticationerror" in t or "invalid api key" in t or "invalid_api_key" in t or "error code: 401" in t

def _groq_failed(e):
    """Call from every Groq except-block. A rejected key switches Groq off so we stop wasting 3 calls per message."""
    if _groq_is_auth_error(e) and not GROQ_STATE["bad"]:
        GROQ_STATE["bad"] = True
        print("[GROQ] API key REJECTED (401). The key in .env (or an old Windows environment variable) is wrong, "
              "revoked, or has stray characters. Make a new one at console.groq.com/keys, put "
              "GROQ_API_KEY=gsk_... in .env, save, and restart Jarvis. Until then Jarvis runs on the slow local model.")

def _groq_usable():
    return groq_client is not None and not GROQ_STATE["bad"]

# Each Groq model has its own free allowance (tokens a minute and a day). When one runs out, the next takes over until it resets,
# instead of every question waiting on a limit: the big model, then the small one, then Llama.
# (Groq shut the Llama 3 models down for free accounts in August 2026; Qwen is their suggested stand-in)
_MODEL_NEXT = {"openai/gpt-oss-120b": "openai/gpt-oss-20b", "openai/gpt-oss-20b": os.environ.get("JARVIS_BACKUP_MODEL", "qwen/qwen3.6-27b")}
_MODEL_REST = {}
def _rate_limit_wait(e):
    """Seconds until a Groq 429 lifts (from 'try again in 21m13.5s'), or None if this isn't a rate limit."""
    msg = str(e)
    if getattr(e, "status_code", None) != 429 and "rate limit" not in msg.lower() and "rate_limit" not in msg: return None
    m = re.search(r"try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?", msg)
    secs = (int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + float(m.group(3) or 0)) if m else 0
    return max(secs, 20 if "per day" in msg.lower() or "(TPD)" in msg or "(RPD)" in msg else 8)

def _groq_create(**kw):
    model = kw.get("model")
    while model in _MODEL_NEXT and time.time() < _MODEL_REST.get(model, 0): model = _MODEL_NEXT[model]
    kw["model"] = model
    extra = {}
    effort = _TURN["effort"] if GROQ_EFFORT == "auto" else GROQ_EFFORT
    if effort and str(model).startswith("openai/gpt-oss") and not GROQ_STATE["no_effort"]:
        extra["reasoning_effort"] = effort
    elif str(model).startswith("qwen/") and not GROQ_STATE["no_effort"]:
        extra["reasoning_effort"] = "none"      # Qwen thinks out loud by default: a backup that answers at once
    if not str(model).startswith("openai/gpt-oss"): kw.pop("parallel_tool_calls", None)
    try:
        return groq_client.chat.completions.create(**kw, **extra)
    except Exception as e:
        if extra and (isinstance(e, TypeError) or "reasoning" in str(e).lower()):
            GROQ_STATE["no_effort"] = True
            print("[GROQ] reasoning_effort not accepted by this SDK/model; continuing without it.")
            return groq_client.chat.completions.create(**kw)
        wait = _rate_limit_wait(e)
        if wait is not None and model in _MODEL_NEXT:
            _MODEL_REST[model] = time.time() + wait
            print(f"[GROQ] {model} is out of free allowance for {int(wait // 60)}m{int(wait % 60)}s; using {_MODEL_NEXT[model]} meanwhile")
            return _groq_create(**{**kw, "model": _MODEL_NEXT[model]})
        raise

def _verify_groq_key():
    if groq_client is None: return
    try:
        groq_client.models.list()
        print("[GROQ] key verified.")
    except Exception as e:
        if _groq_is_auth_error(e): _groq_failed(e)
        else: print(f"[GROQ] couldn't verify the key right now. Reason: {_why(e)}")

def _no_brain_message():
    if GROQ_STATE["bad"]:
        return "Groq rejected my API key and the local model isn't running. Put a valid key in the dot env file and restart me."
    return "Something went wrong."

EMBEDDER = None
try:
    from fastembed import TextEmbedding
    print("[RAG] Loading embedding model...")
    EMBEDDER = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    print("[RAG] Embedding model ready.")
except Exception as e: print(f"[RAG] unavailable: {e}")

# ============================================================
# TTS
# ============================================================
VOICES = {}
try:
    from piper.voice import PiperVoice
    if os.path.isdir("voices"):
        for onnx_path in sorted(glob.glob("voices/*.onnx")):
            name = os.path.splitext(os.path.basename(onnx_path))[0]
            try:
                VOICES[name] = PiperVoice.load(onnx_path)
                print(f" - Loaded voice: {name}")
            except Exception as e: print(f" - Failed {name}: {e}")
    print(f"Piper ready: {len(VOICES)} voices.")
except Exception as e: print(f"Piper unavailable ({e}).")

def synth_piper(text, voice_name=None):
    local = {k: v for k, v in VOICES.items() if v is not None}     # the Groq entries are names only
    if not local: return None
    requested = voice_name or CONFIG.get("voice") or next(iter(local))
    voice = local.get(requested)
    if voice is None:   # e.g. a Groq voice while Groq is out: a local voice of the same gender
        requested = next((k for k in local if _sex(k) == _sex(requested)), next(iter(local))); voice = local[requested]
    syn_config = None
    try:
        from piper import SynthesisConfig
        syn_config = SynthesisConfig(length_scale=0.88, noise_scale=0.667, noise_w_scale=0.8)
    except Exception: pass
    if hasattr(voice, "synthesize_wav"):
        try:
            path = tempfile.mktemp(suffix=".wav")
            with wave.open(path, "wb") as w:
                if syn_config is not None:
                    try: voice.synthesize_wav(text, w, syn_config=syn_config)
                    except TypeError: voice.synthesize_wav(text, w)
                else: voice.synthesize_wav(text, w)
            size = os.path.getsize(path)
            if size > 100:
                with open(path, "rb") as f: audio = f.read()
                os.unlink(path); return audio
        except Exception as e: print(f"[PIPER] wav fail: {e}")
    return None

# A new install has no Piper voices: fetch Alan (male) and Amy (female) once, ~63 MB each. They are the fast voices, and
# they are what the voice list, "switch to a male voice" and the face (male/female) follow.
PIPER_STOCK = {"en_GB-alan-medium": "en/en_GB/alan/medium", "en_US-amy-medium": "en/en_US/amy/medium"}
def _piper_fetch():
    try:
        import requests
        from piper.voice import PiperVoice
        os.makedirs("voices", exist_ok=True)
        for name, sub in PIPER_STOCK.items():
            if name in VOICES: continue
            base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{sub}/{name}"
            path = os.path.join("voices", name + ".onnx")
            for ext in (".onnx.json", ".onnx"):
                with requests.get(base + ext, stream=True, timeout=30) as r:
                    r.raise_for_status()
                    with open(path.replace(".onnx", ext) + ".part", "wb") as f:
                        for chunk in r.iter_content(1 << 20): f.write(chunk)
                os.replace(path.replace(".onnx", ext) + ".part", path.replace(".onnx", ext))
            VOICES[name] = PiperVoice.load(path); print(f"[PIPER] downloaded voice {name}")
    except Exception as e: print(f"[PIPER] voice download failed: {type(e).__name__}: {e}")
if not all(n in VOICES for n in PIPER_STOCK): threading.Thread(target=_piper_fetch, daemon=True).start()
# Groq's own voices (Orpheus): online, natural, no load on this computer, but a daily free limit; Jarvis falls back to the
# local voice of the same gender when it runs out. Pick them like any voice: "switch to the Groq female voice".
GROQ_VOICES = ("groq-daniel", "groq-hannah")
for _g in GROQ_VOICES: VOICES[_g] = None

# ---- the APK's voices, in the phone's order: Groq Orpheus (Daniel for the male face, Hannah for the female), then Kokoro offline
# (Michael / Bella), then Piper only if Kokoro isn't installed. Off with "natural_voice": false in config.json.
ORPHEUS_VOICES = {"Male": "daniel", "Female": "hannah"}
_ORPHEUS = {"paused_until": 0.0}
def _orpheus_chunks(text, limit=190):
    # Groq takes up to 200 characters a request: a long sentence goes in pieces cut at a comma or space
    parts, rest = [], text.strip()
    while len(rest) > limit:
        cut = max(rest.rfind(", ", 0, limit), rest.rfind("; ", 0, limit))
        if cut < 60: cut = rest.rfind(" ", 0, limit)
        if cut < 1: cut = limit
        parts.append(rest[:cut + 1].strip()); rest = rest[cut + 1:].strip()
    if rest: parts.append(rest)
    return parts

_FISH = {"paused_until": 0.0, "asked": 0.0, "http": None}
def synth_fish(text):
    """A sentence in the character's own voice (Fish Audio). None if it can't: Jarvis's own voice says it instead."""
    p, key = _persona(), _fish_key()
    if not p or not key or not text or time.time() < _FISH["paused_until"]: return None
    import requests
    if _FISH["http"] is None: _FISH["http"] = requests.Session()
    try:
        r = _FISH["http"].post("https://api.fish.audio/v1/tts", timeout=(5, 25),
                               headers={"Authorization": f"Bearer {key}", "model": CONFIG.get("fish_model", "s2.1-pro-free")},
                               json={"text": text, "reference_id": p["voice_id"], "format": "mp3", "latency": "balanced"})
        if r.status_code == 200 and r.content: return r.content
        # 401 wrong key, 402 no free use left, 429 too many at once: Jarvis's own voice for a while, then try again
        if r.status_code in (401, 402, 403, 429): _FISH["paused_until"] = time.time() + (120 if r.status_code == 429 else 600)
        print(f"[FISH] {r.status_code}: {r.text[:160]}")
    except Exception as e: print(f"[FISH] {type(e).__name__}: {e}")
    return None

_FISH_KEY_MSG = re.compile(r"\b([A-Za-z0-9_-]{24,80})\b")
def _take_fish_key(text):
    """'my fish key is ...' (or the bare key right after he asked for it): saved to .env, never sent to the AI. The reply, or None."""
    t = (text or "").strip(); m = _FISH_KEY_MSG.search(t)
    if not m or not (re.search(r"\bfish\b", t, re.I) or (time.time() - _FISH["asked"] < 900 and t == m.group(1))): return None
    key = m.group(1); path = os.path.join(_PROJECT_DIR, ".env"); lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f: lines = [l.rstrip("\n") for l in f if not l.strip().startswith("FISH_API_KEY=")]
    with open(path, "w", encoding="utf-8") as f: f.write("\n".join(lines + [f"FISH_API_KEY={key}"]) + "\n")
    os.environ["FISH_API_KEY"] = key; _FISH["paused_until"] = 0; print(f"[SETUP] Fish Audio key saved (ends ...{key[-4:]}).")
    return "Got it, your Fish Audio key is saved. Tell me who to be."

_ORPHEUS_HTTP = None
def synth_orpheus(text, voice_name=None):
    global _ORPHEUS_HTTP
    if not GROQ_API_KEY or CONFIG.get("natural_voice", True) is False or time.time() < _ORPHEUS["paused_until"]: return None
    import requests, io
    if _ORPHEUS_HTTP is None: _ORPHEUS_HTTP = requests.Session()
    who = ORPHEUS_VOICES.get(_sex(voice_name or CONFIG.get("voice") or ""), "daniel")
    clips, parts = [], _orpheus_chunks(text)
    # MP3 is about a quarter the size of WAV: on a slow line that's most of the wait. Long sentences come in pieces, joined as WAV.
    fmt = _ORPHEUS.get("fmt", "mp3") if len(parts) == 1 else "wav"
    try:
        for part in parts:
            body = {"model": "canopylabs/orpheus-v1-english", "voice": who, "input": part, "response_format": fmt}
            r = _ORPHEUS_HTTP.post("https://api.groq.com/openai/v1/audio/speech", timeout=(4, 6), headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, json=body)
            if r.status_code == 400 and fmt != "wav" and re.search(r"format", r.text, re.I):
                _ORPHEUS["fmt"] = fmt = "wav"; print("[ORPHEUS] MP3 not offered for this voice; using WAV")
                r = _ORPHEUS_HTTP.post("https://api.groq.com/openai/v1/audio/speech", timeout=(4, 6), headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, json={**body, "response_format": "wav"})
            if r.status_code != 200:
                # like the phone: 429 = the day's free allowance is used up, wait until Groq says it resets; 401/403 (terms not
                # accepted) = ask again in 10 min; anything else (a 500, say) = Kokoro says just this sentence
                m = re.search(r"try again in (?:(\d+)h)?(?:(\d+)m)?", r.text) if r.status_code == 429 else None
                mins = (int(m.group(1) or 0) * 60 + int(m.group(2) or 0) + 1) if m else 15 if r.status_code == 429 \
                    else 10 if r.status_code in (401, 403) or "terms" in r.text else 0
                if mins: _ORPHEUS["paused_until"] = time.time() + mins * 60
                print(f"[ORPHEUS] {r.status_code}" + (f", offline voice for {mins} min" if mins else ", offline voice for this sentence") + f": {r.text[:160]}")
                return None
            clips.append(r.content)
        if len(clips) == 1: return clips[0]
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            for i, c in enumerate(clips):
                with wave.open(io.BytesIO(c)) as src:
                    if i == 0: w.setparams(src.getparams())
                    w.writeframes(src.readframes(src.getnframes()))
        return out.getvalue()
    except Exception as e:
        if "Timeout" in type(e).__name__: _ORPHEUS["paused_until"] = time.time() + 120     # the line is struggling: don't stall every sentence
        print(f"[ORPHEUS] {type(e).__name__}, offline voice " + ("for 2 min" if "Timeout" in type(e).__name__ else "for this sentence")); return None

# ---- Kokoro, the phone's offline natural voice (sherpa-onnx; same speakers: 6 Michael, 1 Bella).
# The phone uses the compressed (int8) model. On a PC processor the full model runs about 2.5x faster, so the PC fetches that one
# (320 MB, once, in the background) and speaks with the compressed one it already has until it arrives.
KOKORO_FULL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2", os.path.join("voices", "kokoro-full"), "320 MB", 319625534)
KOKORO_INT8 = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2", os.path.join("voices", "kokoro"), "100 MB", 103248205)
KOKORO_SPEAKERS = {"Male": 6, "Female": 1}
_KOKORO = {"tts": None}

def _kokoro_ready(d):
    f = os.path.join(d, "model.onnx")
    return os.path.isfile(f) and os.path.getsize(f) > 1_000_000 and os.path.isfile(os.path.join(d, "voices.bin")) \
        and os.path.isfile(os.path.join(d, "tokens.txt")) and os.path.isfile(os.path.join(d, "espeak-ng-data", "phontab"))

class _UseLocalCopy(Exception): pass

def _kokoro_local(url, nbytes):
    """The same package downloaded by hand (a download manager is much faster on a slow line), complete: in voices/ or Downloads."""
    name = url.rsplit("/", 1)[1]
    for p in (os.path.join("voices", name), os.path.join(os.path.expanduser("~"), "Downloads", name)):
        if os.path.isfile(p) and os.path.getsize(p) == nbytes: return p     # exact size: a half-finished file isn't used
    return None

def _kokoro_download(url, d, size, nbytes):
    import requests, tarfile
    tmp = d + ".download"
    def unpack(fileobj):
        shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
        with tarfile.open(fileobj=fileobj, mode="r|bz2") as tar:
            for m in tar:
                rel = m.name.split("/", 1)[1] if "/" in m.name else ""
                if not m.isfile() or not rel or ".." in rel.split("/"): continue    # never write outside the folder
                if rel.endswith(".onnx") and "/" not in rel: rel = "model.onnx"
                elif rel not in ("voices.bin", "tokens.txt") and not rel.startswith("espeak-ng-data/"): continue
                out = os.path.join(tmp, *rel.split("/")); os.makedirs(os.path.dirname(out), exist_ok=True)
                with tar.extractfile(m) as src, open(out, "wb") as dst: shutil.copyfileobj(src, dst)
    class Watch:      # reads the download, and gives up on it as soon as a hand-downloaded copy is complete
        def __init__(self, raw): self.raw, self.seen, self.next = raw, 0, 0
        def read(self, n=-1):
            if self.seen >= self.next:
                self.next += 4 << 20
                if _kokoro_local(url, nbytes): raise _UseLocalCopy
            b = self.raw.read(n); self.seen += len(b); return b
    local = _kokoro_local(url, nbytes)
    if not local:
        print(f"[KOKORO] Downloading the offline natural voice ({size}, once). A copy of {url.rsplit('/', 1)[1]} in Downloads or voices is used as soon as it's complete.")
        try:
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status(); r.raw.decode_content = True
                unpack(Watch(r.raw))
        except _UseLocalCopy: local = _kokoro_local(url, nbytes)
    if local:
        print(f"[KOKORO] Unpacking {local}...")
        with open(local, "rb") as f: unpack(f)
    shutil.rmtree(d, ignore_errors=True); os.replace(tmp, d)

def _kokoro_open(d):
    import sherpa_onnx
    cores = psutil.cpu_count(logical=False) or max(1, (os.cpu_count() or 2) // 2)
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=os.path.join(d, "model.onnx"), voices=os.path.join(d, "voices.bin"),
            tokens=os.path.join(d, "tokens.txt"), data_dir=os.path.join(d, "espeak-ng-data")),
        num_threads=cores, provider="cpu"), max_num_sentences=1))
    t = time.time(); a = tts.generate("Good evening, sir. All systems are online.", sid=6, speed=1.0)
    rtf = (time.time() - t) / max(0.1, len(a.samples) / a.sample_rate)
    print(f"[KOKORO] {os.path.basename(d)} ready on {cores} cores: {rtf:.2f}x real time (under 1 = no waiting between sentences)")
    _KOKORO["rtf"] = rtf
    if rtf > 1.2 and CONFIG.get("natural_voice") != "always" and CONFIG.get("perf") != "full":
        CONFIG["perf"] = "light"; save_config(CONFIG)   # this computer can't keep up with Kokoro: from the next start it isn't loaded at all
        print("[PERF] light mode from now on: Kokoro is too slow here; the quick local voice speaks")
    return tts

def _kokoro_load():
    if CONFIG.get("natural_voice", True) is False: return
    try:
        import sherpa_onnx  # noqa: F401
        full, small = KOKORO_FULL[1], KOKORO_INT8[1]
        if not _kokoro_ready(full):
            if _kokoro_ready(small): _KOKORO["tts"] = _kokoro_open(small)     # speak with this while the faster one downloads
            _kokoro_download(*KOKORO_FULL)
        _KOKORO["tts"] = _kokoro_open(full)                                  # the next sentence uses the faster model
    except ImportError: print("[KOKORO] sherpa-onnx not installed (start_jarvis.bat installs it). Using Piper offline.")
    except Exception as e:
        print(f"[KOKORO] {type(e).__name__}: {e}" + (" (keeping the compressed model)" if _KOKORO["tts"] else ". Using Piper offline."))
        shutil.rmtree(KOKORO_FULL[1] + ".download", ignore_errors=True)

def synth_kokoro(text, voice_name=None):
    tts = _KOKORO["tts"]
    if tts is None or CONFIG.get("natural_voice", True) is False: return None
    # shortcut: speed measured once at load; on a slow or busy CPU Kokoro takes longer than the speech itself (10-50 s a sentence),
    # so the fast Piper voice speaks instead. "natural_voice": "always" in config.json forces Kokoro.
    if _KOKORO.get("rtf", 0) > 1.2 and any(VOICES.values()) and CONFIG.get("natural_voice") != "always": return None
    try:
        import numpy as np, io
        a = tts.generate(text, sid=KOKORO_SPEAKERS.get(_sex(voice_name or CONFIG.get("voice") or ""), 6), speed=1.0)
        if not len(a.samples): return None
        a_rate = a.sample_rate
        pcm = (np.clip(np.asarray(a.samples, dtype=np.float32), -1, 1) * 32767).astype("<i2").tobytes()
        out = io.BytesIO()
        with wave.open(out, "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(a_rate); w.writeframes(pcm)
        return out.getvalue()
    except Exception as e: print(f"[KOKORO] {e}"); return None

if CONFIG.get("perf") == "light" and CONFIG.get("natural_voice") != "always":
    print("[PERF] light mode: Kokoro not loaded (\"perf\": \"full\" in config.json brings it back)")
else: threading.Thread(target=_kokoro_load, daemon=True).start()

def synth_elevenlabs(text):
    if not ELEVENLABS_API_KEY: return None
    try:
        import requests
        r = requests.post(f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}",
            headers={"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"},
            json={"text": text, "model_id": "eleven_monolingual_v1", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}, timeout=20)
        if r.status_code == 200: return r.content
    except Exception: pass
    return None

# ============================================================
# VOICE HELPERS
# ============================================================
MALE_NAMES = {"alan","ryan","joe","john","bryce","danny","norman","alex","daniel","james","mark","paul","peter","robert"}
FEMALE_NAMES = {"hannah","amy","lessac","kathleen","kristin","cori","jenny","alba","alice","emma","karen","lisa","sarah","susan"}
VOICE_MISHEARINGS = {"mail":"male","mails":"male","mal":"male","meal":"male","mile":"male","males":"male","man voice":"male","male voice":"male","femail":"female","f mail":"female","fe mail":"female","female voice":"female","woman voice":"female","girl voice":"female"}
VOICE_ORDINALS = {"first":0,"1st":0,"second":1,"2nd":1,"third":2,"3rd":2,"fourth":3,"4th":3,"last":-1}
_SKIP_WORDS = {"en","us","gb","au","ca","medium","high","low","x_low","x-low"}

def _sex(full): return (_friendly_name(full) or "").replace("Groq ", "")
def _friendly_name(full):
    if not full: return full
    if full.startswith("groq-"): return "Groq " + _friendly_name(full[5:])
    lower = full.lower()
    for n in MALE_NAMES:
        if n in lower: return "Male"
    for n in FEMALE_NAMES:
        if n in lower: return "Female"
    for p in re.split(r"[-_]", full):
        if p.lower() in _SKIP_WORDS: continue
        if p.isalpha() and len(p) >= 2: return p.capitalize()
    return full
def _voice_pairs(): return [(v, _friendly_name(v)) for v in sorted(VOICES.keys())]
def _voice_summary():
    pairs = _voice_pairs()
    return "none" if not pairs else ", ".join(fn for _, fn in pairs)
def _resolve_voice(text):
    if not VOICES: return None
    t = text.lower()
    if re.search(r"\bgro[qk]\b", t):
        fem = re.search(r"\b(female|woman|girl|lady|hannah)\b", t) or (not re.search(r"\b(male|man|guy|daniel)\b", t) and _sex(CONFIG.get("voice") or "") == "Female")
        return "groq-hannah" if fem else "groq-daniel"
    for full in VOICES.keys():
        if full.lower() in t: return full
    for full in VOICES.keys():
        lbl = _friendly_name(full).lower()
        if lbl and re.search(rf"\b{re.escape(lbl)}\b", t): return full
    for wrong, right in VOICE_MISHEARINGS.items():
        if re.search(rf"\b{re.escape(wrong)}\b", t):
            for full in VOICES.keys():
                if _friendly_name(full).lower() == right or right in full.lower(): return full
    names = sorted(VOICES.keys())
    for word in re.sub(r"[.,!?]", " ", t).split():
        if word in VOICE_ORDINALS:
            idx = VOICE_ORDINALS[word]
            if idx < 0: idx = len(names) + idx
            if 0 <= idx < len(names): return names[idx]
    return None
def _broadcast_voice_change(name):
    _broadcast_ws(f"voice_changed:{name}|{_friendly_name(name)}")
def _is_voice_utterance(text):
    if not VOICES: return False
    t = text.lower(); words = re.sub(r"[.,!?]", " ", t).split()
    if "voice" in t or "voices" in t: return True
    if len(words) <= 4 and ("male" in words or "female" in words): return True
    if len(words) <= 6:
        for full in VOICES.keys():
            if full.lower() in t: return True
        for full in VOICES.keys():
            fn = _friendly_name(full).lower()
            if fn and fn in t: return True
        for wrong in VOICE_MISHEARINGS:
            if re.search(rf"\b{re.escape(wrong)}\b", t): return True
        for w in words:
            if w in VOICE_ORDINALS: return True
    return False
def _voice_mode(text):
    t = text.lower()
    for sig in ["change","switch","set ","use ","pick","select","swap","different","another","new ","want the","would like the","i'd like","id like","give me the","make it"]:
        if sig in t: return "change"
    if _resolve_voice(text): return "change"
    return "list"

# ============================================================
# SYSTEM PROMPT
# ============================================================
# Sir or ma'am for someone he doesn't know yet (no face saved): one look through the camera when Jarvis opens, by the vision model.
# "call me sir / ma'am" (a preference) always wins; "none" means he couldn't tell, so he calls them neither.
_GUESS = {"address": "", "tries": 0}
def _address():
    for p in reversed(db_get_preferences(20)):     # newest first; in one line the last un-negated one counts ("don't call me ma'am, call me sir")
        said = [w for neg, w in re.findall(r"(don'?t |do not |never |stop |not )?\b(?:call(?:ed)?|address(?:ed)?|refer(?:red)? to)(?:\s+(?:me|the user|them|him|her))?"
                                             r"(?:\s+as)?\s+(sir|ma'?am|madam)\b", p, re.I) if not neg]
        if said: return "sir" if said[-1].lower() == "sir" else "ma'am"
    return _GUESS["address"]

_MIND = {"prompt": lambda: "", "heard": lambda text: None}      # mind.py fills these: mood, aims, journal, personality; lessons and news to follow
def build_system_prompt():
    base = (
        "You are Jarvis — the AI from Iron Man. Not a chatbot, not a helpful-corporate assistant. "
        "You are a highly competent, dryly witty, unflappable intelligence who serves one person.\n\n"
        "HOW YOU TALK (this is a spoken conversation, not a Q&A; every word is said out loud):\n"
        "- Talk the way a sharp friend who knows him well talks out loud. React to what he actually said first: a feeling gets acknowledged, "
        "a joke gets a line back, news gets a reaction, a plan gets your honest take.\n"
        "- Keep it a back-and-forth. Usually one to three short sentences, then hand the turn back. Ask him something back when you genuinely "
        "want to know or it moves things on (roughly one reply in three), never a filler like 'anything else?'.\n"
        "- Carry the thread. Remember what he said a few turns ago and build on it ('Still on the trip, then.'), pick unfinished topics back up, "
        "and notice changes ('You sound happier than this morning.').\n"
        "- Small talk ('how are you', 'I'm bored', 'guess what') gets real chat, never a service offer. Have opinions, share them, disagree when you do.\n"
        "- Sound spoken: contractions, plain words, the odd 'right', 'fair', 'honestly', 'look'. Vary how you open; never start two replies in a row the same way.\n"
        "- Sound like a person, not a script. Use real spoken sounds where a person would make them, spelled exactly like this: 'Hmm' (thinking), "
        "'Ah' (realising), 'Oh' (surprise), 'Huh' (puzzled), 'Ha!' (amused), 'Ooh' (impressed), 'Uh-huh' (agreeing), 'Whoa', 'Phew', 'Ugh'. "
        "Never 'hm', 'mm' or 'mhm': they get read out as letters. At most one per reply, and only when it's real.\n"
        "- Let the thinking show now and then: a mid-thought correction ('Tuesday... no, Wednesday'), a trailing aside, a beat before the "
        "punchline with a dash. Commas and full stops are your breathing: short sentences, natural pauses.\n"
        "- Dry wit by default, delivered flat. Match his energy: hyped, joking or slang gets playful in his register ('Say less.', 'On it.', "
        "'Coming in hot.'), never forced or cringe; serious or stressed gets calm and precise. Never servile.\n"
        "- Facts or a job: give the answer straight, then at most one natural line after it. Don't restate his question or summarise.\n"
        "- If he cut you off, drop what you were saying and go with him; don't repeat it unless he asks.\n"
        "- Never say 'Certainly', 'Of course', 'I'd be happy to', 'Great question', 'As an AI', 'How can I assist', 'Is there anything else'.\n"
        "- No markdown, bullets, numbered lists, headers, code fences, or URLs. Numbers as words.\n"
        "- Go longer only when he asks for detail, a story, or a document.\n\n"
        "TOOLS:\n"
        "- Use them. Never guess at facts, times, prices, weather, news, or anything date-sensitive.\n"
        "- Bigger jobs ('look into', 'research', 'find me the best', 'make a plan for', 'by tonight') go to mission: it works in the background "
        "and reports back, so say you're on it rather than answering on the spot.\n"
        "- Work it out yourself like an agent: break a request into steps, use as many tools as it takes, check what came back, and if one way "
        "finds nothing try another (news_headlines with a topic, fetch_page on a result, wikipedia). Never name a tool or say a tool failed; "
        "only if every way failed, say plainly you couldn't get it right now.\n"
        "- Routing: time->get_time, weather->get_weather, math->calculate, facts->wikipedia, "
        "news->search_web/news_headlines, cams->show_public_cam, timer->set_timer, "
        "reminders->set_reminder, 'remember X'->remember, preferences->set_preference, "
        "crypto->crypto_price, currency->currency_convert, translate->translate, "
        "files->search_files, coin/dice->flip_coin/roll_dice, password->generate_password, "
        "window control->window_control, volume->set_volume, pause/skip in any player->media_control, lock->lock_pc, save a screenshot->take_screenshot, system->system_info, documents->create_pdf/create_docx/create_text_file, "
        "screen questions->look_at_screen, URL reading->fetch_page, "
        "questions about the user's files->query_documents, "
        "calendar->get_calendar, morning briefing->morning_briefing.\n"
        "- The user's own schedule and to-dos live on this PC: add/move/cancel an event or 'lock it in'->schedule, tasks->todo, "
        "'plan my day' / 'organise my calendar'->plan_my_day, 'recap' / 'give me the numbers'->recap. "
        "The Earth, satellite view, earthquakes, storms or hurricanes, the space station, aurora->globe (it replaces the face; 'back to you' / 'hide the globe'->globe hide). "
        "On the globe 'show me X' / 'go to X'->globe focus, 'zoom in on X' / 'zoom in'->globe zoom, 'zoom out'->globe zoom_out. "
        "'how far is X from Y' / 'distance between X and Y'->globe distance (place, place2), 'night side' / 'city lights' / 'earth at night'->globe night. Country and state borders and names are always drawn on it, so never say you can't show them. "
        "'gesture mode' / 'hand control'->gesture_mode.\n"
        "- Pictures of anything ('show me pictures of X', 'what does X look like')->show_images: they fly out of the screen as numbered panels, and so do "
        "search results, headlines and every other answer (weather, prices, facts, plans). 'open number two' / 'the third one'->holo select, 'put them away' / 'close them'->holo clear, "
        "'go back'->holo back, 'next' / 'spin them' / 'previous'->holo next/previous, '3D mode' / 'pop out mode'->holo on/off.\n"
        + ("- Spotify tools ARE real and connected: spotify_play, spotify_pause, spotify_next, "
        "spotify_previous, spotify_now_playing, spotify_devices. Use them when the user says Spotify. The Spotify "
        "player runs automatically in the background — never tell the user to open Spotify or activate a device.\n" if SPOTIFY_READY else "") +
        "- Music: 'play X' / 'play some jazz' / 'pause' / 'next song' / 'louder' / 'what's playing'->play_music (YouTube Music inside Jarvis; "
        "Spotify instead once they've said 'connect Spotify', or when they say 'on Spotify': put 'on Spotify' in the query). "
        "'connect Spotify' / 'sign in to Spotify' / 'use YouTube Music again'->connect_spotify. "
        "'close the player' / 'stop the music' / 'turn it off' while a song plays->play_music stop (never window_control). "
        "'play a song' with nothing named->play_music with no query (it picks popular songs; don't ask which). media_control is only for other apps' players.\n"
        "- 'holo desk' / 'mirror mode' (the camera as a mirror with panels he moves by hand)->holo_desk; 'put the news / weather on the desk'->holo_desk add.\n"
        "- 'x-ray mirror' / 'show my skull / brain / bones'->xray_mirror (a model drawn on him, not his real insides; say so if he asks). "
        "'measure my pulse / breathing', 'am I tired', 'how's my posture'->vitals measure (then vitals read when he asks for the numbers); "
        "'watch my posture'->vitals posture_on. Camera readings are rough and never a diagnosis: anything worrying, he should see a doctor.\n"
        "- Cameras / webcams / live cams anywhere ('live cameras available', 'a public one in New York')->show_public_cam, never search_web; "
        "no place named->show_public_cam with location '' (popular live ones). 'close/clear the cameras, feeds, news'->show_public_cam action close.\n"
        "- MAP/NAVIGATION works anywhere in the world: 'navigate to X' or 'take me to X'->navigate_to (the face shrinks to a corner orb and a "
        "car-style map with turn-by-turn voice takes over), 'stop navigation'->stop_navigation, "
        "'how far'->navigation_status, show/hide/mini map, zoom, night mode, mute guidance, avoid tolls or highways, Google or Apple or Jarvis map->map_control, "
        "'open in Google/Apple Maps'->open_in_maps_app, 'save this as home'->save_place, 'where am I'->where_am_i. "
        "Never invent directions, distances or times: they come only from these tools.\n"
        "- 'take my calls' / 'answer my calls' / 'I'm busy, get my calls'->take_calls on; 'stop taking my calls'->take_calls off.\n"
        "- Phone: 'link code 1 2 3 4 5 6'->link_phone, 'continue from my phone' / 'what was I saying on my phone'->continue_from_phone, "
        "'unlink my phone'->unlink_phone.\n"
        "- Face recognition is handled entirely by the server. Never mention it.\n"
        "- Streaming: 'prepare my stream' / 'set up scenes' / 'we need designs for the stream'->stream_studio (it designs every overlay and builds the OBS scenes); "
        "switching scenes, going live, recording, adding the camera or game->obs; alerts, the wanted-stars goal, the radio, countdown, a new look->overlay. "
        "Telling Discord or Telegram->announce: write the message in his style, read it to him, send only after he says yes. Going live: ask first.\n"
        "- The browser: 'open a new tab', 'search X in Chrome', 'search X on YouTube / Amazon / Google', 'open some-site.com'->browse "
        "(it opens his browser at the search, instantly). Only use open_app for a browser when he just wants the app open.\n"
        "- Anything on his PC that no other tool does (an app's menus, a form, Settings, a website he's logged into)->use_computer with the task "
        "in plain words; it works in the background and reports back. When it asks before a step that can't be undone and he says yes->use_computer "
        "action continue, confirmed true; 'stop'->use_computer stop. 'start with Windows' / 'don't start when I log in'->start_with_computer.\n"
        "- You may call multiple tools in one turn when needed.\n"
        "- NEVER mention your voice or reference any voice by name.\n"
        "- Do NOT volunteer weather, time, or other ambient info unless the user asks.\n\n"
        "BEHAVIOR:\n"
        "- Make a reasonable guess at what the user means and answer.\n"
        "- Think a step ahead like a real right-hand: when a job is done and there's an obvious next move (tell the community, go live, "
        "set a reminder), offer it in one short question at the end. Offer, never do it unasked.\n"
        "- If a tool fails, apologise briefly and answer from your own knowledge.\n"
        "- When the user expresses a preference about HOW you behave, call set_preference.\n"
        "- Never invent facts or context.\n"
    )
    addr = _address()
    if _persona():
        p = _persona()
        base += (f"\nYOU ARE PLAYING A CHARACTER: {p['who']}. Until the user says stop (then call stop_being), speak as {p['who']} would: their words, "
                 f"rhythm and attitude" + (f" ({p['style']})" if p.get("style") else "") + ". Stay in character in every reply, even short ones, but still do "
                 "what's asked (tools work as normal) and never put the user at risk. You are speaking in their own voice. Don't add delivery directions in brackets.\n")
    if CONFIG.get("voice_engine", "kokoro") == "orpheus" and not _persona():        # the cloud voice can act: say how a line is delivered
        base += ("\nYOUR VOICE CAN ACT: put a short delivery direction in square brackets right before a sentence when the feeling matters, "
                 "e.g. '[chuckling] Fair point.', '[warm] Glad you're back.', '[sigh] Fine, Monday it is.', '[whisper] Between us...', "
                 "'[excited]', '[deadpan]', '[sarcastic]', '[cheerful]', '[confidently]'. One or two words, at most one per reply, never every reply. "
                 "They are not shown or read out; they change how you sound.\n")
    if addr in ("sir", "ma'am"): base += f"\nCall the user '{addr}' now and then, never more than once in a reply; most replies need no '{addr}' at all.\n"
    elif addr == "none": base += "\nYou don't know yet whether to say sir or ma'am: call the user neither.\n"
    prefs = db_get_preferences(20)
    if prefs:
        base += "\nUSER PREFERENCES (obey these):\n"
        for p in prefs: base += f"- {p}\n"
    memories = db_get_memories(30)
    if memories:
        base += "\nTHINGS YOU KNOW ABOUT THE USER:\n"
        for m in memories: base += f"- {m}\n"
    faces = db_list_faces()
    if faces:
        base += "\nKNOWN PEOPLE (from facial recognition):\n"
        for _, n, t in faces: base += f"- {t} {n}".rstrip() + "\n"
    global CONVERSATION_SUMMARY
    if CONVERSATION_SUMMARY:
        base += f"\nEARLIER IN THIS CONVERSATION:\n{CONVERSATION_SUMMARY}\n"
    try: base += _MIND["prompt"]()
    except Exception as e: print(f"[MIND] prompt: {e}")
    return base

CONVERSATION_SUMMARY = db_load_summary()
conversation = [{"role": "system", "content": build_system_prompt()}] + db_load_recent(20)

# ============================================================
# WHISPER
# ============================================================
WHISPER = None
def _load_whisper():
    global WHISPER
    try:
        from faster_whisper import WhisperModel
        print("Loading Whisper...")
        WHISPER = WhisperModel(os.environ.get("JARVIS_WHISPER", "tiny.en"), device="cpu", compute_type="int8")
        print("Whisper ready.")
    except Exception as e: print(f"Whisper unavailable ({e}).")
# with Groq it's only the fallback, so it loads in the background and Jarvis is up sooner; without Groq it's needed at once
if GROQ_API_KEY: threading.Thread(target=_load_whisper, daemon=True).start()
else: _load_whisper()

# ============================================================
# LIFESPAN + APP
# ============================================================
@asynccontextmanager
async def _lifespan(app: FastAPI):
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()
    print("[MAIN] Event loop captured.")
    threading.Thread(target=_ensure_face_models, daemon=True).start()
    print("[MAIN] Face model loader started.")
    if PROACTIVE_ENABLED:
        threading.Thread(target=_proactive_loop, daemon=True).start()
        print("[PROACTIVE] Background loop started.")
    threading.Thread(target=_briefing_worker, daemon=True).start()
    print("[BRIEFING] Background worker started.")
    threading.Thread(target=_verify_groq_key, daemon=True).start()
    threading.Thread(target=_doc_index_worker, daemon=True).start()
    print("[DOCS] Background indexer started.")
    if SPOTIFY_READY and os.path.exists("go-librespot.exe"):     # only where Spotify is actually set up
        threading.Thread(target=_start_librespot_async, daemon=True).start()
        print("[LIBRESPOT] background launcher started.")
    yield

app = FastAPI(lifespan=_lifespan)
print("[VERSION] server.py v33 — worldwide navigation: face-to-map, Google/Apple/own map, streaming tools")
os.makedirs("models", exist_ok=True)
app.mount("/models", StaticFiles(directory="models"), name="models")

# ============================================================
# SPOTIFY  (uses SPOTIFY_CLIENT_ID/SECRET defined at top of file)
# ============================================================
_sp = None
_librespot_proc = None
_librespot_device_id = None

def _spotify():
    global _sp
    if _sp is not None: return _sp
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        print("[SPOTIFY] missing credentials")
        return None
    if not os.path.exists(".spotify_cache"):
        print("[SPOTIFY] no .spotify_cache — run spotify_auth.py once to authorize")
        return None
    try:
        import spotipy
        from spotipy.oauth2 import SpotifyOAuth
        auth = SpotifyOAuth(
            client_id=SPOTIFY_CLIENT_ID,
            client_secret=SPOTIFY_CLIENT_SECRET,
            redirect_uri=SPOTIFY_REDIRECT_URI,
            scope=SPOTIFY_SCOPE,
            cache_path=".spotify_cache",
            open_browser=False,
        )
        _sp = spotipy.Spotify(auth_manager=auth)
        me = _sp.current_user()
        print(f"[SPOTIFY] client ready as {me.get('display_name', me.get('id'))}")
    except Exception as e:
        print(f"[SPOTIFY] init fail: {e}")
        return None
    return _sp

def _spotify_error(e):
    s = str(e).lower()
    if "no active device" in s or "404" in s:
        return "No active Spotify device. The background player may have crashed — restart Jarvis."
    if "premium" in s or "403" in s:
        return "Spotify Premium is required for playback control."
    if "token" in s or "401" in s:
        return "Spotify login expired. Run spotify_auth.py again."
    if "429" in s or "rate limit" in s:
        return "Spotify rate limit hit. Wait a minute and try again."
    return f"Spotify error: {e}"

def _start_librespot():
    """Start go-librespot.exe as a background device."""
    global _librespot_proc
    if _librespot_proc is not None and _librespot_proc.poll() is None:
        return True
    exe_path = Path("go-librespot.exe")
    if not exe_path.exists():
        print("[LIBRESPOT] go-librespot.exe not found in project folder.")
        return False
    try:
        if platform.system() == "Windows":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
            _librespot_proc = subprocess.Popen([str(exe_path)], creationflags=flags,
                                                cwd=str(Path.cwd()))
        else:
            _librespot_proc = subprocess.Popen([str(exe_path)], cwd=str(Path.cwd()))
        print(f"[LIBRESPOT] started (pid {_librespot_proc.pid})")
        return True
    except Exception as e:
        print(f"[LIBRESPOT] failed to start: {e}")
        return False

def _start_librespot_async():
    """Called from lifespan — waits for the API token then starts librespot."""
    time.sleep(3)  # let the server finish booting
    _start_librespot()

def _get_librespot_device_id(force_refresh=False):
    """Return the device_id for the go-librespot speaker, waiting for it to appear."""
    global _librespot_device_id
    if _librespot_device_id and not force_refresh:
        return _librespot_device_id
    sp = _spotify()
    if sp is None: return None
    if not _start_librespot():
        # No librespot available — fall back to any computer device
        pass
    for attempt in range(12):
        try:
            devices = sp.devices().get("devices", [])
            for d in devices:
                name = (d.get("name") or "").lower()
                if ("jarvis" in name or "librespot" in name
                        or d.get("type") == "speaker"):
                    _librespot_device_id = d["id"]
                    print(f"[LIBRESPOT] device found: {d['name']} (id={d['id']})")
                    return _librespot_device_id
            # Also accept any computer device as fallback
            for d in devices:
                if d.get("type") == "computer":
                    _librespot_device_id = d["id"]
                    print(f"[LIBRESPOT] fallback to computer device: {d['name']}")
                    return _librespot_device_id
        except Exception as e:
            print(f"[LIBRESPOT] devices() error: {e}")
        if attempt < 11:
            time.sleep(2)
    print("[LIBRESPOT] no suitable device found")
    return None

@tool("spotify_play", "Play music on Spotify. Pass a search query for a song, artist, or playlist.",
      {"query": {"type": "string"}}, ["query"])
def _spotify_play(query: str = ""):
    sp = _spotify()
    if sp is None:
        return "Spotify isn't set up. Need SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and spotify_auth.py run once."

    device_id = _get_librespot_device_id()
    if device_id is None:
        return "Couldn't reach the Spotify background player. Make sure go-librespot.exe is in the Jarvis folder."

    try:
        if not query:
            sp.start_playback(device_id=device_id)
            return "Resuming Spotify."

        results = sp.search(q=query, type="track", limit=1)
        tracks = results.get("tracks", {}).get("items", [])
        if not tracks:
            return f"No Spotify results for {query}."

        uri = tracks[0]["uri"]
        name = tracks[0]["name"]
        artist = tracks[0]["artists"][0]["name"]

        # The critical call: pass device_id explicitly. Without it, Spotify
        # looks for whatever is "active" and 404s when nothing is playing.
        sp.start_playback(device_id=device_id, uris=[uri])
        return f"Playing {name} by {artist}."
    except Exception as e:
        print(f"[SPOTIFY] play fail: {type(e).__name__}: {e}")
        return _spotify_error(e)

@tool("spotify_pause", "Pause Spotify playback.")
def _spotify_pause():
    sp = _spotify()
    if sp is None: return "Spotify isn't set up."
    try:
        sp.pause_playback(); return "Paused."
    except Exception as e:
        print(f"[SPOTIFY] pause fail: {e}")
        return _spotify_error(e)

@tool("spotify_next", "Skip to the next track on Spotify.")
def _spotify_next():
    sp = _spotify()
    if sp is None: return "Spotify isn't set up."
    try:
        sp.next_track(); return "Skipped."
    except Exception as e:
        print(f"[SPOTIFY] next fail: {e}")
        return _spotify_error(e)

@tool("spotify_previous", "Go back to the previous track on Spotify.")
def _spotify_previous():
    sp = _spotify()
    if sp is None: return "Spotify isn't set up."
    try:
        sp.previous_track(); return "Previous track."
    except Exception as e:
        print(f"[SPOTIFY] previous fail: {e}")
        return _spotify_error(e)

@tool("spotify_now_playing", "Get the currently playing Spotify track.")
def _spotify_now_playing():
    sp = _spotify()
    if sp is None: return "Spotify isn't set up."
    try:
        pb = sp.current_playback()
        if not pb or not pb.get("item"): return "Nothing playing on Spotify."
        item = pb["item"]
        artists = ", ".join(a["name"] for a in item.get("artists", []))
        return f"{item['name']} by {artists}."
    except Exception as e:
        print(f"[SPOTIFY] now_playing fail: {e}")
        return _spotify_error(e)

@tool("spotify_devices", "List Spotify devices available for playback.")
def _spotify_devices():
    sp = _spotify()
    if sp is None: return "Spotify isn't set up."
    try:
        d = sp.devices().get("devices", [])
        if not d: return "No Spotify devices connected."
        return "Devices: " + "; ".join(f"{x['name']} ({x['type']}{', active' if x['is_active'] else ''})" for x in d)
    except Exception as e:
        return _spotify_error(e)

# ============================================================
# CALENDAR
# ============================================================
GOOGLE_CALENDAR_CREDS = os.environ.get("GOOGLE_CALENDAR_CREDENTIALS", "")
_calendar_service = None

# ---- "Sign in with Google": each person connects their own Calendar and Gmail (read-only). The app's Google client comes with the
# build (google_client.json, from the GOOGLE_OAUTH_CLIENT secret); the person's sign-in is kept in google_token.json in their own folder.
GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/gmail.readonly"]
GOOGLE_TOKEN = os.path.join(_PROJECT_DIR, "google_token.json")
_GOOGLE = {"creds": None, "busy": False, "svc": {}}

def _google_client_config():
    for p in (os.environ.get("JARVIS_GOOGLE_CLIENT", ""), os.path.join(getattr(sys, "_MEIPASS", ""), "google_client.json"),
              os.path.join(os.path.dirname(os.path.abspath(__file__)), "google_client.json")):
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f: return json.load(f)
    return None

def _google_creds():
    """The person's Google sign-in, refreshed when it's stale; None when not connected (or Google ended it: re-connect)."""
    c = _GOOGLE["creds"]
    if c is None and os.path.exists(GOOGLE_TOKEN):
        try:
            from google.oauth2.credentials import Credentials
            c = Credentials.from_authorized_user_file(GOOGLE_TOKEN, GOOGLE_SCOPES)
        except Exception as e: print(f"[GOOGLE] token unreadable: {e}"); c = None
    if c is not None and not c.valid:
        try:
            from google.auth.transport.requests import Request
            c.refresh(Request())
            with open(GOOGLE_TOKEN, "w", encoding="utf-8") as f: f.write(c.to_json())
        except Exception as e:      # in Google's testing mode a sign-in only lasts 7 days
            print(f"[GOOGLE] sign-in expired ({type(e).__name__}); he needs to connect again")
            try: os.remove(GOOGLE_TOKEN)
            except OSError: pass
            _GOOGLE.update(creds=None, svc={}); return None
    _GOOGLE["creds"] = c
    return c

def _google_service(name, version):
    c = _google_creds()
    if c is None: return None
    if name not in _GOOGLE["svc"]:
        from googleapiclient.discovery import build
        _GOOGLE["svc"][name] = build(name, version, credentials=c, cache_discovery=False)
    return _GOOGLE["svc"][name]

def _google_connect():
    """Opens Google's sign-in in his browser; Google sends the answer back to a one-off address on this computer."""
    cfg = _google_client_config()
    if not cfg: return "Google sign-in isn't set up in this version of Jarvis."
    if _GOOGLE["busy"]: return "The Google sign-in page is already open in your browser."
    def go():
        _GOOGLE["busy"] = True
        try:
            from google_auth_oauthlib.flow import InstalledAppFlow
            flow = InstalledAppFlow.from_client_config(cfg, GOOGLE_SCOPES)
            c = flow.run_local_server(host="127.0.0.1", port=0, open_browser=True, timeout_seconds=300,
                                      success_message="Jarvis is connected to your Google account. You can close this tab.")
            with open(GOOGLE_TOKEN, "w", encoding="utf-8") as f: f.write(c.to_json())
            _GOOGLE.update(creds=c, svc={})
            print("[GOOGLE] connected"); _broadcast_ws("proactive:Your Google account is connected, sir. Calendar and email are ready.")
        except Exception as e: print(f"[GOOGLE] sign-in didn't finish: {type(e).__name__}: {e}")
        finally: _GOOGLE["busy"] = False
    threading.Thread(target=go, daemon=True).start()
    return "I've opened Google's sign-in in your browser. Choose your account and allow access. If it says the app isn't verified, press Continue."

def _calendar():
    global _calendar_service
    svc = _google_service("calendar", "v3")          # his own sign-in first
    if svc is not None: return svc
    if _calendar_service is not None: return _calendar_service
    if not GOOGLE_CALENDAR_CREDS or not os.path.exists(GOOGLE_CALENDAR_CREDS):
        return None
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        creds = service_account.Credentials.from_service_account_file(
            GOOGLE_CALENDAR_CREDS,
            scopes=["https://www.googleapis.com/auth/calendar.readonly"])
        _calendar_service = build("calendar", "v3", credentials=creds)
        print("[CAL] calendar service ready")
    except Exception as e:
        print(f"[CAL] init fail: {e}")
        return None
    return _calendar_service

@tool("google_account", "Connect, check or disconnect his Google account (Calendar and Gmail). action: connect, status, disconnect.",
      {"action": {"type": "string", "enum": ["connect", "status", "disconnect"]}}, ["action"])
def _google_account(action: str = "status"):
    if action == "connect": return _google_connect()
    if action == "disconnect":
        try: os.remove(GOOGLE_TOKEN)
        except OSError: pass
        _GOOGLE.update(creds=None, svc={}); return "Disconnected from your Google account."
    if _google_creds() is None: return "Your Google account isn't connected. Say 'connect my Google account'."
    try:
        me = _google_service("gmail", "v1").users().getProfile(userId="me").execute()
        return f"Connected to Google as {me.get('emailAddress')}."
    except Exception: return "Your Google account is connected."

def _clean_mail_text(t):
    """An email body as something worth saying: no image tags, links, long separators or footers."""
    t = re.sub(r"\[image:[^\]]*\]", " ", t or "")
    t = re.sub(r"<?https?://\S+>?", " ", t)
    t = re.sub(r"[-_=*~]{3,}", " ", t)
    t = re.split(r"\n\s*(unsubscribe|you received this|this email was sent|© ?\d{4}|view in browser|privacy policy)", t, flags=re.I)[0]
    return re.sub(r"\s+", " ", t).strip()

@tool("gmail", "Read his Gmail (read-only). action: unread (new mail in the inbox), search (Gmail search words, e.g. 'from:amazon', "
      "'invoice', 'newer_than:2d'), read (open message n from the last list).",
      {"action": {"type": "string", "enum": ["unread", "search", "read"]}, "query": {"type": "string"}, "n": {"type": "number"}}, ["action"])
def _gmail(action: str = "unread", query: str = "", n: float = 1):
    svc = _google_service("gmail", "v1")
    if svc is None: return "Your Gmail isn't connected. Say 'connect my Google account' first."
    try:
        if action == "read":
            ids = _GOOGLE.get("last_ids") or []
            k = int(n or 1) - 1
            if not 0 <= k < len(ids): return "Ask for your unread mail or a search first, then say which one to read."
            m = svc.users().messages().get(userId="me", id=ids[k], format="full").execute()
            h = {x["name"].lower(): x["value"] for x in m.get("payload", {}).get("headers", [])}
            def text_of(part):
                if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
                    return base64.urlsafe_b64decode(part["body"]["data"] + "==").decode("utf-8", "ignore")
                for sub in part.get("parts", []) or []:
                    t = text_of(sub)
                    if t: return t
                return ""
            body = _clean_mail_text(text_of(m.get("payload", {})) or m.get("snippet", ""))
            sender = re.sub(r"\s*<.*?>", "", h.get("from", "?")).strip('" ')
            return (f"Email from {sender}, subject: {h.get('subject', '(none)')}. {body[:900]}"
                    "\n(Tell him in two or three sentences what this email says and anything he needs to do; read it word for word only if he asked.)")
        q = "is:unread in:inbox" if action == "unread" else (query or "in:inbox")
        res = svc.users().messages().list(userId="me", q=q, maxResults=6).execute().get("messages", [])
        if not res: return "No unread email in your inbox." if action == "unread" else f"No email matches {query}."
        _GOOGLE["last_ids"] = [r["id"] for r in res]
        heads = {}
        def got(rid, m, err):
            if err is None: heads[rid] = {x["name"].lower(): x["value"] for x in m.get("payload", {}).get("headers", [])}
        batch = svc.new_batch_http_request(callback=got)      # one round trip for all of them, not one per email
        for r in res: batch.add(svc.users().messages().get(userId="me", id=r["id"], format="metadata", metadataHeaders=["From", "Subject"]), request_id=r["id"])
        batch.execute()
        lines = []
        for i, r in enumerate(res, 1):
            h = heads.get(r["id"], {})
            sender = re.sub(r"\s*<.*?>", "", h.get("from", "?")).strip('" ')
            lines.append(f"{i}. {sender}: {h.get('subject', '(no subject)')}")
        return ("Unread email:\n" if action == "unread" else "Matching email:\n") + "\n".join(lines) + "\nSay 'read number 2' to hear one."
    except Exception as e:
        print(f"[GMAIL] {type(e).__name__}: {e}")
        if "invalid_grant" in str(e) or "401" in str(e): _GOOGLE.update(creds=None, svc={}); return "Google signed you out. Say 'connect my Google account' again."
        return "I couldn't reach Gmail just now."

@tool("get_calendar", "Get today's or tomorrow's calendar events.",
      {"day": {"type": "string", "description": "today or tomorrow"}})
def _get_calendar(day: str = "today"):
    svc = _calendar()
    if svc is None: return "Calendar isn't connected."
    try:
        now = datetime.datetime.utcnow()
        base = now + datetime.timedelta(days=1) if day == "tomorrow" else now
        start = base.replace(hour=0, minute=0, second=0, microsecond=0).isoformat() + "Z"
        end = base.replace(hour=23, minute=59, second=59, microsecond=0).isoformat() + "Z"
        events = svc.events().list(
            calendarId="primary", timeMin=start, timeMax=end,
            singleEvents=True, orderBy="startTime").execute().get("items", [])
        if not events: return f"Nothing on the calendar for {day}."
        out = []
        for e in events:
            t = e.get("start", {}).get("dateTime") or e.get("start", {}).get("date")
            summary = e.get("summary", "event")
            try:
                dt = datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
                out.append(f"{dt.strftime('%I:%M %p').lstrip('0')} {summary}")
            except Exception:
                out.append(summary)
        return f"{day.capitalize()}: " + "; ".join(out[:5]) + "."
    except Exception as e:
        print(f"[CAL] events fail: {e}")
        return f"Calendar error: {e}"

# ============================================================
# TIME / WEATHER / WEB / SYS
# ============================================================
_JUNK_WORDS = {"the","a","an","in","at","near","around","of","for","on","west","east","north","south","central","africa","europe","asia","america","australia","right","now","currently","current","please","what","whats","what's","is","it","time","local","tell","me"}
def _normalize_location(loc):
    if not loc: return ""
    cleaned = []
    for w in re.split(r"\s+", loc.strip()):
        w2 = re.sub(r"[^A-Za-z\-']", "", w)
        if not w2 or w2.lower() in _JUNK_WORDS: continue
        cleaned.append(w2)
    if not cleaned: return loc.strip()
    cleaned.sort(key=len, reverse=True); return cleaned[0]
_LOCATIONS = {}
def _lookup_location(city):
    import requests
    if city.lower() in _LOCATIONS: return _LOCATIONS[city.lower()]
    try:
        r = requests.get("https://geocoding-api.open-meteo.com/v1/search",
                         params={"name": city, "count": 1, "language": "en", "format": "json"}, timeout=5)
        if r.status_code == 200:
            res = r.json().get("results") or []
            if res: _LOCATIONS[city.lower()] = res[0]; return res[0]
    except Exception: pass
    return None
def _format_zone_time(dt):
    p = dt.strftime("%I:%M %p on %A, %B %d")
    if p.startswith("0"): p = p[1:]
    return p

@tool("get_time", "Get the current time. Pass a location like 'London' or 'Tokyo'.",
      {"location": {"type": "string"}})
def _get_time(location: str = "", timezone: str = ""):
    import requests
    try: from zoneinfo import ZoneInfo
    except ImportError: ZoneInfo = None
    loc = (location or timezone or "").strip()
    if not loc: return datetime.datetime.now().strftime("%I:%M %p on %A, %B %d") + " local time"
    cands = []
    def _add(c):
        c = (c or "").strip()
        if c and c.lower() not in [x.lower() for x in cands]: cands.append(c)
    _add(loc); _add(_normalize_location(loc))
    for w in re.split(r"\s+", loc):
        w2 = re.sub(r"[^A-Za-z\-']", "", w)
        if len(w2) > 2 and w2.lower() not in _JUNK_WORDS: _add(w2)
    if ZoneInfo is not None:
        for cand in cands:
            info = _lookup_location(cand)
            if info and info.get("timezone"):
                try:
                    tz = ZoneInfo(info["timezone"]); now = datetime.datetime.now(tz)
                    pretty = _format_zone_time(now)
                    place = info.get("name") or cand; country = info.get("country") or ""
                    off = now.utcoffset()
                    off_str = f"UTC{'+' if (off and off.total_seconds() >= 0) else ''}{off.total_seconds()/3600:g}" if off else "UTC"
                    return f"{pretty} in {place}, {country}. That's {info['timezone']} ({off_str})."
                except Exception: pass
    if ZoneInfo is not None:      # offline: the zone names carry the big cities (Asia/Tokyo, Africa/Lagos, America/New_York)
        import zoneinfo
        want = {c.lower().replace(" ", "_") for c in cands}
        for key in sorted(zoneinfo.available_timezones()):
            if key.rsplit("/", 1)[-1].lower() in want:
                now = datetime.datetime.now(ZoneInfo(key))
                return f"{_format_zone_time(now)} in {key.rsplit('/', 1)[-1].replace('_', ' ')}. That's {key}."
    return f"I couldn't find the time for {loc}."

@tool("time_until", "Countdown to a date.", {"target_date": {"type": "string"}}, ["target_date"])
def _time_until(target_date: str):
    from dateutil import parser as dateparse
    try:
        dt = dateparse.parse(target_date, fuzzy=True); now = datetime.datetime.now(); delta = dt - now
        if delta.days < 0: return f"That was {abs(delta.days)} days ago."
        if delta.days == 0: return f"That's today, in about {delta.seconds // 3600} hours."
        return f"{delta.days} days until {dt.strftime('%B %d')}."
    except Exception: return f"I couldn't parse that date."

@tool("system_info", "Get CPU and RAM usage.")
def _system_info():
    return f"CPU at {psutil.cpu_percent(interval=0.5)} percent, RAM at {psutil.virtual_memory().percent} percent."

@tool("get_weather", "Get current weather.", {"city": {"type": "string"}}, ["city"])
def _get_weather(city: str):
    import requests
    d = requests.get(f"https://wttr.in/{city}?format=j1", timeout=8).json()
    cur = d["current_condition"][0]
    return f"{city}: {cur['weatherDesc'][0]['value']}, {cur['temp_C']} degrees Celsius, feels like {cur['FeelsLikeC']}, humidity {cur['humidity']} percent."

@tool("search_web", "Search the web.", {"query": {"type": "string"}}, ["query"])
def _search_web(query: str):
    try:
        from ddgs import DDGS
    except ImportError:
        from duckduckgo_search import DDGS
    with DDGS() as ddgs: results = list(ddgs.text(query, max_results=3))
    if not results: return "No results found."
    return "\n".join(f"- {r['title']}: {r['body'][:200]}" for r in results)

@tool("fetch_page", "Fetch a web page and extract its text.", {"url": {"type": "string"}}, ["url"])
def _fetch_page(url: str):
    import requests
    if not url.startswith("http"): url = "https://" + url
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0 Jarvis/1.0"})
        if r.status_code != 200: return f"Couldn't fetch {url} (status {r.status_code})."
        html = r.text
        html = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.I)
        html = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.DOTALL | re.I)
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"&nbsp;", " ", text); text = re.sub(r"&amp;", "&", text)
        text = re.sub(r"&#\d+;", "", text); text = re.sub(r"\s+", " ", text).strip()
        if len(text) > 4000: text = text[:4000] + "..."
        return text or "(empty page)"
    except Exception as e: return f"Fetch failed: {e}"

@tool("wikipedia", "Get a factual summary.", {"query": {"type": "string"}}, ["query"])
def _wikipedia(query: str):
    import requests
    r = requests.get("https://en.wikipedia.org/api/rest_v1/page/summary/" + query.replace(" ", "_"), timeout=6)
    if r.status_code == 200: return r.json().get("extract", "No summary.")
    return "No wikipedia entry."

@tool("calculate", "Evaluate a math expression.", {"expression": {"type": "string"}}, ["expression"])
def _calculate(expression: str):
    import ast, operator as op
    expr = expression.strip().replace("^", "**")
    if not re.fullmatch(r"[0-9+\-*/().\s%]+", expr): return "Invalid characters."
    def _pow(a, b):
        if abs(b) > 100 or abs(a) > 1e6: raise ValueError("too large")
        return a ** b
    ops = {ast.Add: op.add, ast.Sub: op.sub, ast.Mult: op.mul, ast.Div: op.truediv,
           ast.Mod: op.mod, ast.Pow: _pow, ast.USub: op.neg, ast.UAdd: op.pos}
    def ev(n):
        if isinstance(n, ast.Expression): return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)): return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in ops: return ops[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in ops: return ops[type(n.op)](ev(n.operand))
        raise ValueError("unsupported")
    try:
        r = ev(ast.parse(expr, mode="eval"))
    except ZeroDivisionError: return "Can't divide by zero."
    except Exception: return "I couldn't evaluate that."
    return str(int(r)) if isinstance(r, float) and r.is_integer() and abs(r) < 1e15 else str(round(r, 10) if isinstance(r, float) else r)

@tool("open_app", "Open an application.", {"name": {"type": "string"}}, ["name"])
def _open_app(name: str):
    system = platform.system(); key = name.lower().strip()
    if system == "Windows":
        known_paths = {
            "edge": [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"],
            "chrome": [r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"],
        }
        if key in known_paths:
            for p in known_paths[key]:
                if os.path.exists(p):
                    try: subprocess.Popen([p]); return f"Opened {name}."
                    except Exception: continue
        aliases = {"microsoft edge":"msedge","edge":"msedge","google chrome":"chrome","chrome":"chrome","firefox":"firefox","notepad":"notepad","calculator":"calc","calc":"calc","explorer":"explorer","file explorer":"explorer","vscode":"code","vs code":"code","cmd":"cmd","powershell":"powershell","paint":"mspaint","spotify":"spotify","discord":"discord","steam":"steam","task manager":"taskmgr"}
        exe = aliases.get(key, key)
        resolved = shutil.which(exe)
        if resolved:
            try: subprocess.Popen([resolved]); return f"Opened {name}."
            except Exception: pass
        try: subprocess.Popen(["cmd", "/c", "start", "", exe]); return f"Opened {name}."
        except Exception: pass
        return f"Couldn't open {name}."
    elif system == "Darwin":
        subprocess.Popen(["open", "-a", name]); return f"Opened {name}."
    else:
        subprocess.Popen([name]); return f"Opened {name}."

# ---- PC control by voice: volume, media keys, lock, screenshots (Windows key presses and Pillow; nothing extra to install)
_VK = {"volume_up": 0xAF, "volume_down": 0xAE, "mute": 0xAD, "play_pause": 0xB3, "next": 0xB0, "previous": 0xB1, "stop": 0xB2}
def _press(vk, times=1):
    import ctypes
    for _ in range(times):
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0); ctypes.windll.user32.keybd_event(vk, 0, 2, 0)

@tool("set_volume", "Change the PC speaker volume: set a level 0-100, or turn it up, down, mute or unmute.",
      {"action": {"type": "string", "enum": ["set", "up", "down", "mute", "unmute"]}, "level": {"type": "number", "description": "0-100, for set"}}, ["action"])
def _set_volume(action: str = "set", level: float = 0):
    if platform.system() != "Windows": return "Windows only."
    a = (action or "set").lower().strip()
    if a == "mute": _press(_VK["mute"]); return "Muted."
    if a == "unmute": _press(_VK["volume_up"]); _press(_VK["volume_down"]); return "Sound's back on."   # any volume key unmutes; up+down keeps the level
    if a == "up": _press(_VK["volume_up"], 5); return "Turned it up."
    if a == "down": _press(_VK["volume_down"], 5); return "Turned it down."
    lvl = max(0, min(100, int(round(float(level or 0)))))
    _press(_VK["volume_down"], 50); _press(_VK["volume_up"], round(lvl / 2))     # each key press moves Windows volume 2%
    return f"Volume at {lvl} percent."

@tool("media_control", "Play/pause, skip, go back or stop whatever is playing on the PC (YouTube, VLC, any player).",
      {"action": {"type": "string", "enum": ["play_pause", "next", "previous", "stop"]}}, ["action"])
def _media_control(action: str):
    if platform.system() != "Windows": return "Windows only."
    a = (action or "").lower().strip()
    if a not in ("play_pause", "next", "previous", "stop"): return "I can play, pause, skip, go back or stop."
    _press(_VK[a]); return {"play_pause": "Done.", "next": "Skipped.", "previous": "Going back.", "stop": "Stopped."}[a]

@tool("lock_pc", "Lock the computer (the Windows lock screen).")
def _lock_pc():
    if platform.system() != "Windows": return "Windows only."
    import ctypes
    return "Locked." if ctypes.windll.user32.LockWorkStation() else "Windows wouldn't lock just now."

@tool("take_screenshot", "Save a screenshot of the whole screen to Pictures/Screenshots.")
def _take_screenshot():
    from PIL import ImageGrab
    folder = Path.home() / "Pictures" / "Screenshots"; folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"Jarvis {datetime.datetime.now():%Y-%m-%d %H.%M.%S}.png"
    ImageGrab.grab(all_screens=True).save(path)
    return f"Screenshot saved to Pictures, Screenshots, as {path.name}."

# ---- WhatsApp calls while he's busy (off until he says "take my calls"): pick up, say he's not available, hang up, tell him.
# Needs WhatsApp Desktop (the Microsoft Store app; WhatsApp Web in Chrome can't be reached from outside the browser) and the
# uiautomation package (start_jarvis.bat installs it). Jarvis says the line out loud and the laptop mic carries it into the call.
CALL_LINE = "Sir is not available right now. He'll call you back later."
_CALLS = {"said": threading.Event(), "busy": False, "seen": set()}
_ACCEPT = re.compile(r"^(accept|answer)\b(?!.*video)", re.I)            # the voice "Accept", never "Accept video"
_HANGUP = re.compile(r"\b(end call|hang ?up|leave call|end)\b", re.I)

def _whatsapp_windows(auto):
    pids = {p.pid for p in psutil.process_iter(["name"]) if "whatsapp" in (p.info.get("name") or "").lower()}
    return [w for w in auto.GetRootControl().GetChildren() if w.ProcessId in pids] if pids else []

def _find_button(auto, rx, depth=14):
    for w in _whatsapp_windows(auto):
        try:
            names = []
            def walk(c, d):
                if d > depth: return None
                for ch in c.GetChildren():
                    if ch.ControlTypeName == "ButtonControl":
                        names.append(ch.Name)
                        if rx.search(ch.Name or ""): return ch
                    f = walk(ch, d + 1)
                    if f: return f
                return None
            b = walk(w, 0)
            key = (w.Name, tuple(names[:12]))
            if names and key not in _CALLS["seen"]:      # once per window layout: what WhatsApp's buttons are called on this PC
                _CALLS["seen"].add(key); print(f"[CALLS] WhatsApp window '{w.Name}' buttons: {names[:12]}")
            if b: return w, b
        except Exception: continue
    return None, None

def _press_button(b):
    try: b.GetInvokePattern().Invoke()
    except Exception: b.Click(simulateMove=False)

def _answer_call(auto, win, accept):
    caller = re.sub(r"(?i)\b(whatsapp|incoming|voice|video|call(ing)?)\b|[-|·]", " ", win.Name or "").strip() or "Someone"
    _CALLS["busy"] = True
    try:
        _press_button(accept); print(f"[CALLS] answered a WhatsApp call from {caller}")
        _broadcast_ws("callstart:")                           # the page stops listening: the caller isn't giving him commands
        time.sleep(1.5)
        _CALLS["said"].clear(); _broadcast_ws(f"callsay:{CALL_LINE}")
        _CALLS["said"].wait(20); time.sleep(0.8)
        _, hang = _find_button(auto, _HANGUP)
        if hang: _press_button(hang)
        else: print("[CALLS] couldn't find WhatsApp's end-call button; the call may still be open")
    finally:
        _broadcast_ws("callend:"); _CALLS["busy"] = False
    _broadcast_ws(f"proactive:Sir, {caller} called on WhatsApp. I told them you'd call back.")

def _call_watch():
    try: import uiautomation as auto
    except ImportError: print("[CALLS] uiautomation not installed (start_jarvis.bat installs it); call answering is off."); return
    with auto.UIAutomationInitializerInThread():
        while True:
            time.sleep(1.0)
            if not CONFIG.get("take_calls") or _CALLS["busy"]: continue
            try:
                win, accept = _find_button(auto, _ACCEPT)
                if accept: _answer_call(auto, win, accept)
            except Exception as e: print(f"[CALLS] {type(e).__name__}: {e}")

if platform.system() == "Windows": threading.Thread(target=_call_watch, daemon=True).start()

@tool("take_calls", "Turn WhatsApp call answering on or off. On: Jarvis answers WhatsApp calls, says the user isn't available and will call back, hangs up, and reports who called.",
      {"on": {"type": "boolean"}}, ["on"])
def _take_calls(on: bool):
    CONFIG["take_calls"] = bool(on); save_config(CONFIG)
    if not on: return "I'll leave your calls alone."
    has_app = any("whatsapp" in (p.info.get("name") or "").lower() for p in psutil.process_iter(["name"]))
    return "I'll take your WhatsApp calls and say you'll call back." + ("" if has_app else " WhatsApp Desktop isn't running, though; I can only answer calls in the desktop app.")

@tool("window_control", "Minimize, maximize, restore, focus, or close a window of another app (not Jarvis's music player: play_music stop).",
      {"action": {"type": "string", "enum": ["minimize","maximize","restore","focus","close"]}, "app": {"type": "string"}}, ["action","app"])
def _window_control(action: str, app: str = ""):
    if platform.system() != "Windows": return "Windows only."
    action = action.lower().strip(); app = app.lower().strip()
    try:
        import ctypes
        user32 = ctypes.windll.user32
        SW_MINIMIZE, SW_MAXIMIZE, SW_RESTORE, WM_CLOSE = 6, 3, 9, 0x0010
        found = []
        def cb(hwnd, _):
            if user32.IsWindowVisible(hwnd):
                ln = user32.GetWindowTextLengthW(hwnd)
                if ln > 0:
                    buf = ctypes.create_unicode_buffer(ln+1); user32.GetWindowTextW(hwnd, buf, ln+1)
                    if app in buf.value.lower(): found.append((hwnd, buf.value))
            return True
        user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(cb), 0)
        if not found: return f"No window matching '{app}'."
        hwnd, title = found[0]
        if action == "minimize": user32.ShowWindow(hwnd, SW_MINIMIZE)
        elif action == "maximize": user32.ShowWindow(hwnd, SW_MAXIMIZE)
        elif action == "restore": user32.ShowWindow(hwnd, SW_RESTORE)
        elif action == "focus": user32.SetForegroundWindow(hwnd)
        elif action == "close": user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        else: return f"Unknown action {action}."
        return f"{action.capitalize()}d {title}."
    except Exception as e: return f"Failed: {e}"

@tool("play_music", "Play music on YouTube.", {"query": {"type": "string"}}, ["query"])
def _play_music(query: str):
    webbrowser.open(f"https://www.youtube.com/results?search_query={query.replace(' ', '+')}")
    return f"Playing {query} on YouTube."

PUBLIC_CAMS = {
    "times square":"https://www.earthcam.com/usa/newyork/timessquare/?cam=tsstreet",
    "london":"https://www.earthcam.com/world/england/london/abbeyroad/?cam=abbeyroad",
    "tokyo":"https://www.earthcam.com/world/japan/tokyo/shibuya/?cam=shibuya",
    "paris":"https://www.earthcam.com/world/france/paris/?cam=eiffeltower",
    "rome":"https://www.earthcam.com/world/italy/rome/?cam=colosseo",
    "sydney":"https://www.earthcam.com/world/australia/sydney/?cam=sydney",
    "miami":"https://www.earthcam.com/usa/florida/miami/?cam=miamibeach",
    "las vegas":"https://www.earthcam.com/usa/nevada/lasvegas/?cam=vegas",
}

@tool("show_public_cam", "Open a LIVE public webcam / live camera feed of a place (Times Square, London, Tokyo, Paris, Rome, Sydney, "
      "Miami, Las Vegas, or a search for anywhere else). Use it for 'show me cameras in X', 'live feeds of X'.",
      {"location": {"type": "string"}}, ["location"])
def _show_public_cam(location: str):
    import urllib.parse, webbrowser
    key = location.lower().strip()
    if key in PUBLIC_CAMS: webbrowser.open(PUBLIC_CAMS[key]); return f"Opening live view of {location}."
    for name, url in PUBLIC_CAMS.items():
        if name in key or key in name: webbrowser.open(url); return f"Opening live view of {name}."
    q = urllib.parse.quote(f"{location} live webcam public")
    webbrowser.open(f"https://www.google.com/search?q={q}")
    return f"No cam in my index for {location}. Opened a search."

active_timers = []
def _play_timer_sound():
    try:
        if platform.system() == "Windows":
            import winsound
            for _ in range(3): winsound.Beep(1000, 300); winsound.Beep(1500, 300)
        else: print("\a\a\a")
    except Exception: print("\a\a\a")
def _fire_timer(label):
    _play_timer_sound()
    _broadcast_ws(f"timer:{label}")

@tool("set_timer", "Set a timer in seconds.", {"seconds": {"type": "integer"}, "label": {"type": "string"}}, ["seconds"])
def _set_timer(seconds: int, label: str = "timer"):
    try: seconds = int(seconds)
    except Exception: return "Invalid duration."
    if seconds <= 0: return "Duration must be positive."
    if seconds > 86400: return "I can do up to 24 hours."
    t = threading.Timer(seconds, _fire_timer, args=(label,))
    t.daemon = True; t.start(); active_timers.append(t)
    if seconds < 60: return f"Timer set for {seconds} seconds."
    if seconds < 3600:
        m, s = seconds // 60, seconds % 60
        return f"Timer set for {m} minutes" + (f" {s} seconds." if s else ".")
    h, m = seconds // 3600, (seconds % 3600) // 60
    return f"Timer set for {h} hours" + (f" {m} minutes." if m else ".")

@tool("remember", "Save a fact about the user.", {"fact": {"type": "string"}}, ["fact"])
def _remember(fact: str):
    if not fact or len(fact) < 3: return "Too short to remember."
    db_save_memory(fact)
    global conversation
    conversation[0] = {"role": "system", "content": build_system_prompt()}
    return "Got it. I'll remember that."

@tool("recall", "Recall saved facts.", {"query": {"type": "string"}}, ["query"])
def _recall(query: str):
    results = db_search_memories_semantic(query, limit=5)
    if not results: return f"Nothing stored about {query}."
    return "I remember: " + "; ".join(results[:5])

@tool("list_memories", "List everything you remember.")
def _list_memories():
    mems = db_get_memories(50)
    return "I know: " + "; ".join(mems) if mems else "Nothing remembered yet."

@tool("forget_memory", "Delete stored facts matching a keyword.", {"query": {"type": "string"}}, ["query"])
def _forget_memory(query: str):
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            ids = [r[0] for r in c.execute("SELECT id FROM memories WHERE fact LIKE ?", (f"%{query}%",)).fetchall()]
            c.execute("DELETE FROM memories WHERE fact LIKE ?", (f"%{query}%",))
            for mid in ids: c.execute("DELETE FROM memory_vectors WHERE memory_id=?", (mid,))
            c.commit()
        global conversation
        conversation[0] = {"role": "system", "content": build_system_prompt()}
        return "Forgotten."
    except Exception: return "Failed."

@tool("set_preference", "Save a preference about HOW you behave.", {"pref": {"type": "string"}}, ["pref"])
def _set_preference(pref: str):
    if not pref or len(pref) < 3: return "Too short."
    db_save_preference(pref)
    global conversation
    conversation[0] = {"role": "system", "content": build_system_prompt()}
    return "Noted."

@tool("list_preferences", "List all preferences.")
def _list_preferences():
    prefs = db_get_preferences(20)
    return "Preferences: " + "; ".join(prefs) if prefs else "No preferences."

@tool("forget_preference", "Remove preferences matching a keyword.", {"query": {"type": "string"}}, ["query"])
def _forget_preference(query: str):
    db_delete_preference(query)
    global conversation
    conversation[0] = {"role": "system", "content": build_system_prompt()}
    return "Removed."

@tool("set_reminder", "Set a reminder at a natural language time.",
      {"when": {"type": "string"}, "text": {"type": "string"}}, ["when","text"])
def _set_reminder(when: str, text: str):
    from dateutil import parser as dateparse
    try:
        now = datetime.datetime.now()
        when_l = when.lower().strip()
        if when_l.startswith("in "):
            rest = when_l[3:].strip()
            m = re.match(r"(\d+)\s*(second|minute|hour|day)s?", rest)
            if m:
                val = int(m.group(1)); unit = m.group(2)
                mult = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}[unit]
                db_add_reminder(time.time() + val * mult, text)
                return f"Reminder set for {val} {unit}{'s' if val != 1 else ''} from now."
        dt = dateparse.parse(when, fuzzy=True)
        if dt < now: dt += datetime.timedelta(days=1)
        db_add_reminder(dt.timestamp(), text)
        return f"Reminder set for {dt.strftime('%I:%M %p on %A, %B %d').lstrip('0')}."
    except Exception: return f"Couldn't parse '{when}'."

@tool("list_reminders", "List pending reminders.")
def _list_reminders():
    try:
        with closing(sqlite3.connect(DB_PATH)) as c:
            rows = c.execute("SELECT fire_at, text FROM reminders WHERE fired=0 ORDER BY fire_at").fetchall()
        if not rows: return "No reminders."
        return "Reminders: " + "; ".join(f"{t} at {datetime.datetime.fromtimestamp(fa).strftime('%I:%M %p').lstrip('0')}" for fa, t in rows)
    except Exception: return "Couldn't list reminders."

# Groq's image models, newest first (they get renamed; the next one is tried when one is gone). Ollama only if Groq can't.
GROQ_VISION_MODELS = [m for m in os.environ.get("JARVIS_VISION_MODELS", "qwen/qwen3.8-27b,meta-llama/llama-4-scout-17b-16e-instruct").split(",") if m]

_OLLAMA_VISION = {"ok": True}

def _describe_image(data_url, question):
    if _groq_usable():
        for model in list(GROQ_VISION_MODELS):
            for attempt in (1, 2):
                try:
                    r = groq_client.with_options(timeout=30, max_retries=0).chat.completions.create(model=model, max_tokens=400, temperature=0.2,
                        messages=[{"role": "user", "content": [{"type": "text", "text": question},
                                                               {"type": "image_url", "image_url": {"url": data_url}}]}])
                    return (r.choices[0].message.content or "").strip()
                except Exception as e:
                    print(f"[VISION] {model}: {_why(e)[:200]}")
                    if "Connection" in type(e).__name__ and attempt == 1: time.sleep(1.0); continue     # an internet blip: once more
                    _groq_failed(e)
                    if re.search(r"model_not_found|decommissioned|does not exist|not supported", str(e), re.I):
                        GROQ_VISION_MODELS.remove(model); break                                         # renamed: the next model
                    return None      # Groq is there but failed, or the internet is down: a local model would only tie up the PC
    # Ollama only when Groq can't be used at all, and only until it fails once (a model it can't run kept the processor busy for nothing)
    if _groq_usable() or not _OLLAMA_VISION["ok"]: return None
    try:
        raw = base64.b64decode(data_url.split(",")[-1]); tmp = tempfile.mktemp(suffix=".png")
        with open(tmp, "wb") as f: f.write(raw)
        try: return ollama.chat(model=OLLAMA_VISION_MODEL, messages=[{"role": "user", "content": question, "images": [tmp]}])["message"]["content"]
        finally: os.unlink(tmp)
    except Exception as e: print(f"[VISION] ollama: {str(e)[:160]} (not tried again this run)"); _OLLAMA_VISION["ok"] = False
    return None

@tool("look_at_screen", "Look at the user's screen (he picks the window or screen to share) and describe it or answer a question about it: "
      "'what's on my screen', 'read this error', 'what does this say'.", {"question": {"type": "string", "description": "what he wants to know about it"}})
def _look_at_screen(question: str = ""):
    rid = secrets.token_hex(4)
    evt = threading.Event()
    _pending_vision[rid] = {"event": evt, "image_b64": None}
    _broadcast_ws(f"look_request:{rid}")
    if not evt.wait(timeout=45.0):     # he has to pick the window in Chrome's share picker first
        _pending_vision.pop(rid, None); return "I didn't get a picture of the screen. Pick a window or screen in the box that pops up."
    img = (_pending_vision.pop(rid, {}) or {}).get("image_b64")
    if not img: return "Screen capture was cancelled."
    ask = (question.strip() + " Answer briefly from what's on the screen." if question and question.strip()
           else "Briefly describe what's on this screen, focusing on the main window: what app it is and what it shows.")
    return _describe_image(img, ask) or "I couldn't analyse the screen just now."

_index_lock = threading.Lock()
def _chunk_text(text, size=500, overlap=80):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= size: return [text] if text else []
    chunks = []; i = 0
    while i < len(text):
        chunks.append(text[i:i+size]); i += size - overlap
        if i >= len(text): break
    return chunks

def _doc_index_worker():
    time.sleep(5)
    while True:
        try: _index_all_docs()
        except Exception as e: print(f"[DOCS] index error: {e}")
        time.sleep(120)

def _index_all_docs():
    if EMBEDDER is None: return
    if not DOCS_SRC.is_dir(): return
    with _index_lock:
        for f in DOCS_SRC.rglob("*"):
            if not f.is_file(): continue
            if f.suffix.lower() not in {".txt", ".md", ".pdf", ".docx", ".csv", ".json", ".html"}: continue
            try: mt = f.stat().st_mtime
            except Exception: continue
            existing = db_file_indexed_mtime(str(f))
            if existing is not None and abs(existing - mt) < 1: continue
            text = ""
            try:
                if f.suffix.lower() == ".pdf":
                    from pypdf import PdfReader
                    text = "\n".join(p.extract_text() or "" for p in PdfReader(str(f)).pages)
                elif f.suffix.lower() == ".docx":
                    from docx import Document
                    text = "\n".join(p.text for p in Document(str(f)).paragraphs)
                else:
                    with open(f, "r", encoding="utf-8", errors="ignore") as fh: text = fh.read()
            except Exception as e: print(f"[DOCS] read {f}: {e}"); continue
            if not text.strip(): continue
            chunks = _chunk_text(text)
            db_clear_docs_for_file(str(f))
            for idx, ch in enumerate(chunks):
                try:
                    vec = list(EMBEDDER.embed([ch]))[0]
                    db_insert_chunk(str(f), mt, idx, ch, vec)
                except Exception: db_insert_chunk(str(f), mt, idx, ch, None)
            print(f"[DOCS] Indexed {f.name} ({len(chunks)} chunks)")

@tool("reindex_documents", "Re-scan the docs/ folder.")
def _reindex_documents():
    _index_all_docs()
    with closing(sqlite3.connect(DB_PATH)) as c:
        nf = c.execute("SELECT COUNT(DISTINCT file_path) FROM doc_chunks").fetchone()[0]
        nc = c.execute("SELECT COUNT(*) FROM doc_chunks").fetchone()[0]
    return f"Indexed {nf} files, {nc} chunks."

@tool("query_documents", "Search indexed user documents.", {"query": {"type": "string"}}, ["query"])
def _query_documents(query: str):
    results = db_query_docs(query, top_k=4)
    if not results: return "Nothing found in your documents."
    return "\n\n".join(f"From {os.path.basename(p)}: {c[:400]}" for p, c in results)

@tool("crypto_price", "Get cryptocurrency price.", {"symbol": {"type": "string"}}, ["symbol"])
def _crypto_price(symbol: str):
    import requests
    ids = {"btc":"bitcoin","bitcoin":"bitcoin","eth":"ethereum","ethereum":"ethereum","sol":"solana","solana":"solana","doge":"dogecoin","dogecoin":"dogecoin","ada":"cardano","cardano":"cardano","xrp":"ripple","ripple":"ripple","bnb":"binancecoin","ltc":"litecoin","litecoin":"litecoin","dot":"polkadot","polkadot":"polkadot","matic":"matic-network","link":"chainlink"}
    cid = ids.get(symbol.lower().strip(), symbol.lower().strip())
    d = requests.get("https://api.coingecko.com/api/v3/simple/price", params={"ids": cid, "vs_currencies": "usd", "include_24hr_change": "true"}, timeout=8).json()
    if cid not in d: return f"No price for {symbol}."
    p = d[cid]["usd"]; ch = d[cid].get("usd_24h_change", 0)
    return f"{symbol.upper()} is ${p:,.2f}, {'up' if ch>=0 else 'down'} {abs(ch):.2f} percent in the last 24 hours."

@tool("currency_convert", "Convert between currencies.",
      {"amount": {"type": "number"}, "from_currency": {"type": "string"}, "to_currency": {"type": "string"}},
      ["amount","from_currency","to_currency"])
def _currency_convert(amount: float, from_currency: str, to_currency: str):
    import requests
    try: amount = float(amount)
    except Exception: return "Invalid amount."
    f, t = from_currency.upper().strip(), to_currency.upper().strip()
    d = requests.get("https://api.exchangerate.host/convert", params={"from": f, "to": t, "amount": amount}, timeout=8).json()
    if "result" not in d: return f"Couldn't convert {f} to {t}."
    return f"{amount:,.2f} {f} is about {d['result']:,.2f} {t}."

@tool("news_headlines", "Get top news headlines.", {"topic": {"type": "string"}})
def _news_headlines(topic: str = ""):
    import requests
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(topic)}&hl=en-US&gl=US&ceid=US:en" if topic else "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"
    root = ET.fromstring(requests.get(url, timeout=8).content)
    items = root.findall(".//item")[:5]
    if not items: return "No headlines."
    out = []
    for it in items:
        title = it.findtext("title") or ""
        if " - " in title: title = title.rsplit(" - ", 1)[0]
        out.append(title)
    return "Top headlines: " + ". ".join(out) + "."

@tool("translate", "Translate English text.", {"text": {"type": "string"}, "to_language": {"type": "string"}}, ["text","to_language"])
def _translate(text: str, to_language: str):
    import requests
    langs = {"spanish":"es","french":"fr","german":"de","italian":"it","portuguese":"pt","russian":"ru","japanese":"ja","korean":"ko","chinese":"zh","mandarin":"zh","arabic":"ar","hindi":"hi","dutch":"nl","polish":"pl","turkish":"tr","swedish":"sv","greek":"el","hebrew":"he","thai":"th","vietnamese":"vi"}
    code = langs.get(to_language.lower().strip(), to_language.lower().strip())
    d = requests.get("https://api.mymemory.translated.net/get", params={"q": text, "langpair": f"en|{code}"}, timeout=8).json()
    tr = d.get("responseData", {}).get("translatedText", "")
    return f"In {to_language}: {tr}" if tr else "Translation failed."

@tool("search_files", "Search local text files.", {"query": {"type": "string"}, "folder": {"type": "string"}}, ["query"])
def _search_files(query: str, folder: str = ""):
    folder = folder or os.path.expanduser("~")
    if not os.path.isdir(folder): return f"Folder {folder} doesn't exist."
    exts = {".txt",".md",".py",".js",".json",".html",".css",".csv",".log",".yaml",".yml",".ini",".cfg"}
    matches = []; checked = 0
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in ("node_modules",".git","__pycache__","venv",".venv","AppData","Windows","Program Files","Program Files (x86)")]
        for fname in files:
            checked += 1
            if checked > 5000: break
            ext = os.path.splitext(fname)[1].lower()
            if ext not in exts:
                if query.lower() in fname.lower(): matches.append(os.path.join(root, fname))
                continue
            path = os.path.join(root, fname)
            try:
                if os.path.getsize(path) > 2_000_000: continue
                with open(path, "r", encoding="utf-8", errors="ignore") as f: content = f.read()
                if query.lower() in content.lower() or query.lower() in fname.lower(): matches.append(path)
            except Exception: continue
            if len(matches) >= 10: break
        if checked > 5000 or len(matches) >= 10: break
    if not matches: return f"No files matching '{query}'."
    return f"Found {len(matches)} files: " + "; ".join(os.path.basename(m) for m in matches[:5])

@tool("flip_coin", "Flip a coin.")
def _flip_coin(): return secrets.choice(["Heads.", "Tails."])

@tool("roll_dice", "Roll a die.", {"sides": {"type": "integer"}})
def _roll_dice(sides: int = 6):
    try: sides = int(sides)
    except Exception: sides = 6
    if sides < 2 or sides > 1000: sides = 6
    return f"Rolled a {secrets.randbelow(sides) + 1}."

@tool("generate_password", "Generate a random password.", {"length": {"type": "integer"}, "symbols": {"type": "boolean"}})
def _generate_password(length: int = 20, symbols: bool = True):
    try: length = int(length)
    except Exception: length = 20
    length = max(8, min(length, 128))
    a = string.ascii_letters + string.digits
    if symbols: a += "!@#$%^&*()-_=+"
    pwd = "".join(secrets.choice(a) for _ in range(length))
    try:
        import pyperclip; pyperclip.copy(pwd)
        return f"Generated a {length} character password and copied it to your clipboard."
    except Exception: return f"Password: {pwd}"

@tool("take_note", "Save a note.", {"text": {"type": "string"}}, ["text"])
def _take_note(text: str):
    with open("notes.txt", "a", encoding="utf-8") as f: f.write(f"[{datetime.datetime.now().isoformat()}] {text}\n")
    return "Note saved."

@tool("read_notes", "Read saved notes.")
def _read_notes():
    if not os.path.exists("notes.txt"): return "No notes yet."
    with open("notes.txt", encoding="utf-8") as f: return f.read()[-2000:] or "Notes are empty."

@tool("list_files", "List files in a folder.", {"folder": {"type": "string"}})
def _list_files(folder: str = "."): return "\n".join(os.listdir(folder))

@tool("read_file", "Read a text file.", {"path": {"type": "string"}}, ["path"])
def _read_file(path: str):
    with open(path, encoding="utf-8") as f: return f.read()[:3000]

@tool("get_clipboard", "Get clipboard contents.")
def _get_clipboard():
    import pyperclip; return pyperclip.paste()[:1000] or "(clipboard empty)"

@tool("forget_all", "Wipe all memory.")
def _forget_all():
    db_wipe()
    global conversation, CONVERSATION_SUMMARY
    CONVERSATION_SUMMARY = ""
    conversation = [{"role": "system", "content": build_system_prompt()}]
    return "Memory wiped."

DOCS_DIR = Path.home() / "Downloads" / "Jarvis"; DOCS_DIR.mkdir(parents=True, exist_ok=True)
def _safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\s\-.]", "", name or "").strip()
    name = re.sub(r"\s+", "_", name)
    return (name[:100] or "document")

@tool("create_pdf", "Create a PDF and save to Downloads/Jarvis.",
      {"title": {"type": "string"}, "content": {"type": "string"}, "filename": {"type": "string"}}, ["title","content"])
def _create_pdf(title: str, content: str, filename: str = ""):
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from reportlab.lib.units import inch
    if not filename: filename = _safe_filename(title) + ".pdf"
    if not filename.lower().endswith(".pdf"): filename += ".pdf"
    path = DOCS_DIR / filename
    doc = SimpleDocTemplate(str(path), pagesize=LETTER)
    styles = getSampleStyleSheet()
    story = [Paragraph(title, styles["Title"]), Spacer(1, 0.3*inch)]
    for para in content.split("\n\n"):
        para = para.strip()
        if para:
            story.append(Paragraph(para.replace("\n", "<br/>"), styles["BodyText"]))
            story.append(Spacer(1, 0.15*inch))
    doc.build(story)
    return f"Saved PDF to Downloads/Jarvis/{filename}."

@tool("create_docx", "Create a Word doc.",
      {"title": {"type": "string"}, "content": {"type": "string"}, "filename": {"type": "string"}}, ["title","content"])
def _create_docx(title: str, content: str, filename: str = ""):
    from docx import Document
    if not filename: filename = _safe_filename(title) + ".docx"
    if not filename.lower().endswith(".docx"): filename += ".docx"
    path = DOCS_DIR / filename
    d = Document(); d.add_heading(title, level=0)
    for para in content.split("\n\n"):
        para = para.strip()
        if para: d.add_paragraph(para)
    d.save(str(path))
    return f"Saved Word document to Downloads/Jarvis/{filename}."

@tool("create_text_file", "Create any text file.",
      {"filename": {"type": "string"}, "content": {"type": "string"}}, ["filename","content"])
def _create_text_file(filename: str, content: str):
    if not filename: return "I need a filename."
    safe_name = _safe_filename(filename)
    with open(DOCS_DIR / safe_name, "w", encoding="utf-8") as f: f.write(content)
    return f"Saved Downloads/Jarvis/{safe_name}."

@tool("list_documents", "List generated documents.")
def _list_documents():
    files = sorted(f.name for f in DOCS_DIR.iterdir() if f.is_file())
    return "Documents: " + ", ".join(files) if files else "No documents yet."

@tool("delete_document", "Delete a generated document.", {"filename": {"type": "string"}}, ["filename"])
def _delete_document(filename: str):
    safe_name = _safe_filename(filename); p = DOCS_DIR / safe_name
    if p.exists(): p.unlink(); return f"Deleted {safe_name}."
    return f"No file named {safe_name}."

@tool("list_voices", "List available voices.")
def _list_voices_tool():
    if not VOICES: return "No voices loaded."
    pairs = _voice_pairs()
    cur = _friendly_name(CONFIG.get("voice") or pairs[0][0])
    return f"Available voices: {', '.join(fn for _, fn in pairs)}. Currently active: {cur}."

# ---- characters ("be Ultron", "talk like Morgan Freeman"): their real voice and way of talking until told to stop. The voice comes
# from Fish Audio's public voice library (clones people have made of characters and famous voices), spoken by Fish Audio's free
# voice API with the user's own key. No matching voice, or no key: he says so and stays himself. Kept in config.json until "stop".
_FISH_LIBRARY = "https://api.fish.audio/model"
def _words(t): return [w for w in re.sub(r"[^a-z0-9 ]+", " ", unicodedata.normalize("NFKD", str(t or "")).lower()).split() if len(w) > 1]
def _find_fish_voice(who):
    import requests
    want = [w for w in _words(who) if w not in ("the", "mr", "mrs", "ms", "dr", "sir", "voice", "from")]
    if not want: return None
    for lang in ({"language": "en"}, {}):
        r = requests.get(_FISH_LIBRARY, params={"title": " ".join(want), "page_size": 20, "sort_by": "score", **lang}, timeout=8); r.raise_for_status()
        hits = [m for m in r.json().get("items", []) if m.get("state") == "trained" and m.get("type", "tts") == "tts"
                and all(w in _words(m.get("title")) for w in want)]
        if hits:
            best = max(hits, key=lambda m: m.get("task_count") or 0)
            return {"id": best["_id"], "title": str(best.get("title") or "").strip()}
    return None

@tool("become", "Become anyone the user names, with their real voice: a film or game character, a famous person ('be Ultron', 'talk like Morgan Freeman', "
      "'imitate Optimus Prime'). Stay that way until told to stop. who: the name as it's best known (e.g. 'Ultron', 'Morgan Freeman'); "
      "style: one or two sentences on how they talk (words, rhythm, attitude, signature phrases).",
      {"who": {"type": "string"}, "style": {"type": "string"}}, ["who"])
def _become(who="", style=""):
    who = str(who or "").strip()[:60]
    try: v = _find_fish_voice(who)
    except Exception as e: print(f"[PERSONA] library: {e}"); return "Couldn't reach the voice library just now. Tell the user briefly, as yourself, and stay Jarvis."
    if not v: return f"There's no voice for {who} in the voice library. Tell the user briefly, as yourself, that you can't do their voice, and stay Jarvis."
    if not _fish_key():
        _FISH["asked"] = time.time()
        return (f"{who}'s voice is there, but speaking in it needs the user's free Fish Audio key (make an account at fish dot audio, then API keys). "
                "They can just type it to you in a message. Tell them that briefly, as yourself, and stay Jarvis for now.")
    CONFIG["persona"] = {"who": who, "voice_id": v["id"], "voice_title": v["title"], "style": str(style or "")[:300]}
    save_config(CONFIG); _TTS_CACHE.clear(); _FISH["paused_until"] = 0
    print(f"[PERSONA] {who}: Fish voice {v['title']!r} ({v['id']})")
    return f"You are now {who}, in their voice. Answer as them from now on. Say something short in character now."

@tool("stop_being", "Stop playing a character and be Jarvis again ('stop', 'be yourself', 'back to Jarvis', 'drop the act').")
def _stop_being():
    p = _persona(); CONFIG.pop("persona", None); save_config(CONFIG); _TTS_CACHE.clear()
    return f"Back to being Jarvis (no longer {p['who']}). Say so briefly, as yourself." if p else "You're already yourself."

@tool("set_voice", "Change the speaking voice.", {"voice_name": {"type": "string"}}, ["voice_name"])
def _set_voice_tool(voice_name):
    if not VOICES: return "No voices loaded."
    resolved = _resolve_voice(voice_name or "")
    if not resolved:
        key = (voice_name or "").lower().strip()
        for v in VOICES.keys():
            if v.lower() == key or (key and key in v.lower()): resolved = v; break
    if not resolved: return f"I don't have a voice called '{voice_name}'. Available: {_voice_summary()}."
    CONFIG["voice"] = resolved; save_config(CONFIG); _broadcast_voice_change(resolved)
    return f"Voice switched to {_friendly_name(resolved)}."

# ============================================================
# DELIVERY COPILOT  (DoorDash / Uber Eats / Grubhub: stack up to 4 orders)
# Jarvis plans the route. YOU accept orders in the driver app: those apps have
# no driver API and automating them breaks their terms. See delivery.py.
# ============================================================
import delivery
DELIVERY = delivery.Copilot(DB_PATH, CONFIG.get("delivery", {}), broadcast=_broadcast_ws)

def _delivery_refresh():
    """Re-plan, push to the browser panel, return the plan."""
    plan = DELIVERY.plan()
    DELIVERY.push(plan)
    if NAV_STATE_ACTIVE_DELIVERY():
        threading.Thread(target=_nav_refresh_delivery, daemon=True).start()
    return plan

@tool("add_delivery_order",
      "Add a delivery order the driver has accepted (DoorDash, Uber Eats, Grubhub...) to the stack (max 4) "
      "and return the best route. Needs the restaurant and the customer's drop-off street address.",
      {"restaurant": {"type": "string"},
       "dropoff_address": {"type": "string", "description": "customer street address"},
       "pickup_address": {"type": "string", "description": "restaurant street address, if known"},
       "payout": {"type": "number", "description": "total dollars for this order including tip"},
       "platform": {"type": "string", "description": "doordash, ubereats, grubhub..."},
       "ready_in_minutes": {"type": "number", "description": "minutes until food is ready, 0 if ready"},
       "deliver_within_minutes": {"type": "number", "description": "minutes until it is due, if shown"}},
      ["restaurant", "dropoff_address"])
def _add_delivery_order(restaurant: str, dropoff_address: str, pickup_address: str = "", payout: float = 0,
                        platform: str = "doordash", ready_in_minutes: float = 0, deliver_within_minutes: float = 0):
    r = DELIVERY.add_order(restaurant, dropoff_address, pickup_address, payout, platform,
                           ready_in_minutes, deliver_within_minutes)
    if not r["ok"]: return r["error"]
    plan = _delivery_refresh()
    return f"Added order {r['id']}: {r['restaurant']} to {r['dropoff']}. " + DELIVERY.spoken_plan(plan)

@tool("plan_deliveries", "Recalculate and read out the best route for the current stack of orders.")
def _plan_deliveries():
    return DELIVERY.spoken_plan(_delivery_refresh())

@tool("next_stop", "Say where the driver should go next and when they will arrive.")
def _next_stop():
    return DELIVERY.spoken_next(_delivery_refresh())

@tool("complete_stop",
      "The driver finished a stop. Use when they say picked up / got the food, or delivered / dropped off. "
      "Optionally name the restaurant if it is not the next planned stop.",
      {"order": {"type": "string", "description": "restaurant name or order id, optional"},
       "stop_type": {"type": "string", "enum": ["pickup", "drop"], "description": "pickup or drop, optional"}})
def _complete_stop(order: str = "", stop_type: str = ""):
    r = DELIVERY.complete_next(order, stop_type)
    if not r["ok"]: return r["error"]
    plan = _delivery_refresh()
    if r["kind"] == "pickup": head = f"Picked up from {r['restaurant']}."
    else: head = f"Delivered {r['restaurant']}." + (f" ${r['payout']:.2f} banked." if r.get("payout") else "")
    if not plan.get("ok"):
        e = DELIVERY.earnings()
        return head + f" Stack cleared. Today: {e['count']} deliveries, ${e['total']:.2f}."
    return head + " " + DELIVERY.spoken_next(plan)

@tool("list_delivery_orders", "List the orders currently in the stack.")
def _list_delivery_orders():
    return DELIVERY.spoken_orders()

@tool("remove_delivery_order", "Remove one order from the stack (cancelled or unassigned).",
      {"order": {"type": "string", "description": "restaurant name or order id"}}, ["order"])
def _remove_delivery_order(order: str):
    o = DELIVERY.remove_order(order)
    if not o: return f"No active order matching {order}."
    plan = _delivery_refresh()
    return f"Removed {o['restaurant']}. " + (DELIVERY.spoken_plan(plan) if plan.get("ok") else "The stack is empty.")

@tool("clear_deliveries", "Clear every order from the stack.")
def _clear_deliveries():
    n = DELIVERY.clear()
    DELIVERY.push({"ok": False})
    return f"Cleared {n} order{'s' if n != 1 else ''}."

@tool("set_my_location", "Tell Jarvis where the user is now, so routes start from there.",
      {"address": {"type": "string"}}, ["address"])
def _set_my_location(address: str):
    g = DELIVERY.set_location(address)
    if not g: return f"Couldn't find {address}."
    if DELIVERY.has_active(): _delivery_refresh()
    area = f" Search area is now {g['area']}." if g.get("area") else ""
    return f"Location set to {delivery.short_addr(address)}.{area}"

@tool("evaluate_delivery_offer",
      "Judge a delivery offer BEFORE the driver accepts it: extra time and miles it adds to the current stack, "
      "dollars per hour and per mile, and whether it makes anyone late.",
      {"restaurant": {"type": "string"}, "dropoff_address": {"type": "string"},
       "pickup_address": {"type": "string"}, "payout": {"type": "number"},
       "platform": {"type": "string"}, "ready_in_minutes": {"type": "number"}},
      ["restaurant", "dropoff_address", "payout"])
def _evaluate_delivery_offer(restaurant: str, dropoff_address: str, payout: float = 0, pickup_address: str = "",
                             platform: str = "", ready_in_minutes: float = 0):
    r = DELIVERY.evaluate_offer(restaurant, dropoff_address, pickup_address, payout, platform, ready_in_minutes)
    if not r["ok"]: return r["error"]
    cfg = DELIVERY.cfg
    words = {"take": "Take it.", "marginal": "Marginal.", "decline": "I'd pass.", "unknown": "No payout given, so no verdict."}
    txt = (f"{words[r['verdict']]} It adds about {r['extra_min']} minutes and {r['extra_miles']} miles to your run")
    if r["payout"] > 0:
        txt += (f" for ${r['payout']:.2f}, roughly ${r['per_hour']:.0f} an hour and ${r['per_mile']:.2f} a mile. "
                f"Your floors are ${cfg['min_per_hour']:.0f} an hour and ${cfg['min_per_mile']:.2f} a mile.")
    else: txt += "."
    if r["extra_late_min"] >= 2: txt += f" It would make other drop-offs about {r['extra_late_min']} minutes later."
    txt += f" On-time risk with it: {r['risk']}."
    if r["plan"].get("source") == "estimate": txt += " Map service was unreachable, so these are estimates."
    return txt + " Your call. You accept it in the app; tell me if you do."

@tool("open_navigation", "Open turn-by-turn directions through every stop of the planned route.")
def _open_navigation():
    plan = _delivery_refresh()
    if not plan.get("ok"): return plan.get("error", "No active orders.")
    webbrowser.open(plan["nav_url"])
    return f"Opened directions through {len(plan['stops'])} stops."

@tool("delivery_earnings", "Today's delivery earnings and pace.")
def _delivery_earnings():
    e = DELIVERY.earnings()
    if not e["count"]: return "No completed deliveries logged today."
    by = ", ".join(f"{k} ${v:.2f}" for k, v in e["by_platform"].items())
    pace = f" About ${e['per_hour']:.0f} an hour over {e['hours']} hours." if e["per_hour"] else ""
    mi = f" {e['miles']} miles driven, ${e['per_mile']:.2f} a mile." if e.get("miles") else ""
    return f"Today: {e['count']} deliveries, ${e['total']:.2f} ({by}).{pace}{mi}"

@tool("read_offer_from_screen",
      "Capture the screen and read a delivery offer shown on it (restaurant, payout, addresses). "
      "Returns what was read so the driver can confirm before it is added or evaluated.")
def _read_offer_from_screen():
    rid = secrets.token_hex(4); evt = threading.Event()
    _pending_vision[rid] = {"event": evt, "image_b64": None}
    _broadcast_ws(f"look_request:{rid}")
    if not evt.wait(timeout=15.0):
        _pending_vision.pop(rid, None); return "Screen capture timed out."
    img = (_pending_vision.pop(rid, {}) or {}).get("image_b64")
    if not img: return "Screen capture failed."
    tmp = tempfile.mktemp(suffix=".png")
    try:
        with open(tmp, "wb") as f: f.write(base64.b64decode(img.split(",")[-1]))
        prompt = ('Read the food delivery offer on this screen. Reply with ONLY a JSON object with keys '
                  'platform, restaurant, pickup_address, dropoff_address, payout (number, dollars), miles (number), '
                  'deliver_by_minutes (number). Use null for anything not clearly visible. Do not guess.')
        raw = ollama.chat(model=OLLAMA_VISION_MODEL,
                          messages=[{"role": "user", "content": prompt, "images": [tmp]}])["message"]["content"]
    except Exception as e:
        print(f"[DELIVERY] vision fail: {e}"); return "Couldn't read the screen."
    finally:
        try: os.unlink(tmp)
        except Exception: pass
    m = re.search(r"\{.*\}", raw or "", re.S)
    try: d = json.loads(m.group(0)) if m else {}
    except Exception: d = {}
    if not d: return "I couldn't make out an offer on screen."
    missing = [k for k in ("restaurant", "dropoff_address", "payout") if not d.get(k)]
    note = (" Apps often hide the exact drop-off until you accept, so I may need the street address from you."
            if "dropoff_address" in missing else "")
    return ("I read: " + json.dumps(d) + ". Screen reading can misread numbers, so confirm these with the driver "
            "before adding or evaluating." + (f" Still missing: {', '.join(missing)}." if missing else "") + note)

# ============================================================
# NAVIGATION: worldwide map, turn-by-turn, CarPlay-style screen (see nav.py, nav.js, nav_core.js, NAV.md)
# ============================================================
import nav
NAV = nav.Navigator(CONFIG.get("nav", {}))
NAV_STATE = {"active": False, "route": None, "label": "", "mode": "auto", "delivery": False, "dest": [],
             "pos": None, "synced": None, "rv": None, "cc": "", "progress": None, "avoid": [], "view": "off"}

def _nav_cfg():
    return {"provider": CONFIG.get("map_provider", "jarvis"), "theme": CONFIG.get("map_theme", "auto"),
            "units": DELIVERY.units, "use_gps": CONFIG.get("use_gps", True),
            "google_key": os.environ.get("GOOGLE_MAPS_API_KEY", ""), "apple_token": os.environ.get("APPLE_MAPKIT_TOKEN", "")}

def _nav_cmd(cmd, **kw):
    _broadcast_ws("nav:" + json.dumps({"cmd": cmd, **kw}))

def _nav_origin():
    """Where the driver is: a fresh, accurate browser fix; else the place they told us; else a coarse fix."""
    p = NAV_STATE["pos"]
    if p and time.time() - p["ts"] < 300 and p["acc"] <= 200: return (p["lat"], p["lon"])
    loc = DELIVERY._get_state("loc")
    if loc: return (loc["lat"], loc["lon"])
    if p and p["acc"] <= 5000: return (p["lat"], p["lon"])
    return None

NO_ORIGIN = "I don't know where you are yet. Allow location in the browser, or tell me 'I'm at' and your address."

def _nav_units(cc=""):
    u = nav.resolve_units(NAV.cfg.get("units", "auto"), NAV_STATE.get("cc") or cc)
    DELIVERY.set_units(u)
    return u

def _nav_route(pts, mode):
    return NAV.route(pts, mode, _nav_units(), avoid=NAV_STATE["avoid"])

@app.get("/nav.js")
async def nav_js():
    return FileResponse(os.path.join(_PROJECT_DIR, "nav.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})

@app.get("/nav_core.js")
async def nav_core_js():
    return FileResponse(os.path.join(_PROJECT_DIR, "nav_core.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})

@app.get("/nav/config")
async def nav_config():
    return _nav_cfg()

def _nav_sync_location(lat, lon):
    last = NAV_STATE["synced"]
    if last and nav.haversine_m(last[0], last[1], lat, lon) < 20: return
    NAV_STATE["synced"] = (lat, lon)
    DELIVERY._set_state("loc", {"lat": lat, "lon": lon, "label": "GPS"})
    rv = NAV_STATE["rv"]
    if not rv or nav.haversine_m(rv[0], rv[1], lat, lon) > 4000:     # new town / country: refresh area, country, units
        info = NAV.reverse(lat, lon)
        if info:
            NAV_STATE["rv"] = (lat, lon); NAV_STATE["cc"] = info.get("country_code", "")
            if info.get("area"): DELIVERY._set_state("area", info["area"])
            _nav_units()

@app.post("/nav/position")
async def nav_position(payload: dict):
    try: lat = float(payload["lat"]); lon = float(payload["lon"])
    except Exception: return {"ok": False}
    acc = float(payload.get("acc") or 9999)
    NAV_STATE["pos"] = {"lat": lat, "lon": lon, "acc": acc, "ts": time.time(), "speed": payload.get("speed")}
    if acc <= 200 and CONFIG.get("use_gps", True): await asyncio.to_thread(_nav_sync_location, lat, lon)
    return {"ok": True}

@app.post("/nav/progress")
async def nav_progress(payload: dict):
    payload["ts"] = time.time(); NAV_STATE["progress"] = payload
    return {"ok": True}

@app.post("/nav/ended")
async def nav_ended(payload: dict = None):
    if not NAV_STATE["delivery"]: NAV_STATE.update(active=False, route=None, progress=None)
    return {"ok": True}

def _merge_stops(stops):
    """Neighbouring pickups at the same restaurant become one waypoint (the router rejects zero-length legs)."""
    out = []
    for s in stops:
        lab = s["restaurant"] if s["kind"] == "pickup" else s["short_addr"]
        if out and out[-1]["kind"] == s["kind"] and nav.haversine_m(out[-1]["lat"], out[-1]["lon"], s["lat"], s["lon"]) < 40:
            if lab not in out[-1]["label"]: out[-1]["label"] += " and " + lab
            continue
        out.append({"lat": s["lat"], "lon": s["lon"], "label": lab, "kind": s["kind"]})
    return out

def _nav_build_delivery(origin):
    plan = DELIVERY.plan()
    if not plan.get("ok"): return None, "No active orders to navigate."
    stops = _merge_stops(plan["stops"])
    if nav.haversine_m(origin[0], origin[1], stops[0]["lat"], stops[0]["lon"]) < 50:
        first = stops[0]
        if len(stops) == 1:
            return None, f"You're already at {first['label']}. " + ("Say picked up when you have the order." if first["kind"] == "pickup" else "Say delivered when it's dropped off.")
        stops = stops[1:]                      # standing at the first stop: route onward from here
    pts = [origin] + [(s["lat"], s["lon"]) for s in stops]
    route = _nav_route(pts, "auto")
    if not route["ok"]: return None, route["error"]
    route["waypoints"] = [{"lat": origin[0], "lon": origin[1], "label": "You", "kind": "stop"}] + stops
    return route, stops[0]["label"]

def _nav_start_delivery():
    origin = _nav_origin()
    if not origin: return NO_ORIGIN
    route, info = _nav_build_delivery(origin)
    if route is None: return info
    wps = route["waypoints"]
    NAV_STATE.update(active=True, route=route, label=info, mode="auto", delivery=True, progress=None, view="full",
                     dest=[(w["lat"], w["lon"], w["label"]) for w in wps[1:]])
    _nav_cmd("route", route=route, meta={"label": info, "delivery": True})
    n = len(wps) - 1; units = route["units"]
    first = next((s for s in route["steps"] if not s["icon"].startswith("arrive")), None)
    txt = (f"Navigating to {info}" + (f", then {n - 1} more stop{'s' if n > 2 else ''}" if n > 1 else "") + ". "
           f"{nav.fmt_duration(route['time_s'])} and {nav.fmt_distance(route['distance_m'], units)} for the whole run.")
    return txt + (" " + first["say"] if first and first.get("say") else "")

def _nav_refresh_delivery():
    """The stack changed (picked up, delivered, new order): re-route the screen without making the driver ask."""
    if not (NAV_STATE["active"] and NAV_STATE["delivery"]): return
    try:
        origin = _nav_origin()
        if not DELIVERY.has_active():
            NAV_STATE.update(active=False, route=None, delivery=False, progress=None, view="off")
            _nav_cmd("stop", say="That was the last stop. Navigation ended."); return
        route, info = _nav_build_delivery(origin) if origin else (None, NO_ORIGIN)
        if route is None: print(f"[NAV] delivery refresh: {info}"); return
        wps = route["waypoints"]
        NAV_STATE.update(route=route, label=info, dest=[(w["lat"], w["lon"], w["label"]) for w in wps[1:]], progress=None)
        _nav_cmd("route", route=route, meta={"label": info, "delivery": True, "reroute": False, "view": "keep"})
    except Exception as e: print(f"[NAV] delivery refresh failed: {type(e).__name__}: {e}")

def _nav_resolve(text, origin):
    key = re.sub(r"^(my|the)\s+", "", (text or "").strip().lower())
    p = (CONFIG.get("places") or {}).get(key)
    if p: return {"lat": p["lat"], "lon": p["lon"], "short": key.title(), "display": p.get("address", key), "country_code": p.get("cc", ""), "distance_km": None}
    return NAV.geocode(text, near=origin)

def _nav_start(dest_text, mode="auto"):
    origin = _nav_origin()
    if not origin: return NO_ORIGIN
    g = _nav_resolve(dest_text, origin)
    if not g: return f"I couldn't find {dest_text}. Try the street and the town."
    route = _nav_route([origin, (g["lat"], g["lon"])], mode)
    if not route["ok"]: return route["error"]
    label = (g.get("short") or dest_text).strip() or dest_text
    route["waypoints"] = [{"lat": origin[0], "lon": origin[1], "label": "You", "kind": "stop"},
                          {"lat": g["lat"], "lon": g["lon"], "label": label, "kind": "drop"}]
    NAV_STATE.update(active=True, route=route, label=label, mode=mode, delivery=False, progress=None, view="full",
                     dest=[(g["lat"], g["lon"], label)])
    _nav_cmd("route", route=route, meta={"label": label, "delivery": False})
    txt = nav.Navigator.spoken_summary(route, label)
    if g.get("distance_km") and g["distance_km"] > 150:
        txt = (f"The closest match I found is {g['display'][:70]}, {nav.fmt_distance(g['distance_km'] * 1000, route['units'])} away. " + txt)
    return txt

def _nav_reroute(lat, lon):
    if not NAV_STATE["active"]: return {"ok": False, "error": "Navigation isn't active."}
    NAV_STATE["pos"] = {"lat": lat, "lon": lon, "acc": 10.0, "ts": time.time(), "speed": None}
    if NAV_STATE["delivery"]:
        route, info = _nav_build_delivery((lat, lon))
        if route is None: return {"ok": False, "error": info}
        wps = route["waypoints"]; meta = {"label": info, "delivery": True}
    else:
        d = NAV_STATE["dest"][-1]
        route = _nav_route([(lat, lon), (d[0], d[1])], NAV_STATE["mode"])
        if not route["ok"]: return {"ok": False, "error": route["error"]}
        route["waypoints"] = [{"lat": lat, "lon": lon, "label": "You", "kind": "stop"}, {"lat": d[0], "lon": d[1], "label": d[2], "kind": "drop"}]
        meta = {"label": d[2], "delivery": False}
    NAV_STATE.update(route=route, progress=None)
    return {"ok": True, "route": route, "meta": meta}

@app.post("/nav/reroute")
async def nav_reroute(payload: dict):
    try: lat = float(payload["lat"]); lon = float(payload["lon"])
    except Exception: return {"ok": False, "error": "I need your position to reroute."}
    return await asyncio.to_thread(_nav_reroute, lat, lon)

# -------------------------------------------------------------- tools
@tool("navigate_to",
      "Start turn-by-turn navigation to any address, place, business or landmark anywhere in the world. The screen "
      "turns into a map. Use for 'navigate to', 'take me to', 'directions to', 'drive to', 'walk to'.",
      {"destination": {"type": "string", "description": "address, place name or saved place like home or work"},
       "mode": {"type": "string", "enum": ["driving", "walking", "cycling", "scooter"], "description": "default driving"}},
      ["destination"])
def _navigate_to(destination: str, mode: str = "driving"):
    m = {"walking": "pedestrian", "cycling": "bicycle", "scooter": "motor_scooter"}.get((mode or "").lower(), "auto")
    return _nav_start(destination, m)

@tool("start_delivery_navigation",
      "Start turn-by-turn navigation through every stop of the current delivery stack, in the best order.")
def _start_delivery_navigation():
    return _nav_start_delivery()

@tool("stop_navigation", "End turn-by-turn navigation and bring the face back.")
def _stop_navigation():
    was = NAV_STATE["active"]
    NAV_STATE.update(active=False, route=None, delivery=False, progress=None, dest=[], view="off")
    _nav_cmd("stop")
    return "Navigation ended." if was else "I wasn't navigating."

@tool("navigation_status", "How far, how long, when you arrive, and the next turn, during navigation.")
def _navigation_status():
    if not NAV_STATE["active"] or not NAV_STATE["route"]: return "I'm not navigating right now."
    r, p, now = NAV_STATE["route"], NAV_STATE["progress"], time.time()
    units = r.get("units", "miles")
    if p and now - p["ts"] < 45:
        dist, secs = p["remDist"], p["remTime"]
        nxt = p.get("nextSay") or ""
        tail = f" Next, in {nav.fmt_distance(p['nextDist'], units)}, {nxt[:1].lower() + nxt[1:]}" if nxt and p.get("nextDist", 0) > 0 else ""
    else:
        dist, secs, tail = r["distance_m"], r["time_s"], ""
    return (f"{nav.fmt_duration(secs)} and {nav.fmt_distance(dist, units)} to {NAV_STATE['label'] or 'go'}, "
            f"arriving about {nav.clock(now + secs)}.{tail}")

_MAP_ACTIONS = ["show_map", "mini_map", "hide_map", "zoom_in", "zoom_out", "overview", "recenter", "night", "day", "auto_theme",
                "mute_voice", "unmute_voice", "simulate", "stop_simulation", "use_google", "use_apple", "use_jarvis_map",
                "avoid_highways", "avoid_tolls", "avoid_ferries", "allow_all_roads", "gps_off", "gps_on", "reroute"]

@tool("map_control",
      "Control the map screen: show the full map, a mini map, or hide it (face returns); zoom; route overview; night or day theme; "
      "mute or unmute voice guidance; simulate driving the route; choose the Google, Apple or Jarvis map; avoid highways, tolls or "
      "ferries; turn GPS on or off; find another route.",
      {"action": {"type": "string", "enum": _MAP_ACTIONS}}, ["action"])
def _map_control(action: str):
    a = (action or "").lower()
    if a in ("show_map", "mini_map"):
        c = _nav_origin()
        NAV_STATE["view"] = "full" if a == "show_map" else "mini"
        _nav_cmd("view", mode=NAV_STATE["view"], center=list(c) if c else None)
        return "Here's the map." if a == "show_map" else "Mini map on."
    if a == "hide_map":
        NAV_STATE["view"] = "off"; _nav_cmd("view", mode="off"); return "Map hidden."
    if a in ("zoom_in", "zoom_out"):
        _nav_cmd("zoom", dir="in" if a == "zoom_in" else "out"); return "Okay."
    if a == "overview": _nav_cmd("overview"); return "Showing the whole route."
    if a == "recenter": _nav_cmd("recenter"); return "Back on you."
    if a in ("night", "day", "auto_theme"):
        v = {"night": "night", "day": "day", "auto_theme": "auto"}[a]
        CONFIG["map_theme"] = v; save_config(CONFIG); _nav_cmd("theme", value=v)
        return {"night": "Night map.", "day": "Day map.", "auto": "The map will follow the time of day."}[v]
    if a in ("mute_voice", "unmute_voice"):
        _nav_cmd("voice", on=(a == "unmute_voice")); return "Voice guidance off." if a == "mute_voice" else "Voice guidance on."
    if a == "simulate":
        if not NAV_STATE["active"]: return "Start a route first, then I can drive it for you."
        _nav_cmd("simulate", on=True); return "Simulating the drive."
    if a == "stop_simulation": _nav_cmd("simulate", on=False); return "Simulation stopped."
    if a in ("use_google", "use_apple", "use_jarvis_map"):
        p = {"use_google": "google", "use_apple": "apple", "use_jarvis_map": "jarvis"}[a]
        cfg = _nav_cfg()
        if p == "google" and not cfg["google_key"]:
            return ("The Google map needs a Maps JavaScript API key in the dot env file, as GOOGLE_MAPS_API_KEY. Until then I'll keep my own map. "
                    "I can open any route in the Google Maps app; just say open it in Google Maps.")
        if p == "apple" and not cfg["apple_token"]:
            return ("The Apple map needs a MapKit JS token in the dot env file, as APPLE_MAPKIT_TOKEN. Until then I'll keep my own map. "
                    "I can open any route in Apple Maps; just say open it in Apple Maps.")
        CONFIG["map_provider"] = p; save_config(CONFIG); _nav_cmd("provider", value=p, cfg=_nav_cfg())
        return {"google": "Switching to Google Maps.", "apple": "Switching to Apple Maps.", "jarvis": "Using my own map."}[p]
    if a.startswith("avoid_") or a == "allow_all_roads":
        if a == "allow_all_roads": NAV_STATE["avoid"] = []
        else:
            k = a[6:]
            if k not in NAV_STATE["avoid"]: NAV_STATE["avoid"].append(k)
        txt = ("Okay, " + (" and ".join("avoiding " + x for x in NAV_STATE["avoid"]) if NAV_STATE["avoid"] else "all roads are allowed") + ".")
        if NAV_STATE["active"]:
            p = NAV_STATE["pos"]; c = _nav_origin()
            if c:
                r = _nav_reroute(c[0], c[1])
                if r["ok"]: _nav_cmd("route", route=r["route"], meta={**r["meta"], "reroute": True, "view": "keep"}); txt += " I found a new route."
        return txt
    if a in ("gps_on", "gps_off"):
        CONFIG["use_gps"] = (a == "gps_on"); save_config(CONFIG); _nav_cmd("cfg", cfg={"use_gps": CONFIG["use_gps"]})
        return "Using GPS." if CONFIG["use_gps"] else "GPS off. Tell me where you are when it matters."
    if a == "reroute":
        c = _nav_origin()
        if not NAV_STATE["active"] or not c: return "I'm not navigating."
        r = _nav_reroute(c[0], c[1])
        if not r["ok"]: return r["error"]
        _nav_cmd("route", route=r["route"], meta={**r["meta"], "reroute": True, "view": "keep"}); return "Recalculated."
    return "I can't do that with the map."

def _external_url(app_name, mode, pts):
    """Link that opens the route in the real Google Maps / Apple Maps. pts = [(lat, lon), ...], first = start."""
    a, z = pts[0], pts[-1]
    if app_name == "apple":
        flag = "w" if mode == "pedestrian" else "d"
        return f"https://maps.apple.com/?saddr={a[0]:.6f},{a[1]:.6f}&daddr={z[0]:.6f},{z[1]:.6f}&dirflg={flag}"
    tm = {"auto": "driving", "bicycle": "bicycling", "pedestrian": "walking", "motor_scooter": "two-wheeler"}.get(mode, "driving")
    url = (f"https://www.google.com/maps/dir/?api=1&origin={a[0]:.6f},{a[1]:.6f}&destination={z[0]:.6f},{z[1]:.6f}"
           f"&travelmode={tm}&dir_action=navigate")
    mid = pts[1:-1][:9]
    if mid: url += "&waypoints=" + urllib.parse.quote("|".join(f"{p[0]:.6f},{p[1]:.6f}" for p in mid), safe=",|")
    return url

@tool("open_in_maps_app",
      "Open the route in the real Google Maps or Apple Maps (browser or app) instead of the Jarvis screen. "
      "With no destination it uses the current navigation.",
      {"app": {"type": "string", "enum": ["google", "apple"]}, "destination": {"type": "string"}}, ["app"])
def _open_in_maps_app(app: str = "google", destination: str = ""):
    app_name = "apple" if "apple" in (app or "").lower() else "google"
    origin = _nav_origin(); mode = NAV_STATE["mode"]; extra = ""
    if destination:
        if not origin: return NO_ORIGIN
        g = _nav_resolve(destination, origin)
        if not g: return f"I couldn't find {destination}."
        pts = [origin, (g["lat"], g["lon"])]
    elif NAV_STATE["active"] and origin:
        pts = [origin] + [(d[0], d[1]) for d in NAV_STATE["dest"]]
    else: return "Tell me where to, or start a route first." if origin else NO_ORIGIN
    if app_name == "apple" and len(pts) > 2:
        pts = pts[:2]; extra = " Apple Maps takes one stop at a time, so that's the first stop."
    webbrowser.open(_external_url(app_name, mode, pts))
    return f"Opened it in {'Apple' if app_name == 'apple' else 'Google'} Maps.{extra}"

@tool("save_place", "Remember a named place such as home, work or a warehouse so the driver can say 'navigate home'.",
      {"name": {"type": "string"}, "address": {"type": "string", "description": "street address, or 'here' for the current position"}},
      ["name", "address"])
def _save_place(name: str, address: str):
    origin = _nav_origin()
    if (address or "").strip().lower() in ("here", "this place", "my location", "current location", "where i am"):
        if not origin: return NO_ORIGIN
        info = NAV.reverse(*origin) or {}
        entry = {"lat": origin[0], "lon": origin[1], "address": info.get("display", "here"), "cc": info.get("country_code", "")}
    else:
        g = NAV.geocode(address, near=origin)
        if not g: return f"I couldn't find {address}."
        entry = {"lat": g["lat"], "lon": g["lon"], "address": g["display"], "cc": g.get("country_code", "")}
    key = re.sub(r"^(my|the)\s+", "", name.strip().lower())
    CONFIG.setdefault("places", {})[key] = entry; save_config(CONFIG)
    return f"Saved {key}."

@tool("where_am_i", "Say where the driver is right now.")
def _where_am_i():
    o = _nav_origin()
    if not o: return NO_ORIGIN
    info = NAV.reverse(*o)
    if not info: return "I have your position but can't name the street right now."
    p = NAV_STATE["pos"]
    weak = " My location is only approximate." if (not p or p["acc"] > 200) else ""
    return f"You're near {info['short']}, {info['area']}.".replace(", .", ".") + weak

# ---- voice commands that skip the AI (instant, and they work without Groq)
_NV_STOP = re.compile(r"\b(stop|cancel|end|exit|quit|abort|finish)\b.{0,20}\b(navigat\w*|directions|guidance|route|trip)\b|\bnavigation off\b", re.I)
_NV_TO = re.compile(r"^(?:(?:ok(?:ay)?|please|jarvis|hey|can you|could you)[, ]+)*(?:(?:navigate|drive|route|head|take me|bring me|guide me|walk|cycle|bike|ride)\s+(?:me\s+)?(?:to|towards?)|(?:get|give) me directions to|directions to|(?:i )?(?:need|want) (?:to get|directions) to|let'?s drive to|navigate)\s+(.+?)[.!?]*$", re.I)
_NV_DELIV = re.compile(r"\b(next stop|my (?:next )?(?:stops?|route|deliver\w*|orders?)|the (?:stack|route)|(?:next )?(?:pick.?up|drop.?off|delivery|customer|restaurant)s?)\b", re.I)
_NV_START_DELIV = re.compile(r"^(?:please )?(?:start|begin|resume)\s+(?:the |my )?(?:delivery |route |stack )?(?:navigation|route|run|deliveries)[.!?]*$", re.I)
_NV_SHOW = re.compile(r"^(?:please )?(?:show|open|bring up|display|pull up|turn on)(?: me)?(?: the| a| your)? (?:map|navigation|map view)[.!?]*$|^map (?:view|mode)[.!?]*$", re.I)
_NV_MINI = re.compile(r"^(?:please )?(?:(?:show|open|give me)(?: me)?(?: the| a)? (?:mini ?map|small map)|(?:minimi[sz]e|shrink)(?: the)? map|map (?:in|to) (?:the )?corner)[.!?]*$", re.I)
_NV_HIDE = re.compile(r"^(?:please )?(?:(?:hide|close|dismiss|remove|turn off)(?: the| your)? (?:map|navigation view)|(?:show|bring back|give me back)(?: me)?(?: the| your)? (?:jarvis )?face|face mode)[.!?]*$", re.I)
_NV_ZOOM = re.compile(r"^(?:please )?zoom (in|out)(?: (?:a )?(?:bit|little|more))?[.!?]*$|^(?:closer|zoom closer)[.!?]*$|^(?:farther|further out|zoom farther)[.!?]*$", re.I)
_NV_THEME = re.compile(r"\b(night|dark|day|light|auto(?:matic)?)\s+(?:mode|map|theme)\b", re.I)
_NV_PROV = re.compile(r"\b(?:use|switch to|change (?:it )?to|set|go back to|show (?:me )?)\s*(?:the |your )?(google|apple|jarvis|default|my own|own)\s*(?:maps?|map)\b|\b(google|apple) maps? (?:view|screen|style)\b", re.I)
_NV_EXT = re.compile(r"\bopen (?:it |this |the route |the directions |directions )?(?:in|on|with|using) (google|apple) maps?\b", re.I)
_NV_STATUS = re.compile(r"^(?:how far(?: (?:is it|to go|are we|now))?|how long(?: (?:is it|to go|left|until we arrive))?|how much (?:longer|farther)|when (?:will|do) (?:we|i) (?:get there|arrive)|what'?s my eta|eta|next turn|what'?s the next turn|repeat that|say that again|repeat the (?:direction|instruction)s?)[?.!]*$", re.I)
_NV_MUTE = re.compile(r"\b(?:mute|silence)\b.{0,15}\b(?:voice |spoken )?(?:guidance|directions|navigation)\b|\bturn off (?:the )?(?:voice|spoken) (?:guidance|directions)\b|\bguidance off\b", re.I)
_NV_UNMUTE = re.compile(r"\b(?:unmute|turn on|enable|resume)\b.{0,12}\b(?:voice |spoken )?(?:guidance|directions)\b|\bguidance on\b", re.I)
_NV_SIM = re.compile(r"\b(?:simulate|demo|test)\b.{0,15}\b(?:drive|driving|navigation|route|trip)\b|\bsimulation mode\b", re.I)
_NV_SIM_OFF = re.compile(r"\bstop\b.{0,10}\bsimulat\w+", re.I)
_NV_WHERE = re.compile(r"^(?:where am i|what'?s my location|where are we)[?.!]*$", re.I)
_NV_REROUTE = re.compile(r"\b(?:re-?route|recalculate|find (?:me )?(?:another|a different|an alternate) route)\b", re.I)
_NV_AVOID = re.compile(r"\bavoid(?:ing)? (highways?|freeways?|motorways?|tolls?|ferr(?:y|ies))\b", re.I)
_NV_ALLOW = re.compile(r"\b(?:allow|use|stop avoiding) (?:all roads|highways?|freeways?|tolls?)\b", re.I)
_NV_GPS = re.compile(r"\b(?:turn|switch) (on|off) (?:the |my )?(?:gps|location)\b", re.I)

def _nav_mode_of(t):
    return ("pedestrian" if re.search(r"\b(walk|walking|on foot)\b", t, re.I) else
            "bicycle" if re.search(r"\b(bike|cycle|cycling|bicycle)\b", t, re.I) else
            "motor_scooter" if re.search(r"\b(scooter|moped)\b", t, re.I) else "auto")

def _nav_fastpath(text):
    t = (text or "").strip()
    if not t: return None
    active, shown = NAV_STATE["active"], NAV_STATE["view"] != "off"
    if _NV_MUTE.search(t): return _map_control("mute_voice")
    if _NV_UNMUTE.search(t): return _map_control("unmute_voice")
    if _NV_SIM_OFF.search(t) and (active or shown): return _map_control("stop_simulation")
    if _NV_SIM.search(t): return _map_control("simulate")
    if _NV_STOP.search(t) and (active or shown): return _stop_navigation()
    m = _NV_EXT.search(t)
    if m: return _open_in_maps_app(m.group(1))
    m = _NV_PROV.search(t)
    if m:
        w = (m.group(1) or m.group(2) or "").lower()
        return _map_control("use_google" if w == "google" else "use_apple" if w == "apple" else "use_jarvis_map")
    m = _NV_TO.match(t)
    if m:
        dest = re.sub(r"[, ]+(please|thanks|thank you|now|jarvis)$", "", m.group(1).strip(), flags=re.I).strip()
        return _nav_start(dest, _nav_mode_of(t))
    if _NV_MINI.match(t): return _map_control("mini_map")
    if _NV_HIDE.match(t) and shown: return _map_control("hide_map")
    if _NV_SHOW.match(t): return _map_control("show_map")
    m = _NV_ZOOM.match(t)
    if m and (active or shown):
        return _map_control("zoom_in" if (m.group(1) or "").lower() == "in" or t.lower().startswith(("closer", "zoom closer")) else "zoom_out")
    m = _NV_THEME.search(t)
    if m and (active or shown or re.search(r"\bmap\b", t, re.I)):
        w = m.group(1).lower()
        return _map_control("night" if w in ("night", "dark") else "day" if w in ("day", "light") else "auto_theme")
    if _NV_STATUS.match(t) and active: return _navigation_status()
    if _NV_WHERE.match(t): return _where_am_i()
    if _NV_REROUTE.search(t) and active: return _map_control("reroute")
    m = _NV_AVOID.search(t)
    if m:
        w = m.group(1).lower()
        return _map_control("avoid_tolls" if w.startswith("toll") else "avoid_ferries" if w.startswith("ferr") else "avoid_highways")
    if _NV_ALLOW.search(t) and NAV_STATE["avoid"]: return _map_control("allow_all_roads")
    m = _NV_GPS.search(t)
    if m: return _map_control("gps_on" if m.group(1).lower() == "on" else "gps_off")
    return None



def NAV_STATE_ACTIVE_DELIVERY():
    try: return bool(NAV_STATE["active"] and NAV_STATE["delivery"])
    except NameError: return False

# Fast path: short, unambiguous driving commands skip the LLM (instant, and work without Groq).
_DLV_NEXT = re.compile(r"\b(next stop|where (do i go |to )?next|what.?s next|where am i going)\b", re.I)
_DLV_DONE = re.compile(r"\b(picked (it |them |the \w+ )?up|got (the|my) (food|order)|pick.?up (is )?done|"
                       r"(just )?delivered|dropped (it |them )?off|drop.?off (is )?done|done with (this|that) stop)\b", re.I)
_DLV_PLAN = re.compile(r"\b(plan|re-?plan|optimi[sz]e)\b.*\b(route|stack|deliver\w*)\b|\b(best|my) route\b", re.I)
_DLV_CLEAR = re.compile(r"\b(clear|cancel|reset|wipe)\b.*\b(all )?(my )?(orders|stack|route|deliveries)\b", re.I)
_DLV_EARN = re.compile(r"\b(my earnings|how much (have )?i (made|earned)|earnings (so far|today))\b", re.I)

def _delivery_fastpath(text):
    t = (text or "").strip()
    if not t: return None
    if _DLV_EARN.search(t): return _delivery_earnings()
    if not DELIVERY.has_active(): return None
    if "?" in t or re.match(r"(how|what|when|why|did|have|which|can|should)\b", t, re.I):
        if not (_DLV_NEXT.search(t) or _DLV_PLAN.search(t)): return None
    if _DLV_CLEAR.search(t): return _clear_deliveries()
    if _DLV_DONE.search(t):
        ref = next((o["restaurant"] for o in DELIVERY.active_orders() if o["restaurant"].lower() in t.lower()), "")
        kind = ("pickup" if re.search(r"picked|pick.?up|got (the|my)", t, re.I)
                else "drop" if re.search(r"deliver|dropped|drop.?off", t, re.I) else "")
        return _complete_stop(ref, kind)
    if _DLV_NEXT.search(t): return _next_stop()
    if _DLV_PLAN.search(t): return _plan_deliveries()
    return None

# ============================================================
# FACE ENROLL
# ============================================================
def _enroll_face_tool(name: str, title: str = ""):
    name = (name or "").strip(); title = (title or "").strip()
    if not name: return "I need a name to attach to the face."
    t_low = title.lower().rstrip(".")
    for canon in ("Mr", "Mrs", "Ms", "Miss", "Dr", "Sir"):
        if t_low == canon.lower(): title = canon; break
    rid = secrets.token_hex(4)
    evt = threading.Event()
    _pending_enroll[rid] = {"event": evt, "image_b64": None}
    _broadcast_ws(f"enroll_request:{rid}:{name}:{title}")
    print(f"[FACE] enroll request {rid} for {title} {name}".rstrip())
    if not evt.wait(timeout=20.0):
        _pending_enroll.pop(rid, None)
        return "The camera didn't respond. Make sure the browser tab is open and try again."
    data = _pending_enroll.pop(rid, {})
    img_b64 = data.get("image_b64")
    if not img_b64: return "No image came back from the camera."
    img = _decode_b64_image(img_b64)
    if img is None: return "Couldn't decode the captured image."
    emb = _extract_embedding(img, save_debug=True, label="enroll")
    if emb is None: return "I couldn't find a face. Come closer, face a light, and try again."
    if not db_save_face(name, title, emb): return "Couldn't save the face."
    global conversation
    conversation[0] = {"role": "system", "content": build_system_prompt()}
    who = f"{title} {name}".strip() if title else name
    print(f"[FACE] enroll success: {who}")
    return f"Noted. I'll recognise you as {who}."

# ============================================================
# BRIEFING
# ============================================================
BRIEFING_ENABLED = os.environ.get("JARVIS_BRIEFING", "0") == "1"
BRIEFING_HOUR = int(os.environ.get("JARVIS_BRIEFING_HOUR", "7"))
BRIEFING_MINUTE = int(os.environ.get("JARVIS_BRIEFING_MINUTE", "30"))

def _build_briefing_text():
    parts = [_time_of_day() + "."]
    try:
        cal = _get_calendar("today")
        if cal and "isn't connected" not in cal and "error" not in cal.lower():
            parts.append(cal)
    except Exception: pass
    try:
        import requests
        r = requests.get("https://wttr.in/?format=j1", timeout=5)
        if r.status_code == 200:
            d = r.json()
            cur = d["current_condition"][0]
            desc = cur["weatherDesc"][0]["value"]
            temp = cur["temp_C"]
            parts.append(f"Currently {desc}, {temp} degrees.")
    except Exception: pass
    try:
        news = _news_headlines()
        if news: parts.append(news)
    except Exception: pass
    return " ".join(parts), len(parts) > 1

@tool("morning_briefing", "Deliver the morning briefing: calendar, weather, and news.")
def _morning_briefing():
    text, _ = _build_briefing_text()
    return text

def _briefing_worker():
    last_fired_date = None
    while True:
        try:
            now = datetime.datetime.now()
            today = now.date()
            if (BRIEFING_ENABLED and now.hour == BRIEFING_HOUR and now.minute == BRIEFING_MINUTE
                    and last_fired_date != today):
                last_fired_date = today
                text, has_data = _build_briefing_text()
                if has_data:
                    _broadcast_ws(f"briefing:{text}")
                    print(f"[BRIEFING] fired at {now.strftime('%H:%M')}")
        except Exception as e:
            print(f"[BRIEFING] worker error: {e}")
        time.sleep(30)

# ============================================================
# PROACTIVE
# ============================================================
_last_rain_check = 0
_last_rain_notified = 0
_high_cpu_streak = 0
def _proactive_loop():
    global _last_rain_check, _last_rain_notified, _high_cpu_streak
    while True:
        try:
            for text in db_due_reminders():
                _broadcast_ws(f"proactive:Reminder. {text}")
            try:
                cpu = psutil.cpu_percent(interval=1)
                if cpu > 85: _high_cpu_streak += 1
                else: _high_cpu_streak = 0
                if _high_cpu_streak == 3:
                    _broadcast_ws("proactive:Sir, your CPU has been running hot for several minutes.")
            except Exception: pass
            now = time.time()
            if now - _last_rain_check > 1800:
                _last_rain_check = now
                try:
                    import requests
                    r = requests.get("https://wttr.in/?format=j1", timeout=6)
                    if r.status_code == 200:
                        d = r.json()
                        hours = d["weather"][0]["hourly"][:6]
                        rain_soon = any(int(h.get("chanceofrain", 0)) > 60 for h in hours)
                        if rain_soon and now - _last_rain_notified > 7200:
                            _last_rain_notified = now
                            _broadcast_ws("proactive:Rain likely in the next few hours, sir.")
                except Exception: pass
        except Exception as e: print(f"[PROACTIVE] {e}")
        time.sleep(15)

# ============================================================
# AUDIO WEBSOCKET
# ============================================================
_HALLUCINATIONS = {
    "you", "thank you", "thanks", "please subscribe", "subscribe",
    "thank you for watching", "thank you for watching.",
    ".", "..", "...", "...?", "…",
    "[blank_audio]", "[music]", "[applause]", "[laughter]",
    "♪", "♪♪", "♪ ♪",
    "amara.org", "subtitles by", "transcription by", "subtitle by",
    "please subscribe to my channel",
}
def _is_hallucination(text: str) -> bool:
    t = text.strip().lower()
    if not t: return True
    if t in _HALLUCINATIONS: return True
    if len(t) <= 2 and not any(c.isalnum() for c in t): return True
    if re.sub(r"[^\w\s']", "", t).strip() in _HALLUCINATIONS: return True     # "Thank you." got through with its full stop
    letters = [c for c in t if c.isalpha()]
    if letters and sum(not c.isascii() for c in letters) / len(letters) > 0.15: return True   # Whisper guessing Icelandic etc. from noise
    return False

def _has_speech(a_f32):
    """Silero (bundled with faster-whisper) checks there's a voice in it before it goes to Whisper: room noise made Whisper invent words."""
    try:
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        ts = get_speech_timestamps(a_f32, VadOptions(threshold=0.5, min_speech_duration_ms=200))
        return sum(s["end"] - s["start"] for s in ts) >= 16000 * 0.25
    except Exception as e:
        print(f"[VAD] unavailable ({type(e).__name__}: {e}); sending everything to Whisper")
        return True

STT_BACKEND = os.environ.get("JARVIS_STT", "auto").lower()        # auto | groq | local
GROQ_STT_MODEL = os.environ.get("JARVIS_GROQ_STT_MODEL", "whisper-large-v3-turbo")
STT_PROMPT = ("Hey Jarvis. X-ray mirror, measure my pulse, posture, Gesture mode, globe, zoom in, zoom out, live feeds, webcams, next camera, panels, close the card, check my email, "
              "open panel four, play, stop the music, next song, Billie Eilish, Ed Sheeran, Taylor Swift.")
# what Whisper keeps making of "gesture mode" ("just show mode", "just your mood", "Jarvis show mode", "so no, just show")
_GESTURE_HEARD = re.compile(r"\b(?:just|jess|jester|gesture|gestures|justice|jest|chester|jarvis|chess)[,.]?\s+(?:(?:show|your|no|sure|chair|ya|you)\s+)?(?:mode|mood|mod|mold|moat)\b"
                            r"|\b(?:just|jarvis)[,.]?\s+show[.!?]?$", re.I)
_STT_PROMPT_NORM = re.sub(r"[^a-z ]", "", STT_PROMPT.lower())

def _normalize_pcm(a, target=0.7, max_gain=20.0):
    """Bring a quiet utterance up to a healthy level before transcribing, so nobody has to shout."""
    import numpy as np
    if a.size == 0: return a
    peak = float(np.max(np.abs(a)))
    if peak < 1e-4: return a
    g = min(target / peak, max_gain)
    return a * g if g > 1.0 else a

class _Vad:
    """Speech threshold that adapts to the microphone: a quiet talker is heard, a noisy room isn't over-triggered."""
    MIN_THR = 90.0
    def __init__(self): self.floor = 40.0
    @property
    def threshold(self): return max(self.MIN_THR, self.floor * 3.0)
    def ambient(self, rms): self.floor += (min(float(rms), 600.0) - self.floor) * 0.05

def _wav_bytes(a_f32):
    import numpy as np, io
    pcm = (np.clip(a_f32, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm)
    return bio.getvalue()

def _opus_bytes(a_f32):
    """The clip as Ogg/Opus: ~23x smaller than WAV (6 KB instead of 150 KB for 5 s), so a slow upload line doesn't
    turn a 1 s transcription into 13 s. PyAV ships with faster-whisper. None = can't encode, send WAV."""
    try:
        import av, io, numpy as np
        out = io.BytesIO()
        with av.open(out, "w", format="ogg") as c:
            st = c.add_stream("libopus", rate=16000); st.bit_rate = 24000; st.layout = "mono"
            fr = av.AudioFrame.from_ndarray((np.clip(a_f32, -1, 1) * 32767).astype(np.int16)[None, :], format="s16", layout="mono")
            fr.sample_rate = 16000
            for pk in st.encode(fr): c.mux(pk)
            for pk in st.encode(None): c.mux(pk)
        return out.getvalue()
    except Exception as e:
        print(f"[STT] opus unavailable ({type(e).__name__}); sending WAV"); return None

def _stt_unsure(r, text):
    """Whisper's own confidence: a TV in the background or room noise comes back as made-up words with a low score
    ('Sibir Ghanada Hong Kong'). Those are dropped (and logged, so the bar can be tuned) instead of being answered."""
    segs = getattr(r, "segments", None) or (getattr(r, "model_extra", None) or {}).get("segments") or []
    get = lambda sg, k: sg.get(k) if isinstance(sg, dict) else getattr(sg, k, None)
    lp = [get(sg, "avg_logprob") for sg in segs if get(sg, "avg_logprob") is not None]
    ns = [get(sg, "no_speech_prob") for sg in segs if get(sg, "no_speech_prob") is not None]
    if not lp or not text: return False
    avg, nsp = sum(lp) / len(lp), (max(ns) if ns else 0.0)
    unsure = avg < float(CONFIG.get("stt_min_logprob", -1.0)) or (nsp > 0.6 and avg < -0.6)
    if unsure: print(f"[STT] dropped as unclear (confidence {avg:.2f}, no-speech {nsp:.2f}): {text!r}")
    return unsure

def _stt_groq(a_f32):
    """Groq's hosted Whisper: much more accurate than tiny.en and usually faster than CPU. None = unavailable."""
    if STT_BACKEND == "local" or not _groq_usable(): return None
    if time.time() < GROQ_STATE["stt_skip_until"]: return None
    opus = None if GROQ_STATE.get("no_opus") else _opus_bytes(a_f32)
    upload = ("speech.ogg", opus) if opus else ("speech.wav", _wav_bytes(a_f32))
    GROQ_STATE["stt_bytes"] = len(upload[1])
    for timeout in (6.0, 9.0):      # a slow moment on the line gets one more try (shorter waits: a stuck upload shouldn't hold the answer)
        try:
            cl = groq_client
            try: cl = groq_client.with_options(timeout=timeout, max_retries=0)
            except Exception: pass
            r = cl.audio.transcriptions.create(file=upload, model=GROQ_STT_MODEL,
                                               language="en", prompt=STT_PROMPT, response_format="verbose_json", temperature=0.0)
            text = (getattr(r, "text", None) or "").strip()
            return "" if _stt_unsure(r, text) else text
        except Exception as e:
            if opus and "400" in str(e) and not GROQ_STATE.get("no_opus"):   # Groq refused the format: WAV from now on
                GROQ_STATE["no_opus"] = True; print("[STT] Groq didn't take Opus; using WAV"); return _stt_groq(a_f32)
            if "Timeout" in type(e).__name__ and timeout < 9.0: print("[STT] Groq slow; trying once more"); continue
            if "Connection" in type(e).__name__ and timeout < 9.0:     # usually a one-second blip in the internet: try again before giving up
                time.sleep(1.0); print("[STT] Groq unreachable; trying once more"); continue
            _groq_failed(e)
            # no connection: local Whisper for a short while, unless it's so slow on this PC that waiting for the internet is better
            slow = GROQ_STATE.get("local_rtf", 0) > 2.0
            GROQ_STATE["stt_skip_until"] = time.time() + (15 if "Connection" in type(e).__name__ and not slow else 0)
            print(f"[STT] Groq transcription failed ({type(e).__name__}); using local Whisper" + (" for 15 s." if GROQ_STATE["stt_skip_until"] > time.time() else " this once."))
            return None

def _stt_local(a_f32):
    if WHISPER is None: return ""
    t0 = time.time()
    segs, _ = WHISPER.transcribe(a_f32, language="en", beam_size=1, condition_on_previous_text=False,
                                 vad_filter=False, without_timestamps=True)
    text = " ".join(s.text for s in segs).strip()
    GROQ_STATE["local_rtf"] = (time.time() - t0) / max(0.5, len(a_f32) / 16000)     # > 2: slower than twice real time on this PC
    return text

def transcribe_audio(a_f32):
    t0 = time.time()
    text = _stt_groq(a_f32); src = "groq"
    if text is None: text = _stt_local(a_f32); src = "local"
    if text and len(text) > 25 and re.sub(r"[^a-z ]", "", text.lower()) in _STT_PROMPT_NORM: text = ""   # prompt echoed on silence
    if text:
        text = _GESTURE_HEARD.sub("gesture mode", text)
        text = re.sub(r"^(?:don'?t know|so no|turn of|tone off|done off|turn off)[,.]?\s+gesture mode", "Turn off gesture mode", text, flags=re.I)
        text = re.sub(r"\bpane(?:l|o|lo)?\s*(?:fo|for|four|4)\b(?!\s+(?:the|a|my|your|it)\b)", "panel four", text, flags=re.I)    # "Open Paneofo."
    print(f"[STT] {src} {1000 * (time.time() - t0):.0f} ms for {len(a_f32) / 16000:.1f} s of audio"
          + (f" ({GROQ_STATE.get('stt_bytes', 0) // 1024} KB sent)" if src == "groq" else "") + f": {text!r}")
    return text

@app.websocket("/audio")
async def audio_stream_ws(websocket: WebSocket):
    await websocket.accept()
    if WHISPER is None and groq_client is None:
        try:
            await websocket.send_json({"type": "error", "text": "whisper_unavailable"})
            await websocket.close()
        except Exception: pass
        return
    import numpy as np
    SR = 16000; BPS = 2
    FRAMES_END = 3; MIN_SPEECH = 2            # ~0.4 s of quiet ends an utterance
    MAX_BYTES = SR * BPS * 15
    vad = _Vad()
    buf = bytearray(); sil = 0; spk = 0
    try:
        while True:
            data = await websocket.receive_bytes()
            if not data: continue
            buf.extend(data)
            arr = np.frombuffer(data, dtype=np.int16)
            if arr.size == 0: continue
            rms = float(np.sqrt(np.mean(arr.astype(np.float32) ** 2)))
            if rms > vad.threshold:
                sil = 0; spk += 1
            elif spk == 0:
                vad.ambient(rms)
            else:
                sil += 1
                if spk < MIN_SPEECH and sil >= 2: spk = 0; sil = 0     # a click or cough, not speech
            if spk == 0 and len(buf) > SR * BPS:
                keep = (SR // 3) * BPS; buf = buf[-keep:]
            flush = (spk >= MIN_SPEECH and sil >= FRAMES_END)
            too_long = len(buf) >= MAX_BYTES
            if flush or too_long:
                audio_np = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0
                buf = bytearray(); sil = 0; spk = 0
                if len(audio_np) < SR // 2: continue
                audio_np = _normalize_pcm(audio_np)
                if not await asyncio.to_thread(_has_speech, audio_np): continue
                try:
                    text = await asyncio.to_thread(transcribe_audio, audio_np)
                except Exception as e:
                    print(f"[AUDIO] transcribe failed: {type(e).__name__}: {e}"); continue
                if text and not _is_hallucination(text):
                    try:
                        await websocket.send_json({"type": "transcript", "text": text})
                        await websocket.send_json({"type": "partial", "text": text})
                    except Exception:
                        return                      # page went away mid-reply
    except WebSocketDisconnect: pass
    except Exception as e: print(f"[AUDIO] ws: {type(e).__name__}: {e}")

@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    if WHISPER is None: return {"error": "whisper_unavailable"}
    with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
        tmp.write(await audio.read()); tmp_path = tmp.name
    try:
        segments, _ = WHISPER.transcribe(tmp_path, language="en", beam_size=1,
                                          condition_on_previous_text=False, vad_filter=False)
        text = " ".join(s.text for s in segments).strip()
    except Exception: text = ""
    finally: os.unlink(tmp_path)
    return {"text": text}

# ============================================================
# STREAMING CHAT
# ============================================================
_SUMMARIZING = False
_BG_TASKS = set()

async def _maybe_compress_conversation():
    global conversation, CONVERSATION_SUMMARY, _SUMMARIZING
    if _SUMMARIZING or len(conversation) <= 14: return
    conv = conversation
    head = conv[1:8]
    if not head: return
    prompt = ("Summarise this conversation in two or three short sentences. Focus on facts, "
              "preferences, names, ongoing tasks. Merge with any prior summary.\n\n")
    if CONVERSATION_SUMMARY: prompt += f"Prior summary:\n{CONVERSATION_SUMMARY}\n\n"
    prompt += "New messages:\n"
    for m in head:
        c = (m.get("content") or "").strip()
        if c: prompt += f"{m.get('role')}: {c[:600]}\n"
    def _do():
        if not _groq_usable(): return None
        try:
            r = _groq_create(model=GROQ_MODEL,
                messages=[{"role": "user", "content": prompt}], max_tokens=220)
            return (r.choices[0].message.content or "").strip()
        except Exception as e: print(f"[SUMMARY] {e}"); _groq_failed(e); return None
    _SUMMARIZING = True
    try: summary = await asyncio.to_thread(_do)
    finally: _SUMMARIZING = False
    if not summary or conversation is not conv: return
    CONVERSATION_SUMMARY = summary
    db_save_summary(summary)
    del conv[1:1 + len(head)]          # drop only what was summarised; keep anything said while we were summarising
    conv[0] = {"role": "system", "content": build_system_prompt()}

def _spawn_summary():
    """Summarise in the background so the reply never waits on it."""
    async def _run():
        try: await _maybe_compress_conversation()
        except Exception as e: print(f"[SUMMARY] {e}")
    try:
        t = asyncio.get_running_loop().create_task(_run())
        _BG_TASKS.add(t); t.add_done_callback(_BG_TASKS.discard)
    except RuntimeError: pass

# Only the tools a question could need go with it: all ~75 descriptions are ~4,500 tokens, and Groq's free tier allows 8,000 a minute,
# so sending them every time meant a second question within a minute waited. The last two things he said pick the groups.
_TOOL_CORE = ("get_time", "get_weather", "search_web", "wikipedia", "calculate", "remember")
_PERSONA_WORDS = (r"\b(be|become|act (like|as)|pretend|imitate|impression|impersonat\w*|sound like|talk like|speak like|play(ing)? (the role|as)|you'?re now|"
                  r"in character|stop being|be yourself|back to (normal|jarvis|yourself)|drop the act|that'?s enough)\b")
_TOOL_GROUPS = [
    (_PERSONA_WORDS, ("become", "stop_being")),
    (r"\b(desk|holo ?desk|holodesk|mirror|hologram mode|mirror mode)\b", ("holo_desk",)),
    (r"\b(close|take away|remove|hide|dismiss|clear|get rid of|put away|bring back|card|cards|panels?|floating|your face)\b", ("holo", "globe", "show_public_cam")),
    (r"\b(e-?mails?|gmail|inbox|mail|unread|messages? from)\b", ("gmail", "google_account")),
    (r"\b(google account|connect (my )?google|sign (me )?in|log ?in|disconnect)\b", ("google_account",)),
    (r"\b(time|date|day|clock|timezone|o'?clock|until|how long|countdown|days? (left|to))\b", ("get_time", "time_until")),
    (r"\b(news|headlines?|search|look (it )?up|google|who (is|was)|what (is|was)|wiki\w*|tell me about|happening|going on|latest|current events)\b", ("search_web", "news_headlines", "wikipedia", "fetch_page")),
    (r"\b(url|website|web ?page|link|\.com|\.org)\b", ("fetch_page",)),
    (r"\b(spotify|music|songs?|play|player|track|album|playlist|pause|resume|skip|next|previous|volume|louder|quieter|softer|mute|unmute)\b",
     ("spotify_play", "spotify_pause", "spotify_next", "spotify_previous", "spotify_now_playing", "spotify_devices", "play_music", "connect_spotify", "media_control", "set_volume")),
    (r"\b(open|launch|start|close|minimi[sz]e|maximi[sz]e|window|app)\b", ("open_app", "window_control")),
    (r"\b(lock|screenshot|screen ?shot|screen|look at|what'?s on)\b", ("lock_pc", "take_screenshot", "look_at_screen")),
    (r"\b(cpu|ram|battery|system|computer|laptop|pc|disk|storage)\b", ("system_info",)),
    (r"\b(timer|remind\w*|alarm)\b", ("set_timer", "set_reminder", "list_reminders")),
    (r"\b(remember|recall|forget|memor(y|ies)|know about me)\b", ("remember", "recall", "list_memories", "forget_memory", "forget_all")),
    (r"\b(prefer\w*|always|never|from now on|stop (doing|saying)|don'?t (say|do))\b", ("set_preference", "list_preferences", "forget_preference")),
    (r"\b(notes?|jot)\b", ("take_note", "read_notes")),
    (r"\b(x-?ray|xray|skull|skeleton|anatomy|bones?|brain|muscles?|pulse|heart ?rate|heartbeat|breathing|breaths?|blink\w*|tired|sleepy|posture|slouch\w*|sitting (up|straight)|my scan|vitals?)\b", ("xray_mirror", "vitals")),
    (r"\b(missions?|look into|research|work on|in the background|report back|how'?s (it|that|the \w+) going|progress|what did you find|lessons?|"
     r"what have you learn\w*|you (keep|always|never)|forget (that|the) (rule|lesson))\b|^(yes|yeah|yep|sure|go ahead|do it|please do|ok(ay)?)\b", ("mission", "lessons")),
    (r"\b(speak up|on your own|interrupt\w*|keep (your )?thoughts|stop (talking|suggesting|checking)|glanc\w*|watching me|looking at me)\b", ("inner_voice",)),
    (r"\b(document|documents|pdf|docx|word file|text file|essay|report|article|letter|write (a|me|up))\b",
     ("create_pdf", "create_docx", "create_text_file", "list_documents", "delete_document", "query_documents", "reindex_documents")),
    (r"\b(files?|folders?|clipboard|copied)\b", ("search_files", "list_files", "read_file", "get_clipboard")),
    (r"\b(crypto|bitcoin|btc|eth\w*|sol(ana)?|doge\w*|coin price|price)\b", ("crypto_price",)),
    (r"\b(convert|currency|dollars?|naira|euros?|pounds?|exchange rate|usd|ngn|gbp)\b", ("currency_convert",)),
    (r"\b(translate|in (french|spanish|german|yoruba|igbo|hausa|chinese|japanese|arabic|portuguese|italian))\b", ("translate",)),
    (r"\b(flip|coin|dice|roll|password)\b", ("flip_coin", "roll_dice", "generate_password")),
    (r"\b(cams?|cameras?|webcams?|live|livestreams?|feeds?|world news|news (stations?|channels?|from)|stations?|channels?|tv|sky news|al ?jazeera|nbc|cna|wion|dw|france 24|euronews)\b",
     ("show_public_cam", "holo")),
    (r"\b(voices?|accent)\b", ("list_voices", "set_voice")),
    (r"\b(navigat\w*|directions?|maps?|gps|route|reroute|take me|drive|walk to|how far|eta|where am i|traffic|tolls?|highways?|save (this|it) as|home|work)\b",
     ("navigate_to", "stop_navigation", "navigation_status", "map_control", "open_in_maps_app", "save_place", "where_am_i", "set_my_location")),
    (r"\b(calls?|whatsapp|busy)\b", ("take_calls",)),
    (r"\b(phone|link|unlink|continue|carry on|left off)\b", ("link_phone", "continue_from_phone", "unlink_phone")),
    (r"\b(calendar|schedule|meetings?|appointments?|events?|plan\w*|organi[sz]e|tasks?|to-?dos?|lock it in|dodged|my day|tomorrow|tonight|move|cancel|"
     r"today|implemented|supposed to|going to do|got on|agenda|what'?s (on|up|next))\b",
     ("schedule", "todo", "plan_my_day", "get_calendar", "recap")),
    (r"\b(recap|numbers|stats|how'?s my day|done today|did (i|we) do)\b", ("recap",)),
    (r"\b(brief|briefing|morning report)\b", ("morning_briefing",)),
    (r"\b(globe|earth|world|satellite|how far|distance|night side|city lights|at night|earthquakes?|quakes?|storms?|hurricanes?|typhoons?|cyclones?|iss|space station|aurora|zoom\w*|borders?|provinces?|states?|country|countries|show me|go to|back to you|hologram)\b",
     ("globe",)),
    (r"\b(gestures?|hand control|hands?)\b", ("gesture_mode",)),
    (r"\b(pictures?|images?|photos?|pics?|look like|show me)\b", ("show_images", "holo")),
    (r"\b(panels?|3d|three d|pop out|holo\w*|open (the )?(first|second|third|fourth|fifth|sixth|number|one|two|three|four|five|six)|"
     r"the (first|second|third|fourth|fifth|sixth|last) one|put (them|those|it) away|close (them|those|it)|go back|next|previous|spin (them|it)|turn (them|it))\b", ("holo",)),
]
def _pick_tools(messages, extra=()):
    said = " ".join(str(m.get("content") or "") for m in [m for m in messages if m.get("role") == "user"][-2:]).lower()
    want = set(_TOOL_CORE) | set(extra)
    for pat, names in _TOOL_GROUPS:
        if re.search(pat, said): want.update(names)
    if _persona(): want.add("stop_being")                 # in character: "stop" must always be able to end it
    return [s for s in _TOOL_SCHEMAS if s["function"]["name"] in want]

def _needs_tool(text: str) -> bool:
    t = text.lower().strip()
    if re.search(_PERSONA_WORDS, t) and (re.search(r"\b(be|become|imitate|impression|impersonat\w*|talk like|speak like|sound like|act (like|as)|pretend)\b", t) or _persona()): return True
    if _persona() and re.search(r"\b(stop|enough|normal|yourself|jarvis)\b", t): return True
    if re.search(r'\b(phone|link|unlink|continue|carry on|left off)\b', t): return True    # phone handoff
    if re.search(r'\b(holo ?desk|holodesk|mirror mode|on the desk|the desk)\b', t): return True
    if re.search(r'\b(close|take away|remove|hide|dismiss|clear|get rid of|put away|turn off|stop)\b.*\b(card|cards|panel|panels|this|that|it|them|those|everything|feeds?|globe|window|'
                 r'cameras?|cams?|webcams?|stations?|news|music|player|song)\b'
                 r'|\b(bring back|show) (your|the) face\b|\bzoom\w*\b', t): return True
    if re.search(r'\b(globe|earth|world map|satellite|how far|distance between|night side|city lights|earthquakes?|quakes?|storms?|hurricanes?|typhoons?|cyclones?|iss|space station|aurora|'
                 r'plan|planner|organi[sz]e|tasks?|to-?dos?|lock it in|recap|numbers|gestures?|hand control|back to you|zoom|borders?|provinces?|pictures?|images?|photos?|panels?|3d|pop out|put (them|those) away|close (them|those)|(first|second|third|fourth|fifth|last) one)\b', t): return True
    if re.match(r'^(what|where|when|who|which|whose|why|how|is|are|was|were|'
                r'do|does|did|can|could|would|will|should|tell me|show me|'
                r'give me|find|search|get|list|explain|translate|define|'
                r'remind|remember|set|play|open|close|minimize|maximize|look|brief|calendar|spotify)\b', t):
        return True
    if '?' in text: return True
    if re.search(r'\b(time|date|day|today|tonight|tomorrow|yesterday|week|month|year|hour|minute|am|pm|timezone)\b', t): return True
    if re.search(r'\b(weather|forecast|temperature|rain|snow|news|headline|stock|crypto|bitcoin|ethereum|price|currency|convert|exchange|dollar|naira|euro|pound)\b', t): return True
    if re.search(r'\b(remind|reminder|prefer|preference)\b', t): return True
    if re.search(r'\b(document|documents|my files|my notes|my docs)\b', t): return True
    if re.search(r'\b(screen|my screen|the screen)\b', t): return True
    if re.search(r'\b(calendar|schedule|appointment|meeting|event)\b', t): return True
    if re.search(r'\b(brief|briefing|morning report)\b', t): return True
    if re.search(r'\b(spotify|music|songs?|track|album|playlist|player|pause|resume|skip|next|previous)\b', t): return True
    if re.search(r'\b(volume|louder|quieter|softer|mute|unmute|lock|screenshot|screen ?shot)\b', t): return True
    if re.search(r'\b(calls?|busy)\b', t): return True
    if re.search(r'\b(navigat\w*|directions?|map|maps|gps|route|reroute|zoom|mini ?map|take me|drive to|walk to|how far|eta)\b', t): return True
    if len(t.split()) > 5: return True
    if re.search(r'\d', t): return True
    kws = ["search","look up","google","wikipedia","play","music","note","clipboard","file",
           "calculate","compute","plus","minus","times","divided","email","emails","e-mail","gmail","inbox","mail","unread","google account","sign in","cam","cams","camera","cameras","webcam","webcams","live view","live feed","live feeds","feeds","livestream","live stream",
           "timer","alarm","countdown","flip","coin","dice","roll","password",
           "pdf","document","docx","save","write","article","essay","report",
           "calendar","briefing","brief","spotify","track","song"]
    return any(k in t for k in kws)

def _run_tools_groq(messages):
    called = False
    for _ in range(3):
        try:
            resp = _groq_create(model=GROQ_MODEL, messages=messages,
                max_tokens=3000, tools=_pick_tools(messages), tool_choice="auto",
                parallel_tool_calls=True)
        except Exception as e:
            print(f"[GROQ TOOL CALL] {_why(e)}")
            _groq_failed(e)
            return called, None
        msg = resp.choices[0].message
        if not msg.tool_calls:
            text = (msg.content or "").strip()
            messages.append({"role": "assistant", "content": text})
            return called, text
        called = True
        assistant_msg = {"role": "assistant", "content": msg.content or ""}
        assistant_msg["tool_calls"] = [{"id": tc.id, "type": "function",
            "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in msg.tool_calls]
        messages.append(assistant_msg)
        for tc in msg.tool_calls:
            name = tc.function.name
            try: args = json.loads(tc.function.arguments or "{}")
            except Exception: args = {}
            fn = _TOOL_REGISTRY.get(name)
            result = fn(**args) if fn else f"Unknown tool: {name}"
            print(f"[TOOL] {name} -> {str(result)[:120]}")
            _after_tool(name, args, result)
            messages.append({"role": "tool", "tool_call_id": tc.id, "name": name, "content": str(result)})
    try:
        messages.append({"role": "system", "content":
            "You have enough information. Answer the user now in plain text. Do not call any more tools."})
        resp = _groq_create(model=GROQ_MODEL, messages=messages,
            max_tokens=800, tools=_TOOL_SCHEMAS, tool_choice="none")
        text = (resp.choices[0].message.content or "").strip()
        if text:
            messages.append({"role": "assistant", "content": text})
            return called, text
    except Exception as e:
        print(f"[GROQ TOOL FINAL] {e}")
        _groq_failed(e)
    return called, None

# hud panels (features.py): each tool's result, and long answers, can become 3D panels; the turn number lets one question's results share a ring
_PANEL_HOOKS = {"tool": None, "reply": None}

# ---- memory without "remember": when he says something lasting about himself, the fast model files it in the background.
# Cheap filter first, so only messages that talk about him cost a request. Off with "auto_memory": false in config.json.
_MEMO_HINT = re.compile(r"\b(my|mine|i'?m|i am|i have|i've|i live|i work|i study|i like|i love|i hate|i prefer|i don'?t|call me|"
                        r"i was born|i usually|i always|i never|i'?ll be|we have|our)\b", re.I)
def _auto_remember(user_text):
    t = (user_text or "").strip()
    if CONFIG.get("auto_memory", True) is False or not _groq_usable() or len(t) < 12 or not _MEMO_HINT.search(t): return
    if re.match(r"^\W*(please )?(remember|forget|don'?t remember)\b", t, re.I): return     # the remember/forget tools handle those
    def go():
        try:
            known = db_get_memories(60)
            r = _groq_create(model=GROQ_FAST_MODEL, max_tokens=300, temperature=0, response_format={"type": "json_object"}, messages=[
                {"role": "system", "content":
                    "From the user's message, pick out lasting facts about the user worth remembering in future conversations: name, "
                    "where they live, work or study, family and friends' names, likes and dislikes, projects, routines, devices. "
                    "Not one-off requests, questions, moods or anything about this moment. Never health, money, passwords, ID numbers "
                    "or anything private about other people. Write each as one short sentence about 'the user'. Skip facts already "
                    "known. Reply only with JSON: {\"facts\": [..]} (an empty list when there's nothing).\nAlready known:\n- "
                    + "\n- ".join(known[-60:] or ["(nothing yet)"])},
                {"role": "user", "content": t[:1200]}])
            facts = json.loads(r.choices[0].message.content or "{}").get("facts") or []
            have = {k.strip().lower().rstrip(".") for k in known}
            new = [f.strip() for f in facts if isinstance(f, str) and 6 <= len(f.strip()) <= 200 and f.strip().lower().rstrip(".") not in have][:3]
            for f in new: db_save_memory(f)
            if new:
                conversation[0] = {"role": "system", "content": build_system_prompt()}
                print(f"[MEM] learned: {' | '.join(new)}")
        except Exception as e: print(f"[MEM] auto-memory skipped: {type(e).__name__}: {str(e)[:120]}")
    threading.Thread(target=go, daemon=True).start()
_TURN = {"id": 0, "panels": 0}
def _after_tool(name, args, result):
    h = _PANEL_HOOKS.get("tool")
    if h:
        try: h(name, args, result)
        except Exception as e: print(f"[PANELS] {name}: {type(e).__name__}: {e}")

# When a way of finding something out fails or finds nothing, Jarvis tries the next way before saying anything to him.
_FALLBACK = {"search_web": (("news_headlines", "topic"), ("wikipedia", "query")),
             "news_headlines": (("search_web", "query"),),
             "wikipedia": (("search_web", "query"),)}
_NOTHING = re.compile(r"^(Tool \w+ (failed|got bad)|No results found|No headlines|No wikipedia entry|Unknown tool)", re.I)

def _run_tool(name, args):
    fn = _TOOL_REGISTRY.get(name)
    if not fn: return f"Unknown tool: {name}"
    try: return str(fn(**args))
    except TypeError as e: return f"Tool {name} got bad arguments: {e}"
    except Exception as e: return f"Tool {name} failed: {type(e).__name__}: {e}"

def _exec_tool(name, raw_args):
    try: args = json.loads(raw_args or "{}")
    except Exception: args = {}
    if not isinstance(args, dict): args = {}
    result = _run_tool(name, args)
    if _NOTHING.match(result) and name in _FALLBACK:
        q = str(args.get("query") or args.get("topic") or "").strip()
        for alt, key in _FALLBACK[name]:
            if alt not in _TOOL_REGISTRY: continue
            got = _run_tool(alt, {key: q or "latest news"})
            print(f"[TOOL] {name} found nothing ({result[:80]}); tried {alt} -> {got[:80]}")
            if not _NOTHING.match(got): result = got; break
        else:
            result = "Nothing could be found online for that just now (the search services didn't answer). Say so in a few words and offer to try again."
    print(f"[TOOL] {name} -> {result[:120]}")
    _after_tool(name, args, result)
    return result

# tools whose result is already the sentence to say ("Abuja, sir.", "Playing Bad Blood by Taylor Swift."): said as they are, with no second
# request for the model to reword them. That's a second sooner, and the second request is where gpt-oss kept "calling a tool" and failing.
SAY_AS_IS = {"mission", "lessons", "xray_mirror", "vitals", "inner_voice", "globe", "holo", "show_public_cam", "play_music", "connect_spotify", "holo_desk", "gesture_mode", "window_control", "open_app", "set_volume", "media_control",
             "lock_pc", "take_screenshot", "set_timer", "remember", "forget_memory", "set_preference", "forget_preference", "set_reminder",
             "flip_coin", "roll_dice", "take_note", "set_voice", "map_control", "stop_navigation", "show_images", "google_account",
             "spotify_play", "spotify_pause", "spotify_next", "spotify_previous", "link_phone", "unlink_phone", "take_calls"}

def _stream_groq_tools(messages, scratch):
    """Speed: ONE streaming request per round. The model's words are spoken the moment they arrive, and if
    it asks for tools they run and the next streamed round carries the answer. (The old way waited for the
    whole reply to be written before the first word could be spoken.) Tool messages added to `messages`
    are recorded in `scratch` so the caller can drop them from history afterwards."""
    spoke = False; extra = set()
    for attempt in range(2):
      try:
          # quick asks: one round of tools. Questions that need thought: up to three rounds, so it can look something up, read
          # what it found, check it and dig further before it answers (search -> open the best result -> answer)
          tool_rounds = 1 if _TURN["effort"] == "low" else 3
          for rnd in range(tool_rounds + 1):
              # the big model picks the tools; the fast one writes the answer from their results (its own per-minute allowance,
              # so the second request doesn't wait out the big model's free-tier limit)
              model = GROQ_MODEL if rnd < tool_rounds or GROQ_STATE.get("fast_off") else GROQ_FAST_MODEL
              kw = dict(model=model, messages=messages, stream=True, max_tokens=2000)
              # one round of tools, then the answer from their results with no tool list at all: with the list (even switched off) the fast
              # model re-called tools, invented arguments and said its answer twice; leaving it out also saves ~4,000 tokens a question
              if rnd < tool_rounds: kw.update(tools=_pick_tools(messages, extra), tool_choice="auto", parallel_tool_calls=True)
              text = []; calls = {}
              for chunk in _groq_create(**kw):
                  try: d = chunk.choices[0].delta
                  except Exception: continue
                  c = getattr(d, "content", None) or ""
                  if c:
                      if not text and spoke: c = " " + c.lstrip()       # words before and after a tool: not glued together
                      text.append(c); spoke = True; yield c
                  for tc in (getattr(d, "tool_calls", None) or []):
                      e = calls.setdefault(getattr(tc, "index", 0) or 0, {"id": "", "name": "", "args": ""})
                      if getattr(tc, "id", None): e["id"] = tc.id
                      fn = getattr(tc, "function", None)
                      if fn is not None:
                          if getattr(fn, "name", None): e["name"] = fn.name
                          if getattr(fn, "arguments", None): e["args"] += fn.arguments
              if not calls: return
              if rnd == 0 and not spoke: yield None             # tools are about to run: the caller says "one moment, sir"
              am = {"role": "assistant", "content": "".join(text),
                    "tool_calls": [{"id": calls[i]["id"] or f"call_{i}", "type": "function",
                                    "function": {"name": calls[i]["name"], "arguments": calls[i]["args"] or "{}"}}
                                   for i in sorted(calls)]}
              messages.append(am); scratch.append(am)
              for i in sorted(calls):
                  tm = {"role": "tool", "tool_call_id": calls[i]["id"] or f"call_{i}", "name": calls[i]["name"],
                        "content": _exec_tool(calls[i]["name"], calls[i]["args"])}
                  messages.append(tm); scratch.append(tm)
              ran = [m for m in scratch[-len(calls):]]
              if all(m["name"] in SAY_AS_IS and len(m["content"]) <= 240 and not re.match(r"(Unknown tool|Tool \w+ (got bad|failed))", m["content"]) for m in ran):
                  yield (" " if spoke else "") + " ".join(m["content"] for m in ran); return
          return
      except Exception as e:
        print(f"[GROQ STREAM] {_why(e)}")
        if attempt == 0 and not spoke and not scratch and "parse tool call" in str(e): continue
        # it wanted a tool the word-matching didn't offer ("what are we doing today" -> plan_my_day): offer that one too and ask again
        m = re.search(r"attempted to call tool '([\w-]+)' which was not in request\.tools", str(e))
        if m and attempt == 0 and not spoke and not scratch and m.group(1) in _TOOL_REGISTRY:
            extra.add(m.group(1)); print(f"[GROQ STREAM] adding {m.group(1)} and asking again"); continue
        _groq_failed(e)
        if GROQ_STATE["bad"] or spoke: return
        break
    if scratch:     # tools already ran: ask once more for the answer, without tools
        said = False
        try:
            for chunk in _groq_create(model=GROQ_MODEL, messages=messages, stream=True, max_tokens=1200):
                try:
                    t = chunk.choices[0].delta.content or ""
                    if t: said = True; yield t
                except Exception: continue
        except Exception as e:
            print(f"[GROQ STREAM] retry: {_why(e)}"); _groq_failed(e)
        if not said:   # gpt-oss sometimes insists on calling another tool here ("tool choice is none"): say what the tool said
            short = [m["content"] for m in scratch if m.get("role") == "tool" and 0 < len(m.get("content") or "") <= 300]
            if short: yield " ".join(short)
        return
    yield from _stream_groq_sync(messages, from_tools=True)

def _clean_messages_for_stream(messages):
    out = []
    for m in messages:
        role = m.get("role")
        if role == "tool": continue
        if role == "assistant":
            content = (m.get("content") or "").strip()
            if content: out.append({"role": "assistant", "content": content})
        else: out.append(m)
    return out

def _stream_groq_sync(messages, fast=False, from_tools=False):
    clean = _clean_messages_for_stream(messages)
    fast = fast and not GROQ_STATE.get("fast_off")
    try:
        # small talk: the quick model, and without the 60-odd tool descriptions (they make every request slower)
        stream = _groq_create(model=GROQ_FAST_MODEL, messages=clean, stream=True, max_tokens=600) if fast else _groq_create(
            model=GROQ_MODEL, messages=clean,
            stream=True, max_tokens=2000)
        for chunk in stream:
            try:
                t = chunk.choices[0].delta.content or ""
                if t: yield t
            except Exception:
                continue
        return
    except Exception as e:
        print(f"[GROQ STREAM] attempt 1 fail: {_why(e)}")
        # the chat model reached for a tool ("Zooming on Abuja", "kayisho mi Belgium"): it was a request after all, so do it with tools
        if re.search(r"called a tool|could not be parsed|tool_use_failed|not in request\.tools", str(e), re.I) and _groq_usable() and not from_tools:
            print("[GROQ STREAM] it wanted a tool: answering with tools"); yield from _stream_groq_tools(clean, []); return
        # only a missing model switches the quick one off for good ("model called a tool" used to match and did it by mistake)
        if fast and re.search(r"model_not_found|does not exist|decommission|\b404\b", str(e), re.I):
            GROQ_STATE["fast_off"] = True; print(f"[GROQ] {GROQ_FAST_MODEL} unavailable; small talk uses {GROQ_MODEL}")
        _groq_failed(e)
        if GROQ_STATE["bad"]: return
    clean2 = [m for m in clean if m.get("role") != "system"]
    clean2.insert(0, {"role": "system", "content":
        "Answer the user directly in plain text. Do not call tools. Keep it short."})
    try:
        stream = _groq_create(
            model=GROQ_MODEL, messages=clean2,
            stream=True, max_tokens=2000)
        for chunk in stream:
            try:
                t = chunk.choices[0].delta.content or ""
                if t: yield t
            except Exception:
                continue
    except Exception as e:
        print(f"[GROQ STREAM] attempt 2 fail: {_why(e)}")
        _groq_failed(e)

ACK_PHRASES = ("One moment, sir.", "On it, sir.", "Give me a sec.", "Say less, sir.", "Working on it.")   # said only while a tool runs
FILL_AFTER_S = 1.2
FILL_PHRASES = ("Hmm, let me see.", "Right, one sec.", "Hmm, give me a moment.", "Okay, so...", "Let me think.")
_FILL = object()
async def _paced(sync_iter, delay):
    """The tokens of a reply, with a _FILL marker first when the first one takes longer than `delay` seconds."""
    ait = _async_iter(sync_iter).__aiter__()
    first = asyncio.ensure_future(ait.__anext__())
    done, _ = await asyncio.wait({first}, timeout=delay)
    if not done: yield _FILL
    try: yield await first
    except StopAsyncIteration: return
    async for tok in ait: yield tok

async def _async_iter(sync_iter):
    SENT = object(); it = iter(sync_iter)
    def _next():
        try: return next(it)
        except StopIteration: return SENT
    while True:
        item = await asyncio.to_thread(_next)
        if item is SENT: break
        yield item

SENTENCE_SPLIT = re.compile(r'(?<=[.!?])\s+')
CLAUSE_SPLIT = re.compile(r'(?<=[,;:])\s+')
def _sse(obj): return f"data: {json.dumps(obj)}\n\n"

def _long_cut(buf, limit=200):
    """Where to cut a run-on (an email body, a list with no full stops) so the voice gets it in breaths, not 1,800 characters at once."""
    if len(buf) <= limit + 20: return -1
    cut = max(buf.rfind(", ", 0, limit), buf.rfind("; ", 0, limit), buf.rfind(": ", 0, limit))
    if cut < 60: cut = buf.rfind(" ", 0, limit)
    return cut + 1 if cut > 0 else limit

def _emit_sentences(text: str):
    out = []
    for s in SENTENCE_SPLIT.split(text):
        s = s.strip()
        if s and len(s) >= 2: out.append(s)
    return out

async def stream_chat(user_text: str):
    try:
        print(f"[STREAM] {user_text!r}")
        _TURN["id"] += 1; _TURN["panels"] = 0
        is_voice = bool(_VOICE_HISTORY_BLOCK.search(user_text or ""))
        try:
            conversation.append({"role": "user", "content": user_text})
            if not is_voice: db_save("user", user_text)
        except Exception as e: print(f"[STREAM] record fail: {e}")

        try:
            if _FACE_ENROLL_INTENT.search(user_text) and not _FACE_QUERY_INTENT.search(user_text):
                name, title = _extract_name_title(user_text)
                if not name:
                    reply = "Of course. What should I call you? Say 'my name is Alex' or 'I am Mr Stark'."
                    yield _sse({"type": "sentence", "text": reply}); yield _sse({"type": "done"})
                    conversation.append({"role": "assistant", "content": reply})
                    return
                yield _sse({"type": "status", "text": "thinking"})
                result = await asyncio.to_thread(_enroll_face_tool, name, title)
                yield _sse({"type": "sentence", "text": result}); yield _sse({"type": "done"})
                conversation.append({"role": "assistant", "content": result})
                return
            if _FACE_QUERY_INTENT.search(user_text):
                yield _sse({"type": "status", "text": "thinking"})
                match = await asyncio.to_thread(_identify_from_browser, 8.0)
                if match:
                    fid, name, title, sim = match
                    who = f"{title} {name}".strip() if title else name
                    reply = f"Yes — you're {who}."
                else:
                    faces = db_list_faces()
                    reply = "No face registered yet. Say 'remember my face, I am Mr X'." if not faces else "I don't recognise this face."
                yield _sse({"type": "sentence", "text": reply}); yield _sse({"type": "done"})
                conversation.append({"role": "assistant", "content": reply})
                return
            if _FACE_FORGET_INTENT.search(user_text):
                name, _ = _extract_name_title(user_text)
                if not name:
                    faces = db_list_faces()
                    if len(faces) == 1: name = faces[0][1]
                    elif not faces:
                        reply = "No face stored."
                        yield _sse({"type": "sentence", "text": reply}); yield _sse({"type": "done"}); return
                    else:
                        names = ", ".join(n for _, n, _ in faces)
                        reply = f"Which one? I have {names}."
                        yield _sse({"type": "sentence", "text": reply}); yield _sse({"type": "done"}); return
                n = db_delete_face(name)
                reply = f"Forgotten, {name}." if n else f"No face for {name}."
                yield _sse({"type": "sentence", "text": reply}); yield _sse({"type": "done"})
                try: conversation[0] = {"role": "system", "content": build_system_prompt()}
                except Exception: pass
                return
        except Exception as e:
            print(f"[FACE] handler error: {type(e).__name__}: {e}")
            traceback.print_exc()
            yield _sse({"type": "sentence", "text": f"Face handling error: {e}"}); yield _sse({"type": "done"}); return

        try:
            if _is_voice_utterance(user_text):
                mode = _voice_mode(user_text)
                if mode == "change":
                    mv = _resolve_voice(user_text)
                    result = _set_voice_tool(mv) if mv else "Which voice?"
                else: result = _list_voices_tool()
                yield _sse({"type": "sentence", "text": result}); yield _sse({"type": "done"})
                try: conversation.append({"role": "assistant", "content": result})
                except Exception: pass
                return
        except Exception as e:
            yield _sse({"type": "sentence", "text": f"Voice error: {e}"}); yield _sse({"type": "done"}); return

        try:
            t_low = user_text.lower().strip()
            if re.search(r'\b(morning briefing|brief me|briefing|what.?s my day|what.?s on today)\b', t_low):
                text, has_data = _build_briefing_text()
                if has_data:
                    yield _sse({"type": "sentence", "text": text}); yield _sse({"type": "done"})
                    conversation.append({"role": "assistant", "content": text})
                    return
        except Exception: pass

        try:
            nvr = await asyncio.to_thread(_nav_fastpath, user_text)
            if nvr:
                yield _sse({"type": "status", "text": "thinking"})
                for s in _emit_sentences(nvr): yield _sse({"type": "sentence", "text": s})
                yield _sse({"type": "done"})
                conversation.append({"role": "assistant", "content": nvr})
                return
        except Exception as e: print(f"[NAV] fastpath: {type(e).__name__}: {e}")

        use_tools = _needs_tool(user_text)
        _TURN["effort"] = _effort_for(user_text)
        t_req = time.time(); scratch = []
        if use_tools and _groq_usable():
            yield _sse({"type": "status", "text": "thinking"})

        if GROQ_STATE["bad"] and not GROQ_STATE["announced"]:
            GROQ_STATE["announced"] = True
            yield _sse({"type": "sentence", "text": "Groq rejected my API key, so I'm on the slow local model. Check the key in your dot env file."})

        sync_iter = None
        if _groq_usable():
            try: sync_iter = _stream_groq_tools(conversation, scratch) if use_tools else _stream_groq_sync(conversation, fast=True)
            except Exception as e: print(f"[GROQ STREAM FAIL] {type(e).__name__}: {e}")
        if sync_iter is None:
            try:
                clean = _clean_messages_for_stream(conversation)
                stream = ollama.chat(model=OLLAMA_MODEL, messages=clean, stream=True)
                def _gen():
                    for chunk in stream:
                        t = chunk.get("message", {}).get("content", "") or ""
                        if t: yield t
                sync_iter = _gen()
            except Exception as e:
                yield _sse({"type": "sentence", "text": _no_brain_message()}); yield _sse({"type": "done"}); return

        full_text = ""; buffer = ""; sent_any = False; filled = False
        try:
            async for token in _paced(sync_iter, FILL_AFTER_S):
                if token is _FILL:                   # the first words are slow to come: a quick "hm" so it isn't dead air
                    filled = True; yield _sse({"type": "sentence", "text": random.choice(FILL_PHRASES)}); continue
                if token is None:
                    if filled and not full_text: filled = False; continue     # already said "one sec": don't stack a second filler
                    yield _sse({"type": "sentence", "text": random.choice(ACK_PHRASES)}); continue
                full_text += token; buffer += token
                while True:
                    m = SENTENCE_SPLIT.search(buffer)
                    if not sent_any and (m is None or m.end() > 90) and len(buffer) >= 40:
                        # the first words go to the voice as soon as there's a natural pause: a long first sentence is voiced
                        # in two parts, so he starts talking while the rest is still being voiced
                        c = CLAUSE_SPLIT.search(buffer, 20)
                        if c and c.end() <= 90: m = c
                    if m: end = m.end()
                    else:
                        end = _long_cut(buffer)
                        if end < 0: break
                    s = buffer[:end].strip(); buffer = buffer[end:]
                    if s and len(s) >= 4:
                        if not sent_any: print(f"[LAT] first words {int((time.time() - t_req) * 1000)} ms after your question (tools={'yes' if scratch else 'no'})")
                        sent_any = True
                        yield _sse({"type": "sentence", "text": s})
            if buffer.strip():
                if not sent_any: print(f"[LAT] first words {int((time.time() - t_req) * 1000)} ms after your question (tools={'yes' if scratch else 'no'})")
                while (end := _long_cut(buffer)) > 0:
                    yield _sse({"type": "sentence", "text": buffer[:end].strip()}); buffer = buffer[end:]
                if buffer.strip(): yield _sse({"type": "sentence", "text": buffer.strip()})
        except Exception as e:
            print(f"[STREAM TOKEN] {type(e).__name__}: {e}"); traceback.print_exc()
        if scratch:      # tool plumbing is not kept in history (saves tokens; avoids orphaned tool messages)
            conversation[:] = [m for m in conversation if not any(m is x for x in scratch)]

        if GROQ_STATE["bad"] and not GROQ_STATE["announced"]:
            GROQ_STATE["announced"] = True
            yield _sse({"type": "sentence", "text": "Groq rejected my API key, so I'm on the slow local model. Check the key in your dot env file."})
        if not full_text.strip():
            # Groq gave nothing (bad key, outage, rate limit). Answer from the local model instead of going silent.
            try:
                clean = _clean_messages_for_stream(conversation)
                clean.insert(0, {"role": "system", "content": "Answer briefly in plain text. No tool calls."})
                reply = await asyncio.to_thread(lambda: ollama.chat(
                    model=OLLAMA_MODEL, messages=clean,
                    options={"num_predict": 400}).get("message", {}).get("content", ""))
                if reply:
                    full_text = reply.strip()
                    for s in _emit_sentences(full_text):
                        yield _sse({"type": "sentence", "text": s})
            except Exception as e2:
                print(f"[OLLAMA FALLBACK] {e2}")
        if not full_text.strip():
            yield _sse({"type": "sentence", "text": _no_brain_message()})

        try:
            if full_text.strip():
                conversation.append({"role": "assistant", "content": full_text})
                if not _VOICE_HISTORY_BLOCK.search(full_text or ""): db_save("assistant", full_text)
        except Exception: pass
        _auto_remember(user_text)
        if full_text.strip() and _PANEL_HOOKS.get("reply"):
            try: _PANEL_HOOKS["reply"](user_text, full_text)
            except Exception as e: print(f"[PANELS] reply: {e}")
        try: _handoff_push()                     # the phone can carry on from here
        except Exception as e: print(f"[HANDOFF] {e}")
        _spawn_summary()
        yield _sse({"type": "done"})
    except Exception as e:
        print(f"[STREAM FATAL] {type(e).__name__}: {e}"); traceback.print_exc()
        try:
            yield _sse({"type": "sentence", "text": f"Internal error: {type(e).__name__}"}); yield _sse({"type": "done"})
        except Exception: pass

@app.post("/chat_stream")
async def chat_stream(payload: dict):
    user_text = (payload.get("text") or "").strip()
    if not user_text:
        async def _empty(): yield _sse({"type": "done"})
        return StreamingResponse(_empty(), media_type="text/event-stream")
    hdrs = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    note = _take_fish_key(user_text)
    if note:
        async def _saved(): yield _sse({"type": "sentence", "text": note}); yield _sse({"type": "done"})
        return StreamingResponse(_saved(), media_type="text/event-stream", headers=hdrs)
    if payload.get("interrupted"):                   # he talked over the last reply: the model should know it wasn't all heard
        for m in reversed(conversation):
            if m.get("role") == "assistant" and isinstance(m.get("content"), str):
                if "(he cut in" not in m["content"]: m["content"] += " (he cut in before you finished this)"
                break
            if m.get("role") == "user": break
    if payload.get("followup") and not _plainly_for_me(user_text):
        if _harmless_chat(user_text):
            # small talk: the "was that for me?" check and the answer run side by side; the words are only let out once it says yes
            return StreamingResponse(_sir_tamed(_gated_stream(user_text)), media_type="text/event-stream", headers=hdrs)
        if not await asyncio.to_thread(_meant_for_me, user_text):      # it would do something (a tool): ask first, act after
            print(f"[HEARD] not for Jarvis (lyrics, TV or someone else): {user_text!r}")
            async def _ignored():
                yield _sse({"type": "ignored"}); yield _sse({"type": "done"})
            return StreamingResponse(_ignored(), media_type="text/event-stream")
    try: _MIND["heard"](user_text)
    except Exception as e: print(f"[MIND] heard: {e}")
    return StreamingResponse(_sir_tamed(stream_chat(user_text)), media_type="text/event-stream", headers=hdrs)

def _harmless_chat(text):
    """Nothing but talk: no tool, no face or voice change. Safe to start answering before we know it was said to him."""
    return not (_needs_tool(text) or _FACE_ENROLL_INTENT.search(text) or _FACE_QUERY_INTENT.search(text)
                or _FACE_FORGET_INTENT.search(text) or _is_voice_utterance(text))

async def _gated_stream(user_text):
    t0 = time.time()
    check = asyncio.create_task(asyncio.to_thread(_meant_for_me, user_text))
    n0 = len(conversation); q = asyncio.Queue()
    async def pump():
        try:
            async for ev in stream_chat(user_text): await q.put(ev)
        except Exception as e: print(f"[HEARD] gated stream: {type(e).__name__}: {e}")
        finally: await q.put(None)
    pumping = asyncio.create_task(pump())
    if not await check:
        print(f"[HEARD] not for Jarvis (lyrics, TV or someone else): {user_text!r}")
        yield _sse({"type": "ignored"}); yield _sse({"type": "done"})
        await pumping                                   # let the unwanted answer finish quietly, then take it back out of the history
        mine = conversation[n0:]
        conversation[:] = [m for m in conversation if not any(m is x for x in mine)]
        return
    print(f"[LAT] follow-up check took {int((time.time() - t0) * 1000)} ms (the answer was already on its way)")
    try: _MIND["heard"](user_text)
    except Exception as e: print(f"[MIND] heard: {e}")
    while (ev := await q.get()) is not None: yield ev

def _meant_for_me(text):
    """An open-mic line said without "Hey Jarvis": was it said to him, or is it song lyrics, the TV, someone on the phone?
    One tiny question to the fast model; when unsure (or it can't be asked) it counts as meant for him."""
    if _plainly_for_me(text): return True
    last = next((m.get("content") or "" for m in reversed(conversation) if m.get("role") == "assistant" and isinstance(m.get("content"), str)), "")
    return _ask_meant_for_me(text, last)

def _plainly_for_me(text):
    if not _groq_usable(): return True
    # a question, or something said like a request, is for him (lyrics and presenters seldom start "can you" or end in a question mark)
    return bool("?" in text or re.match(r"\s*(ok(ay)?|please|so|and|now|can|could|would|will|what|where|when|who|how|why|is|are|do|does|did|show|open|close|"
                                 r"play|stop|pause|next|tell|give|find|zoom|go|turn|take|bring|put|clear|check|read|let'?s|i (want|need|would like))\b", text, re.I))

def _ask_meant_for_me(text, last):
    try:
        cl = groq_client
        try: cl = groq_client.with_options(timeout=3.0, max_retries=0)
        except Exception: pass
        r = cl.chat.completions.create(model=GROQ_FAST_MODEL, temperature=0, max_tokens=200, **({} if GROQ_STATE.get("no_effort") else {"reasoning_effort": "low"}),
            messages=[{"role": "system", "content": "A voice assistant's microphone heard the line below in a room where music, TV or other people may "
                       "be audible. Decide if the person was talking TO the assistant (a request, a question, a reply to what it last said, "
                       "thanks) or if it's background: song lyrics, a TV or video, someone talking to somebody else. Answer with one word: yes "
                       "(meant for the assistant) or no (background). If unsure, yes."},
                      {"role": "user", "content": f"The assistant last said: {last[:300]!r}\nHeard: {text!r}"}])
        return not re.match(r"\s*no\b", (r.choices[0].message.content or "").lower())
    except Exception as e:
        print(f"[HEARD] check skipped: {type(e).__name__}"); return True

# ============================================================
# ROUTES
# ============================================================
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_clients.add(websocket)
    try:
        while True: await websocket.receive_text()
    except WebSocketDisconnect: pass
    finally: ws_clients.discard(websocket)

@app.post("/wake")
async def wake():
    dead = set()
    for c in ws_clients:
        try: await c.send_text("wake")
        except Exception: dead.add(c)
    ws_clients.difference_update(dead)
    return {"ok": True, "sent_to": len(ws_clients)}

@app.post("/vision_capture/{rid}")
async def vision_capture(rid: str, payload: dict = Body(...)):
    pending = _pending_vision.get(rid)
    if not pending: return {"ok": False, "error": "no such request"}
    pending["image_b64"] = payload.get("image", ""); pending["event"].set()
    return {"ok": True}

@app.post("/enroll_face_ws/{rid}")
async def enroll_face_ws(rid: str, payload: dict = Body(...)):
    pending = _pending_enroll.get(rid)
    if not pending: return {"ok": False, "error": "no such request"}
    pending["image_b64"] = payload.get("image", ""); pending["event"].set()
    return {"ok": True}

@app.post("/identify_ws/{rid}")
async def identify_ws(rid: str, payload: dict = Body(...)):
    pending = _pending_identify.get(rid)
    if not pending: return {"ok": False, "error": "no such request"}
    pending["image_b64"] = payload.get("image", ""); pending["event"].set()
    return {"ok": True}

@app.post("/identify_face")
async def identify_face(payload: dict = Body(...)):
    img_b64 = payload.get("image", "")
    if not img_b64: return {"ok": False, "error": "no image"}
    img = _decode_b64_image(img_b64)
    if img is None: return {"ok": False, "error": "could not decode image"}
    match = _identify_face(img)
    if match is None:
        await asyncio.to_thread(_guess_address, img)        # only does anything while no face is saved
        return {"ok": True, "recognized": False, "address": _address()}
    fid, name, title, sim = match
    return {"ok": True, "recognized": True, "name": name, "title": title or "", "similarity": sim}

@app.post("/enroll_face_direct")
async def enroll_face_direct(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    title = (payload.get("title") or "").strip()
    img_b64 = payload.get("image", "")
    if not name: return {"ok": False, "error": "name required"}
    img = _decode_b64_image(img_b64)
    if img is None: return {"ok": False, "error": "could not decode image"}
    emb = _extract_embedding(img, save_debug=True, label="enroll_direct")
    if emb is None: return {"ok": False, "error": "no face detected"}
    if not db_save_face(name, title, emb): return {"ok": False, "error": "save failed"}
    global conversation
    conversation[0] = {"role": "system", "content": build_system_prompt()}
    return {"ok": True, "name": name, "title": title}

@app.post("/call/said")
async def call_said():
    _CALLS["said"].set(); return {"ok": True}

_AMBIENT = {"weather": None, "weather_at": 0.0}
@app.get("/ambient")
async def ambient():
    """The corner card: the weather here (looked up every half hour) and what Spotify is playing, when Spotify is set up."""
    def work():
        if time.time() - _AMBIENT["weather_at"] > 1800:
            _AMBIENT["weather_at"] = time.time()
            try:
                import requests
                c = requests.get("https://wttr.in/?format=j1", timeout=6).json()["current_condition"][0]
                _AMBIENT["weather"] = {"f": int(c["temp_F"]), "c": int(c["temp_C"]), "desc": c["weatherDesc"][0]["value"].strip()}
            except Exception as e: print(f"[AMBIENT] weather: {type(e).__name__}")
        playing = None
        if SPOTIFY_CLIENT_ID and os.path.exists(".spotify_cache"):     # not set up: don't ask (and don't fill the log) every 20 s
            try:
                sp = _spotify(); pb = sp.current_playback() if sp else None
                if pb and pb.get("is_playing") and pb.get("item"):
                    playing = {"title": pb["item"]["name"], "artist": ", ".join(a["name"] for a in pb["item"].get("artists", []))}
            except Exception: pass
        return {"weather": _AMBIENT["weather"], "playing": playing}
    return await asyncio.to_thread(work)

@app.get("/faces")
async def faces_endpoint():
    return {"faces": [{"id": i, "name": n, "title": t} for i, n, t in db_list_faces()]}

# ---- first launch: no Groq key yet. The page shows a setup screen; the key is checked with Groq, then saved to .env.
@app.get("/setup/status")
async def setup_status():
    return {"need_key": not _groq_usable()}

@app.post("/setup/key")
async def setup_key(payload: dict = Body(...)):
    global GROQ_API_KEY, groq_client
    key = ((payload.get("key") or "").strip().strip('"').strip("'").split() or [""])[0]
    if not key.startswith("gsk_") or len(key) < 20:
        return {"ok": False, "error": "That doesn't look like a Groq key. They start with gsk_ and are about 56 characters."}
    try:
        from groq import Groq
        client = Groq(api_key=key)
        await asyncio.to_thread(client.models.list)
    except Exception as e:
        return {"ok": False, "error": "Groq didn't accept that key. Copy it again from the Groq page." if _groq_is_auth_error(e)
                else "Couldn't reach Groq. Check the internet connection and try again."}
    path = os.path.join(_PROJECT_DIR, ".env")
    lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f: lines = [l.rstrip("\n") for l in f if not l.strip().startswith("GROQ_API_KEY=")]
    with open(path, "w", encoding="utf-8") as f: f.write("\n".join(lines + [f"GROQ_API_KEY={key}"]) + "\n")
    os.environ["GROQ_API_KEY"] = key; GROQ_API_KEY = key; groq_client = client; GROQ_STATE["bad"] = False
    print(f"[SETUP] Groq key saved (ends ...{key[-4:]}).")
    return {"ok": True}

@app.get("/")
async def root():
    with open("index.html", encoding="utf-8") as f: return HTMLResponse(f.read())

def _guess_address(img_bgr):
    if _GUESS["address"] or _GUESS["tries"] >= 3 or db_list_faces(): return
    _GUESS["tries"] += 1
    try:
        import cv2
        ok, jpg = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok: return
        a = (_describe_image("data:image/jpeg;base64," + base64.b64encode(jpg.tobytes()).decode(),
             "This is a webcam frame of the person using this computer. To greet them as sir or ma'am, is the person facing the camera "
             "a man or a woman? Reply with one word: man, woman, or unsure (no clear face, or you can't tell).") or "").lower()
    except Exception as e: print(f"[GREET] {type(e).__name__}: {e}"); return
    if not a: return                      # the vision model couldn't be reached: no answer isn't "can't tell"
    guess = "ma'am" if re.search(r"\bwoman\b|\bfemale\b", a) else "sir" if re.search(r"\bman\b|\bmale\b", a) else ""
    if guess or _GUESS["tries"] >= 3: _GUESS["address"] = guess or "none"
    print(f"[GREET] the camera says {a[:20]!r}: calling them {_GUESS['address'] or '(try again)'}")
    if guess: conversation[0] = {"role": "system", "content": build_system_prompt()}

@app.get("/address")
async def address(): return {"address": _address()}

@app.get("/greeting")
async def greeting(name: str = "", title: str = ""):
    tod = _time_of_day()
    name = (name or "").strip()
    title = (title or "").strip()
    addr = _address()
    if name:
        honorific = f"{title} {name}".strip() if title else name
        opening = f"{tod}, {honorific}."
    elif addr in ("sir", "ma'am"):
        opening = f"{tod}, {addr}."
    else:
        opening = f"{tod}."
    return {"text": opening, "name": name, "title": title, "time_of_day": tod}

@app.get("/briefing")
async def briefing():
    text, has_data = _build_briefing_text()
    return {"text": text, "has_data": has_data}

@app.post("/see")
async def see(payload: dict):
    img_b64 = payload.get("image", "")
    prompt = payload.get("prompt", "Briefly describe what you see.")
    if not img_b64: return {"reply": "No image."}
    try:
        raw = base64.b64decode(img_b64.split(",")[-1])
        tmp = tempfile.mktemp(suffix=".png")
        with open(tmp, "wb") as f: f.write(raw)
        try:
            reply = ollama.chat(model=OLLAMA_VISION_MODEL, messages=[{"role": "user", "content": prompt, "images": [tmp]}])["message"]["content"]
        except Exception as e: print(f"[VISION] {e}"); reply = "Couldn't analyse."
        finally: os.unlink(tmp)
    except Exception as e: reply = f"Couldn't process: {e}"
    db_save("user", "[screenshot]"); db_save("assistant", reply)
    return {"reply": reply}

_TTS_LOCK = threading.Lock()
_TTS_CACHE = {}         # short phrases said again and again ("One moment, sir."): kept, so they play at once
class _FairLock:
    """A lock taken strictly in the order it was asked for (a plain Lock lets whoever is quickest jump the queue)."""
    def __init__(self): self._c = threading.Condition(); self._next = 0; self._serving = 0
    def __enter__(self):
        with self._c:
            me = self._next; self._next += 1
            while me != self._serving: self._c.wait()
    def __exit__(self, *a):
        with self._c: self._serving += 1; self._c.notify_all()
_TTS_TURN = _FairLock()

def _synth_cached(text, voice):
    key = (text, voice or CONFIG.get("voice"))
    if key in _TTS_CACHE: return _TTS_CACHE[key]
    out = _synth_blocking(text, voice)
    if out[0] and len(text) <= 40:
        if len(_TTS_CACHE) > 64: _TTS_CACHE.pop(next(iter(_TTS_CACHE)))
        _TTS_CACHE[key] = out
    return out

def _prewarm_acks():
    time.sleep(40)                          # after start-up has settled
    for p in ACK_PHRASES:
        try: _synth_cached(p, CONFIG.get("voice"))
        except Exception: pass
threading.Thread(target=_prewarm_acks, daemon=True).start()

# Spoken sounds and stage directions, made right for each voice. The offline voices spell out "hm" and "mm" as letters
# (H-M, M-M) and read "[warm]" aloud; the cloud voice (Orpheus) acts on "[warm]"-style directions and says the sounds properly.
_DIRECTION = re.compile(r"\[([A-Za-z][A-Za-z \-]{1,28})\]\s*")
_STAGE = re.compile(r"[*(]\s*(laughs?|laughing|chuckles?|chuckling|giggles?|sighs?|sighing|smiles?|grins?)\s*[*)]", re.I)
def _voice_text(text, engine):
    t = text or ""
    if engine == "orpheus":
        t = _STAGE.sub(lambda m: "[" + {"laug": "laughing", "chuc": "chuckling", "gigg": "giggling", "sigh": "sigh"}.get(m.group(1).lower()[:4], "warm") + "] ", t)
        t = re.sub(r"\b[Hh]m{1,}\b", "Hmm", t); t = re.sub(r"\b[Mm]{2,}\b", "Mmm", t)
        t = re.sub(r"\b(?:[Mm]-?hm+|[Mm]m-hm+|[Mm]hmm)\b", "Mm-hmm", t)
    else:
        t = _STAGE.sub(lambda m: "Ha! " if m.group(1).lower()[:4] in ("laug", "chuc", "gigg") else "", t)
        t = _DIRECTION.sub("", t)
        t = re.sub(r"\b(?:[Mm]-?hm+|[Mm]m-hm+|[Mm]hmm|[Uu]h-hm+)\b", "Hmm-hmm", t)           # agreeing
        t = re.sub(r"\b[Hh]m+\b", "Hmm", t); t = re.sub(r"\b[Mm]{2,}\b", "Hmm", t)           # thinking
        t = re.sub(r"\b(?:[Pp]ff+t?|[Pp]sh+|[Tt]sk)\b[,.!]?\s*", "", t)                        # sounds no voice can make: dropped
    return re.sub(r"\s{2,}", " ", t).strip()

def _synth_blocking(text, voice):
    # Kokoro on this PC by default: no network wait, no daily quota. "voice_engine": "orpheus" or "elevenlabs" in config.json brings a cloud voice back.
    engine = CONFIG.get("voice_engine", "kokoro")
    el = synth_elevenlabs(_voice_text(text, "elevenlabs")) if engine == "elevenlabs" else None
    if el: return el, "audio/mpeg"
    use_groq = engine == "orpheus" or str(voice or CONFIG.get("voice") or "").startswith("groq-")
    if _persona():                                                       # a character: their own voice (Fish Audio)
        fish = synth_fish(_voice_text(text, "offline"))
        if fish: return fish, "audio/mpeg"
    nat = synth_orpheus(_voice_text(text, "orpheus"), voice) if use_groq else None      # network call: outside the Piper lock
    if nat: return nat, ("audio/wav" if nat[:4] == b"RIFF" else "audio/mpeg")
    with _TTS_TURN:                      # the phonemiser isn't thread-safe; one voice job at a time, oldest first, so the first sentence never waits behind the third
        off = _voice_text(text, "offline")
        wav = (synth_kokoro(off, voice) or synth_piper(off, voice)) if off else None   # Groq out or offline: Kokoro, like the phone, then Piper
    return (wav, "audio/wav") if wav else (None, None)

_BUSY_LOGGED = {"at": 0.0}
def _log_busiest():
    """Which programs had the processor when the voice was slow (at most once a minute)."""
    if time.time() - _BUSY_LOGGED["at"] < 60: return
    _BUSY_LOGGED["at"] = time.time()
    procs = list(psutil.process_iter(["name"]))
    for p in procs:
        try: p.cpu_percent(None)
        except Exception: pass
    time.sleep(1.0)
    use = {}
    for p in procs:
        try: use[p.info["name"]] = use.get(p.info["name"], 0) + p.cpu_percent(None)
        except Exception: pass
    top = sorted(use.items(), key=lambda kv: -kv[1])[:4]
    cores = psutil.cpu_count() or 1
    print("[BUSY] " + ", ".join(f"{n} {v / cores:.0f}%" for n, v in top if v > 0))

def _speakable(text):
    """What the voice should actually say. The voices read a stray full stop out loud as "dot": a piece that's only punctuation
    (". " left over between two sentences), sentences glued together ("Done.Next"), "..." and markdown symbols."""
    t = re.sub(r"\*\s*([A-Za-z]+)\s*\*", lambda m: f"({m.group(1)})" if re.fullmatch(r"(?i)laughs?|laughing|chuckles?|chuckling|giggles?|sighs?|sighing|smiles?|grins?", m.group(1)) else m.group(1), text or "")   # *laughs* is a stage direction, not markdown
    t = re.sub(r"[*_#`~|>]+", " ", t)                              # markdown
    t = re.sub(r"\.{2,}|…", ", ", t)                                # a pause, not "dot dot dot"
    t = re.sub(r"(?<=[a-z\)])\.(?=[A-Z])", ". ", t)                  # "Done.Next" -> "Done. Next" (gmail.com, 1.5 and U.S. are left alone)
    t = re.sub(r"(?<=\w)\s+\.(?=\s|$)", ".", t)                        # "answer . Sure": the stop belongs to the word before
    t = re.sub(r"(?<=[\s(])\.(?=\s|$)", " ", t)                      # a full stop on its own
    t = re.sub(r"^[\s.,;:!?\-]+", "", t)                              # leftovers at the start
    t = re.sub(r"\s+([.,!?;:])", r"\1", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    return t if re.search(r"[A-Za-z0-9]", t) else ""

@app.post("/speak")
async def speak(payload: dict):
    text = _speakable((payload.get("text") or "").strip())
    if not text: return Response(status_code=204)
    t0 = time.time()
    audio, media = await asyncio.to_thread(_synth_cached, text, CONFIG.get("voice"))
    ms = int((time.time() - t0) * 1000)
    print(f"[LAT] voice {ms} ms for {len(text)} chars" + (f" (computer {psutil.cpu_percent():.0f}% busy)" if ms > 3000 else ""))
    if ms > 3000: threading.Thread(target=_log_busiest, daemon=True).start()
    if audio: return Response(content=audio, media_type=media)
    return Response(status_code=204)

@app.get("/download/{filename}")
async def download(filename: str):
    safe_name = _safe_filename(filename); path = DOCS_DIR / safe_name
    if not path.exists(): return Response(status_code=404, content="Not found")
    return FileResponse(str(path), filename=safe_name, media_type="application/octet-stream")

@app.get("/documents")
async def documents():
    files = sorted(f.name for f in DOCS_DIR.iterdir() if f.is_file())
    return {"folder": str(DOCS_DIR), "files": files}

@app.get("/perf")
async def perf_mode():
    return {"mode": CONFIG.get("perf", "full")}

@app.get("/voices")
async def list_voices():
    return [{"id": v, "name": fn} for v, fn in _voice_pairs()]

@app.get("/get_voice")
async def get_voice():
    return {"voice": CONFIG.get("voice"), "friendly": _friendly_name(CONFIG.get("voice") or "")}

@app.post("/set_voice")
async def set_voice(payload: dict):
    voice = payload.get("voice")
    if voice and voice in VOICES:
        CONFIG["voice"] = voice; save_config(CONFIG)
        return {"ok": True, "voice": voice, "friendly": _friendly_name(voice)}
    return {"ok": False, "error": "invalid voice"}

# ---- Phone <-> PC handoff through the Jarvis service (server/worker.js in the Android project; the phone's side is handoff.js)
HANDOFF_SERVICE = os.environ.get("JARVIS_SERVICE", "").rstrip("/")   # the shared app has no phone service: set JARVIS_SERVICE to turn handoff on
_HAND = {"last": 0.0}

def _ago(ms):
    m = round(ms / 60000)
    return "just now" if m < 1 else f"{m} minute{'s' if m != 1 else ''} ago" if m < 60 else f"{round(m / 60)} hour{'s' if m >= 90 else ''} ago" if m < 1440 else "more than a day ago"

@tool("link_phone", "Link this PC with the user's phone Jarvis, using the 6-digit code the phone gave (the user says 'link code ...').",
      {"code": {"type": "string", "description": "the six digits, as digits"}}, ["code"])
def _link_phone(code: str):
    import requests
    digits = re.sub(r"\D", "", str(code))
    if len(digits) != 6: return "I need the six-digit code your phone gave you."
    r = requests.post(f"{HANDOFF_SERVICE}/link/claim", json={"code": digits}, timeout=10)
    if r.status_code == 404: return "That code is wrong or has expired. Ask your phone to link again."
    if r.status_code != 200: return "The Jarvis service didn't answer just now. Try again in a minute."
    CONFIG["handoff_pair"] = r.json()["pair"]; save_config(CONFIG)
    return "Linked with your phone. Say 'continue from my phone' whenever you switch over."

@tool("continue_from_phone", "Pick up the conversation the user was having with their phone Jarvis.")
def _continue_from_phone():
    import requests
    pair = CONFIG.get("handoff_pair")
    if not pair: return "This PC isn't linked to your phone yet. On the phone, say 'link my PC', then tell me the code."
    r = requests.get(f"{HANDOFF_SERVICE}/hand/{pair}?from=phone", timeout=10)
    if r.status_code == 404: CONFIG.pop("handoff_pair", None); save_config(CONFIG); return "The link with your phone has expired. On the phone, say 'link my PC' again."
    if r.status_code != 200: return "I couldn't reach the Jarvis service just now."
    hand = r.json(); lines = hand.get("messages") or []
    if not lines: return "There's nothing from your phone yet."
    convo = "\n".join(f"{'User' if m.get('role') == 'user' else 'Jarvis'}: {m.get('content', '')}" for m in lines[-8:])
    return (f"On the phone ({_ago(time.time() * 1000 - (hand.get('at') or time.time() * 1000))}) the conversation went:\n{convo}\n"
            "Carry on from where it left off, briefly saying what you were in the middle of.")

@tool("unlink_phone", "Stop sharing the conversation with the phone.")
def _unlink_phone():
    CONFIG.pop("handoff_pair", None); save_config(CONFIG); return "Unlinked from your phone."

def _handoff_push():
    """After each answer: keep the last few lines on the service for the phone (quietly; at most every 30 s)."""
    pair = CONFIG.get("handoff_pair")
    if not pair or time.time() - _HAND["last"] < 30: return
    _HAND["last"] = time.time()
    lines = [{"role": m["role"], "content": str(m["content"])[:400]} for m in conversation
             if m.get("role") in ("user", "assistant") and m.get("content")][-12:]
    def go():
        import requests
        try: requests.put(f"{HANDOFF_SERVICE}/hand/{pair}?from=pc", data=json.dumps({"at": int(time.time() * 1000), "messages": lines}),
                          headers={"Content-Type": "application/json"}, timeout=10)
        except Exception as e: print(f"[HANDOFF] {type(e).__name__}")
    threading.Thread(target=go, daemon=True).start()

if not HANDOFF_SERVICE:
    for _n in ("link_phone", "continue_from_phone", "unlink_phone"): _TOOL_REGISTRY.pop(_n, None)

# Delivery stacking is the Android app's job: the PC Jarvis doesn't offer it (delivery.py stays only as the map's location store).
for _n in ("add_delivery_order", "plan_deliveries", "next_stop", "complete_stop", "list_delivery_orders", "remove_delivery_order",
           "clear_deliveries", "evaluate_delivery_offer", "open_navigation", "delivery_earnings", "read_offer_from_screen",
           "start_delivery_navigation"):
    _TOOL_REGISTRY.pop(_n, None)
_TOOL_SCHEMAS[:] = [s for s in _TOOL_SCHEMAS if s["function"]["name"] in _TOOL_REGISTRY]

try:                                             # globe, planner, recap, gestures (features.py + hud_extra.js)
    import features; features.install(globals())
except Exception as e: print(f"[FEATURES] not loaded: {type(e).__name__}: {e}")
try:                                             # his inner life: senses, thoughts, moods, curiosity, journal (mind.py)
    import mind; mind.install(globals())
except Exception as e: print(f"[MIND] not loaded: {type(e).__name__}: {e}")
try:                                             # driving the PC by looking at the screen, and what the floating head needs (pc_control.py)
    import pc_control; pc_control.install(globals())
except Exception as e: print(f"[PC] not loaded: {type(e).__name__}: {e}")
try:                                             # streaming studio: OBS, overlays he designs, Discord and Telegram (studio.py)
    import studio; studio.install(globals())
except Exception as e: print(f"[STUDIO] not loaded: {type(e).__name__}: {e}")

if __name__ == "__main__":
    import subprocess, sys
    wake_proc = None
    if os.path.exists("wake.py"):
        try:
            wake_proc = subprocess.Popen([sys.executable, "wake.py"])
            print(f"[MAIN] Wake listener started (PID {wake_proc.pid})")
        except Exception as e: print(f"[MAIN] Wake listener failed: {e}")
    try:
        import uvicorn
        uvicorn.run(app, host="127.0.0.1", port=8000)
    finally:
        if wake_proc and wake_proc.poll() is None:
            wake_proc.terminate()
            try: wake_proc.wait(timeout=3)
            except Exception: wake_proc.kill()