import { LedgerEvent, readLedger } from './ledger.js';

import { CitedFile, citedBy, CitingPage, citesOf } from './citations.js';
import { readDeps } from './deps.js';
import { scopesForKey } from './scope.js';
import { Store } from '../store/db.js';
import { DepRow, ScopeRow } from './types.js';

/**
 * Lineage introspection — the agent-facing answer to "why does the knowledge
 * base believe this, and since when?": every live and historical evidence row
 * behind an entity / relation / claim, with the scope (source) that produced
 * it; the inputs a page was built from; the apply/dispose history of a source.
 */

export interface EvidenceView {
  scopeId: string;
  scopeKind: string;
  scopeKey: string;
  scopeSha: string;
  extractor: string;
  weight: number;
  segmentId: string | null;
  attrs: Record<string, unknown>;
  txFrom: string;
  txTo: string | null;
  live: boolean;
}

export interface LineageReport {
  kind: 'entity' | 'relation' | 'claim' | 'page' | 'document';
  id: string;
  current: Record<string, unknown> | null;
  evidence: EvidenceView[];
  deps?: DepRow[];
  scopes?: ScopeRow[];
  /** A document: the wiki pages citing it, and the raw/docs files it cites (src/graph/citations.ts). */
  citedBy?: CitingPage[];
  cites?: CitedFile[];
}

const TABLE: Record<'entity' | 'relation' | 'claim', string> = { entity: 'entities', relation: 'relations', claim: 'claims' };

export async function lineageOf(store: Store, kind: LineageReport['kind'], id: string): Promise<LineageReport> {
  if (kind === 'page') {
    const [current] = await store.query<Record<string, unknown>>(`SELECT * FROM pages WHERE path = $1`, [id]);
    // a generated page's inputs, or the documents a page no generator owns cites
    const deps = [...await readDeps(store, { kind: 'page', id }), ...await readDeps(store, { kind: 'cites', id })];
    const scopes = await scopesForKey(store, 'page', id);
    return { kind, id, current: current ?? null, evidence: [], deps, scopes };
  }
  if (kind === 'document') {
    const key = id;
    const [current] = await store.query<Record<string, unknown>>(`SELECT * FROM documents WHERE path = $1`, [key]);
    const scopes = await scopesForKey(store, 'doc', key);
    const children: ScopeRow[] = [];
    for (const s of scopes) {
      children.push(...(await store.query<ScopeRow>(`SELECT * FROM scopes WHERE parent_id = $1 ORDER BY applied_at DESC`, [s.id])).map(normalizeScope));
    }
    return {
      kind,
      id: key,
      current: current ?? null,
      evidence: [],
      scopes: [...scopes, ...children],
      citedBy: await citedBy(store, key),
      cites: await citesOf(store, key),
    };
  }
  const [current] = await store.query<Record<string, unknown>>(`SELECT * FROM ${TABLE[kind]} WHERE id = $1`, [id]);
  const rows = await store.query<{
    scope_id: string; kind: string; key: string; sha: string; extractor: string; weight: number; segment_id: string | null;
    attrs: Record<string, unknown>; tx_from: string; tx_to: string | null;
  }>(
    `SELECT ev.scope_id, s.kind, s.key, s.sha, ev.extractor, ev.weight, ev.segment_id, ev.attrs, ev.tx_from, ev.tx_to
     FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
     WHERE ev.kind = $1 AND ev.target_id = $2
     ORDER BY ev.tx_from DESC, ev.id DESC`,
    [kind, id],
  );
  return {
    kind,
    id,
    current: current ?? null,
    evidence: rows.map((r) => ({
      scopeId: r.scope_id,
      scopeKind: r.kind,
      scopeKey: r.key,
      scopeSha: r.sha,
      extractor: r.extractor,
      weight: r.weight,
      segmentId: r.segment_id,
      attrs: r.attrs,
      txFrom: iso(r.tx_from),
      txTo: r.tx_to ? iso(r.tx_to) : null,
      live: r.tx_to === null,
    })),
  };
}

export interface HistoryReport {
  key: string;
  scopes: ScopeRow[];
  events: LedgerEvent[];
}

/** Apply / dispose history of a source (document path, datasource id, page path). */
export async function historyOf(store: Store, dataDir: string, target: string): Promise<HistoryReport> {
  const key = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const scopes = (await store.query<ScopeRow>(`SELECT * FROM scopes WHERE key = $1 ORDER BY applied_at DESC`, [key])).map(normalizeScope);
  const ids = new Set(scopes.map((s) => s.id));
  const events = readLedger(dataDir).filter((e) => {
    if (e.ev === 'apply' || e.ev === 'dispose' || e.ev === 'purge' || e.ev === 'redate') return e.scope.key === key || ids.has(e.scope.id);
    return false;
  });
  return { key, scopes, events };
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function normalizeScope(row: ScopeRow): ScopeRow {
  return { ...row, applied_at: iso(row.applied_at), disposed_at: row.disposed_at ? iso(row.disposed_at) : null, meta: row.meta ?? {} };
}
