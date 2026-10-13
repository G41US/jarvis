# Jarvis for iPhone

The iPhone app is a small Swift shell around the **same page** the Android app uses (`app/src/main/assets/www`):
the 3D face, the brain, the delivery copilot, the map, the interpreter, settings. The Swift side gives the page the
phone's abilities through the same two objects Android does (`AndroidBridge`, `AndroidPhone`), so every change to the
page reaches both phones.

| Folder | What it is |
| --- | --- |
| `Jarvis/Sources` | The app: web host (`WebViewController`, `WebServer`, `JSBridge`) and the phone abilities (`Native`, `Speech`, `Ears`, `Http`, `Location`, `Reminders`, `Faces`, `Docs`), Siri shortcut (`App.swift`). |
| `JarvisCore` | Plain Swift shared logic (face maths, "Hey Jarvis", speech detector, .docx writer), tested with `swift test` against the same traces as Android. |
| `project.yml` | The Xcode project, generated with XcodeGen in CI. |
| `Resources/` | Filled by the build: the page (`www`) and the models (`wake`, `vad`, `face`). Not in git. |

GitHub builds it on a Mac (`.github/workflows/build-apk.yml`, jobs `ios-core` and `ios`) when something in `ios/`
changes, when a commit message contains `[ios]`, or when you press **Run workflow** in the Actions tab.
Every build runs in the iPhone simulator and keeps screenshots and the log as the **Jarvis-iphone-simulator** artifact.

## What an iPhone can't do (Apple's rules, for every app)

Read or control other apps (phone control, the DoorDash/Uber offer reader), read other apps' notifications
(announcing WhatsApp/Snapchat messages), change the volume, ringer or Do Not Disturb, send a text or place a call
without you tapping to confirm, or listen for "Hey Jarvis" while closed. On iPhone, Jarvis opens texts, calls and the
SOS message ready to send, and "Hey Siri, talk to Jarvis" (or the Action Button) opens him listening.

## Getting it onto iPhones: TestFlight

Needs the Apple Developer Program ($99 a year): https://developer.apple.com/programs/enroll/
Enrol as an **Individual** (fastest). Then, once:

1. **Create the app record.** App Store Connect (https://appstoreconnect.apple.com) > Apps > **+** > New App.
   Platform iOS, name **Jarvis** (or your chosen name), language English (U.S.), bundle ID **com.g41us.jarvis**
   (if it isn't in the list, first register it at developer.apple.com > Certificates, Identifiers & Profiles >
   Identifiers > **+** > App IDs > App, with that exact ID), SKU anything (e.g. `jarvis-ios`).
2. **Make an API key for GitHub.** App Store Connect > Users and Access > Integrations > App Store Connect API >
   Team Keys > **+**. Name `GitHub`, access **Admin** (needed so the build can make its own signing certificate).
   Download the `.p8` file (you can only download it once). Note the **Key ID** and the **Issuer ID** shown above the list.
3. **Find your Team ID.** developer.apple.com > Account > Membership details > Team ID (10 characters).
4. **Add four GitHub secrets.** github.com/G41US/jarvis > Settings > Secrets and variables > Actions > New repository secret:
   - `APPLE_TEAM_ID` = the Team ID
   - `ASC_KEY_ID` = the Key ID
   - `ASC_ISSUER_ID` = the Issuer ID
   - `ASC_KEY_P8` = the whole contents of the `.p8` file (open it in a text editor, copy everything including the BEGIN/END lines)
5. **Run the build.** Actions > Build Jarvis APK > Run workflow. The iPhone job signs the app and uploads it.
   About 15-30 minutes later it appears in App Store Connect > your app > TestFlight.
6. **Testers.**
   - You (and up to 100 people on your App Store Connect team): TestFlight > Internal Testing > add yourself. No review.
   - Anyone else (up to 10,000): TestFlight > External Testing > **+** group > add the build > fill in the test
     information > submit for Beta App Review (usually about a day the first time). Then switch on **Public Link**
     and share it. Testers install Apple's **TestFlight** app, open the link, tap Install. Each build lasts 90 days;
     new builds arrive in TestFlight automatically.

A different bundle ID? Set a repository **variable** (not secret) `IOS_BUNDLE_ID`.

## App Store

Same app record, then App Store > prepare the version: screenshots, description, privacy details (see
`playstore/PRIVACY.md`, the same answers apply), and submit for review. Before that: the name "Jarvis" and the
Iron Man description, and the female face (a real person's likeness), need replacing or permission.
