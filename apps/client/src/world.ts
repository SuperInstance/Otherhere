import {
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
  roadPoints?: { x: number; z: number }[];
  /** Vertex ranges per Feature, from the Bundle's extras: what the walker can pick. */
  ranges?: { id: string; first: number; count: number }[];
  /** Buildings worth photographing here, each marked by a beacon. */
  quests?: Quest[];
  beacons?: Group;
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

  constructor(
    scene: Scene,
    readonly originCell: string,
    private source: Source = 'api',
  ) {
    this.frame = localFrame(cellCenter(originCell));
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

  private drop(s: CellState) {
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
    });
    const c = this.frame.project(cellCenter(cell));
    group.position.set(c.e, 0, -c.n);
    for (const p of roadPoints) {
      p.x += c.e;
      p.z -= c.n;
    }

    const state = this.cells.get(cell);
    if (!state) return; // evicted while loading
    const ranges =
      (
        gltf.userData as {
          otherhere?: { features?: { id: string; first: number; count: number }[] };
        }
      ).otherhere?.features ?? [];
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
    });
    this.root.add(group);
    this.beaconRoot.add(beacons);
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
      let [minX, maxX, minZ, maxZ, top] = [Infinity, -Infinity, Infinity, -Infinity, 0];
      for (let i = r.first; i < r.first + r.count; i++) {
        minX = Math.min(minX, pos.getX(i));
        maxX = Math.max(maxX, pos.getX(i));
        minZ = Math.min(minZ, pos.getZ(i));
        maxZ = Math.max(maxZ, pos.getZ(i));
        top = Math.max(top, pos.getY(i));
      }
      const [x, z] = [(minX + maxX) / 2, (minZ + maxZ) / 2];
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
      ray.set(new Vector3(x, 1.6, z), new Vector3(dx, 0, dz).normalize());
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
    if (s) this.drop(s);
    this.cells.delete(cell);
    this.want(cell);
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
