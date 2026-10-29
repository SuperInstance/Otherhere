---
status: accepted
---

# A generated tier is framed into its capture: the mesh is authored where it will stand

**Accepted by the project owner on 2026-10-29.**

## Context

[ADR-0023](0023-the-client-gains-a-model-tier.md) gave the client a fourth tier, `model`, and
the Thor could fill it: SPAR3D turns one photograph into a UV'd, PBR-textured mesh, the
finishing lane takes it under the 192,000 B budget, and the browser's own decoder reads it
back.

What it could not do was stand anywhere. The place file carries **one** placement for every
tier of a capture — the same `position`, `quaternion` and `scale` for the gaussian splat and
for the mesh — so a generated mesh has no say in where it lands. It arrives in its
generator's own frame, the shared transform is applied on top, and the result is a mesh
somewhere in the world that has nothing to do with the building it is meant to be.

Two facts made that unavoidable and not merely awkward:

- The capture's placement point is **not** the building. For St Michael's Cathedral it sits
  **1.153 m east and 15.894 m south** of the building's footprint ring.
- The capture's own frame is **y-down**. Its geometry had to be read before anything could be
  placed against it; the splat's 48.765-unit extent along its own `y` is 14.592 m of
  building, because its `y` points at the ground.

So the mesh and the splat, under one transform, would have been at different places and
different sizes: the mesh is 0.992 units tall where the building is 4.864.

## The decision

**A generated tier is framed into its capture's frame before it is published.** The mesh is
transformed on the Thor, once, so that the capture's own placement — the one the place file
already carries — lands it exactly where the building already is.

The transform is the shared placement, undone, followed by the target:

```
M = (1/s) · R' · Translate(-p) · T
```

where `T` is the target: the mesh's base centre at the building's footprint centre, standing
on the ground, the capture's height tall, and its front facing the capture's front bearing.

Three measurements decide `T`, and none of them is a guess:

- **Where the building is.** The footprint ring, projected into the Cell's local frame the
  same way the Bundle builder projects it — `localFrame`, the same rounding to 2 dp, the
  same de-duplication — and averaged. That projection is the game's own model of the asset:
  it is where the photographs stand and where the pick proxy stands.
- **How tall the building is.** The capture's own `heightM`, which the client already uses
  for the proxy box.
- **Which way it faces.** The capture's own `frontAzimuthDeg` — "the direction from the asset
  toward the camera position the card/impostor tiers were baked from".

### The mesh's own frame is not the capture's frame

The generated mesh arrives y-up and centred; the capture's frame is y-down and its origin is
16 m away. The two are reconciled by the same matrix, which is why the scale is 14.707 and
not 1: the mesh is scaled into the capture's units (4.864 units tall), and the capture's own
scale of 3.0 takes it to 14.592 m in the world.

**In code:** `~/sitka-distill/pipeline/frame-model` computes it and bakes it through
`lib/frame_blender.py`; the check it prints is the game itself:

```
baseCentreWorld   [-1.153, 0, -15.894]      the target offset, exactly
heightM           14.592                    the capture's heightM, exactly
frontAzimuthDeg   190.7                     the capture's front bearing
```

## The proof that it landed on the right building

A matrix can be right and the result still wrong, so the two were rendered by **one
renderer** from **one bearing** — the capture's own front, 190.7° — under the capture's own
placement, and compared as silhouettes.

The splat's church and the generated mesh, from that bearing, share a silhouette: the same
mass in the same columns, the same spire above it, at the same scale. That is the only
evidence that matters here, and it is evidence rather than argument.

## What this costs

- **The reconstruction is of a facade, not of a building.** SPAR3D saw one side. Framed to
  the capture's height, the mesh is 11.3 m wide where the cathedral is about 20 m. It reads
  as a smaller building at the distance it is shown at.
- **The mesh is now bound to its capture's frame.** Regenerating it means re-framing it, and
  re-framing it means re-measuring the capture. That is the price of one placement for
  several tiers, and it is paid on the Thor, where the capture lives.
- **The frame-model tool reads the repo.** It uses the repo's own `localFrame` and h3 cell
  centres, so a change to the projection is a change to the framing. That is deliberate: two
  implementations of "the Cell's local frame" would drift.

## What would change this decision

- **Per-tier placement.** If the Bundle carried a placement per tier, a generated mesh
  could simply state where it stands, and this whole layer would disappear. The cost is a
  bigger Bundle and a second thing to get wrong.
- **A capture whose placement is its building.** If the placement point were the building's
  centre, the offset would be zero and the framing would reduce to a scale and a yaw.
- **A mesh that is not of the capture's subject.** The framing assumes the generated mesh is
  a reconstruction of the same building the capture recorded. A mesh of anything else would
  be faithfully and wrongly placed.
