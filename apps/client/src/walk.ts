import type { PerspectiveCamera } from 'three/webgpu';
import type { Pose } from './url';

const WALK = 4; // m/s — brisk; this is a game, not a simulator
const RUN = 14;
const EYE_MIN = 1.7;
const EYE_MAX = 150;
const LOOK = 0.0035; // rad per px
const PITCH_LIMIT = 1.45;

/**
 * Walk camera. Keyboard + drag-to-look on desktop; on touch, the left side of
 * the screen is a virtual joystick and the right side looks around.
 */
export class WalkControls {
  pose: Pose;
  private keys = new Set<string>();
  private look: { id: number; x: number; y: number; x0: number; y0: number; t0: number } | null =
    null;
  /** Called for a quick press-and-release without dragging (a tap or click). */
  onTap: (clientX: number, clientY: number) => void = () => {};
  private stick: { id: number; x0: number; y0: number; dx: number; dy: number } | null = null;
  private stickEl: HTMLElement;
  /** Ground height under a point; `pose.y` is the eye's height above it. Flat by default. */
  groundAt: (x: number, z: number) => number = () => 0;
  private ground: number | null = null;
  private knobEl: HTMLElement;

  constructor(
    private camera: PerspectiveCamera,
    private dom: HTMLElement,
    pose: Pose,
  ) {
    this.pose = { ...pose };
    this.stickEl = document.getElementById('joystick')!;
    this.knobEl = this.stickEl.querySelector('.knob')!;
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.pose.y = Math.min(EYE_MAX, Math.max(EYE_MIN, this.pose.y * (1 + e.deltaY * 0.0015)));
      },
      { passive: false },
    );
    this.apply();
  }

  private onDown = (e: PointerEvent) => {
    this.dom.setPointerCapture(e.pointerId);
    this.dom.focus();
    if (e.pointerType === 'touch' && e.clientX < innerWidth * 0.45 && !this.stick) {
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
      this.stickEl.style.display = 'block';
      this.stickEl.style.left = `${e.clientX}px`;
      this.stickEl.style.top = `${e.clientY}px`;
      this.knobEl.style.transform = '';
    } else if (!this.look) {
      this.look = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        x0: e.clientX,
        y0: e.clientY,
        t0: performance.now(),
      };
    }
  };

  private onMove = (e: PointerEvent) => {
    if (this.stick?.id === e.pointerId) {
      const dx = e.clientX - this.stick.x0;
      const dy = e.clientY - this.stick.y0;
      const len = Math.hypot(dx, dy);
      const k = len > 48 ? 48 / len : 1;
      this.stick.dx = (dx * k) / 48;
      this.stick.dy = (dy * k) / 48;
      this.knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    } else if (this.look?.id === e.pointerId) {
      this.pose.yaw -= (e.clientX - this.look.x) * LOOK;
      this.pose.pitch = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, this.pose.pitch - (e.clientY - this.look.y) * LOOK),
      );
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.stick?.id === e.pointerId) {
      this.stick = null;
      this.stickEl.style.display = 'none';
    }
    if (this.look?.id === e.pointerId) {
      const l = this.look;
      this.look = null;
      if (
        e.type === 'pointerup' &&
        Math.hypot(e.clientX - l.x0, e.clientY - l.y0) < 6 &&
        performance.now() - l.t0 < 400
      ) {
        this.onTap(e.clientX, e.clientY);
      }
    }
  };

  /** Advance by `dt` seconds. Returns true if the pose changed. */
  update(dt: number): boolean {
    const k = this.keys;
    let fwd =
      (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let side =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) -
      (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (k.has('KeyQ')) this.pose.yaw += 1.8 * dt;
    if (k.has('KeyE')) this.pose.yaw -= 1.8 * dt;
    if (k.has('KeyR')) this.pose.y = Math.min(EYE_MAX, this.pose.y + 8 * dt);
    if (k.has('KeyF')) this.pose.y = Math.max(EYE_MIN, this.pose.y - 8 * dt);
    let speed = k.has('ShiftLeft') || k.has('ShiftRight') ? RUN : WALK;
    if (this.stick) {
      fwd = -this.stick.dy;
      side = this.stick.dx;
      if (Math.hypot(fwd, side) > 0.95) speed = RUN * 0.6;
    }
    // Move faster when high up so the neighbourhood stays explorable from above.
    speed *= Math.max(1, this.pose.y / 10);
    const before = `${this.pose.x},${this.pose.y},${this.pose.z},${this.pose.yaw},${this.pose.pitch}`;
    if (fwd || side) {
      const len = Math.hypot(fwd, side);
      const f = (fwd / Math.max(1, len)) * speed * dt;
      const s = (side / Math.max(1, len)) * speed * dt;
      const sin = Math.sin(this.pose.yaw);
      const cos = Math.cos(this.pose.yaw);
      this.pose.x += -sin * f + cos * s;
      this.pose.z += -cos * f - sin * s;
    }
    this.apply(dt);
    return (
      before !== `${this.pose.x},${this.pose.y},${this.pose.z},${this.pose.yaw},${this.pose.pitch}`
    );
  }

  private apply(dt = 0) {
    // Ease toward the ground so steps between heightmap pixels don't jolt the view,
    // but never let the eye sink below it.
    const g = this.groundAt(this.pose.x, this.pose.z);
    this.ground =
      this.ground === null || dt === 0 ? g : Math.max(g, this.ground + (g - this.ground) * Math.min(1, dt * 8));
    this.camera.position.set(this.pose.x, this.ground + this.pose.y, this.pose.z);
    this.camera.rotation.set(this.pose.pitch, this.pose.yaw, 0, 'YXZ');
  }
}
