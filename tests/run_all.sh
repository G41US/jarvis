#!/bin/sh
# Runs every check that can run without an Android SDK or a phone.
set -e
cd "$(dirname "$0")/.."
for f in app/src/main/assets/www/local/*.js; do node --check "$f"; done
TZ=UTC node tests/golden.test.mjs | tail -1                       # nav + delivery engines match the PC (Python) ones
node server/worker.test.mjs | tail -1                              # the key-holding proxy
node tests/stt.test.mjs | tail -1                                  # end-of-speech timing in noise
python3 tools/make_www.py >/dev/null
python3 tests/e2e/e2e.py | tail -1                                 # the whole phone page, fake Android bridge, mocked services
S=$(mktemp -d); python3 tests/android_stubs/gen_stubs.py "$S/src" >/dev/null; mkdir "$S/out"
X=/opt/gradle-8.14.3/lib; LIBS=app/libs/sherpa-onnx.jar:$X/kotlin-stdlib-2.0.21.jar:$X/commons-compress-1.26.1.jar:$X/commons-io-2.15.1.jar:$X/commons-lang3-3.14.0.jar
[ -f app/libs/sherpa-onnx.jar ] || bash tests/fetch_engine.sh     # same step the GitHub build runs
javac -nowarn -Xlint:-options -cp "$LIBS" -d "$S/out" $(find "$S/src" -name '*.java') $(find app/src/main/java -name '*.java') 2>&1 | grep -v "^Note:"; echo "java type-check OK"
javac -d "$S/out" -cp "$S/out" tests/wake/WakeWordTest.java tests/wake/SileroVadTest.java && java -cp "$S/out" WakeWordTest tests/wake/trace.txt | tail -1 && java -cp "$S/out" SileroVadTest tests/wake/vad_trace.txt | tail -1   # wake word == openWakeWord, VAD == Silero
python3 - <<'PY'
import glob, xml.dom.minidom as m
for f in glob.glob('app/src/main/**/*.xml', recursive=True): m.parse(f)
print('xml OK')
PY
