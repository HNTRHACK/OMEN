"""Characters for OMEN: KAI the courier, Maya the tea seller, Orin the relay engineer, and Echo.

Each character is exported as a node tree the game animates directly:
    <name> (root)
      ├─ legL, legR            pivot at the hips
      └─ body                  pivot at the hips (bobs, leans)
           ├─ head             pivot at the neck
           └─ armL, armR       pivot at the shoulders
Front faces -Y in Blender (+Z in the game). Run:  python tools/blender/characters.py [name ...]
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
from lib import reset, box, cyl, rounded, torus, export, preview, tris  # noqa: E402
from lib import ball as _ball  # noqa: E402


def ball(*a, **k):
    """Spheres on characters are smooth-shaded so hands and buns don't look faceted."""
    o = _ball(*a, **k)
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth()
    return o

PIVOTS = {
    "legL": (-0.12, 0, 0.72),
    "legR": (0.12, 0, 0.72),
    "body": (0, 0, 0.72),
    "head": (0, 0, 1.34),
    "armL": (-0.3, 0, 1.25),
    "armR": (0.3, 0, 1.25),
}


def soft(size, loc, m, rot=(0, 0, 0), smooth=2):
    o = rounded(size, loc, m, rot=rot, smooth=smooth)
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth()
    return o


class Rig:
    def __init__(self):
        self.parts = {k: [] for k in PIVOTS}
        self.cur = None

    def part(self, name):
        self.cur = name
        return self

    def add(self, o):
        self.parts[self.cur].append(o)
        return o

    def build(self, root_name, scale=1.0):
        objs = {}
        for name, items in self.parts.items():
            if not items:
                continue
            bpy.ops.object.select_all(action="DESELECT")
            for o in items:
                o.select_set(True)
            bpy.context.view_layer.objects.active = items[0]
            bpy.ops.object.convert(target="MESH")
            bpy.ops.object.join()
            o = bpy.context.active_object
            o.name = name
            o.data.name = f"{root_name}_{name}"
            bpy.context.scene.cursor.location = PIVOTS[name]
            bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
            objs[name] = o
        root = bpy.data.objects.new(root_name, None)
        bpy.context.collection.objects.link(root)

        def parent(child, par):
            child.parent = par
            child.matrix_parent_inverse = par.matrix_world.inverted()

        for n in ("legL", "legR", "body"):
            parent(objs[n], root)
        for n in ("head", "armL", "armR"):
            parent(objs[n], objs["body"])
        root.scale = (scale, scale, scale)
        bpy.context.scene.cursor.location = (0, 0, 0)
        return root


def base(r, c):
    """Shared body: legs, torso, arms, head, eyes. `c` holds colours/options."""
    s = c.get("skin", "skin")
    r.part("legL").add(soft((0.23, 0.25, 0.6), (-0.115, 0, 0.41), c["pants"]))
    r.add(soft((0.24, 0.34, 0.16), (-0.12, -0.05, 0.08), c["shoes"]))
    r.part("legR").add(soft((0.23, 0.25, 0.6), (0.115, 0, 0.41), c["pants"]))
    r.add(soft((0.24, 0.34, 0.16), (0.12, -0.05, 0.08), c["shoes"]))
    r.part("body")
    r.add(soft((0.5, 0.34, 0.22), (0, 0, 0.76), c["pants"]))
    r.add(soft((0.58, 0.38, 0.62), (0, 0, 1.04), c["shirt"]))
    r.add(cyl(0.09, 0.14, (0, 0, 1.36), s, verts=10))
    for side, key in ((-1, "armL"), (1, "armR")):
        r.part(key)
        r.add(soft((0.17, 0.18, 0.5), (side * 0.325, 0, 1.05), c.get("sleeves", c["shirt"])))
        r.add(ball(0.085, (side * 0.335, 0, 0.78), s, subdiv=2))
    r.part("head")
    r.add(soft((0.5, 0.46, 0.48), (0, 0, 1.58), s))
    for side in (-1, 1):
        r.add(soft((0.06, 0.03, 0.1), (side * 0.11, -0.225, 1.58), "ink", smooth=1))
        if c.get("blush", True):
            r.add(ball(0.045, (side * 0.17, -0.2, 1.49), "flower_pink", subdiv=1, scale=(1, 0.4, 0.6)))
    r.add(soft((0.06, 0.04, 0.05), (0, -0.24, 1.52), c.get("nose", s), smooth=1))


def kai():
    reset()
    r = Rig()
    c = dict(pants="navy", shoes="wood", shirt="teal", sleeves="teal")
    base(r, c)
    r.part("head")
    r.add(soft((0.54, 0.5, 0.18), (0, 0.01, 1.83), "red"))  # courier cap
    r.add(box((0.4, 0.26, 0.05), (0, -0.3, 1.78), "red", rot=(-8, 0, 0), bevel=0.02))
    r.add(soft((0.1, 0.06, 0.06), (0, -0.25, 1.9), "butter", smooth=1))  # cap badge
    r.add(soft((0.5, 0.12, 0.3), (0, 0.22, 1.62), "hair"))
    r.add(soft((0.46, 0.1, 0.1), (0, -0.19, 1.72), "hair"))  # fringe under the cap
    for side in (-1, 1):
        r.add(soft((0.06, 0.2, 0.18), (side * 0.245, 0.06, 1.6), "hair"))
    r.part("body")
    r.add(torus(0.17, 0.065, (0, 0, 1.33), "butter", major=16, minor=8))  # scarf
    r.add(soft((0.12, 0.06, 0.32), (0.12, -0.2, 1.18), "butter", rot=(0, 15, 0)))
    r.add(box((0.04, 0.02, 0.5), (0, -0.2, 1.05), "teal_light", bevel=0))  # zip
    r.add(box((0.07, 0.62, 0.05), (0, 0, 1.06), "wood", rot=(0, 52, 0), bevel=0.01))  # strap
    r.add(soft((0.14, 0.34, 0.3), (0.34, 0.02, 0.86), "wood"))  # satchel
    r.add(box((0.16, 0.36, 0.08), (0.35, 0.02, 1.0), "wood_light", bevel=0.02))
    r.add(box((0.04, 0.2, 0.12), (0.44, -0.04, 0.9), "butter", bevel=0.005))  # letter peeking out
    return r.build("kai")


def maya():
    reset()
    r = Rig()
    c = dict(pants="cream", shoes="wood", shirt="plaster", sleeves="plaster")
    base(r, c)
    r.part("body")
    r.add(soft((0.62, 0.42, 0.62), (0, 0, 0.72), "plaster"))  # long kurta
    r.add(soft((0.38, 0.06, 0.5), (0, -0.2, 0.82), "cream"))  # apron
    r.add(soft((0.14, 0.04, 0.1), (0.08, -0.23, 0.78), "white", smooth=1))
    r.add(soft((0.66, 0.44, 0.2), (0, 0.02, 1.28), "teal", rot=(0, 8, 0)))  # shawl
    r.add(soft((0.18, 0.1, 0.45), (-0.22, 0.12, 1.08), "teal", rot=(0, -10, 0)))
    r.part("head")
    r.add(soft((0.52, 0.48, 0.2), (0, 0.02, 1.78), "hair"))
    r.add(soft((0.5, 0.18, 0.4), (0, 0.17, 1.6), "hair"))
    r.add(ball(0.15, (0, 0.24, 1.82), "hair", subdiv=2))  # bun
    r.add(ball(0.06, (0.12, 0.22, 1.90), "flower_yellow", subdiv=1))
    for side in (-1, 1):
        r.add(ball(0.03, (side * 0.255, -0.02, 1.48), "brass", subdiv=1))
    return r.build("maya", 0.96)


def orin():
    reset()
    r = Rig()
    c = dict(pants="ink", shoes="ink", shirt="mint", sleeves="slate", nose="skin")
    base(r, c)
    r.part("body")
    r.add(soft((0.66, 0.44, 0.95), (0, 0.02, 0.86), "slate"))  # long coat
    r.add(box((0.68, 0.46, 0.08), (0, 0.02, 0.78), "brass", bevel=0.02))  # tool belt
    r.add(box((0.12, 0.06, 0.18), (-0.18, -0.24, 0.66), "wood", bevel=0.02))
    r.add(cyl(0.02, 0.22, (0.16, -0.24, 0.98), "brass", verts=6))  # screwdriver in pocket
    r.part("head")
    for (x, y, z, s) in ((0, 0.05, 1.86, 0.2), (-0.22, 0.02, 1.78, 0.15), (0.22, 0.02, 1.8, 0.16), (-0.14, 0.18, 1.84, 0.15), (0.15, 0.18, 1.86, 0.14), (0, 0.22, 1.71, 0.16)):
        r.add(ball(s, (x, y, z), "white", subdiv=2))  # wild hair
    r.add(soft((0.36, 0.14, 0.2), (0, -0.2, 1.39), "white"))  # beard
    for side in (-1, 1):
        r.add(torus(0.075, 0.022, (side * 0.11, -0.23, 1.75), "brass", rot=(90, 0, 0), major=14, minor=5))
        r.add(cyl(0.065, 0.02, (side * 0.11, -0.235, 1.75), "teal_light", verts=12, rot=(90, 0, 0)))
    r.add(box((0.5, 0.06, 0.04), (0, -0.2, 1.75), "ink", bevel=0))
    return r.build("orin", 1.06)


def echo():
    reset()
    r = Rig()
    c = dict(pants="ink", shoes="ink", shirt="cloak", sleeves="cloak", skin="ink", nose="ink", blush=False)
    base(r, c)
    r.part("body")
    r.add(soft((0.74, 0.56, 1.2), (0, 0.03, 0.72), "cloak"))  # cloak to the ground
    r.add(soft((0.8, 0.5, 0.18), (0, 0.04, 1.3), "cloak"))
    r.add(box((0.05, 0.03, 0.9), (0, -0.28, 0.75), "net_glow", bevel=0))  # glowing seam
    r.part("head")
    r.add(soft((0.62, 0.6, 0.6), (0, 0.04, 1.62), "cloak"))  # hood
    r.add(soft((0.42, 0.06, 0.36), (0, -0.24, 1.56), "ink"))  # shadowed face
    r.add(box((0.3, 0.03, 0.045), (0, -0.28, 1.59), "net_glow", bevel=0))  # visor
    return r.build("echo", 1.02)


CHARS = {"kai": kai, "maya": maya, "orin": orin, "echo": echo}

if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or list(CHARS)
    for n in names:
        CHARS[n]()
        export(n)
        print(f"{n}: {tris()} tris")
    if "--lineup" in sys.argv:
        # all four side by side for a quick look
        reset()
        for i, n in enumerate(("kai", "maya", "orin", "echo")):
            root = CHARS[n]() if False else None
        import importlib

        bpy.ops.wm.read_factory_settings(use_empty=True)
        for i, n in enumerate(("kai", "maya", "orin", "echo")):
            bpy.ops.import_scene.gltf(filepath=os.path.join(os.path.dirname(__file__), "..", "..", "public", "models", f"{n}.glb"))
            for o in bpy.context.selected_objects:
                if o.parent is None:
                    o.location.x += (i - 1.5) * 1.1
        preview("characters", dist=5.2, height=0.12, angle=-20, res=(760, 420), target_z=0.95)
