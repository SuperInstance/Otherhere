/**
 * The registry: what the Thor has captured, and where the renderer can fetch it.
 *
 * Doctrine (the same one the foundry states): **the capture is the fact, the payloads are
 * the cache.** A capture is a directory holding `asset.capture.json` — the sidecar with the
 * tier hashes, the recipe, the scorecard and the provenance — plus a `tiers/` directory
 * holding the payloads and one `*.receipt.json` per payload.
 *
 * The renderer never trusts the sidecar blindly: it fetches a tier, checks the byte count
 * and the sha256 against the bundle, and drops the tier if they disagree
 * (`apps/client/src/assets.ts`). This module is the other half of that contract — it is
 * what says *which* tiers exist, *where* they live, and what their hashes are — and it
 * verifies each payload against its receipt **before** the registry will list it, so a
 * corrupt or half-written capture is a refusal rather than a broken scene.
 *
 * The tier names are the client's names. The capture pipeline calls its gaussian field
 * `mesh` (it is the SPZ finalist); the client calls that tier `splat`. The registry
 * translates, once, here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The tiers the client understands, coarsest last-resort first. */
export const TIER_NAMES = ['splat', 'impostor', 'card'] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** The name the capture pipeline uses for the gaussian field. */
const PIPELINE_TIER_ALIASES: Record<string, TierName> = { mesh: 'splat' };

export type TierFile = {
  /** The tier, in the client's vocabulary. */
  tier: TierName;
  /** The file inside the capture's `tiers/` directory. */
  file: string;
  /** Where the renderer fetches it, relative to `places/`. */
  path: string;
  hash: string;
  bytes: number;
  contentType: string;
};

export type CaptureEntry = {
  /** The directory the capture was read from. */
  dir: string;
  family: string;
  version: string;
  contentHash: string;
  kind: string;
  approval: string;
  /** The tiers that are present and verified. */
  tiers: Partial<Record<TierName, TierFile>>;
  /** The sidecar's `params` block: the recipe, the scorecard, the budget. */
  params: unknown;
  provenance: unknown;
};

export type Registry = {
  /** Where the registry was read from. */
  root: string;
  /** Every capture found, newest family first. */
  captures: CaptureEntry[];
  /** The problems found while reading. A capture with a problem is still listed, but flagged. */
  problems: { capture: string; reason: string }[];
};

const CONTENT_TYPES: Record<TierName, string> = {
  splat: 'model/gaussian-splat',
  impostor: 'image/webp',
  card: 'image/webp',
};

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

type Sidecar = {
  family?: string;
  version?: string;
  contentHash?: string;
  kind?: string;
  approval?: string;
  tiers?: Record<string, { hash?: string; bytes?: number }>;
  params?: unknown;
  provenance?: unknown;
};

type Receipt = { file?: string; tier?: string; hash?: string; bytes?: number };

/**
 * Read one capture directory.
 *
 * A capture is only listed with a tier if the payload's bytes and hash match its receipt.
 * A mismatch is reported as a problem and the tier is withheld — the renderer would have
 * dropped it anyway, and serving it would make the failure look like the renderer's.
 */
export function readCapture(dir: string): { entry: CaptureEntry; problems: string[] } {
  const problems: string[] = [];
  const sidecarPath = join(dir, 'asset.capture.json');
  const sidecar = readJson(sidecarPath) as Sidecar;

  const family = sidecar.family ?? 'unknown';
  const version = sidecar.version ?? '0.0.0';
  const entry: CaptureEntry = {
    dir,
    family,
    version,
    contentHash: sidecar.contentHash ?? '',
    kind: sidecar.kind ?? 'distilled',
    approval: sidecar.approval ?? 'draft',
    tiers: {},
    params: sidecar.params ?? null,
    provenance: sidecar.provenance ?? null,
  };

  const tiersDir = join(dir, 'tiers');
  let receipts: Receipt[];
  try {
    receipts = readdirSync(tiersDir)
      .filter((f) => f.endsWith('.receipt.json'))
      .map((f) => readJson(join(tiersDir, f)) as Receipt);
  } catch {
    problems.push(`no tiers directory at ${tiersDir}`);
    return { entry, problems };
  }

  for (const receipt of receipts) {
    if (!receipt.file || !receipt.tier || !receipt.hash) {
      problems.push(`a receipt is missing file/tier/hash: ${JSON.stringify(receipt)}`);
      continue;
    }
    const clientTier = PIPELINE_TIER_ALIASES[receipt.tier] ?? (receipt.tier as TierName);
    if (!TIER_NAMES.includes(clientTier)) {
      problems.push(`unknown tier "${receipt.tier}"`);
      continue;
    }
    const payloadPath = join(tiersDir, receipt.file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(payloadPath);
    } catch {
      problems.push(`${clientTier}: payload missing at ${payloadPath}`);
      continue;
    }
    const actualHash = sha256(bytes);
    if (actualHash !== receipt.hash) {
      problems.push(
        `${clientTier}: ${payloadPath} hashes ${actualHash.slice(0, 12)}…, the receipt says ${receipt.hash.slice(0, 12)}…`,
      );
      continue;
    }
    if (receipt.bytes !== undefined && bytes.byteLength !== receipt.bytes) {
      problems.push(
        `${clientTier}: ${payloadPath} is ${bytes.byteLength} bytes, the receipt says ${receipt.bytes}`,
      );
      continue;
    }
    entry.tiers[clientTier] = {
      tier: clientTier,
      file: receipt.file,
      path: `assets/${family}/${version}/${clientTier}.${clientTier === 'splat' ? 'spz' : 'webp'}`,
      hash: actualHash,
      bytes: bytes.byteLength,
      contentType: CONTENT_TYPES[clientTier],
    };
  }

  // The sidecar's own tier hashes must agree with the receipts, or the capture is
  // describing something other than what is on disk.
  for (const [pipelineTier, declared] of Object.entries(sidecar.tiers ?? {})) {
    const clientTier = PIPELINE_TIER_ALIASES[pipelineTier] ?? (pipelineTier as TierName);
    const found = entry.tiers[clientTier];
    if (!found) continue;
    if (declared.hash && declared.hash !== found.hash) {
      problems.push(
        `${clientTier}: the sidecar and the receipt disagree on the hash (${declared.hash.slice(0, 12)}… vs ${found.hash.slice(0, 12)}…)`,
      );
    }
  }

  return { entry, problems };
}

/**
 * Read every capture under a root.
 *
 * Two layouts are in use, and both are read:
 *   - `<root>/<capture>/asset.capture.json` — the capture pipeline writes one directory
 *     per subject, and the family and version come from the sidecar;
 *   - `<root>/<family>/<version>/asset.capture.json` — the versioned layout, where the
 *     directory names are authoritative.
 */
export function readRegistry(root: string): Registry {
  const registry: Registry = { root, captures: [], problems: [] };
  const isDir = (path: string): boolean => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  const hasSidecar = (dir: string): boolean => {
    try {
      return readdirSync(dir).includes('asset.capture.json');
    } catch {
      return false;
    }
  };

  let families: string[];
  try {
    families = readdirSync(root).filter((name) => isDir(join(root, name)));
  } catch {
    registry.problems.push({ capture: root, reason: 'cannot read the registry root' });
    return registry;
  }

  const visit = (dir: string): void => {
    const { entry, problems } = readCapture(dir);
    registry.captures.push(entry);
    for (const reason of problems) {
      registry.problems.push({ capture: `${entry.family}/${entry.version}`, reason });
    }
  };

  for (const family of families) {
    const familyDir = join(root, family);
    if (hasSidecar(familyDir)) {
      visit(familyDir);
      continue;
    }
    let versions: string[];
    try {
      versions = readdirSync(familyDir).filter((name) => isDir(join(familyDir, name)));
    } catch {
      continue;
    }
    for (const version of versions) {
      const dir = join(familyDir, version);
      if (hasSidecar(dir)) visit(dir);
    }
  }

  registry.captures.sort((a, b) =>
    `${a.family}/${a.version}`.localeCompare(`${b.family}/${b.version}`),
  );
  return registry;
}

/**
 * The manifest the renderer reads: the same shape the client already parses, with the
 * served path, the byte count and the hash for every tier that exists.
 */
export function registryManifest(registry: Registry): {
  format: string;
  captures: {
    family: string;
    version: string;
    contentHash: string;
    kind: string;
    approval: string;
    tiers: { tier: TierName; path: string; hash: string; bytes: number; contentType: string }[];
  }[];
} {
  return {
    format: 'otherhere.capture-registry.v1',
    captures: registry.captures.map((c) => ({
      family: c.family,
      version: c.version,
      contentHash: c.contentHash,
      kind: c.kind,
      approval: c.approval,
      tiers: Object.values(c.tiers).map((t) => ({
        tier: t.tier,
        path: t.path,
        hash: t.hash,
        bytes: t.bytes,
        contentType: t.contentType,
      })),
    })),
  };
}
