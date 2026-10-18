import {
  cellToBoundary,
  cellToChildren,
  cellToLatLng,
  cellToParent,
  getResolution,
  gridDisk,
  isValidCell,
  latLngToCell,
} from 'h3-js';

export type LatLng = { lat: number; lng: number };
export type BBox = { south: number; west: number; north: number; east: number };

/** A Cell is an H3 res-9 cell (ADR-0001). */
export const CELL_RES = 9;
/** A Town is the res-6 parent of a Cell, owned by one TownDO (ADR-0002). */
export const TOWN_RES = 6;
/** OSM is fetched per res-8 block (7 Cells) to keep Overpass requests few (ADR-0010). */
export const INGEST_RES = 8;

// h3-js uses engine trig internally, so its outputs can differ in the last bit
// across engines. Anything that feeds geometry is snapped to 1e-7° (~1 cm).
const snap = (x: number) => Math.round(x * 1e7) / 1e7;

export function cellAt(lat: number, lng: number): string {
  return latLngToCell(lat, lng, CELL_RES);
}

export function isCell(id: string): boolean {
  return isValidCell(id) && getResolution(id) === CELL_RES;
}

export function townOf(cell: string): string {
  return cellToParent(cell, TOWN_RES);
}

export function ingestBlockOf(cell: string): string {
  return cellToParent(cell, INGEST_RES);
}

export function cellsOfBlock(block: string): string[] {
  return cellToChildren(block, CELL_RES).sort();
}

export function cellCenter(cell: string): LatLng {
  const [lat, lng] = cellToLatLng(cell);
  return { lat: snap(lat), lng: snap(lng) };
}

export function cellBoundary(cell: string): LatLng[] {
  return cellToBoundary(cell).map(([lat, lng]) => ({ lat: snap(lat), lng: snap(lng) }));
}

/** The Cell first, then its k-ring neighbours in sorted order. */
export function cellRing(cell: string, k: number): string[] {
  return [
    cell,
    ...gridDisk(cell, k)
      .filter((c) => c !== cell)
      .sort(),
  ];
}

export function blockBBox(block: string): BBox {
  // The children of an H3 cell slightly overhang the parent's boundary, so use theirs.
  const pts = cellsOfBlock(block).flatMap(cellBoundary);
  return {
    south: Math.min(...pts.map((p) => p.lat)),
    north: Math.max(...pts.map((p) => p.lat)),
    west: Math.min(...pts.map((p) => p.lng)),
    east: Math.max(...pts.map((p) => p.lng)),
  };
}
