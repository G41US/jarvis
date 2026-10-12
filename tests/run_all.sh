#!/bin/sh
# Runs every check that can run without an Android SDK.
set -e
cd "$(dirname "$0")/.."
for f in app/src/main/assets/www/local/*.js; do node --check "$f"; done
TZ=UTC node tests/golden.test.mjs | tail -1
python3 tools/make_www.py >/dev/null
python3 tests/e2e/e2e.py | tail -1
S=$(mktemp -d); python3 tests/android_stubs/gen_stubs.py "$S/src" >/dev/null; mkdir "$S/out"
javac -Xlint:-options -d "$S/out" $(find "$S/src" -name '*.java') $(find app/src/main/java -name '*.java') && echo "java type-check OK"
python3 - <<'PY'
import glob, xml.dom.minidom as m
for f in glob.glob('app/src/main/**/*.xml', recursive=True): m.parse(f)
print('xml OK')
PY
