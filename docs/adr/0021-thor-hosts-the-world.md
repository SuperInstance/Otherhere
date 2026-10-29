---
status: accepted
---

# The Thor hosts the world; the ProArt renders it

**Accepted by the project owner on 2026-10-29.**

## Context

The whole-house quilt has three seats: the **Orin** (Casey's desk, the engine), the **Thor**
(the thinking, the models, the generation), and the **ProArt** (the rendering, at the eyes).
The trifecta placement was open. What was missing was not a model — the Thor already hosts a
working decision tier, the JEV rack, ComfyUI, the Foundry, the coder and an image→3D
generator — it was **any way for the ProArt to ask the Thor for anything**.

Meanwhile the renderer already speaks a fetch-on-notice protocol it had never been given a
server for.

## The measurement that decides it

The corpus recorded ProArt→Thor at 5.2 ms but flagged throughput as unmeasured. Measured
2026-10-29 by serving 64 MiB from the Thor over HTTP and fetching it from the ProArt:

| measure                  | value                                  |
| ------------------------ | -------------------------------------- |
| TCP connect              | 5.3 – 8.8 ms                           |
| time to first byte, 4 KB | 11.3 – 18.7 ms                         |
| throughput, 64 MB        | **9.3 – 11.5 MB/s** (≈ 75 – 92 Mbit/s) |

**This rules the Thor out as a render server for a real-time 3D view.** A 1440p frame is
roughly 1–3 MB; at 60 fps that is 60–180 MB/s against a measured 9.3 MB/s — **6–19× over
budget**. Even 10 fps is over. And it rules it _in_ as a host for anything the renderer
fetches once and keeps: a 192 KiB splat tier costs ~50 ms; a 5.35 MB painted mesh costs
0.58 s.

So the placement is not a preference, it is arithmetic:

> **The Thor hosts models and generates assets. The ProArt renders and displays them. The
> Thor is never asked to render frames for a real-time view.**

A _synoptic_ view — scoreboards, cell states, the commons' drift — is text and small numbers,
and costs nothing to move.

## The decision

**The Thor serves; the renderer fetches on notice.** The seam already exists on the renderer
side and is not being used:

- `packages/core/src/schema/asset.ts` defines `AssetCapture` with content-addressed tiers —
  `splat` (a gaussian field, `.spz`), `impostor` and `card`.
- `apps/client/src/assets.ts` picks a tier by distance (`SPLAT_NEAR_M = 140`) and profile,
  fetches it, **checks the byte count and the sha256 against the bundle**, and degrades
  gracefully when a tier fails.
- `packages/assets` (new) is the producer side of that contract: a registry that reads the
  Thor's capture directories, verifies every payload against its receipt, and a service that
  serves the verified bytes at the path the manifest names.

**Rules this imposes:**

1. **Never serve an unverified payload.** A capture whose bytes do not match its receipt is
   withheld and reported, not served. The renderer would drop it anyway; serving it would make
   the failure look like the renderer's.
2. **The manifest names the path, the byte count and the hash.** The renderer must be able to
   check what it got without asking us what it should have got.
3. **The registry is re-read, not cached.** Generation runs ahead of presence, so a capture
   can land at any moment and must become fetchable without a restart.
4. **Heavy payloads stay on the Thor; the manifest is small.** The registry is a few kilobytes;
   a splat tier is ~170 KB; a mesh tier is ~5 MB. The manifest travels; the bytes are fetched.
5. **The pipeline's tier names are translated once, here.** The capture pipeline calls its
   gaussian field `mesh`; the client calls that tier `splat`. The translation lives in the
   registry, not in two places.

## What this makes possible

Everything the Thor can already make becomes reachable by the renderer:

| capability                            | measured on the Thor                        | was it reachable?             |
| ------------------------------------- | ------------------------------------------- | ----------------------------- |
| splat capture (`asset-capture`)       | 11 min 27 s per subject, zero interventions | ❌ batch, by hand             |
| image→3D with PBR (Hunyuan3D-2.1)     | 147.9 s → 40,000 faces, 5.35 MB             | ❌ batch, by hand             |
| feed-forward reconstruction (VGGT-1B) | 230 frames → one global frame, 1314 s       | ❌ batch, by hand             |
| the decision tier (`d1-2B`)           | 98.4 % on text at 189 ms                    | ❌ only from this repo's code |

**Proven end to end on 2026-10-29**, from the ProArt over the LAN: all nine tiers of the
three real captures fetched and verified — byte count and sha256 — in 12–53 ms.

## What this does not do

- It does not make the Thor a render server. §"The measurement that decides it" rules that
  out on bandwidth.
- It does not add a mesh tier to the client. The client speaks `splat` / `impostor` / `card`,
  and the pipeline's `mesh` tier is a gaussian field in SPZ form. A textured-mesh tier would
  be a new schema, a new loader and a new budget — the ledger's "decimate toward game
  budgets" work, not this.
- It does not authenticate. It inherits the Thor's open-by-choice posture
  (ADR-0019): LAN-open, CORS open to every origin, reversible with a key.
- It does not touch the judge, the packs or the Ladder.

## Evidence

- `docs/notes/thor-hosts-the-world.md` — the measurements, the research, and the honest
  negatives.
- `packages/assets/` — the registry, the service, and 9 tests over the contract.
- `docs/adr/0019-local-decision-tiers.md` — the tier the decision models occupy.
