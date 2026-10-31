#!/usr/bin/env python3
"""App updates on the Jarvis service: the newest APK lives in a Cloudflare KV store (UPDATES), in parts under KV's 25 MiB
value limit, so the app can update itself without reaching the private GitHub repo. Run by the build workflow:
  python3 tools/kv_update.py ensure                 # create the store once, bind it in server/wrangler.toml
  python3 tools/kv_update.py upload Jarvis.apk 52   # store build 52 (parts first, then 'meta', then drop older builds)
Needs CF_TOKEN and CF_ACCOUNT in the environment."""
import json, os, sys, urllib.error, urllib.parse, urllib.request

TITLE, PART = 'jarvis-updates', 24 * 1024 * 1024
ACCT, TOKEN = os.environ.get('CF_ACCOUNT', '').strip(), os.environ.get('CF_TOKEN', '').strip()
API = f'https://api.cloudflare.com/client/v4/accounts/{ACCT}/storage/kv/namespaces'


def call(method, url, body=None, ctype='application/json'):
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
    req = urllib.request.Request(url, method=method, data=data, headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': ctype})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: return json.load(e)
        except Exception: return {'success': False, 'errors': [{'message': f'HTTP {e.code}'}]}


def must(j, what):
    if not j.get('success'):
        sys.exit(f'{what} failed: {[e.get("message") for e in j.get("errors", [])]}')
    return j.get('result')


def namespace_id():
    for ns in must(call('GET', API + '?per_page=100'), 'listing KV stores') or []:
        if ns.get('title') == TITLE: return ns['id']
    return must(call('POST', API, {'title': TITLE}), 'creating the KV store')['id']


def key_url(ns, key): return f'{API}/{ns}/values/{urllib.parse.quote(key, safe="")}'


def ensure():
    ns = namespace_id()
    toml = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', 'wrangler.toml')
    with open(toml, 'a') as f:
        f.write(f'\n# app updates (added by the build: tools/kv_update.py)\n[[kv_namespaces]]\nbinding = "UPDATES"\nid = "{ns}"\n')
    print(f'KV store {TITLE}: {ns}')


def upload(path, build):
    ns, data = namespace_id(), open(path, 'rb').read()
    parts = [data[i:i + PART] for i in range(0, len(data), PART)]
    for i, p in enumerate(parts):
        must(call('PUT', key_url(ns, f'apk:{build}:{i}'), p, 'application/octet-stream'), f'storing part {i}')
    must(call('PUT', key_url(ns, 'meta'), json.dumps({'build': int(build), 'size': len(data), 'parts': len(parts)}).encode(), 'application/octet-stream'), 'storing meta')
    old = [k['name'] for k in (must(call('GET', f'{API}/{ns}/keys?prefix=apk:'), 'listing parts') or []) if not k['name'].startswith(f'apk:{build}:')]
    for k in old: call('DELETE', key_url(ns, k))
    print(f'Stored build {build}: {len(data)} bytes in {len(parts)} parts; removed {len(old)} old parts')


if __name__ == '__main__':
    assert PART < 25 * 1024 * 1024   # KV's per-value limit is 25 MiB
    if not (ACCT and TOKEN): sys.exit('CF_ACCOUNT and CF_TOKEN are needed')
    if sys.argv[1:2] == ['ensure']: ensure()
    elif sys.argv[1:2] == ['upload'] and len(sys.argv) == 4: upload(sys.argv[2], sys.argv[3])
    else: sys.exit(__doc__)
