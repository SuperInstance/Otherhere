import { z } from 'zod';
import { CellId } from './cell';

const Hash = z.string().regex(/^[0-9a-f]{64}$/);

export const GeneratorRef = z.object({
  id: z.string(),
  version: z.string(),
  hash: Hash,
});
export type GeneratorRef = z.infer<typeof GeneratorRef>;

/** Describes one built Bundle. The GLB itself lives in R2 at `bundles/<inputsHash>.glb`. */
export const BundleManifest = z.object({
  cell: CellId,
  /** SHA-256 of the canonical build inputs: the content address (ADR-0007). */
  inputsHash: Hash,
  /** SHA-256 of the GLB bytes; must be identical on every device (invariant 2). */
  outputHash: Hash,
  interpreterVersion: z.string(),
  generators: z.array(GeneratorRef),
  featureCount: z.number().int().min(0),
  vertexCount: z.number().int().min(0),
  bytes: z.number().int().min(0),
});
export type BundleManifest = z.infer<typeof BundleManifest>;
