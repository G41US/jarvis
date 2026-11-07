#!/usr/bin/env python3
"""End-to-end test of the phone page: real patched index.html + real on-device JS, with a fake Android bridge, a stand-in for three.js,
and mocked Groq / map services. Run:  python3 tests/e2e/e2e.py   (needs playwright + chromium)"""
import json, os, re, sys, time
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WWW = os.path.join(ROOT, 'app/src/main/assets/www')
STUBS = os.path.join(ROOT, 'tests/e2e/stubs')
ORIGIN = 'https://appassets.androidplatform.net'
fails = 0
def check(name, cond, extra=''):
    global fails
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {extra}'))
    fails += (not cond)

def enc6(pts):
    out = []; pl = pb = 0
    for la, lo in pts:
        for v, prev in ((round(la * 1e6), pl), (round(lo * 1e6), pb)):
            d = v - prev; d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20: out.append(chr((0x20 | (d & 0x1f)) + 63)); d >>= 5
            out.append(chr(d + 63))
        pl, pb = round(la * 1e6), round(lo * 1e6)
    return ''.join(out)

A = (33.4484, -112.0740); M = (33.4520, -112.0600); B = (33.4600, -112.0400)
OSRM = {'code': 'Ok', 'routes': [{'distance': 4200, 'duration': 600, 'geometry': enc6([A, M, B]), 'legs': [{'distance': 4200, 'duration': 600, 'steps': [
    {'distance': 1800, 'duration': 240, 'name': 'Washington St', 'geometry': enc6([A, M]), 'maneuver': {'type': 'depart', 'modifier': 'east', 'location': [A[1], A[0]]}},
    {'distance': 2400, 'duration': 360, 'name': 'Main St', 'geometry': enc6([M, B]), 'maneuver': {'type': 'turn', 'modifier': 'left', 'location': [M[1], M[0]]}},
    {'distance': 0, 'duration': 0, 'name': 'Main St', 'geometry': enc6([B]), 'maneuver': {'type': 'arrive', 'modifier': 'right', 'location': [B[1], B[0]]}}]}]}]}

def nominatim(q):
    ql = q.lower()
    if 'main' in ql: return [{'lat': str(B[0]), 'lon': str(B[1]), 'display_name': '100 Main Street, Phoenix, Arizona, United States', 'name': '', 'address': {'house_number': '100', 'road': 'Main Street', 'city': 'Phoenix', 'state': 'Arizona', 'country_code': 'us'}}]
    if 'chipotle' in ql or 'elm' in ql: return [{'lat': '33.4550', 'lon': '-112.0650', 'display_name': 'Chipotle, 5 Elm Street, Phoenix, Arizona', 'name': 'Chipotle', 'address': {'house_number': '5', 'road': 'Elm Street', 'city': 'Phoenix', 'state': 'Arizona', 'country_code': 'us'}}]
    if 'oak' in ql: return [{'lat': '33.4700', 'lon': '-112.0300', 'display_name': '123 Oak Street, Phoenix, Arizona', 'name': '', 'address': {'house_number': '123', 'road': 'Oak Street', 'city': 'Phoenix', 'state': 'Arizona', 'country_code': 'us'}}]
    return []

state = {'groq_calls': [], 'stt_calls': 0, 'http': []}

def sse(chunks):
    return ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
def delta(**k): return {'choices': [{'delta': k, 'finish_reason': None}]}

def check_multipart(ctype, body):
    """Validate a Whisper upload the way Groq does (the mock used to accept anything)."""
    m = re.search(r'boundary=([^;]+)', ctype)
    if not ctype.startswith('multipart/form-data') or not m: return 'request must be multipart/form-data'
    bd = ('--' + m.group(1)).encode(); parts = {}
    if not body.rstrip().endswith(bd + b'--'): return 'malformed multipart body'
    for chunk in body.split(bd)[1:-1]:
        head, _, data = chunk.lstrip(b'\r\n').partition(b'\r\n\r\n')
        name = re.search(rb'name="([^"]+)"', head)
        if not name: return 'part without a name'
        parts[name.group(1).decode()] = (head, data[:-2] if data.endswith(b'\r\n') else data)
    if 'file' not in parts or not parts['file'][1].startswith(b'RIFF') or b'filename=' not in parts['file'][0]: return 'file is missing or not audio'
    model = parts.get('model', (b'', b''))[1].decode()
    if model not in ('whisper-large-v3-turbo', 'whisper-large-v3'): return f'model {model!r} not found'
    if 'language' in parts:
        lang = parts['language'][1].decode()
        if not re.fullmatch(r'[a-z]{2,3}', lang): return f"invalid language '{lang}'"
    if 'temperature' in parts and not re.fullmatch(r'[0-9.]+', parts['temperature'][1].decode()): return 'invalid temperature'
    return ''

def groq_handler(route):
    req = route.request; url = req.url
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'}
    if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
    if url.endswith('/models'):
        ok = 'Bearer gsk_good' in (req.headers.get('authorization') or '')
        return route.fulfill(status=200 if ok else 401, headers=cors, body='{"data":[]}')
    if 'audio/transcriptions' in url:
        if 'Bearer gsk_good' not in (req.headers.get('authorization') or ''): return route.fulfill(status=401, headers=cors, content_type='application/json', body='{"error":{"message":"Invalid API Key"}}')
        err = check_multipart(req.headers.get('content-type') or '', req.post_data_buffer or b'')
        state['stt_calls'] += 1
        if err:
            state.setdefault('stt_errors', []).append(err)
            return route.fulfill(status=400, headers=cors, content_type='application/json', body=json.dumps({'error': {'message': err, 'type': 'invalid_request_error'}}))
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'text': state.get('stt_text', 'Hey Jarvis')}))
    if 'Bearer gsk_good' not in (req.headers.get('authorization') or ''):
        return route.fulfill(status=401, headers=cors, content_type='application/json', body='{"error":{"message":"Invalid API Key"}}')
    body = json.loads(req.post_data or '{}'); state['groq_calls'].append(body)
    msgs = body.get('messages', [])
    if not body.get('stream'):
        sysm = (msgs[0].get('content') or '') if msgs else ''
        if 'live interpreter' in sysm or sysm.startswith('Translate into'):   # the interpreter (gpt-oss-20b, JSON)
            state.setdefault('interp', []).append(body)
            u = msgs[-1]['content'].lower()
            if sysm.startswith('Translate into'): out = {'translation': 'Hola. Soy Jarvis, un intérprete.'}
            elif 'hola' in u or 'necesito' in u: out = {'from': 'es', 'translation': 'Hello, I need help with my order.'}
            else: out = {'from': 'en', 'translation': '¿Cómo estás? Llego en cinco minutos.'}
            return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'choices': [{'message': {'role': 'assistant', 'content': json.dumps(out, ensure_ascii=False)}}]}))
        if sysm.startswith('You pick out lasting facts'):                # learning about the user (gpt-oss-20b, JSON)
            state.setdefault('learn', []).append(body)
            out = {'facts': ["The user's sister Ada lives in Abuja."], 'preferences': []} if 'sister' in msgs[-1]['content'] else {'facts': [], 'preferences': []}
            return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'choices': [{'message': {'role': 'assistant', 'content': json.dumps(out)}}]}))
        if body.get('model') == 'qwen/qwen3.8-27b':                   # Jarvis's eyes
            state.setdefault('vision', []).append(body)
            q = json.dumps(body['messages'][-1]['content'])
            said = '{"merchant":"Shell","date":"","total":42.10,"currency":"$","category":"fuel","items":"Unleaded 12.1 gal"}' if 'This is a receipt' in q else \
                   'A menu. Tacos al pastor, twelve dollars.' if 'translate it into' in q else 'A red coffee mug on a wooden desk.'
            return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'choices': [{'message': {'role': 'assistant', 'content': said}}]}))
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'choices': [{'message': {'role': 'assistant', 'content': 'summary'}}]}))
    last = msgs[-1]
    # "!script [[tool, args], ...]" as the user's words: the fake model calls those tools one round at a time, like the real one does
    ui = max(i for i, m in enumerate(msgs) if m['role'] == 'user'); uc = msgs[ui].get('content') or ''
    if isinstance(uc, str) and uc.lstrip('!').startswith('script ['):          # (the page drops the "!")
        steps = json.JSONDecoder().raw_decode(uc.lstrip('!')[7:])[0]; done = sum(1 for m in msgs[ui + 1:] if m['role'] == 'tool')
        state.setdefault('script_rounds', []).append(done)
        if done < len(steps) and body.get('tool_choice') != 'none':
            name, args = steps[done]
            chunks = [delta(tool_calls=[{'index': 0, 'id': f's{done}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}])]
        else:
            chunks = [delta(content='Done. ' + (last.get('content') or '')[:300].replace('\n', ' '))]
        return route.fulfill(status=200, headers={**cors, 'Content-Type': 'text/event-stream'}, body=sse(chunks))
    if last['role'] == 'tool':
        txt = "That's " + re.sub(r'[^0-9.]', '', last['content']) + '.' if last['name'] == 'calculate' else 'Done. ' + last['content'][:200]
        chunks = [delta(content=txt[:8]), delta(content=txt[8:])]
    else:
        u = (last.get('content') or '').lower()
        if 'times' in u:
            chunks = [delta(tool_calls=[{'index': 0, 'id': 'c1', 'type': 'function', 'function': {'name': 'calculate', 'arguments': '{"expression":'}}]),
                      delta(tool_calls=[{'index': 0, 'function': {'arguments': '"12*12"}'}}])]
        elif 'weather in markdown' in u:                              # the model sometimes writes markdown; Jarvis must not say "asterisk"
            chunks = [delta(content='**Lagos**: partly cloudy, **31 °C**.\n'), delta(content='- Rain: *40%* chance 🌧️\n- Wind: 12 km/h')]
        elif 'doordash' in u:
            chunks = [delta(tool_calls=[{'index': 0, 'id': 'c2', 'type': 'function', 'function': {'name': 'add_delivery_order', 'arguments': json.dumps({'restaurant': 'Chipotle', 'dropoff_address': '123 Oak Street Phoenix', 'pickup_address': '5 Elm Street Phoenix', 'payout': 8.5, 'platform': 'doordash'})}}])]
        else:
            chunks = [delta(content='Hello. All systems are online. '), delta(content='How can I help?')]
    route.fulfill(status=200, headers={**cors, 'Content-Type': 'text/event-stream'}, body=sse(chunks))

def other_handler(route):
    url = route.request.url; cors = {'Access-Control-Allow-Origin': '*'}
    state['http'].append(url.split('?')[0])
    if 'nominatim' in url and '/search' in url:
        q = re.search(r'[?&]q=([^&]*)', url); from urllib.parse import unquote_plus
        state.setdefault('geo', []).append(unquote_plus(q.group(1)) if q else '')
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(nominatim(unquote_plus(q.group(1)) if q else '')))
    if 'nominatim' in url and '/reverse' in url:
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'lat': str(A[0]), 'lon': str(A[1]), 'display_name': '1 Washington St, Phoenix, Arizona', 'address': {'house_number': '1', 'road': 'Washington St', 'city': 'Phoenix', 'state': 'Arizona', 'country_code': 'us'}}))
    if 'valhalla' in url: return route.fulfill(status=200, headers=cors, content_type='application/json', body='{"error":"x"}')
    if 'routing.openstreetmap.de' in url or 'router.project-osrm.org' in url:
        if '/table/' in url: return route.fulfill(status=400, headers=cors, body='{}')
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(OSRM))
    if 'photon' in url: return route.fulfill(status=200, headers=cors, content_type='application/json', body='{"features":[]}')
    if 'overpass-api.de' in url:
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'elements': [
            {'type': 'node', 'lat': A[0] + 0.004, 'lon': A[1], 'tags': {'amenity': 'fuel', 'brand': 'Circle K'}},
            {'type': 'way', 'center': {'lat': A[0], 'lon': A[1] + 0.002}, 'tags': {'amenity': 'fuel', 'brand': 'Shell', 'addr:housenumber': '300', 'addr:street': 'Main Street'}}]}))
    if 'api.weather.gov/alerts' in url:
        state['nws'] = state.get('nws', 0) + 1
        return route.fulfill(status=200, headers=cors, content_type='application/geo+json', body=json.dumps({'features': [{'id': 'x1', 'properties': {'id': 'urn:alert:1', 'event': 'Tornado Warning', 'severity': 'Extreme',
            'ends': '2030-10-13T18:45:00-07:00', 'instruction': 'TAKE COVER NOW! Move to a basement or an interior room.'}}]}))
    if 'open-meteo' in url and 'geocoding' in url: return route.fulfill(status=200, headers=cors, content_type='application/json', body='{"results":[]}')
    return route.fulfill(status=404, headers=cors, body='')

def asset_handler(route):
    path = re.sub(r'^https://appassets\.androidplatform\.net', '', route.request.url).split('?')[0].split('#')[0]
    if path in ('', '/'): path = '/index.html'
    if path.endswith('/deep.js'): f = os.path.join(STUBS, 'deep.js')
    elif path == '/vendor/three/build/three.module.js': f = os.path.join(STUBS, 'three.module.js')
    elif path.startswith('/vendor/three/examples/jsm/'): f = os.path.join(STUBS, 'addon.js')
    else: f = os.path.join(WWW, path.lstrip('/'))
    if not os.path.isfile(f): return route.fulfill(status=404, body='nf')
    if route.request.method == 'HEAD': return route.fulfill(status=200, body=b'')
    if f.endswith('.glb'): return route.fulfill(status=200, body=b'glTF', content_type='model/gltf-binary')   # the stand-in face loader never reads it
    ct = {'.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json'}.get(os.path.splitext(f)[1], 'application/octet-stream')
    route.fulfill(status=200, body=open(f, 'rb').read(), content_type=ct)

BRIDGE = r"""
(() => {
  const of = window.fetch.bind(window);
  const b64 = u8 => { let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
  window.__pc = { alan: 'missing', amy: 'missing', active: '' }; window.__wifi = true;
  window.__native = { prefetch: [], pcDownloads: [], pcUse: [], listen: [], tts: [], ttsPitch: [], opened: [], stopped: 0, http: [], streams: [], media: [], voice: null, listening: [], speaking: [], tones: 0, mic: 0 };
  window.__fakeVoices = [{ id: 'en-us-x-iom-local', label: 'English US', lang: 'en-US' }, { id: 'en-us-x-tpf-local', label: 'English US', lang: 'en-US' },
                         { id: 'en-gb-x-gbb-local', label: 'English UK', lang: 'en-GB' }, { id: 'en-us-x-sfg-network', label: 'English US', lang: 'en-US' }];
  window.AndroidBridge = {
    httpRequest(id, method, url, headersJson, body, timeoutMs) {
      window.__native.http.push({ method, url, ua: (JSON.parse(headersJson || '{}')['User-Agent'] || '') });
      const hh = JSON.parse(headersJson || '{}'); delete hh['User-Agent'];
      of(url, { method, body: body || undefined, headers: url.includes('192.168.') ? hh : undefined }).then(async r => window.__httpResult(id, r.status, await r.text())).catch(() => window.__httpResult(id, 0, ''));
    },
    httpStream(id, method, url, headersJson, bodyB64, timeoutMs) {
      const h = JSON.parse(headersJson || '{}'); window.__native.streams.push(url);
      const body = bodyB64 ? Uint8Array.from(atob(bodyB64), c => c.charCodeAt(0)) : undefined;
      of(url, { method, headers: h, body }).then(async r => {
        window.__httpHead(id, r.status); const rd = r.body.getReader();
        for (;;) { const { value, done } = await rd.read(); if (done) break; window.__httpChunk(id, b64(value)); }
        window.__httpEnd(id, '');
      }).catch(e => window.__httpEnd(id, String(e)));
    },
    httpAbort(id) {},
    ttsSpeak(id, text, rate, pitch) { window.__native.tts.push(text); window.__native.ttsPitch.push(pitch); setTimeout(() => window.__ttsEvent(id, 'done'), 15); },
    ttsStop() { window.__native.stopped++; },
    ttsPrefetch(t) { window.__native.prefetch.push([t, window.__native.tts.length]); },
    ttsSpeakLang(id, text, rate, pitch, lang) { (window.__native.ttsLang = window.__native.ttsLang || []).push([lang, text]); window.__native.tts.push(text); setTimeout(() => window.__ttsEvent(id, 'done'), 15); },
    ttsLangAvailable(l) { return 1; },
    ttsVoices() { return JSON.stringify(window.__fakeVoices); },
    ttsSetVoice(v) { window.__native.voice = v; },
    openUrl(u) { window.__native.opened.push(u); return 'ok'; },
    setAnnounceMessages(on) { window.__native.announce = on; },
    openApp(n) { window.__native.opened.push('app:' + n); return 'ok'; },
    media(a, q, p) { window.__native.media.push([a, q, p]); return 'ok'; },
    battery() { return JSON.stringify({ level: 77, charging: false, network: 'wifi' }); },
    micStart() { window.__native.mic++; setTimeout(() => window.__jvMic && window.__jvMic('listening'), 10); return 'ok'; },
    micStatus() { return JSON.stringify({ running: true, wake: true, wakeError: '', permission: true }); },
    setListening(on) { window.__native.listening.push(on); }, setSpeaking(on) { window.__native.speaking.push(on); },
    listen(on, pre) { window.__native.listening.push(on); window.__native.listen.push({ on, pre, t: performance.now() }); },
    setMuted(on) {}, setWakeThreshold(t) { window.__native.threshold = t; },
    tone(f, ms, v) { window.__native.tones++; },
    vibrate(k) { (window.__native.vib = window.__native.vib || []).push(k); },
    widget(j) { (window.__native.widget = window.__native.widget || []).push(JSON.parse(j)); }, pinWidget() { window.__native.pinned = 1; return 'asked'; }, widgetCount() { return 0; },
    appBuild() { return 50; }, mouthLevel() { return window.__mouth == null ? 0 : window.__mouth; }, setSpeechSpeed(x) { window.__native.speed = x; }, setCloudVoice(u, h, v) { window.__native.cloud = [u, JSON.parse(h), v]; }, installUpdate(url, token, size, parts) { window.__native.update = [url, token, size, parts]; return 'started'; },
    pcVoices() { return JSON.stringify(window.__pc); },
    pcVoiceDownload(n) { window.__native.pcDownloads.push(n); window.__pc[n] = 'downloading:40'; window.__jvVoices(JSON.stringify(window.__pc));
      setTimeout(() => { window.__pc[n] = 'ready'; window.__jvVoices(JSON.stringify(window.__pc)); }, 300); },
    pcVoiceUse(n) { window.__native.pcUse.push(n); window.__pc.active = n; },
    unmetered() { return !!window.__wifi; },
    setOfferPrefs(h, m, c, on) { window.__native.offerPrefs = [h, m, c, on]; },
    offerReaderStatus() { return JSON.stringify({ enabled: !!window.__offerOn, running: !!window.__offerOn, lastScreen: '', lastScreenAt: 0 }); },
    openOfferReaderSettings() { window.__native.opened.push('accessibility-settings'); },
  };
  // ---- PhoneActions.java stand-in: records every call
  window.__phone = { calls: [], reminders: [], docs: [], events: [], clip: 'copied text', visible: true,
    status: { notifications: true, exactAlarms: false, overlay: false, control: false, controlRunning: false, notifAccess: false, camera: true, contacts: true, calls: false, calendar: true, dnd: false, brightness: false, screenshots: true } };
  const rec = (m, ...a) => window.__phone.calls.push([m, ...a]);
  const P = window.__phone;
  window.AndroidPhone = {
    status() { return JSON.stringify(P.status); },
    request(n) { rec('request', n); return 'opened'; },
    reminderAdd(j) { rec('reminderAdd', j); const o = JSON.parse(j); P.reminders = P.reminders.filter(r => r.id !== o.id).concat([o]); return 'inexact'; },
    reminderList() { return JSON.stringify(P.reminders); },
    reminderCancel(id) { rec('reminderCancel', id); const n = P.reminders.length; P.reminders = P.reminders.filter(r => r.id !== id); return n !== P.reminders.length; },
    clockAlarm(h, m, l, d) { rec('clockAlarm', h, m, l, d); return 'ok'; },
    showClockAlarms() { rec('showClockAlarms'); return 'ok'; },
    flashlight(s) { rec('flashlight', s); return s === 'off' ? 'Flashlight off.' : 'Flashlight on.'; },
    volume(a, l, s) { rec('volume', a, l, s); return 'Volume 60 percent.'; },
    ringer(m) { rec('ringer', m); return 'need-dnd'; },
    dnd(on) { rec('dnd', on); return P.status.dnd ? 'Do Not Disturb on.' : 'need-dnd'; },
    brightness(l) { rec('brightness', l); return 'need-brightness'; },
    openSettings(p) { rec('openSettings', p); return P.visible ? 'ok' : 'notified'; },
    openCamera(m) { rec('openCamera', m); return 'ok'; },
    bringToFront() { rec('bringToFront'); P.visible = true; return 'ok'; },
    isVisible() { return !!P.visible; },
    findContact(n) { rec('findContact', n); return /john/i.test(n) ? JSON.stringify([{ name: 'John Smith', number: '+15551234567', type: 'mobile' }]) : '[]'; },
    call(n) { rec('call', n); return P.status.calls ? 'calling' : 'dialer'; },
    sms(n, t) { rec('sms', n, t); return 'ok'; },
    whatsapp(n, t) { rec('whatsapp', n, t); return 'ok'; },
    notifications(m, app, max) { rec('notifications', m, app, max); if (!P.status.notifAccess) return 'need-notifAccess'; return JSON.stringify([{ n: 1, app: 'WhatsApp', title: 'John Smith', text: 'Where are you?', message: true, canReply: true, ago: 2 }]); },
    replyTo(w, t) { rec('replyTo', w, t); return 'Sent to John Smith on WhatsApp.'; },
    calendarEvents(f, t) { rec('calendarEvents', f, t); return JSON.stringify(P.events); },
    calendarAdd(title, s, e, loc, all) { rec('calendarAdd', title, s, e, loc, all); P.events.push({ title, begin: s, end: e, allDay: all, location: loc }); return 'ok:Personal'; },
    clipboardGet() { return P.clip; }, clipboardSet(t) { P.clip = t; return 'ok'; },
    docSave(k, t, c) { rec('docSave', k, t, c); const o = { name: t + ' 2026-10-12 2200.' + k, uri: 'content://media/external/file/' + (P.docs.length + 1), mime: 'application/pdf' }; P.docs.unshift(o); return JSON.stringify(o); },
    docList() { return JSON.stringify(P.docs); },
    docOpen(u, m, sh) { rec('docOpen', u, m, sh); return 'ok'; },
    docDelete(u) { rec('docDelete', u); P.docs = P.docs.filter(d => d.uri !== u); return true; },
    photoSave(b) { rec('photoSave', b.slice(0, 23)); return 'Jarvis 1.jpg'; },
    screenRead() { rec('screenRead'); if (!P.status.control) return 'need-control'; return 'App on screen: WhatsApp\n[1] tap: Chats\n[2] tap: John Smith\n[3] field: Message'; },
    screenTap(t, l) { rec('screenTap', t, l); return P.status.control ? 'Tapped John Smith.' : 'need-control'; },
    screenType(t, f, sub) { rec('screenType', t, f, sub); return 'Typed it.'; },
    screenScroll(d) { rec('screenScroll', d); return 'Scrolled ' + d + '.'; },
    press(w) { rec('press', w); return 'Done.'; },
    screenshot() { rec('screenshot'); return P.status.control ? '/9j/4AAQSkZJRgABAQ' : 'need-control'; },
    currentApp() { return 'com.whatsapp'; },
    lastLocation() { return JSON.stringify(P.loc || {}); }, locationReport() { return JSON.stringify({ precise: false, approximate: true, on: true, providers: 'passive,network,fused', last: P.loc || {} }); }, freshLocation(t) { rec('freshLocation', t); return JSON.stringify(P.loc || {}); },
    shiftStart() { rec('shiftStart'); P.shift = P.shift || { active: true, start: Date.now(), meters: 0 }; return JSON.stringify(P.shift); },
    shiftStatus() { return JSON.stringify(P.shift || { active: false }); },
    shiftEnd() { rec('shiftEnd'); if (!P.shift) return '{"error":"none"}'; const t = { start: Date.now() - 4 * 3600000, end: Date.now(), meters: 80 * 1609.344 }; P.trips = (P.trips || []).concat([t]); P.shift = null; return JSON.stringify(t); },
    trips() { return JSON.stringify(P.trips || []); },
    sosStart(c, n, m) { rec('sosStart', JSON.parse(c), n, m); P.sos = true; return P.status.sms ? JSON.stringify({ sent: JSON.parse(c).length, contacts: JSON.parse(c).length }) : '{"error":"sms"}'; },
    sosStop(m) { rec('sosStop'); const w = !!P.sos; P.sos = false; return JSON.stringify({ sent: w ? 1 : 0, was_active: w }); },
    sosActive() { return !!P.sos; }, placeText() { return 'https://maps.google.com/?q=33.448400,-112.074000 (within 5 m)'; },
    shareLocation(n, t) { rec('shareLocation', JSON.parse(n), t); return P.status.sms ? 1 : -1; },
    dialEmergency(n) { rec('dialEmergency', n); return 'ok'; },
    birthdays() { const d = new Date(); return JSON.stringify([{ name: 'Ada Lovelace', md: String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), year: 1990 }, { name: 'Tunde', md: '02-29', year: 0 }]); },
    faceRemember(b, name, title) { rec('faceRemember', b.slice(0, 23), name, title); P.faces = (P.faces || []).concat([{ name, title }]); return JSON.stringify({ ok: true, samples: P.faces.filter(f => f.name === name).length }); },
    faceIdentify(b) { rec('faceIdentify', b.slice(0, 23)); const f = (P.faces || [])[0]; return JSON.stringify({ ok: true, face: true, match: f ? { name: f.name, title: f.title, similarity: 0.71 } : null }); },
    faceList() { return JSON.stringify((P.faces || []).map(f => ({ name: f.name, title: f.title, samples: 1 }))); },
    faceForget(n) { const k = (P.faces || []).length; P.faces = (P.faces || []).filter(f => f.name.toLowerCase() !== n.toLowerCase()); return k !== P.faces.length; },
  };
})();
"""

def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 412, 'height': 860}, permissions=['microphone', 'camera', 'geolocation'], geolocation={'latitude': A[0], 'longitude': A[1]}, is_mobile=True, has_touch=True)
        ctx.add_init_script(BRIDGE)
        ctx.route(ORIGIN + '/**', asset_handler)
        ctx.route('https://api.groq.com/**', groq_handler)
        ctx.route(re.compile(r'https://(?!appassets|api\.groq).*'), other_handler)
        pg = ctx.new_page(); errs = []; logs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') else None)
        pg.goto(ORIGIN + '/index.html')
        pg.wait_for_function('window.JARVIS && window.JARVIS.config', timeout=15000)
        ev = pg.evaluate
        ev('JARVIS.proactive.stop()')     # no surprise alerts mid-test; the proactive tests run its checks by hand

        # ---- first run: settings opens by itself, key test works
        pg.wait_for_selector('#jv-ov.on', timeout=5000)
        check('key build: settings explains why a key is needed', "isn't linked to the Jarvis service" in ev("document.getElementById('jv-brain').textContent"))
        check('settings opens on first run', True)
        pg.fill('#jv-ov input[type=password] >> nth=0', 'gsk_bad'); pg.click('#jv-test'); pg.wait_for_function("document.querySelector('#jv-ov .msg').textContent.includes('rejected')", timeout=5000)
        check('bad key is reported', True)
        pg.fill('#jv-ov input[type=password] >> nth=0', 'gsk_good'); pg.click('#jv-test'); pg.wait_for_function("document.querySelector('#jv-ov .msg').textContent.includes('Key works')", timeout=5000)
        check('good key verified', True)
        pg.fill('#jv-ov input[type=text] >> nth=0', 'Marcus')
        pg.click('#jv-ov .pri'); pg.wait_for_function("!document.querySelector('#jv-ov').classList.contains('on')", timeout=3000)
        check('settings saved + closed', ev("JARVIS.config.get('groq_key')") == 'gsk_good' and ev("JARVIS.config.get('user_name')") == 'Marcus')
        ev("JARVIS.config.set('learn', false)")      # learning is tested on its own below (it adds background AI calls)

        # ---- page booted with the fake mic, audio socket is ours
        pg.wait_for_function("document.getElementById('log').textContent.includes('Jarvis online')", timeout=8000)
        check('page initialised (mic + audio socket)', True)
        check('greeting endpoint', ev("fetch('/greeting').then(r=>r.json()).then(j=>j.name)") == 'Marcus')
        # ---- the PC voices (Alan / Amy)
        pg.wait_for_timeout(2200)
        check('on Wi-Fi, the PC voice for the face downloads by itself (Alan for male)', ev('window.__native.pcDownloads') == ['alan'], ev('window.__native.pcDownloads'))
        pg.wait_for_function("window.__pc.alan === 'ready'", timeout=3000); pg.wait_for_timeout(200)
        check('once downloaded, Jarvis switches to Alan', ev('window.__native.pcUse')[-1:] == ['alan'] and ev("JARVIS.chosenVoice().raw") == 'pc:alan', (ev('window.__native.pcUse'), ev("JARVIS.chosenVoice()")))
        check('...and the face stays male', ev("fetch('/get_voice').then(r=>r.json()).then(j=>j.voice)").startswith('adam~'))
        ev("window.__wifi = false")
        r = ev("fetch('/set_voice',{method:'POST',body:JSON.stringify({voice:'female'})}).then(r=>r.json())")
        check('female on mobile data: no surprise download, phone female voice meanwhile', ev('window.__native.pcDownloads') == ['alan'] and ev('window.__native.pcUse')[-1] == '' and ev('window.__native.voice') == 'en-us-x-tpf-local', (ev('window.__native.pcDownloads'), ev('window.__native.pcUse')[-3:], ev('window.__native.voice')))
        ev("JARVIS.ensurePcVoice(true)"); pg.wait_for_function("window.__pc.amy === 'ready'", timeout=3000); pg.wait_for_timeout(200)
        check('download on request, then Amy speaks', ev('window.__native.pcUse')[-1] == 'amy' and ev("JARVIS.chosenVoice().raw") == 'pc:amy')
        ev("fetch('/set_voice',{method:'POST',body:JSON.stringify({voice:'male'})})"); pg.wait_for_timeout(100)
        check('back to male -> Alan (already downloaded)', ev('window.__native.pcUse')[-1] == 'alan')
        ev("JARVIS.config.merge({voice:'adam~en-gb-x-gbb-local'}); JARVIS.announceVoice()")
        check('picking a phone voice by hand turns the PC voice off', ev('window.__native.pcUse')[-1] == '' and ev('window.__native.voice') == 'en-gb-x-gbb-local')
        # ---- the natural voice on the phone (Kokoro): free, no daily limit; Groq's voice first while its allowance lasts
        ev("window.__pc.kokoro = 'missing'; window.__native.pcDownloads.length = 0; window.__wifi = true; JARVIS.ensurePcVoice()")
        pg.wait_for_function("window.__pc.kokoro === 'ready'", timeout=3000); pg.wait_for_timeout(200)
        check('natural voice on: on Wi-Fi the phone\'s natural voice downloads instead of the PC voice', ev('window.__native.pcDownloads') == ['kokoro'], ev('window.__native.pcDownloads'))
        check('...then it is the voice under Groq\'s (Michael for the male face)', ev('window.__native.pcUse')[-1] == 'kokoro:6' and ev('window.__native.cloud')[0].endswith('/audio/speech'), (ev('window.__native.pcUse')[-3:], ev('window.__native.cloud')))
        ev("JARVIS.config.set('natural_voice', 'phone'); JARVIS.announceVoice()")
        check('"always the phone\'s natural voice": Groq\'s voice off', ev('window.__native.cloud')[0] == '' and ev('window.__native.pcUse')[-1] == 'kokoro:6', ev('window.__native.cloud'))
        ev("JARVIS.config.merge({ natural_voice: 'phone', avatar_gender: 'female' }); JARVIS.announceVoice()")
        check('female face -> Bella', ev('window.__native.pcUse')[-1] == 'kokoro:1')
        ev("JARVIS.config.merge({ natural_voice: 'false', avatar_gender: 'male', voice: '' }); JARVIS.announceVoice()")
        check('natural voice off -> the PC voice again', ev('window.__native.pcUse')[-1] == 'alan' and ev('window.__native.cloud')[0] == '', ev('window.__native.pcUse')[-3:])
        ev("JARVIS.config.set('natural_voice', 'true')")
        ev("window.__pc = { alan: 'missing', amy: 'missing', active: '' }; JARVIS.config.merge({voice:''}); JARVIS.announceVoice(); window.__wifi = true")

        vl = ev("fetch('/voices').then(r=>r.json())")
        check('voices listed with genders', len(vl) == 6 and any('Male' in v['name'] for v in vl) and any('Female' in v['name'] for v in vl), vl)
        check('default male face -> British male voice', ev('window.__native.voice') == 'en-gb-x-gbb-local', ev('window.__native.voice'))
        r = ev("fetch('/set_voice',{method:'POST',body:JSON.stringify({voice:'female'})}).then(r=>r.json())")
        check('"female voice" switches to a real female voice', r.get('ok') and ev('window.__native.voice') == 'en-us-x-tpf-local' and r['voice'].startswith('amy~'), (r, ev('window.__native.voice')))
        r = ev("fetch('/set_voice',{method:'POST',body:JSON.stringify({voice:'male'})}).then(r=>r.json())")
        check('"male voice" switches back', r.get('ok') and ev('window.__native.voice') == 'en-gb-x-gbb-local' and r['voice'].startswith('adam~'))
        ev("window.__fakeVoices = window.__fakeVoices.filter(v => !/tpf|sfg/.test(v.id)); JARVIS.refreshVoices()")
        pitch = ev("(()=>{ JARVIS.config.merge({avatar_gender:'female', voice:''}); const c = JARVIS.chosenVoice(); JARVIS.config.merge({avatar_gender:'male'}); return c.pitch; })()")
        check('no female voice on phone -> higher pitch fallback', pitch > 1.1, pitch)
        ev("window.__fakeVoices.push({ id: 'en-us-x-tpf-local', label: 'English US', lang: 'en-US' }); JARVIS.refreshVoices(); JARVIS.config.merge({avatar_gender:'male', voice:''}); JARVIS.announceVoice()")

        # ---- chat with a tool call, spoken through Android TTS
        ev("window.__native.tts.length=0")
        ev("JARVIS.wake()"); pg.wait_for_timeout(300)
        ev("JARVIS.say('what is 12 times 12')")
        pg.wait_for_function("window.__native.tts.join(' ').includes('144')", timeout=8000)
        check('tool call (calculate) -> spoken "144"', True)
        check('log shows exchange', 'times 12' in ev("document.getElementById('log').textContent"))
        sent = [c for c in state['groq_calls'] if c.get('stream')]
        check('chat went through the app (no browser CORS)', any('chat/completions' in u for u in ev('window.__native.streams')))
        names = [t['function']['name'] for t in sent[0].get('tools', [])]
        check('Groq request had the system prompt and only the tools this question needs (router)', sent[0]['messages'][0]['role'] == 'system' and 'calculate' in names and len(names) < 30 and 'tap_on_screen' not in names, (len(names), names[:20]))
        print(f"   request size: {len(names)} tools, {len(json.dumps(sent[0]['tools']))} chars of tools, {len(sent[0]['messages'][0]['content'])} chars of instructions")

        # ---- plain chat
        ev("window.__native.tts.length=0"); pg.wait_for_timeout(1500)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('how are you doing today')")
        pg.wait_for_function("window.__native.tts.join(' ').includes('All systems')", timeout=8000)
        check('plain streamed reply spoken in sentences', True)
        pg.wait_for_timeout(600); spoken, pre = ev("window.__native.tts"), ev("window.__native.prefetch")
        check('every sentence goes to the voice as soon as it is written, before its turn (no gaps)', len(spoken) >= 2 and all(any(p[0] == t for p in pre) for t in spoken) and pre[-1][1] < len(spoken), (spoken, pre))

        # ---- echo: Jarvis must never hear his own reply as a question
        ev("window.__native.listen.length=0; window.__native.tts.length=0; window.__ttsDoneAt=0"); pg.wait_for_timeout(1200)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('give me a status report please')")
        try: pg.wait_for_function("window.__native.tts.join(' ').includes('All systems')", timeout=8000)
        except Exception: print('DBG', ev("document.getElementById('log').textContent.slice(-300)"), ev('JARVIS.stats.dropped'), ev('window.__jv.state()'), ev('window.__native.tts')); raise
        pg.wait_for_function("!window.__jv.state().speaking", timeout=8000); t_quiet = ev("performance.now()")
        pg.wait_for_timeout(1300)
        L = ev("window.__native.listen")
        after = [x for x in L if x['on'] and x['t'] >= t_quiet - 50]
        check('after Jarvis speaks, the mic reopens WITHOUT the buffered audio (his own voice)', after and all(not x['pre'] for x in after), L)
        check('...and only after the echo tail (0.9 s), not straight away', after and after[0]['t'] - t_quiet >= 750, [round(x['t'] - t_quiet) for x in after])
        before = ev("JARVIS.stats.heard.length")
        ev("JARVIS.say('Hello. All systems are online. How can I help?')"); pg.wait_for_timeout(1200)
        check('a transcript of his own reply is dropped as echo', ev("JARVIS.stats.dropped && JARVIS.stats.dropped.kind") == 'echo' and 'All systems' not in ''.join(m for m in ev("[...document.querySelectorAll('#log .msg.user .body')].map(e=>e.textContent)")), ev("JARVIS.stats.dropped"))
        ev("JARVIS.say('thank you jarvis')"); pg.wait_for_timeout(800)
        ev("window.__native.listen.length=0"); ev("window.__jvWake(0.9)"); pg.wait_for_timeout(200)
        check('"Hey Jarvis" while idle opens the mic WITH the second before it', any(x['on'] and x['pre'] for x in ev("window.__native.listen")), ev("window.__native.listen"))
        ev("JARVIS.say('thank you jarvis')"); pg.wait_for_timeout(1500)

        # ---- navigation: origin from page GPS post, voice command bypasses the LLM
        n_before = len(state['groq_calls'])
        ev("fetch('/nav/position',{method:'POST',body:JSON.stringify({lat:%f,lon:%f,acc:10})})" % A)
        ws_msgs = ev("(()=>{window.__ws=[];const w=new WebSocket('ws://'+location.host+'/ws');w.onmessage=e=>window.__ws.push(e.data);return 1})()")
        pg.wait_for_timeout(300)
        ev("window.__native.tts.length=0"); pg.wait_for_timeout(1500)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('navigate to 100 Main Street')")
        try: pg.wait_for_function("window.__ws.some(m=>m.startsWith('nav:'))", timeout=15000)
        except Exception: print('DEBUG ws', ev('window.__ws')[:6], ev("document.getElementById('log').textContent.slice(-500)"), state['http'][-8:], ev("JSON.stringify(window.__native.tts.slice(-4))")); raise
        navmsgs = [json.loads(m[4:]) for m in ev('window.__ws') if m.startswith('nav:')]
        start = [m for m in navmsgs if m.get('cmd') in ('start', 'route')]
        check('nav start pushed over /ws with a route', bool(start), navmsgs[:2])
        check('nav command skipped the LLM', len([c for c in state['groq_calls'] if c.get('stream')]) == len([c for c in state['groq_calls'][:n_before] if c.get('stream')]))
        check('native http used with User-Agent for Nominatim', any('nominatim' in h['url'] and 'Jarvis' in h['ua'] for h in ev('window.__native.http')))
        check('navsvc active', ev('JARVIS.navsvc.state.active') is True)

        # ---- delivery via the model tool (stop the trip first, as a driver would)
        ev("JARVIS.say('Hey Jarvis, stop navigation')"); pg.wait_for_timeout(2500)
        check('stop navigation by voice', ev('JARVIS.navsvc.state.active') is False)
        ev("window.__native.tts.length=0"); pg.wait_for_timeout(1500)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('I accepted a doordash order from Chipotle')")
        plan = {}
        for _ in range(40):
            pg.wait_for_timeout(500); plan = ev("fetch('/delivery/plan').then(r=>r.json())")
            if plan.get('stops'): break
        check('delivery plan has stops', len(plan.get('stops', [])) == 2, plan)
        check('route panel rendered', ev("document.getElementById('route-panel').classList.contains('show')"))
        # ---- with orders, the map comes up by itself under the card and Jarvis shrinks to a corner orb
        try: pg.wait_for_function("document.body.getAttribute('data-nav') === 'dash'", timeout=10000)
        except Exception: pass
        check('orders on: the delivery map comes up by itself (dash view)', ev("document.body.getAttribute('data-nav')") == 'dash' and ev('JARVIS.navsvc.state.delivery') is True, (ev("document.body.getAttribute('data-nav')"), ev('JARVIS.navsvc.state.view')))
        pg.wait_for_timeout(1200)
        g = ev("""(()=>{ const r = id => document.getElementById(id).getBoundingClientRect(), f = r('nav-frame'), p = r('route-panel'), o = r('nav-orb');
          return { ft: f.top, fb: f.bottom, fh: f.height, pt: p.top, pb: p.bottom, ol: o.left, ot: o.top, ow: o.width, W: innerWidth, H: innerHeight,
                   orb: getComputedStyle(document.getElementById('nav-orb')).opacity, three: getComputedStyle(document.getElementById('three')).transform }; })()""")
        check('...the map sits under the route card', g['ft'] >= g['pb'] + 4 and g['fh'] >= 150, g)
        check('...and the face is a small orb in the bottom-right corner, below the map', g['ol'] > g['W'] / 2 and g['ot'] > g['fb'] and g['ow'] < 140 and g['orb'] == '1' and g['three'] != 'none', g)
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/dash.png'))
        def ask0(text, until, timeout=10000):
            ev("window.__native.tts.length=0"); pg.wait_for_timeout(1300)
            ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev(f"JARVIS.say({json.dumps(text)})")
            try: pg.wait_for_function(f"window.__native.tts.join(' ').includes({json.dumps(until)})", timeout=timeout)
            except Exception: pass
            pg.wait_for_timeout(900); return ev("window.__native.tts.join(' ')")
        # ---- Jarvis notices a finished stop: you stay at the restaurant a while, then drive off
        ev("window.__jvDwellMs = 600; window.__native.tts.length = 0")
        post = lambda la, lo: ev("fetch('/nav/position',{method:'POST',body:JSON.stringify({lat:%f,lon:%f,acc:8})})" % (la, lo))
        post(33.4551, -112.0651); pg.wait_for_timeout(800); post(33.4550, -112.0650); pg.wait_for_timeout(300); post(33.4620, -112.0450)
        try: pg.wait_for_function("window.__native.tts.join(' ').includes('picked up')", timeout=8000)
        except Exception: pass
        plan = ev("fetch('/delivery/plan').then(r=>r.json())")
        check('stopped at the pickup, then drove off: marked picked up by itself, and says so', len(plan.get('stops', [])) == 1 and 'Marked Chipotle picked up' in ev("window.__native.tts.join(' ')"), (plan.get('stops'), ev("window.__native.tts")))
        said = ask0('undo', 'Undone')
        plan = ev("fetch('/delivery/plan').then(r=>r.json())")
        check('"undo" puts it back', len(plan.get('stops', [])) == 2 and 'not picked up yet' in said, (said[:120], plan.get('stops')))
        ask0('picked up', 'Picked up')
        said = ask0('delivered', 'Delivered')
        pg.wait_for_timeout(1500)
        check('last drop-off done: card, map and orb go away, the face comes back', ev("document.body.getAttribute('data-nav')") is None and not ev("document.getElementById('route-panel').classList.contains('show')") and ev('JARVIS.navsvc.state.active') is False, (ev("document.body.getAttribute('data-nav')"), said[:120]))

        # ---- speech in, the native way: wake word -> listening -> PCM from Java -> VAD -> Whisper (through the app) -> page
        pg.wait_for_timeout(3000)
        state['stt_calls'] = 0; state['stt_text'] = 'Hey Jarvis'; ev("window.__native.listening.length=0; window.__native.tones=0; window.__native.streams.length=0")
        ev("JARVIS.say('thank you jarvis')"); pg.wait_for_timeout(600)      # close any open session first
        ev("window.__jvWake(0.82)"); pg.wait_for_timeout(400)
        check('wake word opens a session', ev("window.__jv.state().session") is True)
        check('wake chime played natively', ev('window.__native.tones') >= 1, ev('window.__native.tones'))
        check('native mic told to stream audio', True in ev('window.__native.listening'), ev('window.__native.listening'))
        ev("""(()=>{ const f=(n,a)=>{const x=new Int16Array(n); for(let i=0;i<n;i++) x[i]=Math.round(a*Math.sin(i/7)*(1+Math.sin(i/300))); return x;};
          const send = a => { const x = f(1280, a), u = new Uint8Array(x.buffer); let s=''; for (const b of u) s+=String.fromCharCode(b); window.__jvPcm(btoa(s)); };
          for(let i=0;i<10;i++) send(60); for(let i=0;i<25;i++) send(6000); for(let i=0;i<14;i++) send(40); })()""")
        pg.wait_for_timeout(2500)
        check('VAD sent one clip to Whisper', state['stt_calls'] >= 1, state['stt_calls'])
        check('Groq accepted the upload (valid multipart, model, language)', not state.get('stt_errors'), state.get('stt_errors'))
        # ---- the "30 seconds late" case: loud steady background noise + the phone's speech detector
        state['stt_calls'] = 0; state['stt_text'] = 'what time is it'
        ev("JARVIS.say('thank you jarvis')"); pg.wait_for_timeout(600); ev("window.__jvWake(0.9)"); pg.wait_for_timeout(300)
        t_end = ev("""(()=>{ let r=7; const rnd=()=>((r=(r*16807)%2147483647)/2147483647)-0.5;
          const noise=a=>Int16Array.from({length:1280},()=>Math.round(rnd()*2*a*1.7)), voice=a=>Int16Array.from({length:1280},(_, i)=>Math.round(a*Math.sin(i/6)+rnd()*300));
          const send=(x,p)=>{ const u=new Uint8Array(x.buffer); let s=''; for (const b of u) s+=String.fromCharCode(b); window.__jvPcm(btoa(s), p); };
          for(let i=0;i<10;i++) send(noise(400),0.03); for(let i=0;i<20;i++) send(voice(3000),0.96);
          window.__tStop = performance.now(); window.__tHeard = 0;
          const iv = setInterval(()=>{ send(noise(400),0.03); if (JARVIS.stats.heard[0] && JARVIS.stats.heard[0].text==='what time is it' && !window.__tHeard) { window.__tHeard = performance.now(); clearInterval(iv); } }, 80);
          setTimeout(()=>clearInterval(iv), 15000); return 1; })()""")
        pg.wait_for_function("window.__tHeard > 0", timeout=16000)
        lat = ev("window.__tHeard - window.__tStop")
        check(f'noisy room: words reach Jarvis {lat/1000:.1f} s after you stop (was 15-30 s)', lat < 1500, lat)
        check('the clip was cut by the pause, not the time limit', ev("JARVIS.stats.clipWhy") == 'pause', ev("JARVIS.stats.clipWhy"))
        pg.wait_for_timeout(2500)

        # a speech-service error must be visible, not silent
        ev("JARVIS.config.set('stt_model','bogus-model')"); ev("JARVIS.wake()"); pg.wait_for_timeout(300)
        ev("""(()=>{ const f=(n,a)=>{const x=new Int16Array(n); for(let i=0;i<n;i++) x[i]=Math.round(a*Math.sin(i/7)*(1+Math.sin(i/300))); return x;};
          const send = a => { const x = f(1280, a), u = new Uint8Array(x.buffer); let s=''; for (const b of u) s+=String.fromCharCode(b); window.__jvPcm(btoa(s)); };
          for(let i=0;i<10;i++) send(60); for(let i=0;i<25;i++) send(6000); for(let i=0;i<14;i++) send(40); })()"""); pg.wait_for_timeout(2000)
        check('speech errors are shown (Hearing panel + spoken notice)', 'not found' in (ev('JARVIS.stats.sttError') or '') and 'speech service' in ev('JARVIS.stats.notice'), (ev('JARVIS.stats.sttError'), ev('JARVIS.stats.notice')))
        ev("JARVIS.config.set('stt_model',''); JARVIS.stats.sttError=''; JARVIS.stt.skipUntil=0"); state.pop('stt_errors', None)
        check('the words reached Jarvis', ev("JARVIS.stats.heard.some(h => h.text === 'Hey Jarvis')"), ev("JARVIS.stats.heard"))
        check('Whisper went through the app (no browser CORS)', any('audio/transcriptions' in u for u in ev('window.__native.streams')))
        ev("JARVIS.say('thank you jarvis')"); pg.wait_for_timeout(800)
        check('session closed -> mic stops streaming', ev('window.__native.listening').count(False) >= 1 and ev('JARVIS.stats.listening') is False, ev('window.__native.listening'))
        check('speaking state reported to native (for barge-in)', True in ev('window.__native.speaking'))

        # ---- a rejected key is spoken, not swallowed
        ev("JARVIS.config.set('groq_key','gsk_bad')"); ev("window.__native.tts.length=0"); pg.wait_for_timeout(1200)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('tell me something interesting')")   # (not an echo of the mock reply)
        try: pg.wait_for_function("window.__native.tts.join(' ').toLowerCase().includes('key')", timeout=8000)
        except Exception: print('DEBUG tts', ev('window.__native.tts'), ev('window.__jv.state()'), ev("document.getElementById('log').textContent.slice(-300)")); raise
        check('rejected key is spoken', True)
        ev("JARVIS.config.set('groq_key','gsk_good')")

        # ---- hung-up behaviours
        ev("speechSynthesis.cancel()"); check('tts cancel reaches native', ev('window.__native.stopped') >= 1)
        ev("JARVIS.speakTest('hi')"); pg.wait_for_timeout(100); check('speakTest goes to native', 'hi' in ev('window.__native.tts'))

        # ---- offer reader
        check('pay floors reach the offer reader', ev('window.__native.offerPrefs') == [18, 1.5, '$', True], ev('window.__native.offerPrefs'))
        ev("window.__native.tts.length=0")
        ev("""window.__jvOffer(JSON.stringify({platform:'DoorDash', store:'Chipotle', payout:9.5, miles:6.3, minutes:27, estimated:true, orders:1,
            spoken:'Take it. $9.50 for 6.3 miles, $1.51 a mile, about $21 an hour if it takes 27 minutes.'}), true)""")
        pg.wait_for_function("window.__native.tts.join(' ').includes('Take it')", timeout=5000)
        check('an offer read off the screen is spoken by Jarvis', True)
        check('...and shows in the conversation', 'Take it. $9.50' in ev("document.getElementById('log').textContent"))
        r = ev("JARVIS.reg.exec('screen_offer','{}')")
        check('"what was that offer?" answers from the last offer', 'Chipotle' in r and 'Take it' in r and 'You accept it in the app' in r, r)
        ev("JARVIS.openSettings()"); pg.wait_for_timeout(500)
        txt = ev("document.getElementById('jv-ov').textContent")
        check('settings explains the offer reader before turning it on', 'never taps, accepts or declines' in txt and 'Turn on the offer reader' in txt, txt[:200])
        ev("[...document.querySelectorAll('#jv-ov button')].find(b => b.textContent === 'Turn on the offer reader').click()")
        check('"Turn on" opens Android accessibility settings', 'accessibility-settings' in ev('window.__native.opened'))
        ev("window.__offerOn = true"); pg.wait_for_timeout(500)
        check('settings shows it on, with the last offer', 'On. Offers' in ev("document.getElementById('jv-ov').textContent") and 'Last offer: Take it' in ev("document.getElementById('jv-ov').textContent"))
        ev("document.querySelector('#jv-ov .bar button').click()"); pg.wait_for_timeout(300)

        # ---- new phone UI
        check('status pill shows plain-language state', ev("document.querySelector('#jv-status').textContent") in ('Say “Hey Jarvis”', 'Listening', 'Speaking', 'Thinking…'), ev("document.querySelector('#jv-status').textContent"))
        check('caption shows Jarvis\'s last reply', len(ev("document.querySelector('#jv-cap .him').textContent") + ev("document.querySelector('#jv-cap .you').textContent")) > 0)
        ev("document.getElementById('jv-hist').click()"); check('history sheet opens', ev("document.body.classList.contains('jv-history')")); ev("document.getElementById('jv-hist').click()")
        HOLD = "(() => { const o = document.getElementById('jv-orb'), r = o.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;"
        HOLD += " o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 7, button: 0 }));"
        HOLD += " return new Promise(res => setTimeout(() => { o.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 7 })); res(1); }, 700)); })()"
        check('the main screen has no mute or settings buttons any more (just talk + conversation)', not ev("!!document.getElementById('jv-mute')") and ev("[...document.querySelectorAll('#jv-dock button')].filter(b => b.offsetParent).length") == 2
              and ev("!!document.querySelector('#jv-hist-head #jv-gear')"))
        ev(HOLD); pg.wait_for_timeout(200)
        check('holding the talk button mutes, with a buzz', ev("window.__jv.state().muted") is True and ev("document.querySelector('#jv-status').textContent").startswith('Muted')
              and 'mute' in (ev("window.__native.vib") or []) and ev("getComputedStyle(document.getElementById('jv-status')).display") != 'none')
        ev(HOLD); pg.wait_for_timeout(200)
        check('holding it again unmutes; the status pill hides again', ev("window.__jv.state().muted") is False and ev("getComputedStyle(document.getElementById('jv-status')).display") == 'none')
        ev("""(() => { const o = document.getElementById('jv-orb'), r = o.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
              o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 8, button: 0 }));
              o.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y - 60, pointerId: 8 }));
              o.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y - 60, pointerId: 8 })); })()"""); pg.wait_for_timeout(200)
        check('swiping up from the talk button shows ideas', ev("document.body.classList.contains('jv-ideas')") and ev("document.querySelectorAll('#jv-ideas button').length") >= 4 and ev("window.__jv.state().muted") is False)
        ev("document.getElementById('jv-scrim').click()")
        check('tapping away hides them', not ev("document.body.classList.contains('jv-ideas')"))
        ev("JARVIS.uiTiming.answerMs = 1500; JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('what time is it')")
        pg.wait_for_function("document.getElementById('jv-card').classList.contains('answer')", timeout=15000)
        check('once he answers, the card shows just his answer (not your words)', ev("getComputedStyle(document.querySelector('#jv-card .you')).display") == 'none' and len(ev("document.querySelector('#jv-card .him').textContent")) > 0)
        pg.wait_for_function("!document.body.classList.contains('jv-talking')", timeout=20000)
        check('...and clears itself shortly after he is done', not ev("document.body.classList.contains('jv-talking')"))
        ev("JARVIS.uiTiming.answerMs = 10000")

        # ---- earnings page, what Jarvis knows, driving mode
        ev("""(() => { const d = JARVIS.delivery._db(), now = Date.now() / 1000;
              for (const [ago, pay, area, r] of [[0.5, 9.5, 'Tempe, AZ', 'Chipotle'], [1.2, 12, 'Tempe, AZ', 'Wingstop'], [26, 7, 'Mesa, AZ', 'Chipotle'], [50, 11, 'Tempe, AZ', 'Chipotle']])
                d.log.push({ platform: 'DoorDash', restaurant: r, payout: pay, accepted_at: now - ago * 3600 - 1200, delivered_at: now - ago * 3600, area });
              JARVIS.delivery._save(d); })()""")
        r = ev("JARVIS.reg.exec('show_earnings', JSON.stringify({ focus: 'week' }))"); pg.wait_for_timeout(300)
        check('"show my earnings" opens the Earnings page and says the headline', ev("document.getElementById('jv-pane').classList.contains('on')") and 'This week' in r and 'order' in r, r)
        txt = ev("document.getElementById('jv-pane').innerText")
        check('the page has the week total, 7 bars, best areas', ev("document.querySelectorAll('#jv-pane .bars button').length") == 7 and 'Best-paying areas' in txt and 'Tempe, AZ' in txt, txt[:300])
        ev("document.querySelector('#jv-pane .seg button').click()"); pg.wait_for_timeout(100)
        today = ev("'$' + JARVIS.earningsNow().today.earned.toFixed(2)")
        check('Today shows today only (incl. the two just now; on a Monday the week is just today)', today == ev("document.querySelector('#jv-pane .hero').textContent") and ev("JARVIS.earningsNow().today.orders") >= 2 and ev("JARVIS.earningsNow().week.earned") >= ev("JARVIS.earningsNow().today.earned"), [today, ev("document.querySelector('#jv-pane .hero').textContent")])
        check('the face stops while it is open', ev("window.__jvPaused") is True)
        ev("document.querySelector('#jv-pane .back').click()"); pg.wait_for_timeout(100)
        check('closing it brings the face back', ev("window.__jvPaused") is False and not ev("document.body.classList.contains('jv-pane')"))
        ev("JARVIS.kv.set('memories', [{ fact: 'Drives for DoorDash in Tempe', ts: Date.now() }, { fact: 'Likes jollof rice', ts: Date.now() }]); JARVIS.kv.set('prefs', ['Keep answers short'])")
        r = ev("JARVIS.reg.exec('show_what_you_know', '{}')"); pg.wait_for_timeout(200)
        txt = ev("document.getElementById('jv-pane').innerText")
        check('"what do you know about me" lists facts and preferences', 'Likes jollof rice' in txt and 'Keep answers short' in txt and '2 things about you' in r, r)
        ev("document.querySelector('#jv-pane .del[aria-label=\"Forget Likes jollof rice\"]').click()"); pg.wait_for_timeout(100)
        check('tapping x forgets it', [m['fact'] for m in ev("JARVIS.kv.get('memories', [])")] == ['Drives for DoorDash in Tempe'] and 'Likes jollof rice' not in ev("document.getElementById('jv-pane').innerText"))
        ev("document.querySelector('#jv-pane .back').click()")
        r = ev("JARVIS.reg.exec('set_driving_mode', JSON.stringify({ mode: 'on' }))"); pg.wait_for_timeout(400)
        check('driving mode on: big glanceable screen, the face rests', ev("document.body.classList.contains('jv-drive')") and ev("window.__jvHideFace") is True
              and ev("getComputedStyle(document.getElementById('jv-drive')).display") == 'flex' and today in ev("document.querySelector('#jv-drive .dv-money').textContent"), ev("document.getElementById('jv-drive').innerText")[:200])
        ev("document.querySelector('#jv-drive .dv-today').click()"); pg.wait_for_timeout(100)
        check('tapping today\'s pay opens the Earnings page', ev("document.getElementById('jv-pane').classList.contains('on')")); ev("document.querySelector('#jv-pane .back').click()")
        ev("document.querySelector('#jv-drive .dv-x').click()"); pg.wait_for_timeout(200)
        check('the x leaves driving mode (and the face comes back)', not ev("document.body.classList.contains('jv-drive')") and ev("window.__jvHideFace") is False and ev("JARVIS.config.get('drive_mode')") == 'auto')
        ev("JARVIS.reg.exec('set_driving_mode', JSON.stringify({ mode: 'auto' }))")
        pg.wait_for_timeout(5300)
        w = (ev("window.__native.widget") or [{}])[-1]
        check('the home-screen widget shows today\'s pay and opens Earnings', w.get('line1', '').startswith('Today $') and w.get('open') == 'earnings', w)
        ev("window.__fakeWake = true; window.__native.vib = []; window.__jvWake(0.8)"); pg.wait_for_timeout(200)
        check('"Hey Jarvis" buzzes', 'wake' in (ev("window.__native.vib") or []))
        ev("window.__native.vib = []; JARVIS.wake()"); pg.wait_for_timeout(200)
        check('...a tap on the button does not buzz', 'wake' not in (ev("window.__native.vib") or []))
        # ---- location: the phone's own GPS, even with the map closed (it used to say "I don't know where you are")
        ev("JARVIS.navsvc.state.pos = null; window.__phone.loc = { lat: 9.0765, lon: 7.4986, acc: 15, age_s: 4 }")
        check('Jarvis knows where you are from the phone\'s GPS with the map closed', ev("JSON.stringify(JARVIS.navsvc.origin())") == '[9.0765,7.4986]', ev("JSON.stringify(JARVIS.navsvc.origin())"))
        n0 = len(state.get('geo', []))
        r = ev("JARVIS.reg.exec('navigate_to', JSON.stringify({ destination: 'Jabi Lake Mall', from: 'my current location' }))")
        check('"from my current location" starts from the GPS (it used to look that phrase up as a place abroad: "too far")', not any('current location' in q for q in state.get('geo', [])[n0:]) and 'too far' not in r.lower() and 'farther' not in r.lower(), (r, state.get('geo', [])[n0:]))
        ev("JARVIS.reg.exec('stop_navigation', '{}')")
        n0 = len(state.get('geo', []))
        r = ev("JARVIS.navsvc.fastpath ? JARVIS.navsvc.fastpath('give me directions to Jabi Lake Mall from where I am') : null")
        geo = state.get('geo', [])[n0:]
        check('"directions to X from where I am" (the start said last) goes to X from the GPS', r and geo and all('where' not in q.lower() for q in geo) and any('Jabi Lake Mall' == q for q in geo), (r, geo))
        ev("JARVIS.reg.exec('stop_navigation', '{}')")
        ev("JARVIS.navsvc.state.pos = null; window.__phone.loc = {}")
        # ---- talking: speaking speed and a mouth that follows the voice's loudness
        check('he talks a bit faster by default (both voices get the speed)', ev("window.__native.speed") == 1.15, ev("window.__native.speed"))
        ev("window.__mouth = 0.2"); [ev("window.__jvMouthLevel()") for _ in range(5)]
        check('a loud sound from the speaker opens the mouth', ev("window.__jvMouthLevel()") > 0.7)
        ev("window.__mouth = null")
        # ---- faces
        r = ev("JARVIS.reg.exec('choose_face', JSON.stringify({ face: 'orb' }))")
        check('"use the orb": no face, a ball of light (and the 3D face stops drawing)', ev("document.body.classList.contains('jv-faceless')") and ev("window.__jvHideFace") is True and ev("window.__jvFaceFor(true)") == 'orb', r)
        ev("JARVIS.reg.exec('set_voice', JSON.stringify({ voice_name: 'female' }))")
        check('switching voice keeps the orb (with the new voice)', ev("JARVIS.config.get('face')") == 'orb' and ev("JARVIS.config.get('avatar_gender')") == 'female')
        r = ev("JARVIS.reg.exec('choose_face', JSON.stringify({ face: 'female' }))")
        check('"use your female face": her face, female voice, the face is back', ev("JARVIS.config.get('face')") == 'female' and not ev("document.body.classList.contains('jv-faceless')") and ev("window.__jvFaceFor(false)") == 'models/faces/nova.glb', r)
        ev("JARVIS.reg.exec('set_voice', JSON.stringify({ voice_name: 'male' }))")
        check('"male voice" brings the male face', ev("JARVIS.config.get('face')") == 'male' and ev("window.__jvFaceFor(true)") == 'models/faces/kofi.glb')
        ev("JARVIS.config.set('face', 'amara')")
        check('a face from an older build still works (Amara is now the female face)', ev("window.__jvFaceFor(null)") == 'models/faces/nova.glb')
        ev("JARVIS.config.set('face', 'male')")
        ev("JARVIS.openSettings('voice')"); pg.wait_for_timeout(200)
        cards = ev("[...document.querySelectorAll('#jv-ov .face')].map(b => b.dataset.face + ':' + b.getAttribute('aria-checked'))")
        check('settings shows the faces with the male one picked', cards == ['male:true', 'female:false', 'orb:false'], cards)
        ev("document.querySelector('#jv-ov .face[data-face=female]').click()"); pg.wait_for_timeout(300)
        check('tapping Female picks her, with a female voice', ev("JARVIS.config.get('face')") == 'female' and ev("JARVIS.config.get('avatar_gender')") == 'female' and ev("document.querySelector('#jv-ov .face[data-face=female]').getAttribute('aria-checked')") == 'true')
        ev("document.querySelector('#jv-ov .bar .x').click()"); ev("JARVIS.chooseFace('male')"); pg.wait_for_timeout(200)

        ev("document.getElementById('jv-hist').click()"); pg.wait_for_timeout(100)
        check('the conversation sheet links to Earnings, What I know and Settings', [b.strip() for b in ev("[...document.querySelectorAll('#jv-hist-head .links button')].map(b => b.textContent)")] == ['Earnings', 'What I know', 'Settings', 'Clear'])
        ev("document.getElementById('jv-hist').click()")
        ev("JARVIS.openSettings()"); pg.wait_for_timeout(400); pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/settings.png'))
        check('settings open pauses the 3D face', ev("window.__jvPaused === true && getComputedStyle(document.getElementById('three')).visibility === 'hidden'"))
        check('settings: hearing panel shows mic on', 'On' in ev("document.getElementById('jv-diag').textContent"), ev("document.getElementById('jv-diag').textContent")[:200])
        ev("document.querySelector('#jv-ov .bar button').click()"); pg.wait_for_timeout(200)
        check('closing settings resumes the face', ev("window.__jvPaused === false && getComputedStyle(document.getElementById('three')).visibility === 'visible'"))

        # ---- layout on a phone
        w = ev("[document.documentElement.scrollWidth, innerWidth]")
        check('no horizontal scroll', w[0] <= w[1], w)
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/phone.png'))

        # ================================================================== phone powers (tools_phone.js + PhoneActions)
        def ask(text, until, timeout=10000):
            ev("window.__native.tts.length=0"); pg.wait_for_timeout(1300)
            ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev(f"JARVIS.say({json.dumps(text)})")
            try: pg.wait_for_function(f"window.__native.tts.join(' ').includes({json.dumps(until)})", timeout=timeout)
            except Exception: pass
            pg.wait_for_timeout(900)                                   # the rest of the reply
            return ev("window.__native.tts.join(' ')")
        script = lambda *steps: '!script ' + json.dumps([list(x) for x in steps]) + ' on my phone for me please'   # words after it, like a real request
        calls = lambda name: [c for c in ev('window.__phone.calls') if c[0] == name]
        reset = lambda: ev('window.__phone.calls.length = 0')
        ev("JARVIS.config.set('groq_key', 'gsk_good'); JARVIS.brain.state.bad = false; JARVIS.brain.state.announced = false")

        # reminders: native alarms at the exact local time the model worked out
        tomorrow8 = ev("(()=>{ const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); })()")
        iso = ev("(()=>{ const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T08:00'; })()")
        said = ask(script(('set_reminder', {'text': 'call mom', 'at': iso})), 'Reminder set')
        rem = ev('window.__phone.reminders')
        check('reminder goes to Android alarms at the exact local time', len(rem) == 1 and rem[0]['at'] == tomorrow8 and rem[0]['kind'] == 'reminder' and rem[0]['text'] == 'call mom', rem)
        check('...and Jarvis confirms it (with the "may be late" hint once)', 'Reminder set for 8:00 AM tomorrow: call mom' in said and 'Alarms and reminders' in said, said[:300])
        sp = [c for c in state['groq_calls'] if c.get('stream')][-1]['messages'][0]['content']
        check('the brain knows the current local time', 'CURRENT LOCAL TIME' in sp and re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', sp.split('CURRENT LOCAL TIME')[1]), sp[-200:])
        said = ask(script(('set_timer', {'seconds': 90, 'label': 'pizza'})), 'Timer set')
        check('timer -> native alarm, 90 seconds', any(r['kind'] == 'timer' and abs(r['at'] - ev('Date.now()') - 90000) < 8000 for r in ev('window.__phone.reminders')) and 'Timer set for 1 minute 30 seconds' in said, said[:200])
        r = ev("JARVIS.reg.exec('list_reminders', '{}')")
        check('list reminders (native)', 'pizza timer ends' in r and 'call mom' in r, r)
        r = ev("JARVIS.reg.exec('cancel_reminder', JSON.stringify({which: 'timer'}))")
        check('cancel the timer', r.startswith('Cancelled') and not any(x['kind'] == 'timer' for x in ev('window.__phone.reminders')), r)
        ev("window.__native.tts.length=0"); pg.wait_for_timeout(1300)
        ev("window.__jvAlarm(JSON.stringify({ id: 'x', kind: 'reminder', text: 'call mom' }), true)")
        try: pg.wait_for_function("window.__native.tts.join(' ').includes('call mom')", timeout=6000)
        except Exception: pass
        check('a reminder ringing while Jarvis is on screen is spoken', 'Reminder' in ev("window.__native.tts.join(' ')") and 'call mom' in ev("window.__native.tts.join(' ')"), ev('window.__native.tts'))
        reset(); r = ev("JARVIS.reg.exec('set_alarm', JSON.stringify({time: '06:30', days: 'mon,tue,wed,thu,fri'}))")
        check('wake-up alarm goes to the Clock app', calls('clockAlarm') == [['clockAlarm', 6, 30, '', 'mon,tue,wed,thu,fri']] and '6:30' in r, (calls('clockAlarm'), r))

        # websites
        ev('window.__native.opened.length = 0')
        said = ask(script(('open_website', {'site': 'youtube'})), 'Opening')
        check('open a website by name', 'https://www.youtube.com' in ev('window.__native.opened') and 'Opening youtube' in said, (ev('window.__native.opened'), said[:100]))
        r = ev("JARVIS.reg.exec('play_youtube', JSON.stringify({query: 'lofi beats'}))")
        check('YouTube search', any('youtube.com/results?search_query=lofi%20beats' in u for u in ev('window.__native.opened')), ev('window.__native.opened'))
        r = ev("JARVIS.reg.exec('show_public_cam', JSON.stringify({location: 'Times Square'}))")
        check('live public cam: Windy webcams need the build key', 'windy key' in r.lower(), r)

        # eyes: the camera (Chromium's fake camera) -> Groq vision
        state['vision'] = []; reset()
        ev("window.__phone.visible = false")
        said = ask(script(('look_with_camera', {'question': 'what is this?'})), 'coffee mug', timeout=15000)
        v = state['vision']
        img = v and v[-1]['messages'][-1]['content'][1]['image_url']['url']
        check('"what is this?" brings Jarvis to the front, takes a picture and asks the vision model', calls('bringToFront') and v and v[-1]['model'] == 'qwen/qwen3.8-27b' and img.startswith('data:image/jpeg;base64,') and len(img) > 2000, (calls('bringToFront'), len(v), (img or '')[:40]))
        check('...and says what it sees', 'A red coffee mug on a wooden desk' in said, said[:200])
        check('the camera preview closes afterwards', ev("!document.getElementById('jv-cam')"))
        r = ev("JARVIS.reg.exec('take_photo', '{}')")
        check('take a photo -> saved to the gallery', calls('photoSave') and calls('photoSave')[0][1].startswith('data:image/jpeg') and 'gallery' in r, (calls('photoSave'), r))

        # instant commands: done on the phone, no AI round trip
        reset(); n0 = len(state['groq_calls'])
        said = ask('Hey Jarvis, could you turn on the flashlight please', 'Flashlight on')
        check('"turn on the flashlight" is instant: done on the phone, nothing sent to the AI', calls('flashlight') == [['flashlight', 'on']] and len(state['groq_calls']) == n0 and 'Flashlight on' in said, (calls('flashlight'), len(state['groq_calls']) - n0, said[:80]))

        reset(); n0 = len(state['groq_calls'])
        said = ask('Jarvis, on my torchlight', 'Flashlight on')
        check('"on my torchlight" (how it is said in Nigeria) is the flashlight too, instantly', calls('flashlight') == [['flashlight', 'on']] and len(state['groq_calls']) == n0, (calls('flashlight'), said[:80]))

        reset(); n0 = len(state['groq_calls'])
        said = ask('turn it off', 'Flashlight off')
        check('"turn it off" right after means the flashlight (really switched off, not just said)', calls('flashlight') == [['flashlight', 'off']] and len(state['groq_calls']) == n0, (calls('flashlight'), said[:80]))
        reset(); n0 = len(state['groq_calls'])
        said = ask('Switch to the female voice', 'female voice', timeout=12000)
        check('"switch to the female voice" works by voice: voice and face change, no AI needed', ev("JARVIS.chosenVoice().gender") == 'f' and ev("fetch('/get_voice').then(r=>r.json()).then(j=>j.voice)").startswith('amy~') and 'This is my female voice' in said and len(state['groq_calls']) == n0, (ev("JARVIS.chosenVoice()"), said[:120]))
        said = ask('go back to the male voice', 'male voice', timeout=12000)
        check('...and back to male', ev("JARVIS.chosenVoice().gender") == 'm' and 'This is my male voice' in said, said[:120])
        said = ask("What's the weather in markdown", 'Lagos')
        check('markdown and emoji are never spoken (no "asterisk")', 'Lagos: partly cloudy, 31 degrees Celsius.' in said and '*' not in said and '🌧' not in said and 'Rain: 40% chance' in said, said[:200])
        check('...and the answer on screen is clean too', '*' not in ev("document.getElementById('log').textContent.slice(-400)"))
        n0 = len(state['groq_calls'])
        said = ask('set a timer for 5 minutes', 'Timer set')
        check('"set a timer for 5 minutes" is instant', len(state['groq_calls']) == n0 and 'Timer set for 5 minutes' in said, said[:80])
        check('the speed meter shows it', ev('JARVIS.stats.lat && JARVIS.stats.lat.instant') is True)
        said = ask(script(('get_weather', {})) , 'Done')
        check('...while a real question still goes to the AI', len(state['groq_calls']) > n0)

        # live interpreter
        state['interp'] = []; ev("window.__native.ttsLang = []")
        said = ask(script(('start_interpreter', {'language': 'Spanish'})), 'Interpreter on', timeout=12000)
        check('interpreter starts (English <-> Spanish)', 'Interpreter on: English and Spanish' in said and ev('JARVIS.interp.on') is True, said[:200])
        check('...speech-to-text listens for any language and reports it', ev("JARVIS.stt.getConfig('stt_language')") == 'auto' and ev("JARVIS.stt.getConfig('stt_detect')") is True and ev("JARVIS.stt.getConfig('stt_prompt')") == '')
        check('...the page keeps the conversation open and ignores "thank you"', ev('window.__jvInterpreting') is True and ev('window.__jvSessionMs') == 600000)
        pg.wait_for_timeout(3500)
        check('...and greets the other person in Spanish, in a Spanish voice', ['es', 'Hola.'] in ev('window.__native.ttsLang') or any(l == 'es' and 'Hola' in t for l, t in ev('window.__native.ttsLang')), ev('window.__native.ttsLang'))
        check('the face-to-face screen is up, top half turned to them', ev("document.getElementById('jv-int').classList.contains('on') && getComputedStyle(document.querySelector('#jv-int .them')).transform !== 'none'"))
        ev("window.__native.ttsLang = []; window.__native.tts.length = 0")
        ev("JARVIS.say('how are you, I will be there in five minutes')")
        try: pg.wait_for_function("(window.__native.ttsLang || []).length >= 2", timeout=8000)
        except Exception: pass
        check('after Jarvis speaks by himself, he listens again without "Hey Jarvis"', ev('window.__jv.state().speaking') is False or len(ev('window.__native.ttsLang')) > 0, ev('window.__jv.state()'))
        check('what I say is spoken to them in Spanish, with the Spanish voice', ev('window.__native.ttsLang')[0][0] == 'es' and 'Cómo estás' in ev('window.__native.ttsLang')[0][1], ev('window.__native.ttsLang'))
        check('...their half shows the Spanish, mine shows what I said', 'Llego en cinco minutos' in ev("document.querySelector('#jv-int .them .big').textContent") and 'five minutes' in ev("document.querySelector('#jv-int .me .big').textContent"))
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/interpreter.png'))
        req = state['interp'][-1]
        check('...translated by the fast model as JSON', req['model'] == 'openai/gpt-oss-20b' and req.get('response_format', {}).get('type') == 'json_object')
        ev("window.__native.ttsLang = []; window.__native.tts.length = 0"); pg.wait_for_timeout(1300)
        ev("JARVIS.say('hola necesito ayuda con mi pedido')")
        pg.wait_for_function("window.__native.tts.join(' ').includes('Hello, I need help')", timeout=8000)
        check('what they say comes back to me in English, in Jarvis\'s own voice', not ev('window.__native.ttsLang') and 'Hello, I need help with my order' in ev("document.querySelector('#jv-int .me .big').textContent"), ev('window.__native.ttsLang'))
        pg.wait_for_timeout(1300); ev("JARVIS.say('stop interpreting')"); pg.wait_for_timeout(1200)
        check('"stop interpreting" turns it off and restores normal hearing', ev('JARVIS.interp.on') is False and not ev("document.getElementById('jv-int').classList.contains('on')") and ev("JARVIS.stt.getConfig('stt_language', 'en')") == 'en' and ev('window.__jvInterpreting') is False)

        # ================================================================== camera extras
        state['vision'] = []; reset()
        r = ev("JARVIS.reg.exec('scan_receipt', '{}')")
        check('scan a receipt -> logged as a fuel expense', r.startswith('Logged $42.10 at Shell, as fuel'), r)
        check('...read with the vision model asked for JSON', 'reply only in the format asked for' in state['vision'][-1]['messages'][0]['content'])
        r = ev("JARVIS.reg.exec('add_expense', JSON.stringify({amount: 6, merchant: 'Downtown garage', category: 'parking'}))")
        r = ev("JARVIS.reg.exec('expense_summary', JSON.stringify({period: 'month', export: 'csv'}))")
        c = calls('docSave')
        check('expense summary by category, deductible part, CSV export', '$48.10 this month' in r and 'fuel $42.10' in r and 'parking $6.00' in r and 'usually deduct' in r and c and c[-1][1] == 'csv' and c[-1][3].startswith('date,amount,category'), (r, c[-1:] if c else c))
        r = ev("JARVIS.reg.exec('translate_with_camera', JSON.stringify({language: 'Spanish'}))")
        check('translate a menu through the camera', 'Tacos al pastor' in r and 'translate it into Spanish' in json.dumps(state['vision'][-1]['messages'][-1]['content']), r)
        import cv2, base64 as b64
        qr = cv2.QRCodeEncoder.create().encode('WIFI:T:WPA;S:Cafe Guest;P:sunshine42;;'); qr = cv2.copyMakeBorder(cv2.resize(qr, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST), 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
        url = 'data:image/png;base64,' + b64.b64encode(cv2.imencode('.png', qr)[1].tobytes()).decode()
        txt = ev(f"import('/local/camera.js').then(m => m.qrFromImage({json.dumps(url)}))")
        check('QR codes are decoded on the phone (jsQR)', txt == 'WIFI:T:WPA;S:Cafe Guest;P:sunshine42;;', txt)
        d = ev(f"import('/local/tools_extras.js').then(m => m.describeQr({json.dumps(txt)}).say)")
        check('...and a Wi-Fi code gives the network and password', 'Cafe Guest' in d and 's u n s h i n e 4 2' in d, d)

        # ================================================================== driving helpers
        reset(); ev(f"window.__phone.loc = {{ lat: {A[0]}, lon: {A[1]}, acc: 8, age_s: 3 }}")
        r = ev("JARVIS.reg.exec('remember_parking', JSON.stringify({minutes: 60, note: 'level 3'}))")
        check('"I parked here" saves the spot with the street, and a meter reminder', 'Parking spot saved at 1 Washington St, level 3' in r and "10 minutes before the meter" in r and any(x['text'].startswith('Your parking meter') for x in ev('window.__phone.reminders')), r)
        ev(f"window.__phone.loc = {{ lat: {A[0] + 0.002}, lon: {A[1] + 0.002}, acc: 8, age_s: 3 }}")
        r = ev("JARVIS.reg.exec('find_my_car', '{}')")
        check('"where did I park" gives distance and direction', re.search(r'about \d+ feet south-west of you, at 1 Washington St, level 3', r), r)
        ev(f"window.__phone.loc = {{ lat: {A[0]}, lon: {A[1]}, acc: 8, age_s: 3 }}")
        r = ev("JARVIS.reg.exec('find_gas', '{}')")
        check('nearest gas stations, closest first', r.startswith('Nearest: Shell on 300 Main Street') and 'Circle K' in r, r)
        r = ev("JARVIS.reg.exec('start_shift', '{}')"); check('start a shift', 'Shift started' in r and calls('shiftStart'), r)
        r = ev("JARVIS.reg.exec('end_shift', '{}')")
        check('end of shift: hours, miles, IRS deduction at 76¢', 'Shift done. 4 hours, 80.0 miles' in r and 'worth a $60.80 deduction' in r, r)
        r = ev("JARVIS.reg.exec('mileage_log', JSON.stringify({period: 'week', export: 'csv'}))")
        c = calls('docSave')
        check('mileage log for taxes, with CSV export', '80.0 business miles this week' in r and c[-1][1] == 'csv' and c[-1][3].startswith('date,start,end,miles,purpose,irs_rate,deduction') and '"Delivery driving","0.760","60.80"' in c[-1][3], (r, c[-1][3][:200]))

        # ================================================================== safety
        reset(); r = ev("JARVIS.reg.exec('emergency', '{}')")
        check('SOS with no contacts yet -> dialer with 911', calls('dialEmergency') == [['dialEmergency', '911']] and '911' in r, r)
        r = ev("JARVIS.reg.exec('set_emergency_contact', JSON.stringify({who: 'John'}))")
        check('add an emergency contact from the contacts (and ask to send texts)', 'John Smith is now an emergency contact' in r and ['request', 'sms'] in calls('request'), r)
        r = ev("JARVIS.reg.exec('emergency', JSON.stringify({message: 'car broke down'}))")
        check('SOS without text permission -> message to all contacts opens, with location', "open with your location" in r and any(u.startswith('smsto:+15551234567?body=EMERGENCY') and '33.4484' in unquote(u) for u in ev('window.__native.opened')), (r, ev('window.__native.opened')[-1:]))
        ev("window.__phone.status.sms = true"); reset()
        r = ev("JARVIS.reg.exec('emergency', JSON.stringify({message: 'car broke down'}))")
        c = calls('sosStart')
        check('SOS texts the contacts with location, every 5 minutes', c and c[0][1] == [{'name': 'John Smith', 'number': '+15551234567'}] and c[0][3] == 'car broke down' and 'SOS sent to John Smith' in r and 'call 911' in r, (c, r))
        r = ev("JARVIS.reg.exec('im_safe', '{}')")
        check('"I\'m safe" stops it and tells them', calls('sosStop') and "told John Smith you're safe" in r, r)

        # ================================================================== smart home (Home Assistant on the home network)
        state['ha'] = []
        def ha_handler(route):
            req = route.request; cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}
            if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
            if (req.headers.get('authorization') or '') != 'Bearer ha-token': return route.fulfill(status=401, headers=cors, body='')
            if req.url.endswith('/api/states'):
                return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps([
                    {'entity_id': 'light.bedroom', 'state': 'on', 'attributes': {'friendly_name': 'Bedroom'}},
                    {'entity_id': 'light.living_room', 'state': 'off', 'attributes': {'friendly_name': 'Living Room'}},
                    {'entity_id': 'climate.hallway', 'state': 'heat', 'attributes': {'friendly_name': 'Thermostat', 'temperature': 70, 'current_temperature': 68}},
                    {'entity_id': 'lock.front_door', 'state': 'locked', 'attributes': {'friendly_name': 'Front Door'}},
                    {'entity_id': 'scene.movie_time', 'state': 'scening', 'attributes': {'friendly_name': 'Movie Time'}},
                    {'entity_id': 'sensor.cpu', 'state': '3', 'attributes': {'friendly_name': 'CPU'}}]))
            state['ha'].append((req.url.split('8123')[1], json.loads(req.post_data or '{}')))
            return route.fulfill(status=200, headers=cors, content_type='application/json', body='[]')
        ctx.route('http://192.168.1.50:8123/**', ha_handler)
        r = ev("JARVIS.reg.exec('smart_home_control', JSON.stringify({target: 'bedroom lights', action: 'off'}))")
        check('smart home not set up -> says how', 'Smart home' in r, r)
        ev("JARVIS.config.merge({ha_url: 'http://192.168.1.50:8123/', ha_token: 'ha-token'})")
        r = ev("JARVIS.reg.exec('smart_home_control', JSON.stringify({target: 'bedroom lights', action: 'off'}))")
        check('"turn off the bedroom lights" -> Home Assistant light.turn_off', state['ha'][-1:] == [('/api/services/light/turn_off', {'entity_id': 'light.bedroom'})] and r == 'Bedroom off.', (state['ha'], r))
        r = ev("JARVIS.reg.exec('smart_home_control', JSON.stringify({target: 'living room', action: 'on', brightness: 30, color: 'warm white'}))")
        check('dim to 30 percent, warm white', state['ha'][-1] == ('/api/services/light/turn_on', {'entity_id': 'light.living_room', 'brightness_pct': 30, 'color_temp_kelvin': 2700}), state['ha'][-1])
        r = ev("JARVIS.reg.exec('smart_home_control', JSON.stringify({target: 'thermostat', action: 'set', temperature: 72}))")
        check('thermostat to 72', state['ha'][-1] == ('/api/services/climate/set_temperature', {'entity_id': 'climate.hallway', 'temperature': 72}) and '72 degrees' in r, r)
        r = ev("JARVIS.reg.exec('smart_home_scene', JSON.stringify({name: 'movie'}))")
        check('scenes', state['ha'][-1] == ('/api/services/scene/turn_on', {'entity_id': 'scene.movie_time'}), state['ha'][-1])
        r = ev("JARVIS.reg.exec('smart_home_devices', '{}')")
        check('list devices (noise like CPU sensors left out)', 'Bedroom (light): on' in r and 'Thermostat (climate): 68°, set 70' in r and 'CPU' not in r and 'Movie Time' in r, r)

        # ================================================================== proactive
        reset(); r = ev("JARVIS.reg.exec('set_proactive', JSON.stringify({alert: 'briefing', time: '7:30 am'}))")
        bri = [x for x in ev('window.__phone.reminders') if x['id'] == 'briefing']
        check('"brief me every morning at 7:30" -> a daily alarm', '7:30 AM' in r and bri and bri[0]['kind'] == 'briefing' and bri[0]['repeat'] == 'daily' and ev(f"new Date({bri[0]['at'] if bri else 0}).getHours()") == 7, (r, bri))
        ev("window.__native.tts.length = 0"); pg.wait_for_timeout(1300)
        ev("window.__jvAlarm(JSON.stringify({ id: 'briefing', kind: 'briefing', text: 'Morning briefing' }), false)")
        try: pg.wait_for_function("window.__native.tts.join(' ').match(/Good (morning|afternoon|evening)/)", timeout=8000)
        except Exception: pass
        check('...when it rings, Jarvis speaks the briefing (even in the background)', re.search(r'Good (morning|afternoon|evening)', ev("window.__native.tts.join(' ')")), ev('window.__native.tts'))
        ev("window.__native.tts.length = 0"); pg.wait_for_timeout(1500)
        ev("JARVIS.proactive.resetPacing(); JARVIS.proactive.tick()")
        try: pg.wait_for_function("window.__native.tts.join(' ').includes('Tornado Warning')", timeout=8000)
        except Exception: pass
        check('severe weather where you are is announced', 'Weather alert: Tornado Warning' in ev("window.__native.tts.join(' ')") and 'TAKE COVER NOW' in ev("window.__native.tts.join(' ')"), ev('window.__native.tts'))
        n_nws = state.get('nws', 0); ev("JARVIS.proactive.tick()"); pg.wait_for_timeout(500)
        check('...checked every 20 minutes, not every minute', state.get('nws', 0) == n_nws)
        r = ev("JARVIS.reg.exec('birthdays', '{}')")
        check('birthdays from the contacts', r.startswith('Ada Lovelace turns') and 'today' in r, r)
        r = ev("JARVIS.reg.exec('set_proactive', JSON.stringify({alert: 'weather', on: false}))")
        check('alerts can be turned off by voice', r == 'Off: severe weather alerts.' and ev("JARVIS.config.get('pa_weather')") is False)

        # ================================================================== the new interface
        ev("window.__phone.shift = { active: true, start: Date.now() - (2 * 3600000 + 10 * 60000), meters: 34.2 * 1609.344 }; window.dispatchEvent(new Event('jv-refresh'))"); pg.wait_for_timeout(300)
        txt = ev("document.getElementById('jv-shift').innerText.replace(/\\s+/g, ' ')")
        check('on a shift, the top shows time, miles and earnings', ev("document.body.classList.contains('on-shift')") and '2:10' in txt and '34.2' in txt and 'miles' in txt, txt)
        ev("window.__phone.sos = true; window.dispatchEvent(new Event('jv-refresh'))"); pg.wait_for_timeout(300)
        check('an SOS shows a red banner with "I\'m safe"', ev("document.body.classList.contains('sos-on') && getComputedStyle(document.getElementById('jv-sos')).display === 'flex'"))
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/hud.png'))
        ev("document.querySelector('#jv-sos button').click()"); pg.wait_for_timeout(500)
        check('...tapping it stands the SOS down', not ev("document.body.classList.contains('sos-on')") and calls('sosStop'))
        ev("document.getElementById('state').className = 'thinking'"); pg.wait_for_timeout(100)
        ev("window.dispatchEvent(new CustomEvent('jv-activity', { detail: 'get_weather' }))"); pg.wait_for_timeout(100)
        check('while thinking, the status says what Jarvis is doing', ev("document.getElementById('jv-status').textContent") == 'Checking the weather…', ev("document.getElementById('jv-status').textContent"))
        ev("document.getElementById('state').className = 'standby'"); pg.wait_for_timeout(100)
        ev("window.__phone.shift = null; window.dispatchEvent(new Event('jv-refresh'))")
        ev("JARVIS.openSettings()"); pg.wait_for_timeout(600)
        txt = ev("document.getElementById('jv-ov').textContent")
        check('settings has Smart home, Safety (with John Smith) and Alerts', 'Smart home' in txt and 'Home Assistant token' in txt and 'John Smith' in txt and 'Severe weather where you are' in txt, txt[:100])
        ev("document.getElementById('jv-home-test').click()"); pg.wait_for_timeout(1500)
        hm = ev("document.getElementById('jv-home-msg').className + ' | ' + document.getElementById('jv-home-msg').textContent")
        check('smart home "Test connection" lists the devices', 'ok' in hm.split('|')[0] and 'Bedroom' in hm, hm)
        ev("document.querySelector('#jv-ov input[type=time]').value = '06:45'; [...document.querySelectorAll('#jv-ov select')].find(x => x.options[0].text === 'On' && x.closest('div').textContent.includes('Low battery')).value = 'false'")
        ev("document.querySelector('#jv-ov .pri').click()"); pg.wait_for_timeout(500)
        bri = [x for x in ev('window.__phone.reminders') if x['id'] == 'briefing']
        check('saving Alerts: briefing moves to 6:45, battery warnings off (a real off, not the word "false")', ev("JARVIS.config.get('pa_battery')") is False and ev("JARVIS.config.get('pa_breaks')") is True and bri and ev(f"new Date({bri[0]['at']}).getHours() * 60 + new Date({bri[0]['at']}).getMinutes()") == 405, (ev("JARVIS.config.get('pa_battery')"), bri))

        # faces, like the PC
        reset(); r = ev("JARVIS.reg.exec('who_is_this', '{}')")
        check('"who am I?" before any face is remembered', "haven't been asked to remember anyone" in r, r)
        r = ev("JARVIS.reg.exec('remember_face', JSON.stringify({name: 'Marvelous', title: 'Mr'}))")
        c = calls('faceRemember')
        check('"remember my face": front camera picture -> stored on the phone', c and c[0][1].startswith('data:image/jpeg') and c[0][2:] == ['Marvelous', 'Mr'] and "recognise you as Mr Marvelous" in r, (c, r))
        r = ev("JARVIS.reg.exec('who_is_this', '{}')")
        check('"who am I?" recognises the face', r.startswith("That's Mr Marvelous"), r)
        check('list and forget faces', 'Mr Marvelous' in ev("JARVIS.reg.exec('list_faces', '{}')") and ev("JARVIS.reg.exec('forget_face', JSON.stringify({name: 'marvelous'}))") == 'Forgotten.')

        # phone control: a five-step task in one request (more rounds than the old limit of three)
        reset(); ev("window.__phone.status.control = false")
        said = ask(script(('read_screen', {})), 'Accessibility')
        check('phone control off -> Jarvis opens the setting and says the one step', calls('request') == [['request', 'control']] and 'Jarvis phone control' in said, (calls('request'), said[:200]))
        reset(); ev("window.__phone.status.control = true; window.__phone.status.controlRunning = true"); ev('window.__native.opened.length = 0')
        said = ask(script(('open_app', {'name': 'WhatsApp'}), ('read_screen', {}), ('tap_on_screen', {'target': '2'}), ('type_on_screen', {'text': 'On my way', 'field': '3'}), ('press_button', {'button': 'back'})), 'Done.', timeout=15000)
        seq = [c[0] for c in ev('window.__phone.calls')]
        check('multi-step phone control runs every step in order', 'app:WhatsApp' in ev('window.__native.opened') and seq == ['screenRead', 'screenTap', 'screenType', 'press'], (seq, ev('window.__native.opened')))
        check('...with the right arguments', calls('screenTap')[:1] == [['screenTap', '2', False]] and calls('screenType')[:1] == [['screenType', 'On my way', '3', False]] and calls('press')[:1] == [['press', 'back']], ev('window.__phone.calls'))
        state['vision'] = []
        r = ev("JARVIS.reg.exec('look_at_screen', JSON.stringify({question: 'what app is this?'}))")
        check('"what\'s on my screen" -> screenshot -> vision', state['vision'] and state['vision'][-1]['messages'][-1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,/9j/') and 'coffee mug' in r, r)

        # device
        reset()
        check('flashlight', ev("JARVIS.reg.exec('flashlight', JSON.stringify({state: 'on'}))") == 'Flashlight on.' and calls('flashlight') == [['flashlight', 'on']])
        check('volume', ev("JARVIS.reg.exec('set_volume', JSON.stringify({action: 'set', level: 60}))") == 'Volume 60 percent.' and calls('volume') == [['volume', 'set', 60, 'media']])
        r = ev("JARVIS.reg.exec('do_not_disturb', JSON.stringify({on: true}))")
        check('Do Not Disturb without access -> asks for it', 'Do Not Disturb access' in r and ['request', 'dnd'] in calls('request'), r)
        ev("window.__phone.visible = false"); r = ev("JARVIS.reg.exec('open_settings', JSON.stringify({page: 'wifi'}))")
        check('from the background, opening something becomes a tap-to-open notification', 'notifications' in r and 'Open apps from the background' in r, r); ev("window.__phone.visible = true")

        # people
        reset(); r = ev("JARVIS.reg.exec('phone_call', JSON.stringify({who: 'John'}))")
        check('call by name: contacts lookup, then the dialer (no call permission yet)', calls('call') == [['call', '+15551234567']] and 'John Smith' in r and 'dialer' in r, (calls('call'), r))
        ev("window.__phone.status.calls = true"); r = ev("JARVIS.reg.exec('phone_call', JSON.stringify({who: 'John'}))")
        check('...and calls straight away once allowed', r == 'Calling John Smith.', r)
        r = ev("JARVIS.reg.exec('phone_call', JSON.stringify({who: 'Zelda'}))")
        check('unknown name -> asks for the number', "don't see Zelda" in r, r)
        r = ev("JARVIS.reg.exec('send_text', JSON.stringify({who: 'John', message: 'running late'}))")
        check('text by name opens ready to send', calls('sms') == [['sms', '+15551234567', 'running late']] and 'Tap send' in r, r)
        r = ev("JARVIS.reg.exec('whatsapp_message', JSON.stringify({who: 'John', message: 'hi'}))")
        check('WhatsApp by name', calls('whatsapp') == [['whatsapp', '+15551234567', 'hi']], calls('whatsapp'))
        r = ev("JARVIS.reg.exec('read_notifications', '{}')")
        check('read messages without access -> opens notification access', 'notification access' in r and ['request', 'notifAccess'] in calls('request'), r)
        ev("window.__phone.status.notifAccess = true"); r = ev("JARVIS.reg.exec('read_notifications', '{}')")
        check('read messages', 'John Smith on WhatsApp' in r and 'Where are you?' in r and 'can reply' in r, r)
        r = ev("JARVIS.reg.exec('reply_to_message', JSON.stringify({who: 'John', message: 'On my way'}))")
        check('reply through the notification', calls('replyTo') == [['replyTo', 'John', 'On my way']] and 'Sent' in r, r)

        # calendar, clipboard, documents
        reset(); r = ev("JARVIS.reg.exec('add_calendar_event', JSON.stringify({title: 'Dentist', start: '%s', duration_minutes: 30}))" % iso.replace('08:00', '15:00'))
        c = calls('calendarAdd')
        check('add a calendar event at the local time', c and c[0][1] == 'Dentist' and c[0][2] == tomorrow8 + 7 * 3600000 and c[0][3] == tomorrow8 + 7 * 3600000 + 1800000 and 'Dentist' in r, (c, r))
        r = ev("JARVIS.reg.exec('get_calendar', JSON.stringify({day: 'tomorrow'}))")
        check("what's on tomorrow", 'Dentist at 3:00 PM' in r, r)
        check('clipboard', 'copied text' in ev("JARVIS.reg.exec('get_clipboard', '{}')") and ev("JARVIS.reg.exec('copy_to_clipboard', JSON.stringify({text: 'abc'}))") == 'Copied.' and ev('window.__phone.clip') == 'abc')
        r = ev("JARVIS.reg.exec('create_document', JSON.stringify({kind: 'pdf', title: 'Shift notes', content: 'Line one.\\nLine two.'}))")
        check('create a PDF document', calls('docSave') == [['docSave', 'pdf', 'Shift notes', 'Line one.\nLine two.']] and 'Saved' in r, r)
        r = ev("JARVIS.reg.exec('open_document', JSON.stringify({name: 'it', share: true}))")
        check('share the last document', calls('docOpen') and calls('docOpen')[0][3] is True, calls('docOpen'))

        # new-message announcements: short, from the native wording; nothing for updates
        ev("JARVIS.config.set('announce_messages', true); window.__native.tts.length = 0")
        ev("""window.__jvMessage(JSON.stringify({ app: 'Snapchat', title: 'Valerie🍒', text: 'sent you a voice note', message: true, spoken: 'Valerie sent you a voice note on Snapchat.' }), true)"""); pg.wait_for_timeout(1800)
        said = ev("window.__native.tts.join(' ')")
        check('a new message is announced in a few words ("Valerie sent you a voice note on Snapchat.")', 'Valerie sent you a voice note on Snapchat' in said and 'Message from' not in said, said[:160])
        ev("window.__native.tts.length = 0; window.__jvMessage(JSON.stringify({ app: 'WhatsApp', title: 'WhatsApp', text: '3 new messages', message: true }), true)"); pg.wait_for_timeout(900)
        check('...and nothing is said for a notification Android marks as not worth saying', ev("window.__native.tts.join(' ')") == '', ev("window.__native.tts"))
        ev("JARVIS.config.set('announce_messages', false)")
        # learning: lasting facts the user mentions are remembered by themselves
        ev("JARVIS.config.set('learn', true)"); state['learn'] = []
        said = ask('My sister Ada lives in Abuja', 'Hello'); pg.wait_for_timeout(1500)
        facts = ev("(() => { try { return JARVIS.brain.conversation[0].content; } catch (e) { return ''; } })()")
        check('Jarvis learns lasting facts from conversation (asked the small model, fact now in what he knows)', len(state['learn']) == 1 and state['learn'][0]['model'] == 'openai/gpt-oss-20b' and "sister Ada lives in Abuja" in facts, (len(state['learn']), facts[-300:]))
        n0 = len(state['learn']); ask('turn on my flashlight', 'Flashlight'); pg.wait_for_timeout(600)
        check('...but not from commands ("turn on my flashlight")', len(state['learn']) == n0)
        ev("JARVIS.config.set('learn', false)")

        # settings: phone powers
        ev("JARVIS.openSettings()"); pg.wait_for_timeout(700)
        rows = ev("[...document.querySelectorAll('#jv-powers .pw:not([data-extra])')].map(r => [r.querySelector('b').textContent, r.querySelector('.pw-st').textContent, getComputedStyle(r.querySelector('button')).display !== 'none'])")
        check('settings lists the phone powers with on/off (incl. talk from anywhere)', len(rows) == 13 and ['Talk from anywhere', 'Off', True] in rows and ['Offer reader', 'Off', True] in rows and ['Camera', 'On', False] in rows and ['Phone control', 'On', False] in rows and ['Brightness', 'Off', True] in rows, rows)
        reset(); ev("document.querySelector('#jv-powers button[data-power=overlay]').click()")
        check('"Allow" asks Android for it', calls('request') == [['request', 'overlay']], calls('request'))
        ev("document.getElementById('jv-widget').click()")
        check('"Add the Jarvis widget" asks the home screen to place it', ev("window.__native.pinned") == 1 and 'tap Add' in ev("document.querySelector('[data-extra=widget]').textContent"))
        ev("window.__phone.loc = { lat: 9.0765, lon: 7.3986, acc: 40, age_s: 12 }; document.getElementById('jv-loccheck').click()"); pg.wait_for_timeout(1500)
        lc = ev("document.getElementById('jv-loccheck').parentElement.parentElement.textContent")
        check('"Check my location" shows what Jarvis says and what Android reports', 'Jarvis says' in lc and 'approximate' in lc and 'fused' in lc and '40 m' in lc, lc)
        ev("document.getElementById('jv-powers').scrollIntoView()"); pg.wait_for_timeout(200)
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/powers.png'))
        ev("document.querySelector('#jv-ov .bar button').click()"); pg.wait_for_timeout(200)

        # ---- rollout mode: no key on the phone, the build points at the Jarvis proxy
        state['proxy'] = []
        def proxy_handler(route):
            req = route.request; state['proxy'].append({'url': req.url, 'h': dict(req.headers)})
            if req.url.endswith('/models'): return route.fulfill(status=200, body='{"data":[]}')
            if req.url.endswith('/update'): return route.fulfill(status=200, body='{"build":52,"size":70000000,"parts":3}')
            return route.fulfill(status=200, headers={'Content-Type': 'text/event-stream'}, body=sse([delta(content='Proxy mode works. '), delta(content='No key needed.')]))
        ctx2 = b.new_context(viewport={'width': 412, 'height': 860}, is_mobile=True, has_touch=True)
        ctx2.add_init_script(BRIDGE)
        def asset2(route):
            if route.request.url.endswith('/local/build_config.js'):
                return route.fulfill(status=200, content_type='text/javascript', body="export const BUILD = { apiBase: 'https://jarvis-proxy.example.workers.dev/v1', appToken: 'tok123' };")
            return asset_handler(route)
        ctx2.route(ORIGIN + '/**', asset2); ctx2.route('https://jarvis-proxy.example.workers.dev/**', proxy_handler)
        ctx2.route(re.compile(r'https://(?!appassets|jarvis-proxy).*'), other_handler)
        p2 = ctx2.new_page(); p2.goto(ORIGIN + '/index.html'); p2.wait_for_function('window.JARVIS && window.JARVIS.config', timeout=15000); p2.wait_for_timeout(800)
        cv = p2.evaluate("window.__native.cloud")
        check('proxy build: the natural voice goes through the Jarvis service with its token (Daniel for the male face)', cv and cv[0] == 'https://jarvis-proxy.example.workers.dev/v1/audio/speech' and cv[1].get('X-Jarvis-Token') == 'tok123' and cv[2] == 'daniel', cv)
        check('proxy build: settings does not demand a key', p2.evaluate("!document.getElementById('jv-ov').classList.contains('on')") and p2.evaluate("JARVIS.api.mode()") == 'proxy')
        # ---- first run: the setup walkthrough opens by itself and takes the permissions one at a time
        p2.wait_for_selector('#jv-setup.on', timeout=5000)
        q = lambda sel: p2.evaluate(f"document.querySelector('#jv-setup {sel}').textContent")
        check('first run: setup walkthrough opens by itself, starting with the basics', q('.card h2') == 'Hear, see and help', q('.card h2'))
        p2.screenshot(path=os.path.join(ROOT, 'tests/e2e/setup.png'))
        p2.click('#jv-setup .go')
        check('"Allow" asks Android for all the ordinary permissions at once', ['request', 'basics'] in p2.evaluate('window.__phone.calls'))
        p2.evaluate("Object.assign(window.__phone.status, { mic: true, location: true, notifications: true, camera: true, contacts: true, calls: true, sms: true, calendar: true }); window.__jvPerm()"); p2.wait_for_timeout(900)
        check('when Android answers, it moves on to reading messages', q('.card h2') == 'Read and announce your messages', q('.card h2'))
        p2.click('#jv-setup .go'); p2.evaluate("window.__phone.status.restricted = true; window.dispatchEvent(new Event('focus'))"); p2.wait_for_timeout(700)
        check('it opens the exact settings page (notification access)', ['request', 'notifAccess'] in p2.evaluate('window.__phone.calls'))
        check('back without switching it on: explains Android\'s "restricted setting" and how to allow it', 'installed from a file' in q('.note') and 'Allow restricted settings' in q('.note') and p2.evaluate("document.querySelector('#jv-setup .note').classList.contains('on')"), q('.note'))
        p2.click('#jv-setup .note .info'); check('...with a button to Jarvis\'s App info', ['request', 'appInfo'] in p2.evaluate('window.__phone.calls'))
        p2.click('#jv-setup .go'); p2.evaluate("window.__phone.status.notifAccess = true; window.__phone.status.restricted = false; window.dispatchEvent(new Event('focus'))"); p2.wait_for_timeout(700)
        check('switched on -> next: phone control', q('.card h2') == 'Phone control' and 'on' in q('.state'), (q('.card h2'), q('.state')))
        p2.click('#jv-setup .go'); check('phone control opens its own page', ['request', 'control'] in p2.evaluate('window.__phone.calls'))
        p2.evaluate("window.__phone.status.control = true; window.dispatchEvent(new Event('focus'))"); p2.wait_for_timeout(700)
        check('then the offer reader, marked optional, with Skip', q('.card h2') == 'Offer reader (for drivers) (optional)', q('.card h2'))
        p2.click('#jv-setup .skip'); p2.wait_for_timeout(200)
        check('skipping moves on', q('.card h2') == 'Open apps for you', q('.card h2'))
        p2.click('#jv-setup .done'); p2.wait_for_timeout(200)
        check('"finish later" closes it and it won\'t nag on every start', not p2.evaluate("document.getElementById('jv-setup').classList.contains('on')") and p2.evaluate("JARVIS.config.get('setup_v1')") is True)
        p2.evaluate("JARVIS.openSettings()"); p2.wait_for_timeout(300); p2.click('#jv-ov .mi[data-go=powers]'); p2.wait_for_timeout(200); p2.click('#jv-setup-again'); p2.wait_for_timeout(300)
        check('Settings has "Set up permissions, step by step" to come back to it', p2.evaluate("document.getElementById('jv-setup').classList.contains('on')") and not p2.evaluate("document.getElementById('jv-ov').classList.contains('on')"))
        p2.click('#jv-setup .done'); p2.wait_for_timeout(200)
        p2.evaluate("JARVIS.openSettings()"); p2.wait_for_timeout(200)
        menu = p2.evaluate("[...document.querySelectorAll('#jv-ov .mi')].map(b => b.textContent)")
        check('settings opens on a menu of sections, Brain says it is connected', any(m.startswith('BrainConnected to the Jarvis service') for m in menu) and len(menu) >= 9, menu)
        p2.click('#jv-ov .mi[data-go=brain]'); p2.wait_for_timeout(200)
        check('a section opens as its own page, with a back button and its title', p2.evaluate("document.querySelector('#jv-ov .bar .t').textContent") == 'Brain' and p2.evaluate("getComputedStyle(document.querySelector('#jv-ov .bar .back')).display") != 'none')
        sv = p2.evaluate("""(() => { const b = document.getElementById('jv-brain'), adv = document.querySelector('#jv-ov .page[data-id=advanced]');
          return { brainInputs: b.querySelectorAll('input[type=password]').length, brainText: b.textContent,
                   advKey: [...adv.querySelectorAll('input')].some(i => i._key === 'groq_key'), advOpen: adv.classList.contains('on'),
                   visibleKey: [...document.querySelectorAll('#jv-ov input[type=password]')].filter(i => i._key === 'groq_key' && i.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })).map(i => i.closest('section').firstChild.textContent) }; })()""")
        check('proxy build: settings shows "no key needed" and no key field', sv['brainInputs'] == 0 and 'No key' in sv['brainText'] and not sv['visibleKey'], sv)
        check('proxy build: optional own key lives under Advanced (closed)', sv['advKey'] and not sv['advOpen'], sv)
        p2.click('#jv-test'); p2.wait_for_function("document.querySelector('#jv-ov .msg.ok')", timeout=5000)
        check('proxy build: Test connection checks the service', 'Jarvis service' in p2.evaluate("document.querySelector('#jv-ov .msg.ok').textContent"))
        p2.evaluate("document.querySelector('#jv-ov .bar button').click()"); p2.wait_for_timeout(200)
        check('proxy build: closing settings stores no key', not p2.evaluate("JARVIS.config.get('groq_key')"))
        # ---- updates: the service says build 52 is out; this phone has build 50
        p2.evaluate("JARVIS.openSettings('update')"); p2.wait_for_timeout(200)
        up = lambda: p2.evaluate("[document.querySelector('#jv-update-btn').textContent, document.querySelector('#jv-update-btn').closest('section').querySelector('p[aria-live]').textContent]")
        check('Settings > Updates shows this build and a check button', up() == ['Check for updates', 'You have build 50.'], up())
        p2.click('#jv-update-btn'); p2.wait_for_function("document.querySelector('#jv-update-btn').textContent === 'Update now'", timeout=5000)
        check('checking finds build 52 (asked the Jarvis service)', 'Build 52 is ready. You have build 50.' == up()[1] and any(x['url'].endswith('/v1/update') for x in state['proxy']), up())
        p2.click('#jv-update-btn'); p2.wait_for_timeout(200)
        check('"Update now" downloads it from the service with the app token, its exact size and parts', p2.evaluate("window.__native.update") == ['https://jarvis-proxy.example.workers.dev/v1/update/apk', 'tok123', 70000000, 3] and 'Downloading build 52' in up()[1], (p2.evaluate("window.__native.update"), up()))
        p2.evaluate("window.__jvUpdate(JSON.stringify({ state: 'downloading', percent: 45 }))")
        check('...showing progress', 'Downloading build 52… 45%' == up()[1] and p2.evaluate("document.querySelector('#jv-update-btn').disabled"), up())
        p2.evaluate("window.__jvUpdate(JSON.stringify({ state: 'confirm' }))")
        check('...then says to tap Update on Android\'s screen', 'Tap Update on Android' in up()[1], up())
        p2.evaluate("window.__jvUpdate(JSON.stringify({ state: 'failed', error: 'cancelled' }))")
        check('cancelled: offers to try again', up() == ['Try again', "The update didn't finish. Try again on Wi-Fi."], up())
        p2.evaluate("document.querySelector('#jv-ov .bar button').click()"); p2.wait_for_timeout(200)
        p2.wait_for_function("document.getElementById('log').textContent.includes('Jarvis online')", timeout=8000)
        p2.evaluate("JARVIS.wake()"); p2.wait_for_timeout(300); p2.evaluate("JARVIS.say('tell me a fact about owls')")
        p2.wait_for_function("window.__native.tts.join(' ').includes('No key needed')", timeout=8000)
        pc = [x for x in state['proxy'] if 'chat/completions' in x['url']]
        check('proxy build: answers with no key, sends app token and device id, never a Groq key',
              pc and pc[0]['h'].get('x-jarvis-token') == 'tok123' and len(pc[0]['h'].get('x-jarvis-device', '')) == 24 and 'authorization' not in pc[0]['h'], pc[:1])
        ctx2.close()

        # ---- the same page on iPhone (the iOS app sets window.JARVIS_IOS and gives the same two bridge objects)
        ctx3 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        ctx3.add_init_script('window.JARVIS_IOS = true;'); ctx3.add_init_script(BRIDGE)
        ctx3.route(ORIGIN + '/**', asset_handler); ctx3.route(re.compile(r'https://(?!appassets).*'), other_handler)
        p3 = ctx3.new_page(); p3.goto(ORIGIN + '/index.html'); p3.wait_for_function('window.JARVIS && window.JARVIS.config', timeout=15000); p3.wait_for_timeout(600)
        gone = p3.evaluate("['read_screen','read_notifications','set_volume','do_not_disturb','screen_offer','press_button'].filter(n => JARVIS.reg.has(n))")
        check('iPhone: tools Apple forbids are not offered to the AI', not gone and p3.evaluate("JARVIS.reg.has('flashlight') && JARVIS.reg.has('navigate_to') && JARVIS.reg.has('create_document')"), gone)
        check('iPhone: Jarvis is told what an iPhone app cannot do', 'THIS PHONE IS AN IPHONE' in p3.evaluate("JARVIS.brain.conversation[0].content") and "user's Android" not in p3.evaluate("JARVIS.brain.conversation[0].content"))
        p3.evaluate("JARVIS.openSettings()"); p3.wait_for_timeout(500)
        rows3 = p3.evaluate("[...document.querySelectorAll('#jv-powers .pw b')].map(b => b.textContent)")
        check('iPhone: settings list only the permissions an iPhone has', sorted(rows3) == sorted(['Notifications', 'Camera', 'Contacts', 'Calendar', 'Microphone', 'Location']) and 'Android' not in p3.evaluate("document.getElementById('jv-powers').textContent"), rows3)
        p3.evaluate("document.querySelector('#jv-ov .bar button').click()"); p3.wait_for_timeout(200)
        p3.evaluate("Object.assign(window.__phone.status, { calls: false }); JARVIS.setup.open(true)"); p3.wait_for_timeout(300)
        n3 = p3.evaluate("document.querySelectorAll('#jv-setup .dots i').length")
        check('iPhone: setup walkthrough has just the one step (the ordinary questions)', n3 == 1 and 'iPhone' in p3.evaluate("document.querySelector('#jv-setup .why').textContent"), n3)
        ctx3.close()

        bad = [e for e in errs if 'three' not in e.lower()]
        check('no uncaught page errors', not bad, bad[:3])
        if logs: print('console warnings/errors:', [l[:120] for l in logs[:6]])
        b.close()
    print('FAILURES:', fails); sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
