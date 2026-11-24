import { findLinks, tier0Known } from '../graph/concepts.js';
import { expandGroups } from '../graph/resolve.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { Params, toDateString } from '../store/temporal.js';
import { SearchResult } from '../types.js';
import { metricTerms, standsAlone } from './rows.js';
import { docLiveAt, keywordTerms } from './search.js';

/**
 * Subjects: a question that names several things ("考虑以下公司的2024年财报：
 * 倍加洁、盾安环境、迈克生物…", "Consider the 2024 reports of these companies: A, B
 * and C") is answered from each one's own documents, and one search of the
 * whole question finds the two or three that match it best. On the 2026-11
 * evaluation 55% of the comparison questions Ask got wrong had a named
 * company's report missing from the prompt, and the named entities were cut
 * at six, so a question naming nine companies lost three before it was asked.
 *
 * Here every thing the question names is a subject, in the order it names
 * them, and each subject the prompt holds no document of gets its own
 * passage: the chunk of its own documents (the ones mentioning it most) that
 * best matches the question's metric words and embedding. The subjects take
 * one turn each within a character budget, so a question naming more of them
 * gets shorter passages rather than fewer subjects. A word the question uses
 * as a common noun ("which company has…", linked to an entity "company"
 * mentioned in 205 filings) is a concept, not a subject: an entity's type and
 * spread do not tell them apart (a team in the weekly reports is in 207).
 */

/** Characters the subjects' passages add at most. */
export const SUBJECT_CHARS = 12000;
/** A subject's passage is not cut below this, however many subjects share the budget. */
export const SUBJECT_MIN_CHARS = 500;
/** A passage is shown up to this (ask.ts `ASK_CONTEXT_CHARS`). */
const PASSAGE_CHARS = 1500;
/** Documents of one subject read: its own (the most mentions), and one more as near to that. */
const DOCS_PER_SUBJECT = 2;
/** Years a question names that its subjects' documents are taken by, at most ("from 2022 to 2024" is three). */
const YEARS_MAX = 5;
/** A document is the subject's own when it mentions it at least this share as often as its most-mentioning document. */
const OWN_SHARE = 0.5;
/** Things a question names, read as subjects at most: a pasted paragraph is not a question naming a hundred companies. */
export const SUBJECTS_MAX = 40;

export interface Subject {
  /** The entity the question's words link to. */
  id: string;
  /** The words naming it in the question. */
  text: string;
  /** It and the entities merged into it. */
  ids: string[];
  /** Named in lower-case Latin letters alone ("company", "revenue"), or by Latin words inside a phrase ("Basic Earnings Per Share"): a word the question uses, not a name it gives. */
  concept: boolean;
}

/** Whether the words linking to an entity are a common noun: Latin letters, all lower-case, no digit. */
export const isConceptWord = (text: string) => /[a-z]/.test(text) && !/[A-Z0-9]/.test(text) && !/[一-鿿]/.test(text);

/** The things a question names, in the order it names them, each once. */
export async function namedSubjects(store: Store, question: string): Promise<Subject[]> {
  const { index } = await tier0Known(store);
  const seen = new Set<string>();
  const spans: { id: string; text: string; inside: boolean }[] = [];
  for (const s of findLinks(question, index).sort((a, b) => a.start - b.start)) {
    const id = s.candidate.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = question.slice(s.start, s.end);
    // Latin words inside a run of others are part of a phrase ("the Basic Earnings Per Share of"), not a name given
    spans.push({ id, text, inside: !/[一-鿿]/.test(text) && !standsAlone(question, s.start, s.end) });
    if (spans.length >= SUBJECTS_MAX) break;
  }
  return Promise.all(spans.map(async ({ inside, ...s }) => ({ ...s, concept: inside || isConceptWord(s.text), ids: await expandGroups(store, [s.id]).catch(() => [s.id]) })));
}

interface DocRow { subject: number; document_id: string; n: number; title: string | null; path: string; doc_date: string | Date | null }

/**
 * The years a question names, a span between two of them filled in: "2024年财报" → 2024; "从2022年到2024年",
 * "from 2022 to 2024" → 2022, 2023, 2024. A filing workspace holds a company's reports of many years, and the one
 * mentioning it most is not the one asked about.
 */
export function questionYears(question: string): string[] {
  const years = [...new Set([...question.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => m[1]))];
  if (years.length === 2) {
    const [a, b] = years.map(Number).sort((x, y) => x - y);
    const between = new RegExp(`${a}.{0,12}?(?:到|至|—|-|~|\\bto\\b|\\bthrough\\b|\\buntil\\b).{0,12}?${b}|${b}.{0,12}?(?:到|至|—|-|~|\\bto\\b).{0,12}?${a}`, 'i');
    if (between.test(question) && b - a < YEARS_MAX) return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  }
  return years.slice(0, YEARS_MAX);
}

/** Whether a document is of a year: its title or path names it, or its date is in it. */
const ofYear = (d: { title: string | null; path: string; doc_date: string | Date | null }, year: string) =>
  (d.title ?? '').includes(year) || d.path.includes(year) || (toDateString(d.doc_date) ?? '').startsWith(year);
interface ChunkRow { id: string; document_id: string; seq: number; content: string; path: string; title: string | null; doc_date: string | Date | null; lex: number; sim: number | null }

export interface SubjectPassages {
  passages: SearchResult[];
  /** Subjects named, those the prompt already held every document asked of, the passages added (one per subject, or per subject and year asked), and the concepts left out. */
  named: number;
  covered: number;
  added: number;
  concepts: number;
  chars: number;
}

/**
 * A passage for each subject whose documents `contexts` has none of: the chunk of the subject's own documents that
 * best matches the question. A question naming years takes each subject's document of each year it names (the most
 * mentioning one of that year), and a question naming one subject and several years ("from 2022 to 2024") is
 * expanded by those documents alone.
 */
export async function subjectPassages(
  store: Store,
  question: string,
  subjects: Subject[],
  contexts: SearchResult[],
  opts: { queryVector?: number[]; model?: string; budget?: number } = {},
): Promise<SubjectPassages> {
  const concepts = subjects.filter((s) => s.concept).length;
  const named = subjects.length - concepts;
  const none: SubjectPassages = { passages: [], named, covered: 0, added: 0, concepts, chars: 0 };
  const budget = opts.budget ?? SUBJECT_CHARS;
  const years = questionYears(question);
  if (budget <= 0 || named === 0 || (named < 2 && years.length < 2)) return none;

  const p = new Params();
  const ids = subjects.flatMap((s, i) => (s.concept ? [] : s.ids.map((id) => ({ id, i }))));
  const docRows = await store.query<DocRow>(
    `WITH m AS MATERIALIZED (
       SELECT k.subject, m.document_id, count(*)::int AS n
       FROM unnest(${p.add(ids.map((x) => x.id))}::text[], ${p.add(ids.map((x) => x.i))}::int[]) AS k(entity_id, subject)
       JOIN entity_mentions m ON m.entity_id = k.entity_id
       JOIN documents d ON d.id = m.document_id
       WHERE ${docLiveAt('d', p)} AND d.root <> 'wiki'
       GROUP BY 1, 2)
     SELECT m.subject, m.document_id, m.n, d.title, d.path, d.doc_date FROM m JOIN documents d ON d.id = m.document_id`,
    p.list,
  );
  const bySubject = new Map<number, DocRow[]>();
  for (const r of docRows) (bySubject.get(r.subject) ?? bySubject.set(r.subject, []).get(r.subject)!).push(r);
  // the units a passage is given for: a subject's own documents, or its document of each year asked about
  const units: { subject: number; docs: string[] }[] = [];
  for (const [i, rows] of [...bySubject].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => b.n - a.n || (a.document_id < b.document_id ? -1 : 1));
    const dated = years.map((y) => rows.find((r) => ofYear(r, y))).filter((r): r is DocRow => !!r);
    if (dated.length) for (const r of new Set(dated)) units.push({ subject: i, docs: [r.document_id] });
    else units.push({ subject: i, docs: rows.filter((r) => r.n >= OWN_SHARE * rows[0].n).slice(0, DOCS_PER_SUBJECT).map((r) => r.document_id) });
  }
  const held = new Set(contexts.filter((c) => !c.excerpt).map((c) => c.documentId));
  const wanted = units.filter((u) => !u.docs.some((d) => held.has(d)));
  const coveredSubjects = new Set(units.map((u) => u.subject));
  for (const u of wanted) coveredSubjects.delete(u.subject);
  const covered = coveredSubjects.size;
  if (wanted.length === 0) return { ...none, covered };

  // the chunks of each wanted document matching the question best: its metric words and other terms (the names
  // out), then its embedding
  const names = subjects.filter((x) => !x.concept).map((x) => x.text);
  const metrics = metricTerms(question, names);
  const lowerNames = names.map((n) => n.toLowerCase());
  const terms = keywordTerms(question).filter((t) => !lowerNames.some((n) => n.includes(t)) && !metrics.includes(t));
  const q = new Params();
  const text = `regexp_replace(lower(c.content), '\\s+', ' ', 'g')`;
  const weighted = [...metrics.map((t) => [t, 4] as const), ...terms.map((t) => [t, 1] as const)];
  const lex = weighted.length ? weighted.map(([t, w]) => `(CASE WHEN strpos(${text}, ${q.add(t)}) > 0 THEN ${w} ELSE 0 END)`).join(' + ') : '0';
  const docs = [...new Set(wanted.flatMap((u) => u.docs))];
  const sim = opts.queryVector && opts.model
    ? `(SELECT 1 - (e.embedding <=> ${q.add(toVectorLiteral(opts.queryVector))}::${VECTOR_TYPE}) FROM embeddings e WHERE e.chunk_id = c.id AND e.model = ${q.add(opts.model)})`
    : 'NULL::float';
  const chunks = await store.query<ChunkRow>(
    `SELECT * FROM (
       SELECT x.*, row_number() OVER (PARTITION BY x.document_id ORDER BY x.lex DESC, x.sim DESC NULLS LAST, x.seq) AS r
       FROM (SELECT c.id, c.document_id, c.seq, c.content, d.path, d.title, d.doc_date, (${lex})::float AS lex, ${sim} AS sim
             FROM chunks c JOIN documents d ON d.id = c.document_id
             WHERE c.document_id = ANY(${q.add(docs)}::text[])) x) y
     WHERE y.r = 1`,
    q.list,
  );
  const best = new Map(chunks.map((c) => [c.document_id, c]));

  // one turn each, the budget shared: a unit's passage is its best chunk, cut around its metric when the share is short
  const share = Math.max(SUBJECT_MIN_CHARS, Math.min(PASSAGE_CHARS, Math.floor(budget / wanted.length)));
  const passages: SearchResult[] = [];
  let chars = 0;
  for (const u of wanted) {
    const pick = u.docs.map((d) => best.get(d)).filter((c): c is ChunkRow => !!c)
      .sort((a, b) => b.lex - a.lex || (b.sim ?? 0) - (a.sim ?? 0))[0];
    if (!pick) continue;
    // past the budget's last full share, what is left of it; a unit it cannot give the shortest passage waits
    const room = Math.min(share, budget - chars);
    if (room < SUBJECT_MIN_CHARS) break;
    const content = around(pick.content, metrics, room);
    chars += content.length;
    passages.push({
      chunkId: pick.id, documentId: pick.document_id, path: pick.path, title: pick.title, content,
      docDate: toDateString(pick.doc_date), score: 0, signals: {},
    });
  }
  return { ...none, passages, covered, added: passages.length, chars };
}

/** `content` cut to `max` characters around the first metric it holds (from its start when it holds none). */
export function around(content: string, metrics: string[], max: number): string {
  if (content.length <= max) return content;
  const lower = content.toLowerCase();
  const at = Math.min(...metrics.map((m) => lower.indexOf(m)).filter((i) => i >= 0), Infinity);
  const from = Number.isFinite(at) ? Math.max(0, Math.min(at - Math.floor(max / 4), content.length - max)) : 0;
  return `${from > 0 ? '…' : ''}${content.slice(from, from + max)}${from + max < content.length ? '…' : ''}`;
}
