import earcut from 'earcut';
import { SRGB_TO_LINEAR_U16 } from './srgb';

/** A point in the Bundle's local frame: x = east, y = up, z = south (three.js convention). */
export type V3 = [number, number, number];

/** Confidence pair carried per vertex: [shape, colour]. */
export type Conf = [number, number];

export type MeshData = {
  positions: Float32Array;
  normals: Float32Array;
  colours: Uint16Array; // linear RGBA, normalised; A = 65535
  confidence: Float32Array; // VEC2 (shape, colour)
  indices: Uint32Array;
};

// Quantizers (ADR-0006). `+ 0` folds -0 into 0 so equal values have equal bytes.
const q = (v: number) => Math.round(v * 1000) / 1000 + 0; // millimetres
const qc = (v: number) => Math.round(v * 1000) / 1000 + 0;
const qn = (v: number) => Math.round(v * 32767) / 32767 + 0;

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 0, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function normalOf(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return len < 1e-12 ? [0, 1, 0] : [nx / len, ny / len, nz / len];
}

/** Accumulates flat-shaded faces; every face gets its own vertices. */
export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private conf: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * Add a planar convex-or-concave polygon. If `outward` is given, the winding
   * is flipped as needed so the face normal points along it.
   */
  polygon(pts: V3[], colour: string, conf: Conf, outward?: V3): void {
    if (pts.length < 3) return;
    let n = newellNormal(pts);
    if (outward && n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
      pts = [...pts].reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const tris = triangulate(pts, n);
    if (tris.length === 0) return;
    const base = this.vertexCount;
    const [r, g, b] = hexToRgb(colour);
    for (const p of pts) {
      this.pos.push(q(p[0]), q(p[1]), q(p[2]));
      this.nor.push(qn(n[0]), qn(n[1]), qn(n[2]));
      this.col.push(SRGB_TO_LINEAR_U16[r]!, SRGB_TO_LINEAR_U16[g]!, SRGB_TO_LINEAR_U16[b]!, 65535);
      this.conf.push(qc(conf[0]), qc(conf[1]));
    }
    for (const i of tris) this.idx.push(base + i);
  }

  quad(a: V3, b: V3, c: V3, d: V3, colour: string, conf: Conf, outward?: V3): void {
    this.polygon([a, b, c, d], colour, conf, outward);
  }

  tri(a: V3, b: V3, c: V3, colour: string, conf: Conf, outward?: V3): void {
    this.polygon([a, b, c], colour, conf, outward);
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nor),
      colours: new Uint16Array(this.col),
      confidence: new Float32Array(this.conf),
      indices: new Uint32Array(this.idx),
    };
  }
}

/** Newell's method: robust normal for any planar polygon. */
function newellNormal(pts: V3[]): V3 {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-12) return normalOf(pts[0]!, pts[1]!, pts[2]!);
  return [nx / len, ny / len, nz / len];
}

/** Triangulate by projecting onto the dominant plane, keeping CCW winding about `n`. */
function triangulate(pts: V3[], n: V3): number[] {
  if (pts.length === 3) return [0, 1, 2];
  const ax = Math.abs(n[0]),
    ay = Math.abs(n[1]),
    az = Math.abs(n[2]);
  // Drop the dominant axis; choose the remaining pair so projection keeps orientation.
  let i0: 0 | 1 | 2, i1: 0 | 1 | 2;
  if (ax >= ay && ax >= az) [i0, i1] = n[0] > 0 ? [1, 2] : [2, 1];
  else if (ay >= az) [i0, i1] = n[1] > 0 ? [2, 0] : [0, 2];
  else [i0, i1] = n[2] > 0 ? [0, 1] : [1, 0];
  const flat: number[] = [];
  for (const p of pts) flat.push(p[i0], p[i1]);
  return earcut(flat);
}
