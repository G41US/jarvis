// pages.js - two full screens: Earnings (what you made, per hour and per mile, the last 7 days, your best hours and areas)
// and "What I know about you" (everything Jarvis has learned or saved, each with a delete button).
// Both slide over the face like settings do, and stop the 3D face while they're open.
const J = () => window.JARVIS;
const P = () => window.AndroidPhone || null;
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (v !== false && v != null) e.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
const SVG = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ic = (html, cls = '') => { const s = el('span', { class: 'ico ' + cls, 'aria-hidden': 'true' }); s.innerHTML = html; return s; };

const CSS = `
body.jv-pane #three, body.jv-pane #jv-aura, body.jv-pane #jv-top, body.jv-pane #jv-card, body.jv-pane #jv-dock, body.jv-pane #jv-hello, body.jv-pane #jv-toast,
body.jv-pane #jv-ideas, body.jv-pane #jv-hint, body.jv-pane #jv-drive, body.jv-pane #nav-frame, body.jv-pane #nav-orb, body.jv-pane #route-panel, body.jv-pane #log, body.jv-pane #jv-hist-head { visibility: hidden !important; }
#jv-pane { position: fixed; inset: 0; z-index: 70; overflow-y: auto; overscroll-behavior: contain; display: none; color: #eaf6ff;
  background: radial-gradient(90% 40% at 50% 0%, #0d2136 0%, #050b14 60%, #03070c 100%) fixed; font: 15px/1.45 Roboto, system-ui, sans-serif; }
#jv-pane.on { display: block; animation: jvPaneIn .3s cubic-bezier(.2, .8, .2, 1); }
@keyframes jvPaneIn { from { opacity: 0; transform: translateY(14px); } }
#jv-pane .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; padding: calc(env(safe-area-inset-top, 0px) + 10px) 10px 10px;
  background: rgba(4, 10, 18, .84); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); border-bottom: 1px solid rgba(160, 215, 255, .08); }
#jv-pane .bar .t { flex: 1; font: 600 19px/1.2 'Saira', system-ui, sans-serif; font-stretch: 96%; padding-left: 4px; }
#jv-pane button { font-family: Roboto, system-ui, sans-serif; text-transform: none; letter-spacing: normal; text-shadow: none; -webkit-tap-highlight-color: transparent; }
#jv-pane .bar .back { width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #9db3c6; display: grid; place-items: center; }
#jv-pane .bar .back svg { width: 22px; height: 22px; }
#jv-pane .box { max-width: 560px; margin: 0 auto; padding: 14px 16px calc(env(safe-area-inset-bottom, 0px) + 40px); }
#jv-pane h3 { margin: 26px 4px 10px; font: 500 13px/1 Roboto, sans-serif; color: #8aa1b5; }
#jv-pane .seg { display: flex; padding: 4px; gap: 4px; border-radius: 16px; background: rgba(10, 22, 38, .9); border: 1px solid rgba(160, 215, 255, .12); }
#jv-pane .seg button { flex: 1; border: 0; border-radius: 12px; background: transparent; color: #9db3c6; padding: 11px; font-size: 15px; font-weight: 500; }
#jv-pane .seg button[aria-pressed=true] { background: #16324c; color: #eaf6ff; box-shadow: 0 0 0 1px rgba(127, 216, 255, .35); }
#jv-pane .hero { margin: 22px 4px 4px; font: 600 54px/1 'Saira', system-ui, sans-serif; font-stretch: 100%; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
#jv-pane .hero-sub { margin: 6px 4px 0; color: #9db3c6; font-size: 15px; }
#jv-pane .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 18px; }
#jv-pane .tile { padding: 14px 12px; border-radius: 18px; background: rgba(14, 28, 44, .62); border: 1px solid rgba(160, 215, 255, .08); }
#jv-pane .tile b { display: block; font: 600 22px/1.1 'Saira', sans-serif; font-stretch: 92%; font-variant-numeric: tabular-nums; }
#jv-pane .tile span { display: block; margin-top: 4px; font-size: 12px; color: #8aa1b5; }
#jv-pane .tile.na b { color: #61798d; }
#jv-pane .card { border-radius: 20px; background: rgba(14, 28, 44, .62); border: 1px solid rgba(160, 215, 255, .08); overflow: hidden; }
/* last 7 days: one series, bars from a shared baseline, rounded tops, labels only on today and the best day */
#jv-pane .chart { padding: 14px 14px 10px; }
#jv-pane .chart .cap { min-height: 20px; font-size: 14px; color: #c3d7e8; margin: 0 2px 10px; font-variant-numeric: tabular-nums; }
#jv-pane .bars { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; height: 140px; align-items: end; border-bottom: 1px solid rgba(160, 215, 255, .16); }
#jv-pane .bars button { position: relative; height: 100%; border: 0; padding: 0 3px; background: transparent; display: flex; align-items: flex-end; justify-content: center; }
#jv-pane .bars i { display: block; width: 100%; max-width: 30px; min-height: 2px; border-radius: 4px 4px 0 0; background: #ffb24c; }
#jv-pane .bars button.zero i { background: rgba(160, 215, 255, .14); }
#jv-pane .bars button.sel i { box-shadow: 0 0 0 2px #03070c, 0 0 0 3px #eaf6ff; }
#jv-pane .bars small { position: absolute; left: 0; right: 0; text-align: center; font-size: 11px; color: #c3d7e8; font-variant-numeric: tabular-nums; }
#jv-pane .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-top: 6px; }
#jv-pane .days span { text-align: center; font-size: 12px; color: #8aa1b5; }
#jv-pane .days span.today { color: #eaf6ff; font-weight: 600; }
#jv-pane .row { display: flex; align-items: center; gap: 12px; padding: 13px 14px; }
#jv-pane .row + .row { border-top: 1px solid rgba(160, 215, 255, .07); }
#jv-pane .row .tx { flex: 1; min-width: 0; }
#jv-pane .row .tx b { display: block; font-weight: 500; font-size: 15px; overflow-wrap: anywhere; }
#jv-pane .row .tx span { display: block; font-size: 13px; color: #8aa1b5; margin-top: 1px; }
#jv-pane .row .val { font: 600 17px/1 'Saira', sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
#jv-pane .row .rank { width: 26px; height: 26px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 13px; font-weight: 600; color: #03121f; background: #7fd8ff; }
#jv-pane .row .ico { width: 34px; height: 34px; border-radius: 11px; flex: none; display: grid; place-items: center; background: rgba(127, 216, 255, .12); color: #7fd8ff; }
#jv-pane .row .ico svg { width: 19px; height: 19px; }
#jv-pane .row .del { width: 40px; height: 40px; flex: none; border: 0; border-radius: 50%; padding: 0; background: transparent; color: #61798d; display: grid; place-items: center; }
#jv-pane .row .del svg { width: 18px; height: 18px; }
#jv-pane .row .del:active { color: #ff7a85; background: rgba(255, 90, 103, .1); }
#jv-pane .empty { padding: 18px 16px; color: #8aa1b5; font-size: 14px; }
#jv-pane .note { margin: 14px 4px 0; font-size: 13px; color: #7f97ab; }
#jv-pane .lead { margin: 4px 4px 6px; color: #9db3c6; font-size: 14px; }
#jv-pane .sw { display: flex; align-items: center; gap: 12px; padding: 14px; }
#jv-pane .sw .tx { flex: 1; }
#jv-pane .toggle { width: 52px; height: 32px; border-radius: 16px; border: 0; padding: 0; position: relative; background: #1d3249; flex: none; transition: background .2s; }
#jv-pane .toggle::after { content: ''; position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; border-radius: 50%; background: #9db3c6; transition: transform .2s, background .2s; }
#jv-pane .toggle[aria-checked=true] { background: #2c6c8c; } #jv-pane .toggle[aria-checked=true]::after { transform: translateX(20px); background: #eaf6ff; }
#jv-pane .danger { width: 100%; margin-top: 18px; padding: 14px; border-radius: 16px; border: 1px solid rgba(255, 90, 103, .35); background: rgba(255, 90, 103, .08); color: #ff9aa2; font-size: 15px; font-weight: 500; }
#jv-pane button:focus-visible { outline: 2px solid #7fd8ff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { #jv-pane.on { animation: none; } }
`;

const ICON = {
  back: SVG('<path d="M15 5l-7 7 7 7"/>'),
  x: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
  fact: SVG('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  pref: SVG('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  note: SVG('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  place: SVG('<path d="M12 21s-6-5.3-6-10.5a6 6 0 0 1 12 0C18 15.7 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>'),
  face: SVG('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="9.5" cy="10.5" r=".8"/><circle cx="14.5" cy="10.5" r=".8"/><path d="M9.5 15c1.5 1.2 3.5 1.2 5 0"/>'),
  sos: SVG('<path d="M12 3l7 3v5c0 5-3.2 8.3-7 10-3.8-1.7-7-5-7-10V6z"/>'),
  car: SVG('<path d="M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16M4 16h16v3H4zM7 19v1.5M17 19v1.5"/>'),
  talk: SVG('<path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z"/>'),
};

export function initPages() {
  if (document.getElementById('jv-pane')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const pane = el('div', { id: 'jv-pane', role: 'dialog', 'aria-modal': 'true' });
  const title = el('span', { class: 't' });
  const back = el('button', { type: 'button', class: 'back', 'aria-label': 'Close' }); back.innerHTML = ICON.back;
  const box = el('div', { class: 'box' });
  pane.append(el('div', { class: 'bar' }, back, title), box);
  document.body.append(pane);
  let current = '', ticker = 0;
  const close = () => { pane.classList.remove('on'); document.body.classList.remove('jv-pane'); current = ''; clearInterval(ticker); if (!document.body.classList.contains('jv-settings')) window.__jvPaused = false; };
  back.onclick = close;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && current) close(); });
  const show = (name, t) => { current = name; title.textContent = t; pane.classList.add('on'); document.body.classList.add('jv-pane'); window.__jvPaused = true; pane.scrollTop = 0; };

  const cur = () => (J().config.get('currency', '$') || '$');
  const money = (n, d = 2) => `${cur()}${Number(n || 0).toFixed(d)}`;
  const hm = h => { const m = Math.round(h * 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const unit = () => (J().delivery && J().delivery.units === 'km' ? 'km' : 'mi');
  const dist = mi => (unit() === 'km' ? mi * 1.609344 : mi);

  // ================================================================== Earnings
  let period = 'week';
  function paintEarnings() {
    const s = J().earningsNow ? J().earningsNow() : null; box.replaceChildren();
    if (!s) { box.append(el('p', { class: 'empty' }, 'Earnings work on the phone.')); return; }
    const p = period === 'today' ? s.today : s.week;
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Period' });
    for (const [k, t] of [['today', 'Today'], ['week', 'This week']]) seg.append(el('button', { type: 'button', 'aria-pressed': String(period === k), onclick: () => { period = k; paintEarnings(); } }, t));
    box.append(seg);
    box.append(el('div', { class: 'hero' }, money(p.earned)));
    const vsLast = period === 'week' && s.lastWeek.earned > 0 ? ` · last week ${money(s.lastWeek.earned, 0)}` : '';
    box.append(el('div', { class: 'hero-sub' }, `${p.orders} order${p.orders !== 1 ? 's' : ''}${p.hours ? ' · ' + hm(p.hours) : ''}${vsLast}`));
    const tile = (v, label, ok) => el('div', { class: 'tile' + (ok ? '' : ' na') }, el('b', {}, ok ? v : '—'), el('span', {}, label));
    box.append(el('div', { class: 'tiles' },
      tile(money(p.perHour, 0), 'per hour', p.perHour > 0),
      tile(dist(p.miles).toFixed(1), unit() === 'km' ? 'kilometres' : 'miles', p.miles > 0.05),
      tile(money(unit() === 'km' ? p.perMile / 1.609344 : p.perMile), unit() === 'km' ? 'per km' : 'per mile', p.perMile > 0)));

    // last 7 days
    box.append(el('h3', {}, 'Last 7 days'));
    const max = Math.max(1, ...s.days.map(d => d.earned)), best = s.days.reduce((b, d) => (d.earned > b.earned ? d : b), s.days[0]);
    const cap = el('div', { class: 'cap', 'aria-live': 'polite' });
    const capFor = d => `${d.today ? 'Today' : new Date(d.from).toLocaleDateString('en-US', { weekday: 'long' })}: ${money(d.earned)}, ${d.orders} order${d.orders !== 1 ? 's' : ''}`;
    cap.textContent = s.days.some(d => d.earned) ? capFor(s.days[6]) : 'No deliveries in the last 7 days.';
    const bars = el('div', { class: 'bars' }), days = el('div', { class: 'days', 'aria-hidden': 'true' });
    s.days.forEach(d => {
      const h = Math.round((d.earned / max) * 78), b = el('button', { type: 'button', class: d.earned ? '' : 'zero', 'aria-label': capFor(d) });
      const bar = el('i'); bar.style.height = `${Math.max(d.earned ? 4 : 2, h)}%`; b.append(bar);
      if (d.earned && (d.today || d === best)) { const lab = el('small', {}, money(d.earned, 0)); lab.style.bottom = `calc(${Math.max(4, h)}% + 4px)`; b.append(lab); }
      b.onclick = () => { bars.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); cap.textContent = capFor(d); };
      bars.append(b); days.append(el('span', { class: d.today ? 'today' : '' }, d.today ? 'Today' : d.label));
    });
    box.append(el('div', { class: 'card chart' }, cap, bars, days));

    // best hours and areas
    const list = (rows, empty) => { const c = el('div', { class: 'card' }); if (!rows.length) c.append(el('div', { class: 'empty' }, empty)); else rows.forEach(r => c.append(r)); return c; };
    box.append(el('h3', {}, 'Your best hours'));
    box.append(list(s.hours.map((h, i) => el('div', { class: 'row' }, el('span', { class: 'rank' }, String(i + 1)),
      el('div', { class: 'tx' }, el('b', {}, h.label), el('span', {}, `over ${h.days} days, ${h.orders} order${h.orders !== 1 ? 's' : ''}`)),
      el('span', { class: 'val' }, money(h.avg, 0)))), 'After a few days of deliveries, the hours that pay you best show up here.'));
    box.append(el('h3', {}, 'Best-paying areas'));
    box.append(list(s.areas.map((a, i) => el('div', { class: 'row' }, el('span', { class: 'rank' }, String(i + 1)),
      el('div', { class: 'tx' }, el('b', {}, a.name), el('span', {}, `${a.orders} orders${a.area ? '' : ' (restaurant)'}`)),
      el('span', { class: 'val' }, `${money(a.avg)}`))), 'Once two or more orders go to the same place, the best-paying areas show up here.'));
    const apps = Object.entries(p.byPlatform || {}).sort((a, b) => b[1] - a[1]);
    if (apps.length > 1) {
      box.append(el('h3', {}, period === 'today' ? 'By app, today' : 'By app, this week'));
      box.append(list(apps.map(([k, v]) => el('div', { class: 'row' }, el('div', { class: 'tx' }, el('b', {}, k)), el('span', { class: 'val' }, money(v)))), ''));
    }
    box.append(el('p', { class: 'note' }, p.miles > 0 ? 'Time and miles come from your shifts. Pay comes from the orders you mark delivered.'
      : 'Say "start my shift" when you head out, so time and miles are tracked too. Pay comes from the orders you mark delivered.'));
  }
  J().openEarnings = (focus = 'week') => { period = focus === 'today' ? 'today' : 'week'; show('earnings', 'Earnings'); paintEarnings(); clearInterval(ticker); ticker = setInterval(() => current === 'earnings' && !document.hidden && paintEarnings(), 30000); };

  // ================================================================== What I know about you
  function paintKnows() {
    const { kv, config } = J(); box.replaceChildren();
    box.append(el('p', { class: 'lead' }, 'What I\'ve learned or you\'ve asked me to keep. It stays on this phone; only the facts and preferences go to the AI with your requests, so my answers fit you. Tap × to make me forget something.'));
    const forget = fn => () => { fn(); try { J().refreshMemory(); } catch {} paintKnows(); };
    const del = (label, fn) => { const b = el('button', { type: 'button', class: 'del', 'aria-label': 'Forget ' + label, onclick: forget(fn) }); b.innerHTML = ICON.x; return b; };
    const row = (icon, main, sub, label, fn) => el('div', { class: 'row' }, ic(icon), el('div', { class: 'tx' }, el('b', {}, main), sub ? el('span', {}, sub) : null), fn ? del(label || main, fn) : null);
    const section = (t, rows, empty) => { box.append(el('h3', {}, t)); const c = el('div', { class: 'card' }); if (!rows.length) c.append(el('div', { class: 'empty' }, empty)); else c.append(...rows); box.append(c); };
    const ago = ts => { if (!ts) return ''; const d = Math.round((Date.now() - ts) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

    const name = String(config.get('user_name', '') || '');
    const facts = kv.get('memories', []) || [];
    section('About you', [
      ...(name ? [row(ICON.fact, `Your name is ${name}`, 'Change it in Settings, Brain', 'your name', () => config.set('user_name', ''))] : []),
      ...facts.map((f, i) => row(ICON.fact, f.fact, ago(f.ts || f.at), f.fact, () => { const m = kv.get('memories', []) || []; m.splice(i, 1); kv.set('memories', m); })),
    ], 'Nothing yet. Tell me about yourself, or say "remember that…".');
    const prefs = kv.get('prefs', []) || [];
    section('How you like me to be', prefs.map((p, i) => row(ICON.pref, String(p), '', String(p), () => { const a = kv.get('prefs', []) || []; a.splice(i, 1); kv.set('prefs', a); })),
      'Nothing yet. Say things like "keep answers short" and I\'ll stick to it.');
    const notes = kv.get('notes', []) || [];
    section('Notes', notes.map((n, i) => row(ICON.note, n.text, ago(n.ts), 'this note', () => { const a = kv.get('notes', []) || []; a.splice(i, 1); kv.set('notes', a); })), 'No notes. Say "take a note…".');
    const places = config.get('places', {}) || {};
    section('Saved places', Object.entries(places).map(([k, v]) => row(ICON.place, k[0].toUpperCase() + k.slice(1), (v && (v.label || v.address)) || '', k, () => { const p = config.get('places', {}) || {}; delete p[k]; config.set('places', p); })),
      'None. Say "save this as home".');
    let faces = []; try { faces = (P() && P().faceList && parse(P().faceList())) || []; } catch {}
    section('People I recognise', faces.map(f => row(ICON.face, f.name, f.title || `${f.samples || 1} photo${(f.samples || 1) > 1 ? 's' : ''} of their face (only a face code is kept, not the photo)`, f.name,
      () => { try { P().faceForget(f.name); } catch {} })), 'Nobody yet. Point the camera at someone and say "remember this face as…".');
    const ec = config.get('emergency_contacts', []) || [];
    section('Emergency contacts', ec.map((c, i) => row(ICON.sos, c.name, c.number, c.name, () => { const a = config.get('emergency_contacts', []) || []; a.splice(i, 1); config.set('emergency_contacts', a); })),
      'None. Say "add Ada as my emergency contact".');
    const park = kv.get('parking', null), sum = String(kv.get('summary', '') || '');
    const other = [];
    if (park) other.push(row(ICON.car, 'Where you parked', [park.where, park.note, ago(park.at)].filter(Boolean).join(' · '), 'the parking spot', () => kv.del ? kv.del('parking') : kv.set('parking', null)));
    if (sum) other.push(row(ICON.talk, 'A summary of our earlier conversations', sum.length > 140 ? sum.slice(0, 140) + '…' : sum, 'the conversation summary', () => kv.set('summary', '')));
    if (other.length) section('Other things I keep', other, '');

    box.append(el('h3', {}, 'Learning'));
    const on = config.get('learn', true) !== false;
    const tg = el('button', { type: 'button', class: 'toggle', role: 'switch', 'aria-checked': String(on), 'aria-label': 'Learn from our conversations',
      onclick: () => { config.set('learn', !(config.get('learn', true) !== false)); paintKnows(); } });
    box.append(el('div', { class: 'card' }, el('div', { class: 'sw' }, el('div', { class: 'tx' }, el('b', {}, 'Learn from our conversations'),
      el('span', { style: 'display:block;font-size:13px;color:#8aa1b5;margin-top:2px' }, on ? 'I pick up useful facts as we talk. They appear here.' : 'Off: I only keep what you ask me to remember.')), tg)));
    box.append(el('button', { type: 'button', class: 'danger', onclick: () => {
      if (!window.confirm('Forget everything I know about you? Facts, preferences, notes and our conversation history.')) return;
      ['memories', 'prefs', 'notes', 'history', 'summary'].forEach(k => (kv.del ? kv.del(k) : kv.set(k, null)));
      try { J().brain.clearConversation(); } catch {}
      try { J().refreshMemory(); } catch {}
      paintKnows();
    } }, 'Forget everything'));
  }
  J().openKnows = () => { show('knows', 'What I know about you'); paintKnows(); };
}
