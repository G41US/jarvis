# Jarvis for Windows and Mac

The PC Jarvis as a normal app: `Jarvis-Setup.exe` for Windows, `Jarvis-Mac-AppleSilicon.dmg` / `Jarvis-Mac-Intel.dmg` for Mac.
GitHub builds both whenever something in `desktop/` changes (Actions tab, "Build Jarvis desktop").

## What a new user does

1. **Windows:** run `Jarvis-Setup.exe`. If Windows says it protected the PC: *More info* > *Run anyway*.
   **Mac:** open the `.dmg`, drag Jarvis into Applications, open it. The first time macOS blocks it:
   System Settings > Privacy & Security > *Open Anyway*.
2. Jarvis opens its own window and asks for a free Groq key: *Get my free key* opens Groq, they press
   *Create API Key*, copy it, paste it, *Connect*. Done once.
3. Allow the microphone and camera when asked. The first start downloads his voice and hearing (about 400 MB).

Each user's memory, key and voices stay in their own folder: `%APPDATA%\Jarvis` on Windows,
`~/Library/Application Support/Jarvis` on Mac. Uninstalling the app keeps them.
Closing the Jarvis window quits Jarvis. Problems: `jarvis.log` in that folder says what went wrong.

**Updates:** each build is a new version. When Jarvis sees a newer one on the Releases page, an *Update Jarvis to 1.0.N* button
appears at the top. One click downloads it, installs it and reopens Jarvis (no security warnings the second time).
It checks the downloads repo below (`RELEASE_REPO`); while that isn't set up, the app can't see the private releases and the button never shows.
Self-check: `python desktop/test_update.py`.

## Letting anyone download it

This repository is private, so its Releases only work for you. To share:

1. Make a new **public** repository for the downloads, for example `jarvis-download` (it can stay empty).
2. github.com > Settings > Developer settings > Fine-grained tokens > *Generate new token*:
   only that repository, permission *Contents: Read and write*.
3. In this repository: Settings > Secrets and variables > Actions.
   Secret `RELEASE_TOKEN` = the token. Variable `RELEASE_REPO` = `G41US/jarvis-download`.

The next build puts both files on `github.com/G41US/jarvis-download/releases/latest`; that page is the link to share.

## Notes

- Not code-signed, hence the warnings above. Removing them needs an Apple Developer account ($99/year, for notarising)
  and a Windows code-signing certificate.
- Windows-only parts (answering WhatsApp calls, the Spotify speaker) are quietly off on a Mac.
- Mac builds use GitHub's Mac machines, which count 10x against the free Actions minutes of a private repo.
- Run from source: `pip install -r desktop/app/requirements.txt`, then `python desktop/jarvis_app.py`.
