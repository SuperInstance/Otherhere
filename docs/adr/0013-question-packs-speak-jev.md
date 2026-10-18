---
status: accepted
---

# Question packs use TypeSafe's question shapes; vision stays a separate rung (for now)

Question packs are a **Published Language** we share with TypeSafe Jev, so their schema matches Jev's API exactly:

- `choice` criteria are a map from option name to description (1–255 options);
- `noul` criteria are `{ true, false }` descriptions, and the answer is a probability of "yes";
- `score` criteria are an ordered list of 1–10 level descriptions, and the answer is a probability-weighted level.

Packs can then be sent to Jev without translation, and other rungs (rules, distilled models, an LLM) must answer in the same shape.

**The brief is out of date here:** it says Jev "does not accept images, so the vision step comes first". Jev now accepts image `assets` and `box` questions behind a `TypeSafe-Danger-Zone-Images: true` header. We keep vision → structured observation → Jev as the default path, because the observation text is loggable, cacheable, replayable in evals, and model-agnostic, and because the image path is explicitly a "danger zone" preview. A direct-image Jev rung is a candidate to evaluate against the truth judge once it is stable.

Accepted by the project owner on 2026-10-18.
