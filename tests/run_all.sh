#!/bin/sh
# Runs every check that can run without an Android SDK or a phone.
set -e
cd "$(dirname "$0")/.."
for f in app/src/main/assets/www/local/*.js; do node --check "$f"; done
TZ=UTC node tests/golden.test.mjs | tail -1                       # nav + delivery engines match the PC (Python) ones
node server/worker.test.mjs | tail -1                              # the key-holding proxy
node tests/stt.test.mjs | tail -1                                  # end-of-speech timing in noise
node tests/approx.test.mjs | tail -1                               # orders with only a place or area, filled in later
node tests/speed.test.mjs | tail -1                                # instant commands + the tool router (smaller, faster requests)
node tests/extras.test.mjs | tail -1                               # QR codes, receipts, expense periods
node tests/driving.test.mjs | tail -1                              # IRS mileage rate, parking directions, shift sums
node tests/home.test.mjs | tail -1                                 # smart home name matching
node tests/proactive.test.mjs | tail -1                            # birthdays, time to leave, weather alert wording
node tests/earnings.test.mjs | tail -1                             # earnings page: today, week, per hour/mile, best hours and areas
node tests/mouth.test.mjs | tail -1                                # the mouth follows speech loudness
node tests/screen_extras.test.mjs | tail -1                       # the globe, live feeds, answer cards and the inner life
node tests/persona.test.mjs                                     # characters ("be Ultron"): voice settings and staying in character
node tests/xray_vitals.test.mjs | tail -1                         # the PC X-ray mirror's pulse, breathing and tiredness maths
node tests/brain_fallback.test.mjs | tail -1                     # a failed search tries the news and Wikipedia; harder questions think more
python3 tests/mind_agent_test.py | tail -1                       # missions report back, corrections become lessons, news gets followed
python3 tests/studio_test.py | tail -1                           # OBS scenes, overlays, alerts, Discord/Telegram (against a stand-in OBS)
[ -n "$DISPLAY" ] && python3 tests/pc_control_test.py | tail -1  # screen control with the real mouse and keyboard (needs a screen, e.g. Xvfb)
node tests/mind_agent.test.mjs | tail -1                          # the same on the phone
node tests/nav_trip.test.mjs | tail -1                            # several pickups in the fastest order on the map; no made-up directions
node tests/fuel.test.mjs | tail -1                                # fuel price from the web answer, cost per km/mile, currency by country
JW=$(mktemp -d); javac -d "$JW" app/src/main/java/com/jarvis/assistant/Wav.java tests/java/WavCheck.java 2>/dev/null && java -cp "$JW" com.jarvis.assistant.WavCheck 2>/dev/null   # the natural voice's audio
python3 tools/make_www.py >/dev/null
python3 tests/e2e/e2e.py | tail -1                                 # the whole phone page, fake Android bridge, mocked services
S=$(mktemp -d); python3 tests/android_stubs/gen_stubs.py "$S/src" >/dev/null; mkdir "$S/out"
X=/opt/gradle-8.14.3/lib; LIBS=app/libs/sherpa-onnx.jar:$X/kotlin-stdlib-2.0.21.jar:$X/commons-compress-1.26.1.jar:$X/commons-io-2.15.1.jar:$X/commons-lang3-3.14.0.jar
[ -f app/libs/sherpa-onnx.jar ] || { echo "run the Bundle the PC voice engine step from .github/workflows/build-apk.yml first"; exit 1; }
# Real type-check: every Java file against the actual Android 16 framework (android.jar, API 36), when it's available.
AJ=${ANDROID_JAR:-/home/claude/androidjar/android-36.jar}
if [ -f "$AJ" ]; then
  R=$(mktemp -d); python3 tests/android_stubs/gen_stubs.py "$R/src" --non-android >/dev/null; mkdir "$R/out"
  OUT=$(javac -nowarn -Xlint:-options -cp "$AJ:$LIBS" -d "$R/out" $(find "$R/src" -name '*.java') $(find app/src/main/java -name '*.java') 2>&1 | grep -v "^Note:\|JAVA_TOOL_OPTIONS" || true)
  [ -n "$OUT" ] && echo "$OUT"
  if echo "$OUT" | grep -q "error"; then echo "FAILURES: java does not compile against Android 16"; exit 1; fi
  [ -f "$R/out/com/jarvis/assistant/MainActivity.class" ] && echo "java check against real Android 16 OK" || { echo "FAILURES: java does not compile against Android 16"; exit 1; }
else echo "(no android.jar: stand-in check only)"; fi
# The engines the tests run, with lightweight stand-ins (real android.jar classes only throw "Stub!" when run).
javac -nowarn -Xlint:-options -cp "$LIBS" -d "$S/out" $(find "$S/src" -name '*.java') app/src/main/java/com/jarvis/assistant/WakeWord.java app/src/main/java/com/jarvis/assistant/SileroVad.java 2>&1 | grep -v "^Note:\|JAVA_TOOL_OPTIONS" || true; echo "java stand-in compile OK"
javac -d "$S/out" -cp "$S/out" tests/wake/WakeWordTest.java tests/wake/SileroVadTest.java && java -cp "$S/out" WakeWordTest tests/wake/trace.txt | tail -1 && java -cp "$S/out" SileroVadTest tests/wake/vad_trace.txt | tail -1   # wake word == openWakeWord, VAD == Silero
javac -d "$S/out" app/src/main/java/com/jarvis/assistant/FaceMath.java tests/face/FaceMathTest.java && java -cp "$S/out" FaceMathTest tests/face | tail -1   # face pipeline == OpenCV's
python3 - <<'PY'
import glob, xml.dom.minidom as m
for f in glob.glob('app/src/main/**/*.xml', recursive=True): m.parse(f)
print('xml OK')
PY
javac -d "$S/out" app/src/main/java/com/jarvis/assistant/MessageWords.java tests/messages/MessageWordsTest.java && java -cp "$S/out" MessageWordsTest | tail -1   # what Jarvis says for new messages
javac -d "$S/out" app/src/main/java/com/jarvis/assistant/OfferParser.java tests/offers/OfferParserTest.java && java -cp "$S/out" OfferParserTest | tail -1   # offer reader on sample screens
