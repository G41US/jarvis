// extras.js - the PC's screen extras on the phone: the 3D globe (night side, aurora, distances, earthquakes, the space station),
// live news stations and real public webcams (Windy), and answers as cards you swipe through (cards.js draws them).
// The page draws the globe with the PC's own hud_extra.js; this file is the "server" half (features.py on the PC).
import { httpRaw, realFetch } from './net.js';
import { BUILD } from './build_config.js';

const R_KM = 6371, DEG = Math.PI / 180;
export const kmBetween = (a, b) => {
  const h = Math.sin((b[0] - a[0]) * DEG / 2) ** 2 + Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin((b[1] - a[1]) * DEG / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};
const ago = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const YT_HEAD = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };

/** Live streams on a channel's Live tab, round-the-clock ones first: [[videoId, title]] */
export function liveOnPage(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html || ''); if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch { return []; }
  const on = [], runs = t => ((t && t.runs) || []).map(r => r.text || '').join('');
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    const v = o.lockupViewModel;
    if (v && v.contentId) { if (JSON.stringify(v.contentImage || {}).includes('BADGE_STYLE_LIVE')) on.push([v.contentId, ((((v.metadata || {}).lockupMetadataViewModel || {}).title) || {}).content || '']); return; }
    const r = o.videoRenderer;
    if (r && r.videoId) { if (JSON.stringify(r.thumbnailOverlays || []).includes('"LIVE"')) on.push([r.videoId, runs(r.title)]); return; }
    Object.values(o).forEach(walk);
  })(data);
  const steady = t => /24\/7|live ?stream|watch .*live|news now|\| live|english .{0,3} live/i.test(t);
  return on.sort((a, b) => steady(b[1]) - steady(a[1]));
}

// world news, one station per card: UK, Qatar, Nigeria, Germany, France, India, Singapore, Australia, the US
const WORLD = ['SkyNews', 'aljazeeraenglish', 'ChannelsTelevision', 'dwnews', 'France24_en', 'WION', 'ChannelNewsAsia', 'abcnewsaustralia', 'NBCNews'];
const NAMES = { SkyNews: 'Sky News', aljazeeraenglish: 'Al Jazeera English', ChannelsTelevision: 'Channels TV', dwnews: 'DW News', France24_en: 'France 24', WION: 'WION',
  ChannelNewsAsia: 'CNA', abcnewsaustralia: 'ABC News Australia', NBCNews: 'NBC News', NASA: 'NASA' };
const WHERE = { SkyNews: 'United Kingdom', aljazeeraenglish: 'Qatar', ChannelsTelevision: 'Nigeria', dwnews: 'Germany', France24_en: 'France', WION: 'India',
  ChannelNewsAsia: 'Singapore', abcnewsaustralia: 'Australia', NBCNews: 'United States', NASA: 'Space' };
const CHANNELS = { 'sky news': 'SkyNews', 'al jazeera': 'aljazeeraenglish', aljazeera: 'aljazeeraenglish', dw: 'dwnews', 'france 24': 'France24_en', france24: 'France24_en',
  nasa: 'NASA', channels: 'ChannelsTelevision', wion: 'WION', cna: 'ChannelNewsAsia', 'channel news asia': 'ChannelNewsAsia', 'abc australia': 'abcnewsaustralia', nbc: 'NBCNews' };
const REGIONS = { 'east coast': 'New York', 'west coast': 'Los Angeles', midwest: 'Chicago', 'the south': 'Atlanta', 'new england': 'Boston', usa: 'United States', us: 'United States',
  america: 'United States', uk: 'United Kingdom', britain: 'United Kingdom', uae: 'United Arab Emirates', 'middle east': 'Dubai', europe: 'Paris', 'west africa': 'Lagos',
  'east africa': 'Nairobi', 'the alps': 'Zermatt', caribbean: 'Jamaica', scandinavia: 'Stockholm', 'south east asia': 'Bangkok', 'southeast asia': 'Bangkok' };
export function whereIs(place) {
  const p = ' ' + String(place).toLowerCase().replace(/[^a-z ]/g, ' ') + ' ';
  for (const k of Object.keys(REGIONS).sort((a, b) => b.length - a.length)) if (p.includes(' ' + k + ' ')) return REGIONS[k];
  const parts = String(place).split(/\s+(?:in|of|near|around)\s+|,/).filter(s => s.trim());
  return parts.length > 1 ? parts[parts.length - 1].trim() : place;
}

// ---- answers as cards (the PC turns these into its 3D panels)
const NICE = { get_time: 'Time', time_until: 'Countdown', set_timer: 'Timer', set_reminder: 'Reminder', list_reminders: 'Reminders', remember: 'Remembered', recall: 'Memory',
  list_memories: 'Memories', take_note: 'Note', read_notes: 'Notes', translate: 'Translation', flip_coin: 'Coin', roll_dice: 'Dice', where_am_i: 'Location', morning_briefing: 'Briefing',
  list_preferences: 'Preferences', get_calendar: 'Calendar', system_info: 'Phone', fetch_page: 'Page' };
const SHOW = new Set([...Object.keys(NICE), 'get_weather', 'crypto_price', 'currency_convert', 'calculate', 'wikipedia', 'news_headlines', 'search_web']);
export function toolCards(name, args, result) {
  const r = String(result || '').trim(); args = args || {};
  if (!r || !SHOW.has(name) || /^(i couldn'?t|couldn'?t|tool |unknown|tell me which)/i.test(r)) return null;
  let m;
  if (name === 'get_weather' && (m = /^(.*?):\s*(.*?),\s*(-?\d+) degrees (Celsius|Fahrenheit),\s*feels like (-?\d+),\s*humidity (\d+)/.exec(r)))
    return [{ kind: 'stat', label: m[1], value: `${m[3]}°${m[4][0]}`, sub: `${m[2]} · feels ${m[5]}° · humidity ${m[6]}%` }];
  if (name === 'crypto_price' && (m = /^([\w-]+) is at ([\d,.]+) dollars(?:, (up|down) ([\d.]+))?/.exec(r)))
    return [{ kind: 'stat', label: m[1], value: '$' + m[2], sub: m[3] ? `${m[3] === 'up' ? '▲' : '▼'} ${m[4]}% today` : '', tone: m[3] || '' }];
  if (name === 'currency_convert' && (m = /^([\d,.]+ \w+) is about ([\d,.]+) (\w+)/.exec(r))) return [{ kind: 'stat', label: m[1], value: m[2], sub: m[3] }];
  if (name === 'calculate') return [{ kind: 'stat', label: String(args.expression || ''), value: r.slice(0, 18), sub: '' }];
  if (name === 'news_headlines') { const l = r.replace(/^Headlines:\s*/, '').split(/\.\s+/).filter(Boolean); return [{ kind: 'list', title: 'Headlines', rows: l.map((t, i) => ({ t: String(i + 1), title: t.replace(/\.$/, '') })) }]; }
  if (name === 'search_web') { const rows = [...r.matchAll(/^- (.*?): (.*)$/gm)].map((x, i) => ({ t: String(i + 1), title: x[1], sub: x[2].slice(0, 120) })); if (rows.length) return [{ kind: 'list', title: String(args.query || 'Search'), rows }]; }
  if (name === 'wikipedia') return [{ kind: 'note', title: String(args.query || 'Wikipedia'), text: r.slice(0, 900), source: 'wikipedia', wiki: String(args.query || '') }];
  return [{ kind: 'note', title: NICE[name] || name.replace(/_/g, ' '), text: r.slice(0, 700), source: '' }];
}

export function registerExtras(ctx) {
  const { reg, broadcast, log = () => {} } = ctx;
  const send = (kind, o) => broadcast(kind + ':' + JSON.stringify(o));
  const getJson = async (url, opts = {}) => { const r = await httpRaw(url, { timeoutMs: 12000, ...opts }); if (r.status !== 200) throw new Error('HTTP ' + r.status); return JSON.parse(r.text); };
  const panels = (title, items) => send('panels', { title, items });

  // ---- cards for answers: each tool's result, and long explanations
  let turnCards = 0;
  async function onToolResult(name, rawArgs, result) {
    let args = {}; try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {}; } catch {}
    const cards = toolCards(name, args, result); if (!cards) return;
    const w = cards.find(c => c.wiki);
    if (w) try {     // Wikipedia's picture goes first
      const j = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(w.wiki.replace(/ /g, '_')), { headers: { 'User-Agent': 'Jarvis/1.0 (personal assistant)' } });
      const img = (j.originalimage || j.thumbnail || {}).source; if (j.title) w.title = j.title; if (img) cards.unshift({ title: w.title, image: img, source: 'wikipedia' });
    } catch {}
    turnCards++; panels(NICE[name] || name, cards);
  }
  function onReply(question, answer) {
    const had = turnCards; turnCards = 0;
    if (had || String(answer).length < 240) return;          // short replies stay as subtitles
    const q = String(question).replace(/^(hey |ok )?jarvis[,\s]*/i, '').trim();
    panels(q, [{ kind: 'note', title: (q[0] || '').toUpperCase() + q.slice(1, 70), text: String(answer).slice(0, 900), source: 'jarvis' }]);
  }

  // ---- places: countries and states from the globe's own labels (centred properly), anything else from Open-Meteo's place search
  let labels = null;
  async function placeOf(name) {
    const key = String(name || '').toLowerCase().trim().replace(/^the /, ''); if (!key) return null;
    if (!labels) try { labels = await (await realFetch('./models/globe/labels.json')).json(); } catch { labels = {}; }
    for (const kind of ['countries', 'states']) for (const p of labels[kind] || []) if (p.n.toLowerCase() === key) return { lat: p.lat, lon: p.lon, label: p.n, kind: kind === 'countries' ? 'country' : 'state' };
    try {
      const d = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=' + encodeURIComponent(name));
      const g = (d.results || [])[0]; if (!g) return null;
      const fc = g.feature_code || '';
      return { lat: g.latitude, lon: g.longitude, label: g.name, kind: fc.startsWith('PCL') ? 'country' : (fc === 'ADM1' || fc === 'ADMD') ? 'state' : 'city', cc: (g.country_code || '').toUpperCase() };
    } catch { return null; }
  }

  // ---- the globe
  const ZOOM = { country: 2.4, state: 1.75, city: 1.3 };
  let globeAt = '';
  reg.add('globe', "Show the live 3D Earth instead of the face. Country and state borders and names are drawn on it. action: show, hide, satellite (yesterday's real satellite photo), " +
    'holo (hologram look), earthquakes, storms, iss (the space station), aurora, focus (fly to a place), zoom (closer, to the place if given), zoom_out, ' +
    'night (the dark side with city lights), distance (how far place is from place2, drawn as an arc). place: for focus/zoom/distance or earthquakes near X.',
  { action: { type: 'string', enum: ['show', 'hide', 'satellite', 'holo', 'earthquakes', 'storms', 'iss', 'aurora', 'focus', 'zoom', 'zoom_out', 'night', 'distance'] }, place: { type: 'string' }, place2: { type: 'string' } },
  ['action'], async ({ action = 'show', place = '', place2 = '' }) => {
    const a = String(action).toLowerCase().trim();
    if (a === 'hide') { globeAt = ''; send('globe', { cmd: 'hide' }); return 'Globe away.'; }
    if (['show', 'holo', 'satellite'].includes(a)) { send('globe', { cmd: 'show', mode: a === 'satellite' ? 'sat' : 'holo' }); return a === 'satellite' ? "Yesterday's satellite view." : 'The Earth.'; }
    if (a === 'night') { send('globe', { cmd: 'show', night: true }); return 'The night side. Those lights are the cities.'; }
    if (a === 'distance') {
      if (!place2 && /\s(and|to)\s/.test(place)) [place, place2] = place.split(/\s+(?:and|to)\s+/, 2);
      const [p1, p2] = await Promise.all([placeOf(place), placeOf(place2)]);
      if (!p1 || !p2) return `I couldn't find ${p1 ? place2 : place}.`;
      const km = Math.round(kmBetween([p1.lat, p1.lon], [p2.lat, p2.lon]));
      send('globe', { cmd: 'show', measure: { a: { lat: p1.lat, lon: p1.lon, label: p1.label }, b: { lat: p2.lat, lon: p2.lon, label: p2.label }, km } }); globeAt = '';
      return `${p1.label} to ${p2.label}: ${km.toLocaleString('en-US')} kilometres, about ${Math.round(km * 0.621371).toLocaleString('en-US')} miles, as the crow flies.`;
    }
    if (a === 'zoom_out') { globeAt = ''; send('globe', { cmd: 'show', fly: { dist: 5.6 } }); return 'The whole Earth.'; }
    place = String(place).replace(/\d+\s*(%|percent|times|x)?|\b(more|closer|than this|further|further in|in)\b/gi, '').trim().replace(/^[ ,.]+|[ ,.]+$/g, '');
    if (a === 'zoom' && !place) { send('globe', { cmd: 'show', fly: { scale: 0.4 } }); return 'Closer.'; }
    if (a === 'focus' || a === 'zoom') {
      const w = await placeOf(place); if (!w) return `I couldn't find ${place}.`;
      if (a === 'zoom' && w.label === globeAt) { send('globe', { cmd: 'show', fly: { lat: w.lat, lon: w.lon, scale: 0.4, label: w.label } }); return `Closer on ${w.label}.`; }
      send('globe', { cmd: 'show', fly: { lat: w.lat, lon: w.lon, dist: a === 'zoom' ? ZOOM[w.kind] : Math.max(ZOOM[w.kind], w.kind === 'country' ? 2.4 : 1.9), label: w.label } });
      globeAt = w.label; return `${w.label}.`;
    }
    if (a === 'earthquakes') {
      const d = await getJson(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${place ? '2.5_week' : '2.5_day'}.geojson`);
      let qs = d.features.filter(f => f.properties.mag != null).map(f => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], mag: Math.round(f.properties.mag * 10) / 10, label: f.properties.place || 'Unknown', t: f.properties.time / 1000 }));
      const where = place ? await placeOf(place) : null;
      if (where) qs = qs.filter(q => kmBetween([where.lat, where.lon], [q.lat, q.lon]) < 1500);
      qs.sort((x, y) => y.mag - x.mag);
      const focus = where ? { lat: where.lat, lon: where.lon, label: where.label } : qs[0] ? { lat: qs[0].lat, lon: qs[0].lon, label: qs[0].label } : null;
      send('globe', { cmd: 'show', layer: 'quakes', focus, points: qs.slice(0, 300).map(q => ({ lat: q.lat, lon: q.lon, size: q.mag, label: 'M' + q.mag })) });
      const span = place ? 'this week' : 'in the last day';
      if (!qs.length) return `No earthquakes above magnitude two and a half ${where ? 'near ' + where.label + ' ' : ''}${span}.`;
      return `${qs.length} earthquakes above magnitude 2.5 ${where ? 'near ' + where.label + ' ' : ''}${span}. Strongest: magnitude ${qs[0].mag}, ${qs[0].label}, ${ago(qs[0].t)}.`;
    }
    if (a === 'storms') {
      const d = await getJson('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC');
      const ss = (d.features || []).filter(f => String(f.properties.iscurrent).toLowerCase() === 'true')
        .map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: f.properties.eventname || 'Storm', sev: (f.properties.severitydata || {}).severitytext || '' }));
      send('globe', { cmd: 'show', layer: 'storms', focus: ss[0] ? { lat: ss[0].lat, lon: ss[0].lon, label: ss[0].label } : null, points: ss.map(s => ({ lat: s.lat, lon: s.lon, size: 6, label: s.label, tone: 'storm' })) });
      return ss.length ? `${ss.length} active: ` + ss.map(s => `${s.label}, ${s.sev}`).join('; ') + '.' : 'No active tropical storms anywhere right now.';
    }
    if (a === 'iss') {
      const now = Math.floor(Date.now() / 1000), ts = Array.from({ length: 10 }, (_, k) => now + (k - 4) * 600).join(',');
      const tr = (await getJson(`https://api.wheretheiss.at/v1/satellites/25544/positions?timestamps=${ts}&units=kilometers`)).map(p => ({ lat: p.latitude, lon: p.longitude, t: p.timestamp }));
      const cur = tr.reduce((x, y) => (Math.abs(y.t - now) < Math.abs(x.t - now) ? y : x));
      send('globe', { cmd: 'show', layer: 'iss', line: tr, focus: { lat: cur.lat, lon: cur.lon, label: 'ISS' } });
      return `The space station is over latitude ${Math.round(cur.lat)}, longitude ${Math.round(cur.lon)}, circling every ninety-two minutes.`;
    }
    if (a === 'aurora') {
      const d = await getJson('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json');
      const pts = d.coordinates.filter(c => c[2] >= 8).map(([lon, lat, v]) => ({ lat, lon: lon <= 180 ? lon : lon - 360, size: v }));
      const north = Math.max(0, ...pts.filter(p => p.lat > 0).map(p => p.size)), south = Math.max(0, ...pts.filter(p => p.lat < 0).map(p => p.size));
      send('globe', { cmd: 'show', layer: 'aurora', focus: { lat: 66, lon: -100, label: '' }, points: pts });
      return `Aurora chance peaks at ${north} percent in the north and ${south} in the south.`;
    }
    return 'I can show the globe, the night side, distances, satellite view, earthquakes, storms, the space station or the aurora.';
  });

  // ---- live news stations (YouTube) and public webcams (Windy), as cards: tap one to watch
  const live = {};
  async function channelLive(handle) {
    const hit = live[handle]; if (hit && Date.now() - hit.at < 600000) return hit.v;
    let v = null;
    try {
      const r = await httpRaw(`https://www.youtube.com/@${handle}/streams`, { headers: YT_HEAD, timeoutMs: 10000 });
      for (const [id] of liveOnPage(r.text).slice(0, 4)) {
        const o = await httpRaw(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { headers: YT_HEAD, timeoutMs: 6000 }).catch(() => ({ status: 200 }));
        if (o.status === 200) { v = id; break; }       // 401: the owner doesn't allow playing it inside other apps
      }
    } catch (e) { log('[FEEDS]', handle, e && e.message); }
    live[handle] = { at: Date.now(), v }; return v;
  }
  async function newsCards(handles, title) {
    const found = await Promise.all(handles.map(async h => [h, await channelLive(h)]));
    const items = found.filter(([, id]) => id).map(([h, id]) => ({ kind: 'video', video: id, title: NAMES[h] || h, source: 'live' + (WHERE[h] ? ' · ' + WHERE[h] : ''), image: `https://i.ytimg.com/vi/${id}/hqdefault_live.jpg` }));
    if (items.length) panels(title, items);
    return items;
  }
  async function webcams(place, n = 8) {
    const key = String(BUILD.windyKey || '').trim(); if (!key) return null;
    const base = 'https://api.windy.com/webcams/api/v3/webcams?include=images,location,player&limit=50&sortKey=popularity&sortDirection=desc&lang=en';
    let tries = [''];
    if (place) {
      const alias = /^(the )?(usa|us|u\.s\.a?\.?|america|uk|britain|uae)$/i.test(place.trim()) ? whereIs(place) : place;
      const loc = (await placeOf(alias)) || (await placeOf(whereIs(place))); if (!loc) return [];
      tries = (loc.kind === 'country' && loc.cc ? [`&countries=${loc.cc}`] : []).concat([30, 120, 250].map(r => `&nearby=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)},${r}`));
    }
    for (const extra of tries) {
      const r = await httpRaw(base + extra, { headers: { 'x-windy-api-key': key }, timeoutMs: 10000 });
      if (r.status === 401 || r.status === 403) { log('[CAMS] Windy refused the key', r.status); return null; }
      let cams = []; try { cams = (JSON.parse(r.text).webcams || []).filter(w => w.status === 'active'); } catch {}
      cams.sort((x, y) => !!((y.player || {}).live) - !!((x.player || {}).live));          // cameras that stream go first
      const out = [];
      for (const w of cams) {
        const pl = w.player || {}, src = pl.live || pl.day || (w.webcamId ? `https://webcams.windy.com/webcams/public/embed/player/${w.webcamId}/day` : '');
        if (!src.startsWith('https://webcams.windy.com/')) continue;
        const l = w.location || {};
        out.push({ src, live: !!pl.live, title: String(w.title || l.city || 'Webcam').slice(0, 70), where: [l.city, l.country].filter(Boolean).join(', ').slice(0, 50), image: ((w.images || {}).current || {}).preview || '' });
        if (out.length === n) break;
      }
      if (out.length) return out;
    }
    return [];
  }
  reg.remove(['show_public_cam']);
  reg.add('show_public_cam', "Show live feeds as cards (tap one to watch): webcams of a place ('cameras in Paris', 'live cam of Lagos'), world news ('live news', 'news from around the world'), " +
    "one station ('Sky News live', 'Channels TV live', 'Al Jazeera live') or NASA live. No place ('show me live cameras'): location '' gives popular webcams worldwide. action close puts them away.",
  { location: { type: 'string', description: "a place, a news channel, 'news' or 'nasa'" }, action: { type: 'string', enum: ['show', 'close'] } }, ['location'], async ({ location = '', action = 'show' }) => {
    if (action === 'close') { send('panels', { cmd: 'close' }); return 'Feeds closed.'; }
    const q = String(location).trim(), ql = q.toLowerCase();
    const place = ql.replace(/\b(live|public|web)?\s*(cams?|cameras?|webcams?|feeds?)\b|\b(available|anywhere|any|some|popular|around the world|in the world|the)\b/g, '').trim().replace(/^[ ,.?]+|[ ,.?]+$/g, '');
    try {
      const ch = Object.keys(CHANNELS).find(k => new RegExp(`\\b${k}\\b`).test(ql));
      if (ch) { const h = CHANNELS[ch], items = await newsCards([h], NAMES[h]); return items.length ? `${NAMES[h]}, live. Tap it to watch.` : `${NAMES[h]} isn't live right now.`; }
      if (/\bnews\b|\b(stations?|channels?)\b/.test(ql)) {
        const items = await newsCards(WORLD, 'World news');
        return items.length ? `${items.length} news stations from around the world. Tap one to watch.` : "I couldn't get the news stations just now.";
      }
      const cams = await webcams(place ? q : '');
      if (cams === null) return "Webcams aren't set up in this copy of Jarvis yet (it needs a Windy key).";
      if (!cams.length) return `Windy's network has no public webcams in or near ${q} right now.`;
      panels(`Webcams: ${place ? q : 'around the world'}`, cams.map(c => ({ kind: 'video', cam: c.src, live: c.live, title: c.title, source: (c.live ? 'live' : 'timelapse') + (c.where ? ' · ' + c.where : ''), image: c.image })));
      const nLive = cams.filter(c => c.live).length;
      return `${cams.length} webcams${place ? ' around ' + q : ' from around the world'}` + (nLive ? `, ${nLive} streaming live` : ', showing today\'s timelapse') + '. Tap one to watch.';
    } catch (e) { log('[FEEDS]', e && e.message); return "I couldn't reach the live feeds just now."; }
  });

  /** The page asks for the space station's position while it's on the globe. */
  const iss = async () => getJson('https://api.wheretheiss.at/v1/satellites/25544');
  return { onToolResult, onReply, iss, placeOf };
}
