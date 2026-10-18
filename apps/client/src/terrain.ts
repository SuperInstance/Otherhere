import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
  type Scene,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  color,
  distance,
  dot,
  float,
  fract,
  fwidth,
  max,
  min,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  vec3,
} from 'three/tsl';
import type { LocalFrame } from '@otherhere/core';

export type TerrainMode = 'topo' | 'satellite';

const ELEVATION_ATTRIBUTION = 'Elevation: Mapzen Terrain Tiles (USGS 3DEP, SRTM and others)';

export const TERRAIN_ATTRIBUTION: Record<TerrainMode, string> = {
  satellite:
    'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0 · ' +
    ELEVATION_ATTRIBUTION,
  topo: ELEVATION_ATTRIBUTION,
};

/** Tile pixels per side; Terrarium and the satellite proxy both serve 256×256. */
const TILE_PX = 256;
/** Coarsest level we ever build: ~40 km tiles, the backdrop when nothing finer is ready. */
const ROOT_Z = 10;
const MIN_Z = 10;
/** Finest level the proxy serves: ~1.2 km tiles. */
const MAX_Z = 15;
/** Roots are chosen inside this half-width of the walker, in metres. */
const ROOT_SPAN = 16_000;
/** Split while nearer than width × this, merge only beyond width × MERGE_FACTOR. */
const SPLIT_FACTOR = 1.0;
const MERGE_FACTOR = 1.25;
/** Concurrent tile fetches, elevation and satellite together. */
const MAX_FETCHES = 6;
/** Geometry builds queued per frame, so a burst of decodes never stalls the walk. */
const BUILDS_PER_FRAME = 4;
/** z15 heightmaps kept after their mesh is gone, so `heightAt` stays sharp near the walker. */
const FINE_HEIGHTMAPS = 64;
const READY_TIMEOUT = 4_000;
/** A hung request must free its slot: six of them would stall loading for good. */
const FETCH_TIMEOUT = 15_000;
/** A failed tile is asked for again after this long (a 502 is often transient). */
const RETRY_AFTER = 20_000;
/** Failures, with nothing loaded yet, before the layer decides the source is unreachable. */
const DEAD_AFTER = 3;
/** `ready()` coarsens rather than touching more z15 tiles than this. */
const READY_TILE_LIMIT = 64;
/** A camera nearer than this (m) still draws contours. */
const CONTOUR_NEAR = 1_200;
const CONTOUR_FAR = 3_000;

const OCEAN_SIZE = 60_000;
const OCEAN_DEEP = '#2d5563';
const OCEAN_SHEEN = '#5f8ea0';

/* ------------------------------------------------------------------ tile maths */

/** The slippy tile containing a point, clamped to the pyramid. */
export function tileOf(lat: number, lng: number, z: number): { x: number; y: number; z: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: clampInt(x, 0, n - 1), y: clampInt(y, 0, n - 1), z };
}

/** The geographic rectangle a tile covers. `y` counts rows from the north. */
export function tileBounds(
  z: number,
  x: number,
  y: number,
): { north: number; south: number; west: number; east: number } {
  const n = 2 ** z;
  return {
    north: tileLat(y, n),
    south: tileLat(y + 1, n),
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
  };
}

/** Web Mercator y as a fraction of the world, 0 at the north edge. */
function mercatorY(lat: number): number {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

function tileLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function tileKey(t: { z: number; x: number; y: number }): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/* ------------------------------------------------------------------ records */

type TileXYZ = { z: number; x: number; y: number };

type TileBounds = { north: number; south: number; west: number; east: number };

type TileRecord = {
  key: string;
  z: number;
  x: number;
  y: number;
  bounds: TileBounds;
  /** Sampled extremes, for the 3D distance test; both 0 until the heightmap lands. */
  minY: number;
  maxY: number;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** When the last elevation or texture request failed (performance.now()). */
  failedAt: number;
  heightmap?: Float32Array;
  abort?: AbortController;
  mesh?: Mesh;
  /** Per-tile satellite material; only built with the texture, so it owns both. */
  material?: MeshStandardNodeMaterial;
  texture?: Texture;
  texState: 'idle' | 'loading' | 'ready' | 'failed';
  texAbort?: AbortController;
  /** Frame stamp for the LRU, and this frame's mark. */
  lastUsed: number;
  used: boolean;
  /** Held by a pending `ready()` call: never evict. */
  pin: number;
};

type Job = { rec: TileRecord; kind: 'elev' | 'sat'; controller: AbortController };

type Waiter = { keys: Set<string>; done: () => void };

/* ------------------------------------------------------------------ Terrain */

/**
 * Terrain around the walker: a chunked quadtree over the XYZ tile pyramid.
 * It is a display layer only — heights and colours never enter a Bundle, so
 * Derived = f(Facts) (invariant 1) is untouched. Tiles that are coarser than the
 * finest ready ancestor stand in for their children, so the ground is never holed.
 */
export class Terrain {
  readonly root = new Group();
  /** Called with a world rectangle (minX, minZ, maxX, maxZ) when its finest ground arrives. */
  onGround: (minX: number, minZ: number, maxX: number, maxZ: number) => void = () => {};
  private readonly frame: LocalFrame;
  private readonly scene: Scene;
  private readonly maxTiles: number;
  private readonly topo = topoMaterial();
  private readonly ocean: Mesh;
  private readonly records = new Map<string, TileRecord>();
  private readonly jobs: Job[] = [];
  private readonly activeJobs = new Set<Job>();
  private readonly buildQueue: TileRecord[] = [];
  private readonly waiters: Waiter[] = [];
  /** Whether each interior node is currently split, for the hysteresis band. */
  private readonly split = new Map<string, { split: boolean; seen: number }>();
  /** z15 heightmaps outliving their meshes; insertion order is the LRU order. */
  private readonly fine = new Map<string, Float32Array>();
  private inFlight = 0;
  private tick = 0;
  private visits = 0;
  /** What the last update drew, by key: the surface a walker actually sees. */
  private drawn = new Map<string, TileRecord>();
  /** The camera at the last update, to load the nearest tiles first. */
  private eye = { x: 0, z: 0 };
  private loaded = false;
  private failures = 0;
  private dead = false;
  private disposed = false;
  private _mode: TerrainMode;

  constructor(
    scene: Scene,
    frame: LocalFrame,
    opts: { mode?: TerrainMode; maxTiles?: number } = {},
  ) {
    this.scene = scene;
    this.frame = frame;
    this.maxTiles = Math.max(8, opts.maxTiles ?? 160);
    this._mode = opts.mode ?? 'topo';
    this.ocean = oceanMesh();
    this.root.add(this.ocean);
    scene.add(this.root);
  }

  /** True once any elevation tile has decoded; false forever after the first failure. */
  get active(): boolean {
    return this.loaded && !this.dead;
  }

  get mode(): TerrainMode {
    return this._mode;
  }

  set mode(m: TerrainMode) {
    if (m === this._mode) return;
    this._mode = m;
    for (const rec of this.records.values()) this.applyMaterial(rec);
  }

  /**
   * Ground height (m) at a world position, bilinear on the finest heightmap that
   * covers it. Fine tiles survive as heightmaps after their meshes are evicted,
   * so a moving walker keeps metre-scale relief around it.
   */
  /**
   * Where a walker stands: on the surface as drawn, or on the true ground where that is
   * higher. While only a coarse tile is drawn it can bulge above the true ground, and an
   * eye placed by `heightAt` alone would sit inside the hill.
   */
  standAt(x: number, z: number): number {
    return Math.max(this.heightAt(x, z), this.surfaceAt(x, z));
  }

  /** Height of the drawn mesh at a point: its own triangles, interpolated as rendered. */
  private surfaceAt(x: number, z: number): number {
    if (this.dead) return 0;
    const p = this.frame.unproject({ e: x, n: -z });
    for (let z0 = MAX_Z; z0 >= MIN_Z; z0--) {
      const t = tileOf(p.lat, p.lng, z0);
      const rec = this.drawn.get(tileKey(t));
      const pos = rec?.mesh?.geometry.getAttribute('position');
      if (!rec || !pos) continue;
      const seg = rec.z >= 14 ? 64 : 32;
      const side = seg + 1;
      const n = 2 ** z0;
      const u = (((p.lng + 180) / 360) * n - t.x) * seg;
      const v = (mercatorY(p.lat) * n - t.y) * seg;
      const i = Math.min(Math.max(Math.floor(u), 0), seg - 1);
      const j = Math.min(Math.max(Math.floor(v), 0), seg - 1);
      const [fx, fy] = [u - i, v - j];
      // Each quad is two triangles split from (i+1, j) to (i, j+1), as in buildMesh.
      const h = (ii: number, jj: number) => pos.getY(jj * side + ii);
      const surface =
        fx + fy <= 1
          ? h(i, j) + (h(i + 1, j) - h(i, j)) * fx + (h(i, j + 1) - h(i, j)) * fy
          : h(i + 1, j + 1) +
            (h(i, j + 1) - h(i + 1, j + 1)) * (1 - fx) +
            (h(i + 1, j) - h(i + 1, j + 1)) * (1 - fy);
      return Math.max(0, surface);
    }
    return 0;
  }

  /** Elevation before imagery, then the tile nearest the camera. */
  private nextJob(): number {
    let best = 0;
    let bestScore = Infinity;
    for (let k = 0; k < this.jobs.length; k++) {
      const { rec, kind } = this.jobs[k]!;
      const c = this.frame.project({
        lat: (rec.bounds.north + rec.bounds.south) / 2,
        lng: (rec.bounds.west + rec.bounds.east) / 2,
      });
      const score = Math.hypot(c.e - this.eye.x, -c.n - this.eye.z) + (kind === 'sat' ? 1e9 : 0);
      if (score < bestScore) [best, bestScore] = [k, score];
    }
    return best;
  }

  heightAt(x: number, z: number): number {
    if (this.dead) return 0;
    const p = this.frame.unproject({ e: x, n: -z });
    for (let z0 = MAX_Z; z0 >= MIN_Z; z0--) {
      const t = tileOf(p.lat, p.lng, z0);
      const key = tileKey(t);
      const hm = this.records.get(key)?.heightmap ?? this.fine.get(key);
      if (!hm) continue;
      const n = 2 ** z0;
      const fx = ((p.lng + 180) / 360) * n - t.x;
      const fy = mercatorY(p.lat) * n - t.y;
      // The sea is the walkable surface: Terrarium carries bathymetry, and nothing
      // (camera or building) belongs on the sea floor under the ocean plane.
      return Math.max(0, sampleHeightmap(hm, fx, fy));
    }
    return 0;
  }

  /**
   * Resolves once the finest heightmaps covering a world rectangle are in (or
   * have failed, or 4 s passed). Never rejects: a Bundle still stands on
   * whatever ground we have.
   */
  async ready(minX: number, minZ: number, maxX: number, maxZ: number): Promise<void> {
    if (this.dead || this.disposed) return;
    const keys = new Set<string>();
    const pinned: TileRecord[] = [];
    for (const t of this.tilesForRect(minX, minZ, maxX, maxZ)) {
      const key = tileKey(t);
      if (keys.has(key)) continue;
      const existing = this.records.get(key);
      if (existing?.heightmap || existing?.state === 'failed' || this.fine.has(key)) continue;
      const rec = existing ?? this.record(t);
      rec.pin++;
      this.markUsed(rec);
      this.requestHeight(rec);
      pinned.push(rec);
      keys.add(key);
    }
    if (keys.size === 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        keys,
        done: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          for (const rec of pinned) rec.pin = Math.max(0, rec.pin - 1);
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        },
      };
      const timer = setTimeout(waiter.done, READY_TIMEOUT);
      this.waiters.push(waiter);
    });
  }

  /** Call every frame: select tiles, start loads, build what decoded, evict. */
  update(x: number, y: number, z: number): void {
    if (this.dead || this.disposed) return;
    this.tick++;
    this.visits = 0;
    for (const rec of this.records.values()) rec.used = false;

    const drawn = new Set<TileRecord>();
    for (const root of this.rootTiles(x, z)) {
      // A coarse root is the fallback that keeps the ground closed while the
      // finer tiles are still in flight; it is one fetch for the whole area.
      this.requestHeight(this.record(root));
      for (const rec of this.select(root, x, y, z) ?? []) drawn.add(rec);
    }
    this.drawn = new Map([...drawn].map((r) => [r.key, r]));
    this.eye = { x, z };

    this.buildQueued();
    if (this._mode === 'satellite') {
      for (const rec of drawn) this.requestTexture(rec);
    }

    this.abortUnused();
    this.evict();

    for (const rec of this.records.values()) {
      if (rec.mesh) rec.mesh.visible = drawn.has(rec);
    }
    this.ocean.position.set(Math.round(x / 100) * 100, 0, Math.round(z / 100) * 100);
    this.ocean.visible = this.active;

    this.pruneSplit();
  }

  stats(): { tiles: number; heightmaps: number; loading: number; textures: number } {
    let heightmaps = 0;
    let textures = 0;
    for (const rec of this.records.values()) {
      if (rec.heightmap) heightmaps++;
      if (rec.texture) textures++;
    }
    return {
      tiles: this.records.size,
      heightmaps,
      loading: this.inFlight + this.jobs.length,
      textures,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of [...this.jobs, ...this.activeJobs]) job.controller.abort();
    this.jobs.length = 0;
    this.activeJobs.clear();
    for (const w of this.waiters.splice(0)) w.done();
    for (const rec of [...this.records.values()]) this.destroyRecord(rec);
    this.buildQueue.length = 0;
    this.fine.clear();
    this.split.clear();
    this.scene.remove(this.root);
    this.root.remove(this.ocean);
    this.ocean.geometry.dispose();
    oceanMaterialOf(this.ocean).dispose();
    this.topo.dispose();
  }

  /* ---------------------------------------------------------------- selection */

  private rootTiles(x: number, z: number): TileXYZ[] {
    const nw = this.frame.unproject({ e: x - ROOT_SPAN, n: -z + ROOT_SPAN });
    const se = this.frame.unproject({ e: x + ROOT_SPAN, n: -z - ROOT_SPAN });
    const a = tileOf(nw.lat, nw.lng, ROOT_Z);
    const b = tileOf(se.lat, se.lng, ROOT_Z);
    const out: TileXYZ[] = [];
    for (let tx = a.x; tx <= b.x; tx++) {
      for (let ty = a.y; ty <= b.y; ty++) out.push({ z: ROOT_Z, x: tx, y: ty });
    }
    return out;
  }

  /**
   * What to draw over a node's area: its children's selections where the camera is near
   * and every child area can be covered, otherwise this tile alone. Exactly one tile
   * covers each spot, so a fallback never overlaps finer tiles. Null when nothing in the
   * area has a mesh yet.
   */
  private select(node: TileXYZ, x: number, y: number, z: number): TileRecord[] | null {
    const rec = this.record(node);
    this.markUsed(rec);
    if (++this.visits > 2048) return rec.mesh ? [rec] : null;
    const key = rec.key;
    const wasSplit = this.split.get(key)?.split ?? false;
    const box = this.nodeBox(node);
    const width = Math.max(box.maxX - box.minX, box.maxZ - box.minZ);
    const dist = boxDistance(box, x, y, z);
    const limit = wasSplit ? width * MERGE_FACTOR : width * SPLIT_FACTOR;
    const split = node.z < MAX_Z && dist < limit;
    this.split.set(key, { split, seen: this.tick });
    if (!split) {
      this.requestHeight(rec);
      return rec.mesh ? [rec] : null;
    }
    const [z1, x0, y0] = [node.z + 1, node.x * 2, node.y * 2];
    const parts = [
      this.select({ z: z1, x: x0, y: y0 }, x, y, z),
      this.select({ z: z1, x: x0 + 1, y: y0 }, x, y, z),
      this.select({ z: z1, x: x0, y: y0 + 1 }, x, y, z),
      this.select({ z: z1, x: x0 + 1, y: y0 + 1 }, x, y, z),
    ];
    if (parts.every((p) => p)) return parts.flatMap((p) => p!);
    // Part of this area is not ready: this tile stands in for all four children.
    this.requestHeight(rec);
    if (rec.mesh) return [rec];
    return parts.flatMap((p) => p ?? []);
  }

  private nodeBox(node: TileXYZ): {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minY: number;
    maxY: number;
  } {
    const b = tileBounds(node.z, node.x, node.y);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [lat, lng] of [
      [b.north, b.west],
      [b.north, b.east],
      [b.south, b.west],
      [b.south, b.east],
    ] as const) {
      const p = this.frame.project({ lat, lng });
      const wx = p.e;
      const wz = -p.n;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const rec = this.records.get(tileKey(node));
    return { minX, maxX, minZ, maxZ, minY: rec?.minY ?? 0, maxY: rec?.maxY ?? 0 };
  }

  private pruneSplit(): void {
    if (this.split.size < 4096) return;
    const cutoff = this.tick - 240;
    for (const [key, value] of this.split) {
      if (value.seen < cutoff) this.split.delete(key);
    }
  }

  /* ---------------------------------------------------------------- records */

  private record(node: TileXYZ): TileRecord {
    const key = tileKey(node);
    const existing = this.records.get(key);
    if (existing) return existing;
    const rec: TileRecord = {
      key,
      z: node.z,
      x: node.x,
      y: node.y,
      bounds: tileBounds(node.z, node.x, node.y),
      minY: 0,
      maxY: 0,
      state: 'idle',
      texState: 'idle',
      failedAt: 0,
      lastUsed: this.tick,
      used: false,
      pin: 0,
    };
    this.records.set(key, rec);
    return rec;
  }

  private markUsed(rec: TileRecord): void {
    rec.used = true;
    rec.lastUsed = this.tick;
  }

  private destroyRecord(rec: TileRecord): void {
    this.records.delete(rec.key);
    rec.abort?.abort();
    rec.texAbort?.abort();
    if (rec.mesh) {
      this.root.remove(rec.mesh);
      rec.mesh.geometry.dispose();
      rec.mesh = undefined;
    }
    rec.material?.dispose();
    rec.material = undefined;
    if (rec.texture) {
      const image = rec.texture.image as ImageBitmap | undefined;
      // The bitmap *is* the texture source, so it can only be released with it.
      if (image && typeof image.close === 'function') image.close();
      rec.texture.dispose();
      rec.texture = undefined;
    }
    rec.heightmap = undefined;
    rec.state = 'idle';
    rec.texState = 'idle';
  }

  private evict(): void {
    if (this.records.size <= this.maxTiles) return;
    const pool = [...this.records.values()].filter(
      (r) => !r.used && r.pin === 0 && r.state !== 'loading' && r.texState !== 'loading',
    );
    pool.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const rec of pool) {
      if (this.records.size <= this.maxTiles) break;
      this.destroyRecord(rec);
    }
  }

  private abortUnused(): void {
    for (const rec of this.records.values()) {
      if (rec.used || rec.pin > 0) continue;
      if (rec.state === 'loading') {
        rec.abort?.abort();
        rec.abort = undefined;
        rec.state = 'idle';
      }
      if (rec.texState === 'loading') {
        rec.texAbort?.abort();
        rec.texAbort = undefined;
        rec.texState = 'idle';
      }
    }
  }

  /* ---------------------------------------------------------------- loading */

  private requestHeight(rec: TileRecord): void {
    if (rec.state === 'failed' && performance.now() - rec.failedAt > RETRY_AFTER)
      rec.state = 'idle';
    if (this.dead || this.disposed || rec.state !== 'idle') return;
    const controller = new AbortController();
    rec.state = 'loading';
    rec.abort = controller;
    this.jobs.push({ rec, kind: 'elev', controller });
    this.pump();
  }

  private requestTexture(rec: TileRecord): void {
    if (rec.texState === 'failed' && performance.now() - rec.failedAt > RETRY_AFTER)
      rec.texState = 'idle';
    if (this.dead || this.disposed || rec.texState !== 'idle' || !rec.mesh) return;
    const controller = new AbortController();
    rec.texState = 'loading';
    rec.texAbort = controller;
    this.jobs.push({ rec, kind: 'sat', controller });
    this.pump();
  }

  private pump(): void {
    while (!this.dead && !this.disposed && this.inFlight < MAX_FETCHES && this.jobs.length) {
      // Elevation first: it decides whether there is ground at all; imagery only colours it.
      const job = this.jobs.splice(this.nextJob(), 1)[0]!;
      if (job.controller.signal.aborted) continue;
      this.inFlight++;
      this.activeJobs.add(job);
      const run = job.kind === 'elev' ? this.fetchElevation(job) : this.fetchSatellite(job);
      run
        .catch((err: unknown) => {
          if (job.controller.signal.aborted) return;
          if (job.kind === 'elev') this.failElevation(job.rec);
          else this.failTexture(job.rec);
          console.warn(`terrain: tile ${job.rec.key}`, err);
        })
        .finally(() => {
          this.activeJobs.delete(job);
          this.inFlight--;
          this.pump();
        });
    }
  }

  private async fetchElevation(job: Job): Promise<void> {
    const rec = job.rec;
    const res = await fetch(`/api/tiles/elev/${rec.z}/${rec.x}/${rec.y}.png`, {
      signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
    });
    if (!res.ok) throw new Error(`elev ${rec.key}: HTTP ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    let hm: Float32Array;
    try {
      hm = decodeTerrarium(bitmap);
    } finally {
      bitmap.close();
    }
    if (job.controller.signal.aborted || this.records.get(rec.key) !== rec) return;
    this.onHeightmap(rec, hm);
  }

  private async fetchSatellite(job: Job): Promise<void> {
    const rec = job.rec;
    const res = await fetch(`/api/tiles/sat/${rec.z}/${rec.x}/${rec.y}.jpg`, {
      signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
    });
    if (!res.ok) throw new Error(`sat ${rec.key}: HTTP ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    if (job.controller.signal.aborted || this.records.get(rec.key) !== rec) {
      bitmap.close();
      return;
    }
    const tex = new Texture(bitmap);
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = false; // v = 0 is the north edge, i.e. the first row of the JPEG
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0, side: DoubleSide });
    m.colorNode = texture(tex);
    m.name = `terrain-satellite/${rec.key}`;
    rec.texture = tex;
    rec.material = m;
    rec.texState = 'ready';
    rec.texAbort = undefined;
    this.applyMaterial(rec);
  }

  private onHeightmap(rec: TileRecord, hm: Float32Array): void {
    rec.heightmap = hm;
    rec.state = 'ready';
    rec.abort = undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < hm.length; i++) {
      const h = hm[i]!;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    rec.minY = lo;
    rec.maxY = hi;
    if (rec.z === MAX_Z) {
      this.rememberFine(rec.key, hm);
      const nw = this.frame.project({ lat: rec.bounds.north, lng: rec.bounds.west });
      const se = this.frame.project({ lat: rec.bounds.south, lng: rec.bounds.east });
      this.onGround(nw.e, -nw.n, se.e, -se.n);
    }
    if (!this.loaded) {
      this.loaded = true;
      this.ocean.visible = true;
    }
    if (!rec.mesh) this.buildQueue.push(rec);
    this.settle(rec.key);
  }

  private failElevation(rec: TileRecord): void {
    rec.state = 'failed';
    rec.failedAt = performance.now();
    rec.abort = undefined;
    this.settle(rec.key);
    // Several failures and nothing ever loaded: the source is unreachable, so stop
    // asking and fall back to a flat world. Keeps tests (and the walk) deterministic.
    // One failure is not enough: a single missing tile or a 502 must not turn it off.
    if (!this.loaded && ++this.failures >= DEAD_AFTER) this.deactivate();
  }

  private failTexture(rec: TileRecord): void {
    rec.texState = 'failed';
    rec.failedAt = performance.now();
    rec.texAbort = undefined;
  }

  private deactivate(): void {
    if (this.dead) return;
    this.dead = true;
    for (const job of [...this.jobs, ...this.activeJobs]) job.controller.abort();
    this.jobs.length = 0;
    this.ocean.visible = false;
    for (const w of this.waiters.splice(0)) w.done();
  }

  private settle(key: string): void {
    for (const w of [...this.waiters]) {
      w.keys.delete(key);
      if (w.keys.size === 0) w.done();
    }
  }

  private rememberFine(key: string, hm: Float32Array): void {
    this.fine.delete(key);
    this.fine.set(key, hm);
    while (this.fine.size > FINE_HEIGHTMAPS) {
      const oldest = this.fine.keys().next().value;
      if (oldest === undefined) break;
      this.fine.delete(oldest);
    }
  }

  /** The finest level at which a world rectangle is a handful of tiles. */
  private tilesForRect(minX: number, minZ: number, maxX: number, maxZ: number): TileXYZ[] {
    let north = -Infinity;
    let south = Infinity;
    let west = Infinity;
    let east = -Infinity;
    for (const [cx, cz] of [
      [minX, minZ],
      [maxX, minZ],
      [minX, maxZ],
      [maxX, maxZ],
    ] as const) {
      const p = this.frame.unproject({ e: cx, n: -cz });
      north = Math.max(north, p.lat);
      south = Math.min(south, p.lat);
      west = Math.min(west, p.lng);
      east = Math.max(east, p.lng);
    }
    for (let z = MAX_Z; z >= MIN_Z; z--) {
      const a = tileOf(north, west, z);
      const b = tileOf(south, east, z);
      const count = (b.x - a.x + 1) * (b.y - a.y + 1);
      if (count > READY_TILE_LIMIT && z > MIN_Z) continue;
      const out: TileXYZ[] = [];
      for (let x = a.x; x <= b.x; x++) {
        for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
      }
      return out;
    }
    return [];
  }

  /* ---------------------------------------------------------------- meshes */

  private buildQueued(): void {
    let built = 0;
    while (built < BUILDS_PER_FRAME && this.buildQueue.length > 0) {
      const rec = this.buildQueue.shift()!;
      if (this.records.get(rec.key) !== rec || rec.mesh || !rec.heightmap) continue;
      this.buildMesh(rec);
      built++;
    }
  }

  private buildMesh(rec: TileRecord): void {
    const hm = rec.heightmap;
    if (!hm) return;
    const seg = rec.z >= 14 ? 64 : 32;
    const side = seg + 1;
    /** Crack hider: an apron dropped this far below the tile's rim. */
    const skirt = 60 * (16 - rec.z);
    const gridCount = side * side;
    const total = gridCount + 4 * side;
    const positions = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    /** Where each vertex's colour comes from: a skirt is coloured as its rim, not as low ground. */
    const shadeFrom = new Uint32Array(total);

    const b = rec.bounds;
    const dLng = b.east - b.west;
    const n = 2 ** rec.z;
    // Local coordinates keep float32 metres precise even 16 km from the origin.
    const origin = this.frame.project({ lat: b.north, lng: b.west });
    const ox = origin.e;
    const oz = -origin.n;

    for (let j = 0; j < side; j++) {
      const v = j / seg;
      // Rows are even in Mercator y, as the tile's pixels are, not even in latitude.
      const lat = tileLat(rec.y + v, n);
      for (let i = 0; i < side; i++) {
        const u = i / seg;
        // Exact per-vertex projection: the local frame is not a flat scale.
        const p = this.frame.project({ lat, lng: b.west + dLng * u });
        const k = j * side + i;
        positions[k * 3] = p.e - ox;
        positions[k * 3 + 1] = sampleHeightmap(hm, u, v);
        positions[k * 3 + 2] = -p.n - oz;
        uvs[k * 2] = u;
        uvs[k * 2 + 1] = v;
      }
    }

    const edges: ((k: number) => number)[] = [
      (k) => k,
      (k) => seg * side + k,
      (k) => k * side,
      (k) => k * side + seg,
    ];
    let w = gridCount;
    for (const edge of edges) {
      for (let k = 0; k < side; k++) {
        const g = edge(k);
        positions[w * 3] = positions[g * 3]!;
        positions[w * 3 + 1] = positions[g * 3 + 1]! - skirt;
        positions[w * 3 + 2] = positions[g * 3 + 2]!;
        uvs[w * 2] = uvs[g * 2]!;
        uvs[w * 2 + 1] = uvs[g * 2 + 1]!;
        shadeFrom[w] = g;
        w++;
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * side + i;
        const c = a + side;
        indices.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    for (let s = 0; s < 4; s++) {
      const base = gridCount + s * side;
      for (let k = 0; k < seg; k++) {
        const t0 = edges[s]!(k);
        const t1 = edges[s]!(k + 1);
        indices.push(t0, base + k, t1, t1, base + k, base + k + 1);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    // Normals from the surface alone: counting the vertical skirt faces would tilt every
    // rim normal and draw each tile's outline as a line of "steep" rock.
    geometry.setIndex(indices.slice(0, seg * seg * 6));
    geometry.computeVertexNormals();
    geometry.setIndex(indices);
    // Neighbouring tiles sample their own edge pixels, so hairline cracks open between
    // them and the skirts show through. Shaded as the rim (its height for colour, its
    // normal for light), a skirt reads as the surface itself.
    const normals = geometry.getAttribute('normal');
    const ground = new Float32Array(total);
    for (let k = 0; k < total; k++) {
      const g = k < gridCount ? k : shadeFrom[k]!;
      ground[k] = positions[g * 3 + 1]!;
      if (k >= gridCount) normals.setXYZ(k, normals.getX(g), normals.getY(g), normals.getZ(g));
    }
    geometry.setAttribute('ground', new BufferAttribute(ground, 1));
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, this.topo);
    mesh.name = rec.key;
    mesh.position.set(ox, 0, oz);
    mesh.visible = false;
    rec.mesh = mesh;
    this.root.add(mesh);
    this.applyMaterial(rec);
  }

  private applyMaterial(rec: TileRecord): void {
    if (!rec.mesh) return;
    rec.mesh.material = this._mode === 'satellite' && rec.material ? rec.material : this.topo;
  }
}

/* ------------------------------------------------------------------ materials */

/**
 * Topo shading: a coastal temperate rainforest palette keyed on height and slope,
 * with 20 m and 100 m contours that fade out by 3 km so distance reads as haze.
 */
function topoMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0, side: DoubleSide });
  const h = attribute<'float'>('ground', 'float');
  const slope = float(1).sub(normalWorld.y);

  // A cheap two-sine ripple, so the snow line does not read as a contour itself.
  const snowLine = float(1150).add(
    sin(positionWorld.x.mul(0.0013))
      .add(sin(positionWorld.z.mul(0.0019)))
      .mul(40),
  );

  let ground = mix(color('#8a8270'), color('#3f5a3a'), smoothstep(0.5, 4, h));
  ground = mix(ground, color('#4c6b45'), smoothstep(20, 260, h));
  ground = mix(ground, color('#7d8a5c'), smoothstep(350, 700, h));
  ground = mix(
    ground,
    color('#7a7468'),
    max(smoothstep(0.35, 0.55, slope), smoothstep(850, 950, h)),
  );
  ground = mix(ground, color('#f2f2ee'), smoothstep(snowLine.sub(40), snowLine.add(40), h));

  // Pixel-width lines from the screen-space derivative of the height itself.
  const contour = (interval: number) => {
    const t = h.div(interval);
    const f = fract(t);
    const width = max(fwidth(t), float(1e-4));
    const edge = min(f, float(1).sub(f));
    return float(1).sub(smoothstep(0, width.mul(1.5), edge));
  };
  const reach = float(1).sub(
    smoothstep(CONTOUR_NEAR, CONTOUR_FAR, distance(cameraPosition, positionWorld)),
  );
  const lines = contour(20).mul(0.1).add(contour(100).mul(0.25)).mul(reach);

  m.colorNode = ground.mul(float(1).sub(lines));
  m.name = 'terrain-topo';
  return m;
}

function oceanMesh(): Mesh {
  const geometry = new PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, oceanMaterial());
  mesh.name = 'ocean';
  // Opaque terrain draws in any order; the sea goes last so its fresnel never
  // fights the coastline at y = 0.
  mesh.renderOrder = 1;
  mesh.visible = false;
  return mesh;
}

function oceanMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0 });
  m.color.set(OCEAN_DEEP);
  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(float(1).sub(clamp(dot(view, vec3(0, 1, 0)), 0, 1)), 3);
  m.colorNode = mix(color(OCEAN_DEEP), color(OCEAN_SHEEN), fresnel);
  m.name = 'ocean';
  return m;
}

function oceanMaterialOf(mesh: Mesh): MeshStandardNodeMaterial {
  return mesh.material as MeshStandardNodeMaterial;
}

/* ------------------------------------------------------------------ decoding */

let decodeCtx: OffscreenCanvasRenderingContext2D | null = null;

function terrariumContext(): OffscreenCanvasRenderingContext2D {
  if (!decodeCtx) {
    const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('terrain: no 2D context to decode elevation tiles');
    decodeCtx = ctx;
  }
  return decodeCtx;
}

/** Terrarium: h = R * 256 + G + B / 256 - 32768, in metres. */
function decodeTerrarium(bitmap: ImageBitmap): Float32Array {
  const ctx = terrariumContext();
  ctx.clearRect(0, 0, TILE_PX, TILE_PX);
  ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
  const { data } = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = data[j]! * 256 + data[j + 1]! + data[j + 2]! / 256 - 32768;
  }
  return out;
}

/** Bilinear on the 256×256 heightmap; `u` runs west→east, `v` north→south. */
export function sampleHeightmap(hm: Float32Array, u: number, v: number): number {
  // Pixel i covers [i, i+1) / 256 of the tile; its value belongs at its centre.
  const px = Math.min(Math.max(u * TILE_PX - 0.5, 0), TILE_PX - 1);
  const py = Math.min(Math.max(v * TILE_PX - 0.5, 0), TILE_PX - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, TILE_PX - 1);
  const y1 = Math.min(y0 + 1, TILE_PX - 1);
  const fx = px - x0;
  const fy = py - y0;
  const a = hm[y0 * TILE_PX + x0]!;
  const b = hm[y0 * TILE_PX + x1]!;
  const c = hm[y1 * TILE_PX + x0]!;
  const d = hm[y1 * TILE_PX + x1]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* ------------------------------------------------------------------ geometry helpers */

function boxDistance(
  b: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  x: number,
  y: number,
  z: number,
): number {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
