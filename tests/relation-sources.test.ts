import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { sync } from '../src/ingest/sync.js';
import { recountAll } from '../src/lineage/fold.js';
import { refreshRelationSources } from '../src/lineage/relation-sources.js';
import { RELATION_SOURCES_META } from '../src/store/migrations.js';
import { relationSource } from '../src/store/temporal.js';

/**
 * A relation names the document it cites (relations.document_id) and the
 * passage (relations.chunk_id), as a claim does: of its live supporters whose
 * scope read a document, the one of the earliest-dated document, then by path
 * (tests/relation-source-order.test.ts builds one corpus in two orders). The
 * writer grounds a relation the extractor gave no passage to in the first
 * chunk mentioning both ends. Rows written before get their document from a
 * batched pass at open, which agrees with the fold.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-relation-sources-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const report = (date: string, body: string) => `---
title: 支付组周报
date: ${date}
entities:
  - { name: 支付组, type: organization }
  - { name: 结算中台, type: project }
  - { name: 孙欣, type: person }
  - { name: 风控引擎, type: project }
relations:
  - { source: 支付组, target: 结算中台, type: related_to, description: 支付组推进结算中台 }
  - { source: 孙欣, target: 支付组, type: member_of }
  - { source: 支付组, target: 风控引擎, type: related_to, description: 支付组对接风控引擎 }
---
${body}
`;

const FIRST = 'raw/docs/周报/支付组/2025-03-07.md';
const SECOND = 'raw/docs/周报/支付组/2025-03-14.md';

type Rel = { id: string; document_id: string | null; chunk_id: string | null; fold_sha: string };
const relations = (c: AppContext) =>
  c.store.query<Rel>(`SELECT id, document_id, chunk_id, fold_sha FROM relations WHERE tx_to IS NULL ORDER BY id`);
/** A workspace from before v20: no document or passage on the rows, and evidence written without a passage. */
async function asBefore(c: AppContext): Promise<void> {
  await c.store.query(`UPDATE relations SET document_id = NULL, chunk_id = NULL`);
  await c.store.query(`UPDATE evidence SET segment_id = NULL WHERE kind = 'relation'`);
  await c.store.setMeta(RELATION_SOURCES_META, { pending: true });
}

describe('the source of a relation', () => {
  it('is the earliest document that states it, grounded to the passage naming both ends', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, FIRST, report('2025-03-07', '支付组推进结算中台，对接风控引擎。孙欣在支付组。'));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    // a later report repeating every link: two supporters each, the first report stays the source
    write(dataDir, SECOND, report('2025-03-14', '支付组继续推进结算中台，对接风控引擎。孙欣在支付组。'));
    await sync(ctx, { llmGraph: false });

    const rows = await relations(ctx);
    expect(rows).toHaveLength(3);
    const [{ n }] = await ctx.store.query<{ n: number }>(`SELECT min(c)::int AS n FROM (SELECT count(*) AS c FROM evidence WHERE kind = 'relation' AND tx_to IS NULL GROUP BY target_id) x`);
    expect(n).toBe(2);
    for (const r of rows) {
      expect(r.document_id).toBe(documentIdFor(FIRST));
      const [chunk] = await ctx.store.query<{ document_id: string; content: string }>(`SELECT document_id, content FROM chunks WHERE id = $1`, [r.chunk_id]);
      expect(chunk.document_id).toBe(documentIdFor(FIRST));
      expect(chunk.content).toContain('支付组');
    }
    const view = await ctx.store.query<{ source_path: string }>(`SELECT source_path FROM v_relations`);
    expect(view.map((v) => v.source_path)).toEqual([FIRST, FIRST, FIRST]);
  });

  it('is filled in for relations written before, page by page, resumably, as the fold would', async () => {
    const c = ctx!;
    const folded = await relations(c);
    await asBefore(c);
    // stopped after one page of one relation: the rest waits for the next open
    let pages = 0;
    const stopped = await refreshRelationSources(c.store, { batch: 1, log: () => {}, stop: () => pages++ >= 1 });
    expect(stopped).toMatchObject({ relations: 1, read: 1, batches: 1 });
    expect((await relations(c)).filter((r) => r.document_id).length).toBe(1);
    // it says where it stopped, so the next open goes on from there
    expect(await c.store.getMeta(RELATION_SOURCES_META)).toMatchObject({ pending: true, cursor: folded[0].id });
    // resumed: a page per relation, the earlier report of two supporters each, as the fold chose
    const resumed = await refreshRelationSources(c.store, { batch: 1, log: () => {} });
    expect(resumed).toMatchObject({ relations: 2, read: 2, batches: 2 });
    const filled = await relations(c);
    expect(filled.map((r) => r.document_id)).toEqual(folded.map((r) => r.document_id));
    // the passage was never recorded for those: it stays empty until the document is applied again
    expect(filled.map((r) => r.chunk_id)).toEqual([null, null, null]);
    expect(filled.map((r) => r.fold_sha)).toEqual(folded.map((r) => r.fold_sha));
    // done: the next open does nothing
    expect(await refreshRelationSources(c.store, { log: () => {} })).toBeNull();
    // a full refold agrees with the fill
    await c.store.tx((q) => recountAll(q));
    expect((await relations(c)).map((r) => [r.document_id, r.fold_sha])).toEqual(folded.map((r) => [r.document_id, r.fold_sha]));
  });

  it('is never a generated page: the prose scope of a knode page is no source', async () => {
    const c = ctx!;
    const [rel] = await relations(c);
    // a wiki-human scope (the prose on a generated page) supporting the relation before either report
    await c.store.query(
      `INSERT INTO scopes (id, kind, key, sha, status, actor, applied_at, meta) VALUES ('wikihuman1', 'wiki-human', 'wiki/entities/支付组.md', 'x', 'active', 'sync', '2000-01-01T00:00:00Z', $1::jsonb)`,
      [JSON.stringify({ documentId: documentIdFor(SECOND) })],
    );
    await c.store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from) VALUES ('relation', $1, 'wikihuman1', 1, 'human', '{}'::jsonb, '2000-01-01T00:00:00Z')`,
      [rel.id],
    );
    await asBefore(c);
    await refreshRelationSources(c.store, { log: () => {} });
    expect((await relations(c)).find((r) => r.id === rel.id)!.document_id).toBe(documentIdFor(FIRST));
    await c.store.tx((q) => recountAll(q));
    expect((await relations(c)).find((r) => r.id === rel.id)!.document_id).toBe(documentIdFor(FIRST));
    await c.store.query(`DELETE FROM evidence WHERE scope_id = 'wikihuman1'`);
    await c.store.query(`DELETE FROM scopes WHERE id = 'wikihuman1'`);
  });

  it('moves to the next document when the first goes', async () => {
    const c = ctx!;
    fs.rmSync(path.join(c.dataDir, FIRST));
    await sync(c, { llmGraph: false });
    const after = await relations(c);
    expect(after.map((r) => r.document_id)).toEqual([documentIdFor(SECOND), documentIdFor(SECOND), documentIdFor(SECOND)]);
  });

  it('picks by the documents, never by when a supporter was written', () => {
    const ev = (scope: string, tx: string, segment: string | null, extractor = 'x') => ({ kind: 'relation', target_id: 'r', scope_id: scope, segment_id: segment, weight: 1, extractor, attrs: {}, tx_from: tx });
    const doc = (id: string, p: string, date: string | null, kind = 'tier1') => ({ documentId: id, key: p, path: p, date, kind });
    const docs = new Map([
      ['march', doc('d-march', 'raw/docs/b.md', '2025-03-01T00:00:00.000Z')],
      ['may', doc('d-may', 'raw/docs/a.md', '2025-05-01T00:00:00.000Z')],
      ['may-too', doc('d-may-too', 'raw/docs/c.md', '2025-05-01T00:00:00.000Z')],
      ['undated', doc('d-undated', 'raw/docs/0.md', null)],
      ['march-own', doc('d-march', 'raw/docs/b.md', '2025-03-01T00:00:00.000Z', 'doc')],
    ]);
    // a merge or a person's edit read no document: never the source
    expect(relationSource([ev('m', '2025-01-01T00:00:00Z', null), ev('may', '2025-02-01T00:00:00Z', 'c1')], docs)).toEqual({ documentId: 'd-may', chunkId: 'c1' });
    expect(relationSource([ev('m', '2025-01-01T00:00:00Z', null)], docs)).toBeNull();
    // the earliest document date, whichever supporter was written first and in whatever order they are read
    const three = [ev('may', '2025-01-01T00:00:00Z', 'c1'), ev('undated', '2025-01-02T00:00:00Z', 'c0'), ev('march', '2025-06-01T00:00:00Z', 'c2')];
    expect(relationSource(three, docs)).toEqual({ documentId: 'd-march', chunkId: 'c2' });
    expect(relationSource([...three].reverse(), docs)).toEqual({ documentId: 'd-march', chunkId: 'c2' });
    // one date: the path orders them; no date: after every dated document
    expect(relationSource([ev('may-too', '2025-01-01T00:00:00Z', 'c3'), ev('may', '2025-02-01T00:00:00Z', 'c1')], docs)).toEqual({ documentId: 'd-may', chunkId: 'c1' });
    expect(relationSource([ev('undated', '2025-01-01T00:00:00Z', 'c0'), ev('may-too', '2025-02-01T00:00:00Z', 'c3')], docs)).toEqual({ documentId: 'd-may-too', chunkId: 'c3' });
    // within one document: its own scope before its extraction, then a grounded supporter, then the passage id
    const one = [ev('march', '2025-01-01T00:00:00Z', 'c9'), ev('march-own', '2025-02-01T00:00:00Z', null), ev('march', '2025-01-01T00:00:00Z', 'c2', 'w')];
    expect(relationSource(one, docs)).toEqual({ documentId: 'd-march', chunkId: null });
    expect(relationSource([ev('march', '2025-03-01T00:00:00Z', null), ev('march', '2025-01-01T00:00:00Z', 'c9'), ev('march', '2025-02-01T00:00:00Z', 'c2')], docs)).toEqual({ documentId: 'd-march', chunkId: 'c2' });
  });
});
