import { canonicalJson } from '../hash/canonical';
import type { MeshData } from '../geometry/mesh';

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

const pad4 = (n: number) => (n + 3) & ~3;

// glTF is little-endian and we copy typed-array bytes directly.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Write a single-mesh GLB (glTF 2.0 binary). Output bytes are a pure function
 * of the inputs: the JSON chunk is canonical and the binary chunk is laid out
 * in a fixed order (invariant 2).
 *
 * Attributes: POSITION, NORMAL, COLOR_0 (linear RGBA16 normalised), and the custom
 * `_CONFIDENCE` (VEC2 float: shape, colour) that drives "soft until sure".
 */
export function writeGlb(
  mesh: MeshData,
  opts: { name: string; generator: string; extras?: unknown },
): Uint8Array {
  if (!LITTLE_ENDIAN) throw new Error('writeGlb: big-endian platforms are not supported');
  const vertexCount = mesh.positions.length / 3;
  const parts: { bytes: Uint8Array; target: number }[] = [
    {
      bytes: new Uint8Array(
        mesh.positions.buffer,
        mesh.positions.byteOffset,
        mesh.positions.byteLength,
      ),
      target: ARRAY_BUFFER,
    },
    {
      bytes: new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength),
      target: ARRAY_BUFFER,
    },
    {
      bytes: new Uint8Array(mesh.colours.buffer, mesh.colours.byteOffset, mesh.colours.byteLength),
      target: ARRAY_BUFFER,
    },
    {
      bytes: new Uint8Array(
        mesh.confidence.buffer,
        mesh.confidence.byteOffset,
        mesh.confidence.byteLength,
      ),
      target: ARRAY_BUFFER,
    },
    {
      bytes: new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
      target: ELEMENT_ARRAY_BUFFER,
    },
  ];

  const bufferViews: object[] = [];
  let offset = 0;
  for (const p of parts) {
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: p.bytes.byteLength,
      target: p.target,
    });
    offset = pad4(offset + p.bytes.byteLength);
  }
  const binLength = offset;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const a = i % 3;
    const v = mesh.positions[i]!;
    if (v < min[a]!) min[a] = v;
    if (v > max[a]!) max[a] = v;
  }
  const hasVerts = vertexCount > 0;

  const json = {
    asset: { version: '2.0', generator: opts.generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: opts.name }],
    materials: [
      {
        name: 'otherhere',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    meshes: [
      {
        name: opts.name,
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, _CONFIDENCE: 3 },
            indices: 4,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: FLOAT,
        count: vertexCount,
        type: 'VEC3',
        min: hasVerts ? min : [0, 0, 0],
        max: hasVerts ? max : [0, 0, 0],
      },
      { bufferView: 1, componentType: FLOAT, count: vertexCount, type: 'VEC3' },
      {
        bufferView: 2,
        componentType: UNSIGNED_SHORT,
        normalized: true,
        count: vertexCount,
        type: 'VEC4',
      },
      { bufferView: 3, componentType: FLOAT, count: vertexCount, type: 'VEC2' },
      { bufferView: 4, componentType: UNSIGNED_INT, count: mesh.indices.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: binLength }],
    ...(opts.extras !== undefined ? { extras: opts.extras } : {}),
  };

  const jsonBytes = new TextEncoder().encode(canonicalJson(json));
  const jsonLength = pad4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength); // pad JSON with spaces
  let o = 20 + jsonLength;
  dv.setUint32(o, binLength, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  o += 8;
  for (let i = 0; i < parts.length; i++) {
    const view = bufferViews[i] as { byteOffset: number };
    out.set(parts[i]!.bytes, o + view.byteOffset);
  }
  return out;
}

/** Read the JSON chunk back out of a GLB (for tests and tooling). */
export function readGlbJson(glb: Uint8Array): Record<string, unknown> {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len))) as Record<
    string,
    unknown
  >;
}
