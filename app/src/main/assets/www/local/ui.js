// ui.js - the phone layout around Jarvis's face.
// One idea runs the whole screen: black and gold, like his particle face. The light changes with what Jarvis is doing (gold
// waiting or talking, bright champagne while he listens, deep amber while he thinks, red when muted). Rings only in Orb mode.
// Around that, as little as possible: a greeting that steps back to the time, a glass card with the answer that clears itself,
// the talk button (tap to talk, hold to mute, swipe up for ideas) and a conversation button. Words appear only when they say something.
// The PC page's own controls stay underneath and keep working; this layer reads and drives them.
const J = () => window.JARVIS;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const CSS = `
@font-face { font-family: 'Saira'; src: url('fonts/Saira.ttf') format('truetype'); font-weight: 100 900; font-stretch: 50% 125%; font-display: swap; }
:root { --abyss: #000; --glass: rgba(24, 18, 10, .62); --glass-hi: rgba(255, 214, 150, .16); --ice: #fff6e8; --mist: #cdbb9f; --dim: #8c7a62;
  --holo: #f5c97a; --live: #ffecbe; --amber: #ff9a3d; --danger: #ff5a67;   /* black and gold, like his face: gold waiting, bright champagne listening, deep amber thinking */
  --state: var(--holo); --safe-t: env(safe-area-inset-top, 0px); --safe-b: env(safe-area-inset-bottom, 0px);
  --ease: cubic-bezier(.2, .8, .2, 1); }
body { background: var(--abyss); }   /* plain black: only his gold dust, no disc behind him */
body.st-session, body.st-listening { --state: var(--live); }
body.st-thinking { --state: var(--amber); }
body.st-muted { --state: var(--danger); }

/* the PC page's own HUD and backdrop: replaced by this layer */
#state, #controls, #mic-level, #partial-text, #debug, #diag, #voice-panel, #cam-indicator, #activate, #log { visibility: hidden; }
#bg-base, #bg-rings, #bg-halo, #bg-floor { display: none; }
body.jv-history #log { visibility: visible; }

/* ---- the aura: rings of light drawn over the face's canvas, around (never across) the face. The face itself lifts and shrinks
   with the 3D camera when the answer card needs room (window.__jvStage); the aura follows with the same move. */
#three, #three canvas { touch-action: none; }   /* a drag on the face turns his head (not the page) */
#jv-aura { position: fixed; inset: 0; z-index: 2; pointer-events: none; transform-origin: 50% 50%; transform: translateY(var(--stage-ty, 0px)) scale(var(--stage-s, 1)); transition: transform .5s var(--ease), opacity .5s; }
body[data-nav] #jv-aura { opacity: 0; }

/* ---- top bar */
#jv-top { position: fixed; z-index: 9; top: calc(var(--safe-t) + 12px); left: 14px; right: 14px; display: flex; align-items: center; gap: 10px; pointer-events: none; }
#jv-top .jv-sp { flex: 1; }
#jv-status { pointer-events: auto; display: none; align-items: center; gap: 10px; height: 40px; padding: 0 16px 0 13px; border-radius: 999px; max-width: 64vw;
  background: var(--glass); border: 1px solid color-mix(in srgb, var(--state) 38%, transparent); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  font: 600 15px/1 'Saira', system-ui, sans-serif; font-stretch: 88%; color: var(--ice); transition: border-color .4s; }
#jv-status > span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.jv-busy #jv-status { display: inline-flex; animation: jvIn .35s var(--ease); }
@keyframes jvIn { from { opacity: 0; transform: translateY(-6px); } }
#jv-clock { pointer-events: none; font: 400 19px/1 'Saira', system-ui, sans-serif; font-stretch: 104%; color: var(--mist); font-variant-numeric: tabular-nums; letter-spacing: .02em;
  padding-left: 6px; transition: opacity .5s var(--ease); }
#jv-clock { display: none; }   /* the phone's status bar already shows the time */
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
body:not(.jv-greet) #jv-hello, body.jv-talking #jv-hello, body[data-nav] #jv-hello, body.jv-route #jv-hello, body.sos-on #jv-hello { opacity: 0; transform: translateY(-14px) scale(.96); transform-origin: 0 0; }

/* ---- the answer card */
#jv-card { position: fixed; z-index: 8; left: 12px; right: 12px; bottom: calc(var(--safe-b) + 116px); max-height: 40vh; display: flex; flex-direction: column;
  border-radius: 24px; background: linear-gradient(180deg, rgba(50, 32, 16, .72), rgba(30, 18, 8, .78)); -webkit-backdrop-filter: blur(22px) saturate(140%); backdrop-filter: blur(22px) saturate(140%);
  border: 1px solid var(--glass-hi); box-shadow: 0 24px 60px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .06);
  opacity: 0; transform: translateY(18px) scale(.98); pointer-events: none; transition: opacity .45s var(--ease), transform .55s var(--ease); }
/* subtitles: no box, just his words under the face, centred, readable over the gold (the delivery screen keeps its card) */
body:not([data-nav="dash"]) #jv-card { background: none; border: 0; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; text-align: center; left: 20px; right: 20px; }
body:not([data-nav="dash"]) #jv-card::before { display: none; }
body:not([data-nav="dash"]) #jv-card .him, body:not([data-nav="dash"]) #jv-card .heard { font-size: 21px; text-shadow: 0 1px 2px #000, 0 2px 14px #000, 0 0 24px rgba(0, 0, 0, .8);
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
body:not([data-nav="dash"]) #jv-card .you { padding: 0 8px 4px; text-shadow: 0 1px 8px #000; }
body:not([data-nav="dash"]) #jv-card .wait { justify-content: center; } body:not([data-nav="dash"]) #jv-card .wait b { max-width: 140px; }
body:not([data-nav="dash"]) #jv-card .scroll { overflow: hidden; padding: 6px 4px 10px; }
#jv-card::before { content: ''; position: absolute; left: 22px; right: 22px; top: -1px; height: 1px; background: linear-gradient(90deg, transparent, var(--state), transparent); opacity: .8; transition: background .4s; }
body.jv-talking #jv-card { opacity: 1; transform: none; pointer-events: auto; }
#jv-card .you { padding: 16px 48px 0 18px; font: 400 14px/1.4 Roboto, system-ui, sans-serif; color: var(--mist); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#jv-card .you:empty, #jv-card.answer .you { display: none; }
#jv-card.answer .scroll { padding-top: 18px; }
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
#jv-card.listen .x, #jv-card.think .x, #jv-card.answer .x { display: none; }   /* it clears itself; a tap on it also clears it */

/* ---- something Jarvis says by himself (a new message, a reminder): a pill under the top bar */
#jv-toast { position: fixed; z-index: 10; top: calc(var(--safe-t) + 64px); left: 14px; right: 14px; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 18px;
  background: rgba(40, 28, 10, .78); border: 1px solid rgba(255, 178, 76, .32); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  font: 400 15px/1.35 Roboto, system-ui, sans-serif; color: #ffe7c2; opacity: 0; transform: translateY(-12px); pointer-events: none; transition: opacity .4s var(--ease), transform .45s var(--ease); }
#jv-toast.on { opacity: 1; transform: none; pointer-events: auto; }
#jv-toast svg { width: 20px; height: 20px; flex: none; color: var(--amber); }
body.sos-on #jv-toast { top: calc(var(--safe-t) + 140px); }

/* ---- ideas: only when asked for (swipe up from the talk button) */
#jv-ideas { position: fixed; z-index: 10; left: 14px; right: 14px; bottom: calc(var(--safe-b) + 112px); display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  opacity: 0; transform: translateY(16px); pointer-events: none; transition: opacity .3s var(--ease), transform .4s var(--ease); }
body.jv-ideas #jv-ideas { opacity: 1; transform: none; pointer-events: auto; }
#jv-ideas button { height: 44px; padding: 0 18px; border-radius: 999px; border: 1px solid var(--glass-hi); background: rgba(24, 18, 10, .82); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  color: var(--ice); font: 500 15px/1 Roboto, system-ui, sans-serif; white-space: nowrap; text-transform: none; letter-spacing: normal; text-shadow: none; }
#jv-ideas button:active { transform: scale(.96); }
body.jv-ideas #jv-card, body.jv-ideas #jv-hint { opacity: 0 !important; pointer-events: none !important; }
#jv-scrim { position: fixed; inset: 0; z-index: 9; display: none; background: linear-gradient(to top, rgba(0, 0, 0, .7), rgba(0, 0, 0, 0) 60%); }
body.jv-ideas #jv-scrim { display: block; }
/* the hint for new users: a small chevron over the talk button */
#jv-hint { position: fixed; z-index: 8; left: 50%; bottom: calc(var(--safe-b) + 104px); transform: translateX(-50%); display: none; flex-direction: column; align-items: center; gap: 2px;
  border: 0; background: none; padding: 6px 14px; color: var(--dim); font: 400 12px/1.2 Roboto, sans-serif; text-transform: none; letter-spacing: normal; text-shadow: none; transition: opacity .4s; }
#jv-hint svg { width: 18px; height: 18px; animation: jvNudge 2.4s ease-in-out infinite; }
@keyframes jvNudge { 0%, 70%, 100% { transform: none; } 80% { transform: translateY(-4px); } }
body.jv-new #jv-hint { display: flex; }
body.jv-talking #jv-hint, body[data-nav] #jv-hint, body.st-muted #jv-hint, body.jv-history #jv-hint { opacity: 0; pointer-events: none; }

/* ---- the talk button in the middle, conversation in the corner */
#jv-dock { position: fixed; z-index: 9; left: 0; right: 0; bottom: calc(var(--safe-b) + 22px); height: 72px; pointer-events: none; }
#jv-dock > * { pointer-events: auto; }
#jv-dock #jv-hist { position: absolute; right: 18px; top: 14px; }
#jv-dock #jv-keys { position: absolute; right: 72px; top: 14px; }
/* ---- typing instead of talking (an address is easier typed than spelled out loud) */
#jv-type { position: fixed; z-index: 11; left: 12px; right: 12px; bottom: calc(var(--safe-b) + 104px); display: none; gap: 8px; align-items: center; padding: 6px 6px 6px 16px;
  border-radius: 28px; border: 1px solid var(--glass-hi); background: rgba(16, 12, 7, .92); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
body.jv-typing #jv-type { display: flex; }
#jv-type input { flex: 1; min-width: 0; height: 44px; border: 0; outline: 0; background: transparent; color: var(--ice); font: 400 16px/1.2 Roboto, sans-serif; }
#jv-type input::placeholder { color: var(--mist); opacity: .75; }
#jv-type button { flex: 0 0 44px; width: 44px; height: 44px; border-radius: 50%; border: 0; display: grid; place-items: center; background: var(--state); color: #120c04; }
#jv-type button svg { width: 22px; height: 22px; }
body[data-nav="full"] #jv-keys, body.jv-drive #jv-keys { display: none; }
#jv-mapback { position: absolute; left: 18px; top: 14px; display: none; align-items: center; gap: 6px; height: 44px; padding: 0 16px; border-radius: 22px;
  border: 1px solid color-mix(in srgb, var(--state) 45%, transparent); background: rgba(10, 7, 3, .78); color: var(--ice); font: 600 14px/1 Roboto, sans-serif; }
body.jv-trip-hidden #jv-mapback { display: inline-flex; }   /* a trip is running behind the face: one tap back to the map */
#jv-orb { position: absolute; left: 50%; top: 0; margin-left: -36px; width: 72px; height: 72px; border-radius: 50%; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; border: 0; padding: 0; display: grid; place-items: center; cursor: pointer;
  background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--state) 24%, #15100a), #060402 72%); color: var(--ice);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--state) 55%, transparent), 0 0 calc(14px + var(--lvl, 0) * 46px) color-mix(in srgb, var(--state) 60%, transparent), 0 10px 26px rgba(0, 0, 0, .5);
  transition: box-shadow .12s linear, transform .15s; -webkit-tap-highlight-color: transparent; }
#jv-orb::before { content: ''; position: absolute; inset: -5px; border-radius: 50%; padding: 2px;
  background: conic-gradient(from var(--spin, 0deg), transparent 0 55%, var(--state) 80%, transparent 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  opacity: 0; transition: opacity .4s; }
body.st-thinking #jv-orb::before, body.st-listening #jv-orb::before, body.st-session #jv-orb::before { opacity: 1; animation: jvSpin 1.6s linear infinite; }
body.st-thinking #jv-orb::before { animation-duration: .8s; }
#jv-orb svg { width: 28px; height: 28px; position: relative; }
#jv-orb:active, #jv-orb.press { transform: scale(.94); }
#jv-orb.hold { transform: scale(1.08); transition: transform .45s var(--ease); }
body.st-muted #jv-orb { background: radial-gradient(circle at 50% 35%, #4a1820, #12070a 72%); }

/* ---- conversation history, as a sheet with bubbles */
#jv-hist-head { position: fixed; z-index: 11; left: 0; right: 0; top: calc(var(--safe-t) + 70px); display: none; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 16px 10px 22px;
  border-radius: 26px 26px 0 0; background: rgba(24, 14, 6, .96); border-top: 1px solid var(--glass-hi); }
#jv-hist-head h2 { flex: 1; margin: 0; font: 600 21px/1 'Saira', sans-serif; font-stretch: 100%; color: var(--ice); }
#jv-hist-head .links { flex-basis: 100%; display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 6px -16px 0 -6px; padding: 0 16px 2px 6px; }
#jv-hist-head .links::-webkit-scrollbar { display: none; }
#jv-hist-head .links button { flex: none; display: inline-flex; align-items: center; gap: 7px; height: 38px; color: var(--ice); background: rgba(245, 201, 122, .08); }
#jv-hist-head .links button svg { width: 17px; height: 17px; color: var(--mist); }
#jv-hist-head::before { content: ''; position: absolute; top: 6px; left: 50%; width: 38px; height: 4px; margin-left: -19px; border-radius: 2px; background: rgba(255,255,255,.18); }
#jv-hist-head button { height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--glass-hi); background: transparent; color: var(--mist); font-size: 14px; }
#jv-hist-head button.ic { width: 36px; padding: 0; display: grid; place-items: center; } #jv-hist-head button.ic svg { width: 19px; height: 19px; }
body.jv-history #jv-hist-head { display: flex; }
body.jv-history #log { position: fixed !important; z-index: 10; left: 0 !important; right: 0 !important; top: calc(var(--safe-t) + 176px) !important; bottom: 0 !important; width: auto !important; max-height: none !important;
  display: flex; flex-direction: column; gap: 10px; padding: 6px 14px calc(var(--safe-b) + 120px); background: rgba(24, 14, 6, .96); -webkit-mask-image: none; mask-image: none; font: 15px/1.45 Roboto, system-ui, sans-serif; }
body.jv-history #log .msg { margin: 0; max-width: 84%; }
body.jv-history #log .who { display: none; }
body.jv-history #log .msg.user { align-self: flex-end; padding: 10px 14px; border-radius: 20px 20px 6px 20px; background: rgba(245, 201, 122, .16); }
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
    background: linear-gradient(180deg, rgba(40, 30, 22, .82), rgba(28, 18, 10, .86)); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 18px 50px rgba(0,0,0,.4); }
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
body[data-nav="full"] #jv-dock { bottom: calc(var(--safe-b) + 110px); }
body[data-nav="full"] #jv-orb { left: auto; right: 12px; margin: 0; width: 58px; height: 58px; }
@media (orientation: portrait) {   /* phone: his head is in the bottom-right corner, so the talk button goes bottom-left */
  body[data-nav="full"] #jv-orb { left: 16px; right: auto; }
  body[data-nav="full"] #jv-toast { top: calc(var(--nb-b, 182px) + 50px); }   /* under the turn banner and its "Then" row, not over them */
  body[data-nav="full"] #nav-orb { pointer-events: auto; cursor: pointer; }   /* tap his head: back to the face (the trip keeps going) */
  body[data-nav="full"] .nb-then { left: 12px !important; top: calc(var(--nb-b, 182px) + 8px) !important; }   /* the PC put it at a fixed 118px, inside the phone's taller banner */
  body[data-nav="full"] #nav-caption { left: 12px; right: 12px; transform: none; max-width: none; bottom: auto; top: auto;
    bottom: calc(100% - var(--orb-cy) + var(--orb-d) / 2 + 12px); }   /* what he's saying sits above his head, not over it */
  body[data-nav] .nav-note, body[data-nav] #nav-badge { display: none !important; }   /* map-provider and GPS labels printed over the trip numbers */
}
#nav-orb { border-color: color-mix(in srgb, var(--state) 70%, transparent) !important; box-shadow: 0 0 22px color-mix(in srgb, var(--state) 45%, transparent) !important; }   /* gold, like the rest */
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
  box-shadow: 0 0 0 1px rgba(245, 201, 122, .22), 0 18px 50px rgba(0, 0, 0, .5); }
body[data-nav="dash"] #three { z-index: 5; pointer-events: none; transform: translate(var(--orb-tx), var(--orb-ty)) scale(var(--orb-s)); clip-path: circle(var(--orb-r) at 50% var(--orb-fy, 50%)); }
body[data-nav="dash"] #nav-orb { opacity: 1; }
body[data-nav="dash"] #route-panel { max-height: 24vh; overflow-y: auto; }
body[data-nav="dash"] #jv-card { right: calc(var(--orb-d, 110px) + 30px); max-height: var(--orb-d, 110px); bottom: var(--dash-orb-bottom, 112px); border-radius: 20px; }
#nav-frame .maplibregl-ctrl-attrib { background: rgba(0, 0, 0, .55) !important; color: var(--dim); font: 9px/1.3 Roboto, sans-serif; border-radius: 8px; margin: 0 6px 6px 0 !important; }
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

/* ---- driving mode: big, glanceable, few things; the face rests (and stops drawing) */
#jv-drive { position: fixed; z-index: 6; left: 14px; right: 14px; top: calc(var(--safe-t) + 12px); bottom: calc(var(--safe-b) + 110px); display: none; flex-direction: column; gap: 12px; color: var(--ice); overflow: hidden;
  font: 400 15px/1.35 Roboto, system-ui, sans-serif; }
body.jv-drive #jv-drive { display: flex; }
body.jv-faceless #three { visibility: hidden; }
body.jv-drive #three, body.jv-drive #jv-aura, body.jv-drive #jv-hello, body.jv-drive #jv-clock, body.jv-drive #jv-hint, body.jv-drive #jv-shift, body.jv-drive #route-panel { visibility: hidden !important; }
body.jv-drive.jv-busy #jv-drive .dv-head { visibility: hidden; }
#jv-drive .dv-head { display: flex; align-items: flex-start; gap: 10px; }
#jv-drive .dv-clock { flex: 1; font: 300 68px/.95 'Saira', system-ui, sans-serif; font-stretch: 100%; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
#jv-drive .dv-clock em { font-style: normal; font-size: 22px; font-weight: 400; color: var(--mist); margin-left: 6px; letter-spacing: 0; }
#jv-drive .dv-clock small { display: block; margin-top: 8px; font: 400 15px/1.3 Roboto, sans-serif; color: var(--mist); letter-spacing: 0; }
#jv-drive .dv-x { width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--glass-hi); background: var(--glass); color: var(--mist); display: grid; place-items: center; padding: 0; flex: none;
  text-transform: none; letter-spacing: normal; text-shadow: none; }
#jv-drive .dv-x svg { width: 22px; height: 22px; }
#jv-drive .dv-card { border-radius: 26px; padding: 18px 18px 16px; background: linear-gradient(180deg, rgba(50, 32, 16, .78), rgba(30, 18, 8, .82)); border: 1px solid var(--glass-hi); }
#jv-drive .dv-kick { display: flex; align-items: center; gap: 8px; font: 500 14px/1 Roboto, sans-serif; color: var(--mist); }
#jv-drive .dv-kick i { width: 10px; height: 10px; border-radius: 50%; background: var(--live); box-shadow: 0 0 10px var(--live); }
#jv-drive .dv-kick i.pick { background: var(--amber); box-shadow: 0 0 10px var(--amber); }
#jv-drive .dv-name { margin-top: 10px; font: 600 32px/1.08 'Saira', sans-serif; font-stretch: 92%; overflow-wrap: anywhere; }
#jv-drive .dv-sub { margin-top: 6px; font-size: 17px; color: var(--mist); }
#jv-drive .dv-sub b { color: var(--ice); font-weight: 600; }
#jv-drive .dv-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
#jv-drive .dv-btns button { height: 62px; border-radius: 18px; border: 1px solid var(--glass-hi); background: rgba(245, 201, 122, .08); color: var(--ice); font: 600 18px/1 Roboto, sans-serif;
  text-transform: none; letter-spacing: normal; text-shadow: none; }
#jv-drive .dv-btns button.go { background: var(--ice); color: #1f1203; border-color: var(--ice); }
#jv-drive .dv-btns button:active { transform: scale(.97); }
#jv-drive .dv-today { cursor: pointer; }
#jv-drive .dv-money { margin-top: 8px; font: 600 54px/1 'Saira', sans-serif; font-variant-numeric: tabular-nums; }
#jv-drive .dv-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 14px; }
#jv-drive .dv-stats b { display: block; font: 600 22px/1.1 'Saira', sans-serif; font-stretch: 90%; font-variant-numeric: tabular-nums; }
#jv-drive .dv-stats span { display: block; font-size: 12px; color: var(--mist); margin-top: 3px; }
#jv-drive .dv-shift { display: flex; gap: 10px; margin-top: auto; }
#jv-drive .dv-shift button { flex: 1; height: 54px; border-radius: 18px; border: 1px solid var(--glass-hi); background: var(--glass); color: var(--ice); font: 500 16px/1 Roboto, sans-serif;
  text-transform: none; letter-spacing: normal; text-shadow: none; }
body.jv-drive #jv-orb { width: 84px; height: 84px; margin-left: -42px; top: -8px; }
body.jv-drive.jv-talking #jv-drive .dv-today, body.jv-drive.jv-talking #jv-drive .dv-shift { visibility: hidden; }

/* ==== home: the cinematic look. His face with halo rings and a gold floor light, the date and what he's doing on top, the greeting
   low, and one talk bar ("Ask or type anything" + the mic) with a grid button for the shortcuts. */
body:not([data-nav]):not(.jv-drive) #jv-clock { display: block !important; }
#jv-clock { white-space: nowrap; font: 500 11.5px/1 Roboto, system-ui, sans-serif; font-stretch: 100%; letter-spacing: .1em; text-transform: uppercase; color: var(--mist); padding-left: 2px; }
body:not([data-nav]):not(.jv-drive) #jv-status { display: inline-flex; height: 32px; padding: 0 13px 0 11px; font: 500 13px/1 Roboto, system-ui, sans-serif; color: var(--holo); }
#jv-floor { position: fixed; z-index: 1; left: 50%; width: 72vw; max-width: 330px; height: 40px; top: var(--face-bottom, 70vh); transform: translate(-50%, -40%);
  border-radius: 50%; background: radial-gradient(ellipse, color-mix(in srgb, var(--state) 34%, transparent), transparent 70%); pointer-events: none; transition: top .5s var(--ease), opacity .5s; }
body[data-nav] #jv-floor, body.jv-drive #jv-floor, body.jv-faceless #jv-floor { opacity: 0; }
#jv-hello { top: auto !important; bottom: calc(var(--safe-b) + 112px + var(--resume-h, 0px)); left: 22px; right: 22px; }
#jv-hello .g { font: 300 15px/1.2 Roboto, system-ui, sans-serif; font-stretch: 100%; color: var(--mist); letter-spacing: .01em; }
#jv-hello .n { font: 300 36px/1.05 'Saira', system-ui, sans-serif; font-stretch: 118%; margin-top: 8px; letter-spacing: -.01em; background: none; color: var(--ice); -webkit-background-clip: initial; background-clip: initial; }
#jv-hello .n em { font-style: normal; font-weight: 600; color: var(--holo); }
#jv-hello .d { display: none; }
body:not(.jv-greet) #jv-hello { opacity: 1; transform: none; }
body.jv-talking #jv-hello, body[data-nav] #jv-hello, body.jv-typing #jv-hello, body.jv-ideas #jv-hello, body.jv-history #jv-hello, body.sos-on #jv-hello { opacity: 0 !important; transform: translateY(8px) !important; }
body:not([data-nav]):not(.jv-drive) #jv-dock { left: 16px; right: 88px; height: 64px; border-radius: 32px; pointer-events: auto;
  background: rgba(24, 18, 10, .62); border: 1px solid var(--glass-hi); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 14px 34px rgba(0, 0, 0, .4); }
body:not([data-nav]):not(.jv-drive) #jv-orb { left: auto; right: 6px; top: 6px; margin: 0; width: 52px; height: 52px; color: #1b1206;
  background: radial-gradient(circle at 50% 35%, #ffe3a6, #e59a2a 72%); box-shadow: 0 0 calc(16px + var(--lvl, 0) * 40px) rgba(245, 185, 79, .55); }
body:not([data-nav]):not(.jv-drive).st-muted #jv-orb { background: radial-gradient(circle at 50% 35%, #ff8a93, #b3303e 72%); color: #fff; }
body:not([data-nav]):not(.jv-drive) #jv-orb svg { width: 24px; height: 24px; }
body:not([data-nav]):not(.jv-drive) #jv-dock #jv-keys { position: absolute; left: 0; top: 0; right: 64px; width: auto; height: 100%; border: 0; border-radius: 32px 0 0 32px;
  background: none; display: flex; align-items: center; justify-content: flex-start; gap: 10px; padding: 0 8px 0 22px; color: var(--mist); font: 400 15px/1 Roboto, system-ui, sans-serif; }
#jv-keys .ask { display: none; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#jv-keys .bars { display: none; margin-left: auto; gap: 3px; align-items: center; }
#jv-keys .bars i { width: 3px; height: 8px; border-radius: 3px; background: var(--holo); opacity: .85; }
body:not([data-nav]):not(.jv-drive) #jv-keys .ask, body:not([data-nav]):not(.jv-drive) #jv-keys .bars { display: inline-flex; }
body:not([data-nav]):not(.jv-drive) #jv-keys > svg { display: none; }
body.st-listening #jv-keys .bars i, body.st-session #jv-keys .bars i, body.st-speaking #jv-keys .bars i { animation: jvBars .9s ease-in-out infinite; }
#jv-keys .bars i:nth-child(2) { animation-delay: -.2s !important; } #jv-keys .bars i:nth-child(3) { animation-delay: -.5s !important; } #jv-keys .bars i:nth-child(4) { animation-delay: -.7s !important; }
@media (max-width: 380px) { #jv-keys .bars { display: none !important; } }   /* a narrow phone keeps the words whole */
#jv-dock #jv-hist { display: none; }   /* the conversation is in the shortcuts now */
#jv-dock #jv-grid { position: absolute; right: -72px; top: 0; width: 64px; height: 64px; border-radius: 22px; color: var(--holo); }
#jv-dock #jv-grid svg { width: 22px; height: 22px; }
body[data-nav] #jv-grid, body.jv-drive #jv-grid { display: none !important; }
body[data-nav="full"] .nav-tools { right: auto; left: 16px; top: auto; bottom: calc(var(--safe-b) + 196px); }   /* above the talk button: the delivery card and his head have the right side */
body[data-nav="full"] .nav-recenter { left: calc((74px + var(--orb-cx, 300px) - var(--orb-d, 100px) / 2) / 2); }   /* centred between the talk button and his head */
/* the shortcuts tray: app-style tiles */
#jv-tray-scrim { position: fixed; inset: 0; z-index: 30; background: rgba(0, 0, 0, .62); opacity: 0; pointer-events: none; transition: opacity .3s; }
#jv-tray { position: fixed; z-index: 31; left: 0; right: 0; bottom: 0; padding: 10px 18px calc(22px + var(--safe-b)); border-radius: 28px 28px 0 0;
  background: linear-gradient(180deg, rgba(34, 26, 15, .97), rgba(14, 11, 7, .99)); border-top: 1px solid rgba(255, 214, 150, .22);
  transform: translateY(105%); transition: transform .4s var(--ease); font-family: Roboto, system-ui, sans-serif; }
body.jv-tray #jv-tray { transform: none; } body.jv-tray #jv-tray-scrim { opacity: 1; pointer-events: auto; }
#jv-tray .grab { width: 40px; height: 4px; border-radius: 4px; background: rgba(255, 236, 190, .25); margin: 0 auto 14px; }
#jv-tray h3 { margin: 0 0 16px; font: 600 19px/1 'Saira', system-ui, sans-serif; font-stretch: 92%; color: var(--ice); text-transform: none; letter-spacing: normal; }
#jv-tray .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px 6px; }
#jv-tray .tiles button { display: flex; flex-direction: column; align-items: center; gap: 7px; border: 0; background: none; padding: 0; color: var(--ice); font: 500 11.5px/1.2 Roboto, sans-serif;
  text-transform: none; letter-spacing: normal; -webkit-tap-highlight-color: transparent; }
#jv-tray .tiles button:active .tile { transform: scale(.92); }
#jv-tray .tile { width: 58px; height: 58px; border-radius: 16px; display: grid; place-items: center; transition: transform .15s;
  box-shadow: 0 6px 16px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .35); }
#jv-tray .tile svg { width: 27px; height: 27px; }
/* orders waiting: one gold tap back to the route */
#jv-resume { position: fixed; z-index: 9; left: 16px; right: 16px; bottom: calc(var(--safe-b) + 100px); height: 50px; border: 0; border-radius: 18px; display: none; align-items: center; gap: 12px; padding: 0 8px 0 14px;
  background: linear-gradient(160deg, #ffe3a6 0%, #f5b94f 45%, #e08a1e 100%); color: #1b1206; font: 700 15px/1 Roboto, system-ui, sans-serif; text-transform: none; letter-spacing: normal;
  box-shadow: 0 10px 26px rgba(240, 164, 58, .3); -webkit-tap-highlight-color: transparent; }
#jv-resume svg { width: 20px; height: 20px; }
#jv-resume .go { margin-left: auto; width: 34px; height: 34px; border-radius: 50%; background: rgba(27, 18, 6, .12); display: grid; place-items: center; }
body.jv-orders:not([data-nav]):not(.jv-drive):not(.jv-talking):not(.jv-typing):not(.dm-open) #jv-resume { display: flex; }
body.jv-orders:not([data-nav]) { --resume-h: 62px; }
/* the delivery card's own buttons: add another order, end the trip */
#route-panel .rp-acts { display: flex; gap: 8px; margin-top: 10px; }
#route-panel .rp-acts button { flex: 1; height: 40px; border-radius: 13px; display: flex; align-items: center; justify-content: center; gap: 7px; font: 600 13.5px/1 Roboto, system-ui, sans-serif;
  text-transform: none; letter-spacing: normal; border: 1px solid rgba(255, 214, 150, .18); background: rgba(255, 236, 190, .06); color: var(--ice); }
#route-panel .rp-acts button svg { width: 16px; height: 16px; }
#route-panel .rp-acts .end { color: #ff8a93; border-color: rgba(255, 90, 103, .38); background: rgba(255, 90, 103, .1); }
#jv-end { position: fixed; z-index: 41; left: 12px; right: 12px; bottom: calc(var(--safe-b) + 12px); padding: 18px; border-radius: 24px; display: none; flex-direction: column; gap: 10px;
  background: linear-gradient(180deg, rgba(34, 26, 15, .98), rgba(14, 11, 7, .99)); border: 1px solid rgba(255, 214, 150, .22); box-shadow: 0 -10px 40px rgba(0, 0, 0, .6); font-family: Roboto, system-ui, sans-serif; }
body.jv-end #jv-end { display: flex; } body.jv-end #jv-tray-scrim { opacity: 1; pointer-events: auto; }
#jv-end h3 { margin: 0; font: 600 19px/1.2 'Saira', system-ui, sans-serif; font-stretch: 92%; color: var(--ice); text-transform: none; letter-spacing: normal; }
#jv-end p { margin: 0 0 4px; font-size: 13.5px; color: var(--mist); }
#jv-end button { height: 52px; border-radius: 16px; border: 1px solid rgba(255, 214, 150, .18); background: rgba(255, 236, 190, .06); color: var(--ice); font: 600 15px/1 Roboto, sans-serif; text-transform: none; letter-spacing: normal; }
#jv-end button.end { background: linear-gradient(160deg, #ff8a93, #d9404f); color: #fff; border: 0; }
#jv-end button.no { background: none; border: 0; color: var(--mist); height: 40px; }

@media (prefers-reduced-motion: reduce) {
  #jv-status .sig i, #jv-orb::before, #jv-card .wait b, #jv-card .heard::after, #jv-hint svg, body.jv-busy #jv-status { animation: none !important; }
  body:not([data-nav]) #three, #jv-aura, #jv-card, #jv-hello, #jv-ideas, #jv-toast { transition: none; }
}
`;

const ICON = {
  keys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.6 5M18.4 12.6c.06-.5.1-1 .1-1.6M12 17.5V21M3 3l18 18"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>',
  go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 21 3l-8.5 18-2-7.5z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z"/><path d="M8.5 10.5h7M8.5 13.5h4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 19V5M4 19h16M8 15v-3M12 15V8M16 15v-5"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
  car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16M4 16h16v3H4z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2.2 2.2 0 0 0 4 0"/></svg>',
};
const STATUS = { idle: 'Starting…', standby: 'Say “Hey Jarvis”', session: 'Listening', listening: 'Listening', thinking: 'Thinking…', speaking: 'Speaking', muted: 'Muted · tap to unmute' };
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

/** How long things stay on screen. */
export const TIMING = { greetMs: 6000, greetAgainAfterMs: 10 * 60000, answerMs: 6000, ideasMs: 12000, holdMs: 520, newUserUses: 8 };

/** "Good evening" for an hour of the day. */
export function greeting(h) { return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

/** How far to lift and shrink the face so it clears the answer card: { ty, s } in px and scale. */
export function faceHalf(W, H) { return W < H ? 0.30 * W : 0.135 * H; }   // the 3D camera keeps the face ~0.6 of the width wide on a portrait phone
// the particle head (chin to crown) as measured at S21 size (360x756): ~0.47 of the width tall each side of its middle (0.5 leaves the sparse chin room), at 0.54 down
export function stageFor({ H, W = H * 0.45, cardTop, safeTop = 0, cy = 0.54 }) {
  if (!cardTop || cardTop >= H) return { ty: 0, s: 1 };
  const hh = W < H ? 0.5 * W : 0.21 * H, topLimit = safeTop + 64, gap = 14;
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
  const COLORS = { holo: [245, 201, 122], live: [255, 236, 190], amber: [255, 154, 61], danger: [255, 90, 103] };
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
    if (!b.contains('jv-faceless')) return;                           // with a face, nothing behind it: just his gold dust in the dark
    // glow behind the orb
    const g = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 2.4);
    g.addColorStop(0, rgba(0)); g.addColorStop(0.12, rgba(0.07 + energy * 0.12)); g.addColorStop(0.5, rgba(0.025 + energy * 0.04)); g.addColorStop(1, rgba(0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    drawOrb(t, cx, cy, R);                                            // no face: a ball of light that breathes and swirls with his voice
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
  const HUES = [[245, 201, 122], [255, 154, 61], [255, 236, 190]];
  function drawOrb(t, cx, cy, R) {
    const still = reduced(), r0 = R * (0.6 + energy * 0.16 + (still ? 0 : Math.sin(t * 1.6) * 0.015));
    const core = ctx.createRadialGradient(cx - r0 * 0.28, cy - r0 * 0.32, r0 * 0.04, cx, cy, r0);
    core.addColorStop(0, `rgba(255,255,255,${0.5 + energy * 0.3})`); core.addColorStop(0.4, rgba(0.42 + energy * 0.25)); core.addColorStop(1, rgba(0.05));
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, r0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r0, 0, Math.PI * 2); ctx.clip(); ctx.globalCompositeOperation = 'lighter';
    HUES.forEach(([r, g, bl], i) => {
      const a = (still ? 0 : t) * (0.45 + i * 0.19) * (i % 2 ? -1 : 1) + i * 2.1, k = r0 * (0.32 + energy * 0.12);
      const x = cx + Math.cos(a) * k, y = cy + Math.sin(a * 1.3) * k;
      const gg = ctx.createRadialGradient(x, y, 0, x, y, r0 * (0.75 + energy * 0.3));
      const mix = (c, j) => Math.round(c * 0.55 + col[j] * 0.45);
      gg.addColorStop(0, `rgba(${mix(r, 0)},${mix(g, 1)},${mix(bl, 2)},${0.32 + energy * 0.3})`); gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg; ctx.fillRect(cx - r0, cy - r0, r0 * 2, r0 * 2);
    });
    ctx.restore();
    ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(0.45 + energy * 0.35); ctx.beginPath(); ctx.arc(cx, cy, r0, 0, Math.PI * 2); ctx.stroke();
  }
  raf = requestAnimationFrame(frame);
  return { stop: () => cancelAnimationFrame(raf) };
}

export function initUi() {
  if ($('jv-dock')) return;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const B = document.body.classList;
  const buzz = k => { try { if (window.AndroidBridge && window.AndroidBridge.vibrate) window.AndroidBridge.vibrate(k); else if (navigator.vibrate) navigator.vibrate(k === 'mute' ? [25, 60, 25] : 20); } catch {} };

  const aura = el('canvas'); aura.id = 'jv-aura'; aura.setAttribute('aria-hidden', 'true');
  const three = $('three'); if (three && three.parentNode) three.parentNode.insertBefore(aura, three.nextSibling); else document.body.prepend(aura);
  try { createAura(aura); } catch (e) { console.warn('[UI] aura', e); }

  // ---- top bar: the time on the left (a status only while he's working or muted), the shift on the right while you work
  const top = el('div'); top.id = 'jv-top';
  const clock = el('div'); clock.id = 'jv-clock'; clock.setAttribute('aria-hidden', 'true');
  const status = el('div'); status.id = 'jv-status'; status.setAttribute('role', 'status');
  const sig = el('span', 'sig'); sig.setAttribute('aria-hidden', 'true'); sig.append(el('i'), el('i'), el('i'));
  status.append(sig, el('span', '', STATUS.idle));
  const label = status.lastChild;
  status.onclick = () => { if (B.contains('st-muted')) toggleMute(); };
  const shift = el('div'); shift.id = 'jv-shift'; shift.setAttribute('aria-label', 'Shift so far');
  const sTime = el('b'), sMiles = el('b'), sMoney = el('b', 'money');
  shift.append(sTime, sMiles, sMoney);
  top.append(clock, status, el('span', 'jv-sp'), shift);

  const sos = el('div'); sos.id = 'jv-sos'; sos.setAttribute('role', 'alert');
  const sosText = el('span', '', 'SOS is on. Your location goes to your emergency contacts every 5 minutes.'), sosBtn = el('button', '', "I'm safe");
  sosBtn.onclick = async () => { if (J() && J().reg) { const r = await J().reg.exec('im_safe', '{}'); paintSos(); try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(r)); } catch {} } };
  sos.append(sosText, sosBtn);

  // ---- greeting: for a few seconds when you open Jarvis, then it steps back to the time
  const hello = el('div'); hello.id = 'jv-hello';
  const hG = el('div', 'g'), hN = el('div', 'n'), hD = el('div', 'd');
  hello.append(hG, hN, hD);
  const timeText = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ');
  const paintHello = () => {
    const d = new Date(), name = (J() && J().config && String(J().config.get('user_name', '') || '').trim()) || '';
    hG.textContent = greeting(d.getHours()) + (name ? ', ' + name : '');
    hN.innerHTML = 'How can I <em>help</em>?';
    clock.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + timeText(d);
  };
  let greetTimer = 0, hiddenAt = 0;
  const greet = () => { paintHello(); B.add('jv-greet'); clearTimeout(greetTimer); greetTimer = setTimeout(() => B.remove('jv-greet'), TIMING.greetMs); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > TIMING.greetAgainAfterMs) greet();
  });

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

  // ---- ideas (on request) and the hint that tells new users about them
  const ideas = el('div'); ideas.id = 'jv-ideas'; ideas.setAttribute('aria-label', 'Things to try');
  const scrim = el('div'); scrim.id = 'jv-scrim';
  const hint = el('button'); hint.id = 'jv-hint'; hint.type = 'button'; hint.innerHTML = ICON.up; hint.append(el('span', '', 'Swipe up for ideas'));

  // ---- the talk button and the conversation button
  const dock = el('div'); dock.id = 'jv-dock';
  const orb = el('button'); orb.id = 'jv-orb'; orb.setAttribute('aria-label', 'Talk to Jarvis. Hold to mute. Swipe up for ideas.'); orb.innerHTML = ICON.mic;
  const hist = el('button', 'jv-ic'); hist.id = 'jv-hist'; hist.setAttribute('aria-label', 'Conversation and settings'); hist.innerHTML = ICON.hist;
  const mapBack = el('button', '', 'Map'); mapBack.id = 'jv-mapback'; mapBack.type = 'button'; mapBack.setAttribute('aria-label', 'Back to the map');
  mapBack.onclick = () => { try { window.JARVIS.navsvc.mapControl('show_map'); } catch {} };
  const keys = el('button', 'jv-ic'); keys.id = 'jv-keys'; keys.type = 'button'; keys.setAttribute('aria-label', 'Type to Jarvis'); keys.innerHTML = ICON.keys;
  keys.innerHTML = ICON.keys + '<span class="ask">Ask or type anything</span><span class="bars"><i></i><i></i><i></i><i></i></span>';
  const grid = el('button', 'jv-ic'); grid.id = 'jv-grid'; grid.type = 'button'; grid.setAttribute('aria-label', 'Shortcuts'); grid.innerHTML = ICON.grid;
  dock.append(orb, keys, hist, mapBack, grid);
  const floor = el('div'); floor.id = 'jv-floor'; floor.setAttribute('aria-hidden', 'true');
  const trayScrim = el('div'); trayScrim.id = 'jv-tray-scrim';
  const tray = el('section'); tray.id = 'jv-tray'; tray.setAttribute('role', 'dialog'); tray.setAttribute('aria-label', 'Shortcuts');
  const tiles = el('div', 'tiles'); tray.append(el('div', 'grab'), el('h3', '', 'Shortcuts'), tiles);
  const resume = el('button'); resume.id = 'jv-resume'; resume.type = 'button';
  const endSheet = el('section'); endSheet.id = 'jv-end'; endSheet.setAttribute('role', 'dialog'); endSheet.setAttribute('aria-label', 'End trip');
  const typeBar = el('form'); typeBar.id = 'jv-type'; typeBar.setAttribute('aria-label', 'Type to Jarvis');
  const typeIn = el('input'); typeIn.type = 'text'; typeIn.placeholder = 'Type a message or an address'; typeIn.setAttribute('enterkeyhint', 'send');
  typeIn.setAttribute('aria-label', 'Message'); typeIn.autocomplete = 'off';
  const typeGo = el('button'); typeGo.type = 'submit'; typeGo.setAttribute('aria-label', 'Send'); typeGo.innerHTML = ICON.send;
  typeBar.append(typeIn, typeGo);

  // ---- conversation sheet: Clear, Settings, Done
  const hh = el('div'); hh.id = 'jv-hist-head';
  const hClear = el('button', '', 'Clear'), hGear = el('button'), hClose = el('button', '', 'Done');
  hGear.id = 'jv-gear'; hGear.innerHTML = ICON.gear; hGear.append('Settings');
  const hEarn = el('button'); hEarn.id = 'jv-go-earn'; hEarn.innerHTML = ICON.chart; hEarn.append('Earnings');
  const hKnow = el('button'); hKnow.id = 'jv-go-know'; hKnow.innerHTML = ICON.person; hKnow.append('What I know');
  const links = el('div', 'links'); links.append(hEarn, hKnow, hGear, hClear);
  hh.append(el('h2', '', 'Conversation'), hClose, links);

  document.body.append(floor, sos, top, hello, card, toast, scrim, ideas, hint, resume, dock, typeBar, hh, trayScrim, tray, endSheet);

  // ---- actions
  const muteBtn = () => $('muteBtn');
  function toggleMute() {
    const b = muteBtn(); if (!b) return;
    const was = B.contains('st-muted'); b.click(); buzz('mute');
    showToast(was ? 'Listening again.' : 'Muted. Hold the button again, or tap here, to unmute.', true);
  }
  const talk = () => { closeIdeas(); if (B.contains('st-muted')) { toggleMute(); return; } J() && J().wake(); };
  // tap: talk. hold: mute or unmute. swipe up: ideas.
  let pd = null, holdTimer = 0;
  const endPress = () => { clearTimeout(holdTimer); orb.classList.remove('press', 'hold'); pd = null; };
  orb.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    pd = { x: e.clientX, y: e.clientY, done: false }; orb.classList.add('press');
    try { orb.setPointerCapture(e.pointerId); } catch {}
    holdTimer = setTimeout(() => { if (!pd || pd.done) return; pd.done = true; orb.classList.add('hold'); toggleMute(); }, TIMING.holdMs);
  });
  orb.addEventListener('pointermove', e => {
    if (!pd || pd.done) return;
    const dx = e.clientX - pd.x, dy = e.clientY - pd.y;
    if (Math.abs(dx) > 14 || Math.abs(dy) > 14) clearTimeout(holdTimer);
    if (dy < -36 && Math.abs(dy) > Math.abs(dx)) { pd.done = true; openIdeas(); }
  });
  orb.addEventListener('pointerup', () => { const p = pd; endPress(); if (p && !p.done) talk(); });
  orb.addEventListener('pointercancel', endPress);
  orb.addEventListener('click', e => { if (e.detail === 0) talk(); });     // keyboard and screen readers (taps are handled above)
  orb.addEventListener('contextmenu', e => e.preventDefault());
  // ---- turn his head: drag the face to look at it from any side (it stays there); double-tap to bring it back to you
  const spin = { yaw: 0, pitch: 0, drag: false }; window.__jvSpin = spin;
  let turn = null, lastTap = 0;
  document.addEventListener('pointerdown', e => {
    if (e.clientY > window.innerHeight * 0.72 || B.contains('jv-history') || B.contains('jv-drive') || B.contains('jv-faceless') || document.body.hasAttribute('data-nav')) return;
    if (e.target.closest && e.target.closest('button, a, input, select, textarea, #jv-card, #jv-ov, #jv-setup, #jv-pane, #route-panel, #jv-ideas, #jv-toast, #jv-top')) return;
    const now = Date.now(); if (now - lastTap < 320) { spin.yaw = 0; spin.pitch = 0; lastTap = 0; turn = null; buzz && buzz('tick'); return; }
    lastTap = now; turn = { x: e.clientX, y: e.clientY, yaw: spin.yaw, pitch: spin.pitch, id: e.pointerId }; spin.drag = true;
  }, { passive: true });
  document.addEventListener('pointermove', e => {
    if (!turn || e.pointerId !== turn.id) return;
    spin.yaw = turn.yaw + (e.clientX - turn.x) * 0.012;                                         // all the way round, any number of times
    spin.pitch = Math.max(-0.75, Math.min(0.75, turn.pitch + (e.clientY - turn.y) * 0.008));   // up and down, short of upside down
  }, { passive: true });
  const endTurn = () => { turn = null; spin.drag = false; };
  document.addEventListener('pointerup', endTurn); document.addEventListener('pointercancel', endTurn);

  // a swipe up from anywhere near the bottom (not on a button or the answer) also shows ideas
  let sw = null;
  document.addEventListener('touchstart', e => {
    const t = e.touches[0]; sw = null;
    if (!t || e.touches.length > 1 || t.clientY < window.innerHeight * 0.72 || B.contains('jv-history') || document.body.hasAttribute('data-nav')) return;
    if (e.target.closest && e.target.closest('button, a, input, select, #jv-card, #jv-ov, #jv-setup, #route-panel')) return;
    sw = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    const t = e.touches[0]; if (!sw || !t) return;
    if (sw.y - t.clientY > 50 && Math.abs(t.clientX - sw.x) < 60) { sw = null; openIdeas(); }
  }, { passive: true });

  const toggleHist = on => { closeIdeas(); B.toggle('jv-history', on); hist.setAttribute('aria-pressed', String(B.contains('jv-history'))); const l = $('log'); if (l) l.scrollTop = l.scrollHeight; };
  hist.onclick = () => toggleHist(!B.contains('jv-history'));
  // typed messages go to Jarvis exactly like spoken ones (same answer, spoken and shown)
  const typing = on => { B.toggle('jv-typing', on); if (on) { closeIdeas(); setTimeout(() => typeIn.focus(), 30); } else typeIn.blur(); };
  keys.onclick = () => typing(!B.contains('jv-typing'));
  typeBar.addEventListener('submit', e => { e.preventDefault(); const t = typeIn.value.trim(); if (!t) return; typeIn.value = ''; typing(false); ask(t); });
  typeIn.addEventListener('keydown', e => { if (e.key === 'Escape') typing(false); });
  typeIn.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== typeIn && !typeIn.value.trim()) B.remove('jv-typing'); }, 150));
  hClose.onclick = () => toggleHist(false);
  hGear.onclick = () => { toggleHist(false); J() && J().openSettings && J().openSettings(); };
  hEarn.onclick = () => { toggleHist(false); J() && J().openEarnings && J().openEarnings(); };
  hKnow.onclick = () => { toggleHist(false); J() && J().openKnows && J().openKnows(); };
  hClear.onclick = () => { const b = $('clearBtn'); if (b) b.click(); dismissed = Date.now(); paintCard(); };
  let dismissed = 0;
  x.onclick = () => { dismissed = Date.now(); paintCard(); };
  card.addEventListener('click', e => { if (card.classList.contains('answer') && !e.target.closest('a')) { dismissed = Date.now(); paintCard(); } });
  const rp = $('route-panel');
  if (rp) {
    rp.addEventListener('click', () => rp.classList.toggle('jv-folded'));
    // a fresh route card starts folded to one line when the face is on screen (open in the delivery map view)
    new MutationObserver(() => {
      const shown = rp.classList.contains('show');
      B.toggle('jv-route', shown && document.body.getAttribute('data-nav') !== 'dash');
      if (shown && !rp._seen) { rp._seen = true; if (!document.body.hasAttribute('data-nav')) rp.classList.add('jv-folded'); }
      if (!shown) rp._seen = false;
    }).observe(rp, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- ideas
  const ask = text => { if (!J()) return; J().wake(); setTimeout(() => J().say(text), 350); };

  // ---- the shortcuts tray (grid button)
  const TILE = (c1, c2, path) => `<span class="tile" style="background:linear-gradient(160deg,${c1},${c2})"><svg viewBox="0 0 24 24" fill="none" stroke="#1b1206" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
  const tray_ = on => { B.toggle('jv-tray', on); if (on) { closeIdeas(); typing(false); } };
  const shortcuts = [
    ['Delivery', '#ffd88a', '#e08a1e', '<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>', () => window.dispatchEvent(new CustomEvent('jv-dmode'))],
    ['Navigate', '#9fe7b8', '#2fa86a', '<path d="M3 11.5 21 3l-8.5 18-2-7.5z"/>', () => { typeIn.value = 'Navigate to '; typing(true); }],
    ['Earnings', '#a9c8ff', '#3d6fe0', '<path d="M5 20V10M12 20V4M19 20v-7"/>', () => J() && J().openEarnings && J().openEarnings()],
    ['Briefing', '#ffb0c8', '#d9477a', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>', () => ask('Give me my briefing')],
    ['Shift', '#c9b4ff', '#7a52e0', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', () => ask(B.contains('on-shift') ? 'End my shift' : 'Start my shift')],
    ['Chat', '#9fe0f0', '#1f9bb8', '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>', () => toggleHist(true)],
    ['What I know', '#ffd2a0', '#e0702e', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', () => J() && J().openKnows && J().openKnows()],
    ['Settings', '#d6d0c4', '#857a68', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>', () => J() && J().openSettings && J().openSettings()],
  ];
  for (const [name, c1, c2, path, go] of shortcuts) {
    const b = el('button'); b.type = 'button'; b.innerHTML = TILE(c1, c2, path); b.append(document.createTextNode(name));
    b.onclick = () => { tray_(false); buzz('tick'); setTimeout(go, 120); }; tiles.append(b);
  }
  grid.onclick = () => tray_(!B.contains('jv-tray'));
  trayScrim.onclick = () => { tray_(false); B.remove('jv-end'); };

  // ---- orders waiting while the face is up: a gold pill back to the route
  const D = () => J() && J().delivery;
  setInterval(() => {
    const n = D() ? D().activeOrders().length : 0; B.toggle('jv-orders', n > 0);
    const t = `${n} order${n !== 1 ? 's' : ''} · Resume route`; if (n && resume.dataset.t !== t) { resume.dataset.t = t; resume.innerHTML = ICON.go + t + `<span class="go">${ICON.next}</span>`; }
  }, 1200);
  resume.onclick = async () => { buzz('tick'); try { const r = await J().navsvc.startDelivery(); if (!/^Navigating/.test(r)) showToast(r); } catch {} };

  // ---- the delivery card: add an order, or end the trip (asks first)
  if (rp) {
    const acts = el('div', 'rp-acts'), addB = el('button'), endB = el('button', 'end');
    addB.type = endB.type = 'button'; addB.innerHTML = ICON.plus + 'Add order'; endB.innerHTML = ICON.x + 'End trip';
    acts.append(addB, endB); rp.append(acts);
    acts.addEventListener('click', e => e.stopPropagation());          // not a fold/unfold tap
    addB.onclick = () => window.dispatchEvent(new CustomEvent('jv-dmode'));
    endB.onclick = () => openEnd();
  }
  function openEnd() {
    const n = D() ? D().activeOrders().length : 0;
    endSheet.innerHTML = '';
    const yes = el('button', 'end', `End trip and clear ${n} order${n !== 1 ? 's' : ''}`), keep = el('button', '', 'Keep orders, hide the map'), no = el('button', 'no', 'Cancel');
    for (const b of [yes, keep, no]) b.type = 'button';
    endSheet.append(el('h3', '', 'End this trip?'), el('p', '', 'Ending clears the orders from your stack. Your earnings so far are kept.'), yes, keep, no);
    yes.onclick = async () => { B.remove('jv-end'); try { const r = await J().reg.exec('clear_deliveries', '{}'); J().navsvc.stop(); showToast('Trip ended. ' + r); } catch {} };
    keep.onclick = async () => { B.remove('jv-end'); try { await J().navsvc.mapControl('hide_map'); } catch {} };
    no.onclick = () => B.remove('jv-end');
    B.add('jv-end'); buzz('tick');
  }
  // a tap on the small map opens it full screen
  window.addEventListener('jv-map-tap', () => { try { J().navsvc.mapControl('show_map'); } catch {} });
  let ideasTimer = 0;
  const ideasList = () => {
    const ordersOn = !!(rp && rp.classList.contains('show')), shiftOn = B.contains('on-shift');
    return ordersOn ? SUGGEST.orders : shiftOn ? SUGGEST.shift : SUGGEST.idle;
  };
  function openIdeas() {
    if (document.body.hasAttribute('data-nav') || B.contains('jv-history')) return;
    ideas.replaceChildren(...ideasList().map(t => { const b = el('button', '', t); b.type = 'button'; b.onclick = () => ask(t); return b; }));
    B.add('jv-ideas'); buzz('tick');
    clearTimeout(ideasTimer); ideasTimer = setTimeout(closeIdeas, TIMING.ideasMs);
  }
  function closeIdeas() { clearTimeout(ideasTimer); B.remove('jv-ideas'); }
  scrim.onclick = closeIdeas; hint.onclick = openIdeas;
  const uses = () => { try { return Number(J().config.get('ui_uses', 0)) || 0; } catch { return 0; } };
  const paintNew = () => B.toggle('jv-new', uses() < TIMING.newUserUses);
  const countUse = () => { try { J().config.set('ui_uses', uses() + 1); } catch {} paintNew(); };
  J().openIdeas = openIdeas; J().uiTiming = TIMING;

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
    B.toggle('jv-route', !!(rp && rp.classList.contains('show')) && document.body.getAttribute('data-nav') !== 'dash');
    if (document.body.hasAttribute('data-nav')) closeIdeas();
    setTimeout(dashLayout, 30); setTimeout(stage, 40);
  }).observe(document.body, { attributes: true, attributeFilter: ['data-nav'] });
  if (rp && window.ResizeObserver) new ResizeObserver(() => { dashLayout(); stage(); }).observe(rp);
  window.addEventListener('resize', () => setTimeout(dashLayout, 50));
  setInterval(dashLayout, 1500);
  // the bottom of the turn banner (long street names wrap it to more lines): the "Then" row and the toast go under it
  let nbSeen = null;
  const nbLayout = nb => { if (nb.offsetHeight) document.documentElement.style.setProperty('--nb-b', Math.round(nb.getBoundingClientRect().bottom) + 'px'); };
  document.addEventListener('click', e => {   // his head in the corner of the map: back to the face
    if (e.target.closest && e.target.closest('#nav-orb') && document.body.getAttribute('data-nav') === 'full') { try { window.JARVIS.navsvc.mapControl('hide_map'); } catch {} }
  });
  setInterval(() => { const N = window.JARVIS && window.JARVIS.navsvc; B.toggle('jv-trip-hidden', !!(N && N.state.active && !N.state.delivery && N.state.view === 'off')); }, 700);
  setInterval(() => { const nb = document.querySelector('.nb'); if (!nb || nb === nbSeen || !window.ResizeObserver) return; nbSeen = nb; new ResizeObserver(() => nbLayout(nb)).observe(nb); nbLayout(nb); }, 1000);

  // the face makes room for the answer card
  let stageKey = '';
  const stage = () => {
    const talking = B.contains('jv-talking') && !document.body.hasAttribute('data-nav');
    let topBelow = top.getBoundingClientRect().bottom;
    if (rp && rp.classList.contains('show') && rp.offsetHeight) topBelow = Math.max(topBelow, rp.getBoundingClientRect().bottom);
    const home = !talking && !document.body.hasAttribute('data-nav') && !B.contains('jv-drive');
    const r = window.__jvPlan ? window.__jvPlan        // delivery mode's sheet sets its own room for the face
      : talking ? stageFor({ H: window.innerHeight, W: window.innerWidth, cardTop: card.getBoundingClientRect().top, safeTop: topBelow - 52 })
      : home ? stageFor({ H: window.innerHeight, W: window.innerWidth, cardTop: hello.getBoundingClientRect().top + 6, safeTop: topBelow - 52 }) : { ty: 0, s: 1 };
    { const H = window.innerHeight, W = window.innerWidth, hh = W < H ? 0.5 * W : 0.21 * H, c = H / 2 + (H * 0.54 - H / 2) * r.s;
      document.documentElement.style.setProperty('--face-bottom', Math.round(c + hh * r.s * 0.92 + r.ty) + 'px'); }
    const key = r.ty + '|' + r.s; if (key === stageKey) return; stageKey = key;
    window.__jvStage = r; window.__jvStageInstant = reduced();
    document.documentElement.style.setProperty('--stage-ty', r.ty + 'px'); document.documentElement.style.setProperty('--stage-s', String(r.s));
  };
  window.__jvRestage = stage;
  setTimeout(stage, 50); setInterval(stage, 1500);   // the greeting moves when the resume pill comes and goes
  if (window.ResizeObserver) new ResizeObserver(() => stage()).observe(card);
  window.addEventListener('resize', () => setTimeout(stage, 60));

  // what Jarvis is doing right now (the tool he's using), shown instead of "Thinking…"
  let activity = '';
  window.addEventListener('jv-activity', e => {
    activity = (e.detail && (ACTIVITY[e.detail] || '')) || '';
    if (B.contains('st-thinking')) { label.textContent = (activity || 'Thinking') + '…'; waitText.textContent = (activity || 'Thinking') + '…'; }
  });

  // shift readout and SOS banner
  const fmtH = ms => { const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const paintShift = () => {
    const s = J() && J().shiftSummary ? J().shiftSummary() : null;
    B.toggle('on-shift', !!(s && s.active));
    if (!s || !s.active) return;
    const put = (n, v, u) => { const t = `${v}`; if (n.firstChild && n.firstChild.textContent === t) return; n.textContent = ''; n.append(t, el('small', '', u)); };
    put(sTime, fmtH(Date.now() - s.start), 'on shift'); put(sMiles, s.miles.toFixed(1), 'miles'); put(sMoney, `${s.currency}${Math.round(s.earned)}`, 'earned');
  };
  const paintSos = () => { let on = false; try { on = !!(window.AndroidPhone && window.AndroidPhone.sosActive && window.AndroidPhone.sosActive()); } catch {} B.toggle('sos-on', on); };
  const tick = () => { paintShift(); paintSos(); paintHello(); };
  setInterval(tick, 5000); setTimeout(tick, 1500); tick();
  window.addEventListener('jv-refresh', tick);

  // status: mirror the page's own state element. The pill shows only while he's working (thinking) or muted.
  const stateEl = $('state'); let last = '', lastActive = Date.now();
  const syncState = () => {
    const cls = (stateEl && stateEl.className) || 'idle'; if (cls === last) return; last = cls;
    if (cls !== 'thinking') activity = '';
    if (cls !== 'standby' && cls !== 'idle' && cls !== 'session') lastActive = Date.now();
    document.body.className = document.body.className.replace(/\bst-\S+/g, '').trim() + ' st-' + cls;
    label.textContent = cls === 'thinking' && activity ? activity + '…' : STATUS[cls] || STATUS.standby;
    B.toggle('jv-busy', cls === 'thinking' || cls === 'muted');
    orb.setAttribute('aria-label', cls === 'muted' ? 'Unmute Jarvis' : 'Talk to Jarvis. Hold to mute. Swipe up for ideas.');
    if (cls === 'listening' || cls === 'thinking') { closeIdeas(); B.remove('jv-greet'); }
    paintCard();
  };
  if (stateEl) new MutationObserver(syncState).observe(stateEl, { attributes: true, childList: true, characterData: true, subtree: true });

  // the card: what you're saying while you say it, then just Jarvis's answer (it scrolls; it's never cut off).
  // It clears itself about ten seconds after he's done.
  const logEl = $('log'); let lastMsgAt = 0, follow = true, toastTimer = 0, lastToast = '';
  scroll.addEventListener('scroll', () => { follow = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24; scroll.classList.toggle('up', scroll.scrollTop > 4); }, { passive: true });
  function showToast(text, force) {
    if (!text || (text === lastToast && !force)) return; lastToast = text;
    toastText.textContent = text; toast.classList.add('on'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), Math.min(14000, 4000 + text.length * 60));
  }
  toast.onclick = () => { toast.classList.remove('on'); if (B.contains('st-muted')) toggleMute(); };
  let toldUpdate = false;                          // once per session: a newer build is waiting in Settings > Updates
  window.addEventListener('jv-update', () => { const u = J().update && J().update.info(); if (u && !toldUpdate && !u.state && u.latest > u.mine) { toldUpdate = true; showToast(`Build ${u.latest} of Jarvis is ready. Open Settings, then Updates.`); } });
  let cardTimer = 0;
  function paintCard() {
    const s = last;
    const listening = (s === 'listening' || s === 'session') && heard.textContent;
    const thinking = s === 'thinking';
    const hasExchange = !!(you.textContent || him.textContent) && lastMsgAt > dismissed;
    const busy = thinking || s === 'speaking' || listening;
    const quietFor = Date.now() - Math.max(lastMsgAt, lastActive);
    const on = listening || thinking || (hasExchange && (busy || quietFor < TIMING.answerMs));
    B.toggle('jv-talking', !!on);
    card.classList.toggle('listen', !!listening && !thinking);
    card.classList.toggle('think', thinking && !him.textContent);
    card.classList.toggle('answer', !listening && !!him.textContent);
    if (thinking && !activity) waitText.textContent = 'Thinking…';
    clearTimeout(cardTimer); if (on && !busy) cardTimer = setTimeout(paintCard, Math.max(200, TIMING.answerMs - quietFor + 50));
    setTimeout(stage, 30);
  }
  let fullHim = '', saying = '';
  window.addEventListener('jv-saying', e => { saying = String(e.detail || '').trim(); syncCaps(); });
  const syncCaps = () => {
    if (!logEl) return;
    const msgs = [...logEl.querySelectorAll('.msg')];
    const lastOf = k => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].classList.contains(k)) return msgs[i]; return null; };
    const u = lastOf('user'), j = lastOf('jarvis'), p = lastOf('proactive');
    const order = m => (m ? msgs.indexOf(m) : -1);
    const body = m => (m.querySelector('.body') || m).textContent;
    const yt = u ? body(u) : '', ht = j && order(j) > order(u) ? body(j) : '';   // empty while Jarvis is working on your question
    if (yt !== you.textContent || ht !== fullHim) {
      if (yt !== you.textContent) { follow = true; if (yt) countUse(); }
      you.textContent = yt; fullHim = ht; lastMsgAt = Date.now();
      if (follow) requestAnimationFrame(() => { scroll.scrollTop = ht ? 0 : scroll.scrollHeight; });
    }
    // subtitles, not a wall of text: only the sentence he's saying now (the whole reply is in the conversation)
    const cap = !ht ? '' : saying && ht.includes(saying) ? saying : (ht.match(/^.+?[.!?](?=\s|$)/) || [ht])[0];
    if (him.textContent !== cap) him.textContent = cap;
    const nt = p && order(p) > Math.max(order(u), order(j)) ? p.textContent : '';
    if (nt !== note.textContent) { note.textContent = nt; showToast(nt); }
    paintCard();
  };
  if (logEl) new MutationObserver(syncCaps).observe(logEl, { childList: true, subtree: true, characterData: true });
  setInterval(paintCard, 3000);

  // live "heard" line from the page's partial transcript
  const partial = $('partial-text');
  if (partial) new MutationObserver(() => {
    const t = partial.classList.contains('active') && partial.textContent && partial.textContent !== you.textContent ? partial.textContent : '';
    heard.textContent = t; heard.classList.toggle('on', !!t); if (t) lastActive = Date.now(); paintCard();
  }).observe(partial, { attributes: true, childList: true, characterData: true, subtree: true });

  // ---- driving mode: on by itself during a shift or while moving (setting "drive_mode": auto | on | off)
  const drive = el('div'); drive.id = 'jv-drive'; drive.setAttribute('aria-label', 'Driving mode');
  const dvClock = el('div', 'dv-clock'), dvTime = el('span'), dvDate = el('small'), dvX = el('button', 'dv-x');
  dvClock.append(dvTime, dvDate);
  dvX.innerHTML = ICON.x; dvX.setAttribute('aria-label', 'Leave driving mode');
  const dvNext = el('div', 'dv-card dv-next'), dvToday = el('div', 'dv-card dv-today'), dvShift = el('div', 'dv-shift');
  dvToday.setAttribute('role', 'button'); dvToday.tabIndex = 0; dvToday.setAttribute('aria-label', 'Open earnings');
  drive.append(el('div', 'dv-head'), dvNext, dvToday, dvShift);
  drive.firstChild.append(dvClock, dvX);
  document.body.insertBefore(drive, dock);
  let plan = null, moving = false, fastSince = 0, slowSince = 0, lastPos = null, watchId = null, snoozeUntil = 0;
  const mode = () => { try { return String(J().config.get('drive_mode', 'auto') || 'auto'); } catch { return 'auto'; } };
  window.addEventListener('jv-msg', e => {
    const m = String(e.detail || ''); if (!m.startsWith('route:')) return;
    try { const p = JSON.parse(m.slice(6)); plan = p && p.ok && (p.stops || []).length ? p : null; } catch { plan = null; }
    paintDrive();
  });
  const hav = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(x)); };
  function onPos(p) {
    const c = p.coords, t = p.timestamp || Date.now(), here = { lat: c.latitude, lon: c.longitude, t, acc: c.accuracy || 999 };
    let v = c.speed != null && Number.isFinite(c.speed) ? c.speed : null;
    if (v == null && lastPos && here.acc < 80 && lastPos.acc < 80 && t - lastPos.t > 3000) v = hav(lastPos, here) / ((t - lastPos.t) / 1000);
    lastPos = here; if (v == null) return;
    if (v > 5) { slowSince = 0; fastSince = fastSince || t; if (t - fastSince > 15000) moving = true; }          // over ~18 km/h for 15 s
    else if (v < 2) { fastSince = 0; slowSince = slowSince || t; if (t - slowSince > 180000) moving = false; }  // stopped for 3 minutes
    paintDrive();
  }
  function watch() {
    const want = mode() === 'auto' && !document.hidden && !B.contains('on-shift') && !!navigator.geolocation;
    if (want && watchId == null) { try { watchId = navigator.geolocation.watchPosition(onPos, () => {}, { enableHighAccuracy: false, maximumAge: 20000, timeout: 60000 }); } catch {} }
    else if (!want && watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch {} watchId = null; }
  }
  const driving = () => {
    const m = mode(); if (m === 'off') return false;
    if (document.body.hasAttribute('data-nav')) return false;                       // the map view has its own driving layout
    if (m === 'on') return true;
    return Date.now() > snoozeUntil && (B.contains('on-shift') || moving);
  };
  dvX.onclick = () => { if (mode() === 'on') J().config.set('drive_mode', 'auto'); snoozeUntil = Date.now() + 30 * 60000; buzz('tick'); paintDrive(); showToast('Driving mode is off for 30 minutes. Say "driving mode" to bring it back.', true); };
  dvToday.onclick = () => J().openEarnings && J().openEarnings('today');
  dvToday.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dvToday.onclick(); } };
  const btn = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = () => { buzz('tick'); fn(); }; return b; };
  let dvKey = '';
  function paintDrive() {
    const on = driving();
    if (on !== B.contains('jv-drive')) {
      B.toggle('jv-drive', on); syncHide();                                          // the 3D face stops drawing: less battery while you drive
      if (on) { closeIdeas(); B.remove('jv-greet'); }
    }
    watch();
    if (!on) return;
    const now = new Date();
    const tt = timeText(now).split(' '); dvTime.textContent = tt[0]; dvTime.append(el('em', '', tt[1] || ''));
    const sh = J() && J().shiftSummary ? J().shiftSummary() : null;
    dvDate.textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + (sh && sh.active ? ` · on shift ${fmtH(Date.now() - sh.start)}` : '');
    const e = J() && J().earningsNow ? J().earningsNow() : null, t = e ? e.today : null, cur = (J().config.get('currency', '$') || '$');
    const stop = plan && plan.stops[0];
    const key = JSON.stringify([stop && [stop.kind, stop.restaurant, stop.short_addr, stop.eta_clock, stop.mins], t && [t.earned, t.orders, Math.round(t.perHour), t.miles.toFixed(1)], sh && sh.active, mode()]);
    if (key === dvKey) return; dvKey = key;
    // next stop, when there are orders (the map view, if it's on, shows them instead)
    dvNext.hidden = !stop; dvNext.replaceChildren();
    if (stop) {
      const pick = stop.kind === 'pickup', kick = el('div', 'dv-kick'); const dot = el('i', pick ? 'pick' : ''); kick.append(dot, `Next · ${pick ? 'Pick up' : 'Drop off'}${plan.stops.length > 1 ? ` · ${plan.stops.length - 1} more after` : ''}`);
      const sub = el('div', 'dv-sub'); sub.append(`${stop.short_addr || ''}${stop.short_addr ? ' · ' : ''}`); const eta = el('b', '', `${stop.mins} min`); sub.append(eta, ` · ${stop.eta_clock}`);
      const btns = el('div', 'dv-btns');
      btns.append(btn(pick ? 'Picked up' : 'Delivered', 'go', () => ask(pick ? 'Picked up' : 'Delivered')), btn('Directions', '', () => ask('Start delivery navigation')));
      dvNext.append(kick, el('div', 'dv-name', pick ? stop.restaurant : (stop.restaurant + ' order')), sub, btns);
    }
    // today's money, big
    dvToday.replaceChildren();
    const kick2 = el('div', 'dv-kick'); kick2.append('Today');
    const money = el('div', 'dv-money', `${cur}${(t ? t.earned : 0).toFixed(2)}`);
    const stats = el('div', 'dv-stats');
    const stat = (v, l) => { const d = el('div'); d.append(el('b', '', v), el('span', '', l)); return d; };
    const km = J().delivery && J().delivery.units === 'km';
    stats.append(stat(String(t ? t.orders : 0), 'orders'), stat(t && t.perHour ? `${cur}${Math.round(t.perHour)}` : '—', 'per hour'),
      stat(t ? (km ? t.miles * 1.609344 : t.miles).toFixed(1) : '0.0', km ? 'km' : 'miles'));
    dvToday.append(kick2, money, stats);
    // shift button
    dvShift.replaceChildren(sh && sh.active ? btn('End shift', '', () => ask('End my shift')) : btn('Start shift', '', () => ask('Start my shift')), btn('Find gas', '', () => ask('Find gas near me')));
  }
  setInterval(paintDrive, 5000);

  // ---- the home-screen widget's two lines: the next stop, or today's pay, or "tap to talk"
  let wKey = '';
  function pushWidget() {
    const b = window.AndroidBridge; if (!b || typeof b.widget !== 'function') return;
    let e = null, sh = null; try { e = J().earningsNow ? J().earningsNow() : null; sh = J().shiftSummary ? J().shiftSummary() : null; } catch {}
    const t = e && e.today, cur = (J().config.get('currency', '$') || '$'), stop = plan && plan.stops[0];
    let o;
    if (stop) o = { line1: stop.kind === 'pickup' ? `Next: pick up at ${stop.restaurant}` : `Next: drop off ${stop.restaurant}`, line2: `${stop.short_addr || ''}${stop.short_addr ? ' · ' : ''}${stop.eta_clock}`, open: '' };
    else if (t && (t.orders || (sh && sh.active))) o = { line1: `Today ${cur}${t.earned.toFixed(2)}`, line2: `${t.orders} order${t.orders !== 1 ? 's' : ''}${t.perHour ? ` · ${cur}${Math.round(t.perHour)}/hr` : ''}${sh && sh.active ? ` · on shift ${fmtH(Date.now() - sh.start)}` : ''}`, open: 'earnings' };
    else o = { line1: 'Tap to talk', line2: 'Or say “Hey Jarvis” any time', open: '' };
    const k = JSON.stringify(o); if (k === wKey) return; wKey = k;
    try { b.widget(k); } catch {}
  }
  setInterval(pushWidget, 5000); setTimeout(pushWidget, 2500);
  window.addEventListener('jv-msg', e => { if (String(e.detail || '').startsWith('route:')) setTimeout(pushWidget, 50); });
  window.addEventListener('jv-refresh', () => { dvKey = ''; paintDrive(); });
  document.addEventListener('visibilitychange', () => { watch(); });
  new MutationObserver(() => paintDrive()).observe(document.body, { attributes: true, attributeFilter: ['data-nav'] });

  // ---- no face ("Orb"): the aura draws a ball of light and the 3D face stops drawing
  function syncHide() { window.__jvHideFace = B.contains('jv-drive') || B.contains('jv-faceless'); }
  const paintFace = () => { let orbOn = false; try { orbOn = J().config.get('face', '') === 'orb'; } catch {} B.toggle('jv-faceless', orbOn); syncHide(); };
  window.addEventListener('jv-face', paintFace); paintFace();

  syncState(); syncCaps(); paintNew(); greet(); setTimeout(paintDrive, 1600);

  // mic level drives the orb's glow
  let lvl = 0;
  setInterval(() => {
    const s = J() && J().stats; const target = s ? Math.min(1, Math.sqrt(s.rms || 0) / 45) : 0;
    lvl += (target - lvl) * 0.5; orb.style.setProperty('--lvl', lvl.toFixed(3));
  }, 90);
}
