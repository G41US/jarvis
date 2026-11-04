import os, webbrowser
from pathlib import Path


def _load_dotenv():
    """Read KEY=VALUE lines from .env next to this file. Real environment variables win."""
    p = Path(__file__).resolve().parent / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

from spotipy.oauth2 import SpotifyOAuth

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
REDIRECT = os.environ.get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played"

if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env file first")
    raise SystemExit(1)

auth = SpotifyOAuth(
    client_id=CLIENT_ID, client_secret=CLIENT_SECRET,
    redirect_uri=REDIRECT, scope=SCOPE,
    cache_path=".spotify_cache", open_browser=True,
)
token = auth.get_access_token(as_dict=False)
print("Auth OK. Token cached to .spotify_cache")
