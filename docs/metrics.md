# Metrics — the Season 2 scoreboard

_One table per metric, one row per round. Arc 1 builds the harness that fills
these automatically (a probe mode recording first view, frame p50/p95, draw
calls, triangles, GPU memory and network bytes at desktop and 390 px, plus a CI
smoke gate). Until it lands, the rows below are the honest numbers the round's
probe runs and test suites produced by hand. Software-GL container timings are
slow by design; the harness will separate device from code._

## First view (probe walk scene, settle to 7 Cells in Sitka)

Software GL in the dev container — an upper bound, not the phone target.

| Round | Desktop 1280×800 | Phone 390×844 | Notes                                                  |
| ----- | ---------------- | ------------- | ------------------------------------------------------ |
| 08    | 22.2 s           | 17.0 s        | before any change; 17 s again after the round's merges |

## Tests

| Round | Client | Core | Edge | Models | Agent | Judge | E2e specs passing |
| ----- | ------ | ---- | ---- | ------ | ----- | ----- | ----------------- |
| 07    | 90     | 130  | 51   | 36     | 4     | 4     | 12                |
| 08    | 104    | 130  | 51   | 36     | 4     | 4     | 14                |

Round 08 e2e: `gift.spec.ts` and the second `status.spec.ts` case are new; the
two pixel-determinism specs (#40, #48) fail in the container on clean main and
pass in CI — the settle race is next.

## Bundle bytes per wild Cell

| Round           | Value   | Notes                                           |
| --------------- | ------- | ----------------------------------------------- |
| pre-forest-move | 1.57 MB | measured in `2026-10-19-forest-architecture.md` |
| target          | < 50 KB | the forest move, Arc 0                          |

## Deploy

| Round | Health                | Home               | Changes live (bundle grep)                                |
| ----- | --------------------- | ------------------ | --------------------------------------------------------- |
| 08    | ok, interpreter 0.5.0 | 200 in 0.42–0.49 s | all three round PRs verified in the served asset and HTML |
