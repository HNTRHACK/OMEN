"""Mumbai props for the Final Block's second planet. Run headless:
  blender -b --python tools/blender/mumbai.py -- [name ...] [--preview]
Original, stylised pieces in OMEN's toy style (not replicas): a Gateway-style harbour arch,
a kaali-peeli taxi, a local-train carriage, a vada pav cart and a sea wall with palms.
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
from lib import reset, box, cyl, ball, rounded, tube, text, to_mesh_all, export, preview, tris  # noqa: E402


def finish(name):
    to_mesh_all()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    return o


def gateway_arch():
    """Harbour arch: a big central arch, two side bays, four corner turrets with domes."""
    reset()
    W, D, H = 9.0, 3.0, 5.2
    b = 0.35
    box((W + 0.6, D + 0.6, b), (0, 0, b / 2), "basalt_dark", bevel=0.05)
    for x in (-3.9, -1.95, 1.95, 3.9):
        w = 1.1 if abs(x) > 3 else 0.9
        box((w, D, H), (x, 0, b + H / 2), "basalt", bevel=0.06)
    # central bay: solid upper wall with a dark arched opening inset front and back
    box((3.0, D, H - 3.1), (0, 0, b + 3.1 + (H - 3.1) / 2), "basalt", bevel=0.04)
    for y in (-D / 2 - 0.02, D / 2 + 0.02):
        box((2.4, 0.06, 3.1), (0, y, b + 1.55), "black", bevel=0.0)
        cyl(1.2, 0.06, (0, y, b + 3.1), "black", verts=24, rot=(90, 0, 0), bevel=0.0)
    box((2.4, D - 0.2, 0.05), (0, 0, b + 0.03), "black", bevel=0.0)
    # side bays
    for x in (-2.95, 2.95):
        box((1.0, D, H - 2.0), (x, 0, b + 2.0 + (H - 2.0) / 2), "basalt", bevel=0.04)
        for y in (-D / 2 - 0.02, D / 2 + 0.02):
            box((0.9, 0.06, 2.0), (x, y, b + 1.0), "black", bevel=0.0)
            cyl(0.45, 0.06, (x, y, b + 2.0), "black", verts=16, rot=(90, 0, 0), bevel=0.0)
    # cornice + parapet
    box((W + 0.3, D + 0.3, 0.3), (0, 0, b + H + 0.15), "basalt_dark", bevel=0.04)
    for i in range(13):
        box((0.32, D + 0.2, 0.3), (-4.2 + i * 0.7, 0, b + H + 0.45), "basalt", bevel=0.03)
    # corner turrets with domes, taller central crown
    for x in (-4.3, 4.3):
        for y in (-1.2, 1.2):
            cyl(0.45, 1.2, (x, y, b + H + 0.9), "basalt", verts=12)
            ball(0.5, (x, y, b + H + 1.6), "white", subdiv=2, scale=(1, 1, 1.15))
            cyl(0.05, 0.4, (x, y, b + H + 2.2), "brass", verts=6)
    box((3.4, D - 0.4, 1.0), (0, 0, b + H + 0.8), "basalt", bevel=0.05)
    ball(1.1, (0, 0, b + H + 1.5), "white", subdiv=3, scale=(1, 1, 0.9))
    cyl(0.07, 0.7, (0, 0, b + H + 2.7), "brass", verts=6)
    # jaali band
    for y in (-D / 2 - 0.05, D / 2 + 0.05):
        for i in range(9):
            box((0.12, 0.04, 0.6), (-1.2 + i * 0.3, y, b + H - 0.45), "basalt_dark", bevel=0.0)
    return finish("gateway_arch")


def kaali_peeli():
    """Mumbai taxi: black lower body, yellow roof, round headlights, roof rack."""
    reset()
    L, Wd = 3.6, 1.5
    box((L, Wd, 0.6), (0, 0, 0.55), "black", bevel=0.12, segments=3)
    box((2.0, Wd - 0.1, 0.55), (-0.15, 0, 1.12), "taxi_yellow", bevel=0.1, segments=3)
    for x in (-0.65, 0.35):
        for y in (-(Wd - 0.1) / 2 - 0.01, (Wd - 0.1) / 2 + 0.01):
            box((0.8, 0.03, 0.36), (x, y, 1.13), "glass", bevel=0.01)
    box((0.04, Wd - 0.3, 0.36), (0.86, 0, 1.13), "glass", bevel=0.01, rot=(0, -20, 0))
    box((0.04, Wd - 0.3, 0.36), (-1.16, 0, 1.13), "glass", bevel=0.01, rot=(0, 20, 0))
    for x in (-1.15, 1.15):
        for y in (-Wd / 2, Wd / 2):
            cyl(0.32, 0.22, (x, y, 0.32), "ink", verts=14, rot=(90, 0, 0))
            cyl(0.14, 0.24, (x, y, 0.32), "steel", verts=10, rot=(90, 0, 0))
    for y in (-0.5, 0.5):
        cyl(0.13, 0.06, (L / 2 + 0.01, y, 0.65), "glow", verts=12, rot=(0, 90, 0))
    box((0.04, 0.6, 0.22), (L / 2 + 0.01, 0, 0.6), "steel", bevel=0.01)
    box((0.12, Wd + 0.05, 0.12), (L / 2 + 0.04, 0, 0.36), "steel", bevel=0.03)
    box((0.12, Wd + 0.05, 0.12), (-L / 2 - 0.04, 0, 0.36), "steel", bevel=0.03)
    for y in (-0.5, 0.5):
        tube([(-0.9, y, 1.55), (0.6, y, 1.55)], 0.03, "steel")
    box((0.5, 0.18, 0.16), (0.3, 0, 1.55), "taxi_yellow", bevel=0.02)
    return finish("kaali_peeli")


def local_train():
    """One local-train carriage on a stub of track: maroon with a yellow stripe and open doors."""
    reset()
    L, Wd, Hh = 7.0, 2.2, 2.4
    for y in (-0.72, 0.72):
        box((L + 1.4, 0.08, 0.1), (0, y, 0.12), "steel", bevel=0.01)
    for i in range(11):
        box((0.22, 2.0, 0.08), (-L / 2 - 0.4 + i * 0.78, 0, 0.04), "wood", bevel=0.01)
    for x in (-2.4, 2.4):
        box((1.6, 1.6, 0.35), (x, 0, 0.42), "ink", bevel=0.03)
        for dx in (-0.45, 0.45):
            for y in (-0.72, 0.72):
                cyl(0.28, 0.1, (x + dx, y, 0.42), "steel", verts=12, rot=(90, 0, 0))
    box((L, Wd, Hh), (0, 0, 0.62 + Hh / 2), "local_maroon", bevel=0.15, segments=3)
    cyl(Wd / 2 - 0.05, L - 0.1, (0, 0, 0.62 + Hh - 0.25), "steel", verts=16, rot=(0, 90, 0), bevel=0.0)
    box((L + 0.02, Wd + 0.02, 0.22), (0, 0, 0.62 + 0.95), "taxi_yellow", bevel=0.0)
    for y in (-Wd / 2 - 0.01, Wd / 2 + 0.01):
        for x in (-2.6, -1.9, 1.9, 2.6, -0.35, 0.35):
            box((0.5, 0.03, 0.5), (x, y, 0.62 + 1.55), "glass", bevel=0.01)
        for x in (-1.15, 1.15):
            box((0.85, 0.04, 1.85), (x, y, 0.62 + 1.05), "black", bevel=0.01)
    for x in (-L / 2 - 0.01, L / 2 + 0.01):
        box((0.04, 1.0, 1.5), (x, 0, 0.62 + 1.2), "black", bevel=0.01)
    return finish("local_train")


def vada_pav_cart():
    """Hand cart with a kadhai, a pav stack, a striped canopy and a sign."""
    reset()
    box((1.6, 0.9, 0.12), (0, 0, 0.8), "wood_light", bevel=0.02)
    box((1.6, 0.9, 0.45), (0, 0, 0.52), "red", bevel=0.03)
    for x in (-0.55, 0.55):
        for y in (-0.48, 0.48):
            cyl(0.3, 0.06, (x, y, 0.3), "ink", verts=14, rot=(90, 0, 0))
    tube([(-0.8, 0, 0.9), (-1.3, 0, 0.95)], 0.03, "wood")
    cyl(0.22, 0.12, (-0.35, 0, 0.92), "steel", verts=12)
    cyl(0.32, 0.12, (-0.35, 0, 1.03), "black", verts=16, r2=0.2)
    for i in range(5):
        a = i / 5 * math.tau
        ball(0.07, (-0.35 + 0.15 * math.cos(a), 0.15 * math.sin(a), 1.1), "brass", subdiv=1)
    for i, (x, y) in enumerate(((0.25, -0.15), (0.4, -0.15), (0.25, 0.0), (0.4, 0.0), (0.32, -0.07))):
        ball(0.09, (x, y, 0.92 + (0.09 if i == 4 else 0)), "butter", subdiv=1, scale=(1, 1, 0.75))
    for i, c in enumerate(("leaf", "red", "taxi_yellow")):
        cyl(0.06, 0.14, (0.62, -0.25 + i * 0.18, 0.93), c, verts=8)
    for x in (-0.72, 0.72):
        for y in (-0.4, 0.4):
            cyl(0.03, 1.2, (x, y, 1.45), "wood", verts=6)
    for i in range(6):
        box((0.3, 1.1, 0.05), (-0.75 + i * 0.3, 0, 2.08), "red" if i % 2 else "white", bevel=0.0)
    box((1.0, 0.04, 0.26), (0, -0.47, 1.85), "taxi_yellow", bevel=0.02)
    text("VADA PAV", 0.15, (0, -0.5, 1.8), "ink", rot=(90, 0, 0))
    return finish("vada_pav_cart")


def sea_wall():
    """A stretch of sea-front wall (tetrapods on the sea side) with two palms on the promenade."""
    reset()
    L = 8.0
    box((L, 0.6, 0.8), (0, 0, 0.4), "stone", bevel=0.05)
    box((L, 0.7, 0.12), (0, 0, 0.86), "stone_dark", bevel=0.03)
    for i in range(9):
        x = -L / 2 + 0.5 + i * 0.88
        for k in range(3):
            a = k / 3 * math.tau + i
            tube([(x, 0.9, 0.2), (x + 0.3 * math.cos(a), 0.9 + 0.3 * math.sin(a), 0.2 + 0.25 * (k % 2))], 0.09, "stone_dark")
    box((L + 0.4, 1.6, 0.05), (0, 1.4, 0.02), "sea", bevel=0.0)
    for x, lean in ((-2.4, 8), (2.1, -6)):
        pts = [(x + math.sin(math.radians(lean)) * t * 3.6, -0.9, t * 3.6) for t in (0, 0.25, 0.5, 0.75, 1.0)]
        tube(pts, 0.11, "wood")
        top = pts[-1]
        for k in range(7):
            a = k / 7 * math.tau
            ball(0.7, (top[0] + 0.55 * math.cos(a), top[1] + 0.55 * math.sin(a), top[2] - 0.15), "leaf", subdiv=1, scale=(1.0, 0.28, 0.08))
        ball(0.18, (top[0], top[1], top[2] - 0.05), "wood", subdiv=1)
    return finish("sea_wall")


PROPS = {f.__name__: f for f in (gateway_arch, kaali_peeli, local_train, vada_pav_cart, sea_wall)}

if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    names = [a for a in argv if not a.startswith("-")] or list(PROPS)
    for n in names:
        PROPS[n]()
        export(n)
        print(f"{n}: {tris()} tris")
        if "--preview" in argv:
            preview(n)
