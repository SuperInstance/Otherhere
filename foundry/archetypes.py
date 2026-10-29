"""Thor Foundry archetypes: parametric bpy builders.

Every builder takes (params: dict, rng: random.Random) and returns a list of
created objects. The seed + params ARE the asset; geometry is a cache.
Shared palette + helpers keep families coherent.
"""
import bpy
import math
import os
import random
from mathutils import Vector

# ---------------------------------------------------------------- materials
_MATS = {}

def mat(name, color, rough=0.85, metallic=0.0, tex_path=None):
    key = name
    if key in _MATS and tex_path is None:
        return _MATS[key]
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
    if tex_path:
        tex = m.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(tex_path)
        uv = m.node_tree.nodes.new("ShaderNodeUVMap")
        m.node_tree.links.new(uv.outputs["UV"], tex.inputs["Vector"])
        m.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    _MATS[key] = m
    return m

def jitter_color(c, rng, amt=0.05):
    return tuple(max(0.0, min(1.0, v + rng.uniform(-amt, amt))) for v in c)

# Harbor palette family: related boats/houses from one coastal vocabulary.
HULL_COLORS = [
    (0.48, 0.07, 0.05),   # fisherman red
    (0.04, 0.15, 0.33),   # navy
    (0.06, 0.26, 0.19),   # spruce green
    (0.72, 0.70, 0.66),   # weathered white
    (0.08, 0.09, 0.11),   # black
    (0.62, 0.38, 0.08),   # ochre
    (0.10, 0.30, 0.45),   # steel blue
    (0.35, 0.10, 0.28),   # plum
]
HOUSE_COLORS = [
    (0.78, 0.76, 0.72), (0.55, 0.62, 0.66), (0.70, 0.55, 0.38),
    (0.45, 0.55, 0.42), (0.75, 0.68, 0.55), (0.60, 0.42, 0.35),
]
WOOD = (0.36, 0.24, 0.13)
WOOD_DARK = (0.22, 0.14, 0.08)
GLASS = (0.05, 0.08, 0.12)
ROOF = (0.16, 0.15, 0.16)

def wear_color(c, wear, rng):
    grey = (0.38, 0.35, 0.31)
    t = wear * 0.55
    return tuple(c[i] * (1 - t) + grey[i] * t for i in range(3))

# ---------------------------------------------------------------- primitives
def box(name, loc, dims, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.dimensions = dims
    bpy.ops.object.transform_apply(scale=True)
    if material:
        o.data.materials.append(material)
    return o

def cyl(name, loc, radius, depth, material, rot=(0, 0, 0), verts=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius,
                                        depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    if material:
        o.data.materials.append(material)
    return o

def mesh_obj(name, verts, faces, material, uv=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    if uv:
        layer = me.uv_layers.new(name="UVMap")
        for loop in me.loops:
            layer.data[loop.index].uv = uv[loop.vertex_index]
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    if material:
        me.materials.append(material)
    return o

# ---------------------------------------------------------------- fishing boat
def build_fishing_boat(p, rng):
    L = p.get("length", 10.0)
    B = L * p.get("beam_ratio", 0.34)
    freeboard = p.get("freeboard", 0.85)
    depth = p.get("draft", 0.75)
    wear = p.get("wear", 0.3)
    hull_c = wear_color(HULL_COLORS[p.get("palette", rng.randrange(len(HULL_COLORS))) % len(HULL_COLORS)], wear, rng)
    hull_c = jitter_color(hull_c, rng, 0.03)
    tex = p.get("hull_texture")
    m_hull = mat("hull", hull_c, rough=0.55 + wear * 0.35, tex_path=tex)
    m_cab = mat("cabin", jitter_color((0.80, 0.79, 0.75), rng), rough=0.8)
    m_trim = mat("trim", jitter_color((0.12, 0.12, 0.13), rng), rough=0.6)
    m_wood = mat("wood", WOOD, rough=0.9)
    m_glass = mat("glass", GLASS, rough=0.15, metallic=0.4)

    # Lofted hull: stations along X, section = keel -> chine -> gunwale (both sides)
    N = 14
    verts, uvs = [], []
    for i in range(N):
        t = i / (N - 1)                      # 0 stern -> 1 bow
        x = (t - 0.5) * L
        taper = math.sin(math.pi * (0.06 + 0.90 * t)) ** 0.65
        bow = max(0.0, (t - 0.72) / 0.28)
        hb = (B / 2) * taper * (1 - 0.82 * bow ** 2)
        sheer = freeboard * (0.92 + 0.35 * (2 * t - 1) ** 2) + 0.28 * bow ** 2
        kd = depth * (0.55 + 0.45 * math.sin(math.pi * min(1.0, t * 1.15)))
        keel_z = -kd + 0.55 * bow ** 2 * depth
        pts = [(-hb, sheer), (-hb * 0.88, -kd * 0.45), (0.0, keel_z),
               (hb * 0.88, -kd * 0.45), (hb, sheer)]
        vmap = [1.0, 0.72, 0.5, 0.28, 0.0]
        for (yy, zz), vv in zip(pts, vmap):
            verts.append((x, yy, zz))
            uvs.append((t, vv))
    faces = []
    S = 5
    for i in range(N - 1):
        for j in range(S - 1):
            a = i * S + j; b = a + S
            faces.append((a, b, b + 1, a + 1))
    faces.append(tuple(range(0, S)))                       # transom
    bowtip = list(range((N - 1) * S, N * S))
    faces.append(tuple(reversed(bowtip)))
    objs = [mesh_obj("hull", verts, faces, m_hull, uv=uvs)]

    # Deck strip at sheer height amidships
    objs.append(box("deck", (0, 0, freeboard * 0.88), (L * 0.86, B * 0.82, 0.07), m_wood))
    # Gunwale rails
    for s in (-1, 1):
        objs.append(box("rail", (0, s * B * 0.47, freeboard * 1.02),
                        (L * 0.88, 0.09, 0.09), m_trim))
    # Cabin
    cw = L * p.get("cabin_len", 0.30); ch = p.get("cabin_h", 1.55)
    cx = -L * 0.06
    objs.append(box("cabin", (cx, 0, freeboard + ch / 2), (cw, B * 0.62, ch), m_cab))
    objs.append(box("cabin_roof", (cx, 0, freeboard + ch + 0.06),
                    (cw * 1.08, B * 0.70, 0.10), m_trim))
    for s in (-1, 1):  # cabin windows
        for k in range(3):
            objs.append(box("window", (cx - cw * 0.32 + k * cw * 0.32,
                                       s * B * 0.315, freeboard + ch * 0.62),
                            (cw * 0.20, 0.03, ch * 0.34), m_glass))
    # Mast + boom + rigging post
    mh = p.get("mast_h", 4.6)
    mx = L * 0.24
    objs.append(cyl("mast", (mx, 0, freeboard + mh / 2), 0.055, mh, m_wood))
    objs.append(cyl("boom", (mx - L * 0.16, 0, freeboard + mh * 0.52), 0.04,
                    L * 0.34, m_wood, rot=(0, math.radians(78), 0)))
    objs.append(cyl("stern_post", (-L * 0.40, 0, freeboard + 0.8), 0.045, 1.7, m_wood))
    # Wheelhouse gear: crates + buoy on deck (wear knob adds clutter)
    n_crates = 1 + int(wear * 3)
    for k in range(n_crates):
        objs.append(box("crate", (-L * 0.30 + rng.uniform(-0.3, 0.3),
                                  rng.uniform(-B * 0.2, B * 0.2), freeboard + 0.28),
                        (0.55, 0.55, 0.45), m_wood, rot=(0, 0, rng.uniform(0, 0.6))))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, location=(L * 0.30, B * 0.2, freeboard + 0.25))
    buoy = bpy.context.active_object; buoy.name = "buoy"
    buoy.data.materials.append(mat("buoy", (0.75, 0.25, 0.05), rough=0.5))
    objs.append(buoy)
    return objs

# ---------------------------------------------------------------- harbor house
def build_harbor_house(p, rng):
    w = p.get("width", 7.0); d = p.get("depth", 6.0)
    stories = int(p.get("stories", 2))
    sh = 2.9
    H = stories * sh
    pitch = p.get("roof_pitch", 0.55)
    body_c = jitter_color(HOUSE_COLORS[p.get("palette", rng.randrange(len(HOUSE_COLORS))) % len(HOUSE_COLORS)], rng)
    m_body = mat("house_body", body_c, rough=0.9)
    m_trim = mat("house_trim", (0.85, 0.84, 0.80), rough=0.85)
    m_roof = mat("roof", jitter_color(ROOF, rng, 0.03), rough=0.95)
    m_glass = mat("glass", GLASS, rough=0.15, metallic=0.4)
    m_door = mat("door", jitter_color((0.30, 0.12, 0.08), rng), rough=0.8)
    objs = [box("body", (0, 0, H / 2), (w, d, H), m_body)]
    # Gable roof prism
    rh = pitch * w / 2
    v = [(-w/2-0.25, -d/2-0.25, H), (w/2+0.25, -d/2-0.25, H), (w/2+0.25, d/2+0.25, H),
         (-w/2-0.25, d/2+0.25, H), (0, -d/2-0.25, H+rh), (0, d/2+0.25, H+rh)]
    f = [(0, 1, 4), (3, 5, 2), (0, 4, 5, 3), (1, 2, 5, 4), (0, 3, 2, 1)]
    objs.append(mesh_obj("roof", v, f, m_roof))
    # Windows on front (+Y? use -Y face as street side) both floors
    for s in range(stories):
        for k in range(int(w // 2.2)):
            x = -w / 2 + 1.2 + k * 2.2
            objs.append(box("win", (x, -d / 2 - 0.03, 1.1 + s * sh), (0.85, 0.06, 1.15), m_glass))
            objs.append(box("win_trim", (x, -d / 2 - 0.015, 1.1 + s * sh), (1.0, 0.03, 1.3), m_trim))
    objs.append(box("door", (w * 0.28, -d / 2 - 0.03, 1.05), (0.95, 0.07, 2.1), m_door))
    objs.append(box("step", (w * 0.28, -d / 2 - 0.35, 0.09), (1.3, 0.7, 0.18), m_trim))
    if rng.random() < 0.7:
        objs.append(box("chimney", (w * 0.25, 0, H + rh * 0.55), (0.55, 0.55, 1.3),
                        mat("brick", (0.45, 0.22, 0.16), rough=0.95)))
    return objs

# ---------------------------------------------------------------- pier
def build_pier(p, rng):
    L = p.get("length", 18.0); W = p.get("width", 3.2)
    gap = p.get("piling_gap", 3.0)
    m_wood = mat("pier_wood", jitter_color(WOOD, rng), rough=0.95)
    m_dark = mat("pier_dark", WOOD_DARK, rough=0.95)
    objs = []
    n = int(L / 0.32)
    for i in range(n):  # planks
        x = -L / 2 + (i + 0.5) * (L / n)
        objs.append(box("plank", (x, 0, 1.15), (L / n - 0.03, W, 0.09), m_wood))
    x = -L / 2 + gap / 2
    while x < L / 2:
        for s in (-1, 1):
            objs.append(cyl("piling", (x, s * (W / 2 - 0.2), 0.3), 0.14, 2.4, m_dark, verts=10))
        x += gap
    for s in (-1, 1):  # side rails stringers
        objs.append(box("stringer", (0, s * (W / 2 - 0.05), 1.02), (L, 0.12, 0.18), m_dark))
    return objs

# ---------------------------------------------------------------- spruce
def build_spruce(p, rng):
    H = p.get("height", 9.0)
    density = p.get("branch_density", 5)
    snow = p.get("snow", 0.4)
    m_trunk = mat("trunk", (0.25, 0.16, 0.10), rough=1.0)
    m_leaf = mat("spruce_green", jitter_color((0.07, 0.20, 0.10), rng, 0.03), rough=1.0)
    m_snow = mat("snow", (0.92, 0.94, 0.97), rough=0.7)
    objs = [cyl("trunk", (0, 0, H * 0.18), 0.14, H * 0.36, m_trunk, verts=8)]
    layers = int(density) + 2
    for i in range(layers):
        t = i / layers
        z = H * (0.28 + 0.68 * t)
        r = H * 0.30 * (1 - t) ** 0.8 + 0.2
        h = H * 0.30
        bpy.ops.mesh.primitive_cone_add(vertices=14, radius1=r, radius2=0.05,
                                        depth=h, location=(0, 0, z))
        cone = bpy.context.active_object; cone.name = "bough"
        cone.data.materials.append(m_leaf); objs.append(cone)
        if snow > 0.05 and rng.random() < snow + 0.25:
            bpy.ops.mesh.primitive_cone_add(vertices=14, radius1=r * 0.82, radius2=0.04,
                                            depth=h * 0.45, location=(0, 0, z + h * 0.30))
            cap = bpy.context.active_object; cap.name = "snowcap"
            cap.data.materials.append(m_snow); objs.append(cap)
    return objs

# ---------------------------------------------------------------- terrain
def build_terrain(p, rng):
    size = p.get("size", 220.0)
    height = p.get("height", 26.0)
    res = 96
    img_path = p.get("heightmap")
    heights = None
    if img_path:
        try:
            img = bpy.data.images.load(img_path)
            px = list(img.pixels[:])
            iw, ih = img.size
            ch = img.channels
            heights = [[px[(y * iw + x) * ch] for x in range(iw)] for y in range(ih)]
            res = min(iw, ih)
        except Exception as e:
            print("TERRAIN heightmap load failed:", e)
            heights = None
    if heights is None:  # ridged fbm fallback
        grid = {}
        def n2(x, y):
            if (x, y) not in grid:
                grid[(x, y)] = rng.random()
            return grid[(x, y)]
        def smooth(x, y):
            xi, yi = int(x), int(y)
            fx, fy = x - xi, y - yi
            fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
            return (n2(xi, yi) * (1 - fx) * (1 - fy) + n2(xi + 1, yi) * fx * (1 - fy) +
                    n2(xi, yi + 1) * (1 - fx) * fy + n2(xi + 1, yi + 1) * fx * fy)
        heights = []
        for j in range(res):
            row = []
            for i in range(res):
                v = 0.0; amp = 1.0; fr = 3.0
                for _ in range(4):
                    v += amp * (1 - abs(2 * smooth(i / res * fr, j / res * fr) - 1))
                    amp *= 0.5; fr *= 2.1
                row.append(v / 1.9)
            heights.append(row)
    verts, faces = [], []
    for j in range(res):
        for i in range(res):
            x = (i / (res - 1) - 0.5) * size
            y = (j / (res - 1) - 0.5) * size
            edge = min(i, j, res - 1 - i, res - 1 - j) / (res * 0.16)
            z = heights[j][i] * height * min(1.0, edge) - 1.2
            verts.append((x, y, z))
    for j in range(res - 1):
        for i in range(res - 1):
            a = j * res + i
            faces.append((a, a + 1, a + res + 1, a + res))
    o = mesh_obj("terrain", verts, faces, None)
    # Height/slope-graded material via nodes
    m = bpy.data.materials.new("terrain_mat"); m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.08
    ramp.color_ramp.elements[0].color = (0.10, 0.16, 0.08, 1)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = (0.32, 0.28, 0.22, 1)
    el = ramp.color_ramp.elements.new(0.85); el.color = (0.90, 0.92, 0.95, 1)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    div = nt.nodes.new("ShaderNodeMath"); div.operation = 'DIVIDE'
    div.inputs[1].default_value = height
    nt.links.new(geo.outputs["Position"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], div.inputs[0])
    nt.links.new(div.outputs["Value"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    o.data.materials.append(m)
    return [o]

# ---------------------------------------------------------------- sitka house
# Parametric Sitka house family. A draw is parameterised by the real OSM
# footprint (foot_w / foot_d), the roofs lab's roof form + height band
# (roof_form, stories, roof_pitch solved from the lidar height), siding and
# roof materials from the gen3d texture studies, and the massing the gen3d
# house winners validated: grounded body on a foundation, complete roof,
# chimney, a legible window rhythm, an arctic-entry porch variant.
# Parameter provenance: ~/sitka-distill/pipeline/HOUSE-FAMILY.md.
# Local frame: X = street-facing width, Y = depth, front faces -Y, z up.

# Textures ship beside this file so the generator runs from a fresh checkout
# (the Otherhere repo carries them under foundry/textures/). The legacy
# absolute path is the fallback for the pre-move working copy.
_HERE = os.path.dirname(os.path.abspath(__file__))
_LOCAL_TEX = os.path.join(_HERE, "textures")
SITKA_TEX = (_LOCAL_TEX + "/") if os.path.isdir(_LOCAL_TEX) \
    else "/home/caseydigennaro/sitka-distill/gen3d/textures/"
SIDING_TEX = {
    "white_siding": "white-siding.png",
    "cedar_shingle": "cedar-shingle.png",
    "pale_blue": "pale-blue-clapboard.png",
    "red_brown": "red-brown-siding.png",
}
ROOF_TEX = {
    "galvanised": "galvanised-roof.png",
    "asphalt": "asphalt-shingle-roof.png",
    "green_metal": "green-metal-roof.png",
}
_tex_mats = {}

def tex_mat(name, tex_file, tint=(1.0, 1.0, 1.0), rough=0.9, metallic=0.0, scale=2.2):
    if name in _tex_mats:
        return _tex_mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(SITKA_TEX + tex_file)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (scale, scale, scale)
    uv = nt.nodes.new("ShaderNodeUVMap")
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = 'MULTIPLY'
    mix.inputs[0].default_value = 1.0
    mix.inputs[2].default_value = (*tint, 1.0)
    nt.links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], mix.inputs[1])
    nt.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
    _tex_mats[name] = m
    return m

def _fix_normals(o):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(o.data)
    bm.free()

def _gable_prism(span, ridge_len, z0, rise, o, uvk=0.3):
    """Harbour-house prism topology (ridge along Y, X extent = span,
    Y extent = ridge_len). Returns (verts, slope_faces, gable_faces, uvs):
    slopes take the roof material, gable ends take the body material."""
    x, y = span / 2 + o, ridge_len / 2 + o
    v = [(-x, -y, z0), (x, -y, z0), (x, y, z0), (-x, y, z0),
         (0, -y, z0 + rise), (0, y, z0 + rise)]
    slopes = [(0, 4, 5, 3), (1, 2, 5, 4), (0, 3, 2, 1)]
    gables = [(0, 1, 4), (3, 5, 2)]
    uv = [(vx * uvk, vy * uvk) for (vx, vy, vz) in v]
    return v, slopes, gables, uv

def _rot90(verts):
    """Rotate (x, y) -> (-y, x): ridge along Y becomes ridge along X."""
    return [(-y, x, z) for (x, y, z) in verts]

def _shift(verts, dx, dy, dz=0.0):
    return [(x + dx, y + dy, z + dz) for (x, y, z) in verts]

def build_sitka_house(p, rng):
    W = float(p.get("foot_w", 9.5)); D = float(p.get("foot_d", 8.0))
    stories = int(p.get("stories", 2))
    sh = float(p.get("storey_h", 2.9))
    found = 0.35
    eaves = float(p.get("eaves_h", 0.0)) or stories * sh
    top = found + eaves
    form = p.get("roof_form", "gable")
    if form not in ("gable", "cross_gable", "hip", "flat", "shed"):
        form = "gable"  # lab labels outside the family (dome/complex) fall back
    pitch = float(p.get("roof_pitch", 0.6))
    ridge_x = (p.get("ridge_dir", "street") != "front")  # ridge along X?
    o = float(p.get("overhang", 0.32))
    wear = float(p.get("wear", 0.15))
    palette = int(p.get("palette", 0))

    # ---- materials
    siding = p.get("siding", "white_siding")
    grey = 1.0 - 0.30 * wear
    if siding in SIDING_TEX:
        # texture repeat tuned per stock: clapboard fine, shingle mid,
        # pale-blue is board-and-batten (wide boards) per the texture study
        tscale = {"white_siding": 3.4, "cedar_shingle": 2.6,
                  "pale_blue": 1.8, "red_brown": 3.4}[siding]
        m_body = tex_mat(f"sitka_siding_{siding}", SIDING_TEX[siding],
                         tint=(grey, grey, grey * 1.01), rough=0.92, scale=tscale)
    else:
        bc = p.get("body_colour") or HOUSE_COLORS[palette % len(HOUSE_COLORS)]
        m_body = mat(f"sitka_body_{palette}_{siding}",
                     jitter_color(wear_color(tuple(bc), wear, rng), rng, 0.03), rough=0.9)
    roof_kind = p.get("roof_mat", "galvanised")
    if roof_kind in ROOF_TEX:
        rough, metal = {"galvanised": (0.55, 0.35), "asphalt": (0.95, 0.0),
                        "green_metal": (0.5, 0.2)}[roof_kind]
        m_roof = tex_mat(f"sitka_roof_{roof_kind}", ROOF_TEX[roof_kind],
                         rough=rough, metallic=metal, scale=1.5)
    elif roof_kind == "red_metal":
        m_roof = mat("sitka_roof_red", (0.42, 0.10, 0.07), rough=0.55, metallic=0.25)
    else:
        m_roof = mat("sitka_roof_dark", jitter_color(ROOF, rng, 0.03), rough=0.95)
    m_trim = mat("sitka_trim", (0.85, 0.84, 0.80), rough=0.85)
    m_glass = mat("sitka_glass", GLASS, rough=0.15, metallic=0.4)
    door_cols = [(0.30, 0.12, 0.08), (0.10, 0.24, 0.14), (0.08, 0.14, 0.30),
                 (0.35, 0.28, 0.10), (0.22, 0.08, 0.16), (0.12, 0.12, 0.13)]
    m_door = mat(f"sitka_door_{palette % 6}", door_cols[palette % 6], rough=0.8)
    m_found = mat("sitka_concrete", (0.42, 0.41, 0.39), rough=1.0)
    m_brick = mat("sitka_brick", (0.45, 0.22, 0.16), rough=0.95)

    objs = [box("foundation", (0, 0, found / 2), (W - 0.12, D - 0.12, found), m_found),
            box("body", (0, 0, found + eaves / 2), (W, D, eaves), m_body)]

    # ---- roof
    span = D if ridge_x else W            # dimension across the ridge
    rlen = W if ridge_x else D            # dimension along the ridge
    rise = pitch * span / 2
    rt = top + rise
    if form in ("gable", "cross_gable"):
        v, fs, fg, uv = _gable_prism(span, rlen, top, rise, o)
        if ridge_x:
            v = _rot90(v)
            uv = [(x * 0.3, y * 0.3) for (x, y, z) in v]
        roof = mesh_obj("roof", v, fs, m_roof, uv=uv)
        _fix_normals(roof); objs.append(roof)
        gable = mesh_obj("gable_end", v, fg, m_body, uv=uv)
        _fix_normals(gable); objs.append(gable)
        if form == "cross_gable":
            wing_w = 0.44 * (W if ridge_x else D)
            wing_len = 0.55 * (D if ridge_x else W) + 0.85
            wtop = top
            wrise = rise * 0.92
            wv, wfs, wfg, wuv = _gable_prism(wing_w, wing_len, wtop, wrise, o * 0.8)
            if not ridge_x:
                wv = _rot90(wv)
                wuv = [(x * 0.3, y * 0.3) for (x, y, z) in wv]
            # wing sits centred on the front half, ridge perpendicular to
            # the main ridge (centred so the window pass can work around it)
            cx = 0.0
            if ridge_x:
                cy = -D / 2 + wing_len / 2 - 0.85
                wv = _shift(wv, cx, cy)
                objs.append(box("wing_body", (cx, -D / 2 - 0.40, found + eaves / 2),
                                (wing_w, 0.92, eaves), m_body))
            else:
                cy = 0.0
                wv = _shift(wv, -W / 2 + wing_len / 2 - 0.85, cy)
                objs.append(box("wing_body", (-W / 2 - 0.40, cy, found + eaves / 2),
                                (0.92, wing_w, eaves), m_body))
            wing = mesh_obj("roof_wing", wv, wfs, m_roof, uv=wuv)
            _fix_normals(wing); objs.append(wing)
            wgable = mesh_obj("wing_gable", wv, wfg, m_body, uv=wuv)
            _fix_normals(wgable); objs.append(wgable)
    elif form == "hip":
        xe, ye = rlen / 2 + o, span / 2 + o
        rl = max((rlen - span) / 2, 0.0)
        v = [(-xe, -ye, top), (xe, -ye, top), (xe, ye, top), (-xe, ye, top),
             (-rl, 0, rt), (rl, 0, rt)]
        f = [(0, 1, 5, 4), (2, 3, 4, 5), (3, 0, 4), (1, 2, 5), (0, 3, 2, 1)]
        if not ridge_x:
            v = _rot90(v)
        uv = [(x * 0.3, y * 0.3) for (x, y, z) in v]
        roof = mesh_obj("roof", v, f, m_roof, uv=uv)
        _fix_normals(roof); objs.append(roof)
    elif form == "shed":
        xe, ye = W / 2 + o, D / 2 + o
        lo, hi = top + 0.25, top + max(rise, 0.8)
        v = [(-xe, -ye, top), (xe, -ye, top), (xe, ye, top), (-xe, ye, top),
             (-xe, -ye, lo), (xe, -ye, lo), (xe, ye, hi), (-xe, ye, hi)]
        f = [(4, 5, 6, 7), (0, 1, 5, 4), (3, 2, 6, 7), (0, 4, 7, 3),
             (1, 2, 6, 5), (0, 3, 2, 1)]
        uv = [(x * 0.3, y * 0.3) for (x, y, z) in v]
        roof = mesh_obj("roof", v, f, m_roof, uv=uv)
        _fix_normals(roof); objs.append(roof)
    else:  # flat: slab + parapet
        objs.append(box("roof_slab", (0, 0, top + 0.11), (W + 0.35, D + 0.35, 0.22), m_roof))
        for sx, sy, dx, dy in ((0, -1, W + 0.35, 0.18), (0, 1, W + 0.35, 0.18),
                               (-1, 0, 0.18, D + 0.35), (1, 0, 0.18, D + 0.35)):
            objs.append(box("parapet", (sx * (W / 2 + 0.09), sy * (D / 2 + 0.09), top + 0.2),
                            (dx, dy, 0.4), m_body))

    # ---- openings: front (-Y) both floors, sides sparser, one at the back
    # The cross-gable wing (recomputed here with the same draws the roof pass
    # used: cx was consumed from rng before the chimney draw, in roof order —
    # instead the wing centre is re-derived deterministically from foot dims
    # so this pass can leave a window-free zone where the bump covers the wall
    # and put one window per floor on the bump's own front face.)
    rhythm = float(p.get("win_rhythm", 2.2))
    door_x = float(p.get("door_off", rng.uniform(-0.22, 0.22))) * W
    rows = max(1, int(round(eaves / sh)))
    wing_zone = None  # (centre, halfwidth, face) in the window pass's terms
    if form == "cross_gable":
        if ridge_x:
            wing_zone = (0.0, 0.44 * W / 2 + 0.55, "front")
        else:
            wing_zone = (0.0, 0.44 * D / 2 + 0.55, "left")
    def win_front(x, s, yoff=0.0):
        z = found + 1.5 + s * sh
        objs.append(box("win_trim", (x, -D / 2 - yoff - 0.012, z), (1.0, 0.025, 1.3), m_trim))
        objs.append(box("win", (x, -D / 2 - yoff - 0.03, z), (0.85, 0.06, 1.15), m_glass))
    def win_side(y, s, sx, xoff=0.0):
        z = found + 1.5 + s * sh
        objs.append(box("win_trim", (sx * (W / 2 + xoff + 0.012), y, z), (0.025, 1.0, 1.3), m_trim))
        objs.append(box("win", (sx * (W / 2 + xoff + 0.03), y, z), (0.06, 0.85, 1.15), m_glass))
    nfx = max(1, int((W - 1.2) // rhythm))
    for s in range(rows):
        for k in range(nfx):
            x = -W / 2 + 1.2 + k * rhythm if nfx > 1 else 0.0
            if abs(x - door_x) < 0.8 and s == 0:
                continue
            if wing_zone and wing_zone[2] == "front" and abs(x - wing_zone[0]) < wing_zone[1]:
                continue
            win_front(x, s)
        if wing_zone and wing_zone[2] == "front":
            win_front(wing_zone[0], s, yoff=0.86)  # one window on the bump face
        for sx in (-1, 1):
            nsx = max(1, int((D - 1.2) // 2.8))
            for k in range(nsx):
                y = -D / 2 + 1.4 + k * 2.8 if nsx > 1 else 0.0
                if wing_zone and wing_zone[2] == "left" and sx == -1 and abs(y - wing_zone[0]) < wing_zone[1]:
                    continue
                win_side(y, s, sx)
            if wing_zone and wing_zone[2] == "left" and sx == -1:
                win_side(wing_zone[0], s, sx, xoff=0.86)
        z = found + 1.5 + s * sh  # one back window per floor, offset from centre
        objs.append(box("win", (W * 0.18, D / 2 + 0.03, z), (0.85, 0.06, 1.15), m_glass))

    # ---- entry: arctic-entry porch or plain door + step
    if int(p.get("porch", 0)):
        objs.append(box("porch", (door_x, -D / 2 - 0.52, found + 1.13),
                        (1.9, 1.14, 2.26), m_body))
        objs.append(box("porch_cap", (door_x, -D / 2 - 0.55, found + 2.36),
                        (2.15, 1.45, 0.14), m_roof))
        objs.append(box("door", (door_x, -D / 2 - 1.11, found + 1.05),
                        (0.92, 0.06, 2.1), m_door))
        objs.append(box("step", (door_x, -D / 2 - 1.35, 0.09), (1.3, 0.55, 0.18), m_trim))
    else:
        objs.append(box("door", (door_x, -D / 2 - 0.03, found + 1.05),
                        (0.95, 0.07, 2.1), m_door))
        objs.append(box("step", (door_x, -D / 2 - 0.35, 0.09), (1.3, 0.7, 0.18), m_trim))

    # ---- chimney on the ridge line
    if int(p.get("chimney", 1)) and form != "flat":
        off = rng.uniform(-0.25, 0.25)
        if ridge_x:
            objs.append(box("chimney", (off * W, 0, rt - 0.3), (0.55, 0.55, 1.5), m_brick))
        elif form == "shed":
            objs.append(box("chimney", (off * W, D * 0.2, top + max(rise, 0.8) - 0.3),
                            (0.55, 0.55, 1.5), m_brick))
        else:
            objs.append(box("chimney", (0, off * D, rt - 0.3), (0.55, 0.55, 1.5), m_brick))
    return objs

BUILDERS = {
    "fishing_boat": build_fishing_boat,
    "harbor_house": build_harbor_house,
    "pier": build_pier,
    "spruce": build_spruce,
    "terrain": build_terrain,
    "sitka_house": build_sitka_house,
}

DEFAULTS = {
    "fishing_boat": {"length": 10.0, "beam_ratio": 0.34, "freeboard": 0.85,
                     "draft": 0.75, "cabin_len": 0.30, "cabin_h": 1.55,
                     "mast_h": 4.6, "wear": 0.3},
    "harbor_house": {"width": 7.0, "depth": 6.0, "stories": 2, "roof_pitch": 0.55},
    "pier": {"length": 18.0, "width": 3.2, "piling_gap": 3.0},
    "spruce": {"height": 9.0, "branch_density": 5, "snow": 0.4},
    "terrain": {"size": 220.0, "height": 26.0},
    "sitka_house": {"foot_w": 9.5, "foot_d": 8.0, "stories": 2, "storey_h": 2.9,
                    "roof_form": "gable", "roof_pitch": 0.6, "ridge_dir": "street",
                    "siding": "white_siding", "palette": 0, "roof_mat": "galvanised",
                    "porch": 0, "chimney": 1, "win_rhythm": 2.2, "wear": 0.15,
                    "overhang": 0.32},
}
