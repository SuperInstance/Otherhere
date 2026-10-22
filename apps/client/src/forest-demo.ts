import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type WebGPURenderer,
} from 'three/webgpu';
import { crownApex, crownTipFlex, Forest, type PlantedTree } from './forest';
import { cornerBackground, maskCentroid, trackTip } from './crown-readback';
import { swayOffset, WIND_TOWARD } from './wind';

/**
 * The forest test stand (`?demo=forest`) — the crown-motion instrument of #66,
 * Arc 1's first probe law. It is a display-layer world like the generator demo:
 * no network, no Facts, no Bundle — nothing here can touch a golden hash.
 *
 * What round 09 measured still stands: in a real scene, cloud shadows, mist
 * and sky ride the same freezable clock as the crowns, and swamp any
 * forest-region isolation (a full-frame diff at 2.5 s moves 65–70 % of
 * pixels). So this world removes the pollution by construction instead of
 * filtering it: a flat paper plane, one known conifer (the witness) planted by
 * the real `Forest` on the real chunk lattice, a flat background no sky lives
 * in, and two fixed cameras. The only thing that moves is the witness's crown.
 *
 * Per frame it renders a small offscreen target aimed at the witness's apex
 * and reads it back — race-free, inside the same animation frame the wind
 * uniforms were written for — and tracks the apex as the centroid of the
 * crown mask's topmost rows (`crown-readback.ts`). The reading is recorded
 * with the exact wind state the shader saw that frame, from the same debug
 * handle the walk spec trusts. The law that grades these readings lives in
 * the e2e (`crown.spec.ts`) and in the probe's crown scene, not here: this
 * module measures, it does not pass its own test.
 *
 * Determinism: the witness is whatever the real lattice plants nearest the
 * origin — a pure function of the chunk hash and the flat ground — and the
 * isolation replant keeps only it, so every run of every device watches the
 * same tree. `?t=` pins the demo's clock exactly as it pins the day: a frozen
 * demo records still readings, the motion law's negative control.
 */

/** The witness stands on a plane at this height: above the 2.5 m beach line
 *  below which `Forest` plants nothing (MIN_GROUND), and flat, so the lattice
 *  is a pure function of position. */
const GROUND_H = 10;
/** Offscreen readback target, pixels. Square, so one fov covers both axes. */
const RT = 256;
/** The probe camera's distance from the witness apex, metres. Near enough that
 *  a full sway (SWAY_MAX_M and the hemlock leader's flex) spans tens of pixels. */
const PROBE_D = 26;
/** The flat sky colour, as a CSS string for the scene background. The readback
 *  never assumes its byte value: it samples the target's corners, which are
 *  always background (the crown is centred), so colour management cannot break
 *  the mask. */
const SKY_CSS = '#cdd3da';
/** How many readings the ring buffer keeps — the law needs dozens, not thousands. */
const FRAMES_CAP = 480;

/** One recorded frame: the wind the shader saw, and where the apex read. */
export type CrownFrame = {
  /** The wrapped wind clock the shader rendered this frame with. */
  t: number;
  /** The strength uniform the shader rendered this frame with. */
  strength: number;
  /** The apex reading in readback pixels (u right, v down). */
  u: number;
  v: number;
};

export type ForestDemoOpts = {
  species?: 'spruce' | 'hemlock';
  /** Keep every tree within this radius of the witness (metres). The default
   *  isolates the witness alone; a wider radius grows a grove to look at. */
  grove?: number;
  /** Freeze the clock (the `?t=` doctrine: a pinned world holds still). */
  frozen?: boolean;
};

export class ForestDemo {
  readonly scene = new Scene();
  readonly viewCamera: PerspectiveCamera;
  private readonly probeCamera: PerspectiveCamera;
  private readonly rt = new WebGLRenderTarget(RT, RT, { depthBuffer: true });
  private readonly forest: Forest;
  private readonly witness: PlantedTree;
  private readonly apex: Vector3;
  private readonly flexTip: number;
  private readonly cloud = 0.15; // clear sky: the wind blows at strength, not stillness
  private readonly frozen: boolean;
  private elapsed = 0;
  private readonly frames: CrownFrame[] = [];
  private dropped = 0;
  private reading = false;
  /** The readback buffer's row order, learned from the first frame (null until
   *  then): WebGL reads bottom-up, WebGPU top-down, and the instrument refuses
   *  to guess. */
  private bottomUp: boolean | null = null;

  constructor(opts: ForestDemoOpts = {}) {
    const spruceP = opts.species === 'hemlock' ? 0 : 1;
    const grove = opts.grove ?? 1.5;
    this.frozen = opts.frozen ?? false;

    // Phase 1 — scout: plant the real lattice around the origin and let the
    // chunk hash choose the witness. The streaming centre and radius guarantee
    // its chunk plants at stride 1, so the witness is in the planted list.
    const flat = { active: true, heightAt: () => GROUND_H };
    const scout = new Forest(this.scene, flat, {
      radius: 350,
      mix: () => spruceP,
    });
    for (let i = 0; i < 200 && !scout.settled(); i++) scout.update(0, 0);
    const witness = scout.nearest(0, 0);
    scout.dispose();
    if (!witness)
      throw new Error('the forest demo found no tree to watch (the flat stand planted nothing)');
    this.witness = witness;

    // Phase 2 — isolate: replant with everything but the witness's grove
    // occupied. The lattice is deterministic, so the witness returns exactly
    // as the scout planted it, alone (or with its grove).
    this.forest = new Forest(this.scene, flat, {
      radius: 350,
      mix: () => spruceP,
      occupied: (x, z) => (x - witness.x) ** 2 + (z - witness.z) ** 2 > grove ** 2,
    });
    for (let i = 0; i < 200 && !this.forest.settled(); i++) this.forest.update(0, 0);

    // The apex the prediction travels from: the geometry's own topmost vertex,
    // instance-transformed exactly as the shader sees it (translate, yaw, scale).
    const a = crownApex(witness.spruce);
    const cw = Math.cos(witness.yaw);
    const sw = Math.sin(witness.yaw);
    this.apex = new Vector3(
      witness.x + (a.x * witness.width * cw + a.z * witness.width * sw),
      witness.y + a.y * witness.height,
      witness.z + (-a.x * witness.width * sw + a.z * witness.width * cw),
    );
    this.flexTip = crownTipFlex(witness.spruce);

    // The world: flat light and a flat sky no weather lives in — and no
    // ground. A lit plane can never be guaranteed to render the clear colour
    // exactly (tone mapping sees lit materials, not clears), and the readback
    // needs every background pixel to be one flat value by construction. So
    // the witness floats in the void: an instrument, not a landscape. Nothing
    // in frame moves but the crown.
    this.scene.background = new Color(SKY_CSS);
    const hemi = new HemisphereLight('#f6f2ea', '#b7ab92', 1.7);
    const sun = new DirectionalLight('#fff4e2', 1.9);
    sun.position.set(-0.45, 1, 0.3);
    this.scene.add(hemi, sun);

    // The probe camera looks across the wind, so along-wind sway lands fully
    // on screen-x; it aims at the apex so the crown fills the readback.
    const across = new Vector3(-WIND_TOWARD[1], 0, WIND_TOWARD[0]);
    this.probeCamera = new PerspectiveCamera(35, 1, 0.3, 600);
    this.probeCamera.position.copy(this.apex).addScaledVector(across, -PROBE_D);
    this.probeCamera.lookAt(this.apex);
    this.probeCamera.updateMatrixWorld();

    // The view camera is for eyes: the whole witness on its paper plane.
    const h = witness.height;
    this.viewCamera = new PerspectiveCamera(50, 1, 0.3, 4000);
    this.viewCamera.position
      .set(witness.x, GROUND_H + h * 0.45, witness.z)
      .addScaledVector(across, -h * 2.2);
    this.viewCamera.lookAt(witness.x, GROUND_H + h * 0.5, witness.z);
    // Track the window when there is one (the readback tests run headless in
    // plain node, where only the instrument's maths is exercised).
    if (typeof innerWidth === 'number' && typeof addEventListener === 'function') {
      const fit = () => {
        this.viewCamera.aspect = innerWidth / innerHeight;
        this.viewCamera.updateProjectionMatrix();
      };
      addEventListener('resize', fit);
      fit();
    }
  }

  /**
   * One animation frame: advance the demo's own clock (the sky's step law —
   * clamped, and exactly 0 when pinned), feed the real `setWind`, stream the
   * forest, and take the readback. The renderer is passed in because the
   * offscreen render must happen inside this frame, paired with the wind
   * state this frame wrote.
   */
  frame(renderer: WebGPURenderer, rawDt: number): void {
    this.elapsed += this.frozen ? 0 : Math.min(2, Math.max(0, rawDt));
    this.forest.setWind(this.elapsed, this.cloud, 0);
    this.forest.update(0, 0);

    if (this.reading) return; // one readback in flight; this frame is skipped
    this.reading = true;
    const { time, strength } = this.forest.wind();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.probeCamera);
    renderer.setRenderTarget(null);
    renderer
      .readRenderTargetPixelsAsync(this.rt, 0, 0, RT, RT)
      .then((raw) => {
        this.reading = false;
        // The target is RGBA8, so the readback is bytes; the renderer's return
        // type is broad only because other texture formats exist.
        const rgba = raw as Uint8Array;
        // The background is measured, not assumed: the corners of the target
        // are always void (the crown is centred), whatever colour the pipeline
        // wrote them in.
        const bg = cornerBackground(rgba, RT, RT);
        if (this.bottomUp === null) {
          // Calibrate the row order once: the camera aims at the apex, so the
          // crown's mass hangs clearly below the image's middle. Which side of
          // the buffer's halfway its centroid lands on names the row order; an
          // ambiguous frame waits for a cleaner one.
          const c = maskCentroid(rgba, RT, RT, bg);
          if (c && Math.abs(c.v - RT / 2) >= 8) this.bottomUp = c.v < RT / 2;
        }
        if (this.bottomUp === null) {
          this.dropped++;
          return;
        }
        // The mask cuts at 40 rather than the default 24: the crown's shimmer
        // (a ±7 % brightness ripple riding the flutter) can flicker mask edge
        // pixels at a tighter threshold, and the apex band is only a few pixels
        // wide. The crown itself is over 100 units from the void.
        const tip = trackTip(rgba, RT, RT, bg, {
          flipY: this.bottomUp,
          threshold: 40,
          band: 3,
        });
        if (!tip) {
          this.dropped++;
          return;
        }
        this.frames.push({ t: time, strength, u: tip.u, v: tip.v });
        if (this.frames.length > FRAMES_CAP) this.frames.shift();
      })
      .catch(() => {
        this.reading = false;
        this.dropped++;
      });
  }

  /** Project a world point into the readback target's pixels (u right, v down). */
  project(x: number, y: number, z: number): { u: number; v: number } {
    // The cameras never move after construction, but `project` must not rely
    // on a renderer having refreshed the matrices (the node tests never render).
    this.probeCamera.updateMatrixWorld();
    const p = new Vector3(x, y, z).project(this.probeCamera);
    return { u: ((p.x + 1) / 2) * RT, v: ((1 - p.y) / 2) * RT };
  }

  /**
   * Where the spec says the apex sits at wind time `t` — `swayOffset` (the
   * wind's whole spec, the same module the shader mirrors) applied to the
   * witness apex and projected. This is the prediction the law grades the
   * readings against; it runs the spec's own code, on purpose.
   */
  predictTip(t: number): { u: number; v: number } {
    const o = swayOffset(t, this.cloud, this.apex.x, this.apex.z, this.flexTip);
    return this.project(this.apex.x + o[0], this.apex.y, this.apex.z + o[1]);
  }

  /** The instrument's state for `__otherhere.forestDemo`. */
  readout() {
    return {
      witness: {
        ...this.witness,
        flexTip: this.flexTip,
        apex: { x: this.apex.x, y: this.apex.y, z: this.apex.z },
      },
      cloud: this.cloud,
      frozen: this.frozen,
      ready: this.forest.settled(),
      trees: this.forest.stats().trees,
      wind: this.forest.wind(),
      dropped: this.dropped,
      bottomUp: this.bottomUp,
      frames: this.frames,
      project: (x: number, y: number, z: number) => this.project(x, y, z),
      predictTip: (t: number) => this.predictTip(t),
    };
  }

  dispose(): void {
    this.forest.dispose();
    this.rt.dispose();
    this.scene.clear();
  }
}
