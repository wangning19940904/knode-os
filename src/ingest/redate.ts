import { readSidecarPart, replayableTier1, SidecarTier1, updateSidecarPart } from '../fs/sidecar.js';
import { rekeyClaims } from '../graph/claim-rekey.js';
import { frontmatterExtraction } from '../graph/frontmatter.js';
import { loadOntology, normalizePredicate, Ontology } from '../graph/ontology.js';
import { claimId, readingWeek } from '../graph/store.js';
import { propagate } from '../lineage/deps.js';
import { foldTouched } from '../lineage/fold.js';
import { appendLedger, lockLedger, nextLedgerSeq } from '../lineage/ledger.js';
import { findLiveScope, foldOptions, liveChildren, scopeRef } from '../lineage/scope.js';
import { emptyTouched, ScopeRow } from '../lineage/types.js';
import { ParsedMarkdown } from '../markdown.js';
import { dateEnd, dateStart } from '../store/dates.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { SOURCE_SCOPE_KINDS, toIso } from '../store/temporal.js';
import { DocRoot } from '../types.js';
import { docDateOf } from './docdate.js';

/**
 * The version of the rules that read a document's date (docDateOf), kept in
 * its doc scope's meta as `dateRules`: 1 frontmatter and path; 2 a raw
 * document's dateline too. Bump it whenever docDateOf reads dates
 * differently: the next sync pass reads every document's date again and
 * re-dates, in place, those whose date reads otherwise now (redateDocument).
 */
export const DOC_DATE_RULES = 2;

/** A document's date as applying it reads it: a raw document may date itself in its first lines; anything else by its metadata alone. */
export function documentDate(file: string, root: DocRoot, parsed: ParsedMarkdown, at?: string | null): string | null {
  return docDateOf(file, parsed.frontmatter, root === 'docs' ? parsed.body : null, at ?? null);
}

export interface RedateOutcome {
  /** `same`: the date reads as stored; `redated`: changed in place; `unreadable`: a stored extraction could not be read again; `held`: its words do not account for its evidence. Nothing changed in the last two. */
  status: 'same' | 'redated' | 'unreadable' | 'held';
  was: string | null;
  now: string | null;
  /** Evidence rows given new dates. */
  claims: number;
  relations: number;
  /** Evidence rows whose stored dates are not what the old date gave, or whose words read two ways: the document is held. */
  unmatched: number;
  /** A claim whose dates now make it a weekly reading of another id: moved by the claim re-key (src/graph/claim-rekey.ts rekeyClaims). */
  rekey: boolean;
}

type ClaimDates = { valid_from: string | null; valid_to: string | null; event_at: string | null; observed_at: string | null; date_source: string | null };
type RelationDates = { valid_from: string | null; valid_to: string | null };

/** What applyExtraction (src/graph/llm-extract.ts) dates a claim with, on reference date `ref`. */
function claimDates(c: { startDate?: unknown; endDate?: unknown; eventDate?: unknown }, ref: string | null): ClaimDates {
  const validFrom = dateStart(c.startDate, ref);
  const eventAt = dateStart(c.eventDate, ref);
  return {
    valid_from: toIso(validFrom),
    valid_to: toIso(dateEnd(c.endDate, ref)),
    event_at: toIso(eventAt),
    observed_at: toIso(ref),
    date_source: eventAt || validFrom ? 'stated' : ref ? 'document' : null,
  };
}

function relationDates(r: { validFrom?: unknown; validTo?: unknown }, ref: string | null): RelationDates {
  return { valid_from: toIso(dateStart(r.validFrom, ref)), valid_to: toIso(dateEnd(r.validTo, ref)) };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const sameDates = (a: Record<string, string | null>, b: Record<string, string | null>) => Object.keys(a).every((k) => (a[k] ?? null) === (b[k] ?? null));
const nameKey = (v: unknown) => String(v ?? '').normalize('NFKC').trim().toLowerCase();

interface Words {
  claims: { statement: string; startDate?: unknown; endDate?: unknown; eventDate?: unknown }[];
  relations: { source: string; target: string; type: string; description?: string; validFrom?: unknown; validTo?: unknown }[];
}

/** A stored tier-1 extraction that can be read again: the one the live scope carries, whole. */
function readableTier1(t1: SidecarTier1 | null, child: ScopeRow, sha: string): Words | null {
  if (!t1 || child.sha !== sha || (t1.segmenter && child.meta.extractedAt !== t1.extractedAt)) return null;
  if (!Array.isArray(t1.entities) || !Array.isArray(t1.relations) || (t1.claims !== undefined && !Array.isArray(t1.claims))) return null;
  return { claims: t1.claims ?? [], relations: t1.relations };
}

interface EvidenceRow {
  id: string;
  kind: 'claim' | 'relation';
  target_id: string;
  attrs: Record<string, unknown>;
  subject_id: string | null;
  /** A relation's endpoints: their names and aliases, normalized. */
  ends: [string[], string[]] | null;
}

/** What a scope's re-date writes: evidence rows with their new attrs, or the rows the words cannot account for. */
interface ScopePlan {
  updates: { id: string; kind: 'claim' | 'relation'; target: string; attrs: Record<string, unknown>; moves: boolean }[];
  unmatched: number;
}

/**
 * Plan the re-date of one scope's evidence from the words it was read from.
 * A claim row is the extraction's claim of its statement whose dates under the
 * old reference date are the row's (date_source, which follows from them, is
 * not compared, nor observed_at where evidence written before it was recorded
 * lacks it); a
 * relation row is the extraction's relation of its type, description and
 * endpoints whose old dates are the row's. Every claim row must be accounted
 * for, one way: its observed_at moves with the document. Relation rows are
 * read only when one of the extraction's relations states a date relative to
 * the document; one that states none keeps none.
 */
async function planScope(q: Queryable, scopeId: string, words: Words, extractor: string | null, was: string | null, now: string | null, ontology: Ontology): Promise<ScopePlan> {
  const plan: ScopePlan = { updates: [], unmatched: 0 };
  const claims = new Map<string, { old: ClaimDates; next: ClaimDates }[]>();
  for (const c of words.claims) {
    const s = typeof c.statement === 'string' ? c.statement.trim() : '';
    if (!s) continue;
    claims.set(s, [...(claims.get(s) ?? []), { old: claimDates(c, was), next: claimDates(c, now) }]);
  }
  const relations = words.relations.filter((r) => r && typeof r.source === 'string' && typeof r.target === 'string').map((r) => {
    const norm = normalizePredicate(ontology, r.type);
    const [a, b] = norm.flip ? [r.target, r.source] : [r.source, r.target];
    return { type: norm.type, description: r.description ?? '', a: nameKey(a), b: nameKey(b), old: relationDates(r, was), next: relationDates(r, now) };
  });
  const relationsMove = relations.some((r) => !sameDates(r.old, r.next));
  const rows = await q.query<EvidenceRow>(
    `SELECT e.id::text AS id, e.kind, e.target_id, e.attrs, c.subject_id,
            CASE WHEN e.kind = 'relation' THEN jsonb_build_array(
              (SELECT jsonb_build_array(s.name) || s.aliases FROM entities s WHERE s.id = r.source_id),
              (SELECT jsonb_build_array(t.name) || t.aliases FROM entities t WHERE t.id = r.target_id)) END AS ends
     FROM evidence e
     LEFT JOIN claims c ON e.kind = 'claim' AND c.id = e.target_id
     LEFT JOIN relations r ON e.kind = 'relation' AND r.id = e.target_id
     WHERE e.scope_id = $1 AND e.tx_to IS NULL AND e.kind IN ('claim', 'relation') ${extractor ? 'AND e.extractor = $2' : ''}`,
    extractor ? [scopeId, extractor] : [scopeId],
  );
  const one = <T>(fits: { next: T }[]): T | null => {
    const distinct = [...new Map(fits.map((x) => [JSON.stringify(x.next), x.next])).values()];
    return distinct.length === 1 ? distinct[0] : null;
  };
  for (const row of rows) {
    const a = row.attrs ?? {};
    if (row.kind === 'claim') {
      const stored: Partial<ClaimDates> = { valid_from: str(a.valid_from), valid_to: str(a.valid_to), event_at: str(a.event_at) };
      // date_source follows from these and the reference date, so it is never compared; observed_at, where recorded, says which date wrote the row
      if ('observed_at' in a) stored.observed_at = str(a.observed_at);
      const fits = (claims.get(String(a.statement ?? '')) ?? []).filter((x) => sameDates(stored as Record<string, string | null>, x.old));
      const next = one(fits);
      if (!next) {
        plan.unmatched++;
        continue;
      }
      if (sameDates(next, { ...stored, date_source: str(a.date_source), observed_at: str(a.observed_at) } as ClaimDates)) continue;
      const { date_source, ...dates } = next;
      const attrs: Record<string, unknown> = { ...a, ...dates };
      delete attrs.date_source;
      if (date_source) attrs.date_source = date_source;
      // the id the writer would give it now (a weekly reading carries its week), as src/graph/claim-rekey.ts newIdOf reads it
      const statement = String(a.statement ?? '');
      const id = row.subject_id ? claimId(row.subject_id, statement, readingWeek({
        statement, eventAt: dates.event_at, validFrom: dates.valid_from, validTo: dates.valid_to, observedAt: dates.observed_at,
      })) : row.target_id;
      plan.updates.push({ id: row.id, kind: 'claim', target: row.target_id, attrs, moves: id !== row.target_id });
    } else {
      if (!relationsMove) continue;
      const [src, dst] = (row.ends ?? [[], []]).map((names) => new Set((Array.isArray(names) ? names : []).map(nameKey)));
      const stored: RelationDates = { valid_from: str(a.valid_from), valid_to: str(a.valid_to) };
      const fits = relations.filter((r) => r.type === a.type && r.description === String(a.description ?? '')
        && ((src.has(r.a) && dst.has(r.b)) || (src.has(r.b) && dst.has(r.a))) && sameDates(r.old, stored));
      const next = one(fits);
      if (!next) {
        plan.unmatched++;
        continue;
      }
      if (sameDates(next, stored)) continue;
      plan.updates.push({ id: row.id, kind: 'relation', target: row.target_id, attrs: { ...a, ...next }, moves: false });
    }
  }
  return plan;
}

/**
 * A document applied under older date rules (its doc scope's `dateRules` is
 * not DOC_DATE_RULES): read its date again, the way applying it reads it, and
 * when it reads otherwise than the stored doc_date re-date it in place, under
 * its existing scopes and ids: the document's date; the dates of the evidence
 * of its own frontmatter and of its stored tier-1 extraction (relative dates
 * read again from the stored words, `observed_at`, a claim stating none dated
 * by the document); and what folds from them, so its pages are re-planned and
 * the next refine supersedes by the new dates. The relations it supports are
 * folded as well: which document a relation cites goes by the documents'
 * dates. Nothing is applied again: no entity is resolved again, no scope
 * replaced, no evidence row opened or closed, and nothing anyone decided
 * moves. A claim whose new dates make it
 * a weekly reading of its own week keeps its id here and is left to the claim
 * re-key, which is set to visit it.
 *
 * A document whose date reads the same is only marked as checked. When a
 * stored extraction its live scope carries cannot be read again (missing, being
 * redone, damaged), or its words do not account for every evidence row,
 * nothing is changed: the scope is held for these rules (`dateHeld`, with the
 * reason) and it is said once; the next rules, or applying it again, read it
 * again. One transaction per re-dated document, then a ledger line (`redate`),
 * the sidecar's meta.docDate and the re-key of claims that are weekly readings
 * now; null when the scope is already current.
 */
export async function redateDocument(
  store: Store,
  live: ScopeRow,
  doc: { file: string; root: DocRoot; raw: string; sha: string; docId: string; at?: string; actor?: string },
  parse: () => ParsedMarkdown,
  log: (msg: string) => void = () => {},
): Promise<RedateOutcome | null> {
  if (live.meta.dateRules === DOC_DATE_RULES || (live.meta.dateHeld as { rules?: number } | undefined)?.rules === DOC_DATE_RULES) return null;
  const parsed = parse();
  const now = toIso(documentDate(doc.file, doc.root, parsed, doc.at));
  const [row] = await store.query<{ doc_date: string | Date | null }>(`SELECT doc_date FROM documents WHERE id = $1`, [doc.docId]);
  const was = toIso(row?.doc_date ?? null);
  const out: RedateOutcome = { status: 'same', was, now, claims: 0, relations: 0, unmatched: 0, rekey: false };
  const mark = (q: Queryable) => q.query(`UPDATE scopes SET meta = meta || $2::jsonb WHERE id = $1`, [live.id, JSON.stringify({ dateRules: DOC_DATE_RULES })]);
  if (now === was) {
    await mark(store);
    return out;
  }

  // the words each scope's dated evidence was read from
  const sources: { scopeId: string; words: Words; extractor: string | null }[] = [];
  const declared = doc.root === 'codebase' ? null : frontmatterExtraction(parsed.frontmatter);
  if (declared) sources.push({ scopeId: live.id, words: { claims: declared.claims, relations: declared.relations }, extractor: 'tier0.frontmatter' });
  for (const child of await liveChildren(store, live.id)) {
    if (child.kind !== 'tier1') continue;
    const words = readableTier1(replayableTier1(readSidecarPart(store.dataDir, doc.file, 'tier1'), doc.sha, doc.raw.length), child, doc.sha);
    if (words) {
      sources.push({ scopeId: child.id, words, extractor: null });
      continue;
    }
    const [held] = await store.query(`SELECT 1 FROM evidence WHERE scope_id = $1 AND tx_to IS NULL AND kind IN ('claim', 'relation') LIMIT 1`, [child.id]);
    if (!held) continue;
    await store.query(`UPDATE scopes SET meta = meta || $2::jsonb WHERE id = $1`, [live.id, JSON.stringify({ dateHeld: { rules: DOC_DATE_RULES, was, now, reason: 'unreadable extraction' } })]);
    log(`${doc.file}: its date reads ${now?.slice(0, 10) ?? 'none'} now, was ${was?.slice(0, 10) ?? 'none'}, but its stored extraction cannot be read again: left as it is until it is applied again`);
    return { ...out, status: 'unreadable' };
  }

  // read first, so a document is re-dated whole or not at all
  const ontology = loadOntology(store.dataDir);
  const plans: ScopePlan[] = [];
  for (const s of sources) plans.push(await planScope(store, s.scopeId, s.words, s.extractor, was, now, ontology));
  out.unmatched = plans.reduce((n, p) => n + p.unmatched, 0);
  if (out.unmatched) {
    // nothing changed; held for these rules with the reason, so a later rule (or a re-apply) reads it again
    await store.query(`UPDATE scopes SET meta = meta || $2::jsonb WHERE id = $1`, [live.id, JSON.stringify({ dateHeld: { rules: DOC_DATE_RULES, was, now, reason: 'unmatched evidence', unmatched: out.unmatched } })]);
    log(`${doc.file}: its date reads ${now?.slice(0, 10) ?? 'none'} now, was ${was?.slice(0, 10) ?? 'none'}, but ${out.unmatched} of its evidence rows are not what its stored words gave: left as it is`);
    return { ...out, status: 'held' };
  }
  const updates = plans.flatMap((p) => p.updates);
  out.claims = updates.filter((u) => u.kind === 'claim').length;
  out.relations = updates.filter((u) => u.kind === 'relation').length;
  const moved = [...new Set(updates.filter((u) => u.moves).map((u) => u.target))];
  out.rekey = moved.length > 0;
  const txTime = new Date().toISOString();

  const seq = await store.tx(async (q) => {
    await lockLedger(q);
    // applied again since the caller looked: that apply read the date itself
    if ((await findLiveScope(q, 'doc', doc.file))?.id !== live.id) return null;
    const touched = emptyTouched();
    for (const u of updates) {
      await q.query(`UPDATE evidence SET attrs = $2::jsonb WHERE id = $1`, [u.id, JSON.stringify(u.attrs)]);
      (u.kind === 'claim' ? touched.claims : touched.relations).add(u.target);
    }
    await q.query(`UPDATE documents SET doc_date = $2::timestamptz WHERE id = $1`, [doc.docId, now]);
    touched.documents.add(doc.file);
    // a relation cites the earliest-dated document that states it (store/temporal.ts relationSource): every
    // relation this document supports is folded again, so the ones its new date gives or takes move with it
    for (const r of await q.query<{ id: string }>(
      `SELECT DISTINCT ev.target_id AS id FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
       WHERE ev.kind = 'relation' AND ev.tx_to IS NULL AND s.kind = ANY($2::text[]) AND s.status <> 'disposed'
         AND (s.meta->>'documentId' = $1 OR s.key = $3)`,
      [doc.docId, [...SOURCE_SCOPE_KINDS], doc.file],
    )) touched.relations.add(r.id);
    const fold = await foldTouched(q, touched, txTime, foldOptions(store.dataDir));
    await propagate(q, fold.changed, fold.tombstoned, txTime);
    await mark(q);
    return nextLedgerSeq(q);
  });
  if (seq === null) return null;
  // the record is corrected, not versioned: the ledger says so, and the sidecar an attic replay dates the document by follows
  appendLedger(store.dataDir, { seq, ts: txTime, ev: 'redate', actor: doc.actor ?? 'sync', scope: scopeRef(live), documentId: doc.docId, from: was, to: now, rules: DOC_DATE_RULES });
  updateSidecarPart(store.dataDir, doc.file, 'meta', (m) => ({ ...m!, docDate: now }));
  log(`re-dated ${doc.file}: ${was?.slice(0, 10) ?? 'none'} → ${now?.slice(0, 10) ?? 'none'} (${out.claims} claim, ${out.relations} relation dates)`);
  // a claim that is a weekly reading now moves to its week's id, by the claim re-key, at once
  if (moved.length) await rekeyClaims(store, moved, { actor: doc.actor ?? 'sync', onProgress: log });
  return { ...out, status: 'redated' };
}
