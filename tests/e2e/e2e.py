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

def groq_handler(route):
    req = route.request; url = req.url
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'}
    if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
    if url.endswith('/models'):
        ok = 'Bearer gsk_good' in (req.headers.get('authorization') or '')
        return route.fulfill(status=200 if ok else 401, headers=cors, body='{"data":[]}')
    if 'audio/transcriptions' in url:
        if 'Bearer gsk_good' not in (req.headers.get('authorization') or ''): return route.fulfill(status=401, headers=cors, content_type='application/json', body='{"error":{"message":"Invalid API Key"}}')
        state['stt_calls'] += 1
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
  window.__native = { tts: [], opened: [], stopped: 0, http: [], media: [], voice: null };
  window.AndroidBridge = {
    httpRequest(id, method, url, headersJson, body, timeoutMs) {
      window.__native.http.push({ method, url, ua: (JSON.parse(headersJson || '{}')['User-Agent'] || '') });
      of(url, { method, body: body || undefined }).then(async r => window.__httpResult(id, r.status, await r.text())).catch(() => window.__httpResult(id, 0, ''));
    },
    ttsSpeak(id, text, rate, pitch) { window.__native.tts.push(text); setTimeout(() => window.__ttsEvent(id, 'done'), 15); },
    ttsStop() { window.__native.stopped++; },
    ttsVoices() { return JSON.stringify([{ id: 'en-us-x-iom-local', label: 'English US male', lang: 'en-US' }, { id: 'en-gb-x-gba-local', label: 'English UK', lang: 'en-GB' }]); },
    ttsSetVoice(v) { window.__native.voice = v; },
    openUrl(u) { window.__native.opened.push(u); },
    openApp(n) { window.__native.opened.push('app:' + n); return 'ok'; },
    media(a, q, p) { window.__native.media.push([a, q, p]); return 'ok'; },
    battery() { return JSON.stringify({ level: 77, charging: false, network: 'wifi' }); },
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
        check('voices endpoint lists android voices', len(ev("fetch('/voices').then(r=>r.json())")) == 2)
        check('set_voice endpoint', ev("fetch('/set_voice',{method:'POST',body:JSON.stringify({voice:'UK'})}).then(r=>r.json()).then(j=>j.ok)") is True and ev('window.__native.voice') == 'en-gb-x-gba-local')

        # ---- chat with a tool call, spoken through Android TTS
        ev("window.__native.tts.length=0")
        ev("JARVIS.wake()"); pg.wait_for_timeout(300)
        ev("JARVIS.say('what is 12 times 12')")
        pg.wait_for_function("window.__native.tts.join(' ').includes('144')", timeout=8000)
        check('tool call (calculate) -> spoken "144"', True)
        check('log shows exchange', 'times 12' in ev("document.getElementById('log').textContent"))
        sent = [c for c in state['groq_calls'] if c.get('stream')]
        check('Groq request had tools + system prompt', sent and len(sent[0]['tools']) > 20 and sent[0]['messages'][0]['role'] == 'system')

        # ---- plain chat
        ev("window.__native.tts.length=0"); pg.wait_for_timeout(1500)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('how are you doing today')")
        pg.wait_for_function("window.__native.tts.join(' ').includes('All systems')", timeout=8000)
        check('plain streamed reply spoken in sentences', True)

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

        # ---- speech in: PCM -> VAD -> Whisper (mock) -> page
        state['stt_calls'] = 0; state['stt_text'] = 'Hey Jarvis'
        ev("""(()=>{ const s=[]; const f=(n,a)=>{const x=new Int16Array(n); for(let i=0;i<n;i++) x[i]=Math.round(a*Math.sin(i/7)*(1+Math.sin(i/300))); return x;};
          for(let i=0;i<6;i++) JARVIS.stt.feed(f(2048,60));          // noise floor
          for(let i=0;i<20;i++) JARVIS.stt.feed(f(2048,6000));        // speech
          for(let i=0;i<10;i++) JARVIS.stt.feed(f(2048,40)); })()""")
        pg.wait_for_function('1', timeout=100); pg.wait_for_timeout(2500)
        check('VAD sent one clip to Whisper', state['stt_calls'] >= 1, state['stt_calls'])

        # ---- a rejected key is spoken, not swallowed
        ev("JARVIS.config.set('groq_key','gsk_bad')"); ev("window.__native.tts.length=0"); pg.wait_for_timeout(1200)
        ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('how are you doing today')")
        pg.wait_for_function("window.__native.tts.join(' ').toLowerCase().includes('key')", timeout=8000)
        check('rejected key is spoken', True)
        ev("JARVIS.config.set('groq_key','gsk_good')")

        # ---- hung-up behaviours
        ev("speechSynthesis.cancel()"); check('tts cancel reaches native', ev('window.__native.stopped') >= 1)
        ev("JARVIS.speakTest('hi')"); pg.wait_for_timeout(100); check('speakTest goes to native', 'hi' in ev('window.__native.tts'))

        # ---- layout on a phone
        w = ev("[document.documentElement.scrollWidth, innerWidth]")
        check('no horizontal scroll', w[0] <= w[1], w)
        pg.screenshot(path=os.path.join(ROOT, 'tests/e2e/phone.png'))

        bad = [e for e in errs if 'three' not in e.lower()]
        check('no uncaught page errors', not bad, bad[:3])
        if logs: print('console warnings/errors:', [l[:120] for l in logs[:6]])
        b.close()
    print('FAILURES:', fails); sys.exit(1 if fails else 0)

main()
