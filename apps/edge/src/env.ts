import type { JobsDO } from './jobs';
import type { OpsDO } from './ops';
import type { SessionDO } from './session';
import type { TownDO } from './town';

/** Cloudflare's rate-limiting binding. */
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  TOWN: DurableObjectNamespace<TownDO>;
  SESSION: DurableObjectNamespace<SessionDO>;
  OPS: DurableObjectNamespace<OpsDO>;
  JOBS: DurableObjectNamespace<JobsDO>;
  BUNDLES: R2Bucket;
  /** Photo analysis: the one public route that spends model budget. */
  PHOTO_LIMIT?: RateLimit;
  /** Routes that create Sessions, Capsules or judge events. */
  WRITE_LIMIT?: RateLimit;
  ASSETS: Fetcher;
  OVERPASS_ENDPOINTS: string;
  /** Nominatim search endpoint; set only to point tests or a mirror elsewhere. */
  NOMINATIM_URL?: string;
  /** Address lookups (Nominatim asks clients to keep requests low). */
  GEOCODE_LIMIT?: RateLimit;
  /** 'true' only under `wrangler dev`. */
  ALLOW_DEV_ROUTES?: string;
  /** Optional Cloudflare Realtime TURN key (secrets). Without them, ICE is STUN-only. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Model provider keys (Worker secrets). Missing keys disable that rung. */
  GROQ_KEY?: string;
  TYPESAFE_KEY?: string;
  MINIMAX_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** JSON map of daily USD caps per provider, e.g. {"jev":1,"groq":1}. */
  MODEL_CAPS_USD?: string;
  /** 'true' in tests: providers answer from canned fakes, no network. */
  MODEL_FAKE?: string;
  /** If set, owner-only ops routes require `Authorization: Bearer <OPS_TOKEN>`. */
  OPS_TOKEN?: string;
  /** If set, Plugins may pull jobs with `Authorization: Bearer <AGENT_TOKEN>` (ADR-0015). */
  AGENT_TOKEN?: string;
}
