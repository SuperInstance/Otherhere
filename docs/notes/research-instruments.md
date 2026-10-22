# Research instruments: the session's science, put to work

_The operator's round-09 dispatch asked for rounds of R&D, ideation and creative
discovery between the build rounds, using Jev and Playwright together, and the
backend science from the session's other programs. This note is what landed and
what it opened. Cost discipline throughout: every instrument here spends well
under a cent a run, and the standing one is capped at a nickel a day._

## What landed

### The drift canary (ambient, in the Worker)

The flip watch that rounds r3–r9 ran by hand — one canary call, `jev-latest`,
one noul question, read against the sealed band — now runs from the Worker's
own cron (hourly at :17, `drift.ts`). It asks through the ModelRouter under its
own `jev-canary` budget key, so it can neither spend nor be crowded out by any
product path (invariant 9), and a runaway bug tops out at $0.05 a day.
Readings land in the OpsDO; `GET /api/ops/drift` serves them owner-only with
the standing flip verdict. Under `MODEL_FAKE` the fake serves `fake-jev`, so
the flip logic is exercised in tests by construction.

The protocol is the research session's drift monitor transplanted whole: one
calibrated question, a sealed band (0.85–0.99 held across r3–r9), watching the
answer distribution as well as the version string. The moment `served` differs
from the pin is the moment the photo eval must re-run before the pin moves.

### see.mjs — the fresh-eyes reading (local, on demand)

`apps/client/playtest/see.mjs`: Playwright captures any reachable scene (or
reads a frame you already have), fits it to Jev's image bounds, and asks a
designed pack about what a first-time player sees — where the eye lands, what
the world reads as, whether it reads as settled, what would confuse, how calm
it feels. ~$0.0001 a run; a local tool like the delegation scripts, never CI,
never runtime.

First live reading (production, desktop, 2026-10-21): the eye lands on
**text/UI first (0.85)**; the world reads as a **paper model of a real place
(1.00)**; the frame does not read as mid-load (0.18); the top confusion is
**finished vs unfinished geometry (0.33)** — which is the product's own story
(the wake-up moment), seen from outside; mood 5.97/10, leaning "quiet". Two
design signals worth carrying: the interface is the loudest thing in the frame,
and the paper/true boundary is legible enough to be the confusion.

### The layer-namer (round 09, the pattern behind see.mjs)

The settle-race hunt used the same shape ad hoc: Playwright takes two frames,
sharp amplifies the diff, Jev names the layer (water_surface 0.74, horizon
band — the diagnosis that closed #40). see.mjs is that shape generalised: any
frame, any question pack, a fraction of a cent.

## Ideation carried forward (not built yet)

### Level assist as journeys through questions (Arc 3's substrate)

The place-vector corpus plus the retrieval question: given a Town's vector,
which known Towns are near, and what does "near" mean per axis? The r3–r4
corpus laws stand (settle-then-ask; serial visits or the Overpass limit trips).
The retrieval matrix wants: cosine over the raw vectors vs the normalised view
(`placeVectorNormalized`), per-question contribution (which axis separates
Sitka from Zürich — `rainy_coast` vs `warm_earthy_walls`), and a phrasing-law
check that the battery's answers are stable enough to retrieve on (the r9 seal
now guarantees the cache key, not the answers' stability — a baseline re-run
over the same state would measure that, and the decoy run already exists in the
place-vector script).

The shape of the feature, when it comes: arriving somewhere new, the world
quietly knows the places you have been — "this harbour reminds me of Sitka" —
a journey through questions, never a quiz.

### The model ladder (different hardware, same system)

The session's providers slot into roles by cost and speed, and the delegation
log already prices them: Jev for calibrated triage and images (fractions of a
cent, the photo gate and the canary); DeepSeek-V4.1-Flash on DeepInfra for
adversarial review and drafting ($0.001 a diff, catches real bugs at a rate the
r9 reviews demonstrate); Groq for anything latency-bound that a Worker cron
might want (untested here yet — the natural first use is a faster canary or a
cheap classification in a scheduled sweep). The ladder's rule stays: the
cheapest instrument that can answer the question, every answer read by the
engineer before it matters.

## The 2026-10-22 round: retrieval, a blocked seat, and a corpus

### The place-vector retrieval matrix (Arc 3's substrate)

`packages/models/scripts/place-retrieval.ts` (a local instrument like
`place-vector.ts`; this round: 3 live calls, **$0.000186**). It loads the
baseline's five runs per state — already paid for — asks three constructed
states once each (a fishing village, a dense city, an alpine resort, each with
a stated provenance and a believed affinity), and computes the matrix.

**Two laws, measured:**

1. **Retrieve on the normalized view, never the raw vector.** The decoy state
   (nonsense text) reads **0.912 raw cosine to Zürich** — nearer than the
   dense city's 0.931 is far, and above real pairs — because raw cosine is
   dominated by the score answers' 1–9 magnitudes. Normalized, the decoy falls
   to 0.585–0.710, below every real affinity pair. A retrieval built on raw
   vectors would match nonsense to towns.
2. **The battery is stable enough to retrieve on.** Five runs per state agree
   to within-run cosine distance ≤ 0.001; the nearest cross-state gap is
   0.003 (Sitka↔fishing-village), most are 0.05–0.25. The margin is 3–250×
   the noise. (This answers the instruments note's open phrasing-law question:
   the answers are stable enough; the r9 seal covered the key, this covers the
   values.)

**The affinities, as believed before measuring:** fishing-village → Sitka
**0.997** raw / **1.000** normalized (near-tautological: it was constructed
from the same priors — but it proves the vector hears the species mix
exactly); dense-city → Zürich 0.931 raw; alpine-resort sits between, leaning
Sitka (0.952 normalized) on its conifers.

**The separation vocabulary** (leave-one-question-out on Zürich–Sitka):
`mostly_conifers` is the strongest single separator, then `uniform_roofs`,
`dense_not_spread`, `rainy_coast`; `height_scale` dominates the raw view
(+0.092 cosine when dropped). The questions that carry their _similarity_ are
`warm_earthy_walls` and `heights_recorded`. For Arc 3 this is the reason
vocabulary: "this harbour reminds me of Sitka — its conifers, its rainy
coast" is exactly what the per-axis table can name.

**One honest tension:** raw and normalized disagree on Zürich's nearest
neighbour (dense-city raw, alpine-resort normalized). The normalized view is
the safer default (law 1), but the disagreement says the score axes carry the
raw geometry; if Arc 3 wants height to matter in retrieval, that choice has
to be made consciously.

### The Groq seat stays closed (measured, not assumed)

The instruments note listed Groq as the untested latency rung. Tested now:
direct sandbox egress 403s pre-auth (the qthe program's known receipt), and
the groq-relay Worker — redeployed with the current secrets — also receives
**403 on its no-auth disambiguation probe**, meaning Groq's edge refuses the
Cloudflare egress geography before any key is seen. The key is not the
problem; the door is. The drift canary stays on Jev (cheap, hourly, already
running), and the gpt-oss-20b latency question stays open until the block
lifts. Receipts: `curl /probe/noauth` through the relay, 2026-10-22.

### The fresh-eyes corpus (three scenes)

`see.mjs` readings across production scenes — Sitka street (r10), Zürich
(r12), the wild hillside (r12):

| scene         | eye lands    | state clear | top confusion     | mood |
| ------------- | ------------ | ----------- | ----------------- | ---- |
| Sitka street  | text/ui 0.85 | 0.90        | flat_vs_real 0.77 | 6.16 |
| Zürich block  | text/ui 0.87 | 0.15        | flat_vs_real 0.24 | 5.81 |
| wild hillside | text/ui 0.95 | 0.93        | flat_vs_real 0.86 | 6.31 |

Every frame reads as a paper model (1.00 ×3), and the eye lands on the
**text/UI first in all three** (0.85–0.95): the interface is the loudest
thing in every frame the instrument has seen. The Zürich reading caught the
block mid-settle (state 0.15) — the instrument's first capture of the
wake-up moment from outside, worth repeating deliberately. The wild hillside
is the calmest and the most flat-vs-real confused, which is the product's
own story seen at its widest.
