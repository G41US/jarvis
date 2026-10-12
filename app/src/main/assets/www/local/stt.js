// stt.js - speech to text on the phone: the page streams 16 kHz mic audio here; we cut it into utterances (adaptive
// voice-activity detection, same logic as server.py) and transcribe each one with Groq's hosted Whisper.

const SR = 16000, FRAMES_END = 3, MIN_SPEECH = 2, MAX_SAMPLES = SR * 15, MIN_SAMPLES = SR / 2;
const HALLU = new Set(['you', 'thank you', 'thanks', 'please subscribe', 'subscribe', 'thank you for watching', 'thank you for watching.', '.', '..', '...', '...?', '…', '[blank_audio]', '[music]', '[applause]', '[laughter]', '♪', '♪♪', '♪ ♪', 'amara.org', 'subtitles by', 'transcription by', 'subtitle by', 'please subscribe to my channel']);
export const isHallucination = t => { t = String(t || '').trim().toLowerCase(); return !t || HALLU.has(t) || (t.length <= 2 && !/[a-z0-9]/i.test(t)); };

export class Vad {
  constructor() { this.floor = 40; }
  get threshold() { return Math.max(90, this.floor * 3); }
  ambient(rms) { this.floor += (Math.min(rms, 600) - this.floor) * 0.05; }
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
  /** opts: {api, getConfig(k,d), onTranscript(text), onNotice(text), log, transcribe} */
  constructor(opts) {
    Object.assign(this, { log: () => {}, onNotice: () => {}, ...opts });
    this.vad = new Vad(); this.chunks = []; this.total = 0; this.sil = 0; this.spk = 0; this.queue = []; this.busy = false;
    this.recent = []; this.skipUntil = 0; this.noticeAt = {};
  }
  notice(kind, text) { const now = Date.now(); if (now - (this.noticeAt[kind] || 0) < 90000) return; this.noticeAt[kind] = now; this.onNotice(text); }
  /** One chunk of Int16 PCM (ArrayBuffer or Int16Array). */
  feed(data) {
    const arr = data instanceof Int16Array ? data : new Int16Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    if (!arr.length) return;
    this.chunks.push(arr); this.total += arr.length;
    const rms = rmsOf(arr);
    if (rms > this.vad.threshold) { this.sil = 0; this.spk++; }
    else if (this.spk === 0) this.vad.ambient(rms);
    else { this.sil++; if (this.spk < MIN_SPEECH && this.sil >= 2) { this.spk = 0; this.sil = 0; } }
    if (this.spk === 0 && this.total > SR) this._keepTail(Math.floor(SR / 3));
    const flush = this.spk >= MIN_SPEECH && this.sil >= FRAMES_END, tooLong = this.total >= MAX_SAMPLES;
    if (flush || tooLong) {
      const all = new Int16Array(this.total); let o = 0; for (const c of this.chunks) { all.set(c, o); o += c.length; }
      this.chunks = []; this.total = 0; this.sil = 0; this.spk = 0;
      if (all.length < MIN_SAMPLES) return;
      const f = new Float32Array(all.length); for (let i = 0; i < all.length; i++) f[i] = all[i] / 32768;
      this._enqueue(normalize(f));
    }
  }
  /** Drop whatever is half-recorded (Jarvis started talking or the session closed). */
  cut() { this.chunks = []; this.total = 0; this.sil = 0; this.spk = 0; }
  _keepTail(n) {
    let have = 0; const keep = [];
    for (let i = this.chunks.length - 1; i >= 0 && have < n; i--) { keep.unshift(this.chunks[i]); have += this.chunks[i].length; }
    this.chunks = keep; this.total = have;
  }
  _enqueue(f32) { this.queue.push(f32); while (this.queue.length > 2) this.queue.shift(); this._pump(); }
  async _pump() {
    if (this.busy) return; this.busy = true;
    try { while (this.queue.length) { const f = this.queue.shift(); const t = await this._transcribe(f); if (t) this.onTranscript(t); } }
    finally { this.busy = false; }
  }
  async _transcribe(f32) {
    if (this.transcribe) return this.transcribe(f32);               // tests
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
      fd.append('prompt', this.prompt()); fd.append('response_format', 'json'); fd.append('temperature', '0');
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
      const r = await this.api.fetch('/audio/transcriptions', { method: 'POST', body: fd, signal: ctl.signal, timeoutMs: 9000 }).finally(() => clearTimeout(to));
      if (r.status === 401) { if (this.onError) this.onError('HTTP 401: key rejected'); this.skipUntil = Date.now() + 600000; this.notice('auth', 'Groq rejected my API key, so I can not hear you. Open my settings and paste a fresh one.'); return ''; }
      if (r.status === 429) { if (this.onError) this.onError('HTTP 429: speech limit reached'); this.skipUntil = Date.now() + 15000; this.notice('rate', "I've hit the speech limit for a moment. Give me a few seconds."); return ''; }
      if (!r.ok) {
        this.skipUntil = Date.now() + 3000;
        let why = ''; try { const j = JSON.parse(await r.text()); why = (j.error && j.error.message) || ''; } catch {}
        const msg = `HTTP ${r.status}${why ? ': ' + why : ''}`; this.log('[STT]', msg); if (this.onError) this.onError(msg);
        this.notice('http', `My speech service turned the audio down (${msg}). I can't hear you until that's fixed.`);
        return '';
      }
      let text = ((await r.json()).text || '').trim();
      const norm = text.toLowerCase().replace(/[^a-z ]/g, ''), pn = this.prompt().toLowerCase().replace(/[^a-z ]/g, '');
      if (text.length > 25 && pn.includes(norm)) text = '';              // the prompt echoed back on silence
      const ms = Math.round(performance.now() - t0); this.log(`[STT] groq ${ms} ms: ${JSON.stringify(text)}`); if (this.onTiming) this.onTiming(ms, text);
      return isHallucination(text) ? '' : text;
    } catch (e) {
      this.skipUntil = Date.now() + 8000; this.log('[STT] failed', e && e.name); if (this.onError) this.onError(`network: ${(e && e.message) || e}`);
      if (navigator.onLine === false || (e && e.name !== 'AbortError')) this.notice('net', "I can't reach the speech service. Check the data connection.");
      return '';
    }
  }
  prompt() { return 'Hey Jarvis. ' + (this.getConfig('stt_words', 'DoorDash, Uber Eats, Grubhub, Dasher.') || ''); }
}
