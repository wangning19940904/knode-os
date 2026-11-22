import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentAllocationFor, headroomAllocation, sharesFor, typeQuotas, type AgentAllocation } from '../src/eval/allocation.js';
import { agentAllocationOption } from '../src/eval/cli.js';
import { loadPack } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { headroomEvidence, renderReport, buildReportData, separabilityOf, typeEvidenceOf } from '../src/eval/report.js';
import { recordAskOptions, runEval, selectTasks } from '../src/eval/run.js';
import { RunStore, type RunMeta } from '../src/eval/runstore.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ScoreRecord, Task } from '../src/eval/types.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * Where a run's agent sessions go: an allocation over task types for the
 * agent sample (weights, counts, or weights derived from a previous run's
 * records), recorded in run.json and kept on a resume; an update cap for
 * agents; and the report's separability section up front.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-allocation-'));
const oldPath = process.env.PATH;
beforeAll(() => {
  // the end-to-end run below asks agent-grep: the suite's fake Codex answers it, never a real session
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
});
afterAll(() => {
  process.env.PATH = oldPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const task = (id: string, type: string, primary = false): Task => ({ id, suite: 'usage', type: type as Task['type'], question: id, scoring: 'judge', evidence: [], ...(primary ? { primary } : {}) });
/** 40 single-hop, 20 aggregate, 10 timeline, 3 global. */
const TASKS = [
  ...Array.from({ length: 40 }, (_, i) => task(`s${i}`, 'single-hop', i < 3)),
  ...Array.from({ length: 20 }, (_, i) => task(`a${i}`, 'aggregate', i === 7)),
  ...Array.from({ length: 10 }, (_, i) => task(`t${i}`, 'timeline')),
  ...Array.from({ length: 3 }, (_, i) => task(`g${i}`, 'global')),
];
const SUITES = new Set(['usage']);
const byType = (ts: Task[]) => ts.reduce<Record<string, number>>((m, t) => ((m[t.type] = (m[t.type] ?? 0) + 1), m), {});

describe('the agent sample without an allocation', () => {
  it('is the round-robin it always was: null or absent shares change nothing', () => {
    const before = selectTasks(TASKS, SUITES, 30, 0);
    expect(selectTasks(TASKS, SUITES, 30, 0, null).map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(selectTasks(TASKS, SUITES, 30, 0, undefined).map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(byType(before)).toEqual({ 'single-hop': 9, aggregate: 9, timeline: 9, global: 3 });
  });
});

describe('typeQuotas', () => {
  const available = new Map([['single-hop', 40], ['aggregate', 20], ['timeline', 10], ['global', 3]]);
  it('gives every type its floor, then shares the rest by weight, whole questions', () => {
    const q = typeQuotas(available, 30, { weights: { aggregate: 3, timeline: 2, global: 1, 'single-hop': 0.1 }, floor: 1 });
    expect([...q.values()].reduce((a, b) => a + b, 0)).toBe(30);
    expect(q.get('single-hop')).toBe(1 + 0);
    expect(q.get('global')).toBe(3);
    expect(q.get('timeline')).toBe(10);
    // what timeline and global could not take goes to aggregate
    expect(q.get('aggregate')).toBe(16);
  });
  it('leaves out a type of weight 0, and counts the unnamed by "*"', () => {
    const q = typeQuotas(available, 20, { weights: { 'single-hop': 0, '*': 1 } });
    expect(q.get('single-hop')).toBe(0);
    expect(q.get('global')).toBe(3);
    expect((q.get('aggregate') ?? 0) + (q.get('timeline') ?? 0)).toBe(17);
  });
  it('with counts takes each count, at most what the type has, whatever the limit', () => {
    const q = typeQuotas(available, 5, { counts: { aggregate: 12, global: 9, '*': 1 } });
    expect(Object.fromEntries(q)).toEqual({ 'single-hop': 1, aggregate: 12, timeline: 1, global: 3 });
  });
  it('with a floor larger than the limit, hands floors out one round at a time', () => {
    const q = typeQuotas(available, 6, { weights: { '*': 1 }, floor: 5 });
    expect(Object.fromEntries(q)).toEqual({ 'single-hop': 2, aggregate: 2, timeline: 1, global: 1 });
  });
  it('stops when every type of a positive weight is used up', () => {
    const q = typeQuotas(new Map([['a', 2], ['b', 1], ['c', 50]]), 30, { weights: { a: 1, b: 1, c: 0 } });
    expect(Object.fromEntries(q)).toEqual({ a: 2, b: 1, c: 0 });
  });
});

describe('selectTasks with shares', () => {
  it('takes each type\'s quota from the front of its seeded list, primaries first, the same for the same seed', () => {
    const shares = { weights: { aggregate: 4, timeline: 2, '*': 0.1 }, floor: 1 };
    const a = selectTasks(TASKS, SUITES, 30, 's', shares);
    expect(a.map((t) => t.id)).toEqual(selectTasks(TASKS, SUITES, 30, 's', shares).map((t) => t.id));
    expect(a.map((t) => t.id)).not.toEqual(selectTasks(TASKS, SUITES, 30, 'other', shares).map((t) => t.id));
    expect(byType(a)).toEqual({ 'single-hop': 1, aggregate: 19, timeline: 9, global: 1 });
    // the primaries of a type come first: single-hop's one question is a primary, aggregate's seventh is among its 19
    expect(a.find((t) => t.type === 'single-hop')!.primary).toBe(true);
    expect(a.some((t) => t.id === 'a7')).toBe(true);
    // a round-robin order over types, as without shares
    expect(new Set(a.slice(0, 4).map((t) => t.type)).size).toBe(4);
  });
  it('with counts, and below the limit, takes only the counted types', () => {
    expect(byType(selectTasks(TASKS, SUITES, 100, 0, { counts: { timeline: 2 } }))).toEqual({ timeline: 2 });
  });
});

/** Correctness per system, pack and task, as the report keys it. */
function correctness(rows: [string, string, string, number][]): Map<string, number> {
  return new Map(rows.map(([sys, pack, task, v]) => [`${sys}\u0000${pack}\u0000${task}`, v]));
}
const AGENTS = ['agent-grep', 'agent-rag', 'agent-knode-full'];
/** Pack p: single-hop all right (10), timeline differing on 4 of 6; pack q: everything all right. */
function campaignLike(): { c: Map<string, number>; typeOf: Map<string, string> } {
  const rows: [string, string, string, number][] = [];
  const typeOf = new Map<string, string>();
  for (let i = 0; i < 10; i++) {
    for (const a of AGENTS) rows.push([a, 'p', `s${i}`, 1], [a, 'q', `s${i}`, 1]);
    typeOf.set(`p\u0000s${i}`, 'single-hop').set(`q\u0000s${i}`, 'single-hop');
  }
  for (let i = 0; i < 6; i++) {
    AGENTS.forEach((a, j) => rows.push([a, 'p', `t${i}`, i < 4 ? (j === 2 ? 1 : 0.5 * (i % 2)) : 0]));
    typeOf.set(`p\u0000t${i}`, 'timeline');
  }
  // a fourth system that is not an agent arm is not counted
  rows.push(['knode-ask', 'p', 's0', 0]);
  return { c: correctness(rows), typeOf };
}

describe('headroom from a previous run', () => {
  it('counts, per pack and type, the questions on which the arms differed', () => {
    const { c, typeOf } = campaignLike();
    const ev = typeEvidenceOf(c, typeOf);
    expect(ev.p['single-hop']).toEqual({ n: 10, differ: 0, spread: 0, allRight: 10, noneRight: 0 });
    expect(ev.p.timeline).toEqual({ n: 6, differ: 4, spread: 3, allRight: 0, noneRight: 2 });
    expect(ev.q).toEqual({ 'single-hop': { n: 10, differ: 0, spread: 0, allRight: 10, noneRight: 0 } });
  });
  it('weights each type by the mean spread of the arms\' scores, shrunk toward the pooled mean, and keeps ceiling types to the floor', () => {
    const { c, typeOf } = campaignLike();
    const alloc = headroomAllocation(typeEvidenceOf(c, typeOf), { from: ['x'] });
    expect(alloc.mode).toBe('headroom');
    expect(alloc.floor).toBe(1);
    // timeline's spreads 1, ½, 1, ½, 0, 0: pooled (3 + ½) / (6 + 1); single-hop pooled: ½ / 21
    expect(alloc.byPack!['*'].timeline).toBeCloseTo(0.5, 5);
    expect(alloc.byPack!['*']['single-hop']).toBeCloseTo(0.5 / 21, 5);
    expect(alloc.byPack!.p.timeline).toBeCloseTo((3 + 5 * 0.5) / (6 + 5), 5);
    // q never saw timeline: it gets the pooled mean
    expect(alloc.byPack!.q.timeline).toBeCloseTo(0.5, 5);
    // evidence without spreads (recorded before them) counts each differing question as a full spread
    const old = headroomAllocation({ p: { timeline: { n: 6, differ: 4, allRight: 0, noneRight: 2 } as never } });
    expect(old.byPack!.p.timeline).toBeCloseTo((4 + 5 * (4.5 / 7)) / 11, 5);
    const shares = sharesFor(alloc, 'q');
    const picked = selectTasks(TASKS, SUITES, 30, 0, shares);
    expect(byType(picked)['single-hop']).toBeLessThanOrEqual(2);
    expect(byType(picked).timeline).toBe(10);
    // a pack the records do not have takes the pooled weights
    expect(sharesFor(alloc, 'new-pack').weights).toEqual(alloc.byPack!['*']);
  });
  it('reads scores.jsonl, report.json and campaign.json', () => {
    const dir = path.join(tmp, 'records');
    const run = path.join(dir, 'run-p');
    fs.mkdirSync(run, { recursive: true });
    const { c, typeOf } = campaignLike();
    const scores: ScoreRecord[] = [...c].map(([k, value], i) => {
      const [system, pack, taskId] = k.split('\u0000');
      return { key: `k${i}`, pack, system, suite: 'usage', taskId, taskType: typeOf.get(`${pack}\u0000${taskId}`) as ScoreRecord['taskType'], metric: 'correctness', value, at: '' };
    });
    // a latency record and a superseded score (same key, later line wins) are not counted twice
    scores.push({ ...scores[0], metric: 'latency_ms', key: 'lat', value: 5 }, { ...scores.find((s) => s.taskId === 't0' && s.system === 'agent-grep')!, value: 1 });
    fs.writeFileSync(path.join(run, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const ev = headroomEvidence([run]);
    // t0 now 1 for grep: still differs from rag's 0; the rest as before
    expect(ev.p.timeline).toEqual({ n: 6, differ: 4, spread: 3, allRight: 0, noneRight: 2 });
    expect(ev.p['single-hop'].n).toBe(10);
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(report, JSON.stringify({ packs: ['r'], discrimination: { systems: AGENTS, overall: { n: 3, allRight: 1, noneRight: 1, rest: 1 }, byType: { global: { n: 3, allRight: 1, noneRight: 1, rest: 1 } } } }));
    expect(headroomEvidence([report]).r.global).toEqual({ n: 3, differ: 1, spread: 1, allRight: 1, noneRight: 1 });
    const campaign = path.join(dir, 'campaign.json');
    fs.writeFileSync(campaign, JSON.stringify({ entries: [{ runDir: run }, { runDir: path.join(dir, 'not-there') }] }));
    expect(headroomEvidence([campaign])).toEqual(ev);
    expect(() => headroomEvidence([path.join(dir, 'missing')])).toThrow(/does not exist/);
    // a run of one pack is known by its directory's name: two versions of a pack share a manifest id
    const v2 = path.join(dir, 'run-v2');
    fs.mkdirSync(v2);
    fs.writeFileSync(path.join(v2, 'scores.jsonl'), scores.filter((x) => x.pack === 'p').map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(v2, 'run.json'), JSON.stringify({ packs: ['p-v2'] }));
    const both = headroomEvidence([run, v2]);
    expect(Object.keys(both).sort()).toEqual(['p', 'p-v2', 'q']);
    const alloc = headroomAllocation(both);
    expect(sharesFor(alloc, 'p-v2', 'p').weights).toBe(alloc.byPack!['p-v2']);
    expect(sharesFor(alloc, 'p-v3', 'p').weights).toBe(alloc.byPack!.p);
    expect(sharesFor(alloc, 'other', 'other-id').weights).toBe(alloc.byPack!['*']);
  });
});

describe('the command line', () => {
  it('parses weights, counts and headroom, one at a time', () => {
    expect(agentAllocationOption({})).toBeUndefined();
    expect(agentAllocationOption({ agentWeights: 'aggregate=4, timeline=2.5,*=0.5', agentFloor: '2' })).toEqual({ mode: 'weights', weights: { aggregate: 4, timeline: 2.5, '*': 0.5 }, floor: 2 });
    expect(agentAllocationOption({ agentCounts: 'aggregate=12,*=1' })).toEqual({ mode: 'counts', counts: { aggregate: 12, '*': 1 } });
    expect(() => agentAllocationOption({ agentCounts: 'aggregate=1.5' })).toThrow(/whole number/);
    expect(() => agentAllocationOption({ agentWeights: 'nonsense=1' })).toThrow(/unknown task type/);
    expect(() => agentAllocationOption({ agentWeights: 'aggregate' })).toThrow(/type=number/);
    expect(() => agentAllocationOption({ agentWeights: 'aggregate=1', agentCounts: 'aggregate=1' })).toThrow(/give one allocation/);
    expect(() => agentAllocationOption({ agentCounts: 'aggregate=1', agentFloor: '1' })).toThrow(/--agent-floor/);
    const h = agentAllocationOption({ agentHeadroomFrom: path.join(tmp, 'records', 'run-p') })!;
    expect(h.mode).toBe('headroom');
    expect(h.from).toEqual([path.join(tmp, 'records', 'run-p')]);
    expect(Object.keys(h.byPack!).sort()).toEqual(['*', 'p', 'q']);
  });
});

describe('a resume', () => {
  const meta = (allocation?: AgentAllocation | null) => ({ id: 'r1', ...(allocation !== undefined ? { agentSample: { limit: 30, updateLimit: null, allocation, byPack: {}, updates: {} } } : {}) }) as unknown as RunMeta;
  const w: AgentAllocation = { mode: 'weights', weights: { aggregate: 2 } };
  it('keeps the allocation the run recorded, and refuses another', () => {
    expect(agentAllocationFor(w, null)).toBe(w);
    expect(agentAllocationFor(undefined, null)).toBeNull();
    expect(agentAllocationFor(undefined, meta(w))).toEqual(w);
    expect(agentAllocationFor({ ...w }, meta(w))).toEqual(w);
    expect(() => agentAllocationFor({ mode: 'weights', weights: { aggregate: 3 } }, meta(w))).toThrow(/sampled its agent questions by weights aggregate=2/);
    // a run from before allocations, or one that sampled round-robin, stays round-robin
    expect(agentAllocationFor(undefined, meta())).toBeNull();
    expect(() => agentAllocationFor(w, meta())).toThrow(/round-robin/);
    expect(() => agentAllocationFor(w, meta(null))).toThrow(/round-robin/);
  });
  it('of a headroom run uses the weights it recorded, not the records as they are now', () => {
    const recorded = { ...headroomAllocation({ p: { timeline: { n: 6, differ: 4, spread: 3, allRight: 0, noneRight: 2 } } }, { from: ['/x'] }) };
    const now = headroomAllocation({ p: { timeline: { n: 60, differ: 4, spread: 3, allRight: 50, noneRight: 6 } } }, { from: ['/x'] });
    expect(agentAllocationFor(now, meta(recorded))).toBe(recorded);
  });
});

describe('separability in the report', () => {
  it('per pack: the share on which the arms differ, the MDE, and a verdict where none differ', () => {
    const { c } = campaignLike();
    const s = separabilityOf(c)!;
    const [p, q] = s.packs;
    expect(p).toMatchObject({ pack: 'p', n: 16, differ: 4, allRight: 10, noneRight: 2, verdict: null });
    expect(p.agents).toEqual([...AGENTS].sort());
    expect(p.mde!.min).toBeGreaterThan(0);
    expect(p.mde!.min).toBeLessThanOrEqual(p.mde!.median);
    expect(q).toMatchObject({ pack: 'q', n: 10, differ: 0, mde: null });
    expect(q.verdict).toMatch(/^cannot separate the arms: every arm got the same score on all 10 agent question\(s\) \(10 fully right for every arm\)$/);
    expect(s.overall).toMatchObject({ pack: '', n: 26, differ: 4, verdict: null });
    // one agent arm alone: nothing to separate
    expect(separabilityOf(correctness([['agent-grep', 'p', 't', 1]]))).toBeNull();
  });
});

describe('askOptions in run.json', () => {
  it('are recorded for a variant of knode-ask asked without knode-ask itself', () => {
    const meta = {} as RunMeta;
    recordAskOptions(meta, ['knode-ask-hops'], { KNODE_EVAL_ASK_NOW: '2025-11-07' });
    expect(meta.askOptions).toEqual({ now: '2025-11-07' });
    recordAskOptions(meta, ['knode-asked', 'rag-hybrid'], {});
    expect(meta.askOptions).toBeUndefined();
  });
});

describe('the rendered report', () => {
  it('opens with whether each pack can separate the agents, and how the sample was drawn', () => {
    const dir = path.join(tmp, 'report-run');
    const store = new RunStore(dir);
    const { c, typeOf } = campaignLike();
    const scores: ScoreRecord[] = [...c].map(([k, value], i) => {
      const [system, pack, taskId] = k.split('\u0000');
      return { key: `k${i}`, pack, system, suite: 'usage', taskId, taskType: typeOf.get(`${pack}\u0000${taskId}`) as ScoreRecord['taskType'], metric: 'correctness', value, at: '' };
    });
    fs.writeFileSync(path.join(dir, 'scores.jsonl'), scores.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const allocation = headroomAllocation(typeEvidenceOf(c, typeOf), { from: ['/runs/before'] });
    store.writeMeta({
      id: 'report-run', createdAt: '', gitSha: null, knodeVersion: '0', packs: ['p', 'q'], systems: AGENTS, suites: ['usage'],
      model: { connection: 'x', label: 'x', buildEffort: 'low', answerEffort: 'medium' }, judge: { connection: 'x', label: 'x' }, embedding: 'x', fraction: 1, seed: 0, limit: null, versions: {},
      agentSample: { limit: 30, updateLimit: 5, allocation, byPack: { p: { timeline: { available: 6, taken: 6, weight: 0.6 }, 'single-hop': { available: 10, taken: 1, weight: 0.02 } } }, updates: { p: { available: 20, taken: 5 } } },
    });
    const data = buildReportData(dir);
    expect(data.separability!.packs.map((p) => p.pack)).toEqual(['p', 'q']);
    const md = renderReport(data);
    const at = (h: string) => md.indexOf(h);
    expect(at('## Can this run separate the agents?')).toBeGreaterThan(0);
    expect(at('## Can this run separate the agents?')).toBeLessThan(at('## Which questions tell the agents apart'));
    expect(md).toContain('**1 of 2 pack(s) cannot separate the agent arms at all**: q.');
    expect(md).toMatch(/\| p \| 16 \| 4 \(25%\) \| 10 \(63%\) \| 2 \(13%\) \| 0\.\d{3}/);
    expect(md).toMatch(/\| q \| 10 \| 0 \(0%\) \| 10 \(100%\) \| 0 \(0%\) \| — \| cannot separate the arms/);
    expect(md).toContain('Agent sample: 30 a pack by headroom from /runs/before, floor 1; at most 5 update tasks a pack.');
    expect(md).toContain('| p | timeline 6/6 (0.6), single-hop 1/10 (0.02) | 5/20 |');
  });
});

describe('a run with an allocation, end to end (fake Codex)', () => {
  const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
  const packDir = path.join(tmp, 'pack');
  const runDir = path.join(tmp, 'runs', 'counts');
  const common = { packs: [packDir], systems: ['agent-grep'], runDir, quota: false, suites: ['usage' as const, 'update' as const], judgeAudit: 0, workspacesIn: 'run' as const, overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder } };

  it('answers the counted types and the capped update tasks, records them, and keeps them on a resume', async () => {
    buildFixturePack(packDir);
    const allocation: AgentAllocation = { mode: 'counts', counts: { aggregate: 2, timeline: 1 } };
    await runEval({ ...common, agentLimit: 4, agentAllocation: allocation, agentUpdateLimit: 1 });
    const store = new RunStore(runDir);
    const answered = store.allAnswers().filter((a) => a.system === 'agent-grep');
    const loaded = loadPack(packDir);
    const pack = loaded.manifest.id;
    const tasks = new Map(loaded.tasks.map((t) => [t.id, t]));
    expect(byType(answered.filter((a) => !a.batch).map((a) => tasks.get(a.taskId)!))).toEqual({ aggregate: 2, timeline: 1 });
    expect(answered.filter((a) => a.batch)).toHaveLength(1);
    const sample = store.meta()!.agentSample!;
    expect(sample).toMatchObject({ limit: 4, updateLimit: 1, allocation });
    expect(sample.byPack[pack].aggregate).toEqual({ available: 2, taken: 2, weight: 2 });
    expect(sample.byPack[pack]['single-hop']).toEqual({ available: 1, taken: 0, weight: 0 });
    expect(sample.updates[pack]).toEqual({ available: 3, taken: 1 });

    // the report opens with whether the run could separate the agents (one arm: it says nothing) and shows the sample
    const md = renderReport(buildReportData(runDir));
    expect(md).not.toMatch(/Can this run separate the agents/);

    // a resume without the options asks nothing new; with another allocation it is refused
    const n = store.allAnswers().length;
    await runEval({ ...common, agentLimit: 4 });
    expect(new RunStore(runDir).allAnswers()).toHaveLength(n);
    await expect(runEval({ ...common, agentLimit: 4, agentAllocation: { mode: 'counts', counts: { aggregate: 1 } } })).rejects.toThrow(/sampled its agent questions by counts aggregate=2,timeline=1/);
    await expect(runEval({ ...common, agentLimit: 4, agentUpdateLimit: 2 })).rejects.toThrow(/at most 1 update tasks a pack/);
  }, 120_000);
});
