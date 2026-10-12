// nav_core.js - the thinking part of Jarvis navigation. No DOM, so it can be tested on its own.
// Follows a route as position fixes arrive: which step you are on, when to speak, when you have
// arrived, when you have left the route. Mirrors nav.py's number formatting.

const MILE = 1609.344, FOOT = 3.28084;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dp = (b[0] - a[0]) * rad, dl = (b[1] - a[1]) * rad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function bearing(a, b) {
  const rad = Math.PI / 180;
  const p1 = a[0] * rad, p2 = b[0] * rad, dl = (b[1] - a[1]) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// ---------------------------------------------------------------- text
export function fmtDist(m, units = 'miles', short = false) {
  m = Math.max(0, +m || 0);
  if (units === 'miles') {
    const ft = m * FOOT;
    if (ft < 1000) {
      const v = ft >= 25 ? Math.max(50, Math.round(ft / 50) * 50) : Math.max(10, Math.round(ft / 10) * 10);
      return short ? `${v} ft` : `${v} feet`;
    }
    const mi = m / MILE;
    let v = mi >= 10 ? String(Math.round(mi)) : mi.toFixed(1);
    if (v.endsWith('.0')) v = v.slice(0, -2);
    return short ? `${v} mi` : `${v} mile${v === '1' ? '' : 's'}`;
  }
  if (m < 1000) {
    const v = m >= 25 ? Math.max(50, Math.round(m / 50) * 50) : Math.max(10, Math.round(m / 10) * 10);
    return short ? `${v} m` : `${v} meters`;
  }
  const km = m / 1000;
  let v = km >= 10 ? String(Math.round(km)) : km.toFixed(1);
  if (v.endsWith('.0')) v = v.slice(0, -2);
  return short ? `${v} km` : `${v} kilometer${v === '1' ? '' : 's'}`;
}

export function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 90) return s >= 45 ? 'about a minute' : 'under a minute';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60), mm = mins % 60;
  return `${h} hour${h !== 1 ? 's' : ''}` + (mm ? ` ${mm} minutes` : '');
}

const lowerFirst = s => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

// The voice is English. Street names in other scripts would come out as noise, so leave those words out.
export function sayable(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const keep = words.filter(w => !/[^\u0000-ɏḀ-ỿ -⁯ -ÿ]/.test(w));
  const out = keep.join(' ').replace(/\s+([,.])/g, '$1').replace(/\b(onto|on|toward|towards|to|into)\s*([.,]|$)/gi, '$2').replace(/\s+/g, ' ').trim();
  return out || String(text || '');
}

// ------------------------------------------------------------- geometry
export function buildCum(shape) {
  const cum = new Array(shape.length);
  cum[0] = 0;
  for (let i = 1; i < shape.length; i++) cum[i] = cum[i - 1] + hav(shape[i - 1], shape[i]);
  return cum;
}

// Nearest point of the route to p. Looks near the last known index first (cheap), whole route if that is far.
export function project(shape, cum, p, hint = 0, win = 400) {
  const n = shape.length;
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
  const scan = (lo, hi) => {
    let best = null;
    for (let i = lo; i < hi; i++) {
      const ax = (shape[i][1] - p[1]) * kx, ay = (shape[i][0] - p[0]) * ky;
      const bx = (shape[i + 1][1] - p[1]) * kx, by = (shape[i + 1][0] - p[0]) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L > 0 ? clamp(-(ax * dx + ay * dy) / L, 0, 1) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.dist) best = { idx: i, t, dist: d };
    }
    return best;
  };
  if (n < 2) return { idx: 0, t: 0, dist: Infinity, along: 0 };
  let best = scan(Math.max(0, hint - 30), Math.min(n - 1, hint + win));
  if (!best || best.dist > 60) {
    const g = scan(0, n - 1);
    if (!best || g.dist < best.dist - 5) best = g;
  }
  best.along = cum[best.idx] + best.t * (cum[best.idx + 1] - cum[best.idx]);
  return best;
}

// -------------------------------------------------------------- profiles
const PROFILES = {
  auto:          { far: [300, 1500, 35], near: [80, 300, 10], arrive: 30, off: 60, speed: 13 },
  motor_scooter: { far: [250, 1200, 35], near: [70, 250, 10], arrive: 25, off: 50, speed: 11 },
  bicycle:       { far: [120, 500, 30],  near: [35, 120, 8],  arrive: 20, off: 40, speed: 4.5 },
  pedestrian:    { far: [50, 150, 30],   near: [15, 40, 8],   arrive: 15, off: 30, speed: 1.4 },
};

export class Guide {
  /**
   * opts.say(text, {key, urgent})   speak something (the page decides whether it is muted)
   * opts.onUpdate(state)            called after every fix
   * opts.onReroute(pos)             called when you have left the route
   * opts.onArrive({leg, final, waypoint})
   */
  constructor(opts = {}) {
    this.say = opts.say || (() => {});
    this.onUpdate = opts.onUpdate || (() => {});
    this.onReroute = opts.onReroute || (() => {});
    this.onArrive = opts.onArrive || (() => {});
    this.now = opts.now || (() => Date.now());
    this.route = null;
  }

  setRoute(route, { skipFirst = true, label = '' } = {}) {
    this.route = route;
    this.label = label;
    this.profile = PROFILES[route.mode] || PROFILES.auto;
    this.units = route.units || 'miles';
    this.cum = buildCum(route.shape);
    this.total = this.cum[this.cum.length - 1] || 1;
    this.along = 0; this.hint = 0; this.stepIdx = 0; this.offCount = 0; this.lastReroute = 0;
    this.spoken = new Set(); this.arrived = new Set(); this.lastFix = null; this.speed = 0; this.done = false;
    if (skipFirst && route.steps.length) this.spoken.add('0:entered');      // the server's summary already read step 0
    this.state = this._state(route.shape[0], this.profile.speed, null);
    return this.state;
  }

  clear() { this.route = null; this.state = null; }

  _speedNow(fix) {
    if (fix && fix.speed != null && fix.speed >= 1) return fix.speed;
    const st = this.route.steps[this.stepIdx];
    if (st && st.time_s > 5 && st.dist_m > 20) return clamp(st.dist_m / st.time_s, 0.8, 35);
    return this.profile.speed;
  }

  _remaining() {
    const r = this.route, st = r.steps[this.stepIdx];
    let t = 0;
    for (let j = this.stepIdx + 1; j < r.steps.length; j++) t += r.steps[j].time_s || 0;
    if (st) {
      const len = this.cum[st.end] - this.cum[st.begin];
      const frac = len > 1 ? clamp((this.along - this.cum[st.begin]) / len, 0, 1) : 1;
      t += (st.time_s || 0) * (1 - frac);
    }
    return { dist: Math.max(0, this.total - this.along), time: Math.max(0, t) };
  }

  _state(pos, speed, heading) {
    const r = this.route, next = r.steps[this.stepIdx + 1] || null;
    const rem = this._remaining();
    const nextDist = next ? Math.max(0, this.cum[next.begin] - this.along) : 0;
    const leg = Math.min(this.arrived.size, r.legs.length - 1);
    return {
      pos, speed, heading, along: this.along, stepIdx: this.stepIdx, step: r.steps[this.stepIdx] || null, next,
      nextDist, thenStep: r.steps[this.stepIdx + 2] || null, remDist: rem.dist, remTime: rem.time,
      eta: this.now() + rem.time * 1000, idx: this.hint, off: this.offCount > 0, leg, done: this.done, units: this.units,
    };
  }

  fix(f) {
    if (!this.route || this.done) return this.state;
    const r = this.route, P = this.profile, now = this.now();
    const acc = f.acc == null ? 10 : f.acc;
    const pos = [f.lat, f.lon];
    if (acc > 150) {                                   // a coarse fix (Wi-Fi / IP location) says nothing about the road
      this.state = { ...this.state, pos, speed: this.speed, lowAccuracy: true };
      this.onUpdate(this.state);
      return this.state;
    }
    const pr = project(r.shape, this.cum, pos, this.hint);
    const thr = Math.max(P.off, 2 * acc);
    if (pr.dist > thr) {
      this.offCount++;
      if (this.offCount >= 3 && now - this.lastReroute > 8000) {
        this.lastReroute = now; this.offCount = 0;
        this.say('Off route. Recalculating.', { key: 'reroute', urgent: true });
        this.onReroute({ lat: f.lat, lon: f.lon });
      }
    } else {
      this.offCount = 0;
      this.hint = pr.idx;
      if (pr.along >= this.along - 100) this.along = Math.max(this.along, pr.along);   // jitter must not walk us backwards
      else {                                                // a real jump back (looping route, restart): re-find our step
        this.along = pr.along; this.stepIdx = 0;
        while (this.stepIdx + 1 < r.steps.length && this.cum[r.steps[this.stepIdx + 1].begin] <= this.along + 3) this.stepIdx++;
      }
    }
    // heading: GPS if moving, else direction of travel between fixes, else the road
    let heading = f.heading != null && !Number.isNaN(f.heading) && (f.speed || 0) > 1.5 ? f.heading : null;
    if (heading == null && this.lastFix && hav([this.lastFix.lat, this.lastFix.lon], pos) > 6)
      heading = bearing([this.lastFix.lat, this.lastFix.lon], pos);
    if (heading == null) {
      const i = clamp(pr.idx, 0, r.shape.length - 2);
      heading = bearing(r.shape[i], r.shape[i + 1]);
    }
    this.lastFix = { lat: f.lat, lon: f.lon };
    this.speed = this._speedNow(f);

    if (this.offCount === 0) {
      while (this.stepIdx + 1 < r.steps.length && this.cum[r.steps[this.stepIdx + 1].begin] <= this.along + 3) {
        this.stepIdx++;
        const st = r.steps[this.stepIdx], key = `${this.stepIdx}:entered`;
        // a long straight stretch: say how long it lasts
        if (!this.spoken.has(key) && st.after && st.dist_m >= 1500 && !st.icon.startsWith('arrive')) {
          this.spoken.add(key); this.say(st.after, { key });
        }
      }
      this._announce();
      this._arrivals(acc);
    }
    this.state = this._state(pos, this.speed, heading);
    this.onUpdate(this.state);
    return this.state;
  }

  _announce() {
    const r = this.route, P = this.profile;
    const next = r.steps[this.stepIdx + 1];
    if (!next) return;
    const d = this.cum[next.begin] - this.along;
    const far = clamp(this.speed * P.far[2], P.far[0], P.far[1]);
    const nearD = clamp(this.speed * P.near[2], P.near[0], P.near[1]);
    const k = this.stepIdx + 1;
    const cur = r.steps[this.stepIdx];
    const arrive = next.icon.startsWith('arrive');
    const nearKey = `${k}:near`, farKey = `${k}:far`;
    if (arrive) {
      if (d <= far && !this.spoken.has(farKey) && d > nearD) {
        this.spoken.add(farKey);
        const who = this._legLabel(next.leg);
        this.say(`${who} is ${fmtDist(d, this.units)} ahead.`, { key: farKey });
      }
      return;
    }
    if (d <= nearD && !this.spoken.has(nearKey)) {
      this.spoken.add(nearKey); this.spoken.add(farKey);
      this.say(sayable(next.say || next.text), { key: nearKey });
    } else if (d <= far && d > nearD && !this.spoken.has(farKey) && cur && cur.dist_m > far * 1.25) {
      this.spoken.add(farKey);
      this.say(`In ${fmtDist(d, this.units)}, ${lowerFirst(sayable(next.say || next.text))}`, { key: farKey });
    }
  }

  _legLabel(leg) {
    const w = this.route.waypoints && this.route.waypoints[leg + 1];
    return (w && w.label) || (leg === this.route.legs.length - 1 && this.label) || 'Your destination';
  }

  _arrivals(acc) {
    const r = this.route, P = this.profile;
    const i = this.arrived.size;
    if (i >= r.legs.length) return;
    const endAlong = this.cum[r.legs[i].end_index];
    if (this.along >= endAlong - Math.max(P.arrive, acc)) {
      this.arrived.add(i);
      const final = i === r.legs.length - 1;
      if (final) this.done = true;
      const wp = (r.waypoints && r.waypoints[i + 1]) || null;
      this.onArrive({ leg: i, final, waypoint: wp, label: this._legLabel(i) });
    }
  }
}

// ----------------------------------------------------------- simulation
// Drives a pretend car along the route so you can watch (and hear) the whole thing at your desk.
export function simulate(route, onFix, { speed = 20, tickMs = 1000, now = () => Date.now(), timer = setInterval, clear = clearInterval } = {}) {
  const cum = buildCum(route.shape);
  const total = cum[cum.length - 1];
  let d = 0, seg = 0, h = null;
  const at = dist => {
    while (seg < cum.length - 2 && cum[seg + 1] < dist) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = clamp((dist - cum[seg]) / span, 0, 1);
    const a = route.shape[seg], b = route.shape[seg + 1];
    return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, heading: bearing(a, b) };
  };
  const tick = () => {
    const p = at(Math.min(d, total));
    onFix({ lat: p.lat, lon: p.lon, heading: p.heading, speed, acc: 5, ts: now() });
    if (d >= total) { stop(); return false; }
    d += speed * tickMs / 1000;
    return true;
  };
  const id = timer(tick, tickMs);
  function stop() { clear(id); }
  tick();
  return { stop, tick, get distance() { return d; } };
}
