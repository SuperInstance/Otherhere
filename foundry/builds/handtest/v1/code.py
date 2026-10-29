# Hand test: three-masted sailboat via harness helpers.
STAGE = "water"

wood = MAT("hull_wood", color=(0.32, 0.19, 0.1), rough=0.8)
darkwood = MAT("dark_wood", color=(0.2, 0.12, 0.06), rough=0.85)
canvas = MAT("sail_canvas", color=(0.92, 0.88, 0.78), rough=0.95)
red = MAT("flag_red", color=(0.65, 0.08, 0.08), rough=0.9)
brass = MAT("brass", color=(0.72, 0.53, 0.2), rough=0.35, metal=0.9)

# --- hull: lofted sections along X (stern -5 -> bow +5.2) ---
secs = [(-5.0, 1.05, 1.0, 0.05), (-2.5, 1.5, 1.05, -0.55), (0.0, 1.7, 1.1, -0.75),
        (2.5, 1.4, 1.15, -0.5), (4.2, 0.8, 1.25, 0.1), (5.2, 0.03, 1.35, 0.7)]
verts, faces = [], []
for (x, hw, deck, keel) in secs:
    verts += [(x, -hw, deck), (x, -hw * 0.55, keel), (x, hw * 0.55, keel), (x, hw, deck)]
n = len(secs)
for i in range(n - 1):
    b0, b1 = i * 4, (i + 1) * 4
    for k in range(4):
        k2 = (k + 1) % 4
        faces.append((b0 + k, b1 + k, b1 + k2, b0 + k2))
faces.append((0, 1, 2, 3))                      # transom
faces.append(((n - 1) * 4 + 3, (n - 1) * 4 + 2, (n - 1) * 4 + 1, (n - 1) * 4))  # bow cap
MESH("hull", verts, faces, mat=wood, loc=(0, 0, 0.75))

BOX("deck", (0, 0, 1.86), (9.6, 2.6, 0.12), mat=darkwood)
BOX("cabin", (-1.2, 0, 1.92), (3.2, 1.7, 1.0), mat=darkwood, pivot="base")
BOX("rudder", (-5.25, 0, 0.6), (0.5, 0.1, 1.1), mat=darkwood)
CYL("bowsprit", (5.6, 0, 2.2), 0.07, 2.6, mat=darkwood, rot=(0, math.radians(65), 0), pivot="center")

# --- three masts with triangular sails ---
def mast(name, x, h, sail_w):
    CYL(name, (x, 0, 1.9), 0.09, h, mat=darkwood)
    CYL(name + "_boom", (x - sail_w / 2, 0, 2.35), 0.05, sail_w, mat=darkwood,
        rot=(0, math.radians(90), 0), pivot="center")
    sv = [(0, 0, 0.5), (-sail_w, 0, 0.55), (0, 0, h - 0.4)]
    MESH("sail_" + name, sv, [(0, 1, 2)], mat=canvas, loc=(x - 0.12, 0, 1.9))
    sv2 = [(0, 0, 0.5), (sail_w * 0.55, 0, 0.6), (0, 0, h - 1.2)]
    MESH("jib_" + name, sv2, [(0, 1, 2)], mat=canvas, loc=(x + 0.12, 0, 1.9))

mast("mast_fore", 3.1, 7.2, 2.6)
mast("mast_main", 0.1, 8.6, 3.4)
mast("mast_mizzen", -3.0, 6.4, 2.2)

PLANE("flag_main", (0.1, 0, 10.35), (1.1, 0.6), mat=red)
SPHERE("lantern", (-4.9, 0, 2.6), 0.16, mat=brass)
