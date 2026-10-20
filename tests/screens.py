#!/usr/bin/env python3
"""Screenshots of every main screen of the phone app, for design review. Uses the real page, the real three.js face and the
real map (tiles from the internet), with the e2e test's fake Android bridge and fake AI.
  python3 tests/screens.py <vendor dir with three/ and maplibre/> <output dir> [width height]"""
import json, os, re, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e'))
import e2e
from playwright.sync_api import sync_playwright

VENDOR, OUT = sys.argv[1], sys.argv[2]
W, H = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (360, 800)
os.makedirs(OUT, exist_ok=True)

def assets(route):
    path = re.sub(r'^https://appassets\.androidplatform\.net', '', route.request.url).split('?')[0].split('#')[0] or '/index.html'
    if path.startswith('/vendor/') and not path.startswith('/vendor/jsqr'):
        f = os.path.join(VENDOR, path[len('/vendor/'):])
        if not os.path.isfile(f): return route.fulfill(status=404, body='nf')
        ct = 'text/css' if f.endswith('.css') else 'text/javascript'
        return route.fulfill(status=200, body=open(f, 'rb').read(), content_type=ct)
    f = os.path.join(e2e.WWW, path.lstrip('/'))
    if f.endswith('.glb') and os.path.isfile(f): return route.fulfill(status=200, body=open(f, 'rb').read(), content_type='model/gltf-binary')
    return e2e.asset_handler(route)

import ssl, urllib.request
_ctx = ssl.create_default_context(cafile=os.environ.get('REQUESTS_CA_BUNDLE') or os.environ.get('SSL_CERT_FILE') or None)
_cache = {}
def other(route):
    url = route.request.url
    if 'openfreemap' in url:                                          # real map tiles, fetched here (through this machine's proxy, TLS checked)
        try:
            if url not in _cache:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'jarvis-screens'}), context=_ctx, timeout=20) as r:
                    _cache[url] = (r.status, r.read(), r.headers.get('Content-Type', 'application/octet-stream'))
            st, body, ct = _cache[url]
            return route.fulfill(status=st, body=body, content_type=ct, headers={'Access-Control-Allow-Origin': '*'})
        except Exception as e:
            return route.fulfill(status=502, body=str(e))
    return e2e.other_handler(route)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
                                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=2, permissions=['microphone', 'camera', 'geolocation'],
                        geolocation={'latitude': e2e.A[0], 'longitude': e2e.A[1]}, is_mobile=True, has_touch=True)
    ctx.add_init_script(e2e.BRIDGE)
    ctx.route(e2e.ORIGIN + '/**', assets)
    ctx.route('https://api.groq.com/**', e2e.groq_handler)
    ctx.route(re.compile(r'https://(?!appassets|api\.groq).*'), other)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' or '[NAV]' in m.text else None)
    pg.goto(e2e.ORIGIN + '/index.html')
    pg.wait_for_function('window.JARVIS && window.JARVIS.config', timeout=20000)
    ev = pg.evaluate
    ev('JARVIS.proactive.stop()')
    shot = lambda name: (pg.wait_for_timeout(500), pg.screenshot(path=os.path.join(OUT, name + '.png')))

    # first run: settings (no key yet)
    try: pg.wait_for_selector('#jv-ov.on', timeout=6000)
    except Exception: pass
    shot('01-settings-first-run')
    ev("JARVIS.config.set('groq_key', 'gsk_good'); JARVIS.config.set('learn', false); JARVIS.config.set('user_name', 'Marvelous')")
    ev("document.querySelector('#jv-ov .bar .x').click(); JARVIS.openSettings()"); shot('02-settings-menu')
    ev("document.querySelector('#jv-ov .mi[data-go=hearing]').click()"); pg.wait_for_timeout(800); shot('02b-settings-hearing')
    ev("document.querySelector('#jv-ov .bar .back').click(); document.querySelector('#jv-ov .mi[data-go=powers]').click()"); shot('02c-settings-powers')
    ev("document.querySelector('#jv-ov .bar .x').click()")
    pg.wait_for_timeout(9000)                                             # the face loads
    ev("JARVIS.setup && JARVIS.setup.close && JARVIS.setup.close(false)")
    shot('03-home')
    ev("document.body.classList.add('jv-greet')"); shot('03a-greeting'); ev("document.body.classList.remove('jv-greet')")
    ev("JARVIS.openIdeas()"); shot('03b-ideas'); ev("document.getElementById('jv-scrim').click()")

    def state(s, partial=''):
        ev(f"(() => {{ const e = document.getElementById('state'); e.className = {json.dumps(s)}; e.textContent = {json.dumps(s.upper())};"
           f" const p = document.getElementById('partial-text'); p.textContent = {json.dumps(partial)}; p.classList.toggle('active', {json.dumps(bool(partial))}); }})()")
    def msg(text, who):
        ev(f"(() => {{ const d = document.createElement('div'); d.className = 'msg {who}';"
           f" if ('{who}' === 'proactive' || '{who}' === 'sys') d.textContent = {json.dumps(text)}; else d.innerHTML = `<span class=\"who\">{'YOU' if who == 'user' else 'JARVIS'}</span><span class=\"body\"></span>`;"
           f" if (d.querySelector('.body')) d.querySelector('.body').textContent = {json.dumps(text)}; document.getElementById('log').appendChild(d); }})()")

    state('listening', 'what is the weather like in')
    ev("JARVIS.stats.rms = 900"); shot('04-listening')
    msg("What's the weather like in Lagos today?", 'user'); state('thinking')
    ev("window.dispatchEvent(new CustomEvent('jv-activity', { detail: 'get_weather' }))"); shot('05-thinking')
    msg("It's 31 degrees and partly cloudy in Lagos, with a 40 percent chance of rain after 4 PM. Take an umbrella if you're heading out late.", 'jarvis')
    state('speaking'); shot('06-speaking')
    state('session'); msg('Ada sent you a voice note on WhatsApp.', 'proactive'); shot('07-session-with-note')
    ev("document.getElementById('jv-hist').click()"); shot('08-history')
    ev("document.getElementById('jv-hist').click()")
    state('muted'); shot('09-muted'); state('standby')

    # setup walkthrough
    ev("JARVIS.setup.open(true)"); shot('10-setup'); ev("JARVIS.setup.close(false)")

    # deliveries: route card, map under it, face as an orb
    ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('I accepted a doordash order from Chipotle')")
    try: pg.wait_for_function("document.body.getAttribute('data-nav') === 'dash'", timeout=15000)
    except Exception: pass
    pg.wait_for_timeout(6000); shot('11-delivery-dash')
    ev("JARVIS.navsvc.stop && JARVIS.navsvc.stop()"); pg.wait_for_timeout(1500)

    # shift running + SOS banner
    ev("window.__phone.shift = { active: true, start: Date.now() - 2.2 * 3600000, meters: 34.2 * 1609.344 }; window.dispatchEvent(new Event('jv-refresh'))")
    pg.wait_for_timeout(800); shot('12-shift')
    ev("window.__phone.sos = true; window.dispatchEvent(new Event('jv-refresh'))"); shot('13-sos')
    ev("window.__phone.sos = false; window.__phone.shift = null; window.dispatchEvent(new Event('jv-refresh'))")

    # earnings, what Jarvis knows, driving mode
    ev("""(() => { const d = JARVIS.delivery._db(), now = Date.now() / 1000, rows = [];
          const day = n => now - n * 86400;
          const plan = [[0, [[1, 9.5, 'Tempe, AZ', 'Chipotle'], [2, 12.25, 'Tempe, AZ', 'Wingstop'], [3, 7, 'Mesa, AZ', 'Panda Express']]], [1, [[2, 11, 'Tempe, AZ', 'Chipotle'], [3, 8.5, 'Chandler, AZ', 'Five Guys'], [4, 14, 'Scottsdale, AZ', 'Wingstop']]],
            [2, [[1, 6.75, 'Mesa, AZ', 'Chipotle']]], [3, [[1, 10, 'Tempe, AZ', 'Chipotle'], [2, 13.5, 'Scottsdale, AZ', 'Wingstop'], [2.5, 9, 'Chandler, AZ', 'Five Guys']]], [4, []],
            [5, [[1, 16, 'Scottsdale, AZ', 'Wingstop'], [2, 12, 'Tempe, AZ', 'Chipotle'], [3, 9.25, 'Mesa, AZ', 'Panda Express'], [4, 11.5, 'Scottsdale, AZ', 'Five Guys']]], [6, [[1, 8, 'Mesa, AZ', 'Chipotle'], [2, 10.5, 'Tempe, AZ', 'Wingstop']]]];
          for (const [dd, list] of plan) for (const [h, pay, area, r] of list) d.log.push({ platform: h % 2 ? 'DoorDash' : 'Uber Eats', restaurant: r, payout: pay, accepted_at: day(dd) - h * 3600 - 1500, delivered_at: day(dd) - h * 3600, area });
          JARVIS.delivery._save(d);
          JARVIS.kv.set('memories', [{ fact: 'Drives for DoorDash and Uber Eats around Tempe', ts: Date.now() - 86400000 * 3 }, { fact: 'Has a sister called Ada', ts: Date.now() - 86400000 }, { fact: 'Prefers Chipotle orders over long highway drops', ts: Date.now() }]);
          JARVIS.kv.set('prefs', ['Keep answers short while driving', 'Use miles, not kilometres']);
          JARVIS.kv.set('notes', [{ text: 'Ask about the parking at the Tempe Marketplace', ts: Date.now() - 7200000 }]);
          JARVIS.config.set('places', { home: { address: '1420 East Apache Boulevard, Tempe, Arizona' } });
        })()""")
    ev("JARVIS.openEarnings('week')"); shot('16-earnings')
    ev("document.getElementById('jv-pane').scrollBy(0, 700)"); shot('17-earnings-scrolled')
    ev("JARVIS.openKnows()"); shot('18-what-i-know')
    ev("document.querySelector('#jv-pane .back').click()")
    ev("window.__phone.shift = { active: true, start: Date.now() - 2.2 * 3600000, meters: 34.2 * 1609.344 }; JARVIS.config.set('drive_mode', 'on'); window.dispatchEvent(new Event('jv-refresh'))")
    pg.wait_for_timeout(1200); shot('19-driving')
    ev("JARVIS.config.set('dash_map', false)"); ev("JARVIS.wake()"); pg.wait_for_timeout(300); ev("JARVIS.say('I accepted an uber eats order from Wingstop to 45 Mill Avenue, 12 dollars')")
    pg.wait_for_timeout(7000); ev("JARVIS.navsvc.stop && JARVIS.navsvc.stop()"); pg.wait_for_timeout(12000); shot('20-driving-next-stop')
    ev("JARVIS.config.set('drive_mode', 'auto'); JARVIS.config.set('dash_map', true); window.__phone.shift = null; JARVIS.reg.exec('clear_deliveries', '{}'); window.dispatchEvent(new Event('jv-refresh'))"); pg.wait_for_timeout(1000)

    # the female face
    ev("document.querySelectorAll('#log .msg').forEach(m => m.remove()); JARVIS.config.merge({ avatar_gender: 'female', voice: '' }); JARVIS.applySettings({ voiceChanged: true })")
    state('standby'); pg.wait_for_timeout(9000); shot('14-female-home')
    msg("Tell me a joke.", 'user'); msg("Why did the delivery driver bring a ladder? Because the order said the food was on the house.", 'jarvis'); state('speaking'); pg.wait_for_timeout(1500); shot('15-female-speaking')
    print('page errors:', [e[:160] for e in errs if 'three' not in e.lower()][:8])
    b.close()
print('screens in', OUT)
