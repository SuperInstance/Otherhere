# Bundles are built in the Worker and stored in R2 as GLB, keyed by content hash

A Bundle is built on demand by the edge Worker from the Town's resolved Facts and the current generator versions, then stored in R2 under `bundles/<sha256>.glb`. The hash covers the canonical JSON of `{cell, resolved facts, generator id@version list, interpreter version}`. A small per-Cell pointer in the TownDO maps Cell → current hash, so an unchanged Cell is served from R2 without a rebuild.

GLB (binary glTF 2.0) is boring, inspectable in any viewer, loads with three's `GLTFLoader`, and becomes the natural payload for postcard Capsules later. Per-vertex confidence ships as the custom attribute `_CONFIDENCE`. The interpreter lives in `packages/core`, so the browser can build the same Bundle locally (offline, tests, plugins) with identical bytes.

## Consequences

- On the Workers Free plan (10 ms CPU), a dense Cell may not build in one request. M0 targets the Paid plan's CPU limits. If that's not available, the client builds locally and the edge caches the result.
