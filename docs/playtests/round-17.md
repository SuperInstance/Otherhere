# Round 17 — the mesh stands on its building: the generated tier, in the running game

Two PRs. One with the asset and the map for the renderer; one with the note. The subject is the
`model` tier — the client's fourth tier, a real triangle mesh. It had been built and proved
decodable, but **no place file had ever asked for one**, so the game's own world had never
fetched a mesh.

## Played

The game on the ProArt (WSL2, RTX 4050, 6 GB), `wrangler dev` on `:8788`, the Sitka place baked
into the client, a real Chromium at 1280×800 under software GL.

**One probe, six standings.** The probe stands at a saved pose — the client's own pose format
(`#x,y,z,yaw,pitch`) — and takes one frame with the HUD hidden. Each pose is 142 m from the
cathedral's footprint centroid unless it says otherwise, and the probe records **which asset
tier the game fetched for that pose**, by name and by HTTP status.

| pose                          | distance from the centroid | tier the game fetched | status | frame  |
| ----------------------------- | -------------------------- | --------------------- | ------ | ------ |
| `51.30,1.7,381.95,-0.1868,0`  | 138 m                      | `splat`               | 200    | 108 KB |
| `50.56,1.7,385.89,-0.1868,0`  | 142 m                      | `model`               | 200    | 70 KB  |
| `76.93,1.7,388.35,0.0000,0`   | 142 m, bearing 180°        | `model`               | 200    | 51 KB  |
| `28.36,1.7,379.79,-0.3491,0`  | 142 m, bearing 200°        | `model`               | 200    | 95 KB  |
| `-4.52,1.7,362.67,-0.6109,0`  | 142 m, bearing 215°        | `model`               | 200    | 71 KB  |
| `-56.51,1.7,294.92,-1.2217,0` | 142 m, bearing 250°        | `model`               | 200    | 80 KB  |

**The A/B that matters is the first two rows: the same bearing, 4 m apart.** The ladder is
`SPLAT_NEAR_M = 140`, and the client's distance is measured to the capture's footprint
centroid — so 138 m draws the gaussian field and 142 m draws the mesh, in the same direction,
from the same place, in the same run of the game. **6/6** runs: `ready 7, verified 7,
mismatched 0, errors 0`, and **0** page errors, HTTP errors or failed requests.

**And the vibe.** The probe's own walk scene, on the same baked place, from arrival to a saved
postcard and the postcard opened again: `arrival-settled`, `walk-1`, `walk-2`, `after-walk`,
`goto-lincoln-st` (the address jump to Lincoln Street), `postcard-saved`, `postcard-opened`.
`walk-session.json` is that session's raw log.

**The walk fetched no asset tier at all** — and that is a finding, not an oversight. The
cathedral's capture lives in the Cell at the far end of the place, and the walk never gets
there: the seven Cells it lands are the town's, and the capture's Cell is not among them. The
tier is proved by standing at it, not by walking to it, and the walk's job is only to show what
the game feels like.

Evidence in `round-17/`: `tier-splat-138m` and `tier-model-142m` (the A/B), `tier-model-b180`
… `-b250` (the mesh from four more bearings), the seven walk frames, `walk-session.json`, and
`tier-ladder.json` — the six standings, machine-readable, with every stat and every pose.

## Found

- **The client fetches a mesh.** For the first time: the place file named a `model` tier, the
  game asked for it by URL, the capture service answered **200**, the payload's sha256 matched
  the place file's, and the client drew it. Five bearings and a sixth at 138 m, all clean.
- **The mesh is fetched, verified and drawn — and it is still not legible.** At 142 m the
  cathedral's mesh is behind the town's hill from most bearings, or a few dozen pixels where
  it is not. The frames in `round-17/` show the town, the road, the spires and the mesh's
  absence where the cathedral should be; they do **not** show a recognisable church. The
  placement is proved by the transform's own check and by the one-renderer silhouette match,
  **not** by a photograph of the building with the mesh on it. This is the round's honest
  negative and it is not a small one: the tier is correct, verifiable and invisible.
- **ADR-0023's ladder sentence and the code did not match — and neither did the three other
  places it was written.** The ADR said "splat near, model next, photographs beyond";
  `chooseTier` returns the mesh at _any_ distance at or beyond 140 m, so once a capture has a
  mesh the photograph is never shown again. The code's own sentence was the defensible one —
  "it outranks the impostor wherever it exists" — so the ADR's phrase was the loose one. The
  same phrase was also in **`AGENTS.md`** (the instructions an agent reads before touching an
  asset), in **`docs/proart-handoff.md`** (the map for the renderer) and in **two doc comments
  on `chooseTier` and `SPLAT_NEAR_M`**, in the code itself. All four are now corrected to say
  what the code does. The behaviour is unchanged: a mesh at 1 km and a blurry photograph at
  1 km are both a dot, and the mesh is the better dot.
- **`probe.mjs --hash` silently did nothing.** The flag's own comment shows the pose with a
  leading `#` (`#x,y,z,yaw,pitch`) and the URL builder added another, so the client parsed
  `#x` as a number, got `NaN`, and fell back to the default pose — a no-op that looks like a
  pose. Found by playing from a saved pose and arriving somewhere else. Fixed in the probe,
  not the client: the client is right to ignore a malformed hash, and the tool was wrong to
  build one.
- **The probe could not open a baked place at all.** It only had `--at`, a coordinate lookup
  that goes out to Overpass — so it could never reach a place with asset tiers, which is
  every place that carries a capture. Added `--place`, and with it the `stand` scene.
- **The probe's screenshot timed out before the evidence could arrive.** Under software GL the
  world is still streaming terrain tiles when the moment comes, and the default 30 s was not
  enough — the session recorded `page.screenshot: Timeout 30000ms exceeded` and produced no
  frame. Raised to 180 s, and made overridable.

## Fixed

- **#111 `assets: the cathedral's mesh — a generated tier that stands where the building is`** —
  the `model` tier, framed into its capture's frame, baked into the place file beside the
  payload it vouches for by hash; and `docs/proart-handoff.md`, the map of the Thor for
  whoever works on the renderer. **Merged** on green CI.
- **#112 `Round 17: the mesh stands on its building — the generated tier, in the running game`** —
  `--hash` stops doubling its `#`; `--place` opens a baked place by name; `--scene stand` stands
  at one pose and takes one frame with the HUD hidden; every asset tier the game fetches is now
  a log row (`tier-fetch`) with its status; screenshots get 180 s. Plus this note, and the
  ladder sentence corrected in all four places it was written — ADR-0023, `AGENTS.md`,
  `docs/proart-handoff.md` and the two doc comments on the code.

## Measured

- **The mesh**: 169,132 B, 10,000 triangles targeted, 512 px WebP, `EXT_meshopt_compression`.
  Read back with three's own decoder: 11,135 vertices, 9,999 triangles, normals unit, UVs in
  range — **PASS**.
- **The framing**: base centre `[-1.153, 0, -15.894]` (the target, exactly), height
  **14.592 m** (the capture's `heightM`, exactly), front bearing **190.7°** (the capture's
  front azimuth, exactly).
- **The generator**: SPAR3D on one photograph, **31.9 s**, 10,576 MB peak VRAM, 10,326
  vertices / 55,332 indices before the finishing lane.
- **The lane**: the finishing lane 1.3 s, the frame-model bake 0.4 s, the publish seconds. The
  whole way from a photograph to a served tier: **under a minute**, 10.6 GB of VRAM at the
  peak.
- **The game**: 6/6 runs clean — 1 tier fetch each, always 200, `verified 7, mismatched 0,
errors 0`; settle 5.9–23.0 s; frames 51–108 KB.
- **The capture service**: 17 tiers, 4 place-vouched, **0 problems**.
- **Tests**: 477 pass (packages/assets 18, packages/core 166, packages/models 72,
  apps/client 157, apps/edge 56, apps/agent 4, packages/judge 4). Lint and typecheck green.

## Next

1. **The mesh tier's range.** It is only ever drawn at or beyond 140 m, where a 14.6 m
   building is a few dozen pixels and, from most bearings, behind the hill — and it now also
   replaces the impostor at every range. Either the ladder gets a third band (`model` near,
   `impostor` beyond), or the mesh is admitted into the near field and the splat kept for the
   first few metres. Both are design decisions, not bugs; this round reports the measurement
   and changes nothing.
2. **A close photograph of the cathedral with the mesh on it.** The placement is proved by the
   transform's own check and by the matched silhouette; it has not been proved by a frame
   taken from in front of the building, because the range the tier is drawn at does not put
   the building in front of the camera. The likely cause is the tier's range, not its
   placement — which makes (1) the thing to fix first.
3. **`frame-model` in the repo.** It is Thor-side pipeline code today and it reads the repo's
   own `localFrame` and cell centres. If the framing rule is to be enforced by a test rather
   than by a tool, the projection it depends on needs a home in `packages/core`.
4. **The probe should keep its evidence.** `tier-ladder.json` was assembled by hand from six
   session logs. The probe already writes a session JSON per run; teaching it to fold the tier
   rows into one machine-readable summary would make this round's evidence reproducible by
   running the probe twice.
5. **The probe cannot walk to a capture.** The walk scene strides in one direction for a few
   seconds from wherever the place starts, and the seven Cells it lands are the town's — the
   capture's Cell is not among them, so no tier is ever fetched and the cathedral is never in
   frame. A `--walk-to <feature>` that stands where a capture stands — the same arithmetic
   `stand` already has — would let the walk scene play the part that matters without walking
   there.
