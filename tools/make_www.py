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

FRAME_BY_HEAD = r"""
// Finds the head (from the neck to the top) by the model's width, slice by slice from the top down: below the head the
// width narrows to the neck, then grows at the shoulders (or jumps at outstretched arms). Added by make_www.py.
const HEAD_UNITS = 1.05, HEAD_CENTER_Y = 4.37;      // where Adam's head has always been
function frameByHead(model) {
  try {
    model.updateMatrixWorld(true);
    const pts = [], v = new THREE.Vector3();
    model.traverse(c => {
      if (!(c.isMesh || c.isSkinnedMesh) || !c.geometry || !c.geometry.attributes.position) return;
      const p = c.geometry.attributes.position, step = Math.max(1, Math.floor(p.count / 25000));
      for (let i = 0; i < p.count; i += step) { v.fromBufferAttribute(p, i).applyMatrix4(c.matrixWorld); pts.push(v.x, v.y, v.z); }
    });
    if (pts.length < 300) return null;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 1; i < pts.length; i += 3) { y0 = Math.min(y0, pts[i]); y1 = Math.max(y1, pts[i]); }
    const N = 60, sl = (y1 - y0) / N, lo = new Array(N).fill(Infinity), hi = new Array(N).fill(-Infinity), cnt = new Array(N).fill(0);
    for (let i = 0; i < pts.length; i += 3) { const k = Math.min(N - 1, Math.floor((y1 - pts[i + 1]) / sl)); lo[k] = Math.min(lo[k], pts[i]); hi[k] = Math.max(hi[k], pts[i]); cnt[k]++; }
    let hmax = 0, below = false, mn = Infinity, kmin = -1, neck = null;
    for (let k = 0; k < N; k++) {
      if (cnt[k] < 3) continue;
      if (k > N * 0.7) break;
      const w = hi[k] - lo[k];
      if (hmax && w > 1.6 * hmax) { neck = y1 - sl * k; break; }                       // shoulders or arms: the neck is just above
      if (!below) { hmax = Math.max(hmax, w); if (w < 0.85 * hmax && k > 2) { below = true; mn = w; kmin = k; } }
      else if (w < mn) { mn = w; kmin = k; }
      else if (w > 1.3 * mn) { neck = y1 - sl * (kmin + 0.5); break; }
    }
    if (neck === null && kmin >= 0) neck = y1 - sl * (kmin + 0.5);
    if (neck === null || y1 - neck < (y1 - y0) * 0.08) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] >= neck) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 2]); z1 = Math.max(z1, pts[i + 2]); }
    return { neck, top: y1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
  } catch (e) { console.warn('[AVATAR] framing', e); return null; }
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
                    "routeHead.appendChild(mk('span', '', `${plan.orders >= 4 ? '4 orders (full)' : plan.orders + ' of 4 orders'} · ${plan.total_min} min · ${plan.total_miles} ${plan.unit || 'mi'}`));", 'route head')
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
    # ---- frame every face by its HEAD, not its total height: Adam is a full body, the female model is a small bust,
    #      and "fit the whole height" blew the bust up four times (only part of her face showed)
    html = sub_once(html, """    const box = new THREE.Box3().setFromObject(avatarModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = 7.0 / size.y;
    avatarModel.scale.setScalar(s);
    avatarModel.position.sub(center.clone().multiplyScalar(s));
    avatarModel.position.y += 1.4;""", """    const head = frameByHead(avatarModel);
    let s;
    if (head) {
      s = HEAD_UNITS / (head.top - head.neck);
      avatarModel.scale.setScalar(s);
      avatarModel.position.set(-head.cx * s, HEAD_CENTER_Y - ((head.neck + head.top) / 2) * s, -head.cz * s);
    } else {
      const box = new THREE.Box3().setFromObject(avatarModel);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      s = 7.0 / size.y;
      avatarModel.scale.setScalar(s);
      avatarModel.position.sub(center.clone().multiplyScalar(s));
      avatarModel.position.y += 1.4;
    }""", 'frame by head')
    html = sub_once(html, "function doSwap(url) {", FRAME_BY_HEAD + "function doSwap(url) {", 'frame by head helper')

    # ---- live interpreter: a conversation can pause for minutes, "thank you" must not end it, and one word ("Sí") is a full reply
    html = sub_once(html, "}, SESSION_SILENCE_MS);\n}", "}, (window.__jvSessionMs || SESSION_SILENCE_MS));\n}", 'interpreter session length')
    html = sub_once(html, "function hasEndPhrase(text) { const t = cleanPunct(text);", "function hasEndPhrase(text) { if (window.__jvInterpreting) return false; const t = cleanPunct(text);", 'interpreter end phrases')
    html = sub_once(html, "if (words.length < MIN_WORDS) {", "if (words.length < (window.__jvInterpreting || (window.__jvShortOk && window.__jvShortOk(text)) ? 1 : MIN_WORDS)) {", 'interpreter short replies, one-word commands')

    # ---- voice change, cinematic: the old face fades out, the new one materialises in a flare of light, and Jarvis
    #      speaks in the new voice once the new face is up (shim.js waits for 'jv-avatar-ready')
    html = sub_once(html, "    gidPlane.visible = false; faceGroup.add(avatarModel);\n",
                    "    gidPlane.visible = false; faceGroup.add(avatarModel);\n    window.__jvSwapFx = window.__jvSwapFx === undefined ? 0 : 1;   // no flare for the very first face\n"
                    "    try { window.dispatchEvent(new CustomEvent('jv-avatar-ready', { detail: url })); } catch (e) {}\n", 'avatar ready event')
    html = sub_once(html, "  bloomPass.strength = 0.10 + speakingAmount * 0.05;",
                    "  bloomPass.strength = 0.10 + speakingAmount * 0.05 + (window.__jvSwapFx || 0) * 0.85;\n"
                    "  if (window.__jvSwapFx > 0) window.__jvSwapFx = Math.max(0, window.__jvSwapFx - 0.025);", 'swap flare')

    # no localhost anywhere: the page must only talk to its own origin (which the app answers itself)
    os.makedirs(WWW, exist_ok=True)
    open(os.path.join(WWW, 'index.html'), 'w', encoding='utf-8').write(html)
    nav = open(os.path.join(SRC, 'nav.js'), encoding='utf-8').read()
    # MapLibre ships inside the app too (the build workflow copies it to www/vendor/maplibre)
    nav = sub_once(nav, "'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js'", "'./vendor/maplibre/maplibre-gl.js'", 'maplibre js')
    nav = sub_once(nav, "'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css'", "'./vendor/maplibre/maplibre-gl.css'", 'maplibre css')
    # ---- phone "dash" view for deliveries: route card on top, a small map with directions under it, the face as an orb
    #      in the bottom-right corner (ui.js has the layout). Starts by itself while there are orders.
    nav = sub_once(nav, """    const D = Math.round(clamp(H * 0.18, 110, 170)), R = 0.36 * H, sc = D / (2 * R);
    const cx = 28 + D / 2, cy = H - 40 - D / 2;""", """    const dash = S.view === 'dash';
    const D = Math.round(dash ? clamp(H * 0.15, 96, 132) : clamp(H * 0.18, 110, 170)), R = Math.min(0.36 * H, 0.44 * W), sc = D / (2 * R);   // portrait: the circle fits the face, not the screen
    const low = dash ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dash-orb-bottom')) || 120) : 40;
    const fy = W < H ? 0.5 : 0.45; document.documentElement.style.setProperty('--orb-fy', (fy * 100) + '%');
    const cx = dash ? W - 16 - D / 2 : 28 + D / 2, cy = H - low - D / 2;""", 'dash orb corner')
    nav = sub_once(nav, "    r.setProperty('--orb-tx', (cx - sc * 0.5 * W) + 'px'); r.setProperty('--orb-ty', (cy - sc * 0.45 * H) + 'px');",
                   "    r.setProperty('--orb-tx', (cx - sc * 0.5 * W) + 'px'); r.setProperty('--orb-ty', (cy - sc * fy * H) + 'px');", 'orb face centre')
    nav = sub_once(nav, "transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% 45%); }",
                   "transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% var(--orb-fy, 45%)); }", 'orb clip centre')
    nav = sub_once(nav, "      document.body.setAttribute('data-nav', mode);\n", "      document.body.setAttribute('data-nav', mode);\n      startGps();\n", 'map view starts gps')
    nav = sub_once(nav, "case 'view': if (m.mode === 'full' || m.mode === 'mini')", "case 'view': if (m.mode === 'full' || m.mode === 'mini' || m.mode === 'dash')", 'dash view message')
    nav = sub_once(nav, "    if (meta.view !== 'keep') setView(S.view === 'mini' ? 'mini' : 'full');", "    if (meta.view !== 'keep') setView(meta.view === 'dash' ? 'dash' : S.view === 'mini' ? 'mini' : 'full');", 'dash route view')
    open(os.path.join(WWW, 'nav.js'), 'w', encoding='utf-8').write(nav)
    shutil.copyfile(os.path.join(SRC, 'nav_core.js'), os.path.join(WWW, 'nav_core.js'))
    os.makedirs(os.path.join(WWW, 'models'), exist_ok=True)
    keep = os.path.join(WWW, 'models', 'README.txt')
    if not os.path.exists(keep) and not any(f.endswith('.glb') for f in os.listdir(os.path.join(WWW, 'models'))):
        open(keep, 'w').write('Copy your PC Jarvis "models" folder contents here (adam.glb, gideon.png, ...).\nThey are packed into the app.\n')
    print('wrote', os.path.join(WWW, 'index.html'), f'({len(html)//1024} KB)')


if __name__ == '__main__':
    main()
