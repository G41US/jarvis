# Putting Jarvis on the Google Play Store

The build already does the technical part: it targets Android 16 (API 36, required for new apps since 31 August 2026),
draws correctly edge to edge, and makes a signed Play bundle (`Jarvis.aab`) once step 2 is done.
What's left is your Play Console account and Google's forms. Do these in order.

## 1. Before anything else
- **Wake word licence.** The "Hey Jarvis" model (openWakeWord) is licensed for **non-commercial use only** (CC BY-NC-SA 4.0).
  Before you charge money or run ads, replace `app/src/main/assets/wake/hey_jarvis.onnx` with a model you're allowed to ship.
  See "Wake word options" at the end.
- **The name.** "Jarvis" is also Marvel's Iron Man AI. Many apps use the name, but Google can remove apps after a trademark
  complaint. A distinct store name such as "Jarvis Driver Copilot" lowers that risk; don't use Iron Man images or wording.
- **DoorDash and Uber names.** Say the app "works alongside" the Dasher and Uber Driver apps. No logos, nothing implying it's
  official or endorsed.
- **The app ID.** `com.jarvis.assistant` must be unique on Google Play and can never change after the first upload.
  If the Console says it's taken, change `applicationId` in `app/build.gradle` (for example `com.yourname.jarvis`) and rebuild.

## 2. Make the Play bundle
GitHub repo > Settings > Secrets and variables > Actions > New repository secret:
- `UPLOAD_KEY_PASSWORD`: a long password you keep somewhere safe (a password manager).

Run **Build Jarvis APK** again. The first run creates your upload key (saved to this private repo, locked with that password).
Every run then produces **Jarvis.aab** under the run's Artifacts. That file is what you upload to Play.
Also set up the no-key service (`server/README.md`) first, so Play users never see a key screen.

## 3. Play Console
1. Create a developer account at play.google.com/console ($25 once, plus identity verification).
2. **New personal accounts must run a closed test first:** at least **12 testers** opted in for **14 days** in a row before
   you can publish to everyone. Start it early: invite drivers you know.
3. Create the app: name, default language English (US), App, Free.
4. Turn on **Play App Signing** (default) and upload `Jarvis.aab` to the closed testing track.

## 4. Store listing (ready to paste)
- **Short description** (80 max): `Hands-free copilot for delivery drivers: stack orders, route, judge offers by voice.`
- **Full description:**
  > Jarvis is a hands-free voice copilot for delivery drivers. Say "Hey Jarvis" and keep your eyes on the road.
  >
  > • Hears an offer for you: when the Dasher or Uber Driver app shows an offer, Jarvis tells you "take it", "your call" or
  >   "pass", with the pay per mile and per hour against your own minimums. You still accept or decline in the app.
  > • Plans your stack: tell Jarvis the orders you accepted (up to four) and he works out the fastest pickup and drop-off order.
  > • Turn-by-turn navigation anywhere, with spoken directions and a car-style map.
  > • Tracks your earnings, per hour and per mile.
  > • Everyday help: weather, timers, reminders, music, calls and texts, quick answers.
  >
  > Jarvis works alongside the DoorDash and Uber Driver apps. He is not affiliated with or endorsed by DoorDash or Uber.
- **Graphics:** `icon-512.png` and `feature-1024x500.png` in this folder. Add 4 to 8 phone screenshots from your phone
  (the face, a route card, navigation, Settings > Offer reader).
- **Category:** Maps & Navigation. **Contact email:** a business email you check.
- **Privacy policy URL:** the published privacy policy page (see `PRIVACY.md`; fill in your contact email first).

## 5. App content forms
**Target audience:** 18 and over. **Ads:** No. **Content rating:** complete the questionnaire (no violence or user content: Everyone).

**Data safety** (what to tick):
| Data | Collected | Shared | Why | Notes |
|---|---|---|---|---|
| Audio (voice) | Yes | Yes, with Groq (speech-to-text and AI) | App functionality | Only after "Hey Jarvis"; not stored by the app's service |
| Approximate and precise location | Yes | Yes, with map/routing services | App functionality (navigation) | Not stored by us |
| Other user-generated content (questions, notes) | Yes | Yes, with Groq | App functionality | Notes and memories stay on the phone |
| App interactions / device ID | Yes (random ID) | No | Fraud prevention (rate limits) | Random, not tied to identity |
Data is encrypted in transit: **Yes** (HTTPS). Users can delete data: **Yes** (say "forget everything", or clear app data).

**Accessibility API declaration** (the offer reader uses an AccessibilityService):
> The "Jarvis offer reader" reads the text of delivery offers shown by the DoorDash Dasher and Uber Driver apps only
> (restricted with packageNames), so that a driver can hear, hands-free while driving, whether an offer meets their own pay
> per mile and per hour. It never performs actions, taps or gestures (canPerformGestures=false) and does not store or transmit
> what it reads. The user turns it on after an in-app explanation (Settings > Offer reader).

Google reviews this closely and may reject it, because it isn't an accessibility tool for people with disabilities.
If they do, publish without it (remove the service from `AndroidManifest.xml`), keep it in the sideloaded APK, and appeal later.
Record a short screen video of the offer reader working; they often ask for one.

**Foreground service declaration** (microphone and location types):
> Jarvis keeps a foreground service with a visible notification so the driver can say "Hey Jarvis" and get spoken
> turn-by-turn directions while another app (the delivery app or a map) is on screen. Microphone: wake word and voice commands.
> Location: navigation while driving. The user can stop it from the notification.
Attach a short video showing the notification and a voice command with the Dasher app on screen.

## 6. Go live
After 14 days of closed testing with 12 or more testers, apply for production access in the Console, answer the questions
about your test, and roll out.

## Wake word options for a commercial launch
- **Picovoice Porcupine:** a commercial wake-word engine. You type "Hey Jarvis" in their console and get a model file.
  It's a paid licence for commercial use, and the cleanest legal option. It needs a small code change to use their Android library.
- **Train your own openWakeWord model:** the training code is Apache-2.0, but the training data must also be licensed
  for commercial use (the published models used data that isn't). Real work, but you own the result.
- **Keep the current model** only for personal use and free testing.
