import { isCorrectionStatement, normalizeAttribute, parseMeasure } from '../graph/claim-state.js';
import { keyOf } from '../graph/normalize.js';
import { normalizeClaimType } from '../graph/store.js';
import { Queryable } from './migrations.js';

/**
 * Bitemporal helpers. Every graph row carries a system-time window
 * (`tx_from`, `tx_to`): `tx_to IS NULL` means "currently believed". Claims
 * additionally carry a world-time window (`valid_from`, `valid_to`).
 *
 *   as_of    = system time: what did the knowledge base contain at T?
 *   valid_at = world time:  which facts were true (asserted to hold) at T?
 *
 * Current-state queries read the materialized aggregate columns; `as_of`
 * queries recompute from the evidence table (see relationsAsOf / entitiesAsOf).
 */

export type TimeInput = string | Date | null | undefined;

export interface Temporal {
  asOf?: TimeInput;
  validAt?: TimeInput;
}

/** Positional parameter accumulator for hand-built SQL. */
export class Params {
  readonly list: unknown[] = [];
  constructor(initial: unknown[] = []) {
    this.list.push(...initial);
  }
  add(value: unknown): string {
    this.list.push(value);
    return `$${this.list.length}`;
  }
}

export function toIso(t: TimeInput): string | null {
  if (t === null || t === undefined || t === '') return null;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date-only projection (YYYY-MM-DD) for claim validity columns shown to humans/agents. */
export function toDateString(t: TimeInput): string | null {
  const iso = toIso(t);
  return iso ? iso.slice(0, 10) : null;
}

/** System-time predicate: `a.tx_to IS NULL`, or the window containing `asOf`. */
export function live(alias: string, p: Params, asOf?: TimeInput): string {
  const iso = toIso(asOf);
  if (!iso) return `${alias}.tx_to IS NULL`;
  const ph = p.add(iso);
  return `(${alias}.tx_from <= ${ph}::timestamptz AND (${alias}.tx_to IS NULL OR ${alias}.tx_to > ${ph}::timestamptz))`;
}

/** World-time predicate for claims: the validity window contains `at` (open ends match). */
export function validAt(alias: string, p: Params, at?: TimeInput): string {
  const iso = toIso(at);
  if (!iso) return 'TRUE';
  const ph = p.add(iso);
  return `((${alias}.valid_from IS NULL OR ${alias}.valid_from <= ${ph}::timestamptz) AND (${alias}.valid_to IS NULL OR ${alias}.valid_to >= ${ph}::timestamptz))`;
}

/**
 * Liveness of a graph row at a system time. Without `asOf` this is the
 * aggregate column (`tx_to IS NULL`); with one it asks whether any evidence
 * supported the row then, because the aggregates only hold the current state.
 */
export function rowLiveAt(alias: string, kind: 'entity' | 'relation' | 'claim', p: Params, asOf?: TimeInput): string {
  const iso = toIso(asOf);
  if (!iso) return live(alias, p);
  const ph = p.add(iso);
  return `EXISTS (
    SELECT 1 FROM evidence lv
    WHERE lv.kind = ${p.add(kind)} AND lv.target_id = ${alias}.id
      AND lv.tx_from <= ${ph}::timestamptz AND (lv.tx_to IS NULL OR lv.tx_to > ${ph}::timestamptz))`;
}

export interface EvidenceAtRow {
  kind: string;
  target_id: string;
  scope_id: string;
  segment_id: string | null;
  weight: number;
  extractor: string;
  attrs: Record<string, unknown>;
  tx_from: string;
}

/** The document a scope read, for the scopes that read one: a document's own scope, its tier-1 child, a back-reference from one of its claims. */
export interface ScopeDocument {
  documentId: string;
  /** The scope's key (the document's path, for a document's own scope and its tier-1 child). */
  key: string;
  /** The document's path and its date as they are now (`documents.doc_date`; null when it states none): what orders the sources of a relation. */
  path: string;
  date: string | null;
  /** The scope's kind, one of SOURCE_SCOPE_KINDS. */
  kind: string;
}

/**
 * The documents behind evidence scopes. A document's scope and its tier-1
 * child name it in `meta.documentId`; the human-prose scope of a generated
 * wiki page (`wiki-human`) names its page there too, but a page knode wrote is
 * no source, so it is left out with merges, research and a person's edits.
 */
/** Scopes that read a document: its own, its tier-1 extraction, and a back-reference link made from one of its claims (meta.documentId). */
export const SOURCE_SCOPE_KINDS = ['doc', 'tier1', 'backref'] as const;
const SOURCE_KINDS_SQL = SOURCE_SCOPE_KINDS.map((k) => `'${k}'`).join(', ');
/**
 * The id of the document the source scope aliased `s` read: the one its meta
 * names, as every scope an apply writes does; else the document at its key,
 * the path of a document's own scope and of its tier-1 child.
 */
const scopeDocumentSql = (s: string) => `COALESCE(${s}.meta->>'documentId', (SELECT kd.id FROM documents kd WHERE kd.path = ${s}.key))`;

export async function scopeDocuments(q: Queryable, scopeIds: Iterable<string>): Promise<Map<string, ScopeDocument>> {
  const ids = [...new Set(scopeIds)];
  const out = new Map<string, ScopeDocument>();
  if (ids.length === 0) return out;
  const rows = await q.query<{ id: string; key: string; kind: string; document_id: string; path: string; doc_date: string | Date | null }>(
    `SELECT s.id, s.key, s.kind, d.id AS document_id, d.path, d.doc_date
     FROM scopes s JOIN documents d ON d.id = ${scopeDocumentSql('s')}
     WHERE s.id = ANY($1::text[]) AND s.kind = ANY($2::text[])`,
    [ids, [...SOURCE_SCOPE_KINDS]],
  );
  for (const r of rows) out.set(r.id, { documentId: r.document_id, key: r.key, path: r.path, date: toIso(r.doc_date), kind: r.kind });
  return out;
}

/**
 * Evidence rows that were live at `asOf` for the given targets. The ids go to
 * the database as one array parameter: an `as_of` read folds every row it
 * matched, often more than one statement can bind (65,535 parameters).
 */
export async function evidenceAsOf(q: Queryable, kind: string, ids: string[], asOf: string): Promise<EvidenceAtRow[]> {
  if (ids.length === 0) return [];
  return q.query<EvidenceAtRow>(
    `SELECT kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from
     FROM evidence
     WHERE kind = $1 AND target_id = ANY($3::text[])
       AND tx_from <= $2::timestamptz AND (tx_to IS NULL OR tx_to > $2::timestamptz)`,
    [kind, asOf, ids],
  );
}

export interface EntityAsOf {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  wiki_path: string | null;
  mention_count: number;
  evidence_count: number;
}

export const TYPE_PRECEDENCE = ['person', 'organization', 'product', 'project', 'component', 'technology', 'event', 'location', 'datasource', 'dataset', 'other', 'concept'];

/**
 * Fold entity evidence into the row shape (shared by current-state folds and
 * as_of reads). `aliasStop` names the words an alias may not be (the stop
 * lists, by normalized key): an extractor's "other spelling" that is an
 * ordinary word stays in the evidence but out of the row.
 *
 * The type is the one most evidence rows read, among the types `precedence`
 * lists other than `concept`; the declared order only breaks a tie. `concept`
 * is the fallback tier-0 links, mind maps and mined terms write without
 * reading the entity, so it counts only when nothing typed was read, and a
 * type the ontology no longer has counts after it. Precedence first let one
 * stray reading decide: in finance (2026-10-30) 14 `organization` readings
 * outranked 1,090 `theme` ones for 人工智能, and one `product` reading 363
 * `market` ones for 创业板.
 */
export function foldEntityEvidence(
  id: string,
  rows: EvidenceAtRow[],
  mentionCount: number,
  fallback?: { name: string; type: string; description: string; aliases: string[] },
  precedence: readonly string[] = TYPE_PRECEDENCE,
  aliasStop?: ReadonlySet<string>,
): EntityAsOf | null {
  if (rows.length === 0) return null;
  // the name the heaviest reading gives, the earliest of equal weight: one pass,
  // not a sort of every row with two dates made per comparison — a hub entity
  // folds tens of thousands of rows each time a document names it
  let named: { weight: number; at: number; name: string } | null = null;
  for (const r of rows) {
    const n = str(r.attrs.name);
    if (!n) continue;
    const at = new Date(r.tx_from).getTime();
    if (!named || (named.weight - r.weight || at - named.at || n.localeCompare(named.name)) < 0) named = { weight: r.weight, at, name: n };
  }
  const name = named?.name ?? fallback?.name ?? id;
  const typeVotes = new Map<string, number>();
  for (const r of rows) {
    const t = str(r.attrs.type);
    if (t) typeVotes.set(t, (typeVotes.get(t) ?? 0) + 1);
  }
  let type = fallback?.type ?? 'concept';
  if (typeVotes.size > 0) {
    const place = (t: string) => (precedence.includes(t) ? precedence.indexOf(t) : precedence.length);
    const typed = (t: string) => (t === 'concept' ? 1 : precedence.includes(t) ? 0 : 2);
    type = [...typeVotes.entries()].sort((a, b) =>
      typed(a[0]) - typed(b[0]) || b[1] - a[1] || place(a[0]) - place(b[0]) || a[0].localeCompare(b[0]))[0][0];
  }
  let description = '';
  for (const r of rows) {
    const d = str(r.attrs.description) ?? '';
    if (d.length > description.length || (d.length === description.length && d < description)) description = d;
  }
  const aliasSet = new Map<string, string>();
  for (const r of rows) {
    const list = Array.isArray(r.attrs.aliases) ? r.attrs.aliases : [];
    for (const a of list) {
      const s = String(a).trim();
      if (!s || aliasStop?.has(keyOf(s))) continue;
      const k = s.toLowerCase();
      if (!aliasSet.has(k)) aliasSet.set(k, s);
    }
  }
  const aliases = [...aliasSet.values()].sort((a, b) => a.localeCompare(b));
  return { id, name, type, description, aliases, wiki_path: null, mention_count: mentionCount, evidence_count: rows.length };
}

export interface RelationAsOf {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string;
  weight: number;
  /** World-time window (folded like a claim's: MIN start, MAX end unless any supporter leaves it open). */
  valid_from: string | null;
  valid_to: string | null;
  evidence_count: number;
}

/**
 * The version of the rule below, kept in `meta.relation_sources.rule` once
 * every live relation's stored source follows it (src/lineage/relation-sources.ts
 * refreshRelationSources). Bump it whenever `relationSource` picks differently:
 * the next open goes over the live relations again, in place.
 */
export const RELATION_SOURCE_RULE = 2;

/** Code-unit order, which `COLLATE "C"` gives the same strings in SQL (`localeCompare` and a database's own collation depend on where they run). */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one document a relation cites, and the passage when its evidence was
 * grounded to one. Of the live supporters whose scope read a document: the
 * document with the earliest date (`documents.doc_date`; a document that
 * states no date comes after every dated one), then the first by path. That
 * depends on the corpus alone. Rule 1 took the supporter written first
 * (`tx_from`), so which document an entity page cited, and where the walk
 * found a relation's passage, changed with the order extraction happened to
 * finish in: two builds of one corpus disagreed.
 *
 * Within that document, its own scope (frontmatter, links) before its tier-1
 * extraction before a back-reference, as they are written, then by extractor,
 * a grounded supporter before one without a passage, the passage id: the
 * supporter the passage is taken from is as fixed as the document.
 *
 * Entity pages, the graph walk and `v_relations` read the stored
 * `relations.document_id` / `chunk_id` the fold writes by this rule;
 * `relationSourceSql` is the same choice of document in SQL, for a row whose
 * source is not stored yet.
 */
export type RelationSupporter = Pick<EvidenceAtRow, 'scope_id' | 'segment_id' | 'extractor'>;

export function relationSource(rows: readonly RelationSupporter[], docs: ReadonlyMap<string, ScopeDocument>): { documentId: string; chunkId: string | null } | null {
  const kindRank = (k: string) => {
    const i = (SOURCE_SCOPE_KINDS as readonly string[]).indexOf(k);
    return i < 0 ? SOURCE_SCOPE_KINDS.length : i;
  };
  let best: { r: RelationSupporter; doc: ScopeDocument } | null = null;
  for (const r of rows) {
    const doc = docs.get(r.scope_id);
    if (!doc) continue;
    if (!best) { best = { r, doc }; continue; }
    const d = (doc.date === null ? 1 : 0) - (best.doc.date === null ? 1 : 0)
      || byCode(doc.date ?? '', best.doc.date ?? '')
      || byCode(doc.path, best.doc.path)
      || byCode(doc.documentId, best.doc.documentId)
      || kindRank(doc.kind) - kindRank(best.doc.kind)
      || byCode(r.extractor, best.r.extractor)
      || (r.segment_id ? 0 : 1) - (best.r.segment_id ? 0 : 1)
      || byCode(r.segment_id ?? '', best.r.segment_id ?? '')
      || byCode(doc.key, best.doc.key)
      || byCode(r.scope_id, best.r.scope_id);
    if (d < 0) best = { r, doc };
  }
  return best ? { documentId: best.doc.documentId, chunkId: best.r.segment_id ?? null } : null;
}

/**
 * `relationSource`'s choice of document as a scalar subquery: the `path` or
 * the `id` of the document the relation aliased `rel` cites, read from its
 * live evidence. For readers of a row whose `document_id` is not stored
 * (written before v20 and not yet filled, or in a build opened read-only):
 * `COALESCE(<stored>, <this>)`.
 */
export function relationSourceSql(rel: string, column: 'path' | 'id'): string {
  return `(SELECT sd.${column} FROM evidence ev
      JOIN scopes s ON s.id = ev.scope_id AND s.kind IN (${SOURCE_KINDS_SQL})
      JOIN documents sd ON sd.id = ${scopeDocumentSql('s')}
      WHERE ev.kind = 'relation' AND ev.target_id = ${rel}.id AND ev.tx_to IS NULL
      ORDER BY sd.doc_date ASC NULLS LAST, sd.path COLLATE "C", sd.id COLLATE "C" LIMIT 1)`;
}

export function foldRelationEvidence(row: { id: string; source_id: string; target_id: string; type: string }, rows: EvidenceAtRow[]): RelationAsOf | null {
  if (rows.length === 0) return null;
  let description = '';
  let weight = 0;
  for (const r of rows) {
    weight += Number(r.weight) || 0;
    const d = str(r.attrs.description) ?? '';
    if (d.length > description.length || (d.length === description.length && d < description)) description = d;
  }
  const froms = rows.map((r) => toIso(str(r.attrs.valid_from))).filter((x): x is string => Boolean(x)).sort();
  const openEnded = rows.some((r) => !toIso(str(r.attrs.valid_to)));
  const tos = rows.map((r) => toIso(str(r.attrs.valid_to))).filter((x): x is string => Boolean(x)).sort();
  return {
    ...row,
    description,
    weight: Number(weight.toFixed(4)),
    valid_from: froms[0] ?? null,
    valid_to: openEnded ? null : tos[tos.length - 1] ?? null,
    evidence_count: rows.length,
  };
}

export interface ClaimAsOf {
  id: string;
  subject_id: string;
  object_id: string | null;
  type: string;
  statement: string;
  status: string;
  /** fact | opinion | prediction | rumor (highest-weight supporter's reading). */
  kind: string;
  valid_from: string | null;
  valid_to: string | null;
  /** When the event happened (highest-weight supporter's statement). */
  event_at: string | null;
  /** Earliest source date among supporters. */
  observed_at: string | null;
  primary_scope_id: string | null;
  segment_id: string | null;
  evidence_count: number;
  /**
   * The state the claim gives (docs/design/29): the attribute of its subject
   * and the value, from the extractor's reading, else the statement's
   * (src/graph/claim-state.ts). Null for a claim that is no measure.
   */
  attribute: string | null;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  /**
   * The date the claim speaks of: of each supporter, the date it states
   * (event, else start of window), else its document's; of all supporters,
   * the newest — a value a later report repeats is dated by that report.
   */
  effective_at: string | null;
  /** `stated` or `document`: where effective_at came from. */
  date_source: string | null;
  /** The scope of the supporter effective_at came from, so the date and the source shown agree. */
  effective_scope_id: string | null;
  correction: boolean;
}

/** One supporter's own date: the date it states, else its document's. */
function supporterDate(r: EvidenceAtRow): { at: string | null; source: 'stated' | 'document' | null } {
  const stated = toIso(str(r.attrs.event_at)) ?? toIso(str(r.attrs.valid_from));
  if (stated) return { at: stated, source: 'stated' };
  const observed = toIso(str(r.attrs.observed_at));
  return observed ? { at: observed, source: 'document' } : { at: null, source: null };
}

function finiteOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * `subjectName` lets the statement be read for a measure when no supporter
 * carries one (evidence written before claim state, frontmatter claims);
 * without it only the supporters' own readings count.
 */
export function foldClaimEvidence(row: { id: string; subject_id: string; statement: string }, rows: EvidenceAtRow[], subjectName?: string | null): ClaimAsOf | null {
  if (rows.length === 0) return null;
  const byWeight = [...rows].sort((a, b) => b.weight - a.weight || new Date(a.tx_from).getTime() - new Date(b.tx_from).getTime());
  const earliest = [...rows].sort((a, b) => new Date(a.tx_from).getTime() - new Date(b.tx_from).getTime() || a.scope_id.localeCompare(b.scope_id))[0];
  const statuses = rows.map((r) => str(r.attrs.status) ?? 'fact');
  // `absent` is not a weak `fact` — it is the assertion that nothing is there,
  // and it only holds while no source asserts otherwise. Folding it into
  // 'suspected' would quietly erase every recorded absence.
  const allAbsent = statuses.length > 0 && statuses.every((s) => s === 'absent');
  const status = allAbsent
    ? 'absent'
    : statuses.includes('disputed') ? 'disputed' : statuses.includes('fact') ? 'fact' : 'suspected';
  // evidence written before the closed list carries the extractor's own label (市场表现, 盈利预测 …)
  const type = normalizeClaimType(byWeight.map((r) => str(r.attrs.type)).find(Boolean));
  const kind = byWeight.map((r) => str(r.attrs.kind)).find(Boolean) ?? 'fact';
  const froms = rows.map((r) => toIso(str(r.attrs.valid_from))).filter((x): x is string => Boolean(x)).sort();
  const openEnded = rows.some((r) => !toIso(str(r.attrs.valid_to)));
  const tos = rows.map((r) => toIso(str(r.attrs.valid_to))).filter((x): x is string => Boolean(x)).sort();
  const objectId = byWeight.map((r) => str(r.attrs.object_id)).find(Boolean) ?? null;
  const eventAt = byWeight.map((r) => toIso(str(r.attrs.event_at))).find(Boolean) ?? null;
  const observed = rows.map((r) => toIso(str(r.attrs.observed_at))).filter((x): x is string => Boolean(x)).sort();
  // the newest supporter by its own date (ties: the later write, then the scope id)
  const dated = rows.map((r) => ({ r, ...supporterDate(r) }));
  const newest = dated
    .filter((d) => d.at)
    .sort((a, b) => b.at!.localeCompare(a.at!) || new Date(b.r.tx_from).getTime() - new Date(a.r.tx_from).getTime() || a.r.scope_id.localeCompare(b.r.scope_id))[0];
  // the reading of the newest supporter that gives one, else the statement's
  const measured = [...dated]
    .filter((d) => str(d.r.attrs.attribute))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || b.r.weight - a.r.weight)[0]?.r;
  let measure: { attribute: string; valueNum: number | null; valueText: string | null; unit: string | null } | null = null;
  if (measured) {
    const attribute = normalizeAttribute(measured.attrs.attribute) ?? str(measured.attrs.attribute)!;
    measure = { attribute, valueNum: finiteOrNull(measured.attrs.value_num), valueText: str(measured.attrs.value_text) ?? null, unit: str(measured.attrs.unit) ?? null };
  } else if (subjectName) {
    measure = parseMeasure(row.statement, subjectName);
  }
  const correction = rows.some((r) => r.attrs.correction === true) || isCorrectionStatement(row.statement);
  return {
    id: row.id,
    subject_id: row.subject_id,
    object_id: objectId,
    type,
    statement: row.statement,
    status,
    kind,
    valid_from: froms[0] ?? null,
    valid_to: openEnded ? null : tos[tos.length - 1] ?? null,
    event_at: eventAt,
    observed_at: observed[0] ?? null,
    primary_scope_id: earliest.scope_id,
    segment_id: earliest.segment_id,
    evidence_count: rows.length,
    attribute: measure?.attribute ?? null,
    value_num: measure?.valueNum ?? null,
    value_text: measure?.valueText ?? null,
    unit: measure?.unit ?? null,
    effective_at: newest?.at ?? null,
    date_source: newest?.source ?? null,
    effective_scope_id: newest?.r.scope_id ?? null,
    correction,
  };
}

/**
 * Entities as they were at `asOf`, recomputed from evidence (mention counts are
 * current). `precedence` is the workspace ontology's type order
 * (graph/ontology.ts typePrecedence), without which a type no core pack
 * declares counts only after `concept`.
 */
export async function entitiesAsOf(q: Queryable, ids: string[], asOf: string, precedence?: readonly string[]): Promise<EntityAsOf[]> {
  if (ids.length === 0) return [];
  const rows = await evidenceAsOf(q, 'entity', ids, asOf);
  const grouped = groupBy(rows, (r) => r.target_id);
  const current = await q.query<{ id: string; name: string; type: string; description: string; aliases: string[]; wiki_path: string | null; mention_count: number }>(
    `SELECT id, name, type, description, aliases, wiki_path, mention_count FROM entities WHERE id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(current.map((c) => [c.id, c]));
  const out: EntityAsOf[] = [];
  for (const id of ids) {
    const cur = byId.get(id);
    const folded = foldEntityEvidence(id, grouped.get(id) ?? [], cur?.mention_count ?? 0, cur ?? undefined, precedence);
    if (folded) out.push({ ...folded, wiki_path: cur?.wiki_path ?? null });
  }
  return out;
}

/** Relations touching `entityIds` that were live at `asOf`, recomputed from evidence. */
export async function relationsAsOf(q: Queryable, entityIds: string[], asOf: string): Promise<RelationAsOf[]> {
  if (entityIds.length === 0) return [];
  // past the seeds a graph search's frontier holds every neighbour it reached: one array parameter
  const candidates = await q.query<{ id: string; source_id: string; target_id: string; type: string }>(
    `SELECT id, source_id, target_id, type FROM relations WHERE source_id = ANY($1::text[]) OR target_id = ANY($1::text[])`,
    [entityIds],
  );
  if (candidates.length === 0) return [];
  const rows = await evidenceAsOf(q, 'relation', candidates.map((c) => c.id), asOf);
  const grouped = groupBy(rows, (r) => r.target_id);
  const out: RelationAsOf[] = [];
  for (const c of candidates) {
    const folded = foldRelationEvidence(c, grouped.get(c.id) ?? []);
    if (folded) out.push(folded);
  }
  return out;
}

/** Claims about `subjectIds` that were live at `asOf`, recomputed from evidence. */
export async function claimsAsOf(q: Queryable, subjectIds: string[], asOf: string): Promise<ClaimAsOf[]> {
  if (subjectIds.length === 0) return [];
  const candidates = await q.query<{ id: string; subject_id: string; statement: string }>(
    `SELECT id, subject_id, statement FROM claims WHERE subject_id = ANY($1::text[])`,
    [subjectIds],
  );
  if (candidates.length === 0) return [];
  const rows = await evidenceAsOf(q, 'claim', candidates.map((c) => c.id), asOf);
  const grouped = groupBy(rows, (r) => r.target_id);
  const out: ClaimAsOf[] = [];
  for (const c of candidates) {
    const folded = foldClaimEvidence(c, grouped.get(c.id) ?? []);
    if (folded) out.push(folded);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  return out;
}
