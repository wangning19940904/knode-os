import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { joinChunks, tableLike, termWeights, widenPassages } from '../src/search/passages.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import { SearchResult } from '../src/types.js';

/**
 * Widened passages (src/search/passages.ts): before its completion `ask` reads
 * further into the documents behind its first passages — the rest of a short
 * document, the chunk after a table's cut, the chunk of a long document that
 * names what the question asks, the source behind a summary page — so the
 * answer step is not told the knowledge base lacks a row it holds.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-ask-passages-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}
const embedder = new FixtureEmbedder();
let store: Store;

async function addDoc(id: string, docPath: string, chunks: string[]): Promise<void> {
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed')`, [id, docPath, `sha-${id}`]);
  for (const [seq, content] of chunks.entries()) {
    await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, $3, $4, 3, to_tsvector('simple', $4))`, [`${id}-${seq}`, id, seq, content]);
    await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`${id}-${seq}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
  }
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', now())`, [`s-${id}`, docPath, `sha-${id}`]);
}

async function chunkOf(id: string): Promise<SearchResult> {
  const [r] = await store.query<{ id: string; document_id: string; content: string; path: string; title: string | null }>(
    `SELECT c.id, c.document_id, c.content, d.path, d.title FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = $1`, [id]);
  return { chunkId: r.id, documentId: r.document_id, path: r.path, title: r.title, content: r.content, score: 1, signals: {} };
}

// a 10-K page: the title, then a cash-flow statement split over three chunks
const statement = [
  '# General Mills 10K (GENERALMILLS_2020_10K), page 51',
  'Consolidated Statements of Cash Flows (In Millions)\nFiscal Year 2020 2019 2018\nCash Flows - Operating Activities\nNet earnings 2,210.8 1,786.2 2,163.0\nDepreciation and amortization 594.7 620.1 618.8\nNet cash provided by operating activities 3,676.2 2,807.0 2,841.0',
  'Cash Flows - Investing Activities\nPurchases of land, buildings, and equipment (460.8) (537.6) (622.7)\nAcquisitions, net of cash acquired - - (8,035.8)\nNet cash used by investing activities (447.7) (149.5) (8,685.4)',
  'Cash Flows - Financing Activities\nDividends paid (1,195.8) (1,181.7) (1,139.7)\nNet cash used by financing activities (2,100.6) (2,515.1) 5,458.4',
];

// a quarterly filing long enough not to be shown whole, the line asked for deep inside it
const filler = (i: number) => `全聚德2024年第一季度报告 第${i}节。本节叙述公司经营情况、门店与品牌建设、管理层讨论，以及与本季度相关的其他说明事项，${'内容从略。'.repeat(120)}`;
const filing = Array.from({ length: 12 }, (_, i) => filler(i));
filing[9] = '全聚德2024年第一季度报告 合并资产负债表（续）\n项目 期末余额 上年年末余额\n应收账款 21,345.00 19,876.10\n一年内到期的非流动资产 15,491.66 14,203.11\n其他流动资产 8,102.33 7,955.00';

// an annual report: the company on the cover and in many chunks, the line item asked for in a chunk that never names it
const annual = Array.from({ length: 20 }, (_, i) => i === 0
  ? 'Global Clean Energy Holdings, Inc. Annual Report on Form 10-K for 2024'
  : i % 2 ? `Global Clean Energy Holdings discusses its renewable fuels business, risks and outlook in part ${i}. ${'Narrative text. '.repeat(30)}`
    : `Notes to the financial statements, part ${i}. ${'Further narrative about accounts and policies. '.repeat(12)}`);
annual[13] = 'CONSOLIDATED BALANCE SHEETS (in thousands)\nCurrent liabilities\nAccounts payable 14,802 9,311\nAccrued liabilities 7,220 6,105\nNotes payable 258,923 241,770\nTotal current liabilities 323,686 300,104';
// a filing whose shown chunks fill the passage's cap: the matching chunk must still be in it
const tables = Array.from({ length: 10 }, (_, i) => `利润表附注 第${i}部分\n项目 本期 上期\n${Array.from({ length: 30 }, (_, j) => `科目${i}-${j} ${1000 + j},000.00 ${900 + j},000.00`).join('\n')}`);
tables[7] = '合并资产负债表（续）\n项目 期末余额\n一年内到期的非流动负债 1,150,005,581.95\n长期借款 2,003,114,000.00\n应付债券 0.00\n租赁负债 12,004,113.20';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addDoc('gm-p51', 'raw/docs/GENERALMILLS_2020_10K/p51.md', statement);
  await addDoc('qjd', 'raw/docs/filings/zh/qjd.md', filing);
  // a summary page of the 10-K page, and one built from two documents
  await addDoc('gceh', 'raw/docs/filings/en/gceh.md', annual);
  await addDoc('enjie', 'raw/docs/filings/zh/enjie.md', tables);
  await addDoc('gm-sum', 'wiki/sources/general-mills-page-51.md', ['General Mills cash flow statement summary for fiscal 2020: operating cash flow was strong.']);
  await addDoc('two-sum', 'wiki/sources/two-documents.md', ['A page built from two documents.']);
  await store.query(`INSERT INTO pages (path, kind, generator, inputs_sha, tx_from) VALUES ('wiki/sources/general-mills-page-51.md', 'source_summary', 'test', 'x', now()), ('wiki/sources/two-documents.md', 'source_summary', 'test', 'y', now())`);
  await store.query(`INSERT INTO deps (artifact_kind, artifact_id, input_kind, input_id) VALUES
    ('page', 'wiki/sources/general-mills-page-51.md', 'document', 'raw/docs/GENERALMILLS_2020_10K/p51.md'),
    ('page', 'wiki/sources/two-documents.md', 'document', 'raw/docs/GENERALMILLS_2020_10K/p51.md'),
    ('page', 'wiki/sources/two-documents.md', 'document', 'raw/docs/filings/zh/qjd.md')`);
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('passage helpers', () => {
  it('reads a statement as a table and prose as not', () => {
    expect(tableLike(statement[1])).toBe(true);
    expect(tableLike(filing[9])).toBe(true);
    expect(tableLike('One paragraph of prose.\nAnother line of prose.\nA third line.\nAnd a fourth.')).toBe(false);
  });

  it('says the overlap at a seam once', () => {
    expect(joinChunks(['alpha beta gamma delta epsilon zeta', 'gamma delta epsilon zeta eta theta'])).toBe('alpha beta gamma delta epsilon zeta eta theta');
    expect(joinChunks(['first part.', 'second part.'])).toBe('first part.\nsecond part.');
  });

  it('weights a term by its rarity in the document: the company in every chunk counts for nothing', () => {
    const w = termWeights('全聚德一年内到期的非流动资产是多少？', filing);
    expect(w.has('全聚')).toBe(false);
    expect(w.get('流动')).toBeGreaterThan(0);
  });
});

describe('widenPassages', () => {
  it('shows a short document whole in place of its chunk: the capex row after the cut reaches the answer', async () => {
    const hit = await chunkOf('gm-p51-1');
    const out = await widenPassages(store, 'What is the FY2020 free cash flow for General Mills?', [hit]);
    expect(out.documents).toBe(1);
    expect(out.contexts).toHaveLength(1);
    expect(out.contexts[0]).toMatchObject({ chunkId: 'gm-p51-1', path: 'raw/docs/GENERALMILLS_2020_10K/p51.md', widened: { seqs: [0, 1, 2, 3], of: 4 } });
    expect(out.contexts[0].content).toContain('Purchases of land, buildings, and equipment (460.8)');
    expect(out.contexts[0].content).toContain('Net cash provided by operating activities 3,676.2');
  });

  it('adds the chunk of a long document that names what the question asks, after the one the search returned', async () => {
    const hit = await chunkOf('qjd-2');
    const out = await widenPassages(store, '全聚德一年内到期的非流动资产是多少？', [hit]);
    expect(out.contexts).toHaveLength(1);
    const p = out.contexts[0];
    expect(p.widened?.seqs).toEqual(expect.arrayContaining([2, 9]));
    expect(p.widened!.seqs.length).toBeLessThanOrEqual(4);
    expect(p.content).toContain('一年内到期的非流动资产 15,491.66');
    expect(p.content).toContain('[…]');
    expect(p.content.indexOf('第2节')).toBeLessThan(p.content.indexOf('15,491.66'));
  });

  it('adds nothing to a long document no chunk of which names the question better than what is shown', async () => {
    const hit = await chunkOf('qjd-3');
    const out = await widenPassages(store, 'What colour is the sky on Mars?', [hit]);
    expect(out.documents).toBe(0);
    expect(out.contexts).toEqual([hit]);
  });

  it('follows a summary page with its source document, and folds the source chunks shown into it', async () => {
    const summary = await chunkOf('gm-sum-0');
    const raw = await chunkOf('gm-p51-1');
    const other = await chunkOf('qjd-0');
    const out = await widenPassages(store, 'General Mills FY2020 capital expenditures', [summary, other, raw]);
    expect(out.contexts.map((c) => c.path)).toEqual(['wiki/sources/general-mills-page-51.md', 'raw/docs/GENERALMILLS_2020_10K/p51.md', 'raw/docs/filings/zh/qjd.md']);
    expect(out.contexts[1].content).toContain('Purchases of land, buildings, and equipment');
  });

  it('leaves a page built from several documents, and an excerpt, as they are', async () => {
    const page = await chunkOf('two-sum-0');
    const excerpt = { ...(await chunkOf('gm-p51-1')), excerpt: true };
    const out = await widenPassages(store, 'capital expenditures', [page, excerpt]);
    expect(out.documents).toBe(0);
    expect(out.contexts).toEqual([page, excerpt]);
  });

  it('joins the chunks of one document the search returned apart into one passage, in document order', async () => {
    const parts = await Promise.all(['gm-p51-3', 'gm-p51-1', 'gm-p51-2'].map(chunkOf));
    const out = await widenPassages(store, 'General Mills investing activities', parts);
    expect(out.contexts).toHaveLength(1);
    expect(out.contexts[0]).toMatchObject({ chunkId: 'gm-p51-3', widened: { seqs: [0, 1, 2, 3], of: 4 } });
    expect(out.contexts[0].content.indexOf('Operating Activities')).toBeLessThan(out.contexts[0].content.indexOf('Financing Activities'));
  });

  it('weighs a phrase of the question over the company the cover names', async () => {
    const out = await widenPassages(store, 'What is the accounts payable of Global Clean Energy Holdings, Inc.?', [await chunkOf('gceh-3')]);
    expect(out.contexts[0].widened?.seqs).toContain(13);
    expect(out.contexts[0].content).toContain('Accounts payable 14,802');
  });

  it('keeps the chunk naming what is asked when the chunks shown would fill the passage', async () => {
    const shown = await Promise.all(['enjie-1', 'enjie-2', 'enjie-3', 'enjie-4'].map(chunkOf));
    const out = await widenPassages(store, '恩捷股份一年内到期的非流动负债是多少？', shown);
    const passage = out.contexts.find((c) => c.widened)!;
    expect(passage.content).toContain('一年内到期的非流动负债 1,150,005,581.95');
    expect(passage.content.length).toBeLessThanOrEqual(4001);
    // a shown chunk the passage could not hold keeps its own place
    const held = new Set(passage.widened!.seqs);
    for (const c of shown) if (!held.has(Number(c.chunkId.split('-')[1]))) expect(out.contexts.map((x) => x.chunkId)).toContain(c.chunkId);
  });

  it('stays within its budget', async () => {
    const hit = await chunkOf('gm-p51-1');
    const out = await widenPassages(store, 'free cash flow', [hit], { budget: 100 });
    expect(out.documents).toBe(0);
    expect(out.contexts[0].content).toBe(statement[1]);
  });
});

describe('ask', () => {
  function recordingLlm(): { llm: LlmClient; prompts: { system: string; user: string }[] } {
    const prompts: { system: string; user: string }[] = [];
    const llm = {
      enabled: true,
      complete: async (messages: ChatMessage[]) => {
        prompts.push({ system: messages[0].content, user: messages[1].content });
        return 'Answer.\n{"citations":[1],"gaps":[]}';
      },
    } as unknown as LlmClient;
    return { llm, prompts };
  }

  it('gives the answer step the widened passage, marked, and the rules for calculating from it', async () => {
    const { llm, prompts } = recordingLlm();
    const question = 'According to the statement of cash flows, what is the FY2020 free cash flow (cash from operations minus capex) for General Mills?';
    const res = await ask(store, defaultConfig(), embedder, llm, question, { mode: 'keyword', route: 'lookup', track: false });
    expect(res.contexts.map((c) => c.path)).toContain('raw/docs/GENERALMILLS_2020_10K/p51.md');
    expect(res.route.widened?.documents).toBeGreaterThan(0);
    expect(prompts[0].user).toMatch(/\(raw\/docs\/GENERALMILLS_2020_10K\/p51\.md, widened\)\n/);
    expect(prompts[0].user).toContain('Purchases of land, buildings, and equipment (460.8)');
    expect(prompts[0].system).toContain('compute a figure the question asks for');
    expect(prompts[0].system).toContain('Never guess');
    // a passage is cited by the document it is of
    expect(res.citations[0].path).toBe(res.contexts[0].path);
  });

  it('shows the chunks as cut when widening is off', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, defaultConfig(), embedder, llm, 'General Mills operating activities net earnings depreciation', { mode: 'keyword', route: 'lookup', track: false, widen: false });
    expect(res.route.widened).toBeUndefined();
    expect(prompts[0].user).not.toContain(', widened)');
  });
});
