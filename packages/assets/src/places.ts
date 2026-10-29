/**
 * The place files' own record of what the renderer may fetch.
 *
 * A capture that came out of the capture pipeline has a sidecar and a receipt
 * per tier: the pipeline says what it made, and the receipt says what each
 * payload's hash is. A capture that was *baked into a place* — the client's
 * `public/places/assets/` tree, beside the place file that names it — has no
 * sidecar: the recipe and the scorecard were never published with it.
 *
 * But the place file is still a record. It names every tier, that tier's
 * sha256 and that tier's byte count, and the payload sits beside it on disk.
 * That is content-addressed in exactly the way a receipt is, so this module
 * accepts it as one: the service will serve a baked payload only when a place
 * file says what its hash is and the bytes on disk match that hash.
 *
 * The rule is unchanged — **never serve an unverified payload**. Only the
 * source of the record differs: a pipeline receipt, or a place file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, type TierName } from './registry';

/** A tier record a place file carries. */
export type PlaceTierRef = {
  path?: string;
  hash?: string;
  bytes?: number;
  contentType?: string;
};

/** An asset reference a place file carries: the family, the version, the tiers. */
export type PlaceAssetRef = {
  family?: string;
  version?: string;
  tiers?: Record<string, PlaceTierRef>;
};

/** A payload the service may serve, and the record that vouches for it. */
export type PlaceAssetFile = {
  tier: string;
  absolute: string;
  hash: string;
  bytes: number;
  contentType: string;
  /** The place file that vouches for this payload. */
  place: string;
};

export type PlaceAssets = {
  /** The verified payloads, keyed by the path the renderer asks for. */
  files: Map<string, PlaceAssetFile>;
  /** Every refusal and every complaint, in the order they were found. */
  problems: { place: string; reason: string }[];
};

/** The content types the service serves a tier as, by the client's tier name. */
const TIER_CONTENT_TYPES: Record<string, string> = {
  splat: 'model/gaussian-splat',
  impostor: 'image/webp',
  card: 'image/webp',
};

const isAssetRef = (value: unknown): value is PlaceAssetRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PlaceAssetRef).tiers === 'object' &&
  (value as PlaceAssetRef).tiers !== null;

/** Find every asset reference in a parsed place file. */
function findAssetRefs(node: unknown, found: PlaceAssetRef[] = []): PlaceAssetRef[] {
  if (Array.isArray(node)) {
    for (const item of node) findAssetRefs(item, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;
  const obj = node as Record<string, unknown>;
  if (isAssetRef(obj)) {
    found.push(obj);
    // A reference's own tiers hold only tier records, but keep walking: a
    // place may nest references inside a reference's params.
  }
  for (const value of Object.values(obj)) findAssetRefs(value, found);
  return found;
}

/**
 * Read the place files in a directory and verify every asset payload they name.
 *
 * The directory is the one the client serves `places/` from: it holds the
 * place files themselves and the `assets/` tree beside them. The place files
 * are read, never served — this service serves the payloads they vouched for.
 */
export function readPlaceAssets(placesDir: string): PlaceAssets {
  const assets: PlaceAssets = { files: new Map(), problems: [] };

  let entries: string[];
  try {
    entries = readdirSync(placesDir);
  } catch {
    assets.problems.push({ place: placesDir, reason: 'cannot read the places directory' });
    return assets;
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const placePath = join(placesDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(placePath, 'utf8'));
    } catch (err) {
      assets.problems.push({
        place: name,
        reason: `unreadable place file: ${(err as Error).message}`,
      });
      continue;
    }

    for (const ref of findAssetRefs(parsed)) {
      const family = ref.family ?? 'unknown';
      const version = ref.version ?? '0.0.0';
      for (const [tierName, tier] of Object.entries(ref.tiers ?? {})) {
        if (!tier.path || !tier.hash) {
          assets.problems.push({
            place: name,
            reason: `${family}/${version} ${tierName}: the place file names no path or hash`,
          });
          continue;
        }
        const absolute = join(placesDir, tier.path);
        let bytes: Buffer;
        try {
          bytes = readFileSync(absolute);
        } catch {
          assets.problems.push({
            place: name,
            reason: `${family}/${version} ${tierName}: payload missing at ${absolute}`,
          });
          continue;
        }
        const actualHash = sha256(bytes);
        if (actualHash !== tier.hash) {
          assets.problems.push({
            place: name,
            reason: `${family}/${version} ${tierName}: ${absolute} hashes ${actualHash.slice(0, 12)}…, the place file says ${tier.hash.slice(0, 12)}…`,
          });
          continue;
        }
        if (tier.bytes !== undefined && bytes.byteLength !== tier.bytes) {
          assets.problems.push({
            place: name,
            reason: `${family}/${version} ${tierName}: ${absolute} is ${bytes.byteLength} bytes, the place file says ${tier.bytes}`,
          });
          continue;
        }
        // The first record to vouch for a path wins; a later place that names
        // the same path with the same hash is the same payload, and one that
        // names it differently is a problem, not an override.
        const seen = assets.files.get(tier.path);
        if (seen && seen.hash !== actualHash) {
          assets.problems.push({
            place: name,
            reason: `${tier.path}: two places vouch for different bytes`,
          });
          continue;
        }
        if (seen) continue;
        assets.files.set(tier.path, {
          tier: tierName,
          absolute,
          hash: actualHash,
          bytes: bytes.byteLength,
          contentType:
            TIER_CONTENT_TYPES[tierName as TierName] ??
            tier.contentType ??
            'application/octet-stream',
          place: name,
        });
      }
    }
  }

  return assets;
}
