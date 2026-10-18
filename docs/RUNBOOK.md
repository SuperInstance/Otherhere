# Runbook

How Otherhere runs in production and what to do when something goes wrong. One Worker serves the client (static assets) and the API. Durable Objects hold the state: `TownDO` per Town, `SessionDO` per match, plus one `OpsDO` and one `JobsDO`. R2 (`otherhere-bundles`) holds the Bundles.

## Deploy

```sh
pnpm install
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm deploy   # builds the client, then wrangler deploy
```

The token needs Workers Scripts edit and Workers R2 Storage edit. Migrations for new Durable Object classes are listed in `apps/edge/wrangler.jsonc` and run on deploy; never edit or remove an existing migration tag.

The GitHub **Deploy** workflow does the same with repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Set the repository variable `DEPLOY_ENABLED=true` to deploy every push to `main`.

## Secrets (`wrangler secret put <NAME>` in `apps/edge`)

| Secret                              | Turns on                                                            | Without it                                             |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `TYPESAFE_KEY`                      | Jev: the Ladder's first rung and the photo visibility gate          | Photo analysis falls back to other rungs, with no gate |
| `GROQ_KEY` or `MINIMAX_KEY`         | The vision step of photo analysis (Groq first, MiniMax as fallback) | Photo analysis is off (503 with a plain message)       |
| `MINIMAX_KEY`, `ANTHROPIC_API_KEY`  | Higher Ladder rungs                                                 | Those rungs are skipped                                |
| `MODEL_CAPS_USD`                    | Daily cap per provider, e.g. `{"jev":1,"minimax":2}`                | Defaults: $1–2 per provider per day                    |
| `OPS_TOKEN`                         | `/api/ops/*` (spend, decisions, jobs, crawl)                        | Those routes return 404                                |
| `AGENT_TOKEN`                       | `/api/agent/*` for Plugins (ADR-0015)                               | Plugins are off; everything else works                 |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | TURN relay for matches behind strict NATs                           | STUN only                                              |

## Limits and protections

- **Model spend:** every paid call goes through the ModelRouter's daily per-provider caps (invariant 9). A capped provider is skipped as `unavailable`, as is a provider returning 429 or 503.
- **Rate limits:** per client IP (`ratelimits` in `wrangler.jsonc`). Photo analysis allows 20 per minute. Creating Sessions, Capsules and taste events allows 30 per minute. Over the limit: 429 with `retry-after: 60`; the filmed-walk importer waits and retries once.
- **Errors:** an unhandled error returns JSON 500 with a reference ID and logs one JSON line (`level`, `id`, `method`, `path`, `error`) to Workers Logs. Search the logs for the ID a user quotes.
- **Headers:** API responses send `x-content-type-options: nosniff`. The client sends a CSP, `X-Frame-Options: DENY`, a referrer policy and a permissions policy (`apps/client/public/_headers`).

## Checking health

- `GET /api/health` returns `{ ok, interpreter }`.
- With `OPS_TOKEN`: `GET /api/ops/spend` for today's spend per provider, `GET /api/ops/decisions?limit=50` for recent Ladder and gate decisions, `GET /api/ops/jobs` for the Plugin queue.
- In the client, the status line shows `n/n bundle hashes verified`. A mismatch means non-determinism (invariant 2) and is a bug.

## When things go wrong

| Symptom                                           | Likely cause                                                     | What to do                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cells stay a sketch ("waiting for OpenStreetMap") | Every Overpass endpoint failing or slow                          | It retries with backoff on its own. Run a Plugin (`apps/agent`) to fetch blocks from elsewhere, or change `OVERPASS_ENDPOINTS` in `wrangler.jsonc`. |
| Photo analysis returns 503                        | No vision key set                                                | Set `GROQ_KEY` or `MINIMAX_KEY`.                                                                                                                    |
| Photos are analysed but nothing sharpens          | Rungs capped or unavailable, or the gate says "no building"      | Check `/api/ops/decisions` for `unavailable` or `refused` outcomes and `/api/ops/spend` against the caps.                                           |
| Many 429s for real users                          | Rate limit too low for a shared IP (school, office)              | Raise the `ratelimits` values and redeploy.                                                                                                         |
| `MISMATCHED` bundle hashes in the client          | A generator or interpreter changed output without a version bump | Bump `INTERPRETER_VERSION` or the generator version (see README, Determinism).                                                                      |

## Rollback

`wrangler rollback` in `apps/edge` restores the previous Worker version. Durable Object data and R2 Bundles are untouched. Bundles are content-addressed, so old and new versions can share the bucket.
