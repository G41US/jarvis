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
DESK = os.path.join(ROOT, 'desktop', 'app')             # the PC app: its faces and globe come along
DESK_HTML = os.path.join(DESK, 'index.html')


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
const HEAD_UNITS = 1.55, HEAD_CENTER_Y = 4.37;      // a big head: the particle face is the whole screen (measured at S21 size)
function frameByHead(model) {
  try {
    const known = model.userData && model.userData.jvHead;                 // our own faces say where their head is (tools/faces)
    if (known && known.top > known.neck) return { neck: known.neck, top: known.top, cx: known.cx || 0, cz: known.cz || 0 };
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

# Blinking, for faces that have an "eyeBlink" morph: every 2.5-6 seconds, a 150 ms close-and-open (sometimes twice).
BLINK_JS = r"""
  { const bl = window.__jvBlinkMorphs; if (bl && bl.length) {
      const B = window.__jvBlink || (window.__jvBlink = { next: t + 2 + Math.random() * 3, start: -1, twice: false });
      if (B.start < 0 && t >= B.next) { B.start = t; B.twice = Math.random() < 0.18; }
      let v = 0;
      if (B.start >= 0) { const e = t - B.start, d = 0.15; v = e < d ? Math.sin(Math.PI * e / d) : 0;
        if (e >= d) { if (B.twice) { B.twice = false; B.start = t + 0.08; } else { B.start = -1; B.next = t + 2.5 + Math.random() * 3.5; } } }
      for (const m of bl) if (m.mesh.morphTargetInfluences) m.mesh.morphTargetInfluences[m.index] = v;
  } }"""

# The phone layout (ui.js) asks for the face to lift and shrink while the answer card is up: window.__jvStage = {ty, s}.
# Done with the camera (zoom + view offset) rather than by moving the canvas, so there is never a visible canvas edge.
STAGE_JS = r"""
  { const want = window.__jvStage || { ty: 0, s: 1 }, cur = window.__jvStageCur || (window.__jvStageCur = { ty: 0, s: 1 });
    const k = window.__jvStageInstant ? 1 : Math.min(1, dt * 7);
    cur.ty += (want.ty - cur.ty) * k; cur.s += (want.s - cur.s) * k;
    if (Math.abs(want.ty - cur.ty) < 0.3) cur.ty = want.ty; if (Math.abs(want.s - cur.s) < 0.001) cur.s = want.s;
    const w = window.innerWidth, h = window.innerHeight;
    if (cur.ty !== 0 || cur.s !== 1) { camera.zoom = cur.s; camera.setViewOffset(w, h, 0, -cur.ty, w, h); camera.updateProjectionMatrix(); cur.on = true; }
    else if (cur.on) { camera.zoom = 1; camera.clearViewOffset(); camera.updateProjectionMatrix(); cur.on = false; } }"""

CAMERA_FIT = r"""
// phone: pull the camera back on tall, narrow screens so the whole face fits (added by make_www.py)
let camFit = 1;
function fitCamera() {
  const a = window.innerWidth / Math.max(1, window.innerHeight);
  camFit = a >= 1 ? 1 : Math.min(3.2, Math.max(1, (0.85 / (0.4663 * a)) / CAM_BASE.z));
}
fitCamera();
"""


# How a line reads on screen: no delivery directions ("[warm]") or stage directions ("(laughs)"). Same as the PC page.
UNSTAGE_JS = r"""window.__jvUnstage = t => String(t || "").replace(/\[[A-Za-z][A-Za-z \-]{1,28}\]\s*/g, "").replace(/[*(]\s*(laughs?|laughing|chuckles?|chuckling|giggles?|sighs?|sighing|smiles?|grins?)\s*[*)]\s*/gi, "").trim();"""

# The phone speaks through Android (shim.js hands each sentence to the voice and says 'jv-saying'). Cloud speech starts a
# moment later, so his words, lips and gestures start when the sound does: the first rise of the voice's level.
# How long a sentence takes is learnt from the ones before (seconds per letter).
PHONE_SPEECH_JS = r"""
// ---- phone: when each sentence really starts (added by make_www.py)
(function () {
  let pending = null, cur = null, spc = 0.066;
  try { spc = Math.min(0.12, Math.max(0.04, parseFloat(localStorage.getItem('jv-spc')) || 0.066)); } catch (e) {}
  window.addEventListener('jv-saying', e => { pending = { text: String(e.detail || ''), at: performance.now() }; });
  const go = now => {
    const text = window.__jvUnstage(pending.text), dur = Math.max(0.6, text.length * spc);
    cur = { text, at: now, n: text.length };
    try { window.__jvBrowserLips = { tl: window.__jvLips.build(pending.text, null, dur), t0: now }; } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('jv-say', { detail: { text: pending.text, dur } })); } catch (e) {}
    pending = null;
  };
  (function tick() {
    const now = performance.now(), lvl = window.__jvMouthLevel ? window.__jvMouthLevel() : -1;
    if (pending && (lvl > 0.04 || now - pending.at > (lvl < 0 ? 150 : 2500))) go(now);    // no level to go on: start now
    const talking = window.speechSynthesis && window.speechSynthesis.speaking;
    if (cur && !talking && !pending) {                                                     // it ended: learn the pace
      const took = (now - cur.at) / 1000;
      if (cur.n > 12 && took > 0.4) { spc = spc * 0.7 + Math.min(0.12, Math.max(0.04, took / cur.n)) * 0.3; try { localStorage.setItem('jv-spc', spc.toFixed(4)); } catch (e) {} }
      cur = null; window.__jvBrowserLips = null;
    }
    requestAnimationFrame(tick);
  })();
  window.__jvViseme = () => {
    const b = window.__jvBrowserLips;
    return b && window.__jvLips ? window.__jvLips.at(b.tl, (performance.now() - b.t0) / 1000) : null;
  };
})();
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
    html = html.replace(m.group(0), importmap)
    # the faces ship inside the app (local/faces.js lists them; models/faces/*.glb are original, made from CC0 MakeHuman assets,
    # and are drawn as glowing gold particles by makeGoldenParticleFace in the page)
    html = sub_once(html, "const AVATAR_FEMALE = 'https://three.ws/avatars/default.glb';", "const AVATAR_FEMALE = 'models/faces/nova.glb';", 'local female face')
    html = sub_once(html, "const AVATAR_MALE = 'models/adam.glb';", "const AVATAR_MALE = 'models/faces/kofi.glb';", 'local male face')

    # ---- choice of faces: which face goes with the voice comes from the face you picked (local/faces.js); "orb" means no face
    html = sub_once(html, "  const want = isMaleVoice(currentVoice) ? AVATAR_MALE : AVATAR_FEMALE;\n",
                    "  const want = window.__jvFaceFor ? window.__jvFaceFor(isMaleVoice(currentVoice)) : (isMaleVoice(currentVoice) ? AVATAR_MALE : AVATAR_FEMALE);\n"
                    "  if (want === 'orb') { try { window.dispatchEvent(new CustomEvent('jv-avatar-ready', { detail: 'orb' })); } catch (e) {} return; }\n", 'face choice')
    html = sub_once(html, "loadAvatar(AVATAR_FEMALE);\n", "window.__jvSyncFace = syncAvatarToVoice;\n"
                    "loadAvatar((window.__jvFaceFor && window.__jvFaceFor(null)) || AVATAR_FEMALE);\n", 'first face')
    # ---- every mesh that talks: hair, teeth and tongue move with the jaw too (a name can be on several meshes), and blinking
    html = sub_once(html, "          if (MOUTH_MORPH_NAMES.includes(n)) mouthMorphs[n] = { mesh: child, index: child.morphTargetDictionary[n] };\n",
                    "          if (MOUTH_MORPH_NAMES.includes(n)) mouthMorphs[n + '#' + child.uuid] = { mesh: child, index: child.morphTargetDictionary[n], name: n };\n"
                    "          if (n === 'eyeBlink') (window.__jvBlinkMorphs = window.__jvBlinkMorphs || []).push({ mesh: child, index: child.morphTargetDictionary[n] });\n", 'all talking meshes')
    html = sub_once(html, "        const lower = name.toLowerCase();\n", "        const lower = (m.name || name).toLowerCase();\n", 'morph name')
    html = sub_once(html, "  for (const k in mouthMorphs) delete mouthMorphs[k];\n", "  for (const k in mouthMorphs) delete mouthMorphs[k];\n  window.__jvBlinkMorphs = [];\n", 'reset blink')
    html = sub_once(html, "  driveLipSync(t, speakingAmount);\n", "  driveLipSync(t, speakingAmount);\n" + BLINK_JS, 'blink')

    html = sub_once(html, 'async function identifyUser() {\n',
                    'async function identifyUser() {\n  if (window.JARVIS_NATIVE) return currentUser;   // no face ID on the phone\n', 'identifyUser guard')

    html = sub_once(html, "camera.lookAt(CAM_LOOK);\n\nwindow.addEventListener('resize', () => {\n",
                    "camera.lookAt(CAM_LOOK);\n" + CAMERA_FIT + "\nwindow.addEventListener('resize', () => {\n  fitCamera();\n", 'camera fit')
    html = sub_once(html, 'camera.position.z = CAM_BASE.z;', 'camera.position.z = CAM_BASE.z * camFit;' + STAGE_JS, 'camera z')


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
                    "  if (window.JARVIS_NATIVE) { const now = performance.now(); if (document.hidden || window.__jvPaused || window.__jvHideFace || now - _lastFrame < 31) { requestAnimationFrame(animate); return; } _lastFrame = now; }\n", 'frame cap')

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

    # ---- how loud Jarvis is speaking right now, for the ring of light around his face (ui.js)
    html = sub_once(html, "  sharedUniforms.uSpeaking.value = speakingAmount;", "  sharedUniforms.uSpeaking.value = speakingAmount; window.__jvSpeak = speakingAmount;", 'speaking level for the aura')
    # ---- voice change, cinematic: the old face fades out, the new one materialises in a flare of light, and Jarvis
    #      speaks in the new voice once the new face is up (shim.js waits for 'jv-avatar-ready')
    html = sub_once(html, "    gidPlane.visible = false; faceGroup.add(avatarModel);\n",
                    "    gidPlane.visible = false; faceGroup.add(avatarModel);\n    window.__jvSwapFx = window.__jvSwapFx === undefined ? 0 : 1;   // no flare for the very first face\n"
                    "    try { window.dispatchEvent(new CustomEvent('jv-avatar-ready', { detail: url })); } catch (e) {}\n", 'avatar ready event')
    html = sub_once(html, "  bloomPass.strength = 0.10 + speakingAmount * 0.05;",
                    "  bloomPass.strength = 0.10 + speakingAmount * 0.05 + (window.__jvSwapFx || 0) * 0.85;\n"
                    "  if (window.__jvSwapFx > 0) window.__jvSwapFx = Math.max(0, window.__jvSwapFx - 0.025);", 'swap flare')

    # ---- the PC's newer faces: her long hair (strands, fringe, sway) and his beard, taken from the PC page so both stay the same
    desk = open(DESK_HTML, encoding='utf-8').read()
    a, b = desk.index('// Long hair as light, not a helmet'), desk.index('\nfunction makeBeard(')
    beard_end = desk.index('\n}\n', b) + 3
    html = sub_once(html, "  const head = model.userData.jvHead, minY = head ? head.neck : 0.18, eyeMeshes = [], span = head ? head.top - head.neck : 1;",
                    "  const head = model.userData.jvHead, minY = head ? head.neck : 0.18, eyeMeshes = [], hairMeshes = [], browMeshes = [], span = head ? head.top - head.neck : 1;", 'hair lists')
    html = sub_once(html, "    if (/high-?poly|eyelash/i.test(mesh.name)) { if (/high-?poly/i.test(mesh.name)) eyeMeshes.push(mesh); return; }   // eyes get a glow instead of dots\n",
                    "    if (/high-?poly|eyelash/i.test(mesh.name)) { if (/high-?poly/i.test(mesh.name)) eyeMeshes.push(mesh); return; }   // eyes get a glow instead of dots\n"
                    "    if (/eyebrow/i.test(mesh.name)) browMeshes.push(mesh);\n    if (/long|ponytail|bun/i.test(mesh.name)) { hairMeshes.push(mesh); return; }   // long hair gets its own finer layer\n", 'hair meshes')
    html = sub_once(html, "  if (head) {                                    // the epic part",
                    "  const hair = hairMeshes.length && head ? makeLongHair(model, points, geo, browMeshes, eyeMeshes, invRoot, head, span) : null;\n"
                    "  if (model.userData.jvBeard && head) makeBeard(model, points, geo, eyeMeshes, invRoot, head, span);\n  if (head) {                                    // the epic part", 'hair and beard')
    html = sub_once(html, "    particleFx = { spark, orbit, followFace };", "    particleFx = { spark, orbit, followFace, hair };", 'hair fx')
    html = sub_once(html, "function doSwap(url) {", desk[a:beard_end] + "\nfunction doSwap(url) {", 'hair and beard code')
    html = sub_once(html, "    avatarModel = gltf.scene;\n", "    avatarModel = gltf.scene;\n    avatarModel.userData.jvBeard = /kofi/i.test(url);       // his face gets a beard (makeBeard)\n", 'beard face')
    html = sub_once(html, "f.orbit.rotation.z = 0.12 * Math.sin(t * 0.2);\n", "f.orbit.rotation.z = 0.12 * Math.sin(t * 0.2);\n    if (f.hair) f.hair.sway(t, speakingAmount);\n", 'hair sway')
    # ---- the globe (the PC's hud_extra.js, copied below) takes over the screen: the face stops drawing while it's up
    html = sub_once(html, "window.__jvPaused || window.__jvHideFace ||", "window.__jvPaused || window.__jvHideFace || window.__jvFaceOff ||", 'globe hides the face')
    html = sub_once(html, "      else if (data.startsWith('proactive:')) {", "      else if (data.startsWith('globe:')) { if (window.__jvExtra) window.__jvExtra(data); else (window.__jvExtraQ = window.__jvExtraQ || []).push(data); }\n"
                    "      else if (data.startsWith('proactive:')) {", 'globe messages')

    # ================================================================ the PC's newer face and voice, carried over
    # The gold dot face (a real face scan), a head that moves with purpose and with his words, lips that make the shapes of
    # the words, expressions, and the answer console. Taken from the PC page so both stay the same; phone differences below.
    a = desk.index('// ============================================================\n// THE FACE: a real 3D face scan')
    b = desk.index("loadAvatar((window.__jvFaceFor && window.__jvFaceFor(null)) || AVATAR_FEMALE);")
    scan = desk[a:b]
    # (the face scan and its texture decoder come from the same CDN as on the PC: no face scan offline, the old face stays)
    scan = sub_once(scan, """      window.__jvScan = true; pendingSwapUrl = null;
      if (avatarModel) avatarModel.visible = false;
      particles.visible = false;                  // a clean face: no dust around it
      faceGroup.add(S.holder);
      window.__jvScanUpdate = (dt, t) => updateScanFace(S, dt, t);""", """      // phone: the scan is the male face; the female face and the orb stay as they were (local/faces.js)
      window.__jvScan = true; faceGroup.add(S.holder);
      window.__jvScanOn = on => { window.__jvScanActive = on; S.holder.visible = on; particles.visible = !on; if (avatarModel) avatarModel.visible = !on; if (on) S.fade = 0; };
      window.__jvScanOn(!currentAvatarUrl || /kofi|adam/i.test(currentAvatarUrl));
      window.__jvScanUpdate = (dt, t) => { if (window.__jvScanActive) updateScanFace(S, dt, t); };""", 'scan: male face only')
    html = sub_once(html, "loadAvatar((window.__jvFaceFor && window.__jvFaceFor(null)) || AVATAR_FEMALE);", scan + "loadAvatar((window.__jvFaceFor && window.__jvFaceFor(null)) || AVATAR_FEMALE);", 'scan face')
    html = sub_once(html, "function loadAvatar(url) {\n", "function loadAvatar(url) {\n"
                    "  if (window.__jvScan) { const on = /kofi|adam/i.test(url); window.__jvScanOn(on);   // the male face is the face scan\n"
                    "    if (on) { currentAvatarUrl = url; try { window.dispatchEvent(new CustomEvent('jv-avatar-ready', { detail: 'scan' })); } catch (e) {} return; } }\n", 'scan face choice')
    html = sub_once(html, "import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';\n",
                    "import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';\nimport { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\n", 'ktx2 loader')
    html = sub_once(html, "  driveLipSync(t, speakingAmount);\n", "  driveLipSync(t, speakingAmount);\n  if (window.__jvScanUpdate) window.__jvScanUpdate(dt, t);\n", 'scan face each frame')
    # the head turns for a reason, never on a loop: no camera drift, no fixed tilt
    html = sub_once(html, "  camera.position.x = CAM_BASE.x + Math.sin(t*0.1)*0.08;", "  camera.position.x = CAM_BASE.x;", 'no camera drift x')
    html = sub_once(html, "  camera.position.y = CAM_BASE.y + Math.cos(t*0.08)*0.06;", "  camera.position.y = CAM_BASE.y;", 'no camera drift y')
    html = sub_once(html, "  const yaw = mouseNormX * 0.05 + spin.yaw, pitch = -mouseNormY * 0.03 + spin.pitch,",
                    "  const yaw = (window.__jvScanActive ? 0 : mouseNormX * 0.05) + spin.yaw, pitch = (window.__jvScanActive ? 0 : -mouseNormY * 0.03) + spin.pitch,", 'scan: no fixed tilt')
    a = desk.index('// look at a point on the screen for a moment')
    b = desk.index("G.push({ kind: 'wow', at: t0, d: 0.8, a: 1 });\n});\n") + len("G.push({ kind: 'wow', at: t0, d: 0.8, a: 1 });\n});\n")
    html = sub_once(html, "function doSwap(url) {", desk[a:b] + PHONE_SPEECH_JS + "\nfunction doSwap(url) {", 'head gestures and speech timing')
    # lips.js (mouth shapes for the words) and the "[warm]"-free text, before the page's scripts; the console after the page
    html = sub_once(html, '<script type="module" src="local/boot.js"></script>',
                    '<script src="lips.js"></script>\n<script>' + UNSTAGE_JS + '</script>\n<script type="module" src="local/boot.js"></script>\n'
                    '<script type="module" src="local/console.js"></script>', 'lips and console scripts')
    html = sub_once(html, "function addMsg(text, who) {\n", "function addMsg(text, who) {\n  if (who === 'jarvis' || who === 'proactive') text = window.__jvUnstage(text);   // \"[warm]\" is how it's said, not what's shown\n", 'no directions on screen')

    # no localhost anywhere: the page must only talk to its own origin (which the app answers itself)
    os.makedirs(WWW, exist_ok=True)
    open(os.path.join(WWW, 'index.html'), 'w', encoding='utf-8').write(html)
    nav = open(os.path.join(SRC, 'nav.js'), encoding='utf-8').read()
    # MapLibre ships inside the app too (the build workflow copies it to www/vendor/maplibre)
    nav = sub_once(nav, "'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js'", "'./vendor/maplibre/maplibre-gl.js'", 'maplibre js')
    nav = sub_once(nav, "'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css'", "'./vendor/maplibre/maplibre-gl.css'", 'maplibre css')
    # ---- phone "dash" view for deliveries: route card on top, a small map with directions under it, the face as an orb
    #      in the bottom-right corner (ui.js has the layout). Starts by itself while there are orders.
    # (a phone gets a small head so the map has the room)
    nav = sub_once(nav, """    const D = Math.round(clamp(H * 0.18, 110, 170)), R = 0.36 * H, sc = D / (2 * R);
    const cx = 28 + D / 2, cy = H - 40 - D / 2;""", """    const dash = S.view === 'dash';
    const D = Math.round(dash || W < H ? clamp(H * 0.13, 88, 116) : clamp(H * 0.18, 110, 170)), R = Math.min(0.36 * H, 0.44 * W), sc = D / (2 * R);   // portrait: the circle fits the face, not the screen
    // on a phone the head sits in the bottom-right corner, just above the trip numbers (arrive / left / distance)
    const ne = document.querySelector('.ne'), neBox = ne && ne.getBoundingClientRect(), portrait = W < H;
    const low = dash ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dash-orb-bottom')) || 120)
      : portrait ? (neBox && neBox.height ? H - neBox.top + 12 : 110) : 40;
    const fy = portrait ? 0.5 : 0.45; document.documentElement.style.setProperty('--orb-fy', (fy * 100) + '%');
    const cx = dash || portrait ? W - 16 - D / 2 : 28 + D / 2, cy = H - low - D / 2;""", 'dash orb corner')
    nav = sub_once(nav, "    r.setProperty('--orb-tx', (cx - sc * 0.5 * W) + 'px'); r.setProperty('--orb-ty', (cy - sc * 0.45 * H) + 'px');",
                   "    r.setProperty('--orb-tx', (cx - sc * 0.5 * W) + 'px'); r.setProperty('--orb-ty', (cy - sc * fy * H) + 'px');", 'orb face centre')
    nav = sub_once(nav, "transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% 45%); }",
                   "transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% var(--orb-fy, 45%)); }", 'orb clip centre')
    nav = sub_once(nav, "      document.body.setAttribute('data-nav', mode);\n", "      document.body.setAttribute('data-nav', mode);\n      startGps();\n", 'map view starts gps')
    # 3D: the camera tilts further and comes closer while following, so streets and buildings stand up like a 3D sat-nav
    nav = sub_once(nav, "bearing: f.heading || 0, pitch: 55, zoom: f.zoom,", "bearing: f.heading || 0, pitch: 65, zoom: f.zoom + 0.5,", 'map 3d follow')
    nav = sub_once(nav, "case 'view': if (m.mode === 'full' || m.mode === 'mini')", "case 'view': if (m.mode === 'full' || m.mode === 'mini' || m.mode === 'dash')", 'dash view message')
    nav = sub_once(nav, "    if (meta.view !== 'keep') setView(S.view === 'mini' ? 'mini' : 'full');", "    if (meta.view !== 'keep') setView(meta.view === 'dash' ? 'dash' : S.view === 'mini' ? 'mini' : 'full');", 'dash route view')
    # MapLibre's stylesheet (loaded later) sets .maplibregl-map { position: relative }, which collapsed the map box to zero
    # height: the map drew, but invisibly. A more specific rule keeps the box filling its frame.
    nav = sub_once(nav, ".nav-box { position: absolute; inset: 0; }", "#nav-map .nav-box { position: absolute; inset: 0; }", 'map box stays full size')
    open(os.path.join(WWW, 'nav.js'), 'w', encoding='utf-8').write(nav)
    shutil.copyfile(os.path.join(SRC, 'nav_core.js'), os.path.join(WWW, 'nav_core.js'))
    # the globe: the PC's own module and its pictures, borders and names
    shutil.copyfile(os.path.join(DESK, 'hud_extra.js'), os.path.join(WWW, 'hud_extra.js'))
    shutil.copyfile(os.path.join(DESK, 'lips.js'), os.path.join(WWW, 'lips.js'))
    os.makedirs(os.path.join(WWW, 'fonts'), exist_ok=True)
    shutil.copyfile(os.path.join(DESK, 'models', 'fonts', 'JetBrainsMono.woff2'), os.path.join(WWW, 'fonts', 'JetBrainsMono.woff2'))
    shutil.copyfile(os.path.join(DESK, 'models', 'fonts', 'JetBrainsMono-OFL.txt'), os.path.join(WWW, 'fonts', 'JetBrainsMono-OFL.txt'))
    os.makedirs(os.path.join(WWW, 'models', 'globe'), exist_ok=True)
    for f in ('blue.jpg', 'countries.bin', 'states.bin', 'labels.json'):
        shutil.copyfile(os.path.join(DESK, 'models', 'globe', f), os.path.join(WWW, 'models', 'globe', f))
    os.makedirs(os.path.join(WWW, 'models'), exist_ok=True)
    keep = os.path.join(WWW, 'models', 'README.txt')
    if not os.path.exists(keep) and not any(f.endswith('.glb') for f in os.listdir(os.path.join(WWW, 'models'))):
        open(keep, 'w').write('Copy your PC Jarvis "models" folder contents here (adam.glb, gideon.png, ...).\nThey are packed into the app.\n')
    print('wrote', os.path.join(WWW, 'index.html'), f'({len(html)//1024} KB)')


if __name__ == '__main__':
    main()
