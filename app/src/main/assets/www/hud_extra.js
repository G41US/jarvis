// PC HUD extras (loaded by index.html): the live globe, the plan / recap / globe cards, system gauges and hand-gesture control.
// The server drives them over /ws with "globe:", "plan:", "recap:" and "gesture:" messages (features.py).
import * as THREE from 'three';

const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hud = $('hud');
const GURL = window.__jvGlobeUrl || (p => p);      // the phone app fetches the globe's pictures straight from NASA instead of a server

// ============================================================
// YOUTUBE PLAYERS (music and live news) through YouTube's own player API, so Jarvis can pause them, skip, and turn them down while
// he talks. Loaded the first time it's needed.
// ============================================================
let ytReady = null;
const loadYT = () => ytReady || (ytReady = new Promise(res => {
  if (window.YT && window.YT.Player) return res(window.YT);
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(window.YT); };
  document.head.appendChild(Object.assign(el('script'), { src: 'https://www.youtube.com/iframe_api', async: true }));
}));
let ducked = false;
const duckers = new Set();        // players that go quiet while he listens and talks: (on) => ...
window.__jvOnState = s => {
  const on = ['listening', 'thinking', 'speaking', 'session'].includes(s);
  if (on !== ducked) { ducked = on; duckers.forEach(f => f(on)); }
};


document.head.appendChild(el('style', null, `
  #pc-globe { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 2; touch-action: none; opacity: 0; pointer-events: none; transition: opacity .9s var(--ease); }
  #pc-globe.on { opacity: 1; pointer-events: auto; cursor: grab; }
  #pc-globe.on:active { cursor: grabbing; }
  #three { transition: opacity .9s var(--ease); }
  body.pc-globe-on #three { opacity: 0 !important; }
  #pc-holo { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
  #pc-holo.live { pointer-events: auto; }
  #pc-gtoast { position: fixed; left: 0; top: 0; z-index: 21; pointer-events: none; opacity: 0; transition: opacity .25s;
    font: 600 12px/1 'Saira', system-ui, sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #1a1006;
    background: rgba(245,201,122,.92); padding: 6px 10px; border-radius: 999px; box-shadow: 0 0 18px rgba(245,201,122,.6); }
  #pc-gtoast.on { opacity: 1; }
  body.pc-holo-on #three { opacity: 0 !important; }
  #hud::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .9s var(--ease);
    background: linear-gradient(180deg, rgba(0, 0, 0, .62) 0, rgba(0, 0, 0, 0) 190px), linear-gradient(0deg, rgba(0, 0, 0, .6) 0, rgba(0, 0, 0, 0) 170px); }
  body.pc-globe-on #hud::before { opacity: 1; }
  .pc-glabel { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); pointer-events: none; white-space: nowrap;
    font: 500 12px/1 'Saira', system-ui, sans-serif; color: var(--ice); padding: 4px 8px; border-radius: 999px; background: rgba(20, 14, 8, .72);
    border: 1px solid var(--glass-hi); transition: opacity .25s; }
  .pc-gname { position: absolute; left: 0; top: 0; pointer-events: none; white-space: nowrap; opacity: 0; transition: opacity .35s;
    font: 600 11.5px/1 'Saira', system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #fff4dc;
    text-shadow: 0 0 6px #000, 0 0 12px rgba(0, 0, 0, .9), 0 1px 2px #000; }
  .pc-gname.st { font-weight: 500; font-size: 10.5px; letter-spacing: .08em; text-transform: none; color: rgba(255, 236, 200, .82); }
  .pc-glabel.big { font-size: 13px; color: var(--live); border-color: color-mix(in srgb, var(--holo) 55%, transparent); }
  .pc-glabel.pc-gkm { font-size: 15px; font-weight: 600; padding: 6px 12px; letter-spacing: .04em; }
  .pc-glabel.pc-gkm i { font-style: normal; font-weight: 400; font-size: 12px; opacity: .7; margin-left: 6px; }

  #pc-card { position: absolute; left: 48px; top: 150px; width: min(380px, 28vw); max-height: calc(100vh - 250px); overflow: hidden; padding: 20px 22px 22px;
    border-radius: 22px; background: linear-gradient(180deg, rgba(50, 32, 16, .66), rgba(24, 16, 8, .74)); border: 1px solid var(--glass-hi);
    -webkit-backdrop-filter: blur(20px) saturate(140%); backdrop-filter: blur(20px) saturate(140%); box-shadow: 0 24px 60px rgba(0, 0, 0, .45);
    opacity: 0; transform: translateX(-12px); pointer-events: none; transition: opacity .5s var(--ease), transform .6s var(--ease); }
  #pc-card.on { opacity: 1; transform: translate(var(--dx, 0px), var(--dy, 0px)); pointer-events: auto; }
  #pc-card.drag { transition: opacity .5s var(--ease); box-shadow: 0 30px 80px rgba(0, 0, 0, .6), 0 0 0 1px color-mix(in srgb, var(--holo) 50%, transparent); }
  #pc-card header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  #pc-card h2 { margin: 0; font: 600 19px/1.2 'Saira', system-ui, sans-serif; color: var(--ice); }
  #pc-card header span { font: 400 13px/1.2 'Saira', system-ui, sans-serif; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #pc-card .rows { display: grid; gap: 2px; }
  #pc-card .row { display: grid; grid-template-columns: 74px 1fr; gap: 12px; align-items: baseline; padding: 8px 10px; margin: 0 -10px; border-radius: 12px; }
  #pc-card .row b { font: 500 14px/1.3 'Saira', system-ui, sans-serif; color: var(--holo); font-variant-numeric: tabular-nums; }
  #pc-card .row div { min-width: 0; font: 400 15px/1.35 'Saira', system-ui, sans-serif; color: var(--ice); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pc-card .row small { display: block; font-size: 12.5px; color: var(--dim); }
  #pc-card .row.past { opacity: .45; }
  #pc-card .row.suggest { border: 1px dashed color-mix(in srgb, var(--holo) 45%, transparent); background: rgba(245, 201, 122, .05); margin: 3px -10px; }
  #pc-card .row.suggest div::after { content: 'suggested'; margin-left: 8px; font-size: 11px; letter-spacing: .04em; color: var(--holo); text-transform: uppercase; }
  #pc-card h3 { margin: 16px 0 6px; font: 600 12px/1 'Saira', system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  #pc-card h3.warn { color: var(--amber); }
  #pc-card ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  #pc-card li { font: 400 14.5px/1.35 'Saira', system-ui, sans-serif; color: var(--mist); display: flex; justify-content: space-between; gap: 10px; }
  #pc-card li span { color: var(--dim); white-space: nowrap; font-size: 12.5px; }
  #pc-card .empty { font: 400 15px/1.4 'Saira', system-ui, sans-serif; color: var(--mist); }
  #pc-card .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  #pc-card .tile { padding: 10px 13px; border-radius: 14px; background: rgba(255, 214, 150, .05); border: 1px solid rgba(255, 214, 150, .09); min-width: 0;
    opacity: 0; transform: translateY(6px); animation: pcTile .55s var(--ease) forwards; }
  @keyframes pcTile { to { opacity: 1; transform: none; } }
  #pc-card .tile i { display: block; font: normal 500 11.5px/1 'Saira', system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  #pc-card .tile b { display: block; margin: 6px 0 3px; font: 300 23px/1 'Saira', system-ui, sans-serif; font-stretch: 104%; color: var(--ice); font-variant-numeric: tabular-nums; }
  #pc-card .tile span { display: block; font: 400 12.5px/1.3 'Saira', system-ui, sans-serif; color: var(--mist); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #pc-card .tile.up span { color: #9fdc9a; } #pc-card .tile.down span { color: #ff9a7a; }
  body.pc-card-on #pc-brief { opacity: 0 !important; }

  #pc-gauges { position: absolute; left: 48px; bottom: 40px; display: flex; gap: 14px; pointer-events: none; transition: opacity 2.5s var(--ease); }
  body.pc-idle #pc-gauges { opacity: .45; }
  .pc-gauge { position: relative; width: 50px; height: 50px; }
  .pc-gauge svg { width: 50px; height: 50px; transform: rotate(-90deg); }
  .pc-gauge circle { fill: none; stroke-width: 3; }
  .pc-gauge .bg { stroke: rgba(255, 214, 150, .12); }
  .pc-gauge .fg { stroke: var(--holo); stroke-linecap: round; transition: stroke-dashoffset .8s var(--ease), stroke .4s; }
  .pc-gauge.hot .fg { stroke: var(--amber); }
  .pc-gauge b { position: absolute; inset: 0; display: grid; place-items: center; font: 500 13px/1 'Saira', system-ui, sans-serif; color: var(--ice); font-variant-numeric: tabular-nums; }
  .pc-gauge i { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 4px); font: normal 600 10px/1 'Saira', system-ui, sans-serif; letter-spacing: .1em; color: var(--dim); }

  #pc-cam { position: absolute; right: 32px; bottom: 30px; width: 208px; height: 156px; border-radius: 18px; overflow: hidden; border: 1px solid var(--glass-hi);
    background: #000; box-shadow: 0 18px 50px rgba(0, 0, 0, .5); opacity: 0; transform: translateY(10px); transition: opacity .4s, transform .5s var(--ease); pointer-events: none; }
  #pc-cam.on { opacity: 1; transform: none; }
  #pc-cam video, #pc-cam canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
  #pc-cam video { opacity: .55; filter: sepia(.5) saturate(.8); }
  #pc-cam span { position: absolute; left: 10px; top: 9px; font: 600 11px/1 'Saira', system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--live);
    text-shadow: 0 1px 6px #000; }
  /* the pointer: a small gold ring with a dot; brighter over a panel, shrinks and fills while pinching */
  #pc-ring { position: fixed; left: 0; top: 0; z-index: 20; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; pointer-events: none;
    border: 1.5px solid rgba(245,201,122,.75); box-shadow: 0 0 12px rgba(245,201,122,.35);
    opacity: 0; transition: opacity .25s, width .14s, height .14s, margin .14s, background .14s, border-color .2s, box-shadow .2s; }
  #pc-ring i { position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%; background: #fff1d2; box-shadow: 0 0 8px #f5c97a; }
  #pc-ring.on { opacity: 1; }
  #pc-ring.over { border-color: #ffe7b8; box-shadow: 0 0 20px rgba(255,214,140,.7); }
  #pc-ring.pinch { width: 18px; height: 18px; margin: -9px 0 0 -9px; background: rgba(245,201,122,.55); border-color: #fff1d2; }
  #pc-cam.hint span { right: 10px; top: auto; bottom: 9px; line-height: 1.5; letter-spacing: .04em; text-transform: none; font-size: 11.5px;
    background: rgba(20,14,8,.72); padding: 6px 8px; border-radius: 8px; }
  @media (max-width: 900px) { #pc-card { display: none; } #pc-cam { width: 150px; height: 112px; } }
`));

// ============================================================
// SIDE CARD: plan, recap, globe info (one at a time, where the briefing goes)
// ============================================================
const card = el('div'); card.id = 'pc-card'; hud.appendChild(card);
let cardTimer = null, cardKind = null;
function showCard(kind, html, holdMs) {
  card.innerHTML = html; card.style.removeProperty('--dx'); card.style.removeProperty('--dy');
  card.classList.add('on'); document.body.classList.add('pc-card-on'); cardKind = kind;
  clearTimeout(cardTimer); if (holdMs) cardTimer = setTimeout(hideCard, holdMs);
  window.__jvWake && window.__jvWake(); window.__jvGlobe && window.__jvGlobe.layout();
}
function hideCard() { card.classList.remove('on'); document.body.classList.remove('pc-card-on'); cardKind = null; clearTimeout(cardTimer); window.__jvGlobe && window.__jvGlobe.layout(); }
card.addEventListener('dblclick', hideCard);
addEventListener('keydown', e => { if (e.key === 'Escape') { if (feeds.on) feeds.close(); else if (cardKind) hideCard(); else if (window.__jvHolo && window.__jvHolo.has()) window.__jvHolo.clear(); else globe.hide(); } });

function planHtml(p) {
  const rows = (p.rows || []).map(r => `<div class="row ${r.kind}${r.past ? ' past' : ''}"><b>${esc(r.t)}</b><div>${esc(r.title)}<small>until ${esc(r.end)}</small></div></div>`).join('');
  let h = `<header><h2>${esc(p.title)}</h2><span>${new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></header>`;
  h += rows ? `<div class="rows">${rows}</div>` : `<div class="empty">Nothing scheduled.</div>`;
  if (p.dodged && p.dodged.length) h += `<h3 class="warn">Dodged</h3><ul>${p.dodged.map(d => `<li>${esc(d.title)}<span>${esc(d.age)}</span></li>`).join('')}</ul>`;
  if (p.tasks && p.tasks.length) h += `<h3>Tasks</h3><ul>${p.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  return h;
}
function recapHtml(r) {
  return `<header><h2>${esc(r.title)}</h2><span>${esc(r.sub)}</span></header><div class="tiles">` +
    (r.tiles || []).map((t, i) => `<div class="tile ${t.tone || ''}" style="animation-delay:${i * 70}ms"><i>${esc(t.label)}</i><b>${esc(t.value)}</b><span>${esc(t.sub)}</span></div>`).join('') + '</div>';
}
function infoHtml(c) {
  return `<header><h2>${esc(c.title)}</h2><span>${esc(c.sub)}</span></header><div class="rows">` +
    (c.rows || []).map(r => `<div class="row"><b>${esc(r.k)}</b><div>${esc(r.v)}<small>${esc(r.s)}</small></div></div>`).join('') + '</div>';
}

// ============================================================
// GLOBE
// ============================================================
const globe = (() => {
  const canvas = el('canvas'); canvas.id = 'pc-globe'; $('three').after(canvas);
  let renderer = null, scene, camera, earth, group, mat, atmo, aur, aurWant = 0, layer = null, line = null, issDot = null, labels = [], running = false;
  let mode = 0, modeWant = 0, rotX = 0.35, rotY = 0, spin = true, satTex = null, issTimer = null;
  const HOME = 5.6, NEAR = 1.04, FAR = 8;                 // camera distance in Earth radii: whole Earth, closest (about 250 km up), farthest
  let dist = HOME, fly = null, px = 0, pxWant = 0, lastDrag = 0;
  const DEG = Math.PI / 180, R = 1;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const vec = (lat, lon, r = R) => new THREE.Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), -Math.cos(lat * DEG) * Math.sin(lon * DEG)).multiplyScalar(r);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
  const shared = { uMode: { value: 0 }, uGold: { value: new THREE.Color(0xf5c97a) }, uTime: { value: 0 }, uScan: { value: 1 }, uGrid: { value: 15 },
    tNight: { value: blank }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uNight: { value: 0 } };
  const VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vObj;
    void main() { vUv = uv; vObj = normalize(position); vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
  // one look for the whole Earth and for the sharp close-up patch: uBox says which lon/lat the texture covers (west, south, east, north)
  // night side: the sun's real direction darkens it and NASA's Black Marble city lights come on (sampled by lon/lat, so the close-up patch gets them too)
  const FS = `uniform sampler2D tBlue; uniform sampler2D tSat; uniform sampler2D tNight; uniform float uMode; uniform vec3 uGold; uniform float uTime; uniform float uScan; uniform float uGrid;
    uniform vec3 uSun; uniform float uNight; uniform vec4 uBox; uniform float uEdge; varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vObj;
    void main() {
      vec3 b = texture2D(tBlue, vUv).rgb, s = texture2D(tSat, vUv).rgb;
      float land = smoothstep(0.0, 0.08, max(b.r, b.g) - b.b + 0.03);
      float lon = mix(uBox.x, uBox.z, vUv.x), lat = mix(uBox.y, uBox.w, vUv.y);
      vec2 gd = abs(fract(vec2(lon, lat) / uGrid + 0.5) - 0.5) * uGrid / fwidth(vec2(lon, lat));
      float grid = 1.0 - smoothstep(0.0, 1.2, min(gd.x, gd.y));
      float rim = pow(1.0 - max(dot(vN, vV), 0.0), 2.6);
      float scan = 0.5 + 0.5 * sin((lat + 90.0) * 5.0 - uTime * 2.0);
      vec3 holo = uGold * (0.07 + land * (0.46 + 0.1 * scan * uScan) + grid * 0.16) + uGold * rim * 0.9;
      float hasSat = smoothstep(0.03, 0.09, max(s.r, max(s.g, s.b)));
      vec3 gap = mix(vec3(0.10, 0.13, 0.19) + b * 0.3, b * 0.9, land);
      vec3 sat = mix(gap, s, hasSat) * (0.35 + 0.75 * max(dot(vN, normalize(vec3(-0.4, 0.3, 1.0))), 0.0)) + vec3(0.35, 0.55, 1.0) * rim * 0.55;
      float sunD = dot(normalize(vObj), uSun), dark = smoothstep(0.06, -0.14, sunD) * uNight;
      float lights = smoothstep(0.22, 0.8, texture2D(tNight, vec2((lon + 180.0) / 360.0, (lat + 90.0) / 180.0)).r) * dark;
      holo = holo * (1.0 - 0.45 * dark) + vec3(1.0, 0.9, 0.62) * lights * 0.95;
      sat = sat * (1.0 - 0.84 * dark) + vec3(1.0, 0.76, 0.42) * lights * 1.25 + vec3(1.0, 0.55, 0.2) * exp(-pow(sunD / 0.03, 2.0)) * 0.05 * uNight;
      vec2 e = min(vUv, 1.0 - vUv); float a = uEdge > 0.0 ? smoothstep(0.0, uEdge, min(e.x, e.y)) : 1.0;
      gl_FragColor = vec4(mix(holo, sat, uMode), a);
    }`;
  const makeMat = (box, edge) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: edge > 0, depthWrite: !(edge > 0),
    uniforms: { ...shared, tBlue: { value: blank }, tSat: { value: blank }, uBox: { value: new THREE.Vector4(...box) }, uEdge: { value: edge } } });

  function init() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, window.__jvLight ? 1 : 2));   // light mode: no extra-sharp pixels (the globe was the busiest thing)
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100); camera.position.set(0, 0, dist);
    group = new THREE.Group(); scene.add(group);
    mat = makeMat([-180, -90, 180, 90], 0);
    earth = new THREE.Mesh(new THREE.SphereGeometry(R, 160, 80), mat); group.add(earth);
    new THREE.TextureLoader().load(GURL('/globe/tex/blue'), t => { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; mat.uniforms.tBlue.value = t; });
    new THREE.TextureLoader().load(GURL('/globe/tex/night'), t => { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; shared.tNight.value = t; shared.uNight.value = 1; });
    // aurora: two moving green curtains round the magnetic poles (80.7N 72.7W and its opposite), only on the night side
    aur = new THREE.Mesh(new THREE.SphereGeometry(R * 1.022, 128, 64), new THREE.ShaderMaterial({
      uniforms: { uSun: shared.uSun, uTime: shared.uTime, uA: { value: 0 }, uP: { value: vec(80.7, -72.7) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vO; varying vec3 vN; varying vec3 vV; void main() { vO = normalize(position); vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uSun; uniform vec3 uP; uniform float uTime; uniform float uA; varying vec3 vO; varying vec3 vN; varying vec3 vV;
        void main() {
          float m = degrees(asin(clamp(dot(vO, uP), -1.0, 1.0)));
          vec3 e1 = normalize(cross(uP, vec3(0.0, 1.0, 0.0))), e2 = cross(uP, e1);
          float ml = atan(dot(vO, e2), dot(vO, e1)), t = uTime;
          float c = 67.0 + 2.2 * sin(ml * 3.0 + t * 0.25) + 1.2 * sin(ml * 7.0 - t * 0.4), d = abs(m) - c;
          float band = exp(-d * d / 10.0) * (0.78 + 0.22 * sin(ml * 9.0 + t * 0.8 + 2.0 * sin(ml * 4.0 - t * 0.5)) * sin(ml * 31.0 - t * 1.1)) + exp(-d * d / 45.0) * 0.25;
          float night = smoothstep(0.2, -0.1, dot(vO, uSun)), limb = 0.75 + 0.9 * pow(1.0 - max(dot(vN, vV), 0.0), 1.5);
          vec3 col = mix(vec3(0.2, 1.0, 0.5), vec3(0.75, 0.35, 1.0), smoothstep(0.0, 3.0, d));
          float a = band * night * limb * uA; if (a < 0.003) discard; gl_FragColor = vec4(col * a, a);
        }`,
    }));
    aur.renderOrder = 4; group.add(aur);
    atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.12, 64, 32), new THREE.ShaderMaterial({
      uniforms: { uC: { value: new THREE.Color(0xf5c97a) } }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vV; void main() { vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uC; varying vec3 vN; varying vec3 vV; void main() { float f = pow(max(0.0, 0.62 + dot(vN, vV)), 3.0); gl_FragColor = vec4(uC, 1.0) * f * 0.9; }`,
    }));
    scene.add(atmo);
    loadBorders(); loadNames();
    resize(); addEventListener('resize', resize);
    let drag = null; const touches = new Map();      // drag to turn, wheel or two-finger pinch to zoom, double-click / double-tap to pin a distance
    let pinch0 = 0, tapAt0 = 0;
    canvas.addEventListener('pointerdown', e => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId);
      if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); drag = null; return; }
      drag = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'touch') { const t = performance.now(); if (t - tapAt0 < 320) tapAt(e.clientX, e.clientY); tapAt0 = t; }
    });
    canvas.addEventListener('pointermove', e => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && pinch0) { const [a, b] = [...touches.values()], d = Math.hypot(a.x - b.x, a.y - b.y); if (d > 0) setDist(dist * pinch0 / d); pinch0 = d; return; }
      if (!drag) return; turn(e.clientX - drag.x, e.clientY - drag.y); drag = { x: e.clientX, y: e.clientY };
    });
    const lift = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0; drag = null; };
    canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('dblclick', e => tapAt(e.clientX, e.clientY));
    canvas.addEventListener('wheel', e => setDist(dist * (1 + e.deltaY * 0.0012)), { passive: true });
  }
  function turn(dx, dy) {     // slower when close in, so a small drag doesn't fling a continent away
    const k = 3.2 / innerHeight * clamp((dist - 1) / (HOME - 1), 0.03, 1.2);
    rotY += dx * k; rotX = clamp(rotX + dy * k, -1.45, 1.45); spin = false; fly = null; lastDrag = performance.now();
  }
  function sunNow() {      // where the sun is overhead right now (declination and hour angle; the equation of time is ignored, ±4 min)
    const d = new Date(), doy = (d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5, h = d.getUTCHours() + d.getUTCMinutes() / 60;
    shared.uSun.value.copy(vec(-23.44 * Math.cos(2 * Math.PI / 365 * (doy + 10)), (12 - h) * 15));
  }
  function setDist(d) { dist = clamp(d, NEAR, FAR); fly = null; spin = false; lastDrag = performance.now(); }
  function layout() {           // centred; slides right only while a side card is up
    const w = innerWidth, h = innerHeight, rPx = h * 0.5 * (1 / Math.tan(15 * DEG)) / HOME;
    const cardRight = cardKind ? card.getBoundingClientRect().right : 0;
    pxWant = cardKind ? clamp(cardRight + rPx + 40 - w / 2, 0, w * 0.2) : 0;
  }
  function resize() {       // a tall, narrow screen (a phone) fits the Earth's width, not its height
    renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight;
    camera.fov = camera.aspect < 1 ? 2 * Math.atan(Math.tan(15 * DEG) / camera.aspect) / DEG : 30; camera.updateProjectionMatrix(); layout();
  }
  function center() { let lon = -rotY / DEG - 90; lon = ((lon + 180) % 360 + 360) % 360 - 180; return { lat: rotX / DEG, lon }; }

  // cinematic flight: pull back, swing round, settle in (like Google Earth)
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function flyTo(o) {
    const c = center(), lat = o.lat ?? c.lat, lon = o.lon ?? c.lon;
    const d1 = clamp(o.dist ?? (o.scale ? 1 + (dist - 1) * o.scale : dist), NEAR, FAR);     // "closer" shrinks the height above the ground
    let y1 = -(lon + 90) * DEG; const dy = y1 - rotY; y1 = rotY + Math.atan2(Math.sin(dy), Math.cos(dy));
    const x1 = clamp(lat * DEG, -1.45, 1.45);
    const ang = vec(c.lat, c.lon).angleTo(vec(lat, lon));
    const peak = Math.min(6, Math.max(dist, d1, 1 + ang * 1.9));
    const ms = Math.min(4500, 1500 + ang * 800 + Math.abs(Math.log(d1 / dist)) * 700);
    fly = { t0: performance.now(), ms, x0: rotX, y0: rotY, d0: dist, x1, y1, d1, peak };
    spin = false;
  }

  // the sharp close-up: when he's zoomed in and still, fetch a detailed picture of just that area and lay it over the globe
  let patch = null, patchKey = '', lastCheck = 0;
  function wantPatch() {
    if (dist > 2.4 || fly || performance.now() - lastDrag < 450) return;
    const c = center(), halfLat = clamp((dist - 1) * 0.268 / DEG * 1.5, 1, 45), halfLon = clamp(halfLat * camera.aspect / Math.max(0.25, Math.cos(c.lat * DEG)), 1, 170);
    const step = Math.max(0.25, Math.round(halfLat / 3 * 4) / 4), snap = (v, f) => f(v / step) * step;
    const w = Math.max(-180, snap(c.lon - halfLon, Math.floor)), e = Math.min(180, snap(c.lon + halfLon, Math.ceil));
    const s = Math.max(-89.75, snap(c.lat - halfLat, Math.floor)), n = Math.min(89.75, snap(c.lat + halfLat, Math.ceil));
    const kind = modeWant > 0.5 ? 'sat' : 'blue', key = [kind, w, s, e, n].join(',');
    if (key === patchKey) return;
    patchKey = key;
    const q = `w=${w}&s=${s}&e=${e}&n=${n}`, ld = new THREE.TextureLoader();
    const m = makeMat([w, s, e, n], 0.06);
    const geo = new THREE.SphereGeometry(R * 1.0005, 96, 96, (w + 180) * DEG, (e - w) * DEG, (90 - n) * DEG, (n - s) * DEG);
    const swap = () => { if (patchKey !== key) { geo.dispose(); m.dispose(); return; }
      if (patch) { group.remove(patch); patch.geometry.dispose(); patch.material.dispose(); }
      patch = new THREE.Mesh(geo, m); patch.renderOrder = 1; group.add(patch); };
    ld.load(GURL(`/globe/patch?kind=blue&${q}`), t => { t.anisotropy = 8; m.uniforms.tBlue.value = t; if (kind === 'blue') swap(); else if (m.uniforms.tSat.value !== blank) swap(); });
    if (kind === 'sat') ld.load(GURL(`/globe/patch?kind=sat&${q}`), t => { t.anisotropy = 8; m.uniforms.tSat.value = t; if (m.uniforms.tBlue.value !== blank) swap(); });
  }
  function dropPatch() { if (patch) { group.remove(patch); patch.geometry.dispose(); patch.material.dispose(); patch = null; } patchKey = ''; }

  // borders: countries always, states fade in as he zooms (Natural Earth, packed as int16 lon/lat x 90)
  let countries = null, states = null;
  async function lines(url, r, color) {
    const a = new Int16Array(await (await fetch(url)).arrayBuffer());
    const out = new Float32Array(a.length * 3); let k = 0, prev = null;
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] === 32767) { prev = null; continue; }
      const v = vec(a[i + 1] / 90, a[i] / 90, r);
      if (prev) { out[k++] = prev.x; out[k++] = prev.y; out[k++] = prev.z; out[k++] = v.x; out[k++] = v.y; out[k++] = v.z; }
      prev = v;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(out.subarray(0, k), 3));
    const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
    ls.renderOrder = 2; group.add(ls); return ls;
  }
  function loadBorders() {
    lines('/models/globe/countries.bin', R * 1.0012, 0xffe6b8).then(l => countries = l).catch(e => console.warn('[GLOBE] borders', e));
    lines('/models/globe/states.bin', R * 1.0010, 0xffe6b8).then(l => states = l).catch(e => console.warn('[GLOBE] states', e));
  }
  // place names: a small pool of labels reused for whatever countries / states are in view at this zoom
  let names = null; const pool = [];
  function loadNames() {
    fetch('/models/globe/labels.json').then(r => r.json()).then(d => {
      names = [...d.countries.map(p => ({ n: p.n, r: p.r, c: 1, v: vec(p.lat, p.lon, R * 1.002) })), ...d.states.map(p => ({ n: p.n, r: p.r, c: 0, v: vec(p.lat, p.lon, R * 1.002) }))];
    }).catch(e => console.warn('[GLOBE] names', e));
  }
  function nameEl(i) { while (pool.length <= i) { const e = el('div', 'pc-gname'); hud.appendChild(e); pool.push(e); } return pool[i]; }

  function clearLayer() {
    if (layer) { group.remove(layer); layer.geometry.dispose(); layer.material.dispose(); layer = null; }
    if (line) { group.remove(line); line.geometry.dispose(); line = null; }
    if (issDot) { group.remove(issDot); issDot = null; }
    clearInterval(issTimer); labels.forEach(l => l.el.remove()); labels = []; aurWant = 0;
  }
  function label(lat, lon, text, big) { const e = el('div', 'pc-glabel' + (big ? ' big' : ''), esc(text)); hud.appendChild(e); labels.push({ el: e, p: vec(lat, lon, R * 1.02) }); }
  function points(list, kind) {
    const n = list.length, pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3);
    const c = new THREE.Color();
    list.forEach((p, i) => {
      vec(p.lat, p.lon, R * (kind === 'aurora' ? 1.012 : 1.008)).toArray(pos, i * 3);
      if (kind === 'quakes') { size[i] = 6 + Math.pow(Math.max(0, p.size - 2), 1.6) * 5; c.setHSL(0.11 - Math.min(1, (p.size - 2.5) / 4) * 0.11, 1, 0.6); }
      else if (kind === 'storms') { size[i] = 34; c.set(0xff7a4d); }
      else if (kind === 'aurora') { size[i] = 3 + p.size * 0.12; c.setHSL(0.38 - Math.min(1, p.size / 60) * 0.08, 0.9, 0.35 + Math.min(1, p.size / 60) * 0.3); }
      else { size[i] = 10; c.set(0xffecbe); }
      c.toArray(col, i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('size', new THREE.BufferAttribute(size, 1)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: renderer.getPixelRatio() }, uRing: { value: kind === 'storms' ? 1 : 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uPx; uniform float uTime;
        void main() { vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * uPx * (1.0 + 0.12 * sin(uTime * 3.0 + position.x * 40.0)); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; uniform float uRing; uniform float uTime;
        void main() { vec2 q = gl_PointCoord - 0.5; float d = length(q) * 2.0;
          float a = uRing > 0.5 ? smoothstep(0.12, 0.0, abs(d - 0.6 - 0.15 * sin(atan(q.y, q.x) * 3.0 + uTime * 4.0))) + smoothstep(0.25, 0.0, d)
                                : smoothstep(1.0, 0.0, d) * 0.55 + smoothstep(0.35, 0.0, d);
          if (a < 0.01) discard; gl_FragColor = vec4(vC * a, a); }`,
    });
    layer = new THREE.Points(g, m); layer.renderOrder = 3; group.add(layer);
  }
  function arc(track) {          // the station's ground track: great-circle steps between the 10-minute fixes
    const pts = [];
    for (let i = 0; i < track.length - 1; i++) {
      const a = vec(track[i].lat, track[i].lon, R * 1.03), b = vec(track[i + 1].lat, track[i + 1].lon, R * 1.03);
      for (let k = 0; k < 24; k++) pts.push(a.clone().lerp(b, k / 24).setLength(R * 1.03));
    }
    line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffecbe, transparent: true, opacity: 0.7 }));
    group.add(line);
    issDot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); group.add(issDot);
    const put = (lat, lon) => { issDot.position.copy(vec(lat, lon, R * 1.03)); if (labels[0]) labels[0].p = issDot.position.clone(); };
    const now = Date.now() / 1000, cur = track.reduce((m, p) => Math.abs(p.t - now) < Math.abs(m.t - now) ? p : m, track[0]);
    label(cur.lat, cur.lon, 'ISS', true); put(cur.lat, cur.lon);
    issTimer = setInterval(() => fetch('/globe/iss').then(r => r.json()).then(d => put(d.latitude, d.longitude)).catch(() => {}), 5000);
  }

  // distance: two places joined by a great-circle arc lifted off the ground, the length written at its top.
  // Voice sends both places; by hand, two quick pinch-taps (or double-clicks) on the globe drop the pins, a third starts again.
  const latLon = v => ({ lat: Math.asin(clamp(v.y / v.length(), -1, 1)) / DEG, lon: Math.atan2(-v.z, v.x) / DEG });
  const kmBetween = (a, b) => Math.round(6371 * vec(a.lat, a.lon).angleTo(vec(b.lat, b.lon)));
  function measure(a, b, km) {
    clearLayer(); pins = [];
    const va = vec(a.lat, a.lon), vb = vec(b.lat, b.lon), ang = va.angleTo(vb), sn = Math.sin(ang), pts = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120, p = sn < 1e-4 ? va.clone() : va.clone().multiplyScalar(Math.sin((1 - t) * ang) / sn).add(vb.clone().multiplyScalar(Math.sin(t * ang) / sn));
      pts.push(p.setLength(R * (1.004 + (0.015 + ang * 0.09) * Math.sin(Math.PI * t))));
    }
    line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xfff1c9, transparent: true, opacity: 0.95, depthWrite: false }));
    line.renderOrder = 5; group.add(line);
    points([a, b], 'pins');
    label(a.lat, a.lon, a.label || 'A', false); label(b.lat, b.lon, b.label || 'B', false);
    const e = el('div', 'pc-glabel big pc-gkm', `${km.toLocaleString()} km <i>${Math.round(km * 0.621371).toLocaleString()} mi</i>`); hud.appendChild(e);
    labels.push({ el: e, p: pts[60].clone().multiplyScalar(1.01) });
    const mid = sn < 1e-4 || ang > 3.1 ? latLon(pts[60]) : latLon(va.clone().add(vb));
    flyTo({ lat: mid.lat, lon: mid.lon, dist: clamp(1.6 + ang * 1.9, 1.9, HOME) });
  }
  let pins = [];
  const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
  function tapAt(x, y) {
    _ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); _ray.setFromCamera(_ndc, camera);
    const hit = _ray.intersectObject(earth, false)[0]; if (!hit) return false;
    const p = latLon(group.worldToLocal(hit.point.clone())), fmt = (v, a, b) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? a : b}`;
    p.label = `${fmt(p.lat, 'N', 'S')} ${fmt(p.lon, 'E', 'W')}`;
    if (pins.length >= 2) pins = [];
    pins.push(p);
    if (pins.length === 1) { clearLayer(); pins = [p]; points([p], 'pins'); label(p.lat, p.lon, p.label, false); return true; }
    const [a, b] = pins, km = kmBetween(a, b); measure(a, b, km); pins = [a, b];
    if (window.__jvSay) window.__jvSay(`${km.toLocaleString()} kilometres.`);
    return true;
  }

  const clock = new THREE.Clock(); const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _cam = new THREE.Vector3(), _inv = new THREE.Matrix4();
  const lineCol = new THREE.Color(), GOLD = new THREE.Color(0xffe6b8), WHITE = new THREE.Color(0xffffff);
  function project(p, placed, minDx, minDy) {   // screen spot for a point on the globe, or null if it's round the back or would overlap
    _v.copy(p).applyMatrix4(group.matrixWorld); _n.copy(_v).normalize();
    const facing = -_n.dot(_v.clone().sub(camera.position).normalize());
    _v.project(camera);
    const x = (_v.x * 0.5 + 0.5) * innerWidth, y = (-_v.y * 0.5 + 0.5) * innerHeight;
    if (facing < 0.2 || x < -50 || x > innerWidth + 50 || y < -20 || y > innerHeight + 20) return null;
    if (placed.some(q => Math.abs(q.x - x) < (minDx + q.w) / 2 && Math.abs(q.y - y) < minDy)) return null;
    if (hudBoxes.some(r => x + minDx / 2 > r.left - 8 && x - minDx / 2 < r.right + 8 && y + minDy / 2 > r.top - 6 && y - minDy / 2 < r.bottom + 6)) return null;
    return { x, y };
  }
  let hudBoxes = [], boxesAt = 0;      // names keep out from under the greeting, clock, gauges, pill, subtitles and card
  const HUD_IDS = ['pc-hello', 'pc-clock', 'pc-gauges', 'pc-pill', 'pc-subs', 'pc-card', 'pc-cam'];
  function measureHud() {
    hudBoxes = HUD_IDS.map(id => document.getElementById(id)).filter(e => e && parseFloat(getComputedStyle(e).opacity) > 0.05 && getComputedStyle(e).display !== 'none')
      .map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
  }
  let lastDraw = 0, sunAt = 0;
  function frame() {
    if (!running) return;
    if (window.__jvLight && performance.now() - lastDraw < 40) { requestAnimationFrame(frame); return; }   // light mode: the globe at 25 fps
    lastDraw = performance.now();
    const dt = Math.min(0.05, clock.getDelta()), now = performance.now();
    mode += (modeWant - mode) * Math.min(1, dt * 2.5); shared.uMode.value = mode; shared.uTime.value += dt;
    if (now - sunAt > 10000) { sunAt = now; sunNow(); }
    const aw = Math.max(aurWant, mode * 0.6); aur.material.uniforms.uA.value += (aw - aur.material.uniforms.uA.value) * Math.min(1, dt * 2);
    atmo.material.uniforms.uC.value.set(0xf5c97a).lerp(new THREE.Color(0x6aa8ff), mode);
    if (layer) layer.material.uniforms.uTime.value += dt;
    if (fly) {
      const t = Math.min(1, (now - fly.t0) / fly.ms), e = ease(t);
      rotX = fly.x0 + (fly.x1 - fly.x0) * e; rotY = fly.y0 + (fly.y1 - fly.y0) * e;
      const base = fly.d0 + (fly.d1 - fly.d0) * e, mid = fly.d0 + (fly.d1 - fly.d0) * 0.5;
      dist = base + Math.max(0, fly.peak - mid) * Math.sin(Math.PI * e);
      if (t >= 1) { dist = fly.d1; fly = null; }
    } else if (spin && dist >= HOME - 0.5) rotY += dt * 0.06;
    px += (pxWant - px) * Math.min(1, dt * 4);
    camera.position.z = dist; camera.near = Math.max(0.004, (dist - 1) * 0.3); camera.far = dist + 3;
    camera.setViewOffset(innerWidth, innerHeight, -px, 0, innerWidth, innerHeight); camera.updateProjectionMatrix();
    shared.uScan.value = clamp((dist - 2) / 2, 0, 1); shared.uGrid.value = dist < 2 ? 5 : 15;
    group.rotation.set(rotX, rotY, 0); group.updateMatrixWorld();
    lineCol.copy(GOLD).lerp(WHITE, mode);
    if (countries) { countries.material.color.copy(lineCol); countries.material.opacity = 0.35 + 0.35 * clamp((HOME - dist) / 2.5, 0, 1); }
    if (states) { states.material.color.copy(lineCol); states.material.opacity = 0.42 * clamp((3.4 - dist) / 1.4, 0, 1); states.visible = dist < 3.4; }
    if (now - lastCheck > 500) { lastCheck = now; if (dist > 2.6) dropPatch(); else wantPatch(); }
    // event labels first (they matter more), then place names in the room that's left
    if (now - boxesAt > 700) { boxesAt = now; measureHud(); }
    const placed = [], showing = canvas.classList.contains('on');
    for (const l of labels) {
      if (!showing) { l.el.style.opacity = 0; continue; }          // pins sit above their point: collide names with where the pill really is
      const w = l.el.offsetWidth || 90, s = project(l.p, placed, w, 26);
      l.el.style.opacity = s ? 1 : 0;
      if (s) { placed.push({ x: s.x, y: s.y - 21, w }); l.el.style.transform = `translate(${s.x}px, ${s.y - 10}px) translate(-50%, -100%)`; }
    }
    let used = 0; const pins = new Set(labels.map(l => l.el.textContent));
    if (showing && names && dist < 4.6) {
      _cam.copy(camera.position).applyMatrix4(_inv.copy(group.matrixWorld).invert()).normalize();
      const reach = Math.cos(Math.min(Math.acos(1 / dist), (dist - 1) * 0.268 * camera.aspect * 1.1));
      const cRank = dist > 3.6 ? 2 : dist > 2.8 ? 3 : dist > 2.1 ? 5 : 10, sRank = dist > 1.75 ? (dist > 2.1 ? -1 : 3) : 10;
      for (const p of names) {
        if (used >= 45) break;
        if (p.c ? p.r > cRank : p.r > sRank) continue;
        if (pins.has(p.n)) continue;          // the pin already says it
        if (p.v.dot(_cam) / R < reach) continue;
        const w = p.n.length * (p.c ? 8.5 : 7) + 16, s = project(p.v, placed, w, p.c ? 22 : 18);
        if (!s) continue;
        placed.push({ ...s, w });
        const e = nameEl(used++); if (e.textContent !== p.n) e.textContent = p.n;
        e.className = p.c ? 'pc-gname' : 'pc-gname st'; e.style.opacity = 1;
        e.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
      }
    }
    for (let i = used; i < pool.length; i++) pool[i].style.opacity = 0;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  const api = {
    get on() { return running; }, get dist() { return dist; },
    show(msg = {}) {
      const first = !renderer; if (first) init();
      if (msg.mode === 'sat') { modeWant = 1; patchKey = ''; if (!satTex) satTex = new THREE.TextureLoader().load(GURL('/globe/tex/sat'), t => { mat.uniforms.tSat.value = t; }); }
      else if (msg.mode === 'holo') { modeWant = 0; patchKey = ''; }
      if (msg.layer) {
        clearLayer();
        if (msg.layer === 'aurora') { aurWant = 1; sunNow(); if (msg.focus) msg.focus.lon = latLon(shared.uSun.value).lon + 180; }   // look at the part of the oval that's in the dark
        if (msg.points && msg.points.length) points(msg.points, msg.layer);
        if (msg.layer === 'iss' && msg.line) arc(msg.line);
        (msg.points || []).filter(p => p.label).slice(0, msg.layer === 'quakes' ? 5 : 8).forEach((p, i) => label(p.lat, p.lon, p.label, i === 0));
      }
      if (msg.night) {         // the dark side of the Earth, where the cities are lit right now
        modeWant = 1; patchKey = ''; if (!satTex) satTex = new THREE.TextureLoader().load(GURL('/globe/tex/sat'), t => { mat.uniforms.tSat.value = t; });
        sunNow(); const s0 = latLon(shared.uSun.value); msg.fly = { lat: clamp(-s0.lat, -35, 35) + 20, lon: s0.lon > 0 ? s0.lon - 180 : s0.lon + 180, dist: 3.4 };
      }
      if (msg.measure) measure(msg.measure.a, msg.measure.b, msg.measure.km);
      const target = msg.measure ? null : msg.fly || (msg.focus && { lat: msg.focus.lat, lon: msg.focus.lon, dist: msg.layer === 'aurora' ? 3.4 : 3.0, label: msg.focus.label });
      if (target) {
        if (target.label && !msg.layer) { clearLayer(); label(target.lat, target.lon, target.label, true); }
        if (!running && target.lat != null) { rotX = clamp(target.lat * DEG, -1.45, 1.45) - 0.5; rotY = -(target.lon + 90) * DEG + 1.2; dist = HOME; }   // arriving: start off to one side, then sweep in
        flyTo(target);
      }
      if (msg.card) showCard('globe', infoHtml(msg.card)); else if (msg.layer == null && cardKind === 'globe') hideCard();
      layout();
      document.body.classList.add('pc-globe-on'); canvas.classList.add('on'); window.__jvFaceOff = true;
      if (!running) { running = true; clock.getDelta(); requestAnimationFrame(frame); }
    },
    hide() {
      if (!running) return;
      canvas.classList.remove('on'); document.body.classList.remove('pc-globe-on'); window.__jvFaceOff = !!(window.__jvHolo && window.__jvHolo.has());
      if (cardKind === 'globe') hideCard();
      labels.forEach(l => l.el.style.opacity = 0); pool.forEach(e => e.style.opacity = 0);
      setTimeout(() => { if (!canvas.classList.contains('on')) { running = false; clearLayer(); dropPatch(); spin = true; fly = null; dist = HOME; } }, 900);
    },
    turn, layout, setDist, tapAt,
  };
  return api;
})();

// ============================================================
// SYSTEM GAUGES (bottom left)
// ============================================================
const gauges = el('div'); gauges.id = 'pc-gauges'; hud.appendChild(gauges);
const C = 2 * Math.PI * 21;
const gauge = name => { const g = el('div', 'pc-gauge', `<svg viewBox="0 0 50 50"><circle class="bg" cx="25" cy="25" r="21"/><circle class="fg" cx="25" cy="25" r="21" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg><b>–</b><i>${name}</i>`); gauges.appendChild(g); return g; };
const G = { cpu: gauge('CPU'), ram: gauge('RAM'), bat: gauge('BAT') };
function setGauge(g, v, hotAt, invert) {
  if (v == null) { g.style.display = 'none'; return; }
  g.style.display = ''; g.querySelector('.fg').style.strokeDashoffset = C * (1 - Math.max(0, Math.min(100, v)) / 100);
  g.querySelector('b').textContent = Math.round(v); g.classList.toggle('hot', invert ? v <= hotAt : v >= hotAt);
}
async function pollStats() {
  if (!document.hidden) try {
    const s = await (await fetch('/sysstats')).json();
    setGauge(G.cpu, s.cpu, 85); setGauge(G.ram, s.ram, 90); setGauge(G.bat, s.bat, 20, true);
  } catch (e) {}
  setTimeout(pollStats, 3000);
}
if (!window.JARVIS_NATIVE) pollStats();          // the phone app has no PC gauges

// ============================================================
// HOLO PANELS: every answer bursts out of a glowing orb and settles into a ring that spins around it, riding a stream of light.
// Spin it, pull a panel forward, grab one and throw it away, or spread both hands to explode the ring into a wall.
// With 3D mode on, the webcam follows his head and the screen becomes a window (head-coupled perspective).
// ============================================================
const holo = (() => {
  const canvas = el('canvas'); canvas.id = 'pc-holo'; $('pc-globe').after(canvas);
  let renderer = null, scene, camera, orb, core, wave, stream, running = false, items = [], focused = -1, hovered = -1, lastTouch = 0, launchAt = 0, closingAt = 0;
  let ring = 0, ringT = 0, spinV = 0, coasting = false, lastDrag = 0, ringPrev = 0, flow = 0, layout = 'ring', focusScale = 1.5, turnId = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), clock = new THREE.Clock(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.9), hitP = new THREE.Vector3();
  const head = { x: 0, y: 0, z: 4, tx: 0, ty: 0, tz: 4, on: false };
  const ORB = new THREE.Vector3(0, -0.58, 0.1), RC = new THREE.Vector3(0, 0.2, -0.35), TILT = 0.27, MAX = 10;
  const clamp01 = v => Math.max(0, Math.min(1, v)), damp = (k, dt) => 1 - Math.exp(-k * dt);
  const easeOut = t => 1 - Math.pow(1 - t, 3), easeBack = t => { const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

  const PANEL_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const PANEL_FS = `uniform sampler2D map; uniform float uReveal; uniform float uOpacity; uniform float uGlow; uniform float uTime; varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
    void main() {
      vec4 c = texture2D(map, vUv);
      float edge = vUv.y + (n(vUv * 14.0) - 0.5) * 0.2, th = uReveal * 1.3 - 0.12;
      if (edge > th) discard;
      float band = smoothstep(0.1, 0.0, th - edge) * (1.0 - step(0.999, uReveal));
      float scan = 0.035 * sin(vUv.y * 240.0 - uTime * 5.0);
      vec3 col = c.rgb * (1.0 + scan + uGlow * 0.22) + vec3(1.0, 0.8, 0.45) * band * 1.8;
      gl_FragColor = vec4(col, clamp(c.a + band * 0.9, 0.0, 1.0) * uOpacity);
    }`;
  function glowTex(kind) {
    const c = document.createElement('canvas'), x = c.getContext('2d'); c.width = c.height = 256;
    if (kind === 'card') { x.shadowColor = 'rgba(255,205,120,1)'; x.shadowBlur = 38; x.fillStyle = 'rgba(255,205,120,.55)'; x.beginPath(); x.roundRect(48, 48, 160, 160, 18); x.fill(); x.globalCompositeOperation = 'destination-out'; x.shadowBlur = 0; x.beginPath(); x.roundRect(58, 58, 140, 140, 14); x.fill(); }
    else if (kind === 'ring') { x.strokeStyle = 'rgba(255,220,150,1)'; x.lineWidth = 5; x.shadowColor = 'rgba(255,200,110,1)'; x.shadowBlur = 22; x.beginPath(); x.arc(128, 128, 96, 0, 7); x.stroke(); }
    else { const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, 'rgba(255,250,235,1)'); g.addColorStop(0.22, 'rgba(255,214,140,.6)'); g.addColorStop(1, 'rgba(255,190,90,0)'); x.fillStyle = g; x.fillRect(0, 0, 256, 256); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  let CARD_GLOW = null;

  function init() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    const n = 2600, pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = 0.2 * (0.82 + Math.random() * 0.28), s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(t); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * s * Math.sin(t); seed[i] = Math.random() * 6.28;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    orb = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uCharge: { value: 0 }, uPx: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float seed; uniform float uTime; uniform float uLevel; uniform float uCharge; uniform float uPx; varying float vA;
        void main() { float pulse = 1.0 + 0.06 * sin(uTime * 2.0 + seed * 3.0) + uLevel * 0.35 * (0.5 + 0.5 * sin(seed * 9.0 + uTime * 14.0));
          vec3 p = position * pulse * (1.0 - uCharge * 0.45);
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vA = (0.45 + 0.55 * sin(uTime * 3.0 + seed)) * (1.0 + uCharge * 1.5);
          gl_PointSize = (2.2 + uLevel * 2.0 + uCharge * 2.0) * uPx * (4.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d) * vA; if (a < 0.02) discard; gl_FragColor = vec4(vec3(1.0, 0.84, 0.55) * a, a); }`,
    }));
    core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('dot'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    core.scale.setScalar(0.42); orb.add(core); orb.position.copy(ORB); scene.add(orb);
    wave = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('ring'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    wave.position.copy(ORB); scene.add(wave);
    CARD_GLOW = glowTex('card');
    // the orbit: a stream of light flowing round the ring, faint at rest, bright and streaky while it spins
    const sn = 900, sp = new Float32Array(sn * 3), ph = new Float32Array(sn), sd = new Float32Array(sn);
    for (let i = 0; i < sn; i++) { ph[i] = Math.random() * Math.PI * 2; sd[i] = Math.random(); sp[i * 3] = (Math.random() - 0.5) * 0.05; sp[i * 3 + 1] = (Math.random() - 0.5) * 0.035; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('phase', new THREE.BufferAttribute(ph, 1)); sg.setAttribute('seed', new THREE.BufferAttribute(sd, 1));
    stream = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: { uFlow: { value: 0 }, uR: { value: 1.2 }, uTilt: { value: TILT }, uBright: { value: 0 }, uTime: { value: 0 }, uPx: { value: renderer.getPixelRatio() }, uC: { value: RC.clone() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float phase; attribute float seed; uniform float uFlow; uniform float uR; uniform float uTilt; uniform float uBright; uniform float uTime; uniform float uPx; uniform vec3 uC; varying float vA;
        void main() {
          float a = phase + uFlow * (0.75 + seed * 0.5), r = uR + position.x, zl = r * cos(a);
          vec3 p = uC + vec3(r * sin(a), -zl * sin(uTilt) - 0.2 + position.y, zl * cos(uTilt));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = uBright * (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 2.0 + seed * 40.0))) * (0.55 + 0.45 * (cos(a) * 0.5 + 0.5));
          gl_PointSize = (1.4 + seed * 1.8 + uBright * 1.2) * uPx * (4.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d) * vA; if (a < 0.01) discard; gl_FragColor = vec4(vec3(1.0, 0.83, 0.52) * a, a); }`,
    }));
    scene.add(stream);
    resize(); addEventListener('resize', resize);
    let down = null;       // mouse: drag to spin (flick and it coasts), click a panel to pull it forward, wheel to step round
    canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (!down) { hover(e.clientX, e.clientY); return; }
      if (Math.abs(e.clientX - down.x) > 6) down.moved = true;
      if (down.moved) { drag(e.clientX - down.x); down.x = e.clientX; }
    });
    canvas.addEventListener('pointerup', e => { if (down && !down.moved) pick(e.clientX, e.clientY); else if (down) release(); down = null; });
    canvas.addEventListener('wheel', e => { rotate(e.deltaY > 0 ? 1 : -1); }, { passive: true });
  }
  function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; }

  // ---- painting a panel: picture, text, a big number (stat), a list (plan), or a longer note ----
  function wrap(cx, text, w, maxLines) {
    const words = String(text || '').split(/\s+/), lines = []; let line = '';
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (cx.measureText(t).width > w && line) { lines.push(line); line = wd; if (lines.length === maxLines) break; } else line = t; }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…');
    return lines;
  }
  const kindOf = d => d.kind || (d.image ? 'image' : 'text');
  const SIZE = { image: [480, 600, 0.4], text: [640, 400, 0.52], stat: [480, 400, 0.38], list: [560, 680, 0.42], note: [620, 640, 0.48], video: [640, 452, 0.62] };
  const VID = (() => { const W = 640, pad = 14, iw = W - pad * 2 - 24; return { x: pad + 12, y: pad + 12, w: iw, h: Math.round(iw * 9 / 16) }; })();   // the picture area a live station plays in
  function paint(it) {
    const k = kindOf(it.data), [W, H] = SIZE[k], c = it.cv || (it.cv = document.createElement('canvas'));
    c.width = W; c.height = H; const x = c.getContext('2d'), pad = 14, L = pad + 30;
    x.clearRect(0, 0, W, H);
    const grd = x.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, 'rgba(46,30,14,.9)'); grd.addColorStop(1, 'rgba(14,9,4,.94)');
    x.beginPath(); x.roundRect(pad, pad, W - pad * 2, H - pad * 2, 26); x.fillStyle = grd; x.fill();
    x.lineWidth = 3; x.strokeStyle = it.data.tone === 'warn' ? 'rgba(255,154,61,.85)' : 'rgba(245,201,122,.75)'; x.stroke();
    const small = (t, y, col = '#d9b46e') => { x.font = "600 17px Saira, system-ui, sans-serif"; x.fillStyle = col; x.fillText(String(t || '').toUpperCase().slice(0, 40), L, y); };
    if (k === 'video') {        // a live station: its picture (the player sits over it when it's in front), the name, LIVE
      x.save(); x.beginPath(); x.roundRect(VID.x, VID.y, VID.w, VID.h, 16); x.clip(); x.fillStyle = '#000'; x.fillRect(VID.x, VID.y, VID.w, VID.h);
      if (it.pic && it.pic.complete && it.pic.naturalWidth) {
        const r = Math.max(VID.w / it.pic.naturalWidth, VID.h / it.pic.naturalHeight), dw = it.pic.naturalWidth * r, dh = it.pic.naturalHeight * r;
        x.drawImage(it.pic, VID.x + (VID.w - dw) / 2, VID.y + (VID.h - dh) / 2, dw, dh);
      }
      x.restore();
      const ty = VID.y + VID.h + 44;
      const tl = it.data.live === false, pw = tl ? 118 : 62;      // a webcam that sends pictures rather than video says TIMELAPSE
      x.beginPath(); x.roundRect(pad + 26, ty - 22, pw, 28, 14); x.fillStyle = tl ? '#f5c97a' : '#e8483c'; x.fill();
      x.font = "700 15px Saira, system-ui, sans-serif"; x.fillStyle = tl ? '#1a1006' : '#fff'; x.fillText(tl ? 'TIMELAPSE' : 'LIVE', pad + 38, ty - 2);
      x.font = "600 28px Saira, system-ui, sans-serif"; x.fillStyle = '#fff6e8'; x.fillText(wrap(x, it.data.title, W - 160 - pw, 1)[0] || '', pad + 40 + pw, ty);
      x.font = "500 17px Saira, system-ui, sans-serif"; x.fillStyle = '#c9a76a'; x.fillText(String(it.data.source || '').toUpperCase().slice(0, 40), pad + 26, ty + 32);
    } else if (k === 'image') {
      const ih = H - 150;
      x.save(); x.beginPath(); x.roundRect(pad + 12, pad + 12, W - pad * 2 - 24, ih, 18); x.clip();
      if (it.pic && it.pic.complete && it.pic.naturalWidth) {
        const r = Math.max((W - pad * 2 - 24) / it.pic.naturalWidth, ih / it.pic.naturalHeight), dw = it.pic.naturalWidth * r, dh = it.pic.naturalHeight * r;
        x.drawImage(it.pic, pad + 12 + (W - pad * 2 - 24 - dw) / 2, pad + 12 + (ih - dh) / 2, dw, dh);
      } else { x.fillStyle = 'rgba(245,201,122,.08)'; x.fillRect(0, 0, W, H); }
      x.restore();
      x.font = "600 26px Saira, system-ui, sans-serif"; x.fillStyle = '#fff6e8';
      wrap(x, it.data.title, W - 90, 2).forEach((l, i) => x.fillText(l, pad + 26, pad + 12 + ih + 40 + i * 32));
      x.font = "500 18px Saira, system-ui, sans-serif"; x.fillStyle = '#c9a76a'; x.fillText((it.data.source || '').toUpperCase().slice(0, 34), pad + 26, H - pad - 22);
    } else if (k === 'stat') {
      small(it.data.label, pad + 52);
      x.font = "300 96px Saira, system-ui, sans-serif"; x.fillStyle = '#fff6e8';
      let fs = 96; while (x.measureText(String(it.data.value)).width > W - 90 && fs > 40) { fs -= 6; x.font = `300 ${fs}px Saira, system-ui, sans-serif`; }
      x.fillText(String(it.data.value), L - 4, pad + 70 + fs);
      x.font = "400 23px Saira, system-ui, sans-serif"; x.fillStyle = it.data.tone === 'up' ? '#9fdc9a' : it.data.tone === 'down' ? '#ff9a7a' : '#d6c4a6';
      wrap(x, it.data.sub, W - 80, 3).forEach((l, i) => x.fillText(l, L, pad + 120 + fs + i * 30));
    } else if (k === 'list') {
      x.font = "600 32px Saira, system-ui, sans-serif"; x.fillStyle = it.data.tone === 'warn' ? '#ffb070' : '#fff6e8'; x.fillText(String(it.data.title || '').slice(0, 26), L, pad + 62);
      const rows = it.data.rows || [];
      if (!rows.length) { x.font = "400 24px Saira, system-ui, sans-serif"; x.fillStyle = '#d6c4a6'; x.fillText(it.data.empty || 'Nothing here.', L, pad + 120); }
      rows.slice(0, 7).forEach((r, i) => {
        const y = pad + 120 + i * 74;
        if (r.tone === 'suggest') { x.setLineDash([6, 6]); x.strokeStyle = 'rgba(245,201,122,.5)'; x.lineWidth = 2; x.beginPath(); x.roundRect(L - 12, y - 32, W - L * 2 + 24, 64, 12); x.stroke(); x.setLineDash([]); }
        x.globalAlpha = r.tone === 'past' ? 0.45 : 1;
        x.font = "600 22px Saira, system-ui, sans-serif"; x.fillStyle = '#f5c97a'; if (r.t) x.fillText(r.t, L, y);
        const tx = r.t ? L + 130 : L;
        x.font = "500 24px Saira, system-ui, sans-serif"; x.fillStyle = '#fff6e8'; x.fillText(wrap(x, r.title, W - tx - 40, 1)[0] || '', tx, y);
        x.font = "400 18px Saira, system-ui, sans-serif"; x.fillStyle = r.tone === 'suggest' ? '#f5c97a' : '#bfa985'; x.fillText(String(r.sub || '').slice(0, 40), tx, y + 24);
        x.globalAlpha = 1;
      });
    } else if (k === 'note') {
      small(it.data.source || '', pad + 46);
      x.font = "600 34px Saira, system-ui, sans-serif"; x.fillStyle = '#fff6e8';
      const tl = wrap(x, it.data.title, W - 120, 2); tl.forEach((l, i) => x.fillText(l, L, pad + 92 + i * 40));
      x.font = "400 23px Saira, system-ui, sans-serif"; x.fillStyle = '#e2d2b6';
      wrap(x, it.data.text, W - 76, 15 - tl.length * 2).forEach((l, i) => x.fillText(l, L, pad + 112 + tl.length * 40 + i * 31));
    } else {
      small(it.data.source, pad + 42);
      x.font = "600 33px Saira, system-ui, sans-serif"; x.fillStyle = '#fff6e8';
      const tl = wrap(x, it.data.title, W - 120, 3); tl.forEach((l, i) => x.fillText(l, L, pad + 86 + i * 40));
      x.font = "400 22px Saira, system-ui, sans-serif"; x.fillStyle = '#d6c4a6';
      wrap(x, it.data.text, W - 76, Math.max(1, 6 - tl.length)).forEach((l, i) => x.fillText(l, L, pad + 102 + tl.length * 40 + i * 30));
    }
    const ny = k === 'video' ? H - pad - 44 : pad + 34;     // on a station the number sits under the picture, where the player won't cover it
    x.beginPath(); x.arc(W - pad - 34, ny, 19, 0, 7); x.fillStyle = 'rgba(245,201,122,.92)'; x.fill();     // the number to say: "open number three"
    x.font = "700 21px Saira, system-ui, sans-serif"; x.fillStyle = '#1a1006'; x.textAlign = 'center'; x.fillText(String(it.i + 1), W - pad - 34, ny + 7); x.textAlign = 'left';
    if (it.tex) it.tex.needsUpdate = true;
  }

  // ---- layouts: the ring (tilted, centred behind the orb) or the exploded wall ----
  const step = () => Math.PI * 2 / Math.max(1, items.length);
  const radius = () => Math.min(1.5, 0.95 + 0.07 * items.length);
  function ringPos(i, out) {
    const th = i * step() - ring, R = radius() * (focused >= 0 ? 1.18 : 1), zl = R * Math.cos(th);
    out.set(R * Math.sin(th), RC.y - zl * Math.sin(TILT), RC.z + zl * Math.cos(TILT));
    return th;
  }
  function wallPos(i, out) {
    const n = items.length, cols = Math.min(5, Math.ceil(Math.sqrt(n * 1.7))), rows = Math.ceil(n / cols), r = Math.floor(i / cols), c = i % cols;
    const inRow = r === rows - 1 ? n - r * cols : cols, sx = 0.6, sy = 0.62;
    out.set((c - (inRow - 1) / 2) * sx, 0.12 - (r - (rows - 1) / 2) * sy, 0.25);
  }
  function frontIndex() { const n = items.length; return n ? ((Math.round(ring / step()) % n) + n) % n : -1; }
  function nearestTurn(i) { const want = i * step(); return ring + Math.atan2(Math.sin(want - ring), Math.cos(want - ring)); }

  function makeItem(data, i, born) {
    const k = kindOf(data), it = { data, i, born };
    paint(it); it.tex = new THREE.CanvasTexture(it.cv); it.tex.colorSpace = THREE.NoColorSpace; it.tex.anisotropy = 4;
    it.mat = new THREE.ShaderMaterial({ vertexShader: PANEL_VS, fragmentShader: PANEL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { map: { value: it.tex }, uReveal: { value: 0 }, uOpacity: { value: 1 }, uGlow: { value: 0 }, uTime: { value: 0 } } });
    const [W, H, w] = SIZE[k], h = w * H / W;
    it.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), it.mat); it.mesh.visible = false; scene.add(it.mesh);
    it.glow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.6, h * 1.6), new THREE.MeshBasicMaterial({ map: CARD_GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    it.mesh.add(it.glow); it.glow.position.z = -0.002;
    it.streak = new THREE.Line(new THREE.BufferGeometry().setFromPoints([ORB.clone(), ORB.clone()]), new THREE.LineBasicMaterial({ color: 0xffd38a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(it.streak);
    it.pos = ORB.clone(); it.scale = 0.01; it.op = 1; it.ry = 0; it.lift = 0;
    if (data.image) { it.pic = new Image(); it.pic.onload = () => paint(it); it.pic.src = '/holo/img?u=' + encodeURIComponent(data.image); }
    return it;
  }
  async function show(msg) {
    if (!renderer) init();
    await document.fonts.load("600 33px Saira").catch(() => {});
    const now = performance.now(), list = (msg.items || []).slice(0, MAX);
    // more results for the same question join the ring with a smaller burst; a new question starts a fresh ring
    if (msg.turn != null && msg.turn === turnId && items.length && !closingAt) {
      const room = list.slice(0, MAX - items.length);
      room.forEach((d, k) => items.push(makeItem(d, items.length, now + 120 + k * 95)));
      wave.userData.t0 = now + 100; lastTouch = now; return;
    }
    clear(true); focused = -1; hovered = -1; ring = ringT = 0; spinV = 0; coasting = false; closingAt = 0; layout = 'ring'; focusScale = 1.5; turnId = msg.turn;
    launchAt = now + 450; wave.userData.fired = false;
    items = list.map((d, i) => makeItem(d, i, launchAt + i * 95));
    setTimeout(() => window.__jvSfx && window.__jvSfx.burst(), 380);
    lastTouch = now; activate(true);
  }
  function dispose(it) { scene.remove(it.mesh); scene.remove(it.streak); it.mesh.geometry.dispose(); it.glow.geometry.dispose(); it.glow.material.dispose(); it.mat.dispose(); it.tex.dispose(); it.streak.geometry.dispose(); it.streak.material.dispose(); }
  function removeItem(it) {
    const k = items.indexOf(it); if (k < 0) return;
    dispose(it); items.splice(k, 1);
    items.forEach((x, j) => { if (x.i !== j) { x.i = j; paint(x); } });            // renumber, so "number three" still means the third one
    if (focused === k) focused = -1; else if (focused > k) focused--;
    hovered = -1; if (!items.length) { closingAt = 0; activate(false); }
  }
  function clear(instant) {
    tv.stop();
    if (!items.length) return;
    if (instant) { items.forEach(dispose); items = []; return; }
    if (closingAt) return;
    const now = performance.now(); closingAt = now; focused = -1;
    items.forEach((it, k) => { it.leaving = now + k * 55; it.from = it.pos.clone(); it.fromScale = it.scale; it.held = null; });
    setTimeout(() => { if (closingAt === now) { clear(true); closingAt = 0; wave.userData.t0 = performance.now(); activate(false); } }, 900 + items.length * 55);
  }
  function activate(on) {
    window.__jvHoloActive = on || head.on;
    document.body.classList.toggle('pc-holo-on', on);
    canvas.classList.toggle('live', on);
    window.__jvFaceOff = !!(on && items.length) || (window.__jvGlobe && window.__jvGlobe.on);
    if ((on || head.on || wave.userData.t0) && !running) { running = true; clock.getDelta(); requestAnimationFrame(frame); }
  }
  function hit(x, y) {
    if (!items.length) return -1;
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    const hs = ray.intersectObjects(items.filter(it => it.mesh.visible && it.op > 0.45 && !it.thrown).map(it => it.mesh), false);
    return hs.length ? items.findIndex(it => it.mesh === hs[0].object) : -1;
  }
  const touch = () => { lastTouch = performance.now(); };
  function hover(x, y) { const i = hit(x, y); hovered = i; if (i >= 0) touch(); return i; }
  function pick(x, y) { const i = hit(x, y); if (i < 0 || i === focused) back(); else select(i); return i; }
  function select(i) { if (i < 0 || i >= items.length) return; if (layout === 'ring') ringT = nearestTurn(i); spinV = 0; coasting = false; focused = i; focusScale = 1.5; touch(); }
  function back() { focused = -1; touch(); }
  function rotate(dir) { if (items.length > 1 && layout === 'ring') { focused = -1; ringT = Math.round(ringT / step()) * step() + dir * step(); spinV = 0; coasting = false; touch(); } }
  function drag(dx) {              // spin with the hand or mouse; speed measured over time so a flick can coast
    if (items.length < 2 || layout !== 'ring') return;
    focused = -1; coasting = false;
    const now = performance.now(), d = dx / innerWidth * 4.2, el = Math.max(8, now - (lastDrag || now - 16)) / 1000;
    ringT += d; spinV = spinV * 0.5 + (d / el) * 0.5; lastDrag = now; touch();
  }
  function release() { lastDrag = 0; if (Math.abs(spinV) > 0.8) coasting = true; else { ringT = Math.round(ringT / step()) * step(); spinV = 0; } }
  function fling(v) { if (layout === 'ring' && items.length > 1) { spinV = v; coasting = true; focused = -1; touch(); } }
  function twist(da) { if (layout === 'ring' && items.length > 1) { ringT += da; spinV = 0; coasting = false; touch(); } }
  function snapRing() { ringT = Math.round(ringT / step()) * step(); }
  function screenToWorld(x, y, z = 0.9) {
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    plane.constant = -z; return ray.ray.intersectPlane(plane, hitP) ? hitP.clone() : null;
  }
  // grab and throw: a held panel follows the hand in front of the ring; thrown fast enough, it flies off and is gone
  function grab(i) { const it = items[i]; if (!it || it.leaving) return false; it.held = it.pos.clone(); focused = -1; touch(); return true; }
  function movePanel(i, x, y) { const it = items[i]; if (it && it.held) { const p = screenToWorld(x, y); if (p) it.held.copy(p); touch(); } }
  function dropPanel(i) { const it = items[i]; if (it) it.held = null; }
  function throwPanel(i, vx, vy) {
    const it = items[i]; if (!it) return;
    it.held = null; const s = 2.6 / innerWidth;
    it.thrown = { v: new THREE.Vector3(vx * s, -vy * s, 0.6), spin: (Math.random() - 0.5) * 8, t0: performance.now() };
    focused = -1; touch();
  }
  function explode() { if (items.length) { layout = 'wall'; focused = -1; coasting = false; touch(); } }
  function collapse() { if (layout === 'wall') { layout = 'ring'; touch(); } else clear(); }
  function enlarge(f = 1.25) { if (focused >= 0) { focusScale = Math.min(2.4, Math.max(1.1, focusScale * f)); touch(); } }

  // ---- the live station or webcam in front: its player laid exactly over that panel's picture, once the ring has stopped turning ----
  const CAM_OK = /^https:\/\/webcams\.windy\.com\/[\w\/.-]+$/;      // only Windy's own camera player goes into a webcam panel
  const feedOf = d => d.video ? 'yt:' + d.video : d.cam && CAM_OK.test(d.cam) ? 'cam:' + d.cam : null;
  const hasVideo = () => items.some(it => feedOf(it.data));
  const tv = (() => {
    const box = el('div'); box.id = 'pc-holo-tv'; canvas.after(box);
    document.head.appendChild(el('style', null, `#pc-holo-tv { position: fixed; z-index: 2; left: 0; top: 0; pointer-events: none; opacity: 0; border-radius: 10px;
      overflow: hidden; background: #000; transition: opacity .35s var(--ease); } #pc-holo-tv.on { opacity: 1; } #pc-holo-tv iframe { width: 100%; height: 100%; border: 0; display: block; }`));
    const ytHost = box.appendChild(el('div')), camFrame = box.appendChild(el('iframe'));
    ytHost.style.cssText = 'width:100%;height:100%'; camFrame.title = 'Webcam'; camFrame.referrerPolicy = 'strict-origin-when-cross-origin'; camFrame.style.display = 'none';
    let player = null, want = null, loading = null, vol = 80;
    const corner = new THREE.Vector3();
    const level = () => player && player.setVolume && player.setVolume(ducked ? Math.round(vol * 0.15) : vol);
    duckers.add(level);
    function load(feed) {
      want = feed;
      if (feed.startsWith('cam:')) {           // a webcam: Windy's player, silent, so the music can carry on
        try { player && player.pauseVideo(); } catch (e) {}
        ytHost.style.display = 'none'; camFrame.style.display = 'block'; camFrame.src = feed.slice(4); return;
      }
      const id = feed.slice(3); camFrame.style.display = 'none'; camFrame.src = 'about:blank'; ytHost.style.display = 'block';
      if (window.__jvMusic && window.__jvMusic.playing) window.__jvMusic.pause();     // one sound at a time
      if (player && player.loadVideoById) { player.loadVideoById(id); return; }
      if (loading) return;
      loading = loadYT().then(YT => { player = new YT.Player(ytHost.appendChild(el('div')), { width: '100%', height: '100%', videoId: id,
        playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: { onReady: () => { level();          // by now he may have turned to another station, or to a webcam
          if (want && want.startsWith('yt:') && want.slice(3) !== id) player.loadVideoById(want.slice(3)); else if (want && want.startsWith('yt:')) player.playVideo(); else player.pauseVideo(); } } }); });
    }
    function stop() { want = null; box.classList.remove('on'); camFrame.src = 'about:blank'; try { player && player.stopVideo(); } catch (e) {} }
    function place(now) {
      const i = focused >= 0 ? focused : frontIndex(), it = items[i];
      const feed = it && feedOf(it.data);
      const still = feed && !closingAt && layout === 'ring' && !coasting && Math.abs(ringT - ring) < 0.03 && now > it.born + 1200
        && !it.held && !it.thrown && !it.leaving && (focused < 0 || Math.abs(it.scale - focusScale) < 0.03);
      if (!still) { box.classList.remove('on'); return; }
      if (want !== feed) load(feed);
      const [W, H, w] = SIZE.video, h = w * H / W, m = it.mesh;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [u, v] of [[VID.x / W, VID.y / H], [(VID.x + VID.w) / W, (VID.y + VID.h) / H]]) {
        corner.set((u - 0.5) * w, (0.5 - v) * h, 0).applyMatrix4(m.matrixWorld).project(camera);
        const sx = (corner.x + 1) / 2 * innerWidth, sy = (1 - corner.y) / 2 * innerHeight;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      Object.assign(box.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
      box.classList.add('on');
    }
    return { place, stop, get sound() { return !!want && want.startsWith('yt:') && box.classList.contains('on'); } };
  })();

  const _p = new THREE.Vector3(), _m = new THREE.Vector3(), _b = new THREE.Vector3();
  function frame() {
    if (!running) return;
    const dt = Math.min(0.05, clock.getDelta()), now = performance.now(), t = now / 1000;
    const kh = damp(6, dt); head.x += (head.tx - head.x) * kh; head.y += (head.ty - head.y) * kh; head.z += (head.tz - head.z) * kh;
    const W = camera.aspect, ex = head.x * W * 0.9, ey = head.y * 0.8, ez = head.z, nr = 0.05;
    camera.position.set(ex, ey, ez); camera.updateMatrixWorld();
    camera.projectionMatrix.makePerspective((-W - ex) * nr / ez, (W - ex) * nr / ez, (1 - ey) * nr / ez, (-1 - ey) * nr / ez, nr, 50);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    // the ring: coasts after a flick (slowing like a real wheel, then landing on a panel), otherwise springs to where it's sent; drifts when left alone
    if (coasting) { ringT += spinV * dt; spinV *= Math.exp(-dt * 1.3); if (Math.abs(spinV) < 0.35) { coasting = false; spinV = 0; snapRing(); } }
    else if (items.length && !closingAt && focused < 0 && hovered < 0 && layout === 'ring' && now - lastTouch > 9000 && now > launchAt + 2500 && !hasVideo()) ringT += dt * 0.07;
    ring += (ringT - ring) * damp(coasting ? 12 : 5.5, dt);
    const ringVel = Math.abs(ring - ringPrev) / Math.max(dt, 1e-3); ringPrev = ring;

    const showOrb = (items.length > 0 || wave.userData.t0) && !(window.__jvGlobe && window.__jvGlobe.on);
    orb.visible = showOrb;
    const u = orb.material.uniforms, charge = items.length && now < launchAt ? 1 - (launchAt - now) / 450 : 0;
    u.uCharge.value += ((charge > 0 ? easeOut(charge) : 0) - u.uCharge.value) * damp(charge > 0 ? 30 : 8, dt);
    if (items.length && now >= launchAt && !wave.userData.fired) { wave.userData.fired = true; wave.userData.t0 = now; }
    if (wave.userData.t0 && now >= wave.userData.t0) {
      const a = (now - wave.userData.t0) / 750;
      if (a >= 1) { wave.material.opacity = 0; wave.userData.t0 = 0; } else { wave.scale.setScalar(0.25 + easeOut(a) * 2.6); wave.material.opacity = (1 - a) * 0.9; }
    }
    if (showOrb) {
      const lvl = window.__jvMouthLevel ? Math.max(0, window.__jvMouthLevel()) : (window.__jvSpeak || 0);
      u.uTime.value = t; u.uLevel.value += (lvl - u.uLevel.value) * 0.3;
      orb.rotation.y = t * 0.4; orb.rotation.x = Math.sin(t * 0.3) * 0.3;
      core.scale.setScalar(0.38 + 0.08 * Math.sin(t * 2.2) + lvl * 0.2 + u.uCharge.value * 0.35);
    }
    // the light stream: flows round the orbit, faster and brighter the faster the ring turns; gone in wall mode
    const su = stream.material.uniforms, settled = items.length && !closingAt && now > launchAt + 700 && layout === 'ring';
    flow += dt * (0.12 + Math.min(4, ringVel) * 0.9); su.uFlow.value = flow; su.uTime.value = t;
    su.uR.value += (radius() * (focused >= 0 ? 1.18 : 1) - su.uR.value) * damp(5, dt);
    su.uBright.value += ((settled ? (focused >= 0 ? 0.25 : 0.55 + Math.min(1, ringVel * 0.8) * 1.2) : 0) - su.uBright.value) * damp(5, dt);
    stream.visible = su.uBright.value > 0.01;

    for (const it of items.slice()) {
      const i = it.i, m = it.mesh, mat = it.mat.uniforms; mat.uTime.value = t;
      let th = 0, sc = 1, op = 1, ry = 0, glow = 0;
      if (layout === 'wall') wallPos(i, _p);
      else { th = ringPos(i, _p); const depth = (Math.cos(th) + 1) / 2; sc = 0.76 + 0.3 * depth; op = 0.28 + 0.72 * depth; ry = -Math.sin(th) * 0.55; }
      if (focused === i) { _p.set(0, 0.04, 1.42); sc = focusScale; op = 1; ry = 0; glow = 1; }
      else if (focused >= 0) { op *= 0.35; }
      else if (hovered === i) { sc *= 1.08; glow = 0.8; }
      if (it.thrown) {                                             // tossed: carries on in the throw's direction, tumbling, and fades out
        const th2 = it.thrown, age = (now - th2.t0) / 1000;
        it.pos.addScaledVector(th2.v, dt); th2.v.multiplyScalar(Math.exp(-dt * 0.6)); it.ry += th2.spin * dt; it.op = Math.max(0, 1 - age * 1.6);
        m.position.copy(it.pos); m.rotation.set(0, it.ry, th2.spin * age * 0.15); mat.uOpacity.value = it.op; it.glow.material.opacity = it.op * 0.5;
        m.renderOrder = 10 + Math.round((m.position.z + 3) * 100);
        if (it.op <= 0) removeItem(it); continue;
      }
      if (it.leaving) {
        const a = clamp01((now - it.leaving) / 650), e = a * a;
        _m.copy(it.from).lerp(ORB, 0.5).add(_b.set(0, 0.35, 0.3));
        m.position.copy(it.from).multiplyScalar((1 - e) * (1 - e)).add(_m.multiplyScalar(2 * (1 - e) * e)).add(_b.copy(ORB).multiplyScalar(e * e));
        m.scale.setScalar(Math.max(0.01, it.fromScale * (1 - e))); m.rotation.y = it.ry + e * Math.PI;
        mat.uReveal.value = 1 - a; it.glow.material.opacity = (1 - a) * 0.5; it.streak.material.opacity = Math.sin(Math.PI * a) * 0.6;
        it.streak.geometry.attributes.position.setXYZ(1, m.position.x, m.position.y, m.position.z); it.streak.geometry.attributes.position.needsUpdate = true;
        m.renderOrder = 10 + Math.round((m.position.z + 3) * 100); continue;
      }
      if (now < it.born) { m.visible = false; continue; }
      m.visible = true;
      if (it.held) { _p.copy(it.held); sc = 1.25; op = 1; ry = 0; glow = 1; }
      const a = clamp01((now - it.born) / 1150);
      if (a < 1 && !it.held) {
        const e = easeOut(a);
        _m.copy(ORB).lerp(_p, 0.5).add(_b.set(Math.sin(i * 2.4) * 0.25, 0.5, 0.55));
        it.pos.copy(ORB).multiplyScalar((1 - e) * (1 - e)).add(_m.multiplyScalar(2 * (1 - e) * e)).add(_b.copy(_p).multiplyScalar(e * e));
        it.scale = sc * easeBack(clamp01(a * 1.25)); it.ry = ry + (1 - e) * Math.PI * 1.15; it.op = op;
        m.scale.set(it.scale, it.scale * (0.08 + 0.92 * easeOut(clamp01(a * 1.5))), 1);
        mat.uReveal.value = clamp01((a - 0.15) / 0.75);
        it.streak.material.opacity = Math.sin(Math.PI * clamp01(a * 1.4)) * 0.75;
        it.streak.geometry.attributes.position.setXYZ(1, it.pos.x, it.pos.y, it.pos.z); it.streak.geometry.attributes.position.needsUpdate = true;
        it.glow.material.opacity = 0.6 * (1 - a) + 0.15;
      } else {
        const k = damp(it.held ? 16 : 7, dt);
        it.pos.lerp(_p, k); it.scale += (sc - it.scale) * k; it.ry += (ry - it.ry) * k; it.op += (op - it.op) * damp(6, dt);
        it.lift += ((hovered === i && focused < 0 && !it.held ? 0.06 : 0) - it.lift) * k;
        m.scale.setScalar(it.scale); mat.uReveal.value = 1; it.streak.material.opacity = 0;
        it.glow.material.opacity += (glow * 0.55 - it.glow.material.opacity) * k;
      }
      m.position.copy(it.pos); m.position.y += it.lift + (it.held ? 0 : Math.sin(t * 1.1 + i * 1.7) * 0.012);
      m.rotation.set(0, it.ry, 0); mat.uOpacity.value = it.op; mat.uGlow.value += (glow - mat.uGlow.value) * damp(8, dt);
      m.renderOrder = 10 + Math.round((m.position.z + 3) * 100);
    }
    if (items.length && !closingAt && focused < 0 && now - lastTouch > 90000 && !hasVideo()) clear();
    const keep = items.length || head.on || wave.userData.t0;
    if (!keep) { orb.visible = false; stream.visible = false; }
    renderer.render(scene, camera);
    tv.place(now);
    if (keep) requestAnimationFrame(frame); else running = false;
  }
  return {
    show, clear: () => clear(), select: n => select(n - 1), back, rotate, drag, release, fling, twist, hover, pick, grab, movePanel, dropPanel, throwPanel,
    explode, collapse, enlarge, has: () => items.length > 0 && !closingAt, get tv() { return hasVideo(); }, get tvSound() { return tv.sound; }, get focused() { return focused; }, get front() { return frontIndex(); },
    get hovered() { return hovered; }, get layout() { return layout; }, get count() { return items.length; },
    setHead(on) { head.on = on; if (!on) { head.tx = head.ty = 0; head.tz = 4; window.__jvSpin = { yaw: 0, pitch: 0 }; } if (on && !renderer) init(); activate(items.length > 0); },
    headAt(cx, cy, w) {
      head.tx = Math.max(-1.2, Math.min(1.2, (0.5 - cx) * 2.2)); head.ty = Math.max(-1, Math.min(1, (0.5 - cy) * 2));
      head.tz = Math.max(2.4, Math.min(7, 4 * 0.22 / Math.max(0.05, w)));
      window.__jvSpin = { yaw: -head.tx * 0.32, pitch: head.ty * 0.18 };
    },
  };
})();

// ============================================================
// GESTURES (MediaPipe, one webcam, off until he asks). Kept to five, each different enough not to be mistaken for another:
// move = point, pinch = open / put back, pinch and drag = spin the ring (or turn the globe), swipe left / right = next / previous,
// swipe down = close. A small gold pointer follows the knuckles; each gesture is named for a moment and gets a soft sound.
// The same camera also does head tracking for 3D mode.
// ============================================================
class OneEuro {        // smooths jitter when still, stays sharp when moving fast (Casiez et al.)
  constructor(minCut = 1.0, beta = 0.006, dCut = 1.0) { Object.assign(this, { minCut, beta, dCut, x: null, dx: 0, t: 0 }); }
  a(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  f(x, t) {
    if (this.x == null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, (t - this.t) / 1000); this.t = t;
    const dx = (x - this.x) / dt; this.dx += (dx - this.dx) * this.a(this.dCut, dt);
    this.x += (x - this.x) * this.a(this.minCut + this.beta * Math.abs(this.dx), dt); return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}
const sfx = (() => {          // tiny synthesised sounds, quiet
  let ac = null; const ctx = () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {} return ac; };
  function tone(f, dur, type = 'sine', vol = 0.035, f2 = f) {
    const a = ctx(); if (!a) return; const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
    o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, f0, f1, vol = 0.045) {
    const a = ctx(); if (!a) return; const n = Math.floor(a.sampleRate * dur), b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = a.createBufferSource(), bp = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime;
    s.buffer = b; bp.type = 'bandpass'; bp.Q.value = 1.2; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.connect(bp).connect(g).connect(a.destination); s.start(t);
  }
  return { tick: () => tone(1500, 0.05, 'sine', 0.03), back: () => tone(760, 0.1, 'triangle', 0.03, 420), whoosh: () => noise(0.32, 400, 2400, 0.045),
    close: () => noise(0.4, 2400, 200, 0.05), on: () => { tone(660, 0.22, 'sine', 0.03); setTimeout(() => tone(990, 0.26, 'sine', 0.026), 70); }, burst: () => noise(0.6, 200, 1800, 0.03) };
})();
window.__jvSfx = sfx;

const gestures = (() => {
  const box = el('div', null, '<video playsinline muted></video><canvas></canvas><span>Gestures on</span>'); box.id = 'pc-cam'; hud.appendChild(box);
  const ring = el('div', null, '<i></i>'); ring.id = 'pc-ring'; document.body.appendChild(ring);
  const toast = el('div'); toast.id = 'pc-gtoast'; document.body.appendChild(toast);
  const video = box.querySelector('video'), cv = box.querySelector('canvas'), cx = cv.getContext('2d'), label = box.querySelector('span');
  let files = null, lm = null, fd = null, stream = null, last = 0, tick = 0, opening = null, toastT = null, hintT = null;
  const needs = new Set(), VER = '0.10.14', CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  const fx = new OneEuro(), fy = new OneEuro();
  const S = { pinched: false, pinchN: 0, openN: 0, cur: null, hist: [], act: null, swipeAt: 0, lost: 0 };

  function say(text) {
    toast.textContent = text; toast.classList.add('on');
    if (S.cur) toast.style.transform = `translate(${S.cur.x}px, ${S.cur.y - 30}px) translate(-50%, -100%)`;
    clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 800);
  }
  function hint() {         // a reminder of the five, in the camera preview, for the first few seconds
    label.textContent = 'Pinch: open · Pinch + drag: spin · Swipe ←/→: next · Swipe ↓: close'; box.classList.add('hint');
    clearTimeout(hintT); hintT = setTimeout(() => { box.classList.remove('hint'); label.textContent = needs.has('head') ? 'Gestures + 3D' : 'Gestures on'; }, 7000);
  }

  async function start(kind = 'hands', quiet = false) {
    if (needs.has(kind)) return; needs.add(kind);
    try {
      const V = await import(`${CDN}/vision_bundle.mjs`);
      files = files || await V.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      if (kind === 'hands' && !lm) lm = await V.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.55, minTrackingConfidence: 0.5 });
      if (kind === 'head' && !fd) fd = await V.FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', delegate: 'GPU' },
        runningMode: 'VIDEO', minDetectionConfidence: 0.5 });
      if (!needs.has(kind)) return;
      if (!stream) await (opening = opening || openCam());
      if (!stream) throw new Error('camera closed');
      box.classList.toggle('on', needs.has('hands'));
      label.textContent = needs.has('hands') ? (needs.has('head') ? 'Gestures + 3D' : 'Gestures on') : '3D on';
      if (kind === 'hands') {
        if (!quiet) sfx.on();
        let seen = 0; try { seen = +localStorage.getItem('jv_gesture_hints') || 0; localStorage.setItem('jv_gesture_hints', seen + 1); } catch (e) {}
        if (!quiet || seen < 3) hint();          // the reminder: when asked for, and the first few automatic times
      }
    } catch (e) { console.warn('[CAMERA]', kind, e); needs.delete(kind); if (!needs.size) stopCam(); }
  }
  async function openCam() {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: { ideal: 30 } } });
      if (!needs.size) { st.getTracks().forEach(t => t.stop()); return; }
      stream = st; video.srcObject = st; await video.play(); cv.width = video.videoWidth; cv.height = video.videoHeight;
      requestAnimationFrame(loop);
    } finally { opening = null; }
  }
  function stop(kind = 'hands') {
    needs.delete(kind);
    if (kind === 'hands') { box.classList.remove('on', 'hint'); ring.classList.remove('on', 'pinch', 'over'); endAct(); }
    if (needs.has('head')) label.textContent = '3D on';
    if (!needs.size) stopCam();
  }
  function stopCam() { try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {} stream = null; box.classList.remove('on'); }

  function loop(now) {
    if (!stream) return;
    requestAnimationFrame(loop);
    if (now - last < 66 || video.readyState < 2) return;          // ~15 a second; with head tracking too they take turns
    last = now; tick++;
    const doHead = needs.has('head') && fd && (!needs.has('hands') || tick % 2), doHands = needs.has('hands') && lm && (!needs.has('head') || !(tick % 2));
    if (doHead) {
      const f = fd.detectForVideo(video, now).detections[0];
      if (f) { const b = f.boundingBox; holo.headAt((b.originX + b.width / 2) / video.videoWidth, (b.originY + b.height / 2) / video.videoHeight, b.width / video.videoWidth); }
    }
    if (doHands) {
      const res = lm.detectForVideo(video, now);
      if (desk.on) desk.feed(res.landmarks || [], res.handedness || res.handednesses || [], now); else feed(res.landmarks || [], now);   // the holo desk takes both hands
    }
  }

  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const scr = p => ({ x: Math.min(1, Math.max(0, (1 - p.x - 0.15) / 0.7)) * innerWidth, y: Math.min(1, Math.max(0, (p.y - 0.15) / 0.6)) * innerHeight });
  function endAct() {
    const a = S.act; S.act = null; ring.classList.remove('pinch');
    if (!a) return;
    if (a.kind === 'card') card.classList.remove('drag');
    if (a.kind === 'ring') holo.release();
  }

  function feed(lms, now) {
    cx.clearRect(0, 0, cv.width, cv.height);
    const h = lms[0];
    if (!h) {
      if (++S.lost > 4) { ring.classList.remove('on', 'pinch', 'over'); endAct(); S.pinched = false; S.hist = []; fx.reset(); fy.reset(); }
      return;
    }
    S.lost = 0;
    // the hand in the little camera preview only
    cx.strokeStyle = 'rgba(245,201,122,.8)'; cx.lineWidth = 2; cx.beginPath();
    for (const [a, b] of BONES) { cx.moveTo(h[a].x * cv.width, h[a].y * cv.height); cx.lineTo(h[b].x * cv.width, h[b].y * cv.height); } cx.stroke();
    // the pointer sits on the knuckles: it doesn't jump when the fingers pinch or open
    const k = scr({ x: (h[5].x + h[9].x) / 2, y: (h[5].y + h[9].y) / 2 });
    S.cur = { x: fx.f(k.x, now), y: fy.f(k.y, now) };
    ring.classList.add('on'); ring.style.transform = `translate(${S.cur.x}px, ${S.cur.y}px)`;
    S.hist.push({ t: now, x: S.cur.x, y: S.cur.y }); while (S.hist.length && now - S.hist[0].t > 300) S.hist.shift();
    const over = holo.has() ? holo.hover(S.cur.x, S.cur.y) >= 0 : false;
    ring.classList.toggle('over', over);

    // pinch, with a gap between "on" and "off" and two frames to confirm each, so it never flickers
    const size = d(h[0], h[9]) || 1e-3, pinch = d(h[4], h[8]) / size;
    if (!S.pinched) { S.pinchN = pinch < 0.3 ? S.pinchN + 1 : 0; if (S.pinchN >= 2) { S.pinched = true; S.openN = 0; pinchStart(now); } }
    else { S.openN = pinch > 0.48 ? S.openN + 1 : 0; if (S.openN >= 2) { S.pinched = false; S.pinchN = 0; pinchEnd(now); } }
    if (S.pinched) { pinchMove(now); return; }

    // swipes: a quick flat-hand move — sideways turns the ring (or switches face / globe), downwards closes
    const n = S.hist.length;
    if (n > 2 && now - S.swipeAt > 900) {
      const a = S.hist[0], b = S.hist[n - 1], dt = Math.max(0.05, (b.t - a.t) / 1000), vx = (b.x - a.x) / dt / innerWidth, vy = (b.y - a.y) / dt / innerHeight;
      if (Math.abs(vx) > 1.5 && Math.abs(vx) > Math.abs(vy) * 2) {
        S.swipeAt = now; S.hist = [];
        if (holo.has()) { holo.rotate(vx > 0 ? -1 : 1); say(vx > 0 ? 'Previous' : 'Next'); } else { globe.on ? globe.hide() : globe.show({}); say(globe.on ? 'Globe' : 'Face'); }
        sfx.whoosh();
      } else if (vy > 1.6 && vy > Math.abs(vx) * 2) {
        S.swipeAt = now; S.hist = [];
        if (feeds.on) { feeds.close(); sfx.close(); say('Closed'); }
        else if (holo.has() && holo.focused >= 0) { holo.back(); sfx.back(); say('Back'); }
        else if (holo.has()) { holo.clear(); sfx.close(); say('Closed'); }
        else if (cardKind) { hideCard(); sfx.close(); say('Closed'); }
        else if (globe.on) { globe.hide(); sfx.close(); say('Closed'); }
      }
    }
  }
  function pinchStart(now) {
    ring.classList.add('pinch');
    const onCard = document.elementsFromPoint(S.cur.x, S.cur.y).find(e => e.closest && e.closest('#pc-card.on'));
    if (onCard) { const cs = getComputedStyle(card); S.act = { kind: 'card', x: S.cur.x, y: S.cur.y, dx: parseFloat(cs.getPropertyValue('--dx')) || 0, dy: parseFloat(cs.getPropertyValue('--dy')) || 0 }; card.classList.add('drag'); }
    else if (holo.has()) S.act = { kind: 'tap', x: S.cur.x, y: S.cur.y, x0: S.cur.x, y0: S.cur.y, t0: now };
    else if (globe.on) S.act = { kind: 'globe', x: S.cur.x, y: S.cur.y, x0: S.cur.x, y0: S.cur.y, t0: now };
  }
  function pinchMove() {
    const a = S.act; if (!a) return;
    if (a.kind === 'card') { card.style.setProperty('--dx', `${a.dx + S.cur.x - a.x}px`); card.style.setProperty('--dy', `${a.dy + S.cur.y - a.y}px`); clearTimeout(cardTimer); }
    else if (a.kind === 'tap' && Math.abs(S.cur.x - a.x0) > 28) { a.kind = 'ring'; a.x = S.cur.x; say('Spin'); }       // a pinch that moves becomes a spin
    else if (a.kind === 'ring') { holo.drag(S.cur.x - a.x); a.x = S.cur.x; }
    else if (a.kind === 'globe') { globe.turn(S.cur.x - a.x, S.cur.y - a.y); a.x = S.cur.x; a.y = S.cur.y; }
  }
  function pinchEnd(now) {
    const a = S.act;
    if (a && a.kind === 'tap' && now - a.t0 < 700) {
      const before = holo.focused, i = holo.pick(S.cur.x, S.cur.y);
      if (i >= 0 && i !== before) { sfx.tick(); say('Open'); } else if (before >= 0) { sfx.back(); say('Back'); }
      S.act = null; ring.classList.remove('pinch'); return;
    }
    if (a && a.kind === 'globe' && now - a.t0 < 450 && Math.hypot(S.cur.x - a.x0, S.cur.y - a.y0) < 18 && globe.tapAt(S.cur.x, S.cur.y)) sfx.tick();
    endAct();
  }
  async function hands(n) { try { if (lm) await lm.setOptions({ numHands: n }); } catch (e) {} }
  return { start, stop, hands, get stream() { return stream; }, get on() { return needs.has('hands'); }, __feed: feed, __state: S };
})();

// ============================================================
// GESTURES SWITCH THEMSELVES ON when there's something to touch (panels, the globe, a card) and off 10 s after it's gone, so the
// webcam isn't running the rest of the time. "Gesture mode off" stops that (remembered); "gesture mode" turns it on and keeps it on.
// ============================================================
const autoGestures = (() => {
  let auto = true, manual = false, mine = false, offT = null;
  try { auto = localStorage.getItem('jv_gestures_auto') !== 'off'; } catch (e) {}
  const touchable = () => holo.has() || globe.on || !!cardKind || (window.__jvDesk && window.__jvDesk.on);
  function check() {
    if (manual || !auto) return;
    if (touchable()) { clearTimeout(offT); offT = null; if (!gestures.on) { mine = true; gestures.start('hands', true); } }
    else if (gestures.on && mine && !offT) offT = setTimeout(() => { offT = null; if (!touchable() && !manual && mine) { mine = false; gestures.stop('hands'); } }, 10000);
  }
  setInterval(check, 700);
  return {
    set(on) {
      try { localStorage.setItem('jv_gestures_auto', on ? 'on' : 'off'); } catch (e) {}
      auto = on; manual = on; mine = false; clearTimeout(offT); offT = null;
      if (on) gestures.start('hands'); else gestures.stop('hands');
    },
    get auto() { return auto; }, get manual() { return manual; }, check,
  };
})();

// ============================================================
// LIVE FEEDS: up to 4 YouTube live streams as glass windows (city webcams, live news, NASA), between the greeting/clock and the
// bottom bar. One main view at a time: feeds, the globe and the floating panels push each other away.
// ============================================================
const feeds = (() => {
  document.head.appendChild(el('style', null, `
    #pc-feeds { position: fixed; z-index: 15; left: 0; right: 0; display: none; justify-content: center; align-content: center; flex-wrap: wrap;
      gap: 14px; padding: 0 24px; pointer-events: none; opacity: 0; transition: opacity .5s var(--ease); }
    #pc-feeds.on { display: flex; }
    #pc-feeds.show { opacity: 1; }
    .pc-feed { pointer-events: auto; display: flex; flex-direction: column; border-radius: 16px; overflow: hidden; background: var(--glass);
      border: 1px solid var(--glass-hi); box-shadow: 0 18px 50px rgba(0,0,0,.55), 0 0 30px rgba(245,201,122,.08);
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); transform: translateY(14px) scale(.97); transition: transform .5s var(--ease); }
    #pc-feeds.show .pc-feed { transform: none; }
    .pc-feed .bar { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px 0 12px; font: 600 13px/1 'Saira', system-ui, sans-serif;
      color: var(--ice); letter-spacing: normal; text-transform: none; text-shadow: none; }
    .pc-feed .bar i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #ff4b3e; box-shadow: 0 0 8px #ff4b3e; animation: pcLive 1.6s ease-in-out infinite; }
    @keyframes pcLive { 50% { opacity: .35; } }
    .pc-feed .bar b { flex: none; font: 600 10.5px/1 'Saira', system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #1a1006;
      background: var(--holo); padding: 4px 7px; border-radius: 999px; }
    .pc-feed .bar span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pc-feed .bar button { flex: none; width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--mist);
      font: 500 18px/1 system-ui, sans-serif; cursor: pointer; padding: 0; letter-spacing: normal; text-shadow: none; }
    .pc-feed .bar button:hover { background: rgba(255,214,150,.12); color: var(--ice); }
    .pc-feed iframe { display: block; border: 0; width: 100%; flex: 1; background: #000; }
    #pc-feeds-close { position: fixed; z-index: 16; display: none; pointer-events: auto; padding: 8px 16px; border-radius: 999px;
      background: var(--glass); border: 1px solid var(--glass-hi); color: var(--live); font: 600 13px/1.2 'Saira', system-ui, sans-serif;
      letter-spacing: normal; text-transform: none; text-shadow: none; cursor: pointer; transform: translateX(-50%); left: 50%; }
    #pc-feeds-close.on { display: block; }
  `));
  const wall = el('div'); wall.id = 'pc-feeds'; document.body.appendChild(wall);
  const closeAll = el('button', null, 'Close feeds'); closeAll.id = 'pc-feeds-close'; closeAll.type = 'button'; document.body.appendChild(closeAll);
  let list = [];
  // the room left between the greeting / clock on top and the gauges / status pill at the bottom
  const TOP = () => { const m = rectOf('pc-music');     // the music card shrinks to its slim bar (58 px) while the feeds are up
    return Math.max(120, ($('pc-clock')?.getBoundingClientRect().bottom || 120) + 14, m ? m.top + 58 + 14 : 0); };
  const rectOf = id => { const e = $(id); if (!e || getComputedStyle(e).display === 'none') return null; const r = e.getBoundingClientRect(); return r.height ? r : null; };
  let area = { top: 120, bottom: 140, inset: 24 };
  function layout() {
    if (!list.length) return;
    const n = list.length, gap = 14, bar = 34, top = TOP(), pill = rectOf('pc-pill'), gauges = rectOf('pc-gauges'), cam = rectOf('pc-cam');
    const above = r => r ? innerHeight - r.top + 14 : 96;
    // two ways to use the screen: full width above everything at the bottom, or narrower (between the gauges on the left and the
    // camera preview on the right) going down to the status pill. Every row/column split of each; the biggest windows win.
    const side = Math.max(24, gauges ? gauges.right + 14 : 0, cam ? innerWidth - cam.left + 14 : 0);
    const options = [{ inset: 24, bottom: Math.max(above(pill) + 34, above(gauges), above(cam)) + 44 }, { inset: side, bottom: above(pill) + 44 + 34 }];
    let w = 0;
    for (const o of options) for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), W = innerWidth - 2 * o.inset - gap * (cols - 1), H = innerHeight - top - o.bottom - gap * (rows - 1);
      const fit = Math.min(W / cols, ((H / rows) - bar) * 16 / 9, n === 1 ? 1100 : 760);
      if (fit > w) { w = fit; area = { top, bottom: o.bottom, inset: o.inset }; }
    }
    w = Math.max(160, Math.floor(w));
    wall.style.top = area.top + 'px'; wall.style.bottom = area.bottom + 'px'; wall.style.padding = `0 ${area.inset}px`;
    for (const t of wall.children) { t.style.width = w + 'px'; t.style.height = (w * 9 / 16 + bar) + 'px'; }
    closeAll.style.top = (innerHeight - area.bottom + 8) + 'px';
  }
  function remove(tile) {
    tile.remove(); list = [...wall.children];
    if (!list.length) close(); else layout();
  }
  function show(msg) {
    if (window.__jvGlobe && window.__jvGlobe.on) window.__jvGlobe.hide();
    if (window.__jvHolo && window.__jvHolo.has()) window.__jvHolo.clear();
    wall.innerHTML = '';
    for (const f of (msg.feeds || []).slice(0, 4)) {
      // only Windy's own camera player, or a YouTube video id, ever goes into the address
      const src = /^https:\/\/webcams\.windy\.com\/[\w\/.-]+$/.test(f.src || '') ? f.src
        : /^[\w-]{11}$/.test(f.id || '') ? `https://www.youtube.com/embed/${f.id}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1` : null;
      if (!src) continue;
      const tag = f.src && !f.live ? '<b>Timelapse</b>' : '<i></i>';
      const t = el('div', 'pc-feed', `<div class="bar">${tag}<span>${esc(f.title || msg.title || 'Live')}</span><button type="button" aria-label="Close this feed">×</button></div>`);
      const fr = el('iframe'); fr.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; fr.allowFullscreen = true;
      fr.referrerPolicy = 'strict-origin-when-cross-origin'; fr.title = f.title || 'Live feed';
      fr.src = src;
      t.appendChild(fr); t.querySelector('button').onclick = () => remove(t);
      wall.appendChild(t);
    }
    list = [...wall.children];
    if (!list.length) return;
    wall.classList.add('on'); closeAll.classList.add('on'); layout();
    requestAnimationFrame(() => wall.classList.add('show'));
    window.__jvFaceOff = true;          // the face is behind the wall: don't spend the processor drawing it
  }
  function close() {
    if (!wall.classList.contains('on')) return;
    wall.classList.remove('show'); closeAll.classList.remove('on');
    setTimeout(() => { if (!wall.classList.contains('show')) { wall.classList.remove('on'); wall.innerHTML = ''; list = []; } }, 500);
    window.__jvFaceOff = !!((window.__jvGlobe && window.__jvGlobe.on) || (window.__jvHolo && window.__jvHolo.has()));
  }
  closeAll.onclick = close;
  addEventListener('resize', layout);
  return { show, close, get on() { return wall.classList.contains('on') && list.length > 0; } };
})();

// ============================================================
// MUSIC: a now-playing card under the clock. "play X" fills a queue (the song, then its YouTube Music radio); it plays through,
// skipping anything the owner won't let play inside other apps. Shrinks to a slim bar while the globe, panels or feeds are up.
// ============================================================
const music = (() => {
  document.head.appendChild(el('style', null, `
    #pc-music { position: absolute; right: 48px; top: 150px; width: 356px; border-radius: 18px; overflow: hidden; pointer-events: auto; display: none;
      background: var(--glass); border: 1px solid var(--glass-hi); box-shadow: 0 18px 50px rgba(0,0,0,.5);
      -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); opacity: 0; transform: translateY(-8px); transition: opacity .4s var(--ease), transform .4s var(--ease); }
    #pc-music.on { display: block; }
    #pc-music.show { opacity: 1; transform: none; }
    #pc-music .vid { height: 200px; overflow: hidden; background: #000; transition: height .45s var(--ease); }
    #pc-music.slim .vid { height: 0; }
    #pc-music .vid .yt, #pc-music .vid .yt > *, #pc-music .vid .sp { display: block; width: 356px; height: 200px; border: 0; }
    #pc-music .vid .sp { display: none; height: 152px; } #pc-music .vid .sp iframe { display: block; width: 100%; height: 152px; border: 0; }
    #pc-music.spotify .vid { height: 152px; } #pc-music.spotify .vid .yt { display: none; } #pc-music.spotify .vid .sp { display: block; }
    #pc-music.spotify.slim .vid { height: 0; }
    #pc-music .row { display: flex; align-items: center; gap: 6px; height: 56px; padding: 0 8px 0 14px; }
    #pc-music .txt { flex: 1; min-width: 0; }
    #pc-music .t, #pc-music .a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #pc-music .t { font: 600 14px/1.25 'Saira', system-ui, sans-serif; color: var(--ice); }
    #pc-music .a { font: 400 12.5px/1.3 'Saira', system-ui, sans-serif; color: var(--mist); }
    #pc-music.slim.paused { opacity: 0; pointer-events: none; }     /* paused while the news or the globe has the screen: out of the way */
    #pc-music button { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--ice); cursor: pointer;
      font: 500 15px/1 system-ui, sans-serif; padding: 0; letter-spacing: normal; text-shadow: none; }
    #pc-music button:hover { background: rgba(255,214,150,.12); }
    #pc-music button:focus-visible { outline: 2px solid var(--holo); outline-offset: -2px; }
    @media (max-width: 900px) { #pc-music { right: 24px; top: 110px; width: 300px; } #pc-music .vid .yt, #pc-music .vid .yt > *, #pc-music .vid .sp { width: 300px; } }
  `));
  const card = el('div', null, `<div class="vid"><div class="yt"><div></div></div><div class="sp"><div></div></div></div><div class="row"><div class="txt"><div class="t"></div><div class="a"></div></div>
    <button type="button" data-k="previous" aria-label="Previous song"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button><button type="button" data-k="toggle" aria-label="Pause"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>
    <button type="button" data-k="next" aria-label="Next song"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button><button type="button" data-k="stop" aria-label="Close the music"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button></div>`);
  const ICON = { play: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 5v14l12-7z"/></svg>', pause: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>' };
  card.id = 'pc-music'; card.setAttribute('role', 'region'); card.setAttribute('aria-label', 'Music'); hud.appendChild(card);
  const tEl = card.querySelector('.t'), aEl = card.querySelector('.a'), toggle = card.querySelector('[data-k=toggle]');
  let player = null, queue = [], at = 0, k = 0, vol = 70, playing = false, dead = 0, altAsked = false, windowTried = false;
  let src = 'yt', sp = null, spWant = '', spLast = { pos: 0, dur: 0 };     // src: whose player this queue plays in (YouTube or Spotify)
  const post = body => fetch('/music/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  const report = (error = '') => { const t = queue[at] || {}; post({ title: t.title || '', artist: t.artist || '', playing, error }); };
  const level = () => player && player.setVolume && player.setVolume(ducked ? Math.round(vol * 0.15) : vol);
  duckers.add(level);
  const okId = id => /^[\w-]{11}$/.test(id || '');          // only a YouTube video id ever goes into the address
  const okSp = u => /^spotify:track:[A-Za-z0-9]{22}$/.test(u || '');
  const idsOf = t => ((t && t.ids && t.ids.length) ? t.ids : [t && t.id]).filter(okId);
  const usable = t => src === 'sp' ? !!(t && (okSp(t.sp) || t.title)) : idsOf(t).length > 0;
  function paint() {
    const t = queue[at] || {}; tEl.textContent = t.title || ''; aEl.textContent = t.artist || '';
    toggle.innerHTML = playing ? ICON.pause : ICON.play; toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    card.classList.toggle('paused', !playing); card.classList.toggle('spotify', src === 'sp');
  }
  function load() {
    paint();
    if (src === 'sp') { loadSp(); return; }
    const id = idsOf(queue[at])[k]; if (id && player && player.loadVideoById) player.loadVideoById(id);
  }
  function go(i) {
    if (!queue.length) return;
    at = (i + queue.length) % queue.length; k = 0; altAsked = false; load();
  }

  // ---- Spotify's own player (Premium users signed in to Spotify in Jarvis's window hear whole songs; others get 30 s previews) ----
  let spReady = null;
  const loadSpApi = () => spReady || (spReady = new Promise(res => {
    window.onSpotifyIframeApiReady = api => res(api);
    document.head.appendChild(Object.assign(el('script'), { src: 'https://open.spotify.com/embed/iframe-api/v1', async: true }));
  }));
  async function loadSp() {
    const t = queue[at]; if (!t) return;
    if (!okSp(t.sp)) {            // a similar song found on YouTube Music: look it up on Spotify first
      try { t.sp = (await (await fetch('/music/sp?q=' + encodeURIComponent(`${t.title} ${t.artist || ''}`.trim()))).json()).uri || ''; } catch (e) {}
      if (queue[at] !== t) return;
      if (!okSp(t.sp)) { if (++dead < 4) go(at + 1); return; }
    }
    spWant = t.sp; spLast = { pos: 0, dur: 0 };
    if (sp) {
      sp.loadUri(t.sp);
      setTimeout(() => { if (spWant === t.sp && !playing) sp.play(); }, 1500);     // in case the new song's 'ready' doesn't come
      return;
    }
    const api = await loadSpApi();
    api.createController(card.querySelector('.sp > div'), { uri: t.sp, width: '100%', height: 152 }, c => {
      sp = c;
      sp.addListener('ready', () => { if (spWant) sp.play(); });
      sp.addListener('playback_update', e => {
        const d = (e && e.data) || {}, dur = d.duration || 0, pos = d.position || 0;
        if (dur > 0 && dur <= 30500 && !d.isPaused && spWant) {        // only a 30-second preview: not signed in to Spotify Premium here
          spWant = ''; sp.pause(); const t = queue[at] || {};
          post({ preview: true, title: t.title || '', artist: t.artist || '' }); stop();
          if (window.__jvSay) window.__jvSay("Spotify is only giving me 30-second previews, so it's coming from YouTube Music instead. Say connect Spotify to sign in, sir.");
          return;
        }
        if (d.isPaused && spLast.dur > 0 && spLast.pos > spLast.dur - 2500) { spLast = { pos: 0, dur: 0 }; go(at + 1); return; }   // the song ended
        spLast = { pos, dur };
        const p = !d.isPaused && !d.isBuffering; if (p) dead = 0;
        if (p !== playing) { playing = p; paint(); report(); }
      });
    });
  }

  // this upload won't play inside Jarvis (labels often allow only YouTube itself): its other uploads, then a lyric video, then the next song
  async function failed() {
    const t = queue[at], ids = idsOf(t);
    if (k + 1 < ids.length) { k++; load(); return; }
    if (t && !altAsked) {
      altAsked = true;
      try {
        const r = await (await fetch('/music/alt?q=' + encodeURIComponent(`${t.title} ${t.artist || ''}`.trim()))).json();
        const more = (r.ids || []).filter(i => okId(i) && !ids.includes(i));
        if (more.length && queue[at] === t) { t.ids = ids.concat(more); k = ids.length; load(); return; }
      } catch (e) {}
    }
    // nothing of this song would play in here: YouTube Music's own window plays it instead (and the rest of the session's music)
    if (t && okId(t.id) && !windowTried) {
      windowTried = true;
      try {
        const r = await (await fetch('/music/window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }) })).json();
        if (r.ok) {
          stop(); if (window.__jvSay) window.__jvSay("YouTube won't play it inside Jarvis, so it's playing in a YouTube Music window, sir.");
          return;
        }
      } catch (e) {}
    }
    if (++dead >= 3) {          // three songs in a row with nothing playable: say so instead of going quiet
      const msg = "YouTube won't let these songs play inside Jarvis.";
      stop(msg); if (window.__jvSay) window.__jvSay(msg + ' Try another song or artist, sir.');
      return;
    }
    go(at + 1);
  }
  async function play(list, from) {
    if (src === 'yt' && from === 'sp') { try { player && player.stopVideo(); } catch (e) {} }
    if (src === 'sp' && from !== 'sp') { spWant = ''; try { sp && sp.pause(); } catch (e) {} }
    src = from === 'sp' ? 'sp' : 'yt';
    queue = list.filter(usable); at = 0; k = 0; dead = 0; altAsked = false;
    if (!queue.length) return;
    if (window.__jvHolo && window.__jvHolo.tvSound) window.__jvHolo.clear();     // the news stops for the music (webcams are silent: they stay)
    card.classList.add('on'); place(); slim(); requestAnimationFrame(() => card.classList.add('show')); paint();
    if (src === 'sp' || player) { load(); return; }
    const YT = await loadYT();
    player = new YT.Player(card.querySelector('.vid .yt > div'), { width: 356, height: 200, videoId: idsOf(queue[0])[0],
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => { level(); if (src !== 'yt') return; if (idsOf(queue[at])[k] !== idsOf(queue[0])[0]) load(); else player.playVideo(); },
        onStateChange: e => {
          if (src !== 'yt') return;
          if (e.data === YT.PlayerState.ENDED) { go(at + 1); return; }
          const p = e.data === YT.PlayerState.PLAYING; if (p) dead = 0;
          if (p !== playing && e.data !== YT.PlayerState.BUFFERING) { playing = p; paint(); report(); }
        },
        onError: e => {      // tell the log why (101/150: the owner blocks other apps, 153: player setup), then try the next upload
          if (src !== 'yt') return;
          post({ code: e && e.data, id: idsOf(queue[at])[k] || '' });
          failed();
        },
      } });
  }
  function stop(error = '') {
    playing = false; report(error); queue = []; card.classList.remove('show');
    try { player && player.stopVideo(); } catch (e) {}
    spWant = ''; try { sp && sp.pause(); } catch (e) {}
    setTimeout(() => { if (!card.classList.contains('show')) card.classList.remove('on'); }, 400);
  }
  function cmd(c) {
    if (!queue.length || (src === 'yt' && !player)) return;
    if (c === 'next') { go(at + 1); return; } if (c === 'previous') { go(at - 1); return; } if (c === 'stop') { stop(); return; }
    if (src === 'sp') {               // Spotify's player has no volume control: louder/quieter go to the PC's volume (the server does that)
      if (!sp) return;
      if (c === 'pause') sp.pause(); else if (c === 'resume') sp.resume(); else if (c === 'toggle') sp.togglePlay();
      return;
    }
    if (c === 'pause') player.pauseVideo(); else if (c === 'resume') player.playVideo();
    else if (c === 'toggle') playing ? player.pauseVideo() : player.playVideo();
    else if (c === 'louder' || c === 'quieter') { vol = Math.max(10, Math.min(100, vol + (c === 'louder' ? 15 : -15))); level(); }
  }
  card.addEventListener('click', e => { const b = e.target.closest('button'); if (b) cmd(b.dataset.k); });
  const place = () => { const c = $('pc-clock'); card.style.top = Math.round((c ? c.getBoundingClientRect().bottom : 120) + 18) + 'px'; };   // just under the clock
  addEventListener('resize', place);
  // the slim bar while something else needs the room (and while the news is on, the music waits)
  function slim() { card.classList.toggle('slim', !!(document.body.classList.contains('pc-holo-on') || (window.__jvGlobe && window.__jvGlobe.on) || (window.__jvFeeds && window.__jvFeeds.on))); }
  setInterval(() => { if (card.classList.contains('on')) slim(); }, 700);
  const append = list => { if (queue.length) queue.push(...list.filter(usable)); };      // the similar songs, a moment after the first
  return { msg: m => m.cmd === 'play' ? play(m.queue || [], m.src) : m.cmd === 'append' ? append(m.queue || []) : cmd(m.cmd), pause: () => cmd('pause'), get on() { return card.classList.contains('show'); },
           get playing() { return playing; } };
})();

// ============================================================
// HOLO DESK (mirror mode): the camera fills the screen like a mirror and the panels float in the air around him. Fingertips are
// the pointers (both hands): pinch a panel to pick it up and move it, pinch its × (or throw it away) to close it, pinch and drag a
// list to scroll it, a quick pinch on a story or email opens it. Hold an open hand still to bring up a round menu at that hand;
// the row of buttons along the bottom opens the rest. Mouse works too.
// ============================================================
const desk = (() => {
  document.head.appendChild(el('style', null, `
    #pc-desk-cam { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); z-index: 2; opacity: 0;
      pointer-events: none; transition: opacity .8s var(--ease); filter: saturate(.85) brightness(.82) contrast(1.05); }
    #pc-desk-tint { position: fixed; inset: 0; z-index: 2; pointer-events: none; opacity: 0; transition: opacity .8s var(--ease);
      background: radial-gradient(ellipse at 50% 45%, rgba(10,18,30,0) 40%, rgba(6,10,18,.55) 100%), linear-gradient(rgba(40,90,140,.10), rgba(40,90,140,.10)); }
    body.pc-desk-on #pc-desk-cam, body.pc-desk-on #pc-desk-tint { opacity: 1; }
    #pc-desk { position: fixed; inset: 0; z-index: 4; pointer-events: none; display: none; }
    body.pc-desk-on #pc-desk { display: block; }
    body.pc-desk-on #pc-cam { opacity: 0 !important; }
    body.pc-desk-on #pc-subs { bottom: 166px; }
    #pc-desk canvas.hands { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 30; }
    .pc-dp { position: absolute; width: 330px; max-height: min(440px, calc(100vh - 300px)); display: flex; flex-direction: column; border-radius: 16px; overflow: hidden; pointer-events: auto;
      background: rgba(8,16,28,.62); border: 1px solid rgba(120,200,255,.38); box-shadow: 0 0 0 1px rgba(120,200,255,.08), 0 0 28px rgba(80,170,255,.22), 0 18px 40px rgba(0,0,0,.45);
      -webkit-backdrop-filter: blur(10px) saturate(1.2); backdrop-filter: blur(10px) saturate(1.2); color: #e6f4ff; font: 400 13.5px/1.4 'Saira', system-ui, sans-serif;
      transform-origin: 50% 50%; animation: pc-dp-in .45s var(--ease); transition: box-shadow .2s, transform .2s; user-select: none; touch-action: none; }
    @keyframes pc-dp-in { from { opacity: 0; transform: scale(.82); } }
    .pc-dp.held { box-shadow: 0 0 0 1.5px rgba(150,220,255,.9), 0 0 40px rgba(90,190,255,.45), 0 24px 50px rgba(0,0,0,.5); transform: scale(1.03); z-index: 5; }
    .pc-dp.gone { transition: transform .45s ease-in, opacity .45s; opacity: 0; }
    .pc-dp header { display: flex; align-items: center; gap: 8px; padding: 9px 8px 8px 14px; border-bottom: 1px solid rgba(120,200,255,.18); cursor: grab; }
    .pc-dp header b { flex: 1; font: 600 12px/1 'Saira', system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #9fd6ff; }
    .pc-dp header button { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,120,110,.5); background: rgba(255,90,80,.16); color: #ffb3ad;
      font: 600 15px/1 system-ui, sans-serif; cursor: pointer; padding: 0; }
    .pc-dp .body { overflow-y: auto; padding: 10px 14px 14px; scrollbar-width: none; }
    .pc-dp .body::-webkit-scrollbar { display: none; }
    .pc-dp .it { display: flex; gap: 10px; padding: 9px 8px; margin: 0 -6px; border-radius: 10px; cursor: pointer; }
    .pc-dp .it + .it { border-top: 1px solid rgba(120,200,255,.1); }
    .pc-dp .it:hover, .pc-dp .it.hot { background: rgba(120,200,255,.12); }
    .pc-dp .it img { width: 64px; height: 48px; object-fit: cover; border-radius: 6px; flex: none; background: #0b1622; }
    .pc-dp .it .tt { font-weight: 600; color: #f1f9ff; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .pc-dp .it .sm, .pc-dp .sm { font-size: 11.5px; color: #8fb6d6; margin-top: 2px; }
    .pc-dp .big { font: 600 54px/1 'Saira', system-ui, sans-serif; color: #fff; letter-spacing: -.02em; }
    .pc-dp .row { display: flex; justify-content: space-between; gap: 8px; }
    .pc-dp .chips { display: flex; gap: 6px; margin-top: 12px; overflow-x: auto; scrollbar-width: none; }
    .pc-dp .chip { flex: none; min-width: 52px; text-align: center; padding: 7px 4px; border-radius: 10px; background: rgba(120,200,255,.1); }
    .pc-dp .chip b { display: block; font-size: 15px; color: #fff; }
    .pc-dp .hero { width: 100%; height: 150px; object-fit: cover; border-radius: 10px; margin-bottom: 10px; background: #0b1622; }
    .pc-dp p { margin: 8px 0 0; color: #d7ebfa; }
    .pc-dp .ctl { display: flex; justify-content: center; gap: 12px; margin-top: 14px; }
    .pc-dp .ctl button { width: 46px; height: 46px; border-radius: 50%; border: 1px solid rgba(120,200,255,.45); background: rgba(120,200,255,.12); color: #e6f4ff;
      font: 600 16px/1 system-ui, sans-serif; cursor: pointer; }
    #pc-dock { position: absolute; z-index: 100000; left: 50%; bottom: 84px; transform: translateX(-50%); display: flex; gap: 10px; padding: 9px 12px; border-radius: 999px; pointer-events: auto;
      background: rgba(8,16,28,.5); border: 1px solid rgba(120,200,255,.3); box-shadow: 0 0 24px rgba(80,170,255,.18); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    #pc-dock button { position: relative; width: 48px; height: 48px; border-radius: 50%; border: 1px solid rgba(120,200,255,.5); background: rgba(120,200,255,.1); color: #bfe6ff;
      cursor: pointer; padding: 0; display: grid; place-items: center; transition: transform .15s, background .15s, box-shadow .15s; }
    #pc-dock button svg { width: 22px; height: 22px; }
    #pc-dock button.hot, #pc-dock button:hover { background: rgba(120,200,255,.28); box-shadow: 0 0 16px rgba(120,200,255,.55); transform: translateY(-3px); }
    #pc-dock button.press { transform: scale(.9); background: rgba(160,225,255,.5); }
    #pc-dock button.red { border-color: rgba(255,120,110,.6); background: rgba(255,90,80,.16); color: #ffb3ad; }
    #pc-dock button i { position: absolute; top: 54px; left: 50%; transform: translateX(-50%); font: 500 10.5px/1 'Saira', system-ui, sans-serif; letter-spacing: .06em;
      color: #9fd6ff; white-space: nowrap; font-style: normal; opacity: 0; transition: opacity .15s; }
    #pc-dock button.hot i, #pc-dock button:hover i { opacity: 1; }
    .pc-radial { position: absolute; z-index: 100001; width: 230px; height: 230px; margin: -115px 0 0 -115px; pointer-events: none; animation: pc-rad-in .35s var(--ease); }
    @keyframes pc-rad-in { from { opacity: 0; transform: scale(.4) rotate(-40deg); } }
    .pc-radial .disc { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle, rgba(70,150,230,.22) 0 30%, rgba(30,70,120,.35) 31% 64%, rgba(30,70,120,0) 65%);
      border: 1px solid rgba(120,200,255,.35); box-shadow: 0 0 30px rgba(80,170,255,.25) inset; }
    .pc-radial button { position: absolute; width: 50px; height: 50px; margin: -25px 0 0 -25px; border-radius: 50%; border: 1px solid rgba(120,200,255,.6);
      background: rgba(10,30,52,.85); color: #bfe6ff; display: grid; place-items: center; padding: 0; pointer-events: auto; cursor: pointer; transition: transform .15s, background .15s; }
    .pc-radial button svg { width: 22px; height: 22px; }
    .pc-radial button.hot, .pc-radial button:hover { background: rgba(70,190,120,.85); color: #fff; transform: scale(1.15); }
    .pc-radial b { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font: 600 10px/1.1 'Saira', system-ui, sans-serif; letter-spacing: .12em; color: #9fd6ff; text-align: center; }
  `));
  const I = {        // line icons
    news: '<path d="M4 5h13v14H5a1 1 0 0 1-1-1zM17 9h3v9a1 1 0 0 1-1 1h-2M7 9h7M7 12h7M7 15h4"/>',
    weather: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11 3.5 3.5 0 0 0 7 18z"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    email: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4 7l8 6 8-6"/>',
    music: '<path d="M9 17V6l10-2v11"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="15" r="2"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
    cams: '<rect x="3.5" y="7" width="12" height="10" rx="2"/><path d="M15.5 11l5-3v8l-5-3"/>',
    clear: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    exit: '<path d="M14 5h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h9"/>',
  };
  const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;
  const NAMES = { news: 'News', weather: 'Weather', clock: 'Clock', email: 'Email', music: 'Music', globe: 'Globe', cams: 'Cameras', clear: 'Clear all', exit: 'Exit desk' };

  const cam = el('video'); cam.id = 'pc-desk-cam'; cam.muted = true; cam.playsInline = true; $('three').after(cam);
  const tint = el('div'); tint.id = 'pc-desk-tint'; cam.after(tint);
  const root = el('div'); root.id = 'pc-desk'; document.body.appendChild(root);
  const dock = el('div'); dock.id = 'pc-dock'; root.appendChild(dock);
  ['news', 'weather', 'clock', 'email', 'music', 'globe', 'cams', 'clear', 'exit'].forEach(k => {
    const b = el('button', k === 'clear' || k === 'exit' ? 'red' : '', `${svg(k)}<i>${NAMES[k]}</i>`); b.type = 'button'; b.dataset.k = k; b.setAttribute('aria-label', NAMES[k]); dock.appendChild(b);
  });
  const hc = el('canvas', 'hands'); root.appendChild(hc); const hx = hc.getContext('2d');
  let open = false, z = 10, radial = null;

  // ---- panels ----
  const panels = new Set();
  function place(p, x, y) {
    const r = p.getBoundingClientRect(), w = r.width || 330, h = r.height || 200;
    p.style.left = Math.round(clamp(x, 8, innerWidth - w - 8)) + 'px'; p.style.top = Math.round(clamp(y, 8, innerHeight - Math.min(h, 200) - 8)) + 'px';
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function freeSpot(near) {     // the spot a new panel covers least of the others, the greeting, the clock and the dock (near a hand if one opened it)
    const W = 330, Hh = Math.min(440, innerHeight - 300), keep = ['pc-hello', 'pc-clock', 'pc-ambient', 'pc-dock'].map(id => $(id)).filter(Boolean).map(e => e.getBoundingClientRect())
      .filter(r => r.width).map(r => ({ left: r.left - 14, right: r.right + 14, top: r.top - 14, bottom: r.bottom + 14 }));
    const boxes = [...[...panels].map(e => e.getBoundingClientRect()), ...keep];
    let best = null;
    for (let y = 120; y <= Math.max(120, innerHeight - Hh - 150); y += 24) for (let x = 16; x <= innerWidth - W - 16; x += 24) {
      let cost = 0;
      for (const r of boxes) cost += Math.max(0, Math.min(x + W, r.right) - Math.max(x, r.left)) * Math.max(0, Math.min(y + Hh, r.bottom) - Math.max(y, r.top));
      cost += near ? Math.hypot(x + W / 2 - near.x, y + 60 - near.y) * 20 : Math.hypot(x + W / 2 - innerWidth / 2, y - innerHeight * 0.25) * 4;
      if (!best || cost < best.cost) best = { x, y, cost };
    }
    return best || { x: innerWidth / 2 - W / 2, y: 120 };
  }
  function panel(kind, title, html, at) {
    const spot = freeSpot(at);
    const p = el('div', 'pc-dp', `<header><b>${esc(title)}</b><button type="button" data-x aria-label="Close">×</button></header><div class="body">${html}</div>`);
    p.dataset.kind = kind; p.style.zIndex = ++z; root.appendChild(p); panels.add(p);
    place(p, spot.x, spot.y); return p;
  }
  function close(p, flyX = 0, flyY = 0) {
    if (!p || !panels.has(p)) return; panels.delete(p);
    p.classList.add('gone'); p.style.transform = `translate(${flyX}px, ${flyY}px) scale(.7) rotate(${flyX / 40}deg)`;
    setTimeout(() => p.remove(), 460); sfx.close();
  }
  const clearAll = () => [...panels].forEach((p, i) => setTimeout(() => close(p, 0, 60), i * 60));
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return !t ? '' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const img = u => u ? `/holo/img?u=${encodeURIComponent(u)}` : '';
  async function data(kind, extra = '') { const r = await fetch(`/desk/data?kind=${kind}${extra}`); return r.json(); }

  async function add(kind, at) {
    if (kind === 'clear') { clearAll(); return; }
    if (kind === 'exit') { hide(); return; }
    if (kind === 'globe' || kind === 'cams') {          // the big views: leave the desk for them
      hide(); fetch('/desk/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) }).catch(() => {}); return;
    }
    sfx.whoosh();
    if (kind === 'clock') {
      const p = panel('clock', 'Clock', '<div class="big"></div><div class="sm d"></div><div class="chips"></div>', at), zones = [['Lagos', 'Africa/Lagos'], ['London', 'Europe/London'], ['New York', 'America/New_York'], ['Dubai', 'Asia/Dubai'], ['Tokyo', 'Asia/Tokyo']];
      const tick = () => {
        if (!panels.has(p)) return clearInterval(t); const n = new Date();
        p.querySelector('.big').textContent = n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        p.querySelector('.d').textContent = n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        p.querySelector('.chips').innerHTML = zones.map(([c, tz]) => `<div class="chip"><b>${n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz })}</b><span class="sm">${c}</span></div>`).join('');
      }, t = setInterval(tick, 1000); tick(); return;
    }
    if (kind === 'music') {
      const m = window.__jvMusic, p = panel('music', 'Music', `<div class="tt" style="font-size:16px;font-weight:600"></div><div class="sm a"></div>
        <div class="ctl"><button type="button" data-m="previous" aria-label="Previous">⏮︎</button><button type="button" data-m="toggle" aria-label="Play or pause">⏯︎</button><button type="button" data-m="next" aria-label="Next">⏭︎</button></div>`, at);
      const paint = () => { if (!panels.has(p)) return clearInterval(t); const card = $('pc-music');
        p.querySelector('.tt').textContent = card && card.classList.contains('show') ? card.querySelector('.t').textContent : 'Nothing playing';
        p.querySelector('.a').textContent = card && card.classList.contains('show') ? card.querySelector('.a').textContent : 'Say "play" and a song or artist'; }, t = setInterval(paint, 1500);
      paint(); p.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b && m) m.msg({ cmd: b.dataset.m }); }); return;
    }
    const p = panel(kind, NAMES[kind], '<div class="sm">Loading…</div>', at), body = p.querySelector('.body');
    try {
      const d = await data(kind);
      if (d.error) { body.innerHTML = `<div class="sm">${esc(d.error)}</div>`; return; }
      if (kind === 'weather') {
        body.innerHTML = `<div class="row"><div><div class="big">${esc(d.temp)}°</div><div style="font-size:16px;margin-top:4px">${esc(d.desc)}</div><div class="sm">${esc(d.place || '')}</div></div>
          <div class="sm" style="text-align:right">Feels ${esc(d.feels)}°<br>Humidity ${esc(d.humidity)}%<br>Wind ${esc(d.wind)} km/h</div></div>
          <div class="chips">${(d.hours || []).map(h => `<div class="chip"><b>${esc(h.t)}°</b><span class="sm">${esc(h.at)}</span></div>`).join('')}</div>
          <div class="chips">${(d.days || []).map(h => `<div class="chip" style="min-width:86px"><b>${esc(h.hi)}° / ${esc(h.lo)}°</b><span class="sm">${esc(h.day)}</span></div>`).join('')}</div>`;
      } else {          // news and email: a list to scroll; a story or an email opens on its own panel
        body.innerHTML = (d.items || []).map((it, i) => `<div class="it" data-i="${i}">${it.image ? `<img src="${img(it.image)}" alt="">` : ''}<div><div class="tt">${esc(it.title)}</div>
          <div class="sm">${esc(it.source || '')}${it.when ? ' · ' + esc(ago(it.when * 1000)) : ''}</div></div></div>`).join('') || '<div class="sm">Nothing new.</div>';
        p._items = d.items || [];
      }
    } catch (e) { body.innerHTML = '<div class="sm">Couldn\'t load that just now.</div>'; }
  }
  async function openItem(p, i, at) {        // "pick up" a story or an email
    const it = (p._items || [])[i]; if (!it) return;
    sfx.tick();
    if (p.dataset.kind === 'email') {
      const q = panel('mail', 'Email', '<div class="sm">Opening…</div>', at), body = q.querySelector('.body');
      try { const d = await data('email_one', `&id=${encodeURIComponent(it.id)}`);
        body.innerHTML = `<div class="tt" style="font-size:15px;font-weight:600">${esc(d.subject || it.title)}</div><div class="sm">${esc(d.from || it.source)}</div><p>${esc(d.text || '').replace(/\n/g, '<br>')}</p>`;
      } catch (e) { body.innerHTML = '<div class="sm">Couldn\'t open it.</div>'; }
      return;
    }
    panel('story', it.source || 'Story', `${it.image ? `<img class="hero" src="${img(it.image)}" alt="">` : ''}<div class="tt" style="font-size:16px;font-weight:600">${esc(it.title)}</div>
      <div class="sm">${esc(it.source || '')}${it.when ? ' · ' + esc(ago(it.when * 1000)) : ''}</div><p>${esc(it.body || '')}</p>`, at);
  }

  // ---- the round menu at an open hand ----
  const RAD = ['news', 'weather', 'clock', 'email', 'music', 'globe'];
  function showRadial(x, y, hand, now) {
    hideRadial();
    const dockTop = dock.getBoundingClientRect().top || innerHeight;          // whole menu on screen and above the dock
    x = clamp(x, 125, innerWidth - 125); y = clamp(y, 125, Math.max(125, dockTop - 122));
    const r = el('div', 'pc-radial', '<div class="disc"></div><b>HOLO<br>DESK</b>'); r.style.left = x + 'px'; r.style.top = y + 'px';
    RAD.forEach((k, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / RAD.length, b = el('button', '', svg(k)); b.type = 'button'; b.dataset.k = k; b.title = NAMES[k];
      b.style.left = 115 + Math.cos(a) * 84 + 'px'; b.style.top = 115 + Math.sin(a) * 84 + 'px'; r.appendChild(b); });
    root.appendChild(r); radial = { el: r, x, y, hand, t: now }; sfx.on();
  }
  function hideRadial() { if (radial) { radial.el.remove(); radial = null; } }

  // ---- hands: fingertip pointers, pinch to act, open hand held still for the menu ----
  const H = new Map();          // per hand (Left / Right): smoothed pointer, pinch state, what it's holding
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function toScreen(p) {        // where a camera point is on the mirrored, cover-fitted picture
    const vw = cam.videoWidth || 640, vh = cam.videoHeight || 480, s = Math.max(innerWidth / vw, innerHeight / vh), dw = vw * s, dh = vh * s;
    return { x: (innerWidth - dw) / 2 + (1 - p.x) * dw, y: (innerHeight - dh) / 2 + p.y * dh };
  }
  const openHand = h => [[8, 6], [12, 10], [16, 14], [20, 18]].every(([t, j]) => d2(h[t], h[0]) > d2(h[j], h[0]) * 1.12) && d2(h[4], h[8]) / (d2(h[0], h[9]) || 1e-3) > 0.75;
  function hit(x, y) {
    for (const e of document.elementsFromPoint(x, y)) {
      if (!root.contains(e)) continue;
      const b = e.closest('button'); if (b) return { kind: b.closest('.pc-radial') ? 'radial' : b.closest('#pc-dock') ? 'dock' : b.hasAttribute('data-x') ? 'x' : 'btn', el: b };
      const it = e.closest('.it'); if (it) return { kind: 'item', el: it, panel: it.closest('.pc-dp') };
      const p = e.closest('.pc-dp'); if (p) return { kind: 'panel', el: p, panel: p };
    }
    return null;
  }
  function down(st, x, y, now) {
    const h = hit(x, y);
    if (!h) { if (radial) hideRadial(); return; }
    if (h.kind === 'dock' || h.kind === 'radial') { h.el.classList.add('press'); setTimeout(() => h.el.classList.remove('press'), 180); add(h.el.dataset.k, h.kind === 'radial' ? { x: radial.x, y: radial.y } : null); hideRadial(); return; }
    if (h.kind === 'x') { close(h.el.closest('.pc-dp')); return; }
    if (h.kind === 'btn') { if (st.hand) h.el.click(); return; }          // a mouse click arrives by itself
    const p = h.panel; p.style.zIndex = ++z;
    const r = p.getBoundingClientRect(), body = p.querySelector('.body');
    st.hold = { p, item: h.kind === 'item' ? h.el : null, ox: x - r.left, oy: y - r.top, x0: x, y0: y, t0: now, scroll0: body.scrollTop, mode: null, path: [{ x, y, t: now }] };
  }
  function move(st, x, y, now) {
    const a = st.hold; if (!a) return;
    a.path.push({ x, y, t: now }); while (a.path.length > 2 && now - a.path[0].t > 160) a.path.shift();
    if (!a.mode && Math.hypot(x - a.x0, y - a.y0) > 14) {
      // inside a list, a mostly up/down drag scrolls it; anything else picks the panel up
      a.mode = a.item && Math.abs(y - a.y0) > Math.abs(x - a.x0) * 1.3 ? 'scroll' : 'move';
      if (a.mode === 'move') a.p.classList.add('held');
    }
    if (a.mode === 'scroll') a.p.querySelector('.body').scrollTop = a.scroll0 - (y - a.y0) * 1.6;
    if (a.mode === 'move') { a.p.style.left = Math.round(x - a.ox) + 'px'; a.p.style.top = Math.round(y - a.oy) + 'px'; }
  }
  function up(st, x, y, now) {
    const a = st.hold; st.hold = null; if (!a) return;
    a.p.classList.remove('held');
    if (!a.mode && a.item && now - a.t0 < 700) { openItem(a.p, +a.item.dataset.i, { x: x + 40, y }); return; }
    if (a.mode === 'move') {
      const q = a.path[0], dt = Math.max(0.03, (now - q.t) / 1000), vx = (x - q.x) / dt, vy = (y - q.y) / dt;
      if (Math.hypot(vx, vy) > 1800) { close(a.p, vx * 0.35, vy * 0.35); return; }          // thrown away
      place(a.p, x - a.ox, y - a.oy);
    }
  }
  function feed(lms, handed, now) {
    if (!open) return;
    hc.width !== innerWidth && (hc.width = innerWidth); hc.height !== innerHeight && (hc.height = innerHeight);
    hx.clearRect(0, 0, hc.width, hc.height);
    const seen = new Set();
    lms.forEach((h, i) => {
      const id = ((handed && handed[i] && handed[i][0] && handed[i][0].categoryName) || 'H') + (lms.length > 1 && handed && handed[0] && handed[1] && handed[0][0].categoryName === handed[1][0].categoryName ? i : '');
      seen.add(id);
      let st = H.get(id); if (!st) { st = { hand: true, fx: new OneEuro(1.2, 0.01), fy: new OneEuro(1.2, 0.01), pinched: false, pn: 0, on: 0, still: null, hold: null }; H.set(id, st); }
      const tip = toScreen({ x: (h[4].x + h[8].x) / 2, y: (h[4].y + h[8].y) / 2 });
      const x = st.fx.f(tip.x, now), y = st.fy.f(tip.y, now);
      const pr = d2(h[4], h[8]) / (d2(h[0], h[9]) || 1e-3);
      if (!st.pinched) { st.pn = pr < 0.32 ? st.pn + 1 : 0; if (st.pn >= 2) { st.pinched = true; st.on = 0; down(st, x, y, now); } }
      else { st.on = pr > 0.5 ? st.on + 1 : 0; if (st.on >= 2) { st.pinched = false; st.pn = 0; up(st, x, y, now); } }
      if (st.pinched) move(st, x, y, now);
      // an open hand held still for a moment: the menu, round that hand
      const palm = toScreen(h[9]);
      if (!st.pinched && openHand(h)) {
        if (!st.still || Math.hypot(palm.x - st.still.x, palm.y - st.still.y) > 40) st.still = { x: palm.x, y: palm.y, t: now };
        else if (now - st.still.t > 700 && (!radial || radial.hand !== id)) { showRadial(palm.x, palm.y, id, now); st.still.t = now + 1e9; }
      } else st.still = null;
      // hover glow on whatever the fingertip is over
      root.querySelectorAll('.hot').forEach(e => e.classList.remove('hot'));
      const hv = !st.pinched && hit(x, y); if (hv && (hv.kind === 'dock' || hv.kind === 'radial' || hv.kind === 'item')) hv.el.classList.add('hot');
      // the hand, drawn as light over the mirror: a soft line skeleton and the pointer between thumb and finger
      hx.strokeStyle = 'rgba(120,210,255,.55)'; hx.lineWidth = 1.5; hx.beginPath();
      for (const [a, b] of BONES) { const p1 = toScreen(h[a]), p2 = toScreen(h[b]); hx.moveTo(p1.x, p1.y); hx.lineTo(p2.x, p2.y); } hx.stroke();
      for (const k of [4, 8, 12, 16, 20]) { const q = toScreen(h[k]); hx.fillStyle = 'rgba(160,225,255,.9)'; hx.beginPath(); hx.arc(q.x, q.y, 3.2, 0, 7); hx.fill(); }
      hx.strokeStyle = st.pinched ? '#7dffb0' : '#9fe0ff'; hx.lineWidth = 2.5; hx.beginPath(); hx.arc(x, y, st.pinched ? 9 : 14, 0, 7); hx.stroke();
      if (st.pinched) { hx.fillStyle = 'rgba(125,255,176,.55)'; hx.beginPath(); hx.arc(x, y, 9, 0, 7); hx.fill(); }
    });
    for (const [id, st] of H) if (!seen.has(id)) { if (st.hold) up(st, 0, 0, now); H.delete(id); }
    if (radial && !seen.has(radial.hand) && now - radial.t > 1500) hideRadial();
    if (radial && now - radial.t > 8000) hideRadial();
  }
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

  // mouse: the same actions
  root.addEventListener('pointerdown', e => { const st = { hold: null }; mouse = st; down(st, e.clientX, e.clientY, performance.now()); });
  addEventListener('pointermove', e => { if (mouse && mouse.hold) move(mouse, e.clientX, e.clientY, performance.now()); });
  addEventListener('pointerup', e => { if (mouse) { up(mouse, e.clientX, e.clientY, performance.now()); mouse = null; } });
  let mouse = null;
  addEventListener('keydown', e => { if (open && e.key === 'Escape') hide(); });

  async function show(first) {
    if (open) { if (first) add(first); return; }
    open = true; globe.hide(); holo.clear(); feeds.close();
    document.body.classList.add('pc-desk-on'); window.__jvFaceOff = true;
    await gestures.start('hands', true); gestures.hands(2);
    const st = gestures.stream; if (st) { cam.srcObject = st; cam.play().catch(() => {}); }
    sfx.on();
    if (first) add(first); else if (!panels.size) { add('clock'); setTimeout(() => add('weather'), 250); }
  }
  function hide() {
    if (!open) return; open = false; hideRadial();
    document.body.classList.remove('pc-desk-on'); window.__jvFaceOff = false;
    [...panels].forEach(p => close(p)); hx.clearRect(0, 0, hc.width, hc.height);
    gestures.hands(1); if (!autoGestures.manual) gestures.stop('hands');
    setTimeout(() => { if (!open) cam.srcObject = null; }, 900);
  }
  function fromItems(msg) {          // an answer's cards (search results, pictures, headlines) as one list on the desk
    const items = (msg.items || []).map(it => ({ title: it.title || it.text || '', body: it.text || '', source: it.source || '', image: it.image || '' }));
    const p = panel('answer', msg.title || 'Results', items.map((it, i) => `<div class="it" data-i="${i}">${it.image ? `<img src="${img(it.image)}" alt="">` : ''}<div><div class="tt">${esc(it.title)}</div><div class="sm">${esc(it.source)}</div></div></div>`).join(''));
    p._items = items; sfx.whoosh();
  }
  return { show, hide, add, feed, fromItems, get on() { return open; }, clearAll, __panels: panels };
})();

// ============================================================
// SERVER MESSAGES
// ============================================================
window.__jvExtra = data => {
  const i = data.indexOf(':'), kind = data.slice(0, i); let msg = {};
  try { msg = JSON.parse(data.slice(i + 1)); } catch (e) { return; }
  if (kind === 'globe') { if (msg.cmd === 'hide') globe.hide(); else { desk.hide(); holo.clear(); feeds.close(); globe.show(msg); } }   // one main view at a time
  else if (kind === 'plan') showCard('plan', planHtml(msg), 60000);
  else if (kind === 'recap') showCard('recap', recapHtml(msg), 60000);
  else if (kind === 'gesture') autoGestures.set(msg.on);
  else if (kind === 'panels') {
    // on the desk, an answer's cards become a desk panel; live video (news, webcams) needs the ring, so the desk makes way
    if (desk.on && !(msg.items || []).some(it => it.video || it.cam)) { desk.fromItems(msg); return; }
    globe.hide(); feeds.close(); desk.hide(); holo.show(msg);
  }
  else if (kind === 'feeds') msg.cmd === 'close' ? feeds.close() : feeds.show(msg);
  else if (kind === 'music') music.msg(msg);
  else if (kind === 'desk') { if (msg.cmd === 'close') desk.hide(); else if (msg.cmd === 'clear') desk.clearAll(); else desk.show(msg.panel); }
  else if (kind === 'holo') {
    if (msg.cmd === 'on') { holo.setHead(true); gestures.start('head'); } else if (msg.cmd === 'off') { gestures.stop('head'); holo.setHead(false); }
    else if (msg.cmd === 'clear') holo.clear(); else if (msg.cmd === 'select') holo.select(msg.n); else if (msg.cmd === 'back') holo.back();
    else if (msg.cmd === 'next') holo.rotate(1); else if (msg.cmd === 'previous') holo.rotate(-1);
  }
  if (globe.on) globe.layout();
};
(window.__jvExtraQ || []).splice(0).forEach(window.__jvExtra);
window.__jvDesk = desk; window.__jvGlobe = globe; window.__jvGestures = gestures; window.__jvHolo = holo; window.__jvAutoGestures = autoGestures; window.__jvFeeds = feeds; window.__jvMusic = music;
