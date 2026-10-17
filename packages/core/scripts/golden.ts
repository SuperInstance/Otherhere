// Regenerate src/demo/golden.json after an intentional output change
// (bump INTERPRETER_VERSION or a generator version first).
// Usage: pnpm --filter @otherhere/core exec tsx scripts/golden.ts
import { writeFileSync } from 'node:fs';
import { buildBundle } from '../src/bundle/build';
import { demoLot, DEMO_CELL } from '../src/demo/lot';

const { manifest } = await buildBundle({ cell: DEMO_CELL, features: demoLot() });
const golden = {
  cell: DEMO_CELL,
  featureCount: manifest.featureCount,
  inputsHash: manifest.inputsHash,
  outputHash: manifest.outputHash,
  vertexCount: manifest.vertexCount,
};
writeFileSync(
  new URL('../src/demo/golden.json', import.meta.url),
  JSON.stringify(golden, null, 2) + '\n',
);
console.log(golden);
