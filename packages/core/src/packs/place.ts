import { z } from 'zod';
import { QuestionPack } from '../schema/question-pack';
import type { Essence } from '../schema/world';
import type { FeatureKind } from '../schema/feature';
import type { ResolvedAttrs } from '../facts/resolve';
import { bucket, knownHeight, knownSpecies } from '../essence/compute';
import place from './place.v1.json';

/**
 * The place battery (ADR-0018): a fixed, hand-designed set of questions whose
 * calibrated answers over a Town's Essence + census form its place vector.
 * The text is byte-stable from the moment it is first asked — the phrasing law
 * says synonym swaps move answer mass, so a rewording is a new battery version,
 * never an edit to this one.
 */
export const PLACE_PACK: QuestionPack = QuestionPack.parse(place);

/** The battery's sealed short name, stamped on every vector and baseline. */
export const PLACE_BATTERY = 'place.v1' as const;

/** Same bar as Essence: below this confidence a Fact does not count as "known". */
const MIN_CONF = 0.5;

/**
 * A Town's Fact census: what the place is made of, and how much of it is known.
 * Counts are bucketed and shares quantized to 0.05, like Essence, so ordinary
 * Fact writes rarely change the place state (and so rarely re-ask the battery).
 */
export type PlaceCensus = {
  /** Features by kind, small counts kept as 1 (bucketed). */
  featuresByKind: Record<string, number>;
  /** Share of buildings with a resolved height, roof shape or wall colour. */
  known: { height: number; roof: number; colour: number };
  /** Share of trees with a resolved species. */
  knownSpecies: number;
  /** Facts by source, small counts kept as 1 (captures are the human signal). */
  factsBySource: Record<string, number>;
};

/** Like Essence's sample buckets, but a nonzero count never reads as zero. */
const censusBucket = (n: number) => (n > 0 ? Math.max(1, bucket(n)) : 0);

const share = (n: number, d: number) =>
  d > 0 ? Math.round(Math.round(n / d / 0.05) * 0.05 * 100) / 100 : 0;

/**
 * The census half of a place state. `attrs` may carry only the Essence
 * attributes (height/levels, roof.shape, colour, species); everything else the
 * census reads is the Feature's kind. Pure and order-independent.
 */
export function placeCensus(
  features: Iterable<{ kind: FeatureKind; attrs: ResolvedAttrs }>,
  facts: Iterable<{ source: string }> = [],
): PlaceCensus {
  const kinds = new Map<string, number>();
  let buildings = 0;
  let trees = 0;
  let height = 0;
  let roof = 0;
  let colour = 0;
  let species = 0;
  for (const f of features) {
    kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    if (f.kind === 'building') {
      buildings++;
      if (knownHeight(f.attrs) !== null) height++;
      const r = f.attrs['roof.shape'];
      if (r && r.confidence >= MIN_CONF && typeof r.value === 'string') roof++;
      const c = f.attrs.colour;
      if (c && c.confidence >= MIN_CONF && typeof c.value === 'string') colour++;
    } else if (f.kind === 'tree') {
      trees++;
      if (knownSpecies(f.attrs) !== null) species++;
    }
  }
  const sources = new Map<string, number>();
  for (const f of facts) sources.set(f.source, (sources.get(f.source) ?? 0) + 1);
  const counted = (m: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of [...m.keys()].sort()) out[k] = censusBucket(m.get(k)!);
    return out;
  };
  return {
    featuresByKind: counted(kinds),
    known: {
      height: share(height, buildings),
      roof: share(roof, buildings),
      colour: share(colour, buildings),
    },
    knownSpecies: share(species, trees),
    factsBySource: counted(sources),
  };
}

const m = (v: number) => `${v.toFixed(1)} m`;
const pair = (s: string, v: number) => `${s} ${v.toFixed(2)}`;

/**
 * The state the battery is asked over: a deterministic serialization of a
 * Town's Essence and census (ADR-0018). Fixed template, sorted keys, numbers
 * printed through fixed formats, so the same statistics always produce the
 * same bytes — and the same answers. The Essence's `town` id is deliberately
 * not part of it: the state is the place's character, not its address.
 */
export function placeState(essence: Essence, census: PlaceCensus): string {
  const lines = ['PLACE SUMMARY (deterministic statistics of one Town)'];
  lines.push(`biome: ${essence.biome ?? 'unspecified'}`);
  lines.push(
    essence.sampleCount > 0
      ? `building height: median ${m(essence.heightM.median)}, upper decile ${m(essence.heightM.p90)}, ${essence.sampleCount} known heights`
      : 'building height: none recorded',
  );
  const roofs = Object.keys(essence.roofShapes).sort();
  lines.push(
    roofs.length
      ? `roof shape mix: ${roofs.map((k) => pair(k, essence.roofShapes[k]!)).join(', ')}`
      : 'roof shapes: none recorded',
  );
  lines.push(
    essence.palette.length
      ? `wall colour palette: ${essence.palette.join(', ')}`
      : 'wall colours: none recorded',
  );
  const forest = Object.keys(essence.forest ?? {}).sort();
  lines.push(
    forest.length
      ? `tree species mix: ${forest.map((k) => pair(k, essence.forest![k]!)).join(', ')}`
      : 'tree species: none recorded',
  );
  const kinds = Object.keys(census.featuresByKind).sort();
  lines.push(
    kinds.length
      ? `features: ${kinds.map((k) => `${k} ${census.featuresByKind[k]!}`).join(', ')}`
      : 'features: none recorded',
  );
  lines.push(
    `known shares: building height ${census.known.height.toFixed(2)}, roof shape ${census.known.roof.toFixed(2)}, wall colour ${census.known.colour.toFixed(2)}, tree species ${census.knownSpecies.toFixed(2)}`,
  );
  const sources = Object.keys(census.factsBySource).sort();
  lines.push(
    sources.length
      ? `facts by source: ${sources.map((k) => `${k} ${census.factsBySource[k]!}`).join(', ')}`
      : 'facts: none recorded',
  );
  return lines.join('\n');
}

/** A stored place vector: what was asked, of which state, by which served model. */
export const StoredPlaceVector = z.strictObject({
  battery: z.string(),
  /** The pinned model the battery was asked of — the cache's invalidation key. */
  model: z.string(),
  /** What the provider actually served on that ask (the version canary). */
  served: z.string(),
  stateSha: z.string(),
  vector: z.record(z.string(), z.number()),
  at: z.string(),
});
export type StoredPlaceVector = z.infer<typeof StoredPlaceVector>;
