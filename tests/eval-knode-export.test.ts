import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { Judge, LINK_SYSTEM } from '../src/eval/judge.js';
import { Meter } from '../src/eval/meter.js';
import { docText, loadPack, stageCorpus } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { taskPrompt } from '../src/eval/prompts.js';
import { QuotaGuard } from '../src/eval/quota.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { LINK_CITED_PASSAGES, scoreGeneration } from '../src/eval/score/generation.js';
import { startShim, type ChatRequest } from '../src/eval/shim.js';
import { claimWindow, knodeAsk, passageDocuments } from '../src/eval/systems/knode.js';
import type { SystemEnv } from '../src/eval/systems/types.js';
import type { KnowledgeUnit } from '../src/eval/types.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ASK_CONTEXT_CHARS } from '../src/search/ask.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * What the knode adapter hands the scorers (src/eval/systems/knode.ts), on one
 * small build: the units it exports for the generation suite, and what the
 * generation scorer shows its judge of them.
 */

/** The fixture's extraction, with a period on the claim read off the offer email. */
class DatedBackend extends ScriptedBackend {
  /** The prompts the answering model was sent. */
  asked: string[] = [];
  async complete(req: ChatRequest) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (system.includes('You answer questions from a personal knowledge base')) this.asked.push(user);
    if (!system.includes('knowledge-graph extraction engine') || !user.includes('岗位为高级数据工程师')) return super.complete(req);
    this.calls++;
    const text = JSON.stringify({
      entities: [
        { name: '林晓', type: 'person', description: '数据工程师', aliases: [] },
        { name: '澜舟科技', type: 'organization', description: '林晓的新公司', aliases: ['澜舟'] },
      ],
      relations: [{ source: '林晓', target: '澜舟科技', type: 'works_at', description: '入职' }],
      claims: [{ subject: '林晓', statement: '林晓在澜舟科技的试用期', type: 'event', status: 'fact', kind: 'fact', startDate: '2026-04-01', endDate: '2026-06-30' }],
    });
    return { text, usage: { inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 }, model: 'scripted' };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-export-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const base = path.join(tmp, 'runs', 'base');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
// a zone ahead of UTC, where the end of a day in UTC is the next morning: a date cut in local time is a day late
const zone = process.env.TZ;

const backend = new DatedBackend();
let env: SystemEnv;
let closeEnv: () => Promise<void>;
let units: KnowledgeUnit[];
const sys = knodeAsk();

beforeAll(async () => {
  process.env.TZ = 'Asia/Shanghai';
  buildFixturePack(packDir);
  await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: base, quota: false, suites: ['usage'], limit: 1, skipScoring: true, overrides: { chat: new DatedBackend(), judge: scriptedJudge(), embedder } });
  const pack = loadPack(packDir);
  const staged = stageCorpus(pack);
  const meter = new Meter();
  const shim = await startShim({ backend, embedder, meter });
  env = {
    runId: 'export', pack, staged, workDir: new RunStore(base).workDir(pack.manifest.id, 'knode'), shim, meter,
    quota: new QuotaGuard({ enabled: false }), models: { model: '', buildEffort: 'low', answerEffort: 'medium' }, log: () => {},
  };
  closeEnv = async () => {
    await sys.release!(env);
    await shim.close();
    staged.cleanup();
  };
  await sys.reopen!(env);
  units = await sys.exportKnowledge!(env);
}, 180_000);
afterAll(async () => {
  await closeEnv?.();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('exported claims', () => {
  it('say the period they hold for in ISO dates, the end day as stored', () => {
    const dated = units.filter((u) => u.kind === 'claim' && u.text.includes('试用期'));
    expect(dated).toHaveLength(1);
    expect(dated[0].text).toBe('林晓在澜舟科技的试用期 (2026-04-01 – 2026-06-30)');
    expect(dated[0].sources).toEqual(['email/2026-03-05.md']);
    // every date a claim unit carries is a whole one: no weekday-and-month cut of a Date
    for (const u of units.filter((x) => x.kind === 'claim')) expect(u.text).not.toMatch(/\((Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
  });

  it('reads a period from what either driver returns, with open sides', () => {
    // the stored instants: a day's start and a day's end in UTC (src/store/dates.ts)
    expect(claimWindow(new Date('2025-11-03T00:00:00.000Z'), new Date('2025-11-07T23:59:59.999Z'))).toBe(' (2025-11-03 – 2025-11-07)');
    expect(claimWindow('2025-11-03T00:00:00.000Z', '2025-11-07T23:59:59.999Z')).toBe(' (2025-11-03 – 2025-11-07)');
    expect(claimWindow(new Date('2025-11-03T00:00:00.000Z'), null)).toBe(' (2025-11-03 – )');
    expect(claimWindow(null, new Date('2025-11-07T23:59:59.999Z'))).toBe(' (? – 2025-11-07)');
    expect(claimWindow(null, null)).toBe('');
  });
});

describe('exported relations', () => {
  it('name the documents their evidence came from', () => {
    const docs = new Set(env.staged.docs.map((d) => d.path));
    const relations = units.filter((u) => u.kind === 'relation');
    const works = relations.find((u) => u.head === '林晓' && u.tail === '澜舟科技' && u.relation === 'works_at')!;
    // the scripted extraction reads the relation off every document it is shown
    expect(works.sources.length).toBeGreaterThan(1);
    expect(works.sources).toContain('email/2026-03-05.md');
    expect(new Set(works.sources).size).toBe(works.sources.length);
    for (const u of relations) for (const d of u.sources) expect(docs.has(d), d).toBe(true);
    // as its ends do: an entity's documents are the ones that mention it
    const person = units.find((u) => u.id === 'entity:林晓')!;
    for (const d of works.sources) expect(person.sources).toContain(d);
  });

  it('are judged against passages of those documents, a bounded number of them', async () => {
    const asked: { link: string; sources: string[] }[] = [];
    const scripted = scriptedJudge();
    const client = Object.assign(Object.create(scripted) as LlmClient, {
      completeJson: <T>(messages: ChatMessage[], opts?: Parameters<LlmClient['completeJson']>[1]) => {
        if (messages.some((m) => m.role === 'system' && m.content === LINK_SYSTEM)) asked.push(...(JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { link: string; sources: string[] }[] }).items);
        return scripted.completeJson<T>(messages, opts);
      },
    });
    const works = units.find((u) => u.kind === 'relation' && u.relation === 'works_at')!;
    const passages = (item: { sources: string[] }) => item.sources.map((p) => p.replace(/^\[\d+\] /, ''));
    const texts = works.sources.map((d) => docText(env.pack, d));
    const ofCited = (p: string) => texts.some((text) => text.includes(p.slice(0, 40)));
    const judged = async (linkPassages?: number) => {
      asked.length = 0;
      const scores = await scoreGeneration(env.pack, 'knode-ask', units, new Judge({ client, meter: new Meter() }), null, { linkPassages });
      expect(scores.find((r) => r.metric === 'link_precision')?.value).toBe(1);
      return passages(asked.find((i) => i.link === '林晓 —works_at→ 澜舟科技')!);
    };
    // by default: passages of the relation's own documents, more than the corpus search's five alone
    const shown = await judged();
    expect(shown.filter(ofCited).length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThanOrEqual(LINK_CITED_PASSAGES + 5);
    // a relation with more documents than the judge is to read: the best passages across them, then the search's
    expect(works.sources.length * 2).toBeGreaterThan(3);
    const few = await judged(3);
    expect(few.length).toBeLessThan(shown.length);
    expect(few.length).toBeLessThanOrEqual(3 + 5);
    expect(few.slice(0, 3).every(ofCited)).toBe(true);
    // every unit of the build says where it comes from, the relations too
    expect(units.filter((u) => u.kind === 'relation').every((u) => u.sources.length > 0)).toBe(true);
  });
});

describe("knode-ask's retrieval", () => {
  const pages = new Map([
    ['wiki/entities/inc-001.md', ['weekly/a/1.md', 'weekly/a/2.md', 'monthly/pmo-01.md']],
    ['wiki/sources/weekly/a/1.md', ['weekly/a/1.md']],
    ['wiki/sources/index.md', ['weekly/a/1.md', 'weekly/a/2.md']],
  ]);
  const corpus = new Set(['weekly/a/1.md', 'weekly/a/2.md', 'monthly/pmo-01.md']);

  it('counts a passage as the documents it puts before the model', () => {
    // a source chunk: its document
    expect(passageDocuments('raw/docs/weekly/a/1.md', 'text', pages, corpus)).toEqual(['weekly/a/1.md']);
    // a chunk of a page made from several: the documents its lines cite, in order, once each — not every document of the page
    const chunk = '## Current state\n- **级别**: P1 — raw/docs/weekly/a/2.md\n- **修复人**: 丁博 — raw/docs/weekly/a/1.md\n- **根因**: 配置 — raw/docs/weekly/a/2.md.';
    expect(passageDocuments('wiki/entities/inc-001.md', chunk, pages, corpus)).toEqual(['weekly/a/2.md', 'weekly/a/1.md']);
    // … and none when it cites none
    expect(passageDocuments('wiki/entities/inc-001.md', '# INC-001\n\n平台组的事故。', pages, corpus)).toEqual([]);
    // a page made from one document is that document
    expect(passageDocuments('wiki/sources/weekly/a/1.md', 'A summary.', pages, corpus)).toEqual(['weekly/a/1.md']);
    // a navigation page lists documents and holds nothing of them
    expect(passageDocuments('wiki/sources/index.md', '* A - `raw/docs/weekly/a/1.md`', pages, corpus)).toEqual([]);
    // only what the prompt keeps of the passage: a citation past the cut, or a path the cut broke, is not shown
    const long = `${'x'.repeat(ASK_CONTEXT_CHARS - 'raw/docs/weekly/a/'.length - 1)} raw/docs/weekly/a/1.md — raw/docs/monthly/pmo-01.md`;
    expect(passageDocuments('wiki/entities/inc-001.md', long, pages, corpus)).toEqual([]);
    expect(passageDocuments('wiki/entities/inc-001.md', `raw/docs/weekly/a/1.md ${long}`, pages, corpus)).toEqual(['weekly/a/1.md']);
  });

  it('scores the ranking and `retrieved` from what the answer sent its model', async () => {
    const docs = new Set(env.staged.docs.map((d) => d.path));
    for (const id of ['q1', 'c-runs', 'c-chain']) {
      const task = env.staged.tasks.find((t) => t.id === id)!;
      backend.asked.length = 0;
      const a = await sys.answer!(task, taskPrompt(task), env);
      expect(backend.asked, id).toHaveLength(1);
      const prompt = backend.asked[0];
      // read back from the prompt itself: the passages as it numbers them (`[n] (path)`, or with the source's date and
      // what the passage is: `[n] (path, 2026-01-05, newest, widened)`, then the text), then the facts, each with the
      // one source it shows
      const question = prompt.indexOf('\n\n# Question');
      const factsAt = prompt.indexOf('\n\n# Known facts');
      const context = prompt.slice(prompt.indexOf('# Context'), factsAt >= 0 ? factsAt : question);
      const heads = [...context.matchAll(/^\[\d+\] \(([^),]+)(?:, [^)\n]*)?\)$/gm)];
      const sent: string[] = [];
      const sources: string[] = [];
      heads.forEach((h, i) => {
        const text = context.slice(h.index! + h[0].length, heads[i + 1]?.index ?? context.length);
        if (h[1].startsWith('raw/docs/')) sources.push(h[1].slice('raw/docs/'.length));
        if (h[1].startsWith('raw/docs/')) sent.push(h[1].slice('raw/docs/'.length));
        else if (!/(^|\/)(index|log|overview)\.md$/.test(h[1])) sent.push(...[...text.matchAll(/raw\/docs\/([a-z]+\/[\d-]+\.md)/g)].map((m) => m[1]));
      });
      if (factsAt >= 0) sent.push(...[...prompt.slice(factsAt, question).matchAll(/ — raw\/docs\/([a-z]+\/[\d-]+\.md)/g)].map((m) => m[1]));
      expect(sources.length, id).toBeGreaterThan(0);
      const retrieved = a.retrieved!;
      // every document the prompt puts before the model, once, in the prompt's order — and no other
      expect(retrieved, id).toEqual([...new Set(sent)]);
      for (const d of retrieved) expect(docs.has(d), d).toBe(true);
      // what the answer cites is a passage's documents, among those sent
      for (const c of a.citations ?? []) expect(retrieved, id).toContain(c.doc);
      // the retrieval probe is the same retrieval without the completion
      const ranked = await sys.retrieve!(task.question, 5, env);
      expect(ranked, id).toEqual(retrieved.slice(0, 5));
      expect(backend.asked, id).toHaveLength(1);
    }
    // These three questions no longer have a document that reaches the model only through a generated page: a
    // question routed to the walk now also gets the lookup route's graph search and excerpts (docs/design/30 §3),
    // which reach every cited document directly. The page's citations are still read (the per-task equality above,
    // and passageDocuments' test); a case of a document reached only through a page is wanted.
  });
});
