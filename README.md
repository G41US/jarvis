# Jarvis for Android

A real Android app (APK). It runs on its own on the phone: no PC, no localhost, no server.
The face, the wake word ("Hey Jarvis"), voice, the Groq brain, worldwide navigation and the delivery copilot all live inside the app.

You do not need Android Studio. GitHub builds the APK for you, for free.

## Build it (one time, about 15 minutes)

1. **Put the Jarvis face in.** Copy the `models` folder from your PC Jarvis folder (it has `adam.glb`, `gideon.png`...) into
   `app/src/main/assets/www/models/` in this project. If you skip this, Jarvis shows the online face instead.
2. **Make a free GitHub account** (github.com) and create a **private** repository, for example `jarvis-android`.
   Keep it private: it contains the app's signing key.
3. **Upload this whole project** to that repository. Easiest: install *GitHub Desktop*, choose *Add an existing repository / Create repository*
   from this folder, then *Publish repository* (tick "Keep this code private").
   Using the website instead? Drag the folder contents into the "uploading an existing file" page, then check that `.github/workflows/build-apk.yml` arrived
   (if not: *Add file > Create new file*, name it `.github/workflows/build-apk.yml`, paste the file's contents).
   A model file bigger than 25 MB can't go through the website, use GitHub Desktop.
4. Open the repository's **Actions** tab. The build **"Build Jarvis APK"** starts by itself (or press *Run workflow*). It takes 5 to 8 minutes.
5. **Download on your phone:** open the repository in the phone's browser, go to **Releases > Jarvis (latest build) > Jarvis.apk**, tap it, and allow
   "Install unknown apps" for your browser when Android asks. (Prefer a computer? The same file is under the finished run, *Artifacts > Jarvis-apk*.)

New version later? Push the change, wait for the build, install the new `Jarvis.apk` over the old one. Your settings stay.

## First start

1. Allow **Microphone**, **Location** and **Notifications** when asked.
2. The settings screen opens. Paste your **Groq API key** (console.groq.com/keys, free), tap **Test connection**, then **Save**.
3. Say **"Hey Jarvis"**, or tap **TALK**.
4. For listening with the screen off: Android Settings > Apps > Jarvis > Battery > **Unrestricted**.

Try: "Hey Jarvis, navigate to Phoenix Sky Harbor Airport." / "I accepted a DoorDash order from Chipotle to 123 Main Street, it pays 8 dollars." /
"What's next?" / "Picked it up." / "Delivered." / "How much have I made today?"

## What is in the phone version

Face and voice, wake word, Groq brain with tools (weather, web search, timers, reminders, memory, notes, news, crypto, currency, translate, calculator),
turn-by-turn navigation on a map with spoken guidance (worldwide, free services), the delivery stack optimiser with earnings, offer check and
"is this worth it", open apps, play music (Spotify/YouTube Music), call and text (opens the dialer / message with it filled in).

## Different from the PC version

- No face ID, files, clipboard, screen reading or calendar (those need a PC).
- The wake word is detected from the Groq transcript (the PC used a local wake-word model), so it needs a data connection.
  Groq's free tier limits speech requests per minute; if you hit it Jarvis says so and recovers.
- No live traffic: route times are the free services' normal-traffic estimates.
- Turn-by-turn instructions are in English.
- Listening in the background (screen off, another app on top) is best effort. Android decides, and some phones are stricter than others.

## Honest status

The app logic, page and phone-side code were tested in a headless browser with a simulated Android bridge (`python3 tests/e2e/e2e.py`)
and compared line by line with the PC engines (`TZ=UTC node tests/golden.test.mjs`). The Java shell was type-checked, but the
Android build itself and the app on a real phone have **not** been run by me: that happens on GitHub and on your phone.
If the build fails, open the red run in the Actions tab, copy the last error lines and send them over.

## Layout

```
app/src/main/java/com/jarvis/assistant/   Android shell: MainActivity, Bridge (speech, http, apps, music), JarvisService
app/src/main/assets/www/                  the page and the on-device brain (local/*.js)
pc_source/                                your PC page; tools/make_www.py turns it into the phone page
.github/workflows/build-apk.yml           the cloud build
tests/                                    golden tests, end-to-end test, Android stand-ins for type-checking
```
