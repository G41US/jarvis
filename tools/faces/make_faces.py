"""Builds Jarvis's original faces from MakeHuman's CC0 assets (base mesh, targets, skins, hair, eyes, clothes), with Blender
running headless and the MPFB add-on doing the MakeHuman part. Each face is exported as a small GLB for the app:
head, neck and shoulders in a top, with two morph targets the app animates - "jawOpen" (talking) and "eyeBlink".

Setup (once):
  python3 -m venv bvenv && bvenv/bin/pip install bpy==5.1.2
  MPFB 2.0.18 from extensions.blender.org, and makehuman_system_assets_cc0.zip from files.makehumancommunity.org
Run:
  bvenv/bin/python tools/faces/make_faces.py <mpfb.zip> <assets dir> <out dir> [face ...]

Every asset used is CC0 (MakeHuman system assets, released into the public domain in 2020), so the faces are free to ship.
They are generic, made-up people: none is modelled on anyone real."""
import os, sys, json, math, shutil

import bpy
import bmesh
import numpy as np

MPFB_ZIP, ASSETS, OUT = (os.path.abspath(a) for a in sys.argv[1:4])
ONLY = set(sys.argv[4:])

# ------------------------------------------------------------------ the people
# phenotype: MakeHuman's macro sliders (0..1). targets: small face details so nobody looks like the default model.
FACES = {
    'amara': dict(name='Amara', gender='female',
        phenotype=dict(gender=0.0, age=0.47, muscle=0.5, weight=0.42, proportions=0.75, height=0.5, cupsize=0.5, firmness=0.6, race=dict(african=0.9, asian=0.0, caucasian=0.1)),
        targets=[('head-oval', 0.5), ('nose-scale-horiz-decr', 0.15), ('mouth-scale-horiz-incr', 0.15), ('l-eye-scale-incr', 0.25), ('r-eye-scale-incr', 0.25),
                 ('l-cheek-bones-incr', 0.4), ('r-cheek-bones-incr', 0.4), ('chin-width-decr', 0.3), ('mouth-upperlip-volume-incr', 0.2), ('mouth-lowerlip-volume-incr', 0.25),
                 ('mouth-angles-up', 0.35)],
        skin='young_african_female/young_african_female.mhmat', hair='ponytail01/ponytail01.mhclo', hair_color='#1c1310', eyebrows='eyebrow010/eyebrow010.mhclo',
        eyelashes='eyelashes02/eyelashes02.mhclo', eyes='brown', clothes='female_casualsuit01/female_casualsuit01.mhclo', shirt_color='#1d6b70'),
    'nova': dict(name='Nova', gender='female',
        phenotype=dict(gender=0.0, age=0.45, muscle=0.5, weight=0.4, proportions=0.75, height=0.5, cupsize=0.5, firmness=0.6, race=dict(african=0.0, asian=0.55, caucasian=0.45)),
        targets=[('head-round', 0.3), ('nose-scale-horiz-decr', 0.25), ('nose-trans-up', 0.1), ('l-eye-scale-incr', 0.2), ('r-eye-scale-incr', 0.2),
                 ('chin-prominent-incr', 0.2), ('mouth-lowerlip-volume-incr', 0.2), ('l-cheek-volume-decr', 0.2), ('r-cheek-volume-decr', 0.2), ('mouth-angles-up', 0.3)],
        skin='young_asian_female/young_asian_female.mhmat', hair='long01/long01.mhclo', hair_color='#2a1c15', eyebrows='eyebrow011/eyebrow011.mhclo',
        eyelashes='eyelashes03/eyelashes03.mhclo', eyes='brownlight', clothes='female_casualsuit02/female_casualsuit02.mhclo', shirt_color='#d8cfc4'),
    'kofi': dict(name='Kofi', gender='male',
        phenotype=dict(gender=1.0, age=0.5, muscle=0.62, weight=0.48, proportions=0.7, height=0.55, cupsize=0.5, firmness=0.5, race=dict(african=0.95, asian=0.0, caucasian=0.05)),
        targets=[('head-rectangular', 0.4), ('chin-width-incr', 0.25), ('nose-scale-horiz-incr', 0.1), ('l-cheek-bones-incr', 0.3), ('r-cheek-bones-incr', 0.3),
                 ('mouth-lowerlip-volume-incr', 0.2), ('l-eye-trans-up', 0.1), ('r-eye-trans-up', 0.1), ('mouth-angles-up', 0.2)],
        skin='young_african_male/young_african_male.mhmat', hair='short04/short04.mhclo', hair_color='#140f0d', eyebrows='eyebrow001/eyebrow001.mhclo',
        eyelashes='eyelashes01/eyelashes01.mhclo', eyes='brown', clothes='male_casualsuit04/male_casualsuit04.mhclo', shirt_color='#2b3038'),
}
JAW_OPEN = 0.42           # how far "jawOpen" = 1 opens the mouth (the expression unit at 1 is a wide yawn)
ALPHA = {'eyes': 0.5, 'hair': 0.35, 'eyebrows': 'BLEND', 'eyelashes': 'BLEND'}
TEX = {'body': 1024, 'hair': 1024, 'clothes': 512, 'eyes': 256, 'eyebrows': 512, 'eyelashes': 256, 'teeth': 256, 'tongue': 128}

# ------------------------------------------------------------------ MPFB
bpy.ops.extensions.package_install_files(filepath=MPFB_ZIP, repo='user_default', enable_on_install=True)
user_data = os.path.join(bpy.utils.extension_path_user('bl_ext.user_default.mpfb', create=True), 'data')
for sub in os.listdir(ASSETS):
    src, dst = os.path.join(ASSETS, sub), os.path.join(user_data, sub)
    if os.path.isdir(src) and not os.path.exists(dst): shutil.copytree(src, dst)
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.objectservice import ObjectService
MPFB_DATA = os.path.join(os.path.dirname(sys.modules['bl_ext.user_default.mpfb'].__file__), 'data')


def coords(obj, key=None):
    n = len(obj.data.vertices); a = np.empty(n * 3, np.float32)
    (key.data if key is not None else obj.data.vertices).foreach_get('co', a)
    return a.reshape(-1, 3)


def evaluated(obj):
    """Vertex positions with the current shape key mix (no modifiers)."""
    kb = obj.data.shape_keys.key_blocks if obj.data.shape_keys else []
    if not kb: return coords(obj)
    base = coords(obj, kb[0]); out = base.copy()
    for k in list(kb)[1:]:
        if k.value and not k.mute: out += (coords(obj, k) - coords(obj, k.relative_key)) * k.value
    return out


def recolor(img, hexcol):
    """Hair texture in a new colour, keeping its light and dark strands (and its alpha)."""
    w, h = img.size; px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], np.float32)
    seen = px[:, 3] > 0.3; ref = float(np.median(lum[seen])) if seen.any() else 0.5
    col = np.array([int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)
    shade = np.clip(lum / max(ref, 1e-3), 0, 2.2)[:, None] ** 0.9
    out = img.copy(); out.name = img.name + '_tinted'
    px[:, :3] = np.clip(col[None, :] * shade, 0, 1); out.pixels.foreach_set(px.ravel()); out.update()
    return out


def plain_tee(img, hexcol, size):
    """MakeHuman's T-shirts carry a logo and orange stripes: paint them out with the surrounding fabric, then dye the shirt."""
    if max(img.size) > size: img.scale(size, size)
    w, h = img.size; px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(h, w, 4)
    rgb = px[:, :, :3]; r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lum0 = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    fabric = (b > r + 0.10) & (b > g + 0.02) & (lum0 < 0.5)         # the blue cloth (and the darker blue collar), not the pale logo ring
    filled = fabric.copy(); out = rgb * fabric[..., None]
    for _ in range(200):                                            # grow the cloth into the logo and stripes, a pixel ring at a time
        if filled.all(): break
        acc = np.zeros_like(out); cnt = np.zeros(filled.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            f = np.roll(np.roll(filled, dy, 0), dx, 1); o = np.roll(np.roll(out, dy, 0), dx, 1)
            acc += o * f[..., None]; cnt += f
        new = (~filled) & (cnt > 0)
        out[new] = acc[new] / cnt[new][:, None]; filled |= new
    lum = out @ np.array([0.299, 0.587, 0.114], np.float32)
    ref = float(np.median(lum[fabric])) if fabric.any() else 0.3
    col = np.array([int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)
    px[:, :, :3] = np.clip(col * (np.clip(lum / ref, 0, 2.5) ** 0.85)[..., None], 0, 1)
    new_img = bpy.data.images.new(img.name + '_plain', w, h, alpha=False); new_img.pixels.foreach_set(px.ravel()); new_img.update()
    return new_img


def add_scene_extras(path, extras):
    """Writes extras into the GLB's scene (three.js puts them in gltf.scene.userData)."""
    import struct
    b = open(path, 'rb').read(); n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + n]); rest = b[20 + n:]
    j['scenes'][j.get('scene', 0)].setdefault('extras', {}).update(extras)
    js = json.dumps(j, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    out = b[:12] + struct.pack('<I', len(js)) + b'JSON' + js + rest
    out = out[:8] + struct.pack('<I', len(out)) + out[12:]
    open(path, 'wb').write(out)


def proxies(body):
    return [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == body]


def kind_of(o, body):
    n = o.name.lower()
    for k in ('braid', 'bob', 'short', 'long', 'afro', 'ponytail'):
        if k in n: return 'hair'
    for k in ('eyebrow', 'eyelash', 'teeth', 'tongue'):
        if k in n: return {'eyebrow': 'eyebrows', 'eyelash': 'eyelashes'}.get(k, k)
    if 'high-poly' in n or 'low-poly' in n: return 'eyes'
    return 'clothes'


def build(fid, f):
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images): [coll.remove(x) for x in list(coll) if not x.users]
    info = HumanService._create_default_human_info_dict()
    ph = info['phenotype']; ph.update({k: v for k, v in f['phenotype'].items()})
    info.update({'eyes': 'high-poly/high-poly.mhclo', 'eyebrows': f['eyebrows'], 'eyelashes': f['eyelashes'], 'hair': f['hair'],
                 'teeth': 'teeth_base/teeth_base.mhclo', 'tongue': 'tongue01/tongue01.mhclo', 'skin_mhmat': f['skin'], 'skin_material_type': 'MAKESKIN',
                 'eyes_material_type': 'MAKESKIN', 'clothes': [f['clothes']], 'targets': [{'target': t, 'value': v} for t, v in f['targets']]})
    st = HumanService.get_default_deserialization_settings(); st.update({'subdiv_levels': 0, 'material_instances': 'NEVER'})
    body = HumanService.deserialize_from_dict(info, st)

    # ---- expression shapes: the mouth opening (talking) and the eyes closing (blinking), blended by race like MakeHuman does
    race = f['phenotype']['race']
    def unit(name):
        ks = []
        for r, w in race.items():
            if w < 0.01: continue
            k = TargetService.load_target(body, os.path.join(MPFB_DATA, 'targets', 'expression', 'units', r, name + '.target.gz'), weight=0.0, name=f'x_{name}_{r}')
            ks.append((k, w))
        return ks
    jaw = unit('mouth-open') if not f.get('noexpr') else []; blink = unit('eye-left-closure') + unit('eye-right-closure') if not f.get('noexpr') else []
    for k, w in jaw + blink: k.value = 0.0                        # loaded switched on: start from a neutral face

    kids = proxies(body)
    def snap():                                                    # body and every proxy, as they look now
        HumanService.refit(body)
        return evaluated(body), {o.name: coords(o) for o in kids}
    def set_keys(ks, v):
        for k, w in ks: k.value = w * v
    base_b, base_p = snap()
    set_keys(jaw, JAW_OPEN); jaw_b, jaw_p = snap(); set_keys(jaw, 0)
    set_keys(blink, 1.0); bl_b, bl_p = snap(); set_keys(blink, 0)
    HumanService.refit(body)

    # ---- what to drop: what the masks hid (helper geometry, skin under the clothes), and everything below the chest
    # (positions from base_b: the finished shape, not the plain base mesh)
    mw = body.matrix_world
    world = np.array([tuple(mw @ __import__('mathutils').Vector(p)) for p in base_b])
    def joint(name):
        gj = body.vertex_groups[name].index
        idx = [v.index for v in body.data.vertices if any(g.group == gj for g in v.groups)]
        return world[idx].mean(0)
    # where the head is, for the app's framing (it scales every face so the head is the same size): from mid-neck to the top of the scalp
    scalp = float(world[:13380, 2].max())
    neck_z = (joint('joint-neck')[2] + joint('joint-jaw')[2]) / 2; hc = joint('joint-head')
    head_meta = {'neck': round(float(neck_z), 4), 'top': round(scalp + f.get('hair_top', 0.02), 4), 'cx': round(float(hc[0]), 4), 'cz': round(float(-hc[1]), 4)}   # glTF: y up, z = -y
    clav_z = float(joint('joint-l-clavicle')[2])
    cut_z = clav_z - f.get('cut', 0.07)    # a little below the collarbone: the neck and the top of the shoulders
    hide = set()
    for m in body.modifiers:
        if m.type == 'MASK' and m.vertex_group in body.vertex_groups:
            gm = body.vertex_groups[m.vertex_group].index
            for v in body.data.vertices:
                inside = any(g.group == gm and g.weight > 0.01 for g in v.groups)
                if inside == bool(m.invert_vertex_group): hide.add(v.index)   # MASK keeps the group (or, inverted, everything else)
    for m in list(body.modifiers): body.modifiers.remove(m)

    # ---- bake the face into the mesh (no shape keys while cutting: vertex order is kept), then add back the two the app animates
    def rebuild(obj, base, shapes, extra=()):
        if obj.data.shape_keys: obj.shape_key_clear()
        obj.data.vertices.foreach_set('co', base.ravel()); obj.data.update()
        w = obj.matrix_world
        zs = np.array([(w @ v.co).z for v in obj.data.vertices])
        keep = np.array([i not in extra and zs[i] >= cut_z for i in range(len(zs))])
        bm = bmesh.new(); bm.from_mesh(obj.data); bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context='VERTS'); bm.to_mesh(obj.data); bm.free(); obj.data.update()
        if len(obj.data.vertices) != int(keep.sum()): raise RuntimeError(f'{obj.name}: vertex count changed unexpectedly')
        if not len(obj.data.vertices): return False
        obj.shape_key_add(name='Basis', from_mix=False)
        for name, target in shapes:
            t = target[keep]
            if np.abs(t - base[keep]).max() < 2e-4: continue          # under 0.2 mm: not worth a morph target
            k = obj.shape_key_add(name=name, from_mix=False); k.data.foreach_set('co', t.ravel()); k.value = 0.0   # exported as the resting weight
        obj.data.update(); return True
    rebuild(body, base_b, [('jawOpen', jaw_b), ('eyeBlink', bl_b)], hide)
    for o in list(kids):
        if not rebuild(o, base_p[o.name], [('jawOpen', jaw_p[o.name]), ('eyeBlink', bl_p[o.name])]): bpy.data.objects.remove(o, do_unlink=True); kids.remove(o)

    # ---- simple PBR materials the app lights itself
    for o in [body] + kids:
        kind = 'body' if o == body else kind_of(o, body)
        for slot, mat in enumerate(o.data.materials):
            if not mat or not mat.node_tree: continue
            imgs = [n.image for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
            diffuse = next((i for i in imgs if 'normal' not in i.name.lower() and '_ao' not in i.name.lower()), imgs[0] if imgs else None)
            if kind == 'eyes':
                diffuse = bpy.data.images.load(os.path.join(user_data, 'eyes', 'materials', f['eyes'] + '_eye.png'))
            nm = bpy.data.materials.new(f'{fid}_{kind}_{slot}')
            nm.use_nodes = True
            nt = nm.node_tree; [nt.nodes.remove(n) for n in list(nt.nodes)]
            out = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
            nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
            bsdf.inputs['Roughness'].default_value = {'body': 0.58, 'eyes': 0.12, 'hair': 0.72, 'clothes': 0.85, 'teeth': 0.3, 'tongue': 0.45}.get(kind, 0.6)
            bsdf.inputs['Metallic'].default_value = 0.0
            if 'Specular IOR Level' in bsdf.inputs: bsdf.inputs['Specular IOR Level'].default_value = 0.35 if kind == 'body' else 0.5
            if diffuse and kind == 'hair' and f.get('hair_color'):          # MakeHuman's hair textures are light, meant to be tinted
                diffuse = recolor(diffuse, f['hair_color'])
            if diffuse and kind == 'clothes' and f.get('shirt_color'):
                diffuse = plain_tee(diffuse, f['shirt_color'], TEX['clothes'])
            if diffuse:
                if max(diffuse.size) > TEX[kind]:
                    k = TEX[kind] / max(diffuse.size); diffuse.scale(max(1, int(diffuse.size[0] * k)), max(1, int(diffuse.size[1] * k)))
                tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = diffuse
                nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
                alpha = f.get('alpha_' + kind, ALPHA.get(kind))
                if alpha == 'BLEND':                                       # soft edges (eyebrows, eyelashes)
                    nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha']); nm.surface_render_method = 'BLENDED'
                elif alpha:                                                # cut-out at this alpha (eyes: the clear cornea; hair)
                    gt = nt.nodes.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = float(alpha)
                    nt.links.new(tex.outputs['Alpha'], gt.inputs[0]); nt.links.new(gt.outputs[0], bsdf.inputs['Alpha']); nm.surface_render_method = 'DITHERED'
            o.data.materials[slot] = nm

    # ---- export (glTF: +Y up, facing +Z, like the other faces)
    for o in bpy.data.objects: o.select_set(o.type == 'MESH')
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, fid + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_morph=True, export_morph_normal=False,
                              export_skins=False, export_animations=False, export_image_format='JPEG', export_jpeg_quality=86, export_yup=True,
                              export_texcoords=True, export_normals=True, export_materials='EXPORT', export_extras=False)
    add_scene_extras(path, {'jvHead': head_meta})
    print('WROTE', path, os.path.getsize(path) // 1000, 'KB', 'verts', len(body.data.vertices) + sum(len(o.data.vertices) for o in kids))


# "amara:hair=afro01/afro01.mhclo:eyes=green" builds a variant called amara_afro01 (for trying looks)
for spec in list(ONLY):
    if ':' not in spec: continue
    base, *kv = spec.split(':'); v = dict(FACES[base]); tag = []
    for item in kv: k, val = item.split('=', 1); v[k] = float(val) if k == 'cut' or (k.startswith('alpha_') and val != 'BLEND') else val; tag.append(os.path.basename(val).split('.')[0])
    FACES[base + '_' + '_'.join(tag)] = v; ONLY.discard(spec); ONLY.add(base + '_' + '_'.join(tag))
for fid, f in FACES.items():
    if ONLY and fid not in ONLY: continue
    build(fid, f)
    with open(os.path.join(OUT, fid + '.json'), 'w') as fh:
        json.dump({'id': fid, 'name': f['name'], 'gender': f['gender'], 'license': 'CC0 (MakeHuman system assets)'}, fh)
