import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claimsByDoc, coverage, docResolver, formatCoverage, goldNumbers, numberMatches, readNumbers, readWiki, taskGold, textHasNumber, valueMatches,
} from '../src/eval/coverage.js';
import type { LoadedPack } from '../src/eval/pack.js';
import type { Task } from '../src/eval/types.js';

/**
 * `eval pack coverage` (docs/design/38 §3.2 item 5): where a pack's gold sits
 * in a knode build — the evidence document's own summary page, entity and
 * timeline lines naming it, mention lines apart, its claims — with numbers
 * matched at the scales tables print them in.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-coverage-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const task = (over: Partial<Task>): Task => ({ id: 't', suite: 'usage', type: 'numeric', question: 'q?', evidence: [], scoring: 'value', ...over }) as Task;

describe('numbers', () => {
  it('reads scale words and precision', () => {
    const [n] = readNumbers('营业收入 16,742.44 万元');
    expect(n.value).toBeCloseTo(167_424_400, 3);
    expect(n.precision).toBeCloseTo(100, 6);
    expect(n.scaled).toBe(true);
    expect(readNumbers('$1.2 million').map((x) => x.value)).toEqual([1_200_000]);
    // ids and hashes are not numbers
    expect(readNumbers('raw/docs/filings/en/06d5dde4c6d9.md Q1')).toEqual([]);
  });

  it('matches a gold number at the scales a table prints it in, within the coarser precision', () => {
    const [g] = goldNumbers(task({ answer: '167,424,382.67' }))!;
    const m = (text: string) => readNumbers(text).some((n) => numberMatches(n, g));
    expect(m('营业收入为167,424,382.67元')).toBe(true);
    expect(m('营业收入 16,742.44 万元')).toBe(true);
    // a thousands table, no word beside the number
    expect(m('Revenue | 167,424 |')).toBe(true);
    expect(m('约1.7亿元')).toBe(false);
    expect(m('营业收入为167,524,382.67元')).toBe(false);
  });

  it('reads a scale given apart from the number, and a sign as written', () => {
    expect(goldNumbers(task({ answer: '$10,135 in thousands' }))![0].value).toBe(10_135_000);
    expect(textHasNumber('Administrative expenses 10,135', goldNumbers(task({ answer: '$10,135 in thousands' }))!)).toBe(true);
    expect(textHasNumber('Basic loss per share $(0.04)', goldNumbers(task({ answer: '-$0.04', answers: ['-$0.04', '-0.04'] }))!)).toBe(true);
    // dates are not the gold's number; several numbers are not one
    expect(goldNumbers(task({ answer: '2024-03-31: 5.25' }))![0].value).toBe(5.25);
    expect(goldNumbers(task({ answer: '5 and 7' }))).toBeNull();
  });

  it('keeps years to year-like gold', () => {
    const [g] = goldNumbers(task({ answer: '2,024.00' }))!;
    expect(readNumbers('in 2024 the company').some((n) => numberMatches(n, g))).toBe(false);
  });

  it('matches stored values by how they print', () => {
    const [g] = goldNumbers(task({ answer: '144,480.00' }))!;
    expect(valueMatches(144480, g)).toBe(true);
    expect(valueMatches(14.448, g)).toBe(true); // 万元
    expect(valueMatches(144490, g)).toBe(false);
  });
});

describe('gold', () => {
  it('reads each kind of gold, and leaves out what presence cannot measure', () => {
    expect(taskGold(task({ answer: '0.24' })).kind).toBe('number');
    // a count the question derives
    expect(taskGold(task({ answer: '2', scoring: 'exact' })).kind).toBe('none');
    // one of the options the question names
    expect(taskGold(task({ question: '倍加洁、盾安环境、迈克生物中哪一个最高？', answer: '迈克生物', scoring: 'exact' })).kind).toBe('none');
    expect(taskGold(task({ answer: '金卡智能', scoring: 'exact' }))).toEqual({ kind: 'text', texts: ['金卡智能'] });
    // a list item by its number; a derived class not at all
    const g = taskGold(task({ scoring: 'set', items: [{ label: '海新能科: -0.0501', aliases: [], weight: 1 }, { label: 'CLEARONE INC: high shares', aliases: [], weight: 1 }] }));
    expect(g.kind).toBe('list');
    expect(g.items).toHaveLength(1);
    expect(g.items![0].numbers![0].value).toBeCloseTo(0.0501, 9);
    expect(taskGold(task({ scoring: 'set', items: [{ label: 'CLEARONE INC: high shares', aliases: [], weight: 1 }] })).kind).toBe('none');
    // an answer listing several numbers, its years left out
    const several = taskGold(task({ scoring: 'judge', answer: '2023年一季度为3,291,817,780.74元；2024年一季度为17,854,769,474.09元。' }));
    expect(several.kind).toBe('list');
    expect(several.items!.map((i) => i.numbers![0].value)).toEqual([3_291_817_780.74, 17_854_769_474.09]);
    expect(taskGold(task({ scoring: 'abstain' })).kind).toBe('none');
  });
});

describe('a build', () => {
  it('resolves the paths a build writes to the pack\'s by suffix', () => {
    const r = docResolver(['filings/en/a.md', 'b/filings/en/a.md', 'x.md']);
    expect(r('raw/docs/filings/en/a.md')).toBe('filings/en/a.md');
    expect(r('raw/docs/b/filings/en/a.md')).toBe('b/filings/en/a.md');
    expect(r('raw/docs/other.md')).toBeNull();
  });

  it('counts the gold at each place, mention lines apart, per family and kind', () => {
    const packDir = path.join(tmp, 'pack');
    fs.mkdirSync(path.join(packDir, 'corpus', 'f'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'corpus', 'f', 'a.md'), '营业收入 167,424,382.67 元；基本每股收益 0.0432 元；净利润 16,513,092.18 元');
    fs.writeFileSync(path.join(packDir, 'corpus', 'f', 'b.md'), 'Revenue 14,913,497');
    const tasks: Task[] = [
      task({ id: 'rev', answer: '167,424,382.67', evidence: [{ doc: 'f/a.md' }], meta: { family: 'controls' } }),
      task({ id: 'eps', answer: '0.0432', evidence: [{ doc: 'f/a.md' }], meta: { family: 'controls' } }),
      task({ id: 'np', answer: '16,513,092.18', evidence: [{ doc: 'f/a.md' }], meta: { family: 'controls' } }),
      task({ id: 'list', scoring: 'set', type: 'aggregation', items: [{ label: 'A: 167,424,382.67', aliases: [], weight: 1 }, { label: 'B: 14,913,497', aliases: [], weight: 1 }], evidence: [{ doc: 'f/a.md' }, { doc: 'f/b.md' }] }),
    ];
    const pack = { dir: packDir, manifest: { id: 'p', languages: ['zh'] }, docs: [{ path: 'f/a.md' }, { path: 'f/b.md' }], tasks } as unknown as LoadedPack;
    const wiki = path.join(tmp, 'ws', 'wiki');
    for (const d of ['sources', 'entities', 'mentions', 'timelines']) fs.mkdirSync(path.join(wiki, d), { recursive: true });
    fs.writeFileSync(path.join(wiki, 'sources', 'a.md'), '---\ntitle: A\ntype: source\nsource: raw/docs/f/a.md\n---\n\n## Figures\n\n16,742.44 万元 — revenue\n');
    // the entity page holds the EPS on a line naming a.md, and 16,513,092.18 on a line naming another document
    fs.writeFileSync(path.join(wiki, 'entities', 'co.md'), '---\ntitle: Co\ntype: organization\n---\n\n- **EPS**: 0.0432 — raw/docs/f/a.md\n- **net profit**: 16,513,092.18 — raw/docs/f/b.md\n');
    fs.writeFileSync(path.join(wiki, 'mentions', 'co.md'), '---\ntitle: Co (mentions)\ntype: mentions\n---\n\n- A — raw/docs/f/a.md · “净利润 16,513,092.18 元”\n');
    const resolve = docResolver(pack.docs.map((d) => d.path));
    const index = { ...readWiki(wiki, resolve), claims: claimsByDoc([{ path: 'raw/docs/f/a.md', statement: '每股收益为0.0432元', value: 0.0432 }, { path: 'raw/docs/f/b.md', statement: 'revenue', value: 14_913.497 }], resolve) };
    const r = coverage(pack, index, { claimCount: 2 });
    const byId = Object.fromEntries(r.perTask.map((t) => [t.id, t.found]));
    expect(byId.rev).toMatchObject({ corpus: 1, source: 1, entityTimeline: 0, mentions: 0, claims: 0, wiki: 1 });
    expect(byId.eps).toMatchObject({ corpus: 1, source: 0, entityTimeline: 1, claims: 1, wiki: 1 });
    // only in a mention line of its document: the entity line naming b.md does not count
    expect(byId.np).toMatchObject({ corpus: 1, wiki: 0, mentions: 1, mentionsOnly: 1, claims: 0, wikiOrClaims: 0 });
    // half the list on a page (the revenue on a.md's summary), the other half in b.md's claims (in thousands)
    expect(byId.list).toMatchObject({ corpus: 1, source: 0.5, claims: 0.5, wikiOrClaims: 1 });
    const controls = r.rows.find((x) => x.family === 'controls · number')!;
    expect(controls).toMatchObject({ tasks: 3, measurable: 3 });
    expect(controls.found.source).toBe(1);
    expect(r.singleDocNumber.tasks).toBe(3);
    expect(formatCoverage(r)).toContain('| controls · number | 3 | 3 |');
  });
});
