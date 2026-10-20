// Quantify motion between screenshot pairs: pixel counts and max channel diff.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const DIR = '/home/z/my-project/otherhere-lab/playtest-artifacts';
const pair = (a, b) => {
  const A = PNG.sync.read(readFileSync(`${DIR}/${a}.png`));
  const B = PNG.sync.read(readFileSync(`${DIR}/${b}.png`));
  let moved = 0;
  let max = 0;
  const rows = new Set();
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
      if (d > 2) {
        moved++;
        rows.add(y);
      }
      max = Math.max(max, d);
    }
  }
  const total = A.width * A.height;
  return {
    moved,
    total,
    share: +(moved / total).toFixed(4),
    maxChannelDiff: max,
    rowsTouched: rows.size,
    rowBand: [Math.min(...rows), Math.max(...rows)],
  };
};

for (const [name, a, b] of [
  ['calm pair (wind 0.000)', 'sitka-street-calm-1', 'sitka-street-calm-2'],
  ['wind pair (wind 0.455)', 'sitka-street-wind-1', 'sitka-street-wind-2'],
  ['zurich gale (wind 0.91)', 'zurich-street-gale-1', 'zurich-street-gale-2'],
]) {
  console.log(name, JSON.stringify(pair(a, b)));
}
