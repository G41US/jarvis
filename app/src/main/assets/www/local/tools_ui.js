// tools_ui.js - spoken commands for the app's own screens: the Earnings page, "what do you know about me", driving mode.
import { summary } from './earnings.js';

const P = () => (typeof window !== 'undefined' && window.AndroidPhone) || null;
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

/** The delivery log, the tracked shifts and the running one, for earnings.js. */
export function earningsInput(delivery) {
  const p = P(), log = (delivery && delivery._db().log) || [];
  const trips = (p && p.trips && parse(p.trips())) || [];
  const s = (p && p.shiftStatus && parse(p.shiftStatus())) || {};
  return { log, trips, live: s.active ? { start: s.start, meters: s.meters || 0 } : null, now: Date.now() };
}

export function registerUiTools(ctx) {
  const { reg, config, delivery, kv } = ctx, T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const cur = () => config.get('currency', '$') || '$';
  const money = (n, d = 0) => `${cur()}${Number(n || 0).toFixed(d)}`;
  const W = () => (typeof window !== 'undefined' && window.JARVIS) || {};

  T('show_earnings', "Open the Earnings page (today and this week: earned, orders, per hour, per mile; the last 7 days; the user's best-paying hours and areas) and say the headline. Use for 'show my earnings', 'how much did I make this week', 'what are my best hours', 'where pays best'.",
    { focus: { type: 'string', enum: ['today', 'week', 'hours', 'areas'] } }, [], a => {
      const s = summary(earningsInput(delivery)), f = a.focus || 'week';
      if (W().openEarnings) W().openEarnings(f === 'today' ? 'today' : 'week');
      if (!s.total) return "No deliveries logged yet. When you tell me an order's delivered, I'll add its pay here. I've opened the Earnings page.";
      const p = f === 'today' ? s.today : s.week, when = f === 'today' ? 'Today' : 'This week';
      let say = `${when}: ${money(p.earned, 2)} from ${p.orders} order${p.orders !== 1 ? 's' : ''}`;
      if (p.perHour) say += `, about ${money(p.perHour)} an hour`;
      if (p.perMile) say += ` and ${money(p.perMile, 2)} a mile`;
      say += '.';
      if ((f === 'hours' || f === 'week') && s.hours.length) say += ` Your best hours are ${s.hours[0].label.replace('–', ' to ')}, about ${money(s.hours[0].avg)} on average.`;
      if (f === 'areas' && s.areas.length) say += ` Best-paying: ${s.areas.slice(0, 2).map(x => `${x.name} at ${money(x.avg, 2)} an order`).join(', and ')}.`;
      return say;
    });

  T('show_what_you_know', "Open the page that lists everything Jarvis has learned and saved about the user (facts, preferences, notes, places, faces, emergency contacts), where they can delete anything; say a short summary. Use for 'what do you know about me', 'show my memories'.",
    {}, [], () => {
      if (W().openKnows) W().openKnows();
      const facts = (kv.get('memories', []) || []).length, prefs = (kv.get('prefs', []) || []).length, notes = (kv.get('notes', []) || []).length;
      const places = Object.keys(config.get('places', {}) || {}).length, name = String(config.get('user_name', '') || '');
      if (!facts && !prefs && !notes && !places && !name) return "I don't know much about you yet. As we talk I'll learn things, and they'll show up on this page, where you can delete anything.";
      const bits = [facts && `${facts} thing${facts > 1 ? 's' : ''} about you`, prefs && `${prefs} preference${prefs > 1 ? 's' : ''}`, notes && `${notes} note${notes > 1 ? 's' : ''}`, places && `${places} saved place${places > 1 ? 's' : ''}`].filter(Boolean);
      return `${name ? `You're ${name}. ` : ''}${bits.length ? `I've saved ${bits.join(', ')}. ` : ''}It's all on the screen now; tap the cross next to anything that's wrong and I'll forget it.`;
    });

  T('choose_face', "Change Jarvis's face: male or female (a glowing head made of light that reacts as he listens, thinks and talks), or orb (no face, just a ball of light that moves with his voice; saves battery). The voice changes to match. Use for 'change your face', 'use your female face', 'use the orb', 'show your face again'.",
    { face: { type: 'string', enum: ['male', 'female', 'orb', 'back'] } }, ['face'], async a => {
      let id = String(a.face || '').toLowerCase();
      if (id === 'back') id = config.get('avatar_gender', 'male') === 'female' ? 'female' : 'male';
      return ctx.chooseFace ? ctx.chooseFace(id) : 'I can only change my face in the app.';
    });

  T('set_driving_mode', "Driving mode: a simple screen with big text and big buttons for while the user drives (time, next stop, today's pay). mode: on, off, or auto (comes on by itself during a shift or while moving).",
    { mode: { type: 'string', enum: ['on', 'off', 'auto'] } }, ['mode'], a => {
      const m = ['on', 'off', 'auto'].includes(a.mode) ? a.mode : 'auto';
      config.set('drive_mode', m); try { window.dispatchEvent(new Event('jv-refresh')); } catch {}
      return m === 'on' ? 'Driving mode on.' : m === 'off' ? "Driving mode off. It won't come on by itself until you turn it back on." : "Driving mode is automatic: it comes on when you start a shift or start driving.";
    });
}
