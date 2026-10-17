import { rngFor } from '../hash/rng';
import type { ResolvedAttrs } from '../facts/resolve';
import { RoofShape, type LngLat } from '../schema/fact';
import type { Essence } from '../schema/world';
import { essenceParams } from '../essence/compute';
import type { Expr, GeneratorDef, Op } from '../schema/generator';
import type { LocalFrame } from '../geo/frame';
import { MeshBuilder, type Conf, type V3 } from './mesh';
import { cleanRing, minAreaRect, signedArea, type P2 } from './polygon';
import { blob, box, cylinder, extrude, ribbon, roof, windows } from './shapes';

/**
 * Bump when interpreter output changes for the same inputs. It is part of every
 * Bundle's content address, so old Bundles are rebuilt rather than mixed.
 */
export const INTERPRETER_VERSION = '0.4.0';

/** Confidence of anything a generator imagines rather than reads from a Fact. */
export const IMAGINED = 0.25;

type Scalar = number | string | boolean | null;
export type Val = { v: Scalar; c: number };

export type FeatureInput = { id: string; attrs: ResolvedAttrs };

type Ctx = {
  feature: FeatureInput;
  env: Map<string, Val>;
};

export class GeneratorError extends Error {}

const lit = (v: Scalar): Val => ({ v, c: 1 });
const minC = (...xs: Val[]) => xs.reduce((m, x) => Math.min(m, x.c), 1);
const num = (x: Val): number | null =>
  typeof x.v === 'number' && Number.isFinite(x.v) ? x.v : null;

export function evalExpr(e: Expr, ctx: Ctx): Val {
  if (typeof e === 'number' || typeof e === 'string' || typeof e === 'boolean') return lit(e);
  if ('attr' in e && !('op' in e)) {
    const r = ctx.feature.attrs[e.attr];
    if (
      r &&
      (typeof r.value === 'number' || typeof r.value === 'string' || typeof r.value === 'boolean')
    ) {
      return { v: r.value, c: r.confidence };
    }
    if (e.default === undefined) return { v: null, c: 0 };
    const d = evalExpr(e.default, ctx);
    return { v: d.v, c: Math.min(d.c, IMAGINED) };
  }
  if ('param' in e) {
    const p = ctx.env.get(e.param);
    if (!p) throw new GeneratorError(`unknown param ${e.param}`);
    return p;
  }
  switch (e.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'min':
    case 'max': {
      const xs = e.args.map((a) => evalExpr(a, ctx));
      const ns = xs.map(num);
      if (ns.some((n) => n === null)) return { v: null, c: 0 };
      const [first, ...rest] = ns as number[];
      const v = rest.reduce((acc, n) => {
        switch (e.op) {
          case 'add':
            return acc + n;
          case 'sub':
            return acc - n;
          case 'mul':
            return acc * n;
          case 'div':
            return n === 0 ? NaN : acc / n;
          case 'min':
            return Math.min(acc, n);
          default:
            return Math.max(acc, n);
        }
      }, first!);
      return Number.isFinite(v) ? { v, c: minC(...xs) } : { v: null, c: 0 };
    }
    case 'eq':
    case 'lt':
    case 'gt': {
      const [a, b] = e.args.map((x) => evalExpr(x, ctx)) as [Val, Val];
      const v =
        e.op === 'eq'
          ? a.v === b.v
          : a.v !== null && b.v !== null && (e.op === 'lt' ? a.v < b.v : a.v > b.v);
      return { v, c: minC(a, b) };
    }
    case 'and':
    case 'or': {
      const xs = e.args.map((x) => evalExpr(x, ctx));
      const v = e.op === 'and' ? xs.every((x) => !!x.v) : xs.some((x) => !!x.v);
      return { v, c: minC(...xs) };
    }
    case 'not': {
      const x = evalExpr(e.value, ctx);
      return { v: !x.v, c: x.c };
    }
    case 'has':
      return lit(e.attr in ctx.feature.attrs);
    case 'floor': {
      const x = evalExpr(e.value, ctx);
      const n = num(x);
      return n === null ? { v: null, c: 0 } : { v: Math.floor(n), c: x.c };
    }
    case 'clamp': {
      const [x, lo, hi] = [e.value, e.min, e.max].map((a) => evalExpr(a, ctx)) as [Val, Val, Val];
      const [n, l, h] = [num(x), num(lo), num(hi)];
      if (n === null || l === null || h === null) return { v: null, c: 0 };
      return { v: Math.min(h, Math.max(l, n)), c: minC(x, lo, hi) };
    }
    case 'rand': {
      const lo = evalExpr(e.min, ctx);
      const hi = evalExpr(e.max, ctx);
      const [l, h] = [num(lo), num(hi)];
      if (l === null || h === null) return { v: null, c: 0 };
      const r = rngFor(ctx.feature.id, e.key)();
      return { v: l + r * (h - l), c: Math.min(IMAGINED, lo.c, hi.c) };
    }
    case 'pick': {
      const r = rngFor(ctx.feature.id, e.key)();
      // Weights may be expressions (e.g. Essence statistics); non-positive means "never".
      const w = (e.weights ?? e.options.map(() => 1)).map((x) => {
        const n = num(evalExpr(x, ctx));
        return n !== null && n > 0 ? n : 0;
      });
      if (w.length !== e.options.length)
        throw new GeneratorError('pick: weights/options length mismatch');
      const total = w.reduce((a, b) => a + b, 0);
      if (total <= 0) return { v: null, c: 0 };
      let acc = 0;
      let i = 0;
      for (; i < w.length - 1; i++) {
        acc += w[i]! / total;
        if (r < acc) break;
      }
      const chosen = evalExpr(e.options[i]!, ctx);
      return { v: chosen.v, c: Math.min(IMAGINED, chosen.c) };
    }
    case 'if': {
      const cond = evalExpr(e.cond, ctx);
      const branch = evalExpr(cond.v ? e.then : e.else, ctx);
      return { v: branch.v, c: Math.min(cond.c, branch.c) };
    }
  }
}

export type GeometryInput = {
  frame: LocalFrame;
};

export type RunStats = { ops: number; skipped: number; windows: number };

function lngLatsToLocal(frame: LocalFrame, pts: LngLat[]): P2[] {
  return pts.map(([lng, lat]) => frame.project({ lat, lng }));
}

/**
 * Run one GeneratorDef for one Feature, appending geometry to `mesh`. Returns
 * null if the Feature lacks the geometry the generator needs.
 */
export function runGenerator(
  def: GeneratorDef,
  feature: FeatureInput,
  frame: LocalFrame,
  mesh: MeshBuilder,
  essence?: Essence,
): RunStats | null {
  const geomAttr = def.geometry;
  const g = feature.attrs[geomAttr];
  if (!g) return null;
  const geomConf = g.confidence;

  let ring: P2[] | null = null;
  let path: P2[] | null = null;
  let point: P2 | null = null;
  if (geomAttr === 'footprint') {
    ring = cleanRing(lngLatsToLocal(frame, g.value as LngLat[]));
    if (ring.length < 3) return null;
  } else if (geomAttr === 'path') {
    path = lngLatsToLocal(frame, g.value as LngLat[]);
  } else {
    const [lng, lat] = g.value as LngLat;
    point = frame.project({ lat, lng });
  }

  const ctx: Ctx = { feature, env: new Map() };
  // The place's character (ADR-0014): statistics, not Facts about this Feature, so imagined.
  for (const [k, v] of Object.entries(essenceParams(essence))) ctx.env.set(k, { v, c: IMAGINED });
  if (ring) {
    // Footprint metrics, available to generators as `@area`, `@width`, `@length`, `@perimeter`.
    const r = minAreaRect(ring);
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      perimeter += Math.sqrt((b.e - a.e) * (b.e - a.e) + (b.n - a.n) * (b.n - a.n));
    }
    ctx.env.set('@area', { v: Math.abs(signedArea(ring)), c: geomConf });
    ctx.env.set('@width', { v: r.halfW * 2, c: geomConf });
    ctx.env.set('@length', { v: r.halfL * 2, c: geomConf });
    ctx.env.set('@perimeter', { v: perimeter, c: geomConf });
  }
  const stats: RunStats = { ops: 0, skipped: 0, windows: 0 };

  const n = (e: Expr, what: string): Val & { v: number } => {
    const x = evalExpr(e, ctx);
    if (typeof x.v !== 'number') throw new SkipOp(`${what} is not a number`);
    return x as Val & { v: number };
  };
  const s = (e: Expr, what: string): Val & { v: string } => {
    const x = evalExpr(e, ctx);
    if (typeof x.v !== 'string') throw new SkipOp(`${what} is not a string`);
    return x as Val & { v: string };
  };
  const conf = (op: Op, colour: Val, ...shape: Val[]): Conf => [
    Math.min(geomConf, op.confidence ?? 1, ...shape.map((x) => x.c)),
    colour.c,
  ];
  const need = <T>(x: T | null, what: string): T => {
    if (x === null) throw new SkipOp(`needs ${what}`);
    return x;
  };
  const v3 = (xs: [Expr, Expr, Expr], what: string): { v: V3; vals: Val[] } => {
    const vals = xs.map((x, i) => n(x, `${what}[${i}]`));
    return { v: vals.map((x) => x.v) as V3, vals };
  };

  for (const op of def.ops) {
    try {
      if (op.when !== undefined && !evalExpr(op.when, ctx).v) {
        stats.skipped++;
        continue;
      }
      switch (op.op) {
        case 'let':
          ctx.env.set(op.name, evalExpr(op.value, ctx));
          break;
        case 'extrude': {
          const [b, t, c] = [n(op.base, 'base'), n(op.top, 'top'), s(op.colour, 'colour')];
          extrude(mesh, need(ring, 'footprint'), b.v, t.v, c.v, conf(op, c, b, t));
          break;
        }
        case 'roof': {
          const sh = evalExpr(op.shape, ctx);
          const parsed = RoofShape.safeParse(sh.v);
          const shape = parsed.success ? parsed.data : 'flat';
          const [b, r, c] = [n(op.base, 'base'), n(op.rise, 'rise'), s(op.colour, 'colour')];
          const wc = op.wallColour !== undefined ? s(op.wallColour, 'wallColour') : c;
          roof(mesh, need(ring, 'footprint'), shape, b.v, r.v, c.v, wc.v, conf(op, c, sh, b, r));
          break;
        }
        case 'windows': {
          const vals = {
            base: n(op.base, 'base'),
            top: n(op.top, 'top'),
            floorHeight: n(op.floorHeight, 'floorHeight'),
            width: n(op.width, 'width'),
            height: n(op.height, 'height'),
            sill: n(op.sill, 'sill'),
            spacing: n(op.spacing, 'spacing'),
          };
          const c = s(op.colour, 'colour');
          const spec = Object.fromEntries(Object.entries(vals).map(([k, x]) => [k, x.v])) as Record<
            keyof typeof vals,
            number
          >;
          stats.windows += windows(
            mesh,
            need(ring, 'footprint'),
            spec,
            c.v,
            conf(op, c, ...Object.values(vals)),
          );
          break;
        }
        case 'ribbon': {
          const [w, y, c] = [n(op.width, 'width'), n(op.y, 'y'), s(op.colour, 'colour')];
          ribbon(mesh, need(path, 'path'), w.v, y.v, c.v, conf(op, c, w));
          break;
        }
        case 'box': {
          const at = v3(op.at, 'at');
          const size = v3(op.size, 'size');
          const yaw = op.yaw !== undefined ? n(op.yaw, 'yaw') : lit(0);
          const c = s(op.colour, 'colour');
          box(
            mesh,
            need(point, 'position'),
            yaw.v as number,
            at.v,
            size.v,
            c.v,
            conf(op, c, ...at.vals, ...size.vals),
          );
          break;
        }
        case 'cylinder': {
          const at = v3(op.at, 'at');
          const [r, h, c] = [
            n(op.radius, 'radius'),
            n(op.height, 'height'),
            s(op.colour, 'colour'),
          ];
          const tr = op.topRadius !== undefined ? n(op.topRadius, 'topRadius') : r;
          cylinder(
            mesh,
            need(point, 'position'),
            at.v,
            r.v,
            tr.v,
            h.v,
            op.segments,
            c.v,
            conf(op, c, ...at.vals, r, h, tr),
          );
          break;
        }
        case 'blob': {
          const at = v3(op.at, 'at');
          const [r, c] = [n(op.radius, 'radius'), s(op.colour, 'colour')];
          const sq = op.squash !== undefined ? n(op.squash, 'squash') : lit(1);
          blob(
            mesh,
            need(point, 'position'),
            at.v,
            r.v,
            sq.v as number,
            op.detail,
            c.v,
            conf(op, c, ...at.vals, r),
          );
          break;
        }
      }
      stats.ops++;
    } catch (err) {
      if (err instanceof SkipOp) stats.skipped++;
      else throw err;
    }
  }
  return stats;
}

class SkipOp extends Error {}
