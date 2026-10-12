// shim.js - the "server" that lives inside the app. The page still talks to /chat_stream, /speak, /ws, /audio ... exactly as it did on
// the PC; here those calls are answered on the phone: fetch() and WebSocket are intercepted, the voice goes through Android's text-to-speech,
// and Jarvis's brain, delivery copilot and navigation all run in JavaScript. Nothing leaves the phone except calls to Groq and the map services.
import { kv, makeHttp, realFetch, nativeHttp } from './net.js';
import { Registry } from './tools.js';
import { Navigator } from './navlib.js';
import { Copilot } from './delivery.js';
import { createNavService } from './navsvc.js';
import { registerDeliveryTools } from './tools_delivery.js';
import { registerGeneralTools, timeOfDay } from './tools_general.js';
import { createBrain } from './brain.js';
import { SttPipeline } from './stt.js';

const W = window; W.JARVIS_NATIVE = true;
const bridge = () => W.AndroidBridge || null;
const log = (...a) => console.log('[JARVIS]', ...a);

// ---------------------------------------------------------------- settings
const cfgStore = { get(k, d = null) { const c = kv.get('config', {}) || {}; return c[k] === undefined ? d : c[k]; }, set(k, v) { const c = kv.get('config', {}) || {}; c[k] = v; kv.set('config', c); },
  all() { return kv.get('config', {}) || {}; }, merge(o) { kv.set('config', { ...this.all(), ...o }); } };
export const config = cfgStore;

const openUrl = url => { try { if (bridge() && bridge().openUrl) bridge().openUrl(url); else W.open(url, '_blank'); } catch (e) { log('openUrl', e); } };

// ---------------------------------------------------------------- sockets (/ws push messages, /audio mic stream)
const wsSockets = new Set(), audioSockets = new Set();
const broadcast = msg => { for (const s of wsSockets) s._deliver(msg); };
const RealWS = W.WebSocket;
const isLocalWS = url => { try { const u = new URL(url, location.href); return /\/(ws|audio)$/.test(u.pathname) && (u.host === location.host || /^(127\.0\.0\.1|localhost)/.test(u.host)); } catch { return false; } };
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    this.url = url; this.readyState = 0; this.binaryType = 'arraybuffer'; this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null; this._l = {};
    this.kind = new URL(url, location.href).pathname.endsWith('/audio') ? 'audio' : 'ws';
    setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; (this.kind === 'audio' ? audioSockets : wsSockets).add(this); this._emit('open', {}); }, 0);
  }
  get OPEN() { return 1; }
  addEventListener(t, f) { (this._l[t] ||= []).push(f); } removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter(x => x !== f); }
  _emit(t, ev) { const h = this['on' + t]; try { if (h) h.call(this, ev); } catch (e) { console.error(e); } for (const f of (this._l[t] || [])) try { f.call(this, ev); } catch (e) { console.error(e); } }
  _deliver(data) { if (this.readyState === 1) this._emit('message', { data }); }
  send(data) { if (this.kind === 'audio' && this.readyState === 1) stt.feed(data instanceof ArrayBuffer ? new Int16Array(data) : data); }
  close() { if (this.readyState === 3) return; this.readyState = 3; wsSockets.delete(this); audioSockets.delete(this); this._emit('close', { code: 1000 }); }
}
function LocalAwareWebSocket(url, protocols) { return isLocalWS(url) ? new FakeWS(url) : new RealWS(url, protocols); }
Object.assign(LocalAwareWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); LocalAwareWebSocket.prototype = RealWS.prototype;
W.WebSocket = LocalAwareWebSocket;

// ---------------------------------------------------------------- text to speech (Android's engine)
const tts = { active: new Map(), uid: 0, voices: [], loaded: false };
function loadVoices() {
  if (tts.voices.length) return tts.voices;                       // the engine may still be starting; ask again until it answers
  try { if (bridge() && bridge().ttsVoices) tts.voices = JSON.parse(bridge().ttsVoices() || '[]'); } catch { tts.voices = []; }
  return tts.voices;
}
const genderHint = () => (cfgStore.get('avatar_gender', 'male') === 'female' ? 'amy' : 'adam');
const voiceList = () => loadVoices().map((v, i) => ({ id: `${genderHint()}~${v.id}`, name: `${v.label || v.id}${v.lang ? ' · ' + v.lang : ''}`, raw: v.id }));
function applyVoice() { const cur = cfgStore.get('voice', ''); const raw = cur.includes('~') ? cur.split('~').slice(1).join('~') : cur; try { if (bridge() && bridge().ttsSetVoice) bridge().ttsSetVoice(raw || ''); } catch {} }
function setVoice(name) {
  const list = voiceList(), q = String(name || '').toLowerCase().trim(); const hit = list.find(v => v.id.toLowerCase() === q || v.name.toLowerCase().includes(q) || v.raw.toLowerCase().includes(q));
  if (!hit) return null; cfgStore.set('voice', hit.id); applyVoice(); return hit.name;
}
if (bridge() && bridge().ttsSpeak) {
  W.SpeechSynthesisUtterance = class { constructor(text) { this.text = String(text || ''); this.rate = 1; this.pitch = 1; this.volume = 1; this.lang = ''; this.voice = null; this.onend = null; this.onerror = null; this.onstart = null; } };
  W.__ttsEvent = (id, ev) => { const u = tts.active.get(id); if (!u) return; tts.active.delete(id); try { if (ev === 'done') u.onend && u.onend({}); else u.onerror && u.onerror({}); } catch (e) { console.error(e); } };
  const synth = {
    speak(u) { const id = ++tts.uid; tts.active.set(id, u); try { u.onstart && u.onstart({}); bridge().ttsSpeak(id, u.text, u.rate || 1, u.pitch || 1); } catch (e) { tts.active.delete(id); u.onerror && u.onerror({}); } },
    cancel() { try { bridge().ttsStop(); } catch {} const pend = [...tts.active.values()]; tts.active.clear(); pend.forEach(u => { try { u.onend && u.onend({}); } catch {} }); },
    getVoices() { return []; }, pause() {}, resume() {}, get speaking() { return tts.active.size > 0; }, get pending() { return false; }, get paused() { return false; },
    addEventListener() {}, removeEventListener() {},
  };
  try { Object.defineProperty(W, 'speechSynthesis', { value: synth, configurable: true, writable: true }); } catch { try { W.speechSynthesis = synth; } catch {} }
  applyVoice();
}

// ---------------------------------------------------------------- services
const NAV_UA = 'JarvisNavigation/1.0 (personal use; jarvis-android)';
const httpJson = makeHttp({ userAgent: NAV_UA, language: 'en', timeoutMs: 12000, log });
const reg = new Registry();
const navigator_ = new Navigator({ language: cfgStore.get('nav_language', 'en-US'), units: cfgStore.get('units', 'auto') }, httpJson);
function deliveryConfig() {
  const c = cfgStore.all(), d = {};
  if (c.currency) d.currency = c.currency; if (c.units && c.units !== 'auto') d.units = c.units;
  if (c.areas) d.areas = String(c.areas).split(',').map(s => s.trim()).filter(Boolean); if (c.min_per_hour) d.min_per_hour = Number(c.min_per_hour); if (c.min_per_mile) d.min_per_mile = Number(c.min_per_mile);
  if (c.traffic_factor) d.traffic_factor = Number(c.traffic_factor);
  return d;
}
const delivery = new Copilot(kv, deliveryConfig(), { broadcast, http: httpJson });
const navsvc = createNavService({ reg, config: cfgStore, delivery, broadcast, openUrl, navigator: navigator_ });
const dtools = registerDeliveryTools({ reg, delivery, navsvc, openUrl });
let brain = null;
const gctx = { reg, kv, http: httpJson, broadcast, config: cfgStore, delivery, navsvc, openUrl, voices: voiceList, setVoice, onMemoryChange: () => brain && brain.refreshPrompt(), llm: t => brain.llm(t), clearConversation: () => brain && brain.clearConversation() };
registerGeneralTools(gctx);
const briefingFast = async text => (/\b(morning briefing|brief me|briefing|what.?s my day|what.?s on today)\b/i.test(text) ? (await gctx.briefingText())[0] : null);
brain = createBrain({ reg, kv, config: cfgStore, fastpaths: [briefingFast, navsvc.fastpath, dtools.fastpath], log });
log(`on-device Jarvis ready: ${reg.schemas.length} tools, native http: ${nativeHttp()}`);

/** Re-read settings after the settings screen saves. */
export function applySettings() {
  Object.assign(delivery.cfg, deliveryConfig());
  const u = String(cfgStore.get('units', 'auto')).toLowerCase(); delivery._unitsFixed = ['miles', 'mi', 'km'].includes(u); if (delivery._unitsFixed) delivery.units = u === 'km' ? 'km' : 'miles';
  navigator_.cfg.units = cfgStore.get('units', 'auto'); navigator_.cfg.language = cfgStore.get('nav_language', 'en-US');
  brain.refreshPrompt(); applyVoice();
  broadcast('nav:' + JSON.stringify({ cmd: 'provider', value: cfgStore.get('map_provider', 'jarvis'), cfg: navsvc.config() }));
  broadcast('nav:' + JSON.stringify({ cmd: 'theme', value: cfgStore.get('map_theme', 'auto') }));
}

// ---------------------------------------------------------------- speech in
function deliverTranscript(text) {
  for (const s of audioSockets) { s._deliver(JSON.stringify({ type: 'transcript', text })); s._deliver(JSON.stringify({ type: 'partial', text })); }
}
const stt = new SttPipeline({ getKey: () => brain.key(), getConfig: (k, d) => cfgStore.get(k, d), onTranscript: deliverTranscript, onNotice: t => broadcast('proactive:' + t), log });
W.JARVIS = { wake: () => deliverTranscript('Hey Jarvis'), say: t => deliverTranscript(t), applySettings, config: cfgStore, brain, navsvc, delivery, reg, verifyKey: () => brain.verifyKey(), voices: voiceList, setVoice, stt, speakTest: t => W.speechSynthesis && W.speechSynthesis.speak(new W.SpeechSynthesisUtterance(t || 'Jarvis online.')) };

// ---------------------------------------------------------------- the local "HTTP server"
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
async function handle(method, path, query, body, signal) {
  switch (path) {
    case '/chat_stream': {
      const ctl = new AbortController(); if (signal) signal.addEventListener('abort', () => ctl.abort());
      const enc = new TextEncoder(); const it = brain.chat(String((body && body.text) || ''), ctl.signal)[Symbol.asyncIterator]();
      const stream = new ReadableStream({
        async pull(c) { try { const { value, done } = await it.next(); if (done) { c.close(); return; } c.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch (e) { c.error(e); } },
        cancel() { ctl.abort(); try { it.return(); } catch {} } });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }
    case '/speak': return new Response(null, { status: 204 });                    // the page then speaks with Android's voice (browserSpeak)
    case '/greeting': { const name = (query.get('name') || cfgStore.get('user_name', '') || '').trim(), tod = timeOfDay(); return json({ text: name ? `${tod}, ${name}.` : `${tod}.`, name, title: '', time_of_day: tod }); }
    case '/briefing': { const [text, has] = await gctx.briefingText(); return json({ text, has_data: has }); }
    case '/voices': return json(voiceList().map(v => ({ id: v.id, name: v.name })));
    case '/get_voice': { const cur = cfgStore.get('voice', '') || (voiceList()[0] || {}).id || ''; const v = voiceList().find(x => x.id === cur); return json({ voice: cur, friendly: v ? v.name : cur }); }
    case '/set_voice': { const n = setVoice(body && body.voice); return n ? json({ ok: true, voice: body.voice, friendly: n }) : json({ ok: false, error: 'invalid voice' }); }
    case '/delivery/plan': { const p = await delivery.plan(); return json(p.ok ? p : {}); }
    case '/nav/config': return json(navsvc.config());
    case '/nav/position': return json(await navsvc.position(body || {}));
    case '/nav/progress': return json(navsvc.progress(body || {}));
    case '/nav/ended': return json(navsvc.ended());
    case '/nav/reroute': { const lat = parseFloat(body && body.lat), lon = parseFloat(body && body.lon); return json(Number.isFinite(lat) && Number.isFinite(lon) ? await navsvc.reroute(lat, lon) : { ok: false, error: 'I need your position to reroute.' }); }
    case '/faces': case '/documents': return json([]);
    case '/identify_face': case '/enroll_face_direct': return json({ ok: false, recognized: false, error: 'not available on the phone' });
    case '/wake': return json({ ok: true });
    default:
      if (path.startsWith('/identify_ws/') || path.startsWith('/enroll_face_ws/') || path.startsWith('/vision_capture/')) return json({ ok: true });
      return null;
  }
}
const LOCAL_PATHS = /^\/(chat_stream|speak|greeting|briefing|voices|get_voice|set_voice|delivery\/plan|nav\/(config|position|progress|ended|reroute)|faces|documents|identify_face|enroll_face_direct|wake|identify_ws\/|enroll_face_ws\/|vision_capture\/)/;
W.fetch = async function (input, init = {}) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href); } catch { return realFetch(input, init); }
  if (url.origin !== location.origin || !LOCAL_PATHS.test(url.pathname)) return realFetch(input, init);
  const method = (init.method || (input && input.method) || 'GET').toUpperCase(); let body = null;
  if (init.body != null) { try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { body = null; } }
  try { const r = await handle(method, url.pathname, url.searchParams, body, init.signal); return r || new Response('not found', { status: 404 }); }
  catch (e) { console.error('[JARVIS] local endpoint failed', url.pathname, e); return json({ ok: false, error: String(e && e.message || e) }, 500); }
};
