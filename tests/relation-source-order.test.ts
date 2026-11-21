import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { passageDocuments } from '../src/eval/systems/knode.js';
import { applyTier1Scope } from '../src/graph/tier1.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { sync } from '../src/ingest/sync.js';
import { recountAll } from '../src/lineage/fold.js';
import type { LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { RELATION_SOURCES_META } from '../src/store/migrations.js';
import { RELATION_SOURCE_RULE } from '../src/store/temporal.js';
import { generateWiki } from '../src/wiki/generate.js';
import { reconcileViews, regeneratePage } from '../src/wiki/pages.js';
import { walkRelations } from '../src/search/walk.js';

/**
 * The document a relation cites depends on the corpus alone: of the documents
 * that state it, the earliest by date, then the first by path
 * (src/store/temporal.ts relationSource). It used to be the one whose
 * extraction was written first, so two builds of one corpus cited different
 * documents on the same entity page, and an evaluation that maps a page to the
 * documents it cites scored `knode-ask`'s retrieval differently from build to
 * build (tests/eval-workspaces.test.ts failed about two runs in three).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-relation-order-'));
const open: AppContext[] = [];
afterAll(async () => {
  for (const c of open) {
    await c.datasources.closeAll();
    await c.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every file under `dir`, by its path from there; a generated page without the time it was written at. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8').replace(/^( +at: )'[^']+'$/gm, "$1'<when>'");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/*
 * Four documents state that 林晓 works at 澜舟科技: two of one day (the path
 * orders them), a later one, and one that states no date and whose path sorts
 * before all the others. The chat makes no claim, so an entity page names it
 * only as the relation's source.
 */
const UNDATED = 'raw/docs/about.md';
const CHAT = 'raw/docs/chat/2026-03-05.md';
const EMAIL = 'raw/docs/email/2026-03-05.md';
const DIARY = 'raw/docs/diary/2026-03-20.md';
const CORPUS: Record<string, { body: string; claim?: string }> = {
  [UNDATED]: { body: '# 关于林晓\n\n林晓是数据工程师，在澜舟科技工作，住在苏州。', claim: '林晓住在苏州' },
  [CHAT]: { body: '# 微信 · 林晓 与 周敏\n\n林晓：我要去澜舟科技了，四月一日入职。' },
  [EMAIL]: { body: '# 邮件 · 澜舟科技人事部 → 林晓\n\n确认林晓的岗位为高级数据工程师，入职澜舟科技。', claim: '林晓在澜舟科技的岗位是高级数据工程师' },
  [DIARY]: { body: '# 日记\n\n林晓在星河数据的最后一天，下个月去澜舟科技。', claim: '林晓离开了星河数据' },
};
const RELATION = { source: '林晓', target: '澜舟科技', type: 'works_at', description: '入职' };

/** Apply a document's extraction, as a document pass does once its model has answered. */
async function extract(ctx: AppContext, file: string, claim?: string): Promise<void> {
  const documentId = documentIdFor(file);
  const [doc] = await ctx.store.query<{ sha256: string; doc_date: string | Date | null }>(`SELECT sha256, doc_date FROM documents WHERE id = $1`, [documentId]);
  const chunkIds = await ctx.store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [documentId]);
  const res = await applyTier1Scope(
    ctx.store,
    { path: file, sha256: doc.sha256 },
    { documentId, path: file, title: path.basename(file), chunkIds },
    {
      entities: [{ name: '林晓', type: 'person', description: '数据工程师' }, { name: '澜舟科技', type: 'organization', description: '林晓的新公司' }],
      relations: [RELATION],
      claims: claim ? [{ subject: '林晓', statement: claim, type: 'other', status: 'fact', kind: 'fact' }] : [],
    },
    { model: 'test-model', docDate: doc.doc_date ? new Date(doc.doc_date).toISOString() : null },
  );
  expect(res.outcome).toBe('applied');
}

function write(ctx: AppContext, file: string, content: string): void {
  const abs = path.join(ctx.dataDir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A workspace whose documents were indexed and extracted one after the other, in `order`; then its wiki, indexed as a build's is. */
async function build(name: string, order: string[]): Promise<AppContext> {
  const ctx = await createContext(path.join(tmp, name));
  open.push(ctx);
  for (const file of order) {
    write(ctx, file, `${CORPUS[file].body}\n`);
    await sync(ctx, { llmGraph: false, datasources: false });
    await extract(ctx, file, CORPUS[file].claim);
  }
  await generateWiki(ctx.store, ctx.llm, { config: ctx.config, embedder: ctx.embedder });
  await reconcileViews(ctx, { llm: false });
  await sync(ctx, { llmGraph: false, datasources: false });
  return ctx;
}

async function reopen(ctx: AppContext): Promise<AppContext> {
  await ctx.datasources.closeAll();
  await ctx.store.close();
  open.splice(open.indexOf(ctx), 1);
  const again = await createContext(ctx.dataDir);
  open.push(again);
  return again;
}

type Stored = { type: string; document_id: string | null; chunk_document: string | null; source_path: string | null };
const stored = (ctx: AppContext) => ctx.store.query<Stored>(
  `SELECT r.type, r.document_id, c.document_id AS chunk_document, v.source_path
   FROM relations r JOIN v_relations v ON v.id = r.id LEFT JOIN chunks c ON c.id = r.chunk_id WHERE r.tx_to IS NULL ORDER BY r.id`,
);
/** The order the relation's supporters were written in: what its source used to follow. */
const written = async (ctx: AppContext) => (await ctx.store.query<{ key: string }>(
  `SELECT s.key FROM evidence ev JOIN scopes s ON s.id = ev.scope_id WHERE ev.kind = 'relation' AND ev.tx_to IS NULL ORDER BY ev.tx_from, ev.id`,
)).map((r) => r.key);
const entityPage = (ctx: AppContext, id: string) => fs.readFileSync(path.join(ctx.dataDir, 'wiki', 'entities', `${id}.md`), 'utf8');
/** The relation's line on an entity page (the other end is a link once it has a page of its own). */
const cites = (file: string) => new RegExp(`^- (works at → (\\[\\[)?澜舟科技(\\]\\])?|(\\[\\[)?林晓(\\]\\])? → works at): 入职 — ${file.replace(/[.]/g, '\\.')}$`, 'm');

/**
 * What `knode-ask` reports as an answer's `retrieved` (src/eval/systems/knode.ts sentDocuments): the documents of
 * the passages and facts `ask` would put before its model, a generated page counting for the documents it cites.
 */
async function retrieved(ctx: AppContext, question: string): Promise<string[]> {
  const pageSources = new Map<string, string[]>();
  for (const [rel, raw] of Object.entries(tree(path.join(ctx.dataDir, 'wiki')))) {
    if (!rel.endsWith('.md')) continue;
    pageSources.set(`wiki/${rel}`, [...new Set([...raw.matchAll(/raw\/docs\/[^\s)\]'"`，。]+/g)].map((m) => m[0].slice('raw/docs/'.length)))]);
  }
  const noModel = Object.defineProperty(Object.create(ctx.llm) as LlmClient, 'enabled', { value: false });
  const res = await ask(ctx.store, ctx.config, ctx.embedder, noModel, question, { mode: 'hybrid', track: false });
  const known = new Set(Object.keys(CORPUS).map((p) => p.slice('raw/docs/'.length)));
  return [...new Set([
    ...res.contexts.flatMap((c) => passageDocuments(c.path, c.content, pageSources, known)),
    ...res.facts.flatMap((f) => (f.path ? passageDocuments(f.path, '', pageSources, known) : [])),
  ])];
}

describe('the document a relation cites, whatever order the documents were processed in', () => {
  let forward: AppContext;
  let backward: AppContext;
  beforeAll(async () => {
    forward = await build('forward', [CHAT, EMAIL, DIARY, UNDATED]);
    backward = await build('backward', [UNDATED, DIARY, EMAIL, CHAT]);
  }, 240_000);

  it('is the earliest by date, then by path, and a document without a date comes last', async () => {
    expect(await written(forward)).toEqual([CHAT, EMAIL, DIARY, UNDATED]);
    expect(await written(backward)).toEqual([UNDATED, DIARY, EMAIL, CHAT]);
    const expected = [{ type: 'works_at', document_id: documentIdFor(CHAT), chunk_document: documentIdFor(CHAT), source_path: CHAT }];
    expect(await stored(forward)).toEqual(expected);
    expect(await stored(backward)).toEqual(expected);
  });

  it('gives the same wiki pages', () => {
    const a = tree(path.join(forward.dataDir, 'wiki'));
    const b = tree(path.join(backward.dataDir, 'wiki'));
    expect(Object.keys(a).length).toBeGreaterThan(3);
    expect(entityPage(forward, '林晓')).toMatch(cites(CHAT));
    expect(entityPage(forward, '澜舟科技')).toMatch(cites(CHAT));
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const file of Object.keys(a)) expect(b[file], file).toBe(a[file]);
  });

  it('gives the relation walk the same passage', async () => {
    const passages = async (ctx: AppContext) => {
      const walk = await walkRelations(ctx.store, '林晓在哪家公司工作', ['林晓'], { maxHops: 1 });
      return [...walk.steps.map((s) => [s.path, s.description]), ...walk.bridges.map((p) => [p.path, p.content])];
    };
    const a = await passages(forward);
    expect(a.map((x) => x[0])).toEqual([CHAT, CHAT]);
    expect(await passages(backward)).toEqual(a);
  });

  it('gives knode-ask the same retrieved documents', async () => {
    for (const question of ['林晓在哪家公司工作？', '林晓的岗位是什么？', '澜舟科技']) {
      const a = await retrieved(forward, question);
      expect(a.length, question).toBeGreaterThan(0);
      expect(await retrieved(backward, question), question).toEqual(a);
    }
    // the chat makes no claim: a page counts for it only through the relation it is cited for
    expect(await retrieved(forward, '林晓在哪家公司工作？')).toContain('chat/2026-03-05.md');
  });

  it('is read from the evidence the same way while none is stored', async () => {
    // a relation written before sources were stored, in a build nothing has gone over yet (one opened read-only):
    // the page, the walk and the view's readers pick the document the fold would
    const before = await stored(backward);
    await backward.store.query(`UPDATE relations SET document_id = NULL, chunk_id = NULL`);
    try {
      await regeneratePage(backward, 'wiki/entities/林晓.md', 'entity_stub');
      expect(entityPage(backward, '林晓')).toMatch(cites(CHAT));
      const walk = await walkRelations(backward.store, '林晓在哪家公司工作', ['林晓'], { maxHops: 1 });
      expect(walk.steps.map((s) => s.path)).toEqual([CHAT]);
      expect(walk.bridges.map((p) => p.path)).toEqual([CHAT]);
      expect(await retrieved(backward, '林晓在哪家公司工作？')).toEqual(await retrieved(forward, '林晓在哪家公司工作？'));
    } finally {
      await backward.store.tx((q) => recountAll(q));
    }
    expect(await stored(backward)).toEqual(before);
  });

  it('moves in place on an index built under the old rule: nothing is extracted again', async () => {
    // an index from before the rule: the relation cites the supporter written first, its pages say so, and the
    // store records its sources as done without naming a rule
    const first = documentIdFor(UNDATED);
    await backward.store.query(`UPDATE relations SET document_id = $1, chunk_id = (SELECT id FROM chunks WHERE document_id = $1 ORDER BY seq LIMIT 1)`, [first]);
    for (const p of ['wiki/entities/林晓.md', 'wiki/entities/澜舟科技.md']) await regeneratePage(backward, p, 'entity_stub');
    expect(entityPage(backward, '林晓')).toMatch(cites(UNDATED));
    expect(entityPage(backward, '澜舟科技')).toMatch(cites(UNDATED));
    await backward.store.setMeta(RELATION_SOURCES_META, { pending: false, finishedAt: '2026-11-15T00:00:00.000Z', relations: 1, batches: 1, seconds: 0 });
    const evidence = await backward.store.query(`SELECT id::text, scope_id, tx_from, tx_to FROM evidence ORDER BY id`);
    const folds = await backward.store.query(`SELECT id, fold_sha, weight, tx_from FROM relations ORDER BY id`);

    backward = await reopen(backward);
    expect(await backward.store.relationSources).toMatchObject({ relations: 1, read: 1, moved: 1, pages: 2 });
    expect(await backward.store.getMeta(RELATION_SOURCES_META)).toMatchObject({ pending: false, rule: RELATION_SOURCE_RULE });
    expect(await stored(backward)).toEqual(await stored(forward));
    // only the source moved: no evidence row opened or closed, the relation's fold and its transaction time as they were
    expect(await backward.store.query(`SELECT id::text, scope_id, tx_from, tx_to FROM evidence ORDER BY id`)).toEqual(evidence);
    expect(await backward.store.query(`SELECT id, fold_sha, weight, tx_from FROM relations ORDER BY id`)).toEqual(folds);
    expect(await backward.store.query(`SELECT 1 FROM extraction_queue`)).toEqual([]);
    // the pages that name the relation's document are planned again, without a model
    const dirty = (await backward.store.query<{ path: string }>(`SELECT path FROM pages WHERE status = 'dirty' ORDER BY path`)).map((r) => r.path);
    expect(dirty).toEqual(['wiki/entities/林晓.md', 'wiki/entities/澜舟科技.md']);
    await reconcileViews(backward, { llm: false });
    expect(entityPage(backward, '林晓')).toMatch(cites(CHAT));
    expect(entityPage(backward, '澜舟科技')).toMatch(cites(CHAT));
    // a full refold agrees with what the pass stored
    await backward.store.tx((q) => recountAll(q));
    expect(await stored(backward)).toEqual(await stored(forward));
    // done for this rule: the next open starts nothing
    backward = await reopen(backward);
    expect(await backward.store.relationSources).toBeNull();
  }, 120_000);

  it('follows a document that is applied again with another date', async () => {
    // the diary now says it was written before the chat and the email: it is the earliest that states the relation
    write(forward, DIARY, `---\ndate: 2026-03-01\n---\n${CORPUS[DIARY].body}\n`);
    await sync(forward, { llmGraph: false, datasources: false });
    // its old extraction went with its old text
    expect((await stored(forward)).map((r) => r.source_path)).toEqual([CHAT]);
    await extract(forward, DIARY);
    expect((await stored(forward)).map((r) => r.source_path)).toEqual([DIARY]);
    await reconcileViews(forward, { llm: false });
    expect(entityPage(forward, '林晓')).toMatch(cites(DIARY));
  }, 120_000);
});

describe('a document re-dated in place', () => {
  const DATED = 'raw/docs/notes/plan.md';
  const DATELINE = 'raw/docs/notes/minutes.md';
  const declares = `entities:
  - { name: 支付组, type: organization }
  - { name: 结算中台, type: project }
relations:
  - { source: 支付组, target: 结算中台, type: related_to, description: 支付组推进结算中台 }`;

  it('takes or gives up the relations it is the earliest to state', async () => {
    const ctx = await createContext(path.join(tmp, 'redated'));
    open.push(ctx);
    write(ctx, DATED, `---\ntitle: 计划\ndate: 2026-02-10\n${declares}\n---\n支付组推进结算中台。\n`);
    // dated by the line at its top alone
    write(ctx, DATELINE, `---\ntitle: 纪要\n${declares}\n---\n2026-01-05\n\n支付组推进结算中台。\n`);
    await sync(ctx, { llmGraph: false, datasources: false });
    expect((await stored(ctx)).map((r) => r.source_path)).toEqual([DATELINE]);
    await generateWiki(ctx.store, ctx.llm, { config: ctx.config, embedder: ctx.embedder });

    // as it stood under rules that read no dateline: the minutes had no date, so the plan was cited
    await ctx.store.query(`UPDATE documents SET doc_date = NULL WHERE id = $1`, [documentIdFor(DATELINE)]);
    await ctx.store.query(`UPDATE scopes SET meta = meta - 'dateRules' WHERE kind = 'doc' AND key = $1`, [DATELINE]);
    await ctx.store.tx((q) => recountAll(q));
    expect((await stored(ctx)).map((r) => r.source_path)).toEqual([DATED]);
    const page = () => fs.readFileSync(path.join(ctx.dataDir, 'wiki', 'entities', '支付组.md'), 'utf8');
    await regeneratePage(ctx, 'wiki/entities/支付组.md', 'entity_stub');
    expect(page()).toContain(`— ${DATED}`);

    // the next sync reads its date again and re-dates it in place: the relation cites it again, and its pages follow
    const evidence = await ctx.store.query(`SELECT id::text, scope_id, tx_from, tx_to FROM evidence ORDER BY id`);
    await sync(ctx, { llmGraph: false, datasources: false });
    expect((await stored(ctx)).map((r) => r.source_path)).toEqual([DATELINE]);
    expect(await ctx.store.query(`SELECT id::text, scope_id, tx_from, tx_to FROM evidence ORDER BY id`)).toEqual(evidence);
    await reconcileViews(ctx, { llm: false });
    expect(page()).toContain(`— ${DATELINE}`);
  }, 120_000);
});
