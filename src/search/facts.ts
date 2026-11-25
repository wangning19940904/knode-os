import { findLinks, tier0Known } from '../graph/concepts.js';
import { expandGroups, shortNameTwins } from '../graph/resolve.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { Params, relationSourceSql, toDateString } from '../store/temporal.js';
import { ClaimItem, SearchResult } from '../types.js';
import { RECENCY_TERMS } from './newest.js';
import { entityMatchSql, keywordTerms, termCount } from './search.js';
import { SUBJECTS_MAX } from './subjects.js';

/**
 * The claims an answer is given beside its retrieved chunks.
 *
 * A chunk says what one passage says. The claims are what the knowledge base
 * extracted from every document, so they are worth their place in a prompt
 * when they add what the chunks do not hold: what other documents say about
 * the things the question names. They used to be any eight claims about any
 * entity a retrieved chunk mentioned, in no order — on the benchmark's
 * corpus-level questions (list every…, what do the documents say about…) they
 * raised the share of gold evidence in the prompt from 0.38 to 0.40.
 *
 * Here the candidates are the claims about the entities the question names
 * (as subject or object), the claims about entities the retrieved chunks
 * mention, and the claims extracted from those chunks; they are ranked by how
 * well they match the question — its terms, and its embedding where the
 * claim has one — and taken a few per source, so that a list question is
 * answered from many documents rather than from the best one three times.
 * A list question also takes the named entities' relations and the claims
 * about their neighbours and variants (`listRoutes`); its passages, which no
 * claim holds, are search/excerpts.ts.
 */

export interface QuestionFact extends ClaimItem {
  /** The chunk the claim was extracted from, when it is still indexed. */
  chunkId: string | null;
}

export interface FactOptions {
  /** Claims returned at most. */
  limit?: number;
  /** The question's embedding and the model it is of: claims embedded by that model are also ranked by it. */
  queryVector?: number[];
  model?: string;
  /**
   * The question asks for every case (`isListQuestion`): the named entities'
   * relations, and the claims about the entities one relation away and about
   * the named entities' variants ("Gemini-3 Pro" for "Gemini"), join the
   * candidates.
   */
  list?: boolean;
  /** The question's named entities, when the caller has looked them up (`namedEntities`). */
  named?: string[];
}

/**
 * Entities named in a question at most: past these it is a pasted paragraph, not a question. Not what bounds a
 * question naming many things — "these nine companies" names nine — which is what each route's budget does: the
 * facts' `limit`, the passages' characters (search/subjects.ts). It was six, and a comparison of nine companies
 * lost three of them before it was asked.
 */
const NAMED_MAX = SUBJECTS_MAX;
/** Claims read per route. A company in a finance workspace has thousands; the newest are the ones asked about. */
const ROUTE_CAP = 300;
/**
 * Claims about one named entity read at least, when the question names several: the route's claims are shared
 * among them (each its newest `ROUTE_CAP / n`, at least this many), not the newest of all, which one company's
 * week of filings could fill.
 */
const ROUTE_PER_NAMED = 60;
/** A named entity with at most this many candidate claims is a specific thing the question asks about (`factsForQuestion`). */
const SPECIFIC_MAX = 30;
/** Claims taken from one source before every other source has had its turn. */
const PER_SOURCE = 3;
const RRF_K = 60;

/**
 * The live entities a text names, most often first, with the ones merged into them and their short-name twins
 * (`shortNameTwins`): a setting changed under its short name has its current value there, and a question naming
 * the setting by its full name was answered from the initial value its own entity holds.
 */
export async function namedEntities(store: Store, text: string, max = NAMED_MAX): Promise<string[]> {
  const { index } = await tier0Known(store);
  const counts = new Map<string, number>();
  for (const span of findLinks(text, index)) {
    const id = span.candidate.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => id);
  if (ids.length === 0) return [];
  const [grouped, twins] = await Promise.all([expandGroups(store, ids), shortNameTwins(store, ids).catch(() => [] as string[])]);
  return [...new Set([...grouped, ...twins])];
}

/** Documents of a named entity read at most, for excerpts: a name in every document narrows nothing. */
const NAMED_DOCS_CAP = 500;

/**
 * What the excerpts need of the entities a question names: the names and
 * aliases they are written as, and the documents they are mentioned in.
 */
export async function namedSurface(store: Store, ids: string[]): Promise<{ names: string[]; docs: string[] }> {
  if (ids.length === 0) return { names: [], docs: [] };
  const [entities, docs] = await Promise.all([
    store.query<{ name: string; aliases: unknown }>(`SELECT name, aliases FROM entities WHERE id = ANY($1::text[])`, [ids]),
    store.query<{ document_id: string }>(`SELECT DISTINCT document_id FROM entity_mentions WHERE entity_id = ANY($1::text[]) LIMIT $2`, [ids, NAMED_DOCS_CAP]),
  ]);
  const names = new Set<string>();
  for (const e of entities) {
    names.add(e.name);
    for (const a of Array.isArray(e.aliases) ? e.aliases : []) if (typeof a === 'string') names.add(a);
  }
  return { names: [...names], docs: docs.map((d) => d.document_id) };
}

/** Entities one relation away from a named one, read at most for a list question: the heaviest relations first. */
const NEIGHBOURS_CAP = 60;
/** Variants of a named entity read at most ("GPT-4o", "GPT-5", … for "GPT"). */
const VARIANTS_CAP = 60;

const LIVE_CLAIM = `cl.tx_to IS NULL AND cl.canonical_id IS NULL AND cl.superseded_by IS NULL`;
const CLAIM_COLUMNS = `cl.subject_id, se.name AS subject, oe.name AS object, cl.type, cl.statement, cl.status, cl.kind,
  cl.valid_from, cl.valid_to, cl.event_at, s.key AS path, cl.evidence_count, cl.chunk_id`;
/** A claim's nearness to the question, where it has an embedding of the question's model. */
const simOf = (vector: string, model: string) =>
  `(SELECT 1 - (ce.embedding <=> ${vector}::${VECTOR_TYPE}) FROM claim_embeddings ce WHERE ce.claim_id = cl.id AND ce.model = ${model})`;
const CLAIM_JOINS = `JOIN entities se ON se.id = cl.subject_id LEFT JOIN entities oe ON oe.id = cl.object_id LEFT JOIN scopes s ON s.id = cl.primary_scope_id`;

interface Row {
  id: string; via: number; subject_id: string; subject: string; object: string | null; type: string; statement: string; status: string; kind: string;
  valid_from: string | null; valid_to: string | null; event_at: string | null; path: string | null; evidence_count: number; chunk_id: string | null; sim: number | null;
}

export async function factsForQuestion(store: Store, question: string, contexts: SearchResult[], opts: FactOptions = {}): Promise<QuestionFact[]> {
  const limit = opts.limit ?? 24;
  if (limit <= 0) return [];
  const chunkIds = contexts.map((c) => c.chunkId);
  const named = opts.named ?? (await namedEntities(store, question));
  if (chunkIds.length === 0 && named.length === 0) return [];

  const withVector = Boolean(opts.queryVector && opts.model);
  // each named entity its share of the route: the newest of them all would be one company's
  const perNamed = Math.max(Math.ceil(ROUTE_CAP / Math.max(1, named.length)), ROUTE_PER_NAMED);
  const params: unknown[] = [named, chunkIds, ROUTE_CAP, perNamed];
  let sim = 'NULL::float';
  const vector = withVector ? { literal: toVectorLiteral(opts.queryVector!), model: opts.model! } : null;
  if (vector) {
    params.push(vector.literal, vector.model);
    sim = simOf('$5', '$6');
  }
  // via: 0 named by the question, 1 about an entity a retrieved chunk mentions, 2 extracted from a retrieved chunk
  const [rows, listed] = await Promise.all([
    store.query<Row>(
      `WITH cand AS (
         (SELECT x.id, 0 AS via FROM unnest($1::text[]) AS n(id)
          CROSS JOIN LATERAL (SELECT cl.id FROM claims cl WHERE cl.subject_id = n.id AND ${LIVE_CLAIM} ORDER BY cl.tx_from DESC LIMIT $4) x)
         UNION ALL
         (SELECT x.id, 0 AS via FROM unnest($1::text[]) AS n(id)
          CROSS JOIN LATERAL (SELECT cl.id FROM claims cl WHERE cl.object_id = n.id AND ${LIVE_CLAIM} ORDER BY cl.tx_from DESC LIMIT $4) x)
         UNION ALL
         (SELECT cl.id, 1 AS via FROM claims cl
          WHERE cl.subject_id IN (SELECT DISTINCT m.entity_id FROM entity_mentions m WHERE m.chunk_id = ANY($2::text[])) AND ${LIVE_CLAIM}
          ORDER BY cl.tx_from DESC LIMIT $3)
         UNION ALL
         (SELECT cl.id, 2 AS via FROM claims cl WHERE cl.chunk_id = ANY($2::text[]) AND ${LIVE_CLAIM})
       ), picked AS MATERIALIZED (SELECT id, min(via) AS via FROM cand GROUP BY id)
       SELECT cl.id, p.via, ${CLAIM_COLUMNS}, ${sim} AS sim
       FROM picked p
       JOIN claims cl ON cl.id = p.id
       ${CLAIM_JOINS}`,
      params,
    ),
    opts.list && named.length > 0 ? listRoutes(store, named, vector) : Promise.resolve([] as Row[]),
  ]);
  const seen = new Set(rows.map((r) => r.id));
  for (const r of listed) if (!seen.has(r.id)) rows.push(r);

  // a plain fact read off a chunk the model is given anyway says nothing the chunk does not; a hedged
  // or disputed one, a view or a forecast is what the answer has to flag, so it stays
  const inContext = new Set(chunkIds);
  const pool = rows.filter((r) => !(r.chunk_id && inContext.has(r.chunk_id) && r.status === 'fact' && (r.kind ?? 'fact') === 'fact'));
  if (pool.length === 0) return [];

  // a claim about a named entity's short-name twin ("PAY1-C1 is 9000 dollars from week 33") is about the entity
  // the question names by its full name ("per-refund approval limit"): it is matched under both names
  const owners = await aliasOwners(store, named);
  // a question naming a team and one of its settings asks about the setting: claims about a named entity with few
  // claims rank by that too, beside the words and the embedding (the team's hundreds stay ranked by those alone)
  const namedSet = new Set(named);
  const perSubject = new Map<string, number>();
  for (const r of pool) if (namedSet.has(r.subject_id) && !r.id.startsWith('relation:')) perSubject.set(r.subject_id, (perSubject.get(r.subject_id) ?? 0) + 1);
  const specific = perSubject.size > 1 ? (r: Row) => {
    const n = r.id.startsWith('relation:') ? 0 : perSubject.get(r.subject_id) ?? 0;
    return n > 0 && n <= SPECIFIC_MAX ? 1 / n : null;
  } : undefined;
  const picked = pickRelevant(question, pool, limit, {
    sim: (r) => r.sim, named: (r) => r.via === 0, specific,
    text: (r) => {
      const owner = owners.get(r.subject.toLowerCase());
      return owner && owner !== r.subject ? `${owner} ${r.subject} ${r.statement} ${r.object ?? ''}` : `${r.subject} ${r.statement} ${r.object ?? ''}`;
    },
  });
  return picked.map((r) => ({
    id: r.id, subject: r.subject, object: r.object, type: r.type, statement: r.statement, status: r.status, kind: r.kind,
    startDate: toDateString(r.valid_from), endDate: toDateString(r.valid_to), eventDate: toDateString(r.event_at),
    path: r.path, evidenceCount: r.evidence_count, chunkId: r.chunk_id,
  }));
}

/** The named entities' names by each of their aliases (lowercased): a twin goes by one of those. */
async function aliasOwners(store: Store, named: string[]): Promise<Map<string, string>> {
  if (named.length === 0) return new Map();
  const rows = await store.query<{ name: string; aliases: unknown }>(`SELECT name, aliases FROM entities WHERE id = ANY($1::text[])`, [named]).catch(() => []);
  const out = new Map<string, string>();
  for (const r of rows) {
    for (const a of Array.isArray(r.aliases) ? r.aliases : []) {
      if (typeof a === 'string' && a.length > 1 && a.toLowerCase() !== r.name.toLowerCase() && !out.has(a.toLowerCase())) out.set(a.toLowerCase(), r.name);
    }
  }
  return out;
}

/**
 * The candidates a list question adds. "Which papers build on RAG" is
 * answered by what each paper says of its own method, and "what do the
 * documents say about Gemini" by what they say of Gemini-3 Pro: on the
 * benchmark's research-ai corpus-level questions, 61 of the 152 evidence
 * quotes missing from the prompt had a claim, with an entity other than the
 * named one as its subject. So: the named entities' relations, each as a fact
 * read off its source ("MIRAGE-VC uses Retrieval-Augmented Generation: …");
 * the claims about the entities one relation away; and the claims about the
 * named entities' variants, entities whose name is the named one's and more
 * ("GPT-4o", "Gemini 1.5"). These count as matched only by the question's
 * terms or embedding, unlike a claim about a named entity, so a neighbour
 * that says nothing of the question stays out. Not for other questions: the
 * neighbours of what a two-hop question names cost law-cn's multi-hop
 * questions 0.014 of their evidence.
 */
async function listRoutes(store: Store, named: string[], vector: { literal: string; model: string } | null): Promise<Row[]> {
  const p = new Params([named]);
  const names = (await store.query<{ name: string }>(`SELECT lower(name) AS name FROM entities WHERE id = ANY($1::text[])`, [named])).map((r) => r.name).filter((n) => n.length >= 2);
  const variants = names.length
    ? `(SELECT e.id FROM entities e
        WHERE ${entityMatchSql(store, 'e', names, p, ['name'])} AND e.tx_to IS NULL AND e.canonical_id IS NULL AND NOT e.id = ANY($1::text[])
          AND EXISTS (SELECT 1 FROM unnest(${p.add(names)}::text[]) n WHERE left(lower(e.name), length(n) + 1) IN (n || '-', n || ' '))
        LIMIT ${p.add(VARIANTS_CAP)})`
    : `(SELECT NULL::text AS id WHERE false)`;
  const sim = vector ? simOf(p.add(vector.literal), p.add(vector.model)) : 'NULL::float';
  const relationPath = relationSourceSql('r', 'path');
  const [relations, claims] = await Promise.all([
    store.query<Row>(
      `SELECT 'relation:' || r.id AS id, 0 AS via, r.source_id AS subject_id, se.name AS subject, te.name AS object, r.type,
              se.name || ' ' || replace(r.type, '_', ' ') || ' ' || te.name || CASE WHEN r.description <> '' THEN ': ' || r.description ELSE '' END AS statement,
              'fact' AS status, 'fact' AS kind, r.valid_from, r.valid_to, NULL::timestamptz AS event_at,
              COALESCE((SELECT d.path FROM documents d WHERE d.id = r.document_id), ${relationPath}) AS path,
              1 AS evidence_count, NULL::text AS chunk_id, NULL::float AS sim
       FROM relations r JOIN entities se ON se.id = r.source_id JOIN entities te ON te.id = r.target_id
       WHERE (r.source_id = ANY($1::text[]) OR r.target_id = ANY($1::text[])) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
       ORDER BY r.weight DESC, r.id LIMIT $2`,
      [named, ROUTE_CAP],
    ),
    store.query<Row>(
      `WITH near AS MATERIALIZED (
         (SELECT o.id FROM (SELECT CASE WHEN r.source_id = ANY($1::text[]) THEN r.target_id ELSE r.source_id END AS id, max(r.weight) AS w
                            FROM relations r
                            WHERE (r.source_id = ANY($1::text[]) OR r.target_id = ANY($1::text[])) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
                            GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${p.add(NEIGHBOURS_CAP)}) o)
         UNION ${variants}
       )
       SELECT cl.id, 1 AS via, ${CLAIM_COLUMNS}, ${sim} AS sim
       FROM claims cl ${CLAIM_JOINS}
       WHERE (cl.subject_id IN (SELECT id FROM near) OR cl.object_id IN (SELECT id FROM near)) AND ${LIVE_CLAIM} AND NOT cl.subject_id = ANY($1::text[])
       ORDER BY cl.tx_from DESC LIMIT ${p.add(ROUTE_CAP)}`,
      p.list,
    ),
  ]);
  return [...relations, ...claims];
}

/** What `pickRelevant` reads of a claim. */
export interface RankableClaim {
  id: string;
  subject: string;
  object?: string | null;
  statement: string;
  path?: string | null;
}

/**
 * The `limit` claims that answer `question` best, a few per source in turn.
 *
 * A claim is ranked by the question's terms it holds (each weighted by how
 * rare it is among the candidates) and, where `sim` gives one, by its
 * embedding's nearness to the question's; the two orders are fused by rank.
 * A claim matching neither is kept only when `named` says the question names
 * its entity: "what is known about X" matches no claim's words. Sources take
 * turns, `PER_SOURCE` claims a round, so a list question is answered from as
 * many documents as there are rather than from the best one.
 */
export function pickRelevant<T extends RankableClaim>(
  question: string,
  pool: T[],
  limit: number,
  opts: {
    sim?: (c: T) => number | null | undefined;
    named?: (c: T) => boolean;
    /** The text a claim is matched by (default its subject, statement and object). */
    text?: (c: T) => string;
    /** A third order, fused like the other two: how specific to the question the claim's subject is (higher first; null: not ranked by it). */
    specific?: (c: T) => number | null | undefined;
  } = {},
): T[] {
  if (pool.length === 0 || limit <= 0) return [];
  // "now", "最新": the question asks for the latest state, and claims holding the word are no nearer to it
  const terms = keywordTerms(question).filter((t) => !RECENCY_TERMS.has(t.toLowerCase()));
  const texts = pool.map((r) => (opts.text ? opts.text(r) : `${r.subject} ${r.statement} ${r.object ?? ''}`).toLowerCase());
  const idf = terms.map((t) => {
    const df = texts.filter((x) => termCount(x, t) > 0).length;
    return df === 0 ? 0 : Math.log(1 + (pool.length - df + 0.5) / (df + 0.5));
  });
  const lexical = texts.map((x) => terms.reduce((sum, t, i) => (idf[i] > 0 && termCount(x, t) > 0 ? sum + idf[i] : sum), 0));

  const rankOf = (score: (i: number) => number | null | undefined): Map<number, number> => {
    const order = pool.map((_, i) => i).filter((i) => (score(i) ?? 0) > 0).sort((a, b) => score(b)! - score(a)! || (pool[a].id < pool[b].id ? -1 : 1));
    return new Map(order.map((i, rank) => [i, rank]));
  };
  const byTerms = rankOf((i) => lexical[i]);
  const byVector = opts.sim ? rankOf((i) => opts.sim!(pool[i])) : new Map<number, number>();
  const bySubject = opts.specific ? rankOf((i) => opts.specific!(pool[i])) : new Map<number, number>();
  const ranked = pool
    .map((r, i) => {
      let score = 0;
      if (byTerms.has(i)) score += 1 / (RRF_K + byTerms.get(i)! + 1);
      if (byVector.has(i)) score += 1 / (RRF_K + byVector.get(i)! + 1);
      // only beside a match: a specific subject's claim that matches neither the words nor the embedding stays a named one
      if (bySubject.has(i) && score > 0) score += 1 / (RRF_K + bySubject.get(i)! + 1);
      return { r, score, named: opts.named?.(r) ?? false };
    })
    .filter((x) => x.score > 0 || x.named)
    .sort((a, b) => b.score - a.score || Number(b.named) - Number(a.named) || (a.r.id < b.r.id ? -1 : 1));

  const picked: T[] = [];
  const done = new Set<T>();
  const taken = new Map<string, number>();
  const seenText = new Set<string>();
  for (let round = 1; picked.length < limit && round <= Math.ceil(limit / PER_SOURCE) + 1; round++) {
    let added = false;
    for (const { r } of ranked) {
      if (picked.length >= limit) break;
      if (done.has(r)) continue;
      const source = r.path ?? '';
      if ((taken.get(source) ?? 0) >= PER_SOURCE * round) continue;
      done.add(r);
      const text = `${r.subject}|${r.statement}`;
      // the same statement from a second source says nothing new
      if (seenText.has(text)) continue;
      seenText.add(text);
      taken.set(source, (taken.get(source) ?? 0) + 1);
      picked.push(r);
      added = true;
    }
    if (!added) break;
  }
  return picked;
}
