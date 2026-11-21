import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/llm/client.js';
import { canonicalListPairs, Judge } from '../src/eval/judge.js';
import { abstainAnswered, lintBeforeRun, lintPack } from '../src/eval/lint.js';
import { Meter } from '../src/eval/meter.js';
import { loadPack } from '../src/eval/pack.js';
import { absentCorpus, bestPassage } from '../src/eval/packs/absent.js';
import { draftUnanswerable } from '../src/eval/packs/gold.js';
import { PackWriter } from '../src/eval/packs/writer.js';
import { matchByAnchors, nearDate, parseLooseDate, scoreLists } from '../src/eval/score/lists.js';
import { scoreUsage } from '../src/eval/score/usage.js';
import { emptyUsage, type AnswerRecord, type GoldFact, type ScoreRecord, type Task } from '../src/eval/types.js';

/*
 * Three defects of the 2026-11 campaign's gold and grading (all-31, 26 packs
 * analysed 2026-11-21): "unanswerable" questions a document answers, global
 * questions every arm scored 0.5 on, and list verdicts a second judge pass
 * agreed with 69% of the time.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-grading-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const answer = (taskId: string, text: string, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  key: `${taskId}-${extra.system ?? 's'}`, pack: 'p', system: 's', taskId, text, finalAnswer: '', citations: [], retrieved: [], toolCalls: 0,
  usage: emptyUsage(), ms: 10, at: new Date().toISOString(), ...extra,
});
const metric = (rs: ScoreRecord[], taskId: string, m: string, system = 's') => rs.find((r) => r.taskId === taskId && r.metric === m && r.system === system);

/* ------------------------------ 1. unanswerable questions ------------------------------ */

const SURMOUNT = `# Tirzepatide for Weight Reduction in Chinese Adults With Obesity: The SURMOUNT-CN Randomized Clinical Trial.

DESIGN, SETTING, AND PARTICIPANTS: This randomized, double-blind, placebo-controlled, phase 3 clinical trial conducted at 29 centers in China from September 2021 to December 2022 included Chinese adults with obesity.

RESULTS: Of 210 randomized participants (103 [49.0%] female; mean [SD] age, 36.1 [9.1] years), 201 (95.7%) completed the trial.
`;

function medicinePack(dir: string) {
  const w = new PackWriter(dir, { id: 'abstain-planted', version: 1, title: 'abstain', domain: 'fixture', languages: ['en'], description: 'planted abstain faults', builder: { recipe: 'test' } });
  w.addDoc({ path: 'pubmed/38819983.md', lang: 'en' }, SURMOUNT);
  for (let i = 0; i < 12; i++) w.addDoc({ path: `pubmed/other-${i}.md`, lang: 'en' }, `# Semaglutide trial ${i}\n\nOnce-weekly semaglutide reduced body weight versus placebo in adults with obesity over 68 weeks.\n`);
  // a drafted "unanswerable" question the abstract answers (t-u-020ffb6c00)
  w.addTask({ id: 'answered', suite: 'usage', type: 'unanswerable', lang: 'en', question: 'How many participants were randomized in SURMOUNT-CN, the tirzepatide trial conducted in China?', scoring: 'abstain', evidence: [] });
  // one the corpus does not answer
  w.addTask({ id: 'absent', suite: 'usage', type: 'unanswerable', lang: 'en', question: 'Which pharmacy chain stocked the pens first in Brazil?', scoring: 'abstain', evidence: [] });
  // the same words, planted by a recipe from its world model (a namesake on a third team): left out
  w.addTask({ id: 'planted', suite: 'usage', type: 'unanswerable', lang: 'en', question: 'How many participants were randomized in SURMOUNT-CN, the tirzepatide trial conducted in China?', scoring: 'abstain', evidence: [], meta: { subtype: 'unanswerable-namesake' } });
  w.finish();
  return loadPack(dir);
}

describe('abstain tasks the corpus answers', () => {
  it('flags an abstain question whose distinctive terms stand in one passage, and only that one', () => {
    const r = lintPack(medicinePack(path.join(tmp, 'abstain')));
    const flagged = r.findings.filter((f) => f.rule === 'abstain-in-corpus');
    expect(flagged.map((f) => f.task)).toEqual(['answered']);
    expect(flagged[0].message).toMatch(/pubmed\/38819983\.md/);
    // advisory: reported before a run, which goes ahead
    const gate = lintBeforeRun([medicinePack(path.join(tmp, 'abstain-gate'))]);
    expect(gate.ok).toBe(true);
    expect(gate.report).toMatch(/advisory/);
  });

  it('finds the passage in Chinese too (t-u-335ef541a8, diseases/水俣病.md)', () => {
    const docs = [
      { path: 'diseases/水俣病.md', text: '（一）治疗：6、间-二巯基琥珀酸0.5g，每日3次，连服5天，可使尿汞排泄比治疗前增加8倍。' },
      ...Array.from({ length: 10 }, (_, i) => ({ path: `diseases/d${i}.md`, text: `第${i}种疾病的临床表现与治疗原则，常用药物剂量见说明书。` })),
    ];
    const q = '间-二巯基琥珀酸治疗汞中毒时的常用口服剂量是多少？';
    const hit = bestPassage(q, absentCorpus(docs, [q]));
    expect(hit?.doc).toBe('diseases/水俣病.md');
    expect(hit!.terms.slice(0, 3)).toEqual(expect.arrayContaining(['二巯']));
  });

  it('lists an abstain task several systems answer from the same document, from a run\'s answers', () => {
    const pack = medicinePack(path.join(tmp, 'abstain-runs'));
    const ans = (system: string, finalAnswer: string, doc?: string) => ({ system, taskId: 'answered', finalAnswer, citations: doc ? [{ doc }] : [] });
    const found = abstainAnswered(pack, [
      ans('agent-grep', '210 participants were randomized.', 'pubmed/38819983.md'),
      ans('rag-hybrid', '210 participants.', 'pubmed/38819983.md'),
      ans('knode-ask', 'It is not mentioned in the sources.'),
      { system: 'agent-grep', taskId: 'absent', finalAnswer: 'Not stated in the documents.', citations: [] },
    ]);
    expect(found.map((f) => [f.task, f.doc, f.citing, f.answered])).toEqual([['answered', 'pubmed/38819983.md', 2, ['agent-grep', 'rag-hybrid']]]);
    // the judge's abstain_correct wins over the decline phrases where the run scored it
    const scored = abstainAnswered(pack, [ans('agent-grep', '210', 'pubmed/38819983.md'), ans('rag-hybrid', '210', 'pubmed/38819983.md')], [{ system: 'rag-hybrid', taskId: 'answered', metric: 'abstain_correct', value: 1 }]);
    expect(scored).toEqual([]);
  });

  it('drafts unanswerable questions against the corpus: a co-occurring one dropped unasked, the rest checked on whole passages', async () => {
    const seen: string[] = [];
    const author = {
      label: 'author', model: 'author', enabled: true,
      async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
        const user = messages.find((m) => m.role === 'user')!.content;
        seen.push(user);
        if (/^Write/.test(messages[0].content)) return { questions: ['How many participants were randomized in SURMOUNT-CN, the tirzepatide trial conducted in China?', 'Which pharmacy chain stocked the pens first in Brazil?'] } as T;
        const asked = JSON.parse(user) as { i: number; question: string; passages: string[] }[];
        return { verdicts: asked.map((q) => ({ i: q.i, answerable: false })) } as T;
      },
    } as unknown as LlmClient;
    const docs = [{ path: 'pubmed/38819983.md', text: SURMOUNT }, ...Array.from({ length: 12 }, (_, i) => ({ path: `pubmed/other-${i}.md`, text: `# Semaglutide trial ${i}\n\nOnce-weekly semaglutide reduced body weight.\n` }))];
    const facts: GoldFact[] = [{ id: 'f1', text: 'Semaglutide reduced body weight.', doc: 'pubmed/other-1.md', quote: 'semaglutide reduced body weight', entities: ['semaglutide'], kind: 'fact' }];
    const tasks = await draftUnanswerable(author, facts, docs, { lang: 'English', langCode: 'en', n: 2, seed: 0, prefix: 't', entities: ['semaglutide'] });
    expect(tasks.map((t) => t.question)).toEqual(['Which pharmacy chain stocked the pens first in Brazil?']);
    // the check was asked about the other question only, and saw passages uncut
    const check = JSON.parse(seen[1]) as { question: string; passages: string[] }[];
    expect(check.map((c) => c.question)).toEqual(['Which pharmacy chain stocked the pens first in Brazil?']);
    expect(check[0].passages.every((p) => !p.endsWith('…'))).toBe(true);
  });
});

/* ------------------------------ 2. global questions ------------------------------ */

describe('keypoints tasks', () => {
  it('are as right as the share of key points stated, the grade kept beside it', async () => {
    const t: Task = { id: 'g', suite: 'usage', type: 'global', question: 'What are the main approaches?', scoring: 'keypoints', evidence: [], keypoints: ['a', 'b', 'c', 'd'], answer: 'a; b; c; d' };
    const j: Task = { id: 'j', suite: 'usage', type: 'single-hop', question: 'Who?', scoring: 'judge', evidence: [], answer: 'X', keypoints: ['X'] };
    const judge = {
      gradeAnswers: async (items: { id: string; question: string }[]) => new Map(items.map((i) => [i.id, i.question.startsWith('What') ? { score: 1, keypoints: [0, 2, 2, 9], abstained: false, hallucinated: false } : { score: 1, keypoints: [0], abstained: false, hallucinated: false }])),
    } as unknown as Judge;
    const rs = await scoreUsage({ answers: [answer('g', 'a and c'), answer('j', 'X, partly')], tasks: new Map([['p|g', t], ['p|j', j]]), citing: new Set() }, judge);
    // two distinct key points of four in range: 0.5, whatever the 3-point grade
    expect(metric(rs, 'g', 'correctness')?.value).toBe(0.5);
    expect(metric(rs, 'g', 'correctness')?.detail).toMatchObject({ metric: 'keypoint_recall', grade: 0.5 });
    expect(metric(rs, 'g', 'grade')?.value).toBe(0.5);
    expect(metric(rs, 'g', 'keypoint_recall')?.value).toBe(0.5);
    // a judge-scored task with key points keeps the grade as its correctness
    expect(metric(rs, 'j', 'correctness')?.value).toBe(0.5);
    expect(metric(rs, 'j', 'keypoint_recall')?.value).toBe(1);
  });
});

/* ------------------------------ 3. list grading ------------------------------ */

const gold = (label: string, aliases: string[], date?: string) => ({ label, aliases, weight: 1, ...(date ? { date } : {}) });

describe('model-free anchors for judge-matched lists', () => {
  it('reads ISO weeks as their Monday, and dates within a week as near', () => {
    expect(parseLooseDate('2024年第3周')).toEqual({ y: 2024, m: 1, d: 15 });
    expect(parseLooseDate('2024-W03')).toEqual({ y: 2024, m: 1, d: 15 });
    expect(parseLooseDate('week 3 of 2024')).toEqual({ y: 2024, m: 1, d: 15 });
    expect(parseLooseDate('2026-W01')).toEqual({ y: 2025, m: 12, d: 29 });
    expect(nearDate('2025-06-16', '2025-06-12')).toBe(true);
    expect(nearDate('2025-06-16', '2025-06-09')).toBe(false);
    expect(nearDate('2025-06', '2025-06-09')).toBe(false);
    expect(nearDate('2025-06-30', '2025-06')).toBe(true);
  });

  it('pairs an entry that names one gold entry\'s rare term, with agreeing dates, and leaves the rest to the judge', () => {
    // synthetic-reports-zh-v3, timeline (audit ebeed1d2e52f9aedae03)
    const g = [
      gold('GRW1-C2改为35元', ['35'], '2025-05-26'),
      gold('任琳从杭州平台组调入', ['任琳'], '2025-05-26'),
      gold('任琳接手天柱锚点', ['任琳'], '2025-06-09'),
      gold('新风险R-136', ['R-136'], '2025-06-09'),
      gold('天柱锚点改名为摇光枢纽', ['摇光枢纽'], '2025-06-30'),
    ];
    const p = [
      { label: '天柱锚点进度升至23%，负责人变为任琳', date: '2025-06-16' },
      { label: 'R-136未关闭，郝洋跟进', date: '2025-06-09' },
      { label: '天柱锚点更名为摇光枢纽，进度29%', date: '2025-06-30' },
      { label: '摇光枢纽进度升至34%', date: '2025-07-14' },
      { label: '礼包金额35元', date: '2025-05-26' },
    ];
    // 摇光枢纽 is named by two entries: it tells nothing apart; 35 is a number; 任琳's dates are a week off
    expect(matchByAnchors(p, g, '杭州增长组发生了哪些变化？', 'timeline')).toEqual([[1, 3]]);
    // the question's own words never anchor; a contradiction's topics never do
    expect(matchByAnchors([{ label: 'R-136关闭' }], g, 'R-136的状态如何变化？', 'timeline')).toEqual([]);
    expect(matchByAnchors([{ label: 'R-136关闭' }], g, '?', 'contradiction')).toEqual([]);
    // an entry naming two gold entries' terms is a merge: the judge's
    expect(matchByAnchors([{ label: '新风险R-136，天柱锚点改名为摇光枢纽' }], g, '?', 'timeline')).toEqual([]);
  });

  it('asks the judge only about the entries left, in a canonical order, and maps its pairs back', async () => {
    const t: Task = {
      id: 'tl', suite: 'usage', type: 'timeline', question: '项目经历了什么？', scoring: 'set', evidence: [],
      items: [gold('新风险R-136', ['R-136'], '2025-06-09'), gold('任琳接手天柱锚点', ['任琳'], '2025-06-09'), gold('心宿工坊上线', ['心宿工坊'], '2025-06-02')],
      list: { match: 'judge', ordered: true, maxItems: 10, requireDocs: false, primary: 'f1' },
    };
    const asked: { predicted: string[]; gold: string[] }[] = [];
    const judge = {
      matchList: async (items: { id: string; predicted: string[]; gold: string[] }[]) => {
        asked.push(...items);
        // pair "任琳…" with the 任琳 gold entry, written in a scrambled order with a duplicate
        return new Map(items.map((i) => [i.id, { pairs: [[i.predicted.findIndex((x) => x.includes('负责人任琳')), i.gold.findIndex((x) => x.includes('任琳'))], [99, 0], [i.predicted.findIndex((x) => x.includes('负责人任琳')), 1]] }]));
      },
    } as unknown as Judge;
    const json = (items: { label: string; date: string }[]) => JSON.stringify({ items: items.map((i) => ({ ...i, confidence: 0.9, evidence: [] })) });
    const a1 = answer('tl', json([{ label: 'R-136新增', date: '2025-06-09' }, { label: '天柱锚点负责人任琳', date: '2025-06-20' }, { label: '团队9人', date: '2025-06-02' }]));
    const a2 = answer('tl', json([{ label: '团队9人', date: '2025-06-02' }, { label: '天柱锚点负责人任琳', date: '2025-06-20' }, { label: 'R-136新增', date: '2025-06-09' }]), { system: 't' });
    const rs = await scoreLists({ answers: [a1, a2], tasks: new Map([['p|tl', t]]), corpusDocs: new Map() }, judge);
    // R-136 anchored without the judge (任琳's dates are eleven days apart); the judge saw two predicted and two gold entries, the same for both answers
    expect(asked).toHaveLength(2);
    expect(asked[0].predicted).toEqual(['团队9人 (2025-06-02)', '天柱锚点负责人任琳 (2025-06-20)']);
    expect(asked[1].predicted).toEqual(asked[0].predicted);
    expect(asked[0].gold).toEqual(['任琳接手天柱锚点 (2025-06-09) / 任琳', '心宿工坊上线 (2025-06-02) / 心宿工坊']);
    for (const s of ['s', 't']) {
      expect(metric(rs, 'tl', 'set_recall', s)?.value).toBeCloseTo(2 / 3);
      expect(metric(rs, 'tl', 'set_recall', s)?.detail).toMatchObject({ pairedBy: { anchored: 1, judged: 1 } });
    }
  });

  it('reads a judge\'s pairs as one matching whatever order it wrote them in', () => {
    expect(canonicalListPairs([[2, 4], [2, 3], [0, 0], [5, 1], [1, 0]], 3, 5)).toEqual([[0, 0], [2, 3]]);
    expect(canonicalListPairs([[2, 3], [0, 0], [2, 4]], 3, 5)).toEqual(canonicalListPairs([[0, 0], [2, 4], [2, 3]], 3, 5));
    expect(canonicalListPairs('junk', 3, 3)).toEqual([]);
  });

  it('asks the judge one list per call', async () => {
    const calls: number[] = [];
    const client = {
      label: 'j', model: 'j', enabled: true,
      async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
        const items = (JSON.parse(messages[1].content) as { items: { id: string }[] }).items;
        calls.push(items.length);
        return { verdicts: items.map((i) => ({ id: i.id, pairs: [[0, 0]] })) } as T;
      },
    } as unknown as LlmClient;
    const judge = new Judge({ client, meter: new Meter(), batchSize: 8 });
    const lists = Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, predicted: [`p${i}`], gold: [`g${i}`] }));
    expect((await judge.matchList(lists)).size).toBe(5);
    expect((await judge.matchItems(lists.map((l) => ({ ...l, id: `m${l.id}` })))).size).toBe(5);
    expect(calls).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});
