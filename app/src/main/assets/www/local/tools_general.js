// tools_general.js - everyday tools that work on a phone: time, weather, search, math, memory, notes,
// news, crypto, currency, translate, music. Phone abilities (reminders, camera, calls, screen, documents...) are in tools_phone.js.
import { httpRaw, buildUrl } from './net.js';

export const timeOfDay = (d = new Date()) => { const h = d.getHours(); return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const fixSpace = s => String(s).replace(/[  ]/g, ' ');
const WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers',
  82: 'violent rain showers', 85: 'snow showers', 86: 'snow showers', 95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a thunderstorm with hail' };

/** Safe arithmetic: numbers, + - * / % ^ **, parentheses, unary minus. No eval. */
export function calculate(expression) {
  const src = String(expression || '').trim().replace(/\^/g, '**');
  if (!/^[0-9+\-*/().\s%]+$/.test(src)) return 'Invalid characters.';
  let i = 0; const peek = () => { while (src[i] === ' ') i++; return src[i]; };
  const num = () => { peek(); const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i)); if (!m) throw new Error('num'); i += m[0].length; return parseFloat(m[0]); };
  const atom = () => { const c = peek(); if (c === '(') { i++; const v = expr(); if (peek() !== ')') throw new Error('paren'); i++; return v; } if (c === '-') { i++; return -pow(); } if (c === '+') { i++; return pow(); } return num(); };
  const pow = () => { const b = atom(); if (src.slice(i).trimStart().startsWith('**')) { i = src.indexOf('**', i) + 2; const e = pow(); if (Math.abs(e) > 100 || Math.abs(b) > 1e6) throw new Error('too large'); return Math.pow(b, e); } return b; };
  const term = () => { let v = pow(); for (;;) { const c = peek(); if (c === '*' && src[i + 1] !== '*') { i++; v *= pow(); } else if (c === '/') { i++; const d = pow(); if (d === 0) throw new RangeError('zero'); v /= d; } else if (c === '%') { i++; const d = pow(); if (d === 0) throw new RangeError('zero'); v = ((v % d) + d) % d; } else return v; } };
  const expr = () => { let v = term(); for (;;) { const c = peek(); if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v; } };
  try { const v = expr(); if (peek() !== undefined) return "I couldn't evaluate that."; return Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : String(Math.round(v * 1e10) / 1e10); }
  catch (e) { return e instanceof RangeError ? "Can't divide by zero." : "I couldn't evaluate that."; }
}

/** "in 10 minutes", "at 5pm", "tomorrow at 9:30 am", or anything Date can parse -> epoch ms, or null. */
export function parseWhen(when, now = new Date()) {
  const w = String(when || '').toLowerCase().trim();
  let m = /^in\s+(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|day|week)s?\b/.exec(w);
  if (m) { const mult = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600, day: 86400, week: 604800 }[m[2]]; return { at: now.getTime() + parseFloat(m[1]) * mult * 1000, relative: true, n: parseFloat(m[1]), unit: m[2] }; }
  const t = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/.exec(w.replace(/tomorrow|today|tonight|this (?:morning|afternoon|evening)/g, ''));
  const hasDay = /tomorrow|today|tonight|this (morning|afternoon|evening)|^at\b/.test(w) || /\d\s*(am|pm)/.test(w) || /^\d{1,2}:\d{2}/.test(w);
  if (t && hasDay) {
    let h = parseInt(t[1], 10); const mi = t[2] ? parseInt(t[2], 10) : 0, ap = (t[3] || '').replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (!ap && /tonight|evening|afternoon/.test(w) && h < 12) h += 12;
    if (h <= 24 && mi < 60) { const d = new Date(now); d.setHours(h % 24, mi, 0, 0); if (/tomorrow/.test(w)) d.setDate(d.getDate() + 1); else if (d <= now) d.setDate(d.getDate() + 1); return { at: d.getTime(), relative: false }; }
  }
  const p = Date.parse(when); if (!Number.isNaN(p)) { let at = p; if (at < now.getTime()) at += 86400000; return { at, relative: false }; }
  return null;
}
const fmtClockMs = ms => fixSpace(new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));

export function registerGeneralTools(ctx) {
  const { reg, kv, http, broadcast, config } = ctx; const bridge = () => (typeof window !== 'undefined' && window.AndroidBridge) || null;
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const json = async (url, params) => { const r = await httpRaw(buildUrl(url, params), { headers: { Accept: 'application/json', 'User-Agent': 'JarvisAssistant/1.0' }, timeoutMs: 9000 }); try { return r.status === 200 ? JSON.parse(r.text) : null; } catch { return null; } };
  const geo = async name => { const d = await json('https://geocoding-api.open-meteo.com/v1/search', { name, count: 1, language: 'en', format: 'json' }); return d && d.results && d.results[0] || null; };
  const myPlace = () => { const o = ctx.navsvc && ctx.navsvc.origin(); return o ? { latitude: o[0], longitude: o[1], name: 'your location' } : null; };

  T('get_time', "Get the current time. Pass a location like 'Abuja' or 'Tokyo'.", { location: { type: 'string' } }, [], async a => {
    const loc = String(a.location || a.timezone || '').trim();
    if (!loc) { const d = new Date(); return fixSpace(`${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} on ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`) + ' local time'; }
    const g = await geo(loc.replace(/^(the )?(time|date)?\s*(in|at|for)\s+/i, '')); if (!g || !g.timezone) return `I couldn't find the time for ${loc}.`;
    const d = new Date(), tz = g.timezone;
    const pretty = fixSpace(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', weekday: 'long', month: 'long', day: 'numeric' }).format(d));
    const off = (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName') || {}).value || '';
    return `${pretty} in ${g.name}, ${g.country || ''}. That's ${tz} (${off.replace('GMT', 'UTC')}).`;
  });
  T('time_until', 'Countdown to a date.', { target_date: { type: 'string' } }, ['target_date'], a => {
    const p = Date.parse(a.target_date); if (Number.isNaN(p)) return "I couldn't parse that date.";
    const days = Math.floor((p - Date.now()) / 86400000); if (days < 0) return `That was ${Math.abs(days)} days ago.`;
    if (days === 0) return `That's today, in about ${Math.floor(((p - Date.now()) % 86400000) / 3600000)} hours.`;
    return `${days} days until ${new Date(p).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`;
  });
  T('get_weather', "Get current weather for a city. With no city it uses the user's location.", { city: { type: 'string' } }, [], async a => {
    let g = a.city ? await geo(a.city) : myPlace(); if (!g) g = myPlace(); if (!g) return a.city ? `I couldn't find ${a.city}.` : 'Tell me which city, or allow location so I know where you are.';
    // Fahrenheit only where people use it (the US), unless the user picked units: Abuja gets Celsius
    const inUS = (y, x) => (y > 24 && y < 49.5 && x > -125 && x < -66.9) || (y > 51 && y < 72 && x > -170 && x < -129) || (y > 18 && y < 23 && x > -161 && x < -154);
    const f = ctx.delivery._unitsFixed ? ctx.delivery.units === 'miles' : inUS(g.latitude, g.longitude);
    const d = await json('https://api.open-meteo.com/v1/forecast', { latitude: g.latitude, longitude: g.longitude, current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max', timezone: 'auto', temperature_unit: f ? 'fahrenheit' : 'celsius', wind_speed_unit: f ? 'mph' : 'kmh', forecast_days: 1 });
    if (!d || !d.current) return "I couldn't reach the weather service.";
    const c = d.current, dd = d.daily || {}, deg = f ? 'degrees Fahrenheit' : 'degrees Celsius';
    let txt = `${g.name === 'your location' ? 'Right now' : g.name}: ${WMO[c.weather_code] || 'unsettled'}, ${Math.round(c.temperature_2m)} ${deg}, feels like ${Math.round(c.apparent_temperature)}, humidity ${Math.round(c.relative_humidity_2m)} percent, wind ${Math.round(c.wind_speed_10m)} ${f ? 'miles an hour' : 'kilometers an hour'}.`;
    if (dd.temperature_2m_max) txt += ` Today ${Math.round(dd.temperature_2m_min[0])} to ${Math.round(dd.temperature_2m_max[0])}` + (dd.precipitation_probability_max && dd.precipitation_probability_max[0] >= 30 ? `, ${dd.precipitation_probability_max[0]} percent chance of rain.` : '.');
    return txt;
  });
  const decode = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  T('search_web', 'Search the web.', { query: { type: 'string' } }, ['query'], async a => {
    const r = await httpRaw('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' }, body: 'q=' + encodeURIComponent(a.query), timeoutMs: 10000 });
    const out = [];
    if (r.status === 200) {
      const re = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g; let m;
      while ((m = re.exec(r.text)) && out.length < 3) out.push(`- ${decode(m[1])}: ${decode(m[2]).slice(0, 200)}`);
    }
    if (out.length) return out.join('\n');
    const w = await json('https://en.wikipedia.org/w/api.php', { action: 'query', list: 'search', srsearch: a.query, format: 'json', srlimit: 3, origin: '*' });
    const hits = (w && w.query && w.query.search) || [];
    return hits.length ? hits.map(h => `- ${h.title}: ${decode(h.snippet).slice(0, 200)}`).join('\n') : 'No results found.';
  });
  T('fetch_page', 'Fetch a web page and extract its text.', { url: { type: 'string' } }, ['url'], async a => {
    const url = /^https?:/i.test(a.url) ? a.url : 'https://' + a.url, r = await httpRaw(url, { headers: { 'User-Agent': 'Mozilla/5.0 Jarvis/1.0' }, timeoutMs: 10000 });
    if (r.status !== 200) return `Couldn't fetch ${url} (status ${r.status}).`;
    let t = r.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '); t = decode(t);
    return (t.length > 4000 ? t.slice(0, 4000) + '...' : t) || '(empty page)';
  });
  T('wikipedia', 'Get a factual summary.', { query: { type: 'string' } }, ['query'], async a => {
    const d = await json('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(String(a.query).trim().replace(/ /g, '_')));
    return d && d.extract ? d.extract : 'No wikipedia entry.';
  });
  T('calculate', 'Evaluate a math expression.', { expression: { type: 'string' } }, ['expression'], a => calculate(a.expression));
  T('flip_coin', 'Flip a coin.', {}, [], () => (Math.random() < 0.5 ? 'Heads.' : 'Tails.'));
  T('roll_dice', 'Roll dice.', { sides: { type: 'integer' }, count: { type: 'integer' } }, [], a => {
    const sides = Math.min(1000, Math.max(2, parseInt(a.sides || 6, 10) || 6)), n = Math.min(20, Math.max(1, parseInt(a.count || 1, 10) || 1));
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides)); return n === 1 ? `${rolls[0]}.` : `${rolls.join(', ')}. Total ${rolls.reduce((x, y) => x + y, 0)}.`;
  });
  T('generate_password', 'Generate a random password.', { length: { type: 'integer' } }, [], a => {
    const len = Math.min(64, Math.max(8, parseInt(a.length || 16, 10) || 16)), cs = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?';
    const arr = new Uint32Array(len); crypto.getRandomValues(arr); const pw = Array.from(arr, v => cs[v % cs.length]).join('');
    return `Here it is: ${pw}. I won't keep a copy.`;
  });

  // timers, reminders and alarms: tools_phone.js (they ring natively, even when Jarvis is closed)

  // ---- memory, preferences, notes
  const changed = () => ctx.onMemoryChange && ctx.onMemoryChange();
  const mem = () => kv.get('memories', []), prefs = () => kv.get('prefs', []);
  T('remember', 'Save a fact about the user.', { fact: { type: 'string' } }, ['fact'], a => { if (!a.fact || a.fact.length < 3) return 'Too short to remember.'; const m = mem(); m.push({ fact: a.fact.trim(), ts: Date.now() }); kv.set('memories', m); changed(); return "Got it. I'll remember that."; });
  T('recall', 'Recall saved facts.', { query: { type: 'string' } }, ['query'], a => {
    const q = String(a.query || '').toLowerCase().split(/\W+/).filter(w => w.length > 2), hits = mem().map(m => ({ m, s: q.filter(w => m.fact.toLowerCase().includes(w)).length })).filter(x => x.s).sort((x, y) => y.s - x.s).slice(0, 5);
    return hits.length ? 'I remember: ' + hits.map(h => h.m.fact).join('; ') : `Nothing stored about ${a.query}.`;
  });
  T('list_memories', 'List everything you remember.', {}, [], () => { const m = mem(); return m.length ? 'I know: ' + m.slice(-50).map(x => x.fact).join('; ') : 'Nothing remembered yet.'; });
  T('forget_memory', 'Delete stored facts matching a keyword.', { query: { type: 'string' } }, ['query'], a => { const q = String(a.query || '').toLowerCase(); kv.set('memories', mem().filter(m => !m.fact.toLowerCase().includes(q))); changed(); return 'Forgotten.'; });
  T('set_preference', 'Save a preference about HOW you behave.', { pref: { type: 'string' } }, ['pref'], a => { if (!a.pref || a.pref.length < 3) return 'Too short.'; const p = prefs(); p.push(a.pref.trim()); kv.set('prefs', p); changed(); return 'Noted.'; });
  T('list_preferences', 'List all preferences.', {}, [], () => { const p = prefs(); return p.length ? 'Preferences: ' + p.join('; ') : 'No preferences.'; });
  T('forget_preference', 'Remove preferences matching a keyword.', { query: { type: 'string' } }, ['query'], a => { const q = String(a.query || '').toLowerCase(); kv.set('prefs', prefs().filter(p => !p.toLowerCase().includes(q))); changed(); return 'Removed.'; });
  T('forget_all', 'Erase everything remembered about the user: memories, preferences, notes and chat history.', {}, [], () => { ['memories', 'prefs', 'notes', 'history', 'summary'].forEach(k => kv.del(k)); ctx.clearConversation && ctx.clearConversation(); return 'Everything I knew is gone.'; });
  T('take_note', 'Save a short note.', { text: { type: 'string' } }, ['text'], a => { const n = kv.get('notes', []); n.push({ text: a.text, ts: Date.now() }); kv.set('notes', n); return 'Noted.'; });
  T('read_notes', 'Read back saved notes.', {}, [], () => { const n = kv.get('notes', []); return n.length ? 'Your notes: ' + n.slice(-10).map(x => x.text).join('; ') : 'No notes yet.'; });

  // ---- money, news, language
  const COINS = { bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum', solana: 'solana', sol: 'solana', dogecoin: 'dogecoin', doge: 'dogecoin', xrp: 'ripple', ripple: 'ripple', cardano: 'cardano', ada: 'cardano', litecoin: 'litecoin', ltc: 'litecoin', bnb: 'binancecoin', tether: 'tether', usdt: 'tether' };
  T('crypto_price', 'Current price of a cryptocurrency.', { coin: { type: 'string' } }, ['coin'], async a => {
    const key = String(a.coin || '').trim().toLowerCase(); let id = COINS[key];
    if (!id) { const s = await json('https://api.coingecko.com/api/v3/search', { query: key }); id = s && s.coins && s.coins[0] && s.coins[0].id; }
    if (!id) return `I couldn't find ${a.coin}.`;
    const d = await json('https://api.coingecko.com/api/v3/simple/price', { ids: id, vs_currencies: 'usd', include_24hr_change: 'true' });
    if (!d || !d[id]) return "I couldn't reach the price service.";
    const p = d[id].usd, ch = d[id].usd_24h_change; return `${id} is at ${p >= 1 ? p.toLocaleString('en-US', { maximumFractionDigits: 2 }) : p} dollars` + (ch != null ? `, ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(1)} percent today.` : '.');
  });
  T('currency_convert', 'Convert an amount between currencies.', { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, ['amount', 'from', 'to'], async a => {
    const f = String(a.from).trim().toUpperCase(), t = String(a.to).trim().toUpperCase(), d = await json(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`);
    if (!d || !d.rates || !d.rates[t]) return `I couldn't convert ${f} to ${t}.`;
    const v = Number(a.amount) * d.rates[t]; return `${a.amount} ${f} is about ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${t}.`;
  });
  const newsText = async () => {
    const r = await httpRaw('https://feeds.bbci.co.uk/news/rss.xml', { timeoutMs: 8000 }); if (r.status !== 200) return '';
    const items = [...r.text.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].map(m => decode(m[1])).filter(Boolean).slice(0, 4);
    return items.length ? 'Headlines: ' + items.join('. ') + '.' : '';
  };
  T('news_headlines', 'Top news headlines.', {}, [], async () => (await newsText()) || "I couldn't reach the news right now.");
  T('translate', 'Translate text into another language.', { text: { type: 'string' }, language: { type: 'string' } }, ['text', 'language'], async a => (ctx.llm ? ((await ctx.llm(`Translate to ${a.language}. Reply with only the translation.\n\n${a.text}`)) || "I couldn't translate that.") : 'Translation needs my brain online.'));

  // ---- briefing
  async function briefingText() {
    const parts = [timeOfDay() + '.'];
    try { const w = await reg.exec('get_weather', {}); if (w && !/couldn't|Tell me which/.test(w)) parts.push(w); } catch {}
    try { const n = await newsText(); if (n) parts.push(n); } catch {}
    try { if (ctx.calendarToday) { const c = await ctx.calendarToday(); if (c) parts.push(c); } } catch {}
    const rem = (ctx.reminderItems ? ctx.reminderItems() : kv.get('reminders', [])).filter(r => !r.fired && r.kind !== 'timer' && new Date(r.at).toDateString() === new Date().toDateString());
    if (rem.length) parts.push('Reminders today: ' + rem.map(r => `${r.text} at ${fmtClockMs(r.at)}`).join('; ') + '.');
    return [parts.join(' '), parts.length > 1];
  }
  ctx.briefingText = briefingText;
  T('morning_briefing', 'Deliver the morning briefing: weather, calendar, reminders and news.', {}, [], async () => (await briefingText())[0]);

  // ---- phone controls
  const nb = () => bridge();
  T('system_info', 'Battery level and network state of this phone.', {}, [], async () => {
    try { if (nb() && nb().battery) { const b = JSON.parse(nb().battery()); return `Battery at ${b.level} percent${b.charging ? ', charging' : ''}${b.network ? '. Connected over ' + b.network : '. Offline'}.`; } } catch {}
    try { const b = await navigator.getBattery(); return `Battery at ${Math.round(b.level * 100)} percent${b.charging ? ', charging' : ''}.`; } catch {}
    return "I can't read the battery here.";
  });
  T('open_app', 'Open an app installed on this phone by name.', { name: { type: 'string' } }, ['name'], a => {
    if (!nb() || !nb().openApp) return 'I can only open apps on the phone.'; const r = nb().openApp(String(a.name || ''));
    if (r === 'notified') return `I've put ${a.name} in your notifications: tap it to open. To skip that step, switch on "Open apps from the background" in my settings.`;
    return r === 'ok' ? `Opening ${a.name}.` : (r || `I couldn't find an app called ${a.name}.`);
  });
  const media = (action, query = '', pkg = '') => { if (!nb() || !nb().media) return 'I can only control music on the phone.'; return nb().media(action, query, pkg); };
  T('play_music', 'Play a song, artist or playlist in a music app on this phone (Spotify by default).', { query: { type: 'string' }, app: { type: 'string', description: 'spotify, youtube music; default spotify' } }, ['query'], a => {
    const r = media('play_search', a.query, /youtube/i.test(a.app || '') ? 'com.google.android.apps.youtube.music' : 'com.spotify.music'); return r === 'ok' ? `Playing ${a.query}.` : r === 'notified' ? `Tap the notification to start ${a.query}.` : r;
  });
  T('spotify_play', 'Play something on Spotify, or resume playback.', { query: { type: 'string' } }, [], a => { if (!a.query) { const r = media('play'); return r === 'ok' ? 'Playing.' : r; } const r = media('play_search', a.query, 'com.spotify.music'); return r === 'ok' ? `Playing ${a.query} on Spotify.` : r; });
  T('spotify_pause', 'Pause music.', {}, [], () => { const r = media('pause'); return r === 'ok' ? 'Paused.' : r; });
  T('spotify_next', 'Skip to the next track.', {}, [], () => { const r = media('next'); return r === 'ok' ? 'Skipped.' : r; });
  T('spotify_previous', 'Go back to the previous track.', {}, [], () => { const r = media('previous'); return r === 'ok' ? 'Previous track.' : r; });
  T('spotify_now_playing', "Say what's playing.", {}, [], () => "Your phone doesn't let me read what's playing, but I can pause, skip or play something.");
  T('list_voices', 'List the speaking voices available on this phone.', {}, [], () => { const v = ctx.voices ? ctx.voices() : []; return v.length ? 'Available voices: ' + v.slice(0, 8).map(x => x.name).join(', ') + '.' : 'Only the default voice is available.'; });
  T('set_voice', "Change Jarvis's voice and face. voice_name: 'female' or 'male' (the face changes with it), or a voice name from list_voices.", { voice_name: { type: 'string' } }, ['voice_name'], async a => {
    if (ctx.switchVoice) return ctx.switchVoice(a.voice_name);
    const r = ctx.setVoice ? ctx.setVoice(a.voice_name) : null; return r ? `Voice switched to ${r}.` : `I don't have a voice called '${a.voice_name}'.`;
  });
}
