// Re-bake a place Capsule from a fresh OSM ingest: fetch every ingest Block
// the Capsule's Cells touch, convert with the current osmToFacts (landcover
// relations included), sweep a grown bbox for landcover alone (forest
// polygons anchor wherever their centroid falls — often outside the Blocks —
// and makePlaceCapsule keeps the ones whose rings intersect the Cells),
// recompute Essences, and write a new Capsule with the same id/title/view
// and the current generator refs. The Capsule format is a snapshot of Facts,
// so re-baking is how ingest improvements (and generator bumps) reach a
// shipped place — the postcard loop Casey affirmed 2026-10-24: refine,
// re-capture, replace the file, push.
// Usage: pnpm --filter @otherhere/core exec tsx scripts/rebake-capsule.ts <in.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { Capsule } from '../src/schema/capsule';
import { blockBBox, cellAt, cellBoundary, ingestBlockOf, townOf } from '../src/geo/h3';
import {
  fetchOverpass,
  overpassLandcoverQuery,
  overpassQuery,
  type OverpassResponse,
} from '../src/osm/overpass';
import { osmToFacts } from '../src/osm/to-facts';
import { resolveFacts, type ResolvedAttrs } from '../src/facts/resolve';
import { computeEssence } from '../src/essence/compute';
import { regionOf } from '../src/essence/region';
import { forestBiome } from '../src/forest/species';
import { generatorSet } from '../src/generators';
import { makePlaceCapsule } from '../src/capsule/place';
import type { Fact } from '../src/schema/fact';
import type { Feature } from '../src/schema/feature';
import type { Essence } from '../src/schema/world';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: rebake-capsule.ts <in.json> <out.json>');
  process.exit(1);
}
const old = Capsule.parse(JSON.parse(readFileSync(inPath, 'utf8')));
const observedAt = new Date().toISOString();

const blocks = [...new Set(old.cells.map((c) => ingestBlockOf(c)))];
const features = new Map<string, Feature>();
let facts: Fact[] = [];
for (const block of blocks) {
  // Landcover relations carry their full member geometry (multipolygons are
  // thousands of nodes), so the ingest timeouts sit far above the
  // interactive defaults.
  const query = overpassQuery(blockBBox(block)).replace('[timeout:25]', '[timeout:180]');
  const res = await fetchOverpass(query, { timeoutMs: 240_000 });
  const got = osmToFacts(res, { block, observedAt });
  for (const f of got.features) features.set(f.id, f);
  facts.push(...got.facts);
  console.log(
    `block ${block}: ${res.elements.length} elements -> ${got.features.length} features, ${got.facts.length} facts`,
  );
}

// The landcover sweep: one query for landcover alone over the Cells' bbox
// grown by a margin, converted per candidate Block (osmToFacts gates by the
// anchor's Block; running it once per Block present in the response recovers
// every polygon, wherever it anchors). Its landcover replaces the Blocks'
// own — the sweep's bbox covers theirs, and both conversions are identical.
{
  const pts = old.cells.flatMap((c) => cellBoundary(c));
  const m = 0.03; // ~3 km: forest polygons near a town are rarely anchored further out
  const bb = {
    south: Math.min(...pts.map((p) => p.lat)) - m,
    west: Math.min(...pts.map((p) => p.lng)) - m,
    north: Math.max(...pts.map((p) => p.lat)) + m,
    east: Math.max(...pts.map((p) => p.lng)) + m,
  };
  const query = overpassLandcoverQuery(bb).replace('[timeout:25]', '[timeout:180]');
  const res: OverpassResponse = await fetchOverpass(query, { timeoutMs: 240_000 });
  const firstPoint = (el: OverpassResponse['elements'][number]) => {
    const g =
      el.type === 'node'
        ? { lat: el.lat, lon: el.lon }
        : el.type === 'way'
          ? el.geometry?.[0]
          : el.members?.find((x) => x.geometry?.length)?.geometry?.[0];
    return g ? { lat: g.lat, lng: g.lon } : undefined;
  };
  const candidates = new Set(blocks);
  for (const el of res.elements) {
    const p = firstPoint(el);
    if (p) candidates.add(ingestBlockOf(cellAt(p.lat, p.lng)));
  }
  const coverFeatures = new Map<string, Feature>();
  const coverFacts: Fact[] = [];
  for (const block of candidates) {
    const got = osmToFacts(res, { block, observedAt });
    for (const f of got.features)
      if (f.kind === 'landcover' && !coverFeatures.has(f.id)) {
        coverFeatures.set(f.id, f);
        coverFacts.push(...got.facts.filter((x) => x.featureId === f.id));
      }
  }
  const blockCoverIds = new Set(
    [...features.values()].filter((f) => f.kind === 'landcover').map((f) => f.id),
  );
  facts = facts.filter((f) => !blockCoverIds.has(f.featureId));
  for (const f of coverFeatures.values()) features.set(f.id, f);
  facts.push(...coverFacts);
  console.log(
    `landcover sweep: ${res.elements.length} elements over ${candidates.size} candidate blocks -> ${coverFeatures.size} landcover features`,
  );
}

if (!old.view) throw new Error('capsule has no view to preserve');
const centre = old.view.center;
const base = {
  id: old.id,
  title: old.title,
  scope: old.scope,
  createdAt: observedAt,
  cells: old.cells,
  center: centre,
  ...(old.view.pose ? { pose: old.view.pose } : {}),
  features: [...features.values()],
  facts,
  generators: await generatorSet().refs(),
};
// Two passes: the first shapes the snapshot (anchor rule + landcover
// inclusion); Essences are then computed from exactly what shipped, and the
// second pass attaches them.
const shaped = makePlaceCapsule(base);
const resolved = resolveFacts(shaped.snapshot.facts);
const byTown = new Map<string, { kind: Feature['kind']; attrs: ResolvedAttrs }[]>();
for (const f of shaped.snapshot.features) {
  const town = townOf(f.anchorCell);
  const list = byTown.get(town) ?? [];
  list.push({ kind: f.kind, attrs: resolved.get(f.id) ?? {} });
  byTown.set(town, list);
}
const essences: Record<string, Essence> = {};
for (const [town, list] of byTown)
  essences[town] = computeEssence(town, list, {
    biome: forestBiome(centre.lat, centre.lng),
    region: regionOf(centre.lat, centre.lng),
  });
const capsule = makePlaceCapsule({ ...base, essences });
writeFileSync(outPath, JSON.stringify(capsule, null, 2) + '\n');

const count = (xs: { kind: string }[]) =>
  xs.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
console.log('old:', old.snapshot.features.length, 'features', count(old.snapshot.features));
console.log('new:', capsule.snapshot.features.length, 'features', count(capsule.snapshot.features));
console.log(
  'new landcover:',
  capsule.snapshot.features.filter((f) => f.kind === 'landcover').map((f) => f.id),
);
console.log('facts:', old.snapshot.facts.length, '->', capsule.snapshot.facts.length);
console.log('wrote', outPath);
