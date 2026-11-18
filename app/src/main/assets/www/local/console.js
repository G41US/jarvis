// console.js - the answer console on the phone, like the PC's: a live transcript under the face, no box, no lines.
// Your words drop in letter by letter as you say them; while he works it out it says ANALYZING and a line of dots scans;
// his words drop in as he says them (timed to his voice, page 'jv-say' events), the word landing flashes and settles,
// times and numbers glow gold; older lines dim and slide up and out the top. Nothing is cut short.
// It lives inside the answer card (#jv-card), so the face still lifts to make room and it shows and hides with the card.
// The delivery screen ("dash") keeps its own card.

const CSS = `
@font-face { font-family: 'JetBrains Mono'; src: url('fonts/JetBrainsMono.woff2') format('woff2'); font-weight: 100 800; font-display: swap; }
#jv-con { display: none; text-align: left; padding: 4px 2px 2px; }
body:not([data-nav="dash"]) #jv-con { display: block; }
body:not([data-nav="dash"]) #jv-card #jv-cap, body:not([data-nav="dash"]) #jv-card > .x { display: none !important; }
#jv-con .hd { display: flex; align-items: center; gap: 9px; height: 15px; font: 500 10px/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .2em; color: #f5c97a; }
#jv-con .hd .dot { width: 6px; height: 6px; border-radius: 50%; background: #f5c97a; box-shadow: 0 0 0 3px rgba(245, 201, 122, .15), 0 0 10px #f5c97a; }
#jv-con .hd .wv { display: inline-flex; align-items: center; gap: 2px; height: 13px; margin-left: 2px; }
#jv-con .hd .wv i { display: block; width: 2px; height: 100%; background: #f5c97a; border-radius: 1px; transform: scaleY(.2); transition: transform .08s linear; }
#jv-con .hd time { margin-left: auto; color: rgba(245, 201, 122, .5); letter-spacing: .1em; font-variant-numeric: tabular-nums; }
#jv-con .view { display: flex; flex-direction: column; justify-content: flex-end; max-height: 26vh; overflow: hidden; margin-top: 10px; }
#jv-con .view.more { -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 36px); mask-image: linear-gradient(to bottom, transparent 0, #000 36px); }
#jv-con .row { display: grid; grid-template-columns: 40px 1fr; gap: 8px; margin-bottom: 9px; flex: none; transition: opacity 1.2s ease; }
#jv-con .row.old { opacity: .3; }
#jv-con .tag { font: 500 9px/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .14em; padding-top: 4px; }
#jv-con .u .tag span { color: #bfae8f; }
#jv-con .j .tag span { color: #f5c97a; text-shadow: 0 0 8px rgba(245, 201, 122, .5); }
#jv-con .u .m { font: 400 13px/1.45 'JetBrains Mono', ui-monospace, monospace; color: #c9b99c; text-shadow: 0 1px 6px #000; }
#jv-con .j .m { font: 400 17px/1.45 'Saira', system-ui, sans-serif; color: #fff3da; text-shadow: 0 1px 3px #000, 0 0 16px #000; }
#jv-con .w { display: inline-block; white-space: nowrap; }
#jv-con .w.k { color: #ffd88f; font-weight: 500; text-shadow: 0 0 12px rgba(245, 201, 122, .55), 0 1px 3px #000; }
#jv-con .c { display: inline-block; animation: jvDrop .5s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes jvDrop { 0% { opacity: 0; transform: translateY(-.8em) scale(1.35); filter: blur(3px) brightness(2); }
  40% { opacity: 1; transform: none; filter: blur(0) brightness(1.9); text-shadow: 0 0 14px rgba(255, 214, 140, .95); }
  100% { opacity: 1; transform: none; filter: none; } }
#jv-con .scan { display: flex; gap: 5px; align-items: center; height: 24px; }
#jv-con .scan i { width: 4px; height: 4px; border-radius: 50%; background: #f5c97a; opacity: .15; animation: jvScan 1.6s linear infinite; }
@keyframes jvScan { 0%, 30%, 100% { opacity: .15; transform: none; box-shadow: none; } 10% { opacity: 1; transform: scale(1.6); box-shadow: 0 0 8px #f5c97a; } }
#jv-con .ft { display: flex; align-items: center; gap: 8px; padding-top: 4px; font: 400 9px/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .12em; color: rgba(245, 201, 122, .45); opacity: 0; transition: opacity .4s; }
#jv-con .ft.on { opacity: 1; }
#jv-con .ft .bar { flex: 1; height: 2px; background: rgba(245, 201, 122, .14); position: relative; }
#jv-con .ft .bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: #f5c97a; box-shadow: 0 0 6px #f5c97a; transition: width .3s linear; }
@media (prefers-reduced-motion: reduce) { #jv-con .c { animation-duration: .01s; } #jv-con .scan i { animation: none; opacity: .6; } }
`;

const KEY = /\d|°|%|\$|£|€|₦|^(today|tonight|tomorrow|yesterday|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|rain|sunny|snow|storm|am|pm)\W*$/i;
const STAGGER = 22, MAX_ROWS = 5;
const unstage = t => (window.__jvUnstage ? window.__jvUnstage(t) : String(t || '')).trim();
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const keyOf = t => String(t || '').toLowerCase().replace(/\b(sir|ma'?am)\b/g, '').replace(/[^a-z0-9]+/g, '');
const hms = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const wordHtml = (w, at) => `<span class="w${KEY.test(w) ? ' k' : ''}">` + [...w].map((ch, j) => `<span class="c" style="animation-delay:${Math.round(at + j * STAGGER)}ms">${esc(ch)}</span>`).join('') + '</span>';

function start(card) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const con = document.createElement('div'); con.id = 'jv-con';
  con.innerHTML = '<div class="hd"><i class="dot"></i><span class="lab">JARVIS</span><span class="wv">' + '<i></i>'.repeat(9) + '</span><time></time></div>'
    + '<div class="view"></div><div class="ft"><span class="pc"></span><span class="bar"><i></i></span><span class="sec"></span></div>';
  card.insertBefore(con, card.firstChild);
  const view = con.querySelector('.view'), lab = con.querySelector('.lab'), stamp = con.querySelector('time'), bars = [...con.querySelectorAll('.wv i')];
  const ft = con.querySelector('.ft'), ftPc = ft.querySelector('.pc'), ftBar = ft.querySelector('.bar i'), ftSec = ft.querySelector('.sec');
  const recent = new Map();
  let youRow = null, himRow = null, said = 0, total = 0, sents = 0, sentsDone = 0, waiting = [], lastQueued = 0;
  const stateEl = document.getElementById('state');     // the page's state, as the rest of the phone UI reads it (ui.js)
  const state = () => { let s = {}; try { s = window.__jv.state(); } catch {} const c = stateEl && stateEl.classList[0]; if (c) s = { ...s, appState: c }; return s; };
  const fit = () => view.classList.toggle('more', view.scrollHeight > view.clientHeight + 2);
  const newRow = who => {
    [...view.children].forEach(r => r.classList.add('old'));
    const r = document.createElement('div'); r.className = 'row ' + (who === 'you' ? 'u' : 'j');
    r.innerHTML = `<div class="tag"><span>${who === 'you' ? 'YOU' : 'JRV'}</span><em></em></div><div class="m"></div>`;
    view.appendChild(r); while (view.children.length > MAX_ROWS) view.firstChild.remove();
    return r;
  };
  const paintFoot = () => {
    const pc = total ? Math.min(100, Math.round(said / total * 100)) : 0;
    ftPc.textContent = pc + '%'; ftBar.style.width = pc + '%';
    ftSec.textContent = 'SEC ' + String(Math.min(sents, sentsDone + 1)).padStart(2, '0') + '/' + String(sents).padStart(2, '0');
  };
  function showYou(text) {
    text = String(text || '').trim(); if (!text) return;
    if (!youRow || himRow) { youRow = newRow('you'); himRow = null; said = total = sents = sentsDone = 0; ft.classList.remove('on'); }
    const m = youRow.querySelector('.m'), old = (m.dataset.t || '').split(/\s+/).filter(Boolean), now = text.split(/\s+/).filter(Boolean);
    let same = 0; while (same < old.length && same < now.length && old[same] === now[same]) same++;
    if (same < old.length) m.innerHTML = now.slice(0, same).map(w => `<span class="w">${esc(w)}</span>`).join(' ');
    m.insertAdjacentHTML('beforeend', now.slice(same).map((w, i) => (m.textContent || i ? ' ' : '') + wordHtml(w, i * 90)).join(''));
    m.dataset.t = text; fit();
  }
  function thinking() {
    if (himRow) return;
    himRow = newRow('him'); if (youRow) youRow.classList.remove('old');
    himRow.querySelector('.m').innerHTML = '<div class="scan">' + Array.from({ length: 18 }, (_, i) => `<i style="animation-delay:${i * 60}ms"></i>`).join('') + '</div>';
    fit();
  }
  function sayLine(text, dur) {
    text = unstage(text); if (!text) return;
    const k = keyOf(text), w = waiting.findIndex(x => keyOf(x) === k); if (w >= 0) waiting.splice(w, 1);
    const now = performance.now(); for (const [rk, at] of recent) if (now - at > 30000) recent.delete(rk);
    if ([...recent.keys()].join('').includes(k)) return;          // never the same line twice
    recent.set(k, now);
    if (!himRow) { himRow = newRow('him'); if (youRow) youRow.classList.remove('old'); }
    const m = himRow.querySelector('.m');
    m.dataset.keys = (m.dataset.keys || '') + '|' + k;
    if (m.querySelector('.scan')) m.innerHTML = '';
    const words = text.split(/\s+/).filter(Boolean), ms = (isFinite(dur) && dur > 0 ? dur : Math.min(6, text.length * 0.02)) * 1000 * 0.7;
    const per = Math.max(35, Math.min(380, ms / Math.max(1, words.length)));
    m.insertAdjacentHTML('beforeend', (m.textContent ? ' ' : '') + words.map((x, i) => wordHtml(x, i * per)).join(' '));
    total += words.length; sents++;
    words.forEach((_, i) => setTimeout(() => { said++; if (i === words.length - 1) sentsDone++; paintFoot(); }, i * per));
    ft.classList.add('on'); paintFoot();
    requestAnimationFrame(fit); setTimeout(fit, ms + 600);
  }
  window.addEventListener('jv-say', e => sayLine(e.detail.text, e.detail.dur));
  // what you say, live (the page's partial transcript) and as it's sent
  const partial = document.getElementById('partial-text');
  if (partial) new MutationObserver(() => { if (partial.classList.contains('active') && partial.textContent) showYou(partial.textContent); })
    .observe(partial, { attributes: true, childList: true, characterData: true, subtree: true });
  const log = document.getElementById('log');
  if (log) new MutationObserver(muts => {
    for (const mu of muts) for (const n of mu.addedNodes) {
      if (!n.classList || !n.classList.contains('msg')) continue;
      const body = (n.querySelector('.body') || n).textContent;
      if (n.classList.contains('user')) showYou(body);
      else if (n.classList.contains('proactive')) { youRow = null; himRow = null; waiting.push(body); lastQueued = performance.now(); }
      else if (n.classList.contains('jarvis')) { waiting.push(body); lastQueued = performance.now(); }
    }
  }).observe(log, { childList: true, subtree: true });
  setInterval(() => {      // anything that never got a voice (muted, the voice failed): shown once he's quiet
    const s = state(), busy = s.speaking || s.appState === 'thinking' || s.appState === 'speaking';
    if (waiting.length && !busy && performance.now() - lastQueued > 1800) {
      const seen = [...recent.keys()].join('');                 // already on screen as he said it (sentence by sentence)
      const all = waiting.splice(0); for (const t of all) for (const part of (t.match(/[^.!?]+[.!?]*/g) || [t])) if (!seen.includes(keyOf(part))) sayLine(part.trim(), 0);
    }
    stamp.textContent = hms();
  }, 400);
  let lastState = '';
  (function tick() {
    const s = state(), app = s.appState || '';
    if (app !== lastState) { if (app === 'thinking') thinking(); lastState = app; }
    lab.textContent = app === 'thinking' ? 'ANALYZING' : (app === 'session' || app === 'listening') && !himRow ? 'LISTENING' : 'JARVIS';
    let lvl = 0; if (app === 'speaking' && window.__jvMouthLevel) lvl = Math.max(0, window.__jvMouthLevel());
    const t = performance.now() / 120;
    bars.forEach((b, i) => { const v = lvl > 0.02 ? Math.min(1, 0.25 + lvl * 1.8 * (0.6 + 0.4 * Math.sin(t + i * 1.7))) : 0.2; b.style.transform = `scaleY(${v.toFixed(2)})`; });
    requestAnimationFrame(tick);
  })();
}

(function wait() { const card = document.getElementById('jv-card'); if (card) start(card); else setTimeout(wait, 300); })();
