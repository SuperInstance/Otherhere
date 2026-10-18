// Re-pin the judge after a deliberate, human-reviewed change (invariant 6).
// Automated improvement processes must never run this.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { JUDGE_FILES } from '../src/index';

const root = new URL('../', import.meta.url);
const lock = Object.fromEntries(
  JUDGE_FILES.map((f) => [
    f,
    createHash('sha256')
      .update(readFileSync(new URL(f, root)))
      .digest('hex'),
  ]),
);
writeFileSync(new URL('JUDGE.lock.json', root), JSON.stringify(lock, null, 2) + '\n');
console.log(lock);
