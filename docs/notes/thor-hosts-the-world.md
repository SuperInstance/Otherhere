# Thor hosts the world; the ProArt renders it

Evidence for [ADR-0021](../adr/0021-thor-hosts-the-world.md). Every number here was measured
on the Thor (Jetson AGX Thor, 128 GB unified, CUDA 13.2, sm_110, ARM64) or on the ProArt
(WSL2, RTX 4050 6 GB) on **2026-10-28/29**.

---

## The link, measured for the first time

The corpus recorded ProArt→Thor at 5.2 ms and flagged throughput as unmeasured. Method: a
64 MiB payload served from the Thor by `python3 -m http.server` on port 8099, fetched from the
ProArt with `curl -w`.

| measure                  | value                                  | runs |
| ------------------------ | -------------------------------------- | ---- |
| TCP connect              | **5.3 – 8.8 ms** (median ≈ 6 ms)       | 8    |
| time to first byte, 4 KB | **11.3 – 18.7 ms**                     | 5    |
| total, 4 KB              | 12.5 – 29.0 ms                         | 5    |
| total, 1 MB              | 0.117 – 0.167 s                        | 3    |
| total, 64 MB             | 5.83 – 7.19 s                          | 3    |
| throughput, 64 MB        | **9.3 – 11.5 MB/s** (≈ 75 – 92 Mbit/s) | 3    |

**A first attempt at this measurement was wrong and nearly fooled itself.** The probe piped
the payload through `sha256sum` _on the peer_, so the bytes never crossed the wire and the
"throughput" was the cost of an ssh startup. The numbers above come from a second probe that
moves the bytes. Worth writing down because the failure mode — a number that looks plausible
and measures the wrong thing — is the same one that nearly made SF3D look built (§"The
SF3D experiment").

### What it rules in, and what it rules out

**In:** asset delivery. At the slow end of the measured range (9.3 MB/s):

| payload                | fetch cost |
| ---------------------- | ---------- |
| a 192 KiB splat tier   | 0.02 s     |
| a 5.35 MB painted mesh | 0.58 s     |
| a 24 MB dense master   | 2.6 s      |

**Out:** streaming rendered frames. A 1440p frame is ~1–3 MB; 60 fps is 60–180 MB/s against a
measured 9.3 MB/s — **6–19× over budget**. Even 10 fps is over. The Thor must not render
frames for a real-time view.

**Caveats, stated rather than hidden.** One direction only was measured. The ProArt is WSL2
behind a Windows NAT host, so this is the usable figure, not a radio-level one. ICMP is
firewalled between the boxes, so there is no independent RTT to cross-check the connect time
against. The numbers are from an idle period and were not re-measured under load.

**The Thor's Ethernet ports are down.** The link is Wi-Fi end to end. A cable on the server
side removes the wireless hop from the server side of every fetch and every model call. That
is the cheapest available win and it needs no code.

---

## What the Thor already had — and what was merely downloaded

The shelf is 102 GB. The question is not the shelf; it is the shelf minus the things that are
only _downloaded_.

| capability                                | where                      | measured                                                | served?                            |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------- | ---------------------------------- |
| decision tier (4 models)                  | `:8093`–`:8096`            | 98.4 % text / 189 ms (`d1-2B`)                          | ✅ now also `:8097`, OpenAI-shaped |
| coder (`Qwen3-Coder-30B`)                 | `:8001`                    | 82 tok/s warm                                           | ✅                                 |
| JEV rack (I-JEPA, V-JEPA2)                | `:8077`                    | 162 ms / 7.8 s                                          | ✅                                 |
| ComfyUI + image-studio                    | `:8188`, `:8190`           | live                                                    | ✅                                 |
| Foundry (procedural)                      | `:8200`                    | live                                                    | ✅                                 |
| **Hunyuan3D-2.1 → PBR mesh**              | `~/sitka-distill/gen3d`    | **147.9 s**, 40,000 faces, 5.35 MB                      | ❌ **batch, by hand**              |
| **VGGT-1B reconstruction**                | `~/sitka-distill/lab`      | **1314 s** / 230 frames, one global frame, 45.4 GB peak | ❌ **batch, by hand**              |
| **`asset-capture` splat pipeline**        | `~/sitka-distill/pipeline` | **11 min 27 s**, 0 interventions, LOD ladder            | ❌ **batch, by hand**              |
| TRELLIS, TripoSR/SG, SPAR3D, SF3D weights | `~/models/` (≈ 60 GB)      | see below                                               | ❌ **downloaded, unserved**        |

Grepping the foundry portal and the image-studio portal for
`TRELLIS|Hunyuan3D|TripoSR|TripoSG|stable-fast-3d|stable-point-aware-3d` returns **nothing**
outside a vendored stub. Five image-to-3D models, ~60 GB, no door.

---

## The decisive experiment: SF3D's CUDA extensions

The image-to-3D research closed by naming its own decisive test: SF3D is the best on-disk
candidate, but the whole ranking depends on whether `texture_baker` and `uv_unwrapper` compile
against CUDA 13.2 on sm_110.

**Round 1 failed, and failed in a way that could easily have been reported as a success.**
pip's build isolation could not see the venv's torch, so both extensions died with
`No module named 'torch'` at the "getting requirements" step. The import check then printed
`IMPORT_OK` — because Python had picked the **source directory off the CWD**, not a compiled
extension. Checked from a neutral directory, both imports failed: **round 1 built nothing.**

**Round 2** — `--no-build-isolation`, `TORCH_CUDA_ARCH_LIST=11.0`, `CUDA_HOME=/usr/local/cuda`:

```
torch in venv: 2.14.1+cu130 (11, 0)
uv_unwrapper:  IMPORT_OK  file=.../site-packages/uv_unwrapper/__init__.py
texture_baker: IMPORT_OK  file=.../site-packages/texture_baker/__init__.py
```

**The CUDA gate passes on sm_110.**

But the _mesh post-processing_ stage does not: `sf3d/models/mesh.py` imports `gpytoolbox`
(**needs MATLAB — not on this Thor**) and `pynanoinstantmeshes` (**its sdist is missing
`native/ext/tbb/`**, and the upstream GitHub URL is not fetchable). So SF3D's model and
extensions are viable here; its decimate/remesh/subdivide path is not, without MATLAB.

**And that is the right outcome, not a loss.** Hunyuan3D-2.1 already does this job on this
box, producing 40,000-face PBR meshes in 147.9 s. The conclusion is **do not chase SF3D**,
not "build SF3D".

---

## The research, and where it disagreed with this machine

Three parallel sweeps were run — world models, image-to-3D, renderer-side hosting. Full
reports are on the Thor at `~/d1-lab/research/`. The load-bearing part is where they were
wrong, because they read upstream pins instead of the local machine:

| the sweep said                                                                    | local truth                                                                     | why                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| "Hunyuan3D-2/2.1 is a trap — the `torch 2.5.1+cu124` pin cannot target sm_110"    | **Hunyuan3D-2.1 runs here.** 18/18 generated, 0 failures, 147.9 s to a PBR mesh | it read the upstream README pin, not the working venv |
| "SF3D is #1, but the ranking depends on whether the extensions compile on sm_110" | **they compile**                                                                | right question, wrong assumed answer                  |
| "the renderer wants geometry, not pixels; MoGe-2 / VGGT is the top pick"          | **we already run VGGT-1B** (1314 s / 230 frames)                                | it did not know the weights were on disk              |
| "no world model has published Jetson-Thor numbers except Cosmos3-Edge (1.37 fps)" | true                                                                            | no disagreement                                       |

### World models — the honest headline

**No released world model fits a renderer on this hardware.** The JEPA family produces
latents for _planning_, not presentation — a 1024-d vector per patch is something a WebGL
renderer cannot draw with — and the size is wrong: V-JEPA 2-AC's bundle is **11.76 GB**
(measured Content-Length), while our own V-JEPA2 ViT-L call already takes **7.8 s**.
**JEPA-TTT** — the test-time-training paper that looked like the answer to the
attested-updating problem — has **no released code and no checkpoints** (searched, found
nothing), and its output is a _policy_, not a presentation.

What survives, ranked:

1. **Geometry, not pixels — VGGT / MoGe-2.** A depth/point map the renderer consumes
   directly, for parallax and occlusion. MoGe-2 is MIT, 1.31 GB, single-image
   ([MoGe](https://github.com/microsoft/MoGe), [HF](https://huggingface.co/Ruicheng/moge-2-vitl)).
   **Licence warning:** VGGT's _original_ checkpoint is non-commercial and its HF metadata
   says `mit` — a conflict to resolve with Meta before it ships.
2. **Motion — ARDY** (NVIDIA, 192 M, 0.77 GB, 33 ms on a 4090; [paper](https://arxiv.org/abs/2607.08741),
   [repo](https://github.com/nv-tlabs/ardy)). The only _interactive_ generative model in the
   survey that fits comfortably; a 30-joint SOMA variant is the game-oriented one. Its hidden
   cost is a Mistral-class text encoder (~14 GB), amortised per _prompt_, not per frame.
3. **A bespoke latent world model** trained on our own frames+actions, LeWorldModel-style
   (MIT, ~15 M params, 72 MB checkpoints; [repo](https://github.com/lucas-maes/le-wm)). The
   cheapest path to a genuinely game-specific "what happens next" — and it turns proprietary
   game footage into an asset rather than a blocker.
4. **Cosmos3-Edge** — the _only_ world model with published Jetson-Thor numbers
   (137.50 s for 189 frames at 480p, vLLM-Omni; its Reasoner runs at 37–43 tok/s on the same
   Thor; [model card](https://huggingface.co/nvidia/Cosmos3-Edge)). Good for a slow, queued
   "show me what happens if I turn left". Not on the interaction path.

### Image-to-3D — the shelf is stale in quality, not in the dimension that matters

A 27.4 K-triangle UV'd textured GLB under 1 MB is exactly what a 6 GB WebGL client wants
([SF3D paper](https://arxiv.org/pdf/2408.00653)). The 2026 frontier (PBR, 1M-tri targets,
game-ready quad meshes) is better but costs ~4× the VRAM and, on this hardware, ~4× the
dependency pain.

**Two licence facts that must be resolved before anything ships:**
**Depth-Anything-V2-Large is CC-BY-NC-4.0** (the _Small_ checkpoint is Apache-2.0 — switch),
and **Hunyuan's licence excludes the EU, UK and South Korea**. DINOv2 is Apache-2.0, which is
good news — four of the seven models depend on it.

### Renderer-side hosting — the biggest win is cheap, and the biggest trap is arithmetic

The biggest win is CPU-only: **bake the lighting on the Thor** (AO + lightmaps + one IBL
probe) and ship the bake, so the 4050 does not compute it; plus **gltfpack / meshopt / KTX2 /
LOD** on every asset, which is what makes every other capability affordable on a 6 GB card.
The biggest trap is "let the Thor render and the ProArt display" — killed on bandwidth above.

---

## What was built

`packages/assets` — the producer side of the contract the client already speaks.

- `src/registry.ts` — reads a capture directory (`asset.capture.json` + `tiers/` +
  `*.receipt.json`), verifies every payload against its receipt, and produces the manifest.
  A payload that does not match is **withheld and reported**, not served.
- `src/places.ts` — reads the **place files** and the `assets/` tree beside them, and accepts
  the place file's own record (tier, sha256, byte count) as a second kind of voucher. A
  capture that was baked into a place has no pipeline sidecar and no receipt, but the place
  file names every tier and its hash — just as content-addressed. **The rule is unchanged:
  never serve an unverified payload.** Only the source of the record differs.
- `src/server.ts` — serves `GET /places/registry.json` and
  `GET /places/assets/<family>/<version>/<file>`, with the sha256 in a response header so a
  mismatch is diagnosable from the wire, and the record that vouched for it in
  `x-content-source`. The registry is re-read every 60 s, so a capture that lands becomes
  fetchable without a restart.
- `test/registry.test.ts`, `test/places.test.ts` — 17 tests over the tier-name translation, the
  hash enforcement, the refusal path, the place-file record, and an HTTP round trip.

### The client may fetch payloads from another host

`apps/client/src/assets.ts` takes an optional `assetBase`: where the tier payloads are
fetched from, defaulting to the directory the place files are served from. The place file
stays where the game server put it; the payloads come from the Thor.

**`BASE_URL` could not be used for this, and the reason is worth recording.** In Vite,
`import.meta.env.BASE_URL` is the reserved **base path** — the prefix the app's own JS, CSS
and asset URLs are built with. Pointing it at a remote host would rewrite the game's own
script tags to a server that does not serve them, and the page would not load at all. A
second origin needs its own variable: `VITE_ASSET_BASE`, naming the host's root.

### Proven end to end, from the ProArt

All nine tiers of the three real captures, fetched from the ProArt over the LAN and verified
the way the client verifies them:

```
sitka-dock-boat/card            826 B    19.2 ms  bytes=True hash=True
sitka-dock-boat/impostor      2,206 B    12.5 ms  bytes=True hash=True
sitka-dock-boat/splat       173,246 B    48.8 ms  bytes=True hash=True
sitka-oconnell-bridge/card    1,498 B    19.3 ms  bytes=True hash=True
sitka-oconnell-bridge/impostor 3,126 B  16.3 ms  bytes=True hash=True
sitka-oconnell-bridge/splat 166,837 B    51.7 ms  bytes=True hash=True
smoke-dock/card                2,682 B    30.6 ms  bytes=True hash=True
smoke-dock/impostor            5,714 B    29.9 ms  bytes=True hash=True
smoke-dock/splat             168,831 B    52.9 ms  bytes=True hash=True
```

**A splat tier arrives in ~50 ms.** That is the fetch-on-notice budget met.

### And then the door had no house

The service was serving nine tiers. **The client was using none of them.** Two reasons, both
found by reading the actual code rather than the design:

1. The client fetches its payloads from `${BASE_URL}places/<path>` — and `BASE_URL` is Vite's
   base path, which cannot name another host (above).
2. The place file the running ProArt game served named **zero** asset tiers. Its checkout sits
   on `local-sitka-night` at `cf76c7f`, from before the asset layer existed: no
   `apps/client/src/assets.ts`, no `assets/` directory beside the place file.

And the capture the place file _did_ name — `st-michaels-cathedral`, three tiers — was not
among the three captures the service served, because a capture baked into a place has no
pipeline sidecar and no receipt. It had a place file and nothing else.

So the service grew a second kind of voucher (the place file's own record), and the client
grew a second origin (`VITE_ASSET_BASE`). The service now serves **twelve** verified tiers:
nine from the capture registry, three vouched for by `sitka.json`:

```
$ curl -sI http://127.0.0.1:8098/places/assets/st-michaels-cathedral/1.0.0/splat.spz
content-type: model/gaussian-splat
content-length: 193512
x-content-sha256: e1cfb70d0972b178e694ae06d427f081c2d51e2e7c5480f4edaca894a0364c62
x-content-source: place sitka.json
```

---

## The geometry question, measured

[ADR-0022](../adr/0022-the-geometry-service-is-moge.md) records the decision; the numbers are
here. Measured on the Thor, 2026-10-29, at 518 × 924, bf16, weights resident.

**VGGT-1B** (`~/d1-lab/bench_vggt_steady.py`, six repeats, median of the last three):

| repeat                       | forward      |
| ---------------------------- | ------------ |
| 1 (first in a fresh process) | 1516.4 ms    |
| 2                            | 882.2 ms     |
| 3                            | 900.3 ms     |
| 4                            | 901.9 ms     |
| 5                            | 881.0 ms     |
| 6                            | 865.0 ms     |
| **steady-state median**      | **881.0 ms** |

**MoGe ViT-Large, MIT** (`~/d1-lab/bench_moge_service.py`):

| setting                   | warm        | peak GPU |
| ------------------------- | ----------- | -------- |
| `num_tokens=1200`         | **72.2 ms** | 1.43 GB  |
| resolution level 6        | 130.1 ms    | 1.60 GB  |
| resolution level 8        | 144.1 ms    | 1.66 GB  |
| `num_tokens=2500`         | 148.1 ms    | 1.68 GB  |
| resolution level 9 (full) | 150.2 ms    | 1.69 GB  |

### The measurement nearly lied, twice

The first VGGT benchmark reported **218.9 s** for one image and **190.6 s** for the second, and
an ADR was written on that number before it was checked. It was almost entirely **CUDA kernel
compilation**: the torch wheel carries no `sm_110` SASS for these kernels, so they are
JIT-compiled from PTX on first use, and a new tensor shape recompiles. The tell was that the
curve was not monotone — four frames came in at 82.5 s and sixteen at 44.4 s, _faster_ than one.

The same lab notebook had already recorded the mirror image of this mistake for memory
("flat-memory extrapolation from 8/32-frame probes under-estimated the 230-frame activation
cost"). The rule is the same in both directions: **measure at the target, repeat the
measurement, and believe the tail, not the head.**

### What the frame counts hid

- **Weight load: 1201.7 s** for the 5.03 GB checkpoint by the ordinary `torch.load` path. mmap
  cuts it to 99.1 s. A service that reloads on every restart is a service that is cold for
  twenty minutes.
- **The payload is the constraint, not the compute.** One 518 × 924 point map is 478,632 points
  — **5.74 MB as fp32, 2.87 MB as fp16** — and the depth map is another 1.91 MB as fp32. At the
  measured 9.3 MB/s that is **0.31–0.62 s of link** per frame, on top of the compute. A service
  that answers in 72 ms and then spends 300 ms moving the answer has an answer that takes
  **0.4 s**, not 72 ms. The service sends depth and intrinsics, not a point map.

### The conclusion, and the correction

**A geometry service is viable, and it is MoGe — not VGGT.** 72 ms per query, MIT licence,
1.26 GB of weights, 1.4 GB of VRAM. VGGT keeps the batch lane: many images into one global
frame is what a per-cell capture wants, and 230 frames in one coordinate system where COLMAP
produced three fragments is a real strength.

The first draft of this section said the opposite ("geometry is computed ahead of the walk, the
Thor is not asked for geometry on demand") on the strength of the 190.6 s figure. That number
was wrong, the ADR built on it was wrong, and both were corrected rather than quietly amended:
the superseded ADR was deleted in the same commit that replaced it.

---

## The finishing lane: a generated mesh in, a game-ready mesh out

Every generator on the Thor ends at the same problem. A Hunyuan mesh is 5,351,844 B; the
repo's law for a full-profile tier is 192,000 B; the ProArt renders it on a 6 GB card over a
9.3–11.5 MB/s link. The bytes have to come down, and the Thor is the only place with the CPU
to take them down.

The lane is **Blender (decimate + resize + WebP export) → gltfpack `-cc`
(`EXT_meshopt_compression`)**, measured on the Hunyuan cathedral (40,000 faces, 5,351,844 B):

| triangles  | texture    | bytes       | reduction                              |
| ---------- | ---------- | ----------- | -------------------------------------- |
| 40,000     | 1024 px    | 428,948     | 12.5×                                  |
| 20,000     | 1024 px    | 329,912     | 16.2×                                  |
| 10,000     | 1024 px    | 266,660     | 20.1×                                  |
| 20,000     | 512 px     | 239,892     | 22.3×                                  |
| **10,000** | **512 px** | **176,640** | **30.3× — under the 192,000 B budget** |
| 5,000      | 512 px     | 125,032     | 42.8×                                  |

~1.2–3.9 s per size. Three traps are worth naming, because each cost real time:

- **gltfpack has no aarch64 release.** It was built from source here
  (`~/thor-bench/gen3d-src/meshoptimizer`, cmake `-DMESHOPT_BUILD_GLTFPACK=ON`).
- **Draco is a trap, not an option.** Blender 4.0 ships the Draco _importer_ but not the
  exporter, so `export_draco_mesh_compression_enable` is silently ignored and the file comes
  out the same size with the flag on. meshopt is also the better choice for a browser anyway —
  it decodes an order of magnitude faster, and the repo already depends on it.
- **Blender cannot read `EXT_meshopt_compression`** (4.0.2), so the finished file cannot be
  re-imported to check it. It is checked with the **repo's own decoder** instead
  (`~/d1-lab/verify_meshopt_glb.mjs`), which is what the client loads. A byte count is not a
  verification.

## Image-to-3D: SPAR3D works here, for objects

The research sweep said SPAR3D would be gated on `gpytoolbox` (MATLAB) the way SF3D is. It is
not: SPAR3D guards those imports and degrades gracefully, and its two hard dependencies
(`uv_unwrapper`, `texture_baker`) both compiled and imported on `sm_110`. The weights were
already on the shelf (`~/models/stable-point-aware-3d`, 7.33 GB).

Two runs, two different answers, and the difference is the point:

| input                                    | inference | peak VRAM | result                                                                             |
| ---------------------------------------- | --------- | --------- | ---------------------------------------------------------------------------------- |
| a cathedral photograph (`prepped.png`)   | 31.9 s    | 10.6 GB   | **a recognisable 3D cathedral** — dome, spires, textured walls                     |
| a street photograph through a car window | 8.5 s     | 10.3 GB   | a shell of the dominant foreground structure: the A-pillar and door frame, smeared |

SPAR3D is an **object** reconstructor. Given a subject it produces a UV'd, PBR-textured mesh
(base colour + normal map, metallic/roughness) — unlike TripoSG, which has no UV or texture
at all and would have been useless as an asset. The finished cathedral is **168,980 B at
10,000 triangles**, under the full-profile budget, and the render after decimation is
indistinguishable from the render before it.

On a street photograph it is not a place tool. The honest reading: **SPAR3D is the right tool
for an object, and the relief pipeline below is the right tool for a street.**

## One photograph becomes a place

The capture pipeline needs a COLMAP session, a walk around the place and an hour of compute.
That is why the corpus has eleven places rather than eleven hundred.

The geometry service already answers "what is here?" in 72 ms. What it could not answer was
"make that into something the game can load". The **relief pipeline** answers it: a depth map
plus intrinsics is enough to rebuild the place as a relief mesh — the scene as the camera saw
it — with the photograph itself as the texture, painted on exactly, because every vertex's UV
is the pixel it was unprojected from.

Measured end to end on the cathedral photograph: **3.3 s** (geometry 190 ms round trip, relief
1.6 s, finish 1.5 s), and the finished asset is **50,684 B at 10,000 triangles**.

Measured against the photograph it came from, rendered **from the photograph's own camera**
(the intrinsics give the focal length; the glTF camera frame puts the camera at the origin
looking down −Z):

| asset                                    | PSNR (sRGB) | pixels off by more than 48 | bytes   |
| ---------------------------------------- | ----------- | -------------------------- | ------- |
| 100×60 grid, 10,000 triangles            | 22.05 dB    | 3.15 %                     | 50,684  |
| 200×120 grid, 40,000 triangles           | 24.60 dB    | 1.74 %                     | 162,124 |
| 100×60 grid, **full-resolution** texture | 22.13 dB    | 3.07 %                     | —       |

The third row is the informative one: **the texture downscale costs nothing** (22.13 vs
22.05 dB) and the residual is the 2.5D geometry — the chord approximation of a surface that
is only known at the grid's samples. Decimation costs nothing either: the 10,000-triangle
asset and the 11,682-triangle one score identically.

**This is a backdrop, not a reconstruction.** It builds the view the photograph shows and
knows nothing about what is behind the camera.

## The honest negatives

- **No released world model fits this job.** One has published Jetson-Thor numbers, and it is
  a 137-second video generator.
- **Pixel generation is the wrong axis** for a renderer that needs geometry. Every
  video-diffusion model surveyed is offline (5–20 min per clip) or needs an SDPA rewrite,
  because `flash-attn` and `xformers` have **no aarch64 wheels**
  ([xformers](https://github.com/facebookresearch/xformers), [flash-attn](https://github.com/Dao-AILab/flash-attention/blob/main/setup.py)).
- **Streaming frames from the Thor is dead on arithmetic**, not on preference.
- **SF3D is blocked at the mesh-maths stage** (MATLAB, and a package with an incomplete
  sdist), even though its CUDA extensions build fine here.
- **The research sweeps were wrong three times** about this machine. Upstream pins are not
  local truth. Every load-bearing claim above is measured on this box, including the one
  experiment that failed the first time.
- **The first geometry benchmark lied too**, by a factor of 216: 190.6 s where the truth was
  0.88 s. The cause was CUDA kernel compilation, invisible unless the curve is read for
  monotonicity. An ADR was written on the wrong number and had to be replaced.
- **SPAR3D is not a place tool.** On a street photograph it produced a shell of the car's
  door frame, not a street. The relief pipeline covers that case instead.
- **The relief is 2.5D.** Exact from the photograph's camera and wrong away from it, by
  construction. Its 22–25 dB is the price of a mesh that knows only what it was shown.
- **The finishing lane squashed non-square textures.** It resized every texture to a square,
  which is invisible on the Hunyuan cathedral (square textures) and turned a 1080×1920
  photograph of a place into a 512×512 texture — a place painted stretched sideways. The
  aspect ratio is now kept. Nothing measured the old lane's _shape_; only its byte count was
  ever checked.
- **The verifier's first two failures were its own, not the file's.** The extension's stride
  field is `byteStride` and its modes are strings; and `Buffer.prototype.slice()` returns a
  _view_, not a copy, so `readFileSync(...).slice().buffer` pointed at the whole file from
  offset 0. Both produced confident, wrong numbers.
- **The mesh has been decoded, not drawn.** The ProArt proof fetches the model tier,
  hash-verifies it and decodes it with the client's own decoder on the renderer's machine. The
  browser drawing that mesh in a real scene is not yet proven.
