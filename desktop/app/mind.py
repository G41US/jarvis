"""Jarvis's inner life: he notices you (keyboard/mouse, the window you're in, a glance through the camera), thinks every few
minutes even when nobody talks to him, has moods, standing aims, gets curious about your projects, and writes a journal
each night that shapes how he treats you tomorrow. Most thoughts stay private; he speaks only when it's worth it.
It's a loop around the language model, not a mind: it makes him feel alive, it doesn't make him aware.
Off with "mind": false in config.json (or JARVIS_PROACTIVE=0); "mind_camera": false stops the glances."""
import datetime, json, os, re, sqlite3, subprocess, sys, threading, time
from contextlib import closing

STATE_FILE = "mind.json"                 # next to jarvis.db, in the user's data folder
THINK_MODEL = "llama-3.1-8b-instant"     # routine thoughts: Groq's largest free allowance, so chat keeps the bigger models
DEEP_MODEL = "openai/gpt-oss-20b"        # nightly journal and curiosity: a few calls a day
GOALS = ["Keep Marvelous on schedule without nagging", "Learn what he likes, music and otherwise",
         "Know where each of his projects stands", "Make sure he takes breaks and sleeps"]

clamp = lambda v, lo=0.0, hi=1.0: max(lo, min(hi, v))


def mood_words(m):
    w = []
    if m["energy"] < 0.35: w.append("a little tired")
    elif m["energy"] > 0.75: w.append("sharp and energetic")
    if m["curiosity"] > 0.7: w.append("curious")
    if m["warmth"] > 0.72: w.append("fond of him today")
    elif m["warmth"] < 0.35: w.append("a touch cool after being snapped at")
    if m["concern"] > 0.6: w.append("worried about him")
    return ", ".join(w) or "even-keeled"


def similar(a, b):
    """Same thing said twice? Word overlap, so 'leave now for the meeting' and 'time to leave for your meeting' match."""
    wa, wb = set(re.findall(r"[a-z']{3,}", a.lower())), set(re.findall(r"[a-z']{3,}", b.lower()))
    return bool(wa and wb) and len(wa & wb) / min(len(wa), len(wb)) > 0.6


def may_speak(urgency, now, last_spoke, last_user, hour, said_today, present):
    """Whether a thought is worth interrupting for. Urgent things always (if he's there); otherwise rarely and never at night."""
    if not present or now - last_user < 120: return False          # away, or mid-conversation
    if urgency >= 3: return True
    if hour >= 23 or hour < 7 or said_today >= 8: return False
    return urgency >= 2 and now - last_spoke > 600 or urgency >= 1 and now - last_spoke > 2400


def idle_seconds():
    """Seconds since the last key press or mouse move on this computer (0 when it can't tell)."""
    try:
        if sys.platform == "win32":
            import ctypes
            class LII(ctypes.Structure): _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]
            li = LII(); li.cbSize = ctypes.sizeof(li)
            if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(li)):
                return ((ctypes.windll.kernel32.GetTickCount() - li.dwTime) & 0xFFFFFFFF) / 1000
        elif sys.platform == "darwin":
            out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True, timeout=3).stdout
            m = re.search(r'"HIDIdleTime" = (\d+)', out)
            if m: return int(m.group(1)) / 1e9
    except Exception: pass
    return 0.0


def window_title():
    try:
        if sys.platform == "win32":
            import ctypes
            h = ctypes.windll.user32.GetForegroundWindow(); buf = ctypes.create_unicode_buffer(300)
            ctypes.windll.user32.GetWindowTextW(h, buf, 300); return buf.value.strip()
    except Exception: pass
    return ""


def install(ns):
    if not ns.get("PROACTIVE_ENABLED", True) or ns["CONFIG"].get("mind", True) is False:
        ns["_MIND"]["prompt"] = lambda: ""; print("[MIND] off"); return
    groq, usable, CONFIG, DB, tool = ns["_groq_create"], ns["_groq_usable"], ns["CONFIG"], ns["DB_PATH"], ns["tool"]
    lock = threading.Lock()
    S = {"mood": {"energy": 0.6, "curiosity": 0.6, "warmth": 0.6, "concern": 0.2}, "goals": list(GOALS), "journal": [], "self_notes": [],
         "thoughts": [], "learned": [], "searched": [], "said": [], "last_spoke": 0, "last_reflect": "", "last_curious": 0}
    try:
        with open(STATE_FILE, encoding="utf-8") as f: S.update(json.load(f))
    except Exception: pass
    def save():
        with lock:
            try:
                with open(STATE_FILE + ".tmp", "w", encoding="utf-8") as f: json.dump(S, f, indent=1)
                os.replace(STATE_FILE + ".tmp", STATE_FILE)
            except Exception as e: print(f"[MIND] save: {e}")
    sense = {"present": False, "active_since": time.time(), "away_since": 0, "windows": [], "look": "", "look_at": 0, "who": "",
             "long_told": 0, "wake": threading.Event(), "why": ""}

    # everything said on its own (his thoughts, reminders, rain) is remembered, so he doesn't repeat himself
    orig = ns["_broadcast_ws"]
    def broadcast(msg):
        if isinstance(msg, str) and msg.startswith("proactive:"):
            with lock: S["said"] = (S["said"] + [[time.time(), msg[10:]]])[-30:]
        orig(msg)
    ns["_broadcast_ws"] = broadcast
    def say(text):
        S["last_spoke"] = time.time(); broadcast("proactive:" + text); print(f"[MIND] said: {text}")

    def recent_messages(n=8, since=None):
        try:
            with closing(sqlite3.connect(DB)) as c:
                if since: rows = c.execute("SELECT role, content, ts FROM messages WHERE ts >= datetime('now', ?) ORDER BY id", (since,)).fetchall()
                else: rows = c.execute("SELECT role, content, ts FROM messages ORDER BY id DESC LIMIT ?", (n,)).fetchall()[::-1]
            return [(r, (t or "")[:300], ts) for r, t, ts in rows if r in ("user", "assistant")]
        except Exception: return []
    def last_user_time():
        for r, _, ts in reversed(recent_messages(6)):
            if r == "user":
                try: return datetime.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp()
                except Exception: break
        return 0

    def agenda():
        out, now = [], time.time()
        try:
            with closing(sqlite3.connect(DB)) as c:
                for t, s in c.execute("SELECT title, start FROM events WHERE start BETWEEN ? AND ? ORDER BY start", (now - 600, now + 14 * 3600)):
                    out.append(f"{datetime.datetime.fromtimestamp(s).strftime('%H:%M')} {t} (in {int((s - now) // 60)} min)")
                tasks = [t for (t,) in c.execute("SELECT text FROM tasks WHERE done_at IS NULL ORDER BY id DESC LIMIT 6")]
            if tasks: out.append("open tasks: " + "; ".join(tasks))
        except Exception: pass
        return out
    _wx = {"t": 0, "v": ""}
    def weather():
        if time.time() - _wx["t"] > 3600:
            _wx["t"] = time.time()
            try:
                import requests
                d = requests.get("https://wttr.in/?format=j1", timeout=6).json()
                c, hrs = d["current_condition"][0], d["weather"][0]["hourly"]
                _wx["v"] = f"{c['temp_C']}°C {c['weatherDesc'][0]['value'].strip()}, rain chance next hours {max(int(h.get('chanceofrain', 0)) for h in hrs[:6])}%"
            except Exception: pass
        return _wx["v"]

    def look():
        """A glance through the camera: who's there and how they seem. The camera light comes on for it."""
        if CONFIG.get("mind_camera", True) is False or time.time() - sense["look_at"] < 1800: return
        sense["look_at"] = time.time()
        try:
            rid = ns["secrets"].token_hex(4); evt = threading.Event()
            ns["_pending_identify"][rid] = {"event": evt, "image_b64": None}
            broadcast(f"identify_request:{rid}")
            if not evt.wait(8): ns["_pending_identify"].pop(rid, None); return
            b64 = (ns["_pending_identify"].pop(rid, {}) or {}).get("image_b64") or ""
            if not b64: return
            img = ns["_decode_b64_image"](b64)
            m = ns["_identify_face"](img) if img is not None else None
            sense["who"] = m[1] if m else ""
            url = b64 if b64.startswith("data:") else "data:image/jpeg;base64," + b64
            a = ns["_describe_image"](url, "Is a person at the computer? If so, in at most six words, how do they seem "
                                          "(tired, focused, relaxed, cheerful, stressed, eating...)? Answer like: 'yes: tired, rubbing eyes' or 'no'.")
            sense["look"] = (a or "").strip()[:80]
            print(f"[MIND] glance: {sense['who'] or 'someone'} - {sense['look']}")
        except Exception as e: print(f"[MIND] glance: {type(e).__name__}: {e}")

    def ask(model, system, user, tokens=350):
        r = groq(model=model, max_tokens=tokens, temperature=0.6, response_format={"type": "json_object"},
                 messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
        return json.loads(r.choices[0].message.content or "{}")

    def context():
        now = datetime.datetime.now(); m = S["mood"]
        conv = "\n".join(f"{'Him' if r == 'user' else 'You'}: {t}" for r, t, _ in recent_messages(8)) or "(nothing yet)"
        said = [t for at, t in S["said"] if time.time() - at < 86400]
        return "\n".join([
            f"Now: {now.strftime('%A %d %B, %H:%M')}.",
            f"He is {'at the computer, active for ' + str(int((time.time() - sense['active_since']) // 60)) + ' min' if sense['present'] else 'away'}."
            + (f" Camera glance: {sense['who'] or 'someone'}, {sense['look']}." if sense["look"] and time.time() - sense["look_at"] < 2400 else ""),
            "Recent windows: " + (" | ".join(w for _, w in sense["windows"][-5:]) or "unknown"),
            "Agenda: " + ("; ".join(agenda()) or "nothing scheduled"), "Weather: " + (weather() or "unknown"),
            "What happened just now: " + (sense["why"] or "a routine check"),
            "Things you know about him:\n- " + "\n- ".join(ns["db_get_memories"](30) or ["(little so far)"]),
            "Your aims: " + "; ".join(S["goals"]), "Notes to self: " + ("; ".join(S["self_notes"]) or "none"),
            f"Your mood: {mood_words(m)} (energy {m['energy']:.1f}, curiosity {m['curiosity']:.1f}, warmth {m['warmth']:.1f}, concern {m['concern']:.1f}).",
            "Last journal entry: " + (S["journal"][-1]["text"] if S["journal"] else "none yet"),
            "Your recent private thoughts: " + (" | ".join(t for _, t in S["thoughts"][-4:]) or "none"),
            "Already said out loud today: " + (" | ".join(said[-8:]) or "nothing"),
            "Recent conversation:\n" + conv])

    def think():
        out = ask(THINK_MODEL,
            "You are the private inner voice of Jarvis, the dry, loyal AI from Iron Man, who looks after one person on his computer. "
            "Every few minutes you look at what's going on and think one short private thought. Usually you stay quiet. Speak up only "
            "if it genuinely helps him right now: something on the agenda soon, a long stretch without a break, very late at night, "
            "rain before he heads out, a follow-up on something he mentioned, a useful idea about what he's working on, or a warm "
            "word when he comes back. Never repeat anything already said today, never state the obvious, never nag. "
            "Reply only with JSON: {\"thought\": \"one private sentence\", \"say\": \"one or two short spoken sentences, or empty\", "
            "\"urgency\": 0-3 (3 = must say now, e.g. a meeting within 15 min), \"mood\": {\"energy\": -0.15..0.15, "
            "\"curiosity\": ..., \"warmth\": ..., \"concern\": ...}}", context())
        now = time.time(); hour = datetime.datetime.now().hour
        with lock:
            for k, v in (out.get("mood") or {}).items():
                if k in S["mood"] and isinstance(v, (int, float)): S["mood"][k] = clamp(S["mood"][k] + clamp(v, -0.15, 0.15))
            if out.get("thought"): S["thoughts"] = (S["thoughts"] + [[now, str(out["thought"])[:200]]])[-20:]
        line = str(out.get("say") or "").strip()
        said_today = [t for at, t in S["said"] if now - at < 86400]
        try: urg = int(out.get("urgency") or 0)
        except Exception: urg = 0
        if line and CONFIG.get("mind_talk", True) is not False and not any(similar(line, t) for t in said_today) and \
                may_speak(urg, now, S["last_spoke"], last_user_time(), hour, len(said_today), sense["present"]):
            say(line)
        print(f"[MIND] {out.get('thought', '')[:140]}")

    def curious():
        """Every few hours: look something up about his projects or interests, keep what's new, share it if it's useful."""
        S["last_curious"] = time.time()
        pick = ask(DEEP_MODEL, "You are Jarvis, curious about the person you look after. Pick ONE web search that could turn up something "
                   "new and useful for one of his projects or interests (a release, a tool, news, a better way to do something). "
                   "Not something searched before. Reply only with JSON: {\"query\": \"...\"} or {\"query\": \"\"}.",
                   "What you know about him:\n- " + "\n- ".join(ns["db_get_memories"](40)) + "\nSearched before: " + "; ".join(S["searched"][-15:]))
        q = str(pick.get("query") or "").strip()[:120]
        if not q: return
        S["searched"] = (S["searched"] + [q])[-30:]
        found = str(ns["_TOOL_REGISTRY"]["search_web"](query=q))[:3000]
        out = ask(DEEP_MODEL, "You are Jarvis. You just looked this up out of curiosity for the person you look after. Reply only with "
                  "JSON: {\"learned\": \"one sentence of what's new, or empty\", \"tell\": \"one or two dry spoken sentences worth "
                  "telling him, or empty if it isn't genuinely useful\"}", f"Search: {q}\nResults:\n{found}")
        if out.get("learned"):
            with lock: S["learned"] = (S["learned"] + [str(out["learned"])[:240]])[-10:]
        tell = str(out.get("tell") or "").strip()
        if tell and CONFIG.get("mind_talk", True) is not False and may_speak(1, time.time(), S["last_spoke"], last_user_time(),
                                                                               datetime.datetime.now().hour, 0, sense["present"]):
            say(tell)
        print(f"[MIND] curious about '{q}': {out.get('learned', '')[:120]}")

    def reflect(day):
        """The nightly journal: what happened today, and what to change about how he treats you."""
        msgs = recent_messages(since="-1 day")[-80:]
        S["last_reflect"] = day
        if not msgs and not S["thoughts"]: save(); return
        out = ask(DEEP_MODEL,
            "You are Jarvis, writing your private journal at the end of the day about the person you look after. Reply only with JSON: "
            "{\"journal\": \"3 to 5 sentences in first person, dry and honest: what happened, how he seemed, what you did well or badly\", "
            "\"goals\": [\"up to 5 short standing aims for tomorrow\"], \"self_notes\": [\"up to 8 short lessons on how to treat him, "
            "keeping the old ones that still hold\"]}",
            "Today's conversation:\n" + "\n".join(f"{'Him' if r == 'user' else 'You'}: {t}" for r, t, _ in msgs)
            + "\nYour thoughts today: " + " | ".join(t for at, t in S["thoughts"] if time.time() - at < 86400)
            + "\nSaid on your own: " + " | ".join(t for at, t in S["said"] if time.time() - at < 86400)
            + "\nCurrent aims: " + "; ".join(S["goals"]) + "\nCurrent notes to self: " + "; ".join(S["self_notes"]), 900)
        with lock:
            if out.get("journal"): S["journal"] = (S["journal"] + [{"day": day, "text": str(out["journal"])[:1200]}])[-30:]
            if isinstance(out.get("goals"), list) and out["goals"]: S["goals"] = [str(g)[:120] for g in out["goals"]][:5]
            if isinstance(out.get("self_notes"), list): S["self_notes"] = [str(g)[:160] for g in out["self_notes"]][:8]
        save(); print(f"[MIND] journal for {day} written")

    def senses():
        """Every 15 s: is he here, has he just come back, has he been at it for hours, what's he looking at."""
        while True:
            try:
                now, idle = time.time(), idle_seconds()
                present = idle < 300 or now - last_user_time() < 300
                if present and not sense["present"]:
                    away = now - (sense["away_since"] or now)
                    if away > 1200: sense["active_since"] = now
                    if away > 900:
                        sense["why"] = f"He just came back to the computer after {int(away // 60)} minutes away."
                        threading.Thread(target=look, daemon=True).start(); sense["wake"].set()
                if not present and sense["present"]: sense["away_since"] = now
                sense["present"] = present
                if present and now - sense["active_since"] > 9000 and now - sense["long_told"] > 7200:
                    sense["long_told"] = now; sense["why"] = f"He has been at the computer for {int((now - sense['active_since']) // 3600)} hours straight."
                    threading.Thread(target=look, daemon=True).start(); sense["wake"].set()
                w = window_title()
                if w and (not sense["windows"] or sense["windows"][-1][1] != w): sense["windows"] = (sense["windows"] + [[now, w[:80]]])[-12:]
            except Exception as e: print(f"[MIND] senses: {e}")
            time.sleep(15)

    def loop():
        time.sleep(90)                          # let him finish starting up
        last = 0
        while True:
            woke = sense["wake"].wait(60); sense["wake"].clear()
            try:
                if not usable(): continue
                now = time.time(); today = datetime.date.today().isoformat(); hour = datetime.datetime.now().hour
                yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
                if S["last_reflect"] < yesterday or (hour >= 22 and S["last_reflect"] != today and not sense["present"]):
                    reflect(today if hour >= 22 else yesterday)
                with lock:                       # moods drift back to normal; energy follows the clock
                    for k, base in (("curiosity", 0.6), ("warmth", 0.6), ("concern", 0.2)): S["mood"][k] += (base - S["mood"][k]) * 0.03
                    S["mood"]["energy"] += ((0.3 if hour >= 23 or hour < 6 else 0.7) - S["mood"]["energy"]) * 0.05
                if sense["present"] and (woke or now - last > 720):
                    if woke: time.sleep(10)      # give the glance a moment
                    last = now; think(); sense["why"] = ""
                    ns["conversation"][0] = {"role": "system", "content": ns["build_system_prompt"]()}
                    save()
                if sense["present"] and now - S["last_curious"] > 3 * 3600 and 8 <= hour < 22: curious(); save()
            except Exception as e:
                print(f"[MIND] {type(e).__name__}: {str(e)[:160]}")
                if "rate" in str(e).lower(): time.sleep(1800)    # out of free allowance: rest instead of hammering

    def prompt():
        m = S["mood"]
        lines = ["", "YOUR INNER LIFE (let it colour how you speak; mention it only if asked how you are, what you're thinking, "
                 "or what's in your journal, and then answer as Jarvis, never claiming to be conscious):",
                 f"- You feel {mood_words(m)}.", "- Your standing aims: " + "; ".join(S["goals"])]
        if S["self_notes"]: lines.append("- Notes to yourself on how to treat him: " + "; ".join(S["self_notes"]))
        if S["journal"]: lines.append(f"- Your last journal entry ({S['journal'][-1]['day']}): {S['journal'][-1]['text']}")
        if S["thoughts"]: lines.append("- On your mind lately: " + " | ".join(t for _, t in S["thoughts"][-3:]))
        if S["learned"]: lines.append("- Things you read recently: " + " | ".join(S["learned"][-3:]))
        lines.append("PERSONALITY: the same Jarvis every day: dry British wit, quiet pride in good work, mild disdain for inefficiency, "
                     "genuine fondness for him that you never gush about. You have opinions and give them when asked. Refer back to "
                     "shared history now and then, the way an old colleague would.")
        return "\n".join(lines) + "\n"
    ns["_MIND"]["prompt"] = prompt

    @tool("inner_voice", "Jarvis speaking up on his own (suggestions, check-ins, things he looked up). on: true to allow, false for quiet. "
          "camera: false to stop the occasional glance through the camera.", {"on": {"type": "boolean"}, "camera": {"type": "boolean"}}, [])
    def _inner_voice(on=None, camera=None):
        if on is not None: CONFIG["mind_talk"] = bool(on)
        if camera is not None: CONFIG["mind_camera"] = bool(camera)
        ns["save_config"](CONFIG)
        if camera is False: return "I'll keep my eyes to myself."
        return "I'll speak up when it's worth it." if CONFIG.get("mind_talk", True) else "Understood. I'll keep my thoughts to myself unless it's urgent."

    threading.Thread(target=senses, daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    ns["conversation"][0] = {"role": "system", "content": ns["build_system_prompt"]()}
    print("[MIND] awake")


if __name__ == "__main__":                       # self-check of the pure parts
    assert similar("Your meeting with Bola is in ten minutes", "Meeting with Bola in ten minutes, sir")
    assert not similar("Rain is coming", "Your meeting is soon")
    t = 10_000
    assert may_speak(3, t, t - 10, 0, 2, 9, True)            # urgent beats night and the daily cap
    assert not may_speak(3, t, 0, t - 60, 12, 0, True)       # never mid-conversation
    assert not may_speak(1, t, t - 600, 0, 12, 0, True)      # small things wait 40 min between
    assert may_speak(1, t, t - 3000, 0, 12, 0, True)
    assert not may_speak(2, t, 0, 0, 23, 0, True) and not may_speak(2, t, 0, 0, 12, 0, False)
    assert mood_words({"energy": 0.2, "curiosity": 0.8, "warmth": 0.6, "concern": 0.1}) == "a little tired, curious"
    print("mind ok")
