import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docText, type LoadedPack, loadPack } from '../src/eval/pack.js';
import { bodyOf, dateOf, ExcerptIndex } from '../src/eval/packs/crud-news.js';
import { recipe } from '../src/eval/packs/index.js';
import { describeReport, registrantOf, resolveDoc } from '../src/eval/packs/loong.js';
import { cheapLint, type PackMeasure, questionTerms } from '../src/eval/packs/measure.js';
import { checkTopThree, codesIn, redateRows, reportYear } from '../src/eval/packs/mudabench.js';
import { plainNumber, roundingTolerance, sampleByStratum } from '../src/eval/packs/real-docs.js';
import '../src/eval/packs/recipes.js';
import { valueForms } from '../src/eval/packs/wiki-hops.js';
import { wikitextToText } from '../src/eval/packs/wikitext.js';
import type { Task } from '../src/eval/types.js';

/**
 * The real-document recipes (docs/design/33 §4) on a small committed fixture
 * (tests/fixtures/real-docs): invented documents in each dataset's own
 * layout, never the downloads themselves.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'real-docs');
let tmp: string;
const packs: Record<string, LoadedPack> = {};
const task = (p: LoadedPack, pred: (t: Task) => boolean) => {
  const t = p.tasks.find(pred);
  expect(t).toBeDefined();
  return t!;
};
const measure = (p: LoadedPack) => JSON.parse(fs.readFileSync(path.join(p.dir, 'measure.json'), 'utf8')) as PackMeasure;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-real-'));
  const src = path.join(tmp, 'downloads');
  fs.cpSync(FIXTURE, src, { recursive: true });
  // the fetcher keeps Wikipedia revisions gzipped; the fixture keeps them readable
  const pages = path.join(src, 'wikipedia-revisions', 'pages');
  for (const f of fs.readdirSync(pages)) {
    fs.writeFileSync(path.join(pages, `${f}.gz`), zlib.gzipSync(fs.readFileSync(path.join(pages, f))));
    fs.rmSync(path.join(pages, f));
  }
  const build = async (name: string, id: string, options: Record<string, unknown>) => {
    const out = path.join(tmp, 'packs', name);
    const issues = await recipe(id).build(out, { seed: 0, log: () => {}, options });
    expect(issues.errors).toEqual([]);
    packs[name] = loadPack(out);
  };
  await build('loong', 'real-loong-finance', { from: path.join(src, 'loong') });
  await build('muda', 'real-mudabench', { from: path.join(src, 'mudabench') });
  await build('wiki', 'real-wiki-hops', { fanoutqa: path.join(src, 'fanoutqa'), frames: path.join(src, 'frames'), wikipedia: path.join(src, 'wikipedia-revisions') });
  await build('crud', 'real-crud-news-zh', { from: path.join(src, 'crud-rag') });
  await build('crud-2', 'real-crud-news-zh', { from: path.join(src, 'crud-rag'), questions: 2 });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('real-loong-finance', () => {
  it('asks every financial question of the whole corpus, naming what Loong handed over', () => {
    const p = packs.loong;
    expect(p.docs).toHaveLength(6);
    // legal questions and a document name that resolves to nothing are left out
    expect(p.tasks).toHaveLength(5);
    const cmp = task(p, (t) => t.meta?.stratum === 'zh-L2');
    expect(cmp.question).toBe("考虑以下公司的2024年财报：甲科技、乙制造、丙生物。请回答 '交易性金融资产' 最高的公司是哪一个？");
    expect(cmp).toMatchObject({ type: 'comparison', scoring: 'exact', answer: '丙生物' });
    expect(cmp.evidence).toHaveLength(3);
    const trend = task(p, (t) => t.meta?.stratum === 'en-L4');
    expect(trend.question.startsWith('For NORTHWIND TRADERS, INC.: ')).toBe(true);
    expect(trend).toMatchObject({ type: 'temporal', scoring: 'judge', meta: { family: 'timelines', hops: 2 } });
  });

  it('scores lookups by value, groupings as company–group items', () => {
    const p = packs.loong;
    const zh = task(p, (t) => t.meta?.stratum === 'zh-L1');
    expect(zh).toMatchObject({ type: 'numeric', scoring: 'value', answers: ['144,480.00', '144480.00'], meta: { tolerance: 0.0101, hops: 1 } });
    // a lookup's evidence is the named company's report, not Loong's distractor
    expect(zh.evidence).toHaveLength(1);
    expect(docText(p, zh.evidence[0].doc)).toContain('公允价值变动收益 144,480.00');
    expect(task(p, (t) => t.meta?.stratum === 'en-L1').answers).toEqual(['-$0.04', '-0.04']);
    const groups = task(p, (t) => t.meta?.stratum === 'zh-L3');
    expect(groups).toMatchObject({ type: 'aggregation', scoring: 'set', list: { match: 'fields', primary: 'exact' } });
    expect(groups.items!.map((i) => i.fields)).toEqual([[['甲科技'], ['高应收款']], [['丙生物'], ['中应收款']], [['乙制造'], ['低应收款']]]);
  });

  it('gives reports opaque paths and their company in the title', () => {
    const p = packs.loong;
    for (const d of p.docs) expect(d.path).toMatch(/^filings\/(zh|en)\/[0-9a-f]{12}\.md$/);
    expect(p.docs.map((d) => d.title)).toContain('NORTHWIND TRADERS, INC. annual report (Form 10-K), 2023 file');
    expect(p.docs.map((d) => d.title)).toContain('甲科技（600001）2024年一季度报告');
    expect(registrantOf('NORTHWIND TRADERS, INC.\n(Formerly Northwind Co.)\n(Exact name of registrant as specified')).toBe('NORTHWIND TRADERS, INC.');
    expect(describeReport('2024-Acme Widgets, Inc.-j.txt', '')).toMatchObject({ lang: 'en', company: 'Acme Widgets, Inc.', year: '2024' });
    // Loong's glob, but only a unique hit
    const files = ['2024-C-Bond Systems-j.txt', '2024-CLEARONE INC-j.txt', '2024-X-j.txt', '2024-X-n.txt'];
    expect(resolveDoc(files, 'C', 1)).toBeNull();
    expect(resolveDoc(files, 'X', 1)).toBeNull();
    expect(resolveDoc(files, 'CLEARONE INC', 1)).toBe('2024-CLEARONE INC-j.txt');
  });
});

describe('real-mudabench', () => {
  it('scopes "your knowledge base" to the question\'s own reports', () => {
    const p = packs.muda;
    // the ESG question is left out with its document type, and one that needs a report the corpus lacks
    expect(p.tasks).toHaveLength(5);
    const [all, five] = p.tasks.filter((t) => t.scoring === 'set');
    expect(all.question).toContain('以下6家公司2021年的年度报告：601398、002142、601166、600000、601288、601939。');
    expect(five.question).toContain('以下5家公司2021年的年度报告');
    expect(all.items!.map((i) => i.label)).toEqual(['601398', '002142', '601166']);
    expect(all).toMatchObject({ type: 'aggregate', list: { match: 'alias', primary: 'exact' }, meta: { family: 'aggregates', hops: 6, goldCheck: 'agrees' } });
  });

  it('keeps questions over an unreadable scan, not primary', () => {
    const p = packs.muda;
    const [all, five] = p.tasks.filter((t) => t.scoring === 'set');
    expect(all.primary).toBe(false);
    expect(all.meta?.unreadableEvidence).toHaveLength(1);
    expect(five.primary).toBe(true);
    expect(task(p, (t) => t.scoring === 'judge')).toMatchObject({ type: 'aggregation', answer: '极差为4.5个百分点。' });
  });

  it('reads a question about a year from the report that covers it, not the one filed in it', () => {
    const p = packs.muda;
    const head = (sym: string, year: number) => p.docs.find((d) => d.title === `${sym} annual report, fiscal ${year}`);
    // TGX's reports are filed under 2021 and 2022 and cover 2020 and 2021: headed by what they cover
    const [tgx2020, tgx2021] = [head('TGX', 2020), head('TGX', 2021)];
    expect(tgx2020 && tgx2021).toBeTruthy();
    expect(head('TGX', 2022)).toBeUndefined();
    expect(tgx2021!.date).toBe('2021');
    expect(head('AAA', 2022)).toBeTruthy();
    // 2021: re-pointed to the report for 2021, which the dataset files under 2022
    const y2021 = task(p, (t) => t.meta?.datasetId === 'q_0000000000000005');
    expect(y2021.evidence.map((e) => e.doc)).toContain(tgx2021!.path);
    expect(y2021.evidence.map((e) => e.doc)).not.toContain(tgx2020!.path);
    expect(y2021.items!.find((i) => i.label === 'TGX')!.docs).toEqual([tgx2021!.path]);
    expect(y2021.meta?.yearFixes).toEqual([{ symbol: 'TGX', year: 2021, from: tgx2020!.path, covers: 2020, to: tgx2021!.path }]);
    // 2022: no report for it; TGX is not in the gold, so it leaves the question's scope
    const y2022 = task(p, (t) => t.meta?.datasetId === 'q_0000000000000006');
    expect(y2022.question).toContain('the annual reports for 2022 of these 4 companies: AAA, BBB, CCC, DDD.');
    expect(y2022.evidence).toHaveLength(4);
    expect(y2022).toMatchObject({ type: 'aggregation', meta: { scopeDropped: ['TGX'] } });
    // the same, with TGX in the gold: unanswerable from the corpus, left out
    expect(p.tasks.find((t) => t.meta?.datasetId === 'q_0000000000000007')).toBeUndefined();
  });

  it('dates a US report by its cover and re-points or drops a misdated company', () => {
    expect(reportYear('ANNUAL REPORT\nFor the fiscal year ended December 31, 2020\nor')).toBe(2020);
    expect(reportYear('For the fiscal year ended: January 29 , 2022')).toBe(2022);
    expect(reportYear('Form 10-K, no cover period')).toBeUndefined();
    const m = (symbol: string, year: number, id: string) => ({ symbol, year, id, doctype: 'US Stock Annual Report' });
    const docMeta = new Map([m('A', 2021, 'a21'), m('B', 2021, 'b21'), m('T', 2021, 't20'), m('T', 2022, 't21')].map((x) => [x.id, x]));
    const years = new Map([['a21', 2021], ['b21', 2021], ['t20', 2020], ['t21', 2021]]);
    const row = (year: number, answer: string, question = 'the top companies by revenue? Provide their stock symbols.') => ({ question_id: `q${year}${answer}`, question, metadata: [m('A', year, `a${year - 2000}`), m('B', year, `b${year - 2000}`), m('T', year, year === 2021 ? 't20' : 't21')], source_answer: [], final_answer: answer });
    const { rows, left } = redateRows([row(2021, '[T], [A]'), row(2022, '[A], [B]'), row(2022, '[T]'), row(2022, 'about 4.5', 'the range of revenue?')], years, docMeta);
    expect(rows[0].metadata.map((x) => x.id)).toEqual(['a21', 'b21', 't21']);
    expect(rows[1].metadata.map((x) => x.symbol)).toEqual(['A', 'B']);
    expect(rows[1].scopeDropped).toEqual(['T']);
    // T in the gold, or a judged answer that may rest on T: needs a report the corpus lacks
    expect(left.map((l) => l.row.final_answer)).toEqual(['[T]', 'about 4.5']);
  });

  it('reads codes and recomputes a top three', () => {
    expect(codesIn('the top 3 are: [PLAY], [DY], [CMCO]', ['DY', 'CMCO', 'PLAY', 'AVT'])).toEqual(['PLAY', 'DY', 'CMCO']);
    expect(codesIn('601398、002142', ['601398', '002142', '1398'])).toEqual(['601398', '002142']);
    const meta = [5, 4, 3, 2].map((v, i) => ({ symbol: `S${i}`, year: 2021, id: `d${i}`, doctype: 'A股年报', value_x: v }));
    const row = { question_id: 'q', question: '资本充足率最高的三家公司股票代码', metadata: meta, source_answer: [], final_answer: '' };
    expect(checkTopThree(row, ['S0', 'S1', 'S2'])).toBe('agrees');
    expect(checkTopThree(row, ['S0', 'S1', 'S3'])).toBe('disagrees');
    expect(checkTopThree({ ...row, question: '增长最快的三家' }, ['S0'])).toBe('unchecked');
  });
});

describe('real-wiki-hops', () => {
  it('turns FanOutQA answers into sets, counts and names', () => {
    const p = packs.wiki;
    const hands = task(p, (t) => t.id === 'fanout-f000000000000001');
    expect(hands).toMatchObject({ scoring: 'set', list: { match: 'fields', primary: 'recall' }, meta: { hops: 2, fanout: 3, family: 'aggregates' } });
    expect(hands.items!.map((i) => i.fields)).toEqual([[['Pat Burrell'], ['Right']], [['Mark Mulder'], ['Left']]]);
    expect(task(p, (t) => t.id === 'fanout-f000000000000002')).toMatchObject({ scoring: 'count', answer: '1', type: 'numeric' });
    expect(valueForms('$1,027,000')).toEqual(['$1,027,000', '1,027,000', '1027000']);
  });

  it('keeps FRAMES questions whose articles were fetched, and every article as a document', () => {
    const p = packs.wiki;
    const f = task(p, (t) => t.meta?.source === 'frames');
    expect(p.tasks.filter((t) => t.meta?.source === 'frames')).toHaveLength(1);
    expect(f).toMatchObject({ id: 'frames-000', type: 'multi-hop', scoring: 'judge', answer: 'Jane Ballou', meta: { hops: 2, family: 'hops' } });
    expect(p.docs).toHaveLength(6);
    const draft = p.docs.find((d) => d.title === '1998 Example draft')!;
    expect(draft).toMatchObject({ date: '2023-11-01', kind: 'article' });
    const text = docText(p, draft.path);
    expect(text).toContain('first: Pat Burrell');
    expect(text).toContain('Pick | Player\n1 | Pat Burrell\n2 | Mulder');
    expect(text).not.toContain('cite web');
  });

  it('reads wikitext as a reader sees it', () => {
    const t = wikitextToText("{{Infobox person\n| name = A\n| birth_date = {{birth date and age|1976|10|10}}\n| image = x.jpg\n}}\n'''A''' plays for [[Team B|B]].<ref>{{cite news|title=t}}</ref> {{convert|10|km}} [[File:x.jpg|thumb|cap]]\n== Career ==\n* one\n[[Category:People]]");
    expect(t).toContain('birth date: October 10, 1976');
    expect(t).not.toContain('x.jpg');
    expect(t).toContain('A plays for B. 10 km');
    expect(t).toContain('## Career');
    expect(t).toContain('- one');
    expect(t).not.toContain('Category');
  });
});

describe('real-crud-news-zh', () => {
  it('maps excerpts to the articles they were cut from, adding the ones the corpus lacks', () => {
    const p = packs.crud;
    // four lines, one a duplicate; the single-document question's excerpt is not among them
    expect(p.docs).toHaveLength(4);
    const two = task(p, (t) => t.meta?.stratum === 'crud-2doc');
    expect(two).toMatchObject({ type: 'multi-hop', scoring: 'judge', meta: { hops: 2, family: 'hops' } });
    expect(docText(p, two.evidence[0].doc)).toContain('本次活动的主题为重视儿童眼保健');
    const one = task(p, (t) => t.meta?.stratum === 'crud-1doc');
    expect(docText(p, one.evidence[0].doc)).toContain('语料库里没有的报道');
    expect(one).toMatchObject({ type: 'single-hop', meta: { family: 'controls' } });
    expect(p.docs.every((d) => /^news\/[0-9a-f]{12}\.md$/.test(d.path))).toBe(true);
    expect(dateOf('07-29 09:00，正文：x')).toBe('2023-07-29');
    expect(dateOf('[ 2023-07-28 16：40 ] ，正文：x')).toBe('2023-07-28');
  });

  it('finds an excerpt that starts at a sentence inside an article', () => {
    const bodies = ['第一句话写得足够长以便作为索引键使用。第二句话也写得足够长以便作为索引键使用的，再长一些。'].map(bodyOf);
    const idx = new ExcerptIndex(bodies);
    expect(idx.find('第二句话也写得足够长以便作为索引键使用的，再长一些。')).toBe(0);
    expect(idx.find('前文。第二句话也写得足够长以便作为索引键使用的，再长一些。')).toBe(0);
    expect(idx.find('写得足够长')).toBe(0);
    expect(idx.find('另一篇完全不同的文章内容写得足够长以便作为索引键。')).toBeNull();
  });

  it('samples a stratified subset over the same corpus', () => {
    const p = packs['crud-2'];
    expect(p.manifest.id).toBe('real-crud-news-zh-2');
    expect(p.tasks).toHaveLength(2);
    expect(new Set(p.tasks.map((t) => t.meta?.stratum)).size).toBe(2);
    expect(p.docs).toHaveLength(packs.crud.docs.length);
  });
});

describe('measurement and the cheap lint', () => {
  it('measures every pack without a model', () => {
    for (const name of ['loong', 'muda', 'wiki', 'crud']) {
      const m = measure(packs[name]);
      expect(m.documents).toBe(packs[name].docs.length);
      expect(m.tasks).toBe(packs[name].tasks.length);
      expect(m.literalTerm).toBeGreaterThan(0);
      expect(Object.values(m.lengthBuckets).reduce((a, b) => a + b, 0)).toBe(m.documents);
    }
    expect(measure(packs.loong).hops).toMatchObject({ '1': 2, '3': 2, '2': 1 });
    expect(measure(packs.muda).singleDocument).toBe(0);
  });

  it('tokenises questions the way the corpus is searched', () => {
    expect([...questionTerms('What is the Basic Earnings of Acme in 2024?')].sort()).toEqual(['2024', 'acme', 'basic', 'earnings']);
    expect(questionTerms('甲科技的收益')).toEqual(new Set(['甲科技', '科技的', '技的收', '的收益', '甲科技的', '科技的收', '技的收益']));
  });

  it('catches an answer in a file name and one question with two golds', () => {
    const base = { suite: 'usage', type: 'single-hop', scoring: 'exact', evidence: [] } as const;
    const pack = {
      docs: [{ path: 'teams/platform-ops/2024.md' }, { path: 'x/1.md' }],
      tasks: [
        { ...base, id: 'a', question: 'Which team?', answer: 'platform-ops' },
        { ...base, id: 'b', question: 'How many?', answer: '3' },
        { ...base, id: 'c', question: 'how  many?', answer: '4' },
      ],
    } as unknown as LoadedPack;
    expect(cheapLint(pack)).toEqual({ answerInFileName: ['a'], duplicateQuestionDifferentGold: [['b', 'c']] });
  });

  it('reads numbers as datasets write them', () => {
    expect(plainNumber('-$0.04')).toBe('-0.04');
    expect(plainNumber('(1,234.5)')).toBe('-1234.5');
    expect(plainNumber('144,480.00')).toBe('144480.00');
    expect(plainNumber('迈克生物')).toBeNull();
    expect(roundingTolerance('144480.00')).toBe(0.0101);
    expect(roundingTolerance('12')).toBe(1.01);
    const ts = ['a', 'a', 'a', 'b'].map((s, i) => ({ id: `t${i}`, meta: { stratum: s } }) as unknown as Task);
    expect(sampleByStratum(ts, 2, 0).map((t) => t.meta?.stratum).sort()).toEqual(['a', 'b']);
  });
});
