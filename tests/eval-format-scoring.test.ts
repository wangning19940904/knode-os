import { describe, expect, it } from 'vitest';
import type { Judge } from '../src/eval/judge.js';
import { parseStructured, taskPrompt, unclosedItems } from '../src/eval/prompts.js';
import { foldThousands, listParts, matchFieldEntries, matchForm, saysEmptyGroup, scoreLists, shortNames, splitListedItems } from '../src/eval/score/lists.js';
import { scoreUsage, unmeteredStop } from '../src/eval/score/usage.js';
import { namesValue, numbersIn, readValue } from '../src/eval/score/values.js';
import { emptyUsage, type AnswerRecord, type ScoreRecord, type Task } from '../src/eval/types.js';

/*
 * Format-tolerant scoring (docs/design/33 §5): answers the 10× run
 * (separation-2026-11/run-10x) scored below right for their form, not their
 * content. Each case is the recorded answer's text, cut to what matters.
 */

const answer = (taskId: string, text: string, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  key: `${taskId}-${extra.system ?? 's'}`, pack: 'p', system: 's', taskId, text, finalAnswer: '', citations: [], retrieved: [], toolCalls: 0,
  usage: emptyUsage(), ms: 10, at: new Date().toISOString(), ...extra,
});
const noJudge = { gradeAnswers: async () => new Map(), matchList: async () => new Map(), matchItems: async () => new Map() } as unknown as Judge;
const metric = (rs: ScoreRecord[], taskId: string, m: string) => rs.find((r) => r.taskId === taskId && r.metric === m)?.value;
const listTask = (id: string, labels: string[], type: Task['type'] = 'connection'): Task => ({
  id, suite: 'usage', type, question: '?', scoring: 'set', evidence: [],
  items: labels.map((label) => ({ label, aliases: [], weight: 1 })),
  list: { match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1' },
});

describe('format-tolerant scoring: an unclosed JSON list', () => {
  // d10-x-cause-INC-005-D10T1, agent-grep: both incidents right, the object's closing brace missing
  const text = `- **INC-012-D10T2**（十部支付组）——根因是"旧表字段格式不一"。
- **INC-019-D10T3**（十部增长组）——根因是"脏记录混入"。

{"items":[{"label":"INC-012-D10T2","confidence":0.94,"evidence":["周报/十部平台组/8ee814da99.md","周报/十部支付组/734ed3f79c.md"]},{"label":"INC-019-D10T3","confidence":0.94,"evidence":["周报/十部平台组/8ee814da99.md","周报/十部增长组/eaad15bacb.md"]}`;

  it('reads the items it did write', () => {
    expect(parseStructured(text).items.map((i) => i.label)).toEqual(['INC-012-D10T2', 'INC-019-D10T3']);
    // cut inside the second item: the first still counts
    expect(unclosedItems('{"items":[{"label":"A","evidence":[]},{"label":"B","evid')?.items).toEqual([{ label: 'A', evidence: [] }]);
    // the array closed, the object not
    expect(unclosedItems('{"items":[{"label":"A"}]')?.items).toEqual([{ label: 'A' }]);
    expect(unclosedItems('{"items":[')?.items).toEqual([]);
    // a balanced object is not this function's: jsonObjects reads it
    expect(unclosedItems('{"items":[{"label":"A"}]}')).toBeNull();
    expect(unclosedItems('no json here')).toBeNull();
  });

  it('scores the task as right without a model', async () => {
    const rs = await scoreLists({ answers: [answer('cause', text)], tasks: new Map([['p|cause', listTask('cause', ['INC-012-D10T2', 'INC-019-D10T3'])]]), corpusDocs: new Map() }, noJudge);
    expect(metric(rs, 'cause', 'correctness')).toBe(1);
  });

  it('keeps a label task\'s label where the reply also lists items', () => {
    const p = parseStructured('{"items":[{"label":"x"}]}\n{"label":"支付组","confidence":0.8}');
    expect(p.label).toBe('支付组');
    expect(p.items.map((i) => i.label)).toEqual(['x']);
  });
});

describe('format-tolerant scoring: numbers', () => {
  const value = (id: string, gold: string, meta: Record<string, unknown> = {}): Task => ({ id, suite: 'usage', type: 'structured', question: '?', scoring: 'value', answer: gold, evidence: [], meta });

  it('reads a thousands separator: "1,000 milliseconds" names 1000 (d10-st-D10T1-C3-now-xl)', async () => {
    const t: Task = { ...value('ms', '1000', { stale: ['800', '1200'] }), answers: ['1000毫秒'] };
    expect(readValue(t, 'Final answer: 1,000 milliseconds (1 second).').gold).toBe(true);
    // and a stale value written the same way is read as stale
    expect(readValue(t, 'Final answer: 1,200 milliseconds.')).toMatchObject({ gold: false, stale: true });
    const rs = await scoreUsage({ answers: [answer('ms', 'Final answer: 1,000 milliseconds (1 second).')], tasks: new Map([['p|ms', t]]), citing: new Set() }, noJudge);
    expect(metric(rs, 'ms', 'correctness')).toBe(1);
  });

  it('folds only well-formed groups', () => {
    expect(foldThousands('1,347,307.69人')).toBe('1347307.69人');
    expect(foldThousands('第1,2周')).toBe('第1,2周');
    expect(foldThousands('3,4567')).toBe('3,4567');
    expect(matchForm('1,000 ms')).toBe(matchForm('1000ms'));
    expect(numbersIn('134.7万人，共 1,347,308 人')).toEqual([{ value: 134.7, scaled: 1_347_000 }, { value: 1_347_308, scaled: 1_347_308 }]);
  });

  it('reads a figure given at full size against a gold in 万, within the pack\'s tolerance (d9-sq-h1avg-D9T3)', async () => {
    const t = value('avg', '135', { tolerance: 1.01 });
    const recorded = '各月周活跃用户数汇总如下，单位为万人。\n\n周均值＝3503 × 10000 ÷ 26＝1,347,307.69人，四舍五入保留0位小数为 **1,347,308人**。\n\nFinal answer: 九部增长组上半年周活跃用户的周均值为1,347,308人。';
    expect(readValue(t, recorded).gold).toBe(true);
    const rs = await scoreUsage({ answers: [answer('avg', recorded)], tasks: new Map([['p|avg', t]]), citing: new Set() }, noJudge);
    expect(metric(rs, 'avg', 'correctness')).toBe(1);
    // the same figure in 万, and the gold at full size against an answer in 万
    expect(readValue(t, 'Final answer: 134.7万人').gold).toBe(true);
    expect(readValue(value('abs', '1350000', { tolerance: 10_100 }), 'Final answer: 135万人').gold).toBe(true);
    // converted, it is held to the same tolerance: 133.0万 is two away from 135
    expect(readValue(t, '单位为万人。Final answer: 1,330,000人').gold).toBe(false);
    // an answer that never works in 万 is not converted
    expect(readValue(t, 'Final answer: 1,347,308人').gold).toBe(false);
    // a gold small against its tolerance is never compared with a converted number
    expect(namesValue('52,000人', ['5'], 1.01, [1e4])).toBe(false);
    // no tolerance, no conversion
    expect(namesValue('1,347,308人', ['135'], undefined, [1e4])).toBe(false);
  });
});

describe('format-tolerant scoring: two items in one entry', () => {
  const twins = listTask('twins', ['九部平台组', '九部支付组'], 'ambiguous');
  const json = (labels: string[]) => `{"items":[${labels.map((l) => JSON.stringify({ label: l, confidence: 0.99, evidence: [] })).join(',')}]}`;
  const score = async (labels: string[]) => metric(await scoreLists({ answers: [answer('twins', json(labels))], tasks: new Map([['p|twins', twins]]), corpusDocs: new Map() }, noJudge), 'twins', 'correctness');

  it('splits a label at its top-level separators', () => {
    expect(listParts('九部平台组、九部支付组（归属不唯一）')).toEqual(['九部平台组', '九部支付组(归属不唯一)']);
    expect(listParts('五部平台组／五部支付组（归属有歧义）')).toEqual(['五部平台组', '五部支付组(归属有歧义)']);
    expect(listParts('A（甲、乙）')).toEqual(['A(甲、乙)']);
    expect(listParts('1,000 and 2,000')).toEqual(['1000', '2000']);
  });

  it('counts an entry naming both gold items for both (d9-a-twins and its twelve siblings)', async () => {
    expect(await score(['九部平台组、九部支付组（归属不唯一）'])).toBe(1);
    expect(await score(['五部平台组／五部支付组（归属有歧义）'.replace(/五/g, '九')])).toBe(1);
    // a wrong part still costs precision, as a separate wrong entry would: P 2/3, R 1
    expect(await score(['九部平台组、九部支付组、九部增长组'])).toBeCloseTo(0.8, 6);
    // one phrase that mentions both is one claim, matched once
    expect(await score(['九部平台组调往九部支付组'])).toBeCloseTo(2 / 3, 6);
    // parts that name at most one gold item: the entry keeps its form
    expect(splitListedItems([{ label: '九部平台组、负责人陈晨' }], twins.items!)).toEqual([{ label: '九部平台组、负责人陈晨' }]);
  });
});

/*
 * A group written as one entry (2026-11-22, the run of docs/design/36): each
 * case is the `items` block of an answer that run recorded, scored 0 with
 * every company in the class the gold gives it.
 */
describe('format-tolerant scoring: a group in one entry, matched by fields', () => {
  const sets = (id: string, pairs: [string, string][]): Task => ({
    id, suite: 'usage', type: 'aggregation', question: '?', scoring: 'set', evidence: [],
    items: pairs.map(([member, group]) => ({ label: `${member}: ${group}`, aliases: [], weight: 1, fields: [[member], [group]] })),
    list: { match: 'fields', ordered: false, maxItems: 20, requireDocs: false, primary: 'exact' },
  });
  const profit = sets('profit', [['亿纬锂能', '高利润'], ['百亚股份', '中利润'], ['蓝晓科技', '中利润'], ['顺威股份', '低利润'], ['夏厦精密', '低利润'], ['梅安森', '低利润']]);
  const cash = sets('cash', [['Acorda Therapeutics, Inc.', 'zero cash flow'], ['HARTE HANKS INC', 'negative cash flow'], ['CPI AEROSTRUCTURES INC', 'negative cash flow']]);
  const json = (labels: string[]) => `{"items":[${labels.map((l) => JSON.stringify({ label: l, confidence: 1, evidence: [] })).join(',')}]}`;
  const score = async (t: Task, labels: string[], m = 'correctness') => metric(await scoreLists({ answers: [answer(t.id, json(labels))], tasks: new Map([[`p|${t.id}`, t]]), corpusDocs: new Map() }, noJudge), t.id, m);

  it('reads a class with its members as one entry a member, however it is punctuated', async () => {
    // loong-067c49ce-b108, agent-grep
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份、蓝晓科技', '低利润：顺威股份、夏厦精密、梅安森', '负利润：空集合'])).toBe(1);
    expect(await score(profit, ['高利润集合 {亿纬锂能}', '中利润（百亚股份、蓝晓科技）', '低利润：{顺威股份，夏厦精密，梅安森}', '负利润集合 ∅'])).toBe(1);
    // loong-e74fde4b-6a98: a name with its own comma, and a group said to be empty
    expect(await score(cash, ['Positive cash flow: none', 'Zero cash flow: Acorda Therapeutics, Inc.', 'Negative cash flow: HARTE HANKS INC; CPI AEROSTRUCTURES INC'])).toBe(1);
    // one entry a company, as the other arms wrote it, is unchanged
    expect(await score(profit, ['亿纬锂能：高利润', '百亚股份：中利润', '蓝晓科技：中利润', '顺威股份：低利润', '夏厦精密：低利润', '梅安森：低利润'])).toBe(1);
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份、蓝晓科技', '低利润：顺威股份、夏厦精密、梅安森'], 'items_returned')).toBe(6);
  });

  it('still fails a company in the wrong class, one left out, and one given twice', async () => {
    // 蓝晓科技 put with the low ones: five pairs, and its entry is a wrong one
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份', '低利润：蓝晓科技、顺威股份、夏厦精密、梅安森'])).toBe(0);
    expect(matchFieldEntries(['低利润：蓝晓科技、顺威股份、夏厦精密、梅安森'], profit.items!)).toEqual({ pairs: [[0, 3], [0, 4], [0, 5]], entries: [4] });
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份、蓝晓科技', '低利润：顺威股份、夏厦精密'])).toBe(0);
    // in two classes at once: the second is an entry the gold does not have
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份、蓝晓科技', '低利润：顺威股份、夏厦精密、梅安森、蓝晓科技'])).toBe(0);
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份、蓝晓科技', '低利润：顺威股份、夏厦精密、梅安森', '梅安森：低利润'])).toBe(0);
    // a company the answer could not sort is an entry, and not a right one
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：百亚股份、蓝晓科技', '低利润：顺威股份、夏厦精密', '梅安森：无法确定'])).toBe(0);
  });

  it('does not read two classes in one entry as a group', () => {
    // every company and every class in one label would match any gold: left to pair once
    const all = '高利润：亿纬锂能；中利润：百亚股份、蓝晓科技；低利润：顺威股份、夏厦精密、梅安森';
    expect(matchFieldEntries([all], profit.items!).pairs).toHaveLength(1);
    // items that differ in two fields are not a group either (a team's quarters with their counts)
    const quarters = [
      { label: '平台组 Q1：3起', aliases: [], weight: 1, fields: [['平台组'], ['Q1'], ['3']] },
      { label: '平台组 Q2：2起', aliases: [], weight: 1, fields: [['平台组'], ['Q2'], ['2']] },
    ];
    expect(matchFieldEntries(['平台组 Q1 3起，Q2 2起'], quarters)).toEqual({ pairs: [[0, 0]], entries: [1] });
  });

  it('reads a class by its short name when the label holds that one and no other', async () => {
    const liab = sets('liab', [['BIOLARGO, INC.', 'high liabilities'], ['BIOETHICS LTD', 'medium liabilities'], ['Ault Alliance, Inc.', 'high liabilities']]);
    expect([...shortNames(liab.items!)[1].entries()]).toEqual([['high liabilities', 'high'], ['medium liabilities', 'medium']]);
    expect(shortNames(profit.items!)[1].get('高利润')).toBe('高');
    // loong-f4c480aa-405c, agent-grep
    expect(await score(liab, ['BIOLARGO, INC. — high', 'BIOETHICS LTD — medium', 'Ault Alliance, Inc. — high'])).toBe(1);
    expect(await score(liab, ['High — BIOLARGO, INC.; Ault Alliance, Inc.', 'Medium — BIOETHICS LTD'])).toBe(1);
    expect(await score(liab, ['BIOLARGO, INC. — medium', 'BIOETHICS LTD — medium', 'Ault Alliance, Inc. — high'])).toBe(0);
    // loong-ad4aea33-d436: 戴维医疗｜高｜0.1323
    expect(await score(profit, ['亿纬锂能｜高｜1,055,311,277.97', '百亚股份，中', '蓝晓科技：中', '顺威股份 低', '夏厦精密：低', '梅安森：低'])).toBe(1);
    // a company's own name does not name a class, and neither does a label that holds two
    const zh = sets('zh', [['中粮科工', '高利润'], ['高新发展', '中利润']]);
    expect(await score(zh, ['中粮科工：高', '高新发展：中'])).toBe(1);
    expect(await score(zh, ['中粮科工：低', '高新发展：中'])).toBe(0);
    expect(await score(zh, ['中粮科工', '高新发展'])).toBe(0);
    expect(await score(zh, ['中粮科工：高（其中…）', '高新发展：中'])).toBe(0);
    // a full name of another class settles it: its short name inside is not read
    expect(await score(zh, ['中粮科工：中利润', '高新发展：中利润'])).toBe(0);
    // classes with nothing in common, or figures, have no short names
    expect(shortNames(sets('n', [['A1', 'over 1,000,000'], ['B1', 'below 10,000']]).items!)[1].size).toBe(0);
  });

  it('takes "this group is empty" for no item, unless it names something the gold holds', async () => {
    for (const l of ['负利润：空集', '负利润：∅', '负利润（空集）', '增幅10%到50%：{}（现有材料）', 'Positive cash flow: none', '负利润 暂无可确认公司', '负利润：无']) expect(saysEmptyGroup(l, profit.items!), l).toBe(true);
    for (const l of ['梅安森：无法确定', '中利润：空集', '负利润：某公司', 'Aspira — unclassified']) expect(saysEmptyGroup(l, profit.items!), l).toBe(false);
    // a class the gold fills, said to be empty: an entry, and the answer is short of its companies anyway
    expect(await score(profit, ['高利润：亿纬锂能', '中利润：空集', '低利润：顺威股份、夏厦精密、梅安森'])).toBe(0);
  });
});

describe('a group question says how its items are written', () => {
  it('one item a member with its group, for a list matched by fields', () => {
    const t: Task = { id: 'g', suite: 'usage', type: 'aggregation', question: 'Sort these companies into groups.', scoring: 'set', evidence: [], items: [{ label: 'A: high', aliases: [], weight: 1, fields: [['A'], ['high']] }], list: { match: 'fields', ordered: false, maxItems: 10, requireDocs: false, primary: 'exact' } };
    expect(taskPrompt(t)).toContain('one item for each thing sorted');
    expect(taskPrompt({ ...t, type: 'aggregate' })).not.toContain('one item for each thing sorted');
  });
});

describe('a session stopped at its command cap', () => {
  it('has no tokens on record, which is not zero tokens', async () => {
    const t: Task = { id: 'v', suite: 'usage', type: 'numeric', question: '?', scoring: 'exact', answer: '42', evidence: [] };
    const stopped = answer('v', '', { capped: true, toolCalls: 6 });
    const answered = answer('v', 'Final answer: 42', { capped: true, system: 't', usage: { ...emptyUsage(), inputTokens: 900, outputTokens: 20, weightedTokens: 500 } });
    expect(unmeteredStop(stopped)).toBe(true);
    expect(unmeteredStop(answered)).toBe(false);
    expect(unmeteredStop(answer('v', ''))).toBe(false);
    const rs = await scoreUsage({ answers: [stopped, answered], tasks: new Map([['p|v', t]]), citing: new Set() }, noJudge);
    const of = (system: string, m: string) => rs.find((r) => r.system === system && r.metric === m)?.value;
    expect(of('s', 'query_weighted_tokens')).toBeNull();
    expect(of('s', 'capped')).toBe(1);
    expect(of('t', 'query_weighted_tokens')).toBe(500);
  });
});
