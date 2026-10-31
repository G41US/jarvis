# Jarvis for Android

A real Android app (APK). It runs on its own on the phone: no PC, no localhost, no server.
The face, the wake word ("Hey Jarvis"), voice, the Groq brain, worldwide navigation and the delivery copilot all live inside the app.

You do not need Android Studio. GitHub builds the APK for you, for free.

## Build it (one time, about 15 minutes)

1. **The faces are already in.** Jarvis's male and female faces (glowing particle heads) ship in `app/src/main/assets/www/models/faces/`.
2. **Make a free GitHub account** (github.com) and create a **private** repository, for example `jarvis-android`.
   Keep it private: it contains the app's signing key.
3. **Upload this whole project** to that repository. Easiest: install *GitHub Desktop*, choose *Add an existing repository / Create repository*
   from this folder, then *Publish repository* (tick "Keep this code private").
   Using the website instead? Drag the folder contents into the "uploading an existing file" page, then check that `.github/workflows/build-apk.yml` arrived
   (if not: *Add file > Create new file*, name it `.github/workflows/build-apk.yml`, paste the file's contents).
   A model file bigger than 25 MB can't go through the website, use GitHub Desktop.
4. Open the repository's **Actions** tab. The build **"Build Jarvis APK"** starts by itself (or press *Run workflow*). It takes 5 to 8 minutes.
5. **Download on your phone:** open the repository in the phone's browser, go to **Releases > Jarvis (latest build) > Jarvis-build-NN.apk** (NN is the build number), tap it, and allow
   "Install unknown apps" for your browser when Android asks. (Prefer a computer? The same file is under the finished run, *Artifacts > Jarvis-apk*.)

New version later? Push the change, wait for the build, install the new `Jarvis-build-NN.apk` over the old one (the highest number is the newest). Your settings stay.

## First start

1. Allow **Microphone**, **Location** and **Notifications** when asked.
2. The settings screen opens. Paste your **Groq API key** (console.groq.com/keys, free), tap **Test connection**, then **Save**.
   (Builds made with the Jarvis proxy skip this step: see `server/README.md`.)
3. Say **"Hey Jarvis"**. The wake word runs on the phone itself, like `wake.py` on the PC; you can also say it in one breath:
   "Hey Jarvis, what's the weather". Tapping the mic button is only a shortcut.
4. Not hearing you? Settings > **Hearing** shows the live microphone level, the wake score as you say "Hey Jarvis", and the last thing heard.
5. For listening with the screen off: Android Settings > Apps > Jarvis > Battery > **Unrestricted**.
6. **Your PC voices:** on Wi-Fi, Alan (male) or Amy (female) downloads by itself the first time (about 67 MB). On mobile data,
   Settings > Voice and face has a Download button. Until then Jarvis uses the phone's voice.
7. **Offer reader:** Settings > Offer reader > Turn on, then switch on "Jarvis offer reader" in the list Android opens.
   If Android says the setting is restricted (it does for apps installed from a download): Android Settings > Apps > Jarvis >
   three-dot menu > **Allow restricted settings**, then try again. Your floors are under Navigation and deliveries.

**No key for anyone:** see `server/README.md` (three GitHub secrets; the build deploys the service). **Play Store:** see `playstore/PLAYSTORE.md`.

Try: "Hey Jarvis, navigate to Phoenix Sky Harbor Airport." / "I accepted a DoorDash order from Chipotle to 123 Main Street, it pays 8 dollars." /
"What's next?" / "Picked it up." / "Delivered." / "How much have I made today?"

## What is in the phone version

Face and voice, wake word, Groq brain with tools (weather, web search, timers, reminders, memory, notes, news, crypto, currency, translate, calculator),
turn-by-turn navigation on a map with spoken guidance (worldwide, free services), the delivery stack optimiser with earnings, offer check and
"is this worth it", open apps, play music (Spotify/YouTube Music), call and text (opens the dialer / message with it filled in).

## Different from the PC version

- No face ID, files, clipboard, screen reading or calendar yet.
- Voices: the PC's Piper voices (Alan and Amy) run on the phone once downloaded; the phone's own voices are the fallback.
- No live traffic: route times are the free services' normal-traffic estimates.
- Turn-by-turn instructions are in English.
- Listening in the background (screen off, another app on top) is best effort. Android decides, and some phones are stricter than others.

## Before a public release

- **Wake word licence:** the "Hey Jarvis" model comes from openWakeWord and is licensed for **non-commercial use only**
  (CC BY-NC-SA 4.0), same as on the PC. Fine for you and testers; a paid app needs its own model in `app/src/main/assets/wake/hey_jarvis.onnx`.
- **No key for users:** set up the proxy in `server/README.md` so the app uses your Groq account instead of asking each user for a key.

## Honest status

The app logic, page and phone-side code were tested in a headless browser with a simulated Android bridge (`python3 tests/e2e/e2e.py`)
and compared line by line with the PC engines (`TZ=UTC node tests/golden.test.mjs`). The Java shell was type-checked, but the
Android build itself and the app on a real phone have **not** been run by me: that happens on GitHub and on your phone.
If the build fails, open the red run in the Actions tab, copy the last error lines and send them over.

## Layout

```
app/src/main/java/com/jarvis/assistant/   Android shell: MainActivity, Bridge (speech, http, apps, music), VoiceEngine + WakeWord (mic, "Hey Jarvis"),
                                          SileroVad (knows when you've stopped talking, even in noise; MIT licence), JarvisService
server/                                   optional proxy that holds your Groq key (Cloudflare Worker)
app/src/main/assets/www/                  the page and the on-device brain (local/*.js)
pc_source/                                your PC page; tools/make_www.py turns it into the phone page
.github/workflows/build-apk.yml           the cloud build
tests/                                    golden tests, end-to-end test, Android stand-ins for type-checking
```
