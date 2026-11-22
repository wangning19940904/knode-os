import { Queryable, RELATION_SOURCES_META } from '../store/migrations.js';
import { groupBy, RELATION_SOURCE_RULE, relationSource, RelationSupporter, scopeDocuments } from '../store/temporal.js';
import { propagate } from './deps.js';
import { lockLedger } from './ledger.js';
import { emptyTouched } from './types.js';

/**
 * A relation's stored source (`relations.document_id`, `chunk_id`) is written
 * by the fold, and a relation only folds again when one of its supporters
 * changes. So whenever the rule that picks the source changes
 * (`RELATION_SOURCE_RULE`), and for the rows written before v20 that have none,
 * every live relation's source is read again here, once, in place, in the
 * background after `Store.open` — as the claim types are when their mapping
 * changes (./claim-types.ts). Nothing is extracted or applied again: the rule
 * is read over the evidence the index already holds.
 *
 * Rule 2 (2026-11-21): the earliest-dated document that states the relation,
 * then by path, where rule 1 took the supporter written first. Only
 * `document_id` and `chunk_id` are written — not tx_from, weight or fold_sha —
 * and only on the rows whose source reads otherwise now. The pages that
 * depend on a relation whose document moved are marked dirty, since an entity
 * page names that document on the relation's line; the next reconcile plans
 * them again without a model. A relation no document supports (a merge's, a
 * person's) keeps none.
 */

export interface RelationSourcesResult {
  /** Relations whose stored source was written: a document for a row that had none, or another document or passage. */
  relations: number;
  /** Relations read. */
  read: number;
  /** Of `relations`, those that cite another document now (not counting rows that had none). */
  moved: number;
  /** Pages marked dirty for them. */
  pages: number;
  batches: number;
  seconds: number;
}

interface SourcesStore extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

interface SourcesMeta {
  pending?: boolean;
  rule?: number;
  /** Where a stopped pass under `rule` got to: the last relation id it read. */
  cursor?: string;
}

const current = (meta: SourcesMeta | undefined) => meta?.pending === false && meta.rule === RELATION_SOURCE_RULE;

/**
 * Whether the live relations' sources were stored under another rule, or not
 * at all. A store with no live relation has nothing to read again and records
 * the rule at once, before `open` returns, so a fresh store starts no
 * background pass beside its first writes.
 */
export async function relationSourcesStale(store: SourcesStore): Promise<boolean> {
  if (current(await store.getMeta<SourcesMeta>(RELATION_SOURCES_META))) return false;
  const [live] = await store.query<{ one: number }>(`SELECT 1 AS one FROM relations WHERE tx_to IS NULL LIMIT 1`);
  if (live) return true;
  await store.setMeta(RELATION_SOURCES_META, { pending: false, rule: RELATION_SOURCE_RULE, finishedAt: new Date().toISOString(), relations: 0 });
  return false;
}

/**
 * Read the source of every live relation again, `batch` relations per
 * transaction, keyed forward by id. Each transaction takes the ledger lock
 * first, as scope transactions do: an apply folding the same relation
 * meanwhile would otherwise have its newer choice overwritten by one read
 * from the evidence as it was before. Stopped (`close`), it records where it
 * got to and the next open goes on from there; relations written meanwhile
 * get their source from their own fold.
 */
export async function refreshRelationSources(
  store: SourcesStore,
  opts: { batch?: number; log?: (line: string) => void; stop?: () => boolean } = {},
): Promise<RelationSourcesResult | null> {
  const meta = await store.getMeta<SourcesMeta>(RELATION_SOURCES_META);
  if (current(meta)) return null;
  const batch = Math.max(1, Math.floor(opts.batch ?? 2_000));
  const log = opts.log ?? ((line: string) => console.log(`[knode-os] ${line}`));
  const started = Date.now();
  const result: RelationSourcesResult = { relations: 0, read: 0, moved: 0, pages: 0, batches: 0, seconds: 0 };
  let last = meta?.rule === RELATION_SOURCE_RULE && typeof meta.cursor === 'string' ? meta.cursor : '';
  let lastLog = started;
  for (;;) {
    if (opts.stop?.()) {
      result.seconds = (Date.now() - started) / 1000;
      // an open closed before the first batch (a one-off command) has nothing to record or say
      if (result.batches > 0) {
        await store.setMeta(RELATION_SOURCES_META, { pending: true, rule: RELATION_SOURCE_RULE, cursor: last });
        log(`relation sources paused after ${result.read} relations (${result.relations} written), ${result.seconds.toFixed(1)} s; the next open resumes it`);
      }
      return result;
    }
    const page = await store.tx(async (q) => {
      await lockLedger(q);
      const rows = await q.query<{ id: string; document_id: string | null; chunk_id: string | null }>(
        `SELECT id, document_id, chunk_id FROM relations WHERE tx_to IS NULL AND id > $1 ORDER BY id LIMIT $2`,
        [last, batch],
      );
      if (rows.length === 0) return null;
      const ids = rows.map((r) => r.id);
      const evidence = groupBy(
        // only what the rule reads: a hub relation's supporters number thousands, each with its attrs
        await q.query<RelationSupporter & { target_id: string }>(
          `SELECT target_id, scope_id, segment_id, extractor
           FROM evidence WHERE kind = 'relation' AND target_id = ANY($1::text[]) AND tx_to IS NULL`,
          [ids],
        ),
        (r) => r.target_id,
      );
      const docs = await scopeDocuments(q, [...evidence.values()].flatMap((list) => list.map((r) => r.scope_id)));
      const write: { id: string; doc: string | null; chunk: string | null }[] = [];
      // what a page shows is the document: a relation citing another one now has its pages planned again. A row
      // with none stored counts too, since the page read its source from the evidence, by the rule as it was
      const replan = emptyTouched();
      let moved = 0;
      for (const r of rows) {
        const source = relationSource(evidence.get(r.id) ?? [], docs);
        const doc = source?.documentId ?? null;
        const chunk = source?.chunkId ?? null;
        if (doc === r.document_id && chunk === r.chunk_id) continue;
        write.push({ id: r.id, doc, chunk });
        if (doc === r.document_id) continue;
        replan.relations.add(r.id);
        if (r.document_id !== null) moved++;
      }
      // a passage whose chunk is gone stays empty, as the fold leaves it: only rows that read otherwise are written
      const written = write.length === 0 ? [] : await q.query<{ id: string }>(
        `UPDATE relations r SET document_id = u.doc, chunk_id = c.id
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, doc, chunk) LEFT JOIN chunks c ON c.id = u.chunk
         WHERE r.id = u.id AND r.tx_to IS NULL AND (r.document_id IS DISTINCT FROM u.doc OR r.chunk_id IS DISTINCT FROM c.id)
         RETURNING r.id`,
        [write.map((w) => w.id), write.map((w) => w.doc), write.map((w) => w.chunk)],
      );
      const dirty = replan.relations.size ? (await propagate(q, replan, emptyTouched(), new Date().toISOString())).dirtyPages.length : 0;
      return { last: ids[ids.length - 1], read: rows.length, written: written.length, moved, dirty };
    });
    if (!page) break;
    last = page.last;
    result.read += page.read;
    result.relations += page.written;
    result.moved += page.moved;
    result.pages += page.dirty;
    result.batches++;
    if (Date.now() - lastLog >= 2000) {
      lastLog = Date.now();
      log(`relation sources: ${result.read} relations read, ${result.relations} written, ${((lastLog - started) / 1000).toFixed(1)} s`);
    }
  }
  result.seconds = (Date.now() - started) / 1000;
  await store.setMeta(RELATION_SOURCES_META, { pending: false, rule: RELATION_SOURCE_RULE, finishedAt: new Date().toISOString(), ...result });
  if (result.relations > 0) {
    log(`relation sources: ${result.relations} of ${result.read} relations given the document rule ${RELATION_SOURCE_RULE} picks (${result.moved} cite another document now, ${result.pages} pages to plan again; ${result.batches} batches, ${result.seconds.toFixed(1)} s)`);
  }
  return result;
}
