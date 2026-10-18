import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeEssence, essenceParams, ESSENCE_MIN_SAMPLES } from '../src/essence/compute';
import { osmToFacts } from '../src/osm/to-facts';
import { resolveFacts, type ResolvedAttrs } from '../src/facts/resolve';
import { buildBundle, bundleInputsHash } from '../src/bundle/build';
import { demoLot, DEMO_CELL } from '../src/demo/lot';
import type { OverpassResponse } from '../src/osm/overpass';
import type { FeatureKind } from '../src/schema/feature';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/overpass-zurich.json', import.meta.url), 'utf8'),
) as OverpassResponse & { block: string };
const { features, facts } = osmToFacts(fixture, {
  block: fixture.block,
  observedAt: '2026-10-17T00:00:00.000Z',
});
const resolved = resolveFacts(facts);
const town = features.map((f) => ({ kind: f.kind, attrs: resolved.get(f.id) ?? {} }));

const osm = (value: unknown, confidence = 0.8) => ({ value, confidence, source: 'osm' as const });
const b = (attrs: ResolvedAttrs) => ({ kind: 'building' as FeatureKind, attrs });

describe('computeEssence (ADR-0014)', () => {
  it('summarises a real Town', () => {
    const e = computeEssence('861f8ed97ffffff', town);
    expect(e.sampleCount).toBeGreaterThan(ESSENCE_MIN_SAMPLES);
    expect(e.heightM.median).toBeGreaterThan(5);
    expect(e.heightM.p90).toBeGreaterThanOrEqual(e.heightM.median);
    expect(e.heightM.median % 0.5).toBe(0);
    expect(e.propFamilies.tree).toBeGreaterThan(10);
  });

  it('is independent of input order', () => {
    expect(computeEssence('t', [...town].reverse())).toEqual(computeEssence('t', town));
  });

  it('is quantized: one more similar building rarely changes it', () => {
    const base = Array.from({ length: 40 }, (_, i) =>
      b({ height: osm(10 + (i % 7)), 'roof.shape': osm(i % 3 ? 'gable' : 'hip') }),
    );
    expect(
      computeEssence('t', [...base, b({ height: osm(12.2), 'roof.shape': osm('gable') })]),
    ).toEqual(computeEssence('t', base));
  });

  it('says nothing until there are enough samples, and ignores unsure Facts', () => {
    const e = computeEssence('t', [
      b({ height: osm(30) }),
      b({ height: osm(30, 0.2) }),
      b({ 'roof.shape': osm('flat') }),
    ]);
    expect(e.heightM).toEqual({ median: 0, p90: 0 });
    expect(e.roofShapes).toEqual({});
    expect(e.palette).toEqual([]);
  });

  it('always exposes 8 palette slots to generators', () => {
    const p = essenceParams(
      computeEssence(
        't',
        Array.from({ length: 6 }, () => b({ colour: osm('#a5543f') })),
      ),
    );
    expect(p['@essence.palette.count']).toBe(1);
    expect(p['@essence.palette.7']).toBe('#a5543f');
  });
});

describe('Essence shapes imagined buildings', () => {
  const tall = computeEssence(
    't',
    Array.from({ length: 20 }, () =>
      b({ height: osm(30), 'roof.shape': osm('flat'), colour: osm('#4a4642') }),
    ),
  );

  it('is part of the content address', async () => {
    const lot = demoLot();
    expect(await bundleInputsHash({ cell: DEMO_CELL, features: lot, essence: tall })).not.toBe(
      await bundleInputsHash({ cell: DEMO_CELL, features: lot }),
    );
  });

  it("makes an unknown building take the Town's height, roof, and colour", async () => {
    // osm:w200 in the demo lot has only a footprint.
    const outline = demoLot().filter((f) => f.id === 'osm:w200');
    const plain = await buildBundle({ cell: DEMO_CELL, features: outline });
    const local = await buildBundle({ cell: DEMO_CELL, features: outline, essence: tall });
    const maxY = (glb: Uint8Array) => {
      // POSITION is the first buffer view; max is in the accessor (read via JSON).
      const json = JSON.parse(
        new TextDecoder().decode(
          glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true)),
        ),
      );
      return json.accessors[0].max[1] as number;
    };
    expect(maxY(plain.glb)).toBeLessThan(25);
    expect(maxY(local.glb)).toBeGreaterThan(22);
  });
});
