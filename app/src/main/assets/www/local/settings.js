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
body.jv-settings #three, body.jv-settings #hud, body.jv-settings #jv-top, body.jv-settings #jv-cap, body.jv-settings #jv-card, body.jv-settings #jv-dock, body.jv-settings #jv-aura,
body.jv-settings #jv-hello, body.jv-settings #jv-chips, body.jv-settings #jv-toast,
body.jv-settings #bg-base, body.jv-settings #bg-rings, body.jv-settings #bg-halo, body.jv-settings #bg-floor, body.jv-settings #nav-frame, body.jv-settings #nav-orb { visibility: hidden !important; }
#jv-ov { position: fixed; inset: 0; z-index: 80; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; display: none; color: #eaf6ff;
  background: radial-gradient(90% 40% at 50% 0%, #0d2136 0%, #050b14 60%, #03070c 100%) fixed; font: 15px/1.45 Roboto, system-ui, sans-serif; }
#jv-ov.on { display: block; }
#jv-ov .box { max-width: 560px; margin: 0 auto; padding: 8px 16px calc(env(safe-area-inset-bottom, 0px) + 40px); }
/* header: close or back on the left, the title, Done on the right */
#jv-ov .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; padding: calc(env(safe-area-inset-top, 0px) + 10px) 10px 10px;
  background: rgba(4, 10, 18, .82); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); border-bottom: 1px solid rgba(160, 215, 255, .08); }
#jv-ov .bar .t { flex: 1; min-width: 0; font: 600 19px/1.2 'Saira', system-ui, sans-serif; font-stretch: 96%; color: #eaf6ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 4px; }
#jv-ov .bar .ic { width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #9db3c6; display: grid; place-items: center; flex: none; }
#jv-ov .bar .ic svg { width: 22px; height: 22px; }
#jv-ov .bar .pri { padding: 10px 18px; border-radius: 999px; flex: none; }
#jv-ov[data-page] .bar .x, #jv-ov:not([data-page]) .bar .back { display: none; }
#jv-ov .bar .msg { display: none; }
/* the menu */
#jv-ov .hero { display: flex; align-items: center; gap: 14px; margin: 14px 4px 22px; }
#jv-ov .hero .mark { width: 52px; height: 52px; border-radius: 50%; flex: none; background: radial-gradient(circle, #b6ecff 0 20%, rgba(127, 216, 255, .25) 24%, transparent 46%);
  border: 2px solid #7fd8ff; box-shadow: inset 0 0 0 6px #050b14, inset 0 0 0 7.5px rgba(127, 216, 255, .55), 0 0 22px rgba(127, 216, 255, .35); }
#jv-ov .hero h1 { margin: 0; font: 600 26px/1.1 'Saira', system-ui, sans-serif; font-stretch: 105%; color: #eaf6ff; }
#jv-ov .hero p { margin: 3px 0 0; font-size: 14px; color: #8aa1b5; }
#jv-ov .grp { margin: 0 4px 8px; font: 500 13px/1 Roboto, sans-serif; color: #8aa1b5; }
#jv-ov .menu { margin: 0 0 20px; border-radius: 20px; overflow: hidden; background: rgba(14, 28, 44, .62); border: 1px solid rgba(160, 215, 255, .08); }
#jv-ov .mi { width: 100%; display: flex; align-items: center; gap: 14px; padding: 13px 14px; border: 0; border-radius: 0; background: transparent; text-align: left; color: #eaf6ff; }
#jv-ov .mi + .mi { border-top: 1px solid rgba(160, 215, 255, .07); }
#jv-ov .mi:active { background: rgba(127, 216, 255, .06); }
#jv-ov .mi .ico { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; flex: none; background: color-mix(in srgb, var(--c) 18%, transparent); color: var(--c); }
#jv-ov .mi .ico svg { width: 21px; height: 21px; }
#jv-ov .mi .tx { flex: 1; min-width: 0; }
#jv-ov .mi .tx b { display: block; font-weight: 500; font-size: 16px; line-height: 1.25; }
#jv-ov .mi .tx span { display: block; font-size: 13px; color: #8aa1b5; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#jv-ov .mi .tx span.ok { color: #52f2b6; } #jv-ov .mi .tx span.warn { color: #ffb24c; }
#jv-ov .mi::after { content: ''; width: 8px; height: 8px; flex: none; border-right: 2px solid #61798d; border-top: 2px solid #61798d; transform: rotate(45deg); margin-right: 4px; }
#jv-ov[data-page] .hero, #jv-ov[data-page] .grp, #jv-ov[data-page] .menu { display: none; }
/* a page */
#jv-ov .page { display: none; padding-top: 6px; }
#jv-ov .page.on { display: block; }
#jv-ov .page > h2 { display: none; }
#jv-ov .page > p.hint:first-of-type { font-size: 14px; color: #9db3c6; margin: 6px 4px 14px; }
#jv-ov p.hint { margin: 4px 2px 10px; font-size: 13px; color: #7f97ab; }
#jv-ov label { display: block; margin: 16px 2px 6px; font-size: 14px; color: #c3d7e8; }
#jv-ov input, #jv-ov select { width: 100%; box-sizing: border-box; padding: 13px 14px; border-radius: 14px; border: 1px solid rgba(160, 215, 255, .14); background: rgba(10, 22, 38, .9); color: #eaf6ff; font-size: 16px; }
#jv-ov select { -webkit-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, #9db3c6 50%), linear-gradient(135deg, #9db3c6 50%, transparent 50%); background-position: calc(100% - 20px) 55%, calc(100% - 15px) 55%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 36px; }
#jv-ov input:focus, #jv-ov select:focus, #jv-ov button:focus-visible { outline: 2px solid #7fd8ff; outline-offset: 1px; }
#jv-ov input[type=range] { padding: 0; border: 0; background: none; accent-color: #7fd8ff; height: 32px; }
#jv-ov .row { display: flex; gap: 10px; align-items: center; margin-top: 12px; } #jv-ov .row > * { flex: 1; }
#jv-ov button { text-transform: none; letter-spacing: normal; text-shadow: none; font-family: Roboto, system-ui, sans-serif; padding: 13px 16px; border-radius: 14px; border: 1px solid rgba(160, 215, 255, .16); background: rgba(16, 32, 50, .9); color: #d6ecff; font-size: 15px; font-weight: 500; }
#jv-ov button:active { transform: scale(.98); }
#jv-ov button.pri { background: #7fd8ff; color: #03121f; border-color: #7fd8ff; font-weight: 600; }
#jv-ov .seg { display: flex; padding: 4px; gap: 4px; border-radius: 16px; background: rgba(10, 22, 38, .9); border: 1px solid rgba(160, 215, 255, .12); }
#jv-ov .seg button { flex: 1; border: 0; border-radius: 12px; background: transparent; color: #9db3c6; padding: 12px; }
#jv-ov .seg button[aria-pressed=true] { background: #16324c; color: #eaf6ff; box-shadow: 0 0 0 1px rgba(127, 216, 255, .35); }
#jv-ov .msg { min-height: 20px; margin-top: 8px; font-size: 14px; } #jv-ov .ok { color: #52f2b6; } #jv-ov .bad { color: #ff7a85; }
/* hearing check */
#jv-diag { margin-top: 14px; padding: 16px; border-radius: 18px; background: rgba(10, 22, 38, .9); border: 1px solid rgba(160, 215, 255, .1); }
#jv-diag .meter { position: relative; height: 10px; border-radius: 5px; background: #102235; overflow: hidden; margin: 8px 0 10px; }
#jv-diag .meter b { position: absolute; inset: 0; background: #52f2b6; transform-origin: 0 50%; transform: scaleX(0); will-change: transform; border-radius: 5px; }
#jv-diag .meter.wake b { background: #7fd8ff; }
#jv-diag dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; margin: 12px 0 0; font-size: 14px; }
#jv-diag dt { color: #7f97ab; } #jv-diag dd { margin: 0; color: #eaf6ff; overflow-wrap: anywhere; } #jv-diag dd.bad { color: #ff7a85; }
#jv-diag .flash { color: #52f2b6; font-weight: 600; }
/* phone powers */
#jv-ov .pw { padding: 14px 2px; border-top: 1px solid rgba(160, 215, 255, .08); }
#jv-ov .pw-t { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 15px; color: #eaf6ff; }
#jv-ov .pw-st { font-size: 13px; color: #7f97ab; white-space: nowrap; } #jv-ov .pw-st.ok { color: #52f2b6; }
#jv-ov .pw p.hint { margin: 4px 0 10px; }
#jv-ov .pw button { padding: 9px 18px; border-radius: 999px; }
@media (prefers-reduced-motion: reduce) { #jv-ov button:active { transform: none; } }
`;

const SVG = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
/** The menu: each section's page, its icon and colour, and the group it sits in. */
const PAGES = {
  'Brain': { id: 'brain', grp: 'Jarvis', c: '#7fd8ff', ic: SVG('<path d="M9 4.5a3 3 0 0 0-3 3v.3A3 3 0 0 0 4.5 13a3 3 0 0 0 2 4.8A3 3 0 0 0 12 19V6a2.5 2.5 0 0 0-3-1.5zM15 4.5a3 3 0 0 1 3 3v.3a3 3 0 0 1 1.5 5.2 3 3 0 0 1-2 4.8A3 3 0 0 1 12 19"/>') },
  'Voice and face': { id: 'voice', grp: 'Jarvis', c: '#b59bff', ic: SVG('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>') },
  'Hearing': { id: 'hearing', grp: 'Jarvis', c: '#52f2b6', ic: SVG('<path d="M7 9a5 5 0 0 1 10 0c0 3-3 3.5-3 6.5a3 3 0 0 1-5.5 1.6M10 9.5a2 2 0 0 1 4 0"/>') },
  'Offer reader': { id: 'offer', grp: 'On the road', c: '#ffb24c', ic: SVG('<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 10h8M8 14h5"/>') },
  'Navigation and deliveries': { id: 'nav', grp: 'On the road', c: '#ffb24c', ic: SVG('<path d="M12 21s-6-5.3-6-10.5a6 6 0 0 1 12 0C18 15.7 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>') },
  'Alerts': { id: 'alerts', grp: 'On the road', c: '#ffb24c', ic: SVG('<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2.2 2.2 0 0 0 4 0"/>') },
  'Phone powers': { id: 'powers', grp: 'This phone', c: '#7fd8ff', ic: SVG('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M12 7.5l-2 4h4l-2 4"/>') },
  'Safety': { id: 'safety', grp: 'This phone', c: '#ff5a67', ic: SVG('<path d="M12 3l7 3v5c0 5-3.2 8.3-7 10-3.8-1.7-7-5-7-10V6z"/><path d="M12 9v4M12 16h.01"/>') },
  'Smart home': { id: 'home', grp: 'This phone', c: '#52f2b6', ic: SVG('<path d="M4 11l8-6.5 8 6.5M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>') },
  'Advanced': { id: 'advanced', grp: 'More', c: '#9db3c6', ic: SVG('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>') },
};

function field(kind, key, label, opts = {}) {
  const c = J().config, cur = c.get(key, opts.def ?? '');
  const wrap = el('div'); wrap.append(el('label', {}, label));
  let inp;
  if (kind === 'select') { inp = el('select'); for (const [v, t] of opts.options) inp.append(el('option', { value: v }, t)); inp.value = String(cur); if (inp.value !== String(cur)) inp.value = opts.options[0][0]; }
  else { inp = el('input', { type: kind, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }); if (opts.ph) inp.placeholder = opts.ph; if (opts.inputmode) inp.setAttribute('inputmode', opts.inputmode); inp.value = cur == null ? '' : String(cur); }
  wrap.append(inp); if (opts.hint) wrap.append(el('p', { class: 'hint' }, opts.hint));
  inp._key = key; inp._num = !!opts.num; inp._def = opts.def ?? ''; return [wrap, inp];
}

export function initSettings() {
  if (document.getElementById('jv-ov')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const ov = el('div', { id: 'jv-ov', role: 'dialog', 'aria-label': 'Settings' }), box = el('div', { class: 'box' }); ov.append(box);
  const inputs = [];
  const add = (parent, kind, key, label, opts) => { const [w, i] = field(kind, key, label, opts); inputs.push(i); parent.append(w); return i; };
  const pages = [];
  const section = (title, hint) => {
    const meta = PAGES[title] || { id: title.toLowerCase().replace(/\W+/g, '-'), grp: 'More', c: '#9db3c6', ic: '' };
    const s = el('section', { class: 'page', 'data-id': meta.id }); s.append(el('h2', {}, title)); if (hint) s.append(el('p', { class: 'hint' }, hint));
    box.append(s); pages.push({ title, s, ...meta }); return s;
  };
  // header: close (menu) or back (a page), the title, Done (saves). The first button is always "close without saving".
  const bClose = el('button', { type: 'button', class: 'ic x', 'aria-label': 'Close without saving' }), bBack = el('button', { type: 'button', class: 'ic back', 'aria-label': 'Back to settings' });
  bClose.innerHTML = SVG('<path d="M6 6l12 12M18 6L6 18"/>'); bBack.innerHTML = SVG('<path d="M15 5l-7 7 7 7"/>');
  const barTitle = el('span', { class: 't' }, 'Settings'), bDone = el('button', { type: 'button', class: 'pri' }, 'Done');
  const hero = el('div', { class: 'hero' }, el('div', { class: 'mark', 'aria-hidden': 'true' }), el('div', {}, el('h1', {}, 'Jarvis'), el('p', {}, 'Settings stay on this phone.')));
  const menuWrap = el('div');
  box.append(hero, menuWrap);
  const go = id => {
    if (id) ov.setAttribute('data-page', id); else ov.removeAttribute('data-page');
    for (const p of pages) p.s.classList.toggle('on', p.id === id);
    const pg = pages.find(p => p.id === id); barTitle.textContent = pg ? pg.title : 'Settings';
    ov.scrollTop = 0;
  };
  bBack.onclick = () => go(null);

  // ---- brain
  // A build linked to the Jarvis service needs no key: the key field only exists under Advanced, as an optional override.
  // A build that isn't linked yet (the service secrets aren't set) still needs one, and says why.
  const proxy = J().api.hasProxy();
  const sBrain = section('Brain', proxy ? 'Jarvis is connected to the Jarvis service. No key or account needed.'
    : 'This copy of Jarvis isn\'t linked to the Jarvis service yet, so it needs a free Groq key from console.groq.com/keys. Copies built after the service is set up won\'t ask for one.');
  sBrain.id = 'jv-brain';
  let keyIn = null;
  const testMsg = el('div', { class: 'msg' });
  const testBtn = el('button', { id: 'jv-test', onclick: async () => {
    if (keyIn) J().config.set('groq_key', keyIn.value.trim());
    testMsg.className = 'msg'; testMsg.textContent = 'Checking…';
    const r = await J().verifyKey(); testMsg.className = 'msg ' + (r.ok ? 'ok' : 'bad'); testMsg.textContent = r.message;
  } }, 'Test connection');
  if (!proxy) keyIn = add(sBrain, 'password', 'groq_key', 'Groq API key', { ph: 'gsk_…' });
  sBrain.append(el('div', { class: 'row' }, testBtn), testMsg);
  add(sBrain, 'text', 'user_name', 'Your name', { ph: 'What should I call you?' });

  // ---- voice and face
  const sVoice = section('Voice and face');
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Voice' });
  const bMale = el('button', { type: 'button' }, 'Male'), bFemale = el('button', { type: 'button' }, 'Female');
  seg.append(bMale, bFemale); sVoice.append(seg);
  let gender = J().config.get('avatar_gender', 'male');
  const vsel = el('select', { 'aria-label': 'Voice' }); const vw = el('div'); vw.append(el('label', {}, 'Voice'), vsel); sVoice.append(vw);
  const vnote = el('p', { class: 'hint' }); sVoice.append(vnote);
  // the PC voice for this face: status + download
  const pcRow = el('div', { class: 'row', style: 'align-items:center' }), pcText = el('div', { style: 'flex:2;font-size:14px;color:#b9cfe3' }), pcBtn = el('button', { type: 'button' }, 'Download');
  pcRow.append(pcText, pcBtn); sVoice.append(pcRow);
  const paintPc = () => {
    const st = J().pcVoices ? J().pcVoices() : {}; if (!st || st.unavailable) { pcRow.style.display = 'none'; return; }
    const name = gender === 'female' ? 'amy' : 'alan', who = name === 'amy' ? 'Amy' : 'Alan', s = String(st[name] || 'missing');
    pcBtn.style.display = s === 'ready' || s.startsWith('downloading') ? 'none' : '';
    pcText.textContent = s === 'ready' ? `${who}, your PC voice, is on this phone.` : s.startsWith('downloading') ? `Downloading ${who}, your PC voice… ${s.split(':')[1] || 0}%`
      : s.startsWith('error') ? `${who} didn't download (${s.slice(6)}). Try again.` : `${who}, your PC voice, isn't on this phone yet (67 MB, once).`;
  };
  pcBtn.onclick = () => { J().ensurePcVoice(true); setTimeout(paintPc, 200); };
  J().onVoices = () => { if (ov.classList.contains('on')) { paintPc(); fillVoices(); } };
  const paintSeg = () => { bMale.setAttribute('aria-pressed', String(gender === 'male')); bFemale.setAttribute('aria-pressed', String(gender === 'female')); };
  const fillVoices = () => {
    vsel.replaceChildren();
    const g = gender === 'female' ? 'f' : 'm';
    const all = J().voices(), mine = all.filter(v => v.gender === g), unknown = all.filter(v => !v.gender);
    const list = mine.length ? mine : unknown;
    vsel.append(el('option', { value: '' }, 'Best match'));
    for (const v of list) vsel.append(el('option', { value: v.id }, v.name));
    const cur = J().config.get('voice', ''); if (cur && list.some(v => v.id === cur)) vsel.value = cur;
    vnote.textContent = mine.some(v => !v.pc) || mine.some(v => v.pc && !/\(/.test(v.name)) ? '' : `This phone has no ${gender} voice installed, so Jarvis changes the pitch. More voices: ${window.JARVIS_IOS ? 'Settings, Accessibility, Spoken Content, Voices, English (pick an Enhanced or Premium voice)' : 'Android Settings, Text-to-speech, Speech Services by Google, Install voice data'}.`;
  };
  const choose = g => { gender = g; paintSeg(); J().config.merge({ avatar_gender: g, voice: '' }); fillVoices(); J().announceVoice(); J().ensurePcVoice(); paintPc(); };
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
  const dMic = row('Microphone'), dWake = row('Wake word'), dVad = row('Speech detector'), dHeard = row('Last heard'), dBrain = row('Brain'), dSpeed = row('Speech to text'), dLat = row('Last answer');
  diag.append(el('div', {}, 'Your voice'), meter, el('div', {}, 'Wake score (say "Hey Jarvis")'), wmeter, dl);
  sEar.append(diag);
  let diagTimer = null, wakesSeen = 0;
  const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const paintDiag = () => {
    const s = J().stats; if (!s) return;
    meter.firstChild.style.transform = `scaleX(${Math.min(1, Math.sqrt(s.rms || 0) * 0.022).toFixed(3)})`;
    wmeter.firstChild.style.transform = `scaleX(${Math.min(1, s.score || 0).toFixed(3)})`;
    const micTxt = { listening: 'On', starting: 'Starting…', stopped: 'Stopped', 'no-permission': window.JARVIS_IOS ? 'No permission. Allow the microphone in the Settings app, under Jarvis.' : 'No permission. Allow the microphone in Android settings.', browser: 'Browser microphone' };
    put(dMic, micTxt[s.mic] || (String(s.mic).startsWith('listening-no-wake') ? 'On (wake word model failed to load)' : String(s.mic).replace(/^error:/, 'Error: ')));
    if (s.wakes > wakesSeen) { wakesSeen = s.wakes; dWake.className = 'flash'; put(dWake, `Heard you (score ${Number(s.lastWakeScore || 0).toFixed(2)})`); setTimeout(() => { dWake.className = ''; }, 2500); }
    else if (!dWake.className) put(dWake, s.wake ? `Ready · ${s.wakes} so far` : (s.wakeError ? 'Not loaded' : 'Loading…'));
    const h = s.heard && s.heard[0], d = s.dropped;
    const why = { rejected: 'ignored: too short or not for me', echo: 'ignored: sounded like my own voice' };
    const delay = typeof s.delayMs === 'number' ? ` · ${(s.delayMs / 1000).toFixed(1)} s after you stopped` : '';
    put(dHeard, d && (!h || d.at >= h.at) ? `${d.text} (${why[d.kind] || 'ignored'})` : h ? `"${h.text}"${delay}` : '—');
    put(dVad, s.vad ? (s.speech >= 0.5 ? 'Hearing speech' : 'Quiet / noise only') : (s.mic === 'browser' ? 'Loudness only' : 'Loading… (loudness meanwhile)'));
    const m = J().api.mode(); put(dBrain, m === 'key' ? 'Your Groq key' : m === 'proxy' ? 'Jarvis service' : 'Not set up');
    put(dSpeed, s.sttError ? `Failed: ${s.sttError}` : s.sttMs ? `Working · ${s.sttMs} ms · ${s.sttSent || 0} clips` : (s.sttSent ? `${s.sttSent} clips sent…` : 'Nothing sent yet'));
    dSpeed.className = s.sttError ? 'bad' : '';
    const L = s.lat; put(dLat, !L ? '—' : L.instant ? `Instant (done on the phone, ${L.firstWordsMs} ms)` : `First words ${(L.firstWordsMs / 1000).toFixed(1)} s after the words arrived · ${L.tools} tools sent${L.toolRounds ? ` · ${L.toolRounds} step${L.toolRounds > 1 ? 's' : ''}` : ''}${s.warmMs ? ` · link warmed in ${s.warmMs} ms` : ''}`);
  };

  // ---- offer reader
  const sOffer = section('Offer reader', 'When the DoorDash Dasher or Uber Driver app shows you an offer, Jarvis reads the pay, distance and time on it and tells you "take it", "your call" or "pass", using your pay floors below.');
  sOffer.append(el('p', { class: 'hint' }, 'To read the offer, Android has to let Jarvis see what those two apps show on screen (an accessibility permission). Jarvis only looks at the Dasher and Uber Driver apps, never taps, accepts or declines anything, and nothing it reads is saved or sent anywhere.'));
  const offerState = el('div', { style: 'font-size:14px;margin:8px 0' }), offerBtn = el('button', { type: 'button' }, 'Turn on the offer reader');
  const offerLast = el('p', { class: 'hint', style: 'overflow-wrap:anywhere' });
  offerBtn.onclick = () => J().openOfferSettings();
  sOffer.append(offerState, el('div', { class: 'row' }, offerBtn), offerLast);
  sOffer.append(el('p', { class: 'hint' }, 'On the page that opens, switch on "Jarvis offer reader". If the switch is greyed out or Android says "Restricted setting": open Android Settings, Apps, Jarvis, the ⋮ menu at the top right, "Allow restricted settings", then try again. (On Samsung phones it is also listed under Accessibility, Installed apps.)'));
  const paintOffer = () => {
    const st = J().offerStatus ? J().offerStatus() : null; if (!st) { sOffer.style.display = 'none'; return; }
    offerState.textContent = st.enabled ? 'On. Offers in the Dasher and Uber Driver apps are read automatically.' : 'Off.';
    offerState.className = st.enabled ? 'ok' : ''; offerBtn.textContent = st.enabled ? 'Accessibility settings' : 'Turn on the offer reader';
    const o = J().stats && J().stats.lastOffer;
    offerLast.textContent = o ? `Last offer: ${o.spoken}` : st.lastScreen ? `Last screen read: ${st.lastScreen.slice(0, 300)}` : '';
  };

  // ---- phone powers: what Jarvis may do on this phone, each switched on by the user
  const sPow = section('Phone powers', 'What Jarvis can do on this phone. Each one is off until you allow it, and you can take it back any time in ' + (window.JARVIS_IOS ? 'the Settings app.' : 'Android settings.'));
  sPow.id = 'jv-powers';
  const IOS = !!window.JARVIS_IOS, IOS_POWERS = new Set(['notifications', 'camera', 'contacts', 'calendar']);
  const POWERS_ALL = [
    ['notifications', 'Notifications', 'Reminders and timers pop up and ring, even when Jarvis is closed.'],
    ['exactAlarms', 'Reminders on the minute', 'Without this, Android may ring reminders a few minutes late.'],
    ['overlay', 'Open apps from the background', 'Lets Jarvis open apps, websites and calls while he isn\'t on screen (Android calls it "display over other apps").'],
    ['control', 'Phone control', 'Jarvis reads the screen and taps, types, scrolls, goes back or home, and takes screenshots when you ask ("open WhatsApp and message John", "what\'s on my screen"). On the page that opens, switch on "Jarvis phone control". He asks before sending anything and never operates the Dasher or Uber Driver apps.'],
    ['offer', 'Offer reader', 'Reads DoorDash and Uber Driver offers and says take it or pass. Switch on "Jarvis offer reader" on the page that opens.'],
    ['notifAccess', 'Read and reply to messages', '"Read my messages", "reply to John: on my way", and short announcements of new messages. Switch on "Jarvis notifications" on the page that opens.'],
    ['camera', 'Camera', 'Jarvis\'s eyes: "what is this?", "read this sign", "take a photo".'],
    ['contacts', 'Contacts', 'Call and text people by name.'],
    ['calls', 'Phone calls', 'Place calls straight away, without you tapping the call button.'],
    ['calendar', 'Calendar', '"What\'s on today?", "add a meeting tomorrow at 3".'],
    ['dnd', 'Do Not Disturb and silent', 'Switch Do Not Disturb and silent mode by voice.'],
    ['brightness', 'Brightness', 'Change screen brightness by voice.'],
  ];
  const POWERS = IOS ? POWERS_ALL.filter(([k]) => IOS_POWERS.has(k)).concat([['mic', 'Microphone', 'Hearing "Hey Jarvis" and what you ask him.'], ['location', 'Location', 'Directions, your delivery route, weather where you are, parking, SOS.']]) : POWERS_ALL;
  const powRows = {};
  const powList = el('div');
  for (const [k, title, hint] of POWERS) {
    const st = el('span', { class: 'pw-st' }), btn = el('button', { type: 'button', 'data-power': k, onclick: () => { J().phone && J().phone.request(k); } }, 'Allow');
    const r = el('div', { class: 'pw' }, el('div', { class: 'pw-t' }, el('b', {}, title), st), el('p', { class: 'hint' }, hint), btn);
    powRows[k] = { st, btn }; powList.append(r);
  }
  sPow.append(el('div', { class: 'row' }, el('button', { type: 'button', id: 'jv-setup-again', onclick: () => { close(); setTimeout(() => { if (J().setup && !J().setup.open(true)) { /* everything already on */ } }, 50); } }, 'Set up permissions, step by step')));
  sPow.append(powList);
  const ann = el('select', { 'aria-label': 'Read new messages out loud' });
  for (const [v, t] of [['false', 'No'], ['true', 'Yes, read new messages out loud']]) ann.append(el('option', { value: v }, t));
  ann.value = String(!!J().config.get('announce_messages', false));
  ann.onchange = () => { const on = ann.value === 'true'; J().config.set('announce_messages', on); try { window.AndroidBridge && window.AndroidBridge.setAnnounceMessages && window.AndroidBridge.setAnnounceMessages(on); } catch {} if (on && J().phone && !J().phone.status().notifAccess) J().phone.request('notifAccess'); };
  if (!IOS) {
    sPow.append(el('label', {}, 'Read new messages out loud as they arrive (good while driving)'), ann);
    sPow.append(el('p', { class: 'hint' }, 'If Android says a setting is restricted: open Android Settings, Apps, Jarvis, the three-dot menu, "Allow restricted settings", then try again.'));
  } else {
    sPow.append(el('p', { class: 'hint' }, 'Something you said no to can only be switched back on in the Settings app, under Jarvis. Apple doesn\'t let any app read other apps\' messages, work other apps or change the volume, so Jarvis can\'t do those on iPhone.'));
  }
  const paintPowers = () => {
    const s = J().phone ? J().phone.status() : {};
    if (!s || !Object.keys(s).length) { sPow.style.display = 'none'; return; }
    for (const [k] of POWERS) {
      const on = !!s[k], r = powRows[k]; if (!r) continue;
      const txt = on ? (k === 'control' && !s.controlRunning ? 'On (starting…)' : 'On') : 'Off';
      if (r.st.textContent !== txt) { r.st.textContent = txt; r.st.className = 'pw-st ' + (on ? 'ok' : ''); }
      r.btn.style.display = on ? 'none' : '';
    }
  };

  // ---- smart home
  const sHome = section('Smart home', 'Lights, plugs, thermostats, blinds and locks by voice, through Home Assistant (works with most brands) or a Philips Hue bridge.');
  add(sHome, 'text', 'ha_url', 'Home Assistant address', { ph: 'http://192.168.1.20:8123', hint: 'Your home address for Home Assistant, or its Nabu Casa link to use it away from home.' });
  add(sHome, 'password', 'ha_token', 'Home Assistant token', { ph: 'eyJ…', hint: 'In Home Assistant: your profile, Security, Long-lived access tokens, Create token.' });
  add(sHome, 'text', 'hue_ip', 'Hue bridge address', { ph: 'Found by "Connect Hue bridge"' });
  const homeMsg = el('div', { class: 'msg', id: 'jv-home-msg' });
  const homeRun = async (tool, busy) => {
    for (const i of inputs) if (['ha_url', 'ha_token', 'hue_ip'].includes(i._key)) J().config.set(i._key, i.value.trim());
    homeMsg.className = 'msg'; homeMsg.textContent = busy;
    const r = await J().reg.exec(tool, '{}'); homeMsg.className = 'msg ' + (/couldn't|can't|didn't|refused|haven't/i.test(r) ? 'bad' : 'ok'); homeMsg.textContent = r.length > 260 ? r.slice(0, 260) + '…' : r;
  };
  sHome.append(el('div', { class: 'row' }, el('button', { type: 'button', id: 'jv-home-test', onclick: () => homeRun('smart_home_devices', 'Checking…') }, 'Test connection'),
    el('button', { type: 'button', onclick: () => homeRun('connect_hue', 'Looking for your Hue bridge…') }, 'Connect Hue bridge')), homeMsg);

  // ---- safety
  const sSafe = section('Safety', 'Say "emergency" and Jarvis texts these people your location, then an update every 5 minutes until you say "I\'m safe".');
  sSafe.id = 'jv-safety';
  const ecList = el('div'), ecIn = el('input', { type: 'text', placeholder: 'A name in your contacts, or a number', autocomplete: 'off', 'aria-label': 'Add an emergency contact' }), ecMsg = el('div', { class: 'msg' });
  const paintEc = () => {
    ecList.textContent = '';
    const l = J().config.get('emergency_contacts', []) || [];
    if (!l.length) ecList.append(el('p', { class: 'hint' }, 'No emergency contacts yet.'));
    for (const c of l) ecList.append(el('div', { class: 'pw' }, el('div', { class: 'pw-t' }, el('b', {}, c.name), el('span', { class: 'pw-st' }, c.number)),
      el('button', { type: 'button', onclick: async () => { await J().reg.exec('set_emergency_contact', JSON.stringify({ who: c.name, remove: true })); paintEc(); } }, 'Remove')));
  };
  sSafe.append(ecList, el('label', {}, 'Add an emergency contact'), ecIn, el('div', { class: 'row' }, el('button', { type: 'button', onclick: async () => {
    if (!ecIn.value.trim()) return; ecMsg.className = 'msg'; ecMsg.textContent = 'Adding…';
    const r = await J().reg.exec('set_emergency_contact', JSON.stringify({ who: ecIn.value.trim() })); ecMsg.className = 'msg ' + (/now an emergency contact/.test(r) ? 'ok' : 'bad'); ecMsg.textContent = r; ecIn.value = ''; paintEc();
  } }, 'Add contact')), ecMsg);

  // ---- alerts
  const sAl = section('Alerts', 'Things Jarvis tells you without being asked.');
  add(sAl, 'time', 'pa_briefing', 'Morning briefing', { hint: 'Weather, your calendar, reminders and the news at this time every day. Leave blank for none.' });
  const yesNo = [['true', 'On'], ['false', 'Off']];
  add(sAl, 'select', 'pa_weather', 'Severe weather where you are', { def: 'true', options: yesNo });
  add(sAl, 'select', 'pa_leave', 'Time to leave for calendar events', { def: 'true', options: yesNo });
  add(sAl, 'select', 'pa_birthdays', 'Birthdays from your contacts', { def: 'true', options: yesNo });
  add(sAl, 'select', 'pa_battery', 'Low battery while driving', { def: 'true', options: yesNo });
  add(sAl, 'select', 'pa_breaks', 'Break reminders on long shifts', { def: 'true', options: yesNo });

  // ---- navigation & delivery
  const nd = section('Navigation and deliveries', 'Maps, distances and the pay you accept.');
  add(nd, 'select', 'units', 'Distance', { def: 'auto', options: [['auto', 'Automatic'], ['miles', 'Miles'], ['km', 'Kilometres']] });
  add(nd, 'text', 'currency', 'Currency symbol', { def: '$', ph: '$' });
  add(nd, 'text', 'areas', 'Busy areas (comma-separated)', { ph: 'Downtown, Airport', hint: 'Used to suggest where to wait between orders.' });
  add(nd, 'number', 'min_per_hour', 'Lowest pay per hour you accept (offer reader uses this)', { num: true, inputmode: 'decimal', ph: '18' });
  add(nd, 'number', 'min_per_mile', 'Lowest pay per mile you accept (offer reader uses this)', { num: true, inputmode: 'decimal', ph: '1.50' });
  add(nd, 'select', 'use_gps', 'Use GPS', { def: 'true', options: [['true', 'Yes'], ['false', 'No, I will say where I am']] });
  add(nd, 'select', 'map_theme', 'Map colours', { def: 'auto', options: [['auto', 'Follow the time of day'], ['night', 'Always night'], ['day', 'Always day']] });
  add(nd, 'select', 'map_provider', 'Map', { def: 'jarvis', options: [['jarvis', 'Jarvis map (free)'], ['google', 'Google Maps (needs key)'], ['apple', 'Apple Maps (needs token)']] });
  add(nd, 'password', 'google_key', 'Google Maps JavaScript API key (optional)', { ph: 'AIza…' });
  add(nd, 'password', 'apple_token', 'Apple MapKit JS token (optional)', { ph: 'eyJ…' });

  const adv = section('Advanced', 'How hard Jarvis thinks, what he learns, and the model he uses.');
  add(adv, 'select', 'reasoning', 'Thinking effort', { def: 'auto', options: [['auto', 'Automatic: quick for simple things, deeper for hard questions'], ['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High (slowest, most careful)']] });
  add(adv, 'select', 'learn', 'Learn about me from our conversations', { def: 'true', options: [['true', 'Yes: remember lasting things I mention (name, people, places, likes)'], ['false', 'No: only when I say "remember"']] });
  add(adv, 'text', 'groq_model', 'Model', { ph: 'openai/gpt-oss-120b' });
  add(adv, 'text', 'stt_language', 'Speech language code', { ph: 'en', hint: 'Leave blank for English.' });
  if (proxy) keyIn = add(adv, 'password', 'groq_key', 'Your own Groq key (optional)', { ph: 'gsk_…', hint: 'Not needed. Only if you want Jarvis to use your own Groq account instead of the Jarvis service.' });

  const saveMsg = el('div', { class: 'msg' });
  const close = () => { ov.classList.remove('on'); document.body.classList.remove('jv-settings'); window.__jvPaused = false; clearInterval(diagTimer); };
  const save = () => {
    const out = {};
    for (const i of inputs) { let v = i.value.trim(); if (i._key === 'use_gps' || i._key === 'learn' || (/^pa_/.test(i._key) && i._key !== 'pa_briefing')) v = v !== 'false'; else if (i._num) v = v === '' ? '' : Number(v); out[i._key] = v; }
    out.wake_sensitivity = Number(sens.value); out.avatar_gender = gender; out.voice = vsel.value;
    J().config.merge(out); J().applySettings({ voiceChanged: true });
    saveMsg.className = 'msg ok'; saveMsg.textContent = 'Saved.'; setTimeout(close, 300);
  };
  bClose.onclick = close; bDone.onclick = save;
  ov.prepend(el('div', { class: 'bar' }, bClose, bBack, barTitle, bDone)); saveMsg.hidden = true; box.append(saveMsg);
  document.body.append(ov);

  let powTick = 0;
  /** Fresh values every time Settings opens: something may have changed by voice since (a Hue bridge, a key...). */
  const reload = () => {
    for (const i of inputs) {
      const v = J().config.get(i._key, i._def); i.value = v == null ? '' : String(v);
      if (i.tagName === 'SELECT' && i.value !== String(v ?? '')) i.value = i.options[0].value;
    }
  };
  const menuSub = {
    brain: () => J().api.ready() ? [J().api.mode() === 'proxy' ? 'Connected to the Jarvis service' : 'Using your Groq key', 'ok'] : ['Needs a key', 'warn'],
    voice: () => [(gender === 'female' ? 'Female' : 'Male') + ' voice and face'],
    hearing: () => { const s = J().stats || {}; return [s.wake ? `Wake word ready, ${s.wakes || 0} wakes so far` : 'Wake word loading']; },
    offer: () => { const st = J().offerStatus ? J().offerStatus() : null; return st && st.enabled ? ['On', 'ok'] : ['Off']; },
    nav: () => [`${{ jarvis: 'Jarvis map', google: 'Google Maps', apple: 'Apple Maps' }[J().config.get('map_provider', 'jarvis')] || 'Jarvis map'}, ${{ auto: 'automatic units', miles: 'miles', km: 'kilometres' }[J().config.get('units', 'auto')] || 'automatic units'}`],
    alerts: () => { const b = J().config.get('pa_briefing', ''); return [b ? `Morning briefing at ${b}` : 'No morning briefing']; },
    powers: () => { const st = J().phone ? J().phone.status() : {}; const ks = POWERS.map(([k]) => k); const on = ks.filter(k => st && st[k]).length; return [`${on} of ${ks.length} on`, on === ks.length ? 'ok' : '']; },
    safety: () => { const n = (J().config.get('emergency_contacts', []) || []).length; return [n ? `${n} emergency contact${n > 1 ? 's' : ''}` : 'No emergency contacts yet', n ? 'ok' : 'warn']; },
    home: () => [J().config.get('ha_url', '') ? 'Home Assistant' : J().config.get('hue_user', '') ? 'Philips Hue' : 'Not connected'],
    advanced: () => [{ auto: 'Automatic thinking', low: 'Fast thinking', medium: 'Medium thinking', high: 'Careful thinking' }[J().config.get('reasoning', 'auto')] || 'Automatic thinking'],
  };
  const paintMenu = () => {
    menuWrap.replaceChildren();
    let grp = null, list = null;
    const ORDER = ['Jarvis', 'On the road', 'This phone', 'More'];
    for (const p of [...pages].sort((a, b) => ORDER.indexOf(a.grp) - ORDER.indexOf(b.grp))) {
      if (p.s.style.display === 'none') continue;                     // a section this phone doesn't have
      if (p.grp !== grp) { grp = p.grp; menuWrap.append(el('div', { class: 'grp' }, grp)); list = el('div', { class: 'menu' }); menuWrap.append(list); }
      let sub = ['', '']; try { sub = (menuSub[p.id] || (() => ['']))(); } catch {}
      const ico = el('span', { class: 'ico', 'aria-hidden': 'true', style: `--c:${p.c}` }); ico.innerHTML = p.ic;
      const b = el('button', { type: 'button', class: 'mi', 'data-go': p.id }, ico, el('span', { class: 'tx' }, el('b', {}, p.title), el('span', { class: sub[1] || '' }, sub[0] || '')));
      b.onclick = () => go(p.id); list.append(b);
    }
  };
  const open = page => { reload(); J().refreshVoices(); gender = J().config.get('avatar_gender', 'male'); paintSeg(); fillVoices(); paintPc(); saveMsg.textContent = ''; ov.classList.add('on'); document.body.classList.add('jv-settings'); window.__jvPaused = true; paintDiag(); diagTimer = setInterval(() => { paintDiag(); paintOffer(); if (++powTick % 4 === 0) paintPowers(); }, 300); paintOffer(); paintPowers(); paintEc(); paintMenu(); go(typeof page === 'string' ? page : (!J().api.ready() ? 'brain' : null)); };
  J().openSettings = open;
  if (!J().api.ready()) open('brain');
}
