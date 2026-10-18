// An optional Plugin (ADR-0015). Everything works without one (invariant 7).
// Usage: OTHERHERE_EDGE=https://… OTHERHERE_AGENT_TOKEN=… pnpm --filter @otherhere/agent start
//   OTHERHERE_AGENT        name of this device (default: plugin)
//   OTHERHERE_ALWAYS_ON    'true' for a home server
//   OTHERHERE_VRAM_GB      GPU memory, if any
//   OVERPASS_ENDPOINTS     comma-separated, to override the public instances
import { AgentManifest } from '@otherhere/core';
import { detectCapabilities } from './capabilities';
import { ingestBlock } from './handlers';
import { AgentRuntime } from './runtime';

const env = process.env;
if (!env.OTHERHERE_EDGE || !env.OTHERHERE_AGENT_TOKEN) {
  console.error('Set OTHERHERE_EDGE and OTHERHERE_AGENT_TOKEN.');
  process.exit(1);
}
const manifest = AgentManifest.parse({
  agent: env.OTHERHERE_AGENT ?? 'plugin',
  version: '0.1.0',
  capabilities: detectCapabilities(env),
  kinds: ['ingest_block'],
});
const endpoints = env.OVERPASS_ENDPOINTS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const runtime = new AgentRuntime({
  edge: env.OTHERHERE_EDGE,
  token: env.OTHERHERE_AGENT_TOKEN,
  manifest,
  handlers: { ingest_block: ingestBlock(endpoints?.length ? { endpoints } : {}) },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
const stop = new AbortController();
process.on('SIGINT', () => stop.abort());
process.on('SIGTERM', () => stop.abort());
console.log(`${manifest.agent}: ${JSON.stringify(manifest.capabilities)} → ${env.OTHERHERE_EDGE}`);
await runtime.run(stop.signal);
