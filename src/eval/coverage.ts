import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { mdTable } from '../bench/util.js';
import { readMatter } from '../markdown.js';
import { listFiles, type LoadedPack } from './pack.js';
import type { Task } from './types.js';

/**
 * Where a pack's gold answers sit in a knode build, without a model
 * (docs/design/38 §3.2 item 5): per question family (`meta.family`, else the
 * task's type), the share of questions whose gold the build holds — in the
 * source summary page of the question's own evidence document, in entity and
 * timeline pages, in other pages (concepts, datasets, disagreements, the
 * overview), in mention pages alone (a mention line is an excerpt of the
 * source, not knowledge the build compiled, so it is counted apart), and in
 * the claims extracted from the evidence documents.
 *
 * A page that covers many documents (an entity, a timeline) counts only on a
 * line that names one of the question's evidence documents: a number on an
 * entity page may come from any of its documents. A claim counts when its
 * chunk (or its own `document_id`) is in an evidence document.
 *
 * Gold is matched as follows:
 * - a number (the answer holds one): every number in the text is read with
 *   its scale word (thousand, million, 万, 亿 …), and matches when, at one of
 *   the scales a table may print it in (元, 千元, 万元, 百万元, 亿元; units,
 *   thousands, millions), it equals the gold within the coarser of the two
 *   precisions — so 167,424,382.67 matches "16,742.44 万元" and "167,424 千元"
 *   but not "1.7 亿". A text number needs at least min(3, the gold's)
 *   significant digits; signs are ignored (a loss is often written as a
 *   positive number beside the word); a bare four-digit year matches only a
 *   year-like gold. Claims match on `value_num` the same way, and on their
 *   statement as text.
 * - a list (`items`): an item whose label states one number by that number
 *   ("海新能科: -0.0501"), an item "<key>: <words>" with no number not at all
 *   (a class the question derives, "CLEARONE INC: high shares", which no
 *   source states), any other by its label or an alias, normalized (case,
 *   width, spaces and punctuation); a question scores the share of its
 *   measurable items found. An answer listing several numbers is read as a
 *   list of them, its years and small whole numbers left out.
 * - not measurable: a small whole number (under 100: a count the question
 *   derives, found on any page), an answer the question itself names (one of
 *   the options it lists), longer gold (a judged explanation), abstentions.
 * - other short gold (at most 60 characters): the answer or one of `answers`,
 *   normalized as above.
 */

export const COVERAGE_PLACES = ['corpus', 'source', 'entityTimeline', 'other', 'wiki', 'mentions', 'mentionsOnly', 'claims', 'wikiOrClaims'] as const;
export type CoveragePlace = (typeof COVERAGE_PLACES)[number];

const PLACE_LABEL: Record<CoveragePlace, string> = {
  corpus: 'source text',
  source: 'own summary page',
  entityTimeline: 'entity / timeline pages',
  other: 'other pages',
  wiki: 'wiki (pages, no mentions)',
  mentions: 'mention pages',
  mentionsOnly: 'mention pages only',
  claims: 'claims',
  wikiOrClaims: 'wiki or claims',
};

/* --------------------------------- numbers -------------------------------- */

export interface ReadNumber {
  /** The value with its scale word applied, sign dropped. */
  value: number;
  /** The step of the last digit written, scaled as the value is. */
  precision: number;
  /** Significant digits written (leading zeros not counted). */
  sig: number;
  /** A scale word stood beside it (the value is already scaled). */
  scaled: boolean;
  /** A bare whole number between 1900 and 2100: a year, most likely. */
  yearLike: boolean;
  percent: boolean;
}

const SCALE_WORDS: [RegExp, number][] = [
  [/^(?:trillion|万亿)/i, 1e12],
  [/^(?:billion|bn\b|十亿)/i, 1e9],
  [/^亿/, 1e8],
  [/^(?:千万)/, 1e7],
  [/^(?:million|mn\b|百万)/i, 1e6],
  [/^(?:十万)/, 1e5],
  [/^万/, 1e4],
  [/^(?:thousand|千)/i, 1e3],
];

const NUMBER = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

function sigDigits(digits: string): number {
  const plain = digits.replace(/[,.]/g, '').replace(/^0+/, '');
  return Math.max(1, plain.length);
}

/** Every number in a text, with the scale word written right after it. */
export function readNumbers(text: string): ReadNumber[] {
  const t = text.normalize('NFKC');
  const out: ReadNumber[] = [];
  for (const m of t.matchAll(NUMBER)) {
    const raw = m[1];
    const at = m.index ?? 0;
    // part of a longer token: an id (filings/en/06d5dde4c6d9), a version, a date's other half
    const before = t[at - 1] ?? '';
    const afterRaw = t.slice(at + raw.length);
    if (/[A-Za-z_]/.test(before) || /^[A-Za-z_]/.test(afterRaw) && !/^(?:thousand|million|billion|trillion|bn\b|mn\b)/i.test(afterRaw)) continue;
    const plain = raw.replace(/,/g, '');
    const decimals = plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0;
    const after = afterRaw.replace(/^\s+/, '');
    let scale = 1;
    let scaled = false;
    for (const [re, s] of SCALE_WORDS) {
      if (re.test(after)) {
        scale = s;
        scaled = true;
        break;
      }
    }
    const value = Number(plain) * scale;
    if (!Number.isFinite(value)) continue;
    const whole = !raw.includes('.') && !raw.includes(',');
    out.push({
      value, precision: 10 ** -decimals * scale, sig: sigDigits(raw), scaled,
      yearLike: whole && !scaled && Number(plain) >= 1900 && Number(plain) <= 2100,
      percent: /^%|^％|^percent/i.test(after),
    });
  }
  return out;
}

/** Scales a table may print a number in, without a word beside it: units, thousands, ten-thousands, millions, hundred-millions (and the reverse). */
const TABLE_SCALES = [1, 1e3, 1e4, 1e6, 1e8, 1e-3, 1e-4, 1e-6, 1e-8];

/** A gold number: what the answer states, at the precision it was written. */
export interface GoldNumber {
  value: number;
  precision: number;
  sig: number;
  yearLike: boolean;
}

/** A gold answer's scale given apart from the number: "$10,135 in thousands", "（单位：万元）". */
function goldScale(text: string): number {
  const t = text.normalize('NFKC');
  if (/in\s+billions|十亿元/i.test(t)) return 1e9;
  if (/in\s+millions|百万元/i.test(t)) return 1e6;
  if (/in\s+thousands|千元/i.test(t)) return 1e3;
  return 1;
}

/** The numbers a gold text states (dates are not quantities: "2024-03-31", "2024年3月"), with its scale applied. */
export function numbersIn(text: string): GoldNumber[] {
  const nums = readNumbers(text.replace(/\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?/g, ' '));
  const scale = goldScale(text);
  return nums.map((n) => {
    const s = n.scaled ? 1 : scale;
    return { value: n.value * s, precision: n.precision * s, sig: n.sig, yearLike: n.yearLike };
  });
}

/** The gold numbers of a task, or null when its answer is not one number (several, or none). */
export function goldNumbers(task: Pick<Task, 'answer' | 'answers'>): GoldNumber[] | null {
  const texts = [...new Set([task.answer, ...(task.answers ?? [])].filter((x): x is string => typeof x === 'string' && x.trim() !== ''))];
  if (!texts.length) return null;
  const out: GoldNumber[] = [];
  for (const text of texts) {
    const nums = numbersIn(text);
    if (nums.length !== 1) {
      // the answer itself is not one number: not a number question; an alternative that is not is left out
      if (text === task.answer) return null;
      continue;
    }
    out.push(nums[0]);
  }
  return out.length ? out : null;
}

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/** A number read from a text matches a gold number at some scale a table may print it in. */
export function numberMatches(n: ReadNumber, g: GoldNumber): boolean {
  if (n.sig < Math.min(3, g.sig)) return false;
  if (n.yearLike && !g.yearLike) return false;
  const gv = Math.abs(g.value);
  const nv = Math.abs(n.value);
  for (const s of n.scaled || n.percent ? [1] : TABLE_SCALES) {
    if (close(nv * s, gv, Math.max(n.precision * s, g.precision) / 2)) return true;
  }
  return false;
}

/** A stored value (a claim's `value_num`) matches a gold number: its precision is read from how it prints. */
export function valueMatches(v: number, g: GoldNumber): boolean {
  if (!Number.isFinite(v)) return false;
  const s = String(Math.abs(v));
  if (/e/i.test(s)) return TABLE_SCALES.some((k) => close(Math.abs(v) * k, Math.abs(g.value), g.precision / 2 || 1e-9 * Math.abs(g.value)));
  const decimals = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
  return numberMatches({ value: Math.abs(v), precision: 10 ** -decimals, sig: sigDigits(s), scaled: false, yearLike: Number.isInteger(v) && v >= 1900 && v <= 2100, percent: false }, g);
}

export function textHasNumber(text: string, gold: GoldNumber[]): boolean {
  if (!text) return false;
  const nums = readNumbers(text);
  return gold.some((g) => nums.some((n) => numberMatches(n, g)));
}

/* ---------------------------------- text ---------------------------------- */

/** Case, width, spaces and punctuation out: what a string match compares. */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/* ---------------------------------- gold ---------------------------------- */

export type GoldKind = 'number' | 'list' | 'text' | 'none';

/** One thing a question's gold needs found: a number, or one of some names (normalized). */
export interface GoldPart {
  numbers?: GoldNumber[];
  names?: string[];
  /** The documents that state it, where the gold names them (a list item's `docs`). */
  docs?: string[];
}

export interface TaskGold {
  kind: GoldKind;
  numbers?: GoldNumber[];
  /**
   * List items: each by its number where its label states one ("海新能科: -0.0501" — the name is the key, the
   * number the answer), else by its label and aliases. Also an answer that lists several numbers.
   */
  items?: GoldPart[];
  /** Short text answers, normalized. */
  texts?: string[];
}

const TEXT_MAX = 60;
const smallWhole = (n: GoldNumber) => n.precision >= 1 && Math.abs(n.value) < 100 && Number.isInteger(n.value);
/** A list item that pairs a key with a value ("<company>: <group>"). */
const DERIVED_LABEL = /^[^:：]{1,120}[:：]\s*\S/;

export function taskGold(t: Task): TaskGold {
  if (t.scoring === 'abstain') return { kind: 'none' };
  if (t.items?.length) {
    const items = t.items.flatMap((i): GoldPart[] => {
      const nums = numbersIn(i.label);
      const docs = i.docs?.length ? { docs: i.docs } : {};
      if (nums.length === 1) return [{ numbers: nums, ...docs }];
      // "CLEARONE INC: high shares": a class the question derives, which no source states — not measurable here
      if (DERIVED_LABEL.test(i.label) && !nums.length) return [];
      return [{ names: [i.label, ...i.aliases].map(normalize).filter((x) => x.length > 0), ...docs }];
    });
    return items.length ? { kind: 'list', items } : { kind: 'none' };
  }
  const nums = goldNumbers(t);
  // a small whole number (a count the question derives, "2"): every page holds one, so finding it says nothing
  if (nums?.length) return nums.every(smallWhole) ? { kind: 'none' } : { kind: 'number', numbers: nums };
  // an answer listing several numbers ("(倍加洁: 11,078,142.33), (迈克生物: 21,428,623.41)"): each one an item;
  // the years it names ("2023年一季度") and small whole numbers are not what it states
  const several = t.answer ? numbersIn(t.answer).filter((n) => !n.yearLike && !smallWhole(n)) : [];
  if (several.length > 1) return { kind: 'list', items: several.map((n) => ({ numbers: [n] })) };
  // an answer the question itself names ("which of A, B, C …": B) is one of its options, not a fact a page could hold
  const question = normalize(t.question);
  const texts = [t.answer, ...(t.answers ?? [])].filter((x): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= TEXT_MAX).map(normalize).filter((x) => x.length > 0);
  if (texts.length && texts.every((x) => question.includes(x))) return { kind: 'none' };
  return texts.length ? { kind: 'text', texts: [...new Set(texts)] } : { kind: 'none' };
}

/* ---------------------------------- build --------------------------------- */

/** What a knode build holds, by the corpus document it comes from (pack paths). */
export interface BuildIndex {
  /** Source summary pages' text (frontmatter out), by document. */
  source: Map<string, string[]>;
  /** Lines of entity and timeline pages that name a document. */
  entityTimeline: Map<string, string[]>;
  /** Lines of other pages (concepts, datasets, disagreements, overview …) that name a document. */
  other: Map<string, string[]>;
  /** Lines of mention pages that name a document. */
  mentions: Map<string, string[]>;
  /** Claims of a document: statement and value. Absent: the claims were not read. */
  claims?: Map<string, { statement: string; value: number | null }[]>;
  pages: number;
}

export interface ClaimRow {
  path: string | null;
  statement: string;
  value: number | null;
}

/** Resolves the paths a build writes (`raw/docs/filings/en/x.md`) to the pack's (`filings/en/x.md`) by suffix. */
export function docResolver(packDocs: Iterable<string>): (ref: string) => string | null {
  const byBase = new Map<string, string[]>();
  for (const d of packDocs) {
    const b = path.posix.basename(d);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(d);
  }
  return (ref: string) => {
    const r = ref.replace(/\\/g, '/');
    const cands = byBase.get(path.posix.basename(r));
    if (!cands) return null;
    const hit = cands.filter((c) => r === c || r.endsWith(`/${c}`));
    // the longest: `a/x.md` and `b/a/x.md` both end the reference
    return hit.sort((a, b) => b.length - a.length)[0] ?? null;
  };
}

const DOC_REF = /[\w./\\-]+\.(?:md|markdown|txt|html?|pdf|json|jsonl|csv|tsv|docx?|xlsx?)\b/gi;

function push(m: Map<string, string[]>, k: string, v: string) {
  (m.get(k) ?? m.set(k, []).get(k)!).push(v);
}

/** Read a build's wiki: every page, by kind, keyed by the pack documents it names. */
export function readWiki(wikiDir: string, resolve: (ref: string) => string | null): Omit<BuildIndex, 'claims'> {
  const out: Omit<BuildIndex, 'claims'> = { source: new Map(), entityTimeline: new Map(), other: new Map(), mentions: new Map(), pages: 0 };
  for (const rel of listFiles(wikiDir)) {
    if (!rel.endsWith('.md')) continue;
    out.pages++;
    const raw = fs.readFileSync(path.join(wikiDir, rel), 'utf8');
    let data: Record<string, unknown> = {};
    let body = raw;
    try {
      const parsed = readMatter(raw);
      data = parsed.data as Record<string, unknown>;
      body = parsed.content;
    } catch {
      /* a page whose frontmatter does not parse: read it whole */
    }
    const dir = rel.split('/')[0];
    const type = typeof data.type === 'string' ? data.type : '';
    if (dir === 'sources' || type === 'source') {
      const inputs = ((data.knode as { inputs?: { documents?: unknown } } | undefined)?.inputs?.documents);
      const refs = [data.source, ...(Array.isArray(inputs) ? inputs : [])].filter((x): x is string => typeof x === 'string');
      for (const d of new Set(refs.map(resolve).filter((x): x is string => x !== null))) push(out.source, d, body);
      continue;
    }
    const into = dir === 'mentions' || type === 'mentions' ? out.mentions
      : dir === 'entities' || dir === 'timelines' || type === 'timeline' ? out.entityTimeline
      : out.other;
    for (const line of body.split('\n')) {
      const refs = line.match(DOC_REF);
      if (!refs) continue;
      for (const d of new Set(refs.map(resolve).filter((x): x is string => x !== null))) push(into, d, line);
    }
  }
  return out;
}

export function claimsByDoc(rows: ClaimRow[], resolve: (ref: string) => string | null): NonNullable<BuildIndex['claims']> {
  const out: NonNullable<BuildIndex['claims']> = new Map();
  for (const r of rows) {
    const d = r.path ? resolve(r.path) : null;
    if (!d) continue;
    (out.get(d) ?? out.set(d, []).get(d)!).push({ statement: r.statement ?? '', value: r.value === null || r.value === undefined ? null : Number(r.value) });
  }
  return out;
}

/* --------------------------------- measure -------------------------------- */

export interface CoverageRow {
  family: string;
  tasks: number;
  /** Questions whose gold can be matched without a model. */
  measurable: number;
  kinds: Record<GoldKind, number>;
  /** Summed coverage per place (a list question counts the share of its items found). */
  found: Record<CoveragePlace, number>;
}

export interface CoverageResult {
  pack: string;
  workspace: string;
  pages: number;
  /** Claims were read (a database or a file); otherwise their columns are empty. */
  claims: boolean;
  claimCount: number;
  rows: CoverageRow[];
  /** All families pooled. */
  all: CoverageRow;
  /** Questions with one evidence document and a number for gold: the plan's reference subset. */
  singleDocNumber: CoverageRow;
  /** Per question: where its gold was found (1 = everywhere it can be, a share for lists). */
  perTask: { id: string; family: string; kind: GoldKind; docs: string[]; found: Partial<Record<CoveragePlace, number>> }[];
}

const emptyRow = (family: string): CoverageRow => ({
  family, tasks: 0, measurable: 0, kinds: { number: 0, list: 0, text: 0, none: 0 },
  found: Object.fromEntries(COVERAGE_PLACES.map((p) => [p, 0])) as Record<CoveragePlace, number>,
});

export function familyOf(t: Task): string {
  return typeof t.meta?.family === 'string' && t.meta.family ? t.meta.family : t.type;
}

/** One question's coverage at every place: 1 or 0, or the share of a list's items. */
export function taskCoverage(gold: TaskGold, docs: string[], corpus: (doc: string) => string, build: BuildIndex): Record<CoveragePlace, number> | null {
  if (gold.kind === 'none') return null;
  const textsAt = (place: Exclude<CoveragePlace, 'wiki' | 'mentionsOnly' | 'wikiOrClaims' | 'claims'>, ds: string[]): string[] =>
    ds.flatMap((d) => (place === 'corpus' ? [corpus(d)] : build[place].get(d) ?? []));
  const claimsOf = (ds: string[]) => ds.flatMap((d) => build.claims?.get(d) ?? []);
  // one test of "does this text hold the gold", for each kind
  const holds = (texts: string[], values: (number | null)[], test: { numbers?: GoldNumber[]; names?: string[] }): boolean => {
    if (test.numbers) return texts.some((t) => textHasNumber(t, test.numbers!)) || values.some((v) => v !== null && test.numbers!.some((g) => valueMatches(v, g)));
    const names = test.names ?? [];
    return texts.some((t) => {
      const n = normalize(t);
      return names.some((x) => n.includes(x));
    });
  };
  const tests: { numbers?: GoldNumber[]; names?: string[]; docs: string[] }[] = gold.kind === 'number' ? [{ numbers: gold.numbers, docs }]
    : gold.kind === 'text' ? [{ names: gold.texts, docs }]
    : gold.items!.map((i) => ({ ...(i.numbers ? { numbers: i.numbers } : { names: i.names }), docs: i.docs?.length ? i.docs : docs }));
  const at = (place: CoveragePlace): number => {
    const hit = tests.map((t) => {
      if (place === 'claims') {
        const cs = claimsOf(t.docs);
        return holds(cs.map((c) => c.statement), cs.map((c) => c.value), t);
      }
      if (place === 'wiki') return (['source', 'entityTimeline', 'other'] as const).some((p) => holds(textsAt(p, t.docs), [], t));
      if (place === 'mentionsOnly') return holds(textsAt('mentions', t.docs), [], t) && !(['source', 'entityTimeline', 'other'] as const).some((p) => holds(textsAt(p, t.docs), [], t));
      if (place === 'wikiOrClaims') return false; // below
      return holds(textsAt(place, t.docs), [], t);
    });
    return hit.filter(Boolean).length / hit.length;
  };
  const out = Object.fromEntries(COVERAGE_PLACES.map((p) => [p, 0])) as Record<CoveragePlace, number>;
  for (const p of COVERAGE_PLACES) if (p !== 'wikiOrClaims') out[p] = at(p);
  // per item: on a page or in a claim
  const either = tests.map((t) => {
    const cs = claimsOf(t.docs);
    return (['source', 'entityTimeline', 'other'] as const).some((p) => holds(textsAt(p, t.docs), [], t)) || holds(cs.map((c) => c.statement), cs.map((c) => c.value), t);
  });
  out.wikiOrClaims = either.filter(Boolean).length / either.length;
  return out;
}

export function coverage(pack: LoadedPack, build: BuildIndex, opts: { workspace?: string; types?: string[]; claimCount?: number } = {}): CoverageResult {
  const texts = new Map<string, string>();
  const corpus = (d: string) => {
    if (!texts.has(d)) {
      const f = path.join(pack.dir, 'corpus', d);
      texts.set(d, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    }
    return texts.get(d)!;
  };
  const rows = new Map<string, CoverageRow>();
  const all = emptyRow('all');
  const single = emptyRow('one document, a number');
  const perTask: CoverageResult['perTask'] = [];
  for (const t of pack.tasks) {
    if (opts.types?.length && !opts.types.includes(t.type)) continue;
    const family = familyOf(t);
    const gold = taskGold(t);
    const rowKey = `${family} · ${gold.kind}`;
    const row = rows.get(rowKey) ?? rows.set(rowKey, emptyRow(rowKey)).get(rowKey)!;
    const docs = [...new Set(t.evidence.map((e) => e.doc))];
    const singleNumber = gold.kind === 'number' && docs.length === 1;
    for (const r of [row, all, ...(singleNumber ? [single] : [])]) {
      r.tasks++;
      r.kinds[gold.kind]++;
    }
    const found = taskCoverage(gold, docs, corpus, build);
    perTask.push({ id: t.id, family, kind: gold.kind, docs, found: found ?? {} });
    if (!found) continue;
    for (const r of [row, all, ...(singleNumber ? [single] : [])]) {
      r.measurable++;
      for (const p of COVERAGE_PLACES) r.found[p] += found[p];
    }
  }
  return {
    pack: pack.manifest.id, workspace: opts.workspace ?? '', pages: build.pages, claims: Boolean(build.claims), claimCount: opts.claimCount ?? 0,
    rows: [...rows.values()].sort((a, b) => b.tasks - a.tasks || a.family.localeCompare(b.family)), all, singleDocNumber: single, perTask,
  };
}

/* ----------------------------------- io ----------------------------------- */

/** The schema of a build's indexes: named, or found by the comment `eval` writes on it (the workspace's directory, matched whole, else by its name). */
export async function findSchema(client: pg.Client, workspace: string): Promise<string> {
  const r = await client.query<{ nspname: string; description: string }>(
    `select n.nspname, d.description from pg_namespace n join pg_description d on d.objoid = n.oid and d.classoid = 'pg_namespace'::regclass where d.description like 'knode-eval workspace %'`,
  );
  const dirOf = (row: { description: string }) => row.description.replace(/^knode-eval workspace /, '');
  const abs = path.resolve(workspace);
  const exact = r.rows.filter((row) => dirOf(row) === abs);
  if (exact.length === 1) return exact[0].nspname;
  const named = r.rows.filter((row) => path.basename(dirOf(row)) === path.basename(abs));
  if (named.length === 1) return named[0].nspname;
  throw new Error(named.length ? `several schemas belong to a workspace named ${path.basename(abs)}: ${named.map((x) => x.nspname).join(', ')} — name one with --schema` : `no evaluation schema for ${abs} — name it with --schema`);
}

/** The claims of a build, each with the path of its document (its own, else its chunk's), read in a read-only transaction. */
export async function readClaims(url: string, opts: { schema?: string; workspace: string }): Promise<{ schema: string; rows: ClaimRow[] }> {
  const client = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  await client.connect();
  try {
    const schema = opts.schema ?? (await findSchema(client, opts.workspace));
    const q = (x: string) => `"${schema.replace(/"/g, '""')}".${x}`;
    const r = await client.query<{ path: string | null; statement: string; value_num: number | null }>(
      `select d.path, c.statement, c.value_num from ${q('claims')} c left join ${q('chunks')} k on k.id = c.chunk_id left join ${q('documents')} d on d.id = coalesce(c.document_id, k.document_id)`,
    );
    return { schema, rows: r.rows.map((x) => ({ path: x.path, statement: x.statement ?? '', value: x.value_num })) };
  } finally {
    await client.end();
  }
}

/** Claims from a JSON Lines file: `{"path", "statement", "value"}` a line (an export, for a build on PGlite or out of reach). */
export function readClaimsFile(file: string): ClaimRow[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const o = JSON.parse(l) as { path?: string | null; document?: string | null; statement?: string; value?: number | null; value_num?: number | null };
    return { path: o.path ?? o.document ?? null, statement: o.statement ?? '', value: o.value ?? o.value_num ?? null };
  });
}

/** A workspace's PostgreSQL as a URL, from its knode.config.json; null when it is on PGlite or names none. */
export function workspaceDatabaseUrl(workspace: string): string | null {
  const f = path.join(workspace, 'knode.config.json');
  if (!fs.existsSync(f)) return null;
  const db = (JSON.parse(fs.readFileSync(f, 'utf8')) as { database?: { kind?: string; url?: string; host?: string; port?: number; user?: string; password?: string; database?: string } }).database;
  if (!db || db.kind !== 'postgres') return null;
  if (db.url && !db.url.startsWith('env:')) return db.url;
  if (db.url?.startsWith('env:')) return process.env[db.url.slice(4)] ?? null;
  const pw = db.password && !db.password.startsWith('env:') ? db.password : db.password?.startsWith('env:') ? process.env[db.password.slice(4)] ?? '' : '';
  return `postgres://${encodeURIComponent(db.user ?? '')}${pw ? `:${encodeURIComponent(pw)}` : ''}@${db.host ?? '127.0.0.1'}:${db.port ?? 5432}/${encodeURIComponent(db.database ?? 'knode_eval')}`;
}

/* --------------------------------- format --------------------------------- */

export function formatCoverage(r: CoverageResult): string {
  const places = COVERAGE_PLACES.filter((p) => r.claims || (p !== 'claims' && p !== 'wikiOrClaims'));
  const cell = (row: CoverageRow, p: CoveragePlace) => {
    if (!row.measurable) return '—';
    const v = row.found[p];
    return `${Number.isInteger(v) ? v : v.toFixed(1)} (${Math.round((v / row.measurable) * 100)}%)`;
  };
  const kinds = (row: CoverageRow) => (['number', 'list', 'text', 'none'] as const).filter((k) => row.kinds[k]).map((k) => `${k} ${row.kinds[k]}`).join(', ');
  const line = (row: CoverageRow, label = row.family) => [label, row.tasks, row.measurable, kinds(row), ...places.map((p) => cell(row, p))];
  const out = [
    `## ${r.pack}: where the gold is in the build`,
    '',
    `Workspace ${r.workspace || '—'}: ${r.pages} wiki pages${r.claims ? `, ${r.claimCount} claims` : ', claims not read'}. Per family (\`meta.family\`, else the type) and kind of gold (a number; a list, its items by number where they state one; short text; none measurable), the questions whose gold was found at each place, over the measurable ones (a list question counts the share of its items). Pages other than a document's own summary count only on a line naming one of the question's evidence documents; "mention pages only" are questions whose gold is in a mention line (an excerpt of the source) and on no other page.`,
    '',
    mdTable(['family', 'questions', 'measurable', 'gold', ...places.map((p) => PLACE_LABEL[p])], [
      ...r.rows.map((row) => line(row)),
      line(r.all, '**all**'),
      line(r.singleDocNumber, '*one evidence document, a number*'),
    ]),
    '',
  ];
  return out.join('\n');
}
