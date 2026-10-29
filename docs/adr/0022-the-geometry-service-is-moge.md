---
status: accepted
---

# The geometry service is MoGe; VGGT is the batch lane

**Accepted by the project owner on 2026-10-29.**

## Context

[ADR-0021](0021-thor-hosts-the-world.md) settled where things run: the Thor hosts models and
generates assets, the ProArt renders and displays them. That left one question the overnight
research put at the top of the list — **what the Thor could host that would make the ProArt's
world better**: a _geometry service_, something the renderer can ask "what is behind the player?"
and get an answer.

Two feed-forward geometry models were in scope, and the research carried a specific estimate —
**250–600 ms per query** — and asked for it to be measured before anything was built on top of
it. That estimate came from a 4090. **Nothing had been measured on this Thor.**

A geometry service is only worth building if a query is fast enough to feel like a service.
That number decides the architecture, so it was measured first.

## The measurement

Measured on the Thor (Jetson AGX Thor, 128 GB unified, CUDA 13.2, sm_110, ARM64) on 2026-10-29,
at the portrait aspect the cathedral drive actually used (518 × 924), bf16 autocast, weights
resident.

**VGGT-1B** (`~/d1-lab/bench_vggt_steady.py`, `~/d1-lab/research/vggt-steady.json`):

| repeat                       | forward      |
| ---------------------------- | ------------ |
| 1 (first in a fresh process) | 1516.4 ms    |
| 2                            | 882.2 ms     |
| 3                            | 900.3 ms     |
| 4                            | 901.9 ms     |
| 5                            | 881.0 ms     |
| 6                            | 865.0 ms     |
| **steady-state median**      | **881.0 ms** |

**MoGe ViT-Large** (`~/d1-lab/bench_moge_service.py`, `~/d1-lab/research/moge-service-bench.json`):

| setting                   | warm        | peak GPU |
| ------------------------- | ----------- | -------- |
| `num_tokens=1200`         | **72.2 ms** | 1.43 GB  |
| resolution level 6        | 130.1 ms    | 1.60 GB  |
| resolution level 8        | 144.1 ms    | 1.66 GB  |
| `num_tokens=2500`         | 148.1 ms    | 1.68 GB  |
| resolution level 9 (full) | 150.2 ms    | 1.69 GB  |

Model load: 56.1 s (MoGe, 1.26 GB) and 99.1 s (VGGT, 5.03 GB, mmap'd).

### The measurement nearly lied, twice

The first VGGT benchmark reported **218.9 s** for one image and **190.6 s** for the second. That
number was almost entirely **CUDA kernel compilation**: the torch wheel carries no `sm_110` SASS
for these kernels, so they are JIT-compiled from PTX on first use, and a new tensor shape
recompiles. The tell was that the curve was not monotone — four frames came in at 82.5 s and
sixteen at 44.4 s, _faster_ than one.

The same lab notebook had already recorded the mirror image of this mistake for memory
("flat-memory extrapolation from 8/32-frame probes under-estimated the 230-frame activation
cost"). The rule is the same in both directions: **measure at the target, repeat the measurement,
and believe the tail, not the head.**

Two costs that the frame counts hid:

- **Weight load: 1201.7 s** for the 5.03 GB checkpoint by the ordinary `torch.load` path. mmap
  cuts it to 99.1 s. A service that reloads on every restart is a service that is cold for
  twenty minutes.
- **The payload is the constraint, not the compute.** One 518 × 924 point map is 478,632 points
  — **5.74 MB as fp32, 2.87 MB as fp16** — and the depth map is another 1.91 MB as fp32. At the
  measured 9.3 MB/s that is **0.31–0.62 s of link** per frame, on top of the compute. A service
  that answers in 72 ms and then spends 300 ms moving the answer has an answer that takes
  **0.4 s**, not 72 ms.

## The decision

**The geometry service is viable, and it is MoGe — not VGGT.**

- **MoGe ViT-Large is the service.** 72 ms per query at `num_tokens=1200`, MIT licence, 1.26 GB
  of weights, 1.4 GB of VRAM. That is inside the range the research asked about, and the licence
  is settled: the model card says `license: mit`, with no gating and no terms.
  _(The v2 weights live in `Ruicheng/MoGe-2`, which answers 401 to an unauthenticated fetch; the
  v1 release `Ruicheng/moge-vitl` is what this box can actually run.)_
- **VGGT-1B is the batch lane, not the service.** Its strength is many images into one global
  frame — 230 frames in one coordinate system where COLMAP produced three fragments — and that
  is exactly what a per-cell capture wants. At 881 ms per image and with an unresolved licence
  (the original checkpoint is tagged non-commercial while its HuggingFace metadata claims MIT),
  it is not the thing the renderer queries and not the thing that ships.
- **The service sends depth and intrinsics, not a point map.** The point map is a convenience
  for a local consumer; over the link, depth plus the intrinsic matrix is 0.96 MB as fp16 and
  the consumer can unproject it itself — which it already does (`apps/client` has the sha256 and
  byte-count discipline for exactly this kind of payload).

### Consequences

- The renderer gains a **new request path**, and it is the first one that asks the Thor a
  question rather than fetching a known payload. It must be answerable inside a cell load
  (~0.4 s round trip), not inside a frame.
- A geometry service is **stateful in exactly one way: the weights are resident**. The Thor's
  standing policy is that nothing sits in VRAM unless it is actively used; this is the first
  candidate that earns its place by being used. 1.4 GB is the price of admission.
- The compute is cheap enough that the **GPU queue is the right home** for the batch geometry
  lane: a multi-frame reconstruction is a named job, and the queue already owns "never let the
  GPU sit idle while named work exists".

### The service, measured end to end

`geometry/server.py` — MoGe resident, `POST /geometry`, the image in and the depth plus the
intrinsics out. Run from the ProArt on 2026-10-29 against the real link:

| input                        | sent      | answer     | round trip | of which inference |
| ---------------------------- | --------- | ---------- | ---------- | ------------------ |
| PNG, 1920 × 1080             | 2.86 MB   | 1.56 MB    | 768 ms     | 128 ms             |
| JPEG q=90, 1024 long side    | 78 KB     | 1.56 MB    | 551 ms     | 105 ms             |
| **JPEG q=85, 768 long side** | **37 KB** | **892 KB** | **223 ms** | **87 ms**          |

**The transfer dominates, not the inference.** The answer's size is set by the working
resolution, so a caller that wants a smaller answer asks for a smaller image.

The proof also checked two things that are easy to get wrong and expensive to get wrong:

- **Determinism.** The same image gives byte-identical depth on a repeat query. A geometry
  service that answered differently twice would poison every content address downstream.
- **The answer is a geometry, not noise.** 100 % of pixels valid, median depth 2.03 m, and the
  recovered point cloud spans x ∈ [−2.11, 2.00], z ∈ [0.97, 4.46] — a plausible street scene.

And one convention worth naming, because a consumer that got it wrong would reconstruct a
scene that is subtly, plausibly wrong: **the model returns its intrinsics normalised** (the
principal point is (0.5, 0.5), the focal length is in units of the image's own width). The
service sends the pixel form alongside it, flagged.

## What would change this decision

- A measured round trip over the real link with the real payload. The 0.31–0.62 s transfer
  figure is arithmetic on the measured bandwidth; the table above is the measurement, and it is
  better than the arithmetic for small inputs and worse for large ones.
- The Thor's Ethernet brought up. The measured 9.3–11.5 MB/s is a Wi-Fi figure, and with the
  transfer dominating the round trip, this is now the **binding constraint** on the geometry
  service rather than a background detail.
- A resolution below `num_tokens=1200`. The 72 ms figure is the _coarse_ end of the accuracy
  knob; whether 1200 tokens is good enough for the renderer is not yet measured.
