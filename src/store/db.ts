import { DatabaseConfig } from '../config.js';
import { ClaimTypeRefoldResult, claimTypesStale, refoldClaimTypes } from '../lineage/claim-types.js';
import { refreshRelationSources, RelationSourcesResult, relationSourcesStale } from '../lineage/relation-sources.js';
import { Backend, openBackend } from './backend.js';
import { ensureMatchIndexes, MATCH_INDEXES, MatchIndexResult } from './grams.js';
import { CoOccursCleanupResult, dropStoredCoOccurrence, migrate, MigrationResult, Queryable, SCHEMA_VERSION } from './migrations.js';

/**
 * Vector column type for the embeddings table.
 *
 * pgvector caps an *index* entry at roughly one 8 KB page (index tuples cannot
 * be TOASTed, so the whole vector must sit inline): 2000 dims for `vector`
 * (4 bytes/dim) but 4000 for `halfvec` (2 bytes/dim). Storing half precision
 * therefore keeps HNSW reachable at dimensions like 2048 that `vector` could
 * only ever answer with a sequential scan — and halves the table on disk. The
 * recall cost of float16 is negligible for embedding search.
 */
export const VECTOR_TYPE = 'halfvec';

/** Largest dimension pgvector will build an HNSW index for, per VECTOR_TYPE. */
const HNSW_MAX_DIM = 4000;

/** SQLSTATEs after which a transaction is simply run again: deadlock_detected, serialization_failure. */
const RETRY_SQLSTATES = new Set(['40P01', '40001']);

/** Tries a transaction gets in all before such a failure is passed on (see Store.tx). */
export const TX_ATTEMPTS = 4;

/** A statement that may change rows: it holds a writing verb, wherever in it (a CTE may write). */
const CONTENT_WRITE = /(?:^|[\s(;])(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE|COPY)\s/i;
/** The tables that say which documents and chunks a search may return (`Store.contentVersion`). */
const CONTENT_TABLE = /\b(?:documents|chunks|pages|scopes)\b/i;

function isRetryableTxError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RETRY_SQLSTATES.has(code);
}

/**
 * DDL for the dimension-dependent embeddings table. Above HNSW_MAX_DIM the
 * index is skipped rather than failing the open — recall falls back to a
 * sequential scan, which is correct, just slower.
 */
function embeddingsDdl(dim: number): string {
  const index =
    dim <= HNSW_MAX_DIM
      ? `CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx
           ON embeddings USING hnsw (embedding ${VECTOR_TYPE}_cosine_ops);`
      : '';
  return `
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id  TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        model     TEXT NOT NULL,
        embedding ${VECTOR_TYPE}(${dim}) NOT NULL
      );
      ${index}
      -- entity name+description vectors for the duplicate audit; keyed by fold_sha so
      -- an entity is only re-embedded when its folded row changed
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        fold_sha  TEXT NOT NULL,
        model     TEXT NOT NULL,
        embedding ${VECTOR_TYPE}(${dim}) NOT NULL
      );
      -- "subject: statement" vectors for the duplicate-claim audit; a claim's
      -- statement is part of its id, so each is embedded once per model
      CREATE TABLE IF NOT EXISTS claim_embeddings (
        claim_id  TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
        model     TEXT NOT NULL,
        embedding ${VECTOR_TYPE}(${dim}) NOT NULL
      );
  `;
}

/**
 * The derived index over the markdown/file tree plus the lineage ledger —
 * deleting it and re-running `knode-os sync` (or `rebuild`) reconstructs
 * everything. Schema evolution goes through versioned migrations (see
 * migrations.ts). Backed by a PostgreSQL server with pgvector by default, or
 * by embedded PGlite when `database.kind` is "pglite" (see backend.ts).
 */

export class Store implements Queryable {
  /** Result of the migration run performed by `open` (from === to when nothing changed). */
  public migration: MigrationResult = { from: 0, to: 0 };
  /**
   * The batched follow-up of migration v13 (dropStoredCoOccurrence), running in
   * the background since `open`: settled when it has finished or `close` stopped
   * it. Await it to know the stored co_occurs rows are gone.
   */
  public cleanup: Promise<CoOccursCleanupResult | null> = Promise.resolve(null);
  /**
   * The refold claims folded under an older claim type mapping need
   * (refoldClaimTypes), running in the background after `cleanup`; settled at
   * once when nothing needs it.
   */
  public retype: Promise<ClaimTypeRefoldResult | null> = Promise.resolve(null);
  /**
   * The substring indexes search matches terms through (grams.ts), built in the
   * background after `cleanup` when missing: settled once each is there, or
   * when `close` stopped the build. `matchIndexes` names the ones ready.
   */
  public indexing: Promise<MatchIndexResult | null> = Promise.resolve(null);
  /**
   * Every live relation's stored source read again (refreshRelationSources):
   * when the rule that picks it has changed, and for relations written before
   * v20, which have none. In the background after `cleanup`; settled at once
   * when the stored sources already follow the rule.
   */
  public relationSources: Promise<RelationSourcesResult | null> = Promise.resolve(null);
  public readonly matchIndexes = new Set<string>();
  /**
   * Opened read-only (docs/design/35 §4): no migration ran and no upkeep
   * follows the open, the backend refuses every write, and what would only
   * note a use of the index (search hits) is skipped.
   */
  public readOnly = false;
  private stopCleanup = false;
  /** Backend pid of an index build in flight, for close to cancel; only a server can take that call meanwhile. */
  private buildPid: number | null = null;

  private constructor(
    public readonly db: Backend,
    public readonly dataDir: string,
    public embeddingDim: number,
    private readonly embedded: boolean,
  ) {}

  /**
   * Open (or create) the store: run pending migrations, then make sure the
   * dimension-dependent embeddings table exists. If the dimension changed
   * since last run the table is rebuilt (embeddings are regenerated by sync).
   */
  static async open(dataDir: string, embeddingDim: number, dbConfig?: DatabaseConfig, opts: { readOnly?: boolean } = {}): Promise<Store> {
    const kind = dbConfig?.kind || 'pglite';
    if (opts.readOnly && kind !== 'pglite' && kind !== 'postgres') {
      throw new Error(`database.kind "${kind}" cannot be opened read-only: only the built-in pglite and postgres backends can`);
    }
    const db = await openBackend(dataDir, opts.readOnly ? { ...(dbConfig ?? { kind, host: '', port: 0, user: '', password: '', database: '', schemaPrefix: 'ws' }), readOnly: true } : dbConfig);
    const store = new Store(db, dataDir, embeddingDim, kind === 'pglite');
    try {
      if (opts.readOnly) return await store.prepareReadOnly(embeddingDim);
      return await store.prepare(embeddingDim);
    } catch (err) {
      // a failed open hands its backend back: the pool's connections, an embedded database's claim on its directory
      await store.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * The index as it is, for reading only: no migration, no embeddings table
   * made or changed, none of the upkeep `prepare` starts. An index written by
   * another schema version, or with vectors of another dimension, is refused
   * rather than read wrongly. Which substring indexes search may use is read
   * from the database, not built.
   */
  private async prepareReadOnly(embeddingDim: number): Promise<Store> {
    this.readOnly = true;
    const meta = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'meta'`,
    );
    if (!meta.rows[0]?.n) throw new SchemaVersionError(0, SCHEMA_VERSION, 'the index is empty');
    const [version] = (await this.db.query<{ value: { v?: number } }>(`SELECT value FROM meta WHERE key = 'schema_version'`)).rows;
    const v = Number(version?.value?.v ?? 0);
    if (v !== SCHEMA_VERSION) throw new SchemaVersionError(v, SCHEMA_VERSION);
    const [embedding] = (await this.db.query<{ value: { dim?: number } }>(`SELECT value FROM meta WHERE key = 'embedding'`)).rows;
    const dim = embedding?.value?.dim;
    if (dim !== undefined && dim !== embeddingDim) throw new Error(`the index holds ${dim}-dimension vectors; its config names ${embeddingDim}`);
    const names = Object.values(MATCH_INDEXES).map((spec) => spec.name);
    const ready = await this.db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE i.indisvalid AND c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1::text[])`,
      [names],
    );
    for (const r of ready.rows) this.matchIndexes.add(r.name);
    this.migration = { from: v, to: v };
    return this;
  }

  private async prepare(embeddingDim: number): Promise<Store> {
    const db = this.db;
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    this.migration = await migrate(this, (fn) => this.tx(fn));

    const prev = await db.query<{ value: { dim: number; type?: string } }>(
      `SELECT value FROM meta WHERE key = 'embedding'`,
    );
    const prevDim = prev.rows[0]?.value?.dim;
    // Databases written before the halfvec switch carry no type and are `vector`.
    const prevType = prev.rows[0]?.value?.type ?? 'vector';
    if (prevDim !== undefined && prevDim !== embeddingDim) {
      // A new dimension invalidates the stored vectors themselves — drop them
      // and let the next sync regenerate.
      await db.exec(`DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS entity_embeddings; DROP TABLE IF EXISTS claim_embeddings;`);
      await db.exec(`UPDATE documents SET status = 'pending' WHERE status = 'indexed';`);
      console.warn(`[knode-os] embedding dimension changed ${prevDim} -> ${embeddingDim}; embeddings dropped, re-run sync.`);
    } else if (prevDim !== undefined && prevType !== VECTOR_TYPE) {
      // Same dimension, different column type (the vector -> halfvec switch):
      // the values stay meaningful, so cast in place instead of re-embedding.
      // Any index built for the old type's operator class must go first.
      await db.exec(`
        DROP INDEX IF EXISTS embeddings_hnsw_idx;
        ALTER TABLE embeddings
          ALTER COLUMN embedding TYPE ${VECTOR_TYPE}(${embeddingDim})
          USING embedding::${VECTOR_TYPE}(${embeddingDim});
      `);
      console.warn(`[knode-os] embedding column converted ${prevType} -> ${VECTOR_TYPE} (${embeddingDim}d); vectors preserved.`);
    }
    await db.exec(embeddingsDdl(embeddingDim));
    await this.setMeta('embedding', { dim: embeddingDim, type: VECTOR_TYPE });
    // v13 leaves the stored co_occurs rows for here: short autocommitted batches
    // in the background, not one delete inside the migration's transaction, so
    // the open returns at once; close() stops them and the next open resumes
    this.cleanup = dropStoredCoOccurrence(this, { stop: () => this.stopCleanup }).catch((err: unknown) => {
      console.warn(`[knode-os] co_occurs cleanup stopped: ${err instanceof Error ? err.message : String(err)}; the next open resumes it`);
      return null;
    });
    // claims folded under an older claim type mapping follow the same way; a
    // store without claims records the mapping here and starts nothing
    if (await claimTypesStale(this)) {
      this.retype = this.cleanup
        .then(() => refoldClaimTypes(this, { stop: () => this.stopCleanup }))
        .catch((err: unknown) => {
          console.warn(`[knode-os] claim type refold stopped: ${err instanceof Error ? err.message : String(err)}; the next open resumes it`);
          return null;
        });
    }
    // relations whose stored source follows an older rule, or was never stored (before v20), are read again:
    // short batches, after the cleanup; a store without relations records the rule here and starts nothing
    if (await relationSourcesStale(this)) {
      this.relationSources = this.cleanup
        .then(() => refreshRelationSources(this, { stop: () => this.stopCleanup }))
        .catch((err: unknown) => {
          console.warn(`[knode-os] relation sources stopped: ${err instanceof Error ? err.message : String(err)}; the next open resumes it`);
          return null;
        });
    }
    // building the chunk index takes minutes on a large workspace; searches
    // scan without it until it is ready, and a stopped build starts over
    this.indexing = this.cleanup
      .then(() => ensureMatchIndexes(this, { stop: () => this.stopCleanup, building: (pid) => { this.buildPid = pid; } }))
      .catch((err: unknown) => {
        console.warn(`[knode-os] search index build stopped: ${err instanceof Error ? err.message : String(err)}; the next open builds it`);
        return null;
      });
    return this;
  }

  /** Statements and transactions sent to the backend and not answered yet. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Set when `close` has let the last statements finish: nothing more is sent to the backend. */
  private closed = false;

  /**
   * `sent`, counted as in flight until it settles — and refused once the
   * store has closed. `close` waits for what is in flight: an embedded
   * database's own close does not, and a statement its caller did not wait
   * for then ran after the close had returned, on a directory that could be
   * open again by then (see `close`).
   */
  private track<T>(send: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('this index is closed: nothing more can be asked of it'));
    const sent = send();
    const settled = sent.then(() => undefined, () => undefined);
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
    return sent;
  }

  private contentWrites = 0;

  /**
   * A number that moves whenever a statement sent through this store may have
   * changed which documents, chunks, generated pages or scopes exist. What is
   * kept in memory about them (the sizes of a search's sides) is kept with
   * the number it was taken at, and is not used once it has moved.
   *
   * It is this process's writes only. Another process writing the same
   * database (a CLI sync beside a running server) does not move it: what
   * relies on it must still age out, and must not answer "nothing" from
   * memory.
   */
  get contentVersion(): number {
    return this.contentWrites;
  }

  /** Counts `sql` as a write to the content tables when it is one; before it is sent, so a reader never sees the old number after the write. */
  private noteWrite(sql: string): void {
    if (CONTENT_WRITE.test(sql) && CONTENT_TABLE.test(sql)) this.contentWrites++;
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.noteWrite(sql);
    const res = await this.track(() => this.db.query<T>(sql, params));
    // and after it: a count taken while the write was in flight is not kept past it
    this.noteWrite(sql);
    return res.rows;
  }

  async exec(sql: string): Promise<void> {
    this.noteWrite(sql);
    await this.track(() => this.db.exec(sql));
    this.noteWrite(sql);
  }

  /**
   * Run `fn` inside a transaction. The passed handle must be used for every
   * statement in the callback: on PostgreSQL `store.query` runs on another
   * pooled connection, outside the transaction, and on PGlite, which holds a
   * mutex for the transaction, calling it from inside deadlocks.
   *
   * A transaction Postgres picks as a deadlock victim, or one that fails to
   * serialize, is rolled back and run again, up to TX_ATTEMPTS times in all —
   * so `fn` may run more than once: it keeps effects outside the database for
   * after it returns, and starts any state it builds up afresh.
   */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // a body that swallowed the deadlock error fails later on "current transaction is aborted": the deadlock decides
      let conflict = false;
      // a transaction's writes are seen by others when it commits: the content version moves then
      let wrote = false;
      const watch = <R>(p: Promise<R>): Promise<R> =>
        p.catch((err: unknown) => {
          if (isRetryableTxError(err)) conflict = true;
          throw err;
        });
      try {
        const done = await this.track(() => this.db.transaction(async (tx) =>
          fn({
            query: async (sql, params) => {
              wrote ||= CONTENT_WRITE.test(sql) && CONTENT_TABLE.test(sql);
              return (await watch(tx.query(sql, params))).rows as never;
            },
            exec: async (sql) => {
              wrote ||= CONTENT_WRITE.test(sql) && CONTENT_TABLE.test(sql);
              await watch(tx.exec(sql));
            },
          }),
        ));
        if (wrote) this.contentWrites++;
        return done;
      } catch (err) {
        if (attempt >= TX_ATTEMPTS || !(conflict || isRetryableTxError(err))) throw err;
        console.warn(`[knode-os] transaction rolled back (${err instanceof Error ? err.message : err}); running it again, attempt ${attempt + 1} of ${TX_ATTEMPTS}`);
        // the transaction that won holds its locks until it commits; let it
        await new Promise((r) => setTimeout(r, attempt * (20 + Math.random() * 30)));
      }
    }
  }

  /** Legacy transaction helper; prefer `tx`. */
  async transaction<T>(fn: (query: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    return this.tx((q) => fn((sql, params) => q.query(sql, params)));
  }

  /**
   * Rebuild the embeddings table for a new vector dimension and mark every
   * document pending so the next sync regenerates embeddings. No-op if the
   * dimension is unchanged.
   */
  async setEmbeddingDimension(dim: number): Promise<void> {
    if (dim === this.embeddingDim) return;
    await this.db.exec(`DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS entity_embeddings; DROP TABLE IF EXISTS claim_embeddings;`);
    await this.db.exec(embeddingsDdl(dim));
    await this.db.exec(`UPDATE documents SET status = 'pending' WHERE status = 'indexed';`);
    await this.setMeta('embedding', { dim, type: VECTOR_TYPE });
    this.embeddingDim = dim;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const rows = await this.query<{ value: T }>(`SELECT value FROM meta WHERE key = $1`, [key]);
    return rows[0]?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.query(
      `INSERT INTO meta (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async close(): Promise<void> {
    // let the batch in flight finish, then stop: a half-done cleanup or refold resumes at the next open
    this.stopCleanup = true;
    // an index build is one statement of minutes: cancel it (it rolls back whole); embedded PGlite runs one statement at a time, so it is waited for
    if (this.buildPid !== null && !this.embedded) {
      await this.query(`SELECT pg_cancel_backend($1)`, [this.buildPid]).catch(() => undefined);
    }
    await this.cleanup;
    await this.retype;
    await this.relationSources;
    await this.indexing;
    // Whatever was sent and not waited for by its caller is waited for here, and nothing is taken after.
    // Embedded PGlite closes under a statement still queued on it and runs the statement afterwards: a
    // workspace closed and reopened at once then had two instances on one directory, and the second one's
    // close never returned (a loop inside the database; tests/pglite-open-guard.test.ts hung on it when
    // serve's open asked a question it did not wait for, 2026-11-15).
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
    this.closed = true;
    await this.db.close();
  }
}

export type { Queryable } from './migrations.js';

/** An index written by another schema version than this code's: read-only, it is not migrated, and so not opened. */
export class SchemaVersionError extends Error {
  readonly code = 'KNODE_SCHEMA_VERSION';
  constructor(readonly found: number, readonly expected: number, why?: string) {
    super(why ? `${why} (schema version ${found}; this version reads ${expected})` : `the index is at schema version ${found}; this version reads ${expected} and does not migrate a read-only index`);
  }
}

/** Serialize a JS number[] for a pgvector parameter. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? +x.toFixed(7) : 0)).join(',')}]`;
}
