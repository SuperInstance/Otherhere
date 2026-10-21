# Round 07 — the status line says what it must, where it must

## Played

Production at both sizes before any change. Desktop 1280×800, walk scene (`r7-live-desktop`): arrival settled 10.8 s, 7/7 verified, 1525 features, 0 console errors, 0 failed requests; four walk legs to 10 ready / 2 sketch, 2049 features; demo lot; goto Lincoln Street (settle 22.0 s); the postcard save was cut by my own 580 s tool guard (a tool limit, as in round 6). Phone 390×844 (`r7-live-phone`): full scene, goto settle 17 s; the compact HUD showed **only the clock line** — the 1.5em clip hid the attribution, the sketch notice and the quests. Postcard scene (`r7-live-postcard`): gift mode's `#status` textContent carried 6 lines, ~2.5 visible under the 3em clip. After merge: `/api/health` ok, the deployed HTML carries the new tiers, and a verification postcard run plus a phone-size opening confirmed the after state (`gift-after.png`, `phone-gift-after.png`).

## Found

- The phone panel clipped the status to one line and the gift panel to ~2.5: the Sentinel-2/Terrarium attribution (invariant 8), `MISMATCHED`, failed-cell errors and notices sat below the fold (#41, fixed).
- The bare `.row.secondary` hide took the match buttons with the address box's (#41, fixed).
- `#status` announced to screen readers twice a second, forever (#43, fixed).
- `World.reload` dropped and leaked groups through reload chains (#42, fixed).
- The postcard pin read 21.89 against a 23.08 form-open sky on a lagging software clock — instrument question, filed as #51.
- Phone-size HUD input starvation: the postcard title `fill()` timed out at 30 s under SwiftShader (#52).
- `?c=` and `?s=` are mutually exclusive in `parseStart`, so a postcard cannot open as a match arena (#53).

## Fixed

- **PR #45 — `client: gift mode shows the moment, the licence and the problems`** (#41): three status tiers, one span per line — moment (title, clock, attribution) and problems/notices always visible; counts a whole tier behind More options; no line is ever cut mid-line; the match section keeps its buttons.
- **PR #46 — `client: World.reload carries its screen through, and disposes what it drops`** (#42): stale and in-flight wakes ride reload chains; each load is tagged with its state, so superseded loads dispose their own geometry; `retire()` re-indexes clearings.
- **PR #47 — `client: the status line announces changes, not the clock`** (#43): tiers are written only when their lines change; the counts tier announces cell landings (`aria-live=polite`).

## Measured

- Live-region mutations in a settled 2.6 s window: **5 before #47, 0 after** (MutationObserver e2e).
- Reload chain on one Cell: **3 groups + 3 beacon sets on main; 1 + 1 after #46**, superseded geometry disposed (spied `BufferGeometry.dispose`).
- Phone match: `match-invite` hidden on main, visible after #45 (fails-before reproduced by stashing the source, keeping the test).
- Gift mode on production after deploy: title, moment, attribution and the quests notice all visible and uncut; the quests line wraps to two lines at 390 px and is fully visible (measured in-page: `horizontallyClipped: false`, tier `overflow: visible`); counts `display: none` behind More options.
- Suites: 306 tests on fresh main → **315 green** on the round's head (+6 status-tier, +2 reload, +1 write-on-change); e2e +1 spec, +1 phone-match test. The two pixel-determinism specs stay #40-red in this container exactly as on pristine main; CI green on every PR head, GitGuardian included.

## Next

1. **P1 #6 — pin the postcard's pixel-identity contract** (#48): root-cause the uniform-vs-constant fog difference, restore byte-exactness or cap differing pixels and check alpha, document the measured bound.
2. **P1 #7 — make the place-vector seal real** (#49): `sha256(place.v1.json)` in the cache key, pinned by a test.
3. **P1 #8 — test the wind shader that runs** (#50): readback test against `swayOffset` (or delete the mirror), wrap `windTimeU` modulo a common period.

Also open: #51 (pinned-hour instrument), #52 (phone HUD input starvation), #53 (postcards as arenas — URL grammar), #40 (e2e determinism in the dev container). Needed from the owner: the production `OPS_TOKEN` value (or one run of `POST /api/ops/towns/<town>/vector` per town) to re-establish the two vectors retired with the old meta key — each re-ask costs ~$0.00003.
