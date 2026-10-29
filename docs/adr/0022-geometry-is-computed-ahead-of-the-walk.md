---
status: accepted
---

# Geometry is computed ahead of the walk, not during it

**Accepted by the project owner on 2026-10-29.**

## Context

[ADR-0021](0021-thor-hosts-the-world.md) settled where things run: the Thor hosts models and
generates assets, the ProArt renders and displays them. That left one open question the
overnight research put at the top of the list — **what the Thor could host that would make the
ProArt's world better**: a _geometry service_, something the renderer can ask "what is behind
the player?" and get an answer.

The candidates were VGGT-1B and MoGe-2. Both are feed-forward geometry models: images in,
point maps and camera poses out. The research carried a specific estimate — **250–600 ms per
query** — and asked for it to be measured before anything was built on top of it. That estimate
came from a 4090. Nothing had been measured on this Thor.

**A geometry service is only worth building if a query is fast enough to feel like a service.**
If a single image costs seconds, the renderer cannot ask on demand; it can only fetch geometry
that was computed earlier. Those are different architectures with different costs, so the number
decides which one gets built.

## The measurement

Measured on the Thor (Jetson AGX Thor, 128 GB unified, CUDA 13.2, sm_110, ARM64) on
2026-10-29, at the portrait aspect the cathedral drive actually used (518 × 924), bf16
autocast, weights resident. Script `~/d1-lab/bench_vggt_service.py`, log
`~/d1-lab/research/vggt-bench.log`.

| frames         | forward | per frame | peak GPU | end-to-end |
| -------------- | ------- | --------- | -------- | ---------- |
| 1 (cold)       | 218.9 s | 218.9 s   | 8.0 GB   | 226.4 s    |
| 1 (second run) | 190.6 s | 190.6 s   | 8.0 GB   | 190.7 s    |
| 4              | 82.5 s  | 20.6 s    | 9.3 GB   | 89.9 s     |
| 16             | 44.4 s  | 2.78 s    | 12.1 GB  | 67.8 s     |

**The numbers are not monotone in the frame count, and that is the finding.** Four frames are
faster than one. The explanation is a one-time cost paid by the first forwards: the torch wheel
carries no `sm_110` SASS for these kernels, so they are JIT-compiled from PTX on first use. The
_second_ single-image run was still paying part of that bill.

So the honest single-image number is not yet known, and the script that finds it
(`~/d1-lab/bench_vggt_steady.py`, mmap'd weights, six repeats, median of the last three) is
the one that answers the question. The 190.6 s figure is an **upper bound**, and it is already
300× over the service threshold.

Two further costs that the frame counts hide:

- **Weight load: 1201.7 s** for the 5.03 GB checkpoint, the ordinary `torch.load` path. mmap
  cuts this to minutes. A service that reloads on every restart is a service that is cold for
  twenty minutes.
- **The payload is not small.** One 518 × 924 point map is 478,632 points — **5.74 MB as fp32,
  2.87 MB as fp16** — before any compression. At the measured 9.3 MB/s that is 0.62 s of link
  for a single frame of geometry, on top of the compute.

## The decision

**Geometry is computed ahead of the walk. The Thor is not asked for geometry on demand.**

- A **per-cell geometry cache** is the design: geometry is computed in a batch (the 16-frame
  run above is 44.4 s, and the 230-frame cathedral run was 21 min 54 s under contention), it is
  reduced to the tier sizes the renderer actually ships, and it is fetched like any other
  content-addressed payload — through the capture service, verified by hash.
- **VGGT-1B is not a service.** Its licence is also unresolved: the original checkpoint is
  tagged non-commercial while its HuggingFace metadata claims MIT.
- **The licence-clean route is the one to keep.** MoGe-2 (`Ruicheng/moge-vitl`) is MIT outright
  and 1.26 GB. If a geometry model is to run at all, run the one whose licence is settled.

This does not contradict ADR-0021 — it is the same law applied to a new payload. The renderer
fetches content it already knows by hash; it never waits on a model.

## Consequences

- The renderer gains **no** new request path. Geometry arrives the way every other captured
  asset arrives: as a verified tier at a known path.
- A **geometry service** (an HTTP endpoint the renderer can call mid-frame) is not on the table
  on this hardware, and the 9.3 MB/s link would not have carried its output anyway.
- The Thor's batch lanes are the right home for geometry work: the GPU queue already owns
  "never let the GPU sit idle while named work exists", and a 16-frame reconstruction is
  exactly a named batch job.

## What would change this decision

- A single-image forward measured under 150 ms on the Thor. That would make a geometry
  _service_ viable, and it would be worth building.
- The Thor's Ethernet brought up. The measured 9.3–11.5 MB/s is a Wi-Fi figure; a wired
  link is faster, though not 60× faster, and the compute is the binding constraint anyway.
