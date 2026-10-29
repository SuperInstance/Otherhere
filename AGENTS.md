# Working on Otherhere: notes for agents

Read this before changing anything. It is the context a new session lacks: how the pieces fit, the rules that keep the world deterministic, and the mistakes already made once. `docs/BRIEF.md` is the product brief and its invariants. `docs/adr/` records each decision. `docs/advice/` holds reviews and recommendations from earlier sessions; check it before starting work in an area it covers.

## The shape of the system

- **Facts** live in Durable Objects (`apps/edge/src/town.ts`, one `TownDO` per H3 res-6 Town). Every Fact has a source, a confidence and a time. Sources rank (`capture` above `osm` above everything imagined); the highest-ranked confident Fact wins (`packages/core/src/facts`).
- **Bundles** are GLBs built from a Cell's resolved Facts plus the Town's quantized **Essence** (`packages/core/src/bundle/build.ts`). A Bundle is content-addressed: `inputsHash` covers the Cell, the interpreter version, the generator versions, the Facts and the Essence. The client re-hashes every Bundle and shows `n/n bundle hashes verified`. A mismatch is a bug.
- **Generators** are JSON (`packages/core/src/generators/*.json`), interpreted by `geometry/interpret.ts`. Model output is never executed as code (invariant 3). New geometry means a new generator version or a new DSL op.
- **Display layers** run only in the client and never enter a Bundle (ADR-0016):
  - **Terrain** (`terrain.ts`): Terrarium elevation and optional Sentinel-2 2016 imagery, fetched through `/api/tiles`.
  - **Atmosphere** (`atmosphere.ts`): sky, fog and valley mist.
  - **Ocean, foam, clouds, mist banks and snow** (`ocean.ts`).
  - **Forest** (`forest.ts`): instanced conifers, seeded per 250 m chunk.
  - **Arrival** (`arrival.ts`): the opening fly-in.

  They may use public data that is not a Fact (elevation, imagery), so they must not change Bundle bytes.

- **Standing Bundles on the ground**: Bundles are built flat. After the hash check, the client moves each Feature onto the terrain: a building as one rigid piece onto the lowest ground under it, a road draped per vertex. It does this again when finer ground arrives (`World.standAgain`, `standFeatures`). The server never knows elevation.

- **Captured assets** ride beside a Bundle, not inside it. An `asset.capture` Fact names the
  tiers of a capture — `splat` (a gaussian field), `model` (a real triangle mesh), `impostor`
  and `card` (photographs) — each with its path, sha256 and byte count
  (`packages/core/src/schema/asset.ts`). The payloads live beside the place file that vouches
  for them, and the client fetches, hash-verifies and draws them (`apps/client/src/assets.ts`).
  The ladder is **splat near, mesh beyond** — a capture with a `model` tier never shows its
  photograph again; the lite profile never fetches a mesh (ADR-0023).
- **A capture's tiers share ONE placement.** The Fact carries a single
  `position`/`quaternion`/`scale` for every tier, so a _generated_ mesh cannot choose where it
  stands — it has to be authored into the capture's frame on the Thor, or it lands in the
  wrong place at the wrong size facing the wrong way (ADR-0024).

- **The Thor hosts models and generates assets; the ProArt renders them** (ADR-0021). The Thor
  is a Jetson AGX Thor on the LAN; the ProArt is the renderer. If you are working on the
  renderer, **read [`docs/proart-handoff.md`](docs/proart-handoff.md)** first: it is the map of
  what the other machine hosts, how to reach it, and the rules that keep the two halves
  honest. The Thor also serves a live index of everything it has at `http://thor.local:8100/`
  (`/index.json` for agents) — read it before you guess what exists.

## Rules that are easy to break

- **Determinism (invariant 2)**: anything that reaches Bundle bytes must not depend on
  - `Math.random`, the clock, or the order network responses arrive;
  - `Map`/`Set`/object iteration order that came from the network or SQL;
  - floating-point functions that may round differently across engines.

  Sort by stable IDs. Use the `det` helpers in `packages/core/src/math` for trig. Compare squared distances rather than `Math.hypot(...) < r`.

- **Everything an output depends on must be in its content address.** A tuning constant that changes Bundle bytes needs a version that is hashed: bump `INTERPRETER_VERSION` (`geometry/interpret.ts`) or the generator's `version`. Otherwise old Cells keep serving old bytes while new Cells get new ones.
- **Changing output on purpose**: bump the version, then run `pnpm --filter @otherhere/core exec tsx scripts/golden.ts` to re-pin `packages/core/src/demo/golden.json`. The golden is asserted in Node, workerd and the browser.
- **Cache keys move together.** If you rename a stored key (`meta` rows in `TownDO`, R2 prefixes), grep for every reader, writer and invalidator of the old name.
- **Paid model calls go through the `ModelRouter`** with its caps (invariant 9). Scripts under `packages/*/scripts` are local tools, not runtime.
- **No Google imagery or data** (invariant 8). Elevation comes from Mapzen Terrarium; imagery from EOX Sentinel-2 cloudless **2016** (CC BY 4.0; later years are non-commercial). Both are attributed in the status line.
- **Private by default** (invariant 5). Photos are never stored; only Facts derived from them.

## Before you push, and before you merge

- `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass. Prettier also checks Markdown, so run `pnpm exec prettier --write` on docs you add.
- E2E: `pnpm --filter @otherhere/client e2e`. It runs the real Worker with every external service pointed at a closed port: Overpass, Nominatim and both tile sources (see `apps/edge/package.json` `dev:e2e`). So the world is flat in e2e, and terrain-dependent code must fall back cleanly. A failure that "only happens on CI" is usually timing: find the race, don't retry it away.
- **Wait for CI to finish before merging.** #20 was merged while its e2e was still running and shipped a race to production (fixed in #22).
- **Look at it in a browser at the real place.** Most bugs in this project's display layers passed unit tests and review, and only showed in a screenshot of Sitka:
  - buried buildings;
  - the camera inside a hill;
  - a checkerboard shoreline;
  - trees in the sea.

  Software GL in a container runs at 1–3 fps. That is slow but faithful.

- Deploys happen on merge to `main` (GitHub Actions, gated on `DEPLOY_ENABLED`). Check `https://otherhere.superinstance.dev/api/health` afterwards.

## Saving tokens: delegation

Cheaper models draft and review well when the spec is sharp. The process, the tools (`packages/models/scripts/delegate.ts`, `jev-spec-check.ts`, `jev-review.ts`) and every lesson so far are in `docs/notes/delegation.md`. Saved specs and checklists live in `packages/models/tuning/specs/`. In short:

1. Write the exact API and a literal checklist first.
2. Draft with `deepseek-flash` or `MiniMax-M3`.
3. Triage with Jev.
4. Read the draft, type-check it, test it, and look at it in the browser.

Pure maths modules come back nearly ready. Shaders need eyes.
