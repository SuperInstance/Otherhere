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
| 09    | 11.8 s           | 10.1 s        | after the round's merges; byte-exact reloads restored  |

## Tests

| Round | Client | Core | Edge | Models | Agent | Judge | E2e specs passing |
| ----- | ------ | ---- | ---- | ------ | ----- | ----- | ----------------- |
| 07    | 90     | 130  | 51   | 36     | 4     | 4     | 12                |
| 08    | 104    | 130  | 51   | 36     | 4     | 4     | 14                |
| 09    | 109    | 131  | 52   | 36     | 4     | 4     | 16                |
| 10    | 110    | 123  | 55   | 36     | 4     | 4     | 17                |
| 11    | 113    | 123  | 56   | 36     | 4     | 4     | 17                |
| 13    | 127    | 133  | 56   | 36     | 4     | 4     | 20                |

Round 09 e2e: the pixel-determinism specs (#40, #48) are green again — the
scene's one freezable clock plus full display settle gates. The two pixel
specs cost 5.5–6.4 m each under software GL (a full display settle is ~150 s
per load at ~1 fps); CI's rendering is far faster.

## Bundle bytes per wild Cell

| Round           | Value   | Notes                                                      |
| --------------- | ------- | ---------------------------------------------------------- |
| pre-forest-move | 1.57 MB | measured in `2026-10-19-forest-architecture.md`            |
| 10              | 1,836 B | the forest move (ADR-0017 amended): 0 Features, 6 vertices |

A Cell with six observed trees measures 51,684 B — the observations are the
whole payload now. The landcover rings and species mix ride in the GLB extras
(covered by the inputs hash); the trees themselves are instanced client-side.

## Deploy

| Round | Health                | Home               | Changes live (bundle grep)                                          |
| ----- | --------------------- | ------------------ | ------------------------------------------------------------------- |
| 08    | ok, interpreter 0.5.0 | 200 in 0.42–0.49 s | all three round PRs verified in the served asset and HTML           |
| 09    | ok, interpreter 0.5.0 | 200 in 0.05–0.47 s | determinism probe byte-equal across two fresh contexts              |
| 10    | ok, interpreter 0.6.0 | 200 in 0.39 s      | wild Cell GLB parsed live: 0 gen: ranges, mix in extras             |
| 13    | ok, interpreter 0.6.0 | 200 in 0.34 s      | crown law holds on deployed bytes; Sitka rebuilt (7 % of roof band) |
