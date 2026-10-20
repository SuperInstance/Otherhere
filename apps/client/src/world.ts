import {
  BufferAttribute,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  Raycaster,
  Vector3,
  type BufferGeometry,
  type Scene,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { gridDisk } from 'h3-js';
import {
  buildBundle,
  cellAt,
  cellCenter,
  cellRing,
  demoLot,
  fnv1a32,
  DEMO_CELL,
  localFrame,
  questsFor,
  sha256Hex,
  type Quest,
  type CapsuleCellInput,
  type BundleManifest,
  type LocalFrame,
} from '@otherhere/core';
import { MAX_GROUND, MIN_GROUND } from './forest';
import { confidenceMaterial } from './material';

type CellState = {
  state: 'loading' | 'ready' | 'error';
  /** 'ok' = built from OSM; 'failed' / 'loading' = no OSM yet, showing the sketch. */
  ingest?: 'ok' | 'failed' | 'loading';
  /** How many times we have re-asked for a sketch Cell. */
  retries?: number;
  manifest?: BundleManifest;
  verified?: boolean;
  group?: Group;
  /**
   * The Bundle this Cell replaced, still on screen until the new one lands —
   * a retry or a capture must never blank the neighbourhood it is improving.
   */
  stale?: { group: Group; beacons?: Group; clearings?: Disc[] };
  roadPoints?: { x: number; z: number }[];
  /** Vertex ranges per Feature, from the Bundle's extras: what the walker can pick. */
  ranges?: { id: string; first: number; count: number }[];
  /** Buildings worth photographing here, each marked by a beacon. */
  quests?: Quest[];
  beacons?: Group;
  /** The mesh's positions as built (flat), to stand it on the ground again when finer heights arrive. */
  flat?: Float32Array;
  /** Where nothing may grow: discs around buildings and along roads, world frame. */
  clearings?: Disc[];
  /** World-space footprint, for matching new ground to Cells. */
  box?: { minX: number; minZ: number; maxX: number; maxZ: number };
};

export type WorldStats = {
  ready: number;
  loading: number;
  sketch: number;
  errors: number;
  features: number;
  verified: number;
  mismatched: number;
  quests: number;
};

/** Where Bundles come from: the edge API, the built-in demo lot, or a postcard's Fact snapshot. */
type Source = 'api' | 'demo' | { capsule: Map<string, CapsuleCellInput> };

const MAX_PARALLEL = 3;

type Disc = { x: number; z: number; r: number };
/** Clearings are bucketed on this grid (m), so a point query looks at a handful of discs. */
const CLEAR_BUCKET = 32;

/** What the World needs from the terrain layer to stand Bundles on real ground. */
export type Ground = {
  readonly active: boolean;
  heightAt(x: number, z: number): number;
  ready(minX: number, minZ: number, maxX: number, maxZ: number): Promise<void>;
  /** Called when finer ground arrives for a world rectangle. */
  onGround: (minX: number, minZ: number, maxX: number, maxZ: number) => void;
};

/**
 * Loads Bundles around the walker. Each Bundle is in its own Cell-centred frame;
 * here it is offset into one world frame centred on the starting Cell.
 */
export class World {
  readonly frame: LocalFrame;
  private cells = new Map<string, CellState>();
  private queue: string[] = [];
  private active = 0;
  private loader = new GLTFLoader();
  private material = confidenceMaterial();
  readonly root = new Group();
  /** Quest beacons: kept apart from `root` so taps and walk capture never pick them. */
  private beaconRoot = new Group();
  private beaconMaterial = (() => {
    const m = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
    m.color.set(0xffa21a);
    return m;
  })();
  onChange: () => void = () => {};
  /** Called with a world rectangle when Bundles there arrive or go (what grows must change). */
  onBuilt: (minX: number, minZ: number, maxX: number, maxZ: number) => void = () => {};
  private clearBuckets = new Map<string, Disc[]>();
  /** Cells whose ground got finer since they were stood on it. */
  private resnap = new Set<string>();

  constructor(
    scene: Scene,
    readonly originCell: string,
    private source: Source = 'api',
    private ground?: Ground,
  ) {
    this.frame = localFrame(cellCenter(originCell));
    if (ground) ground.onGround = (...rect) => this.groundChanged(...rect);
    scene.add(this.root);
    scene.add(this.beaconRoot);
  }

  /** The Cell under a world-frame position. */
  cellAtWorld(x: number, z: number): string {
    const p = this.frame.unproject({ e: x, n: -z });
    return cellAt(p.lat, p.lng);
  }

  /** Keep the walker's Cell and its ring loaded; drop Cells more than 2 rings away. */
  update(x: number, z: number): void {
    this.standAgain();
    if (this.source === 'demo') {
      this.want(DEMO_CELL);
      return;
    }
    if (typeof this.source === 'object') {
      // A postcard is exactly its Cells: load them all, nothing beyond.
      for (const c of this.source.capsule.keys()) this.want(c);
      return;
    }
    const here = this.cellAtWorld(x, z);
    for (const c of cellRing(here, 1)) this.want(c);
    const keep = new Set(gridDisk(here, 2));
    for (const [c, s] of this.cells) {
      if (!keep.has(c) && s.state !== 'loading') {
        this.drop(s);
        this.cells.delete(c);
        this.onChange();
      }
    }
  }

  /** True where a building or road stands (with a margin): nothing should grow there. */
  occupied(x: number, z: number): boolean {
    const bx = Math.floor(x / CLEAR_BUCKET);
    const bz = Math.floor(z / CLEAR_BUCKET);
    for (let i = bx - 1; i <= bx + 1; i++)
      for (let j = bz - 1; j <= bz + 1; j++)
        for (const d of this.clearBuckets.get(`${i},${j}`) ?? [])
          if ((d.x - x) ** 2 + (d.z - z) ** 2 < d.r * d.r) return true;
    return false;
  }

  private indexClearings() {
    this.clearBuckets.clear();
    for (const s of this.cells.values())
      for (const d of [...(s.clearings ?? []), ...(s.stale?.clearings ?? [])]) {
        const key = `${Math.floor(d.x / CLEAR_BUCKET)},${Math.floor(d.z / CLEAR_BUCKET)}`;
        const list = this.clearBuckets.get(key);
        if (list) list.push(d);
        else this.clearBuckets.set(key, [d]);
      }
  }

  private announceBuilt(s: CellState) {
    if (s.box) this.onBuilt(s.box.minX, s.box.minZ, s.box.maxX, s.box.maxZ);
  }

  /** Take a replaced Bundle off the screen: its successor is up (or the Cell is gone). */
  private retire(s: CellState) {
    const stale = s.stale;
    if (!stale) return;
    s.stale = undefined;
    this.root.remove(stale.group);
    stale.group.traverse((o) => (o as Mesh).geometry?.dispose());
    if (stale.beacons) {
      this.beaconRoot.remove(stale.beacons);
      stale.beacons.traverse((o) => (o as Mesh).geometry?.dispose());
    }
  }

  private drop(s: CellState) {
    this.retire(s); // a failed reload may still be holding the screen
    if (s.clearings?.length) {
      s.clearings = [];
      this.indexClearings();
      this.announceBuilt(s);
    }
    if (s.group) {
      this.root.remove(s.group);
      s.group.traverse((o) => (o as Mesh).geometry?.dispose());
    }
    if (s.beacons) {
      this.beaconRoot.remove(s.beacons);
      s.beacons.traverse((o) => (o as Mesh).geometry?.dispose());
    }
  }

  private want(cell: string) {
    if (this.cells.has(cell)) return;
    this.cells.set(cell, { state: 'loading' });
    this.queue.push(cell);
    this.pump();
  }

  private pump() {
    while (this.active < MAX_PARALLEL && this.queue.length) {
      const cell = this.queue.shift()!;
      this.active++;
      this.load(cell)
        .catch((err) => {
          console.error(`cell ${cell}`, err);
          const s = this.cells.get(cell);
          if (s) s.state = 'error';
        })
        .finally(() => {
          this.active--;
          this.onChange();
          this.pump();
        });
    }
  }

  private async load(cell: string) {
    let manifest: BundleManifest;
    let bytes: Uint8Array;
    let ingest: 'ok' | 'failed' | 'loading' = 'ok';
    let quests: Quest[] = [];
    if (this.source === 'demo' || typeof this.source === 'object') {
      // Built in the browser: the same interpreter, the same bytes (invariant 2).
      const input =
        this.source === 'demo'
          ? { features: demoLot(cell) }
          : (this.source.capsule.get(cell) ?? { features: [] });
      const built = await buildBundle({ cell, ...input });
      // A postcard carries its Facts, so its Quests can be worked out right here.
      if (this.source !== 'demo')
        quests = questsFor(
          cell,
          input.features.filter((f) => f.kind === 'building'),
        );
      manifest = built.manifest;
      bytes = built.glb;
    } else {
      const [info, q] = await Promise.all([
        fetchJson<{ manifest: BundleManifest; status: 'ok' | 'failed' | 'loading' }>(
          `/api/cells/${cell}`,
        ),
        // Quests are a nicety: a Cell still loads without them.
        fetchJson<{ quests: Quest[] }>(`/api/cells/${cell}/quests`).catch(() => ({ quests: [] })),
      ]);
      quests = q.quests;
      manifest = info.manifest;
      ingest = info.status;
      bytes = new Uint8Array(
        await (await fetchOk(`/api/bundles/${manifest.inputsHash}.glb`)).arrayBuffer(),
      );
    }
    const verified = (await sha256Hex(bytes)) === manifest.outputHash;
    const gltf = await this.loader.parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );

    const group = new Group();
    group.name = cell;
    const roadPoints: { x: number; z: number }[] = [];
    gltf.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry as BufferGeometry;
      const m = new Mesh(geometry, this.material);
      m.name = mesh.name;
      // Coplanar surfaces from neighbouring Cells tie in depth; three breaks ties by
      // creation order, i.e. network order. Order by Cell ID so reloads are identical.
      m.renderOrder = fnv1a32(cell) % 1_000_000;
      group.add(m);
      roadPoints.push(...roadVertices(geometry, gltf.userData));
      liftAttribute(geometry, gltf.userData);
    });
    const c = this.frame.project(cellCenter(cell));
    group.position.set(c.e, 0, -c.n);
    const featureRanges =
      (
        gltf.userData as {
          otherhere?: { features?: { id: string; first: number; count: number }[] };
        }
      ).otherhere?.features ?? [];
    const footing = this.ground ? await this.standOnGround(group, featureRanges) : undefined;
    for (const p of roadPoints) {
      p.x += c.e;
      p.z -= c.n;
    }

    const state = this.cells.get(cell);
    if (!state) return; // evicted while loading
    const ranges = featureRanges;
    const beacons = this.beaconsFor(group, ranges, quests);
    beacons.position.copy(group.position);
    Object.assign(state, {
      state: 'ready',
      manifest,
      verified,
      group,
      ingest,
      roadPoints,
      ranges,
      quests,
      beacons,
      ...footing,
    });
    state.clearings = clearingsFor(group, ranges);
    this.indexClearings();
    this.root.add(group);
    this.beaconRoot.add(beacons);
    this.retire(state); // the replaced Bundle, if any, leaves only now
    this.announceBuilt(state);
    // A sketch Cell may be waiting on OpenStreetMap: ask again a few times.
    const retries = state.retries ?? 0;
    if (ingest !== 'ok' && retries < 3) {
      setTimeout(
        () => {
          if (this.cells.get(cell) !== state) return;
          this.reload(cell);
          const next = this.cells.get(cell);
          if (next) next.retries = retries + 1;
        },
        ingest === 'loading' ? 10_000 : 30_000,
      );
    }
  }

  /**
   * Bundles are built on flat ground (Derived = f(Facts), invariant 1); the terrain is a
   * display layer from public elevation data. After the hash is checked, each Feature is
   * moved onto it: anything with height (a building) as one rigid piece onto the lowest
   * ground under it, so floors stay level; flat things (roads, paths) per vertex. The
   * Cell's flat ground hexagon is collapsed: the terrain is the ground now. The flat
   * positions are kept, so the Cell can be stood again when finer ground arrives.
   */
  private async standOnGround(
    group: Group,
    ranges: { id: string; first: number; count: number }[],
  ): Promise<{ flat: Float32Array; box: NonNullable<CellState['box']> } | undefined> {
    // A Bundle is one merged mesh, as pick() and roofSpot() assume.
    const mesh = group.children.find((o) => (o as Mesh).isMesh) as Mesh | undefined;
    if (!mesh) return undefined;
    const flat = (mesh.geometry.getAttribute('position').array as Float32Array).slice();
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox!;
    const o = group.position;
    const box = {
      minX: o.x + b.min.x,
      minZ: o.z + b.min.z,
      maxX: o.x + b.max.x,
      maxZ: o.z + b.max.z,
    };
    await this.ground!.ready(box.minX, box.minZ, box.maxX, box.maxZ);
    this.stand(mesh, flat, ranges, o.x, o.z);
    return { flat, box };
  }

  private stand(
    mesh: Mesh,
    flat: Float32Array,
    ranges: { id: string; first: number; count: number }[],
    ox: number,
    oz: number,
  ) {
    const g = this.ground!;
    if (!g.active) return;
    const pos = mesh.geometry.getAttribute('position');
    (pos.array as Float32Array).set(flat);
    standFeatures(pos, ranges, ox, oz, g);
    pos.needsUpdate = true;
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }

  private groundChanged(minX: number, minZ: number, maxX: number, maxZ: number) {
    for (const [cell, s] of this.cells) {
      const b = s.box;
      if (b && b.minX <= maxX && b.maxX >= minX && b.minZ <= maxZ && b.maxZ >= minZ)
        this.resnap.add(cell);
    }
  }

  /** Stand one Cell on newly arrived ground per frame, and move its beacons with it. */
  private standAgain() {
    const cell = this.resnap.values().next().value;
    if (cell === undefined) return;
    this.resnap.delete(cell);
    const s = this.cells.get(cell);
    const mesh = s?.group?.children.find((o) => (o as Mesh).isMesh) as Mesh | undefined;
    if (!s || !mesh || !s.flat || s.state !== 'ready') return;
    this.stand(mesh, s.flat, s.ranges ?? [], s.group!.position.x, s.group!.position.z);
    if (s.beacons) {
      this.beaconRoot.remove(s.beacons);
      s.beacons.traverse((o) => (o as Mesh).geometry?.dispose());
    }
    s.beacons = this.beaconsFor(s.group!, s.ranges ?? [], s.quests ?? []);
    s.beacons.position.copy(s.group!.position);
    this.beaconRoot.add(s.beacons);
  }

  /** A tall amber column with a marker above each Quest building, placed from its vertices. */
  private beaconsFor(
    group: Group,
    ranges: { id: string; first: number; count: number }[],
    quests: Quest[],
  ): Group {
    const out = new Group();
    const mesh = group.children.find((o) => (o as Mesh).isMesh) as Mesh | undefined;
    const pos = mesh?.geometry.getAttribute('position');
    if (!pos) return out;
    for (const q of quests) {
      const r = ranges.find((x) => x.id === q.featureId);
      if (!r) continue;
      const spot = roofSpot(mesh!.geometry, r);
      if (!spot) continue;
      const { x, z, top } = spot;
      const column = new Mesh(new CylinderGeometry(0.6, 0.6, 30, 8, 1, true), this.beaconMaterial);
      column.position.set(x, top + 15, z);
      const marker = new Mesh(new OctahedronGeometry(1.6), this.beaconMaterial);
      marker.position.set(x, top + 4, z);
      column.name = marker.name = q.id;
      out.add(column, marker);
    }
    return out;
  }

  /** Where each Quest's building is, in the world frame (for tests and tooling). */
  questTargets(): { featureId: string; x: number; z: number; top: number }[] {
    const out: { featureId: string; x: number; z: number; top: number }[] = [];
    for (const s of this.cells.values()) {
      for (const m of s.beacons?.children ?? []) {
        if (!((m as Mesh).geometry instanceof OctahedronGeometry)) continue;
        out.push({
          featureId: m.name.replace(/^photo:/, ''),
          x: m.position.x + s.beacons!.position.x,
          z: m.position.z + s.beacons!.position.z,
          top: m.position.y - 4,
        });
      }
    }
    return out;
  }

  /** The open Quest on a Feature, if there is one. */
  questFor(featureId: string): Quest | undefined {
    for (const s of this.cells.values()) {
      const q = s.quests?.find((x) => x.featureId === featureId);
      if (q) return q;
    }
    return undefined;
  }

  /** The Feature under a ray (from a tap), if any. */
  pick(raycaster: Raycaster): { cell: string; featureId: string; distance: number } | null {
    const hits = raycaster.intersectObject(this.root, true);
    for (const hit of hits) {
      const cell = hit.object.parent?.name;
      const s = cell ? this.cells.get(cell) : undefined;
      if (!s?.ranges || !hit.face) continue;
      const v = hit.face.a;
      const f = s.ranges.find((r) => v >= r.first && v < r.first + r.count);
      if (f) return { cell: cell!, featureId: f.id, distance: hit.distance };
      return null; // hit the ground
    }
    return null;
  }

  /**
   * The building a walker at (x, z) is most likely filming when walking along
   * `dir`: a fan of eye-level rays, centre first, nearest building wins ties.
   */
  buildingAlong(
    x: number,
    z: number,
    dir: { x: number; z: number },
    range = 80,
  ): { cell: string; featureId: string } | null {
    const ray = new Raycaster();
    ray.far = range;
    for (const deg of [0, -12, 12, -24, 24, -36, 36]) {
      const a = (deg * Math.PI) / 180;
      const dx = dir.x * Math.cos(a) - dir.z * Math.sin(a);
      const dz = dir.x * Math.sin(a) + dir.z * Math.cos(a);
      const eye = (this.ground?.active ? this.ground.heightAt(x, z) : 0) + 1.6;
      ray.set(new Vector3(x, eye, z), new Vector3(dx, 0, dz).normalize());
      for (const hit of ray.intersectObject(this.root, true)) {
        const cell = hit.object.parent?.name;
        const s = cell ? this.cells.get(cell) : undefined;
        if (!s?.ranges || !hit.face) continue;
        const v = hit.face.a;
        const f = s.ranges.find((r) => v >= r.first && v < r.first + r.count);
        if (f && /^osm:w\d+$/.test(f.id)) return { cell: cell!, featureId: f.id };
        if (f && !/^osm:n\d+$/.test(f.id)) break; // a road or the ground: look along the next ray
      }
    }
    return null;
  }

  /** Throw away a Cell's Bundle and load its current one (after its Facts changed). */
  reload(cell: string): void {
    const s = this.cells.get(cell);
    this.cells.delete(cell);
    this.want(cell);
    if (!s?.group) return;
    // Keep what is on screen while the reload flies: the old Bundle stays
    // visible until the new one lands, so a sketch Cell's retry (or a capture
    // sharpening a building) never pops the neighbourhood to empty ground.
    const next = this.cells.get(cell);
    if (next) next.stale = { group: s.group, beacons: s.beacons, clearings: s.clearings ?? [] };
  }

  /** A good place to stand: the road vertex nearest the given point, if any is loaded. */
  nearestRoad(x: number, z: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let d = Infinity;
    for (const s of this.cells.values()) {
      for (const p of s.roadPoints ?? []) {
        const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (dd < d) [d, best] = [dd, p];
      }
    }
    return best;
  }

  isReady(cell: string): boolean {
    return this.cells.get(cell)?.state === 'ready';
  }

  stats(): WorldStats {
    const s: WorldStats = {
      ready: 0,
      loading: 0,
      sketch: 0,
      errors: 0,
      features: 0,
      verified: 0,
      mismatched: 0,
      quests: 0,
    };
    for (const c of this.cells.values()) {
      if (c.state === 'loading') s.loading++;
      else if (c.state === 'error') s.errors++;
      else {
        s.ready++;
        s.features += c.manifest?.featureCount ?? 0;
        s.quests += c.quests?.length ?? 0;
        if (c.ingest === 'failed') s.sketch++;
        if (c.verified) s.verified++;
        else s.mismatched++;
      }
    }
    return s;
  }
}

/**
 * A position attribute, or anything shaped like one, so standing can be tested
 * without three.js geometry.
 */
type Positions = {
  readonly count: number;
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
  setXYZ(i: number, x: number, y: number, z: number): void;
  setY(i: number, y: number): void;
};

/**
 * Stands one Bundle's flat geometry on real ground (ADR-0016), in place. The
 * first range is the Cell's flat ground hexagon, collapsed deep below the world;
 * anything with height (a building, a tree) moves as one rigid piece onto the
 * lowest ground under it, so floors stay level; flat things (roads, paths) drape
 * per vertex.
 *
 * Imagined trees (`gen:` ids, ADR-0017) are site-checked first: the build that
 * imagined them has no elevation, so it plants stands in the sea (61 % of the
 * trees in the two wild Cells across Sitka's bay sit below the beach line). The
 * display layer, which owns the terrain, applies the forest's own beach and
 * timber lines here, so an imagined stand ends at the coast. Collapsed features
 * join the ground hexagon below the world, where nothing picks them; a resnap on
 * finer ground stands them again and re-decides.
 */
export function standFeatures(
  pos: Positions,
  ranges: { id: string; first: number; count: number }[],
  ox: number,
  oz: number,
  ground: Pick<Ground, 'active' | 'heightAt'>,
): void {
  if (!ground.active) return;
  const groundAt = (i: number) => ground.heightAt(ox + pos.getX(i), oz + pos.getZ(i));
  const first = ranges[0]?.first ?? pos.count;
  for (let i = 0; i < first; i++) pos.setXYZ(i, 0, -1000, 0);
  for (const r of ranges) {
    let [lo, hi, floor] = [Infinity, -Infinity, Infinity];
    for (let i = r.first; i < r.first + r.count; i++) {
      lo = Math.min(lo, pos.getY(i));
      hi = Math.max(hi, pos.getY(i));
      floor = Math.min(floor, groundAt(i));
    }
    if (imaginedRejected(r, floor)) {
      for (let i = r.first; i < r.first + r.count; i++) pos.setXYZ(i, 0, -1000, 0);
      continue;
    }
    if (hi - lo > 1.5) {
      // Sink a little so the downhill side has no visible gap under it.
      for (let i = r.first; i < r.first + r.count; i++) pos.setY(i, pos.getY(i) + floor - 0.3);
    } else {
      for (let i = r.first; i < r.first + r.count; i++)
        pos.setY(i, pos.getY(i) + groundAt(i) + 0.15);
    }
  }
}

/**
 * An imagined tree (`gen:` id) must not stand on this ground: below the beach
 * line or above the timber line, the same site rules the display forest plants
 * by. Observed trees are never gated — an OSM tree at sea level is someone's
 * observation, and observations win over the site model.
 */
function imaginedRejected(range: { id: string }, groundM: number): boolean {
  return range.id.startsWith('gen:') && (groundM < MIN_GROUND || groundM > MAX_GROUND);
}

/**
 * A point on a Feature's roof: the centroid of its highest triangle (largest on ties).
 * Unlike the centre of the bounding box, it is always on the building, even for
 * L-shaped or courtyard footprints, so a beacon sits on it and a tap below hits it.
 */
function roofSpot(
  geometry: BufferGeometry,
  r: { first: number; count: number },
): { x: number; z: number; top: number } | null {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const n = index ? index.count : pos.count;
  const v = (k: number) => (index ? index.getX(k) : k);
  let best: { y: number; area: number; x: number; z: number } | null = null;
  for (let k = 0; k + 2 < n; k += 3) {
    const [a, b, c] = [v(k), v(k + 1), v(k + 2)];
    if ([a, b, c].some((i) => i < r.first || i >= r.first + r.count)) continue;
    const y = Math.min(pos.getY(a), pos.getY(b), pos.getY(c));
    const [ux, uz] = [pos.getX(b) - pos.getX(a), pos.getZ(b) - pos.getZ(a)];
    const [wx, wz] = [pos.getX(c) - pos.getX(a), pos.getZ(c) - pos.getZ(a)];
    const area = Math.abs(ux * wz - uz * wx) / 2; // footprint area: walls have ~0
    if (area < 0.5) continue;
    if (!best || y > best.y + 0.01 || (Math.abs(y - best.y) <= 0.01 && area > best.area)) {
      best = {
        y,
        area,
        x: (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
        z: (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3,
      };
    }
  }
  if (!best) return null;
  let top = 0;
  for (let i = r.first; i < r.first + r.count; i++) top = Math.max(top, pos.getY(i));
  return { x: best.x, z: best.z, top };
}

/**
 * Discs where nothing grows: one around each building's footprint (half its diagonal
 * plus a yard), and a string of them along each road. Discs are bigger than a building
 * needs, which reads as gardens and verges rather than spruce through the roof.
 */
function clearingsFor(
  group: Group,
  ranges: { id: string; first: number; count: number }[],
): Disc[] {
  const mesh = group.children.find((o) => (o as Mesh).isMesh) as Mesh | undefined;
  const pos = mesh?.geometry.getAttribute('position');
  if (!pos) return [];
  const { x: ox, z: oz } = group.position;
  const out: Disc[] = [];
  for (const f of ranges) {
    if (/:n\d+-n\d+$/.test(f.id)) {
      // A road segment: every vertex pair spans its width; a disc each 2nd vertex.
      for (let i = f.first; i < f.first + f.count; i += 2)
        out.push({ x: ox + pos.getX(i), z: oz + pos.getZ(i), r: 7 });
      continue;
    }
    let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = f.first; i < f.first + f.count; i++) {
      x0 = Math.min(x0, pos.getX(i));
      x1 = Math.max(x1, pos.getX(i));
      z0 = Math.min(z0, pos.getZ(i));
      z1 = Math.max(z1, pos.getZ(i));
    }
    out.push({
      x: ox + (x0 + x1) / 2,
      z: oz + (z0 + z1) / 2,
      r: Math.hypot(x1 - x0, z1 - z0) / 2 + 6,
    });
  }
  return out;
}

/**
 * `_lift`: each vertex's height above the base of its own Feature, for contact shading
 * (walls darken toward the ground, so buildings sit on it instead of floating). Only
 * Features with height get it; flat ones (roads, the ground) are given a large lift so
 * they are never darkened. Display-only: the Bundle's bytes are untouched.
 */
function liftAttribute(geometry: BufferGeometry, userData: Record<string, unknown>) {
  const extras = (userData as { otherhere?: { features?: { first: number; count: number }[] } })
    .otherhere;
  const pos = geometry.getAttribute('position');
  const lift = new Float32Array(pos.count).fill(100);
  for (const f of extras?.features ?? []) {
    let [lo, hi] = [Infinity, -Infinity];
    for (let i = f.first; i < f.first + f.count; i++) {
      lo = Math.min(lo, pos.getY(i));
      hi = Math.max(hi, pos.getY(i));
    }
    if (hi - lo <= 1.5) continue;
    for (let i = f.first; i < f.first + f.count; i++) lift[i] = pos.getY(i) - lo;
  }
  geometry.setAttribute('_lift', new BufferAttribute(lift, 1));
}

/** Vertices belonging to road segments (IDs like `osm:w1:n2-n3`), from the Bundle's feature ranges. */
function roadVertices(geometry: BufferGeometry, userData: Record<string, unknown>) {
  const extras = (
    userData as { otherhere?: { features?: { id: string; first: number; count: number }[] } }
  ).otherhere;
  const pos = geometry.getAttribute('position');
  const out: { x: number; z: number }[] = [];
  for (const f of extras?.features ?? []) {
    if (!/:n\d+-n\d+$/.test(f.id)) continue;
    for (let i = f.first; i < f.first + f.count; i += 2)
      out.push({ x: pos.getX(i), z: pos.getZ(i) });
  }
  return out;
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await (await fetchOk(url)).json()) as T;
}
