# Working agreement for long-running agents

_How to work on Otherhere across many rounds without the reviewer. `AGENTS.md` is the system; this is the rhythm. When the two disagree, `AGENTS.md` and the ADRs win._

## The round

A round is a few hours of work ending in merged, deployed, verified changes and one short note.

1. **Start from `main`.** Pull, install, and run `pnpm lint && pnpm typecheck && pnpm -r test`. If anything is red, fixing it is the round.
2. **Read the queue**, in this order:
   1. open GitHub issues labelled `bug`;
   2. the newest review in `docs/advice/`;
   3. the "Next" section of your last round note.

   Take the highest item first. **No new feature work while a P0 or P1 item is open.**

3. **Play before you change anything.** Run the probe at desktop and phone size against production. Look at the screenshots, read the console, and note what a first-time player would trip on.
4. **Pick at most three changes** and make each one a separate PR. A round that merges two finished fixes beats one with five half-features.
5. **For each change**, follow the definition of done below.
6. **Close the round with a note** under `docs/playtests/` (format below), and open issues for everything you saw but didn't do.

## Definition of done (every PR)

- **It does one thing.** The title is a plain, scannable subject of at most 72 characters. Lead with the area: `client: keep match buttons visible in gift mode`, `edge: single-flight place vector requests`. Put the story in the body.
- **A test fails before the change and passes after.** For a bug, write the test first, watch it fail, then fix. For UI, assert what the user must _see_ (`toBeVisible`), not that text exists somewhere.
- **No test is weakened to get green.** If a tolerance or timeout must change, the PR body says what was measured and why the new bound is the real one.
- **Comments say what the code does, no more.** If something is enforced only by convention, say "by convention" and add a test that enforces it, or don't claim it.
- **Every error and concurrency path you add is handled.** Every timeout you add has a catch that leaves the user in a sensible state. Anything that can be called twice at once is single-flight or safe to repeat.
- **It holds the invariants** (`docs/BRIEF.md`). In particular:
  - Nothing reaches Bundle bytes without being in the content address.
  - No paid model call is reachable from unauthenticated traffic.
  - Every paid call goes through the `ModelRouter`, with its own budget key when it isn't the capture path.
- **It's checked in a browser** at the real place for anything visible: before and after screenshots, desktop and phone.
- **Local checks pass:** `pnpm lint`, `pnpm typecheck`, `pnpm -r test`, and `pnpm --filter @otherhere/client e2e` for client changes.
- **Merge only when every check on the head commit has completed green**, GitGuardian included. If another PR merged in the meantime, merge `main` in and let CI run again. Never merge two PRs within minutes of each other without CI on the combined code.
- **After merge, verify the deploy:** `/api/health`, then one probe run against production.

## Commit and PR style

- **Subject:** `area: what changed`, imperative mood, no metaphors. Areas: `client`, `edge`, `core`, `models`, `docs`, `playtest`, `ci`.
- **Body:** why, what was measured, what was tried and rejected. Metaphor is fine here if it helps.
- **One git identity.** Use the repository owner's configured name and email, not `Z User <z@container>`.
- **Write private shorthand out in full**, or define it in the round note's glossary ("F1", "lane", "seat", "plate").

## Tooling

- **One probe:** `apps/client/playtest/probe.mjs`, with flags for scene, viewport, click budget, output directory and base URL. Don't fork it; add a flag.
- **No machine-specific paths or personal domains.** Defaults resolve inside the repo (`test-results/`, which is git-ignored) and to `https://otherhere.superinstance.dev`.
- **Delegate drafting to cheaper models** where it fits (`docs/notes/delegation.md`): sharp spec, literal checklist, Jev triage, then read every line yourself.

## Round notes

One file per round: `docs/playtests/round-NN.md`, with NN numbered once and used everywhere (branch `playtest/round-NN`, PR title "Round NN: …"). The note has five short sections:

1. **Played:** what was played, where, on what device and viewport, with links to committed evidence (a few small PNGs in `docs/playtests/round-NN/`, each under 200 KB).
2. **Found:** each problem as one line: what a player would notice, its severity, and its cause if known.
3. **Fixed:** the PRs, one line each.
4. **Measured:** numbers, not scores. Frame time, load time, bytes, counts. Model-generated "beauty 8/10" scores don't count as evidence.
5. **Next:** the top three items for the next round, each as a linked GitHub issue with an acceptance check.

Keep it under ~600 words. The PRs hold the detail.

## When you disagree with advice

Advice in `docs/advice/` is a recommendation, not a law. If you think an item is wrong, write an ADR or a short reply note saying why, then do what the ADR decides. Don't let the item sit unanswered. Unanswered advice is the one outcome that helps nobody.
