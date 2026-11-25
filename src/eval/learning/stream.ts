import fs from 'node:fs';
import path from 'node:path';
import { attributeOf, periodOf } from '../../learn/facts.js';
import { bySeed, evidenceDocs, LoadedPack, writeJsonl, writeManifest } from '../pack.js';
import type { CorpusDoc, Task } from '../types.js';

/**
 * The learning suite's question stream (docs/design/38 §4.3), built from a
 * pack's own tasks and metadata without a model:
 *
 *   1. cold      a set S, asked first, with write-back on;
 *   2. warm      asked after all of S, four kinds:
 *                  same        a question of S again, word for word;
 *                  paraphrase  the same question in other words (a pack's own
 *                              paraphrase family, `meta.of`; or a paraphraser);
 *                  near        the same attribute of another subject, or another
 *                              attribute of the same subject (or, where a pack
 *                              asks one value at several dates, another date);
 *                  far         a question sharing neither, the control;
 *   3. update    the pack's update tasks about what S asked, after their batch.
 *
 * A task's subject and attribute are read from what the pack says: a team or
 * company named in the question, the company of a filing's title, the
 * question's words without its subject and period (src/learn/facts.ts
 * `attributeOf`, the same reading a write-back makes). Gold answers are copied
 * with their tasks and never read to pair them.
 */

export const LEARNING_CLASSES = ['cold', 'same', 'paraphrase', 'near-metric', 'near-subject', 'near-period', 'far', 'update'] as const;
export type LearningClass = (typeof LEARNING_CLASSES)[number];
/** The warm classes as the report groups them: near-* together. */
export const WARM_GROUPS = ['same', 'paraphrase', 'near', 'far'] as const;

export interface LearningMeta {
  phase: 'cold' | 'warm' | 'update';
  class: LearningClass;
  /** The pack task it was made from. */
  base: string;
  /** The cold learning task it is paired with (its warm counterpart, or the cold question it is near to); null for a cold one. */
  of: string | null;
  subject: string | null;
  metric: string | null;
  /** A paraphrase that came from a paraphraser rather than the pack: which. */
  paraphraser?: string;
}

export function learningMeta(t: Task): LearningMeta | null {
  const m = t.meta?.learning;
  return m && typeof m === 'object' ? (m as LearningMeta) : null;
}

/** Writes a question in other words. A model-backed one is for a run that pays for it; `STUB_PARAPHRASER` is for tests. */
export interface Paraphraser {
  id: string;
  paraphrase(t: Task): string | null;
}

/**
 * A deterministic stand-in: the question with a fixed lead-in and its asking
 * words swapped. Not a paraphrase a person would accept as one — it is there
 * so the suite runs end to end on a pack with no paraphrase family. A real
 * paraphraser (a model call per question) plugs in through `Paraphraser`.
 */
export const STUB_PARAPHRASER: Paraphraser = {
  id: 'stub',
  paraphrase(t) {
    const q = t.question.trim();
    if (/[一-鿿]/.test(q)) return `请问：${q.replace(/是多少/g, '为多少').replace(/是什么/g, '为何').replace(/是哪/g, '为哪')}`;
    return `Could you tell me: ${q.replace(/^What is/i, 'what is').replace(/^What was/i, 'what was')}`;
  },
};

/** The company a filing's title names: "平安银行（000001）2024年第一季度报告" → 平安银行; "ARVANA INC. annual report (Form 10-K)" → ARVANA INC. */
export function titleSubject(title: string | undefined): string | null {
  if (!title) return null;
  const s = title.split(/（|\(|\s+(?:annual|quarterly|interim)\s+report|\s*\d{4}\s*年|\s+\d{4}\b/i)[0].trim();
  return s.length >= 2 ? s : null;
}

/** Where `name` occurs in `text` ignoring case, as written there; null when it does not. */
function asWritten(text: string, name: string): string | null {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  return i >= 0 ? text.slice(i, i + name.length) : null;
}

/** The subject a task asks about, from what the pack says. */
export function taskSubject(t: Task, docs: ReadonlyMap<string, CorpusDoc>): string | null {
  const meta = t.meta ?? {};
  if (typeof meta.subject === 'string' && meta.subject.trim()) return meta.subject.trim();
  const ev = evidenceDocs(t);
  if (ev.length === 1) {
    const company = titleSubject(docs.get(ev[0])?.title);
    if (company) {
      const written = asWritten(t.question, company) ?? asWritten(t.question, company.replace(/[,.]?\s*(inc|corp|corporation|ltd|co|holdings?)\.?$/i, '').trim());
      if (written) return written;
    }
  }
  const team = /([一-鿿]{2,8}组)/.exec(t.question);
  if (team) return team[1];
  // a question that opens with whom it is about: "林晓在…", "林晓的…"
  const lead = /^([一-鿿]{2,4}?)(?:的|在|是|有|最终|现在|一共)/.exec(t.question.trim());
  return lead ? lead[1] : null;
}

/** The attribute a task asks for: its question without subject, period and asking words, folded for grouping. */
export function taskMetric(t: Task, subject: string | null): string | null {
  const q = t.question;
  const period = periodOf(q);
  const a = attributeOf(q, subject, period?.words ?? null);
  return a ? a.toLowerCase().replace(/\s+/g, ' ').trim() : null;
}

/** Scorings whose gold is one value a model-free check can hold an answer to: what a write-back can carry. */
const LEARNABLE_SCORINGS = new Set(['value', 'exact', 'count']);

export interface StreamOptions {
  /** Cold questions (default 30). */
  cold?: number;
  /** Far controls (default half of the cold set, at least one). */
  far?: number;
  seed?: string | number;
  /** Writes paraphrases for cold questions the pack has none for (default none). */
  paraphraser?: Paraphraser | null;
}

export interface LearningStream {
  tasks: Task[];
  /** Questions per class. */
  counts: Record<LearningClass, number>;
  /** What the pack could offer before sampling: pairs available per kind. */
  available: { pool: number; paraphrase: number; nearMetric: number; nearSubject: number; nearPeriod: number; far: number; update: number };
}

interface Keyed { t: Task; subject: string | null; metric: string | null }

const sameSubject = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Build the stream from a pack's tasks. */
export function buildLearningStream(pack: Pick<LoadedPack, 'tasks' | 'docs'>, opts: StreamOptions = {}): LearningStream {
  const seed = opts.seed ?? 0;
  const docs = new Map(pack.docs.map((d) => [d.path, d]));
  const keyed = new Map<string, Keyed>();
  for (const t of pack.tasks) {
    const subject = taskSubject(t, docs);
    keyed.set(t.id, { t, subject, metric: taskMetric(t, subject) });
  }
  const paraphrasesOf = new Map<string, Task[]>();
  for (const t of pack.tasks) {
    const of = t.meta?.of;
    if (typeof of === 'string' && (t.type === 'paraphrase' || String(t.meta?.family ?? '').includes('paraphrase'))) {
      (paraphrasesOf.get(of) ?? paraphrasesOf.set(of, []).get(of)!).push(t);
    }
  }
  const isParaphrase = (t: Task) => typeof t.meta?.of === 'string';
  const pool = [...keyed.values()].filter((k) => k.t.suite === 'usage' && !k.t.afterUpdate && LEARNABLE_SCORINGS.has(k.t.scoring) && k.subject && k.metric && !isParaphrase(k.t));
  const byMetric = new Map<string, Keyed[]>();
  const bySubject = new Map<string, Keyed[]>();
  for (const k of pool) {
    (byMetric.get(k.metric!) ?? byMetric.set(k.metric!, []).get(k.metric!)!).push(k);
    const s = k.subject!.toLowerCase();
    (bySubject.get(s) ?? bySubject.set(s, []).get(s)!).push(k);
  }
  const metricPartners = (k: Keyed) => (byMetric.get(k.metric!) ?? []).filter((o) => o.t.id !== k.t.id && !sameSubject(o.subject, k.subject));
  const subjectPartners = (k: Keyed) => (bySubject.get(k.subject!.toLowerCase()) ?? []).filter((o) => o.t.id !== k.t.id && o.metric !== k.metric);
  const periodPartners = (k: Keyed) => (byMetric.get(k.metric!) ?? []).filter((o) => o.t.id !== k.t.id && sameSubject(o.subject, k.subject) && o.t.question !== k.t.question);
  const updateTasks = pack.tasks.filter((t) => t.afterUpdate);
  const available = {
    pool: pool.length,
    paraphrase: pool.filter((k) => paraphrasesOf.has(k.t.id)).length,
    nearMetric: pool.filter((k) => metricPartners(k).length > 0).length,
    nearSubject: pool.filter((k) => subjectPartners(k).length > 0).length,
    nearPeriod: pool.filter((k) => periodPartners(k).length > 0).length,
    far: 0,
    update: updateTasks.length,
  };

  // cold: the questions with the most to pair first (a paraphrase, then a near partner), in seeded order within each
  const want = Math.max(1, opts.cold ?? 30);
  const score = (k: Keyed) => (paraphrasesOf.has(k.t.id) ? 2 : 0) + (metricPartners(k).length || subjectPartners(k).length || periodPartners(k).length ? 1 : 0);
  const ordered = bySeed(pool, `${seed}|cold`, (k) => k.t.id).sort((a, b) => score(b) - score(a));
  const used = new Set<string>();
  const cold: { k: Keyed; near: { k: Keyed; cls: LearningClass } | null }[] = [];
  for (const k of ordered) {
    if (cold.length >= want) break;
    if (used.has(k.t.id)) continue;
    used.add(k.t.id);
    const pick = (cands: Keyed[], cls: LearningClass) => {
      // a question with paraphrases of its own is kept for the cold set, where they pair with it
      const free = bySeed(cands.filter((o) => !used.has(o.t.id)), `${seed}|near|${k.t.id}`, (o) => o.t.id)
        .sort((a, b) => Number(paraphrasesOf.has(a.t.id)) - Number(paraphrasesOf.has(b.t.id)));
      return free.length ? { k: free[0], cls } : null;
    };
    const near = pick(metricPartners(k), 'near-metric') ?? pick(subjectPartners(k), 'near-subject') ?? pick(periodPartners(k), 'near-period');
    if (near) used.add(near.k.t.id);
    cold.push({ k, near });
  }
  const coldSubjects = new Set(cold.map((c) => c.k.subject!.toLowerCase()));
  const coldMetrics = new Set(cold.map((c) => c.k.metric!));
  const coldDocs = new Set(cold.flatMap((c) => evidenceDocs(c.k.t)));
  const farPool = pool.filter((k) => !used.has(k.t.id) && !coldSubjects.has(k.subject!.toLowerCase()) && !coldMetrics.has(k.metric!) && !evidenceDocs(k.t).some((d) => coldDocs.has(d)));
  available.far = farPool.length;
  const farWant = Math.max(1, opts.far ?? Math.ceil(cold.length / 2));
  const far = bySeed(farPool, `${seed}|far`, (k) => k.t.id).slice(0, farWant);

  const tasks: Task[] = [];
  const mk = (base: Task, id: string, meta: LearningMeta, over: Partial<Task> = {}): Task => ({
    ...base, ...over, id, suite: 'learning', meta: { ...(base.meta ?? {}), learning: meta },
  });
  const coldId = (t: Task) => `L-cold-${t.id}`;
  for (const { k } of cold) tasks.push(mk(k.t, coldId(k.t), { phase: 'cold', class: 'cold', base: k.t.id, of: null, subject: k.subject, metric: k.metric }));
  for (const { k, near } of cold) {
    tasks.push(mk(k.t, `L-same-${k.t.id}`, { phase: 'warm', class: 'same', base: k.t.id, of: coldId(k.t), subject: k.subject, metric: k.metric }));
    const pps = paraphrasesOf.get(k.t.id) ?? [];
    if (pps.length) {
      for (const pp of pps) tasks.push(mk(pp, `L-para-${pp.id}`, { phase: 'warm', class: 'paraphrase', base: pp.id, of: coldId(k.t), subject: k.subject, metric: k.metric }));
    } else if (opts.paraphraser) {
      const q = opts.paraphraser.paraphrase(k.t);
      if (q && q !== k.t.question) {
        tasks.push(mk(k.t, `L-para-${k.t.id}`, { phase: 'warm', class: 'paraphrase', base: k.t.id, of: coldId(k.t), subject: k.subject, metric: k.metric, paraphraser: opts.paraphraser.id }, { question: q }));
      }
    }
    if (near) tasks.push(mk(near.k.t, `L-near-${near.k.t.id}`, { phase: 'warm', class: near.cls, base: near.k.t.id, of: coldId(k.t), subject: near.k.subject, metric: near.k.metric }));
  }
  far.forEach((k, i) => {
    const pair = cold[i % cold.length]?.k.t;
    tasks.push(mk(k.t, `L-far-${k.t.id}`, { phase: 'warm', class: 'far', base: k.t.id, of: pair ? coldId(pair) : null, subject: k.subject, metric: k.metric }));
  });
  // update: the pack's update tasks about a cold question's subject, attribute or documents
  for (const t of updateTasks) {
    const k = keyed.get(t.id)!;
    const related = cold.find((c) => sameSubject(c.k.subject, k.subject) || (k.metric && c.k.metric === k.metric) || evidenceDocs(t).some((d) => evidenceDocs(c.k.t).includes(d)));
    if (!related) continue;
    tasks.push(mk(t, `L-upd-${t.id}`, { phase: 'update', class: 'update', base: t.id, of: coldId(related.k.t), subject: k.subject, metric: k.metric }));
  }
  const counts = Object.fromEntries(LEARNING_CLASSES.map((c) => [c, 0])) as Record<LearningClass, number>;
  for (const t of tasks) counts[learningMeta(t)!.class]++;
  return { tasks, counts, available };
}

/**
 * The order a run asks the stream in: every cold question first, then every
 * warm one, each phase shuffled by `orderSeed` (two seeds, two orders: an
 * order effect shows as a difference between them); update questions by their
 * batch, shuffled within it.
 */
export function learningOrder(tasks: Task[], orderSeed: string | number): { before: Task[]; byBatch: Map<string, Task[]> } {
  const phase = (p: LearningMeta['phase']) => tasks.filter((t) => learningMeta(t)?.phase === p);
  const before = [...bySeed(phase('cold'), `${orderSeed}|cold`, (t) => t.id), ...bySeed(phase('warm'), `${orderSeed}|warm`, (t) => t.id)];
  const byBatch = new Map<string, Task[]>();
  for (const t of bySeed(phase('update'), `${orderSeed}|update`, (t) => t.id)) {
    const b = t.afterUpdate ?? '';
    (byBatch.get(b) ?? byBatch.set(b, []).get(b)!).push(t);
  }
  return { before, byBatch };
}

/**
 * Write a learning pack: the source pack's corpus, gold and updates as they
 * are, its tasks replaced by the stream (tasks/learning.jsonl). Its id is the
 * source's with `-learning`: a build of its own, since a learning system
 * writes into the knowledge base it answers from.
 */
export function writeLearningPack(src: LoadedPack, outDir: string, opts: StreamOptions = {}): LearningStream {
  const stream = buildLearningStream(src, opts);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of fs.readdirSync(src.dir, { withFileTypes: true })) {
    if (e.name === 'tasks' || e.name === 'pack.json') continue;
    fs.cpSync(path.join(src.dir, e.name), path.join(outDir, e.name), { recursive: true });
  }
  writeJsonl(path.join(outDir, 'tasks', 'learning.jsonl'), stream.tasks);
  writeManifest(outDir, {
    ...src.manifest,
    id: `${src.manifest.id}-learning`.slice(0, 80),
    title: `${src.manifest.title} — learning stream`,
    description: `The learning suite (docs/design/38 §4.3) over ${src.manifest.id}: ${stream.counts.cold} cold questions, then ${stream.counts.same} asked again, ${stream.counts.paraphrase} paraphrases, ${stream.counts['near-metric'] + stream.counts['near-subject'] + stream.counts['near-period']} near and ${stream.counts.far} far questions, and ${stream.counts.update} after the updates.`,
    builder: { recipe: 'learning', options: { from: src.manifest.id, cold: opts.cold ?? 30, far: opts.far ?? null, seed: opts.seed ?? 0, paraphraser: opts.paraphraser?.id ?? null }, builtAt: new Date().toISOString() },
    stats: { ...(src.manifest.stats ?? {}), tasks: stream.tasks.length },
  });
  return stream;
}
