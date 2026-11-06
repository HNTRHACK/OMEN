"""Shared helpers for OMEN's Blender asset scripts (Blender 5, run headless via `bpy`).

Conventions
- 1 unit = 1 metre. KAI is ~1.6 m tall.
- Assets are built around the world origin with their base on z = 0 and their front facing -Y
  (Blender), which the glTF exporter turns into +Z (three.js), the game's "front".
- Colours come from the shared PALETTE so every asset matches; the game swaps the exported
  materials for toon shading by material name.
"""
import math
import os
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS = os.path.join(ROOT, "public", "models")
PREVIEWS = os.path.join(ROOT, "tools", "blender", "previews")

PALETTE = {
    "ink": "#2B2230",
    "cream": "#F1E6D2",
    "plaster": "#E9B9A7",
    "mint": "#BFD8C6",
    "butter": "#F3D98B",
    "stone": "#C9BFAE",
    "stone_dark": "#9E9384",
    "brick": "#B85C4A",
    "slate": "#5F7D99",
    "moss": "#6E8B5A",
    "wood": "#8A5A3B",
    "wood_light": "#B98A5E",
    "teal": "#3E8E8A",
    "teal_light": "#7FC4BC",
    "brass": "#D2A44A",
    "red": "#C8473D",
    "leaf": "#5E9A5B",
    "leaf_dark": "#41744A",
    "flower_pink": "#E88AA6",
    "flower_yellow": "#F5C84C",
    "glass": "#9FC9D4",
    "white": "#FAF7EF",
    "skin": "#E3B08C",
    "skin_dark": "#B87E5A",
    "hair": "#3A2A2A",
    "denim": "#4E6E8E",
    "navy": "#2F3E5C",
    "cloak": "#3D3550",
    "glow": "#FFC85A",
    "net_glow": "#6FE3D6",
    # Mumbai (Final Block)
    "taxi_yellow": "#F2C230",
    "basalt": "#D8B47A",
    "basalt_dark": "#B48E58",
    "local_maroon": "#8E3B46",
    "sea": "#4F8FB0",
    "steel": "#8C96A0",
    "black": "#26222A",
}
EMISSIVE = {"glow": 2.0, "net_glow": 2.5}


def hex_rgba(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    # sRGB → linear for Blender
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), 1.0)


_mats = {}


def mat(name):
    if name in _mats and _mats[name].name in bpy.data.materials:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    col = hex_rgba(PALETTE[name])
    bsdf.inputs["Base Color"].default_value = col
    bsdf.inputs["Roughness"].default_value = 0.85
    if name in EMISSIVE:
        bsdf.inputs["Emission Color"].default_value = col
        bsdf.inputs["Emission Strength"].default_value = EMISSIVE[name]
    _mats[name] = m
    return m


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()
    bpy.context.scene.cursor.location = (0, 0, 0)


def _finish(o, m, bevel, segments=2, name=None):
    if name:
        o.name = name
    o.data.materials.clear()
    o.data.materials.append(mat(m))
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(40)
        mod.harden_normals = False
    o.data.shade_flat() if hasattr(o.data, "shade_flat") else None
    return o


def box(size, loc, m, bevel=0.03, rot=(0, 0, 0), name=None, segments=2):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=[math.radians(a) for a in rot])
    o = bpy.context.active_object
    o.scale = size
    return _finish(o, m, bevel, segments, name)


def cyl(r, h, loc, m, verts=12, r2=None, bevel=0.02, rot=(0, 0, 0), name=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=[math.radians(a) for a in rot])
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=[math.radians(a) for a in rot])
    o = bpy.context.active_object
    return _finish(o, m, bevel, 2, name)


def ball(r, loc, m, subdiv=2, scale=(1, 1, 1), name=None):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r, location=loc)
    o = bpy.context.active_object
    o.scale = scale
    return _finish(o, m, 0, 1, name)


def rounded(size, loc, m, rot=(0, 0, 0), name=None, smooth=2):
    """A soft, pillowy block (subdivided cube) — used for characters, foliage and cushions."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=[math.radians(a) for a in rot])
    o = bpy.context.active_object
    o.scale = size
    _finish(o, m, 0, 1, name)
    sub = o.modifiers.new("soft", "SUBSURF")
    sub.levels = smooth
    sub.render_levels = smooth
    return o


def torus(R, r, loc, m, rot=(0, 0, 0), major=24, minor=8, name=None):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=major, minor_segments=minor, location=loc, rotation=[math.radians(a) for a in rot])
    return _finish(bpy.context.active_object, m, 0, 1, name)


def wedge(w, d, h, loc, m, rot=(0, 0, 0), name=None, overhang=0.0, bevel=0.03):
    """Gable roof prism: ridge along X, slopes toward ±Y."""
    hw, hd = w / 2 + overhang, d / 2 + overhang
    verts = [(-hw, -hd, 0), (hw, -hd, 0), (hw, hd, 0), (-hw, hd, 0), (-hw, 0, h), (hw, 0, h)]
    faces = [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    me = bpy.data.meshes.new(name or "wedge")
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name or "wedge", me)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    bpy.context.view_layer.objects.active = o
    return _finish(o, m, bevel, 2, name)


def tube(points, r, m, name=None, sag=0.0):
    """A bevelled curve through points (cables, string lights, pipes)."""
    cu = bpy.data.curves.new(name or "tube", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = 1
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for i, p in enumerate(points):
        sp.points[i].co = (*p, 1)
    o = bpy.data.objects.new(name or "tube", cu)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(mat(m))
    return o


def catenary(a, b, sag, n=14):
    pts = []
    for i in range(n + 1):
        t = i / n
        p = Vector(a).lerp(Vector(b), t)
        p.z -= math.sin(math.pi * t) * sag
        pts.append(tuple(p))
    return pts


def text(s, size, loc, m, extrude=0.03, rot=(90, 0, 0), name=None, align="CENTER"):
    cu = bpy.data.curves.new(name or "text", "FONT")
    cu.body = s
    cu.size = size
    cu.extrude = extrude
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.resolution_u = 2  # fewer triangles per glyph; still crisp at game scale
    o = bpy.data.objects.new(name or "text", cu)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    o.data.materials.append(mat(m))
    return o


def to_mesh_all():
    """Apply modifiers and convert curves/text to meshes."""
    bpy.ops.object.select_all(action="SELECT")
    objs = [o for o in bpy.context.scene.objects if o.type in ("MESH", "CURVE", "FONT")]
    if not objs:
        return
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.convert(target="MESH")


def join_all(name):
    to_mesh_all()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # merge coincident verts left by joins, recalc normals outward
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return o


def tris(o=None):
    objs = [o] if o else [x for x in bpy.context.scene.objects if x.type == "MESH"]
    n = 0
    for x in objs:
        x.data.calc_loop_triangles()
        n += len(x.data.loop_triangles)
    return n


def export(name):
    os.makedirs(MODELS, exist_ok=True)
    path = os.path.join(MODELS, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=False,
        export_materials="EXPORT",
        export_animations=False,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=7,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=8,
    )
    return path


def preview(name, dist=None, height=0.55, angle=-35, res=(560, 420), target_z=None):
    """Small Cycles render so assets can be critiqued without a GPU."""
    os.makedirs(PREVIEWS, exist_ok=True)
    scn = bpy.context.scene
    objs = [o for o in scn.objects if o.type == "MESH"]
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    center = (lo + hi) / 2
    size = (hi - lo).length
    dist = dist or size * 1.35
    a = math.radians(angle)
    cam_loc = center + Vector((math.sin(a) * dist, -math.cos(a) * dist, size * height))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scn.collection.objects.link(cam)
    cam.location = cam_loc
    look = Vector((center.x, center.y, target_z if target_z is not None else center.z))
    cam.rotation_euler = (look - cam_loc).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 40
    scn.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
    scn.collection.objects.link(sun)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = hex_rgba("#F6D6B8")
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scn.world = world
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 24
    scn.cycles.use_denoising = False
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.filepath = os.path.join(PREVIEWS, f"{name}.png")
    scn.view_settings.view_transform = "Standard"
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(sun)
    return scn.render.filepath
