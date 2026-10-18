import { cellAt, cellCenter } from '../geo/h3';
import { localFrame } from '../geo/frame';
import type { ResolvedAttrs } from '../facts/resolve';
import type { BundleFeature } from '../bundle/build';

/** A Cell in central Zürich used by the demo lot and golden tests. */
export const DEMO_CELL = cellAt(47.3769, 8.5417);

const snap = (x: number) => Math.round(x * 1e7) / 1e7;

/**
 * A hand-made test lot showing every roof shape, an imagined building, roads,
 * and each prop. Coordinates are metres east/north of the Cell centre.
 */
export function demoLot(cell: string = DEMO_CELL): BundleFeature[] {
  const f = localFrame(cellCenter(cell));
  const ll = (e: number, n: number): [number, number] => {
    const p = f.unproject({ e, n });
    return [snap(p.lng), snap(p.lat)];
  };
  const osm = (value: unknown, confidence: number) => ({
    value,
    confidence,
    source: 'osm' as const,
  });
  const rect = (e: number, n: number, w: number, d: number) => [
    ll(e, n),
    ll(e + w, n),
    ll(e + w, n + d),
    ll(e, n + d),
  ];
  const house = (i: number, shape: string, extra: ResolvedAttrs = {}): BundleFeature => ({
    id: `osm:w${100 + i}`,
    kind: 'building',
    attrs: {
      footprint: osm(rect(-40 + i * 16, 8, 11, 9), 0.7),
      building: osm('house', 0.9),
      height: osm(9, 0.8),
      'roof.shape': osm(shape, 0.7),
      ...extra,
    },
  });
  return [
    house(0, 'flat'),
    house(1, 'gable', { colour: osm('#c98f6d', 0.6), 'roof.colour': osm('#5b5f66', 0.6) }),
    house(2, 'hip'),
    house(3, 'shed'),
    {
      // Nothing known but the outline: everything else is imagined, so it renders soft.
      id: 'osm:w200',
      kind: 'building',
      attrs: {
        footprint: osm([ll(30, 8), ll(52, 8), ll(52, 30), ll(42, 30), ll(42, 18), ll(30, 18)], 0.7),
      },
    },
    {
      id: 'osm:w201',
      kind: 'building',
      attrs: {
        footprint: osm(rect(-40, 34, 30, 14), 0.7),
        building: osm('apartments', 0.9),
        levels: osm(5, 0.6),
      },
    },
    {
      id: 'osm:w300:n1-n2',
      kind: 'road',
      attrs: { path: osm([ll(-60, 0), ll(60, 0)], 0.7), highway: osm('residential', 0.9) },
    },
    {
      id: 'osm:w301:n3-n4',
      kind: 'road',
      attrs: { path: osm([ll(-24, 1), ll(-24, 60)], 0.7), highway: osm('footway', 0.9) },
    },
    { id: 'osm:n400', kind: 'tree', attrs: { position: osm(ll(-10, -6), 0.7) } },
    { id: 'osm:n401', kind: 'tree', attrs: { position: osm(ll(4, -7), 0.7) } },
    { id: 'osm:n402', kind: 'tree', attrs: { position: osm(ll(20, -6), 0.7) } },
    { id: 'osm:n500', kind: 'bench', attrs: { position: osm(ll(-3, -6), 0.7) } },
    { id: 'osm:n501', kind: 'bench', attrs: { position: osm(ll(12, -6), 0.7) } },
    { id: 'osm:n600', kind: 'streetlight', attrs: { position: osm(ll(-30, -5), 0.7) } },
    { id: 'osm:n601', kind: 'streetlight', attrs: { position: osm(ll(30, -5), 0.7) } },
  ];
}
