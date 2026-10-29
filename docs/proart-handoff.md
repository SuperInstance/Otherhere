# The ProArt's agent: what the Thor has, and what you do with it

_You are working on the **renderer** — the ProArt (WSL2, RTX 4050, 6 GB VRAM). The **Thor**
(Jetson AGX Thor) is the other machine: it hosts the models, generates the assets and serves
them to you. This document is the map of that split: what is on the other side, how to reach
it, and the rules that keep the two halves honest._

If you are reading this for the first time, read it end to end before changing anything.
It is the context a new session lacks.

---

## 1. The shape of it

**The Thor hosts models and generates assets. The ProArt renders and displays them.** That is
not a preference; it is arithmetic. The link between the two machines is **Wi-Fi end to end**
(the Thor's Ethernet ports are down) and measures **9.3–11.5 MB/s** — so a 170 KB asset costs
about 15 ms, and a 2 GB model would cost three minutes. The Thor has the big GPU (128 GB
unified memory) and the ProArt has the small one (6 GB). So: heavy things live on the Thor,
pixels are made on the ProArt.

Everything the game draws from a capture is **content-addressed**: a payload is named by its
sha256, and the client refuses to parse bytes it cannot verify. There is no "trust me" path.

### The one thing to know before you publish an asset

A capture's tiers **share one placement**. The place file carries a single
`position` / `quaternion` / `scale` for a capture, and the client applies it to every tier —
the gaussian splat and the generated mesh alike. So a generated mesh **cannot choose where it
stands**. It has to be _authored into the capture's frame_ on the Thor, so that the shared
placement lands it where the building already is.

Getting this wrong puts the mesh in the wrong place, at the wrong size, facing the wrong way —
and nothing will tell you, because the client faithfully draws whatever it is given.

**Use `frame-model`** (section 5). It computes the transform and bakes it in. Then verify the
result with the silhouette check (section 8). This is the single most expensive lesson in this
document; do not skip it.

---

## 2. The live index: what is here, right now

The Thor runs a small index service. **Read it first** — it is the discovery surface, and it
probes every service live, so it never tells you about something that is down.

```sh
curl -s http://thor.local:8100/index.json     # machine-readable
curl -s http://thor.local:8100/               # a page a human can read
curl -s http://thor.local:8100/health
```

`index.json` carries: every service with its live status and latency; every capture and every
tier with its path, byte count and hash; the four decision models; the pipeline's tools with
examples and costs; the proof scripts; the model shelf on the Thor's disk; and the system's
state (`MemAvailable`, disk, uptime). It is `otherhere.thor-index.v1`.

If you are an agent: fetch it, and let it tell you what exists. Do not guess port numbers
from memory — the index has them.

---

## 3. The services on the Thor

All of them bind `0.0.0.0` and are reachable from the ProArt. **They carry no API key** —
that was a deliberate choice (ADR-0019, 2026-10-28), so do not add one and do not treat them
as public.

| Port    | Service              | What it is for                                                      |
| ------- | -------------------- | ------------------------------------------------------------------- |
| `:8100` | the live index       | what is here, what is running, what it can do (§2)                  |
| `:8098` | the capture service  | the asset registry, and the verified payloads, by hash (§4)         |
| `:8099` | the geometry service | "what is here?" — MoGe depth + intrinsics, 72 ms a query (ADR-0022) |
| `:8097` | the decision tier    | an OpenAI-shaped front door over the local models (§6)              |
| `:8093` | d1-3B                | a local decision model                                              |
| `:8094` | d1-2B                | a local decision model                                              |
| `:8095` | d1-omni-600M         | a local decision model                                              |
| `:8096` | clef-flash           | the accuracy champion of the local tier — 100 % on text             |
| `:8077` | the Jev rack         | TypeSafe Jev, locally                                               |
| `:8001` | the coder            | an OpenAI-shaped coding model                                       |
| `:8788` | the game             | **on the ProArt**, not the Thor — your own `wrangler dev` (§7)      |

Units live in `~/.config/systemd/user/` on the Thor; each is enabled at boot. A service that
misbehaves is usually a stale unit: `systemctl --user restart <name>.service`.

The capture service and the index both re-read their sources on a timer (60 s), so a new
capture or a new place file becomes visible without a restart. **Registry code changes do need
a restart** — the service runs under `tsx`, which does not hot-reload.

### The Thor's memory watchdog

`~/openclaw-ops/watchdog.sh` (`openclaw-watchdog.service`) sheds load when `MemAvailable`
drops below 15 GiB. It classifies `llama-server`, `vllm` and `transformers` listeners.
**Python services are never shed.** Registered consults (`:8001`, `:8003`) and the standing
fleet services are protected; the local decision tier on `:8093`–`:8096` is tier-1 bench and
is shed first.

That rationing is the captain's choice, not a bug. If a decision tier disappears from the
index, check the watchdog log before you change anything:
`~/openclaw-ops/logs/watchdog-$(date +%F).log`.

---

## 4. The asset lane

### The four tiers

| Tier       | What it is                    | Budget (full profile) | Fetched by                        |
| ---------- | ----------------------------- | --------------------- | --------------------------------- |
| `splat`    | a gaussian field (`.spz`)     | —                     | within 140 m of the asset         |
| `model`    | a real triangle mesh (`.glb`) | **192,000 B**         | beyond 140 m, in the full profile |
| `impostor` | a large photograph (`.webp`)  | —                     | when there is no mesh             |
| `card`     | a small photograph (`.webp`)  | —                     | **the lite profile's only tier**  |

The ladder is **splat near, model next, photographs beyond**, and the lite profile never
fetches a mesh at all (ADR-0023). A mesh outranks the photographs wherever it exists: it is
geometry with real silhouettes, and it is cheap enough to be worth the draw.

### How a payload gets served

Two kinds of record may vouch for a payload, and the rule is the same for both: **never serve
an unverified payload.**

- **A capture receipt** — the pipeline wrote the payload and recorded its hash. The payload
  lives on the Thor under `~/sitka-distill/pipeline/<family>/<version>/tiers/`.
- **A place file** — the payload was baked into a place, and the place file names the tier,
  its sha256 and its byte count _beside the payload itself_. The payload lives in the repo
  under `apps/client/public/places/assets/<family>/<version>/`.

```sh
curl -s http://thor.local:8098/places/registry.json
curl -s http://thor.local:8098/places/assets/st-michaels-cathedral/1.0.0/model.glb -o model.glb
sha256sum model.glb     # must equal the hash the registry or the place file names
```

A place-vouched payload is served **from the place file's own directory**, so the _game server
on the ProArt_ serves it too, at `/places/assets/<family>/<version>/<file>`. That is why the
game can show a generated mesh with no build-time configuration at all.

### Adding a tier to the place file

1. Put the payload in `apps/client/public/places/assets/<family>/<version>/`.
2. Add it to the `asset.capture` fact's `tiers` in `apps/client/public/places/sitka.json`:
   `path`, `hash` (sha256, lower-case hex), `bytes`, `contentType`.
3. The Bundle carries the tier automatically (`packages/core/src/bundle/build.ts` copies
   `splat`, `impostor`, `card`, `model`), and the client fetches, verifies and draws it
   (`apps/client/src/assets.ts`).

The capsule's `id` is an opaque token, not a content hash — editing facts does not change
the address.

---

## 5. The Thor's generation pipeline

It lives in `~/sitka-distill/pipeline` (not a git repository — it is the Thor's side of the
line; the repo holds what ships to the game). Each tool prints a JSON line with its numbers.

| Tool            | What it does                                                                    | Cost              |
| --------------- | ------------------------------------------------------------------------------- | ----------------- |
| `depth-place`   | one photograph → a place asset: MoGe depth → a relief mesh, painted on by UV    | **3.3 s**         |
| `finish-asset`  | any generated mesh → a game-ready mesh: decimate, resize, meshopt, under budget | 1.2–3.9 s         |
| `frame-model`   | a generated mesh → the same mesh, authored into its capture's frame (§1)        | seconds           |
| `publish-model` | a finished mesh → a capture the registry will serve, with a `card` photograph   | seconds           |
| `asset-capture` | the original capture pipeline: a walk around a place → a gaussian field         | an hour, a camera |
| `serve-index`   | the live index of §2                                                            | —                 |

The order for a new generated asset is: **generate → finish → frame → publish → name it in the
place file.**

```sh
cd ~/sitka-distill/pipeline

# one photograph -> a place asset (a relief mesh painted by the photograph's own UVs)
./depth-place --image ~/sitka-distill/exp1/cathedral/frames_full/frame_00000.jpg \
    --outdir /tmp/place-final --name lincoln-street --grid 200 120 \
    --targets 40000 20000 --texture-size 512

# any generated mesh -> under the 192,000 B budget
./finish-asset --source /tmp/place-final/lincoln-street-40000t-512px-webp.glb \
    --outdir /tmp/finished --targets 10000 --texture-size 512 --name lincoln-street

# frame it into the capture's frame, so the shared placement lands it on the building
node ./frame-model --place ~/sitka-distill/Otherhere-src/apps/client/public/places/sitka.json \
    --feature osm:w116029214 \
    --source /tmp/finished/lincoln-street-10000t-512px-webp.blender.glb \
    --out /tmp/finished/lincoln-street-framed.blender.glb \
    --dump-points /tmp/finished/lincoln-street.points.json

# publish it where the registry will serve it
./publish-model --source /tmp/finished/lincoln-street-framed-10000t-512px-webp.glb \
    --family lincoln-street-relief --version 1.0.0 --height-m 8 --front-azimuth 180 \
    --derive-rotation --card --card-azimuth 180
```

### The finishing lane

**meshopt, not Draco.** Blender 4.0 has no Draco _exporter_; the flag is silently ignored and
the file comes out the same size. `gltfpack` is built from source for aarch64 at
`~/thor-bench/gen3d-src/meshoptimizer/build/gltfpack`.

The lane also resizes textures **keeping the aspect ratio** (the longest side is scaled). It
used to scale every texture to a square, which turned a 1080×1920 photograph of a place into a
512×512 texture — a place painted sideways. Nothing measured the old lane's _shape_; only its
byte count was ever checked.

### The rules of the framing

`frame-model` computes

```
M = (1/s) · R' · Translate(-p) · T
```

where `R` is the capture's rotation, `s` its scale, `p` its position, and `T` the target:
the mesh's base centre at the building's footprint ring's centre, standing on the ground, the
capture's `heightM` tall, its front facing the capture's `frontAzimuthDeg`.

Three measurements decide `T`, and none of them is a guess:

- **where the building is** — the `footprint` fact's ring, projected into the anchor Cell's
  local east/north frame the same way the Bundle builder projects it;
- **how tall it is** — the capture's own `heightM`;
- **which way it faces** — the capture's own `frontAzimuthDeg` (the direction from the asset
  toward the camera its `card`/`impostor` tiers were baked from).

The tool prints its own check, and that check is the game itself:

```
baseCentreWorld   [-1.153, 0, -15.894]      the target offset, exactly
heightM           14.592                    the capture's heightM, exactly
frontAzimuthDeg   190.7                     the capture's front bearing
```

**Read those numbers before you publish anything.** They are the difference between an asset
that stands on its building and one that stands in a field.

---

## 6. The decision tier

The Thor hosts small models for the game's own decisions (the "Ladder"). They are reached
through one OpenAI-shaped front door on `:8097`:

```sh
curl -s http://thor.local:8097/v1/models
curl -s http://thor.local:8097/v1/chat/completions -H 'content-type: application/json' \
    -d '{"model":"d1-3B","messages":[{"role":"user","content":"…"}]}'
```

`clef-flash` (`:8096`) is the accuracy champion — 100 % on text, 87.1 % on photos, at zero
cost — but it takes 1.1 s a pack, which is too slow for a per-tick decision. The tiering is in
`docs/adr/0019-local-decision-tiers.md` and the measurements are in
`docs/notes/local-decision-models.md`.

---

## 7. Running and playing the game on the ProArt

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # node is NOT on the PATH in a
                                                               # non-interactive ssh
cd ~/projects/Otherhere
pnpm --filter @otherhere/client build                     # the client is static assets
cd apps/edge && pnpm exec wrangler dev --port 8788 --ip 0.0.0.0 --var ALLOW_DEV_ROUTES:true
```

`wrangler` is in `apps/edge`, not at the repo root — `pnpm exec wrangler` from the root fails
with "Command not found".

### Opening a place

| URL                      | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `/?place=sitka`          | the baked Sitka snapshot, from `public/places/`     |
| `/?at=57.0501,-135.3355` | a place built live around a point                   |
| `/?demo=generators`      | the generator demo                                  |
| `?lite=1` / `?lite=0`    | force the lite / full profile                       |
| `#x,y,z,yaw,pitch`       | a camera pose; the client writes the live pose back |

The camera pose is the client's own world frame (x east, y up, z = −north; azimuth 0 = north,
90 = east). **yaw is the negative of the bearing**, because the camera looks along its local
−Z.

A capsule loads **all** of its cells regardless of where the camera is, so you can stand
160 m away from a building and still have its cell (and its capture) loaded.

### The ProArt's own machine

- **WSL2 behind a Windows NAT host.** Reached over SSH as `proart-lan` (`192.168.0.78:2206`).
- **6 GB VRAM.** The full profile is the one that fits; the lite profile is for phones.
- **Playwright's browsers are at `~/.cache/ms-playwright`** (chromium-1248). There is **no**
  `/opt/pw-browsers/chromium`. Run browser proofs here, not on the Thor.
- Software GL runs at 1–3 fps. That is slow but faithful.
- The repo's one probe is `apps/client/playtest/probe.mjs` (`--scene walk|day|determinism|
postcard|sketch|crown`). Artifacts land in `otherhere-lab/playtest-artifacts/` unless you
  set `PLAYTEST_OUT`. **Do not fork it; add a flag.**

---

## 8. How to prove things

A claim without evidence is a wish. These are the instruments, and what each one actually
proves.

| Script                                         | What it proves                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `~/d1-lab/verify_meshopt_glb.mjs`              | a finished GLB decodes **the way the browser will**, with three's own decoder      |
| `~/d1-lab/look_capture.mjs`                    | a capture and a generated mesh, rendered by **one renderer** from **one bearing**  |
| `~/d1-lab/research/prove_model_from_proart.py` | every model tier fetched, hash-checked and decoded **on the renderer's machine**   |
| `~/d1-lab/prove_model_in_game.mjs`             | the **running game** fetched, verified and drew a generated tier                   |
| `~/d1-lab/render_relicam.py`                   | a relief rendered from its photograph's own camera, to compare with the photograph |
| `~/d1-lab/compare_photo.py`                    | PSNR and a difference image between a render and the photograph it came from       |

The meshopt verifier deserves a note: **the `meshoptimizer` npm package is a phantom** — it
is in the store only because `@types/three` depends on it for types. The client loads
**three's own bundled decoder** (`three/addons/libs/meshopt_decoder.module.js`), and so must
your verifier.

For the framing, the decisive check is the silhouette: render the capture's splat and the
generated mesh by the same renderer, from the capture's own front bearing, under the
capture's own placement. If they share a silhouette, the mesh is on the right building.

---

## 9. The rules that are easy to break

- **Never serve an unverified payload.** A payload is real when a receipt _or_ a place file
  names its sha256 and the bytes on disk match.
- **Everything an output depends on must be in its content address.** A tuning constant that
  changes Bundle bytes needs a version that is hashed.
- **Determinism (invariant 2).** Nothing that reaches Bundle bytes may depend on
  `Math.random`, the clock, network arrival order, or floating-point functions that may round
  differently across engines. The `det` helpers in `packages/core/src/math` exist for this.
- **Model output is never executed as code** (invariant 3).
- **The judge is fixed and never modified** (invariant 6).
- **Paid calls go through the router, with daily caps** (invariant 9).
- **Never reveal a secret.** The TypeSafe key is at `~/.openclaw/secrets/typesafe_api_key.key`
  (mode 600). Read it into an environment variable; never print it, never paste it, never
  commit it.
- **The lean NVMe is a standing priority.** The Thor's disk is 68 % used. Remove with
  `mavis-trash` and then selective `rm`; every removal must be recoverable.
- **`llama.cpp/build` (0.7.0-dev) must not be rebuilt** — `llama-coder30.service` depends on
  it. `llama.cpp-upstream` is the upstream worktree.
- **Blender's Cycles with denoising ON renders pure black on this box.** Use EEVEE.
  `util.BLENDER_CYCLES_USE_DENOISING = False` is the standing guard.

---

## 10. Where things are

| Thing                     | Where                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| the repo (on the Thor)    | `~/sitka-distill/Otherhere-src`                                            |
| the repo (on the ProArt)  | `~/projects/Otherhere`                                                     |
| the pipeline              | `~/sitka-distill/pipeline`                                                 |
| the lab, proofs, analysis | `~/d1-lab` (`README.md`, `PROART-HANDOFF.md`, `research/`)                 |
| the systemd units         | `~/.config/systemd/user/` on the Thor                                      |
| the secrets               | `~/.openclaw/secrets/` on the Thor (mode 600)                              |
| the game's own docs       | `AGENTS.md`, `docs/BRIEF.md` (the invariants), `docs/adr/`, `docs/advice/` |

The decisions behind all of this are recorded as ADRs in `docs/adr/`. The ones that matter
most here: **0021** (the Thor hosts the world), **0022** (the geometry service is MoGe),
**0023** (the client gained a `model` tier), **0024** (a generated tier is framed into its
capture).

## 11. The next thing worth building

The lane is closed end to end: a photograph on the Thor becomes a mesh the game opens, at the
right place, at the right size, and the game fetches it and draws it. What it is **not** yet:

- **A place you can walk into.** The relief is 2.5D — exact from the photograph's camera and
  wrong away from it. A real reconstruction still needs a capture.
- **A capture of every building.** The corpus has eleven places because a capture needs a
  COLMAP session, a walk and an hour of compute. The generated tiers are what happens in the
  meantime: the Thor can make a stand-in for a building it has no capture of.
- **A mesh per tier.** One placement for several tiers is the reason `frame-model` exists.
  Per-tier placement would delete that layer.
