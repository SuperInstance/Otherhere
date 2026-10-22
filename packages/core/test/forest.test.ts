import { describe, expect, it } from 'vitest';
import {
  FOREST_SPECIES,
  FOREST_BIOMES,
  biomeMix,
  forestBiome,
  pickSpecies,
  speciesFromTags,
  type Species,
} from '../src/forest/species';
import { computeEssence, essenceParams, ESSENCE_MIN_SAMPLES } from '../src/essence/compute';
import type { ResolvedAttrs } from '../src/facts/resolve';
import type { FeatureKind } from '../src/schema/feature';

const osm = (value: unknown, confidence = 0.8) => ({
  value,
  confidence,
  source: 'osm' as const,
});

describe('species from tags (ADR-0017)', () => {
  it('recognises the species we can draw', () => {
    expect(speciesFromTags({ taxon: 'Tsuga heterophylla' })).toBe('hemlock');
    expect(speciesFromTags({ species: 'Picea sitchensis' })).toBe('spruce');
    expect(speciesFromTags({ genus: 'Alnus' })).toBe('alder');
    expect(speciesFromTags({ taxon: 'Rubus spectabilis' })).toBe('salmonberry');
    expect(speciesFromTags({ taxon: 'Callitropsis nootkatensis' })).toBe('cedar');
    expect(speciesFromTags({ taxon: 'yellow cedar' })).toBe('cedar');
    expect(speciesFromTags({ taxon: 'Xanthocyparis nootkatensis' })).toBe('cedar');
    expect(speciesFromTags({ taxon: 'Alnus sinuata' })).toBe('alder');
    expect(speciesFromTags({ taxon: 'sitka alder' })).toBe('alder');
  });

  it('narrows a mystery tree to a form, and ignores the rest', () => {
    expect(speciesFromTags({ leaf_type: 'broadleaved' })).toBe('broadleaf');
    expect(speciesFromTags({ leaf_type: 'needleleaved' })).toBeUndefined();
    expect(speciesFromTags({ taxon: 'Fagus sylvatica' })).toBeUndefined();
    expect(speciesFromTags({})).toBeUndefined();
  });
});

describe('biomes', () => {
  it('puts Sitka in the rainforest and Zürich in the temperate zone', () => {
    expect(forestBiome(57.05, -135.33)).toBe('pacific-rainforest');
    expect(forestBiome(47.3769, 8.5417)).toBe('temperate');
  });

  it('carries the observed mix around Sitka: ~70/25/5 big trees', () => {
    const mix = biomeMix('pacific-rainforest');
    expect(mix.hemlock).toBeCloseTo(0.7);
    expect(mix.spruce).toBeCloseTo(0.25);
    expect(mix.cedar).toBeCloseTo(0.05);
    expect(FOREST_BIOMES.temperate.wild).toBe(false);
    expect(FOREST_BIOMES['pacific-rainforest'].wild).toBe(true);
  });
});

describe('pickSpecies', () => {
  it('is a function of the one draw it is given (invariant 2)', () => {
    const w = biomeMix('pacific-rainforest');
    for (const r of [0, 0.1, 0.5, 0.7, 0.99]) {
      expect(pickSpecies(r, w)).toBe(pickSpecies(r, w));
      expect(FOREST_SPECIES).toContain(pickSpecies(r, w));
    }
  });

  it('respects weights: a species with all the mass takes every draw', () => {
    for (let i = 0; i < 64; i++) expect(pickSpecies(i / 64, { cedar: 1 })).toBe('cedar');
  });

  it('never picks a zero-weight species, and says nothing when nothing grows', () => {
    for (let i = 0; i < 64; i++) {
      const s = pickSpecies(i / 64, { hemlock: 0, spruce: 0.5, cedar: 0.5 });
      expect(s === 'spruce' || s === 'cedar').toBe(true);
    }
    expect(pickSpecies(0.5, {})).toBeNull();
  });
});

describe('the forest as Essence (ADR-0014)', () => {
  const tree = (
    species: Species,
    confidence = 0.9,
  ): { kind: FeatureKind; attrs: ResolvedAttrs } => ({
    kind: 'tree',
    attrs: { species: osm(species, confidence) },
  });

  it('says nothing about the mix until the Town has named enough trees', () => {
    const few = computeEssence(
      't',
      Array.from({ length: ESSENCE_MIN_SAMPLES - 1 }, () => tree('hemlock')),
    );
    expect(few.forest).toBeUndefined();
    const unsure = computeEssence(
      't',
      Array.from({ length: 20 }, () => tree('hemlock', 0.2)),
    );
    expect(unsure.forest).toBeUndefined();
  });

  it('quantises the observed mix', () => {
    const e = computeEssence('t', [
      ...Array.from({ length: 10 }, () => tree('hemlock')),
      ...Array.from({ length: 10 }, () => tree('spruce')),
    ]);
    expect(e.forest).toEqual({ hemlock: 0.5, spruce: 0.5 });
    // Quantized: one more hemlock among twenty-one does not move it.
    const e2 = computeEssence('t', [
      ...Array.from({ length: 11 }, () => tree('hemlock')),
      ...Array.from({ length: 10 }, () => tree('spruce')),
    ]);
    expect(e2.forest).toEqual(e.forest);
  });

  it('exposes every species to generators, falling back to the biome', () => {
    const none = essenceParams(computeEssence('t', [tree('hemlock')]));
    const rainforest = essenceParams(
      computeEssence('t', [tree('hemlock')], { biome: 'pacific-rainforest' }),
    );
    expect(none['@essence.forest.hemlock']).toBe(0); // temperate default: no conifers
    expect(rainforest['@essence.forest.hemlock']).toBeCloseTo(0.7);
    expect(rainforest['@essence.forest.spruce']).toBeCloseTo(0.25);
    for (const s of FOREST_SPECIES) expect(rainforest[`@essence.forest.${s}`]).toBeDefined();
    // And a Town that has spoken replaces the biome's voice.
    const own = essenceParams(
      computeEssence(
        't',
        Array.from({ length: 8 }, () => tree('spruce')),
        {
          biome: 'pacific-rainforest',
        },
      ),
    );
    expect(own['@essence.forest.spruce']).toBe(1);
    expect(own['@essence.forest.hemlock']).toBe(0);
  });

  it('is independent of input order', () => {
    const fs = [tree('hemlock'), tree('spruce'), tree('cedar'), tree('alder'), tree('salmonberry')];
    expect(computeEssence('t', [...fs].reverse()).forest).toEqual(computeEssence('t', fs).forest);
  });
});
