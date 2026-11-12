// xray.js - the X-ray mirror (after the "X-Ray Mirror" demo): the camera as a mirror with a labelled skull, brain, muscles, eyes and
// hand bones laid onto you in real time from MediaPipe's face and hand tracking. The anatomy is real 3D models of one adult (BodyParts3D)
// fitted to your face, not
// your real insides: a camera only sees skin. What it does measure for real, from the same video:
//   pulse      - remote photoplethysmography (POS method): blood flow changes the colour of your face very slightly with each beat
//   breathing  - the chest region rising and falling, as a vertical shift of its brightness profile
//   tiredness  - blink rate, how long the eyes are closed (PERCLOS) and yawns, from the face model's blink and jaw scores
//   posture    - leaning in, sinking down or head bent, against how you sat when it started
// Your own scans (an X-ray or MRI picture) can be dropped on the mirror and pinned to your head or hand.
// Not a medical device: rough numbers for curiosity and habits, never a diagnosis.
const VER = '0.10.14', CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

// ---------------------------------------------------------------- signal maths (pure, tested in tests/xray_vitals.test.mjs)
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
/** Samples at uneven times -> evenly spaced at fs per second (linear interpolation). */
export function resample(ts, vals, fs) {
  const out = [], t0 = ts[0], n = Math.floor((ts[ts.length - 1] - t0) * fs);
  for (let i = 0, j = 0; i <= n; i++) {
    const t = t0 + i / fs; while (j < ts.length - 2 && ts[j + 1] < t) j++;
    const k = (t - ts[j]) / ((ts[j + 1] - ts[j]) || 1); out.push(vals[j] + (vals[j + 1] - vals[j]) * Math.max(0, Math.min(1, k)));
  }
  return out;
}
/** The strongest rhythm between lo and hi Hz: { hz, snr } (snr = share of the band's power at the peak and its first harmonic). */
export function dominant(sig, fs, lo, hi) {
  const n = sig.length, m = mean(sig), x = sig.map((v, i) => (v - m) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))));
  const step = Math.min(0.01, (hi - lo) / 200), P = [];
  for (let f = lo; f <= Math.min(hi * 2.1, fs / 2); f += step) {
    let re = 0, im = 0; const w = 2 * Math.PI * f / fs;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    P.push([f, re * re + im * im]);
  }
  const band = P.filter(([f]) => f <= hi); if (!band.length) return { hz: 0, snr: 0 };
  const [hz] = band.reduce((a, b) => (b[1] > a[1] ? b : a));
  const near = (f0, f) => Math.abs(f - f0) <= 0.08 * Math.max(1, f0);
  const sig2 = P.filter(([f]) => near(hz, f) || near(2 * hz, f)).reduce((s, [, p]) => s + p, 0);
  const all = P.filter(([f]) => f <= Math.min(hi * 2.1, fs / 2)).reduce((s, [, p]) => s + p, 0);
  return { hz, snr: sig2 / (all || 1) };
}
/** Pulse from face colour (POS, Wang et al. 2017): rgb = [[r,g,b]...] evenly spaced at fs. Returns { bpm, snr }. */
export function posPulse(rgb, fs) {
  const n = rgb.length, l = Math.round(1.6 * fs), H = new Array(n).fill(0);
  if (n < l + fs * 4) return { bpm: 0, snr: 0 };
  for (let t = 0; t + l <= n; t++) {
    const win = rgb.slice(t, t + l), mr = mean(win.map(c => c[0])), mg = mean(win.map(c => c[1])), mb = mean(win.map(c => c[2]));
    const s1 = win.map(c => c[1] / mg - c[2] / mb), s2 = win.map(c => c[1] / mg + c[2] / mb - 2 * c[0] / mr);
    const a = std(s1) / std(s2), h = s1.map((v, i) => v + a * s2[i]), hm = mean(h);
    for (let i = 0; i < l; i++) H[t + i] += h[i] - hm;
  }
  const d = dominant(H, fs, 0.7, 3.0);
  return { bpm: Math.round(d.hz * 60), snr: d.snr };
}
/** Breaths a minute from a slow up-and-down movement signal. */
export function breathRate(sig, fs) {
  const n = sig.length; if (n < fs * 20) return { rpm: 0, snr: 0 };
  const xs = sig.map((_, i) => i), mx = mean(xs), my = mean(sig);
  const k = xs.reduce((s, x, i) => s + (x - mx) * (sig[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
  const d = dominant(sig.map((v, i) => v - my - k * (i - mx)), fs, 0.1, 0.7);
  return { rpm: Math.round(d.hz * 60), snr: d.snr };
}
/** How tired: from blinks a minute, PERCLOS (share of time the eyes are mostly shut) and yawns in the last minutes. */
export function tiredness(blinksPerMin, perclos, yawns) {
  const score = (perclos > 0.15 ? 2 : perclos > 0.08 ? 1 : 0) + (blinksPerMin > 28 ? 1 : 0) + (yawns >= 2 ? 1 : 0);
  return score >= 3 ? 'tired' : score >= 1 ? 'a bit tired' : 'alert';
}

// ---------------------------------------------------------------- the mirror
export function createXray({ say = () => {}, onState = () => {} } = {}) {
  const $ = id => document.getElementById(id);
  const st = document.createElement('style');
  st.textContent = `
  #pc-xray { position: fixed; inset: 0; z-index: 60; background: #000; display: none; }
  #pc-xray.on { display: block; }
  #pc-xray video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); filter: grayscale(1) contrast(1.15) brightness(.8); }
  #pc-xray canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  #pc-xray canvas.cam { object-fit: cover; transform: scaleX(-1); }
  #pc-xray .tint { position: absolute; inset: 0; background: #0b2a4a; mix-blend-mode: color; pointer-events: none; }
  #pc-xray .panel { position: absolute; right: 16px; top: 16px; width: 250px; max-height: calc(100vh - 32px); overflow: auto; padding: 14px 14px 12px; border-radius: 14px;
    background: rgba(8, 14, 22, .82); border: 1px solid rgba(140, 200, 255, .28); color: #dcecff; font: 400 12.5px/1.45 'Saira', system-ui, sans-serif; backdrop-filter: blur(10px); }
  #pc-xray button, #pc-xray select { letter-spacing: normal; text-transform: none; }
  #pc-xray [hidden] { display: none !important; }
  #pc-xray .panel h3 { margin: 0 0 8px; font: 600 12px/1 'Saira', system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #9fd2ff; }
  #pc-xray .panel section { margin-bottom: 12px; }
  #pc-xray .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  #pc-xray .chips button, #pc-xray .row button, #pc-xray select { border-radius: 8px; border: 1px solid rgba(140, 200, 255, .35); background: rgba(20, 34, 50, .9); color: #dcecff;
    font: 500 12px 'Saira', system-ui, sans-serif; padding: 5px 9px; cursor: pointer; }
  #pc-xray .chips button.on { background: #2b6ea6; border-color: #7cc4ff; color: #fff; }
  #pc-xray input[type=range] { width: 100%; accent-color: #7cc4ff; }
  #pc-xray .row { display: flex; gap: 6px; align-items: center; justify-content: space-between; margin: 4px 0; }
  #pc-xray .vit div { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid rgba(140, 200, 255, .1); }
  #pc-xray .vit b { font-weight: 600; color: #fff; }
  #pc-xray .note { font-size: 10.5px; opacity: .65; margin-top: 6px; }
  #pc-xray .close { position: absolute; left: 16px; top: 16px; border-radius: 20px; padding: 7px 14px; border: 1px solid rgba(140, 200, 255, .4); background: rgba(8, 14, 22, .8);
    color: #dcecff; font: 600 12px 'Saira', system-ui, sans-serif; cursor: pointer; }
  #pc-xray .drop { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font: 600 20px 'Saira', sans-serif; color: #bfe3ff; background: rgba(0, 30, 60, .5); }
  #pc-xray.dragging .drop { display: flex; }`;
  document.head.appendChild(st);
  const root = document.createElement('div'); root.id = 'pc-xray';
  root.innerHTML = `<video playsinline muted></video><div class="tint"></div><canvas class="cam" data-c="shade"></canvas><canvas class="cam" data-c="gl"></canvas><canvas data-c="hud"></canvas><button class="close" type="button">← Back to Jarvis</button>
    <div class="panel" role="region" aria-label="X-ray mirror controls">
      <section><h3>Layers</h3><div class="chips" data-g="layers">
        <button data-k="skull" class="on">Skull</button><button data-k="brain">Brain</button><button data-k="muscles">Muscles</button>
        <button data-k="eyes" class="on">Eyes</button><button data-k="hands" class="on">Hand bones</button><button data-k="labels" class="on">Labels</button></div></section>
      <section><h3>Show</h3><select data-k="cut" aria-label="Which part of the head"><option value="all">Whole head</option><option value="left">Left half</option>
        <option value="right">Right half</option><option value="top">Top of the head</option><option value="lower">Lower face</option></select>
        <div class="row"><span>See-through</span><span data-v="see">85%</span></div><input type="range" min="0" max="100" value="85" data-k="see" aria-label="See-through">
        <div class="row"><span>Brightness</span><span data-v="bright">100%</span></div><input type="range" min="30" max="160" value="100" data-k="bright" aria-label="Brightness"></section>
      <section><h3>Measured from the camera</h3><div class="vit">
        <div><span>Pulse</span><b data-m="pulse">–</b></div><div><span>Breathing</span><b data-m="breath">–</b></div>
        <div><span>Blinks</span><b data-m="blinks">–</b></div><div><span>Alertness</span><b data-m="tired">–</b></div><div><span>Posture</span><b data-m="posture">–</b></div></div>
        <div class="note">Sit still in good light for 20 seconds. Rough readings for habits and curiosity, not a medical device.</div></section>
      <section><h3>Your own scan</h3><div class="row"><button type="button" data-k="load">Load an X-ray / MRI</button><button type="button" data-k="pin" hidden>On head</button></div>
        <input type="file" accept="image/*" hidden><div class="row" data-k="scanrow" hidden><span>Opacity</span><input type="range" min="10" max="100" value="70" data-k="scanop" aria-label="Scan opacity"></div>
        <div class="note">Or drop the picture on the mirror. It stays on this computer.</div></section>
      <div class="note">Anatomy: BodyParts3D, © The Database Center for Life Science, CC BY-SA 2.1 JP. One adult's anatomy fitted to you, not a scan of you.</div>
    </div><div class="drop">Drop your scan to pin it on you</div>`;
  document.body.appendChild(root);
  const video = root.querySelector('video'), cv = root.querySelector('[data-c=hud]'), g = cv.getContext('2d');
  const glc = root.querySelector('[data-c=gl]'), shade = root.querySelector('[data-c=shade]'), sh = shade.getContext('2d');
  const small = document.createElement('canvas'); small.width = 160; small.height = 120; const sg = small.getContext('2d', { willReadFrequently: true });
  const opt = { skull: true, brain: false, muscles: false, eyes: true, hands: true, labels: true, cut: 'all', see: 0.85, bright: 1 };
  let on = false, show = false, stream = null, face = null, hand = null, raf = 0, lastT = 0, tick = 0, faceRes = null, handRes = null;
  let scan = null, scanOn = 'head', scanOp = 0.7, R3 = null;

  // ---- the controls
  root.querySelector('.close').onclick = () => close();
  root.querySelectorAll('[data-g=layers] button').forEach(b => b.onclick = () => { opt[b.dataset.k] = !opt[b.dataset.k]; sync(); });
  root.querySelector('select').onchange = e => { opt.cut = e.target.value; };
  root.querySelector('[data-k=see]').oninput = e => { opt.see = e.target.value / 100; sync(); };
  root.querySelector('[data-k=bright]').oninput = e => { opt.bright = e.target.value / 100; sync(); };
  root.querySelector('[data-k=scanop]').oninput = e => { scanOp = e.target.value / 100; };
  const file = root.querySelector('input[type=file]'), pin = root.querySelector('[data-k=pin]');
  root.querySelector('[data-k=load]').onclick = () => file.click();
  file.onchange = () => file.files[0] && loadScan(file.files[0]);
  pin.onclick = () => { scanOn = scanOn === 'head' ? 'hand' : 'head'; pin.textContent = scanOn === 'head' ? 'On head' : 'On hand'; };
  root.addEventListener('dragover', e => { e.preventDefault(); root.classList.add('dragging'); });
  root.addEventListener('dragleave', e => { if (e.target === root.querySelector('.drop')) root.classList.remove('dragging'); });
  root.addEventListener('drop', e => { e.preventDefault(); root.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f && /^image\//.test(f.type)) loadScan(f); });
  function loadScan(f) {
    const img = new Image(); img.onload = () => { scan = img; pin.hidden = false; root.querySelector('[data-k=scanrow]').hidden = false; };
    img.src = URL.createObjectURL(f);
  }
  function sync() {
    root.querySelectorAll('[data-g=layers] button').forEach(b => b.classList.toggle('on', !!opt[b.dataset.k]));
    root.querySelector('[data-v=see]').textContent = Math.round(opt.see * 100) + '%';
    root.querySelector('[data-v=bright]').textContent = Math.round(opt.bright * 100) + '%';
    root.querySelector('select').value = opt.cut;
  }

  // ---- camera and tracking
  async function start() {
    if (stream) return true;
    const V = await import(`${CDN}/vision_bundle.mjs`), files = await V.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    face = face || await V.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
    await build3d();
    hand = hand || await V.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2 });
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: { ideal: 30 } } });
    video.srcObject = stream; await video.play();
    raf = requestAnimationFrame(loop); return true;
  }
  function stopCam() { cancelAnimationFrame(raf); try { stream && stream.getTracks().forEach(t => t.stop()); } catch {} stream = null; faceRes = handRes = null; }

  function loop(now) {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || now - lastT < 30) return;
    lastT = now; tick++;
    faceRes = face.detectForVideo(video, now);
    if (show && opt.hands && tick % 2) handRes = hand.detectForVideo(video, now + 0.5);
    measure(now);
    if (show) draw();
  }

  // ---- screen geometry: the video fills the window (cover) and is mirrored
  let vw = 1, vh = 1, sc = 1, ox = 0, oy = 0;
  function fit() {
    const w = innerWidth, h = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    vw = video.videoWidth || 640; vh = video.videoHeight || 480; sc = Math.max(w / vw, h / vh); ox = (w - vw * sc) / 2; oy = (h - vh * sc) / 2;
  }
  const S = p => ({ x: ox + (1 - p.x) * vw * sc, y: oy + p.y * vh * sc });
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function draw() {
    fit(); const W = innerWidth, H = innerHeight;
    g.clearRect(0, 0, W, H);
    const f = faceRes && faceRes.faceLandmarks && faceRes.faceLandmarks[0];
    const mat = faceRes && faceRes.facialTransformationMatrixes && faceRes.facialTransformationMatrixes[0];
    const hs = (opt.hands && handRes && handRes.landmarks) || [];
    const groups = [];
    if (R3) {
      const labels = R3.frame(f && mat ? mat.data : null, f, jawOpen(), hs);
      if (labels.head.length) groups.push({ c: S(f[1]), half: dist(S(f[234]), S(f[454])) * 0.56, labels: labels.head });
      labels.hands.forEach((l, i) => { const p = hs[i].map(S); groups.push({ c: p[9], half: Math.max(...p.map(q => Math.abs(q.x - p[9].x))), labels: l }); });
    }
    if (scan) drawScan(f, hs[0]);
    if (opt.labels) groups.forEach(gr => drawLabels(gr.labels, gr.c, gr.half));
  }
  function jawOpen() {
    const b = faceRes && faceRes.faceBlendshapes && faceRes.faceBlendshapes[0];
    const c = b && b.categories.find(x => x.categoryName === 'jawOpen');
    return c ? c.score : 0;
  }

  // ---- 3D anatomy: real meshes (BodyParts3D, see models/xray/LICENSE.txt) placed by MediaPipe's head pose.
  // The GL picture is drawn in the camera's own pixels and stretched and mirrored by CSS exactly like the video.
  const VERT = `uniform mat4 uToHead; uniform float uOrtho; varying vec3 vN, vV, vL;
    void main() { vL = (uToHead * vec4(position, 1.0)).xyz; vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = uOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
  const FRAG = `uniform vec3 uColor; uniform float uAlpha, uGain, uVeil, uFade, uClipOn; uniform vec4 uClip; varying vec3 vN, vV, vL;
    void main() {
      float soft = 1.0;
      if (uClipOn > 0.5) { float d = dot(uClip.xyz, vL) - uClip.w; if (d < 0.0) discard; soft = smoothstep(0.0, 1.2, d); }
      float ndv = abs(dot(normalize(vN), normalize(vV)));
      float fade = uFade > 0.5 ? smoothstep(-12.6, -6.0, vL.y) : 1.0;        // the neck fades out instead of ending in a hard edge
      if (uVeil > 0.5) { gl_FragColor = vec4(uColor, uAlpha * fade * soft); return; }
      float rim = pow(1.0 - ndv, 2.2);                                        // edges seen side-on glow, like bone on film
      gl_FragColor = vec4(uColor, clamp((0.04 + 0.95 * rim) * uGain * fade, 0.0, 1.0) * soft * smoothstep(0.0, 0.18, ndv)); }`;
  const BONES = [[1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12], [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]];
  const GAIN = { skin: 0.28, muscles: 0.5, cranium: 0.85, jaw: 0.85, cerebrum: 0.36, hindbrain: 0.6, eyes: 0.9 };
  const LAYER = { skin: 'skull', cranium: 'skull', jaw: 'skull', cerebrum: 'brain', hindbrain: 'brain', muscles: 'muscles', eyes: 'eyes' };

  async function build3d() {
    if (R3) return;
    const THREE = await import('three');
    const [meta, buf] = await Promise.all([fetch('/models/xray/anatomy.json').then(r => r.json()), fetch('/models/xray/anatomy.bin').then(r => r.arrayBuffer())]);
    const geo = {};
    for (const m of meta.meshes) {            // positions are 16-bit, scaled into each mesh's box
      const q = new Uint16Array(buf, m.offV, m.nv * 3), pos = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) pos[i] = m.min[i % 3] + q[i] / 65535 * m.size[i % 3];
      const gm = new THREE.BufferGeometry(); gm.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      gm.setIndex(new THREE.BufferAttribute(new Uint16Array(buf, m.offI, m.ni).slice(), 1)); gm.computeVertexNormals(); geo[m.name] = gm;
    }
    const renderer = new THREE.WebGLRenderer({ canvas: glc, alpha: true, antialias: true }); renderer.setClearColor(0, 0); renderer.autoClear = false;
    const mat = (color, veil) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: veil ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 1 }, uGain: { value: 1 }, uVeil: { value: veil ? 1 : 0 }, uFade: { value: 0 }, uOrtho: { value: 0 },
        uClipOn: { value: 0 }, uClip: { value: new THREE.Vector4() }, uToHead: { value: new THREE.Matrix4() } } });
    const headScene = new THREE.Scene(), handScene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(63, 16 / 9, 1, 10000);   // MediaPipe's head pose assumes a 63° vertical view
    const ortho = new THREE.OrthographicCamera(0, 1, 1, 0, -5000, 5000);
    const head = new THREE.Group(); head.matrixAutoUpdate = false; headScene.add(head);
    const jawPivot = new THREE.Group(); jawPivot.position.fromArray(meta.jawPivot); head.add(jawPivot);
    const parts = {};
    const add = (name, g0, color, order, veil, parent = head) => {
      const m = new THREE.Mesh(g0, mat(color, veil)); m.renderOrder = order; m.frustumCulled = false; parent.add(m); return (parts[name] = m);
    };
    add('veil', geo.skin, 0x02060c, -10, true).material.uniforms.uFade.value = 1;
    add('skin', geo.skin, 0x6fb6ff, 1).material.uniforms.uFade.value = 1;
    add('muscles', geo.muscles, 0xff6b5e, 2);
    add('cranium', geo.cranium, 0xcfe8ff, 3);
    add('jaw', geo.jaw, 0xcfe8ff, 3, false, jawPivot).position.fromArray(meta.jawPivot).multiplyScalar(-1);
    add('eyes', geo.eyes, 0xfff3a8, 4);
    add('cerebrum', geo.cerebrum, 0xff9fc0, 5);
    add('hindbrain', geo.hindbrain, 0xffc37a, 5);
    const hands = [0, 1].map(() => {
      const grp = new THREE.Group(); handScene.add(grp);
      const mk = g0 => { const m = new THREE.Mesh(g0, mat(0xdcefff)); m.material.uniforms.uOrtho.value = 1; m.matrixAutoUpdate = false; m.frustumCulled = false; grp.add(m); return m; };
      return { grp, palm: mk(geo.hand_palm), bones: BONES.map(([a, b]) => mk(geo[`hand_b_${a}_${b}`])), pts: null };
    });
    const cb = meta.meshes.find(m => m.name === 'cranium'), centre = new THREE.Vector3(...cb.min.map((v, i) => v + cb.size[i] / 2));
    const fitIds = Object.keys(meta.fit).map(Number);
    const T = { m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(), v: new THREE.Vector3(), n: new THREE.Vector3(),
      a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), e1: new THREE.Vector3(), e2: new THREE.Vector3(), e3: new THREE.Vector3(), jawM: new THREE.Matrix4() };
    const pose = { found: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1), fs: 1, fx: 0, fy: 0, jaw: 0 };
    let base = cam.projectionMatrix.clone(), bw = 0, bh = 0;

    function size() {            // drawing buffer = the video's on-screen size, so lines stay sharp
      const dpr = Math.min(2, devicePixelRatio || 1), w = Math.min(2560, Math.round(vw * sc * dpr)), h = Math.round(w * vh / vw);
      if (w === bw && h === bh) return;
      bw = w; bh = h; renderer.setSize(w, h, false); shade.width = vw; shade.height = vh;
      cam.aspect = vw / vh; cam.updateProjectionMatrix(); base = cam.projectionMatrix.clone();
      ortho.right = vw; ortho.top = vh; ortho.updateProjectionMatrix();
    }

    function placeHead(data, lm, jaw) {
      T.m.fromArray(data);
      const e = T.m.elements;     // accept either memory layout
      if (Math.abs(e[12]) + Math.abs(e[13]) + Math.abs(e[14]) < 1e-6 && Math.abs(e[3]) + Math.abs(e[7]) + Math.abs(e[11]) > 1e-3) T.m.transpose();
      T.m.decompose(T.p, T.q, T.s);
      if (!pose.found) { pose.p.copy(T.p); pose.q.copy(T.q); pose.s.copy(T.s); pose.fs = 1; pose.fx = pose.fy = 0; }
      else { pose.p.lerp(T.p, 0.6); pose.q.slerp(T.q, 0.55); pose.s.lerp(T.s, 0.5); }
      pose.found = true; pose.jaw += (jaw - pose.jaw) * 0.6;
      head.matrix.compose(pose.p, pose.q, pose.s); head.matrixWorldNeedsUpdate = true;
      // nudge the picture so the model's key points land on the tracked ones (least-squares scale + shift on screen)
      const P = [], Q = [];
      for (const id of fitIds) if (lm[id]) { T.v.fromArray(meta.fit[id]).applyMatrix4(head.matrix).applyMatrix4(base); P.push([T.v.x, T.v.y]); Q.push([lm[id].x * 2 - 1, 1 - lm[id].y * 2]); }
      const avg = (A, k) => A.reduce((s, a) => s + a[k], 0) / A.length, px = avg(P, 0), py = avg(P, 1), qx = avg(Q, 0), qy = avg(Q, 1);
      let num = 0, den = 0;
      P.forEach(([x, y], i) => { num += (x - px) * (Q[i][0] - qx) + (y - py) * (Q[i][1] - qy); den += (x - px) ** 2 + (y - py) ** 2; });
      const s = Math.max(0.6, Math.min(1.6, den > 1e-9 ? num / den : 1));
      pose.fs += (s - pose.fs) * 0.5; pose.fx += (qx - pose.fs * px - pose.fx) * 0.7; pose.fy += (qy - pose.fs * py - pose.fy) * 0.7;
      T.m.set(pose.fs, 0, 0, pose.fx, 0, pose.fs, 0, pose.fy, 0, 0, 1, 0, 0, 0, 0, 1);
      cam.projectionMatrix.copy(base).premultiply(T.m); cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      jawPivot.rotation.x = Math.min(1, Math.max(0, pose.jaw)) * 0.36;
      jawPivot.updateMatrix(); parts.jaw.updateMatrix(); T.jawM.copy(jawPivot.matrix).multiply(parts.jaw.matrix);
    }

    function placeHand(rig, lm) {      // camera pixels, depth scaled like x
      const fresh = !rig.grp.visible;
      if (!rig.pts) rig.pts = lm.map(() => new THREE.Vector3());
      lm.forEach((p, i) => { T.v.set(p.x * vw, (1 - p.y) * vh, -p.z * vw); fresh ? rig.pts[i].copy(T.v) : rig.pts[i].lerp(T.v, 0.65); });
      const P = rig.pts;
      T.e1.subVectors(P[5], P[0]); T.e2.subVectors(P[17], P[0]);
      T.e3.crossVectors(T.e1, T.e2).normalize().multiplyScalar(Math.sqrt(T.e1.length() * T.e2.length()));
      rig.palm.matrix.makeBasis(T.e1, T.e2, T.e3).setPosition(P[0]); rig.palm.matrixWorldNeedsUpdate = true;
      T.c.subVectors(P[17], P[5]).normalize();                 // across the knuckles: gives each bone its roll
      BONES.forEach(([a, b], i) => {
        T.a.subVectors(P[b], P[a]); const len = Math.max(1e-6, T.a.length()); T.a.divideScalar(len);
        T.b.copy(T.c).addScaledVector(T.a, -T.c.dot(T.a)); if (T.b.lengthSq() < 1e-6) T.b.set(1, 0, 0); T.b.normalize();
        const L = len * (b % 4 === 0 ? 0.8 : 1);              // the fingertip point sits past the end of the bone
        T.e3.crossVectors(T.a, T.b).multiplyScalar(L);
        rig.bones[i].matrix.makeBasis(T.e1.copy(T.a).multiplyScalar(L), T.e2.copy(T.b).multiplyScalar(L), T.e3).setPosition(P[a]);
        rig.bones[i].matrixWorldNeedsUpdate = true;
      });
      rig.grp.visible = true;
    }

    const clip = () => ({ all: null, left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 2.5], lower: [0, -1, -2.5] }[opt.cut]);   // head cm; +x is your left
    function style() {
      const c = clip(), heavy = Math.max(1, ['skull', 'brain', 'muscles'].filter(k => opt[k]).length), share = 1 / (0.4 + 0.6 * heavy);  // glowing layers add up
      for (const [k, m] of Object.entries(parts)) {
        const u = m.material.uniforms;
        m.visible = k === 'veil' || !!opt[LAYER[k]];
        u.uAlpha.value = opt.see; u.uGain.value = opt.bright * (GAIN[k] || 1) * (k === 'skin' ? 1 : share);
        u.uClipOn.value = c ? 1 : 0; if (c) u.uClip.value.set(c[0], c[1], 0, c[2] || 0);
        if (k === 'jaw') u.uToHead.value.copy(T.jawM); else u.uToHead.value.identity();
      }
      for (const r of hands) for (const m of [r.palm, ...r.bones]) m.material.uniforms.uGain.value = opt.bright * 1.15;
    }

    function headLabels() {
      const out = [], c = clip();
      for (const L of meta.labels) {
        if (!opt[L.layer]) continue;
        let best = null;
        for (const p of L.pts) {
          T.v.fromArray(p); if (L.jaw) T.v.applyMatrix4(T.jawM);
          if (c && c[0] * T.v.x + c[1] * T.v.y < (c[2] || 0)) continue;                   // in the cut-away part
          T.n.subVectors(T.v, centre).transformDirection(head.matrix); T.v.applyMatrix4(head.matrix);
          const facing = -T.n.dot(T.a.copy(T.v).normalize());
          T.v.applyMatrix4(cam.projectionMatrix);
          if (!best || facing > best.f) best = { f: facing, x: (T.v.x + 1) / 2, y: (1 - T.v.y) / 2 };
        }
        if (best && best.f > -0.1) out.push([L.t, S(best)]);     // parts at the back of the head stay unlabelled when you face the camera
      }
      return out;
    }

    function veilHand(lm) {            // darken the real hand so the bones read clearly
      const px = i => lm[i].x * vw, py = i => lm[i].y * vh, d = Math.hypot(px(5) - px(17), py(5) - py(17)) || 1, path = new Path2D();
      [0, 1, 2, 5, 9, 13, 17].forEach((i, k) => k ? path.lineTo(px(i), py(i)) : path.moveTo(px(i), py(i))); path.closePath();
      for (const f of FINGERS) [0, ...f].forEach((i, k) => k ? path.lineTo(px(i), py(i)) : path.moveTo(px(i), py(i)));
      sh.save(); sh.filter = `blur(${(d * 0.06).toFixed(1)}px)`; sh.globalAlpha = opt.see * 0.92; sh.fillStyle = sh.strokeStyle = '#02060c';
      sh.lineJoin = sh.lineCap = 'round'; sh.lineWidth = d * 0.36; sh.fill(path); sh.stroke(path); sh.restore();
    }

    function frame(data, lm, jaw, hs) {
      size();
      if (data) placeHead(data, lm, jaw); else pose.found = false;
      head.visible = pose.found;
      sh.clearRect(0, 0, shade.width, shade.height);
      hands.forEach((r, i) => { if (hs[i]) { placeHand(r, hs[i]); veilHand(hs[i]); } else r.grp.visible = false; });
      style();
      renderer.clear(); renderer.render(headScene, cam); renderer.clearDepth(); renderer.render(handScene, ortho);
      const handLabels = hs.map(h => { const p = h.map(S); return [['Phalanges', lerp(p[10], p[11], 0.5)], ['Metacarpals', lerp(p[0], p[9], 0.6)], ['Carpals (wrist)', lerp(p[0], p[9], 0.1)], ['Thumb', p[3]]]; });
      return { head: pose.found ? headLabels() : [], hands: handLabels };
    }
    function clear() { pose.found = false; renderer.clear(); sh.clearRect(0, 0, shade.width, shade.height); }
    R3 = { frame, clear };
  }

  function drawScan(f, h) {
    let c, w, rot = 0;
    if (scanOn === 'hand' && h) { const p = h.map(S); c = lerp(p[0], p[9], 0.5); w = dist(p[0], p[9]) * 2.4; rot = Math.atan2(p[9].y - p[0].y, p[9].x - p[0].x) + Math.PI / 2; }
    else if (f) { const t = S(f[10]), b = S(f[152]); c = lerp(t, b, 0.42); w = dist(S(f[234]), S(f[454])) * 1.35; rot = Math.atan2(S(f[454]).y - S(f[234]).y, S(f[454]).x - S(f[234]).x); }
    else return;
    const hgt = w * scan.height / scan.width;
    g.save(); g.globalAlpha = scanOp; g.globalCompositeOperation = 'screen'; g.translate(c.x, c.y); g.rotate(rot); g.drawImage(scan, -w / 2, -hgt / 2, w, hgt); g.restore();
  }

  const panelEl = root.querySelector('.panel'), panelLeft = () => panelEl.getBoundingClientRect().left || innerWidth;   // labels stay clear of the controls
  function drawLabels(labels, centre, half) {          // columns sit just outside the head or hand
    if (!labels.length) return;
    // split by position into two even columns beside the subject (centre only breaks ties)
    const sorted = labels.map(([t, p]) => ({ t, p })).sort((a, b) => a.p.x - b.p.x || (a.p.x < centre.x ? -1 : 1)), mid = Math.ceil(sorted.length / 2);
    const sides = { l: sorted.slice(0, mid), r: sorted.slice(mid) };
    g.save(); g.font = "500 12px 'Saira', system-ui, sans-serif"; g.textBaseline = 'middle';
    for (const [k, list] of Object.entries(sides)) {
      list.sort((a, b) => a.p.y - b.p.y);
      const xs = list.map(l => l.p.x), edge = k === 'l' ? Math.min(centre.x - half, ...xs) - 24 : Math.max(centre.x + half, ...xs) + 24;
      let y = -Infinity;
      const ys = list.map(l => (y = Math.max(l.p.y, y + 18, 14)));
      const over = y - (innerHeight - 14); if (over > 0) ys.forEach((v, i) => { ys[i] = v - over; });   // keep the column on screen
      for (const [i, l] of list.entries()) {
        y = ys[i]; const tw = g.measureText(l.t).width, tx = k === 'l' ? Math.max(8, edge - tw) : Math.min(panelLeft() - tw - 12, edge);
        g.strokeStyle = 'rgba(170, 215, 255, .55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(l.p.x, l.p.y); g.lineTo(k === 'l' ? tx + tw + 4 : tx - 4, y); g.stroke();
        g.fillStyle = 'rgba(170, 215, 255, .9)'; g.beginPath(); g.arc(l.p.x, l.p.y, 2, 0, 2 * Math.PI); g.fill();
        g.strokeStyle = 'rgba(2, 6, 12, .9)'; g.lineWidth = 3.5; g.strokeText(l.t, tx, y);
        g.fillStyle = '#e6f3ff'; g.fillText(l.t, tx, y);
      }
    }
    g.restore();
  }

  // ---------------------------------------------------------------- measuring
  const M = { rgb: [], ts: [], chest: [], chestT: [], prof: null, blinks: [], closed: [], yawn: 0, yawns: [], wasShut: false, base: null, baseN: [], bad: 0,
    posture: '', told: 0, started: 0, watch: false, last: {} };
  function measure(now) {
    const t = now / 1000, f = faceRes && faceRes.faceLandmarks && faceRes.faceLandmarks[0];
    if (!f) { if (t - (M.lostAt || t) > 2) resetSignal(); M.lostAt = M.lostAt || t; return; }
    M.lostAt = 0;
    sg.drawImage(video, 0, 0, 160, 120);
    const img = sg.getImageData(0, 0, 160, 120).data;
    const fwN = Math.hypot((f[454].x - f[234].x) * 4 / 3, f[454].y - f[234].y), fhN = Math.hypot((f[152].x - f[10].x) * 4 / 3, f[152].y - f[10].y);
    // pulse: skin colour on the forehead and both cheeks
    const avg = (cx, cy, w, h) => { let r = 0, gg = 0, b = 0, n = 0;
      for (let y = Math.max(0, Math.round((cy - h / 2) * 120)); y < Math.min(120, Math.round((cy + h / 2) * 120)); y++)
        for (let x = Math.max(0, Math.round((cx - w / 2) * 160)); x < Math.min(160, Math.round((cx + w / 2) * 160)); x++) { const i = (y * 160 + x) * 4; r += img[i]; gg += img[i + 1]; b += img[i + 2]; n++; }
      return n ? [r / n, gg / n, b / n, n] : null; };
    const rois = [avg(f[151].x, f[151].y, fwN * 0.3, fhN * 0.1), avg(f[50].x, f[50].y, fwN * 0.12, fhN * 0.08), avg(f[280].x, f[280].y, fwN * 0.12, fhN * 0.08)].filter(Boolean);
    const n = rois.reduce((s, r) => s + r[3], 0);
    if (n > 6) { M.rgb.push([0, 1, 2].map(c => rois.reduce((s, r) => s + r[c] * r[3], 0) / n)); M.ts.push(t); }
    // breathing: the chest below the chin, as a brightness profile that slides up and down
    const cx = f[152].x, cy0 = f[152].y + fhN * 0.35, cy1 = Math.min(0.98, f[152].y + fhN * 1.3);
    if (cy1 - cy0 > 0.12) {
      const x0 = Math.max(0, Math.round((cx - fwN * 0.6) * 160)), x1 = Math.min(160, Math.round((cx + fwN * 0.6) * 160)), y0 = Math.round(cy0 * 120), y1 = Math.round(cy1 * 120), prof = [];
      for (let y = y0; y < y1; y++) { let s = 0; for (let x = x0; x < x1; x++) { const i = (y * 160 + x) * 4; s += img[i] + img[i + 1] + img[i + 2]; } prof.push(s / Math.max(1, x1 - x0)); }
      if (M.prof && M.prof.length === prof.length) {
        let best = 0, bestE = Infinity;
        for (let d = -3; d <= 3; d++) { let e = 0, c = 0; for (let i = 4; i < prof.length - 4; i++) { const q = M.prof[i + d]; if (q !== undefined) { e += (prof[i] - q) ** 2; c++; } } e /= c || 1; if (e < bestE) { bestE = e; best = d; } }
        M.chest.push((M.chest.length ? M.chest[M.chest.length - 1] : 0) + best); M.chestT.push(t);
      }
      M.prof = prof;
    }
    // blinks, eye closure and yawns
    const bs = {}; ((faceRes.faceBlendshapes && faceRes.faceBlendshapes[0] && faceRes.faceBlendshapes[0].categories) || []).forEach(c => { bs[c.categoryName] = c.score; });
    const shut = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
    if (shut > 0.55 && !M.wasShut) M.blinks.push(t);
    M.wasShut = shut > 0.45 ? M.wasShut || shut > 0.55 : false;
    M.closed.push([t, shut > 0.7 ? 1 : 0]);
    if ((bs.jawOpen || 0) > 0.6) { M.yawn = M.yawn || t; if (t - M.yawn > 1.5 && !M.yawnCounted) { M.yawns.push(t); M.yawnCounted = true; } } else { M.yawn = 0; M.yawnCounted = false; }
    // posture: compared with the first few seconds
    const cyN = (f[10].y + f[152].y) / 2;
    if (!M.base) { M.baseN.push([fwN, cyN]); if (t - (M.baseT = M.baseT || t) > 3) M.base = { w: mean(M.baseN.map(b => b[0])), y: mean(M.baseN.map(b => b[1])) }; }
    else {
      const bad = fwN > M.base.w * 1.2 ? 'leaning in' : cyN > M.base.y + 0.08 ? 'slouching' : '';
      M.bad = bad ? M.bad + 1 / 30 : Math.max(0, M.bad - 1 / 15); M.posture = M.bad > 20 ? bad || M.posture : (M.bad > 0 ? M.posture : 'good');
      if (M.watch && M.bad > 30 && t - M.told > 600) { M.told = t; say(`Posture check: you're ${bad || 'slouching'}. Sit back and straighten up.`); }
    }
    // trim to the last two minutes, then update the readings once a second
    const cut = t - 120;
    while (M.ts.length && M.ts[0] < t - 24) { M.ts.shift(); M.rgb.shift(); }
    while (M.chestT.length && M.chestT[0] < t - 40) { M.chestT.shift(); M.chest.shift(); }
    while (M.closed.length && M.closed[0][0] < t - 60) M.closed.shift();
    M.blinks = M.blinks.filter(b => b > cut); M.yawns = M.yawns.filter(y => y > t - 600);
    if (t - (M.updated || 0) >= 1) { M.updated = t; readings(t); }
  }
  function resetSignal() { M.rgb = []; M.ts = []; M.chest = []; M.chestT = []; M.prof = null; }
  const hist = [];
  function readings(t) {
    const out = {}, span0 = M.ts.length > 1 ? M.ts[M.ts.length - 1] - M.ts[0] : 0;
    out.slow = span0 > 8 && M.ts.length / span0 < 8;          // pulse needs about 8+ frames a second
    if (M.ts.length > 30 && M.ts[M.ts.length - 1] - M.ts[0] > 12) {
      const fs = 30, rs = [0, 1, 2].map(c => resample(M.ts, M.rgb.map(v => v[c]), fs)), rgb = rs[0].map((_, i) => [rs[0][i], rs[1][i], rs[2][i]]);
      const p = posPulse(rgb, fs);
      if (p.snr > 0.3 && p.bpm >= 42 && p.bpm <= 180) { hist.push(p.bpm); if (hist.length > 7) hist.shift(); }
      out.pulse = hist.length >= 3 ? [...hist].sort((a, b) => a - b)[hist.length >> 1] : 0;
    }
    if (M.chestT.length > 60 && M.chestT[M.chestT.length - 1] - M.chestT[0] > 22) {
      const b = breathRate(resample(M.chestT, M.chest, 10), 10); out.breath = b.snr > 0.25 && b.rpm >= 6 && b.rpm <= 40 ? b.rpm : 0;
    }
    const span = Math.min(60, t - (M.started || t)) || 1;
    out.blinks = span > 20 ? Math.round(M.blinks.filter(b => b > t - 60).length * 60 / span) : null;
    out.perclos = M.closed.length ? M.closed.reduce((s, c) => s + c[1], 0) / M.closed.length : 0;
    out.tired = span > 30 ? tiredness(out.blinks, out.perclos, M.yawns.length) : '';
    out.posture = M.base ? M.posture || 'good' : '';
    M.last = out; ui(out); onState(out);
  }
  function ui(o) {
    const set = (k, v) => { const e = root.querySelector(`[data-m=${k}]`); if (e) e.textContent = v; };
    set('pulse', o.pulse ? `${o.pulse} bpm` : o.slow ? 'camera too slow' : 'measuring…'); set('breath', o.breath ? `${o.breath} / min` : (M.chestT.length ? 'measuring…' : 'show your chest'));
    set('blinks', o.blinks != null ? `${o.blinks} / min` : 'measuring…'); set('tired', o.tired || 'measuring…'); set('posture', o.posture || 'measuring…');
  }

  // ---------------------------------------------------------------- public
  async function open(o = {}) {
    Object.assign(opt, o); sync();
    show = true; root.classList.add('on'); window.__jvFaceOff = true;
    if (!M.started) M.started = performance.now() / 1000;
    try { await start(); return true; } catch (e) { console.warn('[XRAY]', e); close(); say("I couldn't open the camera."); return false; }
  }
  function close() {
    show = false; root.classList.remove('on'); window.__jvFaceOff = false; g.clearRect(0, 0, cv.width, cv.height); if (R3) R3.clear();
    if (!M.watch) { stopCam(); Object.assign(M, { started: 0, base: null, baseN: [], baseT: 0, bad: 0 }); hist.length = 0; resetSignal(); }
  }
  /** Measure without the mirror (posture watch keeps the camera on quietly). */
  async function watch(onOff) {
    M.watch = onOff;
    if (onOff) { M.started = M.started || performance.now() / 1000; try { await start(); } catch (e) { M.watch = false; return false; } }
    else if (!show) close();
    return true;
  }
  const set = o => { Object.assign(opt, o); sync(); };
  return { open, close, watch, set, get on() { return show; }, get readings() { return M.last; },
    get debug() { return { samples: M.ts.length, span: M.ts.length ? M.ts[M.ts.length - 1] - M.ts[0] : 0, chest: M.chestT.length, base: !!M.base, est: [...hist] }; } };
}
