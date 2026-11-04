"""Jarvis desktop app: what Jarvis.exe (Windows) and Jarvis.app (Mac) run.

Starts the Jarvis server, the "Hey Jarvis" listener and a Jarvis window, then quits when that window is closed.
Everything the user owns (memory, their key in .env, downloaded voices, settings) lives in a per-user folder:
  Windows  %APPDATA%\\Jarvis          Mac  ~/Library/Application Support/Jarvis
Run from source for testing:  python desktop/jarvis_app.py
"""
import os, sys, shutil, socket, subprocess, threading, webbrowser

FROZEN = getattr(sys, "frozen", False)
BUNDLE = getattr(sys, "_MEIPASS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"
WEB_FILES = ["index.html", "hud_extra.js", "nav.js", "nav_core.js"]
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


def open_window(home):
    """Returns the window's process when we own it (closing it quits Jarvis), else None (opened in the normal browser)."""
    if os.environ.get("JARVIS_NO_WINDOW"): return None   # headless: the build check, or a home server
    splash = os.path.join(home, "starting.html")
    with open(splash, "w", encoding="utf-8") as f: f.write(SPLASH)
    start = URL if port_open() else "file:///" + splash.replace(os.sep, "/").lstrip("/")
    exe = find_browser()
    if not exe:
        webbrowser.open(start); return None
    return subprocess.Popen([exe, f"--app={start}", f"--user-data-dir={os.path.join(home, 'browser')}", "--autoplay-policy=no-user-gesture-required",
                             "--start-maximized", "--no-first-run", "--no-default-browser-check"])


def start_wake(home):
    cmd = [sys.executable, "--wake"] if FROZEN else [sys.executable, os.path.abspath(__file__), "--wake"]
    try:
        log = open(os.path.join(home, "wake.log"), "a", encoding="utf-8")
        return subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:
        print(f"[APP] wake listener failed: {e}"); return None


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

    lock = socket.socket()
    try: lock.bind(("127.0.0.1", PORT + 1))   # held while this copy runs: opening Jarvis again only brings up a window
    except OSError:
        open_window(home); return
    print(f"[APP] Jarvis starting, data in {home}")
    sync_app_files(home)
    wake_proc = start_wake(home)

    def window():
        win = open_window(home)
        if win is not None:
            win.wait()
            print("[APP] window closed, stopping"); quit_all()

    def quit_all():
        if wake_proc and wake_proc.poll() is None: wake_proc.terminate()
        os._exit(0)

    threading.Thread(target=window, daemon=True).start()
    try:
        import uvicorn, server
        uvicorn.run(server.app, host="127.0.0.1", port=PORT)
    finally:
        quit_all()


if __name__ == "__main__":
    main()
