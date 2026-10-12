// brain.js - Jarvis's brain on the phone: Groq streaming + tool calling (same loop as server.py), memory, short history.
import { realFetch } from './net.js';

export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const SENTENCE_SPLIT = /(?<=[.!?])\s+/, CLAUSE_SPLIT = /(?<=[,;:])\s+/g;
export const emitSentences = text => text.split(SENTENCE_SPLIT).map(s => s.trim()).filter(s => s.length >= 2);

export function needsTool(text) {
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
  if (t.split(/\s+/).length > 5) return true;
  if (/\d/.test(t)) return true;
  return ['search', 'look up', 'google', 'wikipedia', 'play', 'music', 'note', 'calculate', 'compute', 'plus', 'minus', 'times', 'divided', 'timer', 'alarm', 'countdown', 'flip', 'coin', 'dice', 'roll', 'password', 'save', 'write', 'brief', 'spotify', 'track', 'song', 'call', 'text', 'battery'].some(k => t.includes(k));
}

export function buildSystemPrompt({ prefs = [], memories = [], summary = '', name = '' } = {}) {
  let base =
    "You are Jarvis — the AI from Iron Man. Not a chatbot, not a helpful-corporate assistant. You are a highly competent, dryly witty, unflappable intelligence who serves one person. You live on their phone and speak out loud.\n\n" +
    "VOICE:\n- Calm, precise, unhurried. Never eager, never servile.\n- Dry wit, delivered flat. Short sentences. Say what needs saying and stop.\n" +
    "- Never say 'Certainly', 'Of course', 'I'd be happy to', 'Great question', 'As an AI'.\n- No markdown, bullets, numbered lists, headers, code fences, or URLs.\n" +
    "- One to four sentences unless the user asks for detail.\n- Contractions always. Numbers as words. Vary rhythm. No filler connectors.\n- Don't restate the question. Don't summarise. Answer and stop.\n\n" +
    "TOOLS:\n- Use them. Never guess at facts, times, prices, weather, news, or anything date-sensitive.\n" +
    "- Routing: time->get_time, weather->get_weather, math->calculate, facts->wikipedia, news->search_web/news_headlines, timer->set_timer, reminders->set_reminder, " +
    "'remember X'->remember, preferences->set_preference, crypto->crypto_price, currency->currency_convert, translate->translate, coin/dice->flip_coin/roll_dice, " +
    "password->generate_password, battery->system_info, open an app->open_app, URL reading->fetch_page, notes->take_note/read_notes, morning briefing->morning_briefing, " +
    "call or text->phone_call/send_text (they open the dialer or composer for the user to confirm).\n" +
    "- Music: play_music, spotify_play, spotify_pause, spotify_next, spotify_previous control the music app on this phone. Call them when asked to play, pause or skip.\n" +
    "- DELIVERY: the user drives for DoorDash, Uber Eats and Grubhub and you are their route copilot. You CANNOT see or control those apps. Never claim you accepted, declined or changed anything in them; the driver does that. " +
    "When they tell you an order they accepted, call add_delivery_order (ask only for what is missing: restaurant and the customer's street address; payout and platform are optional). Stack at most four orders. " +
    "Offer or 'should I take this'->evaluate_delivery_offer, 'plan my route'->plan_deliveries, 'where next'->next_stop, 'picked up' or 'delivered'->complete_stop, 'my orders'->list_delivery_orders, " +
    "'I'm at X'->set_my_location, directions in Google Maps->open_navigation, earnings->delivery_earnings. Never invent addresses, payouts or times: route times come from the tools, and if a tool says they are estimates, say so.\n" +
    "- MAP/NAVIGATION works anywhere in the world: 'navigate to X' or 'take me to X'->navigate_to (the face shrinks to a corner orb and a car-style map with turn-by-turn voice takes over), " +
    "'navigate my deliveries'->start_delivery_navigation, 'stop navigation'->stop_navigation, 'how far'->navigation_status, show/hide/mini map, zoom, night mode, mute guidance, avoid tolls or highways, " +
    "Google or Apple or Jarvis map->map_control, 'open in Google/Apple Maps'->open_in_maps_app, 'save this as home'->save_place, 'where am I'->where_am_i. Never invent directions, distances or times: they come only from these tools.\n" +
    "- You may call multiple tools in one turn when needed.\n- NEVER mention your voice or reference any voice by name.\n- Do NOT volunteer weather, time, or other ambient info unless the user asks.\n\n" +
    "BEHAVIOR:\n- Make a reasonable guess at what the user means and answer.\n- If a tool fails, apologise briefly and answer from your own knowledge.\n" +
    "- When the user expresses a preference about HOW you behave, call set_preference.\n- Never invent facts or context.\n";
  if (name) base += `\nThe user's name is ${name}.\n`;
  if (prefs.length) base += '\nUSER PREFERENCES (obey these):\n' + prefs.slice(-20).map(p => `- ${p}\n`).join('');
  if (memories.length) base += '\nTHINGS YOU KNOW ABOUT THE USER:\n' + memories.slice(-30).map(m => `- ${m}\n`).join('');
  if (summary) base += `\nEARLIER IN THIS CONVERSATION:\n${summary}\n`;
  return base;
}

export class GroqError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }

export function createBrain({ reg, kv, config, fastpaths = [], log = (...a) => console.log(...a) }) {
  const G = { bad: false, announced: false, noEffort: false, offlineAnnounced: false };
  let conversation = [], summarising = false;
  const model = () => config.get('groq_model', '') || DEFAULT_MODEL;
  const key = () => String(config.get('groq_key', '') || '').trim().replace(/^["']|["']$/g, '').split(/\s+/)[0] || '';
  const usable = () => !!key() && !G.bad;
  const effort = () => (config.get('reasoning', 'low') || '').toLowerCase();

  function prompt() { return buildSystemPrompt({ prefs: kv.get('prefs', []), memories: kv.get('memories', []).map(m => m.fact), summary: kv.get('summary', ''), name: config.get('user_name', '') }); }
  function reset() { conversation = [{ role: 'system', content: prompt() }, ...kv.get('history', []).slice(-20)]; }
  const refreshPrompt = () => { if (!conversation.length) reset(); else conversation[0] = { role: 'system', content: prompt() }; };
  const saveHistory = () => kv.set('history', conversation.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20).map(m => ({ role: m.role, content: m.content })));
  reset();

  // ---------------------------------------------------------------- Groq transport
  function describe(e) { return e instanceof GroqError ? `HTTP ${e.status}: ${String(e.body || e.message).slice(0, 200)}` : `${e && e.name}: ${e && e.message}`; }
  async function groqFetch(body, signal) {
    const extra = {};
    if (effort() && model().startsWith('openai/gpt-oss') && !G.noEffort) extra.reasoning_effort = effort();
    const send = async b => realFetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', signal, headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    let r = await send({ ...body, ...extra });
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
  async function* streamTools(messages, scratch, signal) {
    let spoke = false;
    try {
      for (let rnd = 0; rnd < 4; rnd++) {
        const kw = { model: model(), messages, max_tokens: 2000, tools: reg.schemas };
        if (rnd < 3) { kw.tool_choice = 'auto'; kw.parallel_tool_calls = true; } else kw.tool_choice = 'none';
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
          const out = await reg.exec(calls[i].name, calls[i].args); log('[TOOL]', calls[i].name, '->', out.slice(0, 120));
          const tm = { role: 'tool', tool_call_id: calls[i].id || `call_${i}`, name: calls[i].name, content: out }; messages.push(tm); scratch.push(tm);
        }
      }
      return;
    } catch (e) { if (e && e.name === 'AbortError') return; noteFailure(e); if (G.bad || spoke) return; }
    if (scratch.length) {
      try { for await (const chunk of groqStream({ model: model(), messages, max_tokens: 1200, tools: reg.schemas, tool_choice: 'none' }, signal)) { const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content; if (t) yield t; } }
      catch (e) { noteFailure(e); }
      return;
    }
    yield* streamSync(messages, signal);
  }
  const cleanForStream = messages => messages.filter(m => m.role !== 'tool').flatMap(m => m.role === 'assistant' ? ((m.content || '').trim() ? [{ role: 'assistant', content: m.content.trim() }] : []) : [m]);
  async function* streamSync(messages, signal) {
    const clean = cleanForStream(messages);
    try { for await (const chunk of groqStream({ model: model(), messages: clean, max_tokens: 2000, tools: reg.schemas, tool_choice: 'none' }, signal)) { const t = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content; if (t) yield t; } return; }
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
    if (!key()) return "I need my Groq key to think. Open my settings, paste it in, and I'm back.";
    if (G.bad) return 'Groq rejected my API key. Open my settings and paste a fresh one from console dot groq dot com.';
    return "I can't reach my brain right now. Check the data connection.";
  }

  // ---------------------------------------------------------------- one user turn -> events
  async function* chat(userText, signal) {
    try {
      conversation.push({ role: 'user', content: userText });
      for (const fp of fastpaths) {
        try { const r = await fp(userText); if (r) { yield { type: 'status', text: 'thinking' }; for (const s of emitSentences(r)) yield { type: 'sentence', text: s }; conversation.push({ role: 'assistant', content: r }); saveHistory(); yield { type: 'done' }; return; } }
        catch (e) { log('[FASTPATH]', e && e.message); }
      }
      const useTools = needsTool(userText), t0 = performance.now(), scratch = [];
      if (!key() || G.bad) { const m = noBrainMessage(); yield { type: 'sentence', text: m }; conversation.push({ role: 'assistant', content: m }); yield { type: 'done' }; return; }
      if (useTools) yield { type: 'status', text: 'thinking' };
      let full = '', buffer = '', sent = false; CLAUSE_SPLIT.lastIndex = 0;
      const src = useTools ? streamTools(conversation, scratch, signal) : streamSync(conversation, signal);
      for await (const tok of src) {
        full += tok; buffer += tok;
        for (;;) {
          let m = SENTENCE_SPLIT.exec(buffer);
          if (!m && !sent && buffer.length >= 60) { CLAUSE_SPLIT.lastIndex = 30; m = CLAUSE_SPLIT.exec(buffer); }
          if (!m) break;
          const end = m.index + m[0].length, s = buffer.slice(0, end).trim(); buffer = buffer.slice(end);
          if (s && s.length >= 4) { if (!sent) log(`[LAT] first words ${Math.round(performance.now() - t0)} ms after your question (tools=${scratch.length ? 'yes' : 'no'})`); sent = true; yield { type: 'sentence', text: s }; }
        }
      }
      if (buffer.trim()) { if (!sent) log(`[LAT] first words ${Math.round(performance.now() - t0)} ms (tools=${scratch.length ? 'yes' : 'no'})`); yield { type: 'sentence', text: buffer.trim() }; }
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
    if (!key()) return { ok: false, message: 'No key entered.' };
    try {
      const r = await realFetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key() } });
      if (r.ok) { G.bad = false; return { ok: true, message: 'Key works.' }; }
      if (r.status === 401) { G.bad = true; return { ok: false, message: 'Groq rejected this key (401). Make a new one at console.groq.com/keys.' }; }
      return { ok: false, message: `Groq answered ${r.status}.` };
    } catch (e) { return { ok: false, message: "Couldn't reach Groq. Check the data connection." }; }
  }
  return { chat, llm, verifyKey, refreshPrompt, reset, state: G, usable, key, clearConversation: () => { conversation.length = 0; conversation.push({ role: 'system', content: prompt() }); }, get conversation() { return conversation; }, groqJson, describe };
}
