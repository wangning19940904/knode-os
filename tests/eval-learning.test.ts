import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { learningReport, writeLearningReport } from '../src/eval/learning/metrics.js';
import { buildLearningStream, learningMeta, learningOrder, STUB_PARAPHRASER, taskMetric, taskSubject, titleSubject, writeLearningPack } from '../src/eval/learning/stream.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { loadPack } from '../src/eval/pack.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { DEFAULT_SYSTEMS, expandSystems, makeSystems } from '../src/eval/systems/index.js';
import { LEARN_LOG, NOTES_LOG, readNotes } from '../src/eval/systems/learning.js';
import type { CorpusDoc, Task } from '../src/eval/types.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * The learning suite (docs/design/38 §4.3): a stream built from a pack's own
 * metadata (no model), asked in a fixed order one question at a time, by the
 * systems that write back and by the notes baseline, scored and reported —
 * end to end on the fixture pack with a stand-in Codex and model.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-learning-'));
const packDir = path.join(tmp, 'pack');
const learnDir = path.join(tmp, 'learning-pack');
const notesLog = path.join(tmp, 'notes.log');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const oldPath = process.env.PATH;

beforeAll(() => {
  buildFixturePack(packDir);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_CODEX_NOTES_LOG = notesLog;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CODEX_NOTES_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const task = (id: string, question: string, extra: Partial<Task> = {}): Task => ({
  id, suite: 'usage', type: 'numeric', question, scoring: 'value', answer: '1', evidence: [], ...extra,
} as Task);

describe('the stream, from what a pack says', () => {
  it('reads subjects from filing titles, teams and opening names, and the attribute from the rest of the question', () => {
    expect(titleSubject('平安银行（000001）2024年第一季度报告')).toBe('平安银行');
    expect(titleSubject('ARVANA INC. annual report (Form 10-K), 2019 file')).toBe('ARVANA INC.');
    const docs = new Map<string, CorpusDoc>([['f/a.md', { path: 'f/a.md', title: 'GENERAL ENTERPRISE VENTURES, INC. annual report (Form 10-K), 2021 file' }]]);
    const t = task('a', 'What is the Basic Earnings Per Share of General Enterprise Ventures, Inc.?', { evidence: [{ doc: 'f/a.md' }] });
    expect(taskSubject(t, docs)).toBe('General Enterprise Ventures, Inc.');
    expect(taskMetric(t, taskSubject(t, docs))).toBe('basic earnings per share');
    const v3 = task('b', '截至2024年5月1日，杭州平台组的订单库连接池上限实际是多少？（以全部材料为准。）');
    expect(taskSubject(v3, new Map())).toBe('杭州平台组');
    expect(taskMetric(v3, '杭州平台组')).toBe('订单库连接池上限');
  });

  it('pairs a cold question with its repeat, its paraphrases, a near question and a far control, and update questions about it', () => {
    const docs: CorpusDoc[] = ['a', 'b', 'c', 'd'].map((x) => ({ path: `f/${x}.md`, title: `${{ a: '甲公司', b: '乙公司', c: '丙公司', d: '丁公司' }[x]}（00000${x}）2024年一季度报告` }));
    const tasks: Task[] = [
      task('t1', '甲公司的营业收入是多少？', { evidence: [{ doc: 'f/a.md' }] }),
      task('t2', '乙公司的营业收入是多少？', { evidence: [{ doc: 'f/b.md' }] }),
      task('t3', '甲公司的净利润是多少？', { evidence: [{ doc: 'f/a.md' }] }),
      task('t4', '丙公司的营业收入是多少？', { evidence: [{ doc: 'f/c.md' }] }),
      task('t5', '丁公司的研发费用是多少？', { evidence: [{ doc: 'f/d.md' }] }),
      task('t1-pp1', '请根据材料回答：甲公司的营业收入为多少？', { type: 'paraphrase', evidence: [{ doc: 'f/a.md' }], meta: { of: 't1', family: 'control-paraphrase' } }),
      task('u1', '甲公司的营业收入更新后是多少？', { suite: 'update', type: 'update', afterUpdate: '01', evidence: [{ doc: 'f/a.md' }] }),
      task('u2', '戊公司的员工人数是多少？', { suite: 'update', type: 'update', afterUpdate: '01', evidence: [{ doc: 'f/e.md' }] }),
    ];
    const s = buildLearningStream({ tasks, docs }, { cold: 1, seed: 0 });
    const byClass = (c: string) => s.tasks.filter((t) => learningMeta(t)!.class === c);
    expect(byClass('cold').map((t) => t.id)).toEqual(['L-cold-t1']);
    expect(byClass('same').map((t) => [t.id, t.question, learningMeta(t)!.of])).toEqual([['L-same-t1', '甲公司的营业收入是多少？', 'L-cold-t1']]);
    expect(byClass('paraphrase').map((t) => t.id)).toEqual(['L-para-t1-pp1']);
    expect(byClass('near-metric').map((t) => learningMeta(t)!.base)).toEqual([expect.stringMatching(/^t[24]$/)]);
    // far shares neither the subject, nor the attribute, nor a document
    expect(byClass('far').map((t) => t.id)).toEqual(['L-far-t5']);
    expect(byClass('update').map((t) => [t.id, t.afterUpdate])).toEqual([['L-upd-u1', '01']]);
    expect(s.tasks.every((t) => t.suite === 'learning')).toBe(true);
    // gold is carried, never altered
    expect(byClass('same')[0].answer).toBe('1');
    expect(s.available).toMatchObject({ pool: 5, paraphrase: 1, update: 2 });
  });

  it('asks every cold question before any warm one, in an order its seed decides', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      ...task(`x${i}`, `q${i}`), suite: 'learning' as const,
      meta: { learning: { phase: i < 6 ? 'cold' : 'warm', class: i < 6 ? 'cold' : 'same', base: `x${i}`, of: null, subject: null, metric: null } },
    }));
    const a = learningOrder(tasks, 'a').before.map((t) => t.id);
    const b = learningOrder(tasks, 'b').before.map((t) => t.id);
    for (const order of [a, b]) expect(order.slice(0, 6).every((id) => Number(id.slice(1)) < 6)).toBe(true);
    expect(a).not.toEqual(b);
    expect(learningOrder(tasks, 'a').before.map((t) => t.id)).toEqual(a);
  });

  it('the learning systems are their own builds, taken only when named', () => {
    const ids = ['knode-ask-learn', 'knode-ask-learn-review', 'agent-knode-learn', 'agent-grep-notes'];
    const systems = makeSystems(ids);
    expect(systems.map((s) => s.group)).toEqual(ids);
    expect(systems.every((s) => s.sequential)).toBe(true);
    for (const id of ids) expect(DEFAULT_SYSTEMS).not.toContain(id);
    expect(expandSystems(['learning'])).toEqual([...ids, 'agent-grep', 'knode-ask']);
  });
});

describe('a learning run on the fixture pack', () => {
  it('builds the stream, asks it in order one at a time, writes back, keeps notes across questions, and reports', async () => {
    const s = writeLearningPack(loadPack(packDir), learnDir, { cold: 30, paraphraser: STUB_PARAPHRASER });
    expect(s.counts.cold).toBeGreaterThan(0);
    expect(s.counts.same).toBe(s.counts.cold);
    expect(s.counts.paraphrase).toBeGreaterThan(0);
    expect(s.counts['near-subject'] + s.counts['near-metric']).toBeGreaterThan(0);
    expect(s.counts.update).toBeGreaterThan(0);
    const pack = loadPack(learnDir);
    expect(pack.manifest.id).toBe('fixture-life-learning');
    expect(pack.tasks.every((t) => t.suite === 'learning')).toBe(true);
    expect(pack.updates).toEqual(loadPack(packDir).updates);

    const systems = ['knode-ask-learn', 'knode-ask-learn-review', 'agent-knode-learn', 'agent-grep-notes', 'agent-grep'];
    const res = await runEval({
      packs: [learnDir], systems, runDir: path.join(tmp, 'runs', 'learn'), quota: false, suites: ['learning'], judgeAudit: 0, learningOrder: 'a',
      overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(res.runDir);
    const answers = store.allAnswers();
    expect(answers.filter((a) => a.error).map((a) => `${a.system} ${a.taskId}: ${a.error}`)).toEqual([]);
    const ids = new Set(pack.tasks.map((t) => t.id));
    for (const sys of systems) {
      const mine = answers.filter((a) => a.system === sys);
      // every question of the stream, the update ones after their batch
      expect(new Set(mine.map((a) => a.taskId)), sys).toEqual(ids);
      for (const a of mine) expect(a.batch, `${sys} ${a.taskId}`).toBe(pack.tasks.find((t) => t.id === a.taskId)!.afterUpdate);
      // cold before warm before update, one at a time: the stream's order, as `learningOrder` gives it
      const expected = [...learningOrder(pack.tasks, 'a').before, ...[...learningOrder(pack.tasks, 'a').byBatch.values()].flat()].map((t) => t.id);
      expect([...mine].sort((x, y) => x.at.localeCompare(y.at)).map((a) => a.taskId), sys).toEqual(expected);
    }

    // the learning builds are their own, and each wrote a log line per answer
    const builds = store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => b.system).sort();
    expect(builds).toEqual(['agent-knode-learn', 'knode-ask-learn', 'knode-ask-learn-review']);
    const log = (group: string, file: string) => fs.readFileSync(path.join(store.workDir('fixture-life-learning', group), file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const auto = log('knode-ask-learn', LEARN_LOG);
    const review = log('knode-ask-learn-review', LEARN_LOG);
    expect(auto.length).toBe(ids.size);
    expect(review.length).toBe(ids.size);
    // nothing takes effect without a person in review mode
    expect(review.some((l) => l.status === 'applied')).toBe(false);
    expect(auto.some((l) => l.status === 'applied')).toBe(true);
    expect(review.some((l) => l.status === 'pending')).toBe(true);
    // arm D's final answers are written back too, and what took effect is in its wiki folder for the next question
    const armD = log('agent-knode-learn', LEARN_LOG);
    expect(armD.length).toBe(ids.size);
    expect(armD.some((l) => l.status === 'applied')).toBe(true);
    // each learning build applied the update batches itself
    expect(store.allBuilds().filter((b) => b.system.includes('@')).map((b) => b.system.split('@')[0]).sort()).toEqual(['agent-knode-learn', 'knode-ask-learn', 'knode-ask-learn-review'].flatMap((g) => pack.updates.filter((u) => u <= [...learningOrder(pack.tasks, 'a').byBatch.keys()].sort().at(-1)!).map(() => g)));

    // the notes: each session found what the ones before it wrote, and nothing else
    const seen = fs.readFileSync(notesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    expect(seen.length).toBe(ids.size);
    seen.forEach((held, i) => expect(held.split('\n').filter(Boolean).length, `session ${i + 1}`).toBe(i));
    expect(seen[0]).toBe('');
    const notes = readNotes(store.workDir('fixture-life-learning', 'agent-grep-notes'));
    expect(notes.split('\n').filter(Boolean).length).toBe(ids.size);
    expect(log('agent-grep-notes', NOTES_LOG).every((l) => l.kept && l.after > l.before)).toBe(true);
    // the notes file is not a corpus document an answer retrieved
    expect(answers.filter((a) => a.system === 'agent-grep-notes').some((a) => a.retrieved.includes('NOTES.md'))).toBe(false);

    // the report: per class, contamination, staleness, write-back cost
    const { report, md } = writeLearningReport(res.runDir, [learnDir]);
    expect(report.order).toBe('a');
    expect(report.systems.map((x) => x.system).sort()).toEqual([...systems].sort());
    for (const x of report.systems) {
      const same = x.classes.find((c) => c.class === 'same')!;
      expect(same.pairs, x.system).toBe(s.counts.same);
      expect(same.tokenRatio, x.system).toBeGreaterThan(0);
      expect(x.update.n).toBe(s.counts.update);
    }
    const ask = report.systems.find((x) => x.system === 'knode-ask-learn')!;
    expect(ask.writeback).toMatchObject({ answers: ids.size });
    expect(ask.writeback!.applied).toBeGreaterThan(0);
    expect(report.systems.find((x) => x.system === 'agent-grep-notes')!.notes).toMatchObject({ answers: ids.size, grew: ids.size });
    expect(report.systems.find((x) => x.system === 'agent-grep')!.writeback).toBeNull();
    expect(fs.readFileSync(md, 'utf8')).toContain('## Warm against cold, by class');
    expect(learningReport(res.runDir, [learnDir]).systems.length).toBe(systems.length);
  }, 300_000);
});
