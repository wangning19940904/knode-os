import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { LEARNED_DIR, learnConfig } from '../src/learn/config.js';
import { attributeOf, periodOf } from '../src/learn/facts.js';
import { answerFigures, declaredScale, figureOnLine, numbersIn } from '../src/learn/numbers.js';
import { learnedPathFor, readLearnedPage } from '../src/learn/page.js';
import { checkCitation, parseSourceRef } from '../src/learn/verify.js';
import { learnSuggestionId, writeBack } from '../src/learn/writeback.js';
import { readDeps } from '../src/lineage/deps.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { applySuggestion } from '../src/pack/learn.js';
import { search } from '../src/search/search.js';

/**
 * Learning from use (docs/design/38 §4): an answer written back as a learned
 * question page and derived facts, each cited value checked on its line;
 * waiting for review by default, taking effect at once when auto-accept is on
 * and every check passed; withdrawn or moved when a cited document changes.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-learn-'));
const dataDir = path.join(tmp, 'ws');
let ctx: AppContext;

const REPORT = 'raw/docs/filings/acme-2023.md';
const TEN_K = 'raw/docs/filings/zenith-10k.md';

const reportText = (revenue = '12,345.67') => `---
title: 澄海科技 2023 年年度报告
entities:
  - { name: 澄海科技, type: organization }
---
# 澄海科技 2023 年年度报告

## 合并利润表

单位：万元

| 项目 | 2023 年 | 2022 年 |
| --- | --- | --- |
| 营业收入 | ${revenue} | 10,020.00 |
| 营业成本 | 8,001.50 | 7,100.25 |
| 净利润 | 1,502.30 | 1,210.00 |

研发人员 312 人，岗位以算法工程师为主。
`;

const tenK = `---
title: Zenith Holdings annual report (Form 10-K)
entities:
  - { name: Zenith Holdings, type: organization }
---
# Zenith Holdings 10-K

CONSOLIDATED STATEMENTS OF OPERATIONS (in thousands, except per share data)

Total revenue 4,200 3,900
Net loss (1,234) (980)
Basic loss per share $(0.91) $(0.75)
`;

function write(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const exists = (rel: string) => fs.existsSync(path.join(dataDir, rel));

async function derivedClaims() {
  return ctx.store.query<{ statement: string; attribute: string | null; value_num: number | null; unit: string | null; source_path: string }>(
    `SELECT statement, attribute, value_num, unit, source_path FROM v_claims WHERE source_path LIKE $1 ORDER BY statement`,
    [`${LEARNED_DIR}/%`],
  );
}

async function found(query: string): Promise<string[]> {
  return (await search(ctx.store, ctx.embedder, query, { k: 10, mode: 'keyword', track: false })).map((h) => h.path);
}

beforeAll(async () => {
  write(REPORT, reportText());
  write(TEN_K, tenK);
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('numbers as answers and lines write them', () => {
  it('reads separators, magnitude words, negatives in parentheses, and leaves dates out', () => {
    const [a] = answerFigures('营业收入为 1.23 亿元');
    expect([a.mantissa, a.magnitude, a.unit]).toEqual([1.23, 1e8, '元']);
    const [b] = numbersIn('Net loss (1,234)');
    expect(b.mantissa).toBe(1234);
    expect(answerFigures('2023 年第一季度，截至 2024-05-01，共 9 人').map((n) => n.mantissa)).toEqual([9]);
    expect(answerFigures('$4.2 million')[0].magnitude).toBe(1e6);
  });

  it('matches at the written scale, the declared scale of the table, and the rounding either allows', () => {
    const lines = reportText().split('\n');
    const row = lines.findIndex((l) => l.includes('营业收入'));
    expect(declaredScale(lines, row)).toBe(1e4);
    expect(figureOnLine(answerFigures('12,345.67万元')[0], lines[row], 1e4)?.how).toBe('exact');
    expect(figureOnLine(answerFigures('123,456,700 元')[0], lines[row], 1e4)?.how).toBe('exact');
    expect(figureOnLine(answerFigures('1.23 亿元')[0], lines[row], 1e4)?.how).toBe('exact');
    // the same digits with no declared unit are a guess, never a pass
    expect(figureOnLine(answerFigures('123,456,700')[0], '| 营业收入 | 12,345.67 |', 1)?.how).toBe('scale-guess');
    expect(figureOnLine(answerFigures('12,999')[0], lines[row], 1e4)).toBeNull();
  });

  it('reads the period and the attribute a question asks for without a model', () => {
    expect(periodOf('澄海科技2023年第一季度的营业收入是多少？')?.period).toBe('2023Q1');
    expect(periodOf('What was total revenue in fiscal 2023?')?.period).toBe('2023');
    expect(periodOf('截至2024年5月1日，杭州平台组的连接池上限是多少？')?.period).toBe('2024-05-01');
    expect(attributeOf('澄海科技2023年的营业收入是多少？', '澄海科技', '2023年')).toBe('营业收入');
    expect(attributeOf('英力特的公允价值变动收益是多少？', null, null)).toBe('公允价值变动收益');
    expect(attributeOf('What is the Basic Earnings Per Share of Zenith Holdings?', 'Zenith Holdings', null)).toBe('basic earnings per share');
  });
});

describe('the check on the cited line', () => {
  const figure = (s: string) => ({ figure: answerFigures(s)[0] });

  it('passes a value on its cited line, and fails a wrong line, a missing line and a missing document', () => {
    const row = reportText().split('\n').findIndex((l) => l.includes('营业收入')) + 1;
    expect(parseSourceRef(`filings/acme-2023.md#L${row}`)).toEqual({ path: REPORT, line: row, lineTo: row });
    expect(checkCitation(dataDir, parseSourceRef(`${REPORT}#L${row}`)!, figure('12,345.67万元'))).toMatchObject({ ok: true, reason: 'ok', located: false, scale: 1e4 });
    expect(checkCitation(dataDir, parseSourceRef(`${REPORT}#L${row + 1}`)!, figure('12,345.67万元'))).toMatchObject({ ok: false, reason: 'line-mismatch' });
    expect(checkCitation(dataDir, parseSourceRef(`${REPORT}#L900`)!, figure('12,345.67万元')).reason).toBe('no-such-line');
    expect(checkCitation(dataDir, parseSourceRef('raw/docs/nope.md#L1')!, figure('1')).reason).toBe('no-document');
  });

  it('locates a value its citation gave no line for only on a line naming the attribute', () => {
    const c = checkCitation(dataDir, parseSourceRef(REPORT)!, figure('8,001.50万元'), { attribute: '营业成本' });
    expect(c).toMatchObject({ ok: true, located: true });
    expect(c.lineText).toContain('营业成本');
    // the value is there, under another attribute: not this one
    expect(checkCitation(dataDir, parseSourceRef(REPORT)!, figure('8,001.50万元'), { attribute: '净利润' }).ok).toBe(false);
    // an English 10-K's declared thousands
    expect(checkCitation(dataDir, parseSourceRef(TEN_K)!, figure('$4.2 million'), { attribute: 'total revenue' })).toMatchObject({ ok: true, located: true, scale: 1e3 });
  });
});

describe('writing an answer back', () => {
  const answer = '澄海科技 2023 年营业收入为 12,345.67 万元 [doc: filings/acme-2023.md]。\nFinal answer: 12,345.67万元';
  const question = '澄海科技2023年的营业收入是多少？';

  it('does nothing while learning is off (the default)', async () => {
    expect(learnConfig(ctx.config).enabled).toBe(false);
    const r = await writeBack(ctx, { question, answer, citations: [REPORT], origin: 'ask' });
    expect(r.status).toBe('disabled');
    expect(exists(LEARNED_DIR)).toBe(false);
    expect((await ctx.store.query(`SELECT id FROM suggestions WHERE kind = 'learn'`)).length).toBe(0);
  });

  it('waits for review by default: a learn suggestion outside the index, which nothing reads until a person accepts it', async () => {
    ctx.config.learn = { enabled: true };
    const r = await writeBack(ctx, { question, answer, citations: ['filings/acme-2023.md'], origin: 'ask' });
    expect(r).toMatchObject({ status: 'pending', verified: true, path: learnedPathFor(question) });
    expect(r.facts).toEqual([expect.objectContaining({ subject: '澄海科技', attribute: '营业收入', period: '2023', value: 123456700, unit: '元', scale: 1e4 })]);
    expect(exists(r.path!)).toBe(false);
    expect(await found('营业收入 12,345.67')).not.toContain(r.path);
    expect(await derivedClaims()).toEqual([]);
    const [s] = await ctx.store.query<{ id: string; status: string; payload: { path: string; content: string } }>(`SELECT id, status, payload FROM suggestions WHERE kind = 'learn'`);
    expect(s).toMatchObject({ id: learnSuggestionId(r.path!), status: 'pending' });
    expect(s.payload.path).toBe(r.path);

    // accepted: written, indexed, read by search and as a claim with its measure
    expect(await applySuggestion(ctx.store, dataDir, s.id)).toEqual({ applied: true, path: r.path });
    await sync(ctx, { only: [r.path!], llmGraph: false });
    expect(await found('澄海科技 营业收入')).toContain(r.path);
    const claims = await derivedClaims();
    expect(claims).toEqual([expect.objectContaining({ attribute: '营业收入', value_num: 123456700, unit: '元', source_path: r.path })]);
    fs.rmSync(path.join(dataDir, r.path!));
    await sync(ctx, { only: [r.path!], llmGraph: false });
    expect(await derivedClaims()).toEqual([]);
  });

  it('with auto-accept on, a write-back whose every check passed takes effect at once; one that failed still waits', async () => {
    ctx.config.learn = { enabled: true, autoAccept: true };
    const ok = await writeBack(ctx, { question, answer, citations: [REPORT], origin: 'ask' });
    expect(ok.status).toBe('applied');
    expect(exists(ok.path!)).toBe(true);
    expect(await found('澄海科技 营业收入')).toContain(ok.path);
    expect((await derivedClaims()).map((c) => c.value_num)).toEqual([123456700]);
    // trusted: the writer is knode's own, not an agent's
    const [scope] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = $1 AND status = 'active' AND parent_id IS NULL`, [ok.path]);
    expect(scope.trust).toBe('trusted');
    const page = readLearnedPage(fs.readFileSync(path.join(dataDir, ok.path!), 'utf8'))!;
    expect(page.mode).toBe('auto');
    expect(page.checks[0]).toMatchObject({ ok: true, located: true, attribute: '营业收入' });

    const wrong = await writeBack(ctx, {
      question: '澄海科技2023年的营业成本是多少？', answer: 'Final answer: 9,999.00万元', citations: [REPORT], origin: 'ask',
    });
    expect(wrong).toMatchObject({ status: 'pending', verified: false });
    expect(wrong.checks![0].ok).toBe(false);
    expect(exists(wrong.path!)).toBe(false);

    // a refusal leaves nothing
    expect((await writeBack(ctx, { question: '澄海科技的年终奖是多少？', answer: '资料中没有提到。\nFinal answer: 资料未提及', citations: [REPORT], origin: 'ask' })).status).toBe('skipped');
  });

  it('an agent\'s structured facts are checked on the lines they cite', async () => {
    const row = tenK.split('\n').findIndex((l) => l.startsWith('Total revenue')) + 1;
    const r = await writeBack(ctx, {
      question: 'What was Zenith Holdings total revenue?', answer: 'Total revenue was $4,200 thousand.',
      citations: [], facts: [{ value: '4,200', unit: 'thousand', subject: 'Zenith Holdings', attribute: 'total revenue', period: '2023', source: `${TEN_K}#L${row}` }],
      origin: 'agent',
    });
    expect(r.status).toBe('applied');
    expect(r.facts![0]).toMatchObject({ value: 4_200_000, ref: { path: TEN_K, line: row } });
    const bad = await writeBack(ctx, {
      question: 'What was Zenith Holdings net loss?', answer: 'Net loss was $1,234 thousand.',
      citations: [], facts: [{ value: '1,234', subject: 'Zenith Holdings', attribute: 'net loss', source: `${TEN_K}#L${row}` }],
      origin: 'agent',
    });
    expect(bad).toMatchObject({ status: 'pending', verified: false });
    expect(bad.checks![0].reason).toBe('line-mismatch');
  });
});

describe('when a cited document changes', () => {
  const question = '澄海科技2023年的净利润是多少？';

  it('the learned page depends on the documents it cites', async () => {
    ctx.config.learn = { enabled: true, autoAccept: true };
    const r = await writeBack(ctx, { question, answer: 'Final answer: 1,502.30万元', citations: [REPORT], origin: 'ask' });
    expect(r.status).toBe('applied');
    const deps = await readDeps(ctx.store, { kind: 'cites', id: r.path! });
    expect(deps.map((d) => d.input_id)).toContain(REPORT);
  });

  it('a value whose line moved is followed to its new line; a value that changed withdraws the page', async () => {
    const p = learnedPathFor(question);
    const before = readLearnedPage(fs.readFileSync(path.join(dataDir, p), 'utf8'))!.checks[0].source!;
    // lines inserted above the table: every value moves down two lines
    write(REPORT, reportText().replace('## 合并利润表', '## 合并利润表\n\n（经审计）'));
    await sync(ctx, { llmGraph: false });
    expect(exists(p)).toBe(true);
    const after = readLearnedPage(fs.readFileSync(path.join(dataDir, p), 'utf8'))!.checks[0].source!;
    expect(parseSourceRef(after)!.line).toBe(parseSourceRef(before)!.line! + 2);
    expect(fs.readFileSync(path.join(dataDir, p), 'utf8')).toContain(after);

    // revenue restated: the revenue page is withdrawn, the net-profit page stays
    const revenuePage = learnedPathFor('澄海科技2023年的营业收入是多少？');
    expect(exists(revenuePage)).toBe(true);
    write(REPORT, reportText('12,999.00').replace('## 合并利润表', '## 合并利润表\n\n（经审计）'));
    await sync(ctx, { llmGraph: false });
    expect(exists(revenuePage)).toBe(false);
    expect(exists(p)).toBe(true);
    expect(await found('澄海科技 营业收入 12,345.67')).not.toContain(revenuePage);
    expect((await derivedClaims()).map((c) => c.value_num)).not.toContain(123456700);
    const [s] = await ctx.store.query<{ status: string; payload: { reason: string } }>(`SELECT status, payload FROM suggestions WHERE id = $1`, [learnSuggestionId(revenuePage)]);
    expect(s).toMatchObject({ status: 'pending', payload: { reason: 'stale' } });
  });
});

describe('the MCP surface', () => {
  async function toolNames(): Promise<string[]> {
    const server = new McpServer({ name: 't', version: '0' });
    registerKnodeTools(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(b);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  }

  it('offers knode_writeback only when learning is on', async () => {
    ctx.config.learn = { enabled: false };
    expect(await toolNames()).not.toContain('knode_writeback');
    ctx.config.learn = { enabled: true };
    expect(await toolNames()).toContain('knode_writeback');
  });
});
