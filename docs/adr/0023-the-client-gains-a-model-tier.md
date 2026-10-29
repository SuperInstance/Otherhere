---
status: accepted
---

# The client gains a `model` tier: a real mesh is a thing the game can load

**Accepted by the project owner on 2026-10-29.**

## Context

[ADR-0021](0021-thor-hosts-the-world.md) put the Thor in charge of hosting models and
generating assets and the ProArt in charge of rendering them.
[ADR-0022](0022-the-geometry-service-is-moge.md) settled the geometry service.

Both left one question open, and it turned out to be the question the whole asset lane was
waiting on: **what does the game actually load?**

The answer was: a gaussian splat (`.spz`), a view atlas, or a photograph. Three tiers, and
none of them is a mesh.

That was fine while the only thing that produced assets was the capture pipeline, because the
capture pipeline's output _is_ a gaussian field. It stopped being fine the moment the Thor
started generating geometry, and by then three separate generators had each produced the
same kind of file:

| generator                                       | output                                   | on the Thor          |
| ----------------------------------------------- | ---------------------------------------- | -------------------- |
| Hunyuan3D-2.1                                   | `painted.glb`, 5,351,844 B, 40,000 faces | 147.9 s              |
| SPAR3D                                          | `mesh.glb`, UV'd, PBR-textured           | 31.9 s, 10.6 GB peak |
| the relief pipeline (this ADR's own by-product) | `model.glb`, 168,980 B                   | 3.3 s                |

Every one of them a GLB with the geometry compressed with `EXT_meshopt_compression` — because
that is what the browser can decode quickly, and because the repo already depends on
meshoptimizer. **And not one of them could be opened by the client.** The asset lane did not
end at a file nobody could open; it ended at a file nobody had tried to open.

## The measurement that had to come first

A tier the client cannot read is not a tier. Before adding a vocabulary, the round trip had to
be proven **with the decoder the client itself loads** — not with a library that happens to be
installed, and not with the exporter that wrote the file.

`~/d1-lab/verify_meshopt_glb.mjs` decodes a finished GLB the way the browser will and checks
what came out. The finished asset from the Hunyuan cathedral (10,000 triangles, 512 px WebP,
176,640 B):

```
meshopt views   4 decoded
vertices        11,634
world bounds    x[-0.9778, 0.9607] y[-0.9563, 0.9255] z[-0.9988, 0.9900]
  ok    positions are finite and non-degenerate
normals         11,634/11,634 unit length
uv              u[0.000, 0.062] 0 outside [0,1]
triangles       10,000
  ok    no index points past the last vertex  11633 < 11634
  ok    texture painted is a WebP  512x512 (VP8)
bounds drift    0.00002 (tolerance 0.03978)   <- against the uncompressed original
VERDICT: PASS — the client's own decoder reads this file
```

Three things had to be right, and each was wrong the first time:

- **The decoder.** `meshoptimizer` is in the store only because `@types/three` depends on it
  for types — it is a phantom, and reaching for it would have been reaching for nothing. The
  client loads **three's own bundled decoder** (`three/addons/libs/meshopt_decoder.module.js`),
  and so does the verifier now.
- **Where the compressed bytes live.** Not at the bufferView's `byteOffset` — that points at
  the _fallback_ copy — but at the extension's own `byteOffset` into the buffer it names. And
  the stride field is `byteStride`, not `stride`. And the modes are strings
  (`"ATTRIBUTES"`, `"TRIANGLES"`), not the numbers the old extension used.
- **The geometry is interleaved.** The octahedral normals sit on a four-byte stride, and
  reading them tightly packed gave 7,010 of 11,634 normals off unit length. Honesty about a
  failing number is what found it.

## The decision

**The client gains a fourth tier, `model`: a real triangle mesh.**

- **The tier is a GLB, loaded with `GLTFLoader` and three's own meshopt decoder.** The bytes
  are hash-verified first — an unverified payload is never parsed, whatever it claims to be.
- **The placement goes on a wrapper, not on the loaded scene.** A generated mesh carries its
  own frame (the transform that puts it where its generator put it); overwriting that would
  move the geometry out from under its own texture.
- **The ladder is: splat near, model next, photographs beyond.** A mesh is not a photograph —
  it is geometry with real silhouettes — so it outranks the impostor wherever it exists, and
  it is cheap enough to be worth the draw: the finished assets are **48–169 KB**.
- **The lite profile never fetches a mesh.** The lite profile is a photograph tier, and it
  stays one.
- **The pipeline's vocabulary does not move.** The capture pipeline calls its gaussian field
  `mesh` and the client calls that tier `splat`; the registry translates, once, as it always
  has. The new tier is called `model` in both vocabularies, so no capture has to be migrated
  and no receipt has to be rewritten.

The other half of the door is on the Thor: `publish-model` writes the finished GLB into a
capture directory the registry already understands — a sidecar naming the tier with its hash,
the payload, and a receipt — and the registry checks the payload against the receipt before it
will serve it.

### Proven end to end, from the ProArt

The renderer is the ProArt, so the proof runs there: fetch the registry from the Thor, fetch
the model tier, check its byte count and sha256, and decode it **on the renderer's machine
with the client's own decoder**.

```
registry from the Thor: 3673 B in 26 ms
model tiers: 1
  assets/st-michaels-spar3d/1.0.0/model.glb  168980 B  33.4 ms  bytes=ok hash=ok  ct=model/gltf-binary
    decode: PASS  vertices  11,135  triangles  9,999

1/1 model tiers verified AND decoded on the ProArt
```

That tier is not a fixture. It is a cathedral: **one photograph, SPAR3D, 31.9 s on the Thor,
10.6 GB of VRAM at the peak**, reconstructed into a UV'd, PBR-textured mesh, finished to
10,000 triangles and a 512 px WebP at **168,980 B — under the repo's 192,000 B full-profile
budget** — and served to the renderer.

### The second door: one photograph becomes a place

The same night produced a second capability, and it is the one that changes what the corpus
can be.

The capture pipeline needs a COLMAP session, a walk around the place and an hour of compute.
That is why the corpus has eleven places rather than eleven hundred. The geometry service
already answers "what is here?" in 72 ms; what it could not answer was "make that into
something the game can load".

**The relief pipeline** answers it. A depth map plus intrinsics is enough to rebuild the
place as a relief mesh — the scene as the camera saw it — with the photograph itself as the
texture, painted on exactly, because every vertex's UV is the pixel it was unprojected from:

| stage     | what it does                                                    | cost                                |
| --------- | --------------------------------------------------------------- | ----------------------------------- |
| geometry  | MoGe via the service on :8099                                   | 126 ms inference, 190 ms round trip |
| relief    | depth unprojected into a grid mesh, photograph painted on by UV | 1.6 s                               |
| finish    | decimate, resize, meshopt, under budget                         | 1.5 s                               |
| **total** |                                                                 | **3.3 s**                           |

Measured against the photograph it came from, rendered **from the photograph's own camera**:

| asset                             | PSNR (sRGB) | pixels badly wrong | bytes   |
| --------------------------------- | ----------- | ------------------ | ------- |
| relief, 100×60 grid, 10,000 tris  | 22.05 dB    | 3.15 %             | 50,684  |
| relief, 200×120 grid, 40,000 tris | 24.60 dB    | 1.74 %             | 162,124 |

The residual is the geometry, not the texture: the same asset with the full-resolution
photograph scores 22.13 dB, so the 4× texture downscale costs nothing and the 2.5D chord
approximation costs the rest. **This is a backdrop, not a reconstruction** — it builds the
view the photograph shows and knows nothing about what is behind the camera.

## What would change this decision

- **A real reconstruction.** The relief is a 2.5D approximation; a place you can walk _into_
  still needs a capture. If the renderer ever needs to go behind the camera, the relief is the
  wrong shape and the capture pipeline is still the right one.
- **SPAR3D on scene photographs.** SPAR3D reconstructs a single object. Given a street
  photograph it returned a shell of the dominant foreground structure — recognisable, and
  useless as a place. It is the right tool for an object and the wrong tool for a street.
- **A meshopt round trip that the verifier cannot see.** The verifier reads the finished GLB
  with three's decoder, which is what the browser loads, but the _rendered_ result in the
  browser has not been checked with the mesh in a real scene yet. The ProArt proof decodes the
  bytes; it does not draw them.
- **The relief's scale.** MoGe's depth is metric up to the model's own scale convention. The
  relief inherits that, so a place's relief and a place's capture may not agree on how big the
  world is.
