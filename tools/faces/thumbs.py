#!/usr/bin/env python3
"""Pictures of each face for the settings picker, taken from the app itself (the real page, the real 3D face).
  python3 tools/faces/thumbs.py <vendor dir with three/ and maplibre/>"""
import os, sys, re
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tests'))
sys.argv = [sys.argv[0], sys.argv[1], '/tmp/jv-thumbs', '360', '640']
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tests', 'screens.py')).read().split('with sync_playwright() as p:')[0]
g = {'__file__': os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tests', 'screens.py')}; exec(src, g)
e2e = g['e2e']
from playwright.sync_api import sync_playwright
from PIL import Image
OUT = os.path.join(e2e.WWW, 'models', 'faces')
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': 360, 'height': 640}, device_scale_factor=2)
    ctx.add_init_script(e2e.BRIDGE); ctx.route(e2e.ORIGIN + '/**', g['assets']); ctx.route(re.compile(r'https://(?!appassets).*'), g['other'])
    pg = ctx.new_page(); pg.goto(e2e.ORIGIN + '/index.html'); pg.wait_for_function('window.JARVIS && window.JARVIS.config', timeout=20000)
    pg.evaluate("JARVIS.proactive.stop(); JARVIS.config.set('groq_key', 'gsk_x'); document.querySelectorAll('#jv-ov .bar button')[0].click()")
    pg.add_style_tag(content='#jv-aura,#jv-top,#jv-dock,#jv-hint,#jv-hello,#jv-card,#jv-toast,#jv-setup{display:none!important} body{background:#0a1624!important}')
    for fid in ['male', 'female']:
        pg.evaluate(f"JARVIS.chooseFace('{fid}')"); pg.wait_for_timeout(9000)
        pg.screenshot(path='/tmp/jv-thumb.png')
        im = Image.open('/tmp/jv-thumb.png').convert('RGB'); W, H = im.size
        cy, half = H * 0.51, W * 0.34; box = (int(W / 2 - half), int(cy - half), int(W / 2 + half), int(cy + half))   # the head, square
        im.crop(box).resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, fid + '.jpg'), quality=86)
        print('thumb', fid)
    b.close()
