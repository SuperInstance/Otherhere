import type { Pose } from './url';

const TAU = Math.PI * 2;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Ease in and out with zero slope and curvature at both ends, so a glide starts and stops without a jerk. */
export function smootherstep(t: number): number {
  return t * t * t * (t * (6 * t - 15) + 10);
}

/** Signed turn from `from` to `to` the short way round, in (-π, π]: a yaw glide never spins the long way. */
export function shortestAngle(from: number, to: number): number {
  const d = (to - from) % TAU;
  if (d > Math.PI) return d - TAU;
  if (d <= -Math.PI) return d + TAU;
  return d;
}

/** Where the establishing shot sits relative to its target, as a compass bearing (radians clockwise from north). */
const SHOT_BEARING = (202.5 * Math.PI) / 180;
/** North is -z and east is +x, so a bearing becomes (sin, -cos) on the ground plane: here, west and south. */
const SHOT_DX = Math.sin(SHOT_BEARING);
const SHOT_DZ = -Math.cos(SHOT_BEARING);

const DEFAULT_SHOT_HEIGHT = 260;
const DEFAULT_SHOT_DISTANCE = 520;

/** Less than the exact look-at pitch: the eye lands a little above the target, putting the far hills in frame. */
const SHOT_PITCH_SCALE = 0.85;

/** An establishing shot above and behind `target`, looking at it: where an arrival starts. */
export function establishingShot(
  target: Pose,
  opts?: { height?: number; distance?: number },
): Pose {
  const height = opts?.height ?? DEFAULT_SHOT_HEIGHT;
  const distance = opts?.distance ?? DEFAULT_SHOT_DISTANCE;
  const x = target.x + SHOT_DX * distance;
  const z = target.z + SHOT_DZ * distance;
  const y = target.y + height;
  // Forward is (-sin yaw, -cos yaw) in (x, z), so looking back down the offset gives the yaw that faces the target.
  const yaw = distance > 0 ? Math.atan2(x - target.x, z - target.z) : target.yaw;
  const pitch = -Math.atan2(y - target.y, distance) * SHOT_PITCH_SCALE;
  return { x, y, z, yaw, pitch };
}

const DEFAULT_SECONDS = 7;
/** A retarget late in the glide still gets this long to settle, so the camera never snaps. */
const MIN_RETARGET_SECONDS = 1.5;
/** Height starts easing this far in, so the camera swoops down onto the street instead of sliding in level. */
const HEIGHT_DELAY = 0.15;

/**
 * Glides a pose from `from` to `to` over `seconds`, then stops. Position eases with smootherstep;
 * height comes down on a slightly later curve than the horizontal move, so the camera swoops in
 * rather than sliding; yaw takes the shortest way round; pitch eases from `from.pitch` to `to.pitch`.
 */
export class Arrival {
  private fromX: number;
  private fromY: number;
  private fromZ: number;
  private fromYaw: number;
  private fromPitch: number;
  private toX: number;
  private toY: number;
  private toZ: number;
  private toYaw: number;
  private toPitch: number;
  /** Shortest signed turn between the two yaws, fixed when the glide is set up so step stays allocation-free. */
  private yawDelta: number;
  private duration: number;
  private elapsed = 0;
  private finished = false;

  constructor(from: Pose, to: Pose, seconds = DEFAULT_SECONDS) {
    this.fromX = from.x;
    this.fromY = from.y;
    this.fromZ = from.z;
    this.fromYaw = from.yaw;
    this.fromPitch = from.pitch;
    this.toX = to.x;
    this.toY = to.y;
    this.toZ = to.z;
    this.toYaw = to.yaw;
    this.toPitch = to.pitch;
    this.yawDelta = shortestAngle(from.yaw, to.yaw);
    // Scalar fields only: the caller may keep mutating whatever pose it passed in.
    this.duration = seconds > 0 ? seconds : 0;
  }

  /** True once the glide has landed on its target. */
  get done(): boolean {
    return this.finished;
  }

  /** Advance by dt seconds and write the current pose into `out`. Returns false once finished (and leaves `out` exactly at `to`). */
  step(dt: number, out: Pose): boolean {
    if (!this.finished) {
      if (dt > 0) this.elapsed = Math.min(this.elapsed + dt, this.duration);
      this.finished = this.elapsed >= this.duration;
    }
    if (this.finished) {
      // Land exactly on the target rather than on a re-interpolated approximation of it.
      out.x = this.toX;
      out.y = this.toY;
      out.z = this.toZ;
      out.yaw = this.toYaw;
      out.pitch = this.toPitch;
      return false;
    }
    const t = this.elapsed / this.duration;
    const s = smootherstep(t);
    const h = smootherstep(clamp01((t - HEIGHT_DELAY) / (1 - HEIGHT_DELAY)));
    out.x = this.fromX + (this.toX - this.fromX) * s;
    out.z = this.fromZ + (this.toZ - this.fromZ) * s;
    out.y = this.fromY + (this.toY - this.fromY) * h;
    out.pitch = this.fromPitch + (this.toPitch - this.fromPitch) * s;
    out.yaw = this.fromYaw + this.yawDelta * s;
    return true;
  }

  /** Retarget mid-flight (e.g. the start moved onto the nearest road): the remaining glide ends at `to`, without a jump. */
  retarget(to: Pose): void {
    // Freeze the pose currently on screen as the new start, so the swap is invisible.
    const t = this.finished || this.duration <= 0 ? 1 : this.elapsed / this.duration;
    const s = smootherstep(t);
    const h = smootherstep(clamp01((t - HEIGHT_DELAY) / (1 - HEIGHT_DELAY)));
    this.fromX += (this.toX - this.fromX) * s;
    this.fromZ += (this.toZ - this.fromZ) * s;
    this.fromY += (this.toY - this.fromY) * h;
    this.fromYaw += this.yawDelta * s;
    this.fromPitch += (this.toPitch - this.fromPitch) * s;
    // Carry over whatever time the old glide had left, floored so the landing is still readable.
    this.duration = Math.max(MIN_RETARGET_SECONDS, this.duration - this.elapsed);
    this.elapsed = 0;
    this.finished = false;
    this.toX = to.x;
    this.toY = to.y;
    this.toZ = to.z;
    this.toYaw = to.yaw;
    this.toPitch = to.pitch;
    this.yawDelta = shortestAngle(this.fromYaw, to.yaw);
  }
}
