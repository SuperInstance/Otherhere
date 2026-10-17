# H3 resolution 9 for Cells

A **Cell** is an H3 resolution-9 cell (~0.1 km², ~200 m edge). It is the unit of loading, generation, and caching for **Bundles**. Res 9 keeps one Bundle small enough to rebuild in a single Worker request and download quickly on a phone, while a walk needs only a handful of cells (center + 1 ring = 7 cells, ~700 m across). Res 10 means too many R2 objects and constant cell crossings; res 8 makes Bundles too heavy to rebuild cheaply when one Fact changes.

## Consequences

- Every Feature also records its precise location (lat/lng), so Bundles can be re-bucketed to another resolution without re-ingesting. This keeps the choice reversible under invariant 1 (derived = f(facts, generator versions)).
