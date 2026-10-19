# Delegation: drafting with cheaper models, triage with Jev

How we hand coding work to cheaper models and check it before anyone reads it closely. This is a process to evolve: change it when the log says something works better, and record why here. The evidence lives in `packages/models/tuning/delegate-log.jsonl` (one line per call: model, tokens, cache hits, reasoning tokens, finish reason, cost, seconds, files).

## The loop

1. **Spec.** Write the task as a file: the exact API (types and signatures), the data formats, the failure behaviour, the memory rules, and the style to match. Vague specs come back as plausible but wrong code. Name the one file to write.
2. **Checklist.** Turn every requirement that matters into a literal claim about code ("Evicting a tile calls dispose() on its geometry."), one per line, `id: claim`. Write it before the drafts come back so it isn't shaped by them.
3. **Draft.** `scripts/delegate.ts --task task.md --out <scratch> [--model …] <context files…>`. Context files go first, in sorted order, then the task: the same files make the same prefix, so later tasks over them hit the provider's prompt cache. Output is only written to the scratch directory as text and never run (invariant 3).
4. **Triage.** `scripts/jev-spec-check.ts checklist.txt <draft files…>`: Jev scores each claim for each draft in one call (well under a cent). Read the low scores first. With two drafts from different model families, compare them claim by claim.
5. **Review and adopt.** Read the draft, fix what the triage and the type checker find, copy it in, and run the usual checks. Then `scripts/jev-review.ts` on the branch diff for the invariants.
6. **Log the lesson** below if the run taught anything.

## Providers

| Model                   | Endpoint                            | Notes                                                                                                                        |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `deepseek-flash` (V4.1) | api.deepseek.com, OpenAI-compatible | 1M context. Automatic prefix caching; hits cost a tenth. Reasons before answering, and reasoning counts toward `max_tokens`. |
| `MiniMax-M3`            | api.minimax.io, OpenAI-compatible   | Token Plan, rolling hourly rate limit (429 "2062"). Inline `<think>` blocks are stripped.                                    |
| `glm-*`                 | api.z.ai coding endpoint            | October 2026: every model answers "1113 Insufficient balance". Re-check before relying on it.                                |

## Lessons

- **Give reasoning models room.** The first terrain draft from `deepseek-flash` used all 32,000 output tokens on hidden reasoning and returned no content (`finish: length`). `max_tokens` is now 160,000, and the log records reasoning tokens and the finish reason so this shows up at once.
- **Stream long generations.** MiniMax-M3's first terrain draft died at Node's 300-second headers timeout: a non-streamed reply sends no headers until it is finished. `delegate.ts` now streams (server-sent events) and reads usage from the last event.
- **A literal checklist catches what a skim misses.** On the terrain spec, Jev scored DeepSeek's draft at 0.57 or higher on all 19 claims, and MiniMax's at 0.05 on `per_vertex_projection`: it placed vertices with a flat metres-per-degree scale. Reading the file confirmed it. Cost: $0.0005 per draft.
- **But the checklist only checks what it names.** DeepSeek's draft passed every claim and still had three real bugs: fallback tiles overlapping finer ones, vertex rows even in latitude rather than Mercator y, and a half-pixel sampling offset. A spec claim for each would have caught them; they are in the checklist now for next time.
- **Use a second model as a reviewer, not just a writer.** `deepseek-flash` given the changed files and a review prompt ("find real bugs; severity, scenario, minimal fix; no style") returned 11 findings for $0.015. Five were real and fixed; one I first dismissed (the walker following fine heights while a coarse tile is drawn) turned out to be the cause of the camera ending up inside hills, found later in the browser. Take "medium" review findings about mismatched sources of truth seriously.
- **Models notice wrong hints when the task invites notes.** I gave MiniMax a wrong expected tile for Sitka (655/1149; it is 508/1253). It computed the right value, used it, and said why in its notes. Keep asking for an assumptions section.
- **Verify in a real browser at the real place.** Unit tests and both reviews passed while buildings were buried: `ready()` timed out on slow tiles and snapped them to coarse ground. Only screenshots of Sitka showed it. Cells now stand again when finer ground arrives.

- **Small, sharply specified modules come back nearly ready.** The atmosphere spec (exact API, colours, formulas, cost budget) came back from `deepseek-flash` in 82 s for $0.007, type-checked first time and scored ≥0.90 on every Jev claim. Its notes caught an integration bug in our own spec: a 50 km sky dome outside the camera's 40 km far plane.
- **Models write against old typings.** MiniMax-M3 typed TSL values as bare `Node`; three 0.186's typings are generic (`Node<'float'>`, `Node<'vec3'>`). Put the exact type names in the spec.
- **"Cheap noise" needs a look before it ships.** The ocean draft's product of two axis-aligned sines turned the shore into a 3 m checkerboard. Incommensurate, rotated, drifting sines read as natural. Only a screenshot shows this; no checklist would.
- **Jev hedges on equivalent formulas.** `dispersion` scored 0.66 because the draft wrote ω = √(gk), not the spec's c = √(gλ/2π). Same physics. A middling score on a maths claim means "check it", not "it's wrong".

- **Pure modules delegate best.** The arrival glide (no three.js, a fixed `Pose` type, exact easing formulas) came back from `deepseek-flash` in 61 s for $0.005, type-checked first time and passed 4 tests written afterwards. Shader code needs a look in the browser; plain maths needs only tests.
- **Jev flags products it shouldn't.** On the mountain shaders, `no_checker` scored 0.14 although every pattern was a sum of rotated sines; the multiplications it saw were envelopes and masks. Phrase pattern claims as "the noise is a sum of…", not "nothing multiplies…".
- **Tune looks in the browser, not in the spec.** Mist at the specified strength read as white camouflage blobs; at about half strength with a wider ramp it read as mist. Specs should give a range and let the screenshot decide.

## Costs so far

| Run                                                | Model          | Seconds | Cost       |
| -------------------------------------------------- | -------------- | ------- | ---------- |
| Terrain module draft (951 lines)                   | deepseek-flash | 194     | $0.0155    |
| Terrain module draft (1,003 lines, for comparison) | MiniMax-M3     | ~700    | Token Plan |
| Review of the terrain integration                  | deepseek-flash | 198     | $0.0146    |
| Terrain unit tests                                 | MiniMax-M3     | 736     | Token Plan |
| Spec triage, both drafts                           | Jev            | <5      | $0.0009    |
