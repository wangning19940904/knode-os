import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { planCodebase } from '../../ingest/codebase/codebases.js';
import { codeLanguageOf, skipReason } from '../../ingest/codebase/files.js';
import { codebaseName } from '../../ingest/codebase/git.js';
import { extractSymbols } from '../../ingest/codebase/symbols.js';
import { EVAL_HOME, PackIssues } from '../pack.js';
import type { GoldItem, Task } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * code-localization (docs/design/37 §2): given a change request, name the
 * files that change. Built from a repository's own history, with no model:
 *
 * - a clone with history and without blobs (`git clone --filter=blob:none`)
 *   under `~/knode-eval/sources/git/<name>`, checked out at one **base**
 *   commit; the corpus is that tree as design 25 D2 keeps it (`planCodebase`),
 *   under `corpus/codebase/<name>/`;
 * - one task per later first-parent commit (within `window` of the base) that
 *   passes the filters below; the question is its commit message, unchanged,
 *   inside a fixed frame; the gold is the kept files it touched, one item per
 *   path, matched by alias and scored by set F1;
 * - `meta.stratum` says how much of the gold the message already gives away:
 *   `named` (a gold file's path or basename), `symbol` (an identifier a gold
 *   file defines at the base), `plain` otherwise.
 *
 * Filters, each counted in `gold/profile.json`: a merge, a revert, a release
 * or a dependency bump is left out; the message's body (after the subject,
 * without trailers) is at least `minBody` characters; the commit touches 2 to
 * 15 kept files, every one of which exists at the base (a file created later
 * cannot be found) and is in the corpus; and at least one of them is source
 * code (not documentation, configuration or a test).
 *
 * Nothing dated after the base enters the corpus (`manifest.cutoff`, checked
 * by `validatePack`): no later commit, no changelog written after it. The
 * base is the latest commit that leaves a full window of later commits.
 */

export const CODE_LOCALIZATION_DEFAULTS = { window: 300, minBody: 80, minFiles: 2, maxFiles: 15, minPlain: 60, maxItems: 20 } as const;

export type Stratum = 'named' | 'symbol' | 'plain';

export interface CommitRecord {
  sha: string;
  parents: string[];
  date: string;
  message: string;
  /** Paths the commit touched, with git's status letter (A, M, D, T). */
  changes: { status: string; path: string }[];
}

const git = (dir: string, args: string[], maxBuffer = 1 << 30): string =>
  execFileSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });

const REC = '\x1e';
const FIELD = '\x1f';

/** First-parent commits in (base, tip], oldest first, with what each touched (no rename detection: that would fetch blobs). */
export function readCommits(dir: string, base: string, tip: string): CommitRecord[] {
  const out = git(dir, ['log', '--first-parent', '--reverse', '--no-renames', '--name-status', `--format=${REC}%H${FIELD}%P${FIELD}%cI${FIELD}%B${FIELD}`, `${base}..${tip}`]);
  return out.split(REC).slice(1).map((chunk) => {
    const [sha, parents, date, message, rest] = chunk.split(FIELD);
    const changes = (rest ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [status, ...p] = l.split('\t');
      return { status: status[0], path: p.join('\t') };
    });
    return { sha, parents: parents.split(' ').filter(Boolean), date, message: message.replace(/\s+$/, ''), changes };
  });
}

/** Trailer lines git and GitHub add (Co-authored-by, Signed-off-by …): not part of what the change says. */
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|change-id|reviewed-on):/i;

/** The body of a commit message: after the subject line, trailers removed, trimmed. */
export function messageBody(message: string): string {
  return message.split('\n').slice(1).filter((l) => !TRAILER.test(l.trim())).join('\n').trim();
}

/** A commit whose subject says it is a merge, a revert, a release or a dependency bump. */
export function isHousekeeping(subject: string): string | null {
  const s = subject.trim();
  if (/^merge\b/i.test(s)) return 'merge';
  if (/^revert\b/i.test(s) || /^"?revert "/i.test(s)) return 'revert';
  if (/^(chore|build|ci)\((release|deps?|dependencies)\)/i.test(s) || /^(chore|build)(\(.*\))?:\s*(release|bump|update (the )?dependenc|upgrade dependenc)/i.test(s)) return /release/i.test(s) ? 'release' : 'dependency';
  if (/^(release|bump|prepare release|publish)\b/i.test(s) || /^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(s) || /^(release|version)[: ]+v?\d/i.test(s)) return /bump/i.test(s) ? 'dependency' : 'release';
  if (/^(bump|update|upgrade)\s+\S+\s+(from|to)\s+v?\d/i.test(s) || /^(fix|chore)\(deps?\)/i.test(s)) return 'dependency';
  return null;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures?|snapshots?|e2e)(\/|$)|(^|\/)test_[^/]*$|[._-](test|tests|spec)\.[a-z0-9]+$|_test\.(go|rs|py)$|\.snap$/i;

/** Source code, not documentation, configuration or a test. */
export function isSourceFile(rel: string): boolean {
  const lang = codeLanguageOf(rel);
  return Boolean(lang && lang.kind === 'code' && !TEST_PATH.test(rel));
}

/** A kept file by its path (design 25 D2's path rules; size and content are checked against the base tree). */
export const keptPath = (rel: string) => skipReason(rel) === null;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` hold `term` not inside a longer path or identifier? */
function holdsLiteral(text: string, term: string): boolean {
  return new RegExp(`(?<![\\w.\\-/])${escape(term)}(?![\\w\\-])`).test(text) || new RegExp(`(?<![\\w.\\-])${escape(term)}(?![\\w\\-])`).test(text);
}

/**
 * Is a defined name written in the message as code? A name counts when it is
 * at least four characters, and either shaped like an identifier (an underscore, a
 * digit, or a capital after the first letter: `apply_patch`, `ToolRouter`,
 * `MAX_TURNS`), or when the message writes it as code (in backticks, before
 * `(` or `::`). A one-word name in lower case (`run`, `session`, `Session`)
 * is otherwise an English word, and finding it in prose says nothing; a
 * name of three characters (`new`, `run`) is defined in most files and
 * never counts.
 */
export function messageNamesSymbol(message: string, name: string): boolean {
  if (name.length < 4) return false;
  const word = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  if (!word.test(message)) return false;
  if (name.length >= 4 && /[_\d]|^.+[A-Z]/.test(name)) return true;
  // inside a code span (spans taken pairwise, so prose between two spans is not one), or called, or a path of `::`
  const spans = [...message.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  if (spans.some((s) => word.test(s))) return true;
  return new RegExp(`(?<![\\w$])${escape(name)}\\s*(\\(|::)`).test(message);
}

/** The stratum of a task, and what put it there. */
export function stratumOf(message: string, gold: string[], symbolsOf: (rel: string) => string[]): { stratum: Stratum; named: string[]; symbols: string[] } {
  const named = gold.filter((p) => message.includes(p) || holdsLiteral(message, path.posix.basename(p)));
  if (named.length) return { stratum: 'named', named, symbols: [] };
  const symbols = [...new Set(gold.flatMap((p) => symbolsOf(p).filter((s) => messageNamesSymbol(message, s))))];
  if (symbols.length) return { stratum: 'symbol', named: [], symbols };
  return { stratum: 'plain', named: [], symbols: [] };
}

/** The question an agent is asked: the commit message, unchanged, inside a fixed frame. */
export function localizationQuestion(repo: string, baseDate: string, message: string): string {
  return `You have the code repository ${repo} as it was on ${baseDate.slice(0, 10)}. A change to it was later described by the commit message below. Which existing files of the repository does that change modify?\n\nCommit message:\n"""\n${message}\n"""`;
}

export interface CandidateVerdict {
  commit: CommitRecord;
  distance: number;
  /** Why it is not a task; absent when it is one. */
  reject?: string;
  /** Kept files it touched (by path rules). */
  touched: string[];
  /** Of those, the share that exist in the base tree. */
  atBase: number;
  gold?: string[];
}

/** Every commit after the base, judged against the filters (the gold where it passes). */
export function judgeCommits(
  commits: CommitRecord[], baseTree: Set<string>, corpus: Set<string>,
  opts: { window: number; minBody: number; minFiles: number; maxFiles: number },
): CandidateVerdict[] {
  return commits.map((commit, i) => {
    const distance = i + 1;
    const touched = [...new Set(commit.changes.map((c) => c.path))].filter(keptPath);
    const atBase = touched.length ? touched.filter((p) => baseTree.has(p)).length / touched.length : 0;
    const v: CandidateVerdict = { commit, distance, touched, atBase };
    const subject = commit.message.split('\n')[0] ?? '';
    if (distance > opts.window) return { ...v, reject: 'beyond the window' };
    if (commit.parents.length > 1) return { ...v, reject: 'merge' };
    const kind = isHousekeeping(subject);
    if (kind) return { ...v, reject: kind };
    if (messageBody(commit.message).length < opts.minBody) return { ...v, reject: 'short body' };
    if (touched.length < opts.minFiles) return { ...v, reject: 'too few kept files' };
    if (touched.length > opts.maxFiles) return { ...v, reject: 'too many kept files' };
    if (touched.some((p) => !baseTree.has(p))) return { ...v, reject: 'a file created after the base' };
    // a file at the base the corpus leaves out (too large, generated) cannot be named from the corpus
    const gold = touched.filter((p) => corpus.has(p));
    if (gold.length < opts.minFiles) return { ...v, reject: 'too few kept files in the corpus' };
    if (!gold.some(isSourceFile)) return { ...v, reject: 'no source file' };
    return { ...v, gold };
  });
}

/** The share of a commit's kept files present at the base, by distance from it (open question 2 of design 37). */
export function driftByDistance(verdicts: CandidateVerdict[], bucket = 50): { from: number; to: number; commits: number; atBase: number; allAtBase: number }[] {
  const rows = new Map<number, { n: number; share: number; all: number }>();
  for (const v of verdicts) {
    if (!v.touched.length || v.commit.parents.length > 1) continue;
    const b = Math.floor((v.distance - 1) / bucket);
    const r = rows.get(b) ?? rows.set(b, { n: 0, share: 0, all: 0 }).get(b)!;
    r.n++;
    r.share += v.atBase;
    if (v.atBase === 1) r.all++;
  }
  return [...rows].sort((a, b) => a[0] - b[0]).map(([b, r]) => ({ from: b * bucket + 1, to: (b + 1) * bucket, commits: r.n, atBase: r.share / r.n, allAtBase: r.all / r.n }));
}

/** Where a repository's history clone lives: `options.from`, else `~/knode-eval/sources/git/<name>`. */
export function historyClone(name: string, from?: string): string {
  return path.resolve(from ?? path.join(EVAL_HOME, 'sources', 'git', name));
}

/** The clone's default branch as fetched: `origin/HEAD`, else HEAD (a clone made without a remote). */
function defaultTip(dir: string): string {
  try {
    return git(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD']).trim();
  } catch {
    return 'HEAD';
  }
}

/** Clone with history and without blobs when there is no clone yet (a download: the recipe is `network`). */
function ensureClone(dir: string, url: string | undefined, log: (m: string) => void): void {
  if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'HEAD'))) return;
  if (!url) throw new Error(`no clone at ${dir}: pass {"url": "https://github.com/<owner>/<repo>.git"} to make one, or {"from": "<clone>"}`);
  log(`cloning ${url} (history, no blobs) into ${dir}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', url, dir], { stdio: ['ignore', 'inherit', 'inherit'] });
}

export async function buildCodeLocalizationPack(dir: string, ctx: RecipeContext): Promise<PackIssues> {
  const o = ctx.options;
  const url = typeof o.url === 'string' ? o.url : undefined;
  const repoSpec = typeof o.repository === 'string' ? o.repository : undefined;
  const name = codebaseName(typeof o.name === 'string' ? o.name : repoSpec ? repoSpec.replace('/', '-') : url ? url.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '').replace('/', '-') : '');
  const clone = historyClone(name, typeof o.from === 'string' ? o.from : undefined);
  ensureClone(clone, url ?? (repoSpec ? `https://github.com/${repoSpec}.git` : undefined), ctx.log);
  const num = (k: keyof typeof CODE_LOCALIZATION_DEFAULTS) => (Number.isInteger(Number(o[k])) && Number(o[k]) > 0 ? Number(o[k]) : CODE_LOCALIZATION_DEFAULTS[k]);
  const window = num('window');
  const filters = { window, minBody: num('minBody'), minFiles: num('minFiles'), maxFiles: num('maxFiles') };
  // the tip is the clone's default branch as fetched (origin/HEAD: HEAD itself is moved to the base
  // by the checkout below), or a commit named; the pack records both, so the same options build it again
  const tip = git(clone, ['rev-parse', typeof o.tip === 'string' ? o.tip : defaultTip(clone)]).trim();
  const base = git(clone, ['rev-parse', typeof o.base === 'string' ? o.base : `${tip}~${window}`]).trim();
  const baseDate = git(clone, ['show', '-s', '--format=%cI', base]).trim();
  ctx.log(`${name}: base ${base.slice(0, 12)} (${baseDate}), tip ${tip.slice(0, 12)}`);

  // the base tree on disk: a checkout fetches the blobs it needs in batches
  git(clone, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', base]);
  const baseTree = new Set(git(clone, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean));
  const { plan, skipped } = planCodebase(clone);
  const corpus = new Map(plan.files.map((f) => [f.rel, f]));
  ctx.log(`${name}: ${baseTree.size} files at the base, ${corpus.size} kept (${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(', ')})`);

  const commits = readCommits(clone, base, tip);
  const verdicts = judgeCommits(commits, baseTree, new Set(corpus.keys()), filters);
  const symbolCache = new Map<string, string[]>();
  const symbolsOf = (rel: string): string[] => {
    if (symbolCache.has(rel)) return symbolCache.get(rel)!;
    const lang = codeLanguageOf(rel);
    const f = corpus.get(rel);
    const names = lang && f ? [...new Set(extractSymbols(fs.readFileSync(f.abs, 'utf8'), lang.name, 2000).map((s) => s.name))] : [];
    symbolCache.set(rel, names);
    return names;
  };

  const writer = new PackWriter(dir, {
    id: typeof o.id === 'string' ? o.id : `code-localization-${name}`,
    version: 1,
    title: `Code localization: ${name}`,
    domain: 'code',
    languages: ['en'],
    description: `Change requests from ${name}'s commit messages after ${base.slice(0, 12)} (${baseDate.slice(0, 10)}); gold = the files each commit touched, scored by set F1 without a model (docs/design/37 §2).`,
    builder: { recipe: 'code-localization', options: { ...o, base, tip } },
    cutoff: baseDate,
    lint: { families: {}, strata: { plain: num('minPlain') } },
  });
  writer.addSource({ url: url ?? (repoSpec ? `https://github.com/${repoSpec}` : clone), license: 'see the repository (LICENSE at the base)', note: `history clone, base ${base}, tip ${tip}` });
  for (const f of plan.files) {
    writer.addDoc({ path: `codebase/${name}/${f.rel}`, title: `${name}/${f.rel}`, date: baseDate, kind: 'repository' }, fs.readFileSync(f.abs, 'utf8'));
  }

  const rejected: Record<string, number> = {};
  const strata: Record<Stratum, number> = { named: 0, symbol: 0, plain: 0 };
  const tasks: Task[] = [];
  for (const v of verdicts) {
    if (v.reject) {
      rejected[v.reject] = (rejected[v.reject] ?? 0) + 1;
      continue;
    }
    const gold = v.gold!;
    const s = stratumOf(v.commit.message, gold, symbolsOf);
    strata[s.stratum]++;
    const items: GoldItem[] = gold.map((p) => ({ label: p, aliases: [], weight: 1, docs: [`codebase/${name}/${p}`] }));
    const pr = v.commit.message.split('\n')[0].match(/\(#(\d+)\)\s*$/)?.[1];
    tasks.push({
      id: `${name}-${v.commit.sha.slice(0, 10)}`,
      suite: 'usage',
      type: 'localization',
      lang: 'en',
      question: localizationQuestion(name, baseDate, v.commit.message),
      evidence: gold.map((p) => ({ doc: `codebase/${name}/${p}` })),
      items,
      scoring: 'set',
      list: { match: 'alias', ordered: false, maxItems: num('maxItems'), requireDocs: false, primary: 'f1' },
      primary: s.stratum === 'plain',
      meta: {
        family: 'localization', stratum: s.stratum, repository: name, commit: v.commit.sha, base, date: v.commit.date, distance: v.distance,
        goldFiles: gold.length, source: gold.filter(isSourceFile).length, message: v.commit.message,
        ...(s.named.length ? { namedPaths: s.named } : {}), ...(s.symbols.length ? { namedSymbols: s.symbols.slice(0, 20) } : {}), ...(pr ? { pr: Number(pr) } : {}),
      },
    });
  }
  const drift = driftByDistance(verdicts);
  writer.setProfile({ repository: name, base, baseDate, tip, window, commits: commits.length, tasks: tasks.length, strata, rejected, drift, corpusFiles: corpus.size, baseFiles: baseTree.size });
  ctx.log(`${name}: ${commits.length} commits → ${tasks.length} tasks (named ${strata.named}, symbol ${strata.symbol}, plain ${strata.plain}); rejected ${Object.entries(rejected).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const t of tasks) writer.addTask(t);
  return writer.finish();
}

export function registerCodeLocalizationRecipe(): void {
  registerRecipe({
    id: 'code-localization',
    title: 'Where a change lands: files a commit touched, from a repository\'s history (design 37)',
    domain: 'code',
    network: true,
    needsAuthor: false,
    build: buildCodeLocalizationPack,
  });
}
