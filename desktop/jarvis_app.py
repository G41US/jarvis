"""Jarvis desktop app: what Jarvis.exe (Windows) and Jarvis.app (Mac) run.

Starts the Jarvis server, the "Hey Jarvis" listener, a Jarvis window and his floating head. Closing the window (Windows) doesn't stop
him: he keeps listening in the background and the floating head stays on screen; "Quit Jarvis" on the head's right-click menu stops him.
"--background" (how he starts with the computer) starts him straight into the floating head.
Everything the user owns (memory, their key in .env, downloaded voices, settings) lives in a per-user folder:
  Windows  %APPDATA%\\Jarvis          Mac  ~/Library/Application Support/Jarvis
Run from source for testing:  python desktop/jarvis_app.py
"""
import os, sys, shutil, socket, subprocess, threading, time, webbrowser

FROZEN = getattr(sys, "frozen", False)
BUNDLE = getattr(sys, "_MEIPASS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
PORT = int(os.environ.get("JARVIS_PORT") or 8000)   # another port lets a build test run beside the Jarvis you use
URL = f"http://127.0.0.1:{PORT}"
os.environ.setdefault("JARVIS_SERVER", URL)          # the "Hey Jarvis" listener (a child process) reports here
WEB_FILES = ["index.html", "hud_extra.js", "xray.js", "nav.js", "nav_core.js"]
# Shown the moment Jarvis is opened (the first start downloads voices and can take a few minutes); swaps to Jarvis when it's up.
SPLASH = """<!doctype html><meta charset="utf-8"><title>Jarvis</title>
<style>html,body{margin:0;height:100%;background:#000;color:#f5c97a;font:500 18px/1.5 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}
i{display:block;width:44px;height:44px;margin:0 auto 22px;border-radius:50%;border:2px solid #f5c97a33;border-top-color:#f5c97a;animation:s .9s linear infinite}
@keyframes s{to{transform:rotate(360deg)}} small{display:block;margin-top:6px;color:#8c7a62;font-size:14px}</style>
<div><i></i>Jarvis is starting<small>The very first start downloads his voice and hearing, so it can take a few minutes.</small></div>
<script>(function t(){fetch("{URL}/setup/status",{mode:"no-cors"}).then(function(){location.replace("{URL}")}).catch(function(){setTimeout(t,1000)})})()</script>""".replace("{URL}", URL)


def data_dir():
    if sys.platform == "win32": base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif sys.platform == "darwin": base = os.path.expanduser("~/Library/Application Support")
    else: base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.environ.get("JARVIS_HOME") or os.path.join(base, "Jarvis")


def sync_app_files(home):
    """Copy the page and its models next to the user's data once per version. User files are never touched."""
    try: version = open(os.path.join(BUNDLE, "VERSION"), encoding="utf-8").read().strip()
    except OSError: version = "dev"
    stamp = os.path.join(home, ".app-version")
    try: done = open(stamp, encoding="utf-8").read().strip() == version and version != "dev"
    except OSError: done = False
    if done: return
    for f in WEB_FILES: shutil.copy2(os.path.join(BUNDLE, f), os.path.join(home, f))
    shutil.copytree(os.path.join(BUNDLE, "models"), os.path.join(home, "models"), dirs_exist_ok=True)
    if not os.path.exists(os.path.join(home, "config.json")):
        with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as f: f.write('{\n  "voice": "en_GB-alan-medium"\n}\n')
    with open(stamp, "w", encoding="utf-8") as f: f.write(version)


def port_open():
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def find_browser():
    """Chrome or Edge can open Jarvis as its own window with sound allowed from the start (no "click once" step)."""
    if sys.platform == "win32":
        pf, pf86, local = os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", ""), os.environ.get("LOCALAPPDATA", "")
        paths = [os.path.join(b, "Google", "Chrome", "Application", "chrome.exe") for b in (pf, pf86, local)]
        paths += [os.path.join(b, "Microsoft", "Edge", "Application", "msedge.exe") for b in (pf86, pf)]
    elif sys.platform == "darwin":
        paths = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                 "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    else:
        paths = [shutil.which(n) or "" for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")]
    return next((p for p in paths if p and os.path.isfile(p)), None)


WIN = sys.platform == "win32"

def _find_hwnd():
    """The Jarvis window (a Chrome/Edge app window titled after the page), or 0."""
    if not WIN: return 0
    import ctypes; u = ctypes.windll.user32
    return u.FindWindowW("Chrome_WidgetWin_1", "JARVIS") or u.FindWindowW(None, "JARVIS")

def _hide_when_up(timeout=25):
    """A background start: the page runs (so he can hear and talk) but its window stays minimised; the floating head shows instead."""
    import ctypes; u = ctypes.windll.user32
    end = time.time() + timeout
    while time.time() < end:
        h = _find_hwnd()
        if h: u.ShowWindow(h, 7); return          # SW_SHOWMINNOACTIVE: minimised, without taking the focus
        time.sleep(0.2)

def restore_window_win():
    """Bring the (minimised or off-screen) Jarvis window back, maximised and in front. False when there's no window."""
    h = _find_hwnd()
    if not h: return False
    import ctypes; u = ctypes.windll.user32
    u.ShowWindow(h, 9)                                          # SW_RESTORE
    u.SetWindowPos(h, 0, 80, 60, 1280, 800, 0x0040 | 0x0004)    # onto the screen (it may have been parked off it)
    u.ShowWindow(h, 3)                                          # SW_MAXIMIZE
    u.keybd_event(0x12, 0, 0, 0); u.SetForegroundWindow(h); u.keybd_event(0x12, 0, 2, 0)   # Windows only lets the active app take the front: a tap of Alt counts
    return True

def open_window(home, hidden=False):
    """Returns the window's process when we own it, else None (opened in the normal browser)."""
    if os.environ.get("JARVIS_NO_WINDOW"): return None   # headless: the build check, or a home server
    splash = os.path.join(home, "starting.html")
    with open(splash, "w", encoding="utf-8") as f: f.write(SPLASH)
    start = URL if port_open() else "file:///" + splash.replace(os.sep, "/").lstrip("/")
    exe = find_browser()
    if not exe:
        webbrowser.open(start); return None
    # the music player's plan B opens YouTube Music in a window of this same browser (and profile, so sound is allowed there too)
    os.environ["JARVIS_BROWSER"], os.environ["JARVIS_BROWSER_PROFILE"] = exe, os.path.join(home, "browser")
    # he must keep hearing and talking while minimised: no throttling of a page that's in the background or covered up
    args = [exe, f"--app={start}", f"--user-data-dir={os.path.join(home, 'browser')}", "--autoplay-policy=no-user-gesture-required",
            "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows"]
    args += ["--window-position=-32000,-32000", "--window-size=1280,800"] if hidden and WIN else ["--start-maximized"]
    proc = subprocess.Popen(args)
    if hidden and WIN: threading.Thread(target=_hide_when_up, daemon=True).start()
    return proc


def start_head(home):
    """The floating head: its own little process, so a hiccup in it never touches Jarvis."""
    cmd = [sys.executable, "--head"] if FROZEN else [sys.executable, os.path.abspath(__file__), "--head"]
    try:
        log = open(os.path.join(home, "head.log"), "a", encoding="utf-8")
        return subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:
        print(f"[APP] floating head failed: {e}"); return None


# ---------------- starting with the computer ----------------
RUN_KEY, RUN_NAME = r"Software\Microsoft\Windows\CurrentVersion\Run", "Jarvis"
MAC_AGENT = os.path.expanduser("~/Library/LaunchAgents/com.ghost.jarvis.plist")
LINUX_AUTOSTART = os.path.expanduser("~/.config/autostart/jarvis.desktop")

def launch_cmd():
    if FROZEN: return [sys.executable, "--background"]
    py = sys.executable
    if WIN and os.path.exists(py.replace("python.exe", "pythonw.exe")): py = py.replace("python.exe", "pythonw.exe")   # no console window
    return [py, os.path.abspath(__file__), "--background"]

def startup_on():
    try:
        if WIN:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k: winreg.QueryValueEx(k, RUN_NAME); return True
        return os.path.exists(MAC_AGENT if sys.platform == "darwin" else LINUX_AUTOSTART)
    except OSError: return False

def set_startup(on):
    cmd = launch_cmd()
    try:
        if WIN:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                if on: winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, subprocess.list2cmdline(cmd))
                else:
                    try: winreg.DeleteValue(k, RUN_NAME)
                    except FileNotFoundError: pass
        elif sys.platform == "darwin":
            if on:
                os.makedirs(os.path.dirname(MAC_AGENT), exist_ok=True)
                items = "".join(f"<string>{a}</string>" for a in cmd)
                with open(MAC_AGENT, "w", encoding="utf-8") as f:
                    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
                            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.ghost.jarvis</string>'
                            f'<key>ProgramArguments</key><array>{items}</array><key>RunAtLoad</key><true/></dict></plist>\n')
            elif os.path.exists(MAC_AGENT): os.remove(MAC_AGENT)
        else:
            if on:
                os.makedirs(os.path.dirname(LINUX_AUTOSTART), exist_ok=True)
                with open(LINUX_AUTOSTART, "w", encoding="utf-8") as f:
                    f.write(f"[Desktop Entry]\nType=Application\nName=Jarvis\nExec={subprocess.list2cmdline(cmd)}\nX-GNOME-Autostart-enabled=true\n")
            elif os.path.exists(LINUX_AUTOSTART): os.remove(LINUX_AUTOSTART)
        print(f"[APP] start with the computer: {'on' if on else 'off'}")
    except Exception as e: print(f"[APP] couldn't change starting with the computer: {e}")

def first_run_startup(home):
    """The installed app starts with the computer unless he's turned that off (remembered in config.json)."""
    import json
    p = os.path.join(home, "config.json")
    try: cfg = json.load(open(p, encoding="utf-8"))
    except Exception: cfg = {}
    if "start_with_pc" in cfg or not FROZEN: return
    set_startup(True); cfg["start_with_pc"] = True
    try:
        with open(p, "w", encoding="utf-8") as f: json.dump(cfg, f, indent=2)
    except OSError: pass


def start_wake(home):
    cmd = [sys.executable, "--wake"] if FROZEN else [sys.executable, os.path.abspath(__file__), "--wake"]
    try:
        log = open(os.path.join(home, "wake.log"), "a", encoding="utf-8")
        return subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:
        print(f"[APP] wake listener failed: {e}"); return None


def version_tuple(v):
    """'desktop-v1.0.12' -> (1, 0, 12); anything unreadable sorts as oldest."""
    try: return tuple(int(x) for x in v.rsplit("v", 1)[-1].strip().split("."))
    except ValueError: return (0,)


def pick_asset(assets):
    """The download for this computer from a release's files."""
    names = {a["name"]: a["browser_download_url"] for a in assets}
    if sys.platform == "win32": want = ["Jarvis-Setup.exe"]
    elif sys.platform == "darwin":
        import platform
        arm = platform.machine() == "arm64" or subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True).stdout.strip() == "1"
        want = ["Jarvis-Mac-AppleSilicon.dmg", "Jarvis-Mac-Intel.dmg"] if arm else ["Jarvis-Mac-Intel.dmg"]
    else: want = []
    return next(((n, names[n]) for n in want if n in names), (None, None))


def add_update_routes(app, home, quit_all):
    """/update/check and /update/install for the page's Update button. Updates come from the GitHub Releases the build publishes to."""
    import requests
    def read(name, default=""):
        try: return open(os.path.join(BUNDLE, name), encoding="utf-8").read().strip()
        except OSError: return default
    current, repo = read("VERSION", "0"), read("UPDATE_REPO")
    state = {"state": "idle", "pct": 0, "error": "", "latest": None, "asset": None}

    def check():
        r = requests.get(f"https://api.github.com/repos/{repo}/releases/latest", timeout=10, headers={"Accept": "application/vnd.github+json"})
        r.raise_for_status(); rel = r.json()
        name, url = pick_asset(rel.get("assets", []))
        state["latest"] = rel.get("tag_name", "").rsplit("v", 1)[-1]
        state["asset"] = (name, url) if url and version_tuple(state["latest"]) > version_tuple(current) else None

    def download_and_install():
        name, url = state["asset"]
        folder = os.path.join(home, "update"); os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        try:
            part, total = path + ".part", 0
            if os.path.exists(part): os.remove(part)
            for attempt in range(8):   # a dropped connection picks up where it stopped instead of starting the 225 MB again
                got = os.path.getsize(part) if os.path.exists(part) else 0
                try:
                    # only ever the release's own file, never a URL from the page
                    with requests.get(url, stream=True, timeout=30, headers={"Range": f"bytes={got}-"} if got else {}) as r:
                        r.raise_for_status()
                        if got and r.status_code != 206: got = 0      # server ignored the range: start over
                        if not total: total = got + int(r.headers.get("content-length") or 0)
                        with open(part, "ab" if got else "wb") as f:
                            for chunk in r.iter_content(1 << 20):
                                f.write(chunk); got += len(chunk); state["pct"] = int(got * 100 / total) if total else 0
                    if not total or got >= total: break
                except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError) as e:
                    if attempt == 7: raise
                    print(f"[UPDATE] connection dropped at {got >> 20} MB ({type(e).__name__}), resuming"); time.sleep(3 + attempt * 2)
            os.replace(part, path)
            state["state"] = "installing"; print(f"[UPDATE] installing {name}")
            if sys.platform == "win32":
                # the installer closes this copy, replaces the program files and starts the new Jarvis; user data stays in %APPDATA%
                subprocess.Popen([path, "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"], close_fds=True)
            else:
                app_path = os.path.abspath(os.path.join(os.path.dirname(sys.executable), "..", ".."))   # .../Jarvis.app
                script = os.path.join(folder, "install.sh")
                with open(script, "w") as f: f.write(f"""#!/bin/sh
while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.5; done
MNT="{folder}/mnt"; mkdir -p "$MNT"
hdiutil attach -nobrowse -noautoopen -mountpoint "$MNT" "{path}" || exit 1
rm -rf "{app_path}.old"; mv "{app_path}" "{app_path}.old" && {{ ditto "$MNT/Jarvis.app" "{app_path}" || {{ rm -rf "{app_path}"; mv "{app_path}.old" "{app_path}"; }}; }}; rm -rf "{app_path}.old"
hdiutil detach "$MNT" -quiet
open "{app_path}"
""")
                subprocess.Popen(["/bin/sh", script], start_new_session=True, close_fds=True)
            threading.Timer(1.5, quit_all).start()
        except Exception as e:
            state.update(state="error", error=f"{type(e).__name__}: {e}"); print(f"[UPDATE] failed: {e}")

    @app.get("/update/check")
    def update_check():
        if state["state"] == "idle" and repo:
            try: check()
            except Exception as e: print(f"[UPDATE] check failed: {type(e).__name__}")
        return {"current": current, "latest": state["latest"], "available": bool(state["asset"]),
                "state": state["state"], "pct": state["pct"], "error": state["error"]}

    @app.post("/update/install")
    def update_install():
        if state["state"] in ("downloading", "installing"): return {"ok": True}
        if not state["asset"]: return {"ok": False, "error": "No update available."}
        state.update(state="downloading", pct=0, error="")
        threading.Thread(target=download_and_install, daemon=True).start()
        return {"ok": True}


def add_app_routes(app, restore, quit_all):
    """For the floating head: bring the window back, quit, and the start-with-the-computer switch."""
    @app.post("/app/open_window")
    def app_open_window(): restore(); return {"ok": True}

    @app.post("/app/quit")
    def app_quit():
        threading.Timer(0.3, quit_all).start(); return {"ok": True}

    @app.get("/app/startup")
    def app_startup_get(): return {"on": startup_on()}

    @app.post("/app/startup")
    def app_startup_set(payload: dict):
        set_startup(bool(payload.get("on"))); return {"on": startup_on()}


def main():
    import multiprocessing; multiprocessing.freeze_support()   # libraries that spawn workers need this inside an exe
    home = data_dir(); os.makedirs(home, exist_ok=True)
    os.environ["JARVIS_HOME"] = home
    if FROZEN:   # no console window: everything printed goes to a log the user can send when something breaks
        sys.stdout = sys.stderr = open(os.path.join(home, "jarvis.log" if "--wake" not in sys.argv else "wake.log"), "a", encoding="utf-8", buffering=1)
    if BUNDLE not in sys.path: sys.path.insert(0, BUNDLE)
    os.chdir(home)

    if "--wake" in sys.argv:
        import wake; wake.main(); return
    if "--head" in sys.argv:            # never an error box over Jarvis: a head that can't start just writes why to head.log
        try: import mini_head; mini_head.main()
        except Exception as e:
            import traceback; print(f"[HEAD] couldn't start: {type(e).__name__}: {e}"); traceback.print_exc()
        return

    lock = socket.socket()
    try: lock.bind(("127.0.0.1", PORT + 1))   # held while this copy runs: opening Jarvis again brings his window back
    except OSError:
        try:
            import urllib.request
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                urllib.request.Request(URL + "/app/open_window", data=b"{}", headers={"Content-Type": "application/json"}), timeout=3)
        except Exception: open_window(home)
        return
    print(f"[APP] Jarvis starting, data in {home}")
    sync_app_files(home)
    first_run_startup(home)
    wake_proc = start_wake(home)
    head_proc = start_head(home)
    S = {"win": None, "quitting": False, "loop": False}

    def window_loop(hidden):
        """Owns the window. Closing it (Windows) brings the page back minimised, so he keeps listening; the floating head shows."""
        S["loop"] = True; quick = 0
        try:
            while not S["quitting"]:
                t = time.time()
                S["win"] = open_window(home, hidden=hidden)
                if S["win"] is None: return                      # opened in the normal browser: nothing of ours to watch
                S["win"].wait()
                if S["quitting"]: return
                if not WIN: print("[APP] window closed, stopping"); quit_all(); return
                quick = quick + 1 if time.time() - t < 4 else 0   # the browser handed off or crashed: don't spin
                if quick >= 3: print("[APP] the window keeps closing straight away; not reopening it"); return
                print("[APP] window closed: still running, as the floating head"); hidden = True
        finally: S["loop"] = False

    def restore():
        if WIN and restore_window_win(): return
        if S["loop"] and S["win"] is not None and S["win"].poll() is None: return    # Mac/Linux: it's open already
        threading.Thread(target=window_loop, args=(False,), daemon=True).start()

    def quit_all():
        S["quitting"] = True
        for p in (wake_proc, head_proc, S["win"]):
            if p and p.poll() is None: p.terminate()
        os._exit(0)

    threading.Thread(target=window_loop, args=("--background" in sys.argv,), daemon=True).start()
    try:
        import uvicorn, server
        if FROZEN: add_update_routes(server.app, home, quit_all)
        add_app_routes(server.app, restore, quit_all)
        server.APP_HOOKS = {"set_startup": set_startup, "restore": restore}
        uvicorn.run(server.app, host="127.0.0.1", port=PORT)
    finally:
        quit_all()


if __name__ == "__main__":
    main()
