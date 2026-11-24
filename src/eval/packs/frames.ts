import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { stratified } from '../pack.js';
import type { SourceRecord, Task } from '../types.js';
import { datasetFile, fetchCached } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, opaquePath, questionCount } from './real-docs.js';
import { framesTask, type FramesRow } from './wiki-hops.js';
import { wikitextToText } from './wikitext.js';
import { PackWriter } from './writer.js';

/**
 * public-frames: FRAMES (Krishna et al., 2024, arXiv 2409.12941; Apache-2.0)
 * in a shared-pool setting — a seeded sample of its 824 questions (100 by
 * default, across reasoning types and numbers of articles), each needing
 * 2–15 Wikipedia articles, and every article of every sampled question as
 * one corpus. A question's articles are other questions' distractors, so a
 * system has to find them before it can reason over them. No model is used:
 * questions, answers, links and reasoning types are the dataset's.
 *
 * The dataset ships links only. Each article is the last revision before
 * 2024-10 (the dataset's release), so the text is what its annotators read:
 * fetched as wikitext from the Wikipedia API into the download cache, one
 * request an article, a few seconds apart, with a generic user agent (the
 * same revisions scripts/eval-fetch-wikipedia.py fetches for real-wiki-hops;
 * `{"wikipedia": "<dir>"}` reads such a download instead of fetching). A
 * question with an article that cannot be had is passed over for the next of
 * its stratum.
 *
 * `meta.reasoningTypes` keeps the dataset's labels (numerical reasoning,
 * tabular reasoning, multiple constraints, temporal reasoning,
 * post-processing); the task type is the nearest of the suite's (temporal,
 * numeric, deep-hop from three articles, multi-hop). Answers are judged
 * against the dataset's, as the paper's auto-rater does; the suite's judge
 * grades 0–2 where theirs is right or wrong, so a half-right answer counts
 * half here.
 *
 * **Comparable numbers** (the dataset card, Gemini 1.5 Pro, all 824): no
 * retrieval 40.8%, BM25 with 4 documents 47.4%, multi-step retrieval 66%,
 * and 72.9% with every gold article given (oracle). Their retrieval runs over
 * all of Wikipedia; this pool holds a few hundred articles, every one of
 * them gold for some question, so finding an article is easier here than
 * there and harder than the oracle. The oracle row is the nearest ceiling
 * for a reader of the same strength; none of the rows is this setting.
 * real-wiki-hops asks all 824 over FanOutQA's articles as well.
 */

const REVISION = '58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef';
const TSV = `https://huggingface.co/datasets/google/frames-benchmark/resolve/${REVISION}/test.tsv`;
const LICENSE = 'Apache-2.0 (FRAMES)';
const WIKI_LICENSE = 'CC-BY-SA-4.0 (Wikipedia)';
const API = 'https://en.wikipedia.org/w/api.php';
/** FRAMES was released in October 2024: the last revision before it. */
const EPOCH = '2024-09-30T23:59:59Z';
const USER_AGENT = 'dataset-fetch/0.1';
const PACE_MS = 2000;

interface Page {
  title: string;
  pageid: number;
  revid: number;
  timestamp?: string;
  wikitext: string;
}

/** Rows of a tab-separated file whose fields may be quoted (a quote doubled inside, tabs and line breaks kept). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let start = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && start) quoted = true;
    else if (c === '\t') {
      row.push(cell);
      cell = '';
      start = true;
      continue;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      start = true;
      continue;
    } else cell += c;
    start = false;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** FRAMES's rows with every link each names: its `wikipedia_link_*` columns (the last may hold several) and its `wiki_links` list. */
export function readFramesRows(tsv: string): FramesRow[] {
  const [head, ...lines] = parseTsv(tsv);
  // a cell holds one link, or several after ", "; a link may itself hold a comma (Lincoln,_Nebraska) and a note may follow it
  const urls = (s: string) => s.split(/\s+/).filter((t) => /^https?:\/\//i.test(t)).map((t) => t.replace(/,+$/, ''));
  // `wiki_links` is a list as Python prints it: each link in quotes
  const listed = (s: string) => [...s.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2]).trim()).filter((t) => /^https?:\/\//i.test(t));
  return lines.map((cells) => {
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = cells[i] ?? ''));
    const links = [...new Set([...head.filter((h) => h.startsWith('wikipedia_link')).flatMap((h) => urls(row[h])), ...listed(row.wiki_links ?? '')])];
    return { index: (row[''] ?? row['Unnamed: 0'] ?? row.index ?? '').trim(), Prompt: row.Prompt ?? '', Answer: row.Answer ?? '', reasoning_types: row.reasoning_types ?? '', links };
  }).filter((r) => r.Prompt.trim() && r.Answer.trim());
}

/** The article a link names: its title as the API takes it, or null for a link that is not to English Wikipedia. */
export function titleOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^en(\.m)?\.wikipedia\.org$/.test(u.hostname)) return null;
    // /wiki/<title>, or /w/index.php?title=<title> (not a search)
    const named = u.pathname.startsWith('/wiki/') ? decodeURIComponent(u.pathname.slice('/wiki/'.length)) : u.pathname === '/w/index.php' && !u.searchParams.has('search') ? u.searchParams.get('title') ?? '' : '';
    const title = named.replace(/_/g, ' ').trim();
    return title || null;
  } catch {
    return null;
  }
}

const reasoningTypes = (r: FramesRow) => r.reasoning_types.split('|').map((s) => s.trim()).filter(Boolean);
/** What the sample is drawn across: the reasoning types a question combines and how many articles it needs. */
const stratumOf = (r: FramesRow) => `${reasoningTypes(r).sort().join('+') || 'none'}|${Math.min(r.links.length, 5)}`;

interface Articles {
  /** The article behind a link, or null when it cannot be had. */
  get(url: string): Promise<Page | null>;
  sources(used: Page[]): SourceRecord[];
}

/** Articles from a download in the layout of scripts/eval-fetch-wikipedia.py: `index.jsonl` and `pages/<revid>.json.gz`. */
function localArticles(dir: string): Articles {
  const index = new Map<string, number>();
  for (const line of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { key: string; revid?: number | string };
    if (r.revid !== undefined && Number.isInteger(Number(r.revid))) index.set(r.key, Number(r.revid));
  }
  return {
    async get(url) {
      const revid = index.get(`frames:${url}`);
      const file = path.join(dir, 'pages', `${revid}.json.gz`);
      return revid !== undefined && fs.existsSync(file) ? (JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Page) : null;
    },
    sources: (used) => [{ url: API, license: WIKI_LICENSE, note: `${used.length} article revisions as wikitext from a local download (${dir}; scripts/eval-fetch-wikipedia.py), each the last before ${EPOCH.slice(0, 10)}` }],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Articles from the Wikipedia API, each kept in the download cache: the last revision before the epoch, redirects followed. */
function fetchedArticles(log: (m: string) => void): Articles {
  const records = new Map<number, SourceRecord>();
  const seen = new Map<string, Page | null>();
  let fetched = 0;
  return {
    async get(url) {
      const title = titleOf(url);
      if (!title) return null;
      if (seen.has(title)) return seen.get(title)!;
      const params = new URLSearchParams({ action: 'query', prop: 'revisions', titles: title, redirects: '1', rvlimit: '1', rvdir: 'older', rvstart: EPOCH, rvprop: 'ids|timestamp|content', rvslots: 'main', format: 'json', formatversion: '2' });
      const name = `frames/${crypto.createHash('sha1').update(title).digest('hex').slice(0, 16)}.json`;
      let got: Awaited<ReturnType<typeof fetchCached>> | undefined;
      for (let attempt = 0; !got; attempt++) {
        const t0 = Date.now();
        try {
          got = await fetchCached(`${API}?${params.toString()}`, { name, license: WIKI_LICENSE, headers: { 'User-Agent': USER_AGENT }, maxBytes: 50 * 1024 * 1024, timeoutMs: 5 * 60_000 });
        } catch (e) {
          // rate limited or a network fault: wait and ask again, a few times
          if (attempt >= 3) throw e;
          log(`Wikipedia: ${title}: ${(e as Error).message.slice(0, 120)}; waiting ${30 * (attempt + 1)}s`);
          await sleep(30_000 * (attempt + 1));
          continue;
        }
        // a request that went to the network (not the cache) is followed by a pause
        if (Date.now() - t0 > 150) {
          if (++fetched % 50 === 0) log(`Wikipedia: ${fetched} articles fetched`);
          await sleep(PACE_MS);
        }
      }
      const json = JSON.parse(fs.readFileSync(got.file, 'utf8')) as { query?: { pages?: { title: string; pageid?: number; missing?: boolean; revisions?: { revid: number; timestamp?: string; slots?: { main?: { content?: string } } }[] }[] } };
      const p = json.query?.pages?.[0];
      const rev = p?.revisions?.[0];
      const text = rev?.slots?.main?.content;
      const page = p && !p.missing && p.pageid !== undefined && rev && typeof text === 'string' ? { title: p.title, pageid: p.pageid, revid: rev.revid, timestamp: rev.timestamp, wikitext: text } : null;
      if (page) records.set(page.revid, { ...got.record, note: `${page.title}, revision ${page.revid}${page.timestamp ? ` of ${page.timestamp.slice(0, 10)}` : ''}` });
      seen.set(title, page);
      return page;
    },
    sources: (used) => used.map((p) => records.get(p.revid)).filter((r): r is SourceRecord => Boolean(r)),
  };
}

async function buildFrames(dir: string, ctx: RecipeContext) {
  const want = questionCount({ ...ctx, options: { questions: ctx.options.questions ?? 100 } }) ?? Infinity;
  const seed = ctx.seed ?? 0;
  const from = ctx.options.from ?? ctx.options.frames;
  const src = await datasetFile({ url: TSV, from: from ? String(from) : undefined, rel: 'test.tsv', license: LICENSE, name: `google__frames-benchmark/${REVISION.slice(0, 8)}/test.tsv` });
  const rows = readFramesRows(fs.readFileSync(src.file, 'utf8'));
  const articles = ctx.options.wikipedia ? localArticles(path.resolve(String(ctx.options.wikipedia))) : fetchedArticles(ctx.log);

  const pathOf = (p: Page) => opaquePath('wiki', `${p.title}|${p.revid}`);
  const used = new Map<number, Page>();
  const tasks: Task[] = [];
  const left: Record<string, number> = {};
  for (const r of stratified(rows, stratumOf, (x) => x.index, seed)) {
    if (tasks.length >= want) break;
    const pages = new Map<string, Page | null>();
    for (const u of r.links) {
      pages.set(u, await articles.get(u));
      if (!pages.get(u)) break;
    }
    const fresh = new Set([...pages.values()].filter((p): p is Page => Boolean(p) && !used.has(p!.revid)).map((p) => p.revid)).size;
    if (ctx.limit && used.size + fresh > ctx.limit) continue;
    const t = framesTask(r, (u) => (pages.get(u) ? pathOf(pages.get(u)!) : null));
    if (typeof t === 'string') {
      left[t] = (left[t] ?? 0) + 1;
      continue;
    }
    for (const p of pages.values()) used.set(p!.revid, p!);
    tasks.push({ ...t, meta: { ...t.meta, reasoningTypes: reasoningTypes(r) } });
  }
  for (const [why, n] of Object.entries(left)) ctx.log(`FRAMES: ${n} questions passed over — ${why}`);
  // the dataset's order in the pack; the sample is only a choice
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  const writer = new PackWriter(dir, {
    id: 'public-frames',
    version: 1,
    title: 'FRAMES, shared pool: multi-article questions over the sampled questions\' Wikipedia articles',
    domain: 'public',
    languages: ['en'],
    description: `${tasks.length} of FRAMES's ${rows.length} questions (a seeded sample across reasoning types and numbers of articles), each needing 2–15 Wikipedia articles, over the ${used.size} articles of all of them as one corpus: every article is gold for some question and a distractor for the rest. Articles are the last revisions before ${EPOCH.slice(0, 7)}, each whole. Judged against the dataset's answers; the dataset's reasoning types are in meta.reasoningTypes.`,
    builder: { recipe: 'public-frames', options: { questions: Number.isFinite(want) ? want : 'all' } },
  });
  writer.addSource({ ...src.record, note: [src.record.note, 'FRAMES test set (Krishna et al., 2024), 824 questions'].filter(Boolean).join('; ') });
  const pagesUsed = [...used.values()].sort((a, b) => a.revid - b.revid);
  for (const s of articles.sources(pagesUsed)) writer.addSource(s);
  for (const p of pagesUsed) {
    const date = p.timestamp?.slice(0, 10);
    writer.addDoc({ path: pathOf(p), title: p.title, ...(date ? { date } : {}), lang: 'en', source: 'wikipedia', kind: 'article' }, `# ${p.title}\n\nWikipedia, revision ${p.revid}${date ? ` of ${date}` : ''}\n\n${wikitextToText(p.wikitext)}\n`);
  }
  ctx.log(`FRAMES: ${tasks.length} questions over ${used.size} articles`);
  return finishRealPack(writer, tasks, ctx);
}

export function registerFramesRecipe(): void {
  registerRecipe({ id: 'public-frames', title: 'FRAMES, shared pool: sampled 2–15-article questions over all their Wikipedia articles', domain: 'public', network: true, needsAuthor: false, build: buildFrames });
}
