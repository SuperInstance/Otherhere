# The geometry service

The Thor's answer to "what is here?" — a photograph in, a depth map and the
intrinsics that go with it, out.

This is the sibling of the capture service. The capture service hands the
renderer payloads it already holds, by hash. This one is asked a question.

## Why it exists

The renderer builds a town from Bundles and place files. Both are facts about
places that were captured, authored or imagined ahead of time. Nothing in the
system could turn _a photograph_ into geometry on demand.

The overnight research asked whether the Thor could host a geometry model, and
the answer turned on one number: how long does a query take? Everything else
followed from it.

## The measurement that decided it

Measured on this Thor (Jetson AGX Thor, 128 GB unified, CUDA 13.2, sm_110,
ARM64) on 2026-10-29, at 518 × 924, bf16, weights resident.

| model                                 | warm        | licence    | weights | VRAM    |
| ------------------------------------- | ----------- | ---------- | ------- | ------- |
| **MoGe ViT-Large, `num_tokens=1200`** | **72.2 ms** | MIT        | 1.26 GB | 1.43 GB |
| MoGe ViT-Large, resolution level 9    | 150.2 ms    | MIT        | 1.26 GB | 1.69 GB |
| VGGT-1B                               | 881.0 ms    | unresolved | 5.03 GB | 8.0 GB  |

MoGe's licence is settled (`license: mit`, no gating, no terms). VGGT's original
checkpoint is tagged non-commercial while its HuggingFace metadata claims MIT,
so it is not the thing that ships. VGGT keeps the batch lane — many images into
one global frame is what a per-cell capture wants.

Full numbers, and the measurement that nearly lied: `docs/notes/thor-hosts-the-world.md`.

## The wire

```
POST /geometry?num_tokens=1200&mask=1
Content-Type: image/jpeg

<the image bytes>
```

```json
{
  "format": "otherhere.geometry.v1",
  "model": "moge-vitl",
  "numTokens": 1200,
  "width": 574,
  "height": 1022,
  "inferSeconds": 0.1282,
  "intrinsics": [
    [1.3158, 0.0, 0.5],
    [0.0, 0.739, 0.5],
    [0.0, 0.0, 1.0]
  ],
  "intrinsicsNormalised": true,
  "intrinsicsPixels": [
    [755.27, 0.0, 287.0],
    [0.0, 755.27, 511.0],
    [0.0, 0.0, 1.0]
  ],
  "depth": { "encoding": "base64-fp16", "shape": [1022, 574], "bytes": "…" },
  "mask": { "encoding": "base64-uint8", "shape": [1022, 574], "bytes": "…" }
}
```

**The intrinsics travel twice, on purpose.** The model returns them normalised —
the principal point is (0.5, 0.5) and the focal length is in units of the
image's own width — and a consumer that got that wrong would reconstruct a scene
that is subtly, plausibly wrong. So the pixel form is sent alongside it, and the
normalised form is flagged as such.

### Why depth and intrinsics, and not a point map

A point map for one 518 × 924 frame is 478,632 points — **5.74 MB as fp32, 2.87 MB
as fp16**. Over the measured 9.3 MB/s Thor→ProArt link that is 0.31–0.62 s of
transfer, which would dominate the 72 ms of compute.

The depth map is **0.96 MB as fp16**, and the consumer can unproject it exactly:
the intrinsics travel with it, so a recovered point is in the same units as the
depth. The service measures and states the trade rather than hiding it behind a
convenient payload.

### Measured, from the ProArt

Run from the ProArt on 2026-10-29, against the real link, with the ProArt's own
render of the sitka scene (`~/blender-scenes/sitka/render_final.png`):

| input                        | sent      | answer     | round trip | of which inference |
| ---------------------------- | --------- | ---------- | ---------- | ------------------ |
| PNG, 1920 × 1080             | 2.86 MB   | 1.56 MB    | 768 ms     | 128 ms             |
| JPEG q=90, 1024 long side    | 78 KB     | 1.56 MB    | 551 ms     | 105 ms             |
| **JPEG q=85, 768 long side** | **37 KB** | **892 KB** | **223 ms** | **87 ms**          |

**The transfer dominates, not the inference** — and the answer's size is set by
the working resolution, not by the input's. A caller that wants a smaller answer
asks for a smaller image; one that wants detail pays for it in bytes.

Two more things the proof checked, because a geometry service that answered
differently twice would poison everything downstream of it:

- **Determinism.** The same image gives byte-identical depth on a repeat query.
- **The answer is a geometry, not noise.** 100 % of pixels valid, median depth
  2.03 m, and the recovered point cloud spans x ∈ [−2.11, 2.00], z ∈ [0.97, 4.46]
  — a plausible street scene.

## The two costs that are not the compute

- **Weight load: 56.1 s** at start-up. The service is cold for a minute, then
  resident. Nothing sits in VRAM unless it is being used — 1.4 GB is this
  service's price of admission, and it is the first thing on the box that earns
  its place by being used.
- **The first query in a process is slower than the rest.** The torch wheel
  carries no `sm_110` SASS for these kernels, so they are JIT-compiled from PTX
  on first use. A second query is the number that matters; measure the tail.
  Measured in the running service: 1454 ms for the first query, **78 ms** for the
  second and third.

## Running it

```bash
~/ml/.venv-vggt/bin/python geometry/server.py --port 8099
```

Environment: a venv with `torch` (CUDA), `moge` (from
`git+https://github.com/microsoft/MoGe`), `utils3d_moge` (from
`git+https://github.com/EasternJournalist/utils3d-moge.git`) and `pillow`. The
weights live outside the repository, at `~/models/moge-vitl/model.pt` by
default — see `requirements.txt` for the exact pins.

On the Thor it runs as a systemd user unit, `geometry.service`.
