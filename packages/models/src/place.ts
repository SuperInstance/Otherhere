import {
  PLACE_BATTERY,
  PLACE_PACK,
  placeState,
  sha256Hex,
  type Answers,
  type Essence,
  type PlaceCensus,
  type Question,
} from '@otherhere/core';
import type { JevProvider } from './providers/jev';

/**
 * A Town's place vector (ADR-0018): the sealed place battery's calibrated
 * answers over its deterministic state. `noul` answers are probabilities of
 * yes; `score` answers are probability-weighted levels on the question's own
 * scale — the vector carries each question's raw answer, not a rescaled one.
 */
export type PlaceVector = {
  /** The battery that produced this vector, e.g. `place.v1`. */
  battery: typeof PLACE_BATTERY;
  /** Question id → its raw answer. */
  vector: Record<string, number>;
  /** What the model actually served (the version canary). */
  model_served: string;
  /** SHA-256 of the exact state text the battery was asked over. */
  stateSha: string;
  costUsd: number;
};

/** Extract the vector from battery answers, checking every question answered in shape. */
export function placeVectorFrom(answers: Answers): Record<string, number> {
  const vector: Record<string, number> = {};
  for (const [id, q] of Object.entries(PLACE_PACK.questions)) {
    const a = answers[id];
    if (!a) throw new Error(`place battery: no answer for ${id}`);
    vector[id] = answerMass(id, q, a);
  }
  return vector;
}

function answerMass(id: string, q: Question, a: Answers[string]): number {
  if (q.type === 'noul') {
    if (a.type !== 'noul')
      throw new Error(`place battery: ${id} answered ${a.type}, expected noul`);
    return a.noul;
  }
  if (q.type === 'score') {
    if (a.type !== 'score')
      throw new Error(`place battery: ${id} answered ${a.type}, expected score`);
    return a.score;
  }
  throw new Error(
    `place battery: ${id} is a ${q.type} question; the vector carries noul and score only`,
  );
}

/**
 * Ask the place battery over a state string. The decoy run and the baseline
 * receipts go through here; Towns go through `askPlaceVector`.
 */
export async function askPlaceVectorState(
  provider: JevProvider,
  state: string,
): Promise<PlaceVector> {
  const r = await provider.ask(PLACE_PACK, state);
  return {
    battery: PLACE_BATTERY,
    vector: placeVectorFrom(r.value),
    model_served: r.model,
    stateSha: await sha256Hex(state),
    costUsd: r.costUsd,
  };
}

/** Ask the place battery over a Town's Essence and census (ADR-0018). */
export async function askPlaceVector(
  provider: JevProvider,
  essence: Essence,
  census: PlaceCensus,
): Promise<PlaceVector> {
  return askPlaceVectorState(provider, placeState(essence, census));
}

/**
 * The vector on a common 0–1 scale: noul answers are already probabilities;
 * score answers are levels, mapped by their question's rubric width. The
 * stored vector stays raw (what the model said); this is the comparable view
 * for drift checks and, later, similar-place retrieval.
 */
export function normalizedPlaceVector(vector: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, q] of Object.entries(PLACE_PACK.questions)) {
    const v = vector[id];
    if (v === undefined) continue;
    if (q.type === 'score') {
      const levels = q.criteria.length;
      out[id] = levels > 1 ? (v - 1) / (levels - 1) : v;
    } else {
      out[id] = v;
    }
  }
  return out;
}
