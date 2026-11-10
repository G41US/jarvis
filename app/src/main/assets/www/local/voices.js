// voices.js - turns the phone's text-to-speech voices into a clean male / female list.
// Android doesn't say which voices are male or female, so Google's voice codes are mapped by hand.
// If a phone has no voice of the wanted gender, Jarvis shifts the pitch so male and female still sound different.

const GOOGLE = {
  // United States
  iob: 'f', iog: 'f', iol: 'm', iom: 'm', sfg: 'f', tpc: 'f', tpd: 'm', tpf: 'f',
  // United Kingdom
  gba: 'f', gbb: 'm', gbc: 'f', gbd: 'm', gbg: 'f', rjs: 'm',
  // India
  ahp: 'f', cxx: 'f', ena: 'f', end: 'm',
};
const ACCENTS = { us: 'US English', gb: 'British English', au: 'Australian English', in: 'Indian English', ca: 'Canadian English', ie: 'Irish English', za: 'South African English' };

export function genderOf(v) {
  const id = String((v && v.id) || '').toLowerCase(), label = String((v && v.label) || '').toLowerCase();
  if (/#female|[_-]female|\bfemale\b|smtf\d|-f\d{2}\b/.test(id + ' ' + label)) return 'f';
  if (/#male|[_-]male|\bmale\b|smtm\d|-m\d{2}\b/.test(id + ' ' + label)) return 'm';
  const m = /-x-([a-z]{3})(?:[-#]|$)/.exec(id);
  if (m && GOOGLE[m[1]]) return GOOGLE[m[1]];
  return '';
}
export const isLocal = v => !/network|online/i.test(String(v.id) + ' ' + String(v.label || ''));
export function accentOf(v) { const lang = String(v.lang || v.id || '').toLowerCase().replace('_', '-'); const m = /^en-([a-z]{2})/.exec(lang); return m ? m[1] : (lang.startsWith('en') ? 'us' : ''); }

/** [{id, label, lang}] from Android -> [{id, raw, name, gender, accent, local}] sorted: English first, offline first. */
export function describeVoices(list) {
  const counters = {};
  const out = list.filter(v => /^en/i.test(String(v.lang || v.id)) && accentOf(v) !== 'ng').map(v => {      // no Nigerian English voices for now
    const g = genderOf(v), a = accentOf(v), local = isLocal(v);
    const key = `${a}${g}`; counters[key] = (counters[key] || 0) + 1;
    const gw = g === 'm' ? 'Male' : g === 'f' ? 'Female' : 'Voice';
    const name = `${ACCENTS[a] || 'English'} · ${gw} ${counters[key]}${local ? '' : ' (online)'}`;
    return { raw: v.id, name, gender: g, accent: a, local };
  });
  const rank = v => (v.gender ? 0 : 2) + (v.local ? 0 : 1);
  return out.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
}

/** Best voice for a gender. Male defaults to a British voice (the Jarvis sound), female to American. */
export function pickVoice(described, gender, accent = '') {
  const want = accent || (gender === 'm' ? 'gb' : 'us');
  const score = v => (v.gender === gender ? 0 : 100) + (v.accent === want ? 0 : v.accent === 'us' || v.accent === 'gb' ? 5 : 10) + (v.local ? 0 : 3);
  const best = [...described].sort((a, b) => score(a) - score(b))[0];
  return best && best.gender === gender ? best : null;
}

/** Pitch used when no real voice of that gender exists on the phone. */
export const fallbackPitch = gender => (gender === 'm' ? 0.78 : gender === 'f' ? 1.18 : 1);
