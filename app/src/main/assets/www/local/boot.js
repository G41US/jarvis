// boot.js - first script the page runs. Starts the on-device Jarvis (shim) before the face page boots, then adds the settings screen.
import './shim.js';
import { initSettings } from './settings.js';
const go = () => { try { initSettings(); } catch (e) { console.error('[JARVIS] settings failed', e); } };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
