import type { QuestionPack } from '@otherhere/core';
import { JEV_MODEL, type JevProvider } from '@otherhere/models';
import type { Env } from './env';
import { canaryJev } from './models';
import { opsStub } from './ops';

/**
 * The flip watch, made ambient: one canary call an hour, from the Worker's own
 * cron — never from a request — asking `jev-latest` one fixed noul question and
 * recording what actually served. TypeSafe can move the alias without notice;
 * the product asks the pin (`JEV_MODEL`, re-run the photo eval before moving
 * it — docs/notes/model-field-notes.md), so the moment `served` differs from
 * the pin is the moment the eval must run. Readings land in the OpsDO and are
 * served owner-only at GET /api/ops/drift.
 *
 * The same protocol watched a research model across a whole session (the qthe
 * drift monitor): one calibrated question, read against its sealed band. The
 * band for this state held 0.85–0.99 across rounds r3–r9 (the reading has
 * stayed ~0.92–0.96); a drift outside it means the answer distribution moved,
 * which is worth noticing even before a version flips.
 */

const CANARY_STATE =
  'A quiet grey morning on a temperate coast; the harbour still, the paper world settled.';

const CANARY_PACK: QuestionPack = {
  id: 'probe.drift',
  version: '1.0.0',
  description: 'One fixed question, asked hourly of jev-latest, to watch what serves.',
  questions: {
    calm: {
      type: 'noul',
      instructions: 'Judge the claim: the scene is calm.',
      criteria: {
        true: 'Still water, no wind, no motion.',
        false: 'Wind, waves, or motion.',
      },
    },
  },
};

/** One canary reading, as stored and served. */
export type DriftReading = {
  at: string;
  /** What was asked ('jev-latest' — the alias, so a flip is visible). */
  asked: string;
  /** What actually served (the version canary). */
  served: string;
  /** What the product asks (the pin). */
  pinned: string;
  flipped: boolean;
  /** The calibrated answer, to watch the distribution as well as the version. */
  calm: number | null;
  ms: number;
  costUsd: number;
};

/** The canary run: ask once, record, return. Null when Jev is not configured. */
export async function runDriftCanary(env: Env): Promise<DriftReading | null> {
  const jev: JevProvider | null = canaryJev(env);
  if (!jev) return null;
  const t0 = Date.now();
  const r = await jev.ask(CANARY_PACK, CANARY_STATE);
  const reading: DriftReading = {
    at: new Date().toISOString(),
    asked: 'jev-latest',
    served: r.model,
    pinned: JEV_MODEL,
    flipped: r.model !== JEV_MODEL,
    calm: r.value.calm?.type === 'noul' ? r.value.calm.noul : null,
    ms: Date.now() - t0,
    costUsd: r.costUsd,
  };
  await opsStub(env).recordDrift(reading);
  return reading;
}

/** GET /api/ops/drift — the recent readings and the standing flip verdict, owner-only. */
export async function driftRoute(env: Env, limit: number): Promise<Response> {
  const readings = (await opsStub(env).driftLog(limit)) as DriftReading[];
  const flipped = readings.find((r) => r.flipped);
  return Response.json(
    {
      pinned: JEV_MODEL,
      flipped_now: flipped ? flipped.served : null,
      readings,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
