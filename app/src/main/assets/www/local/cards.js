// cards.js - answers as cards on the phone (the PC shows them as 3D panels): weather, prices, facts with a picture, headlines, search
// results, long explanations, live news stations and webcams. They sit in a row near the top; swipe through them, tap a live one to
// watch it full screen, tap × (or swipe the row up) to put them away. They leave by themselves after a while if untouched.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CSS = `
#pc-gauges, #pc-dock, #pc-desk, #pc-desk-cam, #pc-desk-tint, #pc-cam, #pc-ring, #pc-music, #pc-card, #pc-holo, #pc-holo-tv, #pc-feeds, #pc-feeds-close { display: none !important; }   /* PC-only parts of hud_extra.js */
#jv-cards { position: fixed; left: 0; right: 0; top: calc(env(safe-area-inset-top, 0px) + 54px); z-index: 30; display: flex; gap: 12px; overflow-x: auto;
  scroll-snap-type: x mandatory; padding: 4px 16px 10px; scrollbar-width: none; opacity: 0; transform: translateY(-14px); pointer-events: none;
  transition: opacity .35s, transform .45s cubic-bezier(.2,.8,.2,1); }
#jv-cards::-webkit-scrollbar { display: none; }
#jv-cards.on { opacity: 1; transform: none; pointer-events: auto; }
#jv-cards .c { flex: 0 0 min(80vw, 340px); scroll-snap-align: center; max-height: 44vh; overflow: hidden auto; border-radius: 18px; position: relative;
  background: linear-gradient(160deg, rgba(40,30,14,.86), rgba(12,10,8,.9)); border: 1px solid rgba(245,201,122,.32); box-shadow: 0 10px 30px rgba(0,0,0,.45);
  color: #f6ead2; font: 400 14px/1.45 'Saira', system-ui, sans-serif; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
#jv-cards .c .in { padding: 14px 16px 16px; }
#jv-cards .c h4 { margin: 0 0 6px; font: 600 15px/1.3 'Saira', system-ui, sans-serif; color: #ffe6b3; letter-spacing: .01em; }
#jv-cards .c .src { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: rgba(245,201,122,.7); margin-top: 8px; }
#jv-cards .c img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #1a140c; }
#jv-cards .c .stat { font: 600 40px/1.1 'Saira', system-ui, sans-serif; color: #fff1d2; margin: 4px 0; }
#jv-cards .c .stat.up { color: #9be59b; } #jv-cards .c .stat.down { color: #ff9b8a; }
#jv-cards .c .lbl { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: rgba(245,201,122,.8); }
#jv-cards .c .row { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid rgba(245,201,122,.12); }
#jv-cards .c .row:first-of-type { border-top: 0; }
#jv-cards .c .row b { flex: 0 0 18px; color: #f5c97a; font-weight: 600; } #jv-cards .c .row i { display: block; font-style: normal; font-size: 12px; opacity: .7; }
#jv-cards .c.video .play { position: absolute; left: 50%; top: calc(50% - 22px); width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
  background: rgba(0,0,0,.55); border: 1.5px solid #f5c97a; display: flex; align-items: center; justify-content: center; }
#jv-cards .c.video .play::after { content: ''; border-left: 18px solid #ffe6b3; border-top: 11px solid transparent; border-bottom: 11px solid transparent; margin-left: 5px; }
#jv-cards .c .live { position: absolute; left: 10px; top: 10px; padding: 3px 8px; border-radius: 9px; font: 600 10.5px/1.3 'Saira', system-ui, sans-serif;
  letter-spacing: .08em; background: #d23b2f; color: #fff; }
#jv-cards-x { position: fixed; right: 16px; top: calc(env(safe-area-inset-top, 0px) + 12px); z-index: 31; width: 36px; height: 36px; border-radius: 18px;
  border: 1px solid rgba(245,201,122,.4); background: rgba(12,10,8,.85); color: #f5c97a; font-size: 20px; line-height: 32px; text-align: center; display: none; }
#jv-cards.on + #jv-cards-x { display: block; }
#jv-watch { position: fixed; inset: 0; z-index: 70; background: #000; display: none; flex-direction: column; align-items: center; justify-content: center; }
#jv-watch.on { display: flex; }
#jv-watch .box { width: 100vw; aspect-ratio: 16 / 9; max-height: 80vh; background: #000; }
#jv-watch iframe { width: 100%; height: 100%; border: 0; }
#jv-watch .bar { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 12px); left: 12px; right: 12px; display: flex; justify-content: space-between; gap: 10px; align-items: center; }
#jv-watch .bar span { color: #ffe6b3; font: 600 14px/1.3 'Saira', system-ui, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#jv-watch button { flex: 0 0 auto; height: 38px; padding: 0 14px; border-radius: 19px; border: 1px solid rgba(245,201,122,.5); background: rgba(20,16,10,.9); color: #ffe6b3; font: 600 13px 'Saira', system-ui, sans-serif; }
`;

export function initCards() {
  const W = window, st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const row = document.createElement('div'); row.id = 'jv-cards'; document.body.appendChild(row);
  const x = document.createElement('button'); x.id = 'jv-cards-x'; x.setAttribute('aria-label', 'Put the cards away'); x.textContent = '×'; document.body.appendChild(x);
  const watch = document.createElement('div'); watch.id = 'jv-watch';
  watch.innerHTML = '<div class="bar"><span></span><div><button data-yt hidden>YouTube</button> <button data-close>Close</button></div></div><div class="box"></div>';
  document.body.appendChild(watch);
  let items = [], timer = null;
  const hide = () => { row.classList.remove('on'); clearTimeout(timer); setTimeout(() => { if (!row.classList.contains('on')) row.innerHTML = ''; }, 400); };
  const linger = ms => { clearTimeout(timer); timer = setTimeout(hide, ms); };

  function cardHtml(it, i) {
    if (it.kind === 'video') return `<div class="c video" data-i="${i}">${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : '<img alt="">'}
      ${it.live || it.video ? '<span class="live">LIVE</span>' : ''}<div class="play"></div><div class="in"><h4>${esc(it.title)}</h4><div class="src">${esc(it.source || '')}</div></div></div>`;
    if (it.image && !it.kind) return `<div class="c"><img src="${esc(it.image)}" alt=""><div class="in"><h4>${esc(it.title || '')}</h4>${it.source ? `<div class="src">${esc(it.source)}</div>` : ''}</div></div>`;
    if (it.kind === 'stat') return `<div class="c"><div class="in"><div class="lbl">${esc(it.label)}</div><div class="stat ${esc(it.tone || '')}">${esc(it.value)}</div>${it.sub ? `<div>${esc(it.sub)}</div>` : ''}</div></div>`;
    if (it.kind === 'list') return `<div class="c"><div class="in"><h4>${esc(it.title)}</h4>${(it.rows || []).map(r => `<div class="row"><b>${esc(r.t)}</b><div>${esc(r.title)}${r.sub ? `<i>${esc(r.sub)}</i>` : ''}</div></div>`).join('')}</div></div>`;
    return `<div class="c"><div class="in"><h4>${esc(it.title || '')}</h4><div>${esc(it.text || '')}</div>${it.source ? `<div class="src">${esc(it.source)}</div>` : ''}</div></div>`;
  }
  function show(msg) {
    items = msg.items || []; if (!items.length) return hide();
    row.innerHTML = items.map(cardHtml).join('');
    row.scrollLeft = 0; row.classList.add('on');
    linger(items.some(it => it.kind === 'video') ? 120000 : 45000);
  }
  function play(it) {
    const box = watch.querySelector('.box'), url = it.video
      ? `https://www.youtube.com/embed/${encodeURIComponent(it.video)}?autoplay=1&playsinline=1&rel=0`
      : it.cam;
    if (!url) return;
    box.innerHTML = `<iframe src="${esc(url)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    watch.querySelector('span').textContent = it.title || '';
    const yt = watch.querySelector('[data-yt]'); yt.hidden = !it.video; yt.onclick = () => { const u = 'https://www.youtube.com/watch?v=' + it.video; try { if (W.AndroidBridge && W.AndroidBridge.openUrl) W.AndroidBridge.openUrl(u); else W.open(u, '_blank'); } catch {} };
    watch.classList.add('on'); clearTimeout(timer); W.__jvWatching = true;
  }
  const stop = () => { watch.classList.remove('on'); watch.querySelector('.box').innerHTML = ''; W.__jvWatching = false; if (row.classList.contains('on')) linger(60000); };
  watch.querySelector('[data-close]').onclick = stop;
  x.onclick = hide;
  row.addEventListener('click', e => {
    const c = e.target.closest('.c'); linger(60000);
    if (c && c.dataset.i != null) play(items[+c.dataset.i]);
  });
  row.addEventListener('scroll', () => linger(60000), { passive: true });
  let y0 = null;             // swipe the row up to put it away
  row.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
  row.addEventListener('touchend', e => { if (y0 != null && y0 - e.changedTouches[0].clientY > 50) hide(); y0 = null; }, { passive: true });

  W.addEventListener('jv-msg', e => {
    const m = String(e.detail || ''); if (!m.startsWith('panels:')) return;
    let msg = {}; try { msg = JSON.parse(m.slice(7)); } catch { return; }
    if (msg.cmd === 'close') { hide(); stop(); return; }
    try { W.__jvGlobe && W.__jvGlobe.on && W.__jvGlobe.hide(); } catch {}
    show(msg);
  });
  return { show, hide };
}
