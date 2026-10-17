// Records an Overpass response for the demo block as a test fixture.
// Run: pnpm --filter @otherhere/core exec tsx test/fixtures/record.ts
import { writeFileSync } from 'node:fs';
import { blockBBox, ingestBlockOf } from '../../src/geo/h3';
import { DEMO_CELL } from '../../src/demo/lot';
import { fetchOverpass, overpassQuery } from '../../src/osm/overpass';

const block = ingestBlockOf(DEMO_CELL);
const json = await fetchOverpass(overpassQuery(blockBBox(block)), {
  endpoints: [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
  ],
});
writeFileSync(
  new URL('./overpass-zurich.json', import.meta.url),
  JSON.stringify({ block, ...json }),
);
console.log(block, json.elements.length, 'elements');
