import { canonicalJson } from '../hash/canonical';
import { sha256Hex } from '../hash/sha256';
import { cellBoundary, cellCenter } from '../geo/h3';
import { localFrame } from '../geo/frame';
import type { ResolvedAttrs } from '../facts/resolve';
import type { FeatureKind } from '../schema/feature';
import type { BundleManifest } from '../schema/bundle';
import { generatorSet, type GeneratorSet } from '../generators';
import { INTERPRETER_VERSION, runGenerator } from '../geometry/interpret';
import { MeshBuilder } from '../geometry/mesh';
import { cleanRing } from '../geometry/polygon';
import { writeGlb } from '../glb/write';

export type BundleFeature = { id: string; kind: FeatureKind; attrs: ResolvedAttrs };

export type BuildInput = {
  cell: string;
  features: readonly BundleFeature[];
  generators?: GeneratorSet;
};

export type BuiltBundle = { glb: Uint8Array; manifest: BundleManifest };

/** Ground colour for a Cell nobody has told us about yet: the "sketch". */
export const GROUND_COLOUR = '#ddd6c6';
const GROUND_CONF: [number, number] = [0.2, 0.2];

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The content address of a Bundle (ADR-0007): a hash of everything the output
 * depends on. Same address means same bytes, on every device.
 */
export async function bundleInputsHash(input: BuildInput): Promise<string> {
  const gens = input.generators ?? generatorSet();
  return sha256Hex(
    canonicalJson({
      cell: input.cell,
      interpreter: INTERPRETER_VERSION,
      generators: await gens.refs(),
      features: [...input.features].sort(byId),
    }),
  );
}

export async function buildBundle(input: BuildInput): Promise<BuiltBundle> {
  const gens = input.generators ?? generatorSet();
  const origin = cellCenter(input.cell);
  const frame = localFrame(origin);
  const mesh = new MeshBuilder();

  const hex = cleanRing(cellBoundary(input.cell).map((p) => frame.project(p)));
  mesh.polygon(
    hex.map((p) => [p.e, 0, -p.n]),
    GROUND_COLOUR,
    GROUND_CONF,
    [0, 1, 0],
  );

  const ranges: { id: string; first: number; count: number }[] = [];
  for (const f of [...input.features].sort(byId)) {
    const gen = gens.forKind(f.kind);
    if (!gen) continue;
    const first = mesh.vertexCount;
    const stats = runGenerator(gen, f, frame, mesh);
    if (stats && mesh.vertexCount > first)
      ranges.push({ id: f.id, first, count: mesh.vertexCount - first });
  }

  const inputsHash = await bundleInputsHash({ ...input, generators: gens });
  const data = mesh.build();
  const glb = writeGlbFor(input.cell, data, inputsHash, origin, ranges);
  return {
    glb,
    manifest: {
      cell: input.cell,
      inputsHash,
      outputHash: await sha256Hex(glb),
      interpreterVersion: INTERPRETER_VERSION,
      generators: await gens.refs(),
      featureCount: ranges.length,
      vertexCount: data.positions.length / 3,
      bytes: glb.byteLength,
    },
  };
}

function writeGlbFor(
  cell: string,
  data: ReturnType<MeshBuilder['build']>,
  inputsHash: string,
  origin: { lat: number; lng: number },
  ranges: { id: string; first: number; count: number }[],
): Uint8Array {
  return writeGlb(data, {
    name: cell,
    generator: `otherhere-core/${INTERPRETER_VERSION}`,
    extras: { otherhere: { cell, inputsHash, origin, features: ranges } },
  });
}
