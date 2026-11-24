import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Context, Hono } from 'hono';
import { CallLedger } from '../estimate/ledger.js';
import { estimateProcessing } from '../estimate/processing.js';
import { quotaSources } from '../estimate/quota.js';
import { estimateStudy } from '../estimate/study.js';
import { LabelingScheduler } from '../labeling/scheduler.js';
import { LocalLabelingWorkers } from '../labeling/local.js';
import { LabelingProcessing } from '../labeling/processing.js';
import { mountRemoteApi } from '../remote/api.js';
import { mountEvalProducer } from '../remote/eval-producer.js';
import type { EvalWork } from '../work/eval.js';
import { WorkBroker } from '../work/broker.js';
import type { TranslateSource } from '../work/translate.js';
import type { DocumentRow } from '../types.js';
import { contentLanguages, LANGUAGES, LanguagesConfig, normalizeLanguage, normalizeLanguagesConfig, sameLanguage } from '../lang/languages.js';
import { documentLanguages, isDataFile, recordTranslationState, translatableDocument, translatedText, translationRow, withdrawTranslationRequest } from '../lang/translate.js';
import { accountMayOpenTeam } from '../auth/accounts.js';
import { AuthEnv, authMiddleware, existingTeams, mountAuthRoutes, mountGateways } from '../auth/http.js';
import { AuthService } from '../auth/service.js';
import { contentSecurityPolicy } from './csp.js';
import { embedOrigins, mountEmbed } from './embed.js';
import { findMarkedUmd, findWebDir } from '../web-assets.js';
import { OriginalError, readOriginal } from './originals.js';
import { publicGuard } from './public-guard.js';
import { AppContext, judgeLlmClient } from '../context.js';
import { shareSettingsEverywhere, sharedSnapshot } from '../global-settings.js';
import {
  EmbeddingConfig,
  EmbeddingPoolConfig,
  KnodeConfig,
  LlmConfig,
  LlmConnection,
  RoutedLlmConfig,
  SagSearchConfig,
  redactConfig,
  resolveRoutedLlmConfig,
  llmProviderLabel,
  EmbeddingConnection,
  embeddingProviderLabel,
  embeddingIdentity,
  activeEmbedding,
  syncActiveEmbedding,
  migrateDefaultLlm,
  migrateCliConnections,
  migrateRouteConnections,
  llmTargets,
  routeTargets,
  pinRoutes,
  readAgentLlms,
  readModelAgents,
  syncActiveLlm,
  defaultConfig,
  isCliProvider,
  saveConfig, ResearchConfig, ChatConfig, ReviewConfig, LLM_EFFORTS, LLM_PROTOCOLS, LLM_SPEEDS, ExtractionWorkerConfig, embeddingDeferred, ProcessingConfig, processingSettings } from '../config.js';
import { runSourceQuery } from '../datasource/execute.js';
import { MAX_FILE_BYTES, MAX_PREVIEW_BYTES } from '../constants.js';
import { assertNotPrivate, assertSourcePath, assertWritablePath, capText, cleanRelPath, grepAnswer, grepSearch, isOwnerRootFile, isPrivatePath, isRootWritableFile, listTree, makeDir, movePath, pathExists, readFileTextCapped, removePath, safePath, sanitizeRelativePath, writeFileBytes, writeFileText } from '../fs/files.js';
import { MarkdownMeta, markdownMeta } from '../markdown.js';
import { FOLDER_ABOUT, hasSidecarSegment, SIDECAR_ROOT, TREE_HIDDEN } from '../fs/layout.js';
import { listPlaybooks, readPlaybook, resetPlaybook, savePlaybook } from '../fs/playbooks.js';
import { moveSidecar } from '../fs/sidecar.js';
import { assertNotConvertedOriginal, readSourceTextCapped } from '../ingest/source.js';
import {
  assertNotLinked,
  describeLinkedFolders,
  FolderImportConflict,
  importDestFor,
  importFolder,
  linkedFolders,
  LinkedFolders,
  linkOwning,
  mirrorLinks,
  planFolderImport,
  refreshLinkedFolders,
  resolveImportSource,
  unlinkFolder,
} from '../ingest/folders.js';
import { addCodebase, assertFetchable, checkRef, codebaseActivity, codebaseCard, CodebaseConflict, codebaseDir, codebaseDocsDir, codebaseLinks, Codebases, describeAdd, describeCodebases, editCodebase, removeCodebase, updateActivity, updateCodebases } from '../ingest/codebase/codebases.js';
import { parseRepoSpec } from '../ingest/codebase/git.js';
import { listConversations as listAgentConversations } from '../ingest/conversations/catalog.js';
import { deleteFeed, feedConnectorCatalog, feedItems, checkFeed } from '../ingest/feeds/manage.js';
import { feedProblem, isValidFeedId, loadFeed, normalizeFeed, redactFeed, saveFeed } from '../ingest/feeds/definitions.js';
import { previewFeed, pushToFeed, runFeed } from '../ingest/feeds/run.js';
import { describeFeeds, FeedRunner } from '../ingest/feeds/runner.js';
import {
  AgentConversations,
  conversationCopies,
  conversationLinks,
  ConversationRef,
  describeConversationLinks,
  importConversations,
  previewConversation,
  refreshConversations,
  unfollowConversation,
} from '../ingest/conversations/follow.js';
import { FeishuError } from '../ingest/feishu/client.js';
import {
  describeFeishuLinks,
  feishuClient,
  FeishuDocs,
  feishuImportJobs,
  feishuLinks,
  FeishuSignIn,
  importFeishuBatch,
  importFeishuDocument,
  previewFeishu,
  refreshFeishuLinks,
  splitFeishuInputs,
  startFeishuImport,
  unlinkFeishuDocument,
} from '../ingest/feishu/docs.js';
import { parseFeishuRef } from '../ingest/feishu/markdown.js';
import { documentMentions } from '../graph/mentions.js';
import { entityDetail, graphInsights, graphOverview, graphSearch } from '../graph/query.js';
import { entitiesNamed } from '../graph/resolve.js';
import { buildContextPack } from '../pack/pack.js';
import { applySuggestion } from '../pack/learn.js';
import { learnConfig } from '../learn/config.js';
import { WritebackResult, writeBackAsk } from '../learn/writeback.js';
import { canonicalEmbeddingModel, createConfiguredEmbeddingProvider, EmbeddingQuotaLedger, embeddingLimits, validateEmbeddingPool } from '../ingest/embedding-router.js';
import { LlmClient } from '../llm/client.js';
import { cachedCliToolStatus, listModelsCached, warmModelCache } from '../llm/model-cache.js';
import { agentForSpec, resolveAgentSpec } from '../research/agent.js';
import {
  AgentDefinition,
  BUILTIN_AGENTS,
  deleteAgent,
  ensureDefaultAgents,
  isValidAgentName,
  loadAgent,
  loadAgents,
  saveAgent,
} from '../research/agents.js';
import { availableAgents, suggestResearchAgent } from '../research/executors.js';
import { sync, SyncStats } from '../ingest/sync.js';
import { citedBy } from '../lineage/citations.js';
import { historyOf, lineageOf } from '../lineage/inspect.js';
import { forgetSource, purgeArchived, purgeDisposed } from '../lineage/purge.js';
import { rebuild } from '../lineage/rebuild.js';
import { ask } from '../search/ask.js';
import { exploreSearch, searchSuggest } from '../search/explore.js';
import { search, SearchMode } from '../search/search.js';
import { activityOf, describeSync } from '../activity.js';
import type { EmbeddingBackfill } from '../ingest/embed-backfill.js';
import type { EmbedSource, LocalEmbedSlots } from '../work/embed.js';
import { checkEmbedEndpoint, EmbedEndpoint } from '../work/embed.js';
import { tasksSnapshot } from './tasks.js';
import { planOnly, resolve } from '../compiler/resolve.js';
import { liveAbsences } from '../compiler/absence.js';
import { distillRecipes } from '../compiler/distill.js';
import { evaluatePacks, writeEvalReport } from '../compiler/evaluate.js';
import { writeRankerReport } from '../compiler/ranker.js';
import { changesSince, listSubscriptions, subscribe, unsubscribe } from '../compiler/subscribe.js';
import { checkout, commitWorkset, envelopeFor, listWorksets } from '../compiler/workset.js';
import { listDisputes, resolveDispute, setScopeTrust, TRUST_TIERS, TrustTier } from '../lineage/trust.js';
import { listReceipts, recordFeedback } from '../compiler/receipts.js';
import { readVirtual } from '../compiler/vfs.js';
import { renderCapabilityDts } from '../capability/dts.js';
import { listCapabilities, locatorsForEntities } from '../capability/store.js';
import { queryClaims } from '../store/claims.js';
import { CATALOG_SOURCE, CATALOG_VIEWS, catalogQuery } from '../store/catalog.js';
import { TemporalError, resolveScopeFilter, resolveTemporal } from '../store/resolver.js';
import { syncTraces } from '../traces/sync.js';
import { runDream } from '../dream/dream.js';
import { generateWiki } from '../wiki/generate.js';
import { validateOkfBundle } from '../okf/index.js';
import { configuredPluginSpecs } from '../plugins/loader.js';
import { pluginRegistry } from '../plugins/registry.js';
import { HOOK_NAMES } from '../plugins/types.js';
import { linkedName, resolveKnowledgeLink } from '../obsidian/links.js';
import {
  getSuggestion,
  knowledgeStats,
  listDatasets,
  listDocuments,
  listSuggestions,
  listTraces,
  setSuggestionStatus,
} from '../store/queries.js';
import { queryEntities } from '../store/entities.js';
import { WorkspaceContextRegistry, WorkspaceScope, resolveWorkspaceScope, workspaceDataDir } from './workspaces.js';
import { loadOrCreateMcpToken, McpWorkspaceTokens, mountMcp } from './mcp-http.js';
import { viewerToolOptions } from './evaluation.js';
import { applyClaimMerge, listClaimMerges, unmergeClaim } from '../graph/claim-merge.js';
import { applyMerge, listMerges, unmergeEntity } from '../graph/merge.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { reviewClaims } from '../graph/claim-review.js';
import { archiveJobs, cancelJob, deleteJobs, getJob, latestJob, listJobs, queueJob, resumeJob, retryJob, ResearchStatus } from '../research/jobs.js';
import { activePause } from '../research/failure.js';
import { builtinAvailable, killAgentsFor } from '../research/launch.js';
import { loadResearchTemplates, PHASES, RESEARCH_KINDS, ResearchKind } from '../research/templates.js';
import { activeProfile, BUILTIN_PROFILES, deleteProfile, effectivePipeline, isValidProfileName, loadProfile, loadProfiles, PIPELINE_MODES, profileSummary, ResearchProfile, rolePromptText, saveProfile, writeRolePrompt } from '../research/profile.js';
import { surveyKnowledgeBase } from '../research/survey.js';
import { cancelChatTurn, chatActivity, ChatBusyError, isChatRunning, removeChatWorkspace, resolveChatAgent, startChatTurn } from '../chat/runner.js';
import { createConversation, deleteConversation, getConversation, listConversations } from '../chat/store.js';
import { CHAT_PROTOCOL_FILE, loadChatProtocol, saveChatProtocol } from '../chat/templates.js';
import { CHAT_DIR } from '../fs/layout.js';
import { McpEndpoint, runsRoot } from '../research/workspace.js';
import { recommendWikiTopics, refreshRecommendations } from '../research/recommend.js';
import { captureUrl, readManifest } from '../research/capture.js';
import { deleteResearchSource, loadResearchSources, redactSource, RESEARCH_SOURCE_KINDS, saveResearchSource, sourceProblem } from '../research/sources.js';
import { archiveStudy, cancelStudy, createStudy, listStudies, promoteStudy, refineStudyInBackground, refiningSince, removeStudy, resumeStudy, retryStudy, startProblem, startStudy, StudyFiles, studyPause, studyView, updateStudy, studyPayload } from '../research/study.js';
import { EXPORT_POLICY, exportStudy, StudyExportError } from '../research/export.js';
import { webSearchEnabled, WEB_SEARCH_PROVIDERS } from '../research/web.js';
import { lintWiki } from '../wiki/lint.js';
import { listNotices } from './notices.js';

/**
 * What Ask cannot answer without. Both are states a person fixes in Settings,
 * so the text names the screen rather than the config key.
 */
const NO_MCP_HINT = 'Ask needs the MCP endpoint `serve` hosts — start knode-os serve';
const NO_AGENT_HINT = 'Ask has no agent to run: configure an LLM provider, or name an agent, under Settings → Providers & Agents';
const NO_BUILTIN_HINT = 'the built-in agent is not installed in this build — point Ask at a coding-agent CLI under Settings → Providers & Agents';

/** `GET /api/tree?meta=1`: the Markdown files of a listing whose frontmatter is read, and how much of each. */
const TREE_META_FILES = 500;
const TREE_META_BYTES = 16 * 1024;

/**
 * An embeddings endpoint as Settings sends it: an http(s) URL up to /v1 and a
 * model. A key of '***' keeps the one saved (GET /api/config redacts it).
 */
function embedEndpointOf(value: unknown, saved: EmbedEndpoint | null | undefined): EmbedEndpoint {
  const v = (value ?? {}) as { baseUrl?: unknown; model?: unknown; apiKey?: unknown };
  const baseUrl = String(v.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(v.model ?? '').trim();
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(baseUrl)) throw new Error('the endpoint needs an http(s) URL, e.g. http://127.0.0.1:12020/v1');
  if (!model) throw new Error('name the model the endpoint serves, e.g. BAAI/bge-m3');
  const key = typeof v.apiKey === 'string' ? v.apiKey.trim() : '';
  const apiKey = key === '***' ? saved?.apiKey : key || undefined;
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

/** Comma-separated query parameter → array (absent/empty stays undefined). */
function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const out = value.split(',').map((x) => x.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

type ExtractionConfigDraft = {
  entityLlm?: Partial<RoutedLlmConfig>;
  documentLlm?: Partial<RoutedLlmConfig>;
  summaryLlm?: Partial<RoutedLlmConfig>;
  judgeLlm?: Partial<RoutedLlmConfig>;
  translateLlm?: Partial<RoutedLlmConfig>;
  claims?: boolean;
  batchSize?: number;
  concurrency?: number;
  summaryConcurrency?: number;
  translateConcurrency?: number;
  summaryMinChars?: number;
  summaryMaxSegments?: number;
  summaryAfterExtraction?: boolean;
  workers?: Partial<ExtractionWorkerConfig>[];
};

type ModelConfigDraft = {
  /** Legacy single-provider shape. A client that sends it is editing the active provider. */
  embedding?: Partial<EmbeddingConfig>;
  embeddingProviders?: Partial<EmbeddingConnection>[];
  embeddingUse?: string;
  embeddingPool?: Partial<EmbeddingPoolConfig>;
  ingest?: { concurrency?: number; convertConcurrency?: number; embedding?: string; embedSlots?: number; embedEndpoint?: { baseUrl?: string; model?: string; apiKey?: string } | null };
  llm?: Partial<LlmConfig>;
  connections?: Partial<LlmConnection>[];
  llmUse?: string;
  extraction?: ExtractionConfigDraft;
  retrieval?: { sag?: Partial<SagSearchConfig> };
  research?: Partial<Omit<ResearchConfig, 'auto' | 'init' | 'study' | 'web'>> & {
    auto?: Partial<ResearchConfig['auto']>;
    init?: Partial<ResearchConfig['init']>;
    study?: Partial<ResearchConfig['study']>;
    web?: Partial<Omit<ResearchConfig['web'], 'search'>> & { search?: Partial<ResearchConfig['web']['search']> };
  };
  chat?: Partial<ChatConfig>;
  /** What the Judge stage does with its verdicts, and the workspace's web switch (Research tab); the other review keys are file-only. */
  review?: Partial<Pick<ReviewConfig, 'llmJudge' | 'claims' | 'claimMerge' | 'external'>>;
  /** Content languages (docs/design/17). */
  languages?: Partial<LanguagesConfig>;
  /** This machine's processing, for every workspace on the server: the cap on calls at once, the quota floor. */
  processing?: Partial<ProcessingConfig>;
};

/** What `serve` runs per workspace beside the routes; absent in tests and CLI-hosted apps. */
export interface WorkspaceServices {
  /** The MCP endpoint agents launched for this workspace attach to (null until the server listens). */
  mcp: () => McpEndpoint | null;
  /** Claim queued research now instead of at the next tick. */
  kickResearch: () => void;
  /** Register a background promise so shutdown waits for it. */
  track: <T>(job: Promise<T>) => Promise<T>;
  /** The linked-folder watchers of this workspace; absent outside `serve`, where links are refreshed on demand only. */
  folders?: LinkedFolders | null;
  /** The poller of this workspace's linked Feishu documents; absent outside `serve`, where they are synced on demand only. */
  feishu?: FeishuDocs | null;
  /** The checker of this workspace's followed agent conversations; absent outside `serve`, where they are synced on demand only. */
  conversations?: AgentConversations | null;
  /** This workspace's code repositories: one fetch at a time, followed ones daily; absent outside `serve`. */
  codebases?: Codebases | null;
  /** This workspace's feeds (src/ingest/feeds): scheduled runs, Run now and pushes; absent outside `serve`. */
  feeds?: FeedRunner | null;
  /** Extraction as leased work (src/labeling): local slots and remote workers take segments from it. */
  labeling?: LabelingScheduler | null;
  /** Every kind of leased work — segments and summaries — behind one lease protocol (src/work/broker.ts). */
  work?: WorkBroker | null;
  localWorkers?: LocalLabelingWorkers | null;
  /** Starts and stops the slots and the reviews; stopped until someone starts it. */
  processing?: LabelingProcessing | null;
  /** Translations into the content languages as leased work (src/work/translate.ts); a request wakes it. */
  translations?: TranslateSource | null;
  /** What answered calls cost, measured by the broker — an estimate's averages (src/estimate/ledger.ts). */
  calls?: CallLedger | null;
  /** Vectors computed after a document is indexed (src/ingest/embed-backfill.ts): what Tasks shows of embedding. */
  embeddings?: EmbeddingBackfill | null;
  /** In deferred mode, vectors as leased work (src/work/embed.ts): the backlog, audit requests, own endpoints. */
  embedWork?: EmbedSource | null;
  /** This machine's embed slots (`ingest.embedSlots`). */
  embedSlots?: LocalEmbedSlots | null;
}

/**
 * Paths the workspace is built from: a client may create and delete things
 * inside them, but never rename, move or remove the roots themselves.
 */
const PROTECTED_PATHS = new Set([
  '',
  '.',
  'wiki',
  'raw',
  'raw/docs',
  'playbooks',
  'playbooks/packs',
  'purpose.md',
  'schema.md',
  'knode.config.json',
  'AGENTS.md',
  'CLAUDE.md',
]);

/** A root path is protected however it is spelled (`wiki/..` resolves to the root too). */
function isProtectedPath(rel: string): boolean {
  return PROTECTED_PATHS.has(cleanRelPath(rel)) || PROTECTED_PATHS.has(rel);
}

/** A provider a client may name: a built-in, or one a loaded plugin registered (src/plugins). */
const knownLlmProvider = (id: unknown): id is string => typeof id === 'string' && pluginRegistry().llmProvider(id) !== undefined;
const knownEmbeddingProvider = (id: unknown): id is string => typeof id === 'string' && pluginRegistry().embeddingProvider(id) !== undefined;

type AppEnv = {
  Variables: {
    workspaceContext: AppContext;
    workspaceScope: WorkspaceScope;
  } & Partial<AuthEnv['Variables']>;
};

function mergeLlmConfig(current: LlmConfig, incoming: Partial<LlmConfig> = {}): LlmConfig {
  const cliTimeout = Number(incoming.cliTimeoutMs);
  return {
    provider: knownLlmProvider(incoming.provider) ? incoming.provider : current.provider,
    baseUrl: typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : current.baseUrl,
    apiKey: incoming.apiKey === '***' || incoming.apiKey === undefined ? current.apiKey : String(incoming.apiKey),
    model: typeof incoming.model === 'string' ? incoming.model.trim() : current.model,
    cliPath: typeof incoming.cliPath === 'string' ? incoming.cliPath.trim() : current.cliPath,
    effort: incoming.effort && LLM_EFFORTS.includes(incoming.effort) ? incoming.effort : current.effort,
    speed: incoming.speed && LLM_SPEEDS.includes(incoming.speed) ? incoming.speed : current.speed,
    protocol: incoming.protocol && LLM_PROTOCOLS.includes(incoming.protocol) ? incoming.protocol : current.protocol,
    cliTimeoutMs: Number.isFinite(cliTimeout) && cliTimeout >= 1000 ? Math.floor(cliTimeout) : current.cliTimeoutMs,
    label: typeof incoming.label === 'string' ? incoming.label.trim() : current.label,
  };
}

function mergeRoutedLlmConfig(current: RoutedLlmConfig, incoming: Partial<RoutedLlmConfig> = {}): RoutedLlmConfig {
  const cliTimeout = Number(incoming.cliTimeoutMs);
  const provider = incoming.provider;
  return {
    use: typeof incoming.use === 'string' ? incoming.use.trim() : current.use,
    provider: provider === 'inherit' || knownLlmProvider(provider) ? provider : current.provider,
    baseUrl: typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : current.baseUrl,
    apiKey: incoming.apiKey === '***' || incoming.apiKey === undefined ? current.apiKey : String(incoming.apiKey),
    model: typeof incoming.model === 'string' ? incoming.model.trim() : current.model,
    cliPath: typeof incoming.cliPath === 'string' ? incoming.cliPath.trim() : current.cliPath,
    effort: incoming.effort && LLM_EFFORTS.includes(incoming.effort) ? incoming.effort : current.effort,
    speed: incoming.speed && LLM_SPEEDS.includes(incoming.speed) ? incoming.speed : current.speed,
    protocol: incoming.protocol && LLM_PROTOCOLS.includes(incoming.protocol) ? incoming.protocol : current.protocol,
    cliTimeoutMs: Number.isFinite(cliTimeout) && cliTimeout >= 1000 ? Math.floor(cliTimeout) : current.cliTimeoutMs,
  };
}

/**
 * Connections replace wholesale — the client owns the list, including order and
 * deletions — but each one keeps its stored secret when the client echoes back
 * the redacted '***', and anything without a usable id is dropped rather than
 * saved as an unreferenceable row.
 */
function mergeConnections(current: LlmConnection[], incoming: Partial<LlmConnection>[] | undefined): LlmConnection[] {
  if (!incoming) return current;
  const out: LlmConnection[] = [];
  for (const draft of incoming) {
    const id = typeof draft.id === 'string' ? draft.id.trim() : '';
    if (!id || id === 'default' || out.some((c) => c.id === id)) continue;
    const previous = current.find((c) => c.id === id);
    const merged = mergeLlmConfig(previous ?? defaultConnectionConfig(), draft);
    out.push({
      ...merged,
      id,
      label: typeof draft.label === 'string' && draft.label.trim() ? draft.label.trim() : previous?.label || llmProviderLabel(merged.provider),
    });
  }
  return out;
}

/**
 * What a draft's pipeline routes can run on: the models it lists, then the
 * agents as saved — they are files, written before the config that names
 * them. A deepagents agent following the default follows the draft's.
 */
function draftRouteTargets(config: KnodeConfig, draft: ModelConfigDraft): LlmConnection[] {
  const llmUse = typeof draft.llmUse === 'string' && draft.llmUse.trim() ? draft.llmUse.trim() : config.llmUse;
  return routeTargets({
    llm: config.llm,
    connections: mergeConnections(config.connections, draft.connections),
    llmUse,
    agentLlms: config.agentLlms,
    modelAgents: config.modelAgents,
  });
}

/** One embedding entry, merged onto what is stored so '***' keeps the real key. */
function mergeEmbeddingConfig(current: EmbeddingConfig, incoming: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  const dims = Number(incoming.dimensions);
  const batch = Number(incoming.batchSize);
  return {
    provider: knownEmbeddingProvider(incoming.provider) ? incoming.provider : current.provider,
    baseUrl: typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : current.baseUrl,
    apiKey: incoming.apiKey === '***' || incoming.apiKey === undefined ? current.apiKey : String(incoming.apiKey),
    model: typeof incoming.model === 'string' ? incoming.model.trim() : current.model,
    dimensions: Number.isFinite(dims) && dims >= 1 ? Math.floor(dims) : current.dimensions,
    batchSize: Number.isFinite(batch) && batch >= 1 ? Math.floor(batch) : current.batchSize,
    sendDimensions: typeof incoming.sendDimensions === 'boolean' ? incoming.sendDimensions : current.sendDimensions,
  };
}

/**
 * The embedding library replaces wholesale, like `connections`: the client owns
 * the order and the deletions. An absent list means the client does not model
 * them yet, so the stored ones stay.
 */
function mergeEmbeddings(
  current: EmbeddingConnection[],
  incoming: Partial<EmbeddingConnection>[] | undefined,
): EmbeddingConnection[] {
  if (!incoming) return current;
  const out: EmbeddingConnection[] = [];
  for (const draft of incoming) {
    const id = typeof draft.id === 'string' ? draft.id.trim() : '';
    if (!id || out.some((e) => e.id === id)) continue;
    const previous = current.find((e) => e.id === id);
    const merged = mergeEmbeddingConfig(previous ?? defaultEmbeddingConfig(), draft);
    const entry: EmbeddingConnection = {
      ...previous,
      ...merged,
      id,
      label: typeof draft.label === 'string' && draft.label.trim() ? draft.label.trim() : previous?.label || embeddingProviderLabel(merged.provider),
    };
    if (typeof draft.enabled === 'boolean') entry.enabled = draft.enabled;
    if (draft.priority !== undefined) {
      if (!Number.isSafeInteger(draft.priority) || draft.priority < 0) throw new Error('Priority must be a non-negative integer.');
      entry.priority = draft.priority;
    }
    for (const field of ['quotaGroup', 'limitNote', 'upstream'] as const) {
      if (typeof draft[field] === 'string') entry[field] = draft[field].trim();
    }
    if (draft.catalog !== undefined) {
      if (!Array.isArray(draft.catalog) || !draft.catalog.every((id) => typeof id === 'string')) throw new Error('Invalid embedding model catalog.');
      entry.catalog = [...new Set(draft.catalog.map((id) => id.trim()).filter(Boolean))].slice(0, 1000);
    }
    if (draft.limits !== undefined) entry.limits = { ...embeddingLimits(entry), ...draft.limits };
    embeddingLimits(entry);
    out.push(entry);
  }
  // Something has to embed, so a list that would end up empty keeps the current one.
  return out.length ? out : current;
}

function defaultEmbeddingConfig(): EmbeddingConfig {
  return { provider: 'openai', baseUrl: '', apiKey: '', model: '', dimensions: 1536, batchSize: 32, sendDimensions: false };
}

/**
 * Fold a draft's embedding sections into one answer, so /test, /models and PUT
 * can never disagree about which provider a draft would actually run on. The
 * library is the authority; a draft carrying only the legacy `embedding` block
 * — the pre-library web UI — is a patch to the active entry, which is also how
 * its echoed '***' finds the right stored key.
 */
function mergeEmbeddingSection(
  current: KnodeConfig,
  draft: ModelConfigDraft,
): Pick<KnodeConfig, 'embedding' | 'embeddingProviders' | 'embeddingUse' | 'embeddingPool'> {
  const next: KnodeConfig = { ...current };
  next.embeddingProviders = mergeEmbeddings(current.embeddingProviders, draft.embeddingProviders);
  if (typeof draft.embeddingUse === 'string') next.embeddingUse = draft.embeddingUse.trim();
  if (draft.embeddingPool) {
    next.embeddingPool = { enabled: false, model: 'bge-m3', dimensions: 1024, batchSize: 16,
      ...current.embeddingPool, ...draft.embeddingPool };
    if (typeof next.embeddingPool.enabled !== 'boolean' || typeof next.embeddingPool.model !== 'string') throw new Error('Invalid embedding pool.');
    next.embeddingPool.model = next.embeddingPool.model.trim();
  }
  if (draft.embedding && !draft.embeddingProviders) {
    const active = activeEmbedding(next);
    next.embeddingProviders = next.embeddingProviders.map((e) =>
      (e.id === active.id ? { ...e, ...mergeEmbeddingConfig(e, draft.embedding) } : e));
  }
  syncActiveEmbedding(next);
  return { embedding: next.embedding, embeddingProviders: next.embeddingProviders, embeddingUse: next.embeddingUse, embeddingPool: next.embeddingPool };
}

function defaultConnectionConfig(): LlmConfig {
  return { provider: 'openai', baseUrl: '', apiKey: '', protocol: 'auto', model: '', cliPath: '', effort: 'default', cliTimeoutMs: 300_000 };
}

async function testLlmConfig(config: LlmConfig): Promise<unknown> {
  const client = new LlmClient(config);
  if (!client.enabled) return { ok: true, enabled: false, note: 'no model set — this route is disabled' };
  const t0 = Date.now();
  const reply = await client.complete([{ role: 'user', content: 'Reply with exactly the word: pong' }], { maxTokens: 8 });
  return { ok: true, enabled: true, model: client.label, sample: reply.trim().slice(0, 120), ms: Date.now() - t0 };
}

/**
 * Set on a `GET /api/search` response whose vector channel returned fewer
 * candidates than it was asked for though more exist (`SearchResults.partial`):
 * what stopped it. The body is the array of results either way.
 */
export const SEARCH_PARTIAL_HEADER = 'x-knode-search-partial';

/**
 * The most results `GET /api/search` returns, whatever `k` asks for: the
 * bound a walk (`sag`) already has, twice the search tool's 50. The route had
 * none — `k=1e9` answered with every chunk a query's words matched, content
 * and all, which on a large workspace is the corpus in one response. Its
 * callers ask for far fewer: the web embed 24, the desktop app 12, the CLI
 * what its user types (8 unless told).
 */
export const SEARCH_ROUTE_K_MAX = 100;

/** What every refused route of an evaluation root's viewer answers (409). */
export const EVALUATION_READ_ONLY = 'evaluation workspaces are read-only';

/** Requests that only read though they are not GETs: the viewer serves them. */
const VIEWER_READING_POSTS = new Set(['/api/entities/mentions']);
/** GETs that write (a report file, a subscription's cursor) or start work (research): the viewer refuses them. */
const VIEWER_WRITING_GETS = [/^\/api\/learning$/, /^\/api\/research\//, /^\/api\/subscriptions\/[^/]+\/changes$/];

/** Whether an evaluation root's viewer answers this request with 409 (docs/design/35 §4). */
export function viewerRefuses(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return VIEWER_WRITING_GETS.some((re) => re.test(pathname));
  return !VIEWER_READING_POSTS.has(pathname);
}

export function createApp(
  rootCtx: AppContext,
  log: (msg: string) => void = console.log,
  workspaceContexts = new WorkspaceContextRegistry(rootCtx.dataDir, { templateConfig: () => rootCtx.config }),
  opts: {
    services?: (ctx: AppContext) => WorkspaceServices | null;
    /** Sign-in (src/auth); absent, the app trusts the workspace headers and only the remote API is reachable from outside. */
    auth?: AuthService | null;
    /** The MCP tokens `serve` mints for the agents it launches, one per workspace (src/server/mcp-http.ts). */
    mcpTokens?: McpWorkspaceTokens;
    /** An evaluation run's work offered to remote workers (src/work/eval.ts); absent outside `serve`. */
    evalWork?: EvalWork | null;
    /**
     * An evaluation root's viewer (docs/design/35 §4): every route that would
     * change a workspace answers 409, `/mcp` has only the reading tools, and
     * there is no remote API.
     */
    evaluation?: boolean;
  } = {},
) {
  const app = new Hono<AppEnv>();
  const auth = opts.auth ?? null;
  const mcpPath = rootCtx.config.server.mcp?.path || '/mcp';
  // who may frame the embedded reader: checked first, so a bad entry stops here (src/server/embed.ts)
  const embedAllowed = embedOrigins(rootCtx.config.server);
  // before anything else: who is asking, from where, and may they
  if (auth) app.use('*', authMiddleware(auth, { mcpPath }));
  else app.use('*', publicGuard({ allowInsecureRemote: rootCtx.config.server.auth?.allowInsecureRemote }));
  const ingestRunning = new Set<string>();
  /** Who the request acts for: the signed-in account, or (sign-in off) the user the client names. */
  const requestUser = (c: Context<AppEnv>): string | undefined => (auth ? c.get('account')?.username : c.req.header('x-knode-user'));
  /** An administrator, or anyone with sign-in off: who may see what only the machine's owner should (an account's balance). */
  const mayChangeSettings = (c: Context<AppEnv>): boolean => !auth || c.get('account')?.role === 'admin';
  const servicesFor = (ctx: AppContext): WorkspaceServices | null => opts.services?.(ctx) ?? null;

  const err = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
  /** 400 for a request the caller can fix (a bad time window, an unknown kind), 500 otherwise. */
  const status = (e: unknown, fallback: 400 | 500 = 500): 400 | 500 => (e instanceof TemporalError ? 400 : fallback);
  const requestCtx = (c: { get: (key: 'workspaceContext') => AppContext }) => c.get('workspaceContext');

  // an evaluation root's builds are read, never changed: refused here, before a workspace is even opened
  if (opts.evaluation) {
    app.use('/api/*', async (c, next) => {
      if (c.req.path.startsWith('/api/auth/')) return next();
      if (viewerRefuses(c.req.method, c.req.path)) return c.json({ error: EVALUATION_READ_ONLY, reason: 'read-only' }, 409);
      return next();
    });
  }

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/workspaces' || c.req.path.startsWith('/api/auth/')) return next();
    // a link opened in a tab cannot send headers: an original, or a study's export, names its workspace in the query
    const linked = c.req.method === 'GET' && (c.req.path === '/api/file/original' || /^\/api\/research\/studies\/[^/]+\/export$/.test(c.req.path));
    const named = (header: string, query: string) => c.req.header(header) ?? (linked ? c.req.query(query) : undefined);
    try {
      const scope = resolveWorkspaceScope({
        user: requestUser(c) ?? (linked && !auth ? c.req.query('user') : undefined),
        kind: named('x-knode-workspace-kind', 'kind'),
        id: named('x-knode-workspace-id', 'id'),
        name: named('x-knode-workspace-name', 'name'),
      });
      const account = auth ? c.get('account') : undefined;
      if (account && scope.kind === 'team' && !accountMayOpenTeam(account, scope.slug)) {
        return c.json({ error: `your account has not been given the team "${scope.name}" — ask an administrator`, reason: 'forbidden' }, 403);
      }
      c.set('workspaceScope', scope);
      if (scope.kind === 'personal' && !workspaceContexts.exists(scope)) {
        return c.json({ error: `workspace "${scope.name}" does not exist` }, 404);
      }
      if (c.req.path === '/api/workspace' && c.req.method === 'DELETE') return next();
      c.set('workspaceContext', await workspaceContexts.get(scope));
      await next();
    } catch (e) {
      // an evaluation build the viewer does not open (still building, held by its run, another schema version): said, not a sign-in matter
      if (opts.evaluation && e instanceof Error && / is not opened: /.test(e.message)) return c.json({ ...err(e), reason: 'not-opened' }, 409);
      return c.json(err(e), 401);
    }
  });

  // MCP over Streamable HTTP shares the workspace registry (and therefore the
  // one open index per workspace) with the REST routes; see mcp-http.ts.
  const mcpConfig = rootCtx.config.server.mcp;
  if (!mcpConfig || mcpConfig.enabled !== false) {
    mountMcp(app, {
      path: mcpConfig?.path || '/mcp',
      token: loadOrCreateMcpToken(rootCtx.dataDir),
      registry: workspaceContexts,
      // the viewer's: reading tools only, and reading leaves no trace
      ...(opts.evaluation ? { tools: viewerToolOptions() } : {}),
      workspaceTokens: opts.mcpTokens,
      // the data root's token names its workspace in headers: with sign-in on, an
      // account's own, or a team it has been given — as the REST routes hold it
      authorize: auth
        ? (scope) => {
          const account = auth.accounts.get(scope.user);
          if (!account || account.disabled) return `"${scope.user}" is not an account on this server — name yours (knode-os connect --user <name>)`;
          if (scope.kind === 'team' && !accountMayOpenTeam(account, scope.slug)) return `the account "${account.username}" has not been given the team "${scope.name}"`;
          return null;
        }
        : undefined,
    });
  }

  // labeling and knowledge access for other machines (src/remote), token-authenticated
  if (rootCtx.config.server.remote?.enabled !== false && !opts.evaluation) {
    mountRemoteApi(app, {
      rootDataDir: rootCtx.dataDir,
      registry: workspaceContexts,
      work: (ctx) => servicesFor(ctx)?.work ?? null,
      evalArchive: opts.evalWork ? (sha) => opts.evalWork!.archives.file(sha) : undefined,
      config: rootCtx.config.server.remote,
      log,
    });
    // an evaluation run on this machine offers its model work here (docs/design/27 §8): loopback, the data root's MCP token
    if (opts.evalWork) mountEvalProducer(app, { work: opts.evalWork, token: loadOrCreateMcpToken(rootCtx.dataDir), config: () => rootCtx.config, log });
  }

  // sign-in, sessions, users and the gateways to local services (src/auth)
  if (auth) {
    mountAuthRoutes(app, auth, { teams: () => existingTeams(rootCtx.dataDir), log });
    mountGateways(app, auth);
  } else {
    // the UI asks first; with sign-in off it falls back to naming a user
    app.get('/api/auth/state', (c) => c.json({ auth: false, setupRequired: false, signedIn: false }));
  }

  /* ------------------------------- system ------------------------------- */

  app.get('/api/health', (c) => {
    // where the data lives is this machine's business
    const local = c.get('client')?.local ?? true;
    return c.json({
      ok: true,
      ...(local ? { dataRoot: rootCtx.dataDir } : {}),
      workspaceIsolation: true,
      auth: auth ? { enabled: true, setupRequired: auth.setupRequired() } : { enabled: false },
    });
  });

  app.get('/api/workspaces', (c) => {
    try {
      const user = requestUser(c);
      if (!user) return c.json({ error: 'username is required' }, 401);
      return c.json(workspaceContexts.listUserWorkspaces(user));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/workspaces', async (c) => {
    try {
      const user = requestUser(c);
      if (!user) return c.json({ error: 'username is required' }, 401);
      const { name } = await c.req.json<{ name: string }>();
      return c.json(workspaceContexts.createUserWorkspace(user, name), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/workspace', async (c) => {
    const scope = c.get('workspaceScope');
    const dataDir = workspaceDataDir(rootCtx.dataDir, scope);
    if (ingestRunning.has(dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    try {
      await workspaceContexts.reset(scope);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /**
   * After a settings save in `ctx`: every setting but what a workspace
   * contains is the server's (src/global-settings.ts), so the root and every
   * other workspace take the change now, open ones reloaded. An open one moved
   * onto another embedding model gets its vectors the way a save of its own
   * would: the backlog refills (deferred), or every document is re-applied
   * (inline) in the background.
   */
  const shareIfChanged = async (ctx: AppContext, before: string) => {
    if (sharedSnapshot(ctx.dataDir, ctx.config) === before) return null;
    const root = { dataDir: workspaceContexts.rootDataDir, config: workspaceContexts.template() ?? rootCtx.config };
    const open = await workspaceContexts.openContexts();
    const change = shareSettingsEverywhere({ root, from: ctx, open, log: (m) => log(`settings: ${m}`) });
    const here = path.relative(root.dataDir, ctx.dataDir) || '.';
    log(`settings: the settings saved in ${here} apply to every workspace now (${change.written.length} written, ${change.reloaded.length} open reloaded)`);
    for (const f of change.failed) log(`settings: ${path.relative(root.dataDir, f.dataDir)} could not take them: ${f.error}`);
    for (const dataDir of change.reloaded) {
      const other = open.find((o) => o.dataDir === dataDir);
      if (other) servicesFor(other)?.translations?.wake();
    }
    for (const dataDir of change.reembedded) {
      const other = open.find((o) => o.dataDir === dataDir);
      if (other) await followEmbeddingModel(other);
    }
    return { written: change.written.length, reloaded: change.reloaded.length, failed: change.failed.length, reembedded: change.reembedded.length };
  };

  /** A workspace whose embedder was just replaced from elsewhere: a new width, then its vectors for the new model. */
  const followEmbeddingModel = async (other: AppContext) => {
    const label = path.relative(workspaceContexts.rootDataDir, other.dataDir) || '.';
    try {
      await other.store.setEmbeddingDimension(other.config.embedding.dimensions);
      if (embeddingDeferred(other.config) || ingestRunning.has(other.dataDir)) {
        other.embeddings?.kick();
        return;
      }
      ingestRunning.add(other.dataDir);
      void activityOf(other.dataDir).run('sync', 'Re-embed every document for the new model', () => sync(other, { onProgress: log }), describeSync)
        .catch((e) => log(`settings: ${label} could not re-embed: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          ingestRunning.delete(other.dataDir);
          other.embeddings?.kick();
        });
    } catch (e) {
      log(`settings: ${label} could not move to the new embedding model: ${e instanceof Error ? e.message : e}`);
    }
  };

  app.get('/api/config', (c) => {
    const ctx = requestCtx(c);
    // The settings screen always starts here and asks for models a moment
    // later, so warm them now rather than making the first dropdown wait.
    // Never awaited: a slow endpoint must not hold up reading the config.
    warmModelCache(ctx.config);
    return c.json(redactConfig(ctx.config));
  });

  // What `provider` and `database.kind` may name here: the built-ins and what
  // the loaded plugins registered, with the fields each one reads, so a
  // settings screen can draw a form for a provider it has never heard of.
  app.get('/api/config/providers', (c) => {
    const registry = pluginRegistry();
    const owner = new Map<string, string>();
    for (const plugin of registry.describe()) {
      for (const id of plugin.llmProviders) owner.set(`llm:${id}`, plugin.name);
      for (const id of plugin.embeddingProviders) owner.set(`embedding:${id}`, plugin.name);
      for (const id of plugin.storageBackends) owner.set(`storage:${id}`, plugin.name);
      for (const id of plugin.converters) owner.set(`converter:${id}`, plugin.name);
    }
    const by = (kind: string, id: string) => owner.get(`${kind}:${id}`) ?? 'builtin';
    return c.json({
      llm: registry.llmProviders().map((p) => ({ id: p.id, label: p.label, kind: p.kind, fields: p.fields ?? null, note: p.note ?? null, listsModels: typeof p.listModels === 'function', plugin: by('llm', p.id) })),
      embedding: registry.embeddingProviders().map((p) => ({ id: p.id, label: p.label, kind: p.kind, fields: p.fields ?? null, note: p.note ?? null, listsModels: typeof p.listModels === 'function', plugin: by('embedding', p.id) })),
      storage: registry.storageBackends().map((b) => ({ id: b.id, label: b.label, note: b.note ?? null, plugin: by('storage', b.id) })),
      converters: registry.converterList().map((v) => ({ id: v.id, label: v.label ?? v.id, extensions: v.extensions, version: v.version ?? 1, usesVision: v.usesVision === true, plugin: by('converter', v.id) })),
      hooks: HOOK_NAMES.map((hook) => ({ hook, handlers: registry.describe().filter((p) => p.hooks.includes(hook)).map((p) => p.name) })),
    });
  });

  // The plugins this process loaded and what each one registered (docs/design/11).
  app.get('/api/plugins', (c) => {
    const ctx = requestCtx(c);
    const registry = pluginRegistry();
    return c.json({
      configured: configuredPluginSpecs(ctx.config.plugins).map((spec) => ({ module: spec.module, options: Object.keys(spec.options ?? {}) })),
      plugins: registry.describe(),
      warnings: registry.warnings,
    });
  });

  app.get('/api/config/embedding-usage', async (c) => {
    try { return c.json({ entries: await new EmbeddingQuotaLedger().status(requestCtx(c).config.embeddingProviders) }); }
    catch (e) { return c.json(err(e), 500); }
  });

  // A short, quota-accounted connectivity check without running the LLM stages.
  app.post('/api/config/embedding-test', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json() as { config?: ModelConfigDraft; id?: string };
      const merged = { ...ctx.config, ...mergeEmbeddingSection(ctx.config, body.config ?? {}) };
      if (body.id) {
        const entry = merged.embeddingProviders.find((e) => e.id === body.id);
        if (!entry) throw new Error('Embedding key not found.');
        merged.embeddingProviders = [{ ...entry, enabled: true }];
        merged.embeddingPool = { enabled: true, model: entry.model, dimensions: entry.dimensions, batchSize: 1 };
      }
      const started = Date.now();
      const provider = createConfiguredEmbeddingProvider(merged);
      const [vector] = await provider.embed(['知识库使用向量检索，将相近语义的文本匹配起来。']);
      return c.json({ ok: true, model: provider.model, dimensions: vector.length, ms: Date.now() - started });
    } catch (e) { return c.json({ ok: false, ...err(e) }, 400); }
  });

  // Check an embeddings endpoint of this machine before Settings saves it (docs/design/12 §4.3): it embeds the
  // probe set and every vector must come within server.remote.embedProbeCosine of the pool's own. Nothing is saved.
  app.post('/api/config/embedding-endpoint/check', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json() as { baseUrl?: unknown; model?: unknown; apiKey?: unknown };
      const endpoint = embedEndpointOf(body, ctx.config.ingest.embedEndpoint);
      return c.json(await checkEmbedEndpoint(ctx, endpoint));
    } catch (e) { return c.json({ ok: false, ...err(e) }, 400); }
  });

  // Test a draft model configuration without persisting it. An apiKey of '***'
  // means "keep the current secret" (GET /api/config redacts literal keys).
  app.post('/api/config/test', async (c) => {
    const ctx = requestCtx(c);
    const draft = (await c.req.json().catch(() => ({}))) as ModelConfigDraft;
    const out: { embedding: unknown; llm: unknown; entityLlm: unknown; documentLlm: unknown; summaryLlm: unknown; judgeLlm: unknown; translateLlm: unknown } = {
      embedding: null, llm: null, entityLlm: null, documentLlm: null, summaryLlm: null, judgeLlm: null, translateLlm: null,
    };

    try {
      const merged = { ...ctx.config, ...mergeEmbeddingSection(ctx.config, draft) };
      const e = merged.embedding;
      const provider = createConfiguredEmbeddingProvider(merged);
      const t0 = Date.now();
      const [vec] = await provider.embed(['knode-os configuration connectivity test']);
      out.embedding = { ok: true, provider: e.provider, model: provider.model, dimensions: vec.length, ms: Date.now() - t0 };
    } catch (e) {
      out.embedding = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const baseLlm = mergeLlmConfig(ctx.config.llm, draft.llm);
    // a route may name an agent, which the pipeline calls one-shot
    const connections = draftRouteTargets(ctx.config, draft);
    const entityRoute = mergeRoutedLlmConfig(ctx.config.extraction.entityLlm, draft.extraction?.entityLlm);
    const documentRoute = mergeRoutedLlmConfig(ctx.config.extraction.documentLlm, draft.extraction?.documentLlm);
    const summaryRoute = mergeRoutedLlmConfig(ctx.config.extraction.summaryLlm, draft.extraction?.summaryLlm);
    const judgeRoute = mergeRoutedLlmConfig(ctx.config.extraction.judgeLlm, draft.extraction?.judgeLlm);
    const translateRoute = mergeRoutedLlmConfig(ctx.config.extraction.translateLlm, draft.extraction?.translateLlm);
    try {
      out.llm = await testLlmConfig(baseLlm);
    } catch (e) {
      out.llm = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const routedTests: Array<[keyof Pick<typeof out, 'entityLlm' | 'documentLlm' | 'summaryLlm' | 'judgeLlm' | 'translateLlm'>, RoutedLlmConfig, string]> = [
      ['entityLlm', entityRoute, ctx.config.extraction.tier1Model],
      ['documentLlm', documentRoute, ''],
      ['summaryLlm', summaryRoute, ''],
      ['judgeLlm', judgeRoute, ''],
      ['translateLlm', translateRoute, ''],
    ];
    for (const [key, route, legacyModel] of routedTests) {
      const fullyInherited =
        !route.use && route.provider === 'inherit' && !route.baseUrl && !route.apiKey && !route.model && !route.cliPath;
      if (fullyInherited && !legacyModel) {
        out[key] = { ...(out.llm as Record<string, unknown>), inherited: true };
        continue;
      }
      try {
        out[key] = await testLlmConfig(resolveRoutedLlmConfig(baseLlm, route, connections, legacyModel));
      } catch (e) {
        out[key] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return c.json(out);
  });

  // Which models a draft route can actually be pointed at. Same '***' apiKey
  // convention as /api/config/test; a route that inherits is resolved against
  // the draft default provider first, so the list matches what would run.
  app.post('/api/config/models', async (c) => {
    const ctx = requestCtx(c);
    const body = (await c.req.json().catch(() => ({}))) as { route?: string; config?: ModelConfigDraft; refresh?: boolean };
    const draft = body.config ?? {};
    const route = body.route ?? 'llm';
    const opts = { refresh: body.refresh === true };

    if (route === 'embedding') {
      const merged = mergeEmbeddingSection(ctx.config, draft);
      if (merged.embeddingPool?.enabled) {
        const ids = new Set(merged.embeddingProviders.filter((e) => e.enabled !== false && e.provider === 'openai')
          .flatMap((e) => [e.model, ...(e.catalog ?? [])]).filter(Boolean).map(canonicalEmbeddingModel));
        return c.json({ ok: true, source: 'builtin', models: [...ids].sort().map((id) => ({ id })), note: 'Models from configured keys. Refresh a key to update its catalog.' });
      }
      return c.json(await listModelsCached('embedding', merged.embedding, opts));
    }

    // A named embedding provider lists on its own, before Index points at it.
    if (route.startsWith('embedding:')) {
      const id = route.slice('embedding:'.length);
      const entry = mergeEmbeddingSection(ctx.config, draft).embeddingProviders.find((e) => e.id === id);
      if (!entry) return c.json({ error: `unknown embedding provider: ${route}` }, 400);
      return c.json(await listModelsCached('embedding', entry, opts));
    }

    // the models the draft lists, and the agents a route may name as well
    const connections = draftRouteTargets(ctx.config, draft);
    // the default is an ordinary row, so 'llm' means whichever one `llmUse`
    // names in the draft — with an explicit `llm` block still winning, for a
    // client that edits the mirror
    const llmUse = typeof draft.llmUse === 'string' && draft.llmUse.trim() ? draft.llmUse.trim() : ctx.config.llmUse;
    const active = connections.find((c) => c.id === llmUse) ?? ctx.config.llm;
    const baseLlm = mergeLlmConfig(active, draft.llm);
    if (route === 'llm') return c.json(await listModelsCached('chat', baseLlm, opts));

    // A named connection can be listed on its own, before any route uses it.
    if (route.startsWith('connection:')) {
      const connection = connections.find((c) => c.id === route.slice('connection:'.length));
      if (!connection) return c.json({ error: `unknown connection: ${route}` }, 400);
      return c.json(await listModelsCached('chat', connection, opts));
    }

    if (route !== 'entityLlm' && route !== 'documentLlm' && route !== 'summaryLlm' && route !== 'judgeLlm' && route !== 'translateLlm') {
      return c.json({ error: `unknown route: ${route}` }, 400);
    }
    const merged = mergeRoutedLlmConfig(ctx.config.extraction[route], draft.extraction?.[route]);
    return c.json(await listModelsCached('chat', resolveRoutedLlmConfig(baseLlm, merged, connections), opts));
  });

  // Where each coding-agent CLI resolved to on the service PATH — Settings uses
  // this to keep the executable field out of the way when it is redundant.
  app.get('/api/config/cli-tools', (c) => c.json({ tools: cachedCliToolStatus({ refresh: c.req.query('refresh') === '1' }) }));

  // the languages knode-os knows, and the workspace's content languages: what a client's pickers and switcher show (docs/design/17)
  app.get('/api/languages', (c) => {
    const ctx = requestCtx(c);
    const current = contentLanguages(ctx.config);
    return c.json({ languages: LANGUAGES, enabled: current.on, primary: current.primary, secondary: current.secondary, offered: current.offered, maxChars: current.maxChars });
  });

  // Which executors can actually run here, and which one to preselect when
  // `research.agent` is still empty. Both clients read this instead of each
  // working out its own preference order.
  app.get('/api/config/agents', async (c) => {
    const ctx = requestCtx(c);
    const agents = await availableAgents(ctx.config);
    return c.json({ agents, suggested: suggestResearchAgent(ctx.config, agents) });
  });

  // Persist + hot-apply embedding/llm config. Re-embeds the corpus when the
  // embedding provider/model/dimensions changed.
  app.put('/api/config', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    try {
      const incoming = (await c.req.json()) as ModelConfigDraft;
      const next: KnodeConfig = JSON.parse(JSON.stringify(ctx.config));
      // every setting but what a workspace contains is the server's (src/global-settings.ts): what this save changes goes everywhere
      const sharedBefore = sharedSnapshot(ctx.dataDir, ctx.config);

      // Unconditional: this is also what repairs a dangling embeddingUse, and
      // it flattens the mirror before the re-embed diff below reads it.
      Object.assign(next, mergeEmbeddingSection(next, incoming));
      if (incoming.connections) {
        next.connections = mergeConnections(next.connections, incoming.connections);
      }
      if (typeof incoming.llmUse === 'string' && incoming.llmUse.trim()) {
        next.llmUse = incoming.llmUse.trim();
      }
      if (incoming.llm) {
        // `llm` is the flattened mirror, so a client that edits it — an older
        // one, or `knode-os config set` — is editing the default's row
        const index = next.connections.findIndex((c) => c.id === next.llmUse);
        if (index >= 0) next.connections[index] = { ...next.connections[index], ...mergeLlmConfig(next.connections[index], incoming.llm) };
        else next.llm = mergeLlmConfig(next.llm, incoming.llm);
      }
      // routes before the migrations below, which may rename what they name
      if (incoming.extraction) {
        const x = incoming.extraction;
        if (x.entityLlm) {
          next.extraction.entityLlm = mergeRoutedLlmConfig(next.extraction.entityLlm, x.entityLlm);
          next.extraction.tier1Model = '';
        }
        if (x.documentLlm) {
          next.extraction.documentLlm = mergeRoutedLlmConfig(next.extraction.documentLlm, x.documentLlm);
        }
        if (x.summaryLlm) {
          next.extraction.summaryLlm = mergeRoutedLlmConfig(next.extraction.summaryLlm, x.summaryLlm);
        }
        if (x.judgeLlm) {
          next.extraction.judgeLlm = mergeRoutedLlmConfig(next.extraction.judgeLlm, x.judgeLlm);
        }
        if (x.translateLlm) {
          next.extraction.translateLlm = mergeRoutedLlmConfig(next.extraction.translateLlm, x.translateLlm);
        }
        if (typeof x.claims === 'boolean') next.extraction.claims = x.claims;
        const batchSize = Number(x.batchSize);
        const concurrency = Number(x.concurrency);
        if (Number.isFinite(batchSize) && batchSize >= 1) next.extraction.batchSize = Math.floor(batchSize);
        if (Number.isFinite(concurrency) && concurrency >= 1) next.extraction.concurrency = Math.floor(concurrency);
        // 0 leaves summaries to remote workers (src/labeling/local.ts)
        const summaryConcurrency = Number(x.summaryConcurrency);
        if (x.summaryConcurrency !== undefined && Number.isFinite(summaryConcurrency) && summaryConcurrency >= 0) {
          next.extraction.summaryConcurrency = Math.min(16, Math.floor(summaryConcurrency));
        }
        // and translations (docs/design/17)
        const translateConcurrency = Number(x.translateConcurrency);
        if (x.translateConcurrency !== undefined && Number.isFinite(translateConcurrency) && translateConcurrency >= 0) {
          next.extraction.translateConcurrency = Math.min(16, Math.floor(translateConcurrency));
        }
        // the Summarize stage's size threshold (0: every document) and how many segments one summary reads at most (docs/design/14)
        const summaryMinChars = Number(x.summaryMinChars);
        if (x.summaryMinChars !== undefined && Number.isFinite(summaryMinChars) && summaryMinChars >= 0) next.extraction.summaryMinChars = Math.floor(summaryMinChars);
        const summaryMaxSegments = Number(x.summaryMaxSegments);
        if (x.summaryMaxSegments !== undefined && Number.isFinite(summaryMaxSegments) && summaryMaxSegments >= 1) next.extraction.summaryMaxSegments = Math.min(64, Math.floor(summaryMaxSegments));
        if (typeof x.summaryAfterExtraction === 'boolean') next.extraction.summaryAfterExtraction = x.summaryAfterExtraction;
        if (Array.isArray(x.workers)) {
          // `serve`'s labeling slots per agent (src/labeling/local.ts); a target must exist
          const targets = new Set(routeTargets(next).map((t) => t.id));
          const workers = [];
          for (const w of x.workers as Partial<ExtractionWorkerConfig>[]) {
            const use = typeof w?.use === 'string' ? w.use.trim() : '';
            const slots = Number(w?.slots);
            if (!use || !Number.isFinite(slots) || slots < 0) return c.json({ error: 'each extraction worker needs a target ("use") and a slot count' }, 400);
            if (!targets.has(use)) return c.json({ error: `extraction worker "${use}" is no connection or agent` }, 400);
            const cliTimeoutMs = Number(w.cliTimeoutMs);
            workers.push({
              use,
              slots: Math.min(16, Math.floor(slots)),
              ...(typeof w.model === 'string' && w.model.trim() ? { model: w.model.trim() } : {}),
              ...(w.effort && LLM_EFFORTS.includes(w.effort) ? { effort: w.effort } : {}),
              ...(w.speed && LLM_SPEEDS.includes(w.speed) ? { speed: w.speed } : {}),
              ...(Number.isFinite(cliTimeoutMs) && cliTimeoutMs >= 1000 ? { cliTimeoutMs: Math.floor(cliTimeoutMs) } : {}),
            });
          }
          next.extraction.workers = workers;
        }
      }
      // a client written before named connections sends a route's endpoint
      // inline; it becomes a row, the way `loadConfig` lifts it
      Object.assign(next, migrateRouteConnections(next));
      // repairs a dangling `llmUse` — including a client that sent a list
      // without the default's row — and flattens the mirror before the
      // reconvert diff below reads it
      Object.assign(next, migrateDefaultLlm(next));
      // a client written before CLIs became agents still sends them as rows
      Object.assign(next, migrateCliConnections(next, ctx.dataDir));
      // every stage names what it runs on: one that names nothing, or a row
      // this save deleted, is written down as the default it would run on
      pinRoutes(next);
      if (incoming.ingest) {
        const setInt = (key: 'concurrency' | 'convertConcurrency', min: number, max: number) => {
          const value = Number(incoming.ingest![key]);
          if (incoming.ingest![key] !== undefined && Number.isFinite(value)) {
            next.ingest[key] = Math.min(max, Math.max(min, Math.floor(value)));
          }
        };
        setInt('concurrency', 1, 32);
        setInt('convertConcurrency', 1, 16);
        // when vectors are made: by the sync (inline) or as leased work (deferred, docs/design/12 §3.3)
        const mode = incoming.ingest.embedding;
        if (mode !== undefined) {
          if (mode !== 'inline' && mode !== 'deferred') return c.json({ error: `ingest.embedding is "inline" or "deferred", not ${JSON.stringify(mode)}` }, 400);
          next.ingest.embedding = mode;
        }
        const slots = Number(incoming.ingest.embedSlots);
        if (incoming.ingest.embedSlots !== undefined && Number.isFinite(slots)) next.ingest.embedSlots = Math.min(32, Math.max(0, Math.floor(slots)));
        // an embeddings endpoint of this machine's own for the embed slots: null removes it
        if (incoming.ingest.embedEndpoint === null) delete next.ingest.embedEndpoint;
        else if (incoming.ingest.embedEndpoint !== undefined) next.ingest.embedEndpoint = embedEndpointOf(incoming.ingest.embedEndpoint, ctx.config.ingest.embedEndpoint);
      }
      if (incoming.research) {
        const r = incoming.research;
        const cur = next.research;
        if (typeof r.agent === 'string') {
          const spec = r.agent.trim();
          // '' is legal (not configured); anything else has to resolve, or the
          // queue would stall with nothing but a log line to show for it
          if (spec && !agentForSpec(next, spec, '', ctx.dataDir)) return c.json({ error: `unknown research agent "${spec}"` }, 400);
          cur.agent = spec;
        }
        if (typeof r.model === 'string') cur.model = r.model.trim();
        if (typeof r.profile === 'string' && isValidProfileName(r.profile.trim())) cur.profile = r.profile.trim();
        if (typeof r.pipeline === 'string' && (PIPELINE_MODES as readonly string[]).includes(r.pipeline)) cur.pipeline = r.pipeline as ResearchConfig['pipeline'];
        const setInt = (key: 'maxTurns' | 'timeoutMs' | 'concurrency' | 'researchers' | 'reviewRounds' | 'keepRuns', min: number, max: number) => {
          const value = Number(r[key]);
          if (r[key] !== undefined && Number.isFinite(value)) cur[key] = Math.min(max, Math.max(min, Math.floor(value)));
        };
        setInt('maxTurns', 1, 500);
        setInt('timeoutMs', 60_000, 24 * 3_600_000);
        setInt('concurrency', 1, 8);
        setInt('researchers', 1, 16);
        setInt('reviewRounds', 0, 6);
        setInt('keepRuns', 1, 500);
        if (r.auto) {
          if (typeof r.auto.enabled === 'boolean') cur.auto.enabled = r.auto.enabled;
          const daily = Number(r.auto.dailyJobs);
          if (r.auto.dailyJobs !== undefined && Number.isFinite(daily)) cur.auto.dailyJobs = Math.min(50, Math.max(1, Math.floor(daily)));
        }
        if (r.init) {
          cur.init = { ...cur.init };
          const followUps = Number(r.init.followUps);
          if (r.init.followUps !== undefined && Number.isFinite(followUps)) cur.init.followUps = Math.min(20, Math.max(0, Math.floor(followUps)));
          const maxMs = Number(r.init.extractionMaxMs);
          if (r.init.extractionMaxMs !== undefined && Number.isFinite(maxMs)) cur.init.extractionMaxMs = Math.min(3_600_000, Math.max(60_000, Math.floor(maxMs)));
        }
        if (r.study) {
          cur.study = { ...cur.study };
          const clamp = (key: 'collectors' | 'maxPages' | 'maxCaptures', min: number, max: number) => {
            const value = Number(r.study![key]);
            if (r.study![key] !== undefined && Number.isFinite(value)) cur.study[key] = Math.min(max, Math.max(min, Math.floor(value)));
          };
          clamp('collectors', 1, 8);
          clamp('maxPages', 1, 12);
          clamp('maxCaptures', 1, 500);
          if (typeof r.study.refiner === 'string') {
            const spec = r.study.refiner.trim();
            if (spec && !agentForSpec(next, spec, '', ctx.dataDir) && !llmTargets(next).some((t) => t.id === spec)) return c.json({ error: `unknown refiner "${spec}"` }, 400);
            cur.study.refiner = spec;
          }
        }
        if (r.web) {
          cur.web = { ...cur.web, search: { ...cur.web.search } };
          if (r.web.search) {
            const sr = r.web.search;
            if (typeof sr.provider === 'string' && (sr.provider === '' || (WEB_SEARCH_PROVIDERS as string[]).includes(sr.provider))) cur.web.search.provider = sr.provider;
            if (typeof sr.baseUrl === 'string') cur.web.search.baseUrl = sr.baseUrl.trim();
            // '***' is the redacted key GET /api/config hands out: keep the stored one
            if (typeof sr.apiKey === 'string' && sr.apiKey !== '***') cur.web.search.apiKey = sr.apiKey.trim();
            const max = Number(sr.maxResults);
            if (sr.maxResults !== undefined && Number.isFinite(max)) cur.web.search.maxResults = Math.min(20, Math.max(1, Math.floor(max)));
          }
          if (typeof r.web.allowPrivateHosts === 'boolean') cur.web.allowPrivateHosts = r.web.allowPrivateHosts;
          if (typeof r.web.userAgent === 'string' && r.web.userAgent.trim()) cur.web.userAgent = r.web.userAgent.trim().slice(0, 300);
          if (typeof r.web.proxy === 'string' && !r.web.proxy.includes('***')) cur.web.proxy = r.web.proxy.trim();
          const bytes = Number(r.web.maxBytes);
          if (r.web.maxBytes !== undefined && Number.isFinite(bytes)) cur.web.maxBytes = Math.min(200 * 1024 * 1024, Math.max(256 * 1024, Math.floor(bytes)));
          const timeout = Number(r.web.timeoutMs);
          if (r.web.timeoutMs !== undefined && Number.isFinite(timeout)) cur.web.timeoutMs = Math.min(600_000, Math.max(5_000, Math.floor(timeout)));
        }
      }
      if (incoming.chat) {
        const ch = incoming.chat;
        const cur = next.chat;
        if (typeof ch.agent === 'string') {
          const spec = ch.agent.trim();
          if (spec && !agentForSpec(next, spec, '', ctx.dataDir)) return c.json({ error: `unknown chat agent "${spec}"` }, 400);
          cur.agent = spec;
        }
        if (typeof ch.model === 'string') cur.model = ch.model.trim();
        // effort, tools, turn cap, timeout and the extra prompt belong to the
        // agent now — see `playbooks/agents/` and `resolveChatRuntime`
        const setInt = (key: 'historyTurns' | 'keep', min: number, max: number) => {
          const value = Number(ch[key]);
          if (ch[key] !== undefined && Number.isFinite(value)) cur[key] = Math.min(max, Math.max(min, Math.floor(value)));
        };
        setInt('historyTurns', 0, 50);
        setInt('keep', 1, 500);
      }
      if (incoming.review) {
        // the three modes the Judge stage's form sets and the web switch on the
        // Research tab; thresholds stay in the file
        const { llmJudge, claims, claimMerge, external } = incoming.review;
        if (llmJudge === 'off' || llmJudge === 'suggest' || llmJudge === 'auto') next.review.llmJudge = llmJudge;
        if (claims === 'off' || claims === 'suggest') next.review.claims = claims;
        if (claimMerge === 'off' || claimMerge === 'suggest' || claimMerge === 'auto') next.review.claimMerge = claimMerge;
        if (external === 'off' || external === 'verify' || external === 'research') next.review.external = external;
      }
      if (incoming.processing) {
        // this machine's processing (src/labeling/local.ts), for every workspace on the server: the slots
        // read the cap and the floor within a minute; an old client's `autoStart` is ignored
        const p = incoming.processing;
        const current = processingSettings(next);
        const count = (v: unknown, max: number, fallback: number) => {
          if (v === undefined) return fallback;
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : NaN;
        };
        const maxLocalCalls = count(p.maxLocalCalls, 64, current.maxLocalCalls);
        const minQuotaPercent = count(p.minQuotaPercent, 100, current.minQuotaPercent);
        if (Number.isNaN(maxLocalCalls)) return c.json({ error: 'processing.maxLocalCalls must be a whole number from 0 (no cap) up' }, 400);
        if (Number.isNaN(minQuotaPercent)) return c.json({ error: 'processing.minQuotaPercent must be a percentage from 0 (off) to 100' }, 400);
        next.processing = { maxLocalCalls, minQuotaPercent };
      }
      if (incoming.languages) {
        // content languages (docs/design/17): a language knode-os does not know is refused, not dropped in silence
        const l = incoming.languages;
        for (const tag of [l.primary, ...(Array.isArray(l.secondary) ? l.secondary : [])]) {
          if (typeof tag === 'string' && tag.trim() && !normalizeLanguage(tag)) return c.json({ error: `unknown language "${tag}"` }, 400);
        }
        const merged = normalizeLanguagesConfig({ ...next.languages, ...l });
        if (merged.enabled && !merged.primary) return c.json({ error: 'content languages need a primary language' }, 400);
        next.languages = merged;
      }
      if (incoming.retrieval?.sag) {
        const sag = incoming.retrieval.sag;
        const setInt = (key: keyof Omit<SagSearchConfig, 'directRatio'>, min: number, max: number) => {
          const value = Number(sag[key]);
          if (Number.isFinite(value)) next.retrieval.sag[key] = Math.min(max, Math.max(min, Math.floor(value)));
        };
        setInt('seedChunks', 1, 100);
        setInt('entityFrontier', 1, 200);
        setInt('maxEventsPerEntity', 1, 100);
        setInt('candidatePool', 1, 500);
        setInt('maxHops', 1, 4);
        const directRatio = Number(sag.directRatio);
        if (Number.isFinite(directRatio)) next.retrieval.sag.directRatio = Math.min(1, Math.max(0, directRatio));
      }

      const reembed = embeddingIdentity(next.embedding) !== embeddingIdentity(ctx.config.embedding);
      const modeChanged = embeddingDeferred(next) !== embeddingDeferred(ctx.config);
      const dimChanged = next.embedding.dimensions !== ctx.config.embedding.dimensions;
      const previousDocumentLlm = resolveRoutedLlmConfig(ctx.config.llm, ctx.config.extraction.documentLlm, routeTargets(ctx.config));
      const nextDocumentLlm = resolveRoutedLlmConfig(next.llm, next.extraction.documentLlm, routeTargets(next));
      const reconvert =
        previousDocumentLlm.provider !== nextDocumentLlm.provider ||
        previousDocumentLlm.model !== nextDocumentLlm.model ||
        previousDocumentLlm.baseUrl !== nextDocumentLlm.baseUrl ||
        previousDocumentLlm.cliPath !== nextDocumentLlm.cliPath;

      validateEmbeddingPool(next);
      const nextEmbedder = createConfiguredEmbeddingProvider(next);
      // a new or changed endpoint of this machine's own is saved only once it passes calibration
      const endpoint = next.ingest.embedEndpoint;
      const before = ctx.config.ingest.embedEndpoint;
      if (endpoint && (endpoint.baseUrl !== before?.baseUrl || endpoint.model !== before?.model || endpoint.apiKey !== before?.apiKey
          || embeddingIdentity(next.embedding) !== embeddingIdentity(ctx.config.embedding))) {
        const check = await checkEmbedEndpoint({ dataDir: ctx.dataDir, config: next, embedder: nextEmbedder }, endpoint);
        if (!check.ok) return c.json({ error: `the embedding endpoint did not pass calibration: ${check.reason}`, check }, 400);
      }
      saveConfig(ctx.dataDir, next);
      ctx.config = next;
      ctx.llm = judgeLlmClient(next);
      ctx.embedder = nextEmbedder;
      // a new primary language, or the languages turned on: the Translate stage looks again
      servicesFor(ctx)?.translations?.wake();
      const shared = await shareIfChanged(ctx, sharedBefore);

      let reindex: Awaited<ReturnType<typeof sync>> | null = null;
      // deferred: a new model needs no re-apply — the embed backlog refills for it and drains
      const resync = reconvert || (reembed && !embeddingDeferred(next));
      if (reembed && dimChanged && !resync) await ctx.store.setEmbeddingDimension(next.embedding.dimensions);
      if (resync) {
        ingestRunning.add(ctx.dataDir);
        try {
          // a new embedding model re-applies every document scope (chunks are
          // reused, only missing vectors are computed); a new dimension
          // rebuilds the embeddings table first
          if (reembed && dimChanged) await ctx.store.setEmbeddingDimension(next.embedding.dimensions);
          reindex = await activityOf(ctx.dataDir).run('sync', reembed ? 'Re-embed every document for the new model' : 'Re-convert images and scans for the new route', () => sync(ctx, { onProgress: log }), describeSync);
        } finally {
          ingestRunning.delete(ctx.dataDir);
        }
      }
      // the backlog for a new model, or the other embedder for a new mode, starts now
      if (reembed || modeChanged) ctx.embeddings?.kick();
      return c.json({ ok: true, config: redactConfig(next), reembedded: reembed, reconverted: reconvert, reindex, ...(shared ? { shared } : {}) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/stats', async (c) => {
    const ctx = requestCtx(c);
    const row = await knowledgeStats(ctx.store);
    const lastDream = await ctx.store.getMeta('last_dream');
    return c.json({ ...row, lastDream: lastDream ?? null, embeddingModel: ctx.embedder.model, llmModel: ctx.llm.enabled ? ctx.llm.label : null });
  });

  // the whole base in numbers: documents by folder, entities by type, predicates, claims, wiki pages, the guide
  app.get('/api/survey', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await surveyKnowledgeBase(ctx));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // what a person should know about the workspace, as data each client words itself (src/server/notices.ts)
  app.get('/api/notices', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json({ notices: await listNotices(ctx) });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* ------------------------------- files -------------------------------- */

  app.get('/api/tree', (c) => {
    const ctx = requestCtx(c);
    try {
      // `depth=1` lists a folder's own entries, the way the clients open folders;
      // without it the whole subtree comes back. `dirs=1` leaves the files out.
      const depthArg = c.req.query('depth');
      const depth = depthArg === undefined ? undefined : Number(depthArg);
      if (depth !== undefined && !(Number.isInteger(depth) && depth >= 1)) return c.json({ error: 'depth must be a whole number of levels, 1 or more' }, 400);
      // the tree is for knowledge: system folders stay out of it (TREE_HIDDEN)
      const tree = listTree(ctx.dataDir, c.req.query('path') ?? '.', depth, { dirsOnly: ['1', 'true'].includes(c.req.query('dirs') ?? ''), hide: TREE_HIDDEN });
      // the mirror of a linked folder says where it comes from, so a client can
      // mark it and keep edits off it (the routes refuse them anyway); the list
      // rides along for files under a mirror whose folder was never listed. A
      // folder knode-os makes says what it is for.
      const links = mirrorLinks(ctx.config);
      const feishuDests = new Set(feishuLinks(ctx.config).map((l) => l.dest));
      const conversationDests = new Set(conversationLinks(ctx.config).map((l) => l.dest));
      // a repository's mirror, card and docs copy name the entry they belong to (src/ingest/codebase)
      const codebaseDests = new Map(codebaseLinks(ctx.config).flatMap((l) => [codebaseDir(l.name), codebaseCard(l.name), codebaseDocsDir(l.name)].map((d) => [d, l.name] as const)));
      const mark = (node: typeof tree): void => {
        const marked = node as typeof tree & { linked?: string; about?: string };
        const link = links.find((l) => l.dest === node.path);
        if (link) marked.linked = link.source;
        if (node.kind === 'dir' && FOLDER_ABOUT[node.path]) marked.about = FOLDER_ABOUT[node.path];
        for (const child of node.children ?? []) mark(child);
      };
      mark(tree);
      // `meta=1` with `depth=1`: each Markdown file says what its frontmatter
      // calls it — title, description, date… — the way the embedded reader
      // lists a folder; read from the head of each file, for a page of them
      if (depth === 1 && ['1', 'true'].includes(c.req.query('meta') ?? '')) {
        const files = (tree.children ?? []).filter((n) => n.kind === 'file' && /\.(md|markdown)$/i.test(n.name)).slice(0, TREE_META_FILES);
        for (const file of files) {
          try {
            const meta = markdownMeta(readFileTextCapped(ctx.dataDir, file.path, TREE_META_BYTES).content);
            if (meta) (file as typeof file & { meta?: MarkdownMeta }).meta = meta;
          } catch {
            // a file gone or unreadable since the listing: it lists by name
          }
        }
      }
      return c.json({
        ...tree,
        links: links.map((l) => {
          const codebase = codebaseDests.get(l.dest);
          if (codebase) return { path: l.dest, source: l.source, kind: 'codebase', name: codebase };
          return { path: l.dest, source: l.source, kind: feishuDests.has(l.dest) ? 'feishu' : conversationDests.has(l.dest) ? 'conversation' : 'folder' };
        }),
      });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/file', async (c) => {
    const ctx = requestCtx(c);
    try {
      const p = c.req.query('path');
      if (!p) return c.json({ error: 'path required' }, 400);
      // the config (literal keys) and the private state are not files to hand out, to anyone
      if (isPrivatePath(p)) return c.json({ error: `${p} is not available through the file API`, reason: 'private' }, 403);
      const maxBytes = Number(c.req.query('maxBytes'));
      const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_FILE_BYTES) : MAX_PREVIEW_BYTES;
      // a PDF / image original answers with the Markdown knode-os derived from it
      const file = readSourceTextCapped(ctx.dataDir, p, cap);
      if (!file) return c.json({ error: `no derived text for ${p} yet — run a sync first` }, 404);
      // the document in the reader's language, where the workspace has content languages on (docs/design/17)
      const languages = await documentLanguages(ctx.store, ctx.dataDir, ctx.config, p);
      const asked = normalizeLanguage(c.req.query('lang'));
      if (languages && asked && !sameLanguage(asked, languages.source)) {
        const [doc] = await ctx.store.query<Pick<DocumentRow, 'id' | 'path' | 'root' | 'sha256'>>(`SELECT id, path, root, sha256 FROM documents WHERE path = $1 AND status = 'indexed'`, [p]);
        const translated = doc ? translatedText(ctx.dataDir, doc, asked) : null;
        if (translated) {
          const capped = capText(translated.text, cap);
          return c.json({
            path: p, content: capped.content, bytes: capped.bytes, truncated: capped.truncated, derived: file.derived,
            languages: { ...languages, shown: asked }, translation: { language: asked, done: translated.done, parts: translated.parts, model: translated.model },
          });
        }
      }
      return c.json({
        path: p, content: file.content, bytes: file.bytes, truncated: file.truncated, derived: file.derived,
        ...(languages ? { languages: { ...languages, shown: languages.source } } : {}),
      });
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  // ask for a document in another of the workspace's languages: the Translate stage takes it next (docs/design/17)
  app.post('/api/file/translate', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ path?: string; lang?: string; cancel?: boolean }>().catch(() => ({} as { path?: string; lang?: string; cancel?: boolean }));
      const p = typeof body.path === 'string' ? body.path : '';
      if (!p) return c.json({ error: 'path required' }, 400);
      if (isPrivatePath(p)) return c.json({ error: `${p} is not available through the file API`, reason: 'private' }, 403);
      const languages = contentLanguages(ctx.config);
      if (!languages.on) return c.json({ error: 'content languages are off for this workspace — turn them on in Settings → Ingest → Translate' }, 409);
      const lang = normalizeLanguage(body.lang);
      if (!lang || !languages.offered.includes(lang)) return c.json({ error: `${body.lang ?? '(none)'} is not one of this workspace's languages (${languages.offered.join(', ')})` }, 400);
      const doc = await translatableDocument(ctx.store, p);
      if (!doc) return c.json({ error: `${p} is neither an indexed document under raw/docs nor a wiki page` }, 404);
      if (isDataFile(p)) return c.json({ error: `${p} is data, not prose: it is not translated` }, 400);
      const current = await documentLanguages(ctx.store, ctx.dataDir, ctx.config, p);
      if (current?.source && sameLanguage(current.source, lang)) return c.json({ error: `${p} is written in ${lang} already` }, 400);
      if (body.cancel) {
        await withdrawTranslationRequest(ctx.store, doc.id, lang);
        return c.json({ ok: true, status: current?.translations[lang]?.status ?? 'none' });
      }
      const state = current?.translations[lang];
      if (state?.status !== 'done') {
        const row = await translationRow(ctx.store, doc.id, lang);
        // a failed translation asked for again starts its attempts over
        const fresh = row?.status === 'failed' && row.content_sha === doc.sha256;
        if (fresh) await ctx.store.query(`UPDATE translations SET attempts = 0 WHERE document_id = $1 AND language = $2`, [doc.id, lang]);
        const partial = row && row.content_sha === doc.sha256 && row.status === 'partial';
        await recordTranslationState(ctx.store, doc, lang, {
          status: partial ? 'partial' : 'requested', parts: partial ? row.parts : 0, done: partial ? row.done : 0, requested: true,
        });
        servicesFor(ctx)?.translations?.wake();
      }
      const services = servicesFor(ctx);
      return c.json({
        ok: true,
        status: state?.status === 'done' ? 'done' : 'requested',
        // a request waits for this machine's slots or a remote worker; with neither it waits for processing to start
        processing: services?.processing?.state().running ?? false,
      });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // the wiki pages citing a raw/docs file (src/graph/citations.ts): the file view's "Cited by"
  app.get('/api/file/citations', async (c) => {
    const ctx = requestCtx(c);
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    if (isPrivatePath(p)) return c.json({ error: `${p} is not available through the file API`, reason: 'private' }, 403);
    try {
      return c.json({ path: p, citedBy: await citedBy(ctx.store, p) });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // the file itself, for people to read: a PDF, a picture, a saved page made safe to open (src/server/originals.ts)
  app.get('/api/file/original', (c) => {
    const ctx = requestCtx(c);
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    try {
      const { body, headers } = readOriginal(ctx.dataDir, p);
      return c.body(body, 200, headers);
    } catch (e) {
      return c.json(err(e), e instanceof OriginalError ? e.status : 404);
    }
  });

  app.get('/api/link/resolve', async (c) => {
    const ctx = requestCtx(c);
    try {
      const target = c.req.query('target');
      const from = c.req.query('from');
      if (!target || !from) return c.json({ error: 'target and from required' }, 400);
      const resolved = resolveKnowledgeLink(ctx.dataDir, from, target);
      if (resolved) return c.json(resolved);
      // a name no note answers to may be an entity the graph has: its page when it has one, else the entity's panel
      const name = linkedName(target);
      const entity = name ? (await entitiesNamed(ctx.store, [name])).get(name) : undefined;
      if (entity?.wikiPath && pathExists(ctx.dataDir, entity.wikiPath)) return c.json({ path: entity.wikiPath, fragment: null });
      if (entity) return c.json({ path: null, fragment: null, entity: { id: entity.id, name: entity.name, type: entity.type } });
      return c.json({ error: `link target not found: ${target}` }, 404);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.put('/api/file', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { path: p, content } = await c.req.json<{ path: string; content: string }>();
      if (!p || typeof content !== 'string') return c.json({ error: 'path and content required' }, 400);
      // purpose.md and schema.md are the owner's to edit here, never an agent's (OWNER_ROOT_FILES)
      if (!isOwnerRootFile(p)) assertWritablePath(p);
      assertNotConvertedOriginal(p);
      assertNotLinked(ctx.config, p, 'write to');
      writeFileText(ctx.dataDir, p, content);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/file', async (c) => {
    const ctx = requestCtx(c);
    try {
      const p = c.req.query('path');
      if (!p) return c.json({ error: 'path required' }, 400);
      if (isProtectedPath(p)) return c.json({ error: 'refusing to delete a root path' }, 400);
      assertWritablePath(p);
      assertNotLinked(ctx.config, p, 'delete');
      removePath(ctx.dataDir, p);
      // deleting a source is a dispose: everything it produced is reverted,
      // history stays queryable with as_of (use /api/forget to purge it)
      const stats = await sync(ctx, { only: [p], onProgress: log });
      return c.json({ ok: true, disposed: stats.disposed, pagesArchived: stats.pagesArchived });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/mkdir', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { path: p } = await c.req.json<{ path: string }>();
      const rel = sanitizeRelativePath(p ?? '');
      if (!rel) return c.json({ error: 'path required' }, 400);
      // a directory where the guide belongs would break every later read of it
      if (isProtectedPath(rel) || isRootWritableFile(rel)) return c.json({ error: `${rel} is a file this workspace owns, not a directory` }, 400);
      assertWritablePath(rel);
      assertNotLinked(ctx.config, rel, 'create a folder in');
      makeDir(ctx.dataDir, rel);
      return c.json({ ok: true, path: rel });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // A move is a pure filesystem operation: the doc's scope key is its path, so
  // the knowledge only follows once an ingest reconciles the old key away and
  // applies the new one. Batch callers move everything first and ingest once,
  // the way uploads do — syncing per file would re-cook raw/docs each time.
  app.post('/api/mv', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { from, to } = await c.req.json<{ from: string; to: string }>();
      if (!from || !to) return c.json({ error: 'from and to required' }, 400);
      const src = sanitizeRelativePath(from);
      const dst = sanitizeRelativePath(to);
      if (!src || !dst) return c.json({ error: 'from and to required' }, 400);
      assertWritablePath(src);
      assertWritablePath(dst);
      // wiki/ and raw/docs/ are writable, which alone would let a rename walk
      // the whole tree away from under the workspace
      if (isProtectedPath(src) || isProtectedPath(dst)) {
        return c.json({ error: 'refusing to move a root path' }, 400);
      }
      // a linked folder's mirror (or anything holding one) stays where the link put it
      assertNotLinked(ctx.config, src, 'move');
      assertNotLinked(ctx.config, dst, 'move into');
      if (src === dst) return c.json({ ok: true, from: src, to: dst });
      // renameSync replaces the destination without a word, which in a batch
      // move would silently destroy a same-named file already sitting there
      if (pathExists(ctx.dataDir, dst)) return c.json({ error: `already exists: ${dst}` }, 409);
      if (!pathExists(ctx.dataDir, src)) return c.json({ error: `no such path: ${src}` }, 404);
      movePath(ctx.dataDir, src, dst);
      // the sidecar follows, so a moved PDF is not converted again and keeps its tier-1 result
      moveSidecar(ctx.dataDir, src, dst);
      return c.json({ ok: true, from: src, to: dst });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/upload', async (c) => {
    const ctx = requestCtx(c);
    try {
      const form = await c.req.formData();
      // sanitize before the prefix check: "raw/docs/../../x" would pass it
      const dir = sanitizeRelativePath((form.get('dir') as string) || '') || 'raw/docs';
      if (!/^(raw\/docs|wiki)(\/|$)/.test(dir)) return c.json({ error: 'uploads go to raw/docs or wiki' }, 400);
      if (hasSidecarSegment(dir)) return c.json({ error: `${SIDECAR_ROOT}/ is system-owned` }, 400);
      assertNotLinked(ctx.config, dir, 'upload into');
      const saved: string[] = [];
      const skipped: string[] = [];
      for (const [, v] of form.entries()) {
        if (!(v instanceof File)) continue;
        // folder uploads carry the path inside the dropped folder as the
        // filename ("notes/2026/kickoff.md"), so the subtree is recreated
        const name = sanitizeRelativePath(v.name);
        if (!name) continue;
        // a dropped folder copied from another workspace may carry its old
        // sidecar tree along: that is knode-os's state, never an upload
        if (hasSidecarSegment(name)) {
          skipped.push(name);
          continue;
        }
        const rel = `${dir}/${name}`.replace(/\/+/g, '/');
        if (pathExists(ctx.dataDir, rel)) {
          const ext = path.extname(name);
          const stem = name.slice(0, name.length - ext.length);
          const alt = `${dir}/${stem}-${Date.now()}${ext}`;
          writeFileBytes(ctx.dataDir, alt, new Uint8Array(await v.arrayBuffer()));
          saved.push(alt);
        } else {
          writeFileBytes(ctx.dataDir, rel, new Uint8Array(await v.arrayBuffer()));
          saved.push(rel);
        }
      }
      return c.json({ ok: true, saved, ...(skipped.length ? { skipped } : {}) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ---------------------------- folder import --------------------------- */

  // A folder elsewhere on this machine, mirrored under raw/docs with its tree
  // intact: once (copy) or kept in sync (link). See src/ingest/folders.ts.
  // Importing is an administrator's call (src/auth/apis.ts), and never reaches
  // into the data root: other accounts' workspaces, the teams, the tokens.
  const importPolicy = { protectedRoots: [rootCtx.dataDir] };

  app.get('/api/folders', (c) => {
    const ctx = requestCtx(c);
    const folders = servicesFor(ctx)?.folders ?? null;
    return c.json({ links: folders ? folders.status() : describeLinkedFolders(ctx) });
  });

  // what an import would carry, before anything is written
  app.post('/api/folders/preview', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { source?: string; dest?: string };
      const source = resolveImportSource(ctx.dataDir, String(body.source ?? ''), importPolicy);
      const dest = importDestFor(source, body.dest);
      const plan = planFolderImport(source);
      const owner = linkOwning(linkedFolders(ctx.config), dest);
      return c.json({
        source,
        dest,
        files: plan.files.length,
        bytes: plan.bytes,
        skippedByType: plan.skippedByType,
        tooLarge: plan.tooLarge,
        exists: pathExists(ctx.dataDir, dest),
        linked: owner ? { source: owner.source, dest: owner.dest } : null,
        sample: plan.files.slice(0, 8).map((f) => f.rel),
      });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/folders/import', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    // held while the folder is copied and the link written: a config save in
    // the meantime would drop the link. Indexing runs after the response
    // (unless `wait`), with vectors after that (src/ingest/embed-backfill.ts).
    ingestRunning.add(ctx.dataDir);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { source?: string; dest?: string; mode?: string; replace?: boolean; wait?: boolean };
      const mode = body.mode === 'link' ? 'link' : body.mode === 'copy' || body.mode === undefined ? 'copy' : null;
      if (!mode) return c.json({ error: 'mode must be copy or link' }, 400);
      const services = servicesFor(ctx);
      const background = body.wait === true
        ? undefined
        : {
          track: services?.track,
          onIndexed: (done: { dest: string; sync: SyncStats | null; error?: string }) =>
            log(done.error
              ? `import ${done.dest}: indexing failed: ${done.error}`
              : `import ${done.dest}: ${done.sync!.indexed} indexed, ${done.sync!.unchanged} unchanged, ${done.sync!.errors} errors, ${done.sync!.chunks} chunks`),
        };
      const opts = { dest: body.dest, replace: Boolean(body.replace), policy: importPolicy, onProgress: log, background };
      const folders = services?.folders ?? null;
      const result = await activityOf(ctx.dataDir).run(
        'folder',
        `${mode === 'link' ? 'Link' : 'Import'} ${String(body.source ?? '')}`,
        () => (mode === 'link' && folders ? folders.add(String(body.source ?? ''), opts) : importFolder(ctx, String(body.source ?? ''), { ...opts, mode })),
        (r) => `${r.copied.length} files copied into ${r.dest}`,
      );
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(err(e), e instanceof FolderImportConflict ? 409 : 400);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  // mirror a link's source now (every link without `dest`) and index what changed
  app.post('/api/folders/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { dest?: string };
      const dest = typeof body.dest === 'string' && body.dest.trim() ? cleanRelPath(body.dest) : undefined;
      const folders = servicesFor(ctx)?.folders ?? null;
      const results = folders ? await folders.refresh(dest) : await refreshLinkedFolders(ctx, dest, { onProgress: log, policy: importPolicy });
      return c.json({ ok: true, results: results.map((r) => ({ ...r, copied: r.copied.length, removed: r.removed.length })) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // forget a link; the mirror stays unless removeFiles=1, which disposes it like any deletion
  app.delete('/api/folders', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const dest = cleanRelPath(c.req.query('dest') ?? '');
      if (!dest) return c.json({ error: 'dest required' }, 400);
      const removeFiles = c.req.query('removeFiles') === '1' || c.req.query('removeFiles') === 'true';
      const folders = servicesFor(ctx)?.folders ?? null;
      const result = folders ? await folders.remove(dest, { removeFiles }) : await unlinkFolder(ctx, dest, { removeFiles, onProgress: log });
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(err(e), 400);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  /* --------------------------- code repositories --------------------------- */

  // Repositories under raw/codebase (src/ingest/codebase, docs/design/25). Adding
  // one fetches from the network onto the server's disk, so it is an
  // administrator's call (src/auth/apis.ts) and only remote URLs are taken.
  app.get('/api/codebases', (c) => {
    const ctx = requestCtx(c);
    const activity = activityOf(ctx.dataDir);
    const { running: active, recent } = activity.snapshot();
    // what is fetching now, and how the last few ended — a background add says so here when it fails
    return c.json({
      codebases: describeCodebases(ctx),
      running: (servicesFor(ctx)?.codebases?.busy ?? false) || activity.busy('codebase'),
      activity: active.filter((a) => a.kind === 'codebase'),
      recent: recent.filter((a) => a.kind === 'codebase').slice(0, 5),
    });
  });

  app.post('/api/codebases/add', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { repository?: string; name?: string; ref?: string; include?: string[]; exclude?: string[]; follow?: boolean; docs?: boolean; wait?: boolean };
      const spec = String(body.repository ?? '').trim();
      const strings = (v: unknown) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : []);
      const opts = { name: body.name, ref: body.ref, include: strings(body.include), exclude: strings(body.exclude), follow: Boolean(body.follow), docs: body.docs !== false, allowLocal: false };
      // refuse what is wrong before answering, so the person hears it now rather than in the log
      assertFetchable(parseRepoSpec(spec).url, false);
      checkRef(opts.ref);
      const services = servicesFor(ctx);
      const run = () => (services?.codebases
        ? services.codebases.add(spec, opts)
        : codebaseActivity(ctx, `Add repository ${spec}`, log, (progress) => addCodebase(ctx, spec, { ...opts, onProgress: progress }), describeAdd));
      if (body.wait === true) return c.json({ ok: true, ...(await run()) });
      void run().catch((e) => log(`codebase ${spec}: ${e instanceof Error ? e.message : e}`));
      return c.json({ ok: true, started: true }, 202);
    } catch (e) {
      return c.json(err(e), e instanceof CodebaseConflict ? 409 : 400);
    }
  });

  // fetch one repository (or every one, or with `followed` every followed one — Tasks → Check now) again;
  // `wait: false` answers 202 at once, saying how many it fetches and whether it waits behind a fetch
  // under way, and the fetch shows as a `codebase` activity — a large repository takes minutes to index
  app.post('/api/codebases/update', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { name?: string; reindex?: boolean; wait?: boolean; followed?: boolean };
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
      if (name && !codebaseLinks(ctx.config).some((l) => l.name === name)) return c.json({ error: `no repository named ${name}` }, 404);
      const force = Boolean(body.reindex);
      const followedOnly = !name && body.followed === true;
      const repositories = name ? 1 : codebaseLinks(ctx.config).filter((l) => !followedOnly || l.follow).length;
      const services = servicesFor(ctx);
      const run = () => (services?.codebases
        ? services.codebases.update(name, { force, followedOnly })
        : updateActivity(ctx, name ? `${name}: fetching again from its repository` : followedOnly ? 'Followed repositories: fetching again' : 'Every repository: fetching again', log,
          (progress) => updateCodebases(ctx, name, { force, followedOnly, onProgress: progress })));
      if (body.wait === false) {
        if (repositories === 0) return c.json({ ok: true, started: false, repositories });
        const queued = services?.codebases?.busy ?? false;
        void run().catch((e) => log(`codebase ${name ?? (followedOnly ? '(followed)' : '(all)')}: ${e instanceof Error ? e.message : e}`));
        return c.json({ ok: true, started: true, repositories, queued }, 202);
      }
      const results = await run();
      return c.json({ ok: true, results: results.map((r) => ('error' in r ? r : { ...r, copied: r.copied.length, removed: r.removed.length })) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.patch('/api/codebases', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { name?: string; ref?: string; include?: string[]; exclude?: string[]; follow?: boolean; docs?: boolean };
      const patch: Parameters<typeof editCodebase>[2] = {};
      if (typeof body.ref === 'string') patch.ref = body.ref;
      if (Array.isArray(body.include)) patch.include = body.include.map(String).filter(Boolean);
      if (Array.isArray(body.exclude)) patch.exclude = body.exclude.map(String).filter(Boolean);
      if (typeof body.follow === 'boolean') patch.follow = body.follow;
      if (typeof body.docs === 'boolean') patch.docs = body.docs;
      return c.json({ ok: true, codebase: editCodebase(ctx, String(body.name ?? ''), patch) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/codebases', async (c) => {
    const ctx = requestCtx(c);
    try {
      const name = String(c.req.query('name') ?? '').trim();
      if (!name) return c.json({ error: 'name required' }, 400);
      const keepFiles = c.req.query('keepFiles') === '1' || c.req.query('keepFiles') === 'true';
      const services = servicesFor(ctx);
      const result = services?.codebases
        ? await services.codebases.remove(name, { keepFiles })
        : await codebaseActivity(ctx, `Remove repository ${name}${keepFiles ? ', keeping its files' : ''}`, log, (progress) => removeCodebase(ctx, name, { keepFiles, onProgress: progress }));
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* --------------------------- Feishu documents --------------------------- */

  // Feishu Docs mirrored under raw/docs, once or kept in sync (src/ingest/feishu/docs.ts).
  // Reading goes out as this machine's signed-in Feishu user (lark-cli), so signing in,
  // previewing and importing are an administrator's call (src/auth/apis.ts); syncing and
  // unlinking what is linked already are a files matter, like a linked folder's.
  const feishuSignIn = new FeishuSignIn(() => feishuClient(rootCtx.config), log);
  /** A Feishu failure as a response: what went wrong, and whether signing in again would fix it. */
  const feishuErr = (e: unknown) => ({ ...err(e), ...(e instanceof FeishuError ? { reason: `feishu-${e.kind}` } : {}) });

  app.get('/api/feishu', (c) => {
    const ctx = requestCtx(c);
    const feishu = servicesFor(ctx)?.feishu ?? null;
    return c.json({ links: feishu ? feishu.status() : describeFeishuLinks(ctx) });
  });

  // who lark-cli is signed in as, what it may read, and a sign-in under way
  app.get('/api/feishu/auth', async (c) => {
    const status = await feishuClient(requestCtx(c).config).status();
    return c.json({ ...status, signIn: feishuSignIn.state() });
  });

  // the one-time authorization: a device-flow link to open on any device
  app.post('/api/feishu/auth/login', async (c) => {
    try {
      const status = await feishuClient(requestCtx(c).config).status();
      if (!status.installed) return c.json({ error: status.error ?? 'lark-cli is not installed', reason: 'feishu-not-installed' }, 400);
      return c.json({ ok: true, signIn: await feishuSignIn.begin(status) });
    } catch (e) {
      return c.json(feishuErr(e), 400);
    }
  });

  // what an import would bring, before anything is written — and proof it is readable: one link
  // (`url`, the answer is its preview) or several (`urls`, one line each; the answer lists them)
  app.post('/api/feishu/preview', async (c) => {
    const ctx = requestCtx(c);
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; urls?: string | string[]; dest?: string; subpages?: boolean };
    const client = feishuClient(ctx.config);
    const subpages = body.subpages === true;
    if (body.urls === undefined) {
      try {
        return c.json(await previewFeishu(ctx, client, String(body.url ?? ''), { subpages, dest: body.dest }));
      } catch (e) {
        return c.json(feishuErr(e), 400);
      }
    }
    const inputs = splitFeishuInputs(body.urls);
    if (inputs.length === 0) return c.json({ error: 'paste at least one Feishu link' }, 400);
    const items = [];
    for (const input of inputs) {
      try {
        items.push({ input, ok: true, preview: await previewFeishu(ctx, client, input, { subpages }), error: null });
      } catch (e) {
        items.push({ input, ok: false, preview: null, ...feishuErr(e) });
        // without a working sign-in every other link fails the same way
        if (e instanceof FeishuError && (e.kind === 'auth' || e.kind === 'not-installed')) break;
      }
    }
    return c.json({ items });
  });

  // import or link: one document at once (its indexing goes on in the background); several
  // links, or a wiki tree, as a background job to follow at GET /api/feishu/import/:id —
  // or all of it before answering with `wait`
  app.post('/api/feishu/import', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; urls?: string | string[]; dest?: string; mode?: string; wait?: boolean; subpages?: boolean };
    const mode = body.mode === 'link' ? 'link' : body.mode === 'copy' || body.mode === undefined ? 'copy' : null;
    if (!mode) return c.json({ error: 'mode must be copy or link' }, 400);
    const inputs = splitFeishuInputs(body.urls ?? body.url ?? '');
    if (inputs.length === 0) return c.json({ error: 'a Feishu link is required' }, 400);
    const subpages = body.subpages === true;
    const services = servicesFor(ctx);
    const feishu = services?.feishu ?? null;
    const client = feishuClient(ctx.config);
    let ref: ReturnType<typeof parseFeishuRef> | null = null;
    try {
      ref = parseFeishuRef(inputs[0]);
    } catch {
      // reported by the import itself
    }
    const tree = ref?.kind === 'space' || (ref?.kind === 'wiki' && subpages);
    if ((inputs.length > 1 || tree) && body.wait !== true) {
      try {
        const opts = { mode, subpages } as const;
        const { job } = feishu ? feishu.startImport(inputs, opts) : startFeishuImport(ctx, client, inputs, { ...opts, log, track: services?.track });
        return c.json({ ok: true, job }, 202);
      } catch (e) {
        return c.json(feishuErr(e), e instanceof FolderImportConflict ? 409 : 400);
      }
    }
    // held while the documents are written and the links saved, as for a folder import
    ingestRunning.add(ctx.dataDir);
    try {
      if (inputs.length > 1 || tree) {
        const out = await activityOf(ctx.dataDir).run(
          'feishu',
          `${mode === 'link' ? 'Link' : 'Import'} ${inputs.length === 1 ? inputs[0] : `${inputs.length} Feishu links`}`,
          () => importFeishuBatch(ctx, client, inputs, { mode, subpages, dest: body.dest, onProgress: log }),
          (r) => `${r.items.filter((x) => x.ok).length} of ${r.items.length} written`,
        );
        return c.json({ ok: true, ...out });
      }
      const background = body.wait === true
        ? undefined
        : {
          track: services?.track,
          onIndexed: (done: { dest: string; sync: SyncStats | null; error?: string }) =>
            log(done.error
              ? `feishu ${done.dest}: indexing failed: ${done.error}`
              : `feishu ${done.dest}: ${done.sync!.indexed} indexed, ${done.sync!.unchanged} unchanged, ${done.sync!.errors} errors, ${done.sync!.chunks} chunks`),
        };
      const url = inputs[0];
      const opts = { mode, dest: body.dest, subpages, onProgress: log, background } as const;
      const result = await activityOf(ctx.dataDir).run(
        'feishu',
        `${mode === 'link' ? 'Link' : 'Import'} ${url}`,
        () => (feishu ? feishu.add(url, opts) : importFeishuDocument(ctx, client, url, opts)),
        (r) => `${r.title}: ${r.written.length} files written into ${r.dest}`,
      );
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(feishuErr(e), e instanceof FolderImportConflict ? 409 : 400);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  // background imports of this workspace, latest first, and one of them as it goes
  app.get('/api/feishu/import', (c) => c.json({ jobs: feishuImportJobs(requestCtx(c).dataDir) }));
  app.get('/api/feishu/import/:id', (c) => {
    const job = feishuImportJobs(requestCtx(c).dataDir).find((j) => j.id === c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'no such import' }, 404);
  });

  // ask Feishu now which linked documents changed, and re-mirror those; `force` fetches regardless.
  // Every link (the Check now buttons) is checked in the background unless `wait`; one with `dest`, before answering.
  app.post('/api/feishu/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { dest?: string; force?: boolean; wait?: boolean };
      const dest = typeof body.dest === 'string' && body.dest.trim() ? cleanRelPath(body.dest) : undefined;
      const force = body.force === true;
      const feishu = servicesFor(ctx)?.feishu ?? null;
      if (!dest && feishu && body.wait !== true) {
        if (feishuLinks(ctx.config).length === 0) return c.json({ ok: true, started: false, running: false, links: 0 });
        const started = feishu.checkNow({ force });
        return c.json({ ok: true, started, running: true, links: feishuLinks(ctx.config).length }, started ? 202 : 200);
      }
      const results = feishu
        ? await feishu.refresh(dest, { force })
        : await refreshFeishuLinks(ctx, feishuClient(ctx.config), { dest, force, onProgress: log });
      return c.json({ ok: true, results });
    } catch (e) {
      return c.json(feishuErr(e), 400);
    }
  });

  // forget a linked document; the mirror stays unless removeFiles=1
  app.delete('/api/feishu', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const dest = cleanRelPath(c.req.query('dest') ?? '');
      if (!dest) return c.json({ error: 'dest required' }, 400);
      const removeFiles = c.req.query('removeFiles') === '1' || c.req.query('removeFiles') === 'true';
      const feishu = servicesFor(ctx)?.feishu ?? null;
      const result = feishu ? await feishu.remove(dest, { removeFiles }) : await unlinkFeishuDocument(ctx, dest, { removeFiles, onProgress: log });
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(err(e), 400);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  /* --------------------------- agent conversations ------------------------ */

  // Claude Code and Codex sessions on this machine, picked one by one and rendered into raw/docs as
  // dialogue, once or followed (src/ingest/conversations, docs/design/24). The catalog shows every
  // session's prompts, so it, a preview and importing are an administrator's; what is followed is
  // anyone's who may sync the files.

  const agentOf = (v: unknown): 'claude' | 'codex' | null => (v === 'claude' || v === 'codex' ? v : null);

  // what is followed here, with when each was last checked
  app.get('/api/conversations', (c) => {
    const ctx = requestCtx(c);
    const conversations = servicesFor(ctx)?.conversations ?? null;
    return c.json({ links: conversations ? conversations.status() : describeConversationLinks(ctx), checking: conversations?.checking ?? false });
  });

  // this machine's conversations, newest first; each says whether this workspace holds a copy
  app.get('/api/conversations/catalog', (c) => {
    const ctx = requestCtx(c);
    const truthy = (v: string | undefined) => v === '1' || v === 'true';
    const limit = Number(c.req.query('limit') ?? '');
    const result = listAgentConversations(ctx.config, {
      q: c.req.query('q') ?? undefined,
      agent: agentOf(c.req.query('agent')) ?? undefined,
      project: c.req.query('project') || undefined,
      automated: truthy(c.req.query('automated')),
      id: c.req.query('id') || undefined,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : undefined,
    });
    const copies = conversationCopies(ctx.dataDir, ctx.config);
    const followed = new Set(conversationLinks(ctx.config).map((l) => `${l.agent}:${l.id}`));
    return c.json({
      ...result,
      conversations: result.conversations.map((s) => {
        const key = `${s.agent}:${s.id}`;
        return { ...s, copy: copies.get(key) ?? null, followed: followed.has(key) };
      }),
    });
  });

  // what importing one would write, without writing it
  app.get('/api/conversations/preview', (c) => {
    const ctx = requestCtx(c);
    const agent = agentOf(c.req.query('agent'));
    const id = c.req.query('id') ?? '';
    if (!agent || !id) return c.json({ error: 'agent (claude or codex) and id are required' }, 400);
    try {
      return c.json(previewConversation(ctx, { agent, id }, c.req.query('folder') || undefined));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // import (copy) or follow conversations, then index what was written
  app.post('/api/conversations/import', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { sessions?: unknown; mode?: string; folder?: string };
    const mode = body.mode === 'follow' ? 'follow' : body.mode === 'copy' || body.mode === undefined ? 'copy' : null;
    if (!mode) return c.json({ error: 'mode must be copy or follow' }, 400);
    const refs: ConversationRef[] = (Array.isArray(body.sessions) ? body.sessions : [])
      .map((x) => (x && typeof x === 'object' ? (x as { agent?: unknown; id?: unknown }) : {}))
      .flatMap((x) => {
        const agent = agentOf(x.agent);
        return agent && typeof x.id === 'string' && x.id.trim() ? [{ agent, id: x.id.trim() }] : [];
      });
    if (refs.length === 0) return c.json({ error: 'name at least one conversation: sessions [{ agent, id }]' }, 400);
    const folder = typeof body.folder === 'string' && body.folder.trim() ? body.folder : undefined;
    const conversations = servicesFor(ctx)?.conversations ?? null;
    ingestRunning.add(ctx.dataDir);
    try {
      const opts = { mode, folder, onProgress: log } as const;
      const result = await activityOf(ctx.dataDir).run(
        'conversations',
        `${mode === 'follow' ? 'Follow' : 'Import'} ${refs.length === 1 ? 'a conversation' : `${refs.length} conversations`}`,
        () => (conversations ? conversations.add(refs, opts) : importConversations(ctx, refs, opts)),
        (r) => `${r.items.filter((i) => i.ok).length} of ${r.items.length} written`,
      );
      return c.json({ ok: result.items.some((i) => i.ok), ...result });
    } catch (e) {
      return c.json(err(e), 400);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  // look at every followed conversation now (in the background unless `wait`), or the one at `dest` before answering;
  // a person asking does not wait for a conversation to go quiet; `force` renders even unchanged ones
  app.post('/api/conversations/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { dest?: string; force?: boolean; wait?: boolean };
      const dest = typeof body.dest === 'string' && body.dest.trim() ? cleanRelPath(body.dest) : undefined;
      const force = body.force === true;
      const conversations = servicesFor(ctx)?.conversations ?? null;
      const followed = conversationLinks(ctx.config).length;
      if (!dest && conversations && body.wait !== true) {
        if (followed === 0) return c.json({ ok: true, started: false, running: false, links: 0 });
        const started = conversations.checkNow({ force });
        return c.json({ ok: true, started, running: true, links: followed }, started ? 202 : 200);
      }
      const results = conversations
        ? await conversations.refresh(dest, { force })
        : await refreshConversations(ctx, { dest, force, onProgress: log });
      return c.json({ ok: true, results });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // stop following a conversation; its copy stays unless removeFiles=1
  app.delete('/api/conversations', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const dest = cleanRelPath(c.req.query('dest') ?? '');
      if (!dest) return c.json({ error: 'dest required' }, 400);
      const removeFiles = c.req.query('removeFiles') === '1' || c.req.query('removeFiles') === 'true';
      const conversations = servicesFor(ctx)?.conversations ?? null;
      const result = conversations ? await conversations.remove(dest, { removeFiles }) : await unfollowConversation(ctx, dest, { removeFiles, onProgress: log });
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(err(e), 400);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  /* --------------------------------- feeds -------------------------------- */

  // Sources that keep producing items — chats, mailboxes, accounts, searches, repositories —
  // pulled on a schedule or pushed in, filtered and transformed by the feed's stages and written
  // under raw/docs (src/ingest/feeds, docs/design/26). Defining a feed can make the server run a
  // program or a model, so writing one, previewing one and checking its source are an
  // administrator's; running, pushing and rendering again are anyone's who may ingest.

  const feedRunner = (ctx: AppContext) => servicesFor(ctx)?.feeds ?? null;

  app.get('/api/feeds', (c) => {
    const ctx = requestCtx(c);
    const runner = feedRunner(ctx);
    return c.json({ feeds: runner ? runner.status() : describeFeeds(ctx.dataDir) });
  });

  // the kinds of source and the user-defined stages this server can run
  app.get('/api/feeds/connectors', (c) => c.json(feedConnectorCatalog()));

  app.get('/api/feeds/:id', (c) => {
    const ctx = requestCtx(c);
    const feed = loadFeed(ctx.dataDir, c.req.param('id'));
    if (!feed) return c.json({ error: 'no such feed' }, 404);
    const runner = feedRunner(ctx);
    const status = (runner ? runner.status() : describeFeeds(ctx.dataDir)).find((f) => f.id === feed.id) ?? null;
    return c.json({ feed: redactFeed(feed), status });
  });

  // what the feed kept, dropped and is waiting on, newest first — to see whether a filter does what it should
  app.get('/api/feeds/:id/items', (c) => {
    const ctx = requestCtx(c);
    const feed = loadFeed(ctx.dataDir, c.req.param('id'));
    if (!feed) return c.json({ error: 'no such feed' }, 404);
    const status = c.req.query('status');
    const limit = Number(c.req.query('limit') ?? '');
    return c.json({
      items: feedItems(ctx.dataDir, feed, {
        status: status === 'keep' || status === 'drop' || status === 'pending' ? status : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50,
      }),
    });
  });

  // create or replace a feed's definition (the body is the feed as GET shows it; masked secrets keep their values)
  app.put('/api/feeds/:id', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    if (!isValidFeedId(id)) return c.json({ error: 'a feed id is lower-case letters, digits, - and _' }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const feed = saveFeed(ctx.dataDir, id, body);
      return c.json({ ok: true, feed: redactFeed(feed) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // stop and forget a feed; removeFiles=1 also removes what it wrote, forget=1 its ledger
  app.delete('/api/feeds/:id', async (c) => {
    const ctx = requestCtx(c);
    const truthy = (v: string | undefined) => v === '1' || v === 'true';
    try {
      const result = await deleteFeed(ctx, c.req.param('id'), { removeFiles: truthy(c.req.query('removeFiles')), forgetLedger: truthy(c.req.query('forget')), onProgress: log });
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // what a run would pull, keep and write, without keeping or writing anything — for a stored feed ({ id })
  // or a definition being written ({ id, feed }); model and command stages do run
  app.post('/api/feeds/preview', async (c) => {
    const ctx = requestCtx(c);
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; feed?: Record<string, unknown>; items?: unknown[]; pull?: boolean };
    const id = typeof body.id === 'string' && isValidFeedId(body.id) ? body.id : 'preview-feed';
    const feed = body.feed ? normalizeFeed(body.feed, id) : loadFeed(ctx.dataDir, id);
    if (!feed) return c.json({ error: 'name a stored feed (id) or send a definition (feed)' }, 400);
    const problem = feedProblem(feed);
    if (problem) return c.json({ error: problem }, 400);
    try {
      const result = await previewFeed(ctx, feed, { items: Array.isArray(body.items) ? body.items : undefined, pull: body.pull, onProgress: log });
      return c.json({ preview: true, ...result });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // can the feed reach its source with these params?
  app.post('/api/feeds/check', async (c) => {
    const ctx = requestCtx(c);
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; feed?: Record<string, unknown> };
    const id = typeof body.id === 'string' && isValidFeedId(body.id) ? body.id : 'check-feed';
    const feed = body.feed ? normalizeFeed(body.feed, id) : loadFeed(ctx.dataDir, id);
    if (!feed) return c.json({ error: 'name a stored feed (id) or send a definition (feed)' }, 400);
    try {
      return c.json(await checkFeed(ctx, feed));
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  });

  // run now: in the background (202) unless wait is set
  app.post('/api/feeds/:id/run', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    const feed = loadFeed(ctx.dataDir, id);
    if (!feed) return c.json({ error: 'no such feed' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { wait?: boolean };
    const runner = feedRunner(ctx);
    try {
      if (runner && body.wait !== true) {
        const started = runner.runNow(id);
        return c.json({ ok: true, started, running: true }, started ? 202 : 200);
      }
      const result = runner ? await (runner.runNow(id, {}, true) as Promise<unknown>) : await runFeed(ctx, feed, { onProgress: log });
      return c.json({ ok: true, result });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // push items in: a JSON body { items: [...] } (or one item), or NDJSON — one item per line
  app.post('/api/feeds/:id/items', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    const feed = loadFeed(ctx.dataDir, id);
    if (!feed) return c.json({ error: 'no such feed' }, 404);
    if (!feed.enabled) return c.json({ error: `feed ${id} is disabled` }, 409);
    const raw = await c.req.text();
    let items: unknown[] = [];
    try {
      const type = (c.req.header('content-type') ?? '').toLowerCase();
      if (type.includes('ndjson') || type.includes('jsonl')) items = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      else {
        const body = JSON.parse(raw || '{}') as { items?: unknown[] } | unknown[];
        items = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : body && typeof body === 'object' && 'id' in body ? [body] : [];
      }
    } catch {
      return c.json({ error: 'send JSON ({ "items": [...] }) or NDJSON (one item per line)' }, 400);
    }
    if (items.length === 0) return c.json({ error: 'no items in the body' }, 400);
    if (items.length > 5000) return c.json({ error: 'at most 5000 items per request' }, 413);
    try {
      const runner = feedRunner(ctx);
      const result = runner ? await runner.push(id, items) : await pushToFeed(ctx, feed, items, { onProgress: log });
      return c.json({ ok: true, result });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // render the feed's documents again from its ledger: all periods, or those that changed; redecide asks the stages again
  app.post('/api/feeds/:id/rerender', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    const feed = loadFeed(ctx.dataDir, id);
    if (!feed) return c.json({ error: 'no such feed' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { redecide?: boolean };
    try {
      const runner = feedRunner(ctx);
      const opts = { pull: false, all: true, redecide: body.redecide === true };
      const result = runner ? await (runner.runNow(id, opts, true) as Promise<unknown>) : await runFeed(ctx, feed, { ...opts, onProgress: log });
      return c.json({ ok: true, result });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ----------------------------- knowledge ------------------------------ */

  app.post('/api/ingest', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest already running' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const stats = await activityOf(ctx.dataDir).run('ingest', 'Index new and changed files', () => sync(ctx, { onProgress: log }), describeSync);
      return c.json(stats);
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  app.post('/api/sync', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'sync already running' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { only?: string[]; verify?: boolean };
      const only = Array.isArray(body.only) ? body.only.map(String) : undefined;
      return c.json(await activityOf(ctx.dataDir).run('sync', `Sync ${only?.length ? only.join(', ') : 'everything'}`, () => sync(ctx, { only, verify: Boolean(body.verify), onProgress: log }), describeSync));
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  /* ------------------------------- lineage ------------------------------ */

  app.get('/api/lineage', async (c) => {
    const ctx = requestCtx(c);
    const kind = c.req.query('kind');
    const id = c.req.query('id');
    if (!id || !['entity', 'relation', 'claim', 'page', 'document'].includes(kind ?? '')) {
      return c.json({ error: 'kind (entity|relation|claim|page|document) and id required' }, 400);
    }
    try {
      return c.json(await lineageOf(ctx.store, kind as 'entity', id));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/history', async (c) => {
    const ctx = requestCtx(c);
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    return c.json(await historyOf(ctx.store, ctx.dataDir, p));
  });

  app.post('/api/forget', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'sync running — try again shortly' }, 409);
    try {
      const { path: p } = await c.req.json<{ path: string }>();
      if (!p) return c.json({ error: 'path required' }, 400);
      assertSourcePath(p);
      return c.json(await forgetSource(ctx, p));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/purge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { before?: string; archived?: boolean };
      const out: Record<string, unknown> = {};
      if (body.archived) out.archivedRemoved = purgeArchived(ctx.dataDir);
      if (body.before || !body.archived) out.disposed = await purgeDisposed(ctx.store, { before: body.before, actor: 'api' });
      return c.json(out);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/rebuild', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'sync running — try again shortly' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { history?: boolean };
      return c.json(await rebuild(ctx, { history: Boolean(body.history), onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  app.get('/api/search', async (c) => {
    const ctx = requestCtx(c);
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'q required' }, 400);
    // a number of results, a hundred at the most; anything else is the default (`search` reads it so too)
    const asked = Number(c.req.query('k') ?? 8);
    const k = Number.isFinite(asked) && asked >= 1 ? Math.min(SEARCH_ROUTE_K_MAX, Math.floor(asked)) : 8;
    const modeParam = c.req.query('mode') ?? 'hybrid';
    if (!['hybrid', 'vector', 'keyword', 'sag'].includes(modeParam)) {
      return c.json({ error: `unsupported search mode: ${modeParam}` }, 400);
    }
    const mode = modeParam as SearchMode;
    try {
      const results = await search(ctx.store, ctx.embedder, q, {
        k,
        mode,
        heat: ctx.config.heat,
        sag: ctx.config.retrieval.sag,
        asOf: c.req.query('as_of') || undefined,
        filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
      });
      // the body stays the array of results; a vector channel that came back short is said beside it
      if (results.partial) c.header(SEARCH_PARTIAL_HEADER, results.partial);
      return c.json(results);
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  // Explore → Search: passages with their rank in each channel, the entities the query names, their relations and claims
  app.get('/api/search/explore', async (c) => {
    const ctx = requestCtx(c);
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ error: 'q required' }, 400);
    const modeParam = c.req.query('mode') ?? 'hybrid';
    if (!['hybrid', 'vector', 'keyword', 'sag'].includes(modeParam)) {
      return c.json({ error: `unsupported search mode: ${modeParam}` }, 400);
    }
    try {
      return c.json(await exploreSearch(ctx.store, ctx.embedder, q, {
        k: Math.min(50, Math.max(1, Number(c.req.query('k') ?? 20) || 20)),
        mode: modeParam as SearchMode,
        heat: ctx.config.heat,
        sag: ctx.config.retrieval.sag,
        filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  // what a search box offers while someone types: entities and documents by name, no model involved
  app.get('/api/search/suggest', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await searchSuggest(ctx.store, c.req.query('q') ?? '', Number(c.req.query('limit') ?? 6)));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/ask', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { question, mode = 'hybrid' } = await c.req.json<{ question: string; mode?: SearchMode }>();
      if (!question) return c.json({ error: 'question required' }, 400);
      if (!['hybrid', 'vector', 'keyword', 'sag'].includes(mode)) {
        return c.json({ error: `unsupported search mode: ${mode}` }, 400);
      }
      const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question, { mode });
      // learning from use (src/learn): the answer written back, when the workspace has it on
      const learn = learnConfig(ctx.config);
      if (!learn.enabled || !learn.ask) return c.json(res);
      const learned: WritebackResult = await writeBackAsk(ctx, question, res).catch((e) => ({ status: 'skipped' as const, reason: e instanceof Error ? e.message : String(e), ms: 0 }));
      return c.json({ ...res, learned: { status: learned.status, path: learned.path, suggestionId: learned.suggestionId, verified: learned.verified, reason: learned.reason } });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/graph', async (c) => {
    const ctx = requestCtx(c);
    try {
      const q = c.req.query('q');
      const depth = Number(c.req.query('depth') ?? 2);
      // nodes to return; each reader clamps it to its own range, and NaN means its default
      const limit = Number(c.req.query('limit'));
      if (q) {
        return c.json(await graphSearch(ctx.store, q, {
          depth,
          limit,
          heat: ctx.config.heat,
          temporal: resolveTemporal({
            asOf: c.req.query('as_of') || undefined,
            validAt: c.req.query('valid_at') || undefined,
            validRange: c.req.query('valid_range') || undefined,
          }),
          filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
        }));
      }
      return c.json(await graphOverview(ctx.store, {
        limit,
        types: csv(c.req.query('types')),
        edges: c.req.query('edges') === 'typed' ? 'typed' : 'all',
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.get('/api/claims', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await queryClaims(ctx.store, {
        subject: c.req.query('subject') || undefined,
        object: c.req.query('object') || undefined,
        types: csv(c.req.query('types')),
        statuses: csv(c.req.query('status')),
        kinds: csv(c.req.query('claim_kind')),
        text: c.req.query('text') || undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        eventRange: c.req.query('event_range')
          ? (({ validFrom, validTo }) => ({ from: validFrom, to: validTo }))(resolveTemporal({ validRange: c.req.query('event_range') }))
          : undefined,
        includeSuperseded: c.req.query('include_superseded') === '1' || c.req.query('include_superseded') === 'true',
        order: c.req.query('order') === 'timeline' ? 'timeline' : undefined,
        temporal: resolveTemporal({
          asOf: c.req.query('as_of') || undefined,
          validAt: c.req.query('valid_at') || undefined,
          validRange: c.req.query('valid_range') || undefined,
        }),
        filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
      }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/graph/insights', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await graphInsights(ctx.store));
  });

  // one page of the entity table (src/store/entities.ts); the remote API keeps the bare list
  app.get('/api/entities', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await queryEntities(ctx.store, {
      q: c.req.query('q'),
      types: csv(c.req.query('type')),
      sort: c.req.query('sort'),
      order: c.req.query('order'),
      offset: Number(c.req.query('offset')),
      limit: Number(c.req.query('limit')),
      merged: c.req.query('merged') === '1' || c.req.query('merged') === 'true',
    }));
  });

  // the entities a Markdown view marks: known names in the text it shows, and what its file was indexed with
  app.post('/api/entities/mentions', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; path?: unknown };
      if (typeof body.text !== 'string') return c.json({ error: 'text required' }, 400);
      return c.json(await documentMentions(ctx.store, body.text, { path: typeof body.path === 'string' ? body.path : undefined }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // the panel a marked name opens: the entity with its relations, co-mentions, claims and documents
  app.get('/api/entities/detail', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.query('id');
    if (!id) return c.json({ error: 'id required' }, 400);
    try {
      const detail = await entityDetail(ctx.store, id);
      return detail ? c.json(detail) : c.json({ error: `no live entity ${id}` }, 404);
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/documents', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listDocuments(ctx.store));
  });

  app.get('/api/okf/validate', (c) => {
    const ctx = requestCtx(c);
    try {
      const asIndexed = ['1', 'true'].includes(c.req.query('asIndexed') ?? '');
      const bundle = c.req.query('path') ?? 'wiki';
      assertNotPrivate(bundle);
      return c.json(validateOkfBundle(safePath(ctx.dataDir, bundle), { asIndexed }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/wiki/generate', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json({ created: await generateWiki(ctx.store, ctx.llm, { config: ctx.config, onProgress: log }) });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/grep', (c) => {
    const ctx = requestCtx(c);
    try {
      const pattern = c.req.query('pattern');
      if (!pattern) return c.json({ error: 'pattern required' }, 400);
      // A client that asks for `shape=answer` gets {matches, total}, and `cut` when the matches are a sample
      // (src/fs/files.ts grepAnswer). One that does not gets the array of matches this route has always
      // answered: a command line older than the answer shape reads an object as "(no matches)".
      const at = c.req.query('path') || undefined;
      const answer = grepAnswer(grepSearch(ctx.dataDir, pattern, { paths: at ? [at] : undefined, maxMatches: Number(c.req.query('maxMatches') ?? 100) }));
      return c.json(c.req.query('shape') === 'answer' ? answer : answer.matches);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* --------------------------- live datasources -------------------------- */

  app.post('/api/resolve', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{
        query: string; actor?: string; render?: 'json-graph' | 'ts-program'; record?: boolean;
        maxToolCalls?: number; asOf?: string; validAt?: string; validRange?: string; freshness?: string;
        kinds?: string[]; sources?: string[]; trust?: string; workset?: string;
      }>();
      if (!body.query) return c.json({ error: 'query required' }, 400);
      return c.json(await resolve(ctx, body.query, {
        actor: body.actor,
        render: body.render,
        record: body.record,
        budget: body.maxToolCalls ? { maxToolCalls: body.maxToolCalls } : undefined,
        temporal: await envelopeFor(ctx.store, {
          workset: body.workset, asOf: body.asOf, validAt: body.validAt, validRange: body.validRange, freshness: body.freshness,
        }),
        filter: resolveScopeFilter({ kinds: body.kinds, sources: body.sources, trust: body.trust, actor: body.actor }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.post('/api/plan', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ query: string; render?: 'json-graph' | 'ts-program'; maxToolCalls?: number; asOf?: string; freshness?: string }>();
      if (!body.query) return c.json({ error: 'query required' }, 400);
      return c.json(await planOnly(ctx, body.query, {
        render: body.render,
        budget: body.maxToolCalls ? { maxToolCalls: body.maxToolCalls } : undefined,
        temporal: resolveTemporal({ asOf: body.asOf, freshness: body.freshness }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.post('/api/feedback', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<Parameters<typeof recordFeedback>[1]>();
      if (!body.receiptId) return c.json({ error: 'receiptId required' }, 400);
      return c.json(await recordFeedback(ctx.store, body));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/worksets', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ actor?: string; note?: string; asOf?: string; entities?: string[] }>()
        .catch(() => ({} as { actor?: string; note?: string; asOf?: string; entities?: string[] }));
      return c.json(await checkout(ctx.store, body));
    } catch (e) {
      return c.json(err(e), status(e, 400));
    }
  });

  app.get('/api/worksets', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listWorksets(ctx.store, { actor: c.req.query('actor') || undefined, open: c.req.query('open') === 'true' }));
  });

  app.post('/api/worksets/:id/commit', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ content: string; title?: string; path?: string; keepOpen?: boolean }>();
      if (!body.content) return c.json({ error: 'content required' }, 400);
      return c.json(await commitWorkset(ctx, { worksetId: c.req.param('id'), ...body }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/absences', async (c) => {
    const ctx = requestCtx(c);
    const entities = csv(c.req.query('entities'));
    if (!entities) return c.json({ error: 'entities required' }, 400);
    return c.json(await liveAbsences(ctx.store, entities, c.req.query('as_of') || undefined));
  });

  app.get('/api/disputes', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listDisputes(ctx.store, { status: c.req.query('status') ?? 'open' }));
  });

  app.post('/api/disputes/:id/resolve', async (c) => {
    const ctx = requestCtx(c);
    const body = await c.req.json<{ actor?: string }>().catch(() => ({} as { actor?: string }));
    return c.json({ resolved: await resolveDispute(ctx.store, c.req.param('id'), body.actor) });
  });

  app.post('/api/trust', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ path: string; to: 'trusted' | 'quarantined'; actor?: string }>();
      if (!body.path || !body.to) return c.json({ error: 'path and to required' }, 400);
      return c.json(await setScopeTrust(ctx.store, { key: body.path, to: body.to, actor: body.actor }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/subscriptions', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listSubscriptions(ctx.store, c.req.query('actor') || undefined));
  });

  app.post('/api/subscriptions', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ kind: 'entity' | 'source' | 'intent'; target: string; actor?: string }>();
      if (!body.kind || !body.target) return c.json({ error: 'kind and target required' }, 400);
      return c.json(await subscribe(ctx.store, body));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/subscriptions/:id', async (c) => {
    const ctx = requestCtx(c);
    return c.json({ removed: await unsubscribe(ctx.store, c.req.param('id')) });
  });

  app.get('/api/subscriptions/:id/changes', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await changesSince(ctx.store, c.req.param('id'), {
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        advance: c.req.query('peek') !== 'true',
      }));
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.get('/api/learning', async (c) => {
    const ctx = requestCtx(c);
    const lookbackDays = c.req.query('lookback') ? Number(c.req.query('lookback')) : undefined;
    const intent = c.req.query('intent') || undefined;
    const ranking = await writeRankerReport(ctx.store, { intent });
    const evaluation = await evaluatePacks(ctx.store, { lookbackDays });
    const evalPath = writeEvalReport(ctx.dataDir, evaluation);
    const distilled = c.req.query('distill') === 'true' ? await distillRecipes(ctx.store, { lookbackDays, intent }) : null;
    return c.json({ ranking, evaluation, evalPath, distilled });
  });

  app.get('/api/receipts', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listReceipts(ctx.store, {
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      intent: c.req.query('intent') || undefined,
    }));
  });

  app.get('/api/vfs', async (c) => {
    const ctx = requestCtx(c);
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    try {
      return c.text(await readVirtual(ctx, p.startsWith('/') ? p : `/${p}`));
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.get('/api/capabilities', async (c) => {
    const ctx = requestCtx(c);
    try {
      const entity = c.req.query('entity') || undefined;
      const asOf = c.req.query('as_of') || undefined;
      const capabilities = await listCapabilities(ctx.store, {
        sourceIds: csv(c.req.query('source')),
        kinds: csv(c.req.query('kind')),
        entityIds: entity ? [entity] : undefined,
        asOf,
      });
      if (c.req.query('format') === 'dts') return c.text(renderCapabilityDts(capabilities));
      const locators = entity ? await locatorsForEntities(ctx.store, [entity], asOf) : [];
      return c.json({ capabilities, locators });
    } catch (e) {
      return c.json(err(e), status(e, 400));
    }
  });

  app.get('/api/datasources', async (c) => {
    const ctx = requestCtx(c);
    const datasets = await listDatasets(ctx.store);
    return c.json({
      sources: [
        ...ctx.config.datasources.map((d) => ({ id: d.id, kind: d.kind, description: d.description ?? '' })),
        { id: CATALOG_SOURCE, kind: 'catalog', description: 'the knowledge base itself, as read-only SQL views' },
      ],
      catalog: CATALOG_VIEWS,
      datasets,
    });
  });

  app.post('/api/datasources/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      const stats = await activityOf(ctx.dataDir).run('datasources', 'Refresh datasource schemas', () => sync(ctx, { only: ['datasources'], onProgress: log }), (r) => `${r.pagesRegenerated} wiki pages refreshed`);
      return c.json({ sources: ctx.config.datasources.length, wikiPages: stats.pagesRegenerated, errors: stats.datasourceErrors, disposed: stats.disposed });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/datasources/:id/query', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { sql, maxRows } = await c.req.json<{ sql: string; maxRows?: number }>();
      if (!sql) return c.json({ error: 'sql required' }, 400);
      const id = c.req.param('id');
      if (id === CATALOG_SOURCE) return c.json(await catalogQuery(ctx.store, sql, { maxRows }));
      return c.json(await runSourceQuery(ctx.datasources, id, sql, { maxRows }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ------------------------------ context pack --------------------------- */

  app.post('/api/pack', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{
        utterance: string; record?: boolean; asOf?: string; validAt?: string;
        validRange?: string; freshness?: string; kinds?: string[]; sources?: string[];
      }>();
      if (!body.utterance) return c.json({ error: 'utterance required' }, 400);
      return c.json(await buildContextPack(ctx, body.utterance, {
        record: body.record,
        temporal: resolveTemporal({ asOf: body.asOf, validAt: body.validAt, validRange: body.validRange, freshness: body.freshness }),
        filter: resolveScopeFilter({ kinds: body.kinds, sources: body.sources }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  /* --------------------------- traces & dream --------------------------- */

  app.get('/api/traces', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listTraces(ctx.store));
  });

  app.post('/api/traces/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await activityOf(ctx.dataDir).run('traces', 'Collect agent traces', () => syncTraces(ctx.store, ctx.config, { ignoreSince: true }), (r) => `${r.copied} traces, ${r.skills} skill files`));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/suggestions', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listSuggestions(ctx.store, { status: c.req.query('status') }));
  });

  app.post('/api/suggestions/:id/status', async (c) => {
    const ctx = requestCtx(c);
    const { status } = await c.req.json<{ status: string }>();
    if (status !== 'pending' && status !== 'accepted' && status !== 'rejected' && status !== 'stale') return c.json({ error: 'bad status' }, 400);
    const id = c.req.param('id');
    await setSuggestionStatus(ctx.store, id, status);
    // machine-actionable suggestions (playbook revisions) take effect on accept
    let applied: { applied: boolean; path?: string } = { applied: false };
    if (status === 'accepted') {
      const s = await getSuggestion(ctx.store, id);
      if (s && (s.kind === 'pack' || s.kind === 'recipe' || s.kind === 'merge' || s.kind === 'claim-merge' || s.kind === 'wiki' || s.kind === 'learn')) {
        try {
          applied = await applySuggestion(ctx.store, ctx.dataDir, id);
          // an accepted learned page is read from the next answer on (src/learn/writeback.ts)
          if (s.kind === 'learn' && applied.path) await sync(ctx, { only: [applied.path], llmGraph: false, datasources: false });
        } catch (e) {
          await setSuggestionStatus(ctx.store, id, 'pending');
          return c.json(err(e), 400);
        }
      }
    }
    return c.json({ ok: true, ...applied });
  });

  /* ------------------------------ entities -------------------------------- */

  app.get('/api/entities/merges', async (c) => c.json(await listMerges(requestCtx(c).store)));

  app.post('/api/entities/merge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { entityId, canonicalId, reason } = await c.req.json<{ entityId: string; canonicalId: string; reason?: string }>();
      return c.json(await applyMerge(ctx.store, { entityId, canonicalId, reason, actor: 'user' }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/entities/unmerge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { entityId } = await c.req.json<{ entityId: string }>();
      return c.json({ ok: await unmergeEntity(ctx.store, entityId, { actor: 'user' }) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* -------------------------- duplicate claims ---------------------------- */

  app.get('/api/claims/merges', async (c) => c.json(await listClaimMerges(requestCtx(c).store)));

  app.post('/api/claims/merge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { claimId, canonicalId, reason } = await c.req.json<{ claimId: string; canonicalId: string; reason?: string }>();
      return c.json(await applyClaimMerge(ctx.store, { claimId, canonicalId, reason, actor: 'user' }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/claims/unmerge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { claimId } = await c.req.json<{ claimId: string }>();
      return c.json({ ok: await unmergeClaim(ctx.store, claimId, { actor: 'user' }) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/review/claims', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await reviewClaims(ctx, { onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/entities/dedupe', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await auditDuplicateEntities({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: ctx.llm }, { onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/wiki/lint', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await lintWiki(ctx, { onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* ------------------------------ research -------------------------------- */

  // archived jobs are left out unless asked for (`archived=1` lists only them); a paused job carries `pause`
  app.get('/api/research/jobs', async (c) => {
    const ctx = requestCtx(c);
    const status = c.req.query('status');
    const jobs = await listJobs(ctx.store, {
      status: status ? (status.split(',').map((s) => s.trim()).filter(Boolean) as ResearchStatus[]) : undefined,
      archived: c.req.query('archived') === '1',
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json(jobs.map((j) => ({ ...j, pause: j.status === 'queued' ? activePause(j.payload) : null })));
  });

  app.post('/api/research/jobs', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ kind?: string; target?: string; query?: string; template?: string }>();
      const kind = (body.kind ?? (body.query && !body.target ? 'question' : 'entity')) as ResearchKind;
      if (!RESEARCH_KINDS.includes(kind)) return c.json({ error: `kind must be one of ${RESEARCH_KINDS.join(', ')}` }, 400);
      const res = await queueJob(ctx.store, { kind, target: body.target, query: body.query, template: body.template, requestedBy: 'web' });
      if (res.created) servicesFor(ctx)?.kickResearch();
      return c.json(res, res.created ? 201 : 200);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // Knowledge-base initialization: the survey, the guide, the newest init job and the pages it queued.
  app.get('/api/research/init', async (c) => {
    const ctx = requestCtx(c);
    try {
      const [survey, job, followUps] = await Promise.all([
        surveyKnowledgeBase(ctx),
        latestJob(ctx.store, 'init'),
        listJobs(ctx.store, { requestedBy: 'init', limit: 10 }),
      ]);
      return c.json({ survey, guide: survey.guide, job, followUps });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/research/init', async (c) => {
    const ctx = requestCtx(c);
    try {
      const res = await queueJob(ctx.store, { kind: 'init', requestedBy: 'web' });
      if (res.created) servicesFor(ctx)?.kickResearch();
      return c.json(res, res.created ? 201 : 200);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/research/ask', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { query } = await c.req.json<{ query: string }>();
      if (!query?.trim()) return c.json({ error: 'query is required' }, 400);
      return c.json(await queueJob(ctx.store, { kind: 'question', query, requestedBy: 'web' }), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/research/recommendations', async (c) => {
    const ctx = requestCtx(c);
    try {
      if (c.req.query('refresh')) return c.json((await refreshRecommendations(ctx)).recommendations);
      // pending wiki suggestions are the filed recommendations; recompute on demand otherwise
      const pending = await ctx.store.query<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id, payload FROM suggestions WHERE kind = 'wiki' AND status = 'pending' ORDER BY (payload ->> 'score')::float DESC NULLS LAST LIMIT 30`,
      );
      if (pending.length > 0) return c.json(pending.map((s) => ({ ...s.payload, suggestionId: s.id })));
      return c.json(await recommendWikiTopics(ctx));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // Named agents: who runs a job or a chat turn, and how hard they think.
  // The research *policy* — phases, roles, verification — stays in profiles.
  const agentDetail = (ctx: AppContext, definition: AgentDefinition) => ({
    ...definition,
    builtin: Boolean(BUILTIN_AGENTS[definition.name]),
    /** Whether what it names can actually run here right now. */
    runnable: Boolean(resolveAgentSpec(ctx.config, definition.name, '', ctx.dataDir)),
  });

  /**
   * An agent file changed. The pipeline may run on any agent and the default
   * on a CLI agent, so re-read them, re-flatten the default in case it is one,
   * and move a stage whose agent is gone to the default — saving only when
   * that moved something. `ctx.llm` is rebuilt either way: Judge may run on
   * the very agent that changed.
   */
  const refreshAgentLlms = (ctx: AppContext, moved = false) => {
    const before = JSON.stringify([ctx.config.llmUse, ctx.config.llm]);
    ctx.config.agentLlms = readAgentLlms(ctx.dataDir);
    ctx.config.modelAgents = readModelAgents(ctx.dataDir);
    const targets = llmTargets(ctx.config);
    if (targets.length === 0 && isCliProvider(ctx.config.llm.provider)) {
      // the default was the last CLI agent, and it is gone: leave an empty
      // endpoint, as a new workspace has, rather than a mirror of an agent the
      // next load would rebuild as a row
      ctx.config.llm = { ...defaultConfig().llm };
    }
    // a default that no longer resolves falls back to the first model, then
    // the first CLI agent
    syncActiveLlm(ctx.config);
    const pinned = pinRoutes(ctx.config);
    if (moved || pinned || JSON.stringify([ctx.config.llmUse, ctx.config.llm]) !== before) {
      saveConfig(ctx.dataDir, ctx.config);
    }
    ctx.llm = judgeLlmClient(ctx.config);
  };

  app.get('/api/agents', (c) => {
    const ctx = requestCtx(c);
    return c.json({
      active: ctx.config.research?.agent ?? '',
      chat: ctx.config.chat?.agent ?? '',
      agents: [...loadAgents(ctx.dataDir).values()].map((a) => agentDetail(ctx, a)),
    });
  });

  app.get('/api/agents/:name', (c) => {
    const ctx = requestCtx(c);
    const definition = loadAgent(ctx.dataDir, c.req.param('name'));
    if (!definition) return c.json({ error: 'no such agent' }, 404);
    return c.json(agentDetail(ctx, definition));
  });

  app.put('/api/agents/:name', async (c) => {
    const ctx = requestCtx(c);
    const name = c.req.param('name');
    if (!isValidAgentName(name)) return c.json({ error: 'agent names use letters, digits, - and _ (max 41 chars)' }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { agent?: Record<string, unknown> };
      const incoming = { ...(body.agent ?? {}) };
      // a client that predates OpenCode agents saves without the field; keep the connection it does not know about
      if (!('connection' in incoming)) incoming.connection = loadAgent(ctx.dataDir, name)?.connection ?? '';
      const sharedBefore = sharedSnapshot(ctx.dataDir, ctx.config);
      const saved = saveAgent(ctx.dataDir, { ...incoming, name });
      refreshAgentLlms(ctx);
      // an agent a stage runs on is the server's: every workspace takes the edit
      await shareIfChanged(ctx, sharedBefore);
      return c.json(agentDetail(ctx, saved));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // Deleting a built-in resets it, the way a built-in profile behaves.
  app.delete('/api/agents/:name', async (c) => {
    const ctx = requestCtx(c);
    const name = c.req.param('name');
    const sharedBefore = sharedSnapshot(ctx.dataDir, ctx.config);
    if (!deleteAgent(ctx.dataDir, name)) return c.json({ error: 'no such agent' }, 404);
    const reset = Boolean(BUILTIN_AGENTS[name]);
    // A config still naming a deleted agent would stall the queue with an
    // unresolvable spec, so move it off explicitly: research and Ask to "not
    // set". A pipeline route moves to the default and a default that was this
    // agent falls back, both when the agents are re-read.
    let moved = false;
    if (reset) {
      // back as its defaults before the re-read, or a stage on it would move
      ensureDefaultAgents(ctx.dataDir);
    } else {
      for (const key of ['research', 'chat'] as const) {
        if (ctx.config[key]?.agent === name) {
          ctx.config[key].agent = '';
          moved = true;
        }
      }
    }
    refreshAgentLlms(ctx, moved);
    // a stage that ran on it moved to the default: so it does everywhere
    await shareIfChanged(ctx, sharedBefore);
    return c.json({ ok: true, reset });
  });

  // Research profiles: how a job runs (effort, search, verification, sub-agent roles with their own prompts).
  const profileDetail = (dataDir: string, profile: ResearchProfile) => ({
    ...profile,
    builtin: Boolean(BUILTIN_PROFILES[profile.name]),
    phaseDefaults: PHASES,
    roles: profile.roles.map((r) => {
      const p = rolePromptText(dataDir, r);
      return { ...r, promptPath: p.path, promptText: p.text, promptIsDefault: p.isDefault, promptDefault: PHASES[r.phase] };
    }),
  });

  app.get('/api/research/profiles', (c) => {
    const ctx = requestCtx(c);
    const active = activeProfile(ctx.dataDir, ctx.config);
    return c.json({ active: active.name, pipeline: effectivePipeline(active, ctx.config), profiles: [...loadProfiles(ctx.dataDir).values()].map(profileSummary) });
  });

  app.get('/api/research/profiles/:name', (c) => {
    const ctx = requestCtx(c);
    const profile = loadProfile(ctx.dataDir, c.req.param('name'));
    if (!profile) return c.json({ error: 'no such profile' }, 404);
    return c.json(profileDetail(ctx.dataDir, profile));
  });

  app.put('/api/research/profiles/:name', async (c) => {
    const ctx = requestCtx(c);
    const name = c.req.param('name');
    if (!isValidProfileName(name)) return c.json({ error: 'profile names use letters, digits, - and _ (max 41 chars)' }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { profile?: Record<string, unknown>; prompts?: Record<string, string>; activate?: boolean };
      let saved = saveProfile(ctx.dataDir, { ...(body.profile ?? {}), name } as Partial<ResearchProfile> & { name: string });
      // role prompts: only a text that differs from what the role currently runs with is written (built-ins stay built-in)
      let changed = false;
      const roles = saved.roles.map((role) => {
        const text = body.prompts?.[role.id];
        if (typeof text !== 'string') return role;
        const current = rolePromptText(ctx.dataDir, role);
        if (text.trim() === current.text.trim()) return role;
        changed = true;
        return { ...role, prompt: writeRolePrompt(ctx.dataDir, role, text) };
      });
      if (changed) saved = saveProfile(ctx.dataDir, { ...saved, roles });
      if (body.activate && ctx.config.research.profile !== name) {
        ctx.config.research.profile = name;
        saveConfig(ctx.dataDir, ctx.config);
      }
      return c.json(profileDetail(ctx.dataDir, saved));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/research/profiles/:name', (c) => {
    const ctx = requestCtx(c);
    const name = c.req.param('name');
    if (!isValidProfileName(name)) return c.json({ error: 'invalid profile name' }, 400);
    if ((ctx.config.research?.profile || 'default') === name && !BUILTIN_PROFILES[name]) return c.json({ error: 'select another profile before deleting the active one' }, 400);
    const removed = deleteProfile(ctx.dataDir, name);
    if (!removed) return c.json({ error: 'no such profile' }, 404);
    // a built-in comes back as its default on the next load (delete = reset)
    return c.json({ ok: true, reset: Boolean(BUILTIN_PROFILES[name]) });
  });

  app.get('/api/research/templates', (c) => {
    const ctx = requestCtx(c);
    return c.json([...loadResearchTemplates(ctx.dataDir).values()].map((t) => ({ name: t.name, kind: t.kind, output: t.output, maxTurns: t.maxTurns, requires: t.requires, path: t.path })));
  });

  app.get('/api/research/pages', async (c) => {
    const ctx = requestCtx(c);
    const jobs = await listJobs(ctx.store, { status: 'done', limit: 200 });
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!job.outputPath || seen.has(job.outputPath)) continue;
      seen.add(job.outputPath);
      let exists = false;
      try {
        exists = fs.existsSync(safePath(ctx.dataDir, job.outputPath));
      } catch {
        exists = false;
      }
      const [scope] = await ctx.store.query<{ trust: string; actor: string; applied_at: string }>(
        `SELECT trust, actor, applied_at FROM scopes WHERE kind = 'doc' AND key = $1 AND status = 'active' ORDER BY applied_at DESC LIMIT 1`,
        [job.outputPath],
      );
      out.push({ path: job.outputPath, exists, job: job.id, kind: job.kind, target: job.target ?? job.query, agent: job.agent, finishedAt: job.finishedAt, trust: scope?.trust ?? null, warnings: Array.isArray(job.payload.warnings) ? job.payload.warnings : [] });
    }
    return c.json(out);
  });

  // One job, with what the run directory knows while it is still running: phases so far, the plan (and an
  // init job's topics), and — on request — the tail of one session's transcript (`log=1` = the main one,
  // `log=<label>` = transcript-<label>.jsonl of a team phase).
  app.get('/api/research/jobs/:id', async (c) => {
    const ctx = requestCtx(c);
    const job = await getJob(ctx.store, c.req.param('id'));
    if (!job) return c.json({ error: 'no such job' }, 404);
    const runDir = path.join(runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs'), job.id);
    const readJson = (name: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
      } catch {
        return null;
      }
    };
    let log: string | null = null;
    const wanted = c.req.query('log');
    if (wanted) {
      const label = wanted === '1' || wanted === 'agent' ? '' : /^[a-z0-9-]{1,40}$/i.test(wanted) ? wanted : null;
      if (label === null) return c.json({ error: 'log must be 1 or a phase label (letters, digits, -)' }, 400);
      const file = path.join(runDir, label ? `transcript-${label}.jsonl` : 'transcript.jsonl');
      if (fs.existsSync(file)) log = fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n');
    }
    const phases = Array.isArray(job.payload.phases) ? job.payload.phases : readJson('phases.json');
    const plan = readJson('plan.json');
    const transcripts = fs.existsSync(runDir)
      ? fs.readdirSync(runDir).filter((f) => /^transcript(-.+)?\.jsonl$/.test(f)).map((f) => f.replace(/^transcript-?/, '').replace(/\.jsonl$/, '') || 'agent').sort()
      : [];
    return c.json({ ...job, log, phases: phases ?? [], plan, steps: Array.isArray(job.payload.steps) ? job.payload.steps : [], transcripts });
  });

  // cancel flips the row and kills the job's running sessions in this process
  app.post('/api/research/jobs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const cancelled = await cancelJob(requestCtx(c).store, id);
    return c.json({ cancelled, killed: cancelled ? killAgentsFor(id) : 0 });
  });

  app.post('/api/research/jobs/:id/retry', async (c) => {
    const ctx = requestCtx(c);
    const job = await retryJob(ctx.store, c.req.param('id'));
    if (job) servicesFor(ctx)?.kickResearch();
    return job ? c.json(job) : c.json({ error: 'job is not in a retryable state' }, 400);
  });

  // a job waiting out a pause (a spent usage limit, docs/design/22) runs now
  app.post('/api/research/jobs/:id/resume', async (c) => {
    const ctx = requestCtx(c);
    const job = await resumeJob(ctx.store, c.req.param('id'));
    if (job) servicesFor(ctx)?.kickResearch();
    return job ? c.json(job) : c.json({ error: 'job is not paused' }, 400);
  });

  // a finished job leaves the lists, and comes back; a study's page goes with its study
  for (const [action, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/api/research/jobs/:id/${action}`, async (c) => {
      const ctx = requestCtx(c);
      const job = await getJob(ctx.store, c.req.param('id'));
      if (!job) return c.json({ error: 'no such job' }, 404);
      if (job.kind === 'study' || typeof job.payload.study === 'string') return c.json({ error: `a study and its pages are ${action}d together: use /api/research/studies/<id>/${action}` }, 400);
      const [done] = await archiveJobs(ctx.store, [job.id], archived);
      return done ? c.json(await getJob(ctx.store, done)) : c.json({ error: `a ${job.status} job is not ${action}d — only a finished one` }, 400);
    });
  }

  // a job that failed or was cancelled goes, with its run directory; the page it wrote, if any, stays
  app.delete('/api/research/jobs/:id', async (c) => {
    const ctx = requestCtx(c);
    const job = await getJob(ctx.store, c.req.param('id'));
    if (!job) return c.json({ error: 'no such job' }, 404);
    if (job.kind === 'study' || typeof job.payload.study === 'string') return c.json({ error: 'a study and its pages are removed together: DELETE /api/research/studies/<id>' }, 400);
    if (job.status !== 'failed' && job.status !== 'cancelled') return c.json({ error: `a ${job.status} job is not removed — only a failed or cancelled one (archive a finished one)` }, 400);
    const removed = await deleteJobs(ctx.store, [job.id]);
    fs.rmSync(path.join(runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs'), job.id), { recursive: true, force: true });
    return c.json({ removed });
  });

  /* ------------------------------ research studies ------------------------ */

  // A topic researched into several pages (docs/design/15). A study is a draft until started:
  // POST creates it and refines it once, refine / PUT edit it, start queues it.
  const studyOr404 = async (ctx: AppContext, id: string) => {
    const job = await getJob(ctx.store, id);
    return job && job.kind === 'study' ? job : null;
  };

  // the studies not archived, newest first (`archived=1`: only the archived ones)
  app.get('/api/research/studies', async (c) => {
    const ctx = requestCtx(c);
    const jobs = await listStudies(ctx, Math.min(200, Number(c.req.query('limit') ?? 50) || 50), { archived: c.req.query('archived') === '1' });
    return c.json(await Promise.all(jobs.map(async (j) => {
      const p = studyPayload(j);
      return {
        id: j.id, status: j.status, stage: p.stage, title: p.brief.title, slug: j.target, topic: p.topic.slice(0, 400),
        pages: p.brief.pages.length, children: p.children.length, runner: p.runner, web: p.sources.web,
        createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error, steps: p.steps,
        outputPath: j.outputPath,
        pause: await studyPause(ctx, j),
        archivedAt: typeof j.payload.archivedAt === 'string' ? new Date(j.payload.archivedAt).toISOString() : null,
      };
    })));
  });

  app.post('/api/research/studies', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ topic?: string; runner?: Record<string, unknown>; sources?: { web?: boolean; ids?: string[] }; language?: string; refine?: boolean }>();
      if (!body.topic?.trim()) return c.json({ error: 'topic is required' }, 400);
      // the refiner may be a CLI one-shot that takes minutes: the draft comes back now, the brief when it is in
      const track = servicesFor(ctx)?.track ?? (<T,>(p: Promise<T>) => p);
      const job = await createStudy(ctx, { topic: body.topic, runner: body.runner, sources: body.sources, language: body.language, refine: body.refine === false ? false : 'background', track, requestedBy: requestUser(c) ?? 'web' });
      return c.json({ ...(await studyView(ctx, job)), refining: refiningSince(job) }, 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/research/studies/:id', async (c) => {
    const ctx = requestCtx(c);
    const job = await studyOr404(ctx, c.req.param('id'));
    if (!job) return c.json({ error: 'no such study' }, 404);
    const view = await studyView(ctx, job);
    return c.json({ ...view, refining: refiningSince(job), startProblem: job.status === 'draft' ? startProblem(ctx, job) : null });
  });

  app.put('/api/research/studies/:id', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ brief?: unknown; runner?: Record<string, unknown>; sources?: { web?: boolean; ids?: string[] } }>();
      const job = await updateStudy(ctx, c.req.param('id'), { brief: body.brief as never, runner: body.runner, sources: body.sources });
      return c.json({ ...(await studyView(ctx, job)), startProblem: startProblem(ctx, job) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/research/studies/:id/refine', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ feedback?: string; answers?: Record<string, string>; brief?: unknown; runner?: Record<string, unknown>; sources?: { web?: boolean; ids?: string[] } }>().catch(() => ({} as Record<string, never>));
      const track = servicesFor(ctx)?.track ?? (<T,>(p: Promise<T>) => p);
      const job = await refineStudyInBackground(ctx, c.req.param('id'), { feedback: body.feedback, answers: body.answers, brief: body.brief as never, runner: body.runner, sources: body.sources }, track);
      return c.json({ ...(await studyView(ctx, job)), refining: refiningSince(job), startProblem: startProblem(ctx, job) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/research/studies/:id/start', async (c) => {
    const ctx = requestCtx(c);
    try {
      const job = await startStudy(ctx, c.req.param('id'));
      servicesFor(ctx)?.kickResearch();
      return c.json(await studyView(ctx, job));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // what the study would take once started, from the studies run here before (docs/design/18)
  app.get('/api/research/studies/:id/estimate', async (c) => {
    const ctx = requestCtx(c);
    const job = await getJob(ctx.store, c.req.param('id'));
    if (!job || job.kind !== 'study') return c.json({ error: 'no such study' }, 404);
    try {
      return c.json(await estimateStudy({ store: ctx.store, config: ctx.config, job, quota: quotaSources(ctx.config), showBalance: mayChangeSettings(c) }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/research/studies/:id/cancel', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await cancelStudy(ctx, c.req.param('id')));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // a failed study goes back in line at the stage it failed in; its failed pages are retried with it
  app.post('/api/research/studies/:id/retry', async (c) => {
    const ctx = requestCtx(c);
    const job = await studyOr404(ctx, c.req.param('id'));
    if (!job) return c.json({ error: 'no such study' }, 404);
    if (!['failed', 'cancelled'].includes(job.status)) return c.json({ error: `a ${job.status} study is not retried` }, 400);
    const retried = await retryStudy(ctx, job);
    servicesFor(ctx)?.kickResearch();
    return c.json(await studyView(ctx, retried));
  });

  // a paused study (its collect, its report, or its pages) runs now instead of when its pause ends
  app.post('/api/research/studies/:id/resume', async (c) => {
    const ctx = requestCtx(c);
    const job = await studyOr404(ctx, c.req.param('id'));
    if (!job) return c.json({ error: 'no such study' }, 404);
    const { resumed } = await resumeStudy(ctx, job);
    if (resumed === 0) return c.json({ error: 'nothing in this study is paused' }, 400);
    servicesFor(ctx)?.kickResearch();
    return c.json({ ...(await studyView(ctx, (await getJob(ctx.store, job.id))!)), resumed });
  });

  // a finished study leaves the list with its pages' jobs, and keeps everything (unarchive brings it back)
  for (const [action, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/api/research/studies/:id/${action}`, async (c) => {
      const ctx = requestCtx(c);
      const job = await studyOr404(ctx, c.req.param('id'));
      if (!job) return c.json({ error: 'no such study' }, 404);
      const next = await archiveStudy(ctx, job, archived);
      return next ? c.json(await studyView(ctx, next)) : c.json({ error: `a ${job.status} study is not ${action}d — cancel it first, or wait for it to finish` }, 400);
    });
  }

  // a draft, or a study that failed or was cancelled: its jobs and run logs go; what it wrote into the knowledge base stays
  app.delete('/api/research/studies/:id', async (c) => {
    const ctx = requestCtx(c);
    const removed = await removeStudy(ctx, c.req.param('id'));
    return removed ? c.json(removed) : c.json({ error: 'only a draft, or a study that failed or was cancelled, can be removed — archive a finished one, cancel a running one' }, 400);
  });

  // a person's review of what a study produced: its pages, and the sources it captured
  app.post('/api/research/studies/:id/promote', async (c) => {
    const ctx = requestCtx(c);
    const job = await studyOr404(ctx, c.req.param('id'));
    if (!job) return c.json({ error: 'no such study' }, 404);
    const body = await c.req.json<{ what?: StudyFiles; to?: TrustTier }>().catch(() => ({} as { what?: StudyFiles; to?: TrustTier }));
    const what = body.what ?? 'pages';
    const to = body.to ?? 'trusted';
    if (!['pages', 'sources', 'all'].includes(what)) return c.json({ error: 'what must be pages, sources or all' }, 400);
    if (!TRUST_TIERS.includes(to)) return c.json({ error: `to must be ${TRUST_TIERS.join(' or ')}` }, 400);
    const promotion = await promoteStudy(ctx, job, { what, to, actor: requestUser(c) });
    // count is what changed (clients before `changed` read it)
    return c.json({ what, ...promotion, count: promotion.changed.length });
  });

  // the tail of one session of a study: collect-<n> (gathering) or the report's transcript
  app.get('/api/research/studies/:id/log', async (c) => {
    const ctx = requestCtx(c);
    const job = await studyOr404(ctx, c.req.param('id'));
    if (!job) return c.json({ error: 'no such study' }, 404);
    const label = c.req.query('label') ?? '';
    if (!/^[a-z0-9-]{1,40}$/i.test(label)) return c.json({ error: 'label must be letters, digits and -' }, 400);
    const root = runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs');
    const file = label.startsWith('collect')
      ? path.join(root, `${job.id}-collect`, `transcript-${label}.jsonl`)
      : path.join(root, job.id, label === 'agent' ? 'transcript.jsonl' : `transcript-${label}.jsonl`);
    const log = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n') : null;
    const collectDir = path.join(root, `${job.id}-collect`);
    const labels = fs.existsSync(collectDir) ? fs.readdirSync(collectDir).filter((f) => /^transcript-.+\.jsonl$/.test(f)).map((f) => f.replace(/^transcript-|\.jsonl$/g, '')).sort() : [];
    return c.json({ label, log, labels });
  });

  // the study as one HTML file to read, save or print: the report, then the pages (src/research/export.ts)
  app.get('/api/research/studies/:id/export', async (c) => {
    const ctx = requestCtx(c);
    const job = await studyOr404(ctx, c.req.param('id'));
    if (!job) return c.json({ error: 'no such study' }, 404);
    try {
      const { html, filename } = await exportStudy(ctx, job);
      const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
      return c.body(html, 200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        // what agents wrote, as a page of its own: a sandbox (a unique origin, no script), styles inline, pictures from the web
        'content-security-policy': `sandbox allow-popups allow-popups-to-escape-sandbox; ${EXPORT_POLICY}; frame-ancestors 'none'`,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, no-cache',
      });
    } catch (e) {
      return c.json(err(e), e instanceof StudyExportError ? e.status : 500);
    }
  });

  // a person saves a web page or file into the knowledge base (into a study, or on its own)
  app.post('/api/research/capture', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ url?: string; study?: string; why?: string }>();
      if (!body.url?.trim()) return c.json({ error: 'url is required' }, 400);
      let study: { id: string; slug: string; title?: string } | null = null;
      if (body.study) {
        const job = await studyOr404(ctx, body.study);
        if (!job) return c.json({ error: 'no such study' }, 404);
        study = { id: job.id, slug: job.target ?? job.id, title: studyPayload(job).brief.title };
      }
      return c.json(await captureUrl(ctx, { url: body.url, study, why: body.why, actor: requestUser(c) ?? 'web', index: 'background' }), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/research/captures', async (c) => {
    const ctx = requestCtx(c);
    const entries = readManifest(ctx.dataDir).entries;
    return c.json(entries.slice(-500).reverse());
  });

  // what a study may use: the research sources, knode's own web search, the workspace's web switch
  app.get('/api/research/sources', (c) => {
    const ctx = requestCtx(c);
    const sources = loadResearchSources(ctx.dataDir).map((s) => ({ ...redactSource(s), problem: sourceProblem(s, ctx.config) }));
    return c.json({
      sources,
      kinds: RESEARCH_SOURCE_KINDS,
      datasources: ctx.config.datasources.map((d) => ({ id: d.id, kind: d.kind, description: d.description ?? '' })),
      web: {
        gate: ctx.config.review?.external ?? 'verify',
        search: { provider: ctx.config.research.web.search.provider, enabled: webSearchEnabled(ctx.config.research.web), providers: WEB_SEARCH_PROVIDERS },
        proxy: ctx.config.research.web.proxy ? 'configured' : (process.env.HTTPS_PROXY || process.env.https_proxy ? 'environment' : 'none'),
        userAgent: ctx.config.research.web.userAgent,
      },
      connections: llmTargets(ctx.config).filter((t) => t.baseUrl && !isCliProvider(t.provider)).map((t) => ({ id: t.id, label: t.label, model: t.model })),
    });
  });

  app.put('/api/research/sources/:id', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const saved = saveResearchSource(ctx.dataDir, { ...body, id: c.req.param('id') }, ctx.config);
      return c.json({ ...redactSource(saved), problem: sourceProblem(saved, ctx.config) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/research/sources/:id', (c) => {
    const ctx = requestCtx(c);
    return deleteResearchSource(ctx.dataDir, c.req.param('id')) ? c.json({ removed: true }) : c.json({ error: 'no such source' }, 404);
  });

  /* ------------------------------ chat ------------------------------------ */

  /**
   * Whether a question typed now would be answered, and if not, what to fix.
   * The send path returns the same `reason` values, so a race that slips past
   * this check lands on the same screen rather than a toast.
   */
  app.get('/api/chat/readiness', async (c) => {
    const ctx = requestCtx(c);
    if (!(servicesFor(ctx)?.mcp() ?? null)) return c.json({ ready: false, reason: 'no-mcp', hint: NO_MCP_HINT });
    const agent = resolveChatAgent(ctx.config, ctx.dataDir);
    if (!agent) return c.json({ ready: false, reason: 'no-agent', hint: NO_AGENT_HINT });
    // a packaged build may have been pruned of the built-in agent's packages;
    // saying so here beats looking ready and failing every turn
    if (agent.kind === 'builtin' && !(await builtinAvailable())) {
      return c.json({ ready: false, reason: 'no-builtin', hint: NO_BUILTIN_HINT });
    }
    return c.json({ ready: true, provider: agent.provider, model: agent.model });
  });

  app.get('/api/chat/conversations', async (c) => {
    const ctx = requestCtx(c);
    const limit = Number(c.req.query('limit'));
    return c.json(await listConversations(ctx.store, { limit: Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : undefined }));
  });

  app.post('/api/chat/conversations', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { title?: string };
      const scope = c.get('workspaceScope');
      return c.json(await createConversation(ctx.store, { title: body.title, createdBy: scope?.user ?? null }), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/chat/conversations/:id', async (c) => {
    const ctx = requestCtx(c);
    const conversation = await getConversation(ctx.store, c.req.param('id'), { messages: true });
    if (!conversation) return c.json({ error: 'no such conversation' }, 404);
    return c.json({ ...conversation, running: isChatRunning(ctx, conversation.id) });
  });

  /**
   * A message starts an agent session in the background: 202 with the user
   * message's seq, then poll /status until idle. Both gates answer 503 with a
   * `reason` the client turns into a screen that says what to configure — a
   * question typed into a box deserves better than a toast.
   */
  app.post('/api/chat/conversations/:id/messages', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    try {
      const body = (await c.req.json().catch(() => ({}))) as { text?: string };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return c.json({ error: 'text is required' }, 400);
      if (!(await getConversation(ctx.store, id))) return c.json({ error: 'no such conversation' }, 404);
      const services = servicesFor(ctx);
      const mcp = services?.mcp() ?? null;
      if (!mcp) return c.json({ error: NO_MCP_HINT, reason: 'no-mcp' }, 503);
      if (!resolveChatAgent(ctx.config, ctx.dataDir)) return c.json({ error: NO_AGENT_HINT, reason: 'no-agent' }, 503);
      const { seq, turn } = await startChatTurn(ctx, id, text, { mcp, log });
      const tracked = services ? services.track(turn) : turn;
      tracked.catch((e) => log(`chat ${id}: turn failed: ${e instanceof Error ? e.message : e}`));
      return c.json({ ok: true, seq, status: 'running' }, 202);
    } catch (e) {
      if (e instanceof ChatBusyError) return c.json({ error: e.message }, 409);
      return c.json(err(e), 400);
    }
  });

  app.get('/api/chat/conversations/:id/status', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    const conversation = await getConversation(ctx.store, id);
    if (!conversation) return c.json({ error: 'no such conversation' }, 404);
    const activity = chatActivity(ctx, id);
    // the row says running until the turn's message lands; the in-process registry is the truth in this process
    return c.json({ ...activity, status: activity.status === 'running' ? 'running' : conversation.status === 'running' && activity.status === 'idle' && !isChatRunning(ctx, id) ? 'idle' : activity.status, updatedAt: conversation.updatedAt });
  });

  app.post('/api/chat/conversations/:id/cancel', (c) => {
    const ctx = requestCtx(c);
    return c.json({ cancelled: cancelChatTurn(ctx, c.req.param('id')) });
  });

  app.delete('/api/chat/conversations/:id', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    if (isChatRunning(ctx, id)) return c.json({ error: 'the conversation is answering — cancel it first' }, 409);
    const removed = await deleteConversation(ctx.store, id);
    if (!removed) return c.json({ error: 'no such conversation' }, 404);
    removeChatWorkspace(ctx, id);
    return c.json({ ok: true });
  });

  app.get('/api/chat/protocol', (c) => {
    const ctx = requestCtx(c);
    return c.json({ path: `${CHAT_DIR}/${CHAT_PROTOCOL_FILE}`, text: loadChatProtocol(ctx.dataDir) });
  });

  app.put('/api/chat/protocol', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { text?: string };
      if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'text is required' }, 400);
      return c.json({ path: saveChatProtocol(ctx.dataDir, body.text), text: loadChatProtocol(ctx.dataDir) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ------------------------------ playbooks ----------------------------- */

  // playbooks/ for Settings, which edits what the file tree no longer shows (src/fs/playbooks.ts)
  app.get('/api/playbooks', (c) => c.json({ groups: listPlaybooks(requestCtx(c).dataDir) }));

  app.get('/api/playbooks/file', (c) => {
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    try {
      return c.json(readPlaybook(requestCtx(c).dataDir, p));
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.put('/api/playbooks/file', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { path?: string; text?: string };
      if (!body.path || typeof body.text !== 'string') return c.json({ error: 'path and text required' }, 400);
      return c.json(savePlaybook(requestCtx(c).dataDir, body.path, body.text));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // a delete is a reset: the built-in version goes back in place of the edited one
  app.delete('/api/playbooks/file', (c) => {
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    try {
      return c.json(resetPlaybook(requestCtx(c).dataDir, p));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // Tasks → Queue: the document pipeline, the calls out now and who holds them, the workers, jobs and what runs on a clock
  app.get('/api/tasks', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await tasksSnapshot(ctx, servicesFor(ctx)));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // the labeling scheduler, the summary and judge sources and this machine's worker slots, for the UI;
  // `scheduler.workers` lists every worker the broker saw, whatever it took
  app.get('/api/labeling/status', async (c) => {
    const ctx = requestCtx(c);
    const services = servicesFor(ctx);
    if (!services?.labeling) return c.json({ error: 'labeling runs only inside `knode-os serve`' }, 503);
    const scheduler = await services.labeling.status();
    const work = services.work ? await services.work.status() : null;
    return c.json({
      processing: services.processing?.state() ?? null,
      scheduler: work ? { ...scheduler, workers: work.workers } : scheduler,
      summaries: work?.kinds.summarize ?? null,
      judge: work?.kinds.judge ?? null,
      translations: work?.kinds.translate ?? null,
      shares: work?.shares ?? null,
      local: services.localWorkers?.status() ?? [],
    });
  });

  // processing spends model calls, so it runs only when someone starts it
  const switchProcessing = (on: boolean) => async (c: Context<AppEnv>) => {
    const ctx = requestCtx(c);
    const processing = servicesFor(ctx)?.processing;
    if (!processing) return c.json({ error: 'processing runs only inside `knode-os serve`' }, 503);
    const by = c.get('account')?.username ?? c.req.header('x-knode-user') ?? 'local';
    const changed = on ? processing.start(by) : processing.stop(by);
    return c.json({ ok: true, changed, processing: processing.state() });
  };
  app.post('/api/labeling/start', switchProcessing(true));
  app.post('/api/labeling/stop', switchProcessing(false));

  /* ------------------------------ estimates ------------------------------ */

  const ledgerOf = (ctx: AppContext) => servicesFor(ctx)?.calls ?? CallLedger.forWorkspace(ctx.dataDir);

  // what starting the processing would take — calls, tokens, time, transfer, cost, and each plan's share (docs/design/18)
  app.get('/api/labeling/estimate', async (c) => {
    const ctx = requestCtx(c);
    try {
      const work = servicesFor(ctx)?.work;
      return c.json(await estimateProcessing({
        store: ctx.store,
        config: ctx.config,
        ledger: ledgerOf(ctx),
        workers: work ? (await work.status()).workers : [],
        quota: quotaSources(ctx.config),
        showBalance: mayChangeSettings(c),
      }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // the plans themselves: Codex's windows and credits as Codex reports them, Cursor's tier, and the calls measured here
  app.get('/api/usage', async (c) => {
    const ctx = requestCtx(c);
    try {
      const quota = quotaSources(ctx.config);
      const [codex, cursorPlan] = await Promise.all([quota.codex(), quota.cursorPlan()]);
      return c.json({
        codex: codex ? { account: codex.account, calibration: codex.calibration && { rates: codex.calibration.rates, weightPerToken: codex.calibration.weightPerToken }, error: codex.error } : null,
        cursor: { plan: cursorPlan },
        calls: ledgerOf(ctx).stats().map(({ ms: _samples, ...s }) => s),
      });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/dream', async (c) => {
    const ctx = requestCtx(c);
    try {
      const res = await activityOf(ctx.dataDir).run('dream', 'Dream over recent agent traces', () => runDream(ctx.store, ctx.config, ctx.llm, { onProgress: log }), (r) => `${r.suggestions.length} suggestions`);
      return c.json(res);
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* ------------------------------ static UI ----------------------------- */

  const webDir = findWebDir();
  // the reader another app may frame, before the UI's catch-all, which must never answer under /embed
  mountEmbed(app, { webDir, allowedOrigins: embedAllowed });
  const markedJs = findMarkedUmd();
  app.get('/vendor/marked.js', (c) => {
    if (!markedJs) return c.text('window.marked=null;', 200, { 'content-type': 'text/javascript' });
    return c.text(fs.readFileSync(markedJs, 'utf8'), 200, { 'content-type': 'text/javascript' });
  });
  // the graph view's layout, zoom and drag (web/graph.js); without it the view says so instead of breaking
  const d3Js = findD3Umd();
  app.get('/vendor/d3.js', (c) => {
    if (!d3Js) return c.text('window.d3=null;', 200, { 'content-type': 'text/javascript' });
    return c.text(fs.readFileSync(d3Js, 'utf8'), 200, { 'content-type': 'text/javascript' });
  });
  app.get('/*', (c) => {
    if (!webDir) return c.text('web UI assets not found', 404);
    let rel = c.req.path.replace(/^\/+/, '') || 'index.html';
    if (!fs.existsSync(path.join(webDir, rel)) || fs.statSync(path.join(webDir, rel)).isDirectory()) rel = 'index.html';
    const abs = path.resolve(webDir, rel);
    if (!abs.startsWith(path.resolve(webDir))) return c.text('forbidden', 403);
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    };
    const ct = types[path.extname(abs)] ?? 'application/octet-stream';
    // with sign-in off nothing else hardens the UI, so its files carry the policy themselves
    return c.body(fs.readFileSync(abs), 200, {
      'content-type': ct,
      'content-security-policy': contentSecurityPolicy(ct),
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
    });
  });

  return app;
}

/** d3's browser bundle: the package exports only its ES entry, and `dist/` sits beside that entry's `src/`. */
function findD3Umd(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('d3'); // .../d3/src/index.js
    const p = path.resolve(path.dirname(entry), '..', 'dist', 'd3.min.js');
    if (fs.existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}
