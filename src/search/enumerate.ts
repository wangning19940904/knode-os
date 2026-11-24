import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { Params, toDateString } from '../store/temporal.js';
import { ClaimRecord, queryClaims, sourcesOf } from '../store/claims.js';
import { foldTimeline } from '../graph/claim-timeline.js';
import { pickRelevant, QuestionFact } from './facts.js';

/**
 * Every claim matching a question's entities, claim types and time window
 * (docs/design/30 §2): what a list, aggregate or timeline question is
 * answered from, instead of the top few chunks a search returns.
 *
 * The match is SQL: claims about (subject or object) the entities the
 * question names and the ones merged into them, optionally of the claim types
 * it names, optionally dated inside the window it names — the date being the
 * claim's effective date when the store has one, else its event date, else
 * the start of its validity, else its document's date. Counts are taken over
 * the whole match (by month, by type, by subject, documents), so "how many"
 * is answered from the knowledge base and not from what fits in a prompt; the
 * claims themselves are listed up to a limit, each with every source behind it.
 *
 * Typed claim values. The claim-state work adds attribute / value columns to
 * claims (suggested: `attribute`, `value_num`, `value_text`, `unit`, and an
 * effective date). They are looked up in the schema once per store
 * (`typedColumns`) under the names in `CLAIM_TYPED_COLUMNS`, used when
 * present and ignored when not; settling on other names is a change to that
 * map alone.
 */

/** The typed claim columns by role, each with the names it may have in `claims`, first match wins. */
export const CLAIM_TYPED_COLUMNS = {
  attribute: ['attribute'],
  valueNum: ['value_num'],
  valueText: ['value_text'],
  unit: ['unit'],
  effective: ['effective_at', 'effective_date', 'effective_from'],
} as const;

export type TypedRole = keyof typeof CLAIM_TYPED_COLUMNS;
export type TypedColumns = Partial<Record<TypedRole, string>>;

const typedCache = new WeakMap<Store, Promise<TypedColumns>>();

/** Which typed claim columns this store has, by role. */
export function typedColumns(store: Store): Promise<TypedColumns> {
  let hit = typedCache.get(store);
  if (!hit) {
    hit = store
      .query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'claims'`)
      .then((rows) => {
        const have = new Set(rows.map((r) => r.column_name));
        const out: TypedColumns = {};
        for (const [role, names] of Object.entries(CLAIM_TYPED_COLUMNS) as [TypedRole, readonly string[]][]) {
          const name = names.find((n) => have.has(n));
          if (name) out[role] = name;
        }
        return out;
      })
      .catch(() => ({}));
    typedCache.set(store, hit);
  }
  return hit;
}

export interface EnumerateQuery {
  /** Entity ids: a claim matches when one of them is its subject or its object. */
  entities?: string[];
  /** Claim types; none = every type. */
  types?: string[];
  /** Statement substrings, any of which matches; used when no entity is given. */
  terms?: string[];
  /** World-time window on the claim's date (ISO instants; open sides null). */
  range?: { from: string | null; to: string | null } | null;
  /** Also list claims a newer one replaced (a timeline wants them; a count does not). */
  includeSuperseded?: boolean;
  /** `timeline`: oldest first; `recent`: newest first. */
  order?: 'timeline' | 'recent';
  /** Claims listed at most (the counts cover every match). */
  limit?: number;
  /**
   * With `order: 'timeline'`: fold restatements (graph/claim-timeline.ts) before the limit, so the
   * listed claims are the subject's changes rather than its weekly restatements; each folded
   * claim carries `repeats`. The counts still cover every match.
   */
  fold?: boolean;
  /**
   * List the claims that match the question best rather than the oldest: every match is read (up to `SCAN_CAP`),
   * ranked by the question's terms and, where a claim has an embedding of the question's model, by its nearness
   * (facts.ts `pickRelevant`, a few per source in turn), and the `limit` best are listed in date order. Without it
   * a hub entity's list was its first 150 claims by date, whatever the question asked about. Not with `fold`.
   */
  rank?: { question: string; queryVector?: number[]; model?: string };
}

export interface EnumeratedClaim extends QuestionFact {
  /** The date the window was tested on (effective, event, validity start or document date). */
  date: string | null;
  superseded: boolean;
  /** Every live source stating it. */
  sources: string[];
  attribute?: string | null;
  value?: string | null;
  unit?: string | null;
  /** With `fold`: the claim stands for this many restatements (itself included), first dated `date`, on these dates. */
  repeats?: { count: number; dates: string[] };
}

export interface Enumeration {
  claims: EnumeratedClaim[];
  /** Claims matched before the limit (at most `SCAN_CAP`: `capped` says whether there may be more). */
  matched: number;
  capped: boolean;
  /** Distinct documents behind the match. */
  documents: number;
  /** Counts over the whole match. */
  byMonth: [string, number][];
  byType: [string, number][];
  bySubject: [string, number][];
}

/** Matching claims counted at most. A hub entity of a finance workspace has thousands; past this the counts say "at least". */
export const SCAN_CAP = 5000;
/** Groups shown per count at most. */
const GROUPS = 40;

/** Claim types too general to be what a question names. */
const GENERIC_TYPES = new Set(['fact', 'event', 'other', 'statement', 'claim', 'general', 'attribute', 'description']);

/**
 * The claim types a question names in words: "earnings", "guidance",
 * "product launch" for `product_launch`. Generic types never count.
 */
export async function typesInQuestion(store: Store, question: string): Promise<string[]> {
  const rows = await store.query<{ type: string }>(`SELECT DISTINCT type FROM claims WHERE tx_to IS NULL LIMIT 500`);
  const q = question.toLowerCase();
  return rows
    .map((r) => r.type)
    .filter((t) => t && !GENERIC_TYPES.has(t.toLowerCase()))
    .filter((t) => {
      const words = t.toLowerCase().replace(/[_-]+/g, ' ').trim();
      if (words.length < 3) return false;
      const stem = words.replace(/s$/, '');
      return new RegExp(`(^|[^a-z])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(q) || q.includes(t.toLowerCase());
    });
}

/** The SQL of a match, as the `m` CTE both queries read, with its parameters. */
async function matchSql(store: Store, q: EnumerateQuery): Promise<{ sql: string; p: Params; typed: TypedColumns } | null> {
  const typed = await typedColumns(store);
  const p = new Params();
  const where = ['cl.tx_to IS NULL', 'cl.canonical_id IS NULL'];
  if (!q.includeSuperseded) where.push('cl.superseded_by IS NULL');
  const entities = [...new Set(q.entities ?? [])];
  const terms = (q.terms ?? []).filter((t) => t.trim().length >= 2).slice(0, 8);
  if (entities.length) {
    const e = p.add(entities);
    where.push(`(cl.subject_id = ANY(${e}::text[]) OR cl.object_id = ANY(${e}::text[]))`);
  } else if (terms.length) {
    where.push(`(${terms.map((t) => `cl.statement ILIKE ${p.add(`%${t.replace(/[%_\\]/g, '\\$&')}%`)}`).join(' OR ')})`);
  } else {
    return null; // nothing to enumerate by
  }
  if (q.types?.length) where.push(`cl.type = ANY(${p.add(q.types)}::text[])`);
  const effective = `COALESCE(${typed.effective ? `cl.${typed.effective}::timestamptz, ` : ''}cl.event_at, cl.valid_from, d.doc_date::timestamptz)`;
  if (q.range?.from) where.push(`${effective} >= ${p.add(q.range.from)}::timestamptz`);
  if (q.range?.to) where.push(`${effective} <= ${p.add(q.range.to)}::timestamptz`);
  const col = (role: TypedRole, cast = 'text') => (typed[role] ? `cl.${typed[role]}::${cast}` : `NULL::${cast}`);
  const sql = `m AS MATERIALIZED (
      SELECT cl.id, cl.subject_id, cl.object_id, se.name AS subject, oe.name AS object, cl.type, cl.statement, cl.status, cl.kind,
             cl.valid_from, cl.valid_to, cl.event_at, s.key AS path, cl.evidence_count, cl.chunk_id,
             cl.superseded_by, ${effective} AS eff, ch.document_id,
             ${col('attribute')} AS attribute, COALESCE(${col('valueNum')}, ${col('valueText')}) AS value, ${col('unit')} AS unit
      FROM claims cl
      JOIN entities se ON se.id = cl.subject_id
      LEFT JOIN entities oe ON oe.id = cl.object_id
      LEFT JOIN scopes s ON s.id = cl.primary_scope_id
      LEFT JOIN chunks ch ON ch.id = cl.chunk_id
      LEFT JOIN documents d ON d.id = ch.document_id
      WHERE ${where.join(' AND ')}
      LIMIT ${p.add(SCAN_CAP + 1)})`;
  return { sql, p, typed };
}

interface Row {
  subject_id: string; object_id: string | null;
  id: string; subject: string; object: string | null; type: string; statement: string; status: string; kind: string;
  valid_from: string | Date | null; valid_to: string | Date | null; event_at: string | Date | null; path: string | null;
  evidence_count: number; chunk_id: string | null; superseded_by: string | null; eff: string | Date | null;
  attribute: string | null; value: string | null; unit: string | null; sim?: number | null;
}

export async function enumerateClaims(store: Store, q: EnumerateQuery): Promise<Enumeration> {
  const empty: Enumeration = { claims: [], matched: 0, capped: false, documents: 0, byMonth: [], byType: [], bySubject: [] };
  const m = await matchSql(store, q);
  if (!m) return empty;
  const limit = Math.min(Math.max(q.limit ?? 150, 1), 1000);
  const order = q.order === 'recent' ? 'eff DESC NULLS LAST, id' : 'eff ASC NULLS LAST, id';
  const fold = q.fold === true && q.order !== 'recent';
  const rank = !fold && q.rank ? q.rank : null;
  // the counts read the match's parameters alone; the list adds the question's vector to them
  const base = [...m.p.list];
  // the question's nearness, for the ranked list: read off the claims' own embeddings, no call
  const sim = rank?.queryVector && rank.model
    ? `(SELECT 1 - (ce.embedding <=> ${m.p.add(toVectorLiteral(rank.queryVector))}::${VECTOR_TYPE}) FROM claim_embeddings ce WHERE ce.claim_id = m.id AND ce.model = ${m.p.add(rank.model)})`
    : 'NULL::float';
  const [read, counts] = await Promise.all([
    store.query<Row>(`WITH ${m.sql} SELECT m.*, ${sim} AS sim FROM m ORDER BY ${order} LIMIT ${fold || rank ? SCAN_CAP : limit}`, m.p.list),
    store.query<{ dim: string; label: string | null; n: number }>(
      `WITH ${m.sql}
       SELECT 'month' AS dim, to_char(eff, 'YYYY-MM') AS label, count(*)::int AS n FROM m WHERE eff IS NOT NULL GROUP BY 2
       UNION ALL SELECT 'type', type, count(*)::int FROM m GROUP BY 2
       UNION ALL SELECT 'subject', subject, count(*)::int FROM m GROUP BY 2
       UNION ALL SELECT 'documents', NULL, count(DISTINCT COALESCE(document_id, path))::int FROM m
       UNION ALL SELECT 'total', NULL, count(*)::int FROM m`,
      base,
    ),
  ]);
  // ranked: the best `limit`, shown in the order asked for (the scan's)
  let scanned = read;
  if (rank && read.length > limit) {
    const picked = new Set(pickRelevant(rank.question, read, limit, { sim: (r) => r.sim, named: () => true }));
    scanned = read.filter((r) => picked.has(r));
  }
  const total = counts.find((c) => c.dim === 'total')?.n ?? read.length;
  const group = (dim: string, byCount: boolean): [string, number][] => counts
    .filter((c) => c.dim === dim && c.label !== null)
    .map((c) => [c.label!, c.n] as [string, number])
    .sort((a, b) => (byCount ? b[1] - a[1] || a[0].localeCompare(b[0]) : a[0].localeCompare(b[0])))
    .slice(0, GROUPS);
  const entries = fold
    ? foldTimeline(scanned.map((r) => ({ ...r, value_num: null, value_text: r.value === null ? null : String(r.value), on: toDateString(r.eff) })), { series: false })
        .slice(0, limit)
        .map((e) => ({ row: e.head, members: e.members }))
    : scanned.map((r) => ({ row: r, members: [r] }));
  const sources = await sourcesOf(store, entries.flatMap((e) => e.members.map((r) => r.id)));
  const sourcesFor = (members: Row[]) => [...new Set(members.flatMap((r) => sources.get(r.id) ?? (r.path ? [r.path] : [])))].sort();
  return {
    claims: entries.map(({ row: r, members }) => ({
      id: r.id, subject: r.subject, object: r.object, type: r.type, statement: r.statement, status: r.status, kind: r.kind,
      startDate: toDateString(r.valid_from), endDate: toDateString(r.valid_to), eventDate: toDateString(r.event_at),
      path: r.path, evidenceCount: r.evidence_count, chunkId: r.chunk_id,
      date: toDateString(r.eff), superseded: Boolean(r.superseded_by), sources: sourcesFor(members),
      ...(m.typed.attribute || m.typed.valueNum || m.typed.valueText ? { attribute: r.attribute, value: r.value === null ? null : String(r.value), unit: r.unit } : {}),
      ...(members.length > 1 ? { repeats: { count: members.length, dates: [...new Set(members.map((x) => toDateString(x.eff)).filter((d): d is string => !!d))] } } : {}),
    })),
    matched: Math.min(total, SCAN_CAP),
    capped: total > SCAN_CAP,
    documents: counts.find((c) => c.dim === 'documents')?.n ?? 0,
    byMonth: group('month', false),
    byType: group('type', true),
    bySubject: group('subject', true),
  };
}

/** Readings of a measurement series shown in its entry at most. */
const READINGS_SHOWN = 12;

export interface SubjectTimelines {
  /** The entries listed, oldest first: each a change, a restated value said once, or a series with its readings. */
  claims: EnumeratedClaim[];
  /** Claims matched before folding, and the entries they folded into, over every subject. */
  matched: number;
  entries: number;
  /** Subjects read, and those whose entries were more than their share: these list the ones matching the question best. */
  subjects: number;
  ranked: number;
}

/** A timeline entry as a fact the prompt lists: a series carries its readings in its statement. */
function timelineFact(c: ClaimRecord): EnumeratedClaim {
  const readings = c.readings?.length
    ? ` — readings: ${c.readings.slice(0, READINGS_SHOWN).map((r) => `${r.date ?? '?'} ${r.value ?? '?'}`).join('; ')}${c.readings.length > READINGS_SHOWN ? `; … (${c.readings.length} in all)` : ''}`
    : '';
  return {
    id: c.id, subject: c.subject, object: c.object, type: c.type, statement: `${c.statement}${readings}`, status: c.status, kind: c.kind,
    startDate: toDateString(c.validFrom), endDate: toDateString(c.validTo), eventDate: toDateString(c.eventAt),
    path: c.sourcePath, evidenceCount: c.evidenceCount, chunkId: null,
    date: c.date, superseded: c.superseded, sources: c.sources, attribute: c.attribute, value: c.value,
    ...(c.repeats && c.repeats.count > 1 && !c.readings ? { repeats: c.repeats } : {}),
  };
}

/**
 * The chronology of each subject a timeline question names, as `knode_claims order="timeline" related=true` gives
 * it (store/claims.ts): dated by the claim's own event or validity before its sources' dates, superseded values
 * included, a value restated in later reports folded into the entry where it first appeared, a measurement series
 * one entry with its readings, and the claims about the subject's parts and members and with it as the object.
 * The subjects share `limit` entries; a subject with more than its share lists those matching the question best,
 * still in date order. Ask's own enumeration dated a restated "still open" by its newest restatement and listed the
 * first 150 claims by that date.
 */
export async function subjectTimelines(
  store: Store,
  subjects: string[],
  opts: { range?: { from: string | null; to: string | null } | null; limit: number; question: string },
): Promise<SubjectTimelines> {
  const out: SubjectTimelines = { claims: [], matched: 0, entries: 0, subjects: 0, ranked: 0 };
  if (subjects.length === 0) return out;
  const share = Math.max(1, Math.ceil(opts.limit / subjects.length));
  const eventRange = opts.range ? { from: opts.range.from, to: opts.range.to } : undefined;
  const results = await Promise.all(subjects.map((subject) =>
    queryClaims(store, { subject, related: true, order: 'timeline', eventRange, limit: 500 }).catch(() => null)));
  const seen = new Set<string>();
  for (const r of results) {
    if (!r || r.claims.length === 0) continue;
    out.subjects++;
    out.matched += r.matched;
    out.entries += r.entries;
    let claims = r.claims.filter((c) => !seen.has(c.id));
    if (claims.length > share) {
      out.ranked++;
      const picked = new Set(pickRelevant(opts.question, claims.map((c) => ({ ...c, path: c.sourcePath })), share, { named: () => true }).map((c) => c.id));
      claims = claims.filter((c) => picked.has(c.id));
    }
    for (const c of claims) {
      seen.add(c.id);
      out.claims.push(timelineFact(c));
    }
  }
  // one chronology over the subjects, undated last
  out.claims = out.claims.map((c, i) => ({ c, i })).sort((a, b) => {
    const [da, db] = [a.c.date, b.c.date];
    if (da && db && da !== db) return da < db ? -1 : 1;
    if (!da !== !db) return da ? -1 : 1;
    return a.i - b.i;
  }).map((x) => x.c);
  return out;
}
