#!/usr/bin/env tsx
/**
 * Serve the Thor's capture registry to the renderer.
 *
 *   pnpm --filter @otherhere/assets exec tsx scripts/serve-captures.ts \
 *     --root /home/caseydigennaro/sitka-distill/pipeline --port 8098 \
 *     --places-dir /home/caseydigennaro/sitka-distill/Otherhere-src/apps/client/public/places
 */
import { createCaptureService } from '../src/server';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};

const root = arg('root', '/home/caseydigennaro/sitka-distill/pipeline');
const placesDir = arg('places-dir', '');
const port = Number(arg('port', '8098'));
const host = arg('host', '0.0.0.0');

const service = createCaptureService({
  root,
  ...(placesDir ? { placesDir } : {}),
  port,
  host,
});
await service.listen();

const tiers = service.files.size;
console.log(
  `capture service on http://${host}:${port}/places — ${service.registry.captures.length} captures, ${tiers} verified tiers`,
);
for (const capture of service.registry.captures) {
  console.log(
    `  ${capture.family}/${capture.version}  tiers: ${Object.keys(capture.tiers).join(', ')}`,
  );
}
if (service.placeAssets.files.size) {
  console.log(`  ${service.placeAssets.files.size} tiers vouched for by place files`);
}
const problems = [
  ...service.registry.problems.map((p) => `  ${p.capture}: ${p.reason}`),
  ...service.placeAssets.problems.map((p) => `  ${p.place}: ${p.reason}`),
];
if (problems.length) {
  console.log(`\n${problems.length} problems:`);
  for (const p of problems) console.log(p);
}
