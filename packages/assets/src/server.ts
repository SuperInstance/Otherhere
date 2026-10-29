/**
 * The door: a service that hands the renderer's asset tiers to it, by hash, on notice.
 *
 * The renderer fetches `places/<path>` for every tier it wants, then checks the byte count
 * and the sha256 against the bundle it already holds (`apps/client/src/assets.ts`). This
 * service is the other end of that: it reads a capture registry off disk, verifies every
 * payload against its receipt, and serves the verified bytes at the path the manifest
 * names.
 *
 * It is deliberately small and dependency-free. It serves files; it does not generate
 * them, it does not transform them, and it never serves a payload it has not verified.
 *
 * Routes:
 *   GET /health                          → {"status":"ok","captures":N,"tiers":N}
 *   GET /places/registry.json            → the manifest
 *   GET /places/assets/<family>/<ver>/<file> → a verified tier payload
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRegistry, registryManifest, type Registry, type TierFile } from './registry';

export type CaptureServiceOptions = {
  /** The registry root: a directory of capture directories. */
  root: string;
  /** Where the payloads live, relative to a capture directory. */
  tiersDir?: string;
  host?: string;
  port?: number;
  /** How often to re-read the registry so a new capture becomes fetchable. 0 disables. */
  rescanMs?: number;
};

export type CaptureService = {
  readonly registry: Registry;
  /** Every verified tier, keyed by the path the renderer asks for. */
  readonly files: Map<string, { file: string; tier: TierFile; absolute: string }>;
  listen: () => Promise<void>;
  close: () => Promise<void>;
  /** The bound address, once listening — null before. */
  address: () => { host: string; port: number } | null;
};

/** Build the index of servable payloads from a registry. */
export function indexTiers(
  registry: Registry,
  tiersDir = 'tiers',
): Map<string, { file: string; tier: TierFile; absolute: string }> {
  const files = new Map<string, { file: string; tier: TierFile; absolute: string }>();
  for (const capture of registry.captures) {
    for (const tier of Object.values(capture.tiers)) {
      const absolute = join(capture.dir, tiersDir, tier.file);
      files.set(tier.path, { file: tier.file, tier, absolute });
    }
  }
  return files;
}

export function createCaptureService(options: CaptureServiceOptions): CaptureService {
  const tiersDir = options.tiersDir ?? 'tiers';
  const state = {
    registry: readRegistry(options.root),
    files: indexTiers(readRegistry(options.root), tiersDir),
  };

  // Generation runs ahead of presence, so a capture can land at any moment. The
  // registry is re-read on a timer rather than only at boot, so a new capture
  // becomes fetchable without restarting anything.
  const rescanMs = options.rescanMs ?? 60_000;
  if (rescanMs > 0) {
    const timer = setInterval(() => {
      const fresh = readRegistry(options.root);
      state.registry = fresh;
      state.files = indexTiers(fresh, tiersDir);
    }, rescanMs);
    timer.unref?.();
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = decodeURIComponent(url.pathname);

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (path === '/health' || path === '/places/health')) {
      const body = JSON.stringify({
        status: 'ok',
        captures: state.registry.captures.length,
        tiers: state.files.size,
        problems: state.registry.problems.length,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && path === '/places/registry.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(registryManifest(state.registry), null, 2));
      return;
    }

    if (req.method === 'GET' && path.startsWith('/places/assets/')) {
      const relative = path.slice('/places/'.length);
      const found = state.files.get(relative);
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no tier at ${relative}` }));
        return;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(found.absolute);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
        return;
      }
      // The renderer checks this itself; serving the hash makes a mismatch diagnosable
      // from the wire rather than from inside the client.
      res.writeHead(200, {
        'content-type': found.tier.contentType,
        'content-length': String(bytes.byteLength),
        'x-content-sha256': found.tier.hash,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(bytes);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no route for ${req.method} ${path}` }));
  });

  return {
    get registry() {
      return state.registry;
    },
    get files() {
      return state.files;
    },
    listen: () =>
      new Promise<void>((resolve) =>
        server.listen(options.port ?? 8098, options.host ?? '0.0.0.0', resolve),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    address: () => {
      const a = server.address();
      if (!a || typeof a === 'string') return null;
      return { host: a.address, port: a.port };
    },
  };
}
