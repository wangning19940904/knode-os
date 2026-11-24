import crypto from 'node:crypto';
import fs from 'node:fs';
import { safePath } from '../fs/files.js';
import { carryOrigin } from '../fs/sidecar.js';
import {
  CLAIM_KINDS,
  CLAIM_STATUS,
  claimId,
  ExtractedEntity,
  normalizeClaimType,
  readingWeek,
  relationId,
  slugify,
} from '../graph/store.js';
import type { PlannedCitation } from '../graph/citations.js';
import type { TableFact } from '../tables/parse.js';
import { entityTypeIds, loadOntology, normalizePredicate, Ontology, relationSpec } from '../graph/ontology.js';
import { codeOf, MentionContext } from '../graph/identity.js';
import { followNamesake, NamesakeIndex, resolutionMode, resolveEntityId, ResolvedEntity } from '../graph/resolve.js';
import { EntityCorrections, readEntityCorrections, refusedKeys, refuses } from '../graph/corrections.js';
import { entityKeyKinds, KeyKind, mentionKeys, typesCompatible } from '../graph/normalize.js';
import { ReviewResolution } from '../config.js';
import { toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { toIso } from '../store/temporal.js';
import { DocRoot, SuggestionRow } from '../types.js';
import { storeBlob } from './attic.js';
import { readDeps, writeDeps } from './deps.js';
import { replaceRegion, splitRegions } from '../wiki/regions.js';
import { TrustTier } from './trust.js';
import {
  ArtifactKind,
  DepDecl,
  EffectKind,
  emptyTouched,
  EvidenceRef,
  FsOp,
  InverseSpec,
  ScopeRow,
  TouchedSet,
  WriterStats,
} from './types.js';

/**
 * The effect writer: everything a scope body writes goes through here, so
 * every write is either implicit evidence (closed by scope id on dispose) or
 * an explicit effect whose inverse is recorded before the forward action.
 *
 * Bound to one scope and one open transaction. Bodies must not await
 * network / LLM / embedding calls — compute first, write second — so the
 * transaction ends quickly: on PostgreSQL it holds a pooled connection and the
 * ledger row lock other writers queue on (`lockLedger`), on PGlite the single
 * connection.
 */

/** Citation rows per INSERT: ten parameters each, well under PostgreSQL's 65,535. */
const CITATION_BATCH = 500;
/** Table fact rows per INSERT: 24 parameters each, well under PostgreSQL's 65,535. */
const TABLE_FACT_BATCH = 500;

export interface DocumentProjection {
  id: string;
  path: string;
  root: DocRoot;
  title: string | null;
  sha256: string;
  mime: string;
  bytes: number;
  /** Length of the indexed text in characters (the Summarize stage's size threshold reads it). */
  chars?: number;
  /** The language of the indexed text (src/lang/detect.ts); null when it has no letters. */
  language?: string | null;
  kind: 'source' | 'view';
  /** Reference date of the source (ISO), when one was found. */
  docDate?: string | null;
}

export interface ChunkRow {
  id: string;
  seq: number;
  content: string;
  tokenCount: number;
}

export interface DatasetUpsert {
  id: string;
  source_id: string;
  table_name: string;
  kind: string;
  columns: { name: string; type: string }[];
  row_count: number | null;
  schema_sha: string;
  description: string;
  entity_count: number;
}

export interface CapabilityUpsert {
  /** Logical id, stable across re-applies: `<source>.<name>`. */
  id: string;
  kind: 'table' | 'endpoint' | 'metric' | 'tool';
  source_id: string;
  name: string;
  title?: string;
  /** How a request against this capability is written: sql, promql, http, object, tool. */
  dialect?: string;
  /** The dataset / tool entity this capability corresponds to, when there is one. */
  entity_id?: string | null;
  schema?: unknown;
  semantics?: string;
  sample_queries?: unknown[];
  freshness_seconds?: number | null;
  cost?: number;
  acl?: unknown[];
  placement?: 'materialize' | 'federate' | 'cache';
}

export interface CapabilityNote {
  capability_id: string;
  source_path: string;
  semantics?: string;
  sample_queries?: unknown[];
  pitfalls?: unknown[];
  joins?: unknown[];
  cost?: number | null;
  freshness_seconds?: number | null;
}

export interface PageUpsert {
  path: string;
  kind: string;
  generator: string;
  inputs_sha: string;
  file_sha: string | null;
  regions: { id: string; sha: string }[];
}

export interface NewSuggestion {
  id?: string;
  kind: SuggestionRow['kind'];
  title: string;
  body: string;
  evidence: SuggestionRow['evidence'] | EvidenceRef[];
  reportPath?: string | null;
  payload?: unknown;
}

export class ScopeWriter {
  readonly touched: TouchedSet = emptyTouched();
  readonly fsOps: FsOp[] = [];
  readonly stats: WriterStats = { entities: 0, relations: 0, claims: 0, mentions: 0, chunks: 0, effects: 0, capabilities: 0, locators: 0, citations: 0, unknownPredicates: 0 };
  private readonly entityTypes: Set<string>;
  private readonly resolveCache = new Map<string, ResolvedEntity>();
  /** Lookup keys of entities written by this scope body — the fold publishes them only after commit. */
  private readonly localKeys = new Map<string, { id: string; name: string; type: string; kind: KeyKind }>();
  /** The names that were parted into several entities (graph/identity.ts), read once for this body. */
  private readonly namesakes = new NamesakeIndex();
  /** review.resolution: 'exact' (spelling must match) or 'suffix' (corporate suffixes ignored). */
  private readonly resolution: ReviewResolution;
  /** Spellings a person said an entity does not answer to: never resolved onto it, here or in the graph. */
  private readonly corrections: EntityCorrections;
  /** Ids this body has written outright (a later mention with that slug is the same entity, not a redirect). */
  private readonly localIds = new Set<string>();
  private readonly seenEvidence = new Set<string>();
  /** Entity ids known to exist in this transaction (created here or verified once). */
  private readonly knownEntities = new Set<string>();
  /** The chunks this body mentioned each entity in, in order: where a relation between two of them is grounded. */
  private readonly mentionedIn = new Map<string, string[]>();

  constructor(
    readonly q: Queryable,
    readonly scope: ScopeRow,
    readonly txTime: string,
    readonly dataDir: string,
    /** Tier every evidence row this scope writes is stamped with. */
    readonly trust: TrustTier = 'trusted',
    /** Vocabulary the writes are validated against (the data dir's packs by default). */
    readonly ontology: Ontology = loadOntology(dataDir),
  ) {
    this.entityTypes = entityTypeIds(ontology);
    this.resolution = resolutionMode(dataDir);
    this.corrections = readEntityCorrections(dataDir);
  }

  /* ------------------------------ evidence ------------------------------ */

  /**
   * Entity evidence. Without an explicit `id` the mention is resolved first
   * (graph/resolve.ts): an entity already known under another spelling, or one
   * merged into a survivor, receives the evidence instead of a new row, and
   * the mention's own spelling is kept as an alias so the fold surfaces it. A
   * name that was parted into several entities resolves to the one its
   * document means.
   */
  async entity(
    e: ExtractedEntity,
    /** `context`: what the mention's document says about it — which of a parted name's entities it means (graph/identity.ts). */
    o: { extractor: string; weight?: number; segmentId?: string | null; id?: string; sameAs?: string | null; context?: MentionContext },
  ): Promise<string> {
    const name = e.name.trim();
    let id = o.id;
    let resolved: ResolvedEntity | null = null;
    if (!id) {
      const slug = slugify(name);
      const local = this.localIds.has(slug) ? null : this.findLocal(name, e.aliases ?? [], e.type);
      if (local && local.id !== slug) resolved = { id: local.id, name: local.name, resolvedFrom: name };
      else {
        resolved = await resolveEntityId(
          this.q,
          { name, type: e.type, aliases: e.aliases, sameAs: o.sameAs ?? e.sameAs ?? null, context: o.context },
          this.resolveCache,
          { mode: this.resolution, corrections: this.corrections, namesakes: this.namesakes },
        );
      }
      id = resolved.id;
    }
    const type = this.entityTypes.has(e.type) ? e.type : 'concept';
    // an entity parted from its namesake by a code keeps that code alone: another one among the
    // mention's spellings is the namesake's, repeated by an extraction that was shown its name
    const own = resolved?.namesake ? codeOf(resolved.namesake.label) : null;
    const keeps = (spelling: string) => {
      const c = own ? codeOf(spelling) : null;
      return !c || c.value === own!.value;
    };
    const aliases = (e.aliases ?? []).map(String).filter(keeps);
    const redirected = Boolean(resolved?.resolvedFrom);
    if (redirected && name && keeps(name) && !aliases.some((a) => a.toLowerCase() === name.toLowerCase())) aliases.push(name);
    const evidenceName = (redirected ? resolved?.name : undefined) ?? name ?? id;
    await this.q.query(
      `INSERT INTO entities (id, name, type, description, aliases, tx_from)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, evidenceName || id, type, e.description ?? '', JSON.stringify(aliases), this.txTime],
    );
    await this.addEvidence('entity', id, o.extractor, o.weight ?? 1, o.segmentId ?? null, {
      name: evidenceName || id,
      type,
      description: e.description ?? '',
      aliases,
      ...(redirected ? { resolved_from: resolved!.resolvedFrom } : {}),
    });
    // the evidence keeps what the extractor said; a later mention in this body only lands here under a spelling the entity answers to
    const refused = refusedKeys(this.corrections.get(id));
    for (const [k, kind] of entityKeyKinds(evidenceName, aliases.filter((a) => !refuses(refused, a)))) if (!this.localKeys.has(k)) this.localKeys.set(k, { id, name: evidenceName || id, type, kind });
    this.localIds.add(id);
    this.knownEntities.add(id);
    this.touched.entities.add(id);
    return id;
  }

  /**
   * Which entity a link to `entity` means in this document, where that entity
   * belongs to a name refine parted (graph/identity.ts): the one the
   * document's own names point at, else `entity` itself.
   */
  async namesakeOf(entity: { id: string; name: string }, spellings: readonly string[], context: MentionContext): Promise<{ id: string; name: string }> {
    const meant = await followNamesake(this.q, entity, { name: entity.name, spellings, context }, this.namesakes, this.corrections.size ? (id) => refuses(refusedKeys(this.corrections.get(id)), entity.name) : undefined);
    return meant ?? entity;
  }

  /** An entity this body already wrote that answers to one of the mention's keys (same type, or an untyped placeholder on either side), and not one that refuses its name. */
  private findLocal(name: string, aliases: string[], type: string): { id: string; name: string; type: string } | null {
    for (const k of mentionKeys(name, aliases, this.resolution)) {
      const hit = this.localKeys.get(k);
      if (hit && (this.resolution === 'suffix' || hit.kind === 'exact') && typesCompatible(type, hit.type) && !refuses(refusedKeys(this.corrections.get(hit.id)), name)) return hit;
    }
    return null;
  }

  private async entitiesExist(ids: string[]): Promise<boolean> {
    const unknown = ids.filter((id) => !this.knownEntities.has(id));
    if (unknown.length === 0) return true;
    const ph = unknown.map((_, i) => `$${i + 1}`).join(',');
    const rows = await this.q.query<{ id: string }>(`SELECT id FROM entities WHERE id IN (${ph})`, unknown);
    for (const r of rows) this.knownEntities.add(r.id);
    return rows.length === unknown.length;
  }

  /**
   * A typed edge. The predicate is normalized against the ontology: a synonym
   * becomes the canonical id, an inverse reading (`parent_of`) becomes the
   * canonical id with the endpoints swapped, a symmetric predicate is stored
   * once with ordered endpoints, and an unknown spelling falls back to
   * `related_to` while keeping the original in `attrs.raw_type` and counting
   * it in `stats.unknownPredicates`.
   */
  async relation(
    sourceId: string,
    targetId: string,
    r: { type: string; description?: string; weight?: number; extractor: string; segmentId?: string | null; validFrom?: string | null; validTo?: string | null },
  ): Promise<string | null> {
    if (sourceId === targetId) return null;
    if (!(await this.entitiesExist([sourceId, targetId]))) return null;
    const segmentId = r.segmentId ?? this.passageOf(sourceId, targetId);
    const norm = normalizePredicate(this.ontology, r.type);
    const type = norm.type;
    let [a, b] = norm.flip ? [targetId, sourceId] : [sourceId, targetId];
    const spec = relationSpec(this.ontology, type);
    if (spec?.symmetric && !spec.system && a > b) [a, b] = [b, a];
    if (norm.unknown) this.stats.unknownPredicates++;
    const id = relationId(a, type, b);
    await this.q.query(
      `INSERT INTO relations (id, source_id, target_id, type, description, weight, tx_from)
       VALUES ($1, $2, $3, $4, $5, 0, $6::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, a, b, type, r.description ?? '', this.txTime],
    );
    const added = await this.addEvidence('relation', id, r.extractor, r.weight ?? 1, segmentId, {
      type,
      description: r.description ?? '',
      valid_from: toIso(r.validFrom),
      valid_to: toIso(r.validTo),
      ...(norm.unknown ? { raw_type: norm.unknown } : {}),
    });
    if (added) this.stats.relations++;
    this.touched.relations.add(id);
    return id;
  }

  async claim(
    subjectId: string,
    c: {
      objectId?: string | null;
      /** One of CLAIM_TYPES; any other spelling is mapped (unknown → other). */
      type: string;
      statement: string;
      status: string;
      /** fact | opinion | prediction | rumor (default fact): what sort of assertion, apart from how firmly it is made. */
      kind?: string;
      validFrom?: string | null;
      validTo?: string | null;
      /** When the asserted event happened (world time), if distinct from the validity window. */
      eventAt?: string | null;
      /** Reference date of the source that made the assertion. */
      observedAt?: string | null;
      /** `stated` when the source dates the claim itself, `document` when only its document's date does (docs/design/29). */
      dateSource?: 'stated' | 'document' | null;
      /** The attribute of the subject the claim gives a value of, normalized (src/graph/claim-state.ts), and that value. */
      attribute?: string | null;
      valueNum?: number | null;
      valueText?: string | null;
      unit?: string | null;
      /** The claim corrects an earlier report. */
      correction?: boolean;
      extractor: string;
      segmentId?: string | null;
      weight?: number;
    },
  ): Promise<string | null> {
    const statement = c.statement.trim();
    if (!statement) return null;
    const id = claimId(subjectId, statement, readingWeek({ ...c, statement }));
    const status = (CLAIM_STATUS as readonly string[]).includes(c.status) ? c.status : 'fact';
    const kind = (CLAIM_KINDS as readonly string[]).includes(c.kind ?? '') ? c.kind! : 'fact';
    const type = normalizeClaimType(c.type);
    const validFrom = toIso(c.validFrom);
    const validTo = toIso(c.validTo);
    await this.q.query(
      `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, tx_from)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz) ON CONFLICT (id) DO NOTHING`,
      [id, subjectId, type, statement, status, kind, validFrom, validTo, this.txTime],
    );
    const added = await this.addEvidence('claim', id, c.extractor, c.weight ?? 1, c.segmentId ?? null, {
      type,
      status,
      kind,
      statement,
      valid_from: validFrom,
      valid_to: validTo,
      event_at: toIso(c.eventAt),
      observed_at: toIso(c.observedAt),
      object_id: c.objectId ?? null,
      // the state fields only when there are any, so evidence of claims without them hashes as before
      ...(c.dateSource ? { date_source: c.dateSource } : {}),
      ...(c.attribute ? { attribute: c.attribute, value_num: c.valueNum ?? null, value_text: c.valueText ?? null, unit: c.unit ?? null } : {}),
      ...(c.correction ? { correction: true } : {}),
    });
    if (added) this.stats.claims++;
    this.touched.claims.add(id);
    return id;
  }

  /**
   * Chunk-level mention; the chunk row must already exist (call `document`
   * first). Co-occurrence between entities is derived from these rows on read
   * (graph/cooccur.ts), never stored as edges.
   */
  async mention(entityId: string, chunkId: string, documentId: string): Promise<void> {
    const rows = await this.q.query<{ entity_id: string }>(
      `INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING entity_id`,
      [entityId, chunkId, documentId, this.scope.id],
    );
    if (rows.length) this.stats.mentions++;
    const seen = this.mentionedIn.get(entityId);
    if (!seen) this.mentionedIn.set(entityId, [chunkId]);
    else if (!seen.includes(chunkId)) seen.push(chunkId);
    this.touched.entities.add(entityId);
  }

  /**
   * The passage a relation between two entities of this body is grounded to
   * when the extractor named none: the first chunk this body mentioned both
   * in, else the first it mentioned either in (an endpoint named only in the
   * relation has no mention), else none.
   */
  private passageOf(sourceId: string, targetId: string): string | null {
    const a = this.mentionedIn.get(sourceId) ?? [];
    const b = this.mentionedIn.get(targetId) ?? [];
    return a.find((c) => b.includes(c)) ?? a[0] ?? b[0] ?? null;
  }

  private async addEvidence(kind: string, targetId: string, extractor: string, weight: number, segmentId: string | null, attrs: Record<string, unknown>): Promise<boolean> {
    const key = `${kind}|${targetId}|${extractor}`;
    if (this.seenEvidence.has(key)) return false;
    this.seenEvidence.add(key);
    await this.q.query(
      `INSERT INTO evidence (kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, trust)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9)`,
      [kind, targetId, this.scope.id, segmentId, weight, extractor, JSON.stringify(attrs), this.txTime, this.trust],
    );
    if (kind === 'entity') this.stats.entities++;
    return true;
  }

  /* --------------------------- document projection ---------------------- */

  /**
   * The search projection of a source: documents row + chunks + embeddings.
   * Chunk ids are content-derived, so unchanged chunks (and their paid
   * embeddings) survive a re-apply; only vectors passed in are (re)written.
   */
  async document(row: DocumentProjection, chunks: ChunkRow[], vectors: Map<string, number[]>, model: string): Promise<void> {
    // a pre-lineage row may hold this path under another id: it is replaced wholesale
    await this.q.query(`DELETE FROM documents WHERE path = $1 AND id <> $2`, [row.path, row.id]);
    await this.q.query(
      `INSERT INTO documents (id, path, root, title, sha256, mime, bytes, chars, language, status, scope_id, kind, doc_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $12, 'indexed', $9, $10, $11::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         path = EXCLUDED.path, root = EXCLUDED.root, title = EXCLUDED.title, sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime,
         bytes = EXCLUDED.bytes, chars = EXCLUDED.chars, language = EXCLUDED.language, status = 'indexed', error = NULL, scope_id = EXCLUDED.scope_id, kind = EXCLUDED.kind, doc_date = EXCLUDED.doc_date, updated_at = now()`,
      [row.id, row.path, row.root, row.title, row.sha256, row.mime, row.bytes, row.chars ?? null, this.scope.id, row.kind, toIso(row.docDate), row.language ?? null],
    );
    if (chunks.length === 0) {
      await this.q.query(`DELETE FROM chunks WHERE document_id = $1`, [row.id]);
    } else {
      const params: unknown[] = [row.id, ...chunks.map((c) => c.id)];
      const ph = chunks.map((_, i) => `$${i + 2}`).join(',');
      await this.q.query(`DELETE FROM chunks WHERE document_id = $1 AND id NOT IN (${ph})`, params);
    }
    for (const c of chunks) {
      await this.q.query(
        `INSERT INTO chunks (id, document_id, seq, content, token_count, metadata, tsv)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_tsvector('simple', $4))
         ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, token_count = EXCLUDED.token_count`,
        [c.id, row.id, c.seq, c.content, c.tokenCount, JSON.stringify({ path: row.path, title: row.title })],
      );
    }
    for (const [chunkId, vec] of vectors) {
      await this.q.query(
        `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})
         ON CONFLICT (chunk_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
        [chunkId, model, toVectorLiteral(vec)],
      );
    }
    this.stats.chunks = chunks.length;
    this.touched.documents.add(row.path);
  }

  /* --------------------------- explicit effects ------------------------- */

  /** Record the inverse, then run the forward action. */
  async effect(kind: EffectKind, target: string, inverse: InverseSpec, forward: () => Promise<void>): Promise<void> {
    await forward();
    await this.q.query(
      `INSERT INTO effects (scope_id, kind, target, inverse) VALUES ($1, $2, $3, $4::jsonb)`,
      [this.scope.id, kind, target, JSON.stringify(inverse)],
    );
    this.stats.effects++;
  }

  async setWikiPath(entityId: string, wikiPath: string | null): Promise<void> {
    const [cur] = await this.q.query<{ wiki_path: string | null }>(`SELECT wiki_path FROM entities WHERE id = $1`, [entityId]);
    if (!cur || cur.wiki_path === wikiPath) return;
    await this.effect('wiki_path', entityId, { op: 'wiki_path.restore', entityId, prev: cur.wiki_path }, async () => {
      await this.q.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [entityId, wikiPath]);
    });
  }

  /**
   * Record "entity is the same as canonical" (graph/merge.ts). An explicit
   * effect with an inverse, so disposing the merge scope restores the previous
   * canonical pointer; chains are flattened so nothing ever points at a merged
   * entity. Both entities are touched: the survivor's lookup keys are rebuilt
   * by the fold to include the merged entity's names.
   */
  async linkEntity(l: { entityId: string; canonicalId: string; reason?: string; actor?: string }): Promise<string> {
    const linkId = crypto.createHash('sha256').update(`link|${l.entityId}|${l.canonicalId}`).digest('hex').slice(0, 16);
    const [cur] = await this.q.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM entities WHERE id = $1`, [l.entityId]);
    await this.effect('entity_link', l.entityId, { op: 'entity_link.remove', linkId, entityId: l.entityId, prevCanonical: cur?.canonical_id ?? null }, async () => {
      await this.q.query(
        `INSERT INTO entity_links (id, entity_id, canonical_id, kind, scope_id, actor, reason, created_at, tx_to)
         VALUES ($1, $2, $3, 'same_as', $4, $5, $6, $7::timestamptz, NULL)
         ON CONFLICT (id) DO UPDATE SET scope_id = EXCLUDED.scope_id, actor = EXCLUDED.actor, reason = EXCLUDED.reason,
           created_at = EXCLUDED.created_at, tx_to = NULL`,
        [linkId, l.entityId, l.canonicalId, this.scope.id, l.actor ?? this.scope.actor, l.reason ?? '', this.txTime],
      );
      await this.q.query(`UPDATE entities SET canonical_id = $2 WHERE id = $1`, [l.entityId, l.canonicalId]);
      await this.q.query(`UPDATE entities SET canonical_id = $2 WHERE canonical_id = $1`, [l.entityId, l.canonicalId]);
    });
    this.touched.entities.add(l.entityId);
    this.touched.entities.add(l.canonicalId);
    return linkId;
  }

  /**
   * Record "claim is the same as canonical" (graph/claim-merge.ts). Like
   * linkEntity: an explicit effect whose inverse restores the claim — and any
   * members it carried, which move onto the new representative so groups stay
   * one level deep. Both claims are touched: the representative's fold takes
   * in its members' evidence.
   */
  async linkClaim(l: { claimId: string; canonicalId: string; kind?: 'same_as' | 'contains'; reason?: string; actor?: string; confidence?: number | null }): Promise<string> {
    const linkId = crypto.createHash('sha256').update(`claim-link|${l.claimId}|${l.canonicalId}`).digest('hex').slice(0, 16);
    const [cur] = await this.q.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM claims WHERE id = $1`, [l.claimId]);
    const members = await this.q.query<{ id: string }>(`SELECT id FROM claims WHERE canonical_id = $1`, [l.claimId]);
    const regrouped = members.map((m) => m.id);
    await this.effect('claim_link', l.claimId, { op: 'claim_link.remove', linkId, claimId: l.claimId, prevCanonical: cur?.canonical_id ?? null, regrouped }, async () => {
      await this.q.query(
        `INSERT INTO claim_links (id, claim_id, canonical_id, kind, scope_id, actor, reason, confidence, created_at, tx_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, NULL)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, scope_id = EXCLUDED.scope_id, actor = EXCLUDED.actor, reason = EXCLUDED.reason,
           confidence = EXCLUDED.confidence, created_at = EXCLUDED.created_at, tx_to = NULL`,
        [linkId, l.claimId, l.canonicalId, l.kind ?? 'same_as', this.scope.id, l.actor ?? this.scope.actor, l.reason ?? '', l.confidence ?? null, this.txTime],
      );
      await this.q.query(`UPDATE claims SET canonical_id = $2 WHERE id = $1`, [l.claimId, l.canonicalId]);
      if (regrouped.length > 0) await this.q.query(`UPDATE claims SET canonical_id = $2 WHERE canonical_id = $1`, [l.claimId, l.canonicalId]);
    });
    this.touched.claims.add(l.claimId);
    this.touched.claims.add(l.canonicalId);
    for (const id of regrouped) this.touched.claims.add(id);
    return linkId;
  }

  async upsertDataset(row: DatasetUpsert): Promise<void> {
    const [prev] = await this.q.query<Record<string, unknown>>(`SELECT * FROM datasets WHERE id = $1`, [row.id]);
    await this.effect('row_upsert', `datasets:${row.id}`, { op: 'row.restore', table: 'datasets', id: row.id, prev: prev ? jsonSafe(prev) : null }, async () => {
      await this.q.query(
        `INSERT INTO datasets (id, source_id, table_name, kind, columns, row_count, schema_sha, description, entity_count, refreshed_at, scope_id, tx_from, tx_to)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now(), $10, $11::timestamptz, NULL)
         ON CONFLICT (id) DO UPDATE SET
           source_id = EXCLUDED.source_id, table_name = EXCLUDED.table_name, kind = EXCLUDED.kind, columns = EXCLUDED.columns,
           row_count = EXCLUDED.row_count, schema_sha = EXCLUDED.schema_sha, description = EXCLUDED.description,
           entity_count = EXCLUDED.entity_count, refreshed_at = now(), scope_id = EXCLUDED.scope_id,
           tx_from = CASE WHEN datasets.tx_to IS NOT NULL THEN EXCLUDED.tx_from ELSE datasets.tx_from END, tx_to = NULL`,
        [row.id, row.source_id, row.table_name, row.kind, JSON.stringify(row.columns), row.row_count, row.schema_sha, row.description, row.entity_count, this.scope.id, this.txTime],
      );
    });
    this.touched.datasets.add(row.id);
  }

  /* ----------------------------- capabilities ---------------------------- */

  /**
   * Register what can be asked of a source. Capability rows, their locators
   * and their notes are owned by the writing scope and closed by scope id on
   * dispose — the same "implicit evidence" contract entity evidence uses — so
   * they need no explicit inverse and cannot outlive the source that declared
   * them.
   */
  async capability(row: CapabilityUpsert): Promise<string> {
    await this.q.query(
      `INSERT INTO capabilities (id, scope_id, kind, source_id, name, title, dialect, entity_id, schema,
                                 semantics, sample_queries, freshness_seconds, cost, acl, placement, tx_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13, $14::jsonb, $15, $16::timestamptz)`,
      [
        row.id, this.scope.id, row.kind, row.source_id, row.name, row.title ?? '', row.dialect ?? 'sql',
        row.entity_id ?? null, JSON.stringify(row.schema ?? {}), row.semantics ?? '',
        JSON.stringify(row.sample_queries ?? []), row.freshness_seconds ?? null, row.cost ?? 1,
        JSON.stringify(row.acl ?? []), row.placement ?? 'federate', this.txTime,
      ],
    );
    this.stats.capabilities++;
    return row.id;
  }

  /** Bind one entity to one capability parameter (`symbol = '300750'`). */
  async locator(entityId: string, capabilityId: string, param: string, value: string): Promise<void> {
    const v = value.trim();
    if (!v) return;
    await this.q.query(
      `INSERT INTO locators (entity_id, capability_id, param, value, scope_id, tx_from)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (entity_id, capability_id, param, value) WHERE tx_to IS NULL DO NOTHING`,
      [entityId, capabilityId, param, v, this.scope.id, this.txTime],
    );
    this.stats.locators++;
  }

  /** The semantic layer a `capabilities/*.md` source contributes to a capability. */
  async capabilityNote(row: CapabilityNote): Promise<void> {
    await this.q.query(
      `INSERT INTO capability_notes (capability_id, scope_id, source_path, semantics, sample_queries, pitfalls, joins, cost, freshness_seconds, tx_from)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::timestamptz)`,
      [
        row.capability_id, this.scope.id, row.source_path, row.semantics ?? '',
        JSON.stringify(row.sample_queries ?? []), JSON.stringify(row.pitfalls ?? []),
        JSON.stringify(row.joins ?? []), row.cost ?? null, row.freshness_seconds ?? null, this.txTime,
      ],
    );
    this.stats.capabilities++;
  }

  /**
   * A wiki page's citations of raw/docs files (src/graph/citations.ts): rows
   * this scope owns, closed with it on replace or dispose like capability
   * notes. Batched, because a trader page cites hundreds of posts.
   */
  async citations(documentId: string, sourcePath: string, rows: PlannedCitation[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CITATION_BATCH) {
      const params: unknown[] = [];
      const tuples = rows.slice(i, i + CITATION_BATCH).map((r) => {
        const at = params.push(this.scope.id, documentId, sourcePath, r.path, r.type, r.inverse, r.via, r.fragment, r.chunkId, this.txTime) - 10;
        return `(${Array.from({ length: 9 }, (_, k) => `$${at + k + 1}`).join(', ')}, $${at + 10}::timestamptz)`;
      });
      await this.q.query(
        `INSERT INTO citations (scope_id, document_id, source_path, target_path, type, inverse, via, fragment, chunk_id, tx_from)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    }
    this.stats.citations += rows.length;
  }

  /**
   * A document's table facts (src/tables): rows this scope owns, deleted with
   * it on replace or dispose. Batched, because a report has hundreds of cells.
   */
  async tableFacts(document: { id: string; path: string; subject: string | null; docPeriod: string | null }, rows: TableFact[]): Promise<void> {
    const cols = 24;
    for (let i = 0; i < rows.length; i += TABLE_FACT_BATCH) {
      const params: unknown[] = [];
      const tuples = rows.slice(i, i + TABLE_FACT_BATCH).map((f) => {
        const at = params.push(
          this.scope.id, document.id, document.path, document.subject, document.docPeriod, f.tableNo, f.tableLine, f.tableTitle,
          f.line, f.col, f.section, f.label, f.labelKey, f.period, f.periodKey, f.periodSpan,
          f.valueNum, f.valueText, f.unit, f.scale, f.scaleFactor, f.parser, f.confidence, this.txTime,
        ) - cols;
        return `(${Array.from({ length: cols - 1 }, (_, k) => `$${at + k + 1}`).join(', ')}, $${at + cols}::timestamptz)`;
      });
      await this.q.query(
        `INSERT INTO table_facts (scope_id, document_id, source_path, subject, doc_period, table_no, table_line, table_title,
           line, col, section, label, label_key, period, period_key, period_span,
           value_num, value_text, unit, scale, scale_factor, parser, confidence, tx_from)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    }
    this.stats.tableFacts = (this.stats.tableFacts ?? 0) + rows.length;
  }

  /** Queue the document for tier-1 extraction; `segments` is how many extraction calls it will take (progress only). */
  async enqueueTier1(documentId: string, segments = 0): Promise<void> {
    const [existing] = await this.q.query<{ document_id: string }>(`SELECT document_id FROM extraction_queue WHERE document_id = $1`, [documentId]);
    if (existing) return;
    await this.effect('enqueue', documentId, { op: 'queue.remove', documentId }, async () => {
      await this.q.query(
        `INSERT INTO extraction_queue (document_id, tier, priority, segments_total) VALUES ($1, 1, 0, $2) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, segments],
      );
    });
  }

  async suggestion(row: NewSuggestion): Promise<string> {
    const id = row.id ?? crypto.createHash('sha256').update(`${row.kind}|${row.title}`).digest('hex').slice(0, 16);
    await this.effect('suggestion', id, { op: 'suggestion.retract', id }, async () => {
      await this.q.query(
        `INSERT INTO suggestions (id, kind, title, body, evidence, status, report_path, payload, scope_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7::jsonb, $8)
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence, report_path = EXCLUDED.report_path,
           payload = EXCLUDED.payload, scope_id = EXCLUDED.scope_id,
           status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
        [id, row.kind, row.title, row.body, JSON.stringify(row.evidence ?? []), row.reportPath ?? null, row.payload === undefined ? null : JSON.stringify(row.payload), this.scope.id],
      );
    });
    return id;
  }

  async page(row: PageUpsert): Promise<void> {
    const [prev] = await this.q.query<Record<string, unknown>>(`SELECT * FROM pages WHERE path = $1`, [row.path]);
    await this.effect('page', row.path, { op: 'page.restore', path: row.path, prev: prev ? jsonSafe(prev) : null }, async () => {
      await this.q.query(
        `INSERT INTO pages (path, kind, scope_id, generator, inputs_sha, file_sha, regions, status, dirty_reason, tx_from, tx_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'active', NULL, $8::timestamptz, NULL)
         ON CONFLICT (path) DO UPDATE SET
           kind = EXCLUDED.kind, scope_id = EXCLUDED.scope_id, generator = EXCLUDED.generator, inputs_sha = EXCLUDED.inputs_sha,
           file_sha = EXCLUDED.file_sha, regions = EXCLUDED.regions, status = 'active', dirty_reason = NULL,
           tx_from = CASE WHEN pages.tx_to IS NOT NULL THEN EXCLUDED.tx_from ELSE pages.tx_from END, tx_to = NULL`,
        [row.path, row.kind, this.scope.id, row.generator, row.inputs_sha, row.file_sha, JSON.stringify(row.regions), this.txTime],
      );
    });
  }

  async deps(artifact: { kind: ArtifactKind; id: string }, inputs: DepDecl[]): Promise<void> {
    const prev = await readDeps(this.q, artifact);
    await this.effect('dep', `${artifact.kind}:${artifact.id}`, { op: 'deps.restore', artifactKind: artifact.kind, artifactId: artifact.id, prev }, async () => {
      await writeDeps(this.q, artifact, inputs);
    });
  }

  /* ---------------------------- file effects ---------------------------- */

  /** Write a whole file owned by this scope. Executed after COMMIT; the previous content (if any) goes to the attic. */
  async writeFile(rel: string, content: string): Promise<void> {
    const abs = safePath(this.dataDir, rel);
    let inverse: InverseSpec;
    if (fs.existsSync(abs)) {
      const prev = fs.readFileSync(abs, 'utf8');
      inverse = { op: 'file.restore', path: rel, blob: storeBlob(this.dataDir, prev) };
    } else {
      inverse = { op: 'file.delete', path: rel };
    }
    await this.effect('file_write', rel, inverse, async () => {});
    this.fsOps.push({ op: 'write', path: rel, content });
  }

  /** Replace one managed region inside a (possibly human-owned) file. */
  async writeRegion(rel: string, regionId: string, content: string): Promise<void> {
    const abs = safePath(this.dataDir, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const prev = splitRegions(current).regions.get(regionId) ?? null;
    await this.effect('region_write', `${rel}#${regionId}`, { op: 'region.restore', path: rel, region: regionId, prev }, async () => {});
    this.fsOps.push({ op: 'region', path: rel, region: regionId, content });
  }
}

/**
 * Execute queued file operations (after the transaction committed). Idempotent.
 * A page is composed around the prose already in the file, so whoever wrote
 * that file (an agent, on record in its sidecar) is still its writer after.
 */
export function runFsOps(dataDir: string, ops: FsOp[]): void {
  for (const op of ops) {
    const abs = safePath(dataDir, op.path);
    fs.mkdirSync(require_dirname(abs), { recursive: true });
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    const next = op.op === 'write' ? op.content : replaceRegion(current ?? '', op.region, op.content);
    if (current !== null) carryOrigin(dataDir, op.path, current, next);
    fs.writeFileSync(abs, next);
  }
}

function require_dirname(abs: string): string {
  return abs.slice(0, Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')));
}

function jsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}
