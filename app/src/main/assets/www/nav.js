// nav.js - Jarvis navigation screen: the face shrinks into a corner orb and a CarPlay-style map takes over.
// Three map back-ends behind one interface:
//   jarvis  OpenFreeMap tiles via MapLibre   (free, works worldwide, no key)       <- default
//   google  Google Maps JavaScript API       (needs GOOGLE_MAPS_API_KEY in .env)
//   apple   Apple MapKit JS                  (needs APPLE_MAPKIT_TOKEN in .env)
// If the chosen one can't load, a plain route view is shown and Jarvis says so. Navigation never stops working.
import { Guide, simulate, fmtDist, fmtDur, clamp, hav } from './nav_core.js';

const MAPLIBRE_JS = './vendor/maplibre/maplibre-gl.js';
const MAPLIBRE_CSS = './vendor/maplibre/maplibre-gl.css';
const STYLE_DAY = 'https://tiles.openfreemap.org/styles/liberty';
const STYLE_NIGHT = 'https://tiles.openfreemap.org/styles/dark';
const APPLE_JS = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
const ROUTE = '#3b9bff', ROUTE_EDGE = '#06223f';
const KIND_COLOR = { pickup: '#e8b04a', drop: '#4fe39a', stop: '#78d0f0' };

// ------------------------------------------------------------------ css
const CSS = `
:root { --orb-d: 150px; --orb-s: .2; --orb-tx: 0px; --orb-ty: 0px; --orb-r: 36vh; --orb-cx: 100px; --orb-cy: 100px; }
#three { transform-origin: 0 0; clip-path: circle(160vmax at 50% 45%);
  transition: transform .9s cubic-bezier(.22,.8,.24,1), clip-path .9s cubic-bezier(.22,.8,.24,1); }
#nav-frame { position: fixed; inset: 0; z-index: 4; display: none; opacity: 0; pointer-events: none; overflow: hidden;
  background: #0a131c; clip-path: circle(0px at var(--orb-cx) var(--orb-cy));
  transition: clip-path .9s cubic-bezier(.22,.8,.24,1), opacity .5s; font-family: inherit; }
#nav-map { position: absolute; inset: 0; }
body[data-nav] #nav-frame { pointer-events: auto; }
.nav-tools { position: absolute; right: 14px; top: 42%; display: none; flex-direction: column; gap: 10px; z-index: 3; }
body[data-nav="full"] .nav-tools { display: flex; }
.nav-tools button, .nav-recenter { -webkit-tap-highlight-color: transparent; border: 1px solid rgba(255,214,150,.18); color: #fff6e8; cursor: pointer;
  background: rgba(24,18,10,.72); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); font-family: Roboto, system-ui, sans-serif; text-transform: none; letter-spacing: normal; }
.nav-tools button { width: 48px; height: 48px; border-radius: 16px; display: grid; place-items: center; padding: 0; }
.nav-tools button svg { width: 22px; height: 22px; }
.nav-tools button.on { color: #f5c97a; border-color: rgba(245,201,122,.5); }
.nav-tools button.close { color: #ff8a93; border-color: rgba(255,90,103,.45); background: rgba(40,10,14,.78); }
.nav-recenter { position: absolute; left: 50%; bottom: 150px; transform: translate(-50%, 12px); z-index: 3; display: flex; align-items: center; gap: 9px; height: 46px; padding: 0 20px; border-radius: 23px;
  background: #fff6e8; color: #1b1206; font-weight: 700; font-size: 15px; box-shadow: 0 8px 22px rgba(0,0,0,.45); opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; }
.nav-recenter svg { width: 18px; height: 18px; }
.nav-preview { position: absolute; left: 50%; bottom: 150px; transform: translate(-50%, 16px) scale(.96); z-index: 3; display: flex; align-items: baseline; gap: 10px; padding: 12px 20px; border-radius: 20px;
  background: rgba(14,11,7,.9); border: 1px solid rgba(245,201,122,.35); color: #fff6e8; font-family: Roboto, system-ui, sans-serif; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .35s, transform .45s; }
.nav-preview b { font-size: 24px; color: #7ee0a1; } .nav-preview span { font-size: 14px; color: #cdbb9f; }
.nav-preview.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
body[data-nav="full"] #nav-frame.free .nav-recenter { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
#nav-map .nav-layer { position: absolute; inset: 0; opacity: 0; transition: opacity .6s; }
#nav-map .nav-layer.ready { opacity: 1; }
#nav-map canvas { width: 100%; height: 100%; display: block; }
#nav-map .nav-box { position: absolute; inset: 0; }
.nav-note { position: absolute; right: 24px; bottom: 68px; text-align: right; font-size: 10px; letter-spacing: 2px; color: #ddbb88; text-transform: uppercase; opacity: .8; }
body[data-nav] #hud { z-index: 7; }
body[data-nav="full"] #nav-frame { opacity: 1; clip-path: circle(160vmax at var(--orb-cx) var(--orb-cy)); }
body[data-nav="full"] #three { z-index: 5; pointer-events: none;
  transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% var(--orb-fy, 45%)); }
body[data-nav="full"] #bg-rings, body[data-nav="full"] #bg-halo, body[data-nav="full"] #bg-floor { opacity: 0; transition: opacity .6s; }
body[data-nav="full"] #log, body[data-nav="full"] #diag, body[data-nav="full"] #voice-panel,
body[data-nav="full"] #mic-level, body[data-nav="full"] #partial-text { opacity: 0; pointer-events: none; }
body[data-nav="full"] #state { left: 28px; width: var(--orb-d); bottom: 12px; transform: none; text-align: center;
  letter-spacing: 5px; font-size: 10px; padding: 0; }
body[data-nav="full"] #controls { left: auto; right: 24px; bottom: 14px; transform: none; gap: 22px; }
body[data-nav="full"] #route-panel { background: rgba(8,16,28,.82); backdrop-filter: blur(10px); border: 1px solid rgba(90,170,220,.3);
  border-radius: 14px; padding: 12px 14px; top: 20px; right: 20px; }
body[data-nav="mini"] #nav-frame { inset: auto; top: 84px; right: 44px; width: 400px; height: 290px; border-radius: 18px; opacity: 1;
  clip-path: inset(0 round 18px); box-shadow: 0 0 0 1px rgba(120,208,240,.35), 0 10px 40px rgba(0,0,0,.55); }
body[data-nav="mini"] #route-panel { top: 396px; }
body[data-nav="mini"] #nav-orb, body[data-nav="mini"] #nav-caption, body[data-nav="mini"] .nb-then { display: none; }
#nav-orb { position: fixed; z-index: 6; width: var(--orb-d); height: var(--orb-d); border-radius: 50%; opacity: 0; pointer-events: none;
  left: calc(var(--orb-cx) - var(--orb-d) / 2); top: calc(var(--orb-cy) - var(--orb-d) / 2);
  border: 2px solid rgba(120,208,240,.55); box-shadow: 0 0 22px rgba(120,208,240,.35), inset 0 0 18px rgba(120,208,240,.18);
  transition: opacity .6s .3s, border-color .4s, box-shadow .4s; }
body[data-nav="full"] #nav-orb { opacity: 1; }
#nav-orb.listening, #nav-orb.session { border-color: #78eeaa; box-shadow: 0 0 24px rgba(120,238,170,.5); }
#nav-orb.thinking { border-color: #ddbb88; box-shadow: 0 0 24px rgba(221,187,136,.5); }
#nav-orb.speaking { border-color: #78ddff; box-shadow: 0 0 30px rgba(120,221,255,.7); animation: orbPulse 1.1s ease-in-out infinite; }
#nav-orb.muted { border-color: #aa7777; box-shadow: none; }
@keyframes orbPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
.nb { position: absolute; left: 20px; top: 20px; display: flex; gap: 16px; align-items: center; min-width: 320px; max-width: min(520px, 62vw);
  padding: 14px 20px 14px 14px; border-radius: 18px; background: rgba(10,22,36,.88); backdrop-filter: blur(10px);
  border: 1px solid rgba(120,208,240,.28); box-shadow: 0 8px 30px rgba(0,0,0,.45); color: #eaf6ff; }
.nb-icon { width: 64px; height: 64px; flex: none; }
.nb-dist { font-size: 30px; font-weight: 700; letter-spacing: 1px; line-height: 1.05; font-variant-numeric: tabular-nums; }
.nb-text { font-size: 15px; color: #b8d8ee; margin-top: 3px; line-height: 1.3; }
.nb-then { position: absolute; left: 20px; top: 118px; display: none; align-items: center; gap: 8px; padding: 6px 14px 6px 8px;
  border-radius: 12px; background: rgba(10,22,36,.85); border: 1px solid rgba(120,208,240,.2); font-size: 12px; color: #9cc4de; }
.nb-then.show { display: flex; }
.nb-then svg { width: 22px; height: 22px; }
.nb.off { border-color: rgba(221,187,136,.6); } .nb.off .nb-dist { color: #ddbb88; }
.ne { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; align-items: stretch; gap: 0;
  border-radius: 16px; background: rgba(10,22,36,.9); backdrop-filter: blur(10px); border: 1px solid rgba(120,208,240,.28);
  box-shadow: 0 8px 30px rgba(0,0,0,.45); color: #eaf6ff; overflow: hidden; }
.ne-c { padding: 10px 22px; text-align: center; border-left: 1px solid rgba(120,208,240,.14); min-width: 92px; }
.ne-c:first-child { border-left: none; }
.ne-c b { display: block; font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.ne-c b i { font-size: 12px; font-style: normal; margin-left: 3px; color: #9cc4de; }
.ne-c span { font-size: 9px; letter-spacing: 3px; color: #78a0bc; text-transform: uppercase; }
.ne-stop { padding: 10px 18px; align-self: center; font-size: 11px; letter-spacing: 2px; color: #ddbb88; text-transform: uppercase;
  border-left: 1px solid rgba(120,208,240,.14); max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#nav-caption { position: absolute; left: 50%; bottom: 112px; transform: translateX(-50%); max-width: min(720px, 70vw); text-align: center;
  font-size: 14px; line-height: 1.4; color: #dff3ff; padding: 8px 18px; border-radius: 14px; background: rgba(10,22,36,.8);
  border: 1px solid rgba(120,208,240,.2); opacity: 0; transition: opacity .35s; pointer-events: none; }
#nav-caption.show { opacity: 1; }
#nav-caption em { font-style: normal; color: #78d0f0; letter-spacing: 3px; font-size: 10px; margin-right: 8px; }
#nav-badge { position: absolute; right: 24px; bottom: 50px; font-size: 10px; letter-spacing: 3px; color: #78a0bc; text-transform: uppercase;
  text-shadow: 0 1px 6px rgba(0,0,0,.8); }
#nav-badge .sim { color: #ddbb88; } #nav-badge .bad { color: #dd8877; }
#nav-toast { position: absolute; left: 50%; top: 22px; transform: translateX(-50%); padding: 8px 18px; border-radius: 12px;
  background: rgba(40,28,10,.92); border: 1px solid rgba(221,187,136,.5); color: #f0d8a8; font-size: 12px; letter-spacing: 1px;
  opacity: 0; transition: opacity .3s; pointer-events: none; max-width: 70vw; text-align: center; }
#nav-toast.show { opacity: 1; }
body[data-nav="mini"] .nb { left: 10px; top: 10px; min-width: 0; padding: 8px 12px 8px 8px; gap: 10px; border-radius: 14px; max-width: 330px; }
body[data-nav="mini"] .nb-icon { width: 40px; height: 40px; } body[data-nav="mini"] .nb-dist { font-size: 20px; }
body[data-nav="mini"] .nb-text { font-size: 11px; }
body[data-nav="mini"] .ne { bottom: 10px; border-radius: 12px; } body[data-nav="mini"] .ne-c { padding: 5px 12px; min-width: 60px; }
body[data-nav="mini"] .ne-c b { font-size: 15px; } body[data-nav="mini"] .ne-c span { font-size: 7px; letter-spacing: 2px; }
body[data-nav="mini"] .ne-stop, body[data-nav="mini"] #nav-badge, body[data-nav="mini"] .nav-note { display: none; }
.ne-c b { white-space: nowrap; }
.nav-me { width: 34px; height: 34px; } .nav-me svg { width: 100%; height: 100%; filter: drop-shadow(0 2px 6px rgba(0,0,0,.6)); }
.nav-wp { width: 26px; height: 26px; border-radius: 50%; border: 3px solid #fff; color: #08131c; font: 700 12px/20px monospace; text-align: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.6); }
`;

// ---------------------------------------------------------------- icons
const TURN = { straight: 0, depart: 0, slight_right: 45, right: 90, sharp_right: 135, slight_left: -45, left: -90, sharp_left: -135,
  fork_left: -28, fork_right: 28, exit_left: -38, exit_right: 38, merge: 0 };
export function iconSvg(name, color = '#fff') {
  const a = `fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
  let inner;
  if ((name || '').startsWith('arrive')) {
    inner = `<path d="M32 6c-10 0-18 8-18 18 0 13 18 34 18 34s18-21 18-34C50 14 42 6 32 6z" fill="${color}"/><circle cx="32" cy="24" r="7" fill="#0a1620"/>`;
  } else if (name === 'roundabout') {
    inner = `<g ${a}><circle cx="32" cy="38" r="13"/><path d="M32 60v-9"/><path d="M32 25V9"/><path d="M23 18l9-9 9 9"/></g>`;
  } else if (name === 'uturn' || name === 'uturn_left') {
    const flip = name === 'uturn_left' ? ' transform="translate(64 0) scale(-1 1)"' : '';
    inner = `<g ${a}${flip}><path d="M22 58V26a11 11 0 0 1 22 0v18"/><path d="M34 36l10 10 10-10"/></g>`;
  } else if (name === 'ferry') {
    inner = `<g ${a}><path d="M10 38h44l-6 14H16z"/><path d="M20 38V24h24v14"/><path d="M32 24v-10"/></g>`;
  } else {
    const ang = TURN[name] ?? 0;
    inner = `<g ${a}><path d="M32 58V34"/><g transform="rotate(${ang} 32 34)"><path d="M32 34V13"/><path d="M21 23l11-11 11 11"/></g></g>`;
  }
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}
const ME_SVG = `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="rgba(59,155,255,.25)"/><path d="M20 5 L31 33 L20 27 L9 33 Z" fill="#fff" stroke="#3b9bff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;

// --------------------------------------------------------------- loaders
const _loaded = {};
function loadScript(src, attrs = {}) {
  return (_loaded[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = () => res(); s.onerror = () => { delete _loaded[src]; rej(new Error('could not load ' + src)); };
    document.head.appendChild(s);
  }));
}
function loadCss(href) {
  return (_loaded[href] ||= new Promise(res => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = () => res(); l.onerror = () => res();
    document.head.appendChild(l);
  }));
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// ---------------------------------------------------------- map adapters
// Interface: init(layer, {center:[lat,lon], night, cfg}) setNight setRoute(shape) setWaypoints([{lat,lon,label,kind}])
//            setPosition(lat,lon,heading) follow({lat,lon,heading,zoom}) overview(bbox) resize() destroy()
const zoomToMpp = (zoom, lat) => 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);

export class CanvasAdapter {
  constructor(note = '') { this.kind = 'canvas'; this.note = note; }
  async init(layer, o) {
    this.layer = layer; this.night = !!o.night;
    this.cv = document.createElement('canvas'); layer.appendChild(this.cv);
    if (this.note) { const n = document.createElement('div'); n.className = 'nav-note'; n.textContent = this.note; layer.appendChild(n); }
    this.shape = []; this.wps = []; this.pos = null; this.heading = 0; this.mode = 'follow';
    this.cam = { lat: o.center[0], lon: o.center[1], h: 0, mpp: zoomToMpp(16, o.center[0]) };
    this.tgt = { ...this.cam };
    this.resize();
    const loop = () => { this._raf = requestAnimationFrame(loop); if (this.layer.getClientRects().length) { this._step(); this._draw(); } };
    this._raf = requestAnimationFrame(loop);
  }
  setNight(b) { this.night = b; }
  setRoute(shape) { this.shape = shape || []; }
  setWaypoints(w) { this.wps = w || []; }
  setPosition(lat, lon, h) { this.pos = { lat, lon }; this.heading = h || 0; }
  follow(f) { this.mode = 'follow'; Object.assign(this.tgt, { lat: f.lat, lon: f.lon, h: f.heading || 0, mpp: zoomToMpp(f.zoom, f.lat) }); }
  overview(b) {
    this.mode = 'overview';
    const lat = (b[1] + b[3]) / 2, lon = (b[0] + b[2]) / 2;
    const spanX = Math.max(1, (b[2] - b[0]) * 111320 * Math.cos(lat * Math.PI / 180)), spanY = Math.max(1, (b[3] - b[1]) * 110540);
    const W = this.cv.clientWidth || 800, H = this.cv.clientHeight || 600;
    Object.assign(this.tgt, { lat, lon, h: 0, mpp: Math.max(spanX / (W * 0.8), spanY / (H * 0.7), 2) });
  }
  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.layer.clientWidth || window.innerWidth, h = this.layer.clientHeight || window.innerHeight;
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(h * this.dpr);
  }
  destroy() { cancelAnimationFrame(this._raf); this.layer.textContent = ''; }
  _step() {
    const c = this.cam, t = this.tgt, k = 0.14;
    c.lat += (t.lat - c.lat) * k; c.lon += (t.lon - c.lon) * k;
    let dh = ((t.h - c.h + 540) % 360) - 180; c.h = (c.h + dh * k + 360) % 360;
    c.mpp = Math.exp(Math.log(c.mpp) + (Math.log(t.mpp) - Math.log(c.mpp)) * k);
  }
  _draw() {
    const cv = this.cv, ctx = cv.getContext('2d'), W = cv.width, H = cv.height, d = this.dpr, c = this.cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.night ? '#0a131c' : '#e8ecef'; ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = this.mode === 'follow' ? H * 0.68 : H / 2;
    const th = c.h * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    const kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110540;
    const P = (lat, lon) => {
      const dx = (lon - c.lon) * kx, dy = (lat - c.lat) * ky;
      return [cx + (dx * cs - dy * sn) / c.mpp * d, cy - (dx * sn + dy * cs) / c.mpp * d];
    };
    // faint grid (north/east lines) so movement and rotation are visible even without tiles
    const G = Math.pow(10, Math.round(Math.log10(c.mpp * 160)));
    ctx.strokeStyle = this.night ? 'rgba(90,150,200,.10)' : 'rgba(40,60,90,.10)'; ctx.lineWidth = d;
    const R = Math.max(W, H) * c.mpp / d * 1.2, e0 = Math.floor((-R) / G), e1 = Math.ceil(R / G);
    ctx.beginPath();
    for (let i = e0; i <= e1; i++) {
      const eastM = Math.round(c.lon * kx / G) * G + i * G, northM = Math.round(c.lat * ky / G) * G + i * G;
      let a = P(c.lat - R / ky, eastM / kx), b = P(c.lat + R / ky, eastM / kx); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      a = P(northM / ky, c.lon - R / kx); b = P(northM / ky, c.lon + R / kx); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    if (this.shape.length > 1) {
      const step = Math.max(1, Math.floor(this.shape.length / 3000));
      const path = () => { ctx.beginPath(); this.shape.forEach((p, i) => { if (i % step && i !== this.shape.length - 1) return; const q = P(p[0], p[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); };
      ctx.lineJoin = ctx.lineCap = 'round';
      path(); ctx.strokeStyle = ROUTE_EDGE; ctx.lineWidth = 15 * d; ctx.stroke();
      path(); ctx.strokeStyle = ROUTE; ctx.lineWidth = 9 * d; ctx.stroke();
    }
    this.wps.forEach((w, i) => {
      if (i === 0) return;
      const q = P(w.lat, w.lon); ctx.beginPath(); ctx.arc(q[0], q[1], 13 * d, 0, 7);
      ctx.fillStyle = KIND_COLOR[w.kind] || KIND_COLOR.stop; ctx.fill(); ctx.lineWidth = 3 * d; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#08131c'; ctx.font = `bold ${12 * d}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(w.n || i), q[0], q[1] + d);
    });
    if (this.pos) {
      const q = P(this.pos.lat, this.pos.lon), a = ((this.heading - c.h) * Math.PI) / 180, s = 17 * d;
      ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(a);
      ctx.beginPath(); ctx.arc(0, 0, s * 1.4, 0, 7); ctx.fillStyle = 'rgba(59,155,255,.25)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * .62, s * .85); ctx.lineTo(0, s * .45); ctx.lineTo(-s * .62, s * .85); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.5 * d; ctx.strokeStyle = ROUTE; ctx.stroke(); ctx.restore();
    }
  }
}

export class MapLibreAdapter {
  constructor() { this.kind = 'maplibre'; this.coords = []; this.wpMarkers = []; }
  async init(layer, o) {
    await Promise.all([loadCss(MAPLIBRE_CSS), loadScript(MAPLIBRE_JS)]);
    if (!window.maplibregl) throw new Error('MapLibre did not load');
    this.layer = layer; this.night = !!o.night;
    const box = document.createElement('div'); box.className = 'nav-box'; layer.appendChild(box);
    const map = this.map = new maplibregl.Map({ container: box, style: this.night ? STYLE_NIGHT : STYLE_DAY,
      center: [o.center[1], o.center[0]], zoom: 15, pitch: 0, interactive: false, fadeDuration: 0, maxPitch: 70,
      attributionControl: { compact: true } });
    await withTimeout(new Promise(res => map.once('load', res)), 14000, 'the map style did not load');
    this._layers(); map.on('style.load', () => this._layers());
    const el = document.createElement('div'); el.className = 'nav-me'; el.innerHTML = ME_SVG;
    this.meEl = el.firstChild;
    this.me = new maplibregl.Marker({ element: el, rotationAlignment: 'viewport', pitchAlignment: 'viewport' }).setLngLat([o.center[1], o.center[0]]).addTo(map);
    for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) map.on(ev, e => { if (e.originalEvent && this.onUser) this.onUser(); });
  }
  interact(on) {   // the full-screen map can be dragged, pinched and turned; the small ones stay still
    for (const h of ['dragPan', 'touchZoomRotate', 'doubleClickZoom', 'scrollZoom', 'dragRotate', 'touchPitch']) { try { this.map[h][on ? 'enable' : 'disable'](); } catch (e) {} }
  }
  _geo() { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.coords.length > 1 ? this.coords : [[0, 0], [0, 0]] } }; }
  _layers() {
    const map = this.map;
    if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: this._geo() });
    const lay = (id, color, w, op) => { if (!map.getLayer(id)) map.addLayer({ id, type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, w[0], 17, w[1]], 'line-opacity': op } }); };
    lay('route-casing', ROUTE_EDGE, [6, 16], 0.9); lay('route-line', ROUTE, [4, 10], 1);
    this._style3d();
  }
  _style3d() {   // raised buildings (OpenFreeMap has heights) and, at night, warm gold-on-black colours to match Jarvis
    const map = this.map, layers = (map.getStyle() && map.getStyle().layers) || [];
    try {
      if (map.getSource('openmaptiles') && !layers.some(l => l.type === 'fill-extrusion')) {
        const label = layers.find(l => l.type === 'symbol'), beforeId = map.getLayer('route-casing') ? 'route-casing' : label && label.id;
        map.addLayer({ id: 'jv-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
          paint: { 'fill-extrusion-color': this.night ? '#2c2218' : '#ddd6c8', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': this.night ? 0.92 : 0.78 } }, beforeId);
      }
      if (!this.night) return;
      for (const l of layers) {
        const id = l.id;
        if (l.type === 'background') map.setPaintProperty(id, 'background-color', '#090705');
        else if (l.type === 'fill' && /water/.test(id)) map.setPaintProperty(id, 'fill-color', '#0b1218');
        else if (l.type === 'line' && /motorway|trunk|primary/.test(id) && !/casing/.test(id)) map.setPaintProperty(id, 'line-color', '#6e5129');
        else if (l.type === 'line' && /road|street|secondary|tertiary|minor|service|highway|path/.test(id) && !/casing/.test(id)) map.setPaintProperty(id, 'line-color', '#3a2f23');
        else if (l.type === 'symbol' && l.paint && 'text-color' in l.paint) map.setPaintProperty(id, 'text-color', '#cdbb9f');
      }
    } catch (e) { console.warn('[NAV] 3d style', e); }
  }
  setNight(b) { if (b === this.night) return; this.night = b; this.map.setStyle(b ? STYLE_NIGHT : STYLE_DAY); }
  setRoute(shape) { this.coords = (shape || []).map(p => [p[1], p[0]]); const s = this.map.getSource('route'); if (s) s.setData(this._geo()); }
  setWaypoints(w) {
    this.wpMarkers.forEach(m => m.remove()); this.wpMarkers = [];
    (w || []).forEach((p, i) => {
      if (i === 0) return;
      const el = document.createElement('div'); el.className = 'nav-wp'; el.textContent = String(p.n || i);
      el.style.background = KIND_COLOR[p.kind] || KIND_COLOR.stop;
      this.wpMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(this.map));
    });
  }
  setPosition(lat, lon, h) {
    this.me.setLngLat([lon, lat]);
    this.meEl.style.transform = `rotate(${(h || 0) - this.map.getBearing()}deg)`;
  }
  follow(f) {
    const H = this.layer.clientHeight || 600;
    this.map.easeTo({ center: [f.lon, f.lat], bearing: f.heading || 0, pitch: 65, zoom: f.zoom + 0.5, duration: 950, easing: t => t, essential: true,
      padding: { top: Math.round(H * 0.36), bottom: 0, left: 0, right: 0 } });
  }
  overview(b) {
    this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 140, bottom: 140, left: 90, right: 90 }, pitch: 0, bearing: 0, duration: 900, maxZoom: 17 });
  }
  resize() { this.map.resize(); }
  destroy() { try { this.map.remove(); } catch (e) {} }
}

const GOOGLE_NIGHT = [
  { elementType: 'geometry', stylers: [{ color: '#0f1b27' }] }, { elementType: 'labels.text.fill', stylers: [{ color: '#7f9db3' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a131c' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22384d' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2f5273' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#08111a' }] }, { featureType: 'poi', stylers: [{ visibility: 'off' }] }];

export class GoogleAdapter {
  constructor() { this.kind = 'google'; this.wpMarkers = []; }
  async init(layer, o) {
    const key = o.cfg && o.cfg.google_key;
    if (!key) throw new Error('no Google Maps key in .env (GOOGLE_MAPS_API_KEY)');
    await withTimeout(new Promise((res, rej) => {
      window.__jarvisGmapsReady = res;
      window.gm_authFailure = () => { if (this.ready) this.onFail && this.onFail('Google rejected the key'); else rej(new Error('Google rejected the key')); };
      loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__jarvisGmapsReady&v=weekly`).catch(rej);
    }), 14000, 'Google Maps timed out');
    this.night = !!o.night; this.layer = layer;
    const box = document.createElement('div'); box.className = 'nav-box'; layer.appendChild(box);
    this.map = new google.maps.Map(box, { center: { lat: o.center[0], lng: o.center[1] }, zoom: 16, disableDefaultUI: true,
      gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false, styles: this.night ? GOOGLE_NIGHT : [] });
    const mk = (w, c) => new google.maps.Polyline({ map: this.map, path: [], strokeColor: c, strokeWeight: w, strokeOpacity: 1, zIndex: c === ROUTE ? 2 : 1 });
    this.casing = mk(12, ROUTE_EDGE); this.line = mk(7, ROUTE);
    this.me = new google.maps.Marker({ map: this.map, position: { lat: o.center[0], lng: o.center[1] }, zIndex: 100,
      icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, fillColor: '#fff', fillOpacity: 1, strokeColor: ROUTE, strokeWeight: 2, rotation: 0 } });
    this.ready = true;
  }
  setNight(b) { this.night = b; this.map.setOptions({ styles: b ? GOOGLE_NIGHT : [] }); }
  setRoute(shape) { const p = (shape || []).map(q => ({ lat: q[0], lng: q[1] })); this.casing.setPath(p); this.line.setPath(p); }
  setWaypoints(w) {
    this.wpMarkers.forEach(m => m.setMap(null)); this.wpMarkers = [];
    (w || []).forEach((p, i) => { if (i === 0) return;
      this.wpMarkers.push(new google.maps.Marker({ map: this.map, position: { lat: p.lat, lng: p.lon }, label: { text: String(p.n || i), color: '#08131c', fontWeight: '700' },
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: KIND_COLOR[p.kind] || KIND_COLOR.stop, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } })); });
  }
  setPosition(lat, lon, h) { this.me.setPosition({ lat, lng: lon }); const ic = this.me.getIcon(); ic.rotation = h || 0; this.me.setIcon(ic); }
  follow(f) { this.map.panTo({ lat: f.lat, lng: f.lon }); this.map.setZoom(Math.round(f.zoom)); }
  overview(b) { this.map.fitBounds({ west: b[0], south: b[1], east: b[2], north: b[3] }, { top: 140, bottom: 140, left: 90, right: 90 }); }
  resize() { if (window.google) google.maps.event.trigger(this.map, 'resize'); }
  destroy() { this.layer && (this.layer.textContent = ''); }
}

export class AppleAdapter {
  constructor() { this.kind = 'apple'; this.wpAnn = []; this.ov = []; }
  async init(layer, o) {
    const token = o.cfg && o.cfg.apple_token;
    if (!token) throw new Error('no Apple MapKit token in .env (APPLE_MAPKIT_TOKEN)');
    await withTimeout(new Promise((res, rej) => {
      window.__jarvisMapkitReady = res;
      loadScript(APPLE_JS, { crossorigin: 'anonymous', 'data-callback': '__jarvisMapkitReady', 'data-libraries': 'map,annotations,overlays' }).catch(rej);
    }), 14000, 'Apple Maps timed out');
    mapkit.init({ authorizationCallback: done => done(token), language: 'en' });
    this.layer = layer; this.night = !!o.night;
    const box = document.createElement('div'); box.className = 'nav-box'; layer.appendChild(box);
    this.map = new mapkit.Map(box, { showsCompass: mapkit.FeatureVisibility.Hidden, showsZoomControl: false, showsMapTypeControl: false,
      showsScale: mapkit.FeatureVisibility.Hidden, isScrollEnabled: false, isZoomEnabled: false, isRotationEnabled: false,
      colorScheme: this.night ? mapkit.Map.ColorSchemes.Dark : mapkit.Map.ColorSchemes.Light });
    this.meEl = document.createElement('div'); this.meEl.className = 'nav-me'; this.meEl.innerHTML = ME_SVG;
    this.me = new mapkit.Annotation(new mapkit.Coordinate(o.center[0], o.center[1]), () => this.meEl, { animates: false });
    this.map.addAnnotation(this.me);
  }
  setNight(b) { this.night = b; this.map.colorScheme = b ? mapkit.Map.ColorSchemes.Dark : mapkit.Map.ColorSchemes.Light; }
  setRoute(shape) {
    this.ov.forEach(x => this.map.removeOverlay(x)); this.ov = [];
    if (!shape || shape.length < 2) return;
    const step = Math.max(1, Math.floor(shape.length / 4000));
    const pts = shape.filter((_, i) => i % step === 0 || i === shape.length - 1).map(p => new mapkit.Coordinate(p[0], p[1]));
    const mk = (w, c) => new mapkit.PolylineOverlay(pts, { style: new mapkit.Style({ lineWidth: w, strokeColor: c, lineJoin: 'round', lineCap: 'round' }) });
    this.ov = [mk(12, ROUTE_EDGE), mk(7, ROUTE)]; this.ov.forEach(x => this.map.addOverlay(x));
  }
  setWaypoints(w) {
    this.wpAnn.forEach(a => this.map.removeAnnotation(a)); this.wpAnn = [];
    (w || []).forEach((p, i) => { if (i === 0) return;
      const a = new mapkit.MarkerAnnotation(new mapkit.Coordinate(p.lat, p.lon), { color: KIND_COLOR[p.kind] || KIND_COLOR.stop, glyphText: String(p.n || i) });
      this.map.addAnnotation(a); this.wpAnn.push(a); });
  }
  setPosition(lat, lon, h) { this.me.coordinate = new mapkit.Coordinate(lat, lon); this.meEl.firstChild.style.transform = `rotate(${h || 0}deg)`; }
  _region(lat, lon, zoom) {
    const W = this.layer.clientWidth || 800, H = this.layer.clientHeight || 600, deg = 360 / (256 * Math.pow(2, zoom));
    return new mapkit.CoordinateRegion(new mapkit.Coordinate(lat, lon), new mapkit.CoordinateSpan(H * deg * Math.cos(lat * Math.PI / 180), W * deg));
  }
  follow(f) { this.map.setRegionAnimated(this._region(f.lat, f.lon, f.zoom), true); }
  overview(b) {
    const lat = (b[1] + b[3]) / 2, lon = (b[0] + b[2]) / 2;
    this.map.setRegionAnimated(new mapkit.CoordinateRegion(new mapkit.Coordinate(lat, lon),
      new mapkit.CoordinateSpan(Math.max(0.004, (b[3] - b[1]) * 1.5), Math.max(0.004, (b[2] - b[0]) * 1.5))), true);
  }
  resize() {}
  destroy() { try { this.map.destroy(); } catch (e) {} }
}

// ------------------------------------------------------------ map manager
// Shows a plain route view at once (no waiting), then swaps in the real map when it is ready.
// Anything the chosen map can't do falls back, and the user is told.
export class MapView {
  constructor(host, hooks = {}) {
    this.host = host; this.hooks = hooks; this.adapter = null; this.want = null;
    this.s = { night: false, shape: [], wps: [], pos: null, follow: null, overview: null, center: [0, 0] };
  }
  async _swap(adapter, o) {
    const layer = document.createElement('div'); layer.className = 'nav-layer'; this.host.appendChild(layer);
    try { await adapter.init(layer, o); } catch (e) { try { adapter.destroy(); } catch (e2) {} layer.remove(); throw e; }
    adapter.onFail = why => this.hooks.degrade && this.hooks.degrade(adapter.kind, why);
    adapter.onUser = () => this.hooks.onUser && this.hooks.onUser();
    const old = this.adapter; this.adapter = adapter; this.layer = layer;
    this._replay();
    requestAnimationFrame(() => layer.classList.add('ready'));
    if (old) setTimeout(() => { const l = old._layer; old.destroy(); if (l) l.remove(); }, 700);
    adapter._layer = layer;
    return adapter;
  }
  _replay() {
    const a = this.adapter, s = this.s;
    a.setNight(s.night); a.setRoute(s.shape); a.setWaypoints(s.wps);
    if (s.pos) a.setPosition(s.pos[0], s.pos[1], s.pos[2]);
    if (s.overview) a.overview(s.overview); else if (s.follow) a.follow(s.follow);
    if (a.interact) a.interact(!!s.interact);
  }
  async start(provider, center, night, cfg) {
    this.s.center = center; this.s.night = night; this.cfg = cfg;
    if (!this.adapter) {
      const o = { center, night, cfg };
      await this._swap(new CanvasAdapter(), o);
    }
    await this.use(provider);
  }
  async use(provider) {
    if (this.want === provider && this.adapter && this.adapter.kind !== 'canvas') return;
    this.want = provider;
    const o = { center: this.s.pos ? [this.s.pos[0], this.s.pos[1]] : this.s.center, night: this.s.night, cfg: this.cfg };
    const make = { jarvis: () => new MapLibreAdapter(), google: () => new GoogleAdapter(), apple: () => new AppleAdapter() }[provider] || (() => new MapLibreAdapter());
    try {
      await this._swap(make(), o);
    } catch (e) {
      console.warn('[NAV] map provider', provider, 'unavailable:', e.message);
      if (provider !== 'jarvis') {
        this.hooks.toast && this.hooks.toast(`${provider === 'google' ? 'Google' : 'Apple'} Maps unavailable: ${e.message}. Using the Jarvis map.`);
        this.hooks.say && this.hooks.say(`${provider === 'google' ? 'Google' : 'Apple'} Maps isn't available, so I'm using my own map.`);
        this.hooks.fellBack && this.hooks.fellBack('jarvis');
        this.want = 'jarvis';
        try { await this._swap(new MapLibreAdapter(), o); return; } catch (e2) { console.warn('[NAV] jarvis map unavailable:', e2.message); }
      }
      if (this.adapter && this.adapter.kind === 'canvas' && !this.adapter.note) {
        this.adapter.note = 'Map tiles unavailable - showing route only';
        const n = document.createElement('div'); n.className = 'nav-note'; n.textContent = this.adapter.note; this.adapter.layer.appendChild(n);
      }
    }
  }
  get kind() { return this.adapter ? this.adapter.kind : 'none'; }
  setNight(b) { this.s.night = b; this.adapter && this.adapter.setNight(b); }
  setRoute(shape) { this.s.shape = shape; this.adapter && this.adapter.setRoute(shape); }
  setWaypoints(w) { this.s.wps = w; this.adapter && this.adapter.setWaypoints(w); }
  setPosition(lat, lon, h) { this.s.pos = [lat, lon, h]; this.adapter && this.adapter.setPosition(lat, lon, h); }
  follow(f) { this.s.follow = f; this.s.overview = null; this.adapter && this.adapter.follow(f); }
  overview(b) { this.s.overview = b; this.adapter && this.adapter.overview(b); }
  resize() { this.adapter && this.adapter.resize(); }
  interact(on) { this.s.interact = on; this.adapter && this.adapter.interact && this.adapter.interact(on); }
}

// ---------------------------------------------------------------- the screen
export function createNav(env = {}) {
  const say = env.say || (() => {});
  const style = document.createElement('style'); style.id = 'nav-style'; style.textContent = CSS; document.head.appendChild(style);

  const frame = document.createElement('div'); frame.id = 'nav-frame';
  frame.innerHTML = `<div id="nav-map"></div>
    <div class="nb"><div class="nb-icon"></div><div><div class="nb-dist"></div><div class="nb-text"></div></div></div>
    <div class="nb-then"></div>
    <div class="ne"></div>
    <div id="nav-badge"></div><div id="nav-toast"></div>
    <div class="nav-tools"><button type="button" data-t="close" class="close" aria-label="End or hide navigation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <button type="button" data-t="north" aria-label="North up or heading up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l4 9-4-2-4 2z" fill="currentColor"/><path d="M12 21l-4-9 4 2 4-2z"/></svg></button>
      <button type="button" data-t="overview" aria-label="Whole route"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg></button>
      <button type="button" data-t="voice" aria-label="Voice guidance on or off"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path class="w" d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg></button></div>
    <div class="nav-preview"></div>
    <button type="button" class="nav-recenter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 21 3l-8.5 18-2-7.5z"/></svg>Recenter</button>`;
  const orb = document.createElement('div'); orb.id = 'nav-orb';
  const caption = document.createElement('div'); caption.id = 'nav-caption';
  frame.appendChild(caption);
  document.body.appendChild(frame); document.body.appendChild(orb);
  const $ = sel => frame.querySelector(sel);
  const dom = { map: $('#nav-map'), banner: $('.nb'), icon: $('.nb-icon'), dist: $('.nb-dist'), text: $('.nb-text'),
    then: $('.nb-then'), eta: $('.ne'), badge: $('#nav-badge'), toast: $('#nav-toast'), preview: $('.nav-preview') };

  const S = { cfg: { provider: 'jarvis', theme: 'auto', units: 'miles', use_gps: true, google_key: '', apple_token: '' },
    route: null, meta: {}, voice: true, sim: null, simSpeed: 25, gpsWatch: null, gps: { state: 'idle', last: null },
    overview: false, zoomOff: 0, lastPost: 0, lastPostPos: null, lastProg: 0, lastShapeUpd: 0, rerouteFail: 0, view: 'off', endTimer: 0, st: null };

  const speak = (t, o = {}) => { if (S.voice) say(t, o); };
  const guide = new Guide({ say: speak, onUpdate: onGuide, onReroute: doReroute, onArrive });
  const mv = new MapView(dom.map, {
    onUser: () => { if (S.view === 'full') { S.free = true; frame.classList.add('free'); } },   // he moved the map: stop following until Recenter
    toast: msg => toast(msg, 6000), say: t => say(t, { urgent: true }),
    fellBack: p => { S.cfg.provider = p; badge(); },
    degrade: (kind, why) => { toast(`${kind} map failed: ${why}`, 6000); say("That map stopped working, so I'm switching to my own.", { urgent: true }); S.cfg.provider = 'jarvis'; mv.use('jarvis'); },
  });

  // ---- little helpers
  function toast(msg, ms = 3500) { dom.toast.textContent = msg; dom.toast.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => dom.toast.classList.remove('show'), ms); }
  let capTimer = 0;
  function captionShow(text, who) {
    if (S.view === 'off' || !text) return;
    caption.innerHTML = '';
    if (who === 'user') { const e = document.createElement('em'); e.textContent = 'YOU'; caption.appendChild(e); }
    caption.appendChild(document.createTextNode(text));
    caption.classList.add('show'); clearTimeout(capTimer); capTimer = setTimeout(() => caption.classList.remove('show'), 7000);
  }
  const isNight = () => S.cfg.theme === 'night' || (S.cfg.theme === 'auto' && (new Date().getHours() >= 19 || new Date().getHours() < 6));
  function applyTheme() { mv.setNight(isNight()); }
  setInterval(() => { if (S.cfg.theme === 'auto') applyTheme(); }, 600000);
  const speedText = ms => ms == null ? '' : (S.st && S.st.units === 'km' ? `${Math.round(ms * 3.6)}` : `${Math.round(ms * 2.23694)}`);
  const clockText = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function layoutOrb() {
    const W = window.innerWidth, H = window.innerHeight;
    const dash = S.view === 'dash';
    const D = Math.round(dash || W < H ? clamp(H * 0.13, 88, 116) : clamp(H * 0.18, 110, 170)), R = Math.min(0.36 * H, 0.44 * W), sc = D / (2 * R);   // portrait: the circle fits the face, not the screen
    // on a phone the head sits in the bottom-right corner, just above the trip numbers (arrive / left / distance)
    const ne = document.querySelector('.ne'), neBox = ne && ne.getBoundingClientRect(), portrait = W < H;
    const low = dash ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dash-orb-bottom')) || 120)
      : portrait ? (neBox && neBox.height ? H - neBox.top + 12 : 110) : 40;
    const fy = portrait ? 0.5 : 0.45; document.documentElement.style.setProperty('--orb-fy', (fy * 100) + '%');
    const cx = dash || portrait ? W - 16 - D / 2 : 28 + D / 2, cy = H - low - D / 2;
    const r = document.documentElement.style;
    r.setProperty('--orb-d', D + 'px'); r.setProperty('--orb-s', String(sc)); r.setProperty('--orb-r', R + 'px');
    r.setProperty('--orb-tx', (cx - sc * 0.5 * W) + 'px'); r.setProperty('--orb-ty', (cy - sc * fy * H) + 'px');
    r.setProperty('--orb-cx', cx + 'px'); r.setProperty('--orb-cy', cy + 'px');
  }
  window.addEventListener('resize', () => { layoutOrb(); mv.resize(); });
  const stateEl = document.getElementById('state');
  if (stateEl) new MutationObserver(() => { orb.className = stateEl.className; }).observe(stateEl, { attributes: true, attributeFilter: ['class'] });

  function badge() {
    const prov = { jarvis: 'Jarvis map', google: 'Google Maps', apple: 'Apple Maps' }[S.cfg.provider] || 'Jarvis map';
    const g = S.gps.state, parts = [prov];
    if (S.sim) parts.push('<span class="sim">SIMULATING</span>');
    else if (g === 'ok') parts.push(`GPS ${Math.round(S.gps.last.acc)} m`);
    else if (g === 'coarse') parts.push('<span class="bad">GPS weak</span>');
    else if (g === 'denied') parts.push('<span class="bad">GPS blocked</span>');
    else if (g === 'unavailable' || g === 'error') parts.push('<span class="bad">no GPS</span>');
    dom.badge.innerHTML = parts.join(' · ');
  }

  // ---- view (face <-> map)
  function setView(mode, center) {
    if (center && !S.route) mv.s.center = center;
    if (mode === S.view) return;
    const prev = S.view; S.view = mode;
    clearTimeout(S.hideT);
    mv.interact(mode === 'full'); S.free = false; frame.classList.remove('free');
    if (mode !== 'off') {
      layoutOrb();
      frame.style.display = 'block';
      void frame.offsetWidth;
      document.body.setAttribute('data-nav', mode);
      startGps();
      const c = S.st ? S.st.pos : (S.route ? S.route.shape[0] : (S.gps.last ? [S.gps.last.lat, S.gps.last.lon] : [0, 0]));
      mv.start(S.cfg.provider, c, isNight(), S.cfg).then(() => { refollow(); }).catch(e => console.warn('[NAV]', e));
      setTimeout(() => mv.resize(), 120); setTimeout(() => mv.resize(), 1000);
    } else {
      document.body.removeAttribute('data-nav');
      S.hideT = setTimeout(() => { if (S.view === 'off') frame.style.display = 'none'; }, 1000);
    }
  }

  // ---- drawing the banner / eta
  function onGuide(st) {
    S.st = st; if (!S.route || !st) return;
    const units = st.units;
    if (st.lowAccuracy) return;
    const next = st.next;
    const arriving = !next || next.icon.startsWith('arrive');
    dom.banner.classList.toggle('off', !!st.off);
    if (st.off) {
      dom.icon.innerHTML = iconSvg('uturn', '#ddbb88'); dom.dist.textContent = 'Off route'; dom.text.textContent = 'Recalculating…';
    } else {
      dom.icon.innerHTML = iconSvg(arriving ? 'arrive' : next.icon);
      dom.dist.textContent = fmtDist(next ? st.nextDist : 0, units, true);
      dom.text.textContent = arriving ? `${S.meta.label || 'Destination'}` : next.text.replace(/\.$/, '');
    }
    const then = st.thenStep, curNext = next;
    if (!st.off && curNext && then && !curNext.icon.startsWith('arrive') && !then.icon.startsWith('arrive') && curNext.dist_m < 500) {
      dom.then.innerHTML = `Then ${iconSvg(then.icon, '#9cc4de')} ${escapeHtml(then.text.replace(/\.$/, ''))}`; dom.then.classList.add('show');
    } else dom.then.classList.remove('show');
    const mins = Math.max(0, Math.round(st.remTime / 60));
    const left = mins >= 60 ? `${Math.floor(mins / 60)}<i>h</i> ${mins % 60}<i>m</i>` : `${mins}<i>min</i>`;
    const sp = st.speed != null && (S.gps.state === 'ok' || S.sim) ? speedText(st.speed) : '';
    const w = S.route.waypoints && S.route.waypoints[st.leg + 1];
    const stop = S.meta.delivery && w ? `<div class="ne-stop">Next · ${escapeHtml(w.label || 'stop')}${w.kind ? ' (' + (w.kind === 'drop' ? 'drop-off' : 'pickup') + ')' : ''}</div>` : '';
    dom.eta.innerHTML = `<div class="ne-c"><b>${clockText(st.eta)}</b><span>arrive</span></div>
      <div class="ne-c"><b>${left}</b><span>left</span></div>
      <div class="ne-c"><b>${fmtDist(st.remDist, units, true).replace(' ', '<i>') + '</i>'}</b><span>distance</span></div>
      ${sp ? `<div class="ne-c"><b>${sp}<i>${units === 'km' ? 'km/h' : 'mph'}</i></b><span>speed</span></div>` : ''}${stop}`;
    // map
    mv.setPosition(st.pos[0], st.pos[1], st.heading);
    const now = Date.now();
    if (now - S.lastShapeUpd > 1500) { S.lastShapeUpd = now; mv.setRoute([st.pos, ...S.route.shape.slice(st.idx + 1)]); }
    if (!S.overview && !S.free) refollow(st);
    // tell the server how we're doing (so "how far?" and "what's next?" work by voice)
    if (now - S.lastProg > 5000) {
      S.lastProg = now;
      post('/nav/progress', { remDist: st.remDist, remTime: st.remTime, units, lat: st.pos[0], lon: st.pos[1], leg: st.leg,
        nextSay: next ? next.say : '', nextDist: st.nextDist, nextText: next ? next.text : '', label: S.meta.label || '' });
    }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function zoomFor(st) {
    const sp = st && st.speed != null ? st.speed : 10, mode = S.route ? S.route.mode : 'auto';
    const base = mode === 'pedestrian' ? 18.2 : mode === 'bicycle' ? 17.4 : clamp(17.3 - sp / 8, 14.8, 17.4);
    return clamp(base + S.zoomOff, 11, 19.5);
  }
  function recenter() { S.overview = false; S.free = false; frame.classList.remove('free'); refollow(); }
  const tool = t => frame.querySelector(`.nav-tools [data-t="${t}"]`);
  frame.querySelector('.nav-recenter').onclick = e => { e.stopPropagation(); recenter(); };
  frame.querySelector('.nav-tools').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; e.stopPropagation();
    if (b.dataset.t === 'close') { const ev = new CustomEvent('jv-map-close', { cancelable: true }); if (window.dispatchEvent(ev)) setView('off'); return; }   // the phone asks end-or-hide; elsewhere it just hides
    if (b.dataset.t === 'north') { S.north = !S.north; b.classList.toggle('on', S.north); if (!S.free && !S.overview) refollow(); }
    else if (b.dataset.t === 'overview') { if (S.route) { S.overview = true; mv.overview(S.route.bbox); frame.classList.add('free'); } }
    else if (b.dataset.t === 'voice') { S.voice = !S.voice; b.classList.toggle('on', !S.voice); b.querySelector('.w').style.opacity = S.voice ? 1 : 0; toast(S.voice ? 'Voice guidance on' : 'Voice guidance off', 1800); }
  };
  // a tap on the small map (the delivery card's map, or the mini map) opens it full screen
  frame.addEventListener('click', () => { if (S.view === 'dash' || S.view === 'mini') window.dispatchEvent(new CustomEvent('jv-map-tap')); });
  function refollow(st = S.st) {
    if (!S.route) return;
    const p = st ? st.pos : S.route.shape[0], h = st && !S.north ? st.heading : 0;
    mv.follow({ lat: p[0], lon: p[1], heading: h || 0, zoom: zoomFor(st) });
  }

  // ---- routes
  function startRoute(route, meta = {}, { silent = false } = {}) {
    clearTimeout(S.endTimer);
    S.route = route; S.meta = meta; S.overview = false;
    S.cfg.units = route.units || S.cfg.units;
    guide.setRoute(route, { label: meta.label || '', skipFirst: !meta.reroute });
    const wps = (route.waypoints || []).map((w, i) => ({ lat: w.lat, lon: w.lon, label: w.label, kind: w.kind || (i === route.waypoints.length - 1 ? 'drop' : 'stop'), n: i }));
    const metaW = meta.waypoints || [];
    wps.forEach((w, i) => { if (metaW[i]) Object.assign(w, metaW[i]); });
    route.waypoints = wps;
    mv.setRoute(route.shape); mv.setWaypoints(wps);
    const first = route.shape[0];
    mv.setPosition(first[0], first[1], 0);
    S.st = guide.state;
    if (meta.view !== 'keep') setView(meta.view === 'dash' ? 'dash' : S.view === 'mini' ? 'mini' : 'full');
    applyTheme(); onGuide(guide.state); refollow(guide.state); badge();
    startGps();
    if (S.sim || meta.simulate) startSim();
    else if (S.gps.last && Date.now() - S.gps.last.ts < 10000) guide.fix(S.gps.last);
    if (!meta.reroute && meta.view !== 'keep' && !silent) preview(route);
  }
  // a new trip: the whole route and its numbers for three seconds, then the camera flies down behind you
  function preview(route) {
    if (S.view !== 'full' || !route.bbox) return;
    S.overview = true; mv.overview(route.bbox);
    const n = (route.waypoints || []).length - 1;
    dom.preview.innerHTML = `<b>${fmtDur(route.time_s || 0)}</b><span>${fmtDist(route.distance_m || 0, route.units || S.cfg.units)}${n > 1 ? ` · ${n} stops` : ''}</span>`;
    dom.preview.classList.add('show'); clearTimeout(S.prevT);
    S.prevT = setTimeout(() => { dom.preview.classList.remove('show'); if (S.overview && !S.free) { S.overview = false; refollow(); } }, 3200);
  }
  function stopNav(sayText) {
    clearTimeout(S.endTimer); stopSim();
    S.route = null; S.meta = {}; guide.clear(); S.st = null;
    mv.setRoute([]); mv.setWaypoints([]);
    dom.then.classList.remove('show');
    if (sayText) speak(sayText, { urgent: true });
    setView('off');
  }
  async function doReroute(pos) {
    if (!S.route || Date.now() - S.rerouteFail < 20000) return;
    try {
      const r = await (await fetch('/nav/reroute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pos) })).json();
      if (r.ok) startRoute(r.route, { ...S.meta, ...(r.meta || {}), reroute: true, view: 'keep' });
      else { S.rerouteFail = Date.now(); speak(r.error || "I can't find a way from here.", { urgent: true }); }
    } catch (e) { S.rerouteFail = Date.now(); speak("I lost the connection while recalculating.", { urgent: true }); }
  }
  function onArrive({ leg, final, waypoint, label }) {
    if (S.meta.delivery) {
      const kind = waypoint && waypoint.kind;
      if (kind === 'pickup') speak(`Arrived at ${label}. Say picked up when you have the order.`, { urgent: true });
      else if (kind === 'drop') speak(`Arrived at ${label}. Say delivered when you've dropped it off.`, { urgent: true });
      else speak(`You have arrived at ${label}.`, { urgent: true });
      return;                                         // the server re-plans when you confirm, so the map stays up
    }
    speak(`You have arrived at ${label}.`, { urgent: true });
    if (final) {
      post('/nav/ended', {});
      S.endTimer = setTimeout(() => stopNav(''), 12000);
    }
  }

  // ---- simulation
  function startSim() {
    if (!S.route) return false;
    if (S.sim) S.sim.stop();
    const sp = S.route.mode === 'pedestrian' ? 4 : S.route.mode === 'bicycle' ? 9 : S.simSpeed;
    guide.setRoute(S.route, { skipFirst: true, label: S.meta.label || '' });
    S.sim = simulate(S.route, f => { S.gps.last = { ...f, sim: true }; guide.fix(f); }, { speed: sp });
    badge(); return true;
  }
  function stopSim() { if (S.sim) { S.sim.stop(); S.sim = null; badge(); } }

  // ---- GPS
  function startGps() {
    if (S.gpsWatch != null || !S.cfg.use_gps) return;
    if (!('geolocation' in navigator)) { S.gps.state = 'unavailable'; badge(); return; }
    S.gpsWatch = navigator.geolocation.watchPosition(p => {
      const c = p.coords;
      onFix({ lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading, ts: p.timestamp || Date.now() });
    }, err => { S.gps.state = err.code === 1 ? 'denied' : 'error'; badge(); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }
  function stopGps() { if (S.gpsWatch != null) navigator.geolocation.clearWatch(S.gpsWatch); S.gpsWatch = null; S.gps.state = 'idle'; badge(); }
  function onFix(f) {
    S.gps.last = f; S.gps.state = f.acc <= 150 ? 'ok' : 'coarse'; badge();
    const moved = S.lastPostPos ? hav(S.lastPostPos, [f.lat, f.lon]) : 1e9;
    if (Date.now() - S.lastPost > 4000 && (moved > 25 || Date.now() - S.lastPost > 30000)) {
      S.lastPost = Date.now(); S.lastPostPos = [f.lat, f.lon];
      post('/nav/position', { lat: f.lat, lon: f.lon, acc: f.acc, speed: f.speed, heading: f.heading });
    }
    if (S.route && !S.sim) guide.fix(f);
    else if (!S.route && S.view !== 'off') {                 // plain map: just show where you are
      mv.setPosition(f.lat, f.lon, f.heading || 0);
      mv.follow({ lat: f.lat, lon: f.lon, heading: 0, zoom: 16 + S.zoomOff });
    }
  }
  function post(url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); }

  // ---- messages from the server
  function handle(m) {
    switch (m.cmd) {
      case 'route': startRoute(m.route, m.meta || {}); break;
      case 'stop': stopNav(m.say || ''); break;
      case 'view': if (m.mode === 'full' || m.mode === 'mini' || m.mode === 'dash') setView(m.mode, m.center || (S.gps.last ? [S.gps.last.lat, S.gps.last.lon] : null)); else setView('off'); break;
      case 'zoom': S.zoomOff = clamp(S.zoomOff + (m.dir === 'in' ? 1 : -1), -4, 4); S.overview = false; refollow(); break;
      case 'theme': S.cfg.theme = m.value; applyTheme(); break;
      case 'provider': Object.assign(S.cfg, m.cfg || {}, { provider: m.value }); badge(); if (S.view !== 'off') mv.use(m.value); break;
      case 'voice': S.voice = !!m.on; { const b = tool('voice'); if (b) { b.classList.toggle('on', !S.voice); b.querySelector('.w').style.opacity = S.voice ? 1 : 0; } } break;
      case 'simulate': m.on ? (startSim() || toast('Start a route first, then I can simulate driving it.')) : stopSim(); break;
      case 'overview': if (S.route) { S.overview = true; mv.overview(S.route.bbox); if (S.view === 'full') frame.classList.add('free'); } break;
      case 'recenter': recenter(); break;
      case 'cfg': Object.assign(S.cfg, m.cfg || {}); if (S.cfg.use_gps === false) stopGps(); else startGps(); badge(); break;
    }
  }

  fetch('/nav/config').then(r => r.json()).then(c => { Object.assign(S.cfg, c); badge(); }).catch(() => {});
  layoutOrb(); badge();
  return { handle, startGps, stopGps, caption: captionShow, get view() { return S.view; }, get route() { return S.route; },
    get state() { return S; }, guide, mapView: mv, setView, startRoute, stopNav, startSim, stopSim, onFix, iconSvg };
}
