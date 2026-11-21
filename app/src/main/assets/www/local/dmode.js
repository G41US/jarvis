// dmode.js - Delivery mode: plan up to 4 orders the way a ride app asks "from where, to where", then one tap puts the fastest
// route on the 3D map with Jarvis's head in the corner. Opened by voice ("delivery mode"), by the delivery_mode tool, or
// window event 'jv-dmode'. The face shrinks as the sheet grows, so he stays visible above the orders.
import { stageFor } from './ui.js';

export const MAX_ORDERS = 4;
/** Order rows that are ready to send: both ends filled in. */
export const readyRows = rows => rows.filter(r => !r.locked && r.from.trim() && r.to.trim());
/** Every new row is complete (and there is at least one order). */
export const canStart = rows => rows.length > 0 && rows.every(r => r.locked || (r.from.trim() && r.to.trim()));

const CSS = `
#dm { position: fixed; z-index: 40; left: 0; right: 0; bottom: 0; max-height: 64vh; display: flex; flex-direction: column;
  padding: 10px 16px calc(14px + var(--safe-b, 0px)); border-radius: 26px 26px 0 0;
  background: linear-gradient(180deg, rgba(34, 26, 15, .94), rgba(14, 11, 7, .97)); border-top: 1px solid rgba(255, 214, 150, .22);
  box-shadow: 0 -18px 50px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 236, 190, .08);
  -webkit-backdrop-filter: blur(22px) saturate(140%); backdrop-filter: blur(22px) saturate(140%);
  font-family: Roboto, system-ui, sans-serif; color: var(--ice, #fff6e8);
  transform: translateY(110%); transition: transform .45s cubic-bezier(.2, .8, .2, 1); }
body.dm-open #dm { transform: none; }
#dm button, #dm input { text-transform: none; letter-spacing: normal; text-shadow: none; font-family: Roboto, system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
body.dm-open #jv-dock, body.dm-open #jv-hint, body.dm-open #jv-hello, body.dm-open #jv-type, body.dm-open #jv-card, body.dm-open #route-panel { opacity: 0 !important; pointer-events: none !important; }
#dm .grab { width: 40px; height: 4px; border-radius: 4px; background: rgba(255, 236, 190, .22); margin: 0 auto 10px; flex: none; }
#dm header { display: flex; align-items: center; gap: 12px; flex: none; margin-bottom: 12px; }
#dm .app { width: 40px; height: 40px; border-radius: 11px; flex: none; display: grid; place-items: center;
  background: linear-gradient(160deg, #ffd88a, #f0a43a 55%, #c97416); box-shadow: 0 4px 14px rgba(240, 164, 58, .35), inset 0 1px 0 rgba(255, 255, 255, .45); }
#dm .app svg { width: 22px; height: 22px; }
#dm h2 { margin: 0; font: 600 21px/1.1 'Saira', system-ui, sans-serif; font-stretch: 92%; letter-spacing: .01em; color: #fff6e8; text-transform: none; }
#dm header p { margin: 2px 0 0; font-size: 12.5px; color: var(--mist, #cdbb9f); }
#dm header .t { flex: 1; min-width: 0; }
#dm .x { width: 36px; height: 36px; border-radius: 50%; border: 0; background: rgba(255, 236, 190, .08); color: var(--mist, #cdbb9f); display: grid; place-items: center; padding: 0; }
#dm .x svg { width: 18px; height: 18px; }
#dm .list { overflow-y: auto; overscroll-behavior: contain; flex: 1 1 auto; min-height: 0; margin: 0 -4px; padding: 0 4px; scrollbar-width: none; }
#dm .list::-webkit-scrollbar { display: none; }
#dm .me { display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 14px; margin-bottom: 8px; border-radius: 14px;
  background: rgba(255, 236, 190, .05); font-size: 14px; color: var(--mist, #cdbb9f); }
#dm .me i { width: 10px; height: 10px; border-radius: 50%; background: #7ee0a1; box-shadow: 0 0 0 4px rgba(126, 224, 161, .18); flex: none; }
#dm .me b { color: #fff6e8; font-weight: 500; }
#dm .ord { position: relative; border-radius: 18px; margin-bottom: 8px; background: rgba(255, 236, 190, .055); border: 1px solid rgba(255, 214, 150, .1);
  transition: background .25s, border-color .25s; animation: dmIn .35s cubic-bezier(.2, .8, .2, 1); }
@keyframes dmIn { from { opacity: 0; transform: translateY(10px); } }
#dm .ord.open { background: rgba(255, 236, 190, .085); border-color: rgba(255, 214, 150, .28); }
#dm .ord.bad { border-color: rgba(255, 90, 103, .6); }
#dm .num { position: absolute; left: 12px; top: 12px; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center;
  font: 700 12px/1 Roboto, sans-serif; color: #1b1206; background: linear-gradient(160deg, #ffe0a0, #f2b552); }
#dm .row { position: relative; display: flex; align-items: center; height: 48px; padding: 0 44px 0 46px; }
#dm .row + .row { border-top: 1px solid rgba(255, 236, 190, .07); }
#dm .row .pin { position: absolute; left: 49px; width: 10px; height: 10px; }
#dm .row.from .pin { border-radius: 50%; border: 2.5px solid #f5c97a; }
#dm .row.to .pin { border-radius: 2.5px; background: #f5c97a; }
#dm .ord .line { position: absolute; left: 53px; top: 31px; height: 34px; border-left: 2px dotted rgba(245, 201, 122, .45); pointer-events: none; }
#dm input { width: 100%; height: 100%; border: 0; outline: 0; background: none; color: #fff6e8; font: 400 16px/1 Roboto, system-ui, sans-serif; padding: 0 0 0 26px; }
#dm input::placeholder { color: rgba(205, 187, 159, .62); }
#dm .ord.locked input { color: var(--mist, #cdbb9f); }
#dm .rm { position: absolute; right: 8px; top: 8px; width: 32px; height: 32px; border-radius: 50%; border: 0; padding: 0; display: grid; place-items: center;
  background: none; color: rgba(205, 187, 159, .7); }
#dm .rm svg { width: 16px; height: 16px; }
#dm .ord.mini { height: 52px; }
#dm .ord.mini .num { top: 15px; }
#dm .sum { display: flex; align-items: center; gap: 8px; width: 100%; height: 100%; padding: 0 44px 0 46px; border: 0; background: none; color: #fff6e8; font-size: 14.5px; text-align: left; }
#dm .sum .a, #dm .sum .b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
#dm .sum .a { flex: 0 1 auto; max-width: 42%; font-weight: 500; } #dm .sum .b { flex: 1 1 0; color: var(--mist, #cdbb9f); }
#dm .sum .p1 { width: 8px; height: 8px; border-radius: 50%; border: 2px solid #f5c97a; flex: none; }
#dm .sum .p2 { width: 8px; height: 8px; border-radius: 2px; background: #f5c97a; flex: none; }
#dm .sum .arr { font-style: normal; color: rgba(245, 201, 122, .6); flex: none; }
#dm .ord.mini .tag { top: 19px; }
#dm .ord.mini.locked .sum { padding-right: 104px; }
#dm .err { padding: 0 14px 10px 46px; font-size: 12.5px; color: #ff8a93; }
#dm .tag { position: absolute; right: 44px; top: 16px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #7ee0a1; }
#dm .sug { margin: -2px 0 8px; border-radius: 16px; overflow: hidden; background: rgba(10, 8, 5, .7); border: 1px solid rgba(255, 214, 150, .14); }
#dm .sug button { display: flex; width: 100%; gap: 12px; align-items: center; text-align: left; padding: 10px 14px; border: 0; background: none; color: #fff6e8; font: inherit; }
#dm .sug button + button { border-top: 1px solid rgba(255, 236, 190, .06); }
#dm .sug .ico { width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center; background: rgba(255, 236, 190, .08); color: #f5c97a; }
#dm .sug .ico svg { width: 16px; height: 16px; }
#dm .sug b { display: block; font-weight: 500; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#dm .sug small { display: block; font-size: 12px; color: var(--mist, #cdbb9f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
#dm .sug span { min-width: 0; }
#dm .add { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 46px; margin: 2px 0 10px; border-radius: 15px;
  border: 1px dashed rgba(245, 201, 122, .45); background: none; color: #f5c97a; font: 500 15px/1 Roboto, sans-serif; flex: none; }
#dm .add svg { width: 18px; height: 18px; }
#dm .add small { color: var(--mist, #cdbb9f); font-size: 12.5px; font-weight: 400; }
#dm .add:disabled { opacity: .4; }
#dm .go { flex: none; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 56px; border: 0; border-radius: 18px;
  background: linear-gradient(160deg, #ffe3a6 0%, #f5b94f 45%, #e08a1e 100%); color: #1b1206; font: 700 16.5px/1 Roboto, system-ui, sans-serif; letter-spacing: .01em;
  box-shadow: 0 10px 28px rgba(240, 164, 58, .32), inset 0 1px 0 rgba(255, 255, 255, .55); transition: transform .15s, opacity .2s; }
#dm .go:active { transform: scale(.98); }
#dm .go:disabled { opacity: .38; box-shadow: none; }
#dm .go svg { width: 20px; height: 20px; }
#dm .go.busy::after { content: ''; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, .45) 50%, transparent 70%);
  animation: dmShine 1.1s linear infinite; }
@keyframes dmShine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
#dm .foot { flex: none; text-align: center; font-size: 12px; color: var(--mist, #cdbb9f); margin-top: 9px; min-height: 15px; }
#dm .foot.bad { color: #ff8a93; }
@media (prefers-reduced-motion: reduce) { #dm, #dm .ord { transition: none; animation: none; } }
`;
const I = {
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="#1b1206" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 21 3l-8.5 18-2-7.5z"/></svg>',
};

export function initDeliveryMode() {
  const J = () => window.JARVIS, B = document.body;
  const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
  const el = (t, c = '', html = '') => { const e = document.createElement(t); if (c) e.className = c; if (html) e.innerHTML = html; return e; };

  const sheet = el('section'); sheet.id = 'dm'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', 'Delivery mode');
  const head = el('header'), title = el('div', 't');
  title.append(el('h2', '', 'Delivery mode'), el('p', '', 'Up to 4 orders · fastest route'));
  const x = el('button', 'x', I.x); x.type = 'button'; x.setAttribute('aria-label', 'Close');
  head.append(el('div', 'app', I.bag), title, x);
  const list = el('div', 'list'), add = el('button', 'add'), go = el('button', 'go'), foot = el('div', 'foot');
  add.type = 'button'; go.type = 'button';
  sheet.append(el('div', 'grab'), head, list, add, go, foot);
  document.body.append(sheet);

  let rows = [], openIdx = 0, sugFor = null, sugTimer = 0, busy = false;
  const D = () => J() && J().delivery;

  // ---- the face makes room: the taller the sheet, the smaller and higher he sits
  function restage() {
    const open = B.classList.contains('dm-open');
    window.__jvPlan = open ? stageFor({ H: innerHeight, W: innerWidth, cardTop: innerHeight - sheet.offsetHeight, safeTop: 12 }) : null;   // where it lands, not mid-slide
    if (window.__jvRestage) window.__jvRestage();
  }
  if (window.ResizeObserver) new ResizeObserver(() => restage()).observe(sheet);

  function loadStack() {
    const d = D(); if (!d) return [];
    return d.activeOrders().map(o => ({ id: o.id, locked: true, from: o.restaurant, fromQ: '', to: o.drop_addr, toQ: '', err: '' }));
  }
  const blank = () => ({ from: '', fromQ: '', to: '', toQ: '', err: '', locked: false });

  function render() {
    list.innerHTML = '';
    const me = el('div', 'me'); me.append(el('i'), document.createTextNode('Starting from '), el('b', '', 'your location')); list.append(me);
    rows.forEach((r, i) => {
      if (i !== openIdx || r.locked) if (r.locked || (r.from.trim() && r.to.trim() && !r.err)) {   // done: one tidy line, tap to edit
        const c = el('div', 'ord mini' + (r.locked ? ' locked' : '')); c.append(el('span', 'num', String(i + 1)));
        const line = el('button', 'sum'); line.type = 'button'; line.setAttribute('aria-label', `Order ${i + 1}: ${r.from} to ${r.to}`);
        const a = el('span', 'a'), b = el('span', 'b'); a.textContent = r.from; b.textContent = r.to;
        line.append(el('i', 'p1'), a, el('i', 'arr', '→'), el('i', 'p2'), b);
        line.onclick = () => { if (r.locked) return; openIdx = i; hideSug(); render(); };
        const rm = el('button', 'rm', I.x); rm.type = 'button'; rm.setAttribute('aria-label', `Remove order ${i + 1}`); rm.onclick = () => remove(i);
        c.append(line, rm); if (r.locked) c.append(el('span', 'tag', 'In stack')); list.append(c); return;
      }
      const card = el('div', 'ord' + (i === openIdx && !r.locked ? ' open' : '') + (r.locked ? ' locked' : '') + (r.err ? ' bad' : ''));
      card.append(el('span', 'num', String(i + 1)), el('i', 'line'));
      for (const k of ['from', 'to']) {
        const row = el('div', 'row ' + k), inp = el('input');
        inp.value = r[k]; inp.placeholder = k === 'from' ? 'Pick up from' : 'Deliver to';
        inp.setAttribute('aria-label', `Order ${i + 1} ${k === 'from' ? 'pick-up' : 'drop-off'}`); inp.autocomplete = 'off'; inp.enterKeyHint = k === 'from' ? 'next' : 'done';
        inp.readOnly = r.locked;
        inp.oninput = () => { r[k] = inp.value; r[k + 'Q'] = ''; r.err = ''; card.classList.remove('bad'); suggest(i, k, inp.value); sync(); };
        inp.onfocus = () => { if (r.locked) return; if (openIdx !== i) { openIdx = i; card.classList.add('open'); } };
        inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); hideSug(); if (k === 'from') card.querySelector('.row.to input').focus(); else inp.blur(); } };
        row.append(el('i', 'pin'), inp); card.append(row);
      }
      if (r.locked) card.append(el('span', 'tag', 'In stack'));
      const rm = el('button', 'rm', I.x); rm.type = 'button'; rm.setAttribute('aria-label', `Remove order ${i + 1}`);
      rm.onclick = () => remove(i); card.append(rm);
      if (r.err) card.append(el('div', 'err', r.err));
      list.append(card);
      if (sugFor && sugFor.i === i) list.append(sugFor.box);
    });
    sync();
  }
  function sync() {
    const n = rows.length;
    add.disabled = n >= MAX_ORDERS;
    add.innerHTML = I.plus + (n >= MAX_ORDERS ? 'Stack is full' : n ? 'Add another order' : 'Add an order') + ` <small>${n} of ${MAX_ORDERS}</small>`;
    go.disabled = busy || !canStart(rows);
    if (!busy) go.innerHTML = I.go + (n > 1 ? `Start route · ${n} orders` : 'Start route');
  }
  function remove(i) {
    const r = rows[i];
    if (r.locked && D()) { D().removeOrder(String(r.id)); J().reg.exec('plan_deliveries', '{}').catch(() => {}); }
    rows.splice(i, 1); openIdx = Math.max(0, Math.min(openIdx, rows.length - 1)); hideSug();
    if (!rows.length) rows.push(blank());
    render();
  }
  add.onclick = () => {
    if (rows.length >= MAX_ORDERS) return;
    rows.push(blank()); openIdx = rows.length - 1; hideSug(); render();
    const inp = list.querySelectorAll('.ord')[openIdx].querySelector('input'); inp && inp.focus();
    list.scrollTop = list.scrollHeight;
  };
  x.onclick = () => close();

  // ---- place suggestions as you type (OpenStreetMap's Photon search, near where you are)
  function hideSug() { if (sugFor) { sugFor.box.remove(); sugFor = null; } }
  function suggest(i, k, q) {
    clearTimeout(sugTimer); q = q.trim();
    if (q.length < 3) { hideSug(); return; }
    sugTimer = setTimeout(async () => {
      let feats = [];
      try {
        const o = J().navsvc.origin(), params = { q, limit: 5 }; if (o) { params.lat = o[0]; params.lon = o[1]; }
        const res = await D()._get('https://photon.komoot.io/api/', params); feats = (res && res.features) || [];
      } catch {}
      if (!rows[i] || rows[i][k].trim() !== q) return;          // typed on since
      hideSug(); if (!feats.length) return;
      const box = el('div', 'sug');
      for (const f of feats) {
        const p = f.properties || {}, name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || q;
        const area = [p.name ? [p.housenumber, p.street].filter(Boolean).join(' ') : '', p.district || p.locality, p.city, p.state].filter(Boolean).join(', ');
        const b = el('button'); b.type = 'button';
        const txt = el('span'); txt.append(el('b', '', ''), el('small', '', '')); txt.firstChild.textContent = name; txt.lastChild.textContent = area;
        b.append(el('span', 'ico', I.pin), txt);
        b.onclick = () => {
          const r = rows[i]; r[k] = name; r[k + 'Q'] = [name, area].filter(Boolean).join(', '); hideSug(); render();
          const next = list.querySelectorAll('.ord')[i].querySelector(k === 'from' ? '.row.to input' : null);
          if (next) next.focus();
        };
        box.append(b);
      }
      const cards = list.querySelectorAll('.ord'); sugFor = { i, box }; cards[i] && cards[i].after(box);
    }, 350);
  }

  // ---- start: add the new orders, then the fastest route on the map
  go.onclick = async () => {
    if (busy || !canStart(rows)) return;
    busy = true; go.classList.add('busy'); go.disabled = true; go.innerHTML = I.go + 'Finding the fastest route…'; foot.textContent = ''; foot.classList.remove('bad'); hideSug();
    try {
      for (const r of readyRows(rows)) {
        const res = await D().addOrder(r.from.trim(), r.toQ || r.to.trim(), r.fromQ || r.from.trim());
        if (!res.ok) { r.err = res.error; openIdx = rows.indexOf(r); throw new Error(res.error); }
        Object.assign(r, { id: res.id, locked: true, err: '' });
      }
      await J().reg.exec('plan_deliveries', '{}');                    // the route card and the delivery map catch up
      const said = await J().navsvc.startDelivery();
      if (!/^Navigating/.test(said)) throw new Error(said);
      close(); try { J().announce(said); } catch {}
    } catch (e) {
      foot.textContent = (e && e.message) || 'Something went wrong. Try again.'; foot.classList.add('bad'); render();
    } finally { busy = false; go.classList.remove('busy'); sync(); }
  };

  function open() {
    if (B.classList.contains('dm-open')) return;
    rows = loadStack(); if (rows.length < MAX_ORDERS) rows.push(blank());
    openIdx = rows.length - 1; foot.textContent = ''; foot.classList.remove('bad'); render();
    try { if (document.body.getAttribute('data-nav')) J().navsvc.mapControl('hide_map'); } catch {}
    B.classList.add('dm-open'); setTimeout(restage, 30);
  }
  function close() { B.classList.remove('dm-open'); hideSug(); (document.activeElement || {}).blur && document.activeElement.blur(); restage(); }
  window.addEventListener('jv-dmode', e => (e.detail === 'close' ? close() : open()));
  window.__jvDeliveryMode = { open, close, rows: () => rows };
}
