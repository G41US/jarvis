// A failed or empty search tries the news and Wikipedia before Jarvis says anything; harder questions get more thinking.
import assert from 'node:assert/strict';
import { Registry } from '../app/src/main/assets/www/local/tools.js';
import { effortFor } from '../app/src/main/assets/www/local/brain.js';
console.warn = console.log = () => {};
const r = new Registry(), seen = [];
r.add('search_web', '', {}, [], () => { seen.push('search'); throw new Error('blocked'); });
r.add('news_headlines', '', {}, [], a => { seen.push('news:' + a.topic); return 'Headlines: France news.'; });
assert.equal(await r.exec('search_web', '{"query":"France"}'), 'Headlines: France news.');
assert.deepEqual(seen, ['search', 'news:France']);
r.fns.news_headlines = () => "I couldn't reach the news right now.";
assert.match(await r.exec('search_web', '{"query":"France"}'), /^Nothing could be found/);
assert.match(await r.exec("news_headlines", "[]"), /^Nothing could be found/);   // odd arguments are ignored, and its own fallback runs
assert.equal(effortFor('what is happening in France'), 'medium');
assert.equal(effortFor('think hard about this'), 'high');
assert.equal(effortFor('open whatsapp'), 'low');
process.stdout.write('brain fallback OK\n');
