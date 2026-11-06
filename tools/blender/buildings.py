"""Hero buildings for Blockhaven: Maya's tea stall, Orin's relay workshop, the courier post office,
and three modular houses. Run:  python tools/blender/buildings.py [name ...]
"""
import math
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from lib import reset, box, cyl, ball, rounded, torus, wedge, tube, catenary, text, join_all, export, preview, tris  # noqa: E402


def potted_plant(x, y, z=0, s=1.0, flower="flower_pink"):
    cyl(0.22 * s, 0.38 * s, (x, y, z + 0.19 * s), "brick", verts=10, r2=0.17 * s)
    rounded((0.5 * s, 0.5 * s, 0.45 * s), (x, y, z + 0.6 * s), "leaf")
    for i in range(3):
        a = i * 2.1
        ball(0.07 * s, (x + math.cos(a) * 0.17 * s, y + math.sin(a) * 0.17 * s, z + 0.78 * s), flower, subdiv=1)


def window(x, y, z, w=0.85, h=1.0, shutters="teal", facing=0):
    """Framed window on a wall facing -Y (facing=0) or ±X (facing=±90)."""
    rot = (0, 0, facing)
    box((w + 0.18, 0.1, h + 0.18), (x, y, z), "white", rot=rot)
    dy = -0.04
    if facing == 0:
        box((w, 0.08, h), (x, y + dy, z), "glass", bevel=0.01)
        box((0.05, 0.1, h), (x, y + dy - 0.01, z), "white", bevel=0)
        box((w, 0.1, 0.05), (x, y + dy - 0.01, z), "white", bevel=0)
        if shutters:
            for s in (-1, 1):
                box((w * 0.48, 0.06, h + 0.05), (x + s * (w * 0.5 + w * 0.28), y - 0.03, z), shutters)
        box((w + 0.3, 0.22, 0.08), (x, y - 0.1, z - h / 2 - 0.08), "white")  # sill
    else:
        sx = 1 if facing > 0 else -1
        box((0.08, w, h), (x + 0.04 * sx, y, z), "glass", bevel=0.01)


# ------------------------------------------------------------------ Maya's tea stall


def chai_shop():
    reset()
    box((5.6, 4.4, 0.25), (0, 0, 0.125), "stone")
    # ground floor: open front with a counter
    box((5.2, 0.25, 2.6), (0, 1.85, 1.55), "cream")
    for s in (-1, 1):
        box((0.25, 3.9, 2.6), (s * 2.48, 0, 1.55), "cream")
        box((0.32, 0.32, 2.6), (s * 2.42, -1.95, 1.55), "wood")
    box((5.3, 0.4, 0.42), (0, -1.98, 2.68), "wood")
    text("MAYA'S CHAI", 0.3, (0, -2.19, 2.66), "cream", extrude=0.02)
    # counter
    box((4.2, 0.7, 1.0), (0, -1.35, 0.75), "wood_light")
    box((4.45, 0.85, 0.1), (0, -1.35, 1.3), "wood")
    for x in (-1.35, 0, 1.35):
        box((1.1, 0.05, 0.6), (x, -1.71, 0.75), "plaster", bevel=0.02)
    # kettle on a little stove
    cyl(0.32, 0.12, (-1.25, -1.3, 1.41), "ink", verts=14)
    cyl(0.29, 0.44, (-1.25, -1.3, 1.69), "brass", verts=16, r2=0.24)
    cyl(0.12, 0.12, (-1.25, -1.3, 1.97), "brass", verts=12, r2=0.06)
    ball(0.05, (-1.25, -1.3, 2.05), "ink", subdiv=1)
    cyl(0.045, 0.42, (-0.98, -1.3, 1.8), "brass", verts=8, rot=(0, -55, 0))
    torus(0.18, 0.025, (-1.48, -1.3, 1.85), "ink", rot=(90, 0, 0), major=14, minor=6)
    # glasses of chai and jars of biscuits
    for i in range(5):
        cyl(0.07, 0.14, (0.0 + i * 0.2, -1.5, 1.42), "glass", verts=10, r2=0.06)
        cyl(0.062, 0.1, (0.0 + i * 0.2, -1.5, 1.41), "brick", verts=10, bevel=0)
    for i, c in enumerate(("butter", "flower_pink", "mint")):
        x = 1.25 + i * 0.32
        cyl(0.13, 0.32, (x, -1.2, 1.51), "glass", verts=12)
        cyl(0.11, 0.18, (x, -1.2, 1.45), c, verts=12, bevel=0)
        cyl(0.14, 0.06, (x, -1.2, 1.7), "brass", verts=12)
    # back shelves
    for z in (1.6, 2.2):
        box((3.8, 0.35, 0.07), (0, 1.58, z), "wood")
        for i in range(9):
            col = ("brass", "glass", "brick", "mint")[i % 4]
            cyl(0.09, 0.22, (-1.6 + i * 0.4, 1.58, z + 0.15), col, verts=10)
    # striped awning
    for i in range(8):
        x = -2.3 + i * 0.66
        box((0.66, 1.25, 0.06), (x, -2.55, 2.62), "red" if i % 2 == 0 else "cream", rot=(-18, 0, 0), bevel=0.01)
        cyl(0.15, 0.05, (x, -3.12, 2.47), "red" if i % 2 == 0 else "cream", verts=12, rot=(90, 0, 0), bevel=0)  # scallop
    # upper floor with a balcony
    box((5.4, 4.3, 0.2), (0, 0, 2.97), "wood")
    box((4.6, 3.4, 2.2), (0, 0.3, 4.17), "plaster")
    for x in (-1.15, 1.15):
        window(x, -1.4, 4.2)
    box((0.9, 0.1, 1.7), (0, -1.42, 3.95), "white")
    box((0.75, 0.12, 1.55), (0, -1.45, 3.92), "teal")  # balcony door
    box((5.2, 0.09, 0.09), (0, -2.05, 3.92), "wood")
    for i in range(14):
        box((0.06, 0.06, 0.8), (-2.55 + i * 0.39, -2.05, 3.47), "wood", bevel=0.01)
    for s in (-1, 1):
        box((0.09, 4.2, 0.09), (s * 2.6, -0.05, 3.92), "wood")
        box((1.0, 0.32, 0.26), (s * 1.6, -2.05, 4.1), "brick")
        for i in range(4):
            ball(0.1, (s * 1.6 - 0.35 + i * 0.23, -2.05, 4.3), "flower_pink" if i % 2 else "flower_yellow", subdiv=1)
            rounded((0.22, 0.2, 0.14), (s * 1.6 - 0.35 + i * 0.23, -2.05, 4.2), "leaf")
    # roof, chimney
    wedge(4.6, 3.4, 1.65, (0, 0.3, 5.27), "brick", overhang=0.38)
    box((5.4, 0.18, 0.16), (0, 0.3, 6.9), "wood")
    box((0.55, 0.55, 1.5), (1.45, 1.1, 6.1), "stone")
    box((0.72, 0.72, 0.14), (1.45, 1.1, 6.88), "stone_dark")
    # string lights under the awning edge
    pts = catenary((-2.6, -3.2, 2.35), (2.6, -3.2, 2.35), 0.25, 16)
    tube(pts, 0.012, "ink")
    for p in pts[1:-1:2]:
        ball(0.06, (p[0], p[1], p[2] - 0.07), "glow", subdiv=1)
    # street furniture
    for x in (-0.9, 0.7):
        cyl(0.04, 0.6, (x, -2.25, 0.3), "wood", verts=8)
        cyl(0.22, 0.07, (x, -2.25, 0.63), "teal", verts=12)
    # chalk menu on an easel
    box((0.75, 0.06, 0.95), (-3.1, -2.8, 1.05), "ink", rot=(-10, 0, 8))
    text("CHAI 10", 0.13, (-3.1, -2.86, 1.25), "white", extrude=0.005, rot=(80, 0, 8))
    text("BUN 15", 0.13, (-3.1, -2.86, 1.0), "white", extrude=0.005, rot=(80, 0, 8))
    for s in (-1, 1):
        box((0.05, 0.05, 1.2), (-3.1 + s * 0.3, -2.75, 0.6), "wood", rot=(-10, 0, 8))
    # bench + plants
    box((1.6, 0.45, 0.09), (3.3, -2.7, 0.48), "wood")
    box((1.6, 0.08, 0.4), (3.3, -2.48, 0.78), "wood")
    for s in (-1, 1):
        box((0.08, 0.4, 0.45), (3.3 + s * 0.7, -2.7, 0.24), "ink")
    potted_plant(-2.9, -1.6, 0.0, 1.1)
    potted_plant(2.9, -1.6, 0.0, 0.9, "flower_yellow")
    o = join_all("chai_shop")
    return o


# ------------------------------------------------------------------ Orin's relay workshop


def wall_point(r, theta_deg, z):
    t = math.radians(theta_deg)
    return (r * math.sin(t), -r * math.cos(t), z)


def gear(loc, r, rot, m="brass", teeth=10):
    cyl(r, 0.14, loc, m, verts=20, rot=rot)
    cyl(r * 0.35, 0.18, loc, "ink", verts=12, rot=rot)
    # teeth: small boxes around the rim (in the gear's local plane)
    import mathutils

    R = mathutils.Euler([math.radians(a) for a in rot]).to_matrix()
    for i in range(teeth):
        a = i / teeth * math.tau
        local = mathutils.Vector((math.cos(a) * r, math.sin(a) * r, 0))
        p = mathutils.Vector(loc) + R @ local
        box((0.16, 0.16, 0.14), tuple(p), m, rot=rot, bevel=0.01)


def workshop():
    reset()
    cyl(3.05, 1.0, (0, 0, 0.5), "stone_dark", verts=18)
    cyl(2.75, 3.1, (0, 0, 2.55), "wood_light", verts=18)
    for z in (1.15, 2.7, 4.0):
        cyl(2.82, 0.16, (0, 0, z), "wood", verts=18)
    # tilted conical roof, a crooked chimney, and the relay mast
    cyl(3.35, 2.5, (0.1, 0.15, 5.3), "slate", verts=18, r2=0.18, rot=(4, -5, 0))
    cyl(0.24, 1.5, (1.5, 0.9, 6.0), "brass", verts=10, rot=(0, 10, 0))
    ball(0.28, (1.63, 0.9, 6.8), "brass")
    cyl(0.22, 0.9, (1.95, 0.9, 7.05), "brass", verts=10, rot=(0, 55, 0))
    cyl(0.3, 0.12, (2.32, 0.9, 7.33), "ink", verts=10, rot=(0, 55, 0))
    cyl(0.07, 3.6, (-0.4, 0.3, 7.6), "ink", verts=8)
    for i, z in enumerate((6.6, 7.4, 8.2)):
        torus(0.42 - i * 0.08, 0.04, (-0.4, 0.3, z), "net_glow", major=20, minor=6)
    ball(0.16, (-0.4, 0.3, 9.45), "net_glow")
    # satellite dish on the roof
    cyl(0.95, 0.4, (-1.7, -0.6, 6.0), "white", verts=20, r2=0.12, rot=(-35, -25, 0))
    cyl(0.05, 0.9, (-1.6, -0.5, 5.6), "ink", verts=6)
    # arched door, steps, sign
    box((1.25, 0.35, 2.0), (0, -2.65, 1.0 + 0.05), "wood")
    cyl(0.62, 0.35, (0, -2.65, 2.05), "wood", verts=16, rot=(90, 0, 0))
    torus(0.66, 0.07, (0, -2.84, 2.05), "stone", rot=(90, 0, 0), major=20, minor=6)
    ball(0.06, (0.4, -2.86, 1.05), "brass", subdiv=1)
    box((1.8, 0.7, 0.18), (0, -3.15, 0.09), "stone")
    box((3.2, 0.12, 0.6), (0, -2.86, 3.35), "cream")
    text("ORIN'S RELAY WORKS", 0.24, (0, -2.94, 3.33), "ink", extrude=0.02)
    # porthole windows around the tower
    for th, z in ((-55, 2.2), (55, 2.2), (-110, 3.3), (110, 3.3), (180, 2.4)):
        p = wall_point(2.78, th, z)
        torus(0.42, 0.08, p, "brass", rot=(90, 0, th), major=18, minor=6)
        cyl(0.38, 0.06, p, "glass", verts=18, rot=(90, 0, th))
    # gears bolted to the wall
    gear(wall_point(2.85, 35, 3.3), 0.55, (90, 0, 35))
    gear(wall_point(2.85, 48, 2.55), 0.32, (90, 0, 48), "teal", teeth=8)
    # workbench with a radio, a screen showing the network, tools
    bx, by = 2.9, -3.0
    box((2.1, 0.85, 0.1), (bx, by, 0.92), "wood")
    for sx in (-0.9, 0.9):
        for sy in (-0.3, 0.3):
            box((0.09, 0.09, 0.9), (bx + sx, by + sy, 0.45), "wood")
    box((1.9, 0.75, 0.06), (bx, by, 0.3), "wood_light")
    box((0.7, 0.45, 0.5), (bx - 0.45, by + 0.1, 1.22), "teal")
    box((0.58, 0.05, 0.36), (bx - 0.45, by - 0.14, 1.24), "ink", bevel=0.01)
    box((0.48, 0.05, 0.26), (bx - 0.45, by - 0.17, 1.24), "net_glow", bevel=0)
    for i in range(3):
        cyl(0.05, 0.05, (bx - 0.62 + i * 0.17, by - 0.14, 1.03), "brass", verts=8, rot=(90, 0, 0))
    box((0.5, 0.3, 0.3), (bx + 0.5, by + 0.15, 1.12), "red")
    box((0.5, 0.3, 0.06), (bx + 0.5, by + 0.15, 1.3), "ink")
    cyl(0.025, 0.4, (bx + 0.1, by - 0.2, 0.99), "ink", verts=6, rot=(0, 90, 20))
    # crates and a coil of cable
    for (x, y, z, s) in ((-3.0, -2.4, 0.4, 0.8), (-3.05, -2.45, 1.2, 0.7), (-3.9, -2.1, 0.35, 0.7)):
        box((s, s, s), (x, y, z), "wood_light")
        box((s + 0.02, s * 0.15, s + 0.02), (x, y, z), "wood", bevel=0.01)
    torus(0.35, 0.06, (-2.2, -3.4, 0.08), "ink", major=20, minor=6)
    tube(catenary((-0.4, 0.3, 6.2), (bx - 0.6, by + 0.3, 1.5), 1.4, 18), 0.03, "ink")
    potted_plant(1.3, -3.1, 0, 0.9, "flower_yellow")
    return join_all("workshop")


# ------------------------------------------------------------------ the courier post office


def post_office():
    reset()
    box((7.6, 5.6, 0.3), (0, 0, 0.15), "stone")
    box((7.0, 5.0, 4.6), (0, 0, 2.6), "cream")
    for sx in (-1, 1):
        box((0.42, 0.42, 4.6), (sx * 3.4, -2.42, 2.6), "stone")
        box((0.42, 0.42, 4.6), (sx * 3.4, 2.42, 2.6), "stone")
    box((7.5, 5.5, 0.32), (0, 0, 5.05), "stone")
    box((7.5, 0.25, 0.25), (0, -2.6, 2.95), "stone")
    wedge(7.0, 5.0, 1.9, (0, 0, 5.2), "slate", overhang=0.3)
    # dormer with the clock
    box((1.9, 1.0, 1.6), (0, -2.0, 6.0), "cream")
    wedge(1.9, 1.0, 0.8, (0, -2.0, 6.8), "slate", overhang=0.15, rot=(0, 0, 90))
    cyl(0.62, 0.14, (0, -2.55, 6.0), "white", verts=24, rot=(90, 0, 0))
    torus(0.64, 0.06, (0, -2.62, 6.0), "brass", rot=(90, 0, 0), major=24, minor=6)
    for i in range(12):
        a = i / 12 * math.tau
        box((0.04, 0.03, 0.12 if i % 3 == 0 else 0.07), (math.sin(a) * 0.5, -2.64, 6.0 + math.cos(a) * 0.5), "ink", rot=(0, math.degrees(a), 0), bevel=0)
    box((0.05, 0.03, 0.36), (0.0, -2.66, 6.16), "ink", bevel=0)
    box((0.05, 0.03, 0.3), (0.12, -2.66, 5.95), "ink", rot=(0, 120, 0), bevel=0)
    # door, steps, sign
    box((1.7, 0.25, 2.5), (0, -2.45, 1.55), "white")
    box((1.4, 0.3, 2.3), (0, -2.47, 1.45), "navy")
    cyl(0.7, 0.3, (0, -2.47, 2.6), "navy", verts=18, rot=(90, 0, 0))
    ball(0.07, (0.45, -2.66, 1.35), "brass", subdiv=1)
    for i in range(3):
        box((2.6 - i * 0.3, 0.45, 0.15), (0, -2.95 + i * 0.25, 0.08 + i * 0.15), "stone")
    box((4.6, 0.14, 0.62), (0, -2.58, 3.55), "navy")
    text("COURIER POST", 0.36, (0, -2.66, 3.53), "white", extrude=0.02)
    # big envelope emblem
    box((0.9, 0.06, 0.6), (-2.3, -2.58, 3.55), "butter")
    wedge(0.9, 0.06, 0.32, (-2.3, -2.61, 3.55), "brass", rot=(-90, 0, 0), bevel=0.01)
    box((0.9, 0.06, 0.6), (2.3, -2.58, 3.55), "butter")
    wedge(0.9, 0.06, 0.32, (2.3, -2.61, 3.55), "brass", rot=(-90, 0, 0), bevel=0.01)
    # windows
    for x in (-2.35, 2.35):
        window(x, -2.52, 1.6, 1.0, 1.4, "navy")
    for x in (-2.3, 0, 2.3):
        window(x, -2.52, 4.3 - 0.1, 0.9, 0.8, None)
    for y in (-1.0, 1.0):
        window(3.52, y, 1.8, 0.9, 1.2, None, facing=90)
        window(-3.52, y, 1.8, 0.9, 1.2, None, facing=-90)
    # mail slots, mailbox, parcels, flag
    for i in range(3):
        box((0.36, 0.06, 0.08), (-1.3, -2.53, 1.3 + i * 0.25), "brass", bevel=0.01)
    cyl(0.32, 1.0, (-3.0, -3.5, 0.5), "red", verts=16)
    ball(0.33, (-3.0, -3.5, 1.0), "red", scale=(1, 1, 0.55))
    box((0.3, 0.05, 0.05), (-3.0, -3.83, 0.82), "ink", bevel=0)
    for (x, y, z, s, c) in ((2.4, -3.3, 0.25, 0.5, "wood_light"), (2.8, -3.2, 0.2, 0.4, "butter"), (2.55, -3.25, 0.62, 0.36, "wood_light")):
        box((s, s * 0.8, s), (x, y, z), c)
        box((s + 0.02, 0.04, s + 0.02), (x, y, z), "ink", bevel=0)
    cyl(0.06, 5.5, (4.3, -2.0, 2.75), "white", verts=8)
    ball(0.12, (4.3, -2.0, 5.55), "brass", subdiv=1)
    box((1.2, 0.04, 0.75), (4.92, -2.0, 5.0), "teal", bevel=0.01)
    box((0.5, 0.05, 0.32), (4.92, -2.03, 5.0), "butter", bevel=0.01)
    # courier cart
    box((1.2, 0.8, 0.5), (-4.5, -1.5, 0.65), "teal")
    for sy in (-0.45, 0.45):
        cyl(0.3, 0.08, (-4.5, -1.5 + sy, 0.3), "ink", verts=14, rot=(90, 0, 0))
    cyl(0.03, 1.0, (-5.2, -1.5, 0.75), "wood", verts=6, rot=(0, 60, 0))
    box((0.45, 0.35, 0.3), (-4.6, -1.5, 1.05), "butter")
    potted_plant(1.6, -3.1, 0, 0.9)
    potted_plant(-1.6, -3.1, 0, 0.9, "flower_yellow")
    return join_all("post_office")


# ------------------------------------------------------------------ modular houses


def house(name, w, d, floors, wall, roof, roof_kind, seed):
    reset()
    import random

    rnd = random.Random(seed)
    h = 2.6 * floors
    box((w + 0.3, d + 0.3, 0.22), (0, 0, 0.11), "stone")
    box((w, d, h), (0, 0, 0.22 + h / 2), wall)
    top = 0.22 + h
    if roof_kind == "gable":
        wedge(w, d, 1.5, (0, 0, top), roof, overhang=0.32)
        box((0.5, 0.5, 1.4), (w * 0.28, d * 0.2, top + 0.9), "stone")
    elif roof_kind == "side":
        wedge(d, w, 1.4, (0, 0, top), roof, overhang=0.3, rot=(0, 0, 90))
        box((0.45, 0.45, 1.3), (-w * 0.2, d * 0.25, top + 0.8), "brick")
    else:  # flat roof terrace with a water tank and a little shed
        box((w + 0.2, d + 0.2, 0.25), (0, 0, top + 0.12), "stone")
        for sx in (-1, 1):
            box((0.12, d + 0.2, 0.5), (sx * (w / 2 + 0.04), 0, top + 0.5), "stone")
        box((w + 0.2, 0.12, 0.5), (0, -(d / 2 + 0.04), top + 0.5), "stone")
        cyl(0.45, 0.8, (w * 0.25, d * 0.15, top + 0.65), "ink", verts=12)
        box((1.2, 1.0, 1.0), (-w * 0.2, d * 0.2, top + 0.75), roof)
    # door with a canopy and a step
    dx = rnd.choice((-0.25, 0.0, 0.25)) * w
    box((0.95, 0.12, 1.95), (dx, -d / 2 - 0.02, 1.2), rnd.choice(("teal", "navy", "red", "wood")))
    box((1.25, 0.6, 0.08), (dx, -d / 2 - 0.3, 2.35), roof, rot=(-12, 0, 0))
    box((1.2, 0.45, 0.14), (dx, -d / 2 - 0.25, 0.07), "stone")
    ball(0.05, (dx + 0.3, -d / 2 - 0.1, 1.15), "brass", subdiv=1)
    # windows with flower boxes
    for f in range(floors):
        z = 1.6 + f * 2.6
        xs = (-w * 0.3, w * 0.3) if f == 0 else (-w * 0.3, 0.0, w * 0.3)
        for x in xs:
            if f == 0 and abs(x - dx) < 0.9:
                continue
            window(x, -d / 2 - 0.02, z, 0.7, 0.9, rnd.choice(("teal", "mint", "slate", None)))
            if rnd.random() < 0.65:
                box((0.85, 0.28, 0.2), (x, -d / 2 - 0.2, z - 0.62), "brick")
                for i in range(4):
                    ball(0.08, (x - 0.3 + i * 0.2, -d / 2 - 0.2, z - 0.45), rnd.choice(("flower_pink", "flower_yellow", "white")), subdiv=1)
        for y in (-d * 0.2, d * 0.2):
            window(w / 2 + 0.02, y, z, 0.6, 0.8, None, facing=90)
    if floors > 1 and rnd.random() < 0.6:
        box((w * 0.6, 0.8, 0.12), (0, -d / 2 - 0.4, 2.85), "wood")
        box((w * 0.6, 0.06, 0.06), (0, -d / 2 - 0.78, 3.55), "wood")
        for i in range(int(w * 0.6 / 0.3) + 1):
            box((0.05, 0.05, 0.7), (-w * 0.3 + i * 0.3, -d / 2 - 0.78, 3.2), "wood", bevel=0)
    return join_all(name)


HOUSES = {
    "house_a": dict(w=3.6, d=3.4, floors=2, wall="cream", roof="brick", roof_kind="gable", seed=1),
    "house_b": dict(w=3.2, d=3.2, floors=2, wall="plaster", roof="slate", roof_kind="side", seed=2),
    "house_c": dict(w=3.8, d=3.4, floors=1, wall="mint", roof="moss", roof_kind="flat", seed=3),
    "house_d": dict(w=3.0, d=3.0, floors=3, wall="butter", roof="brick", roof_kind="side", seed=4),
}

BUILDS = {"chai_shop": chai_shop, "workshop": workshop, "post_office": post_office}
for k, v in HOUSES.items():
    BUILDS[k] = (lambda k=k, v=v: house(k, **v))

if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or list(BUILDS)
    do_preview = "--no-preview" not in sys.argv
    for n in names:
        o = BUILDS[n]()
        path = export(n)
        print(f"{n}: {tris(o)} tris -> {os.path.relpath(path)}")
        if do_preview:
            preview(n)
