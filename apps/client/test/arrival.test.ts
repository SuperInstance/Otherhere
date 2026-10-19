import { describe, expect, it } from 'vitest';
import { Arrival, establishingShot, shortestAngle, smootherstep } from '../src/arrival';

describe('arrival', () => {
  it('eases from 0 to 1 with zero slope at both ends', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 12);
    expect(smootherstep(0.01)).toBeLessThan(0.0001);
  });

  it('turns the short way round', () => {
    expect(shortestAngle(3, -3)).toBeCloseTo(2 * Math.PI - 6, 12);
    expect(shortestAngle(-3, 3)).toBeCloseTo(6 - 2 * Math.PI, 12);
    expect(shortestAngle(0, 1)).toBeCloseTo(1, 12);
  });

  it('starts above the target and lands exactly on it', () => {
    const street = { x: 10, y: 1.7, z: -20, yaw: 0.3, pitch: 0 };
    const from = establishingShot(street);
    expect(from.y).toBeGreaterThan(100);
    expect(from.pitch).toBeLessThan(0);
    const pose = { ...from };
    const glide = new Arrival(from, street, 2);
    let frames = 0;
    while (glide.step(0.1, pose) && frames < 100) frames++;
    expect(glide.done).toBe(true);
    expect(pose).toEqual(street);
  });

  it('retargets mid-flight without a jump', () => {
    const street = { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 };
    const pose = establishingShot(street);
    const glide = new Arrival({ ...pose }, street, 4);
    for (let i = 0; i < 10; i++) glide.step(0.1, pose);
    const before = { ...pose };
    glide.retarget({ ...street, x: 30, z: -10 });
    glide.step(0.001, pose);
    expect(Math.hypot(pose.x - before.x, pose.z - before.z)).toBeLessThan(0.5);
    expect(Math.abs(pose.y - before.y)).toBeLessThan(0.5);
  });
});
