import { describe, expect, it } from 'vitest';
import {
  CELL_RES,
  TOWN_RES,
  cellAt,
  cellCenter,
  cellRing,
  townOf,
  ingestBlockOf,
  cellsOfBlock,
  blockBBox,
  isCell,
} from '../src/geo/h3';
import { localFrame } from '../src/geo/frame';

const ZURICH = { lat: 47.3769, lng: 8.5417 };

describe('H3 helpers', () => {
  it('maps lat/lng to a res-9 Cell and its res-6 Town (ADR-0001, ADR-0002)', () => {
    const cell = cellAt(ZURICH.lat, ZURICH.lng);
    expect(isCell(cell)).toBe(true);
    expect(CELL_RES).toBe(9);
    expect(TOWN_RES).toBe(6);
    expect(townOf(cell)).toMatch(/^86/);
    expect(isCell(townOf(cell))).toBe(false);
  });

  it('quantizes cell centers to 1e-7 degrees so the frame origin is engine-independent', () => {
    const c = cellCenter(cellAt(ZURICH.lat, ZURICH.lng));
    expect(Math.round(c.lat * 1e7) / 1e7).toBe(c.lat);
    expect(Math.round(c.lng * 1e7) / 1e7).toBe(c.lng);
  });

  it('returns the cell plus its ring', () => {
    const cell = cellAt(ZURICH.lat, ZURICH.lng);
    const ring = cellRing(cell, 1);
    expect(ring).toHaveLength(7);
    expect(ring[0]).toBe(cell);
  });

  it('an ingest block (res 8) contains its 7 Cells and a bbox covering them', () => {
    const cell = cellAt(ZURICH.lat, ZURICH.lng);
    const block = ingestBlockOf(cell);
    const cells = cellsOfBlock(block);
    expect(cells).toHaveLength(7);
    expect(cells).toContain(cell);
    const bb = blockBBox(block);
    for (const c of cells) {
      const { lat, lng } = cellCenter(c);
      expect(lat > bb.south && lat < bb.north && lng > bb.west && lng < bb.east).toBe(true);
    }
  });
});

describe('localFrame', () => {
  it('projects to metres east/north and back', () => {
    const f = localFrame(ZURICH);
    const p = f.project({ lat: ZURICH.lat + 0.001, lng: ZURICH.lng + 0.001 });
    expect(p.n).toBeCloseTo(111.19, 1);
    expect(p.e).toBeCloseTo(75.31, 1);
    const back = f.unproject(p);
    expect(back.lat).toBeCloseTo(ZURICH.lat + 0.001, 12);
    expect(back.lng).toBeCloseTo(ZURICH.lng + 0.001, 12);
  });
});
