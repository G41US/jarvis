// ui.js - the phone layout around the hologram face: a status line, big captions of the latest exchange,
// and one dock (mute, the mic orb, history). The PC page's own controls stay underneath and keep working;
// this layer reads them and drives them, so behaviour is identical to the browser version.
const J = () => window.JARVIS;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const CSS = `
@font-face { font-family: 'Saira'; src: url('fonts/Saira.ttf') format('truetype'); font-weight: 100 900; font-stretch: 50% 125%; font-display: swap; }
:root { --void: #03070d; --holo: #7fd6ff; --ice: #e8f4ff; --live: #5ef0a0; --amber: #ffb547; --steel: #6f8aa3; --danger: #ff7a7a;
  --state: var(--holo); --safe-t: env(safe-area-inset-top, 0px); --safe-b: env(safe-area-inset-bottom, 0px); }
body { background: var(--void); }
/* the PC HUD bits this layer replaces */
#state, #controls, #mic-level, #partial-text, #debug, #diag, #voice-panel, #cam-indicator, #activate, #log { visibility: hidden; }
body.jv-history #log { visibility: visible; }

#jv-top { position: fixed; z-index: 9; top: calc(var(--safe-t) + 12px); left: 14px; right: 14px; display: flex; align-items: center; gap: 10px; pointer-events: none; }
#jv-status { pointer-events: auto; display: inline-flex; align-items: center; gap: 9px; padding: 8px 14px 8px 12px; border-radius: 999px;
  background: rgba(6, 16, 28, .72); border: 1px solid color-mix(in srgb, var(--state) 45%, transparent); backdrop-filter: blur(8px);
  font: 500 15px/1 'Saira', system-ui, sans-serif; font-stretch: 92%; color: var(--ice); transition: border-color .3s; }
#jv-status i { width: 9px; height: 9px; border-radius: 50%; background: var(--state); box-shadow: 0 0 10px var(--state); transition: background .3s; }
#jv-top .jv-sp { flex: 1; }
.jv-ic, #jv-orb { text-transform: none; letter-spacing: normal; text-shadow: none; }
.jv-ic { pointer-events: auto; width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; border: 1px solid rgba(127, 214, 255, .28);
  background: rgba(6, 16, 28, .72); color: var(--holo); -webkit-tap-highlight-color: transparent; }
.jv-ic svg { width: 21px; height: 21px; }
.jv-ic:active { transform: scale(.94); }
.jv-ic.on { border-color: var(--danger); color: var(--danger); }

#jv-cap { position: fixed; z-index: 8; left: 18px; right: 18px; bottom: calc(var(--safe-b) + 128px); pointer-events: none; text-align: left; }
#jv-cap .you { font: 400 15px/1.35 Roboto, system-ui, sans-serif; color: var(--steel); margin-bottom: 6px; max-height: 2.7em; overflow: hidden; }
#jv-cap .you::before { content: '“'; } #jv-cap .you::after { content: '”'; } #jv-cap .you:empty::before, #jv-cap .you:empty::after { content: none; }
#jv-cap .him { font: 500 22px/1.3 'Saira', Roboto, system-ui, sans-serif; font-stretch: 96%; color: var(--ice); text-wrap: pretty;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 2px 18px rgba(0,0,0,.8); }
#jv-cap .heard { font: italic 400 16px/1.3 Roboto, system-ui, sans-serif; color: var(--live); min-height: 1.3em; opacity: 0; transition: opacity .2s; }
#jv-cap .heard.on { opacity: .9; }
#jv-cap .note { font: 400 14px/1.35 Roboto, system-ui, sans-serif; color: var(--amber); margin-top: 6px; }

#jv-dock { position: fixed; z-index: 9; left: 0; right: 0; bottom: calc(var(--safe-b) + 22px); display: flex; justify-content: center; align-items: center; gap: 34px; }
#jv-orb { position: relative; width: 78px; height: 78px; border-radius: 50%; border: 0; padding: 0; background: radial-gradient(circle at 50% 42%, rgba(127,214,255,.22), rgba(6,16,28,.9) 70%);
  box-shadow: 0 0 0 1.5px var(--state), 0 0 calc(10px + var(--lvl, 0) * 40px) color-mix(in srgb, var(--state) 70%, transparent); transition: box-shadow .12s linear; -webkit-tap-highlight-color: transparent; }
#jv-orb::after { content: ''; position: absolute; inset: calc(-6px - var(--lvl, 0) * 10px); border-radius: 50%; border: 1px solid color-mix(in srgb, var(--state) 40%, transparent); transition: inset .12s linear; }
#jv-orb svg { width: 30px; height: 30px; color: var(--state); }
#jv-orb:active { transform: scale(.95); }
body.st-speaking #jv-orb { animation: jvPulse 1.2s ease-in-out infinite; }
@keyframes jvPulse { 50% { box-shadow: 0 0 0 1.5px var(--state), 0 0 36px var(--state); } }
@media (prefers-reduced-motion: reduce) { body.st-speaking #jv-orb { animation: none; } }

body.st-session, body.st-listening { --state: var(--live); }
body.st-thinking { --state: var(--amber); }
body.st-speaking { --state: var(--holo); }
body.st-muted { --state: var(--danger); }

/* conversation history (the PC log), as a sheet */
body.jv-history #log { position: fixed !important; z-index: 10; left: 0 !important; right: 0 !important; top: auto !important; bottom: 0 !important; width: auto !important;
  max-height: 62vh !important; padding: 18px 18px calc(var(--safe-b) + 112px); background: rgba(4, 10, 18, .96); border-top: 1px solid rgba(127,214,255,.25);
  border-radius: 20px 20px 0 0; -webkit-mask-image: none; mask-image: none; font: 15px/1.5 Roboto, system-ui, sans-serif; }
body.jv-history #log .who { font: 600 12px/1 'Saira', sans-serif; letter-spacing: .5px; text-transform: none; }
body.jv-history #jv-cap { visibility: hidden; }

/* delivery route card */
#route-panel { font-family: Roboto, system-ui, sans-serif; }
@media (max-width: 820px), (orientation: portrait) {
  #route-panel { top: calc(var(--safe-t) + 66px) !important; left: 12px !important; right: 12px !important; width: auto !important; max-height: 30vh;
    padding: 12px 14px; border-radius: 16px; background: rgba(6, 16, 28, .82); border: 1px solid rgba(255,181,71,.3); backdrop-filter: blur(8px); }
  #route-panel.jv-folded { max-height: 46px; overflow: hidden; }
  #route-head { font: 500 13px/1.45 'Saira', sans-serif !important; letter-spacing: .3px !important; text-transform: none !important; }
  #route-head .money { color: var(--amber) !important; }
  #route-head .est { color: #c9b48f !important; }
  .rs .k { text-transform: none !important; min-width: 54px !important; }
  .rs .k { font-size: 10px !important; letter-spacing: 1px !important; }
}

/* while the map is up the map owns the screen; Jarvis shrinks to the dock on the right */
body[data-nav="full"] #jv-cap { visibility: hidden; }
body[data-nav="full"] #jv-dock { left: auto; right: 12px; bottom: calc(var(--safe-b) + 110px); flex-direction: column; gap: 14px; }
body[data-nav="full"] #jv-orb { width: 60px; height: 60px; }
body[data-nav="full"] #jv-hist { display: none; }
@media (max-width: 820px), (orientation: portrait) {
  body[data-nav="mini"] #nav-frame { top: calc(var(--safe-t) + 66px) !important; left: 12px !important; right: 12px !important; width: auto !important; height: 34vh !important; }
  body[data-nav="mini"] #route-panel { top: calc(var(--safe-t) + 66px + 34vh + 10px) !important; }
  .nb { left: 12px !important; right: 12px; top: calc(var(--safe-t) + 64px) !important; min-width: 0 !important; max-width: none !important; }
  .ne { bottom: calc(var(--safe-b) + 18px) !important; }
  .ne-c { padding: 8px 14px !important; min-width: 74px !important; }
}
`;

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.6 5M18.4 12.6c.06-.5.1-1 .1-1.6M12 17.5V21M3 3l18 18"/></svg>',
  hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const STATUS = { idle: 'Starting…', standby: 'Say “Hey Jarvis”', session: 'Listening', listening: 'Listening', thinking: 'Thinking…', speaking: 'Speaking', muted: 'Muted' };

export function initUi() {
  if ($('jv-dock')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);

  const top = el('div'); top.id = 'jv-top';
  const status = el('div'); status.id = 'jv-status'; status.append(el('i'), el('span', '', STATUS.idle));
  const gear = el('button', 'jv-ic'); gear.id = 'jv-gear'; gear.setAttribute('aria-label', 'Settings'); gear.innerHTML = ICON.gear;
  gear.onclick = () => J() && J().openSettings && J().openSettings();
  top.append(status, el('span', 'jv-sp'), gear);

  const cap = el('div'); cap.id = 'jv-cap';
  const you = el('div', 'you'), him = el('div', 'him'), heard = el('div', 'heard'), note = el('div', 'note');
  cap.append(heard, you, him, note);

  const dock = el('div'); dock.id = 'jv-dock';
  const mute = el('button', 'jv-ic'); mute.id = 'jv-mute'; mute.setAttribute('aria-label', 'Mute microphone'); mute.innerHTML = ICON.mute;
  const orb = el('button'); orb.id = 'jv-orb'; orb.setAttribute('aria-label', 'Talk to Jarvis'); orb.innerHTML = ICON.mic;
  const hist = el('button', 'jv-ic'); hist.id = 'jv-hist'; hist.setAttribute('aria-label', 'Conversation history'); hist.innerHTML = ICON.hist;
  dock.append(mute, orb, hist);
  document.body.append(top, cap, dock);

  mute.onclick = () => { const b = $('muteBtn'); if (b) b.click(); };
  orb.onclick = () => { if (document.body.classList.contains('st-muted')) { const b = $('muteBtn'); if (b) b.click(); return; } J() && J().wake(); };
  hist.onclick = () => { document.body.classList.toggle('jv-history'); const l = $('log'); if (l) l.scrollTop = l.scrollHeight; };
  const rp = $('route-panel'); if (rp) rp.addEventListener('click', () => rp.classList.toggle('jv-folded'));

  // status: mirror the page's own state element
  const stateEl = $('state'); let last = '';
  const syncState = () => {
    const cls = (stateEl && stateEl.className) || 'idle'; if (cls === last) return; last = cls;
    document.body.className = document.body.className.replace(/\bst-\S+/g, '').trim() + ' st-' + cls;
    status.lastChild.textContent = STATUS[cls] || STATUS.standby;
    const muted = cls === 'muted'; mute.classList.toggle('on', muted); mute.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  };
  if (stateEl) new MutationObserver(syncState).observe(stateEl, { attributes: true, childList: true, characterData: true, subtree: true });
  syncState();

  // captions: the latest thing you said and the latest thing Jarvis said, from the page's log
  const logEl = $('log');
  const syncCaps = () => {
    if (!logEl) return;
    const msgs = [...logEl.querySelectorAll('.msg')];
    const lastOf = k => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].classList.contains(k)) return msgs[i]; return null; };
    const u = lastOf('user'), j = lastOf('jarvis'), p = lastOf('proactive');
    const order = m => (m ? msgs.indexOf(m) : -1);
    const body = m => (m.querySelector('.body') || m).textContent;
    you.textContent = u ? body(u) : '';
    him.textContent = j && order(j) > order(u) ? body(j) : '';                 // empty while Jarvis is working on your question
    note.textContent = p && order(p) > Math.max(order(u), order(j)) ? p.textContent : '';
  };
  if (logEl) new MutationObserver(syncCaps).observe(logEl, { childList: true, subtree: true, characterData: true });

  // live "heard" line from the page's partial transcript
  const partial = $('partial-text');
  if (partial) new MutationObserver(() => { heard.textContent = partial.textContent; heard.classList.toggle('on', partial.classList.contains('active') && !!partial.textContent && partial.textContent !== you.textContent); })
    .observe(partial, { attributes: true, childList: true, characterData: true, subtree: true });

  // mic level drives the orb's glow
  let lvl = 0;
  setInterval(() => {
    const s = J() && J().stats; const target = s ? Math.min(1, Math.sqrt(s.rms || 0) / 45) : 0;
    lvl += (target - lvl) * 0.5; orb.style.setProperty('--lvl', lvl.toFixed(3));
  }, 90);
}
