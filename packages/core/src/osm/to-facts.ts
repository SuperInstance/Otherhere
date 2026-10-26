import { cellAt, ingestBlockOf } from '../geo/h3';
import { localFrame } from '../geo/frame';
import { centroid } from '../geometry/polygon';
import { snapped, speciesFromTags, SPECIES_CONFIDENCE } from '../forest/species';
import type { Fact, LngLat, RoofShape } from '../schema/fact';
import type { Feature, FeatureKind } from '../schema/feature';
import type { OverpassElement, OverpassResponse } from './overpass';

/** How much we trust each kind of OSM tag. */
export const OSM_CONFIDENCE = {
  geometry: 0.7,
  height: 0.8,
  levels: 0.6,
  roofShape: 0.7,
  colour: 0.6,
  type: 0.9,
  species: SPECIES_CONFIDENCE,
} as const;

const ROOF_SHAPES: Record<string, RoofShape> = {
  flat: 'flat',
  gabled: 'gable',
  gable: 'gable',
  gambrel: 'gable',
  saltbox: 'gable',
  hipped: 'hip',
  hip: 'hip',
  'half-hipped': 'hip',
  pyramidal: 'hip',
  mansard: 'hip',
  skillion: 'shed',
  shed: 'shed',
  lean_to: 'shed',
};

const NAMED_COLOURS: Record<string, string> = {
  white: '#f2f0ea',
  black: '#2b2b2b',
  grey: '#9a9a9a',
  gray: '#9a9a9a',
  silver: '#c0c0c0',
  red: '#b5443b',
  maroon: '#7a2e2a',
  brown: '#7a5a43',
  beige: '#e3d5b8',
  cream: '#efe4c8',
  yellow: '#e6c75a',
  orange: '#d98a3d',
  green: '#6f9a52',
  darkgreen: '#3f6b3a',
  blue: '#4f6fa3',
  lightblue: '#a9c3db',
  pink: '#e2a9b5',
  tan: '#d2b48c',
  sand: '#d9c39a',
};

/** "12", "12 m", "12.5m" → metres. Feet and other units are ignored. */
export function parseMetres(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m)?\s*$/.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  return v > 0 && v <= 1000 ? v : undefined;
}

export function parseColour(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  return NAMED_COLOURS[t];
}

/** Landcover polygons we ingest as areas the forest can be imagined into. */
const LANDCOVER: Record<string, string> = {
  forest: 'forest', // landuse=forest
  wood: 'forest', // natural=wood
  scrub: 'scrub', // natural=scrub
  meadow: 'meadow', // landuse=meadow (open: no imagined trees)
};

const PROP_KINDS: [string, string, FeatureKind][] = [
  ['natural', 'tree', 'tree'],
  ['amenity', 'bench', 'bench'],
  ['highway', 'street_lamp', 'streetlight'],
];
// Highways that are not drawable paths.
const SKIP_HIGHWAYS = new Set([
  'proposed',
  'construction',
  'abandoned',
  'platform',
  'street_lamp',
  'bus_stop',
]);

export type IngestResult = { features: Feature[]; facts: Fact[] };

/**
 * Join unordered way segments into closed rings by matching endpoints
 * (multipolygon outers arrive as separate ways in no useful order, some
 * reversed). Deterministic: segments are sorted before stitching and joins
 * are taken in that fixed order, so a relation always yields the same rings
 * in the same order however Overpass ordered its members. Open chains —
 * outers we cannot close — are dropped: an area we cannot close is not an
 * area we know.
 */
export function stitchRings(paths: LngLat[][]): LngLat[][] {
  const same = (a: LngLat, b: LngLat) => a[0] === b[0] && a[1] === b[1];
  const pool = paths
    .filter((p) => p.length >= 2)
    .map((p) => [...p])
    .sort((a, b) => {
      const ka = JSON.stringify(a);
      const kb = JSON.stringify(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const rings: LngLat[][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i]!;
        const head = cur[0]!;
        const tail = cur[cur.length - 1]!;
        const sHead = s[0]!;
        const sTail = s[s.length - 1]!;
        if (same(tail, sHead)) cur = [...cur, ...s.slice(1)];
        else if (same(tail, sTail)) cur = [...cur, ...[...s].reverse().slice(1)];
        else if (same(head, sTail)) cur = [...s.slice(0, -1), ...cur];
        else if (same(head, sHead)) cur = [...[...s].reverse().slice(0, -1), ...cur];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur.length >= 4 && same(cur[0]!, cur[cur.length - 1]!)) rings.push(cur);
  }
  return rings;
}

/**
 * Convert an Overpass response into Features and Facts with `source: "osm"`
 * (invariant 4). Only Features anchored inside `block` are kept (ADR-0010).
 */
export function osmToFacts(
  res: OverpassResponse,
  opts: { block: string; observedAt: string },
): IngestResult {
  const features = new Map<string, Feature>();
  const facts: Fact[] = [];
  const add = (featureId: string, attribute: string, value: unknown, confidence: number) => {
    if (value === undefined) return;
    facts.push({
      featureId,
      attribute,
      value: value as Fact['value'],
      source: 'osm',
      confidence,
      observedAt: opts.observedAt,
      version: 1,
    });
  };
  const anchor = (id: string, kind: FeatureKind, lat: number, lng: number): boolean => {
    const cell = cellAt(lat, lng);
    if (ingestBlockOf(cell) !== opts.block) return false;
    features.set(id, { id, kind, anchorCell: cell });
    return true;
  };

  for (const el of res.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node') {
      const prop = PROP_KINDS.find(([k, v]) => tags[k] === v);
      if (!prop) continue;
      const id = `osm:n${el.id}`;
      if (!anchor(id, prop[2], el.lat, el.lon)) continue;
      add(id, 'position', [el.lon, el.lat] satisfies LngLat, OSM_CONFIDENCE.geometry);
      add(id, 'height', parseMetres(tags.height), OSM_CONFIDENCE.height);
      add(id, 'species', speciesFromTags(tags), OSM_CONFIDENCE.species);
      add(id, 'osm.tags', tags, 1);
    } else if (el.type === 'way' && el.geometry?.length) {
      const cover = LANDCOVER[tags.landuse ?? ''] ?? LANDCOVER[tags.natural ?? ''];
      if (tags.building && tags.building !== 'no') ingestBuilding(el, tags);
      else if (cover) ingestLandcover(el, tags, cover);
      else if (tags.highway && !SKIP_HIGHWAYS.has(tags.highway) && tags.area !== 'yes')
        ingestRoad(el, tags);
    } else if (el.type === 'relation') {
      const cover = LANDCOVER[tags.landuse ?? ''] ?? LANDCOVER[tags.natural ?? ''];
      if (cover) ingestLandcoverRelation(el, tags, cover);
    }
  }

  /** A landcover multipolygon relation: its outer member ways, stitched into
   *  rings, become one landcover Feature per ring. Inner rings (clearings,
   *  lakes) are not representable in a single-ring footprint yet, so they
   *  are skipped — the forest they would have excluded is a known over-claim,
   *  bounded by the clearing's size. The first ring keeps the bare relation
   *  id; later rings take `:o<k>` suffixes in stitch order. */
  function ingestLandcoverRelation(
    el: Extract<OverpassElement, { type: 'relation' }>,
    tags: Record<string, string>,
    cover: string,
  ) {
    const outers: LngLat[][] = [];
    for (const m of el.members ?? []) {
      if (m.type !== 'way' || (m.role !== 'outer' && m.role !== '') || !m.geometry?.length)
        continue;
      const path = m.geometry.map((g) => snapped({ lat: g.lat, lng: g.lon }));
      if (path.length >= 2) outers.push(path);
    }
    const rings = stitchRings(outers);
    rings.forEach((ring, i) => {
      const frame = localFrame({ lat: ring[0]![1], lng: ring[0]![0] });
      const c = frame.unproject(centroid(ring.map((p) => frame.project({ lat: p[1], lng: p[0] }))));
      const id = i === 0 ? `osm:r${el.id}` : `osm:r${el.id}:o${i + 1}`;
      if (!anchor(id, 'landcover', c.lat, c.lng)) return;
      add(id, 'footprint', ring, OSM_CONFIDENCE.geometry);
      add(id, 'landcover', cover, OSM_CONFIDENCE.type);
      add(id, 'name', tags.name, OSM_CONFIDENCE.type);
      add(id, 'osm.tags', tags, 1);
    });
  }

  /** A landcover polygon: an observed area, never drawn directly, that the
   *  imagined forest grows inside (and meadows keep open). */
  function ingestLandcover(
    el: Extract<OverpassElement, { type: 'way' }>,
    tags: Record<string, string>,
    cover: string,
  ) {
    const ring: LngLat[] = el.geometry.map((g) => snapped({ lat: g.lat, lng: g.lon }));
    if (ring.length < 4) return; // closed rings repeat the first node
    const frame = localFrame({ lat: el.geometry[0]!.lat, lng: el.geometry[0]!.lon });
    const c = frame.unproject(
      centroid(el.geometry.map((g) => frame.project({ lat: g.lat, lng: g.lon }))),
    );
    const id = `osm:w${el.id}`;
    if (!anchor(id, 'landcover', c.lat, c.lng)) return;
    add(id, 'footprint', ring, OSM_CONFIDENCE.geometry);
    add(id, 'landcover', cover, OSM_CONFIDENCE.type);
    add(id, 'name', tags.name, OSM_CONFIDENCE.type);
    add(id, 'osm.tags', tags, 1);
  }

  function ingestBuilding(
    el: Extract<OverpassElement, { type: 'way' }>,
    tags: Record<string, string>,
  ) {
    const ring: LngLat[] = el.geometry.map((g) => [g.lon, g.lat]);
    if (ring.length < 4) return; // closed rings repeat the first node
    const first = el.geometry[0]!;
    const frame = localFrame({ lat: first.lat, lng: first.lon });
    const c = frame.unproject(
      centroid(el.geometry.map((g) => frame.project({ lat: g.lat, lng: g.lon }))),
    );
    const id = `osm:w${el.id}`;
    if (!anchor(id, 'building', c.lat, c.lng)) return;
    add(id, 'footprint', ring, OSM_CONFIDENCE.geometry);
    add(id, 'building', tags.building, OSM_CONFIDENCE.type);
    add(id, 'height', parseMetres(tags.height), OSM_CONFIDENCE.height);
    add(id, 'minHeight', parseMetres(tags.min_height), OSM_CONFIDENCE.height);
    const levels = Number(tags['building:levels']);
    if (Number.isFinite(levels) && levels >= 1 && levels <= 300)
      add(id, 'levels', Math.round(levels), OSM_CONFIDENCE.levels);
    add(id, 'roof.shape', ROOF_SHAPES[tags['roof:shape'] ?? ''], OSM_CONFIDENCE.roofShape);
    add(id, 'roof.height', parseMetres(tags['roof:height']), OSM_CONFIDENCE.height);
    add(id, 'colour', parseColour(tags['building:colour'] ?? tags.colour), OSM_CONFIDENCE.colour);
    add(id, 'roof.colour', parseColour(tags['roof:colour']), OSM_CONFIDENCE.colour);
    add(id, 'name', tags.name, OSM_CONFIDENCE.type);
    add(id, 'osm.tags', tags, 1);
  }

  function ingestRoad(el: Extract<OverpassElement, { type: 'way' }>, tags: Record<string, string>) {
    // Split into node-to-node segments, each anchored by its midpoint (ADR-0003).
    for (let i = 0; i + 1 < el.geometry.length; i++) {
      const a = el.geometry[i]!;
      const b = el.geometry[i + 1]!;
      const na = el.nodes[i];
      const nb = el.nodes[i + 1];
      if (na === undefined || nb === undefined || na === nb) continue;
      const id = `osm:w${el.id}:n${na}-n${nb}`;
      if (!anchor(id, 'road', (a.lat + b.lat) / 2, (a.lon + b.lon) / 2)) continue;
      add(
        id,
        'path',
        [
          [a.lon, a.lat],
          [b.lon, b.lat],
        ] satisfies LngLat[],
        OSM_CONFIDENCE.geometry,
      );
      add(id, 'highway', tags.highway, OSM_CONFIDENCE.type);
      add(id, 'width', parseMetres(tags.width), OSM_CONFIDENCE.height);
      add(id, 'name', tags.name, OSM_CONFIDENCE.type);
    }
  }

  return { features: [...features.values()], facts };
}
