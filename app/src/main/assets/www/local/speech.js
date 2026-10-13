// speech.js - turns written text into something that sounds right out loud. The AI sometimes writes **bold**, bullet
// points, links or emoji; a speech engine reads those as "asterisk asterisk", "hyphen", "h t t p s" or "cherry".
// Everything Jarvis says (and shows as his answer) passes through forSpeech().

const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}|️)|[\u{1F3FB}-\u{1F3FF}])*/gu;

/** Drop emoji (and the joiners and skin tones that hang off them). */
export const noEmoji = s => String(s || '').replace(EMOJI, '').replace(/[️‍⃣]/g, '');

const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'the link'; } };

export function forSpeech(text) {
  let s = String(text || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');                                     // code blocks are not for reading out
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1');                     // [text](url) -> text
  s = s.replace(/https?:\/\/[^\s)]+/g, m => host(m));                         // bare links -> the site's name
  s = s.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (m, t) => /[.!?:;,]$/.test(t.trim()) ? t.trim() : t.trim() + '.');   // headings
  s = s.replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+(.*)$/gm, (m, t) => /[.!?:;,]$/.test(t.trim()) ? t.trim() : t.trim() + '.');   // list items become sentences
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2');   // **bold**, *italic*
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/[*#`~|<>^]+/g, ' ');                                         // anything left over
  s = noEmoji(s);
  s = s.replace(/°\s?F\b/g, ' degrees Fahrenheit').replace(/°\s?C\b/g, ' degrees Celsius').replace(/°/g, ' degrees')
    .replace(/\s?->\s?|\s?→\s?/g, ' to ').replace(/\s&\s/g, ' and ').replace(/\bw\/(?=\s)/g, 'with').replace(/\be\.g\.\s?/gi, 'for example ').replace(/\bi\.e\.\s?/gi, 'that is ')
    .replace(/(\d)\s?\/\s?(hr|hour)\b/g, '$1 an hour').replace(/(\d)\s?\/\s?(mi|mile)\b/g, '$1 a mile').replace(/\s[—–]\s|[—–]/g, ', ');
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/([!?;])(?=[A-Za-z])/g, '$1 ').replace(/\.(?=[A-Z][a-z])/g, '. ')
    .replace(/,\s*,/g, ',').replace(/^[\s,.;:]+/, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}
