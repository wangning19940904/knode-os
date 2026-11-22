import fs from 'node:fs';
import path from 'node:path';
import { docText, evidenceDocs, foldSpace, type LoadedPack } from '../pack.js';
import type { Task } from '../types.js';

/**
 * How far a pack can be answered by lookup, measured without a model
 * (docs/design/33 §4): whether a literal term of each question lies in its
 * gold documents and how many other documents share it, how many questions
 * one document answers, and the corpus's size and shape. Beside it, the two
 * cheapest lint checks: an answer written into a file name, and one question
 * asked twice with different gold.
 */

/** A question term is selective when at most this many documents contain it: its grep hits fit on a screen. */
export const SELECTIVE_DOCS = [10, 100] as const;

const STOP = new Set(
  ('about above after again against also among another because been before being below between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while whom whose with would your yours many much only include included including based provide list name names give find tell what which how many does did were company companies year years total number ' +
    'please answer question following according among').split(/\s+/),
);

/** The terms a question could be grepped for: Latin words of four letters or more (numbers of three digits or more), CJK runs as 3- and 4-grams. */
export function questionTerms(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.normalize('NFKC').toLowerCase();
  for (const m of t.matchAll(/[a-z0-9]+(?:[-'.][a-z0-9]+)*/g)) {
    const w = m[0];
    if (/^\d+(?:[.,]\d+)*$/.test(w) ? w.replace(/\D/g, '').length >= 3 : w.length >= 4 && !STOP.has(w)) out.add(w);
  }
  for (const m of t.matchAll(/[㐀-鿿]+/g)) for (const n of [3, 4]) for (let i = 0; i + n <= m[0].length; i++) out.add(m[0].slice(i, i + n));
  return out;
}

/** The terms of `wanted` a document contains (same tokenisation as the question's). */
function termsIn(text: string, wanted: Set<string>): Set<string> {
  const found = new Set<string>();
  const t = text.normalize('NFKC').toLowerCase();
  for (const m of t.matchAll(/[a-z0-9]+(?:[-'.][a-z0-9]+)*/g)) if (wanted.has(m[0])) found.add(m[0]);
  for (const m of t.matchAll(/[㐀-鿿]+/g)) {
    const run = m[0];
    for (const n of [3, 4]) for (let i = 0; i + n <= run.length; i++) {
      const g = run.slice(i, i + n);
      if (wanted.has(g)) found.add(g);
    }
  }
  return found;
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const share = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export interface PackMeasure {
  pack: string;
  documents: number;
  chars: number;
  docChars: { min: number; p10: number; p50: number; p90: number; max: number; mean: number };
  /** Documents by length in characters. */
  lengthBuckets: Record<string, number>;
  tasks: number;
  byType: Record<string, number>;
  byStratum: Record<string, number>;
  /** meta.hops (the dataset's own count where it has one; else distinct evidence documents). */
  hops: Record<string, number>;
  /** Tasks with evidence, the denominator of the shares below. */
  withEvidence: number;
  /** A gold document contains a literal term of the question. */
  literalTerm: number | null;
  /** A gold document contains a question term that at most N documents of the corpus contain. */
  selectiveTerm: Record<string, number | null>;
  /** Every gold document contains such a term: no step needs a bridge found elsewhere. */
  everyGoldSelective: Record<string, number | null>;
  /** One document holds all the evidence. */
  singleDocument: number | null;
  lint: { answerInFileName: string[]; duplicateQuestionDifferentGold: string[][] };
}

/** The gold a task is scored against, as one comparable string. */
function goldKey(t: Task): string {
  return JSON.stringify([t.answer ?? null, [...(t.answers ?? [])].sort(), (t.items ?? []).map((i) => i.label).sort(), t.scoring]);
}

/** Answer strings worth looking for in a path: a letter or a CJK character in them, three characters or more. */
function answerStrings(t: Task): string[] {
  const raw = [t.answer, ...(t.answers ?? []), ...(t.items ?? []).flatMap((i) => [i.label, ...(i.fields?.flat() ?? [])])].filter((s): s is string => Boolean(s));
  return [...new Set(raw.map((s) => s.normalize('NFKC').toLowerCase().trim()))].filter((s) => s.length >= 3 && s.length <= 80 && /[a-z㐀-鿿]/.test(s));
}

export function cheapLint(pack: LoadedPack): PackMeasure['lint'] {
  const paths = pack.docs.map((d) => d.path.normalize('NFKC').toLowerCase());
  // a localization task's answer is a path by design (docs/design/37 §2): its question is what must not give it
  const answerInFileName = pack.tasks.filter((t) => t.type !== 'localization' && answerStrings(t).some((a) => paths.some((p) => p.includes(a)))).map((t) => t.id);
  const byQuestion = new Map<string, Task[]>();
  for (const t of pack.tasks) {
    const k = foldSpace(t.question).toLowerCase();
    (byQuestion.get(k) ?? byQuestion.set(k, []).get(k)!).push(t);
  }
  const duplicateQuestionDifferentGold = [...byQuestion.values()].filter((ts) => ts.length > 1 && new Set(ts.map(goldKey)).size > 1).map((ts) => ts.map((t) => t.id));
  return { answerInFileName, duplicateQuestionDifferentGold };
}

export function measurePack(pack: LoadedPack): PackMeasure {
  const lengths: number[] = [];
  const qTerms = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const t of pack.tasks) {
    const terms = questionTerms(t.question);
    qTerms.set(t.id, terms);
    for (const w of terms) all.add(w);
  }
  const gold = new Set(pack.tasks.flatMap(evidenceDocs));
  const df = new Map<string, number>();
  const goldTerms = new Map<string, Set<string>>();
  for (const d of pack.docs) {
    const text = docText(pack, d.path);
    lengths.push(text.length);
    const found = termsIn(text, all);
    for (const w of found) df.set(w, (df.get(w) ?? 0) + 1);
    if (gold.has(d.path)) goldTerms.set(d.path, found);
  }
  lengths.sort((a, b) => a - b);
  const chars = lengths.reduce((a, b) => a + b, 0);
  const buckets: [string, number][] = [['<1k', 1e3], ['1k-5k', 5e3], ['5k-20k', 2e4], ['20k-100k', 1e5], ['100k-500k', 5e5], ['>=500k', Infinity]];
  const lengthBuckets = Object.fromEntries(buckets.map(([k]) => [k, 0]));
  for (const n of lengths) lengthBuckets[buckets.find(([, hi]) => n < hi)![0]]++;

  const count = (f: (t: Task) => string) => {
    const m: Record<string, number> = {};
    for (const t of pack.tasks) m[f(t)] = (m[f(t)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  };
  const withEv = pack.tasks.filter((t) => evidenceDocs(t).length > 0);
  let literal = 0;
  let single = 0;
  const selective: Record<string, number> = {};
  const every: Record<string, number> = {};
  for (const t of withEv) {
    const docs = evidenceDocs(t);
    const terms = qTerms.get(t.id)!;
    const hits = docs.map((d) => [...(goldTerms.get(d) ?? [])].filter((w) => terms.has(w)));
    if (hits.some((h) => h.length)) literal++;
    if (docs.length === 1) single++;
    for (const k of SELECTIVE_DOCS) {
      const sel = hits.map((h) => h.some((w) => (df.get(w) ?? 0) <= k));
      if (sel.some(Boolean)) selective[k] = (selective[k] ?? 0) + 1;
      if (sel.every(Boolean)) every[k] = (every[k] ?? 0) + 1;
    }
  }
  return {
    pack: pack.manifest.id,
    documents: pack.docs.length,
    chars,
    docChars: { min: lengths[0] ?? 0, p10: quantile(lengths, 0.1), p50: quantile(lengths, 0.5), p90: quantile(lengths, 0.9), max: lengths.at(-1) ?? 0, mean: Math.round(chars / Math.max(1, lengths.length)) },
    lengthBuckets,
    tasks: pack.tasks.length,
    byType: count((t) => t.type),
    byStratum: count((t) => String(t.meta?.stratum ?? t.type)),
    hops: count((t) => String(t.meta?.hops ?? evidenceDocs(t).length)),
    withEvidence: withEv.length,
    literalTerm: share(literal, withEv.length),
    selectiveTerm: Object.fromEntries(SELECTIVE_DOCS.map((k) => [`<=${k}docs`, share(selective[k] ?? 0, withEv.length)])),
    everyGoldSelective: Object.fromEntries(SELECTIVE_DOCS.map((k) => [`<=${k}docs`, share(every[k] ?? 0, withEv.length)])),
    singleDocument: share(single, withEv.length),
    lint: cheapLint(pack),
  };
}

/** Measures a built pack and keeps the result beside it (`measure.json`, outside corpus/ and gold/). */
export function writeMeasure(pack: LoadedPack): PackMeasure {
  const m = measurePack(pack);
  fs.writeFileSync(path.join(pack.dir, 'measure.json'), JSON.stringify(m, null, 2) + '\n');
  return m;
}
