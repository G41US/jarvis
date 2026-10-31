// faces.js - the faces Jarvis can wear. Each goes with a voice: the male face speaks with a male voice, the female with a female one.
// Both are glowing gold particle heads (makeGoldenParticleFace in the page) shaped from original, made-up people built from MakeHuman's CC0 assets
// (tools/faces/make_faces.py). "Orb" is no face at all: a ball of light that moves with his voice (and saves battery).
export const FACES = [
  { id: 'male', name: 'Male', gender: 'male', url: 'models/faces/lee.glb', thumb: 'models/faces/male.jpg' },
  { id: 'female', name: 'Female', gender: 'female', url: 'models/faces/nova.glb', thumb: 'models/faces/female.jpg' },
  { id: 'orb', name: 'Orb', gender: null, url: 'orb', thumb: '' },
];
export const DEFAULT_FACE = { male: 'male', female: 'female' };
const OLD = { adam: 'male', kofi: 'male', amara: 'female', nova: 'female' };   // faces from older builds, still in people's settings
export const faceById = id => { const k = String(id || '').toLowerCase(); return FACES.find(f => f.id === (OLD[k] || k)) || null; };

/** The face to show. wantMale: the voice is a man's (true), a woman's (false), or unknown (null: go by the setting). */
export function faceFor(config, wantMale) {
  const picked = faceById(config.get('face', ''));
  if (picked && picked.id === 'orb') return 'orb';
  if (wantMale === null || wantMale === undefined) wantMale = picked ? picked.gender === 'male' : config.get('avatar_gender', 'male') !== 'female';
  return faceById(wantMale ? 'male' : 'female').url;
}

/** What to store when the voice changes gender ("switch to the female voice"): that gender's face, or the orb stays. */
export function faceForGender(config, gender) {
  const cur = faceById(config.get('face', ''));
  return cur && cur.id === 'orb' ? 'orb' : DEFAULT_FACE[gender];
}

