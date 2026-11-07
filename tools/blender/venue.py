"""Venue architecture for the OMEN Expo (a stylised hall inspired by the exhibition halls of the
Jio World Convention Centre: 12 m ceilings and white branching "tree" columns that hold square,
softly lit canopies). Original geometry, not a copy of any photograph.

Run with Blender 5 (no separate bpy install needed):
  blender -b --python tools/blender/venue.py -- [tree_column] [--preview]
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import lib  # noqa: E402
from lib import reset, box, cyl, tube, to_mesh_all, export, preview, tris  # noqa: E402

# Two venue colours on top of the shared palette: the column's warm white and the canopy glow.
lib.PALETTE["column"] = "#EDEAE2"
lib.PALETTE["canopy_glow"] = "#8F9BFF"
lib.EMISSIVE["canopy_glow"] = 1.6

TRUNK_TOP = 5.4  # where the trunk splits
CANOPY = 7.6  # canopy side (m)
CANOPY_Z = 10.2  # underside height; the ceiling is at 12 m


def finish(name):
    to_mesh_all()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    main = bpy.context.active_object
    main.name = name
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    return main


def tree_column():
    """A tapering trunk that splits into four curved arms carrying a square canopy."""
    reset()
    cyl(0.5, 0.25, (0, 0, 0.125), "stone_dark", verts=16, bevel=0.02)  # floor collar
    cyl(0.5, TRUNK_TOP, (0, 0, TRUNK_TOP / 2), "column", verts=16, r2=0.38, bevel=0)
    # A slim light strip running up the trunk, like the uplit seams in the reference halls.
    for a in range(4):
        ang = math.radians(45 + a * 90)
        box((0.06, 0.06, TRUNK_TOP - 0.6), (math.cos(ang) * 0.44, math.sin(ang) * 0.44, TRUNK_TOP / 2), "canopy_glow", bevel=0)
    # Four arms curving out to under the canopy's corners.
    reach = CANOPY * 0.36
    for a in range(4):
        ang = math.radians(45 + a * 90)
        dx, dy = math.cos(ang), math.sin(ang)
        pts = [(0, 0, TRUNK_TOP - 0.4)]
        for i in range(1, 7):
            t = i / 6
            r = reach * (1 - (1 - t) ** 2)  # leaves the trunk steeply, flattens near the top
            pts.append((dx * r, dy * r, TRUNK_TOP - 0.4 + (CANOPY_Z - TRUNK_TOP + 0.4) * t))
        tube(pts, 0.26, "column")
    # The canopy: a shallow inverted tray with a glowing panel underneath.
    box((CANOPY, CANOPY, 0.28), (0, 0, CANOPY_Z + 0.42), "column", bevel=0.06)
    box((CANOPY - 0.5, CANOPY - 0.5, 0.18), (0, 0, CANOPY_Z + 0.2), "column", bevel=0.04)
    box((CANOPY - 1.6, CANOPY - 1.6, 0.04), (0, 0, CANOPY_Z + 0.1), "canopy_glow", bevel=0)
    return finish("tree_column")


ASSETS = {f.__name__: f for f in (tree_column,)}

if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    names = [a for a in argv if not a.startswith("-")] or list(ASSETS)
    for n in names:
        ASSETS[n]()
        export(n)
        print(f"{n}: {tris()} tris")
        if "--preview" in argv:
            preview(n, dist=24, height=0.35, target_z=6)
