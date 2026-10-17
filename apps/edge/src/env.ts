import type { SessionDO } from './session';
import type { TownDO } from './town';

export interface Env {
  TOWN: DurableObjectNamespace<TownDO>;
  SESSION: DurableObjectNamespace<SessionDO>;
  BUNDLES: R2Bucket;
  ASSETS: Fetcher;
  OVERPASS_ENDPOINTS: string;
  /** 'true' only under `wrangler dev`. */
  ALLOW_DEV_ROUTES?: string;
  /** Optional Cloudflare Realtime TURN key (secrets). Without them, ICE is STUN-only. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
