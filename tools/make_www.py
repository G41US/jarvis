#!/usr/bin/env python3
"""Builds app/src/main/assets/www/index.html (+ nav.js, nav_core.js) from the PC Jarvis page.

Usage:  python3 tools/make_www.py [path/to/pc/jarvis/folder]

Every patch is asserted, so if the PC page changes shape the build stops loudly instead of shipping a half-patched page.
"""
import os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, 'pc_source')
WWW = os.path.join(ROOT, 'app', 'src', 'main', 'assets', 'www')


def sub_once(text, old, new, label):
    n = text.count(old)
    assert n == 1, f'patch "{label}": expected 1 match, found {n}'
    return text.replace(old, new)


MOBILE_CSS = r"""
  /* ---- phone layout (added by make_www.py) ---- */
  html, body { overscroll-behavior: none; -webkit-tap-highlight-color: transparent; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
  #activate { display: none !important; }
  #diag, #voice-panel, #debug, #cam-indicator { display: none !important; }
  @media (max-width: 820px), (orientation: portrait) {
    #log { left: 12px; right: 12px; width: auto; bottom: calc(150px + env(safe-area-inset-bottom, 0px)); max-height: 30vh; font-size: 13px; }
    #state { bottom: calc(104px + env(safe-area-inset-bottom, 0px)); }
    #partial-text { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); max-width: 92vw; text-align: center; }
    #mic-level { bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }
    #controls { bottom: calc(22px + env(safe-area-inset-bottom, 0px)); gap: 22px; }
    #controls button { font-size: 12px; letter-spacing: 3px; padding: 14px 10px; }
    #route-panel { top: calc(58px + env(safe-area-inset-top, 0px)); left: 10px; right: 10px; width: auto; max-height: 34vh; }
    .rs .sub { margin-left: 0; }
    .rs .t { min-width: 52px; }
  }
"""

CAMERA_FIT = r"""
// phone: pull the camera back on tall, narrow screens so the whole face fits (added by make_www.py)
let camFit = 1;
function fitCamera() {
  const a = window.innerWidth / Math.max(1, window.innerHeight);
  camFit = a >= 1 ? 1 : Math.min(3.2, Math.max(1, (0.85 / (0.4663 * a)) / CAM_BASE.z));
}
fitCamera();
"""


def main():
    src_html = os.path.join(SRC, 'index.html')
    assert os.path.exists(src_html), f'cannot find {src_html} - pass the PC Jarvis folder as the first argument'
    html = open(src_html, encoding='utf-8').read()

    html = sub_once(html, '<meta charset="utf-8">',
                    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#05060a">',
                    'viewport')
    html = sub_once(html, '<title>JARVIS</title>', '<title>Jarvis</title>', 'title')

    # three.js ships inside the app (the build workflow copies it to www/vendor/three) so the face works offline
    m = re.search(r'<script type="importmap">.*?</script>', html, re.S)
    assert m, 'importmap not found'
    importmap = ('<script type="importmap">\n{ "imports": { "three": "./vendor/three/build/three.module.js",\n'
                 '  "three/addons/": "./vendor/three/examples/jsm/" } }\n</script>\n'
                 '<script type="module" src="local/boot.js"></script>')
    probe = ('<script>(function(){try{var x=new XMLHttpRequest();x.open("HEAD","models/adam.glb",false);x.send();window.__NO_ADAM=x.status!==200;}'
             'catch(e){window.__NO_ADAM=true;}})();</script>\n')
    html = html.replace(m.group(0), probe + importmap)
    # if the Adam model was not copied into the app, show the online face instead of nothing
    # the female face also ships inside the app when models/female.glb is present (no internet needed for the face)
    if os.path.exists(os.path.join(WWW, 'models', 'female.glb')):
        html = sub_once(html, "const AVATAR_FEMALE = 'https://three.ws/avatars/default.glb';", "const AVATAR_FEMALE = 'models/female.glb';", 'local female face')
    html = sub_once(html, "const AVATAR_MALE = 'models/adam.glb';",
                    "const AVATAR_MALE = window.__NO_ADAM ? AVATAR_FEMALE : 'models/adam.glb';", 'adam fallback')

    html = sub_once(html, 'async function identifyUser() {\n',
                    'async function identifyUser() {\n  if (window.JARVIS_NATIVE) return currentUser;   // no face ID on the phone\n', 'identifyUser guard')

    html = sub_once(html, "camera.lookAt(CAM_LOOK);\n\nwindow.addEventListener('resize', () => {\n",
                    "camera.lookAt(CAM_LOOK);\n" + CAMERA_FIT + "\nwindow.addEventListener('resize', () => {\n  fitCamera();\n", 'camera fit')
    html = sub_once(html, 'camera.position.z = CAM_BASE.z;', 'camera.position.z = CAM_BASE.z * camFit;', 'camera z')


    # ---- the app records the microphone natively (VoiceEngine.java); the page only receives transcripts
    html = sub_once(html, """    micStream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } });
    await setupMicAnalyser(micStream);
    startMicLevelLoop();
    connectAudioWs();
    await setupAudioCapture(micStream);""", """    if (window.JARVIS_NATIVE_MIC) { connectAudioWs(); }       // phone: native mic + on-device wake word
    else {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } });
    await setupMicAnalyser(micStream);
    startMicLevelLoop();
    connectAudioWs();
    await setupAudioCapture(micStream);
    }""", 'native mic')
    # ---- let the in-app server see what the page is doing (it only streams audio while Jarvis is listening)
    html = sub_once(html, "let active = false, sessionActive = false, recognizing = false, speaking = false, muted = false;\n",
                    "let active = false, sessionActive = false, recognizing = false, speaking = false, muted = false;\n"
                    "window.__jv = { state: () => ({ active, session: sessionActive, speaking, muted, guide: typeof guideSpeaking !== 'undefined' && guideSpeaking, appState }) };\n",
                    'page state')
    # ---- phone: chime and listen straight away instead of a spoken greeting talking over your question
    html = sub_once(html, "  if (Date.now() - lastGreetAt < GREET_EVERY_MS) {", "  if (window.JARVIS_NATIVE || Date.now() - lastGreetAt < GREET_EVERY_MS) {", 'no greeting on wake')
    # ---- chimes through Android (a WebView audio context can be asleep)
    html = sub_once(html, "function beep(freq, duration, volume) {\n",
                    "function beep(freq, duration, volume) {\n  if (window.AndroidBridge && window.AndroidBridge.tone) { try { window.AndroidBridge.tone(freq, Math.round(duration * 1000), volume || 0.06); return; } catch (e) {} }\n",
                    'native chime')
    # ---- rendering budget on phones: lower pixel ratio, ~30 fps, nothing while hidden
    html = sub_once(html, "renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));", "renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.JARVIS_NATIVE ? ((navigator.deviceMemory || 4) <= 4 ? 1 : 1.25) : 2));", 'pixel ratio')
    html = sub_once(html, "composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));", "composer.setPixelRatio(Math.min(window.devicePixelRatio, window.JARVIS_NATIVE ? ((navigator.deviceMemory || 4) <= 4 ? 1 : 1.25) : 2));", 'composer pixel ratio')
    html = sub_once(html, "function animate() {\n", "let _lastFrame = 0;\nfunction animate() {\n"
                    "  if (window.JARVIS_NATIVE) { const now = performance.now(); if (document.hidden || window.__jvPaused || now - _lastFrame < 31) { requestAnimationFrame(animate); return; } _lastFrame = now; }\n", 'frame cap')

    # ---- route card in plain sentence case (the page writes these strings itself)
    html = sub_once(html, "routeHead.appendChild(mk('span', '', `ROUTE · ${plan.orders} ORDER${plan.orders === 1 ? '' : 'S'} · ${plan.total_min} MIN · ${plan.total_miles} ${(plan.unit || 'mi').toUpperCase()}`));",
                    "routeHead.appendChild(mk('span', '', `${plan.orders} order${plan.orders === 1 ? '' : 's'} · ${plan.total_min} min · ${plan.total_miles} ${plan.unit || 'mi'}`));", 'route head')
    html = sub_once(html, "` · ${plan.currency || '$'}${Math.round(plan.per_hour)}/HR`", "` · ${plan.currency || '$'}${Math.round(plan.per_hour)} an hour`", 'route per hour')
    html = sub_once(html, "`${plan.total_min_lo}-${plan.total_min_hi} MIN · ON-TIME RISK ${String(plan.risk || 'low').toUpperCase()}`", "`${plan.total_min_lo}–${plan.total_min_hi} min · on-time risk ${String(plan.risk || 'low')}`", 'route risk')
    html = sub_once(html, "mk('span', 'est', 'ESTIMATED TIMES')", "mk('span', 'est', 'Estimated times')", 'route estimate')
    html = sub_once(html, "row.appendChild(mk('span', 'k', s.kind === 'pickup' ? 'PICK' : 'DROP'));", "row.appendChild(mk('span', 'k', s.kind === 'pickup' ? 'Pick up' : 'Drop off'));", 'route kinds')

    # ---- phone: words that mostly repeat what Jarvis just said are his own echo (mic is also closed while he talks + 0.9 s)
    html = sub_once(html, "const ECHO_SIMILARITY_THRESHOLD = 0.40, POST_TTS_DELAY_MS = 50, ECHO_MEMORY_MS = 15000;",
                    "const ECHO_SIMILARITY_THRESHOLD = window.JARVIS_NATIVE_MIC ? 0.5 : 0.40, POST_TTS_DELAY_MS = 50, ECHO_MEMORY_MS = 15000;", 'echo filter')
    # ---- tell the Hearing panel when something you said was ignored, and why
    html = sub_once(html, "function showDebug(text, kind) {\n", "function showDebug(text, kind) {\n  try { if (window.__jvDebug) window.__jvDebug(text, kind); } catch (e) {}\n", 'debug hook')
    html = sub_once(html, '</style>', MOBILE_CSS + '</style>', 'mobile css')
    # ---- things Jarvis says by himself (reminders, offers, messages, the interpreter's hello): they must play even before
    #      the first question (no speech controller yet), and end "speaking" when done, or the next thing you say without
    #      "Hey Jarvis" is ignored as talking over him
    html = sub_once(html, "        addMsg(text, 'proactive');\n        if (!muted) enqueueSpeech(text);",
                    "        addMsg(text, 'proactive');\n        if (!muted) { if (!bargeAbort) bargeAbort = new AbortController(); const ch = enqueueSpeech(text); ch.then(() => { if (speakChain === ch && speaking) { speaking = false; if (active && !muted) { if (sessionActive) { setState('session'); armSessionSilenceTimer(); } else setState('standby'); } } }); }",
                    'proactive speech ends')
    # ---- live interpreter: a conversation can pause for minutes, "thank you" must not end it, and one word ("Sí") is a full reply
    html = sub_once(html, "}, SESSION_SILENCE_MS);\n}", "}, (window.__jvSessionMs || SESSION_SILENCE_MS));\n}", 'interpreter session length')
    html = sub_once(html, "function hasEndPhrase(text) { const t = cleanPunct(text);", "function hasEndPhrase(text) { if (window.__jvInterpreting) return false; const t = cleanPunct(text);", 'interpreter end phrases')
    html = sub_once(html, "if (words.length < MIN_WORDS) {", "if (words.length < (window.__jvInterpreting ? 1 : MIN_WORDS)) {", 'interpreter short replies')

    # no localhost anywhere: the page must only talk to its own origin (which the app answers itself)
    os.makedirs(WWW, exist_ok=True)
    open(os.path.join(WWW, 'index.html'), 'w', encoding='utf-8').write(html)
    nav = open(os.path.join(SRC, 'nav.js'), encoding='utf-8').read()
    # MapLibre ships inside the app too (the build workflow copies it to www/vendor/maplibre)
    nav = sub_once(nav, "'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js'", "'./vendor/maplibre/maplibre-gl.js'", 'maplibre js')
    nav = sub_once(nav, "'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css'", "'./vendor/maplibre/maplibre-gl.css'", 'maplibre css')
    open(os.path.join(WWW, 'nav.js'), 'w', encoding='utf-8').write(nav)
    shutil.copyfile(os.path.join(SRC, 'nav_core.js'), os.path.join(WWW, 'nav_core.js'))
    os.makedirs(os.path.join(WWW, 'models'), exist_ok=True)
    keep = os.path.join(WWW, 'models', 'README.txt')
    if not os.path.exists(keep) and not any(f.endswith('.glb') for f in os.listdir(os.path.join(WWW, 'models'))):
        open(keep, 'w').write('Copy your PC Jarvis "models" folder contents here (adam.glb, gideon.png, ...).\nThey are packed into the app.\n')
    print('wrote', os.path.join(WWW, 'index.html'), f'({len(html)//1024} KB)')


if __name__ == '__main__':
    main()
