import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/llm/client.js';
import { auditSample, Judge } from '../src/eval/judge.js';
import { Meter } from '../src/eval/meter.js';
import { buildReportData, renderReport } from '../src/eval/report.js';
import { judgeAuditFor } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { scoreUsage } from '../src/eval/score/usage.js';
import { emptyUsage, type AnswerRecord, type Task } from '../src/eval/types.js';

/* The judge audit (docs/design/33 §5): a seeded share of verdicts judged a second time, in a call of its own. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-audit-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A judge whose verdict depends on whether the call is the audit's (ids ending ~audit); every call's ids are kept. */
function twoMindedJudge(first: (id: string) => object, second: (id: string) => object): LlmClient & { calls: string[][] } {
  const client = {
    calls: [] as string[][],
    label: 'scripted-judge', model: 'scripted-judge', enabled: true,
    async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
      const items = (JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { id: string }[] }).items;
      client.calls.push(items.map((i) => i.id));
      return { verdicts: items.map((i) => ({ id: i.id, ...(i.id.endsWith('~audit') ? second(i.id) : first(i.id)) })) } as T;
    },
  };
  return client as unknown as LlmClient & { calls: string[][] };
}

describe('judge audit', () => {
  it('samples a seeded share, at least the minimum, the same items whatever else the pass holds', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `item-${i}`);
    const picked = auditSample(ids, 0.05, 20, 'seed', (x) => x);
    expect(picked.length).toBeGreaterThan(70);
    expect(picked.length).toBeLessThan(130);
    // an item under the share is picked in any pass that holds it
    const half = ids.slice(0, 1000);
    const pickedHalf = new Set(auditSample(half, 0.05, 0, 'seed', (x) => x));
    expect(picked.filter((x) => half.includes(x)).every((x) => pickedHalf.has(x))).toBe(true);
    // a small pass: the minimum, or everything when there are fewer
    expect(auditSample(ids.slice(0, 100), 0.05, 20, 'seed', (x) => x)).toHaveLength(20);
    expect(auditSample(ids.slice(0, 7), 0.05, 20, 'seed', (x) => x)).toHaveLength(7);
    expect(auditSample(ids, 0, 20, 'seed', (x) => x)).toEqual([]);
    // another seed, another sample
    expect(auditSample(ids, 0.05, 20, 'other', (x) => x)).not.toEqual(picked);
  });

  it('lists a correct answer the first verdict scored 0 (h5r-C0, agent-grep, 10× run)', async () => {
    const dir = path.join(tmp, 'h5r');
    const store = new RunStore(dir);
    const task: Task = {
      id: 'h5r-C0', suite: 'usage', type: 'deep-hop', scoring: 'judge', evidence: [], keypoints: ['方杰'],
      question: '（第一事业部）提出风险R-07的人修复过一起由客户升级的事故。同一个客户还在另一个组升级过事故——那一起是谁修复的？',
      answer: '方杰（平台组，INC-001-T1）',
    };
    const answer: AnswerRecord = {
      key: 'a1', pack: 'p', system: 'agent-grep', taskId: 'h5r-C0', at: new Date().toISOString(), citations: [], retrieved: [], toolCalls: 3, usage: emptyUsage(), ms: 10, finalAnswer: '方杰。',
      text: '那一起由**方杰**修复。\n\n- 风险 R-07 的提出人是陈伟。\n- 陈伟修复了支付组事故 INC-010-T2，该事故由客户华鼎零售升级。\n- 华鼎零售还在平台组投诉升级了事故 INC-001-T1，次周记录显示该事故由方杰修复。\n\nFinal answer: 方杰。',
    };
    store.putAnswer(answer);
    const client = twoMindedJudge(
      () => ({ score: 0, keypoints: [], abstained: false, hallucinated: true, reason: 'Gave 方杰 but wrong chain, answer text contradicts itself' }),
      () => ({ score: 2, keypoints: [0], abstained: false, hallucinated: false, reason: 'Names 方杰, the reference fixer' }),
    );
    const cacheFile = path.join(dir, 'cache', 'judge.jsonl');
    const judge = new Judge({ client, meter: new Meter(), cacheFile }).audit(judgeAuditFor(undefined, 0, store));
    const tasks = new Map([['p|h5r-C0', task]]);
    const scores = await scoreUsage({ answers: [answer], tasks, citing: new Set() }, judge);
    for (const s of scores) store.putScore(s);
    // the score is the first verdict's; the audit asked once more, in a call of its own, under an id of its own
    expect(scores.find((s) => s.metric === 'correctness')?.value).toBe(0);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1][0]).toBe(`${client.calls[0][0]}~audit`);
    const [rec] = store.allJudgeAudits();
    expect(rec).toMatchObject({ kind: 'grade', agree: false, first: { score: 0 }, second: { score: 2 } });

    // the report lists the item, both verdicts and both reasons
    const data = buildReportData(dir);
    expect(data.judgeAudit?.byKind.grade).toEqual({ n: 1, agree: 0 });
    expect(data.judgeAudit?.disagreements[0]).toMatchObject({
      kind: 'grade', system: 'agent-grep', taskId: 'h5r-C0', reasons: ['Gave 方杰 but wrong chain, answer text contradicts itself', 'Names 方杰, the reference fixer'],
    });
    const md = renderReport(data);
    expect(md).toContain('## Judge audit');
    expect(md).toMatch(/grade \| agent-grep \| h5r-C0 \| （第一事业部）提出风险R-07.*\| score 0, hallucinated \| Gave 方杰 but wrong chain.*\| score 2 \| Names 方杰/);

    // a rerun replays both from the cache, each under its own key: the second verdict is the audit's, not the first replayed
    const again = twoMindedJudge(() => ({ score: 1 }), () => ({ score: 1 }));
    const store2 = new RunStore(path.join(tmp, 'h5r-replay'));
    const replay = new Judge({ client: again, meter: new Meter(), cacheFile }).audit(judgeAuditFor(0.05, 0, store2));
    await scoreUsage({ answers: [answer], tasks, citing: new Set() }, replay);
    expect(again.calls).toHaveLength(0);
    expect(store2.allJudgeAudits()[0]).toMatchObject({ first: { score: 0 }, second: { score: 2 }, agree: false });
  });

  it('asks the sample in another order, agrees where the verdicts do, and is off at 0', async () => {
    const store = new RunStore(path.join(tmp, 'order'));
    const tasks = new Map<string, Task>();
    const answers: AnswerRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `t${i}`;
      tasks.set(`p|${id}`, { id, suite: 'usage', type: 'fact', scoring: 'judge', evidence: [], question: `q${i}?`, answer: `a${i}` });
      answers.push({ key: id, pack: 'p', system: 's', taskId: id, at: '', text: `Final answer: a${i}`, finalAnswer: `a${i}`, citations: [], retrieved: [], toolCalls: 0, usage: emptyUsage(), ms: 1 });
    }
    const client = twoMindedJudge(() => ({ score: 2, keypoints: [], abstained: false, hallucinated: false }), () => ({ score: 2, keypoints: [], abstained: false, hallucinated: false }));
    const judge = new Judge({ client, meter: new Meter(), batchSize: 100 }).audit(judgeAuditFor(0.05, 'seed', store));
    await scoreUsage({ answers, tasks, citing: new Set() }, judge);
    expect(client.calls).toHaveLength(2);
    const firstOrder = client.calls[0].filter((id) => client.calls[1].includes(`${id}~audit`));
    const secondOrder = client.calls[1].map((id) => id.replace(/~audit$/, ''));
    expect(secondOrder).toHaveLength(20);
    expect(new Set(secondOrder)).toEqual(new Set(firstOrder));
    expect(secondOrder).not.toEqual(firstOrder);
    expect(store.allJudgeAudits().every((r) => r.agree)).toBe(true);

    const off = twoMindedJudge(() => ({ score: 2 }), () => ({ score: 0 }));
    const offStore = new RunStore(path.join(tmp, 'off'));
    await scoreUsage({ answers, tasks, citing: new Set() }, new Judge({ client: off, meter: new Meter(), batchSize: 100 }).audit(judgeAuditFor(0, 'seed', offStore)));
    expect(off.calls).toHaveLength(1);
    expect(offStore.allJudgeAudits()).toEqual([]);
    expect(() => judgeAuditFor(2, 'seed', offStore)).toThrow(/between 0 and 1/);
  });
  it('audits the key points of a key-points grade, every such answer, under a kind of its own', async () => {
    const dir = path.join(tmp, 'keypoints');
    const store = new RunStore(dir);
    const tasks = new Map<string, Task>();
    const answers: AnswerRecord[] = [];
    // one global question scored by its key points, and thirty plain judged ones around it
    tasks.set('p|g1', { id: 'g1', suite: 'usage', type: 'global', scoring: 'keypoints', evidence: [], keypoints: ['a', 'b', 'c', 'd'], question: 'What changed?', answer: 'a; b; c; d' });
    for (let n = 0; n < 30; n++) tasks.set(`p|j${n}`, { id: `j${n}`, suite: 'usage', type: 'single-hop', scoring: 'judge', evidence: [], question: `Q${n}?`, answer: `A${n}` });
    for (const t of tasks.values()) answers.push({ key: `a-${t.id}`, pack: 'p', system: 'agent-grep', taskId: t.id, at: new Date().toISOString(), citations: [], retrieved: [], toolCalls: 0, usage: emptyUsage(), ms: 1, text: `answer to ${t.id}`, finalAnswer: 'x' });
    // the two passes agree on every grade, and name different key points for the global answer
    const client = twoMindedJudge(
      () => ({ score: 1, keypoints: [0, 1], abstained: false, hallucinated: false, reason: 'first' }),
      () => ({ score: 1, keypoints: [0, 2, 3], abstained: false, hallucinated: false, reason: 'second' }),
    );
    const judge = new Judge({ client, meter: new Meter(), cacheFile: path.join(dir, 'cache', 'judge.jsonl') }).audit(judgeAuditFor(0.05, 0, store));
    const scores = await scoreUsage({ answers, tasks, citing: new Set() }, judge);
    // the score of the global answer is the first pass's key points: 2 of 4
    expect(scores.find((x) => x.taskId === 'g1' && x.metric === 'correctness')?.value).toBe(0.5);
    const audits = store.allJudgeAudits();
    const points = audits.filter((a) => a.kind === 'keypoints');
    expect(points).toHaveLength(1);
    expect(points[0].agree).toBe(false);
    // the grades of the regular sample all agree: the key points' disagreement is not counted against them
    const grades = audits.filter((a) => a.kind === 'grade');
    expect(grades.length).toBeGreaterThanOrEqual(20);
    expect(grades.every((a) => a.agree)).toBe(true);
  });

  it('matches one list a call unless told to batch them', async () => {
    const lists = Array.from({ length: 6 }, (_, n) => ({ id: `l${n}`, predicted: [`p${n}`], gold: [`g${n}`] }));
    const one = twoMindedJudge(() => ({ pairs: [[0, 0]] }), () => ({ pairs: [[0, 0]] }));
    await new Judge({ client: one, meter: new Meter() }).matchList(lists);
    expect(one.calls.map((c) => c.length)).toEqual([1, 1, 1, 1, 1, 1]);
    const batched = twoMindedJudge(() => ({ pairs: [[0, 0]] }), () => ({ pairs: [[0, 0]] }));
    await new Judge({ client: batched, meter: new Meter(), listBatchSize: 4 }).matchList(lists);
    expect(batched.calls.map((c) => c.length).sort()).toEqual([2, 4]);
  });
});
