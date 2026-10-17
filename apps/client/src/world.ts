import { Group, Mesh, type BufferGeometry, type Scene } from 'three/webgpu';
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
  sha256Hex,
  type BundleFeature,
  type BundleManifest,
  type LocalFrame,
} from '@otherhere/core';
import { confidenceMaterial } from './material';

type CellState = {
  state: 'loading' | 'ready' | 'error';
  /** 'ok' = built from OSM; 'failed' = OSM unreachable, showing the sketch. */
  ingest?: 'ok' | 'failed';
  manifest?: BundleManifest;
  verified?: boolean;
  group?: Group;
  roadPoints?: { x: number; z: number }[];
};

export type WorldStats = {
  ready: number;
  loading: number;
  sketch: number;
  errors: number;
  features: number;
  verified: number;
  mismatched: number;
};

/** Where Bundles come from: the edge API, the built-in demo lot, or a postcard's Fact snapshot. */
type Source = 'api' | 'demo' | { capsule: Map<string, BundleFeature[]> };

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
  onChange: () => void = () => {};

  constructor(
    scene: Scene,
    readonly originCell: string,
    private source: Source = 'api',
  ) {
    this.frame = localFrame(cellCenter(originCell));
    scene.add(this.root);
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
        if (s.group) {
          this.root.remove(s.group);
          s.group.traverse((o) => (o as Mesh).geometry?.dispose());
        }
        this.cells.delete(c);
        this.onChange();
      }
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
    let ingest: 'ok' | 'failed' = 'ok';
    if (this.source === 'demo' || typeof this.source === 'object') {
      // Built in the browser: the same interpreter, the same bytes (invariant 2).
      const features =
        this.source === 'demo' ? demoLot(cell) : (this.source.capsule.get(cell) ?? []);
      const built = await buildBundle({ cell, features });
      manifest = built.manifest;
      bytes = built.glb;
    } else {
      const info = await fetchJson<{ manifest: BundleManifest; status: 'ok' | 'failed' }>(
        `/api/cells/${cell}`,
      );
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
    Object.assign(state, { state: 'ready', manifest, verified, group, ingest, roadPoints });
    this.root.add(group);
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
    };
    for (const c of this.cells.values()) {
      if (c.state === 'loading') s.loading++;
      else if (c.state === 'error') s.errors++;
      else {
        s.ready++;
        s.features += c.manifest?.featureCount ?? 0;
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
