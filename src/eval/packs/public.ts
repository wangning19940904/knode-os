import { seededKey, shortHash as hash, stratified } from '../pack.js';
import type { CorpusDoc, Task, TaskType } from '../types.js';
import { finishDocpack } from './docpack.js';
import { fetchJson } from './fetch.js';
import { registerFramesRecipe } from './frames.js';
import { registerRecipe, RecipeContext } from './index.js';
import { registerRamdocsRecipe } from './ramdocs.js';
import { PackWriter } from './writer.js';

/**
 * Pack recipes for the public domain (docs/design/23 §2): published
 * multi-hop QA benchmarks, so the suite's numbers can be set beside the
 * literature's. Everything is model-free — questions, answers, evidence and
 * links come from the datasets' own annotations.
 *
 * - public-musique: MuSiQue (Trivedi et al., 2022, CC BY 4.0) as released
 *   with HippoRAG 2 — 2–4-hop questions composed from single-hop ones, each
 *   with 20 Wikipedia paragraphs (supporting and distractors). Its
 *   decomposition gives the bridge between hops: the gold links.
 * - public-multihoprag: MultiHop-RAG (Tang & Yang, 2024, ODC-BY) — news
 *   articles from late 2023 and queries whose evidence spans 2–4 of them
 *   (inference, comparison, temporal), plus null queries the corpus cannot
 *   answer. Its evidence sentences are exact quotes: the gold facts.
 * - public-ramdocs (ramdocs.ts): RAMDocs (Wang et al., 2025, MIT) — questions
 *   about a shared name over passages that conflict, mislead and distract;
 *   the dataset's strict exact match.
 * - public-frames (frames.ts): FRAMES (Krishna et al., 2024, Apache-2.0) — a
 *   sample of its multi-article questions over all their Wikipedia articles.
 */

type Doc = CorpusDoc & { text: string };

const slug = (s: string, n = 60) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n).replace(/-+$/, '') || 'x';

/* ------------------------------ public-musique ------------------------------ */

interface MusiqueQuestion {
  id: string;
  question: string;
  answer: string;
  answer_aliases: string[];
  answerable: boolean;
  paragraphs: { idx: number; title: string; paragraph_text: string; is_supporting: boolean }[];
  question_decomposition: { id: number; question: string; answer: string; paragraph_support_idx: number | null }[];
}

const HIPPO = 'https://huggingface.co/datasets/osunlp/HippoRAG_2/resolve/main';
const MUSIQUE_LICENSE = 'CC-BY-4.0 (MuSiQue; HippoRAG 2 release)';

async function buildMusique(dir: string, ctx: RecipeContext) {
  const want = Number(ctx.options.questions ?? 25);
  // deeper questions only: 3hop1, 3hop2, 4hop1 … (the composition type's leading digit)
  const minHops = Number(ctx.options.minHops ?? 2);
  const limit = ctx.limit ?? Infinity;
  const seed = ctx.seed ?? 0;
  const writer = new PackWriter(dir, {
    // only 3–4-hop questions: a pack of its own, beside the pilot's
    id: minHops >= 3 ? 'public-musique-deep' : 'public-musique',
    version: 1,
    title: 'MuSiQue multi-hop questions over Wikipedia paragraphs',
    domain: 'public',
    languages: ['en'],
    description: `About ${want} MuSiQue questions (2–4 hops, drawn across composition types) with every paragraph they come with — supporting and distractor Wikipedia paragraphs, one document each — from the HippoRAG 2 release. Gold answers with their aliases (exact match), supporting paragraphs as evidence, and the bridges between consecutive hops as gold links.`,
    builder: { recipe: 'public-musique', options: { questions: want, minHops } },
  });
  const qs = await fetchJson<MusiqueQuestion[]>(`${HIPPO}/musique.json`, { license: MUSIQUE_LICENSE });
  const corpus = await fetchJson<{ title: string; text: string }[]>(`${HIPPO}/musique_corpus.json`, { license: MUSIQUE_LICENSE });
  writer.addSource({ ...qs.record, note: 'MuSiQue-Ans dev questions (1000) as sampled by HippoRAG 2 (Gutiérrez et al., 2025)' });
  writer.addSource({ ...corpus.record, note: 'their paragraphs; a paragraph\'s index here names its document' });
  const corpusIdx = new Map(corpus.json.map((p, i) => [`${p.title}\n${p.text}`, i]));

  const docs = new Map<string, Doc>();
  const docOf = (p: MusiqueQuestion['paragraphs'][number]) => {
    const key = `${p.title}\n${p.paragraph_text}`;
    if (!docs.has(key)) {
      const i = corpusIdx.get(key);
      docs.set(key, { path: `p/${i ?? `x${hash(key)}`}-${slug(p.title)}.md`, title: p.title, lang: 'en', source: 'musique', kind: 'paragraph', text: `# ${p.title}\n\n${p.paragraph_text}\n` });
    }
    return docs.get(key)!;
  };
  const keyOf = (p: MusiqueQuestion['paragraphs'][number]) => `${p.title}\n${p.paragraph_text}`;

  // questions across composition types (2hop, 3hop1, 3hop2, 4hop1…) whose supporting paragraphs fit the budget
  const chosen: MusiqueQuestion[] = [];
  const hopsOf = (q: MusiqueQuestion) => Number(q.id.match(/^(\d)hop/)?.[1] ?? q.question_decomposition.length);
  for (const q of stratified(qs.json.filter((x) => x.answerable && hopsOf(x) >= minHops), (x) => x.id.split('__')[0], (x) => x.id, seed)) {
    if (chosen.length >= want) break;
    const support = q.paragraphs.filter((p) => p.is_supporting);
    const fresh = support.filter((p) => !docs.has(keyOf(p))).length;
    if (!support.length || docs.size + fresh > limit) continue;
    support.forEach(docOf);
    chosen.push(q);
  }
  // then their distractors, as far as the budget goes
  for (const q of chosen) for (const p of q.paragraphs) if (!p.is_supporting && docs.size < limit) docOf(p);

  const tasks: Task[] = [];
  const linked = new Set<string>();
  for (const q of chosen) {
    const byIdx = new Map(q.paragraphs.map((p) => [p.idx, p]));
    const hops = q.question_decomposition.map((h) => (h.paragraph_support_idx != null ? byIdx.get(h.paragraph_support_idx) : undefined));
    const support = [...hops.filter((p): p is NonNullable<typeof p> => Boolean(p)), ...q.paragraphs.filter((p) => p.is_supporting)];
    const evidence = [...new Set(support.map((p) => docOf(p).path))].map((doc) => ({ doc }));
    // a question of three or four hops over as many paragraphs is a deep hop
    const deep = hopsOf(q) >= 3 && evidence.length >= 3;
    tasks.push({
      id: `musique-${q.id}`, suite: 'usage', type: deep ? 'deep-hop' : 'multi-hop', lang: 'en', question: q.question, answer: q.answer,
      answers: [...new Set([q.answer, ...q.answer_aliases])], scoring: 'exact', evidence, primary: true,
      meta: { source: 'musique', composition: q.id.split('__')[0], hops: hopsOf(q), decomposition: q.question_decomposition.map((h) => ({ question: h.question, answer: h.answer })) },
    });
    if (q.answer_aliases.length) writer.addAlias({ canonical: q.answer, aliases: q.answer_aliases });
    // a hop that refers to an earlier one (#1, #2 …) bridges their paragraphs
    q.question_decomposition.forEach((h, k) => {
      for (const m of h.question.matchAll(/#(\d)/g)) {
        const from = hops[+m[1] - 1];
        const to = hops[k];
        if (!from || !to || from.title === to.title || linked.has(`${from.title}|${to.title}`)) continue;
        linked.add(`${from.title}|${to.title}`);
        writer.addLink({ head: from.title, relation: 'bridge', tail: to.title, origin: 'model-free' });
      }
    });
  }
  ctx.log(`MuSiQue: ${tasks.length} questions, ${docs.size} paragraphs, ${linked.size} bridge links`);
  return finishDocpack({ writer, docs: [...docs.values()], lang: 'en', tasks }, ctx);
}

/* ---------------------------- public-multihoprag ---------------------------- */

interface MhrQuery {
  query: string;
  answer: string;
  question_type: string;
  evidence_list: { title: string; source: string; published_at: string; fact: string }[];
}

interface MhrArticle {
  title: string;
  author: string | null;
  source: string;
  published_at: string;
  category: string;
  url: string;
  body: string;
}

const MHR = 'https://huggingface.co/datasets/yixuantt/MultiHopRAG/resolve/main';
const MHR_QUOTA: Record<string, number> = { inference_query: 12, comparison_query: 12, temporal_query: 10, null_query: 6 };
const MHR_TYPES: Record<string, TaskType> = { inference_query: 'multi-hop', comparison_query: 'comparison', temporal_query: 'temporal', null_query: 'unanswerable' };

async function buildMultihopRag(dir: string, ctx: RecipeContext) {
  const want = Number(ctx.options.questions ?? 40);
  const seed = ctx.seed ?? 0;
  const distractors = Math.min(Number(ctx.options.distractors ?? 40), ctx.limit ? Math.floor(ctx.limit / 3) : Infinity);
  const budget = (ctx.limit ?? Infinity) - distractors;
  const writer = new PackWriter(dir, {
    id: 'public-multihoprag',
    version: 1,
    title: 'MultiHop-RAG: queries across late-2023 news articles',
    domain: 'public',
    languages: ['en'],
    description: `About ${want} MultiHop-RAG queries drawn across inference, comparison, temporal and null (unanswerable) types, with the news articles (Sept–Dec 2023) their evidence comes from plus about ${distractors} distractor articles. Gold answers are judged; null queries must be declined. The evidence sentences are the gold facts.`,
    builder: { recipe: 'public-multihoprag', options: { questions: want, distractors } },
  });
  const qs = await fetchJson<MhrQuery[]>(`${MHR}/MultiHopRAG.json`, { license: 'ODC-BY' });
  const corpus = await fetchJson<MhrArticle[]>(`${MHR}/corpus.json`, { license: 'ODC-BY' });
  writer.addSource({ ...qs.record, note: 'MultiHop-RAG queries (Tang & Yang, COLM 2024)' });
  writer.addSource({ ...corpus.record, note: 'its 609 news articles' });
  const byTitle = new Map(corpus.json.map((a) => [a.title, a]));

  const docs = new Map<string, Doc>();
  const docOf = (a: MhrArticle) => {
    if (!docs.has(a.title)) {
      const day = a.published_at.slice(0, 10);
      const byline = [a.source, day, a.author].filter(Boolean).join(' · ');
      docs.set(a.title, { path: `articles/${slug(a.source, 30)}/${day}-${slug(a.title, 50)}.md`, title: a.title, date: day, ...(a.author ? { author: a.author } : {}), lang: 'en', source: a.source, kind: a.category, text: `# ${a.title}\n\n${byline}\n${a.url}\n\n${a.body}\n` });
    }
    return docs.get(a.title)!;
  };

  const quota = (t: string) => Math.round((MHR_QUOTA[t] ?? 0) * want / 40);
  const taken = new Map<string, number>();
  const tasks: Task[] = [];
  const facts = new Map<string, { doc: string; fact: string; date: string }>();
  for (const q of stratified(qs.json.filter((x) => quota(x.question_type) > 0), (x) => x.question_type, (x) => x.query, seed)) {
    if (tasks.length >= want) break;
    const t = q.question_type;
    if ((taken.get(t) ?? 0) >= quota(t)) continue;
    const articles = q.evidence_list.map((e) => byTitle.get(e.title));
    if (articles.some((a) => !a)) continue;
    const fresh = new Set(articles.filter((a) => !docs.has(a!.title)).map((a) => a!.title)).size;
    if (docs.size + fresh > budget) continue;
    taken.set(t, (taken.get(t) ?? 0) + 1);
    const evidence = [...new Map(q.evidence_list.map((e) => {
      const d = docOf(byTitle.get(e.title)!);
      facts.set(hash(d.path, e.fact), { doc: d.path, fact: e.fact, date: e.published_at.slice(0, 10) });
      return [`${d.path}|${e.fact}`, { doc: d.path, quote: e.fact }] as const;
    })).values()];
    const type = MHR_TYPES[t];
    tasks.push({
      id: `mhr-${hash(q.query)}`, suite: 'usage', type, lang: 'en', question: q.query,
      ...(type === 'unanswerable' ? {} : { answer: q.answer }),
      scoring: type === 'unanswerable' ? 'abstain' : 'judge', evidence, primary: type !== 'unanswerable' ? true : undefined,
      meta: { source: 'multihoprag', questionType: t, ...(type === 'unanswerable' ? { goldAnswer: q.answer } : {}) },
    });
  }
  // distractors: other articles, in seeded order
  const rest = corpus.json.filter((a) => !docs.has(a.title)).sort((a, b) => seededKey(seed, a.title).localeCompare(seededKey(seed, b.title)));
  for (const a of rest.slice(0, distractors)) docOf(a);

  for (const [id, f] of facts) writer.addFact({ id: `f-${id}`, text: f.fact, doc: f.doc, quote: f.fact, date: f.date, kind: 'fact' });
  ctx.log(`MultiHop-RAG: ${tasks.length} queries (${[...taken].map(([k, v]) => `${k} ${v}`).join(', ')}), ${docs.size} articles, ${facts.size} evidence facts`);
  return finishDocpack({ writer, docs: [...docs.values()], lang: 'en', tasks }, ctx);
}

export function registerPublicRecipes(): void {
  registerRecipe({ id: 'public-musique', title: 'MuSiQue 2–4-hop questions over their Wikipedia paragraphs (HippoRAG 2 release)', domain: 'public', network: true, needsAuthor: false, build: buildMusique });
  registerRecipe({ id: 'public-multihoprag', title: 'MultiHop-RAG news queries: inference, comparison, temporal, null', domain: 'public', network: true, needsAuthor: false, build: buildMultihopRag });
  registerRamdocsRecipe();
  registerFramesRecipe();
}
