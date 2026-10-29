"""Foundry Builder harness: runs INSIDE Blender (blender -b --python harness.py -- ...).

Wraps brain-written build code with everything the code should not have to
care about: scene reset, Cycles GPU setup, material/part helpers, texture
UVs, the water/ground stage, auto-framing camera, motion keyframes,
GLB/blend export, preview render, turntable + motion frame strips.

Prints one line: BUILDER_RESULT {json}

Args after --:
  --code <path.py>     the brain's build code (exec'd with helpers in scope)
  --import-glb <path>  instead of code: stage an existing mesh (CAD lane)
  --out <dir>          version dir for artifacts
  --textures <json>    {key: abs_png_path} available to code as TEXTURES
  --motion <json>      motion spec (see apply_motion) or {}
  --samples <int>      Cycles samples for the beauty preview
"""
import bpy
import sys
import os
import json
import math
import time
import random
import fnmatch


def argv():
    args = sys.argv[sys.argv.index("--") + 1:]
    out = {}
    it = iter(args)
    for k in it:
        if k.startswith("--"):
            out[k[2:]] = next(it)
    return out


A = argv()
OUT = A["out"]
os.makedirs(OUT, exist_ok=True)
TEXTURES = json.loads(A.get("textures", "{}"))
MOTION = json.loads(A.get("motion", "{}"))
SAMPLES = int(A.get("samples", "48"))

# ---------------------------------------------------------------------------
# Scene + Cycles (same recipe as the foundry engine)
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)


def setup_cycles(samples, want_gpu=True):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    avail = [i.identifier for i in sc.cycles.bl_rna.properties["denoiser"].enum_items]
    sc.cycles.use_denoising = ("OPENIMAGEDENOISE" in avail or "OPTIX" in avail)
    chosen = "CPU"
    if want_gpu:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = backend
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type == backend]
                if gpus:
                    for d in prefs.devices:
                        d.use = (d.type == backend)
                    sc.cycles.device = "GPU"
                    chosen = backend + ":" + gpus[0].name
                    break
            except Exception:  # noqa: BLE001
                pass
    if chosen == "CPU":
        sc.cycles.device = "CPU"
    return chosen


DEVICE = setup_cycles(SAMPLES)

# ---------------------------------------------------------------------------
# Helpers exposed to the build code
# ---------------------------------------------------------------------------
PARTS = {}
_rng = random.Random(int(A.get("seed", "7")))


def _srgb2lin(c):
    """Brain-written colors are sRGB; Principled wants linear. Without this
    conversion every material renders washed-out beige (found in QA:
    black/dark-wood/gold all came out tan)."""
    c = min(1.0, max(0.0, float(c)))
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _set_alpha_mode(m):
    """Blender 4.2+ renamed the alpha controls: 4.0 (this box) uses
    blend_method/shadow_method, newer uses surface_render_method.
    Written against the new name first, every alpha texture crashed
    the build on this 4.0.2 install (found in the SVG insignia proof)."""
    if hasattr(m, "surface_render_method"):
        m.surface_render_method = "DITHERED"
    else:
        m.blend_method = "BLEND"
        if hasattr(m, "shadow_method"):
            m.shadow_method = "HASHED"


def MAT(name, color=(0.8, 0.8, 0.8), rough=0.85, metal=0.0, tex=None,
        tex_scale=2.0, alpha=1.0):
    """Create (or fetch) a material. tex = key into TEXTURES (or a path).
    tex_scale = world units covered by one texture tile."""
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (
        _srgb2lin(color[0]), _srgb2lin(color[1]), _srgb2lin(color[2]), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        _set_alpha_mode(m)
    if tex:
        path = TEXTURES.get(tex, tex)
        if path and os.path.isfile(path):
            img = bpy.data.images.load(path)
            img.alpha_mode = "STRAIGHT"
            tnode = nt.nodes.new("ShaderNodeTexImage")
            tnode.image = img
            tnode.extension = "REPEAT"
            coord = nt.nodes.new("ShaderNodeTexCoord")
            nt.links.new(coord.outputs["UV"], tnode.inputs["Vector"])
            # Tint: the brain sets color AND tex expecting the color to
            # deepen the texture (raw SDXL tiles render washed-out white
            # under stage light). Multiply by sqrt(linear color): full
            # multiply double-darkens; white (1,1,1) leaves art untouched.
            mix = nt.nodes.new("ShaderNodeMixRGB")
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1.0
            tint = nt.nodes.new("ShaderNodeRGB")
            tint.outputs[0].default_value = (
                _srgb2lin(color[0]) ** 0.5, _srgb2lin(color[1]) ** 0.5,
                _srgb2lin(color[2]) ** 0.5, 1.0)
            nt.links.new(tnode.outputs["Color"], mix.inputs[1])
            nt.links.new(tint.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], bsdf.inputs["Base Color"])
            if alpha < 1.0 or img.depth == 32:
                nt.links.new(tnode.outputs["Alpha"], bsdf.inputs["Alpha"])
                _set_alpha_mode(m)
            if img.depth == 32:
                # alpha art (SVG decals) must keep the part's native
                # 0..1 UVs — see ensure_uvs
                m["decal"] = True
            m["tex_scale"] = float(tex_scale)
            m["uses_tex"] = True
    return m


def _finish(obj, name, mat):
    obj.name = name
    if mat is not None:
        obj.data.materials.append(mat)
        if mat.get("decal"):
            # float decal parts 3 cm off the surface along their facing
            # normal: placed exactly coplanar (the brain's habit), the
            # decal z-fights the sail and only fragments show
            from mathutils import Vector as _V
            obj.location += obj.rotation_euler.to_matrix() @ _V((0, 0, 0.03))
    PARTS[name] = obj
    return obj


def BOX(name, loc, size, mat=None, rot=(0, 0, 0), pivot="center"):
    if isinstance(size, (int, float)):
        size = (size, size, size)
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.active_object
    o.dimensions = size
    bpy.ops.object.transform_apply(scale=True)
    if pivot == "base":
        o.location.z += size[2] / 2
    return _finish(o, name, mat)


def CYL(name, loc, radius, depth, mat=None, vertices=24, rot=(0, 0, 0),
        pivot="base"):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth,
                                        vertices=vertices, location=loc,
                                        rotation=rot)
    o = bpy.context.active_object
    if pivot == "base":
        o.location.z += depth / 2
    return _finish(o, name, mat)


def CONE(name, loc, r1, r2, depth, mat=None, vertices=24, pivot="base"):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=depth,
                                    vertices=vertices, location=loc)
    o = bpy.context.active_object
    if pivot == "base":
        o.location.z += depth / 2
    return _finish(o, name, mat)


def SPHERE(name, loc, radius, mat=None, scale=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc)
    o = bpy.context.active_object
    if scale:
        o.scale = scale
    return _finish(o, name, mat)


def PLANE(name, loc, size, mat=None, rot=(0, 0, 0)):
    if isinstance(size, (int, float)):
        size = (size, size)
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.dimensions = (size[0], size[1], 0)
    return _finish(o, name, mat)


def MESH(name, verts, faces, mat=None, loc=(0, 0, 0)):
    """Custom geometry. verts are LOCAL (relative to the object's origin,
    which is the part's pivot). faces are index tuples."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [],
                   [tuple(f) for f in faces])
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    o.location = loc
    return _finish(o, name, mat)


def GROUP(name, children, loc=(0, 0, 0)):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    g = bpy.context.active_object
    g.name = name
    for c in children:
        if isinstance(c, str):
            c = PARTS[c]
        c.parent = g
        c.matrix_parent_inverse = g.matrix_world.inverted()
    PARTS[name] = g
    return g




def HULL(name, length=10.0, beam=3.2, depth=1.7, mat=None, loc=(0, 0, 0)):
    """A lofted boat hull (use this — never a box). Origin at the waterline;
    the keel dips below z=0, the deck sits near z=+0.68*depth."""
    prof = [(0.00, 0.62, 0.62, 0.05), (0.18, 0.88, 0.65, -0.32),
            (0.42, 1.00, 0.68, -0.45), (0.65, 0.92, 0.72, -0.34),
            (0.85, 0.62, 0.82, 0.02), (1.00, 0.02, 0.92, 0.42)]
    verts, faces = [], []
    for (t, hwf, deckf, keelf) in prof:
        x = -length / 2 + t * length
        hw = (beam / 2) * hwf
        verts += [(x, -hw, depth * deckf), (x, -hw * 0.55, depth * keelf),
                  (x, hw * 0.55, depth * keelf), (x, hw, depth * deckf)]
    n = len(prof)
    for i in range(n - 1):
        b0, b1 = i * 4, (i + 1) * 4
        for k in range(4):
            faces.append((b0 + k, b1 + k, b1 + (k + 1) % 4, b0 + (k + 1) % 4))
    faces.append((0, 1, 2, 3))
    faces.append(((n - 1) * 4 + 3, (n - 1) * 4 + 2, (n - 1) * 4 + 1, (n - 1) * 4))
    return MESH(name, verts, faces, mat=mat, loc=loc)


def SAIL(name, loc, width=-3.0, height=5.0, mat=None):
    """A triangular fore-aft sail. Origin (the pivot) is the tack at the
    mast foot; width runs along the boom (negative = toward the stern),
    height up the mast."""
    verts = [(0, 0, 0), (width, 0, height * 0.06), (0, 0, height)]
    return MESH(name, verts, [(0, 1, 2)], mat=mat, loc=loc)

HELPERS = {"MAT": MAT, "BOX": BOX, "CYL": CYL, "CONE": CONE, "SPHERE": SPHERE,
           "PLANE": PLANE, "MESH": MESH, "GROUP": GROUP, "PARTS": PARTS,
           "HULL": HULL, "SAIL": SAIL,
           "TEXTURES": TEXTURES, "rng": _rng}

# ---------------------------------------------------------------------------
# Build: exec the brain's code (or import a CAD mesh)
# ---------------------------------------------------------------------------
t_build0 = time.time()
stage_kind = "water"

if A.get("import-glb"):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=A["import-glb"])
    imported = [o for o in bpy.data.objects if o not in before
                and o.type == "MESH"]
    steel = MAT("cad_steel", color=(0.62, 0.65, 0.68), rough=0.38, metal=0.85)
    brass = MAT("cad_brass", color=(0.72, 0.53, 0.2), rough=0.3, metal=0.9)
    for i, o in enumerate(imported):
        if not o.data.materials:
            o.data.materials.append(brass if i == 0 else steel)
        PARTS[o.name] = o
    # CAD parts are authored centred on their own origin; rest the part on
    # the stage (bbox base at z=0) instead of sinking halfway through the
    # floor — the first wheel proof rendered as a brass sunrise.
    if imported:
        from mathutils import Vector as _V
        lo_z = min((o.matrix_world @ _V(c)).z for o in imported
                   for c in o.bound_box)
        roots = {o.parent if o.parent else o for o in imported}
        for r in roots:
            r.location.z -= lo_z
    stage_kind = "ground"
else:
    code = open(A["code"]).read()
    ns = {"bpy": bpy, "math": math, "random": random, "__name__": "build"}
    ns.update(HELPERS)
    exec(compile(code, A["code"], "exec"), ns)  # noqa: S102 — the glass box IS the sandbox review
    stage_kind = ns.get("STAGE", "water")

asset_objs = [o for o in bpy.context.scene.objects
              if o.type in ("MESH", "EMPTY") and o.name != "ASSET_ROOT"]
if not asset_objs:
    raise RuntimeError("build produced no objects")

# ---------------------------------------------------------------------------
# UVs: box projection for textured meshes that lack a UV map (context-free,
# so it works headless). One tile spans the material's tex_scale world units.
# ---------------------------------------------------------------------------
def ensure_uvs(obj):
    if obj.type != "MESH":
        return
    mats = [m for m in obj.data.materials if m and m.get("uses_tex")]
    if not mats:
        return
    if any(m.get("decal") for m in mats):
        return  # decals keep native UVs; world box projection samples a
        # random wrapped corner of the art and the decal vanishes
    scale = float(mats[0].get("tex_scale", 2.0)) or 2.0
    me = obj.data
    uv = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    for poly in me.polygons:
        n = (mw.to_3x3() @ poly.normal).normalized()
        ax = max(range(3), key=lambda i: abs(n[i]))
        others = [i for i in range(3) if i != ax]
        for li in poly.loop_indices:
            v = mw @ me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (v[others[0]] / scale, v[others[1]] / scale)


for o in asset_objs:
    ensure_uvs(o)

# Group everything under one root, world transforms preserved.
bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
ROOT = bpy.context.active_object
ROOT.name = "ASSET_ROOT"
for o in asset_objs:
    o.parent = ROOT
    o.matrix_parent_inverse = ROOT.matrix_world.inverted()

# ---------------------------------------------------------------------------
# Stage + camera (auto-framed from the asset's bounding box)
# ---------------------------------------------------------------------------
def add_stage(kind):
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    sky = world.node_tree.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(24)
    sky.sun_rotation = math.radians(35)
    world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.55
    bpy.ops.object.light_add(type="SUN", location=(30, -25, 42))
    sun = bpy.context.active_object
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(52), 0, math.radians(33))
    if kind in ("water", "ground"):
        bpy.ops.mesh.primitive_plane_add(size=900, location=(0, 0, 0))
        w = bpy.context.active_object
        w.name = "stage_floor"
        if kind == "water":
            m = MAT("stage_water", color=(0.015, 0.05, 0.085), rough=0.12,
                    metal=0.05)
        else:
            m = MAT("stage_ground", color=(0.16, 0.13, 0.1), rough=0.95)
        w.data.materials.append(m)


from mathutils import Vector


def bbox(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


LO, HI = bbox(asset_objs)
CENTER = (LO + HI) / 2
SPAN = (HI - LO).length

add_stage(stage_kind)


def look_at(cam, target):
    d = target - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


bpy.ops.object.camera_add()
CAM = bpy.context.active_object
CAM.data.lens = 42
bpy.context.scene.camera = CAM


def frame_camera(azimuth_deg=38, elevation_deg=18, dist_factor=1.55):
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    # the old hard 6 m floor made sub-metre CAD parts render as specks:
    # floor scales with the asset once the asset is small
    dist = max(SPAN * dist_factor, min(6.0, SPAN * 3.0))
    tgt = Vector((CENTER.x, CENTER.y, CENTER.z))
    # Camera sits in the (+X, -Y) quadrant, same side as the key light:
    # the prompt's convention is that a building's front (door/windows)
    # is its -Y face, so fronts are both visible and lit in previews.
    CAM.location = tgt + Vector((dist * math.cos(el) * math.sin(az),
                                 -dist * math.cos(el) * math.cos(az),
                                 dist * math.sin(el)))
    look_at(CAM, tgt)
    return tgt


TARGET = frame_camera()

# ---------------------------------------------------------------------------
# Motion: keyframes on the root (bob/sway) + named parts (glob patterns).
# Loop is LOOP_S seconds at FPS; periods snap to divisors of the loop.
# ---------------------------------------------------------------------------
FPS = 24
LOOP_S = 2.0
NFRAMES = int(FPS * LOOP_S)


def _snap_period(p):
    p = max(0.25, float(p))
    n = max(1, round(LOOP_S / p))
    return LOOP_S / n


def _key_sine(obj, path, amp, period_s, phase=0.0, base=0.0):
    period = _snap_period(period_s)
    keys = 16
    for i in range(keys + 1):
        f = 1 + round(i * NFRAMES / keys)
        t = (f - 1) / FPS
        v = base + amp * math.sin(2 * math.pi * t / period + phase)
        if path == "loc_z":
            obj.location.z = v
            obj.keyframe_insert("location", index=2, frame=f)
        elif path.startswith("rot_"):
            ax = {"x": 0, "y": 1, "z": 2}[path[-1]]
            obj.rotation_euler[ax] = v
            obj.keyframe_insert("rotation_euler", index=ax, frame=f)


motion_applied = {}
if MOTION:
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, NFRAMES
    sc.render.fps = FPS
    bob = MOTION.get("bob") or {}
    if bob.get("amp"):
        _key_sine(ROOT, "loc_z", float(bob["amp"]),
                  float(bob.get("period_s", 2.0)), base=ROOT.location.z)
        motion_applied["bob"] = bob
    sway = MOTION.get("sway") or {}
    if sway.get("amp_deg"):
        _key_sine(ROOT, "rot_x", math.radians(float(sway["amp_deg"])),
                  float(sway.get("period_s", 2.0)), phase=0.7)
        motion_applied["sway"] = sway
    for pattern, spec in (MOTION.get("parts") or {}).items():
        for name, obj in list(PARTS.items()) + [(o.name, o) for o in asset_objs]:
            if fnmatch.fnmatch(name.lower(), pattern.lower()):
                for chan, cs in spec.items():
                    amp = float(cs.get("amp_deg", cs.get("amp", 0)))
                    if chan.startswith("rot_"):
                        amp = math.radians(amp)
                    _key_sine(obj, chan, amp, float(cs.get("period_s", 1.0)),
                              base=(obj.rotation_euler[{"x": 0, "y": 1, "z": 2}[chan[-1]]]
                                    if chan.startswith("rot_") else obj.location.z))
                motion_applied[name] = spec
build_s = time.time() - t_build0

# ---------------------------------------------------------------------------
# Export + renders
# ---------------------------------------------------------------------------
sc = bpy.context.scene
sc.frame_set(1)
bpy.ops.object.select_all(action="DESELECT")
for o in asset_objs:
    o.select_set(True)
ROOT.select_set(True)
bpy.context.view_layer.objects.active = asset_objs[0]
glb_path = os.path.join(OUT, "asset.glb")
bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB",
                          use_selection=True,
                          export_apply=not bool(MOTION),
                          export_animations=bool(MOTION))
blend_path = os.path.join(OUT, "asset.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend_path)


def render_to(path, rx, ry, samples):
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    sc.render.resolution_x = rx
    sc.render.resolution_y = ry
    sc.render.filepath = path
    sc.render.image_settings.file_format = "PNG"
    t = time.time()
    bpy.ops.render.render(write_still=True)
    return time.time() - t


t = time.time()
render_s = render_to(os.path.join(OUT, "preview.png"), 768, 512, SAMPLES)
preview_s = time.time() - t

tt_dir = os.path.join(OUT, "frames_tt")
os.makedirs(tt_dir, exist_ok=True)
t = time.time()
for i in range(12):
    frame_camera(azimuth_deg=i * 30, elevation_deg=16)
    render_to(os.path.join(tt_dir, f"frame_{i:02d}.png"), 576, 576, 32)
tt_s = time.time() - t
frame_camera()

motion_s = 0.0
if MOTION:
    mo_dir = os.path.join(OUT, "frames_motion")
    os.makedirs(mo_dir, exist_ok=True)
    t = time.time()
    n = 20
    for i in range(n):
        sc.frame_set(1 + round(i * NFRAMES / n))
        render_to(os.path.join(mo_dir, f"frame_{i:02d}.png"), 640, 448, 24)
    motion_s = time.time() - t
    sc.frame_set(1)

result = {
    "ok": True,
    "device": DEVICE,
    "objects": sorted(o.name for o in asset_objs if o.type == "MESH"),
    "parts": sorted(PARTS.keys()),
    "stage": stage_kind,
    "motion_applied": motion_applied,
    "build_s": round(build_s, 2),
    "preview_render_s": round(preview_s, 2),
    "turntable_s": round(tt_s, 2),
    "motion_s": round(motion_s, 2),
    "glb": glb_path,
    "blend": blend_path,
}
print("BUILDER_RESULT " + json.dumps(result))
