// learn.js - Jarvis learns about you from ordinary conversation. After you say something about yourself ("my sister Ada
// lives in Leeds", "I start work at 7", "I hate long answers"), a small, fast model picks out the lasting facts and they
// join what Jarvis knows (the same list "remember" writes to, shown in "what do you know about me"). Kept on this phone.

const PERSONAL = /^(i|i'm|im|i've|i'd|my|we|we're|our|me and|no|actually|call me)\b|\b(my (\w+ )?(name|wife|husband|son|daughter|kids?|sister|brother|mum|mom|dad|father|mother|friend|boss|girlfriend|boyfriend|partner|car|job|work|birthday|address|favou?rite|home|house)|i (am|was|live|stay|work|drive|like|love|enjoy|hate|prefer|usually|always|never|normally|start|finish|go|study|speak|have|don'?t like|can'?t stand))\b/i;
// Commands and questions are things to do, not things to learn ("turn on my flashlight", "what's my name").
const NOT_WORTH = /^(what|where|when|who|which|how|why|is|are|can|could|would|will|should|do|does|did|turn|switch|open|close|call|text|send|set|play|pause|stop|start|navigate|take|show|read|find|search|remind|add|remove|delete|cancel|tell|give|put|make|check|scan|look|share|go|get|lock|use|change|reply|message|book|order)\b/i;

const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
/** How alike two facts are (0..1), by shared words. */
export function similarity(a, b) {
  const A = new Set(words(a)), B = new Set(words(b)); if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
/** Add facts to a list, replacing an older fact that says nearly the same thing. Returns how many were new or updated. */
export function mergeFacts(list, facts, now = Date.now(), cap = 200) {
  let changed = 0;
  for (const raw of facts) {
    const f = String(raw || '').replace(/\s+/g, ' ').trim().replace(/^[-*•]\s*/, ''); if (f.length < 6 || f.length > 200) continue;
    const i = list.findIndex(m => similarity(m.fact, f) >= 0.75);
    if (i >= 0) { if (list[i].fact.toLowerCase() === f.toLowerCase()) continue; list.splice(i, 1); }
    list.push({ fact: f, ts: now, learned: true }); changed++;
  }
  while (list.length > cap) list.shift();
  return changed;
}
/** Is this worth a look? Statements about the user, not commands or questions. */
export function worthLearning(text) {
  const t = String(text || '').trim().replace(/^(hey |ok |okay )?jarvis[,.!]?\s*/i, '').replace(/^(please|so|well|oh|hey)[,]?\s+/i, ''); if (t.split(/\s+/).length < 3) return false;
  if (NOT_WORTH.test(t)) return false;
  return PERSONAL.test(t);
}

const SYSTEM = 'You pick out lasting facts about a user from one exchange with their voice assistant. ' +
  'Return JSON: {"facts": [...], "preferences": [...]}. facts: things the USER stated about themselves or their life that will still be true in a month ' +
  '(their name, family and friends by name, work, where they live or often go, routines, vehicle, languages, likes and dislikes). Write each as a short third-person sentence starting "The user" or with the person\'s name. ' +
  'preferences: lasting instructions about how the assistant should behave ("keep answers short", "call me boss"). ' +
  'Do NOT include: requests or tasks, questions, anything temporary (where they are right now, today\'s plans), anything the assistant said, guesses, health conditions, passwords or account numbers. ' +
  'If a fact replaces one already known, write the new version. If nothing qualifies, return empty lists.';

export function createLearner({ groqJson, kv, onChange = () => {}, enabled = () => true, log = () => {}, model = 'openai/gpt-oss-20b' }) {
  let busy = false, last = 0, queued = null;
  async function run(user, said) {
    busy = true; last = Date.now();
    try {
      const known = kv.get('memories', []).slice(-40).map(m => m.fact), prefs = kv.get('prefs', []).slice(-20);
      const r = await groqJson({ model, max_tokens: 600, reasoning_effort: 'low', response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM },
          { role: 'user', content: `Already known: ${JSON.stringify(known)}\nPreferences already set: ${JSON.stringify(prefs)}\n\nUser said: ${JSON.stringify(user)}\nAssistant replied: ${JSON.stringify(String(said).slice(0, 400))}` }] });
      let out = {}; try { out = JSON.parse((r.choices[0].message.content || '{}').replace(/^```(json)?|```$/g, '')); } catch { out = {}; }
      const facts = Array.isArray(out.facts) ? out.facts : [], wants = Array.isArray(out.preferences) ? out.preferences : [];
      const mem = kv.get('memories', []), n = mergeFacts(mem, facts); if (n) kv.set('memories', mem);
      const p = kv.get('prefs', []), pList = p.map(x => ({ fact: x })), m = mergeFacts(pList, wants, Date.now(), 40); if (m) kv.set('prefs', pList.map(x => x.fact));
      if (n || m) { log('[LEARN]', [...facts, ...wants].join(' | ')); onChange(); }
      return n + m;
    } catch (e) { log('[LEARN] skipped', e && e.message); return 0; }
    finally {
      busy = false;
      if (queued) { const q = queued; queued = null; setTimeout(() => observe(q[0], q[1]), 1500); }
    }
  }
  function observe(user, said) {
    if (!enabled() || !worthLearning(user)) return false;
    if (busy) { queued = [user, said]; return true; }
    const wait = 8000 - (Date.now() - last); if (wait > 0) { queued = null; setTimeout(() => { if (!busy) run(user, said); else queued = [user, said]; }, wait); return true; }
    run(user, said); return true;
  }
  return { observe, run };
}
