import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goldNumbers, normalize, numberMatches, readNumbers } from './coverage.js';
import type { GradeItem, GradeVerdict } from './judge.js';
import { recordKey } from './runstore.js';
import type { AnswerRecord, Task } from './types.js';

/**
 * The judge's pass rate on answers known to be wrong (docs/design/38 §7, E8).
 *
 * A run may mix a few decoys a pack into the judge's grading batches: answers
 * built without a model that are on topic and wrong — the question's own gold
 * with its number shifted, the gold of another question of the same type, or
 * another question's answer a system gave. They go to the judge like any
 * answer (an id of the same shape, the same question, reference and key
 * points, in a seeded place among the batch's items), their verdicts are kept
 * apart in `judge-decoys.jsonl` and never scored, and the report gives the
 * share the judge graded right (score 2) and partly right (score 1).
 *
 * Only questions the judge grades against a reference answer are used
 * (scoring judge, exact, count, keypoints with an answer); abstentions and
 * key-point-only questions are not.
 */

export type DecoyHow = 'number-shifted' | 'other-gold' | 'other-answer';

export interface Decoy extends GradeItem {
  pack: string;
  taskId: string;
  taskType: string;
  how: DecoyHow;
}

export interface DecoyRecord {
  key: string;
  pack: string;
  taskId: string;
  taskType: string;
  how: DecoyHow;
  answer: string;
  reference: string;
  score: 0 | 1 | 2;
  abstained: boolean;
  reason?: string;
  at: string;
}

export const DECOY_FILE = 'judge-decoys.jsonl';

const GRADED = new Set(['judge', 'exact', 'count', 'keypoints']);

/** A stable fraction in [0, 1) from what is hashed. */
function fraction(...parts: unknown[]): number {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest().readUInt32BE(0) / 2 ** 32;
}

const referenceOf = (t: Task): string | undefined => t.answer ?? t.answers?.join(' / ');

/** Factors a gold number is moved by: far enough to be wrong at any rounding, near enough to look like an answer. */
const SHIFTS = [1.37, 0.73, 1.9, 0.52, 2.6];

/** The number written like `raw` (its decimals, its thousands separators). */
function writeLike(raw: string, value: number): string {
  const plain = raw.replace(/,/g, '');
  const decimals = plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0;
  const fixed = Math.abs(value).toFixed(decimals);
  if (!raw.includes(',')) return fixed;
  const [int, dec] = fixed.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${dec !== undefined ? `.${dec}` : ''}`;
}

/** The gold with its one number moved (a year by a year or two), or null when the gold is not one number. */
export function shiftedNumber(t: Task, seed: string | number): string | null {
  const gold = goldNumbers(t);
  const ref = t.answer;
  if (!gold?.length || !ref) return null;
  // the number goldNumbers read: the first that is not part of a date
  const dateless = ref.normalize('NFKC');
  const m = [...dateless.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].find((x) => !/[-/年月]\s*$/.test(dateless.slice(0, x.index)) && !/^\s*[-/年月日]/.test(dateless.slice((x.index ?? 0) + x[0].length)));
  if (!m) return null;
  const raw = m[0];
  const value = Number(raw.replace(/,/g, ''));
  const yearLike = !raw.includes('.') && !raw.includes(',') && value >= 1900 && value <= 2100;
  const start = Math.floor(fraction('decoy-shift', seed, t.id) * SHIFTS.length);
  const candidates = yearLike ? [value + 2, value - 1, value + 1, value - 3] : SHIFTS.map((_, i) => value * SHIFTS[(start + i) % SHIFTS.length]);
  for (const c of candidates) {
    let text = writeLike(raw, c);
    if (Number(text.replace(/,/g, '')) === value) text = writeLike(raw, value + 1);
    const out = `${dateless.slice(0, m.index)}${text}${dateless.slice((m.index ?? 0) + raw.length)}`;
    // wrong against every form of the gold, at every scale a table may print it in
    if (!readNumbers(out).some((n) => gold.some((g) => numberMatches(n, g)))) return out;
  }
  return null;
}

/** A text that states this task's gold (normalized): a decoy built from it would not be wrong. */
function statesGold(t: Task, text: string): boolean {
  const n = normalize(text);
  const golds = [t.answer, ...(t.answers ?? [])].filter((x): x is string => Boolean(x && x.trim()));
  if (golds.some((g) => normalize(g).length > 0 && n.includes(normalize(g)))) return true;
  const nums = goldNumbers(t);
  return Boolean(nums?.length && readNumbers(text).some((r) => nums!.some((g) => numberMatches(r, g))));
}

/**
 * Up to `perPack` decoys a pack, from the tasks in `tasks` (keyed
 * `<pack>|<taskId>`) of the packs that `answers` answered: questions picked in
 * a seeded order, each given the first construction that works — its gold's
 * number shifted, another same-type question's gold, another question's
 * answer from the run (same type first). Pure: nothing is asked.
 */
export function buildDecoys(tasks: Map<string, Task>, answers: Pick<AnswerRecord, 'pack' | 'taskId' | 'finalAnswer' | 'text' | 'error'>[], opts: { perPack: number; seed: string | number }): Decoy[] {
  if (!(opts.perPack > 0)) return [];
  const byPack = new Map<string, Task[]>();
  for (const [k, t] of tasks) {
    const pack = k.slice(0, k.lastIndexOf('|'));
    (byPack.get(pack) ?? byPack.set(pack, []).get(pack)!).push(t);
  }
  const answered = new Set(answers.map((a) => a.pack));
  const out: Decoy[] = [];
  for (const [pack, all] of [...byPack].sort(([a], [b]) => a.localeCompare(b))) {
    if (!answered.has(pack)) continue;
    const graded = all.filter((t) => GRADED.has(t.scoring) && referenceOf(t));
    const finals = answers.filter((a) => a.pack === pack && !a.error && (a.finalAnswer || a.text)?.trim());
    const order = [...graded].sort((x, y) => fraction('decoy', opts.seed, pack, x.id) - fraction('decoy', opts.seed, pack, y.id));
    let made = 0;
    for (const t of order) {
      if (made >= opts.perPack) break;
      const rank = (x: { id?: string; taskId?: string }) => fraction('decoy-source', opts.seed, pack, t.id, x.id ?? x.taskId);
      const pick = (): { answer: string; how: DecoyHow } | null => {
        const shifted = shiftedNumber(t, opts.seed);
        if (shifted) return { answer: shifted, how: 'number-shifted' };
        const others = graded.filter((o) => o.id !== t.id && referenceOf(o) && !statesGold(t, referenceOf(o)!));
        const same = others.filter((o) => o.type === t.type).sort((a, b) => rank(a) - rank(b));
        if (same.length) return { answer: referenceOf(same[0])!, how: 'other-gold' };
        const theirs = finals.filter((a) => a.taskId !== t.id && !statesGold(t, a.finalAnswer || a.text)).sort((a, b) => rank(a) - rank(b));
        const sameType = theirs.filter((a) => tasks.get(`${pack}|${a.taskId}`)?.type === t.type);
        const a = sameType[0] ?? theirs[0];
        return a ? { answer: (a.finalAnswer || a.text).trim().slice(0, 1500), how: 'other-answer' } : null;
      };
      const p = pick();
      if (!p) continue;
      out.push({
        id: recordKey('decoy', pack, t.id, String(opts.seed)), pack, taskId: t.id, taskType: t.type, how: p.how,
        question: t.question, reference: referenceOf(t), ...(t.keypoints?.length ? { keypoints: t.keypoints } : {}),
        answer: `Final answer: ${p.answer}`,
      });
      made++;
    }
  }
  return out;
}

/** The decoys a run has had judged, by key. */
export function readDecoys(runDir: string): DecoyRecord[] {
  const f = path.join(runDir, DECOY_FILE);
  if (!fs.existsSync(f)) return [];
  const by = new Map<string, DecoyRecord>();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as DecoyRecord;
      by.set(r.key, r);
    } catch {
      /* a torn line */
    }
  }
  return [...by.values()];
}

export function decoyRecord(d: Decoy, v: GradeVerdict): DecoyRecord {
  return {
    key: d.id, pack: d.pack, taskId: d.taskId, taskType: d.taskType, how: d.how, answer: d.answer, reference: d.reference ?? '',
    score: v.score, abstained: Boolean(v.abstained), ...(v.reason ? { reason: v.reason } : {}), at: new Date().toISOString(),
  };
}

export function appendDecoy(runDir: string, r: DecoyRecord): void {
  fs.appendFileSync(path.join(runDir, DECOY_FILE), JSON.stringify(r) + '\n');
}

export interface DecoySummaryRow {
  n: number;
  /** Graded fully right (2): the judge let a wrong answer pass. */
  passed: number;
  /** Graded partly right (1). */
  partial: number;
}

export interface DecoySummary {
  all: DecoySummaryRow;
  byPack: Record<string, DecoySummaryRow>;
  byHow: Record<string, DecoySummaryRow>;
  /** The decoys the judge passed, for reading. */
  passedItems: { pack: string; taskId: string; how: DecoyHow; answer: string; reference: string; reason?: string }[];
}

/** The judge's pass rate on decoys: overall, per pack and per construction. Null with none judged. */
export function decoySummary(records: DecoyRecord[]): DecoySummary | null {
  if (!records.length) return null;
  const row = (): DecoySummaryRow => ({ n: 0, passed: 0, partial: 0 });
  const s: DecoySummary = { all: row(), byPack: {}, byHow: {}, passedItems: [] };
  for (const r of records) {
    for (const x of [s.all, (s.byPack[r.pack] ??= row()), (s.byHow[r.how] ??= row())]) {
      x.n++;
      if (r.score === 2) x.passed++;
      else if (r.score === 1) x.partial++;
    }
    if (r.score === 2) s.passedItems.push({ pack: r.pack, taskId: r.taskId, how: r.how, answer: r.answer, reference: r.reference, ...(r.reason ? { reason: r.reason } : {}) });
  }
  return s;
}
