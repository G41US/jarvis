// tools.js - tool registry (the same shape Groq's tool calling expects) + helpers shared by the tool modules.
const FALLBACK = { search_web: [['news_headlines', 'topic'], ['wikipedia', 'query']], news_headlines: [['search_web', 'query']], wikipedia: [['search_web', 'query']] };
const NOTHING = /^(Tool \w+ (failed|got bad)|No results found|No wikipedia entry|Unknown tool|I couldn't reach the news)/i;
export class Registry {
  constructor() { this.schemas = []; this.fns = {}; }
  /** add(name, description, properties, required, fn) ; fn(args) -> string | Promise<string> */
  add(name, description, properties, required, fn) {
    this.fns[name] = fn;
    this.schemas.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties: properties || {}, required: required || [] } } });
  }
  has(name) { return name in this.fns; }
  /** Drops tools this phone can't do (on iPhone: reading the screen, other apps' notifications...). */
  remove(names) { const drop = new Set(names); for (const n of drop) delete this.fns[n]; this.schemas = this.schemas.filter(s => !drop.has(s.function.name)); }
  async exec(name, rawArgs) {
    let args = {};
    try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {}); } catch { args = {}; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    const out = await this.run(name, args);
    if (!NOTHING.test(out) || !FALLBACK[name]) return out;
    // that way found nothing: try the next way of finding the same thing before saying anything
    const q = String(args.query || args.topic || '').trim() || 'latest news';
    for (const [alt, key] of FALLBACK[name]) {
      if (!this.fns[alt]) continue;
      const got = await this.run(alt, { [key]: q });
      console.log('[TOOL]', name, 'found nothing; tried', alt, '->', got.slice(0, 80));
      if (!NOTHING.test(got)) return got;
    }
    return "Nothing could be found online for that just now (the search services didn't answer). Say so in a few words and offer to try again.";
  }
  async run(name, args) {
    const fn = this.fns[name];
    if (!fn) return `Unknown tool: ${name}`;
    try { const r = await fn(args); return String(r ?? ''); }
    catch (e) { console.warn('[TOOL FAIL]', name, e); return `Tool ${name} failed: ${(e && e.message) || e}`; }
  }
}
export const sayList = (a) => a.filter(Boolean).join(' ');
