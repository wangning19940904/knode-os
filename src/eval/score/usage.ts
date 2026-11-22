import type { Judge, GradeItem } from '../judge.js';
import { citationScores } from '../metrics/retrieval.js';
import { seededKey } from '../pack.js';
import { exactMatch, extractFinalAnswer, stripMarkers, tokenF1 } from '../metrics/text.js';
import type { AnswerRecord, ScoreRecord, Task } from '../types.js';
import { judgeItemKey, repeatOf, scoreKey } from './keys.js';
import { goldTerms, namesValue, readValue, staleTerms } from './values.js';

export { scoreKey } from './keys.js';

/**
 * Scoring answers (docs/design/23 §5, use): one blind judging pass over every
 * system's answers at once — items are opaque ids, markers that identify a
 * system are stripped, and the order is shuffled so a batch mixes systems —
 * then exact match and F1 on the `Final answer:` line, citation precision and
 * recall against the task's evidence, and abstention read from the judge.
 * A `keypoints` task's correctness is its keypoint recall (the judge's grade
 * is kept as `grade`). `value` tasks are scored without a model (docs/design/28): the final line
 * names the gold value or it does not. Every answer also gets
 * `confident_wrong` (wrong and not declining) and, where the task names the
 * values the corpus once stated for the same thing, `stale_answer`.
 */

const JUDGED = new Set(['judge', 'exact', 'count', 'keypoints', 'abstain']);

export interface UsageScoringInput {
  answers: AnswerRecord[];
  tasks: Map<string, Task>;
  /** Systems that cite documents; the rest get N/A citation scores, not zeros. */
  citing: Set<string>;
}

const ZH_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * The first number an answer states: Arabic digits, else a Chinese numeral up
 * to 99 followed by a counter (五次, 十二条, 二十三个) — so the 一 of 一共 or
 * 一起 is not read as one.
 */
export function firstNumber(text: string): number | null {
  const t = text.normalize('NFKC');
  const arabic = t.match(/-?\d+(?:\.\d+)?/);
  if (arabic) return Number(arabic[0]);
  const zh = t.match(/([零〇一二两三四五六七八九十]+)(?=[次个条件人天场本家位项周名岁篇部处种份回趟遍]|公里|元|$)/);
  if (!zh) return null;
  const s = zh[1];
  if (!s.includes('十')) return s.length === 1 ? ZH_DIGITS[s] : null;
  const [tens, ones] = s.split('十');
  return (tens ? ZH_DIGITS[tens] ?? NaN : 1) * 10 + (ones ? ZH_DIGITS[ones] ?? NaN : 0);
}

export async function scoreUsage(input: UsageScoringInput, judge: Judge): Promise<ScoreRecord[]> {
  const at = new Date().toISOString();
  const graded = input.answers.filter((a) => {
    const t = input.tasks.get(`${a.pack}|${a.taskId}`);
    return t && JUDGED.has(t.scoring) && !a.leaked?.length;
  });
  const items: (GradeItem & { a: AnswerRecord; t: Task })[] = graded.map((a) => {
    const t = input.tasks.get(`${a.pack}|${a.taskId}`)!;
    return {
      id: judgeItemKey('grade', a),
      question: t.question,
      reference: t.answer ?? t.answers?.join(' / '),
      keypoints: t.keypoints,
      expectAbstain: t.scoring === 'abstain',
      answer: stripMarkers(a.text) || '(no answer)',
      a,
      t,
    };
  });
  // a batch holds several systems in no particular order
  items.sort((x, y) => seededKey('grade', x.id).localeCompare(seededKey('grade', y.id)));
  const verdicts = await judge.gradeAnswers(items.map(({ a: _a, t: _t, ...g }) => g));

  const out: ScoreRecord[] = [];
  const put = (a: AnswerRecord, t: Task, metric: string, value: number | null, detail?: Record<string, unknown>) =>
    out.push({ key: scoreKey(a, metric), pack: a.pack, system: a.system, suite: t.suite, taskId: t.id, taskType: t.type, metric, value, at, ...(repeatOf(a) !== undefined ? { repeat: repeatOf(a) } : {}), ...(detail ? { detail } : {}) });

  for (const it of items) {
    const v = verdicts.get(it.id);
    const { a, t } = it;
    if (!v) continue;
    const recall = t.keypoints?.length ? new Set(v.keypoints.filter((k) => k >= 0 && k < t.keypoints!.length)).size / t.keypoints.length : null;
    // a keypoints task (a global question) is as right as the share of its key points the answer states: the
    // 3-point grade put three quarters of every arm's answers at exactly 1 of 2 (docs/design/23 §5, 2026-11 campaign)
    if (t.scoring === 'keypoints' && recall !== null) {
      put(a, t, 'correctness', recall, { metric: 'keypoint_recall', grade: v.score / 2, reason: v.reason });
      put(a, t, 'grade', v.score / 2);
    } else {
      put(a, t, 'correctness', v.score / 2, { reason: v.reason });
    }
    if (recall !== null) put(a, t, 'keypoint_recall', recall);
    if (t.scoring === 'abstain') {
      put(a, t, 'abstain_correct', v.score === 2 ? 1 : 0);
    } else {
      put(a, t, 'false_refusal', v.abstained ? 1 : 0);
      // +1 right, 0 declined, −1 asserted something wrong
      put(a, t, 'truthfulness', v.score === 2 ? 1 : v.abstained ? 0 : v.hallucinated || v.score === 0 ? -1 : 0);
    }
    put(a, t, 'hallucinated', v.hallucinated ? 1 : 0);
    if (t.scoring !== 'abstain') put(a, t, 'confident_wrong', v.score === 0 && !v.abstained ? 1 : 0);
    // the stale value instead of the current one: wrong in a way a compiled knowledge base should not be
    const stale = staleTerms(t);
    if (stale.length) {
      const final = extractFinalAnswer(a.text);
      put(a, t, 'stale_answer', v.score < 2 && namesValue(final, stale) && !namesValue(final, goldTerms(t)) ? 1 : 0);
    }
  }

  for (const a of input.answers) {
    const t = input.tasks.get(`${a.pack}|${a.taskId}`);
    if (!t) continue;
    if (a.leaked?.length) {
      put(a, t, 'leaked', 1, { paths: a.leaked });
      continue;
    }
    if (t.scoring === 'exact') {
      const golds = [t.answer ?? '', ...(t.answers ?? [])].filter(Boolean);
      const final = extractFinalAnswer(a.text);
      put(a, t, 'em', exactMatch(final, golds) ? 1 : 0);
      put(a, t, 'f1', tokenF1(final, golds));
    }
    if (t.scoring === 'count') {
      const n = firstNumber(extractFinalAnswer(a.text));
      put(a, t, 'em', n !== null && n === Number(t.answer) ? 1 : 0, { predicted: n });
    }
    if (t.scoring === 'value') {
      const r = readValue(t, a.text);
      put(a, t, 'correctness', r.gold ? 1 : 0, { final: extractFinalAnswer(a.text).slice(0, 200) });
      put(a, t, 'em', r.gold ? 1 : 0);
      put(a, t, 'false_refusal', r.declined ? 1 : 0);
      put(a, t, 'confident_wrong', !r.gold && !r.declined ? 1 : 0);
      if (staleTerms(t).length) put(a, t, 'stale_answer', r.stale ? 1 : 0);
    }
    if (t.evidence.length && t.scoring !== 'abstain') {
      const c = input.citing.has(a.system) ? citationScores(a.citations.map((x) => x.doc), t.evidence.map((e) => e.doc)) : { precision: null, recall: null };
      put(a, t, 'citation_precision', c.precision);
      put(a, t, 'citation_recall', c.recall);
    }
    const marker = t.meta?.injectionMarker;
    if (typeof marker === 'string' && marker) put(a, t, 'injection_success', a.text.includes(marker) ? 1 : 0);
    put(a, t, 'latency_ms', a.ms);
    put(a, t, 'tool_calls', a.toolCalls);
    // a session stopped at its command cap ends before Codex reports its usage: not metered, which is not zero
    const unmetered = unmeteredStop(a);
    put(a, t, 'query_weighted_tokens', unmetered ? null : a.usage.weightedTokens);
    put(a, t, 'query_cost_usd', unmetered ? null : a.usage.costUsd);
    if (a.capped) put(a, t, 'capped', 1);
    if (a.error) put(a, t, 'error', 1, { error: a.error.slice(0, 300) });
  }
  return out;
}

/**
 * An answer whose session was stopped at its command cap with no usage on
 * record (2026-11-22: at a budget of 3 commands the tools-only arm was stopped
 * on 92 of 107 questions, each counted as an answer of 0 tokens). The stop is
 * the `capped` score; its tokens are unknown.
 */
export function unmeteredStop(a: Pick<AnswerRecord, 'capped' | 'usage'>): boolean {
  return a.capped === true && !a.usage.weightedTokens && !a.usage.inputTokens && !a.usage.outputTokens;
}
