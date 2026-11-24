import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mapLimit } from '../../bench/util.js';
import { listFiles } from '../pack.js';
import type { SourceRecord, Task } from '../types.js';
import { datasetFile, fetchJson } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, opaquePath, type Family } from './real-docs.js';
import { PackWriter } from './writer.js';

/**
 * real-wildgraphbench: WildGraphBench (Wang et al., 2026, arXiv 2602.02053,
 * ACL 2026 Findings; Apache-2.0) — for each of twelve Wikipedia articles, the
 * external pages the article cites (news sites, blogs, reports, PDFs turned
 * to text: long, noisy, of every kind) as the corpus, and questions written
 * from the article's cited statements: single-fact (one reference), multi-fact
 * (several references) and summary (a section's statements). The Wikipedia
 * article itself is "for reference only": it holds the answers, and is
 * neither fetched nor put in the corpus. No model is used.
 *
 * `{"domains": [...]}` chooses the domains (or "all"); the default is the
 * three smallest — mathematics (Prime number), nature (2012 Pacific typhoon
 * season) and history (World War II): 193 pages and 97 questions, of which
 * only 2 are multi-fact, so the default pack says nothing about that type
 * (technology, culture and people have 32–37 each). The benchmark builds one
 * graph per domain; here the chosen domains share one corpus, each page under
 * its domain's folder, and a question that does not name its topic is asked
 * with it.
 *
 * **Scoring, and where it differs from the benchmark's.**
 * - Single-fact and multi-fact questions are usage tasks judged against the
 *   dataset's answer. The benchmark's judge says right or wrong; the suite's
 *   grades 0–2, so a half-right answer counts half here.
 * - A summary question is scored as the suite scores a profile: the answer
 *   is a list of facts, matched one to one against the dataset's
 *   `gold_statements` by the judge, with set precision, recall and F1
 *   reported and F1 as the task's correctness (the gold is the section's
 *   whole content, not a sample). The benchmark instead has a model split a
 *   free-text summary into at most 20 statements, counts a gold statement as
 *   recalled when the whole answer supports it and a candidate statement as
 *   precise when the whole reference supports it. So here a system writes
 *   its own items (one that packs two facts into an item can match only one
 *   gold statement), and a match is a pair, not a statement against a
 *   paragraph: expect lower recall and precision than the benchmark's for
 *   the same answer. A summary whose references are five pages or more is
 *   typed `profile`; with fewer it is `global` (the profile type requires
 *   five evidence documents), scored the same way.
 *
 * **Comparable numbers** (the paper's main table, gpt-4o-mini, all twelve
 * domains, one graph each): single-fact accuracy 66.9 for flat RAG and 71.5
 * for HippoRAG 2; multi-fact 35.1 and 39.3 (Microsoft GraphRAG global 47.6);
 * summary F1 15.8 and 13.4. A pack of other domains, pooled, with these
 * scorers is not that table: single-fact accuracy is the nearest, summary F1
 * the furthest.
 */

export const WGB_DOMAINS = ['culture', 'geography', 'health', 'history', 'human_activities', 'mathematics', 'nature', 'people', 'philosophy', 'religion', 'society', 'technology'] as const;
const DEFAULT_DOMAINS = ['mathematics', 'nature', 'history'];
const REVISION = 'bdac7ee73d42901ded65cb438a0f7b1aecd5e67b';
const REPO = 'Bstwpy/WildGraphBench';
const LICENSE = 'Apache-2.0 (WildGraphBench); the reference pages are third-party web pages as the dataset collected them';

export interface WgbQuestion {
  question: string;
  question_type: string[] | string;
  answer?: string;
  gold_statements?: string[];
  ref_urls?: string[];
}

/** The domains a build takes: the option as a list, a comma-separated string or "all". */
export function domainsOf(option: unknown): string[] {
  if (option === undefined || option === null) return DEFAULT_DOMAINS;
  const asked = option === 'all' ? [...WGB_DOMAINS] : (Array.isArray(option) ? option.map(String) : String(option).split(',')).map((d) => d.trim()).filter(Boolean);
  const unknown = asked.filter((d) => !(WGB_DOMAINS as readonly string[]).includes(d));
  if (!asked.length || unknown.length) throw new Error(`domains: one or more of ${WGB_DOMAINS.join(', ')}, or "all" (got ${JSON.stringify(option)})`);
  // the benchmark's order, each once
  return WGB_DOMAINS.filter((d) => asked.includes(d));
}

/** The pack id: the base for the default domains, the domains in its name otherwise. */
export function wgbPackId(domains: string[]): string {
  if (domains.join() === domainsOf(undefined).join()) return 'real-wildgraphbench';
  return domains.length === WGB_DOMAINS.length ? 'real-wildgraphbench-all' : `real-wildgraphbench-${domains.map((d) => d.replace(/_/g, '-')).join('-')}`;
}

export const questionType = (q: WgbQuestion) => String(Array.isArray(q.question_type) ? q.question_type[0] ?? '' : q.question_type ?? '').trim().toLowerCase().replace(/_/g, '-');

/** A URL as two references to the same page may write it: no scheme, `www.`, fragment or trailing slash, lower-cased host. */
export function urlKey(url: string): string {
  const t = url.trim().replace(/^https?:\/\//i, '').replace(/#.*$/, '').replace(/\/+$/, '');
  const slash = t.indexOf('/');
  const host = (slash < 0 ? t : t.slice(0, slash)).toLowerCase().replace(/^www\./, '');
  return host + (slash < 0 ? '' : t.slice(slash));
}

const safeSegment = (s: string) => s.replace(/[^\w.\-]+/g, '_').slice(0, 80);
/** Where a file of the dataset lies in the download cache: its path made safe, with a hash so no two collide. */
const cacheName = (rel: string) => `Bstwpy__WildGraphBench/${REVISION.slice(0, 8)}/${rel.split('/').map(safeSegment).join('/')}.${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 8)}`;
const urlOf = (rel: string) => `https://huggingface.co/datasets/${REPO}/resolve/${REVISION}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** The files under `corpus/<domain>/`, relative to the dataset's root: from a local copy, else from the repository's listing. */
async function listDomain(domain: string, from: string | undefined): Promise<{ files: string[]; record?: SourceRecord }> {
  if (from) {
    const dir = path.join(from, 'corpus', domain);
    if (!fs.existsSync(dir)) throw new Error(`${dir} is missing: a local copy of WildGraphBench holds corpus/<domain>/<topic>/reference_pages/`);
    return { files: listFiles(dir).map((f) => `corpus/${domain}/${f}`) };
  }
  const { json, record } = await fetchJson<{ type: string; path: string }[]>(`https://huggingface.co/api/datasets/${REPO}/tree/${REVISION}/corpus/${domain}?recursive=true&limit=1000`, { license: LICENSE, name: `Bstwpy__WildGraphBench/${REVISION.slice(0, 8)}/tree-${domain}.json` });
  if (json.length >= 1000) throw new Error(`WildGraphBench: the listing of corpus/${domain} is cut at ${json.length} entries`);
  return { files: json.filter((e) => e.type === 'file').map((e) => e.path).sort(), record: { ...record, note: `listing of corpus/${domain}` } };
}

interface PageDoc {
  domain: string;
  topic: string;
  /** Its path in the dataset. */
  rel: string;
  /** Its path in the pack's corpus. */
  path: string;
  title: string;
  text: string;
}

export interface WgbReference {
  /** Every URL the reference's record holds (the page's, an archive's). */
  urls: string[];
  title?: string;
  /** The reference page it was saved as, by file name, when the record names one that exists. */
  page?: string;
}

const stemOf = (file: string) => path.basename(file).replace(/\.txt$/i, '');
/** A title as a file name keeps it: letters and digits only, lower-cased. */
const bare = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * references.jsonl, read for what ties a question's `ref_urls` to a saved
 * page: each record's URLs, its title, and the page file it names — a field
 * holding a file of `reference_pages/`, else the page whose file name is the
 * record's title (the dataset names pages by their titles, shortened).
 */
export function readReferences(jsonl: string, pages: string[]): WgbReference[] {
  const byName = new Map(pages.map((p) => [path.basename(p), p]));
  const byStem = new Map(pages.map((p) => [bare(stemOf(p)), p]));
  const out: WgbReference[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const strings = Object.entries(rec).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as const] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => [k, x] as const) : []));
    const urls = [...new Set(strings.filter(([, v]) => /^https?:\/\//i.test(v.trim())).map(([, v]) => v.trim()))];
    const title = strings.find(([k]) => /title/i.test(k))?.[1];
    const named = strings.map(([, v]) => byName.get(path.basename(v)) ?? byName.get(`${path.basename(v)}.txt`)).find(Boolean);
    const page = named ?? (title && bare(title) ? byStem.get(bare(title)) ?? [...byStem].find(([stem]) => stem.length >= 12 && bare(title).startsWith(stem))?.[1] : undefined);
    if (urls.length) out.push({ urls, ...(title ? { title } : {}), ...(page ? { page } : {}) });
  }
  return out;
}

const TYPES: Record<string, { type: Task['type']; family: Family }> = {
  'single-fact': { type: 'single-hop', family: 'controls' },
  'multi-fact': { type: 'multi-hop', family: 'hops' },
  summary: { type: 'profile', family: 'aggregates' },
};

/** A domain's questions as tasks; a string says why one is left out. */
export function wgbTask(q: WgbQuestion, at: { domain: string; topic: string; index: number }, docOf: (url: string) => string | null): Task | string {
  const kind = questionType(q);
  const known = TYPES[kind];
  if (!known) return `a question of another type (${kind || 'none'})`;
  const refs = [...new Set((q.ref_urls ?? []).map((u) => u.trim()).filter(Boolean))];
  const resolved = refs.map(docOf);
  const docs = [...new Set(resolved.filter((d): d is string => Boolean(d)))];
  const missing = resolved.filter((d) => !d).length;
  // an answer whose page the corpus lacks cannot be found in it
  if (!docs.length) return 'no reference page in the corpus';
  if (missing && kind !== 'summary') return 'a reference page the corpus lacks';
  // asked of several topics at once, a question says which it is about
  const named = q.question.toLowerCase().includes(at.topic.toLowerCase());
  const question = named ? q.question.trim() : `${q.question.trim()} (Topic: ${at.topic}.)`;
  const base = {
    id: `wgb-${at.domain.replace(/_/g, '-')}-${String(at.index).padStart(3, '0')}`, suite: 'usage' as const, lang: 'en', question,
    evidence: docs.map((doc) => ({ doc })),
    meta: {
      source: 'wildgraphbench', domain: at.domain, topic: at.topic, datasetIndex: at.index, datasetType: kind, family: known.family, hops: docs.length, references: refs.length,
      stratum: `${at.domain}-${kind}`, ...(question !== q.question.trim() ? { originalQuestion: q.question.trim() } : {}), ...(missing ? { missingReferences: missing } : {}),
    },
  };
  if (kind === 'summary') {
    const statements = [...new Set((q.gold_statements ?? []).map((s) => s.trim()).filter(Boolean))];
    if (!statements.length) return 'a summary without gold statements';
    if (statements.length > 55) return 'more gold statements than a list may hold';
    return {
      ...base, type: docs.length >= 5 ? 'profile' : 'global', scoring: 'set', items: statements.map((label) => ({ label, aliases: [], weight: 1 })),
      list: { match: 'judge', ordered: false, maxItems: Math.min(60, Math.max(20, statements.length + 5)), requireDocs: false, primary: 'f1' },
      // a summary missing one of its references is asked, but is not part of the headline
      primary: !missing,
    };
  }
  const answer = (q.answer ?? '').trim();
  if (!answer) return 'a question without an answer';
  return { ...base, type: known.type, scoring: 'judge', answer, primary: true };
}

async function buildWildGraphBench(dir: string, ctx: RecipeContext) {
  const domains = domainsOf(ctx.options.domains);
  const from = ctx.options.from ? path.resolve(String(ctx.options.from)) : undefined;
  const file = (rel: string) => datasetFile({ url: urlOf(rel), from, rel, license: LICENSE, name: cacheName(rel), maxBytes: 100 * 1024 * 1024 });
  const sources: SourceRecord[] = [];
  const docs: PageDoc[] = [];
  const all: Task[] = [];
  const left: Record<string, number> = {};
  const counts: string[] = [];

  for (const domain of domains) {
    const listing = await listDomain(domain, from);
    if (listing.record) sources.push(listing.record);
    const pages = listing.files.filter((f) => /\/reference_pages\/[^/]+\.txt$/i.test(f));
    const refsFile = listing.files.find((f) => /\/references\.jsonl$/.test(f));
    if (!pages.length || !refsFile) throw new Error(`WildGraphBench: corpus/${domain} holds no reference pages or no references.jsonl`);
    const topic = pages[0].split('/')[2];
    const refs = await file(refsFile);
    sources.push({ ...refs.record, note: [refs.record.note, `${domain}: reference metadata`].filter(Boolean).join('; ') });
    const references = readReferences(fs.readFileSync(refs.file, 'utf8'), pages);
    const titleOf = new Map(references.filter((r) => r.page && r.title).map((r) => [r.page!, r.title!]));

    // a page that cannot be had stops the build: a corpus short of a page is another corpus
    const failed: string[] = [];
    const fetched = await mapLimit(pages, 4, async (rel) => ({ rel, got: await file(rel) }), (err, rel) => failed.push(`${rel}: ${(err as Error).message.slice(0, 160)}`));
    if (failed.length) throw new Error(`WildGraphBench: ${failed.length} reference pages of ${domain} could not be read — ${failed.slice(0, 3).join('; ')}`);
    const pathOf = new Map<string, string>();
    for (const { rel, got } of fetched.filter((f): f is NonNullable<typeof f> => Boolean(f))) {
      sources.push({ ...got.record, note: [got.record.note, `${domain}: reference page`].filter(Boolean).join('; ') });
      const text = fs.readFileSync(got.file, 'utf8').replace(/\r\n?/g, '\n').trim();
      if (!text) continue;
      const p = opaquePath(`pages/${domain}`, rel);
      pathOf.set(rel, p);
      docs.push({ domain, topic, rel, path: p, title: (titleOf.get(rel) ?? stemOf(rel)).trim(), text });
    }
    // a question's reference, by any URL its record holds
    const byUrl = new Map<string, string>();
    for (const r of references) if (r.page && pathOf.has(r.page)) for (const u of r.urls) if (!byUrl.has(urlKey(u))) byUrl.set(urlKey(u), pathOf.get(r.page)!);

    const qs = await file(`QA/${domain}/questions.jsonl`);
    sources.push({ ...qs.record, note: [qs.record.note, `${domain}: questions`].filter(Boolean).join('; ') });
    const rows = fs.readFileSync(qs.file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as WgbQuestion);
    let kept = 0;
    rows.forEach((q, index) => {
      const t = wgbTask(q, { domain, topic, index }, (u) => byUrl.get(urlKey(u)) ?? null);
      if (typeof t === 'string') left[`${domain}: ${t}`] = (left[`${domain}: ${t}`] ?? 0) + 1;
      else {
        all.push(t);
        kept++;
      }
    });
    counts.push(`${domain} (${topic}): ${pathOf.size} pages, ${kept} of ${rows.length} questions`);
  }
  for (const c of counts) ctx.log(`WildGraphBench: ${c}`);
  for (const [why, n] of Object.entries(left)) ctx.log(`WildGraphBench: ${n} questions left out — ${why}`);

  const by = (kind: string) => all.filter((t) => t.meta?.datasetType === kind).length;
  const writer = new PackWriter(dir, {
    id: wgbPackId(domains),
    version: 1,
    title: 'WildGraphBench: questions from a Wikipedia article over the noisy web pages it cites',
    domain: 'public',
    languages: ['en'],
    description: `${all.length} WildGraphBench questions (${by('single-fact')} single-fact, ${by('multi-fact')} multi-fact, ${by('summary')} summary) of the domains ${domains.join(', ')}, over the ${docs.length} reference pages their Wikipedia articles cite, as one corpus; the articles themselves are left out. Single- and multi-fact answers are judged against the dataset's; a summary is a list of facts matched against the dataset's gold statements (set F1).`,
    builder: { recipe: 'real-wildgraphbench', options: { domains } },
  });
  for (const s of sources) writer.addSource(s);
  for (const d of docs) writer.addDoc({ path: d.path, title: d.title, lang: 'en', source: 'wildgraphbench', kind: 'web-page' }, `# ${d.title}\n\n${d.text}\n`);
  return finishRealPack(writer, all, ctx);
}

export function registerWildGraphBenchRecipe(): void {
  registerRecipe({ id: 'real-wildgraphbench', title: 'WildGraphBench: single-fact, multi-fact and summary questions over the web pages a Wikipedia article cites', domain: 'public', network: true, needsAuthor: false, build: buildWildGraphBench });
}
