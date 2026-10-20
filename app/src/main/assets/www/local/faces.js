// faces.js - the faces Jarvis can wear. Each goes with a voice: a man's face speaks with a male voice, a woman's with a female one.
// Kofi, Amara and Nova are original, made-up people built from MakeHuman's CC0 assets (tools/faces/make_faces.py); they blink and
// their lips move as they talk. "Orb" is no face at all: a ball of light that moves with his voice (and saves battery).
export const FACES = [
  { id: 'adam', name: 'Adam', gender: 'male', url: 'models/adam.glb', thumb: 'models/faces/adam.jpg' },
  { id: 'kofi', name: 'Kofi', gender: 'male', url: 'models/faces/kofi.glb', thumb: 'models/faces/kofi.jpg' },
  { id: 'amara', name: 'Amara', gender: 'female', url: 'models/faces/amara.glb', thumb: 'models/faces/amara.jpg' },
  { id: 'nova', name: 'Nova', gender: 'female', url: 'models/faces/nova.glb', thumb: 'models/faces/nova.jpg' },
  { id: 'orb', name: 'Orb', gender: null, url: 'orb', thumb: '' },
];
export const DEFAULT_FACE = { male: 'adam', female: 'amara' };
export const faceById = id => FACES.find(f => f.id === String(id || '').toLowerCase()) || null;

/** The face to show. wantMale: the voice is a man's (true), a woman's (false), or unknown (null: go by the setting). */
export function faceFor(config, wantMale) {
  const picked = faceById(config.get('face', ''));
  if (picked && picked.id === 'orb') return 'orb';
  if (wantMale === null || wantMale === undefined) wantMale = picked ? picked.gender === 'male' : config.get('avatar_gender', 'male') !== 'female';
  const g = wantMale ? 'male' : 'female';
  if (picked && picked.gender === g) return picked.url;
  const remembered = faceById(config.get('face_' + g, DEFAULT_FACE[g]));
  const f = remembered && remembered.gender === g ? remembered : faceById(DEFAULT_FACE[g]);
  if (f.id === 'adam' && typeof window !== 'undefined' && window.__NO_ADAM) return faceById('kofi').url;   // a build without Adam's model
  return f.url;
}

/** What to store when the voice changes gender ("switch to the female voice"): the last face you used for that gender, or the orb stays. */
export function faceForGender(config, gender) {
  const cur = faceById(config.get('face', ''));
  if (cur && cur.id === 'orb') return 'orb';
  const r = faceById(config.get('face_' + gender, DEFAULT_FACE[gender]));
  return r && r.gender === gender ? r.id : DEFAULT_FACE[gender];
}

/** "Amara", "the orb", "a woman", "the African guy" -> a face id, or null. */
export function matchFace(text) {
  const t = String(text || '').toLowerCase();
  for (const f of FACES) if (new RegExp(`\\b${f.id}\\b`).test(t)) return f.id;
  if (/\b(orb|ball|light|no face|faceless|just (a )?light|bubble|sphere)\b/.test(t)) return 'orb';
  return null;
}
