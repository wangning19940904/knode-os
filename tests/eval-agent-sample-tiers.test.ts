import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  agentAllocationFor,
  formatSampleReport,
  headroomAllocation,
  questionClasses,
  questionClassOf,
  sampleByType,
  sampleReportOf,
  sharesFor,
  typeQuotas,
  type AgentAllocation,
  type QuestionClass,
} from '../src/eval/allocation.js';
import { agentAllocationOption } from '../src/eval/cli.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { loadPack } from '../src/eval/pack.js';
import { headroomRecords } from '../src/eval/report.js';
import { planAgentSample, selectTasks } from '../src/eval/run.js';
import type { RunMeta } from '../src/eval/runstore.js';
import type { ScoreRecord, Task } from '../src/eval/types.js';

/**
 * Sampling an agent sample by what earlier records saw of each question
 * (docs/design/36 §5, "Sampling by question"): contested questions first,
 * never-seen ones by the type weights, agreed ones only when nothing else is
 * left, all-wrong ones left out and listed; and the report of the sample
 * printed before any model is called.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sample-tiers-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const task = (id: string, type: string): Task => ({ id, suite: 'usage', type: type as Task['type'], question: id, scoring: 'judge', evidence: [] });
/** 20 aggregate (a0–a19), 20 temporal (t0–t19), 10 single-hop (s0–s9). */
const TASKS = [
  ...Array.from({ length: 20 }, (_, i) => task(`a${i}`, 'aggregate')),
  ...Array.from({ length: 20 }, (_, i) => task(`t${i}`, 'temporal')),
  ...Array.from({ length: 10 }, (_, i) => task(`s${i}`, 'single-hop')),
];
const SUITES = new Set(['usage']);
const ids = (ts: Task[]) => ts.map((t) => t.id);
const byType = (ts: Task[]) => ts.reduce<Record<string, number>>((m, t) => ((m[t.type] = (m[t.type] ?? 0) + 1), m), {});

describe('a question\'s class', () => {
  it('is contested where two arms, or one arm\'s repeats, scored it differently', () => {
    expect(questionClassOf([[1], [0]])).toBe('contested');
    expect(questionClassOf([[1], [0.5]])).toBe('contested');
    expect(questionClassOf([[1, 0], [1]])).toBe('contested');
    // one arm alone says something only when its repeats disagree
    expect(questionClassOf([[1, 0]])).toBe('contested');
    expect(questionClassOf([[1, 1]])).toBeNull();
    expect(questionClassOf([[0]])).toBeNull();
    expect(questionClassOf([])).toBeNull();
  });
  it('is right, wrong or the same partial score where every answer of two or more arms agreed', () => {
    expect(questionClassOf([[1, 1], [1]])).toBe('right');
    expect(questionClassOf([[0], [0], [0, 0]])).toBe('wrong');
    expect(questionClassOf([[0.5], [0.5]])).toBe('partial');
    expect(questionClassOf([[], [1], [1]])).toBe('right');
  });
  it('is read per pack and task over every arm\'s answers, without a score', () => {
    const c = questionClasses([
      { arm: 'g', pack: 'p', taskId: 'x', taskType: 'aggregate', value: 1 },
      { arm: 'k', pack: 'p', taskId: 'x', value: 0 },
      { arm: 'g', pack: 'p', taskId: 'y', value: 0 },
      { arm: 'k', pack: 'p', taskId: 'y', value: null },
      { arm: 'g', pack: 'q', taskId: 'x', value: 1 },
      { arm: 'k', pack: 'q', taskId: 'x', value: 1 },
    ]);
    expect(c).toEqual({ p: { x: { type: 'aggregate', cls: 'contested' } }, q: { x: { type: 'untyped', cls: 'right' } } });
  });
});

/** Classes for TASKS: a0–a4 wrong, a5–a9 right, a10 contested; t0–t3 contested, t4–t9 right; s0 partial; the rest never seen. */
function classes(): Record<string, QuestionClass> {
  const c: Record<string, QuestionClass> = {};
  for (let i = 0; i < 5; i++) c[`a${i}`] = 'wrong';
  for (let i = 5; i < 10; i++) c[`a${i}`] = 'right';
  c.a10 = 'contested';
  for (let i = 0; i < 4; i++) c[`t${i}`] = 'contested';
  for (let i = 4; i < 10; i++) c[`t${i}`] = 'right';
  c.s0 = 'partial';
  return c;
}

describe('the sample in tiers', () => {
  const shares = { weights: { aggregate: 1, temporal: 1, 'single-hop': 1 }, floor: 1, classes: classes() };
  it('takes every contested question first, then never-seen ones, and leaves all-wrong ones out', () => {
    const picked = selectTasks(TASKS, SUITES, 20, 0, shares);
    expect(picked).toHaveLength(20);
    expect(ids(picked).slice(0, 5).sort()).toEqual(['a10', 't0', 't1', 't2', 't3']);
    const c = shares.classes;
    expect(picked.slice(5).every((t) => c[t.id] === undefined)).toBe(true);
    expect(picked.some((t) => c[t.id] === 'wrong' || c[t.id] === 'right')).toBe(false);
  });
  it('takes agreed questions only when no never-seen one is left, and all-wrong ones only up to --agent-suspects', () => {
    // never seen: a11–a19 (9), t10–t19 (10), s1–s9 (9) = 28; contested 5; agreed 12 (11 right, 1 partial)
    const all = selectTasks(TASKS, SUITES, 50, 0, shares);
    expect(all).toHaveLength(45);
    expect(all.filter((t) => shares.classes[t.id] === 'wrong')).toHaveLength(0);
    // the agreed come after every never-seen one
    const firstAgreed = all.findIndex((t) => shares.classes[t.id] === 'right' || shares.classes[t.id] === 'partial');
    expect(firstAgreed).toBe(33);
    const withSuspects = selectTasks(TASKS, SUITES, 50, 0, { ...shares, suspects: 2 });
    expect(withSuspects).toHaveLength(47);
    expect(withSuspects.slice(-2).every((t) => shares.classes[t.id] === 'wrong')).toBe(true);
  });
  it('spreads the never-seen questions by the type weights, a type\'s floor counting what the contested tier gave it', () => {
    const picked = selectTasks(TASKS, SUITES, 15, 0, { ...shares, weights: { aggregate: 8, temporal: 1, 'single-hop': 1 } });
    // contested: 1 aggregate, 4 temporal, so both have their floor; then 10 never seen: single-hop its floor of 1,
    // the other 9 at 8 : 1 : 1, whole questions by largest share (all to aggregate)
    const unseen = picked.filter((t) => shares.classes[t.id] === undefined);
    expect(unseen).toHaveLength(10);
    expect(byType(unseen)).toEqual({ aggregate: 9, 'single-hop': 1 });
    expect(typeQuotas(new Map([['x', 5], ['y', 5]]), 4, { weights: { x: 1, y: 1 }, floor: 2 }, new Map([['x', 2]]))).toEqual(new Map([['x', 1], ['y', 3]]));
  });
  it('is the same for the same seed, and another for another', () => {
    const a = ids(selectTasks(TASKS, SUITES, 20, 7, shares));
    expect(ids(selectTasks(TASKS, SUITES, 20, 7, shares))).toEqual(a);
    expect(ids(selectTasks(TASKS, SUITES, 20, 8, shares))).not.toEqual(a);
  });
  it('without classes samples as before', () => {
    const { classes: _, ...plain } = shares;
    expect(ids(selectTasks(TASKS, SUITES, 20, 0, plain))).toEqual(ids(selectTasks(TASKS, SUITES, 20, 0, { weights: plain.weights, floor: 1 })));
  });
});

describe('the sample report', () => {
  it('counts the sample by what the records saw, lists the suspects left out, and warns when few are expected to be contested', () => {
    const shares = { weights: { '*': 1 }, floor: 1, classes: classes(), contested: { aggregate: 0.1, temporal: 0.4, '*': 0.2 } };
    const picked = selectTasks(TASKS, SUITES, 20, 0, shares);
    const r = sampleReportOf(TASKS, picked, shares)!;
    expect(r.n).toBe(20);
    expect(r.taken).toEqual({ contested: 5, unseen: 15, right: 0, partial: 0, wrong: 0 });
    expect(r.suspects).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    const unseen = byType(picked.filter((t) => !shares.classes[t.id]));
    expect(r.expected).toBeCloseTo(5 + (unseen.aggregate ?? 0) * 0.1 + (unseen.temporal ?? 0) * 0.4 + (unseen['single-hop'] ?? 0) * 0.2, 3);
    expect(r.warning).toMatch(/^mostly uninformative: about \d+ of 20 questions are expected to be contested \(5 seen contested, 15 never seen\)/);
    expect(r.mde).toBeCloseTo((2.8 * Math.sqrt(r.expected!)) / 20, 3);
    const lines = formatSampleReport('p', sampleByType(TASKS, picked, shares), r);
    expect(lines[0]).toMatch(/^\[p\] agent sample by what the records saw: 20 of 50 — 5 contested, 15 never seen; about [\d.]+ expected contested$/);
    expect(lines.some((l) => /5 all-wrong question\(s\) left out.*a0, a1, a2, a3, a4/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^ {2}warning: mostly uninformative/);
  });
  it('gives no warning when most of the sample was contested, and no report without classes', () => {
    const c: Record<string, QuestionClass> = Object.fromEntries(TASKS.slice(0, 30).map((t) => [t.id, 'contested']));
    const shares = { weights: { '*': 1 }, classes: c, contested: { '*': 0.5 } };
    const r = sampleReportOf(TASKS, selectTasks(TASKS, SUITES, 30, 0, shares), shares)!;
    expect(r.taken.contested).toBe(30);
    expect(r.warning).toBeNull();
    expect(sampleReportOf(TASKS, TASKS, { weights: { '*': 1 } })).toBeNull();
  });
});

/** Scores of one run of pack p: three agent arms and one single-call system, a repeat, per TASKS-like questions. */
function writeRun(dir: string, packs: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const rows: [string, string, number, number?][] = [
    // x0: arms agree right; x1: arms agree wrong; x2: arms differ; x3: grep's repeat differs
    ['agent-grep', 'x0', 1], ['agent-rag', 'x0', 1], ['agent-knode-full', 'x0', 1],
    ['agent-grep', 'x1', 0], ['agent-rag', 'x1', 0], ['agent-knode-full', 'x1', 0],
    ['agent-grep', 'x2', 1], ['agent-rag', 'x2', 0], ['agent-knode-full', 'x2', 1],
    ['agent-grep', 'x3', 1], ['agent-grep', 'x3', 0, 2], ['agent-rag', 'x3', 1], ['agent-knode-full', 'x3', 1],
    // a single call that got x1 right does not make it contested: only agent arms count
    ['knode-ask', 'x1', 1],
  ];
  const scores: ScoreRecord[] = rows.map(([system, taskId, value, repeat], i) => ({ key: `k${i}`, pack: 'p', system, suite: 'usage', taskId, taskType: 'aggregate', metric: 'correctness', value, at: '', ...(repeat ? { repeat } : {}) }));
  fs.writeFileSync(path.join(dir, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ packs }));
}

describe('headroom from per-question records', () => {
  it('classes each question over the agent arms\' answers, repeats included, keyed by the pack directory a copied run names by path', () => {
    const run = path.join(tmp, 'run-a');
    writeRun(run, ['/somewhere/packs-next/p-v2']);
    const rec = headroomRecords([run]);
    expect(Object.keys(rec.types)).toEqual(['p-v2']);
    expect(rec.questions).toEqual({ 'p-v2': { x0: { type: 'aggregate', cls: 'right' }, x1: { type: 'aggregate', cls: 'wrong' }, x2: { type: 'aggregate', cls: 'contested' }, x3: { type: 'aggregate', cls: 'contested' } } });
  });
  it('records the classes and contested shares in the allocation, and the pack\'s shares carry them', () => {
    const run = path.join(tmp, 'run-a');
    const alloc = agentAllocationOption({ agentHeadroomFrom: run, agentSuspects: '1' })!;
    expect(alloc.questions).toEqual({ 'p-v2': { x0: 'right', x1: 'wrong', x2: 'contested', x3: 'contested' } });
    // two of four contested, pooled (2 + ½) / 5, the pack's own shrunk toward it: (2 + 5 · 0.5) / (4 + 5)
    expect(alloc.contested!['*'].aggregate).toBeCloseTo(0.5, 5);
    expect(alloc.contested!['p-v2'].aggregate).toBeCloseTo(0.5, 5);
    expect(alloc.suspects).toBe(1);
    const s = sharesFor(alloc, 'p-v2', 'p');
    expect(s.classes).toBe(alloc.questions!['p-v2']);
    expect(s.suspects).toBe(1);
    // a pack the records never saw: tiers on, every question never seen
    expect(sharesFor(alloc, 'other').classes).toEqual({});
    expect(sharesFor(alloc, 'other').contested).toEqual(alloc.contested!['*']);
  });
  it('plain stratified keeps the tiers and weighs every type the same; stale questions are sampled as never seen', () => {
    const run = path.join(tmp, 'run-a');
    const even = agentAllocationOption({ agentHeadroomFrom: run, agentHeadroomTypes: 'even' })!;
    expect(even.types).toBe('even');
    expect(even.byPack).toEqual({ '*': { '*': 1 }, 'p-v2': { '*': 1 } });
    expect(even.questions!['p-v2'].x2).toBe('contested');
    const file = path.join(tmp, 'stale.txt');
    fs.writeFileSync(file, '# reworded on 2026-11-22\nx1  the three highest\nx2\n');
    const stale = agentAllocationOption({ agentHeadroomFrom: run, agentHeadroomStale: file })!;
    expect(stale.stale).toEqual(['x1', 'x2']);
    expect(stale.questions!['p-v2']).toEqual({ x0: 'right', x3: 'contested' });
    expect(agentAllocationOption({ agentHeadroomFrom: run, agentHeadroomStale: 'x0' })!.questions!['p-v2']).toEqual({ x1: 'wrong', x2: 'contested', x3: 'contested' });
  });
  it('refuses the headroom options without --agent-headroom-from, and bad values', () => {
    expect(() => agentAllocationOption({ agentSuspects: '1' })).toThrow(/with --agent-headroom-from/);
    expect(() => agentAllocationOption({ agentWeights: 'aggregate=1', agentHeadroomTypes: 'even' })).toThrow(/with --agent-headroom-from/);
    expect(() => agentAllocationOption({ agentHeadroomFrom: path.join(tmp, 'run-a'), agentSuspects: '-1' })).toThrow(/whole number/);
    expect(() => agentAllocationOption({ agentHeadroomFrom: path.join(tmp, 'run-a'), agentHeadroomTypes: 'wide' })).toThrow(/spread or even/);
  });
  it('on a resume keeps the recorded classes, and refuses another suspect cap or type rule', () => {
    const recorded = headroomAllocation({ p: { aggregate: { n: 4, differ: 2, spread: 2, allRight: 1, noneRight: 1 } } }, { from: ['/x'], questions: { p: { x1: { type: 'aggregate', cls: 'wrong' } } } });
    const meta = { id: 'r1', agentSample: { limit: 30, updateLimit: null, allocation: recorded, byPack: {}, updates: {} } } as unknown as RunMeta;
    const now: AgentAllocation = { ...recorded, questions: { p: { x1: 'right' } } };
    expect(agentAllocationFor(now, meta)).toBe(recorded);
    expect(() => agentAllocationFor({ ...recorded, suspects: 3 }, meta)).toThrow(/sampled its agent questions by headroom from \/x, floor 1, by question/);
    expect(() => agentAllocationFor({ ...recorded, types: 'even' }, meta)).toThrow(/resume it with that allocation/);
  });
});

describe('the sample before a run', () => {
  it('is worked out from the pack alone, with the report the run prints first', () => {
    const dir = path.join(tmp, 'packs');
    buildFixturePack(dir);
    const pack = loadPack(dir);
    const usage = pack.tasks.filter((t) => t.suite === 'usage' && !t.afterUpdate);
    const first = usage[0];
    const alloc = headroomAllocation({ [path.basename(pack.dir)]: { [first.type]: { n: 1, differ: 0, spread: 0, allRight: 0, noneRight: 1 } } }, {
      questions: { [path.basename(pack.dir)]: { [first.id]: { type: first.type, cls: 'wrong' } } },
    });
    const plan = planAgentSample(pack, pack.tasks, { suites: new Set(['usage']), agentLimit: 30, seed: 0, allocation: alloc });
    expect(plan.agentTasks.map((t) => t.id)).not.toContain(first.id);
    expect(plan.agentTasks).toHaveLength(usage.length - 1);
    expect(plan.report!.suspects).toEqual([first.id]);
    expect(plan.lines[0]).toMatch(new RegExp(`^\\[${pack.manifest.id}\\] agent sample by what the records saw: ${usage.length - 1} of ${usage.length}`));
    // round-robin, as before: no lines
    expect(planAgentSample(pack, pack.tasks, { suites: new Set(['usage']), agentLimit: 30, seed: 0, allocation: null }).lines).toEqual([]);
  });
});
