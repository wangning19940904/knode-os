import fs from 'node:fs';
import path from 'node:path';
import type { LoadedPack } from './pack.js';
import { ABSENT_COVERAGE, absentCorpus, bestPassage } from './packs/absent.js';
import { lexicalTokens } from './packs/separation.js';
import { declines } from './score/values.js';
import { extractFinalAnswer } from './metrics/text.js';
import type { Task } from './types.js';

/**
 * Pack lint (docs/design/33 §4, D7): what makes a benchmark measure its own
 * artifacts instead of the systems, checked without a model before a run
 * spends anything. Every rule found a real fault in the 2026-11 separation
 * run or is one of design 33's rules for its question families:
 *
 * - class-word       a question word that occurs in only one class (`kind`) of document, none of the question's
 *                    evidence of that class: it sends a keyword search to the wrong documents (the "（第N事业部）"
 *                    prefix occurred only in the PMO summaries)
 * - ambiguous-subject a name in the question that is the name, or a part of the name, of more than one entity of
 *                    the pack's alias gold, with nothing in the question to tell them apart ("平台组" when ten
 *                    divisions have one): the gold is not unique under the question's own words
 * - file-names       a question whose gold the file names alone give (a path segment, or a count of files)
 * - family-minimum   a family (`meta.family`) or a hop stratum (`meta.stratum`) with fewer questions than the
 *                    pack's manifest asks for (`lint.families`, `lint.strata`)
 * - duplicate-text   two questions with the same text and different gold
 * - hop-shortcut     a multi-hop question whose answer stands on one line of some document beside a rare word of
 *                    the question: one grep skips the chain
 * - abstain-in-corpus an "unanswerable" question (scoring abstain) whose distinctive terms stand together in one
 *                    passage of a document (packs/absent.ts): a drafted unanswerable question about a detail the
 *                    corpus does state, so a right answer scores 0 (medicine-us "How many participants were
 *                    randomized in SURMOUNT-CN" — pubmed/38819983.md says 210). Questions a recipe plants from its
 *                    own world model (`meta.subtype` unanswerable-*: a namesake on a third team, a false premise)
 *                    name corpus terms on purpose and are left out: the recipe knows the fact does not exist; so
 *                    is a task a person has checked against the passage (`meta.absenceChecked: true`)
 *
 * Words are the separation families' tokens (two-character sequences in
 * Chinese without a function character, content words in English); "rare" is
 * a document frequency of at most 0.5% of the corpus (at least 2 documents).
 */

export const LINT_RULES = ['class-word', 'ambiguous-subject', 'file-names', 'family-minimum', 'duplicate-text', 'hop-shortcut', 'abstain-in-corpus'] as const;
export type LintRule = (typeof LINT_RULES)[number];
/**
 * Rules that ask for a look rather than stop a run: `abstain-in-corpus` is lexical, and on the 2026-11 packs
 * a third of what it flags was answered by the run's systems while the rest were look-alikes (the subject is
 * in the corpus, the asked value is not). Their findings are reported before a run, which goes ahead.
 */
export const ADVISORY_RULES: ReadonlySet<LintRule> = new Set(['abstain-in-corpus']);

export interface LintFinding { rule: LintRule; task?: string; message: string }
export interface LintResult {
  pack: string;
  findings: LintFinding[];
  counts: Record<LintRule, number>;
  /** Questions by family (`meta.family`, else the task type) and by stratum. */
  families: Record<string, number>;
  strata: Record<string, number>;
  docs: number;
  tasks: number;
}

/**
 * Chinese two-character sequences with a function character in them straddle words ("起事" of "几起事故",
 * "一的" of "周一的"): no one searches for them, so the word rules leave them out.
 */
const ZH_FUNCTION = /[的了是个起在有和这那也就都与着或被把给从到对为以之其几么吗呢里一]/;
const wordish = (lang: 'zh' | 'en', tok: string) => lang === 'en' || !ZH_FUNCTION.test(tok);

const langOf = (t: Task, pack: LoadedPack): 'zh' | 'en' => ((t.lang ?? pack.manifest.languages[0]) === 'zh' ? 'zh' : 'en');
const familyOf = (t: Task) => (typeof t.meta?.family === 'string' ? t.meta.family : t.type);

/** The gold of a task as one comparable string. */
export function goldKey(t: Task): string {
  return JSON.stringify([t.scoring, t.answer ?? null, [...(t.answers ?? [])].sort(), (t.items ?? []).map((i) => i.label).sort(), t.choices ?? null]);
}

/** A line holds an answer form: a number only as a whole number ("20" is not in "R-2032"). */
function holdsForm(line: string, form: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(form)) return line.includes(form);
  return new RegExp(`(?<![\\w.-])${form.replace('.', '\\.')}(?![\\w.])`).test(line);
}

/** The forms an answer gives its gold in: the answer, its variants, set items' labels. */
function answerForms(t: Task): string[] {
  return [t.answer ?? '', ...(t.answers ?? [])].map((x) => x.trim()).filter((x) => x.length >= 2);
}

interface Corpus {
  n: number;
  kinds: string[];
  /** For each question token: the documents holding it (only up to the rare limit; `common` past it) and the kinds. */
  df: Map<string, { docs: number[]; kinds: Set<string>; common: boolean; count: number }>;
  paths: string[];
  kindOf: string[];
}

/** One pass over the corpus counting only the tokens the questions use. */
function scanCorpus(pack: LoadedPack, wanted: Map<'zh' | 'en', Set<string>>, rareLimit: number): Corpus {
  const df: Corpus['df'] = new Map();
  for (const set of wanted.values()) for (const tok of set) df.set(tok, { docs: [], kinds: new Set(), common: false, count: 0 });
  const zh = wanted.get('zh') ?? new Set<string>();
  const en = wanted.get('en') ?? new Set<string>();
  const paths = pack.docs.map((d) => d.path);
  const kindOf = pack.docs.map((d) => d.kind ?? 'document');
  pack.docs.forEach((d, i) => {
    const file = path.join(pack.dir, 'corpus', d.path);
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    const seen = new Set<string>();
    if (zh.size) {
      const t = text.normalize('NFKC');
      for (let k = 0; k + 1 < t.length; k++) {
        const c0 = t.charCodeAt(k);
        if (c0 < 0x3400 || c0 > 0x9fff) continue;
        const c1 = t.charCodeAt(k + 1);
        if (c1 < 0x3400 || c1 > 0x9fff) continue;
        const bi = t.slice(k, k + 2);
        if (zh.has(bi)) seen.add(bi);
      }
    }
    if (en.size) for (const w of lexicalTokens('en', text)) if (en.has(w)) seen.add(w);
    for (const tok of seen) {
      const e = df.get(tok)!;
      e.count++;
      e.kinds.add(kindOf[i]);
      if (!e.common) {
        e.docs.push(i);
        if (e.docs.length > rareLimit) {
          e.common = true;
          e.docs = [];
        }
      }
    }
  });
  return { n: pack.docs.length, kinds: [...new Set(kindOf)], df, paths, kindOf };
}

export function lintPack(pack: LoadedPack): LintResult {
  const findings: LintFinding[] = [];
  const add = (rule: LintRule, message: string, task?: string) => findings.push({ rule, message, ...(task ? { task } : {}) });
  const N = pack.docs.length;
  const rare = Math.max(2, Math.floor(N * 0.005));
  const tasks = pack.tasks;
  const tokensOf = new Map<string, Set<string>>();
  const wanted = new Map<'zh' | 'en', Set<string>>();
  for (const t of tasks) {
    const l = langOf(t, pack);
    const toks = new Set([...lexicalTokens(l, t.question)].filter((x) => wordish(l, x)));
    tokensOf.set(t.id, toks);
    const w = wanted.get(l) ?? wanted.set(l, new Set()).get(l)!;
    for (const x of toks) w.add(x);
  }
  // keep postings up to the rare limit for the shortcut rule, kinds for every token
  const corpus = scanCorpus(pack, wanted, rare);
  const kindByPath = new Map(pack.docs.map((d) => [d.path, d.kind ?? 'document']));

  /* class-word */
  if (corpus.kinds.length > 1) {
    for (const t of tasks) {
      if (t.scoring === 'abstain' || !t.evidence.length) continue;
      const evKinds = new Set(t.evidence.map((e) => kindByPath.get(e.doc)).filter(Boolean) as string[]);
      if (!evKinds.size) continue;
      const bad = [...tokensOf.get(t.id)!].filter((tok) => {
        const e = corpus.df.get(tok);
        return e && e.count > 0 && e.kinds.size === 1 && !evKinds.has([...e.kinds][0]);
      });
      if (bad.length) add('class-word', `"${bad.slice(0, 4).join('", "')}" occur${bad.length === 1 ? 's' : ''} only in ${[...corpus.df.get(bad[0])!.kinds][0]} documents, none of its evidence`, t.id);
    }
  }

  /* ambiguous-subject */
  if (pack.aliases.length) {
    const byString = new Map<string, Set<number>>();
    pack.aliases.forEach((a, i) => {
      for (const s of a.aliases) if (s.length >= 2) (byString.get(s) ?? byString.set(s, new Set()).get(s)!).add(i);
    });
    const strings = [...byString.keys()].sort((a, b) => b.length - a.length);
    for (const t of tasks) {
      if (Number(t.meta?.readings ?? 0) > 1 || t.type === 'ambiguous' || t.type === 'unanswerable') continue;
      const q = t.question;
      // the names the question holds, longest first, none inside another found name
      const found: string[] = [];
      for (const s of strings) if (q.includes(s) && !found.some((f) => f.includes(s))) found.push(s);
      for (const s of found) {
        const clusters = new Set<number>();
        for (const [str, ids] of byString) if (str.includes(s)) for (const id of ids) clusters.add(id);
        const kinds = new Map<string, number[]>();
        for (const id of clusters) {
          const k = pack.aliases[id].kind ?? '';
          (kinds.get(k) ?? kinds.set(k, []).get(k)!).push(id);
        }
        for (const [kind, ids] of kinds) {
          if (ids.length < 2) continue;
          // told apart by a context term in the question (a team for a namesake or a setting)
          // (a context term counts only where the question does not hold it inside a longer name: "平台组" in "二部平台组")
          const named = (c: string) => Boolean(c) && q.includes(c) && !found.some((f) => f !== c && f.includes(c));
          const told = ids.filter((id) => (pack.aliases[id].context ?? []).some(named));
          if (told.length === 1) continue;
          add('ambiguous-subject', `"${s}" names ${ids.length} ${kind || 'entities'} (${ids.slice(0, 3).map((id) => pack.aliases[id].canonical).join(', ')}${ids.length > 3 ? ', …' : ''})`, t.id);
          break;
        }
      }
    }
  }

  /* file-names */
  const segments = new Set(corpus.paths.flatMap((p) => p.split('/')).flatMap((s) => [s, s.replace(/\.[a-z]+$/, '')]));
  const dirCounts = new Map<string, number>();
  for (const p of corpus.paths) {
    const d = path.dirname(p);
    dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
  }
  for (const t of tasks) {
    const forms = answerForms(t);
    if ((t.scoring === 'value' || t.scoring === 'exact' || t.scoring === 'judge') && forms.length && forms.some((f) => segments.has(f))) {
      const toks = tokensOf.get(t.id)!;
      const linked = corpus.paths.some((p) => p.split('/').some((s) => forms.includes(s) || forms.includes(s.replace(/\.[a-z]+$/, ''))) && [...toks].some((tok) => p.includes(tok)));
      if (linked) add('file-names', `its answer "${forms.find((f) => segments.has(f))}" is a path segment beside a word of the question`, t.id);
    }
    if (t.scoring === 'set' && t.items?.length && t.items.every((it) => [it.label, ...it.aliases].some((x) => segments.has(x)))) add('file-names', 'every gold item is a path segment', t.id);
    if (t.scoring === 'count' && t.answer) {
      const toks = [...tokensOf.get(t.id)!];
      // the folder's own name, not a parent's: "周报" in a question names every weekly folder at once
      const dir = [...dirCounts].find(([d, n]) => {
        const own = path.basename(d);
        return n === Number(t.answer) && own.length >= 2 && (t.question.includes(own) || toks.some((tok) => own.includes(tok)));
      });
      if (dir) add('file-names', `the count ${t.answer} is the number of files in ${dir[0]}/, a folder the question names`, t.id);
    }
  }

  /* family-minimum */
  const families: Record<string, number> = {};
  const strata: Record<string, number> = {};
  for (const t of tasks) {
    families[familyOf(t)] = (families[familyOf(t)] ?? 0) + 1;
    if (typeof t.meta?.stratum === 'string') strata[t.meta.stratum] = (strata[t.meta.stratum] ?? 0) + 1;
  }
  const minimum = pack.manifest.lint;
  for (const [f, n] of Object.entries(minimum?.families ?? {})) if ((families[f] ?? 0) < n) add('family-minimum', `family ${f} has ${families[f] ?? 0} questions, fewer than ${n}`);
  for (const [s, n] of Object.entries(minimum?.strata ?? {})) if ((strata[s] ?? 0) < n) add('family-minimum', `stratum ${s} has ${strata[s] ?? 0} questions, fewer than ${n}`);

  /* duplicate-text */
  const byText = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = `${t.lang ?? ''}|${t.afterUpdate ?? ''}|${t.question.trim()}`;
    (byText.get(k) ?? byText.set(k, []).get(k)!).push(t);
  }
  for (const [, ts] of byText) if (ts.length > 1 && new Set(ts.map(goldKey)).size > 1) add('duplicate-text', `${ts.length} questions share this text with different gold: ${ts.map((x) => x.id).join(', ')}`, ts[0].id);

  /* hop-shortcut */
  const lineCache = new Map<number, string[]>();
  const linesOf = (i: number) => {
    if (!lineCache.has(i)) {
      const file = path.join(pack.dir, 'corpus', corpus.paths[i]);
      lineCache.set(i, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []);
      if (lineCache.size > 2000) lineCache.delete(lineCache.keys().next().value!);
    }
    return lineCache.get(i)!;
  };
  for (const t of tasks) {
    const hops = Number(t.meta?.hops ?? 0);
    if (hops < 2 && t.type !== 'deep-hop' && t.type !== 'nonlexical-hop' && t.type !== 'multi-hop') continue;
    const forms = [...answerForms(t), ...(t.keypoints ?? []).filter((k) => k.length >= 2)];
    if (!forms.length) continue;
    const rareToks = [...tokensOf.get(t.id)!].filter((tok) => {
      const e = corpus.df.get(tok);
      return e && e.count > 0 && !e.common;
    });
    let hit: { tok: string; doc: string } | undefined;
    for (const tok of rareToks) {
      for (const i of corpus.df.get(tok)!.docs) {
        const l = linesOf(i).find((x) => lexicalTokens(langOf(t, pack), x).has(tok) && forms.some((f) => holdsForm(x, f)));
        if (l) {
          hit = { tok, doc: corpus.paths[i] };
          break;
        }
      }
      if (hit) break;
    }
    if (hit) add('hop-shortcut', `its answer stands on a line of ${hit.doc} beside the question's rare word "${hit.tok}"`, t.id);
  }

  /* abstain-in-corpus */
  for (const f of abstainInCorpus(pack)) add('abstain-in-corpus', f.message, f.task);

  const counts = Object.fromEntries(LINT_RULES.map((r) => [r, findings.filter((f) => f.rule === r).length])) as Record<LintRule, number>;
  return { pack: pack.manifest.id, findings, counts, families, strata, docs: N, tasks: tasks.length };
}

/** An abstain question a recipe planted from its own world model: it names corpus terms on purpose. */
export const plantedAbstain = (t: Task) => String(t.meta?.subtype ?? '').startsWith('unanswerable-');

/** The abstain tasks of a pack whose distinctive terms co-occur in one passage (packs/absent.ts), best passage first. */
export function abstainInCorpus(pack: LoadedPack, threshold = ABSENT_COVERAGE): { task: string; doc: string; coverage: number; message: string }[] {
  const asked = pack.tasks.filter((t) => t.scoring === 'abstain' && !plantedAbstain(t) && t.meta?.absenceChecked !== true);
  if (!asked.length) return [];
  const docs = pack.docs.flatMap((d) => {
    const file = path.join(pack.dir, 'corpus', d.path);
    return fs.existsSync(file) ? [{ path: d.path, text: fs.readFileSync(file, 'utf8') }] : [];
  });
  const corpus = absentCorpus(docs, asked.map((t) => t.question));
  return asked.flatMap((t) => {
    const hit = bestPassage(t.question, corpus);
    if (!hit || hit.coverage < threshold) return [];
    return [{ task: t.id, doc: hit.doc, coverage: hit.coverage, message: `${Math.round(hit.coverage * 100)}% of its weighted terms stand in one passage of ${hit.doc} ("${hit.terms.slice(0, 4).join('", "')}"): check the corpus does not answer it` }];
  });
}

/* ------------------------------ checks against a run ------------------------------ */

/** What a check against a run reads of an answer record (answers.jsonl). */
export interface RunAnswer { system: string; taskId: string; text?: string; finalAnswer?: string; citations?: { doc: string }[] }
/** What it reads of a score record (scores.jsonl). */
export interface RunScore { system: string; taskId: string; metric: string; value: number | null }

export interface AbstainAnswered {
  task: string;
  question: string;
  /** Systems asked, systems that answered instead of declining. */
  asked: string[];
  answered: string[];
  /** The document most answering systems cite, and how many cite it. */
  doc: string;
  citing: number;
  /** Planted by its recipe from the world model (`plantedAbstain`): the fact does not exist, so a "yes" is the systems' or the judge's error, not the gold's. */
  planted: boolean;
  message: string;
}

/**
 * The second signal for abstain tasks (rule `abstain-answered`): a run's
 * answers. An abstain task that at least `minSystems` systems answer — not
 * declining — while citing the same document is suspect: independent systems
 * rarely invent the same answer from the same source. "Answered" is the
 * judge's `abstain_correct` 0 where the run scored it, else an answer that
 * does not decline (score/values.ts `declines`).
 */
export function abstainAnswered(pack: LoadedPack, answers: RunAnswer[], scores: RunScore[] = [], minSystems = 2): AbstainAnswered[] {
  const asked = new Map(pack.tasks.filter((t) => t.scoring === 'abstain').map((t) => [t.id, t]));
  const judged = new Map<string, number>();
  for (const s of scores) if (s.metric === 'abstain_correct' && asked.has(s.taskId) && typeof s.value === 'number') judged.set(`${s.taskId}|${s.system}`, s.value);
  const byTask = new Map<string, RunAnswer[]>();
  for (const a of answers) if (asked.has(a.taskId)) (byTask.get(a.taskId) ?? byTask.set(a.taskId, []).get(a.taskId)!).push(a);
  const out: AbstainAnswered[] = [];
  for (const [id, list] of byTask) {
    const answered = list.filter((a) => {
      const v = judged.get(`${id}|${a.system}`);
      return v !== undefined ? v === 0 : !declines(a.finalAnswer ?? extractFinalAnswer(a.text ?? ''));
    });
    const cites = new Map<string, Set<string>>();
    for (const a of answered) for (const c of a.citations ?? []) (cites.get(c.doc) ?? cites.set(c.doc, new Set()).get(c.doc)!).add(a.system);
    const top = [...cites].sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0]))[0];
    if (!top || top[1].size < minSystems) continue;
    const systems = [...new Set(list.map((a) => a.system))].sort();
    out.push({
      task: id, question: asked.get(id)!.question, asked: systems, answered: [...new Set(answered.map((a) => a.system))].sort(), doc: top[0], citing: top[1].size,
      planted: plantedAbstain(asked.get(id)!),
      message: `${top[1].size} of ${systems.length} systems answered it citing ${top[0]}${plantedAbstain(asked.get(id)!) ? ' (planted: check the answers and the judge, not the gold)' : ''}`,
    });
  }
  return out.sort((a, b) => b.citing - a.citing || a.task.localeCompare(b.task));
}

/** A lint result as lines for the console: counts by rule, then up to `examples` findings of each. */
export function formatLint(r: LintResult, examples = 5): string {
  const out = [`${r.pack}: ${r.docs} documents, ${r.tasks} tasks — ${r.findings.length ? `${r.findings.length} finding(s)` : 'clean'}`];
  for (const rule of LINT_RULES) {
    const fs_ = r.findings.filter((f) => f.rule === rule);
    if (!fs_.length) continue;
    out.push(`  ${rule}: ${fs_.length}`);
    for (const f of fs_.slice(0, examples)) out.push(`    ${f.task ? `${f.task}: ` : ''}${f.message}`);
  }
  return out.join('\n');
}

/**
 * `eval run`'s check before it spends anything: every pack linted, and a report of the ones with findings.
 * `ok` false stops the run (unless --no-lint); findings of advisory rules alone are reported and do not.
 */
export function lintBeforeRun(packs: LoadedPack[]): { ok: boolean; report: string; results: LintResult[] } {
  const results = packs.map(lintPack);
  const bad = results.filter((r) => r.findings.some((f) => !ADVISORY_RULES.has(f.rule)));
  const advised = results.filter((r) => !bad.includes(r) && r.findings.length);
  const parts = [
    ...(bad.length ? [`${bad.map((r) => formatLint(r, 3)).join('\n')}\n\npack lint: ${bad.map((r) => r.pack).join(', ')} — fix the pack, or pass --no-lint to run it as it is`] : []),
    ...(advised.length ? [`${advised.map((r) => formatLint(r, 3)).join('\n')}\n\npack lint (advisory, the run goes ahead): ${advised.map((r) => r.pack).join(', ')} — check each flagged task, and mark one the corpus does not answer meta.absenceChecked`] : []),
  ];
  return { ok: !bad.length, report: parts.join('\n\n'), results };
}
