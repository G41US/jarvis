// Instant commands and the tool router: what should be answered on the phone, and which tools the AI is sent.
import { matchIntent, normalise } from '../app/src/main/assets/www/local/intents.js';
import { createRouter, groupsFor, CORE, GROUPS } from '../app/src/main/assets/www/local/router.js';
import { needsTool } from '../app/src/main/assets/www/local/brain.js';
let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + extra)); if (!ok) fails++; };
const I = (text, tool, args) => { const r = matchIntent(text); const ok = tool === null ? r === null : r && r.tool === tool && (!args || Object.entries(args).every(([k, v]) => JSON.stringify(r.args[k]) === JSON.stringify(v))); check(`instant: "${text}" -> ${tool}${args ? ' ' + JSON.stringify(args) : ''}`, ok, JSON.stringify(r)); };

check('normalise strips the wake word and politeness', normalise('Hey Jarvis, could you please turn on the flashlight?') === 'turn on the flashlight', normalise('Hey Jarvis, could you please turn on the flashlight?'));
I('What time is it?', 'get_time'); I("what's the date today", 'get_time');
I('Turn on the flashlight', 'flashlight', { state: 'on' }); I('flashlight off', 'flashlight', { state: 'off' }); I('turn the torch off', 'flashlight', { state: 'off' });
I('volume up', 'set_volume', { action: 'up' }); I('make it a bit quieter', 'set_volume', { action: 'down' }); I('set volume to 40 percent', 'set_volume', { action: 'set', level: 40 });
I('put my phone on vibrate', 'ringer_mode', { mode: 'vibrate' }); I('silent mode', 'ringer_mode', { mode: 'silent' }); I('turn on do not disturb', 'do_not_disturb', { on: true }); I('DND off', 'do_not_disturb', { on: false });
I('go back', 'press_button', { button: 'back' }); I('lock the phone', 'press_button', { button: 'lock' }); I('take a screenshot', 'press_button', { button: 'screenshot' });
I('set a timer for 5 minutes', 'set_timer', { seconds: 300 }); I('timer for ten seconds', 'set_timer', { seconds: 10 }); I('two hour timer', 'set_timer', { seconds: 7200 }); I('set a timer for half minute', 'set_timer', { seconds: 30 });
I('remind me in 20 minutes to check the oven', 'set_reminder', { text: 'check the oven', in_minutes: 20 });
I('cancel the timer', 'cancel_reminder', { which: 'timer' }); I('pause the music', 'spotify_pause'); I('next song', 'spotify_next');
I('open whatsapp', 'open_app', { name: 'whatsapp' }); I('launch the Uber Driver app', 'open_app', { name: 'uber driver' });
I("what's my battery", 'system_info'); I('I parked here', 'remember_parking'); I('where did I park', 'find_my_car'); I("I'm safe now", 'im_safe'); I('stop interpreting', 'stop_interpreter');
// these must go to the AI
I('open whatsapp and message John I am late', null); I('open settings', null); I('turn on the living room lights', null); I('what time does the game start tonight', null);
I('set a timer', null); I('remind me to call mom', null); I('what is this', null); I('volume', null);

// router
const all = [...new Set([...CORE, ...Object.values(GROUPS).flatMap(g => g[1])])].map(name => ({ type: 'function', function: { name } }));
const R = (text, must, mustNot = []) => { const r = createRouter().pick(all, text); const names = r.tools.map(t => t.function.name);
  const miss = must.filter(n => !names.includes(n)), extra = mustNot.filter(n => names.includes(n));
  check(`router: "${text}" sends ${must.join(', ')}${mustNot.length ? ' but not ' + mustNot.join(', ') : ''}`, !miss.length && !extra.length, `missing ${miss} / extra ${extra} / groups ${r.groups}`); return names.length; };
R('what is the weather like', ['get_weather'], ['tap_on_screen', 'add_delivery_order']);
R('send John a text saying I am running late', ['send_text', 'phone_call']);
R('open WhatsApp and message John on my way', ['open_app', 'read_screen', 'tap_on_screen', 'type_on_screen', 'whatsapp_message']);
R('I accepted a DoorDash order from Chipotle to 123 Oak Street', ['add_delivery_order']);
R("what's on my calendar tomorrow", ['get_calendar']);
R('take me to the airport', ['navigate_to']);
R('what is this', ['look_with_camera']); R('who am I', ['who_is_this']); R("what's on my screen", ['look_at_screen']);
R('turn off the bedroom lights', ['smart_home_control']); R('set the thermostat to 72', ['smart_home_control']);
R('I need help, this is an emergency', ['emergency']); R('where did I park my car', ['find_my_car']);
R('start my shift', ['start_shift']); R('how many miles did I drive this week', ['mileage_log']);
R('scan this receipt', ['scan_receipt']); R('translate this menu', ['translate_with_camera']); R('scan the QR code', ['scan_qr']);
R('be my interpreter, she speaks Spanish', ['start_interpreter']);
R('make me a PDF of my shift notes', ['create_document']);
R('flashlight on', ['flashlight']); R('turn on wifi', ['open_settings', 'tap_on_screen']);
const small = R('what is the capital of France', ['search_web', 'wikipedia']);
check(`a plain question sends only the core (${small} of ${all.length} tools)`, small === CORE.length, small);
// follow-ups keep the previous turn's tools
const router = createRouter(); router.pick(all, 'text John that I am late');
const follow = router.pick(all, 'yes send it').tools.map(t => t.function.name);
check('follow-up "yes send it" still has the messaging tools', follow.includes('send_text'), follow.join(','));
router.pick(all, 'thanks'); router.pick(all, 'what is two plus two');
check('...and they drop off two turns later', !router.pick(all, 'okay').tools.some(t => t.function.name === 'send_text'));
for (const t of ['Emergency!', 'SOS', 'help me', 'lights off', 'start my shift', 'scan this', 'I parked']) check(`"${t}" is sent with tools (so Jarvis can act on it)`, needsTool(t));
const rr = createRouter().pick(all, 'Emergency!').tools.map(t => t.function.name);
check('"Emergency!" reaches the SOS tool', rr.includes('emergency'), rr.join(','));
for (const t of ['What are you up to?', "what's up", 'How are you doing today?', 'Tell me a joke', 'who are you', 'I am bored']) check(`"${t}" is conversation: no tools sent`, !needsTool(t));
for (const t of ['Do you know where I parked?', 'What are you up to tomorrow on my calendar', 'navigate to the airport']) check(`"${t}" still gets tools`, needsTool(t));
{ const r = createRouter(); r.pick(all, 'navigate to the airport'); const n = r.pick(all, 'what do you think about football these days').tools.map(t => t.function.name);
  check('a new, unrelated question does not inherit the map tools from the last request', !n.includes('navigate_to'), n.join(',')); }
console.log('FAILURES:', fails); process.exit(fails ? 1 : 0);
