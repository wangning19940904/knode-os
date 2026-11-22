import crypto from 'node:crypto';
import path from 'node:path';
import { embeddingDeferred, KnodeConfig } from '../config.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { originOf, readSidecarPart, replayableTier1, SidecarTier1, truncatedTier1, updateSidecarPart } from '../fs/sidecar.js';
import { CITATIONS_VERSION, dedupeCitations, rawDocValue, relationCitation } from '../graph/citations.js';
import { planTier0, Tier0Plan, wireConcepts, wireLinks } from '../graph/concepts.js';
import { frontmatterExtraction } from '../graph/frontmatter.js';
import { loadOntology } from '../graph/ontology.js';
import { parseCapabilityNotes } from '../capability/notes.js';
import { TRUST_TIERS, TrustTier, detectDisputes, tierForActor } from '../lineage/trust.js';
import { applyExtraction } from '../graph/llm-extract.js';
import { segmentText } from '../graph/segment.js';
import { applyTier1Scope, enqueueTier1, segmentRangesOf } from '../graph/tier1.js';
import { PageContext } from '../graph/store.js';
import { applyWirePlan, extractWikilinks, planWireFromMarkdown, WikiIndex } from '../graph/wire.js';
import { isReservedWikiFile } from '../lineage/declared.js';
import { carryCitationBaseline, CITE_DEPS_VERSION, CitationDepsPlan, planCitationDeps } from '../lineage/page-deps.js';
import { readDeps } from '../lineage/deps.js';
import { applyScope, findLiveScope } from '../lineage/scope.js';
import { ParsedMarkdown, parseFrontmatter, titleFromMarkdown } from '../markdown.js';
import { isGeneratedConcept } from '../okf/index.js';
import { pluginRegistry } from '../plugins/registry.js';
import { restoreUsageFromSidecar } from '../stats/heat.js';
import { Store } from '../store/db.js';
import { DocRoot } from '../types.js';
import { hasProse, hasRegions, stripRegions } from '../wiki/regions.js';
import { chunkCode, chunkText } from './chunker.js';
import { splitCodebaseKey } from './codebase/files.js';
import { DOC_DATE_RULES, documentDate, redateDocument } from './redate.js';
import { detectLanguage } from '../lang/detect.js';
import { estimateTokens } from '../llm/tokens.js';
import { MINDMAP_PLAN_VERSION, MindMapPlan, planDocumentMindMap, wireMindMap, withMindMapSubject } from '../mindmap/graph.js';
import { isMindMapFrontmatter, mindMapChunks, parseMindMap } from '../mindmap/outline.js';
import type { DeferredEmbeddings } from '../context.js';
import { EmbeddingProvider } from './embeddings.js';
import { loadSourceText, sha256 } from './source.js';

export { DOC_DATE_RULES } from './redate.js';

/**
 * Apply one file as a document scope: chunk → embed (reusing unchanged
 * content-addressed chunks) → search projection → tier-0 graph evidence
 * (declared facts, links to entities the graph already knows, mined concept
 * placeholders — src/graph/concepts.ts), all inside one scope transaction.
 * Under `serve` the embed step is left to the background embedder
 * (`ctx.embeddings`): an apply never waits on the rate-limited pool, and never
 * fails because its daily quota is spent. In deferred mode
 * (`ingest.embedding: "deferred"`, docs/design/12 §3.3) no apply embeds, the
 * CLI's included: the chunks wait in the embed backlog that `serve`'s embed
 * slots and remote workers drain (src/work/embed.ts), and a new embedding
 * model re-applies nothing — the backlog refills for it instead. Tier-1 sidecar replays and the
 * human-written parts of generated pages become child scopes of the document's
 * scope.
 *
 * The text comes from src/ingest/source.ts: raw text normalized in memory, or
 * the sidecar's content.md for converted originals and trace episodes.
 *
 * Sources vs views:
 *   - sources (raw docs, skills, human wiki pages, anchors) contribute
 *     entities / relations / claims;
 *   - views (generated pages, recognised by a live `pages` row or
 *     `generated: true` without an explicit `actor`) are indexed for search only.
 *     A page that names its author (`actor: agent/…`, a research page) is a
 *     Source whatever its `generated` key says — trust follows that actor. Only prose a human wrote
 *     outside the managed regions counts as evidence (`extractor: human`) —
 *     that is what stops a stub page from resurrecting the entity it describes.
 *   - reserved files (index.md / log.md) never touch the graph.
 */

export interface ApplyDocContext {
  store: Store;
  config: KnodeConfig;
  embedder: EmbeddingProvider;
  /** When set, chunks are written without vectors and embedded later (src/ingest/embed-backfill.ts, src/work/embed.ts). */
  embeddings?: DeferredEmbeddings;
}

export interface ApplyDocOptions {
  /** Queue the document for tier-1 LLM extraction when no sidecar replay exists. */
  queueTier1?: boolean;
  /**
   * Re-apply although content and embedding model are unchanged: the live
   * scope is replaced (chunks and their vectors kept — the chunk ids are
   * content-addressed), tier-0 evidence is recomputed, a finished tier-1 is
   * replayed from the sidecar, and nothing new is queued for extraction where
   * the sidecar's tier-1 is done. `knode-os sync --reapply`.
   */
  reapply?: boolean;
  actor?: string;
  at?: string;
  wikiIndex?: WikiIndex;
  onProgress?: (msg: string) => void;
}

export interface DocOutcome {
  outcome: 'applied' | 'unchanged' | 'skipped';
  chunks: number;
  entities: number;
  relations: number;
  scopeId: string | null;
  /** sha256 of the text the live scope now holds; null when skipped. */
  sha: string | null;
}

/** A repository file's title: `<repository>/<path inside it>`, which is what a reader searches and recognizes. */
function codebaseTitle(file: string): string {
  const key = splitCodebaseKey(file);
  return key ? `${key.name}/${key.path}` : path.basename(file);
}

export function documentIdFor(file: string): string {
  return crypto.createHash('sha256').update(file).digest('hex').slice(0, 24);
}

export function chunkIdFor(docId: string, seq: number, content: string): string {
  return crypto.createHash('sha256').update(`${docId}|${seq}|${content}`).digest('hex').slice(0, 32);
}

interface Classification {
  kind: 'source' | 'view';
  graph: boolean;
  /** undefined = planner default (every non-reserved wiki / imported OKF page) */
  selfEntity: boolean | undefined;
  humanBody: string;
}

async function classify(store: Store, file: string, root: DocRoot, parsed: ParsedMarkdown): Promise<Classification> {
  // a repository's file is searchable text, never graph evidence: `[[x]]` in a
  // shell test or a Python index is not a link, and the card speaks for the repository
  if (root === 'codebase') return { kind: 'source', graph: false, selfEntity: false, humanBody: parsed.body };
  if (root !== 'wiki') return { kind: 'source', graph: true, selfEntity: undefined, humanBody: parsed.body };
  if (isReservedWikiFile(file)) return { kind: 'source', graph: false, selfEntity: false, humanBody: parsed.body };
  const [pageRow] = await store.query<{ status: string }>(`SELECT status FROM pages WHERE path = $1 AND tx_to IS NULL`, [file]);
  const authored = typeof parsed.frontmatter.actor === 'string' && parsed.frontmatter.actor.trim() !== '';
  const generated = pageRow !== undefined || (isGeneratedConcept(parsed.frontmatter) && !authored);
  if (generated) {
    // legacy generated pages without markers are fully managed
    const humanBody = hasRegions(parsed.body) ? stripRegions(parsed.body) : '';
    const graph = hasProse(humanBody);
    return { kind: 'view', graph, selfEntity: graph, humanBody };
  }
  // `selfEntity: false` in frontmatter: a hub page (the overview) that is about the whole base, not one entity.
  // A generated region in a person's page (the overview's holdings) is no one's assertion: the graph reads the rest
  return { kind: 'source', graph: true, selfEntity: parsed.frontmatter.selfEntity === false ? false : undefined, humanBody: hasRegions(parsed.body) ? stripRegions(parsed.body) : parsed.body };
}

export async function applyDocScope(ctx: ApplyDocContext, file: string, root: DocRoot, opts: ApplyDocOptions = {}): Promise<DocOutcome> {
  const { store, config, embedder } = ctx;
  const progress = opts.onProgress ?? (() => {});
  const actor = opts.actor ?? 'sync';
  const none = { chunks: 0, entities: 0, relations: 0, scopeId: null, sha: null };
  const source = loadSourceText(store.dataDir, file, root);
  if (!source) return { outcome: 'skipped', ...none };
  const raw = source.text;
  const bytes = Buffer.byteLength(raw);
  if (bytes > MAX_FILE_BYTES) return { outcome: 'skipped', ...none };
  const sha = sha256(raw);
  const docId = documentIdFor(file);

  const live = await findLiveScope(store, 'doc', file);
  // deferred: vectors are the backlog's business, so another model is no reason to re-apply
  const deferred = embeddingDeferred(config);
  const sameModel = deferred || live?.meta.embedModel === embedder.model;
  // a wiki page applied before pages could cite raw/docs files is read again
  // once — unless it is a generated view: the summaries cite their documents
  // in machine-written regions, which never count
  const citationsStale = root === 'wiki' && live !== null && live.sha === sha && sameModel
    && live.meta.citations !== CITATIONS_VERSION && live.meta.kind !== 'view'
    && !isReservedWikiFile(file) && raw.includes('raw/docs/');
  // a page applied before its cited files became dependencies is read again once (docs/design/37 §5): this is
  // the backfill of the research pages written earlier
  const citeDepsStale = root === 'wiki' && live !== null && live.sha === sha && sameModel
    && live.meta.citeDeps !== CITE_DEPS_VERSION && live.meta.kind !== 'view'
    && !isReservedWikiFile(file) && (raw.includes('raw/docs/') || raw.includes('raw/codebase/'));
  // a mind map applied by an older planner is read again once (docs/design/19)
  const mindMapStale = live !== null && live.sha === sha && sameModel && live.meta.mindmap !== MINDMAP_PLAN_VERSION && looksLikeMindMap(raw);
  // a document applied under older date rules has its date read again, and is re-dated in place when it reads otherwise
  const code = root === 'codebase';
  const parse = (): ParsedMarkdown => (code ? { frontmatter: {}, body: raw } : parseFrontmatter(raw));
  if (live && live.sha === sha && sameModel && !opts.reapply && !citationsStale && !citeDepsStale && !mindMapStale) {
    await redateDocument(store, live, { file, root, raw, sha, docId, at: opts.at, actor }, parse, progress);
    // a sidecar may have gained a replayable tier-1 extraction since (copied
    // from another machine, or written by a bench run) — apply it as the
    // document's child scope without re-indexing the document itself
    if (root === 'docs') {
      await ensureTier1Replay(store, file, raw, sha, docId, opts);
      // an extraction from before segmented extraction read only the start of
      // a long document: queue it again so the rest gets read (docs/design/10)
      if (opts.queueTier1 && truncatedTier1(readSidecarPart(store.dataDir, file, 'tier1'), sha, raw.length)) {
        await enqueueTier1(store, docId, segmentText(raw, config.extraction.segmentChars).length);
      }
    }
    return { outcome: 'unchanged', ...none, scopeId: live.id, sha };
  }

  progress(`indexing ${file}`);
  // source code has no frontmatter: a YAML file or a README's own header is its text, not knode metadata
  const parsed = parse();
  const title = code ? codebaseTitle(file) : titleFromMarkdown(file, parsed);
  const cls = await classify(store, file, root, parsed);
  // a raw document may date itself in its first lines; a wiki page, a trace or source code is dated by its metadata alone
  const docDate = documentDate(file, root, parsed, opts.at);
  // what a reader would read it as: the Translate stage reads this (docs/design/17);
  // '' is "read, and in no language", which no backfill needs to read again — and code is never translated
  const language = code ? '' : detectLanguage(raw, parsed.frontmatter) ?? '';

  /* ── pure preparation: chunking, embeddings (network, unless deferred), tier-0 plans ── */
  // plugin hooks (docs/design/11) may reshape the chunks and the tier-0 terms
  // here, before anything is written; the scope body below stays pure writes
  const registry = pluginRegistry();
  // a mind map is cut along its branches, each piece under the path it hangs from (docs/design/19)
  const mindMap = isMindMapFrontmatter(parsed.frontmatter) ? parseMindMap(parsed.body) : null;
  let pieces = mindMap
    ? mindMapChunks(mindMap, config.ingest.chunkSize).map((content) => ({ content, tokenCount: estimateTokens(content) }))
    : code
      ? await chunkCode(file, parsed.body, config.ingest)
      : await chunkText(file, parsed.body, config.ingest, { markdown: source.derived || undefined });
  if (registry.hasHandlers('chunk')) {
    pieces = (await registry.filter('chunk', pieces, {
      path: file, root, dataDir: store.dataDir, text: parsed.body,
      config: { chunkSize: config.ingest.chunkSize, chunkOverlap: config.ingest.chunkOverlap },
    })).filter((p) => p && typeof p.content === 'string' && p.content.trim().length > 0)
      .map((p) => ({ content: p.content, tokenCount: Number.isFinite(p.tokenCount) ? p.tokenCount : estimateTokens(p.content) }));
  }
  const chunkRows = pieces.map((p, i) => ({ id: chunkIdFor(docId, i, p.content), seq: i, content: p.content, tokenCount: p.tokenCount }));
  const vectors = new Map<string, number[]>();
  if (chunkRows.length > 0) {
    const ph = chunkRows.map((_, i) => `$${i + 2}`).join(',');
    const have = new Set(
      (await store.query<{ chunk_id: string }>(`SELECT chunk_id FROM embeddings WHERE model = $1 AND chunk_id IN (${ph})`, [embedder.model, ...chunkRows.map((c) => c.id)]))
        .map((r) => r.chunk_id),
    );
    const missing = chunkRows.filter((c) => !have.has(c.id));
    if (missing.length > 0 && !ctx.embeddings && !deferred) {
      const vecs = await embedder.embed(missing.map((c) => c.content));
      missing.forEach((c, i) => vectors.set(c.id, vecs[i]));
    }
  }

  const page: PageContext = { documentId: docId, path: file, title: title ?? path.basename(file), chunkIds: chunkRows.map((c) => ({ id: c.id, content: c.content })) };
  const isSource = cls.kind === 'source';
  // a source wiki page may carry machine-maintained regions (a timeline the
  // page generator refreshes); only its prose is evidence, the regions are not
  const sourceBody = root === 'wiki' && hasRegions(parsed.body) ? stripRegions(parsed.body) : parsed.body;
  const wirePlan = isSource && cls.graph
    ? planWireFromMarkdown(store.dataDir, page, parsed, { selfEntity: cls.selfEntity, wikiIndex: opts.wikiIndex, body: sourceBody })
    : null;
  const humanPlan = !isSource && cls.graph
    ? planWireFromMarkdown(store.dataDir, page, { frontmatter: parsed.frontmatter, body: cls.humanBody }, { selfEntity: true, body: cls.humanBody, wikiIndex: opts.wikiIndex, citations: 'body' })
    : null;
  // a bundle page may declare entities, typed relations and claims in its
  // frontmatter (research pages do), its own entity the default subject. On a
  // wiki page a relation naming a raw/docs file is a citation instead, which
  // needs no entity of the page's own
  // a mind map's subject is declared with its type wherever the document names it
  const fm = mindMap ? withMindMapSubject(parsed.frontmatter, loadOntology(store.dataDir)) : parsed.frontmatter;
  const declaredWiki = wirePlan && (wirePlan.self || root === 'wiki') && (fm.relations || fm.claims || fm.entities)
    ? frontmatterExtraction(
      { relations: fm.relations, claims: fm.claims, entities: fm.entities },
      { defaultSource: wirePlan.self?.name, citationTarget: root === 'wiki' ? (v) => rawDocValue(file, v) : undefined },
    )
    : null;
  if (wirePlan && declaredWiki?.citations.length) {
    const ontology = loadOntology(store.dataDir);
    const typed = declaredWiki.citations.map((d) => ({ ...relationCitation(ontology, d), chunkId: null }));
    wirePlan.citations = dedupeCitations([...wirePlan.citations, ...typed]);
  }
  // a wiki page no generator owns depends on the files it cites (docs/design/37 §5); a view's inputs are its generator's
  let citeDeps: (CitationDepsPlan & { since?: string }) | null = root === 'wiki' && isSource && !isReservedWikiFile(file)
    ? await planCitationDeps(store, store.dataDir, raw)
    : null;
  // the same text re-applied (--reapply, a new embedding model, a version bump) keeps the baseline it was checked
  // against: otherwise a page whose cited files changed in the meantime would look clean afterwards
  if (citeDeps && live && live.sha === sha) {
    citeDeps = carryCitationBaseline(citeDeps, await readDeps(store, { kind: 'cites', id: file }), live);
  }
  const declared = root === 'docs' && isSource ? frontmatterExtraction(fm) : null;
  // tier-0 links what the graph already knows and mines the rest; both are
  // planned here (two reads) so the scope body only writes
  const tier0: Tier0Plan | null = root === 'docs' && isSource ? await planTier0(store, parsed, title) : null;
  if (tier0 && registry.hasHandlers('tier0.concepts')) {
    // the mined terms, before they become concept entities (docs/design/11)
    const filtered = await registry.filter('tier0.concepts', tier0.concepts, { path: file, root, dataDir: store.dataDir, text: parsed.body, frontmatter: parsed.frontmatter });
    tier0.concepts = [...new Set((Array.isArray(filtered) ? filtered : []).filter((c) => typeof c === 'string').map((c) => c.trim()).filter(Boolean))];
  }
  // what the map's tree says about the entities its nodes name; a wiki page's own entity is its root
  const mindMapPlan: MindMapPlan | null = mindMap && isSource && cls.graph && (root === 'docs' || root === 'wiki')
    ? await planDocumentMindMap(store, mindMap, parsed.frontmatter, wirePlan?.self ?? null)
    : null;
  const capabilityNotes = root === 'capabilities' ? parseCapabilityNotes(parsed) : [];
  // Trust follows the *document's* origin, not whoever happened to run this
  // sync. A note an agent wrote stays agent-written; sync is a mechanical
  // reconciliation, not the author. The writer of these exact bytes, when one
  // is on record (an agent through MCP — src/fs/sidecar.ts `originOf`), sets
  // the ceiling; frontmatter may say "agent" or "quarantined" outright, but
  // never raise a document above its writer: that is the agent's own text.
  // a converted original counts too: a page or PDF an agent had knode capture is on record as the agent's
  // (src/research/capture.ts); one nobody recorded costs nothing here, originOf returns before reading it
  const writer = root === 'traces' ? null : originOf(store.dataDir, file);
  const writerTier = tierForActor(writer?.actor ?? actor);
  const declaredTrust = typeof parsed.frontmatter.trust === 'string' && TRUST_TIERS.includes(parsed.frontmatter.trust as TrustTier)
    ? (parsed.frontmatter.trust as TrustTier)
    : typeof parsed.frontmatter.actor === 'string'
      ? tierForActor(parsed.frontmatter.actor)
      : undefined;
  // the same bytes applied again keep the tier their live scope has: a person
  // may have promoted it since (setScopeTrust), and re-reading is no new version
  const trust: TrustTier = live && live.sha === sha && live.trust
    ? live.trust
    : writerTier === 'quarantined' ? 'quarantined' : declaredTrust ?? writerTier;
  const declaredAcl = Array.isArray(parsed.frontmatter.acl) ? parsed.frontmatter.acl.map(String) : undefined;
  const tier1Part = root === 'docs' && isSource ? readSidecarPart(store.dataDir, file, 'tier1') : null;
  const tier1 = tier1Part ? replayableTier1(tier1Part, sha, raw.length) : null;
  // a re-apply recomputes tier-0; what a model has already read of this content is not read again
  const tier1Done = tier1Part?.status === 'done' && tier1Part.contentSha === sha;
  const queueTier1 = Boolean(opts.queueTier1) && !tier1 && !(opts.reapply && tier1Done);

  /* ── the document scope ── */
  let g = { entities: 0, relations: 0 };
  const res = await applyScope(
    store,
    { kind: 'doc', key: file },
    sha,
    {
      actor,
      at: opts.at,
      force: Boolean(live && (!sameModel || opts.reapply || citationsStale || citeDepsStale || mindMapStale)),
      keepProjectionOnReplace: true,
      trust,
      acl: declaredAcl,
      meta: {
        documentId: docId, embedModel: embedder.model, root, kind: cls.kind, title, dateRules: DOC_DATE_RULES,
        ...(root === 'wiki' ? { citations: CITATIONS_VERSION, citeDeps: CITE_DEPS_VERSION } : {}),
        ...(citeDeps && Object.keys(citeDeps.commits).length ? { citedCommits: citeDeps.commits } : {}),
        ...(citeDeps?.since ? { citedSince: citeDeps.since } : {}),
        ...(mindMapPlan ? { mindmap: MINDMAP_PLAN_VERSION } : {}),
      },
    },
    async (w) => {
      // counted afresh on every run: a transaction rolled back for a deadlock runs the body again
      g = { entities: 0, relations: 0 };
      await w.document(
        { id: docId, path: file, root, title, sha256: sha, mime: guessMime(file), bytes, chars: raw.length, language, kind: cls.kind, docDate },
        chunkRows,
        vectors,
        embedder.model,
      );
      // the page's own deps row set: replacing the scope restores the previous set first, so a page that stops
      // citing a file stops depending on it
      if (citeDeps?.deps.length) await w.deps({ kind: 'cites', id: file }, citeDeps.deps);
      if (wirePlan) {
        const s = await applyWirePlan(w, page, wirePlan, { extractor: 'tier0.wikilink' });
        g = { entities: g.entities + s.entities, relations: g.relations + s.relations };
        if (wirePlan.self && declaredWiki && (declaredWiki.entities.length || declaredWiki.relations.length || declaredWiki.claims.length)) {
          const dg = await applyExtraction(w, page, declaredWiki.entities, declaredWiki.relations, declaredWiki.claims, 'tier0.frontmatter', { docDate });
          g = { entities: g.entities, relations: g.relations + dg.relations };
        }
      }
      if (root === 'docs' && isSource) {
        // declared facts first: they carry names, types and aliases the concept
        // miner's bare terms then resolve onto instead of minting duplicates
        if (declared) {
          const dg = await applyExtraction(w, page, declared.entities, declared.relations, declared.claims, 'tier0.frontmatter', { docDate });
          g = { entities: g.entities + dg.entities, relations: g.relations + dg.relations };
        }
        // then links to typed entities the graph already knows, then the mined
        // placeholders; co-occurrence between them is derived from their mentions on read
        const lg = tier0 ? await wireLinks(w, page, tier0.links) : { entities: 0, ids: [] };
        const cg = await wireConcepts(w, page, tier0?.concepts ?? []);
        g = { entities: g.entities + lg.entities + cg.entities, relations: g.relations };
        if (queueTier1) await w.enqueueTier1(docId, segmentText(raw, config.extraction.segmentChars).length);
      }
      if (mindMapPlan) {
        const mg = await wireMindMap(w, page, mindMapPlan);
        g = { entities: g.entities + mg.entities, relations: g.relations + mg.relations };
      }
      // a capabilities/*.md file is an ordinary source *and* the semantic layer
      // over the capabilities it names: both halves belong to this one scope,
      // so removing the file retires the notes with it
      for (const note of capabilityNotes) await w.capabilityNote({ ...note, source_path: file });
    },
  );

  // a quarantined source cannot silently become the knowledge base's position:
  // where it disagrees with a trusted claim, the disagreement is recorded
  if (res.outcome === 'applied') await detectDisputes(store, res.scope.id);

  /* ── child scopes: human prose on a generated page, tier-1 replay ── */
  if (humanPlan) {
    const humanSha = crypto.createHash('sha256').update(cls.humanBody).digest('hex');
    let human = { entities: 0, relations: 0 };
    await applyScope(
      store,
      { kind: 'wiki-human', key: file },
      humanSha,
      { parentId: res.scope.id, actor, at: opts.at, meta: { documentId: docId } },
      async (w) => {
        human = await applyWirePlan(w, page, humanPlan, { extractor: 'human' });
      },
    );
    g = { entities: g.entities + human.entities, relations: g.relations + human.relations };
  }

  if (root === 'docs' && isSource) {
    // sidecar: chunk map + tier-0 extraction results; restore usage on rebuild
    const now = new Date().toISOString();
    const meta = updateSidecarPart(store.dataDir, file, 'meta', (m) => ({
      ...m!,
      title,
      docDate,
      contentSha256: sha,
      ingestedAt: now,
      chunks: chunkRows.map((c) => ({ id: c.id, seq: c.seq, tokenCount: c.tokenCount })),
    }));
    if (meta) {
      updateSidecarPart(store.dataDir, file, 'tier0', () => ({
        contentSha: sha,
        concepts: tier0?.concepts ?? [],
        linked: tier0?.links.map((l) => l.name) ?? [],
        wikilinks: extractWikilinks(parsed.body),
        extractedAt: now,
        declared: declared ? { entities: declared.entities, relations: declared.relations, claims: declared.claims } : null,
      }));
      await restoreUsageFromSidecar(store, docId, readSidecarPart(store.dataDir, file, 'usage'));
    }

    if (tier1) {
      // the replay goes through applyTier1Scope like a fresh extraction, so the
      // tier-0 placeholders it supersedes are retired the same way
      const lg = await applyTier1Scope(store, { path: file, sha256: sha }, page, { entities: tier1.entities, relations: tier1.relations, claims: tier1.claims ?? [] }, {
        model: tier1.model,
        at: opts.at,
        docDate,
        extractedAt: tier1.segmenter ? tier1.extractedAt : undefined,
        segments: tier1Segments(raw, tier1),
      });
      g = { entities: g.entities + lg.entities, relations: g.relations + lg.relations };
    }
  }

  const outcome: DocOutcome = { outcome: 'applied', chunks: chunkRows.length, entities: g.entities, relations: g.relations, scopeId: res.scope.id, sha };
  if (registry.hasHandlers('document.applied')) {
    await registry.emit('document.applied', {
      path: file, root, dataDir: store.dataDir, outcome: 'applied',
      chunks: outcome.chunks, entities: outcome.entities, relations: outcome.relations, scopeId: outcome.scopeId,
    });
  }
  return outcome;
}

/** Grounding ranges for a segmented tier-1 result (see applyExtraction). */
/**
 * A mind map, judged from its frontmatter alone: every unchanged document a
 * sync visits is asked, so the YAML is parsed only when a `type:` line in it
 * names a mind map.
 */
function looksLikeMindMap(raw: string): boolean {
  if (!raw.startsWith('---')) return false;
  const end = raw.indexOf('\n---', 3);
  return /^type:[ \t]*["']?mind[\s_-]*map/im.test(raw.slice(0, end < 0 ? 4_000 : end)) && isMindMapFrontmatter(parseFrontmatter(raw).frontmatter);
}

function tier1Segments(text: string, tier1: SidecarTier1): { text: string; ranges: { start: number; end: number }[] } | undefined {
  const ranges = segmentRangesOf(tier1);
  return ranges ? { text, ranges } : undefined;
}

async function ensureTier1Replay(store: Store, file: string, raw: string, sha: string, docId: string, opts: ApplyDocOptions): Promise<void> {
  const tier1 = replayableTier1(readSidecarPart(store.dataDir, file, 'tier1'), sha, raw.length);
  if (!tier1) return;
  const child = await findLiveScope(store, 'tier1', file);
  // the live scope already carries this result (a segmented one names its extractedAt)
  if (child && child.sha === sha && (!tier1.segmenter || child.meta.extractedAt === tier1.extractedAt)) return;
  const chunks = await store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [docId]);
  const [docRow] = await store.query<{ doc_date: string | Date | null }>(`SELECT doc_date FROM documents WHERE id = $1`, [docId]);
  const docDate = docRow?.doc_date ? new Date(docRow.doc_date).toISOString() : null;
  const page: PageContext = { documentId: docId, path: file, title: path.basename(file), chunkIds: chunks };
  await applyTier1Scope(store, { path: file, sha256: sha }, page, { entities: tier1.entities, relations: tier1.relations, claims: tier1.claims ?? [] }, {
    model: tier1.model,
    at: opts.at,
    force: true,
    docDate,
    extractedAt: tier1.segmenter ? tier1.extractedAt : undefined,
    segments: tier1Segments(raw, tier1),
  });
}

export function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.jsonl': 'application/jsonl', '.yaml': 'text/yaml',
    '.yml': 'text/yaml', '.csv': 'text/csv', '.html': 'text/html', '.pdf': 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}
