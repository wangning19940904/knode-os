import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';
import { RAW_DOCS } from '../fs/layout.js';
import { removeSidecar, sidecarDir, sidecarHoldsPaidWork } from '../fs/sidecar.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { hasAtticSidecar, moveSidecarToAttic, readBlob, removeAtticSidecar, removeBlob } from './attic.js';
import { emptyPropagation, Propagation, propagate, writeDeps } from './deps.js';
import { FoldOptions, FoldResult, foldTouched } from './fold.js';
import { appendLedger, LedgerScopeRef, lockLedger, nextLedgerSeq } from './ledger.js';
import { TrustTier, tierForActor } from './trust.js';
import { DisposeReason, emptyTouched, InverseSpec, ScopeKind, ScopeRow, TouchedSet, WriterStats } from './types.js';
import { runFsOps, ScopeWriter } from './writer.js';
import { aliasStopKeys } from '../graph/concept-stoplist.js';
import { readEntityCorrections } from '../graph/corrections.js';
import { loadOntology, typePrecedence } from '../graph/ontology.js';
import { replaceRegion } from '../wiki/regions.js';

/**
 * Scope runtime — temporal composability for the knowledge base.
 *
 *   applyScope    open a scope for (kind, key, sha), run the body through a
 *                 ScopeWriter, fold the touched aggregates, propagate to
 *                 dependents, commit, then run file effects and log the event.
 *                 Same (kind, key, sha) → `unchanged` before any write. A
 *                 previous version is disposed in the same transaction, so
 *                 an apply that fails leaves it live rather than half replaced.
 *   disposeScope  children first, then close this scope's evidence, drop its
 *                 mentions / projection, replay explicit inverses in reverse
 *                 order, fold, propagate, tombstone — all in one transaction.
 *   purgeScope    physically erase a disposed scope (evidence history, attic).
 *
 * Every scope transaction takes the ledger counter's lock first (lockLedger),
 * and Store.tx runs it again when Postgres still picks it as a deadlock
 * victim — bodies may run more than once and keep file effects for after
 * COMMIT.
 */

export interface ApplyOptions {
  parentId?: string | null;
  actor?: string;
  /** Transaction time (ISO). Defaults to now; rebuild passes the original apply time. */
  at?: string;
  meta?: Record<string, unknown>;
  /** Dispose a live scope with a different sha before applying (default true). */
  replace?: boolean;
  /** Re-apply even when the sha matches (e.g. embedding model changed). */
  force?: boolean;
  /**
   * When replacing a document scope, keep chunks/embeddings in place so the
   * new apply can reuse unchanged content-addressed chunks (default: true for
   * kind 'doc').
   */
  keepProjectionOnReplace?: boolean;
  /** Write the ledger line (default true; rebuild's historical replays pass false). */
  log?: boolean;
  /**
   * Trust tier for everything this scope writes. Defaults to the actor's tier,
   * so an agent's own write is quarantined without every call site having to
   * remember to say so. A child of a quarantined scope is quarantined whatever
   * this says.
   */
  trust?: TrustTier;
  /** Actors allowed to read what this scope produced; empty = unrestricted. */
  acl?: string[];
}

export interface ApplyResult {
  scope: ScopeRow;
  outcome: 'applied' | 'unchanged';
  touched: TouchedSet;
  fold: FoldResult | null;
  propagation: Propagation;
  stats: WriterStats;
}

export interface DisposeOptions {
  actor?: string;
  reason: DisposeReason;
  at?: string;
  /** Leave chunks/embeddings for the replacing apply to reconcile. */
  keepProjection?: boolean;
  /** Write the ledger line (default true). */
  log?: boolean;
}

export interface DisposeResult {
  scope: ScopeRow;
  touched: TouchedSet;
  fold: FoldResult;
  propagation: Propagation;
  children: string[];
}

/** A scope disposed inside a transaction, with what is left to do once it commits. */
interface Disposed {
  scope: ScopeRow;
  reason: DisposeReason;
  seq: number;
  ts: string;
  fsInverses: InverseSpec[];
}

export function scopeRef(s: ScopeRow): LedgerScopeRef {
  return { id: s.id, kind: s.kind, key: s.key, sha: s.sha, parent: s.parent_id };
}

export async function findLiveScope(q: Queryable, kind: ScopeKind, key: string): Promise<ScopeRow | null> {
  const rows = await q.query<ScopeRow>(`SELECT * FROM scopes WHERE kind = $1 AND key = $2 AND status <> 'disposed' LIMIT 1`, [kind, key]);
  return rows[0] ? normalizeScope(rows[0]) : null;
}

export async function scopeById(q: Queryable, id: string): Promise<ScopeRow | null> {
  const rows = await q.query<ScopeRow>(`SELECT * FROM scopes WHERE id = $1`, [id]);
  return rows[0] ? normalizeScope(rows[0]) : null;
}

export async function liveChildren(q: Queryable, parentId: string): Promise<ScopeRow[]> {
  const rows = await q.query<ScopeRow>(
    `SELECT * FROM scopes WHERE parent_id = $1 AND status <> 'disposed' ORDER BY applied_at DESC, id DESC`,
    [parentId],
  );
  return rows.map(normalizeScope);
}

export async function scopesForKey(q: Queryable, kind: ScopeKind, key: string): Promise<ScopeRow[]> {
  const rows = await q.query<ScopeRow>(`SELECT * FROM scopes WHERE kind = $1 AND key = $2 ORDER BY applied_at DESC`, [kind, key]);
  return rows.map(normalizeScope);
}

function normalizeScope(row: ScopeRow): ScopeRow {
  return {
    ...row,
    applied_at: isoOf(row.applied_at),
    disposed_at: row.disposed_at ? isoOf(row.disposed_at) : null,
    meta: row.meta ?? {},
  };
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Apply a source. See module doc. `body` may run more than once (a
 * transaction Postgres rolls back for a deadlock runs again): it writes
 * through the writer, and whatever it counts outside starts over each time.
 */
export async function applyScope(
  store: Store,
  key: { kind: ScopeKind; key: string },
  sha: string,
  opts: ApplyOptions,
  body: (w: ScopeWriter) => Promise<void>,
): Promise<ApplyResult> {
  const actor = opts.actor ?? 'system';
  const unchanged = (scope: ScopeRow): ApplyResult =>
    ({ scope, outcome: 'unchanged', touched: emptyTouched(), fold: null, propagation: emptyPropagation(), stats: zeroStats() });
  const live = await findLiveScope(store, key.kind, key.key);
  if (live && live.sha === sha && !opts.force) return unchanged(live);

  const txTime = opts.at ?? new Date().toISOString();
  const id = crypto.createHash('sha256').update(`${key.kind}|${key.key}|${sha}|${txTime}|${opts.parentId ?? ''}`).digest('hex').slice(0, 24);
  const scope: ScopeRow = {
    id,
    kind: key.kind,
    key: key.key,
    sha,
    parent_id: opts.parentId ?? null,
    status: 'applying',
    actor,
    applied_at: txTime,
    disposed_at: null,
    meta: opts.meta ?? {},
  };
  let trust = opts.trust ?? tierForActor(actor);
  // a child — a document's tier-1 extraction, the prose on a generated page —
  // is what was read out of its parent, so it is never trusted above it:
  // otherwise a model reading an agent's quarantined note would turn its
  // claims into the knowledge base's position
  if (opts.parentId && trust !== 'quarantined') {
    const [parent] = await store.query<{ trust: TrustTier }>(`SELECT trust FROM scopes WHERE id = $1`, [opts.parentId]);
    if (parent?.trust === 'quarantined') trust = 'quarantined';
  }
  const acl = opts.acl ?? [];
  const ontology = loadOntology(store.dataDir);
  const fold = foldOptions(store.dataDir, ontology);

  let writer!: ScopeWriter;
  let seq = 0;
  let disposed: Disposed[] = [];
  const result = await store.tx(async (q): Promise<ApplyResult> => {
    disposed = [];
    // the ledger lock comes first in every transaction that folds entity rows
    // (dispose, purge, placeholder retirement too): scope transactions queue
    // on it instead of deadlocking on the entity rows they both fold
    await lockLedger(q);
    // the live version as of this transaction: a retry runs after whoever won the deadlock committed
    const current = await findLiveScope(q, key.kind, key.key);
    if (current && current.sha === sha && !opts.force) return unchanged(current);
    if (current && (opts.replace ?? true)) {
      await disposeTree(q, current, { reason: 'replaced', keepProjection: opts.keepProjectionOnReplace ?? key.kind === 'doc' }, txTime, fold, disposed);
    }
    await q.query(
      `INSERT INTO scopes (id, kind, key, sha, parent_id, status, actor, applied_at, meta, trust, acl)
       VALUES ($1, $2, $3, $4, $5, 'applying', $6, $7::timestamptz, $8::jsonb, $9, $10::jsonb)`,
      [id, scope.kind, scope.key, sha, scope.parent_id, actor, txTime, JSON.stringify(scope.meta), trust, JSON.stringify(acl)],
    );
    seq = await nextLedgerSeq(q);
    writer = new ScopeWriter(q, scope, txTime, store.dataDir, trust, ontology);
    await body(writer);
    const folded = await foldTouched(q, writer.touched, txTime, fold);
    const propagation = await propagate(q, folded.changed, folded.tombstoned, txTime);
    await q.query(`UPDATE scopes SET status = 'active' WHERE id = $1`, [id]);
    return { scope, outcome: 'applied', touched: writer.touched, fold: folded, propagation, stats: writer.stats };
  });
  if (result.outcome === 'unchanged') return result;
  scope.status = 'active';

  settleDisposed(store.dataDir, disposed, actor, opts.log);
  runFsOps(store.dataDir, writer.fsOps);
  if (opts.log ?? true) {
    appendLedger(store.dataDir, {
      seq,
      ts: txTime,
      ev: 'apply',
      actor,
      scope: scopeRef(scope),
      stats: { evidence: writer.stats.entities + writer.stats.relations + writer.stats.claims, effects: writer.stats.effects, chunks: writer.stats.chunks },
    });
  }
  return result;
}

/**
 * Dispose a scope: revert everything it produced, children first, in one
 * transaction — a dispose that fails leaves the whole tree live.
 */
export async function disposeScope(store: Store, scopeId: string, opts: DisposeOptions): Promise<DisposeResult | null> {
  const actor = opts.actor ?? 'system';
  const txTime = opts.at ?? new Date().toISOString();
  const fold = foldOptions(store.dataDir);
  let disposed: Disposed[] = [];
  const result = await store.tx(async (q) => {
    disposed = [];
    await lockLedger(q);
    const scope = await scopeById(q, scopeId);
    if (!scope || scope.status === 'disposed') return null;
    return disposeTree(q, scope, { reason: opts.reason, keepProjection: opts.keepProjection }, txTime, fold, disposed);
  });
  settleDisposed(store.dataDir, disposed, actor, opts.log);
  return result;
}

/** How every fold of one data dir runs: the ontology's type precedence, the words an alias may not be, a person's corrections. */
export function foldOptions(dataDir: string, ontology = loadOntology(dataDir)): FoldOptions {
  return { typePrecedence: typePrecedence(ontology), aliasStop: aliasStopKeys(dataDir), corrections: readEntityCorrections(dataDir) };
}

/** Dispose `scope` and its live children (first) inside an open transaction; what is left for after COMMIT goes to `out`. */
async function disposeTree(
  q: Queryable,
  scope: ScopeRow,
  opts: { reason: DisposeReason; keepProjection?: boolean },
  txTime: string,
  fold: FoldOptions,
  out: Disposed[],
): Promise<DisposeResult> {
  const children = await liveChildren(q, scope.id);
  for (const child of children) await disposeTree(q, child, { reason: opts.reason }, txTime, fold, out);

  const scopeId = scope.id;
  const touched = emptyTouched();
  const tombstoned = emptyTouched();
  const fsInverses: InverseSpec[] = [];
  // The document projection — chunks, the embeddings that cascade from them,
  // the documents row — belongs to the doc scope alone. A child (a tier-1
  // extraction, human prose on a generated page) names the document only to
  // find it: disposing one, or replacing it with a fresh extraction, must leave
  // the projection in place, or every vector of the document is paid for again.
  const documentId = scope.kind === 'doc' && typeof scope.meta.documentId === 'string' ? scope.meta.documentId : null;

  const ev = await q.query<{ kind: string; target_id: string }>(
    `UPDATE evidence SET tx_to = $2::timestamptz WHERE scope_id = $1 AND tx_to IS NULL RETURNING kind, target_id`,
    [scopeId, txTime],
  );
  for (const r of ev) {
    if (r.kind === 'entity') touched.entities.add(r.target_id);
    else if (r.kind === 'relation') touched.relations.add(r.target_id);
    else if (r.kind === 'claim') touched.claims.add(r.target_id);
  }
  const mentions = await q.query<{ entity_id: string }>(`DELETE FROM entity_mentions WHERE scope_id = $1 RETURNING entity_id`, [scopeId]);
  for (const m of mentions) touched.entities.add(m.entity_id);

  // capabilities, their locators and their notes are scope-owned: closing
  // them here is what retires a source's query surface along with the source;
  // so are a page's citations, which then stop listing it on the files it cited
  for (const table of ['capabilities', 'capability_notes', 'locators', 'citations']) {
    await q.query(`UPDATE ${table} SET tx_to = $2::timestamptz WHERE scope_id = $1 AND tx_to IS NULL`, [scopeId, txTime]);
  }
  // table facts are read from the document's text alone, so they keep no history of their own: the
  // document's versions are that history, and a re-parse writes them again (src/tables/store.ts)
  if (scope.kind === 'tables') await q.query(`DELETE FROM table_facts WHERE scope_id = $1`, [scopeId]);

  if (documentId && !opts.keepProjection) {
    await q.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);
    await q.query(`UPDATE documents SET status = 'disposed', scope_id = NULL, updated_at = now() WHERE id = $1`, [documentId]);
    touched.documents.add(scope.key);
    tombstoned.documents.add(scope.key);
  }

  const effects = await q.query<{ seq: number; kind: string; target: string; inverse: InverseSpec }>(
    `SELECT seq, kind, target, inverse FROM effects WHERE scope_id = $1 AND reverted_at IS NULL ORDER BY seq DESC`,
    [scopeId],
  );
  for (const e of effects) {
    await revertEffect(q, e.inverse, opts.reason, txTime, touched, tombstoned, fsInverses);
    await q.query(`UPDATE effects SET reverted_at = $2::timestamptz WHERE seq = $1`, [e.seq, txTime]);
  }

  const folded = await foldTouched(q, touched, txTime, fold);
  for (const d of tombstoned.documents) folded.tombstoned.documents.add(d);
  for (const d of tombstoned.datasets) folded.tombstoned.datasets.add(d);
  for (const d of touched.documents) folded.changed.documents.add(d);
  for (const d of touched.datasets) folded.changed.datasets.add(d);
  const propagation = await propagate(q, folded.changed, folded.tombstoned, txTime, { archive: opts.reason !== 'replaced' });

  await q.query(
    `UPDATE scopes SET status = 'disposed', disposed_at = $2::timestamptz, meta = meta || $3::jsonb WHERE id = $1`,
    [scopeId, txTime, JSON.stringify({ reason: opts.reason })],
  );
  out.push({ scope, reason: opts.reason, seq: await nextLedgerSeq(q), ts: txTime, fsInverses });
  return { scope: { ...scope, status: 'disposed', disposed_at: txTime }, touched, fold: folded, propagation, children: children.map((c) => c.id) };
}

/** After COMMIT, in dispose order (children first): file inverses, the attic move, the ledger line. */
function settleDisposed(dataDir: string, disposed: Disposed[], actor: string, log: boolean | undefined): void {
  for (const d of disposed) {
    runInverseFsOps(dataDir, d.fsInverses, d.reason);
    // a removed document's sidecar (paid extraction, usage history) goes to the
    // attic; the raw file itself is the user's and is never touched here
    let attic: string | null = null;
    if (d.scope.kind === 'doc' && d.reason === 'removed' && d.scope.key.startsWith(`${RAW_DOCS}/`)) {
      if (moveSidecarToAttic(dataDir, d.scope.key, d.scope.id)) attic = d.scope.id;
    }
    if (log ?? true) {
      appendLedger(dataDir, { seq: d.seq, ts: d.ts, ev: 'dispose', actor, scope: scopeRef(d.scope), reason: d.reason, attic });
    }
  }
}

async function revertEffect(
  q: Queryable,
  inv: InverseSpec,
  reason: DisposeReason,
  txTime: string,
  touched: TouchedSet,
  tombstoned: TouchedSet,
  fsInverses: InverseSpec[],
): Promise<void> {
  switch (inv.op) {
    case 'wiki_path.restore':
      await q.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [inv.entityId, inv.prev]);
      return;
    case 'row.restore': {
      if (inv.prev) {
        const p = inv.prev;
        await q.query(
          `UPDATE datasets SET source_id = $2, table_name = $3, kind = $4, columns = $5::jsonb, row_count = $6, schema_sha = $7,
                  description = $8, entity_count = $9, refreshed_at = $10, scope_id = $11, tx_from = $12::timestamptz, tx_to = $13
           WHERE id = $1`,
          [inv.id, p.source_id, p.table_name, p.kind, JSON.stringify(p.columns ?? []), p.row_count ?? null, p.schema_sha ?? '',
            p.description ?? '', p.entity_count ?? 0, p.refreshed_at ?? null, p.scope_id ?? null, p.tx_from ?? txTime, p.tx_to ?? null],
        );
        if (p.tx_to) tombstoned.datasets.add(inv.id);
      } else {
        await q.query(`UPDATE datasets SET tx_to = COALESCE(tx_to, $2::timestamptz), scope_id = NULL WHERE id = $1`, [inv.id, txTime]);
        tombstoned.datasets.add(inv.id);
      }
      touched.datasets.add(inv.id);
      return;
    }
    case 'queue.remove':
      await q.query(`DELETE FROM extraction_queue WHERE document_id = $1`, [inv.documentId]);
      return;
    case 'suggestion.retract':
      await q.query(`DELETE FROM suggestions WHERE id = $1 AND status = 'pending'`, [inv.id]);
      await q.query(`UPDATE suggestions SET status = 'stale' WHERE id = $1 AND status <> 'stale'`, [inv.id]);
      return;
    case 'deps.restore':
      await writeDeps(q, { kind: inv.artifactKind, id: inv.artifactId }, inv.prev);
      return;
    case 'entity_link.remove': {
      const [link] = await q.query<{ canonical_id: string }>(`SELECT canonical_id FROM entity_links WHERE id = $1`, [inv.linkId]);
      await q.query(`UPDATE entity_links SET tx_to = $2::timestamptz WHERE id = $1 AND tx_to IS NULL`, [inv.linkId, txTime]);
      await q.query(`UPDATE entities SET canonical_id = $2 WHERE id = $1`, [inv.entityId, inv.prevCanonical]);
      touched.entities.add(inv.entityId);
      if (link?.canonical_id) touched.entities.add(link.canonical_id);
      return;
    }
    case 'claim_link.remove': {
      const [link] = await q.query<{ canonical_id: string }>(`SELECT canonical_id FROM claim_links WHERE id = $1`, [inv.linkId]);
      await q.query(`UPDATE claim_links SET tx_to = $2::timestamptz WHERE id = $1 AND tx_to IS NULL`, [inv.linkId, txTime]);
      await q.query(`UPDATE claims SET canonical_id = $2 WHERE id = $1`, [inv.claimId, inv.prevCanonical]);
      // the members it brought along go back to it, unless something else regrouped them since;
      // a group grows with the corpus, so its members go as one array parameter
      if (link?.canonical_id && inv.regrouped.length > 0) {
        await q.query(`UPDATE claims SET canonical_id = $1 WHERE canonical_id = $2 AND id = ANY($3::text[])`, [inv.claimId, link.canonical_id, inv.regrouped]);
      }
      touched.claims.add(inv.claimId);
      for (const id of inv.regrouped) touched.claims.add(id);
      if (link?.canonical_id) touched.claims.add(link.canonical_id);
      return;
    }
    case 'page.restore': {
      if (reason === 'archived' || !inv.prev) {
        await q.query(
          `UPDATE pages SET status = 'archived', scope_id = NULL, tx_to = COALESCE(tx_to, $2::timestamptz) WHERE path = $1`,
          [inv.path, txTime],
        );
      } else {
        const p = inv.prev;
        await q.query(
          `UPDATE pages SET kind = $2, scope_id = $3, generator = $4, inputs_sha = $5, file_sha = $6, regions = $7::jsonb,
                  status = $8, dirty_reason = $9::jsonb, tx_from = $10::timestamptz, tx_to = $11
           WHERE path = $1`,
          [inv.path, p.kind, p.scope_id ?? null, p.generator, p.inputs_sha, p.file_sha ?? null, JSON.stringify(p.regions ?? []),
            p.status ?? 'active', p.dirty_reason ? JSON.stringify(p.dirty_reason) : null, p.tx_from ?? txTime, p.tx_to ?? null],
        );
      }
      return;
    }
    case 'file.delete':
    case 'file.restore':
    case 'region.restore':
      if (reason !== 'replaced') fsInverses.push(inv);
      return;
    default:
      return;
  }
}

/** Archive location for a page file: wiki/x.md → wiki/.archive/x.md. */
export function archivedPath(rel: string): string {
  if (rel.startsWith('wiki/')) return `wiki/.archive/${rel.slice('wiki/'.length)}`;
  const dir = path.posix.dirname(rel);
  return `${dir === '.' ? '' : dir + '/'}.archive/${path.posix.basename(rel)}`;
}

function runInverseFsOps(dataDir: string, inverses: InverseSpec[], reason: DisposeReason): void {
  for (const inv of inverses) {
    if (inv.op === 'file.delete') {
      const abs = safePath(dataDir, inv.path);
      if (!fs.existsSync(abs)) continue;
      if (reason === 'archived') {
        const dst = safePath(dataDir, archivedPath(inv.path));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(abs, dst);
      } else {
        fs.rmSync(abs, { force: true });
      }
    } else if (inv.op === 'file.restore') {
      const content = readBlob(dataDir, inv.blob);
      const abs = safePath(dataDir, inv.path);
      if (reason === 'archived') {
        if (fs.existsSync(abs)) {
          const dst = safePath(dataDir, archivedPath(inv.path));
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.renameSync(abs, dst);
        }
        if (content !== null) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
        }
      } else if (content !== null) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    } else if (inv.op === 'region.restore') {
      const abs = safePath(dataDir, inv.path);
      if (!fs.existsSync(abs)) continue;
      const current = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, replaceRegion(current, inv.region, inv.prev));
    }
  }
}

export interface OrphanResult {
  /** The documents row was tombstoned here (its chunks and embeddings dropped). */
  tombstoned: boolean;
  chunks: number;
  /** Attic entry the sidecar moved to (the document's last scope id). */
  attic: string | null;
  propagation: Propagation;
}

/**
 * Dispose what is left of a removed document that no live scope owns: its
 * search projection and, under raw/docs, its sidecar. A re-index that failed
 * half way left this behind while a replace still ran as two transactions —
 * the old version disposed as 'replaced' (which keeps chunks, embeddings and
 * the documents row for the new apply), the new version never committed —
 * and once the source is gone no dispose ever comes for it. This does what
 * the document scope's own dispose would have: drop the chunks, tombstone the
 * row, fold the entities its mentions touched, archive the pages that
 * required it, and move the sidecar to the attic under the document's last
 * scope (or, with no scope to file it under, keep it if it holds paid work).
 * Returns null while a live scope owns the key.
 */
export async function disposeOrphanDocument(
  store: Store,
  key: string,
  opts: { actor?: string; at?: string; log?: boolean } = {},
): Promise<OrphanResult | null> {
  const scopes = await scopesForKey(store, 'doc', key);
  if (scopes.some((s) => s.status !== 'disposed')) return null;
  const [last] = scopes;
  const actor = opts.actor ?? 'system';
  const txTime = opts.at ?? new Date().toISOString();
  const [doc] = await store.query<{ id: string }>(
    `SELECT d.id FROM documents d
     WHERE d.path = $1 AND (d.status <> 'disposed' OR EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id))`,
    [key],
  );
  const dropped = !doc ? null : await store.tx(async (q) => {
    await lockLedger(q);
    if (await findLiveScope(q, 'doc', key)) return 'live' as const; // applied since the caller looked
    const touched = emptyTouched();
    const tombstoned = emptyTouched();
    const mentioned = await q.query<{ entity_id: string }>(
      `SELECT DISTINCT m.entity_id FROM chunks c JOIN entity_mentions m ON m.chunk_id = c.id WHERE c.document_id = $1`,
      [doc.id],
    );
    for (const m of mentioned) touched.entities.add(m.entity_id);
    const chunks = await q.query<{ id: string }>(`DELETE FROM chunks WHERE document_id = $1 RETURNING id`, [doc.id]);
    await q.query(`UPDATE documents SET status = 'disposed', scope_id = NULL, updated_at = now() WHERE id = $1`, [doc.id]);
    touched.documents.add(key);
    tombstoned.documents.add(key);
    const fold = await foldTouched(q, touched, txTime, foldOptions(store.dataDir));
    for (const d of tombstoned.documents) fold.tombstoned.documents.add(d);
    const propagation = await propagate(q, fold.changed, fold.tombstoned, txTime);
    return { chunks: chunks.length, propagation, seq: last ? await nextLedgerSeq(q) : 0 };
  });
  if (dropped === 'live') return null;

  // the sidecar takes the way a removal's would; an attic entry the last scope
  // already has (it was removed once before) is never overwritten
  let attic: string | null = null;
  if (key.startsWith(`${RAW_DOCS}/`) && fs.existsSync(sidecarDir(store.dataDir, key))) {
    if (last && !hasAtticSidecar(store.dataDir, last.id) && moveSidecarToAttic(store.dataDir, key, last.id)) attic = last.id;
    else if (!sidecarHoldsPaidWork(store.dataDir, key)) removeSidecar(store.dataDir, key);
  }
  if (last && (dropped || attic) && (opts.log ?? true)) {
    const seq = dropped?.seq || (await nextLedgerSeq(store));
    appendLedger(store.dataDir, { seq, ts: txTime, ev: 'dispose', actor, scope: scopeRef(last), reason: 'removed', attic });
  }
  return { tombstoned: Boolean(dropped), chunks: dropped?.chunks ?? 0, attic, propagation: dropped?.propagation ?? emptyPropagation() };
}

export interface PurgeResult {
  purged: string[];
  orphansRemoved: { claims: number; relations: number; entities: number };
}

/** Physically erase a disposed scope (and its disposed children). Live scopes are refused. */
export async function purgeScope(store: Store, scopeId: string, opts: { actor?: string } = {}): Promise<PurgeResult> {
  const scope = await scopeById(store, scopeId);
  if (!scope) throw new Error(`unknown scope ${scopeId}`);
  if (scope.status !== 'disposed') throw new Error(`scope ${scopeId} is live — remove the source and sync before purging`);
  const purged: string[] = [];
  const children = await store.query<ScopeRow>(`SELECT * FROM scopes WHERE parent_id = $1`, [scopeId]);
  for (const child of children) {
    if (child.status !== 'disposed') throw new Error(`child scope ${child.id} is live`);
    const res = await purgeScope(store, child.id, opts);
    purged.push(...res.purged);
  }
  const blobs = await store.query<{ inverse: InverseSpec }>(`SELECT inverse FROM effects WHERE scope_id = $1`, [scopeId]);
  let seq = 0;
  let orphans = { claims: 0, relations: 0, entities: 0 };
  await store.tx(async (q) => {
    await lockLedger(q);
    await q.query(`DELETE FROM evidence WHERE scope_id = $1`, [scopeId]);
    await q.query(`DELETE FROM effects WHERE scope_id = $1`, [scopeId]);
    await q.query(`DELETE FROM entity_mentions WHERE scope_id = $1`, [scopeId]);
    await q.query(`DELETE FROM scopes WHERE id = $1`, [scopeId]);
    orphans = await gcOrphanRows(q);
    seq = await nextLedgerSeq(q);
  });
  for (const b of blobs) {
    if (b.inverse.op === 'file.restore') removeBlob(store.dataDir, b.inverse.blob);
  }
  removeAtticSidecar(store.dataDir, scopeId);
  appendLedger(store.dataDir, { seq, ts: new Date().toISOString(), ev: 'purge', actor: opts.actor ?? 'system', scope: scopeRef(scope) });
  purged.push(scopeId);
  return { purged, orphansRemoved: orphans };
}

/** Delete graph rows that no evidence (live or historical) supports any more. */
export async function gcOrphanRows(q: Queryable): Promise<{ claims: number; relations: number; entities: number }> {
  const claims = await q.query<{ id: string }>(
    `DELETE FROM claims c WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'claim' AND e.target_id = c.id) RETURNING id`,
  );
  const relations = await q.query<{ id: string }>(
    `DELETE FROM relations r WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'relation' AND e.target_id = r.id) RETURNING id`,
  );
  const entities = await q.query<{ id: string }>(
    `DELETE FROM entities x
     WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'entity' AND e.target_id = x.id)
       AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = x.id OR r.target_id = x.id)
       AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.subject_id = x.id OR c.object_id = x.id)
       AND NOT EXISTS (SELECT 1 FROM entity_mentions m WHERE m.entity_id = x.id)
     RETURNING id`,
  );
  return { claims: claims.length, relations: relations.length, entities: entities.length };
}

function zeroStats(): WriterStats {
  return { entities: 0, relations: 0, claims: 0, mentions: 0, chunks: 0, effects: 0, capabilities: 0, locators: 0, citations: 0, unknownPredicates: 0 };
}
