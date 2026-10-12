// boot.js - first script the page runs. Starts the on-device Jarvis (shim) before the face page boots, then adds the phone layout and settings.
import './shim.js';
import { initSettings } from './settings.js';
import { initUi } from './ui.js';
const go = () => {
  try { initUi(); } catch (e) { console.error('[JARVIS] ui failed', e); }
  try { initSettings(); } catch (e) { console.error('[JARVIS] settings failed', e); }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
