/**
 * Schema migrations. `meta.schema_version` records the applied version; each
 * migration runs in its own transaction (Postgres DDL is transactional and
 * PGlite honours it), so a crash mid-migration leaves the previous version
 * intact and the next open retries.
 *
 *   v1  baseline   — the pre-lineage schema (documents/chunks/entities/…)
 *   v2  lineage    — scopes / effects / evidence / deps / pages + bitemporal
 *                    columns. Rebuilds the graph layer from sources on the
 *                    first sync (old rows carry no per-source evidence).
 *   v3  temporal   — drops the legacy TEXT date columns superseded by the
 *                    `valid_from` / `valid_to` timestamps, indexes the world
 *                    time window, and publishes the read-only `v_*` catalog
 *                    views agents query through knode_query(source='catalog').
 */

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement execution (DDL scripts). Optional on plain query handles. */
  exec?(sql: string): Promise<void>;
}

/** `meta` key v13 sets: stored co_occurs rows are still to be deleted (see dropStoredCoOccurrence). */
export const COOCCURS_CLEANUP_META = 'cooccurs_cleanup';
/** `meta` key v20 sets: relations written before still lack their document. It also records the rule the stored sources follow (src/lineage/relation-sources.ts refreshRelationSources). */
export const RELATION_SOURCES_META = 'relation_sources';

export interface MigrationContext {
  /** Schema version the database had before this migration run started. */
  from: number;
}

export interface Migration {
  version: number;
  name: string;
  up(q: Queryable, ctx: MigrationContext): Promise<void>;
}

const V1_BASELINE = `
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  root       TEXT NOT NULL,
  title      TEXT,
  sha256     TEXT NOT NULL,
  mime       TEXT,
  bytes      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}',
  tsv         tsvector,
  UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks (document_id);

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'concept',
  description   TEXT NOT NULL DEFAULT '',
  aliases       JSONB NOT NULL DEFAULT '[]',
  wiki_path     TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relations (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'related_to',
  description TEXT NOT NULL DEFAULT '',
  weight      REAL NOT NULL DEFAULT 1.0,
  document_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relations_source_idx ON relations (source_id);
CREATE INDEX IF NOT EXISTS relations_target_idx ON relations (target_id);

CREATE TABLE IF NOT EXISTS claims (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  object_id    TEXT REFERENCES entities(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'fact',
  statement    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'fact',
  start_date   TEXT,
  end_date     TEXT,
  document_id  TEXT,
  chunk_id     TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_subject_idx ON claims (subject_id);
CREATE INDEX IF NOT EXISTS claims_document_idx ON claims (document_id);

CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id    TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS mentions_chunk_idx ON entity_mentions (chunk_id);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  session_id  TEXT,
  path        TEXT NOT NULL UNIQUE,
  project     TEXT,
  started_at  TIMESTAMPTZ,
  bytes       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL DEFAULT '',
  analyzed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'pending',
  report_path TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunk_stats (
  chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS doc_stats (
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  last_hit_at  TIMESTAMPTZ,
  heat         REAL NOT NULL DEFAULT 0,
  heat_updated TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS extraction_queue (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tier        INTEGER NOT NULL DEFAULT 1,
  priority    REAL NOT NULL DEFAULT 0,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS extraction_queue_priority_idx ON extraction_queue (priority DESC);

CREATE TABLE IF NOT EXISTS datasets (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  columns      JSONB NOT NULL DEFAULT '[]',
  row_count    BIGINT,
  schema_sha   TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  entity_count INTEGER NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ,
  UNIQUE (source_id, table_name)
);

CREATE TABLE IF NOT EXISTS pack_events (
  id             TEXT PRIMARY KEY,
  utterance      TEXT NOT NULL,
  entities       JSONB NOT NULL DEFAULT '[]',
  playbooks      JSONB NOT NULL DEFAULT '[]',
  datasets       JSONB NOT NULL DEFAULT '[]',
  probes         JSONB NOT NULL DEFAULT '[]',
  gaps           JSONB NOT NULL DEFAULT '[]',
  doc_count      INTEGER NOT NULL DEFAULT 0,
  claim_count    INTEGER NOT NULL DEFAULT 0,
  stale_count    INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pack_events_created_idx ON pack_events (created_at DESC);
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS payload JSONB;
`;

const V2_LINEAGE = `
-- one row per apply of a source (document, datasource, page, dream …); the
-- unit of temporal composability: dispose reverts everything it produced
CREATE TABLE IF NOT EXISTS scopes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  sha         TEXT NOT NULL,
  parent_id   TEXT REFERENCES scopes(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'applying',
  actor       TEXT NOT NULL DEFAULT 'system',
  applied_at  TIMESTAMPTZ NOT NULL,
  disposed_at TIMESTAMPTZ,
  meta        JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS scopes_live_key_idx ON scopes (kind, key) WHERE status <> 'disposed';
CREATE INDEX IF NOT EXISTS scopes_key_idx ON scopes (kind, key);
CREATE INDEX IF NOT EXISTS scopes_parent_idx ON scopes (parent_id);

-- explicit effects with a recorded inverse (files, queue entries, rows …)
CREATE TABLE IF NOT EXISTS effects (
  seq         BIGSERIAL PRIMARY KEY,
  scope_id    TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  inverse     JSONB NOT NULL,
  reverted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS effects_scope_idx ON effects (scope_id, seq);

-- per-source contribution to a shared entity / relation / claim row
CREATE TABLE IF NOT EXISTS evidence (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  scope_id    TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  segment_id  TEXT,
  weight      REAL NOT NULL DEFAULT 1.0,
  extractor   TEXT NOT NULL,
  attrs       JSONB NOT NULL DEFAULT '{}',
  tx_from     TIMESTAMPTZ NOT NULL,
  tx_to       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS evidence_live_target_idx ON evidence (kind, target_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS evidence_target_hist_idx ON evidence (kind, target_id, tx_from);
CREATE INDEX IF NOT EXISTS evidence_scope_idx ON evidence (scope_id);

-- spatial composability: artifact <- input
CREATE TABLE IF NOT EXISTS deps (
  artifact_kind TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  input_kind    TEXT NOT NULL,
  input_id      TEXT NOT NULL,
  required      BOOLEAN NOT NULL DEFAULT false,
  input_sha     TEXT,
  PRIMARY KEY (artifact_kind, artifact_id, input_kind, input_id)
);
CREATE INDEX IF NOT EXISTS deps_input_idx ON deps (input_kind, input_id);

-- materialized wiki views
CREATE TABLE IF NOT EXISTS pages (
  path         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  scope_id     TEXT REFERENCES scopes(id) ON DELETE SET NULL,
  generator    TEXT NOT NULL,
  inputs_sha   TEXT NOT NULL,
  file_sha     TEXT,
  regions      JSONB NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active',
  dirty_reason JSONB,
  tx_from      TIMESTAMPTZ NOT NULL,
  tx_to        TIMESTAMPTZ
);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS scope_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'source';

ALTER TABLE entities ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE entities ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS fold_sha TEXT NOT NULL DEFAULT '';

ALTER TABLE relations ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE relations ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS fold_sha TEXT NOT NULL DEFAULT '';

ALTER TABLE claims ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE claims ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS fold_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS primary_scope_id TEXT;

ALTER TABLE entity_mentions ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE entity_mentions DROP CONSTRAINT IF EXISTS entity_mentions_pkey;
ALTER TABLE entity_mentions ADD PRIMARY KEY (entity_id, chunk_id, scope_id);
CREATE INDEX IF NOT EXISTS mentions_scope_idx ON entity_mentions (scope_id);

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS scope_id TEXT;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS scope_id TEXT;

CREATE INDEX IF NOT EXISTS entities_live_mentions_idx ON entities (mention_count DESC) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS relations_live_source_idx ON relations (source_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS relations_live_target_idx ON relations (target_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS claims_live_subject_idx ON claims (subject_id) WHERE tx_to IS NULL;

-- pre-lineage graph rows carry no per-source evidence and inflated weights:
-- rebuild the graph layer from sources on the next sync. Chunks/embeddings
-- are kept (chunk ids are content-derived, so they are reused as-is).
DELETE FROM entities;
DELETE FROM extraction_queue;
UPDATE documents SET status = 'pending' WHERE status = 'indexed';
`;

const V3_TEMPORAL = `
-- claims carried both a TIMESTAMPTZ window (valid_from/valid_to, the one the
-- fold maintains) and its TEXT projection (start_date/end_date) from the
-- pre-lineage schema. Two columns for one fact drift; the projection is
-- computed on read now (toDateString), so the TEXT pair goes.
ALTER TABLE claims DROP COLUMN IF EXISTS start_date;
ALTER TABLE claims DROP COLUMN IF EXISTS end_date;

CREATE INDEX IF NOT EXISTS claims_valid_window_idx ON claims (valid_from, valid_to) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS documents_root_kind_idx ON documents (root, kind);
CREATE INDEX IF NOT EXISTS documents_path_idx ON documents (path text_pattern_ops);
CREATE INDEX IF NOT EXISTS scopes_live_kind_idx ON scopes (kind) WHERE disposed_at IS NULL;

-- Read-only catalog: the shape agents are allowed to see of the projection
-- database itself. Views hide the fold bookkeeping (fold_sha, dirty_reason)
-- and default to currently-believed rows, so a plain SELECT cannot silently
-- read tombstoned knowledge. History stays reachable through v_evidence.
CREATE OR REPLACE VIEW v_documents AS
  SELECT d.id, d.path, d.root, d.kind, d.title, d.sha256, d.mime, d.bytes, d.status,
         d.scope_id, d.created_at, d.updated_at
  FROM documents d;

CREATE OR REPLACE VIEW v_entities AS
  SELECT e.id, e.name, e.type, e.description, e.aliases, e.wiki_path,
         e.mention_count, e.evidence_count, e.tx_from
  FROM entities e WHERE e.tx_to IS NULL;

CREATE OR REPLACE VIEW v_relations AS
  SELECT r.id, r.source_id, r.target_id, r.type, r.description, r.weight,
         r.evidence_count, r.tx_from
  FROM relations r WHERE r.tx_to IS NULL;

CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  WHERE cl.tx_to IS NULL;

CREATE OR REPLACE VIEW v_scopes AS
  SELECT s.id, s.kind, s.key, s.sha, s.parent_id, s.status, s.actor,
         s.applied_at, s.disposed_at
  FROM scopes s;

CREATE OR REPLACE VIEW v_evidence AS
  SELECT ev.id, ev.kind, ev.target_id, ev.scope_id, s.key AS source_path,
         ev.segment_id, ev.weight, ev.extractor, ev.tx_from, ev.tx_to
  FROM evidence ev
  JOIN scopes s ON s.id = ev.scope_id;

CREATE OR REPLACE VIEW v_pages AS
  SELECT p.path, p.kind, p.generator, p.inputs_sha, p.status, p.tx_from
  FROM pages p WHERE p.tx_to IS NULL;

CREATE OR REPLACE VIEW v_datasets AS
  SELECT d.id, d.source_id, d.table_name, d.kind, d.columns, d.row_count,
         d.description, d.entity_count, d.refreshed_at, d.tx_from
  FROM datasets d WHERE d.tx_to IS NULL;

CREATE OR REPLACE VIEW v_mentions AS
  SELECT m.entity_id, m.chunk_id, m.document_id, d.path AS document_path
  FROM entity_mentions m JOIN documents d ON d.id = m.document_id;
`;

const V4_CAPABILITY = `
-- What can be asked of a source. A dataset scope registers its table; a
-- datasource scope registers its endpoints/metrics; built-in tools register
-- themselves. Rows are owned by exactly one scope and closed by scope id on
-- dispose (the "implicit evidence" half of the ledger), so removing a source
-- from the config retires its capabilities without an explicit inverse.
CREATE TABLE IF NOT EXISTS capabilities (
  seq               BIGSERIAL PRIMARY KEY,
  id                TEXT NOT NULL,
  scope_id          TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  dialect           TEXT NOT NULL DEFAULT 'sql',
  entity_id         TEXT,
  schema            JSONB NOT NULL DEFAULT '{}',
  semantics         TEXT NOT NULL DEFAULT '',
  sample_queries    JSONB NOT NULL DEFAULT '[]',
  freshness_seconds INTEGER,
  cost              REAL NOT NULL DEFAULT 1,
  acl               JSONB NOT NULL DEFAULT '[]',
  placement         TEXT NOT NULL DEFAULT 'federate',
  tx_from           TIMESTAMPTZ NOT NULL,
  tx_to             TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS capabilities_live_id_idx ON capabilities (id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS capabilities_scope_idx ON capabilities (scope_id);
CREATE INDEX IF NOT EXISTS capabilities_source_idx ON capabilities (source_id) WHERE tx_to IS NULL;

-- The semantic layer: metric definitions, join paths, known pitfalls. Written
-- by people or agents under capabilities/*.md, which is itself a Source — so a
-- note is a separate row per contributing scope rather than a field two scopes
-- would fight over.
CREATE TABLE IF NOT EXISTS capability_notes (
  seq               BIGSERIAL PRIMARY KEY,
  capability_id     TEXT NOT NULL,
  scope_id          TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  source_path       TEXT NOT NULL,
  semantics         TEXT NOT NULL DEFAULT '',
  sample_queries    JSONB NOT NULL DEFAULT '[]',
  pitfalls          JSONB NOT NULL DEFAULT '[]',
  joins             JSONB NOT NULL DEFAULT '[]',
  cost              REAL,
  freshness_seconds INTEGER,
  tx_from           TIMESTAMPTZ NOT NULL,
  tx_to             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS capability_notes_live_idx ON capability_notes (capability_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS capability_notes_scope_idx ON capability_notes (scope_id);

-- How to reach one entity through one capability: the parameter to bind and
-- the value to bind it to. This is what turns "宁德时代" into
-- "symbol = '300750' on market-mysql.daily_quotes".
CREATE TABLE IF NOT EXISTS locators (
  seq           BIGSERIAL PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  param         TEXT NOT NULL,
  value         TEXT NOT NULL,
  scope_id      TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  tx_from       TIMESTAMPTZ NOT NULL,
  tx_to         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS locators_live_idx ON locators (entity_id, capability_id, param, value) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS locators_entity_idx ON locators (entity_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS locators_capability_idx ON locators (capability_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS locators_scope_idx ON locators (scope_id);

CREATE OR REPLACE VIEW v_capabilities AS
  SELECT c.id, c.kind, c.source_id, c.name, c.title, c.dialect, c.entity_id, c.schema,
         c.semantics, c.sample_queries, c.freshness_seconds, c.cost, c.placement, c.tx_from
  FROM capabilities c WHERE c.tx_to IS NULL;

CREATE OR REPLACE VIEW v_locators AS
  SELECT l.entity_id, l.capability_id, l.param, l.value, l.tx_from
  FROM locators l WHERE l.tx_to IS NULL;

CREATE OR REPLACE VIEW v_capability_notes AS
  SELECT n.capability_id, n.source_path, n.semantics, n.sample_queries, n.pitfalls,
         n.joins, n.cost, n.freshness_seconds, n.tx_from
  FROM capability_notes n WHERE n.tx_to IS NULL;
`;

const V5_RECEIPTS = `
-- One row per resolve/pack. The receipt is what makes the loop learnable: the
-- plan that was handed out, the calls the agent actually made, and which
-- returned ids it ended up using. Everything the ranker needs later is here,
-- so no separate telemetry path can drift from it.
CREATE TABLE IF NOT EXISTS receipts (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'resolve',
  query        TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'agent',
  intent       TEXT,
  recipe_path  TEXT,
  recipe_sha   TEXT,
  program_sha  TEXT,
  entities     JSONB NOT NULL DEFAULT '[]',
  playbooks    JSONB NOT NULL DEFAULT '[]',
  datasets     JSONB NOT NULL DEFAULT '[]',
  probes       JSONB NOT NULL DEFAULT '[]',
  gaps         JSONB NOT NULL DEFAULT '[]',
  plan         JSONB,
  calls        JSONB NOT NULL DEFAULT '[]',
  used_ids     JSONB NOT NULL DEFAULT '[]',
  ignored_ids  JSONB NOT NULL DEFAULT '[]',
  budget       JSONB NOT NULL DEFAULT '{}',
  summary      JSONB NOT NULL DEFAULT '{}',
  outcome      TEXT,
  as_of        TIMESTAMPTZ,
  valid_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  feedback_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS receipts_created_idx ON receipts (created_at DESC);
CREATE INDEX IF NOT EXISTS receipts_intent_idx ON receipts (intent, created_at DESC);

-- Carry the existing pack history over, then replace the table with a view of
-- the same shape: the learning loop keeps its query, the data gets one home.
INSERT INTO receipts (id, kind, query, entities, playbooks, datasets, probes, gaps, summary, created_at)
SELECT id, 'pack', utterance, entities, playbooks, datasets, probes, gaps,
       jsonb_build_object('docCount', doc_count, 'claimCount', claim_count,
                          'staleCount', stale_count, 'conflictCount', conflict_count),
       created_at
FROM pack_events
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS pack_events;

CREATE OR REPLACE VIEW pack_events AS
  SELECT r.id, r.query AS utterance, r.entities, r.playbooks, r.datasets, r.probes, r.gaps,
         COALESCE((r.summary ->> 'docCount')::int, 0)      AS doc_count,
         COALESCE((r.summary ->> 'claimCount')::int, 0)    AS claim_count,
         COALESCE((r.summary ->> 'staleCount')::int, 0)    AS stale_count,
         COALESCE((r.summary ->> 'conflictCount')::int, 0) AS conflict_count,
         r.created_at
  FROM receipts r;

CREATE OR REPLACE VIEW v_receipts AS
  SELECT r.id, r.kind, r.query, r.actor, r.intent, r.recipe_path, r.outcome,
         r.entities, r.gaps, r.calls, r.used_ids, r.summary, r.created_at, r.feedback_at
  FROM receipts r;
`;

const V6_AGENT_DB = `
-- Trust and access travel with the scope that produced a fact, because that is
-- the only place that knows where it came from. An agent's own writes land
-- quarantined: readable, attributable, and excluded from trusted answers until
-- somebody promotes them.
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS trust TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS acl JSONB NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS scopes_trust_idx ON scopes (trust) WHERE disposed_at IS NULL;

-- Evidence carries the tier it was written at, so a read can filter without
-- joining scopes on every row.
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS trust TEXT NOT NULL DEFAULT 'trusted';
CREATE INDEX IF NOT EXISTS evidence_trust_idx ON evidence (trust) WHERE tx_to IS NULL;

-- A contradiction is a fact about the knowledge base, not a merge conflict to
-- resolve silently. Quarantined evidence that disagrees with a trusted claim
-- opens one of these instead of overwriting it.
CREATE TABLE IF NOT EXISTS disputes (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL,
  against_id    TEXT,
  scope_id      TEXT REFERENCES scopes(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  detail        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);
CREATE INDEX IF NOT EXISTS disputes_claim_idx ON disputes (claim_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS disputes_scope_idx ON disputes (scope_id);

-- A pinned view for a long task. Everything read through a workset answers at
-- the same system time, so a plan that runs for an hour does not see the world
-- change under it half way through.
CREATE TABLE IF NOT EXISTS worksets (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL DEFAULT 'agent',
  as_of       TIMESTAMPTZ NOT NULL,
  valid_at    TIMESTAMPTZ,
  note        TEXT NOT NULL DEFAULT '',
  entities    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  commit_path TEXT
);
CREATE INDEX IF NOT EXISTS worksets_open_idx ON worksets (actor) WHERE closed_at IS NULL;

-- "Tell me when this changes." Polled rather than pushed: the cursor is a
-- system time, so a subscriber that was offline still sees everything since.
CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target       TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'agent',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_target_idx ON subscriptions (actor, kind, target);

-- v_scopes predates the trust columns; append them (CREATE OR REPLACE can add
-- columns at the end, which is why they go last rather than beside status)
CREATE OR REPLACE VIEW v_scopes AS
  SELECT s.id, s.kind, s.key, s.sha, s.parent_id, s.status, s.actor,
         s.applied_at, s.disposed_at, s.trust, s.acl
  FROM scopes s;

CREATE OR REPLACE VIEW v_disputes AS
  SELECT d.id, d.claim_id, d.against_id, d.reason, d.status, d.created_at, d.resolved_at
  FROM disputes d;

CREATE OR REPLACE VIEW v_worksets AS
  SELECT w.id, w.actor, w.as_of, w.valid_at, w.note, w.created_at, w.closed_at, w.commit_path
  FROM worksets w;

-- Per-(intent, slot, capability) outcomes, the ranker's input. A view rather
-- than a table so it can never drift from the receipts it summarizes.
CREATE OR REPLACE VIEW v_capability_stats AS
  SELECT r.intent,
         call ->> 'slot'       AS slot,
         call ->> 'capability' AS capability,
         count(*)::int                                                             AS attempts,
         count(*) FILTER (WHERE COALESCE((call ->> 'ok')::boolean, true))::int      AS ok,
         count(*) FILTER (WHERE r.used_ids ? (call ->> 'nodeId'))::int              AS used,
         COALESCE(avg(NULLIF((call ->> 'elapsedMs')::float, 0)), 0)::float          AS avg_latency_ms,
         max(r.created_at)                                                          AS last_seen
  FROM receipts r
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.calls, '[]'::jsonb)) AS call
  WHERE r.feedback_at IS NOT NULL
    AND call ->> 'slot' IS NOT NULL
    AND call ->> 'capability' IS NOT NULL
  GROUP BY r.intent, call ->> 'slot', call ->> 'capability';
`;

const V7_WIKI_RESEARCH = `
-- Relations gain a world-time window like claims already have: "A supplies B"
-- is true of a period, not forever. Folded from evidence attrs (MIN valid_from,
-- MAX valid_to unless any supporter leaves it open).
ALTER TABLE relations ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS relations_valid_window_idx ON relations (valid_from, valid_to) WHERE tx_to IS NULL;

-- Claims separate the time an event happened (event_at) from the window the
-- statement holds for (valid_from / valid_to) and the date of the document
-- that reported it (observed_at). superseded_by is system-maintained by the
-- claim audit: an older fact replaced by a newer one is kept, not deleted.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS superseded_by TEXT;

-- The reference date of a source (frontmatter date, or a date in its path).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_date TIMESTAMPTZ;

-- Entity resolution: name_key / entity_alias_keys are the normalized lookup
-- keys the writer resolves new mentions against; canonical_id points a merged
-- entity at the one it was folded into (reversible through entity_links).
ALTER TABLE entities ADD COLUMN IF NOT EXISTS canonical_id TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS name_key TEXT;
CREATE INDEX IF NOT EXISTS entities_name_key_idx ON entities (name_key) WHERE tx_to IS NULL;
CREATE TABLE IF NOT EXISTS entity_alias_keys (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias_key)
);
CREATE INDEX IF NOT EXISTS entity_alias_keys_key_idx ON entity_alias_keys (alias_key);
CREATE TABLE IF NOT EXISTS entity_links (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'same_as',
  scope_id     TEXT,
  actor        TEXT,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_to        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS entity_links_entity_idx ON entity_links (entity_id) WHERE tx_to IS NULL;

-- Deep-research jobs: one row per page an external agent is asked to write.
CREATE TABLE IF NOT EXISTS research_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target       TEXT,
  query        TEXT,
  template     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  agent        TEXT,
  model        TEXT,
  workset_id   TEXT,
  output_path  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER,
  cost_usd     REAL,
  payload      JSONB NOT NULL DEFAULT '{}',
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_jobs_status_idx ON research_jobs (status, created_at);

-- Catalog views: CREATE OR REPLACE may only append columns, so the new ones go last.
CREATE OR REPLACE VIEW v_documents AS
  SELECT d.id, d.path, d.root, d.kind, d.title, d.sha256, d.mime, d.bytes, d.status,
         d.scope_id, d.created_at, d.updated_at, d.doc_date
  FROM documents d;

CREATE OR REPLACE VIEW v_entities AS
  SELECT e.id, e.name, e.type, e.description, e.aliases, e.wiki_path,
         e.mention_count, e.evidence_count, e.tx_from, e.canonical_id
  FROM entities e WHERE e.tx_to IS NULL;

CREATE OR REPLACE VIEW v_relations AS
  SELECT r.id, r.source_id, r.target_id, r.type, r.description, r.weight,
         r.evidence_count, r.tx_from, r.valid_from, r.valid_to
  FROM relations r WHERE r.tx_to IS NULL;

CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path, cl.event_at, cl.observed_at, cl.superseded_by
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  WHERE cl.tx_to IS NULL;

CREATE OR REPLACE VIEW v_entity_links AS
  SELECT l.id, l.entity_id, l.canonical_id, l.kind, l.actor, l.reason, l.created_at
  FROM entity_links l WHERE l.tx_to IS NULL;

CREATE OR REPLACE VIEW v_research_jobs AS
  SELECT j.id, j.kind, j.target, j.query, j.template, j.status, j.agent, j.model,
         j.output_path, j.error, j.attempts, j.turns, j.cost_usd, j.requested_by,
         j.created_at, j.started_at, j.finished_at
  FROM research_jobs j;
`;

const V8_REVIEW = `
-- Lookup keys carry their kind so the resolver can be told to merge only on an
-- identical spelling ('exact') while suffix-stripped keys ('bare') stay
-- available to the duplicate audit. Keys written before this column are
-- retagged the next time their entity folds (\`knode-os sync --verify\` does all).
ALTER TABLE entity_alias_keys ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'exact';
`;

const V9_CHAT = `
-- The chat entry: a person talks to the configured coding-agent CLI. One row
-- per conversation, one per message; an assistant message keeps the tool
-- activity parsed from the session transcript and what the turn cost.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  agent      TEXT,
  model      TEXT,
  status     TEXT NOT NULL DEFAULT 'idle',
  created_by TEXT,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  events          JSONB NOT NULL DEFAULT '[]',
  turns           INTEGER,
  cost_usd        REAL,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages (conversation_id, seq);
`;

// Ask's quick mode carried its citations, gaps and claims here. Quick mode is
// gone (2026-09-19) and nothing writes this column any more, but it is kept,
// and so is this migration: historical answers still hold their citations, and
// deleting the entry would lower SCHEMA_VERSION so every existing database
// would read as newer than the code.
const V10_CHAT_QUICK = `
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
`;

// Long documents and duplicate claims (docs/design/10). The extraction queue
// counts a document's segments for progress; a claim merged into another
// points at its representative through canonical_id, recorded (and undone)
// by a claim-merge scope through claim_links, exactly like entity merges; the
// duplicate-claim audit remembers every pair it judged.
const V11_CLAIM_MERGE = `
ALTER TABLE extraction_queue ADD COLUMN IF NOT EXISTS segments_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE extraction_queue ADD COLUMN IF NOT EXISTS segments_done INTEGER NOT NULL DEFAULT 0;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS canonical_id TEXT;
CREATE INDEX IF NOT EXISTS claims_canonical_idx ON claims (canonical_id) WHERE canonical_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS claim_links (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'same_as',
  scope_id     TEXT,
  actor        TEXT,
  reason       TEXT NOT NULL DEFAULT '',
  confidence   REAL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_to        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS claim_links_claim_idx ON claim_links (claim_id) WHERE tx_to IS NULL;
CREATE TABLE IF NOT EXISTS claim_pair_verdicts (
  pair_id    TEXT PRIMARY KEY,
  a_id       TEXT NOT NULL,
  b_id       TEXT NOT NULL,
  relation   TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '',
  model      TEXT,
  judged_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the catalog shows a merged group once, as its representative
CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path, cl.event_at, cl.observed_at, cl.superseded_by
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL;

CREATE OR REPLACE VIEW v_claim_links AS
  SELECT l.id, l.claim_id, l.canonical_id, l.kind, l.actor, l.reason, l.confidence, l.created_at
  FROM claim_links l WHERE l.tx_to IS NULL;
`;

// Indexes a source's disposal leaned on without having them. Deleting a
// document's chunks sets claims.chunk_id to NULL through its foreign key, which
// without an index scanned every claim once per chunk; an entity's delete does
// the same to claims.object_id, a scope's purge to pages.scope_id; and every
// fold of an entity looks up the entities merged into it by canonical_id.
const V12_DISPOSE_INDEXES = `
CREATE INDEX IF NOT EXISTS claims_chunk_idx ON claims (chunk_id) WHERE chunk_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_object_idx ON claims (object_id) WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_scope_idx ON pages (scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_canonical_idx ON entities (canonical_id) WHERE canonical_id IS NOT NULL;
`;

// Co-occurrence is derived from entity_mentions on read now (src/graph/cooccur.ts):
// two entities co-occur when a live document mentions both, strongly when one
// chunk does. The stored `co_occurs` rows said nothing the mentions did not and
// were 92% of the finance workspace's relations table (844k of 912k rows, with
// 2.0M of its 2.96M evidence rows behind them), so they go — deleted rather
// than tombstoned, because an as_of read folds relations back out of their
// evidence and would resurrect them.
//
// The migration itself only adds the index the derivation joins on and flags
// the cleanup; the rows are deleted by `dropStoredCoOccurrence`, which
// Store.open runs in the background once the migrations have committed, in
// short autocommitted batches, so the startup transaction never holds two
// million row locks and the service comes up at once while writers keep
// going. Readers ignore rows of this type until then. Measured on a Postgres
// copy of that workspace: see dropStoredCoOccurrence.
const V13_DERIVED_COOCCURRENCE = `
CREATE INDEX IF NOT EXISTS mentions_document_idx ON entity_mentions (document_id);
INSERT INTO meta (key, value) VALUES ('${COOCCURS_CLEANUP_META}', '{"pending": true}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;

// Claims say what sort of assertion they are: `kind` is fact / opinion /
// prediction / rumor beside `status`, which keeps saying how firmly the source
// makes it. Rows written before read as facts, which is how they were stored.
// The view gains the column at its end, as a replaced view must.
const V14_CLAIM_KIND = `
ALTER TABLE claims ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'fact';
CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path, cl.event_at, cl.observed_at, cl.superseded_by, cl.kind
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL;
`;

// The length of a document's indexed text in characters, beside its bytes:
// the Summarize stage leaves documents under `extraction.summaryMinChars`
// out, and the scan that finds due documents must know that without reading
// every file (docs/design/14). Written with every apply; rows indexed before
// it exists keep NULL until the scan reads the text once (`documentChars`).
const V15_DOCUMENT_CHARS = `
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chars INTEGER;
`;

// A wiki page citing a file under raw/docs — a [[raw/docs/…]] link, a Markdown
// link, a `sources:` entry, a typed `relations:` entry (src/graph/citations.ts).
// A raw document has no node in the graph and relations join entities, so a
// citation is a row of its own, owned by the citing page's scope like a
// capability note and closed by tx_to when that scope is replaced or disposed,
// which keeps "cited by" right under `as_of`. The target is the path the page
// wrote, normalized, not a document id: a page may cite a file uploaded later,
// and the order sync applies them in must not matter. Lookups fold case, as
// the file system the paths come from does.
const V16_CITATIONS = `
CREATE TABLE IF NOT EXISTS citations (
  seq          BIGSERIAL PRIMARY KEY,
  scope_id     TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL,
  source_path  TEXT NOT NULL,
  target_path  TEXT NOT NULL,
  type         TEXT NOT NULL,
  inverse      BOOLEAN NOT NULL DEFAULT false,
  via          TEXT NOT NULL,
  fragment     TEXT,
  chunk_id     TEXT,
  tx_from      TIMESTAMPTZ NOT NULL,
  tx_to        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS citations_target_idx ON citations (lower(target_path), tx_from);
CREATE INDEX IF NOT EXISTS citations_source_idx ON citations (source_path, tx_from);
CREATE INDEX IF NOT EXISTS citations_scope_idx ON citations (scope_id);
CREATE OR REPLACE VIEW v_citations AS
  SELECT c.source_path, c.target_path, c.type, c.inverse, c.via, c.fragment, s.trust, c.tx_from
  FROM citations c JOIN scopes s ON s.id = c.scope_id
  WHERE c.tx_to IS NULL;
`;

// Content languages (docs/design/17). A document's language beside its
// length, detected from the indexed text on every apply; rows indexed before
// it keep NULL until the Translate stage's scan reads the text once. And what
// that stage made of each document: one row per document and language it was
// translated into, for the content it translated, so a scan finds what is due
// without opening a sidecar per document and a reader's file view says how
// far a translation got. The translations themselves are files in the
// sidecar (views/translations/); a rebuild loses these rows and the scan
// writes them again from those files, without a model call.
const V17_CONTENT_LANGUAGES = `
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language TEXT;
CREATE TABLE IF NOT EXISTS translations (
  document_id  TEXT NOT NULL,
  language     TEXT NOT NULL,
  content_sha  TEXT NOT NULL,
  status       TEXT NOT NULL,
  parts        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  requested    BOOLEAN NOT NULL DEFAULT false,
  model        TEXT,
  error        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, language)
);
CREATE INDEX IF NOT EXISTS translations_status_idx ON translations (language, status);
`;

// Substring matching through an index (src/store/grams.ts). Search matches
// query terms as substrings, and the terms of a CJK query are two-character
// bigrams that no full-text parser and no trigram index can look up, so every
// such search scanned every chunk (8–20 s on a 370k-chunk workspace). This
// function reduces a text to the n-grams of its lowercased runs: each bigram of
// a CJK run, each bigram and trigram of a run of [a-z0-9_.$-], the two
// character classes queryTerms takes terms from. A GIN index over it answers
// "holds every gram of the term", which every text containing the term does.
// The indexes themselves are built in the background after open
// (ensureMatchIndexes), as that takes minutes on a large workspace. An index
// stores the function's output, so a change to the grams needs a function and
// indexes under new names, never a CREATE OR REPLACE of this one. A call takes
// about 250 µs on a chunk; COST says so, which keeps the planner reading
// through the index and, where it reads rows one by one, testing the cheap
// exact match on a row before this.
const V18_MATCH_GRAMS = `
CREATE OR REPLACE FUNCTION match_grams(t text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE COST 1000 AS $$
    SELECT array_to_tsvector(coalesce(array_agg(substr(r[1], i, n)), '{}'::text[]))
    FROM regexp_matches(lower(t), '[一-鿿㐀-䶿]{2,}|[a-z0-9_.$-]{2,}', 'g') AS r,
         generate_series(2, CASE WHEN ascii(r[1]) < 128 THEN 3 ELSE 2 END) AS n,
         generate_series(1, length(r[1]) - n + 1) AS i
  $$;
`;

// Claim state (docs/design/29). A measure-like claim says subject + attribute +
// value + date: `attribute` is the key its parser read ("进度", "在岗人数"),
// the value is a number with its unit or a text, and `effective_at` is the
// date the claim speaks of — the date it states, else its document's date
// (`date_source` says which), taken from the newest evidence so a value
// repeated in a later report is dated by that report. `effective_scope_id` is
// the scope of that evidence, so a line's date and its source agree.
// `correction` marks a claim that corrects an earlier report. `state_v` is the
// parser version a row was read with: NULL rows are read lazily (the fold, or
// refine's backfill), never inside this migration — every column is added
// without a rewrite (no default, or a constant one) on finance's large table.
// `claim_attribute_keys` maps a subject's near-synonym keys onto one
// (完成度 / 进度), written by refine; `entity_namesakes` records a person
// split from a namesake by context, which extraction then resolves to.
// v_claims shows the subject's canonical key and falls back, for rows not yet
// read, to the old date columns.
// Weekly readings get ids of their own (src/graph/claim-rekey.ts): the moves of an existing
// workspace's claims onto them, kept until what was decided about the old claim has been
// carried over, and the indexes that carrying looks claims up by.
const V21_CLAIM_REKEY = `
CREATE TABLE IF NOT EXISTS claim_rekey_moves (
  old_id   TEXT NOT NULL,
  new_id   TEXT NOT NULL,
  week     TEXT,
  whole    BOOLEAN NOT NULL,
  carried  BOOLEAN NOT NULL DEFAULT false,
  -- the links to undo and redo, written with the carried rows, so a carry cut short redoes them
  plan     JSONB,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (old_id, new_id)
);
CREATE INDEX IF NOT EXISTS claim_rekey_moves_pending_idx ON claim_rekey_moves (old_id) WHERE NOT carried;
CREATE INDEX IF NOT EXISTS claim_rekey_moves_new_idx ON claim_rekey_moves (new_id);
CREATE INDEX IF NOT EXISTS claim_pair_verdicts_a_idx ON claim_pair_verdicts (a_id);
CREATE INDEX IF NOT EXISTS claim_pair_verdicts_b_idx ON claim_pair_verdicts (b_id);
CREATE INDEX IF NOT EXISTS suggestions_merge_claim_idx ON suggestions ((payload->>'claimId')) WHERE kind = 'claim-merge';
CREATE INDEX IF NOT EXISTS suggestions_merge_canonical_idx ON suggestions ((payload->>'canonicalId')) WHERE kind = 'claim-merge';
CREATE INDEX IF NOT EXISTS suggestions_conflict_a_idx ON suggestions ((payload->>'a')) WHERE kind = 'knowledge';
CREATE INDEX IF NOT EXISTS suggestions_conflict_b_idx ON suggestions ((payload->>'b')) WHERE kind = 'knowledge';
CREATE INDEX IF NOT EXISTS disputes_against_idx ON disputes (against_id);
CREATE INDEX IF NOT EXISTS claim_links_canonical_idx ON claim_links (canonical_id) WHERE tx_to IS NULL;
`;

const V19_CLAIM_STATE = `
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attribute TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS value_num DOUBLE PRECISION;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS value_text TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS date_source TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS effective_scope_id TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS correction BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS state_v SMALLINT;
CREATE INDEX IF NOT EXISTS claims_attribute_idx ON claims (subject_id, attribute) WHERE tx_to IS NULL AND attribute IS NOT NULL;
CREATE TABLE IF NOT EXISTS claim_attribute_keys (
  subject_id  TEXT NOT NULL,
  attribute   TEXT NOT NULL,
  canonical   TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, attribute)
);
CREATE TABLE IF NOT EXISTS entity_namesakes (
  id          TEXT PRIMARY KEY,
  base_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  label       TEXT NOT NULL,
  anchors     JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  documents   JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_namesakes_base_idx ON entity_namesakes (base_id);
CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path, cl.event_at, cl.observed_at, cl.superseded_by, cl.kind,
         COALESCE(ak.canonical, cl.attribute) AS attribute, cl.value_num, cl.value_text, cl.unit,
         COALESCE(cl.effective_at, cl.event_at, cl.valid_from, cl.observed_at) AS effective_at,
         COALESCE(cl.date_source, CASE WHEN cl.event_at IS NOT NULL OR cl.valid_from IS NOT NULL THEN 'stated'
                                       WHEN cl.observed_at IS NOT NULL THEN 'document' END) AS date_source,
         cl.correction, COALESCE(es.key, s.key) AS effective_source_path
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  LEFT JOIN scopes es ON es.id = cl.effective_scope_id
  LEFT JOIN claim_attribute_keys ak ON ak.subject_id = cl.subject_id AND ak.attribute = cl.attribute
  WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL;
`;

// A relation names the document it cites (relations.document_id was
// in the baseline schema and never written) and, where the extraction grounded
// it, the passage, as a claim does with chunk_id. The fold sets both from the
// live supporters whose scope is a document's own, its tier-1 extraction or a
// back-reference (a generated page's prose scope names its page, but is no
// source), by store/temporal.ts relationSource; only
// chunk_id needs an index, for the foreign key a chunk's deletion fires.
// Neither enters fold_sha. Rows written before keep NULL until
// `refreshRelationSources` (src/lineage/relation-sources.ts; Store.open, in the
// background, in batches) or their next fold; readers read the same choice
// from the evidence meanwhile (relationSourceSql).
const V20_RELATION_SOURCE = `
ALTER TABLE relations ADD COLUMN IF NOT EXISTS chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS relations_chunk_idx ON relations (chunk_id) WHERE chunk_id IS NOT NULL;
CREATE OR REPLACE VIEW v_relations AS
  SELECT r.id, r.source_id, r.target_id, r.type, r.description, r.weight,
         r.evidence_count, r.tx_from, r.valid_from, r.valid_to,
         r.document_id, r.chunk_id, d.path AS source_path
  FROM relations r LEFT JOIN documents d ON d.id = r.document_id
  WHERE r.tx_to IS NULL;
INSERT INTO meta (key, value) VALUES ('${RELATION_SOURCES_META}', '{"pending": true}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', up: async (q) => execScript(q, V1_BASELINE) },
  {
    version: 2,
    name: 'lineage',
    up: async (q, ctx) => {
      // Early pre-lineage builds are treated as v1 but did not yet include
      // datasets, pack_events, or suggestions.payload. Complete that baseline
      // inside this migration's transaction before altering those objects.
      if (ctx.from >= 1) await execScript(q, V1_BASELINE);
      await execScript(q, V2_LINEAGE);
      if (ctx.from >= 1) {
        await q.query(
          `INSERT INTO meta (key, value) VALUES ('lineage_rebuild', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify({ pending: true, at: new Date().toISOString() })],
        );
      }
    },
  },
  { version: 3, name: 'temporal', up: async (q) => execScript(q, V3_TEMPORAL) },
  { version: 4, name: 'capability', up: async (q) => execScript(q, V4_CAPABILITY) },
  { version: 5, name: 'receipts', up: async (q) => execScript(q, V5_RECEIPTS) },
  { version: 6, name: 'agent-db', up: async (q) => execScript(q, V6_AGENT_DB) },
  { version: 7, name: 'wiki-research', up: async (q) => execScript(q, V7_WIKI_RESEARCH) },
  { version: 8, name: 'review', up: async (q) => execScript(q, V8_REVIEW) },
  { version: 9, name: 'chat', up: async (q) => execScript(q, V9_CHAT) },
  { version: 10, name: 'chat-quick', up: async (q) => execScript(q, V10_CHAT_QUICK) },
  { version: 11, name: 'claim-merge', up: async (q) => execScript(q, V11_CLAIM_MERGE) },
  { version: 12, name: 'dispose-indexes', up: async (q) => execScript(q, V12_DISPOSE_INDEXES) },
  { version: 13, name: 'derived-cooccurrence', up: async (q) => execScript(q, V13_DERIVED_COOCCURRENCE) },
  { version: 14, name: 'claim-kind', up: async (q) => execScript(q, V14_CLAIM_KIND) },
  { version: 15, name: 'document-chars', up: async (q) => execScript(q, V15_DOCUMENT_CHARS) },
  { version: 16, name: 'citations', up: async (q) => execScript(q, V16_CITATIONS) },
  { version: 17, name: 'content-languages', up: async (q) => execScript(q, V17_CONTENT_LANGUAGES) },
  { version: 18, name: 'match-grams', up: async (q) => execScript(q, V18_MATCH_GRAMS) },
  { version: 19, name: 'claim-state', up: async (q) => execScript(q, V19_CLAIM_STATE) },
  { version: 20, name: 'relation-source', up: async (q) => execScript(q, V20_RELATION_SOURCE) },
  { version: 21, name: 'claim-rekey', up: async (q) => execScript(q, V21_CLAIM_REKEY) },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export interface CoOccursCleanupResult {
  relations: number;
  evidence: number;
  batches: number;
  seconds: number;
}

interface MetaStore extends Queryable {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

/**
 * The follow-up v13 flags: delete the stored co_occurs rows and their evidence,
 * `batch` relations per statement, each statement its own transaction, keyed
 * forward by relation id so a batch never re-walks what the last one deleted.
 * Store.open starts it in the background once the migrations have committed,
 * so the service comes up at once; `close` stops it after the statement in
 * flight and the next open resumes where it stopped. Readers ignore rows of
 * this type until it is done (graph/query.ts and the other relation readers).
 * Nothing here touches `meta.ledger_seq`. Idempotent: the flag stays pending
 * until a batch finds nothing left, so a stopped run, a crash, or a second
 * opener working at the same time all simply continue.
 *
 * Measured 2026-10-18 by opening a Postgres 17 copy of the finance workspace
 * with this code (998k co_occurs rows, 2.24M evidence rows; shared_buffers
 * 128MB, the server's settings): open returned after 0.1 s; 100 statements of
 * 10k relations, median 1.0 s, p95 1.7 s, max 2.7 s each (the evidence rows of
 * a batch are scattered over a 1.2 GB table), 99 s in all, each statement
 * holding only its own row locks for that long. The one-statement delete it
 * replaces took 20 s inside the startup transaction.
 */
export async function dropStoredCoOccurrence(
  store: MetaStore,
  opts: { batch?: number; log?: (line: string) => void; stop?: () => boolean } = {},
): Promise<CoOccursCleanupResult | null> {
  const flag = await store.getMeta<{ pending?: boolean }>(COOCCURS_CLEANUP_META);
  if (!flag?.pending) return null;
  const batch = Math.max(100, Math.floor(opts.batch ?? 10_000));
  const log = opts.log ?? ((line: string) => console.log(`[knode-os] ${line}`));
  const [{ n: total }] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM relations WHERE type = 'co_occurs'`);
  const started = Date.now();
  if (total > 0) log(`dropping ${total} stored co_occurs relation rows and their evidence, ${batch} relations per statement (co-occurrence is derived from mentions now)`);
  let relations = 0;
  let evidence = 0;
  let batches = 0;
  let last = '';
  let lastLog = started;
  for (;;) {
    if (opts.stop?.()) {
      log(`co_occurs cleanup paused at ${relations} / ${total} relations after ${((Date.now() - started) / 1000).toFixed(1)} s; the next open resumes it`);
      return { relations, evidence, batches, seconds: (Date.now() - started) / 1000 };
    }
    const [row] = await store.query<{ relations: number; evidence: number; last: string | null }>(
      `WITH batch AS (
         SELECT id FROM relations WHERE type = 'co_occurs' AND id > $1 ORDER BY id LIMIT $2
       ), ev AS (
         DELETE FROM evidence e USING batch b WHERE e.kind = 'relation' AND e.target_id = b.id RETURNING e.id
       ), rel AS (
         DELETE FROM relations r USING batch b WHERE r.id = b.id RETURNING r.id
       )
       SELECT (SELECT count(*)::int FROM rel) AS relations, (SELECT count(*)::int FROM ev) AS evidence, (SELECT max(id) FROM batch) AS last`,
      [last, batch],
    );
    if (!row?.last) break;
    last = row.last;
    relations += Number(row.relations);
    evidence += Number(row.evidence);
    batches++;
    if (Date.now() - lastLog >= 2000) {
      lastLog = Date.now();
      log(`co_occurs cleanup: ${relations} / ${total} relations, ${evidence} evidence rows, ${((lastLog - started) / 1000).toFixed(1)} s`);
    }
  }
  const seconds = (Date.now() - started) / 1000;
  await store.setMeta(COOCCURS_CLEANUP_META, { pending: false, finishedAt: new Date().toISOString(), relations, evidence, batches, seconds });
  if (total > 0 || relations > 0) log(`dropped ${relations} stored co_occurs relation rows and ${evidence} evidence rows in ${batches} batches, ${seconds.toFixed(1)} s`);
  return { relations, evidence, batches, seconds };
}

async function execScript(q: Queryable, script: string): Promise<void> {
  if (q.exec) {
    await q.exec(script);
    return;
  }
  for (const statement of splitStatements(script)) await q.query(statement);
}

/** Split a DDL script on statement boundaries (no string literals contain ';'). */
export function splitStatements(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface MigrationResult {
  from: number;
  to: number;
}

/**
 * Bring the database to the current schema version. A database created before
 * versioning (no `schema_version` key but a `documents` table) is treated as v1.
 *
 * Only the schema the store creates its tables in counts, `current_schema()`:
 * `public` on PGlite, the workspace's own schema on Postgres. On Postgres
 * `public` sits on every workspace's search_path (pgvector lives there), so a
 * `documents` table in it belongs to no workspace and must not make a fresh
 * schema look like v1.
 */
export async function migrate(
  q: Queryable,
  tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>,
): Promise<MigrationResult> {
  const [row] = await q.query<{ value: { v: number } }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  let current = row?.value?.v;
  if (current === undefined) {
    const [t] = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'documents'`,
    );
    current = t?.n ? 1 : 0;
  }
  const from = current;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await tx(async (txq) => {
      await m.up(txq, { from });
      await txq.query(
        `INSERT INTO meta (key, value) VALUES ('schema_version', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify({ v: m.version, name: m.name, at: new Date().toISOString() })],
      );
    });
    current = m.version;
  }
  // a database made here holds no claim written before weekly readings had ids of their own:
  // nothing for src/graph/claim-rekey.ts to move, and nothing for the audit to wait on
  if (from === 0) {
    await q.query(`INSERT INTO meta (key, value) VALUES ('claim_identity', '{"cursor": null, "done": true}'::jsonb) ON CONFLICT (key) DO NOTHING`);
  }
  return { from, to: current };
}
