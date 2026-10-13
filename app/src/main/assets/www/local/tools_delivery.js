// tools_delivery.js - the delivery copilot tools and instant voice commands (port of the delivery block in server.py).
import { shortAddr } from './delivery.js';

export function registerDeliveryTools(ctx) {
  const { reg, delivery: D } = ctx, T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const money = (v, dec = 2) => D.money(v, dec);
  async function refresh() {
    const plan = await D.plan(); await D.push(plan);
    const nav = ctx.navsvc;
    if (nav && nav.state.active && nav.state.delivery) nav.refreshDelivery();                                   // re-route the map in the background
    else if (nav && plan.ok && ctx.config.get('dash_map', true) !== false) nav.startDash().catch(e => console.warn('[DELIVERY] map', e));   // orders: the map comes up under the card
    if (nav && !plan.ok) nav.endDash();                                                                          // all done: the face comes back
    return plan;
  }
  // You parked at a stop for a while and drove off: that stop is done (say "undo" if not).
  if (ctx.navsvc) ctx.navsvc.onStopDone(async kind => {
    const r = await D.completeNext('', kind); if (!r.ok) return;
    const plan = await refresh();
    let head = r.kind === 'pickup' ? `Marked ${r.restaurant} picked up.` : `Marked ${r.restaurant} delivered.` + (r.payout ? ` ${money(r.payout)} banked.` : '');
    head += plan.ok ? ' ' + D.spokenNext(plan) : ' That was the last stop.';
    ctx.broadcast('proactive:' + head + ' Say undo if that was wrong.');
  });
  T('add_delivery_order', "Add a delivery order the driver has accepted (DoorDash, Uber Eats, Grubhub...) to the stack (max 4) and return the best route. Needs the restaurant and where it goes: a full street address OR just a place, landmark, apartment complex, street or neighbourhood if that's all the driver has. Never insist on a street number.",
    { restaurant: { type: 'string' }, dropoff_address: { type: 'string', description: "customer's address, or the place / area if the exact address isn't known yet (e.g. 'Arcadia', 'near Tempe Marketplace', 'Mill Avenue')" }, pickup_address: { type: 'string', description: 'restaurant street address, if known' },
      payout: { type: 'number', description: 'total money for this order including tip' }, platform: { type: 'string', description: 'doordash, ubereats, grubhub...' },
      ready_in_minutes: { type: 'number', description: 'minutes until food is ready, 0 if ready' }, deliver_within_minutes: { type: 'number', description: 'minutes until it is due, if shown' } },
    ['restaurant', 'dropoff_address'], async a => {
      const r = await D.addOrder(a.restaurant, a.dropoff_address, a.pickup_address || '', a.payout || 0, a.platform || 'doordash', a.ready_in_minutes || 0, a.deliver_within_minutes || 0);
      if (!r.ok) return r.error; const plan = await refresh();
      const rough = r.approx ? ` I only have ${r.approx === 'street' ? 'the street' : 'the area'} for that drop-off, so I'll route to ${r.approx === 'street' ? 'that street' : 'the area'} for now. Tell me the number when you have it.` : '';
      return `Added order ${r.id}: ${r.restaurant} to ${r.dropoff}.${rough} ` + D.spokenPlan(plan);
    });
  T('update_delivery_address', "Fill in or correct an order's drop-off later: just the house number ('it's 1420', 'the number is 22B'), or a full or better address. If the order isn't named, it applies to the order whose address is still approximate.",
    { address: { type: 'string', description: "the house number alone, or the full / better address" }, order: { type: 'string', description: 'restaurant name or order number, optional' } }, ['address'], async a => {
      const r = await D.updateAddress(a.order || '', a.address); if (!r.ok) return r.error;
      const plan = await refresh();
      const head = r.precision === 'exact' ? `Got it: ${r.restaurant} goes to ${r.dropoff}.` : `Updated ${r.restaurant} to ${r.dropoff}, still approximate.`;
      return `${head}${r.moved_m > 300 ? ` That moved the stop about ${D.units === 'km' ? (r.moved_m / 1000).toFixed(1) + ' kilometers' : (r.moved_m / 1609.344).toFixed(1) + ' miles'}.` : ''} ` + D.spokenNext(plan);
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
  T('undo_stop', 'Undo the last stop marked picked up or delivered (said by mistake, or Jarvis marked it when the driver drove off). Use for "undo", "not yet", "I haven\'t picked it up".', {}, [], async () => {
    const m = D.undoLast(); if (!m) return 'There\'s nothing recent to undo.';
    const plan = await refresh(); return `Undone: ${m.restaurant} is back as ${m.kind === 'pickup' ? 'not picked up yet' : 'not delivered yet'}. ` + (plan.ok ? D.spokenNext(plan) : '');
  });
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
  const UNDO = /^(undo( that| it)?|not yet|that'?s wrong|i (haven'?t|didn'?t|did not|have not) (picked|pick|got|delivered|deliver|dropped|drop)( \w+)*( (it|them) (up|off))?( yet)?|(it|that) (wasn'?t|was not) (delivered|picked up)( yet)?)[.!]?$/i;
  const EARN = /\b(my earnings|how much (have )?i (made|earned)|earnings (so far|today))\b/i;
  // "it's 1420", "the number is 22B", "house number 1420" while an order still has only a rough address
  const NUMBER_ONLY = /^(?:(?:ok(?:ay)?|so|and)[, ]+)?(?:it'?s|it is|the (?:house |street |building )?number(?: is)?|house number|number)\s+#?(\d{1,6}[a-z]?)[.!]?$/i;
  async function fastpath(text) {
    const t = String(text || '').trim(); if (!t) return null;
    if (EARN.test(t)) return earnings();
    if (UNDO.test(t) && D._undo) return reg.exec('undo_stop', '{}');
    if (!D.hasActive()) return null;
    const nm = NUMBER_ONLY.exec(t);
    if (nm && D.activeOrders().some(o => o.drop_precision === 'street')) return reg.exec('update_delivery_address', JSON.stringify({ address: nm[1] }));
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
