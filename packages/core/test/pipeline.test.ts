import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { osmToFacts } from '../src/osm/to-facts';
import { resolveFacts } from '../src/facts/resolve';
import { buildBundle, type BundleFeature } from '../src/bundle/build';
import { cellsOfBlock } from '../src/geo/h3';
import type { OverpassResponse } from '../src/osm/overpass';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/overpass-zurich.json', import.meta.url), 'utf8'),
) as OverpassResponse & {
  block: string;
};

describe('OSM → Facts → Bundle', () => {
  it('builds every Cell of a dense block quickly and deterministically', async () => {
    const { features, facts } = osmToFacts(fixture, {
      block: fixture.block,
      observedAt: '2026-10-17T00:00:00.000Z',
    });
    const resolved = resolveFacts(facts);
    const stats: { cell: string; features: number; vertices: number; kb: number; ms: number }[] =
      [];
    for (const cell of cellsOfBlock(fixture.block)) {
      const fs: BundleFeature[] = features
        .filter((f) => f.anchorCell === cell)
        .map((f) => ({ id: f.id, kind: f.kind, attrs: resolved.get(f.id) ?? {} }));
      const t0 = performance.now();
      const a = await buildBundle({ cell, features: fs });
      const ms = performance.now() - t0;
      const b = await buildBundle({ cell, features: fs });
      expect(b.manifest.outputHash).toBe(a.manifest.outputHash);
      stats.push({
        cell,
        features: fs.length,
        vertices: a.manifest.vertexCount,
        kb: Math.round(a.glb.byteLength / 1024),
        ms: Math.round(ms),
      });
    }
    console.table(stats);
    expect(stats.reduce((s, x) => s + x.features, 0)).toBe(features.length);
    expect(Math.max(...stats.map((s) => s.ms))).toBeLessThan(2000);
  });
});
