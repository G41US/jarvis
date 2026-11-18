// persona.js - "be Ultron for a minute", "talk like Morgan Freeman", "do your best Yoda": Jarvis plays the character until
// told to stop. The AI picks how they talk (words, attitude) and the closest voice it has: which of the natural voices,
// deeper or higher, slower or quicker, and how every line is delivered ("menacing", "warm"), plus the nearest offline voice.
// It's an impression made from the voices on hand, not a copy of anyone's real voice. Stays on (even after a restart)
// until "stop", "be yourself" or "back to Jarvis".

export const CLOUD_VOICES = { daniel: 'male, crisp and composed', troy: 'male, deep and smooth', austin: 'male, warm and younger',
  hannah: 'female, clear and warm', diana: 'female, poised and lower', autumn: 'female, bright and lively' };
// the offline voice (Kokoro on the phone), by sex and accent: speaker numbers
const OFFLINE = { male: { american: 5, british: 9, default: 6 }, female: { american: 3, british: 7, default: 1 } };
const clamp = (x, a, b, d) => { const n = Number(x); return isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };
const DIRECTION = /^\s*\[[A-Za-z][A-Za-z \-]{1,28}\]/;

export function createPersona({ reg, cfgStore, onChange = () => {} }) {
  const read = () => { try { const p = JSON.parse(cfgStore.get('persona', '') || 'null'); return p && p.who ? p : null; } catch { return null; } };
  let cur = read();
  const save = p => { cur = p; cfgStore.set('persona', p ? JSON.stringify(p) : ''); onChange(cur); };

  reg.add('become', "Play a character or do an impression of anyone the user names (a film character, a famous person, an accent, a type: " +
    "'be Ultron', 'talk like Morgan Freeman', 'speak like a pirate') and stay that way until told to stop. You choose, from what you know of how they sound: " +
    "gender; voice, the closest of: " + Object.entries(CLOUD_VOICES).map(([k, v]) => `${k} (${v})`).join(', ') + "; " +
    "pitch (0.75 to 1.3; 1 normal, lower is deeper: a deep menacing robot about 0.85, a small child about 1.25); speed (0.8 to 1.2; slower is more deliberate); " +
    "delivery (one to three words for how every line is said, e.g. 'menacing', 'cold calm', 'cheerful', 'gravelly', 'whisper', 'sarcastic', 'regal'); " +
    "accent ('american', 'british' or 'other'); style (one or two sentences on how they talk: words, rhythm, attitude, signature phrases). " +
    "After this, answer as them.",
    { who: { type: 'string' }, gender: { type: 'string', enum: ['male', 'female'] }, voice: { type: 'string', enum: Object.keys(CLOUD_VOICES) },
      pitch: { type: 'number' }, speed: { type: 'number' }, delivery: { type: 'string' }, accent: { type: 'string' }, style: { type: 'string' } },
    ['who', 'gender', 'voice'],
    a => {
      const gender = a.gender === 'female' ? 'female' : 'male';
      const voice = CLOUD_VOICES[a.voice] ? a.voice : gender === 'female' ? 'hannah' : 'troy';
      const accent = /brit|english|uk/i.test(a.accent || '') ? 'british' : /americ|us/i.test(a.accent || '') ? 'american' : 'default';
      save({ who: String(a.who || '').slice(0, 60), gender, voice, pitch: clamp(a.pitch, 0.75, 1.3, 1), speed: clamp(a.speed, 0.8, 1.2, 1),
        delivery: String(a.delivery || '').replace(/[^A-Za-z \-]/g, '').trim().slice(0, 28), offline: OFFLINE[gender][accent], style: String(a.style || '').slice(0, 300) });
      return `You are now ${cur.who}. Answer as them from now on (it's an impression with the voices on hand). Say something short in character now.`;
    });
  reg.add('stop_being', "Stop playing a character and be Jarvis again ('stop', 'be yourself', 'back to Jarvis', 'drop the act', 'that's enough').", {}, [],
    () => { const was = cur && cur.who; save(null); return was ? `Back to being Jarvis (no longer ${was}). Say so briefly, as yourself.` : "You're already yourself."; });

  return {
    get: () => cur,
    /** Added to the AI's instructions while a character is on. */
    prompt: () => !cur ? '' : `\n\nYOU ARE PLAYING A CHARACTER: ${cur.who}. Until the user says stop (then call stop_being), speak as ${cur.who} would: their words, rhythm and attitude` +
      (cur.style ? ` (${cur.style})` : '') + `. Stay in character in every reply, even short ones, but still do what's asked (tools work as normal) and never put the user at risk. ` +
      `Your voice is already set for the part: don't describe it, and don't add delivery directions in brackets.\n`,
    /** How a sentence is handed to the voice: the character's delivery in front, unless the line has its own. */
    deliver: text => (cur && cur.delivery && !DIRECTION.test(text) ? `[${cur.delivery}] ` : '') + text,
  };
}
