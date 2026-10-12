// settings.js - the phone's settings screen. Opens by itself the first time (when Jarvis has no way to think yet),
// and from the gear afterwards. Everything is stored on this phone only.
const J = () => window.JARVIS;
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) e.append(k && k.nodeType ? k : document.createTextNode(k == null ? '' : String(k)));
  return e;
};

const CSS = `
/* while settings are open nothing else is drawn: the 3D face stops, so the phone has its graphics memory for this screen */
body.jv-settings #three, body.jv-settings #hud, body.jv-settings #jv-top, body.jv-settings #jv-cap, body.jv-settings #jv-dock,
body.jv-settings #bg-base, body.jv-settings #bg-rings, body.jv-settings #bg-halo, body.jv-settings #bg-floor, body.jv-settings #nav-frame, body.jv-settings #nav-orb { visibility: hidden !important; }
#jv-ov { position: fixed; inset: 0; z-index: 80; background: #03070d; overflow-y: auto; -webkit-overflow-scrolling: touch; display: none; color: #e8f4ff;
  font: 15px/1.45 Roboto, system-ui, sans-serif; }
#jv-ov.on { display: block; }
#jv-ov .box { max-width: 560px; margin: 0 auto; padding: calc(env(safe-area-inset-top, 0px) + 18px) 18px 120px; }
#jv-ov h1 { margin: 4px 0 4px; font: 600 28px/1.1 'Saira', system-ui, sans-serif; font-stretch: 90%; color: #7fd6ff; }
#jv-ov .lead { margin: 0 0 8px; color: #6f8aa3; }
#jv-ov section { margin-top: 26px; }
#jv-ov h2 { margin: 0 0 4px; font: 600 18px/1.2 'Saira', system-ui, sans-serif; color: #e8f4ff; }
#jv-ov p.hint { margin: 2px 0 10px; font-size: 13px; color: #6f8aa3; }
#jv-ov label { display: block; margin: 12px 0 4px; font-size: 14px; color: #b9cfe3; }
#jv-ov input, #jv-ov select { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; border: 1px solid #1d3347; background: #081321; color: #e8f4ff; font-size: 16px; }
#jv-ov input:focus, #jv-ov select:focus, #jv-ov button:focus-visible { outline: 2px solid #7fd6ff; outline-offset: 1px; }
#jv-ov input[type=range] { padding: 0; border: 0; background: none; accent-color: #7fd6ff; height: 32px; }
#jv-ov .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; } #jv-ov .row > * { flex: 1; }
#jv-ov button { text-transform: none; letter-spacing: normal; text-shadow: none; font-family: Roboto, system-ui, sans-serif; padding: 12px 14px; border-radius: 10px; border: 1px solid #2a4a66; background: #0c1c2e; color: #cfe9ff; font-size: 15px; font-weight: 500; }
#jv-ov button.pri { background: #7fd6ff; color: #03121f; border-color: #7fd6ff; font-weight: 600; }
#jv-ov .seg { display: flex; border: 1px solid #1d3347; border-radius: 12px; overflow: hidden; }
#jv-ov .seg button { flex: 1; border: 0; border-radius: 0; background: transparent; color: #9fb7cc; padding: 13px; }
#jv-ov .seg button[aria-pressed=true] { background: #12324c; color: #e8f4ff; box-shadow: inset 0 -2px 0 #7fd6ff; }
#jv-ov .msg { min-height: 20px; margin-top: 8px; font-size: 14px; } #jv-ov .ok { color: #5ef0a0; } #jv-ov .bad { color: #ff7a7a; }
#jv-ov .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 18px calc(env(safe-area-inset-bottom, 0px) + 14px); background: linear-gradient(transparent, #03070d 30%); }
#jv-ov .bar .row { max-width: 560px; margin: 0 auto; }
#jv-ov details { margin-top: 26px; border-top: 1px solid #12253a; padding-top: 14px; }
#jv-ov summary { font: 600 18px/1.2 'Saira', system-ui, sans-serif; color: #e8f4ff; cursor: pointer; }
/* hearing check */
#jv-diag { margin-top: 10px; padding: 14px; border-radius: 14px; background: #081321; border: 1px solid #12253a; }
#jv-diag .meter { position: relative; height: 10px; border-radius: 5px; background: #102235; overflow: hidden; margin: 8px 0 4px; }
#jv-diag .meter b { position: absolute; inset: 0; background: #5ef0a0; transform-origin: 0 50%; transform: scaleX(0); will-change: transform; }
#jv-diag .meter.wake b { background: #7fd6ff; }
#jv-diag dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 12px 0 0; font-size: 14px; }
#jv-diag dt { color: #6f8aa3; } #jv-diag dd { margin: 0; color: #e8f4ff; overflow-wrap: anywhere; }
#jv-diag .flash { color: #5ef0a0; font-weight: 600; }
`;

function field(kind, key, label, opts = {}) {
  const c = J().config, cur = c.get(key, opts.def ?? '');
  const wrap = el('div'); wrap.append(el('label', {}, label));
  let inp;
  if (kind === 'select') { inp = el('select'); for (const [v, t] of opts.options) inp.append(el('option', { value: v }, t)); inp.value = String(cur); if (inp.value !== String(cur)) inp.value = opts.options[0][0]; }
  else { inp = el('input', { type: kind, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }); if (opts.ph) inp.placeholder = opts.ph; if (opts.inputmode) inp.setAttribute('inputmode', opts.inputmode); inp.value = cur == null ? '' : String(cur); }
  wrap.append(inp); if (opts.hint) wrap.append(el('p', { class: 'hint' }, opts.hint));
  inp._key = key; inp._num = !!opts.num; return [wrap, inp];
}

export function initSettings() {
  if (document.getElementById('jv-ov')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const ov = el('div', { id: 'jv-ov', role: 'dialog', 'aria-label': 'Settings' }), box = el('div', { class: 'box' }); ov.append(box);
  const inputs = [];
  const add = (parent, kind, key, label, opts) => { const [w, i] = field(kind, key, label, opts); inputs.push(i); parent.append(w); return i; };
  const section = (title, hint) => { const s = el('section'); s.append(el('h2', {}, title)); if (hint) s.append(el('p', { class: 'hint' }, hint)); box.append(s); return s; };

  box.append(el('h1', {}, 'Jarvis'), el('p', { class: 'lead' }, 'Settings stay on this phone.'));

  // ---- brain
  const sBrain = section('Brain', 'Jarvis thinks and listens through Groq. A free key from console.groq.com/keys is enough.');
  const keyIn = add(sBrain, 'password', 'groq_key', 'Groq API key', { ph: 'gsk_…' });
  const testMsg = el('div', { class: 'msg' });
  sBrain.append(el('div', { class: 'row' }, el('button', { id: 'jv-test', onclick: async () => {
    J().config.set('groq_key', keyIn.value.trim()); testMsg.className = 'msg'; testMsg.textContent = 'Checking…';
    const r = await J().verifyKey(); testMsg.className = 'msg ' + (r.ok ? 'ok' : 'bad'); testMsg.textContent = r.message;
  } }, 'Test connection')), testMsg);
  if (J().api.hasProxy()) sBrain.querySelector('.hint').textContent = 'Jarvis works without a key. Add your own Groq key only if you want to use it instead.';
  add(sBrain, 'text', 'user_name', 'Your name', { ph: 'What should I call you?' });

  // ---- voice and face
  const sVoice = section('Voice and face');
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Voice' });
  const bMale = el('button', { type: 'button' }, 'Male'), bFemale = el('button', { type: 'button' }, 'Female');
  seg.append(bMale, bFemale); sVoice.append(seg);
  let gender = J().config.get('avatar_gender', 'male');
  const vsel = el('select', { 'aria-label': 'Voice' }); const vw = el('div'); vw.append(el('label', {}, 'Voice'), vsel); sVoice.append(vw);
  const vnote = el('p', { class: 'hint' }); sVoice.append(vnote);
  const paintSeg = () => { bMale.setAttribute('aria-pressed', String(gender === 'male')); bFemale.setAttribute('aria-pressed', String(gender === 'female')); };
  const fillVoices = () => {
    vsel.replaceChildren();
    const g = gender === 'female' ? 'f' : 'm';
    const all = J().voices(), mine = all.filter(v => v.gender === g), unknown = all.filter(v => !v.gender);
    const list = mine.length ? mine : unknown;
    vsel.append(el('option', { value: '' }, 'Best match'));
    for (const v of list) vsel.append(el('option', { value: v.id }, v.name));
    const cur = J().config.get('voice', ''); if (cur && list.some(v => v.id === cur)) vsel.value = cur;
    vnote.textContent = mine.length ? '' : `This phone has no ${gender} voice installed, so Jarvis changes the pitch. More voices: Android Settings, Text-to-speech, Speech Services by Google, Install voice data.`;
  };
  const choose = g => { gender = g; paintSeg(); J().config.merge({ avatar_gender: g, voice: '' }); fillVoices(); J().announceVoice(); };
  bMale.onclick = () => choose('male'); bFemale.onclick = () => choose('female');
  vsel.onchange = () => { J().config.set('voice', vsel.value); J().announceVoice(); };
  sVoice.append(el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { type: 'button', onclick: () => J().speakTest(gender === 'female' ? 'Hello. This is how I sound.' : 'Good evening. This is how I sound.') }, 'Hear it')));

  // ---- hearing
  const sEar = section('Hearing', 'Jarvis listens for "Hey Jarvis" on the phone itself. Nothing is sent anywhere until he hears it.');
  const sens = el('input', { type: 'range', min: '0.15', max: '0.6', step: '0.05', 'aria-label': 'Wake word sensitivity' });
  sens.value = String(J().config.get('wake_sensitivity', 0.3));
  sEar.append(el('label', {}, 'Wake word: more sensitive ⟷ fewer false wakes'), sens);
  const diag = el('div', { id: 'jv-diag' });
  const meter = el('div', { class: 'meter' }, el('b')), wmeter = el('div', { class: 'meter wake' }, el('b'));
  const dl = el('dl');
  const row = (k) => { const dd = el('dd'); dl.append(el('dt', {}, k), dd); return dd; };
  const dMic = row('Microphone'), dWake = row('Wake word'), dHeard = row('Last heard'), dBrain = row('Brain'), dSpeed = row('Speech to text');
  diag.append(el('div', {}, 'Your voice'), meter, el('div', {}, 'Wake score (say "Hey Jarvis")'), wmeter, dl);
  sEar.append(diag);
  let diagTimer = null, wakesSeen = 0;
  const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const paintDiag = () => {
    const s = J().stats; if (!s) return;
    meter.firstChild.style.transform = `scaleX(${Math.min(1, Math.sqrt(s.rms || 0) * 0.022).toFixed(3)})`;
    wmeter.firstChild.style.transform = `scaleX(${Math.min(1, s.score || 0).toFixed(3)})`;
    const micTxt = { listening: 'On', starting: 'Starting…', stopped: 'Stopped', 'no-permission': 'No permission. Allow the microphone in Android settings.', browser: 'Browser microphone' };
    put(dMic, micTxt[s.mic] || (String(s.mic).startsWith('listening-no-wake') ? 'On (wake word model failed to load)' : String(s.mic).replace(/^error:/, 'Error: ')));
    if (s.wakes > wakesSeen) { wakesSeen = s.wakes; dWake.className = 'flash'; put(dWake, `Heard you (score ${Number(s.lastWakeScore || 0).toFixed(2)})`); setTimeout(() => { dWake.className = ''; }, 2500); }
    else if (!dWake.className) put(dWake, s.wake ? `Ready · ${s.wakes} so far` : (s.wakeError ? 'Not loaded' : 'Loading…'));
    put(dHeard, s.heard && s.heard[0] ? `"${s.heard[0].text}"` : '—');
    const m = J().api.mode(); put(dBrain, m === 'key' ? 'Your Groq key' : m === 'proxy' ? 'Jarvis service' : 'Not set up');
    put(dSpeed, (s.sttMs ? `${s.sttMs} ms` : '—') + (s.notice ? ` · ${s.notice}` : ''));
  };

  // ---- navigation & delivery
  const nd = el('details'); nd.append(el('summary', {}, 'Navigation and deliveries')); box.append(nd);
  add(nd, 'select', 'units', 'Distance', { def: 'auto', options: [['auto', 'Automatic'], ['miles', 'Miles'], ['km', 'Kilometres']] });
  add(nd, 'text', 'currency', 'Currency symbol', { def: '$', ph: '$' });
  add(nd, 'text', 'areas', 'Busy areas (comma-separated)', { ph: 'Downtown, Airport', hint: 'Used to suggest where to wait between orders.' });
  add(nd, 'number', 'min_per_hour', 'Lowest pay per hour you accept', { num: true, inputmode: 'decimal', ph: '20' });
  add(nd, 'number', 'min_per_mile', 'Lowest pay per mile you accept', { num: true, inputmode: 'decimal', ph: '1.5' });
  add(nd, 'select', 'use_gps', 'Use GPS', { def: 'true', options: [['true', 'Yes'], ['false', 'No, I will say where I am']] });
  add(nd, 'select', 'map_theme', 'Map colours', { def: 'auto', options: [['auto', 'Follow the time of day'], ['night', 'Always night'], ['day', 'Always day']] });
  add(nd, 'select', 'map_provider', 'Map', { def: 'jarvis', options: [['jarvis', 'Jarvis map (free)'], ['google', 'Google Maps (needs key)'], ['apple', 'Apple Maps (needs token)']] });
  add(nd, 'password', 'google_key', 'Google Maps JavaScript API key (optional)', { ph: 'AIza…' });
  add(nd, 'password', 'apple_token', 'Apple MapKit JS token (optional)', { ph: 'eyJ…' });

  const adv = el('details'); adv.append(el('summary', {}, 'Advanced')); box.append(adv);
  add(adv, 'select', 'reasoning', 'Thinking effort', { def: 'low', options: [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High']] });
  add(adv, 'text', 'groq_model', 'Model', { ph: 'openai/gpt-oss-120b' });
  add(adv, 'text', 'stt_language', 'Speech language code', { ph: 'en', hint: 'Leave blank for English.' });

  const saveMsg = el('div', { class: 'msg' });
  const close = () => { ov.classList.remove('on'); document.body.classList.remove('jv-settings'); window.__jvPaused = false; clearInterval(diagTimer); };
  const save = () => {
    const out = {};
    for (const i of inputs) { let v = i.value.trim(); if (i._key === 'use_gps') v = v !== 'false'; else if (i._num) v = v === '' ? '' : Number(v); out[i._key] = v; }
    out.wake_sensitivity = Number(sens.value); out.avatar_gender = gender; out.voice = vsel.value;
    J().config.merge(out); J().applySettings({ voiceChanged: true });
    saveMsg.className = 'msg ok'; saveMsg.textContent = 'Saved.'; setTimeout(close, 300);
  };
  ov.append(el('div', { class: 'bar' }, el('div', { class: 'row' }, el('button', { type: 'button', onclick: close }, 'Close'), el('button', { type: 'button', class: 'pri', onclick: save }, 'Save')), saveMsg));
  document.body.append(ov);

  const open = () => { J().refreshVoices(); gender = J().config.get('avatar_gender', 'male'); paintSeg(); fillVoices(); saveMsg.textContent = ''; ov.classList.add('on'); document.body.classList.add('jv-settings'); window.__jvPaused = true; paintDiag(); diagTimer = setInterval(paintDiag, 150); };
  J().openSettings = open;
  if (!J().api.ready()) open();
}
