import { Queryable } from '../store/migrations.js';
import {
  EntityAsOf,
  EvidenceAtRow,
  foldClaimEvidence,
  foldEntityEvidence,
  foldRelationEvidence,
  groupBy,
  Params,
  relationSource,
  scopeDocuments,
} from '../store/temporal.js';
import { EntityCorrection, EntityCorrections, refusedKeys, refuses } from '../graph/corrections.js';
import { CLAIM_STATE_VERSION } from '../graph/claim-state.js';
import { entityKeyKinds, KeyKind, nameKey } from '../graph/normalize.js';
import { emptyTouched, TouchedSet } from './types.js';
import { sha16 } from '../digest.js';

/**
 * The fold: recompute the visible aggregate columns of entities / relations /
 * claims from their *live* evidence, for exactly the ids an apply or dispose
 * touched, inside that same transaction.
 *
 * Rules are meant to be order-independent so a rebuild reproduces the same rows:
 *   entity   name = highest-weight evidence (ties: earliest, then lexicographic),
 *            type = the most-read typed reading (the ontology's order breaks a
 *            tie; concept only when nothing typed was read), a person's
 *            correction over both, longest description, alias union,
 *            mention_count = distinct chunks mentioning it
 *   relation weight = SUM(evidence.weight), longest description; its cited
 *            document = the earliest-dated that states it, then by path
 *            (store/temporal.ts relationSource)
 *   claim    status: all-absent > disputed > fact > suspected; valid_from = MIN;
 *            valid_to = NULL if any evidence is open-ended else MAX
 * A row with zero live evidence (or a dead endpoint / subject) is tombstoned
 * (tx_to set); one that regains evidence reopens with a fresh tx_from.
 */

export interface FoldResult {
  /** Rows whose fold changed or whose liveness flipped. */
  changed: TouchedSet;
  tombstoned: TouchedSet;
  reopened: TouchedSet;
}

export interface FoldOptions {
  /** Entity type precedence (from the ontology); defaults to the built-in order. */
  typePrecedence?: readonly string[];
  /** Words an alias may not be (src/graph/concept-stoplist.ts aliasStopKeys); none dropped when absent. */
  aliasStop?: ReadonlySet<string>;
  /** A person's corrections to single entities (src/graph/corrections.ts readEntityCorrections); none when absent. */
  corrections?: EntityCorrections;
}

export async function foldTouched(q: Queryable, touched: TouchedSet, txTime: string, opts: FoldOptions = {}): Promise<FoldResult> {
  const result: FoldResult = { changed: emptyTouched(), tombstoned: emptyTouched(), reopened: emptyTouched() };
  const relationIds = new Set(touched.relations);
  const claimIds = new Set(touched.claims);

  await foldEntities(q, [...touched.entities], txTime, result, opts);

  // liveness flips cascade to the edges and claims that hang off the entity,
  // but only to the rows whose liveness the flip can change. A tombstone can
  // only end the live ones; a return can only revive a row that still has
  // live evidence (a claim: its own, or its merged members'). Any other row
  // folds to what it already is, and a hub entity collects tens of thousands
  // of them — refolding those made re-importing a cleared corpus crawl.
  const tombstoned = [...result.tombstoned.entities];
  const reopened = [...result.reopened.entities];
  const liveEvidenceOf = (kind: string, alias: string) =>
    `EXISTS (SELECT 1 FROM evidence e WHERE e.kind = '${kind}' AND e.target_id = ${alias}.id AND e.tx_to IS NULL)`;
  const attached = async (ids: string[], revive: boolean) => {
    const rel = revive ? ` AND (r.tx_to IS NULL OR ${liveEvidenceOf('relation', 'r')})` : ' AND r.tx_to IS NULL';
    const cl = revive
      ? ` AND (c.tx_to IS NULL OR ${liveEvidenceOf('claim', 'c')}
          OR EXISTS (SELECT 1 FROM claims m JOIN evidence e ON e.kind = 'claim' AND e.target_id = m.id AND e.tx_to IS NULL WHERE m.canonical_id = c.id))`
      : ' AND c.tx_to IS NULL';
    for (const r of await selectIn<{ id: string }>(q, ids, (ph) => `SELECT r.id FROM relations r WHERE (r.source_id IN (${ph}) OR r.target_id IN (${ph}))${rel}`)) relationIds.add(r.id);
    for (const c of await selectIn<{ id: string }>(q, ids, (ph) => `SELECT c.id FROM claims c WHERE c.subject_id IN (${ph})${cl}`)) claimIds.add(c.id);
  };
  await attached(tombstoned, false);
  await attached(reopened, true);

  await foldRelations(q, [...relationIds], txTime, result);
  await foldClaims(q, [...claimIds], txTime, result);

  for (const d of touched.documents) result.changed.documents.add(d);
  for (const d of touched.datasets) result.changed.datasets.add(d);
  return result;
}

/**
 * Ids bound per IN list. Postgres takes at most 65,535 parameters in one
 * statement, and the edges of a single hub entity can number more.
 */
export const IN_BATCH = 5000;

/** Run `sql(placeholders)` over `ids` in slices that fit one statement, and return the rows of every slice. */
async function selectIn<T>(q: Queryable, ids: readonly string[], sql: (ph: string) => string, lead: unknown[] = []): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const p = new Params(lead);
    const ph = ids.slice(i, i + IN_BATCH).map((id) => p.add(id)).join(',');
    // a slice of hub edges can return more rows than a spread may pass as arguments
    for (const row of await q.query<T>(sql(ph), p.list)) rows.push(row);
  }
  return rows;
}

async function liveEvidence(q: Queryable, kind: string, ids: string[]): Promise<Map<string, EvidenceAtRow[]>> {
  if (ids.length === 0) return new Map();
  const rows = await selectIn<EvidenceAtRow>(
    q,
    ids,
    (ph) => `SELECT kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from
     FROM evidence WHERE kind = $1 AND target_id IN (${ph}) AND tx_to IS NULL`,
    [kind],
  );
  return groupBy(rows, (r) => r.target_id);
}

/** The fold under a person's correction: their type (one the ontology has), and none of the spellings they said the entity does not answer to. */
function corrected(folded: EntityAsOf | null, fix: EntityCorrection | undefined, refused: ReadonlySet<string>, precedence?: readonly string[]): EntityAsOf | null {
  if (!folded || !fix) return folded;
  const type = fix.type && (!precedence || precedence.includes(fix.type)) ? fix.type : folded.type;
  return { ...folded, type, aliases: folded.aliases.filter((a) => !refuses(refused, a)) };
}

async function foldEntities(q: Queryable, ids: string[], txTime: string, result: FoldResult, opts: FoldOptions): Promise<void> {
  if (ids.length === 0) return;
  const evidence = await liveEvidence(q, 'entity', ids);
  const mentionRows = await selectIn<{ entity_id: string; n: number }>(
    q,
    ids,
    (ph) => `SELECT entity_id, count(DISTINCT chunk_id)::int AS n FROM entity_mentions WHERE entity_id IN (${ph}) GROUP BY entity_id`,
  );
  const mentions = new Map(mentionRows.map((r) => [r.entity_id, r.n]));
  const current = await selectIn<{
    id: string; name: string; type: string; description: string; aliases: string[];
    mention_count: number; evidence_count: number; fold_sha: string; tx_to: string | null;
  }>(q, ids, (ph) => `SELECT id, name, type, description, aliases, mention_count, evidence_count, fold_sha, tx_to FROM entities WHERE id IN (${ph})`);

  for (const cur of current) {
    const rows = evidence.get(cur.id) ?? [];
    const mentionCount = mentions.get(cur.id) ?? 0;
    const wasLive = cur.tx_to === null;
    const fix = opts.corrections?.get(cur.id);
    const refused = refusedKeys(fix);
    const folded = corrected(foldEntityEvidence(cur.id, rows, mentionCount, cur, opts.typePrecedence, opts.aliasStop), fix, refused, opts.typePrecedence);
    if (!folded) {
      if (wasLive) {
        await q.query(
          `UPDATE entities SET tx_to = $2, evidence_count = 0, mention_count = $3, fold_sha = '', updated_at = now() WHERE id = $1`,
          [cur.id, txTime, mentionCount],
        );
        await q.query(`DELETE FROM entity_alias_keys WHERE entity_id = $1`, [cur.id]);
        result.tombstoned.entities.add(cur.id);
        result.changed.entities.add(cur.id);
      } else if (mentionCount !== cur.mention_count) {
        await q.query(`UPDATE entities SET mention_count = $2 WHERE id = $1`, [cur.id, mentionCount]);
      }
      continue;
    }
    const foldSha = sha16([folded.name, folded.type, folded.description, folded.aliases, folded.mention_count]);
    if (!wasLive) result.reopened.entities.add(cur.id);
    if (!wasLive || foldSha !== cur.fold_sha) result.changed.entities.add(cur.id);
    await q.query(
      `UPDATE entities SET name = $2, type = $3, description = $4, aliases = $5::jsonb, mention_count = $6,
              evidence_count = $7, fold_sha = $8,
              tx_from = CASE WHEN tx_to IS NOT NULL THEN $9::timestamptz ELSE tx_from END, tx_to = NULL,
              updated_at = now()
       WHERE id = $1`,
      [cur.id, folded.name, folded.type, folded.description, JSON.stringify(folded.aliases), mentionCount, folded.evidence_count, foldSha, txTime],
    );
    await refreshEntityKeys(q, cur.id, folded.name, folded.aliases, refused);
  }
}

/**
 * The lookup keys an entity answers to (graph/resolve.ts): its own folded
 * name and aliases plus those of every entity merged into it, with and
 * without corporate suffixes, less the spellings a person said it does not
 * answer to (never its own name). Rebuilt whenever the entity's fold runs.
 */
async function refreshEntityKeys(q: Queryable, id: string, name: string, aliases: string[], refused: ReadonlySet<string>): Promise<void> {
  const keys = entityKeyKinds(name, aliases);
  const members = await q.query<{ name: string; aliases: string[] }>(`SELECT name, aliases FROM entities WHERE canonical_id = $1 AND tx_to IS NULL`, [id]);
  for (const m of members) {
    const spellings = [m.name, ...(Array.isArray(m.aliases) ? m.aliases : [])].filter((s) => !refuses(refused, s));
    for (const [k, kind] of entityKeyKinds('', spellings)) {
      if (!keys.has(k) || (kind === 'exact' && keys.get(k) === 'bare')) keys.set(k, kind);
    }
  }
  const own = nameKey(name);
  for (const k of refused) if (k !== own.key && k !== own.bare) keys.delete(k);
  await q.query(`DELETE FROM entity_alias_keys WHERE entity_id = $1`, [id]);
  const list = [...keys.entries()] as [string, KeyKind][];
  if (list.length > 0) {
    // aliases and merged members accumulate with the corpus: two array parameters, not two per key
    await q.query(
      `INSERT INTO entity_alias_keys (entity_id, alias_key, kind)
       SELECT $1, k.alias_key, k.kind FROM unnest($2::text[], $3::text[]) AS k(alias_key, kind)
       ON CONFLICT DO NOTHING`,
      [id, list.map(([k]) => k), list.map(([, kind]) => kind)],
    );
  }
  await q.query(`UPDATE entities SET name_key = $2 WHERE id = $1`, [id, nameKey(name).bare || null]);
}

async function entityLiveness(q: Queryable, ids: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const rows = await selectIn<{ id: string; tx_to: string | null }>(q, ids, (ph) => `SELECT id, tx_to FROM entities WHERE id IN (${ph})`);
  for (const r of rows) out.set(r.id, r.tx_to === null);
  return out;
}

async function foldRelations(q: Queryable, ids: string[], txTime: string, result: FoldResult): Promise<void> {
  if (ids.length === 0) return;
  const evidence = await liveEvidence(q, 'relation', ids);
  const current = await selectIn<{
    id: string; source_id: string; target_id: string; type: string; description: string; weight: number;
    evidence_count: number; fold_sha: string; tx_to: string | null; document_id: string | null;
  }>(q, ids, (ph) => `SELECT id, source_id, target_id, type, description, weight, evidence_count, fold_sha, tx_to, document_id FROM relations WHERE id IN (${ph})`);
  const endpoints = [...new Set(current.flatMap((r) => [r.source_id, r.target_id]))];
  const alive = await entityLiveness(q, endpoints);
  // the document (and passage) each relation cites; provenance, so no part of fold_sha
  const docs = await scopeDocuments(q, [...evidence.values()].flatMap((rows) => rows.map((r) => r.scope_id)));

  for (const cur of current) {
    const rows = evidence.get(cur.id) ?? [];
    const wasLive = cur.tx_to === null;
    const folded = foldRelationEvidence(cur, rows);
    const live = Boolean(folded) && alive.get(cur.source_id) === true && alive.get(cur.target_id) === true;
    if (!live) {
      if (wasLive) {
        await q.query(`UPDATE relations SET tx_to = $2, evidence_count = $3, fold_sha = '' WHERE id = $1`, [cur.id, txTime, rows.length]);
        result.tombstoned.relations.add(cur.id);
        result.changed.relations.add(cur.id);
      }
      continue;
    }
    const foldSha = sha16([Number(folded!.weight.toFixed(3)), folded!.description, folded!.valid_from, folded!.valid_to]);
    if (!wasLive) result.reopened.relations.add(cur.id);
    const source = relationSource(rows, docs);
    // a page names the document: a relation that cites another now (a supporter of an earlier date, a
    // document re-dated, a rule that picks otherwise) is planned again, though nothing the sha covers moved
    const recited = cur.document_id !== (source?.documentId ?? null);
    if (!wasLive || foldSha !== cur.fold_sha || recited) result.changed.relations.add(cur.id);
    await q.query(
      `UPDATE relations SET weight = $2, description = $3, evidence_count = $4, fold_sha = $5,
              valid_from = $7::timestamptz, valid_to = $8::timestamptz,
              document_id = $9, chunk_id = (SELECT id FROM chunks WHERE id = $10),
              tx_from = CASE WHEN tx_to IS NOT NULL THEN $6::timestamptz ELSE tx_from END, tx_to = NULL
       WHERE id = $1`,
      [cur.id, folded!.weight, folded!.description, folded!.evidence_count, foldSha, txTime, folded!.valid_from, folded!.valid_to, source?.documentId ?? null, source?.chunkId ?? null],
    );
  }
}

async function foldClaims(q: Queryable, touchedIds: string[], txTime: string, result: FoldResult): Promise<void> {
  if (touchedIds.length === 0) return;
  // a merged claim's representative folds over the whole group (docs/design/10),
  // so touching a member refolds its representative as well
  const reps = await selectIn<{ canonical_id: string }>(
    q,
    touchedIds,
    (ph) => `SELECT DISTINCT canonical_id FROM claims WHERE id IN (${ph}) AND canonical_id IS NOT NULL`,
  );
  const ids = [...new Set([...touchedIds, ...reps.map((r) => r.canonical_id)])];
  const current = await selectIn<{
    id: string; subject_id: string; statement: string; fold_sha: string; tx_to: string | null; canonical_id: string | null;
  }>(q, ids, (ph) => `SELECT id, subject_id, statement, fold_sha, tx_to, canonical_id FROM claims WHERE id IN (${ph})`);
  const memberRows = await selectIn<{ id: string; canonical_id: string }>(q, ids, (ph) => `SELECT id, canonical_id FROM claims WHERE canonical_id IN (${ph})`);
  const members = groupBy(memberRows, (m) => m.canonical_id);
  const evidence = await liveEvidence(q, 'claim', [...new Set([...ids, ...memberRows.map((m) => m.id)])]);
  const subjects = [...new Set(current.map((c) => c.subject_id))];
  const alive = await entityLiveness(q, subjects);
  // a statement is read for its measure against its subject's name (claim-state.ts)
  const names = new Map((await selectIn<{ id: string; name: string }>(q, subjects, (ph) => `SELECT id, name FROM entities WHERE id IN (${ph})`)).map((e) => [e.id, e.name]));

  for (const cur of current) {
    const own = members.get(cur.id) ?? [];
    const rows = cur.canonical_id
      ? evidence.get(cur.id) ?? []
      : [...(evidence.get(cur.id) ?? []), ...own.flatMap((m) => evidence.get(m.id) ?? [])];
    const wasLive = cur.tx_to === null;
    const folded = foldClaimEvidence(cur, rows, names.get(cur.subject_id));
    const live = Boolean(folded) && alive.get(cur.subject_id) === true;
    if (!live) {
      if (wasLive) {
        await q.query(`UPDATE claims SET tx_to = $2, evidence_count = $3, fold_sha = '' WHERE id = $1`, [cur.id, txTime, rows.length]);
        result.tombstoned.claims.add(cur.id);
        result.changed.claims.add(cur.id);
      }
      continue;
    }
    const f = folded!;
    // a representative's group size is part of what it shows (its source count);
    // the kind joins only when it is not the default, so rows folded before
    // claims had one keep their sha and nothing downstream re-renders for it
    // the claim state joins only where it says something the old columns did not
    // (a measure, a correction, a newer supporter than the first), for the same reason
    const state = f.attribute || f.correction || (f.effective_scope_id && f.effective_scope_id !== f.primary_scope_id)
      ? [f.attribute, f.value_num, f.value_text, f.unit, f.effective_at, f.effective_scope_id, f.correction]
      : [];
    const foldSha = sha16([f.status, f.type, f.valid_from, f.valid_to, f.object_id, f.primary_scope_id, f.event_at, f.observed_at, ...(own.length ? [own.length] : []), ...(f.kind === 'fact' ? [] : [f.kind]), ...state]);
    if (!wasLive) result.reopened.claims.add(cur.id);
    if (!wasLive || foldSha !== cur.fold_sha) result.changed.claims.add(cur.id);
    await q.query(
      `UPDATE claims SET status = $2, type = $3, valid_from = $4::timestamptz, valid_to = $5::timestamptz,
              primary_scope_id = $6,
              object_id = (SELECT id FROM entities WHERE id = $7),
              chunk_id = (SELECT id FROM chunks WHERE id = $8),
              evidence_count = $9, fold_sha = $10,
              event_at = $12::timestamptz, observed_at = $13::timestamptz, kind = $14,
              attribute = $15, value_num = $16::float8, value_text = $17, unit = $18,
              effective_at = $19::timestamptz, date_source = $20, effective_scope_id = $21, correction = $22, state_v = $23,
              tx_from = CASE WHEN tx_to IS NOT NULL THEN $11::timestamptz ELSE tx_from END, tx_to = NULL
       WHERE id = $1`,
      [
        cur.id, f.status, f.type, f.valid_from, f.valid_to,
        f.primary_scope_id, f.object_id, f.segment_id, f.evidence_count, foldSha, txTime,
        f.event_at, f.observed_at, f.kind,
        f.attribute, f.value_num, f.value_text, f.unit, f.effective_at, f.date_source, f.effective_scope_id, f.correction, CLAIM_STATE_VERSION,
      ],
    );
  }
}

/** Full recompute (verification / repair). Returns how many rows changed. */
export async function recountAll(q: Queryable, txTime = new Date().toISOString(), opts: FoldOptions = {}): Promise<{ entities: number; relations: number; claims: number; changed: number }> {
  const touched = emptyTouched();
  for (const r of await q.query<{ id: string }>(`SELECT id FROM entities`)) touched.entities.add(r.id);
  for (const r of await q.query<{ id: string }>(`SELECT id FROM relations`)) touched.relations.add(r.id);
  for (const r of await q.query<{ id: string }>(`SELECT id FROM claims`)) touched.claims.add(r.id);
  const res = await foldTouched(q, touched, txTime, opts);
  return {
    entities: touched.entities.size,
    relations: touched.relations.size,
    claims: touched.claims.size,
    changed: res.changed.entities.size + res.changed.relations.size + res.changed.claims.size,
  };
}
