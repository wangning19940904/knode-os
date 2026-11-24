import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { documentClass, METHODS_BEGIN, METHODS_END, methodSuggestionId, refreshMethodPlaybooks, withRegion } from '../src/learn/methods.js';
import { writeBack } from '../src/learn/writeback.js';
import { applySuggestion } from '../src/pack/learn.js';
import { buildContextPack } from '../src/pack/pack.js';
import { parsePlaybook } from '../src/pack/playbook.js';

/**
 * The third write-back (docs/design/38 §4.2): where a kind of document keeps a
 * measure — section, row, column, unit — read back from the lines learned
 * facts were checked on, proposed for the entity type's playbook once checked
 * on two documents, and handed to an agent by knode_resolve's context pack.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-learn-methods-'));
const dataDir = path.join(tmp, 'ws');
let ctx: AppContext;
const PLAYBOOK = 'playbooks/packs/organization.md';

const report = (company: string, revenue: string, cost: string) => `---
title: ${company} 2023 年年度报告
entities:
  - { name: ${company}, type: organization }
---
# ${company} 2023 年年度报告

## 合并利润表

单位：万元

| 项目 | 2023 年 | 2022 年 |
| --- | --- | --- |
| 营业收入 | ${revenue} | 10,020.00 |
| 营业成本 | ${cost} | 7,100.25 |
`;

function write(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const read = (rel: string) => fs.readFileSync(path.join(dataDir, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(dataDir, rel));

beforeAll(async () => {
  write('raw/docs/a.md', report('澄海科技', '12,345.67', '8,001.50'));
  write('raw/docs/b.md', report('远川电子', '23,456.78', '9,100.00'));
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('where a kind of document keeps a measure', () => {
  it('reads a document class from a title without its subject', () => {
    expect(documentClass('澄海科技 2023 年年度报告', '澄海科技')).toBe('年度报告');
    expect(documentClass('平安银行（000001）2024年第一季度报告', '平安银行')).toBe('第一季度报告');
    expect(documentClass('ARVANA INC. annual report (Form 10-K), 2019 file', 'ARVANA INC.')).toBe('annual report');
  });

  it('keeps a person\'s playbook outside its region', () => {
    const mine = '---\ntype: playbook\nappliesTo: organization\n---\n# Mine\n\nMy guidance.\n';
    const once = withRegion(mine, `${METHODS_BEGIN}\nA\n${METHODS_END}`);
    const twice = withRegion(once, `${METHODS_BEGIN}\nB\n${METHODS_END}`);
    expect(twice).toContain('My guidance.');
    expect(twice).toContain('\nB\n');
    expect(twice).not.toContain('\nA\n');
    expect(withRegion(twice, '').trim()).toBe(mine.trim());
  });

  it('one document is not a method; a second one checked the same way writes it into the type\'s playbook (auto-accept)', async () => {
    ctx.config.learn = { enabled: true, autoAccept: true };
    const a = await writeBack(ctx, { question: '澄海科技2023年的营业收入是多少？', answer: 'Final answer: 12,345.67万元', citations: ['raw/docs/a.md'], origin: 'ask' });
    expect(a.status).toBe('applied');
    expect(a.methods).toEqual({ written: [], suggested: [] });
    expect(exists(PLAYBOOK)).toBe(false);

    const b = await writeBack(ctx, { question: '远川电子2023年的营业收入是多少？', answer: 'Final answer: 23,456.78万元', citations: ['raw/docs/b.md'], origin: 'ask' });
    expect(b.methods?.written).toEqual([PLAYBOOK]);
    const text = read(PLAYBOOK);
    expect(parsePlaybook(text, PLAYBOOK)).toMatchObject({ appliesTo: 'organization' });
    expect(text).toContain('**营业收入**（年度报告）：「合并利润表」一节，行「营业收入」，第 2 列（表头是期间）；数值按「单位：万元」读');
    expect(text).toContain('已在 2 篇文档上逐行校验：raw/docs/a.md#L14, raw/docs/b.md#L14');
    // seeded from the default playbook's guidance, for that type
    expect(text).toContain('Applies to any matched entity');

    // knode_resolve's context pack hands it to the agent asking about a company
    const pack = await buildContextPack(ctx, '澄海科技的营业成本是多少', { track: false });
    expect(pack.playbooksUsed).toContain(PLAYBOOK);
    expect(pack.guidance.join('\n')).toContain('取数方法');
  });

  it('waits for review as a playbook revision when auto-accept is off; accepting writes it', async () => {
    fs.rmSync(path.join(dataDir, PLAYBOOK));
    const r = await refreshMethodPlaybooks(ctx.store, dataDir, { autoAccept: false });
    expect(r.written).toEqual([]);
    expect(r.suggested).toEqual([methodSuggestionId(PLAYBOOK)]);
    expect(exists(PLAYBOOK)).toBe(false);
    const [s] = await ctx.store.query<{ kind: string; status: string; payload: { path: string } }>(`SELECT kind, status, payload FROM suggestions WHERE id = $1`, [r.suggested[0]]);
    expect(s).toMatchObject({ kind: 'pack', status: 'pending', payload: { path: PLAYBOOK } });
    expect(await applySuggestion(ctx.store, dataDir, r.suggested[0])).toEqual({ applied: true, path: PLAYBOOK });
    expect(read(PLAYBOOK)).toContain('**营业收入**');
  });

  it('a method whose support went away (a source restated) leaves the playbook', async () => {
    ctx.config.learn = { enabled: true, autoAccept: true };
    write('raw/docs/b.md', report('远川电子', '23,999.00', '9,100.00'));
    await sync(ctx, { llmGraph: false });
    const text = read(PLAYBOOK);
    expect(text).not.toContain(METHODS_BEGIN);
    expect(text).toContain('Applies to any matched entity');
  });
});
