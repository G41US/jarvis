"""Self-check for the Update button's server side. Run: python desktop/test_update.py (needs fastapi + requests)."""
import io, os, sys, tempfile, time, threading, types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jarvis_app as ja

# version order and asset choice
assert ja.version_tuple("desktop-v1.0.10") > ja.version_tuple("1.0.9") > ja.version_tuple("junk")
assets = [{"name": n, "browser_download_url": "u/" + n} for n in ("Jarvis-Setup.exe", "Jarvis-Mac-Intel.dmg")]
real = sys.platform
sys.platform = "win32"; assert ja.pick_asset(assets) == ("Jarvis-Setup.exe", "u/Jarvis-Setup.exe")
sys.platform = "linux"; assert ja.pick_asset(assets) == (None, None)
sys.platform = real

# a fake GitHub: /latest says v1.0.9 with a 3 MB installer
PAYLOAD = os.urandom(3 << 20); RANGES = []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.endswith("/releases/latest"):
            body = ('{"tag_name": "desktop-v1.0.9", "assets": [{"name": "Jarvis-Setup.exe", "browser_download_url": "http://127.0.0.1:%d/dl"}]}'
                    % self.server.server_port).encode()
        else:   # the installer: the first download drops halfway (like a flaky line), the resume asks for the rest
            rng = self.headers.get("Range")
            if rng:
                start = int(rng.split("=")[1].split("-")[0]); body = PAYLOAD[start:]
                self.send_response(206); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
                RANGES.append(start); return
            self.send_response(200); self.send_header("Content-Length", str(len(PAYLOAD))); self.end_headers()
            self.wfile.write(PAYLOAD[:len(PAYLOAD) // 2]); self.wfile.flush(); self.connection.shutdown(2); return
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
srv = ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()

import requests
_get = requests.get
requests.get = lambda url, **k: _get(url.replace("https://api.github.com", f"http://127.0.0.1:{srv.server_port}"), **k)

bundle, home = tempfile.mkdtemp(), tempfile.mkdtemp()
open(os.path.join(bundle, "VERSION"), "w").write("1.0.3"); open(os.path.join(bundle, "UPDATE_REPO"), "w").write("ghost-example/downloads")
ja.BUNDLE = bundle
launched, quit_called = [], threading.Event()
ja.subprocess = types.SimpleNamespace(Popen=lambda cmd, **k: launched.append(cmd), run=ja.subprocess.run)
from fastapi import FastAPI
from fastapi.testclient import TestClient
app = FastAPI(); ja.add_update_routes(app, home, quit_called.set); c = TestClient(app)
c.get("/nothing")              # load the HTTP client's modules before pretending to be Windows
sys.platform = "win32"
s = c.get("/update/check").json()
assert s["available"] and s["latest"] == "1.0.9" and s["current"] == "1.0.3", s
assert c.post("/update/install").json()["ok"]
assert quit_called.wait(15), c.get("/update/check").json()
sys.platform = real
dl = os.path.join(home, "update", "Jarvis-Setup.exe")
assert open(dl, "rb").read() == PAYLOAD, "download corrupted"
assert RANGES and RANGES[0] > 0, f"didn't resume: {RANGES}"
assert launched and launched[0][0] == dl and "/SILENT" in launched[0], launched
assert c.get("/update/check").json()["state"] == "installing"

# up to date: no button
open(os.path.join(bundle, "VERSION"), "w").write("1.0.9")
app2 = FastAPI(); ja.add_update_routes(app2, home, lambda: None)
assert not TestClient(app2).get("/update/check").json()["available"]
print("update self-check ok")
