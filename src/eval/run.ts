import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit } from '../bench/util.js';
import { defaultConfig, isCliProvider, KnodeConfig, LlmEffort, loadConfig } from '../config.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { createConfiguredEmbeddingProvider } from '../ingest/embedding-router.js';
import { LlmClient } from '../llm/client.js';
import { AUDIT_DEFAULT_SHARE, Judge, JUDGE_SYSTEM, type JudgeAudit } from './judge.js';
import { ModelChain, parseChain, SpendLedger } from './chain.js';
import { setAgentRouting, setAgentStopping } from './agent.js';
import { Meter } from './meter.js';
import { dirBytes, listFiles, loadPack, LoadedPack, packsDir, runsDir, seededKey, stageCorpus, StagedCorpus, stageUpdate, validatePack } from './pack.js';
import { calibrateEndpoint, checkEndpoint, endpointUnder, preferEndpoint } from './endpoint.js';
import { citationsIn, taskPrompt } from './prompts.js';
import { EmbeddingBudget, QuotaGuard } from './quota.js';
import { fileLines, recordKey, RunMeta, RunStore } from './runstore.js';
import { agentAllocationFor, describeAllocation, sampleByType, sharesFor, typeQuotas, type AgentAllocation, type TypeShares } from './allocation.js';
import { scoreEmergence } from './score/emergence.js';
import { scoreGeneration } from './score/generation.js';
import { scoreLists } from './score/lists.js';
import { scoreKey, scoreUsage } from './score/usage.js';
import { ChatBackend, ChatRequest, ClientBackend, CodexBackend, shimState, startShim } from './shim.js';
import { currentRemote, withPieceTag, withRemote } from './placement.js';
import { judgeAgent, judgeFamily, queueRunId, PackScope, packMayLeave, PieceStuckError, PublishedChatBackend, RemoteEval, remoteJudgeClient, RunCancelledError } from './remote.js';
import type { EvalFamily } from '../work/eval.js';
import type { Placed } from './meter.js';
import { closeAdapters } from './systems/external.js';
import { askOptionsFromEnv, closeKnodeStates } from './systems/knode.js';
import { describeDatabase, EVAL_POOL_MAX, evalDatabase, orphanedEvalSchemas, sameDatabase } from './database.js';
import { EvalRootPlacement, evalRootDir, evalRunId, initEvalRoot, liveDatabase, newEvalManifest, placeEvalWorkspace, readEvalManifest, readWorkspacePointer, WORKSPACE_POINTER, writeEvalManifest, writeWorkspacePointer } from './root.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import { makeSystems } from './systems/index.js';
import { removeHeldTempDirs, sweepStaleTempDirs } from './tmp.js';
import { boundedOutputs, boundedTrace } from './trace.js';
import { SystemEnv, SystemUnderTest, taggedEmbedder } from './systems/types.js';
import { extractFinalAnswer } from './metrics/text.js';
import { AnswerRecord, BuildRecord, emptyUsage, ScoreRecord, Suite, SUITES, Task, TaskType, Usage } from './types.js';

/**
 * `knode-os eval run` (docs/design/23 §7). For each pack: stage the corpus,
 * build each system group once, answer the selected tasks, apply update
 * batches and answer the update tasks, then score — every answer of every
 * system judged in one blind pass, generated knowledge scored per build.
 * Every record is keyed, so a rerun of the same directory resumes.
 */

export interface RunOptions {
  packs: string[];
  systems: string[];
  suites?: Suite[];
  /** Resume this run directory instead of starting a new one. */
  runDir?: string;
  /** A knode workspace whose config supplies the embedder and, with `chatConnection`, the chat endpoint (read-only). */
  configFrom?: string;
  /**
   * Where knode's indexes live (docs/design/31 D1): a PostgreSQL connection
   * string (default `KNODE_EVAL_DATABASE_URL`). Absent, the run follows its
   * config's `database.kind`: PGlite in each workspace, or the database
   * `knode_eval` on the server `configFrom` (or the default config) names. A
   * run refuses to start on that config's own database.
   */
  databaseUrl?: string;
  /** Keep knode's indexes in embedded PGlite whatever the config names (a comparison with earlier runs, design 31 D5). */
  pglite?: boolean;
  /**
   * The evaluation root a new run keeps its knode builds in, one workspace per
   * pack (docs/design/35): default `KNODE_EVAL_ROOT`, else
   * `<KNODE_EVAL_HOME>/server`, made on first use. A resumed run keeps the
   * root it started with.
   */
  evalRoot?: string;
  /**
   * Where a new run's knode builds go: `root` (the default) or, as before
   * evaluation roots, `run` — `<run>/work/<pack>/knode/ws`. A resumed run keeps
   * the layout it started with (`run.json` `workspaces`). Tests, and a
   * comparison with the old layout.
   */
  workspacesIn?: 'root' | 'run';
  /**
   * Spend nothing: a model call or an embedding not in the run's caches fails
   * instead of reaching a model or the embedder (a rebuild from another run's
   * copied caches, design 31 D5). Agent sessions and the judge are not cached:
   * leave them out (`--systems`, `--skip-scoring`).
   */
  replayOnly?: boolean;
  /**
   * A connection of that workspace — an API endpoint — that answers the shim's
   * chat calls instead of `codex exec`. Agents stay Codex sessions.
   */
  chatConnection?: string;
  /** The model every system builds and answers with ('' = Codex's default, or the connection's). */
  model?: string;
  /**
   * An OpenAI-compatible embedding endpoint (a local bge-m3, say) that embeds in
   * place of the workspace's embedder, under its identity, once it reproduces the
   * vectors the run holds (`checkEndpoint`).
   */
  embeddingEndpoint?: string;
  /** With `embeddingEndpoint`: embed on the workspace's embedder while the endpoint is unreachable (a local bge-m3 first, the pool after). */
  embeddingFallback?: boolean;
  buildEffort?: LlmEffort;
  answerEffort?: LlmEffort;
  /** Judge: a CLI provider ('claude-cli') and model. */
  judgeProvider?: string;
  judgeModel?: string;
  /**
   * Budgeted model chains (D18), e.g. `openai-api:200,codex-cli`: the model
   * calls of every system (`chatChain`), the agent sessions (`agentChain`,
   * API links billed through Codex, then the login) and the judge
   * (`judgeChain`). Connections come from `configFrom`.
   */
  chatChain?: string;
  agentChain?: string;
  judgeChain?: string;
  embedding?: 'workspace' | 'local';
  /** At most this many tasks per pack (stratified by type), and fewer for agents. */
  limit?: number;
  /** Only tasks of these types (a focused run: the corpus-level types, deep hops, updates). */
  types?: TaskType[];
  agentLimit?: number;
  /**
   * How the agent sample is spread over task types (weights, counts, or
   * weights derived from a previous run's records). Absent: round-robin over
   * types, as before; a resume keeps the allocation the run recorded.
   */
  agentAllocation?: AgentAllocation | null;
  /** At most this many update tasks per pack for agent systems (stratified by type, seeded); absent: all of them. */
  agentUpdateLimit?: number;
  fraction?: number;
  seed?: string | number;
  /**
   * An old command line's slots (no `remote`, no `local`): the run's own
   * slots, `codex:<slots>` and the judge's CLI at as many (default 6).
   */
  slots?: number;
  /**
   * The run's own slots, by CLI (`--local codex:6,claude:1`): they lease the
   * run's pieces like a worker and run them on this machine with the run's
   * backends. Null or empty: none — with no worker either, nothing runs.
   */
  local?: Partial<Record<EvalFamily, number>> | null;
  /**
   * The most tasks one system answers at once in each pack, update batches
   * included: a bound on the width the slots online give (none by default;
   * 3 for an old command line).
   */
  answerConcurrency?: number;
  /**
   * The most judge calls at once: a bound on the width the slots online that
   * take the judge's calls give (none by default; 2 for an old command line).
   */
  judgeConcurrency?: number;
  /** Packs worked on at once (each builds and answers on its own; the shim's slots bound the model calls). */
  packConcurrency?: number;
  quota?: boolean;
  embeddingTokenCap?: number;
  /** At most this many embedding tokens per UTC day (a shared pool's free quotas reset at 00:00 UTC). */
  embeddingDailyCap?: number;
  /** Skip scoring (answers only) or answering (score what is there). */
  skipScoring?: boolean;
  /**
   * Start from another run's builds of the same packs (same id, version,
   * fraction and seed) and its embedding vectors: their work directories are
   * copied and their build records kept, cost included — so a new task set
   * over an unchanged corpus does not pay for the builds again. A build the
   * other run went on to update is built again: update batches change its
   * work directory in place, so what is there is no longer the base build.
   */
  reuseBuildsFrom?: string;
  /**
   * Build groups (`knode`, `llm-wiki`, `rag`, …) not taken from
   * `reuseBuildsFrom`, built afresh: a build's key names the pack and its
   * version, not the code that built it, so after a change to how a group
   * builds (knode's retrieval, entity pages, summaries) its old build would
   * otherwise come back.
   */
  rebuild?: string[];
  /** Tests: stand-ins for Codex, the judge and the embedder. */
  overrides?: { chat?: ChatBackend; judge?: LlmClient; embedder?: EmbeddingProvider };
  /**
   * Offer the run's model work to remote workers through `serve` on this
   * machine (docs/design/27 §8): its origin and the data root's MCP token.
   * Only work whose CLI and model the run names leaves (`--model`, and
   * `--judge-model` for the judge); a pack with a `private:` source never does.
   */
  remote?: { serveUrl: string; token: string; refreshMs?: number } | null;
  /**
   * Share of judge verdicts judged a second time, in a call of their own, for
   * how often the judge disagrees with itself (default 0.05, at least 20 a
   * pass; 0: off). Recorded in the run's `judge-audit.jsonl`.
   */
  judgeAudit?: number;
  /** Lists the judge matches in one call (default 1: a list's verdict depends on that list alone; more saves judge calls). */
  judgeListBatch?: number;
  /** Answer each task this many times, for run-to-run variance (default 1: today's keys). */
  repeat?: number;
  /** The systems answered `repeat` times (default: every system that answers). */
  repeatSystems?: string[];
  /**
   * With `repeat`: repeats after the first answer only a seeded sample of
   * this many tasks per pack (and per update batch), stratified by task type
   * and the same for every repeated system — run-to-run spread for a part of
   * the cost. Unset: every task is repeated.
   */
  repeatSample?: number;
  /** Cancels the run: what is out with workers is withdrawn and their session tokens revoked. */
  signal?: AbortSignal;
  /**
   * How long a piece may wait while no slot online meets its requirements
   * (default 30 min; 0: no limit). Past it the run stops cleanly and throws
   * `WaitLimitError`; a resume continues.
   */
  waitMinutes?: number;
  /** Tests: how often waiting is checked (the log comes every twelve checks). */
  waitCheckMs?: number;
  /**
   * The pool every piece of the run requires (docs/design/32 §2): only a slot
   * of it takes them, the run's own slots included (they are in it). Absent:
   * any slot that meets a piece; the run's own slots are pool `local`.
   */
  pool?: string;
  onProgress?: (msg: string) => void;
}

export interface RunResult {
  runDir: string;
  builds: number;
  answers: number;
  scores: number;
  /** Pieces three different workers could not serve (docs/design/32 §3): the run is incomplete. */
  stuck: number;
}

/** `--replay-only`: what is not in the reply cache is not asked. */
class ReplayOnlyBackend implements ChatBackend {
  readonly label = 'replay-only';
  async complete(req: ChatRequest): Promise<never> {
    const tag = req.tag ? [req.tag.system, req.tag.stage, req.tag.task].filter(Boolean).join('/') : 'a call';
    throw new Error(`not in the reply cache (--replay-only): ${tag}`);
  }
}

/** `--replay-only`: the embedder's identity, so cached vectors are found, and nothing behind it. */
function refusingEmbedder(identity: EmbeddingProvider): EmbeddingProvider {
  return {
    model: identity.model,
    dimensions: identity.dimensions,
    embed: async (texts) => {
      throw new Error(`not in the vector cache (--replay-only): ${texts.length} texts`);
    },
  };
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function knodeVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Tasks a system answers on a pack: the suites asked for, stratified by type, at most `limit`.
 *
 * Within a type the primary tasks come first. A type whose tasks name a `meta.stratum` (the reports' deep hops:
 * h4, h5, h5r) is taken in proportion to its strata, whatever the number taken: primaries first within each
 * stratum, the strata interleaved by how far through each one a task is. Without that a limited run sampled a
 * different mix from an unlimited one — of the 10× reports pack's 69 deep hops (20 h5, 29 h4, 20 h5r) the 18
 * a run took at a limit of 300 were 8 h5 and 10 h5r and no h4, h4 having no primary, against 2 / 3 / 2 at 1×.
 *
 * With `shares` (an agent sample's allocation) each type gives the number `typeQuotas` sets — the first ones
 * of its list, in the same order — instead of an even share; without, every caller samples as before.
 */
export function selectTasks(tasks: Task[], suites: Set<string>, limit: number | undefined, seed: string | number, shares?: TypeShares | null): Task[] {
  const pool = tasks.filter((t) => suites.has(t.suite));
  if (!shares && (!limit || pool.length <= limit)) return pool;
  const byType = new Map<string, Task[]>();
  for (const t of [...pool].sort((a, b) => seededKey(seed, a.id).localeCompare(seededKey(seed, b.id)))) {
    (byType.get(t.type) ?? byType.set(t.type, []).get(t.type)!).push(t);
  }
  // primary tasks first within each type (within each stratum of it), then round-robin across types
  for (const [type, list] of byType) {
    list.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
    byType.set(type, interleaveStrata(list));
  }
  // an allocation fixes how many each type gives; the order stays the round-robin's
  const quota = shares ? typeQuotas(new Map([...byType].map(([t, l]) => [t, l.length])), limit ?? pool.length, shares) : null;
  const lists = [...byType].map(([type, l]) => (quota ? l.slice(0, quota.get(type) ?? 0) : l));
  const cap = quota ? [...quota.values()].reduce((a, b) => a + b, 0) : limit!;
  const out: Task[] = [];
  for (let i = 0; out.length < cap; i++) {
    let added = false;
    for (const l of lists) {
      if (l[i] && out.length < cap) {
        out.push(l[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/**
 * The tasks repeats after the first ask (`--repeat-sample`): `n` of `pool`,
 * stratified by task type as `selectTasks` samples (round-robin across types,
 * primary tasks first), under a seed of its own so the sample is not simply
 * the first tasks of the run's own order. Null: no sample, every task repeats.
 */
export function repeatSampleOf(pool: Task[], n: number | undefined, seed: string | number): Set<string> | null {
  if (!n || n <= 0) return null;
  return new Set(selectTasks(pool, new Set(pool.map((t) => t.suite)), Math.trunc(n), `${seed}|repeat`).map((t) => t.id));
}

const isAgent = (s: SystemUnderTest) => s.kind === 'agent' || s.id.startsWith('agent-');

/** A workspace connection as the shim's backend, at the run's model when it names one. */
function connectionBackend(config: KnodeConfig | null, id: string, model?: string): ChatBackend {
  if (!config) throw new Error('--chat-connection names a connection of the --config-from workspace');
  const connection = config.connections.find((c) => c.id === id);
  if (!connection) throw new Error(`no connection "${id}" in the --config-from workspace (it has: ${config.connections.map((c) => c.id).join(', ')})`);
  if (isCliProvider(connection.provider)) throw new Error(`connection "${id}" is a CLI; --chat-connection takes an API endpoint`);
  return new ClientBackend(new LlmClient({ ...connection, model: model || connection.model }));
}

/** `--local codex:6,claude:1` as a map, refused when it names another CLI or a count that is none. */
export function parseLocal(spec: string): Partial<Record<EvalFamily, number>> {
  const out: Partial<Record<EvalFamily, number>> = {};
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [family, n = '1'] = part.split(':').map((x) => x.trim());
    if (family !== 'codex' && family !== 'claude') throw new Error(`--local: "${family}" is not a CLI a run's slot runs (codex or claude)`);
    const count = Number(n);
    if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error(`--local: ${part}: the count must be a whole number from 0 to 64`);
    out[family] = (out[family] ?? 0) + count;
  }
  return out;
}

export function describeLocal(local: Partial<Record<EvalFamily, number>>): string {
  return Object.entries(local).filter(([, n]) => n).map(([f, n]) => `${f}:${n}`).join(',') || 'none';
}

/**
 * Where a run's work runs (docs/design/32 §3). An old command line — no
 * `--remote`, no `--local` — runs here on slots sized from `--slots`: Codex
 * for the model calls and agent sessions, and the judge's CLI.
 */
export function runPlacement(opts: Pick<RunOptions, 'local' | 'remote' | 'slots'>, judge: EvalFamily): { legacy: boolean; local: Partial<Record<EvalFamily, number>> | null } {
  if (opts.local !== undefined || opts.remote) return { legacy: false, local: opts.local && Object.values(opts.local).some((n) => n) ? opts.local : null };
  const n = Math.max(1, Math.trunc(opts.slots ?? 6));
  return { legacy: true, local: { codex: n, ...(judge === 'codex' ? {} : { [judge]: n }) } };
}

/** The most tasks one system answers at once: `--answer-concurrency`, which an old command line has at 3. */
function answerCap(opts: Pick<RunOptions, 'answerConcurrency'>, placement: { legacy: boolean }): number | undefined {
  return opts.answerConcurrency ?? (placement.legacy ? 3 : undefined);
}

/** The most judge calls at once: `--judge-concurrency`, which an old command line has at 2. */
export function judgeCap(opts: Pick<RunOptions, 'judgeConcurrency'>, placement: { legacy: boolean }): number | undefined {
  const n = opts.judgeConcurrency ?? (placement.legacy ? 2 : undefined);
  return n === undefined ? undefined : Math.max(1, Math.trunc(n));
}

/**
 * How many judge calls go out at once: as many as the slots online that take
 * them (docs/design/32 §3), at most the cap, never fewer than one — a call is
 * published and waits for a slot.
 */
export function judgeWidth(remote: RemoteEval, family: EvalFamily, eligible: 'any' | 'local', cap: number | undefined): () => number {
  return () => Math.max(1, Math.min(cap ?? Infinity, remote.width('eval-call', family, eligible)));
}

export async function runEval(opts: RunOptions): Promise<RunResult> {
  const progress = opts.onProgress ?? (() => {});
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const runDir = path.resolve(opts.runDir ?? path.join(runsDir(), stamp));
  const store = new RunStore(runDir);
  const suites = new Set<string>(opts.suites ?? SUITES);
  const fraction = opts.fraction ?? 1;
  const seed = opts.seed ?? 0;
  const meter = new Meter(path.join(runDir, 'meter.jsonl'));
  if (opts.replayOnly) {
    const agents = makeSystems(opts.systems).filter(isAgent).map((sys) => sys.id);
    if (agents.length) throw new Error(`--replay-only: agent sessions are not cached, leave out ${agents.join(', ')}`);
    if (!opts.skipScoring) throw new Error('--replay-only: the judge is not served from the reply cache, add --skip-scoring');
  }
  const quota = new QuotaGuard({ enabled: opts.quota ?? (!opts.overrides?.chat && !opts.replayOnly), log: (m, d) => {
    progress(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`);
    store.log(m, d);
  } });

  const budget = new EmbeddingBudget({
    dailyTokens: opts.embeddingDailyCap,
    usedToday: (day) => meter.all((e) => e.at.startsWith(day)).reduce((s, e) => s + (e.embeddingTokens ?? 0), 0),
    log: (m, d) => {
      progress(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`);
      store.log(m, d);
    },
  });

  const workspaceConfig = opts.configFrom ? loadConfig(opts.configFrom) : null;
  // the indexes on the product's backend, in a database of their own (docs/design/31 D1): checked before anything is spent
  if (opts.pglite && opts.databaseUrl) throw new Error('--pglite and --database-url name two places for the indexes: pick one');
  const sourceDatabase = opts.pglite ? { ...defaultConfig().database, kind: 'pglite' } : workspaceConfig?.database ?? defaultConfig().database;
  const database = evalDatabase(sourceDatabase, { url: opts.databaseUrl, poolSize: opts.answerConcurrency ?? 3 });
  if (sameDatabase(database, sourceDatabase)) {
    throw new Error(`the evaluation's indexes would go into ${describeDatabase(database)}, the database ${opts.configFrom ? `the --config-from workspace (${opts.configFrom})` : 'the default config'} uses — name another with --database-url (or KNODE_EVAL_DATABASE_URL)`);
  }
  // a run from before this field kept its indexes on PGlite
  const previous = store.meta() ? store.meta()!.database ?? { kind: 'pglite', at: 'pglite' } : null;
  if (previous && previous.kind !== database.kind) {
    throw new Error(`run ${path.basename(runDir)} keeps its indexes on ${previous.at}; this run would keep them on ${describeDatabase(database)} — results on two backends are not pooled: resume it on ${previous.kind}, or start a new run`);
  }
  // where the knode builds go (docs/design/35): a new run's into the evaluation root, a run made before stays as it was
  const layout: 'root' | 'run' = store.meta() ? (store.meta()!.workspaces === 'root' ? 'root' : 'run') : (opts.workspacesIn ?? 'root');
  const rootPlace: EvalRootPlacement | null = layout === 'root'
    ? (() => {
      const { root } = initEvalRoot(opts.evalRoot ? evalRootDir(opts.evalRoot) : store.meta()?.evalRoot ?? evalRootDir(), {
        database, live: opts.configFrom ? sourceDatabase : liveDatabase(), liveLabel: opts.configFrom ? `the --config-from workspace (${opts.configFrom})` : 'the default data root',
      });
      return {
        root: root.dir, owner: root.owner, run: runDir, runId: evalRunId(runDir), fraction, seed,
        builtWith: { version: knodeVersion(), commit: gitSha()?.slice(0, 12) ?? null, schema: SCHEMA_VERSION },
      };
    })()
    : null;
  const configured = opts.overrides?.embedder
    ?? (opts.embedding === 'local' || !workspaceConfig
      ? createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false })
      : createConfiguredEmbeddingProvider(workspaceConfig));
  const onEndpoint = opts.embeddingEndpoint ? endpointUnder(configured, opts.embeddingEndpoint) : null;
  const embedder = opts.replayOnly ? refusingEmbedder(configured) : !onEndpoint ? configured
    : opts.embeddingFallback ? preferEndpoint(onEndpoint, configured, (m) => {
      progress(m);
      store.log(m);
    }) : onEndpoint;
  const ledger = new SpendLedger();
  const chainLog = (m: string) => {
    progress(m);
    store.log(m);
  };
  const chain = (spec: string) => new ModelChain(parseChain(spec, workspaceConfig, { ledger, model: opts.model }), ledger, chainLog);
  const backend = opts.replayOnly ? new ReplayOnlyBackend()
    : opts.overrides?.chat
    ?? (opts.chatChain ? chain(opts.chatChain).asBackend()
      : opts.chatConnection ? connectionBackend(workspaceConfig, opts.chatConnection, opts.model) : new CodexBackend({ model: opts.model }));
  const localJudge = opts.overrides?.judge
    ?? (opts.judgeChain ? chain(opts.judgeChain).asClient()
      : new LlmClient({ provider: opts.judgeProvider ?? 'claude-cli', baseUrl: '', apiKey: '', model: opts.judgeModel ?? '', cliPath: '', cliTimeoutMs: 600_000 }));
  // the run only publishes (docs/design/32): to serve's broker on this machine, or one of its own
  // the queue's id for the run: the directory's name, made one a queue carries when it is not
  const runId = queueRunId(path.basename(runDir));
  const queueLog = chainLog;
  const placement = runPlacement(opts, judgeFamily(opts.judgeProvider ?? 'claude-cli'));
  if (placement.legacy) queueLog(`work: no --remote and no --local: this run's model work runs on this machine, on --local ${describeLocal(placement.local!)} (sized from --slots)`);
  // the run stops on its caller's cancel, on a signal, or when it has waited its limit for a slot: whatever it stopped is not recorded
  const stop = new AbortController();
  const waiting = {
    pool: opts.pool, waitMinutes: opts.waitMinutes ?? 30, checkMs: opts.waitCheckMs, logEveryMs: opts.waitCheckMs ? opts.waitCheckMs * 12 : undefined, onStop: () => stop.abort(),
    onStuck: (piece: import('./remote.js').StuckPiece) => store.log('piece stuck', { ...piece }),
  };
  let remote = opts.remote ? await RemoteEval.connect({ ...opts.remote, run: runId, scope: runDir, quota, log: queueLog, ...waiting }) : null;
  if (opts.remote && !remote) queueLog(`work: serve is not answering: the run publishes to a broker of its own${placement.local ? '' : ', and with no --local nothing takes its pieces'}`);
  remote ??= RemoteEval.own({ run: runId, scope: runDir, quota, log: queueLog, refreshMs: opts.remote?.refreshMs, ...waiting });
  // what the end of the run closes, whatever it got to: set as the run starts each of them
  const opened: { shim: Awaited<ReturnType<typeof startShim>> | null; localShim: Awaited<ReturnType<typeof startShim>> | null; meta: RunMeta | null; onSignal: ((s: NodeJS.Signals) => void) | null } = { shim: null, localShim: null, meta: null, onSignal: null };
  const loaded: { pack: LoadedPack; staged: StagedCorpus }[] = [];
  const onAbort = () => {
    stop.abort();
    void remote.cancel();
  };
  try {
    if (placement.local) remote.startLocal(placement.local);
    else queueLog(`work: no slot on this machine: the run's pieces wait for workers${remote.waitMinutes ? ` (at most ${remote.waitMinutes} min while none online takes them)` : ''}`);
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    setAgentStopping(stop.signal);
    // a call may leave only on the run's own Codex backend with a named model: the worker runs exactly that one
    const callsLeave = !opts.replayOnly && !opts.overrides?.chat && !opts.chatChain && !opts.chatConnection && Boolean(opts.model);
    if (remote.where === 'serve' && !callsLeave) chainLog(`remote: model calls are for this machine's slots only (${opts.model ? 'the run answers on a chain, a connection or a stand-in' : 'no --model: a worker runs the model the run names'}); agent sessions${opts.model ? '' : ' too'}`);
    // one pool per open workspace, as wide as a system may answer, at most 16
    if (database.kind === 'postgres') database.poolSize = Math.min(EVAL_POOL_MAX, answerCap(opts, placement) ?? EVAL_POOL_MAX);
    const state = shimState({ cacheDir: store.cacheDir(), embeddingTokenCap: opts.embeddingTokenCap });
    const placed = new PublishedChatBackend(backend, remote, { model: opts.model ?? '', eligible: callsLeave ? 'any' : 'local' });
    // a private pack's calls stay on this machine (packs share the caches)
    const placedHere = callsLeave ? new PublishedChatBackend(backend, remote, { model: opts.model ?? '', eligible: 'local' }) : placed;
    // a pack with a private source never leaves: its scoring neither, and the judge scores packs together
    const anyPrivate = opts.packs.some((dir) => !packMayLeave(loadPack(dir)));
    const judgeLeaves = !opts.overrides?.judge && !opts.judgeChain ? judgeAgent(opts.judgeProvider ?? 'claude-cli', opts.judgeModel ?? '') : null;
    if (remote.where === 'serve' && judgeLeaves && anyPrivate) chainLog('remote: the judge is for this machine\'s slots only (a pack in this run has private sources)');
    else if (remote.where === 'serve' && !judgeLeaves) chainLog('remote: the judge is for this machine\'s slots only (no --judge-model, or a chain or stand-in judges)');
    const judgeEligible = judgeLeaves && !anyPrivate ? 'any' as const : 'local' as const;
    const judgeClient = remoteJudgeClient(localJudge, remote, {
      family: judgeFamily(opts.judgeProvider ?? 'claude-cli'), model: opts.judgeModel ?? '', effort: judgeLeaves?.effort ?? null,
      eligible: judgeEligible, backend: judgeLeaves ? `${judgeLeaves.family}-cli:${judgeLeaves.model}` : null,
    });
    // this machine's plan is spent only by the run's own Codex slots
    quota.setBypass(() => !remote.hasLocal('codex'));
    if (opts.agentChain) {
      const agents = chain(opts.agentChain);
      const bad = agents.links.find((l) => !l.api && l.name !== 'codex-cli');
      if (bad) throw new Error(`--agent-chain: agents run in Codex; "${bad.name}" is neither an API connection nor codex-cli`);
      setAgentRouting({
        pick: () => agents.pick(),
        charge: (name, model, usage) => void agents.charge(agents.links.find((l) => l.name === name)!, model, usage, { role: 'agent' }),
        exhaust: (name, why) => agents.exhaust(agents.links.find((l) => l.name === name)!, why),
      });
    }
    // the judge is as wide as the slots online that take its calls, at most --judge-concurrency
    const judge = new Judge({
      client: judgeClient, meter, quota, cacheFile: path.join(store.cacheDir(), 'judge.jsonl'),
      width: judgeWidth(remote, judgeFamily(opts.judgeProvider ?? 'claude-cli'), judgeEligible, judgeCap(opts, placement)),
      listBatchSize: opts.judgeListBatch,
    });
    const models = { model: opts.model ?? '', buildEffort: opts.buildEffort ?? 'low', answerEffort: opts.answerEffort ?? 'medium' };
    judge.audit(judgeAuditFor(opts.judgeAudit, seed, store));

    if (opts.reuseBuildsFrom) {
      const groups = new Set(makeSystems(opts.systems).map((sys) => sys.group).filter((g) => !opts.rebuild?.includes(g)));
      const n = reuseBuilds(store, path.resolve(opts.reuseBuildsFrom), opts.packs, `${embedder.model} (${embedder.dimensions})`, fraction, seed, groups, rootPlace);
      progress(`reusing ${n.builds} builds and ${n.vectors} embedding vectors from ${opts.reuseBuildsFrom}${opts.rebuild?.length ? `; building ${opts.rebuild.join(', ')} afresh` : ''}`);
      if (n.updated.length) progress(`building again, since ${opts.reuseBuildsFrom} updated them after building: ${n.updated.join(', ')}`);
      store.log('builds reused', { from: opts.reuseBuildsFrom, ...n });
    }

    const shimOptions = {
      embedder,
      meter,
      state,
      buildEffort: models.buildEffort,
      answerEffort: models.answerEffort,
      embeddingBudget: budget,
    };
    const shim = await startShim({ ...shimOptions, backend: placed });
    opened.shim = shim;
    // a private pack's calls go to a shim that publishes them for this machine's slots only
    const localShim = placedHere !== placed ? await startShim({ ...shimOptions, backend: placedHere }) : shim;
    opened.localShim = localShim;

    // the agent sample's allocation and update cap: what the command line gives, or on a resume what the run recorded
    const before = store.meta();
    const allocation = agentAllocationFor(opts.agentAllocation, before);
    const recordedUpdates = before ? before.agentSample?.updateLimit ?? null : undefined;
    if (recordedUpdates !== undefined && opts.agentUpdateLimit !== undefined && recordedUpdates !== opts.agentUpdateLimit) {
      throw new Error(`run ${before!.id} gave its agents ${recordedUpdates === null ? 'every update task' : `at most ${recordedUpdates} update tasks a pack`}: resume it with that (or no --agent-update-limit), or start a new run`);
    }
    const agentUpdateLimit = opts.agentUpdateLimit ?? recordedUpdates ?? null;
    const agentLimit = opts.agentLimit ?? 30;
    if (allocation) progress(`agent sample: ${agentLimit} a pack by ${describeAllocation(allocation)}`);

    const meta: RunMeta = store.meta() ?? {
      id: path.basename(runDir),
      createdAt: new Date().toISOString(),
      gitSha: gitSha(),
      knodeVersion: knodeVersion(),
      packs: opts.packs.map((p) => path.basename(p)),
      systems: opts.systems,
      suites: [...suites],
      model: { connection: opts.replayOnly ? 'replay-only' : opts.chatChain ?? opts.chatConnection ?? 'codex-cli', label: backend.label, buildEffort: models.buildEffort, answerEffort: models.answerEffort, ...(opts.agentChain ? { agents: opts.agentChain } : {}) },
      judge: { connection: opts.judgeChain ?? opts.judgeProvider ?? 'claude-cli', label: judgeClient.label },
      embedding: `${embedder.model} (${embedder.dimensions})`,
      database: { kind: database.kind, at: describeDatabase(database), ...(database.kind === 'postgres' ? { poolSize: database.poolSize } : {}) },
      ...(rootPlace ? { workspaces: 'root' as const, evalRoot: rootPlace.root } : {}),
      fraction,
      seed,
      limit: opts.limit ?? null,
      versions: {},
      ...(opts.types?.length ? { types: opts.types } : {}),
    };
    meta.database ??= { kind: database.kind, at: describeDatabase(database) };
    meta.agentSample = { limit: agentLimit, updateLimit: agentUpdateLimit, allocation, byPack: meta.agentSample?.byPack ?? {}, updates: meta.agentSample?.updates ?? {} };
    store.writeMeta(meta);
    opened.meta = meta;

    // a system answers as wide as the slots online that could take its work, at most --answer-concurrency (docs/design/32 §3)
    const cap = answerCap(opts, placement);
    const concurrencyFor = (s: SystemUnderTest, leaves: boolean) => () => {
      const scope = new PackScope(remote, leaves, leaves && callsLeave ? 'any' : 'local');
      const width = isAgent(s) ? scope.sessionSlots(leaves && Boolean(opts.model) && !opts.agentChain ? 'any' : 'local') : scope.callSlots();
      return Math.max(1, Math.min(cap ?? Infinity, width));
    };
    const repeat = Math.max(1, Math.trunc(opts.repeat ?? 1));
    const repeatsOf = (s: SystemUnderTest) => (repeat > 1 && (!opts.repeatSystems?.length || opts.repeatSystems.includes(s.id)) ? repeat : 1);
    if (repeat > 1) meta.repeat = { n: repeat, systems: opts.repeatSystems?.length ? opts.repeatSystems : opts.systems, ...(opts.repeatSample ? { sample: opts.repeatSample } : {}) };
    // the tasks a repeat after the first asks: all of them, or the seeded sample (`--repeat-sample`)
    const repeatedTasks = (tasks: Task[], r: number, sample: Set<string> | null) => (r === 1 || !sample ? tasks : tasks.filter((t) => sample.has(t.id)));
    if (remote.where === 'serve') meta.remote = { serve: opts.remote!.serveUrl, calls: callsLeave, judge: Boolean(judgeLeaves && !anyPrivate) };
    // where its work goes, as this start of the run has it (docs/design/32): a resume with other slots says so here
    meta.work = {
      broker: remote.where, ...(remote.where === 'serve' ? { serve: opts.remote!.serveUrl } : {}),
      local: placement.local, pool: remote.pool, waitMinutes: remote.waitMinutes, legacy: placement.legacy,
    };
    delete meta.stuck;
    recordAskOptions(meta, opts.systems);
    store.writeMeta(meta);
    const tasksByKey = new Map<string, Task>();
    const corpusDocs = new Map<string, Set<string>>();
    const citing = new Set<string>();

    // a run stopped by a signal takes down what it started and the temp directories it holds;
    // one killed outright leaves them for the next run's sweep
    const swept = sweepStaleTempDirs();
    if (swept) progress(`removed ${swept} temp directories of runs that are gone`);
    // and the evaluation schemas whose run directory is gone: listed, never dropped here (`eval drop --orphaned` does)
    if (database.kind === 'postgres') {
      const orphans = await orphanedEvalSchemas(database).catch(() => []);
      if (orphans.length) {
        progress(`${orphans.length} evaluation schemas in ${describeDatabase(database)} belong to workspaces that are gone (${orphans.slice(0, 3).map((o) => o.schema).join(', ')}${orphans.length > 3 ? ', …' : ''}): \`knode-os eval drop --orphaned\` drops them`);
        store.log('orphaned evaluation schemas', { database: describeDatabase(database), schemas: orphans.map((o) => o.schema) });
      }
    }
    const onSignal = (signal: NodeJS.Signals) => {
      closeAdapters();
      removeHeldTempDirs();
      // what is out with workers is withdrawn and its session tokens die before this process does
      stop.abort();
      void remote.cancel().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    opened.onSignal = onSignal;

    // every pack is validated before anything is spent on any of them
    const packs = opts.packs.map((dir) => {
      const pack = loadPack(dir);
      const issues = validatePack(pack);
      if (issues.errors.length) throw new Error(`pack ${pack.manifest.id} is invalid:\n- ${issues.errors.slice(0, 20).join('\n- ')}`);
      for (const w of issues.warnings) store.log('pack warning', { pack: pack.manifest.id, warning: w });
      return pack;
    });
    if (opts.embeddingEndpoint && onEndpoint) {
      // against the vectors the run holds; a run that holds too few is checked against the workspace's embedder itself
      try {
        const check = await checkEndpoint(onEndpoint, shim.vectors, packs).catch(async (err) => {
          if (!/can be checked against only/.test(String(err))) throw err;
          return calibrateEndpoint(onEndpoint, configured, packs);
        });
        progress(`embedding on ${opts.embeddingEndpoint} as ${embedder.model}: ${check.texts} texts came back at cosine ${check.lowest.toFixed(5)} or more`);
        store.log('embedding endpoint', { url: opts.embeddingEndpoint, identity: embedder.model, ...check });
      } catch (err) {
        // unreachable: the fallback takes over; a model that does not reproduce the vectors is refused either way
        if (!opts.embeddingFallback || !/econnrefused|fetch failed|etimedout|enotfound|socket hang up|connection (refused|reset)|network/i.test(String(err))) throw err;
        progress(`embedding endpoint ${opts.embeddingEndpoint} unreachable: embedding on ${configured.model}`);
        store.log('embedding endpoint unreachable', { url: opts.embeddingEndpoint, error: String(err).slice(0, 200) });
      }
    }
    const runPack = async (pack: LoadedPack) => {
      const staged = stageCorpus(pack, { fraction, seed });
      loaded.push({ pack, staged });
      corpusDocs.set(pack.manifest.id, new Set(staged.docs.map((d) => d.path)));
      for (const t of pack.tasks) tasksByKey.set(`${pack.manifest.id}|${t.id}`, t);
      progress(`pack ${pack.manifest.id}: ${staged.docs.length} documents${staged.padded ? ` (${staged.padded} of them padding)` : ''}, ${staged.tasks.length} tasks`);
      const leaves = packMayLeave(pack);
      if (remote.where === 'serve' && !leaves) progress(`pack ${pack.manifest.id} has private sources: all its work is for this machine's slots only`);
      const packShim = leaves ? shim : localShim;
      const chars = staged.docs.reduce((n, d) => n + fs.readFileSync(path.join(staged.dir, d.path), 'utf8').length, 0);
      meta.staged = { ...meta.staged, [pack.manifest.id]: { documents: staged.docs.length, padded: staged.padded, chars, tasks: staged.tasks.length } };
      store.writeMeta(meta);

      const systems = makeSystems(opts.systems).filter((s) => s.applicable?.(pack, staged) ?? true);
      for (const s of systems) if (s.answers && s.kind !== 'reference' && s.cites !== false) citing.add(s.id);
      const groups = new Map<string, SystemUnderTest[]>();
      for (const s of systems) (groups.get(s.group) ?? groups.set(s.group, []).get(s.group)!).push(s);

      const failed = new Set<string>();
      const typed = opts.types?.length ? staged.tasks.filter((t) => opts.types!.includes(t.type)) : staged.tasks;
      const allTasks = selectTasks(typed.filter((t) => !t.afterUpdate), suites, opts.limit, seed);
      const updateTasks = suites.has('update') ? typed.filter((t) => t.afterUpdate) : [];
      // the agent sample: round-robin over types, or by the run's allocation
      const shares = allocation ? sharesFor(allocation, path.basename(pack.dir), pack.manifest.id) : null;
      const agentTasks = selectTasks(allTasks, suites, agentLimit, seed, shares);
      // the update tasks agents answer: all, or a seeded sample stratified by type (`--agent-update-limit`)
      const agentUpdates = agentUpdateLimit === null ? null : new Set(selectTasks(updateTasks, suites, agentUpdateLimit, seed).map((t) => t.id));
      meta.agentSample!.byPack[pack.manifest.id] = sampleByType(allTasks, agentTasks, shares);
      if (updateTasks.length) meta.agentSample!.updates[pack.manifest.id] = { available: updateTasks.length, taken: agentUpdates?.size ?? updateTasks.length };
      store.writeMeta(meta);
      if (allocation) progress(`[${pack.manifest.id}] agents answer ${agentTasks.length} of ${allTasks.length}: ${Object.entries(meta.agentSample!.byPack[pack.manifest.id]).map(([t, c]) => `${t} ${c.taken}/${c.available}`).join(', ')}`);
      // the repeat sample: drawn from the tasks every repeated system answers (an agent answers its own subset), so pairs compare
      const repeated = systems.filter((s) => s.answers && repeatsOf(s) > 1);
      const repeatPool = repeated.some(isAgent) ? agentTasks : allTasks;
      const repeatSample = repeatSampleOf(repeatPool, opts.repeatSample, seed);

      for (const [group, members] of groups) {
        const env: SystemEnv = {
          runId: meta.id,
          pack,
          staged,
          workDir: store.workDir(pack.manifest.id, group),
          shim: packShim,
          meter,
          quota,
          models,
          log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`),
          database,
          ...(rootPlace ? { evalRoot: rootPlace } : {}),
        };
        if (!(await buildGroup(store, meter, env, group, members, fraction, seed, progress, stop.signal))) {
          failed.add(group);
          continue;
        }
        for (const s of members) {
          for (const other of members) if (other !== s) await other.release?.(env);
          const tasks = isAgent(s) ? agentTasks : allTasks;
          for (let r = 1; r <= repeatsOf(s); r++) await answerAll(store, meter, env, s, repeatedTasks(tasks, r, repeatSample), fraction, seed, concurrencyFor(s, leaves), progress, undefined, r, stop.signal);
          await retrieveAll(store, env, s, allTasks, fraction, seed, stop.signal);
        }
        // generated knowledge, once per build
        const exporter = members.find((s) => s.exportKnowledge);
        if (exporter && suites.has('generation') && !opts.skipScoring) {
          const done = store.score(recordKey('gen', pack.manifest.id, exporter.id, 'units'));
          if (!done) {
            progress(`[${pack.manifest.id}/${group}] scoring generated knowledge`);
            const units = await exporter.exportKnowledge!(env);
            try {
              for (const r of await scoreGeneration(pack, exporter.id, units, judge, taggedEmbedder(env, { system: '__score__', stage: 'embed' }), { seed })) store.putScore(r);
            } catch (err) {
              if (!(err instanceof PieceStuckError)) throw err;
              progress(`[${pack.manifest.id}/${group}] generated knowledge left unscored for a resume: a judge call is stuck`);
            }
          }
        }
        for (const s of members) await s.release?.(env);
      }

      // update batches, in order and cumulatively up to the last one a task asks after: apply each to the
      // staged corpus, let every system that can update (its cost recorded per batch), then ask that batch's tasks
      const last = updateTasks.map((t) => t.afterUpdate!).sort().at(-1);
      const batches = last ? pack.updates.filter((b) => b <= last) : [];
      for (const batch of batches) {
        const files = stageUpdate(pack, staged, batch);
        for (const f of files) corpusDocs.get(pack.manifest.id)!.add(f);
        const tasks = updateTasks.filter((t) => t.afterUpdate === batch);
        for (const [group, members] of groups) {
          if (failed.has(group)) continue;
          const env: SystemEnv = { runId: meta.id, pack, staged, workDir: store.workDir(pack.manifest.id, group), shim: packShim, meter, quota, models, log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`), database, ...(rootPlace ? { evalRoot: rootPlace } : {}) };
          const updater = members.find((s) => s.update);
          const key = recordKey('update', pack.manifest.id, group, batch, fraction, seed);
          if (updater && !store.build(key)) {
            const mark = meter.mark();
            const t0 = Date.now();
            let ok = true;
            let error: string | undefined;
            const stuckMark = remote.stuck.length;
            try {
              await withPieceTag({ system: group }, () => updater.update!(files, env, batch));
            } catch (err) {
              ok = false;
              error = err instanceof Error ? err.message : String(err);
            }
            if (stop.signal.aborted) throw new RunCancelledError();
            if (remote.stuckFor(stuckMark, group).length || (error && /^cancelled:/.test(error))) {
              progress(`[${pack.manifest.id}/${group}] update ${batch} left for a resume: ${error && /^cancelled:/.test(error) ? 'its session was cancelled' : 'a piece of it is stuck'}`);
              failed.add(group);
              continue;
            }
            store.putBuild({ key, pack: pack.manifest.id, system: `${group}@${batch}`, ok, error, ms: Date.now() - t0, usage: meter.usage((e) => e.system === group, mark), stages: meter.stages(group, mark), bytes: 0, notes: { batch, files: files.length, tasks: tasks.length }, at: new Date().toISOString(), ...where(meter.placement((e) => e.system === group, mark)) });
          } else {
            // nothing to update, or a resumed run that updated already: reopen on the staged corpus as it now is
            for (const s of members) await s.reopen?.(env).catch(() => {});
          }
          const batchSample = repeatSampleOf(tasks, opts.repeatSample, seed);
          for (const s of members) {
            const own = isAgent(s) && agentUpdates ? tasks.filter((t) => agentUpdates.has(t.id)) : tasks;
            for (let r = 1; r <= repeatsOf(s); r++) await answerAll(store, meter, env, s, repeatedTasks(own, r, batchSample), fraction, seed, concurrencyFor(s, leaves), progress, batch, r, stop.signal);
          }
          for (const s of members) await s.release?.(env);
        }
      }
      // done with the pack: its builds are let go of (the viewer may open them)
      for (const [group, members] of groups) {
        const env: SystemEnv = { runId: meta.id, pack, staged, workDir: store.workDir(pack.manifest.id, group), shim: packShim, meter, quota, models, log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`), database, ...(rootPlace ? { evalRoot: rootPlace } : {}) };
        for (const s of members) await s.finish?.(env);
      }
    };
    // a pack the embedding budget cut short waits for it to open, then goes on where it stopped
    const runPackWithinBudget = async (pack: LoadedPack) => {
      for (;;) {
        const before = budget.refusals;
        try {
          // a pack's agent sessions may leave unless a source of it is private (src/eval/placement.ts)
          const leaves = packMayLeave(pack);
          await withRemote(new PackScope(remote, leaves, leaves && callsLeave ? 'any' : 'local'), () => runPack(pack));
        } catch (err) {
          if (budget.refusals === before) throw err;
        }
        if (budget.refusals === before) return;
        progress(`[${pack.manifest.id}] cut short by the embedding budget: going on once it opens`);
        await budget.wait();
      }
    };
    await mapLimit(packs, opts.packConcurrency ?? 1, runPackWithinBudget, (err, pack) => {
      progress(`pack ${pack.manifest.id} stopped: ${err instanceof Error ? err.message : String(err)}`);
      store.log('pack failed', { pack: pack.manifest.id, error: err instanceof Error ? err.message : String(err) });
    });

    if (stop.signal.aborted) throw remote.stopped ?? new RunCancelledError();
    if (!opts.skipScoring) {
      try {
        await scoreAnswers(store, judge, { tasks: tasksByKey, corpusDocs, citing }, progress, meter);
      } catch (err) {
        // the pass writes its scores at its end: a stuck judge call leaves the whole pass for a resume (its verdicts are cached)
        if (!(err instanceof PieceStuckError)) throw err;
        progress('scoring left for a resume: a judge call is stuck');
      }
    }
    const c = remote.counts;
    progress(`work: ${c.published} pieces published; ${c.workers} served by workers, ${c.local} by this run's own slots${remote.stuck.length ? `; ${remote.stuck.length} stuck` : ''}`);
    store.log('work', { ...c, stuck: remote.stuck.length, broker: remote.where });
    if (remote.stuck.length) progress(`incomplete: ${remote.stuck.length} piece(s) three different workers could not serve were left unanswered; resume with --run-dir ${runDir} once workers can`);
  } catch (err) {
    // a run the wait limit stopped says so, whatever stopped first on the way out
    if (remote.stopped) {
      remote.stopped.runDir = runDir;
      store.log('stopped', { reason: remote.stopped.message.slice(0, 500) });
    }
    throw remote.stopped ?? err;
  } finally {
    // the stuck pieces of this start of the run, for its report, however it ended
    if (remote.stuck.length && opened.meta) {
      opened.meta.stuck = remote.stuck.map((p) => ({ ...p, lastError: p.lastError.slice(0, 500) }));
      store.writeMeta(opened.meta);
    }
    remote.close();
    await remote.drained();
    setAgentRouting(null);
    if (opened.onSignal) {
      process.off('SIGINT', opened.onSignal);
      process.off('SIGTERM', opened.onSignal);
    }
    opts.signal?.removeEventListener('abort', onAbort);
    setAgentStopping(null);
    if (stop.signal.aborted) await remote.cancel();
    remote.close();
    quota.setBypass(null);
    closeAdapters();
    // what a pack still holds open — its index and tool host — when the run ends early
    await closeKnodeStates(runDir);
    await opened.shim?.close();
    if (opened.localShim && opened.localShim !== opened.shim) await opened.localShim.close();
    for (const l of loaded) l.staged.cleanup();
  }
  return { runDir, builds: store.allBuilds().length, answers: store.allAnswers().length, scores: store.allScores().length, stuck: remote.stuck.length };
}

/**
 * Copy another run's finished builds of these packs, and its embedding
 * vectors, into this run. Refused when the other run embedded with another
 * model: a knode index or a RAG index answers queries only in its own space.
 * A build the other run updated (`<group>@<batch>`, applied in place) is left
 * out and listed in `updated`: its work directory holds the updated corpus.
 */
export function reuseBuilds(store: RunStore, from: string, packDirs: string[], embedding: string, fraction: number, seed: string | number, groups?: Set<string>, rootPlace?: EvalRootPlacement | null): { builds: number; vectors: number; updated: string[] } {
  const src = new RunStore(from);
  const meta = src.meta();
  if (!meta) throw new Error(`--reuse-builds-from: not a run directory: ${from}`);
  if (meta.embedding !== embedding) throw new Error(`--reuse-builds-from: ${meta.id} embedded with ${meta.embedding}; this run embeds with ${embedding}`);
  let builds = 0;
  const updated: string[] = [];
  for (const dir of packDirs) {
    const pack = loadPack(dir);
    const all = src.allBuilds().filter((x) => x.pack === pack.manifest.id);
    for (const b of all.filter((x) => x.ok && !x.system.includes('@') && (!groups || groups.has(x.system)))) {
      if (b.key !== recordKey('build', pack.manifest.id, pack.manifest.version, b.system, fraction, seed) || store.build(b.key)) continue;
      if (all.some((x) => x.system.startsWith(`${b.system}@`))) {
        updated.push(`${pack.manifest.id}/${b.system}`);
        continue;
      }
      const work = path.join(from, 'work', pack.manifest.id, b.system);
      const dest = store.workDir(pack.manifest.id, b.system);
      // the build's workspace: in the other run's evaluation root (`workspace.json`), or in its run directory (`ws`)
      const pointer = readWorkspacePointer(work);
      const sourceWs = pointer?.dir ?? (fs.existsSync(path.join(work, 'ws', 'knode.config.json')) ? path.join(work, 'ws') : null);
      // not an index lock (src/store: `.knode/db.lock`, the pid that holds a PGlite directory open): it is the
      // other run's process, and the copy is this run's to open
      const notLock = (src: string) => path.basename(src) !== 'db.lock';
      if (fs.existsSync(work)) {
        fs.cpSync(work, dest, {
          recursive: true,
          // the workspace goes where this run keeps its builds, below; the other run's pointer to its own is not this run's
          filter: (src) => notLock(src) && src !== path.join(work, WORKSPACE_POINTER) && !(rootPlace && sourceWs && src === path.join(work, 'ws')),
        });
      }
      if (sourceWs && fs.existsSync(sourceWs) && rootPlace) {
        // a workspace of this run's own in the root, its manifest this run's; the index is made its own when it is reopened
        const ws = placeEvalWorkspace(rootPlace, pack.manifest.id, b.system);
        fs.rmSync(ws, { recursive: true, force: true });
        fs.cpSync(sourceWs, ws, { recursive: true, filter: (src) => notLock(src) && !/\.workspace\.json\.\d+\.tmp$/.test(src) });
        const theirs = readEvalManifest(sourceWs)?.evaluation;
        const made = newEvalManifest(rootPlace, ws, {
          pack: pack.manifest.id, packVersion: pack.manifest.version, group: b.system, fingerprint: theirs?.fingerprint, models: theirs?.models, state: 'built',
        });
        const { writer: _writer, ...evaluation } = made.evaluation;
        writeEvalManifest(ws, { ...made, evaluation: { ...evaluation, builtWith: theirs?.builtWith ?? evaluation.builtWith, reusedFrom: path.resolve(from) } as typeof evaluation });
        let index: { kind?: string; schema?: string } = {};
        try {
          index = JSON.parse(fs.readFileSync(path.join(ws, '.knode', 'eval-index.json'), 'utf8')) as typeof index;
        } catch {
          // no record: the reopen says what is missing
        }
        writeWorkspacePointer(dest, { dir: ws, kind: index.kind ?? 'pglite', ...(index.schema ? { schema: index.schema } : {}) });
      } else if (sourceWs && pointer && fs.existsSync(sourceWs)) {
        // a run made before keeps its builds in its own directory, whatever the other run did
        fs.cpSync(sourceWs, path.join(dest, 'ws'), { recursive: true, filter: (src) => notLock(src) && !/\.workspace\.json\.\d+\.tmp$/.test(src) });
      }
      store.putBuild({ ...b, notes: { ...b.notes, reusedFrom: meta.id, builtAt: b.at } });
      builds++;
    }
  }
  // the vectors the reused indexes were built with, so a reopened RAG index embeds nothing again — and
  // also when no build is reused (`--rebuild knode` beside systems that build nothing): they are what
  // an embedding endpoint is checked against, and without them the check falls to the workspace's
  // embedder, which stopped a run cold on a day its pool was out of quota
  let vectors = 0;
  const from_ = path.join(from, 'cache', 'vectors.jsonl');
  const to = path.join(store.cacheDir(), 'vectors.jsonl');
  if (fs.existsSync(from_) && !fs.existsSync(to)) {
    fs.copyFileSync(from_, to);
    vectors = fileLineCount(to);
  }
  return { builds, vectors, updated };
}

function fileLineCount(file: string): number {
  let n = 0;
  for (const line of fileLines(file)) if (line.trim()) n++;
  return n;
}

/** Build (or reopen) a group's knowledge base; false when it failed, so the run goes on without it. */
/**
 * Judge every answer not scored yet, or answered again since its score: one
 * blind pass over all systems at once (usage), then the emergence probes.
 * The judge is Claude, so this runs while Codex is paused for its plan window.
 */
export async function scoreAnswers(
  store: RunStore, judge: Judge,
  ctx: { tasks: Map<string, Task>; corpusDocs: Map<string, Set<string>>; citing: Set<string> },
  progress: (m: string) => void = () => {},
  meter?: Meter,
): Promise<number> {
  // a repeated answer (`--repeat`) keeps its system; its scores carry `repeat` and keys of their own (score/keys.ts)
  const answers = store.allAnswers().filter((a) => {
    if (!ctx.tasks.has(`${a.pack}|${a.taskId}`)) return false;
    const scored = store.score(scoreKey(a, 'latency_ms'));
    return !scored || scored.at < a.at;
  });
  if (!answers.length) return 0;
  progress(`scoring ${answers.length} answers`);
  const citing = ctx.citing;
  // where the judge's calls ran, on every score of the pass (docs/design/27 §8)
  const mark = meter?.mark() ?? 0;
  const pending: ScoreRecord[] = [];
  const put = (r: ScoreRecord) => pending.push(r);
  // the three scorers ask the judge together (its gate bounds the calls of all three); their records keep this
  // order, and a scorer that failed is thrown only once the others are done, so what they asked is in the cache
  const scored = await Promise.allSettled([
    scoreUsage({ answers, tasks: ctx.tasks, citing }, judge),
    scoreLists({ answers, tasks: ctx.tasks, corpusDocs: ctx.corpusDocs }, judge),
    scoreEmergence({ answers, tasks: ctx.tasks, corpusDocs: ctx.corpusDocs }, judge),
  ]);
  const rejected = scored.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  for (const s of scored) if (s.status === 'fulfilled') for (const r of s.value) put(r);
  const placed = where(meter?.placement((e) => e.system === JUDGE_SYSTEM, mark) ?? null);
  for (const r of pending) store.putScore({ ...r, ...placed });
  return answers.length;
}

/** A record's `worker` and `backend` from where its model calls ran; nothing when it made none. */
function where(p: Placed | null): { worker?: string; backend?: string } {
  return p ? { worker: p.worker, backend: p.backend } : {};
}

/**
 * `knode-os eval score <runDir>`: judge what a run has answered so far, from
 * its records and the packs it names — with no model of its own running, so
 * only while the run itself is stopped.
 */
export async function scoreRun(runDir: string, opts: { judgeProvider?: string; judgeModel?: string; judgeAudit?: number; judgeListBatch?: number; judgeConcurrency?: number; onProgress?: (m: string) => void; remote?: RunOptions['remote']; local?: RunOptions['local']; slots?: number; waitMinutes?: number; waitCheckMs?: number; pool?: string } = {}): Promise<number> {
  const store = new RunStore(runDir);
  const meta = store.meta();
  if (!meta) throw new Error(`not a run directory: ${runDir}`);
  const meter = new Meter(path.join(runDir, 'meter.jsonl'));
  const quota = new QuotaGuard({ enabled: false, log: (m, d) => opts.onProgress?.(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`) });
  const local = new LlmClient({ provider: opts.judgeProvider ?? 'claude-cli', baseUrl: '', apiKey: '', model: opts.judgeModel ?? '', cliPath: '', cliTimeoutMs: 600_000 });
  const tasks = new Map<string, Task>();
  const corpusDocs = new Map<string, Set<string>>();
  const packs: LoadedPack[] = [];
  for (const name of meta.packs) {
    const dir = path.isAbsolute(name) ? name : path.join(packsDir(), name);
    if (!fs.existsSync(path.join(dir, 'pack.json'))) continue;
    packs.push(loadPack(dir));
  }
  // the judge's calls are published as a run's (docs/design/32): to serve's broker, or the scoring's own with its own slots
  const agent = judgeAgent(opts.judgeProvider ?? 'claude-cli', opts.judgeModel ?? '');
  const family = judgeFamily(opts.judgeProvider ?? 'claude-cli');
  const log = (m: string) => opts.onProgress?.(m);
  const placement = runPlacement(opts, family);
  if (placement.legacy) log(`work: no --remote and no --local: the judge runs on this machine, on --local ${describeLocal(placement.local!)} (sized from --slots)`);
  const run = queueRunId(`${meta.id}-score`);
  const waiting = { pool: opts.pool, waitMinutes: opts.waitMinutes ?? 30, checkMs: opts.waitCheckMs, logEveryMs: opts.waitCheckMs ? opts.waitCheckMs * 12 : undefined };
  // the scoring's pieces are its own: another scope than the run's answers
  let remote = opts.remote ? await RemoteEval.connect({ ...opts.remote, run, scope: `${runDir}#score`, quota, log, ...waiting }) : null;
  if (opts.remote && !remote) log(`work: serve is not answering: scoring publishes to a broker of its own${placement.local ? '' : ', and with no --local nothing takes its calls'}`);
  remote ??= RemoteEval.own({ run, scope: `${runDir}#score`, quota, log, ...waiting });
  try {
    return await scoreWith(remote);
  } catch (err) {
    throw remote.stopped ?? err;
  } finally {
    remote.close();
  }

  async function scoreWith(remote: RemoteEval): Promise<number> {
    // never for a run with a private pack
    const eligible = agent && packs.every(packMayLeave) ? 'any' as const : 'local' as const;
    const client = remoteJudgeClient(local, remote, {
      family, model: opts.judgeModel ?? '', effort: agent?.effort ?? null,
      eligible, backend: agent ? `${agent.family}-cli:${agent.model}` : null,
    });
    const judge = new Judge({ client, meter, quota, cacheFile: path.join(store.cacheDir(), 'judge.jsonl'), width: judgeWidth(remote, family, eligible, judgeCap(opts, placement)), listBatchSize: opts.judgeListBatch });
    for (const pack of packs) {
      for (const t of pack.tasks) tasks.set(`${pack.manifest.id}|${t.id}`, t);
      const docs = new Set(pack.docs.map((d) => d.path));
      for (const batch of pack.updates) for (const f of listFiles(path.join(pack.dir, 'updates', batch))) docs.add(f);
      corpusDocs.set(pack.manifest.id, docs);
    }
    judge.audit(judgeAuditFor(opts.judgeAudit, meta!.seed, store));
    const citing = new Set(makeSystems(meta!.systems).filter((s) => s.answers && s.kind !== 'reference' && s.cites !== false).map((s) => s.id));
    // the scoring's own slots start last: anything above that throws leaves none behind
    if (placement.local) remote.startLocal(placement.local);
    return scoreAnswers(store, judge, { tasks, corpusDocs, citing }, opts.onProgress, meter);
  }
}

/**
 * `--judge-audit`: the share of the judge's verdicts asked a second time
 * (default 5%, at least 20 a pass), every pair written to the run's
 * `judge-audit.jsonl`; 0 turns it off.
 */
export function judgeAuditFor(share: number | undefined, seed: string | number, store: RunStore): JudgeAudit | null {
  const s = share ?? AUDIT_DEFAULT_SHARE;
  if (!Number.isFinite(s) || s < 0 || s > 1) throw new Error('--judge-audit: a share between 0 and 1');
  return s > 0 ? { share: s, seed, record: (r) => store.putJudgeAudit(r) } : null;
}

/** Usages added field by field. */
function addUsage(a: Usage, b: Usage): Usage {
  const out = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof Usage, number][]) if (typeof v === 'number') out[k] = ((out[k] as number | undefined) ?? 0) + v;
  return out;
}

/**
 * A resumed build's record (`resumed` in its notes): the earlier attempt's
 * time and cost counted with this one's, since both went into the build, and
 * what that attempt ended with.
 */
export function withEarlierAttempt(rec: BuildRecord, earlier: BuildRecord | null): BuildRecord {
  const own = (rec.notes?.resumed && typeof rec.notes.resumed === 'object' ? rec.notes.resumed : {}) as Record<string, unknown>;
  const resumed = { ...own, ...(earlier ? { earlier: { at: earlier.at, error: earlier.error ?? null, ms: earlier.ms, weightedTokens: earlier.usage.weightedTokens, embeddingTokens: earlier.usage.embeddingTokens } } : { earlier: null }) };
  if (!earlier) return { ...rec, notes: { ...rec.notes, resumed } };
  const stages = { ...earlier.stages };
  for (const [k, u] of Object.entries(rec.stages)) stages[k] = stages[k] ? addUsage(stages[k], u) : u;
  return {
    ...rec, ms: rec.ms + earlier.ms, usage: addUsage(earlier.usage, rec.usage), stages,
    peakRssBytes: Math.max(rec.peakRssBytes ?? 0, earlier.peakRssBytes ?? 0) || undefined, notes: { ...rec.notes, resumed },
  };
}

async function buildGroup(store: RunStore, meter: Meter, env: SystemEnv, group: string, members: SystemUnderTest[], fraction: number, seed: string | number, progress: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new RunCancelledError();
  const builder = members.find((s) => s.build);
  if (!builder) return true;
  const key = recordKey('build', env.pack.manifest.id, env.pack.manifest.version, group, fraction, seed);
  const done = store.build(key);
  if (done?.ok) {
    progress(`[${env.pack.manifest.id}/${group}] reusing build from ${done.at}`);
    try {
      await builder.reopen?.(env);
      return true;
    } catch (err) {
      // another run's build that cannot be made this run's own (its schema gone, another backend): built afresh
      const from = (done.notes as { reusedFrom?: string } | undefined)?.reusedFrom;
      if (!from) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      progress(`[${env.pack.manifest.id}/${group}] cannot reuse the build of ${from} (${reason}): building afresh`);
      store.log('reused build rebuilt', { pack: env.pack.manifest.id, group, from, reason });
    }
  }
  // an earlier attempt of this build that stopped or failed, which the builder continues from: its cost is the build's too
  const resuming = Boolean(builder.resumable?.(env));
  const earlier = resuming && done && !done.ok ? done : null;
  progress(`[${env.pack.manifest.id}/${group}] ${resuming ? 'resuming the build' : 'building'}`);
  if (resuming) store.log('build resumed', { pack: env.pack.manifest.id, group, ...(earlier ? { earlierError: earlier.error, earlierAt: earlier.at } : {}) });
  const mark = meter.mark();
  const t0 = Date.now();
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 1000);
  let rec: BuildRecord;
  const remote = currentRemote<PackScope>()?.remote;
  const stuckMark = remote?.stuck.length ?? 0;
  try {
    const r = await withPieceTag({ system: group }, () => builder.build!(env));
    rec = {
      key, pack: env.pack.manifest.id, system: group, ok: true, ms: Date.now() - t0,
      usage: meter.usage((e) => e.system === group && !e.task, mark), stages: meter.stages(group, mark),
      bytes: r.kbDir ? kbBytes(group, r.kbDir) : 0, peakRssBytes: peak, notes: r.notes, at: new Date().toISOString(),
      ...where(meter.placement((e) => e.system === group && !e.task, mark)),
    };
  } catch (err) {
    rec = {
      key, pack: env.pack.manifest.id, system: group, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0,
      usage: meter.usage((e) => e.system === group && !e.task, mark), stages: meter.stages(group, mark), bytes: 0, peakRssBytes: peak, at: new Date().toISOString(),
      ...where(meter.placement((e) => e.system === group && !e.task, mark)),
    };
    progress(`[${env.pack.manifest.id}/${group}] build failed: ${rec.error}`);
  } finally {
    clearInterval(sampler);
  }
  if (resuming) rec = withEarlierAttempt(rec, earlier);
  // a cancelled run writes no record of what it stopped: a resumed run builds it again (knode continues what it left)
  if (signal?.aborted) throw new RunCancelledError();
  // nor a build one of whose pieces is stuck: the group waits for a resume, and the run goes on without it
  if (remote?.stuckFor(stuckMark, group).length || (!rec.ok && rec.error && /^cancelled:/.test(rec.error))) {
    progress(`[${env.pack.manifest.id}/${group}] build left for a resume: ${!rec.ok && rec.error && /^cancelled:/.test(rec.error) ? 'a session of it was cancelled' : 'a piece of it is stuck'}`);
    for (const s of members) await s.release?.(env);
    return false;
  }
  store.putBuild(rec);
  if (!rec.ok) {
    store.log('build failed', { pack: env.pack.manifest.id, group, error: rec.error });
    for (const s of members) await s.release?.(env);
  }
  return rec.ok;
}

function kbBytes(group: string, dir: string): number {
  if (group === 'knode') return dirBytes(path.join(dir, '.knode')) + dirBytes(path.join(dir, 'wiki')) + dirBytes(path.join(dir, '.sidecar'));
  return dirBytes(dir);
}

/**
 * An answer's key. Repeat 1 keeps the key every run has used; a repeat
 * (`--repeat`) adds its index, and its task id carries `~r<n>` while it is
 * answered, so the shim asks the model again instead of replaying.
 */
export function answerKey(pack: string, system: string, taskId: string, fraction: number, seed: string | number, batch?: string, repeat = 1): string {
  return repeat > 1 ? recordKey('answer', pack, system, taskId, fraction, seed, batch, `r${repeat}`) : recordKey('answer', pack, system, taskId, fraction, seed, batch);
}

async function answerAll(
  store: RunStore, meter: Meter, env: SystemEnv, s: SystemUnderTest, tasks: Task[], fraction: number, seed: string | number,
  concurrency: number | (() => number), progress: (m: string) => void, batch?: string, repeat = 1, signal?: AbortSignal,
): Promise<void> {
  if (!s.answers || !s.answer) return;
  const docs = new Set(env.staged.docs.map((d) => d.path));
  // an answer that ended in an error is asked again on resume (a timeout, a backend that was down)
  const todo = tasks.filter((t) => {
    const prev = store.answer(answerKey(env.pack.manifest.id, s.id, t.id, fraction, seed, batch, repeat));
    return !prev || Boolean(prev.error);
  });
  if (!todo.length) return;
  progress(`[${env.pack.manifest.id}/${s.id}] answering ${todo.length} tasks${repeat > 1 ? ` (repeat ${repeat})` : ''}`);
  let done = 0;
  await eachWithin(todo, typeof concurrency === 'number' ? () => concurrency : concurrency, async (task) => {
    if (signal?.aborted) return;
    const key = answerKey(env.pack.manifest.id, s.id, task.id, fraction, seed, batch, repeat);
    // a repeat is asked under `<task>~r<n>`: its own meter tag and reply-cache key
    const t = repeat > 1 ? { ...task, id: `${task.id}~r${repeat}` } : task;
    // every answer, not only agents': one-shot systems spend the same plan
    await env.quota.wait();
    const mark = meter.mark();
    const t0 = Date.now();
    let rec: AnswerRecord;
    const placed = () => ({ ...(repeat > 1 ? { repeat } : {}), ...where(meter.placement((e) => e.system === s.id && e.task === t.id, mark)) });
    const remote = currentRemote<PackScope>()?.remote;
    const stuckMark = remote?.stuck.length ?? 0;
    try {
      const a = await withPieceTag({ system: s.id, task: t.id }, () => s.answer!(t, taskPrompt(task), env));
      rec = {
        key, pack: env.pack.manifest.id, system: s.id, taskId: task.id, ...(batch ? { batch } : {}), at: new Date().toISOString(),
        text: a.text, finalAnswer: extractFinalAnswer(a.text),
        citations: a.citations ?? citationsIn(a.text, docs), retrieved: a.retrieved ?? [], toolCalls: a.toolCalls ?? 0,
        ...(a.commands ? { commands: boundedTrace(a.commands) } : {}),
        // what each command returned, beside it (docs/design/33 D7); absent when the session's events carried none
        ...(a.commands && a.outputs?.some((o) => o) ? { outputs: boundedOutputs(a.outputs.slice(0, a.commands.length)) } : {}),
        ...(a.capped ? { capped: true } : {}), ...(a.leaked?.length ? { leaked: a.leaked } : {}), ...(a.error ? { error: a.error } : {}),
        ...(a.error && /^cancelled:/.test(a.error) ? { cancelled: true } : {}),
        usage: meter.usage((e) => e.system === s.id && e.task === t.id, mark), ms: Date.now() - t0,
        ...placed(),
      };
    } catch (err) {
      rec = {
        key, pack: env.pack.manifest.id, system: s.id, taskId: task.id, ...(batch ? { batch } : {}), at: new Date().toISOString(),
        text: '', finalAnswer: '', citations: [], retrieved: [], toolCalls: 0, error: err instanceof Error ? err.message : String(err),
        usage: meter.usage((e) => e.system === s.id && e.task === t.id, mark), ms: Date.now() - t0,
        ...placed(),
      };
    }
    // a cancelled run writes no record of what it stopped: a resumed run asks it whole
    if (signal?.aborted) return;
    // nor does an answer one of whose pieces is stuck (docs/design/32 §3): it is left for a resume, never answered another way
    if (remote?.stuckFor(stuckMark, s.id, t.id).length) {
      progress(`[${env.pack.manifest.id}/${s.id}] ${task.id}: left unanswered, a piece of it is stuck`);
      return;
    }
    store.putAnswer(rec);
    if (++done % 10 === 0) progress(`[${env.pack.manifest.id}/${s.id}] ${done}/${todo.length}`);
  });
}

/**
 * Each item through `fn`, at most `width()` at once — re-read whenever one
 * ends and every second, so a system answers as wide as the slots online
 * (docs/design/32 §3). A failure of one item is that item's.
 */
export function eachWithin<T>(items: T[], width: () => number, fn: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let next = 0;
    let active = 0;
    const timer = setInterval(() => pump(), 1_000);
    timer.unref?.();
    const pump = () => {
      while (next < items.length && active < Math.max(1, width())) {
        const item = items[next++];
        active++;
        void fn(item).catch(() => {}).finally(() => {
          active--;
          pump();
        });
      }
      if (next >= items.length && active === 0) {
        clearInterval(timer);
        resolve();
      }
    };
    pump();
  });
}

async function retrieveAll(store: RunStore, env: SystemEnv, s: SystemUnderTest, tasks: Task[], fraction: number, seed: string | number, signal?: AbortSignal): Promise<void> {
  if (!s.retrieve) return;
  const { retrievalScores } = await import('./metrics/retrieval.js');
  const remote = currentRemote<PackScope>()?.remote;
  for (const t of tasks) {
    // a stopping run scores nothing more: what it stopped is asked again on resume
    if (signal?.aborted) return;
    if (!t.evidence.length || t.scoring === 'abstain' || t.suite !== 'usage') continue;
    const probe = recordKey('score', env.pack.manifest.id, s.id, t.id, 'recall@5');
    if (store.score(probe)) continue;
    let ranked: string[] = [];
    const stuckMark = remote?.stuck.length ?? 0;
    try {
      ranked = await withPieceTag({ system: s.id, task: t.id }, () => s.retrieve!(t.question, 10, env));
    } catch (err) {
      if (signal?.aborted) return;
      store.log('retrieve failed', { system: s.id, task: t.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // a retrieval whose model call stuck, or that ended as the run stopped, is no ranking to score
    if (signal?.aborted) return;
    if (remote?.stuckFor(stuckMark, s.id).length) continue;
    const r = retrievalScores(ranked, [...new Set(t.evidence.map((e) => e.doc))]);
    const at = new Date().toISOString();
    const put = (metric: string, value: number) => store.putScore({ key: recordKey('score', env.pack.manifest.id, s.id, t.id, metric), pack: env.pack.manifest.id, system: s.id, suite: 'usage', taskId: t.id, taskType: t.type, metric, value, at, detail: metric === 'recall@5' ? { ranked } : undefined });
    for (const k of [2, 5, 10]) put(`recall@${k}`, r.recall[k]);
    put('all@5', r.all[5]);
    put('mrr@10', r.mrr10);
    put('ndcg@10', r.ndcg10);
  }
}

/**
 * `list` reordered so that every prefix of it holds its strata (`meta.stratum`) in proportion to their sizes, to
 * within one task: the j-th of a stratum of m tasks sits at (j + ½) / m of the way through, each stratum in the
 * order it came. A list with one stratum, or none named, is returned as it is.
 */
function interleaveStrata(list: Task[]): Task[] {
  const stratumOf = (t: Task) => (typeof t.meta?.stratum === 'string' ? t.meta.stratum : '');
  const strata = new Map<string, Task[]>();
  for (const t of list) (strata.get(stratumOf(t)) ?? strata.set(stratumOf(t), []).get(stratumOf(t))!).push(t);
  if (strata.size < 2) return list;
  return [...strata.entries()]
    .flatMap(([name, of]) => of.map((task, j) => ({ task, name, at: (j + 0.5) / of.length })))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    .map((x) => x.task);
}

export { emptyUsage };
export { headroomAllocation, typeQuotas, type AgentAllocation, type AgentSample, type TypeEvidence, type TypeShares } from './allocation.js';

/**
 * Record in the run's metadata what knode-ask is asked beyond its defaults, as this start of the run reads it —
 * whenever a run asks knode-ask or a variant of it (`knode-ask-hops`), which read the same settings.
 */
export function recordAskOptions(meta: RunMeta, systems: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (systems.some((id) => id === 'knode-ask' || id.startsWith('knode-ask-'))) meta.askOptions = askOptionsFromEnv(env);
  else delete meta.askOptions;
}
