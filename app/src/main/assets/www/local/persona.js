// persona.js - "be Ultron for a minute", "talk like Morgan Freeman": Jarvis takes on that person's real voice and way of talking
// until told to stop. The voice comes from Fish Audio's public voice library (clones people have made of characters and famous
// voices), spoken by Fish Audio's free voice API with the user's own key. No matching voice, or no key: he says so and stays
// himself (no lookalike voices). Stays on, even after a restart, until "stop", "be yourself" or "back to Jarvis".

const LIBRARY = 'https://api.fish.audio/model';
// "stop", "be yourself", "normal voice": back to Jarvis at once, without the AI (in character it sometimes stays in the role)
export const EXIT = new RegExp("^(?:(?:hey )?jarvis[,.! ]+)?(?:(?:ok(?:ay)?|alright|all right|please|now|ok then)[,.! ]+)*(?:" +
  "stop(?: it| now| that| please| the act| being [\\w' -]+| talking like (?:that|him|her|them))?|that'?s enough|enough(?: now)?|" +
  "be yourself(?: again)?|be jarvis(?: again)?|you can stop(?: now)?|drop the act|" +
  "(?:go |switch |change |come |get )?back to (?:jarvis|normal|yourself|being (?:jarvis|yourself)|your (?:own |normal |default |regular |old )?voice)|" +
  "(?:go |switch |change |come )back|(?:use |switch to |change to )?(?:your )?(?:normal|default|own|regular|old) voice)" +
  "(?:[,.! ]+(?:please|jarvis|now|thanks|thank you))*[.!? ]*$", 'i');
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
const KEYISH = /\b([A-Za-z0-9_-]{24,80})\b/;

/** The library's voices for a name, best first: every word of the name in the title, the most liked first (users like the
 *  ones that really sound like the person; the most used are often just the first ones made). */
export async function findVoices(who, fetchFn = fetch) {
  const want = words(who).filter(w => !/^(the|mr|mrs|ms|dr|sir|voice|from)$/.test(w));
  if (!want.length) return null;
  for (const lang of ['&language=en', '']) {
    const r = await fetchFn(`${LIBRARY}?title=${encodeURIComponent(want.join(' '))}&page_size=20&sort_by=score${lang}`);
    if (!r.ok) throw new Error('voice library ' + r.status);
    const items = ((await r.json()).items || []).filter(m => m.state === 'trained' && (m.type || 'tts') === 'tts');
    const hits = items.filter(m => { const t = words(m.title); return want.every(w => t.includes(w)); })
      .sort((a, b) => (b.like_count || 0) - (a.like_count || 0) || (b.task_count || 0) - (a.task_count || 0));
    if (hits.length) return hits.map(m => ({ id: m._id, title: String(m.title || '').trim() }));
  }
  return [];
}
export const findVoice = async (who, fetchFn = fetch) => (await findVoices(who, fetchFn))[0] || null;

export function createPersona({ reg, cfgStore, onChange = () => {}, fetchFn = (...a) => fetch(...a), builtKey = '' }) {
  const read = () => { try { const p = JSON.parse(cfgStore.get('persona', '') || 'null'); return p && p.who && p.voice && p.voice.id ? p : null; } catch { return null; } };
  let cur = read(), askedKeyAt = 0;
  const key = () => String(cfgStore.get('fish_key', '') || builtKey || '').trim();   // their own key, or the one built into the app
  const save = p => { cur = p; cfgStore.set('persona', p ? JSON.stringify(p) : ''); onChange(cur); };
  // the voice kept for each name ("that's not his voice" moves on, and the one he ends up with is remembered)
  const picks = () => { try { return JSON.parse(cfgStore.get('fish_picks', '') || '{}') || {}; } catch { return {}; } };
  const keep = (who, id) => { const m = picks(); m[words(who).join(' ')] = id; cfgStore.set('fish_picks', JSON.stringify(m)); };

  reg.add('become', "Become anyone the user names, with their real voice: a film or game character, a famous person ('be Ultron', " +
    "'talk like Morgan Freeman', 'imitate Optimus Prime'). Stay that way until told to stop. who: the name as it's best known " +
    "(e.g. 'Ultron', 'Morgan Freeman'); style: one or two sentences on how they talk (words, rhythm, attitude, signature phrases).",
    { who: { type: 'string' }, style: { type: 'string' } }, ['who'],
    async a => {
      const who = String(a.who || '').trim().slice(0, 60);
      let voices = [];
      try { voices = await findVoices(who, fetchFn); }
      catch { return `Couldn't reach the voice library just now. Tell the user briefly, as yourself, and stay Jarvis.`; }
      const kept = picks()[words(who).join(' ')], voice = voices.find(v => v.id === kept) || voices[0] || null;
      if (!voice) return `There's no voice for ${who} in the voice library. Tell the user briefly, as yourself, that you can't do their voice, and stay Jarvis.`;
      if (!key()) { askedKeyAt = Date.now(); return `${who}'s voice is there, but speaking in it needs the user's free Fish Audio key (make an account at fish dot audio, ` +
        `then API keys). They can paste it in Settings, Voice, or just send it to you in a message. Tell them that briefly, as yourself, and stay Jarvis for now.`; }
      save({ who, voice, tried: [voice.id], style: String(a.style || '').slice(0, 300) }); keep(who, voice.id);
      return `You are now ${who}, in their voice. Answer as them from now on. Say something short in character now.`;
    });
  reg.add('try_another_voice', "The character's voice is wrong ('that's not his voice', 'he doesn't sound like that', 'wrong voice', 'try another voice'): " +
    "switch to the next voice for them in the library.", {}, [],
    async () => {
      if (!cur) return "You aren't playing anyone right now.";
      let voices = [];
      try { voices = await findVoices(cur.who, fetchFn); } catch { return "Couldn't reach the voice library just now. Say so briefly."; }
      const tried = cur.tried || [cur.voice.id], next = voices.find(v => !tried.includes(v.id));
      if (!next) return `That was the last voice for ${cur.who} in the library. Say so briefly, in character, and offer to stop.`;
      save({ ...cur, voice: next, tried: [...tried, next.id] }); keep(cur.who, next.id);
      return `Switched to another voice for ${cur.who} (${tried.length + 1} of ${voices.length}). Say one short line in character so the user can hear it.`;
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
