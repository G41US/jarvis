#!/usr/bin/env python3
"""End-to-end test of the phone page: real patched index.html + real on-device JS, with a fake Android bridge, a stand-in for three.js,
and mocked Groq / map services. Run:  python3 tests/e2e/e2e.py   (needs playwright + chromium)"""
import json, os, re, sys, time
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
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'choices': [{'message': {'role': 'assistant', 'content': 'summary'}}]}))
    last = msgs[-1]
    if last['role'] == 'tool':
        txt = "That's " + re.sub(r'[^0-9.]', '', last['content']) + '.' if last['name'] == 'calculate' else 'Done. ' + last['content'][:200]
        chunks = [delta(content=txt[:8]), delta(content=txt[8:])]
    else:
        u = (last.get('content') or '').lower()
        if 'times' in u:
            chunks = [delta(tool_calls=[{'index': 0, 'id': 'c1', 'type': 'function', 'function': {'name': 'calculate', 'arguments': '{"expression":'}}]),
                      delta(tool_calls=[{'index': 0, 'function': {'arguments': '"12*12"}'}}])]
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
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(nominatim(unquote_plus(q.group(1)) if q else '')))
    if 'nominatim' in url and '/reverse' in url:
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps({'lat': str(A[0]), 'lon': str(A[1]), 'display_name': '1 Washington St, Phoenix, Arizona', 'address': {'house_number': '1', 'road': 'Washington St', 'city': 'Phoenix', 'state': 'Arizona', 'country_code': 'us'}}))
    if 'valhalla' in url: return route.fulfill(status=200, headers=cors, content_type='application/json', body='{"error":"x"}')
    if 'routing.openstreetmap.de' in url or 'router.project-osrm.org' in url:
        if '/table/' in url: return route.fulfill(status=400, headers=cors, body='{}')
        return route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(OSRM))
    if 'photon' in url: return route.fulfill(status=200, headers=cors, content_type='application/json', body='{"features":[]}')
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
  window.__native = { pcDownloads: [], pcUse: [], listen: [], tts: [], ttsPitch: [], opened: [], stopped: 0, http: [], streams: [], media: [], voice: null, listening: [], speaking: [], tones: 0, mic: 0 };
  window.__fakeVoices = [{ id: 'en-us-x-iom-local', label: 'English US', lang: 'en-US' }, { id: 'en-us-x-tpf-local', label: 'English US', lang: 'en-US' },
                         { id: 'en-gb-x-gbb-local', label: 'English UK', lang: 'en-GB' }, { id: 'en-us-x-sfg-network', label: 'English US', lang: 'en-US' }];
  window.AndroidBridge = {
    httpRequest(id, method, url, headersJson, body, timeoutMs) {
      window.__native.http.push({ method, url, ua: (JSON.parse(headersJson || '{}')['User-Agent'] || '') });
      of(url, { method, body: body || undefined }).then(async r => window.__httpResult(id, r.status, await r.text())).catch(() => window.__httpResult(id, 0, ''));
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
    ttsVoices() { return JSON.stringify(window.__fakeVoices); },
    ttsSetVoice(v) { window.__native.voice = v; },
    openUrl(u) { window.__native.opened.push(u); },
    openApp(n) { window.__native.opened.push('app:' + n); return 'ok'; },
    media(a, q, p) { window.__native.media.push([a, q, p]); return 'ok'; },
    battery() { return JSON.stringify({ level: 77, charging: false, network: 'wifi' }); },
    micStart() { window.__native.mic++; setTimeout(() => window.__jvMic && window.__jvMic('listening'), 10); return 'ok'; },
    micStatus() { return JSON.stringify({ running: true, wake: true, wakeError: '', permission: true }); },
    setListening(on) { window.__native.listening.push(on); }, setSpeaking(on) { window.__native.speaking.push(on); },
    listen(on, pre) { window.__native.listening.push(on); window.__native.listen.push({ on, pre, t: performance.now() }); },
    setMuted(on) {}, setWakeThreshold(t) { window.__native.threshold = t; },
    tone(f, ms, v) { window.__native.tones++; },
    pcVoices() { return JSON.stringify(window.__pc); },
    pcVoiceDownload(n) { window.__native.pcDownloads.push(n); window.__pc[n] = 'downloading:40'; window.__jvVoices(JSON.stringify(window.__pc));
      setTimeout(() => { window.__pc[n] = 'ready'; window.__jvVoices(JSON.stringify(window.__pc)); }, 300); },
    pcVoiceUse(n) { window.__native.pcUse.push(n); window.__pc.active = n; },
    unmetered() { return !!window.__wifi; },
  };
})();
"""

def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 412, 'height': 860}, permissions=['microphone', 'geolocation'], geolocation={'latitude': A[0], 'longitude': A[1]}, is_mobile=True, has_touch=True)
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

        # ---- first run: settings opens by itself, key test works
        pg.wait_for_selector('#jv-ov.on', timeout=5000)
        check('settings opens on first run', True)
        pg.fill('#jv-ov input[type=password] >> nth=0', 'gsk_bad'); pg.click('#jv-test'); pg.wait_for_function("document.querySelector('#jv-ov .msg').textContent.includes('rejected')", timeout=5000)
        check('bad key is reported', True)
        pg.fill('#jv-ov input[type=password] >> nth=0', 'gsk_good'); pg.click('#jv-test'); pg.wait_for_function("document.querySelector('#jv-ov .msg').textContent.includes('Key works')", timeout=5000)
        check('good key verified', True)
        pg.fill('#jv-ov input[type=text] >> nth=0', 'Marcus')
        pg.click('#jv-ov .pri'); pg.wait_for_function("!document.querySelector('#jv-ov').classList.contains('on')", timeout=3000)
        check('settings saved + closed', ev("JARVIS.config.get('groq_key')") == 'gsk_good' and ev("JARVIS.config.get('user_name')") == 'Marcus')

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
        check('Groq request had tools + system prompt', sent and len(sent[0]['tools']) > 20 and sent[0]['messages'][0]['role'] == 'system')

        # ---- plain chat
        ev("window.__native.tts.length=0"); pg.wait_for_timeout(1500)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('how are you doing today')")
        pg.wait_for_function("window.__native.tts.join(' ').includes('All systems')", timeout=8000)
        check('plain streamed reply spoken in sentences', True)

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
        pg.wait_for_function("window.__ws.some(m=>m.startsWith('nav:'))", timeout=15000)
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

        # ---- new phone UI
        check('status pill shows plain-language state', ev("document.querySelector('#jv-status').textContent") in ('Say “Hey Jarvis”', 'Listening', 'Speaking', 'Thinking…'), ev("document.querySelector('#jv-status').textContent"))
        check('caption shows Jarvis\'s last reply', len(ev("document.querySelector('#jv-cap .him').textContent") + ev("document.querySelector('#jv-cap .you').textContent")) > 0)
        ev("document.getElementById('jv-hist').click()"); check('history sheet opens', ev("document.body.classList.contains('jv-history')")); ev("document.getElementById('jv-hist').click()")
        ev("document.getElementById('jv-mute').click()"); pg.wait_for_timeout(200)
        check('mute button mutes', ev("window.__jv.state().muted") is True and ev("document.querySelector('#jv-status').textContent") == 'Muted')
        ev("document.getElementById('jv-mute').click()"); pg.wait_for_timeout(200)
        ev("JARVIS.openSettings()"); pg.wait_for_timeout(400); pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/settings.png'))
        check('settings open pauses the 3D face', ev("window.__jvPaused === true && getComputedStyle(document.getElementById('three')).visibility === 'hidden'"))
        check('settings: hearing panel shows mic on', 'On' in ev("document.getElementById('jv-diag').textContent"), ev("document.getElementById('jv-diag').textContent")[:200])
        ev("document.querySelector('#jv-ov .bar button').click()"); pg.wait_for_timeout(200)
        check('closing settings resumes the face', ev("window.__jvPaused === false && getComputedStyle(document.getElementById('three')).visibility === 'visible'"))

        # ---- layout on a phone
        w = ev("[document.documentElement.scrollWidth, innerWidth]")
        check('no horizontal scroll', w[0] <= w[1], w)
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/phone.png'))

        # ---- rollout mode: no key on the phone, the build points at the Jarvis proxy
        state['proxy'] = []
        def proxy_handler(route):
            req = route.request; state['proxy'].append({'url': req.url, 'h': dict(req.headers)})
            if req.url.endswith('/models'): return route.fulfill(status=200, body='{"data":[]}')
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
        check('proxy build: settings does not demand a key', p2.evaluate("!document.getElementById('jv-ov').classList.contains('on')") and p2.evaluate("JARVIS.api.mode()") == 'proxy')
        p2.wait_for_function("document.getElementById('log').textContent.includes('Jarvis online')", timeout=8000)
        p2.evaluate("JARVIS.wake()"); p2.wait_for_timeout(300); p2.evaluate("JARVIS.say('tell me a fact about owls')")
        p2.wait_for_function("window.__native.tts.join(' ').includes('No key needed')", timeout=8000)
        pc = [x for x in state['proxy'] if 'chat/completions' in x['url']]
        check('proxy build: answers with no key, sends app token and device id, never a Groq key',
              pc and pc[0]['h'].get('x-jarvis-token') == 'tok123' and len(pc[0]['h'].get('x-jarvis-device', '')) == 24 and 'authorization' not in pc[0]['h'], pc[:1])
        ctx2.close()

        bad = [e for e in errs if 'three' not in e.lower()]
        check('no uncaught page errors', not bad, bad[:3])
        if logs: print('console warnings/errors:', [l[:120] for l in logs[:6]])
        b.close()
    print('FAILURES:', fails); sys.exit(1 if fails else 0)

main()
