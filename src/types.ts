/** Shared domain types for knode-os. */

export type DocRoot = 'docs' | 'wiki' | 'skills' | 'traces' | 'capabilities' | 'codebase';

export interface DocumentRow {
  id: string;
  path: string;
  root: DocRoot;
  title: string | null;
  sha256: string;
  mime: string | null;
  bytes: number;
  /** Length of the indexed text in characters; null for a row indexed before the column existed (schema v15). */
  chars?: number | null;
  /** The language of the indexed text (docs/design/17); null when it has none, or for a row indexed before the column existed (schema v17). */
  language?: string | null;
  status: 'pending' | 'indexed' | 'error' | 'skipped' | 'disposed';
  error: string | null;
  created_at: string;
  updated_at: string;
  /** Live scope that produced this projection (null once disposed). */
  scope_id?: string | null;
  /** 'source' contributes to the graph; 'view' (generated page) is indexed for search only. */
  kind?: 'source' | 'view';
}

export interface EntityRow {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  wiki_path: string | null;
  mention_count: number;
  evidence_count?: number;
  /** Set when this entity was merged into another (graph/merge.ts); reads redirect to it. */
  canonical_id?: string | null;
  name_key?: string | null;
  /** System-time window; tx_to set = tombstoned (no live evidence). */
  tx_from?: string;
  tx_to?: string | null;
}

export interface RelationRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string;
  weight: number;
  document_id?: string | null;
  evidence_count?: number;
  /** World-time window the edge holds for (null = unbounded / unknown). */
  valid_from?: string | null;
  valid_to?: string | null;
  tx_from?: string;
  tx_to?: string | null;
}

/** Claim projected for query results / the web UI. */
export interface ClaimItem {
  id: string;
  subject: string;
  object: string | null;
  type: string;
  statement: string;
  status: string;
  /** fact | opinion | prediction | rumor (absent on rows read before claims had a kind). */
  kind?: string;
  /** Validity window (world time), date-only. */
  startDate: string | null;
  endDate: string | null;
  /** When the asserted event happened, date-only, if the source said. */
  eventDate?: string | null;
  /** Source that first asserted the claim (scope key); see knode_lineage for all supporters. */
  path: string | null;
  /** Number of live sources supporting the claim. */
  evidenceCount?: number;
}

export interface TraceRow {
  id: string;
  source: 'claude' | 'codex';
  session_id: string | null;
  path: string;
  project: string | null;
  started_at: string | null;
  bytes: number;
  sha256: string;
  analyzed_at: string | null;
}

export interface SuggestionRow {
  id: string;
  kind: 'skill' | 'memory' | 'knowledge' | 'pack' | 'recipe' | 'merge' | 'claim-merge' | 'wiki' | 'learn';
  title: string;
  body: string;
  evidence: (string | { kind: string; id?: string; path?: string; text?: string })[];
  /** 'stale' = an input the suggestion depended on was tombstoned. */
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  report_path: string | null;
  /**
   * Machine-applicable change: for kind 'pack' / 'recipe' the { path, content } of the file to write;
   * for 'merge' { entityId, canonicalId, reason }; for 'claim-merge' { claimId, canonicalId, kind, confidence, reason };
   * for 'wiki' the research job spec.
   */
  payload?: ({ path?: string; content?: string } & Record<string, unknown>) | null;
  created_at: string;
}

/** External live table registered in the index (schema only, no rows). */
export interface DatasetRow {
  id: string;
  source_id: string;
  table_name: string;
  kind: string;
  columns: { name: string; type: string }[];
  row_count: number | null;
  schema_sha: string;
  description: string;
  entity_count: number;
  refreshed_at: string | null;
  scope_id?: string | null;
  tx_to?: string | null;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  path: string;
  title: string | null;
  content: string;
  /** The source's reference date (date-only), when one was found. */
  docDate?: string | null;
  score: number;
  signals: { vector?: number; keyword?: number; graph?: number; structural?: number; /** BM25 over the question's and the bridge terms, for a chunk a bridge term reached (search/bridge.ts). */ bridge?: number; /** The cross-encoder's score, when a rerank stage ran (src/search/rerank.ts). */ rerank?: number };
  /** Lines cut from the chunk because they hold what a list question names (search/excerpts.ts), not the whole chunk. */
  excerpt?: boolean;
  /** More of its document than the chunk: the chunks (by `seq`, of `of`) `ask` joined into this passage (search/passages.ts). */
  widened?: { seqs: number[]; of: number };
  /**
   * One of the newest dated sources about what a question asking for the latest state names (search/newest.ts):
   * rank 1 the newest; `full` the newest holding every word of the question the best-matching source holds.
   */
  newest?: { rank: number; full?: true };
  /** The chunk is of a generated page (an entity page, a timeline: search/search.ts `SideSql.generated`), not of a source. Absent on a source's chunk. */
  generated?: true;
  /** Its 1-based rank in each recall channel that found it; only when the search was asked to explain. */
  ranks?: { vector?: number; keyword?: number; graph?: number };
  /**
   * Claims read off this chunk that a newer claim has since replaced, each
   * with the claim that holds now (src/search/current.ts): the passage says
   * what was true, this says what is.
   */
  current?: CurrentClaim[];
  /** Retrieval provenance. Present for SAG results and omitted by legacy modes. */
  trace?: {
    route: 'direct' | 'sag' | 'both';
    /** Number of chunk -> entity -> chunk expansion rounds. */
    hop?: number;
    /** Direct chunk from which structural expansion started. */
    seedChunkId?: string;
    /** Entity bridge chain followed to reach this chunk. */
    bridgeEntities?: string[];
    /** A walked hop's passage that only mentions both ends: the relation has no recorded source to show. */
    coMention?: boolean;
    /** Terms of the seed passages this chunk was reached by (search/bridge.ts); absent when none was. */
    bridgeTerms?: string[];
  };
}

/** A superseded claim a passage rests on, and the claim at the end of its supersession chain. */
export interface CurrentClaim {
  /** The claim the passage states. */
  was: { id: string; statement: string };
  /** What replaced it, as believed now. */
  now: { id: string; statement: string; date: string | null; path: string | null };
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string;
  /** Mentions in an overview; hop-decayed relevance to the query in a search. */
  score: number;
  mentionCount: number;
  /** Live typed relations across the whole graph, not only among the nodes returned. */
  degree?: number;
  wikiPath?: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  description: string;
  weight: number;
  /** Date-only world-time window, when the edge carries one. */
  validFrom?: string | null;
  validTo?: string | null;
}

export interface GraphSearchResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: SearchResult[];
  claims?: ClaimItem[];
}

export interface IngestStats {
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  errors: number;
  chunks: number;
  entities: number;
  relations: number;
}
