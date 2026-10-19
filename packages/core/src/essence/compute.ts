import type { ResolvedAttrs } from '../facts/resolve';
import { Essence } from '../schema/world';
import type { FeatureKind } from '../schema/feature';
import { biomeMix, type ForestBiome, type Species, FOREST_SPECIES } from '../forest/species';

/** Below this many known samples, a statistic is left out (generators fall back to defaults). */
export const ESSENCE_MIN_SAMPLES = 5;
/** Facts below this confidence do not shape the Essence. */
const MIN_CONF = 0.5;

const q = (v: number, step: number) => Math.round(v / step) * step;

/** Sample counts are bucketed too: generators only need "enough or not", and raw counts change on every Fact. */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const bucket = (n: number) => BUCKETS.filter((b) => b <= n).pop() ?? 0;
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/** A building's known height, from `height` or else `levels`; null if neither is known. */
function knownHeight(a: ResolvedAttrs): number | null {
  const h = a.height;
  if (h && h.confidence >= MIN_CONF && typeof h.value === 'number') return h.value;
  const l = a.levels;
  if (l && l.confidence >= MIN_CONF && typeof l.value === 'number') return l.value * 3.1 + 1;
  return null;
}

/** A tree's known species, from any source we trust enough to count. */
function knownSpecies(a: ResolvedAttrs): Species | null {
  const s = a.species;
  if (s && s.confidence >= MIN_CONF && typeof s.value === 'string')
    return (FOREST_SPECIES as readonly string[]).includes(s.value) ? (s.value as Species) : null;
  return null;
}

/**
 * Summarise a Town's character from its resolved Facts (ADR-0014). Pure and
 * deterministic: input order does not matter, and output is quantized so that
 * small changes in Facts rarely change it.
 */
export function computeEssence(
  town: string,
  features: Iterable<{ kind: FeatureKind; attrs: ResolvedAttrs }>,
  opts: { biome?: ForestBiome } = {},
): Essence {
  const heights: number[] = [];
  const roofs = new Map<string, number>();
  const colours = new Map<string, number>();
  const props = new Map<string, number>();
  const species = new Map<string, number>();
  for (const f of features) {
    if (f.kind === 'landcover') continue; // ground, not a prop
    if (f.kind !== 'building') {
      if (f.kind === 'tree') {
        const s = knownSpecies(f.attrs);
        if (s) species.set(s, (species.get(s) ?? 0) + 1);
      }
      if (f.kind !== 'road') props.set(f.kind, (props.get(f.kind) ?? 0) + 1);
      continue;
    }
    const h = knownHeight(f.attrs);
    if (h !== null) heights.push(h);
    const r = f.attrs['roof.shape'];
    if (r && r.confidence >= MIN_CONF && typeof r.value === 'string')
      roofs.set(r.value, (roofs.get(r.value) ?? 0) + 1);
    const c = f.attrs.colour;
    if (c && c.confidence >= MIN_CONF && typeof c.value === 'string')
      colours.set(c.value, (colours.get(c.value) ?? 0) + 1);
  }

  heights.sort((a, b) => a - b);
  const at = (p: number) => heights[Math.min(heights.length - 1, Math.floor(p * heights.length))]!;
  const heightM =
    heights.length >= ESSENCE_MIN_SAMPLES
      ? { median: q(at(0.5), 0.5), p90: q(at(0.9), 0.5) }
      : { median: 0, p90: 0 };

  const roofTotal = [...roofs.values()].reduce((a, b) => a + b, 0);
  const roofShapes: Record<string, number> = {};
  if (roofTotal >= ESSENCE_MIN_SAMPLES) {
    for (const k of [...roofs.keys()].sort())
      roofShapes[k] = round(q(roofs.get(k)! / roofTotal, 0.05), 2);
  }

  const colourTotal = [...colours.values()].reduce((a, b) => a + b, 0);
  const palette =
    colourTotal >= ESSENCE_MIN_SAMPLES
      ? [...colours.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, 8)
          .map(([hex]) => hex)
      : [];

  const propFamilies: Record<string, number> = {};
  for (const k of [...props.keys()].sort()) propFamilies[k] = bucket(props.get(k)!);

  // The forest mix, once the Town has told us enough species to have one.
  const speciesTotal = [...species.values()].reduce((a, b) => a + b, 0);
  const forest: Record<string, number> = {};
  if (speciesTotal >= ESSENCE_MIN_SAMPLES) {
    for (const k of [...species.keys()].sort())
      forest[k] = round(q(species.get(k)! / speciesTotal, 0.05), 2);
  }

  return Essence.parse({
    town,
    palette,
    roofShapes,
    heightM,
    propFamilies,
    sampleCount: bucket(heights.length),
    ...(opts.biome ? { biome: opts.biome } : {}),
    ...(Object.keys(forest).length ? { forest } : {}),
  });
}

/**
 * Essence as generator params (`@essence.*`). They are statistics about the
 * place, not Facts about this Feature, so they carry imagined confidence.
 */
export function essenceParams(e: Essence | undefined): Record<string, number | string> {
  if (!e)
    return essenceParams({
      town: '',
      palette: [],
      roofShapes: {},
      heightM: { median: 0, p90: 0 },
      propFamilies: {},
      sampleCount: 0,
    });
  const out: Record<string, number | string> = {
    '@essence.samples': e.sampleCount,
    '@essence.height.median': e.heightM.median,
    '@essence.height.p90': e.heightM.p90,
    '@essence.palette.count': e.palette.length,
  };
  for (const shape of ['flat', 'gable', 'hip', 'shed'])
    out[`@essence.roof.${shape}`] = e.roofShapes[shape] ?? 0;
  // The forest mix: the Town's own species shares when it has enough, else the
  // biome's default character (ADR-0017). Every species always has a weight, so
  // generators can reference any of them.
  const hasForest = Object.keys(e.forest ?? {}).length > 0;
  const fallback = biomeMix(e.biome ?? 'temperate');
  for (const s of FOREST_SPECIES)
    out[`@essence.forest.${s}`] = hasForest ? (e.forest?.[s] ?? 0) : fallback[s];
  // Always 8 slots, so generators can reference any of them; unused slots get weight 0.
  for (let i = 0; i < 8; i++)
    out[`@essence.palette.${i}`] = e.palette[i] ?? e.palette[0] ?? '#ddd6c6';
  return out;
}
