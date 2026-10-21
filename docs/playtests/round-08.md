# Round 08 — Season 2 opens: the last P0, a finished gift, a quiet status line

Played before changing anything, fixed three review items, opened the leftovers.

## Played

Production (`https://otherhere.superinstance.dev`), the probe's walk scene, before and after:

- desktop 1280×800 and phone 390×844 before ([desktop](round-08/desktop-lincoln-st.png), [phone](round-08/phone-lincoln-st.png)), phone after merge ([final](round-08/after-merge-final.png));
- health `{"ok":true,"interpreter":"0.5.0"}`; home 200 in 0.42–0.49 s;
- both sizes: 7/7 bundle hashes verified, 0 MISMATCHED, 1,601 features, 13 quests, 1 sketch Cell retrying OSM;
- the sandbox reaper cut the desktop run's postcard step (background browsers are reaped ~40 s after a tool call returns — known law); the phone run completed the scene.

## Found

The three open P0s from the rounds 06-07 review, each verified in the code before fixing:

1. **P0 #5, the walk import aborts on one slow building** — an observe timeout rejects the whole import; sharpened Cells never reload; a late `seeked` settles the next seek; unreadable frames never count in `done`.
2. **Gift mode clips the error and the host button** — both lived inside `#goto`, which gift mode and the phone compact panel hide; a phone hides `#host` even outside gift mode.
3. **`#status-cells` over-announces** — a polite live region holding counters that change on every Cell landing: a running counter in the ear through every load and walk.

## Fixed

- **#56 `client: one slow building no longer aborts a walk import`** — `postObservation()` never throws (a failure is one building's, counted in `WalkProgress.failed`); `seek()` only accepts a landing within 0.05 s of its own target (samples are ≥ 4 s apart); unreadable frames count in `done` (`videoFrames` yields `{t, jpeg: null}`); `main.ts` reloads sharpened Cells in a `finally`.
- **#57 `client: a gift keeps the error, host button and licence visible`** — `#coords-error` and `#host-row` moved outside `#goto`; new `gift.spec.ts` at 390 px asserts `toBeVisible()` on the error (after collapsing More options), the host button, and the Elevation: Mapzen attribution — the spec serves a real Terrarium tile through `page.route`, so the licence line renders under e2e for the first time.
- **#58 `client: the routine counts fall silent, Loaded is said once`** — `#status-cells` is no longer a live region; `LoadAnnouncer` says "Loaded" once per quiet load (1.5 s debounce, a new burst cancels) into a visually hidden `#announce`.

Each PR: red before, green after (documented in the PR bodies); every check green on the head commit, GitGuardian included; main merged in and CI re-run before each follow-on merge.

## Measured

- Client unit tests: **90 → 104** (10 walk-import, 4 LoadAnnouncer). Full suite: 315 (core 130, client 104, edge 51, models 36, agent 4, judge 4).
- E2e: 14 specs pass; the two pixel-determinism specs (#40, #48) fail identically on clean main in this container (verified by stash + rerun) — they are the next Arc 0 work, not regressions.
- New `gift.spec.ts`: 10.5 s; new status spec: 24.9 s.
- Probe settle to 7 Cells: desktop 22.2 s, phone 17.0 s, after-merge phone 17 s (software GL; `docs/metrics.md` starts the Season 2 scoreboard with these).
- The deployed bundle serves all three changes (grep: `could not be observed`, `announce`; HTML: `host-row`, `announce`).
- Adversarial pre-merge review ran on a fallback model: the project's DeepSeek/MiniMax/Jev credentials were lost with the workspace recycle (`.env.local` gone). No real findings. Cost: $0 (own tooling).

## Next

1. **#40, the settle race** — expose a "display settled" signal (no chunks pending, no wakes running, no tiles in flight), wait for it plus N identical frames, diff the two PNGs to name the layer, then restore byte-exact `equals` and close **#48** the same way.
2. **#49, the place-vector seal** — `sha256(place.v1.json)` in the cache key, pinned in a test.
3. **#50, the wind shader** — test what runs (readback against `swayOffset`, or delete the mirror); wrap `windTimeU` modulo a common period.

Smaller review items filed this round as #59 (observe provider errors → 502/503), #60 (a reload's second wake leaks its material), #61 (probe `--viewport` fails loudly); #52 and #55 stand. The delegation credentials lost to the workspace recycle need restoring before the next round (DeepSeek/MiniMax/Jev keys, `.env.local`).

The forest move (imagined trees out of Bundles, under 50 KB per wild Cell from 1.57 MB) follows these, then Arc 1's harness.
