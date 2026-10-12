// api.js - where Jarvis's brain and ears live.
// Two ways to reach Groq:
//  1. the user's own Groq key (settings screen), straight to api.groq.com
//  2. no key at all: the Jarvis proxy set at build time (server/worker.js holds the key, so users never need one)
import { BUILD } from './build_config.js';
import { apiFetch, kv } from './net.js';

const GROQ = 'https://api.groq.com/openai/v1';
export function createApi(config) {
  const userKey = () => String(config.get('groq_key', '') || '').trim().replace(/^["']|["']$/g, '').split(/\s+/)[0] || '';
  const proxy = () => String(BUILD.apiBase || '').trim().replace(/\/+$/, '');
  let device = kv.get('device_id', '');
  if (!device) { device = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''); kv.set('device_id', device); }
  const api = {
    /** 'key' (user's own key), 'proxy' (built-in service) or '' (nothing configured) */
    mode: () => (userKey() ? 'key' : proxy() ? 'proxy' : ''),
    ready: () => !!api.mode(),
    base: () => (api.mode() === 'proxy' ? proxy() : GROQ),
    headers: (extra = {}) => (api.mode() === 'proxy'
      ? { 'X-Jarvis-Token': BUILD.appToken || '', 'X-Jarvis-Device': device, ...extra }
      : { Authorization: 'Bearer ' + userKey(), ...extra }),
    fetch: (path, init = {}) => apiFetch(api.base() + path, { ...init, headers: api.headers(init.headers || {}) }),
    userKey, device: () => device, hasProxy: () => !!proxy(),
  };
  return api;
}
