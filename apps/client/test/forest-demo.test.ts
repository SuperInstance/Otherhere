import { describe, expect, it } from 'vitest';
import { ForestDemo } from '../src/forest-demo';
import { crownApex, crownTipFlex } from '../src/forest';
import { swayOffset, WIND_PERIOD } from '../src/wind';

describe("crownTipFlex (the prediction's traveller, read from the geometry)", () => {
  it("is the flex baked at each species' apex vertex", () => {
    // Spruce: stiff tiers, 0.72 * t^1.8 at the y=1 apex. Hemlock: the whipped
    // leader, t^2.4 + the 0.18 leader term. Golden numbers from the geometry.
    expect(crownTipFlex(true)).toBeCloseTo(0.72, 5);
    expect(crownTipFlex(false)).toBeCloseTo(1.18, 5);
  });
  it('puts the apex at the top of the crown, leaning only for hemlock', () => {
    expect(crownApex(true)).toEqual({ x: 0, y: 1, z: 0 });
    expect(crownApex(false).x).toBeGreaterThan(0);
    expect(crownApex(false).y).toBe(1);
  });
});

describe('ForestDemo (the #66 instrument, maths only — no renderer here)', () => {
  it('chooses the same witness every time, and isolates it alone', () => {
    const a = new ForestDemo({ species: 'spruce' });
    const b = new ForestDemo({ species: 'spruce' });
    const wa = a.readout().witness;
    const wb = b.readout().witness;
    expect(wa.x).toBe(wb.x);
    expect(wa.z).toBe(wb.z);
    expect(wa.height).toBe(wb.height);
    expect(wa.spruce).toBe(true);
    // The isolation replant leaves exactly the witness standing.
    expect(a.readout().trees).toBe(1);
    expect(a.readout().ready).toBe(true);
    a.dispose();
    b.dispose();
  });

  it('honours the species and grove asks', () => {
    const hemlock = new ForestDemo({ species: 'hemlock' });
    expect(hemlock.readout().witness.spruce).toBe(false);
    hemlock.dispose();
    // A wide grove keeps the witness's neighbours: more than one tree.
    const grove = new ForestDemo({ species: 'spruce', grove: 40 });
    expect(grove.readout().trees).toBeGreaterThan(1);
    grove.dispose();
  });

  it('predicts the apex with the wind spec, periodic on the wind period', () => {
    const demo = new ForestDemo({ species: 'spruce' });
    const { apex, flexTip } = demo.readout().witness;
    // The prediction is swayOffset applied at the apex — exactly what the
    // shader adds to the apex vertex, projected.
    const p0 = demo.predictTip(0);
    const o = swayOffset(0, demo.readout().cloud, apex.x, apex.z, flexTip);
    const direct = demo.project(apex.x + o[0], apex.y, apex.z + o[1]);
    expect(p0.u).toBeCloseTo(direct.u, 6);
    expect(p0.v).toBeCloseTo(direct.v, 6);
    // And it is exactly periodic: one wind period later is the same place.
    const pT = demo.predictTip(WIND_PERIOD);
    expect(pT.u).toBeCloseTo(p0.u, 4);
    expect(pT.v).toBeCloseTo(p0.v, 4);
    // The resting apex sits at the centre of the readback, where the mask
    // expects it (the t=0 prediction is already displaced — the wind is on).
    const rest = demo.project(apex.x, apex.y, apex.z);
    expect(Math.abs(rest.u - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(rest.v - 128)).toBeLessThanOrEqual(1);
    // A full-strength sway stays inside the target: the readback can see it.
    const span = Math.hypot(p0.u - rest.u, p0.v - rest.v);
    expect(span).toBeGreaterThan(0.5); // the t=0 wind visibly moves the tip
    expect(span).toBeLessThan(100);
    demo.dispose();
  });
});
