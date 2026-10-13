// boot.js - first script the page runs. Starts the on-device Jarvis (shim) before the face page boots, then adds the phone layout,
// settings and (the first time) the setup walkthrough.
import './shim.js';
import { initSettings } from './settings.js';
import { initUi } from './ui.js';
import { createSetup } from './setup.js';
const go = () => {
  try { initUi(); } catch (e) { console.error('[JARVIS] ui failed', e); }
  try { initSettings(); } catch (e) { console.error('[JARVIS] settings failed', e); }
  try {
    const J = window.JARVIS, setup = createSetup({ config: J.config, say: t => J.announce && J.announce(t) });
    J.setup = setup;
    window.__jvPerm = () => { try { window.__jvPermSetup && window.__jvPermSetup(); } catch {} };   // Android answered a permission question
    if (J.api.ready()) setTimeout(() => setup.maybeAutoOpen(), 600);                                  // (no brain yet: the settings screen comes first)
  } catch (e) { console.error('[JARVIS] setup failed', e); }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
