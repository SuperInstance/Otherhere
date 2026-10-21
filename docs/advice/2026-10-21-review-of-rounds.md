# Review: playtest rounds #27–#36 and the forest work (#21, #23)

_For the agent that wrote them. Read it all before your next round; every item has a file and line on `main` as of 2026-10-21 and a test that proves it's done._

## The short version

You are good at the thing that is hardest to teach. You play the real site, you measure before you fix, and you refuse to retry flakes away. Your F1 diagnosis (Playwright starving at ~1 fps under SwiftShader, not a moving button) was excellent. You keep display layers out of Bundles, you dispose GPU resources carefully, and CI was green on the head of every PR you merged.

What holds the project back is **closure**:

- Each round opens new feel work while known defects stay open. None of the seven forest-advice items is done.
- Several features shipped with a real bug in their error or concurrency path.
- One feature put a paid model call on a public, unauthenticated endpoint.
- Comments and tests claim more than the code does: "sealed", "deterministic", "gives up on that building", "this much and no more".

The fix is a working rhythm: finish and prove, then explore. That is in `working-agreement.md`.

## Fix first, in this order

Each item is its own small PR. Its title says what it fixes, and its test fails before the fix and passes after it.

### P0: correctness, cost and access

**1. A public GET can spend the capture budget.** `GET /api/towns/:town/vector` (`apps/edge/src/index.ts:153`) calls Jev through `placeJev` (`apps/edge/src/models.ts:88`, `town.ts:434`) on any cache miss, for any of the ~14M valid res-6 ids, including empty ocean Towns. It shares the `jev` daily cap with the photo gate and the capture Ladder, so a crawler can starve captures.

Also:

- Two concurrent misses both pay, because Durable Object input gates don't hold across an outgoing fetch.
- `invalidateEssence()` deletes the vector on every Fact write (`town.ts:196`), so the quantized state hash never saves a call.
- A cache hit still scans every Fact to compute that hash (`town.ts:391–420`).

_Do:_

- Compute vectors offline or behind `OPS_TOKEN`. Refuse Towns with no Features.
- Give place vectors their own budget key (`jev-place`).
- Single-flight the in-flight promise per Town.
- Stop deleting the vector in `invalidateEssence`; rely on the state hash.
- Cache the census.

_Test:_ an unauthenticated GET never reaches the router; two concurrent requests make one model call; an exhausted budget returns a clean 503.

**2. Gift mode hides what the user and the licence need.** `#hud.gift:not(.expanded) #status { max-height: 3em; overflow: hidden }` (`apps/client/src/style.css` near line 194) clips the status line mid-line. It hides:

- the `MISMATCHED` integrity line;
- the Sentinel-2 / Terrarium attribution, which invariant 8 requires to be visible;
- "N cells failed to load";
- the "newer generators" honesty notice.

`#coords-error` sits inside the hidden `#goto`. `.row.secondary` also hides the match and host buttons, the social next step that round set out to improve.

_Do:_ split the status into a gift tier (title, moment, attribution) and an always-visible tier (errors, mismatches, notices). Never clip text mid-line. Keep the match buttons visible.

_Test:_ e2e with `toBeVisible()` (not `toContainText`, which passes on clipped text) for the attribution, an error and the match buttons in gift mode.

**3. `World.reload` leaks a group when a Cell is reloaded while it loads.** `world.ts`, `reload()`: if the current state has no `group` (it is still loading, possibly carrying a `stale` group from an earlier reload), the function returns early and the pending `stale` group is dropped without being retired or disposed. The meshes stay in the scene and their memory is never freed. `load()` also resolves `this.cells.get(cell)` only on completion, so two loads in flight for one Cell write into one state and orphan the first group.

Related: `indexClearings()` runs while stale clearings are attached, and `retire` removes them without re-indexing, so the forest keeps the old buildings' clearings.

_Do:_ carry `stale` forward when reloading a loading Cell (or retire it), guard `load()` with a per-Cell generation counter, and re-index after retiring.

_Test:_ reload a Cell twice before the first load resolves. Assert that exactly one group is in `root` and that `dispose` was called for the rest.

**4. The status line is a screen-reader alarm.** `#status` is `aria-live="polite"` (`index.html:87`), and since #28 it refreshes every 500 ms with a ticking clock (`main.ts` around line 806). A screen reader announces it twice a second forever.

_Do:_ move the clock and weather into a separate element that is not a live region. Announce only meaningful changes: cells loaded, errors, quests.

**5. A walk import aborts on one slow building.** The observe timeout (`capture.ts:153`) rejects inside `learnFromWalk` and is never caught per building, so the whole import stops. The cells already sharpened are then never reloaded. A seek that times out can resolve the _next_ seek with a late `seeked` event (`capture.ts:43`). Unreadable frames never increment `done`.

_Do:_ wrap each send in try/catch and count failures; always reload the sharpened cells; ignore stale `seeked` events (check `currentTime` or use a token per seek).

### P1: honesty of tests and claims

**6. The postcard's pixel-identity contract was loosened after a red CI run.** Commit ae51d52 replaced `shared.equals(live)` with `expectIdentical(…, 1)` (`e2e/postcard.spec.ts:78`). That limits each channel difference to 1 but not how many pixels may differ, and it ignores alpha. A frame that is off by 1/255 everywhere passes. The "one-ulp fog rounding" explanation was not proven, and the difference began when #28 moved the fog constants into uniforms.

_Do:_ find the root cause (most likely uniform versus constant precision across contexts). Restore a byte-exact match, or cap the number of differing pixels and check alpha. Document the measured bound.

**7. Make the place-vector "seal" real.** The cache key is battery name + model pin + state hash, not a hash of `packs/place.v1.json`. Rewording a question without bumping `PLACE_BATTERY` passes CI and keeps serving old answers.

_Do:_ put `sha256(place.v1.json)` in the key and pin it in a test.

**8. Test what runs, not its mirror.** The wind's TSL shader is "mirrored" by `swayOffset` in `wind.ts`, but `swayOffset` is used only by tests, so the shader can drift unnoticed.

_Do:_ add a small render or readback test of the shader against `swayOffset`, or delete the mirror and test the shader's inputs and uniforms. Wrap `windTimeU` modulo a common period: float32 `sin(t·6.3)` jitters after hours in an open tab.

**9. Correct the comments.**

- `sky.ts:11` says the sky depends on "elapsed render time, never the wall clock". It sums rAF frame times, which _is_ wall time. Display-only, so harmless, but say so.
- `cloudOf()` (`atmosphere.ts:250`) re-derives cloud cover from `hazeScale` using constants copied from `sky.ts:349`. Pass `cloud` in `SkyView` and delete the inversion.

### P2: the forest advice (all still open)

Every item in `2026-10-19-forest-architecture.md` is still open. In `packages/core/src/forest/imagine.ts`:

- list-position thinning (`:159`);
- `Math.hypot` in a hashed comparison (`:151`);
- the two disagreeing biome defaults (`:121` vs `essence/compute.ts:120–142`);
- one meadow suppressing the wild fill (`:88–92`);
- the hexagon edge band on `wild:` zones (`:190`);
- constants outside the content address;
- imagined trees still baked into Bundles (`bundle/build.ts:70`; 1.57 MB per empty wild Cell).

Either do them (with an `INTERPRETER_VERSION` bump and a golden re-pin) or write an ADR saying why not. The advice README asks each PR to say which items it took. Only #30 mentioned the advice, to defer it.

### P3: tooling and housekeeping

- **One probe, not eleven.** `apps/client/playtest/` has 11 scripts (2,565 lines). `funA-walk.mjs` (778 lines) is `probe.mjs` with a 33-line difference. Fold the variants into `probe.mjs` behind flags (`--scene`, `--click-budget`, `--out`).
- **No machine paths.** Remove `/home/z/...` (`verify-postcard.mjs:55`, `wake-shots.mjs:23`) and the personal workers.dev default (`f1-postcard.mjs:28`). Take paths from arguments or environment, defaulting inside the repo's ignored `test-results/`.
- **Evidence a reader can check.** Notes cite `otherhere-lab/playtest-artifacts/`, which isn't in the repo. Commit small curated evidence (a few PNGs under 200 KB each) beside each note, or upload CI artifacts and link them.
- **One numbering.** #36 says "r5", the file is `enjoyability-r3`, its heading says "round 3" and the branches say r3/r4/r5. Use one round number everywhere.
- **Move `windFloor` out of core.** It's a display-only tuning value living in `packages/core/src/forest/species.ts:76`, beside data the generators read. Keep client tuning in the client.

## What to keep doing

- Play the live site, at street level and on a phone, every round.
- Measure first. The F1 investigation is the model: a hypothesis, an instrument, a number, then the fix.
- Keep everything time-based on the freezable clock, so postcards freeze it too.
- Give each feature real behavioural tests (the edge spend and invalidation tests, the sky astronomy tests).
- Explain the reasoning in commit bodies. Keep that, and make the subject plain (see the working agreement).
