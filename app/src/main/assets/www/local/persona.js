// persona.js - "be Ultron for a minute", "talk like Morgan Freeman": Jarvis takes on that person's real voice and way of talking
// until told to stop. The voice comes from Fish Audio's public voice library (clones people have made of characters and famous
// voices), spoken by Fish Audio's free voice API with the user's own key. No matching voice, or no key: he says so and stays
// himself (no lookalike voices). Stays on, even after a restart, until "stop", "be yourself" or "back to Jarvis".

const LIBRARY = 'https://api.fish.audio/model';
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
const KEYISH = /\b([A-Za-z0-9_-]{24,80})\b/;

/** The best voice in the library for a name: every word of the name in its title, the most used of the top results. */
export async function findVoice(who, fetchFn = fetch) {
  const want = words(who).filter(w => !/^(the|mr|mrs|ms|dr|sir|voice|from)$/.test(w));
  if (!want.length) return null;
  for (const lang of ['&language=en', '']) {
    const r = await fetchFn(`${LIBRARY}?title=${encodeURIComponent(want.join(' '))}&page_size=20&sort_by=score${lang}`);
    if (!r.ok) throw new Error('voice library ' + r.status);
    const items = ((await r.json()).items || []).filter(m => m.state === 'trained' && (m.type || 'tts') === 'tts');
    const hits = items.filter(m => { const t = words(m.title); return want.every(w => t.includes(w)); });
    if (hits.length) { const best = hits.reduce((a, b) => ((b.task_count || 0) > (a.task_count || 0) ? b : a)); return { id: best._id, title: String(best.title || '').trim() }; }
  }
  return null;
}

export function createPersona({ reg, cfgStore, onChange = () => {}, fetchFn = (...a) => fetch(...a) }) {
  const read = () => { try { const p = JSON.parse(cfgStore.get('persona', '') || 'null'); return p && p.who && p.voice && p.voice.id ? p : null; } catch { return null; } };
  let cur = read(), askedKeyAt = 0;
  const key = () => String(cfgStore.get('fish_key', '') || '').trim();
  const save = p => { cur = p; cfgStore.set('persona', p ? JSON.stringify(p) : ''); onChange(cur); };

  reg.add('become', "Become anyone the user names, with their real voice: a film or game character, a famous person ('be Ultron', " +
    "'talk like Morgan Freeman', 'imitate Optimus Prime'). Stay that way until told to stop. who: the name as it's best known " +
    "(e.g. 'Ultron', 'Morgan Freeman'); style: one or two sentences on how they talk (words, rhythm, attitude, signature phrases).",
    { who: { type: 'string' }, style: { type: 'string' } }, ['who'],
    async a => {
      const who = String(a.who || '').trim().slice(0, 60);
      let voice = null;
      try { voice = await findVoice(who, fetchFn); }
      catch { return `Couldn't reach the voice library just now. Tell the user briefly, as yourself, and stay Jarvis.`; }
      if (!voice) return `There's no voice for ${who} in the voice library. Tell the user briefly, as yourself, that you can't do their voice, and stay Jarvis.`;
      if (!key()) { askedKeyAt = Date.now(); return `${who}'s voice is there, but speaking in it needs the user's free Fish Audio key (make an account at fish dot audio, ` +
        `then API keys). They can paste it in Settings, Voice, or just send it to you in a message. Tell them that briefly, as yourself, and stay Jarvis for now.`; }
      save({ who, voice, style: String(a.style || '').slice(0, 300) });
      return `You are now ${who}, in their voice. Answer as them from now on. Say something short in character now.`;
    });
  reg.add('stop_being', "Stop being a character and be Jarvis again ('stop', 'be yourself', 'back to Jarvis', 'drop the act', 'that's enough').", {}, [],
    () => { const was = cur && cur.who; save(null); return was ? `Back to being Jarvis (no longer ${was}). Say so briefly, as yourself.` : "You're already yourself."; });

  return {
    get: () => cur,
    /** The voice to speak with while in character: {key, id}, or null for Jarvis's own voice. */
    voice: () => (cur && key() ? { key: key(), id: cur.voice.id } : null),
    /** Added to the AI's instructions while a character is on. */
    prompt: () => !cur ? '' : `\n\nYOU ARE PLAYING A CHARACTER: ${cur.who}. You are speaking in ${cur.who}'s own voice. Until the user says stop (then call stop_being), ` +
      `speak as ${cur.who} would: their words, rhythm and attitude` + (cur.style ? ` (${cur.style})` : '') +
      `. Stay in character in every reply, even short ones, but still do what's asked (tools work as normal) and never put the user at risk. ` +
      `Don't add delivery directions in brackets.\n`,
    /** A message carrying the Fish Audio key ("my fish key is ..."): saved here, so it never goes to the AI. The reply, or null. */
    takeKey: text => {
      const t = String(text || '').trim(), m = KEYISH.exec(t);
      if (!m || !(/\bfish\b/i.test(t) || (Date.now() - askedKeyAt < 15 * 60000 && t === m[1]))) return null;
      cfgStore.set('fish_key', m[1]); onChange(cur);
      return "Got it, your Fish Audio key is saved. Tell me who to be.";
    },
  };
}
