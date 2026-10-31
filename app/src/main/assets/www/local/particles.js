// particles.js - Jarvis's face as glowing particles instead of a realistic person. A loaded face model is only used for its
// shape: thousands of points are scattered over its surface, the mesh is hidden, and two lights sit in the eyes.
// The points react to what he's doing: a slow shimmer while waiting, ripples with your voice while listening, a brighter
// swirl while thinking, a pulse around the mouth while talking.
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

const COUNT = 32000, DOT_PX = 1.6, DUST = 900, RING = 900;
const STATE = {                                     // [colour, glow] for each state (colour tints the gold a little)
  idle: [0xffbe5c, 0.6], standby: [0xffbe5c, 0.6], session: [0xbff7e4, 0.8], listening: [0xbff7e4, 0.85],
  thinking: [0xffcf7a, 1.7], speaking: [0xd8f1ff, 0.95], muted: [0xff9aa2, 0.3],
};

const VERT = `
attribute float aPhase; attribute float aFade;
uniform float uTime, uEnergy, uSwirl, uSize, uMouthY, uMouthZ, uSpeak, uMic, uSpan; uniform vec3 uCenter;
varying float vAlpha; varying float vHot;
void main() {
  vec3 p = position, dir = normalize(p - uCenter + vec3(0.0001));
  float tw = sin(uTime * (1.3 + aPhase * 0.7) + aPhase * 6.283);
  p += dir * tw * uSpan * 0.004 * (0.5 + uEnergy);                                           // shimmer
  float a = uSwirl * (0.6 + 0.4 * sin(aPhase * 9.0)) * sin(uTime * 2.2 + p.y / uSpan * 4.0) * 0.06;   // thinking: a drift around the head
  vec2 q = p.xz - uCenter.xz; p.xz = uCenter.xz + mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
  float mouth = exp(-pow((p.y - uMouthY) / (uSpan * 0.07), 2.0)) * smoothstep(0.0, uSpan * 0.12, p.z - uMouthZ);   // the band around the lips
  p.z += mouth * uSpeak * uSpan * 0.05 * (0.5 + 0.5 * sin(uTime * 18.0 + aPhase * 6.0));
  p += dir * uMic * uSpan * 0.04 * sin(uTime * 9.0 + p.y / uSpan * 25.0);                    // listening: ripples with your voice
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vHot = mouth * uSpeak;
  float spark = pow(max(0.0, sin(uTime * (0.6 + aPhase * 1.7) + aPhase * 80.0)), 40.0);       // now and then a dot flashes
  vAlpha = aFade * (0.55 + 0.45 * (0.5 + 0.5 * tw)) + spark * 1.2;
  gl_PointSize = uSize * (0.6 + 1.5 * pow(fract(aPhase * 7.31), 8.0)) * (1.0 + vHot * 0.8 + spark * 0.9) / max(0.1, -mv.z);
}`;
const FRAG = `
uniform vec3 uColor; uniform float uEnergy, uOpacity;
varying float vAlpha; varying float vHot;
void main() {
  float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.0, d);
  vec3 c = mix(uColor, vec3(1.0, 0.95, 0.85), smoothstep(0.25, 0.0, d) * 0.7);
  gl_FragColor = vec4(c * (0.6 + uEnergy * 0.7 + vHot), core * vAlpha * uOpacity * (0.45 + uEnergy * 0.5));
}`;

// a small bright glint with a soft sideways streak (an eye catching the light), not a big glowing ball
function glintTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64; const g = c.getContext('2d');
  const streak = g.createLinearGradient(0, 0, 128, 0);
  streak.addColorStop(0, 'rgba(255,210,140,0)'); streak.addColorStop(0.5, 'rgba(255,240,215,0.9)'); streak.addColorStop(1, 'rgba(255,210,140,0)');
  g.fillStyle = streak; g.fillRect(34, 31, 60, 2);
  const r = g.createRadialGradient(64, 32, 0, 64, 32, 11);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(255,236,200,0.8)'); r.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = r; g.fillRect(40, 8, 48, 48); return new THREE.CanvasTexture(c);
}

// a soft vertical streak: a ray of light falling through the dark
function rayTexture() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 128; const g = c.getContext('2d');
  const v = g.createLinearGradient(0, 0, 0, 128); v.addColorStop(0, 'rgba(255,220,170,0)'); v.addColorStop(0.5, 'rgba(255,230,190,1)'); v.addColorStop(1, 'rgba(255,220,170,0)');
  const h = g.createLinearGradient(0, 0, 16, 0); h.addColorStop(0, 'rgba(0,0,0,1)'); h.addColorStop(0.5, 'rgba(0,0,0,0)'); h.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = v; g.fillRect(0, 0, 16, 128); g.globalCompositeOperation = 'destination-out'; g.fillStyle = h; g.fillRect(0, 0, 16, 128);
  return new THREE.CanvasTexture(c);
}

// reads a mesh's texture at a uv: [luminance, alpha] (hair is drawn on mostly transparent cards; skin is darker at the lips
// and brows, which is how the face's features show up in the dots). null when the mesh has no texture.
function texOf(mesh) {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material, img = m && m.map && m.map.image;
  if (!img || !img.width) return null;
  try {
    const W = Math.min(512, img.width), H = Math.min(512, img.height), c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); const d = g.getImageData(0, 0, W, H).data, flip = m.map.flipY;
    return uv => { const x = Math.min(W - 1, Math.max(0, Math.floor((uv.x % 1 + 1) % 1 * W))), y0 = (uv.y % 1 + 1) % 1, y = Math.min(H - 1, Math.max(0, Math.floor((flip ? 1 - y0 : y0) * H)));
      const i = (y * W + x) * 4; return [(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255, d[i + 3] / 255]; };
  } catch { return null; }
}

/** Turns a loaded face model into particles. state(): the page's state name; level(): mic loudness 0..1; speak(): 0..1. */
export function particlize(model, { state = () => 'idle', level = () => 0, speak = () => 0 } = {}) {
  model.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const meshes = [], eyes = [];
  model.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const n = (o.name || '').toLowerCase();
    if (/teeth|tongue|eyelash|casualsuit|shirt|clothes/.test(n)) { o.visible = false; return; }   // inside the mouth, lashes, clothes
    if (/high-?poly|low-?poly|eye(?!brow|lash)/.test(n)) { eyes.push(o); o.visible = false; return; }
    meshes.push(o);
  });
  if (!meshes.length) return null;
  // where the head is, in the model's own space: our faces say so; otherwise guess from the bounding box
  const box = new THREE.Box3().setFromObject(model).applyMatrix4(toModel);
  const meta = model.userData.jvHead || { top: box.max.y, neck: box.max.y - (box.max.y - box.min.y) * 0.35 };
  const span = meta.top - meta.neck, low = meta.neck - span * 0.15;            // no body: the neck fades out under the chin
  const center = new THREE.Vector3(meta.cx || 0, meta.neck + span * 0.55, meta.cz || 0), d = new THREE.Vector3();

  // scatter points over the surfaces, by area
  const area = m => { const g = m.geometry, p = g.attributes.position, idx = g.index; let s = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const n = idx ? idx.count : p.count; for (let i = 0; i < n; i += 3) { const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2); s += b.sub(a).cross(c.sub(a)).length() / 2; } return s; };
  const areas = meshes.map(area), total = areas.reduce((x, y) => x + y, 0) || 1;
  const pos = [], phase = [], fade = [], v = new THREE.Vector3(), nrm = new THREE.Vector3(), col = new THREE.Color(), uv = new THREE.Vector2(), mat = new THREE.Matrix4();
  meshes.forEach((m, k) => {
    const s = new MeshSurfaceSampler(m).build(); mat.multiplyMatrices(toModel, m.matrixWorld);
    const tex = texOf(m), mt = Array.isArray(m.material) ? m.material[0] : m.material;
    const cards = !!(mt && (mt.alphaTest > 0 || mt.transparent)), brow = /brow/i.test(m.name);   // hair, brows: see-through cards
    const want = Math.round(COUNT * 2.4 * areas[k] / total * (brow ? 1.5 : cards ? 0 : 1));   // no hair: a smooth head, like a sculpture of light
    let ref = 0; if (tex && !cards) { for (let i = 0; i < 400; i++) { s.sample(v, nrm, col, uv); ref += tex(uv)[0]; } ref /= 400; }   // the skin's usual tone
    for (let i = 0; i < want; i++) {
      s.sample(v, nrm, col, uv); v.applyMatrix4(mat); if (v.y < low) continue;
      const tx = tex ? tex(uv) : [ref, 1]; if (cards && tx[1] < 0.5) continue;   // skip see-through bits of hair cards
      nrm.transformDirection(mat);
      if (!cards && nrm.dot(d.subVectors(v, center)) < 0) continue;            // inside the mouth and nose: faces pointing inwards
      d.subVectors(v, center).setY(0).normalize(); const outline = Math.pow(1 - Math.abs(nrm.z), 2) * Math.max(0, nrm.x * d.x + nrm.z * d.z);   // the head's outer edge, not creases inside the face
      if (!cards && outline < 0.3 && Math.random() > 0.1 + 0.6 * Math.abs(nrm.z)) continue;   // inside the face: sparse, see-through (creases would pile up)
      const tone = cards ? (brow ? 1.0 : 0.45) : Math.min(1.1, Math.max(0.85, tx[0] / (ref || 1)));
      pos.push(v.x, v.y, v.z); phase.push(Math.random()); fade.push(tone * (0.55 + 0.5 * (1 - Math.abs(nrm.z)) + 1.4 * outline) * Math.min(1, Math.max(0.05, (v.y - low) / (span * 0.3))));   // features and outline bright, the middle of the face see-through
    }
    m.visible = false;
  });
  // evenly lit, what sticks out a touch brighter (strong shading drew a dark muzzle and a bright outline: it looked like a skull)
  let zMax = -Infinity; for (let i = 2; i < pos.length; i += 3) zMax = Math.max(zMax, pos[i]);
  for (let i = 0; i < fade.length; i++) { const zf = Math.min(1, Math.max(0, (pos[i * 3 + 2] - zMax + span * 0.55) / (span * 0.55)));
    fade[i] *= 0.75 + 0.35 * zf; }
  for (let i = 0; i < DUST; i++) {                                               // a few specks of dust floating around the head
    const r = span * (0.75 + Math.random() * 0.7), t = Math.random() * Math.PI * 2, y = (Math.random() * 1.6 - 0.6) * span;
    pos.push(center.x + Math.cos(t) * r, center.y + y, center.z + Math.sin(t) * r * 0.6); phase.push(Math.random()); fade.push(0.08 + Math.random() * 0.25);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  const mouthY = meta.neck + span * 0.27;
  let front = -Infinity; for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - mouthY) < span * 0.04) front = Math.max(front, pos[i + 2]);
  const u = {
    uTime: { value: 0 }, uEnergy: { value: 0.55 }, uSwirl: { value: 0 }, uSize: { value: 1 }, uOpacity: { value: 1 },
    uColor: { value: new THREE.Color(0xffbe5c) }, uMouthY: { value: mouthY }, uMouthZ: { value: (Number.isFinite(front) ? front : 0) - span * 0.06 },
    uSpeak: { value: 0 }, uMic: { value: 0 }, uSpan: { value: span }, uCenter: { value: center },
  };
  const pmat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, pmat); points.frustumCulled = false; points.name = 'jv-particles';
  const pivot = new THREE.Group(); pivot.position.copy(center); points.position.copy(center).negate(); pivot.add(points); model.add(pivot);

  // the eyes: two soft lights
  const lights = [];
  if (eyes.length) {
    const eb = new THREE.Box3(); eyes.forEach(e => eb.expandByObject(e)); eb.applyMatrix4(toModel);
    const c = eb.getCenter(new THREE.Vector3()), dx = (eb.max.x - eb.min.x) / 4, tex = glintTexture();
    for (const sx of [-1, 1]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xfff0d6, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
      sp.position.set(c.x + sx * dx - center.x, c.y - center.y, eb.max.z - center.z); sp.scale.set(span * 0.3, span * 0.15, 1); pivot.add(sp); lights.push(sp);
    }
  }

  // faint orbits of dust around the head, and soft rays of light falling through the dark
  const rp = [], rph = [], rf = [];
  for (const [tilt, rad] of [[0.35, 1.25], [-0.3, 1.5], [1.25, 1.4], [0.9, 1.75]]) for (let i = 0; i < RING; i++) {
    const t = Math.random() * Math.PI * 2, r = span * rad * (0.93 + Math.random() * 0.14), y = Math.sin(t) * r * Math.sin(tilt);
    rp.push(Math.cos(t) * r, y, Math.sin(t) * r * Math.cos(tilt)); rph.push(Math.random()); rf.push(0.15 + 0.6 * Math.random() * Math.random());
  }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  rg.setAttribute('aPhase', new THREE.Float32BufferAttribute(rph, 1)); rg.setAttribute('aFade', new THREE.Float32BufferAttribute(rf, 1));
  const halo = new THREE.Points(rg, pmat); halo.frustumCulled = false; halo.position.copy(center); model.add(halo);
  const rays = [], rtex = rayTexture();
  for (let i = 0; i < 6; i++) {
    const r = new THREE.Sprite(new THREE.SpriteMaterial({ map: rtex, color: 0xffdcae, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    r.userData.o = 0.08 + Math.random() * 0.14; r.scale.set(span * 0.08, span * (0.5 + Math.random() * 0.4), 1);
    r.position.set(center.x + (Math.random() < 0.5 ? -1 : 1) * span * (0.8 + Math.random() * 0.6), center.y + (Math.random() * 3 - 1.4) * span, center.z - span * Math.random());   // beside and behind the head, never across the face
    model.add(r); rays.push(r);
  }

  // every frame: follow what he's doing
  const target = new THREE.Color(), t0 = performance.now();
  let energy = 0.55, swirl = 0;
  const headW = new THREE.Vector3();
  points.onBeforeRender = (renderer, scene, camera) => {
    points.localToWorld(headW.copy(u.uCenter.value));
    u.uSize.value = DOT_PX * renderer.getPixelRatio() * camera.position.distanceTo(headW);   // dots stay the same size on screen
    const [col, glow] = STATE[state()] || STATE.idle, mic = Math.min(1, level());
    energy += (glow + mic * 0.4 - energy) * 0.08; swirl += ((state() === 'thinking' ? 1 : 0) - swirl) * 0.05;
    target.set(col); u.uColor.value.lerp(target, 0.08);
    u.uTime.value = (performance.now() - t0) / 1000;
    pivot.rotation.y = 0.05 * Math.sin(u.uTime.value * 0.31) + 0.02 * Math.sin(u.uTime.value * 0.83);   // facing you, barely moving: alive
    pivot.rotation.x = 0.03 * Math.sin(u.uTime.value * 0.23); u.uEnergy.value = energy; u.uSwirl.value = swirl;
    u.uSpeak.value = speak(); u.uMic.value = state() === 'listening' || state() === 'session' ? mic : 0;
    u.uOpacity.value = pmat.opacity;                                              // the page fades faces in and out with .opacity
    for (const l of lights) { l.material.opacity = pmat.opacity * Math.min(1, 0.8 + energy * 0.2 + (state() === 'thinking' ? 0.2 * Math.sin(u.uTime.value * 6) : 0)); }
    halo.rotation.y = u.uTime.value * 0.05; halo.rotation.x = 0.35 * Math.sin(u.uTime.value * 0.07);
    for (const r of rays) { r.position.y -= span * 0.0025; if (r.position.y < -span * 1.4) r.position.y = span * 1.6; r.material.opacity = pmat.opacity * r.userData.o; }
  };
  return { points, count: pos.length / 3 };   // (the orbits share the dots' material, so they glow and fade with him)
}
