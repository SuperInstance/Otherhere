# M0 plan: vertical slices

Each slice is demoable on its own and lands as small, test-first commits. Decisions are in `docs/adr/`; vocabulary is in `CONTEXT.md`.

| # | Slice | Demo |
|---|-------|------|
| S0 | **Skeleton**: pnpm workspaces, TypeScript, ESLint + Prettier, Vitest, GitHub Actions CI, `pnpm dev` runs Vite client + local wrangler together | `pnpm dev` → page loads, calls `/api/health` on local wrangler |
| S1 | **Core vocabulary**: zod schemas (Fact, Feature, Cell, Bundle, Capsule, Scope, Ruleset, GeneratorDef, QuestionPack, Ladder decision log), H3 helpers, deterministic math, seeded RNG, canonical JSON + SHA-256 | `pnpm test` covers schema round-trips, fact resolution, RNG streams |
| S2 | **Geometry DSL v0**: interpreter for footprint extrusion, flat/gable/hip/shed roofs, window grids, props (tree, bench, streetlight); deterministic GLB writer; golden hash tests | `?demo=generators` shows every roof + prop on a test lot |
| S3 | **OSM ingest**: Overpass query for a Cell's bbox → Features/Facts (`source: "osm"`), roads split into anchored segments, Overpass endpoint fallback | Unit tests on recorded Overpass fixtures; `pnpm ingest <lat> <lng>` prints Facts |
| S4 | **Edge pipeline**: `TownDO` (SQLite) stores Facts and Cell→Bundle-hash pointers; `GET /api/cells/:cell/bundle` ingests if needed, builds, caches GLB in R2 by content hash | Workers-runtime tests: same Cell twice → same hash, second served from R2 |
| S5 | **Walk your neighborhood**: lat/lng input, loads Cell + ring, walk camera (WASD/mouse, touch joystick on iPad/iPhone), "soft until sure" confidence shading, WebGPU→WebGL2 fallback | Type coordinates, walk; reload gives identical scene |
| S6 | **Deploy**: `wrangler deploy` serves the client as static assets + API from one Worker | Public URL |

**Out of M0:** terrain (flat ground), SessionDO, captures, models router, auth (ADR-0009).
