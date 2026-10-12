// tools.js - tool registry (the same shape Groq's tool calling expects) + helpers shared by the tool modules.
export class Registry {
  constructor() { this.schemas = []; this.fns = {}; }
  /** add(name, description, properties, required, fn) ; fn(args) -> string | Promise<string> */
  add(name, description, properties, required, fn) {
    this.fns[name] = fn;
    this.schemas.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties: properties || {}, required: required || [] } } });
  }
  has(name) { return name in this.fns; }
  async exec(name, rawArgs) {
    let args = {};
    try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {}); } catch { args = {}; }
    const fn = this.fns[name];
    if (!fn) return `Unknown tool: ${name}`;
    try { const r = await fn(args || {}); return String(r ?? ''); }
    catch (e) { console.warn('[TOOL FAIL]', name, e); return `Tool ${name} failed: ${(e && e.message) || e}`; }
  }
}
export const sayList = (a) => a.filter(Boolean).join(' ');
