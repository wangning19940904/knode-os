import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { readDeps } from '../src/lineage/deps.js';
import { citedPathCandidates, planCitationDeps } from '../src/lineage/page-deps.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { citationChanges, fileCitationRefreshes, wikiSuggestionId } from '../src/research/cited-refresh.js';
import { getJob } from '../src/research/jobs.js';
import { queueFromSuggestion } from '../src/research/recommend.js';
import { templateFor } from '../src/research/templates.js';
import { prepareRunWorkspace } from '../src/research/workspace.js';

/**
 * Design 37 §5: an agent page's citations of raw/codebase and raw/docs files
 * become `deps` rows; a changed or removed cited file files one refresh
 * suggestion for the page — never a re-render or an archive — whose reason
 * counts the files and names the commits, and whose job brief lists them; a
 * page left alone for enough repository updates gets an audit.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-citation-deps-'));
const dataDir = path.join(tmp, 'ws');
let ctx: AppContext;

const C1 = '4f1c2ab9d0e1f00000000000000000000000000a';
const C2 = '9d0e7719aa11f00000000000000000000000000b';
const C3 = 'c3c3c3c3c3c3f00000000000000000000000000c';

const PAGE = 'wiki/code/acme-tool/resuming-a-session.md';
const OTHER = 'wiki/research/acme-overview.md';
const HUMAN = 'wiki/notes/acme-notes.md';
const A = 'raw/codebase/acme-tool/src/a.ts';
const B = 'raw/codebase/acme-tool/src/b.ts';
const C = 'raw/codebase/acme-tool/src/c.ts';
const D = 'raw/codebase/acme-tool/src/d.ts';
const README = 'raw/codebase/acme-tool/README.md';
const DESIGN = 'raw/docs/notes/design.md';
const CARD = 'raw/docs/codebase/acme-tool.md';

function write(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function card(commit: string): string {
  return `---\ntitle: "acme/tool"\ntype: repository\ncodebase: raw/codebase/acme-tool\ncommit: ${commit}\ntags: [codebase]\n---\n# acme/tool\n\nA tool at ${commit.slice(0, 7)}.\n`;
}

function agentPage(commit: string, extra = ''): string {
  return `---
type: concept
title: Resuming a session
aliases: [continue a conversation]
repositories:
  - { name: acme-tool, commit: ${commit} }
sources: [${DESIGN}]
actor: agent/claude-cli
research: { job: r_seed, kind: section, template: section, at: "2026-11-20T00:00:00Z", agent: claude-cli }
---
## What it does

A session is resumed from its rollout file（来源：${A}#L1-L5）.

## Path

The loader reads the file (Source: ${B}#L2; ${C}).
The card describes the layout (${CARD}). A file that is not there: ${'raw/codebase/acme-tool/src/missing.ts'}#L9.
${extra}`;
}

async function suggestionsFor(page: string) {
  return ctx.store.query<{ id: string; status: string; title: string; payload: Record<string, any> }>(
    `SELECT id, status, title, payload FROM suggestions WHERE kind = 'wiki' AND payload->>'target' = $1`,
    [page],
  );
}

beforeAll(async () => {
  write(A, 'export function resume() {\n  return 1;\n}\n');
  write(B, 'export function load() {\n  return 2;\n}\n');
  write(C, 'export const c = 3;\n');
  write(D, 'export const d = 4;\n');
  write(README, '# acme tool\n\nNothing cites this file.\n');
  write(DESIGN, '---\ntitle: Design notes\n---\n# Design notes\n\nResume reads the rollout.\n');
  write(CARD, card(C1));
  write(PAGE, agentPage(C1));
  write(OTHER, `---\ntype: concept\ntitle: Acme overview\nactor: agent/codex-cli\nresearch: { job: r_o, kind: entity, at: "2026-11-20T00:00:00Z" }\n---\n# Acme overview\n\nThe d module holds a constant（来源：${D}）。\n`);
  write(HUMAN, `---\ntitle: My notes on acme\n---\n# My notes\n\nI read ${A} myself.\n`);
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('citations become dependencies', () => {
  it('reads every way an agent cites a file, with or without a line range', () => {
    const text = [
      `（来源：${A}#L12-L40）`,
      `(Source: ${B}#L2; raw/docs/x/y.pdf).`,
      `"source": "raw/docs/z.md",`,
      `see [the appendix](../../raw/docs/papers/d1-appendix.md#e-4171ba2c)`,
      `- raw/codebase/acme-tool/src/c.ts`,
      `.sidecar/raw/docs/p.pdf/content.md`,
      `a word like myraw/docs/not.md is not one`,
    ].join('\n');
    expect(citedPathCandidates(text)).toEqual([
      A, B, 'raw/docs/x/y.pdf', 'raw/docs/z.md', 'raw/docs/papers/d1-appendix.md', C, '.sidecar/raw/docs/p.pdf/content.md',
    ]);
  });

  it('writes one required:false deps row per cited document with its content hash, and records the commit', async () => {
    const deps = await readDeps(ctx.store, { kind: 'page', id: PAGE });
    expect(deps.map((d) => d.input_id)).toEqual([DESIGN, A, B, C].sort());
    expect(deps.every((d) => d.input_kind === 'document' && d.required === false)).toBe(true);
    const docs = new Map((await ctx.store.query<{ path: string; sha256: string }>(`SELECT path, sha256 FROM documents`)).map((r) => [r.path, r.sha256]));
    for (const d of deps) expect(d.input_sha).toBe(docs.get(d.input_id));
    // the card is never a dependency (it changes on every commit); the missing file resolves to nothing
    expect(deps.some((d) => d.input_id === CARD)).toBe(false);
    const plan = await planCitationDeps(ctx.store, dataDir, fs.readFileSync(path.join(dataDir, PAGE), 'utf8'));
    expect(plan.unresolved).toEqual(['raw/codebase/acme-tool/src/missing.ts']);
    const scope = await findLiveScope(ctx.store, 'doc', PAGE);
    expect(scope!.meta.citedCommits).toEqual({ 'acme-tool': C1 });
    // a person's page depends on what it cites too; a page no generator owns has no pages row
    expect((await readDeps(ctx.store, { kind: 'page', id: HUMAN })).map((d) => d.input_id)).toEqual([A]);
    expect(await ctx.store.query(`SELECT path FROM pages WHERE path = ANY($1::text[])`, [[PAGE, OTHER, HUMAN]])).toEqual([]);
  });

  it('a page applied before citations were dependencies gets them on the next ordinary sync', async () => {
    await ctx.store.query(`DELETE FROM deps WHERE artifact_id = $1`, [OTHER]);
    await ctx.store.query(`UPDATE scopes SET meta = meta - 'citeDeps' WHERE kind = 'doc' AND key = $1 AND status = 'active'`, [OTHER]);
    await sync(ctx, { llmGraph: false });
    expect((await readDeps(ctx.store, { kind: 'page', id: OTHER })).map((d) => d.input_id)).toEqual([D]);
  });

  it('a rebuild produces the same rows, although wiki pages are applied before the repositories', async () => {
    const all = async () => ctx.store.query(`SELECT artifact_kind, artifact_id, input_kind, input_id, required, input_sha FROM deps WHERE artifact_kind = 'page' ORDER BY artifact_id, input_id`);
    const before = await all();
    expect(before.length).toBe(6);
    await rebuild(ctx, {});
    expect(await all()).toEqual(before);
    expect(await suggestionsFor(PAGE)).toEqual([]);
  });
});

describe('a changed cited file files a refresh suggestion', () => {
  it('an unrelated file changing files nothing', async () => {
    write(README, '# acme tool\n\nStill nobody cites this.\n');
    await sync(ctx, { llmGraph: false });
    expect(await ctx.store.query(`SELECT id FROM suggestions WHERE kind = 'wiki'`)).toEqual([]);
    expect(await citationChanges(ctx.store, dataDir)).toEqual([]);
  });

  it('two changed files of a repository update give one suggestion that counts them and names both commits', async () => {
    const pageBefore = fs.readFileSync(path.join(dataDir, PAGE), 'utf8');
    const scopeBefore = await findLiveScope(ctx.store, 'doc', PAGE);
    write(A, 'export function resume(id: string) {\n  return id.length;\n}\n');
    write(B, 'export function load() {\n  return 22;\n}\n');
    write(CARD, card(C2));
    await sync(ctx, { only: ['raw/codebase/acme-tool', CARD], llmGraph: false });

    const [s, ...more] = await suggestionsFor(PAGE);
    expect(more).toEqual([]);
    expect(s.id).toBe(wikiSuggestionId('refresh', PAGE));
    expect(s.status).toBe('pending');
    expect(s.payload.kind).toBe('refresh');
    expect(s.payload.reasons).toEqual(['acme-tool：引用的 3 个文件中 2 个在 4f1c2ab 与 9d0e771 之间改变']);
    expect(s.payload.citations.changed).toEqual([A, B]);
    expect(s.payload.citations.removed).toEqual([]);
    expect(s.payload.citations.repositories).toEqual([{ name: 'acme-tool', from: C1, to: C2, cited: 3, changed: 2, removed: 0 }]);

    // not re-rendered, not archived, not even marked: the page and its scope are as they were
    expect(fs.readFileSync(path.join(dataDir, PAGE), 'utf8')).toBe(pageBefore);
    expect((await findLiveScope(ctx.store, 'doc', PAGE))!.id).toBe(scopeBefore!.id);
    expect(await ctx.store.query(`SELECT path FROM pages WHERE path = $1`, [PAGE])).toEqual([]);
    // a person's page and an agent page citing none of them get nothing
    expect(await suggestionsFor(HUMAN)).toEqual([]);
    expect(await suggestionsFor(OTHER)).toEqual([]);

    // the next sync brings the same suggestion up to date instead of adding one
    await sync(ctx, { llmGraph: false });
    expect((await suggestionsFor(PAGE)).length).toBe(1);
  });

  it('a removed cited file gives the stronger reason first and archives nothing', async () => {
    fs.rmSync(path.join(dataDir, C));
    await sync(ctx, { only: ['raw/codebase/acme-tool'], llmGraph: false });
    const [s, ...more] = await suggestionsFor(PAGE);
    expect(more).toEqual([]);
    expect(s.payload.reasons).toEqual([
      'acme-tool：引用的 3 个文件中 1 个在 4f1c2ab 与 9d0e771 之间被删除，页面可能在描述已经不存在的代码',
      'acme-tool：引用的 3 个文件中 2 个在 4f1c2ab 与 9d0e771 之间改变',
    ]);
    expect(s.payload.citations.removed).toEqual([C]);
    expect(s.payload.score).toBeGreaterThan(0.8);
    expect((await findLiveScope(ctx.store, 'doc', PAGE))!.status).toBe('active');
    expect(fs.existsSync(path.join(dataDir, PAGE))).toBe(true);
    const [doc] = await ctx.store.query<{ status: string }>(`SELECT status FROM documents WHERE path = $1`, [PAGE]);
    expect(doc.status).not.toBe('disposed');
  });

  it('accepting queues one refresh job whose brief lists the files and the commits; an open job is not duplicated', async () => {
    const [s] = await suggestionsFor(PAGE);
    const { job, created } = await queueFromSuggestion(ctx, s.payload, 'test');
    expect(created).toBe(true);
    await ctx.store.query(`UPDATE suggestions SET status = 'accepted' WHERE id = $1`, [s.id]);
    expect((await getJob(ctx.store, job.id))!.payload.citations.changed).toEqual([A, B]);

    // more changes while the job waits: nothing new is filed for the page
    write(A, 'export function resume(id: string) {\n  return id.length + 1;\n}\n');
    await sync(ctx, { only: [A], llmGraph: false });
    expect((await suggestionsFor(PAGE)).map((x) => x.status)).toEqual(['accepted']);

    const run = await prepareRunWorkspace(ctx, job, templateFor(dataDir, 'refresh'), {
      runsDir: '.runs', provider: 'claude-cli', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', headers: {} }, readDirs: ['raw/codebase'], seed: '',
    });
    const brief = fs.readFileSync(run.briefPath, 'utf8');
    expect(run.outputPath).toBe(PAGE);
    expect(brief).toContain('## 引用的文件已变化');
    expect(brief).toContain(`本页核对于 \`${C1}\`，镜像现在是 \`${C2}\``);
    expect(brief).toContain(`### 改变的文件\n\n- \`${A}\`\n- \`${B}\``);
    expect(brief).toContain(`### 已删除的文件\n\n- \`${C}\``);
    expect(brief).toContain('repositories: [{ name, commit }]');
    expect(brief).not.toContain('审计');
    const schema = fs.readFileSync(path.join(run.dir, 'CLAUDE.md'), 'utf8');
    expect(schema).toContain('引用的文件已变化');
    await ctx.store.query(`UPDATE research_jobs SET status = 'failed' WHERE id = $1`, [job.id]);
  });

  it('a decided suggestion is not reopened by the same state, but is by a new change', async () => {
    const id = wikiSuggestionId('refresh', PAGE);
    // the job failed; the accepted suggestion recorded the state before A changed again, so the next pass files it again
    await fileCitationRefreshes(ctx);
    expect((await suggestionsFor(PAGE))[0].status).toBe('pending');
    await ctx.store.query(`UPDATE suggestions SET status = 'rejected' WHERE id = $1`, [id]);
    const again = await fileCitationRefreshes(ctx);
    expect(again.filed).not.toContain(id);
    expect((await suggestionsFor(PAGE))[0].status).toBe('rejected');
    write(B, 'export function load() {\n  return 23;\n}\n');
    await sync(ctx, { only: [B], llmGraph: false });
    expect((await suggestionsFor(PAGE))[0].status).toBe('pending');
  });

  it('a refreshed page depends on the files as they are now, and its pending suggestion goes stale', async () => {
    write(PAGE, agentPage(C2, '\nThe loader no longer reads c.\n').replace(`; ${C})`, ')'));
    await sync(ctx, { only: [PAGE], llmGraph: false });
    expect((await readDeps(ctx.store, { kind: 'page', id: PAGE })).map((d) => d.input_id)).toEqual([DESIGN, A, B].sort());
    expect(await citationChanges(ctx.store, dataDir, { pages: [PAGE] })).toEqual([]);
    expect((await suggestionsFor(PAGE)).map((x) => x.status)).toEqual(['stale']);
  });
});

describe('the audit', () => {
  it('files a suggestion after the configured number of repository updates without a rewrite, and none when off', async () => {
    ctx.config.research.auditAfterUpdates = 0;
    write(CARD, card(C3));
    await sync(ctx, { only: [CARD], llmGraph: false });
    write(CARD, card(C1));
    await sync(ctx, { only: [CARD], llmGraph: false });
    expect(await suggestionsFor(OTHER)).toEqual([]);

    ctx.config.research.auditAfterUpdates = 3;
    // OTHER was applied before three card versions (C2, C3, C1); PAGE was rewritten after C2, so it has seen two
    await fileCitationRefreshes(ctx, { prefixes: [CARD] });
    const [s, ...more] = await suggestionsFor(OTHER);
    expect(more).toEqual([]);
    expect(s.payload.reasons).toEqual(['acme-tool 自本页写成后更新了 3 次，本页一直没有刷新：从头重列入口']);
    expect(s.payload.citations.audit).toEqual({ repository: 'acme-tool', updates: 3 });
    expect(s.payload.citations.changed).toEqual([]);
    expect((await suggestionsFor(PAGE)).map((x) => x.status)).toEqual(['stale']);

    const { job } = await queueFromSuggestion(ctx, s.payload, 'test');
    const run = await prepareRunWorkspace(ctx, job, templateFor(dataDir, 'refresh'), {
      runsDir: '.runs', provider: 'claude-cli', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', headers: {} }, readDirs: ['raw/codebase'], seed: '',
    });
    const brief = fs.readFileSync(run.briefPath, 'utf8');
    expect(brief).toContain('**审计**');
    expect(brief).toContain('从头搜索并列出所有入口');
    ctx.config.research.auditAfterUpdates = 30;
  });
});
