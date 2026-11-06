# PyInstaller recipe for Jarvis.exe / Jarvis.app. Build:  pyinstaller desktop/jarvis.spec --noconfirm   (from the repo root)
import os, sys
from PyInstaller.utils.hooks import collect_all, collect_submodules

HERE = os.path.abspath(SPECPATH)
APP = os.path.join(HERE, "app")

datas = [(os.path.join(APP, f), ".") for f in ("index.html", "hud_extra.js", "nav.js", "nav_core.js", "VERSION")]
datas += [(os.path.join(APP, "models"), "models")]
if os.path.exists(os.path.join(APP, "UPDATE_REPO")): datas += [(os.path.join(APP, "UPDATE_REPO"), ".")]   # written by the build: where updates come from
if os.path.exists(os.path.join(APP, "google_client.json")): datas += [(os.path.join(APP, "google_client.json"), ".")]   # written by the build: Sign in with Google
if os.path.exists(os.path.join(APP, "windy_key")): datas += [(os.path.join(APP, "windy_key"), ".")]   # written by the build: the webcams' Windy key
if os.path.exists(os.path.join(APP, "spotify_client.json")): datas += [(os.path.join(APP, "spotify_client.json"), ".")]   # written by the build: Spotify search
binaries, hidden = [], ["server", "features", "wake", "nav", "delivery", "spotify_auth", "google_auth_oauthlib.flow", "google.oauth2.credentials"]
hidden += collect_submodules("uvicorn")
# libraries that load model files, native libraries or templates from their own folder at run time
for pkg in ("openwakeword", "faster_whisper", "ctranslate2", "sherpa_onnx", "fastembed", "onnxruntime", "piper", "tokenizers",
            "docx", "reportlab", "googleapiclient", "pypdf", "ddgs", "groq", "spotipy", "pyaudio"):
    try:
        d, b, h = collect_all(pkg); datas += d; binaries += b; hidden += h
    except Exception as e:
        print(f"[spec] skipped {pkg}: {e}")
if sys.platform == "win32": hidden += ["uiautomation"]

a = Analysis([os.path.join(HERE, "jarvis_app.py")], pathex=[APP], binaries=binaries, datas=datas, hiddenimports=hidden,
             excludes=["tkinter", "matplotlib", "torch", "tensorflow", "IPython", "pytest"])
pyz = PYZ(a.pure)
icon = os.path.join(HERE, "icon.ico" if sys.platform == "win32" else "icon.icns")
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Jarvis", console=False, icon=icon if os.path.exists(icon) else None)
coll = COLLECT(exe, a.binaries, a.datas, name="Jarvis")
if sys.platform == "darwin":
    app = BUNDLE(coll, name="Jarvis.app", icon=icon if os.path.exists(icon) else None, bundle_identifier="com.ghost.jarvis",
                 info_plist={"NSMicrophoneUsageDescription": "Jarvis listens for \"Hey Jarvis\" and to what you say.",
                             "NSCameraUsageDescription": "Jarvis uses the camera for hand gestures and to recognise you.",
                             "CFBundleShortVersionString": open(os.path.join(APP, "VERSION")).read().strip(), "LSMinimumSystemVersion": "12.0"})
