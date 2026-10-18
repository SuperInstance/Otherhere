import { cpus } from 'node:os';
import type { Capabilities } from '@otherhere/core';

/**
 * What this device offers. CPU count is detected; the rest is declared, since a
 * GPU or an always-on machine cannot be told reliably from inside Node.
 */
export function detectCapabilities(env: Record<string, string | undefined>): Capabilities {
  const vramGb = Number(env.OTHERHERE_VRAM_GB ?? 0);
  return {
    network: env.OTHERHERE_OFFLINE !== 'true',
    gpu: vramGb > 0,
    vramGb: Number.isFinite(vramGb) ? vramGb : 0,
    cpuCores: Math.max(1, cpus().length),
    alwaysOn: env.OTHERHERE_ALWAYS_ON === 'true',
  };
}
