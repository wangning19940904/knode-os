import { CLAIM_KINDS, claimTypeOf } from '../graph/store.js';
import { foldTimeline, TimelineEntry } from '../graph/claim-timeline.js';
import { Store } from './db.js';
import {
  NO_FILTER,
  NO_TEMPORAL,
  ResolvedScopeFilter,
  ResolvedTemporal,
  SourceKind,
  evidenceFilterSql,
  idsPassingFilter,
  overlapsValidWindow,
  resolveScopeFilter,
  resolveTemporal,
  validOverlap,
} from './resolver.js';
import {
  Params,
  evidenceAsOf,
  foldClaimEvidence,
  groupBy,
  live,
  toDateString,
  toIso,
} from './temporal.js';

/**
 * Structured claim access — the query surface behind `knode_claims`.
 *
 * Search returns prose an agent has to read and trust; this returns the
 * assertions themselves, each with its validity window, its status among
 * conflicting sources, and the scope that supports it. An agent that needs
 * "what do we hold about X, and since when" should ask here rather than
 * re-derive it from retrieved chunks.
 */

export interface ClaimQuery {
  /** Entity id, exact name, or alias — matched case-insensitively, substring as a fallback. */
  subject?: string;
  /** Same matching as `subject`, applied to the claim's object entity. */
  object?: string;
  /** Claim types (CLAIM_TYPES ids; a known old spelling such as `revenue` is mapped, an unknown one matches nothing). */
  types?: string[];
  /** fact | suspected | disputed */
  statuses?: string[];
  /** fact | opinion | prediction | rumor */
  kinds?: string[];
  /** Substring of the statement text. */
  text?: string;
  /**
   * Only claims whose date falls in this window (ISO instants; open sides null). The date is the
   * event time, else the start of validity, else the date the claim's source states or is dated
   * by: a weekly report's "R-115 is still open" has no event time but is dated by its week.
   */
  eventRange?: { from?: string | null; to?: string | null };
  /** Also return facts a newer fact of the same subject and type replaced. Default: hidden, except in a timeline, which is their history. */
  includeSuperseded?: boolean;
  /**
   * `timeline` orders by date ascending (see `eventRange`) and folds restatements into the
   * change they restate (graph/claim-timeline.ts); default is newest belief first.
   */
  order?: 'recent' | 'timeline';
  /** In a timeline, fold repeated readings and series (default true); false lists every row. */
  fold?: boolean;
  /**
   * Also the claims about the subject's parts and members (entities `part_of` / `member_of` /
   * `works_at` it) and the claims with it as their object: what happened in a team, not only
   * what was said of the team itself.
   */
  related?: boolean;
  /**
   * One claim per subject, its earliest dated one; with `eventRange`, the subjects first dated in
   * the window. What a count of new things in a period reads ("incidents reported in Q1", "risks
   * raised in 2025"): a later follow-up of an older incident is not a new one.
   */
  firstMention?: boolean;
  limit?: number;
  temporal?: ResolvedTemporal;
  filter?: ResolvedScopeFilter;
}

/** The `knode_claims` tool's arguments, as an agent sends them. */
export interface ClaimToolArgs {
  subject?: string;
  object?: string;
  types?: string[];
  statuses?: string[];
  claim_kinds?: string[];
  text?: string;
  event_range?: string;
  include_superseded?: boolean;
  order?: 'recent' | 'timeline';
  fold?: boolean;
  related?: boolean;
  first_mention?: boolean;
  limit?: number;
  as_of?: string;
  valid_at?: string;
  valid_range?: string;
  kinds?: SourceKind[];
  sources?: string[];
  trust?: 'trusted' | 'quarantined' | 'any';
  actor?: string;
}

/** The query a `knode_claims` call runs: the one mapping from tool arguments, shared by the tool and offline replays. */
export function claimQueryFromArgs(a: ClaimToolArgs): ClaimQuery {
  const range = a.event_range ? resolveTemporal({ validRange: a.event_range }) : null;
  return {
    subject: a.subject,
    object: a.object,
    types: a.types,
    statuses: a.statuses,
    kinds: a.claim_kinds,
    text: a.text,
    limit: a.limit,
    eventRange: range ? { from: range.validFrom, to: range.validTo } : undefined,
    includeSuperseded: a.include_superseded,
    order: a.order,
    fold: a.fold,
    related: a.related,
    firstMention: a.first_mention,
    temporal: resolveTemporal({ asOf: a.as_of, validAt: a.valid_at, validRange: a.valid_range }),
    filter: resolveScopeFilter({ kinds: a.kinds, sources: a.sources, trust: a.trust, actor: a.actor }),
  };
}

export interface ClaimRecord {
  id: string;
  subject: string;
  subjectId: string;
  object: string | null;
  objectId: string | null;
  type: string;
  statement: string;
  status: string;
  /** fact | opinion | prediction | rumor: what sort of assertion, apart from how firmly it is made (`status`). */
  kind: string;
  /** World time the assertion starts holding; null = open. */
  validFrom: string | null;
  /** World time it stops holding; null = still open. */
  validTo: string | null;
  /** The validity window closed before `now` — do not quote it as current. */
  stale: boolean;
  /** When the asserted event happened (date-only), if the source said. */
  eventAt: string | null;
  /** Date of the earliest source reporting it. */
  observedAt: string | null;
  /** The date a timeline places it at and an event range filters on: eventAt, else validFrom, else its source's date. */
  date: string | null;
  /** Where `date` comes from: event | validity | stated (in the text, not as an event) | document (the first source's own date). */
  dateBasis: 'event' | 'validity' | 'stated' | 'document' | null;
  /** The subject's attribute this claim gives a value of, and that value (docs/design/29). */
  attribute: string | null;
  value: string | null;
  /** In a folded timeline: the same value restated later — how often and on which dates (sources are in `sources`). */
  repeats?: { count: number; dates: string[] };
  /** With an event range and no first_mention: the subject was first dated before the window — a follow-up, not something new in it. */
  followUp?: true;
  /** In a folded timeline, a measurement series: each change of value, in date order. */
  readings?: { date: string | null; value: string | null; source: string | null }[];
  /** A newer fact of the same subject and type replaced this one (kept for history, hidden by default). */
  supersededBy: string | null;
  superseded: boolean;
  /** Path of the scope that first supported the claim. */
  sourcePath: string | null;
  /**
   * Every source that states it — in its own words or, for a merged group, in
   * the words of a claim merged into it (docs/design/10).
   */
  sources: string[];
  evidenceCount: number;
  /** System time the knowledge base started believing this version. */
  txFrom: string | null;
}

export interface ClaimQueryResult {
  claims: ClaimRecord[];
  /** Matching rows, before folding and `limit`. */
  matched: number;
  /** Entries after folding (a timeline), before `limit`; equals `matched` when nothing was folded. */
  entries: number;
  /** `limit` cut entries off: `note` says what was left out and how to get it. */
  truncated: boolean;
  note?: string;
  /** What the resolver actually applied — echoed so agents can see the envelope. */
  applied: string[];
}

const STATUSES = new Set(['fact', 'suspected', 'disputed']);
const KINDS = new Set<string>(CLAIM_KINDS);

interface Row {
  id: string;
  subject_id: string;
  subject: string;
  object_id: string | null;
  object: string | null;
  type: string;
  statement: string;
  status: string;
  kind: string;
  // the driver hands back Date objects for timestamptz; normalize before comparing
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  event_at?: string | Date | null;
  observed_at?: string | Date | null;
  superseded_by?: string | null;
  effective_at?: string | Date | null;
  date_source?: string | null;
  attribute?: string | null;
  value_num?: number | null;
  value_text?: string | null;
  unit?: string | null;
  source_path: string | null;
  evidence_count: number;
  tx_from: string | null;
}

/**
 * The date a claim sits at in a timeline, as SQL over `claims cl`: event time, else the start of
 * validity, else a date its text states, else the first source reporting it — a restated "still
 * open" sits where it was first said, not at its newest restatement (effective_at), which is last.
 */
const dateKey = (a: string) => `COALESCE(${a}.event_at, ${a}.valid_from, CASE WHEN ${a}.date_source = 'stated' THEN ${a}.effective_at END, ${a}.observed_at, ${a}.effective_at)`;
const DATE_KEY = dateKey('cl');

/**
 * The entities a reference names, as a subquery of ids: an id, a name or alias
 * (exact, else as a substring); the entities merged into those; and a
 * short-name twin — an entity of the same type named by an alias of an entity
 * the reference names exactly (its id, its name or one of its aliases), when
 * nothing else goes by that alias: a report's short name for a setting ("the
 * pool cap") extracted as an entity of its own, which the full name's aliases
 * list.
 *
 * A twin is taken only from an exact match and only within its type: on a
 * large workspace alias lists are noisy (a company's aliases there hold a
 * nickname that is also the name of a concept, and a product that merely
 * mentions the company matches as a substring), and a hop from every loose
 * match brought a sector's claims into a company's. The matched entities are
 * read once, and every entity going by one of their aliases once: the first
 * form of this scanned the entities again for each alias (0.75 s for one
 * subject on 164k entities).
 */
function entitySetSql(p: Params, ref: string): string {
  const exact = p.add(ref);
  const like = p.add(`%${ref}%`);
  const aliasesOf = (a: string) => `CASE WHEN jsonb_typeof(${a}.aliases) = 'array' THEN ${a}.aliases ELSE '[]'::jsonb END`;
  const precise = `(er.id = ${exact} OR lower(er.name) = lower(${exact}) OR ${aliasesOf('er')} @> to_jsonb(${exact}::text))`;
  return `WITH n AS MATERIALIZED (
      SELECT er.id, er.type, er.aliases, ${precise} AS precise
      FROM entities er
      WHERE ${precise} OR er.aliases::text ILIKE ${like} OR er.name ILIKE ${like}),
    al AS MATERIALIZED (
      SELECT DISTINCT n.id AS owner, n.type, a.alias, lower(a.alias) AS la
      FROM n CROSS JOIN LATERAL jsonb_array_elements_text(${aliasesOf('n')}) AS a(alias)
      WHERE n.precise AND length(a.alias) > 1),
    hit AS MATERIALIZED (
      SELECT e.id, e.type, e.canonical_id, lower(e.name) AS ln, e.aliases
      FROM entities e
      WHERE EXISTS (SELECT 1 FROM al)
        AND (lower(e.name) IN (SELECT la FROM al) OR (jsonb_typeof(e.aliases) = 'array' AND e.aliases ?| ARRAY(SELECT alias FROM al))))
    SELECT n.id FROM n
    UNION
    SELECT em.id FROM entities em WHERE em.canonical_id IN (SELECT n.id FROM n)
    UNION
    SELECT et.id FROM al JOIN hit et ON et.ln = al.la AND et.id <> al.owner AND et.canonical_id IS NULL AND et.type = al.type
    WHERE NOT EXISTS (
      SELECT 1 FROM hit eo
      WHERE eo.id <> al.owner AND eo.id <> et.id AND eo.canonical_id IS DISTINCT FROM al.owner
        AND (eo.ln = al.la OR eo.aliases @> to_jsonb(al.alias)))`;
}

/** Relations that make their source a part or member of their target. */
const PART_RELATIONS = ['part_of', 'member_of', 'works_at'];

/** Claim-reference predicate on `column` for an entity reference. */
function entityRefSql(column: string, p: Params, ref: string): string {
  return `${column} IN (${entitySetSql(p, ref)})`;
}

/** `related`: claims about the entities or their parts and members, or with them as the object. */
function relatedRefSql(p: Params, ref: string): string {
  const set = entitySetSql(p, ref);
  const parts = `SELECT r.source_id FROM relations r
    WHERE r.tx_to IS NULL AND r.type IN (${PART_RELATIONS.map((x) => p.add(x)).join(',')}) AND r.target_id IN (${set})`;
  return `(cl.subject_id IN (${set}) OR cl.subject_id IN (${parts}) OR cl.object_id IN (${set}))`;
}

export async function queryClaims(store: Store, q: ClaimQuery = {}): Promise<ClaimQueryResult> {
  const t = q.temporal ?? NO_TEMPORAL;
  const f = q.filter ?? NO_FILTER;
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const now = new Date().toISOString();
  const timeline = q.order === 'timeline';
  const includeSuperseded = q.includeSuperseded ?? timeline;
  const empty = (): ClaimQueryResult => ({ claims: [], matched: 0, entries: 0, truncated: false, applied: applied(t, f) });

  const p = new Params();
  const where: string[] = [];
  if (q.subject) where.push(q.related ? relatedRefSql(p, q.subject) : entityRefSql('cl.subject_id', p, q.subject));
  if (q.object) where.push(entityRefSql('cl.object_id', p, q.object));
  if (q.types?.length) {
    const types = [...new Set(q.types.map((x) => claimTypeOf(x) ?? x))];
    where.push(`cl.type IN (${types.map((x) => p.add(x)).join(',')})`);
  }
  if (q.statuses?.length) {
    const valid = q.statuses.filter((s) => STATUSES.has(s.toLowerCase()));
    if (valid.length === 0) return empty();
    where.push(`cl.status IN (${valid.map((x) => p.add(x.toLowerCase())).join(',')})`);
  }
  if (q.kinds?.length) {
    const valid = q.kinds.filter((k) => KINDS.has(k.toLowerCase()));
    if (valid.length === 0) return empty();
    where.push(`cl.kind IN (${valid.map((x) => p.add(x.toLowerCase())).join(',')})`);
  }
  if (q.text) where.push(`cl.statement ILIKE ${p.add(`%${q.text}%`)}`);
  if (!includeSuperseded) where.push('cl.superseded_by IS NULL');
  // a merged group answers once, as its representative
  where.push('cl.canonical_id IS NULL');
  if (q.firstMention) {
    where.push(`${DATE_KEY} IS NOT NULL`);
    where.push(`NOT EXISTS (SELECT 1 FROM claims c2 WHERE c2.subject_id = cl.subject_id AND c2.tx_to IS NULL AND c2.canonical_id IS NULL AND ${dateKey('c2')} < ${DATE_KEY})`);
  }
  if (q.eventRange?.from) where.push(`${DATE_KEY} >= ${p.add(q.eventRange.from)}::timestamptz`);
  if (q.eventRange?.to) where.push(`${DATE_KEY} <= ${p.add(q.eventRange.to)}::timestamptz`);

  // `as_of` reads fold from evidence, so the tx window and the scope filter are
  // applied after the candidate scan rather than inside it.
  const scan = t.txTime
    ? where
    : [...where, live('cl', p), validOverlap('cl', p, t), evidenceFilterSql('cl.id', 'claim', p, f, null)];

  const rows = await store.query<Row>(
    `SELECT cl.id, cl.subject_id, se.name AS subject, cl.object_id, oe.name AS object,
            cl.type, cl.statement, cl.status, cl.kind, cl.valid_from, cl.valid_to,
            cl.event_at, cl.observed_at, cl.superseded_by, cl.effective_at, cl.date_source,
            cl.attribute, cl.value_num, cl.value_text, cl.unit,
            s.key AS source_path, cl.evidence_count, cl.tx_from
     FROM claims cl
     JOIN entities se ON se.id = cl.subject_id
     LEFT JOIN entities oe ON oe.id = cl.object_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     ${scan.length ? `WHERE ${scan.join(' AND ')}` : ''}
     ORDER BY ${timeline ? `${DATE_KEY} ASC NULLS LAST, cl.tx_from ASC, cl.id` : 'cl.valid_from DESC NULLS LAST, cl.tx_from DESC'}`,
    p.list,
  );

  const asOf = t.txTime ? await foldAsOf(store, rows, t, f) : rows;
  // an as_of read re-dates rows from the evidence of then: order them again
  const ordered = (timeline && t.txTime ? sortByDate(asOf) : asOf).map(dated);
  // ties on the earliest date: one claim per subject still
  const projected = q.firstMention ? ordered.filter((r, i, all) => all.findIndex((x) => x.subject_id === r.subject_id) === i) : ordered;
  const entries: TimelineEntry<DatedRow>[] = timeline && q.fold !== false
    // one subject asked for: the entities it names are one thing (its old name, its short name)
    ? foldTimeline(projected, { acrossSubjects: Boolean(q.subject) && !q.related })
    : projected.map((r) => ({ kind: 'single', head: r, members: [r], changes: [] }));
  const page = entries.slice(0, limit);
  const sources = await sourcesOf(store, page.flatMap((e) => e.members.map((m) => m.id)));
  const truncated = entries.length > page.length;
  const result: ClaimQueryResult = {
    claims: page.map((e) => entryRecord(e, now, sources)),
    matched: projected.length,
    entries: entries.length,
    truncated,
    applied: applied(t, f),
  };
  if (timeline && q.includeSuperseded === undefined) result.applied.push('timeline: superseded values included (include_superseded=false hides them)');
  if (entries.length < projected.length) result.applied.push(`timeline: ${projected.length} claims folded into ${entries.length} entries (restated values and series; fold=false lists every claim)`);
  // a window read without first_mention holds follow-ups of older subjects beside the new ones: mark them, so a
  // count of what was new in the period does not take a later report of an old incident for a new incident
  if (q.eventRange?.from && !q.firstMention && !t.txTime && page.length) {
    const subjects = [...new Set(page.map((e) => e.head.subject_id))];
    const before = new Params();
    const older = await store.query<{ subject_id: string }>(
      `SELECT DISTINCT cl.subject_id FROM claims cl
       WHERE cl.subject_id = ANY(${before.add(subjects)}::text[]) AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
         AND ${DATE_KEY} < ${before.add(q.eventRange.from)}::timestamptz`,
      before.list,
    );
    if (older.length) {
      const old = new Set(older.map((r) => r.subject_id));
      page.forEach((e, i) => {
        if (old.has(e.head.subject_id)) result.claims[i].followUp = true;
      });
      result.applied.push(`window: ${old.size} of the ${subjects.length} subjects listed were first dated before it (followUp: true) — first_mention=true keeps only the subjects first dated in the window`);
    }
  }
  if (truncated) {
    const last = page[page.length - 1]?.head.on ?? null;
    result.note = timeline
      ? `showing the first ${page.length} of ${entries.length} entries, through ${last ?? 'the undated ones'}: ask again with event_range starting after ${last ?? 'that date'}, or a higher limit, for the rest`
      : `showing the newest ${page.length} of ${entries.length}: narrow with event_range / types / text, or raise limit, for the rest`;
  }
  return result;
}

interface DatedRow extends Row {
  on: string | null;
}

function dated(r: Row): DatedRow {
  return { ...r, on: dateOf(r).date };
}

function dateOf(r: Row): { date: string | null; basis: ClaimRecord['dateBasis'] } {
  const event = toDateString(r.event_at ?? null);
  if (event) return { date: event, basis: 'event' };
  const valid = toDateString(r.valid_from);
  if (valid) return { date: valid, basis: 'validity' };
  const effective = toDateString(r.effective_at ?? null);
  if (effective && r.date_source === 'stated') return { date: effective, basis: 'stated' };
  const observed = toDateString(r.observed_at ?? null) ?? effective;
  return observed ? { date: observed, basis: 'document' } : { date: null, basis: null };
}

function sortByDate(rows: Row[]): Row[] {
  const key = (r: Row) => dateOf(r).date ?? '￿';
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)) || String(a.tx_from ?? '').localeCompare(String(b.tx_from ?? '')) || a.id.localeCompare(b.id));
}

function valueOf(r: Row): string | null {
  if (r.value_num !== null && r.value_num !== undefined) return r.unit ? `${r.value_num} ${r.unit}` : String(r.value_num);
  return r.value_text ?? null;
}

/** One entry as a record: its head, with the sources of every row it stands for. */
function entryRecord(e: TimelineEntry<DatedRow>, now: string, sources: Map<string, string[]>): ClaimRecord {
  const merged = [...new Set(e.members.flatMap((m) => sources.get(m.id) ?? (m.source_path ? [m.source_path] : [])))].sort();
  const rec = project(e.head, now, merged.length ? merged : undefined);
  if (e.kind === 'repeat') {
    rec.repeats = { count: e.members.length, dates: [...new Set(e.members.map((m) => m.on).filter((d): d is string => !!d))] };
  } else if (e.kind === 'series') {
    rec.readings = e.changes.map((c) => ({ date: c.on, value: valueOf(c), source: c.source_path }));
    rec.repeats = { count: e.members.length, dates: [] };
  }
  return rec;
}

/** Claim id → the paths of every live source behind it and the claims merged into it. */
export async function sourcesOf(store: Store, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await store.query<{ rep: string; key: string }>(
    `SELECT DISTINCT COALESCE(c.canonical_id, c.id) AS rep, s.key
     FROM (SELECT id, canonical_id FROM claims WHERE id = ANY($1::text[])
           UNION ALL SELECT id, canonical_id FROM claims WHERE canonical_id = ANY($1::text[])) c
     JOIN evidence e ON e.kind = 'claim' AND e.target_id = c.id AND e.tx_to IS NULL
     JOIN scopes s ON s.id = e.scope_id
     ORDER BY s.key`,
    [ids],
  );
  for (const r of rows) (out.get(r.rep) ?? out.set(r.rep, []).get(r.rep)!).push(r.key);
  return out;
}

/** Rebuild the candidate rows from the evidence that was live at `txTime`. */
async function foldAsOf(store: Store, rows: Row[], t: ResolvedTemporal, f: ResolvedScopeFilter): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const asOf = t.txTime!;
  const evidence = await evidenceAsOf(store, 'claim', rows.map((r) => r.id), asOf);
  const grouped = groupBy(evidence, (e) => e.target_id);
  const allowed = await idsPassingFilter(store, 'claim', rows.map((r) => r.id), f, asOf);

  const scopeIds = new Set<string>();
  const folded: { row: Row; scopeId: string | null }[] = [];
  for (const row of rows) {
    if (!allowed.has(row.id)) continue;
    const fold = foldClaimEvidence(row, grouped.get(row.id) ?? []);
    if (!fold || !overlapsValidWindow(fold, t)) continue;
    if (fold.primary_scope_id) scopeIds.add(fold.primary_scope_id);
    folded.push({
      row: {
        ...row,
        type: fold.type,
        status: fold.status,
        kind: fold.kind,
        object_id: fold.object_id,
        valid_from: fold.valid_from,
        valid_to: fold.valid_to,
        event_at: fold.event_at,
        observed_at: fold.observed_at,
        evidence_count: fold.evidence_count,
        tx_from: (grouped.get(row.id) ?? []).map((e) => e.tx_from).sort()[0] ?? row.tx_from,
      },
      scopeId: fold.primary_scope_id,
    });
  }

  // the supporting scope at that time is not necessarily today's primary one
  const keys = new Map<string, string>();
  if (scopeIds.size > 0) {
    for (const s of await store.query<{ id: string; key: string }>(`SELECT id, key FROM scopes WHERE id = ANY($1::text[])`, [[...scopeIds]])) {
      keys.set(s.id, s.key);
    }
  }
  return folded.map(({ row, scopeId }) => ({ ...row, source_path: scopeId ? keys.get(scopeId) ?? null : null }));
}

function project(r: Row, now: string, sources?: string[]): ClaimRecord {
  const validTo = toIso(r.valid_to);
  const when = dateOf(r);
  return {
    id: r.id,
    subject: r.subject,
    subjectId: r.subject_id,
    object: r.object,
    objectId: r.object_id,
    type: r.type,
    statement: r.statement,
    status: r.status,
    kind: r.kind,
    validFrom: toDateString(r.valid_from),
    validTo: toDateString(validTo),
    stale: Boolean(validTo && validTo < now),
    eventAt: toDateString(r.event_at ?? null),
    observedAt: toDateString(r.observed_at ?? null),
    date: when.date,
    dateBasis: when.basis,
    attribute: r.attribute ?? null,
    value: valueOf(r),
    supersededBy: r.superseded_by ?? null,
    superseded: Boolean(r.superseded_by),
    sourcePath: r.source_path,
    sources: sources ?? (r.source_path ? [r.source_path] : []),
    evidenceCount: r.evidence_count,
    txFrom: r.tx_from,
  };
}

function applied(t: ResolvedTemporal, f: ResolvedScopeFilter): string[] {
  return [...t.notes, ...f.notes];
}
