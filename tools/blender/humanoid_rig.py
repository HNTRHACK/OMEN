"""Skeleton, skinning, animation clips and GLB export for tools/blender/humanoid.py.

  blender -b --python tools/blender/humanoid_rig.py -- [--export] [--poses] [--preview]
"""
import math
import os
import sys

import bpy
from mathutils import Vector, Quaternion

sys.path.insert(0, os.path.dirname(__file__))
import lib  # noqa: E402
import humanoid as H  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
SIDES = (("L", 1), ("R", -1))  # Blender +X is the character's left
FPS = 30
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


# ---------------------------------------------------------------- skeleton
def armature():
    J = H.J
    data = bpy.data.armatures.new("human_rig")
    rig = bpy.data.objects.new("human", data)
    bpy.context.collection.objects.link(rig)
    H.select_only(rig)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones

    def bone(name, h, t, parent=None, deform=True):
        b = eb.new(name)
        b.head = Vector(h)
        b.tail = Vector(t)
        b.roll = 0
        if parent:
            b.parent = eb[parent]
        b.use_deform = deform
        return b

    chin = H.CHIN.z
    top = chin + 0.304 * H.HEAD_SCALE
    bone("hips", (0, 0, 0.93), (0, 0, 1.05))
    bone("spine", (0, 0, 1.05), (0, -0.004, 1.22), "hips")
    bone("chest", (0, -0.004, 1.22), (0, 0, 1.40), "spine")
    bone("neck", (0, 0.004, 1.42), (0, 0.008, chin + 0.03), "chest")
    bone("head", (0, 0.008, chin + 0.03), (0, 0.008, top), "neck")
    mz = chin + (H.HEAD_C.z - 0.078 - chin) * H.HEAD_SCALE
    bone("jaw", (0, 0.02, mz + 0.03), (0, -0.09, mz - 0.03), "head", deform=False)
    for side, s in SIDES:
        sh, el, wr = J[f"shoulder_{side}"], J[f"elbow_{side}"], J[f"wrist_{side}"]
        bone(f"shoulder_{side}", (s * 0.03, 0, 1.385), sh, "chest")
        bone(f"upper_arm_{side}", sh, el, f"shoulder_{side}")
        bone(f"forearm_{side}", el, wr, f"upper_arm_{side}")
        d = (wr - el).normalized()
        bone(f"hand_{side}", wr, wr + d * 0.13, f"forearm_{side}")
        hp, kn, an = J[f"hip_{side}"], J[f"knee_{side}"], J[f"ankle_{side}"]
        bone(f"thigh_{side}", hp, kn, "hips")
        bone(f"shin_{side}", kn, an, f"thigh_{side}")
        bone(f"foot_{side}", an, (an.x, an.y - 0.13, 0.03), f"shin_{side}")
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def bone_parent(o, rig, bone):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    rig.data.bones.active = rig.data.bones[bone]
    bpy.ops.object.parent_set(type="BONE", keep_transform=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def skin(body, rig):
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


# ---------------------------------------------------------------- animation
# Rotations are given about ARMATURE axes (X = the character's right→left, Y = front→back,
# Z = up), so directions are explicit: for a bone pointing down (legs, arms), a NEGATIVE X
# rotation swings it forward; for one pointing up (spine), a POSITIVE X rotation leans forward.
def relaxed(name):
    """The standing pose every clip starts from: arms down from the modelling A-pose, elbows soft."""
    for side, s in SIDES:
        if name == f"upper_arm_{side}":
            return [(Y, s * 21)]
        if name == f"forearm_{side}":
            return [(X, -12)]
        if name == f"hand_{side}":
            return [(Y, s * 6)]
    return []


def pose(rig, frame, rots, hips_lift=0.0):
    for pb in rig.pose.bones:
        B = pb.bone.matrix_local.to_quaternion()
        R = Quaternion()
        for axis, deg in relaxed(pb.name) + rots.get(pb.name, []):
            R = Quaternion(axis, math.radians(deg)) @ R
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = B.inverted() @ R @ B
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == "hips":
            pb.location = B.inverted() @ Vector((0, 0, hips_lift))
            pb.keyframe_insert("location", frame=frame)


def clip(rig, name, frames, fn):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for f in range(0, frames + 1):
        rots, lift = fn(f / frames)
        pose(rig, f, rots, lift)
    return act


def legs(t, swing, knee):
    rots = {}
    for side, s in SIDES:
        ph = 2 * math.pi * (t + (0 if side == "L" else 0.5))
        a = -swing * math.sin(ph)  # negative = forward
        k = 6 + knee * max(0.0, math.cos(ph)) ** 1.4  # the knee bends while the leg swings through
        rots[f"thigh_{side}"] = [(X, a - k * 0.35)]
        rots[f"shin_{side}"] = [(X, k)]
        rots[f"foot_{side}"] = [(X, -(a * 0.55) - k * 0.45 + 4 * math.sin(ph))]
    return rots


def walk(t):
    ph = 2 * math.pi * t
    r = legs(t, 24, 40)
    for side, s in SIDES:
        o = 0 if side == "L" else math.pi
        r[f"upper_arm_{side}"] = [(X, 18 * math.sin(ph + o))]  # opposite to the same-side leg
        r[f"forearm_{side}"] = [(X, -8 - 8 * max(0, -math.sin(ph + o)))]
    r["hips"] = [(Z, 5 * math.sin(ph)), (Y, 2.5 * math.cos(2 * ph))]
    r["chest"] = [(Z, -7 * math.sin(ph)), (X, 3)]
    r["head"] = [(Z, 2 * math.sin(ph))]
    return r, -0.022 * math.cos(2 * ph) - 0.008


def run(t):
    ph = 2 * math.pi * t
    r = legs(t, 42, 95)
    for side, s in SIDES:
        sw = math.sin(ph + (0 if side == "L" else math.pi))
        r[f"upper_arm_{side}"] = [(X, 38 * sw), (Y, s * -8)]
        r[f"forearm_{side}"] = [(X, -78 - 12 * sw)]
    r["hips"] = [(Z, 8 * math.sin(ph))]
    r["spine"] = [(X, 9)]
    r["chest"] = [(Z, -11 * math.sin(ph)), (X, 4)]
    r["head"] = [(X, -9)]
    return r, -0.05 * math.cos(2 * ph) - 0.03


def idle(t):
    ph = 2 * math.pi * t
    b = math.sin(ph)
    r = {"chest": [(X, -1.4 * b)], "spine": [(X, -0.6 * b)], "head": [(X, 1.2 * b), (Z, 2 * math.sin(ph * 0.5 + 1))]}
    for side, s in SIDES:
        r[f"upper_arm_{side}"] = [(Y, s * -1.2 * b)]
        r[f"thigh_{side}"] = [(X, -2)]
        r[f"shin_{side}"] = [(X, 4)]
        r[f"foot_{side}"] = [(X, -2)]
    return r, -0.004 - 0.002 * b


def turn(t):
    ph = 2 * math.pi * t
    r = {}
    for side, s in SIDES:
        up = max(0.0, math.sin(ph + (0 if side == "L" else math.pi)))
        r[f"thigh_{side}"] = [(X, -22 * up)]
        r[f"shin_{side}"] = [(X, 40 * up)]
        r[f"foot_{side}"] = [(X, -16 * up)]
    r["hips"] = [(Z, 4 * math.sin(ph))]
    return r, -0.01


def crouch(k):
    r = {}
    for side, s in SIDES:
        r[f"thigh_{side}"] = [(X, -38 * k)]
        r[f"shin_{side}"] = [(X, 72 * k)]
        r[f"foot_{side}"] = [(X, -34 * k)]
        r[f"upper_arm_{side}"] = [(X, 28 * k)]
    r["spine"] = [(X, 14 * k)]
    return r, -0.16 * k


def jump(t):
    if t < 0.45:
        return crouch(math.sin(math.pi * t / 0.9))
    k = (t - 0.45) / 0.55
    r = {}
    for side, s in SIDES:
        r[f"upper_arm_{side}"] = [(X, -55 * k), (Y, s * -10 * k)]
        r[f"forearm_{side}"] = [(X, -20 * k)]
        r[f"thigh_{side}"] = [(X, -8 * k)]
        r[f"shin_{side}"] = [(X, 18 * k)]
        r[f"foot_{side}"] = [(X, 25 * k)]
    r["spine"] = [(X, -4 * k)]
    return r, 0.0


def fall(t):
    ph = 2 * math.pi * t
    r = {}
    for side, s in SIDES:
        o = 0 if side == "L" else math.pi
        r[f"upper_arm_{side}"] = [(Y, s * -38), (X, -10 + 8 * math.sin(ph + o))]
        r[f"forearm_{side}"] = [(X, -25)]
        r[f"thigh_{side}"] = [(X, -26 + 10 * math.sin(ph + o))]
        r[f"shin_{side}"] = [(X, 38 - 8 * math.sin(ph + o))]
        r[f"foot_{side}"] = [(X, 10)]
    return r, 0.0


def land(t):
    return crouch(0.75 * math.sin(math.pi * min(1.0, t * 1.15)) * (1 - t))


def wave(t):
    ph = 2 * math.pi * t
    k = min(1.0, t * 5, (1 - t) * 5)  # raise, wave, lower
    return {
        "upper_arm_R": [(Y, 128 * k)],  # right arm: positive Y raises it outward
        "forearm_R": [(Y, (-30 + 22 * math.sin(ph * 3)) * k), (X, -10 * k)],
        "hand_R": [(Y, -12 * math.sin(ph * 3) * k)],
        "head": [(Z, -6 * k), (X, -3 * k)],
        "chest": [(Z, -4 * k)],
    }, 0.0


def talk(t):
    ph = 2 * math.pi * t
    return {
        "head": [(X, 4 * math.sin(ph * 2)), (Z, 5 * math.sin(ph))],
        "jaw": [(X, 7 * max(0, math.sin(ph * 6)))],
        "chest": [(Z, 3 * math.sin(ph))],
        "upper_arm_L": [(X, -22 - 6 * math.sin(ph)), (Y, -6)],
        "forearm_L": [(X, -55 - 10 * math.sin(ph * 2))],
        "upper_arm_R": [(X, -14 + 8 * math.sin(ph + 1)), (Y, 6)],
        "forearm_R": [(X, -48 - 12 * math.sin(ph * 2 + 1))],
    }, 0.0


def interact(t):
    k = math.sin(math.pi * t)
    return {
        "upper_arm_R": [(X, -62 * k), (Y, -10 * k)],
        "forearm_R": [(X, -18 * k)],
        "hand_R": [(X, 10 * k)],
        "spine": [(X, 6 * k)],
        "head": [(X, 6 * k)],
    }, 0.0


CLIPS = {
    "idle": (60, idle),
    "walk": (30, walk),  # one full cycle (two steps) per second
    "run": (20, run),
    "turn": (24, turn),
    "jump": (10, jump),
    "fall": (20, fall),
    "land": (12, land),
    "wave": (48, wave),
    "talk": (48, talk),
    "interact": (30, interact),
}


def animate(rig):
    bpy.context.scene.render.fps = FPS
    acts = {name: clip(rig, name, n, fn) for name, (n, fn) in CLIPS.items()}
    rig.animation_data.action = acts["idle"]
    return acts


def export_glb(path):
    for o in list(bpy.context.scene.objects):
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
        export_def_bones=False,
        export_morph=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=7,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
    )


def assemble():
    body, head, face, hairs, hands, shoes, extra = H.build()
    rig = armature()
    skin(body, rig)
    # clothing trims ride their bones rigidly (disconnected pieces get no automatic weights)
    for name, o in extra.items():
        o.name = name
        bone_parent(o, rig, f"forearm_{name[-1]}" if name.startswith("cuff") else "spine")
    for o in [head, *(v for k, v in face.items() if k != "lip_lower"), *hairs.values()]:
        bone_parent(o, rig, "head")
    bone_parent(face["lip_lower"], rig, "jaw")
    for side, _ in SIDES:
        bone_parent(hands[side], rig, f"hand_{side}")
        bone_parent(shoes[side], rig, f"foot_{side}")
    # mesh names must not collide with bone names in three.js (hand_L the bone vs hand_L the mesh)
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and not o.name.startswith("m_"):
            o.name = "m_" + o.name
    total = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            n = lib.tris(o)
            total += n
            print(f"  {o.name}: {n} tris")
    print("TOTAL tris (all hairstyles):", total)
    return rig, hairs


if __name__ == "__main__":
    rig, hairs = assemble()
    acts = animate(rig)
    for n, h in hairs.items():
        h.hide_render = n != "short"
    if "--poses" in ARGS:
        for name, frame in (("walk", 0), ("walk", 8), ("run", 5), ("jump", 4), ("wave", 18), ("talk", 10)):
            rig.animation_data.action = acts[name]
            bpy.context.scene.frame_set(frame)
            lib.preview(f"human_pose_{name}_{frame}", dist=3.4, height=0.12, angle=-60, res=(420, 620), target_z=0.95)
        rig.animation_data.action = acts["idle"]
        bpy.context.scene.frame_set(0)
    if "--preview" in ARGS:
        lib.preview("human_front", dist=3.2, height=0.12, angle=0, res=(520, 760), target_z=0.95)
        lib.preview("human_face", dist=0.95, height=0.02, angle=-25, res=(640, 640), target_z=1.7)
    if "--export" in ARGS:
        export_glb(os.path.join(lib.MODELS, "human.glb"))
        print("exported human.glb")
