import { z } from 'zod';
import { isValidCell, getResolution } from 'h3-js';
import { INGEST_RES } from '../geo/h3';

/** What a Plugin device can do (ADR-0015). Plugins are optional (invariant 7). */
export const Capabilities = z.strictObject({
  /** Can reach the public internet (Overpass, imagery). */
  network: z.boolean(),
  gpu: z.boolean(),
  vramGb: z.number().min(0),
  cpuCores: z.number().int().min(1),
  /** Expected to stay online for hours, like a home server; a phone is not. */
  alwaysOn: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const JOB_KINDS = ['ingest_block'] as const;
export const JobKind = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKind>;

/** Sent with every claim, so the queue only hands out jobs this device can run. */
export const AgentManifest = z.strictObject({
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  version: z.string().max(32),
  capabilities: Capabilities,
  kinds: z.array(JobKind).min(1),
});
export type AgentManifest = z.infer<typeof AgentManifest>;

/** The minimum a device needs for a job; any field left out is not required. */
export const Requirements = z.strictObject({
  network: z.boolean().optional(),
  gpu: z.boolean().optional(),
  vramGb: z.number().min(0).optional(),
  cpuCores: z.number().int().min(1).optional(),
  alwaysOn: z.boolean().optional(),
});
export type Requirements = z.infer<typeof Requirements>;

export const REQUIREMENTS: Record<JobKind, Requirements> = {
  ingest_block: { network: true },
};

export function canRun(req: Requirements, caps: Capabilities): boolean {
  return (
    (!req.network || caps.network) &&
    (!req.gpu || caps.gpu) &&
    caps.vramGb >= (req.vramGb ?? 0) &&
    caps.cpuCores >= (req.cpuCores ?? 1) &&
    (!req.alwaysOn || caps.alwaysOn)
  );
}

const IngestBlock = z
  .string()
  .refine((b) => isValidCell(b) && getResolution(b) === INGEST_RES, 'not an ingest block');

/** A job as handed to a Plugin. */
export const Job = z.strictObject({
  id: z.string(),
  kind: JobKind,
  block: IngestBlock,
  /** The claim expires at this time; a result after it is refused. */
  leaseUntil: z.iso.datetime(),
});
export type Job = z.infer<typeof Job>;

const LatLon = { lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) };
const Tags = z.record(z.string().max(255), z.string().max(255)).optional();

/** Overpass `out body geom` JSON, as much of it as `osmToFacts` reads. */
export const OverpassResponseSchema = z.object({
  elements: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('node'), id: z.number().int(), ...LatLon, tags: Tags }),
        z.object({
          type: z.literal('way'),
          id: z.number().int(),
          nodes: z.array(z.number().int()).max(2000),
          geometry: z.array(z.object(LatLon)).max(2000),
          tags: Tags,
        }),
        z.object({ type: z.literal('relation'), id: z.number().int(), tags: Tags }),
      ]),
    )
    .max(100_000),
});

/**
 * A Plugin's result. It is a proposal, not a write: the TownDO validates it and
 * derives Facts itself with trusted code. For `ingest_block` the Plugin returns
 * the raw Overpass response, never Facts, so it cannot choose a source rank.
 */
export const Proposal = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ingest_block'), overpass: OverpassResponseSchema }),
]);
export type Proposal = z.infer<typeof Proposal>;
