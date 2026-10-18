import { describe, expect, it } from 'vitest';
import { buildBundle, bundleInputsHash } from '../src/bundle/build';
import { demoLot, DEMO_CELL } from '../src/demo/lot';
import { readGlbJson } from '../src/glb/write';
import { BUILTIN_GENERATORS } from '../src/generators';
import { BundleManifest } from '../src/schema/bundle';
import GOLDEN from '../src/demo/golden.json';

describe('built-in generators', () => {
  it('cover every Feature kind', () => {
    const kinds = new Set(BUILTIN_GENERATORS.flatMap((g) => g.appliesTo));
    expect([...kinds].sort()).toEqual(['bench', 'building', 'road', 'streetlight', 'tree']);
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
    expect(manifest.featureCount).toBe(demoLot().length);
  });
});
