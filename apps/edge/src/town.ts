import { DurableObject } from 'cloudflare:workers';
import {
  buildBundle,
  bundleInputsHash,
  computeEssence,
  forestBiome,
  regionOf,
  PLACE_BATTERY,
  PLACE_BATTERY_SHA,
  placeCensus,
  placeState,
  sha256Hex,
  StoredPlaceVector,
  type Essence,
  type PlaceCensus,
  BundleManifest,
  Fact,
  fetchOverpass,
  generatorSet,
  ingestBlockOf,
  osmToFacts,
  overpassQuery,
  blockBBox,
  resolveFacts,
  townCenter,
  OverpassResponseSchema,
  townOf,
  questsFor,
  type Quest,
  type BundleFeature,
  type Feature,
  type OverpassResponse,
  type ResolvedAttrs,
} from '@otherhere/core';
import {
  askPlaceVectorState,
  BudgetExceeded,
  JEV_MODEL,
  type JevProvider,
} from '@otherhere/models';
import type { Env } from './env';
import { jobsStub } from './jobs';
import { placeJev } from './models';

/** `loading`: an Overpass fetch is still running; the Cell is served as a sketch meanwhile. */
export type BlockStatus = 'ok' | 'failed' | 'loading';

/** How long a Bundle request waits for an ingest before serving the sketch. */
const INGEST_WAIT_MS = 8_000;

export type CellBundle = { manifest: BundleManifest; status: BlockStatus; cached: boolean };

/** Retry a failed Overpass ingest after this long (grows with attempts). */
const RETRY_AFTER_MS = 60_000;

const gens = generatorSet();

/**
 * One place-vector compute attempt's outcome (ADR-0018, as amended): the
 * vector, or the reason it was not computed. A tagged result, not a thrown
 * error, so the reason survives the Durable Object RPC boundary intact.
 */
export type PlaceVectorCompute =
  | { ok: true; vector: StoredPlaceVector; asked: boolean }
  | { ok: false; reason: 'no-features' | 'not-configured' }
  | { ok: false; reason: 'budget'; spent: number; cap: number };

/**
 * One Town (an H3 res-6 cell, ADR-0002): its Facts, Features, and the
 * Cell → Bundle pointers. Bundles themselves live in R2.
 */
export class TownDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private inflight = new Map<string, Promise<BlockStatus>>();
  /** Single-flight for the place-vector compute: Durable Object input gates do
   * not hold across an outgoing model fetch, so concurrent computes share this. */
  private vectorFlight: Promise<PlaceVectorCompute> | null = null;

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
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bundles (
        cell TEXT PRIMARY KEY,
        inputs_hash TEXT NOT NULL,
        manifest TEXT NOT NULL
      );
    `);
    // Buildings a photo could not settle (the Ladder's human rung): they become Quests.
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS unsure (feature_id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
    );
    // v2: which Plugin, if any, delivered a block's data (ADR-0015).
    const cols = this.sql.exec<{ name: string }>('PRAGMA table_info(blocks)').toArray();
    if (!cols.some((c) => c.name === 'via'))
      this.sql.exec('ALTER TABLE blocks ADD COLUMN via TEXT');
  }

  /** Write Features and Facts. Same-source rewrites bump `version` only when the value changes. */
  private write(features: Feature[], facts: Fact[]): void {
    this.ctx.storage.transactionSync(() => {
      this.invalidateEssence();
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
    via: string | null = null,
  ): Promise<number> {
    const { features, facts } = osmToFacts(res, { block, observedAt });
    this.write(features, facts);
    this.sql.exec(
      `INSERT INTO blocks (block, status, updated_at, attempts, error, via) VALUES (?, 'ok', ?, 0, NULL, ?)
       ON CONFLICT(block) DO UPDATE SET status = 'ok', updated_at = excluded.updated_at, attempts = 0,
         error = NULL, via = excluded.via`,
      block,
      Date.now(),
      via,
    );
    return features.length;
  }

  /**
   * A Plugin's result for an `ingest_block` job (ADR-0015). It is a proposal: the
   * raw Overpass response is checked here and Facts are derived by `osmToFacts`,
   * which keeps only Features anchored inside the block and always writes
   * `source: "osm"`. Throws a plain Error when the proposal is not acceptable.
   */
  async acceptIngestProposal(block: string, overpass: unknown, agent: string): Promise<number> {
    if (townOf(block) !== this.ctx.id.name) throw new Error('block is not in this Town');
    const r = OverpassResponseSchema.safeParse(overpass);
    if (!r.success) throw new Error(`not an Overpass response: ${r.error.issues[0]?.message}`);
    return this.ingestOverpass(
      block,
      r.data as OverpassResponse,
      new Date().toISOString(),
      `agent:${agent}`,
    );
  }

  /**
   * Moderation: remove one source's Facts about a Feature (e.g. a bad or abusive
   * capture). The Feature resolves from its remaining sources again, so its Bundle
   * rebuilds on the next request. Returns how many Facts were removed.
   */
  async removeFacts(featureId: string, source: string): Promise<number> {
    const n = this.sql
      .exec('DELETE FROM facts WHERE feature_id = ? AND source = ? RETURNING 1', featureId, source)
      .toArray().length;
    if (n) this.invalidateEssence();
    return n;
  }

  /**
   * Drop the cached Essence and the cached census: the next read recomputes
   * them from the Facts. The one place that knows the cache keys, so a renamed
   * key (`essence:2`, `essence-census:1`) cannot leave a writer invalidating the
   * old name. The stored place vector is deliberately NOT dropped: it survives
   * Fact writes and the compute path decides staleness by state hash (ADR-0018
   * as amended — a write that does not change the state must not force a re-ask).
   */
  private invalidateEssence(): void {
    this.sql.exec("DELETE FROM meta WHERE key LIKE 'essence%'");
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
      // If Plugins are set up, ask one to fetch the block for us. Without them the
      // retry above still happens on the next request (invariant 7).
      if (this.env.AGENT_TOKEN) await jobsStub(this.env).enqueue('ingest_block', block);
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

  /** Record whether a photo settled a building. An unsettled one stays a Quest until one does. */
  async markObserved(featureId: string, settled: boolean): Promise<void> {
    if (settled) this.sql.exec('DELETE FROM unsure WHERE feature_id = ?', featureId);
    else
      this.sql.exec(
        'INSERT OR REPLACE INTO unsure (feature_id, at) VALUES (?, ?)',
        featureId,
        Date.now(),
      );
  }

  /** The Quests in a Cell: the buildings a photo would sharpen most. */
  async quests(cell: string): Promise<Quest[]> {
    const { features, resolved } = await this.cellFacts(cell);
    const ids = features.filter((f) => f.kind === 'building').map((f) => f.id);
    const unsure = new Set(
      this.sql
        .exec<{ feature_id: string }>(
          'SELECT u.feature_id FROM unsure u JOIN features f ON f.id = u.feature_id WHERE f.anchor_cell = ?',
          cell,
        )
        .toArray()
        .map((r) => r.feature_id),
    );
    return questsFor(
      cell,
      ids.map((id) => ({ id, attrs: resolved[id] ?? {} })),
      unsure,
    );
  }

  /**
   * The Town's Essence (ADR-0014), recomputed lazily after any write. The cache key
   * is versioned, so a deploy that changes what Essence says (species, biome) does
   * not keep serving an older shape from storage.
   */
  private essence(): Essence {
    const cached = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'essence:2'")
      .toArray()[0];
    if (cached) return JSON.parse(cached.value) as Essence;
    const kinds = new Map(
      this.sql
        .exec<{ id: string; kind: Feature['kind'] }>('SELECT id, kind FROM features')
        .toArray()
        .map((r) => [r.id, r.kind]),
    );
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
        `SELECT * FROM facts WHERE attribute IN ('height', 'levels', 'roof.shape', 'colour', 'species')`,
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
    const resolved = resolveFacts(facts);
    // The Town's place in the world decides its fallback forest character and
    // its imagined buildings' regional prior (ADR-0014): a TownDO's name is its
    // res-6 Cell.
    const name = this.ctx.id.name ?? 'town';
    const centre = townCenter(name) ?? { lat: 0, lng: 0 };
    const e = computeEssence(
      name,
      [...kinds].map(([id, kind]) => ({ kind, attrs: resolved.get(id) ?? {} })),
      { biome: forestBiome(centre.lat, centre.lng), region: regionOf(centre.lat, centre.lng) },
    );
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('essence:2', ?)",
      JSON.stringify(e),
    );
    return e;
  }

  /**
   * The census half of a place state (ADR-0018): every Feature and every Fact,
   * counted. Like `essence()`, a pure read of the Facts; the state's Essence half
   * is the cached `essence()` itself, so the battery is asked over exactly the
   * statistics the Town serves. The census is cached under `essence-census:1`, so
   * repeated computes between writes (retries, pin moves) do not rescan every
   * Fact; `invalidateEssence()` drops it whenever the Facts change.
   */
  private placeSnapshot(): { essence: Essence; census: PlaceCensus } {
    const cached = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'essence-census:1'")
      .toArray()[0];
    if (cached) {
      return { essence: this.essence(), census: JSON.parse(cached.value) as PlaceCensus };
    }
    const kinds = this.sql
      .exec<{ id: string; kind: Feature['kind'] }>('SELECT id, kind FROM features')
      .toArray();
    const facts = this.sql
      .exec<{
        feature_id: string;
        attribute: string;
        source: Fact['source'];
        value: string;
        confidence: number;
        observed_at: string;
        version: number;
      }>('SELECT * FROM facts')
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
    const resolved = resolveFacts(facts);
    const census = placeCensus(
      kinds.map((r) => ({ kind: r.kind, attrs: resolved.get(r.id) ?? {} })),
      facts,
    );
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('essence-census:1', ?)",
      JSON.stringify(census),
    );
    return { essence: this.essence(), census };
  }

  /**
   * The stored place vector (ADR-0018), or null when this Town has none yet.
   * A pure read of `meta`: no model call, no Fact scan, no Jev configuration
   * needed. This is the only method the public `GET /api/towns/:town/vector`
   * reaches, so unauthenticated traffic can never spend model budget. The
   * record carries the sha of the state it describes; readers who care compare
   * against that, not against "now".
   */
  placeVector(): StoredPlaceVector | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'place-vector:1'")
      .toArray()[0];
    if (!row) return null;
    const parsed = StoredPlaceVector.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Compute (or refresh) the Town's place vector (ADR-0018, as amended): the
   * sealed place battery's calibrated answers over its deterministic state.
   * Owner-only — reached through `POST /api/ops/towns/:town/vector` — because a
   * compute on a cache miss is a paid call, and paid calls must never be
   * reachable from unauthenticated traffic (invariant 9). Refuses Towns with no
   * Features, shares one in-flight promise per Town (a second concurrent caller
   * waits for the first's answer instead of paying again), and re-asks only when
   * the battery version, the model pin or the state's sha changed. The stored
   * vector survives Fact writes; the state hash decides whether it is stale.
   * The vector is Town metadata, never a Bundle input.
   */
  async essenceVector(): Promise<PlaceVectorCompute> {
    const jev = placeJev(this.env);
    if (!jev) return { ok: false, reason: 'not-configured' };
    const featureCount = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM features')
      .toArray()[0];
    if (!featureCount?.n) return { ok: false, reason: 'no-features' };
    if (!this.vectorFlight) {
      this.vectorFlight = this.computeVector(jev).finally(() => {
        this.vectorFlight = null;
      });
    }
    return this.vectorFlight;
  }

  private async computeVector(jev: JevProvider): Promise<PlaceVectorCompute> {
    try {
      const { essence, census } = this.placeSnapshot();
      const state = placeState(essence, census);
      const stateSha = await sha256Hex(state);
      const batterySha = await PLACE_BATTERY_SHA;
      const stored = this.placeVector();
      if (
        stored &&
        stored.battery === PLACE_BATTERY &&
        stored.batterySha === batterySha &&
        stored.model === JEV_MODEL &&
        stored.stateSha === stateSha
      ) {
        return { ok: true, vector: stored, asked: false };
      }
      const r = await askPlaceVectorState(jev, state);
      const fresh: StoredPlaceVector = {
        battery: PLACE_BATTERY,
        batterySha,
        model: JEV_MODEL,
        served: r.model_served,
        stateSha: r.stateSha,
        vector: r.vector,
        at: new Date().toISOString(),
      };
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('place-vector:1', ?)",
        JSON.stringify(fresh),
      );
      // The pre-amendment key; one read of it is enough to retire it for good.
      this.sql.exec("DELETE FROM meta WHERE key = 'essence-vector:1'");
      return { ok: true, vector: fresh, asked: true };
    } catch (err) {
      if (err instanceof BudgetExceeded)
        return { ok: false, reason: 'budget', spent: err.spent, cap: err.cap };
      throw err;
    }
  }

  /** Every Feature anchored in a Cell and every Fact about them, for a Capsule snapshot. */
  async snapshot(
    cell: string,
  ): Promise<{ status: BlockStatus; features: Feature[]; facts: Fact[]; essence: Essence }> {
    // A capsule save is never held hostage to a slow Overpass either: after the
    // short wait, snapshot what is stored and let the fetch finish in the background.
    const ingest = this.ensureBlock(ingestBlockOf(cell));
    const status = await Promise.race([
      ingest,
      new Promise<BlockStatus>((r) => setTimeout(() => r('loading'), INGEST_WAIT_MS)),
    ]);
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
    return { status, features, facts, essence: this.essence() };
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
    const essence = this.essence();
    const inputsHash = await bundleInputsHash({ cell, features: input, generators: gens, essence });

    const row = this.sql
      .exec<{ inputs_hash: string; manifest: string }>(
        'SELECT inputs_hash, manifest FROM bundles WHERE cell = ?',
        cell,
      )
      .toArray()[0];
    if (row?.inputs_hash === inputsHash && (await this.env.BUNDLES.head(bundleKey(inputsHash)))) {
      return { manifest: BundleManifest.parse(JSON.parse(row.manifest)), status, cached: true };
    }

    const { glb, manifest } = await buildBundle({
      cell,
      features: input,
      generators: gens,
      essence,
    });
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
