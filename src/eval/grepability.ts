import fs from 'node:fs';
import path from 'node:path';
import type { LoadedPack } from './pack.js';
import { lexicalTokens } from './packs/separation.js';
import { Bm25 } from './retrieval.js';
import type { Task } from './types.js';

/**
 * How far a literal search gets on a pack, without a model (docs/design/33
 * §4, stage 2 E): for each question family, the share of questions whose
 * gold documents all hold a literal term of the question, and the share whose
 * first-step document (its first evidence document) does.
 *
 * A term is what a grep would narrow with: a word of the question (a
 * two-character sequence without a function character in Chinese, a content
 * word in English), a name of the pack's alias gold that the question holds,
 * or an id ("INC-1104", "R-114", "PLT1-C2") — and only when at most `share`
 * of the corpus holds it (5% by default), since a word in every report narrows
 * nothing. Gold documents are the set items' documents where items name them,
 * else `meta.goldDocs`, else the evidence.
 *
 * Beside the two shares, a ranking that does not depend on a threshold: the
 * share of questions whose gold documents all, and whose first-step document,
 * are among the ten documents a BM25 search on the question's text ranks
 * first (the harness's own index, whole documents).
 */

const ZH_FUNCTION = /[的了是个起在有和这那也就都与着或被把给从到对为以之其几么吗呢里一]/;
const ID = /\b[A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

/** The family of a task: design 33's for v3 packs (`meta.family`), the nearest one for older packs' types. */
export function familyFor(t: Task): string {
  // a localization pack's rows are its strata (docs/design/37 §2)
  if (t.type === 'localization') return `localization:${String(t.meta?.stratum ?? 'plain')}`;
  const f = typeof t.meta?.family === 'string' ? t.meta.family : '';
  const v3 = ['aggregate', 'current-state', 'alias', 'hop', 'timeline', 'lookalike', 'update', 'control-exact', 'control-paraphrase', 'control-xl'];
  if (v3.includes(f)) return f;
  switch (t.type) {
    case 'aggregate': case 'structured': case 'aggregation': return 'aggregate';
    case 'stale': return 'current-state';
    case 'lookalike': return t.meta?.subtype === 'rename' ? 'alias' : 'lookalike';
    case 'ambiguous': case 'unanswerable': return 'lookalike';
    case 'deep-hop': case 'nonlexical-hop': case 'multi-hop': return 'hop';
    case 'timeline': case 'temporal': return 'timeline';
    case 'update': return 'update';
    case 'paraphrase': return 'control-paraphrase';
    case 'cross-lingual': return 'control-xl';
    case 'single-hop': return 'control-exact';
    default: return `other:${t.type}`;
  }
}

export interface GrepRow { family: string; n: number; allGold: number; firstStep: number; top10All: number; top10First: number }
export interface GrepResult { pack: string; docs: number; share: number; rows: GrepRow[] }

export function grepability(pack: LoadedPack, share = 0.05): GrepResult {
  const lang = (t: Task): 'zh' | 'en' => ((t.lang ?? pack.manifest.languages[0]) === 'zh' ? 'zh' : 'en');
  const texts = new Map<string, string>();
  for (const d of pack.docs) {
    const f = path.join(pack.dir, 'corpus', d.path);
    texts.set(d.path, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  }
  const N = pack.docs.length;
  const limit = Math.max(1, Math.floor(N * share));
  const aliasStrings = [...new Set(pack.aliases.flatMap((a) => a.aliases).filter((s) => s.length >= 2))].sort((a, b) => b.length - a.length);
  // the request itself: a localization task's commit message without the frame every task shares
  const askOf = (t: Task) => (typeof t.meta?.message === 'string' ? t.meta.message : t.question);
  const termsOf = (t: Task): string[] => {
    const l = lang(t);
    const q = askOf(t);
    const words = [...lexicalTokens(l, q)].filter((x) => l === 'en' || !ZH_FUNCTION.test(x));
    const names = aliasStrings.filter((s) => q.includes(s));
    const ids = q.match(ID) ?? [];
    return [...new Set([...words, ...names, ...ids])];
  };
  const tasks = pack.tasks;
  const terms = new Map(tasks.map((t) => [t.id, termsOf(t)]));
  // document frequencies: words through each document's own tokens, names and ids by a substring test
  const df = new Map<string, number>();
  const wordTerms = new Set<string>();
  const stringTerms = new Set<string>();
  for (const t of tasks) for (const x of terms.get(t.id)!) (/^[㐀-鿿]{2}$/.test(x) || /^[a-z][a-z'-]*$/.test(x) ? wordTerms : stringTerms).add(x);
  const langs = new Set(tasks.map(lang));
  for (const text of texts.values()) {
    const seen = new Set<string>();
    for (const l of langs) for (const tok of lexicalTokens(l, text)) if (wordTerms.has(tok)) seen.add(tok);
    for (const s of stringTerms) if (text.includes(s)) seen.add(s);
    for (const x of seen) df.set(x, (df.get(x) ?? 0) + 1);
  }
  const enTokens = new Map<string, Set<string>>();
  const holds = (doc: string, x: string, l: 'zh' | 'en') => {
    const text = texts.get(doc) ?? '';
    if (!wordTerms.has(x) || stringTerms.has(x) || l === 'zh') return text.includes(x);
    if (!enTokens.has(doc)) enTokens.set(doc, lexicalTokens('en', text));
    return enTokens.get(doc)!.has(x);
  };
  const bm25 = new Bm25(pack.docs.map((d) => d.path), (p) => texts.get(p) ?? '');
  const by = new Map<string, { n: number; all: number; first: number; tAll: number; tFirst: number }>();
  for (const t of tasks) {
    const l = lang(t);
    const narrow = terms.get(t.id)!.filter((x) => (df.get(x) ?? 0) > 0 && (df.get(x) ?? 0) <= limit);
    const itemDocs = (t.items ?? []).flatMap((it) => it.docs ?? []);
    const metaDocs = Array.isArray(t.meta?.goldDocs) ? (t.meta!.goldDocs as string[]) : [];
    const gold = [...new Set(itemDocs.length ? itemDocs : metaDocs.length ? metaDocs : t.evidence.map((e) => e.doc))].filter((d) => texts.has(d));
    const first = t.evidence.map((e) => e.doc).find((d) => texts.has(d));
    if (!gold.length && !first) continue;
    const row = by.get(familyFor(t)) ?? by.set(familyFor(t), { n: 0, all: 0, first: 0, tAll: 0, tFirst: 0 }).get(familyFor(t))!;
    row.n++;
    if (gold.length && gold.every((d) => narrow.some((x) => holds(d, x, l)))) row.all++;
    if (first && narrow.some((x) => holds(first, x, l))) row.first++;
    const top = new Set(bm25.search(askOf(t), 10).map((h) => h.item));
    if (gold.length && gold.every((d) => top.has(d))) row.tAll++;
    if (first && top.has(first)) row.tFirst++;
  }
  const rows = [...by].map(([family, r]) => ({ family, n: r.n, allGold: r.all / r.n, firstStep: r.first / r.n, top10All: r.tAll / r.n, top10First: r.tFirst / r.n })).sort((a, b) => a.family.localeCompare(b.family));
  return { pack: pack.manifest.id, docs: N, share, rows };
}

export function formatGrepability(rs: GrepResult[]): string {
  const families = [...new Set(rs.flatMap((r) => r.rows.map((x) => x.family)))].sort();
  const head = `| family | ${rs.map((r) => `${r.pack}: n · all gold · first step · BM25@10 all · BM25@10 first`).join(' | ')} |`;
  const lines = [head, `| --- | ${rs.map(() => '---').join(' | ')} |`];
  for (const f of families) {
    lines.push(`| ${f} | ${rs.map((r) => {
      const x = r.rows.find((y) => y.family === f);
      const pc = (v: number) => `${(v * 100).toFixed(0)}%`;
      return x ? `${x.n} · ${pc(x.allGold)} · ${pc(x.firstStep)} · ${pc(x.top10All)} · ${pc(x.top10First)}` : '—';
    }).join(' | ')} |`);
  }
  const tot = (r: GrepResult, k: 'allGold' | 'firstStep' | 'top10All' | 'top10First') => {
    const n = r.rows.reduce((a, x) => a + x.n, 0);
    return n ? (r.rows.reduce((a, x) => a + x[k] * x.n, 0) / n) * 100 : 0;
  };
  lines.push(`| all | ${rs.map((r) => `${r.rows.reduce((a, x) => a + x.n, 0)} · ${tot(r, 'allGold').toFixed(0)}% · ${tot(r, 'firstStep').toFixed(0)}% · ${tot(r, 'top10All').toFixed(0)}% · ${tot(r, 'top10First').toFixed(0)}%`).join(' | ')} |`);
  return lines.join('\n');
}
