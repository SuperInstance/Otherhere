import { ROOF_COLOURS, WALL_COLOURS, type ResolvedAttrs } from '@otherhere/core';

const SOURCE_NAMES: Record<string, string> = {
  osm: 'OpenStreetMap',
  overture: 'Overture',
  satellite_inference: 'satellite',
  street_imagery: 'street imagery',
  capture: 'a photo',
  manual_edit: 'an edit',
};

const COLOUR_NAMES = new Map<string, string>(
  [...Object.entries(WALL_COLOURS), ...Object.entries(ROOF_COLOURS)].map(([name, hex]) => [
    hex,
    name,
  ]),
);
const colourName = (v: unknown) => COLOUR_NAMES.get(String(v)) ?? String(v);

const LABELS: [attr: string, label: string, fmt?: (v: unknown) => string][] = [
  ['building', 'Type'],
  ['height', 'Height', (v) => `${v} m`],
  ['levels', 'Floors'],
  ['roof.shape', 'Roof'],
  ['colour', 'Walls', colourName],
  ['roof.colour', 'Roof colour', colourName],
];

/** What we know about a building, and where each piece came from (invariant 4). */
export function describeFacts(attrs: ResolvedAttrs): string[] {
  const lines: string[] = [];
  for (const [attr, label, fmt] of LABELS) {
    const r = attrs[attr];
    if (!r) continue;
    const value = fmt ? fmt(r.value) : String(r.value);
    lines.push(
      `${label}: ${value} (from ${SOURCE_NAMES[r.source] ?? r.source}, ${Math.round(r.confidence * 100)}% sure)`,
    );
  }
  if (!attrs.height && !attrs.levels) lines.push('Height: imagined');
  if (!attrs['roof.shape']) lines.push('Roof: imagined');
  return lines;
}

/** Downscale a photo on the device before it leaves it: max 1280 px, JPEG. Returns base64. */
export async function photoToJpegBase64(file: File, max = 1280): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.85),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
