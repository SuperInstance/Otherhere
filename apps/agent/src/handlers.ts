import { blockBBox, fetchOverpass, overpassQuery, type Proposal } from '@otherhere/core';
import type { FetchLike, Handler } from './runtime';

/** `ingest_block`: fetch one block from Overpass and hand back the raw response. */
export const ingestBlock =
  (opts: { fetch?: FetchLike; endpoints?: readonly string[] } = {}): Handler =>
  async (job) => {
    const overpass = await fetchOverpass(overpassQuery(blockBBox(job.block)), {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.endpoints ? { endpoints: opts.endpoints } : {}),
      timeoutMs: 60_000,
    });
    return { kind: 'ingest_block', overpass } as Proposal;
  };
