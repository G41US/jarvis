// ui.js - the phone layout around Jarvis's face.
// One idea runs the whole screen: the light changes with what Jarvis is doing (light blue waiting or talking, mint while he
// listens, amber while he thinks, red when muted), and a ring of light around his face moves with your voice and his.
// Around that: a greeting while he waits, a glass card with the whole answer while you talk, and one floating bar of buttons.
// The PC page's own controls stay underneath and keep working; this layer reads and drives them.
const J = () => window.JARVIS;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const CSS = `
@font-face { font-family: 'Saira'; src: url('fonts/Saira.ttf') format('truetype'); font-weight: 100 900; font-stretch: 50% 125%; font-display: swap; }
:root { --abyss: #03070c; --glass: rgba(12, 26, 42, .58); --glass-hi: rgba(160, 215, 255, .14); --ice: #eaf6ff; --mist: #9db3c6; --dim: #61798d;
  --holo: #7fd8ff; --live: #52f2b6; --amber: #ffb24c; --danger: #ff5a67;
  --state: var(--holo); --safe-t: env(safe-area-inset-top, 0px); --safe-b: env(safe-area-inset-bottom, 0px);
  --ease: cubic-bezier(.2, .8, .2, 1); }
body { background: radial-gradient(120% 70% at 50% 46%, #0b1a2c 0%, #050c16 46%, var(--abyss) 78%); }
body.st-session, body.st-listening { --state: var(--live); }
body.st-thinking { --state: var(--amber); }
body.st-muted { --state: var(--danger); }

/* the PC page's own HUD and backdrop: replaced by this layer */
#state, #controls, #mic-level, #partial-text, #debug, #diag, #voice-panel, #cam-indicator, #activate, #log { visibility: hidden; }
#bg-base, #bg-rings, #bg-halo, #bg-floor { display: none; }
body.jv-history #log { visibility: visible; }

/* ---- the aura: rings of light drawn over the face's canvas, around (never across) the face. The face itself lifts and shrinks
   with the 3D camera when the answer card needs room (window.__jvStage); the aura follows with the same move. */
#jv-aura { position: fixed; inset: 0; z-index: 2; pointer-events: none; transform-origin: 50% 50%; transform: translateY(var(--stage-ty, 0px)) scale(var(--stage-s, 1)); transition: transform .5s var(--ease), opacity .5s; }
body[data-nav] #jv-aura { opacity: 0; }

/* ---- top bar */
#jv-top { position: fixed; z-index: 9; top: calc(var(--safe-t) + 12px); left: 14px; right: 14px; display: flex; align-items: center; gap: 10px; pointer-events: none; }
#jv-top .jv-sp { flex: 1; }
#jv-status { pointer-events: auto; display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px 0 13px; border-radius: 999px; max-width: 64vw;
  background: var(--glass); border: 1px solid color-mix(in srgb, var(--state) 38%, transparent); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  font: 600 15px/1 'Saira', system-ui, sans-serif; font-stretch: 88%; color: var(--ice); transition: border-color .4s; }
#jv-status > span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* the little sign in the pill: a dot waiting, moving bars listening or talking, a spinning arc thinking */
#jv-status .sig { position: relative; width: 14px; height: 14px; flex: none; display: grid; grid-auto-flow: column; align-items: center; justify-content: center; gap: 2px; }
#jv-status .sig i { width: 2.5px; height: 4px; border-radius: 2px; background: var(--state); transition: background .4s, height .2s; }
body.st-standby #jv-status .sig i, body.st-idle #jv-status .sig i, body.st-muted #jv-status .sig i { height: 4px; }
body.st-standby #jv-status .sig i:not(:nth-child(2)), body.st-idle #jv-status .sig i:not(:nth-child(2)), body.st-muted #jv-status .sig i:not(:nth-child(2)) { opacity: 0; }
body.st-standby #jv-status .sig i:nth-child(2), body.st-idle #jv-status .sig i:nth-child(2), body.st-muted #jv-status .sig i:nth-child(2) { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 10px var(--state); }
body.st-listening #jv-status .sig i, body.st-session #jv-status .sig i, body.st-speaking #jv-status .sig i { animation: jvBars .9s ease-in-out infinite; }
#jv-status .sig i:nth-child(2) { animation-delay: -.3s !important; } #jv-status .sig i:nth-child(3) { animation-delay: -.6s !important; }
@keyframes jvBars { 0%, 100% { height: 4px; } 50% { height: 13px; } }
body.st-thinking #jv-status .sig i { opacity: 0; }
body.st-thinking #jv-status .sig::after { content: ''; position: absolute; inset: 0; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--state) 25%, transparent); border-top-color: var(--state); animation: jvSpin .8s linear infinite; }
@keyframes jvSpin { to { transform: rotate(360deg); } }

.jv-ic, #jv-orb, #jv-card button, #jv-chips button, #jv-hist-head button { text-transform: none; letter-spacing: normal; text-shadow: none; font-family: Roboto, system-ui, sans-serif; }
.jv-ic { pointer-events: auto; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; padding: 0; border: 1px solid var(--glass-hi);
  background: var(--glass); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); color: var(--mist); -webkit-tap-highlight-color: transparent; transition: transform .15s, color .3s, border-color .3s; }
.jv-ic svg { width: 21px; height: 21px; }
.jv-ic:active { transform: scale(.92); }
.jv-ic.on { border-color: color-mix(in srgb, var(--danger) 60%, transparent); color: var(--danger); }
button:focus-visible { outline: 2px solid var(--ice) !important; outline-offset: 3px; }

/* shift readout: an instrument cluster, only while a shift is running */
#jv-shift { pointer-events: auto; display: none; align-items: stretch; height: 44px; border-radius: 14px; background: var(--glass); border: 1px solid rgba(255, 178, 76, .3);
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); overflow: hidden; }
body.on-shift #jv-shift { display: flex; }
#jv-shift b { display: flex; flex-direction: column; justify-content: center; padding: 0 10px; font: 600 17px/1 'Saira', sans-serif; font-stretch: 76%; color: var(--ice); font-variant-numeric: tabular-nums; }
#jv-shift b + b { border-left: 1px solid rgba(255, 178, 76, .18); }
#jv-shift b small { font: 500 10px/1.2 Roboto, sans-serif; color: var(--mist); margin-top: 3px; }
#jv-shift b.money { color: var(--amber); }
body.on-shift #jv-status { max-width: 40vw; }

/* ---- greeting while he waits */
#jv-hello { position: fixed; z-index: 4; top: calc(var(--safe-t) + 78px); left: 24px; right: 24px; pointer-events: none; color: var(--ice);
  transition: opacity .6s var(--ease), transform .6s var(--ease); }
#jv-hello .g { font: 300 26px/1.1 'Saira', system-ui, sans-serif; font-stretch: 118%; color: var(--mist); letter-spacing: .01em; }
#jv-hello .n { font: 600 38px/1.05 'Saira', system-ui, sans-serif; font-stretch: 112%; margin-top: 2px; letter-spacing: -.005em;
  background: linear-gradient(100deg, var(--ice) 30%, color-mix(in srgb, var(--state) 80%, var(--ice))); -webkit-background-clip: text; background-clip: text; color: transparent; }
#jv-hello .d { font: 400 14px/1.4 Roboto, system-ui, sans-serif; color: var(--dim); margin-top: 10px; }
body.jv-talking #jv-hello, body[data-nav] #jv-hello, body.jv-route #jv-hello, body.sos-on #jv-hello { opacity: 0; transform: translateY(-10px); }

/* ---- the answer card */
#jv-card { position: fixed; z-index: 8; left: 12px; right: 12px; bottom: calc(var(--safe-b) + 116px); max-height: 40vh; display: flex; flex-direction: column;
  border-radius: 24px; background: linear-gradient(180deg, rgba(16, 32, 50, .72), rgba(8, 18, 30, .78)); -webkit-backdrop-filter: blur(22px) saturate(140%); backdrop-filter: blur(22px) saturate(140%);
  border: 1px solid var(--glass-hi); box-shadow: 0 24px 60px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .06);
  opacity: 0; transform: translateY(18px) scale(.98); pointer-events: none; transition: opacity .45s var(--ease), transform .55s var(--ease); }
#jv-card::before { content: ''; position: absolute; left: 22px; right: 22px; top: -1px; height: 1px; background: linear-gradient(90deg, transparent, var(--state), transparent); opacity: .8; transition: background .4s; }
body.jv-talking #jv-card { opacity: 1; transform: none; pointer-events: auto; }
#jv-card .you { padding: 16px 48px 0 18px; font: 400 14px/1.4 Roboto, system-ui, sans-serif; color: var(--mist); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#jv-card .you:empty { display: none; }
#jv-card .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 18px 18px; scrollbar-width: none; }
#jv-card .scroll.up { -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 22px); mask-image: linear-gradient(to bottom, transparent 0, #000 22px); }
#jv-card .scroll::-webkit-scrollbar { display: none; }
#jv-card .him { font: 500 19px/1.42 'Saira', Roboto, system-ui, sans-serif; font-stretch: 96%; color: var(--ice); text-wrap: pretty; white-space: pre-wrap; overflow-wrap: anywhere; }
#jv-card .heard { font: 500 21px/1.38 'Saira', Roboto, system-ui, sans-serif; font-stretch: 96%; color: var(--live); }
#jv-card .heard:not(:empty)::after { content: ''; display: inline-block; width: 2px; height: 1.05em; margin-left: 3px; vertical-align: -0.15em; background: var(--live); animation: jvCaret 1s steps(1) infinite; }
@keyframes jvCaret { 50% { opacity: 0; } }
#jv-card .wait { display: none; align-items: center; gap: 12px; font: 400 15px/1.3 Roboto, system-ui, sans-serif; color: var(--mist); }
#jv-card.listen .wait, #jv-card.think .wait { display: flex; }
#jv-card .wait b { flex: 1; height: 10px; border-radius: 6px; background: linear-gradient(90deg, rgba(255,255,255,.05) 0%, color-mix(in srgb, var(--state) 35%, transparent) 50%, rgba(255,255,255,.05) 100%) 0 0 / 200% 100%;
  animation: jvShimmer 1.4s linear infinite; }
#jv-card.listen .wait b { display: none; }
@keyframes jvShimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
#jv-card.listen .him, #jv-card.think .him { display: none; }
#jv-card:not(.listen) .heard { display: none; }
#jv-card .x { position: absolute; top: 8px; right: 8px; width: 36px; height: 36px; border-radius: 50%; border: 0; padding: 0; display: grid; place-items: center; background: transparent; color: var(--dim); }
#jv-card .x svg { width: 18px; height: 18px; }
#jv-card.listen .x, #jv-card.think .x { display: none; }

/* ---- something Jarvis says by himself (a new message, a reminder): a pill under the top bar */
#jv-toast { position: fixed; z-index: 10; top: calc(var(--safe-t) + 64px); left: 14px; right: 14px; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 18px;
  background: rgba(40, 28, 10, .78); border: 1px solid rgba(255, 178, 76, .32); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  font: 400 15px/1.35 Roboto, system-ui, sans-serif; color: #ffe7c2; opacity: 0; transform: translateY(-12px); pointer-events: none; transition: opacity .4s var(--ease), transform .45s var(--ease); }
#jv-toast.on { opacity: 1; transform: none; pointer-events: auto; }
#jv-toast svg { width: 20px; height: 20px; flex: none; color: var(--amber); }
body.sos-on #jv-toast { top: calc(var(--safe-t) + 140px); }

/* ---- things to try, while he waits */
#jv-chips { position: fixed; z-index: 8; left: 0; right: 0; bottom: calc(var(--safe-b) + 118px); display: flex; gap: 8px; overflow-x: auto; padding: 4px 14px; scrollbar-width: none;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 14px, #000 calc(100% - 14px), transparent); mask-image: linear-gradient(90deg, transparent, #000 14px, #000 calc(100% - 14px), transparent);
  transition: opacity .4s var(--ease), transform .45s var(--ease); }
#jv-chips::-webkit-scrollbar { display: none; }
#jv-chips button { flex: none; height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--glass-hi); background: var(--glass); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  color: var(--ice); font-size: 14px; font-weight: 500; white-space: nowrap; }
#jv-chips button:active { transform: scale(.96); }
body.jv-talking #jv-chips, body[data-nav] #jv-chips, body.st-muted #jv-chips, body.jv-history #jv-chips { opacity: 0; transform: translateY(10px); pointer-events: none; }

/* ---- the bar of buttons */
#jv-dock { position: fixed; z-index: 9; left: 50%; bottom: calc(var(--safe-b) + 18px); transform: translateX(-50%); display: flex; align-items: center; gap: 26px; padding: 8px 14px; border-radius: 999px;
  background: rgba(8, 18, 30, .55); border: 1px solid var(--glass-hi); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 16px 40px rgba(0, 0, 0, .4); }
#jv-dock .jv-ic { background: transparent; border-color: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; }
#jv-dock .jv-ic.on { background: color-mix(in srgb, var(--danger) 14%, transparent); }
#jv-orb { position: relative; width: 72px; height: 72px; margin: -14px 0; border-radius: 50%; border: 0; padding: 0; display: grid; place-items: center; cursor: pointer;
  background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--state) 34%, #0c1a2a), #06101c 72%); color: var(--ice);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--state) 55%, transparent), 0 0 calc(14px + var(--lvl, 0) * 46px) color-mix(in srgb, var(--state) 60%, transparent), 0 10px 26px rgba(0, 0, 0, .5);
  transition: box-shadow .12s linear, transform .15s; -webkit-tap-highlight-color: transparent; }
#jv-orb::before { content: ''; position: absolute; inset: -5px; border-radius: 50%; padding: 2px;
  background: conic-gradient(from var(--spin, 0deg), transparent 0 55%, var(--state) 80%, transparent 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  opacity: 0; transition: opacity .4s; }
body.st-thinking #jv-orb::before, body.st-listening #jv-orb::before, body.st-session #jv-orb::before { opacity: 1; animation: jvSpin 1.6s linear infinite; }
body.st-thinking #jv-orb::before { animation-duration: .8s; }
#jv-orb svg { width: 28px; height: 28px; position: relative; }
#jv-orb:active { transform: scale(.94); }

/* ---- conversation history, as a sheet with bubbles */
#jv-hist-head { position: fixed; z-index: 11; left: 0; right: 0; top: calc(var(--safe-t) + 70px); display: none; align-items: center; gap: 8px; padding: 14px 16px 10px 22px;
  border-radius: 26px 26px 0 0; background: rgba(6, 14, 24, .96); border-top: 1px solid var(--glass-hi); }
#jv-hist-head h2 { flex: 1; margin: 0; font: 600 21px/1 'Saira', sans-serif; font-stretch: 100%; color: var(--ice); }
#jv-hist-head::before { content: ''; position: absolute; top: 6px; left: 50%; width: 38px; height: 4px; margin-left: -19px; border-radius: 2px; background: rgba(255,255,255,.18); }
#jv-hist-head button { height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--glass-hi); background: transparent; color: var(--mist); font-size: 14px; }
body.jv-history #jv-hist-head { display: flex; }
body.jv-history #log { position: fixed !important; z-index: 10; left: 0 !important; right: 0 !important; top: calc(var(--safe-t) + 128px) !important; bottom: 0 !important; width: auto !important; max-height: none !important;
  display: flex; flex-direction: column; gap: 10px; padding: 6px 14px calc(var(--safe-b) + 120px); background: rgba(6, 14, 24, .96); -webkit-mask-image: none; mask-image: none; font: 15px/1.45 Roboto, system-ui, sans-serif; }
body.jv-history #log .msg { margin: 0; max-width: 84%; }
body.jv-history #log .who { display: none; }
body.jv-history #log .msg.user { align-self: flex-end; padding: 10px 14px; border-radius: 20px 20px 6px 20px; background: rgba(127, 216, 255, .16); }
body.jv-history #log .msg.user .body { color: var(--ice); }
body.jv-history #log .msg.jarvis { align-self: flex-start; padding: 11px 15px; border-radius: 20px 20px 20px 6px; background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .06); }
body.jv-history #log .msg.jarvis .body { color: #dcecf8; }
body.jv-history #log .msg.sys, body.jv-history #log .msg.proactive { align-self: center; max-width: 92%; text-align: center; font-size: 13px; font-style: normal; opacity: 1; }
body.jv-history #log .msg.sys { color: var(--dim); } body.jv-history #log .msg.proactive { color: #f5cf95; }
body.jv-history #jv-card, body.jv-history #jv-toast { visibility: hidden; }

/* ---- SOS: impossible to miss, one tap to stand down */
#jv-sos { position: fixed; z-index: 12; left: 0; right: 0; top: 0; display: none; align-items: center; gap: 12px; padding: calc(var(--safe-t) + 12px) 16px 14px;
  background: linear-gradient(180deg, #7a0f19, #5a0a12); box-shadow: 0 10px 40px rgba(255, 40, 60, .35); font: 600 15px/1.3 'Saira', sans-serif; color: #ffe9e9; }
body.sos-on #jv-sos { display: flex; }
body.sos-on #jv-top { top: calc(var(--safe-t) + 86px); }
#jv-sos span { flex: 1; }
#jv-sos button { border: 0; border-radius: 999px; padding: 12px 18px; background: #ffe9e9; color: #5a0a12; font: 700 15px/1 'Saira', sans-serif; text-transform: none; letter-spacing: normal; text-shadow: none; white-space: nowrap; }
body.sos-on #route-panel, body.sos-on .nb { top: calc(var(--safe-t) + 142px) !important; }
body.sos-on[data-nav="mini"] #nav-frame { top: calc(var(--safe-t) + 140px) !important; }

/* ---- delivery route card: a timeline of stops */
#route-panel { font-family: Roboto, system-ui, sans-serif; }
@media (max-width: 820px), (orientation: portrait) {
  #route-panel { top: calc(var(--safe-t) + 66px) !important; left: 12px !important; right: 12px !important; width: auto !important; max-height: 32vh; z-index: 7;
    padding: 14px 16px 12px; border-radius: 22px; border: 1px solid rgba(255, 178, 76, .26); border-left: 1px solid rgba(255, 178, 76, .26) !important;
    background: linear-gradient(180deg, rgba(22, 30, 40, .82), rgba(10, 18, 28, .86)); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 18px 50px rgba(0,0,0,.4); }
  #route-head { margin-bottom: 8px !important; font: 400 13px/1.45 Roboto, sans-serif !important; letter-spacing: 0 !important; text-transform: none !important; color: var(--mist) !important; text-shadow: none !important; }
  #route-head > span { display: block; } #route-head br { display: none; }
  #route-head > span:first-child { font: 600 17px/1.25 'Saira', sans-serif; font-stretch: 92%; color: var(--ice); margin-bottom: 2px; padding-right: 26px; }
  #route-head .money { color: var(--amber) !important; font-weight: 500; }
  #route-head .est { color: #cdb894 !important; }
  #route-panel::after { content: ''; position: absolute; top: 18px; right: 16px; width: 8px; height: 8px; border-right: 2px solid var(--mist); border-bottom: 2px solid var(--mist); transform: rotate(-135deg); transition: transform .3s; }
  #route-panel.jv-folded { overflow: hidden; padding-bottom: 14px; }
  #route-panel.jv-folded #route-stops, #route-panel.jv-folded #route-warn, #route-panel.jv-folded #route-head > :not(:first-child) { display: none !important; }
  #route-panel.jv-folded #route-head { margin-bottom: 0 !important; }
  #route-panel.jv-folded::after { transform: rotate(45deg) translate(-3px, -3px); }
  .rs { position: relative; margin: 0 !important; padding: 6px 0 8px 22px; font-size: 14px !important; }
  .rs::before { content: ''; position: absolute; left: 3px; top: 12px; width: 9px; height: 9px; border-radius: 50%; background: var(--live); box-shadow: 0 0 10px color-mix(in srgb, var(--live) 60%, transparent); }
  .rs.pickup::before { background: var(--amber); box-shadow: 0 0 10px color-mix(in srgb, var(--amber) 60%, transparent); }
  .rs:not(:last-child)::after { content: ''; position: absolute; left: 7px; top: 24px; bottom: -8px; width: 1px; background: rgba(255, 255, 255, .14); }
  .rs .row { gap: 10px !important; }
  .rs .t { color: var(--ice) !important; min-width: 0 !important; font: 600 15px/1.3 'Saira', sans-serif; font-stretch: 86%; font-variant-numeric: tabular-nums; }
  .rs .k { text-transform: none !important; letter-spacing: 0 !important; font-size: 12px !important; min-width: 0 !important; }
  .rs .n { color: var(--ice) !important; font-weight: 500; text-shadow: none !important; }
  .rs .sub { margin-left: 0 !important; font-size: 12px !important; letter-spacing: 0 !important; color: var(--dim) !important; }
  #route-warn { font-size: 12px !important; color: #cdb894 !important; font-style: normal !important; }
}

/* ---- while the map is up the map owns the screen; Jarvis shrinks to the bar on the right */
body[data-nav="full"] #jv-card { visibility: hidden; }
body[data-nav="full"] #jv-dock { left: auto; right: 12px; transform: none; bottom: calc(var(--safe-b) + 110px); flex-direction: column; gap: 14px; padding: 10px 8px; }
body[data-nav="full"] #jv-orb { width: 58px; height: 58px; margin: 0; }
body[data-nav="full"] #jv-hist { display: none; }
@media (max-width: 820px), (orientation: portrait) {
  body[data-nav="mini"] #nav-frame { top: calc(var(--safe-t) + 66px) !important; left: 12px !important; right: 12px !important; width: auto !important; height: 34vh !important; }
  body[data-nav="mini"] #route-panel { top: calc(var(--safe-t) + 66px + 34vh + 10px) !important; }
  .nb { left: 12px !important; right: 12px; top: calc(var(--safe-t) + 64px) !important; min-width: 0 !important; max-width: none !important; }
  .ne { bottom: calc(var(--safe-b) + 18px) !important; }
  .ne-c { padding: 8px 14px !important; min-width: 74px !important; }
}

/* ---- deliveries ("dash"): the route card on top, a small map with directions under it, Jarvis as an orb in the bottom-right */
body[data-nav="dash"] #nav-frame { inset: auto !important; top: var(--dash-top, 330px) !important; left: 12px !important; right: 12px !important; width: auto !important;
  height: var(--dash-h, 34vh) !important; border-radius: 22px; opacity: 1; clip-path: inset(0 round 22px);
  box-shadow: 0 0 0 1px rgba(127, 216, 255, .22), 0 18px 50px rgba(0, 0, 0, .5); }
body[data-nav="dash"] #three { z-index: 5; pointer-events: none; transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% var(--orb-fy, 50%)); }
body[data-nav="dash"] #nav-orb { opacity: 1; }
body[data-nav="dash"] #route-panel { max-height: 24vh; overflow-y: auto; }
body[data-nav="dash"] #jv-card { right: calc(var(--orb-d, 110px) + 30px); max-height: var(--orb-d, 110px); bottom: var(--dash-orb-bottom, 112px); border-radius: 20px; }
#nav-frame .maplibregl-ctrl-attrib { background: rgba(3, 7, 12, .55) !important; color: var(--dim); font: 9px/1.3 Roboto, sans-serif; border-radius: 8px; margin: 0 6px 6px 0 !important; }
#nav-frame .maplibregl-ctrl-attrib a { color: var(--mist) !important; }
#nav-frame .maplibregl-ctrl-attrib.maplibregl-compact { min-height: 18px; padding: 2px 22px 2px 6px !important; }
#nav-frame .maplibregl-ctrl-attrib-button { width: 18px; height: 18px; filter: invert(.8); }
body[data-nav="dash"] #jv-card .him { font-size: 16px; }
body[data-nav="dash"] #jv-card .you { display: none; }
body[data-nav="dash"] #jv-card .scroll { padding-top: 14px; }
body[data-nav="dash"] #jv-card .x { display: none; }
body[data-nav="dash"] .nb { top: 8px !important; left: 8px !important; right: 8px !important; padding: 7px 12px 7px 8px !important; gap: 10px !important; border-radius: 16px !important; }
body[data-nav="dash"] .nb:has(.nb-dist:empty) { display: none !important; }   /* no route yet (waiting for GPS): no empty banner */
body[data-nav="dash"] .nb-icon { width: 38px !important; height: 38px !important; }
body[data-nav="dash"] .nb-dist { font-size: 19px !important; }
body[data-nav="dash"] .nb-text { font-size: 12px !important; }
body[data-nav="dash"] .ne { bottom: 8px !important; border-radius: 14px; }
body[data-nav="dash"] .ne-c { padding: 4px 10px !important; min-width: 56px !important; }
body[data-nav="dash"] .ne-c b { font-size: 15px !important; } body[data-nav="dash"] .ne-c span { font-size: 8px !important; letter-spacing: 1.5px !important; }
body[data-nav="dash"] .nb-then, body[data-nav="dash"] #nav-badge, body[data-nav="dash"] .nav-note, body[data-nav="dash"] #nav-caption, body[data-nav="dash"] .ne-stop { display: none !important; }

@media (prefers-reduced-motion: reduce) {
  #jv-status .sig i, #jv-orb::before, #jv-card .wait b, #jv-card .heard::after { animation: none !important; }
  body:not([data-nav]) #three, #jv-aura, #jv-card, #jv-hello, #jv-chips, #jv-toast { transition: none; }
}
`;

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.6 5M18.4 12.6c.06-.5.1-1 .1-1.6M12 17.5V21M3 3l18 18"/></svg>',
  hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z"/><path d="M8.5 10.5h7M8.5 13.5h4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2.2 2.2 0 0 0 4 0"/></svg>',
};
const STATUS = { idle: 'Starting…', standby: 'Say “Hey Jarvis”', session: 'Listening', listening: 'Listening', thinking: 'Thinking…', speaking: 'Speaking', muted: 'Muted' };
/** What Jarvis is doing while you wait, from the tool he's using. */
export const ACTIVITY = {
  get_weather: 'Checking the weather', search_web: 'Searching the web', wikipedia: 'Looking it up', fetch_page: 'Reading the page', news_headlines: 'Getting the news',
  navigate_to: 'Finding the route', start_delivery_navigation: 'Routing your stops', plan_deliveries: 'Planning your stops', add_delivery_order: 'Adding the order', evaluate_delivery_offer: 'Weighing the offer',
  look_with_camera: 'Looking', translate_with_camera: 'Reading and translating', scan_receipt: 'Reading the receipt', scan_qr: 'Scanning', who_is_this: 'Looking at the face', remember_face: 'Learning the face',
  look_at_screen: 'Looking at your screen', read_screen: 'Reading the screen', tap_on_screen: 'Tapping', type_on_screen: 'Typing', scroll_screen: 'Scrolling', press_button: 'Pressing',
  open_app: 'Opening the app', open_website: 'Opening the site', phone_call: 'Calling', send_text: 'Writing the message', whatsapp_message: 'Opening WhatsApp', read_notifications: 'Reading your messages',
  reply_to_message: 'Sending the reply', get_calendar: 'Checking your calendar', add_calendar_event: 'Adding it to your calendar', create_document: 'Writing the document', set_reminder: 'Setting the reminder',
  find_gas: 'Finding gas nearby', find_my_car: 'Finding your car', end_shift: 'Adding up your shift', mileage_log: 'Adding up your miles', expense_summary: 'Adding up expenses',
  smart_home_control: 'Talking to your home', smart_home_devices: 'Checking your home', emergency: 'Sending your SOS', start_interpreter: 'Starting the interpreter', crypto_price: 'Checking the price', currency_convert: 'Converting',
};

/** Things to try, by situation. Tapping one asks it, as if you'd said it. */
export const SUGGEST = {
  idle: ["What's the weather?", "What's on my calendar today?", 'Remind me in 20 minutes', 'Start my shift', 'Translate for me', 'Find gas near me'],
  orders: ['Where next?', 'Picked up', 'Delivered', 'How much did I make today?', 'Show the mini map'],
  shift: ['How is my shift going?', 'Where did I park?', 'Find gas near me', 'End my shift'],
};

/** "Good evening" for an hour of the day. */
export function greeting(h) { return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

/** How far to lift and shrink the face so it clears the answer card: { ty, s } in px and scale. */
export function faceHalf(W, H) { return W < H ? 0.30 * W : 0.135 * H; }   // the 3D camera keeps the face ~0.6 of the width wide on a portrait phone
export function stageFor({ H, W = H * 0.45, cardTop, safeTop = 0, cy = 0.51 }) {
  if (!cardTop || cardTop >= H) return { ty: 0, s: 1 };
  const hh = faceHalf(W, H), topLimit = safeTop + 64, gap = 12;
  const centre = s => H / 2 + (H * cy - H / 2) * s;                // the camera zooms about the middle of the screen
  let s = 0.88, ty = Math.min(0, (cardTop - gap) - (centre(s) + hh * s));
  if (centre(s) - hh * s + ty < topLimit) {                         // not enough room even lifted: shrink to fit between the top bar and the card
    s = Math.max(0.5, ((cardTop - gap) - topLimit) / (2 * hh));
    ty = (topLimit + hh * s) - centre(s);
  }
  return { ty: Math.round(ty), s: Math.round(s * 1000) / 1000 };
}

// ------------------------------------------------------------------ the aura: rings of light around the face
function createAura(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, t0 = performance.now(), last = 0, energy = 0, raf = 0;
  const col = [127, 216, 255], target = [127, 216, 255];
  const COLORS = { holo: [127, 216, 255], live: [82, 242, 182], amber: [255, 178, 76], danger: [255, 90, 103] };
  const motes = Array.from({ length: 46 }, (_, i) => ({ a: Math.random() * Math.PI * 2, r: 1.05 + Math.random() * 0.75, s: (0.02 + Math.random() * 0.05) * (i % 2 ? 1 : -1), z: 0.6 + Math.random() * 1.6, p: Math.random() * 6.28 }));
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  };
  resize(); window.addEventListener('resize', resize);
  const rgba = a => `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${a})`;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const paused = document.hidden || window.__jvPaused || document.body.hasAttribute('data-nav') || document.body.classList.contains('jv-history');
    if (paused || now - last < 30) return;                           // ~30 frames a second is plenty for light
    last = now;
    const t = (now - t0) / 1000, b = document.body.classList;
    const st = b.contains('st-thinking') ? 'think' : b.contains('st-speaking') ? 'speak' : b.contains('st-listening') || b.contains('st-session') ? 'listen' : b.contains('st-muted') ? 'mute' : 'idle';
    const key = st === 'listen' ? 'live' : st === 'think' ? 'amber' : st === 'mute' ? 'danger' : 'holo';
    for (let i = 0; i < 3; i++) { target[i] = COLORS[key][i]; col[i] += (target[i] - col[i]) * 0.08; }
    const stats = J() && J().stats;
    const mic = stats ? Math.min(1, Math.sqrt(stats.rms || 0) / 40) : 0;
    const want = reduced() ? 0.15 : st === 'listen' ? 0.25 + mic * 0.9 : st === 'speak' ? 0.35 + Math.min(1, (window.__jvSpeak || 0) * 1.6) * 0.7 : st === 'think' ? 0.45 + Math.sin(t * 5) * 0.12 : st === 'mute' ? 0.05 : 0.12 + Math.sin(t * 1.2) * 0.04;
    energy += (want - energy) * 0.18;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.51, R = faceHalf(W, H) * 1.12;
    // glow behind the head
    const g = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 2.4);
    g.addColorStop(0, rgba(0)); g.addColorStop(0.12, rgba(0.07 + energy * 0.12)); g.addColorStop(0.5, rgba(0.025 + energy * 0.04)); g.addColorStop(1, rgba(0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round';
    const spin = reduced() ? 0 : t * (st === 'think' ? 1.4 : 0.18);
    // fine outer ring with ticks
    ctx.lineWidth = 1; ctx.strokeStyle = rgba(0.16);
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.34, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 90; i++) {
      const a = i / 90 * Math.PI * 2 - spin * 0.35, long = i % 15 === 0, r1 = R * 1.38, r2 = R * (long ? 1.47 : 1.42);
      ctx.strokeStyle = rgba(long ? 0.42 : 0.16); ctx.lineWidth = long ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); ctx.stroke();
    }
    // two arcs turning against each other
    const arc = (r, a0, len, w, alpha) => { ctx.lineWidth = w; ctx.strokeStyle = rgba(alpha); ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + len); ctx.stroke(); };
    arc(R * 1.22, spin, 1.1 + energy * 0.9, 2, 0.55 + energy * 0.3);
    arc(R * 1.22, spin + Math.PI, 0.5 + energy * 0.5, 2, 0.35 + energy * 0.3);
    arc(R * 1.56, -spin * 0.7 + 1.2, 0.7, 1.5, 0.28);
    arc(R * 1.56, -spin * 0.7 + 3.9, 1.6, 1.5, 0.18);
    // the voice ring: a line that moves with sound
    const N = 120, amp = R * 0.11 * energy;
    for (const [k, w, a] of [[1, 6, 0.10], [1, 1.6, 0.75]]) {
      ctx.lineWidth = w; ctx.strokeStyle = rgba(a * (0.4 + energy)); ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const ang = i / N * Math.PI * 2;
        const n = Math.sin(ang * 3 + t * 2.1) * 0.5 + Math.sin(ang * 7 - t * 3.3) * 0.32 + Math.sin(ang * 13 + t * 5.2) * 0.18;
        const r = R * 1.06 + n * amp * k;
        const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    // drifting motes
    for (const m of motes) {
      if (!reduced()) m.a += m.s * 0.03 * (1 + energy * 2);
      const r = R * m.r + Math.sin(t + m.p) * 4, x = cx + Math.cos(m.a) * r, y = cy + Math.sin(m.a) * r * 0.92;
      ctx.fillStyle = rgba((0.18 + 0.25 * Math.sin(t * 1.5 + m.p) ** 2) * (0.5 + energy)); ctx.beginPath(); ctx.arc(x, y, m.z, 0, Math.PI * 2); ctx.fill();
    }
  }
  raf = requestAnimationFrame(frame);
  return { stop: () => cancelAnimationFrame(raf) };
}

export function initUi() {
  if ($('jv-dock')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);

  const aura = el('canvas'); aura.id = 'jv-aura'; aura.setAttribute('aria-hidden', 'true');
  const three = $('three'); if (three && three.parentNode) three.parentNode.insertBefore(aura, three.nextSibling); else document.body.prepend(aura);
  try { createAura(aura); } catch (e) { console.warn('[UI] aura', e); }

  // ---- top bar
  const top = el('div'); top.id = 'jv-top';
  const status = el('div'); status.id = 'jv-status'; status.setAttribute('role', 'status');
  const sig = el('span', 'sig'); sig.setAttribute('aria-hidden', 'true'); sig.append(el('i'), el('i'), el('i'));
  status.append(sig, el('span', '', STATUS.idle));
  const label = status.lastChild;
  const gear = el('button', 'jv-ic'); gear.id = 'jv-gear'; gear.setAttribute('aria-label', 'Settings'); gear.innerHTML = ICON.gear;
  gear.onclick = () => J() && J().openSettings && J().openSettings();
  const shift = el('div'); shift.id = 'jv-shift'; shift.setAttribute('aria-label', 'Shift so far');
  const sTime = el('b'), sMiles = el('b'), sMoney = el('b', 'money');
  shift.append(sTime, sMiles, sMoney);
  top.append(status, el('span', 'jv-sp'), shift, gear);

  const sos = el('div'); sos.id = 'jv-sos'; sos.setAttribute('role', 'alert');
  const sosText = el('span', '', 'SOS is on. Your location goes to your emergency contacts every 5 minutes.'), sosBtn = el('button', '', "I'm safe");
  sosBtn.onclick = async () => { if (J() && J().reg) { const r = await J().reg.exec('im_safe', '{}'); paintSos(); try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(r)); } catch {} } };
  sos.append(sosText, sosBtn);

  // ---- greeting
  const hello = el('div'); hello.id = 'jv-hello';
  const hG = el('div', 'g'), hN = el('div', 'n'), hD = el('div', 'd');
  hello.append(hG, hN, hD);
  const paintHello = () => {
    const d = new Date(), name = (J() && J().config && String(J().config.get('user_name', '') || '').trim()) || '';
    hG.textContent = greeting(d.getHours()) + (name ? ',' : '');
    hN.textContent = name || 'I’m listening.';
    hD.textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ');
  };

  // ---- the answer card (#jv-cap stays as its id so older code and tests still find it)
  const card = el('div'); card.id = 'jv-card';
  const cap = el('div'); cap.id = 'jv-cap'; cap.style.display = 'contents';
  const you = el('div', 'you'), scroll = el('div', 'scroll'), heard = el('div', 'heard'), him = el('div', 'him'), note = el('div', 'note');
  note.hidden = true;
  const wait = el('div', 'wait'); const waitText = el('span', '', 'Listening…'); wait.append(waitText, el('b'));
  const x = el('button', 'x'); x.setAttribute('aria-label', 'Hide this answer'); x.innerHTML = ICON.x;
  scroll.append(heard, wait, him);
  cap.append(you, scroll, note);
  card.append(cap, x);

  // ---- toast
  const toast = el('div'); toast.id = 'jv-toast'; toast.setAttribute('role', 'status'); toast.innerHTML = ICON.bell; const toastText = el('span'); toast.append(toastText);

  // ---- things to try
  const chips = el('div'); chips.id = 'jv-chips'; chips.setAttribute('aria-label', 'Things to try');

  // ---- dock
  const dock = el('div'); dock.id = 'jv-dock';
  const mute = el('button', 'jv-ic'); mute.id = 'jv-mute'; mute.setAttribute('aria-label', 'Mute microphone'); mute.innerHTML = ICON.mute;
  const orb = el('button'); orb.id = 'jv-orb'; orb.setAttribute('aria-label', 'Talk to Jarvis'); orb.innerHTML = ICON.mic;
  const hist = el('button', 'jv-ic'); hist.id = 'jv-hist'; hist.setAttribute('aria-label', 'Conversation'); hist.innerHTML = ICON.hist;
  dock.append(mute, orb, hist);

  // ---- history header
  const hh = el('div'); hh.id = 'jv-hist-head';
  const hClear = el('button', '', 'Clear'), hClose = el('button', '', 'Done');
  hh.append(el('h2', '', 'Conversation'), hClear, hClose);

  document.body.append(sos, top, hello, card, toast, chips, dock, hh);

  // ---- actions
  mute.onclick = () => { const b = $('muteBtn'); if (b) b.click(); };
  orb.onclick = () => { if (document.body.classList.contains('st-muted')) { const b = $('muteBtn'); if (b) b.click(); return; } J() && J().wake(); };
  const toggleHist = on => { document.body.classList.toggle('jv-history', on); hist.setAttribute('aria-pressed', String(document.body.classList.contains('jv-history'))); const l = $('log'); if (l) l.scrollTop = l.scrollHeight; };
  hist.onclick = () => toggleHist(!document.body.classList.contains('jv-history'));
  hClose.onclick = () => toggleHist(false);
  hClear.onclick = () => { const b = $('clearBtn'); if (b) b.click(); dismissed = Date.now(); paintCard(); };
  let dismissed = 0;
  x.onclick = () => { dismissed = Date.now(); paintCard(); };
  const rp = $('route-panel');
  if (rp) {
    rp.addEventListener('click', () => rp.classList.toggle('jv-folded'));
    // a fresh route card starts folded to one line when the face is on screen (open in the delivery map view)
    new MutationObserver(() => {
      const shown = rp.classList.contains('show');
      document.body.classList.toggle('jv-route', shown && document.body.getAttribute('data-nav') !== 'dash');
      if (shown && !rp._seen) { rp._seen = true; if (!document.body.hasAttribute('data-nav')) rp.classList.add('jv-folded'); }
      if (!shown) rp._seen = false;
    }).observe(rp, { attributes: true, attributeFilter: ['class'] });
  }

  const ask = text => { if (!J()) return; J().wake(); setTimeout(() => J().say(text), 350); };
  let chipsKey = '';
  const paintChips = () => {
    const ordersOn = !!(rp && rp.classList.contains('show')), shiftOn = document.body.classList.contains('on-shift');
    const list = ordersOn ? SUGGEST.orders : shiftOn ? SUGGEST.shift : SUGGEST.idle, key = list.join('|');
    if (key === chipsKey) return; chipsKey = key;
    chips.replaceChildren(...list.map(t => { const b = el('button', '', t); b.type = 'button'; b.onclick = () => ask(t); return b; }));
  };

  // dash layout: the map fills the space between the route card and Jarvis's corner orb, whatever the card's height
  let dashKey = '';
  const dashLayout = () => {
    if (document.body.getAttribute('data-nav') !== 'dash') { dashKey = ''; return; }
    const H = window.innerHeight, root = document.documentElement.style, safeT = parseFloat(getComputedStyle(document.body).getPropertyValue('--safe-t')) || 0;
    const cr = rp && getComputedStyle(rp).display !== 'none' && rp.offsetHeight > 0 ? rp.getBoundingClientRect() : null;
    const topY = Math.round(cr ? cr.bottom + 10 : safeT + 66);
    const dk = dock.getBoundingClientRect(), orbBottom = Math.round(H - dk.top + 10);
    const D = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--orb-d')) || 110;
    const h = Math.max(150, Math.round(H - orbBottom - D - 14 - topY));
    const key = `${topY}|${h}|${orbBottom}`; if (key === dashKey) return; dashKey = key;
    root.setProperty('--dash-top', topY + 'px'); root.setProperty('--dash-h', h + 'px'); root.setProperty('--dash-orb-bottom', orbBottom + 'px');
    window.dispatchEvent(new Event('resize'));                                   // the map and the orb re-fit
  };
  new MutationObserver(() => {
    if (rp) { if (document.body.getAttribute('data-nav') === 'dash') rp.classList.remove('jv-folded');   // the delivery map view shows the whole route
              else if (!document.body.hasAttribute('data-nav') && rp.classList.contains('show')) rp.classList.add('jv-folded'); }   // back to the face: one line
    document.body.classList.toggle('jv-route', !!(rp && rp.classList.contains('show')) && document.body.getAttribute('data-nav') !== 'dash');
    setTimeout(dashLayout, 30); setTimeout(stage, 40); paintChips();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-nav'] });
  if (rp && window.ResizeObserver) new ResizeObserver(() => { dashLayout(); stage(); }).observe(rp);
  window.addEventListener('resize', () => setTimeout(dashLayout, 50));
  setInterval(dashLayout, 1500);

  // the face makes room for the answer card
  let stageKey = '';
  const stage = () => {
    const talking = document.body.classList.contains('jv-talking') && !document.body.hasAttribute('data-nav');
    let topBelow = top.getBoundingClientRect().bottom;
    if (rp && rp.classList.contains('show') && rp.offsetHeight) topBelow = Math.max(topBelow, rp.getBoundingClientRect().bottom);
    const r = talking ? stageFor({ H: window.innerHeight, W: window.innerWidth, cardTop: card.getBoundingClientRect().top, safeTop: topBelow - 52 }) : { ty: 0, s: 1 };
    const key = r.ty + '|' + r.s; if (key === stageKey) return; stageKey = key;
    window.__jvStage = r; window.__jvStageInstant = reduced();
    document.documentElement.style.setProperty('--stage-ty', r.ty + 'px'); document.documentElement.style.setProperty('--stage-s', String(r.s));
  };
  if (window.ResizeObserver) new ResizeObserver(() => stage()).observe(card);
  window.addEventListener('resize', () => setTimeout(stage, 60));

  // what Jarvis is doing right now (the tool he's using), shown instead of "Thinking…"
  let activity = '';
  window.addEventListener('jv-activity', e => {
    activity = (e.detail && (ACTIVITY[e.detail] || '')) || '';
    if (document.body.classList.contains('st-thinking')) { label.textContent = (activity || 'Thinking') + '…'; waitText.textContent = (activity || 'Thinking') + '…'; }
  });

  // shift readout and SOS banner
  const fmtH = ms => { const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const paintShift = () => {
    const s = J() && J().shiftSummary ? J().shiftSummary() : null;
    document.body.classList.toggle('on-shift', !!(s && s.active));
    if (!s || !s.active) return;
    const put = (n, v, u) => { const t = `${v}`; if (n.firstChild && n.firstChild.textContent === t) return; n.textContent = ''; n.append(t, el('small', '', u)); };
    put(sTime, fmtH(Date.now() - s.start), 'on shift'); put(sMiles, s.miles.toFixed(1), 'miles'); put(sMoney, `${s.currency}${Math.round(s.earned)}`, 'earned');
  };
  const paintSos = () => { let on = false; try { on = !!(window.AndroidPhone && window.AndroidPhone.sosActive && window.AndroidPhone.sosActive()); } catch {} document.body.classList.toggle('sos-on', on); };
  const tick = () => { paintShift(); paintSos(); paintHello(); paintChips(); };
  setInterval(tick, 5000); setTimeout(tick, 1500); tick();
  window.addEventListener('jv-refresh', tick);

  // status: mirror the page's own state element
  const stateEl = $('state'); let last = '', lastActive = Date.now();
  const syncState = () => {
    const cls = (stateEl && stateEl.className) || 'idle'; if (cls === last) return; last = cls;
    if (cls !== 'thinking') activity = '';
    if (cls !== 'standby' && cls !== 'idle') lastActive = Date.now();
    document.body.className = document.body.className.replace(/\bst-\S+/g, '').trim() + ' st-' + cls;
    label.textContent = cls === 'thinking' && activity ? activity + '…' : STATUS[cls] || STATUS.standby;
    const muted = cls === 'muted'; mute.classList.toggle('on', muted); mute.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
    paintCard();
  };
  if (stateEl) new MutationObserver(syncState).observe(stateEl, { attributes: true, childList: true, characterData: true, subtree: true });

  // the card: what you said, then Jarvis's whole answer (it scrolls; it's never cut off). It hides by itself a while after he's done.
  const logEl = $('log'); let lastMsgAt = 0, follow = true, toastTimer = 0, lastToast = '';
  scroll.addEventListener('scroll', () => { follow = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24; scroll.classList.toggle('up', scroll.scrollTop > 4); }, { passive: true });
  const showToast = text => {
    if (!text || text === lastToast) return; lastToast = text;
    toastText.textContent = text; toast.classList.add('on'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), Math.min(14000, 5000 + text.length * 60));
  };
  toast.onclick = () => toast.classList.remove('on');
  const paintCard = () => {
    const b = document.body.classList, s = last;
    const listening = (s === 'listening' || s === 'session') && heard.textContent;
    const thinking = s === 'thinking';
    const hasExchange = !!(you.textContent || him.textContent) && lastMsgAt > dismissed;
    const recent = Date.now() - Math.max(lastMsgAt, lastActive) < 25000;
    const active = s === 'thinking' || s === 'speaking' || s === 'listening' || s === 'session';
    const on = listening || thinking || (hasExchange && (active || recent));
    b.toggle('jv-talking', !!on);
    card.classList.toggle('listen', !!listening && !thinking);
    card.classList.toggle('think', thinking && !him.textContent);
    if (thinking && !activity) waitText.textContent = 'Thinking…';
    setTimeout(stage, 30);
  };
  const syncCaps = () => {
    if (!logEl) return;
    const msgs = [...logEl.querySelectorAll('.msg')];
    const lastOf = k => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].classList.contains(k)) return msgs[i]; return null; };
    const u = lastOf('user'), j = lastOf('jarvis'), p = lastOf('proactive');
    const order = m => (m ? msgs.indexOf(m) : -1);
    const body = m => (m.querySelector('.body') || m).textContent;
    const yt = u ? body(u) : '', ht = j && order(j) > order(u) ? body(j) : '';   // empty while Jarvis is working on your question
    if (yt !== you.textContent || ht !== him.textContent) {
      if (yt !== you.textContent) follow = true;
      you.textContent = yt; him.textContent = ht; lastMsgAt = Date.now();
      if (follow) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
    const nt = p && order(p) > Math.max(order(u), order(j)) ? p.textContent : '';
    if (nt !== note.textContent) { note.textContent = nt; showToast(nt); }
    paintCard();
  };
  if (logEl) new MutationObserver(syncCaps).observe(logEl, { childList: true, subtree: true, characterData: true });
  setInterval(paintCard, 4000);                                      // lets the card fade away once a conversation has gone quiet

  // live "heard" line from the page's partial transcript
  const partial = $('partial-text');
  if (partial) new MutationObserver(() => {
    const t = partial.classList.contains('active') && partial.textContent && partial.textContent !== you.textContent ? partial.textContent : '';
    heard.textContent = t; heard.classList.toggle('on', !!t); if (t) lastActive = Date.now(); paintCard();
  }).observe(partial, { attributes: true, childList: true, characterData: true, subtree: true });

  syncState(); syncCaps();

  // mic level drives the orb's glow
  let lvl = 0;
  setInterval(() => {
    const s = J() && J().stats; const target = s ? Math.min(1, Math.sqrt(s.rms || 0) / 45) : 0;
    lvl += (target - lvl) * 0.5; orb.style.setProperty('--lvl', lvl.toFixed(3));
  }, 90);
}
