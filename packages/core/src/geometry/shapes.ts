import { detCos, detSin } from '../math/det';
import type { RoofShape } from '../schema/fact';
import { MeshBuilder, type Conf, type V3 } from './mesh';
import { minAreaRect, signedArea, type P2 } from './polygon';

const to3 = (p: P2, y: number): V3 => [p.e, y, -p.n];
const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];

/** Outward normal of edge a→b on a CCW ring, in 3D. */
function outwardOf(a: P2, b: P2): V3 {
  return [b.n - a.n, 0, b.e - a.e];
}

function len(a: P2, b: P2): number {
  return Math.sqrt((b.e - a.e) * (b.e - a.e) + (b.n - a.n) * (b.n - a.n));
}

export function extrude(
  m: MeshBuilder,
  ring: P2[],
  base: number,
  top: number,
  colour: string,
  conf: Conf,
): void {
  if (top <= base) return;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    m.quad(to3(a, base), to3(b, base), to3(b, top), to3(a, top), colour, conf, outwardOf(a, b));
  }
}

/** How well a footprint fills its oriented bounding rectangle (1 = a rectangle). */
export function rectangularity(ring: P2[]): number {
  const r = minAreaRect(ring);
  return r.area > 0 ? Math.abs(signedArea(ring)) / r.area : 0;
}

/** Pitched roofs need a roughly rectangular footprint; others get a flat roof. */
export const PITCHED_MIN_RECTANGULARITY = 0.8;

export function roof(
  m: MeshBuilder,
  ring: P2[],
  shape: RoofShape,
  base: number,
  rise: number,
  colour: string,
  wallColour: string,
  conf: Conf,
): RoofShape {
  if (shape === 'flat' || rise <= 0 || rectangularity(ring) < PITCHED_MIN_RECTANGULARITY) {
    m.polygon(
      ring.map((p) => to3(p, base)),
      colour,
      conf,
      UP,
    );
    return 'flat';
  }
  const { c, u, v, halfL, halfW } = minAreaRect(ring);
  const at = (su: number, sv: number): P2 => ({
    e: c.e + su * u.e + sv * v.e,
    n: c.n + su * u.n + sv * v.n,
  });
  const corner = (su: -1 | 1, sv: -1 | 1, y = base) => to3(at(su * halfL, sv * halfW), y);
  const outU: V3 = [u.e, 0, -u.n];
  const outV: V3 = [v.e, 0, -v.n];
  const neg = (x: V3): V3 => [-x[0], -x[1], -x[2]];
  const top = base + rise;
  // The underside closes the box so roofs read as solid from below.
  m.polygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], wallColour, conf, DOWN);

  if (shape === 'gable') {
    const r0 = to3(at(-halfL, 0), top);
    const r1 = to3(at(halfL, 0), top);
    m.quad(corner(-1, -1), corner(1, -1), r1, r0, colour, conf, [outV[0] * -1, 1, outV[2] * -1]);
    m.quad(corner(1, 1), corner(-1, 1), r0, r1, colour, conf, [outV[0], 1, outV[2]]);
    m.tri(corner(-1, 1), corner(-1, -1), r0, wallColour, conf, neg(outU));
    m.tri(corner(1, -1), corner(1, 1), r1, wallColour, conf, outU);
  } else if (shape === 'hip') {
    const ridge = Math.max(0, halfL - halfW);
    const r0 = to3(at(-ridge, 0), top);
    const r1 = to3(at(ridge, 0), top);
    m.quad(corner(-1, -1), corner(1, -1), r1, r0, colour, conf, [-outV[0], 1, -outV[2]]);
    m.quad(corner(1, 1), corner(-1, 1), r0, r1, colour, conf, [outV[0], 1, outV[2]]);
    m.tri(corner(-1, 1), corner(-1, -1), r0, colour, conf, [-outU[0], 1, -outU[2]]);
    m.tri(corner(1, -1), corner(1, 1), r1, colour, conf, [outU[0], 1, outU[2]]);
  } else {
    // shed: low along -v, high along +v.
    const h = (su: -1 | 1) => to3(at(su * halfL, halfW), top);
    m.quad(corner(-1, -1), corner(1, -1), h(1), h(-1), colour, conf, [-outV[0], 1, -outV[2]]);
    m.quad(corner(1, 1), corner(-1, 1), h(-1), h(1), wallColour, conf, outV);
    m.tri(corner(-1, 1), corner(-1, -1), h(-1), wallColour, conf, neg(outU));
    m.tri(corner(1, -1), corner(1, 1), h(1), wallColour, conf, outU);
  }
  return shape;
}

export type WindowSpec = {
  base: number;
  top: number;
  floorHeight: number;
  width: number;
  height: number;
  sill: number;
  spacing: number;
};

export const MAX_WINDOWS_PER_FEATURE = 2000;

export function windows(
  m: MeshBuilder,
  ring: P2[],
  w: WindowSpec,
  colour: string,
  conf: Conf,
): number {
  if (w.floorHeight <= 0 || w.spacing <= 0 || w.width <= 0 || w.height <= 0) return 0;
  const OFFSET = 0.03; // panes sit just proud of the wall
  let count = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const L = len(a, b);
    const n = Math.floor(L / w.spacing);
    if (n < 1 || w.width >= L) continue;
    const d = { e: (b.e - a.e) / L, n: (b.n - a.n) / L };
    const out = { e: d.n * OFFSET, n: -d.e * OFFSET };
    const outward = outwardOf(a, b);
    for (let y = w.base + w.sill; y + w.height <= w.top - 0.2; y += w.floorHeight) {
      for (let k = 0; k < n; k++) {
        if (count >= MAX_WINDOWS_PER_FEATURE) return count;
        const t = ((k + 0.5) / n) * L;
        const p0 = {
          e: a.e + d.e * (t - w.width / 2) + out.e,
          n: a.n + d.n * (t - w.width / 2) + out.n,
        };
        const p1 = {
          e: a.e + d.e * (t + w.width / 2) + out.e,
          n: a.n + d.n * (t + w.width / 2) + out.n,
        };
        m.quad(
          to3(p0, y),
          to3(p1, y),
          to3(p1, y + w.height),
          to3(p0, y + w.height),
          colour,
          conf,
          outward,
        );
        count++;
      }
    }
  }
  return count;
}

export function ribbon(
  m: MeshBuilder,
  path: P2[],
  width: number,
  y: number,
  colour: string,
  conf: Conf,
): void {
  const hw = width / 2;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const L = len(a, b);
    if (L < 1e-6) continue;
    // Extend each segment by half a width so consecutive segments overlap at joints.
    const d = { e: (b.e - a.e) / L, n: (b.n - a.n) / L };
    const p = { e: -d.n * hw, n: d.e * hw };
    const a2 = { e: a.e - d.e * hw, n: a.n - d.n * hw };
    const b2 = { e: b.e + d.e * hw, n: b.n + d.n * hw };
    m.quad(
      to3({ e: a2.e - p.e, n: a2.n - p.n }, y),
      to3({ e: b2.e - p.e, n: b2.n - p.n }, y),
      to3({ e: b2.e + p.e, n: b2.n + p.n }, y),
      to3({ e: a2.e + p.e, n: a2.n + p.n }, y),
      colour,
      conf,
      UP,
    );
  }
}

/** Rotate a local offset by `yaw` radians about up (deterministic trig). */
function place(origin: P2, yaw: number, e: number, n: number): P2 {
  const c = detCos(yaw);
  const s = detSin(yaw);
  return { e: origin.e + e * c - n * s, n: origin.n + e * s + n * c };
}

export function box(
  m: MeshBuilder,
  origin: P2,
  yaw: number,
  at: V3,
  size: V3,
  colour: string,
  conf: Conf,
): void {
  const [ox, oy, on] = at; // east, up, north offsets
  const [w, d, h] = size;
  const pts = [
    place(origin, yaw, ox - w / 2, on - d / 2),
    place(origin, yaw, ox + w / 2, on - d / 2),
    place(origin, yaw, ox + w / 2, on + d / 2),
    place(origin, yaw, ox - w / 2, on + d / 2),
  ];
  extrude(m, pts, oy, oy + h, colour, conf);
  m.polygon(
    pts.map((p) => to3(p, oy + h)),
    colour,
    conf,
    UP,
  );
  m.polygon(
    pts.map((p) => to3(p, oy)),
    colour,
    conf,
    DOWN,
  );
}

export function cylinder(
  m: MeshBuilder,
  origin: P2,
  at: V3,
  radius: number,
  topRadius: number,
  height: number,
  segments: number,
  colour: string,
  conf: Conf,
): void {
  const c = { e: origin.e + at[0], n: origin.n + at[2] };
  const y0 = at[1];
  const y1 = at[1] + height;
  const ring = (r: number) =>
    Array.from({ length: segments }, (_, i) => {
      const t = (i / segments) * 6.283185307179586;
      return { e: c.e + r * detCos(t), n: c.n + r * detSin(t) };
    });
  const lo = ring(radius);
  const hi = ring(topRadius);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const out = outwardOf(lo[i]!, lo[j]!);
    if (topRadius > 1e-6)
      m.quad(to3(lo[i]!, y0), to3(lo[j]!, y0), to3(hi[j]!, y1), to3(hi[i]!, y1), colour, conf, out);
    else m.tri(to3(lo[i]!, y0), to3(lo[j]!, y0), to3(c, y1), colour, conf, [out[0], 0.5, out[2]]);
  }
  if (topRadius > 1e-6)
    m.polygon(
      hi.map((p) => to3(p, y1)),
      colour,
      conf,
      UP,
    );
}

/** A low-poly sphere: a subdivided octahedron, optionally squashed vertically. */
export function blob(
  m: MeshBuilder,
  origin: P2,
  at: V3,
  radius: number,
  squash: number,
  detail: number,
  colour: string,
  conf: Conf,
): void {
  const centre: V3 = [origin.e + at[0], at[1], -(origin.n + at[2])];
  let tris: [V3, V3, V3][] = [];
  const X: V3 = [1, 0, 0],
    NX: V3 = [-1, 0, 0],
    Y: V3 = [0, 1, 0],
    NY: V3 = [0, -1, 0],
    Z: V3 = [0, 0, 1],
    NZ: V3 = [0, 0, -1];
  for (const [a, b] of [
    [X, Z],
    [Z, NX],
    [NX, NZ],
    [NZ, X],
  ] as const) {
    tris.push([a, b, Y], [b, a, NY]);
  }
  const norm = (v: V3): V3 => {
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const mid = (a: V3, b: V3): V3 => norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  for (let d = 0; d < detail; d++) {
    tris = tris.flatMap(([a, b, c]) => {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      return [
        [a, ab, ca],
        [ab, b, bc],
        [ca, bc, c],
        [ab, bc, ca],
      ] as [V3, V3, V3][];
    });
  }
  const tx = (v: V3): V3 => [
    centre[0] + v[0] * radius,
    centre[1] + v[1] * radius * squash,
    centre[2] + v[2] * radius,
  ];
  for (const [a, b, c] of tris) {
    const o = norm([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]);
    m.tri(tx(a), tx(b), tx(c), colour, conf, o);
  }
}
