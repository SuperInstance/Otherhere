import { describe, expect, it } from 'vitest';
import { buildBundle, bundleInputsHash } from '../src/bundle/build';
import { demoLot, DEMO_CELL } from '../src/demo/lot';
import { readGlbJson } from '../src/glb/write';
import { BUILTIN_GENERATORS } from '../src/generators';
import { BundleManifest } from '../src/schema/bundle';
import { FOREST_SPECIES, FOREST_BIOMES, RAINFOREST_BOX } from '../src/forest/species';
import { cellAt } from '../src/geo/h3';
import { computeEssence } from '../src/essence/compute';
import { REGION_BOX, REGION_PRIORS, GENERIC_PRIOR } from '../src/essence/region';
import GOLDEN from '../src/demo/golden.json';

describe('built-in generators', () => {
  it('cover every Feature kind a generator can draw', () => {
    const kinds = new Set(BUILTIN_GENERATORS.flatMap((g) => g.appliesTo));
    expect([...kinds].sort()).toEqual(['bench', 'building', 'road', 'streetlight', 'tree']);
  });

  it('leaves landcover to the imagination: it is an input, not a drawing', () => {
    // ADR-0017: landcover Features grow the imagined forest; they have no
    // generator of their own and contribute no geometry of their own.
    expect(BUILTIN_GENERATORS.some((g) => g.appliesTo.includes('landcover'))).toBe(false);
  });
});

describe('buildBundle (invariants 1 and 2)', () => {
  it('is deterministic: same inputs give byte-identical GLBs', async () => {
    const a = await buildBundle({ cell: DEMO_CELL, features: demoLot() });
    const b = await buildBundle({ cell: DEMO_CELL, features: [...demoLot()].reverse() });
    expect(b.manifest.outputHash).toBe(a.manifest.outputHash);
    expect(b.manifest.inputsHash).toBe(a.manifest.inputsHash);
    expect(BundleManifest.parse(a.manifest)).toBeTruthy();
  });

  it('pins golden hashes for the demo lot', async () => {
    // The same bytes are asserted in the Workers runtime (apps/edge) and the browser (apps/client).
    // A change here means every Bundle changes: bump INTERPRETER_VERSION or a generator version.
    expect(DEMO_CELL).toBe(GOLDEN.cell);
    const { manifest } = await buildBundle({ cell: DEMO_CELL, features: demoLot() });
    expect({
      inputsHash: manifest.inputsHash,
      outputHash: manifest.outputHash,
      vertexCount: manifest.vertexCount,
      featureCount: manifest.featureCount,
    }).toEqual({
      inputsHash: GOLDEN.inputsHash,
      outputHash: GOLDEN.outputHash,
      vertexCount: GOLDEN.vertexCount,
      featureCount: GOLDEN.featureCount,
    });
  });

  it('inputs hash changes when a Fact changes', async () => {
    const lot = demoLot();
    const h1 = await bundleInputsHash({ cell: DEMO_CELL, features: lot });
    const changed = lot.map((f) =>
      f.id === 'osm:w100'
        ? {
            ...f,
            attrs: { ...f.attrs, height: { value: 12, confidence: 0.8, source: 'osm' as const } },
          }
        : f,
    );
    expect(await bundleInputsHash({ cell: DEMO_CELL, features: changed })).not.toBe(h1);
  });

  it('writes a valid GLB with feature ranges and the confidence attribute', async () => {
    const { glb, manifest } = await buildBundle({ cell: DEMO_CELL, features: demoLot() });
    const json = readGlbJson(glb) as {
      meshes: { primitives: { attributes: Record<string, number> }[] }[];
      extras: { otherhere: { features: { id: string }[]; cell: string } };
    };
    expect(Object.keys(json.meshes[0]!.primitives[0]!.attributes).sort()).toEqual([
      'COLOR_0',
      'NORMAL',
      'POSITION',
      '_CONFIDENCE',
    ]);
    expect(json.extras.otherhere.cell).toBe(DEMO_CELL);
    expect(json.extras.otherhere.features.map((f) => f.id)).toContain('osm:w200');
    // Only the drawable Features are drawn now: the imagined forest left the
    // build (ADR-0017, amended 2026-10-22), so no `gen:` ranges ever appear.
    const drawn = demoLot().filter((f) => f.kind !== 'landcover').length;
    expect(json.extras.otherhere.features.some((f) => f.id.startsWith('gen:'))).toBe(false);
    expect(manifest.featureCount).toBe(drawn);
  });

  it('carries the forest as data: landcover rings and the species mix', async () => {
    // The display forest reads the extras the way it used to read imagined
    // trees (ADR-0017, amended): zones in the Cell's local frame, the mix over
    // every species, both covered by the inputs hash.
    const { glb } = await buildBundle({ cell: DEMO_CELL, features: demoLot() });
    const json = readGlbJson(glb) as {
      extras: {
        otherhere: {
          forest: {
            mix: Record<string, number>;
            zones: { id: string; cover: string; ring: number[] }[];
          };
        };
      };
    };
    const { mix, zones } = json.extras.otherhere.forest;
    // The demo lot's wood and scrub patch, as rings — the same polygons the
    // imagined forest used to grow from, and the meadows that stay open.
    expect(zones.map((z) => [z.id, z.cover]).sort()).toEqual([
      ['osm:w400', 'forest'],
      ['osm:w401', 'scrub'],
    ]);
    for (const z of zones) {
      expect(z.ring.length).toBeGreaterThanOrEqual(6); // a flat e/n pair list
      expect(z.ring.length % 2).toBe(0);
    }
    // The demo Cell is temperate with no Essence: the biome's mix, over every
    // species the vocabulary knows. (The GLB's JSON chunk is canonical, so the
    // keys arrive sorted; the build itself is order-independent either way.)
    expect([...Object.keys(mix)].sort()).toEqual([...FOREST_SPECIES].sort());
    expect(mix.broadleaf).toBe(1);
    expect(mix.hemlock).toBe(0);
  });

  it("keeps a wild Cell's Bundle a sketch, not a scan of every stem", async () => {
    // The forest advice's headline number: a wild rainforest Cell with no
    // Facts built ~1.57 MB of imagined trees. Now it is ground and extras —
    // kilobytes the display forest turns into instanced trees client-side.
    const SITKA = cellAt(57.0537, -135.33);
    const { glb, manifest } = await buildBundle({ cell: SITKA, features: [] });
    expect(manifest.featureCount).toBe(0);
    expect(glb.byteLength).toBeLessThan(50_000);
  });

  it('covers the forest extras in the content address', async () => {
    // A changed ring, a changed cover and a changed Town mix must all move the
    // inputs hash, or old Cells would keep serving a stale forest.
    const lot = demoLot();
    const base = await bundleInputsHash({ cell: DEMO_CELL, features: lot });
    const moved = lot.map((f) =>
      f.id === 'osm:w400'
        ? {
            ...f,
            attrs: {
              ...f.attrs,
              footprint: {
                value: (f.attrs.footprint!.value as number[][]).slice(0, -1),
                confidence: 0.7,
                source: 'osm' as const,
              },
            },
          }
        : f,
    );
    expect(await bundleInputsHash({ cell: DEMO_CELL, features: moved })).not.toBe(base);
    // A Town that has found its own voice changes the forest the extras carry.
    const spoken = computeEssence('t', [
      ...Array.from({ length: 8 }, () => ({
        kind: 'tree' as const,
        attrs: { species: { value: 'spruce', confidence: 0.9, source: 'osm' as const } },
      })),
    ]);
    const essenced = await bundleInputsHash({
      cell: DEMO_CELL,
      features: lot,
      essence: spoken,
    });
    expect(essenced).not.toBe(base);
  });

  it('covers the fixed lookup tables in the content address (review P0 #3)', async () => {
    // The scenario: someone edits a wall colour in the region table. Only the
    // region *code* was hashed, so the address — and so the GLB R2 serves
    // under it — stayed put while the client rebuilt different bytes: the
    // world showed fewer than n/n verified. The tables are hashed as data now,
    // so any edit must move the address the way a Fact change does. The demo
    // Cell is temperate with no region on purpose: the coverage is
    // unconditional, exactly so no dependency analysis is ever needed.
    const input = { cell: DEMO_CELL, features: demoLot() };
    const before = await bundleInputsHash(input);
    // Each edit is what a PR touching that table looks like; each restore
    // holds the hash to its old value, proving it is a pure function of the
    // tables and not of the order the edits ran in.
    const edits: [name: string, edit: () => () => void][] = [
      [
        'a region wall colour',
        () => {
          const p = REGION_PRIORS['southeast-alaska'] as unknown as {
            wallColours: string[];
          };
          const was = p.wallColours;
          p.wallColours = ['#ffffff'];
          return () => {
            p.wallColours = [...was];
          };
        },
      ],
      [
        'the generic prior pitch',
        () => {
          const p = GENERIC_PRIOR as unknown as { pitch: { min: number } };
          const was = p.pitch.min;
          p.pitch.min = 0.3;
          return () => {
            p.pitch.min = was;
          };
        },
      ],
      [
        'the region box',
        () => {
          const b = REGION_BOX as unknown as { north: number };
          const was = b.north;
          b.north = 61;
          return () => {
            b.north = was;
          };
        },
      ],
      [
        'a forest biome mix',
        () => {
          const b = FOREST_BIOMES.temperate as unknown as { mix: Record<string, number> };
          const was = b.mix;
          b.mix = { hemlock: 0.5, broadleaf: 0.5 };
          return () => {
            b.mix = { ...was };
          };
        },
      ],
      [
        'the rainforest box',
        () => {
          const b = RAINFOREST_BOX as unknown as { west: number };
          const was = b.west;
          b.west = -147;
          return () => {
            b.west = was;
          };
        },
      ],
    ];
    for (const [name, edit] of edits) {
      const restore = edit();
      try {
        expect(await bundleInputsHash(input), name).not.toBe(before);
      } finally {
        restore();
      }
    }
    expect(await bundleInputsHash(input)).toBe(before); // every restore held
  });
});
