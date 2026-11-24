import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { catalogQuery } from '../src/store/catalog.js';
import { modelNormalizer } from '../src/tables/labels.js';
import { normalizeTableLabels, runTableModelPass, tableMatrix, TableMatrix } from '../src/tables/store.js';

/**
 * Table facts in a workspace (docs/design/38 §3.2): parsed on sync into a
 * child scope of each document's, readable through v_table_facts and
 * knode_table, replaced when the document changes, gone when it goes — and
 * nothing of it while `extraction.tableFacts` is off.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-table-facts-'));
const opened: AppContext[] = [];
afterAll(async () => {
  for (const c of opened) {
    await c.datasources.closeAll();
    await c.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function open(name: string, tableFacts: boolean): Promise<AppContext> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await createContext(dir);
  if (tableFacts) ctx.config.extraction.tableFacts = { enabled: true };
  opened.push(ctx);
  return ctx;
}

const zhReport = (cash: string) => `# 卡莱特（301391）2024年一季度报告

1、合并资产负债表
2024年 03月 31日
单位：元
|项目|期末余额|期初余额|
|---|---|---|
|货币资金|${cash}|306,803,552.74|
|应付账款|138,767,380.36|170,902,900.45|
|资产总计|2,878,819,360.26|2,864,868,520.85|
2、合并利润表
单位：元
|项目|本期发生额|上期发生额|
|---|---|---|
|一、营业总收入|142,734,076.02|132,710,272.70|
|其中：营业收入|142,734,076.02|132,710,272.70|
`;

const EN_10Q = `# Correlate Energy Corp. quarterly report (Form 10-Q), 2024 file
For the quarterly period ended March 31, 2024

CONDENSED CONSOLIDATED BALANCE SHEETS

(in thousands, except per share data)

                                                          March 31,      December 31,
                                                             2024            2023

Cash                                                  $      101,665  $    1,412,379
Accounts payable                                      $      734,425  $      304,400
Total assets                                          $    3,047,769  $    4,560,690

CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS

                                                        For the three months ended
                                                                March 31,
                                                           2024            2023

Revenues                                              $      432,799  $       50,734
Cost of goods and services sold                              210,000          20,000
`;

/** knode_table and friends as an MCP client sees them. */
function tools(ctx: AppContext) {
  const registered = new Map<string, { description: string; schema: Record<string, z.ZodTypeAny>; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
  const fake = {
    registerTool: (name: string, config: { description: string; inputSchema: Record<string, z.ZodTypeAny> }, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => {
      registered.set(name, { description: config.description, schema: config.inputSchema, handler });
    },
  } as unknown as McpServer;
  registerKnodeTools(fake, ctx);
  return {
    has: (name: string) => registered.has(name),
    description: (name: string) => registered.get(name)!.description,
    call: async (name: string, args: Record<string, unknown>) => {
      const t = registered.get(name)!;
      return JSON.parse((await t.handler(z.object(t.schema).parse(args))).content[0].text);
    },
  };
}

describe('table facts in a workspace', () => {
  let ctx: AppContext;

  it('parses the tables of synced documents into a child scope of each, readable through the catalog', async () => {
    ctx = await open('on', true);
    write(ctx.dataDir, 'raw/docs/zh/kaleite.md', zhReport('624,885,759.43'));
    write(ctx.dataDir, 'raw/docs/en/correlate.md', EN_10Q);
    await sync(ctx, { llmGraph: false });

    const scopes = await ctx.store.query<{ key: string; parent_kind: string }>(
      `SELECT t.key, p.kind AS parent_kind FROM scopes t JOIN scopes p ON p.id = t.parent_id WHERE t.kind = 'tables' AND t.status = 'active' ORDER BY t.key`,
    );
    expect(scopes).toEqual([
      { key: 'raw/docs/en/correlate.md', parent_kind: 'doc' },
      { key: 'raw/docs/zh/kaleite.md', parent_kind: 'doc' },
    ]);
    const rows = (await catalogQuery(ctx.store, `SELECT subject, label, label_key, period, period_key, value_num, scale, scale_factor, value_scaled, ref FROM v_table_facts WHERE label_key = 'accounts_payable' ORDER BY ref, period`)).rows;
    expect(rows).toEqual([
      { subject: 'Correlate Energy Corp.', label: 'Accounts payable', label_key: 'accounts_payable', period: 'December 31, 2023', period_key: '2023-12-31', value_num: 304400, scale: '(in thousands, except per share data)', scale_factor: 1000, value_scaled: 304400000, ref: 'raw/docs/en/correlate.md#L12' },
      { subject: 'Correlate Energy Corp.', label: 'Accounts payable', label_key: 'accounts_payable', period: 'March 31, 2024', period_key: '2024-03-31', value_num: 734425, scale: '(in thousands, except per share data)', scale_factor: 1000, value_scaled: 734425000, ref: 'raw/docs/en/correlate.md#L12' },
      { subject: '卡莱特', label: '应付账款', label_key: 'accounts_payable', period: '期初余额', period_key: 'prior', value_num: 170902900.45, scale: '单位：元', scale_factor: 1, value_scaled: 170902900.45, ref: 'raw/docs/zh/kaleite.md#L9' },
      { subject: '卡莱特', label: '应付账款', label_key: 'accounts_payable', period: '期末余额', period_key: '2024-03-31', value_num: 138767380.36, scale: '单位：元', scale_factor: 1, value_scaled: 138767380.36, ref: 'raw/docs/zh/kaleite.md#L9' },
    ]);
    // the line a ref names is the row
    expect(fs.readFileSync(path.join(ctx.dataDir, 'raw/docs/en/correlate.md'), 'utf8').split('\n')[11]).toMatch(/^Accounts payable/);
    expect(fs.readFileSync(path.join(ctx.dataDir, 'raw/docs/zh/kaleite.md'), 'utf8').split('\n')[8]).toMatch(/^\|应付账款\|/);
  });

  it('answers metrics × companies × periods in one knode_table call, by label as written or by key', async () => {
    const t = tools(ctx);
    expect(t.has('knode_table')).toBe(true);
    expect(t.description('knode_query')).toContain('v_table_facts(');
    const m: TableMatrix = await t.call('knode_table', { metrics: ['应付账款', 'Revenues'], subjects: ['卡莱特', 'Correlate Energy'], periods: ['2024'] });
    expect(m.columns).toEqual(['2024']);
    const cell = (subject: string, metric: string) => m.rows.find((r) => r.subject === subject && r.metric === metric)?.cells['2024'];
    expect(cell('卡莱特', '应付账款')).toMatchObject({ value: 138767380.36, scale: '单位：元', scaleFactor: 1, ref: 'raw/docs/zh/kaleite.md#L9', periodKey: '2024-03-31' });
    // "应付账款" and "Accounts payable" are one key
    expect(cell('Correlate Energy', '应付账款')).toMatchObject({ value: 734425, valueScaled: 734425000, unit: 'USD', ref: 'raw/docs/en/correlate.md#L12' });
    // "Revenues" = 营业收入, and a current column reads as the report's period
    expect(cell('卡莱特', 'Revenues')).toMatchObject({ value: 142734076.02, label: '其中：营业收入', periodKey: '2024-03-31' });
    expect(cell('Correlate Energy', 'Revenues')).toMatchObject({ value: 432799, periodSpan: '3M' });
    expect(m.missing).toEqual([]);

    // no periods: every period found is a column
    const all = await tableMatrix(ctx.store, { metrics: ['total_assets'], subjects: ['卡莱特'] });
    expect(all.columns).toEqual(['prior', '2024-03-31']);
    expect(all.rows[0].cells['prior']).toMatchObject({ value: 2864868520.85, period: '期初余额' });
    const none = await tableMatrix(ctx.store, { metrics: ['goodwill'], subjects: ['卡莱特'] });
    expect(none.missing).toEqual([{ subject: '卡莱特', metric: 'goodwill' }]);
  });

  it('replaces a document\'s facts when it changes, and removes them when it goes', async () => {
    const before = await ctx.store.query<{ id: string }>(`SELECT id FROM scopes WHERE kind = 'tables' AND key = 'raw/docs/zh/kaleite.md' AND status = 'active'`);
    write(ctx.dataDir, 'raw/docs/zh/kaleite.md', zhReport('700,000,000.00'));
    await sync(ctx, { llmGraph: false });
    const cash = await ctx.store.query<{ value_num: number }>(`SELECT value_num FROM v_table_facts WHERE label = '货币资金' AND period = '期末余额'`);
    expect(cash).toEqual([{ value_num: 700000000 }]);
    const after = await ctx.store.query<{ id: string }>(`SELECT id FROM scopes WHERE kind = 'tables' AND key = 'raw/docs/zh/kaleite.md' AND status = 'active'`);
    expect(after[0].id).not.toBe(before[0].id);
    expect(await ctx.store.query(`SELECT status FROM scopes WHERE id = $1`, [before[0].id])).toEqual([{ status: 'disposed' }]);

    // an unchanged sync parses nothing again
    const logs: string[] = [];
    await sync(ctx, { llmGraph: false, onProgress: (msg) => logs.push(msg) });
    expect(logs.filter((l) => l.startsWith('tables:'))).toEqual([]);

    fs.rmSync(path.join(ctx.dataDir, 'raw/docs/zh/kaleite.md'));
    await sync(ctx, { llmGraph: false });
    expect(await ctx.store.query(`SELECT count(*)::int AS n FROM table_facts WHERE source_path = 'raw/docs/zh/kaleite.md'`)).toEqual([{ n: 0 }]);
    expect((await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM table_facts`))[0].n).toBeGreaterThan(0);
  });

  it('maps distinct labels no synonym group holds through a normalizer, once each', async () => {
    let calls = 0;
    const normalizer = modelNormalizer('stub', async (messages) => {
      calls++;
      const labels = messages[1].content.split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
      return { mappings: labels.filter((l) => l === 'cost of goods and services sold').map((label) => ({ label, key: 'cost_of_revenue' })) };
    });
    const first = await normalizeTableLabels(ctx.store, normalizer);
    expect(first.mapped).toBe(1);
    expect(first.asked).toBeGreaterThan(0);
    expect(await normalizeTableLabels(ctx.store, normalizer)).toEqual({ asked: 0, mapped: 0 });
    expect(calls).toBe(1);
    // the view reads the mapping; the raw label stays as written
    expect(await ctx.store.query(`SELECT label, label_key FROM v_table_facts WHERE label = 'Cost of goods and services sold' LIMIT 1`)).toEqual([
      { label: 'Cost of goods and services sold', label_key: 'cost_of_revenue' },
    ]);
    const m = await tableMatrix(ctx.store, { metrics: ['营业成本'], periods: ['2024'] });
    expect(m.rows.map((r) => [r.subject, r.cells['2024']?.value])).toEqual([['Correlate Energy Corp.', 210000]]);
  });
});

describe('the model path through a stub', () => {
  it('stores grounded rows by segment and replays them as facts, only where the switch says so', async () => {
    const ctx = await open('model', true);
    ctx.config.extraction.tableFacts = { enabled: true, model: true };
    const lines = ['# 示例（000001）2024年一季度报告', '1、合并资产负债表', '单位：万元', '项目', '期末余额', '期初余额'];
    for (let i = 0; i < 12; i++) lines.push(`科目${i}`, `${(1000 + i).toLocaleString('en-US')}.5${i}`, `${(2000 + i).toLocaleString('en-US')}.1${i}`);
    write(ctx.dataDir, 'raw/docs/flat.md', `${lines.join('\n')}\n`);
    await sync(ctx, { llmGraph: false });
    expect(await ctx.store.query(`SELECT count(*)::int AS n FROM table_facts WHERE parser = 'llm'`)).toEqual([{ n: 0 }]);

    const prompts: string[] = [];
    const stats = await runTableModelPass(ctx, async (messages) => {
      prompts.push(messages[1].content);
      return [
        '{"line": 8, "label": "科目0", "column": "期末余额", "value": "1,000.50", "scale": "单位：万元"}',
        '{"line": 9, "label": "科目0", "column": "期初余额", "value": "2,000.10", "scale": null}',
        '{"line": 8, "label": "科目0", "column": "期末余额", "value": "8,888.88", "scale": null}',
      ].join('\n');
    }, { model: 'stub' });
    expect(stats).toEqual({ documents: 1, calls: 1, rows: 2, failed: 0 });
    expect(prompts[0]).toContain('8| 1,000.50');
    const facts = await ctx.store.query(`SELECT line, label, period_key, value_num, scale, scale_factor, parser FROM v_table_facts WHERE parser = 'llm' ORDER BY line`);
    expect(facts).toEqual([
      { line: 8, label: '科目0', period_key: 'current', value_num: 1000.5, scale: '单位：万元', scale_factor: 10000, parser: 'llm' },
      { line: 9, label: '科目0', period_key: 'prior', value_num: 2000.1, scale: '单位：万元', scale_factor: 10000, parser: 'llm' },
    ]);
    // a second pass makes no call for a segment already read
    expect(await runTableModelPass(ctx, async () => { throw new Error('no call expected'); }, { model: 'stub' })).toEqual({ documents: 0, calls: 0, rows: 0, failed: 0 });
  });
});

describe('with the switch off', () => {
  it('parses nothing, writes nothing and offers no knode_table; turning it on later parses what is there', async () => {
    const ctx = await open('off', false);
    write(ctx.dataDir, 'raw/docs/zh/kaleite.md', zhReport('624,885,759.43'));
    await sync(ctx, { llmGraph: false });
    expect(await ctx.store.query(`SELECT count(*)::int AS n FROM table_facts`)).toEqual([{ n: 0 }]);
    expect(await ctx.store.query(`SELECT count(*)::int AS n FROM scopes WHERE kind = 'tables'`)).toEqual([{ n: 0 }]);
    const t = tools(ctx);
    expect(t.has('knode_table')).toBe(false);
    expect(t.description('knode_query')).not.toContain('v_table_facts');
    const listed = await t.call('knode_datasources', {});
    expect(listed.catalog.map((v: { name: string }) => v.name)).not.toContain('v_table_facts');

    const doc = await ctx.store.query<{ id: string }>(`SELECT id FROM scopes WHERE kind = 'doc' AND status = 'active'`);
    ctx.config.extraction.tableFacts = { enabled: true };
    await sync(ctx, { llmGraph: false });
    expect((await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM table_facts`))[0].n).toBeGreaterThan(0);
    // the document itself was not applied again
    expect(await ctx.store.query(`SELECT id FROM scopes WHERE kind = 'doc' AND status = 'active'`)).toEqual(doc);
  });
});
