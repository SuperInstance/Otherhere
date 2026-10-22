import { describe, expect, it } from 'vitest';
import { computeEssence, essenceParams } from '../src/essence/compute';
import { GENERIC_PRIOR, regionOf, REGION_PRIORS } from '../src/essence/region';
import { bundleInputsHash, type BundleFeature } from '../src/bundle/build';
import { runGenerator } from '../src/geometry/interpret';
import { generatorSet } from '../src/generators';
import { cellAt, cellCenter } from '../src/geo/h3';
import { localFrame } from '../src/geo/frame';
import { hexToRgb, MeshBuilder } from '../src/geometry/mesh';
import { SRGB_TO_LINEAR_U16 } from '../src/geometry/srgb';
import type { ResolvedAttrs } from '../src/facts/resolve';
import type { LngLat } from '../src/schema/fact';

const SITKA = cellAt(57.0531, -135.3351);
const building = generatorSet().forKind('building')!;

const osm = (value: unknown, confidence = 0.8): ResolvedAttrs[string] => ({
  value,
  confidence,
  source: 'osm' as const,
});

/** A rectangle of w x d metres at a local offset, as a footprint Fact. */
function rect(
  e: number,
  n: number,
  w: number,
  d: number,
): { value: LngLat[]; confidence: number; source: 'osm' } {
  const f = localFrame(cellCenter(SITKA));
  const ll = (de: number, dn: number): LngLat => {
    const p = f.unproject({ e: de, n: dn });
    return [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))];
  };
  return {
    value: [ll(e, n), ll(e + w, n), ll(e + w, n + d), ll(e, n + d)],
    confidence: 0.7,
    source: 'osm',
  };
}

/**
 * A building whose type is `yes` and whose height is known (so the eave sits at
 * a fixed 6 m and the roof's shape reads straight off the mesh: a flat roof
 * caps at the eave, a pitched one rises above it).
 */
function yesBuilding(i: number, w = 10, d = 12): BundleFeature {
  return {
    id: `osm:yes${i}`,
    kind: 'building',
    attrs: {
      footprint: rect(-30 + (i % 8) * 12, -30 + Math.floor(i / 8) * 20, w, d),
      building: osm('yes', 0.9),
      height: osm(6, 0.8),
    },
  };
}

type Built = {
  /** Vertices within 2 cm of the top: a flat cap ring (12 here) vs a ridge or apex (6). */
  topCount: number;
  /** The roof's rise, as the gap between the top and the highest non-window
   *  level below it (the roof's base ring): the wall top for a pitched roof,
   *  the ground for a flat one (whose cap is the only non-window level up top). */
  rise: number;
  roofColour: number[];
  wallColours: Set<string>;
};

/** Run the building generator and read the shape off the mesh. The height Fact
 *  is the building's total — ridge included — so `maxY` cannot tell flat from
 *  pitched; the top level's vertex count and the roof-base level can. */
function build(f: BundleFeature, essence?: Parameters<typeof runGenerator>[4]): Built {
  const m = new MeshBuilder();
  runGenerator(building, f, localFrame(cellCenter(SITKA)), m, essence);
  const data = m.build();
  let maxY = -Infinity;
  for (let i = 0; i < data.positions.length; i += 3) maxY = Math.max(maxY, data.positions[i + 1]!);
  const WINDOW = u16('#3d5566');
  const isWindow = (i: number) =>
    Math.abs(data.colours[i * 4]! - WINDOW[0]!) < 3 &&
    Math.abs(data.colours[i * 4 + 1]! - WINDOW[1]!) < 3;
  let topCount = 0;
  let roofBase = -Infinity;
  const roofColour: number[] = [];
  const wallColours = new Set<string>();
  for (let i = 0; i < data.positions.length / 3; i++) {
    const y = data.positions[i * 3 + 1]!;
    const r = data.colours[i * 4]!;
    const g = data.colours[i * 4 + 1]!;
    const b = data.colours[i * 4 + 2]!;
    if (y > maxY - 0.02) {
      topCount++;
      roofColour.push(r, g, b);
    } else if (y < 5.5) wallColours.add(`${r},${g},${b}`);
    if (!isWindow(i) && y < maxY - 0.5 && y > roofBase) roofBase = y;
  }
  return { topCount, rise: maxY - roofBase, roofColour, wallColours };
}

/** A flat cap ring carries far more top vertices than a ridge or apex. */
const isPitched = (b: Built) => b.topCount <= 8;

/** True when a vertex-colour triple matches a hex within a small tolerance. */
const hasColour = (colours: Iterable<string>, hex: number[]) => {
  for (const c of colours) {
    const [r = 0, g = 0, b = 0] = c.split(',').map(Number);
    if (Math.abs(r - hex[0]!) < 3 && Math.abs(g - hex[1]!) < 3 && Math.abs(b - hex[2]!) < 3)
      return true;
  }
  return false;
};

/** The u16 linear triple a hex renders as, so tests speak the mesh's colours. */
const u16 = (hex: string): number[] => {
  const [r, g, b] = hexToRgb(hex);
  return [SRGB_TO_LINEAR_U16[r]!, SRGB_TO_LINEAR_U16[g]!, SRGB_TO_LINEAR_U16[b]!];
};

const REGION_ONLY_METAL = ['#7a2e2a', '#4f545b'].map(u16);
const PAINTED_WOOD = REGION_PRIORS['southeast-alaska']!.wallColours.map(u16);
const PASTELS = ['#efe6da', '#e8d9c4', '#d9b99b', '#c98f6d', '#b7c4c9', '#a9b59a', '#d7c6d6'].map(
  u16,
);

/** An Essence that says nothing but its region (a Town nobody has measured). */
const bare = (region?: 'southeast-alaska') => ({
  town: 't',
  palette: [],
  roofShapes: {},
  heightM: { median: 0, p90: 0 },
  propFamilies: {},
  sampleCount: 0,
  ...(region ? { region } : {}),
});

describe('regionOf (the built-region box)', () => {
  it('holds Southeast Alaska and nothing around it', () => {
    for (const [lat, lng] of [
      [57.0531, -135.3351], // Sitka
      [55.0375, -131.2559], // Ketchikan
      [58.3019, -134.4197], // Juneau
      [59.5469, -139.7272], // Yakutat
      [55.9182, -129.9894], // Hyder, the eastern edge
    ] as const)
      expect(regionOf(lat, lng)).toBe('southeast-alaska');
    for (const [lat, lng] of [
      [47.3769, 8.5417], // Zürich
      [49.2827, -123.1207], // Vancouver
      [61.2181, -149.9003], // Anchorage
      [54.2, -130.2], // Prince Rupert, just south of the line
    ] as const)
      expect(regionOf(lat, lng)).toBeUndefined();
  });

  it('over-reaches the border on purpose: Stewart, Atlin, Carcross, Teslin', () => {
    // The box is coarse, not the border (its comment says so, and this pins
    // it): the east and north edges take in four Canadian towns along with
    // the panhandle. If the box is ever tightened, this test and the comment
    // move together — a lookup-table edit also moves every content address.
    for (const [lat, lng] of [
      [55.9368, -129.9845], // Stewart, BC
      [59.5745, -133.7075], // Atlin, BC
      [60.1633, -134.3639], // Carcross, Yukon
      [60.1703, -132.7453], // Teslin, Yukon
    ] as const)
      expect(regionOf(lat, lng)).toBe('southeast-alaska');
  });
});

describe('the regional prior as Essence params', () => {
  it('computeEssence records the region it is given', () => {
    expect(computeEssence('t', [], { region: 'southeast-alaska' }).region).toBe('southeast-alaska');
    expect(computeEssence('t', []).region).toBeUndefined();
  });

  it('exposes the region table to generators, imagined and quantized by construction', () => {
    const p = essenceParams(computeEssence('t', [], { region: 'southeast-alaska' }));
    expect(p['@essence.region.present']).toBe(1);
    expect(p['@essence.region.roof.gable']).toBe(5);
    expect(p['@essence.region.roof.shed']).toBe(2);
    expect(p['@essence.region.pitch.min']).toBe(REGION_PRIORS['southeast-alaska']!.pitch.min);
    expect(p['@essence.region.roofcolour.0']).toBe('#5b5f66');
    expect(p['@essence.region.roofcolour.1']).toBe('#7a2e2a');
  });

  it("carries the pre-region pitch and roof-colour literals in a region's absence", () => {
    const p = essenceParams(undefined);
    expect(p['@essence.region.present']).toBe(0);
    expect(p['@essence.region.roof.gable']).toBe(0);
    // The pitch and pitched-roof colours building.basic carried as literals.
    expect(p['@essence.region.pitch.min']).toBe(0.28);
    expect(p['@essence.region.pitch.max']).toBe(0.42);
    expect(p['@essence.region.roofcolour.0']).toBe('#8c4a3c');
    expect(p['@essence.region.roofcolour.1']).toBe('#5b5f66');
    expect(p['@essence.region.roofcolour.2']).toBe('#7a6a58');
    expect(p['@essence.region.roofcolour.3']).toBe('#a0573f');
    expect(GENERIC_PRIOR.pitch).toEqual({ min: 0.28, max: 0.42 });
  });

  it('an Essence straight from storage gets its region derived into the content address', async () => {
    const features = [yesBuilding(0)];
    // A stored Essence that predates regions, in a Sitka Cell: the hash must
    // match the same Essence with the region written in — the derivation fills
    // exactly what a fresh computation would.
    const derived = await bundleInputsHash({ cell: SITKA, features, essence: bare() });
    const explicit = await bundleInputsHash({
      cell: SITKA,
      features,
      essence: bare('southeast-alaska'),
    });
    expect(derived).toBe(explicit);
  });
});

describe('the regional prior shapes imagined buildings', () => {
  const ids = Array.from({ length: 40 }, (_, i) => i);
  const pitchedShare = (essence?: Parameters<typeof build>[1], w = 10) => {
    let pitched = 0;
    for (const i of ids) if (isPitched(build(yesBuilding(i, w, 12), essence))) pitched++;
    return pitched / ids.length;
  };

  it('a small unknown yes footprint is treated like a house, not a flat box', () => {
    // Weights gable 5 / hip 3 / shed 1 / flat 1: mostly pitched. Before the
    // rule, a `yes` footprint drew flat 5 / hip 1 — 31 of these 40 came out flat.
    expect(pitchedShare(undefined)).toBeGreaterThanOrEqual(0.6);
  });

  it('a large unknown footprint keeps flat or hip', () => {
    expect(pitchedShare(undefined, 30)).toBeLessThanOrEqual(0.4);
  });

  it('a large unknown footprint keeps flat or hip in a region too (review P1 #4)', () => {
    // The region branch ran before the house / small-yes rule, so every
    // unknown building in Southeast Alaska, of any size, was pitched 8 times
    // in 9 — a 3,000 m2 cannery got a gable. The region now speaks only where
    // the generic rule would imagine a roof at all: it changes the weights of
    // imagining, never which buildings get imagined.
    expect(pitchedShare(bare('southeast-alaska'), 30)).toBeLessThanOrEqual(0.4);
    // And the region still pitches what it should: the small ones (the rule
    // above the large one, re-read through the region's weights).
    expect(pitchedShare(bare('southeast-alaska'))).toBeGreaterThanOrEqual(0.75);
  });

  it('a region imagines steep, metal-roofed, painted-wood buildings where nothing is known', () => {
    const region = bare('southeast-alaska');
    // Gable-led and shed-heavy: 8 of 9 weights are pitched shapes.
    expect(pitchedShare(region)).toBeGreaterThanOrEqual(0.75);

    // Steeper: the same pitched draws rise higher under the region's pitch
    // (width 4 keeps both ranges under the height cap, so the rise is the pitch).
    const meanRise = (essence?: Parameters<typeof build>[1]) => {
      let s = 0;
      let n = 0;
      for (const i of ids) {
        const b = build(yesBuilding(i, 4, 15), essence);
        if (isPitched(b)) {
          s += b.rise;
          n++;
        }
      }
      return s / Math.max(1, n);
    };
    expect(meanRise(region) - meanRise(undefined)).toBeGreaterThan(0.3);

    // Metal roofs: region-only colours appear where the generic list has none.
    let regionOnlyMetals = 0;
    for (const i of ids) {
      const { roofColour } = build(yesBuilding(i), region);
      const triple = `${roofColour[0]},${roofColour[1]},${roofColour[2]}`;
      if (REGION_ONLY_METAL.some((m) => hasColour([triple], m))) regionOnlyMetals++;
    }
    expect(regionOnlyMetals).toBeGreaterThanOrEqual(6);

    // Painted-wood walls replace the pastel defaults, for every building.
    for (const i of ids)
      expect(
        PAINTED_WOOD.some((m) => hasColour(build(yesBuilding(i), region).wallColours, m)),
        `yes${i} walls not painted wood`,
      ).toBe(true);

    // And without the region, the walls stay pastel (the generic path unchanged).
    for (const i of ids)
      expect(
        PASTELS.some((m) => hasColour(build(yesBuilding(i)).wallColours, m)),
        `yes${i} walls not pastel`,
      ).toBe(true);
  });

  it("the Town's own samples outrank the region", () => {
    const town = {
      ...bare('southeast-alaska'),
      roofShapes: { flat: 1 },
      sampleCount: 25,
    };
    // A Town that measures its roofs as all flat keeps all-flat imagination,
    // region or no region.
    for (const i of ids)
      expect(isPitched(build(yesBuilding(i), town)), `yes${i} pitched`).toBe(false);
  });

  it('Facts outrank everything', () => {
    const known: BundleFeature = {
      ...yesBuilding(0),
      attrs: { ...yesBuilding(0).attrs, 'roof.shape': osm('flat', 0.9) },
    };
    expect(isPitched(build(known, bare('southeast-alaska')))).toBe(false);
  });
});
