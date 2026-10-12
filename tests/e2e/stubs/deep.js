// A stand-in for three.js in tests: every constructor/call/property yields another harmless proxy, so the page's own logic runs without WebGL.
export function deep() {
  const cache = new Map();
  const mk = () => new Proxy(function () {}, {
    get(t, k) { if (k === Symbol.toPrimitive) return () => 0; if (k === Symbol.iterator) return function* () {}; if (k === 'then') return undefined; if (k === 'length') return 0;
      if (!cache.has(k)) cache.set(k, deep()); return cache.get(k); },
    set() { return true; }, apply() { return deep(); }, construct() { return deep(); }, has() { return true; } });
  return mk();
}
