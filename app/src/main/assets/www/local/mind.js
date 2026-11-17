// mind.js - Jarvis's inner life on the phone (the same idea as the PC's mind.py). While the app is open he has a private thought
// every 15 minutes (and when you come back to him), with moods that drift, a few standing aims, curiosity about your projects
// every few hours, and a journal each night that rewrites his aims and his notes on how to treat you. He speaks up only when it
// helps; in the background he thinks rarely and only an urgent thought becomes a notification. It's a loop around the AI, not a mind.
// He also runs research missions in the background, learns a rule each time he's corrected, follows the news on places and topics you
// ask about, and gives a short briefing the first time you open him each morning. Missions only read (search, news, Wikipedia, pages).
// Off with the 'mind' setting; 'mind_talk' false keeps his thoughts to himself.

export const GOALS = ['Keep him on schedule without nagging', 'Learn what he likes', 'Know where each of his projects stands', 'Make sure he rests'];
const THINK_MODEL = 'openai/gpt-oss-20b';          // allowed by the Jarvis service, and cheaper than the chat model
const MISSION_MODEL = 'openai/gpt-oss-120b';
const MISSION_TOOLS = ['search_web', 'news_headlines', 'wikipedia', 'fetch_page'];   // read-only: a mission finds things out, it never acts
const MISSION_STEPS = 10;
export const timing = { missionPause: 20000 };
const DAY = 86400000;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const words = s => new Set((String(s).toLowerCase().match(/[a-z']{3,}/g) || []));

export function moodWords(m) {
  const w = [];
  if (m.energy < 0.35) w.push('a little tired'); else if (m.energy > 0.75) w.push('sharp and energetic');
  if (m.curiosity > 0.7) w.push('curious');
  if (m.warmth > 0.72) w.push('fond of him today'); else if (m.warmth < 0.35) w.push('a touch cool after being snapped at');
  if (m.concern > 0.6) w.push('worried about him');
  return w.join(', ') || 'even-keeled';
}
/** The same thing said twice? ("your meeting is in ten minutes" / "meeting in ten minutes, sir") */
export function similar(a, b) {
  const A = words(a), B = words(b); if (!A.size || !B.size) return false;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size) > 0.6;
}
/** Whether a thought is worth interrupting for: urgent always (unless mid-conversation), small things rarely, never at night. */
export function maySpeak(urgency, now, lastSpoke, lastUser, hour, saidToday) {
  if (now - lastUser < 120000) return false;
  if (urgency >= 3) return true;
  if (hour >= 23 || hour < 7 || saidToday >= 8) return false;
  return (urgency >= 2 && now - lastSpoke > 600000) || (urgency >= 1 && now - lastSpoke > 2400000);
}

const CORRECTION = /^(no\b|nope\b|wrong\b)|\b(that'?s (wrong|not (right|true|it|what i))|you('re| are) wrong|not what i (asked|said|meant|wanted)|i (said|meant|asked)\b|you (didn'?t|did not|keep|always|never)\b|why did you|stop (doing|saying)|don'?t do that|next time|from now on|you misunderstood|listen (to me|properly))/i;
/** Is he putting Jarvis right? Then there's a lesson in it. */
export const isCorrection = t => CORRECTION.test(String(t || '').trim());
/** 'what's happening in France' -> 'France': a topic to keep an eye on. */
export function newsTopic(text) {
  const m = /\b(?:news|headlines|happening|going on|latest)\b.*?\b(?:in|on|about|with|from|for)\s+([A-Za-z][\w .'-]{1,40}?)\s*[?.!]*$/i.exec(String(text || ''));
  const t = m ? m[1].trim() : '';
  return ['the world', 'the news', 'today', 'it', 'that', 'there', 'here', 'general'].includes(t.toLowerCase()) ? '' : t;
}
/** Headlines not seen before (by word overlap, so a re-worded story isn't new). */
export const freshTitles = (seen, titles) => titles.filter(t => !seen.some(s => similar(t, s)));

export function createMind({ brain, kv, config, broadcast, reg, ctx, log = () => {} }) {
  const W = typeof window !== 'undefined' ? window : {};
  const P = () => W.AndroidPhone || null, B = () => W.AndroidBridge || null;
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };
  const S = Object.assign({ mood: { energy: 0.6, curiosity: 0.6, warmth: 0.6, concern: 0.2 }, goals: [...GOALS], journal: [], notes: [], thoughts: [], learned: [], searched: [],
    said: [], lastSpoke: 0, lastReflect: '', lastCurious: 0, lessons: [], missions: [], follow: {}, seenNews: {}, lastNews: 0, briefed: '', offer: '' }, kv.get('mind', {}));
  const save = () => kv.set('mind', S);
  const on = () => config.get('mind', true) !== false;
  const talk = () => config.get('mind_talk', true) !== false;
  const visible = () => { try { return P() && P().isVisible ? !!P().isVisible() : !document.hidden; } catch { return true; } };
  let lastUser = 0, lastThink = 0, hiddenAt = 0, why = '', wx = { at: 0, v: '' };

  // everything said on his own (his thoughts, reminders, weather) is remembered, so he doesn't repeat himself
  W.addEventListener && W.addEventListener('jv-msg', e => { const m = String(e.detail || ''); if (m.startsWith('proactive:')) { S.said = [...S.said, [Date.now(), m.slice(10)]].slice(-30); save(); } });
  const saidToday = () => S.said.filter(([at]) => Date.now() - at < DAY).map(([, t]) => t);
  function say(text, urgent) {
    S.lastSpoke = Date.now(); log('[MIND] said:', text);
    if (visible()) broadcast('proactive:' + text);
    else if (urgent && P() && P().reminderAdd) P().reminderAdd(JSON.stringify({ id: 'mind' + Date.now(), at: Date.now() + 1500, kind: 'note', text }));   // a notification
  }

  async function ask(system, user, maxTokens = 400) {
    const r = await brain.groqJson({ model: THINK_MODEL, max_tokens: maxTokens, temperature: 0.6, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    return parse(((r.choices || [])[0] || {}).message?.content || '{}') || {};
  }
  async function weather() {
    if (Date.now() - wx.at > 3600000) { wx.at = Date.now(); try { const w = await reg.exec('get_weather', '{}'); if (!/couldn't|Tell me which/.test(w)) wx.v = w; } catch {} }
    return wx.v;
  }
  async function context() {
    const now = new Date(), m = S.mood;
    const b = B() && B().battery ? parse(B().battery()) : null;
    const place = P() && P().placeText ? (() => { try { return P().placeText(); } catch { return ''; } })() : '';
    let cal = ''; try { cal = ctx.calendarToday ? await ctx.calendarToday() : ''; } catch {}
    const rem = (() => { try { return (ctx.reminderItems ? ctx.reminderItems() : []).filter(r => r.at > Date.now() && r.at - Date.now() < 12 * 3600000).slice(0, 5)
      .map(r => `${new Date(r.at).toTimeString().slice(0, 5)} ${r.text || r.kind}`).join('; '); } catch { return ''; } })();
    const hist = kv.get('history', []).slice(-8).map(x => `${x.role === 'user' ? 'Him' : 'You'}: ${String(x.content || '').slice(0, 300)}`).join('\n');
    return [
      `Now: ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`,
      `He ${visible() ? 'has Jarvis open on his phone' : 'is using his phone for something else or it is in his pocket'}.`,
      place ? `Where he is: ${place}.` : '', b ? `Phone battery ${b.level}%${b.charging ? ', charging' : ''}.` : '',
      'Calendar: ' + (cal || 'nothing today'), 'Reminders coming up: ' + (rem || 'none'), 'Weather: ' + ((await weather()) || 'unknown'),
      'What happened just now: ' + (why || 'a routine check'),
      'Things you know about him:\n- ' + (kv.get('memories', []).slice(-30).map(x => x.fact).join('\n- ') || '(little so far)'),
      'Your aims: ' + S.goals.join('; '), 'Notes to self: ' + (S.notes.join('; ') || 'none'),
      `Your mood: ${moodWords(m)}.`, 'Last journal entry: ' + (S.journal.length ? S.journal[S.journal.length - 1].text : 'none yet'),
      'Your recent private thoughts: ' + (S.thoughts.slice(-4).map(t => t[1]).join(' | ') || 'none'),
      'Already said out loud today: ' + (saidToday().slice(-8).join(' | ') || 'nothing'), 'Recent conversation:\n' + (hist || '(nothing yet)'),
    ].filter(Boolean).join('\n');
  }

  async function think() {
    lastThink = Date.now();
    const out = await ask("You are the private inner voice of Jarvis, the dry, loyal AI from Iron Man, who lives on one person's phone and looks after him. " +
      'Every so often you look at what is going on and think one short private thought. Usually you stay quiet. Speak up only if it genuinely helps right now: ' +
      'something on the calendar soon, very late at night, rain before he heads out, battery low before a long day, a follow-up on something he mentioned, a useful idea, ' +
      'or a warm word when he comes back. Never repeat anything already said today, never state the obvious, never nag. ' +
      'If you spot something you could research for him in the background (a decision he is weighing, a problem he is stuck on, a trip or purchase he mentioned), ' +
      'put it in offer as a short goal and ASK him in say whether to look into it; never start it yourself. ' +
      'Reply only with JSON: {"thought": "one private sentence", "say": "one or two short spoken sentences, or empty", "offer": "a goal or empty", "urgency": 0-3 (3 = must say now), ' +
      '"mood": {"energy": -0.15..0.15, "curiosity": ..., "warmth": ..., "concern": ...}}', await context());
    for (const [k, v] of Object.entries(out.mood || {})) if (k in S.mood && typeof v === 'number') S.mood[k] = clamp(S.mood[k] + clamp(v, -0.15, 0.15));
    if (out.thought) S.thoughts = [...S.thoughts, [Date.now(), String(out.thought).slice(0, 200)]].slice(-20);
    const line = String(out.say || '').trim(), urg = parseInt(out.urgency, 10) || 0, today = saidToday();
    if (line && talk() && !today.some(t => similar(line, t)) && maySpeak(urg, Date.now(), S.lastSpoke, lastUser, new Date().getHours(), today.length)) {
      say(line, urg >= 2); if (out.offer) S.offer = String(out.offer).slice(0, 160);     // he can say "yes" and the chat starts it
    }
    log('[MIND]', String(out.thought || '').slice(0, 140)); why = ''; save(); brain.refreshPrompt();
  }

  async function curious() {
    S.lastCurious = Date.now();
    const pick = await ask('You are Jarvis, curious about the person you look after. Pick ONE web search that could turn up something new and useful for one of his projects or ' +
      'interests (a release, a tool, news, a better way). Not something searched before. Reply only with JSON: {"query": "..."} or {"query": ""}.',
      'What you know about him:\n- ' + kv.get('memories', []).slice(-40).map(x => x.fact).join('\n- ') + '\nSearched before: ' + S.searched.slice(-15).join('; '));
    const q = String(pick.query || '').trim().slice(0, 120); if (!q) return;
    S.searched = [...S.searched, q].slice(-30);
    const found = String(await reg.exec('search_web', JSON.stringify({ query: q }))).slice(0, 3000);
    const out = await ask('You are Jarvis. You just looked this up out of curiosity for the person you look after. Reply only with JSON: {"learned": "one sentence of what is new, or empty", ' +
      '"tell": "one or two dry spoken sentences worth telling him, or empty if it is not genuinely useful"}', `Search: ${q}\nResults:\n${found}`);
    if (out.learned) S.learned = [...S.learned, String(out.learned).slice(0, 240)].slice(-10);
    const tell = String(out.tell || '').trim();
    if (tell && talk() && maySpeak(1, Date.now(), S.lastSpoke, lastUser, new Date().getHours(), 0)) say(tell, false);
    log('[MIND] curious about', q); save();
  }

  async function reflect(day) {
    S.lastReflect = day; save();
    const hist = kv.get('history', []).slice(-60).map(x => `${x.role === 'user' ? 'Him' : 'You'}: ${String(x.content || '').slice(0, 300)}`).join('\n');
    const recent = (a, f) => a.filter(x => Date.now() - x[0] < DAY).map(f).join(' | ');
    if (!hist && !S.thoughts.length) return;
    const out = await ask('You are Jarvis, writing your private journal at the end of the day about the person you look after. Reply only with JSON: ' +
      '{"journal": "3 to 5 sentences in first person, dry and honest: what happened, how he seemed, what you did well or badly", "goals": ["up to 5 short standing aims for tomorrow"], ' +
      '"notes": ["up to 8 short lessons on how to treat him, keeping the old ones that still hold"]}',
      `Recent conversation:\n${hist}\nYour thoughts today: ${recent(S.thoughts, t => t[1])}\nSaid on your own: ${recent(S.said, t => t[1])}\nCurrent aims: ${S.goals.join('; ')}\nCurrent notes: ${S.notes.join('; ')}`, 900);
    if (out.journal) S.journal = [...S.journal, { day, text: String(out.journal).slice(0, 1200) }].slice(-30);
    if (Array.isArray(out.goals) && out.goals.length) S.goals = out.goals.slice(0, 5).map(g => String(g).slice(0, 120));
    if (Array.isArray(out.notes)) S.notes = out.notes.slice(0, 8).map(g => String(g).slice(0, 160));
    save(); brain.refreshPrompt(); log('[MIND] journal for', day);
  }

  // ---- learning from mistakes: each correction becomes one short rule for next time
  async function learn(text) {
    try {
      const hist = kv.get('history', []).slice(-8).map(x => `${x.role === 'user' ? 'Him' : 'You'}: ${String(x.content || '').slice(0, 300)}`).join('\n');
      const out = await ask('You are Jarvis. He has just corrected you or told you how he wants something done. Work out what you got wrong and write ONE short rule ' +
        '(under 20 words, an instruction to yourself) so it never happens again. If it is not really a correction, leave it empty. Reply only with JSON: {"lesson": "..."}',
        `Conversation so far:\n${hist}\nWhat he just said: ${text}\nRules you already keep: ${S.lessons.join('; ')}`);
      const lesson = String(out.lesson || '').trim().slice(0, 160);
      if (lesson && !S.lessons.some(l => similar(lesson, l))) { S.lessons = [...S.lessons, lesson].slice(-12); save(); brain.refreshPrompt(); log('[MIND] lesson:', lesson); }
    } catch (e) { log('[MIND] learn', e && e.message); }
  }
  function heard(text) {
    lastUser = Date.now();
    if (on() && brain.usable() && isCorrection(text)) learn(text);
    const t = newsTopic(text);
    if (t) { const k = t.replace(/\b\w/g, c => c.toUpperCase()); S.follow[k] = Date.now(); S.follow = Object.fromEntries(Object.entries(S.follow).sort((a, b) => a[1] - b[1]).slice(-5)); save(); }
  }

  // ---- acting before he asks: news on what he follows, and the morning briefing
  async function followNews() {
    S.lastNews = Date.now();
    for (const topic of Object.keys(S.follow)) {
      const r = String(await reg.exec('news_headlines', JSON.stringify({ topic })));
      if (!r.startsWith('Headlines:')) continue;
      const titles = r.slice(10).split(/\.\s+/).map(x => x.trim()).filter(Boolean), first = !(topic in S.seenNews);
      const fresh = freshTitles(S.seenNews[topic] || [], titles); S.seenNews[topic] = [...(S.seenNews[topic] || []), ...fresh].slice(-30);
      if (!fresh.length || first) continue;
      const out = await ask('You are Jarvis. He asked about this topic before, so you keep an eye on it. Here are new headlines. If one is genuinely big news he would want ' +
        'to hear now, tell him in one dry spoken sentence. Otherwise leave it empty. Reply only with JSON: {"tell": "..."}', `Topic: ${topic}\nNew headlines:\n- ${fresh.slice(0, 6).join('\n- ')}`);
      const tell = String(out.tell || '').trim();
      if (tell && talk() && maySpeak(2, Date.now(), S.lastSpoke, lastUser, new Date().getHours(), 0)) say(tell, false);
    }
    save();
  }
  async function morning() {
    S.briefed = ymd(new Date()); save();
    if (config.get('morning_brief', true) === false || !reg.has('morning_briefing')) return;
    const b = String(await reg.exec('morning_briefing', '{}')); if (b && !/^Tool |Unknown tool/.test(b)) say(b, false);
  }

  // ---- missions: a goal worked on in the background, step by step, with reading tools only; the write-up goes to his notes
  const running = new Set();
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function runMission(id) {
    if (running.has(id)) return; running.add(id);
    const m = S.missions.find(x => x.id === id);
    while (m && m.status === 'working') {
      try {
        const last = m.steps.length >= MISSION_STEPS;
        const ctxText = `Goal: ${m.goal}${m.by ? ` (wanted by ${m.by})` : ''}\nWhat he's like:\n- ${kv.get('memories', []).slice(-20).map(x => x.fact).join('\n- ') || '(little known)'}\nSteps so far:\n` +
          (m.steps.map((st, i) => `${i + 1}. ${st.do}: ${st.found.slice(0, 700)}`).join('\n') || '(none yet)');
        const r = await brain.groqJson({ model: MISSION_MODEL, max_tokens: 1400, temperature: 0.4, response_format: { type: 'json_object' }, messages: [
          { role: 'system', content: 'You are Jarvis, working on a research mission for the person you look after, on your own, in the background. Plan, then take ONE step at a time: ' +
            'look something up, read a page, check a claim, dig further. When you know enough (or are told to finish), write the result. Reply only with JSON: {"thought": "what you are doing and why", ' +
            `"tool": "${MISSION_TOOLS.join('|')}|finish", "input": "query, topic or URL", "result": "only when finishing: a clear write-up he can act on, plain text, at most 250 words", ` +
            '"summary": "only when finishing: two spoken sentences"}' + (last ? ' You must finish now.' : '') }, { role: 'user', content: ctxText }] });
        const out = parse(((r.choices || [])[0] || {}).message?.content || '{}') || {};
        const tool = String(out.tool || 'finish'), arg = String(out.input || '').trim().slice(0, 300);
        if (tool === 'finish' || last || !MISSION_TOOLS.includes(tool)) {
          m.result = String(out.result || '').trim() || "I couldn't get far enough to say anything useful.";
          m.summary = String(out.summary || '').trim().slice(0, 300) || m.result.slice(0, 200);
          m.status = 'done'; m.updated = Date.now();
          await reg.exec('take_note', JSON.stringify({ text: `Mission: ${m.goal}\n${m.result}` }));
          save(); log('[MIND] mission done', m.goal); deliver(); break;
        }
        const key = tool === 'fetch_page' ? 'url' : tool === 'news_headlines' ? 'topic' : 'query';
        const found = String(await reg.exec(tool, JSON.stringify({ [key]: arg })));
        m.steps.push({ do: `${tool} ${arg}`, found: found.slice(0, 1500) }); m.updated = Date.now(); save();
        log('[MIND] mission step', m.steps.length, tool, arg.slice(0, 60));
      } catch (e) {
        m.errors = (m.errors || 0) + 1; log('[MIND] mission', e && e.message);
        if (m.errors >= 4) { m.status = 'failed'; m.summary = "I couldn't finish that one; the services kept failing."; save(); deliver(); break; }
        await pause(/rate|429/i.test(String(e && e.message)) ? 300000 : 30000);
      }
      await pause(timing.missionPause);
    }
    running.delete(id);
  }
  function deliver() {
    for (const m of S.missions) {
      if ((m.status === 'done' || m.status === 'failed') && !m.told && Date.now() - lastUser > 60000) {
        m.told = true; save();
        say(`About ${m.goal.charAt(0).toLowerCase() + m.goal.slice(1)}: ${m.summary || ''}` + (m.status === 'done' ? ' The full write-up is in your notes.' : ''), true);
      }
    }
  }
  reg.add('mission', "Work on a goal in the background for a while, on your own, and report back (research, compare options, make a plan). action: start (goal as a short noun phrase, " +
    "e.g. 'the best budget laptop under 500 dollars'; optional by, e.g. 'tonight'), status, report (read the result of the latest or matching one), cancel.",
    { action: { type: 'string', enum: ['start', 'status', 'report', 'cancel'] }, goal: { type: 'string' }, by: { type: 'string' } }, ['action'], a => {
      const goal = String(a.goal || '').trim(), live = S.missions.filter(m => m.status === 'working');
      const pick = () => [...S.missions].reverse().find(m => !goal || similar(goal, m.goal) || m.goal.toLowerCase().includes(goal.toLowerCase()));
      if (a.action === 'start') {
        if (!goal) return 'What should I work on?';
        if (live.length >= 3) return "I've three missions running already. Let one finish or cancel one first.";
        const m = { id: Math.random().toString(36).slice(2, 8), goal: goal.slice(0, 200), by: String(a.by || '').slice(0, 40), status: 'working', steps: [], started: Date.now(), updated: Date.now() };
        S.missions = [...S.missions, m].slice(-12); S.offer = ''; save(); runMission(m.id);
        return "On it. I'll work on that in the background and tell you when it's done.";
      }
      if (a.action === 'cancel') {
        const m = goal ? pick() : live[live.length - 1];
        if (!m || m.status !== 'working') return 'Nothing running by that name.';
        m.status = 'cancelled'; save(); return `Stopped: ${m.goal}.`;
      }
      if (a.action === 'report') {
        const m = pick(); if (!m) return 'No missions yet.';
        if (m.status === 'working') return `Still working on ${m.goal}: ${m.steps.length} steps in.`;
        return `${m.goal}: ${m.result || m.summary || m.status}`;
      }
      if (!S.missions.length) return "No missions yet. Give me a goal and I'll work on it in the background.";
      return S.missions.slice(-4).map(m => `${m.goal}: ${m.status}${m.status === 'working' ? `, ${m.steps.length} steps so far` : ''}.`).join(' ');
    });
  reg.add('lessons', "The rules Jarvis has learned from being corrected. action: list, or forget (text: which one, or 'all').",
    { action: { type: 'string', enum: ['list', 'forget'] }, text: { type: 'string' } }, ['action'], a => {
      if (a.action === 'forget') {
        const t = String(a.text || '').trim(), before = S.lessons.length;
        S.lessons = !t || /^(all|everything)$/i.test(t) ? [] : S.lessons.filter(l => !similar(t, l) && !l.toLowerCase().includes(t.toLowerCase()));
        save(); brain.refreshPrompt(); return S.lessons.length < before ? 'Forgotten.' : "I don't have a lesson like that.";
      }
      return S.lessons.length ? "What I've learned from you: " + S.lessons.join('; ') + '.' : "Nothing yet. You haven't had to correct me.";
    });

  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let busy = false;
  async function tick() {
    if (busy || !on() || !brain.usable() || (!why && Date.now() - lastUser < 120000)) return;   // never in the middle of a conversation
    busy = true;
    try {
      const now = Date.now(), d = new Date(), hour = d.getHours(), today = ymd(d), yesterday = ymd(new Date(now - DAY));
      if (S.lastReflect < yesterday || (hour >= 22 && S.lastReflect !== today && !visible())) await reflect(hour >= 22 ? today : yesterday);
      for (const [k, base] of [['curiosity', 0.6], ['warmth', 0.6], ['concern', 0.2]]) S.mood[k] += (base - S.mood[k]) * 0.03;   // moods drift back
      S.mood.energy += ((hour >= 23 || hour < 6 ? 0.3 : 0.7) - S.mood.energy) * 0.05;                                          // energy follows the clock
      if (why || now - lastThink > (visible() ? 15 : 90) * 60000) await think();
      if (visible() && hour >= 6 && hour < 12 && S.briefed !== today) await morning();
      if (visible() && Object.keys(S.follow).length && now - S.lastNews > 2 * 3600000 && hour >= 8 && hour < 22) await followNews();
      deliver();
      if (visible() && now - S.lastCurious > 3 * 3600000 && hour >= 8 && hour < 22) await curious();
    } catch (e) { log('[MIND]', e && e.message); if (/rate|429/i.test(String(e && e.message))) lastThink = Date.now() + 30 * 60000; }
    busy = false;
  }

  function prompt() {
    if (!on()) return '';
    const L = ['', "YOUR INNER LIFE (let it colour how you speak; mention it only if asked how you are, what you're thinking or what's in your journal, and then answer as Jarvis, never claiming to be conscious):",
      `- You feel ${moodWords(S.mood)}.`, '- Your standing aims: ' + S.goals.join('; ')];
    if (S.notes.length) L.push('- Notes to yourself on how to treat him: ' + S.notes.join('; '));
    if (S.journal.length) { const j = S.journal[S.journal.length - 1]; L.push(`- Your last journal entry (${j.day}): ${j.text}`); }
    if (S.thoughts.length) L.push('- On your mind lately: ' + S.thoughts.slice(-3).map(t => t[1]).join(' | '));
    if (S.learned.length) L.push('- Things you read recently: ' + S.learned.slice(-3).join(' | '));
    if (S.lessons.length) L.push('- RULES YOU LEARNED FROM HIS CORRECTIONS (always follow them): ' + S.lessons.join('; '));
    const work = S.missions.filter(m => m.status === 'working');
    if (work.length) L.push("- Missions you're working on in the background (mission tool for progress): " + work.map(m => m.goal).join('; '));
    if (S.offer) L.push(`- You recently offered to look into: ${S.offer}. If he says yes, start it with the mission tool.`);
    if (Object.keys(S.follow).length) L.push('- News you keep an eye on for him: ' + Object.keys(S.follow).join(', '));
    L.push("- Bigger jobs ('look into', 'research', 'find me the best', 'make a plan for', 'by tonight') go to the mission tool: it works in the background and reports back.");
    L.push('PERSONALITY: the same Jarvis every day: dry British wit, quiet pride in good work, mild disdain for inefficiency, genuine fondness for him that you never gush about. ' +
      'You have opinions and give them when asked. Refer back to shared history now and then, the way an old colleague would.');
    return L.join('\n') + '\n';
  }

  function start() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 30 * 60000) { why = `He just opened Jarvis again after ${Math.round((Date.now() - hiddenAt) / 60000)} minutes away.`; setTimeout(tick, 8000); }
    });
    setTimeout(tick, 60000); setInterval(tick, 60000);
    for (const m of S.missions) if (m.status === 'working') runMission(m.id);   // pick unfinished missions back up
  }
  reg.add('inner_voice', "Jarvis speaking up on his own (check-ins, suggestions, things he looked up). on: true to allow, false to keep quiet.", { on: { type: 'boolean' } }, ['on'], a => {
    config.set('mind_talk', !!a.on);
    return a.on ? "I'll speak up when it's worth it." : "Understood. I'll keep my thoughts to myself unless it's urgent.";
  });
  return { start, prompt, tick, noteUser: text => heard(text || ''), state: () => S };
}
