import fs from 'node:fs';
import type { LearnConfig } from './learn/config.js';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LANGUAGES, LanguagesConfig, normalizeLanguagesConfig } from './lang/languages.js';
import type { PluginSpec } from './plugins/types.js';
import { agentFileNames, isValidAgentName, readAgentFile, renameProfileAgents, upgradeAgentFiles, writeAgentFile } from './research/agent-file.js';

/** The embedding providers knode-os ships with; a plugin may register more (docs/design/11). */
export const BUILTIN_EMBEDDING_PROVIDERS = ['openai', 'ark-multimodal', 'local'] as const;

export interface EmbeddingConfig {
  /**
   * 'openai'         = any OpenAI-compatible /v1/embeddings endpoint;
   * 'ark-multimodal' = Volcengine Ark's /embeddings/multimodal endpoint
   *                    (doubao-embedding-vision-*), which fuses one input into
   *                    a single vector and therefore embeds one text per call;
   * 'local'          = built-in hashing embedder (offline, no key needed);
   * anything else    = an embedding provider a plugin registered.
   */
  provider: string;
  baseUrl: string;
  /** Plain key, or "env:VAR_NAME" to read from the environment. */
  apiKey: string;
  model: string;
  dimensions: number;
  /** openai: texts per request. ark-multimodal: parallel single-text requests. */
  batchSize: number;
  /**
   * Send the `dimensions` request param (OpenAI text-embedding-3+, and Ark's
   * multimodal endpoint). Many OpenAI-compatible routers (litellm, Ollama, …)
   * reject unknown params — leave false unless your endpoint truncates via
   * `dimensions`. When false, `dimensions` must match the model's native
   * output size.
   */
  sendDimensions: boolean;
}

/**
 * One named embedding provider. Structurally the mirror of `LlmConnection`:
 * the endpoint lives here once, and `embedding.use` points at it.
 *
 * Only one can be active at a time. Vectors are comparable only within one
 * model, and the embeddings table has a single column width per workspace, so
 * switching re-embeds the corpus rather than letting two sets coexist.
 */
export interface EmbeddingConnection extends EmbeddingConfig {
  /** Stable key `embedding.use` references. Never reused for a different endpoint. */
  id: string;
  label: string;
  /** Opt out of a model pool without deleting the credential. */
  enabled?: boolean;
  /** Lower numbers are used first; equal priorities rotate fairly. */
  priority?: number;
  /** Keys for one provider account share a quota bucket across workspaces. */
  quotaGroup?: string;
  limits?: EmbeddingLimits;
  limitNote?: string;
  /** Last explicitly refreshed embedding catalog; IDs are provider-native. */
  catalog?: string[];
  /** OpenRouter upstream pin, for example deepinfra/fp32. */
  upstream?: string;
  /**
   * Lend this key to remote workers that hold the `embed-keys` scope
   * (docs/design/12 §4.2): they embed on it under reservations this machine's
   * quota ledger makes. Off unless turned on, key by key.
   */
  lendToWorkers?: boolean;
}

export interface EmbeddingLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  concurrency: number;
  resetTimezone: string;
}

export interface EmbeddingPoolConfig {
  enabled: boolean;
  model: string;
  dimensions: number;
  batchSize: number;
}

/**
 * Where the derived index lives.
 *
 * 'postgres', the default, keeps it on a PostgreSQL server with pgvector. All
 * workspaces share one database and are isolated by schema: a schema is free
 * where a database carries its own ~8 MB catalog, and each schema keeps a
 * private HNSW index (a shared table keyed by workspace could not — HNSW walks
 * a distance-ordered graph, so an equality predicate on a scalar column cannot
 * be pushed into the walk). 'pglite' opts into the same schema embedded in the
 * process, per workspace under `<workspace>/.knode/db`, with nothing to install
 * or run — for offline / zero-setup use and the test suite: a single-process
 * 32-bit WASM build, it tops out around a million chunks and lets one process
 * at a time open the index.
 */
export interface DatabaseConfig {
  /** 'pglite', 'postgres', or the id of a storage backend a plugin registered (docs/design/11). */
  kind: string;
  host: string;
  port: number;
  user: string;
  /** Plain key, or "env:VAR_NAME". Empty when the server uses trust/peer auth. */
  password: string;
  /** The single database every workspace shares. Created on first open. */
  database: string;
  /** Schemas are named `<prefix>_<workspace slug>_<hash of the data dir>`. */
  schemaPrefix: string;
  /**
   * postgres: a connection string (`postgres://user:pass@host:5432/knode`)
   * instead of the host/port/user/password/database fields; "env:VAR_NAME"
   * reads it from the environment. A database named in the URL wins over
   * `database`.
   */
  url?: string;
  /** postgres: TLS — true or 'require' verify the server certificate, 'no-verify' encrypts without verifying. */
  ssl?: boolean | 'require' | 'no-verify';
  /** postgres: connections in one workspace's pool (pg's default is 10). */
  poolSize?: number;
  /** pglite: where the embedded database lives, relative to the workspace or absolute. Default `.knode/db`. */
  path?: string;
  /** Anything a storage plugin needs beyond the fields above. */
  options?: Record<string, unknown>;
  /**
   * Never in a file: set by `Store.open(…, { readOnly: true })` on the copy it
   * hands the backend (docs/design/35 §4). The built-in backends then create
   * nothing — no database, schema or extension — and every transaction they
   * run is read-only (`default_transaction_read_only`).
   */
  readOnly?: boolean;
}

/**
 * What `provider` may name on a connection or a route: a built-in
 * (`BUILTIN_LLM_PROVIDERS`) or an LLM provider a plugin registered. Open so a
 * config may name a provider the running process has not loaded — the client
 * then reports it, rather than the config failing to parse.
 */
export type LlmProvider = string;

/** The LLM providers knode-os ships with. `command` runs any executable as a model (src/llm/providers/command.ts). */
export const BUILTIN_LLM_PROVIDERS = ['openai', 'codex-cli', 'claude-cli', 'cursor-cli', 'opencode-cli', 'command'] as const;

/**
 * The coding-agent CLIs: agents that bring their own loop, kept in `playbooks/agents/`.
 * `opencode-cli` is the one that brings no login of its own: it runs on a model
 * connection's endpoint and key (see `bindAgentEndpoints`).
 */
export const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'cursor-cli', 'opencode-cli'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

export function isCliProvider(provider: unknown): provider is CliProvider {
  return (CLI_PROVIDERS as readonly unknown[]).includes(provider);
}

/**
 * Reasoning effort a CLI provider runs at. `default` leaves the CLI's own
 * setting alone; everything else is passed through (see `effortFor` for the
 * CLIs that cannot take the whole ladder). Research profiles read the same
 * list as `EFFORTS`, so a level means one thing everywhere. `ultra` is the
 * rung codex lists above `max`: maximum reasoning that delegates on its own.
 */
export const LLM_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

/**
 * How fast a CLI provider answers. `default` leaves the CLI's own setting
 * alone; `fast` asks for the priority tier the codex catalog lists as "Fast"
 * (quicker, at higher usage). The other CLIs have no such switch and ignore
 * it — see `speedFor`.
 */
export const LLM_SPEEDS = ['default', 'fast'] as const;
export type LlmSpeed = (typeof LLM_SPEEDS)[number];

/**
 * Which wire an OpenAI-compatible endpoint is spoken to on.
 *
 * 'auto'      = prefer `/responses`, fall back to `/chat/completions` when the
 *               endpoint has no such route. Reasoning models return their
 *               thinking as a first-class output item on the Responses API and
 *               as a non-standard `message.reasoning_content` on Chat
 *               Completions, so preferring Responses loses less.
 * 'responses' = pin the Responses API; a missing route is an error, not a
 *               silent downgrade.
 * 'chat'      = pin Chat Completions, for an endpoint that answers `/responses`
 *               with a lossy shim, or to skip the one-request probe.
 *
 * CLI providers ignore it: they are processes, not endpoints.
 */
export const LLM_PROTOCOLS = ['auto', 'responses', 'chat'] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

export interface LlmConfig {
  /**
   * 'openai'     = any OpenAI-compatible /v1/chat/completions endpoint (needs baseUrl/apiKey);
   * 'codex-cli'  = shell out to the local `codex exec` CLI (reuses its login, no key);
   * 'claude-cli' = shell out to the local `claude -p` CLI (reuses its login, no key);
   * 'cursor-cli' = shell out to the local `cursor-agent -p` CLI (reuses its login, no key);
   * 'opencode-cli' = shell out to the local `opencode run` CLI on `baseUrl` / `apiKey` /
   *                `protocol`, copied from the connection its agent file names;
   * 'command'    = run the executable at `cliPath` once per call (JSON on stdin, reply on stdout);
   * anything else = an LLM provider a plugin registered.
   */
  provider: LlmProvider;
  /** OpenAI-compatible endpoint. Ignored by CLI providers, except opencode-cli, which runs on it. */
  baseUrl: string;
  /** Ignored by CLI providers, except opencode-cli. */
  apiKey: string;
  /**
   * Which wire to speak to an OpenAI-compatible endpoint on. Absent = 'auto'.
   * Ignored by CLI providers, except opencode-cli (see `opencodeProviderNpm`).
   */
  protocol?: LlmProtocol;
  /**
   * openai: empty model disables LLM features (graph falls back to heuristics).
   * CLI providers: empty = the CLI's own default model; otherwise passed as --model.
   */
  model: string;
  /** Override the CLI executable (path or name). Empty = provider default from PATH. */
  cliPath: string;
  /**
   * How hard a CLI provider thinks: claude `--effort`, codex
   * `model_reasoning_effort`, cursor `model[effort=…]`. Absent or 'default'
   * leaves the CLI's own setting alone. OpenAI-compatible endpoints ignore it.
   */
  effort?: LlmEffort;
  /** How fast, see `LLM_SPEEDS`. Absent or 'default' leaves the CLI's own tier alone. */
  speed?: LlmSpeed;
  /** Kill a CLI completion after this long. */
  cliTimeoutMs: number;
  /** Shown in the UI. Empty = llmProviderLabel(provider). */
  label?: string;
  /**
   * opencode-cli only: the model connection the agent file names (`connection`),
   * whose endpoint, key and protocol `bindAgentEndpoints` copies in. '' or
   * 'default' = the default LLM's connection. Read from the agent file; only
   * the `llm` mirror of a default that is an OpenCode agent carries it into
   * the config.
   */
  connection?: string;
  /**
   * 'deepagents' = run the deepagents loop on this endpoint and hand back its
   * final answer, instead of calling the model directly: how a pipeline stage
   * runs a deepagents agent (see `routeTargets`). Never stored; a route
   * resolves it from the agent it names. CLI providers ignore it — their
   * loop is the CLI's own.
   */
  loop?: 'deepagents';
}

/** Per-job LLM routing. `inherit` keeps using the default `llm` connection. */
export interface RoutedLlmConfig extends Omit<LlmConfig, 'provider'> {
  /**
   * Legacy per-route provider. Kept so configs written before named
   * connections keep resolving; `loadConfig` migrates these into `use`.
   */
  provider: 'inherit' | LlmProvider;
  /**
   * What runs this route, by id: a model endpoint or an agent (see
   * `routeTargets`). `model` still overrides that target's own model, so one
   * endpoint can serve several routes at different price points.
   *
   * '' and 'default' followed the default LLM. A stage no longer does —
   * `pinRoutes` writes them down as the default they were running on.
   */
  use: string;
}

/**
 * A named LLM connection. Endpoint and credentials live here once; routes
 * point at one by id instead of repeating them.
 *
 * In `connections` this is a model endpoint. The same shape also carries an
 * agent to the places that call it one-shot (see `llmTargets` and
 * `routeTargets`), which is why `provider` still admits the CLIs.
 */
export interface LlmConnection extends LlmConfig {
  /** Stable key routes reference. Never reused for a different endpoint. */
  id: string;
  /** Shown in the UI. */
  label: string;
}

export interface ExtractionConfig {
  /** Also extract time-bound claims (GraphRAG covariates) in the tier-1 call. */
  claims: boolean;
  /** Model for tier-1 entity/relation extraction. Empty = use llm.model. */
  tier1Model: string;
  /** Provider and model used for tier-1 entity / relation / claim extraction. */
  entityLlm: RoutedLlmConfig;
  /** Vision-capable provider used to convert images and scanned PDF pages to Markdown. */
  documentLlm: RoutedLlmConfig;
  /**
   * The Summarize stage: one summary page per document in raw/docs, written in
   * the background document pass right after extraction (see
   * `summaryLlmClient`, `ensureSourceSummaries`).
   */
  summaryLlm: RoutedLlmConfig;
  /**
   * The Judge stage: knode_ask, Dream, the duplicate-entity review after each
   * extraction pass and at night, and the disputed-claim review — every job
   * that takes `ctx.llm` rather than a stage of its own (see `judgeLlmClient`).
   * A config from before the split starts as its `summaryLlm`, which is where
   * these jobs ran (`migrateJudgeRoute`).
   */
  judgeLlm: RoutedLlmConfig;
  /** New documents get a priority boost that decays over this many days. */
  freshnessBoostDays: number;
  /** Static per-root priority weights for the extraction queue. */
  importance: Record<string, number>;
  /**
   * Model calls one background pass makes: extraction calls (one per segment,
   * so a long document spans several passes) and, separately, summaries (one
   * per document). See docs/design/10.
   */
  batchSize: number;
  /** Parallel LLM calls within one background pass, for extraction and summaries alike. */
  concurrency: number;
  /**
   * Longest text one extraction call reads, in characters. A longer document
   * is cut into segments of at most this size (src/graph/segment.ts), each
   * extracted on its own and cached by its text hash; a shorter one is a
   * single call, as before.
   */
  segmentChars: number;
  /** Minutes between background document passes while `serve` runs. */
  intervalMinutes: number;
  /**
   * The worker slots `serve` runs for extraction on this machine (src/labeling):
   * each names a route target — a connection or an agent, e.g. a Codex and a
   * Cursor agent — and how many calls it runs at once. Absent or empty: the
   * Extract stage's own route with `concurrency` slots. Workers on other
   * machines come in through the remote API and need no entry here.
   */
  workers?: ExtractionWorkerConfig[];
  /**
   * Summary pages written at once on `serve`'s own summary slots (src/labeling/local.ts);
   * default `concurrency`. 0 leaves summaries to remote workers.
   */
  summaryConcurrency?: number;
  /**
   * Shortest document the Summarize stage writes a page for, in characters of
   * its indexed text (frontmatter included). A shorter document gets no
   * summary page at all — not a pointer page either: a page is indexed again
   * as a view, so for a one-paragraph post it would only double the post's
   * weight in search while saying less than the post (docs/design/14). Such
   * documents are never "due" a summary; `knode-os wiki prune-summaries`
   * archives the pages written before the threshold existed. 0 summarizes
   * every document.
   */
  summaryMinChars: number;
  /**
   * Segments one summary reads at most. A document longer than one call
   * (`LLM_WIKI_INPUT_CHARS`) is cut the way extraction cuts it, each segment
   * summarized on its own and the parts merged in one more call; past this
   * many segments the summary samples evenly through the document and the
   * page says how much of it was read (docs/design/14).
   */
  summaryMaxSegments: number;
  /**
   * Whether a document's summary page waits for its extraction (absent or
   * true: it does). A page links only names the graph already has, so a
   * summary written first misses the entities extraction finds. false writes
   * the summary pages of documents still queued for extraction too — for a
   * library whose extraction would take far longer than its summaries. The
   * summary is cached by the document's content, so extraction landing later
   * does not redo it: the page keeps the links it had (docs/design/14).
   */
  summaryAfterExtraction?: boolean;
  /**
   * The Translate stage (docs/design/17): a document under raw/docs in
   * another language than the workspace's primary one is translated into it,
   * segment by segment, as leased work beside summaries. Runs only while
   * `languages` is on. A config from before the stage starts as its
   * `summaryLlm` (`migrateTranslateRoute`).
   */
  translateLlm: RoutedLlmConfig;
  /**
   * Translation calls `serve`'s own slots run at once (src/labeling/local.ts);
   * default `concurrency`. 0 leaves translations to remote workers.
   */
  translateConcurrency?: number;
}

/** One kind of local labeling worker: what it runs on and how many calls at once. */
export interface ExtractionWorkerConfig {
  /** A route target id (`routeTargets`): a connection or an agent. */
  use: string;
  /** Calls in flight at once; 0 turns the worker off. */
  slots: number;
  /** Overrides the target's model / effort / speed / timeout for these calls. */
  model?: string;
  effort?: LlmEffort;
  speed?: LlmSpeed;
  cliTimeoutMs?: number;
}

/**
 * The remote API (src/remote): labeling and knowledge access for other
 * machines, under /remote/v1 on the same port, authenticated by per-machine
 * tokens (`knode-os remote token create`). With sign-in off, requests from
 * outside this machine reach these routes and nothing else (src/server/public-guard.ts).
 */
export interface RemoteApiConfig {
  enabled: boolean;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
  /** How long a worker may hold a segment or a summary before it goes back in line (renewable). */
  leaseMinutes?: number;
  /**
   * The kinds of work besides extraction (always offered) that remote workers
   * may take here (docs/design/12). Summaries default to on, the Judge
   * stage's review calls to off.
   */
  offer?: { summarize?: boolean; judge?: boolean; translate?: boolean; embed?: boolean; session?: boolean; eval?: boolean };
  /**
   * How a slot that takes several kinds of work shares them: tasks handed out
   * per kind, by weight (src/work/broker.ts). Default extraction 3, summaries 1,
   * translation 1, and an evaluation run's work 1 as one entry (docs/design/32
   * §4; 0: only when no knowledge-base work waits for the slot). Judge calls
   * go before all of them.
   */
  shares?: { extract?: number; summarize?: number; translate?: number; eval?: number };
  /** Longest a review waits for one judge call to be answered, here or remotely (default 20). */
  callDeadlineMinutes?: number;
  /**
   * Research sessions offered to remote workers (`offer.session`, docs/design/27):
   * how long a session waits for an online worker that takes its CLI before it
   * runs here (default 30 s), and how long one this machine may not run (its
   * plan under the floor, `research.localSessions` 0) waits for a worker before
   * its job waits as design 22 says (default 30 min).
   */
  sessionOfferSeconds?: number;
  sessionWaitMinutes?: number;
  /**
   * No longer read (docs/design/32): an evaluation run's piece waits until a
   * slot takes it, bounded by the run's own `--wait-minutes`. Kept so a
   * settings file that names it still loads.
   */
  evalOfferSeconds?: number;
  /**
   * The most an evaluation run's tasks and results may take in serve's queue
   * (`<data root>/.knode/eval-queue/`, docs/design/32 §5), in MB (default
   * 2048). Past it a run's publish is refused with that word; results already
   * collected go first.
   */
  evalQueueMB?: number;
  /**
   * The remote models whose verdicts may merge or reject without a person
   * (`review.llmJudge` / `review.claimMerge` set to auto): model labels as a
   * worker reports them ("codex:gpt-6.1-sol"), or a prefix ending in * ("codex:*").
   * Any other remote verdict is filed as a suggestion with the verdict attached.
   */
  judgeModels?: string[];
  /**
   * The cosine every probe vector a remote worker's own embedding endpoint
   * makes must reach against this machine's reference vectors before its
   * vectors are taken, and every spot check after (default 0.98, docs/design/12 §4.3).
   */
  embedProbeCosine?: number;
}

/**
 * Sign-in for `serve` (src/auth): accounts in `.knode/accounts.json`, made
 * with `knode-os user add` or, on a server with none yet, from the web UI or
 * the app on this machine. Every request to the UI's API, /gw and the app
 * needs a session, local or not; other machines must also come over HTTPS.
 */
export interface AuthConfig {
  /** Off: serve trusts the workspace headers a client sends and answers only /remote/v1 from outside — for development. */
  enabled: boolean;
  /** Days a browser or app session lives without use. */
  sessionDays?: number;
  /**
   * Answer other machines over plain HTTP. Only on a network that encrypts by
   * itself (a VPN such as Tailscale or WireGuard): passwords and sessions
   * cross it in the clear otherwise.
   */
  allowInsecureRemote?: boolean;
}

/**
 * A second, HTTPS listener for reaching `serve` by IP address or a name of
 * your own: the main one stays plain HTTP on loopback, for this machine, the
 * MCP endpoint and a tunnel in front of it.
 */
export interface TlsListenerConfig {
  port: number;
  /** Address to listen on; "0.0.0.0" or "::" for every interface. */
  host: string;
  /** PEM certificate (chain) and private key; relative paths are under the data root. `knode-os tls init` makes a self-signed pair. */
  cert: string;
  key: string;
}

/**
 * The embeddable reader at /embed/v1 (src/server/embed.ts): the one page
 * another app may put in an iframe, and the SDK at /embed/sdk.js.
 */
export interface EmbedConfig {
  /**
   * The exact origins (scheme://host[:port], no path, no wildcard) whose pages
   * may frame the reader and load the SDK, e.g. "https://app.example.com".
   * Empty: only knode-os itself may frame it. `serve` refuses to start on an
   * entry that is not an origin.
   */
  allowedOrigins: string[];
}

/**
 * A folder elsewhere on this machine mirrored into raw/docs and kept in sync
 * while `serve` runs (src/ingest/folders.ts). Written by the folder routes and
 * `knode-os folders link`, never by hand.
 */
export interface LinkedFolder {
  /** Absolute path of the folder outside the workspace. */
  source: string;
  /** Its mirror inside the workspace, a folder under raw/docs. */
  dest: string;
  createdAt: string;
}

/**
 * A Feishu document — or a wiki page with the pages under it, or a whole wiki
 * space — mirrored into raw/docs and kept in sync while `serve` runs
 * (src/ingest/feishu/docs.ts, ./tree.ts). Written by the Feishu routes and
 * `knode-os feishu link`, never by hand.
 */
export interface FeishuLink {
  /** The document's link as Feishu reports it (a wiki link when it was linked through one; a space's link for a whole space). */
  url: string;
  /** What Feishu stores it under: the docx token of a document; for a tree, its top page's node token, or the space id. */
  token: string;
  /** One document, or a wiki tree mirrored folder by folder. Absent in links made before trees: a document. */
  type: 'docx' | 'wiki-tree';
  /** The wiki node token, when the link named a wiki page (a tree's top page). */
  wiki?: string;
  /** A tree's wiki space. */
  space?: string;
  /** The title when last mirrored. */
  title: string;
  /** Its mirror inside the workspace, a folder under raw/docs. */
  dest: string;
  createdAt: string;
}

/**
 * A Claude Code or Codex conversation on this machine, rendered into raw/docs
 * as dialogue and kept current while `serve` runs (src/ingest/conversations,
 * docs/design/24). Written by the conversation routes and `knode-os
 * conversations import --follow`, never by hand.
 */
export interface ConversationLink {
  agent: 'claude' | 'codex';
  /** The session id the agent keeps it under. */
  id: string;
  /** Where its transcript was last found; found again by id when it moves. */
  source: string;
  /** The title when last rendered. */
  title: string;
  /** The repository it ran in, when known. */
  project: string | null;
  /** Its Markdown inside the workspace: a file under raw/docs. */
  dest: string;
  createdAt: string;
}

/**
 * A code repository kept under raw/codebase/<name>/ at one commit, with its
 * card at raw/docs/codebase/<name>.md (src/ingest/codebase, docs/design/25).
 * Written by `knode-os codebase add` and the codebase routes, never by hand.
 */
export interface CodebaseLink {
  /** Folder name under raw/codebase. */
  name: string;
  /** What git fetches from: an https / ssh URL or a path on this machine. */
  url: string;
  /** The repository's web page, when it has one. */
  web?: string | null;
  /** Branch, tag or commit to track; absent = the remote's default branch. */
  ref?: string;
  /** Globs (gitignore-style) a file must match to be carried; empty = all. */
  include?: string[];
  /** Globs that leave files behind, on top of the built-in rules. */
  exclude?: string[];
  /** `serve` fetches the ref again once a day and indexes what changed. */
  follow: boolean;
  /**
   * Copy the repository's documentation (top-level Markdown, docs/ folders)
   * to raw/docs/codebase/<name>/, where extraction and summaries read it.
   * Absent = true.
   */
  docs?: boolean;
  /** The commit the mirror holds, and its date. */
  commit?: string;
  committedAt?: string;
  /** When knode-os last looked at the remote, whatever it found. */
  checkedAt?: string;
  createdAt: string;
}

/** How `serve` keeps followed conversations current (docs/design/24 D8). */
export interface ConversationSyncConfig {
  /** Minutes between looks at the followed transcripts (default 10). */
  everyMinutes?: number;
  /** A transcript changed less than this many minutes ago waits: the agent may still be writing (default 10). */
  quietMinutes?: number;
}

/** How knode-os reaches Feishu: lark-cli, signed in as the person whose documents these are. */
export interface FeishuConfig {
  /** The lark-cli executable; default the one on PATH, else ~/.local/bin/lark-cli. */
  cli?: string;
  /**
   * When `serve` asks Feishu which linked documents changed: once a day at
   * this local time ("HH:MM", default "06:00"), and at startup when that
   * time passed while it was down. "off" leaves it to the Check now buttons.
   */
  checkAt?: string;
}

export interface IngestConfig {
  chunkSize: number;
  chunkOverlap: number;
  /** Re-sync automatically when files under the data dir change. */
  watch: boolean;
  /** Folders mirrored from elsewhere on this machine; absent or empty when none is linked. */
  linkedFolders?: LinkedFolder[];
  /** Feishu documents mirrored and kept in sync; absent or empty when none is linked. */
  feishuDocs?: FeishuLink[];
  feishu?: FeishuConfig;
  /** Agent conversations followed and kept in sync; absent or empty when none is. */
  conversations?: ConversationLink[];
  conversationSync?: ConversationSyncConfig;
  /** Code repositories under raw/codebase; absent or empty when none is added. */
  codebases?: CodebaseLink[];
  /**
   * When `serve` fetches followed repositories again: once a day at this
   * local time ("HH:MM", default "05:00"), "off" for never.
   */
  codebaseCheckAt?: string;
  /** Parallel documents in flight during the index pass; embedding round-trips dominate. */
  concurrency?: number;
  /**
   * Parallel document conversions in the prepare pass. Each conversion is one
   * or more vision calls, so this is the Convert stage's rate against the
   * document model. Pages inside one PDF stay sequential — two limits that
   * multiplied would blow a rate limit on a single scanned book.
   */
  convertConcurrency?: number;
  /**
   * When a document's vectors are made (docs/design/12 §3.3). "inline", the
   * default: while the document is applied (by the CLI), or right after by
   * `serve`'s background embedder (src/ingest/embed-backfill.ts). "deferred":
   * never by the sync; the chunks wait in a backlog that `serve`'s embed slots
   * and remote workers drain as leased work (src/work/embed.ts), the
   * duplicate audits' vectors go the same way, and changing the embedding
   * model refills the backlog instead of re-applying every document.
   */
  embedding?: 'inline' | 'deferred';
  /** `serve`'s own embed slots in deferred mode (default 8); 0 leaves the backlog to remote workers. */
  embedSlots?: number;
  /**
   * An OpenAI-compatible embeddings endpoint on this machine (a local bge-m3,
   * TEI, Ollama…) for `serve`'s embed slots in deferred mode. Its vectors are
   * taken once it passes the same calibration as a remote worker's own
   * endpoint (src/work/embed.ts); until then, and whenever it is refused, the
   * slots embed on the pool. Settings checks it before saving.
   */
  embedEndpoint?: { baseUrl: string; model: string; apiKey?: string } | null;
}

/** Whether vectors are leased work here (docs/design/12 §3.3): `ingest.embedding: "deferred"`. */
export function embeddingDeferred(config: Pick<KnodeConfig, 'ingest'>): boolean {
  return config.ingest?.embedding === 'deferred';
}

export interface HeatConfig {
  /** Half-life (days) of the exponentially-decayed access score. */
  halfLifeDays: number;
  /** Minutes between flushing usage stats from the DB back to sidecars. */
  flushIntervalMinutes: number;
  /**
   * The most usage heat can add to a fused search score, as a fraction
   * (0.05 = +5%). The boost grows with a document's heat and levels off
   * below this (heatBoost in src/stats/heat.ts), so heat reorders only
   * results the recall channels scored within this fraction of each other.
   * 0 turns it off.
   */
  searchWeight: number;
  /** Documents below this heat are treated as cold in wiki generation. */
  coldThreshold: number;
}

/** Query-time event expansion inspired by SAG (chunk = event in phase one). */
export interface SagSearchConfig {
  /** Number of direct hybrid hits used as event seeds. */
  seedChunks: number;
  /** Maximum entity nodes expanded at each hop. */
  entityFrontier: number;
  /**
   * Per-entity cap when expanding back to event chunks. An entity past it
   * keeps the chunks where the most of the hop's entities meet, newest first
   * among equals; usage heat does not choose.
   */
  maxEventsPerEntity: number;
  /** Maximum structurally discovered chunks sent to vector coarse ranking. */
  candidatePool: number;
  /** Number of chunk -> entity -> chunk expansion rounds. */
  maxHops: number;
  /** Reserved share of final results for the direct retrieval route; the walk's passages rank after those places. */
  directRatio: number;
  /**
   * Terms of the seed passages searched for as bridges, beside the entities
   * they mention (src/search/bridge.ts). Absent or 0: none, the walk crosses
   * through extracted entities only.
   */
  bridgeTerms?: number;
  /** Chunks the bridge terms put forward at most. Absent: 50. */
  bridgePool?: number;
}

/**
 * An optional second ranking of hybrid search's fused candidates by a
 * cross-encoder behind an HTTP `/rerank` endpoint (docs/design/30): a local
 * bge-reranker under TEI, or any OpenAI-compatible server that speaks the
 * Jina / Cohere shape. Off by default; knode-os never starts one. A failed
 * call leaves the fused order as it was.
 */
export interface RerankConfig {
  enabled: boolean;
  /** Base URL of the server; `/rerank` is appended unless the URL already ends in it. */
  url: string;
  /** `tei`: {query, texts} → [{index, score}]; `openai`: {model, query, documents, top_n} → {results: [{index, relevance_score}]}. Either answer shape is read. */
  style: 'tei' | 'openai';
  /** Model name sent in the `openai` style. */
  model: string;
  /** Bearer token, when the server wants one. */
  apiKey: string;
  /** Fused candidates sent to the reranker at most; the rest keep their fused order behind them. */
  candidates: number;
  /** Characters of each candidate sent. */
  maxChars: number;
  timeoutMs: number;
}

/** How `ask` routes a question (src/search/route.ts). */
export interface AskRouterConfig {
  /** `rules`: cheap patterns only; `model`: one small call to the Judge stage when the rules are unsure. */
  classifier: 'rules' | 'model';
  /** Claims an enumerated (list / aggregate / timeline) answer lists at most. */
  enumerateLimit: number;
  /** Relation hops a multi-hop answer walks at most. */
  maxHops: number;
  /**
   * Compute a list, count or "value as of" question's answer from the claims in code (docs/design/34 §1).
   * Off by default until a model-backed run has checked it; absent: off.
   */
  computedSets?: boolean;
  /** A second retrieval round when the first is thin (docs/design/34 §2). Absent: on. */
  secondRound?: boolean;
  /** Milliseconds a computed set may take; past them nothing is computed. Absent: 1000. */
  computedBudgetMs?: number;
}

export function defaultRerankConfig(): RerankConfig {
  return { enabled: false, url: '', style: 'tei', model: '', apiKey: '', candidates: 30, maxChars: 2000, timeoutMs: 8000 };
}

export function defaultAskRouterConfig(): AskRouterConfig {
  return { classifier: 'rules', enumerateLimit: 150, maxHops: 4, computedSets: false, secondRound: true };
}

export type DataSourceKind = 'mysql' | 'timescale' | 'duckdb' | 'http-json' | 'prometheus' | 'object';

/** How a request against a source is written. Only `sql` goes through the SQL guard. */
export type SourceDialect = 'sql' | 'http' | 'promql' | 'object';

/**
 * One declared HTTP endpoint. Endpoints are an allowlist, never a template an
 * agent can fill with an arbitrary URL: the connector refuses anything not
 * named here, so opening an HTTP source cannot become an open proxy.
 */
export interface HttpEndpointConfig {
  name: string;
  /** Path appended to the source's baseUrl; `{param}` placeholders are filled from the request. */
  path: string;
  description?: string;
  /** Query/path parameters this endpoint accepts. Anything else is rejected. */
  params?: { name: string; in?: 'query' | 'path'; type?: string; required?: boolean }[];
  /** Dotted path to the array of records inside the JSON response (e.g. "data.items"). */
  resultPath?: string;
  /** Documented result fields, used for the capability schema. */
  fields?: { name: string; type: string }[];
  /** Parameter whose values are graph entities (entity linking, same idea as entityColumns). */
  entityParams?: EntityColumnConfig[];
}

/** One declared Prometheus metric. */
export interface PrometheusMetricConfig {
  name: string;
  description?: string;
  /** Labels worth showing in the capability schema. */
  labels?: string[];
  /** Label whose values are graph entities (e.g. `service`, `instance`). */
  entityLabels?: EntityColumnConfig[];
}

/** A column whose values are graph entities (e.g. company names in a quotes table). */
export interface EntityColumnConfig {
  column: string;
  /** Entity type for sampled values (usually 'organization'). */
  entityType: string;
  /** Extra columns whose values become aliases of the entity (e.g. ticker symbol). */
  aliasColumns?: string[];
}

export interface DataSourceTableConfig {
  name: string;
  description?: string;
  entityColumns?: EntityColumnConfig[];
}

/**
 * An external live data source. Row data is never materialized into the
 * index — only schemas and entity↔table links are, so the graph can answer
 * "which tables contain company A" while the rows stay fresh at query time.
 */
export interface DataSourceConfig {
  id: string;
  kind: DataSourceKind;
  description?: string;
  /** mysql / timescale connection. Password supports the "env:VAR" convention. */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** duckdb / object: directory of files (absolute, or relative to the data dir). */
  path?: string;
  /** http-json / prometheus: base URL of the service. */
  baseUrl?: string;
  /** http-json / prometheus: request headers; values support the "env:VAR" convention. */
  headers?: Record<string, string>;
  /** http-json: the endpoints this source exposes. Requests outside this list are refused. */
  endpoints?: HttpEndpointConfig[];
  /** prometheus: the metrics this source exposes. Empty = discover from the server. */
  metrics?: PrometheusMetricConfig[];
  /** object: file extensions to catalog (default: everything). */
  extensions?: string[];
  /** Typical staleness of this source's answers, e.g. "30s" — seeds capability freshness. */
  freshness?: string | number;
  /** Relative expense of one call against this source (planner utility). Default 1. */
  cost?: number;
  /** Tables to introspect + link. Empty = introspect all, link nothing. */
  tables?: DataSourceTableConfig[];
  /** Hard cap on rows returned by native queries against this source. */
  maxRows?: number;
  timeoutMs?: number;
}

export interface PackConfig {
  /** Max entities matched from one utterance. */
  maxEntities: number;
  /** Doc chunks per pack. */
  maxDocs: number;
  /** Claims per pack. */
  maxClaims: number;
  /** Live probe queries per pack (across all matched entities). */
  maxProbes: number;
  /** Rows kept per probe result. */
  probeRows: number;
  /** In-memory TTL for probe results (they are never persisted). */
  liveTtlSeconds: number;
  /** Without fresher news than this many days, the pack flags a freshness gap. */
  staleNewsDays: number;
}

/**
 * MCP over Streamable HTTP, hosted by `serve` at `path`. Agents share the
 * running index through it instead of opening a second (PGlite: exclusive)
 * copy of the workspace.
 */
export interface McpServerConfig {
  enabled: boolean;
  path: string;
}

/**
 * How deep-research jobs are run. A job launches the configured agent with the
 * knode MCP endpoint attached — either a coding-agent CLI headlessly, or the
 * built-in agent loop on an OpenAI-compatible connection — and the agent
 * researches a topic and writes the wiki page back through `knode_write`.
 */
export interface ResearchConfig {
  /**
   * Which agent runs jobs: a connection id from `connections`, a CLI provider
   * name ('claude-cli' | 'codex-cli' | 'cursor-cli' | 'opencode-cli'), or 'default' for the
   * section-01 connection. An OpenAI-compatible connection runs the built-in
   * agent. Empty = not configured, and research is disabled — there is no
   * fallback, because one that only worked when the default provider happened
   * to be a CLI made the same config silently have research or not.
   */
  agent: string;
  /** Model for the agent. Empty = the CLI's own default / the connection's model. */
  model: string;
  /**
   * Turn cap for a session whose template sets none — every built-in template
   * sets its own, and a role may set its own (claude --max-turns, the built-in
   * loop's recursion limit; codex and cursor take no cap). Not in Settings.
   */
  maxTurns: number;
  /** Kill one agent session after this long; a team job runs several. */
  timeoutMs: number;
  /** Concurrent CLI runs per workspace. */
  concurrency: number;
  /**
   * Research sessions this machine runs at once when sessions are offered to
   * remote workers (`server.remote.offer.session`, docs/design/27): unset, no
   * limit beyond the jobs' own; 0, sessions run only on remote workers.
   */
  localSessions?: number | null;
  /** Where run workspaces live, relative to the data dir. */
  runsDir: string;
  /** Finished run directories kept before the oldest are pruned. */
  keepRuns: number;
  /** Data-dir subtrees exposed read-only to the agent (add-dir). Writes never go through the filesystem. */
  readDirs: string[];
  /** Accept the top recommendations automatically, up to `dailyJobs` per day. */
  auto: { enabled: boolean; dailyJobs: number };
  /**
   * The audit of an agent page that cites a repository (docs/design/37 §5):
   * after this many updates of the repository with no rewrite of the page,
   * it gets a refresh suggestion anyway, whose brief asks for the entry
   * points to be listed again from scratch — following the page's own
   * citations never finds a path it missed. 0 turns the audit off. Not in Settings.
   */
  auditAfterUpdates: number;
  /**
   * 'native' (default): one orchestrator session with the profile's native
   * roles registered as the CLI's own sub-agents (claude --agents, codex
   * agents.<id>, cursor .cursor/agents); it splits the research by period or
   * sub-question, delegates it in parallel and writes the page itself.
   * 'team' (the deeper, slower mode): a plan session splits the research the
   * same way, parallel researcher sessions take one part each, a synthesis
   * session writes the page, a review session critiques it and a revision
   * session fixes what it found. 'single': one agent session does everything.
   * The profile's own `pipeline` wins — Settings edits it there — so this is
   * only what a profile that names none runs.
   */
  pipeline: 'single' | 'team' | 'native';
  /**
   * Research profile under playbooks/research/profiles/<name>.yaml: reasoning
   * effort, web search freshness, verification bar and the sub-agent roles
   * (each with its own CLI, model, tools and prompt). Built-ins: default,
   * quick, thorough, native.
   */
  profile: string;
  /** Parallel researcher sessions in 'team' mode, when the research role sets no `parallel`. */
  researchers: number;
  /** Review → revise rounds in 'team' mode before the page is accepted or rejected, when the revise role sets none. */
  reviewRounds: number;
  /** Knowledge-base initialization (kind = init): how long its pre-flight catches up on extraction, and how many topic pages it queues. */
  init: ResearchInitConfig;
  /** Studies: a topic researched into several pages (kind = study, docs/design/15). */
  study: ResearchStudyConfig;
  /** What research may fetch from the web, where it goes, and which search API knode itself calls. */
  web: ResearchWebConfig;
}

export interface ResearchStudyConfig {
  /** Collector sessions a study runs at once while it gathers material. */
  collectors: number;
  /** Pages one study may plan besides its report; the refiner is told, and a longer plan is cut. */
  maxPages: number;
  /** Web captures one study may make before knode_capture refuses more. */
  maxCaptures: number;
  /**
   * Who turns a topic into a brief: an agent name, connection id or CLI.
   * Empty = the default LLM when it is a model endpoint, else the study's own agent, one-shot.
   */
  refiner: string;
}

export type WebSearchProvider = '' | 'searxng' | 'brave' | 'tavily' | 'serper';

export interface ResearchWebConfig {
  /**
   * The search API behind `knode_web_search`. Empty = none: only an agent with
   * a search tool of its own (Claude Code, Codex) searches the web, the
   * built-in agent cannot. Nothing is called that a person did not name here.
   */
  search: { provider: WebSearchProvider; baseUrl: string; apiKey: string; maxResults: number };
  /** Largest response a capture or fetch reads. */
  maxBytes: number;
  timeoutMs: number;
  /**
   * Also fetch private, loopback and link-local addresses (an intranet wiki).
   * Off: a URL an agent picked can never reach this machine's own services or
   * the local network.
   */
  allowPrivateHosts: boolean;
  /**
   * Proxy for fetches: '' = HTTPS_PROXY / HTTP_PROXY from the environment
   * (NO_PROXY honoured), 'none' = direct, or an http:// proxy URL.
   */
  proxy: string;
  /** User-Agent for fetches. Some publishers require a contact (SEC EDGAR asks for "Name email@domain"). */
  userAgent: string;
}

export interface ResearchInitConfig {
  /** Topic pages (from the plan) queued as follow-up research jobs after an initialization. */
  followUps: number;
  /**
   * How long an initialization first spends extracting documents that still
   * wait in the tier-1 queue; whatever is left goes on in the background loop.
   * The catch-up always runs — an empty queue makes it a no-op.
   */
  extractionMaxMs: number;
}

/**
 * Ask: a person talks to the configured agent, which answers from the
 * knowledge base over MCP and may write what it is taught (quarantined notes
 * under raw/docs/notes/). Every turn is a fresh session that replays recent
 * history — no CLI session persistence (see docs/design/07).
 *
 * *How* that agent runs — effort, tool grants, turn cap, timeout, extra
 * prompt — belongs to the agent, in `playbooks/agents/<name>.yaml`. This block
 * used to keep a second copy of all of it that nothing read; what is left is
 * the three things that are properties of the conversation rather than of who
 * answers it.
 */
export interface ChatConfig {
  /** Agent name, connection id or provider; '' falls back to research.agent, then the default connection. */
  agent: string;
  /** Model override ('' = the agent's own). */
  model: string;
  /** Messages replayed into each turn's prompt (user + assistant, most recent). */
  historyTurns: number;
  /** Conversations kept per workspace; older ones are pruned. One conversation per question fills this faster than turns do. */
  keep: number;
}

export interface GraphConfig {
  /** Ontology packs under playbooks/ontology/<pack>.yaml, merged in order; later packs may extend earlier ones. */
  ontologyPacks: string[];
}

export type ReviewResolution = 'exact' | 'suffix';
export type ReviewIdentity = 'context' | 'name';
export type ReviewLlmMode = 'off' | 'suggest' | 'auto';
export type ReviewExternal = 'off' | 'verify' | 'research';

/**
 * This machine's processing: the extraction, summary, translation and judge
 * slots `serve` runs (src/labeling/local.ts) and the reviews after them. One
 * setting for the whole server (src/global-settings.ts): every workspace
 * carries the root config's copy, and processing starts with the service in
 * every workspace. A file written before 2026-11-08 may still say `autoStart`;
 * it is read past and dropped at the next save.
 */
export interface ProcessingConfig {
  /**
   * Model calls this machine's slots run at once, every workspace and every
   * stage together — extraction, summaries, translations and review calls.
   * Each stage's own slot count still applies under it. 0: no cap beyond
   * those. Default 2.
   */
  maxLocalCalls: number;
  /**
   * While a Codex or Claude plan has less than this percent left in any of
   * its windows, the background work on it stops: the processing slots, the
   * research jobs, Dream and the tier-2 pass. It goes on once that window
   * resets above it (src/labeling/plan-quota.ts). Ask is never held. 0 turns
   * the floor off. Default 20.
   */
  minQuotaPercent: number;
}

export const DEFAULT_PROCESSING: ProcessingConfig = { maxLocalCalls: 2, minQuotaPercent: 20 };

/** The processing settings, a missing or unusable one at its default (an old `autoStart` is ignored). */
export function processingSettings(config: Pick<KnodeConfig, 'processing'>): ProcessingConfig {
  const p = config.processing ?? DEFAULT_PROCESSING;
  const count = (v: unknown, fallback: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : fallback;
  };
  return {
    maxLocalCalls: count(p.maxLocalCalls, DEFAULT_PROCESSING.maxLocalCalls, 64),
    minQuotaPercent: count(p.minQuotaPercent, DEFAULT_PROCESSING.minQuotaPercent, 100),
  };
}

/**
 * How much checking sits between extraction and the graph. Three layers, each
 * with its own knob, so a workspace can be strict (nothing merges without a
 * person) or hands-off (the LLM judge merges what it is sure about).
 */
export interface ReviewConfig {
  /**
   * Write-time auto-merge rule. 'exact': a mention merges into a known entity
   * only when its spelling equals a known name or alias (after NFKC / width /
   * case folding). 'suffix': names that differ only by a corporate suffix
   * (股份有限公司, Inc., Co., Ltd. …) merge too. Anything fuzzier is always a
   * suggestion a person accepts.
   */
  resolution: ReviewResolution;
  /**
   * How far refine goes in telling apart things of one name. 'name' (the
   * default, also when unset): as before — people of one name are split when
   * their documents carry dates and fall into two contexts at the same time.
   * 'context': a workspace turns on the rest (src/graph/entity-context.ts) —
   * an entity whose documents carry several codes under roofs of their own
   * is parted into one entity per code, and people are also told apart where
   * documents are dated only by the claims they state, comparing what each
   * context is about. Every split re-applies its documents from their
   * sidecars, logs its reason, and is undone by merging the two entities.
   * Nothing is ever parted when a document is written; names already parted
   * keep resolving to their entities under either setting.
   */
  identity?: ReviewIdentity;
  /**
   * Back-references across periodic reports (src/graph/backrefs.ts): a report's
   * id-less "上周那起X已由Y修复" linked to the one identified incident X of the
   * same series' previous report. Off unless set. `periodic`: folders (path
   * prefixes such as "raw/docs/周报") whose documents are periodic reports.
   * `detect`: also any folder whose dated documents demonstrably are a series
   * (four or more, one title pattern, a regular interval).
   */
  backReferences?: { periodic?: string[]; detect?: boolean };
  /** LLM judge over duplicate-entity candidates: off / annotate suggestions with a verdict / also merge above autoMergeMinConfidence. */
  llmJudge: ReviewLlmMode;
  /** Candidates the judge rejects with at least this confidence are dropped (and remembered) instead of filed. */
  llmMinConfidence: number;
  /** 'auto' merges without a person at or above this confidence. */
  autoMergeMinConfidence: number;
  /** Duplicate-entity candidates judged per run (one LLM call each). */
  maxJudgedPerRun: number;
  /**
   * Judge calls `serve` runs at once on its own judge slots, on the Judge
   * stage's route, while a review waits on them (default 2). 0 leaves them
   * to remote workers (`server.remote.offer.judge`).
   */
  concurrency?: number;
  /**
   * Judge calls a review sends at once when it calls the Judge route itself
   * (`directJudge`: the nightly pass, the CLI, a document pass outside
   * `serve`'s slots). Default 1. An evaluation build sets it to its pass
   * concurrency, since its calls go to remote workers (docs/design/27 §8).
   */
  directConcurrency?: number;
  /** LLM review of disputed / suspected claims, filed as knowledge suggestions with a verdict. */
  claims: 'off' | 'suggest';
  /**
   * Duplicate claims (docs/design/10): 'auto' merges pairs that are identical
   * once normalized, and pairs the Judge calls the same at or above
   * claimMergeMinConfidence that pass the number / period checks; the rest of
   * the same-verdicts become suggestions. 'suggest' files every judged merge
   * as a suggestion (identical ones still merge). 'off' leaves claims alone.
   */
  claimMerge: ReviewLlmMode;
  /** 'auto' merges a judged pair without a person at or above this confidence. */
  claimMergeMinConfidence: number;
  /**
   * Duplicate-claim pairs the Judge looks at per run, 12 to a call (the
   * default 1200 is 100 calls). The most promising go first: pairs that read
   * alike before pairs that only share a number, pairs that could merge
   * before guarded ones. The rest have no verdict yet, so a later run
   * proposes them again — the nightly one compares every claim. Identical and
   * different-period pairs need no model and never wait. 0 judges none.
   */
  claimMergeMaxJudgedPerRun: number;
  /**
   * The workspace's web switch, for research jobs and Ask alike: off / only
   * `verify` jobs (and agents set to `on`) get web tools / every job may use
   * them. A profile, role or agent can narrow it or widen `verify`, never
   * past `off`. Edited on the Research tab.
   */
  external: ReviewExternal;
}

export interface KnodeConfig {
  /**
   * The active embedding provider, flattened. Derived from `embeddingProviders`
   * on every load and every save, never edited on its own, so that every reader
   * — the store's vector width, `ctx.embedder`, wiki, dream, the dedupe audit —
   * keeps taking one plain endpoint and never has to know the library exists.
   */
  embedding: EmbeddingConfig;
  /** Every configured embedding provider. The Index stage runs on exactly one. */
  embeddingProviders: EmbeddingConnection[];
  /** Which `embeddingProviders` entry the Index stage runs on. */
  embeddingUse: string;
  /** One vector space, with compatible credentials selected at request time. */
  embeddingPool?: EmbeddingPoolConfig;
  database: DatabaseConfig;
  /**
   * A mirror of the connection `llmUse` names, flattened by `syncActiveLlm`.
   *
   * Everything that needs "the default model" — a route that names no
   * connection, `agentForSpec('default')` — reads this, so the default can
   * become an ordinary row without touching any of them. `ctx.llm` used to
   * be one of them; it is the Judge stage's now (`judgeLlmClient`).
   */
  llm: LlmConfig;
  /**
   * Every configured model endpoint, including whichever one is the default.
   * Coding-agent CLIs are agents and live in `playbooks/agents/` —
   * `migrateCliConnections` moves any left here.
   */
  connections: LlmConnection[];
  /**
   * What the default is: a `connections` entry, or — on a machine with no model
   * endpoint — a CLI agent's name.
   */
  llmUse: string;
  /**
   * The CLI agents under `playbooks/agents/`, as the one-shot LLMs a pipeline
   * route or the default can run on. Read from the files on load and whenever
   * an agent is saved; never written to the config file.
   */
  agentLlms?: LlmConnection[];
  /**
   * The deepagents agents under `playbooks/agents/`, which a pipeline route —
   * not the default, which they may follow — can run on one-shot. Read and
   * kept like `agentLlms`.
   */
  modelAgents?: ModelAgent[];
  server: {
    port: number; host: string; mcp: McpServerConfig; remote?: RemoteApiConfig; auth?: AuthConfig; tls?: TlsListenerConfig | null; embed?: EmbedConfig;
    /**
     * An evaluation root (docs/design/35 §2): the root's workspaces are a
     * run's builds, `serve` on it is a viewer that changes none of them, and
     * only an evaluation run writes into it. Set by `knode-os eval root init`.
     */
    evaluation?: boolean;
  };
  /** An evaluation root's own settings (docs/design/35 §3): the account its builds are filed under. */
  evaluation?: { owner?: string };
  ingest: IngestConfig;
  extraction: ExtractionConfig;
  retrieval: { sag: SagSearchConfig; /** Absent in a config written before it: off. */ rerank?: RerankConfig; /** Absent in a config written before it: `defaultAskRouterConfig()`. */ router?: AskRouterConfig };
  heat: HeatConfig;
  datasources: DataSourceConfig[];
  pack: PackConfig;
  /** Deep-research jobs run by an external coding-agent CLI (see src/research). */
  research: ResearchConfig;
  /** Knowledge-graph vocabulary: which ontology packs define entity and relation types. */
  graph: GraphConfig;
  /** Review strength between extraction and the graph (entity merges, claims, external verification). */
  review: ReviewConfig;
  /**
   * This machine's processing (src/labeling/processing.ts): how many model
   * calls its slots run at once, and the plan quota background work leaves
   * alone. Shared by every workspace on the server (src/global-settings.ts).
   * Absent in a config written before it: the defaults (`processingSettings`).
   */
  processing?: ProcessingConfig;
  /** The chat entry (see src/chat). */
  chat: ChatConfig;
  /**
   * Learning from use (src/learn, docs/design/38 §4): answers written back as checked question pages and derived
   * facts. Absent, or `enabled: false`: nothing is written back.
   */
  learn?: Partial<LearnConfig>;
  /** Content languages: the language the knowledge is read in, and what is translated into it (docs/design/17). */
  languages: LanguagesConfig;
  trace: {
    /** Where Claude Code stores session transcripts. */
    claudeProjectsDir: string;
    /** Where Codex CLI stores session rollouts. */
    codexSessionsDir: string;
    /** Extra skill source dirs to mirror into raw/skills. */
    skillDirs: string[];
    syncIntervalMinutes: number;
    /**
     * Prepare synced transcripts as searchable episodes (Markdown in their sidecars).
     * Off by default: a machine with months of agent history would otherwise
     * turn one sync into thousands of embedding calls.
     */
    episodes?: boolean;
  };
  dream: {
    /**
     * Local 24-hour time "HH:MM" at which the nightly dream runs while `serve`
     * is up ("3:00" is read as 03:00); the tier-2 pass follows ten minutes later.
     */
    schedule: string;
    lookbackDays: number;
    /** Max trace excerpt characters fed to the LLM per dream run. */
    maxContextChars: number;
  };
  /**
   * Plugin modules to load when this workspace opens (docs/design/11): LLM and
   * embedding providers, storage backends, document converters and hooks at
   * the processing stages. Loaded once per process; file-only — the settings
   * screen does not edit it.
   */
  plugins?: PluginSpec[];
  /** What estimates price calls at and compare them with (docs/design/18). File-only. */
  usage?: UsageConfig;
}

/**
 * Prices and plan allowances for estimates (src/estimate). Everything is
 * optional: without it an estimate prices only the models it knows, and
 * shows a plan's share only where the service reports its own use (Codex).
 */
export interface UsageConfig {
  /** US dollars per million tokens, by model name — exact, or a prefix ending in `*` — over the built-in table. */
  prices?: Record<string, { input: number; cachedInput: number; cacheWrite?: number; output: number }>;
  /** What a plan includes, in usage at API prices, for a service that does not report its own use. */
  allowances?: {
    cursor?: { monthlyUsd?: number };
    claude?: { fiveHourUsd?: number; weeklyUsd?: number };
  };
  /** Read the Codex account's limits through `codex app-server` (no model call). Default on. */
  codexLimits?: boolean;
}

export const CONFIG_FILE = 'knode.config.json';

export function defaultConfig(): KnodeConfig {
  const home = os.homedir();
  return {
    embedding: {
      provider: 'local',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'env:OPENAI_API_KEY',
      model: 'text-embedding-3-small',
      dimensions: 384,
      batchSize: 32,
      sendDimensions: false,
    },
    // Empty, not a seeded row: `deepMerge` keeps a default the saved file does
    // not mention, so a seeded row would survive the merge of a pre-library
    // config and then overwrite that config's real embedding settings.
    embeddingProviders: [],
    embeddingUse: '',
    database: {
      // PostgreSQL by default: one shared database, one schema per workspace. The
      // embedded PGlite index stays available for offline / zero-setup use and
      // is what the test suite runs on — set database.kind to "pglite", or
      // KNODE_DATABASE_KIND=pglite before the config file exists.
      kind: process.env.KNODE_DATABASE_KIND === 'pglite' ? 'pglite' : 'postgres',
      host: '127.0.0.1',
      port: 5432,
      user: '',
      password: '',
      database: 'knode',
      schemaPrefix: 'ws',
    },
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'env:OPENAI_API_KEY',
      protocol: 'auto',
      model: '',
      cliPath: '',
      effort: 'default',
      cliTimeoutMs: 300_000,
    },
    // seeded empty, like `embeddingProviders`: a row here would survive
    // `deepMerge` and clobber a real saved list. `migrateDefaultLlm` mints the
    // default's row on load instead.
    connections: [],
    llmUse: '',
    server: {
      port: 9100,
      host: '127.0.0.1',
      mcp: { enabled: true, path: '/mcp' },
      remote: {
        enabled: true, maxBodyBytes: 8 * 1024 * 1024, leaseMinutes: 15,
        offer: { summarize: true, judge: false, translate: true, embed: true, session: false, eval: false }, shares: { extract: 3, summarize: 1, translate: 1, eval: 1 }, callDeadlineMinutes: 20, judgeModels: [],
        sessionOfferSeconds: 30, sessionWaitMinutes: 30,
        embedProbeCosine: 0.98,
      },
      auth: { enabled: true, sessionDays: 30, allowInsecureRemote: false },
      tls: null,
      embed: { allowedOrigins: [] },
    },
    ingest: { chunkSize: 1200, chunkOverlap: 150, watch: true, concurrency: 4, convertConcurrency: 2, embedding: 'inline', embedSlots: 8 },
    extraction: {
      claims: true,
      tier1Model: '',
      entityLlm: defaultRoutedLlmConfig(),
      documentLlm: defaultRoutedLlmConfig(),
      summaryLlm: defaultRoutedLlmConfig(),
      judgeLlm: defaultRoutedLlmConfig(),
      translateLlm: defaultRoutedLlmConfig(),
      freshnessBoostDays: 3,
      importance: { docs: 1.0, skills: 0.6 },
      batchSize: 8,
      concurrency: 1,
      intervalMinutes: 5,
      segmentChars: 12_000,
      summaryMinChars: 1_500,
      summaryMaxSegments: 12,
    },
    retrieval: {
      sag: {
        seedChunks: 12,
        entityFrontier: 24,
        maxEventsPerEntity: 12,
        candidatePool: 120,
        maxHops: 2,
        directRatio: 0.5,
      },
      rerank: defaultRerankConfig(),
      router: defaultAskRouterConfig(),
    },
    heat: {
      halfLifeDays: 14,
      flushIntervalMinutes: 60,
      searchWeight: 0.05,
      coldThreshold: 0.05,
    },
    datasources: [],
    pack: {
      maxEntities: 4,
      maxDocs: 6,
      maxClaims: 12,
      maxProbes: 6,
      probeRows: 10,
      liveTtlSeconds: 30,
      staleNewsDays: 7,
    },
    research: {
      agent: '',
      model: '',
      maxTurns: 40,
      timeoutMs: 1_200_000,
      concurrency: 1,
      runsDir: '.runs',
      keepRuns: 20,
      readDirs: ['raw/docs', 'raw/codebase', 'wiki', '.sidecar'],
      auto: { enabled: false, dailyJobs: 3 },
      auditAfterUpdates: 30,
      pipeline: 'native',
      profile: 'default',
      researchers: 3,
      reviewRounds: 1,
      init: { followUps: 6, extractionMaxMs: 900_000 },
      study: { collectors: 3, maxPages: 6, maxCaptures: 60, refiner: '' },
      web: {
        search: { provider: '', baseUrl: '', apiKey: '', maxResults: 8 },
        maxBytes: 25 * 1024 * 1024,
        timeoutMs: 30_000,
        allowPrivateHosts: false,
        proxy: '',
        userAgent: 'knode-os/0.1 (local research assistant)',
      },
    },
    graph: { ontologyPacks: ['core', 'organization'] },
    review: {
      resolution: 'exact',
      llmJudge: 'suggest',
      llmMinConfidence: 0.6,
      autoMergeMinConfidence: 0.95,
      maxJudgedPerRun: 30,
      concurrency: 2,
      claims: 'suggest',
      claimMerge: 'auto',
      claimMergeMinConfidence: 0.9,
      claimMergeMaxJudgedPerRun: 1200,
      external: 'verify',
    },
    processing: { ...DEFAULT_PROCESSING },
    chat: { agent: 'default', model: '', historyTurns: 12, keep: 200 },
    languages: { ...DEFAULT_LANGUAGES, secondary: [] },
    trace: {
      claudeProjectsDir: path.join(home, '.claude', 'projects'),
      codexSessionsDir: path.join(home, '.codex', 'sessions'),
      skillDirs: [path.join(home, '.claude', 'skills'), path.join(home, '.codex', 'prompts')],
      syncIntervalMinutes: 10,
    },
    dream: { schedule: '03:00', lookbackDays: 7, maxContextChars: 60_000 },
  };
}

export function defaultRoutedLlmConfig(): RoutedLlmConfig {
  return {
    use: '',
    provider: 'inherit',
    baseUrl: '',
    apiKey: '',
    protocol: 'auto',
    model: '',
    cliPath: '',
    effort: 'default',
    speed: 'default',
    cliTimeoutMs: 300_000,
  };
}

/**
 * Resolve a per-job route into a concrete client configuration.
 *
 * A route that names a connection takes that connection whole, with its own
 * `model` as an override. Anything else falls back to the pre-connections
 * behaviour: inherit the default provider, or use the fields the route carries
 * itself. An unknown id resolves to the default rather than failing a pipeline
 * pass — deleting a connection degrades a route, it does not break it.
 */
export function resolveRoutedLlmConfig(
  base: LlmConfig,
  route: RoutedLlmConfig,
  connections: LlmConnection[],
  legacyModel = '',
): LlmConfig {
  const connection = route.use && route.use !== 'default' ? connections.find((c) => c.id === route.use) : undefined;
  if (connection) {
    return {
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      // the wire belongs to the endpoint, so a route rides the connection's
      // choice rather than overriding it
      protocol: connection.protocol,
      model: route.model || connection.model,
      cliPath: connection.cliPath,
      effort: routeEffort(route.effort) ?? connection.effort,
      speed: routeSpeed(route.speed) ?? connection.speed,
      cliTimeoutMs: route.cliTimeoutMs || connection.cliTimeoutMs,
      ...(connection.loop ? { loop: connection.loop } : {}),
    };
  }
  if (route.use) {
    return { ...base, model: route.model || legacyModel || base.model };
  }
  const provider = route.provider === 'inherit' ? base.provider : route.provider;
  const inheritedProvider = route.provider === 'inherit';
  return {
    provider,
    baseUrl: route.baseUrl || base.baseUrl,
    apiKey: route.apiKey || base.apiKey,
    // a route that brings its own endpoint brings its own wire; one that
    // inherits the endpoint inherits the wire with it
    protocol: (route.baseUrl ? route.protocol : undefined) ?? base.protocol,
    model: route.model || legacyModel || (inheritedProvider ? base.model : ''),
    cliPath: route.cliPath || (provider === base.provider ? base.cliPath : ''),
    effort: routeEffort(route.effort) ?? base.effort,
    speed: routeSpeed(route.speed) ?? base.speed,
    cliTimeoutMs: route.cliTimeoutMs || base.cliTimeoutMs,
  };
}

/** A route only overrides the effort when it names a real level, the way an empty `model` inherits. */
function routeEffort(effort: LlmEffort | undefined): LlmEffort | undefined {
  return effort && effort !== 'default' ? effort : undefined;
}

/** The same for speed: a route's 'default' is its target's own. */
function routeSpeed(speed: LlmSpeed | undefined): LlmSpeed | undefined {
  return speed && speed !== 'default' ? speed : undefined;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * A workspace's config, as its file and its agent files say, with what older
 * versions wrote brought up to date — and written back when that changed
 * something. `readOnly` (an evaluation build opened in the viewer, docs/design/35
 * §4): the same config in memory, and nothing written — no agent file
 * upgraded or moved, no config saved.
 */
export function loadConfig(dataDir: string, opts: { readOnly?: boolean } = {}): KnodeConfig {
  const file = path.join(dataDir, CONFIG_FILE);
  // the agent files before anything reads them: a retired built-in leaves
  // here, and what named it follows its replacement below, before `pinRoutes`
  // resolves a single stage
  const retired = opts.readOnly ? new Map<string, string>() : upgradeAgentFiles(dataDir);
  const base = defaultConfig();
  // before the default is resolved: it may name a CLI agent
  base.agentLlms = readAgentLlms(dataDir);
  base.modelAgents = readModelAgents(dataDir);
  if (!fs.existsSync(file)) {
    const fresh = migrateEmbeddingProviders(opts.readOnly ? migrateDefaultLlm(base) : migrateCliConnections(migrateDefaultLlm(base), dataDir));
    renameRetiredAgents(fresh, dataDir, retired);
    pinRoutes(fresh);
    return fresh;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KnodeConfig>;
  const merged = migrateChatConfig(deepMerge(base, raw));
  // processing starts with the service everywhere now: an old `autoStart` is
  // read past, and leaves the file at its next save
  merged.processing = processingSettings(merged);
  // the schedulers compare "HH:MM" strings, so "3:00" is held as 03:00; a value
  // that is no time of day stays as written, and `serve` says it will not run
  if (merged.dream) merged.dream.schedule = normalizeTimeOfDay(merged.dream.schedule) ?? merged.dream.schedule;
  const unbudgeted = dropTokenBudget(merged);
  const unchosen = dropInitExtractionChoice(merged);
  // before routes are lifted and pinned, so the copy is lifted and pinned with them
  const judged = migrateJudgeRoute(merged, raw);
  const translated = migrateTranslateRoute(merged, raw);
  const unconcepted = dropConceptRoute(merged);
  merged.languages = normalizeLanguagesConfig(merged.languages);
  merged.agentLlms = base.agentLlms;
  merged.modelAgents = base.modelAgents;
  const renamed = renameRetiredAgents(merged, dataDir, retired);
  // routes first: it may already have minted a connection for this endpoint,
  // and the default must reuse that row rather than add a twin; CLI rows move
  // out last, once both have had their say about which rows exist
  const routed = migrateDefaultLlm(migrateRouteConnections(merged));
  const movesCli = routed.connections.some((c) => isCliProvider(c.provider));
  const config = migrateEmbeddingProviders(opts.readOnly ? routed : migrateCliConnections(routed, dataDir));
  // stages last, once the default and every target are where they will stay
  const pinned = pinRoutes(config);
  // the move wrote agent files, so the config that no longer names those rows
  // is written too — otherwise every load would move them again; a pinned
  // stage, a spec renamed off a retired agent, a dropped token budget or init
  // extraction choice, the Judge route's first copy and the retired concept
  // route are written for the same reason
  if (!opts.readOnly && (movesCli || pinned || renamed || unbudgeted || unchosen || judged || translated || unconcepted)) saveConfig(dataDir, config);
  return config;
}

/**
 * Point what named a retired built-in agent (`upgradeAgentFiles`) at its
 * replacement: research, Ask, the pipeline stages, and the profile roles that
 * pin one. Returns whether the config changed; the profiles are files of
 * their own and are written as they change.
 */
export function renameRetiredAgents(config: KnodeConfig, dataDir: string, renamed: Map<string, string>): boolean {
  if (renamed.size === 0) return false;
  renameProfileAgents(dataDir, renamed);
  let changed = false;
  for (const key of ['research', 'chat'] as const) {
    const to = renamed.get(config[key]?.agent?.trim() ?? '');
    if (!to) continue;
    config[key].agent = to;
    changed = true;
  }
  for (const key of ROUTE_KEYS) {
    const to = renamed.get(config.extraction[key]?.use?.trim() ?? '');
    if (!to) continue;
    config.extraction[key] = { ...config.extraction[key], use: to };
    changed = true;
  }
  return changed;
}

/**
 * Drop the `chat.*` keys that left chat: effort and web access went to the
 * agent definition, and Ask's turn cap and timeout are fixed now.
 *
 * `deepMerge` keeps unknown keys, so without this a file written before the
 * move would carry them forever, looking like settings. Anything that was not
 * the old default is announced once: `chat.maxTurns: 100` vanishing in silence
 * is the kind of thing that becomes a bug report.
 */
const MOVED_CHAT_KEYS: Record<string, unknown> = { effort: 'default', maxTurns: 30, timeoutMs: 600_000, web: 'inherit' };

export function migrateChatConfig(config: KnodeConfig): KnodeConfig {
  const chat = config.chat as unknown as Record<string, unknown> | undefined;
  if (!chat) return config;
  const carried: string[] = [];
  for (const [key, wasDefault] of Object.entries(MOVED_CHAT_KEYS)) {
    if (!(key in chat)) continue;
    if (chat[key] !== wasDefault) carried.push(`${key}=${JSON.stringify(chat[key])}`);
    delete chat[key];
  }
  if (carried.length > 0) {
    console.warn(`knode: chat.${carried.join(', chat.')} no longer applies — Ask runs every agent with the same turn cap and timeout; an agent's effort and web access live in playbooks/agents/<name>.yaml (Settings → Providers & Agents)`);
  }
  return config;
}

/**
 * Drop `extraction.dailyTokenBudget`. Nothing caps background LLM work by a
 * daily token count any more — tier-1 extraction is paced by its batch size
 * and interval — and `deepMerge` keeps unknown keys, so a file written before
 * would otherwise carry it forever, looking like a setting. Returns whether
 * there was one to drop.
 */
export function dropTokenBudget(config: KnodeConfig): boolean {
  const extraction = config.extraction as unknown as Record<string, unknown> | undefined;
  if (!extraction || !('dailyTokenBudget' in extraction)) return false;
  delete extraction.dailyTokenBudget;
  return true;
}

/**
 * Drop `research.init.extraction` ('drain' | 'skip'). An initialization now
 * always catches up on what the tier-1 queue still holds before its agent
 * starts — within `extractionMaxMs`, a no-op when nothing waits — so there is
 * nothing left to choose. Removed for the same reason as the token budget:
 * `deepMerge` would keep it in the file forever. Returns whether there was one.
 */
export function dropInitExtractionChoice(config: KnodeConfig): boolean {
  const init = config.research?.init as unknown as Record<string, unknown> | undefined;
  if (!init || !('extraction' in init)) return false;
  delete init.extraction;
  return true;
}

/**
 * Give a config from before the Judge stage its route: a copy of `summaryLlm`.
 * knode_ask, Dream and the two reviews ran on the Summarize stage until it
 * kept only document summaries, so they keep running where they ran — the
 * same target, model, effort and speed. `raw` is the file as written, since
 * `deepMerge` has already filled in a default by now. Returns whether it copied.
 */
export function migrateJudgeRoute(config: KnodeConfig, raw: Partial<KnodeConfig>): boolean {
  if ((raw.extraction as Partial<ExtractionConfig> | undefined)?.judgeLlm) return false;
  config.extraction.judgeLlm = { ...config.extraction.summaryLlm };
  return true;
}

/**
 * Give a config from before the Translate stage its route: a copy of
 * `summaryLlm`. A translation is prose for people to read, like a summary,
 * so it starts on the agent or model that writes them — the same target,
 * model, effort and speed — instead of whatever the default is.
 */
export function migrateTranslateRoute(config: KnodeConfig, raw: Partial<KnodeConfig>): boolean {
  if ((raw.extraction as Partial<ExtractionConfig> | undefined)?.translateLlm) return false;
  config.extraction.translateLlm = { ...config.extraction.summaryLlm };
  return true;
}

/**
 * Drop `extraction.conceptLlm` and its legacy `tier2Model`. The Synthesize
 * stage wrote nightly concept-cluster pages; concept pages are research's job
 * now (docs/design/09), so nothing reads either. `deepMerge` would keep them
 * in the file forever, looking like settings. Returns whether there was one.
 */
export function dropConceptRoute(config: KnodeConfig): boolean {
  const extraction = config.extraction as unknown as Record<string, unknown> | undefined;
  if (!extraction) return false;
  let dropped = false;
  for (const key of ['conceptLlm', 'tier2Model']) {
    if (!(key in extraction)) continue;
    delete extraction[key];
    dropped = true;
  }
  return dropped;
}

const ROUTE_KEYS = ['entityLlm', 'documentLlm', 'summaryLlm', 'judgeLlm', 'translateLlm'] as const;

/**
 * Lift pre-connections route overrides into named connections, in memory, so
 * everything downstream only has to understand `use`. A route whose resolved
 * endpoint matches the default just points at the default; the rest get a
 * connection each, deduplicated so routes sharing an endpoint share one. The
 * route keeps its own `model`, which stays an override on top.
 */
export function migrateRouteConnections(config: KnodeConfig): KnodeConfig {
  const connections = [...(config.connections ?? [])];
  for (const key of ROUTE_KEYS) {
    const route = config.extraction[key];
    if (!route || route.use || route.provider === 'inherit') continue;
    const resolved = resolveRoutedLlmConfig(config.llm, route, []);
    if (sameEndpoint(resolved, config.llm)) {
      config.extraction[key] = { ...route, use: 'default' };
      continue;
    }
    const existing = connections.find((c) => sameEndpoint(c, resolved));
    const connection = existing ?? {
      ...resolved,
      model: '',
      id: uniqueConnectionId(resolved.provider, connections),
      label: llmProviderLabel(resolved.provider),
    };
    if (!existing) connections.push(connection);
    config.extraction[key] = { ...route, use: connection.id };
  }
  return { ...config, connections };
}

/**
 * Put the default LLM in `connections` as an ordinary row and point `llmUse`
 * at it, the way `embeddingUse` has always pointed into `embeddingProviders`.
 *
 * `config.llm` used to be the default *itself*: a field beside the list, which
 * meant two row builders in one table, and meant that making an existing
 * connection the default was retyping its endpoint and key rather than
 * clicking it. It is now a mirror of the named row.
 *
 * Routes are left alone here; `pinRoutes` writes an inheriting one down as
 * this default once every target is known.
 */
export function migrateDefaultLlm(config: KnodeConfig): KnodeConfig {
  const connections = [...(config.connections ?? [])];
  const targets = llmTargets({ ...config, connections });
  if (!targets.some((c) => c.id === config.llmUse)) {
    const existing = targets.find((c) => sameEndpoint(c, config.llm) && c.model === config.llm.model);
    if (existing) {
      config.llmUse = existing.id;
    } else {
      const id = uniqueConnectionId(config.llm.provider, connections);
      connections.unshift({ ...config.llm, id, label: config.llm.label?.trim() || llmProviderLabel(config.llm.provider) });
      config.llmUse = id;
    }
  }
  return syncActiveLlm({ ...config, connections });
}

/**
 * The connection the default points at. A dangling `llmUse` falls back to the
 * first model endpoint, then the first CLI agent, rather than failing —
 * deleting the default demotes it, it does not leave the workspace without a
 * model.
 */
export function activeLlm(config: Pick<KnodeConfig, 'llm' | 'connections' | 'llmUse' | 'agentLlms'>): LlmConnection {
  const targets = llmTargets(config);
  return (
    targets.find((c) => c.id === config.llmUse) ??
    targets[0] ?? {
      ...config.llm,
      id: config.llmUse || 'default-1',
      label: config.llm.label?.trim() || llmProviderLabel(config.llm.provider),
    }
  );
}

/** Rewrite the `llm` mirror from the active row, repairing a dangling `llmUse`. */
export function syncActiveLlm(config: KnodeConfig): KnodeConfig {
  const { id, ...endpoint } = activeLlm(config);
  config.llm = endpoint;
  config.llmUse = id;
  return config;
}

/**
 * Everything the default can run on: the model endpoints, then the CLI
 * agents, called one-shot. An endpoint wins an id clash, since it is what the
 * config itself names. A pipeline route can run on more — see `routeTargets`.
 */
export function llmTargets(config: Pick<KnodeConfig, 'connections' | 'agentLlms'> & { llmUse?: string }): LlmConnection[] {
  const connections = config.connections ?? [];
  const agents = (config.agentLlms ?? []).filter((a) => !connections.some((c) => c.id === a.id));
  return [...connections, ...bindAgentEndpoints(agents, connections, config.llmUse ?? '')];
}

/**
 * The model connection an opencode-cli agent runs on: the one it names, or
 * the default LLM's for '' and 'default'. Only a model endpoint qualifies —
 * never another agent, so a default that is this very agent binds nothing
 * rather than going round in a circle.
 */
export function modelConnectionFor(connections: LlmConnection[], spec: string, llmUse: string): LlmConnection | null {
  const wanted = spec.trim();
  const id = !wanted || wanted === 'default' ? llmUse : wanted;
  const connection = connections.find((c) => c.id === id);
  return connection && connection.provider === 'openai' && connection.baseUrl ? connection : null;
}

/**
 * Give every opencode-cli agent row the endpoint, key and protocol of the
 * connection it names, and that connection's model when it names none of its
 * own. OpenCode brings no login: it is a loop, and the model it loops on is
 * one of `connections`. The key stays in its raw form (`env:VAR` or the
 * literal); the launcher hands it to the process in the environment, never in
 * argv or a file. A row whose connection is gone keeps an empty `baseUrl`, and
 * running it says so.
 */
export function bindAgentEndpoints(rows: LlmConnection[], connections: LlmConnection[], llmUse: string): LlmConnection[] {
  return rows.map((row) => {
    if (row.provider !== 'opencode-cli') return row;
    const endpoint = modelConnectionFor(connections, row.connection ?? '', llmUse);
    if (!endpoint) return { ...row, baseUrl: '', apiKey: '' };
    return { ...row, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, protocol: endpoint.protocol ?? 'auto', model: row.model || endpoint.model };
  });
}

/**
 * Everything a pipeline route can run on: `llmTargets`, then the deepagents
 * agents, each as its endpoint with the deepagents loop on it.
 *
 * A stage sends its own prompt and wants one answer back. A model answers it
 * directly; an agent runs its own loop on it once and hands back the final
 * answer — a CLI agent as that CLI, a deepagents agent as the deepagents loop
 * on its model (`loop`, see `completeViaDeepagents`). So a deepagents agent is
 * not its endpoint's row again under another name, even when it names no
 * model of its own: the same model, reached through the loop.
 *
 * The default cannot be one of these, since they may follow it — so they
 * stay out of `llmTargets`. One following a default that is a CLI agent does
 * not run at all (see `resolveAgentSpec`), so it is no target either.
 */
export function routeTargets(
  config: Pick<KnodeConfig, 'llm' | 'connections' | 'llmUse' | 'agentLlms' | 'modelAgents'>,
): LlmConnection[] {
  const targets = llmTargets(config);
  const connections = config.connections ?? [];
  const agents: LlmConnection[] = [];
  for (const agent of config.modelAgents ?? []) {
    if (targets.some((t) => t.id === agent.id)) continue;
    const endpoint = agent.runsOn === 'default' ? activeLlm(config) : connections.find((c) => c.id === agent.runsOn);
    if (!endpoint || isCliProvider(endpoint.provider)) continue;
    agents.push({ ...endpoint, id: agent.id, label: agent.label, model: agent.model || endpoint.model, loop: 'deepagents' });
  }
  return [...targets, ...agents];
}

/** The route that replaced a tier model, which a pinned route takes over. */
const LEGACY_ROUTE_MODELS: Partial<Record<(typeof ROUTE_KEYS)[number], 'tier1Model'>> = {
  entityLlm: 'tier1Model',
};

/**
 * Write down what each pipeline stage runs on, by id.
 *
 * A stage could name nothing and follow the default, which its picker offered
 * beside the default's own row — two entries for one endpoint that only came
 * apart later, when the default moved. A stage now names what it runs on, so
 * a route that names nothing — or something since deleted, which resolved to
 * the default anyway — is pinned to what the default is now, with the legacy
 * tier model it was using. Moving the default later moves no stage.
 *
 * Returns whether any route moved. Leaves them alone when the default itself
 * names nothing that can run, since there is nothing to pin to.
 */
export function pinRoutes(config: KnodeConfig): boolean {
  const targets = routeTargets(config);
  if (!targets.some((t) => t.id === config.llmUse)) return false;
  let moved = false;
  for (const key of ROUTE_KEYS) {
    const route = config.extraction[key];
    // 'default' is what `resolveRoutedLlmConfig` reads as the default, even
    // when an agent happens to have that name
    if (route.use && route.use !== 'default' && targets.some((t) => t.id === route.use)) continue;
    const legacy = LEGACY_ROUTE_MODELS[key];
    config.extraction[key] = { ...route, use: config.llmUse, model: route.model || (legacy ? config.extraction[legacy] : '') };
    if (legacy) config.extraction[legacy] = '';
    moved = true;
  }
  return moved;
}

/** How long a CLI agent's one-shot call may take; agent files carry no timeout of their own for it. */
const CLI_ONE_SHOT_TIMEOUT_MS = 300_000;

/** The CLI agents under `playbooks/agents/`, shaped as the connections `llmTargets` hands on. */
export function readAgentLlms(dataDir: string): LlmConnection[] {
  const out: LlmConnection[] = [];
  for (const name of agentFileNames(dataDir)) {
    const raw = readAgentFile(dataDir, name);
    const executor = typeof raw?.executor === 'string' ? raw.executor.trim() : '';
    if (!raw || !isCliProvider(executor)) continue;
    const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
    out.push({
      id: name,
      label: text('title') || name,
      provider: executor,
      baseUrl: '',
      apiKey: '',
      model: text('model'),
      cliPath: text('cliPath'),
      effort: LLM_EFFORTS.includes(raw.effort as LlmEffort) ? (raw.effort as LlmEffort) : 'default',
      speed: LLM_SPEEDS.includes(raw.speed as LlmSpeed) ? (raw.speed as LlmSpeed) : 'default',
      cliTimeoutMs: CLI_ONE_SHOT_TIMEOUT_MS,
      // which model endpoint it loops on; `llmTargets` fills in the rest
      ...(executor === 'opencode-cli' ? { connection: text('connection') } : {}),
    });
  }
  return out;
}

/** A deepagents agent as a pipeline route sees it: which model it runs on. */
export interface ModelAgent {
  id: string;
  label: string;
  /** Its `executor`: 'default' follows the default LLM, anything else names a connection. */
  runsOn: string;
  /** Empty = the model of the endpoint it runs on. */
  model: string;
}

/**
 * The deepagents agents under `playbooks/agents/`, left for `routeTargets` to
 * resolve against the connections. An agent file with no executor follows the
 * default, the way `normalizeAgent` reads it.
 */
export function readModelAgents(dataDir: string): ModelAgent[] {
  const out: ModelAgent[] = [];
  for (const name of agentFileNames(dataDir)) {
    const raw = readAgentFile(dataDir, name);
    if (!raw) continue;
    const executor = typeof raw.executor === 'string' ? raw.executor.trim() : 'default';
    if (isCliProvider(executor)) continue;
    const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
    out.push({ id: name, label: text('title') || name, runsOn: executor, model: text('model') });
  }
  return out;
}

/**
 * Move coding-agent CLIs out of `connections` and into `playbooks/agents/`.
 *
 * A CLI is an agent that brings its own loop, not a model endpoint. Keeping it
 * among the models made "cursor" the default *LLM*, and made the built-in deep
 * agent — which follows the default — quietly run Cursor instead of deepagents.
 *
 * Each row becomes an agent file under its own id, so every route, `llmUse`,
 * research role and agent spec that named it keeps resolving; `llmTargets`
 * hands CLI agents back to the pipeline as one-shot LLMs. Agents that ran on a
 * row — by its id, or as a bare CLI name borrowing its model — take its path
 * and model into their own file, and a bare `research.agent` / `chat.agent`
 * becomes the agent it was borrowing from, so nothing runs differently.
 *
 * The one deliberate change: a default that was a CLI moves to the first model
 * endpoint that has a model, because deepagents follows the default and
 * cannot run on a CLI. A workspace with no such endpoint keeps the CLI.
 *
 * Idempotent: once the rows are gone there is nothing left to move.
 */
export function migrateCliConnections(config: KnodeConfig, dataDir: string): KnodeConfig {
  const cli = (config.connections ?? []).filter((c) => isCliProvider(c.provider));
  if (cli.length === 0) return config;

  const before = new Set(agentFileNames(dataDir));
  const names = new Map<string, string>();
  for (const connection of cli) {
    const existing = readAgentFile(dataDir, connection.id);
    // a rerun finds its own file; a different agent under that name keeps it
    const reuse = isValidAgentName(connection.id) && (!existing || existing.executor === connection.provider);
    const name = reuse ? connection.id : uniqueAgentName(dataDir, connection.id, connection.provider);
    if (!readAgentFile(dataDir, name)) {
      writeAgentFile(dataDir, name, {
        name,
        title: connection.label?.trim() || llmProviderLabel(connection.provider),
        description: '',
        executor: connection.provider,
        cliPath: connection.cliPath ?? '',
        model: connection.model ?? '',
        effort: connection.effort ?? 'default',
        // what a bare spec used to launch with, so Ask on it behaves the same
        tools: { write: true, files: true, web: 'inherit' },
        maxTurns: 0,
        timeoutMs: 0,
        prompt: '',
      });
    }
    names.set(connection.id, name);
  }

  // the row a bare CLI name borrowed its path and model from: the default's
  // when it runs that CLI, else the first that does (see `bareAgentFor`)
  const lender = (provider: string) =>
    cli.find((c) => c.id === config.llmUse && c.provider === provider) ?? cli.find((c) => c.provider === provider);

  const created = new Set(names.values());
  for (const name of before) {
    if (created.has(name)) continue;
    const raw = readAgentFile(dataDir, name);
    const executor = typeof raw?.executor === 'string' ? raw.executor.trim() : '';
    if (!raw || !executor) continue;
    const source = cli.find((c) => c.id === executor) ?? (isCliProvider(executor) && !raw.model && !raw.cliPath ? lender(executor) : undefined);
    if (!source) continue;
    writeAgentFile(dataDir, name, {
      ...raw,
      executor: source.provider,
      cliPath: (typeof raw.cliPath === 'string' && raw.cliPath.trim()) || source.cliPath || '',
      model: (typeof raw.model === 'string' && raw.model.trim()) || source.model || '',
    });
  }

  for (const key of ROUTE_KEYS) {
    const route = config.extraction[key];
    if (route?.use && names.has(route.use)) route.use = names.get(route.use)!;
  }
  for (const key of ['research', 'chat'] as const) {
    const spec = config[key]?.agent?.trim();
    if (!spec) continue;
    const source = names.has(spec) ? cli.find((c) => c.id === spec) : isCliProvider(spec) ? lender(spec) : undefined;
    if (source) config[key].agent = names.get(source.id)!;
  }

  config.connections = config.connections.filter((c) => !isCliProvider(c.provider));
  if (names.has(config.llmUse)) {
    const model = config.connections.find((c) => c.model && c.baseUrl);
    config.llmUse = model?.id ?? names.get(config.llmUse)!;
  }
  config.agentLlms = readAgentLlms(dataDir);
  config.modelAgents = readModelAgents(dataDir);
  console.warn(`knode: ${[...names.values()].join(', ')} moved from connections to playbooks/agents/ — a coding-agent CLI is an agent now (Settings → Providers & Agents)`);
  return syncActiveLlm(config);
}

function uniqueAgentName(dataDir: string, id: string, provider: string): string {
  const base = isValidAgentName(`${id}-agent`) ? `${id}-agent` : provider;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!readAgentFile(dataDir, name)) return name;
  }
}

function sameEndpoint(a: LlmConfig, b: LlmConfig): boolean {
  return a.provider === b.provider && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.cliPath === b.cliPath;
}

function uniqueConnectionId(provider: LlmProvider, connections: LlmConnection[]): string {
  for (let n = 1; ; n++) {
    const id = `${provider}-${n}`;
    if (!connections.some((c) => c.id === id)) return id;
  }
}

/**
 * Lift the single `embedding` block into the named library, in memory, so the
 * UI only has to understand a list. A config written before the library had
 * exactly one embedding provider; it becomes the first entry and stays active,
 * which is why nothing re-embeds on the upgrade.
 *
 * A `use` naming an entry that no longer exists falls back to the first one
 * rather than failing: deleting a provider degrades the workspace the way an
 * unknown route id does, it does not break indexing.
 */
export function migrateEmbeddingProviders(config: KnodeConfig): KnodeConfig {
  if (!config.embeddingProviders?.length) {
    const id = uniqueEmbeddingId(config.embedding.provider, []);
    config.embeddingProviders = [{ ...config.embedding, id, label: embeddingProviderLabel(config.embedding.provider) }];
    config.embeddingUse = id;
  }
  return syncActiveEmbedding(config);
}

/**
 * The entry the Index stage runs on. Unlike an LLM route there is no `inherit`
 * case — one entry simply is the active one. A `use` naming an entry that no
 * longer exists falls back to the first rather than failing an ingest pass:
 * deleting the active provider re-embeds on the next save, it does not break.
 */
export function activeEmbedding(
  config: Pick<KnodeConfig, 'embedding' | 'embeddingProviders' | 'embeddingUse'>,
): EmbeddingConnection {
  const providers = config.embeddingProviders ?? [];
  return (
    providers.find((e) => e.id === config.embeddingUse) ??
    providers[0] ?? {
      ...config.embedding,
      id: config.embeddingUse || uniqueEmbeddingId(config.embedding.provider, []),
      label: embeddingProviderLabel(config.embedding.provider),
    }
  );
}

/**
 * Rewrite the `embedding` mirror from the active entry, repairing a dangling
 * `embeddingUse` on the way. The save path calls this before the re-embed diff
 * runs, so that diff keeps comparing two plain endpoints.
 */
export function syncActiveEmbedding(config: KnodeConfig): KnodeConfig {
  const entry = activeEmbedding(config);
  config.embeddingUse = entry.id;
  const pool = config.embeddingPool;
  config.embedding = pool?.enabled ? {
    provider: 'openai', baseUrl: 'pool://l2-v1', apiKey: '', model: pool.model,
    dimensions: pool.dimensions, batchSize: pool.batchSize, sendDimensions: false,
  } : {
    provider: entry.provider, baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model,
    dimensions: entry.dimensions, batchSize: entry.batchSize, sendDimensions: entry.sendDimensions,
  };
  return config;
}

/**
 * What makes two embedding configurations produce comparable vectors: every
 * field that changes the vector space and nothing that does not, so rotating a
 * key or widening a batch never costs a re-embed — and repointing one model
 * name at a different vendor does.
 */
export function embeddingIdentity(cfg: EmbeddingConfig): string {
  // the local hashing embedder reads nothing but the dimension, so its unused
  // endpoint fields must not be able to trigger a re-embed
  if (cfg.provider === 'local') return `local|${cfg.dimensions}`;
  return [cfg.provider, cfg.baseUrl.replace(/\/+$/, ''), cfg.model, cfg.dimensions, cfg.sendDimensions].join('|');
}

function uniqueEmbeddingId(provider: EmbeddingConfig['provider'], providers: EmbeddingConnection[]): string {
  for (let n = 1; ; n++) {
    const id = `${provider}-${n}`;
    if (!providers.some((e) => e.id === id)) return id;
  }
}

export function embeddingProviderLabel(provider: EmbeddingConfig['provider']): string {
  switch (provider) {
    case 'openai': return 'OpenAI-compatible API';
    case 'ark-multimodal': return 'Volcengine Ark · multimodal';
    case 'local': return 'Local hashing · offline';
    default: return provider;
  }
}

/** The built-in providers' display names; a plugin provider's label comes from its registration (GET /api/config/providers). */
export function llmProviderLabel(provider: LlmProvider): string {
  switch (provider) {
    case 'openai': return 'OpenAI-compatible API';
    case 'codex-cli': return 'Codex CLI';
    case 'claude-cli': return 'Claude Code CLI';
    case 'cursor-cli': return 'Cursor Agent CLI';
    case 'opencode-cli': return 'OpenCode CLI';
    case 'command': return 'Command · any executable';
    default: return provider;
  }
}

export function saveConfig(dataDir: string, config: KnodeConfig): void {
  const file = path.join(dataDir, CONFIG_FILE);
  // derived from the agent files; writing them would make two copies to disagree
  const { agentLlms: _derived, modelAgents: _alsoDerived, ...persisted } = config;
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * A local time of day the way the nightly schedulers match it against the
 * clock: zero-padded 24-hour "HH:MM". An unpadded hour ("3:00") is read as
 * meant; anything else ("3am", "25:00", "03:5") is null.
 */
export function normalizeTimeOfDay(value: unknown): string | null {
  const match = typeof value === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return formatTimeOfDay(hours * 60 + minutes);
}

/** An "HH:MM" time of day `minutes` later: carried into the next hour, wrapped past midnight. */
export function addMinutesToTimeOfDay(time: string, minutes: number): string {
  const [hours, mins] = time.split(':').map(Number);
  return formatTimeOfDay(hours * 60 + mins + minutes);
}

function formatTimeOfDay(minutesSinceMidnight: number): string {
  const day = 24 * 60;
  const t = ((minutesSinceMidnight % day) + day) % day;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Resolve "env:VAR" indirection in API keys. */
export function resolveSecret(value: string): string {
  if (value.startsWith('env:')) return process.env[value.slice(4)] ?? '';
  return value;
}

/** Resolve the data directory from CLI flag > env > default ~/.knode-os. */
export function resolveDataDir(flag?: string): string {
  const dir = flag || process.env.KNODE_OS_DATA || path.join(os.homedir(), '.knode-os');
  return path.resolve(dir);
}

/** Redact secrets for API exposure. */
export function redactConfig(config: KnodeConfig): KnodeConfig {
  const clone = JSON.parse(JSON.stringify(config)) as KnodeConfig;
  // clients read agents from /api/agents; these copies are the service's own
  delete clone.agentLlms;
  delete clone.modelAgents;
  const secretHolders = [
    clone.embedding,
    clone.llm,
    clone.extraction.entityLlm,
    clone.extraction.documentLlm,
    clone.extraction.summaryLlm,
    clone.extraction.judgeLlm,
    clone.extraction.translateLlm,
    ...(clone.connections ?? []),
    ...(clone.embeddingProviders ?? []),
  ];
  for (const c of secretHolders) {
    if (c.apiKey && !c.apiKey.startsWith('env:')) c.apiKey = '***';
  }
  const search = clone.research?.web?.search;
  if (search?.apiKey && !search.apiKey.startsWith('env:')) search.apiKey = '***';
  const endpoint = clone.ingest?.embedEndpoint;
  if (endpoint?.apiKey && !endpoint.apiKey.startsWith('env:')) endpoint.apiKey = '***';
  if (clone.research?.web?.proxy) clone.research.web.proxy = redactConnectionUrl(clone.research.web.proxy);
  const literal = (value: unknown) => !(typeof value === 'string' && (value === '' || value.startsWith('env:')));
  for (const ds of clone.datasources ?? []) {
    if (ds.password && !ds.password.startsWith('env:')) ds.password = '***';
    // an API token travels as a header; a URL may carry a password of its own
    for (const name of Object.keys(ds.headers ?? {})) if (literal(ds.headers![name])) ds.headers![name] = '***';
    if (ds.baseUrl) ds.baseUrl = redactConnectionUrl(ds.baseUrl);
  }
  if (clone.database?.password && !clone.database.password.startsWith('env:')) clone.database.password = '***';
  if (clone.database?.url) clone.database.url = redactConnectionUrl(clone.database.url);
  // plugin options are the plugin's business, keys included; GET /api/plugins names them, never their values
  for (const spec of Array.isArray(clone.plugins) ? clone.plugins : []) {
    if (!spec || typeof spec !== 'object' || !spec.options || typeof spec.options !== 'object') continue;
    for (const key of Object.keys(spec.options)) if (literal(spec.options[key])) spec.options[key] = '***';
  }
  return clone;
}

/** A connection string with its password masked; an "env:VAR" reference or a string that is no URL is returned as it is. */
export function redactConnectionUrl(url: string): string {
  if (!url || url.startsWith('env:')) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.password) return url;
    parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}
