import {
  fitForJev,
  ROOF_COLOURS,
  WALL_COLOURS,
  type Quest,
  type ResolvedAttrs,
} from '@otherhere/core';

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

/**
 * How to draw a `width`×`height` source so it leaves the device small (long side at
 * most `max`) and is still a size Jev accepts (every side 280–1568 px): a centred
 * source rectangle and the output size. Only extreme panoramas lose their edges.
 */
export function sendSize(width: number, height: number, max = 1280) {
  const k = Math.min(1, max / Math.max(width, height));
  const f = fitForJev(Math.round(width * k), Math.round(height * k));
  const [sw, sh] = [f.crop.width / k, f.crop.height / k];
  return { sx: (width - sw) / 2, sy: (height - sh) / 2, sw, sh, width: f.width, height: f.height };
}

/** Prepare a photo on the device before it leaves it (see `sendSize`), as base64 JPEG. */
export async function photoToJpegBase64(file: File, max = 1280): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const s = sendSize(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = s.width;
  canvas.height = s.height;
  canvas.getContext('2d')!.drawImage(bitmap, s.sx, s.sy, s.sw, s.sh, 0, 0, s.width, s.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.85),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const ASK_NAMES: Record<string, string> = {
  'roof.shape': 'its roof',
  levels: 'how many floors it has',
  colour: 'its wall colour',
};

/** What a Quest asks for, in a sentence. */
export function questLine(q: Quest): string {
  if (q.reason === 'unsure')
    return 'Quest: the last photo of this building was not clear enough. Take one straight on to settle it.';
  const asks = q.ask.map((a) => ASK_NAMES[a] ?? a);
  const list = asks.length > 1 ? `${asks.slice(0, -1).join(', ')} and ${asks.at(-1)}` : asks[0];
  return `Quest: nobody has told us ${list}. Photograph it to sharpen it.`;
}

/** How many Quests this device has completed (a per-device convenience, not a score anyone else sees). */
export const questsDone = {
  get(): number {
    try {
      return Number(localStorage.getItem('otherhere.questsDone') ?? 0) || 0;
    } catch {
      return 0;
    }
  },
  add(): number {
    const n = this.get() + 1;
    try {
      localStorage.setItem('otherhere.questsDone', String(n));
    } catch {
      // Storage may be unavailable (private mode): the count just won't persist.
    }
    return n;
  },
};
