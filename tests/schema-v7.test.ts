import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { CATALOG_VIEWS } from '../src/store/catalog.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-schema-v7-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('schema v7/v8/v10/v11/v12/v13/v14/v15/v16/v17/v18/v19/v20 (wiki research + review + quick answers + claim merges + dispose indexes + derived co-occurrence + claim kind + document chars + citations + content languages + match grams + claim state + relation source)', () => {
  it('adds the temporal relation / claim columns, resolution tables and research jobs, and every catalog view resolves', async () => {
    fs.mkdirSync(path.join(tmp, 'ws', '.knode'), { recursive: true });
    const store = await Store.open(path.join(tmp, 'ws'), 3);
    try {
      expect(SCHEMA_VERSION).toBe(22);
      expect(store.migration.to).toBe(22);
      // v22: table facts and their label keys (src/tables), and the catalog view over them
      expect(await store.query(`SELECT count(*)::int AS n FROM v_table_facts`)).toEqual([{ n: 0 }]);
      expect(await store.query(`SELECT count(*)::int AS n FROM table_label_keys`)).toEqual([{ n: 0 }]);
      // every foreign key a disposal fires, the merged-entity lookup of the fold, and the
      // document side of derived co-occurrence (v13) have an index to use
      const indexes = (await store.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`)).map((r) => r.indexname);
      expect(indexes).toEqual(expect.arrayContaining(['claims_chunk_idx', 'claims_object_idx', 'pages_scope_idx', 'entities_canonical_idx', 'mentions_document_idx']));
      const columns = async (table: string) =>
        (await store.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
          [table],
        )).map((r) => r.column_name);
      expect(await columns('relations')).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
      // v20: the document and passage a relation was read from (lineage/fold.ts relationSource)
      expect(await columns('relations')).toEqual(expect.arrayContaining(['document_id', 'chunk_id']));
      expect(await columns('v_relations')).toEqual(expect.arrayContaining(['document_id', 'chunk_id', 'source_path']));
      expect(indexes).toContain('relations_chunk_idx');
      expect(await columns('claims')).toEqual(expect.arrayContaining(['event_at', 'observed_at', 'superseded_by']));
      expect(await columns('documents')).toContain('doc_date');
      // v15: the indexed text's length, read by the Summarize stage's size threshold (docs/design/14)
      expect(await columns('documents')).toContain('chars');
      // v16: wiki pages citing raw/docs files, owned by the citing scope (src/graph/citations.ts)
      expect(await columns('citations')).toEqual(expect.arrayContaining(['scope_id', 'source_path', 'target_path', 'type', 'inverse', 'via', 'fragment', 'tx_from', 'tx_to']));
      expect(indexes).toEqual(expect.arrayContaining(['citations_target_idx', 'citations_source_idx', 'citations_scope_idx']));
      // v17: a document's language, and how far each translation of it got (docs/design/17)
      expect(await columns('documents')).toContain('language');
      expect(await columns('translations')).toEqual(expect.arrayContaining(['document_id', 'language', 'content_sha', 'status', 'parts', 'done', 'attempts', 'requested', 'model', 'error']));
      expect(indexes).toContain('translations_status_idx');
      // v18: the n-grams substring matching looks terms up by (src/store/grams.ts); open builds the indexes over them in the background
      expect(await store.query(`SELECT match_grams('宁德时代 HBM3E')::text AS grams`)).toEqual([{ grams: `'3e' 'bm' 'bm3' 'hb' 'hbm' 'm3' 'm3e' '宁德' '德时' '时代'` }]);
      expect(await columns('entities')).toEqual(expect.arrayContaining(['canonical_id', 'name_key']));
      expect(await columns('entity_alias_keys')).toEqual(expect.arrayContaining(['entity_id', 'alias_key', 'kind']));
      expect(await columns('entity_links')).toEqual(expect.arrayContaining(['entity_id', 'canonical_id', 'scope_id']));
      expect(await columns('entity_embeddings')).toEqual(expect.arrayContaining(['entity_id', 'fold_sha', 'embedding']));
      expect(await columns('research_jobs')).toEqual(expect.arrayContaining(['kind', 'template', 'status', 'output_path']));
      expect(await columns('chat_conversations')).toEqual(expect.arrayContaining(['title', 'agent', 'status', 'payload']));
      expect(await columns('chat_messages')).toEqual(expect.arrayContaining(['conversation_id', 'seq', 'role', 'content', 'events', 'payload', 'turns', 'cost_usd', 'error']));
      expect(await columns('claims')).toContain('canonical_id');
      expect(await columns('claim_links')).toEqual(expect.arrayContaining(['claim_id', 'canonical_id', 'kind', 'scope_id', 'confidence']));
      expect(await columns('claim_pair_verdicts')).toEqual(expect.arrayContaining(['pair_id', 'relation', 'confidence', 'model']));
      expect(await columns('claim_embeddings')).toEqual(expect.arrayContaining(['claim_id', 'model', 'embedding']));
      expect(await columns('extraction_queue')).toEqual(expect.arrayContaining(['segments_total', 'segments_done']));
      // v19: claim state (docs/design/29) — attribute, value, effective date — and the tables refine keeps beside it
      expect(await columns('claims')).toEqual(expect.arrayContaining(['attribute', 'value_num', 'value_text', 'unit', 'effective_at', 'date_source', 'effective_scope_id', 'correction', 'state_v']));
      expect(await columns('claim_attribute_keys')).toEqual(expect.arrayContaining(['subject_id', 'attribute', 'canonical', 'reason']));
      expect(await columns('entity_namesakes')).toEqual(expect.arrayContaining(['id', 'base_id', 'name', 'label', 'anchors', 'documents', 'reason']));
      expect(await columns('v_claims')).toEqual(expect.arrayContaining(['attribute', 'value_num', 'value_text', 'unit', 'effective_at', 'date_source', 'correction', 'effective_source_path']));
      expect(indexes).toContain('claims_attribute_idx');
      for (const view of CATALOG_VIEWS) {
        await expect(store.query(`SELECT * FROM ${view.name} LIMIT 1`)).resolves.toBeDefined();
      }
    } finally {
      await store.close();
    }
  });
});
