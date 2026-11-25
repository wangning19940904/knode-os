import { describe, expect, it } from 'vitest';
import { segmentText } from '../src/graph/segment.js';
import { cleanLabel, labelKey, modelNormalizer, parseLabelNormalizeReply } from '../src/tables/labels.js';
import { isNumericLine, modelPathSegments, modelRowsToFacts, parseTableModelReply, tableModelMessages } from '../src/tables/llm.js';
import { documentSubject, parseTables, TableFact } from '../src/tables/parse.js';
import { documentPeriod, effectiveScale, parseCell, parsePeriod, scaleIn } from '../src/tables/values.js';

/**
 * Hand-checked samples of the layouts the corpora use (docs/design/38 §3.2
 * item 1): a Chinese quarterly report's pipe tables as the converter wrote
 * them (a header glued to the row above, a label cell written twice, a page
 * break written as a new table), an EDGAR 10-Q's space-aligned statements
 * (non-breaking spaces, "$" apart from its number, a header over two lines,
 * the scale note above), and a PDF text layer's single-spaced rows.
 */

const find = (facts: TableFact[], label: string, period?: string) =>
  facts.filter((f) => f.label === label && (period === undefined || f.period === period));

describe('cells, scales and periods', () => {
  it('reads thousands separators, parentheses, dashes and percentages', () => {
    expect(parseCell('251,360,005.65')).toMatchObject({ kind: 'number', num: 251360005.65 });
    expect(parseCell('(1,310,714)')).toMatchObject({ kind: 'number', num: -1310714 });
    expect(parseCell('$ (0.04)')).toMatchObject({ kind: 'number', num: -0.04, unit: 'USD' });
    expect(parseCell('-$0.04')).toMatchObject({ kind: 'number', num: -0.04 });
    expect(parseCell('-76,631,164.09')).toMatchObject({ kind: 'number', num: -76631164.09 });
    expect(parseCell('－35.39%')).toMatchObject({ kind: 'number', num: -35.39, unit: '%' });
    expect(parseCell('(5.2)%')).toMatchObject({ kind: 'number', num: -5.2, unit: '%' });
    expect(parseCell('1.2亿')).toMatchObject({ kind: 'number', num: 1.2, scale: { raw: '亿', factor: 1e8 } });
    for (const dash of ['-', '—', '–', '--', '$ -', '不适用']) expect(parseCell(dash).kind).toBe('dash');
    expect(parseCell('').kind).toBe('empty');
    expect(parseCell('1/24/2023').kind).toBe('text');
    expect(parseCell('$3.20/Share').kind).toBe('text');
  });

  it('keeps the scale as its own field, with its wording', () => {
    expect(scaleIn('单位：元')).toMatchObject({ raw: '单位：元', factor: 1, unit: '元' });
    expect(scaleIn('金额单位：人民币万元')).toMatchObject({ factor: 1e4, unit: '元' });
    expect(scaleIn('(in thousands, except per share data)')).toMatchObject({ factor: 1e3, exceptPerShare: true });
    expect(scaleIn('($ in millions)')).toMatchObject({ factor: 1e6, unit: 'USD' });
    expect(scaleIn('Accounts payable 1,234')).toBeNull();
    const thousands = scaleIn('(Dollars in thousands, except per share amounts)')!;
    // a per-share row is as written whatever the table's note says
    expect(effectiveScale(parseCell('(0.63)'), 'Net loss per share - basic and diluted', '2024', thousands)).toMatchObject({ factor: 1 });
    expect(effectiveScale(parseCell('14,802'), 'Accounts payable', '2024', thousands)).toMatchObject({ factor: 1e3, raw: '(Dollars in thousands, except per share amounts)' });
    // the row's own unit beats the table's
    expect(effectiveScale(parseCell('0.28'), '基本每股收益（元/股）', '本报告期', scaleIn('单位：万元'))).toMatchObject({ factor: 1, unit: '元/股' });
  });

  it('reads periods from column headers', () => {
    expect(parsePeriod('March 31, 2024')).toEqual({ key: '2024-03-31', span: null });
    expect(parsePeriod('For the three months ended March 31, 2023')).toEqual({ key: '2023-03-31', span: '3M' });
    expect(parsePeriod('2024年 03月 31日')).toMatchObject({ key: '2024-03-31' });
    expect(parsePeriod('2023 年 12 月 31 日')).toMatchObject({ key: '2023-12-31' });
    expect(parsePeriod('2024')).toMatchObject({ key: '2024' });
    expect(parsePeriod('2024年第一季度')).toMatchObject({ key: '2024-Q1', span: '3M' });
    expect(parsePeriod('期末余额').key).toBe('current');
    expect(parsePeriod('上年同期').key).toBe('prior');
    expect(parsePeriod('本报告期比上年同期增减（%）').key).toBe('change');
    expect(documentPeriod('# 卡莱特（301391）2024年一季度报告\n')).toBe('2024-03-31');
    expect(documentPeriod('FORM 10-Q\nFor the quarterly period ended March 31, 2024\n')).toBe('2024-03-31');
  });

  it('normalizes labels once, keeping Chinese and English line items under one key', () => {
    expect(labelKey('营业收入')).toBe('revenue');
    expect(labelKey('Revenues')).toBe('revenue');
    expect(labelKey('其中：营业收入')).toBe('revenue');
    expect(labelKey('应付账款')).toBe('accounts_payable');
    expect(labelKey('Accounts payable')).toBe('accounts_payable');
    expect(labelKey('Accounts receivable, net')).toBe('accounts_receivable');
    expect(labelKey('减：库存股')).toBe('treasury_stock');
    expect(labelKey('四、利润总额（亏损总额以“－”号填列）')).toBe('total_profit');
    expect(labelKey('Net income (loss)')).toBe('net_income');
    expect(labelKey('Net cash provided by (used in) operating activities')).toBe('operating_cash_flow');
    expect(labelKey('Net cash used in investing activities')).toBe('investing_cash_flow');
    expect(labelKey("Total stockholders' equity (deficit)")).toBe('total_equity');
    // a label no group holds is its cleaned self, and the raw label is never lost
    expect(labelKey('Accounts payable, related party')).toBe('accounts payable, related party');
    expect(cleanLabel('1.持续经营净利润（净亏损以“－”号填列）')).toBe('持续经营净利润');
  });
});

const ZH_REPORT = `# 卡莱特（301391）2024年一季度报告

一、主要财务数据
（一）主要会计数据和财务指标
|-|本报告期|上年同期|本报告期比上年同期增减（%）|
|---|---|---|---|
|营业收入（元）|142,734,076.02|132,710,272.70|7.55%|
|经营活动产生的现金流量净额（元）|-76,631,164.09|-16,105,623.52|-375.80%|
|基本每股收益（元/股）|0.28|0.43|-34.88%|（二）非经常性损益项目和金额
单位：元
|项目|本报告期金额|说明|
|---|---|---|
|减：所得税影响额|2,378,144.38|-||利润表项目|本期发生额|上期发生额|
|---|---|---|
|销售费用|25,912,621.73|17,805,378.00|
1、合并资产负债表
编制单位：卡莱特云科技股份有限公司
2024年 03月 31日
单位：元
|项目|期末余额|期初余额|
|---|---|---|
|流动资产：|-|-|
|货币资金|624,885,759.43|306,803,552.74|
|拆入资金|-|-||交易性金融负债|交易性金融负债|-|-|
|---|---|---|---|
|应付账款|应付账款|138,767,380.36|170,902,900.45|
|库存股|(49,973,689.38)|-|

第 12 页

|未分配利润|396,872,304.44|377,986,276.66|
|负债和所有者权益总计|2,878,819,360.26|2,864,868,520.85|法定代表人：周锦志
2、合并利润表
金额单位：人民币万元
|项目|本期发生额|上期发生额|
|---|---|---|
|一、营业总收入|14,273.41|13,271.03|
`;

describe('Markdown pipe tables (Chinese report)', () => {
  const parse = parseTables(ZH_REPORT);
  const lines = ZH_REPORT.split('\n');
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;

  it('reads the subject and the period of the report', () => {
    expect(parse.subject).toBe('卡莱特');
    expect(parse.docPeriod).toBe('2024-03-31');
  });

  it('types every cell: label, period, value, unit, scale and line', () => {
    const revenue = find(parse.facts, '营业收入（元）');
    expect(revenue.map((f) => [f.period, f.periodKey, f.valueNum, f.unit])).toEqual([
      ['本报告期', 'current', 142734076.02, '元'],
      ['上年同期', 'prior', 132710272.7, '元'],
      ['本报告期比上年同期增减（%）', 'change', 7.55, '%'],
    ]);
    expect(revenue[0]).toMatchObject({ labelKey: 'revenue', line: lineOf('|营业收入（元）|'), parser: 'pipe', scaleFactor: 1 });
    expect(find(parse.facts, '经营活动产生的现金流量净额（元）', '本报告期')[0].valueNum).toBe(-76631164.09);
    expect(find(parse.facts, '基本每股收益（元/股）', '本报告期')[0]).toMatchObject({ valueNum: 0.28, unit: '元/股', scaleFactor: 1 });
  });

  it('takes the glued heading as the next table\'s title, and splits a header glued to the row above it', () => {
    const tax = find(parse.facts, '减：所得税影响额', '本报告期金额')[0];
    expect(tax).toMatchObject({ valueNum: 2378144.38, scale: '单位：元', tableTitle: '（二）非经常性损益项目和金额' });
    const selling = find(parse.facts, '销售费用', '本期发生额')[0];
    expect(selling).toMatchObject({ valueNum: 25912621.73, line: lineOf('|销售费用|') });
    expect(selling.tableNo).not.toBe(tax.tableNo);
  });

  it('reads a dated balance sheet: its date for the current column, sections, dashes as no value', () => {
    const cash = find(parse.facts, '货币资金');
    expect(cash.map((f) => [f.periodKey, f.valueNum, f.section, f.scale])).toEqual([
      ['2024-03-31', 624885759.43, '流动资产', '单位：元'],
      ['prior', 306803552.74, '流动资产', '单位：元'],
    ]);
    expect(cash[0].tableTitle).toBe('1、合并资产负债表');
    expect(find(parse.facts, '拆入资金').map((f) => [f.valueNum, f.valueText])).toEqual([[null, '-'], [null, '-']]);
  });

  it('keeps a table going over a converter\'s page break: the false header row, a label written twice, a page number between', () => {
    const sheet = find(parse.facts, '货币资金')[0].tableNo;
    const payable = find(parse.facts, '应付账款');
    expect(payable.map((f) => [f.valueNum, f.period, f.tableNo])).toEqual([
      [138767380.36, '期末余额', sheet],
      [170902900.45, '期初余额', sheet],
    ]);
    expect(find(parse.facts, '交易性金融负债').map((f) => f.valueText)).toEqual(['-', '-']);
    // after "第 12 页", headerless: the same table, its header and scale
    const retained = find(parse.facts, '未分配利润', '期末余额')[0];
    expect(retained).toMatchObject({ tableNo: sheet, valueNum: 396872304.44, scale: '单位：元', line: lineOf('|未分配利润|') });
    expect(find(parse.facts, '负债和所有者权益总计', '期末余额')[0].valueNum).toBe(2878819360.26);
    // parentheses are negative
    expect(find(parse.facts, '库存股', '期末余额')[0].valueNum).toBe(-49973689.38);
  });

  it('applies a scale note stated in 万元 to the values, keeping both', () => {
    const total = find(parse.facts, '一、营业总收入', '本期发生额')[0];
    expect(total).toMatchObject({ valueNum: 14273.41, scale: '金额单位：人民币万元', scaleFactor: 1e4, labelKey: 'total_revenue', tableTitle: '2、合并利润表' });
  });
});

const NB = ' ';
const EN_10Q = `# Correlate Energy Corp. quarterly report (Form 10-Q), 2024 file
FORM 10-Q
For the quarterly period ended March 31, 2024

CORRELATE ENERGY CORP.

CONDENSED CONSOLIDATED BALANCE SHEETS

(in thousands, except per share data)

                                                          March 31,      December 31,

                                                             2024            2023

Current assets

Cash                                                  ${NB}$      101,665${NB}${NB}$    1,412,379${NB}

Accounts receivable                                          184,709         408,816

Intangible assets - customer relationships,

   net                                                       128,590         140,280

Total assets                                          $    3,047,769  $    4,560,690








Current liabilities

Accounts payable                                      ${NB}$      734,425${NB}${NB}$      304,400${NB}

Total liabilities                                          4,180,433       2,960,551

CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS

(in thousands, except per share data)

                                                        For the three months ended

                                                                March 31,

                                                           2024            2023

Revenues                                              $      432,799  $       50,734

Net loss                                              $   (3,519,710) $     (353,611)

Net loss per common share - Basic and diluted         $        (0.04)${NB}$        (0.00)
`;

describe('space-aligned text tables (an EDGAR 10-Q)', () => {
  const parse = parseTables(EN_10Q);
  const lines = EN_10Q.split('\n');
  const lineOf = (needle: string) => lines.findIndex((l) => l.startsWith(needle)) + 1;

  it('reads the registrant and the period', () => {
    expect(parse.subject).toBe('Correlate Energy Corp.');
    expect(parse.docPeriod).toBe('2024-03-31');
  });

  it('finds the columns by where the numbers end, the headers over two lines, the scale above', () => {
    const cash = find(parse.facts, 'Cash');
    expect(cash.map((f) => [f.period, f.periodKey, f.valueNum, f.scaleFactor])).toEqual([
      ['March 31, 2024', '2024-03-31', 101665, 1000],
      ['December 31, 2023', '2023-12-31', 1412379, 1000],
    ]);
    expect(cash[0]).toMatchObject({ scale: '(in thousands, except per share data)', unit: 'USD', line: lineOf('Cash'), parser: 'text', section: 'Current assets', labelKey: 'cash' });
    expect(parse.tables.find((t) => t.no === cash[0].tableNo)!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('joins a wrapped label, and keeps the scale across a page break', () => {
    expect(find(parse.facts, 'Intangible assets - customer relationships, net', 'March 31, 2024')[0].valueNum).toBe(128590);
    const payable = find(parse.facts, 'Accounts payable', 'March 31, 2024')[0];
    expect(payable).toMatchObject({ valueNum: 734425, scaleFactor: 1000, labelKey: 'accounts_payable' });
  });

  it('reads a duration header and parenthesized negatives; a per-share row is as written', () => {
    expect(find(parse.facts, 'Revenues').map((f) => [f.periodKey, f.periodSpan, f.valueNum])).toEqual([
      ['2024-03-31', '3M', 432799],
      ['2023-03-31', '3M', 50734],
    ]);
    expect(find(parse.facts, 'Net loss', 'For the three months ended March 31, 2024')[0].valueNum).toBe(-3519710);
    const eps = find(parse.facts, 'Net loss per common share - Basic and diluted');
    expect(eps.map((f) => [f.valueNum, f.scaleFactor])).toEqual([[-0.04, 1], [-0, 1]]);
    expect(eps[0].labelKey).toBe('eps_basic');
  });
});

const PDF_TEXT = `# BURL annual report, fiscal 2023

BURLINGTON STORES, INC.
CONSOLIDATED BALANCE SHEETS
(All amounts in thousands, except share and per share data)
January 28, January 29,
2023 2022
ASSETS
Current assets:
Cash and cash equivalents $ 872,623 $ 1,091,091
Accounts receivable—net of allowance for doubtful accounts of $1,252 and $3,305,
respectively 71,091 54,089
Total current assets 2,283,792 2,547,644
Total assets
$ 7,269,597 $ 7,089,513
Current liabilities:
Accounts payable $ 955,793 $ 1,080,802
Changes in working capital (125,006 ) 214,792
`;

describe('single-spaced rows (a PDF text layer)', () => {
  const parse = parseTables(PDF_TEXT);

  it('reads columns by order, with the two-line date header and the scale note', () => {
    const payable = find(parse.facts, 'Accounts payable');
    expect(payable.map((f) => [f.period, f.periodKey, f.valueNum, f.scaleFactor])).toEqual([
      ['January 28, 2023', '2023-01-28', 955793, 1000],
      ['January 29, 2022', '2022-01-29', 1080802, 1000],
    ]);
    expect(payable[0].section).toBe('Current liabilities');
  });

  it('takes a label written above its values, joins a wrapped one, and reads "(125,006 )"', () => {
    expect(find(parse.facts, 'Total assets').map((f) => f.valueNum)).toEqual([7269597, 7089513]);
    expect(find(parse.facts, 'Accounts receivable—net of allowance for doubtful accounts of $1,252 and $3,305, respectively').map((f) => f.valueNum)).toEqual([71091, 54089]);
    expect(find(parse.facts, 'Changes in working capital').map((f) => f.valueNum)).toEqual([-125006, 214792]);
  });
});

describe('subjects', () => {
  it('reads the company from the title forms the corpora use', () => {
    expect(documentSubject('', '卡莱特（301391）2024年一季度报告')).toBe('卡莱特');
    expect(documentSubject('', 'Dolphin Entertainment, Inc. annual report (Form 10-K), 2024 file')).toBe('Dolphin Entertainment, Inc.');
    expect(documentSubject('# 002699 2023年年度报告\n美盛文化创意股份有限公司 2023 年年度报告全文\n', null)).toBe('002699 美盛文化创意股份有限公司');
  });
});

/* ------------------------------ the model path ------------------------------ */

// a table a converter wrote one cell per line: nothing the layout reading can vouch for
const FLAT_LINES = ['# 示例 2024年一季度报告', '1、合并资产负债表', '单位：万元', '项目', '期末余额', '期初余额'];
for (let i = 0; i < 12; i++) FLAT_LINES.push(`科目${i}`, `${(1000 + i).toLocaleString('en-US')}.5${i}`, `${(2000 + i).toLocaleString('en-US')}.1${i}`);
const FLAT = `${FLAT_LINES.join('\n')}\n`;

describe('the model path (stubbed, no model is called)', () => {
  it('sends only segments dense with numbers that no confident table explains', () => {
    const flat = parseTables(FLAT);
    const segs = segmentText(FLAT, 12_000);
    expect(modelPathSegments(FLAT, segs, flat)).toHaveLength(1);
    // the pipe report and the 10-Q are explained by their own tables
    expect(modelPathSegments(ZH_REPORT, segmentText(ZH_REPORT, 12_000), parseTables(ZH_REPORT))).toHaveLength(0);
    expect(modelPathSegments(EN_10Q, segmentText(EN_10Q, 12_000), parseTables(EN_10Q))).toHaveLength(0);
    // prose with numbers in it is not a table row
    expect(isNumericLine('Net loss for the quarter ended March 31, 2024 was $3,401,000, as compared to a net loss of $5,059,000 for the quarter.')).toBe(false);
    expect(isNumericLine('Accounts payable    734,425    304,400')).toBe(true);
    expect(isNumericLine('1,001.51')).toBe(true);
  });

  it('numbers the lines in the request, and keeps only reply rows the text bears out', () => {
    const seg = { startLine: 1, endLine: FLAT_LINES.length };
    const [system, user] = tableModelMessages(FLAT, seg, { subject: '示例' });
    expect(system.content).toContain('no limit on the number of lines');
    expect(user.content).toContain('8| 1,000.50');
    const reply = [
      '```jsonl',
      '{"line": 7, "label": "科目0", "column": "期末余额", "value": "1,000.50", "scale": "单位：万元"}',
      '{"line": 9, "label": "科目0", "column": "期初余额", "value": "2,000.10", "scale": null}',
      '{"line": 10, "label": "科目1", "column": "期末余额", "value": "9,999.99", "scale": null}',
      '{"line": 10, "label": "不存在的科目", "column": "期末余额", "value": "1,001.51", "scale": null}',
      '{"line": 99, "label": "科目0", "column": "期末余额", "value": "1,000.50", "scale": null}',
      '{"line": 13, "label": "科目2", "column": "期末余额", "value": "1,002.52", "scale": "单位：亿元"}',
      '{"line": 14, "label": "科目3", "colu',
    ].join('\n');
    const rows = parseTableModelReply(reply, FLAT, seg);
    // a row named on its label's line moves to the line below where its value stands; an invented value, a label not near
    // it, a line out of range and a truncated line are dropped; a scale the text does not state is not kept
    expect(rows).toEqual([
      { line: 8, label: '科目0', column: '期末余额', value: '1,000.50', scale: '单位：万元' },
      { line: 9, label: '科目0', column: '期初余额', value: '2,000.10', scale: null },
      { line: 14, label: '科目2', column: '期末余额', value: '1,002.52', scale: null },
    ]);
    const facts = modelRowsToFacts(rows, FLAT, 7);
    expect(facts.map((f) => [f.line, f.label, f.periodKey, f.valueNum, f.scaleFactor, f.parser])).toEqual([
      [8, '科目0', 'current', 1000.5, 1e4, 'llm'],
      [9, '科目0', 'prior', 2000.1, 1e4, 'llm'],
      [14, '科目2', 'current', 1002.52, 1e4, 'llm'],
    ]);
  });

  it('normalizes labels through a model only for keys it was asked about, onto known keys', async () => {
    const asked: string[][] = [];
    const normalizer = modelNormalizer('stub', async (messages) => {
      asked.push(messages[1].content.split('\n'));
      return { mappings: [{ label: 'cost of goods and services sold', key: 'cost_of_revenue' }, { label: 'made up', key: 'revenue' }, { label: 'other', key: 'not_a_key' }] };
    });
    const out = await normalizer.normalize(['cost of goods and services sold', 'other']);
    expect(asked).toEqual([['1. cost of goods and services sold', '2. other']]);
    expect(out).toEqual([{ key: 'cost of goods and services sold', canonical: 'cost_of_revenue', reason: 'model' }]);
    expect(parseLabelNormalizeReply('nonsense', ['a'])).toEqual([]);
  });
});
