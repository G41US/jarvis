// The phone's globe, live feeds, answer cards and inner life: the parts that don't need a screen.
import assert from 'node:assert/strict';
import { liveOnPage, toolCards, kmBetween, whereIs } from '../app/src/main/assets/www/local/extras.js';
import { maySpeak, similar, moodWords } from '../app/src/main/assets/www/local/mind.js';

const data = { contents: [{ lockupViewModel: { contentId: 'aaa', contentImage: { x: 'BADGE_STYLE_LIVE' }, metadata: { lockupMetadataViewModel: { title: { content: 'Evening bulletin' } } } } },
  { lockupViewModel: { contentId: 'bbb', contentImage: { x: 'BADGE_STYLE_LIVE' }, metadata: { lockupMetadataViewModel: { title: { content: 'Sky News 24/7 live' } } } } },
  { lockupViewModel: { contentId: 'ccc', contentImage: {}, metadata: {} } },
  { videoRenderer: { videoId: 'ddd', title: { runs: [{ text: 'Old layout' }] }, thumbnailOverlays: [{ style: 'LIVE' }] } }] };
const ids = liveOnPage(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`);
assert.deepEqual(ids.map(x => x[0]), ['bbb', 'aaa', 'ddd']);          // round-the-clock stream first; the one not live is skipped
assert.deepEqual(liveOnPage('no data'), []);

assert.equal(Math.round(kmBetween([6.4541, 3.3947], [51.5072, -0.1276])), 5020);    // Lagos to London (haversine, 6371 km Earth)
assert.equal(whereIs('east coast USA'), 'New York');
assert.equal(whereIs('Lekki in Lagos'), 'Lagos');

const w = toolCards('get_weather', {}, 'Lagos: partly cloudy, 31 degrees Celsius, feels like 35, humidity 70 percent, wind 12 km/h.');
assert.equal(w[0].kind, 'stat'); assert.equal(w[0].value, '31°C');
assert.equal(toolCards('crypto_price', {}, 'bitcoin is at 64,210.5 dollars, down 1.2 percent today.')[0].tone, 'down');
assert.equal(toolCards('news_headlines', {}, 'Headlines: One thing. Another thing.')[0].rows.length, 2);
assert.equal(toolCards('search_web', { query: 'q' }, '- Title A: snippet a\n- Title B: snippet b')[0].rows[1].title, 'Title B');
assert.equal(toolCards('get_weather', {}, "I couldn't reach the weather service."), null);
assert.equal(toolCards('flashlight', {}, 'Flashlight on.'), null);              // device actions get no card

const t = 10_000_000;
assert.ok(maySpeak(3, t, t - 10, 0, 2, 9));                 // urgent beats night and the daily cap
assert.ok(!maySpeak(3, t, 0, t - 60000, 12, 0));            // never mid-conversation
assert.ok(!maySpeak(1, t, t - 600000, 0, 12, 0));           // small things wait 40 min
assert.ok(maySpeak(1, t, t - 3000000, 0, 12, 0));
assert.ok(!maySpeak(2, t, 0, 0, 23, 0));
assert.ok(similar('Your meeting with Bola is in ten minutes', 'Meeting with Bola in ten minutes, sir'));
assert.ok(!similar('Rain is coming', 'Your meeting is soon'));
assert.equal(moodWords({ energy: 0.2, curiosity: 0.8, warmth: 0.6, concern: 0.1 }), 'a little tired, curious');
console.log('screen extras OK');
