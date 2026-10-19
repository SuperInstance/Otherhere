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

/** Sitka's timber line: nothing on the beach or in the alpine. */
const MIN_GROUND = 2.5;
const MAX_GROUND = 720;
/** Slope is sampled ±4 m, i.e. over an 8 m baseline. */
const SLOPE_STEP = 4;

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
  trees: number;
  /** Some candidates are still unplanted because the instance budget ran out. */
  partial: boolean;
};

type Job = { readonly ix: number; readonly iz: number; readonly d: number };

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
 * of its integer coordinates and the ground beneath them, so the same forest grows
 * on every device and again after every replant. Chunks are planted two per frame,
 * nearest first, and dropped once the camera is well inside the horizon; instance
 * buffers come and go, the two geometries and the material are built once.
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
   * streaming pass replants them, nearest first, as the camera comes round.
   */
  invalidate(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const ix0 = Math.floor(minX / CHUNK);
    const ix1 = Math.floor(maxX / CHUNK);
    const iz0 = Math.floor(minZ / CHUNK);
    const iz1 = Math.floor(maxZ / CHUNK);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const chunk = this.chunks.get(chunkKey(ix, iz));
        if (chunk !== undefined) this.drop(chunk);
      }
    }
  }

  /**
   * Once per frame. Drops chunks past the horizon, then plants or completes at most
   * two of the nearest chunks — streaming the forest in over a few dozen frames
   * rather than stalling one.
   */
  update(x: number, z: number): void {
    if (!this.ground.active) return; // no terrain heights yet: plant nothing

    const dropDist = this.radius * 1.25;
    for (const chunk of [...this.chunks.values()]) {
      const dx = (chunk.ix + 0.5) * CHUNK - x;
      const dz = (chunk.iz + 0.5) * CHUNK - z;
      if (Math.hypot(dx, dz) > dropDist) this.drop(chunk);
    }

    if (this.trees >= this.maxTrees) return; // budget spent: nothing can be added

    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const reach = Math.ceil(this.radius / CHUNK) + 1;
    const jobs: Job[] = [];
    for (let iz = cz - reach; iz <= cz + reach; iz++) {
      for (let ix = cx - reach; ix <= cx + reach; ix++) {
        const d = Math.hypot((ix + 0.5) * CHUNK - x, (iz + 0.5) * CHUNK - z);
        if (d > this.radius) continue;
        const chunk = this.chunks.get(chunkKey(ix, iz));
        if (chunk !== undefined && !chunk.partial) continue;
        jobs.push({ ix, iz, d });
      }
    }
    jobs.sort((a, b) => a.d - b.d);

    let done = 0;
    for (const job of jobs) {
      if (done >= 2) break;
      const chunk = this.chunks.get(chunkKey(job.ix, job.iz));
      if (chunk === undefined) this.plant(job.ix, job.iz);
      else this.fill(chunk);
      done++;
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

  private plant(ix: number, iz: number): void {
    const { spruce, hemlock } = this.buildTrees(ix, iz);
    const chunk: Chunk = { ix, iz, species: [], trees: 0, partial: false };
    if (spruce.length > 0) {
      chunk.species.push(this.makeSpecies(this.spruceGeometry, spruce, SPRUCE_TINT));
    }
    if (hemlock.length > 0) {
      chunk.species.push(this.makeSpecies(this.hemlockGeometry, hemlock, HEMLOCK_TINT));
    }
    this.chunks.set(chunkKey(ix, iz), chunk);
    this.fill(chunk);
  }

  private makeSpecies(geometry: BufferGeometry, trees: readonly Tree[], tint: Color): SpeciesMesh {
    const mesh = new InstancedMesh(geometry, this.material, trees.length);
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

  /** Removes a chunk from the scene and frees only its instance buffers. */
  private drop(chunk: Chunk): void {
    for (const sp of chunk.species) {
      this.root.remove(sp.mesh);
      sp.mesh.dispose();
    }
    this.trees -= chunk.trees;
    this.chunks.delete(chunkKey(chunk.ix, chunk.iz));
  }

  /**
   * The chunk's whole candidate list, deterministically. Every candidate draws the
   * same randoms in the same order, so a replant over unchanged ground and
   * occupancy reproduces the chunk tree for tree.
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
        const thin = Math.min(Math.max((h - 450) / 270, 0), 1);
        const height = stretch * (1 - 0.55 * thin);

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
