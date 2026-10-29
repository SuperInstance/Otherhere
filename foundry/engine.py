"""Thor Foundry engine: runs INSIDE Blender (blender -b --python engine.py -- <args>).

Modes: probe | mint | familysheet | turntable | bob
Prints one line: FOUNDRY_RESULT {json}
"""
import bpy
import sys
import os
import json
import math
import time
import random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archetypes as A


def argv():
    args = sys.argv[sys.argv.index("--") + 1:]
    out = {}
    it = iter(args)
    for k in it:
        if k.startswith("--"):
            out[k[2:]] = next(it)
    return out


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def setup_cycles(samples, want_gpu=True):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    avail = [i.identifier for i in sc.cycles.bl_rna.properties["denoiser"].enum_items]
    if "OPENIMAGEDENOISE" in avail or "OPTIX" in avail:
        sc.cycles.use_denoising = True
    else:
        sc.cycles.use_denoising = False
        print("FOUNDRY no denoiser in this build; denoising off")
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
            except Exception as e:
                print("FOUNDRY backend", backend, "failed:", e)
    if chosen == "CPU":
        sc.cycles.device = "CPU"
    return chosen


def add_stage(water=True, sun_energy=3.2):
    world = bpy.data.worlds.get("World")
    if world is None:
        world = bpy.data.worlds.new("World")
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
    sun.data.energy = sun_energy
    sun.rotation_euler = (math.radians(52), 0, math.radians(33))
    if water:
        bpy.ops.mesh.primitive_plane_add(size=900, location=(0, 0, 0))
        w = bpy.context.active_object
        w.name = "water"
        m = bpy.data.materials.new("water_mat")
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (0.015, 0.05, 0.085, 1)
        b.inputs["Roughness"].default_value = 0.12
        b.inputs["Metallic"].default_value = 0.05
        w.data.materials.append(m)
    bpy.context.scene.world = world


def look_at(cam, target):
    d = target - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def add_cam(loc, target, lens=42):
    from mathutils import Vector as V
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.active_object
    cam.data.lens = lens
    look_at(cam, V(target))
    bpy.context.scene.camera = cam
    return cam


def render_to(path, rx, ry, samples):
    sc = bpy.context.scene
    sc.render.resolution_x = rx
    sc.render.resolution_y = ry
    sc.render.filepath = path
    sc.render.image_settings.file_format = "PNG"
    t = time.time()
    bpy.ops.render.render(write_still=True)
    return time.time() - t


def build(arch, params, seed):
    import zlib
    rng = random.Random(seed * 7919 + zlib.crc32(arch.encode()))
    fn = A.BUILDERS[arch]
    objs = fn(params, rng)
    return objs


def group_under_empty(objs, name):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = name
    for o in objs:
        o.parent = root
    return root


def mode_probe(a):
    devices = {}
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA", "METAL", "HIP"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            devices[backend] = [(d.name, d.type) for d in prefs.devices]
        except Exception as e:
            devices[backend] = "ERR: " + str(e)
    chosen = setup_cycles(32)
    add_stage(water=False, sun_energy=3.0)
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1))
    add_cam((6, -6, 4), (0, 0, 1))
    out = "/tmp/foundry_probe.png"
    secs = render_to(out, 480, 360, 32)
    return {"devices": devices, "chosen": chosen, "cube_render_s": round(secs, 2),
            "probe_png": out}


def mode_mint(a):
    arch, seed = a["archetype"], int(a["seed"])
    params = json.loads(a.get("params", "{}"))
    outdir = a["out"]
    os.makedirs(outdir, exist_ok=True)
    chosen = setup_cycles(int(a.get("samples", "48")))
    objs = build(arch, params, seed)
    add_stage(water=(arch != "terrain"))
    # preview framing per archetype
    frames = {"fishing_boat": ((13, -11, 5.5), (0, 0, 0.8), 40),
              "harbor_house": ((11, -12, 6), (0, 0, 2.2), 42),
              "sitka_house": ((12, -13, 6.5), (0, 0, 2.4), 42),
              "pier": ((15, -13, 7), (0, 0, 0.6), 40),
              "spruce": ((8, -8, 5), (0, 0, 3.6), 46),
              "terrain": ((130, -130, 70), (0, 0, 4), 38)}
    if arch == "sitka_house":
        # adaptive framing: footprint ranges 6.5-31 m, so the fixed harbour
        # framing crops (or misses) large draws — scale distance to the plan
        W = float(params.get("foot_w", 9.5)); D = float(params.get("foot_d", 8.0))
        H = 0.35 + (float(params.get("eaves_h", 0.0)) or
                    int(params.get("stories", 2)) * float(params.get("storey_h", 2.9)))
        k = (2.0 * max(W, D) + 4.0) / 18.9
        loc, tgt, lens = (12 * k, -13 * k, 6.5 * k + H * 0.25), (0, 0, min(H * 0.45, 4.0)), 42
    else:
        loc, tgt, lens = frames.get(arch, ((12, -12, 6), (0, 0, 1), 42))
    add_cam(loc, tgt, lens)
    # export before render (selection = the built objects)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    glb = os.path.join(outdir, "asset.glb")
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB",
                              use_selection=True, export_apply=True)
    blend = os.path.join(outdir, "asset.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    secs = render_to(os.path.join(outdir, "preview.png"), 768, 512, int(a.get("samples", "48")))
    return {"device": chosen, "render_s": round(secs, 2), "glb": glb, "blend": blend,
            "objects": len(objs)}


def mode_familysheet(a):
    members = a["members"].split(",")
    arch = a["archetype"]
    chosen = setup_cycles(48)
    add_stage(water=True)
    spacing = {"fishing_boat": 6.8, "harbor_house": 9.5, "sitka_house": 10.5}.get(arch, 8.0)
    yaw = {"fishing_boat": 90.0, "harbor_house": 0.0}.get(arch, 0.0)
    n = len(members)
    for i, glb in enumerate(members):
        bpy.ops.import_scene.gltf(filepath=glb)
        imported = [o for o in bpy.context.selected_objects]
        root = group_under_empty(imported, f"member{i}")
        root.location.x = (i - (n - 1) / 2) * spacing
        root.rotation_euler.z = math.radians(yaw)
    span = spacing * n
    add_cam((0, -span * 1.05, span * 0.30), (0, 0, 1.0), 40)
    out = a["out"]
    secs = render_to(out, 1600, 640, 48)
    return {"device": chosen, "render_s": round(secs, 2), "sheet": out, "members": n}


def mode_turntable(a):
    arch, seed = a["archetype"], int(a["seed"])
    params = json.loads(a.get("params", "{}"))
    frames_dir = a["out"]
    os.makedirs(frames_dir, exist_ok=True)
    chosen = setup_cycles(32)
    objs = build(arch, params, seed)
    add_stage(water=True)
    R = 14.5
    times = []
    for i in range(12):
        th = math.radians(i * 30)
        loc = (R * math.sin(th), -R * math.cos(th), 5.0)
        if i == 0:
            cam = add_cam(loc, (0, 0, 1.0), 42)
        else:
            cam.location = loc
            look_at(cam, __import__("mathutils").Vector((0, 0, 1.0)))
        times.append(render_to(os.path.join(frames_dir, f"frame_{i:02d}.png"), 576, 576, 32))
    return {"device": chosen, "frames": 12,
            "per_frame_s": [round(t, 2) for t in times]}


def mode_bob(a):
    seed = int(a["seed"])
    params = json.loads(a.get("params", "{}"))
    frames_dir = a["out"]
    os.makedirs(frames_dir, exist_ok=True)
    chosen = setup_cycles(32)
    boat = build("fishing_boat", params, seed)
    root = group_under_empty(boat, "BOAT_ROOT")
    pier = build("pier", {"length": 16.0, "width": 3.0, "piling_gap": 3.2}, seed)
    for o in pier:
        o.location.x += 1.5
        o.location.y += 6.2
    add_stage(water=True)
    add_cam((13.5, -12, 4.2), (0, 0, 1.0), 40)
    amp = float(params.get("bob_amp", 0.16))
    period = float(params.get("bob_period", 2.4))  # seconds
    fps = 12
    n = int(period * fps)
    sc = bpy.context.scene
    sc.render.fps = fps
    times = []
    for f in range(n):
        ph = 2 * math.pi * f / n
        root.location.z = amp * math.sin(ph)
        root.rotation_euler.x = math.radians(1.7) * math.sin(ph + 0.6)
        root.rotation_euler.y = math.radians(1.1) * math.sin(ph * 0.5)
        root.keyframe_insert("location", frame=f + 1)
        root.keyframe_insert("rotation_euler", frame=f + 1)
        times.append(render_to(os.path.join(frames_dir, f"frame_{f:02d}.png"), 640, 448, 32))
    blend = os.path.join(os.path.dirname(frames_dir.rstrip("/")), "bob_scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    return {"device": chosen, "frames": n, "fps": fps, "blend": blend,
            "per_frame_s": [round(t, 2) for t in times]}


def mode_street(a):
    members = json.loads(a["members"])
    samples = int(a.get("samples", "48"))
    chosen = setup_cycles(samples)
    add_stage(water=False, sun_energy=3.2)
    span = float(a["span"])
    bpy.ops.mesh.primitive_plane_add(size=1600, location=(0, 0, -0.03))
    g = bpy.context.active_object
    g.name = "ground"
    gm = bpy.data.materials.new("ground_mat")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.055, 0.085, 0.045, 1)
    gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
    g.data.materials.append(gm)

    def strip(name, y, w, col, z=0.0, h=0.06):
        bpy.ops.mesh.primitive_cube_add(location=(0, y, z))
        s = bpy.context.active_object
        s.name = name
        s.dimensions = (span + 60, w, h)
        bpy.ops.object.transform_apply(scale=True)
        m = bpy.data.materials.new(name + "_mat")
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*col, 1)
        m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
        s.data.materials.append(m)

    strip("road", 0, 7.6, (0.075, 0.075, 0.08))
    strip("walk_n", 4.4, 1.1, (0.45, 0.44, 0.42), z=0.02, h=0.09)
    strip("walk_s", -4.4, 1.1, (0.45, 0.44, 0.42), z=0.02, h=0.09)
    for m in members:
        bpy.ops.import_scene.gltf(filepath=m["glb"])
        imported = [o for o in bpy.context.selected_objects]
        root = group_under_empty(imported, "house")
        root.location.x = float(m["x"])
        root.location.y = float(m["y"])
        root.rotation_euler.z = math.radians(float(m.get("yaw", 0.0)))
    add_cam((0, -span * 1.25, span * 0.62), (0, 0, 1.0), 40)
    out = a["out"]
    secs = render_to(out, int(a.get("rx", "2600")), int(a.get("ry", "900")), samples)
    return {"device": chosen, "render_s": round(secs, 2), "sheet": out,
            "members": len(members)}

def main():
    a = argv()
    mode = a.get("mode", "probe")
    clear_scene()
    fn = {"probe": mode_probe, "mint": mode_mint, "familysheet": mode_familysheet,
          "turntable": mode_turntable, "bob": mode_bob, "street": mode_street}[mode]
    result = fn(a)
    result["mode"] = mode
    print("FOUNDRY_RESULT " + json.dumps(result))


main()
