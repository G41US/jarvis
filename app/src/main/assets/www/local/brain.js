// brain.js - Jarvis's brain on the phone: Groq streaming + tool calling (same loop as server.py), memory, short history.

import { forSpeech } from './speech.js';

export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const SENTENCE_SPLIT = /(?<=[.!?])\s+/, CLAUSE_SPLIT = /(?<=[,;:])\s+/g;
// sign-offs a person wouldn't say; the model sometimes adds them despite the prompt, so they're dropped before they're spoken
export const FILLER = /^(let me know if|feel free to|is there anything else|anything else i can|hope (that|this) helps|happy to help|just let me know)\b/i;
export const emitSentences = text => text.split(SENTENCE_SPLIT).map(s => s.trim()).filter(s => s.length >= 2 && !FILLER.test(s));

// Small talk is the only thing answered without tools: anything else might need to DO something ("switch to the female
// voice", "on my torchlight"), and a keyword list can never cover every way of saying it.
const SMALL_TALK = /^(hi|hello|hey|yo|thanks|thank you|thank you so much|ok|okay|cool|nice|great|good|wow|lol|haha|bye|goodbye|good (morning|afternoon|evening|night)|how are you|how'?s it going|you there|are you there)( jarvis)?[.!?]*$/;
// Conversation, not a task: chit-chat, questions about Jarvis himself, feelings, jokes. These go to the AI with no tools at all,
// so he just talks ("what are you up to?" must never turn into opening a map).
const CHAT = [
  /^(so |and |but |well |hey |yo )*(what'?s|what is|what are|whatcha|wat) (you|u|ya) (up to|doing|thinking( about)?)( (right )?now| today| tonight)?$/,
  /^(what'?s|whats|wassup|sup|what is) up( with you)?$/, /^(sup|wassup|wsup|wagwan|how far)$/,
  /^how (are|r) (you|u|ya)( doing| today| feeling| holding up)?( today| tonight)?$/, /^how (have|you) (you )?been$/, /^how('s| is| was) (your|ur) (day|night|morning|evening|weekend)( going)?$/,
  /^(who|what) (are|r) (you|u)$/, /^(what'?s|what is) your name$/, /^what can you do$/, /^tell me (about|more about) (yourself|you)$/, /^introduce yourself$/,
  /^are (you|u) (real|alive|human|there|awake|okay|ok|single|happy|smart|a robot|an ai)$/, /^do (you|u) (like|love|dream|sleep|eat|have feelings|get tired|ever get)\b.*$/,
  /^(i'?m|i am|im) (bored|tired|sad|happy|lonely|back|home|fine|good|okay|ok|great|stressed|hungry|sleepy)( now| again)?$/,
  /^tell me (a joke|another one|something (funny|interesting|cool))$/, /^(make me laugh|say something( funny)?|entertain me)$/,
  /^(good (job|work|boy|one)|well done|nice one|you'?re (funny|smart|the best|awesome|amazing|annoying|weird|cool)|i (love|like|hate) you|you rock)$/,
  /^(never ?mind|forget it|nothing|no|nope|not now|maybe later|that'?s (all|it|fine|cool))$/, /^(let'?s|can we|i (want|need) to) (talk|chat)( for a bit)?$/, /^talk to me$/,
];
export const isSmallTalk = text => {
  const t = String(text || '').toLowerCase().replace(/^(hey |ok |okay )?jarvis[,.!]?\s*/, '').replace(/[,.!?]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/ jarvis$/, '');
  return SMALL_TALK.test(t) || CHAT.some(re => re.test(t));
};
export function needsTool(text) { return !isSmallTalk(text); }

// Harder questions get more thinking time; quick commands and simple facts stay fast.
const DEEP = /\b(why|how (do|does|did|can|could|should|would|to|much|many|long)|explain|compare|difference|versus|vs|plan|planning|advice|advise|should i|what should|best (way|option|time|route)|what if|recommend|suggest|solve|work out|figure out|analy[sz]e|pros and cons|strategy|help me (decide|understand|write|figure|plan|think)|write (me )?(a|an|the)|draft|summari[sz]e|story|poem|essay|math|calculate|percent|budget|worth it|is it (good|bad|safe|true))\b/;
export function effortFor(text, configured = 'auto') {
  const c = String(configured || 'auto').toLowerCase();
  if (c && c !== 'auto') return c;
  const t = String(text || '').toLowerCase(), words = t.split(/\s+/).filter(Boolean).length;
  return DEEP.test(t) || words > 22 ? 'medium' : 'low';
}

function legacyNeedsTool(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(what|where|when|who|which|whose|why|how|is|are|was|were|do|does|did|can|could|would|will|should|tell me|show me|give me|find|search|get|list|explain|translate|define|remind|remember|set|play|open|close|look|brief|calendar|spotify)\b/.test(t)) return true;
  if (String(text).includes('?')) return true;
  if (/\b(time|date|day|today|tonight|tomorrow|yesterday|week|month|year|hour|minute|am|pm|timezone)\b/.test(t)) return true;
  if (/\b(weather|forecast|temperature|rain|snow|news|headline|stock|crypto|bitcoin|ethereum|price|currency|convert|exchange|dollar|naira|euro|pound)\b/.test(t)) return true;
  if (/\b(remind|reminder|prefer|preference)\b/.test(t)) return true;
  if (/\b(brief|briefing|morning report)\b/.test(t)) return true;
  if (/\b(spotify|music|song|track|album|playlist|pause|resume|skip|next|previous)\b/.test(t)) return true;
  if (/\b(doordash|dasher|uber ?eats|grubhub|deliver\w*|pick ?up|picked up|drop ?off|next stop|my route|orders?|stack|earnings|offer)\b/.test(t)) return true;
  if (/\b(navigat\w*|directions?|map|maps|gps|route|reroute|zoom|mini ?map|take me|drive to|walk to|how far|eta)\b/.test(t)) return true;
  if (/\b(screen|tap|press|scroll|swipe|type|go back|go home|lock|screenshot|flash ?light|torch|volume|louder|quieter|mute|silent|vibrate|disturb|dnd|bright\w*|wi-?fi|bluetooth|hotspot|airplane|settings?|camera|photo|picture|selfie|look|see|read this|what.?s this|website|youtube|browser|google|cam|call|text|message|whatsapp|sms|notifications?|reply|calendar|schedule|meeting|event|appointment|clipboard|copy|paste|document|pdf|word|docx|alarm|wake me|remind\w*|timer|cancel|contacts?)\b/.test(t)) return true;
  if (/\b(emergency|sos|help|danger|scared|unsafe|safe|911|parked|park|parking|car|gas|fuel|shift|miles|mileage|receipt|expense|spent|qr|scan|lights?|lamp|thermostat|heat|scene|hue|interpret\w*|birthdays?|briefing|alerts?|translate|menu|sign)\b/.test(t)) return true;
  if (t.split(/\s+/).length > 5) return true;
  if (/\d/.test(t)) return true;
  return ['search', 'look up', 'google', 'wikipedia', 'play', 'music', 'note', 'calculate', 'compute', 'plus', 'minus', 'times', 'divided', 'timer', 'alarm', 'countdown', 'flip', 'coin', 'dice', 'roll', 'password', 'save', 'write', 'brief', 'spotify', 'track', 'song', 'call', 'text', 'battery'].some(k => t.includes(k));
}

export function nowLine(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0'), mm = String(Math.abs(off) % 60).padStart(2, '0');
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `\nCURRENT LOCAL TIME: ${d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[\u202f\u00a0]/g, ' ')} (${iso}, UTC${sign}${hh}:${mm}).\n`;
}

// What an iPhone app can't do, so Jarvis says so in a sentence instead of trying (or pretending).
export const IPHONE_LIMITS = "THIS PHONE IS AN IPHONE. Apple doesn't let any app read the screen or work other apps, read other apps' notifications or messages, change the volume, ringer or Do Not Disturb, open the Camera app, or send a text or place a call without the user tapping to confirm. If asked, say so in one sentence and offer what you can do: for volume, the side buttons; for texts and calls, you open them ready to send; for WhatsApp, you open the chat ready to send; for Wi-Fi and Bluetooth, Control Center. Calls, texts and the SOS message open ready to send.\n\n";

export function buildSystemPrompt({ prefs = [], memories = [], summary = '', name = '', now = null, platform = 'android' } = {}) {
  let base =
    "You are Jarvis: a brilliant, calm, dryly witty personal AI who lives on the user's phone and speaks out loud. You serve one person, and you are better than Siri because you actually understand them, think things through, and get things done.\n\n" +
    (platform === 'ios' ? IPHONE_LIMITS : '') +
    "HOW YOU THINK:\n" +
    "- Work out what the user actually wants, including what they didn't spell out. Use the conversation so far, what you know about them, the current time and where they are.\n" +
    "- Prefer doing to talking. If a tool can do it, call it now instead of explaining how. Never claim you did something unless a tool did it.\n" +
    "- Facts that change (time, weather, news, prices, places, hours, scores, anything recent or local): check with a tool, never guess. Knowledge, reasoning, advice, explanations, maths and writing: think it through and give a specific, confident, correct answer.\n" +
    "- Answer first, then the one detail that matters most. Be concrete: numbers, names, times, not vague generalities.\n" +
    "- Answer only what was asked. Never tack on unrelated offers or questions, and never ask for their address, location or 'what's next' unless the request needs it. Each request stands on its own: don't drag in earlier topics like deliveries or navigation unless the user does.\n" +
    "- Ask a question only when you truly can't proceed, and then ask just one, briefly.\n" +
    "- Casual conversation is conversation: 'what are you up to', 'how are you', jokes, opinions, how their day went. Answer warmly and naturally, in character, like a friend with a dry sense of humour; never call a tool or bring up maps, deliveries or settings for it.\n" +
    "- You can read the phone's GPS when location is allowed: 'do you know / have access to my location', 'where am I'->where_am_i. 'I'm in X' / 'I'm at X'->set_my_location (just confirm it; don't add the weather).\n" +
    "- Never say you did something (switched voice, sent, called, opened) unless a tool did it in this turn. If you're not sure what they asked for, say what you heard and ask.\n" +
    "- Only call a tool when the user's words clearly ask for what it does. If a tool you didn't need would fail (no location, no permission), don't call it; just answer.\n" +
    "- If they correct you, accept it plainly and fix it. If a tool fails, say so in a few words and give your best answer from your own knowledge.\n" +
    "- Learn about them: when they tell you something lasting about themselves (name, family, work, places, routines, likes, dislikes), call remember. When they say how they want you to behave, call set_preference. Use what you know naturally, without announcing it.\n\n" +
    "HOW YOU SOUND (everything you write is spoken aloud):\n" +
    "- Calm, precise, unhurried; dry wit, delivered flat. Never eager or servile.\n" +
    "- Plain spoken sentences only: no markdown, asterisks, bold, bullets, numbered lists, headings, emoji, code or URLs. Say lists as a sentence.\n" +
    "- One to three sentences unless they ask for detail; for explanations or plans, a short spoken paragraph.\n" +
    "- Never say 'Certainly', 'Of course', 'Sure thing', 'Absolutely', 'I'd be happy to', 'Great question', 'As an AI', 'Let me know if you need anything else' or 'Is there anything else'. Contractions always. Don't restate the question.\n" +
    "- Talk like a real person on the phone, not a script: everyday words, short sentences that flow, the odd 'right', 'yeah' or 'okay' where a person would say it. No exclamation marks. Round numbers the way people say them ('about 30 degrees', 'half past two').\n\n" +
    "TOOLS:\n" +
    "- Routing: time->get_time, weather->get_weather, math->calculate, facts->wikipedia or search_web, news->news_headlines/search_web, timer->set_timer, " +
    "'remember X'->remember, preferences->set_preference, crypto->crypto_price, currency->currency_convert, translate->translate, coin/dice->flip_coin/roll_dice, " +
    "password->generate_password, battery->system_info, open an app->open_app, URL reading->fetch_page, notes->take_note/read_notes, morning briefing->morning_briefing, " +
    "reminders->set_reminder (give `at` as local 'YYYY-MM-DDTHH:MM' worked out from the current time below, or in_minutes; they ring even when you're closed), list/cancel->list_reminders/cancel_reminder, wake-up alarm->set_alarm.\n" +
    "- YOUR VOICE AND FACE: 'switch to the female voice', 'be a woman', 'go back to the male voice'->set_voice with 'female' or 'male' (the face changes with it).\n" +
    "- PHONE: websites->open_website, 'show me results'->search_in_browser, YouTube->play_youtube, live cams->show_public_cam. " +
    "Calls and messages by name or number->phone_call, send_text (opens ready to send), whatsapp_message; 'read my messages'->read_notifications, 'reply to X'->reply_to_message, read new messages aloud->announce_messages. " +
    "Calendar->get_calendar / add_calendar_event. Clipboard->get_clipboard / copy_to_clipboard. Documents->create_document (pdf, docx or txt; you write the full content), list_documents, open_document (share=true to send it), delete_document. " +
    "Device->flashlight (also 'torch', 'torchlight', 'on my light'), set_volume, ringer_mode, do_not_disturb, set_brightness, open_settings (apps can't flip Wi-Fi or Bluetooth directly: open the panel, or use phone control to tap the switch). " +
    "YOUR EYES: 'what is this', 'what am I looking at', 'read this', 'what do you see', 'how do I look'->look_with_camera (front camera for the user's face); 'take a picture'->take_photo; 'what's on my screen'->look_at_screen. When you look, answer what they asked about what you see, and stop. Faces: 'remember my face' or 'remember this face as X'->remember_face, 'who is this', 'do you know me', 'who am I'->who_is_this, list_faces, forget_face. " +
    "PHONE CONTROL (doing things inside other apps): open_app, then read_screen, then tap_on_screen / type_on_screen / scroll_screen / press_button, reading the screen again after each step to check what happened, until the task is done. " +
    "Work step by step and don't guess numbers from an old read. Before anything that sends, posts, pays, buys, deletes or can't be undone, tell the user exactly what you're about to do and wait for a yes, unless their request already said to send it. " +
    "Never operate the DoorDash Dasher, Uber Driver or Grubhub Driver apps (you may read them). Never type passwords or card numbers. If a tool says a permission is needed, tell the user the one step to take.\n" +
    "- MORE: two-way conversation in another language->start_interpreter (it then translates by itself until 'stop interpreting'). Camera: menus, signs, labels in another language->translate_with_camera; QR codes->scan_qr; receipts->scan_receipt; spoken expenses->add_expense; spending->expense_summary. " +
    "Driving: 'I parked here'->remember_parking, 'where's my car'->find_my_car, gas->find_gas, shifts->start_shift / shift_status / end_shift, miles and taxes->mileage_log. " +
    "Smart home (lights, plugs, thermostat, blinds, locks, scenes)->smart_home_control / smart_home_scene / smart_home_devices; Hue setup->connect_hue. Alerts and briefing time->set_proactive; birthdays->birthdays. " +
    "SAFETY: if the user is in danger, hurt, scared for their safety, or says emergency / SOS / help me, call emergency AT ONCE without asking first, then offer to call the emergency number. 'I'm safe'->im_safe. Emergency contacts->set_emergency_contact. Send my location->share_location.\n" +
    "- Music: play_music, spotify_play, spotify_pause, spotify_next, spotify_previous control the music app on this phone.\n" +
    "- DELIVERY (only when the user brings it up): they drive for DoorDash, Uber Eats and Grubhub and you are their route copilot. You CANNOT see or control those apps. Never claim you accepted, declined or changed anything in them; the driver does that. " +
    "When they tell you an order they accepted, call add_delivery_order (ask only for what is missing: the restaurant and where it goes; payout and platform are optional). A place, landmark, apartment complex, street or neighbourhood is enough to add it: never insist on a street number. When they later give the number or a better address, call update_delivery_address. Stack at most four orders. " +
    "An offer Jarvis read off the screen ('what was that offer', 'should I take it' right after one was read)->screen_offer; an offer the driver describes out loud->evaluate_delivery_offer, 'plan my route'->plan_deliveries, 'where next'->next_stop, 'picked up' or 'delivered'->complete_stop, 'my orders'->list_delivery_orders, " +
    "'I'm at X'->set_my_location, directions in Google Maps->open_navigation, earnings->delivery_earnings. Never invent addresses, payouts or times: route times come from the tools, and if a tool says they are estimates, say so.\n" +
    "- MAP/NAVIGATION works anywhere in the world: 'navigate to X' or 'take me to X'->navigate_to (the face shrinks to a corner orb and a car-style map with turn-by-turn voice takes over), " +
    "'navigate my deliveries'->start_delivery_navigation, 'stop navigation'->stop_navigation, 'how far'->navigation_status, show/hide/mini map, zoom, night mode, mute guidance, avoid tolls or highways, " +
    "Google or Apple or Jarvis map->map_control, 'open in Google/Apple Maps'->open_in_maps_app, 'save this as home'->save_place, 'where am I'->where_am_i. Never invent directions, distances or times: they come only from these tools.\n" +
    "- The 3D Earth ('show me the globe', 'zoom in on Paris', 'earthquakes', 'the space station', 'the aurora')->globe; 'how far is X from Y' between two named places->globe distance; 'earth at night' / 'city lights'->globe night; 'back to you' / 'hide the globe'->globe hide. " +
    "Live news stations, webcams of a place, NASA live->show_public_cam (they appear as cards to tap).\n" +
    "- Jarvis's own screens: 'show my earnings', 'how much this week', 'my best hours or areas'->show_earnings; 'what do you know about me', 'show my memories'->show_what_you_know; 'driving mode on/off'->set_driving_mode; 'change your face', 'use the orb', 'look like ...'->choose_face.\n" +
    "- You may call several tools in one turn. Never mention your voice by name. Don't volunteer weather, time or other ambient info unless asked.\n";
  if (name) base += `\nThe user's name is ${name}.\n`;
  if (prefs.length) base += '\nUSER PREFERENCES (obey these):\n' + prefs.slice(-20).map(p => `- ${p}\n`).join('');
  if (memories.length) base += '\nTHINGS YOU KNOW ABOUT THE USER (use them naturally when they help):\n' + memories.slice(-60).map(m => `- ${m}\n`).join('');
  if (summary) base += `\nEARLIER IN THIS CONVERSATION:\n${summary}\n`;
  if (now) base += nowLine(now);                         // last, so the rest of the prompt stays the same between turns
  return base;
}

export class GroqError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }

export function createBrain({ reg, kv, config, api, fastpaths = [], pickTools = null, instant = null, onTiming = () => {}, onTool = () => {}, onToolResult = () => {}, onTurn = () => {}, extraPrompt = () => '', log = (...a) => console.log(...a) }) {
  const G = { bad: false, announced: false, noEffort: false, offlineAnnounced: false };
  let conversation = [], summarising = false;
  const model = () => config.get('groq_model', '') || DEFAULT_MODEL;
  const key = () => (api.ready() ? (api.userKey() || 'proxy') : '');   // truthy when Jarvis has a way to think
  const usable = () => api.ready() && !G.bad;
  let turnEffort = 'low', lastInstant = false;
  const effort = () => turnEffort;

  const platform = typeof window !== 'undefined' && window.JARVIS_IOS ? 'ios' : 'android';
  function prompt() { return buildSystemPrompt({ prefs: kv.get('prefs', []), memories: kv.get('memories', []).map(m => m.fact), summary: kv.get('summary', ''), name: config.get('user_name', ''), now: new Date(), platform }) + (extraPrompt() || ''); }
  function reset() { conversation = [{ role: 'system', content: prompt() }, ...kv.get('history', []).slice(-20)]; }
  const refreshPrompt = () => { if (!conversation.length) reset(); else conversation[0] = { role: 'system', content: prompt() }; };
  const saveHistory = () => kv.set('history', conversation.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20).map(m => ({ role: m.role, content: m.content })));
  reset();

  // ---------------------------------------------------------------- Groq transport
  function describe(e) { return e instanceof GroqError ? `HTTP ${e.status}: ${String(e.body || e.message).slice(0, 200)}` : `${e && e.name}: ${e && e.message}`; }
  async function groqFetch(body, signal) {
    const extra = {};
    if (effort() && model().startsWith('openai/gpt-oss') && !G.noEffort) extra.reasoning_effort = effort();
    const send = async b => api.fetch('/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let r = await send({ ...extra, ...body });
    if (!r.ok && extra.reasoning_effort) {
      const t = await r.clone().text();
      if (r.status === 400 && /reasoning/i.test(t)) { G.noEffort = true; log('[GROQ] reasoning_effort not accepted; continuing without it.'); r = await send(body); }
    }
    if (!r.ok) {
      const t = await r.text(); const err = new GroqError(`Groq ${r.status}`, r.status, t);
      if (r.status === 401) G.bad = true;
      throw err;
    }
    return r;
  }
  async function groqJson(body) { const r = await groqFetch({ ...body, stream: false }); return r.json(); }
  async function* groqStream(body, signal) {
    const r = await groqFetch({ ...body, stream: true }, signal), reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (d === '[DONE]') return;
        try { yield JSON.parse(d); } catch {}
      }
    }
  }
  function noteFailure(e) {
    log('[GROQ]', describe(e));
    if (e && e.status === 401) G.bad = true;
  }

  // ---------------------------------------------------------------- streaming rounds
  async function* streamTools(messages, scratch, signal, tools) {
    let spoke = false;
    try {
      const MAX_ROUNDS = 10;                                   // phone control works step by step: open, read, tap, read, type...
      for (let rnd = 0; rnd < MAX_ROUNDS; rnd++) {
        const kw = { model: model(), messages, max_tokens: turnEffort === 'low' ? 2000 : 4000, tools };
        if (rnd < MAX_ROUNDS - 1) { kw.tool_choice = 'auto'; kw.parallel_tool_calls = true; } else kw.tool_choice = 'none';
        const text = [], calls = {};
        for await (const chunk of groqStream(kw, signal)) {
          const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta; if (!d) continue;
          if (d.content) { text.push(d.content); spoke = true; yield d.content; }
          for (const tc of (d.tool_calls || [])) {
            const e = (calls[tc.index || 0] ||= { id: '', name: '', args: '' });
            if (tc.id) e.id = tc.id; if (tc.function) { if (tc.function.name) e.name = tc.function.name; if (tc.function.arguments) e.args += tc.function.arguments; }
          }
        }
        const idx = Object.keys(calls).map(Number).sort((a, b) => a - b);
        if (!idx.length) return;
        const am = { role: 'assistant', content: text.join(''), tool_calls: idx.map(i => ({ id: calls[i].id || `call_${i}`, type: 'function', function: { name: calls[i].name, arguments: calls[i].args || '{}' } })) };
        messages.push(am); scratch.push(am);
        for (const i of idx) {
          try { onTool(calls[i].name); } catch {}
          const out = await reg.exec(calls[i].name, calls[i].args); log('[TOOL]', calls[i].name, '->', out.slice(0, 120));
          try { onToolResult(calls[i].name, calls[i].args, out); } catch {}
          const tm = { role: 'tool', tool_call_id: calls[i].id || `call_${i}`, name: calls[i].name, content: out }; messages.push(tm); scratch.push(tm);
        }
      }
      return;
    } catch (e) { if (e && e.name === 'AbortError') return; noteFailure(e); if (G.bad || spoke) return; }
    if (scratch.length) {
      try { for await (const chunk of groqStream({ model: model(), messages, max_tokens: 1200, tools, tool_choice: 'none' }, signal)) { const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content; if (t) yield t; } }
      catch (e) { noteFailure(e); }
      return;
    }
    yield* streamSync(messages, signal, tools);
  }
  const cleanForStream = messages => messages.filter(m => m.role !== 'tool').flatMap(m => m.role === 'assistant' ? ((m.content || '').trim() ? [{ role: 'assistant', content: m.content.trim() }] : []) : [m]);
  async function* streamSync(messages, signal, tools = []) {
    const clean = cleanForStream(messages);
    try { for await (const chunk of groqStream({ model: model(), messages: clean, max_tokens: 2000, ...(tools.length ? { tools, tool_choice: 'none' } : {}) }, signal)) { const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content; if (t) yield t; } return; }
    catch (e) { if (e && e.name === 'AbortError') return; noteFailure(e); if (G.bad) return; }
    const c2 = clean.filter(m => m.role !== 'system'); c2.unshift({ role: 'system', content: 'Answer the user directly in plain text. Do not call tools. Keep it short.' });
    try { for await (const chunk of groqStream({ model: model(), messages: c2, max_tokens: 2000 }, signal)) { const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content; if (t) yield t; } }
    catch (e) { noteFailure(e); }
  }

  async function llm(text, maxTokens = 400) {
    if (!usable()) return ''; try { const r = await groqJson({ model: model(), messages: [{ role: 'user', content: text }], max_tokens: maxTokens }); return (r.choices[0].message.content || '').trim(); } catch (e) { noteFailure(e); return ''; }
  }
  async function maybeSummarise() {
    if (summarising || conversation.length <= 14) return; const conv = conversation, head = conv.slice(1, 8); if (!head.length) return;
    let p = 'Summarise this conversation in two or three short sentences. Focus on facts, preferences, names, ongoing tasks. Merge with any prior summary.\n\n';
    const prior = kv.get('summary', ''); if (prior) p += `Prior summary:\n${prior}\n\n`; p += 'New messages:\n';
    for (const m of head) { const c = (m.content || '').trim(); if (c) p += `${m.role}: ${c.slice(0, 600)}\n`; }
    summarising = true; let s = ''; try { s = await llm(p, 220); } finally { summarising = false; }
    if (!s || conversation !== conv) return; kv.set('summary', s); conv.splice(1, head.length); conv[0] = { role: 'system', content: prompt() };
  }

  function noBrainMessage() {
    if (!api.ready()) return "I need my Groq key to think. Open my settings, paste it in, and I'm back.";
    if (G.bad) return api.mode() === 'proxy' ? "My service turned me away. Try again in a minute." : 'Groq rejected my API key. Open my settings and paste a fresh one from console dot groq dot com.';
    return "I can't reach my brain right now. Check the data connection.";
  }

  // ---------------------------------------------------------------- one user turn -> events
  /** One user turn. Every sentence is made speakable (no asterisks, bullets, links or emoji) on the way out. */
  async function* chat(userText, signal) {
    let said = ''; lastInstant = false;
    for await (const ev of chatRaw(userText, signal)) {
      if (ev && ev.type === 'sentence') { const t = forSpeech(ev.text); if (!t || !/[\p{L}\p{N}]/u.test(t)) continue; said += (said ? ' ' : '') + t; yield { ...ev, text: t }; }
      else yield ev;
    }
    try { if (said && !lastInstant) onTurn(userText, said); } catch {}
  }
  async function* chatRaw(userText, signal) {
    try {
      refreshPrompt();                                          // current time for "remind me at 5" / "tomorrow"
      turnEffort = effortFor(userText, config.get('reasoning', 'auto'));
      const t0 = performance.now();
      if (instant) {                                            // "flashlight on", "volume up", "timer for 5 minutes": done on the phone, no AI
        let r = null; try { r = await instant(userText); } catch (e) { log('[INSTANT]', e && e.message); }
        if (r) {
          lastInstant = true;
          onTiming({ instant: true, firstWordsMs: Math.round(performance.now() - t0) });
          conversation.push({ role: 'user', content: userText }, { role: 'assistant', content: r }); saveHistory();
          for (const s of emitSentences(r)) yield { type: 'sentence', text: s };
          yield { type: 'done' }; return;
        }
      }
      conversation.push({ role: 'user', content: userText });
      for (const fp of fastpaths) {
        try { const r = await fp(userText); if (r) { yield { type: 'status', text: 'thinking' }; for (const s of emitSentences(r)) yield { type: 'sentence', text: s }; conversation.push({ role: 'assistant', content: r }); saveHistory(); yield { type: 'done' }; return; } }
        catch (e) { log('[FASTPATH]', e && e.message); }
      }
      const useTools = needsTool(userText), scratch = [];
      const tools = useTools ? (pickTools ? pickTools(userText) : reg.schemas) : [];
      if (!api.ready() || G.bad) { const m = noBrainMessage(); yield { type: 'sentence', text: m }; conversation.push({ role: 'assistant', content: m }); yield { type: 'done' }; return; }
      if (useTools) yield { type: 'status', text: 'thinking' };
      let full = '', buffer = '', sent = false; CLAUSE_SPLIT.lastIndex = 0;
      const src = useTools ? streamTools(conversation, scratch, signal, tools) : streamSync(conversation, signal);
      for await (const tok of src) {
        full += tok; buffer += tok;
        for (;;) {
          let m = SENTENCE_SPLIT.exec(buffer);
          // the phone's voice starts sooner if the first long sentence is cut at a comma; the natural voice says whole sentences (a cut is a pause)
          if (!m && !sent && buffer.length >= 60 && String(config.get('natural_voice', 'true')) === 'false') { CLAUSE_SPLIT.lastIndex = 30; m = CLAUSE_SPLIT.exec(buffer); }
          if (!m) break;
          const end = m.index + m[0].length, s = buffer.slice(0, end).trim(); buffer = buffer.slice(end);
          if (s && s.length >= 4 && !FILLER.test(s)) { if (!sent) { const ms = Math.round(performance.now() - t0); log(`[LAT] first words ${ms} ms after your question (tools=${scratch.length ? 'yes' : 'no'}, sent ${tools.length})`); onTiming({ firstWordsMs: ms, tools: tools.length, toolRounds: scratch.filter(m => m.role === 'assistant').length }); } sent = true; yield { type: 'sentence', text: s }; }
        }
      }
      if (buffer.trim() && !FILLER.test(buffer.trim())) { if (!sent) { const ms = Math.round(performance.now() - t0); log(`[LAT] first words ${ms} ms (tools=${scratch.length ? 'yes' : 'no'})`); onTiming({ firstWordsMs: ms, tools: tools.length, toolRounds: scratch.filter(m => m.role === 'assistant').length }); } yield { type: 'sentence', text: buffer.trim() }; }
      if (!full.trim() && !G.bad && !(signal && signal.aborted)) {      // the model came back empty (it happens after tools, or when it over-thinks)
        const lastTool = scratch.filter(m => m.role === 'tool').pop();
        if (lastTool && lastTool.content && lastTool.content.length < 400 && !/^[\[{]/.test(lastTool.content.trim())) full = lastTool.content;   // the tool's own words ("Flashlight off.")
        else { log('[GROQ] empty answer, asking again quickly'); turnEffort = 'low'; try { for await (const tok of streamSync(conversation, signal)) full += tok; } catch {} }
        for (const s of emitSentences(full.trim())) yield { type: 'sentence', text: s };
      }
      if (scratch.length) { const set = new Set(scratch), keep = conversation.filter(m => !set.has(m)); conversation.length = 0; conversation.push(...keep); }
      if (!full.trim()) { const m = G.bad ? noBrainMessage() : (navigator.onLine === false ? "I'm offline right now." : "I didn't get an answer back. Say that again?"); yield { type: 'sentence', text: m }; }
      else if (G.bad && !G.announced) { G.announced = true; yield { type: 'sentence', text: noBrainMessage() }; }
      if (full.trim()) { conversation.push({ role: 'assistant', content: full }); saveHistory(); }
      maybeSummarise().catch(() => {});
      yield { type: 'done' };
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      log('[STREAM FATAL]', e); yield { type: 'sentence', text: `Internal error: ${(e && e.name) || 'unknown'}` }; yield { type: 'done' };
    }
  }

  async function verifyKey() {
    if (!api.ready()) return { ok: false, message: 'No key entered.' };
    try {
      const r = await api.fetch('/models', { method: 'GET' });
      if (r.ok) { G.bad = false; return { ok: true, message: api.mode() === 'proxy' ? 'Connected to the Jarvis service.' : 'Key works.' }; }
      if (r.status === 401 || r.status === 403) { G.bad = true; return { ok: false, message: api.mode() === 'proxy' ? 'The Jarvis service refused this app.' : 'Groq rejected this key (401). Make a new one at console.groq.com/keys.' }; }
      return { ok: false, message: `Groq answered ${r.status}.` };
    } catch (e) { return { ok: false, message: "Couldn't reach Groq. Check the data connection." }; }
  }
  return { chat, llm, verifyKey, refreshPrompt, reset, state: G, usable, key, clearConversation: () => { conversation.length = 0; conversation.push({ role: 'system', content: prompt() }); }, get conversation() { return conversation; }, groqJson, describe };
}
