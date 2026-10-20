import type { LngLat } from '../schema/fact';

/**
 * The species our tree generator can draw (ADR-0017). Species is a Fact like any
 * other attribute: OpenStreetMap `taxon`/`genus` tags, a capture, or an edit can
 * state it, and everything else imagines it from the place's forest character.
 */
export const FOREST_SPECIES = [
  'hemlock',
  'spruce',
  'cedar',
  'alder',
  'salmonberry',
  'broadleaf',
] as const;
export type Species = (typeof FOREST_SPECIES)[number];

/** How much we trust a species read from OSM taxonomy tags. */
export const SPECIES_CONFIDENCE = 0.9;

/**
 * Latin binomials, genera, and common names we recognise. Matched against
 * `taxon`, `species`, and `genus` after lower-casing; a genus match is only kept
 * when that genus has one plausible species in our scope.
 */
const TAXA: [RegExp, Species][] = [
  [/^tsuga( heterophylla)?$/, 'hemlock'],
  [/^western hemlock$/, 'hemlock'],
  [/^picea( sitchensis)?$/, 'spruce'],
  [/^sitka spruce$/, 'spruce'],
  [/^(callitropsis|chamaecyparis|xanthocyparis|cupressus) nootkatensis$/, 'cedar'],
  [/^yellow ?-?cedar$/, 'cedar'],
  [/^alaska(n)? ?-?cedar$/, 'cedar'],
  [/^nootka( ?false)? ?-?cypress$/, 'cedar'],
  [/^alnus( (rubra|sinuata|oregona|incana|viridis|crispa))?$/, 'alder'],
  [/^(red |sitka )?alder$/, 'alder'],
  [/^rubus( spectabilis)?$/, 'salmonberry'],
  [/^salmonberry$/, 'salmonberry'],
];

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The species an OpenStreetMap element's tags name, if we can draw it. */
export function speciesFromTags(tags: Record<string, string>): Species | undefined {
  for (const key of ['taxon', 'species', 'genus']) {
    const v = tags[key];
    if (!v) continue;
    const t = normalise(v);
    for (const [re, species] of TAXA) if (re.test(t)) return species;
  }
  // `leaf_type` narrows a mystery tree to a form, not a species.
  if (tags.leaf_type === 'broadleaved') return 'broadleaf';
  return undefined;
}

/**
 * Forest character by biome, as default species mixes (ADR-0014 vocabulary: this
 * is the Essence's fallback when a Town has too few species Facts to speak).
 * The `pacific-rainforest` numbers are the observed big-tree mix around Sitka:
 * ~70% western hemlock, ~25% Sitka spruce, ~5% yellow cedar, with alder on
 * disturbed edges and salmonberry in clearings and roadsides (placement, not
 * mix, decides those two).
 *
 * `wild` marks biomes where an unobserved cell is forest until Facts say
 * otherwise; in a temperate town an empty cell stays open ground.
 *
 * `windFloor` is the biome-band wind decision (enjoyability r2 → r3): the
 * r2 day census measured that calm-under-overcast leaves the pacific
 * rainforest's crowns still 96.6% of the day (Sitka tops out at 0.557, 3.4%
 * above 0.5) — the wind lives in temperate towns. But an ocean stand never
 * truly rests: the Alexander Archipelago under grey sky still breathes. The
 * floor 0.12 sits BELOW the status line's 'a breeze' word (0.3), so the
 * motion is felt, not named — and the temperate still-air contract
 * (overcast = exactly 0) holds everywhere else.
 */
export const FOREST_BIOMES = {
  temperate: { mix: { broadleaf: 1 }, wild: false, windFloor: 0 },
  'pacific-rainforest': { mix: { hemlock: 0.7, spruce: 0.25, cedar: 0.05 }, wild: true, windFloor: 0.12 },
} as const;
export type ForestBiome = keyof typeof FOREST_BIOMES;

/**
 * Coarse placeholder for the North Pacific coastal rainforest (the Alexander
 * Archipelago and the immediate mainland coast): the box from Cross Sound to
 * the Nass, inland to the Coast Mountains. Real ecoregion polygons replace this
 * when satellite inference lands; until then being generous costs only soft,
 * imagined trees, and the sea keeps them off the water.
 */
const RAINFOREST_BOX = { south: 54.5, north: 60.5, west: -148, east: -129.5 };

export function forestBiome(lat: number, lng: number): ForestBiome {
  const b = RAINFOREST_BOX;
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east
    ? 'pacific-rainforest'
    : 'temperate';
}

/** The biome's default mix, padded to every species (0 = never imagined). */
export function biomeMix(biome: ForestBiome): Record<Species, number> {
  const out = { hemlock: 0, spruce: 0, cedar: 0, alder: 0, salmonberry: 0, broadleaf: 0 };
  for (const [k, v] of Object.entries(FOREST_BIOMES[biome].mix)) out[k as Species] = v;
  return out;
}

/** A weighted species pick over `FOREST_SPECIES` order, from one RNG draw. */
export function pickSpecies(r: number, weights: Record<string, number>): Species | null {
  const w = FOREST_SPECIES.map((s) => ((weights[s] ?? 0) > 0 ? weights[s]! : 0));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i]! / total;
    if (r < acc) return FOREST_SPECIES[i]!;
  }
  return FOREST_SPECIES[w.length - 1]!;
}

/** Positions snapped like every other geometry input (ADR-0006). */
export const snapCoord = (v: number) => Math.round(v * 1e7) / 1e7;
export const snapped = (p: { lng: number; lat: number }): LngLat => [
  snapCoord(p.lng),
  snapCoord(p.lat),
];
