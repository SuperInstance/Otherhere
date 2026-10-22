import { canonicalJson } from '../hash/canonical';
import { sha256Hex } from '../hash/sha256';
import { cellBoundary, cellCenter } from '../geo/h3';
import { localFrame } from '../geo/frame';
import type { ResolvedAttrs } from '../facts/resolve';
import type { FeatureKind } from '../schema/feature';
import type { LngLat } from '../schema/fact';
import type { BundleManifest } from '../schema/bundle';
import type { Essence } from '../schema/world';
import { generatorSet, type GeneratorSet } from '../generators';
import { INTERPRETER_VERSION, runGenerator } from '../geometry/interpret';
import { MeshBuilder } from '../geometry/mesh';
import { cleanRing } from '../geometry/polygon';
import {
  biomeMix,
  forestBiome,
  FOREST_BIOMES,
  FOREST_SPECIES,
  RAINFOREST_BOX,
  type Species,
} from '../forest/species';
import { regionOf, GENERIC_PRIOR, REGION_BOX, REGION_PRIORS } from '../essence/region';
import { writeGlb } from '../glb/write';

export type BundleFeature = { id: string; kind: FeatureKind; attrs: ResolvedAttrs };

/** A landcover ring the display forest reads: local-frame metres, flat
 *  `[e0, n0, e1, n1, …]`, rounded to centimetres so the JSON stays compact. */
export type ForestZone = {
  id: string;
  cover: 'forest' | 'scrub' | 'meadow';
  ring: number[];
};

/** What a Bundle tells the display forest (ADR-0017, amended 2026-10-22):
 *  the landcover rings and the Town's species mix, as data — never as trees.
 *  Everything here derives from the Features and the Essence, both in the
 *  content address, so the extras are covered by the inputs hash. */
export type ForestExtras = { mix: Record<Species, number>; zones: ForestZone[] };

export type BuildInput = {
  cell: string;
  features: readonly BundleFeature[];
  generators?: GeneratorSet;
  /** The Town's character (ADR-0014). Part of the content address. */
  essence?: Essence;
};

export type BuiltBundle = { glb: Uint8Array; manifest: BundleManifest };

/** Ground colour for a Cell nobody has told us about yet: the "sketch". */
export const GROUND_COLOUR = '#ddd6c6';
// Where the ground is, is certain (flat in M0); what covers it is not yet known.
const GROUND_CONF: [number, number] = [1, 0.2];

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The fixed lookup tables a Bundle's output depends on, hashed into the
 * content address as data (review 2026-10-22 P0 #3): the region priors and
 * the boxes that decide which region and biome a Town sits in, the forest
 * biomes' mixes and the species vocabulary. Before this, only the region
 * *code* was hashed — the tables were "interpreter code, whose version is in
 * the address" only by convention, so an edit to a wall colour kept the old
 * address while the bytes changed: R2 served the old GLB and the client
 * rebuilt different ones under it. Hashing them as data makes every table
 * edit move the address the way a Fact change does, unconditionally — no
 * dependency analysis, no convention to remember.
 */
export const LOOKUP_TABLES = {
  region: { priors: REGION_PRIORS, genericPrior: GENERIC_PRIOR, box: REGION_BOX },
  forest: { biomes: FOREST_BIOMES, species: FOREST_SPECIES, rainforestBox: RAINFOREST_BOX },
} as const;

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
      tables: LOOKUP_TABLES,
      generators: await gens.refs(),
      features: [...input.features].sort(byId),
      essence: withDerivedRegion(input),
    }),
  );
}

/**
 * Fill an Essence's absent `region` from the Cell's coordinates, the same way
 * the forest mix falls back to the biome of the centre: an Essence straight
 * from storage predates regions, but its Town sits where it always sat, so the
 * derived region is the same value a fresh computation would write — and it
 * lands in the content address, so the region a Bundle was built under is
 * always part of its hash (and the region table itself is hashed as data
 * too, via LOOKUP_TABLES).
 */
function withDerivedRegion(input: BuildInput): Essence | undefined {
  if (!input.essence || input.essence.region) return input.essence;
  const centre = cellCenter(input.cell);
  const region = regionOf(centre.lat, centre.lng);
  return region ? { ...input.essence, region } : input.essence;
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

  // Landcover is an input, not a drawing (ADR-0017): the imagined trees it
  // used to grow here are the display forest's job now, so the rings and the
  // Town's mix ride along as extras instead of as a thousand Features.
  const forest = forestExtras(input, frame);

  const ranges: { id: string; first: number; count: number }[] = [];
  // Sorted, so the vertex order — and so the bytes — never depend on the order
  // the Facts arrived in (invariant 2).
  const essence = withDerivedRegion(input);
  for (const f of [...input.features].sort(byId)) {
    const gen = gens.forKind(f.kind);
    if (!gen) continue;
    const first = mesh.vertexCount;
    const stats = runGenerator(gen, f, frame, mesh, essence);
    if (stats && mesh.vertexCount > first)
      ranges.push({ id: f.id, first, count: mesh.vertexCount - first });
  }

  const inputsHash = await bundleInputsHash({ ...input, generators: gens });
  const data = mesh.build();
  const glb = writeGlbFor(input.cell, data, inputsHash, origin, ranges, forest);
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
  forest: ForestExtras,
): Uint8Array {
  return writeGlb(data, {
    name: cell,
    generator: `otherhere-core/${INTERPRETER_VERSION}`,
    extras: { otherhere: { cell, inputsHash, origin, features: ranges, forest } },
  });
}

/** Collect the landcover rings and the species mix for the display forest.
 *  Pure and deterministic: the mix is built over `FOREST_SPECIES` order (an
 *  Essence straight from storage may carry any key order), and ring points
 *  are rounded to centimetres — coarser than any OSM polygon deserves. */
export function forestExtras(
  input: BuildInput,
  frame: ReturnType<typeof localFrame>,
): ForestExtras {
  const zones: ForestZone[] = [];
  for (const f of input.features) {
    if (f.kind !== 'landcover') continue;
    const cover = f.attrs.landcover;
    const fp = f.attrs.footprint;
    if (!cover || !fp || !Array.isArray(fp.value) || fp.value.length < 3) continue;
    // The Fact schema constrains landcover to these three; the resolved attr
    // arrives untyped, so the guard is the schema restated where it is read.
    if (cover.value !== 'forest' && cover.value !== 'scrub' && cover.value !== 'meadow') continue;
    const ring = cleanRing(
      (fp.value as LngLat[]).map((p) => frame.project({ lat: p[1], lng: p[0] })),
    );
    if (ring.length < 3) continue;
    // Rounded to centimetres, then deduplicated: a polygon smaller than a
    // coin can round to fewer than three distinct points, and a degenerate
    // ring is dropped rather than shipped as a zone nothing can be inside.
    const flat: number[] = [];
    for (const p of ring) {
      const e = Math.round(p.e * 100) / 100;
      const n = Math.round(p.n * 100) / 100;
      const last = flat.length - 2;
      if (last >= 0 && flat[last] === e && flat[last + 1] === n) continue;
      flat.push(e, n);
    }
    if (flat.length < 6) continue;
    zones.push({ id: f.id, cover: cover.value, ring: flat });
  }
  zones.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // The mix over `FOREST_SPECIES` order, whatever order the Essence's own object
  // carries: an Essence straight from storage may list its keys in any order.
  const source = input.essence?.forest;
  const from = source && Object.keys(source).length ? source : biomeMixOf(input);
  const mix = Object.fromEntries(FOREST_SPECIES.map((s) => [s, from[s] ?? 0])) as Record<
    Species,
    number
  >;
  return { mix, zones };
}

/** The Town's own mix when it has one, else the biome's character. */
function biomeMixOf(input: BuildInput): Record<string, number> {
  const centre = cellCenter(input.cell);
  return biomeMix(input.essence?.biome ?? forestBiome(centre.lat, centre.lng));
}
