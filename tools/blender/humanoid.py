"""OMEN's player character: an original, stylised full-body human (cartoon proportions, about
5.6 heads tall) with a real humanoid skeleton and animation clips.

  blender -b --python tools/blender/humanoid.py -- [--preview] [--poses]

Built entirely from code (reproducible, no third-party assets):
  - body: a skin-modifier skeleton graph (torso, neck, arms, legs) subdivided into one smooth,
    continuous mesh; clothing is assigned by region (jacket, inner tee, trousers);
  - head: a deformed sphere with nose and ears fused in by voxel remesh (one sculpted surface);
  - face parts: eyes (sclera, iris, pupil, highlight), upper eyelids, eyebrows, lips;
  - hands with four fingers and a thumb; sneakers; six hairstyles (shown one at a time);
  - armature: hips → spine → chest → neck → head (+ jaw), shoulders/arms/hands, legs/feet;
    the body is skinned with automatic weights; rigid parts are parented to their bones;
  - actions: idle, walk, run, turn, jump, fall, land, wave, talk, interact (in place).
Material names are the recolour hooks used by src/human.js.

Units: metres. Blender: Z up, the character faces -Y (glTF/three.js: Y up, faces +Z).
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix, Quaternion

sys.path.insert(0, os.path.dirname(__file__))
import lib  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []

# Colours (recoloured at runtime by material name).
for k, v in {
    "h_skin": "#D99A73", "h_hair": "#2E2221", "h_jacket": "#3E8E8A", "h_tee": "#F1E6D2", "h_pants": "#2F3E5C",
    "h_shoe": "#F4F1EA", "h_sole": "#2B2230", "h_eye_white": "#FBFAF7", "h_iris": "#4A3020", "h_pupil": "#14101A",
    "h_lip": "#B8605E", "h_brow": "#2E2221", "h_mouth": "#5A2228", "h_lid": "#D99A73", "h_lash": "#1B1418", "h_shoe_accent": "#C8473D",
}.items():
    lib.PALETTE[k] = v

HEAD_C = Vector((0, 0, 1.645))  # head centre


def mat(name, rough=0.6):
    m = lib.mat(name)
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = rough
    return m


def obj_from_bm(bm, name):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return o


def select_only(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def apply_mods(o):
    select_only(o)
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def smooth(o):
    for p in o.data.polygons:
        p.use_smooth = True


def remesh(o, voxel):
    m = o.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.adaptivity = 0.0
    apply_mods(o)


def decimate(o, ratio):
    m = o.modifiers.new("dec", "DECIMATE")
    m.ratio = ratio
    apply_mods(o)


def laplace(o, factor=0.5, repeat=4):
    m = o.modifiers.new("smooth", "SMOOTH")
    m.factor = factor
    m.iterations = repeat
    apply_mods(o)


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    return o


def ellipsoid(c, r, segs=24, rings=16, name="e"):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * r[0], v.co.y * r[1], v.co.z * r[2])) + Vector(c)
    return obj_from_bm(bm, name)


def capsule(a, b, ra, rb, name="cap", segs=14):
    """A tapered tube with round caps from point a to b (radii ra, rb)."""
    a, b = Vector(a), Vector(b)
    d = b - a
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=ra, radius2=rb, depth=d.length)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    for v in bm.verts:
        v.co = q @ v.co + (a + b) / 2
    o = obj_from_bm(bm, name)
    s1 = ellipsoid(a, (ra, ra, ra), 12, 8)
    s2 = ellipsoid(b, (rb, rb, rb), 12, 8)
    return join([o, s1, s2], name)


# ---------------------------------------------------------------- body (skin modifier)
J = {}  # joint positions, shared with the armature


def body_mesh():
    verts, edges, radii = [], [], []

    def v(key, p, r):
        J[key] = Vector(p)
        verts.append(p)
        radii.append(r)
        return len(verts) - 1

    def e(a, b):
        edges.append((a, b))

    pel = v("pelvis", (0, 0.0, 0.93), (0.152, 0.112))
    waist = v("waist", (0, 0.0, 1.05), (0.138, 0.1))
    e(pel, waist)
    chest = v("chest", (0, -0.006, 1.22), (0.17, 0.118))
    e(waist, chest)
    upch = v("upchest", (0, 0.0, 1.345), (0.178, 0.108))
    e(chest, upch)
    nb = v("neck_base", (0, 0.004, 1.425), (0.056, 0.056))
    e(upch, nb)
    nt = v("neck_top", (0, 0.008, 1.535), (0.047, 0.047))
    e(nb, nt)
    for s, side in ((-1, "R"), (1, "L")):  # Blender +X is the character's left
        sh = v(f"shoulder_{side}", (s * 0.17, 0.0, 1.37), (0.074, 0.074))
        e(upch, sh)
        ua = v(f"arm_{side}", (s * 0.222, 0.0, 1.33), (0.07, 0.07))
        e(sh, ua)
        el = v(f"elbow_{side}", (s * 0.318, 0.018, 1.115), (0.055, 0.055))
        e(ua, el)
        wr = v(f"wrist_{side}", (s * 0.385, 0.0, 0.935), (0.042, 0.038))
        e(el, wr)
        hp = v(f"hip_{side}", (s * 0.094, 0.004, 0.84), (0.1, 0.1))
        e(pel, hp)
        kn = v(f"knee_{side}", (s * 0.098, -0.004, 0.46), (0.07, 0.074))
        e(hp, kn)
        an = v(f"ankle_{side}", (s * 0.099, 0.014, 0.11), (0.05, 0.054))
        e(kn, an)
    me = bpy.data.meshes.new("body")
    me.from_pydata(verts, edges, [])
    o = bpy.data.objects.new("body", me)
    bpy.context.collection.objects.link(o)
    sk = o.modifiers.new("skin", "SKIN")
    sk.use_smooth_shade = True
    sv = o.data.skin_vertices[""].data
    for i, r in enumerate(radii):
        sv[i].radius = r
    sv[pel].use_root = True
    sub = o.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    apply_mods(o)
    laplace(o, 0.4, 3)
    # shape: a little chest and seat, flatter back
    for vtx in o.data.vertices:
        p = vtx.co
        if 1.12 < p.z < 1.36 and p.y < 0 and abs(p.x) < 0.15:
            p.y -= 0.012 * math.sin(math.pi * (p.z - 1.12) / 0.24)
        if 0.86 < p.z < 1.0 and p.y > 0 and abs(p.x) < 0.15:
            p.y += 0.012 * math.sin(math.pi * (p.z - 0.86) / 0.14)
    smooth(o)
    return o


def assign_clothes(o):
    """Jacket on the torso and arms (to the wrists), an inner tee at the open front and collar,
    trousers below the waist, skin on the neck."""
    names = ["h_jacket", "h_tee", "h_pants", "h_skin"]
    o.data.materials.clear()
    for n in names:
        o.data.materials.append(mat(n))
    idx = {n: i for i, n in enumerate(names)}
    for p in o.data.polygons:
        c = p.center
        if c.z > 1.445 and abs(c.x) < 0.09:
            m = "h_skin"  # neck
        elif c.z < 1.0 and abs(c.x) < 0.2:
            m = "h_pants"
        elif c.z > 1.385 and abs(c.x) < 0.085:
            m = "h_tee"  # collar
        elif c.y < -0.07 and abs(c.x) < 0.035 and 1.03 < c.z < 1.40:
            m = "h_tee"  # the tee showing at the open jacket front
        else:
            m = "h_jacket"
        p.material_index = idx[m]


# ---------------------------------------------------------------- head
def head_mesh():
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=32, radius=1.0)
    for vt in bm.verts:
        x, y, z = vt.co
        X, Y, Z = x * 0.118, y * 0.13, z * 0.152
        t = max(0.0, min(1.0, (-z - 0.05) / 0.95))  # 0 above the cheekbones → 1 at the chin
        X *= 1 - 0.34 * t ** 1.5
        Y *= 1 - 0.22 * t
        Y -= 0.014 * t  # chin forward (front is -Y)
        if y > 0 and z > -0.2:
            Y *= 1.07  # back of the skull
        if y < -0.55:
            Y *= 0.95  # a flatter face plane
        if -0.45 < z < 0.1 and y < -0.3:
            X *= 1.03  # cheeks
        vt.co = Vector((X, Y, Z)) + HEAD_C
    head = obj_from_bm(bm, "head")
    parts = [head]
    # nose: bridge + tip + nostrils
    parts.append(capsule(HEAD_C + Vector((0, -0.121, 0.03)), HEAD_C + Vector((0, -0.139, -0.03)), 0.011, 0.016, "nose_bridge"))
    parts.append(ellipsoid(HEAD_C + Vector((0, -0.141, -0.036)), (0.019, 0.017, 0.015), 16, 12, "nose_tip"))
    for s in (-1, 1):
        parts.append(ellipsoid(HEAD_C + Vector((s * 0.016, -0.133, -0.042)), (0.012, 0.011, 0.009), 12, 8, "nostril"))
        # ears
        ear = ellipsoid(HEAD_C + Vector((s * 0.116, 0.012, -0.002)), (0.012, 0.022, 0.034), 16, 12, "ear")
        parts.append(ear)
        # brow ridge and cheekbones, softly
        parts.append(ellipsoid(HEAD_C + Vector((s * 0.046, -0.112, 0.045)), (0.034, 0.014, 0.012), 16, 10, "brow_ridge"))
    o = join(parts, "head")
    remesh(o, 0.0032)
    laplace(o, 0.5, 2)
    decimate(o, 0.085)
    smooth(o)
    o.data.materials.clear()
    o.data.materials.append(mat("h_skin", 0.55))
    return o


def surface_y(head, x, z):
    """Where the face surface is, seen from the front, at (x, z)."""
    hit, loc, n, i = head.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)))
    return loc.y if hit else -0.12 + HEAD_C.y


def face_parts(head):
    parts = {}
    ez = HEAD_C.z + 0.012
    for s, side in ((-1, "R"), (1, "L")):
        ex = s * 0.046
        fy = surface_y(head, ex, ez)
        c = Vector((ex, fy + 0.012, ez))
        white = ellipsoid(c, (0.027, 0.02, 0.029), 18, 12, f"eye_{side}")
        white.data.materials.append(mat("h_eye_white", 0.25))
        iris = ellipsoid(c + Vector((0, -0.016, -0.002)), (0.015, 0.006, 0.017), 16, 8, f"iris_{side}")
        iris.data.materials.append(mat("h_iris", 0.3))
        pupil = ellipsoid(c + Vector((0, -0.0205, -0.002)), (0.0072, 0.003, 0.008), 14, 10, f"pupil_{side}")
        pupil.data.materials.append(mat("h_pupil", 0.2))
        glint = ellipsoid(c + Vector((s * -0.004, -0.0225, 0.007)), (0.0032, 0.0015, 0.0032), 8, 6, f"glint_{side}")
        glint.data.materials.append(mat("h_eye_white", 0.1))
        eye = join([white, iris, pupil, glint], f"eye_{side}")
        parts[f"eye_{side}"] = eye
        # upper eyelid: a skin-coloured shell over the top third of the eye, with a lash line
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=1.0)
        for vt in list(bm.verts):
            if vt.co.z < 0.28:
                bm.verts.remove(vt)
        for vt in bm.verts:
            vt.co = Vector((vt.co.x * 0.031, vt.co.y * 0.0235, vt.co.z * 0.032)) + c
        lid = obj_from_bm(bm, f"lid_{side}")
        lid.data.materials.append(mat("h_lid", 0.55))
        lash = lib.tube([(c.x - 0.029, c.y - 0.006, c.z + 0.006), (c.x - 0.012, c.y - 0.021, c.z + 0.012), (c.x + 0.012, c.y - 0.021, c.z + 0.012), (c.x + 0.029, c.y - 0.006, c.z + 0.006)], 0.0022, "h_lash")
        to_mesh(lash)
        parts[f"lid_{side}"] = join([lid, lash], f"lid_{side}")
        # eyebrow: a tapered arc above the eye
        bz = ez + 0.047
        by = surface_y(head, s * 0.045, bz) - 0.004
        pts = [(s * 0.018, by + 0.004, bz - 0.002), (s * 0.04, by - 0.002, bz + 0.006), (s * 0.062, by + 0.004, bz + 0.004), (s * 0.075, by + 0.012, bz - 0.006)]
        brow = lib.tube(pts, 0.0085, "h_brow")
        to_mesh(brow)
        brow.name = f"brow_{side}"
        parts[f"brow_{side}"] = brow
    # lips: upper and lower, curved slightly into a smile; a mouth line between
    mz = HEAD_C.z - 0.078
    my = surface_y(head, 0, mz)
    up = ellipsoid((0, my - 0.0015, mz + 0.006), (0.027, 0.009, 0.0068), 24, 12, "lip_upper")
    lo = ellipsoid((0, my - 0.0005, mz - 0.0085), (0.024, 0.0095, 0.0085), 24, 12, "lip_lower")
    for o in (up, lo):
        for vt in o.data.vertices:
            vt.co.z += 22 * vt.co.x ** 2  # corners up: a gentle smile
            vt.co.y += 30 * vt.co.x ** 2  # wrap round the face
        o.data.materials.append(mat("h_lip", 0.45))
    line = lib.tube([(-0.028, my - 0.005, mz + 0.0168), (0, my - 0.008, mz - 0.0015), (0.028, my - 0.005, mz + 0.0168)], 0.0016, "h_mouth")
    to_mesh(line)
    parts["lip_upper"] = join([up, line], "lip_upper")
    parts["lip_lower"] = lo
    return parts


def to_mesh(o):
    select_only(o)
    bpy.ops.object.convert(target="MESH")
    smooth(o)
    return o


# ---------------------------------------------------------------- hair
def hair_cap(head, lift=0.011, name="hair"):
    """A shell over the scalp: the head's surface above a hairline (high at the forehead, low at the nape)."""
    o = head.copy()
    o.data = head.data.copy()
    o.name = name
    bpy.context.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    kill = []
    for vt in bm.verts:
        p = vt.co - HEAD_C
        ang = math.atan2(p.x, -p.y)  # 0 = front, ±pi = back
        front = math.cos(ang)  # 1 front … -1 back
        line = 0.072 * max(0, front) ** 0.8 + 0.01 * (1 - abs(front)) - 0.075 * max(0, -front) ** 1.2
        side = abs(math.sin(ang))
        if side > 0.75 and -0.25 < front < 0.6:
            line = max(line, 0.035)  # above the ears
        if p.z < line:
            kill.append(vt)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.normal_update()
    for vt in bm.verts:
        vt.co += vt.normal * lift
    bm.to_mesh(o.data)
    bm.free()
    sol = o.modifiers.new("sol", "SOLIDIFY")
    sol.thickness = 0.012
    sol.offset = 1
    apply_mods(o)
    return o


def hairstyle(head, style):
    cap = hair_cap(head, 0.012 if style != "buzz" else 0.004, f"hair_{style}")
    extra = []
    c = HEAD_C
    if style == "short":
        extra.append(ellipsoid(c + Vector((0.0, -0.05, 0.135)), (0.1, 0.07, 0.04), 20, 12))
        extra.append(ellipsoid(c + Vector((0.035, -0.095, 0.11)), (0.06, 0.035, 0.03), 16, 10))
    elif style == "quiff":
        extra.append(ellipsoid(c + Vector((-0.01, -0.07, 0.15)), (0.095, 0.07, 0.055), 20, 12))
        extra.append(ellipsoid(c + Vector((0.03, -0.105, 0.135)), (0.06, 0.04, 0.045), 16, 10))
    elif style == "curly":
        import random

        rnd = random.Random(4)
        for _ in range(46):
            a = rnd.uniform(0, 2 * math.pi)
            el = rnd.uniform(0.25, 1.35)
            r = 0.142
            p = Vector((math.cos(a) * math.sin(el) * r * 0.86, math.sin(a) * math.sin(el) * r, math.cos(el) * r * 1.05))
            if p.y < -0.06 and p.z < 0.06:
                continue  # keep the face clear
            extra.append(ellipsoid(c + p + Vector((0, 0, 0.02)), (0.032, 0.032, 0.03), 10, 8))
    elif style == "long":
        extra.append(ellipsoid(c + Vector((0, 0.065, -0.085)), (0.13, 0.065, 0.16), 20, 14))
        for s in (-1, 1):
            extra.append(ellipsoid(c + Vector((s * 0.112, -0.005, -0.08)), (0.035, 0.07, 0.13), 14, 10))
        extra.append(ellipsoid(c + Vector((0.02, -0.07, 0.12)), (0.1, 0.06, 0.04), 18, 10))
    elif style == "bun":
        extra.append(ellipsoid(c + Vector((0, 0.07, 0.16)), (0.055, 0.052, 0.05), 18, 12))
    o = join([cap] + extra, f"hair_{style}") if extra else cap
    remesh(o, 0.0045)
    laplace(o, 0.5, 2)
    decimate(o, 0.09 if style != "curly" else 0.12)
    smooth(o)
    o.data.materials.clear()
    o.data.materials.append(mat("h_hair", 0.75))
    return o


# ---------------------------------------------------------------- hands and shoes
def hand(side):
    s = 1 if side == "L" else -1
    w = J[f"wrist_{side}"]
    d = Vector((s * 0.34, -0.02, -1)).normalized()  # down the arm
    out = Vector((s * 1, 0, 0.34)).normalized()  # across the knuckles
    fwd = Vector((0, -1, 0))
    palm_c = w + d * 0.036
    parts = [ellipsoid(palm_c, (0.03, 0.017, 0.042), 18, 12, "palm")]
    # rotate the palm ellipsoid to follow the arm
    for vt in parts[0].data.vertices:
        p = vt.co - palm_c
        q = Vector((0, 0, -1)).rotation_difference(d)
        vt.co = q @ p + palm_c
    for i, k in enumerate((-1.5, -0.5, 0.5, 1.5)):
        base = palm_c + d * 0.038 + out * (k * 0.0135) + fwd * 0.003
        mid = base + d * 0.03 + fwd * 0.008
        tip = mid + d * 0.024 + fwd * 0.012
        L = 1 - abs(k) * 0.06
        parts.append(capsule(base, base + (mid - base) * L, 0.0085, 0.0078, "finger"))
        parts.append(capsule(base + (mid - base) * L, base + (tip - base) * L, 0.0078, 0.0068, "finger"))
    tb = palm_c - out * 0.028 + fwd * 0.012 - d * 0.005
    parts.append(capsule(tb, tb + d * 0.028 - out * 0.012 + fwd * 0.014, 0.0095, 0.0082, "thumb"))
    o = join(parts, f"hand_{side}")
    remesh(o, 0.0022)
    laplace(o, 0.5, 2)
    decimate(o, 0.1)
    smooth(o)
    o.data.materials.clear()
    o.data.materials.append(mat("h_skin", 0.55))
    return o


def shoe(side):
    a = J[f"ankle_{side}"]
    c = Vector((a.x, a.y - 0.045, 0.0))
    upper = ellipsoid(c + Vector((0, -0.02, 0.055)), (0.05, 0.13, 0.052), 24, 14, "upper")
    toe = ellipsoid(c + Vector((0, -0.1, 0.035)), (0.048, 0.06, 0.034), 18, 12, "toe")
    collar = capsule(a + Vector((0, 0.0, -0.035)), a + Vector((0, 0.005, 0.02)), 0.047, 0.045, "collar")
    up = join([upper, toe, collar], f"shoe_{side}")
    remesh(up, 0.004)
    laplace(up, 0.5, 2)
    # flatten the bottom onto the sole
    for vt in up.data.vertices:
        if vt.co.z < 0.022:
            vt.co.z = 0.022
    decimate(up, 0.11)
    smooth(up)
    up.data.materials.clear()
    up.data.materials.append(mat("h_shoe", 0.5))
    sole = lib.box((0.104, 0.265, 0.026), (c.x, c.y - 0.035, 0.013), "h_sole", bevel=0.012)
    stripe = lib.box((0.003, 0.11, 0.022), (c.x + (0.051 if side == "L" else -0.051), c.y - 0.01, 0.05), "h_shoe_accent", bevel=0.001)
    to_mesh(sole)
    to_mesh(stripe)
    o = join([up, sole, stripe], f"shoe_{side}")
    return o


# ---------------------------------------------------------------- build
HEAD_SCALE = 1.36  # cartoon proportions: a big, expressive head
CHIN = Vector((0, 0.0, HEAD_C.z - 0.152))


def scale_about(o, pivot, k):
    for vt in o.data.vertices:
        vt.co = pivot + (vt.co - pivot) * k


def trims(body):
    """Clean edges for the clothing: a jacket hem, cuffs and the open front's facings."""
    out = {}
    hem = lib.torus(0.142, 0.016, (0, 0.0, 1.0), "h_jacket", major=32, minor=8)
    hem.scale = (1.0, 0.76, 1.0)
    out["hem"] = hem
    for side in ("L", "R"):
        w = J[f"wrist_{side}"]
        el = J[f"elbow_{side}"]
        d = (w - el).normalized()
        cuff = capsule(w - d * 0.03, w - d * 0.005, 0.046, 0.045, f"cuff_{side}")
        cuff.data.materials.append(mat("h_jacket"))
        out[f"cuff_{side}"] = cuff
    for s in (-1, 1):
        pts = []
        for z in [1.0 + i * 0.04 for i in range(11)]:
            hit, loc, n, i = body.ray_cast(Vector((s * 0.041, -1.0, z)), Vector((0, 1, 0)))
            if hit:
                pts.append((loc.x, loc.y - 0.002, loc.z))
        if len(pts) > 2:
            out[f"facing_{s}"] = lib.tube(pts, 0.0115, "h_jacket")
    for o in out.values():
        to_mesh(o)
        select_only(o)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return out


def build():
    lib.reset()
    body = body_mesh()
    assign_clothes(body)
    head = head_mesh()
    face = face_parts(head)
    hairs = {s: hairstyle(head, s) for s in ("short", "quiff", "curly", "buzz", "long", "bun")}
    for o in [head, *face.values(), *hairs.values()]:
        scale_about(o, CHIN, HEAD_SCALE)
    hands = {s: hand(s) for s in ("L", "R")}
    shoes = {s: shoe(s) for s in ("L", "R")}
    extra = trims(body)
    return body, head, face, hairs, hands, shoes, extra


if __name__ == "__main__" and False:  # (build via humanoid_rig.py)
    body, head, face, hairs, hands, shoes, extra = build()
    for n, h in hairs.items():
        h.hide_render = n != "short"
    if "--preview" in ARGS:
        out = os.path.join(lib.PREVIEWS, "human_front.png")
        lib.preview("human_front", dist=3.2, height=0.12, angle=0, res=(520, 760), target_z=0.95)
        lib.preview("human_three_quarter", dist=3.2, height=0.12, angle=-35, res=(520, 760), target_z=0.95)
        lib.preview("human_face", dist=0.85, height=0.02, angle=-25, res=(640, 640), target_z=1.62)
        lib.preview("human_side", dist=3.2, height=0.12, angle=-90, res=(520, 760), target_z=0.95)
    print("tris:", lib.tris())
