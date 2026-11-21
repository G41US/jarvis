// boot.js - first script the page runs. Starts the on-device Jarvis (shim) before the face page boots, then adds the phone layout,
// settings and (the first time) the setup walkthrough.
import './shim.js';
import { initSettings } from './settings.js';
import { initUi } from './ui.js';
import { initPages } from './pages.js';
import { createSetup } from './setup.js';
import { initCards } from './cards.js';
import { initDeliveryMode } from './dmode.js';
// The globe's pictures: the blue marble ships in the app, the rest come straight from NASA's GIBS (it allows other sites to use them)
const GIBS = (layer, [w, s, e, n], width, extra = '') => 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1' +
  `&LAYERS=${layer}&STYLES=&SRS=EPSG:4326&BBOX=${w},${s},${e},${n}&WIDTH=${width}&HEIGHT=${Math.max(64, Math.min(2048, Math.round(width * (n - s) / (e - w))))}&FORMAT=image/jpeg${extra}`;
const SAT = 'VIIRS_SNPP_CorrectedReflectance_TrueColor', BLUE = 'BlueMarble_ShadedRelief_Bathymetry';
const yesterday = () => '&TIME=' + new Date(Date.now() - 86400000).toISOString().slice(0, 10);
export function globeUrl(p) {
  if (p === '/globe/tex/blue') return '/models/globe/blue.jpg';
  if (p === '/globe/tex/night') return GIBS('VIIRS_Black_Marble', [-180, -90, 180, 90], 2048);
  if (p === '/globe/tex/sat') return GIBS(SAT, [-180, -90, 180, 90], 2048, yesterday());
  const m = /^\/globe\/patch\?kind=(\w+)&w=([-\d.]+)&s=([-\d.]+)&e=([-\d.]+)&n=([-\d.]+)/.exec(p);
  if (m) return GIBS(m[1] === 'sat' ? SAT : BLUE, [m[2], m[3], m[4], m[5]].map(Number), 1024, m[1] === 'sat' ? yesterday() : '');
  return p;
}
const go = () => {
  try { initUi(); } catch (e) { console.error('[JARVIS] ui failed', e); }
  try { initPages(); } catch (e) { console.error('[JARVIS] pages failed', e); }
  try { initSettings(); } catch (e) { console.error('[JARVIS] settings failed', e); }
  try { initCards(); } catch (e) { console.error('[JARVIS] cards failed', e); }
  try { initDeliveryMode(); } catch (e) { console.error('[JARVIS] delivery mode failed', e); }
  window.__jvGlobeUrl = globeUrl;
  import('../hud_extra.js').catch(e => console.error('[JARVIS] globe failed', e));     // the PC's globe (make_www.py copies it in)
  try {
    const J = window.JARVIS, setup = createSetup({ config: J.config, say: t => J.announce && J.announce(t) });
    J.setup = setup;
    window.__jvPerm = () => { try { window.__jvPermSetup && window.__jvPermSetup(); } catch {} };   // Android answered a permission question
    if (J.api.ready()) setTimeout(() => setup.maybeAutoOpen(), 600);                                  // (no brain yet: the settings screen comes first)
  } catch (e) { console.error('[JARVIS] setup failed', e); }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
