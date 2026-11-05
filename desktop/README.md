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

## Letting anyone download it (without your name on it)

This repository is private, so its Releases only work for you. The downloads go to a public repo under a separate
"ghost" identity instead. A Release page shows who published it, so the token must belong to that identity, not to you.

1. Sign out of GitHub (or use a private window) and make a new free account, e.g. `ghost-builds`, with an email
   that isn't linked to you.
2. Signed in as that account: *+* > *New organization* > Free. Name it e.g. `ghost-apps` (plain `ghost` is taken).
3. In the organization: *New repository* `downloads`, **Public**, tick *Add a README* (a release needs one commit).
4. Still as that account: Settings > Developer settings > Fine-grained tokens > *Generate new token*.
   Resource owner: the organization. Repository: `downloads` only. Permission *Contents: Read and write*.
5. Back on your own account, in this repository: Settings > Secrets and variables > Actions.
   Secret `RELEASE_TOKEN` = the token. Variable `RELEASE_REPO` = `ghost-apps/downloads`.

The next build puts the files on `github.com/ghost-apps/downloads/releases/latest`: that's the link to share, and
installed copies take their updates from there. The installer shows no publisher, the Mac app is `com.ghost.jarvis`,
and the phone handoff (which used your Cloudflare service) is off in this app.

## Notes

- Not code-signed, hence the warnings above. Removing them needs an Apple Developer account ($99/year, for notarising)
  and a Windows code-signing certificate.
- Windows-only parts (answering WhatsApp calls, the Spotify speaker) are quietly off on a Mac.
- Builds run only when started (Actions tab > Build Jarvis desktop > Run workflow). Windows builds on your own laptop (below) unless
  you tick "cloud"; tick "mac" for a Mac build on GitHub's machines (they count 10x against the 2,000 free minutes a month).

## Building on your own laptop (free, unlimited)

The laptop is registered once as this repo's build machine (a "self-hosted runner"). After that, Run workflow builds there.
1. github.com/G41US/jarvis > Settings > Actions > Runners > **New self-hosted runner** > **Windows**, x64.
2. Open **PowerShell** (not as admin), and run the commands GitHub shows under *Download* and *Configure*, one block at a time.
   When `config.cmd` asks: runner group: Enter; name: `jarvis-laptop`; **additional labels: `jarvis-laptop`**; work folder: Enter;
   **run as service: Y**; service account: Enter.
3. The runner then shows as *Idle* on that Runners page. It starts with Windows; builds only need the laptop on and online.
Remove it any time from the same page (and `.\config.cmd remove` in its folder).
- Run from source: `pip install -r desktop/app/requirements.txt`, then `python desktop/jarvis_app.py`.
