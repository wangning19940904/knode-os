import { defaultAskRouterConfig, KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { ClaimItem, SearchResult } from '../types.js';
import { graphSearch } from '../graph/query.js';
import { EXCERPT_CHARS, excerptsForQuestion, isListQuestion } from './excerpts.js';
import { factsForQuestion, namedEntities, namedSurface, QuestionFact } from './facts.js';
import { search, SearchMode } from './search.js';
import { EnumeratedClaim, Enumeration, enumerateClaims, typesInQuestion } from './enumerate.js';
import { ComputedSet, computeClaimSet, SET_BUDGET_MS } from './claimset.js';
import { secondRound } from './second.js';
import { asksLatest, newestSources } from './newest.js';
import { PASSAGE_MAX, widenPassages } from './passages.js';
import { isChainQuestion, QuestionKind, QuestionRoute, questionRange, routeQuestion } from './route.js';
import { stepsAsFacts, walkRelations } from './walk.js';

/** Characters of a retrieved passage the answering model is shown. */
export const ASK_CONTEXT_CHARS = 1500;

export interface AskResult {
  answer: string;
  /** What the answer cited: a retrieved chunk, or a known fact by its source (then `chunkId` is the chunk it was read from, '' when that is gone). */
  citations: { ref: number; path: string; chunkId: string }[];
  gaps: string[];
  contexts: SearchResult[];
  facts: ClaimItem[];
  /** How the question was routed and what each route did (docs/design/30). */
  route: AskRoute;
  /** The set, count or value computed from the claims for this question, when it asks for one (docs/design/34 §1). */
  computed?: ComputedSet;
}

export interface AskRoute {
  kind: QuestionKind;
  /** Which rule, the model, or the caller decided; `fallback:…` when a route found nothing and the lookup path answered. */
  by: string;
  range: QuestionRoute['range'];
  /** For list, aggregate and timeline: what the enumeration matched and listed. */
  enumerated?: { matched: number; listed: number; documents: number; capped: boolean; types: string[]; entities: number };
  /** For multi-hop: the relations walked and the entities reached. */
  walked?: {
    hops: number; relations: number; reached: number; bridges: number;
    /** What the question ordered ("第二起"), the hop it ordered, and each branch's pick or why there was none. */
    ordering?: { asked: string; hop: number | null; picks: string[] };
    /** The walk's time budget was spent before it finished: what it stopped before, after how long. */
    spent?: { budgetMs: number; ms: number; before: string };
  };
  /** For a question asking for a set, a count or a value as of a date: what the claims gave (docs/design/34 §1). */
  computed?: { op: string; scope: string; matched: number; items: number; rows: number; ms: number };
  /** A set the question asks for that was not computed because its time budget ran out: the answer may be incomplete. */
  computedSkipped?: { why: string; budgetMs: number; ms: number };
  /** When the first round was thin: what the second found, and why it ran (docs/design/34 §2). */
  second?: { chunks: number; facts: number; from: string[]; uncoveredNamed: string[]; missingTerms: string[]; statements: number; ms: number };
  /** The documents behind the first passages read further before the answer (search/passages.ts): how many, and the characters added. */
  widened?: { documents: number; chars: number };
  /** For a question asking for the latest state: the newest sources about what it names, put first (search/newest.ts). */
  newest?: { path: string; date: string | null }[];
}

const ASK_SYSTEM = `You answer questions from a personal knowledge base. You are given retrieved context chunks, each tagged [n] with its path and, when known, its source's date — one marked "excerpt" holds only the lines of its document that name what the question asks about, one marked "widened" holds more of its document than the search returned (the parts are in document order; "[…]" marks a gap) — and optionally a "Known facts" list: claims extracted from the whole knowledge base, each tagged [n] too, with its date and the document it comes from. The facts reach documents the chunks do not; a question that asks for every case, a list or a history is answered from both.

Rules:
- Answer in the question's language, concise but complete. Lead with the answer, then the caveats.
- Cite evidence inline as [n] after the claims it supports. Only cite chunks and facts you actually used.
- Known facts marked [suspected] or [disputed] are unverified — if you use one, explicitly flag the uncertainty in your answer. One marked [opinion], [prediction] or [rumor] is a view, a forecast or hearsay from the sources, not an established fact: say so when you use it.
- Answer from what the context states and from what follows from it in a step: compute a figure the question asks for from the figures given (a sum, difference, ratio, margin, average, growth rate, unit conversion, count, or the time between two dates) and show the calculation in one line; to compare, state each side's value with its source, then the comparison. A table may name a figure differently from the question (capital expenditures as "purchases of property and equipment"; 资本开支 as 购建固定资产…支付的现金): use the row that is that figure and say which row it is. A question that needs such a step is answerable: take the step, do not decline it.
- Answer every part of the question the context supports. Say "not in the knowledge base" only of a part for which no chunk or fact states the answer or what it can be computed from; one missing part does not make the rest unanswerable.
- Never guess: a value that is neither stated nor computable from the context is missing, whatever you know otherwise — do not fill it from memory or from another company's, period's or document's figure, and do not present an estimate as the value.
- If the context is contradictory, say so and give each side with its source.
- End with a JSON line: {"citations":[n,...],"gaps":["what the knowledge base is missing to answer better", ...]} (gaps may be empty).`;

/** The rule an enumerated answer adds: the facts are the whole match, and the counts are over it. */
const ENUMERATED_RULE = `
- Known facts marked "enumerated" are every claim the knowledge base holds about what the question names (in the period it names): answer a list with every relevant item, merging the same item stated by several sources; count distinct items or events, not lines; the "Counts" section is computed over all matching claims, including any not listed. A fact marked "replaced later" was true until a newer fact replaced it: use it for history, not as the current state.`;

/** The rule the newest sources add (search/newest.ts): the question asks for the latest state, and these are the newest sources about it. */
const NEWEST_RULE = `
- A chunk marked "newest" is from the most recent dated source the knowledge base holds about what the question names; "next newest" is the one before it; "newest with all the question's words" is the most recent holding everything the question asks about, which may be older. The question asks for the latest or current state: answer from the newest source that states it, and say the date it is as of. An older chunk, page or fact that gives another value is the earlier state, not a contradiction, unless it is dated later; a line saying what a value was first set at or used to be states an earlier value, however new the source restating it, and the current value is the latest change dated before the newest source. What the question asks of "the latest report" — a figure, a count, the items still open — is read from that report itself.`;

/**
 * A set left uncomputed past its time budget. On PGlite (WASM on this thread) no timer fires while a statement runs,
 * so the budget is overrun by the statement under way when it passes; on PostgreSQL the wait ends at the budget
 * and the statement finishes on the server, unwaited.
 */
interface SpentBudget { budgetMs?: number; ms?: number }
const OVER_BUDGET_GAP = 'The set the question asks for was not computed from the claims (its time budget ran out): the answer may be incomplete.';
const renderOverBudget = (s: Required<SpentBudget>) =>
  `\n\n# Computed from the claims\nNot computed: its time budget of ${s.budgetMs} ms ran out (after ${s.ms} ms). The facts above were not checked to hold every item or reading the question asks for: say that the answer may be incomplete.`;

/** Compute the set a question asks for, noting in `spent` when its time budget ran out. */
function computeSet(store: Store, question: string, routed: Pick<QuestionRoute, 'kind' | 'range'>, named: string[], now: string | undefined, router: ReturnType<typeof defaultAskRouterConfig>, spent: SpentBudget): Promise<ComputedSet | null> {
  const started = Date.now();
  const budgetMs = router.computedBudgetMs ?? SET_BUDGET_MS;
  return computeClaimSet(store, question, routed, named, {
    now, budgetMs,
    skipped: (why) => { if (why === 'over its time budget') Object.assign(spent, { budgetMs, ms: Date.now() - started }); },
  }).catch(() => null);
}

/** The rule a computed set adds: its counts and values were computed in code over every matching claim. */
const COMPUTED_RULE = `
- The "Computed from the claims" section was computed in code over the claims of the scope it names that matched the question by the attributes and words it lists (each row is among the known facts marked "set", with its own kind and status): use its figures only where that match is what the question asks, and say which items it lists; a row from a source you were not shown in full is still evidence. What it says it left out (forecasts, replaced or other-unit figures) is not in its figures. If its scope or its match is not what the question asks, say so and answer from the rest.`;

/** The computed set as the prompt shows it: what was matched, where, and the lines of the answer. */
function renderComputed(c: ComputedSet): string {
  return `\n\n# Computed from the claims\nScope: ${c.scope}. Matched by ${c.matchedBy.join(', ') || 'nothing'}: ${c.matched} claims${c.capped ? ' (the scope was larger than read)' : ''}.\n${c.lines.join('\n')}`;
}

/** The rows of a computed set as known facts, each with every source. */
function computedFacts(c: ComputedSet): PromptFact[] {
  return c.rows.map((r) => ({
    id: r.id, subject: r.subject, object: r.object, type: 'set', statement: r.statement, status: r.status, kind: r.kind,
    startDate: null, endDate: null, eventDate: null, date: r.date, path: r.sources[0] ?? null, sources: r.sources, superseded: r.superseded, chunkId: null,
  }));
}

/** `[fact]` / `[suspected]` for a fact; a view, forecast or rumour is tagged by its kind, with the status when hedged. */
export function claimTag(c: { status: string; kind?: string | null }): string {
  const kind = c.kind ?? 'fact';
  if (kind === 'fact') return c.status;
  return c.status === 'fact' ? kind : `${kind}, ${c.status}`;
}

/** A fact as the prompt may list it: a claim, an enumerated claim, or a relation walked. */
type PromptFact = ClaimItem & { chunkId?: string | null; superseded?: boolean; sources?: string[]; date?: string | null; repeats?: { count: number; dates: string[] } };

/** The facts as the prompt lists them: numbered on from the chunks, each with its tag, date and source. */
function renderFacts(facts: PromptFact[], firstRef: number, heading = 'Known facts'): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f, i) => {
    const period = f.startDate || f.endDate ? ` (${f.startDate ?? '?'} ~ ${f.endDate ?? ''})` : '';
    const when = f.eventDate ? ` (${f.eventDate})` : f.date && !period ? ` (${f.date})` : period;
    const more = f.sources && f.sources.length > 1 ? ` (+${f.sources.length - 1} more source${f.sources.length > 2 ? 's' : ''})` : '';
    // a folded timeline entry: the same value restated later, said once with how long it was restated
    const again = f.repeats && f.repeats.count > 1 ? ` (restated ${f.repeats.count - 1}×${f.repeats.dates.length > 1 ? `, last ${f.repeats.dates[f.repeats.dates.length - 1]}` : ''})` : '';
    return `[${firstRef + i}] [${claimTag(f)}${f.type === 'set' ? '; set' : ''}${f.superseded ? '; replaced later' : ''}] ${f.statement}${when}${again}${f.path ? ` — ${f.path}${more}` : ''}`;
  });
  return `\n\n# ${heading}\n${lines.join('\n')}`;
}

/** The counts an enumerated answer is given: over every match, not over the claims listed. */
function renderCounts(e: Enumeration, kind: QuestionKind): string {
  const total = `${e.capped ? 'at least ' : ''}${e.matched} matching claims from ${e.documents} documents`;
  const row = (label: string, groups: [string, number][]) => (groups.length > 1 ? `\n${label}: ${groups.map(([k, n]) => `${k} ${n}`).join(', ')}` : '');
  if (kind === 'list') return `\n\n# Counts\n${total}`;
  return `\n\n# Counts\n${total}${row('By month', e.byMonth)}${row('By claim type', e.byType)}${row('By subject', e.bySubject)}`;
}

/** The claims that replaced claims the retrieved passages state, as facts, when the facts do not hold them yet. */
function currentFacts(contexts: SearchResult[], facts: ClaimItem[]): PromptFact[] {
  const have = new Set(facts.map((f) => f.id));
  const out: PromptFact[] = [];
  for (const c of contexts) {
    for (const cur of c.current ?? []) {
      if (have.has(cur.now.id)) continue;
      have.add(cur.now.id);
      out.push({
        id: cur.now.id, subject: '', object: null, type: 'current', statement: `${cur.now.statement} (replaces: ${cur.was.statement})`,
        status: 'fact', startDate: null, endDate: null, eventDate: cur.now.date, path: cur.now.path, chunkId: null,
      });
    }
  }
  return out.slice(0, 8);
}

/**
 * RAG answer with citations and explicit gap analysis (gbrain's `think`),
 * routed by the kind of question (docs/design/30):
 *
 *   lookup     selectable retrieval (hybrid by default, SAG opt-in) + graph
 *              expansion → budgeted context → cited synthesis. One search,
 *              one completion: what every question got before the router.
 *   list / aggregate / timeline
 *              the claims about what the question names, enumerated by SQL
 *              (entity, claim type, time window) with counts over the whole
 *              match, beside a short search and the excerpts; falls back to
 *              the lookup path when nothing is enumerated.
 *   multihop   SAG search plus a bounded relation walk from the named
 *              entities, with the passages that state each hop.
 *
 * Every route ends in the same single completion. Routing costs no model
 * call unless `retrieval.router.classifier` is `model` (then at most one).
 */
export async function ask(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  question: string,
  opts: {
    k?: number;
    mode?: SearchMode;
    /** The question's embedding, when the caller has it already. */
    queryVector?: number[];
    /** Known facts listed at most (default 24; an enumerated answer lists up to `retrieval.router.enumerateLimit`). */
    facts?: number;
    /** Characters of excerpts for a list question at most (default `EXCERPT_CHARS`; 0 for none). */
    excerpts?: number;
    /** Route the question this way instead of classifying it; `auto` (default) classifies. */
    route?: QuestionKind | 'auto';
    /** false: its searches record no hits (an evaluation answering against the index as built, docs/design/31 D3). */
    track?: boolean;
    /** false: no second retrieval round however thin the first; true: one whatever `retrieval.router.secondRound` says (docs/design/34 §2). */
    second?: boolean;
    /** true / false: compute a set, count or value from the claims, whatever `retrieval.router.computedSets` says (docs/design/34 §1). */
    computed?: boolean;
    /** The day relative periods ("去年", "三季度", "last 3 months") are read from (YYYY-MM-DD); default today. An evaluation of a past corpus sets its own. */
    now?: string;
    /** false: show the chunks as the search cut them, without reading further into their documents (search/passages.ts). */
    widen?: boolean;
    /** false: no newest sources for a question asking for the latest state (search/newest.ts). */
    newest?: boolean;
  } = {},
): Promise<AskResult> {
  const router = { ...defaultAskRouterConfig(), ...config.retrieval.router };
  const mode = opts.mode ?? 'hybrid';
  // embedded once, for the search and for ranking the facts; a provider that cannot serve it leaves both to their other signals
  let queryVector = opts.queryVector;
  if (!queryVector && mode !== 'keyword') {
    try {
      queryVector = (await embedder.embed([question]))[0];
    } catch {
      queryVector = undefined;
    }
  }
  const routed: QuestionRoute = opts.route && opts.route !== 'auto'
    ? { kind: opts.route, range: questionRange(question), by: 'caller' }
    : await routeQuestion(question, { classifier: router.classifier, llm });
  // a set, a count or a value as of a date is computed from the claims, whichever route answers the rest
  const named = await namedEntities(store, question);
  const computing = opts.computed ?? router.computedSets === true;
  const spent: SpentBudget = {};
  const computed = computing && (routed.kind === 'list' || routed.kind === 'aggregate' || routed.kind === 'lookup')
    ? await computeSet(store, question, routed, named, opts.now, router, spent)
    : null;
  const env: RouteEnv = { store, config, embedder, llm, question, opts, queryVector, router, routed, named, computed, spent };

  if (routed.kind === 'list' || routed.kind === 'aggregate' || routed.kind === 'timeline') {
    const enumerated = await enumeratedAnswer(env);
    if (enumerated) return enumerated;
    return lookupAnswer({ ...env, routed: { ...routed, by: `fallback:${routed.by}` } });
  }
  if (routed.kind === 'multihop') return multihopAnswer(env);
  return lookupAnswer(env);
}

interface RouteEnv {
  store: Store;
  config: KnodeConfig;
  embedder: EmbeddingProvider;
  llm: LlmClient;
  question: string;
  opts: { k?: number; mode?: SearchMode; facts?: number; excerpts?: number; track?: boolean; second?: boolean; computed?: boolean; now?: string; widen?: boolean; newest?: boolean };
  queryVector: number[] | undefined;
  router: ReturnType<typeof defaultAskRouterConfig>;
  routed: QuestionRoute;
  /** The entities the question names (`namedEntities`). */
  named: string[];
  /** The set the claims gave, when the question asks for one. */
  computed: ComputedSet | null;
  /** Filled when a set was asked for and its time budget ran out. */
  spent: SpentBudget;
}

const routeOf = (r: QuestionRoute, extra: Partial<AskRoute> = {}): AskRoute => ({ kind: r.kind, by: r.by, range: r.range, ...extra });

/** The single-shot path: one search, a depth-2 graph search, ranked facts, excerpts for a list question. */
async function lookupAnswer(env: RouteEnv): Promise<AskResult> {
  const { store, config, embedder, question, opts, queryVector } = env;
  const k = opts.k ?? 8;
  const mode = opts.mode ?? 'hybrid';
  const [retrieved, graph, named] = await Promise.all([
    search(store, embedder, question, { k, mode, heat: config.heat, sag: config.retrieval.sag, rerank: config.retrieval.rerank, queryVector, track: opts.track }),
    graphSearch(store, question, { depth: 2, chunkLimit: 4, heat: config.heat, track: opts.track }),
    Promise.resolve(env.named),
  ]);
  const seen = new Set(retrieved.map((r) => r.chunkId));
  const found = [...retrieved, ...graph.chunks.filter((c) => !seen.has(c.chunkId))].slice(0, k + 4);
  // a question asking for every case is answered from many documents: more kinds of fact, and the lines of
  // further documents that name what it asks about
  const list = isListQuestion(question);
  const excerptBudget = list ? (opts.excerpts ?? EXCERPT_CHARS) : 0;
  const [facts, excerpts]: [QuestionFact[], SearchResult[]] = await Promise.all([
    factsForQuestion(store, question, found, { limit: opts.facts, queryVector, model: embedder.model, named, list }),
    excerptBudget > 0
      ? namedSurface(store, named).then((s) => excerptsForQuestion(store, question, found, { budget: excerptBudget, names: s.names, namedDocs: s.docs }))
      : Promise.resolve([]),
  ]);
  const contexts = [...found, ...excerpts];
  return compose(env, contexts, [...facts, ...currentFacts(contexts, facts)], '', routeOf(env.routed));
}

/**
 * List, aggregate and timeline: the enumeration of the claims about the named
 * entities (or of the claim types the question names), the relevance-ranked
 * facts a list question gets (relations, neighbours, variants), a short
 * search and the excerpts. Null when nothing is enumerated.
 */
async function enumeratedAnswer(env: RouteEnv): Promise<AskResult | null> {
  const { store, config, embedder, question, opts, queryVector, router, routed, named } = env;
  const types = await typesInQuestion(store, question);
  if (named.length === 0 && types.length === 0) return null;
  const timeline = routed.kind === 'timeline';
  const limit = Math.max(1, router.enumerateLimit);
  // a timeline lists the subject's changes: a value restated in later reports is one fact with its dates, not a
  // fact per report, so the limit holds the history rather than its first weeks (graph/claim-timeline.ts)
  const query = { entities: named, types, range: routed.range, includeSuperseded: timeline, order: 'timeline' as const, limit, fold: timeline };
  let enumeration = await enumerateClaims(store, query);
  let usedTypes = types;
  // a type the question seems to name, but no claim of it about these entities: every type
  if (enumeration.matched === 0 && types.length > 0 && named.length > 0) {
    enumeration = await enumerateClaims(store, { ...query, types: [] });
    usedTypes = [];
  }
  if (enumeration.matched === 0) return null;

  // the passages: a short search, not the top eight, and the lines of the named entities' other documents
  const k = Math.min(opts.k ?? 8, 4);
  const retrieved = await search(store, embedder, question, { k, mode: opts.mode ?? 'hybrid', heat: config.heat, sag: config.retrieval.sag, rerank: config.retrieval.rerank, queryVector, track: opts.track });
  const excerptBudget = opts.excerpts ?? EXCERPT_CHARS;
  const [ranked, excerpts]: [QuestionFact[], SearchResult[]] = await Promise.all([
    factsForQuestion(store, question, retrieved, { limit, queryVector, model: embedder.model, named, list: true }),
    excerptBudget > 0 && named.length > 0
      ? namedSurface(store, named).then((s) => excerptsForQuestion(store, question, retrieved, { budget: excerptBudget, names: s.names, namedDocs: s.docs }))
      : Promise.resolve([]),
  ]);
  const inRange = (f: { eventDate?: string | null; startDate: string | null }) => {
    const d = f.eventDate ?? f.startDate;
    if (!routed.range || !d) return true;
    return (!routed.range.from || d >= routed.range.from.slice(0, 10)) && (!routed.range.to || d <= routed.range.to.slice(0, 10));
  };
  const relevant = ranked.filter(inRange);
  const enumerated = new Set(enumeration.claims.map((c) => c.id));

  let facts: PromptFact[];
  if (timeline) {
    // one chronology: the enumerated claims and the ranked facts the enumeration does not hold, oldest first
    const dateOf = (f: PromptFact) => f.date ?? f.eventDate ?? f.startDate ?? null;
    const extra = relevant.filter((f) => !enumerated.has(f.id)).slice(0, Math.ceil(limit / 4));
    facts = [...enumeration.claims, ...extra]
      .map((f, i) => ({ f, i }))
      .sort((a, b) => {
        const da = dateOf(a.f);
        const db = dateOf(b.f);
        if (da && db && da !== db) return da < db ? -1 : 1;
        if (!da !== !db) return da ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.f);
  } else {
    // the best-matching facts first (a third of the room), then every enumerated claim, then the rest of the ranked
    const head = relevant.slice(0, Math.ceil(limit / 3));
    const inHead = new Set(head.map((f) => f.id));
    const rest: PromptFact[] = enumeration.claims.filter((c) => !inHead.has(c.id));
    const tail = relevant.slice(head.length).filter((f) => !enumerated.has(f.id));
    facts = [...head, ...rest, ...tail].slice(0, limit);
  }
  const byId = new Map<string, EnumeratedClaim>(enumeration.claims.map((c) => [c.id, c]));
  facts = facts.map((f) => byId.get(f.id) ?? f);

  const contexts = [...retrieved, ...excerpts];
  const listed = facts.filter((f) => enumerated.has(f.id)).length;
  const heading = `Known facts (enumerated: ${listed} of ${enumeration.capped ? 'at least ' : ''}${enumeration.matched} matching claims listed${routed.range ? `, ${routed.range.text}` : ''})`;
  return compose(env, contexts, [...facts, ...currentFacts(contexts, facts)], renderCounts(enumeration, routed.kind), routeOf(routed, {
    enumerated: { matched: enumeration.matched, listed, documents: enumeration.documents, capped: enumeration.capped, types: usedTypes, entities: named.length },
  }), heading);
}

/** Entities the walk reached that a chain's computed set may be scoped to, at most. */
const CHAIN_SET_SCOPES = 8;

/**
 * Multi-hop: SAG search, and a bounded walk over the named entities' relations with the passages stating each
 * hop, beside what the lookup route would have found for the same question (the set the claims compute, the
 * depth-2 graph search, the excerpts of a list question): a question the walk cannot help loses nothing by
 * being routed to it.
 */
async function multihopAnswer(env: RouteEnv): Promise<AskResult> {
  const { store, config, embedder, question, opts, queryVector, router, named } = env;
  const k = opts.k ?? 8;
  // the SAG search needs the question's embedding: without one (the embedder down, or keyword asked for) the caller's
  // mode answers, whose hybrid search falls back to the keyword and graph channels as the lookup route's does
  const asked = opts.mode ?? 'hybrid';
  const mode: SearchMode = asked === 'keyword' ? 'keyword' : queryVector ? 'sag' : 'hybrid';
  const chain = isChainQuestion(question);
  const [retrieved, walk, graph, setFirst] = await Promise.all([
    search(store, embedder, question, { k, mode, heat: config.heat, sag: config.retrieval.sag, rerank: config.retrieval.rerank, queryVector, track: opts.track }),
    walkRelations(store, question, named, { maxHops: router.maxHops, queryVector, model: embedder.model, now: opts.now }),
    graphSearch(store, question, { depth: 2, chunkLimit: 4, heat: config.heat, track: opts.track }),
    // a walked question gets a computed set too, under the same switch, reference day and time budget as any other;
    // a chain's waits for the walk (below)
    env.computed ? Promise.resolve(env.computed)
      : (opts.computed ?? router.computedSets === true) && !chain
        ? computeSet(store, question, { kind: 'lookup', range: env.routed.range }, named, opts.now, router, env.spent)
        : Promise.resolve(null),
  ]);
  // a chain ("平台组的INC-001是谁修复的？此人还修复过哪些事故？") asks for the set of what it finds, not of what it names
  // first: its set is computed over the entities the walk reached, and kept only when it is scoped to one of them
  let computed = setFirst;
  if (chain && !env.computed && (opts.computed ?? router.computedSets === true)) {
    const found = walk.reached.filter((id) => !named.includes(id)).slice(0, CHAIN_SET_SCOPES);
    const set = found.length ? await computeSet(store, question, { kind: 'lookup', range: env.routed.range }, found, opts.now, router, env.spent) : null;
    const names = set ? new Set((await store.query<{ name: string }>(`SELECT name FROM entities WHERE id = ANY($1::text[])`, [found])).map((r) => r.name)) : new Set<string>();
    computed = set && set.scope && names.has(set.scope) ? set : null;
  }
  const seen = new Set(retrieved.map((r) => r.chunkId));
  // the passages that state the hops share the top of the context with the search: a chain's later hops are
  // rarely what a search of the whole question finds; the graph search's chunks come after both
  const bridges = walk.bridges.filter((c) => !seen.has(c.chunkId));
  for (const b of bridges) seen.add(b.chunkId);
  const fromGraph = graph.chunks.filter((c) => !seen.has(c.chunkId));
  const half = Math.ceil(k / 2);
  const found = [...retrieved.slice(0, half), ...bridges.slice(0, k - half), ...retrieved.slice(half), ...bridges.slice(k - half), ...fromGraph].slice(0, k + 4);
  const list = isListQuestion(question);
  const excerptBudget = list ? (opts.excerpts ?? EXCERPT_CHARS) : 0;
  const [ranked, excerpts]: [QuestionFact[], SearchResult[]] = await Promise.all([
    factsForQuestion(store, question, found, { limit: opts.facts, queryVector, model: embedder.model, named: [...named, ...walk.reached], list }),
    excerptBudget > 0
      ? namedSurface(store, named).then((s) => excerptsForQuestion(store, question, found, { budget: excerptBudget, names: s.names, namedDocs: s.docs }))
      : Promise.resolve([]),
  ]);
  const contexts = [...found, ...excerpts];
  const steps = stepsAsFacts(walk.steps);
  const stepIds = new Set(steps.map((s) => s.id));
  // what the walk ordered is its own computation, said apart from the sources' facts: what it took, from how many,
  // by which date, or why it took nothing
  const ordering: PromptFact[] = (walk.ordering?.picks ?? []).map((pick, i) => ({
    id: `ordering:${i}`, subject: '', object: null, type: 'ordering', status: 'computed', kind: 'fact',
    statement: `Ordered by the walk from the dates the sources state (no source states this order): ${walk.ordering!.asked} — ${pick}`,
    startDate: null, endDate: null, eventDate: null, path: null, chunkId: null,
  }));
  // a walk cut short by its time budget says where it stopped: what lies past it was not looked for, not absent
  if (walk.spent) {
    ordering.push({
      id: 'walk:spent', subject: '', object: null, type: 'walk', status: 'computed', kind: 'fact',
      statement: `The relation walk stopped before ${walk.spent.before}: its time budget (${walk.spent.budgetMs} ms) was spent after ${walk.spent.ms} ms; relations past that point were not looked for`,
      startDate: null, endDate: null, eventDate: null, path: null, chunkId: null,
    });
  }
  const facts: PromptFact[] = [...ordering, ...steps, ...ranked.filter((f) => !stepIds.has(f.id))];
  return compose({ ...env, computed }, contexts, [...facts, ...currentFacts(contexts, facts)], '', routeOf(env.routed, {
    walked: {
      hops: walk.steps.reduce((n, s) => Math.max(n, s.hop), 0), relations: walk.steps.length, reached: walk.reached.length, bridges: walk.bridges.length,
      ...(walk.ordering ? { ordering: walk.ordering } : {}),
      ...(walk.spent ? { spent: walk.spent } : {}),
    },
  }));
}

/** A passage's header in the prompt: its path, its source's date, and what it is (newest, excerpt, widened). */
export function passageLabel(c: SearchResult): string {
  const parts = [c.path];
  if (c.docDate) parts.push(c.docDate);
  if (c.newest) parts.push(c.newest.rank === 1 ? 'newest' : c.newest.full ? 'newest with all the question\'s words' : 'next newest');
  if (c.excerpt) parts.push('excerpt');
  else if (c.widened) parts.push('widened');
  return parts.join(', ');
}

/** The one completion every route ends in, and its citations. */
async function compose(env: RouteEnv, firstContexts: SearchResult[], firstRanked: PromptFact[], counts: string, routedFirst: AskRoute, heading?: string): Promise<AskResult> {
  const { llm, question, computed } = env;
  // a thin first round gets one more, from what it found; a computed set or a timeline is complete already
  let contexts = firstContexts;
  let ranked = firstRanked;
  let routed = routedFirst;
  // a question asking for the latest state is given the newest sources about what it names first: a search ranks
  // last year's report as high as last week's
  if (env.opts.newest !== false && asksLatest(question)) {
    const newest = await newestSources(env.store, question, env.named, { now: env.opts.now }).catch(() => []);
    if (newest.length > 0) {
      const lead = new Set(newest.map((c) => c.chunkId));
      contexts = [...newest, ...contexts.filter((c) => !lead.has(c.chunkId))];
      routed = { ...routed, newest: newest.map((c) => ({ path: c.path, date: c.docDate ?? null })) };
    }
  }
  if (!computed && routedFirst.kind !== 'timeline' && (env.opts.second ?? env.router.secondRound !== false)) {
    const more = await secondRound(env.store, question, {
      named: env.named, contexts, facts: ranked, chain: routedFirst.kind === 'multihop' || isChainQuestion(question),
      queryVector: env.queryVector, model: env.embedder.model,
    }).catch(() => null);
    if (more) {
      contexts = [...contexts, ...more.chunks];
      ranked = [...ranked, ...more.facts];
      routed = { ...routed, second: { chunks: more.chunks.length, facts: more.facts.length, ...more.reason, statements: more.statements, ms: more.ms } };
    }
  }
  // the documents behind the first passages, read further: the row after a table's cut, the chunk naming what is asked
  if (env.opts.widen !== false) {
    const wide = await widenPassages(env.store, question, contexts).catch(() => null);
    if (wide && wide.documents > 0) {
      contexts = wide.contexts;
      routed = { ...routed, widened: { documents: wide.documents, chars: wide.chars } };
    }
  }
  // the computed set's rows lead the facts; what else was ranked follows, without repeating them
  const setRows = computed ? computedFacts(computed) : [];
  const inSet = new Set(setRows.map((f) => f.id));
  // a computed set's rows count toward the enumerate limit: the facts listed stay within it
  const facts = [...setRows, ...ranked.filter((f) => !inSet.has(f.id))].slice(0, computed ? Math.max(env.router.enumerateLimit, setRows.length) : undefined);
  // a set asked for and left uncomputed for time is said, in the prompt, the route and the gaps
  const overBudget = !computed && env.spent.ms !== undefined ? (env.spent as Required<SpentBudget>) : null;
  const extra = `${counts}${computed ? renderComputed(computed) : overBudget ? renderOverBudget(overBudget) : ''}`;
  const route: AskRoute = computed
    ? { ...routed, computed: { op: computed.op, scope: computed.scope, matched: computed.matched, items: computed.items, rows: setRows.length, ms: computed.ms } }
    : overBudget ? { ...routed, computedSkipped: { why: 'over its time budget', ...overBudget } } : routed;
  const budgetGap = overBudget ? [OVER_BUDGET_GAP] : [];
  const system = `${ASK_SYSTEM}${route.enumerated ? ENUMERATED_RULE : ''}${computed ? COMPUTED_RULE : ''}${contexts.some((c) => c.newest) ? NEWEST_RULE : ''}`;
  // what a reference number stands for: the chunks first, then the facts
  const refs = [
    ...contexts.map((c) => ({ path: c.path, chunkId: c.chunkId })),
    ...facts.map((f) => ({ path: f.path ?? '', chunkId: f.chunkId ?? '' })),
  ];

  if (!llm.enabled) {
    return {
      answer: 'The Judge stage has no model (Settings → Ingest, or extraction.judgeLlm in knode.config.json) — returning retrieved context only.',
      citations: contexts.map((c, i) => ({ ref: i + 1, path: c.path, chunkId: c.chunkId })),
      gaps: budgetGap,
      contexts,
      facts,
      route,
      ...(computed ? { computed } : {}),
    };
  }

  const contextBlock = contexts.map((c, i) => `[${i + 1}] (${passageLabel(c)})\n${c.content.slice(0, c.widened ? PASSAGE_MAX + 1 : ASK_CONTEXT_CHARS)}`).join('\n\n');
  const raw = await llm.complete([
    { role: 'system', content: system },
    { role: 'user', content: `# Context\n${contextBlock}${renderFacts(facts, contexts.length + 1, heading)}${extra}\n\n# Question\n${question}` },
  ], { maxTokens: route.enumerated || computed ? 3000 : 2000 });

  let answer = raw.trim();
  let gaps: string[] = [];
  let cited: number[] = [];
  const jsonMatch = answer.match(/\{["']citations["'][\s\S]*\}\s*$/);
  if (jsonMatch) {
    try {
      const meta = JSON.parse(jsonMatch[0]) as { citations?: number[]; gaps?: string[] };
      cited = (meta.citations ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= refs.length);
      gaps = (meta.gaps ?? []).map(String).slice(0, 5);
      answer = answer.slice(0, jsonMatch.index).trim();
    } catch {
      /* keep raw answer */
    }
  }
  if (cited.length === 0) {
    cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= refs.length);
  }
  return {
    answer,
    // a fact whose source is no longer known has nothing to cite
    citations: cited.filter((n) => refs[n - 1].path).map((n) => ({ ref: n, ...refs[n - 1] })),
    gaps: [...budgetGap, ...gaps],
    contexts,
    facts,
    route,
    ...(computed ? { computed } : {}),
  };
}
