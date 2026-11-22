/**
 * What an agent needs to write SQL against the catalog without guessing the
 * schema (docs/design/30 §5): the views a question about the knowledge base
 * itself is answered from, their columns, and worked queries. Shown in the
 * `knode_query` description and in the benchmark agent's brief; every example
 * is run against a fixture by tests/answer-routing.test.ts, so a view change
 * that breaks one fails there.
 */

export const CATALOG_VIEW_COLUMNS = [
  'v_entities(id, name, type, description, aliases jsonb, wiki_path, mention_count, evidence_count, canonical_id) — canonical_id set: merged into that entity',
  'v_claims(id, subject_id, object_id, type, statement, status [fact|suspected|disputed], kind [fact|opinion|prediction|rumor], valid_from, valid_to, event_at, observed_at, superseded_by, source_path, evidence_count, attribute, value_num, value_text, unit, effective_at, date_source [stated|document], correction, effective_source_path) — attribute: what the claim measures about its subject (progress, headcount, price …), with its value; effective_at: the date it holds from (stated, else the date of its document); superseded_by set: replaced by that newer claim, so superseded_by IS NULL is the current value of an attribute',
  'v_relations(id, source_id, target_id, type, description, weight, evidence_count, valid_from, valid_to, document_id, chunk_id, source_path) — source_path: the one document cited for the link, the earliest-dated that states it, then the first by path (chunk_id: the passage in it, when one was recorded; v_evidence has every source); NULL for a link no document states',
  'v_evidence(kind [entity|relation|claim], target_id, source_path, weight, extractor, tx_from, tx_to) — every source behind a row; tx_to IS NULL: still live',
  'v_mentions(entity_id, chunk_id, document_id, document_path)',
  'v_documents(id, path, root, kind, title, doc_date, status)',
];

export const CATALOG_EXAMPLES: { question: string; sql: string }[] = [
  {
    question: 'every current claim about an entity dated in 2026, oldest first',
    sql: `SELECT c.event_at, c.statement, c.source_path FROM v_claims c JOIN v_entities e ON e.id = c.subject_id WHERE e.name ILIKE 'Acme%' AND c.superseded_by IS NULL AND c.event_at >= '2026-01-01' AND c.event_at < '2027-01-01' ORDER BY c.event_at`,
  },
  {
    question: 'the current value of every attribute of an entity, and one attribute\'s history',
    sql: `SELECT c.attribute, c.value_num, c.value_text, c.unit, c.effective_at, c.superseded_by IS NULL AS current, c.effective_source_path FROM v_claims c JOIN v_entities e ON e.id = c.subject_id WHERE e.name ILIKE 'Acme%' AND c.attribute IS NOT NULL ORDER BY c.attribute, c.effective_at`,
  },
  {
    question: 'who did what with an entity — every relation in both directions, with the sentence that states it (one hop of a chain)',
    sql: `SELECT s.name AS source, r.type, t.name AS target, r.description, r.valid_from FROM v_relations r JOIN v_entities s ON s.id = r.source_id JOIN v_entities t ON t.id = r.target_id WHERE s.name ILIKE 'Acme%' OR t.name ILIKE 'Acme%' ORDER BY r.weight DESC LIMIT 50`,
  },
  {
    question: 'how many documents mention each organization',
    sql: `SELECT e.name, count(DISTINCT m.document_id) AS documents FROM v_entities e JOIN v_mentions m ON m.entity_id = e.id WHERE e.type = 'organization' AND e.canonical_id IS NULL GROUP BY e.name ORDER BY documents DESC LIMIT 20`,
  },
  {
    question: 'which sources state the claims matching a word',
    sql: `SELECT c.statement, v.source_path FROM v_claims c JOIN v_evidence v ON v.target_id = c.id AND v.kind = 'claim' AND v.tx_to IS NULL WHERE c.statement ILIKE '%outage%' ORDER BY c.statement`,
  },
];

/** The guide as one block of text. */
export function catalogGuide(): string {
  return [
    'Catalog views (source="catalog": Postgres SQL, one SELECT / WITH, read-only, row-capped; knode_datasources lists every view):',
    ...CATALOG_VIEW_COLUMNS.map((v) => `- ${v}`),
    'Join an entity to its claims by v_claims.subject_id (or object_id) = v_entities.id; match names with ILIKE. Examples:',
    ...CATALOG_EXAMPLES.map((e, i) => `${i + 1}. ${e.question}: ${e.sql}`),
  ].join('\n');
}
