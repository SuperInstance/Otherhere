import {
  BoxGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  TextureLoader,
  type Scene,
  type Texture,
} from 'three/webgpu';
import { sha256Hex, type AssetExtras } from '@otherhere/core';

/**
 * Captured assets in the world: the display side of the `asset.capture`
 * design. A Bundle whose extras carry an asset has NO procedural geometry
 * for that Feature (core suppressed it at build time); this layer fetches
 * the payload the extras name, verifies it against the sha256 the Bundle
 * carries — the same discipline as the Bundle's own output hash — and
 * stands it where the extras place it. Nothing here reaches Bundle bytes.
 *
 * Tier ladder (budgets are the design's law, enforced here at fetch time):
 * the full profile shows the true 3D capture (`splat`) near and the large
 * photograph (`impostor`) far; the lite profile never fetches the splat —
 * the small photograph (`card`) is its tier at every distance.
 */

export type AssetHost = {
  /** Directory the place files (and their `assets/` payloads) are served from, trailing slash. */
  placesBase: string;
  /**
   * Where the tier payloads are fetched from, trailing slash. Defaults to
   * `placesBase` — but the payloads do not have to live beside the place files:
   * the Thor hosts them, and the renderer may fetch them from there while the
   * place file itself stays on the game server.
   */
  assetBase?: string;
  lite: boolean;
};

export type TierName = 'splat' | 'impostor' | 'card';
type TierRef = { path: string; hash: string; bytes: number };

/** One capture placed in the world frame, parsed from a Bundle's extras. */
export type PlacedAsset = {
  featureId: string;
  family: string;
  tiers: Partial<Record<TierName, TierRef>>;
  /** The asset's own origin in the world frame (the splat's placement point). */
  world: { x: number; z: number };
  /** Placement exactly as the extras carry it, in the Cell's local frame. */
  local: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: number;
  };
  heightM: number;
  frontAzimuthDeg: number;
  cardQuad?: { widthM: number; heightM: number; centreYM: number };
  /** Footprint ring in the world frame's (e, n) axes (n = -z). */
  ring: { e: number; n: number }[];
  /** Ring centroid in the world frame (x = e, z = -n): the impostor's post. */
  centre: { x: number; z: number };
  /** Where nothing may grow, the clearings' own shape. */
  clearing: { x: number; z: number; r: number; built: true };
};

/** Full profile: the splat inside this distance, photographs beyond it. */
export const SPLAT_NEAR_M = 140;

/**
 * Parse a Bundle's `assets` extras into world-frame placements. `c` is the
 * Cell centre in the world frame's (e, n) axes. Pure, and unit-tested —
 * the `zonesFor` pattern (ADR-0017) carried to captures.
 */
export function assetsFor(
  assets: AssetExtras[] | undefined,
  c: { e: number; n: number },
): PlacedAsset[] {
  const out: PlacedAsset[] = [];
  for (const a of assets ?? []) {
    if (!Array.isArray(a.ring) || a.ring.length < 6 || a.ring.length % 2 !== 0) continue;
    const ring: { e: number; n: number }[] = [];
    let minE = Infinity,
      maxE = -Infinity,
      minN = Infinity,
      maxN = -Infinity,
      sumE = 0,
      sumN = 0;
    for (let i = 0; i < a.ring.length; i += 2) {
      const e = c.e + a.ring[i]!;
      const n = c.n + a.ring[i + 1]!;
      ring.push({ e, n });
      sumE += e;
      sumN += n;
      minE = Math.min(minE, e);
      maxE = Math.max(maxE, e);
      minN = Math.min(minN, n);
      maxN = Math.max(maxN, n);
    }
    const centre = { x: sumE / ring.length, z: -(sumN / ring.length) };
    out.push({
      featureId: a.id,
      family: a.family,
      tiers: a.tiers,
      world: { x: c.e + a.position[0], z: -c.n + a.position[2] },
      local: { position: a.position, quaternion: a.quaternion, scale: a.scale },
      heightM: a.heightM,
      frontAzimuthDeg: a.frontAzimuthDeg,
      cardQuad: a.cardQuad,
      ring,
      centre,
      clearing: {
        x: centre.x,
        z: centre.z,
        r: Math.hypot(maxE - minE, maxN - minN) / 2 + 6,
        built: true,
      },
    });
  }
  return out;
}

/**
 * The tier a profile shows at a distance. Pure. A missing preferred tier
 * falls to the next one down; a lone splat shows at any distance rather
 * than leaving the lot empty.
 */
export function chooseTier(
  lite: boolean,
  distanceM: number,
  tiers: Partial<Record<TierName, TierRef>>,
): TierName | null {
  if (lite) return tiers.card ? 'card' : tiers.impostor ? 'impostor' : null;
  if (distanceM < SPLAT_NEAR_M && tiers.splat) return 'splat';
  return tiers.impostor ? 'impostor' : tiers.card ? 'card' : tiers.splat ? 'splat' : null;
}

type GroundLike = { readonly active: boolean; heightAt(x: number, z: number): number };

type Entry = {
  cell: string;
  placed: PlacedAsset;
  /** At the Cell group's world position; children carry the local placement. */
  group: Group;
  shown?: TierName;
  loading?: TierName;
  objects: Partial<Record<TierName, Group>>;
  proxy: Mesh;
  failed: Set<TierName>;
};

/**
 * Owns every placed capture's objects: fetch + hash-verify + build on first
 * need, LOD swap and billboarding per frame, ground standing with the
 * Bundles, disposal with the Cell. The World drives it.
 */
export class AssetLayer {
  readonly root = new Group();
  private entries = new Map<string, Entry>();
  private textureLoader = new TextureLoader();

  constructor(
    scene: Scene,
    private host: AssetHost,
    private ground?: GroundLike,
  ) {
    this.root.name = 'assets';
    scene.add(this.root);
  }

  private key(cell: string, featureId: string) {
    return `${cell}/${featureId}`;
  }

  /** The ground a placed asset stands on: lowest terrain under its ring, sunk a step. */
  private baseY(p: PlacedAsset): number {
    if (!this.ground?.active) return 0;
    let lo = Infinity;
    for (const pt of p.ring) lo = Math.min(lo, this.ground.heightAt(pt.e, -pt.n));
    return Number.isFinite(lo) ? lo - 0.3 : 0;
  }

  /** Register a Cell's captures (replacing any it had: a reload's new word wins). */
  attach(cell: string, placed: PlacedAsset[], anchor: { x: number; z: number }): void {
    this.detach(cell);
    for (const p of placed) {
      const group = new Group();
      group.name = p.featureId;
      group.position.set(anchor.x, this.baseY(p), anchor.z);
      // The pick proxy: the footprint's box, tall as the asset. It renders
      // nothing (colour and depth writes off) but raycasts like a building.
      const xs = p.ring.map((r) => r.e);
      const ns = p.ring.map((r) => r.n);
      const w = Math.max(...xs) - Math.min(...xs);
      const d = Math.max(...ns) - Math.min(...ns);
      const proxy = new Mesh(
        new BoxGeometry(Math.max(w, 1), p.heightM, Math.max(d, 1)),
        new MeshBasicNodeMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      (proxy.material as MeshBasicNodeMaterial).colorWrite = false;
      proxy.position.set(p.centre.x - anchor.x, p.heightM / 2, p.centre.z - anchor.z);
      proxy.userData.assetKey = this.key(cell, p.featureId);
      group.add(proxy);
      this.root.add(group);
      this.entries.set(this.key(cell, p.featureId), {
        cell,
        placed: p,
        group,
        objects: {},
        proxy,
        failed: new Set(),
      });
    }
  }

  /** Remove a Cell's captures and give their memory back. */
  detach(cell: string): void {
    for (const [k, e] of this.entries) {
      if (e.cell !== cell) continue;
      this.root.remove(e.group);
      e.group.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const m = mesh.material as MeshBasicNodeMaterial & { map?: Texture };
        if (m?.map) m.map.dispose();
        m?.dispose?.();
      });
      this.entries.delete(k);
    }
  }

  /** Re-stand a Cell's captures after finer ground arrives (World.standAgain's hook). */
  restand(cell: string): void {
    for (const e of this.entries.values())
      if (e.cell === cell) e.group.position.y = this.baseY(e.placed);
  }

  /** Per frame: pick each capture's tier for the walker's distance, billboard the photographs. */
  update(focusX: number, focusZ: number): void {
    for (const e of this.entries.values()) {
      const p = e.placed;
      const d = Math.hypot(p.centre.x - focusX, p.centre.z - focusZ);
      const want = chooseTier(this.host.lite, d, p.tiers);
      if (want && want !== e.shown && !e.failed.has(want)) void this.show(e, want);
      const shownObj = e.shown ? e.objects[e.shown] : undefined;
      const billboard = shownObj?.userData.billboard as Mesh | undefined;
      if (billboard) {
        // A photograph stands on its post and turns to face the walker.
        billboard.rotation.y = Math.atan2(focusX - p.centre.x, focusZ - p.centre.z);
      }
    }
  }

  /** The capture under a ray, if any: picks answer through the proxy boxes. */
  pick(raycaster: Raycaster): { cell: string; featureId: string; distance: number } | null {
    const proxies = [...this.entries.values()].map((e) => e.proxy);
    if (!proxies.length) return null;
    const hits = raycaster.intersectObjects(proxies, false);
    const hit = hits[0];
    if (!hit) return null;
    const key = hit.object.userData.assetKey as string;
    const e = this.entries.get(key);
    return e ? { cell: e.cell, featureId: e.placed.featureId, distance: hit.distance } : null;
  }

  private async show(e: Entry, tier: TierName): Promise<void> {
    if (e.loading === tier || e.objects[tier]) {
      this.swap(e, tier);
      return;
    }
    e.loading = tier;
    try {
      const obj = tier === 'splat' ? await this.buildSplat(e) : await this.buildCard(e, tier);
      if (!this.entries.has(this.key(e.cell, e.placed.featureId))) {
        obj.traverse((o) => (o as Mesh).geometry?.dispose());
        return; // detached while loading
      }
      e.objects[tier] = obj;
      e.group.add(obj);
      this.swap(e, tier);
    } catch (err) {
      // A capture that cannot load or fails its hash must never take the
      // page down with it: the lot stands empty and the failure is named.
      console.error(`asset ${e.placed.family} tier ${tier}`, err);
      e.failed.add(tier);
    } finally {
      if (e.loading === tier) e.loading = undefined;
    }
  }

  private swap(e: Entry, tier: TierName): void {
    for (const [t, obj] of Object.entries(e.objects)) obj.visible = t === tier;
    e.shown = tier;
  }

  /** Fetch a tier's bytes and hold them to the hash the Bundle carries. */
  private async verifiedBytes(tier: TierRef): Promise<Uint8Array> {
    const res = await fetch(`${this.host.assetBase ?? this.host.placesBase}${tier.path}`);
    if (!res.ok) throw new Error(`${tier.path}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength !== tier.bytes)
      throw new Error(`${tier.path}: ${bytes.byteLength} bytes, the Bundle says ${tier.bytes}`);
    const hash = await sha256Hex(bytes);
    if (hash !== tier.hash) throw new Error(`${tier.path}: hash mismatch`);
    return bytes;
  }

  private async buildSplat(e: Entry): Promise<Group> {
    const tier = e.placed.tiers.splat!;
    const bytes = await this.verifiedBytes(tier);
    const [{ SPZLoader }, { GaussianSplat }] = await Promise.all([
      import('three/addons/loaders/SPZLoader.js'),
      import('three/addons/objects/GaussianSplat.js'),
    ]);
    const geometry = await new Promise<import('three/webgpu').BufferGeometry>((resolve, reject) => {
      new SPZLoader().parse(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        resolve,
        reject,
      );
    });
    const mesh = new GaussianSplat(geometry);
    const [px, py, pz] = e.placed.local.position;
    mesh.position.set(px, py, pz);
    const [qx, qy, qz, qw] = e.placed.local.quaternion;
    mesh.quaternion.copy(new Quaternion(qx, qy, qz, qw));
    mesh.scale.setScalar(e.placed.local.scale);
    const out = new Group();
    out.add(mesh);
    return out;
  }

  private async buildCard(e: Entry, tier: TierName): Promise<Group> {
    const ref = e.placed.tiers[tier]!;
    const bytes = await this.verifiedBytes(ref);
    const url = URL.createObjectURL(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/webp' }),
    );
    try {
      const tex = await this.textureLoader.loadAsync(url);
      tex.colorSpace = SRGBColorSpace;
      const p = e.placed;
      const quad = p.cardQuad ?? { widthM: p.heightM, heightM: p.heightM, centreYM: p.heightM / 2 };
      const mesh = new Mesh(
        new PlaneGeometry(quad.widthM, quad.heightM),
        new MeshBasicNodeMaterial({
          map: tex,
          transparent: true,
          alphaTest: 0.04,
          side: DoubleSide,
        }),
      );
      mesh.position.set(
        p.centre.x - e.group.position.x,
        quad.centreYM,
        p.centre.z - e.group.position.z,
      );
      const out = new Group();
      out.add(mesh);
      out.userData.billboard = mesh;
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
