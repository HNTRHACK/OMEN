"""Street props for Blockhaven. Run:  python tools/blender/props.py [name ...]

Objects whose name starts with "dyn_" are kept as separate nodes so the game can animate them
(e.g. the relay lantern's crystal that lights up during the quest).
"""
import math
import os
import random
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
from lib import reset, box, cyl, ball, rounded, torus, wedge, tube, catenary, text, to_mesh_all, export, preview, tris, mat  # noqa: E402


def finish(name):
    """Join everything except dyn_* parts; keep those as children of the main mesh."""
    to_mesh_all()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    static = [o for o in objs if not o.name.startswith("dyn_")]
    dyn = [o for o in objs if o.name.startswith("dyn_")]
    bpy.ops.object.select_all(action="DESELECT")
    for o in static:
        o.select_set(True)
    bpy.context.view_layer.objects.active = static[0]
    bpy.ops.object.join()
    main = bpy.context.active_object
    main.name = name
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    for d in dyn:
        bpy.ops.object.select_all(action="DESELECT")
        d.select_set(True)
        bpy.context.view_layer.objects.active = d
        bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY")
        d.parent = main
    return main


def smooth(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth()
    return o


# ------------------------------------------------------------------ foliage


def tree_round():
    reset()
    cyl(0.16, 1.9, (0, 0, 0.95), "wood", verts=8, r2=0.11)
    cyl(0.06, 0.8, (0.25, 0, 1.5), "wood", verts=6, rot=(0, 35, 0))
    for (x, y, z, s, c) in ((0, 0, 2.3, 1.25, "leaf"), (0.55, 0.2, 2.0, 0.85, "leaf_dark"), (-0.5, -0.25, 2.1, 0.9, "leaf"), (0.1, -0.35, 2.85, 0.8, "leaf_dark"), (-0.2, 0.45, 2.7, 0.75, "leaf")):
        smooth(rounded((s, s, s * 0.85), (x, y, z), c, rot=(10, 20, 30)))
    return finish("tree_round")


def tree_cypress():
    reset()
    cyl(0.1, 0.8, (0, 0, 0.4), "wood", verts=6)
    smooth(rounded((0.9, 0.9, 3.0), (0, 0, 2.0), "leaf_dark"))
    smooth(rounded((0.6, 0.6, 1.2), (0.05, 0.05, 3.3), "leaf"))
    return finish("tree_cypress")


def tree_pine():
    reset()
    cyl(0.14, 1.1, (0, 0, 0.55), "wood", verts=8)
    for i, (r, z) in enumerate(((1.25, 1.3), (1.0, 2.1), (0.72, 2.85), (0.45, 3.5))):
        cyl(r, 1.0, (0, 0, z), "leaf_dark" if i % 2 == 0 else "leaf", verts=9, r2=0.05, rot=(0, 0, i * 17))
    return finish("tree_pine")


def bush():
    reset()
    for (x, y, s, c) in ((0, 0, 0.9, "leaf"), (0.45, 0.1, 0.65, "leaf_dark"), (-0.4, -0.05, 0.6, "leaf_dark")):
        smooth(rounded((s, s * 0.9, s * 0.75), (x, y, s * 0.35), c))
    for i in range(5):
        a = i * 1.3
        ball(0.07, (math.cos(a) * 0.35, math.sin(a) * 0.35 - 0.2, 0.6), "flower_pink" if i % 2 else "white", subdiv=1)
    return finish("bush")


# ------------------------------------------------------------------ street furniture


def lantern_post():
    reset()
    cyl(0.18, 0.2, (0, 0, 0.1), "ink", verts=10)
    cyl(0.06, 2.8, (0, 0, 1.5), "ink", verts=8)
    torus(0.08, 0.025, (0, 0, 2.4), "ink", major=10, minor=4)
    cyl(0.04, 0.55, (0.24, 0, 2.85), "ink", verts=6, rot=(0, 90, 0))
    tube([(0.5, 0, 2.85), (0.52, 0, 2.6)], 0.012, "ink")
    cyl(0.2, 0.1, (0.52, 0, 2.6), "ink", verts=8)
    cyl(0.15, 0.32, (0.52, 0, 2.37), "dyn_glow".replace("dyn_", ""), verts=8, r2=0.12, name="dyn_lamp")
    cyl(0.22, 0.12, (0.52, 0, 2.18), "ink", verts=8, r2=0.1)
    return finish("lantern_post")


def bench():
    reset()
    for i in range(3):
        box((1.8, 0.14, 0.06), (0, -0.2 + i * 0.16, 0.48), "wood_light", bevel=0.015)
    for i in range(2):
        box((1.8, 0.06, 0.13), (0, 0.24, 0.72 + i * 0.18), "wood_light", bevel=0.015)
    for s in (-1, 1):
        box((0.07, 0.5, 0.07), (s * 0.75, 0, 0.42), "ink", bevel=0.01)
        box((0.07, 0.07, 0.45), (s * 0.75, -0.2, 0.22), "ink", bevel=0.01)
        box((0.07, 0.07, 0.95), (s * 0.75, 0.24, 0.47), "ink", bevel=0.01)
    return finish("bench")


def fence():
    reset()
    box((2.0, 0.06, 0.08), (0, 0, 0.35), "white", bevel=0.01)
    box((2.0, 0.06, 0.08), (0, 0, 0.7), "white", bevel=0.01)
    for i in range(7):
        x = -0.9 + i * 0.3
        box((0.12, 0.05, 0.95), (x, 0, 0.47), "white", bevel=0.01)
        cyl(0.085, 0.12, (x, 0, 0.98), "white", verts=4, r2=0.0, rot=(0, 0, 45), bevel=0)
    return finish("fence")


def planter():
    reset()
    box((1.4, 0.5, 0.45), (0, 0, 0.22), "wood")
    box((1.5, 0.6, 0.06), (0, 0, 0.45), "wood_light")
    rng = random.Random(7)
    for i in range(9):
        x = -0.55 + (i % 5) * 0.27
        y = -0.1 + (i // 5) * 0.2
        rounded((0.22, 0.2, 0.25), (x, y, 0.58), "leaf")
        ball(0.075, (x + rng.uniform(-0.05, 0.05), y, 0.75), rng.choice(("flower_pink", "flower_yellow", "white", "red")), subdiv=1)
    return finish("planter")


def crates():
    reset()
    for (x, y, z, s, r) in ((0, 0, 0.3, 0.6, 5), (0.65, 0.05, 0.25, 0.5, -8), (0.25, 0.05, 0.85, 0.5, 12)):
        box((s, s, s), (x, y, z), "wood_light", rot=(0, 0, r))
        box((s + 0.02, s * 0.12, s + 0.02), (x, y, z), "wood", rot=(0, 0, r), bevel=0.01)
        box((s * 0.12, s + 0.02, s + 0.02), (x, y, z), "wood", rot=(0, 0, r), bevel=0.01)
    cyl(0.3, 0.75, (-0.7, 0.1, 0.37), "wood", verts=12)
    for z in (0.12, 0.62):
        cyl(0.31, 0.06, (-0.7, 0.1, z), "ink", verts=12, bevel=0)
    return finish("crates")


def signpost():
    reset()
    cyl(0.07, 2.4, (0, 0, 1.2), "wood", verts=8)
    ball(0.1, (0, 0, 2.42), "brass", subdiv=1)
    for i, (label, ang, col) in enumerate((("MAYA'S CHAI", 20, "butter"), ("RELAY WORKS", 160, "mint"), ("COURIER POST", -60, "cream"))):
        z = 2.0 - i * 0.38
        a = math.radians(ang)
        cx, cy = math.cos(a) * 0.55, math.sin(a) * 0.55
        box((1.05, 0.06, 0.28), (cx, cy, z), col, rot=(0, 0, ang))
        # text sits on the board's front face (board normal = rotate(-Y, ang))
        for side in (1, -1):
            nx, ny = math.sin(a) * 0.04 * side, -math.cos(a) * 0.04 * side
            text(label, 0.13, (cx + nx, cy + ny, z), "ink", extrude=0.006, rot=(90, 0, ang + (0 if side == 1 else 180)))
    return finish("signpost")


def noticeboard():
    """Environmental storytelling: the village is worried about its network."""
    reset()
    for s in (-1, 1):
        cyl(0.06, 1.9, (s * 0.8, 0, 0.95), "wood", verts=8)
    box((1.8, 0.1, 1.1), (0, 0, 1.35), "wood_light")
    wedge(2.0, 0.4, 0.3, (0, 0, 1.92), "brick", overhang=0.05)
    notes = (("RELAY DOWN\nAGAIN??", -0.5, 1.55, -4), ("LOST:\n1 PAYMENT\n#4127", 0.15, 1.5, 3), ("FESTIVAL\nTONIGHT", 0.55, 1.15, -2), ("WHO SIGNED\nBLOCK 88?", -0.45, 1.05, 5))
    for (label, x, z, r) in notes:
        box((0.48, 0.03, 0.36), (x, -0.07, z), "white", rot=(0, r, 0), bevel=0.005)
        text(label, 0.065, (x, -0.09, z), "ink", extrude=0.003, rot=(90, r, 0))
        ball(0.025, (x, -0.1, z + 0.15), "red", subdiv=1)
    return finish("noticeboard")


def relay_lantern():
    """The plaza's network lantern. Its crystal (dyn_crystal) is dark until KAI relights it."""
    reset()
    cyl(0.9, 0.3, (0, 0, 0.15), "stone_dark", verts=10)
    cyl(0.7, 0.3, (0, 0, 0.45), "stone", verts=10)
    cyl(0.18, 2.6, (0, 0, 1.9), "stone", verts=8)
    for z in (1.1, 2.6):
        torus(0.22, 0.05, (0, 0, z), "brass", major=12, minor=5)
    cyl(0.55, 0.12, (0, 0, 3.25), "brass", verts=8)
    for i in range(6):
        a = i / 6 * math.tau
        cyl(0.03, 1.0, (math.cos(a) * 0.45, math.sin(a) * 0.45, 3.8), "brass", verts=6)
    cyl(0.6, 0.5, (0, 0, 4.45), "slate", verts=8, r2=0.05)
    ball(0.1, (0, 0, 4.75), "brass", subdiv=1)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.32, location=(0, 0, 3.8))
    o = bpy.context.active_object
    o.scale = (1, 1, 1.5)
    o.name = "dyn_crystal"
    o.data.materials.append(mat("net_glow"))
    # little plaque
    box((0.7, 0.06, 0.3), (0, -0.72, 0.5), "brass", rot=(-15, 0, 0))
    text("RELAY 03", 0.09, (0, -0.76, 0.5), "ink", extrude=0.004, rot=(75, 0, 0))
    return finish("relay_lantern")


def well():
    reset()
    cyl(1.1, 0.8, (0, 0, 0.4), "stone", verts=14)
    cyl(0.85, 0.82, (0, 0, 0.42), "teal_light", verts=14, bevel=0)
    torus(1.1, 0.12, (0, 0, 0.82), "stone_dark", major=14, minor=6)
    for s in (-1, 1):
        box((0.15, 0.15, 2.0), (s * 0.95, 0, 1.4), "wood")
    wedge(2.4, 1.6, 0.7, (0, 0, 2.35), "brick", overhang=0.1)
    cyl(0.08, 2.0, (0, 0, 1.95), "wood", verts=8, rot=(0, 90, 0))
    tube([(0, 0, 1.9), (0, 0, 1.2)], 0.015, "ink")
    cyl(0.18, 0.25, (0, 0, 1.08), "wood_light", verts=10)
    return finish("well")


def market_stall():
    reset()
    box((2.2, 1.0, 0.85), (0, 0, 0.43), "wood_light")
    box((2.35, 1.1, 0.08), (0, 0, 0.87), "wood")
    for (x, c) in ((-0.7, "red"), (0.0, "flower_yellow"), (0.7, "leaf")):
        box((0.6, 0.6, 0.22), (x, -0.1, 1.0), "wood", bevel=0.01)
        for i in range(6):
            ball(0.1, (x - 0.18 + (i % 3) * 0.18, -0.25 + (i // 3) * 0.25, 1.17), c, subdiv=1)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl(0.04, 2.3, (sx * 1.05, sy * 0.45, 1.15), "wood", verts=6)
    for i in range(6):
        box((0.42, 1.4, 0.05), (-1.05 + i * 0.42, 0, 2.35), "teal" if i % 2 == 0 else "cream", rot=(-10, 0, 0), bevel=0.01)
    return finish("market_stall")


def rocks():
    reset()
    for (x, y, s) in ((0, 0, 0.7), (0.6, 0.2, 0.45), (-0.45, 0.35, 0.35)):
        o = ball(s, (x, y, s * 0.4), "stone", subdiv=1, scale=(1, 0.85, 0.65))
    return finish("rocks")


def string_pole():
    reset()
    cyl(0.07, 3.2, (0, 0, 1.6), "wood", verts=8)
    box((0.5, 0.06, 0.06), (0, 0, 3.1), "wood", bevel=0.01)
    return finish("string_pole")


PROPS = {f.__name__: f for f in (tree_round, tree_cypress, tree_pine, bush, lantern_post, bench, fence, planter, crates, signpost, noticeboard, relay_lantern, well, market_stall, rocks, string_pole)}

if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or list(PROPS)
    for n in names:
        o = PROPS[n]()
        export(n)
        print(f"{n}: {tris()} tris")
        if "--preview" in sys.argv:
            preview(n)
