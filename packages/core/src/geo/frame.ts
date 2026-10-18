import { DEG, detCos } from '../math/det';
import type { LatLng } from './h3';

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS = 6371008.8;

export type EN = { e: number; n: number };

export type LocalFrame = {
  origin: LatLng;
  project(p: LatLng): EN;
  unproject(p: EN): LatLng;
};

/**
 * A local east/north metric frame around `origin` (equirectangular). Accurate
 * to well under a centimetre across a Cell, and deterministic (ADR-0006).
 */
export function localFrame(origin: LatLng): LocalFrame {
  const mPerDegLat = DEG * EARTH_RADIUS;
  const mPerDegLng = mPerDegLat * detCos(origin.lat * DEG);
  return {
    origin,
    project: (p) => ({
      e: (p.lng - origin.lng) * mPerDegLng,
      n: (p.lat - origin.lat) * mPerDegLat,
    }),
    unproject: (p) => ({
      lat: origin.lat + p.n / mPerDegLat,
      lng: origin.lng + p.e / mPerDegLng,
    }),
  };
}
