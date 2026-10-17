import type { TownDO } from './town';

export interface Env {
  TOWN: DurableObjectNamespace<TownDO>;
  BUNDLES: R2Bucket;
  ASSETS: Fetcher;
  OVERPASS_ENDPOINTS: string;
  /** 'true' only under `wrangler dev`. */
  ALLOW_DEV_ROUTES?: string;
}
