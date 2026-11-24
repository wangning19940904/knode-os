import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { modelFromClaudeResult, sanitizeUsage, usageFromClaudeResult } from '../src/llm/usage.js';
import { readDecoys } from '../src/eval/decoys.js';
import { Judge } from '../src/eval/judge.js';
import { judgeChangeOf, JudgeChangedError, recordJudgeChange, ServedJudgeGuard, servedName } from '../src/eval/judge-identity.js';
import { Meter } from '../src/eval/meter.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { buildReportData, renderReport } from '../src/eval/report.js';
import { runEval } from '../src/eval/run.js';
import { RunStore, type RunMeta } from '../src/eval/runstore.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * One judge a run (docs/design/38 E3): a resume that would score with another
 * judge — on the command line, or a model a routing layer put under it, as the
 * reply's `modelUsage` shows — refuses unless allowed, and an allowed change is
 * recorded in run.json and the report.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-consistency-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const meta = (judge: RunMeta['judge']): RunMeta => ({ id: 'r', judge } as RunMeta);

/** The scripted judge, under another label and naming the model that answered in its usage. */
function namedJudge(label: string, served: () => string | null): LlmClient & { calls: number } {
  const base = scriptedJudge();
  const j = Object.create(base) as LlmClient & { calls: number };
  Object.defineProperty(j, 'label', { value: label });
  j.completeJson = (async (messages: Parameters<LlmClient['completeJson']>[0], opts: { onUsage?: (u: unknown) => void } = {}) => base.completeJson(messages, {
    ...opts, onUsage: (u: unknown) => opts.onUsage?.({ ...(u as object), ...(served() ? { model: served() } : {}) }),
  })) as LlmClient['completeJson'];
  return j;
}

describe('the model a reply names', () => {
  it('is read from Claude Code\'s modelUsage, the one that wrote most, and survives a worker\'s report', () => {
    const wrapper = { result: 'x', usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { 'claude-haiku-5-5': { outputTokens: 2 }, 'wangning/claude-sonnet-5-5': { outputTokens: 50 } } };
    expect(modelFromClaudeResult(wrapper)).toBe('wangning/claude-sonnet-5-5');
    expect(usageFromClaudeResult(wrapper)!.model).toBe('wangning/claude-sonnet-5-5');
    expect(usageFromClaudeResult({ result: 'x', usage: { input_tokens: 10, output_tokens: 5 } })!.model).toBeUndefined();
    expect(sanitizeUsage({ inputTokens: 10, outputTokens: 5, model: ' wangning/claude-sonnet-5-5 ' })!.model).toBe('wangning/claude-sonnet-5-5');
    expect(servedName('wangning/claude-sonnet-5-5[1m]')).toBe('wangning/claude-sonnet-5-5');
  });
});

describe('the resume check', () => {
  const now = { connection: 'claude-cli', label: 'claude-cli:b' };

  it('passes the same judge and a new run, refuses another unless allowed', () => {
    expect(judgeChangeOf(null, now, false, 'run')).toBeNull();
    expect(judgeChangeOf(meta({ connection: 'claude-cli', label: 'claude-cli:b' }), now, false, 'run')).toBeNull();
    expect(() => judgeChangeOf(meta({ connection: 'claude-cli', label: 'claude-cli:a' }), now, false, 'run')).toThrow(JudgeChangedError);
    const change = judgeChangeOf(meta({ connection: 'claude-cli', label: 'claude-cli:a', served: 'a' }), now, true, 'score')!;
    expect(change).toMatchObject({ kind: 'configured', from: 'claude-cli (claude-cli:a)', to: 'claude-cli (claude-cli:b)', by: 'score' });
    const m = meta({ connection: 'claude-cli', label: 'claude-cli:a', served: 'a' });
    recordJudgeChange(m, now, change);
    expect(m.judge).toEqual(now);
    expect(m.judgeChanges).toHaveLength(1);
  });

  it('records the first model served, refuses another unless allowed, and counts replies naming none', () => {
    const m = meta({ connection: 'c', label: 'l' });
    let saved = 0;
    const strict = new ServedJudgeGuard(m, false, 'run', () => saved++);
    strict.served('wangning/claude-sonnet-5-5[1m]');
    strict.served('wangning/claude-sonnet-5-5');
    strict.served(null);
    expect(m.judge).toMatchObject({ served: 'wangning/claude-sonnet-5-5', unnamed: 1 });
    expect(saved).toBe(1);
    expect(() => strict.served('expiring-soon/claude-sonnet-5-5')).toThrow(/answered by wangning\/claude-sonnet-5-5, and this one by expiring-soon/);
    const allowing = new ServedJudgeGuard(m, true, 'run', () => saved++);
    allowing.served('expiring-soon/claude-sonnet-5-5');
    expect(m.judge.served).toBe('expiring-soon/claude-sonnet-5-5');
    expect(m.judgeChanges).toEqual([expect.objectContaining({ kind: 'served', from: 'wangning/claude-sonnet-5-5', to: 'expiring-soon/claude-sonnet-5-5' })]);
  });

  it('refuses a reply from another model before its verdict is cached', async () => {
    let model = 'model-a';
    const cacheFile = path.join(tmp, 'judge-cache.jsonl');
    const m = meta({ connection: 'c', label: 'l' });
    const judge = new Judge({ client: namedJudge('l', () => model), meter: new Meter(), cacheFile, served: (x) => new ServedJudgeGuard(m, false, 'run', () => {}).served(x) });
    await judge.gradeAnswers([{ id: 'a', question: 'q', reference: 'r', answer: 'x' }]);
    expect(m.judge.served).toBe('model-a');
    const before = fs.readFileSync(cacheFile, 'utf8');
    model = 'model-b';
    await expect(judge.gradeAnswers([{ id: 'b', question: 'q2', reference: 'r', answer: 'y' }])).rejects.toThrow(JudgeChangedError);
    expect(fs.readFileSync(cacheFile, 'utf8')).toBe(before);
  });
});

describe('a resumed run', () => {
  it('refuses another judge, goes on when allowed, and the report lists the change', async () => {
    const packDir = path.join(tmp, 'pack');
    buildFixturePack(packDir);
    const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
    const runDir = path.join(tmp, 'run');
    let served = 'model-a';
    const base = { packs: [packDir], systems: ['closed-book'], runDir, quota: false, suites: ['usage' as const], judgeAudit: 0 };
    await runEval({ ...base, judgeDecoys: 2, overrides: { chat: new ScriptedBackend(), judge: namedJudge('judge-a', () => served), embedder } });
    const store = () => new RunStore(runDir);
    expect(store().meta()!.judge).toMatchObject({ label: 'judge-a', served: 'model-a' });
    // the decoys went to the judge with the answers, and none was scored
    const decoys = readDecoys(runDir);
    expect(decoys.length).toBeGreaterThan(0);
    expect(decoys.length).toBeLessThanOrEqual(2);
    expect(store().allScores().some((s) => decoys.some((d) => d.key === s.key))).toBe(false);

    // another judge on the command line
    await expect(runEval({ ...base, overrides: { chat: new ScriptedBackend(), judge: namedJudge('judge-b', () => served), embedder } })).rejects.toThrow(/was judged by .*judge-a.*--allow-judge-change/);
    // answering only: the judge is not used, so nothing to refuse
    await runEval({ ...base, skipScoring: true, overrides: { chat: new ScriptedBackend(), judge: namedJudge('judge-b', () => served), embedder } });
    expect(store().meta()!.judge.label).toBe('judge-a');

    // the same judge, another model under it: scored again from scratch, so the judge is asked
    fs.rmSync(path.join(runDir, 'scores.jsonl'));
    fs.rmSync(path.join(runDir, 'cache', 'judge.jsonl'), { force: true });
    served = 'model-b';
    await expect(runEval({ ...base, overrides: { chat: new ScriptedBackend(), judge: namedJudge('judge-a', () => served), embedder } })).rejects.toThrow(/answered by model-a, and this one by model-b/);
    expect(fs.existsSync(path.join(runDir, 'scores.jsonl')) ? store().allScores().length : 0).toBe(0);
    await runEval({ ...base, allowJudgeChange: true, overrides: { chat: new ScriptedBackend(), judge: namedJudge('judge-a', () => served), embedder } });
    expect(store().meta()!.judge.served).toBe('model-b');
    expect(store().allScores().length).toBeGreaterThan(0);
    expect(renderReport(buildReportData(runDir))).toContain('judge: judge-a, answering as model-b');

    // and another judge, allowed
    await runEval({ ...base, allowJudgeChange: true, overrides: { chat: new ScriptedBackend(), judge: namedJudge('judge-b', () => served), embedder } });
    const m = store().meta()!;
    expect(m.judge.label).toBe('judge-b');
    expect(m.judgeChanges!.map((c) => c.kind)).toEqual(['served', 'configured']);
    const md = renderReport(buildReportData(runDir));
    expect(md).toContain('## Judge changes (2)');
    // a new judge's model is read afresh from its replies
    expect(m.judge.served).toBeUndefined();
    expect(md).toContain('## Judge decoys');
  }, 180_000);
});
