// xray.js - the X-ray mirror (after the "X-Ray Mirror" demo): the camera as a mirror with a labelled skull, brain, muscles, eyes and
// hand bones drawn onto you in real time from MediaPipe's face and hand tracking. The anatomy is a model fitted to your face, not
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
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_B = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
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
  #pc-xray video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); filter: saturate(.8) brightness(.9); }
  #pc-xray canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
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
  root.innerHTML = `<video playsinline muted></video><canvas></canvas><button class="close" type="button">← Back to Jarvis</button>
    <div class="panel" role="region" aria-label="X-ray mirror controls">
      <section><h3>Layers</h3><div class="chips" data-g="layers">
        <button data-k="skull" class="on">Skull</button><button data-k="brain" class="on">Brain</button><button data-k="muscles">Muscles</button>
        <button data-k="eyes" class="on">Eyes</button><button data-k="hands" class="on">Hand bones</button><button data-k="labels" class="on">Labels</button></div></section>
      <section><h3>Show</h3><select data-k="cut" aria-label="Which part of the head"><option value="all">Whole head</option><option value="left">Left half</option>
        <option value="right">Right half</option><option value="top">Top of the head</option><option value="lower">Lower face</option></select>
        <div class="row"><span>See-through</span><span data-v="see">60%</span></div><input type="range" min="0" max="100" value="60" data-k="see" aria-label="See-through">
        <div class="row"><span>Brightness</span><span data-v="bright">100%</span></div><input type="range" min="30" max="160" value="100" data-k="bright" aria-label="Brightness"></section>
      <section><h3>Measured from the camera</h3><div class="vit">
        <div><span>Pulse</span><b data-m="pulse">–</b></div><div><span>Breathing</span><b data-m="breath">–</b></div>
        <div><span>Blinks</span><b data-m="blinks">–</b></div><div><span>Alertness</span><b data-m="tired">–</b></div><div><span>Posture</span><b data-m="posture">–</b></div></div>
        <div class="note">Sit still in good light for 20 seconds. Rough readings for habits and curiosity, not a medical device.</div></section>
      <section><h3>Your own scan</h3><div class="row"><button type="button" data-k="load">Load an X-ray / MRI</button><button type="button" data-k="pin" hidden>On head</button></div>
        <input type="file" accept="image/*" hidden><div class="row" data-k="scanrow" hidden><span>Opacity</span><input type="range" min="10" max="100" value="70" data-k="scanop" aria-label="Scan opacity"></div>
        <div class="note">Or drop the picture on the mirror. It stays on this computer.</div></section>
    </div><div class="drop">Drop your scan to pin it on you</div>`;
  document.body.appendChild(root);
  const video = root.querySelector('video'), cv = root.querySelector('canvas'), g = cv.getContext('2d');
  const small = document.createElement('canvas'); small.width = 160; small.height = 120; const sg = small.getContext('2d', { willReadFrequently: true });
  const opt = { skull: true, brain: true, muscles: false, eyes: true, hands: true, labels: true, cut: 'all', see: 0.6, bright: 1 };
  let on = false, show = false, stream = null, face = null, hand = null, raf = 0, lastT = 0, tick = 0, faceRes = null, handRes = null;
  let scan = null, scanOn = 'head', scanOp = 0.7, gyri = null;

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
  const dprNow = () => Math.min(2, devicePixelRatio || 1);
  const S = p => ({ x: ox + (1 - p.x) * vw * sc, y: oy + p.y * vh * sc });
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function draw() {
    fit(); const W = innerWidth, H = innerHeight;
    g.clearRect(0, 0, W, H);
    const f = faceRes && faceRes.faceLandmarks && faceRes.faceLandmarks[0];
    const groups = [];
    if (f) { const labels = []; const clip = drawHead(f, labels); groups.push({ c: S(f[1]), labels: clip ? labels.filter(([, q]) => g.isPointInPath(clip, q.x * dprNow(), q.y * dprNow())) : labels }); }
    const hs = (opt.hands && handRes && handRes.landmarks) || [];
    hs.forEach(h => { const labels = []; drawHand(h, labels); groups.push({ c: S(h[9]), labels }); });
    if (scan) drawScan(f, hs[0]);
    if (opt.labels) groups.forEach(gr => drawLabels(gr.labels, gr.c));
  }

  // glowing X-ray strokes: a wide faint line under a thin bright one (cheaper than shadowBlur)
  const BONE = a => `rgba(225, 240, 255, ${a})`, BRAIN = a => `rgba(255, 140, 200, ${a})`, MUSC = a => `rgba(255, 90, 80, ${a})`, EYE = a => `rgba(140, 220, 255, ${a})`;
  function glow(path, col, w) {
    const k = opt.bright;
    g.lineCap = g.lineJoin = 'round';
    g.strokeStyle = col(0.18 * k); g.lineWidth = w * 3.2; g.stroke(path);
    g.strokeStyle = col(0.85 * Math.min(1, k)); g.lineWidth = w; g.stroke(path);
  }
  const P = () => new Path2D();

  function drawHead(lm, labels) {
    const pt = i => S(lm[i]), top = pt(10), chin = pt(152), lft = pt(234), rgt = pt(454);
    const C = lerp(top, chin, 0.5), fh = dist(top, chin), fw = dist(lft, rgt);
    const R = { x: (rgt.x - lft.x) / fw, y: (rgt.y - lft.y) / fw }, U = { x: -R.y, y: R.x }; // R: towards 454; U: up the face
    if (U.x * (top.x - chin.x) + U.y * (top.y - chin.y) < 0) { U.x = -U.x; U.y = -U.y; }
    const L = (a, b) => ({ x: C.x + R.x * a * fw + U.x * b * fh, y: C.y + R.y * a * fw + U.y * b * fh });
    const roll = Math.atan2(R.y, R.x);
    let clip = null;
    g.save();
    // which part shows: a half-plane in the face's own frame
    if (opt.cut !== 'all') {
      const sgn = R.x >= 0 ? 1 : -1, poly = { left: [[-9 * sgn, -9], [0, -9], [0, 9], [-9 * sgn, 9]], right: [[0, -9], [9 * sgn, -9], [9 * sgn, 9], [0, 9]],
        top: [[-9, 0.05], [9, 0.05], [9, 9], [-9, 9]], lower: [[-9, -9], [9, -9], [9, 0.05], [-9, 0.05]] }[opt.cut];
      const cp = P(); poly.forEach(([a, b], i) => { const q = L(a, b); i ? cp.lineTo(q.x, q.y) : cp.moveTo(q.x, q.y); }); cp.closePath(); g.clip(cp); clip = cp;
    }
    // the skin turns to film: a dark blue wash over the head, as strong as "see-through" says
    const head = P(); OVAL.forEach((i, k) => { const q = pt(i); k ? head.lineTo(q.x, q.y) : head.moveTo(q.x, q.y); }); head.closePath();
    const cr = L(0, 0.3);
    head.ellipse(cr.x, cr.y, 0.56 * fw, 0.66 * fh, roll, Math.PI, 2 * Math.PI);
    g.fillStyle = `rgba(4, 18, 36, ${0.25 + 0.6 * opt.see})`; g.fill(head);
    g.globalCompositeOperation = 'lighter';

    if (opt.brain) {
      const bc = L(0, 0.36), rx = 0.47 * fw, ry = 0.5 * fh;
      const gr = g.createRadialGradient(bc.x, bc.y, 0, bc.x, bc.y, Math.max(rx, ry));
      gr.addColorStop(0, BRAIN(0.28 * opt.bright)); gr.addColorStop(1, BRAIN(0.04));
      const shape = P(); shape.ellipse(bc.x, bc.y, rx, ry, roll, Math.PI * 1.04, Math.PI * 1.96); shape.lineTo(L(0.4, 0.12).x, L(0.4, 0.12).y);
      shape.quadraticCurveTo(L(0, 0.02).x, L(0, 0.02).y, L(-0.4, 0.12).x, L(-0.4, 0.12).y); shape.closePath();
      g.fillStyle = gr; g.fill(shape);
      g.save(); g.clip(shape);
      gyri = gyri || makeGyri();
      const gp = P();
      for (const curve of gyri) curve.forEach(([a, b], i) => { const q = L(a * 0.47, 0.36 + b * 0.5); i ? gp.lineTo(q.x, q.y) : gp.moveTo(q.x, q.y); });
      glow(gp, BRAIN, 1.2); g.restore();
      const fis = P(), f0 = L(0, 0.85), f1 = L(0, 0.2); fis.moveTo(f0.x, f0.y); fis.lineTo(f1.x, f1.y); glow(fis, BRAIN, 1.4);
      labels.push(['Frontal lobe', L(0.12, 0.62)], ['Temporal lobe', L(-0.42, 0.2)], ['Longitudinal fissure', L(0, 0.78)]);
    }
    if (opt.muscles) {
      const m = P();
      for (const s of [-1, 1]) {
        for (let k = 0; k < 7; k++) { const a = L(s * 0.42, 0.02), b = L(s * (0.5 - k * 0.03), 0.24 + k * 0.07); m.moveTo(a.x, a.y); m.lineTo(b.x, b.y); }   // temporalis
        const jaw = pt(s * R.x > 0 ? 397 : 172);
        for (let k = 0; k < 6; k++) { const a = L(s * (0.3 + k * 0.025), -0.02), b = lerp(jaw, L(s * 0.3, -0.38), k / 8); m.moveTo(a.x, a.y); m.lineTo(b.x, b.y); }   // masseter
      }
      for (let k = -4; k <= 4; k++) { const a = L(k * 0.07, 0.2), b = L(k * 0.075, 0.5); m.moveTo(a.x, a.y); m.lineTo(b.x, b.y); }     // frontalis
      const mo = lerp(pt(13), pt(14), 0.5); m.moveTo(mo.x + dist(pt(61), pt(291)) * 0.62, mo.y);
      m.ellipse(mo.x, mo.y, dist(pt(61), pt(291)) * 0.62, Math.max(fh * 0.07, dist(pt(0), pt(17)) * 0.75), roll, 0, 2 * Math.PI);      // orbicularis oris
      glow(m, MUSC, 1.3);
      labels.push(['Temporalis', L(-0.47, 0.32)], ['Masseter', L(0.36, -0.18)], ['Frontalis', L(-0.15, 0.42)], ['Orbicularis oris', L(0.15, -0.3)]);
    }
    if (opt.skull) {
      const k = P();
      k.ellipse(cr.x, cr.y, 0.56 * fw, 0.66 * fh, roll, Math.PI * 0.97, Math.PI * 2.03);                                   // cranium
      const jawPts = [454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234].map(i => lerp(C, pt(i), 0.93));
      jawPts.forEach((q, i) => (i ? k.lineTo(q.x, q.y) : k.moveTo(q.x, q.y)));                                               // mandible
      for (const [ring, s] of [[EYE_A, 1], [EYE_B, -1]]) {                                                                    // orbits
        const ps = ring.map(pt), c = { x: mean(ps.map(p => p.x)), y: mean(ps.map(p => p.y)) }, w = Math.max(...ps.map(p => dist(p, c)));
        k.moveTo(c.x + w * 1.55, c.y); k.ellipse(c.x, c.y, w * 1.55, w * 1.2, roll, 0, 2 * Math.PI);
        const side = dist(c, lft) < dist(c, rgt) ? lft : rgt, z0 = lerp(c, side, 0.45), z1 = lerp(side, pt(side === lft ? 127 : 356), 0.3);
        k.moveTo(z0.x, z0.y + w * 0.9); k.quadraticCurveTo(lerp(z0, z1, 0.5).x, lerp(z0, z1, 0.5).y + w * 1.2, z1.x, z1.y + w * 0.6);       // zygomatic arch
      }
      const n0 = lerp(pt(168), pt(1), 0.45), n1 = lerp(pt(2), pt(1), 0.25), nw = dist(pt(98), pt(327)) * 0.45;           // nasal aperture
      k.moveTo(n0.x, n0.y); k.bezierCurveTo(n0.x + R.x * nw * 1.4, n0.y + R.y * nw * 1.4, n1.x + R.x * nw * 1.3, n1.y + R.y * nw * 1.3, n1.x, n1.y);
      k.bezierCurveTo(n1.x - R.x * nw * 1.3, n1.y - R.y * nw * 1.3, n0.x - R.x * nw * 1.4, n0.y - R.y * nw * 1.4, n0.x, n0.y);
      // teeth: two rows following the lips; they part when the mouth opens
      const mL = pt(61), mR = pt(291), up = pt(13), lo = pt(14), th = fh * 0.05, gap = Math.max(0, dist(up, lo) - fh * 0.01);
      for (let t = 0; t < 14; t++) {
        const u = (t + 0.5) / 14, bow = Math.sin(Math.PI * u) * fh * 0.03, base = lerp(mL, mR, u), wv = dist(mL, mR) / 14 * 0.8 * (0.7 + 0.3 * Math.sin(Math.PI * u));
        const row = (dy, dir) => { const y0 = { x: base.x - U.x * (dy - bow), y: base.y - U.y * (dy - bow) }; const y1 = { x: y0.x - U.x * th * dir, y: y0.y - U.y * th * dir };
          k.moveTo(y0.x - R.x * wv / 2, y0.y - R.y * wv / 2); k.lineTo(y1.x - R.x * wv / 2, y1.y - R.y * wv / 2); k.lineTo(y1.x + R.x * wv / 2, y1.y + R.y * wv / 2); k.lineTo(y0.x + R.x * wv / 2, y0.y + R.y * wv / 2); };
        row(-fh * 0.004, -1); row(gap + fh * 0.004, 1);
      }
      for (let v = 0; v < 4; v++) { const c = L(0, -0.62 - v * 0.11); k.moveTo(c.x + fw * 0.09, c.y); k.ellipse(c.x, c.y, fw * 0.09, fh * 0.04, roll, 0, 2 * Math.PI); }   // cervical spine
      glow(k, BONE, 1.6);
      labels.push(['Frontal bone', L(0, 0.9)], ['Parietal bone', L(0.45, 0.62)], ['Orbit', L(0.2, 0.13)], ['Nasal cavity', L(0, -0.02)], ['Zygomatic arch', L(0.42, 0.04)],
        ['Maxilla', L(-0.17, -0.12)], ['Teeth', L(0.1, -0.2)], ['Mandible', L(-0.25, -0.38)], ['Cervical spine', L(0, -0.75)]);
    }
    if (opt.eyes) {
      const e = P();
      for (const [iris, ring] of [[468, EYE_A], [473, EYE_B]]) {
        const ps = ring.map(pt), c = lm[iris] ? pt(iris) : { x: mean(ps.map(p => p.x)), y: mean(ps.map(p => p.y)) }, r = fw * 0.075;
        e.moveTo(c.x + r, c.y); e.arc(c.x, c.y, r, 0, 2 * Math.PI); e.moveTo(c.x + r * 0.42, c.y); e.arc(c.x, c.y, r * 0.42, 0, 2 * Math.PI);
        const back = L(0, 0.22); e.moveTo(c.x, c.y); e.quadraticCurveTo(lerp(c, back, 0.5).x, lerp(c, back, 0.5).y - fh * 0.03, back.x, back.y);   // optic nerve
      }
      glow(e, EYE, 1.2);
      labels.push(['Eye', L(-0.2, 0.13)], ['Optic nerve', L(0.05, 0.2)]);
    }
    g.restore();
    return clip;              // the labels of the hidden part are dropped too
  }

  function drawHand(lm, labels) {
    const p = lm.map(S), palm = dist(p[0], p[9]) || 1, b = P();
    const bone = (a, c, w) => { b.moveTo(a.x, a.y); b.lineTo(c.x, c.y); joints.push([c, w * 0.62]); widths.push([a, c, w]); };
    const joints = [], widths = [];
    const base = i => lerp(p[0], p[i], 0.22);
    for (const [k, f] of FINGERS.entries()) {
      const m0 = k === 0 ? lerp(p[0], p[1], 0.35) : base(f[0]);
      bone(m0, p[f[0]], palm * (k === 0 ? 0.11 : 0.085));                                         // metacarpals (the thumb's starts at the wrist)
      bone(p[f[0]], p[f[1]], palm * 0.08); bone(p[f[1]], p[f[2]], palm * 0.065); bone(p[f[2]], p[f[3]], palm * 0.055);   // phalanges
    }
    const away = { x: (p[0].x - p[9].x) / palm, y: (p[0].y - p[9].y) / palm }, side = { x: -away.y, y: away.x };
    for (const s of [-1, 1]) {                                                                        // radius and ulna
      const a = { x: p[0].x + side.x * s * palm * 0.17, y: p[0].y + side.y * s * palm * 0.17 };
      widths.push([a, { x: a.x + away.x * palm * 1.5, y: a.y + away.y * palm * 1.5 }, palm * (s > 0 ? 0.13 : 0.11)]);
    }
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {                                          // carpals: two rows of four
      const q = lerp(p[0], lerp(p[1], p[17], c / 3), 0.12 + r * 0.14);
      b.moveTo(q.x + palm * 0.06, q.y); b.ellipse(q.x, q.y, palm * 0.06, palm * 0.045, 0, 0, 2 * Math.PI);
    }
    g.save(); g.globalCompositeOperation = 'lighter';
    for (const [a, c, w] of widths) { const q = P(); q.moveTo(a.x, a.y); q.lineTo(c.x, c.y); glow(q, BONE, Math.max(1.5, w * 0.55)); }
    for (const [c, r] of joints) { const q = P(); q.arc(c.x, c.y, Math.max(1.5, r * 0.6), 0, 2 * Math.PI); glow(q, BONE, 1); }
    glow(b, BONE, 1.2); g.restore();
    labels.push(['Phalanges', p[12]], ['Metacarpals', lerp(p[0], p[9], 0.55)], ['Carpals', lerp(p[0], p[9], 0.15)],
      ['Radius', { x: p[0].x + away.x * palm * 1.1 + side.x * palm * 0.17, y: p[0].y + away.y * palm * 1.1 + side.y * palm * 0.17 }],
      ['Ulna', { x: p[0].x + away.x * palm * 1.1 - side.x * palm * 0.17, y: p[0].y + away.y * palm * 1.1 - side.y * palm * 0.17 }]);
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
  function drawLabels(labels, centre) {
    if (!labels.length) return;
    const cx = centre.x, sides = { l: [], r: [] };
    labels.forEach(([t, p]) => sides[p.x < cx ? 'l' : 'r'].push({ t, p }));
    g.save(); g.font = "500 12px 'Saira', system-ui, sans-serif"; g.textBaseline = 'middle';
    for (const [k, list] of Object.entries(sides)) {
      list.sort((a, b) => a.p.y - b.p.y);
      const xs = list.map(l => l.p.x), edge = k === 'l' ? Math.min(...xs) - 40 : Math.max(...xs) + 40;
      let y = -Infinity;
      for (const l of list) {
        y = Math.max(l.p.y, y + 18); const tw = g.measureText(l.t).width, tx = k === 'l' ? Math.max(8, edge - tw) : Math.min(panelLeft() - tw - 12, edge);
        g.strokeStyle = 'rgba(170, 215, 255, .55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(l.p.x, l.p.y); g.lineTo(k === 'l' ? tx + tw + 4 : tx - 4, y); g.stroke();
        g.fillStyle = 'rgba(170, 215, 255, .9)'; g.beginPath(); g.arc(l.p.x, l.p.y, 2, 0, 2 * Math.PI); g.fill();
        g.fillStyle = '#e6f3ff'; g.fillText(l.t, tx, y);
      }
    }
    g.restore();
  }

  function makeGyri() {          // folds of the brain: wavy lines in a unit disc, fixed so they don't flicker
    let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, out = [];
    for (let k = 0; k < 34; k++) {
      let x = rnd() * 2 - 1, y = rnd() * 2 - 1, a = rnd() * 6.28; const c = [];
      for (let i = 0; i < 14; i++) { c.push([x, y]); a += (rnd() - 0.5) * 2.2; x += Math.cos(a) * 0.09; y += Math.sin(a) * 0.09; }
      out.push(c);
    }
    return out;
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
    show = false; root.classList.remove('on'); window.__jvFaceOff = false; g.clearRect(0, 0, cv.width, cv.height);
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
