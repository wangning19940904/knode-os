import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { SearchResult } from '../types.js';
import { keywordTerms } from './search.js';

/**
 * The newest sources about what a question names, for a question asking for
 * the latest source or what it says (`asksLatest`).
 *
 * Ask's search ranks passages by how well they match the question, and a
 * question's words match last year's report as well as last week's: on the
 * 2026-11-21 update questions ("By Oslo Platform's latest weekly report, how
 * many risks are still open?", "杭州平台组最新报告的那起事故是哪一起？") the
 * report the question was about was in none of the 26 prompts, and Ask
 * declined, or gave the incident before the newest, while an agent listing
 * the reports by date answered every one. Nothing in the search, the facts or
 * the enumeration ordered anything by date.
 *
 * This reads, for such a question, the documents that mention the entities it
 * names, newest first by their own date, and scores each by the question's
 * other words it holds. It gives the newest that matches loosely (of the kind
 * of source asked about: the latest report may say "in progress" where the
 * question says "still open") and the newest that holds every word the best
 * match holds (a "newest incident" is in the newest report with an incident
 * in it), each by its best-matching chunk, to lead the passages, marked with
 * their date. The passages are read further (search/passages.ts) like any
 * other.
 */

/** Sources given at most: the newest, and the one before it (a change shows as one). */
export const NEWEST_SOURCES = 2;
/** Documents about the named entities read at most, newest first. */
const CANDIDATES = 40;
/** Where no title says what a source is: a candidate matching at least this share of the best is of the kind asked about. */
const LOOSE_SHARE = 0.5;
/** A title holding at least this share of the best-titled candidates' words is of the same kind ("weekly report" beside a "monthly report"). */
const TITLE_SHARE = 0.75;
/**
 * Chunks of a document matched: its first this many, and the chunks around each mention of the named entities. A
 * report is a few chunks; a day of a chat group is hundreds, of which those naming the entity are what it says of it
 * (40 such documents of a finance workspace were 3,527 chunks, 143 of them naming the company).
 */
const HEAD_CHUNKS = 12;

/**
 * Whether a question asks for the newest source, or what the newest source says: "latest", "newest", "most
 * recent", "最新", "最近一次". Not a bare "current" ("current ratio", "current liabilities"), nor "最近" alone, which
 * names a period ("最近三个月").
 *
 * Nor "now", "currently", "现在", "目前", "当前": they ask for a thing's current value, which is in whichever source
 * last changed it, not in the newest one. On the 2026-11-22 model check (docs/design/36 §5, Q3) "杭州增长组的每日推送
 * 上限现在是多少？" was given the team's two newest reports, neither naming the cap (it changed in an older one,
 * under a short name the search found), and was answered from a value set months before: the settings went 20 →
 * 15 of 24 right while the questions asking for the latest report went 35 → 65 of 67.
 */
export function asksLatest(question: string): boolean {
  return /\b(?:latest|newest|most recent(?:ly)?)\b/i.test(question)
    || /最新|最近(?:一次|一期|一周|一份|一篇|一起|的一|报告)/.test(question);
}

/**
 * Words that ask for the latest state and say nothing of what about it: matched against claims they rank "Cara
 * Wilson now leads Oslo Growth" first for "What is Oslo Growth's daily push cap now?".
 */
export const RECENCY_TERMS = new Set(['now', 'currently', 'latest', 'newest', 'recent', 'recently', 'today', 'nowadays', '最新', '目前', '现在', '当前', '如今', '眼下']);

/** Words of a recency question that say "newest" or how to answer, not what to look for. */
const NOT_TOPIC = /\b(?:latest|newest|most|recent(?:ly)?|currently|now|nowadays|present|today|these|days|give|many|much|still)\b|最新|最近|目前|现在|当前|如今|眼下/gi;

/** A word's stem for matching in text: "risks" in "Risks", "reported" in "reports". */
function stem(term: string): string {
  if (!/^[a-z]+$/.test(term) || term.length <= 4) return term;
  return term.replace(/(?:ies|es|s|ed|ing)$/, (m) => (m === 'ies' ? 'y' : '')).replace(/e$/, '');
}

/** The question's words to look for in a source: its terms without the named entities' names and the recency words. */
export function topicTerms(question: string, names: string[]): string[] {
  let q = question;
  // longest first, so that "Oslo Platform weekly report" does not leave "weekly report" of a shorter name's cut
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    if (n.length >= 2) q = q.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  q = q.replace(/[’']s\b/g, ' ').replace(NOT_TOPIC, ' ');
  const out = new Set<string>();
  for (const t of keywordTerms(q, 32)) {
    const s = stem(t.toLowerCase());
    // a two-letter Latin word ("id") is a substring of half the words in any text
    if (s.length >= (/^[a-z0-9]+$/.test(s) ? 3 : 2)) out.add(s);
  }
  return [...out];
}

interface Candidate { id: string; path: string; title: string | null; doc_date: string | Date }
interface ChunkHits { document_id: string; id: string; seq: number; hits: number[] }

export interface NewestOptions {
  /** Sources given at most (default `NEWEST_SOURCES`). */
  k?: number;
  /** The reference day (YYYY-MM-DD): a source dated after it is not yet written. */
  now?: string;
}

/**
 * The newest sources about the `named` entities that hold the question's words best, newest first, each as its
 * best-matching chunk with `newest` set. Empty when the question names nothing or no source about it is dated.
 */
export async function newestSources(store: Store, question: string, named: string[], opts: NewestOptions = {}): Promise<SearchResult[]> {
  const k = opts.k ?? NEWEST_SOURCES;
  if (named.length === 0 || k <= 0) return [];
  const [entities, candidates] = await Promise.all([
    store.query<{ name: string; aliases: unknown }>(`SELECT name, aliases FROM entities WHERE id = ANY($1::text[])`, [named]),
    store.query<Candidate>(
      `SELECT d.id, d.path, d.title, d.doc_date
         FROM documents d
        WHERE d.id IN (SELECT m.document_id FROM entity_mentions m WHERE m.entity_id = ANY($1::text[]))
          AND d.kind = 'source' AND d.status = 'indexed' AND d.root <> 'codebase' AND d.doc_date IS NOT NULL
          AND ($3::date IS NULL OR d.doc_date < $3::date + 1)
        ORDER BY d.doc_date DESC, d.path DESC
        LIMIT $2`,
      [named, CANDIDATES, opts.now ?? null],
    ),
  ]);
  if (candidates.length === 0) return [];
  const names = new Set<string>();
  for (const e of entities) {
    names.add(e.name);
    for (const a of Array.isArray(e.aliases) ? e.aliases : []) if (typeof a === 'string') names.add(a);
  }
  const terms = topicTerms(question, [...names]);
  const hits = terms.length
    ? await store.query<ChunkHits>(
      `WITH m AS MATERIALIZED (
         SELECT DISTINCT mc.document_id, mc.seq FROM entity_mentions em JOIN chunks mc ON mc.id = em.chunk_id
          WHERE em.document_id = ANY($1::text[]) AND em.entity_id = ANY($4::text[]))
       SELECT c.document_id, c.id, c.seq,
              ARRAY(SELECT t.i::int FROM unnest($2::text[]) WITH ORDINALITY AS t(term, i) WHERE strpos(x.lc, t.term) > 0) AS hits
         FROM chunks c CROSS JOIN LATERAL (SELECT lower(c.content) AS lc) x
        WHERE c.document_id = ANY($1::text[])
          AND (c.seq < $3 OR EXISTS (SELECT 1 FROM m WHERE m.document_id = c.document_id AND c.seq BETWEEN m.seq - 1 AND m.seq + 1))`,
      [candidates.map((c) => c.id), terms, HEAD_CHUNKS, named],
    )
    : [];

  // each word of the question weighted by the share of the candidates holding it: a word most of what is said about
  // the entity uses ("周报", "risk", "incident") says what kind of source is asked for, while a bigram cut across two
  // words ("起事" of "那起事故") or a stray word matches by chance
  const lowerNames = [...names].map((n) => n.toLowerCase()).filter((n) => n.length >= 2);
  const covered = new Map<string, Set<number>>();
  const best = new Map<string, ChunkHits>();
  for (const h of hits) {
    const set = covered.get(h.document_id) ?? new Set<number>();
    for (const i of h.hits) set.add(i);
    covered.set(h.document_id, set);
    const was = best.get(h.document_id);
    if (!was || h.hits.length > was.hits.length || (h.hits.length === was.hits.length && h.seq < was.seq)) best.set(h.document_id, h);
  }
  const df = new Map<number, number>();
  for (const set of covered.values()) for (const i of set) df.set(i, (df.get(i) ?? 0) + 1);
  const weight = (i: number) => (df.get(i) ?? 0) / candidates.length;
  const scored = candidates.map((c) => {
    const title = (c.title ?? '').toLowerCase();
    // the title says what kind of source it is: the named entity's own ("Oslo Platform weekly report"), and of
    // the kind the question names ("weekly report", "周报")
    const own = lowerNames.some((n) => title.includes(n));
    let titled = 0;
    terms.forEach((t, i) => { if (title.includes(t)) titled += weight(i + 1); });
    let score = 0;
    for (const i of covered.get(c.id) ?? []) score += weight(i);
    return { c, own, titled, score };
  });
  // the sources of the kind asked about: the named entity's own when it has any (a postmortem titled "事故复盘报告"
  // or minutes using the question's words are not the team's report), and of those the ones whose titles hold the
  // question's words best ("weekly report", not the monthly one)
  const owned = scored.filter((s) => s.own);
  const pool = owned.length ? owned : scored;
  const bestTitled = Math.max(...pool.map((s) => s.titled));
  const kind = bestTitled > 0 ? pool.filter((s) => s.titled >= bestTitled * TITLE_SHARE) : pool;
  const top = Math.max(...kind.map((s) => s.score));
  // the newest of that kind: the latest report may say "in progress" where the question and every older report say
  // "still open" (where no title says what a source is, the newest matching at least half as well); and the newest
  // holding the best match's words, which may be older: a "newest incident" is in the newest report with one in it
  const loose = owned.length || bestTitled > 0 ? kind : kind.filter((s) => s.score >= top * LOOSE_SHARE);
  const full = kind.find((s) => s.score >= top - 1e-9);
  const kept: { c: Candidate; full: boolean }[] = [];
  if (loose[0]) kept.push({ c: loose[0].c, full: loose[0] === full });
  if (full && full !== loose[0] && kept.length < k) kept.push({ c: full.c, full: true });
  for (const s of loose.slice(1)) {
    if (kept.length >= k) break;
    if (!kept.some((x) => x.c.id === s.c.id)) kept.push({ c: s.c, full: s === full });
  }

  const anchors = kept.map((s) => best.get(s.c.id)?.id ?? null);
  const firstChunks = anchors.some((a) => a === null)
    ? await store.query<{ document_id: string; id: string }>(
      `SELECT DISTINCT ON (document_id) document_id, id FROM chunks WHERE document_id = ANY($1::text[]) ORDER BY document_id, seq`,
      [kept.map((s) => s.c.id)],
    )
    : [];
  const first = new Map(firstChunks.map((r) => [r.document_id, r.id]));
  const ids = kept.map((s, i) => anchors[i] ?? first.get(s.c.id) ?? null).filter((x): x is string => x !== null);
  if (ids.length === 0) return [];
  const content = new Map(
    (await store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE id = ANY($1::text[])`, [ids])).map((r) => [r.id, r.content]),
  );
  const out: SearchResult[] = [];
  kept.forEach((s, i) => {
    const chunkId = anchors[i] ?? first.get(s.c.id);
    if (!chunkId || !content.has(chunkId)) return;
    out.push({
      chunkId, documentId: s.c.id, path: s.c.path, title: s.c.title, content: content.get(chunkId)!,
      docDate: toDateString(s.c.doc_date), score: 0, signals: { structural: 1 },
      newest: { rank: out.length + 1, ...(s.full && out.length > 0 ? { full: true } : {}) },
    });
  });
  return out;
}
