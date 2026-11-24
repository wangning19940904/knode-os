import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/llm/client.js';
import { goldNumbers, numberMatches, readNumbers } from '../src/eval/coverage.js';
import { appendDecoy, buildDecoys, decoyRecord, decoySummary, shiftedNumber, type Decoy } from '../src/eval/decoys.js';
import { Judge, mixIn, type GradeItem, type GradeVerdict } from '../src/eval/judge.js';
import { Meter } from '../src/eval/meter.js';
import { buildReportData, renderReport } from '../src/eval/report.js';
import type { AnswerRecord, Task } from '../src/eval/types.js';

/**
 * The judge's pass rate on wrong answers (docs/design/38 E8): decoys built
 * without a model from the gold and other questions' answers, mixed into the
 * grading batches, kept apart from the scores, and counted in the report.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-decoys-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, suite: 'usage', type: 'single-hop', question: `${id}?`, evidence: [], scoring: 'judge', ...over }) as Task;
const answer = (taskId: string, text: string, pack = 'p'): Pick<AnswerRecord, 'pack' | 'taskId' | 'finalAnswer' | 'text' | 'error'> => ({ pack, taskId, finalAnswer: text, text });

describe('building decoys', () => {
  it('moves the gold\'s number, written as the gold writes it, to a value no form of the gold matches', () => {
    const t = task('rev', { answer: '营业收入为167,424,382.67元', answers: ['167424382.67'] });
    const out = shiftedNumber(t, 0)!;
    expect(out).toMatch(/^营业收入为\d{1,3}(,\d{3})+\.\d{2}元$/);
    const gold = goldNumbers(t)!;
    expect(readNumbers(out).some((n) => gold.some((g) => numberMatches(n, g)))).toBe(false);
    // a year moves by a year or two; a gold that is not one number is not moved
    expect(shiftedNumber(task('y', { answer: '2019' }), 0)).toMatch(/^20(1[6-9]|2[01])$/);
    expect(shiftedNumber(task('n', { answer: '伍佰' }), 0)).toBeNull();
  });

  it('takes, per pack, the seeded questions the judge grades against a reference, each its first construction that works', () => {
    const tasks = new Map<string, Task>([
      ['p|num', task('num', { type: 'numeric', answer: '0.24' })],
      ['p|who', task('who', { answer: '张三' })],
      ['p|who2', task('who2', { answer: '李四' })],
      ['p|alone', task('alone', { type: 'temporal', answer: '在三月' })],
      ['p|abs', task('abs', { scoring: 'abstain' })],
      ['p|kp', task('kp', { scoring: 'keypoints', keypoints: ['a'] })],
      ['q|other', task('other', { answer: '王五' })],
    ]);
    const answers = [answer('who', '李四'), answer('num', '0.31'), answer('alone', '在三月'), answer('who2', '赵六')];
    const decoys = buildDecoys(tasks, answers, { perPack: 10, seed: 0 });
    const by = Object.fromEntries(decoys.map((d) => [d.taskId, d]));
    // only the pack that was answered; never an abstention or a question with key points alone
    expect(decoys.every((d) => d.pack === 'p')).toBe(true);
    expect(Object.keys(by).sort()).toEqual(['alone', 'num', 'who', 'who2']);
    expect(by.num.how).toBe('number-shifted');
    expect(by.who).toMatchObject({ how: 'other-gold', answer: 'Final answer: 李四', reference: '张三', question: 'who?' });
    // no other question of its type: another question's answer, never one that states its own gold
    expect(by.alone.how).toBe('other-answer');
    expect(by.alone.answer).not.toContain('在三月');
    expect(by.num.id).toMatch(/^[0-9a-f]{20}$/);
    // seeded, and at most perPack a pack
    expect(buildDecoys(tasks, answers, { perPack: 10, seed: 0 })).toEqual(decoys);
    expect(buildDecoys(tasks, answers, { perPack: 2, seed: 0 })).toHaveLength(2);
    expect(buildDecoys(tasks, answers, { perPack: 0, seed: 0 })).toEqual([]);
  });
});

describe('mixing decoys into the grading', () => {
  it('keeps the batch\'s order and puts each decoy at a seeded place', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}` }));
    const mixed = mixIn(items, [{ id: 'd1' }, { id: 'd2' }]);
    expect(mixed).toHaveLength(12);
    expect(mixed.filter((x) => x.id.startsWith('a'))).toEqual(items);
    expect(mixIn(items, [{ id: 'd1' }, { id: 'd2' }])).toEqual(mixed);
  });

  it('asks the decoys in the answers\' batches, returns their verdicts apart, and only once', async () => {
    const asked: string[][] = [];
    const client = {
      label: 'stub', model: 'stub', enabled: true,
      async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
        const items = (JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { id: string; answer: string }[] }).items;
        asked.push(items.map((i) => i.id));
        // a lenient judge: everything right, but for answers saying "wrong"
        return { verdicts: items.map((i) => ({ id: i.id, score: i.answer.includes('wrong') ? 0 : 2, keypoints: [], abstained: false, hallucinated: false, reason: 'ok' })) } as T;
      },
    } as unknown as LlmClient;
    const judge = new Judge({ client, meter: new Meter(), batchSize: 20 });
    const items: GradeItem[] = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, question: `q${i}`, reference: 'r', answer: 'x' }));
    const decoys: Decoy[] = [
      { id: 'd1', pack: 'p', taskId: 't1', taskType: 'numeric', how: 'number-shifted', question: 'q', reference: '0.24', answer: 'Final answer: 0.33' },
      { id: 'd2', pack: 'p', taskId: 't2', taskType: 'single-hop', how: 'other-gold', question: 'q', reference: '张三', answer: 'Final answer: wrong' },
    ];
    const got: [string, GradeVerdict][] = [];
    judge.mixDecoys(decoys, (d, v) => got.push([d.id, v]));
    // a pass with no answers of its own leaves them for the next
    expect((await judge.gradeAnswers([])).size).toBe(0);
    const verdicts = await judge.gradeAnswers(items);
    expect([...verdicts.keys()].sort()).toEqual(items.map((i) => i.id));
    expect(asked.at(-1)!.sort()).toEqual([...items.map((i) => i.id), 'd1', 'd2'].sort());
    expect(got.map(([id, v]) => [id, v.score])).toEqual(expect.arrayContaining([['d1', 2], ['d2', 0]]));
    // the next pass asks no decoy again
    await judge.gradeAnswers([{ id: 'a9', question: 'q9', reference: 'r', answer: 'y' }]);
    expect(asked.at(-1)).toEqual(['a9']);

    // the report: passed 1 of 2
    const runDir = path.join(tmp, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    for (const [id, v] of got) appendDecoy(runDir, decoyRecord(decoys.find((d) => d.id === id)!, v));
    const s = decoySummary([...fs.readFileSync(path.join(runDir, 'judge-decoys.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))])!;
    expect(s.all).toEqual({ n: 2, passed: 1, partial: 0 });
    expect(s.byHow['number-shifted']).toEqual({ n: 1, passed: 1, partial: 0 });
    const md = renderReport(buildReportData(runDir));
    expect(md).toContain('## Judge decoys');
    expect(md).toContain('| **all** | 2 | 1 (50%) | 0 (0%) |');
    expect(md).toContain('### Passed decoys (1)');
  });
});
