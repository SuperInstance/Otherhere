# Otherhere

A second version of where you already are: your real place, but playable, imagined, and shared. The whole Earth starts as a stylized sketch and sharpens wherever someone plays, captures, or pays attention. It's a game first, not a digital twin.

Read [`docs/BRIEF.md`](docs/BRIEF.md) for the vision, [`CONTEXT.md`](CONTEXT.md) for the vocabulary, [`docs/adr/`](docs/adr) for decisions, and [`docs/PLAN-M0.md`](docs/PLAN-M0.md) for the current milestone.

| Generator demo (built in the browser) | Zürich from OpenStreetMap                                    |
| ------------------------------------- | ------------------------------------------------------------ |
| ![Demo lot](docs/img/demo.png)        | ![Aerial view of central Zürich](docs/img/aerial-zurich.png) |

Geometry backed by known facts (OSM height, roof shape) renders crisp and fully coloured. Geometry the generators imagine renders **soft**: washed toward paper, with flattened shading.

## Layout

```
packages/core   zod schemas, H3 helpers, deterministic math + RNG, geometry DSL + interpreter,
                built-in generators (JSON), GLB writer, OSM → Facts
apps/edge       Cloudflare Worker: TownDO (SQLite Facts per H3 res-6 Town), R2 Bundle cache,
                SessionDO (matches: signaling, relay, authoritative events), static client
apps/client     Vite + three.js (WebGPU, falls back to WebGL2): walk any lat/lng
```

## Develop

```sh
pnpm install
pnpm dev          # client on :5173 (proxying /api) + local Worker on :8787
pnpm seed:dev     # optional: load the recorded Zürich block, so it works without reaching Overpass
open "http://localhost:5173/?at=47.3769,8.5417"
```

Controls: WASD or arrows to walk, drag to look, Shift to run, scroll (or R/F) to rise and fall. On touch screens, the left side is a joystick and the right side looks around. `?demo=generators` shows every roof shape and prop.

**Play capture the flag:** while walking a place, choose **Start a match here** and share the invite link. Players join the smaller team and start at their bases. Grab the enemy flag and bring it home; defenders tag intruders in their half. Enemies stay hidden unless a teammate is within 45 m (team fog). Motion travels peer to peer over WebRTC, and the match's Durable Object decides pickups, captures, tags, and score (ADR-0011). To relay through TURN behind strict NATs, set the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` Worker secrets (Cloudflare Realtime).

```sh
pnpm test         # core (Node), edge (workerd), client unit tests
pnpm --filter @otherhere/client e2e   # Playwright: demo, real neighbourhood, pixel-identical reload, two-player match
pnpm lint && pnpm typecheck
pnpm ingest <lat> <lng>               # fetch OSM around a point and summarise the Facts
```

## Determinism

Bundles are a pure function of Facts and generator versions (invariants 1 and 2). The demo lot's GLB hash is pinned in [`packages/core/src/demo/golden.json`](packages/core/src/demo/golden.json) and asserted in Node, in workerd, and in the browser. The client re-hashes every Bundle it downloads and shows `n/n bundle hashes verified`. If you change generator or interpreter output on purpose, bump `INTERPRETER_VERSION` (or the generator's version) and run `pnpm --filter @otherhere/core exec tsx scripts/golden.ts`.

## Deploy

The Worker serves both the client and the API. Deploying needs an R2 bucket named `otherhere-bundles`, which already exists in the account this was built against.

```sh
CLOUDFLARE_API_TOKEN=... pnpm deploy
```

Or run the **Deploy** GitHub Action. It needs repository secrets `CLOUDFLARE_API_TOKEN` (permissions: Workers Scripts edit, Workers R2 Storage edit) and `CLOUDFLARE_ACCOUNT_ID`. To deploy on every push to `main`, set the repository variable `DEPLOY_ENABLED=true`.

OSM data © OpenStreetMap contributors, ODbL. Fetched from public Overpass instances with endpoint fallback (ADR-0010).
