import { resolveFacts } from '../facts/resolve';
import { Capsule } from '../schema/capsule';
import type { GeneratorRef } from '../schema/bundle';
import type { Fact, LngLat } from '../schema/fact';
import type { Feature } from '../schema/feature';
import type { Scope } from '../schema/scope';
import type { BundleFeature } from '../bundle/build';
import type { Essence } from '../schema/world';
import { cellBoundary, townOf } from '../geo/h3';
import { pointInRing, type P2 } from '../geometry/polygon';

/**
 * The Cells a landcover ring touches: every Cell the ring's area intersects,
 * not just the one its centroid anchors in. A forest polygon drawn around a
 * town crosses many Cells; before this, only the centroid's Cell knew about
 * it, so the forest appeared in one Cell and the town's own ground in the
 * next stayed "uncovered" — the display forest then fell back to imagining
 * trees across the town (the 2026-10-24 "trees everywhere" inversion, whose
 * ingest half this closes). Pure geometry on (lng, lat): a vertex of either
 * polygon inside the other, or any pair of edges crossing.
 */
export function landcoverCellsForRing(ring: LngLat[], cells: string[]): string[] {
  const r: P2[] = ring.map((p) => ({ e: p[0], n: p[1] }));
  const hit = (cell: string): boolean => {
    const b: P2[] = cellBoundary(cell).map((p) => ({ e: p.lng, n: p.lat }));
    if (r.some((p) => pointInRing(p, b))) return true;
    if (b.some((p) => pointInRing(p, r))) return true;
    for (let i = 0; i + 1 < r.length; i++)
      for (let j = 0; j < b.length; j++)
        if (segmentsCross(r[i]!, r[i + 1]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    return false;
  };
  return cells.filter(hit);
}

/** Proper segment crossing (touching counts: a shared edge is an intersection). */
function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const cross = (o: P2, p: P2, q: P2) => (p.e - o.e) * (q.n - o.n) - (p.n - o.n) * (q.e - o.e);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export type PlaceCapsuleInput = {
  id: string;
  title: string;
  scope: Scope;
  createdAt: string;
  cells: string[];
  center: { lat: number; lng: number };
  pose?: [number, number, number, number, number];
  features: Feature[];
  facts: Fact[];
  generators: GeneratorRef[];
  essences?: Record<string, Essence>;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A place postcard (ADR-0008): a snapshot of every Fact about the Features
 * anchored in its Cells, plus the generator versions that drew them. Bundles
 * are rebuilt from it, so it never ships meshes. Every place is also an arena.
 *
 * One exception to the anchor rule: a landcover Feature is also snapshotted
 * when its ring intersects a Capsule Cell, wherever it anchors. A forest
 * polygon is routinely bigger than a Cell — its centroid can sit streets
 * away from the ground it covers — so an anchor-only snapshot silently
 * drops the woods around a town (Sitka's capsule held exactly one of the
 * 133 landcover polygons its area carries). Landcover draws nothing; the
 * ring rides along so the fan-out in `capsuleBundleInputs` can speak in
 * every Cell it touches.
 */
export function makePlaceCapsule(input: PlaceCapsuleInput): Capsule {
  const cells = [...new Set(input.cells)];
  const inCells = new Set(cells);
  const footprints = new Map<string, LngLat[]>();
  for (const f of input.facts)
    if (f.attribute === 'footprint' && Array.isArray(f.value))
      footprints.set(f.featureId, f.value as LngLat[]);
  const features = input.features
    .filter(
      (f) =>
        inCells.has(f.anchorCell) ||
        (f.kind === 'landcover' &&
          ((fp) => fp !== undefined && landcoverCellsForRing(fp, cells).length > 0)(
            footprints.get(f.id),
          )),
    )
    .sort((a, b) => cmp(a.id, b.id));
  const ids = new Set(features.map((f) => f.id));
  const facts = input.facts
    .filter((f) => ids.has(f.featureId))
    .sort(
      (a, b) =>
        cmp(a.featureId, b.featureId) || cmp(a.attribute, b.attribute) || cmp(a.source, b.source),
    );
  return Capsule.parse({
    format: 'otherhere.capsule',
    formatVersion: 1,
    id: input.id,
    kind: 'place',
    title: input.title,
    scope: input.scope,
    createdAt: input.createdAt,
    cells,
    view: { center: input.center, ...(input.pose ? { pose: input.pose } : {}) },
    snapshot: {
      features,
      facts,
      generators: input.generators,
      ...(input.essences ? { essences: input.essences } : {}),
    },
    // A place postcard holds map Facts only: no imagery, so nothing to blur.
    // Captures (M2) must be blurred by the agent before they can be attached.
    privacy: { blurred: true },
    ownerIsKid: false,
  });
}

export type CapsuleCellInput = { features: BundleFeature[]; essence?: Essence };

/**
 * Per-Cell Bundle inputs, resolved from the snapshot exactly as the TownDO
 * resolves live Facts — with one deliberate divergence: landcover Features
 * are fanned out to every Cell their ring intersects (see
 * `landcoverCellsForRing`), because a Bundle's forest extras are read per
 * Cell while a forest does not respect Cell borders. Landcover draws no
 * geometry, so the fan-out changes only which Cells carry the zone in their
 * extras. The TownDO converges to the same inputs when its ingest fans out
 * the same way; until then a Capsule and the live Town may address the same
 * Cell differently where a ring crosses a border, by exactly those extras.
 */
export function capsuleBundleInputs(c: Capsule): Map<string, CapsuleCellInput> {
  const resolved = resolveFacts(c.snapshot.facts);
  const out = new Map<string, CapsuleCellInput>(
    c.cells.map((cell) => {
      const essence = c.snapshot.essences?.[townOf(cell)];
      return [cell, essence ? { features: [], essence } : { features: [] }];
    }),
  );
  for (const f of c.snapshot.features) {
    out
      .get(f.anchorCell)
      ?.features.push({ id: f.id, kind: f.kind, attrs: resolved.get(f.id) ?? {} });
  }
  // Landcover fan-out: the same Feature joins every intersected Cell's
  // inputs. Sorted afterwards so input order — and so Bundle bytes — stay
  // independent of fan-out discovery order (invariant 2).
  for (const f of c.snapshot.features) {
    if (f.kind !== 'landcover') continue;
    const fp = resolved.get(f.id)?.footprint;
    if (!fp || !Array.isArray(fp.value) || fp.value.length < 3) continue;
    const ring = fp.value as LngLat[];
    for (const cell of landcoverCellsForRing(ring, c.cells)) {
      const entry = out.get(cell);
      if (entry && !entry.features.some((x) => x.id === f.id))
        entry.features.push({ id: f.id, kind: f.kind, attrs: resolved.get(f.id) ?? {} });
    }
  }
  for (const entry of out.values()) entry.features.sort((a, b) => cmp(a.id, b.id));
  return out;
}

/** True if this build draws the Capsule with the same generators it was saved with. */
export function generatorsMatch(c: Capsule, current: GeneratorRef[]): boolean {
  const key = (g: GeneratorRef) => `${g.id}@${g.version}#${g.hash}`;
  const a = new Set(c.snapshot.generators.map(key));
  return current.length === a.size && current.every((g) => a.has(key(g)));
}
