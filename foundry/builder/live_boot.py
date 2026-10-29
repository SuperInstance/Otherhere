"""Foundry live session: runs INSIDE the persistent Blender GUI (Xvfb).

Starts a small exec server on 127.0.0.1:8377. The portal pushes the
builder's current code here after every successful headless build, so the
asset appears in the live viewport as it is built. Protocol: one JSON
object per line.
  {"ping": true}                    -> {"ok": true, "ping": true}
  {"code": ..., "textures": {...}}  -> {"ok": bool, "error": str|None}
  {"screenshot": true}              -> renders the viewport (OpenGL) to
                                       /tmp/foundry_live_shot.png

Execution happens on Blender's main thread via bpy.app.timers (the socket
thread only queues). This is a MIRROR: the headless harness stays the
source of truth; a failure here never fails a build.
"""
import bpy
import json
import math
import os
import queue
import random
import socket
import threading
import traceback

HOST, PORT = "127.0.0.1", 8377
JOBS = queue.Queue()
_rng = random.Random(7)

# ---------------------------------------------------------------------------
# Helpers — the same contract as the headless harness, viewport flavor.
# ---------------------------------------------------------------------------
PARTS = {}
TEXTURES = {}


def _act():
    """The context's active-object attribute raises AttributeError inside
    app.timer callbacks in the GUI (window-bound context). The view
    layer's active object is the same thing and is always reachable."""
    vl = bpy.context.view_layer
    if vl is not None and vl.objects.active is not None:
        return vl.objects.active
    sc = bpy.context.scene
    return sc.objects[-1] if sc and len(sc.objects) else None


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
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    # same sRGB->linear conversion as the headless harness, so the live
    # palette matches the beauty renders
    lin = tuple((c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
                for c in color)
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
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
            tn = m.node_tree.nodes.new("ShaderNodeTexImage")
            tn.image = img
            tn.extension = "REPEAT"
            coord = m.node_tree.nodes.new("ShaderNodeTexCoord")
            m.node_tree.links.new(coord.outputs["UV"], tn.inputs["Vector"])
            m.node_tree.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
            if img.depth == 32:
                m.node_tree.links.new(tn.outputs["Alpha"],
                                       bsdf.inputs["Alpha"])
                _set_alpha_mode(m)
                m["decal"] = True  # keep native UVs (see ensure_uvs)
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
    o = _act()
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
    o = _act()
    if pivot == "base":
        o.location.z += depth / 2
    return _finish(o, name, mat)


def CONE(name, loc, r1, r2, depth, mat=None, vertices=24, pivot="base"):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=depth,
                                    vertices=vertices, location=loc)
    o = _act()
    if pivot == "base":
        o.location.z += depth / 2
    return _finish(o, name, mat)


def SPHERE(name, loc, radius, mat=None, scale=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc)
    o = _act()
    if scale:
        o.scale = scale
    return _finish(o, name, mat)


def PLANE(name, loc, size, mat=None, rot=(0, 0, 0)):
    if isinstance(size, (int, float)):
        size = (size, size)
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc, rotation=rot)
    o = _act()
    o.dimensions = (size[0], size[1], 0)
    return _finish(o, name, mat)


def MESH(name, verts, faces, mat=None, loc=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    o.location = loc
    return _finish(o, name, mat)


def GROUP(name, children, loc=(0, 0, 0)):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    g = _act()
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


def ensure_uvs(obj):
    if obj.type != "MESH":
        return
    mats = [m for m in obj.data.materials if m and m.get("uses_tex")]
    if not mats:
        return
    if any(m.get("decal") for m in mats):
        return  # decals keep native UVs (same rule as the headless harness)
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


def stage_and_frame(asset_objs, stage_kind):
    from mathutils import Vector
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.05, 0.07, 0.1, 1)
    bg.inputs["Strength"].default_value = 1.0
    bpy.ops.object.light_add(type="SUN", location=(30, -25, 42))
    sun = _act()
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(52), 0, math.radians(33))
    if stage_kind in ("water", "ground"):
        bpy.ops.mesh.primitive_plane_add(size=900, location=(0, 0, 0))
        w = _act()
        w.name = "stage_floor"
        col = (0.015, 0.05, 0.085) if stage_kind == "water" else (0.16, 0.13, 0.1)
        w.data.materials.append(MAT("stage_mat", color=col, rough=0.4))
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in asset_objs:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            wv = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, wv))
            hi = Vector(map(max, hi, wv))
    center = (lo + hi) / 2
    span = max((hi - lo).length, 4.0)
    bpy.ops.object.camera_add()
    cam = _act()
    cam.data.lens = 42
    bpy.context.scene.camera = cam
    dist = span * 1.55
    az, el = math.radians(38), math.radians(18)
    cam.location = center + Vector((dist * math.cos(el) * math.sin(az),
                                    -dist * math.cos(el) * math.cos(az),
                                    dist * math.sin(el)))
    d = center - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    # viewport: material shading + look through the camera
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE"
    except Exception:  # noqa: BLE001
        pass
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.shading.type = "MATERIAL"
                # view_camera() poll-fails from timer context even with a
                # window/area override; assigning view_perspective is the
                # same state change at the data level and always works.
                try:
                    space.region_3d.view_perspective = "CAMERA"
                except Exception:  # noqa: BLE001
                    pass


def run_build(payload):
    global TEXTURES
    TEXTURES = payload.get("textures") or {}
    HELPERS["TEXTURES"] = TEXTURES
    PARTS.clear()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ns = {"bpy": bpy, "math": math, "random": random, "__name__": "live_build"}
    ns.update(HELPERS)
    exec(compile(payload["code"], "<live>", "exec"), ns)  # noqa: S102
    asset_objs = [o for o in bpy.context.scene.objects
                  if o.type in ("MESH", "EMPTY")]
    for o in asset_objs:
        ensure_uvs(o)
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = _act()
    root.name = "ASSET_ROOT"
    for o in asset_objs:
        o.parent = root
        o.matrix_parent_inverse = root.matrix_world.inverted()
    stage_and_frame(asset_objs, ns.get("STAGE", "water"))
    return {"objects": len(asset_objs)}


def screenshot():
    path = "/tmp/foundry_live_shot.png"
    sc = bpy.context.scene
    sc.render.filepath = path
    sc.render.resolution_x, sc.render.resolution_y = 960, 600
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.opengl(write_still=True)
    return path


def pump():
    try:
        while True:
            conn, payload = JOBS.get_nowait()
            try:
                if payload.get("ping"):
                    out = {"ok": True, "ping": True}
                elif payload.get("screenshot"):
                    out = {"ok": True, "path": screenshot()}
                elif payload.get("code"):
                    out = {"ok": True, **run_build(payload)}
                else:
                    out = {"ok": False, "error": "unknown payload"}
            except Exception:  # noqa: BLE001 — report, never crash the GUI
                out = {"ok": False, "error": traceback.format_exc()[-1200:]}
            try:
                conn.sendall((json.dumps(out) + "\n").encode())
            except Exception:  # noqa: BLE001
                pass
            finally:
                conn.close()
    except queue.Empty:
        pass
    return 0.25


def serve():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(8)
    print(f"LIVE_SERVER listening on {HOST}:{PORT}", flush=True)
    while True:
        conn, _ = srv.accept()
        try:
            data = b""
            while b"\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            payload = json.loads(data.decode().strip().splitlines()[0])
            JOBS.put((conn, payload))
        except Exception:  # noqa: BLE001
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


threading.Thread(target=serve, daemon=True).start()
bpy.app.timers.register(pump, first_interval=0.5, persistent=True)
print("LIVE_BOOT ready", flush=True)
