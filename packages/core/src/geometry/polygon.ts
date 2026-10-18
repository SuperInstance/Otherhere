// 2D polygon helpers in a local east/north frame. Deterministic (ADR-0006).

export type P2 = { e: number; n: number };

export function signedArea(pts: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.e * q.n - q.e * p.n;
  }
  return a / 2;
}

/**
 * Normalise a ring: snap to millimetres, drop a closing duplicate and
 * consecutive duplicates, and make it counter-clockwise.
 */
export function cleanRing(pts: readonly P2[]): P2[] {
  const snapped = pts.map((p) => ({
    e: Math.round(p.e * 1000) / 1000,
    n: Math.round(p.n * 1000) / 1000,
  }));
  const out: P2[] = [];
  for (const p of snapped) {
    const last = out[out.length - 1];
    if (!last || last.e !== p.e || last.n !== p.n) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first.e === last.e && first.n === last.n) out.pop();
  return signedArea(out) < 0 ? out.reverse() : out;
}

export function centroid(pts: readonly P2[]): P2 {
  // Area-weighted centroid; falls back to the vertex mean for degenerate rings.
  let a = 0;
  let ce = 0;
  let cn = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const cross = p.e * q.n - q.e * p.n;
    a += cross;
    ce += (p.e + q.e) * cross;
    cn += (p.n + q.n) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const m = pts.reduce((s, p) => ({ e: s.e + p.e, n: s.n + p.n }), { e: 0, n: 0 });
    return { e: m.e / pts.length, n: m.n / pts.length };
  }
  return { e: ce / (3 * a), n: cn / (3 * a) };
}

/** Andrew's monotone chain; returns a CCW hull. */
export function convexHull(pts: readonly P2[]): P2[] {
  const s = [...pts].sort((a, b) => a.e - b.e || a.n - b.n);
  if (s.length < 3) return s;
  const cross = (o: P2, a: P2, b: P2) => (a.e - o.e) * (b.n - o.n) - (a.n - o.n) * (b.e - o.e);
  const lower: P2[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** An oriented bounding rectangle: centre, unit long axis `u`, unit short axis `v`, half-extents. */
export type OBB = { c: P2; u: P2; v: P2; halfL: number; halfW: number; area: number };

/** Minimum-area oriented bounding rectangle via hull edges (no trig needed). */
export function minAreaRect(pts: readonly P2[]): OBB {
  const hull = convexHull(pts);
  let best: OBB | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.sqrt((b.e - a.e) * (b.e - a.e) + (b.n - a.n) * (b.n - a.n));
    if (len < 1e-9) continue;
    const u = { e: (b.e - a.e) / len, n: (b.n - a.n) / len };
    const v = { e: -u.n, n: u.e };
    let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity;
    for (const p of hull) {
      const pu = p.e * u.e + p.n * u.n;
      const pv = p.e * v.e + p.n * v.n;
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-9) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const c = { e: cu * u.e + cv * v.e, n: cu * u.n + cv * v.n };
      const hu = (maxU - minU) / 2;
      const hv = (maxV - minV) / 2;
      // Normalise so `u` is the long axis.
      best =
        hu >= hv
          ? { c, u, v, halfL: hu, halfW: hv, area }
          : { c, u: v, v: { e: -u.e, n: -u.n }, halfL: hv, halfW: hu, area };
    }
  }
  if (!best) throw new Error('minAreaRect: degenerate polygon');
  return best;
}
