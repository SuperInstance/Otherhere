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
