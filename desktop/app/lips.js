// Lip sync: the mouth makes the shapes of the words he is actually saying, at the moment he says them.
// 1. The sentence is turned into mouth shapes (visemes) with English spelling rules: lips together on m/b/p,
//    lip under the teeth on f/v, round on oo/w, wide on ee, open on ah...
// 2. Those shapes are laid over the sound itself: the audio is decoded, its pauses found, each phrase is pinned to a pause
//    where the sentence has punctuation, and the words inside a phrase share out the time between the pauses.
// The jaw still opens with the loudness of each syllable (index.html); this decides which shape it makes.
(function () {
  // the mouth for each shape (ARKit blend shapes on the face scan); jaw = how far it opens at full voice
  const SHAPES = {
    sil: { jaw: 0.0, m: { mouthClose: 0.1 } },
    PP:  { jaw: 0.0, closed: true, m: { mouthPress_L: 0.55, mouthPress_R: 0.55, mouthClose: 0.35 } },   // m b p: lips meet
    FF:  { jaw: 0.07, m: { mouthRollLower: 0.6, mouthUpperUp_L: 0.25, mouthUpperUp_R: 0.25 } },       // f v: lower lip to the teeth
    TH:  { jaw: 0.14, m: { mouthLowerDown_L: 0.2, mouthLowerDown_R: 0.2 } },
    DD:  { jaw: 0.16, m: { mouthStretch_L: 0.12, mouthStretch_R: 0.12 } },                            // t d n l
    kk:  { jaw: 0.22, m: { mouthStretch_L: 0.08, mouthStretch_R: 0.08 } },                            // k g ng h
    CH:  { jaw: 0.12, m: { mouthFunnel: 0.5, mouthPucker: 0.2, mouthUpperUp_L: 0.15, mouthUpperUp_R: 0.15 } },   // sh ch j
    SS:  { jaw: 0.05, m: { mouthStretch_L: 0.3, mouthStretch_R: 0.3, mouthSmile_L: 0.15, mouthSmile_R: 0.15 } },  // s z: teeth together
    RR:  { jaw: 0.12, m: { mouthFunnel: 0.3, mouthPucker: 0.3 } },
    aa:  { jaw: 0.52, m: { mouthLowerDown_L: 0.3, mouthLowerDown_R: 0.3 } },                          // ah
    E:   { jaw: 0.32, m: { mouthStretch_L: 0.3, mouthStretch_R: 0.3, mouthSmile_L: 0.1, mouthSmile_R: 0.1 } },
    I:   { jaw: 0.17, m: { mouthStretch_L: 0.35, mouthStretch_R: 0.35, mouthSmile_L: 0.3, mouthSmile_R: 0.3 } },     // ee
    O:   { jaw: 0.38, m: { mouthFunnel: 0.55, mouthPucker: 0.15 } },
    U:   { jaw: 0.13, m: { mouthPucker: 0.75, mouthFunnel: 0.3 } },                                   // oo w
  };
  const VOWEL = { aa: 1, E: 1, I: 1, O: 1, U: 1 };
  const LEN = { aa: 1.7, E: 1.5, I: 1.4, O: 1.7, U: 1.5, PP: 0.9, FF: 1.0, TH: 1.0, DD: 0.8, kk: 0.9, CH: 1.1, SS: 1.1, RR: 0.9, sil: 0.6 };

  // spelling to mouth shapes, longest pattern first
  const RULES = [
    ['tion', ['CH', 'E', 'DD']], ['sion', ['CH', 'E', 'DD']], ['ough', ['O']], ['augh', ['O']], ['eigh', ['E', 'I']], ['igh', ['aa', 'I']],
    ['tch', ['CH']], ['dge', ['CH']], ['sch', ['SS', 'kk']],
    ['th', ['TH']], ['sh', ['CH']], ['ch', ['CH']], ['ph', ['FF']], ['wh', ['U']], ['ck', ['kk']], ['ng', ['kk']], ['qu', ['kk', 'U']],
    ['kn', ['DD']], ['wr', ['RR']], ['gh', []], ['mb', ['PP']],
    ['oo', ['U']], ['ee', ['I']], ['ea', ['I']], ['ie', ['I']], ['ai', ['E']], ['ay', ['E']], ['ei', ['E']], ['ey', ['E']],
    ['oa', ['O']], ['ow', ['O', 'U']], ['ou', ['aa', 'U']], ['oi', ['O', 'I']], ['oy', ['O', 'I']], ['au', ['O']], ['aw', ['O']],
    ['er', ['RR']], ['ir', ['RR']], ['ur', ['RR']], ['ar', ['aa', 'RR']], ['or', ['O', 'RR']],
  ];
  const ONE = { a: ['aa'], e: ['E'], i: ['I'], o: ['O'], u: ['aa'], y: ['I'], b: ['PP'], m: ['PP'], p: ['PP'], f: ['FF'], v: ['FF'],
    t: ['DD'], d: ['DD'], n: ['DD'], l: ['DD'], k: ['kk'], g: ['kk'], q: ['kk'], h: ['kk'], x: ['kk', 'SS'], s: ['SS'], z: ['SS'],
    j: ['CH'], r: ['RR'], w: ['U'] };
  const LONG = { a: ['E', 'I'], e: ['I'], i: ['aa', 'I'], o: ['O', 'U'], u: ['U'] };
  const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

  function wordShapes(word) {
    let w = word.toLowerCase().replace(/\d/g, d => ' ' + NUM[+d] + ' ').replace(/[^a-z ]/g, '');
    const out = [];
    for (const part of w.split(' ').filter(Boolean)) {
      let s = part;
      let magic = -1;                                                      // vowel + consonant + silent e says its name: "five", "home"
      if (s.length > 3 && /[aeiou][^aeiouwxy]e$/.test(s)) magic = s.length - 3;
      if (s.length > 3 && /[^aeiou]e$/.test(s)) s = s.slice(0, -1);         // silent final e: "make", "time"
      let i = 0, last = '';
      while (i < s.length) {
        let hit = null;
        for (const [pat, v] of RULES) if (s.startsWith(pat, i)) { hit = [pat, v]; break; }
        let v;
        if (i === magic && !hit) { v = LONG[s[i]] || []; i++; for (const x of v) { out.push(x); last = x; } continue; }
        if (hit) { v = hit[1]; i += hit[0].length; }
        else {
          const c = s[i];
          if (c === 'c') v = /[eiy]/.test(s[i + 1] || '') ? ['SS'] : ['kk'];
          else if (c === 'u' && i === 0 && s.length > 2) v = ['aa'];
          else if (c === 'u' && /[^aeiou]e?$/.test(s.slice(i + 1)) && s.length <= 4) v = ['aa'];   // "but", "cup"
          else v = ONE[c] || [];
          if (c === s[i - 1] && !/[aeiou]/.test(c)) v = [];                  // double consonant: one sound
          i++;
        }
        for (const x of v) if (x !== last || VOWEL[x]) { out.push(x); last = x; }
      }
    }
    return out;
  }

  // the loudness of the sound, 100 times a second, and where it pauses
  function envelope(buf) {
    const d = buf.getChannelData(0), hop = Math.max(1, Math.round(buf.sampleRate / 100)), n = Math.floor(d.length / hop), env = new Float32Array(n);
    let mx = 1e-6;
    for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop, e = i + hop; i < e; i++) s += d[i] * d[i]; env[f] = Math.sqrt(s / hop); if (env[f] > mx) mx = env[f]; }
    for (let f = 0; f < n; f++) env[f] /= mx;
    return env;
  }
  function voicedSpans(env) {
    const on = 0.07, spans = [];
    let start = -1;
    for (let f = 0; f <= env.length; f++) {
      const v = f < env.length && env[f] > on;
      if (v && start < 0) start = f;
      if (!v && start >= 0) { spans.push([start / 100, f / 100]); start = -1; }
    }
    const merged = [];                                       // gaps under 70 ms are inside a word, not pauses
    for (const s of spans) { const p = merged[merged.length - 1]; if (p && s[0] - p[1] < 0.07) p[1] = s[1]; else merged.push(s.slice()); }
    return merged;
  }

  // the timeline: [{ t0, t1, v }] in seconds from the start of the sound
  function build(text, audioBuffer, duration) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const items = words.map(w => {
      const v = wordShapes(w); const weight = v.reduce((a, x) => a + (LEN[x] || 1), 0) || 1;
      return { v, weight, pause: /[,;:.!?…—-]$/.test(w) };
    });
    let spans = null, dur = duration;
    if (audioBuffer) { const env = envelope(audioBuffer); spans = voicedSpans(env); dur = audioBuffer.duration; }
    if (!spans || !spans.length) spans = [[Math.min(0.05, (dur || 1) * 0.05), dur || Math.max(1, text.length * 0.065)]];
    const voiced = spans.reduce((a, s) => a + s[1] - s[0], 0);
    // voiced time -> real time (skipping the pauses)
    const real = x => { for (const s of spans) { const l = s[1] - s[0]; if (x <= l) return s[0] + x; x -= l; } return spans[spans.length - 1][1]; };
    // pin each phrase end (a word with punctuation) to the pause nearest its share of the sentence
    const total = items.reduce((a, it) => a + it.weight, 0) || 1, gaps = [];
    let acc = 0; for (let k = 0; k < spans.length - 1; k++) { acc += spans[k][1] - spans[k][0]; gaps.push({ at: acc / voiced, k, used: false }); }
    const anchors = [[0, 0]];                                // [word index, voiced seconds]
    let cw = 0;
    items.forEach((it, i) => {
      cw += it.weight;
      if (!it.pause || i === items.length - 1) return;
      const f = cw / total; let best = null;
      for (const g of gaps) if (!g.used && Math.abs(g.at - f) < 0.18 && (!best || Math.abs(g.at - f) < Math.abs(best.at - f))) best = g;
      if (best && best.at * voiced > anchors[anchors.length - 1][1]) { best.used = true; anchors.push([i + 1, best.at * voiced]); }
    });
    anchors.push([items.length, voiced]);
    const tl = [];
    for (let a = 0; a < anchors.length - 1; a++) {
      const [i0, v0] = anchors[a], [i1, v1] = anchors[a + 1];
      const seg = items.slice(i0, i1), w = seg.reduce((s, it) => s + it.weight, 0) || 1;
      let x = v0;
      for (const it of seg) {
        const wl = (v1 - v0) * it.weight / w, per = wl / (it.weight || 1);
        for (const v of it.v) { const l = per * (LEN[v] || 1); tl.push({ t0: real(x), t1: real(x + l), v }); x += l; }
        if (!it.v.length) x += wl;
      }
    }
    return tl;
  }

  // the shape at time t, eased into the next one near its end so the lips move rather than jump
  function at(tl, t) {
    if (!tl || !tl.length) return null;
    let lo = 0, hi = tl.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tl[mid].t0 <= t) lo = mid; else hi = mid - 1; }
    const cur = tl[lo];
    if (t < cur.t0 || t > cur.t1 + 0.06) return { a: SHAPES.sil, b: null, k: 0 };
    const nxt = tl[lo + 1], len = cur.t1 - cur.t0, k = len > 0 && nxt && nxt.t0 - cur.t1 < 0.05 ? Math.max(0, (t - (cur.t1 - len * 0.35)) / (len * 0.35)) : 0;
    return { a: SHAPES[cur.v] || SHAPES.sil, b: nxt ? SHAPES[nxt.v] : null, k: Math.min(1, k), v: cur.v };
  }

  window.__jvLips = { build, at, wordShapes, SHAPES };
})();
