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

| Model                   | Endpoint                                | Notes                                                                                                                         |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `deepseek-flash` (V4.1) | api.deepseek.com, OpenAI-compatible     | 1M context. Automatic prefix caching; hits cost a tenth. Reasons before answering, and reasoning counts toward `max_tokens`. |
| `MiniMax-M3`            | api.minimax.io, OpenAI-compatible       | Token Plan, rolling hourly rate limit (429 "2062"). Inline `<think>` blocks are stripped.                                     |
| `glm-*`                 | api.z.ai coding endpoint                | October 2026: every model answers "1113 Insufficient balance". Re-check before relying on it.                                 |

## Lessons

- **Give reasoning models room.** The first terrain draft from `deepseek-flash` used all 32,000 output tokens on hidden reasoning and returned no content (`finish: length`). `max_tokens` is now 160,000, and the log records reasoning tokens and the finish reason so this shows up at once.
