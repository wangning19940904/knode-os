import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AMORTIZE_AT, breakEvenOf, buildCostOf, buildPerDocOf, buildReportData, efficiencyOf, quantile, renderReport, type ReportData } from '../src/eval/report.js';
import { emptyUsage, type AnswerRecord, type BuildRecord, type ScoreRecord } from '../src/eval/types.js';

/**
 * The report's cost (docs/design/38 §8.1, E7): break-even for every system that
 * answers from a build (each knode agent arm, not only knode-ask), update
 * batches counted in the build, amortized at 100, 1,000 and 10,000 queries,
 * build cost per document, and latency p90 beside p50 — from records old and new.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-cost-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pq = (weightedTokens: number) => ({ latencyP50: 0, toolCalls: 0, weightedTokens, costUsd: 0, n: 30, capped: 0, leaked: 0, errors: 0 });
const build = (system: string, weightedTokens: number, over: Partial<BuildRecord> = {}): BuildRecord => ({
  key: system, pack: 'p', system, ok: true, ms: 1, usage: { ...emptyUsage(), weightedTokens, calls: weightedTokens / 10_000 }, stages: {}, bytes: 0, at: '', ...over,
});

describe('build cost and break-even', () => {
  const perQuery: ReportData['perQuery'] = { p: {
    'agent-grep': pq(20_000),
    'knode-ask': pq(10_000),
    'agent-knode-wiki-sources': pq(15_000),
    'agent-knode-full': pq(25_000),
    'rag-hybrid': pq(5_000),
  } };
  const builds = [build('knode', 1_000_000), build('knode@01', 150_000, { notes: { batch: '01', files: 3 } }), build('knode@02', 50_000, { ok: false }), build('knode@03', 50_000, { notes: { files: 2 } }), build('rag', 30_000)];

  it('counts the update batches that succeeded in the build', () => {
    expect(buildCostOf(builds, 'p', 'knode')).toEqual({ first: 1_000_000, updates: 200_000, total: 1_200_000, calls: 120 });
    expect(buildCostOf(builds, 'p', 'llm-wiki')).toBeNull();
  });

  it('gives break-even for every system that answers from a build, and the usual answerer\'s as before', () => {
    const { breakEven, breakEvenBySystem } = breakEvenOf(perQuery, builds);
    expect(breakEvenBySystem.p.knode).toEqual({ 'knode-ask': 120, 'agent-knode-wiki-sources': 240, 'agent-knode-full': null });
    expect(breakEven.p.knode).toBe(120);
    expect(breakEven.p.rag).toBeCloseTo(2, 9);
    expect(breakEvenBySystem.p.rag).toEqual({ 'rag-hybrid': 2 });
  });

  it('spreads the whole build over 100, 1,000 and 10,000 queries', () => {
    expect([...AMORTIZE_AT]).toEqual([100, 1000, 10000]);
    const usage = { p: { 'agent-knode-wiki-sources': { correctness: { value: 0.6, n: 30 } }, 'agent-grep': { correctness: { value: 0.6, n: 30 } } } };
    const e = efficiencyOf(usage, perQuery, builds).p['agent-knode-wiki-sources'];
    expect(e).toMatchObject({ buildTokens: 1_000_000, updateTokens: 200_000, totalBuildTokens: 1_200_000, breakEven: 240 });
    expect(e.amortized['10000']).toBeCloseTo(0.6 / ((15_000 + 120) / 1000), 9);
  });

  it('gives a build\'s cost per document: the staged documents, or the files an update added', () => {
    const per = buildPerDocOf(builds, { p: { documents: 100 } }).p;
    expect(per.knode).toEqual({ documents: 100, weightedTokens: 10_000, calls: 1 });
    expect(per['knode@01']).toEqual({ documents: 3, weightedTokens: 50_000, calls: 5 });
    // an update with no file count is left out
    expect(per['knode@02']).toBeUndefined();
    expect(buildPerDocOf(builds, undefined).p?.knode).toBeUndefined();
  });

  it('reads p90 by nearest rank', () => {
    expect(quantile([], 0.9)).toBe(0);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([5], 0.9)).toBe(5);
  });
});

describe('a report from records', () => {
  it('renders the new cost columns from records written before them', () => {
    const dir = path.join(tmp, 'run');
    fs.mkdirSync(dir, { recursive: true });
    const answers: AnswerRecord[] = [];
    const scores: ScoreRecord[] = [];
    for (const [system, tokens] of [['agent-grep', 20_000], ['knode-ask', 8_000], ['agent-knode-full', 30_000]] as const) {
      for (let i = 0; i < 10; i++) {
        answers.push({ key: `${system}${i}`, pack: 'p', system, taskId: `t${i}`, at: '', text: '', finalAnswer: '', citations: [], retrieved: [], toolCalls: 1, usage: { ...emptyUsage(), weightedTokens: tokens }, ms: (i + 1) * 1000 });
        scores.push({ key: `s${system}${i}`, pack: 'p', system, suite: 'usage', taskId: `t${i}`, metric: 'correctness', value: i % 2, at: '' });
      }
    }
    // a record as an old run wrote it: no notes; and run.json without `staged`
    const old = build('knode', 1_200_000);
    fs.writeFileSync(path.join(dir, 'answers.jsonl'), answers.map((a) => JSON.stringify(a)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'builds.jsonl'), JSON.stringify(old) + '\n');
    const d = buildReportData(dir);
    expect(d.perQuery.p['knode-ask'].latencyP90).toBe(9000);
    expect(d.breakEven.p.knode).toBe(100);
    expect(d.breakEvenBySystem!.p.knode).toEqual({ 'knode-ask': 100, 'agent-knode-full': null });
    expect(d.buildPerDoc).toEqual({});
    const md = renderReport(d);
    expect(md).toContain('p90 latency');
    expect(md).toContain('with build @ 10000');
    expect(md).toContain('#### Total cost by queries answered');
    expect(md).toContain('agent-knode-full never; knode-ask 100');
    expect(md).toContain('tokens / document');
  });
});
