import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, color, float, luminance, mix, smoothstep, vec3 } from 'three/tsl';

/** The colour of the unknown: what an unseen place looks like before it sharpens. */
export const PAPER = '#ddd6c6';

/**
 * "Soft until sure". Each vertex carries `_confidence` = (shape, colour):
 * - low colour confidence washes the colour toward a pale, paper-tinted version;
 * - low shape confidence lifts the surface toward paper and flattens its
 *   shading (a haze), so imagined buildings read as a pencil sketch;
 * - high confidence keeps full colour and full light-and-shade contrast.
 * Everything stays opaque, so there is no sorting or dithering noise.
 */
export function confidenceMaterial(): MeshStandardNodeMaterial {
  const conf = attribute('_confidence', 'vec2');
  const colourSure = smoothstep(0.2, 0.7, conf.y);
  const shapeSure = smoothstep(0.15, 0.7, conf.x);

  const base = attribute('color', 'vec4').rgb;
  const paper = color(PAPER);
  const washed = mix(paper, mix(vec3(luminance(base)), base, 0.65), 0.7);
  const coloured = mix(washed, base, colourSure);

  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  m.colorNode = mix(paper, coloured, mix(float(0.6), float(1), shapeSure));
  // Haze: unsure surfaces glow faintly with paper, which flattens their shading.
  m.emissiveNode = paper.mul(float(1).sub(shapeSure).mul(0.32));
  m.name = 'soft-until-sure';
  return m;
}
