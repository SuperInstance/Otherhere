import { DurableObject } from 'cloudflare:workers';
import {
  buildBundle,
  bundleInputsHash,
  BundleManifest,
  Fact,
  fetchOverpass,
  generatorSet,
  ingestBlockOf,
  osmToFacts,
  overpassQuery,
  blockBBox,
  resolveFacts,
  type BundleFeature,
  type Feature,
  type OverpassResponse,
  type ResolvedAttrs,
} from '@otherhere/core';
import type { Env } from './env';

/** `loading`: an Overpass fetch is still running; the Cell is served as a sketch meanwhile. */
export type BlockStatus = 'ok' | 'failed' | 'loading';

/** How long a Bundle request waits for an ingest before serving the sketch. */
const INGEST_WAIT_MS = 8_000;

export type CellBundle = { manifest: BundleManifest; status: BlockStatus; cached: boolean };

/** Retry a failed Overpass ingest after this long (grows with attempts). */
const RETRY_AFTER_MS = 60_000;

const gens = generatorSet();

/**
 * One Town (an H3 res-6 cell, ADR-0002): its Facts, Features, and the
 * Cell → Bundle pointers. Bundles themselves live in R2.
 */
export class TownDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private inflight = new Map<string, Promise<BlockStatus>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        anchor_cell TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS features_by_cell ON features(anchor_cell);
      CREATE TABLE IF NOT EXISTS facts (
        feature_id TEXT NOT NULL,
        attribute TEXT NOT NULL,
        source TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        observed_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (feature_id, attribute, source)
      );
      CREATE TABLE IF NOT EXISTS blocks (
        block TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS bundles (
        cell TEXT PRIMARY KEY,
        inputs_hash TEXT NOT NULL,
        manifest TEXT NOT NULL
      );
    `);
  }

  /** Write Features and Facts. Same-source rewrites bump `version` only when the value changes. */
  private write(features: Feature[], facts: Fact[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const f of features) {
        this.sql.exec(
          `INSERT INTO features (id, kind, anchor_cell) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, anchor_cell = excluded.anchor_cell`,
          f.id,
          f.kind,
          f.anchorCell,
        );
      }
      for (const f of facts) {
        this.sql.exec(
          `INSERT INTO facts (feature_id, attribute, source, value, confidence, observed_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(feature_id, attribute, source) DO UPDATE SET
             version = CASE WHEN facts.value = excluded.value AND facts.confidence = excluded.confidence
                            THEN facts.version ELSE facts.version + 1 END,
             value = excluded.value,
             confidence = excluded.confidence,
             observed_at = excluded.observed_at`,
          f.featureId,
          f.attribute,
          f.source,
          JSON.stringify(f.value),
          f.confidence,
          f.observedAt,
          f.version,
        );
      }
    });
  }

  /** Store an Overpass response for one ingest block (ADR-0010). */
  async ingestOverpass(
    block: string,
    res: OverpassResponse,
    observedAt = new Date().toISOString(),
  ): Promise<number> {
    const { features, facts } = osmToFacts(res, { block, observedAt });
    this.write(features, facts);
    this.sql.exec(
      `INSERT INTO blocks (block, status, updated_at, attempts, error) VALUES (?, 'ok', ?, 0, NULL)
       ON CONFLICT(block) DO UPDATE SET status = 'ok', updated_at = excluded.updated_at, attempts = 0, error = NULL`,
      block,
      Date.now(),
    );
    return features.length;
  }

  /** Facts from any source. Validated; the TownDO is the gatekeeper for what enters a World. */
  async putFacts(facts: unknown[]): Promise<number> {
    const parsed = facts.map((f, i) => {
      const r = Fact.safeParse(f);
      // Throw a plain Error: it crosses the RPC boundary cleanly.
      if (!r.success)
        throw new Error(`invalid Fact at ${i}: ${r.error.issues.map((x) => x.message).join(', ')}`);
      return r.data;
    });
    for (const f of parsed) {
      const known =
        this.sql.exec('SELECT 1 FROM features WHERE id = ?', f.featureId).toArray().length > 0;
      if (!known) throw new Error(`unknown Feature ${f.featureId}`);
    }
    this.write([], parsed);
    return parsed.length;
  }

  private async ensureBlock(block: string): Promise<BlockStatus> {
    const row = this.sql
      .exec<{ status: string; updated_at: number; attempts: number }>(
        'SELECT status, updated_at, attempts FROM blocks WHERE block = ?',
        block,
      )
      .toArray()[0];
    if (row?.status === 'ok') return 'ok';
    if (row && Date.now() - row.updated_at < RETRY_AFTER_MS * row.attempts) return 'failed';

    let p = this.inflight.get(block);
    if (!p) {
      p = this.fetchBlock(block, row?.attempts ?? 0).finally(() => this.inflight.delete(block));
      this.inflight.set(block, p);
    }
    return p;
  }

  private async fetchBlock(block: string, attempts: number): Promise<BlockStatus> {
    try {
      const res = await fetchOverpass(overpassQuery(blockBBox(block)), {
        endpoints: this.env.OVERPASS_ENDPOINTS.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        timeoutMs: 25_000,
      });
      await this.ingestOverpass(block, res);
      return 'ok';
    } catch (err) {
      this.sql.exec(
        `INSERT INTO blocks (block, status, updated_at, attempts, error) VALUES (?, 'failed', ?, ?, ?)
         ON CONFLICT(block) DO UPDATE SET status = 'failed', updated_at = excluded.updated_at,
           attempts = excluded.attempts, error = excluded.error`,
        block,
        Date.now(),
        attempts + 1,
        String((err as Error).message).slice(0, 500),
      );
      return 'failed';
    }
  }

  /** The Features anchored in a Cell, with their resolved values. */
  async cellFacts(
    cell: string,
  ): Promise<{ features: Feature[]; resolved: Record<string, ResolvedAttrs> }> {
    const features = this.sql
      .exec<{ id: string; kind: Feature['kind']; anchor_cell: string }>(
        'SELECT id, kind, anchor_cell FROM features WHERE anchor_cell = ? ORDER BY id',
        cell,
      )
      .toArray()
      .map((r) => ({ id: r.id, kind: r.kind, anchorCell: r.anchor_cell }));
    const facts = this.sql
      .exec<{
        feature_id: string;
        attribute: string;
        source: Fact['source'];
        value: string;
        confidence: number;
        observed_at: string;
        version: number;
      }>(
        `SELECT f.* FROM facts f JOIN features x ON x.id = f.feature_id WHERE x.anchor_cell = ?`,
        cell,
      )
      .toArray()
      .map((r): Fact => ({
        featureId: r.feature_id,
        attribute: r.attribute,
        source: r.source,
        value: JSON.parse(r.value) as Fact['value'],
        confidence: r.confidence,
        observedAt: r.observed_at,
        version: r.version,
      }));
    return { features, resolved: Object.fromEntries(resolveFacts(facts)) };
  }

  /** Every Feature anchored in a Cell and every Fact about them, for a Capsule snapshot. */
  async snapshot(
    cell: string,
  ): Promise<{ status: BlockStatus; features: Feature[]; facts: Fact[] }> {
    const status = await this.ensureBlock(ingestBlockOf(cell));
    const features = this.sql
      .exec<{ id: string; kind: Feature['kind']; anchor_cell: string }>(
        'SELECT id, kind, anchor_cell FROM features WHERE anchor_cell = ?',
        cell,
      )
      .toArray()
      .map((r) => ({ id: r.id, kind: r.kind, anchorCell: r.anchor_cell }));
    const facts = this.sql
      .exec<{
        feature_id: string;
        attribute: string;
        source: Fact['source'];
        value: string;
        confidence: number;
        observed_at: string;
        version: number;
      }>(
        'SELECT f.* FROM facts f JOIN features x ON x.id = f.feature_id WHERE x.anchor_cell = ?',
        cell,
      )
      .toArray()
      .map((r): Fact => ({
        featureId: r.feature_id,
        attribute: r.attribute,
        source: r.source,
        value: JSON.parse(r.value) as Fact['value'],
        confidence: r.confidence,
        observedAt: r.observed_at,
        version: r.version,
      }));
    return { status, features, facts };
  }

  /** The current Bundle for a Cell: ingest if needed, then build or reuse by content address. */
  async bundleFor(cell: string): Promise<CellBundle> {
    // Never hold a Cell hostage to a slow Overpass: after a short wait, serve what we
    // have and let the fetch finish in the background (the client asks again).
    const ingest = this.ensureBlock(ingestBlockOf(cell));
    const status = await Promise.race([
      ingest,
      new Promise<BlockStatus>((r) => setTimeout(() => r('loading'), INGEST_WAIT_MS)),
    ]);
    const { features, resolved } = await this.cellFacts(cell);
    const input: BundleFeature[] = features.map((f) => ({
      id: f.id,
      kind: f.kind,
      attrs: resolved[f.id] ?? {},
    }));
    const inputsHash = await bundleInputsHash({ cell, features: input, generators: gens });

    const row = this.sql
      .exec<{ inputs_hash: string; manifest: string }>(
        'SELECT inputs_hash, manifest FROM bundles WHERE cell = ?',
        cell,
      )
      .toArray()[0];
    if (row?.inputs_hash === inputsHash && (await this.env.BUNDLES.head(bundleKey(inputsHash)))) {
      return { manifest: BundleManifest.parse(JSON.parse(row.manifest)), status, cached: true };
    }

    const { glb, manifest } = await buildBundle({ cell, features: input, generators: gens });
    const gz = await new Response(
      new Blob([glb as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    await this.env.BUNDLES.put(bundleKey(manifest.inputsHash), gz, {
      httpMetadata: { contentType: 'model/gltf-binary', contentEncoding: 'gzip' },
      customMetadata: { outputHash: manifest.outputHash, cell },
    });
    this.sql.exec(
      `INSERT INTO bundles (cell, inputs_hash, manifest) VALUES (?, ?, ?)
       ON CONFLICT(cell) DO UPDATE SET inputs_hash = excluded.inputs_hash, manifest = excluded.manifest`,
      cell,
      manifest.inputsHash,
      JSON.stringify(manifest),
    );
    return { manifest, status, cached: false };
  }
}

export const bundleKey = (inputsHash: string) => `bundles/${inputsHash}.glb`;
