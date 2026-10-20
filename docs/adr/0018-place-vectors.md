---
status: proposed
---

# Place vectors: a Town's character as one fixed, versioned question battery

A **place vector** is the calibrated answer mass of a hand-designed question battery asked over a Town's deterministic statistics. It is the invisible lane's first instrument: background intelligence, computed from Facts the Town already holds, that the system can retrieve, compare and watch without touching anything a player sees. The design ports the measured laws of this team's JEV-as-embedder research program rather than re-deriving them:

- **The shortcut law.** One-shot LLM-_generated_ question sets collapse to surface shortcuts (measured 0.25, the majority baseline, in that program). Batteries are hand-designed, fixed and versioned.
- **The phrasing law.** Answer mass is lexically sensitive: synonym swaps move it by up to 2× the drift band, while reordering and reframing do not. So `place.v1`'s text is **byte-stable from the moment it was first asked** (the sealed round below). A rewording is a new battery version (`place.v2`), never an edit.
- **The drift band.** The same battery over the same state answers within ±0.10 across calls and sessions. The band is the instrument's noise floor; separations smaller than it are not separations.

## The battery (`pack.place` v1.0.0, sealed as `place.v1`)

Eleven questions — eight `noul` (probability of yes) and three `score` (probability-weighted rubric levels), no `choice`: `tall_for_a_town`, `steep_roofs`, `uniform_roofs`, `dense_not_spread`, `warm_earthy_walls`, `mostly_conifers`, `rainy_coast`, `heights_recorded`, `height_scale`, `known_in_detail`, `green_setting`. Every question asks only what the state can ground; each `false` criterion carries its own "too little recorded to say" branch, so an unknown place reads unknown rather than wrong.

The state is a deterministic serialization of the Town's **Essence** (already quantized, ADR-0014) plus a small **Fact census**: features by kind, the share of buildings with a known height/roof/colour, the share of trees with a known species, and Facts by source (captures are the human signal). Keys are sorted, numbers print through fixed formats, counts and shares are bucketed like Essence, so ordinary Fact writes rarely change the state text — and the battery is re-asked only when the place actually changed. `askPlaceVector` sends it through the `JevProvider` (pinned `jev-1.13.0`, ADR-0013's amendment) via the `ModelRouter` (invariant 9), and every answer carries the served model — the version canary.

## The sealed round (2026-10-20, 11 calls, $0.0007, `model_served: jev-1.13.0` on every call)

| question                | Zürich seed block, median (spread) | Sitka priors, median (spread) | separation | decoy |
| ----------------------- | ---------------------------------- | ----------------------------- | ---------- | ----- |
| tall_for_a_town         | 0.23 (0.01)                        | 0.08 (0.01)                   | 0.15       | 0.26  |
| steep_roofs             | 0.17 (0.02)                        | 0.91 (0.01)                   | **0.74**   | 0.37  |
| uniform_roofs           | 0.04 (0.01)                        | 0.97 (0.01)                   | **0.93**   | 0.25  |
| dense_not_spread        | 0.59 (0.02)                        | 0.33 (0.02)                   | 0.26       | 0.35  |
| warm_earthy_walls       | 0.71 (0.02)                        | 0.93 (0.01)                   | 0.22       | 0.26  |
| mostly_conifers         | 0.02 (0.00)                        | 0.98 (0.00)                   | **0.96**   | 0.29  |
| rainy_coast             | 0.06 (0.00)                        | 0.79 (0.02)                   | **0.73**   | 0.10  |
| heights_recorded        | 0.27 (0.09)                        | 0.91 (0.01)                   | 0.64       | 0.39  |
| height_scale (10 lvl)   | 4.27 (0.15)                        | 2.83 (0.19)                   | 1.44 lvl   | 2.49  |
| known_in_detail (5 lvl) | 1.54 (0.16)                        | 3.87 (0.08)                   | 2.33 lvl   | 0.00  |
| green_setting (5 lvl)   | 1.41 (0.05)                        | 2.07 (0.04)                   | 0.66 lvl   | 0.36  |

- **Drift band: held.** Every question's spread over 5 runs per state is within ±0.10 on the comparable 0–1 scale (max 0.09, on `heights_recorded`; score questions compared after rubric normalization, max 0.04).
- **Separation: real and in the expected directions.** Zürich reads flat-roofed, mixed, broadleaf, tall-ish and dense; Sitka reads gabled, uniform, conifer, coastal-rainforest and low. The strongest axes (`mostly_conifers` 0.96, `uniform_roofs` 0.93) are near band-edge-free.
- **Decoy: soft floor.** A nonsense state ("the frobnicated zix quibbles murpl") reads 0.10–0.39 on `noul` questions and 0.00–2.49 on scores — uncertain middles, never confident hallucination, but a softer floor than the ~0.02 the research program measured on document batteries. Recorded as an honest limit below.
- States: the Zürich block is the repo's seed fixture computed exactly as `TownDO.essence()` sees it (state sha `d722a81e…`); the Sitka state is **constructed** from the `pacific-rainforest` biome and ADR-0017's regional priors (low wooden buildings, ~70/25/5 hemlock/spruce/cedar), not recorded Sitka data (sha `1716b84a…`). The sealed baseline with every run, state text and canary lives at `packages/models/tuning/place-baseline.json`.

## Storage: the Essence's shadow, never a Bundle input

`TownDO.essenceVector()` computes lazily on first request after a write and stores under `meta['essence-vector:1']`, beside `essence:2`, carrying the battery version, the model pin, the served model (the canary) and the state's sha. The two keys move together: `invalidateEssence()` drops both, and the cache is only served when battery, pin and sha all still match, so a battery upgrade or a pin move re-asks exactly once per Town. `GET /api/towns/:town/vector` serves the public-safe vector (derived statistics of Facts; no user data, invariant 5).

**Place vectors never enter Bundle inputs.** They are Town metadata, like the Essence's shadow: not in `bundleInputsHash`, not in a generator's params, invisible to the client's content-address checks. Bundle determinism (invariant 2) is untouched by construction — answers are stored data, never executed (invariant 3), and a place vector failing to compute must never fail a Bundle.

## Uses

- **Similar-place retrieval** ("explore another place like this one"): compare normalized vectors across Towns — the round-1 separation axes are exactly the ones such a ranking would key on.
- **Quest-selection grounding**: a Town that reads `known_in_detail` low wants capture quests; one that reads high wants different attention.
- **The eventual player-knowledge model**: what a player has seen of which kinds of places, as a battery over their journey.

## The drift watch

The baseline is the anchor: re-run `pnpm --filter @otherhere/models place-vector` when the pin moves or `jev-latest` flips (typesafe announced a flip to 1.14.0 around 2026-10-21; this project pins 1.13.0 deliberately, but `model_served` is checked per call regardless), and compare against the sealed states' shas and answers. Cross-model agreement in the research program was 100 % at record level across a minor version flip, so the band is expected to hold across the pin; the canary tells us when to look.

## Honest limits

- Calibrated mass is a **probability instrument, not a semantic embedding**: answers measure the model's confidence in claims about recorded statistics. Two Towns with different unrecorded characters can share a vector.
- Separation was measured on **exactly two states**, one of them constructed from priors. The axis list is a round-1 reading, not a validated feature space.
- The decoy floor is **soft** (0.10–0.39 on `noul`): the "too little recorded to say" branches pull nonsense toward the middle rather than the floor. Vectors from towns with almost no Facts should be treated as weak evidence.
- `score` answers are levels on question-specific rubrics; they must be normalized (`normalizedPlaceVector`) before comparing across questions or against the ±0.10 band.
