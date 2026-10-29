# LLM-to-3D, procedural streets, and the blind-critic loop

A survey of four things worth studying, and what each one says to our own stack. Written 2026-10-28.

---

## 1. LLMto3D — <https://cdml-lab.github.io/LLMto3D/>

**Generating Parametric Objects from Text Prompts** (Bat-El Hizmi, Abraham Shkolnik, Guy Austern, Yoav Sterman).

The shape of it: **three agents, each an LLM pre-trained for one task**.

1. **Object-Deconstructor** — deconstructs a text prompt into design elements; describes geometry and spatial relations.
2. **Code-Writer** — translates that description into code against the **Rhino.Geometry** library in the **Rhino3D / Grasshopper** modelling environment.
3. **Program-Assembler** — reassembles the models and adds parametric control interfaces.

The output is **parametric geometry with sliders**, not a mesh — dimensionally controllable and printable.

**Why it matters to us:** this is the same thesis as the Thor Foundry — _code is the generative medium, and the parameters are the asset_ — reached from a different direction (Rhino/Grasshopper instead of Blender) and with **specialised fine-tuned agents** rather than one general model.

The specialisation is the part worth stealing: the Deconstructor is very nearly a **question pack** (a typed decomposition of a prompt), and the Code-Writer is very nearly the **LLM-as-compiler** cell in `quilt-pincher`. The Assembly step is the **deterministic core**.

## 2. LL3M — <https://github.com/threedle/ll3m>

**LL3M writes Python code that generates 3D assets in Blender.** A multi-agent system that coordinates specialised LLM agents to **plan, retrieve, write, debug, and refine** Blender scripts.

Three ideas that matter more than the code:

- **Code as the generative medium.** _"We break away from the typical generative approach that learns from a collection of 3D data. Instead, we reformulate shape generation as a code-writing task, enabling greater modularity, editability, and integration with artist workflows."_
- **BlenderRAG.** A retrieval-augmented knowledge base built from Blender API documentation, giving the agents examples, types and functions. _"A shared code context across agents enables awareness of previous attempts."_
- **A co-creative loop.** _"Agents can automatically self-critique using code and visuals, while iterative user instructions provide an intuitive way to refine assets."_

**The server is gone.** The README says the paper's model (Claude Sonnet 3.7) was retired and _"we have discontinued the LL3M server."_ The repo is the **client** only: `config/config.yaml` points at `https://server.ll3m.org/`, and the multi-agent server code is not in the repo. `config/loader.py` honours a `LL3M_SERVER_URL` environment override, so it can be pointed elsewhere — but there is no local server to point at. Treat the architecture as the artefact, not the package.

Its stated limitation is the one we already solved: _"The coding LLM may occasionally hallucinate or generate different results for the same prompt… Random seeds can lead to variations in quality."_ Our foundry's answer is `params + seed` as the asset, and `mint.py regen --id N` proving byte-identical reproduction.

## 3. night-street — <https://github.com/StarKnightt/night-street>

**Photorealistic procedural city street at golden hour.** Three.js + React Three Fiber, **zero external assets**, MIT licence. Live at <https://night-street.vercel.app>.

> Every texture, every mesh, every light and every sound in this scene is generated in code. There are no image files in this repository, no models, no HDRIs, no audio files. […] Nothing was authored in Blender, Substance or Photoshop, because nothing was authored anywhere except in a text editor.

The asphalt is a GLSL surface description baked into a PBR texture set on the GPU. The buildings are indexed triangle soup from a massing solver. The sky is an analytic dome with three procedural cloud decks, baked into a cube used as both background and IBL. Traffic, tyre noise and canyon reverberation are a Web Audio graph rendered offline. Six fixed **capture stations**, and `npm run shoot` renders them from the running build.

**`PROMPTS.md` is the real find.** The build's prompts are published verbatim, typos included — _"because a tidied prompt is a reconstruction and the point of publishing these is that they are not."_ Two things in it are architecture, not art direction:

**The blind-critic loop.** For each system:

> For each system: build it, then spawn ONE separate sub-agent as a harsh visual critic. The critic should compare the result against real nighttime city photography […] The critic must never be the same agent that built it. It should only see the rendered output, not the code.

> /loop on each system until the critic says it genuinely looks like a real nighttime photograph, not a render.

And the acceptance test, stated as a human experiment:

> Screenshot the final result. Show it to someone without context. If they think it's a photo before they realize it's a browser, you're done. If they immediately think "3D render" or "game," keep going.

**The do-not-touch rule.** _"do NOT touch the lighting, road texture, or building geometry that already works. only add to what's there. after each fix, screenshot and compare against real golden hour city photography."_

**What this says to us.** The critic is the **yin** to the builder's **yang** — and the rule that makes it work is _separation_: the critic never sees the code, and never is the builder. A critic that shares the builder's context cannot criticise it. That is now rule 3 of [ADR-0019](../adr/0019-local-decision-tiers.md).

The do-not-touch rule is the same discipline as our conservation law: the slow tier changes the fast tier from above, it does not rewrite it.

## 4. Edge vs cloud GPUs — <https://huggingface.co/blog/daya-shankar/edge-vs-cloud-gpu>

_(Casey's link was `/blog/daya-shankar/open-source-llm`, which 404s. The live post is `/open-source-llms` — "Best Open-Source LLM Models in 2026: Coding, Local, Agentic AI, Benchmarks, and License".)_

The edge-vs-cloud post lands exactly where we landed:

> The practical question is not "edge or cloud." It is "which requests should run locally and which should go to a GPU cloud," and how to route between them cleanly.

Its two hybrid patterns are our architecture:

> **1. Edge preprocessing, cloud reasoning** — Do early stages locally, then send compact representations to the cloud for heavier reasoning.

> **2. Model cascading** — Run a small, fast model locally for most requests. Escalate only uncertain or high value cases to a larger cloud model.

Also worth keeping: _"decide with measurements, not ideology, while measuring end-to-end latency… including data transfer"_ and _"set a latency SLO and a cost envelope, then benchmark the same model on one edge node and one cloud endpoint. Compare p95 latency and full costs, not just GPU hours."_ That is the eval harness in `packages/judge/scripts/local-vs-cloud.ts`.

The companion post's picks, for the record: **Gemma 4 26B A4B** for local deployment ("only 3.8B active parameters"), **Qwen3 or Gemma 4** for a clean Apache-2.0 commercial licence, **Phi-4** for a small local model under MIT. Note that our hot **Qwen3-Coder-30B-A3B** is the same shape as Gemma 4 26B A4B — a large total parameter count with few active — which is the pattern that actually fits local hardware.

---

## The thread through all four

**Code is the generative medium; a model that cannot touch the code judges the result.** LLMto3D's three agents, LL3M's plan/retrieve/write/debug/refine team, night-street's blind critic against renders, and our own tier stack are the same idea at different scales:

|                | builder                        | critic                         | what the critic sees                            |
| -------------- | ------------------------------ | ------------------------------ | ----------------------------------------------- |
| `night-street` | the agent that wrote the scene | a separate sub-agent           | the rendered output, never the code             |
| `LL3M`         | the code-writing agent         | the same team, self-critiquing | the code _and_ the visuals                      |
| LLMto3D        | the Code-Writer                | the Object-Deconstructor       | the prompt, before any code exists              |
| **ours**       | T0 + T1 (60 Hz, local)         | T2 + T4 (2–5 Hz, slow)         | observations and traces, never the core's state |

Two things we already do that these projects had to solve:

- **Determinism.** LL3M's limitation is that the same prompt gives different results and seeds vary. Our foundry's answer — `params + seed` _is_ the asset, and `mint.py regen --id N` is byte-identical — is stronger than either.
- **BlenderRAG.** LL3M retrieves from Blender API documentation. We could do the same over the foundry's own `archetypes.py` / `engine.py` surface, which is a retrieval index that already exists.

One thing we do that LL3M and LLMto3D deliberately do not: **invariant 3 — model output is never executed as code.** Both projects run LLM-written Blender/Rhino code directly. That is their product. For us the generator is code we wrote, and a model proposes _parameters_, not code. The cost is that we cannot ask a model to invent a new archetype; the benefit is that the foundry stays reproducible and content-addressed. That trade is deliberate, and it is the one place where our stack and theirs genuinely diverge.
