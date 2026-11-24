import fs from 'node:fs';
import path from 'node:path';
import { loadPack, packsDir } from '../pack.js';
import { RunStore } from '../runstore.js';
import { LEARN_LOG, LearnLogLine, NOTES_LOG, NotesLogLine } from '../systems/learning.js';
import { makeSystems } from '../systems/index.js';
import type { AnswerRecord, Task } from '../types.js';
import { LearningMeta, learningMeta, WARM_GROUPS } from './stream.js';

/**
 * The learning suite's numbers (docs/design/38 §4.3), per system, from a run's
 * answers, scores and the systems' write-back and notes logs:
 *
 *   - per warm class (same, paraphrase, near, far): the weighted-token ratio of
 *     the warm answers to their cold partners', and the correctness difference;
 *   - contamination: of the cold questions answered wrong whose answer was
 *     written back and took effect, the share whose warm repeat (same or
 *     paraphrase) gave the same wrong answer;
 *   - staleness: the share of answers after the updates that gave a value the
 *     update replaced (`stale_answer`, scored as for the update suite);
 *   - what writing back cost (its time and its indexing's tokens), added to
 *     the system's answering cost.
 *
 * Correctness is the scorer's 0–1; an answer below 0.5 counts as wrong.
 */

export interface ClassStats {
  class: string;
  /** Warm answers of the class. */
  n: number;
  /** Of them, paired with a cold answer of the same system (both answered without an error). */
  pairs: number;
  /** Sum of the warm answers' weighted tokens over the sum of their cold partners'. */
  tokenRatio: number | null;
  correctWarm: number | null;
  correctCold: number | null;
  correctDiff: number | null;
}

export interface SystemLearning {
  system: string;
  cold: { n: number; correct: number | null; weightedTokens: number };
  classes: ClassStats[];
  contamination: { coldWrong: number; writtenWrong: number; followed: number; repeats: number; rate: number | null };
  update: { n: number; correct: number | null; stale: number | null };
  writeback: { answers: number; applied: number; pending: number; skipped: number; verified: number; ms: number; embeddingTokens: number; weightedTokens: number } | null;
  notes: { answers: number; grew: number; finalChars: number } | null;
  /** Answering plus writing back, weighted tokens, over the whole stream (builds not included). */
  totalWeightedTokens: number;
}

export interface LearningReport {
  runDir: string;
  order: string | null;
  packs: string[];
  /** Questions per class in the stream. */
  counts: Record<string, number>;
  systems: SystemLearning[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s,，。.、:：;；*_`'"“”]/g, '');

function readLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

function warmGroup(cls: string): string {
  return cls.startsWith('near') ? 'near' : cls;
}

/** The learning report of a run. Its packs are found by name under the packs directory, or given (`packDirs`) when built elsewhere. */
export function learningReport(runDir: string, packDirs?: string[]): LearningReport {
  const store = new RunStore(runDir);
  const meta = store.meta();
  const packs = packDirs?.length ? packDirs : (meta?.packs ?? []).map((name) => (path.isAbsolute(name) ? name : path.join(packsDir(), name)));
  const tasks = new Map<string, Task & { learning: LearningMeta }>();
  const counts: Record<string, number> = {};
  for (const dir of packs) {
    let pack;
    try {
      pack = loadPack(dir);
    } catch {
      continue;
    }
    for (const t of pack.tasks) {
      const m = learningMeta(t);
      if (!m) continue;
      tasks.set(`${pack.manifest.id}|${t.id}`, { ...t, learning: m });
      counts[m.class] = (counts[m.class] ?? 0) + 1;
    }
  }
  const answers = store.allAnswers().filter((a) => tasks.has(`${a.pack}|${a.taskId}`) && !a.repeat);
  const correct = new Map<string, number>();
  const stale = new Map<string, number>();
  for (const s of store.allScores()) {
    if (!s.taskId || s.repeat) continue;
    if (s.metric === 'correctness' && s.value !== null) correct.set(`${s.pack}|${s.system}|${s.taskId}`, s.value);
    if (s.metric === 'stale_answer' && s.value !== null) stale.set(`${s.pack}|${s.system}|${s.taskId}`, s.value);
  }
  const order = (() => {
    const line = readLines<{ event?: string; order?: string }>(path.join(runDir, 'events.jsonl')).reverse().find((l) => l.event === 'learning order');
    return line?.order ?? null;
  })();

  const systems: SystemLearning[] = [];
  for (const system of [...new Set(answers.map((a) => a.system))].sort()) {
    const mine = answers.filter((a) => a.system === system);
    const byTask = new Map(mine.map((a) => [`${a.pack}|${a.taskId}`, a]));
    const ok = (a: AnswerRecord | undefined): a is AnswerRecord => Boolean(a && !a.error);
    const corr = (a: AnswerRecord) => correct.get(`${a.pack}|${system}|${a.taskId}`);
    const phase = (p: LearningMeta['phase']) => mine.filter((a) => tasks.get(`${a.pack}|${a.taskId}`)!.learning.phase === p);
    const cold = phase('cold').filter(ok);
    const classes: ClassStats[] = WARM_GROUPS.map((g) => {
      const warm = phase('warm').filter((a) => warmGroup(tasks.get(`${a.pack}|${a.taskId}`)!.learning.class) === g);
      const pairs = warm.filter(ok).map((w) => ({ w, c: byTask.get(`${w.pack}|${tasks.get(`${w.pack}|${w.taskId}`)!.learning.of}`) })).filter((p): p is { w: AnswerRecord; c: AnswerRecord } => ok(p.c));
      const coldTokens = pairs.reduce((n, p) => n + p.c.usage.weightedTokens, 0);
      const warmTokens = pairs.reduce((n, p) => n + p.w.usage.weightedTokens, 0);
      const scored = pairs.filter((p) => corr(p.w) !== undefined && corr(p.c) !== undefined);
      const cw = mean(scored.map((p) => corr(p.w)!));
      const cc = mean(scored.map((p) => corr(p.c)!));
      return { class: g, n: warm.length, pairs: pairs.length, tokenRatio: coldTokens > 0 ? warmTokens / coldTokens : null, correctWarm: cw, correctCold: cc, correctDiff: cw !== null && cc !== null ? cw - cc : null };
    });

    // what each cold answer left behind, by the system's own logs
    const group = (() => {
      try {
        return makeSystems([system])[0].group;
      } catch {
        return system;
      }
    })();
    const learnLog = new Map<string, LearnLogLine>();
    const notesLog = new Map<string, NotesLogLine>();
    for (const pack of new Set(mine.map((a) => a.pack))) {
      for (const l of readLines<LearnLogLine>(path.join(store.workDir(pack, group), LEARN_LOG))) learnLog.set(`${pack}|${l.task}`, l);
      for (const l of readLines<NotesLogLine>(path.join(store.workDir(pack, group), NOTES_LOG))) notesLog.set(`${pack}|${l.task}`, l);
    }
    const tookEffect = (a: AnswerRecord): boolean => {
      const l = learnLog.get(`${a.pack}|${a.taskId}`);
      if (l) return l.status === 'applied';
      const n = notesLog.get(`${a.pack}|${a.taskId}`);
      return Boolean(n && n.kept && n.after !== n.before);
    };
    const coldWrong = cold.filter((a) => (corr(a) ?? 1) < 0.5);
    const writtenWrong = coldWrong.filter(tookEffect);
    let followed = 0;
    let repeats = 0;
    for (const c of writtenWrong) {
      const coldId = `L-cold-${tasks.get(`${c.pack}|${c.taskId}`)!.learning.base}`;
      for (const w of phase('warm').filter(ok)) {
        const m = tasks.get(`${w.pack}|${w.taskId}`)!.learning;
        if (m.of !== coldId || (m.class !== 'same' && m.class !== 'paraphrase')) continue;
        repeats++;
        if ((corr(w) ?? 1) < 0.5 && norm(w.finalAnswer) === norm(c.finalAnswer)) followed++;
      }
    }
    const upd = phase('update').filter(ok);
    const learnLines = mine.map((a) => learnLog.get(`${a.pack}|${a.taskId}`)).filter((l): l is LearnLogLine => Boolean(l));
    const notesLines = mine.map((a) => notesLog.get(`${a.pack}|${a.taskId}`)).filter((l): l is NotesLogLine => Boolean(l));
    const writeback = learnLines.length ? {
      answers: learnLines.length,
      applied: learnLines.filter((l) => l.status === 'applied').length,
      pending: learnLines.filter((l) => l.status === 'pending').length,
      skipped: learnLines.filter((l) => l.status === 'skipped' || l.status === 'disabled').length,
      verified: learnLines.filter((l) => l.verified).length,
      ms: learnLines.reduce((n, l) => n + l.ms, 0),
      embeddingTokens: learnLines.reduce((n, l) => n + l.embeddingTokens, 0),
      weightedTokens: learnLines.reduce((n, l) => n + l.weightedTokens, 0),
    } : null;
    systems.push({
      system,
      cold: { n: cold.length, correct: mean(cold.map(corr).filter((v): v is number => v !== undefined)), weightedTokens: cold.reduce((n, a) => n + a.usage.weightedTokens, 0) },
      classes,
      contamination: { coldWrong: coldWrong.length, writtenWrong: writtenWrong.length, followed, repeats, rate: repeats ? followed / repeats : null },
      update: {
        n: upd.length,
        correct: mean(upd.map(corr).filter((v): v is number => v !== undefined)),
        stale: mean(upd.map((a) => stale.get(`${a.pack}|${system}|${a.taskId}`)).filter((v): v is number => v !== undefined)),
      },
      writeback,
      notes: notesLines.length ? { answers: notesLines.length, grew: notesLines.filter((l) => l.after > l.before).length, finalChars: notesLines.at(-1)!.after } : null,
      totalWeightedTokens: mine.reduce((n, a) => n + a.usage.weightedTokens, 0) + (writeback?.weightedTokens ?? 0),
    });
  }
  return { runDir, order, packs, counts, systems };
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
const signed = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);

export function learningMarkdown(r: LearningReport): string {
  const out: string[] = [];
  out.push('# Learning from use', '');
  out.push(`Run ${r.runDir}; question order ${r.order ?? '(the run\'s seed)'}. Stream: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  out.push('## Warm against cold, by class', '');
  out.push('Token ratio: the warm answers\' weighted tokens over their cold partners\'. Δ correct: warm minus cold, in points. `near` and `far` ask other questions than their partners: their differences carry the difference in difficulty, which `far` (sharing nothing with the cold set) measures.', '');
  out.push('| system | cold n | cold correct | ' + WARM_GROUPS.map((g) => `${g}: n / token ratio / Δ correct`).join(' | ') + ' |');
  out.push('| --- | --- | --- | ' + WARM_GROUPS.map(() => '---').join(' | ') + ' |');
  for (const s of r.systems) {
    out.push(`| ${s.system} | ${s.cold.n} | ${pct(s.cold.correct)} | ${s.classes.map((c) => `${c.pairs} / ${num(c.tokenRatio)} / ${signed(c.correctDiff)}`).join(' | ')} |`);
  }
  out.push('', '## Contamination, staleness and what writing back cost', '');
  out.push('| system | cold wrong | wrong & written | repeats followed | contamination | after update n | stale | written: applied / pending / skipped | write-back ms | write-back tokens | notes grew | total weighted tokens |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of r.systems) {
    const w = s.writeback;
    out.push(`| ${s.system} | ${s.contamination.coldWrong} | ${s.contamination.writtenWrong} | ${s.contamination.followed}/${s.contamination.repeats} | ${pct(s.contamination.rate)} | ${s.update.n} | ${pct(s.update.stale)} | ${w ? `${w.applied} / ${w.pending} / ${w.skipped}` : '—'} | ${w ? w.ms : '—'} | ${w ? w.weightedTokens + w.embeddingTokens : '—'} | ${s.notes ? `${s.notes.grew}/${s.notes.answers}` : '—'} | ${Math.round(s.totalWeightedTokens)} |`);
  }
  out.push('');
  return out.join('\n');
}

/** Write learning.json and learning.md into the run directory. */
export function writeLearningReport(runDir: string, packDirs?: string[]): { json: string; md: string; report: LearningReport } {
  const report = learningReport(runDir, packDirs);
  const json = path.join(runDir, 'learning.json');
  const md = path.join(runDir, 'learning.md');
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  fs.writeFileSync(md, learningMarkdown(report));
  return { json, md, report };
}
