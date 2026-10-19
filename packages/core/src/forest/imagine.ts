import { cellBoundary, cellCenter } from '../geo/h3';
import { localFrame } from '../geo/frame';
import {
  cleanRing,
  depthInRing,
  pointInRing,
  ringDistance,
  segmentDistance,
  type P2,
} from '../geometry/polygon';
import { fnv1a32 } from '../hash/fnv';
import { rngFor } from '../hash/rng';
import type { LngLat } from '../schema/fact';
import type { Essence } from '../schema/world';
import type { BundleFeature } from '../bundle/build';
import {
  biomeMix,
  forestBiome,
  FOREST_BIOMES,
  FOREST_SPECIES,
  pickSpecies,
  snapped,
} from './species';

/**
 * The imagined forest (ADR-0017): trees a Bundle build derives from landcover
 * Facts and the Town's Essence, seeded from stable IDs so the same inputs give
 * the same trees on every device (invariant 2). They are never Facts — each one
 * exists only inside the build that imagined it, marked `source: "imagined"`,
 * and the first real observation (an OSM tree, a capture) simply wins.
 */

/** Jittered grid spacing, in metres: a stylised old-growth stand. */
export const FILL_SPACING_M = 13;
/** How far a candidate may slide from its grid point. */
const JITTER_M = 4.5;
/** Cap per Cell, so a full forest stays a sketch and not a scan of every stem. */
export const MAX_TREES_PER_CELL = 220;
/** No imagined tree this close to a road centreline or a building wall. */
const ROAD_CLEARANCE_M = 7;
const BUILDING_CLEARANCE_M = 7;
/** Nor crowding an observed tree, which knows exactly where it is. */
const TREE_CLEARANCE_M = 3.5;
/** Inside a forest polygon, the disturbed strip that grows alder and shrubs. */
const EDGE_ZONE_M = 11;
/** Near-roadside strip: salmonberry and alder thickets. */
const NEAR_ROAD_M = 12;
/** A Cell this built-up is settled; its trees come from Facts, not imagination. */
const WILD_FILL_MAX_BUILDINGS = 4;

/** Confidence of an imagined tree's position and species. */
const IMAGINED_TREE = 0.3;

/** Species mixes by site. Interior is the Essence's, the others are stylised
 *  succession: alder follows disturbance, salmonberry takes the light. */
const EDGE_MIX = { hemlock: 0.22, spruce: 0.12, cedar: 0.03, alder: 0.45, salmonberry: 0.18 };
const ROADSIDE_MIX = {
  hemlock: 0.2,
  spruce: 0.09,
  cedar: 0.03,
  alder: 0.3,
  salmonberry: 0.38,
};
const SCRUB_MIX = { alder: 0.55, salmonberry: 0.45 };

type Zone = { key: string; ring: P2[]; cover: 'forest' | 'scrub' };

type Obstacles = {
  buildings: P2[][];
  roads: [P2, P2][];
  trees: P2[];
};

/**
 * Imagine the trees for one Cell from its Features and Essence. Pure and
 * deterministic: the same Facts, Essence, and Cell always grow the same forest.
 */
export function imagineForest(
  cell: string,
  features: readonly BundleFeature[],
  essence?: Essence,
): BundleFeature[] {
  const frame = localFrame(cellCenter(cell));
  const hex = cleanRing(cellBoundary(cell).map((p) => frame.project(p)));
  const zones: Zone[] = [];
  const obstacles: Obstacles = { buildings: [], roads: [], trees: [] };
  let buildings = 0;
  let hasLandcover = false;

  for (const f of [...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (f.kind === 'landcover') {
      hasLandcover = true;
      const ring = footprintOf(f, frame);
      const cover = f.attrs.landcover;
      if (!ring || !cover) continue;
      if (cover.value !== 'forest' && cover.value !== 'scrub') continue; // meadows stay open
      zones.push({ key: f.id, ring, cover: cover.value });
    } else if (f.kind === 'building') {
      const ring = footprintOf(f, frame);
      if (ring) {
        buildings++;
        obstacles.buildings.push(ring);
      }
    } else if (f.kind === 'road') {
      const path = f.attrs.path;
      if (path && Array.isArray(path.value) && path.value.length >= 2) {
        const pts = (path.value as LngLat[]).map((p) => frame.project({ lat: p[1], lng: p[0] }));
        for (let i = 0; i + 1 < pts.length; i++) obstacles.roads.push([pts[i]!, pts[i + 1]!]);
      }
    } else if (f.kind === 'tree') {
      const pos = f.attrs.position;
      if (pos && Array.isArray(pos.value))
        obstacles.trees.push(
          frame.project({ lat: (pos.value as LngLat)[1]!, lng: (pos.value as LngLat)[0]! }),
        );
    }
  }

  // A wild Cell in a forest biome is forest until Facts say otherwise.
  const centre = cellCenter(cell);
  const biome = essence?.biome ?? forestBiome(centre.lat, centre.lng);
  if (!hasLandcover && buildings <= WILD_FILL_MAX_BUILDINGS && FOREST_BIOMES[biome].wild)
    zones.push({ key: `wild:${cell}`, ring: hex, cover: 'forest' });
  if (!zones.length) return [];

  // The interior mix: the Town's own species shares when it has them (Essence),
  // else the biome's character.
  const interior: Record<string, number> = Object.fromEntries(
    FOREST_SPECIES.map((s) => [s, essence?.forest?.[s] ?? 0]),
  );
  if (!Object.keys(essence?.forest ?? {}).length) Object.assign(interior, biomeMix(biome));

  const candidates: { p: P2; mix: Record<string, number> }[] = [];
  for (const zone of zones) {
    const rng = rngFor(zone.key, 'forest.fill');
    const bb = bbox(zone.ring);
    const cellbb = bbox(hex);
    const lo = Math.max(bb.minE, cellbb.minE) - FILL_SPACING_M;
    const hi = Math.min(bb.maxE, cellbb.maxE) + FILL_SPACING_M;
    const loN = Math.max(bb.minN, cellbb.minN) - FILL_SPACING_M;
    const hiN = Math.min(bb.maxN, cellbb.maxN) + FILL_SPACING_M;
    for (let e = lo; e <= hi; e += FILL_SPACING_M) {
      for (let n = loN; n <= hiN; n += FILL_SPACING_M) {
        const p = {
          e: e + (rng() - 0.5) * 2 * JITTER_M,
          n: n + (rng() - 0.5) * 2 * JITTER_M,
        };
        if (!pointInRing(p, hex) || !pointInRing(p, zone.ring)) continue;
        if (nearestRoad(p, obstacles.roads) < ROAD_CLEARANCE_M) continue;
        if (obstacles.buildings.some((b) => ringDistance(p, b) < BUILDING_CLEARANCE_M)) continue;
        if (obstacles.trees.some((t) => Math.hypot(t.e - p.e, t.n - p.n) < TREE_CLEARANCE_M))
          continue;
        candidates.push({ p, mix: mixFor(p, zone, obstacles, interior) });
      }
    }
  }

  // Thin a crowded Cell uniformly rather than truncating one corner of the grid.
  const stride = Math.max(1, Math.ceil(candidates.length / MAX_TREES_PER_CELL));
  const out: BundleFeature[] = [];
  for (let i = 0; i < candidates.length; i += stride) {
    const { p, mix } = candidates[i]!;
    const ll = snapped(frame.unproject(p));
    const id = `gen:${fnv1a32(`${cell}:${ll[0]},${ll[1]}`)}`;
    const species = pickSpecies(rngFor(id, 'species')(), mix);
    if (!species) continue;
    out.push({
      id,
      kind: 'tree',
      attrs: {
        position: { value: ll, confidence: IMAGINED_TREE, source: 'imagined' },
        species: { value: species, confidence: IMAGINED_TREE, source: 'imagined' },
      },
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Which mix a spot earns: scrub stays scrub, roadsides fruit, edges regrow. */
function mixFor(
  p: P2,
  zone: Zone,
  obstacles: Obstacles,
  interior: Record<string, number>,
): Record<string, number> {
  if (zone.cover === 'scrub') return SCRUB_MIX;
  const road = nearestRoad(p, obstacles.roads);
  if (road < NEAR_ROAD_M) return ROADSIDE_MIX;
  // The disturbed strip just inside the forest's own boundary.
  if (depthInRing(p, zone.ring) < EDGE_ZONE_M) return EDGE_MIX;
  return interior;
}

function nearestRoad(p: P2, roads: [P2, P2][]): number {
  let d = Infinity;
  for (const [a, b] of roads) d = Math.min(d, segmentDistance(p, a, b));
  return d;
}

function footprintOf(f: BundleFeature, frame: ReturnType<typeof localFrame>): P2[] | null {
  const fp = f.attrs.footprint;
  if (!fp || !Array.isArray(fp.value) || fp.value.length < 3) return null;
  const ring = cleanRing(
    (fp.value as LngLat[]).map((p) => frame.project({ lat: p[1], lng: p[0] })),
  );
  return ring.length >= 3 ? ring : null;
}

function bbox(ring: P2[]): { minE: number; maxE: number; minN: number; maxN: number } {
  let minE = Infinity,
    maxE = -Infinity,
    minN = Infinity,
    maxN = -Infinity;
  for (const p of ring) {
    minE = Math.min(minE, p.e);
    maxE = Math.max(maxE, p.e);
    minN = Math.min(minN, p.n);
    maxN = Math.max(maxN, p.n);
  }
  return { minE, maxE, minN, maxN };
}
