#!/usr/bin/env tsx
/**
 * Serve the Thor's capture registry to the renderer.
 *
 *   pnpm --filter @otherhere/assets exec tsx scripts/serve-captures.ts \
 *     --root /home/caseydigennaro/sitka-distill/pipeline --port 8098
 */
import { createCaptureService } from '../src/server';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};

const root = arg('root', '/home/caseydigennaro/sitka-distill/pipeline');
const port = Number(arg('port', '8098'));
const host = arg('host', '0.0.0.0');

const service = createCaptureService({ root, port, host });
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
if (service.registry.problems.length) {
  console.log(`\n${service.registry.problems.length} problems:`);
  for (const p of service.registry.problems) console.log(`  ${p.capture}: ${p.reason}`);
}
