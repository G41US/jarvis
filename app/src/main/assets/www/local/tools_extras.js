// tools_extras.js - camera extras and the expense log:
//   "translate this menu", "what does this sign say in English"   -> translate_with_camera
//   "scan this QR code"                                            -> scan_qr (live, on the phone; Wi-Fi codes give the password)
//   "scan this receipt", "I spent 40 dollars on gas"               -> scan_receipt / add_expense
//   "how much did I spend this week", "export my expenses"         -> expense_summary
import { scanQr } from './camera.js';

export const CATEGORIES = ['fuel', 'food', 'parking', 'tolls', 'phone', 'car maintenance', 'car wash', 'supplies', 'insurance', 'groceries', 'shopping', 'bills', 'other'];
const CAT_WORDS = [[/\b(gas|fuel|petrol|diesel|shell|chevron|exxon|mobil|bp|valero|circle k|speedway|marathon|sunoco|wawa|sheetz|qt|quiktrip|costco gas)\b/i, 'fuel'],
  [/\b(park|parking|meter)\b/i, 'parking'], [/\b(toll|tolls|e-?zpass|sunpass|fastrak)\b/i, 'tolls'], [/\b(oil change|tire|tyre|repair|mechanic|auto ?zone|jiffy|brake|maintenance)\b/i, 'car maintenance'],
  [/\b(car ?wash)\b/i, 'car wash'], [/\b(insulated bag|hot bag|phone mount|charger|supplies)\b/i, 'supplies'], [/\b(phone|verizon|t-?mobile|at&t|cricket|data plan)\b/i, 'phone'],
  [/\b(insurance)\b/i, 'insurance'], [/\b(lunch|dinner|breakfast|coffee|food|restaurant|mcdonald|starbucks|chick-?fil-?a|burger|pizza|taco)\b/i, 'food'], [/\b(grocer|walmart|kroger|aldi|publix)\b/i, 'groceries']];
/** Delivery drivers can usually deduct these (the IRS standard mileage rate already covers fuel and car upkeep if they use it). */
export const BUSINESS = new Set(['parking', 'tolls', 'phone', 'supplies']);
export const guessCategory = text => { for (const [re, c] of CAT_WORDS) if (re.test(text)) return c; return 'other'; };

const money = (n, cur = '$') => `${cur}${Number(n || 0).toFixed(2)}`;
const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** [from, to) epoch ms for today / week / month / year / last week / last month / all. Weeks start on Monday. */
export function periodRange(period = 'week', now = new Date()) {
  const p = String(period || 'week').toLowerCase(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/today/.test(p)) return [d0.getTime(), d0.getTime() + 86400000, 'today'];
  if (/yesterday/.test(p)) return [d0.getTime() - 86400000, d0.getTime(), 'yesterday'];
  if (/last week/.test(p)) { const m = new Date(d0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7) - 7); return [m.getTime(), m.getTime() + 7 * 86400000, 'last week']; }
  if (/week/.test(p)) { const m = new Date(d0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return [m.getTime(), now.getTime() + 1, 'this week']; }
  if (/last month/.test(p)) { const a = new Date(now.getFullYear(), now.getMonth() - 1, 1), b = new Date(now.getFullYear(), now.getMonth(), 1); return [a.getTime(), b.getTime(), 'last month']; }
  if (/month/.test(p)) return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime() + 1, 'this month'];
  if (/last year/.test(p)) return [new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime(), 'last year'];
  if (/year/.test(p)) return [new Date(now.getFullYear(), 0, 1).getTime(), now.getTime() + 1, 'this year'];
  return [0, now.getTime() + 1, 'in total'];
}

/** What a QR code holds, in words Jarvis can say. */
export function describeQr(t) {
  const s = String(t || '').trim();
  if (/^https?:\/\//i.test(s)) { let host = s; try { host = new URL(s).hostname.replace(/^www\./, ''); } catch {} return { kind: 'link', url: s, say: `It's a link to ${host}. Want me to open it?` }; }
  let m = /^WIFI:(.*)$/i.exec(s);
  if (m) { const f = k => { const r = new RegExp(`(?:^|;)${k}:((?:\\\\.|[^;])*)`, 'i').exec(m[1]); return r ? r[1].replace(/\\(.)/g, '$1') : ''; }; const ssid = f('S'), pw = f('P');
    return { kind: 'wifi', ssid, password: pw, say: `It's the Wi-Fi network ${ssid}${pw ? `. The password is ${pw.split('').join(' ')}. I've copied it, so you can paste it.` : ', with no password.'}` }; }
  if (/^(tel|TEL):/.test(s)) return { kind: 'phone', number: s.slice(4), say: `It's a phone number: ${s.slice(4)}. Want me to call it?` };
  if (/^(smsto|SMSTO|sms):/i.test(s)) { const p = s.split(':'); return { kind: 'sms', number: p[1], say: `It's a text message to ${p[1]}${p[2] ? ' saying ' + p[2] : ''}.` }; }
  if (/^mailto:/i.test(s)) return { kind: 'email', say: `It's an email address: ${s.slice(7).split('?')[0]}.` };
  if (/^geo:/i.test(s)) return { kind: 'place', say: `It's a location: ${s.slice(4).split('?')[0]}. I can navigate there.` };
  if (/^BEGIN:VCARD/i.test(s)) { const n = /\nFN:(.*)/i.exec(s), tel = /\nTEL[^:]*:(.*)/i.exec(s); return { kind: 'contact', say: `It's a contact card${n ? ' for ' + n[1].trim() : ''}${tel ? ', number ' + tel[1].trim() : ''}.` }; }
  return { kind: 'text', say: s.length > 300 ? `It says: ${s.slice(0, 300)}…` : `It says: ${s}` };
}

export function registerExtraTools(ctx) {
  const { reg, kv, config } = ctx, H = ctx.phoneHelpers;
  const T = (n, d, p, r, f) => reg.add(n, d, p, r, f);
  const cur = () => config.get('currency', '$') || '$';

  // ---------------------------------------------------------------- camera extras
  T('translate_with_camera', "Read and translate text through the camera: a menu, sign, label, letter or screen in another language. language: what to translate it into (default the user's language, English).",
    { language: { type: 'string' } }, [], async a => {
      const shot = await H.shoot('environment', 'Point at the text'); if (!shot.ok) return H.camFail(shot.error);
      const lang = a.language || 'English';
      return H.see(shot.dataUrl, `Read the text you can see and translate it into ${lang}. Say what kind of thing it is in a few words first (a menu, a sign...). For a menu, give the dishes with a short description and the price. Keep it to what matters; if there is a lot, give the main parts and offer the rest.`, 'a photo of text the user wants translated');
    });
  T('scan_qr', 'Scan a QR code with the camera and say what it holds (a link, a Wi-Fi password, a phone number, a contact...). open: open a link straight away.', { open: { type: 'boolean' } }, [], async a => {
    if (H.has('isVisible') && !window.AndroidPhone.isVisible()) { const r = H.call('bringToFront'); if (r === 'ok') await new Promise(x => setTimeout(x, 900)); else return H.camFail('background'); }
    const r = await scanQr(); if (!r.ok) return r.error === 'timeout' ? "I couldn't find a QR code. Hold it steady, a bit further away, and try again." : r.error === 'noscanner' ? "The QR scanner didn't load." : H.camFail(r.error);
    const d = describeQr(r.text); kv.set('last_qr', { text: r.text, at: Date.now() });
    if (d.kind === 'wifi' && d.password && H.has('clipboardSet')) H.call('clipboardSet', d.password);
    if (d.kind === 'link' && a.open) { const o = H.openUrl(d.url, 'the link'); return o === 'ok' ? `Opening ${d.url}.` : o; }
    return d.say;
  });

  // ---------------------------------------------------------------- expenses
  const list = () => kv.get('expenses', []);
  function addExpense(e) {
    const item = { id: 'e' + Date.now().toString(36), amount: Math.round(Number(e.amount) * 100) / 100, category: CATEGORIES.includes(e.category) ? e.category : guessCategory(`${e.category || ''} ${e.merchant || ''} ${e.note || ''}`),
      merchant: String(e.merchant || '').slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : isoDay(), note: String(e.note || '').slice(0, 120), source: e.source || 'voice', at: Date.now() };
    const l = list(); l.push(item); kv.set('expenses', l.slice(-2000)); return item;
  }
  ctx.expenses = { list, addExpense };
  const dayMs = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };

  T('scan_receipt', 'Photograph a receipt and log it as an expense (amount, store, date, category). For drivers: gas, parking, tolls and supplies count toward the tax log.', {}, [], async () => {
    const shot = await H.shoot('environment', 'Hold the receipt flat'); if (!shot.ok) return H.camFail(shot.error);
    const raw = await H.see(shot.dataUrl, `This is a receipt. Reply with JSON only, no other words: {"merchant":"store name","date":"YYYY-MM-DD or empty","total":number (the final amount paid),"currency":"symbol","category":"one of ${CATEGORIES.join(', ')}","items":"up to 5 main items, short"}. If it is not a receipt, reply {"error":"not a receipt"}.`, 'a photo of a receipt', { raw: true });
    let j = null; try { j = JSON.parse((/\{[\s\S]*\}/.exec(raw) || [raw])[0]); } catch {}
    if (!j || j.error || !Number.isFinite(Number(j.total)) || Number(j.total) <= 0) return j && j.error ? "That doesn't look like a receipt to me." : "I couldn't read the total. Try again with the receipt flat and in good light, or tell me the amount.";
    const e = addExpense({ amount: Number(j.total), category: j.category, merchant: j.merchant, date: j.date, note: j.items, source: 'receipt' });
    return `Logged ${money(e.amount, j.currency || cur())} at ${e.merchant || 'that store'}, as ${e.category}${e.date !== isoDay() ? ', dated ' + new Date(dayMs(e.date)).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : ''}.`;
  });
  T('add_expense', `Log an expense the user tells you ("I spent 40 dollars on gas at Shell"). category: one of ${CATEGORIES.join(', ')}. date: YYYY-MM-DD if not today.`,
    { amount: { type: 'number' }, category: { type: 'string' }, merchant: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } }, ['amount'], a => {
      if (!(Number(a.amount) > 0)) return 'How much was it?';
      const e = addExpense(a); return `Logged ${money(e.amount, cur())} for ${e.category}${e.merchant ? ' at ' + e.merchant : ''}.`;
    });
  T('expense_summary', "How much the user spent, by category: period today, week, last week, month, last month, year, all. export: 'csv' or 'pdf' saves a file to share with an accountant.",
    { period: { type: 'string' }, category: { type: 'string' }, export: { type: 'string', enum: ['', 'csv', 'pdf'] } }, [], a => {
      const [from, to, label] = periodRange(a.period || 'month'), want = String(a.category || '').toLowerCase();
      const l = list().filter(e => { const t = dayMs(e.date); return t >= from && t < to && (!want || e.category.includes(want)); }).sort((x, y) => x.date.localeCompare(y.date));
      if (!l.length) return `No expenses logged ${label}${want ? ' for ' + want : ''}.`;
      const by = {}; for (const e of l) by[e.category] = (by[e.category] || 0) + e.amount;
      const total = l.reduce((s, e) => s + e.amount, 0), biz = l.filter(e => BUSINESS.has(e.category)).reduce((s, e) => s + e.amount, 0);
      let say = `${money(total, cur())} ${label} across ${l.length} expense${l.length > 1 ? 's' : ''}: ` + Object.entries(by).sort((x, y) => y[1] - x[1]).map(([c, v]) => `${c} ${money(v, cur())}`).join(', ') + '.';
      if (biz > 0) say += ` ${money(biz, cur())} of that is parking, tolls, phone and supplies, which drivers can usually deduct on top of mileage.`;
      if (a.export && H.has('docSave')) {
        const csv = 'date,amount,category,merchant,note\n' + l.map(e => [e.date, e.amount.toFixed(2), e.category, e.merchant, e.note].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        const body = a.export === 'csv' ? csv : l.map(e => `${e.date}  ${money(e.amount, cur())}  ${e.category}${e.merchant ? ' — ' + e.merchant : ''}${e.note ? ' (' + e.note + ')' : ''}`).join('\n') + `\n\nTotal: ${money(total, cur())}\n` + Object.entries(by).map(([c, v]) => `${c}: ${money(v, cur())}`).join('\n');
        const r = H.parse(H.call('docSave', a.export, `Expenses ${label}`, body));
        if (r) { kv.set('last_doc', r); say += ` Saved as "${r.name}" in Documents. Want me to share it?`; }
      }
      return say;
    });
}
