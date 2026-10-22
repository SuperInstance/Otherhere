/**
 * A Town's built region (ADR-0014's coordinate-derived priors, the building
 * half of what `biome` is to the forest): the character a place's imagined
 * buildings take where no Fact and no Town sample speaks. The roadmap's
 * Southeast Alaska table — steep gables and sheds, metal roofs, painted wood
 * siding — so an unseen shed in Sitka stops coming out as a flat white box.
 *
 * Like the biome, the region is decided by a coarse box over the Town's
 * coordinates (satellite inference is a later rung), it is quantized by being
 * a fixed table, and it reaches generators only through `@essence.region.*`
 * params with imagined confidence — the "soft until sure" wash still applies
 * to everything it colours.
 */

/** The regions a Town can sit in. One entry today; the table grows one row at a time. */
export const REGION_CODES = ['southeast-alaska'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

/** What a region says about imagined buildings. Fixed tables, quantized by construction. */
export type RegionPrior = {
  /** Roof-shape weights, used only where no Fact and no Town sample speaks. */
  roofWeights: { flat: number; gable: number; hip: number; shed: number };
  /** Roof pitch as a share of the footprint's width: steep, here. */
  pitch: { min: number; max: number };
  /** Pitched-roof colours, metal-led. */
  roofColours: readonly string[];
  /** Wall colours where the Town has no palette: painted wood siding. */
  wallColours: readonly string[];
};

/** Southeast Alaska: the Alexander Archipelago and the panhandle coast. */
export const REGION_PRIORS: Record<RegionCode, RegionPrior> = {
  'southeast-alaska': {
    roofWeights: { flat: 1, gable: 5, hip: 1, shed: 2 },
    pitch: { min: 0.38, max: 0.55 },
    roofColours: ['#5b5f66', '#7a2e2a', '#8c4a3c', '#4f545b'],
    wallColours: ['#8a4640', '#6d7b8a', '#d9d0bd', '#4f6350', '#8d908c'],
  },
};

/**
 * The generic pitch and pitched-roof colours a town with no region keeps: the
 * values `building.basic` carried as literals before regions existed, exposed
 * through the same param slots so the generator needs no branch for them.
 * These two slots are the only part of the old behaviour that moved verbatim —
 * the roof-shape chain around them changed for every town in the same PR
 * (the house rule's weights, and the small-`yes` footprint rule), so a town
 * without a region does not draw the roofs it drew before regions; see the
 * correction on round 13's note.
 */
export const GENERIC_PRIOR: Pick<RegionPrior, 'pitch' | 'roofColours'> = {
  pitch: { min: 0.28, max: 0.42 },
  roofColours: ['#8c4a3c', '#5b5f66', '#7a6a58', '#a0573f'],
};

/**
 * The panhandle box: Ketchikan (55.0, -131.6) to Yakutat (59.5, -139.7), west
 * to the outer coast. Coarse on purpose: a box is honest about what it knows,
 * and nobody's border runs that straight — and this one does not try to: the
 * east and north edges reach well past the Alaska–BC line, so Stewart and
 * Atlin (BC) and Carcross and Teslin (Yukon) sit in the Southeast Alaska
 * region along with the panhandle (region.test.ts pins those four, so the
 * comment cannot drift from the table). A fixed table like the priors: it
 * decides which region a Town sits in, so it is hashed into the content
 * address as data (review 2026-10-22 P0 #3).
 */
export const REGION_BOX = { south: 54.5, north: 60.4, west: -140.2, east: -129.6 } as const;

/** A Town's region from its coordinates: a coarse box, like `forestBiome`. */
export function regionOf(lat: number, lng: number): RegionCode | undefined {
  const b = REGION_BOX;
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east
    ? 'southeast-alaska'
    : undefined;
}
