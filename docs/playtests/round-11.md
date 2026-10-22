# Round 11 — the reload path's three leaks, closed

Three small PRs from the rounds 06–07 review's list: the double-reload wake leak (#60), the observe route's raw provider errors (#59), and the probe's silent viewport fallback (#61). All three issues closed.

## Played

Production (`https://otherhere.superinstance.dev`) after the round's merges: the sketch scene probe at Sitka, desktop (`r11-verify*`, evidence in `round-11/`) — 0 page errors, 0 console errors, 0 failed requests; health `{"ok":true,"interpreter":"0.6.0"}`, home 200 in 0.34 s.

## Found

- A reload landing while an earlier wake still breathed carried that wake to the new state, and the new Bundle's own wake then overwrote `state.wake` without disposing the carried material — one leaked shader program per double reload, forever.
- A queued load whose state a later reload replaced still ran when its turn came: a fetch and a build the state check at landing would throw away.
- The photo route answered every provider failure with 502 plus the error's own message in the body — upstream detail that is not ours to show, and the wrong status for the classes that are not the photo's fault.
- `--viewport garbage` played as 1280×800 with the intended string recorded nowhere.

## Fixed

- **#71 `client: a double reload disposes the interrupted wake and skips superseded loads (#60)`** — the landing hands the carried wake back before installing its own; the pump skips superseded jobs at pop time (in-flight loads still complete and discard — cancelling a started fetch needs abort plumbing through the API path, left for that round); and the missing retire test: a moved house's stale clearing stops suppressing growth, proven with a one-house lot that moves 40 m.
- **#72 `edge: observe provider errors map to safe 502/503 bodies (#59)`** — the class decides: budget → 503 with the ledger's numbers; provider 429/503 → 503 "unavailable"; anything else → a bare 502. The operator reads the detail in the tail; the player never sees provider text. The fake vision provider learned failure markers (`UNAVAILABLE99`, `NETWORK99`) so each class is tested end to end.
- **#73 `playtest: a malformed --viewport fails loudly (#61)`** — the flag validates its own shape and exits 2 with the offending value before any page opens.

Each fix's test was verified red without the fix and green with it. Adversarial review on #71 (DeepSeek-V4.1-Flash on DeepInfra, $0.004) argued the two fixes were mutually exclusive; it could not see `reload()`'s pre-existing wake carry, and the red-before runs are the proof both fire.

## Measured

- Client unit tests: 110 → **113** (double wake, superseded fetch, retire re-index). Edge: 55 → **56** (error mapping). Core 123, models 36, agent 4, judge 4 — **336 total**.
- E2e: fast 15 specs locally on #71's branch; both pixel specs and the full suite green on CI for every merged head.
- Model spend this round: two adversarial reviews ($0.004 + $0.005). Total **under $0.01**.

## Next

1. **#66** — crown-motion readback to pin the wind shader to its spec (`swayOffset`), Arc 1's first probe law.
2. **#52** — phone-size HUD input starvation under software GL; **#53** — a postcard as a match arena (`?c=`/`?s=`); **#51** — the frozen-clock instrument for the pinned-hour postcard.
3. An R&D round between build rounds: `see.mjs` readings over a scene corpus, and the place-vector retrieval matrix (which axis separates Sitka from Zürich) — Arc 3's substrate.
