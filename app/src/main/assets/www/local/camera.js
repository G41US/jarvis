// camera.js - Jarvis's eyes on the phone. Shows a live preview for a moment (so you can see what he's looking at and aim),
// then takes one still as a JPEG data URL. Works while Jarvis is on screen (Android blocks the camera for background apps).
const CSS = `
#jv-cam { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(2,6,12,.72); }
#jv-cam .frame { position: relative; width: min(88vw, 520px); aspect-ratio: 3 / 4; border-radius: 22px; overflow: hidden; border: 2px solid #7fd6ff; box-shadow: 0 0 40px rgba(127,214,255,.35); background: #000; }
#jv-cam video, #jv-cam img { width: 100%; height: 100%; object-fit: cover; display: block; }
#jv-cam .label { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px; font: 600 16px/1.2 'Saira', system-ui, sans-serif; color: #e8f4ff; text-align: center;
  background: linear-gradient(transparent, rgba(0,0,0,.7)); letter-spacing: .02em; }
#jv-cam .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; transition: opacity .25s; }
#jv-cam button { position: absolute; top: 10px; right: 10px; width: 40px; height: 40px; border-radius: 20px; border: 0; background: rgba(0,0,0,.5); color: #fff; font-size: 20px; }
`;

let busy = false;

/**
 * Takes one picture. facing: 'environment' (back) or 'user' (front).
 * Resolves { ok: true, dataUrl, width, height } or { ok: false, error: 'denied' | 'nocamera' | 'busy' | 'cancelled' | message }.
 */
export async function snap({ facing = 'environment', maxSide = 1024, quality = 0.82, previewMs = 1300, label = 'Looking…', keepMs = 700 } = {}) {
  if (busy) return { ok: false, error: 'busy' };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: false, error: 'nocamera' };
  busy = true;
  if (!document.getElementById('jv-cam-css')) { const s = document.createElement('style'); s.id = 'jv-cam-css'; s.textContent = CSS; document.head.append(s); }
  const ov = document.createElement('div'); ov.id = 'jv-cam';
  ov.innerHTML = '<div class="frame"><video playsinline muted autoplay></video><div class="flash"></div><div class="label"></div><button aria-label="Cancel">×</button></div>';
  ov.querySelector('.label').textContent = label;
  let cancelled = false; ov.querySelector('button').onclick = () => { cancelled = true; };
  document.body.append(ov);
  const video = ov.querySelector('video');
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    video.srcObject = stream;
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('the camera did not start')), 6000); video.onloadeddata = () => { clearTimeout(t); res(); }; });
    try { await video.play(); } catch {}
    const until = performance.now() + previewMs;                       // let focus and exposure settle; the user can aim
    while (performance.now() < until && !cancelled) await new Promise(r => setTimeout(r, 50));
    if (cancelled) return { ok: false, error: 'cancelled' };
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 960, k = Math.min(1, maxSide / Math.max(vw, vh));
    const c = document.createElement('canvas'); c.width = Math.round(vw * k); c.height = Math.round(vh * k);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', quality);
    const fl = ov.querySelector('.flash'); fl.style.opacity = '0.85'; setTimeout(() => { fl.style.opacity = '0'; }, 90);
    const img = document.createElement('img'); img.src = dataUrl; video.replaceWith(img);   // freeze on the picture he took
    ov.querySelector('.label').textContent = 'Got it';
    await new Promise(r => setTimeout(r, keepMs));
    return { ok: true, dataUrl, width: c.width, height: c.height };
  } catch (e) {
    const n = (e && e.name) || '';
    return { ok: false, error: n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nocamera' : String((e && e.message) || e) };
  } finally {
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {}
    ov.remove(); busy = false;
  }
}
