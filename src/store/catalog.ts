import crypto from 'node:crypto';
import {
  assertReadOnlySql, match, NUMBER, PG_DOLLAR_QUOTE as DOLLAR_QUOTE, PG_PARAM as PARAM, PG_QUOTE_CONTINUE as QUOTE_CONTINUE,
  PG_QUOTED_PREFIX as QUOTED_PREFIX, PG_STRING_PREFIX as STRING_PREFIX, PG_WORD as WORD, SPACE,
} from '../datasource/guard.js';
import { Store } from './db.js';

/**
 * The projection database as a queryable source. `knode_query` routes
 * `source: "catalog"` here, so an agent that needs a shape the fixed tools do
 * not expose — "claims per source this month", "entities with one lone
 * supporting document" — can ask SQL instead of paging a tool. The REST route,
 * `datasource query catalog` and the remote API's `POST …/sql` run the same path.
 *
 * Only the `v_*` views are reachable. They exclude fold bookkeeping and
 * default to currently-believed rows, so no query can accidentally read
 * tombstoned knowledge as if it were current, and no schema change to the
 * base tables leaks into agent-written SQL.
 *
 * Two layers hold that line. The text check reads the statement: one SELECT /
 * WITH, and every relation it names is a catalog view or a CTE in scope. It
 * cannot see into a function call — `query_to_xml` takes its query as a
 * string — and the service's own connection may read every workspace's
 * schema, so the database enforces the same rule. Each query runs
 *
 *   - in a READ ONLY transaction that is always rolled back, so neither a
 *     write nor a changed setting (`set_config`) survives the statement;
 *   - under a statement timeout;
 *   - as its workspace's reader role, which cannot log in and may only SELECT
 *     that schema's catalog views. Each schema has its own: one role granted
 *     every workspace's views would let a function call read across them.
 */

export const CATALOG_SOURCE = 'catalog';

const TABLE_FACTS_VIEW = 'every cell of the statement tables in raw/docs (extraction.tableFacts): source_path, line and ref (path#Lline), subject (the report\'s company), doc_period, table_no / table_title, section, label (as written) and label_key (normalized: revenue, accounts_payable …), period (the column header as written), period_key (an ISO date, a year, 2024-Q1, or current / prior / change), period_span (3M, 12M …), value_num (as written) and value_text, unit, scale (its wording as written: 单位：元, in thousands) and scale_factor, value_scaled = value_num × scale_factor, parser (pipe | text | llm), confidence';

export const CATALOG_VIEWS: { name: string; description: string }[] = [
  { name: 'v_documents', description: 'indexed sources: path, root (docs/skills/wiki), kind (source/view), sha, status' },
  { name: 'v_entities', description: 'currently believed entities with mention and evidence counts' },
  { name: 'v_relations', description: 'currently believed typed edges with folded weight' },
  { name: 'v_claims', description: 'currently believed claims with their world-time window and source path (a merged group appears once, as its representative); state columns: attribute (the subject\'s normalized key, e.g. 进度 / 在岗人数), value_num / value_text, unit, effective_at (the date stated, else the document\'s), date_source (stated | document), correction, effective_source_path (the document that dated it); superseded_by IS NULL marks the current value of an attribute' },
  { name: 'v_scopes', description: 'every apply of a source, including disposed ones (applied_at / disposed_at)' },
  { name: 'v_evidence', description: 'per-source support behind each graph row, with its system-time window' },
  { name: 'v_pages', description: 'materialized wiki views and their input signatures' },
  { name: 'v_datasets', description: 'registered live tables and their schemas' },
  { name: 'v_mentions', description: 'entity ↔ chunk ↔ document grounding' },
  { name: 'v_citations', description: 'wiki pages citing raw/docs files: page and file path, predicate (cites / derived_from / tested_by …), how the link was written, the citing page\'s trust' },
  { name: 'v_capabilities', description: 'what can be asked of which source, with schema, cost and freshness' },
  { name: 'v_locators', description: 'how to reach an entity through a capability: parameter and value to bind' },
  { name: 'v_capability_notes', description: 'the written semantic layer: metric definitions, joins, pitfalls' },
  { name: 'v_receipts', description: 'one row per resolve: plan handed out, calls made, ids used' },
  { name: 'v_capability_stats', description: 'per (intent, slot, capability): attempts, successes, usage, latency' },
  { name: 'v_disputes', description: 'open contradictions between claims, and how they were resolved' },
  { name: 'v_worksets', description: 'pinned views for long-running tasks' },
  { name: 'v_entity_links', description: 'entities merged into a canonical one (same_as), with who decided and why' },
  { name: 'v_claim_links', description: 'claims merged into a representative claim (same_as / contains), with who decided, why and how sure' },
  { name: 'v_research_jobs', description: 'deep-research jobs: what page was requested, which agent ran it, outcome' },
  { name: 'v_table_facts', description: TABLE_FACTS_VIEW },
];

/** Views listed only where their feature is on (an empty view is still readable, so SQL written against it never fails). */
export const OPTIONAL_CATALOG_VIEWS: ReadonlySet<string> = new Set(['v_table_facts']);

const VIEW_NAMES = new Set(CATALOG_VIEWS.map((v) => v.name));
const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

/* ------------------------------- the text check ------------------------------- */

interface Token {
  /**
   * `word`: an unquoted name or keyword, lower-cased the way Postgres folds it
   * (ASCII only); `quoted`: a "quoted" name; `literal`: a string, number or $n.
   */
  kind: 'word' | 'quoted' | 'literal' | 'punct';
  text: string;
}

/** A -- comment runs to the next newline or carriage return. */
const LINE_COMMENT = /--[^\n\r]*/y;

/** The index just past the quote that closes the literal opening at `open`, or the end of `sql`. */
function closeQuote(sql: string, open: number, backslashEscapes: boolean): number {
  const quote = sql[open];
  let i = open + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === '\\') i += 2;
    else if (sql[i] !== quote) i++;
    else if (sql[i + 1] === quote) i += 2; // a doubled quote stands for itself
    else return i + 1;
  }
  return sql.length;
}

/**
 * The tokens PostgreSQL reads from `sql`. The shared guard's stripper is
 * dialect-neutral; this one follows Postgres where they differ — a backslash
 * is an ordinary character in '…' (only E'…' escapes with it), $tag$…$tag$
 * quotes a string, block comments nest, a -- comment ends at a carriage return
 * as well as a newline, and a string continued on a later line keeps its
 * escape mode — so no quoting trick can show the check a different statement
 * than the one the database runs.
 */
function lex(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    let m: string | undefined;
    if (SPACE.test(ch)) {
      i++;
    } else if ((m = match(LINE_COMMENT, sql, i))) {
      i += m.length;
    } else if (sql.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      } while (depth > 0 && i < sql.length);
    } else if (ch === "'" || (m = match(STRING_PREFIX, sql, i))) {
      const open = i + (m ? m.length - 1 : 0);
      const backslashEscapes = m?.[0] === 'e' || m?.[0] === 'E';
      let end = closeQuote(sql, open, backslashEscapes);
      let more: string | undefined;
      while ((more = match(QUOTE_CONTINUE, sql, end))) end = closeQuote(sql, end + more.length - 1, backslashEscapes);
      out.push({ kind: 'literal', text: sql.slice(i, end) });
      i = end;
    } else if (ch === '"' || (m = match(QUOTED_PREFIX, sql, i))) {
      const open = i + (m ? m.length - 1 : 0);
      const end = closeQuote(sql, open, false);
      out.push({ kind: 'quoted', text: sql.slice(open + 1, end - 1).replace(/""/g, '"') });
      i = end;
    } else if ((m = match(DOLLAR_QUOTE, sql, i))) {
      const close = sql.indexOf(m, i + m.length);
      const end = close === -1 ? sql.length : close + m.length;
      out.push({ kind: 'literal', text: sql.slice(i, end) });
      i = end;
    } else if ((m = match(PARAM, sql, i) ?? match(NUMBER, sql, i))) {
      out.push({ kind: 'literal', text: m });
      i += m.length;
    } else if ((m = match(WORD, sql, i))) {
      out.push({ kind: 'word', text: m.replace(/[A-Z]/g, (c) => c.toLowerCase()) });
      i += m.length;
    } else {
      out.push({ kind: 'punct', text: ch });
      i++;
    }
  }
  return out;
}

const isWord = (t: Token | undefined, text: string) => t?.kind === 'word' && t.text === text;
const isPunct = (t: Token | undefined, text: string) => t?.kind === 'punct' && t.text === text;

/**
 * For each "(", the index of its ")"; for every token, the "(" that most
 * closely encloses it (-1 at the top level). Throws on unbalanced brackets —
 * the statement is wrapped in a subquery, and a stray ")" would let it close
 * that subquery and go on as part of the outer query.
 */
function nesting(toks: Token[]): { close: number[]; enclosing: number[] } {
  const close: number[] = [];
  const enclosing: number[] = [];
  const open: number[] = [];
  const parens: number[] = [];
  toks.forEach((t, i) => {
    enclosing[i] = parens.length ? parens[parens.length - 1] : -1;
    if (t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[') {
      open.push(i);
      if (t.text === '(') parens.push(i);
    } else if (t.text === ')' || t.text === ']') {
      const o = open.pop();
      if (o === undefined || toks[o].text !== (t.text === ')' ? '(' : '[')) throw new Error('catalog: unbalanced parentheses');
      if (t.text === ')') close[parens.pop()!] = i;
    }
  });
  if (open.length) throw new Error('catalog: unbalanced parentheses');
  return { close, enclosing };
}

interface CteScope {
  name: string;
  /** The name means the CTE strictly between these two token indexes. */
  from: number;
  to: number;
}

/**
 * Where each name a WITH clause binds means its CTE: to the end of the query
 * the WITH belongs to, starting after the CTE's own body — a plain WITH cannot
 * see itself, so in `WITH chunks AS (SELECT * FROM chunks)` the inner name is
 * the table — or, for WITH RECURSIVE, from the WITH on.
 */
function cteScopes(toks: Token[], close: number[], enclosing: number[]): CteScope[] {
  const scopes: CteScope[] = [];
  for (let w = 0; w < toks.length; w++) {
    if (!isWord(toks[w], 'with')) continue;
    const end = enclosing[w] === -1 ? toks.length : close[enclosing[w]];
    const recursive = isWord(toks[w + 1], 'recursive');
    let p = recursive ? w + 2 : w + 1;
    // name [(columns)] AS [NOT] [MATERIALIZED] (body), …
    for (;;) {
      if (toks[p]?.kind !== 'word') break;
      let q = isPunct(toks[p + 1], '(') ? close[p + 1] + 1 : p + 1;
      if (!isWord(toks[q], 'as')) break;
      q++;
      if (isWord(toks[q], 'not')) q++;
      if (isWord(toks[q], 'materialized')) q++;
      if (!isPunct(toks[q], '(')) break;
      scopes.push({ name: toks[p].text, from: recursive ? w : close[q], to: end });
      q = close[q] + 1;
      // a recursive body may be followed by SEARCH … SET col and CYCLE … USING col
      if (isWord(toks[q], 'search')) {
        while (q < end && !isWord(toks[q], 'set')) q++;
        q += 2;
      }
      if (isWord(toks[q], 'cycle')) {
        while (q < end && !isWord(toks[q], 'using')) q++;
        q += 2;
      }
      if (!isPunct(toks[q], ',')) break;
      p = q + 1;
    }
  }
  return scopes;
}

/** Words that end a FROM list at their own level. */
const AFTER_FROM = new Set(['where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch', 'for', 'union', 'intersect', 'except']);

function notReadable(name: string): Error {
  return new Error(`catalog: "${name}" is not readable — the catalog exposes only ${[...VIEW_NAMES].join(', ')}`);
}

/**
 * Throw unless every relation the statement reads is one of the catalog views
 * or a CTE in scope. A relation is read wherever Postgres takes one: after
 * FROM, JOIN, TABLE or a comma in a FROM list (LATERAL and ONLY in between),
 * and first inside a parenthesis that opens a FROM item. Anything else in
 * those places — a schema-qualified or quoted name, a function — is refused.
 */
export function assertCatalogTables(sql: string): void {
  const toks = lex(sql);
  const { close, enclosing } = nesting(toks);
  const ctes = cteScopes(toks, close, enclosing);
  const readable = (name: string, at: number) =>
    VIEW_NAMES.has(name) || ctes.some((c) => c.name === name && c.from < at && at < c.to);

  // one frame per parenthesis: has this level's SELECT been seen, is its FROM list open, how deep in [ ] is it
  const frames = [{ select: false, from: false, brackets: 0 }];
  let expectRelation = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const frame = frames[frames.length - 1];
    if (expectRelation) {
      if (t.kind === 'quoted') throw notReadable(t.text);
      if (t.kind === 'word') {
        if (t.text === 'only' || t.text === 'lateral') continue;
        const query = t.text === 'select' || t.text === 'with' || t.text === 'table' || (t.text === 'values' && isPunct(toks[i + 1], '('));
        if (!query) {
          let name = t.text;
          while (isPunct(toks[i + 1], '.') && toks[i + 2]) {
            name += `.${toks[i + 2].text}`;
            i += 2;
          }
          if (name.includes('.') || !readable(name, i)) throw notReadable(name);
          expectRelation = false;
          continue;
        }
      }
      // "(" opens a FROM item, so the expectation carries into it
      if (!isPunct(t, '(')) expectRelation = false;
    }
    if (t.kind === 'punct') {
      if (t.text === '(') frames.push({ select: false, from: expectRelation, brackets: 0 });
      else if (t.text === ')') frames.pop();
      else if (t.text === '[') frame.brackets++;
      else if (t.text === ']') frame.brackets--;
      else if (t.text === ',') expectRelation = frame.from && frame.brackets === 0;
      else if (t.text === ';') throw new Error('catalog: one statement only');
      continue;
    }
    if (t.kind !== 'word') continue;
    if (t.text === 'select') {
      frame.select = true;
      frame.from = false;
    } else if (t.text === 'from') {
      // EXTRACT(y FROM d) has no SELECT at its level; IS [NOT] DISTINCT FROM compares
      const distinct = isWord(toks[i - 1], 'distinct') && (isWord(toks[i - 2], 'is') || (isWord(toks[i - 2], 'not') && isWord(toks[i - 3], 'is')));
      if (frame.select && !distinct) frame.from = expectRelation = true;
    } else if (t.text === 'join' || t.text === 'table') {
      expectRelation = true;
    } else if (t.text === 'values' || AFTER_FROM.has(t.text)) {
      frame.from = false;
    }
  }
}

export interface CatalogResult {
  source: typeof CATALOG_SOURCE;
  /** System time the rows were read at — the catalog is always read live. */
  asOf: string;
  rowCount: number;
  /** The row cap was reached; narrow the query rather than assuming this is everything. */
  truncated: boolean;
  rows: Record<string, unknown>[];
  elapsedMs: number;
}

/**
 * The statement a catalog query may run, or an error: one read-only SELECT /
 * WITH over the catalog views only. Returned trimmed of a trailing semicolon.
 */
export function validateCatalogSql(sql: string): string {
  assertReadOnlySql(sql);
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const first = lex(trimmed).find((t) => t.kind === 'word')?.text;
  if (first !== 'select' && first !== 'with') {
    throw new Error(`catalog: only SELECT / WITH statements are supported (got "${first ?? '?'}")`);
  }
  assertCatalogTables(trimmed);
  return trimmed;
}

/** Rows a catalog query may return. */
export function catalogRowCap(maxRows?: number): number {
  return Math.min(Math.max(maxRows ?? DEFAULT_MAX_ROWS, 1), HARD_MAX_ROWS);
}

/* ------------------------------ the database's part ----------------------------- */

/**
 * The role a schema's catalog SQL runs as. Derived from the schema, so every
 * workspace has its own; hashed, so it fits Postgres's 63-byte names.
 */
export function catalogReaderRole(schema: string): string {
  return `knode_reader_${crypto.createHash('sha1').update(schema).digest('hex').slice(0, 16)}`;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Readers set up per open store; a new store (a reopen, a rebuild) grants again. */
const readers = new WeakMap<Store, Promise<string>>();

/** This store's reader role: created once per cluster, granted this schema's views once per store. */
function readerRole(store: Store): Promise<string> {
  let ready = readers.get(store);
  if (!ready) {
    ready = setUpReader(store);
    readers.set(store, ready);
    ready.catch(() => readers.delete(store));
  }
  return ready;
}

async function setUpReader(store: Store): Promise<string> {
  const [{ schema }] = await store.query<{ schema: string }>(`SELECT current_schema() AS schema`);
  const role = catalogReaderRole(schema);
  const exists = async () =>
    (await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [role]))[0].n > 0;
  if (!(await exists())) {
    try {
      await store.exec(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    } catch (err) {
      // a concurrent opener may have created it first
      if (!(await exists())) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`catalog: cannot create the role catalog SQL runs as (${reason}) — the database user needs CREATEROLE`);
      }
    }
  }
  const quoted = quoteIdent(schema);
  await store.exec(`GRANT USAGE ON SCHEMA ${quoted} TO ${role}`);
  await store.exec(`GRANT SELECT ON ${[...VIEW_NAMES].map((v) => `${quoted}.${quoteIdent(v)}`).join(', ')} TO ${role}`);
  return role;
}

class RolledBack extends Error {
  constructor(readonly rows: Record<string, unknown>[]) {
    super('rolled back');
  }
}

/**
 * Run one read-only SELECT against the catalog views. The statement is wrapped
 * in an outer LIMIT, so a query without one cannot return the whole graph.
 */
export async function catalogQuery(
  store: Store,
  sql: string,
  opts: { maxRows?: number; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  const statement = validateCatalogSql(sql);
  const maxRows = catalogRowCap(opts.maxRows);
  const timeoutMs = Math.min(Math.max(1_000, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)), MAX_TIMEOUT_MS);
  const role = await readerRole(store);
  const started = Date.now();
  let rows: Record<string, unknown>[] = [];
  try {
    await store.tx(async (q) => {
      await q.query('SET TRANSACTION READ ONLY');
      await q.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await q.query(`SET LOCAL ROLE ${role}`);
      // the newline ends a trailing -- comment before the wrapper's own text
      const result = await q.query<Record<string, unknown>>(`SELECT * FROM (${statement}\n) AS catalog_query LIMIT $1`, [maxRows + 1]);
      throw new RolledBack(result);
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    rows = err.rows;
  }
  return {
    source: CATALOG_SOURCE,
    asOf: new Date().toISOString(),
    rowCount: Math.min(rows.length, maxRows),
    truncated: rows.length > maxRows,
    rows: rows.slice(0, maxRows),
    elapsedMs: Date.now() - started,
  };
}
