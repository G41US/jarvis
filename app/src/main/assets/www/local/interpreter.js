// interpreter.js - live interpreter. "Be my interpreter, she speaks Spanish": from then on, whatever either of you says is
// heard in any language (Whisper names the language), translated into the other one, and spoken in that language's voice.
// The screen splits face to face: the top half is turned upside down for the person across from you, in their language.
// "Stop interpreting" ends it.

export const LANGS = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', italian: 'it', dutch: 'nl', polish: 'pl', russian: 'ru', ukrainian: 'uk',
  turkish: 'tr', arabic: 'ar', hebrew: 'he', persian: 'fa', farsi: 'fa', hindi: 'hi', urdu: 'ur', bengali: 'bn', punjabi: 'pa', tamil: 'ta', telugu: 'te',
  chinese: 'zh', mandarin: 'zh', cantonese: 'yue', japanese: 'ja', korean: 'ko', vietnamese: 'vi', thai: 'th', indonesian: 'id', malay: 'ms', tagalog: 'tl', filipino: 'tl',
  swahili: 'sw', yoruba: 'yo', hausa: 'ha', igbo: 'ig', amharic: 'am', somali: 'so', zulu: 'zu', afrikaans: 'af', greek: 'el', romanian: 'ro', hungarian: 'hu',
  czech: 'cs', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', haitian: 'ht', 'haitian creole': 'ht', creole: 'ht', nepali: 'ne', burmese: 'my', khmer: 'km',
};
const NAMES = Object.fromEntries(Object.entries(LANGS).reverse().map(([n, c]) => [c, n[0].toUpperCase() + n.slice(1)]));
NAMES.en = 'English'; NAMES.zh = 'Chinese'; NAMES.fa = 'Persian'; NAMES.tl = 'Tagalog'; NAMES.ht = 'Haitian Creole';
export const langCode = s => { const t = String(s || '').toLowerCase().trim(); return LANGS[t] || (/^[a-z]{2,3}(-[a-z]{2})?$/.test(t) && NAMES[t.slice(0, 2)] ? t.slice(0, 2) : (Object.keys(LANGS).find(n => t.includes(n)) ? LANGS[Object.keys(LANGS).find(n => t.includes(n))] : '')); };
export const langName = c => NAMES[c] || c;
/** Each language's name in itself, for the half of the screen that faces that person. */
export const NATIVE = { es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português', it: 'Italiano', nl: 'Nederlands', pl: 'Polski', ru: 'Русский', uk: 'Українська', tr: 'Türkçe',
  ar: 'العربية', he: 'עברית', fa: 'فارسی', hi: 'हिन्दी', ur: 'اردو', bn: 'বাংলা', pa: 'ਪੰਜਾਬੀ', ta: 'தமிழ்', te: 'తెలుగు', zh: '中文', yue: '粵語', ja: '日本語', ko: '한국어', vi: 'Tiếng Việt',
  th: 'ไทย', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', tl: 'Tagalog', sw: 'Kiswahili', yo: 'Yorùbá', ha: 'Hausa', ig: 'Igbo', am: 'አማርኛ', so: 'Soomaali', zu: 'isiZulu',
  af: 'Afrikaans', el: 'Ελληνικά', ro: 'Română', hu: 'Magyar', cs: 'Čeština', sv: 'Svenska', no: 'Norsk', da: 'Dansk', fi: 'Suomi', ht: 'Kreyòl ayisyen', ne: 'नेपाली', my: 'မြန်မာ', km: 'ខ្មែរ', en: 'English' };

const CSS = `
#jv-int { position: fixed; inset: 0; z-index: 55; display: none; flex-direction: column; background: #03070d; color: #e8f4ff; font-family: 'Saira', system-ui, sans-serif; }
#jv-int.on { display: flex; }
#jv-int .half { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding: 22px 22px 18px; gap: 10px; overflow: hidden; }
#jv-int .them { transform: rotate(180deg); background: linear-gradient(180deg, #071422, #03070d); border-top: 1px solid #12324c; }
#jv-int .me { background: linear-gradient(0deg, #071422, #03070d); }
#jv-int .lang { font: 600 16px/1 'Saira', sans-serif; font-stretch: 88%; color: #7fd6ff; display: flex; align-items: center; gap: 8px; }
#jv-int .lang i { width: 8px; height: 8px; border-radius: 4px; background: #2a4a66; display: inline-block; }
#jv-int .lang i.live { background: #5ef0a0; box-shadow: 0 0 12px #5ef0a0; }
#jv-int .big { font: 500 clamp(22px, 6.4vw, 34px)/1.25 'Saira', sans-serif; color: #f2f9ff; min-height: 2.5em; overflow-wrap: anywhere; }
#jv-int .small { font: 400 15px/1.35 Roboto, system-ui, sans-serif; color: #7f98ae; min-height: 1.3em; overflow-wrap: anywhere; }
#jv-int .mid { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: #061120; border-top: 1px solid #12253a; border-bottom: 1px solid #12253a; }
#jv-int .mid span { font: 500 13px/1 Roboto, sans-serif; color: #9fb7cc; }
#jv-int .mid button { border: 1px solid #2a4a66; background: #0c1c2e; color: #cfe9ff; border-radius: 18px; padding: 9px 18px; font: 500 15px Roboto, sans-serif; text-transform: none; letter-spacing: normal; text-shadow: none; }
`;

export function createInterpreter({ api, broadcast, langFor, log = () => {}, bridge = () => null }) {
  const st = { on: false, mine: 'en', theirs: 'es', busy: false, turns: [] };
  let ui = null;

  function buildUi() {
    if (ui || typeof document === 'undefined') return ui;
    const s = document.createElement('style'); s.textContent = CSS; document.head.append(s);
    const root = document.createElement('div'); root.id = 'jv-int';
    root.innerHTML = `<div class="half them"><div class="lang"><i></i><b></b></div><div class="small" dir="auto"></div><div class="big" dir="auto"></div></div>
      <div class="mid"><span class="status">Listening…</span><button type="button">Stop</button></div>
      <div class="half me"><div class="lang"><i></i><b></b></div><div class="small" dir="auto"></div><div class="big" dir="auto"></div></div>`;
    root.querySelector('.mid button').onclick = () => stop(true);
    document.body.append(root);
    const q = (h, c) => root.querySelector(`.${h} .${c}`);
    ui = { root, them: { lang: q('them', 'lang b'), dot: q('them', 'lang i'), small: q('them', 'small'), big: q('them', 'big') },
      me: { lang: q('me', 'lang b'), dot: q('me', 'lang i'), small: q('me', 'small'), big: q('me', 'big') }, status: root.querySelector('.status') };
    return ui;
  }
  function paint(status) {
    const u = buildUi(); if (!u) return;
    u.root.classList.toggle('on', st.on);
    u.them.lang.textContent = NATIVE[st.theirs] || langName(st.theirs); u.me.lang.textContent = langName(st.mine);
    if (status) u.status.textContent = status;
    const last = st.turns[st.turns.length - 1];
    if (!last) { u.me.big.textContent = 'Speak, and I\'ll translate.'; u.me.small.textContent = ''; u.them.big.textContent = st.intro || ''; u.them.small.textContent = ''; return; }
    // each half shows the conversation in its reader's language: the big line is the newest thing to read
    const meSide = last.from === st.mine ? { big: last.text, small: 'You said' } : { big: last.translation, small: `They said: ${last.text}` };
    const themSide = last.from === st.mine ? { big: last.translation, small: `${langName(st.mine)}: ${last.text}` } : { big: last.text, small: '' };
    u.me.big.textContent = meSide.big; u.me.small.textContent = meSide.small; u.them.big.textContent = themSide.big; u.them.small.textContent = themSide.small;
    u.me.dot.className = last.from === st.mine ? 'live' : ''; u.them.dot.className = last.from === st.theirs ? 'live' : '';
  }

  async function llmJson(system, user, maxTokens = 600) {
    const body = { model: 'openai/gpt-oss-20b', reasoning_effort: 'low', max_tokens: maxTokens, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    const send = b => api.fetch('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let r = await send(body);
    if (!r.ok && r.status === 400) { const t = await r.clone().text(); if (/response_format|json/i.test(t)) { delete body.response_format; r = await send(body); } }
    if (!r.ok) throw new Error('translate ' + r.status);
    const j = await r.json(), c = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const m = /\{[\s\S]*\}/.exec(c); return JSON.parse(m ? m[0] : c);
  }

  /** -> { from, to, text, translation } */
  async function translate(text, heard) {
    const A = langName(st.mine), B = langName(st.theirs), hint = heard ? ` The speech recogniser thinks it was ${heard}.` : '';
    const sys = `You are a live interpreter between ${A} (${st.mine}) and ${B} (${st.theirs}). You get one spoken sentence.${hint} Decide which of the two languages it is in, then translate it into the OTHER one: natural, spoken, same tone and meaning, keep names and numbers. Do not answer it, do not add anything. Reply with JSON only: {"from":"${st.mine} or ${st.theirs}","translation":"..."}`;
    const j = await llmJson(sys, text);
    const from = String(j.from || '').toLowerCase().slice(0, 3).startsWith(st.theirs) ? st.theirs : st.mine;
    return { from, to: from === st.mine ? st.theirs : st.mine, text, translation: String(j.translation || j.text || '').trim() };
  }

  function sayIn(lang, text) { for (const s of String(text).split(/(?<=[.!?。！？])\s*/).map(x => x.trim()).filter(Boolean)) langFor.set(s, lang); langFor.set(String(text).trim(), lang); }

  async function start(theirs, mine = 'en') {
    const t = langCode(theirs), m = langCode(mine) || 'en';
    if (!t) return { ok: false, message: `I don't know the language "${theirs}". Try Spanish, French, Arabic, Chinese, Yoruba…` };
    if (t === m) return { ok: false, message: 'Both sides would speak the same language.' };
    Object.assign(st, { on: true, mine: m, theirs: t, turns: [], intro: '' });
    if (typeof window !== 'undefined') { window.__jvInterpreting = true; window.__jvSessionMs = 10 * 60000; }
    let avail = 1; try { const b = bridge(); if (b && b.ttsLangAvailable) avail = b.ttsLangAvailable(t); } catch {}
    paint('Listening…');
    try {   // a short hello for the other person, in their language
      const j = await llmJson(`Translate into ${langName(t)}. JSON only: {"translation":"..."}`, `Hello. I'm Jarvis, an interpreter. Speak normally and I'll translate what you both say.`, 200);
      st.intro = String(j.translation || '').trim();
    } catch (e) { log('[INTERPRETER] intro', e); }
    paint();
    if (st.intro) { sayIn(t, st.intro); setTimeout(() => { if (st.on) broadcast('proactive:' + st.intro); }, 2600); }
    const voiceNote = avail === 1 ? '' : avail === 0 ? ` Your phone needs to download its ${langName(t)} voice (Android Settings, Text-to-speech); until then I'll show the words on screen.` : ` Your phone has no ${langName(t)} voice, so the other person reads the top half of the screen.`;
    return { ok: true, message: `Interpreter on: ${langName(m)} and ${langName(t)}. Speak normally; I'll translate both ways. The top half of the screen faces them. Say "stop interpreting" when you're done.${voiceNote}` };
  }

  function stop(fromButton = false) {
    if (!st.on) return 'The interpreter is already off.';
    st.on = false; if (typeof window !== 'undefined') { window.__jvInterpreting = false; window.__jvSessionMs = 0; }
    paint();
    if (fromButton) broadcast('proactive:Interpreter off.');
    return 'Interpreter off.';
  }

  /** One thing someone said while interpreting -> what Jarvis says (in the other language). */
  async function* respond(text, heard) {
    if (/^\W*(stop|end|exit|quit|close) (the )?(interpreter|interpreting|translating|translation)( mode)?\W*$/i.test(String(text).trim())) {
      yield { type: 'sentence', text: stop() }; yield { type: 'done' }; return;
    }
    paint('Translating…');
    try {
      const t0 = performance.now(), r = await translate(text, heard);
      if (!r.translation) { paint('Listening…'); yield { type: 'done' }; return; }
      st.turns.push(r); if (st.turns.length > 30) st.turns.shift();
      log(`[INTERPRETER] ${r.from}->${r.to} in ${Math.round(performance.now() - t0)} ms`);
      paint('Listening…');
      sayIn(r.to, r.translation);
      for (const s of r.translation.split(/(?<=[.!?。！？])\s+/).map(x => x.trim()).filter(Boolean)) yield { type: 'sentence', text: s };
    } catch (e) {
      log('[INTERPRETER]', e && e.message); paint('Listening…');
      yield { type: 'sentence', text: "Sorry, I couldn't translate that. Say it again?" };
    }
    yield { type: 'done' };
  }

  return { state: st, start, stop, respond, translate, paint, get on() { return st.on; } };
}
