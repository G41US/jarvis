// shim.js - the "server" that lives inside the app. The page still talks to /chat_stream, /speak, /ws, /audio ... exactly as it did on
// the PC; here those calls are answered on the phone: fetch() and WebSocket are intercepted, the voice goes through Android's text-to-speech,
// the microphone and the "Hey Jarvis" wake word run natively (VoiceEngine.java), and Jarvis's brain, delivery copilot and navigation run here.
import { kv, makeHttp, realFetch, nativeHttp, b64ToBytes } from './net.js';
import { Registry } from './tools.js';
import { Navigator } from './navlib.js';
import { Copilot } from './delivery.js';
import { createNavService } from './navsvc.js';
import { registerDeliveryTools } from './tools_delivery.js';
import { registerGeneralTools, timeOfDay, parseWhen } from './tools_general.js';
import { registerPhoneTools } from './tools_phone.js';
import { createBrain } from './brain.js';
import { SttPipeline } from './stt.js';
import { createApi } from './api.js';
import { describeVoices, pickVoice, fallbackPitch } from './voices.js';

const W = window; W.JARVIS_NATIVE = true;
const bridge = () => W.AndroidBridge || null;
const has = m => !!(bridge() && typeof bridge()[m] === 'function');
const log = (...a) => console.log('[JARVIS]', ...a);
W.JARVIS_NATIVE_MIC = has('micStart');                 // the page skips its own microphone code when the app records natively

// ---------------------------------------------------------------- settings
const cfgStore = { get(k, d = null) { const c = kv.get('config', {}) || {}; const v = c[k]; return v === undefined || v === null || v === '' ? d : v; },   /* a blank box means 'use the default' */ set(k, v) { const c = kv.get('config', {}) || {}; c[k] = v; kv.set('config', c); },
  all() { return kv.get('config', {}) || {}; }, merge(o) { kv.set('config', { ...this.all(), ...o }); } };
export const config = cfgStore;
const api = createApi(cfgStore);

const openUrl = url => { try { if (has('openUrl')) bridge().openUrl(url); else W.open(url, '_blank'); } catch (e) { log('openUrl', e); } };

// ---------------------------------------------------------------- sockets (/ws push messages, /audio transcripts)
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
  send(data) { if (this.kind === 'audio' && this.readyState === 1) ears.feed(data instanceof ArrayBuffer ? new Int16Array(data) : data); }   // browser-mic fallback
  close() { if (this.readyState === 3) return; this.readyState = 3; wsSockets.delete(this); audioSockets.delete(this); this._emit('close', { code: 1000 }); }
}
function LocalAwareWebSocket(url, protocols) { return isLocalWS(url) ? new FakeWS(url) : new RealWS(url, protocols); }
Object.assign(LocalAwareWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); LocalAwareWebSocket.prototype = RealWS.prototype;
W.WebSocket = LocalAwareWebSocket;

// ---------------------------------------------------------------- voices
// First choice: the PC's own Piper voices, Alan (male) and Amy (female), run on the phone (PiperTts.java).
// Until one is downloaded (about 67 MB, once), the phone's own voices stand in, matched by gender.
const tts = { active: new Map(), uid: 0, pitchMul: 1 };
const PC = { m: { name: 'alan', label: 'Alan · your PC voice' }, f: { name: 'amy', label: 'Amy · your PC voice' } };
let rawVoices = [], pcState = {};
function loadVoices() { if (!rawVoices.length && has('ttsVoices')) { try { rawVoices = JSON.parse(bridge().ttsVoices() || '[]'); } catch { rawVoices = []; } } return rawVoices; }
function readPc() { if (has('pcVoices')) { try { pcState = JSON.parse(bridge().pcVoices() || '{}'); } catch { pcState = {}; } } return pcState; }
const pcReady = name => readPc()[name] === 'ready';
const gender = () => (cfgStore.get('avatar_gender', 'male') === 'female' ? 'f' : 'm');
const hint = g => (g === 'f' ? 'amy' : 'adam');                 // the page picks the face from these words in the voice id
const described = () => describeVoices(loadVoices());
const pcStateText = name => { const st = String(readPc()[name] || 'missing'); return st === 'ready' ? '' : st.startsWith('downloading') ? ` (downloading ${st.split(':')[1] || 0}%)` : ' (not downloaded)'; };
const voiceList = () => {
  const pc = has('pcVoices') && !readPc().unavailable ? ['m', 'f'].map(g => ({ id: `${hint(g)}~pc:${PC[g].name}`, name: PC[g].label + pcStateText(PC[g].name), raw: `pc:${PC[g].name}`, gender: g, pc: true })) : [];
  return [...pc, ...described().map(v => ({ id: `${hint(v.gender || gender())}~${v.raw}`, name: v.name, raw: v.raw, gender: v.gender }))];
};
function chosenVoice() {
  const g = gender(), cur = String(cfgStore.get('voice', '') || ''), raw = cur.includes('~') ? cur.split('~').slice(1).join('~') : cur;
  // the PC voice when it's chosen (or "best match") and downloaded
  if ((!raw || raw === `pc:${PC[g].name}`) && pcReady(PC[g].name)) return { raw: `pc:${PC[g].name}`, name: PC[g].label, pitch: 1, id: `${hint(g)}~pc:${PC[g].name}`, gender: g, pc: PC[g].name };
  const list = described();
  let v = raw.startsWith('pc:') ? null : list.find(x => x.raw === raw);
  if (!v || (v.gender && v.gender !== g)) v = pickVoice(list, g) || (v && !v.gender ? v : null);
  const real = !!(v && v.gender === g);
  return { raw: v ? v.raw : '', name: v ? v.name : (g === 'm' ? 'Phone voice, deeper' : 'Phone voice, higher'), pitch: real ? 1 : fallbackPitch(g), id: `${hint(g)}~${v ? v.raw : 'default'}`, gender: g, pc: '' };
}
function applyVoice() {
  const c = chosenVoice(); tts.pitchMul = c.pitch;
  try { if (has('pcVoiceUse')) bridge().pcVoiceUse(c.pc || ''); if (!c.pc && has('ttsSetVoice')) bridge().ttsSetVoice(c.raw || ''); } catch {}
  return c;
}
function announceVoice() { const c = applyVoice(); broadcast(`voice_changed:${c.id}|${c.name}`); return c; }
/** Fetch the PC voice for the current face: automatically on Wi-Fi, or when asked (force). */
function ensurePcVoice(force = false) {
  if (!has('pcVoiceDownload')) return; const want = PC[gender()].name, st = String(readPc()[want] || '');
  if (st === 'ready' || st.startsWith('downloading')) return;
  let wifi = false; try { wifi = has('unmetered') && bridge().unmetered(); } catch {}
  if (force || wifi) bridge().pcVoiceDownload(want);
}
let pcWasReady = {};
W.__jvVoices = json => {
  try { pcState = JSON.parse(json); } catch { return; }
  for (const n of ['alan', 'amy']) { const now = pcState[n] === 'ready'; if (now && !pcWasReady[n] && PC[gender()].name === n) announceVoice(); pcWasReady[n] = now; }
  if (W.JARVIS && W.JARVIS.onVoices) try { W.JARVIS.onVoices(pcState); } catch {}
};
function setVoice(q) {
  const t = String(q || '').toLowerCase().trim();
  if (/\b(female|woman|girl|lady|her|she|amy)\b/.test(t)) { cfgStore.merge({ avatar_gender: 'female', voice: '' }); ensurePcVoice(); return announceVoice().name; }
  if (/\b(male|man|guy|him|he|deeper|alan)\b/.test(t)) { cfgStore.merge({ avatar_gender: 'male', voice: '' }); ensurePcVoice(); return announceVoice().name; }
  const hit = voiceList().find(v => v.id.toLowerCase() === t || v.raw.toLowerCase() === t || v.name.toLowerCase().includes(t));
  if (!hit) return null;
  const up = { voice: hit.id }; if (hit.gender) up.avatar_gender = hit.gender === 'f' ? 'female' : 'male';
  cfgStore.merge(up); if (hit.pc) ensurePcVoice(true); return announceVoice().name;
}

// ---------------------------------------------------------------- text to speech (Android's engine)
if (has('ttsSpeak')) {
  W.SpeechSynthesisUtterance = class { constructor(text) { this.text = String(text || ''); this.rate = 1; this.pitch = 1; this.volume = 1; this.lang = ''; this.voice = null; this.onend = null; this.onerror = null; this.onstart = null; } };
  const finish = (id, ev) => {
    const e = tts.active.get(id); if (!e) return; tts.active.delete(id); clearTimeout(e.timer);
    try { if (ev === 'done') e.u.onend && e.u.onend({}); else e.u.onerror && e.u.onerror({}); } catch (err) { console.error(err); }
  };
  W.__ttsEvent = (id, ev) => finish(id, ev);
  const synth = {
    speak(u) {
      const id = ++tts.uid, rate = u.rate || 1;
      // Watchdog: if the phone's speech engine never reports back, carry on anyway instead of freezing in "speaking".
      const timer = setTimeout(() => { log('tts watchdog released', id); finish(id, 'done'); }, 2500 + u.text.length * 95 / Math.max(0.5, rate));
      tts.active.set(id, { u, timer });
      try { u.onstart && u.onstart({}); bridge().ttsSpeak(id, u.text, rate, (u.pitch || 1) * tts.pitchMul); } catch (e) { finish(id, 'error'); }
    },
    cancel() { try { bridge().ttsStop(); } catch {} for (const id of [...tts.active.keys()]) finish(id, 'done'); },
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
Object.assign(gctx, { api, parseWhen });
const phone = registerPhoneTools(gctx);                 // also gives gctx reminderItems / calendarToday for the briefing
const briefingFast = async text => (/\b(morning briefing|brief me|briefing|what.?s my day|what.?s on today)\b/i.test(text) ? (await gctx.briefingText())[0] : null);
brain = createBrain({ reg, kv, config: cfgStore, api, fastpaths: [briefingFast, navsvc.fastpath, dtools.fastpath], log });
log(`on-device Jarvis ready: ${reg.schemas.length} tools, native http: ${nativeHttp()}, native mic: ${W.JARVIS_NATIVE_MIC}, brain: ${api.mode() || 'no key'}`);

/** Re-read settings after the settings screen saves. */
export function applySettings({ voiceChanged = false } = {}) {
  Object.assign(delivery.cfg, deliveryConfig());
  const u = String(cfgStore.get('units', 'auto')).toLowerCase(); delivery._unitsFixed = ['miles', 'mi', 'km'].includes(u); if (delivery._unitsFixed) delivery.units = u === 'km' ? 'km' : 'miles';
  navigator_.cfg.units = cfgStore.get('units', 'auto'); navigator_.cfg.language = cfgStore.get('nav_language', 'en-US');
  brain.refreshPrompt(); if (voiceChanged) announceVoice(); else applyVoice();
  const th = Number(cfgStore.get('wake_sensitivity', 0.3)); if (has('setWakeThreshold') && th) bridge().setWakeThreshold(th);
  if (typeof pushOfferPrefs === 'function') pushOfferPrefs();
  broadcast('nav:' + JSON.stringify({ cmd: 'provider', value: cfgStore.get('map_provider', 'jarvis'), cfg: navsvc.config() }));
  broadcast('nav:' + JSON.stringify({ cmd: 'theme', value: cfgStore.get('map_theme', 'auto') }));
}

// ---------------------------------------------------------------- offer reader (OfferReaderService.java)
let lastOffer = null;
W.__jvOffer = (json, speakHere) => {
  try { lastOffer = { ...JSON.parse(json), at: Date.now() }; } catch { return; }
  stats.lastOffer = lastOffer;
  if (speakHere) broadcast('proactive:' + lastOffer.spoken);          // Jarvis on screen: he says it (and the mic stays shut while he does)
};
reg.add('screen_offer', "The last DoorDash or Uber Eats offer Jarvis read off the driver's screen, with the verdict (take it / your call / pass). Use for 'what was that offer', 'should I take it', 'was that worth it'.",
  {}, [], () => {
    if (!lastOffer) return "I haven't seen an offer yet. Turn on the offer reader in my settings, then offers in the Dasher or Uber Driver app are read automatically.";
    const ago = Math.round((Date.now() - lastOffer.at) / 1000);
    return `${lastOffer.spoken} That was ${lastOffer.platform || 'an'} offer${lastOffer.store ? ' from ' + lastOffer.store : ''}, ${ago < 90 ? ago + ' seconds' : Math.round(ago / 60) + ' minutes'} ago. You accept it in the app; tell me if you do and I'll add it to your route.`;
  });
function pushOfferPrefs() {
  if (!has('setOfferPrefs')) return;
  const c = deliveryConfig();
  try { bridge().setOfferPrefs(Number(c.min_per_hour || 18), Number(c.min_per_mile || 1.5), c.currency || '$', cfgStore.get('read_offers', true) !== false); } catch {}
}

// ---------------------------------------------------------------- ears: native mic + wake word -> speech to text
const stats = { mic: has('micStart') ? 'starting' : 'browser', wake: false, rms: 0, score: 0, wakes: 0, lastWakeAt: 0, listening: false, heard: [], sttMs: 0, notice: '' };
function deliverTranscript(text, info) {
  if (info && typeof info.delayMs === 'number') { stats.delayMs = info.delayMs; stats.clipMs = info.audioMs; stats.clipWhy = info.why; }
  stats.heard.unshift({ text, at: Date.now() }); stats.heard.length = Math.min(stats.heard.length, 6);
  for (const s of audioSockets) { s._deliver(JSON.stringify({ type: 'transcript', text })); s._deliver(JSON.stringify({ type: 'partial', text })); }
}
const stt = new SttPipeline({ api, getConfig: (k, d) => cfgStore.get(k, d), onTranscript: deliverTranscript, onNotice: t => { stats.notice = t; broadcast('proactive:' + t); }, log,
  onTiming: ms => { stats.sttMs = ms; stats.sttError = ''; }, onSent: () => { stats.sttSent = (stats.sttSent || 0) + 1; }, onError: e => { stats.sttError = e; } });
const ears = { feed: (int16, speech = null) => stt.feed(int16, speech), reset: () => stt.cut() };
W.__jvDebug = (text, kind) => { if (kind !== 'heard') stats.dropped = { text: String(text), kind, at: Date.now() }; };
const meter = () => document.getElementById('mic-level-fill');
W.__jvPcm = (b64, speech) => { const b = b64ToBytes(b64); ears.feed(new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), typeof speech === 'number' ? speech : null); };
W.__jvLevel = (rms, score, speech) => {
  stats.rms = rms; stats.score = score; stats.speech = typeof speech === 'number' ? speech : -1;
  const m = meter(); if (m) m.style.width = Math.min(100, Math.sqrt(rms) * 2.2) + '%';
  if (!stats.listening) stt.vad.track(rms);                                  // keep the loudness fallback's noise floor current while idle
};
W.__jvWake = score => {
  stats.wakes++; stats.lastWakeAt = Date.now(); stats.lastWakeScore = score;
  log(`wake word (${Number(score).toFixed(2)})`);
  const st = pageState(); if (st && st.muted) return;
  // Idle: open the mic at once, with the second before the wake word ("Hey Jarvis, what's the time" in one breath).
  // Talking over Jarvis: the page stops his voice; the mic reopens after the echo tail, without that second (it holds his voice).
  if (!(st && st.speaking) && !ttsBusy()) setListening(true, true);
  broadcast('wake');
};
W.__jvMic = state => {
  stats.mic = String(state);
  if (state === 'permission') micStart();
  try { const s = JSON.parse(bridge().micStatus()); stats.wake = !!s.wake; stats.vad = !!s.vad; stats.wakeError = s.wakeError || ''; } catch {}
};
function micStart() { if (!has('micStart')) return; const r = bridge().micStart(); stats.mic = r === 'ok' ? 'starting' : r; }

const pageState = () => { try { return W.__jv && W.__jv.state(); } catch { return null; } };
function setListening(on, withPreroll = false) {
  if (stats.listening === on) return; stats.listening = on;
  if (has('listen')) bridge().listen(on, !!withPreroll); else if (has('setListening')) bridge().setListening(on);
  if (!on) ears.reset();
}
// Jarvis's voice keeps coming out of the speaker (longer over Bluetooth) after the speech engine says "done";
// the mic stays closed for this long after he stops so he never hears his own last words as your question.
const ECHO_TAIL_MS = 900;
const ttsBusy = () => { try { return !!(W.speechSynthesis && W.speechSynthesis.speaking); } catch { return false; } };
let lastSpeaking = null, lastMuted = null, quietSince = 0;
setInterval(() => {                                      // follow the page: listen only while a session is open and Jarvis is quiet
  const st = pageState(); if (!st) return;
  const talking = !!(st.speaking || ttsBusy());
  if (talking) quietSince = 0; else if (!quietSince) quietSince = performance.now();
  const settled = quietSince && performance.now() - quietSince >= ECHO_TAIL_MS;
  if (talking || !st.session || st.muted || !st.active) setListening(false);
  else if (settled && !stats.listening) setListening(true, false);
  if (st.speaking !== lastSpeaking) { lastSpeaking = st.speaking; if (has('setSpeaking')) bridge().setSpeaking(!!st.speaking); }
  const mute = !!(st.muted || !st.active); if (mute !== lastMuted) { lastMuted = mute; if (has('setMuted')) bridge().setMuted(mute); }
}, 100);
micStart();
applySettings();
setTimeout(() => { readPc(); pcWasReady = { alan: pcReady('alan'), amy: pcReady('amy') }; ensurePcVoice(); }, 1500);   // PC voice for this face (Wi-Fi only)

W.JARVIS = {
  wake: () => W.__jvWake(1), say: t => deliverTranscript(t), applySettings, config: cfgStore, api, brain, navsvc, delivery, reg, stats, stt,
  phone, verifyKey: () => brain.verifyKey(), voices: voiceList, chosenVoice, setVoice, announceVoice, pcVoices: readPc, ensurePcVoice, offerStatus: () => { try { return JSON.parse(bridge().offerReaderStatus()); } catch { return null; } }, openOfferSettings: () => has('openOfferReaderSettings') && bridge().openOfferReaderSettings(), refreshVoices: () => { rawVoices = []; return applyVoice(); },
  speakTest: t => W.speechSynthesis && W.speechSynthesis.speak(Object.assign(new W.SpeechSynthesisUtterance(t || 'Jarvis online.'), { rate: 1.1 })),
};

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
    case '/briefing': { const [text, has_] = await gctx.briefingText(); return json({ text, has_data: has_ }); }
    case '/voices': return json(voiceList().map(v => ({ id: v.id, name: v.name })));
    case '/get_voice': { const c = chosenVoice(); return json({ voice: c.id, friendly: c.name }); }
    case '/set_voice': { const n = setVoice(body && body.voice); return n ? json({ ok: true, voice: chosenVoice().id, friendly: n }) : json({ ok: false, error: 'invalid voice' }); }
    case '/delivery/plan': { const p = await delivery.plan(); return json(p.ok ? p : {}); }
    case '/nav/config': return json(navsvc.config());
    case '/nav/position': return json(await navsvc.position(body || {}));
    case '/nav/progress': return json(navsvc.progress(body || {}));
    case '/nav/ended': return json(navsvc.ended());
    case '/nav/reroute': { const lat = parseFloat(body && body.lat), lon = parseFloat(body && body.lon); return json(Number.isFinite(lat) && Number.isFinite(lon) ? await navsvc.reroute(lat, lon) : { ok: false, error: 'I need your position to reroute.' }); }
    case '/faces': { let l = []; try { l = JSON.parse(W.AndroidPhone && W.AndroidPhone.faceList ? W.AndroidPhone.faceList() : '[]'); } catch {} return json(l.map((p, i) => ({ id: i + 1, name: p.name, title: p.title }))); }
    case '/documents': return json([]);
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
