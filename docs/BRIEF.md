# Project brief: a world engine built from real places

> How to use: put this file at `docs/BRIEF.md` in an empty repo, open Claude Code there, and say:
> "Read docs/BRIEF.md and follow the 'How to work' section."

## What we're building

A game platform where the real world is the raw material. The whole Earth exists from the start as a stylized sketch. Wherever someone plays, captures, or pays attention, it sharpens. It remembers like a person does: vivid where you are now, the essence of where you've been, and specific memories that never fade.

People use it to:
- create explorable media from places they love ("Street View but way better", stylized and narrated)
- keep private atlases of favorite spots
- play games on real places with friends
- (later) let kids vibe-code adventures in their own neighborhood

It is a game first, not a digital twin. "Stylized truth" means accurate layout, proportions, color, and character, not photorealism. The system must get better at what it creates the more it's used.

It is not a central system. Each person's world lives in storage they own. Sharing is opt-in, per item, by scope.

## Glossary (use these exact words in code and docs)

- **World**: a person's remembered world: facts, captures, essence, memories.
- **Fact**: one attribute of one feature, with provenance (source, confidence, timestamp, version).
- **Feature**: a building, road, tree, prop, etc., with a stable ID.
- **Cell**: an H3 cell; the unit of loading, generation, and caching.
- **Bundle**: derived assets for a cell (meshes, textures). Always regenerable.
- **Generator**: a parametric object definition written in our geometry DSL.
- **Capture**: user-recorded media (phone video, GPS track, photos, voice notes) attached to a place.
- **Essence**: compressed statistics of a neighborhood's character (palette, eras, roof types, prop families). Used to imagine unseen areas.
- **Memory**: a high-salience place kept at full fidelity forever.
- **Ruleset**: the game being played. It defines objectives, simulation, and fog behavior.
- **Capsule**: a shareable package (a place, capture, ruleset, or match) with a scope.
- **Scope**: `private` | `friends` | `public`.
- **Plugin**: an optional device that contributes compute (GPU laptop, always-on server, any laptop, phone).
- **Question pack**: a versioned set of typed questions answered by a decision model.
- **Ladder**: the escalation path for decisions, from cheapest to most expensive.

## Invariants (never violate; propose an ADR if one seems wrong)

1. **Derived = f(facts, generator versions).** Bundles are content-addressed and regenerable. Only facts and captures are irreplaceable.
2. **Determinism.** All procedural randomness is seeded from stable IDs (plus the sim clock for agents). Same inputs give the same output on every device. Test this with output hashes.
3. **No executing model-written code.** Generators and rulesets are data in constrained DSLs, run by our trusted interpreter. No `eval`, no dynamic imports of generated code.
4. **Provenance on every fact.** Source rank, lowest to highest: `osm` < `overture` < `satellite_inference` < `street_imagery` < `capture` < `manual_edit`. Resolve conflicts by rank, then confidence.
5. **Private by default.** Before anything leaves `private` scope, faces and license plates are blurred, and home areas can be location-fuzzed. Kid accounts never have `public` scope; kid friends connect directly by code or with parent approval.
6. **The judge is fixed.** Eval sets and scoring code are never modified by automated improvement processes.
7. **Plugins are optional.** Everything must work with only Cloudflare plus one browser.
8. **Data sources.** Use OpenStreetMap, Overture, Mapillary, open elevation and imagery datasets, and user captures. Never Google Street View or Google Maps imagery.
9. **Paid model calls go through one router** with per-provider daily budget caps. Tests use fakes and never call paid APIs.

## Architecture (decided)

TypeScript monorepo, pnpm workspaces.

- `packages/core`: zod schemas for every glossary type, H3 helpers, seeded RNG, the geometry DSL and its interpreter, and the capsule format.
- `apps/client`: Vite + Three.js (WebGPU renderer with WebGL fallback). Must run in desktop browsers and Safari on iPad/iPhone. Includes a walk camera and a confidence-driven "soft until sure" stylized look.
- `apps/edge`: Cloudflare Workers.
  - `TownDO` (SQLite-backed Durable Object): facts, essence, memories for one town or region.
  - `SessionDO`: presence, WebRTC signaling, edit log. Uses the WebSocket Hibernation API.
  - R2: bundles and captures. Vectorize: generator and question-pack indexes. Queues: jobs.
- `apps/agent`: Node plugin runtime for extra devices. It advertises a capability manifest (GPU, VRAM, CPU, always-on), pulls matching jobs, and returns results as proposals that the TownDO validates.
- `packages/models`: the model router.
  - Vision model (e.g. Groq): turns pixels into structured observations ("state").
  - TypeSafe Jev: typed decisions over question packs. API shape: `POST https://api.typesafe.ai/v1/systemone` with `{ state, model: "jev-latest", questions: { <id>: { type: "noul" | "choice" | "score", instructions, criteria } } }`. Returns answers with probabilities and confidence. `choice` allows up to 255 options; `score` takes 2–10 levels. It does not accept images, so the vision step comes first.
  - Claude: authors new generators and question packs (rare, expensive).
- Networking: WebRTC data channels between peers, `SessionDO` for signaling, Cloudflare Realtime TURN for NAT traversal.

### Concepts to model now, implement later

- **Ladder**: rule/lookup → local distilled model → Jev → Groq → Claude → human quest. Now: the interface, plus logging of every decision with its rung, cost, and confidence.
- **Fog-of-war memory**: rings of focus / recent / remembered; essence; memory salience (dwell time, friend activity, captures, edits, landmark status). Now: the data model and an eviction policy stub.
- **Fog in games**: a ruleset parameter. Knowledge is shared within scope; visibility is a game rule.
- **Two judges**: truth (layout and landmarks vs. captures) and taste (players choosing between variants, dwell, reuse). Now: event schemas and storage only.

## First killer use cases

1. **Explorable postcards**: walk somewhere great, get a stylized explorable diorama with your narration, share it by link.
2. **Capture the flag anywhere**: drop friends into a foggy real city for a 20-minute match.

Every postcard should be playable as an arena. Design data formats with that in mind.

## Milestones

### M0: Foundation (build this first, then stop for review)

- Monorepo, lint, typecheck, tests, CI.
- Core schemas: Fact, Feature, Cell, Bundle, Capsule, Scope, Ruleset, GeneratorDef, QuestionPack.
- Geometry DSL v0 and interpreter:
  - footprint extrusion
  - roofs (flat, gable, hip, shed)
  - window grids
  - a few simple props
  - golden tests proving determinism
- Ingest: fetch OSM buildings and roads for a small bounding box into Facts with `source: "osm"`.
- Edge: `TownDO` stores facts; bundles are built and cached in R2 by H3 cell.
- Client: enter a lat/lng and walk a stylized version of that neighborhood. Confidence drives the soft-vs-crisp look.

**Done when:** I can open a URL, type coordinates, and walk my neighborhood; reloads are identical; tests pass; it's deployed with wrangler.

### M1: Session and play

`SessionDO` signaling, WebRTC data channels, and TURN. Two browsers (one an iPad) see each other move. Capture-the-flag ruleset v0 with team fog.

### M2: Capture to postcard

Phone upload of video plus a GPS track. An agent job on a GPU plugin extracts frames, blurs faces and plates, and produces observations. Facts are written with `source: "capture"`. Capsule export with scope and a share-link viewer.

### M3: Intelligence

Model router with budget caps, building question pack v1 via Jev, observers, truth and taste eval sets, and ladder logging.

### Later

Always-on crawler plugin, essence decay, distilling ladder rungs onto the GPU laptop, kid accounts, backyard quests, what-if city sim, a public capsule directory.

## Non-goals for now

Photorealism, planet-wide pre-generation, a public community, native apps, anti-cheat, complex accounts.

## How to work

1. **Interview me first.** Read this brief, then ask me about anything ambiguous for M0, one question at a time. Record decisions as ADRs in `docs/adr/` and keep the glossary in `CONTEXT.md`. If the `grill-with-docs` skill is available, use it.
2. **Plan M0 as vertical slices**, each one demoable, and get my approval before coding. If `to-prd` and `to-issues` are available, use them to publish the plan.
3. **Build test-first** (use the `tdd` skill if available) with small commits. Keep `pnpm dev` running the client against local wrangler at all times.
4. **Prefer boring, well-supported libraries.** Ask before adding heavy dependencies.
5. **After each slice,** show me what works and what's next. Stop at the end of M0.
6. **If this brief is wrong somewhere,** say so and propose an ADR. Never silently diverge.

### Open questions to raise early

- H3 resolution for cells.
- DSL syntax: JSON vs. a small text format.
- Friend auth: magic links vs. passkeys.
- Whether capsules snapshot facts or reference them live.
