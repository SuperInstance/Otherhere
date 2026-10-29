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
import { AssetCapture } from '../schema/asset';
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

/** One tier of a captured asset, as the Bundle's extras carry it. */
export type AssetTierExtras = { path: string; hash: string; bytes: number };

/**
 * A distilled capture placed in this Cell (the `asset.capture` design): the
 * sidecar a display layer needs to fetch, verify and place the payload that
 * REPLACES the Feature's procedural geometry — plus the footprint ring in
 * local-frame metres (flat `[e0, n0, …]`, centimetre-rounded, the forest
 * zones' convention) so the client can keep trees out, stand the asset on
 * the ground and answer picks without the payload. Derives entirely from
 * the Feature's Facts, so the inputs hash covers it. The `assets` key is
 * written only when a Cell actually carries a capture: Bundles without one
 * stay byte-identical.
 */
export type AssetExtras = {
  id: string;
  family: string;
  version: string;
  /**
   * The tiers this capture offers. `splat` is the gaussian field, `model` a real
   * triangle mesh (the GLB the Thor's generators write), `impostor` the view atlas
   * and `card` the small photograph.
   */
  tiers: {
    splat?: AssetTierExtras;
    impostor?: AssetTierExtras;
    card?: AssetTierExtras;
    model?: AssetTierExtras;
  };
  /** Placement in the Cell's local frame: position + quaternion * (scale * p). */
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  heightM: number;
  frontAzimuthDeg: number;
  cardQuad?: { widthM: number; heightM: number; centreYM: number };
  ring: number[];
};

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
 * Fill an Essence's absent `region` from the CELL's centre — not the Town's,
 * which is what the TownDO uses when it stores one (town.ts derives from the
 * town centre). For an old Essence straight from storage, a Cell whose centre
 * sits near a region-box edge can therefore derive a different region than
 * its Town would store today; whichever value the Essence ends up carrying
 * lands in the content address (and the region table itself is hashed as
 * data too, via LOOKUP_TABLES).
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

  // A distilled capture replaces its Feature's procedural geometry outright
  // (precedence: capture over archetype over procedural). The placement
  // rides as extras; the payload bytes live beside the Bundle, never in it.
  const assets = assetExtras(input, frame);
  const captured = new Set(assets.map((a) => a.id));

  const ranges: { id: string; first: number; count: number }[] = [];
  // Sorted, so the vertex order — and so the bytes — never depend on the order
  // the Facts arrived in (invariant 2).
  const essence = withDerivedRegion(input);
  for (const f of [...input.features].sort(byId)) {
    if (captured.has(f.id)) continue;
    const gen = gens.forKind(f.kind);
    if (!gen) continue;
    const first = mesh.vertexCount;
    const stats = runGenerator(gen, f, frame, mesh, essence);
    if (stats && mesh.vertexCount > first)
      ranges.push({ id: f.id, first, count: mesh.vertexCount - first });
  }

  const inputsHash = await bundleInputsHash({ ...input, generators: gens });
  const data = mesh.build();
  const glb = writeGlbFor(input.cell, data, inputsHash, origin, ranges, forest, assets);
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
  assets: AssetExtras[],
): Uint8Array {
  return writeGlb(data, {
    name: cell,
    generator: `otherhere-core/${INTERPRETER_VERSION}`,
    extras: {
      otherhere: {
        cell,
        inputsHash,
        origin,
        features: ranges,
        forest,
        // Only when a capture rides: a Cell without one keeps the exact
        // extras (and so the exact bytes) it has always had.
        ...(assets.length ? { assets } : {}),
      },
    },
  });
}

/**
 * Collect the captured assets placed in this Cell. A Feature joins when its
 * winning `asset.capture` Fact parses as a sidecar AND it carries a
 * footprint to stand the capture on; a malformed sidecar is ignored (the
 * Feature keeps its procedural build) rather than breaking the Bundle.
 * Numbers are rounded the way the forest rings are — centimetres, and
 * enough decimals on the rotation to hold a degree at building scale — so
 * the extras stay compact and stable. Sorted by Feature ID.
 */
export function assetExtras(
  input: BuildInput,
  frame: ReturnType<typeof localFrame>,
): AssetExtras[] {
  const out: AssetExtras[] = [];
  for (const f of input.features) {
    const raw = f.attrs['asset.capture'];
    const fp = f.attrs.footprint;
    if (!raw || !fp || !Array.isArray(fp.value) || fp.value.length < 3) continue;
    const parsed = AssetCapture.safeParse(raw.value);
    if (!parsed.success) continue;
    const cap = parsed.data;
    const ring = cleanRing(
      (fp.value as LngLat[]).map((p) => frame.project({ lat: p[1], lng: p[0] })),
    );
    if (ring.length < 3) continue;
    const flat: number[] = [];
    for (const p of ring) {
      const e = Math.round(p.e * 100) / 100;
      const n = Math.round(p.n * 100) / 100;
      const last = flat.length - 2;
      if (last >= 0 && flat[last] === e && flat[last + 1] === n) continue;
      flat.push(e, n);
    }
    if (flat.length < 6) continue;
    const tiers: AssetExtras['tiers'] = {};
    for (const k of ['splat', 'impostor', 'card', 'model'] as const) {
      const t = cap.tiers[k];
      if (t) tiers[k] = { path: t.path, hash: t.hash, bytes: t.bytes };
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    out.push({
      id: f.id,
      family: cap.family,
      version: cap.version,
      tiers,
      position: [
        r3(cap.params.position[0]),
        r3(cap.params.position[1]),
        r3(cap.params.position[2]),
      ],
      quaternion: [
        r6(cap.params.quaternion[0]),
        r6(cap.params.quaternion[1]),
        r6(cap.params.quaternion[2]),
        r6(cap.params.quaternion[3]),
      ],
      scale: r6(cap.params.scale),
      heightM: r3(cap.params.heightM),
      frontAzimuthDeg: Math.round(cap.params.frontAzimuthDeg * 100) / 100,
      ...(cap.params.cardQuad
        ? {
            cardQuad: {
              widthM: r3(cap.params.cardQuad.widthM),
              heightM: r3(cap.params.cardQuad.heightM),
              centreYM: r3(cap.params.cardQuad.centreYM),
            },
          }
        : {}),
      ring: flat,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
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
