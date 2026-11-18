"""Jarvis's floating head: a small see-through window with his dot face that stays on top of everything while the Jarvis window is
minimised or closed. It bobs gently, glows blue while he listens and talks when he talks. Click it to bring Jarvis back; drag it
anywhere (it remembers where); right-click for the menu. jarvis_app.py starts it as its own process: Jarvis.exe --head
"""
import json, math, os, sys, threading, time, urllib.request

SERVER = os.environ.get("JARVIS_SERVER", "http://127.0.0.1:8000")
HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 180, 220
SHEETS = {"idle": 72, "listen": 72, "speak": 48}
FPS = 12
KEY = "#010203"          # Windows: this exact colour is see-through

def models_dir():
    for d in (os.path.join(os.getcwd(), "models", "head"), os.path.join(HERE, "models", "head"),
              os.path.join(getattr(sys, "_MEIPASS", HERE), "models", "head")):
        if os.path.isdir(d): return d
    return os.path.join(HERE, "models", "head")

_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))     # Jarvis is on this PC: never through a proxy

def http(path, data=None, timeout=1.5):
    req = urllib.request.Request(SERVER + path, data=None if data is None else json.dumps(data).encode(),
                                 headers={"Content-Type": "application/json"}, method="GET" if data is None else "POST")
    with _DIRECT.open(req, timeout=timeout) as r: return json.loads(r.read() or b"{}")

def load_pos(sw, sh):
    try:
        with open("head.json", encoding="utf-8") as f: p = json.load(f)
        if 0 <= p["x"] <= sw - 60 and 0 <= p["y"] <= sh - 60: return p["x"], p["y"]
    except Exception: pass
    return sw - W - 40, sh - H - 90          # bottom right, above the taskbar

def save_pos(x, y):
    try:
        with open("head.json", "w", encoding="utf-8") as f: json.dump({"x": x, "y": y}, f)
    except Exception: pass

def main():
    import tkinter as tk
    root = tk.Tk(); root.title("Jarvis head"); root.overrideredirect(True)
    root.attributes("-topmost", True)
    if sys.platform == "win32":
        root.configure(bg=KEY); root.attributes("-transparentcolor", KEY); bg = KEY
    elif sys.platform == "darwin":
        root.attributes("-transparent", True); root.configure(bg="systemTransparent"); bg = "systemTransparent"
    else: bg = "black"
    canvas = tk.Canvas(root, width=W, height=H, bg=bg, highlightthickness=0, bd=0); canvas.pack()

    frames = {}
    try: from PIL import Image, ImageTk          # quick (Tk's own PNG reader takes seconds on these strips)
    except ImportError: Image = None
    for name, n in SHEETS.items():
        path = os.path.join(models_dir(), name + ".png"); out = []
        if Image is not None:
            sheet = Image.open(path).convert("RGBA")
            if sys.platform == "win32":             # see-through by colour key there: blend the soft edges onto that colour
                back = Image.new("RGBA", sheet.size, KEY); back.alpha_composite(sheet); sheet = back
            out = [ImageTk.PhotoImage(sheet.crop((i * W, 0, i * W + W, H)), master=root) for i in range(n)]
        else:
            sheet = tk.PhotoImage(file=path)
            for i in range(n):
                f = tk.PhotoImage(width=W, height=H)
                f.tk.call(f, "copy", sheet, "-from", i * W, 0, i * W + W, H, "-to", 0, 0)
                out.append(f)
        frames[name] = out
    item = canvas.create_image(0, 0, anchor="nw", image=frames["idle"][0])

    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    S = {"x": 0, "y": 0, "show": False, "state": "idle", "drag": None, "moved": False, "ui": {}, "seen": 0.0, "startup": None}
    S["x"], S["y"] = load_pos(sw, sh)
    root.geometry(f"{W}x{H}+{S['x']}+{S['y']}"); root.withdraw()

    def poll():          # his state and whether the big window is showing, from the page's own reports to the server
        while True:
            try:
                S["ui"] = http("/ui_state"); S["seen"] = time.time()
            except Exception: pass
            time.sleep(0.25)
    threading.Thread(target=poll, daemon=True).start()

    def want_shown():
        ui = S["ui"]
        if time.time() - S["seen"] > 6: return False                 # the server is gone: Jarvis is shutting down
        return not ui.get("window_open") or not ui.get("visible")

    t0 = time.time()
    def tick():
        show = want_shown()
        if show != S["show"]:
            S["show"] = show
            if show: root.deiconify(); root.attributes("-topmost", True)
            else: root.withdraw()
        if show:
            st = (S["ui"].get("state") or "idle")
            sheet = "speak" if st == "speaking" else "listen" if st in ("listening", "session") else "idle"
            n = len(frames[sheet]); k = int((time.time() - t0) * FPS) % n
            canvas.itemconfigure(item, image=frames[sheet][k])
            if S["drag"] is None:                                    # a slow float up and down
                bob = int(round(5 * math.sin((time.time() - t0) * 1.3)))
                root.geometry(f"+{S['x']}+{S['y'] + bob}")
        root.after(int(1000 / FPS), tick)

    def press(e): S["drag"] = (e.x_root, e.y_root, S["x"], S["y"]); S["moved"] = False
    def motion(e):
        if not S["drag"]: return
        dx, dy = e.x_root - S["drag"][0], e.y_root - S["drag"][1]
        if abs(dx) + abs(dy) > 4: S["moved"] = True
        S["x"], S["y"] = S["drag"][2] + dx, S["drag"][3] + dy
        root.geometry(f"+{S['x']}+{S['y']}")
    def release(e):
        moved = S["moved"]; S["drag"] = None
        if moved: save_pos(S["x"], S["y"])
        else: open_jarvis()
    def open_jarvis():
        try: http("/app/open_window", {})
        except Exception: pass

    menu = tk.Menu(root, tearoff=0)
    start_var = tk.BooleanVar(value=False)
    def toggle_startup():
        try: http("/app/startup", {"on": bool(start_var.get())})
        except Exception: pass
    def quit_jarvis():
        try: http("/app/quit", {}, timeout=3)
        except Exception: pass
        root.destroy()
    menu.add_command(label="Open Jarvis", command=open_jarvis)
    menu.add_checkbutton(label="Start with my computer", variable=start_var, command=toggle_startup)
    menu.add_separator()
    menu.add_command(label="Quit Jarvis", command=quit_jarvis)
    def popup(e):
        try: start_var.set(bool(http("/app/startup").get("on")))
        except Exception: pass
        menu.tk_popup(e.x_root, e.y_root)

    canvas.bind("<ButtonPress-1>", press); canvas.bind("<B1-Motion>", motion); canvas.bind("<ButtonRelease-1>", release)
    canvas.bind("<Button-3>", popup); canvas.bind("<Button-2>", popup)          # Mac's right click is Button-2
    tick(); root.mainloop()

if __name__ == "__main__":
    main()
