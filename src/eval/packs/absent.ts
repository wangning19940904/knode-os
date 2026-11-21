import { lexicalTokens } from './separation.js';

/**
 * Is an "unanswerable" question answered somewhere in the corpus? Checked
 * without a model before a pack is used (lint rule `abstain-in-corpus`) and
 * before a drafted unanswerable question is kept (packs/gold.ts): the
 * question's terms, weighted by how rare they are in the corpus, against
 * every passage of every document. A question whose rare terms stand together
 * in one passage asks about something that passage covers; the 2026-11
 * campaign's abstain questions that every arm answered from one document
 * ("How many participants were randomized in SURMOUNT-CN …", "间-二巯基琥珀酸
 * …的常用口服剂量") all had most of their weight in one abstract or section.
 *
 * Terms: content words (English), two-character sequences without a function
 * or question character (Chinese, simplified and traditional), and codes with
 * a digit or a hyphen ("SURMOUNT-CN", "HbA1c", "R-136") in either language.
 * Passages: windows of 1,500 characters at a 750-character stride, so a fact
 * near a window's edge is still whole in the next one.
 */

const ZH_SKIP = /[的了是个個起在有和这這那也就都与與着著或被把给給从從到对對为為以之其几幾么麼吗嗎呢里裡一哪什多少怎谁誰]/;

/** The terms of a text, as the check counts them. */
export function absentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of lexicalTokens('zh', text)) if (!ZH_SKIP.test(t)) out.add(t);
  for (const t of lexicalTokens('en', text)) out.add(t);
  for (const t of text.normalize('NFKC').toLowerCase().match(/[a-z]*\d[a-z0-9.-]*|[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? []) if (t.length >= 2) out.add(t.replace(/[.-]+$/, ''));
  return out;
}

export const PASSAGE_CHARS = 1500;

/** A document's passages, each as the set of `wanted` terms it holds. */
export function passageTerms(text: string, wanted: Set<string>, size = PASSAGE_CHARS): Set<string>[] {
  const out: Set<string>[] = [];
  const t = text.normalize('NFKC');
  for (let i = 0; i === 0 || i < t.length - size / 2; i += size / 2) {
    const s = new Set<string>();
    for (const x of absentTerms(t.slice(i, i + size))) if (wanted.has(x)) s.add(x);
    out.push(s);
  }
  return out;
}

export interface AbsentCorpus {
  n: number;
  df: Map<string, number>;
  docs: { path: string; passages: Set<string>[] }[];
}

/** One pass over the documents for the terms of `questions`. */
export function absentCorpus(docs: { path: string; text: string }[], questions: string[]): AbsentCorpus {
  const wanted = new Set(questions.flatMap((q) => [...absentTerms(q)]));
  const df = new Map<string, number>();
  const out: AbsentCorpus['docs'] = [];
  for (const d of docs) {
    const passages = passageTerms(d.text, wanted);
    const all = new Set(passages.flatMap((p) => [...p]));
    for (const x of all) df.set(x, (df.get(x) ?? 0) + 1);
    if (all.size) out.push({ path: d.path, passages: passages.filter((p) => p.size) });
  }
  return { n: docs.length, df, docs: out };
}

export interface AbsentHit {
  /** Share of the question's rarity-weighted terms the best passage holds (0–1). */
  coverage: number;
  doc: string;
  /** The question's terms that passage holds, rarest first. */
  terms: string[];
}

/** Coverage at or above this: the question's distinctive terms co-occur in one passage. */
export const ABSENT_COVERAGE = 0.6;

/** The passage that holds the most of the question, by the weight of its terms (a term's weight: log((N+1)/(df+0.5))). */
export function bestPassage(question: string, corpus: AbsentCorpus): AbsentHit | null {
  const q = [...absentTerms(question)];
  if (!q.length) return null;
  const w = (x: string) => Math.log((corpus.n + 1) / ((corpus.df.get(x) ?? 0) + 0.5));
  const total = q.reduce((s, x) => s + w(x), 0);
  if (!(total > 0)) return null;
  let best: AbsentHit | null = null;
  for (const d of corpus.docs) {
    for (const p of d.passages) {
      const held = q.filter((x) => p.has(x));
      if (!held.length) continue;
      const coverage = held.reduce((s, x) => s + w(x), 0) / total;
      if (!best || coverage > best.coverage) best = { coverage, doc: d.path, terms: held.sort((a, b) => w(b) - w(a)) };
    }
  }
  return best;
}
