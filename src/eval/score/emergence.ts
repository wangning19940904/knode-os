import { canonicalListPairs, type Judge } from '../judge.js';
import { termMatches } from '../metrics/stylometry.js';
import { normalizeAnswer } from '../metrics/text.js';
import { parseStructured } from '../prompts.js';
import { judgeItemKey, repeatOf, scoreKey } from './keys.js';
import type { AnswerRecord, GoldItem, ScoreRecord, Task } from '../types.js';

/**
 * Scoring emergence probes (docs/design/23 §5): every system answers the
 * same probe with the same JSON (items with confidence and evidence), and the
 * items are matched one-to-one against a fixed gold list — by the judge for
 * themes and needs, without a model for characteristic words, labels and
 * attribution. Recall is split by how directly the signal is written in the
 * sources (explicit / implicit / latent) where the gold says.
 */

export interface EmergenceInput {
  answers: AnswerRecord[];
  tasks: Map<string, Task>;
  corpusDocs: Map<string, Set<string>>;
}

const sameLabel = (a: string, gold: string[]) => gold.some((g) => normalizeAnswer(g) === normalizeAnswer(a) || normalizeAnswer(a).includes(normalizeAnswer(g)));

export async function scoreEmergence(input: EmergenceInput, judge: Judge): Promise<ScoreRecord[]> {
  const at = new Date().toISOString();
  const out: ScoreRecord[] = [];
  const put = (a: AnswerRecord, t: Task, metric: string, value: number | null, detail?: Record<string, unknown>) =>
    out.push({ key: scoreKey(a, metric), pack: a.pack, system: a.system, suite: t.suite, taskId: t.id, taskType: t.type, metric, value, at, ...(repeatOf(a) !== undefined ? { repeat: repeatOf(a) } : {}), ...(detail ? { detail } : {}) });

  const toJudge: { id: string; predicted: string[]; gold: string[]; a: AnswerRecord; t: Task; items: ReturnType<typeof parseStructured>['items'] }[] = [];
  for (const a of input.answers) {
    const t = input.tasks.get(`${a.pack}|${a.taskId}`);
    if (!t || a.leaked?.length) continue;
    const parsed = parseStructured(a.text);
    if (t.scoring === 'label' || t.scoring === 'choice') {
      const gold = [t.answer ?? '', ...(t.answers ?? [])].filter(Boolean);
      const ok = parsed.label ? sameLabel(parsed.label, gold) : false;
      put(a, t, 'label_correct', ok ? 1 : 0, { predicted: parsed.label, gold });
      if (parsed.confidence !== null) put(a, t, 'brier', (parsed.confidence - (ok ? 1 : 0)) ** 2);
      continue;
    }
    // corpus-level lists (a list spec) are scored by score/lists.ts
    if (t.scoring !== 'set' || !t.items?.length || t.list) continue;
    const docs = input.corpusDocs.get(a.pack) ?? new Set();
    const minEvidence = Number(t.meta?.minEvidence ?? 1);
    const items = parsed.items.slice(0, 10);
    put(a, t, 'items_returned', items.length);
    put(a, t, 'grounded_share', items.length ? items.filter((i) => i.evidence.filter((e) => docs.has(e.replace(/^(?:raw\/docs|raw|corpus)\//, ''))).length >= minEvidence).length / items.length : 0);
    if (t.meta?.match === 'terms') {
      scoreTerms(a, t, items.map((i) => i.label), put);
      continue;
    }
    toJudge.push({ id: judgeItemKey('match', a), predicted: items.map((i) => i.label), gold: t.items.map((g) => [g.label, ...g.aliases].join(' / ')), a, t, items });
  }

  const verdicts = await judge.matchItems(toJudge.map(({ id, predicted, gold }) => ({ id, predicted, gold })));
  for (const j of toJudge) {
    const v = verdicts.get(j.id);
    if (!v) continue;
    const gold = j.t.items!;
    const pairs = canonicalListPairs(v.pairs, j.predicted.length, gold.length);
    setScores(j.a, j.t, gold, pairs, j.predicted.length, j.items.map((i) => i.confidence), put);
  }
  return out;
}

type Put = (a: AnswerRecord, t: Task, metric: string, value: number | null, detail?: Record<string, unknown>) => void;

function setScores(a: AnswerRecord, t: Task, gold: GoldItem[], pairs: [number, number][], predicted: number, confidences: (number | null)[], put: Put): void {
  const totalWeight = gold.reduce((s, g) => s + g.weight, 0);
  const hitWeight = pairs.reduce((s, [, g]) => s + gold[g].weight, 0);
  const precision = predicted ? pairs.length / predicted : 0;
  const recall = totalWeight ? hitWeight / totalWeight : 0;
  put(a, t, 'set_precision', precision);
  put(a, t, 'set_recall', recall, { matched: pairs.map(([p, g]) => [p, gold[g].label]) });
  put(a, t, 'set_f1', precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
  for (const signal of ['explicit', 'implicit', 'latent'] as const) {
    const of = gold.map((g, i) => ({ g, i })).filter((x) => x.g.signal === signal);
    if (!of.length) continue;
    const hit = of.filter((x) => pairs.some(([, g]) => g === x.i)).length;
    put(a, t, `set_recall_${signal}`, hit / of.length);
  }
  const matched = new Set(pairs.map(([p]) => p));
  const calib = confidences.map((c, i) => (c === null ? null : (c - (matched.has(i) ? 1 : 0)) ** 2)).filter((x): x is number => x !== null);
  if (calib.length) put(a, t, 'brier', calib.reduce((s, x) => s + x, 0) / calib.length);
}

/** Characteristic words: model-free matching against the stylometric gold, precision@10 and recall@10. */
function scoreTerms(a: AnswerRecord, t: Task, predicted: string[], put: Put): void {
  const lang = (t.lang === 'zh' ? 'zh' : 'en') as 'zh' | 'en';
  const gold = t.items!;
  const pairs: [number, number][] = [];
  const used = new Set<number>();
  predicted.slice(0, 10).forEach((p, pi) => {
    const gi = gold.findIndex((g, i) => !used.has(i) && [g.label, ...g.aliases].some((x) => termMatches(p, x, lang)));
    if (gi >= 0) {
      used.add(gi);
      pairs.push([pi, gi]);
    }
  });
  put(a, t, 'terms_precision_at_10', predicted.length ? pairs.length / Math.min(10, predicted.length) : 0, { matched: pairs.map(([p, g]) => [predicted[p], gold[g].label]) });
  put(a, t, 'terms_recall_at_10', Math.min(10, gold.length) ? pairs.length / Math.min(10, gold.length) : 0);
}
