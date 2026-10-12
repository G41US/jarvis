// tools_phone.js - what Jarvis can do with the phone itself: reminders, timers and alarms that ring even when he's closed,
// websites and YouTube, his eyes (camera and screen), phone control (tap, type, scroll, back, home), flashlight, volume,
// Do Not Disturb, settings, contacts, calls and texts, notifications, calendar, clipboard and documents.
// Native pieces live in PhoneActions.java (window.AndroidPhone); in a plain browser the tools fall back gracefully.
import { snap } from './camera.js';

export const VISION_MODEL = 'qwen/qwen3.8-27b';
const fixSpace = s => String(s).replace(/[  ]/g, ' ');
const clock = ms => fixSpace(new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
const dayWord = ms => {
  const d = new Date(ms), now = new Date(), t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), dd = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0) / 86400000);
  return dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : dd > 1 && dd < 7 ? 'on ' + d.toLocaleDateString('en-US', { weekday: 'long' }) : 'on ' + d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};
const when = ms => `${clock(ms)} ${dayWord(ms)}`;

/** "2026-10-13T08:00", "2026-10-13 8:00", "08:00", "8:30 pm" (local) -> epoch ms; times alone mean the next time it comes round. */
export function parseLocal(s, now = new Date()) {
  const t = String(s || '').trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s]+(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?)?/.exec(t);
  if (m) {
    let h = m[4] ? parseInt(m[4], 10) : 9; const mi = m[5] ? parseInt(m[5], 10) : 0;
    if (m[6] === 'pm' && h < 12) h += 12; if (m[6] === 'am' && h === 12) h = 0;
    return new Date(+m[1], +m[2] - 1, +m[3], h, mi, 0, 0).getTime();
  }
  m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (m && (m[2] || m[3])) {
    let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0, ap = (m[3] || '').replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    const d = new Date(now); d.setHours(h, mi, 0, 0); if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); return d.getTime();
  }
  return null;
}

export function registerPhoneTools(ctx) {
  const { reg, kv, broadcast, config, api, parseWhen } = ctx;
  const W = typeof window !== 'undefined' ? window : {};
  const P = () => W.AndroidPhone || null;
  const has = m => !!(P() && typeof P()[m] === 'function');
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const call = (m, ...args) => { try { return has(m) ? P()[m](...args) : null; } catch (e) { console.warn('[PHONE]', m, e); return null; } };
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };

  // ---- permissions: a tool that needs one asks for it and tells the user what to do
  const NEED = {
    contacts: ['contacts', 'I need permission to read your contacts for that. Tap Allow, then ask me again.'],
    calendar: ['calendar', 'I need access to your calendar. Tap Allow, then ask me again.'],
    camera: ['camera', 'I need the camera for that. Tap Allow, then ask me again.'],
    notifAccess: ['notifAccess', "I need notification access to read your messages. I've opened the setting: switch on Jarvis notifications, then ask me again."],
    control: ['control', "That needs Jarvis phone control. I've opened Accessibility: tap Jarvis phone control, switch it on, then ask me again."],
    dnd: ['dnd', "Android needs Do Not Disturb access for that. I've opened the setting: allow Jarvis, then ask me again."],
    brightness: ['brightness', "Android needs permission to change system settings for that. I've opened it: allow Jarvis, then ask me again."],
  };
  const needed = r => { const m = /^need-(\w+)/.exec(String(r || '')); if (!m || !NEED[m[1]]) return null; call('request', NEED[m[1]][0]); return NEED[m[1]][1]; };
  const opened = (r, what) => r === 'notified' ? `I've put ${what} in your notifications. Tap it to open; to skip this step, switch on "Open apps from the background" in my settings.` : r === 'failed' ? `I couldn't open ${what}.` : null;
  const openUrl = (url, what) => { const r = W.AndroidBridge && W.AndroidBridge.openUrl ? W.AndroidBridge.openUrl(url) : (W.open && W.open(url, '_blank'), 'ok'); return opened(r, what) || 'ok'; };

  // ================================================================== reminders, timers, alarms
  const native = () => has('reminderAdd');
  const localList = () => kv.get('reminders', []);
  function addItem(item) {
    if (native()) return call('reminderAdd', JSON.stringify(item)) || 'error';
    const l = localList(); l.push({ ...item, fired: false }); kv.set('reminders', l); return 'local';
  }
  function items() {
    if (native()) return (parse(call('reminderList')) || []).sort((a, b) => a.at - b.at);
    return localList().filter(r => !r.fired).sort((a, b) => a.at - b.at);
  }
  function cancelItem(id) {
    if (native()) return !!call('reminderCancel', id);
    const l = localList(), n = l.length; kv.set('reminders', l.filter(r => r.id !== id)); return l.length !== n;
  }
  const lateNote = r => (r === 'inexact' && !kv.get('told_exact', false) ? (kv.set('told_exact', true), ' Android may ring it a few minutes late until you allow "Alarms and reminders" for me in Settings, under Phone powers.') : '');
  function resolveAt(a, now = new Date()) {
    if (a.in_minutes != null && a.in_minutes !== '' && Number.isFinite(Number(a.in_minutes))) return now.getTime() + Number(a.in_minutes) * 60000;
    if (a.at) { const t = parseLocal(a.at, now); if (t) return t; }
    if (a.when) { const p = parseWhen(a.when, now); if (p) return p.at; const t = parseLocal(a.when, now); if (t) return t; }
    return null;
  }

  T('set_reminder', "Set a reminder. Give `at` as local date-time 'YYYY-MM-DDTHH:MM' (work it out from the current time in your instructions), or `in_minutes`. repeat: daily, weekdays or weekly. It rings with a notification even when Jarvis is closed.",
    { text: { type: 'string', description: 'what to remind about' }, at: { type: 'string' }, in_minutes: { type: 'number' }, when: { type: 'string', description: 'natural time, only if you cannot give at or in_minutes' }, repeat: { type: 'string', enum: ['', 'daily', 'weekdays', 'weekly'] } },
    ['text'], a => {
      const at = resolveAt(a); if (!at) return `I couldn't tell when. Say a time, like 5 pm or in 20 minutes.`;
      if (at < Date.now() - 60000) return "That time has already passed. When should I remind you?";
      const repeat = ['daily', 'weekdays', 'weekly'].includes(a.repeat) ? a.repeat : '';
      const r = addItem({ id: 'r' + Date.now().toString(36), at, kind: 'reminder', text: String(a.text || '').trim() || 'your reminder', repeat });
      if (r === 'error') return "I couldn't set that reminder.";
      const mins = Math.round((at - Date.now()) / 60000);
      const t = mins < 60 && !repeat ? `in ${mins <= 1 ? 'a minute' : mins + ' minutes'}` : `for ${when(at)}`;
      return `Reminder set ${t}${repeat ? ', repeating ' + (repeat === 'weekdays' ? 'on weekdays' : repeat) : ''}: ${a.text}.` + lateNote(r);
    });
  T('list_reminders', 'List pending reminders and timers.', {}, [], () => {
    const l = items(); if (!l.length) return 'No reminders or timers.';
    return l.slice(0, 10).map((r, i) => `${i + 1}. ${r.kind === 'timer' ? (r.text && r.text !== 'timer' ? r.text + ' timer' : 'Timer') + ' ends' : r.text} ${when(r.at)}${r.repeat ? ' (' + r.repeat + ')' : ''}`).join('. ') + '.';
  });
  T('cancel_reminder', "Cancel a reminder or timer: its number from list_reminders, words from its text, 'timer', or 'all'.", { which: { type: 'string' } }, ['which'], a => {
    const l = items(), w = String(a.which || '').toLowerCase().trim(); if (!l.length) return 'There are no reminders to cancel.';
    let pick = [];
    if (w === 'all' || w === 'everything') pick = l;
    else if (/^\d+$/.test(w)) pick = l[+w - 1] ? [l[+w - 1]] : [];
    else if (/^(the )?timers?$/.test(w)) pick = l.filter(r => r.kind === 'timer');
    else pick = l.filter(r => String(r.text || '').toLowerCase().includes(w.replace(/^(the|my)\s+/, '')));
    if (!pick.length) return `I don't see a reminder matching ${a.which}.`;
    pick.forEach(r => cancelItem(r.id));
    return pick.length === 1 ? `Cancelled: ${pick[0].kind === 'timer' ? 'the timer' : pick[0].text}.` : `Cancelled ${pick.length}.`;
  });
  T('set_timer', 'Set a countdown timer in seconds. It rings even if Jarvis is closed.', { seconds: { type: 'integer' }, label: { type: 'string' } }, ['seconds'], a => {
    const s = parseInt(a.seconds, 10); if (!Number.isFinite(s)) return 'Invalid duration.'; if (s <= 0) return 'Duration must be positive.'; if (s > 86400) return 'I can do up to 24 hours.';
    const r = addItem({ id: 't' + Date.now().toString(36), at: Date.now() + s * 1000, kind: 'timer', text: String(a.label || 'timer'), repeat: '' });
    if (r === 'error') return "I couldn't start the timer.";
    let txt;
    if (s < 60) txt = `Timer set for ${s} seconds.`;
    else if (s < 3600) { const m = Math.floor(s / 60), rr = s % 60; txt = `Timer set for ${m} minute${m !== 1 ? 's' : ''}` + (rr ? ` ${rr} seconds.` : '.'); }
    else { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); txt = `Timer set for ${h} hour${h !== 1 ? 's' : ''}` + (m ? ` ${m} minutes.` : '.'); }
    return txt + lateNote(r);
  });
  T('set_alarm', "Set a wake-up alarm in the phone's Clock app. time: 24-hour 'HH:MM'. days: optional, e.g. 'mon,tue,wed,thu,fri'.", { time: { type: 'string' }, label: { type: 'string' }, days: { type: 'string' } }, ['time'], a => {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(a.time || '')); if (!m) return 'What time should the alarm be?';
    let h = +m[1]; const mi = m[2] ? +m[2] : 0, ap = (m[3] || '').toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (!has('clockAlarm')) return "I can only set Clock alarms on the phone. I can set a reminder instead.";
    const r = call('clockAlarm', h, mi, String(a.label || ''), String(a.days || ''));
    if (r === 'no-clock') return "I can't find a Clock app. I'll set a reminder instead if you like.";
    const o = opened(r, 'the alarm'); if (o) return o;
    const d = new Date(); d.setHours(h, mi, 0, 0);
    return `Alarm set for ${clock(d.getTime())}${a.days ? ' on ' + a.days : ''} in your Clock app.`;
  });
  T('show_alarms', "Open the Clock app's alarm list.", {}, [], () => opened(call('showClockAlarms'), 'your alarms') || 'Here are your alarms.');

  // fallback ticking (browser, tests): native alarms ring through __jvAlarm instead
  if (!native()) {
    const iv = setInterval(() => {
      const now = Date.now(), l = localList(); let ch = false;
      for (const r of l) if (!r.fired && r.at <= now) { r.fired = true; ch = true; broadcast(r.kind === 'timer' ? 'timer:' + (r.text || 'timer') : 'proactive:Reminder. ' + r.text); }
      if (ch) kv.set('reminders', l.filter(r => !r.fired || now - r.at < 86400000));
    }, 1000);
    ctx.stopTimers = () => clearInterval(iv);
  }
  W.__jvAlarm = (json, visible) => {
    const r = parse(json); if (!r || !visible) return;                               // in the background the app speaks it natively
    broadcast(r.kind === 'timer' ? 'timer:' + (r.text || 'timer') : 'proactive:Reminder. ' + (r.text || ''));
  };

  // ================================================================== websites, search, YouTube, live cams
  const SITES = { youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com', facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com',
    x: 'https://x.com', twitter: 'https://x.com', tiktok: 'https://www.tiktok.com', linkedin: 'https://www.linkedin.com', reddit: 'https://www.reddit.com', amazon: 'https://www.amazon.com',
    netflix: 'https://www.netflix.com', wikipedia: 'https://en.wikipedia.org', whatsapp: 'https://web.whatsapp.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', github: 'https://github.com',
    espn: 'https://www.espn.com', cnn: 'https://www.cnn.com', bbc: 'https://www.bbc.com', weather: 'https://weather.com', 'doordash': 'https://www.doordash.com', 'uber eats': 'https://www.ubereats.com' };
  T('open_website', "Open a website in the browser (or its app). Give a URL or a site's name.", { site: { type: 'string' } }, ['site'], a => {
    const s = String(a.site || '').trim(); if (!s) return 'Which website?';
    const key = s.toLowerCase().replace(/^(the )?/, '').replace(/\.com$/, '').trim();
    let url = SITES[key] || (/^https?:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) ? 'https://' + s : 'https://www.google.com/search?btnI=1&q=' + encodeURIComponent(s));
    const r = openUrl(url, s); return r === 'ok' ? `Opening ${s}.` : r;
  });
  T('search_in_browser', 'Show Google search results in the browser (when the user wants to see results, not hear an answer).', { query: { type: 'string' } }, ['query'], a => {
    const r = openUrl('https://www.google.com/search?q=' + encodeURIComponent(a.query || ''), 'the search'); return r === 'ok' ? `Searching for ${a.query}.` : r;
  });
  T('play_youtube', 'Search YouTube for a video, song or channel and open it.', { query: { type: 'string' } }, ['query'], a => {
    const r = openUrl('https://www.youtube.com/results?search_query=' + encodeURIComponent(a.query || ''), 'YouTube'); return r === 'ok' ? `Opening YouTube for ${a.query}.` : r;
  });
  const CAMS = { 'times square': 'https://www.earthcam.com/usa/newyork/timessquare/?cam=tsstreet', london: 'https://www.earthcam.com/world/england/london/abbeyroad/?cam=abbeyroad', tokyo: 'https://www.earthcam.com/world/japan/tokyo/shibuya/?cam=shibuya',
    paris: 'https://www.earthcam.com/world/france/paris/?cam=eiffeltower', rome: 'https://www.earthcam.com/world/italy/rome/?cam=colosseo', sydney: 'https://www.earthcam.com/world/australia/sydney/?cam=sydney',
    miami: 'https://www.earthcam.com/usa/florida/miami/?cam=miamibeach', 'las vegas': 'https://www.earthcam.com/usa/nevada/lasvegas/?cam=vegas', 'new york': 'https://www.earthcam.com/usa/newyork/timessquare/?cam=tsstreet' };
  T('show_public_cam', 'Open a live public webcam of a place.', { location: { type: 'string' } }, ['location'], a => {
    const k = String(a.location || '').toLowerCase().trim(); const hit = Object.keys(CAMS).find(n => k.includes(n) || n.includes(k));
    if (hit) { const r = openUrl(CAMS[hit], 'the live cam'); return r === 'ok' ? `Opening a live view of ${hit}.` : r; }
    const r = openUrl('https://www.youtube.com/results?search_query=' + encodeURIComponent(a.location + ' live cam') + '&sp=EgJAAQ%253D%253D', 'the live cams'); return r === 'ok' ? `Looking for live cams of ${a.location}.` : r;
  });

  // ================================================================== eyes: camera and screen
  async function see(dataUrl, question, what) {
    const sys = `You are the eyes of Jarvis, a voice assistant. You are looking at ${what}. Answer the question for someone who will HEAR your answer: plain sentences, no markdown, no lists, at most four sentences unless they asked you to read text out, then read it faithfully. If you can't tell, say so.`;
    const body = { model: VISION_MODEL, max_tokens: 700, messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text: question || 'What do you see?' }, { type: 'image_url', image_url: { url: dataUrl } }] }] };
    try {
      const r = await api.fetch('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const t = await r.text(); if (!r.ok) { console.warn('[VISION]', r.status, t.slice(0, 200)); return r.status === 429 ? "My eyes are rate-limited for a moment. Try again shortly." : "I couldn't make sense of the picture just now."; }
      const j = JSON.parse(t), m = j.choices && j.choices[0] && j.choices[0].message;
      return String((m && m.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || "I couldn't make that out.";
    } catch (e) { console.warn('[VISION]', e); return "I couldn't reach my eyes. Check the data connection."; }
  }
  async function onScreenForCamera() {
    if (!has('isVisible') || P().isVisible()) return true;
    const r = call('bringToFront'); if (r !== 'ok') return false;
    for (let i = 0; i < 20; i++) { await new Promise(res => setTimeout(res, 100)); if (P().isVisible()) { await new Promise(res => setTimeout(res, 400)); return true; } }
    return false;
  }
  async function shoot(facing, label) {
    if (!(await onScreenForCamera())) return { ok: false, error: 'background' };
    const shot = await snap({ facing, label });
    if (!shot.ok && shot.error === 'denied') call('request', 'camera');
    return shot;
  }
  const camFail = e => e === 'background' ? "Open me first: Android only lets me use the camera while I'm on screen." : e === 'denied' ? NEED.camera[1] : e === 'nocamera' ? "I can't find a camera on this phone." : e === 'cancelled' ? 'Cancelled.' : e === 'busy' ? "I'm already using the camera." : "The camera didn't work just now.";
  T('look_with_camera', "Jarvis's eyes: take a picture with the phone camera and answer a question about it (what is this, read this sign or label, what colour, how many, describe the scene, who is this). camera: back (default) or front (selfie / 'look at me').",
    { question: { type: 'string' }, camera: { type: 'string', enum: ['back', 'front'] } }, [], async a => {
      const shot = await shoot(a.camera === 'front' ? 'user' : 'environment', 'Looking…'); if (!shot.ok) return camFail(shot.error);
      return see(shot.dataUrl, a.question || 'What is this? Describe what matters.', 'a photo just taken with the phone camera');
    });
  T('take_photo', 'Take a photo with the phone camera and save it to the gallery (Pictures/Jarvis). camera: back or front.', { camera: { type: 'string', enum: ['back', 'front'] } }, [], async a => {
    const shot = await shoot(a.camera === 'front' ? 'user' : 'environment', 'Smile…'); if (!shot.ok) return camFail(shot.error);
    const name = call('photoSave', shot.dataUrl); return name ? `Photo saved to your gallery, in the Jarvis album.` : "I took it but couldn't save it.";
  });
  T('open_camera_app', "Open the phone's own camera app. mode: photo, video or selfie.", { mode: { type: 'string', enum: ['photo', 'video', 'selfie'] } }, [], a => opened(call('openCamera', a.mode || 'photo'), 'the camera') || 'Camera open.');

  const control = (m, ...args) => { if (!has(m)) return "I can only do that on the phone."; const r = call(m, ...args); return needed(r) || (r === 'starting' ? 'Phone control is starting. Ask me again in a second.' : r); };
  T('look_at_screen', "Look at what's on the phone's screen right now (a screenshot) and answer a question about it. Needs Jarvis phone control.", { question: { type: 'string' } }, [], async a => {
    if (!has('screenshot')) return "I can only see the screen on the phone.";
    const r = call('screenshot'); const n = needed(r); if (n) return n;
    if (r === 'starting') return 'Phone control is starting. Ask me again in a second.';
    if (r === 'old-android') { const txt = call('screenRead'); return needed(txt) || txt; }
    if (!r) return "The screenshot didn't work. That app may block screenshots.";
    return see('data:image/jpeg;base64,' + r, a.question || "What's on the screen? Summarise what matters.", "a screenshot of the user's phone screen");
  });
  T('read_screen', "Read the text and buttons on the phone's screen as a numbered list. Use before tapping or typing, and after each step to see what changed.", {}, [], () => control('screenRead'));
  T('tap_on_screen', 'Tap a button or item on the screen: its [number] from read_screen, or its text.', { target: { type: 'string' }, long_press: { type: 'boolean' } }, ['target'], a => control('screenTap', String(a.target), !!a.long_press));
  T('type_on_screen', 'Type text into a box on the screen (the focused one, or the field named or numbered). submit: press enter/search afterwards.', { text: { type: 'string' }, field: { type: 'string' }, submit: { type: 'boolean' } }, ['text'], a => control('screenType', String(a.text), String(a.field || ''), !!a.submit));
  T('scroll_screen', 'Scroll the screen: down, up, left or right.', { direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] } }, ['direction'], a => control('screenScroll', a.direction));
  T('press_button', 'Press a phone button: back, home, recents, notifications, quick_settings, lock, screenshot, power.', { button: { type: 'string' } }, ['button'], a => control('press', String(a.button)));

  // ================================================================== device
  const dev = (m, ...args) => { if (!has(m)) return "I can only do that on the phone."; const r = call(m, ...args); return needed(r) || opened(r, 'that') || r; };
  T('flashlight', 'Turn the flashlight on, off, or toggle it.', { state: { type: 'string', enum: ['on', 'off', 'toggle'] } }, ['state'], a => dev('flashlight', a.state || 'toggle'));
  T('set_volume', 'Change the volume. action: up, down, mute, unmute, max or set (with level 0-100). stream: media (default), ring, alarm, call, notification.',
    { action: { type: 'string', enum: ['up', 'down', 'mute', 'unmute', 'max', 'set'] }, level: { type: 'integer' }, stream: { type: 'string' } }, ['action'], a => dev('volume', a.action, parseInt(a.level || 0, 10) || 0, a.stream || 'media'));
  T('ringer_mode', 'Put the phone on silent, vibrate or normal ring.', { mode: { type: 'string', enum: ['silent', 'vibrate', 'normal'] } }, ['mode'], a => dev('ringer', a.mode));
  T('do_not_disturb', 'Turn Do Not Disturb on or off.', { on: { type: 'boolean' } }, ['on'], a => dev('dnd', a.on !== false));
  T('set_brightness', 'Set screen brightness 0-100, or -1 for automatic.', { level: { type: 'integer' } }, ['level'], a => dev('brightness', parseInt(a.level, 10)));
  T('open_settings', "Open a phone settings page: wifi, bluetooth, internet, hotspot, airplane, location, battery, display, sound, notifications, apps, storage, date, accessibility, security, language, about, jarvis. (Apps can't switch Wi-Fi or Bluetooth themselves; this opens the switch, or use phone control to tap it.)",
    { page: { type: 'string' } }, ['page'], a => { const r = dev('openSettings', a.page || ''); return r === 'ok' ? `Opening ${a.page} settings.` : r; });

  // ================================================================== people: calls, texts, WhatsApp, notifications
  async function who(person) {
    const p = String(person || '').trim(); if (!p) return { error: 'Who should I contact?' };
    if (/^[+\d][\d\s().-]{2,}$/.test(p)) return { number: p.replace(/[^\d+]/g, ''), name: p };
    if (!has('findContact')) return { error: "I can only look up contacts on the phone. Give me the number." };
    const r = call('findContact', p.replace(/^(my|the)\s+/i, '')); const n = needed(r); if (n) return { error: n };
    const list = parse(r) || []; if (!list.length) return { error: `I don't see ${p} in your contacts. What's the number?` };
    const names = [...new Set(list.map(c => c.name))];
    if (names.length > 1 && !names.some(x => x.toLowerCase() === p.toLowerCase())) return { error: `I found ${names.slice(0, 4).join(', ')}. Which one?` };
    const pick = list.find(c => c.name.toLowerCase() === p.toLowerCase()) || list[0];
    const mobile = list.filter(c => c.name === pick.name).find(c => /mobile|cell/.test(c.type)) || pick;
    return { number: mobile.number, name: pick.name };
  }
  T('phone_call', "Call someone: a contact's name or a number. Calls straight away if allowed, otherwise opens the dialer.", { who: { type: 'string' } }, ['who'], async a => {
    const c = await who(a.who || a.number); if (c.error) return c.error;
    if (!has('call')) { openUrl('tel:' + c.number, 'the dialer'); return `Dialing ${c.name}.`; }
    const r = call('call', c.number); return r === 'calling' ? `Calling ${c.name}.` : r === 'dialer' ? `${c.name}'s number is in the dialer. Tap call. To call without tapping, allow phone calls in my settings.` : opened(r, 'the call') || `Calling ${c.name}.`;
  });
  T('send_text', 'Write a text message (SMS) to a contact or number; it opens ready for the user to tap send.', { who: { type: 'string' }, message: { type: 'string' } }, ['who', 'message'], async a => {
    const c = await who(a.who || a.number); if (c.error) return c.error;
    const r = has('sms') ? call('sms', c.number, String(a.message || '')) : openUrl('smsto:' + c.number + '?body=' + encodeURIComponent(a.message || ''), 'your message');
    return opened(r, 'your message') || `Your message to ${c.name} is ready. Tap send.`;
  });
  T('whatsapp_message', 'Open a WhatsApp chat with a contact or number, with the message typed in, ready to send.', { who: { type: 'string' }, message: { type: 'string' } }, ['who'], async a => {
    const c = await who(a.who); if (c.error) return c.error;
    const r = call('whatsapp', c.number, String(a.message || '')); return opened(r, 'WhatsApp') || `WhatsApp is open with ${c.name}${a.message ? ', message typed in. Tap send' : ''}.`;
  });
  T('read_notifications', "Read the phone's recent notifications. only_messages: just texts and chats. app: filter by app name.", { only_messages: { type: 'boolean' }, app: { type: 'string' } }, [], a => {
    if (!has('notifications')) return 'I can only read notifications on the phone.';
    const r = call('notifications', a.only_messages !== false, String(a.app || ''), 8); const n = needed(r); if (n) return n;
    if (r === 'starting') return 'Notification access is starting. Ask me again in a moment.';
    const l = parse(r) || []; if (!l.length) return a.only_messages === false ? 'No notifications.' : 'No new messages.';
    return l.map(x => `${x.n}. ${x.title || x.app}${x.app && x.title ? ' on ' + x.app : ''}${x.ago ? ', ' + (x.ago < 60 ? x.ago + ' min ago' : Math.round(x.ago / 60) + ' h ago') : ''}: ${x.text}${x.canReply ? ' (can reply)' : ''}`).join('\n');
  });
  T('reply_to_message', "Reply to a message notification (WhatsApp, Messages, etc.) through its Reply button. who: the sender's name, or the number from read_notifications. Confirm the wording with the user first unless they clearly said to send it.",
    { who: { type: 'string' }, message: { type: 'string' } }, ['message'], a => dev('replyTo', String(a.who || ''), String(a.message || '')));
  T('announce_messages', 'Turn on or off reading new messages out loud as they arrive (handy while driving).', { on: { type: 'boolean' } }, ['on'], a => {
    config.set('announce_messages', a.on !== false); if (W.AndroidBridge && W.AndroidBridge.setAnnounceMessages) W.AndroidBridge.setAnnounceMessages(a.on !== false);
    if (a.on !== false && has('status') && !(parse(call('status')) || {}).notifAccess) { call('request', 'notifAccess'); return NEED.notifAccess[1]; }
    return a.on !== false ? "I'll read new messages out loud as they come in." : "I'll keep quiet about new messages.";
  });
  W.__jvMessage = (json, visible) => {
    const m = parse(json); if (!m || !visible || !config.get('announce_messages', false)) return;
    broadcast(`proactive:Message from ${m.title || 'someone'}${m.app ? ' on ' + m.app : ''}. ${m.text}`);
  };

  // ================================================================== calendar
  const dayRange = (d, now = new Date()) => {
    const s = String(d || 'today').toLowerCase().trim(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (s === 'tomorrow') start.setDate(start.getDate() + 1);
    else if (s === 'week' || s === 'this week' || s === 'next 7 days') return [start.getTime(), start.getTime() + 7 * 86400000, 'in the next seven days'];
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, dd] = s.split('-').map(Number); start.setFullYear(y, m - 1, dd); }
    else if (s !== 'today') { const p = Date.parse(s); if (!Number.isNaN(p)) { const x = new Date(p); start.setFullYear(x.getFullYear(), x.getMonth(), x.getDate()); } }
    return [start.getTime(), start.getTime() + 86400000, dayWord(start.getTime() + 43200000)];
  };
  T('get_calendar', "What's on the user's calendar. day: today (default), tomorrow, week, or a date YYYY-MM-DD.", { day: { type: 'string' } }, [], a => {
    if (!has('calendarEvents')) return "I can only read the calendar on the phone.";
    const [from, to, label] = dayRange(a.day); const r = call('calendarEvents', from, to); const n = needed(r); if (n) return n;
    const l = parse(r); if (!l) return "I couldn't read your calendar."; if (!l.length) return `Nothing on your calendar ${label}.`;
    return `${l.length} event${l.length > 1 ? 's' : ''} ${label}: ` + l.map(e => `${e.title}${e.allDay ? ' (all day)' : ' at ' + clock(e.begin) + (label.startsWith('in the next') ? ' ' + dayWord(e.begin) : '')}${e.location ? ', ' + e.location : ''}`).join('; ') + '.';
  });
  T('add_calendar_event', "Add an event to the user's calendar. start: local 'YYYY-MM-DDTHH:MM'. Give end or duration_minutes (default 60). all_day for whole-day events (start 'YYYY-MM-DD').",
    { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, duration_minutes: { type: 'integer' }, location: { type: 'string' }, all_day: { type: 'boolean' } }, ['title', 'start'], a => {
      if (!has('calendarAdd')) return "I can only add calendar events on the phone.";
      let s = parseLocal(a.start); if (!s) return 'When does it start?';
      let e = a.end ? parseLocal(a.end) : s + (parseInt(a.duration_minutes, 10) || 60) * 60000;
      if (a.all_day) { const d = new Date(s); s = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); e = s + 86400000; }
      const r = call('calendarAdd', String(a.title), s, e || s + 3600000, String(a.location || ''), !!a.all_day); const n = needed(r); if (n) return n;
      if (r === 'no-calendar') return "There's no calendar on this phone I can write to. Add a Google account's calendar first.";
      if (!String(r).startsWith('ok')) return "I couldn't add that event.";
      return `Added ${a.title} ${a.all_day ? dayWord(parseLocal(a.start)) + ', all day' : 'at ' + when(s)}.`;
    });

  // ================================================================== clipboard and documents
  T('get_clipboard', "Read what's on the phone's clipboard (what the user copied).", {}, [], () => {
    if (!has('clipboardGet')) return "I can only read the clipboard on the phone.";
    const t = call('clipboardGet'); return t ? `Clipboard: ${String(t).slice(0, 1500)}` : "The clipboard is empty, or Android hid it because I'm not on screen.";
  });
  T('copy_to_clipboard', 'Copy text to the clipboard so the user can paste it.', { text: { type: 'string' } }, ['text'], a => { if (!has('clipboardSet')) return "I can only use the clipboard on the phone."; call('clipboardSet', String(a.text || '')); return 'Copied.'; });
  T('create_document', "Write a document and save it in the phone's Documents/Jarvis folder. kind: pdf, docx (Word) or txt. Write the full content yourself; plain paragraphs separated by new lines.",
    { kind: { type: 'string', enum: ['pdf', 'docx', 'txt'] }, title: { type: 'string' }, content: { type: 'string' } }, ['kind', 'title', 'content'], a => {
      if (!has('docSave')) return "I can only save documents on the phone.";
      const r = call('docSave', a.kind || 'pdf', String(a.title || ''), String(a.content || '')); const o = parse(r);
      if (!o) return `I couldn't save it. ${String(r || '').replace(/^error:\s*/, '')}`;
      kv.set('last_doc', o); return `Saved "${o.name}" in Documents, Jarvis folder. Want me to open or share it?`;
    });
  const docs = () => parse(call('docList')) || [];
  const findDoc = n => { const l = docs(), w = String(n || '').toLowerCase().trim(); if (!w || /^(it|that|the last( one)?|latest)$/.test(w)) return kv.get('last_doc', null) || l[0] || null; return l.find(d => d.name.toLowerCase().includes(w)) || null; };
  T('list_documents', "List the documents Jarvis has saved.", {}, [], () => { if (!has('docList')) return 'I can only list documents on the phone.'; const l = docs(); return l.length ? 'Your documents: ' + l.slice(0, 10).map(d => d.name).join('; ') + '.' : 'No documents yet.'; });
  T('open_document', "Open a saved document, or share it (email, WhatsApp, Drive…). name: part of its name, or 'it' for the last one.", { name: { type: 'string' }, share: { type: 'boolean' } }, [], a => {
    if (!has('docOpen')) return 'I can only open documents on the phone.'; const d = findDoc(a.name); if (!d) return "I can't find that document.";
    const r = call('docOpen', d.uri, d.mime || '', !!a.share); return opened(r, d.name) || (a.share ? 'Choose where to send it.' : `Opening ${d.name}.`);
  });
  T('delete_document', 'Delete a document Jarvis saved. Confirm with the user first.', { name: { type: 'string' } }, ['name'], a => {
    if (!has('docDelete')) return 'I can only delete documents on the phone.'; const d = findDoc(a.name); if (!d) return "I can't find that document.";
    return call('docDelete', d.uri) ? `Deleted ${d.name}.` : "I couldn't delete it.";
  });

  ctx.reminderItems = items;
  ctx.calendarToday = async () => {                              // for the morning briefing: quietly skipped without calendar access
    if (!has('calendarEvents') || !(parse(call('status')) || {}).calendar) return '';
    const [from, to] = dayRange('today'); const l = parse(call('calendarEvents', from, to)) || [];
    return l.length ? `On your calendar today: ${l.slice(0, 5).map(e => e.title + (e.allDay ? '' : ' at ' + clock(e.begin))).join('; ')}.` : '';
  };
  return { see, status: () => parse(call('status')) || {}, request: n => call('request', n) };
}
