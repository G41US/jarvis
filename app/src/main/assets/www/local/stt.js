// stt.js - speech to text on the phone: microphone audio arrives here while Jarvis is listening; we cut it into utterances and
// transcribe each one with Groq's hosted Whisper. End of speech is found by the phone's speech detector (Silero VAD, a probability
// per chunk from VoiceEngine.java) so background noise can't hold a sentence open; a loudness detector is the fallback.

const SR = 16000;
const PRE_MS = 300;          // audio kept from just before speech starts
const END_MS = 550;          // this much quiet after speech = you've finished
const MIN_SPEECH_MS = 200;   // shorter blips are noise
const NOISE_RESET_MS = 350;  // a blip followed by this much quiet is discarded
const MAX_MS = 12000;        // never hold a clip longer than this
const SPEECH_ON = 0.5, SPEECH_OFF = 0.35;
const HALLU = new Set(['you', 'thank you', 'thanks', 'please subscribe', 'subscribe', 'thank you for watching', 'thank you for watching.', '.', '..', '...', '...?', '…', '[blank_audio]', '[music]', '[applause]', '[laughter]', '♪', '♪♪', '♪ ♪', 'amara.org', 'subtitles by', 'transcription by', 'subtitle by', 'please subscribe to my channel']);
export const isHallucination = t => { t = String(t || '').trim().toLowerCase(); return !t || HALLU.has(t) || (t.length <= 2 && !/[a-z0-9]/i.test(t)); };

/** Loudness fallback: tracks the room's noise floor (drops fast, rises slowly) so steady noise stops counting as speech. */
export class Vad {
  constructor() { this.floor = 40; }
  get threshold() { return Math.max(100, this.floor * 2.5); }
  /** idle: learn the room quickly; mid-sentence: drift slowly so your own voice isn't learned as noise */
  track(rms, talking = false) { const r = Math.min(rms, 4000); this.floor += (r - this.floor) * (r < this.floor ? 0.25 : talking ? 0.008 : 0.05); }
  ambient(rms) { this.track(rms); }
}
export function rmsOf(int16) { let s = 0; for (let i = 0; i < int16.length; i++) s += int16[i] * int16[i]; return Math.sqrt(s / Math.max(1, int16.length)); }
export function normalize(samples, target = 0.7, maxGain = 20) {          // Float32 in [-1,1]
  let peak = 0; for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (peak < 1e-4) return samples; const g = Math.min(target / peak, maxGain); if (g <= 1) return samples;
  const out = new Float32Array(samples.length); for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g; return out;
}
export function wavBytes(f32) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Uint8Array(buf);
}

export class SttPipeline {
  /** opts: {api, getConfig(k,d), onTranscript(text, info), onNotice(text), log, transcribe, now} */
  constructor(opts) {
    Object.assign(this, { log: () => {}, onNotice: () => {}, now: () => performance.now(), ...opts });
    this.vad = new Vad(); this.recent = []; this.skipUntil = 0; this.noticeAt = {}; this.order = Promise.resolve(); this.inFlight = 0;
    this.cut();
  }
  notice(kind, text) { const now = Date.now(); if (now - (this.noticeAt[kind] || 0) < 90000) return; this.noticeAt[kind] = now; this.onNotice(text); }

  /** One chunk of Int16 PCM. speech = the phone's speech probability for it (0..1), or null/-1 when unknown. */
  feed(data, speech = null) {
    const arr = data instanceof Int16Array ? data : new Int16Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    if (!arr.length) return;
    const ms = arr.length * 1000 / SR, rms = rmsOf(arr), model = typeof speech === 'number' && speech >= 0;
    let isSpeech, isQuiet;
    if (model) { isSpeech = speech >= SPEECH_ON; isQuiet = speech < SPEECH_OFF; }
    else { this.vad.track(rms, this.active); isSpeech = rms > this.vad.threshold; isQuiet = !isSpeech; }

    if (!this.active) {                                                   // waiting for you to start talking
      this.pre.push(arr); this.preMs += ms;
      while (this.pre.length > 1 && this.preMs - this.pre[0].length * 1000 / SR >= PRE_MS) this.preMs -= this.pre.shift().length * 1000 / SR;
      if (isSpeech) { this.active = true; this.chunks = this.pre; this.totalMs = this.preMs; this.pre = []; this.preMs = 0; this.speechMs = ms; this.quietMs = 0; }
      return;
    }
    this.chunks.push(arr); this.totalMs += ms;
    if (isSpeech) { this.speechMs += ms; this.quietMs = 0; } else if (isQuiet) this.quietMs += ms;
    if (this.speechMs < MIN_SPEECH_MS && this.quietMs >= NOISE_RESET_MS) { this.cut(); return; }      // a click or a cough
    if ((this.speechMs >= MIN_SPEECH_MS && this.quietMs >= END_MS) || this.totalMs >= MAX_MS) this._flush(this.totalMs >= MAX_MS ? 'max' : 'pause');
  }
  _flush(why) {
    const n = this.chunks.reduce((a, c) => a + c.length, 0), all = new Int16Array(n); let o = 0; for (const c of this.chunks) { all.set(c, o); o += c.length; }
    const info = { endedAt: this.now(), audioMs: Math.round(n * 1000 / SR), why };
    this.cut();
    const f = new Float32Array(all.length); for (let i = 0; i < all.length; i++) f[i] = all[i] / 32768;
    this._enqueue(normalize(f), info);
  }
  /** Drop whatever is half-recorded (Jarvis started talking or the session closed). */
  cut() { this.active = false; this.chunks = []; this.totalMs = 0; this.speechMs = 0; this.quietMs = 0; this.pre = []; this.preMs = 0; }
  /** Transcribe right away (clips overlap), but hand the words over in the order you said them. */
  _enqueue(f32, info) {
    if (this.inFlight >= 3) return;                                       // something is badly backed up; don't pile on
    this.inFlight++;
    const meta = {};                                                       // the language Whisper heard (interpreter mode)
    const job = this._transcribe(f32, meta).finally(() => { this.inFlight--; });
    this.order = this.order.then(async () => { const t = await job; if (t) this.onTranscript(t, { ...info, ...meta, delayMs: Math.round(this.now() - info.endedAt) }); }).catch(() => {});
  }
  async _transcribe(f32, meta = {}) {
    if (this.transcribe) return this.transcribe(f32, meta);         // tests
    if (!this.api.ready()) { this.notice('nokey', 'I need my Groq key to hear you. Open my settings and paste it in.'); return ''; }
    const now = Date.now(); if (now < this.skipUntil) return '';
    this.recent = this.recent.filter(t => now - t < 60000);
    if (this.recent.length >= 18) { this.notice('rate', "I'm hearing a lot of noise, so I'm skipping some audio to stay under the speech limit."); return ''; }
    this.recent.push(now);
    const t0 = performance.now();
    try {
      const fd = new FormData();
      fd.append('file', new Blob([wavBytes(f32)], { type: 'audio/wav' }), 'speech.wav');
      const lang = String(this.getConfig('stt_language', 'en') || 'en').trim().toLowerCase();
      fd.append('model', this.getConfig('stt_model', 'whisper-large-v3-turbo') || 'whisper-large-v3-turbo');
      if (/^[a-z]{2,3}$/.test(lang)) fd.append('language', lang);                 // a bad value would make Groq reject every clip
      if (this.onSent) this.onSent();
      const detect = !!this.getConfig('stt_detect', false);                 // interpreter: any language, and say which
      if (this.prompt()) fd.append('prompt', this.prompt()); fd.append('response_format', detect ? 'verbose_json' : 'json'); fd.append('temperature', '0');
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
      const r = await this.api.fetch('/audio/transcriptions', { method: 'POST', body: fd, signal: ctl.signal, timeoutMs: 9000 }).finally(() => clearTimeout(to));
      if (r.status === 401) { if (this.onError) this.onError('HTTP 401: key rejected'); this.skipUntil = Date.now() + 600000; this.notice('auth', 'Groq rejected my API key, so I can not hear you. Open my settings and paste a fresh one.'); return ''; }
      if (r.status === 429) { if (this.onError) this.onError('HTTP 429: speech limit reached'); this.skipUntil = Date.now() + 15000; this.notice('rate', "I've hit the speech limit for a moment. Give me a few seconds."); return ''; }
      if (!r.ok) {
        this.skipUntil = Date.now() + 1500;
        let why = ''; try { const j = JSON.parse(await r.text()); why = (j.error && j.error.message) || ''; } catch {}
        const msg = `HTTP ${r.status}${why ? ': ' + why : ''}`; this.log('[STT]', msg); if (this.onError) this.onError(msg);
        this.notice('http', `My speech service turned the audio down (${msg}). I can't hear you until that's fixed.`);
        return '';
      }
      const j = await r.json(); let text = (j.text || '').trim();
      if (j.language) meta.language = String(j.language).toLowerCase();
      const norm = text.toLowerCase().replace(/[^a-z ]/g, ''), pn = this.prompt().toLowerCase().replace(/[^a-z ]/g, '');
      if (text.length > 25 && pn && norm && pn.includes(norm)) text = '';   // the prompt echoed back on silence
      const ms = Math.round(performance.now() - t0); this.log(`[STT] groq ${ms} ms: ${JSON.stringify(text)}`); if (this.onTiming) this.onTiming(ms, text);
      if (detect) { const l = text.toLowerCase().replace(/[.!]+$/, ''); return !text || (HALLU.has(l) && l !== 'thank you' && l !== 'thanks') ? '' : text; }   // interpreter: '好', 'Sí' and 'thank you' are real answers
      return isHallucination(text) ? '' : text;
    } catch (e) {
      this.skipUntil = Date.now() + 1500; this.log('[STT] failed', e && e.name); if (this.onError) this.onError(`network: ${(e && e.message) || e}`);
      if (navigator.onLine === false || (e && e.name !== 'AbortError')) this.notice('net', "I can't reach the speech service. Check the data connection.");
      return '';
    }
  }
  prompt() { const p = this.getConfig('stt_prompt', null); if (p != null) return p; return 'Hey Jarvis. Male voice, female voice. ' + (this.getConfig('stt_words', 'DoorDash, Uber Eats, Grubhub, Dasher.') || ''); }
}
