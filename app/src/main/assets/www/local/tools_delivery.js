// tools_delivery.js - the delivery copilot tools and instant voice commands (port of the delivery block in server.py).
import { shortAddr } from './delivery.js';

export function registerDeliveryTools(ctx) {
  const { reg, delivery: D } = ctx, T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const money = (v, dec = 2) => D.money(v, dec);
  async function refresh() {
    const plan = await D.plan(); await D.push(plan);
    if (ctx.navsvc && ctx.navsvc.state.active && ctx.navsvc.state.delivery) ctx.navsvc.refreshDelivery();      // re-route the map in the background
    return plan;
  }
  T('add_delivery_order', "Add a delivery order the driver has accepted (DoorDash, Uber Eats, Grubhub...) to the stack (max 4) and return the best route. Needs the restaurant and the customer's drop-off street address.",
    { restaurant: { type: 'string' }, dropoff_address: { type: 'string', description: 'customer street address' }, pickup_address: { type: 'string', description: 'restaurant street address, if known' },
      payout: { type: 'number', description: 'total money for this order including tip' }, platform: { type: 'string', description: 'doordash, ubereats, grubhub...' },
      ready_in_minutes: { type: 'number', description: 'minutes until food is ready, 0 if ready' }, deliver_within_minutes: { type: 'number', description: 'minutes until it is due, if shown' } },
    ['restaurant', 'dropoff_address'], async a => {
      const r = await D.addOrder(a.restaurant, a.dropoff_address, a.pickup_address || '', a.payout || 0, a.platform || 'doordash', a.ready_in_minutes || 0, a.deliver_within_minutes || 0);
      if (!r.ok) return r.error; const plan = await refresh(); return `Added order ${r.id}: ${r.restaurant} to ${r.dropoff}. ` + D.spokenPlan(plan);
    });
  T('plan_deliveries', 'Recalculate and read out the best route for the current stack of orders.', {}, [], async () => D.spokenPlan(await refresh()));
  T('next_stop', 'Say where the driver should go next and when they will arrive.', {}, [], async () => D.spokenNext(await refresh()));
  T('complete_stop', 'The driver finished a stop. Use when they say picked up / got the food, or delivered / dropped off. Optionally name the restaurant if it is not the next planned stop.',
    { order: { type: 'string', description: 'restaurant name or order id, optional' }, stop_type: { type: 'string', enum: ['pickup', 'drop'], description: 'pickup or drop, optional' } }, [], async a => completeStop(a.order || '', a.stop_type || ''));
  async function completeStop(order, kind) {
    const r = await D.completeNext(order, kind); if (!r.ok) return r.error;
    const plan = await refresh(); let head;
    if (r.kind === 'pickup') head = `Picked up from ${r.restaurant}.`; else head = `Delivered ${r.restaurant}.` + (r.payout ? ` ${money(r.payout)} banked.` : '');
    if (!plan.ok) { const e = D.earnings(); return head + ` Stack cleared. Today: ${e.count} deliveries, ${money(e.total)}.`; }
    return head + ' ' + D.spokenNext(plan);
  }
  T('list_delivery_orders', 'List the orders currently in the stack.', {}, [], () => D.spokenOrders());
  T('remove_delivery_order', 'Remove one order from the stack (cancelled or unassigned).', { order: { type: 'string', description: 'restaurant name or order id' } }, ['order'], async a => {
    const o = D.removeOrder(a.order); if (!o) return `No active order matching ${a.order}.`; const plan = await refresh(); return `Removed ${o.restaurant}. ` + (plan.ok ? D.spokenPlan(plan) : 'The stack is empty.');
  });
  async function clearAll() { const n = D.clear(); await D.push({ ok: false }); if (ctx.navsvc && ctx.navsvc.state.delivery) ctx.navsvc.refreshDelivery(); return `Cleared ${n} order${n !== 1 ? 's' : ''}.`; }
  T('clear_deliveries', 'Clear every order from the stack.', {}, [], clearAll);
  T('set_my_location', 'Tell Jarvis where the driver is now, so routes start from there.', { address: { type: 'string' } }, ['address'], async a => {
    const g = await D.setLocation(a.address); if (!g) return `Couldn't find ${a.address}.`; if (D.hasActive()) await refresh();
    return `Location set to ${shortAddr(a.address)}.` + (g.area ? ` Search area is now ${g.area}.` : '');
  });
  T('evaluate_delivery_offer', 'Judge a delivery offer BEFORE the driver accepts it: extra time and miles it adds to the current stack, money per hour and per mile, and whether it makes anyone late.',
    { restaurant: { type: 'string' }, dropoff_address: { type: 'string' }, pickup_address: { type: 'string' }, payout: { type: 'number' }, platform: { type: 'string' }, ready_in_minutes: { type: 'number' } },
    ['restaurant', 'dropoff_address', 'payout'], async a => {
      const r = await D.evaluateOffer(a.restaurant, a.dropoff_address, a.pickup_address || '', a.payout || 0, a.platform || '', a.ready_in_minutes || 0); if (!r.ok) return r.error;
      const cfg = D.cfg, words = { take: 'Take it.', marginal: 'Marginal.', decline: "I'd pass.", unknown: 'No payout given, so no verdict.' }, per = D.unitWord === 'kilometers' ? 'kilometer' : 'mile';
      let txt = `${words[r.verdict]} It adds about ${r.extra_min} minutes and ${r.extra_miles} ${D.unitWord} to your run`;
      if (r.payout > 0) txt += ` for ${money(r.payout)}, roughly ${money(r.per_hour, 0)} an hour and ${money(r.per_mile)} a ${per}. Your floors are ${money(cfg.min_per_hour, 0)} an hour and ${money(cfg.min_per_mile)} a ${per}.`; else txt += '.';
      if (r.extra_late_min >= 2) txt += ` It would make other drop-offs about ${r.extra_late_min} minutes later.`;
      txt += ` On-time risk with it: ${r.risk}.`;
      if (r.plan.source === 'estimate') txt += ' Map service was unreachable, so these are estimates.';
      return txt + ' Your call. You accept it in the app; tell me if you do.';
    });
  T('open_navigation', 'Open turn-by-turn directions through every stop of the planned route in Google Maps.', {}, [], async () => {
    const plan = await refresh(); if (!plan.ok) return plan.error || 'No active orders.'; ctx.openUrl(plan.nav_url); return `Opened directions through ${plan.stops.length} stops.`;
  });
  T('delivery_earnings', "Today's delivery earnings and pace.", {}, [], () => earnings());
  function earnings() {
    const e = D.earnings(); if (!e.count) return 'No completed deliveries logged today.';
    const by = Object.entries(e.by_platform).map(([k, v]) => `${k} ${money(v)}`).join(', ');
    const pace = e.per_hour ? ` About ${money(e.per_hour, 0)} an hour over ${e.hours} hours.` : '', mi = e.miles ? ` ${e.miles} ${D.unitWord} driven, ${money(e.per_mile)} a ${D.unitWord === 'kilometers' ? 'kilometer' : 'mile'}.` : '';
    return `Today: ${e.count} deliveries, ${money(e.total)} (${by}).${pace}${mi}`;
  }

  // ---- instant voice commands (skip the AI)
  const NEXT = /\b(next stop|where (do i go |to )?next|what.?s next|where am i going)\b/i;
  const DONE = /\b(picked (it |them |the \w+ )?up|got (the|my) (food|order)|pick.?up (is )?done|(just )?delivered|dropped (it |them )?off|drop.?off (is )?done|done with (this|that) stop)\b/i;
  const PLAN = /\b(plan|re-?plan|optimi[sz]e)\b.*\b(route|stack|deliver\w*)\b|\b(best|my) route\b/i;
  const CLEAR = /\b(clear|cancel|reset|wipe)\b.*\b(all )?(my )?(orders|stack|route|deliveries)\b/i;
  const EARN = /\b(my earnings|how much (have )?i (made|earned)|earnings (so far|today))\b/i;
  async function fastpath(text) {
    const t = String(text || '').trim(); if (!t) return null;
    if (EARN.test(t)) return earnings();
    if (!D.hasActive()) return null;
    if (t.includes('?') || /^(how|what|when|why|did|have|which|can|should)\b/i.test(t)) { if (!(NEXT.test(t) || PLAN.test(t))) return null; }
    if (CLEAR.test(t)) return clearAll();
    if (DONE.test(t)) {
      const ref = (D.activeOrders().find(o => t.toLowerCase().includes(o.restaurant.toLowerCase())) || {}).restaurant || '';
      const kind = /picked|pick.?up|got (the|my)/i.test(t) ? 'pickup' : /deliver|dropped|drop.?off/i.test(t) ? 'drop' : '';
      return completeStop(ref, kind);
    }
    if (NEXT.test(t)) return D.spokenNext(await refresh());
    if (PLAN.test(t)) return D.spokenPlan(await refresh());
    return null;
  }
  return { fastpath, refresh };
}
