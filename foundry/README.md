# Thor Foundry

The Blender-side asset factory for Otherhere's town.

It is the sibling of the game's own generator. The game builds geometry from
JSON generator specs interpreted in `packages/core`; the foundry builds
geometry in Blender, where real texture maps and real light are available.
Both answer the same question — what does this town look like — by turning a
name plus parameters into a thing you can stand in.

## The doctrine

**Params + seed ARE the asset. The mesh and the render are a cache.**

That is not a slogan here; it is the file layout. `recipes/*.json` holds the
archetype, the seed and the parameters. `mint.py` can rebuild any of them
from that recipe alone, byte for byte, on any machine with Blender. The GLB
and the preview PNG are what that recipe currently looks like, not what it is.

This mirrors the game's own invariant 1 — _"Derived = f(facts, generator
versions). Bundles are content-addressed and regenerable. Only facts and
captures are irreplaceable"_ — and invariant 2, determinism, which the repo
already tests with output hashes.

The corollary matters more than the rule: **a render you have not looked at
is not a fact, and an asset nobody has touched is not a library.** In October
2026 a standing GPU job minted 16,600 generic variants over three days —
about 23 GB of near-identical trees, docks and boats. Their recipes remain in
the live registry and can be regenerated on demand; their renders were
destroyed. Only the assets that carry distinct design decisions survived:
the sitka houses and the hand-built freeform pieces.

## Why the sitka houses are the ones worth keeping

`sitka_house` is the only archetype with a wide enough parameter space to
produce genuinely different buildings rather than interpolations of one
silhouette:

- **five roof topologies** — `gable`, `cross_gable`, `hip`, `flat`, `shed`.
  A cross-gable grows a perpendicular wing with its own roof and gable end, so
  the footprint changes shape rather than scale.
- **seven real texture maps** — white siding, cedar shingle, pale-blue
  clapboard, red-brown siding, galvanised roof, asphalt shingles, green
  metal. Each stock has its own UV scale, so the boards read at the right
  width.
- **discrete seed choices** — palette, porch, chimney, stories and ridge
  direction are categorical, not continuous jitter, so the seed space is
  combinatorial.
- **hand-authored overrides** — seeds 101–114 carry explicit `foot_w`,
  `foot_d`, `door_off`, `eaves_h` and `body_colour` values that no seed
  derivation produces. Those are design decisions.

They are also the right building for the place: board-and-batten and cedar
shingle under galvanised metal, deep eaves for the rain, on a raised wood
foundation. Southeast Alaska construction, for a town in Southeast Alaska.

The generic archetypes are one silhouette each — a gabled prism, a cone stack,
a plank deck — so their seed jitter only moves a number inside a fixed shape.

## Layout

```
archetypes.py     parametric bpy builders, one per archetype
engine.py         the Blender entry point: build, export GLB, render preview
mint.py           the CLI: mint / family / refine / touch / cull / regen
registry.py       the asset registry (SQLite): recipes and their renders
fetch_dem.py      fetch the real Sitka DEM and cut a heightmap
demo_run.py       a scripted demo pass

textures/         the texture maps the archetypes sample
data/             the derived Sitka heightmap and its provenance
recipes/          the recipes — archetype, seed, params — for the kept assets
renders/          the GLB + preview PNG each kept recipe currently produces
builds/           freeform build versions; a freeform asset's recipe is its code
builder/          the build runner that turns a written prompt into a build
MANIFEST.sha256   sha256 of every file here
```

## Reproducing an asset byte for byte

Blender is required. `mint.py` looks for `./blender/blender` first and falls
back to `/usr/bin/blender`.

```bash
cd foundry
PARAMS=$(python3 -c "import json;print(json.dumps([r for r in json.load(open('recipes/sitka-house.json')) if r['seed']==110][0]['params']))")
python3 mint.py mint --archetype sitka_house --seed 110 --params "$PARAMS"
sha256sum out/sitka_house/seed-110/asset.glb
```

That hash matches the carried render exactly, and it matches the original
minted on the Thor. Two seeds were checked against the live originals after
this code was relocated into the repo: `seed-110` and `seed-103`, both
byte-identical.

Note that **the seed alone is not enough.** The hand-authored houses carry
explicit parameter overrides, so the recipe is the source of truth and the
seed is only one field of it.

## The Sitka DEM

`data/sitka_height.png` is the derived heightmap for the Sitka harbour area.
The raw SRTM tile is not carried — it is public data and re-fetchable:

```bash
python3 fetch_dem.py   # pulls N57W136 from AWS terrain tiles, cuts the heightmap
```

The same tile already fed the game's satellite frame; see the provenance
recorded in `data/meta.json`.

## What is deliberately not here

- **The generic L0 recipes** (16,372 of them) stay in the live registry on the
  Thor. They are regenerable slop and carry no design information.
- **`registry.db` itself.** The recipes that matter are exported as JSON here,
  in a form `mint.py` consumes directly.
- **The `.blend` working files.** They are the editor state of a render, not
  the asset.
- **The portal and the edge worker.** Those are separate deployments; only the
  generator they call is carried here.

## Provenance

Generated on the Thor (NVIDIA Jetson AGX Thor) with headless Blender, Cycles
on the GPU through a patched `sm_110` CUDA kernel. The sitka houses were
authored from `~/sitka-distill/pipeline/HOUSE-FAMILY.md`. Local frame:
X = street-facing width, Y = depth, front faces -Y, z up.
