// fuel.js - what fuel costs where you drive. Once a day Jarvis looks up the local pump price on the web (there's no free
// live feed for every country), or you type your own in Settings. With your car's economy that gives the fuel cost per
// km / mile, so earnings and offers can show what you keep after fuel.

/** Pulls {price, unit, source} out of the model's JSON answer; null when it isn't a believable pump price. */
export function parseFuel(text) {
  let j = null; try { j = JSON.parse(String(text || '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return null; }
  const price = Number(String(j && j.price != null ? j.price : '').replace(/[^\d.]/g, ''));
  const unit = /gal/i.test(String(j && j.unit)) ? 'gallon' : 'litre';
  if (!(price > 0) || price > 1e6) return null;
  return { price, unit, source: String((j && j.source) || '').slice(0, 80) };
}
/** Fuel cost per km or mile from a pump price and the car's economy (km per litre, or miles per gallon). */
export function costPerDistance({ price, unit }, economy, distUnit) {
  if (!(price > 0) || !(economy > 0)) return 0;
  const perLitre = unit === 'gallon' ? price / 3.78541 : price;
  return distUnit === 'km' ? perLitre / economy                       // economy in km per litre
    : (unit === 'gallon' ? price : perLitre * 3.78541) / economy;     // economy in miles per gallon
}

export function registerFuel({ reg, config, navsvc, delivery, llm, log = () => {} }) {
  const km = () => delivery.units === 'km';
  const cur = () => config.get('currency', '$') || '$';
  const economy = () => Number(config.get('fuel_economy', '')) || (km() ? 12 : 28);   // a typical small car if he hasn't said
  let busy = false;

  /** The price in use: his own if he typed one and turned auto off, else today's lookup. */
  function price() {
    const own = Number(config.get('fuel_price', ''));
    if (String(config.get('fuel_auto', 'true')) === 'false' && own > 0) return { price: own, unit: km() ? 'litre' : 'gallon', source: 'your price', at: 0, where: '' };
    const f = config.get('fuel_found', null);
    if (f && f.price > 0) return f;
    return own > 0 ? { price: own, unit: km() ? 'litre' : 'gallon', source: 'your price', at: 0, where: '' } : null;
  }
  const perDist = () => { const p = price(); return p ? costPerDistance(p, economy(), km() ? 'km' : 'mile') : 0; };

  async function lookup(force = false) {
    if (busy || String(config.get('fuel_auto', 'true')) === 'false') return null;
    const pl = navsvc.place && navsvc.place(); if (!pl) return null;
    const where = pl.text.split(',').slice(-2).join(',').trim() || pl.text, f = config.get('fuel_found', null);
    if (!force && f && f.where === where && Date.now() - f.at < 20 * 3600000) return f;
    busy = true;
    try {
      const unit = km() ? 'litre' : 'gallon';
      const found = await reg.exec('search_web', JSON.stringify({ query: `current petrol pump price per ${unit} in ${where} today` }));
      const out = await llm(`From these search results, what does regular petrol (gasoline) cost per ${unit} at the pump in ${where} right now, in ${cur()}? ` +
        `Reply only with JSON: {"price": number, "unit": "${unit}", "source": "site name"}. If the results don't say, reply {"price": 0}.\n\n${String(found).slice(0, 3500)}`);
      const p = parseFuel(out); if (!p) { log('[FUEL] no price found for', where); return null; }
      const rec = { ...p, at: Date.now(), where, cur: cur() }; config.set('fuel_found', rec); log('[FUEL]', where, rec.price, rec.unit); return rec;
    } catch (e) { log('[FUEL] lookup', e && e.message); return null; } finally { busy = false; }
  }
  setTimeout(() => lookup().catch(() => {}), 20000); setInterval(() => { if (typeof document === 'undefined' || !document.hidden) lookup().catch(() => {}); }, 3 * 3600000);

  reg.add('fuel_price', "What petrol / gas costs where the driver is (looked up once a day, or the price he set), and what that means per km or mile for his car.",
    { refresh: { type: 'boolean', description: 'look it up again now' } }, [], async a => {
      if (a.refresh) await lookup(true); else if (!price()) await lookup();
      const p = price(); if (!p) return "I couldn't find the fuel price for where you are. You can set it in Settings, under Navigation and deliveries.";
      const d = perDist(), u = km() ? 'kilometre' : 'mile';
      const when = p.at ? (Date.now() - p.at < 86400000 ? 'checked today' : 'checked ' + new Date(p.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) : '';
      return `Fuel is about ${delivery.money(p.price)} a ${p.unit}${p.where ? ' around ' + p.where : ''}${p.source ? ` (${[p.source, when].filter(Boolean).join(', ')})` : ''}. ` +
        (d ? `With your car that's about ${delivery.money(d)} a ${u}.` : '');
    });
  return { price, perDist, lookup, economy };
}
