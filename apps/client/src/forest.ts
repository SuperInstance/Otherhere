import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  type Scene,
  Vector3,
} from 'three/webgpu';
import { float, mix, positionLocal, smoothstep, vec3 } from 'three/tsl';

/* ---------------------------------------------------------------- world grid */

/** Chunk edge, metres. Fixed so a chunk's identity survives streaming in and out. */
const CHUNK = 250;
/** 250 m does not divide by 7.5, so the lattice is 34 cells of 7.35 m: seamless across chunks. */
const COLS = Math.ceil(CHUNK / 7.5);
const STEP = CHUNK / COLS;
const JITTER = 3;

/**
 * Sitka's timber line: nothing on the beach or in the alpine. Shared with the
 * imagined-tree site gate in world.ts, so both forests end at one coast.
 */
export const MIN_GROUND = 2.5;
export const MAX_GROUND = 720;
/** Slope is sampled ±4 m, i.e. over an 8 m baseline. */
const SLOPE_STEP = 4;

/**
 * Detail bands: every tree within FULL_M, every 2nd to MID_M, every 4th beyond. A
 * 15–45 m tree at 950 m is a few pixels; a quarter of the stems reads as the same
 * wall of green, and the same instance budget then covers the whole radius instead
 * of stopping at a visible edge (the display-layer version of the terrain's own
 * coarse-tiles-stand-in trick, ADR-0016).
 */
const FULL_M = 450;
const MID_M = 950;
/** Refine only well inside a band, coarsen only well outside it, as the terrain's
 * split/merge factors do: a chunk walked along a boundary never flickers. */
const REFINE = 0.8;
const COARSEN = 1.25;
/**
 * When the budget cannot fit a far chunk even at stride 4, a fresh plant keeps
 * doubling its stride until it fits: every chunk inside the radius holds some
 * trees, however few, rather than the forest ending in a hard line. Beyond this
 * cap (~7 trees of a full chunk) it plants what fits and completes later.
 */
const MAX_STRIDE = 128;

/** The stride a chunk wants at distance `d` from the walker. */
function wantedStride(d: number): 1 | 2 | 4 {
  return d < FULL_M ? 1 : d < MID_M ? 2 : 4;
}

/** Detail bands: 0 is every tree, 1 every 2nd, 2 every 4th or coarser still. */
function bandOf(stride: number): 0 | 1 | 2 {
  return stride <= 1 ? 0 : stride <= 2 ? 1 : 2;
}

/** The distance band a stride's boundary sits at (stride 1 ends at FULL_M, 2 at MID_M). */
function strideBoundary(stride: number): number {
  return stride <= 1 ? FULL_M : MID_M;
}

/** Spruce reads bluish, hemlock warmer — the only thing telling the species apart at distance. */
const SPRUCE_TINT = new Color('#2c4a32');
const HEMLOCK_TINT = new Color('#36503a');

/* ------------------------------------------------------------------- hashing */

/** 32-bit mix of two signed chunk indices: identical on every device, no state. */
function hashChunk(ix: number, iz: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function hashLattice(ix: number, iz: number): number {
  let h = Math.imul(ix, 0x1f123bb5) ^ Math.imul(iz, 0x2545f491) ^ 0x5eed1e55;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** mulberry32: small, fast, and hand-rolled so the stream is fixed forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smooth value noise in 0..1 on a 60 m lattice. Seeded by position only, never by
 * chunk, so a clearing is one hole in the forest rather than four quarter-holes.
 */
function valueNoise(x: number, z: number): number {
  const fx = x / 60;
  const fz = z / 60;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  return lerp(
    lerp(hashLattice(ix, iz), hashLattice(ix + 1, iz), sx),
    lerp(hashLattice(ix, iz + 1), hashLattice(ix + 1, iz + 1), sx),
    sz,
  );
}

/* ------------------------------------------------------------------ geometry */

type Point = readonly [number, number, number];

function pushTri(out: number[], a: Point, b: Point, c: Point): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/**
 * One cone tier: base ring at `baseY`, apex at `apexY`, wound outward, plus its
 * underside so the crown does not vanish when seen from below.
 */
function pushCone(
  out: number[],
  radius: number,
  baseY: number,
  apexY: number,
  lean: number,
  segments: number,
): void {
  const apex: Point = [lean, apexY, 0];
  const centre: Point = [0, baseY, 0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: Point = [Math.cos(a0) * radius, baseY, Math.sin(a0) * radius];
    const p1: Point = [Math.cos(a1) * radius, baseY, Math.sin(a1) * radius];
    pushTri(out, p0, apex, p1);
    pushTri(out, p0, p1, centre);
  }
}

/** Open six-sided trunk: the caps are always inside ground or crown, so they are skipped. */
function pushTrunk(out: number[], radius: number, topY: number, segments: number): void {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const b0: Point = [Math.cos(a0) * radius, 0, Math.sin(a0) * radius];
    const b1: Point = [Math.cos(a1) * radius, 0, Math.sin(a1) * radius];
    const t0: Point = [Math.cos(a0) * radius, topY, Math.sin(a0) * radius];
    const t1: Point = [Math.cos(a1) * radius, topY, Math.sin(a1) * radius];
    pushTri(out, b0, t0, b1);
    pushTri(out, t0, t1, b1);
  }
}

/**
 * Unit-height conifer, base at y = 0, centred on x/z, so an instance only needs to
 * scale by (width, height, width). Spruce is a narrow three-tier spire at 54
 * triangles; hemlock a broader two-tier crown with a leaning tip at 40.
 */
function buildConiferGeometry(spruce: boolean): BufferGeometry {
  const out: number[] = [];
  pushTrunk(out, 0.03, 0.12, 6);
  if (spruce) {
    pushCone(out, 0.5, 0.1, 0.55, 0, 7);
    pushCone(out, 0.38, 0.38, 0.82, 0, 7);
    pushCone(out, 0.24, 0.62, 1, 0, 7);
  } else {
    pushCone(out, 0.46, 0.12, 0.62, 0.015, 7);
    pushCone(out, 0.3, 0.45, 1, 0.03, 7);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out, 3));
  // Non-indexed, so this gives flat per-face normals: exactly the low-poly read we want.
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ material */

/**
 * One material for every tree of both species. three multiplies each instance's colour
 * into `colorNode` itself (NodeMaterial.setupDiffuseColor), so this is only the shading:
 * darker toward the base so a stand has depth instead of reading as a flat wall, and a
 * faint lift on the upper third so the crowns don't go black against the sky.
 */
function coniferMaterial(): MeshStandardNodeMaterial {
  const y = positionLocal.y;
  const depth = mix(float(0.55), float(1), smoothstep(0, 0.45, y));
  const rim = mix(float(1), float(1.25), smoothstep(0.65, 1, y).mul(0.4));

  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  m.colorNode = vec3(depth.mul(rim));
  m.name = 'conifer';
  return m;
}

/* --------------------------------------------------------------------- types */

export type ForestGround = {
  readonly active: boolean;
  heightAt(x: number, z: number): number;
};

/** A planted candidate; positions are world space, sizes metres. */
type Tree = {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly height: number;
  readonly width: number;
  readonly yaw: number;
  /** Lightness multiplier around 1, so a stand is not one flat colour. */
  readonly shade: number;
};

/**
 * One species of one chunk. The instance buffers are sized for the chunk's full
 * candidate list up front, so finishing a partial chunk only raises `count`
 * instead of rebuilding anything.
 */
type SpeciesMesh = {
  readonly mesh: InstancedMesh;
  readonly trees: readonly Tree[];
  readonly tint: Color;
  placed: number;
};

type Chunk = {
  readonly ix: number;
  readonly iz: number;
  readonly species: SpeciesMesh[];
  /** Which detail stride the chunk is planted at: 1, 2, 4, or coarser (see `wantedStride`). */
  readonly stride: number;
  trees: number;
  /** Some candidates are still unplanted because the instance budget ran out. */
  partial: boolean;
};

type Job = {
  readonly ix: number;
  readonly iz: number;
  readonly d: number;
  /** The stride to plant or replant at; unset when the job is only completing a partial chunk. */
  readonly stride?: number;
};

function chunkKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

/* -------------------------------------------------------------- scratch space */

const _pos = new Vector3();
const _scale = new Vector3();
const _quat = new Quaternion();
const _matrix = new Matrix4();
const _colour = new Color();
const UP = new Vector3(0, 1, 0);

/* -------------------------------------------------------------------- forest */

/**
 * A streamed, display-only forest of low-poly conifers.
 *
 * The world is cut into fixed 250 m chunks and a chunk's trees are a pure function
 * of its integer coordinates, the ground beneath them, and its detail stride — so
 * the same forest grows on every device and again after every replant. Chunks are
 * planted or re-banded two per frame, nearest first, and dropped once the camera is
 * well inside the horizon; instance buffers come and go, the two geometries and the
 * material are built once. Near chunks carry every tree and distant ones every 2nd
 * or 4th (sparser still when the budget runs out), so the forest always reaches the
 * horizon and sharpens as you walk into it — sketch until sure, like everything
 * else here.
 */
export class Forest {
  readonly root = new Group();

  private readonly ground: ForestGround;
  private readonly occupied: ((x: number, z: number) => boolean) | undefined;
  private readonly radius: number;
  private readonly maxTrees: number;
  private readonly spruceGeometry: BufferGeometry;
  private readonly hemlockGeometry: BufferGeometry;
  private readonly material: MeshStandardNodeMaterial;
  private readonly chunks = new Map<string, Chunk>();
  /** Strides of chunks dropped by `invalidate`, so a replant keeps its detail. */
  private readonly replantStride = new Map<string, number>();
  /** Fresh chunks still to plant inside the radius, by detail band (see `bandOf`). */
  private pending: [number, number, number] = [0, 0, 0];
  private trees = 0;

  constructor(
    scene: Scene,
    ground: ForestGround,
    opts?: {
      occupied?: (x: number, z: number) => boolean;
      radius?: number;
      maxTrees?: number;
    },
  ) {
    this.ground = ground;
    this.occupied = opts?.occupied;
    this.radius = opts?.radius ?? 1400;
    this.maxTrees = opts?.maxTrees ?? 26000;
    this.spruceGeometry = buildConiferGeometry(true);
    this.hemlockGeometry = buildConiferGeometry(false);
    this.material = coniferMaterial();
    scene.add(this.root);
  }

  /**
   * Heights or buildings changed here: drop the affected chunks so the normal
   * streaming pass replants them, nearest first, as the camera comes round. The
   * chunk's stride is remembered, so finer ground or a new Bundle can only sharpen
   * what it shows, never thin it back to what the distance alone would ask for.
   */
  invalidate(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const ix0 = Math.floor(minX / CHUNK);
    const ix1 = Math.floor(maxX / CHUNK);
    const iz0 = Math.floor(minZ / CHUNK);
    const iz1 = Math.floor(maxZ / CHUNK);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const chunk = this.chunks.get(chunkKey(ix, iz));
        if (chunk !== undefined) {
          this.drop(chunk);
          this.replantStride.set(chunkKey(ix, iz), chunk.stride);
        }
      }
    }
  }

  /**
   * Once per frame. Drops chunks past the horizon, then plants, completes, or
   * re-bands at most two of the nearest chunks — streaming the forest in over a few
   * dozen frames rather than stalling one. Three rules keep a spent budget from
   * wedging the stream: band changes always run (coarsening a distant chunk is what
   * frees instances for near ones), completing a partial chunk only runs while the
   * budget has room (it can place nothing otherwise, and would starve the coarsens),
   * and a fresh plant fits itself to the room that's left, doubling its stride past
   * the band's own until it does — so the forest reaches the horizon, thinly, even
   * where the budget runs out.
   */
  update(x: number, z: number): void {
    if (!this.ground.active) return; // no terrain heights yet: plant nothing

    const dropDist = this.radius * 1.25;
    for (const chunk of [...this.chunks.values()]) {
      const dx = (chunk.ix + 0.5) * CHUNK - x;
      const dz = (chunk.iz + 0.5) * CHUNK - z;
      if (Math.hypot(dx, dz) > dropDist) this.drop(chunk);
    }

    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const reach = Math.ceil(this.radius / CHUNK) + 1;
    const room = this.trees < this.maxTrees;
    const jobs: Job[] = [];
    const pending: [number, number, number] = [0, 0, 0]; // fresh chunks, by band
    for (let iz = cz - reach; iz <= cz + reach; iz++) {
      for (let ix = cx - reach; ix <= cx + reach; ix++) {
        const d = Math.hypot((ix + 0.5) * CHUNK - x, (iz + 0.5) * CHUNK - z);
        if (d > this.radius) continue;
        const key = chunkKey(ix, iz);
        const chunk = this.chunks.get(key);
        if (chunk === undefined) {
          // Plant straight into the band the distance asks for, never coarser than
          // the chunk last held (an invalidated chunk keeps its detail).
          const held = this.replantStride.get(key) ?? 0;
          const stride = Math.max(wantedStride(d), held);
          pending[bandOf(stride)]++;
          jobs.push({ ix, iz, d, stride });
        } else {
          const stride = bandedStride(d, chunk.stride);
          if (stride !== undefined) jobs.push({ ix, iz, d, stride });
          else if (chunk.partial && room) jobs.push({ ix, iz, d });
        }
      }
    }
    this.pending = pending;
    jobs.sort((a, b) => a.d - b.d);

    let done = 0;
    for (const job of jobs) {
      if (done >= 2) break;
      const chunk = this.chunks.get(chunkKey(job.ix, job.iz));
      if (job.stride === undefined) {
        if (chunk !== undefined) {
          this.fill(chunk);
          done++;
        }
      } else {
        // A band change drops the chunk first, so the replant can always afford at
        // least as many trees as it just let go; a fresh plant fits the room left.
        if (chunk !== undefined) this.drop(chunk);
        this.plant(job.ix, job.iz, job.stride, chunk === undefined);
        done++;
      }
    }
  }

  stats(): { chunks: number; trees: number } {
    return { chunks: this.chunks.size, trees: this.trees };
  }

  dispose(): void {
    for (const chunk of [...this.chunks.values()]) this.drop(chunk);
    this.chunks.clear();
    this.root.removeFromParent();
    this.spruceGeometry.dispose();
    this.hemlockGeometry.dispose();
    this.material.dispose();
  }

  /* ---------------------------------------------------------------- planting */

  /**
   * Plant a chunk at `want`-stride. A fresh plant (`escalate`) whose wanted stride
   * is coarser than 1 may double it further until the chunk fits its share of the
   * budget left for the chunks still waiting in its band or a finer one — so a tight
   * budget thins the far bands first and evenly, and the last chunks in radius plant
   * sparse rather than not at all. A re-band plants exactly at `want`, because
   * dropping the old chunk has already handed back its instances.
   */
  private plant(ix: number, iz: number, want: number, escalate: boolean): void {
    const full = this.buildTrees(ix, iz);
    let stride = want;
    const band = bandOf(want);
    if (escalate && want >= 2) {
      const total = full.spruce.length + full.hemlock.length;
      // Jobs run nearest first, so everything in a finer band has planted already;
      // the share divides what's left among this band's chunks and coarser ones.
      const waiting =
        this.pending[0] + (band > 0 ? this.pending[1] : 0) + (band > 1 ? this.pending[2] : 0);
      const share = Math.max(1, (this.maxTrees - this.trees) / Math.max(1, waiting));
      while (stride < MAX_STRIDE && total / stride > share) stride *= 2;
      this.pending[band] = Math.max(0, this.pending[band] - 1);
    }
    const spruce = thin(full.spruce, stride);
    const hemlock = thin(full.hemlock, stride);
    this.replantStride.delete(chunkKey(ix, iz));
    const chunk: Chunk = { ix, iz, species: [], trees: 0, partial: false, stride };
    if (spruce.length > 0) {
      chunk.species.push(this.makeSpecies(ix, iz, this.spruceGeometry, spruce, SPRUCE_TINT));
    }
    if (hemlock.length > 0) {
      chunk.species.push(this.makeSpecies(ix, iz, this.hemlockGeometry, hemlock, HEMLOCK_TINT));
    }
    this.chunks.set(chunkKey(ix, iz), chunk);
    this.fill(chunk);
  }

  private makeSpecies(
    ix: number,
    iz: number,
    geometry: BufferGeometry,
    trees: readonly Tree[],
    tint: Color,
  ): SpeciesMesh {
    const mesh = new InstancedMesh(geometry, this.material, trees.length);
    // Named by chunk, so a walk or a test can find one chunk's instances in the scene.
    mesh.name = chunkKey(ix, iz);
    mesh.count = 0;
    mesh.visible = false;
    this.root.add(mesh);
    return { mesh, trees, tint, placed: 0 };
  }

  /** Writes as many of a chunk's trees as the budget allows; the rest wait for later. */
  private fill(chunk: Chunk): void {
    let budget = this.maxTrees - this.trees;
    for (const sp of chunk.species) {
      let added = 0;
      while (budget > 0 && sp.placed < sp.trees.length) {
        const tree = sp.trees[sp.placed];
        if (tree === undefined) break;
        this.writeInstance(sp, sp.placed, tree);
        sp.placed++;
        chunk.trees++;
        this.trees++;
        budget--;
        added++;
      }
      if (added === 0) continue;
      sp.mesh.count = sp.placed;
      sp.mesh.visible = true;
      sp.mesh.instanceMatrix.needsUpdate = true;
      if (sp.mesh.instanceColor !== null) sp.mesh.instanceColor.needsUpdate = true;
      sp.mesh.computeBoundingSphere();
    }
    chunk.partial = chunk.species.some((sp) => sp.placed < sp.trees.length);
  }

  private writeInstance(sp: SpeciesMesh, index: number, tree: Tree): void {
    _quat.setFromAxisAngle(UP, tree.yaw);
    _pos.set(tree.x, tree.y, tree.z);
    _scale.set(tree.width, tree.height, tree.width);
    _matrix.compose(_pos, _quat, _scale);
    sp.mesh.setMatrixAt(index, _matrix);
    _colour.copy(sp.tint).multiplyScalar(tree.shade);
    sp.mesh.setColorAt(index, _colour);
  }

  /** Removes a chunk from the scene, frees its instance buffers, and forgets its stride. */
  private drop(chunk: Chunk): void {
    for (const sp of chunk.species) {
      this.root.remove(sp.mesh);
      sp.mesh.dispose();
    }
    this.trees -= chunk.trees;
    this.chunks.delete(chunkKey(chunk.ix, chunk.iz));
    this.replantStride.delete(chunkKey(chunk.ix, chunk.iz));
  }

  /**
   * The chunk's whole candidate list, deterministically. Every candidate draws the
   * same randoms in the same order, so a replant over unchanged ground and
   * occupancy reproduces the chunk tree for tree, and thinning only picks a subset
   * of the finished lists: a chunk refined from stride 4 to 1 grows exactly the
   * trees a fresh plant would, and no others.
   */
  private buildTrees(ix: number, iz: number): { spruce: Tree[]; hemlock: Tree[] } {
    const rng = mulberry32(hashChunk(ix, iz));
    const spruce: Tree[] = [];
    const hemlock: Tree[] = [];
    const minX = ix * CHUNK;
    const minZ = iz * CHUNK;
    const occupied = this.occupied;

    for (let gz = 0; gz < COLS; gz++) {
      for (let gx = 0; gx < COLS; gx++) {
        const rx = rng();
        const rz = rng();
        const rKeep = rng();
        const rSpecies = rng();
        const rHeight = rng();
        const rYaw = rng();
        const rShade = rng();

        const x = minX + (gx + 0.5) * STEP + (rx * 2 - 1) * JITTER;
        const z = minZ + (gz + 0.5) * STEP + (rz * 2 - 1) * JITTER;

        const h = this.ground.heightAt(x, z);
        if (h < MIN_GROUND || h > MAX_GROUND) continue; // water, beach, alpine

        const dhx =
          this.ground.heightAt(x + SLOPE_STEP, z) - this.ground.heightAt(x - SLOPE_STEP, z);
        const dhz =
          this.ground.heightAt(x, z + SLOPE_STEP) - this.ground.heightAt(x, z - SLOPE_STEP);
        const slope = Math.hypot(dhx, dhz) / (2 * SLOPE_STEP);
        if (slope > 0.9) continue; // bare rock

        // Dense on the flats, thinning as the ground steepens.
        const slopeKeep = slope <= 0.35 ? 1 : (0.9 - slope) / 0.55;
        // Timber line: full stocking low down, nothing by 720 m.
        const altKeep = h <= 300 ? 0.85 : (0.85 * (MAX_GROUND - h)) / (MAX_GROUND - 300);
        if (rKeep > slopeKeep * altKeep) continue;

        if (occupied !== undefined && occupied(x, z)) continue;
        if (valueNoise(x, z) < 0.12) continue; // a clearing the loggers left

        const isSpruce = rSpecies < 0.6;
        const stretch = isSpruce ? 18 + rHeight * 24 : 15 + rHeight * 17;
        // Above 450 m the growing season runs out and the same species stands shorter.
        const stunted = Math.min(Math.max((h - 450) / 270, 0), 1);
        const height = stretch * (1 - 0.55 * stunted);

        const tree: Tree = {
          x,
          z,
          y: h - 0.6, // root the trunk into the slope so nothing floats
          height,
          width: height * (isSpruce ? 0.32 : 0.36),
          yaw: rYaw * Math.PI * 2,
          shade: 1 + (rShade * 2 - 1) * 0.08,
        };
        (isSpruce ? spruce : hemlock).push(tree);
      }
    }
    return { spruce, hemlock };
  }
}

/** Every `stride`-th tree of a list, starting at the first: a subset of any finer stride. */
function thin(trees: Tree[], stride: number): Tree[] {
  if (stride === 1) return trees;
  const out: Tree[] = [];
  for (let i = 0; i < trees.length; i += stride) out.push(trees[i]!);
  return out;
}

/**
 * The stride a planted chunk should move to, honouring the hysteresis margins:
 * undefined when it should stay put. Refining needs the walker well inside the
 * finer band; coarsening needs them well outside the chunk's own.
 */
function bandedStride(d: number, stride: number): 1 | 2 | 4 | undefined {
  const want = wantedStride(d);
  if (want === stride) return undefined;
  if (want < stride) {
    // Finer: the boundary in question is the finer stride's own.
    return d < strideBoundary(want) * REFINE ? want : undefined;
  }
  // Coarser: the boundary in question is the chunk's own.
  return d > strideBoundary(stride) * COARSEN ? want : undefined;
}
