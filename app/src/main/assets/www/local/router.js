// router.js - sends the AI only the tools a request could need (instead of all ~110 every time), which makes every
// answer faster: a smaller request uploads quicker on mobile data and the model starts talking sooner.
// A small core is always included; groups are added by keywords in what you said, and stay for the next two turns so
// follow-ups ("yes, send it", "and the other one?") still work.

export const CORE = ['get_time', 'get_weather', 'search_web', 'wikipedia', 'calculate', 'remember', 'recall', 'take_note', 'set_reminder', 'set_timer',
  'list_reminders', 'open_app', 'open_website', 'system_info', 'morning_briefing', 'translate', 'flashlight', 'set_voice'];

export const GROUPS = {
  memory: [/\b(remember|forget|memor|prefer|preference|notes?|what do you know|about me|wipe|erase)/, ['list_memories', 'forget_memory', 'set_preference', 'list_preferences', 'forget_preference', 'forget_all', 'read_notes', 'show_what_you_know']],
  info: [/\b(news|headline|bitcoin|btc|ethereum|crypto|coin|price of|exchange rate|currency|convert|dollars?|naira|euros?|pounds?|yen|translat|how do you say|in (spanish|french|german|yoruba|igbo|hausa|chinese|arabic)|page|url|link|article|website says|countdown|until|days (until|to|left)|flip|dice|roll|password)/,
    ['news_headlines', 'crypto_price', 'currency_convert', 'translate', 'fetch_page', 'time_until', 'flip_coin', 'roll_dice', 'generate_password']],
  music: [/\b(music|song|songs|play|playing|pause|resume|skip|next (song|track)|previous|spotify|album|playlist|artist|podcast|youtube|video|listen)/,
    ['play_music', 'spotify_play', 'spotify_pause', 'spotify_next', 'spotify_previous', 'spotify_now_playing', 'play_youtube']],
  reminders: [/\b(remind|reminder|alarm|timer|wake me|cancel|snooze|countdown|o'?clock)/, ['cancel_reminder', 'set_alarm', 'show_alarms']],
  web: [/\b(website|web ?site|browser|google|search|look up|youtube|cam\b|webcam|live (view|cam|feed)|show me|open .*\.(com|org|net|ng|io))/, ['search_in_browser', 'play_youtube', 'show_public_cam', 'fetch_page']],
  eyes: [/\b(camera|photo|picture|pic|selfie|snap|look|see|seeing|this|read (this|that|it)|what'?s this|what is (this|that)|scan|qr|barcode|receipt|menu|sign|label|face|who am i|who is|recogni[sz]e|know me|screen)/,
    ['look_with_camera', 'take_photo', 'open_camera_app', 'remember_face', 'who_is_this', 'list_faces', 'forget_face', 'look_at_screen', 'translate_with_camera', 'scan_qr', 'scan_receipt']],
  control: [/\b(tap|press|click|type|scroll|swipe|screen|go back|go home|back button|home screen|lock|screenshot|recent apps|notification (shade|panel)|quick settings|whatsapp|instagram|facebook|telegram|tiktok|snapchat|twitter|gmail|chrome|settings|app\b|in the app|wi-?fi|bluetooth|hotspot|airplane|flight mode|mobile data|and (send|post|search|type|tap|reply|like|share))/,
    ['read_screen', 'tap_on_screen', 'type_on_screen', 'scroll_screen', 'press_button', 'look_at_screen']],
  device: [/\b(flash ?light|torch|volume|louder|quieter|softer|mute|unmute|silent|vibrat|ringer|ring|disturb|dnd|bright|dim|wi-?fi|bluetooth|hotspot|airplane|flight mode|settings|mobile data|data|location|gps|battery|nfc|display)/,
    ['flashlight', 'set_volume', 'ringer_mode', 'do_not_disturb', 'set_brightness', 'open_settings']],
  people: [/\b(call|ring|dial|phone|text|sms|message|messages|whatsapp|reply|respond|notification|notifications|inbox|tell (him|her|them|\w+) (that|i)|contact|announce|read (out|aloud))/,
    ['phone_call', 'send_text', 'whatsapp_message', 'read_notifications', 'reply_to_message', 'announce_messages']],
  calendar: [/\b(calendar|schedule|meeting|appointment|event|agenda|what'?s on|am i (busy|free)|plans|book|tomorrow|today|this week)/, ['get_calendar', 'add_calendar_event']],
  docs: [/\b(clipboard|copy|paste|copied|document|doc\b|pdf|word|docx|file|write (me )?(a|an|up)|letter|report|essay|resume|cv|share (it|that|the))/,
    ['get_clipboard', 'copy_to_clipboard', 'create_document', 'list_documents', 'open_document', 'delete_document']],
  delivery: [/\b(undo|not yet|doordash|door dash|dasher|uber|eats|grubhub|instacart|deliver\w*|order|orders|pick ?up|picked|drop ?off|dropped|stack|restaurant|customer|tip|payout|pay|offer|earn\w*|made|dash|route|next stop|stops|accepted|accept|decline)/,
    ['add_delivery_order', 'update_delivery_address', 'plan_deliveries', 'next_stop', 'complete_stop', 'list_delivery_orders', 'remove_delivery_order', 'clear_deliveries',
      'set_my_location', 'evaluate_delivery_offer', 'open_navigation', 'delivery_earnings', 'screen_offer', 'start_delivery_navigation', 'undo_stop', 'map_control', 'show_earnings', 'set_driving_mode']],
  nav: [/\b(navigat\w*|directions?|route|map|maps|take me|drive (me )?to|walk(ing)? to|get to|how far|eta|arriv|where am i|my location|location|gps|i'?m (in|at)|i am (in|at)|save (this|it|here|place)|home|work|zoom|traffic|toll|highway|reroute|stop navigation|guidance)/,
    ['navigate_to', 'start_delivery_navigation', 'stop_navigation', 'navigation_status', 'map_control', 'open_in_maps_app', 'save_place', 'where_am_i', 'set_my_location']],
  voice: [/\b(voice|accent|sound like|speak (like|as)|male|female|man|woman|face|avatar|look like|orb)/, ['list_voices', 'set_voice', 'choose_face']],
  interpreter: [/\b(interpret|interpreter|translat\w* (for|between|conversation)|conversation mode|speak to (him|her|them)|talk to (him|her|them)|in (spanish|french|german|portuguese|chinese|arabic|hindi|yoruba|igbo|hausa|swahili|japanese|korean|russian|italian))/,
    ['start_interpreter', 'stop_interpreter']],
  driving: [/\b(park|parked|parking|car|gas|fuel|petrol|station|shift|mileage|miles|mile log|tax|deduct|irs|break|drive|driving|driven|clock (in|out)|start (my )?(shift|dash|day)|end (my )?(shift|dash|day))/,
    ['remember_parking', 'find_my_car', 'find_gas', 'start_shift', 'end_shift', 'shift_status', 'mileage_log', 'set_driving_mode', 'show_earnings']],
  expenses: [/\b(receipt|expense|expenses|spent|spend|spending|bought|cost|costs|budget|write.?off)/, ['scan_receipt', 'add_expense', 'expense_summary']],
  safety: [/\b(emergency|sos|help me|danger|unsafe|scared|threat|attack|accident|crash|911|police|ambulance|i'?m safe|safe now|emergency contact|share (my )?location|where i am)/,
    ['emergency', 'im_safe', 'set_emergency_contact', 'share_location']],
  home: [/\b(lights?|lamp|bulb|switch|plug|thermostat|temperature|heat|cool|ac\b|air ?con|fan|tv|scene|smart home|home assistant|hue|lock the (door|house)|garage|blinds|curtains|bedroom|living room|kitchen|bathroom|porch)/,
    ['smart_home_devices', 'smart_home_control', 'smart_home_scene', 'connect_hue']],
  alerts: [/\b(alert|alerts|notify me|proactive|briefing (at|every)|every morning|weather warning|storm|birthday|birthdays|leave (now|by)|time to leave)/,
    ['set_proactive', 'proactive_status', 'birthdays']],
  offer: [/\b(that offer|the offer|worth it|take it|should i (take|accept))/, ['screen_offer', 'evaluate_delivery_offer']],
  handoff: [/\b(link|unlink|linked|my (pc|computer|laptop)|on (the|my) (pc|computer|laptop)|continue|carry on|pick up where|left off)/, ['link_pc', 'continue_from_pc', 'unlink_pc']],
};

/** Which groups a sentence touches. */
export function groupsFor(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ', out = [];
  for (const [g, [re]] of Object.entries(GROUPS)) if (re.test(t)) out.push(g);
  return out;
}

/** A follow-up to the last request rather than a new one: short, or leaning on what was just said. */
export function isFollowUp(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  if (t.trim().split(' ').length <= 4) return true;
  return /\b(it|that|them|again|also|too|instead|same|another|other one|the next|yes|yeah|yep|no|nope|do it|go ahead|send it|cancel that|undo)\b/.test(t) || /^ (and|but|also|then|now|ok|okay) /.test(t);
}

/** The router: remembers the last two turns' groups. `all` is reg.schemas. */
export function createRouter() {
  const recent = [];
  return {
    pick(all, text, extraGroups = []) {
      // the last two turns' tools carry over only for follow-ups ("turn it off", "yes send it", "and the other one?")
      const groups = new Set([...groupsFor(text), ...extraGroups, ...(isFollowUp(text) ? recent.flat() : [])]);
      recent.push([...groupsFor(text), ...extraGroups]); while (recent.length > 2) recent.shift();
      const want = new Set(CORE);
      for (const g of groups) for (const n of (GROUPS[g] ? GROUPS[g][1] : [])) want.add(n);
      const picked = all.filter(s => want.has(s.function.name));
      return { tools: picked, groups: [...groups] };
    },
    /** An instant command ran a tool without the AI: keep that tool's group for the follow-ups ("now turn it off"). */
    note(tool) { const g = Object.keys(GROUPS).filter(k => GROUPS[k][1].includes(tool)); if (g.length) { recent.push(g); while (recent.length > 2) recent.shift(); } },
    reset() { recent.length = 0; },
  };
}
