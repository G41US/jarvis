// mind.js - Jarvis's inner life on the phone (the same idea as the PC's mind.py). While the app is open he has a private thought
// every 15 minutes (and when you come back to him), with moods that drift, a few standing aims, curiosity about your projects
// every few hours, and a journal each night that rewrites his aims and his notes on how to treat you. He speaks up only when it
// helps; in the background he thinks rarely and only an urgent thought becomes a notification. It's a loop around the AI, not a mind.
// Off with the 'mind' setting; 'mind_talk' false keeps his thoughts to himself.

export const GOALS = ['Keep him on schedule without nagging', 'Learn what he likes', 'Know where each of his projects stands', 'Make sure he rests'];
const THINK_MODEL = 'openai/gpt-oss-20b';          // allowed by the Jarvis service, and cheaper than the chat model
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

export function createMind({ brain, kv, config, broadcast, reg, ctx, log = () => {} }) {
  const W = typeof window !== 'undefined' ? window : {};
  const P = () => W.AndroidPhone || null, B = () => W.AndroidBridge || null;
  const parse = s => { try { return JSON.parse(s); } catch { return null; } };
  const S = Object.assign({ mood: { energy: 0.6, curiosity: 0.6, warmth: 0.6, concern: 0.2 }, goals: [...GOALS], journal: [], notes: [], thoughts: [], learned: [], searched: [],
    said: [], lastSpoke: 0, lastReflect: '', lastCurious: 0 }, kv.get('mind', {}));
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
      'Reply only with JSON: {"thought": "one private sentence", "say": "one or two short spoken sentences, or empty", "urgency": 0-3 (3 = must say now), ' +
      '"mood": {"energy": -0.15..0.15, "curiosity": ..., "warmth": ..., "concern": ...}}', await context());
    for (const [k, v] of Object.entries(out.mood || {})) if (k in S.mood && typeof v === 'number') S.mood[k] = clamp(S.mood[k] + clamp(v, -0.15, 0.15));
    if (out.thought) S.thoughts = [...S.thoughts, [Date.now(), String(out.thought).slice(0, 200)]].slice(-20);
    const line = String(out.say || '').trim(), urg = parseInt(out.urgency, 10) || 0, today = saidToday();
    if (line && talk() && !today.some(t => similar(line, t)) && maySpeak(urg, Date.now(), S.lastSpoke, lastUser, new Date().getHours(), today.length)) say(line, urg >= 2);
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
  }
  reg.add('inner_voice', "Jarvis speaking up on his own (check-ins, suggestions, things he looked up). on: true to allow, false to keep quiet.", { on: { type: 'boolean' } }, ['on'], a => {
    config.set('mind_talk', !!a.on);
    return a.on ? "I'll speak up when it's worth it." : "Understood. I'll keep my thoughts to myself unless it's urgent.";
  });
  return { start, prompt, tick, noteUser: () => { lastUser = Date.now(); }, state: () => S };
}
