// handoff.js - carry a conversation between the phone and the PC Jarvis, through the Jarvis service (server/worker.js).
//   "link my PC"                                     -> link_pc: a one-time 6-digit code, said aloud, for the PC
//   "continue from my PC", "what was I saying on my computer" -> continue_from_pc
//   "unlink my PC"                                   -> unlink_pc
// After each answer the phone keeps its last few lines on the service (at most every 30 s), so the PC can carry on too.
import { BUILD } from './build_config.js';
import { apiFetch } from './net.js';

const KEEP = 12, EVERY = 30000, CLIP = 400;
export const lastLines = (conversation, keep = KEEP) => conversation.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
  .slice(-keep).map(m => ({ role: m.role, content: String(m.content).slice(0, CLIP) }));
export function sayAgo(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 1440 ? `${Math.round(m / 60)} hour${m < 90 ? '' : 's'} ago` : 'more than a day ago';
}
export function readBack(hand, now = Date.now()) {
  const lines = (hand && hand.messages) || [];
  if (!lines.length) return '';
  return `On the PC (${sayAgo(now - (hand.at || now))}) the conversation went:\n` + lines.slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Jarvis'}: ${m.content}`).join('\n') +
    '\nCarry on from where it left off, briefly saying what you were in the middle of.';
}

export function registerHandoff({ reg, kv, api, fetchImpl = apiFetch }) {
  const service = () => String(BUILD.apiBase || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const pair = () => kv.get('handoff_pair', '');
  const headers = () => ({ 'X-Jarvis-Token': BUILD.appToken || '', 'X-Jarvis-Device': api.device(), 'Content-Type': 'application/json' });
  let lastPush = 0;

  reg.add('link_pc', "Link the phone with the user's PC Jarvis so a conversation can continue on either one: gives a one-time code the user says to the PC.", {}, [], async () => {
    if (!service()) return "Linking needs the Jarvis service, and this build doesn't have it.";
    const r = await fetchImpl(service() + '/link/new', { method: 'POST', headers: headers(), body: '{}' });
    if (!r.ok) return "The Jarvis service didn't give me a code just now. Try again in a minute.";
    const j = await r.json(); kv.set('handoff_pair', j.pair);
    return `Say this to your PC: Jarvis, link code ${String(j.code).split('').join(' ')}. The code works for ten minutes.`;
  });
  reg.add('continue_from_pc', 'Pick up the conversation the user was having with their PC Jarvis.', {}, [], async () => {
    if (!pair()) return "Your phone isn't linked to your PC yet. Say 'link my PC' and I'll give you a code for it.";
    const r = await fetchImpl(`${service()}/hand/${pair()}?from=pc`, { headers: headers() });
    if (r.status === 404) { kv.set('handoff_pair', ''); return "The link with your PC has expired. Say 'link my PC' to link them again."; }
    if (!r.ok) return "I couldn't reach the Jarvis service just now.";
    return readBack(await r.json()) || "There's nothing from your PC yet.";
  });
  reg.add('unlink_pc', 'Stop sharing the conversation with the PC.', {}, [], () => { kv.set('handoff_pair', ''); return 'Unlinked from your PC.'; });

  /** after each answer: keep the last few lines on the service for the PC (quietly; at most every 30 s) */
  const push = async conversation => {
    if (!pair() || !service() || Date.now() - lastPush < EVERY) return;
    lastPush = Date.now();
    try { await fetchImpl(`${service()}/hand/${pair()}?from=phone`, { method: 'PUT', headers: headers(), body: JSON.stringify({ at: Date.now(), messages: lastLines(conversation) }) }); } catch {}
  };
  return { push };
}
