// setup.js - the first-run walkthrough. Android's own pop-ups cover the ordinary permissions (microphone, location,
// camera, contacts...), all asked together at the start. The special switches Android keeps in Settings (reading
// messages, phone control, the offer reader, opening apps from the background...) are then taken one at a time:
// one tap opens the exact page, and when you come back Jarvis checks it and moves on by himself.
// Opens by itself once; afterwards from Settings, "Set up permissions".
const W = window;
const P = () => W.AndroidPhone || null;
const status = () => { try { return JSON.parse(P().status() || '{}'); } catch { return {}; } };

export const STEPS = [
  { k: 'basics', title: 'Hear, see and help', why: 'Microphone, location, notifications, camera, contacts, calls, texts and calendar. Android asks for each one in turn: tap Allow (or "While using the app").',
    done: s => !!(s.mic !== false && s.location && s.notifications && s.camera && s.contacts && s.calls && s.sms && s.calendar), btn: 'Allow' },
  { k: 'notifAccess', title: 'Read and announce your messages', why: 'So Jarvis can tell you who messaged you ("Ada sent you a voice note") and reply for you. On the page that opens, switch on Jarvis notifications.', done: s => !!s.notifAccess, gated: true },
  { k: 'control', title: 'Phone control', why: 'So Jarvis can open apps, read your screen, tap, type, scroll and go back when you ask. On the page that opens, switch on Jarvis phone control and confirm. (If you see a list instead: on Samsung look under Installed apps; elsewhere under Downloaded apps.)', done: s => !!s.control, gated: true },
  { k: 'offer', title: 'Offer reader (for drivers)', why: 'Reads DoorDash and Uber Driver offers off the screen and tells you take it or pass. On the page that opens, switch on Jarvis offer reader (in a list, look under Installed apps or Downloaded apps). Skip this if you don\'t drive.', done: s => !!s.offer, gated: true, optional: true },
  { k: 'overlay', title: 'Open apps for you', why: 'Lets Jarvis open apps, maps and calls while he isn\'t on screen. Find Jarvis in the list and switch it on.', done: s => !!s.overlay },
  { k: 'exactAlarms', title: 'Reminders on the minute', why: 'Without this, Android may ring reminders a few minutes late. Switch it on for Jarvis.', done: s => !!s.exactAlarms },
  { k: 'dnd', title: 'Do Not Disturb', why: 'So you can say "silent mode" or "do not disturb on". Switch it on for Jarvis.', done: s => !!s.dnd, optional: true },
  { k: 'brightness', title: 'Brightness', why: 'So you can say "brighter" or "dim the screen". Switch on "Allow modifying system settings".', done: s => !!s.brightness, optional: true },
];

const CSS = `
#jv-setup { position: fixed; inset: 0; z-index: 90; display: none; background: radial-gradient(120% 80% at 50% 0%, #0b2236 0%, #03070d 60%); color: #e8f4ff;
  font: 15px/1.5 Roboto, system-ui, sans-serif; overflow-y: auto; }
#jv-setup.on { display: block; }
#jv-setup .wrap { max-width: 520px; margin: 0 auto; padding: calc(env(safe-area-inset-top, 0px) + 28px) 20px calc(env(safe-area-inset-bottom, 0px) + 28px); min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
#jv-setup .kicker { font: 600 13px/1 'Saira', system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #7fd6ff; }
#jv-setup h1 { margin: 10px 0 6px; font: 600 30px/1.1 'Saira', system-ui, sans-serif; color: #fff; }
#jv-setup .lead { color: #8ea9c1; margin: 0 0 18px; }
#jv-setup .dots { display: flex; gap: 6px; margin: 4px 0 22px; }
#jv-setup .dots i { flex: 1; height: 4px; border-radius: 2px; background: #15304a; }
#jv-setup .dots i.ok { background: #5ef0a0; } #jv-setup .dots i.now { background: #7fd6ff; }
#jv-setup .card { padding: 20px; border-radius: 18px; background: rgba(9, 24, 40, .85); border: 1px solid #1a3550; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
#jv-setup .card h2 { margin: 0 0 8px; font: 600 21px/1.2 'Saira', system-ui, sans-serif; color: #fff; }
#jv-setup .card p { margin: 0; color: #b9cfe3; }
#jv-setup .note { margin-top: 14px; padding: 12px 14px; border-radius: 12px; background: #2a1a0b; border: 1px solid #6b4a1f; color: #ffd9a8; font-size: 14px; display: none; }
#jv-setup .note.on { display: block; }
#jv-setup .note b { color: #fff; }
#jv-setup .btns { display: flex; gap: 10px; margin-top: 18px; }
#jv-setup button { text-shadow: none; flex: 1; padding: 14px; border-radius: 12px; border: 1px solid #2a4a66; background: #0c1c2e; color: #cfe9ff; font: 500 16px Roboto, system-ui, sans-serif; text-transform: none; letter-spacing: normal; }
#jv-setup button.pri { background: #7fd6ff; color: #03121f; border-color: #7fd6ff; font-weight: 600; }
#jv-setup button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
#jv-setup .later { margin-top: auto; padding-top: 22px; text-align: center; }
#jv-setup .later button { flex: none; background: none; border: 0; color: #6f8aa3; font-size: 14px; padding: 8px; text-decoration: underline; }
#jv-setup .state { margin-top: 12px; font-size: 14px; min-height: 20px; color: #6f8aa3; } #jv-setup .state.ok { color: #5ef0a0; }
`;

export function createSetup({ config, say = () => {} }) {
  let ov = null, i = 0, tries = 0, failed = 0, opened = false;
  const steps = () => STEPS;
  const pending = s => steps().filter(st => !st.done(s) && !(config.get('setup_skip', []) || []).includes(st.k));
  function build() {
    if (ov) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    ov = document.createElement('div'); ov.id = 'jv-setup'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'jv-setup-h');
    ov.innerHTML = `<div class="wrap"><div class="kicker">Setting up Jarvis</div><h1 id="jv-setup-h">Let's give me my powers</h1>
      <p class="lead">A few switches so I can actually do things on this phone. Each takes a tap or two.</p><div class="dots"></div>
      <div class="card"><h2></h2><p class="why"></p><div class="note"></div><div class="state" aria-live="polite"></div>
      <div class="btns"><button type="button" class="skip">Skip</button><button type="button" class="pri go">Allow</button></div></div>
      <div class="later"><button type="button" class="done">I'll finish this later</button></div></div>`;
    document.body.append(ov);
    ov.querySelector('.go').onclick = go; ov.querySelector('.skip').onclick = skip; ov.querySelector('.done').onclick = () => close(false);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ov.classList.contains('on')) setTimeout(recheck, 400); });
    W.addEventListener('focus', () => { if (ov.classList.contains('on')) setTimeout(recheck, 400); });
  }
  const cur = () => steps()[i];
  function paint(msg = '', ok = false) {
    const s = status(), step = cur();
    const dots = ov.querySelector('.dots'); dots.replaceChildren(...steps().map((x, k) => { const d = document.createElement('i'); if (x.done(s)) d.className = 'ok'; else if (k === i) d.className = 'now'; return d; }));
    ov.querySelector('.card h2').textContent = step.title + (step.optional ? ' (optional)' : '');
    ov.querySelector('.why').textContent = step.why;
    ov.querySelector('.go').textContent = tries && step.k !== 'basics' ? 'Open it again' : (step.btn || 'Open');
    const note = ov.querySelector('.note');
    if (step.gated && (s.restricted || failed > 0)) {
      note.innerHTML = `${s.restricted ? 'Android is blocking this switch because Jarvis was installed from a file, not the Play Store.' : 'If Android said <b>Restricted setting</b>, or the switch is greyed out:'} ` +
        `tap <b>Open App info</b>, then the <b>⋮</b> menu at the top right, then <b>Allow restricted settings</b>. Come back and tap <b>Open it again</b>.` +
        `<div class="btns" style="margin-top:10px"><button type="button" class="info">Open App info</button></div>`;
      note.querySelector('.info').onclick = () => { try { P().request('appInfo'); } catch {} };
      note.classList.add('on');
    } else note.classList.remove('on');
    const stEl = ov.querySelector('.state'); stEl.textContent = msg; stEl.className = 'state' + (ok ? ' ok' : '');
  }
  function next(msg) {
    const s = status(), skipped = config.get('setup_skip', []) || [];
    let k = i + 1; while (k < steps().length && (steps()[k].done(s) || skipped.includes(steps()[k].k))) k++;
    if (k >= steps().length) { finish(); return; }
    i = k; tries = 0; failed = 0; paint(msg, true); focusGo();
  }
  const focusGo = () => { try { ov.querySelector('.go').focus(); } catch {} };
  function go() {
    const step = cur(); tries++; opened = true;
    let r = ''; try { r = P().request(step.k); } catch {}
    if (r === 'granted') { opened = false; next('Already on.'); return; }
    paint(step.k === 'basics' ? 'Answer Android\'s questions…' : 'Switch it on, then come back here.');
  }
  function recheck() {
    if (!opened) return; const s = status(), step = cur(); opened = false;
    if (step.done(s)) next(`${step.title}: on.`);
    else { failed++; paint(step.k === 'basics' ? 'Some were not allowed. You can allow them later when Jarvis needs them.' : 'Not switched on yet.'); }
    if (step.k === 'basics' && !step.done(s)) setTimeout(() => { if (cur() === step) next(''); }, 1800);
  }
  W.__jvPermSetup = () => { if (ov && ov.classList.contains('on') && cur() && cur().k === 'basics') { opened = true; setTimeout(recheck, 300); } };
  function skip() {
    const step = cur(); if (step.optional) { const sk = new Set(config.get('setup_skip', []) || []); sk.add(step.k); config.set('setup_skip', [...sk]); }
    next('');
  }
  function finish() {
    config.set('setup_v1', true); close(true);
    say('All set. Say Hey Jarvis whenever you need me.');
  }
  function close(done) {
    if (!ov) return; ov.classList.remove('on'); W.__jvPaused = false;
    if (!done) config.set('setup_v1', true);           // "later": don't nag on every start; Settings has the button
  }
  function open(force = false) {
    if (!P() || typeof P().status !== 'function') return false;
    const s = status(), skipped = force ? [] : (config.get('setup_skip', []) || []);
    if (force) config.set('setup_skip', []);
    const left = steps().filter(st => !st.done(s) && !skipped.includes(st.k));
    if (!left.length) { config.set('setup_v1', true); return false; }
    build(); i = steps().indexOf(left[0]); tries = 0; failed = 0; opened = false;
    ov.classList.add('on'); W.__jvPaused = true; paint(); focusGo();
    return true;
  }
  /** First start: open by itself once. */
  function maybeAutoOpen() { if (!config.get('setup_v1', false)) return open(false); return false; }
  return { open, maybeAutoOpen, close, get isOpen() { return !!(ov && ov.classList.contains('on')); }, pending: () => pending(status()) };
}
