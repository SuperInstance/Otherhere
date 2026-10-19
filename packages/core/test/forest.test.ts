import { describe, expect, it } from 'vitest';
import { cellAt, cellCenter } from '../src/geo/h3';
import { localFrame } from '../src/geo/frame';
import {
  FOREST_SPECIES,
  FOREST_BIOMES,
  biomeMix,
  forestBiome,
  pickSpecies,
  speciesFromTags,
  type Species,
} from '../src/forest/species';
import { FILL_SPACING_M, MAX_TREES_PER_CELL, imagineForest } from '../src/forest/imagine';
import { computeEssence, essenceParams, ESSENCE_MIN_SAMPLES } from '../src/essence/compute';
import { Fact } from '../src/schema/fact';
import type { ResolvedAttrs } from '../src/facts/resolve';
import type { BundleFeature } from '../src/bundle/build';
import type { FeatureKind } from '../src/schema/feature';

/** A Cell on Baranof Island, Sitka: pacific rainforest, hemlock over spruce. */
const SITKA = cellAt(57.0537, -135.33);
/** A Cell in central Zürich: temperate, empty Cells stay open. */
const ZURICH = cellAt(47.3769, 8.5417);

const osm = (value: unknown, confidence = 0.8) => ({
  value,
  confidence,
  source: 'osm' as const,
});

/** The same relative layout, anchored on any Cell's frame. */
function lotFor(cell: string): BundleFeature[] {
  const f = localFrame(cellCenter(cell));
  const snap = (x: number) => Math.round(x * 1e7) / 1e7;
  const ll = (e: number, n: number): [number, number] => {
    const p = f.unproject({ e, n });
    return [snap(p.lng), snap(p.lat)];
  };
  const rect = (e: number, n: number, w: number, d: number) => [
    ll(e, n),
    ll(e + w, n),
    ll(e + w, n + d),
    ll(e, n + d),
  ];
  return [
    // A wood west of the road, a scrub patch east of it.
    {
      id: 'osm:w900',
      kind: 'landcover',
      attrs: { footprint: osm(rect(-150, -80, 220, 160), 0.7), landcover: osm('forest', 0.9) },
    },
    {
      id: 'osm:w901',
      kind: 'landcover',
      attrs: { footprint: osm(rect(90, -40, 60, 80), 0.7), landcover: osm('scrub', 0.9) },
    },
    {
      id: 'osm:w910:n1-n2',
      kind: 'road',
      attrs: { path: osm([ll(-160, 0), ll(160, 0)], 0.7), highway: osm('residential', 0.9) },
    },
    {
      id: 'osm:w920',
      kind: 'building',
      attrs: { footprint: osm(rect(-120, 30, 12, 10), 0.7), building: osm('house', 0.9) },
    },
    // An observed tree that knows exactly where it is.
    {
      id: 'osm:n930',
      kind: 'tree',
      attrs: { position: osm(ll(-60, 60), 0.7), species: osm('spruce', 0.9) },
    },
  ];
}

/** Trees a lot imagines, with the jittered grid filtered out of the way. */
const treesFor = (cell: string, features = lotFor(cell)) => imagineForest(cell, features);

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

describe('imagineForest (ADR-0017, invariants 1 and 2)', () => {
  it('grows the same forest from the same Facts, whatever order they arrive in', () => {
    const a = treesFor(SITKA);
    const b = imagineForest(SITKA, [...lotFor(SITKA)].reverse());
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it('imagines trees as derived Features, never as Facts', () => {
    for (const t of treesFor(SITKA)) {
      expect(t.id).toMatch(/^gen:/);
      expect(t.kind).toBe('tree');
      expect(t.attrs.species?.source).toBe('imagined');
      expect(t.attrs.species?.confidence).toBe(0.3);
      expect(t.attrs.position?.source).toBe('imagined');
      expect(FOREST_SPECIES).toContain(t.attrs.species?.value as Species);
      // `imagined` is below every observed source and cannot pose as a Fact.
      expect(() =>
        Fact.parse({
          featureId: t.id,
          attribute: 'species',
          value: t.attrs.species?.value,
          source: 'imagined',
          confidence: 0.3,
          observedAt: '2026-10-19T00:00:00.000Z',
          version: 1,
        }),
      ).toThrow();
    }
  });

  it('caps a crowded Cell, thinning it instead of truncating one corner', () => {
    // A wild rainforest Cell has no landcover: the whole hexagon is the zone.
    const wild = imagineForest(SITKA, []);
    expect(wild.length).toBeGreaterThan(0);
    expect(wild.length).toBeLessThanOrEqual(MAX_TREES_PER_CELL);
    const e = wild.map((t) => (t.attrs.position!.value as [number, number])[0]);
    expect(Math.max(...e) - Math.min(...e)).toBeGreaterThan(0.002); // spread over the Cell
  });

  it('keeps trees out of the road, the buildings, and the observed tree', () => {
    const f = localFrame(cellCenter(SITKA));
    const trees = treesFor(SITKA);
    const inWood = (t: BundleFeature) => {
      const p = f.project({
        lat: (t.attrs.position!.value as [number, number])[1]!,
        lng: (t.attrs.position!.value as [number, number])[0]!,
      });
      return p.e < -150 + 220 && p.e > -150 && p.n > -80 && p.n < 80; // inside the wood
    };
    const wood = trees.filter(inWood);
    expect(wood.length).toBeGreaterThan(20);
    for (const t of wood) {
      const [lng, lat] = t.attrs.position!.value as [number, number];
      const p = f.project({ lat, lng });
      expect(Math.abs(p.n)).toBeGreaterThanOrEqual(6.9); // ROAD_CLEARANCE_M
      const toHouse = Math.hypot(
        Math.max(-120 - p.e, 0, p.e + 108), // the house's rectangle
        Math.max(30 - p.n, 0, p.n - 40),
      );
      expect(toHouse).toBeGreaterThanOrEqual(6.9); // BUILDING_CLEARANCE_M
      expect(Math.hypot(p.e + 60, p.n - 60)).toBeGreaterThanOrEqual(3.4); // TREE_CLEARANCE_M
    }
  });

  it('grows only inside observed landcover in a temperate Town', () => {
    const f = localFrame(cellCenter(ZURICH));
    const trees = treesFor(ZURICH);
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) {
      const [lng, lat] = t.attrs.position!.value as [number, number];
      const p = f.project({ lat, lng });
      const inWood = p.e >= -150 && p.e <= 70 && p.n >= -80 && p.n <= 80;
      const inScrub = p.e >= 90 && p.e <= 150 && p.n >= -40 && p.n <= 40;
      expect(inWood || inScrub).toBe(true);
    }
    // No landcover at all, and a temperate Cell stays open ground.
    expect(imagineForest(ZURICH, [])).toEqual([]);
  });

  it('fills a wild rainforest Cell with the biome mix, hemlock over spruce', () => {
    const wild = imagineForest(SITKA, []);
    const count = (s: Species) => wild.filter((t) => t.attrs.species?.value === s).length;
    expect(count('hemlock') / wild.length).toBeGreaterThan(0.4);
    expect(count('hemlock')).toBeGreaterThan(count('spruce'));
    expect(count('spruce')).toBeGreaterThan(count('cedar'));
    // Shrubs only where the light is: the interior is conifer country.
    expect(count('salmonberry') / wild.length).toBeLessThan(0.1);
  });

  it('follows the Town Essence when it has its own forest character', () => {
    const planted = computeEssence('sitka', [], { biome: 'pacific-rainforest' });
    const essence = {
      ...planted,
      forest: { hemlock: 1 },
    };
    const wild = imagineForest(SITKA, [], essence);
    const hemlock = wild.filter((t) => t.attrs.species?.value === 'hemlock').length;
    // The interior follows the Essence; the disturbed edge still regrows alder.
    expect(hemlock / wild.length).toBeGreaterThan(0.8);
  });

  it('places alder and salmonberry where the ground is disturbed', () => {
    const f = localFrame(cellCenter(SITKA));
    const trees = treesFor(SITKA);
    const near = trees.filter((t) => {
      const [lng, lat] = t.attrs.position!.value as [number, number];
      const p = f.project({ lat, lng });
      return Math.abs(p.n) < 12 && p.e > -150 && p.e < 70; // the roadside strip in the wood
    });
    expect(near.length).toBeGreaterThan(4);
    const shrubs = near.filter((t) =>
      ['alder', 'salmonberry'].includes(String(t.attrs.species?.value)),
    );
    expect(shrubs.length).toBeGreaterThan(0);
    // And the scrub patch is alder and salmonberry, nothing else.
    const scrub = trees.filter((t) => {
      const [lng, lat] = t.attrs.position!.value as [number, number];
      const p = f.project({ lat, lng });
      return p.e >= 90 && p.e <= 150 && p.n >= -40 && p.n <= 40;
    });
    expect(scrub.length).toBeGreaterThan(4);
    for (const t of scrub) expect(['alder', 'salmonberry']).toContain(t.attrs.species?.value);
  });

  it('keeps meadows open', () => {
    const f = localFrame(cellCenter(SITKA));
    const snap = (x: number) => Math.round(x * 1e7) / 1e7;
    const ll = (e: number, n: number): [number, number] => {
      const p = f.unproject({ e, n });
      return [snap(p.lng), snap(p.lat)];
    };
    const meadow: BundleFeature[] = [
      {
        id: 'osm:w950',
        kind: 'landcover',
        attrs: {
          footprint: osm([ll(-100, -60), ll(100, -60), ll(100, 60), ll(-100, 60)], 0.7),
          landcover: osm('meadow', 0.9),
        },
      },
    ];
    expect(imagineForest(SITKA, meadow)).toEqual([]);
  });

  it('grows a different forest in a different Cell', () => {
    const other = cellAt(57.06, -135.32);
    const a = new Set(treesFor(SITKA).map((t) => t.id));
    const b = treesFor(other);
    expect(b.length).toBeGreaterThan(0);
    for (const t of b) expect(a.has(t.id)).toBe(false);
  });

  it('sketches a stand, not a scan: spacing coarser than the grid it thins', () => {
    expect(FILL_SPACING_M).toBeGreaterThan(6);
    expect(MAX_TREES_PER_CELL).toBeLessThanOrEqual(256);
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
