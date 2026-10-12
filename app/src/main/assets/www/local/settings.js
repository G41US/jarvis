// settings.js - the phone's settings screen. Opens by itself the first time (no Groq key yet), and from the gear button afterwards.
// Everything is stored on the phone (localStorage); keys never go anywhere except to the service they belong to.
const J = () => window.JARVIS;
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'style') e.style.cssText = v; else if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) e.append(k && k.nodeType ? k : document.createTextNode(k == null ? '' : String(k)));
  return e;
};

const CSS = `
#jv-gear,#jv-talk{position:fixed;z-index:60;top:calc(env(safe-area-inset-top,0px) + 10px);height:38px;border-radius:19px;border:1px solid rgba(90,170,220,.5);background:rgba(8,18,30,.78);color:#8fd0ff;
  font:600 12px/38px Consolas,Monaco,monospace;letter-spacing:1px;text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(6px)}
#jv-gear{right:10px;width:38px;font-size:19px}
#jv-talk{right:56px;padding:0 14px}
#jv-ov{position:fixed;inset:0;z-index:80;background:rgba(2,6,12,.94);overflow-y:auto;-webkit-overflow-scrolling:touch;display:none;color:#cfe6fa;font:14px/1.4 system-ui,sans-serif}
#jv-ov.on{display:block}
#jv-ov .box{max-width:560px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 16px) 16px 40px}
#jv-ov h1{margin:6px 0 2px;font:700 20px Consolas,monospace;letter-spacing:3px;color:#7fd0ff}
#jv-ov h2{margin:22px 0 6px;font:700 12px Consolas,monospace;letter-spacing:2px;color:#5fa8d8;text-transform:uppercase;border-bottom:1px solid rgba(90,170,220,.25);padding-bottom:4px}
#jv-ov p.hint{margin:2px 0 8px;font-size:12px;color:#7d9bb5}
#jv-ov label{display:block;margin:10px 0 3px;font-size:13px;color:#a8c8e8}
#jv-ov input,#jv-ov select{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:8px;border:1px solid rgba(90,170,220,.35);background:#0a1522;color:#e6f3ff;font-size:15px}
#jv-ov .row{display:flex;gap:8px;align-items:center}#jv-ov .row>*{flex:1}
#jv-ov button{padding:11px 14px;border-radius:8px;border:1px solid rgba(90,170,220,.6);background:#0f2236;color:#bfe4ff;font-size:14px;font-weight:600}
#jv-ov button.pri{background:#0d6aa8;color:#fff;border-color:#2aa0e8}
#jv-ov .msg{min-height:18px;margin-top:6px;font-size:13px}#jv-ov .ok{color:#6fe39a}#jv-ov .bad{color:#ff8a80}
#jv-ov .bar{position:sticky;bottom:0;margin-top:22px;padding:12px 0;background:linear-gradient(transparent,#02060c 40%)}
`;

function field(kind, key, label, opts = {}) {
  const c = J().config, cur = c.get(key, opts.def ?? '');
  const wrap = el('div'); wrap.append(el('label', {}, label));
  let inp;
  if (kind === 'select') { inp = el('select'); for (const [v, t] of opts.options) { const o = el('option', { value: v }, t); inp.append(o); } inp.value = String(cur); if (inp.value !== String(cur)) inp.value = opts.options[0][0]; }
  else { inp = el('input', { type: kind, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }); if (opts.ph) inp.placeholder = opts.ph; if (opts.inputmode) inp.setAttribute('inputmode', opts.inputmode); inp.value = cur == null ? '' : String(cur); }
  wrap.append(inp); if (opts.hint) wrap.append(el('p', { class: 'hint' }, opts.hint));
  inp._key = key; inp._num = !!opts.num; return [wrap, inp];
}

export function initSettings() {
  if (document.getElementById('jv-ov')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const ov = el('div', { id: 'jv-ov' }), box = el('div', { class: 'box' }); ov.append(box);
  const inputs = [];
  const add = (kind, key, label, opts) => { const [w, i] = field(kind, key, label, opts); inputs.push(i); box.append(w); return i; };
  const section = (t, hint) => { box.append(el('h2', {}, t)); if (hint) box.append(el('p', { class: 'hint' }, hint)); };

  box.append(el('h1', {}, 'JARVIS'), el('p', { class: 'hint' }, 'Everything here is stored on this phone only.'));

  section('Brain (required)', 'Jarvis thinks and listens through Groq. The free plan is enough. Get a key at console.groq.com/keys, then paste it here.');
  const keyIn = add('password', 'groq_key', 'Groq API key', { ph: 'gsk_...' });
  const testMsg = el('div', { class: 'msg' });
  box.append(el('div', { class: 'row' }, el('button', { id: 'jv-test', onclick: async () => {
    J().config.set('groq_key', keyIn.value.trim()); testMsg.className = 'msg'; testMsg.textContent = 'Testing...';
    const r = await J().verifyKey(); testMsg.className = 'msg ' + (r.ok ? 'ok' : 'bad'); testMsg.textContent = r.message;
  } }, 'Test connection')), testMsg);
  add('text', 'user_name', 'Your name', { ph: 'What should I call you?' });

  section('Voice');
  const vsel = el('select'); const vw = el('div'); vw.append(el('label', {}, 'Voice (from your phone\'s speech engine)'), vsel); box.append(vw);
  const fillVoices = () => { vsel.replaceChildren(); const list = J().voices(); if (!list.length) vsel.append(el('option', { value: '' }, 'Phone default')); for (const v of list) vsel.append(el('option', { value: v.id }, v.name)); const cur = J().config.get('voice', ''); if (cur) vsel.value = cur; };
  const [gw, gsel] = field('select', 'avatar_gender', 'Face', { def: 'male', options: [['male', 'Male (Adam)'], ['female', 'Female']] }); inputs.push(gsel); box.append(gw);
  gsel.addEventListener('change', () => { J().config.set('avatar_gender', gsel.value); fillVoices(); });
  box.append(el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { onclick: () => { if (vsel.value) J().setVoice(vsel.value); J().speakTest('Jarvis online. How do I sound?'); } }, 'Hear this voice')));

  section('Navigation & delivery');
  add('select', 'units', 'Distance units', { def: 'auto', options: [['auto', 'Automatic'], ['miles', 'Miles'], ['km', 'Kilometres']] });
  add('text', 'currency', 'Currency symbol', { def: '$', ph: '$' });
  add('text', 'areas', 'Hot areas (comma-separated)', { ph: 'Downtown, Airport', hint: 'Used to suggest where to wait between orders.' });
  add('number', 'min_per_hour', 'Minimum pay per hour', { num: true, inputmode: 'decimal', ph: '20' });
  add('number', 'min_per_mile', 'Minimum pay per mile', { num: true, inputmode: 'decimal', ph: '1.5' });
  add('select', 'use_gps', 'Use GPS', { def: 'true', options: [['true', 'Yes'], ['false', 'No - I will say where I am']] });
  add('select', 'map_theme', 'Map theme', { def: 'auto', options: [['auto', 'Follow the time of day'], ['night', 'Always night'], ['day', 'Always day']] });
  add('select', 'map_provider', 'Map', { def: 'jarvis', options: [['jarvis', 'Jarvis map (free)'], ['google', 'Google Maps (needs key)'], ['apple', 'Apple Maps (needs token)']] });
  add('password', 'google_key', 'Google Maps JavaScript API key (optional)', { ph: 'AIza...' });
  add('password', 'apple_token', 'Apple MapKit JS token (optional)', { ph: 'eyJ...' });

  section('Advanced');
  add('select', 'reasoning', 'Thinking effort', { def: 'low', options: [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High']] });
  add('text', 'groq_model', 'Groq model', { ph: 'openai/gpt-oss-120b' });
  add('text', 'stt_language', 'Speech language code', { ph: 'en', hint: 'Leave blank for English.' });

  const saveMsg = el('div', { class: 'msg' });
  const save = () => {
    const c = J().config, out = {};
    for (const i of inputs) {
      let v = i.value.trim();
      if (i._key === 'use_gps') v = v !== 'false';
      else if (i._num) v = v === '' ? '' : Number(v);
      out[i._key] = v;
    }
    if (vsel.value) out.voice = vsel.value;
    c.merge(out); J().applySettings();
    saveMsg.className = 'msg ok'; saveMsg.textContent = 'Saved.';
    setTimeout(() => ov.classList.remove('on'), 350);
  };
  box.append(el('div', { class: 'bar' }, el('div', { class: 'row' }, el('button', { onclick: () => ov.classList.remove('on') }, 'Close'), el('button', { class: 'pri', onclick: save }, 'Save')), saveMsg));
  document.body.append(ov);

  const open = () => { fillVoices(); saveMsg.textContent = ''; ov.classList.add('on'); };
  document.body.append(
    el('div', { id: 'jv-gear', title: 'Settings', onclick: open }, '⚙'),
    el('div', { id: 'jv-talk', title: 'Talk to Jarvis', onclick: () => J().wake() }, 'TALK'));
  J().openSettings = open;
  if (!J().brain.key()) open();
}
