import { canonicalListPairs as canonicalPairs, type Judge } from '../judge.js';
import { hasCjk, normalizeAnswer } from '../metrics/text.js';
import { parseStructured } from '../prompts.js';
import type { AnswerRecord, GoldItem, ListSpec, ScoreRecord, Task } from '../types.js';
import { ListSpecSchema } from '../types.js';
import { judgeItemKey, repeatOf, scoreKey } from './keys.js';

/**
 * Scoring corpus-level lists (docs/design/23 §4): an aggregate, a timeline,
 * the sides of a contradiction or a profile, each answered as the same JSON
 * list and matched one-to-one against a gold list — without a model where the
 * gold allows it (an alias that occurs in the predicted label, or the
 * documents an item cites), by the judge otherwise — and a judge-matched list
 * goes to the judge only for what its gold's own terms do not settle
 * (`matchByAnchors`). A timeline is also scored
 * on order and dates; a contradiction match needs one of the documents that
 * take that side. The task's correctness is set F1 (recall where the gold is
 * a sample), times order accuracy for a timeline. A structured query
 * (docs/design/28) matches by fields — every field of the gold item (a team,
 * a quarter, a count) named in one predicted label — and is right only when
 * the whole set is. A look-alike task names its distractors: the share of
 * predicted items that are the look-alike's is `distractor_rate`.
 */

const CJK_CLASS = '㐀-䶿一-鿿぀-ヿ가-힯';
const SPACE_BY_CJK = new RegExp(`\\s+(?=[${CJK_CLASS}])|(?<=[${CJK_CLASS}])\\s+`, 'gu');

/**
 * Thousands separators dropped: "1,000" and "1,347,307.69" as the digits
 * they are. Only a well-formed group (one to three digits, then groups of
 * exactly three) is folded, so "3,4" and "第1,2周" keep their comma.
 */
export function foldThousands(s: string): string {
  return s.normalize('NFKC').replace(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d]|,\d)/g, (m) => m.replace(/,/g, ''));
}

/** Normalized for matching: NFKC, lower case, thousands separators and punctuation folded; no spaces next to CJK, none between a number and its unit. */
export function matchForm(s: string): string {
  return normalizeAnswer(foldThousands(s)).replace(SPACE_BY_CJK, '').replace(/(?<=\d)\s+(?=[a-z%])/g, '').replace(/(?<=\d)\s+(?=\d)/g, ' ');
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isLatin = (c: string | undefined) => c !== undefined && /[a-z]/.test(c);

/** Does `needle` occur in `hay` as a whole term — a number not inside a longer number, a Latin word not inside a longer word? */
export function containsTerm(hay: string, needle: string): boolean {
  const h = matchForm(hay);
  const n = matchForm(needle);
  if (!n || (!hasCjk(n) && n.length < 2 && !isDigit(n))) return false;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) {
    const before = h[i - 1];
    const after = h[i + n.length];
    const first = n[0];
    const last = n[n.length - 1];
    const okBefore = !(isDigit(first) && isDigit(before)) && !(isLatin(first) && isLatin(before)) && !(isDigit(first) && before === '.');
    const okAfter = !(isDigit(last) && isDigit(after)) && !(isLatin(last) && isLatin(after)) && !(isDigit(last) && after === '.' && isDigit(h[i + n.length + 1]));
    if (okBefore && okAfter) return true;
  }
  return false;
}

/** Pairs [predicted, gold] where the predicted label holds the gold label or one of its aliases, longest names first, each used once. */
export function matchByAlias(predicted: string[], gold: GoldItem[]): [number, number][] {
  const names = gold.flatMap((g, gi) => [g.label, ...g.aliases].map((name) => ({ gi, name })));
  names.sort((a, b) => matchForm(b.name).length - matchForm(a.name).length);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const out: [number, number][] = [];
  for (const { gi, name } of names) {
    if (usedG.has(gi)) continue;
    const pi = predicted.findIndex((p, i) => !usedP.has(i) && containsTerm(p, name));
    if (pi < 0) continue;
    usedP.add(pi);
    usedG.add(gi);
    out.push([pi, gi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Where a label that lists several things divides: 、 , ; / | and the words for "and" / "or", outside brackets. */
const LIST_SEPARATOR = /^(?:[、,;/|]|以及|和|与|及|或|\s+(?:and|or)\s+)/i;
const OPEN = '(（[【「『“';
const CLOSE = ')）]】」』”';

/** A label's parts at its top-level list separators (thousands separators kept), trimmed, empty ones dropped. */
export function listParts(label: string): string[] {
  const s = foldThousands(label);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && depth > 0) depth--;
    else if (depth === 0) {
      const sep = s.slice(i).match(LIST_SEPARATOR);
      if (sep) {
        parts.push(s.slice(start, i));
        i += sep[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * An entry that lists several gold items in one label ("九部平台组、九部支付组
 * （归属不唯一）") stands for its parts, each counted as an item the answer
 * gave: it is a list written in one string, and scored as if written out, so
 * it can match one gold item per part, and a part that names nothing in the
 * gold lowers precision as a separate wrong entry would. Only when two or more
 * parts each name a different gold item: an entry that merely mentions two
 * names in one phrase ("九部平台组调往九部支付组") is one claim, and a label
 * whose parts name at most one gold item keeps its form (its precision does
 * not change for being written with a comma).
 */
export function splitListedItems<T extends { label: string }>(items: T[], gold: GoldItem[]): T[] {
  return items.flatMap((it) => {
    const parts = listParts(it.label);
    if (parts.length < 2 || matchByAlias(parts, gold).length < 2) return [it];
    return parts.map((label) => ({ ...it, label }));
  });
}

/** Pairs [predicted, gold] where the predicted label names every field of the gold item (one term of each group), each used once. */
export function matchByFields(predicted: string[], gold: GoldItem[]): [number, number][] {
  const usedP = new Set<number>();
  const out: [number, number][] = [];
  // the most specific items first, so a looser one does not take their label
  const order = gold.map((g, gi) => ({ g, gi })).sort((a, b) => (b.g.fields?.length ?? 0) - (a.g.fields?.length ?? 0));
  for (const { g, gi } of order) {
    if (!g.fields?.length) continue;
    const pi = predicted.findIndex((p, i) => !usedP.has(i) && g.fields!.every((group) => group.some((term) => containsTerm(p, term))));
    if (pi < 0) continue;
    usedP.add(pi);
    out.push([pi, gi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * The pairs of a judge-matched list (`list.match` judge) that need no judge
 * (2026-11 judge audit: a second pass agreed with the first on 69% of list
 * verdicts, and nearly every disagreement was a list of ten or more entries
 * with one or two borderline pairs). A predicted entry is paired with a gold
 * entry when its label names a term of that gold entry — the label itself,
 * or an alias: an id, a name, the value an event set — and no other unpaired
 * gold entry's term, with the dates agreeing where both have one (`nearDate`).
 * A term tells entries apart only where it is rare on both sides: one that
 * the question holds, or that more than one predicted entry names (a team
 * every entry is about), does not count, nor does a weak term — a number, or
 * a word of under two CJK or four Latin characters: "原报240" names the old
 * value of a change to 240. An entry that names several gold entries' terms is a merge, left to
 * the judge, as is everything not paired here; the judge then sees only the
 * unpaired entries of both lists. A contradiction's gold entries are topics
 * ("Payments's headcount"), not statements, and are all left to the judge.
 */
export function matchByAnchors(items: { label: string; date?: string }[], gold: GoldItem[], question = '', type = ''): [number, number][] {
  if (type === 'contradiction') return [];
  const q = matchForm(question);
  const strong = (term: string) => {
    const f = matchForm(term);
    if (/^[\d\s.,%-]+$/.test(f)) return false;
    return hasCjk(f) ? [...f.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, '')].length >= 2 : f.replace(/[^a-z0-9]/g, '').length >= 4;
  };
  const terms = gold.map((g) => [...new Set([g.label, ...g.aliases].map((x) => x.trim()).filter((x) => x && matchForm(x) && !(q && q.includes(matchForm(x)))))]
    .filter((x) => items.filter((it) => containsTerm(it.label, x)).length === 1));
  const usedG = new Set<number>();
  const out: [number, number][] = [];
  items.forEach((it, pi) => {
    const named: { gi: number; weak: boolean }[] = [];
    gold.forEach((g, gi) => {
      if (usedG.has(gi)) return;
      const hit = terms[gi].filter((t) => containsTerm(it.label, t));
      if (!hit.length) return;
      if (g.date && it.date && !nearDate(it.date, g.date)) return;
      named.push({ gi, weak: !hit.some(strong) });
    });
    // one gold entry named (after the dates ruled the others out), by a strong term
    const pick = named.length === 1 && !named[0].weak ? named[0] : undefined;
    if (!pick) return;
    usedG.add(pick.gi);
    out.push([pi, pick.gi]);
  });
  return out;
}

/** A cited path as a corpus document: prefixes the systems write stripped, a bare file name resolved when it names one document. */
export function evidenceDoc(cited: string, docs: Set<string>): string | undefined {
  const p = cited.trim().replace(/^\.\//, '').replace(/^(?:raw\/docs|raw|corpus)\//, '').replace(/[)\].,;:，。]+$/, '');
  if (docs.has(p)) return p;
  const base = p.split('/').pop();
  const named = [...docs].filter((d) => d.split('/').pop() === base);
  return named.length === 1 ? named[0] : undefined;
}

/** Pairs [predicted, gold] where the predicted item's evidence covers every document of the gold item. */
export function matchByDocs(evidence: string[][], gold: GoldItem[], docs: Set<string>): [number, number][] {
  const cited = evidence.map((ev) => new Set(ev.map((e) => evidenceDoc(e, docs)).filter((d): d is string => Boolean(d))));
  const usedP = new Set<number>();
  const out: [number, number][] = [];
  gold.forEach((g, gi) => {
    if (!g.docs?.length) return;
    const pi = cited.findIndex((c, i) => !usedP.has(i) && g.docs!.every((d) => c.has(d)));
    if (pi < 0) return;
    usedP.add(pi);
    out.push([pi, gi]);
  });
  return out.sort((a, b) => a[0] - b[0]);
}

/* ---------------------------------- dates ---------------------------------- */

export interface LooseDate {
  y?: number;
  m: number;
  d?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date as an answer writes it: 2026-04-12, 2026/4/12, 2026年4月12日, 4月12日, April 12, 2026, 12 April — or the gold's YYYY-MM. */
export function parseLooseDate(s: string): LooseDate | null {
  const t = s.normalize('NFKC').toLowerCase();
  // an ISO week (2024-W03, 2024年第3周, week 3 of 2024) as its Monday: the reports packs date a week's events so
  let m = t.match(/(\d{4})\s*-?w(\d{1,2})\b/) ?? t.match(/(\d{4})\s*年\s*第\s*(\d{1,2})\s*周/);
  const wk = m ? [m[1], m[2]] : t.match(/\bweek\s+(\d{1,2})\s+(?:of\s+)?(\d{4})/)?.slice(1, 3).reverse();
  if (wk) {
    const monday = isoWeekMonday(+wk[0], +wk[1]);
    if (monday) return { y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() };
  }
  m = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/);
  if (m) return { y: +m[1], m: +m[2], ...(m[3] ? { d: +m[3] } : {}) };
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) return { m: +m[1], d: +m[2] };
  m = t.match(/(\d{1,2})\s*月/);
  if (m && !/\d\s*月\s*\d/.test(t)) return { m: +m[1] };
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m) return { m: MONTHS.indexOf(m[1]) + 1, d: +m[2], ...(m[3] ? { y: +m[3] } : {}) };
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/);
  if (m) return { m: MONTHS.indexOf(m[2]) + 1, d: +m[1], ...(m[3] ? { y: +m[3] } : {}) };
  return null;
}

/** The Monday of ISO week `w` of `year`, or null for a week that is not one. */
export function isoWeekMonday(year: number, w: number): Date | null {
  if (!(w >= 1 && w <= 53)) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000);
  const d = new Date(monday1.getTime() + (w - 1) * 7 * 86_400_000);
  return w === 53 && new Date(d.getTime() + 3 * 86_400_000).getUTCFullYear() !== year ? null : d;
}

/**
 * Do a predicted and a gold date agree closely enough to tell one dated item from another: the gold date at
 * its precision, or, both to the day, within `days` of each other (a weekly report dates its week's events by
 * the week, an answer by the day it names).
 */
export function nearDate(predicted: string, gold: string, days = 6): boolean {
  if (sameDate(predicted, gold)) return true;
  const p = parseLooseDate(predicted);
  const g = parseLooseDate(gold);
  if (!p?.d || !g?.d || g.y === undefined) return false;
  const pt = Date.UTC(p.y ?? g.y, p.m - 1, p.d);
  const gt = Date.UTC(g.y, g.m - 1, g.d);
  return Math.abs(pt - gt) <= days * 86_400_000;
}

/** Does a predicted date name the gold date, at the gold's precision (a missing year is taken as the gold's)? */
export function sameDate(predicted: string, gold: string): boolean {
  const p = parseLooseDate(predicted);
  const g = parseLooseDate(gold);
  if (!p || !g) return false;
  if (p.y !== undefined && g.y !== undefined && p.y !== g.y) return false;
  if (p.m !== g.m) return false;
  return g.d === undefined || p.d === g.d;
}

/** Share of matched item pairs, among those whose gold dates differ, that the answer lists in the gold's order. */
export function orderAccuracy(pairs: [number, number][], gold: GoldItem[]): number | null {
  let right = 0;
  let total = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [pa, ga] = pairs[i];
      const [pb, gb] = pairs[j];
      const da = gold[ga].date ?? '';
      const db = gold[gb].date ?? '';
      if (!da || !db || da === db) continue;
      total++;
      if ((pa < pb) === (da < db)) right++;
    }
  }
  return total ? right / total : null;
}

/* --------------------------------- scoring --------------------------------- */

export function listSpec(t: Task): ListSpec {
  return t.list ?? ListSpecSchema.parse({});
}

export interface ListInput {
  answers: AnswerRecord[];
  tasks: Map<string, Task>;
  corpusDocs: Map<string, Set<string>>;
}

type Put = (a: AnswerRecord, t: Task, metric: string, value: number | null, detail?: Record<string, unknown>) => void;

/** A predicted entry as the judge sees it: label and date. */
const judgeEntry = (i: { label: string; date?: string }) => `${i.label}${i.date ? ` (${i.date})` : ''}`;

/** The gold as the judge sees it: label, date and aliases on one line. */
const goldLine = (g: GoldItem) => `${g.label}${g.date ? ` (${g.date})` : ''}${g.aliases.length ? ` / ${g.aliases.join(' / ')}` : ''}`;

export async function scoreLists(input: ListInput, judge: Judge): Promise<ScoreRecord[]> {
  const at = new Date().toISOString();
  const out: ScoreRecord[] = [];
  const put: Put = (a, t, metric, value, detail) =>
    out.push({ key: scoreKey(a, metric), pack: a.pack, system: a.system, suite: t.suite, taskId: t.id, taskType: t.type, metric, value, at, ...(repeatOf(a) !== undefined ? { repeat: repeatOf(a) } : {}), ...(detail ? { detail } : {}) });

  const toJudge: { id: string; a: AnswerRecord; t: Task; items: ReturnType<typeof parseStructured>['items']; anchored: [number, number][]; restP: number[]; restG: number[] }[] = [];
  for (const a of input.answers) {
    const t = input.tasks.get(`${a.pack}|${a.taskId}`);
    if (!t || !t.list || t.scoring !== 'set' || !t.items?.length || a.leaked?.length) continue;
    const spec = listSpec(t);
    const given = parseStructured(a.text).items.slice(0, spec.maxItems);
    // matched by name: an entry that lists several gold items counts as its parts
    const items = spec.match === 'alias' ? splitListedItems(given, t.items) : given;
    put(a, t, 'items_returned', items.length);
    if (spec.match === 'judge' && items.length) {
      // the pairs the gold's own terms settle, then the judge on what is left of both lists
      const anchored = matchByAnchors(items, t.items, t.question, t.type);
      // in a canonical order: the same entries in another order are the same question to the judge (and its cache)
      const restP = items.map((_, i) => i).filter((i) => !anchored.some(([p]) => p === i))
        .sort((x, y) => judgeEntry(items[x]).localeCompare(judgeEntry(items[y])) || x - y);
      const restG = t.items.map((_, i) => i).filter((i) => !anchored.some(([, g]) => g === i));
      if (restP.length && restG.length) toJudge.push({ id: judgeItemKey('list', a), a, t, items, anchored, restP, restG });
      else listScores(a, t, spec, anchored.sort((x, y) => x[0] - y[0]), items, input.corpusDocs.get(a.pack) ?? new Set(), put, { anchored: anchored.length, judged: 0 });
      continue;
    }
    const docs = input.corpusDocs.get(a.pack) ?? new Set<string>();
    const pairs = !items.length ? [] : spec.match === 'docs'
      ? matchByDocs(items.map((i) => i.evidence), t.items, docs)
      : spec.match === 'fields' ? matchByFields(items.map((i) => i.label), t.items)
        : matchByAlias(items.map((i) => i.label), t.items);
    listScores(a, t, spec, pairs, items, docs, put);
  }

  const verdicts = await judge.matchList(toJudge.map((j) => ({
    id: j.id,
    predicted: j.restP.map((i) => judgeEntry(j.items[i])),
    gold: j.restG.map((i) => goldLine(j.t.items![i])),
  })));
  for (const j of toJudge) {
    const v = verdicts.get(j.id);
    if (!v) continue;
    // the judge's pairs are over the unpaired entries: back to the lists' own indices
    const judged = canonicalPairs(v.pairs, j.restP.length, j.restG.length).map(([p, g]) => [j.restP[p], j.restG[g]] as [number, number]);
    const pairs = [...j.anchored, ...judged].sort((x, y) => x[0] - y[0]);
    listScores(j.a, j.t, listSpec(j.t), pairs, j.items, input.corpusDocs.get(j.a.pack) ?? new Set(), put, { anchored: j.anchored.length, judged: judged.length });
  }
  return out;
}

/** Set precision / recall / F1 over the matched pairs, and what the task type adds: order and dates, attribution. */
export function listScores(
  a: AnswerRecord, t: Task, spec: ListSpec, matched: [number, number][], items: { label: string; evidence: string[]; date?: string; confidence: number | null }[],
  docs: Set<string>, put: Put, how?: { anchored: number; judged: number },
): void {
  const gold = t.items!;
  const cited = (i: number) => new Set(items[i].evidence.map((e) => evidenceDoc(e, docs)).filter((d): d is string => Boolean(d)));
  // "which sources": a side found without one of its documents is not found
  const pairs = spec.requireDocs ? matched.filter(([p, g]) => (gold[g].docs ?? []).some((d) => cited(p).has(d))) : matched;
  const totalWeight = gold.reduce((s, g) => s + g.weight, 0);
  const hitWeight = pairs.reduce((s, [, g]) => s + gold[g].weight, 0);
  const precision = items.length ? pairs.length / items.length : 0;
  const recall = totalWeight ? hitWeight / totalWeight : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  put(a, t, 'set_precision', precision);
  put(a, t, 'set_recall', recall, { matched: pairs.map(([p, g]) => [items[p].label, gold[g].label]), ...(how ? { pairedBy: how } : {}) });
  put(a, t, 'set_f1', f1);
  // exact: the whole set, nothing missing and nothing extra
  let correctness = spec.primary === 'recall' ? recall : spec.primary === 'exact' ? (pairs.length === gold.length && items.length === gold.length ? 1 : 0) : f1;
  if (spec.ordered) {
    const order = orderAccuracy(pairs, gold);
    put(a, t, 'order_accuracy', order);
    if (order !== null) correctness *= order;
    const dated = pairs.filter(([p, g]) => gold[g].date && items[p].date);
    put(a, t, 'date_accuracy', pairs.length ? dated.filter(([p, g]) => sameDate(items[p].date!, gold[g].date!)).length / pairs.length : null);
  }
  const attributed = pairs.filter(([, g]) => gold[g].docs?.length);
  if (attributed.length) {
    put(a, t, 'attribution_recall', attributed.reduce((s, [p, g]) => s + gold[g].docs!.filter((d) => cited(p).has(d)).length / gold[g].docs!.length, 0) / attributed.length);
  }
  put(a, t, 'correctness', correctness, { metric: spec.primary === 'recall' ? 'set_recall' : spec.primary === 'exact' ? 'exact_set' : 'set_f1', ...(spec.ordered ? { times: 'order_accuracy' } : {}) });
  // a look-alike's items given for the asked entity's
  const distractors = Array.isArray(t.meta?.distractors) ? (t.meta!.distractors as unknown[]).map(String) : [];
  if (distractors.length) {
    const took = items.filter((it, i) => !pairs.some(([p]) => p === i) && distractors.some((d) => containsTerm(it.label, d))).length;
    put(a, t, 'distractor_rate', items.length ? took / items.length : 0);
    put(a, t, 'stale_answer', took > 0 ? 1 : 0);
  }
  // wrong, and said with confidence (no confidence given counts as confident)
  if (items.length) {
    const stated = items.map((it) => it.confidence ?? 1);
    put(a, t, 'confident_wrong', correctness < 0.5 && stated.reduce((x, y) => x + y, 0) / stated.length >= 0.7 ? 1 : 0);
  }
  const conf = items.map((it, i) => (it.confidence === null ? null : (it.confidence - (pairs.some(([p]) => p === i) ? 1 : 0)) ** 2)).filter((x): x is number => x !== null);
  if (conf.length) put(a, t, 'brier', conf.reduce((s, x) => s + x, 0) / conf.length);
}
