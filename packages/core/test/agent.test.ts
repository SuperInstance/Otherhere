import { describe, expect, it } from 'vitest';
import {
  AgentManifest,
  canRun,
  ingestBlockOf,
  cellAt,
  Job,
  Proposal,
  REQUIREMENTS,
  type Capabilities,
} from '../src/index';
import fixture from './fixtures/overpass-zurich.json';

const laptop: Capabilities = { network: true, gpu: false, vramGb: 0, cpuCores: 8, alwaysOn: false };

describe('plugin jobs', () => {
  it('matches a job to the devices that can run it', () => {
    expect(canRun(REQUIREMENTS.ingest_block, laptop)).toBe(true);
    expect(canRun(REQUIREMENTS.ingest_block, { ...laptop, network: false })).toBe(false);
    expect(canRun({ gpu: true, vramGb: 8 }, { ...laptop, gpu: true, vramGb: 6 })).toBe(false);
    expect(canRun({ gpu: true, vramGb: 8 }, { ...laptop, gpu: true, vramGb: 12 })).toBe(true);
  });

  it('validates manifests and jobs', () => {
    expect(
      AgentManifest.safeParse({
        agent: 'home-server',
        version: '0.1.0',
        capabilities: laptop,
        kinds: ['ingest_block'],
      }).success,
    ).toBe(true);
    expect(
      AgentManifest.safeParse({ agent: 'x', version: '1', capabilities: laptop, kinds: [] })
        .success,
    ).toBe(false);
    const block = ingestBlockOf(cellAt(47.3769, 8.5417));
    const leaseUntil = '2026-10-18T00:00:00.000Z';
    expect(Job.safeParse({ id: 'j', kind: 'ingest_block', block, leaseUntil }).success).toBe(true);
    // A res-9 Cell is not an ingest block.
    expect(
      Job.safeParse({ id: 'j', kind: 'ingest_block', block: cellAt(47.3769, 8.5417), leaseUntil })
        .success,
    ).toBe(false);
  });

  it('accepts a real Overpass response as an ingest proposal, and nothing that carries Facts', () => {
    expect(Proposal.safeParse({ kind: 'ingest_block', overpass: fixture }).success).toBe(true);
    expect(
      Proposal.safeParse({
        kind: 'ingest_block',
        overpass: { elements: [] },
        facts: [{ source: 'manual_edit' }],
      }).success,
    ).toBe(false);
    expect(
      Proposal.safeParse({
        kind: 'ingest_block',
        overpass: { elements: [{ type: 'node', id: 1, lat: 200, lon: 0 }] },
      }).success,
    ).toBe(false);
  });
});
