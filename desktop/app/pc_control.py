"""Jarvis drives the PC like a person would: he looks at the screen, picks what to click or type, does it, looks again, and keeps
going until the job is done ("fill in this form", "turn on dark mode in Settings", "export this project"). Anything that sends,
pays, deletes, posts or installs stops first and asks. Say "stop" at any time, or throw the mouse into a screen corner.

Also here: what the floating head needs (his state, and whether the Jarvis window is showing) and "start with my computer".
server.py calls install(globals()) once.
"""
import base64, io, json, os, re, sys, threading, time

WIN = sys.platform == "win32"
MAX_STEPS, MAX_SECONDS = 25, 240
RISKY = re.compile(r"\b(send|submit|pay|purchase|buy|order|checkout|check out|place order|delete|remove|erase|uninstall|install|format|"
                   r"post|publish|tweet|transfer|withdraw|confirm|sign out|log ?out|shut ?down|restart|reset|unsubscribe|accept)\b", re.I)
CLICKY = {"ButtonControl", "MenuItemControl", "EditControl", "HyperlinkControl", "ListItemControl", "TabItemControl", "CheckBoxControl",
          "RadioButtonControl", "ComboBoxControl", "TreeItemControl", "DataItemControl", "SplitButtonControl", "MenuBarControl",
          "DocumentControl", "SliderControl", "SpinnerControl"}

RUN = {"task": "", "busy": False, "stop": False, "log": [], "pending": None, "ok_risky": False, "steps": 0}

def _dpi_aware():
    if WIN:
        try: import ctypes; ctypes.windll.shcore.SetProcessDpiAwareness(2)     # real pixels, so clicks land where the picture says
        except Exception: pass

def _elements(limit=90, budget=1.5):
    """Clickable things in the window in front, with their boxes (Windows UI Automation). Empty elsewhere: the picture alone decides."""
    if not WIN: return []
    try:
        import uiautomation as auto
        win = auto.GetForegroundControl().GetTopLevelControl()
        out, t0 = [], time.time()
        for c, depth in auto.WalkControl(win, maxDepth=14):
            if time.time() - t0 > budget or len(out) >= limit: break
            try:
                if c.ControlTypeName not in CLICKY or c.IsOffscreen or not c.IsEnabled: continue
                r = c.BoundingRectangle
                if r.width() < 6 or r.height() < 6: continue
                out.append({"name": (c.Name or c.AutomationId or "")[:50], "type": c.ControlTypeName.replace("Control", ""),
                            "box": (r.left, r.top, r.right, r.bottom)})
            except Exception: continue
        return out
    except Exception as e:
        print(f"[PC] elements: {type(e).__name__}"); return []

def _snapshot(elements):
    """Screenshot with every clickable thing boxed and numbered (the model picks a number, not a guessed spot)."""
    from PIL import ImageGrab, ImageDraw
    shot = ImageGrab.grab()
    scale = min(1.0, 1280 / shot.width)
    img = shot.resize((int(shot.width * scale), int(shot.height * scale))) if scale < 1 else shot.copy()
    d = ImageDraw.Draw(img)
    for i, e in enumerate(elements, 1):
        l, t, r, b = [int(v * scale) for v in e["box"]]
        d.rectangle([l, t, r, b], outline=(255, 0, 180), width=2)
        d.rectangle([l, t, l + 22, t + 14], fill=(255, 0, 180)); d.text((l + 2, t + 1), str(i), fill=(255, 255, 255))
    buf = io.BytesIO(); img.convert("RGB").save(buf, "JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(), scale, shot.size

PROMPT = """You are operating a computer to finish this task for the user: {task}
Steps so far: {log}
The screenshot shows the screen now ({w}x{h}). Clickable things are boxed in pink and numbered:
{elements}
Choose the ONE next action. Reply with JSON only, no other text:
{{"thought": "<short>", "action": "click|double_click|right_click|type|key|scroll|open|wait|done|fail",
 "element": <number or null>, "x": <x on the screenshot if no element fits, else null>, "y": <y or null>,
 "text": "<text to type, or app/website to open>", "keys": "<e.g. ctrl+s, enter, alt+tab>", "amount": <scroll clicks, minus = down>,
 "risky": <true if this click or key sends, pays, buys, deletes, posts, installs or can't be undone>, "say": "<when done or failing: one short line for the user>"}}
Prefer keyboard shortcuts when they're reliable. To type into a field, click it first. If the task is finished, action done."""

def _ask_model(describe, task, elements, data_url, size):
    els = "\n".join(f"[{i}] {e['type']} {e['name']!r}" for i, e in enumerate(elements, 1)) or "(none listed: use x and y)"
    raw = describe(data_url, PROMPT.format(task=task, log="; ".join(RUN["log"][-8:]) or "none", w=size[0], h=size[1], elements=els))
    if not raw: return None
    m = re.search(r"\{.*\}", raw, re.S)
    try: return json.loads(m.group(0)) if m else None
    except Exception: return None

def _do(step, elements, scale):
    import pyautogui
    pyautogui.FAILSAFE = True; pyautogui.PAUSE = 0.15
    a = (step.get("action") or "").lower()
    x = y = None
    el = step.get("element")
    if isinstance(el, int) and 1 <= el <= len(elements):
        l, t, r, b = elements[el - 1]["box"]; x, y = (l + r) // 2, (t + b) // 2
    elif step.get("x") is not None and step.get("y") is not None:
        x, y = int(step["x"] / scale), int(step["y"] / scale)
    if a in ("click", "double_click", "right_click"):
        if x is None: return "no target"
        {"click": pyautogui.click, "double_click": pyautogui.doubleClick, "right_click": pyautogui.rightClick}[a](x, y)
        return f"{a.replace('_', ' ')} {elements[el - 1]['name'] if isinstance(el, int) and 1 <= el <= len(elements) else (x, y)}"
    if a == "type":
        txt = str(step.get("text") or "")
        if x is not None: pyautogui.click(x, y)
        if txt.isascii(): pyautogui.write(txt, interval=0.01)
        else:                                            # accents, emoji, other scripts: through the clipboard
            import pyperclip; pyperclip.copy(txt); pyautogui.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")
        return f"typed {txt[:40]!r}"
    if a == "key":
        keys = [k.strip().lower() for k in re.split(r"[+ ]", str(step.get("keys") or "")) if k.strip()]
        keys = ["command" if k in ("cmd", "win") and sys.platform == "darwin" else ("win" if k == "windows" else k) for k in keys]
        if not keys: return "no keys"
        pyautogui.hotkey(*keys); return "pressed " + "+".join(keys)
    if a == "scroll":
        if x is not None: pyautogui.moveTo(x, y)
        pyautogui.scroll(int(step.get("amount") or -5) * 120); return "scrolled"
    if a == "open":
        what = str(step.get("text") or "")
        if re.match(r"^(https?://|www\.)|\.(com|org|net|io|ng|co)\b", what):
            import webbrowser; webbrowser.open(what if what.startswith("http") else "https://" + what)
        else:
            pyautogui.press("win" if WIN else "command"); time.sleep(0.6); pyautogui.write(what, interval=0.02); time.sleep(0.8); pyautogui.press("enter")
        time.sleep(2); return f"opened {what}"
    if a == "wait": time.sleep(1.5); return "waited"
    return a

def install(ns):
    tool, app = ns["tool"], ns["app"]
    _dpi_aware()
    ui = {"state": "idle", "visible": True, "at": 0.0}

    @app.post("/ui_state")
    async def ui_state_in(payload: dict):
        ui.update(state=str(payload.get("state") or "idle"), visible=bool(payload.get("visible", True)), at=time.time()); return {"ok": True}

    @app.get("/ui_state")
    async def ui_state_out():
        st = "speaking" if RUN["busy"] and ui["state"] not in ("speaking", "listening", "session") else ui["state"]
        return {"state": st, "visible": ui["visible"], "window_open": time.time() - ui["at"] < 8, "working": RUN["busy"]}

    def say(text):
        try: ns["_broadcast_ws"]("proactive:" + text)
        except Exception: pass
        try: ns["conversation"].append({"role": "assistant", "content": text})    # so "yes" or "what happened?" make sense next turn
        except Exception: pass
        print(f"[PC] said: {text}")

    def minimise_jarvis():
        """Get the Jarvis window out of the way so the clicks land on the real screen (the floating head stays)."""
        if not WIN: return
        try:
            import ctypes; u = ctypes.windll.user32
            hwnd = u.FindWindowW(None, "JARVIS")
            if hwnd: u.ShowWindow(hwnd, 6)            # SW_MINIMIZE
        except Exception: pass

    def run():
        RUN.update(busy=True, stop=False, steps=0)
        t0 = time.time(); describe = ns["_describe_image"]
        try:
            minimise_jarvis(); time.sleep(0.8)
            while not RUN["stop"] and RUN["steps"] < MAX_STEPS and time.time() - t0 < MAX_SECONDS:
                els = _elements()
                url, scale, size = _snapshot(els)
                step = _ask_model(describe, RUN["task"], els, url, size)
                if step is None: say("I couldn't read the screen just now, so I've stopped."); return
                a = (step.get("action") or "").lower()
                if a == "done": say(step.get("say") or "Done."); return
                if a == "fail": say(step.get("say") or "I couldn't finish that one."); return
                target = ""
                el = step.get("element")
                if isinstance(el, int) and 1 <= el <= len(els): target = els[el - 1]["name"]
                risky = bool(step.get("risky")) or bool(RISKY.search(f"{target} {step.get('keys') or ''}" if a in ("click", "double_click", "key") else ""))
                if risky and not RUN["ok_risky"]:
                    RUN["pending"] = step
                    say(f"Before I {a.replace('_', ' ')} {target or step.get('keys') or 'that'}: it can't be undone. Shall I go ahead?")
                    return
                RUN["ok_risky"] = False                       # a yes covers one step, not the rest of the job
                RUN["log"].append(_do(step, els, scale)); RUN["steps"] += 1
                time.sleep(0.7)                               # let the app react before looking again
            if RUN["stop"]: say("Stopped.")
            else: say("That's taking longer than it should, so I've stopped where I am.")
        except Exception as e:
            if "FailSafe" in type(e).__name__: say("You threw the mouse in the corner, so I stopped.")
            else: print(f"[PC] {type(e).__name__}: {e}"); say("Something went wrong on the screen, so I stopped.")
        finally: RUN["busy"] = False

    @tool("use_computer",
          "Do something on his PC by looking at the screen and clicking and typing like a person: any app or website, when no other tool "
          "does it ('fill in this form', 'turn on dark mode in Settings', 'rename these files in Explorer', 'export the project in Premiere'). "
          "Runs in the background and reports back. action: start (with task), stop, continue (after he said yes to a step that "
          "can't be undone: confirmed=true).",
          {"task": {"type": "string"}, "action": {"type": "string"}, "confirmed": {"type": "boolean"}}, [])
    def use_computer(task="", action="start", confirmed=False):
        a = (action or "start").lower()
        if a == "stop":
            RUN["stop"] = True; RUN["pending"] = None
            return "Stopping." if RUN["busy"] else "Nothing's running."
        try: import pyautogui  # noqa: F401
        except Exception: return "Screen control needs one more part: pip install pyautogui, then restart me."
        if a == "continue":
            if not RUN["pending"] and not RUN["task"]: return "There's nothing waiting to carry on."
            if not confirmed: return "Ask him whether to go ahead with that step; only continue with confirmed=true after a yes."
            RUN["ok_risky"] = True; RUN["pending"] = None
        else:
            if not task: return "What should I do on the screen?"
            if RUN["busy"]: return "I'm still on the last job. Say stop first if you want this one instead."
            RUN.update(task=task, log=[], pending=None, ok_risky=bool(confirmed))
        threading.Thread(target=run, daemon=True).start()
        return "On it. I'm driving the screen now: say stop if you need it back."

    @tool("start_with_computer", "Turn on or off Jarvis starting by himself when the computer starts ('start with Windows', "
          "'don't start when I log in').", {"on": {"type": "boolean"}}, ["on"])
    def start_with_computer(on=True):
        hooks = ns.get("APP_HOOKS") or {}
        if "set_startup" not in hooks: return "That only works in the installed Jarvis app."
        hooks["set_startup"](bool(on))
        return "I'll start with the computer from now on." if on else "I won't start by myself any more."

    words = (r"\b(on my (computer|pc|laptop|screen)|use (my|the) (computer|pc|mouse|keyboard)|click|double.?click|type (in|into|it)|fill (in|out)|"
             r"in (chrome|edge|firefox|explorer|file explorer|settings|excel|word|powerpoint|photoshop|premiere|vs ?code|notepad|outlook|steam)|"
             r"take over|drive|do it for me|stop (that|it|clicking|driving)|carry on|continue|start (with|when) (windows|my (computer|pc|laptop))|"
             r"(on|at) (startup|start ?up|log ?in))\b")
    ns["_TOOL_GROUPS"].append((words, ("use_computer", "start_with_computer")))
    ns["_TOOL_GROUPS"].append((r"^\s*(yes|yeah|yep|sure|go ahead|do it|please do|ok(ay)?|no|nope|stop|cancel|don'?t)\b", ("use_computer",)))
    _needs = ns["_needs_tool"]
    ns["_needs_tool"] = lambda text: bool(re.search(words, (text or "").lower())) or _needs(text)
    print("[PC] screen control ready")
