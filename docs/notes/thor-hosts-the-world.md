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
- `src/server.ts` — serves `GET /places/registry.json` and
  `GET /places/assets/<family>/<version>/<file>`, with the sha256 in a response header so a
  mismatch is diagnosable from the wire. The registry is re-read every 60 s, so a capture
  that lands becomes fetchable without a restart.
- `test/registry.test.ts` — 9 tests over the tier-name translation, the hash enforcement, the
  refusal path, and an HTTP round trip.

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

---

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
