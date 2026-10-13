// intents.js - instant commands. Short, common requests ("flashlight on", "volume up", "set a timer for 5 minutes",
// "what time is it", "go back") are recognised on the phone and done at once, with no trip to the AI.
// Patterns match the WHOLE sentence, so anything longer or unusual still goes to the AI.

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90, half: 0.5 };
const num = s => { const t = String(s || '').trim(); if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t); return WORDS[t] != null ? WORDS[t] : NaN; };
const UNIT = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600 };
const N = '(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty five|forty|fifty|sixty|ninety|half)';

/** Strip the politeness and the wake word: "Hey Jarvis, could you please turn on the flashlight?" -> "turn on the flashlight". */
export function normalise(text) {
  return String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/[.,!?;:]+/g, ' ')
    .replace(/^\s*(hey|ok|okay|yo)?\s*jarvis\s*/, '').replace(/\bplease\b/g, '')
    .replace(/^\s*(can|could|would|will) you\s+/, '').replace(/^\s*(i want you to|i need you to|go ahead and|just)\s+/, '')
    .replace(/\s+/g, ' ').trim();
}

/** [pattern, (match) => [tool, args] | string]. First match wins. */
export const INTENTS = [
  // ---- time
  [/^(what'?s|what is|tell me) the time( now)?$|^what time is it( now)?$|^time$/, () => ['get_time', {}]],
  [/^(what'?s|what is) (the )?(date|day)( today)?$|^what day is (it|today)$|^what'?s today'?s date$/, () => ['get_time', {}]],
  // ---- flashlight
  [/^(turn|switch|put) (on|off) (the |my )?(flash ?light|torch|light on (the|my) phone)$/, m => ['flashlight', { state: m[2] }]],
  [/^(turn|switch|put) (the |my )?(flash ?light|torch) (on|off)$/, m => ['flashlight', { state: m[4] }]],
  [/^(flash ?light|torch) (on|off)$/, m => ['flashlight', { state: m[2] }]],
  [/^(toggle )?(the )?(flash ?light|torch)$/, () => ['flashlight', { state: 'toggle' }]],
  // ---- volume, ringer, do not disturb
  [/^(turn (it|the volume|the sound|the music) up|volume up|(make it )?(a (bit|little) )?louder|increase (the )?volume|raise (the )?volume)$/, () => ['set_volume', { action: 'up' }]],
  [/^(turn (it|the volume|the sound|the music) down|volume down|(make it )?(a (bit|little) )?(quieter|softer)|lower (the )?volume|decrease (the )?volume|reduce (the )?volume)$/, () => ['set_volume', { action: 'down' }]],
  [new RegExp(`^(set |put |turn )?(the )?volume (to |at )?${N}( percent| %)?$`), m => ['set_volume', { action: 'set', level: num(m[4]) }]],
  [/^(max|maximum|full) volume$|^volume (to )?(max|maximum|full)$/, () => ['set_volume', { action: 'max' }]],
  [/^(mute|unmute)( the (volume|sound|music|phone))?$/, m => ['set_volume', { action: m[1] }]],
  [/^(put |set |turn )?(the |my )?phone (on|to) (silent|vibrate)$|^(silent|vibrate) mode( on)?$|^(go )?(silent|vibrate)$/, m => ['ringer_mode', { mode: (m[4] || m[6] || m[5] || '').includes('vib') ? 'vibrate' : 'silent' }]],
  [/^(turn |switch )?(on|off) (do not disturb|dnd)$|^(do not disturb|dnd) (on|off)$|^(turn|switch) (do not disturb|dnd) (on|off)$/, m => ['do_not_disturb', { on: (m[2] || m[5] || m[8]) === 'on' }]],
  // ---- phone buttons (need phone control)
  [/^go back$|^back$|^press back$/, () => ['press_button', { button: 'back' }]],
  [/^go to (the )?home ?screen$|^home screen$|^press (the )?home( button)?$/, () => ['press_button', { button: 'home' }]],   // not "go home": a driver means the house
  [/^lock (the |my )?(phone|screen)$/, () => ['press_button', { button: 'lock' }]],
  [/^(take a )?screenshot$|^take a screen ?shot$/, () => ['press_button', { button: 'screenshot' }]],
  [/^(show|open|pull down) (my |the )?notifications$/, () => ['press_button', { button: 'notifications' }]],
  [/^(show |open )?recent apps$/, () => ['press_button', { button: 'recents' }]],
  // ---- timers
  [new RegExp(`^(set |start )?(a |the )?timer (for )?${N} (second|sec|minute|min|hour|hr)s?$|^${N} (second|sec|minute|min|hour|hr)s? timer$`),
    m => { const n = num(m[4] || m[6]), u = UNIT[m[5] || m[7]]; return Number.isFinite(n) && u ? ['set_timer', { seconds: Math.round(n * u) }] : null; }],
  [new RegExp(`^(set |start )?(a |the )?timer (for )?(an? )?hour and a half$`), () => ['set_timer', { seconds: 5400 }]],
  [new RegExp(`^remind me in ${N} (second|sec|minute|min|hour|hr)s? (to|about|that) (.+)$`),
    m => { const n = num(m[1]), u = UNIT[m[2]]; return Number.isFinite(n) && u ? ['set_reminder', { text: m[4], in_minutes: (n * u) / 60 }] : null; }],
  [/^(cancel|stop|delete) (the |my )?timers?$/, () => ['cancel_reminder', { which: 'timer' }]],
  [/^(what are )?my reminders$|^(list|show)( me)? (my )?reminders$|^any reminders$/, () => ['list_reminders', {}]],
  // ---- music
  [/^(pause|stop) (the )?(music|song|playback)$|^pause$/, () => ['spotify_pause', {}]],
  [/^(resume|continue|unpause) (the )?(music|song|playback)?$|^play music$/, () => ['spotify_play', {}]],
  [/^(next|skip)( (this )?(song|track))?$|^next (song|track)$/, () => ['spotify_next', {}]],
  [/^(previous|last|go back a) (song|track)$|^previous$/, () => ['spotify_previous', {}]],
  // ---- apps and quick info
  [/^(open|launch|start) (the )?([a-z0-9][a-z0-9 .&'-]{1,30}?)( app)?$/, m => (/\b(and|then|website|\.com|settings|camera|map|maps|door|garage)\b/.test(m[3]) ? null : ['open_app', { name: m[3] }])],
  [/^(what'?s )?(my |the )?battery( level| status| percentage)?$|^how much battery( do i have| is left)?$/, () => ['system_info', {}]],
  // ---- parking and safety (new helpers)
  [/^(i (just )?parked( here)?|remember (where i parked|my parking( spot)?|this parking spot)|save (my )?parking( spot)?)$/, () => ['remember_parking', {}]],
  [/^(where did i park|where'?s my car|find my car|take me to my car)$/, m => ['find_my_car', { navigate: /take me/.test(m[0]) }]],
  [/^(i'?m safe( now)?|i am safe( now)?|cancel (the )?(emergency|sos))$/, () => ['im_safe', {}]],
  // ---- interpreter
  [/^(stop|end|exit|quit|close) (the )?(interpreter|interpreting|translating|translation)( mode)?$/, () => ['stop_interpreter', {}]],
];

/** -> { tool, args } or null. `has` tells whether a tool exists in this build. */
export function matchIntent(text, has = () => true) {
  const t = normalise(text);
  if (!t || t.split(' ').length > 12) return null;
  for (const [re, f] of INTENTS) {
    const m = re.exec(t); if (!m) continue;
    const r = f(m); if (!r) continue;
    const [tool, args] = r;
    if (has(tool)) return { tool, args };
  }
  return null;
}
