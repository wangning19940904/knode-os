import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { readSidecarPart, SidecarTables, updateSidecarPart } from '../fs/sidecar.js';
import { segmentText } from '../graph/segment.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { loadSourceText, readSourceTextCapped, sha256 } from '../ingest/source.js';
import { applyScope } from '../lineage/scope.js';
import type { ChatMessage } from '../llm/client.js';
import { Store } from '../store/db.js';
import { identityNormalizer, isKnownKey, LabelNormalizer, labelKey, cleanLabel } from './labels.js';
import { modelPathSegments, modelRowsToFacts, parseTableModelReply, tableModelMessages } from './llm.js';
import { parseTables, TableFact, TableParse } from './parse.js';
import { parsePeriod } from './values.js';

/**
 * Table facts in the store (docs/design/38 §3.2 item 1).
 *
 * Each document's facts are written by a `tables` scope, a child of its `doc`
 * scope, keyed by the document's path, whose sha is the document's content
 * hash with the parser's version (and the model replies it replays). So:
 *
 *   - a document that changes replaces its doc scope, which disposes the
 *     child, which deletes its facts; the next pass parses the new text;
 *   - a document removed takes its facts with it the same way;
 *   - a parser change (TABLE_PARSER_VERSION) re-parses every document once;
 *   - turning the switch on in a workspace that has documents parses them all
 *     on the next sync, without re-applying a single document.
 *
 * `refreshTableFacts` is that pass, at the end of every sync while
 * `extraction.tableFacts.enabled` is on. It reads only files, never a model.
 */

/** Bump when parsing changes what a document yields: every document is parsed again on the next sync. */
export const TABLE_PARSER_VERSION = 1;

export function tableFactsEnabled(config: KnodeConfig): boolean {
  return config.extraction.tableFacts?.enabled === true;
}

function modelReplay(config: KnodeConfig): boolean {
  return config.extraction.tableFacts?.model === true;
}

/** The facts a document's text yields: the layout reading's, then the stored model replies' for lines it left unexplained. */
export function buildTableFacts(text: string, opts: { title?: string | null; segmentChars?: number; replies?: SidecarTables | null } = {}): { parse: TableParse; facts: TableFact[]; modelSegments: string[] } {
  const parse = parseTables(text, { title: opts.title });
  const facts = [...parse.facts];
  const used: string[] = [];
  const replies = opts.replies?.segments;
  if (replies && Object.keys(replies).length) {
    const segments = segmentText(text, opts.segmentChars ?? 12_000);
    const explained = new Set(parse.facts.filter((f) => f.valueNum !== null && f.confidence >= 0.7).map((f) => f.line));
    let no = parse.tables.length;
    for (const seg of modelPathSegments(text, segments, parse)) {
      const reply = replies[seg.sha];
      if (!reply) continue;
      used.push(seg.sha);
      const rows = reply.rows.filter((r) => !explained.has(r.line));
      facts.push(...modelRowsToFacts(rows, text, ++no).map((f) => ({ ...f, tableTitle: `model: lines ${seg.startLine}–${seg.endLine}` })));
    }
  }
  return { parse, facts, modelSegments: used.sort() };
}

/**
 * The text a ref's line number counts in: what an agent reads at the path —
 * the file itself, or a converted original's derived Markdown (knode_read,
 * grep, sed). Not the indexed text, which carries frontmatter the file may not.
 */
function shownText(dataDir: string, key: string): string | null {
  try {
    return readSourceTextCapped(dataDir, key, MAX_FILE_BYTES)?.content ?? null;
  } catch {
    return null;
  }
}

function tablesSha(docSha: string, modelSegments: string[]): string {
  return crypto.createHash('sha256').update(`${docSha}|tables v${TABLE_PARSER_VERSION}|${modelSegments.join(',')}`).digest('hex');
}

export interface RefreshStats {
  parsed: number;
  unchanged: number;
  facts: number;
  skipped: number;
}

interface LiveDoc {
  id: string;
  key: string;
  sha: string;
  document_id: string | null;
  title: string | null;
  tables_sha: string | null;
}

/**
 * Parse the tables of every live raw/docs document whose facts are missing or
 * stale (under `prefixes`, when given). A no-op while the switch is off.
 */
export async function refreshTableFacts(
  ctx: { store: Store; config: KnodeConfig; dataDir: string },
  opts: { prefixes?: string[]; onProgress?: (m: string) => void; actor?: string; force?: boolean } = {},
): Promise<RefreshStats> {
  const stats: RefreshStats = { parsed: 0, unchanged: 0, facts: 0, skipped: 0 };
  if (!tableFactsEnabled(ctx.config)) return stats;
  const params: unknown[] = [];
  let scoped = '';
  if (opts.prefixes?.length) {
    params.push(opts.prefixes);
    scoped = ` AND (s.key = ANY($1::text[]) OR EXISTS (SELECT 1 FROM unnest($1::text[]) AS u(prefix) WHERE starts_with(s.key, u.prefix || '/')))`;
  }
  const docs = await ctx.store.query<LiveDoc>(
    `SELECT s.id, s.key, s.sha, s.meta->>'documentId' AS document_id, d.title, t.sha AS tables_sha
     FROM scopes s
     LEFT JOIN documents d ON d.path = s.key
     LEFT JOIN scopes t ON t.parent_id = s.id AND t.kind = 'tables' AND t.status = 'active'
     WHERE s.kind = 'doc' AND s.status = 'active' AND s.parent_id IS NULL AND s.meta->>'root' = 'docs'${scoped}
     ORDER BY s.key`,
    params,
  );
  const replay = modelReplay(ctx.config);
  for (const doc of docs) {
    const replies = replay ? readSidecarPart(ctx.dataDir, doc.key, 'tables') : null;
    // the sha a pass would write, known without reading the text unless there are replies to weigh
    if (!opts.force && !replies && doc.tables_sha === tablesSha(doc.sha, [])) {
      stats.unchanged++;
      continue;
    }
    const source = loadSourceText(ctx.dataDir, doc.key, 'docs');
    const shown = shownText(ctx.dataDir, doc.key);
    // the file changed since its scope was applied: the next sync re-applies it, and parses it then
    if (!source || shown === null || sha256(source.text) !== doc.sha || !doc.document_id) {
      stats.skipped++;
      continue;
    }
    const built = buildTableFacts(shown, { title: doc.title, segmentChars: ctx.config.extraction.segmentChars, replies });
    const sha = tablesSha(doc.sha, built.modelSegments);
    if (!opts.force && doc.tables_sha === sha) {
      stats.unchanged++;
      continue;
    }
    await applyScope(
      ctx.store,
      { kind: 'tables', key: doc.key },
      sha,
      { parentId: doc.id, actor: opts.actor ?? 'sync', force: opts.force, meta: { documentId: doc.document_id, parser: TABLE_PARSER_VERSION, tables: built.parse.tables.length } },
      async (w) => {
        await w.tableFacts({ id: doc.document_id!, path: doc.key, subject: built.parse.subject, docPeriod: built.parse.docPeriod }, built.facts);
      },
    );
    stats.parsed++;
    stats.facts += built.facts.length;
  }
  if (stats.parsed) opts.onProgress?.(`tables: ${stats.facts} facts from ${stats.parsed} document(s)`);
  return stats;
}

/* ---------------------------- label normalization --------------------------- */

/**
 * Put the distinct label keys no synonym group holds to `normalizer`, once
 * each: its mappings go to `table_label_keys`, and a key it leaves alone is
 * recorded as asked (canonical = itself), so it is not asked again.
 */
export async function normalizeTableLabels(store: Store, normalizer: LabelNormalizer = identityNormalizer, opts: { limit?: number } = {}): Promise<{ asked: number; mapped: number }> {
  const rows = await store.query<{ label_key: string }>(
    `SELECT DISTINCT f.label_key FROM table_facts f
     WHERE NOT EXISTS (SELECT 1 FROM table_label_keys k WHERE k.label_key = f.label_key)
     ORDER BY f.label_key LIMIT $1`,
    [opts.limit ?? 5000],
  );
  const keys = rows.map((r) => r.label_key).filter((k) => !isKnownKey(k));
  if (!keys.length) return { asked: 0, mapped: 0 };
  const mappings = new Map((await normalizer.normalize(keys)).map((m) => [m.key, m]));
  for (let i = 0; i < keys.length; i += 500) {
    const batch = keys.slice(i, i + 500);
    const canon = batch.map((k) => mappings.get(k)?.canonical ?? k);
    const reason = batch.map((k) => (mappings.has(k) ? `${normalizer.name}: ${mappings.get(k)!.reason}` : `${normalizer.name}: none`));
    await store.query(
      `INSERT INTO table_label_keys (label_key, canonical, reason, updated_at)
       SELECT * , now() FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (label_key) DO UPDATE SET canonical = EXCLUDED.canonical, reason = EXCLUDED.reason, updated_at = now()`,
      [batch, canon, reason],
    );
  }
  return { asked: keys.length, mapped: [...mappings.values()].filter((m) => m.canonical !== m.key).length };
}

/* ------------------------------ the model pass ------------------------------ */

export interface ModelPassStats {
  documents: number;
  calls: number;
  rows: number;
  failed: number;
}

/**
 * Send the segments the layout reading cannot vouch for to a model, once
 * each, and keep the rows the text bears out in the sidecar; then re-apply
 * those documents' facts. `complete` is the call (an LlmClient's `complete`,
 * or a stub). Not run by sync or by any background pass.
 */
export async function runTableModelPass(
  ctx: { store: Store; config: KnodeConfig; dataDir: string },
  complete: (messages: ChatMessage[]) => Promise<string>,
  opts: { model: string; paths?: string[]; maxCalls?: number } = { model: 'unknown' },
): Promise<ModelPassStats> {
  const stats: ModelPassStats = { documents: 0, calls: 0, rows: 0, failed: 0 };
  const docs = await ctx.store.query<{ key: string; title: string | null }>(
    `SELECT s.key, d.title FROM scopes s LEFT JOIN documents d ON d.path = s.key
     WHERE s.kind = 'tables' AND s.status = 'active'${opts.paths?.length ? ' AND s.key = ANY($1::text[])' : ''} ORDER BY s.key`,
    opts.paths?.length ? [opts.paths] : [],
  );
  const touched: string[] = [];
  for (const doc of docs) {
    if (opts.maxCalls !== undefined && stats.calls >= opts.maxCalls) break;
    const text = shownText(ctx.dataDir, doc.key);
    if (text === null) continue;
    const parse = parseTables(text, { title: doc.title });
    const segments = segmentText(text, ctx.config.extraction.segmentChars);
    const cached = readSidecarPart(ctx.dataDir, doc.key, 'tables')?.segments ?? {};
    let added = false;
    for (const seg of modelPathSegments(text, segments, parse)) {
      if (cached[seg.sha]) continue;
      if (opts.maxCalls !== undefined && stats.calls >= opts.maxCalls) break;
      stats.calls++;
      let reply: string;
      try {
        reply = await complete(tableModelMessages(text, seg, { subject: parse.subject, title: doc.title }));
      } catch {
        stats.failed++;
        continue;
      }
      const rows = parseTableModelReply(reply, text, seg);
      stats.rows += rows.length;
      updateSidecarPart(ctx.dataDir, doc.key, 'tables', (cur) => ({
        segments: { ...(cur?.segments ?? {}), [seg.sha]: { model: opts.model, at: new Date().toISOString(), rows } },
      }));
      added = true;
    }
    if (added) {
      stats.documents++;
      touched.push(doc.key);
    }
  }
  if (touched.length && modelReplay(ctx.config)) await refreshTableFacts(ctx, { prefixes: touched, actor: 'tables.model' });
  return stats;
}

/* ------------------------------- knode_table ------------------------------- */

export interface TableQuery {
  /** Row labels as written or keys ("营业收入", "Accounts payable", "revenue"); one or more. */
  metrics: string[];
  /** Companies (or documents): matched against the fact's subject, its document's title and path. */
  subjects?: string[];
  /** "2024", "2024-03-31", "2024-Q1", "期末余额", "current" …; none: every period found. */
  periods?: string[];
  /** Restrict to documents under these path prefixes. */
  paths?: string[];
  /** false: a metric matches only by key or exact label; true (default): a label containing it when nothing matches exactly. */
  contains?: boolean;
}

export interface TableCell {
  value: number | null;
  /** The cell as written. */
  text: string;
  unit: string | null;
  /** The scale's wording as written ("单位：元", "in thousands"); null when the table states none. */
  scale: string | null;
  scaleFactor: number;
  /** value × scaleFactor. */
  valueScaled: number | null;
  /** path#Lline of the row. */
  ref: string;
  label: string;
  period: string;
  periodKey: string | null;
  periodSpan: string | null;
  table: string | null;
  section: string | null;
  parser: string;
  confidence: number;
  /** Other cells of this document that match too (another table, another column under the same period), up to three. */
  alternatives?: { value: number | null; text: string; scale: string | null; ref: string; label: string; period: string; table: string | null }[];
}

export interface TableMatrix {
  columns: string[];
  rows: { subject: string; path: string; metric: string; cells: Record<string, TableCell | null> }[];
  /** Subject × metric pairs nothing matched. */
  missing: { subject: string | null; metric: string }[];
  note: string;
}

interface FactRow {
  source_path: string;
  subject: string | null;
  doc_period: string | null;
  title: string | null;
  table_no: number;
  table_title: string | null;
  line: number;
  section: string | null;
  label: string;
  label_key: string;
  period: string;
  period_key: string | null;
  period_span: string | null;
  value_num: number | null;
  value_text: string;
  unit: string | null;
  scale: string | null;
  scale_factor: number;
  parser: string;
  confidence: number;
}

const FACT_CAP = 20_000;

/** A requested period's test on a fact: its own key, the document's period for a `current` column, the header as written. */
function periodMatcher(p: string): (f: FactRow) => boolean {
  const key = parsePeriod(p).key ?? p.trim().toLowerCase();
  const raw = p.trim().toLowerCase();
  return (f) => {
    const own = f.period_key === 'current' && f.doc_period ? f.doc_period : f.period_key;
    if (own && (own === key || own.startsWith(`${key}-`) || (key.length === 4 && own.startsWith(key)))) return true;
    if ((key === 'current' || key === 'prior' || key === 'change') && f.period_key === key) return true;
    return raw.length >= 2 && f.period.toLowerCase().includes(raw);
  };
}

/** The column a fact falls in when no periods were asked for: its resolved key, else its header. */
function naturalColumn(f: FactRow): string {
  if (f.period_key === 'current' && f.doc_period) return f.doc_period;
  return f.period_key ?? (f.period || '(no header)');
}

/**
 * Metrics × subjects × periods in one call: for each subject and metric, the
 * cell of each period, with its value as written, unit, scale and line.
 */
export async function tableMatrix(store: Store, q: TableQuery): Promise<TableMatrix> {
  const metrics = [...new Set(q.metrics.map((m) => m.trim()).filter(Boolean))];
  if (!metrics.length) throw new Error('knode_table: name at least one metric');
  const mapped = new Map((await store.query<{ label_key: string; canonical: string }>(`SELECT label_key, canonical FROM table_label_keys`)).map((r) => [r.label_key, r.canonical]));
  const metricKeys = metrics.map((m) => {
    const k = labelKey(m);
    return { metric: m, key: mapped.get(k) ?? k, raw: cleanLabel(m) };
  });

  const params: unknown[] = [];
  const where: string[] = [];
  params.push([...new Set(metricKeys.map((m) => m.key))], [...new Set(metricKeys.map((m) => m.raw))]);
  const contains = q.contains !== false;
  const likes = metrics.map((m) => `%${m.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  params.push(likes);
  where.push(`(f.label_key = ANY($1::text[]) OR lower(f.label) = ANY($2::text[])${contains ? ' OR f.label ILIKE ANY($3::text[])' : ''})`);
  if (q.paths?.length) {
    params.push(q.paths);
    where.push(`(f.source_path = ANY($${params.length}::text[]) OR EXISTS (SELECT 1 FROM unnest($${params.length}::text[]) AS u(prefix) WHERE starts_with(f.source_path, u.prefix || '/')))`);
  }
  const subjects = [...new Set((q.subjects ?? []).map((s) => s.trim()).filter(Boolean))];
  // a subject also answers to its entity's aliases
  const spellings = new Map<string, string[]>();
  for (const s of subjects) {
    const ent = await store.query<{ aliases: unknown }>(
      `SELECT aliases FROM entities WHERE tx_to IS NULL AND lower(name) = lower($1) LIMIT 1`,
      [s],
    ).catch(() => []);
    const aliases = Array.isArray(ent[0]?.aliases) ? (ent[0].aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    spellings.set(s, [s, ...aliases].filter((x) => x.length >= 2));
  }
  if (subjects.length) {
    const all = [...new Set([...spellings.values()].flat())].map((x) => `%${x.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    params.push(all);
    const p = `$${params.length}::text[]`;
    where.push(`(f.subject ILIKE ANY(${p}) OR f.source_path ILIKE ANY(${p}) OR d.title ILIKE ANY(${p}))`);
  }
  params.push(FACT_CAP + 1);
  const facts = await store.query<FactRow>(
    `SELECT f.source_path, f.subject, f.doc_period, d.title, f.table_no, f.table_title, f.line, f.section, f.label, f.label_key,
            f.period, f.period_key, f.period_span, f.value_num, f.value_text, f.unit, f.scale, f.scale_factor, f.parser, f.confidence
     FROM v_table_facts f LEFT JOIN documents d ON d.id = f.document_id
     WHERE ${where.join(' AND ')}
     ORDER BY f.source_path, f.table_no, f.line, f.col
     LIMIT $${params.length}`,
    params,
  );
  const truncated = facts.length > FACT_CAP;
  const rows = facts.slice(0, FACT_CAP);

  // which metric a fact answers: by key or exact label first; by containment only for a metric nothing else matched in that document
  const exactOf = (f: FactRow, m: (typeof metricKeys)[number]) => f.label_key === m.key || f.label.toLowerCase() === m.raw || cleanLabel(f.label) === m.raw;
  const subjectOf = (f: FactRow): string | null => {
    if (!subjects.length) return f.subject ?? f.title ?? f.source_path;
    const hay = `${f.subject ?? ''} ${f.title ?? ''} ${f.source_path}`.toLowerCase();
    return subjects.find((s) => spellings.get(s)!.some((x) => hay.includes(x.toLowerCase()))) ?? null;
  };
  const periodTests = (q.periods ?? []).map((p) => ({ name: p, test: periodMatcher(p) }));

  type Group = { subject: string; path: string; metric: string; facts: { f: FactRow; exact: boolean }[] };
  const groups = new Map<string, Group>();
  for (const f of rows) {
    const subject = subjectOf(f);
    if (subject === null) continue;
    for (const m of metricKeys) {
      const exact = exactOf(f, m);
      if (!exact && !(contains && f.label.toLowerCase().includes(m.metric.toLowerCase()))) continue;
      const key = `${subject}\u0000${f.source_path}\u0000${m.metric}`;
      const g = groups.get(key) ?? { subject, path: f.source_path, metric: m.metric, facts: [] };
      g.facts.push({ f, exact });
      groups.set(key, g);
    }
  }

  const columns = periodTests.length
    ? periodTests.map((p) => p.name)
    : [...new Set([...groups.values()].flatMap((g) => g.facts.filter((x) => x.f.value_num !== null).map((x) => naturalColumn(x.f))))].sort((a, b) => b.localeCompare(a));
  const out: TableMatrix['rows'] = [];
  for (const g of groups.values()) {
    // containment answers only where the document has no exact match for the metric
    const pool = g.facts.some((x) => x.exact) ? g.facts.filter((x) => x.exact) : g.facts;
    const cells: Record<string, TableCell | null> = {};
    let any = false;
    for (const col of columns) {
      const test = periodTests.length ? periodTests.find((p) => p.name === col)!.test : (f: FactRow) => naturalColumn(f) === col;
      const hits = pool.map((x) => x.f).filter((f) => f.value_num !== null && test(f));
      if (!hits.length) {
        cells[col] = null;
        continue;
      }
      // the most confident reading, then the first table (a consolidated statement comes before the parent company's)
      hits.sort((a, b) => b.confidence - a.confidence || a.table_no - b.table_no || a.line - b.line);
      const [best, ...rest] = hits;
      any = true;
      const alternatives = rest
        .filter((r) => r.value_num !== best.value_num || r.scale_factor !== best.scale_factor)
        .slice(0, 3)
        .map((r) => ({ value: r.value_num, text: r.value_text, scale: r.scale, ref: `${r.source_path}#L${r.line}`, label: r.label, period: r.period, table: r.table_title }));
      cells[col] = {
        value: best.value_num,
        text: best.value_text,
        unit: best.unit,
        scale: best.scale,
        scaleFactor: best.scale_factor,
        valueScaled: best.value_num === null ? null : best.value_num * best.scale_factor,
        ref: `${best.source_path}#L${best.line}`,
        label: best.label,
        period: best.period,
        periodKey: best.period_key === 'current' && best.doc_period ? best.doc_period : best.period_key,
        periodSpan: best.period_span,
        table: best.table_title,
        section: best.section,
        parser: best.parser,
        confidence: best.confidence,
        ...(alternatives.length ? { alternatives } : {}),
      };
    }
    if (any) out.push({ subject: g.subject, path: g.path, metric: g.metric, cells });
  }
  out.sort((a, b) => a.subject.localeCompare(b.subject) || a.path.localeCompare(b.path) || metrics.indexOf(a.metric) - metrics.indexOf(b.metric));

  const missing: TableMatrix['missing'] = [];
  const haveSubjects = subjects.length ? subjects : [null];
  for (const s of haveSubjects) {
    for (const m of metrics) if (!out.some((r) => r.metric === m && (s === null || r.subject === s))) missing.push({ subject: s, metric: m });
  }
  const notes = [
    'value is as written in the table; valueScaled = value × scaleFactor, the scale read from the table\'s note (scale: its wording; null when the table states none — then the value is as written, not known to be in units).',
    'periodKey "current" / "prior" are the report\'s own columns (本期 / 上期, 期末 / 期初); a current column of a dated report shows the report\'s period end.',
    'Check a cell at ref (path#Lline) when it matters.',
  ];
  if (truncated) notes.push(`More than ${FACT_CAP} cells matched: narrow subjects, metrics or paths.`);
  return { columns, rows: out, missing, note: notes.join(' ') };
}
