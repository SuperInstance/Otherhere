# Determinism: local metric frames, deterministic math, quantized output

JavaScript does not guarantee bit-identical `Math.sin`/`Math.cos`/`Math.pow` across engines, so "same inputs give the same output on every device" (invariant 2) needs care:

1. Geometry is computed in a **local metric frame** centered on the Cell center (meters, east/north/up). Lat/lng is projected with an equirectangular approximation whose `cos(lat)` comes from our own polynomial `detCos`, using only `+ − × ÷`. IEEE-754 makes those bit-exact everywhere.
2. The interpreter uses only `+ − × ÷`, `Math.sqrt` (correctly rounded by spec), `Math.floor`/`Math.round`, `Math.min`/`Math.max`, `Math.abs`, and our deterministic trig.
3. Randomness comes from `mulberry32` seeded with `fnv1a32(stableId + ":" + purpose)`.
4. Output vertices are **quantized to millimetres (Int32)** before serialisation and hashing.

Golden tests assert SHA-256 hashes of interpreter output and run in both Node and the Workers runtime.
