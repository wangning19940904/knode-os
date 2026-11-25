/**
 * Lineage runtime types — the Cordis-style effect ledger mapped onto the
 * knowledge base: a *scope* is one apply of a source; every derived write it
 * makes is either implicit evidence (closed by scope id on dispose) or an
 * explicit *effect* carrying its own inverse.
 */

import type { TrustTier } from './trust.js';

export type ScopeKind = 'doc' | 'wiki-human' | 'tier1' | 'tables' | 'page' | 'datasource' | 'dataset' | 'dream' | 'absence' | 'merge' | 'claim-merge' | 'lint' | 'backref';
export type ScopeStatus = 'applying' | 'active' | 'disposed';
export type DisposeReason = 'removed' | 'replaced' | 'archived' | 'purge';

export interface ScopeRow {
  id: string;
  kind: ScopeKind;
  key: string;
  sha: string;
  parent_id: string | null;
  status: ScopeStatus;
  actor: string;
  applied_at: string;
  disposed_at: string | null;
  meta: Record<string, unknown>;
  /** The tier the scope was applied at, or promoted / demoted to since (src/lineage/trust.ts); read from `scopes`. */
  trust?: TrustTier;
}

/** Ids whose aggregate rows an apply/dispose touched (recomputed by the fold). */
export interface TouchedSet {
  entities: Set<string>;
  relations: Set<string>;
  claims: Set<string>;
  documents: Set<string>;
  datasets: Set<string>;
}

export function emptyTouched(): TouchedSet {
  return { entities: new Set(), relations: new Set(), claims: new Set(), documents: new Set(), datasets: new Set() };
}

export type DepInputKind = 'entity' | 'relation' | 'claim' | 'document' | 'dataset' | 'trace' | 'set';

export interface DepDecl {
  kind: DepInputKind;
  id: string;
  required?: boolean;
  /** Fingerprint of the input at generation time (fold_sha, document sha, set sha …). */
  sha?: string | null;
}

/**
 * `page`: a generated page's declared inputs (propagate marks it dirty or archives it). `suggestion`: what a
 * suggestion rests on. `cites`: the documents a page no generator owns cites (src/lineage/page-deps.ts) — kept
 * apart so they are read directly, and so propagate, which acts on `page` and `suggestion` only, never touches the page.
 */
export type ArtifactKind = 'page' | 'suggestion' | 'cites';

export interface DepRow {
  input_kind: DepInputKind;
  input_id: string;
  required: boolean;
  input_sha: string | null;
}

/** Recorded inverse of an explicit effect. Replayed in reverse order on dispose. */
export type InverseSpec =
  | { op: 'wiki_path.restore'; entityId: string; prev: string | null }
  | { op: 'row.restore'; table: 'datasets'; id: string; prev: Record<string, unknown> | null }
  | { op: 'queue.remove'; documentId: string }
  | { op: 'suggestion.retract'; id: string }
  | { op: 'deps.restore'; artifactKind: ArtifactKind; artifactId: string; prev: DepRow[] }
  | { op: 'page.restore'; path: string; prev: Record<string, unknown> | null }
  | { op: 'file.delete'; path: string }
  | { op: 'file.restore'; path: string; blob: string }
  | { op: 'region.restore'; path: string; region: string; prev: string | null }
  | { op: 'entity_link.remove'; linkId: string; entityId: string; prevCanonical: string | null }
  /** `regrouped`: members of the merged claim that were moved onto the new representative with it. */
  | { op: 'claim_link.remove'; linkId: string; claimId: string; prevCanonical: string | null; regrouped: string[] }
  | { op: 'noop' };

export type FsOp =
  | { op: 'write'; path: string; content: string }
  | { op: 'region'; path: string; region: string; content: string };

export type EffectKind = 'wiki_path' | 'row_upsert' | 'enqueue' | 'suggestion' | 'dep' | 'page' | 'file_write' | 'region_write' | 'entity_link' | 'claim_link';

/** Structured provenance reference carried by suggestions / pages instead of verbatim copies. */
export interface EvidenceRef {
  kind: 'claim' | 'chunk' | 'trace' | 'document' | 'receipt' | 'text';
  id?: string;
  path?: string;
  text?: string;
}

export interface WriterStats {
  entities: number;
  relations: number;
  claims: number;
  mentions: number;
  chunks: number;
  effects: number;
  capabilities: number;
  locators: number;
  /** Citations of raw/docs files a wiki page wrote (src/graph/citations.ts). */
  citations: number;
  /** Relation predicates that matched nothing in the ontology and fell back to related_to. */
  unknownPredicates: number;
  /** Table fact rows written (src/tables, a `tables` scope). */
  tableFacts?: number;
}
