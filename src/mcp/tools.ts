import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppContext } from '../context.js';
import { runSourceQuery } from '../datasource/execute.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { assertNotPrivate, assertSourcePath, assertWritablePath, cleanRelPath, grepAnswer, listTree, safePath, writeFileText } from '../fs/files.js';
import { recordOrigin } from '../fs/sidecar.js';
import { assertNotConvertedOriginal, readSourceTextCapped } from '../ingest/source.js';
import { assertNotLinked } from '../ingest/folders.js';
import { graphInsights, graphSearch } from '../graph/query.js';
import { sync } from '../ingest/sync.js';
import { historyOf, lineageOf } from '../lineage/inspect.js';
import { forgetSource } from '../lineage/purge.js';
import { buildContextPack } from '../pack/pack.js';
import { search } from '../search/search.js';
import { ask } from '../search/ask.js';
import { planOnly, resolve } from '../compiler/resolve.js';
import { liveAbsences } from '../compiler/absence.js';
import { distillRecipes } from '../compiler/distill.js';
import { evaluatePacks } from '../compiler/evaluate.js';
import { writeRankerReport } from '../compiler/ranker.js';
import { changesSince, listSubscriptions, subscribe, unsubscribe } from '../compiler/subscribe.js';
import { checkout, commitWorkset, envelopeFor, listWorksets } from '../compiler/workset.js';
import { listDisputes, resolveDispute, setScopeTrust } from '../lineage/trust.js';
import { recordFeedback } from '../compiler/receipts.js';
import { isVirtualPath, readVirtual } from '../compiler/vfs.js';
import { renderCapabilityDts } from '../capability/dts.js';
import { listCapabilities, locatorsForEntities } from '../capability/store.js';
import { claimQueryFromArgs, queryClaims } from '../store/claims.js';
import { CATALOG_SOURCE, CATALOG_VIEWS, catalogQuery, OPTIONAL_CATALOG_VIEWS } from '../store/catalog.js';
import { tableFactsEnabled, tableMatrix } from '../tables/store.js';
import { resolveScopeFilter, resolveTemporal, SOURCE_KINDS } from '../store/resolver.js';
import { listDatasets, listSuggestions } from '../store/queries.js';
import { validateOkfBundle } from '../okf/index.js';
import { cancelJob, getJob, listJobs, queueJob } from '../research/jobs.js';
import { killAgentsFor } from '../research/launch.js';
import { surveyKnowledgeBase } from '../research/survey.js';
import { loadResearchTemplates, RESEARCH_KINDS, ResearchKind } from '../research/templates.js';
import { captureUrl, fetchReadable } from '../research/capture.js';
import { chartBlock, parseChart } from '../research/chart.js';
import { callApiSource, loadResearchSource } from '../research/sources.js';
import { createStudy, listStudies, startStudy, studyAgent, studyView, refineStudy } from '../research/study.js';
import { webSearch, webSearchEnabled } from '../research/web.js';
import { readSection } from '../research/read.js';
import { grepAcross, grepWithContext, READ_BUDGET, READ_BUDGET_MAX, READ_PATHS_MAX, readMany } from './batch.js';
import { catalogGuide } from './catalog-guide.js';
import { loadFeed } from '../ingest/feeds/definitions.js';
import { pushToFeed } from '../ingest/feeds/run.js';
import { describeFeeds } from '../ingest/feeds/runner.js';

/** Who wrote what an MCP client writes: an agent's text, quarantined until a person promotes it (src/lineage/trust.ts). */
export const MCP_WRITER = 'mcp';

export interface KnodeToolOptions {
  /**
   * Who is on the other end. `agent`: a research or Ask run this server
   * launched for a workspace (its token is that workspace's,
   * src/server/mcp-http.ts) — it may not promote a source or settle a
   * dispute, which is the review its own writes wait for. `owner` (the
   * default): this machine's own MCP clients, a person at the keyboard.
   */
  caller?: 'owner' | 'agent';
  /** Register only these tools (a remote research session's set, docs/design/27). */
  only?: ReadonlySet<string>;
  /** Checked before a tool runs, with its arguments: throws to refuse (a remote session's writes, bound to its job). */
  guard?: (tool: string, args: Record<string, unknown>) => void;
  /**
   * false: reading leaves no trace — searches record no hits (the heat that
   * feeds ranking) and resolve, plan and context calls write no receipt or
   * pack event. An evaluation's agent sets it, so every question sees the
   * index as built (docs/design/31 D3). Default true.
   */
  track?: boolean;
}

/** The tool surface narrowed to `only`, each handler behind `guard`; the server itself when neither is given. */
function narrowed(target: McpServer, opts: KnodeToolOptions): McpServer {
  if (!opts.only && !opts.guard) return target;
  const { only, guard } = opts;
  const registerTool = (name: string, config: unknown, handler: (args: Record<string, unknown>, extra: unknown) => unknown) => {
    if (only && !only.has(name)) return undefined;
    const guarded = guard
      ? (args: Record<string, unknown>, extra: unknown) => {
        guard(name, args ?? {});
        return handler(args, extra);
      }
      : handler;
    return (target.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(name, config, guarded);
  };
  return { registerTool } as unknown as McpServer;
}

/**
 * The knode-os tool surface, independent of transport. The stdio server
 * (`knode-os mcp`) and the Streamable HTTP endpoint `serve` mounts at /mcp
 * both register exactly this set, so an agent sees the same tools whichever
 * way it connects.
 */
export function registerKnodeTools(target: McpServer, ctx: AppContext, opts: KnodeToolOptions = {}): void {
  const server = narrowed(target, opts);
  const agent = opts.caller === 'agent';
  const track = opts.track !== false;
  const tableFacts = ctx.config ? tableFactsEnabled(ctx.config) : false;
  // what a read writes beside its answer when reads are not tracked: nothing
  const quiet = track ? {} : ({ track: false, record: false } as const);
  const forPerson = (what: string) => new Error(`${what} is a person's review, not an agent's: ask them to do it in knode-os (the source's "adopt" in the UI, or \`knode-os trust\`)`);
  const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
  const asOfSchema = z.string().optional().describe('System time (ISO 8601): answer from what the knowledge base contained at that instant');
  const validAtSchema = z.string().optional().describe('World time (ISO 8601): only claims whose validity window contains this instant');
  const validRangeSchema = z.string().optional().describe('World time window instead of an instant: "2026-01-01..2026-06-30", "2026-08" (that month), "2026" (that year), or "2026-03-01.." (open ended). Mutually exclusive with valid_at.');
  const kindsSchema = z.array(z.enum(SOURCE_KINDS)).optional()
    .describe('Restrict to source kinds: doc = raw/docs, wiki = human-written wiki prose, view = generated wiki page, skill = raw/skills, trace = raw/traces (only present when trace.episodes is on), code = raw/codebase (code repositories: source files cut along their definitions, each chunk headed by its file)');
  const sourcesSchema = z.array(z.string()).optional()
    .describe('Restrict to path prefixes, e.g. ["raw/docs/reports"]');
  const freshnessSchema = z.string().optional().describe('Max age of live/federated reads: "30s", "15m", "2h", "7d". Cached probe answers older than this are re-run.');
  const actorSchema = z.string().optional().describe('Who is asking — restricted sources answer only to actors named on their ACL');
  const trustSchema = z.enum(['trusted', 'quarantined', 'any']).optional()
    .describe('Trust tier: agent writes land quarantined until promoted. Default any — pass "trusted" to exclude unreviewed agent writes.');

  server.registerTool(
    'knode_search',
    {
      title: 'Search the knowledge base',
      description: 'Passages: search docs, wiki and skills by meaning and words. Not for lists, counts, timelines or who-did-what (knode_claims / knode_query answer those in one call) nor exact strings and IDs (grep). A hit whose claim was replaced carries `current`: the claim that holds now. Mode sag adds query-time chunk/entity multi-hop expansion with retrieval traces. as_of restricts to documents that were live at that system time; kinds/sources restrict which sources may answer (the sag expansion honours them too, so a scoped walk cannot escape through a shared entity).',
      inputSchema: {
        query: z.string().describe('Natural-language or keyword query'),
        k: z.number().int().min(1).max(50).optional().describe('Max results (default 8)'),
        mode: z.enum(['hybrid', 'vector', 'keyword', 'sag']).optional(),
        as_of: asOfSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
        actor: actorSchema,
      },
    },
    async ({ query, k, mode, as_of, kinds, sources, trust, actor }) => {
      const results = await search(ctx.store, ctx.embedder, query, {
        k: k ?? 8,
        mode: mode ?? 'hybrid',
        heat: ctx.config.heat,
        sag: ctx.config.retrieval.sag,
        rerank: ctx.config.retrieval.rerank,
        asOf: as_of,
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
        track,
      });
      const answer = json(results.map((r) => ({
        path: r.path,
        title: r.title,
        score: +r.score.toFixed(4),
        signals: r.signals,
        trace: r.trace,
        // a claim this passage states was replaced: what holds now
        current: r.current,
        content: r.content,
      })));
      // The semantic channel stopped short of what it was asked for (a folder too large to read, lying
      // further than the index is walked): said in a block of its own after the results, which stay the
      // array they were. Without it "few results" or "none" reads as "nothing there".
      if (results.partial) answer.content.push({ type: 'text' as const, text: JSON.stringify({ partial: results.partial }, null, 2) });
      return answer;
    },
  );

  server.registerTool(
    'knode_graph_search',
    {
      title: 'Search the knowledge graph',
      description: 'Find entities matching the query and expand the graph around them (multi-hop). Returns nodes, typed edges (with their validity window when known), grounding chunks and claims. as_of recomputes nodes/edges from evidence at that system time; valid_at / valid_range filter claims and time-bound edges by world time; kinds/sources restrict which sources may support a node or edge.',
      inputSchema: {
        query: z.string(),
        depth: z.number().int().min(1).max(4).optional().describe('Expansion hops (default 2)'),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
        actor: actorSchema,
      },
    },
    async ({ query, depth, as_of, valid_at, valid_range, kinds, sources, trust, actor }) =>
      json(await graphSearch(ctx.store, query, {
        depth: depth ?? 2,
        heat: ctx.config.heat,
        temporal: resolveTemporal({ asOf: as_of, validAt: valid_at, validRange: valid_range }),
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
        track,
      })),
  );

  server.registerTool(
    'knode_ask',
    {
      title: 'Ask the knowledge base',
      description: 'RAG answer with [n] citations and explicit gaps, written by the Judge pipeline stage (extraction.judgeLlm). Routed by the kind of question: a lookup answers from the best passages; a list, count or timeline from every claim about what it names (enumerated, with counts); a multi-hop question from a walk over relations. `route` says which. When that stage has no model, returns the retrieved context instead.',
      inputSchema: {
        question: z.string(),
        mode: z.enum(['hybrid', 'vector', 'keyword', 'sag']).optional().describe('Retrieval mode (default hybrid)'),
      },
    },
    async ({ question, mode }) => {
      const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question, { mode: mode ?? 'hybrid', track });
      return json({ answer: res.answer, citations: res.citations, gaps: res.gaps, route: res.route });
    },
  );

  server.registerTool(
    'knode_ls',
    {
      title: 'List knowledge files',
      description: 'List the data directory tree (raw/docs, raw/codebase, raw/traces, raw/skills, wiki, playbooks, ledger).',
      inputSchema: { path: z.string().optional().describe('Subdirectory, e.g. "wiki" (default: root)') },
    },
    async ({ path: p }) => json(listTree(ctx.dataDir, p ?? '.')),
  );

  const sliceShape = {
    section: z.string().optional().describe('A heading of the document: its section is returned, up to the next heading of the same or a higher level'),
    offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Lines to return (default 400 when offset is given)'),
    outline: z.boolean().optional().describe('Return only the headings, with line numbers'),
  };
  server.registerTool(
    'knode_read',
    {
      title: 'Read knowledge files',
      description: 'Read one file, or several in one call, by path relative to the data directory, e.g. "wiki/index.md". Several files: `paths` takes up to 20 entries, each a path or {path, section?, offset?, limit?, outline?}; they share one budget of `max_chars` characters (default 60000): short files come whole, long ones split the rest and say where to read on. Read every document you need in one call rather than one call each. A PDF, web page (HTML) or image under raw/docs returns the Markdown knode-os derived from it. A long document (a prospectus, an annual report) reads in parts: `section` returns one heading\'s section (a heading\'s text, as the capture outline or `outline: true` lists them), `offset` / `limit` a range of lines, `outline: true` only the headings with their line numbers. A path starting with "/" reads the virtual filesystem instead — /entities/<id>.md, /claims/<subject>.md, /capabilities/<source>/<name>.md, /live/<capability>?<param>=<value> — rendered on read, and every one of them accepts ?as_of=<iso>. Read "/" for the roots.',
      inputSchema: {
        path: z.string().optional().describe('One file (or use `paths` for several)'),
        ...sliceShape,
        paths: z.array(z.union([z.string(), z.object({ path: z.string(), ...sliceShape })])).min(1).max(READ_PATHS_MAX).optional()
          .describe('Several files in one call: each a path, or {path, section?, offset?, limit?, outline?}'),
        max_chars: z.number().int().min(1000).max(READ_BUDGET_MAX).optional().describe(`Characters returned at most over all of \`paths\` (default ${READ_BUDGET})`),
      },
    },
    async ({ path: p, section, offset, limit, outline, paths, max_chars }) => {
      if (paths?.length) {
        const requests = [
          ...(p ? [{ path: p, section, offset, limit, outline }] : []),
          ...paths.map((x) => (typeof x === 'string' ? { path: x } : x)),
        ].slice(0, READ_PATHS_MAX);
        return { content: [{ type: 'text' as const, text: await readMany(ctx, requests, max_chars ?? READ_BUDGET) }] };
      }
      if (!p) throw new Error('knode_read needs `path` or `paths`');
      if (isVirtualPath(p)) return { content: [{ type: 'text' as const, text: await readVirtual(ctx, p) }] };
      const file = readSourceTextCapped(ctx.dataDir, p, MAX_FILE_BYTES);
      if (!file) throw new Error(`no derived text for ${p} yet — run knode_sync first (a capture is indexed within seconds)`);
      if (section === undefined && offset === undefined && limit === undefined && !outline) return { content: [{ type: 'text' as const, text: file.content }] };
      return { content: [{ type: 'text' as const, text: readSection(file.content, { section, offset, limit, outline }) }] };
    },
  );

  server.registerTool(
    'knode_write',
    {
      title: 'Write a knowledge file',
      description: 'Create or overwrite a file under wiki/, raw/docs/ or playbooks/packs/, or the root AGENTS.md / CLAUDE.md knowledge-base guide (other roots are read-only). A source file is applied as a new scope on the next sync; the guide is never indexed.',
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path: p, content }) => {
      assertWritablePath(p);
      assertNotConvertedOriginal(p);
      assertNotLinked(ctx.config, p, 'write to');
      // on record before the bytes land, so no sync sees them unattributed: whatever
      // its frontmatter claims, this is an MCP client's text (src/fs/sidecar.ts)
      recordOrigin(ctx.dataDir, cleanRelPath(p), content, MCP_WRITER);
      writeFileText(ctx.dataDir, p, content);
      return json({ ok: true, path: p });
    },
  );

  server.registerTool(
    'knode_feeds',
    {
      title: 'List feeds',
      description: 'The feeds of this knowledge base (docs/design/26): sources that keep producing items — group chats, mailboxes, accounts, arXiv searches, repositories, RSS — with their connector, schedule, the folder they write in, and how their last run went. Feeds of connector "push" take items through knode_feed_push.',
      inputSchema: {},
    },
    async () => json(describeFeeds(ctx.dataDir).map((f) => ({ id: f.id, title: f.title, description: f.description, connector: f.connector, enabled: f.enabled, dest: f.dest, items: f.items, lastRunAt: f.state.lastRunAt ?? null, lastError: f.state.lastError ?? null }))),
  );

  server.registerTool(
    'knode_feed_push',
    {
      title: 'Push items into a feed',
      description: 'Hand items — a post, an article, a message, a link worth keeping — to a feed of connector "push". They go through the feed\'s filter and transform stages like pulled ones, and the kept ones are written into its documents. Each item: { id (stable; a URL works), title?, text (Markdown), url?, author?, publishedAt? (ISO 8601), tags? }. An agent may only push into a feed whose trust is "quarantine", so what it hands in waits for a person\'s review.',
      inputSchema: {
        feed: z.string().describe('The feed id (see knode_feeds)'),
        items: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
      },
    },
    async ({ feed: id, items }) => {
      const feed = loadFeed(ctx.dataDir, id);
      if (!feed) throw new Error(`no feed "${id}" — knode_feeds lists them`);
      if (feed.connector !== 'push') throw new Error(`feed ${id} pulls from ${feed.connector}; only feeds of connector "push" take items from MCP`);
      if (!feed.enabled) throw new Error(`feed ${id} is disabled`);
      if (agent && feed.trust !== 'quarantine') throw new Error(`feed ${id} writes trusted documents; an agent may push only into a feed with trust: quarantine`);
      const r = await pushToFeed(ctx, feed, items.map((i) => ({ ...i, meta: { ...((i.meta as Record<string, unknown>) ?? {}), pushedBy: agent ? 'agent' : MCP_WRITER } })));
      return json({ ok: true, pushed: r.pushed, changed: r.changed, kept: r.kept, dropped: r.dropped, pending: r.pending, decisions: r.decisions, documents: r.documents.map((d) => d.path) });
    },
  );

  server.registerTool(
    'knode_ingest',
    {
      title: 'Sync the knowledge base',
      description: 'Reconcile declared sources (docs/wiki/skills/datasources) with the index: apply changed files, dispose removed ones (reverting everything they produced), regenerate dependent wiki pages.',
      inputSchema: {},
    },
    async () => json(await sync(ctx)),
  );

  server.registerTool(
    'knode_sync',
    {
      title: 'Sync sources (scoped)',
      description: 'Same as knode_ingest but optionally restricted to path prefixes (e.g. ["raw/docs/reports"]) or "datasources"; verify=true recounts folds and repairs ledger/pages drift.',
      inputSchema: {
        only: z.array(z.string()).optional(),
        verify: z.boolean().optional(),
      },
    },
    async ({ only, verify }) => json(await sync(ctx, { only, verify })),
  );

  server.registerTool(
    'knode_lineage',
    {
      title: 'Lineage of a graph row or page',
      description: 'Why does the knowledge base believe this? Lists every live and historical evidence row (source scope, extractor, weight, system-time window) behind an entity/relation/claim, the inputs a page was built from, or the scope history of a document — with the wiki pages citing it (citedBy: cites / derived_from / tested_by …) and the raw/docs files it cites.',
      inputSchema: {
        kind: z.enum(['entity', 'relation', 'claim', 'page', 'document']),
        id: z.string().describe('Entity slug, relation/claim id, page path (wiki/…), or document path'),
      },
    },
    async ({ kind, id }) => json(await lineageOf(ctx.store, kind, id)),
  );

  server.registerTool(
    'knode_history',
    {
      title: 'Apply/dispose history of a source',
      description: 'Scopes and ledger events for a document path, datasource id or page path — when it was applied, replaced, removed or purged.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => json(await historyOf(ctx.store, ctx.dataDir, p)),
  );

  server.registerTool(
    'knode_forget',
    {
      title: 'Forget a source',
      description: 'Delete a file under raw/docs/ or wiki/, dispose everything it produced (entities, edges, claims it alone supported, generated pages), and purge its history so it cannot be reconstructed. Use knode_write/delete + sync for a reversible removal instead.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      assertSourcePath(p);
      assertNotLinked(ctx.config, p, 'forget');
      return json(await forgetSource(ctx, p));
    },
  );

  server.registerTool(
    'knode_okf_validate',
    {
      title: 'Validate an OKF knowledge bundle',
      description: 'Validate Google Open Knowledge Format conformance. Defaults to the native wiki/ bundle; path must be relative to the data directory. as_indexed validates the view knode-os indexes (frontmatter normalizer applied in memory) — what an unannotated raw/docs subtree looks like to the pipeline.',
      inputSchema: {
        path: z.string().optional().describe('Bundle directory, e.g. "wiki" or "raw/docs/okf/team"'),
        as_indexed: z.boolean().optional(),
      },
    },
    async ({ path: p, as_indexed }) => {
      assertNotPrivate(p ?? 'wiki');
      return json(validateOkfBundle(safePath(ctx.dataDir, p ?? 'wiki'), { asIndexed: Boolean(as_indexed) }));
    },
  );

  server.registerTool(
    'knode_graph_insights',
    {
      title: 'Knowledge graph insights',
      description: 'Graph health: totals, hub entities, isolated entities, type distribution.',
      inputSchema: {},
    },
    async () => json(await graphInsights(ctx.store)),
  );

  server.registerTool(
    'knode_survey',
    {
      title: 'Survey the knowledge base',
      description: 'What this knowledge base holds, in numbers: documents by folder and date range, entities by type with the top ones, relation predicates (and unknown ones), claims by status, wiki pages (generated / written / researched), the ontology packs in force, live datasources, the extraction backlog, and whether an AGENTS.md guide exists. The orientation call for an agent that has not seen this base before; read the guide itself with knode_read "AGENTS.md".',
      inputSchema: {},
    },
    async () => json(await surveyKnowledgeBase(ctx)),
  );

  server.registerTool(
    'knode_suggestions',
    {
      title: 'Dream suggestions',
      description: 'Improvement suggestions from the nightly dream (skills / memory / knowledge / playbook revisions). Status stale = an input the suggestion relied on was removed.',
      inputSchema: { status: z.enum(['pending', 'accepted', 'rejected', 'stale']).optional() },
    },
    async ({ status }) => json(await listSuggestions(ctx.store, { status: status ?? 'pending', limit: 50 })),
  );

  server.registerTool(
    'knode_context_pack',
    {
      title: 'Build a context pack',
      description:
        'One-shot context assembly for an utterance: matches entities, pulls the docs/claims/live-tables linked to them in the knowledge graph, runs playbook probe queries against live sources (with asOf timestamps), and returns gap analysis + concrete next queries. Call this FIRST when a user mentions a company/product/entity. as_of / valid_at answer from an earlier state.',
      inputSchema: {
        utterance: z.string().describe('The user request, verbatim'),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        freshness: freshnessSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
      },
    },
    async ({ utterance, as_of, valid_at, valid_range, freshness, kinds, sources }) => json(await buildContextPack(ctx, utterance, {
      temporal: resolveTemporal({ asOf: as_of, validAt: valid_at, validRange: valid_range, freshness }),
      filter: resolveScopeFilter({ kinds, sources }),
      ...quiet,
    })),
  );

  server.registerTool(
    'knode_claims',
    {
      title: 'Query claims directly',
      description:
        'Time-bound assertions as structured rows, instead of prose you have to read and trust. Each claim carries its world-time validity window, its status among conflicting sources (fact / suspected / disputed), its kind (fact / opinion / prediction / rumor), the source path that supports it and how many evidence rows back it, and `date` with its basis (event / validity / stated / document). Use this when the question is "what do we hold about X, and since when", and for how something changed: order=timeline gives one entity\'s chronology in one call, oldest first, superseded values included, each change once — a value restated in later reports folds into the entry where it first appeared (`repeats` gives how often and when), and a measurement series (weekly progress, a metric) is one entry with every change of value in `readings`; fold=false lists every claim. related=true adds the claims about its parts and members and those with it as the object (what changed in a team: people joining and leaving, its projects, settings and risks). text= finds every claim with a word across all entities (everyone who moved teams). event_range keeps claims dated in a window; first_mention=true keeps each subject\'s earliest claim, so text="INC-" with event_range="2024Q1" lists the incidents first reported that quarter. `truncated` and `note` say when limit cut entries off. as_of asks what was believed then, valid_at / valid_range ask what holds in the world, and stale=true means the validity window has already closed. For a value now or as of a date, check the latest source: a document that changes a value under a code or short name may not have updated its claim.',
      inputSchema: {
        subject: z.string().optional().describe('Entity id, name or alias the claim is about'),
        object: z.string().optional().describe('Entity id, name or alias on the other side of the claim'),
        types: z.array(z.string()).optional().describe('Claim types, e.g. ["earnings", "guidance"]'),
        statuses: z.array(z.enum(['fact', 'suspected', 'disputed', 'absent'])).optional()
          .describe('absent = negative knowledge: a lookup that came back empty, with the window it holds for'),
        claim_kinds: z.array(z.enum(['fact', 'opinion', 'prediction', 'rumor'])).optional()
          .describe('What sort of assertion: fact = happened or holds; opinion = someone\'s view; prediction = a forecast; rumor = unconfirmed. Default: all'),
        text: z.string().optional().describe('Substring of the statement'),
        event_range: z.string().optional().describe('Only claims dated in this window — event time, else start of validity, else the date of the source: "2026-01-01..2026-06-30", "2026Q2", "2026"'),
        include_superseded: z.boolean().optional().describe('Also return facts a newer fact of the same subject and attribute replaced: hidden by default, shown by default in a timeline'),
        order: z.enum(['recent', 'timeline']).optional().describe('timeline = by date ascending, restatements folded, for building a chronology'),
        fold: z.boolean().optional().describe('In a timeline, fold restated values and measurement series into one entry each (default true)'),
        related: z.boolean().optional().describe('Also claims about the subject\'s parts and members, and claims with it as the object (default false)'),
        first_mention: z.boolean().optional().describe('One claim per subject, its earliest dated one; with event_range, only subjects first dated in the window — for counting new incidents, hires or risks in a period (a later follow-up of an older one is not new)'),
        limit: z.number().int().min(1).max(500).optional().describe('Entries to return, default 50'),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
        actor: actorSchema,
      },
    },
    async (args) => json(await queryClaims(ctx.store, claimQueryFromArgs(args))),
  );

  server.registerTool(
    'knode_resolve',
    {
      title: 'Resolve a question into ready context plus a plan',
      description:
        'For "who or what is X" and questions about something you have not met yet (lists, counts, timelines and who-did-what go straight to knode_claims / knode_query). Instead of returning whatever text matches, it works out what an answer to this kind of question NEEDS (the intent\'s slots), fills everything the local index can answer, and compiles what is left into a plan of tool calls for you to execute. Read `slots` to see what is covered, `unknowns` for required things nothing can fill (answer around them and say so — do not invent them), `plan.nodes` for the work to do, and `availableNextQueries` for what is worth running first. Report back with knode_feedback and the returned receiptId so the next resolve for this kind of question is better.',
      inputSchema: {
        query: z.string().describe('The user request, verbatim'),
        actor: z.string().optional().describe('Who is asking — recorded on the receipt, and used for ACL checks'),
        workset: z.string().optional().describe('Workset id from knode_checkout: answers at the instant it pinned'),
        render: z.enum(['json-graph', 'ts-program']).optional().describe('ts-program also returns the plan as runnable code'),
        max_tool_calls: z.number().int().min(1).max(32).optional(),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        freshness: freshnessSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
      },
    },
    async ({ query, actor, workset, render, max_tool_calls, as_of, valid_at, valid_range, freshness, kinds, sources, trust }) =>
      json(await resolve(ctx, query, {
        actor,
        render,
        budget: max_tool_calls ? { maxToolCalls: max_tool_calls } : undefined,
        ...quiet,
        temporal: await envelopeFor(ctx.store, { workset, asOf: as_of, validAt: valid_at, validRange: valid_range, freshness }),
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
      })),
  );

  server.registerTool(
    'knode_plan',
    {
      title: 'Just the plan for a question',
      description:
        'The plan knode_resolve would hand you, without the context pack — for when you already have the context and want the remaining work. `phases` groups nodes that can run in parallel; nodes in a later phase depend on an earlier one. Budgets on the plan are advisory: knode enforces its own read-only, row-cap and ACL limits on every call regardless.',
      inputSchema: {
        query: z.string(),
        render: z.enum(['json-graph', 'ts-program']).optional(),
        max_tool_calls: z.number().int().min(1).max(32).optional(),
        as_of: asOfSchema,
        freshness: freshnessSchema,
      },
    },
    async ({ query, render, max_tool_calls, as_of, freshness }) =>
      json(await planOnly(ctx, query, {
        render,
        budget: max_tool_calls ? { maxToolCalls: max_tool_calls } : undefined,
        ...quiet,
        temporal: resolveTemporal({ asOf: as_of, freshness }),
      })),
  );

  server.registerTool(
    'knode_feedback',
    {
      title: 'Report what a plan actually did',
      description:
        'Close the loop on a knode_resolve: which nodes you ran, whether they worked, and which returned ids you actually used. This is what teaches the planner which source answers a slot rather than merely responding to it — an unreported resolve teaches nothing. If you had to rewrite the plan to make it work, send the rewrite as revised_plan; it becomes a candidate recipe rather than being applied blindly.',
      inputSchema: {
        receipt_id: z.string().describe('The receiptId from knode_resolve'),
        executed: z.array(z.object({
          nodeId: z.string(),
          slot: z.string().optional(),
          capability: z.string().optional(),
          ok: z.boolean(),
          elapsedMs: z.number().optional(),
          rows: z.number().optional(),
          tokens: z.number().optional(),
          error: z.string().optional(),
        })).optional(),
        used_ids: z.array(z.string()).optional().describe('Node ids / chunk ids whose results made it into the answer'),
        ignored_ids: z.array(z.string()).optional(),
        outcome: z.string().optional().describe('answered | partial | failed, or a short note'),
        revised_plan: z.unknown().optional(),
      },
    },
    async ({ receipt_id, executed, used_ids, ignored_ids, outcome, revised_plan }) =>
      json(await recordFeedback(ctx.store, {
        receiptId: receipt_id,
        executed,
        usedIds: used_ids,
        ignoredIds: ignored_ids,
        outcome,
        revisedPlan: revised_plan,
      })),
  );

  server.registerTool(
    'knode_checkout',
    {
      title: 'Pin a consistent view for a long task',
      description:
        'Freeze system time so every later call answers from the same instant. A research session that spans a sync would otherwise see the knowledge base change under it, and report a contradiction that is really two reads taken either side of an ingest. Pass the returned id as `workset` to knode_resolve / knode_search. Finish with knode_commit to write your conclusions back as a source.',
      inputSchema: {
        actor: z.string().optional(),
        note: z.string().optional().describe('What this session is for'),
        entities: z.array(z.string()).optional(),
        as_of: asOfSchema,
      },
    },
    async ({ actor, note, entities, as_of }) => json(await checkout(ctx.store, { actor, note, entities, asOf: as_of })),
  );

  server.registerTool(
    'knode_commit',
    {
      title: 'Write a workset\'s conclusions back as a source',
      description:
        'Save what the task concluded as an ordinary document under raw/docs/notes/ — chunked, attributable and revertible like any other source on the next sync. Agent-written sources land quarantined: searchable and cited, but they cannot silently override a trusted claim; where they disagree, a dispute is opened for review.',
      inputSchema: {
        workset: z.string().describe('Workset id from knode_checkout'),
        content: z.string().describe('Markdown body'),
        title: z.string().optional(),
        path: z.string().optional().describe('Override the destination (must be a writable root)'),
        keep_open: z.boolean().optional(),
      },
    },
    async ({ workset, content, title, path: p, keep_open }) =>
      json(await commitWorkset(ctx, { worksetId: workset, content, title, path: p, keepOpen: keep_open, writer: MCP_WRITER })),
  );

  server.registerTool(
    'knode_worksets',
    {
      title: 'List worksets',
      description: 'Pinned views, open and committed.',
      inputSchema: { actor: z.string().optional(), open: z.boolean().optional() },
    },
    async ({ actor, open }) => json(await listWorksets(ctx.store, { actor, open })),
  );

  server.registerTool(
    'knode_subscribe',
    {
      title: 'Watch an entity, source or intent for changes',
      description:
        'Register interest and poll it. The cursor is a system time, not a queue position, so a subscriber that was away still sees everything since — and two subscribers never consume each other\'s events. Call with action="changes" to read (and advance); peek=true reads without advancing, for when you might not finish handling them.',
      inputSchema: {
        action: z.enum(['subscribe', 'unsubscribe', 'list', 'changes']).describe('What to do'),
        kind: z.enum(['entity', 'source', 'intent']).optional().describe('For subscribe: what to watch'),
        target: z.string().optional().describe('For subscribe: entity id, path prefix or intent id'),
        id: z.string().optional().describe('For unsubscribe / changes'),
        actor: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        peek: z.boolean().optional().describe('For changes: do not advance the cursor'),
      },
    },
    async ({ action, kind, target, id, actor, limit, peek }) => {
      if (action === 'subscribe') {
        if (!kind || !target) throw new Error('subscribe needs kind and target');
        return json(await subscribe(ctx.store, { kind, target, actor }));
      }
      if (action === 'unsubscribe') {
        if (!id) throw new Error('unsubscribe needs id');
        return json({ removed: await unsubscribe(ctx.store, id) });
      }
      if (action === 'changes') {
        if (!id) throw new Error('changes needs id');
        return json(await changesSince(ctx.store, id, { limit, advance: !peek }));
      }
      return json(await listSubscriptions(ctx.store, actor));
    },
  );

  server.registerTool(
    'knode_absences',
    {
      title: 'What we looked for and did not find',
      description:
        'Negative knowledge: bindings that came back empty, with the window they are believed empty for. Check this before spending a call on something the knowledge base already knows is not there — and note the expiry: "nothing there" is true of a moment, not forever.',
      inputSchema: { entities: z.array(z.string()).describe('Entity ids'), as_of: asOfSchema },
    },
    async ({ entities, as_of }) => json(await liveAbsences(ctx.store, entities, as_of)),
  );

  server.registerTool(
    'knode_disputes',
    {
      title: 'Contradictions between sources',
      description:
        'Where a quarantined write disagrees with a trusted claim, the disagreement is recorded rather than resolved by overwriting. List them, or resolve one once a person has decided. Promoting the quarantined source (knode_trust) resolves the disputes it opened.',
      inputSchema: {
        action: z.enum(['list', 'resolve']).optional(),
        id: z.string().optional().describe('For resolve'),
        status: z.string().optional().describe('open | resolved (list only)'),
        actor: z.string().optional(),
      },
    },
    async ({ action, id, status, actor }) => {
      if (action === 'resolve') {
        if (agent) throw forPerson('settling a dispute');
        if (!id) throw new Error('resolve needs id');
        return json({ resolved: await resolveDispute(ctx.store, id, actor) });
      }
      return json(await listDisputes(ctx.store, { status: status ?? 'open' }));
    },
  );

  server.registerTool(
    'knode_trust',
    {
      title: 'Promote or demote a source',
      description:
        'Move a source between trust tiers. Agent writes start quarantined — visible and attributable, but excluded when a caller asks for trusted-only, and unable to override a trusted claim. Promoting resolves the disputes that source opened, because the review is what the quarantine was waiting for.',
      inputSchema: {
        path: z.string().describe('Source key, e.g. "raw/docs/notes/w_ab12.md"'),
        to: z.enum(['trusted', 'quarantined']),
        actor: z.string().optional(),
      },
    },
    async ({ path: p, to, actor }) => {
      // an agent's writes wait for this very call; it may demote, never promote
      if (agent && to === 'trusted') throw forPerson('promoting a source');
      return json(await setScopeTrust(ctx.store, { key: p, to, actor }));
    },
  );

  server.registerTool(
    'knode_learning',
    {
      title: 'What the planner has learned',
      description:
        'The capability ranking (which source actually answers which slot, from receipts), pack precision (used over returned), and the recipe candidates distillation would propose. Regenerates wiki/learning/ so the numbers steering the planner stay reviewable by a person.',
      inputSchema: {
        lookback_days: z.number().int().min(1).max(365).optional(),
        intent: z.string().optional(),
        distill: z.boolean().optional().describe('Also propose recipes for plan shapes that keep working'),
      },
    },
    async ({ lookback_days, intent, distill }) => {
      const ranking = await writeRankerReport(ctx.store, { intent });
      const evaluation = await evaluatePacks(ctx.store, { lookbackDays: lookback_days });
      const distilled = distill ? await distillRecipes(ctx.store, { lookbackDays: lookback_days, intent }) : null;
      return json({
        ranking: { path: ranking.path, rows: ranking.rows },
        evaluation,
        distilled: distilled && {
          shapes: distilled.shapes,
          proposed: distilled.suggestions.map((s) => ({ id: s.id, title: s.title, body: s.body })),
          rejected: distilled.candidates.filter((c) => !c.ok).map((c) => ({ signature: c.shape.signature, reason: c.reason })),
        },
      });
    },
  );

  server.registerTool(
    'knode_research',
    {
      title: 'Deep-research wiki pages',
      description:
        'Ask knode-os to have a coding-agent CLI research a topic and write a wiki page (entity / concept / comparison / timeline / question / refresh). action=queue adds a job (deduplicated; runs while `serve` is up and research.agent is configured), init queues a knowledge-base initialization (extraction, then an overview page plus the AGENTS.md guide, with follow-up topic pages queued), list shows recent jobs, status shows one job with its outcome and warnings, cancel stops a job and kills its running sessions, templates lists the page templates under playbooks/research. Pages written this way land quarantined until a person promotes them.',
      inputSchema: {
        action: z.enum(['queue', 'init', 'list', 'status', 'cancel', 'templates']),
        kind: z.enum(RESEARCH_KINDS as [ResearchKind, ...ResearchKind[]]).optional().describe('For queue (default entity; question uses `query`)'),
        target: z.string().optional().describe('Entity / concept name, "A vs B" for comparison, or a wiki page path for refresh'),
        query: z.string().optional().describe('For kind=question: the question to answer and file as a page'),
        template: z.string().optional().describe('Template file stem under playbooks/research (default: the kind)'),
        id: z.string().optional().describe('Job id for status / cancel'),
        status: z.enum(['queued', 'running', 'validating', 'done', 'failed', 'cancelled']).optional().describe('For list'),
      },
    },
    async ({ action, kind, target, query, template, id, status }) => {
      if (action === 'queue') {
        const k = kind ?? (query && !target ? 'question' : 'entity');
        return json(await queueJob(ctx.store, { kind: k, target, query, template, requestedBy: 'mcp' }));
      }
      if (action === 'init') {
        return json(await queueJob(ctx.store, { kind: 'init', requestedBy: 'mcp' }));
      }
      if (action === 'status') {
        if (!id) throw new Error('status needs id');
        return json(await getJob(ctx.store, id));
      }
      if (action === 'cancel') {
        if (!id) throw new Error('cancel needs id');
        const cancelled = await cancelJob(ctx.store, id);
        return json({ cancelled, killed: cancelled ? killAgentsFor(id) : 0 });
      }
      if (action === 'templates') {
        return json([...loadResearchTemplates(ctx.dataDir).values()].map((t) => ({ name: t.name, kind: t.kind, output: t.output, requires: t.requires, path: t.path })));
      }
      return json(await listJobs(ctx.store, { status, limit: 50 }));
    },
  );


  /* ---------------------------------------------------------- research: web, sources, charts, studies */

  /** The actor a capture is on record as: the study's agent when it names one, else an MCP client. */
  const captureActor = async (study: string | undefined): Promise<{ actor: string; ref: { id: string; slug: string; title?: string } | null }> => {
    if (!study) return { actor: MCP_WRITER, ref: null };
    const job = await getJob(ctx.store, study);
    if (!job || job.kind !== 'study') throw new Error(`no study ${study} — knode_study action=list shows them`);
    const agentFor = studyAgent(ctx, job);
    const brief = (job.payload.brief ?? {}) as { title?: string };
    return { actor: agentFor ? `agent/${agentFor.provider}` : MCP_WRITER, ref: { id: job.id, slug: job.target ?? job.id, title: brief.title } };
  };

  server.registerTool(
    'knode_capture',
    {
      title: 'Save web material into the knowledge base',
      description: 'Fetch a URL — a web page, a PDF, a CSV / JSON file, an image — and keep it as a source under raw/docs/research/<study>/: knode fetches it itself (never pass the page as text unless knode cannot), keeps the original, converts it to Markdown and indexes it within seconds. Returns the path to cite (frontmatter `sources:`, `（来源：…）`), the title, the publication date when the page states one, and the outline of a long document (read its parts with knode_read `section`). The same URL is kept once; a second capture returns the first. Pass `study` inside a research study. When the site refuses knode (403, a login, a page that is all script), capture another URL for the same document, or pass the text you read as `content` to keep a clearly labelled excerpt.',
      inputSchema: {
        url: z.string().describe('http(s) URL of the page or file'),
        study: z.string().optional().describe('The research study this is for (its id, e.g. r_0123456789)'),
        why: z.string().optional().describe('One line: what this source is for'),
        title: z.string().optional().describe('A title, when the document carries none (a PDF without metadata)'),
        content: z.string().optional().describe('Only when knode could not fetch the URL: the text you read, saved as your excerpt of it'),
      },
    },
    async ({ url, study, why, title, content }) => {
      const { actor, ref } = await captureActor(study);
      return json(await captureUrl(ctx, { url, study: ref, why, title, content, actor, maxCaptures: ref ? ctx.config.research.study.maxCaptures : undefined }));
    },
  );

  server.registerTool(
    'knode_web_fetch',
    {
      title: 'Read a web page without keeping it',
      description: 'Fetch a URL and return its readable text (HTML as Markdown), in slices of up to 60 000 characters (`offset`, `limit`) — to decide whether a page is worth a knode_capture. Nothing is saved; cite only what you captured.',
      inputSchema: {
        url: z.string(),
        offset: z.number().int().min(0).optional().describe('Character offset (the previous answer\'s nextOffset)'),
        limit: z.number().int().min(1000).max(60000).optional(),
      },
    },
    async ({ url, offset, limit }) => json(await fetchReadable(ctx, url, { offset, limit })),
  );

  if (webSearchEnabled(ctx.config.research?.web)) {
    server.registerTool(
      'knode_web_search',
      {
        title: 'Search the web',
        description: `Search the web through the search API this knowledge base is configured with (${ctx.config.research.web.search.provider}). Returns title, URL, snippet and date per result; read one with knode_web_fetch, keep the ones you rely on with knode_capture.`,
        inputSchema: {
          query: z.string(),
          max: z.number().int().min(1).max(20).optional(),
          domains: z.array(z.string()).optional().describe('Only these sites, e.g. ["sec.gov"]'),
          recency: z.enum(['day', 'week', 'month', 'year']).optional(),
        },
      },
      async ({ query, max, domains, recency }) => json(await webSearch(ctx.config.research.web, query, { max, domains, recency })),
    );
  }

  server.registerTool(
    'knode_api',
    {
      title: 'Call a configured API source',
      description: 'Call one declared endpoint of an API research source (playbooks/research/sources/<id>.yaml, kind api). Only declared endpoints and parameters pass. `capture: true` also keeps the answer as a data file of the study (raw/docs/research/<study>/files/…), so it can be cited.',
      inputSchema: {
        source: z.string(),
        endpoint: z.string(),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        capture: z.boolean().optional(),
        study: z.string().optional(),
        why: z.string().optional(),
      },
    },
    async ({ source, endpoint, params, capture, study, why }) => {
      const src = loadResearchSource(ctx.dataDir, source);
      if (!src) throw new Error(`no research source "${source}"`);
      const res = await callApiSource(ctx.config, src, endpoint, params ?? {});
      let saved: unknown = null;
      if (capture && res.status < 400) {
        const { actor, ref } = await captureActor(study);
        saved = await captureUrl(ctx, {
          url: res.url, study: ref, why: why ?? `${src.title}: ${endpoint}`, actor, title: `${src.title} — ${endpoint}`,
          prefetched: { url: res.url, finalUrl: res.finalUrl, status: res.status, headers: {}, contentType: res.contentType, charset: res.charset, body: res.body, truncated: false },
        });
      }
      return json({ source: res.source, endpoint: res.endpoint, url: res.url, status: res.status, contentType: res.contentType, records: res.records, text: res.records ? undefined : res.text, truncated: res.truncated, captured: saved });
    },
  );

  server.registerTool(
    'knode_chart',
    {
      title: 'Check a chart before writing it',
      description: 'Validate a chart spec for a ```chart block in a wiki page — {"type": "bar|hbar|line|area|stacked-bar|share|scatter|waterfall|timeline", "title", "subtitle"?, "unit"?, "x": [labels], "series": [{"name", "values": [numbers or null]}], "source": "the paths / URLs the numbers come from", "note"?}. Every type has that shape: x names the categories, each series has one value per category, at most 8 series and 60 categories, one unit and one value axis. '
        + 'share: each column drawn as 100% — market share over time, a series per company; percentages that add up to 100 per column (add an "Other" series), or amounts the chart turns into shares. '
        + 'scatter: x names the points; exactly two series, the horizontal measure first and then the vertical one, each named with its unit ("Forward P/E, ×") — valuation against growth. '
        + 'waterfall: one series, a bridge such as a margin walk: the first and the last bar are levels and the bars between are changes (positive or negative); with subtotals in the middle, name every level in "totals": [x labels]; the changes should add up to the next level. '
        + 'timeline: x lists generations or milestones in order (HBM3E, HBM4, HBM4E), a series per maker, and each value is when it got there: 2025, "2025-03", "2025-Q4", "2026-H1", or null for not yet. '
        + 'Colour follows the series, never a rank. Returns the errors and warnings, or the normalized block to paste into the page.',
      inputSchema: { spec: z.union([z.string(), z.record(z.string(), z.unknown())]) },
    },
    async ({ spec }) => {
      const r = parseChart(typeof spec === 'string' ? spec : JSON.stringify(spec));
      return json({ ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, block: r.spec ? chartBlock(r.spec) : null });
    },
  );

  server.registerTool(
    'knode_study',
    {
      title: 'Research studies',
      description: 'Research studies: a topic researched into several wiki pages (collect sources → one page per planned part → a report). action=list shows recent studies, show one study (brief, stages, pages, captured sources). From this machine\'s own clients also: create (a topic; refined into a brief right away), refine (feedback on a draft), start (queue a draft).',
      inputSchema: {
        action: z.enum(['list', 'show', 'create', 'refine', 'start']),
        id: z.string().optional(),
        topic: z.string().optional().describe('For create: what to research, in a sentence or a paragraph'),
        feedback: z.string().optional().describe('For refine: what to change in the brief'),
        agent: z.string().optional().describe('For create: the agent that runs it (default research.agent)'),
        web: z.boolean().optional().describe('For create: may it search the web (default true)'),
      },
    },
    async ({ action, id, topic, feedback, agent: agentSpec, web }) => {
      if (action === 'list') {
        return json((await listStudies(ctx, 30)).map((j) => ({ id: j.id, status: j.status, stage: j.payload.stage, title: (j.payload.brief as { title?: string } | undefined)?.title ?? j.query, created: j.createdAt })));
      }
      if (action === 'show') {
        if (!id) throw new Error('show needs id');
        const job = await getJob(ctx.store, id);
        if (!job || job.kind !== 'study') throw new Error(`no study ${id}`);
        return json(await studyView(ctx, job));
      }
      if (agent) throw new Error(`${action} is a person's decision — it spends the agent's quota on a whole study: ask them to do it in knode-os (Research)`);
      if (action === 'create') {
        if (!topic) throw new Error('create needs topic');
        return json(await createStudy(ctx, { topic, runner: agentSpec ? { agent: agentSpec } : undefined, sources: web === undefined ? undefined : { web }, requestedBy: 'mcp' }));
      }
      if (!id) throw new Error(`${action} needs id`);
      if (action === 'refine') return json(await refineStudy(ctx, id, { feedback }));
      return json(await startStudy(ctx, id));
    },
  );

  server.registerTool(
    'knode_capabilities',
    {
      title: 'What can be asked, and of which source',
      description:
        'The capability catalog: every table, endpoint, metric and built-in tool this knowledge base can reach, with its schema, the semantics people wrote about it (metric definitions, join paths, pitfalls), its typical freshness and its relative cost. Ask for format="dts" to get a TypeScript declaration to write a program against. Pass an entity to see only what can actually be reached for it, together with the locators — the parameter and value to bind, e.g. symbol = "300750".',
      inputSchema: {
        source: z.string().optional().describe('Restrict to one datasource id'),
        kind: z.enum(['table', 'endpoint', 'metric', 'tool']).optional(),
        entity: z.string().optional().describe('Entity id: only capabilities reachable for it, plus how to bind them'),
        format: z.enum(['json', 'dts']).optional().describe('dts returns a TypeScript declaration instead of JSON'),
        as_of: asOfSchema,
      },
    },
    async ({ source, kind, entity, format, as_of }) => {
      const capabilities = await listCapabilities(ctx.store, {
        sourceIds: source ? [source] : undefined,
        kinds: kind ? [kind] : undefined,
        entityIds: entity ? [entity] : undefined,
        asOf: as_of,
      });
      if (format === 'dts') {
        return { content: [{ type: 'text' as const, text: renderCapabilityDts(capabilities) }] };
      }
      const locators = entity ? await locatorsForEntities(ctx.store, [entity], as_of) : [];
      return json({ capabilities, locators });
    },
  );

  server.registerTool(
    'knode_datasources',
    {
      title: 'List live data sources',
      description: 'Configured external sources (mysql/timescale/duckdb) and their registered tables: schema columns, row counts, linked entity counts, freshness. Rows are never indexed — query them with knode_query. Also lists the built-in "catalog" source: read-only views over the knowledge base itself, for shapes the fixed tools do not expose.',
      inputSchema: {},
    },
    async () => {
      const datasets = await listDatasets(ctx.store);
      return json({
        sources: [
          ...ctx.datasources.list().map((d) => ({ id: d.id, kind: d.kind, description: d.description ?? '' })),
          { id: CATALOG_SOURCE, kind: 'catalog', description: 'the knowledge base itself, as read-only SQL views' },
        ],
        catalog: tableFacts ? CATALOG_VIEWS : CATALOG_VIEWS.filter((v) => !OPTIONAL_CATALOG_VIEWS.has(v.name)),
        datasets: datasets.map((d) => ({
          id: d.id,
          source: d.source_id,
          table: d.table_name,
          kind: d.kind,
          columns: d.columns,
          rowCount: d.row_count === null ? null : Number(d.row_count),
          linkedEntities: d.entity_count,
          refreshedAt: d.refreshed_at,
          description: d.description,
          wikiPage: `wiki/datasets/${d.id}.md`,
        })),
      });
    },
  );

  server.registerTool(
    'knode_query',
    {
      title: 'Native query against a live data source',
      description: `Run a read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN) directly against a configured source in its native dialect. Returns rows plus an asOf timestamp; results are live, never from the index. source="catalog" queries the knowledge base itself through the v_* views — the tool for lists, counts, rankings and date ranges over what the knowledge base extracted (every claim about X in 2025, how many P1 incidents company-wide, how many documents mention Y) and for who did what (v_relations: every relation of an entity with the sentence stating it, one call per hop of a chain), in one call instead of reading documents one by one.\n${catalogGuide({ tableFacts })}`,
      inputSchema: {
        source: z.string().describe('Datasource id, e.g. "market-mysql", or "catalog" for the knowledge base itself (see knode_datasources)'),
        sql: z.string().describe('A single read-only SQL statement in the source\'s dialect'),
        maxRows: z.number().int().min(1).max(1000).optional().describe('Row cap (default from source config)'),
      },
    },
    async ({ source, sql, maxRows }) => {
      if (source === CATALOG_SOURCE) return json(await catalogQuery(ctx.store, sql, { maxRows }));
      return json(await runSourceQuery(ctx.datasources, source, sql, { maxRows }));
    },
  );

  // the statement tables of raw/docs as one matrix (src/tables): offered only where extraction.tableFacts is on
  if (tableFacts) {
    server.registerTool(
      'knode_table',
      {
        title: 'Metrics × companies × periods from the statement tables',
        description: 'One call for numbers that stand in the tables of many reports ("accounts payable of these 12 companies at 2024-03-31", "营业收入 of A, B and C, 2023 and 2024"): returns a matrix with one row per company (document) and metric and one column per period; each cell has the value as written, the unit, the scale (its wording as the table states it, e.g. "单位：万元" or "in thousands", and scaleFactor; valueScaled = value × scaleFactor) and ref = path#Lline to check it with one read. Metrics match a row label as written or its normalized key (营业收入 = revenue, 应付账款 = Accounts payable = accounts_payable; ", net", "(loss)", numbering and 其中：/减： are ignored), then labels containing the metric. Every cell of every table is there, not just headline figures; derived ratios are not computed. `missing` lists the company × metric pairs nothing matched — read those documents. Use knode_query on v_table_facts for shapes this does not give.',
        inputSchema: {
          metrics: z.array(z.string()).min(1).max(20).describe('Row labels or keys, e.g. ["Accounts payable", "营业收入", "total_assets"]'),
          subjects: z.array(z.string()).max(60).optional().describe('Companies (or document names / path parts); none: every company that has the metric'),
          periods: z.array(z.string()).max(12).optional().describe('e.g. ["2024-03-31", "2023-12-31"], ["2024", "2023"], ["2024-Q1"], ["期末余额"], ["current", "prior"]; none: every period found'),
          paths: z.array(z.string()).max(20).optional().describe('Restrict to documents under these path prefixes'),
          contains: z.boolean().optional().describe('false: match a metric by key or exact label only (default true: also labels containing it, where nothing matches exactly)'),
        },
      },
      async ({ metrics, subjects, periods, paths, contains }) => json(await tableMatrix(ctx.store, { metrics, subjects, periods, paths, contains })),
    );
  }

  server.registerTool(
    'knode_grep',
    {
      title: 'Grep the knowledge files',
      description: 'Regex search across wiki, raw/docs (including the Markdown derived from PDFs and images), raw/skills, playbooks/packs and raw/codebase (code repositories; pass path="raw/codebase/<repo>" to search one) (like grep -rn). For exact strings, IDs, symbols, tickers and numbers, and for the latest mention of a value before a date. `context: N` returns N lines around each match, grouped by file (like grep -n -C N), so one call can replace reading the files; `paths` searches several subtrees or files at once. Without `context` the answer is {matches, total}; when more lines match than it shows (maxMatches, or max_per_file) it has `cut` as well: the matches are then a sample shared over the folders and files that hold them, not the first ones met, and `cut.folders` names every folder that matches with its count — search that folder alone to see its matches. With `context` the same is said in a closing note.',
      inputSchema: {
        pattern: z.string().describe('JavaScript regular expression (case-insensitive)'),
        path: z.string().optional().describe('Restrict to a subtree or a file, e.g. "wiki/datasets"'),
        paths: z.array(z.string()).max(20).optional().describe('Several subtrees or files to search in one call'),
        context: z.number().int().min(0).max(20).optional().describe('Lines of context before and after each match; the answer is then text grouped by file ("12: match", "13- context")'),
        maxMatches: z.number().int().min(1).max(500).optional(),
        max_per_file: z.number().int().min(1).max(500).optional().describe('Matches per file at most, so one long file does not take every match'),
      },
    },
    async ({ pattern, path: p, paths, context, maxMatches, max_per_file }) => {
      const roots = [...(p ? [p] : []), ...(paths ?? [])];
      if (context !== undefined && context > 0) {
        return { content: [{ type: 'text' as const, text: grepWithContext(ctx, { pattern, paths: roots, context, maxMatches, maxPerFile: max_per_file }) }] };
      }
      // one shape, cut or not: {matches, total}, and `cut` when the matches are a sample of what matches
      return json(grepAnswer(grepAcross(ctx, { pattern, paths: roots, maxMatches, maxPerFile: max_per_file })));
    },
  );
}
