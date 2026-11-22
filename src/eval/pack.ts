import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CORPUS_TASK_MIN_DOCS, CORPUS_TASK_TYPES, CorpusDoc, CorpusDocSchema, DEEP_HOP_MIN, GoldAlias, GoldAliasSchema, GoldFact, GoldFactSchema,
  GoldLink, GoldLinkSchema, PackManifest, PackManifestSchema, STRUCTURED_MIN_DOCS, Task, TaskSchema,
} from './types.js';
import { evalTempDir } from './tmp.js';

/**
 * Benchmark packs on disk (docs/design/23 §1).
 *
 *   pack.json  corpus/ corpus.jsonl  holdout/  gold/{facts,links,aliases}.jsonl gold/profile.json
 *   tasks/*.jsonl  updates/NN/  injections/  padding/ padding.jsonl
 *
 * Packs live outside the repository (`~/knode-eval/packs`): they hold
 * downloaded third-party text. A system under test never reads the pack
 * directory — `stageCorpus` copies the documents somewhere with nothing
 * else beside them, so an agent cannot wander from the corpus into the gold.
 */

export const EVAL_HOME = process.env.KNODE_EVAL_HOME || path.join(os.homedir(), 'knode-eval');
export const packsDir = () => path.join(EVAL_HOME, 'packs');
export const runsDir = () => path.join(EVAL_HOME, 'runs');
export const sourcesDir = () => path.join(EVAL_HOME, 'sources');

export interface LoadedPack {
  dir: string;
  manifest: PackManifest;
  docs: CorpusDoc[];
  tasks: Task[];
  facts: GoldFact[];
  links: GoldLink[];
  aliases: GoldAlias[];
  profile: Record<string, unknown>;
  /** Update batches, in order: updates/01, updates/02 … */
  updates: string[];
  /** Documents planted to attack the system (prompt injection), relative to injections/. */
  injections: string[];
  /**
   * Documents that only scale curves stage (`--fraction` above 1): more of the
   * same kind of source, chosen so that no closed-world task's gold changes.
   */
  padding: CorpusDoc[];
}

export function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const parsed = schema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${file}:${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
    out.push(parsed.data);
  });
  return out;
}

export function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/** Text files under `dir`, relative and sorted, hidden entries skipped. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out.sort();
}

export function loadPack(dir: string): LoadedPack {
  const abs = path.resolve(dir);
  const manifestFile = path.join(abs, 'pack.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`not a benchmark pack (no pack.json): ${abs}`);
  const manifest = PackManifestSchema.parse(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const corpusDir = path.join(abs, 'corpus');
  const listed = readJsonl(path.join(abs, 'corpus.jsonl'), CorpusDocSchema);
  const known = new Set(listed.map((d) => d.path));
  // a file in corpus/ that corpus.jsonl does not list is still a document
  const docs = [...listed, ...listFiles(corpusDir).filter((p) => !known.has(p)).map((p) => ({ path: p }))];
  const tasks = listFiles(path.join(abs, 'tasks')).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readJsonl(path.join(abs, 'tasks', f), TaskSchema));
  const profileFile = path.join(abs, 'gold', 'profile.json');
  const updatesDir = path.join(abs, 'updates');
  return {
    dir: abs,
    manifest,
    docs,
    tasks,
    facts: readJsonl(path.join(abs, 'gold', 'facts.jsonl'), GoldFactSchema),
    links: readJsonl(path.join(abs, 'gold', 'links.jsonl'), GoldLinkSchema),
    aliases: readJsonl(path.join(abs, 'gold', 'aliases.jsonl'), GoldAliasSchema),
    profile: fs.existsSync(profileFile) ? (JSON.parse(fs.readFileSync(profileFile, 'utf8')) as Record<string, unknown>) : {},
    updates: fs.existsSync(updatesDir)
      ? fs.readdirSync(updatesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      : [],
    injections: listFiles(path.join(abs, 'injections')),
    padding: (() => {
      const listedPad = readJsonl(path.join(abs, 'padding.jsonl'), CorpusDocSchema);
      const knownPad = new Set(listedPad.map((d) => d.path));
      return [...listedPad, ...listFiles(path.join(abs, 'padding')).filter((p) => !knownPad.has(p)).map((p) => ({ path: p }))];
    })(),
  };
}

/** Text of a document of an update batch (updates/<batch>/<doc>), or '' when the batch does not hold it. */
export function updateText(pack: LoadedPack, batch: string, doc: string): string {
  const file = path.join(pack.dir, 'updates', batch, doc);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Distinct documents a task's evidence names. */
export function evidenceDocs(t: Task): string[] {
  return [...new Set(t.evidence.map((e) => e.doc))];
}

export function docText(pack: LoadedPack, doc: string): string {
  const file = path.join(pack.dir, 'corpus', doc);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Whitespace folded, for checking that a quote occurs in its document. */
export function foldSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export interface PackIssues {
  errors: string[];
  warnings: string[];
}

/**
 * What would make a pack's scores meaningless: evidence pointing at missing
 * documents or quotes that are not in them, duplicate ids, tasks without
 * the gold their scoring needs, and gold that leaks into the corpus.
 */
export function validatePack(pack: LoadedPack): PackIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const docs = new Set(pack.docs.map((d) => d.path));
  const texts = new Map<string, string>();
  const text = (doc: string) => {
    if (!texts.has(doc)) texts.set(doc, foldSpace(docText(pack, doc)));
    return texts.get(doc)!;
  };

  if (pack.docs.length === 0) errors.push('corpus/ holds no documents');
  for (const d of pack.docs) if (!fs.existsSync(path.join(pack.dir, 'corpus', d.path))) errors.push(`corpus.jsonl lists ${d.path}, which is not in corpus/`);
  // the leak rule on dates (docs/design/37 §2): nothing in the corpus is dated after the pack's cutoff
  const cutoff = pack.manifest.cutoff ? Date.parse(pack.manifest.cutoff) : NaN;
  if (Number.isFinite(cutoff)) {
    const late = pack.docs.filter((d) => d.date && Date.parse(d.date) > cutoff);
    if (late.length) errors.push(`${late.length} corpus documents are dated after the cutoff ${pack.manifest.cutoff}: ${late.slice(0, 3).map((d) => d.path).join(', ')}`);
  }

  const ids = new Set<string>();
  // an update task's evidence may lie in its batch or an earlier one (batches apply cumulatively)
  const updateHolding = (doc: string, upTo: string) => pack.updates.filter((b) => b <= upTo && updateText(pack, b, doc));
  const known = (doc: string, afterUpdate?: string) => docs.has(doc) || (afterUpdate ? updateHolding(doc, afterUpdate).length > 0 : pack.updates.some((b) => updateText(pack, b, doc)));
  for (const t of pack.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
    for (const e of t.evidence) {
      if (!docs.has(e.doc)) {
        const batches = t.afterUpdate ? updateHolding(e.doc, t.afterUpdate) : [];
        if (!batches.length) {
          errors.push(t.afterUpdate ? `task ${t.id}: evidence doc ${e.doc} is neither in the corpus nor in an update batch up to ${t.afterUpdate}` : `task ${t.id}: evidence doc ${e.doc} is not in the corpus`);
        } else if (e.quote && !batches.some((b) => foldSpace(updateText(pack, b, e.doc)).includes(foldSpace(e.quote!)))) {
          errors.push(`task ${t.id}: quote not found in update ${e.doc}: "${e.quote.slice(0, 60)}"`);
        }
        continue;
      }
      if (e.quote && !text(e.doc).includes(foldSpace(e.quote))) errors.push(`task ${t.id}: quote not found in ${e.doc}: "${e.quote.slice(0, 60)}"`);
    }
    if ((t.scoring === 'judge' || t.scoring === 'exact' || t.scoring === 'value') && !t.answer && !t.answers?.length) errors.push(`task ${t.id}: ${t.scoring} scoring needs an answer`);
    if (t.scoring === 'count' && !/^\d+(\.\d+)?$/.test((t.answer ?? '').trim())) errors.push(`task ${t.id}: count scoring needs a number as the answer`);
    if (t.scoring === 'set' && !t.items?.length) errors.push(`task ${t.id}: set scoring needs items`);
    if (t.scoring === 'choice' && (!t.choices?.length || !t.answer || !t.choices.includes(t.answer))) errors.push(`task ${t.id}: choice scoring needs choices that include the answer`);
    if (t.scoring === 'keypoints' && !t.keypoints?.length) errors.push(`task ${t.id}: keypoints scoring needs keypoints`);
    if (t.scoring === 'label' && !t.answer) errors.push(`task ${t.id}: label scoring needs an answer`);
    if (t.afterUpdate && !pack.updates.includes(t.afterUpdate)) errors.push(`task ${t.id}: update batch ${t.afterUpdate} does not exist`);
    if (t.type === 'unanswerable' && t.scoring !== 'abstain') warnings.push(`task ${t.id}: unanswerable but scored ${t.scoring}`);
    for (const it of t.items ?? []) for (const d of it.docs ?? []) if (!known(d, t.afterUpdate)) errors.push(`task ${t.id}: item "${it.label.slice(0, 30)}" names ${d}, which is not in the corpus`);
    if (t.list && t.scoring !== 'set') errors.push(`task ${t.id}: a list spec needs set scoring`);
    if (t.list && (t.list.match === 'docs' || t.list.requireDocs) && t.items?.some((it) => !it.docs?.length)) errors.push(`task ${t.id}: matching by documents needs every item's docs`);
    if (t.list && t.items && t.items.length > t.list.maxItems) errors.push(`task ${t.id}: ${t.items.length} gold items but the answer may list only ${t.list.maxItems}`);

    // corpus-level tasks: set-scored (or a count), spread over many documents
    if (CORPUS_TASK_TYPES.includes(t.type)) {
      const spread = evidenceDocs(t).length;
      if (spread < CORPUS_TASK_MIN_DOCS) errors.push(`task ${t.id}: a ${t.type} task needs evidence in at least ${CORPUS_TASK_MIN_DOCS} documents (has ${spread})`);
      if (t.scoring !== 'set' && t.scoring !== 'count') errors.push(`task ${t.id}: a ${t.type} task is scored as a set or a count, not ${t.scoring}`);
      if (t.scoring === 'set' && !t.list) errors.push(`task ${t.id}: a ${t.type} task needs a list spec`);
    }
    if (t.type === 'timeline' && t.scoring === 'set') {
      if (!t.list?.ordered) errors.push(`task ${t.id}: a timeline is an ordered list`);
      if (t.items?.some((it) => !it.date)) errors.push(`task ${t.id}: every timeline item needs a date`);
    }
    if (t.type === 'contradiction' && t.scoring === 'set' && (t.items?.length ?? 0) < 2) errors.push(`task ${t.id}: a contradiction needs at least two sides`);
    if (t.type === 'deep-hop' || t.type === 'nonlexical-hop') {
      const hops = Number(t.meta?.hops ?? 0);
      if (hops < DEEP_HOP_MIN) errors.push(`task ${t.id}: a ${t.type} task needs meta.hops ≥ ${DEEP_HOP_MIN}`);
      if (evidenceDocs(t).length < DEEP_HOP_MIN) errors.push(`task ${t.id}: a ${t.type} task's hops lie in at least ${DEEP_HOP_MIN} different documents`);
    }
    // the separation families (docs/design/28)
    if (t.list?.match === 'fields' && t.items?.some((it) => !it.fields?.length)) errors.push(`task ${t.id}: matching by fields needs every item's fields`);
    if (t.type === 'structured') {
      const spread = evidenceDocs(t).length;
      if (spread < STRUCTURED_MIN_DOCS) errors.push(`task ${t.id}: a structured query's evidence spans at least ${STRUCTURED_MIN_DOCS} documents (has ${spread})`);
      if (t.scoring !== 'set' && t.scoring !== 'count' && t.scoring !== 'value') errors.push(`task ${t.id}: a structured query is scored as a set, a count or a value, not ${t.scoring}`);
    }
    if (t.type === 'stale') {
      const stale = t.meta?.stale;
      if (!Array.isArray(stale) || !stale.length) errors.push(`task ${t.id}: a stale task names its stale values (meta.stale)`);
      else if (stale.some((v) => [t.answer, ...(t.answers ?? [])].includes(String(v)))) errors.push(`task ${t.id}: a stale value is also the answer`);
    }
    if (t.type === 'connection' && (t.scoring !== 'set' || !t.list)) errors.push(`task ${t.id}: a connection task is a set with a list spec`);
  }

  // padding (scale curves) must leave every closed-world task's gold as it is
  if (pack.padding.length) {
    const padTexts = pack.padding.map((d) => {
      const file = path.join(pack.dir, 'padding', d.path);
      if (!fs.existsSync(file)) errors.push(`padding.jsonl lists ${d.path}, which is not in padding/`);
      if (docs.has(d.path)) errors.push(`padding document ${d.path} has the path of a corpus document`);
      return { path: d.path, text: fs.existsSync(file) ? foldSpace(fs.readFileSync(file, 'utf8')) : '' };
    });
    for (const t of pack.tasks) {
      if (!t.closedWorld) continue;
      for (const pre of t.closedWorld.prefixes) {
        const under = padTexts.find((p) => p.path.startsWith(pre));
        if (under) errors.push(`task ${t.id}: padding document ${under.path} lies under its closed-world prefix ${pre}`);
      }
      for (const term of t.closedWorld.terms) {
        // one CJK character is a word (膝); one Latin letter is not
        if (foldSpace(term).length < 2 && !/[\u3400-\u9fff]/.test(term)) {
          warnings.push(`task ${t.id}: closed-world term "${term}" is too short to check`);
          continue;
        }
        const hit = padTexts.find((p) => p.text.includes(foldSpace(term)));
        if (hit) errors.push(`task ${t.id}: padding document ${hit.path} mentions its closed-world term "${term}"`);
      }
    }
  }

  const factIds = new Set<string>();
  for (const f of pack.facts) {
    if (factIds.has(f.id)) errors.push(`duplicate fact id ${f.id}`);
    factIds.add(f.id);
    if (!docs.has(f.doc)) errors.push(`fact ${f.id}: doc ${f.doc} is not in the corpus`);
    else if (f.quote && !text(f.doc).includes(foldSpace(f.quote))) errors.push(`fact ${f.id}: quote not found in ${f.doc}`);
  }

  // the holdout must not be readable from the corpus: a holdout file copied into corpus/ by mistake
  const holdout = listFiles(path.join(pack.dir, 'holdout'));
  const corpusNames = new Set(pack.docs.map((d) => path.basename(d.path)));
  for (const h of holdout) if (corpusNames.has(path.basename(h))) warnings.push(`holdout/${h} shares a file name with a corpus document`);

  if (pack.tasks.length === 0) warnings.push('the pack has no tasks');
  const suites = new Set(pack.tasks.map((t) => t.suite));
  if (pack.facts.length === 0 && !suites.has('generation')) warnings.push('no gold facts: generation coverage cannot be scored');
  return { errors, warnings };
}

export function writeManifest(dir: string, manifest: PackManifest): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(PackManifestSchema.parse(manifest), null, 2) + '\n');
}

/** Deterministic order and selection from a seed: the same seed picks the same documents. */
export function seededKey(seed: string | number, id: string): string {
  return crypto.createHash('sha256').update(`${seed}|${id}`).digest('hex');
}

/** A ten-character id from its parts: the same parts give the same id. */
export function shortHash(...parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

/** Items in the order a seed gives them. */
export function bySeed<T>(items: T[], seed: string | number, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b))));
}

/** Items in a seeded round-robin over strata: every stratum is drawn once before any is drawn twice. */
export function stratified<T>(items: T[], stratum: (t: T) => string, key: (t: T) => string, seed: string | number): T[] {
  const groups = new Map<string, T[]>();
  for (const t of items) (groups.get(stratum(t)) ?? groups.set(stratum(t), []).get(stratum(t))!).push(t);
  const lists = [...groups.entries()]
    .sort((a, b) => seededKey(seed, a[0]).localeCompare(seededKey(seed, b[0])))
    .map(([, list]) => list.sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b)))));
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) for (const l of lists) if (round < l.length) out.push(l[round]);
  return out;
}

export interface StagedCorpus {
  /** The directory a system reads — a fresh temp directory with nothing else in its parent. */
  dir: string;
  docs: CorpusDoc[];
  /** Tasks whose evidence is all inside the staged documents. */
  tasks: Task[];
  /** Padding documents among `docs` (scale curves). */
  padded: number;
  cleanup: () => void;
}

/**
 * Copy the corpus — or a seeded fraction of it — to a new directory under the
 * OS temp dir. Tasks whose evidence falls outside the fraction are dropped
 * (an unanswerable task stays: it has none). A fraction above 1 stages the
 * whole corpus plus that many times its size again in seeded padding
 * documents (`fraction` 10 → ten times the documents), and keeps every task:
 * `validatePack` has checked that padding cannot change a closed-world task's
 * gold. A pack without enough padding is an error, not a smaller curve.
 * Update batches are not copied; `stageUpdate` adds one when an update suite
 * asks for it.
 */
export function stageCorpus(pack: LoadedPack, opts: { fraction?: number; seed?: string | number } = {}): StagedCorpus {
  const fraction = opts.fraction ?? 1;
  const seed = opts.seed ?? 0;
  if (!(fraction > 0) || !Number.isFinite(fraction)) throw new Error(`--fraction must be a positive number (got ${fraction})`);
  const bySeed = (docs: CorpusDoc[]) => [...docs].sort((a, b) => seededKey(seed, a.path).localeCompare(seededKey(seed, b.path)));
  let keep: CorpusDoc[];
  let padding: CorpusDoc[] = [];
  if (fraction <= 1) {
    keep = fraction === 1 ? pack.docs : bySeed(pack.docs).slice(0, Math.max(1, Math.round(pack.docs.length * fraction)));
  } else {
    keep = pack.docs;
    const want = Math.round(pack.docs.length * (fraction - 1));
    if (pack.padding.length < want) {
      throw new Error(`pack ${pack.manifest.id} has ${pack.padding.length} padding documents; --fraction ${fraction} needs ${want} (rebuild the pack with more padding)`);
    }
    padding = bySeed(pack.padding).slice(0, want);
  }
  const kept = new Set(keep.map((d) => d.path));
  const { root, cleanup } = evalTempDir('corpus');
  const dir = path.join(root, 'corpus');
  const copy = (from: string, d: CorpusDoc) => {
    const to = path.join(dir, d.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(pack.dir, from, d.path), to);
  };
  for (const d of keep) copy('corpus', d);
  for (const d of padding) copy('padding', d);
  const tasks = pack.tasks.filter((t) => t.afterUpdate || t.evidence.every((e) => kept.has(e.doc)));
  return { dir, docs: [...keep, ...padding], tasks, padded: padding.length, cleanup };
}

/**
 * Copy an update batch into a staged corpus and list its documents among the
 * staged ones (so answers may cite them and a rebuilt index reads them);
 * returns the documents it added or replaced. Batches apply cumulatively.
 */
export function stageUpdate(pack: LoadedPack, staged: StagedCorpus, batch: string): string[] {
  const from = path.join(pack.dir, 'updates', batch);
  const files = listFiles(from);
  const present = new Set(staged.docs.map((d) => d.path));
  for (const f of files) {
    const to = path.join(staged.dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(from, f), to);
    if (!present.has(f)) staged.docs.push({ path: f, kind: 'update' });
  }
  return files;
}

/** Bytes a directory takes, recursively. */
export function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const abs = path.join(p, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) total += fs.statSync(abs).size;
    }
  };
  walk(dir);
  return total;
}
