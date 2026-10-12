#!/usr/bin/env python3
"""Shrinks the textures inside a .glb so it loads fast on a phone (geometry is untouched).
Usage: python3 tools/optimize_glb.py in.glb out.glb [max_side=2048] [normal_max_side=1024]"""
import io, json, struct, sys
from PIL import Image

def main(src, dst, max_side=2048, normal_side=1024):
    d = open(src, 'rb').read()
    assert d[:4] == b'glTF'
    jl = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20 + jl])
    o = 20 + jl; bl = struct.unpack('<I', d[o:o + 4])[0]; bin_ = d[o + 8:o + 8 + bl]
    views = [bytes(bin_[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]) for v in j['bufferViews']]
    for im in j.get('images', []):
        if 'bufferView' not in im: continue
        raw = views[im['bufferView']]; img = Image.open(io.BytesIO(raw)); img.load()
        name = (im.get('name') or '').lower(); is_normal = 'normal' in name
        side = normal_side if is_normal else max_side
        if max(img.size) > side:
            s = side / max(img.size); img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
        has_alpha = img.mode in ('RGBA', 'LA') and img.getchannel('A').getextrema()[0] < 250
        buf = io.BytesIO()
        if has_alpha or is_normal:
            img.save(buf, 'PNG', optimize=True); im['mimeType'] = 'image/png'
        else:
            img.convert('RGB').save(buf, 'JPEG', quality=88, optimize=True); im['mimeType'] = 'image/jpeg'
        new = buf.getvalue()
        if len(new) < len(raw): views[im['bufferView']] = new
        print(f"  {im.get('name')}: {len(raw)/1e6:.1f} MB -> {len(views[im['bufferView']])/1e6:.2f} MB {img.size} {'alpha' if has_alpha else ''}")
    out = bytearray()
    for v, data in zip(j['bufferViews'], views):
        while len(out) % 4: out.append(0)
        v['byteOffset'] = len(out); v['byteLength'] = len(data); v.pop('byteStride', None) if 'byteStride' in v and v.get('target') is None and False else None
        out += data
    while len(out) % 4: out.append(0)
    j['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    glb = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(out)) + b'BIN\x00' + bytes(out)
    open(dst, 'wb').write(glb)
    print(f'{src}: {len(d)/1e6:.1f} MB -> {dst}: {len(glb)/1e6:.1f} MB')

if __name__ == '__main__':
    a = sys.argv[1:]; main(a[0], a[1], *(int(x) for x in a[2:]))
