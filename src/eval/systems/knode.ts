import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection, type SagSearchConfig } from '../../config.js';
import { AppContext, createContext } from '../../context.js';
import { runDocumentPass } from '../../ingest/background.js';
import { sync } from '../../ingest/sync.js';
import { parseFrontmatter } from '../../markdown.js';
import { ask, ASK_CONTEXT_CHARS, type AskResult } from '../../search/ask.js';
import { search } from '../../search/search.js';
import { toDateString } from '../../store/temporal.js';
import type { ChatMessage, LlmClient } from '../../llm/client.js';
import { generateWiki } from '../../wiki/generate.js';
import { refreshNavigationIfChanged } from '../../wiki/navigation.js';
import { reconcileViews, type ReconcileStats } from '../../wiki/pages.js';
import { refineWiki } from '../../wiki/refine.js';
import { isolatedCopy, runAgent } from '../agent.js';
import { formatTag } from '../meter.js';
import { currentRemote } from '../placement.js';
import { listFiles } from '../pack.js';
import { citationsIn } from '../prompts.js';
import type { Citation, KnowledgeUnit } from '../types.js';
import { AGENT_BRIEF, armBrief } from './agents.js';
import { catalogGuide } from '../../mcp/catalog-guide.js';
import { questionKindGuide } from '../../mcp/question-kinds.js';
import { WIKI_SOURCES_HAS, wikiWithSources } from './llm-wiki.js';
import { recordAgent, shimClient, SystemEnv, SystemUnderTest } from './types.js';
import { evalTempDir } from '../tmp.js';
import { startToolHost, ToolHost } from '../toolhost.js';
import { cloneSchema, describeDatabase, dropEvalWorkspace, evalDatabase, markSchema, storableDatabase } from '../database.js';
import { assertNoLeak } from '../leak.js';
import { claimWriter, EvalRootPlacement, EvaluationInfo, newEvalManifest, placeEvalWorkspace, readEvalManifest, readWorkspacePointer, releaseWriter, updateEvaluation, writeEvalManifest, writeWorkspacePointer } from '../root.js';

/**
 * knode-os as a system under test (docs/design/23 §3): a fresh workspace per
 * pack with its index on the product's backend — a schema of its own in the
 * evaluation database on PostgreSQL, an embedded database on PGlite
 * (src/eval/database.ts, docs/design/31 D1) — every model route and the embedder
 * pointed at the run's shim (so its build is metered like everyone else's),
 * built the way `serve` builds — sync, then document passes until the queue
 * and the summaries are done, then wiki generation and refinement.
 *
 * One build, five ways to use it: `knode-ask` (the cited-answer pipeline),
 * `knode-sag` (multi-hop retrieval, scored on retrieval), `agent-knode` (the
 * same Codex agent as the grep baseline, given knode's MCP retrieval tools
 * instead of the files), `agent-knode-wiki` (that agent reading the
 * generated wiki) and `agent-knode-wiki-sources` (reading the wiki with the
 * sources beside it, the wiki as a navigation layer). The run opens the
 * index once per build and everything shares it: answers, retrieval probes,
 * and the agent sessions' tools, which the run serves itself
 * (src/eval/toolhost.ts, docs/design/31 D4).
 */

interface KnodeState {
  ws: string;
  /** Where the run keeps its builds (docs/design/35): absent for a run made before, whose build is `<workDir>/ws`. */
  placement: EvalRootPlacement | null;
  /** The run's own directory for this pack and group (`workspace.json` is kept there). */
  workDir: string;
  /**
   * The open context, held as the promise of it: answers that start together
   * share one open instead of each opening the index (docs/design/31 F2 — on
   * PGlite several instances on one directory stalled the process).
   */
  ctx: Promise<AppContext> | null;
  /** A close in flight: the next open waits for it. */
  closing: Promise<void> | null;
  /** The build's tool hosts for agent sessions, one per tool set (agent-knode's, agent-knode-full's), each started with its first session. */
  hosts: Map<string, Promise<ToolHost>>;
  /** wiki page path → the corpus documents it was generated from. */
  pageSources: Map<string, string[]>;
}

const states = new Map<string, KnodeState>();

/**
 * Tools an agent may use against the knowledge base — retrieval and reading
 * only, nothing that calls a model or writes knowledge. `knode_resolve` is the
 * call the server's own instructions name for "who or what is X" and
 * `knode_survey` the one they name for orientation: an agent told to start
 * with tools it was not given searched and grepped instead, 11 calls a
 * question against grep's 5. `knode_query` (read-only SQL; the agent gets the
 * catalog source only, there being no live datasource in an eval workspace)
 * answers lists, counts and date ranges in one call: without it, in the
 * 2026-11 corpus run, the agent read raw documents one per call, 8.1 calls and
 * 49.6k weighted tokens a question on the reports pack against grep's 3.7 and
 * 30.5k (docs/design/30).
 */
export const KNODE_AGENT_TOOLS = ['knode_resolve', 'knode_survey', 'knode_search', 'knode_graph_search', 'knode_read', 'knode_ls', 'knode_grep', 'knode_claims', 'knode_query'];

/**
 * The knode agent's brief: the grep baseline's (same opening, same budget)
 * with the tools routed by the kind of question (`questionKindGuide`: the
 * kinds the 10× reports run showed to matter, 2026-11-15), and the catalog's
 * schema, which an agent cannot guess. The shared brief's "search and read the files
 * with shell commands" does not apply here: there are no files to run them on.
 */
export function knodeAgentBrief(): string {
  return `You are answering a question about a document collection. The documents are not in the current directory: they are in a knowledge base you reach through the knode MCP tools (source documents under raw/docs/, generated pages under wiki/). Work read-only. You have a budget of about 20 tool calls; answer before you run out — most questions need 2 to 5. Do not use the network.

${questionKindGuide()}

${catalogGuide()}`;
}

const STAGES = ['extract', 'summary', 'kb-judge', 'document', 'translate'] as const;

/** Document-pass settings of the workspaces under test, recorded in every build's notes. */
export const KNODE_EVAL_CONCURRENCY = Number(process.env.KNODE_EVAL_KNODE_CONCURRENCY ?? 6);
export const KNODE_EVAL_BATCH = Number(process.env.KNODE_EVAL_KNODE_BATCH ?? 16);

/**
 * A build's document-pass settings: as wide as the slots online for its model
 * calls when the build starts (docs/design/32 §3), and never narrower than
 * `KNODE_EVAL_CONCURRENCY` — calls beyond the slots wait in the queue, and a
 * build on the six slots an old command line has keeps the batches it always
 * had, so its reply cache still answers it. A pass's batch grows in proportion
 * to the width, so a pass has enough calls to fill the slots.
 */
export function evalPassSettings(): { concurrency: number; batchSize: number } {
  const slots = currentRemote<{ callSlots(): number }>()?.callSlots() ?? 0;
  if (slots <= KNODE_EVAL_CONCURRENCY) return { concurrency: KNODE_EVAL_CONCURRENCY, batchSize: KNODE_EVAL_BATCH };
  const concurrency = slots;
  return { concurrency, batchSize: Math.max(KNODE_EVAL_BATCH, Math.ceil((concurrency * KNODE_EVAL_BATCH) / Math.max(1, KNODE_EVAL_CONCURRENCY))) };
}

/**
 * Where a run's build of a pack is: what `work/<pack>/<group>/workspace.json`
 * names, else — in an evaluation root (docs/design/35 §3) — the folder the run
 * gets there, else, for a run made before builds lived in a root, `<workDir>/ws`.
 */
function workspaceOf(env: SystemEnv): string {
  const pointer = readWorkspacePointer(env.workDir);
  if (pointer) return pointer.dir;
  if (!env.evalRoot) return path.join(env.workDir, 'ws');
  return placeEvalWorkspace(env.evalRoot, env.pack.manifest.id, path.basename(env.workDir));
}

/** One state per working directory: a run's pack, never another run's of the same pack. */
function stateFor(env: SystemEnv): KnodeState {
  let s = states.get(env.workDir);
  if (!s) {
    s = { ws: workspaceOf(env), placement: env.evalRoot ?? null, workDir: env.workDir, ctx: null, closing: null, hosts: new Map(), pageSources: new Map() };
    states.set(env.workDir, s);
  }
  return s;
}

/** A build in the root that another run's manifest names is not this run's to open or change. */
function assertOwnWorkspace(s: KnodeState): void {
  if (!s.placement) return;
  const m = readEvalManifest(s.ws);
  if (!m) throw new Error(`${s.ws} has no evaluation manifest: not a build of this run`);
  if (path.resolve(m.evaluation.run) !== path.resolve(s.placement.run)) {
    throw new Error(`the workspace ${s.ws} is the build of ${m.evaluation.run}, not of this run (${s.placement.run})`);
  }
}

/** The manifest's state, in the root layout only. */
function setState(s: KnodeState, change: (e: EvaluationInfo) => EvaluationInfo): void {
  if (s.placement) updateEvaluation(s.ws, change);
}

function withoutError(e: EvaluationInfo): EvaluationInfo {
  const { error: _error, ...rest } = e;
  return rest as EvaluationInfo;
}

/**
 * The workspace config: the run's evaluation database (PGlite in the workspace, or a schema of its own on
 * PostgreSQL — never a live workspace's database), the shim for every stage and for embeddings, nothing that
 * reaches out on its own.
 */
export function evalWorkspaceConfig(env: Pick<SystemEnv, 'shim' | 'pack'> & Partial<Pick<SystemEnv, 'database'>>, system = 'knode'): KnodeConfig {
  const base = defaultConfig();
  const connection = (stage: string): LlmConnection => ({
    id: `eval-${stage}`,
    label: `eval ${stage}`,
    provider: 'openai',
    baseUrl: env.shim.baseUrl,
    apiKey: formatTag({ system, stage }),
    protocol: 'chat',
    model: `codex@${stage}`,
    cliPath: '',
    effort: 'default',
    cliTimeoutMs: 900_000,
  });
  const route = (stage: string) => ({ ...defaultRoutedLlmConfig(), use: `eval-${stage}` });
  const embedder = env.shim.embedder;
  const pass = evalPassSettings();
  return {
    ...base,
    database: storableDatabase(env.database ?? evalDatabase(base.database)),
    embedding: embedder
      ? { provider: 'openai', baseUrl: env.shim.baseUrl, apiKey: formatTag({ system, stage: 'embed' }), model: embedder.model, dimensions: embedder.dimensions, batchSize: 16, sendDimensions: false }
      : base.embedding,
    embeddingProviders: [],
    connections: STAGES.map(connection),
    llmUse: 'eval-kb-judge',
    extraction: {
      ...base.extraction,
      entityLlm: route('extract'),
      documentLlm: route('document'),
      summaryLlm: route('summary'),
      judgeLlm: route('kb-judge'),
      translateLlm: route('translate'),
      workers: [],
      // a benchmark build may use more of the shim's slots than the product default (3 calls, 8 documents a pass),
      // and the remote workers' beside them
      ...pass,
    },
    // the reviews inside a build call the Judge route themselves, one call at a time by default; a build's
    // calls go through the shim (and to the workers), so they go out as wide as its extraction does
    review: { ...base.review, directConcurrency: pass.concurrency },
  } as KnodeConfig;
}

/** The workspace's context, opened once however many callers ask at the same time (single-flight). */
function open(s: KnodeState): Promise<AppContext> {
  if (s.ctx) return s.ctx;
  const closing = s.closing;
  const opening = (async () => {
    if (closing) await closing;
    // the run holds its build while it has it open: the viewer lists it and does not open it (docs/design/35 §4)
    if (s.placement) claimWriter(s.ws);
    const ctx = await createContext(s.ws);
    // the index as built, for every answer: the store finishes its own upkeep in the background after it opens, and
    // until the substring indexes are marked ready the keyword channel takes another path that scores differently
    // (on PostgreSQL the first answers after an open did; on PGlite the upkeep ran first anyway)
    await Promise.all([ctx.store.indexing, ctx.store.retype]);
    return ctx;
  })();
  s.ctx = opening;
  // a failed open is not kept: the next caller tries again
  opening.catch(() => {
    if (s.ctx === opening) s.ctx = null;
  });
  return opening;
}

/**
 * The build's tool host for one tool set (single-flight): every agent session
 * of the build with those tools calls them on the one open index. A set has a
 * host of its own, so a session can call only the tools its arm has, here and
 * on a worker (serve's route passes a session's own tools only).
 */
function toolHost(s: KnodeState, tools: string[]): Promise<ToolHost> {
  const key = [...tools].sort().join(',');
  const had = s.hosts.get(key);
  if (had) return had;
  const starting = startToolHost(() => open(s), tools);
  s.hosts.set(key, starting);
  starting.catch(() => {
    if (s.hosts.get(key) === starting) s.hosts.delete(key);
  });
  return starting;
}

/** Close the tool host, then the context once an open still in flight has finished; an open after this waits for the close. */
async function close(s: KnodeState): Promise<void> {
  const hosts = [...s.hosts.values()];
  s.hosts.clear();
  for (const host of hosts) await (await host.catch(() => null))?.close();
  const opened = s.ctx;
  if (!opened) return s.closing ?? undefined;
  s.ctx = null;
  const closing = (async () => {
    const ctx = await opened.catch(() => null);
    if (!ctx) return;
    await ctx.datasources.closeAll();
    await ctx.store.close();
  })();
  s.closing = closing;
  try {
    await closing;
  } finally {
    if (s.closing === closing) s.closing = null;
  }
}

/** What a build's index is and where, beside its workspace: what a reused copy of the workspace is reopened by. */
interface IndexRecord {
  kind: string;
  /** PostgreSQL: the build's schema in the evaluation database. */
  schema?: string;
  /** The workspace the index belongs to: a copy elsewhere (a reused build) does not own it. */
  workspace: string;
}

const indexRecordFile = (s: KnodeState) => path.join(s.ws, '.knode', 'eval-index.json');

function readIndexRecord(s: KnodeState): IndexRecord | null {
  try {
    return JSON.parse(fs.readFileSync(indexRecordFile(s), 'utf8')) as IndexRecord;
  } catch {
    return null;
  }
}

/** Note the build's index (and on PostgreSQL label its schema with the workspace, for `eval drop --orphaned`). */
async function recordIndex(s: KnodeState, ctx: AppContext): Promise<IndexRecord> {
  const cfg = ctx.config.database;
  const rec: IndexRecord = { kind: cfg.kind, workspace: path.resolve(s.ws), ...(cfg.kind === 'postgres' ? { schema: await markSchema(cfg, s.ws) } : {}) };
  fs.writeFileSync(indexRecordFile(s), JSON.stringify(rec, null, 2));
  pointTo(s, rec);
  return rec;
}

/** The run's record of where its build is (`work/<pack>/<group>/workspace.json`), in the root layout. */
function pointTo(s: KnodeState, rec: Pick<IndexRecord, 'kind' | 'schema'>): void {
  if (s.placement) writeWorkspacePointer(s.workDir, { dir: path.resolve(s.ws), kind: rec.kind, ...(rec.schema ? { schema: rec.schema } : {}) });
}

/**
 * A reused build's index, made this workspace's own: its work directory was copied, and with it an
 * embedded PGlite index; a PostgreSQL schema stays where it is, so it is cloned into this workspace's
 * (update batches change an index in place — two runs must not share one). Throws when it cannot be,
 * and the run builds afresh.
 */
async function adoptIndex(s: KnodeState, env: SystemEnv, cfg: KnodeConfig): Promise<void> {
  const rec = readIndexRecord(s);
  const kind = cfg.database.kind;
  if (kind !== 'postgres') {
    if (rec && rec.kind !== kind) throw new Error(`the build's index is on ${rec.kind}; this run keeps its indexes on ${kind}`);
    pointTo(s, { kind });
    return;
  }
  if (!rec?.schema || rec.kind !== 'postgres') throw new Error(`the build's index is on ${rec?.kind ?? 'pglite (it has no index record)'}; this run keeps its indexes on ${describeDatabase(cfg.database)}`);
  if (rec.workspace === path.resolve(s.ws)) return;
  const t0 = Date.now();
  const cloned = await cloneSchema(cfg.database, rec.schema, s.ws, cfg.embedding.dimensions);
  fs.writeFileSync(indexRecordFile(s), JSON.stringify({ kind, schema: cloned.schema, workspace: path.resolve(s.ws) } satisfies IndexRecord, null, 2));
  pointTo(s, { kind, schema: cloned.schema });
  env.log(`knode: cloned schema ${rec.schema} into ${cloned.schema} (${cloned.tables} tables, ${cloned.rows} rows, ${Date.now() - t0} ms)`);
}

/** `raw/docs/<x>` → corpus path `<x>`; a generated page → the documents it was made from. */
function toCorpus(s: KnodeState, p: string): string[] {
  if (p.startsWith('raw/docs/')) return [p.slice('raw/docs/'.length)];
  return s.pageSources.get(p) ?? [];
}

/**
 * The document a search hit stands for when ranking documents: a source chunk's
 * own, a summary page's one source, and none for a page made from several (an
 * entity page cites every document that mentions the entity). Counting such a
 * page as all of them put a dozen documents the search never ranked ahead of
 * the ones it did: on the pilot's MuSiQue questions knode's vector channel
 * scored 0.47 recall@5 that way and 0.60 by its source chunks, against 0.58
 * for the RAG baseline on the same vectors. (`knode-sag`'s ranking; `knode-ask`
 * is scored on what it sent its model, `sentDocuments`.)
 */
function rankedDocument(s: KnodeState, p: string): string[] {
  const docs = toCorpus(s, p);
  return p.startsWith('raw/docs/') || docs.length === 1 ? docs : [];
}

const CITED_PATH = /raw\/docs\/[^\s)\]'"`，。]+/g;
/** The generated indexes, the log and the overview: pages that list documents and pages without saying what they hold. */
const NAVIGATION_PAGE = /(^|\/)(index|log|overview)\.md$/;

/**
 * The corpus documents one passage puts before a model, in the order it names
 * them. A source chunk is its document. A chunk of a generated page is the
 * documents the text sent cites by path (a page's lines end in the document
 * each was read from; the text is cut where the prompt cuts it), and a page
 * made from one document — a summary, an entity only one document mentions —
 * is that document whatever its chunk cites. A page chunk that names no
 * document counts for none: the model was shown nothing it could trace. Nor
 * does a navigation page (an index, the log, the overview): it lists
 * documents by title and path and says nothing of what they hold.
 *
 * Neither of the two rules this replaces held for `knode-ask` on the 2026-11
 * 10× reports run: a page counted for no document left the ranking empty for
 * 27 of 232 questions and shorter than five for 117, and a page counted for
 * every document it cites anywhere put 606 documents in an answer's
 * `retrieved` (and 72 in its citations) when the model had been shown a dozen
 * passages. `known`, when given, is the corpus: a path cut by the prompt's
 * limit, or followed by punctuation, is no document.
 */
export function passageDocuments(pagePath: string, content: string, pageSources: ReadonlyMap<string, string[]>, known?: ReadonlySet<string>): string[] {
  if (pagePath.startsWith('raw/docs/')) return [pagePath.slice('raw/docs/'.length)];
  if (NAVIGATION_PAGE.test(pagePath)) return [];
  const made = pageSources.get(pagePath) ?? [];
  const cited = [...content.slice(0, ASK_CONTEXT_CHARS).matchAll(CITED_PATH)].flatMap((m) => {
    const doc = m[0].slice('raw/docs/'.length);
    if (!known || known.has(doc)) return [doc];
    const trimmed = doc.replace(/[.,;:!?。，；：、）)]+$/, '');
    return known.has(trimmed) ? [trimmed] : [];
  });
  return [...new Set([...(made.length === 1 ? made : []), ...cited])];
}

/**
 * The documents `ask` put before its model, in the prompt's order: its
 * passages, then the facts it listed, each by the one source the prompt shows
 * for it. What `knode-ask`'s ranking and an answer's `retrieved` are.
 */
function sentDocuments(s: KnodeState, res: Pick<AskResult, 'contexts' | 'facts'>, known: ReadonlySet<string>): string[] {
  return [...new Set([
    ...res.contexts.flatMap((c) => passageDocuments(c.path, c.content, s.pageSources, known)),
    ...res.facts.flatMap((f) => (f.path ? passageDocuments(f.path, '', s.pageSources, known) : [])),
  ])];
}

/** The documents an answer cited: each `[n]` by the passage or fact it numbers, as `sentDocuments` counts them. */
function citedDocuments(s: KnodeState, res: AskResult, known: ReadonlySet<string>): string[] {
  return res.citations.flatMap((c) => {
    const passage = res.contexts[c.ref - 1];
    return passage ? passageDocuments(passage.path, passage.content, s.pageSources, known) : passageDocuments(c.path, '', s.pageSources, known);
  });
}

/** `client` with no model behind it: `ask` then stops at what it would have sent one (a retrieval probe). */
function withoutModel(client: LlmClient): LlmClient {
  return Object.defineProperty(Object.create(client) as LlmClient, 'enabled', { value: false });
}

function readPageSources(s: KnodeState): void {
  s.pageSources.clear();
  const wiki = path.join(s.ws, 'wiki');
  for (const rel of listFiles(wiki).filter((f) => f.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(wiki, rel), 'utf8');
    const fm = parseFrontmatter(raw).frontmatter;
    const declared = [fm.source, ...(((fm.knode as { inputs?: { documents?: unknown[] } } | undefined)?.inputs?.documents) ?? [])]
      .filter((x): x is string => typeof x === 'string');
    const cited = [...raw.matchAll(/raw\/docs\/[^\s)\]'"`，。]+/g)].map((m) => m[0]);
    const docs = [...new Set([...declared, ...cited].filter((p) => p.startsWith('raw/docs/')).map((p) => p.slice('raw/docs/'.length)))];
    s.pageSources.set(`wiki/${rel}`, docs);
  }
}

/**
 * A build in progress, beside its index (`.knode/eval-build.json`): what it is
 * a build of, and the phases it has finished. A run that stopped or failed
 * mid-build (the 10× build lost a connection after five hours) continues from
 * it when it is resumed: the documents synced, extracted and embedded stay,
 * the extraction queue holds what is left, and finished phases are not done
 * again.
 */
interface BuildProgress {
  /** The staged corpus (paths and sizes), the pack version and the models: anything else is another build. */
  fingerprint: string;
  startedAt: string;
  /** Attempts so far, this one among them. */
  attempts: number;
  done: ('synced' | 'extracted' | 'wiki' | 'refined')[];
  wikiPages?: number;
  refined?: unknown;
}

const progressFile = (s: KnodeState) => path.join(s.ws, '.knode', 'eval-build.json');

function readProgress(s: KnodeState): BuildProgress | null {
  try {
    return JSON.parse(fs.readFileSync(progressFile(s), 'utf8')) as BuildProgress;
  } catch {
    return null;
  }
}

function writeProgress(s: KnodeState, p: BuildProgress): void {
  fs.mkdirSync(path.dirname(progressFile(s)), { recursive: true });
  fs.writeFileSync(progressFile(s), JSON.stringify(p, null, 2));
}

export function buildFingerprint(env: Pick<SystemEnv, 'pack' | 'staged' | 'models'>): string {
  const docs = env.staged.docs.map((d) => {
    let size = -1;
    try {
      size = fs.statSync(path.join(env.staged.dir, d.path)).size;
    } catch {
      /* not staged as a file */
    }
    return [d.path, size];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha1').update(JSON.stringify([env.pack.manifest.id, env.pack.manifest.version, docs, env.models ?? null])).digest('hex');
}

/**
 * The progress an earlier attempt left in this workspace, when this build can
 * continue from it: the same corpus and models, the workspace's config there,
 * and its index this workspace's own (a copy of another run's build is never
 * continued: its index is not this run's).
 */
function resumableProgress(s: KnodeState, env: SystemEnv): BuildProgress | null {
  const prior = readProgress(s);
  if (!prior || prior.fingerprint !== buildFingerprint(env)) return null;
  if (!fs.existsSync(path.join(s.ws, 'knode.config.json'))) return null;
  const index = readIndexRecord(s);
  return index && index.workspace === path.resolve(s.ws) ? prior : null;
}

async function drain(ctx: AppContext, env: SystemEnv): Promise<Record<string, number>> {
  const totals = { passes: 0, processed: 0, failed: 0, calls: 0, callsFailed: 0, summaries: 0 };
  for (let i = 0; i < 2000; i++) {
    await env.quota.wait();
    const pass = await runDocumentPass(ctx);
    totals.passes++;
    totals.processed += pass.processed;
    totals.failed += pass.failed;
    totals.calls += pass.calls;
    totals.callsFailed += pass.callsFailed;
    totals.summaries += pass.summaries.length;
    if (i % 10 === 0) env.log(`knode pass ${i + 1}: processed ${totals.processed}, queued ${pass.queued}, summaries ${totals.summaries}`);
    if ((pass.queued === 0 || !pass.progressed) && pass.summaries.length === 0) break;
  }
  return totals;
}

/**
 * What `serve` does after a batch of new documents is extracted, past what a
 * document pass does itself: its review round (src/labeling/followup.ts) runs
 * the audits and `afterExtraction`, as `runDocumentPass` does, and then brings
 * every page those steps or the new claims dirtied up to date without a model
 * (`reconcileViews`, llm off) and refreshes the navigation. A pass leaves that
 * to the next sync, and an update batch's next sync was the next batch's
 * first step: without this a batch's pages were re-rendered only when the
 * following batch arrived — its questions read the pages as of the batch
 * before, beside the new document — and the last batch's never were (in the
 * 2026-11 campaign 174 entity pages and a timeline of the 10× reports build
 * were left dirty). Nothing more than serve does: no model
 * pass over the wiki (`wiki generate`) and no refine, which serve runs only on
 * its nightly schedule.
 */
async function reviewLikeServe(ctx: AppContext, env: SystemEnv): Promise<ReconcileStats> {
  const views = await reconcileViews(ctx, { actor: 'tier1', llm: false });
  try {
    await refreshNavigationIfChanged(ctx, { actor: 'tier1' });
  } catch (err) {
    env.log(`knode update: navigation failed: ${err instanceof Error ? err.message : err}`);
  }
  env.log(`knode update: ${views.regenerated} pages regenerated, ${views.archived} archived, ${views.deferred} left for a model pass`);
  return views;
}

function knodeSystem(id: string, label: string, kind: SystemUnderTest['kind'], answers: boolean, extra: Partial<SystemUnderTest>): SystemUnderTest {
  return {
    id,
    label,
    group: 'knode',
    kind,
    answers,
    resumable(env) {
      return resumableProgress(stateFor(env), env) !== null;
    },
    async build(env) {
      const s = stateFor(env);
      try {
        const built = await buildWorkspace(s, env);
        setState(s, (e) => ({ ...withoutError(e), state: 'built' }));
        return built;
      } catch (err) {
        // the build's folder says it failed, for the viewer's list (a resume continues it, or builds it again)
        if (s.placement && readEvalManifest(s.ws)) setState(s, (e) => ({ ...e, state: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }));
        throw err;
      }
    },
    async reopen(env) {
      const s = stateFor(env);
      if (!fs.existsSync(path.join(s.ws, 'knode.config.json'))) throw new Error(`no knode workspace to reopen at ${s.ws}`);
      assertOwnWorkspace(s);
      // the shim's port changed since the build: repoint the workspace at this run's shim (and its database)
      const config = evalWorkspaceConfig(env);
      fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(config, null, 2));
      await adoptIndex(s, env, config);
      readPageSources(s);
    },
    async release(env) {
      await close(stateFor(env));
    },
    async finish(env) {
      const s = stateFor(env);
      await close(s);
      // held from the first open to here: between a pack's answers and its batches the run reopens it, and a viewer
      // that opened it meanwhile would hold its embedded index
      if (s.placement && fs.existsSync(s.ws)) releaseWriter(s.ws);
    },
    ...extra,
  };
}

/** Build (or continue building) a run's knode workspace: in its evaluation root, or in the run directory for a run made before. */
async function buildWorkspace(s: KnodeState, env: SystemEnv): Promise<{ notes?: Record<string, unknown>; kbDir?: string }> {
      await close(s);
      const prior = resumableProgress(s, env);
      const config = evalWorkspaceConfig(env);
      if (prior) {
        assertOwnWorkspace(s);
        setState(s, (e) => ({ ...withoutError(e), state: 'building' }));
        // an earlier attempt's workspace: kept, and pointed at this run's shim (its port changed) and database
        fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(config, null, 2));
        await adoptIndex(s, env, config);
        env.log(`knode: resuming the build started ${prior.startedAt} (attempt ${prior.attempts + 1}; done: ${prior.done.join(', ') || 'nothing yet'})`);
      } else {
        fs.rmSync(s.ws, { recursive: true, force: true });
        fs.mkdirSync(s.ws, { recursive: true });
        // a workspace of the evaluation root, made as the root's own are: its manifest, filed under the root's owner
        if (s.placement) {
          writeEvalManifest(s.ws, newEvalManifest(s.placement, s.ws, {
            pack: env.pack.manifest.id, packVersion: env.pack.manifest.version, group: path.basename(s.workDir), fingerprint: buildFingerprint(env),
            models: { build: env.models.model || 'codex (its default model)', embedding: `${config.embedding.model} (${config.embedding.dimensions})` },
          }));
        }
        fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(config, null, 2));
        // a build starts empty: on PostgreSQL the workspace's schema outlives its directory (an earlier, failed build)
        if (config.database.kind === 'postgres') await dropEvalWorkspace(s.ws, config.database);
        fs.cpSync(env.staged.dir, path.join(s.ws, 'raw', 'docs'), { recursive: true });
      }
      // only the staged corpus: never a gold, holdout or task file of the pack (docs/design/35 D7)
      assertNoLeak(s.ws, env.pack.dir, 'after staging');
      const progress: BuildProgress = prior
        ? { ...prior, done: [...prior.done], attempts: prior.attempts + 1 }
        : { fingerprint: buildFingerprint(env), startedAt: new Date().toISOString(), attempts: 1, done: [] };
      const finish = (phase: BuildProgress['done'][number]) => {
        if (!progress.done.includes(phase)) progress.done.push(phase);
        writeProgress(s, progress);
      };
      const ctx = await open(s);
      const index = prior ? readIndexRecord(s)! : await recordIndex(s, ctx);
      writeProgress(s, progress);
      const countsOf = async () => (await ctx.store.query<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM documents WHERE status = 'indexed') AS documents,
                (SELECT count(*)::int FROM chunks) AS chunks,
                (SELECT count(*)::int FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL) AS entities,
                (SELECT count(*)::int FROM relations WHERE tx_to IS NULL) AS relations,
                (SELECT count(*)::int FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL) AS claims,
                (SELECT count(*)::int FROM extraction_queue) AS queued`,
      ))[0];
      // what the earlier attempts left: indexed and embedded documents, and the extraction queue still to drain
      const before = prior ? await countsOf() : null;
      const t0 = Date.now();
      // sync is incremental: a resumed build indexes (and embeds) only what the earlier attempt had not
      const synced = await sync(ctx, { datasources: false, onProgress: (m) => env.log(`knode sync: ${m}`) });
      finish('synced');
      const tSync = Date.now() - t0;
      const passes = await drain(ctx, env);
      finish('extracted');
      const tPasses = Date.now() - t0 - tSync;
      let pages = progress.wikiPages ?? 0;
      if (!progress.done.includes('wiki')) {
        pages = (await generateWiki(ctx.store, ctx.llm, { config: ctx.config, embedder: ctx.embedder, onProgress: (m) => env.log(`knode wiki: ${m}`) })).length;
        progress.wikiPages = pages;
        finish('wiki');
      }
      let refined = progress.refined;
      if (!progress.done.includes('refined')) {
        refined = await refineWiki(ctx.store, ctx.config, ctx.llm, { embedder: ctx.embedder });
        progress.refined = refined;
        finish('refined');
      }
      // the generated pages are searchable too, as in a live workspace
      await sync(ctx, { datasources: false, llmGraph: false });
      readPageSources(s);
      const { queued: _queued, ...counts } = await countsOf();
      return {
        kbDir: s.ws,
        notes: {
          ...counts, database: describeDatabase(ctx.config.database), ...(index.schema ? { schema: index.schema } : {}), ...passes, passConcurrency: ctx.config.extraction.concurrency, judgeConcurrency: ctx.config.review?.directConcurrency ?? 1, passBatch: ctx.config.extraction.batchSize, wikiPages: pages, refined, indexed: synced.indexed, stageMs: { sync: tSync, documentPasses: tPasses, wiki: Date.now() - t0 - tSync - tPasses },
          // a resumed build: what the earlier attempts had done, and what this one found already there
          ...(prior ? { resumed: { startedAt: prior.startedAt, attempt: progress.attempts, phasesDone: prior.done, before } } : {}),
          ...(s.placement ? { workspace: path.resolve(s.ws) } : {}),
        },
      };
}

/**
 * What a run asks `ask` to do beyond its defaults (docs/design/34): compute sets from the claims
 * (`KNODE_EVAL_ASK_COMPUTED=1`, off unless set) and read relative periods from a reference day
 * (`KNODE_EVAL_ASK_NOW=YYYY-MM-DD`: a pack's own "today", 2025-11-07 for the 10x reports pack).
 */
export function askOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { computed?: boolean; now?: string } {
  // empty is unset, as for any setting
  const computed = env.KNODE_EVAL_ASK_COMPUTED?.trim() || undefined;
  const now = env.KNODE_EVAL_ASK_NOW?.trim() || undefined;
  let on: boolean | undefined;
  if (computed !== undefined) {
    if (/^(1|true|yes|on|enabled?)$/i.test(computed)) on = true;
    else if (/^(0|false|no|off|disabled?)$/i.test(computed)) on = false;
    else throw new Error(`KNODE_EVAL_ASK_COMPUTED must be on or off (1 / true / yes / on / enabled, or 0 / false / no / off / disabled), not "${computed}"`);
  }
  if (now !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(now);
    const day = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!m || !day || day.toISOString().slice(0, 10) !== now) throw new Error(`KNODE_EVAL_ASK_NOW must be a day (YYYY-MM-DD); "${now}" is not a day`);
  }
  return { ...(on !== undefined ? { computed: on } : {}), ...(now ? { now } : {}) };
}

/** What one Ask system answers with beyond the workspace's config: `ask`'s options, and retrieval settings over the build's. */
interface AskTuning {
  options: { computed?: boolean; now?: string };
  /** Over the workspace's `retrieval.sag`, for every search this system's answers make. */
  sag?: Partial<SagSearchConfig>;
}

/**
 * `knode-ask-hops`: Ask with the retrieval built for hop and aggregate
 * questions switched on, beside the default `knode-ask` on the same build —
 * bridge terms on the SAG walk (src/search/bridge.ts; 20 terms with 70% of the
 * places kept for the direct route, the setting the 2026-11 offline
 * measurements found best: MuSiQue all-evidence@10 28.4 → 33.4) and sets,
 * counts and values as of a day computed from the claims (docs/design/34 §1).
 * Both are off by default in the product, and were off in the 2026-11
 * campaign (its `run.json`: `askOptions: {}`; the workspaces' `retrieval.sag`
 * had no `bridgeTerms`). The reference day is the run's, as for `knode-ask`.
 * Rerank stays as the workspace has it: an evaluation starts no reranker.
 */
export const ASK_HOPS_SAG: Partial<SagSearchConfig> = { bridgeTerms: 20, directRatio: 0.7 };

/** The workspace's config with `tuning`'s retrieval settings over it; the config itself when there are none. */
function tunedConfig(config: KnodeConfig, tuning: AskTuning): KnodeConfig {
  if (!tuning.sag) return config;
  return { ...config, retrieval: { ...config.retrieval, sag: { ...config.retrieval.sag, ...tuning.sag } } };
}

export function knodeAsk(options: { computed?: boolean; now?: string } = askOptionsFromEnv()): SystemUnderTest {
  return askSystem('knode-ask', 'knode-os ask (hybrid retrieval, cited answer)', { options });
}

export function knodeAskHops(env: NodeJS.ProcessEnv = process.env): SystemUnderTest {
  // the run's reference day, as knode-ask has it; computed sets on, whatever KNODE_EVAL_ASK_COMPUTED says
  const { now } = askOptionsFromEnv(env);
  return askSystem('knode-ask-hops', `knode-os ask with bridge terms (${ASK_HOPS_SAG.bridgeTerms}, ${Math.round(ASK_HOPS_SAG.directRatio! * 100)}% direct) and computed sets`, {
    options: { computed: true, ...(now ? { now } : {}) },
    sag: ASK_HOPS_SAG,
  });
}

function askSystem(id: string, label: string, tuning: AskTuning): SystemUnderTest {
  const { options } = tuning;
  // as wide as the run's answer concurrency: every answer shares the one open context (docs/design/31 D2)
  return knodeSystem(id, label, 'kb', true, {
    settings: { askOptions: options, ...(tuning.sag ? { sag: tuning.sag } : {}) },
    async answer(task, prompt, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      // ask retrieves with its question: give it the question alone, and the shared output rules to its model call
      const rules = prompt.startsWith(task.question) ? prompt.slice(task.question.length) : '';
      const llm = withAppendedRules(shimClient(env, { system: id, stage: 'answer', task: task.id }), rules);
      // against the index as built: an answer records no hits, so no question moves another's ranking (docs/design/31 D3)
      const res = await ask(ctx.store, tunedConfig(ctx.config, tuning), ctx.embedder, llm, task.question, { mode: 'hybrid', track: false, ...options });
      // ask's own [n] citations, each the documents of the passage or fact it numbers, and any [doc: path] the
      // answer wrote under the shared output rules
      const docs = new Set(env.staged.docs.map((d) => d.path));
      const citations: Citation[] = [...new Set([...citedDocuments(s, res, docs), ...citationsIn(res.answer, docs).map((c) => c.doc)])].map((doc) => ({ doc }));
      return { text: res.answer, citations, retrieved: sentDocuments(s, res, docs) };
    },
    /**
     * The ranking an answer is made from: the documents `ask` would send its model for the question, in the
     * prompt's order — the same retrieval as `answer` (route, search, graph expansion, excerpts, facts) without
     * the completion, not a search of its own. The same list as that answer's `retrieved`, cut to `k`, while the
     * router classifies by rules (the default; a model classifier is not asked here).
     */
    async retrieve(query, k, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      const res = await ask(ctx.store, tunedConfig(ctx.config, tuning), ctx.embedder, withoutModel(ctx.llm), query, { mode: 'hybrid', track: false, ...options });
      return sentDocuments(s, res, new Set(env.staged.docs.map((d) => d.path))).slice(0, k);
    },
    async exportKnowledge(env) {
      return exportUnits(stateFor(env));
    },
    async update(_files, env, batch) {
      const s = stateFor(env);
      assertOwnWorkspace(s);
      const ctx = await open(s);
      // the batch is applied in place: the manifest says so while it is, and which batches the workspace holds after
      setState(s, (e) => ({ ...withoutError(e), state: 'updating' }));
      try {
        fs.cpSync(env.staged.dir, path.join(s.ws, 'raw', 'docs'), { recursive: true });
        assertNoLeak(s.ws, env.pack.dir, `after update batch ${batch ?? ''}`.trim());
        await sync(ctx, { datasources: false });
        await drain(ctx, env);
        await reviewLikeServe(ctx, env);
        readPageSources(s);
      } catch (err) {
        setState(s, (e) => ({ ...e, state: 'failed', error: `update ${batch ?? ''}: ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}` }));
        throw err;
      }
      setState(s, (e) => ({ ...withoutError(e), state: 'built', batchesApplied: batch && !e.batchesApplied.includes(batch) ? [...e.batchesApplied, batch] : e.batchesApplied }));
    },
  });
}

export function knodeSag(): SystemUnderTest {
  return knodeSystem('knode-sag', 'knode-os SAG multi-hop retrieval', 'kb', false, {
    async retrieve(query, k, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      const hits = await search(ctx.store, ctx.embedder, query, { k: k * 3, mode: 'sag', track: false, heat: ctx.config.heat, sag: ctx.config.retrieval.sag, rerank: ctx.config.retrieval.rerank, current: false });
      return [...new Set(hits.flatMap((h) => rankedDocument(s, h.path)))].slice(0, k);
    },
  });
}

/** Close every knode workspace a run holds open under `dir` (a run that ends, or is cancelled, mid-pack). */
export async function closeKnodeStates(dir: string): Promise<void> {
  const root = path.resolve(dir) + path.sep;
  for (const [workDir, s] of states) {
    if (!path.resolve(workDir).startsWith(root)) continue;
    await close(s).catch(() => {});
    // and lets go of it: a build the run ended with is the viewer's to open
    if (s.placement) {
      try {
        releaseWriter(s.ws);
      } catch {
        // its folder is gone (dropped)
      }
    }
    states.delete(workDir);
  }
}

export function agentKnode(): SystemUnderTest {
  // as wide as the run's session slots: every session calls the build's one tool host (docs/design/31 D4)
  return knodeSystem('agent-knode', 'Codex agent with knode MCP retrieval tools', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      const host = await toolHost(s, KNODE_AGENT_TOOLS);
      await env.quota.wait();
      const tmp = evalTempDir('mcp');
      const empty = tmp.root;
      try {
        const r = await runAgent({
          cwd: empty,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${knodeAgentBrief()}\n\n${prompt}`,
          mcp: { name: 'knode', url: host.url, token: host.secret, enabledTools: KNODE_AGENT_TOOLS },
        });
        recordAgent(env.meter, { system: 'agent-knode', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const citations = [...new Set([
          ...citationsIn(r.text, docs).map((c) => c.doc),
          ...[...r.text.matchAll(/wiki\/[^\s)\]'"`，。]+\.md/g)].flatMap((m) => toCorpus(s, m[0])),
        ])].map((doc) => ({ doc }));
        return { text: r.text, citations, toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs, capped: r.capped, leaked: r.leaked, error: r.error };
      } finally {
        tmp.cleanup();
      }
    },
  });
}

export function agentKnodeWiki(): SystemUnderTest {
  return knodeSystem('agent-knode-wiki', 'Codex agent reading the knode-generated wiki', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      await env.quota.wait();
      const copy = isolatedCopy(path.join(s.ws, 'wiki'), 'wiki');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${AGENT_BRIEF('The current directory is a wiki generated from the documents (start from index.md and sources/). The source documents themselves are not here; pages cite them as raw/docs/<path> — cite those paths.')}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-knode-wiki', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const viaPages = r.filesTouched.flatMap((f) => toCorpus(s, `wiki/${f}`));
        return {
          text: r.text,
          citations: citationsIn(r.text, docs),
          retrieved: [...new Set(viaPages)],
          toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs,
          capped: r.capped,
          leaked: r.leaked,
          error: r.error,
        };
      } finally {
        copy.cleanup();
      }
    },
  });
}

export function agentKnodeWikiSources(): SystemUnderTest {
  return knodeSystem('agent-knode-wiki-sources', 'Codex agent reading the knode-generated wiki and the sources', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      await env.quota.wait();
      // the pages cite raw/docs/<path>: the sources sit where those links point
      const copy = wikiWithSources(path.join(s.ws, 'wiki'), env.staged.dir, 'wiki', 'raw/docs');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${armBrief(KNODE_WIKI_SOURCES_HAS)}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-knode-wiki-sources', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        return {
          text: r.text,
          citations: citationsIn(r.text, docs),
          retrieved: [...new Set(r.filesTouched.flatMap((f) => toCorpus(s, f)))],
          toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs,
          capped: r.capped,
          leaked: r.leaked,
          error: r.error,
        };
      } finally {
        copy.cleanup();
      }
    },
  });
}

/**
 * Arm D's knode tools (docs/design/33 §2): retrieval only — hybrid search,
 * the graph, claims, SQL over the catalog, resolution, orientation. Not
 * `knode_grep`, `knode_read` or `knode_ls`: the shell does that, so every
 * knode call an arm-D answer makes is a use of something grep cannot do.
 */
export const KNODE_FULL_TOOLS = ['knode_search', 'knode_graph_search', 'knode_claims', 'knode_query', 'knode_resolve', 'knode_survey'];

/** Arm D's sentence of the shared brief: arm C's folder, and knode's retrieval tools beside it. */
/** Arm C's sentence: the knode wiki and the sources beside it, where its pages' links point. */
export const KNODE_WIKI_SOURCES_HAS = WIKI_SOURCES_HAS('wiki/, generated pages; sources/ holds one summary per document', 'raw/docs/');

export const AGENT_KNODE_FULL_HAS = `${KNODE_WIKI_SOURCES_HAS} You also have knode's retrieval tools (on the MCP server knode) over an index built from the same documents: ${KNODE_FULL_TOOLS.join(', ')}. Their results name documents as raw/docs/<path> and pages as wiki/<page>, the paths of the current directory. A tool call counts against the budget as a command does.`;

/**
 * Arm D's tool guide: which tool answers which kind of question
 * (`questionKindGuide`), with grep and reading done in the shell, and the
 * catalog's schema for knode_query.
 */
export function knodeFullGuide(): string {
  // the catalog guide points to knode_datasources for the full list of views: arm D has no such tool, and a brief
  // naming tools an agent was not given sends it searching for them
  const catalog = catalogGuide().replace(/; knode_datasources lists every view/, '');
  return `${questionKindGuide({ grep: 'rg in the shell (rg -n -C3 "<string>" raw/docs wiki)', read: 'the shell (sed -n, head or cat; several files in one command)' })}

${catalog}`;
}

export function agentKnodeFull(): SystemUnderTest {
  return knodeSystem('agent-knode-full', 'Codex agent reading the knode wiki and the sources, with knode retrieval tools', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      const host = await toolHost(s, KNODE_FULL_TOOLS);
      await env.quota.wait();
      // arm C's folder: the pages and the sources where their links point
      const copy = wikiWithSources(path.join(s.ws, 'wiki'), env.staged.dir, 'wiki', 'raw/docs');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${armBrief(AGENT_KNODE_FULL_HAS, knodeFullGuide())}\n\n${prompt}`,
          mcp: { name: 'knode', url: host.url, token: host.secret, enabledTools: KNODE_FULL_TOOLS },
        });
        recordAgent(env.meter, { system: 'agent-knode-full', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const citations = [...new Set([
          ...citationsIn(r.text, docs).map((c) => c.doc),
          ...[...r.text.matchAll(/wiki\/[^\s)\]'"`，。]+\.md/g)].flatMap((m) => toCorpus(s, m[0])),
        ])].map((doc) => ({ doc }));
        return {
          text: r.text,
          citations,
          retrieved: [...new Set(r.filesTouched.flatMap((f) => toCorpus(s, f)))],
          toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs,
          capped: r.capped,
          leaked: r.leaked,
          error: r.error,
        };
      } finally {
        copy.cleanup();
      }
    },
  });
}

/** A client that adds `rules` to the last user message of every call — the output contract every system answers under. */
function withAppendedRules(client: LlmClient, rules: string): LlmClient {
  if (!rules.trim()) return client;
  const add = (messages: ChatMessage[]): ChatMessage[] => {
    const i = messages.map((m) => m.role).lastIndexOf('user');
    return i < 0 ? [...messages, { role: 'user', content: rules.trim() }] : messages.map((m, k) => (k === i ? { ...m, content: `${m.content}${rules}` } : m));
  };
  const complete = client.complete.bind(client);
  const completeJson = client.completeJson.bind(client);
  return Object.assign(Object.create(client) as LlmClient, {
    complete: (messages: ChatMessage[], opts?: Parameters<LlmClient['complete']>[1]) => complete(add(messages), opts),
    completeJson: <T>(messages: ChatMessage[], opts?: Parameters<LlmClient['completeJson']>[1]) => completeJson<T>(add(messages), opts),
  });
}

/**
 * The period a claim holds for, as its unit's text says it: ` (2025-11-03 – 2025-11-07)`, the two days as
 * stored (UTC, the end day being the day the stored instant falls in), '' for a claim with no period. The
 * columns come back as Dates: cut from `String(date)` they read "Mon Nov 03", with no year and in local time
 * (an end of day in UTC is the next morning in UTC+8), and a judge that assumed the year marked true claims
 * contradicted — 25 of the 28 failing claims of the 2026-11 10× reports run.
 */
export function claimWindow(validFrom: string | Date | null, validTo: string | Date | null): string {
  const from = toDateString(validFrom);
  const to = toDateString(validTo);
  return from || to ? ` (${from ?? '?'} – ${to ?? ''})` : '';
}

/** Everything the build generated, as units: entities, relations, claims and pages — never the source chunks. */
async function exportUnits(s: KnodeState): Promise<KnowledgeUnit[]> {
  const ctx = await open(s);
  const strip = (p: string | null) => (p && p.startsWith('raw/docs/') ? [p.slice('raw/docs/'.length)] : []);
  const units: KnowledgeUnit[] = [];

  const sourcesOf = new Map<string, string[]>();
  for (const r of await ctx.store.query<{ entity_id: string; path: string }>(
    `SELECT DISTINCT m.entity_id, d.path FROM entity_mentions m JOIN documents d ON d.id = m.document_id WHERE d.root = 'docs'`,
  )) (sourcesOf.get(r.entity_id) ?? sourcesOf.set(r.entity_id, []).get(r.entity_id)!).push(...strip(r.path));

  for (const e of await ctx.store.query<{ id: string; name: string; type: string; description: string; aliases: unknown }>(
    `SELECT id, name, type, description, aliases FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`,
  )) {
    const aliases = Array.isArray(e.aliases) ? (e.aliases as string[]) : [];
    units.push({ id: `entity:${e.id}`, kind: 'entity', title: e.name, text: `${e.name} (${e.type}): ${e.description}`.trim() + (aliases.length ? `\naliases: ${aliases.join(', ')}` : ''), sources: sourcesOf.get(e.id) ?? [], links: [] });
  }
  // a relation's documents are the ones its evidence came from, oldest first: the row's own document_id is unset
  // for an extracted relation, whose evidence is written on the scope of the document read (`doc`, or `tier1`
  // keyed by the same path — as an entity page names a relation's source, src/wiki/pages.ts). Without them every
  // relation unit had no source, and its link was judged against passages a keyword search of the corpus found.
  const evidenceOf = new Map<string, string[]>();
  for (const r of await ctx.store.query<{ target_id: string; path: string }>(
    `SELECT ev.target_id, s.key AS path FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
     WHERE ev.kind = 'relation' AND ev.tx_to IS NULL AND s.kind IN ('doc', 'tier1')
     GROUP BY ev.target_id, s.key ORDER BY min(ev.tx_from), s.key`,
  )) (evidenceOf.get(r.target_id) ?? evidenceOf.set(r.target_id, []).get(r.target_id)!).push(...strip(r.path));
  for (const r of await ctx.store.query<{ id: string; head: string; tail: string; type: string; description: string; path: string | null; source_id: string; target_id: string }>(
    `SELECT r.id, s.name AS head, t.name AS tail, r.type, r.description, d.path, r.source_id, r.target_id
     FROM relations r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
     LEFT JOIN documents d ON d.id = r.document_id WHERE r.tx_to IS NULL`,
  )) {
    const sources = [...new Set([...strip(r.path), ...(evidenceOf.get(r.id) ?? [])])];
    units.push({ id: `relation:${r.id}`, kind: 'relation', head: r.head, tail: r.tail, relation: r.type, text: `${r.head} —${r.type}→ ${r.tail}${r.description ? `: ${r.description}` : ''}`, sources, links: [`entity:${r.source_id}`, `entity:${r.target_id}`] });
  }
  for (const c of await ctx.store.query<{ id: string; subject: string; statement: string; kind: string; valid_from: string | Date | null; valid_to: string | Date | null; path: string | null; subject_id: string }>(
    `SELECT c.id, e.name AS subject, c.statement, c.kind, c.valid_from, c.valid_to, d.path, c.subject_id
     FROM claims c JOIN entities e ON e.id = c.subject_id
     LEFT JOIN chunks ch ON ch.id = c.chunk_id LEFT JOIN documents d ON d.id = ch.document_id
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL`,
  )) {
    units.push({ id: `claim:${c.id}`, kind: 'claim', title: c.subject, text: `${c.statement}${claimWindow(c.valid_from, c.valid_to)}${c.kind && c.kind !== 'fact' ? ` [${c.kind}]` : ''}`, sources: strip(c.path), links: [`entity:${c.subject_id}`] });
  }
  const wiki = path.join(s.ws, 'wiki');
  for (const rel of listFiles(wiki).filter((f) => f.endsWith('.md'))) {
    // navigation pages (the generated indexes, the overview) are not knowledge units
    if (rel.startsWith('.obsidian') || NAVIGATION_PAGE.test(rel)) continue;
    const kind: KnowledgeUnit['kind'] = rel.startsWith('sources/') ? 'summary' : rel.startsWith('concepts/') ? 'community' : 'page';
    const body = parseFrontmatter(fs.readFileSync(path.join(wiki, rel), 'utf8')).body.replace(/<!--[^>]*-->/g, '').trim();
    if (!body) continue;
    const links = [...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => `page:${m[1].trim()}`);
    units.push({ id: `page:wiki/${rel}`, kind, title: rel, text: body, sources: s.pageSources.get(`wiki/${rel}`) ?? [], links });
  }
  return units;
}

