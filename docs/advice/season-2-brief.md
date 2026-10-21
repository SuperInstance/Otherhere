# Season 2: from a good demo to a place people return to

_The standing mission after rounds 06–07. It replaces the phase plan in `long-run-brief.md`; the guardrails, the round and the definition of done there and in `working-agreement.md` still apply._

Season 1 made Sitka exist: real ground, sky, sea, forest, weather and a fly-in. Season 2 makes it **worth coming back to**:

- a world that is right (closed defects, honest tests);
- light enough for a phone;
- built from place-true assets;
- with a reason to play, and a reason to bring a friend.

Work in **arcs**. An arc is several rounds toward one measurable outcome. Finish an arc before starting the next, and keep each round's rhythm.

## Arc 0: zero debt (start here)

The outcome: every P0 and P1 item and every open `bug` issue is closed. Specifically:

- **The P0s:** walk-import timeouts; the rest of gift mode; the `#status-cells` live region (`2026-10-21-review-rounds-06-07.md`).
- **The races and contracts:** #40, the display-settled race, then the byte-exact walk spec; #48, the postcard pixel contract; #49, the place-vector seal; #50, testing the wind shader that actually runs.
- **The forest advice:** `2026-10-19-forest-architecture.md`. Move imagined trees from Bundles to the display forest, or write an ADR saying why not and do the remaining items. Measure Bundle bytes per wild Cell before and after; the target is under 50 KB, down from 1.57 MB.

**Done when** `gh issue list --label bug` is empty, every review item is closed or answered by an ADR, and the walk and postcard specs are byte-exact again.

## Arc 1: a budget you can feel

The outcome: the first view in Sitka loads quickly on a phone and walking is smooth.

- **Build a performance harness first:**
  - a probe mode that records first-view time, frame time (p50/p95), draw calls, triangles, GPU memory estimate and network bytes, at desktop and 390 px;
  - write the results to `docs/metrics.md` each round (a table: round, metric, value);
  - put a smoke version in CI that fails on a large regression.
- **Then automatic quality steps**, driven by measured frame time rather than device guesses. In order: forest radius and budget → terrain `maxTiles` → mist and cloud shadows → pixel ratio.
- **Then the transfer budget:** Bundle bytes per Cell, tile bytes per view, and HTTP caching headers on the edge.

**Done when** `docs/metrics.md` shows first view under 4 s on a fast connection and p95 frame time under 33 ms on the 390 px software probe, or the best the harness can show with an explanation.

## Arc 2: places that look like themselves

The outcome: a stranger can tell Sitka from Zürich from street level, before anyone has taken a photo.

- **Regional priors in Essence**, per the roadmap. Southeast Alaska: steep gable and shed roofs, metal roofing, painted wood siding. Small `building=yes` footprints get pitched roofs. Quantized and hashed; bump the generator version and re-pin the golden.
- **Generated landmarks.**
  - Add DSL ops: lathe/onion dome, drum, stepped spire, bell-cast roof.
  - A model writes a generator (JSON) from public photos and a description; Jev checks it against a checklist.
  - It enters through a capture-ranked Fact that references the generator ID, versioned, with a human approval step before it is public.
  - First landmark: St. Michael's Cathedral, Sitka. Then the Russian Bishop's House and Castle Hill.
- **Before and after screenshots** at the same poses, committed with each change.

**Done when** the cathedral stands in Sitka from a generated generator, and a side-by-side of Sitka and Zürich streets is in the round note.

## Arc 3: a reason to play

The outcome: a first-time visitor has something to do in the first two minutes, and a reason to come back.

- **Quests that pay off.** Photographing a beaconed building already sharpens it. Make that visible and rewarding: a short "this building is now known" moment, a neighbourhood completion meter, and a postcard that shows what you sharpened.
- **A daily thing to do**, seeded by date, deterministic and shared: "today's three buildings in Sitka".
- **Matches people can start.** Fix #53 (a postcard can't open as a match arena). Make the host button reachable everywhere, and show a friend's presence before the fog hides them.
- **Never make the player hunt:** onboarding hints that disappear once used, and a visible cue when a Cell is waiting on OpenStreetMap.

**Done when** a fresh probe session completes a quest, sees the reward, saves a postcard and opens it as a gift, and a two-browser match starts from a shared link. All of it runs as e2e.

## Arc 4: trust and reach

- **Accessibility:** keyboard-only play, screen-reader announcements for meaningful events only, reduced motion (no twinkle or sway), contrast checks.
- **Offline and installable:** a PWA with cached Bundles for visited Cells, so a walk in Sitka works with bad signal.
- **Observability:** client errors reported to an edge endpoint, rate-limited and without personal data, plus a `/api/ops/health` view of error rates, spend and cache hit rates.
- **Ten towns:** run the probe on ten real places (dense city, village, island, desert, mountain, snow, tropics) and fix what breaks.

## How to go further, faster

- **Run lanes in parallel.** Within a round, split independent work across sub-agents or parallel sessions: one fixing, one measuring, one drafting with a cheaper model. Merge sequentially, each on green CI.
- **Delegate drafts, keep judgment.** Use `deepseek-flash` or `MiniMax-M3` for drafts and adversarial reviews (`docs/notes/delegation.md`), and Jev for spec checks. Read every line before it lands, and log costs in the delegation notes.
- **Review yourself adversarially before each merge.** Ask a cheap model "find real bugs: severity, scenario, minimal fix" on your diff. Fix what is real; note what you rejected and why.
- **Keep the scoreboard.** `docs/metrics.md` (numbers) and the GitHub issues (closed vs opened per round) are how progress is judged. A round with no numbers moving is a round to rethink.
- **Ask before:**
  - architectural changes that contradict an ADR;
  - deleting data;
  - changing secrets, deploys or domains;
  - adding paid services;
  - spending more than $1 of model calls in a round.

  Otherwise, keep going: finish an arc, then start the next.
