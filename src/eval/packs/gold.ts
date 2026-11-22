import { mapLimit } from '../../bench/util.js';
import type { LlmClient } from '../../llm/client.js';
import { foldSpace, seededKey, shortHash as id } from '../pack.js';
import { Bm25, chunkDocs } from '../retrieval.js';
import { ABSENT_COVERAGE, absentCorpus, bestPassage } from './absent.js';
import type { GoldFact, Task } from '../types.js';

/**
 * Gold and tasks for packs whose sources come without them (docs/design/23
 * §2). An author model (Claude — another family than the Codex answerer)
 * drafts atomic facts with an exact quote, and every quote is checked to be
 * a substring of its document; tasks are written from those facts, then each
 * is answered by the author reading only its evidence (the oracle check) and
 * dropped when that answer does not match — gold an oracle cannot recover is
 * noise. Unanswerable questions are kept only when no passage of the corpus
 * holds their distinctive terms together and the author, shown the passages
 * most likely to answer them whole, agrees the corpus does not.
 */

export interface DocText {
  path: string;
  text: string;
  date?: string;
}

function langName(lang: string): string {
  return lang === 'zh' ? 'Chinese' : 'English';
}

/* ------------------------------- gold facts ------------------------------- */

export async function extractFacts(author: LlmClient, docs: DocText[], opts: { lang: string; perDoc?: number; maxChars?: number; batch?: number; log?: (m: string) => void }): Promise<GoldFact[]> {
  const perDoc = opts.perDoc ?? 6;
  const maxChars = opts.maxChars ?? 7000;
  const batches: DocText[][] = [];
  for (let i = 0; i < docs.length; i += opts.batch ?? 3) batches.push(docs.slice(i, i + (opts.batch ?? 3)));
  const out: GoldFact[] = [];
  let rejected = 0;
  await mapLimit(batches, 3, async (group, bi) => {
    const reply = await author.completeJson<{ facts?: { doc?: string; text?: string; quote?: string; entities?: string[]; date?: string; kind?: string }[] }>([
      { role: 'system', content: `You write gold facts for a benchmark. For each document, list up to ${perDoc} atomic facts a reader could look up in it: one checkable statement each (who/what/when/how much), self-contained, written in ${langName(opts.lang)}. For each fact give "quote": a short span copied EXACTLY, character for character, from the document that states it (8–60 characters). Prefer specific facts (names, numbers, dates, decisions, opinions attributed to someone) over generic ones. Skip boilerplate.
Answer with JSON: {"facts":[{"doc":"<path>","text":"…","quote":"…","entities":["…"],"date":"YYYY-MM-DD or empty","kind":"fact|opinion|prediction|event"}]}` },
      { role: 'user', content: group.map((d) => `<document path="${d.path}"${d.date ? ` date="${d.date}"` : ''}>\n${d.text.slice(0, maxChars)}\n</document>`).join('\n\n') },
    ], { maxTokens: 4000 });
    for (const f of reply.facts ?? []) {
      const doc = group.find((d) => d.path === f.doc);
      if (!doc || !f.text || !f.quote) continue;
      if (!foldSpace(doc.text).includes(foldSpace(f.quote))) {
        rejected++;
        continue;
      }
      out.push({ id: `f-${id(doc.path, f.quote)}`, text: f.text.trim(), doc: doc.path, quote: f.quote, entities: (f.entities ?? []).map(String).filter(Boolean).slice(0, 6), ...(f.date ? { date: f.date } : {}), kind: f.kind ?? 'fact' });
    }
    if ((bi + 1) % 10 === 0) opts.log?.(`facts: ${bi + 1}/${batches.length} batches, ${out.length} kept, ${rejected} quotes rejected`);
  }, (err) => opts.log?.(`facts batch failed: ${err instanceof Error ? err.message : String(err)}`));
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

/* --------------------------------- tasks --------------------------------- */

export interface TaskPlan {
  single?: number;
  multi?: number;
  temporal?: number;
  unanswerable?: number;
  global?: number;
}

/** A small build drafts proportionally fewer tasks. */
export function scaledPlan(plan: TaskPlan, docs: number, full: number): TaskPlan {
  const f = Math.min(1, docs / full);
  return Object.fromEntries(Object.entries(plan).map(([k, n]) => [k, n ? Math.max(1, Math.round(n * f)) : 0]));
}

type Draft = Omit<Task, 'evidence'> & { evidence: Task['evidence'] };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

function pick<T>(items: T[], n: number, seed: string | number, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b)))).slice(0, n);
}

export async function generateTasks(author: LlmClient, facts: GoldFact[], docs: DocText[], opts: { lang: string; plan: TaskPlan; seed?: string | number; prefix?: string; log?: (m: string) => void }): Promise<Task[]> {
  const seed = opts.seed ?? 0;
  const lang = langName(opts.lang);
  const prefix = opts.prefix ?? 't';
  const drafts: Draft[] = [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const docText = new Map(docs.map((d) => [d.path, d.text]));

  // single-hop: one fact each, paraphrased so the question does not copy the quote
  const singles = pick(facts.filter((f) => f.kind !== 'opinion'), opts.plan.single ?? 0, seed, (f) => f.id);
  for (let i = 0; i < singles.length; i += 10) {
    const group = singles.slice(i, i + 10);
    const r = await author.completeJson<{ tasks?: { fact?: string; question?: string; answer?: string; short?: boolean }[] }>([
      { role: 'system', content: `Write one benchmark question per fact, in ${lang}. The question must be answerable from the fact's document alone, stand on its own (name the people, companies, places involved), and paraphrase rather than copy the quote. "answer": the short answer. "short": true when the answer is a name, number, date or a few words.
Answer with JSON: {"tasks":[{"fact":"<fact id>","question":"…","answer":"…","short":true}]}` },
      { role: 'user', content: JSON.stringify(group.map((f) => ({ fact: f.id, text: f.text, quote: f.quote, doc: f.doc }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const f = t.fact ? byId.get(t.fact) : undefined;
      if (!f || !t.question || !t.answer) continue;
      drafts.push({ id: `${prefix}-s-${id(f.id)}`, suite: 'usage', type: 'single-hop', lang: opts.lang, question: t.question, answer: t.answer, scoring: t.short ? 'exact' : 'judge', evidence: [{ doc: f.doc, quote: f.quote }], primary: true });
    }
  }

  // multi-hop: two facts from different documents that share an entity
  const byEntity = new Map<string, GoldFact[]>();
  for (const f of facts) for (const e of f.entities) (byEntity.get(norm(e)) ?? byEntity.set(norm(e), []).get(norm(e))!).push(f);
  const pairs: [GoldFact, GoldFact, string][] = [];
  for (const [e, list] of byEntity) {
    if (e.length < 2) continue;
    const docsOf = [...new Set(list.map((f) => f.doc))];
    if (docsOf.length < 2) continue;
    const a = list.find((f) => f.doc === docsOf[0])!;
    const b = list.find((f) => f.doc === docsOf[1])!;
    pairs.push([a, b, e]);
  }
  const chosenPairs = pick(pairs, opts.plan.multi ?? 0, seed, ([a, b]) => a.id + b.id);
  for (let i = 0; i < chosenPairs.length; i += 6) {
    const group = chosenPairs.slice(i, i + 6);
    const r = await author.completeJson<{ tasks?: { pair?: number; question?: string; answer?: string; keypoints?: string[] }[] }>([
      { role: 'system', content: `Each item has two facts from different documents that share an entity. Write one question in ${lang} that needs BOTH facts to answer (a bridge: find X in one, then ask about X in the other; or a comparison). It must stand on its own. Give the answer and 2–3 keypoints the answer must contain.
Answer with JSON: {"tasks":[{"pair":<index>,"question":"…","answer":"…","keypoints":["…"]}]}` },
      { role: 'user', content: JSON.stringify(group.map(([a, b, e], k) => ({ pair: k, shared: e, fact1: a.text, fact2: b.text }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const p = typeof t.pair === 'number' ? group[t.pair] : undefined;
      if (!p || !t.question || !t.answer) continue;
      drafts.push({ id: `${prefix}-m-${id(p[0].id, p[1].id)}`, suite: 'usage', type: 'multi-hop', lang: opts.lang, question: t.question, answer: t.answer, keypoints: t.keypoints?.slice(0, 4), scoring: 'judge', evidence: [{ doc: p[0].doc, quote: p[0].quote }, { doc: p[1].doc, quote: p[1].quote }], primary: true });
    }
  }

  // temporal: dated facts — when something happened, or which of two came first
  const dated = facts.filter((f) => f.date && /^\d{4}/.test(f.date));
  const temporal = pick(dated, opts.plan.temporal ?? 0, seed, (f) => f.id);
  if (temporal.length) {
    const r = await author.completeJson<{ tasks?: { fact?: string; question?: string; answer?: string }[] }>([
      { role: 'system', content: `Write one time question per dated fact, in ${lang}: when it happened, how long before or after something else in the fact, or what held as of a date. Stand-alone; give the answer.
Answer with JSON: {"tasks":[{"fact":"<fact id>","question":"…","answer":"…"}]}` },
      { role: 'user', content: JSON.stringify(temporal.map((f) => ({ fact: f.id, text: f.text, date: f.date }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const f = t.fact ? byId.get(t.fact) : undefined;
      if (!f || !t.question || !t.answer) continue;
      drafts.push({ id: `${prefix}-t-${id(f.id)}`, suite: 'usage', type: 'temporal', lang: opts.lang, question: t.question, answer: t.answer, scoring: 'judge', evidence: [{ doc: f.doc, quote: f.quote }] });
    }
  }

  // global: questions over many facts, scored by keypoints
  if (opts.plan.global) {
    const sample = pick(facts, 60, seed, (f) => f.id);
    const r = await author.completeJson<{ tasks?: { question?: string; keypoints?: string[]; facts?: string[] }[] }>([
      { role: 'system', content: `From these facts drawn across a document collection, write ${opts.plan.global} broad questions in ${lang} that need many documents to answer well (main themes, how views differ, what changed over time). For each give 4–6 keypoints a good answer contains, at the level the question asks: each keypoint a theme, contrast or trend a summary answer would state (it may name an example in parentheses), backed by at least two of the listed facts from different documents — never a single document's detail (a method's parts, one figure) that a good summary could leave out. List the fact ids behind them.
Answer with JSON: {"tasks":[{"question":"…","keypoints":["…"],"facts":["<fact id>"]}]}` },
      { role: 'user', content: JSON.stringify(sample.map((f) => ({ id: f.id, text: f.text }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      if (!t.question || !t.keypoints?.length) continue;
      const ev = [...new Set((t.facts ?? []).map((x) => byId.get(x)?.doc).filter((d): d is string => Boolean(d)))].map((doc) => ({ doc }));
      drafts.push({ id: `${prefix}-g-${id(t.question)}`, suite: 'usage', type: 'global', lang: opts.lang, question: t.question, answer: t.keypoints.join('; '), keypoints: t.keypoints, scoring: 'keypoints', evidence: ev });
    }
  }

  // the author may write two questions for one fact or pair: the first is kept
  const seenIds = new Set<string>();
  const unique = drafts.filter((d) => (seenIds.has(d.id) ? false : (seenIds.add(d.id), true)));
  const kept = await oracleCheck(author, unique, docText, lang, opts.log);

  // unanswerable: plausible questions the corpus does not answer, confirmed against the corpus itself
  if (opts.plan.unanswerable) kept.push(...await draftUnanswerable(author, facts, docs, { lang, langCode: opts.lang, n: opts.plan.unanswerable, seed, prefix, entities: [...byEntity.keys()], log: opts.log }));
  opts.log?.(`tasks: ${drafts.length} drafted, ${kept.length} kept after the oracle check`);
  return kept;
}

/**
 * Unanswerable questions (docs/design/23 §2), checked against the corpus and
 * not against the facts drafted from it. The 2026-11 campaign found drafted
 * "unanswerable" questions that a document answers word for word (SURMOUNT-CN
 * randomised 210 participants; 间-二巯基琥珀酸 0.5g): the author was asked
 * for details "these facts do NOT answer", the facts being a 40-fact sample
 * of at most a few per document, so it asked about the rest of the documents
 * — often what it knew of the subject already — and the check showed it the
 * five BM25 chunks cut to their first 800 of 1,200 characters, all questions
 * in one call. Now:
 *
 * - the author is told the facts are a sample, and to ask for what documents
 *   of this kind would not record, not for what it knows of the subject;
 * - a question whose distinctive terms co-occur in one passage of the corpus
 *   (packs/absent.ts, the lint rule `abstain-in-corpus`) is dropped before
 *   any check, without a model;
 * - the rest are checked a few at a time against whole passages: the BM25
 *   hits and the passage holding most of the question's terms, uncut.
 * A question is kept only when the author says, explicitly, that none answers it.
 */
export async function draftUnanswerable(author: LlmClient, facts: GoldFact[], docs: DocText[], opts: { lang: string; langCode: string; n: number; seed: string | number; prefix: string; entities: string[]; log?: (m: string) => void }): Promise<Task[]> {
  const r = await author.completeJson<{ questions?: string[] }>([
    { role: 'system', content: `Write ${opts.n * 3} questions in ${opts.lang} about the entities below that sound natural for this collection but that its documents do NOT answer. The facts listed are only a sample of what the documents say: do not ask for a figure, date or name that documents of this kind normally report (a trial's enrolment or results, a dose a reference lists, a law's effective date), and never ask for something you know of the subject yourself. Ask instead for a detail such documents would not record (a private remark, a later event, a figure no source of this kind gives). Stand-alone.
Answer with JSON: {"questions":["…"]}` },
    { role: 'user', content: JSON.stringify({ entities: opts.entities.slice(0, 80), facts: pick(facts, 40, opts.seed, (f) => f.id).map((f) => f.text) }) },
  ], { maxTokens: 2500 });
  const drafted = [...new Set((r.questions ?? []).map((q) => String(q).trim()).filter(Boolean))];
  const corpus = absentCorpus(docs, drafted);
  const hits = new Map(drafted.map((q) => [q, bestPassage(q, corpus)]));
  const candidates = drafted.filter((q) => (hits.get(q)?.coverage ?? 0) < ABSENT_COVERAGE);
  const chunks = chunkDocs(docs.map((d) => ({ path: d.path, text: d.text })));
  const index = new Bm25(chunks, (c) => c.text);
  const byDoc = new Map<string, typeof chunks>();
  for (const c of chunks) (byDoc.get(c.doc) ?? byDoc.set(c.doc, []).get(c.doc)!).push(c);
  // the passages to show: BM25's best, and the chunks of the document that holds most of the question's terms
  const passagesOf = (q: string) => {
    const shown = index.search(q, 6).map((h) => h.item);
    const near = hits.get(q)?.doc;
    for (const c of near ? byDoc.get(near) ?? [] : []) if (shown.length < 9 && !shown.includes(c)) shown.push(c);
    return shown.map((c) => `[${c.doc}] ${c.text}`);
  };
  const absent = new Set<string>();
  for (let i = 0; i < candidates.length; i += 4) {
    const group = candidates.slice(i, i + 4);
    const check = await author.completeJson<{ verdicts?: { i?: number; answerable?: boolean }[] }>([
      { role: 'system', content: 'For each question, read every passage and decide whether any of them answers it, fully or in part (a figure, a date, a name, a reason it asks for). Answer with JSON: {"verdicts":[{"i":<index>,"answerable":true|false}]}' },
      { role: 'user', content: JSON.stringify(group.map((q, k) => ({ i: k, question: q, passages: passagesOf(q) }))) },
    ], { maxTokens: 1500 }).catch((err) => {
      opts.log?.(`unanswerable check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { verdicts: [] };
    });
    for (const v of check.verdicts ?? []) if (v.answerable === false && typeof v.i === 'number' && group[v.i]) absent.add(group[v.i]);
  }
  opts.log?.(`unanswerable: ${drafted.length} drafted, ${drafted.length - candidates.length} dropped for terms that co-occur in one passage, ${absent.size} confirmed absent`);
  return drafted.filter((q) => absent.has(q)).slice(0, opts.n)
    .map((q) => ({ id: `${opts.prefix}-u-${id(q)}`, suite: 'usage' as const, type: 'unanswerable' as const, lang: opts.langCode, question: q, scoring: 'abstain' as const, evidence: [] }));
}

/** Keep the drafts the author, reading only their evidence, answers the way the gold does. */
export async function oracleCheck(author: LlmClient, drafts: Draft[], docText: Map<string, string>, lang: string, log?: (m: string) => void): Promise<Draft[]> {
  const kept: Draft[] = [];
  for (let i = 0; i < drafts.length; i += 6) {
    const group = drafts.slice(i, i + 6);
    const r = await author.completeJson<{ verdicts?: { i?: number; consistent?: boolean }[] }>([
      { role: 'system', content: `For each item, read only the evidence documents, answer the question yourself, then say whether your answer agrees with the gold answer (same key information). Questions and documents may be in ${lang} or English.
Answer with JSON: {"verdicts":[{"i":<index>,"consistent":true|false}]}` },
      { role: 'user', content: JSON.stringify(group.map((t, k) => ({ i: k, question: t.question, gold: t.answer, evidence: t.evidence.map((e) => (docText.get(e.doc) ?? '').slice(0, 5000)) }))) },
    ], { maxTokens: 1500 }).catch((err) => {
      log?.(`oracle check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { verdicts: [] };
    });
    const ok = new Set((r.verdicts ?? []).filter((v) => v.consistent && typeof v.i === 'number').map((v) => v.i!));
    group.forEach((t, k) => ok.has(k) && kept.push(t));
  }
  return kept;
}
