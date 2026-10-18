// Fetch OSM for the ingest block around a lat/lng and summarise the Facts.
// Usage: pnpm ingest <lat> <lng>
import { blockBBox, cellAt, ingestBlockOf } from '../src/geo/h3';
import { fetchOverpass, overpassQuery } from '../src/osm/overpass';
import { osmToFacts } from '../src/osm/to-facts';

const [lat, lng] = process.argv.slice(2).map(Number);
if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error('usage: pnpm ingest <lat> <lng>');
  process.exit(1);
}
const cell = cellAt(lat, lng);
const block = ingestBlockOf(cell);
const res = await fetchOverpass(overpassQuery(blockBBox(block)));
const { features, facts } = osmToFacts(res, { block, observedAt: new Date().toISOString() });
const count = (xs: string[]) =>
  xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
console.log(`cell ${cell}  block ${block}  elements ${res.elements.length}`);
console.log('features', count(features.map((f) => f.kind)));
console.log('facts', count(facts.map((f) => f.attribute)));
