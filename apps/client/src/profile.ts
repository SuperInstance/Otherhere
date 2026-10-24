/**
 * Display profiles: how much world this screen should draw.
 *
 * The full profile is the game as designed for a desktop GPU. The lite
 * profile is the same game — same Facts, same Bundles, same hashes —
 * tuned for a phone: fewer pixels per frame, no antialiasing, a sparser
 * and nearer display forest, and coarser terrain tiles (fewer bytes to
 * fetch and decode on a mobile connection). Everything a profile touches
 * is display-only (ADR-0016): it never reaches a Bundle, so a lite phone
 * and a full desktop verify the same town byte for byte.
 *
 * Resolution: an explicit `?lite=1` / `?lite=0` (or `?profile=lite|full`)
 * in the link wins; otherwise the build's default (the GitHub Pages
 * /mobile/ build is baked lite); otherwise full.
 */
export interface Profile {
  lite: boolean;
  /** Cap on the renderer's pixel ratio: the single biggest GPU lever on a phone. */
  pixelRatioCap: number;
  antialias: boolean;
  /** Multiplier on the display forest's density (1 = every tree the law allows). */
  forestDensity: number;
  /** Forest planting radius in metres, or null for the Forest default. */
  forestRadius: number | null;
  /** Forest instance budget, or null for the Forest default. */
  forestMaxTrees: number | null;
  /** Finest terrain tile zoom, or null for the Terrain default. */
  terrainMaxZ: number | null;
  /** Terrain tile budget, or null for the Terrain default. */
  terrainMaxTiles: number | null;
}

export const FULL_PROFILE: Profile = {
  lite: false,
  pixelRatioCap: 2,
  antialias: true,
  forestDensity: 1,
  forestRadius: null,
  forestMaxTrees: null,
  terrainMaxZ: null,
  terrainMaxTiles: null,
};

export const LITE_PROFILE: Profile = {
  lite: true,
  pixelRatioCap: 1.5,
  antialias: false,
  forestDensity: 0.6,
  forestRadius: 700,
  forestMaxTrees: 6000,
  terrainMaxZ: 14,
  terrainMaxTiles: 96,
};

export function resolveProfile(search: string, buildProfile?: string): Profile {
  const p = new URLSearchParams(search);
  const q = p.get('lite') ?? p.get('profile');
  if (q === '1' || q === 'lite') return LITE_PROFILE;
  if (q === '0' || q === 'full') return FULL_PROFILE;
  return buildProfile === 'lite' ? LITE_PROFILE : FULL_PROFILE;
}
