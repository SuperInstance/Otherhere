import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, color, float, luminance, mix, smoothstep, uniform, vec3 } from 'three/tsl';

/** A wake factor uniform (0 = paper, 1 = fully arrived), animated by the World. */
export type WakeUniform = ReturnType<typeof uniform>;

/** The colour of the unknown: what an unseen place looks like before it sharpens. */
export const PAPER = '#ddd6c6';
/** How long a replaced Bundle takes to breathe from paper to its true state (ms). */
export const WAKE_MS = 1600;

/**
 * "Soft until sure". Each vertex carries `_confidence` = (shape, colour):
 * - low colour confidence washes the colour toward a pale, paper-tinted version;
 * - low shape confidence lifts the surface toward paper and flattens its
 *   shading (a haze), so imagined buildings read as a pencil sketch;
 * - high confidence keeps full colour and full light-and-shade contrast.
 * Everything stays opaque, so there is no sorting or dithering noise.
 *
 * With `wake` (0 → 1, animated by the World): the material starts entirely
 * paper — the sketch look — and breathes to the formula above. THE WAKE-UP
 * MOMENT (enjoyability r1 item 3): when new knowledge replaces old (a capture
 * landing, OpenStreetMap arriving for a sketch Cell), the world must be FELT
 * to sharpen, not silently swap. Display layer only: same geometry, same
 * Bundle, one uniform.
 */
export function confidenceMaterial(wake?: WakeUniform): MeshStandardNodeMaterial {
  const conf = attribute('_confidence', 'vec2');
  // The colour wash was retuned 2026-10-25 (the Sitka skin remake): at the
  // old curve an imagined colour (confidence 0.25) kept ~3% of itself, so a
  // whole imagined town rendered as one cream — the soft-until-sure language
  // was drowning the very colours the region priors and material studies
  // exist to give it. The first retune (0.04–0.46, paper 0.48) still landed
  // timid under the full grade stack — measured on the postcard pair, hue
  // shifts of only ~5–10 RGB points where the albedos promise 30+ — so the
  // curve now gives imagined colour ~0.78 of its voice and the washed base
  // keeps more of its hue. A known Fact (0.6+) is essentially full, and only
  // the truly unknown (near 0) sits at paper. Shape confidence keeps its
  // original curve: the sketchiness of imagined FORM was never the problem.
  const colourSure = smoothstep(0.02, 0.34, conf.y);
  const shapeSure = smoothstep(0.15, 0.7, conf.x);

  const base = attribute('color', 'vec4').rgb;
  const paper = color(PAPER);
  const washed = mix(paper, mix(vec3(luminance(base)), base, 0.78), 0.34);
  const coloured = mix(washed, base, colourSure);

  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  // Contact shading: walls darken over their lowest couple of metres, so a building
  // sits on the ground instead of floating (an ambient-occlusion stand-in, one multiply).
  const contact = mix(float(0.62), float(1), smoothstep(0, 2.2, attribute('_lift', 'float')));
  // The shape floor and the haze were retuned with the colour wash
  // (2026-10-25): shape confidence is dragged to 0.25 by any imagined height
  // or roof — nearly every building in a real town — and at the old floor
  // (0.6) plus haze (0.32) that overlaid ~38% warm paper over even a
  // building whose COLOUR is known at 0.9 (the cathedral's livery rendered
  // warm cream). The floor is now 0.78 and the haze 0.18: imagined form
  // still reads soft and sketchy, but it no longer recolours what is known.
  const confident = mix(paper, coloured, mix(float(0.78), float(1), shapeSure)).mul(contact);
  if (wake) {
    // A typed float view of the uniform. The runtime node is the same object;
    // UniformNode's generics simply do not carry TSL's operable methods in
    // this three version, so the checker needs the float-node shape.
    const w = wake as unknown as ReturnType<typeof float>;
    m.colorNode = mix(paper.mul(contact), confident, w);
    // While waking, everything hazes paper (the sketch look), not just the unsure.
    m.emissiveNode = paper.mul(float(1).sub(shapeSure).mul(0.18).add(w.oneMinus().mul(0.32)));
  } else {
    m.colorNode = confident;
    m.emissiveNode = paper.mul(float(1).sub(shapeSure).mul(0.18));
  }
  m.name = wake ? 'soft-until-sure-waking' : 'soft-until-sure';
  return m;
}

/** A fresh wake uniform, starting at paper. */
export const wakeUniform = (): WakeUniform => uniform(0);
