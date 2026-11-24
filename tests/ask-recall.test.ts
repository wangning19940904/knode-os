import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { enumerateClaims, fillShares, subjectTimelines } from '../src/search/enumerate.js';
import { namedEntities } from '../src/search/facts.js';
import { questionRange } from '../src/search/route.js';
import { asksForValue, fuzzyPieces, metricParts, metricTerms, rowExcerpts, rowWindows } from '../src/search/rows.js';
import { around, isConceptWord, namedSubjects, SUBJECT_MIN_CHARS, subjectPassages } from '../src/search/subjects.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import type { SearchResult } from '../src/types.js';

/**
 * Ask's recall (docs/design/38 §6.2): R1, every subject a question names gets
 * its own documents' passage and its share of the facts, however many it
 * names; R2, a question asking for a value gets the lines of the documents in
 * hand that name its metric; R3, an enumeration lists what matches the
 * question rather than the oldest claims, a timeline is each subject's folded
 * chronology, and a window bounded by a day is read as that.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-ask-recall-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}
const embedder = new FixtureEmbedder();
let store: Store;

async function addDoc(id: string, chunks: string[], title = id, docDate: string | null = null): Promise<void> {
  const docPath = `raw/docs/${id}.md`;
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $3, $4, 10, 'indexed', $5)`, [id, docPath, title, `sha-${id}`, docDate]);
  for (const [seq, content] of chunks.entries()) {
    await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, $3, $4, 3, to_tsvector('simple', $4))`, [`${id}-${seq}`, id, seq, content]);
    await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`${id}-${seq}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
  }
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', now())`, [`s-${id}`, docPath, `sha-${id}`]);
}

async function addEntity(id: string, name: string, type = 'organization'): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

async function mention(entity: string, doc: string, seq = 0): Promise<void> {
  await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [entity, `${doc}-${seq}`, doc, `s-${doc}`]);
}

async function addClaim(id: string, subject: string, statement: string, doc: string, extra: { type?: string; eventAt?: string | null; validFrom?: string | null; txFrom?: string; attribute?: string; valueText?: string; supersededBy?: string; noChunk?: boolean } = {}): Promise<void> {
  await store.query(
    `INSERT INTO claims (id, subject_id, type, statement, status, kind, event_at, valid_from, chunk_id, primary_scope_id, superseded_by, evidence_count, attribute, value_text, tx_from)
     VALUES ($1, $2, $3, $4, 'fact', 'fact', $5, $6, $7, $8, $9, 1, $10, $11, COALESCE($12::timestamptz, now()))`,
    [id, subject, extra.type ?? 'event', statement, extra.eventAt ?? null, extra.validFrom ?? null, extra.noChunk ? null : `${doc}-0`, `s-${doc}`, extra.supersededBy ?? null, extra.attribute ?? null, extra.valueText ?? null, extra.txFrom ?? null],
  );
  await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) VALUES ('claim', $1, $2, 1, 'fixture', now())`, [id, `s-${doc}`]);
}

async function chunkOf(id: string): Promise<SearchResult> {
  const [r] = await store.query<{ id: string; document_id: string; content: string; path: string; title: string | null }>(
    `SELECT c.id, c.document_id, c.content, d.path, d.title FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1`, [id]);
  return { chunkId: r.id, documentId: r.document_id, path: r.path, title: r.title, content: r.content, score: 1, signals: {} };
}

/** A client that keeps each prompt and answers nothing. */
function recordingLlm(): { llm: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  const llm = {
    enabled: true,
    complete: async (messages: ChatMessage[]) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return '{"citations":[],"gaps":[]}';
    },
    completeJson: async () => { throw new Error('no JSON call expected'); },
  } as unknown as LlmClient;
  return { llm, prompts };
}

const config = defaultConfig();

// nine companies, each with a quarterly report: a cover, narrative, and the balance sheet with the asked-for row
const COMPANIES = ['倍加洁', '盾安环境', '迈克生物', '沪电股份', '全聚德', '和仁科技', '亿纬锂能', '蓝晓科技', '梅安森'];
const narrative = (name: string, i: number) => `${name}2024年第一季度报告 第${i}节 经营情况讨论与分析。${'本季度公司经营稳健，各项业务有序推进。'.repeat(20)}`;
const sheet = (name: string, value: string) => `${name} 合并资产负债表\n单位：元 币种：人民币\n| 项目 | 2024年3月31日 | 2023年12月31日 |\n| --- | --- | --- |\n| 货币资金 | 1,000,000.00 | 900,000.00 |\n| 交易性金融资产 | ${value} | 1.00 |\n| 应收账款 | 5,000.00 | 4,000.00 |`;

// a long filing: the line asked for in one chunk among many that never name it
const FILLER = Array.from({ length: 14 }, (_, i) => `英力特2024年第一季度报告 第${i}节。${'公司坚持稳健经营，持续推进各项工作。'.repeat(30)}`);
FILLER[11] = '合并利润表（续）\n单位：元\n| 项目 | 本期发生额 | 上期发生额 |\n| --- | --- | --- |\n| 投资收益 | 2,000.00 | 1,000.00 |\n| 公允价值变动收益（损失以“－”号填列） | 144,480.00 | -3,500.00 |\n| 信用减值损失 | -12.00 | -10.00 |';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;

  for (const [i, name] of COMPANIES.entries()) {
    const id = `co-${i}`;
    await addEntity(id, name);
    await addDoc(`filing-${i}`, [`${name}2024年第一季度报告`, narrative(name, 1), narrative(name, 2), sheet(name, `${(i + 1) * 1000}.00`)], `${name}2024年第一季度报告`);
    for (const seq of [0, 1, 2, 3]) await mention(id, `filing-${i}`, seq);
  }
  // a document about financial assets in general, which a search of the whole question finds first
  await addDoc('primer', ['交易性金融资产是指企业为了近期内出售而持有的金融资产。交易性金融资产最高的公司通常是哪一个？考虑以下公司的2024年财报。'], '金融资产入门');

  await addEntity('ylt', '英力特');
  await addDoc('ylt-q1', FILLER, '英力特2024年第一季度报告');
  for (const seq of [0, 1, 2]) await mention('ylt', 'ylt-q1', seq);

  // a hub with 400 claims, the newest; a small company with five, older: both named
  await addEntity('hub', 'Nimbus Freight');
  await addEntity('eps-standard', 'Earnings Per Share', 'technology');
  await addEntity('small', 'Borealis Logistics');
  await addDoc('hub-doc', ['Nimbus Freight operations log.']);
  await addDoc('small-doc', ['Borealis Logistics quarterly report.']);
  // read off a chunk no longer indexed: a fact the passages cannot hold, so only the facts can bring it
  for (let i = 0; i < 5; i++) await addClaim(`small-${i}`, 'small', `Borealis Logistics opened depot ${i}`, 'small-doc', { txFrom: '2026-01-01T00:00:00Z', noChunk: true });
  for (let i = 0; i < 400; i++) await addClaim(`hub-${i}`, 'hub', `Nimbus Freight moved shipment ${i}`, 'hub-doc', { txFrom: '2026-06-01T00:00:00Z' });

  // a project's weekly reports: started, a status restated week after week, a rename of its owner, closed after the window
  await addEntity('tbtt', '天弁天梯', 'project');
  for (let w = 1; w <= 12; w++) {
    const day = `2026-0${1 + Math.floor((w - 1) / 4)}-${String(1 + ((w - 1) % 4) * 7).padStart(2, '0')}`;
    await addDoc(`wk-${w}`, [`周报 第${w}周：天弁天梯项目进展。`], `周报 第${w}周`, day);
    await mention('tbtt', `wk-${w}`);
    await addClaim(`tbtt-status-${w}`, 'tbtt', '天弁天梯项目状态为进行中', `wk-${w}`, { type: 'status', validFrom: `${day}T00:00:00Z`, attribute: 'status', valueText: '进行中' });
  }
  await addClaim('tbtt-start', 'tbtt', '天弁天梯项目启动', 'wk-1', { type: 'milestone', eventAt: '2026-01-01T00:00:00Z' });
  await addClaim('tbtt-owner', 'tbtt', '天弁天梯项目负责人改为张敏', 'wk-6', { type: 'milestone', eventAt: '2026-02-08T00:00:00Z' });
  await addClaim('tbtt-closed', 'tbtt', '天弁天梯项目结项', 'wk-12', { type: 'milestone', eventAt: '2026-06-20T00:00:00Z' });

  // a list question's hub: 200 old incidents, then the three about payments the question asks for, newest
  await addEntity('ops', 'Orion Ops');
  await addDoc('ops-doc', ['Orion Ops incident log.']);
  for (let i = 0; i < 200; i++) await addClaim(`inc-${i}`, 'ops', `Orion Ops had a network incident number ${i}`, 'ops-doc', { type: 'incident', eventAt: `2025-0${1 + (i % 9)}-10T00:00:00Z` });
  for (let i = 0; i < 3; i++) await addClaim(`pay-${i}`, 'ops', `Orion Ops had a payments refund incident ${i}`, 'ops-doc', { type: 'incident', eventAt: `2026-03-1${i}T00:00:00Z` });
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('R1: every subject a question names gets its share', () => {
  const question = `考虑以下公司的2024年财报：${COMPANIES.join('、')}。请回答 '交易性金融资产' 最高的公司是哪一个？`;

  it('reads every named thing, past the six it used to stop at, in the question\'s order', async () => {
    const named = await namedEntities(store, question);
    expect(named.length).toBe(COMPANIES.length);
    const subjects = await namedSubjects(store, question);
    expect(subjects.map((s) => s.text)).toEqual(COMPANIES);
    expect(subjects.every((s) => !s.concept)).toBe(true);
  });

  it('puts each company\'s own report into the prompt, with the row asked for', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, config, embedder, llm, question, { mode: 'hybrid', track: false });
    const docs = new Set(res.contexts.map((c) => c.documentId));
    for (let i = 0; i < COMPANIES.length; i++) expect(docs.has(`filing-${i}`)).toBe(true);
    expect(res.route.subjects).toMatchObject({ named: COMPANIES.length });
    expect(res.route.subjects!.covered + res.route.subjects!.added).toBe(COMPANIES.length);
    for (let i = 0; i < COMPANIES.length; i++) expect(prompts[0]).toContain(`| 交易性金融资产 | ${(i + 1) * 1000}.00 |`);
  });

  it('bounds the passages by characters, not by how many subjects: a short budget gives fewer, each at least the shortest', async () => {
    const subjects = await namedSubjects(store, question);
    const all = await subjectPassages(store, question, subjects, []);
    expect(all.added).toBe(COMPANIES.length);
    expect(all.passages.map((p) => p.documentId)).toEqual(COMPANIES.map((_, i) => `filing-${i}`));
    // each its own report's balance sheet, the chunk naming the metric
    expect(all.passages.every((p) => p.content.includes('交易性金融资产'))).toBe(true);
    const budget = all.chars / 3;
    const short = await subjectPassages(store, question, subjects, [], { budget });
    expect(short.added).toBeGreaterThan(0);
    expect(short.added).toBeLessThan(all.added);
    expect(short.chars).toBeLessThanOrEqual(budget);
    // below the shortest passage, nothing more is added
    expect((await subjectPassages(store, question, subjects, [], { budget: SUBJECT_MIN_CHARS - 1 })).added).toBe(0);
    // a subject the passages hold a document of has its share already
    const held = await subjectPassages(store, question, subjects, [await chunkOf('filing-0-0')]);
    expect(held).toMatchObject({ covered: 1, added: COMPANIES.length - 1 });
  });

  it('without the subjects step, a search of the whole question leaves companies out', async () => {
    const { llm } = recordingLlm();
    const res = await ask(store, config, embedder, llm, question, { mode: 'hybrid', track: false, subjects: false });
    const docs = new Set(res.contexts.map((c) => c.documentId));
    expect(COMPANIES.filter((_, i) => !docs.has(`filing-${i}`)).length).toBeGreaterThan(0);
  });

  it('shares the facts among the named entities: the hub\'s newest 300 claims do not crowd out the other', async () => {
    const { llm } = recordingLlm();
    const res = await ask(store, config, embedder, llm, 'What did Nimbus Freight and Borealis Logistics do?', { mode: 'hybrid', track: false, route: 'lookup', rows: false });
    expect(res.facts.some((f) => f.id.startsWith('small-'))).toBe(true);
  });

  it('takes Latin words inside a phrase for part of it, not a subject', async () => {
    const subjects = await namedSubjects(store, 'What is the Basic Earnings Per Share of Nimbus Freight and Borealis Logistics?');
    expect(subjects.map((s) => [s.text, s.concept])).toEqual([['Earnings Per Share', true], ['Nimbus Freight', false], ['Borealis Logistics', false]]);
  });

  it('takes a lower-case common noun for a concept, not a subject', () => {
    expect(isConceptWord('company')).toBe(true);
    expect(isConceptWord('HARTE HANKS INC')).toBe(false);
    expect(isConceptWord('Gemini')).toBe(false);
    expect(isConceptWord('倍加洁')).toBe(false);
  });

  it('cuts a passage around the metric when the subjects share a short budget', () => {
    const text = `${'x'.repeat(2000)}交易性金融资产 12.00${'y'.repeat(2000)}`;
    const cut = around(text, ['交易性金融资产'], 600);
    expect(cut).toContain('交易性金融资产 12.00');
    expect(cut.length).toBeLessThanOrEqual(602);
  });
});

describe('R2: the line holding the value asked for', () => {
  it('reads the metric words out of a value question', () => {
    expect(metricTerms('英力特的公允价值变动收益是多少？', ['英力特'])).toEqual(['公允价值变动收益']);
    expect(metricTerms("考虑以下公司的2024年财报：倍加洁、盾安环境。请回答 '交易性金融资产' 最高的公司是哪一个？", ['倍加洁', '盾安环境'])).toEqual(['交易性金融资产']);
    expect(metricTerms('What is the Basic Earnings Per Share of General Enterprise Ventures, Inc.?', ['General Enterprise Ventures'])).toEqual(['basic earnings per share']);
    expect(metricTerms("Consider the 2024 reports of these companies: A and B. Which company has the highest 'Total Operating Revenue'?", ['A', 'B'])).toEqual(['total operating revenue']);
    expect(metricTerms('根据洋河股份2022年、2023年和2024年一季度的财报信息，销售商品、提供劳务收到的现金呈现了什么样的发展趋势？', ['洋河股份'])).toContain('销售商品、提供劳务收到的现金');
    expect(metricParts('销售商品、提供劳务收到的现金')).toEqual(['销售商品', '提供劳务收到', '现金']);
    // a name inside the metric's words is part of it: "Earnings Per Share" linked to an accounting standard
    expect(metricTerms('What is the Basic Earnings Per Share of General Enterprise Ventures, Inc.?', ['Earnings Per Share'])).toContain('basic earnings per share');
    expect(metricTerms('根据格力电器历年一季度财报信息，‘一年内到期的非流动负债’呈现什么样的变化趋势？请列出各个季度的具体数据。', ['格力电器'])).toEqual(['一年内到期的非流动负债']);
    // what says how to answer is not a metric
    expect(metricTerms('杭州平台组在2024年各周服务可用性的平均值是多少？以项目管理办公室核对后的数字为准，保留3位小数。', ['杭州平台组', '项目管理办公室'])).toEqual(['服务可用性']);
    expect(metricTerms('2024年第一季度，杭州平台组、杭州支付组和杭州增长组所有P1事故的影响时长加起来是多少分钟？（周报按其周一的日期计入月份、季度和年份。）', ['杭州平台组', '杭州支付组', '杭州增长组'])).toEqual(['p1事故的影响时长', '影响时长']);
  });

  it('knows a value question', () => {
    expect(asksForValue('英力特的公允价值变动收益是多少？')).toBe(true);
    expect(asksForValue('What is the capital surplus of HARTE HANKS INC in thousands?')).toBe(true);
    expect(asksForValue('谁负责天弁天梯项目？')).toBe(false);
  });

  it('shows a table row behind its header and its unit', () => {
    const windows = rowWindows(FILLER[11], ['公允价值变动收益']);
    expect(windows).toHaveLength(1);
    expect(windows[0].split('\n')).toEqual(['单位：元', '| 项目 | 本期发生额 | 上期发生额 |', '| 公允价值变动收益（损失以“－”号填列） | 144,480.00 | -3,500.00 |']);
  });

  it('reads a line naming the metric in other words only when asked to, for a document naming it in none of the question\'s', () => {
    expect(fuzzyPieces('公允价值变动损益')).toEqual({ pieces: ['公允', '允价', '价值', '值变', '变动', '动损', '损益'], need: 5 });
    expect(fuzzyPieces('basic earnings per share').need).toBe(3);
    // too short to match loosely
    expect(fuzzyPieces('专项储备').pieces).toEqual([]);
    expect(fuzzyPieces('net income').pieces).toEqual([]);
    expect(rowWindows(FILLER[11], ['公允价值变动损益'])).toEqual([]);
    expect(rowWindows(FILLER[11], ['公允价值变动损益'], true)).toHaveLength(1);
    const eps = 'Net loss per share:\n| Net loss per share – basic | (0.54) | (0.31) |\n| Weighted average shares | 10,000 | 9,000 |';
    expect(rowWindows(eps, ['basic earnings per share'], true)).toEqual(['| Net loss per share – basic | (0.54) | (0.31) |']);
    expect(metricTerms('格力电器的一般风险准备金额是多少（依据其2024年一季度报告）？', ['格力电器'])).toEqual(['一般风险准备']);
  });

  it('gives the loosely named line of a filing that never uses the question\'s words', async () => {
    const rows = await rowExcerpts(store, '英力特的公允价值变动损益是多少？', [await chunkOf('ylt-q1-0')], { names: ['英力特'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('144,480.00');
  });

  it('matches a metric written with its parts apart', () => {
    const content = '| 销售商品、提供劳务收到的现金 | 10.00 |\n| 收到的税费返还 | 1.00 |';
    expect(rowWindows(content, ['销售商品，提供劳务收到的现金'])).toHaveLength(1);
  });

  it('adds the line from a long filing the passages hold only the cover of, and not a line they show', async () => {
    const cover = await chunkOf('ylt-q1-0');
    const rows = await rowExcerpts(store, '英力特的公允价值变动收益是多少？', [cover], { names: ['英力特'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: 'ylt-q1', chunkId: 'ylt-q1-11', excerpt: true });
    expect(rows[0].content).toBe('单位：元\n| 项目 | 本期发生额 | 上期发生额 |\n| 公允价值变动收益（损失以“－”号填列） | 144,480.00 | -3,500.00 |');
    // the chunk holding it is in the passages already: nothing to add
    expect(await rowExcerpts(store, '英力特的公允价值变动收益是多少？', [cover, await chunkOf('ylt-q1-11')], { names: ['英力特'] })).toEqual([]);
    // a question naming no metric, or a document outside the passages, adds nothing
    expect(await rowExcerpts(store, '英力特是什么公司？', [cover], { names: ['英力特'] })).toEqual([]);
    expect(await rowExcerpts(store, '英力特的公允价值变动收益是多少？', [await chunkOf('filing-0-0')], { names: ['英力特'] })).toEqual([]);
  });

  it('gives Ask the rows of a value question, in an excerpt passage after the others', async () => {
    const { llm, prompts } = recordingLlm();
    const question = `考虑以下公司的2024年财报：${COMPANIES.join('、')}。请回答 '交易性金融资产' 最高的公司是哪一个？`;
    const res = await ask(store, config, embedder, llm, question, { mode: 'hybrid', track: false, widen: false });
    expect(res.route.rows?.terms).toEqual(['交易性金融资产']);
    expect(res.route.rows!.documents).toBeGreaterThan(0);
    const rows = res.contexts.filter((c) => c.excerpt);
    expect(rows.every((c) => c.content.includes('交易性金融资产'))).toBe(true);
    expect(prompts[0]).toContain('excerpt');
    const off = await ask(store, config, embedder, recordingLlm().llm, question, { mode: 'hybrid', track: false, widen: false, rows: false });
    expect(off.route.rows).toBeUndefined();
  });
});

describe('R3: enumerations by relevance and window, timelines folded', () => {
  it('reads a window bounded by a day as up to that day', () => {
    expect(questionRange('天弁天梯项目从启动到2026年5月1日为止，经历了哪些节点？按时间先后列出。')).toMatchObject({ from: null, to: '2026-05-01T23:59:59.999Z' });
    expect(questionRange('截至2025年3月31日，还有哪些风险未关闭？')).toMatchObject({ from: null, to: '2025-03-31T23:59:59.999Z' });
    expect(questionRange('自2024年2月5日以来有哪些人离职？')).toMatchObject({ from: '2024-02-05T00:00:00.000Z', to: null });
    expect(questionRange('从2024年3月4日到2024年7月15日，发生了哪些事故？')).toMatchObject({ from: '2024-03-04T00:00:00.000Z', to: '2024-07-15T23:59:59.999Z' });
    expect(questionRange('What changed through March 31, 2025?')).toMatchObject({ from: null, to: '2025-03-31T23:59:59.999Z' });
    // the month forms still read as before
    expect(questionRange('2024年5月发生了什么')).toMatchObject({ from: '2024-05-01T00:00:00.000Z', to: '2024-05-31T23:59:59.999Z' });
  });

  it('lists the claims matching the question, not the oldest', async () => {
    const query = { entities: ['ops'], types: [], order: 'timeline' as const, limit: 20 };
    const oldest = await enumerateClaims(store, query);
    expect(oldest.claims.some((c) => c.id.startsWith('pay-'))).toBe(false);
    const ranked = await enumerateClaims(store, { ...query, rank: { question: 'Which payments refund incidents did Orion Ops have?' } });
    expect(ranked.matched).toBe(203);
    expect(ranked.claims).toHaveLength(20);
    expect(ranked.claims.filter((c) => c.id.startsWith('pay-'))).toHaveLength(3);
    // still in date order
    const dates = ranked.claims.map((c) => c.date ?? '');
    expect([...dates].sort()).toEqual(dates);
  });

  it('gives a timeline each subject\'s folded chronology inside the window', async () => {
    const tl = await subjectTimelines(store, ['tbtt'], { range: questionRange('从启动到2026年5月1日为止'), limit: 150, question: '天弁天梯项目经历了哪些节点？' });
    const statements = tl.claims.map((c) => c.statement);
    expect(statements).toContain('天弁天梯项目启动');
    expect(statements).toContain('天弁天梯项目负责人改为张敏');
    expect(statements).not.toContain('天弁天梯项目结项');
    // twelve weekly "进行中" readings are one entry
    const status = tl.claims.filter((c) => c.statement === '天弁天梯项目状态为进行中');
    expect(status).toHaveLength(1);
    expect(status[0].repeats?.count).toBe(12);
  });

  it('shares a timeline\'s limit so a short chronology leaves its room to a long one', () => {
    expect(fillShares([6, 300, 2], 150)).toEqual([6, 142, 2]);
    expect(fillShares([100, 100], 150)).toEqual([75, 75]);
    expect(fillShares([100, 100, 100], 10)).toEqual([3, 3, 4]);
    expect(fillShares([3, 4], 150)).toEqual([3, 4]);
    expect(fillShares([], 150)).toEqual([]);
  });

  it('answers a timeline question from it', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, config, embedder, llm, '天弁天梯项目从启动到2026年5月1日为止，经历了哪些节点？按时间先后列出。', { mode: 'hybrid', track: false });
    expect(res.route.kind).toBe('timeline');
    expect(res.route.by).not.toMatch(/^fallback/);
    expect(res.route.timeline).toMatchObject({ subjects: 1 });
    expect(prompts[0]).toContain('天弁天梯项目负责人改为张敏');
    expect(prompts[0]).toMatch(/天弁天梯项目状态为进行中.*restated 11×/);
    expect(prompts[0]).not.toContain('天弁天梯项目结项');
  });
});
