// particles.js - Jarvis's face as glowing particles instead of a realistic person. A loaded face model is only used for its
// shape: thousands of points are scattered over its surface, the mesh is hidden, and two lights sit in the eyes.
// The points react to what he's doing: a slow shimmer while waiting, ripples with your voice while listening, a brighter
// swirl while thinking, a pulse around the mouth while talking.
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

const COUNT = 16000, DOT_PX = 1.8;
const STATE = {                                     // [colour, glow] for each state (colour tints the gold a little)
  idle: [0xffd9a0, 0.55], standby: [0xffd9a0, 0.55], session: [0xbff7e4, 0.8], listening: [0xbff7e4, 0.85],
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
  vAlpha = aFade * (0.55 + 0.45 * (0.5 + 0.5 * tw));
  gl_PointSize = uSize * (0.7 + 0.6 * fract(aPhase * 7.31)) * (1.0 + vHot * 0.8) / max(0.1, -mv.z);
}`;
const FRAG = `
uniform vec3 uColor; uniform float uEnergy, uOpacity;
varying float vAlpha; varying float vHot;
void main() {
  float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uColor * (0.6 + uEnergy * 0.7 + vHot), core * core * vAlpha * uOpacity * (0.45 + uEnergy * 0.5));
}`;

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,230,180,0.7)'); r.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
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
  const span = meta.top - meta.neck, low = meta.neck - span * 0.3;             // keep the neck, fade out at the shoulders
  const center = new THREE.Vector3(meta.cx || 0, meta.neck + span * 0.55, meta.cz || 0), d = new THREE.Vector3();

  // scatter points over the surfaces, by area
  const area = m => { const g = m.geometry, p = g.attributes.position, idx = g.index; let s = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const n = idx ? idx.count : p.count; for (let i = 0; i < n; i += 3) { const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2); s += b.sub(a).cross(c.sub(a)).length() / 2; } return s; };
  const areas = meshes.map(area), total = areas.reduce((x, y) => x + y, 0) || 1;
  const pos = [], phase = [], fade = [], rim = [], v = new THREE.Vector3(), nrm = new THREE.Vector3(), col = new THREE.Color(), uv = new THREE.Vector2(), mat = new THREE.Matrix4();
  meshes.forEach((m, k) => {
    const s = new MeshSurfaceSampler(m).build(); mat.multiplyMatrices(toModel, m.matrixWorld);
    const brow = /brow/i.test(m.name), want = Math.round(COUNT * 2.4 * areas[k] / total * (brow ? 5 : 1)), tex = texOf(m), mt = Array.isArray(m.material) ? m.material[0] : m.material;
    const cards = !!(mt && (mt.alphaTest > 0 || mt.transparent));                 // hair, brows: see-through cards
    let ref = 0; if (tex && !cards) { for (let i = 0; i < 400; i++) { s.sample(v, nrm, col, uv); ref += tex(uv)[0]; } ref /= 400; }   // the skin's usual tone
    for (let i = 0; i < want; i++) {
      s.sample(v, nrm, col, uv); v.applyMatrix4(mat); if (v.y < low) continue;
      const tx = tex ? tex(uv) : [ref, 1]; if (cards && tx[1] < 0.5) continue;   // skip see-through bits of hair cards
      nrm.transformDirection(mat);
      if (!cards && nrm.dot(d.subVectors(v, center)) < 0) continue;            // inside the mouth and nose: faces pointing inwards
      const edge = Math.pow(1 - Math.abs(nrm.z), 2), tone = cards ? (brow ? 1.6 : 0.7) : Math.min(1.2, Math.max(0.6, tx[0] / (ref || 1)));
      pos.push(v.x, v.y, v.z); phase.push(Math.random()); fade.push(tone * Math.min(1, Math.max(0.05, (v.y - low) / (span * 0.3)))); rim.push(edge);
    }
    m.visible = false;
  });
  // what sticks out (nose, lips, brows, cheekbones, chin) glows brighter, like a depth map, and the outline glows too:
  // that's what makes a face read from the front
  let zMax = -Infinity; for (let i = 2; i < pos.length; i += 3) zMax = Math.max(zMax, pos[i]);
  for (let i = 0; i < fade.length; i++) { const zf = Math.min(1, Math.max(0, (pos[i * 3 + 2] - zMax + span * 0.55) / (span * 0.55)));
    fade[i] *= Math.min(1.5, 0.12 + 1.1 * Math.pow(zf, 3) + 0.55 * rim[i]); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  const mouthY = meta.neck + span * 0.27;
  let front = -Infinity; for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - mouthY) < span * 0.04) front = Math.max(front, pos[i + 2]);
  const u = {
    uTime: { value: 0 }, uEnergy: { value: 0.55 }, uSwirl: { value: 0 }, uSize: { value: 1 }, uOpacity: { value: 1 },
    uColor: { value: new THREE.Color(0xffd9a0) }, uMouthY: { value: mouthY }, uMouthZ: { value: (Number.isFinite(front) ? front : 0) - span * 0.06 },
    uSpeak: { value: 0 }, uMic: { value: 0 }, uSpan: { value: span }, uCenter: { value: center },
  };
  const pmat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, pmat); points.frustumCulled = false; points.name = 'jv-particles';
  model.add(points);

  // the eyes: two soft lights
  const lights = [];
  if (eyes.length) {
    const eb = new THREE.Box3(); eyes.forEach(e => eb.expandByObject(e)); eb.applyMatrix4(toModel);
    const c = eb.getCenter(new THREE.Vector3()), dx = (eb.max.x - eb.min.x) / 4, tex = glowTexture();
    for (const sx of [-1, 1]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffe2b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.position.set(c.x + sx * dx, c.y, eb.max.z + span * 0.02); sp.scale.setScalar(span * 0.07); model.add(sp); lights.push(sp);
    }
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
    u.uTime.value = (performance.now() - t0) / 1000; u.uEnergy.value = energy; u.uSwirl.value = swirl;
    u.uSpeak.value = speak(); u.uMic.value = state() === 'listening' || state() === 'session' ? mic : 0;
    u.uOpacity.value = pmat.opacity;                                              // the page fades faces in and out with .opacity
    for (const l of lights) { l.material.opacity = pmat.opacity * (0.25 + energy * 0.35 + (state() === 'thinking' ? 0.35 + 0.2 * Math.sin(u.uTime.value * 6) : 0)); l.material.color.copy(u.uColor.value); }
  };
  return { points, count: pos.length / 3 };
}
