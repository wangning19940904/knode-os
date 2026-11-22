import { unmeteredStop } from './score/usage.js';
import fs from 'node:fs';
import path from 'node:path';
import { mdTable } from '../bench/util.js';
import { chartBlock } from '../research/chart.js';
import { bootstrapMean, holm, mean, minimumDetectableEffect, pairedBootstrap, round, sd, wilson } from './metrics/stats.js';
import { describeAllocation, questionClasses, SAMPLE_TIERS, type AgentSample, type AnswerScore, type QuestionClass, type TypeEvidence, type TypeTaken } from './allocation.js';
import { fileLines, RunStore } from './runstore.js';
import { judgeItemKey } from './score/keys.js';
import { SYSTEMS } from './systems/index.js';
import { toolsOf, toolUse, type ToolUse } from './trace.js';
import { CORPUS_TASK_TYPES, SEPARATION_TASK_TYPES, type BuildRecord, type ScoreRecord } from './types.js';

/**
 * `knode-os eval report` (docs/design/23 §8): everything a run measured,
 * aggregated from its JSONL records — so every number in the report can be
 * traced back to `scores.jsonl`, `answers.jsonl` and `builds.jsonl`.
 */

/** The system that answers for a build group, for per-query cost and break-even. */
const GROUP_ANSWERER: Record<string, string> = { knode: 'knode-ask', 'llm-wiki': 'agent-wiki', rag: 'rag-hybrid', graphrag: 'graphrag', lightrag: 'lightrag', hipporag: 'hipporag' };
export const BASELINE = 'agent-grep';

const USAGE_METRICS = ['correctness', 'em', 'f1', 'keypoint_recall', 'citation_precision', 'citation_recall', 'abstain_correct', 'false_refusal', 'truthfulness', 'hallucinated', 'confident_wrong', 'stale_answer', 'injection_success'] as const;
const LIST_METRICS = ['correctness', 'set_precision', 'set_recall', 'set_f1', 'order_accuracy', 'date_accuracy', 'attribution_recall', 'items_returned', 'em'] as const;
/** What separates a compiled knowledge base from a lookup (docs/design/28), per pack and system. */
const SEPARATION_METRICS = ['correctness', 'stale_answer', 'confident_wrong', 'distractor_rate', 'citation_precision'] as const;
const RATE_METRICS = ['correctness', 'em', 'abstain_correct', 'false_refusal', 'hallucinated', 'label_correct', 'all@5', 'injection_success', 'confident_wrong', 'stale_answer'];
/** Queries a build is amortized over in the cost-normalized table. */
export const AMORTIZE_AT = [100, 1000] as const;

/** The build group a system answers from (its build's cost is its own), or none. */
export function groupOf(system: string): string | null {
  try {
    return SYSTEMS[system]?.().group ?? null;
  } catch {
    return null;
  }
}
const RETRIEVAL_METRICS = ['recall@2', 'recall@5', 'all@5', 'mrr@10', 'ndcg@10'] as const;
const EMERGENCE_METRICS = ['label_correct', 'set_recall', 'set_precision', 'set_f1', 'set_recall_latent', 'terms_precision_at_10', 'grounded_share', 'brier'] as const;
const GENERATION_METRICS = ['coverage', 'precision', 'attribution_precision', 'link_precision', 'link_recall', 'duplicate_rate', 'over_merge', 'er_bcubed_precision', 'er_bcubed_recall', 'er_bcubed_f1', 'er_found', 'contradiction_rate', 'contradicted_rate', 'compression', 'units', 'units_with_sources', 'links_per_page', 'orphan_page_rate'] as const;

export interface Cell {
  value: number | null;
  n: number;
  ci?: [number, number];
}

export interface Efficiency {
  correctness: number | null;
  /** Mean weighted tokens per query over the system's own answers. */
  queryTokens: number;
  per1k: number | null;
  buildTokens: number;
  /** null: the build never pays back (the system costs as much per query as agent-grep, or more). */
  breakEven: number | null;
  amortized: Record<string, number | null>;
  n: number;
}

export interface Paired {
  system: string;
  diff: number;
  ci: [number, number];
  p: number;
  n: number;
  /** The smallest delta this many paired tasks could detect (α 0.05, power 0.8). */
  mde: number;
}

export interface Variance {
  repeats: number;
  /** Mean correctness of each repeat, in repeat order. */
  perRepeat: number[];
  /** Standard deviation of the repeats' mean correctness. */
  sdAcrossRepeats: number;
  /** Mean over tasks of the standard deviation of a task's correctness across repeats. */
  withinTaskSd: number;
  /** Share of tasks whose correctness differs between repeats. */
  unstable: number;
  tasks: number;
}

/** Two repeated systems on the tasks both answered in every repeat (`--repeat`, `--repeat-sample`). */
export interface RepeatPair {
  a: string;
  b: string;
  tasks: number;
  /** Mean correctness of a minus b, per repeat. */
  perRepeat: number[];
  /** The mean of those: the paired difference on the sample. */
  diff: number;
  /** Each system's run-to-run spread on these tasks: the SD across repeats of its mean correctness. */
  spreadA: number;
  spreadB: number;
  /** The spread of a single run's difference that rerunning both alone gives: √(spreadA² + spreadB²). */
  noise: number;
  /** The difference is within the run-to-run spread: the per-repeat differences change sign, or |diff| ≤ 2 × noise. */
  withinSpread: boolean;
}

/**
 * The five differences declared before a run (docs/design/33 §2), each the
 * later arm minus the earlier: what the addition between them buys.
 */
export const LADDER_DIFFERENCES = [
  { name: 'B − A', a: 'agent-rag', b: 'agent-grep', measures: 'semantic search over the sources' },
  { name: 'C − A', a: 'agent-knode-wiki-sources', b: 'agent-grep', measures: 'the wiki itself' },
  { name: 'D − C', a: 'agent-knode-full', b: 'agent-knode-wiki-sources', measures: "knode's retrieval: hybrid search, graph, claims, SQL" },
  { name: 'D − A', a: 'agent-knode-full', b: 'agent-grep', measures: 'the product as a whole' },
  { name: 'D − B', a: 'agent-knode-full', b: 'agent-rag', measures: 'the product against an agent with plain RAG' },
] as const;

/** What the ladder compares, per answer: correctness, then what the answer cost. */
export const LADDER_METRICS = ['correctness', 'tokens', 'usd', 'seconds', 'toolCalls'] as const;
export type LadderMetric = (typeof LADDER_METRICS)[number];

export interface LadderCell {
  /** Mean of a − b over the paired questions, its bootstrap interval and p. */
  diff: number;
  ci: [number, number];
  p: number;
  /** The smallest difference this many pairs could detect (α 0.05, power 0.8), in the metric's units. */
  mde: number;
  /** After Holm's correction across the rows shown, for this metric. */
  significant: boolean;
  /** Each arm's mean over the same questions. */
  meanA: number;
  meanB: number;
}

export interface LadderRow {
  name: string;
  a: string;
  b: string;
  measures: string;
  /** Questions both arms answered and were scored on (first answers; repeats are their own systems). */
  n: number;
  metrics: Record<LadderMetric, LadderCell>;
}

export interface DiscriminationCounts {
  /** Questions every agent system was scored on. */
  n: number;
  /** Every one of them fully right (correctness 1). */
  allRight: number;
  /** None of them fully right. */
  noneRight: number;
  /** Some fully right and some not: the questions that can tell them apart. */
  rest: number;
}

export interface Discrimination {
  systems: string[];
  overall: DiscriminationCounts;
  byType: Record<string, DiscriminationCounts>;
}

/**
 * Whether a pack's agent sample could tell the arms apart: over the questions
 * every agent arm was scored on, those on which their correctness differed at
 * all, and the smallest paired difference between two arms the sample could
 * detect (α 0.05, power 0.8) — the median over the pairs of arms whose scores
 * differ somewhere, and the range. `pack` is '' for every pack pooled.
 */
export interface PackSeparability {
  pack: string;
  agents: string[];
  n: number;
  allRight: number;
  noneRight: number;
  /** Questions on which the arms' correctness was not all the same: the only ones that can show a difference. */
  differ: number;
  mde: { median: number; min: number; max: number } | null;
  /** One line when the pack cannot separate the arms at all; null otherwise. */
  verdict: string | null;
}

export interface Separability {
  packs: PackSeparability[];
  overall: PackSeparability;
  /** The run's agent sample (`run.json`): its limit, its allocation over types and what each pack took. */
  sample?: AgentSample;
}

export interface KnodeToolRow {
  tool: string;
  /** Calls of the tool over the system's traced answers, and per traced answer. */
  calls: number;
  perAnswer: number;
  /** Answers that called it at least once and their mean correctness; the same for those that did not. */
  used: Cell;
  unused: Cell;
}

export interface JudgeAuditSummary {
  /** Per kind of verdict (grade, list, match, …): verdicts judged twice, and how many of the pairs agreed. */
  byKind: Record<string, { n: number; agree: number }>;
  disagreements: {
    kind: string;
    id: string;
    /** The answer it was about, for a grade, list or match of an answer. */
    pack?: string;
    system?: string;
    taskId?: string;
    repeat?: number;
    /** The question (a grade) or what was matched, as the judge saw it. */
    asked: string;
    first: unknown;
    second: unknown;
    /** The judge's reason with each verdict, where its kind gives one. */
    reasons: [string | null, string | null];
  }[];
}

/** The run's judge audit: agreement per kind, and each disagreement with the answer it was about. */
export function judgeAuditOf(store: RunStore): JudgeAuditSummary | undefined {
  const recs = store.allJudgeAudits();
  if (!recs.length) return undefined;
  const about = new Map<string, ReturnType<RunStore['allAnswers']>[number]>();
  for (const a of store.allAnswers()) for (const kind of ['grade', 'list', 'match']) about.set(judgeItemKey(kind, a), a);
  const byKind: JudgeAuditSummary['byKind'] = {};
  const disagreements: JudgeAuditSummary['disagreements'] = [];
  const reason = (v: unknown) => (v && typeof v === 'object' && typeof (v as { reason?: unknown }).reason === 'string' ? (v as { reason: string }).reason : null);
  for (const r of recs) {
    const k = (byKind[r.kind] ??= { n: 0, agree: 0 });
    k.n++;
    if (r.agree) {
      k.agree++;
      continue;
    }
    const a = about.get(r.id);
    const item = (r.item ?? {}) as Record<string, unknown>;
    const asked = typeof item.question === 'string' ? item.question : JSON.stringify(item).slice(0, 300);
    disagreements.push({
      kind: r.kind, id: r.id, ...(a ? { pack: a.pack, system: a.system, taskId: a.taskId, ...(a.repeat ? { repeat: a.repeat } : {}) } : {}),
      asked, first: r.first, second: r.second, reasons: [reason(r.first), reason(r.second)],
    });
  }
  disagreements.sort((x, y) => x.kind.localeCompare(y.kind) || (x.system ?? '').localeCompare(y.system ?? '') || (x.taskId ?? x.id).localeCompare(y.taskId ?? y.id));
  return { byKind, disagreements };
}

/** A verdict in a table cell: a grade's score, a match's pairs, else its fields. */
function verdictText(v: unknown): string {
  if (!v || typeof v !== 'object') return String(v);
  const o = v as Record<string, unknown>;
  if ('score' in o) return `score ${o.score}${o.abstained ? ', abstained' : ''}${o.hallucinated ? ', hallucinated' : ''}`;
  if ('pairs' in o) return `pairs ${JSON.stringify(o.pairs)}`;
  return JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'id' && k !== 'reason')));
}

const cellText = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\|/g, '/').replace(/\n/g, ' ');

function judgeAuditLines(a: JudgeAuditSummary | undefined): string[] {
  if (!a) return [];
  const out = ['## Judge audit', '', 'A seeded share of the judge\'s verdicts (`--judge-audit`, default 5%, at least 20 a pass) judged a second time, in calls of their own with the items in another order. Scores use the first verdict; this is how often a second look agrees with it.', ''];
  out.push(mdTable(['kind', 'judged twice', 'agreed', 'agreement'], Object.entries(a.byKind).sort().map(([k, v]) => [k, v.n, v.agree, `${((v.agree / v.n) * 100).toFixed(0)}%`])), '');
  if (a.disagreements.length) {
    out.push(`### Disagreements (${a.disagreements.length})`, '');
    out.push(mdTable(['kind', 'system', 'task', 'asked', 'first verdict', 'reason', 'second verdict', 'reason'], a.disagreements.map((d) => [
      d.kind, d.system ?? '—', d.taskId ? `${d.taskId}${d.repeat ? ` (repeat ${d.repeat})` : ''}` : d.id, cellText(d.asked), verdictText(d.first), cellText(d.reasons[0] ?? '—', 100), verdictText(d.second), cellText(d.reasons[1] ?? '—', 100),
    ])), '');
  }
  return out;
}

export interface ReportData {
  run: ReturnType<RunStore['meta']>;
  packs: string[];
  systems: string[];
  usage: Record<string, Record<string, Record<string, Cell>>>;
  retrieval: Record<string, Record<string, Record<string, Cell>>>;
  emergence: Record<string, Record<string, Record<string, Cell>>>;
  generation: Record<string, Record<string, Record<string, Cell>>>;
  /**
   * `weightedTokens` and `costUsd` are means over the answers with usage on record: `unmetered` counts those stopped
   * at their command cap before any was reported; `closed`, the capped ones answered in their closing turn.
   */
  perQuery: Record<string, Record<string, { latencyP50: number; toolCalls: number; weightedTokens: number; costUsd: number; n: number; capped: number; unmetered?: number; closed?: number; leaked: number; errors: number }>>;
  /**
   * What the agents did, per pack and agent system: tool calls per answer and
   * the programs (shell agents) or knode tools (the MCP agent) behind them,
   * from the traces on the answer records.
   */
  tools: Record<string, Record<string, ToolUse>>;
  builds: BuildRecord[];
  breakEven: Record<string, Record<string, number | null>>;
  /** Corpus-level list tasks (aggregate, timeline, contradiction, profile) per pack and system. */
  lists: Record<string, Record<string, Record<string, Cell>>>;
  /**
   * Correctness for what it costs, per pack and system: correctness per 1k
   * query weighted tokens, the build's weighted tokens, the queries after
   * which the build has paid for itself against agent-grep, and correctness
   * per 1k tokens with the build spread over 100 and 1000 queries.
   */
  efficiency: Record<string, Record<string, Efficiency>>;
  /** Update batches: what each group's incremental build cost, and how each system answered after it. */
  updates: Record<string, { batch: string; builds: { group: string; ok: boolean; ms: number; weightedTokens: number; embeddingTokens: number; calls: number }[]; correctness: Record<string, Cell> }[]>;
  pooled: (Paired & { significant: boolean })[];
  /** Paired correctness against the baseline, per pack, with the minimum detectable effect. */
  paired?: Record<string, Paired[]>;
  byType: Record<string, Record<string, Cell>>;
  /** Correctness per task type, per pack and system (every type, the separation families among them), and each system's paired delta per type. */
  typesByPack?: Record<string, Record<string, Record<string, Cell>>>;
  typeDeltas?: Record<string, Record<string, Record<string, Paired>>>;
  /** Stale answers, confident wrong answers, look-alike items and citation precision, per pack and system, over the separation families and over everything. */
  separation?: Record<string, Record<string, Record<string, Cell>>>;
  /** The ladder's declared differences (docs/design/33 §2), pooled over packs, for the rows whose arms the run has. */
  ladder?: LadderRow[];
  /** Questions every agent system got fully right, none did, and the rest (docs/design/33 §5). */
  discrimination?: Discrimination;
  /** Per pack, whether its agent sample could tell the arms apart, first in the report. */
  separability?: Separability;
  /** Per pack and system that called knode's tools: calls per tool, and correctness with and without each. */
  knodeTools?: Record<string, Record<string, KnodeToolRow[]>>;
  /** What one correct answer costs: weighted tokens and USD over the sum of correctness, per pack and system. */
  costPerCorrect?: Record<string, Record<string, { tokens: number | null; usd: number | null; correct: number; n: number; toolCalls: number }>>;
  /** Run-to-run variance where a system answered the same tasks more than once (`eval run --repeat`). */
  variance?: Record<string, Record<string, Variance>>;
  /** Per pack, every two repeated systems: their paired difference on the repeated tasks against their run-to-run spread. */
  repeatPairs?: Record<string, RepeatPair[]>;
  judgeUsage: { calls: number; weightedTokens: number; costUsd: number };
  /** The judge audit (`--judge-audit`): verdicts judged twice, how often the two agreed, and every disagreement. */
  judgeAudit?: JudgeAuditSummary;
  /**
   * Where the run's model work ran (docs/design/32): per pool and worker, the
   * model calls and agent sessions it answered (replays from the reply cache
   * apart), from the meter; this machine's are the run's own slots.
   */
  ranAt?: { pool: string; worker: string; calls: number; sessions: number; replayed: number }[];
}

/** The meter's model calls and sessions by pool and worker (embeddings are the run's own, and left out). */
export function ranAtOf(runDir: string, localPool: string): NonNullable<ReportData['ranAt']> {
  const file = path.join(runDir, 'meter.jsonl');
  if (!fs.existsSync(file)) return [];
  const by = new Map<string, { pool: string; worker: string; calls: number; sessions: number; replayed: number }>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { stage?: string; worker?: string; pool?: string; replayed?: boolean; embeddingCalls?: number; embeddingTokens?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.embeddingCalls || e.embeddingTokens) continue;
    const worker = e.worker ?? 'this machine';
    const pool = e.pool ?? (e.worker ? '?' : localPool);
    const k = `${pool}\u0000${worker}`;
    const row = by.get(k) ?? { pool, worker, calls: 0, sessions: 0, replayed: 0 };
    if (e.replayed) row.replayed++;
    else if (e.stage === 'agent') row.sessions++;
    else row.calls++;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => a.pool.localeCompare(b.pool) || a.worker.localeCompare(b.worker));
}

function cell(values: number[], rate = false): Cell {
  if (!values.length) return { value: null, n: 0 };
  const m = mean(values);
  if (rate && values.every((v) => v === 0 || v === 1)) return { value: m, n: values.length, ci: wilson(values.filter((v) => v === 1).length, values.length) };
  return { value: m, n: values.length, ci: values.length > 1 ? bootstrapMean(values) : undefined };
}

function grouped(scores: ScoreRecord[], metrics: readonly string[], filter: (s: ScoreRecord) => boolean = () => true): Record<string, Record<string, Record<string, Cell>>> {
  const acc = new Map<string, number[]>();
  for (const s of scores) {
    if (!metrics.includes(s.metric) || s.value === null || !Number.isFinite(s.value) || !filter(s)) continue;
    const k = `${s.pack}\u0000${s.system}\u0000${s.metric}`;
    (acc.get(k) ?? acc.set(k, []).get(k)!).push(s.value);
  }
  const out: Record<string, Record<string, Record<string, Cell>>> = {};
  for (const [k, vs] of acc) {
    const [pack, system, metric] = k.split('\u0000');
    ((out[pack] ??= {})[system] ??= {})[metric] = cell(vs, RATE_METRICS.includes(metric));
  }
  return out;
}

export function buildReportData(runDir: string): ReportData {
  const store = new RunStore(runDir);
  const scores = store.allScores();
  const answers = store.allAnswers();
  const builds = store.allBuilds();
  const packs = [...new Set([...answers.map((a) => a.pack), ...builds.map((b) => b.pack)])].sort();
  const systems = [...new Set(answers.map((a) => a.system).concat(scores.map((s) => s.system)))].filter((s) => s !== '__judge__').sort();

  const usage = grouped(scores, USAGE_METRICS, (s) => s.suite !== 'emergence');
  const retrieval = grouped(scores, RETRIEVAL_METRICS);
  const emergence = grouped(scores, EMERGENCE_METRICS, (s) => s.suite === 'emergence');
  const generation: ReportData['generation'] = {};
  for (const s of scores.filter((x) => x.suite === 'generation' && GENERATION_METRICS.includes(x.metric as (typeof GENERATION_METRICS)[number]))) {
    ((generation[s.pack] ??= {})[s.system] ??= {})[s.metric] = { value: s.value, n: s.n ?? 0, ci: s.ci };
  }

  const perQuery: ReportData['perQuery'] = {};
  for (const a of answers) {
    const p = ((perQuery[a.pack] ??= {})[a.system] ??= { latencyP50: 0, toolCalls: 0, weightedTokens: 0, costUsd: 0, n: 0, capped: 0, unmetered: 0, closed: 0, leaked: 0, errors: 0 });
    p.n++;
    p.toolCalls += a.toolCalls;
    p.weightedTokens += a.usage.weightedTokens;
    p.costUsd += a.usage.costUsd;
    if (a.capped) p.capped++;
    if (unmeteredStop(a)) p.unmetered = (p.unmetered ?? 0) + 1;
    if (a.capped && a.closing === 'answered') p.closed = (p.closed ?? 0) + 1;
    if (a.leaked?.length) p.leaked++;
    if (a.error) p.errors++;
  }
  for (const [pack, bySystem] of Object.entries(perQuery)) {
    for (const [system, p] of Object.entries(bySystem)) {
      const lat = answers.filter((a) => a.pack === pack && a.system === system).map((a) => a.ms).sort((x, y) => x - y);
      p.latencyP50 = lat[Math.floor(lat.length / 2)] ?? 0;
      p.toolCalls /= p.n;
      // over the answers whose usage is on record: a stopped session's is unknown, not zero
      const metered = Math.max(1, p.n - (p.unmetered ?? 0));
      p.weightedTokens /= metered;
      p.costUsd /= metered;
    }
  }

  // every agent-* system, and anything else that left a trace; records from before traces count as untraced
  const tools: ReportData['tools'] = {};
  const agentAnswers = new Map<string, typeof answers>();
  for (const a of answers) {
    if (!a.system.startsWith('agent-') && !a.commands) continue;
    const k = `${a.pack}\u0000${a.system}`;
    (agentAnswers.get(k) ?? agentAnswers.set(k, []).get(k)!).push(a);
  }
  for (const [k, as] of agentAnswers) {
    const [pack, system] = k.split('\u0000');
    (tools[pack] ??= {})[system] = toolUse(as);
  }

  // queries after which a build has paid for itself against the grep agent's per-query cost
  const breakEven: ReportData['breakEven'] = {};
  for (const b of builds.filter((x) => x.ok && !x.system.includes('@'))) {
    const answerer = GROUP_ANSWERER[b.system];
    const grep = perQuery[b.pack]?.[BASELINE]?.weightedTokens;
    const own = answerer ? perQuery[b.pack]?.[answerer]?.weightedTokens : undefined;
    if (grep === undefined || own === undefined) continue;
    (breakEven[b.pack] ??= {})[b.system] = grep > own ? b.usage.weightedTokens / (grep - own) : null;
  }

  // pooled paired comparison of correctness against the baseline, over the tasks both answered (repeats averaged per task)
  const perTask = new Map<string, number[]>();
  const typeOf = new Map<string, string>();
  for (const s of scores) {
    if (s.metric !== 'correctness' || s.value === null || !Number.isFinite(s.value)) continue;
    const k = `${s.system}\u0000${s.pack}\u0000${s.taskId}`;
    (perTask.get(k) ?? perTask.set(k, []).get(k)!).push(s.value);
    if (s.taskType) typeOf.set(`${s.pack}\u0000${s.taskId}`, s.taskType);
  }
  const correctness = new Map([...perTask].map(([k, vs]) => [k, mean(vs)]));
  const others = systems.filter((s) => s !== BASELINE);
  const compare = (system: string, keep: (pack: string, task: string) => boolean): Paired | null => {
    const a: number[] = [];
    const b: number[] = [];
    for (const [k, v] of correctness) {
      const [sys, pack, task] = k.split('\u0000');
      if (sys !== system || !keep(pack, task)) continue;
      const base = correctness.get(`${BASELINE}\u0000${pack}\u0000${task}`);
      if (base === undefined) continue;
      a.push(v);
      b.push(base);
    }
    if (!a.length) return null;
    return { system, ...pairedBootstrap(a, b), mde: minimumDetectableEffect(a.map((x, i) => x - b[i])) };
  };
  const comparisons = others.map((system) => compare(system, () => true)).filter((c): c is Paired => c !== null && c.n > 0);
  const sig = holm(comparisons.map((c) => c.p));
  const pooled = comparisons.map((c, i) => ({ ...c, significant: sig[i] }));
  const paired: NonNullable<ReportData['paired']> = {};
  const typeDeltas: NonNullable<ReportData['typeDeltas']> = {};
  for (const pack of packs) {
    const rows = others.map((system) => compare(system, (p) => p === pack)).filter((c): c is Paired => c !== null);
    if (rows.length) paired[pack] = rows;
    const types = new Set([...typeOf].filter(([k]) => k.startsWith(`${pack}\u0000`)).map(([, t]) => t));
    for (const type of types) {
      for (const system of others) {
        const c = compare(system, (p, task) => p === pack && typeOf.get(`${p}\u0000${task}`) === type);
        if (c) ((typeDeltas[pack] ??= {})[type] ??= {})[system] = c;
      }
    }
  }

  const corpusTypes = new Set<string>(CORPUS_TASK_TYPES);
  const lists = grouped(scores, LIST_METRICS, (s) => s.suite === 'usage' && Boolean(s.taskType && corpusTypes.has(s.taskType)));
  const efficiency = efficiencyOf(usage, perQuery, builds);
  const updates = updatesOf(builds, answers, scores);

  const byType: ReportData['byType'] = {};
  const typeAcc = new Map<string, number[]>();
  for (const s of scores) {
    if (s.metric !== 'correctness' || s.value === null || !s.taskType) continue;
    const k = `${s.system}\u0000${s.taskType}`;
    (typeAcc.get(k) ?? typeAcc.set(k, []).get(k)!).push(s.value);
  }
  for (const [k, vs] of typeAcc) {
    const [system, type] = k.split('\u0000');
    (byType[system] ??= {})[type] = cell(vs);
  }
  const typesByPack: NonNullable<ReportData['typesByPack']> = {};
  {
    const acc = new Map<string, number[]>();
    for (const [k, v] of correctness) {
      const [system, pack, task] = k.split('\u0000');
      const type = typeOf.get(`${pack}\u0000${task}`);
      if (!type) continue;
      const key = `${pack}\u0000${type}\u0000${system}`;
      (acc.get(key) ?? acc.set(key, []).get(key)!).push(v);
    }
    for (const [key, vs] of acc) {
      const [pack, type, system] = key.split('\u0000');
      ((typesByPack[pack] ??= {})[type] ??= {})[system] = cell(vs);
    }
  }
  const separation = separationOf(scores);
  const costPerCorrect = costPerCorrectOf(answers, scores);
  const ladder = ladderOf(answers, correctness);
  const discrimination = discriminationOf(systems.filter(isAgentSystem), correctness, typeOf);
  const separability = separabilityOf(correctness, store.meta()?.agentSample);
  const knodeTools = knodeToolsOf(answers, correctness);
  const variance = varianceOf(answers, scores);
  const repeatPairs = repeatPairsOf(answers, scores);

  const judgeEvents = fs.existsSync(path.join(runDir, 'meter.jsonl'))
    ? fs.readFileSync(path.join(runDir, 'meter.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"__judge__"')).length
    : 0;
  return {
    run: store.meta(), packs, systems, usage, retrieval, emergence, generation, perQuery, tools, builds, breakEven, lists, efficiency, updates, pooled, paired, byType, typesByPack, typeDeltas,
    separation, costPerCorrect, ...(ladder.length ? { ladder } : {}), ...(discrimination ? { discrimination } : {}), ...(separability ? { separability } : {}), ...(Object.keys(knodeTools).length ? { knodeTools } : {}),
    variance, repeatPairs, judgeUsage: { calls: judgeEvents, weightedTokens: 0, costUsd: 0 }, judgeAudit: judgeAuditOf(store),
    ranAt: ranAtOf(runDir, store.meta()?.work?.pool ?? 'local'),
  };
}

const SEPARATION_TYPES = new Set<string>(SEPARATION_TASK_TYPES);

/** An agent system: one that answers with an agent session (the ladder's arms, the diagnostics, the llm-wiki agents). */
export function isAgentSystem(system: string): boolean {
  try {
    return SYSTEMS[system]?.().kind === 'agent';
  } catch {
    return false;
  }
}

type Answers = ReturnType<RunStore['allAnswers']>;

/** A first answer's cost on one question, in the ladder's units. */
function costOf(a: Answers[number]): Record<Exclude<LadderMetric, 'correctness'>, number> {
  return { tokens: a.usage.weightedTokens, usd: a.usage.costUsd, seconds: a.ms / 1000, toolCalls: a.toolCalls };
}

/**
 * The ladder table's rows (docs/design/33 §2, §5): for each declared
 * difference whose two arms the run answered with, the paired difference over
 * the questions both were scored on (all packs pooled, a question per pack and
 * task), for correctness and for cost — weighted tokens, USD at API prices,
 * latency, tool calls — each with its bootstrap interval, p, minimum
 * detectable difference, and significance after Holm's correction across the
 * rows shown, metric by metric.
 */
export function ladderOf(answers: Answers, correctness: ReadonlyMap<string, number>): LadderRow[] {
  const first = new Map<string, Answers[number]>();
  for (const a of answers) if (!a.repeat && !a.cancelled) first.set(`${a.system}\u0000${a.pack}\u0000${a.taskId}`, a);
  const answered = new Set([...first.values()].map((a) => a.system));
  const rows = LADDER_DIFFERENCES.filter((d) => answered.has(d.a) && answered.has(d.b)).map((d) => {
    const pairs: { a: Record<LadderMetric, number>; b: Record<LadderMetric, number> }[] = [];
    for (const [k, ra] of first) {
      const [sys, pack, task] = k.split('\u0000');
      if (sys !== d.a) continue;
      const rb = first.get(`${d.b}\u0000${pack}\u0000${task}`);
      const ca = correctness.get(`${d.a}\u0000${pack}\u0000${task}`);
      const cb = correctness.get(`${d.b}\u0000${pack}\u0000${task}`);
      if (!rb || ca === undefined || cb === undefined) continue;
      pairs.push({ a: { correctness: ca, ...costOf(ra) }, b: { correctness: cb, ...costOf(rb) } });
    }
    return { d, pairs };
  }).filter((r) => r.pairs.length > 0);
  const cells = rows.map(({ pairs }) => Object.fromEntries(LADDER_METRICS.map((m) => {
    const xa = pairs.map((p) => p.a[m]);
    const xb = pairs.map((p) => p.b[m]);
    const r = pairedBootstrap(xa, xb);
    return [m, { diff: r.diff, ci: r.ci, p: r.p, mde: minimumDetectableEffect(xa.map((x, i) => x - xb[i])), significant: false, meanA: mean(xa), meanB: mean(xb) }];
  })) as Record<LadderMetric, LadderCell>);
  for (const m of LADDER_METRICS) {
    const sig = holm(cells.map((c) => c[m].p));
    cells.forEach((c, i) => (c[m].significant = sig[i]));
  }
  return rows.map(({ d, pairs }, i) => ({ name: d.name, a: d.a, b: d.b, measures: d.measures, n: pairs.length, metrics: cells[i] }));
}

/**
 * Which questions can tell the agents apart (docs/design/33 §0, §5): over the
 * questions every agent system of the run was scored on, those all of them
 * got fully right, those none did, and the rest — overall and per task type.
 * Null with fewer than two agent systems.
 */
export function discriminationOf(agents: string[], correctness: ReadonlyMap<string, number>, typeOf: ReadonlyMap<string, string>): Discrimination | null {
  if (agents.length < 2) return null;
  const byQuestion = new Map<string, Map<string, number>>();
  for (const [k, v] of correctness) {
    const [sys, pack, task] = k.split('\u0000');
    if (!agents.includes(sys)) continue;
    const q = `${pack}\u0000${task}`;
    (byQuestion.get(q) ?? byQuestion.set(q, new Map()).get(q)!).set(sys, v);
  }
  const empty = (): DiscriminationCounts => ({ n: 0, allRight: 0, noneRight: 0, rest: 0 });
  const overall = empty();
  const byType: Record<string, DiscriminationCounts> = {};
  for (const [q, vs] of byQuestion) {
    if (vs.size < agents.length) continue;
    const right = [...vs.values()].filter((v) => v >= 1).length;
    const kind = right === agents.length ? 'allRight' : right === 0 ? 'noneRight' : 'rest';
    for (const c of [overall, (byType[typeOf.get(q) ?? 'untyped'] ??= empty())]) {
      c.n++;
      c[kind]++;
    }
  }
  return overall.n ? { systems: [...agents].sort(), overall, byType } : null;
}

/** Correctness per question (pack, task) and agent arm, from a run's per-task means; arms by pack, those of at least one score. */
function agentQuestions(correctness: ReadonlyMap<string, number>, isAgent: (system: string) => boolean = isAgentSystem): Map<string, { agents: Set<string>; questions: Map<string, Map<string, number>> }> {
  const out = new Map<string, { agents: Set<string>; questions: Map<string, Map<string, number>> }>();
  const known = new Map<string, boolean>();
  for (const [k, v] of correctness) {
    const [sys, pack, task] = k.split('\u0000');
    if (!(known.get(sys) ?? known.set(sys, isAgent(sys)).get(sys))) continue;
    const p = out.get(pack) ?? out.set(pack, { agents: new Set(), questions: new Map() }).get(pack)!;
    p.agents.add(sys);
    (p.questions.get(task) ?? p.questions.set(task, new Map()).get(task)!).set(sys, v);
  }
  return out;
}

/** Equal within rounding: the judge's scores are fractions of small integers. */
const same = (vs: number[]) => Math.max(...vs) - Math.min(...vs) < 1e-9;

/**
 * Per pack and task type, over the questions every agent arm of the pack was
 * scored on: how many, how many the arms' scores differed on, how many all
 * got fully right and how many none did — what `--agent-headroom-from`
 * derives its weights from. Packs with fewer than two agent arms are left out.
 */
export function typeEvidenceOf(correctness: ReadonlyMap<string, number>, typeOf: ReadonlyMap<string, string>, isAgent?: (system: string) => boolean): Record<string, Record<string, TypeEvidence>> {
  const out: Record<string, Record<string, TypeEvidence>> = {};
  for (const [pack, { agents, questions }] of agentQuestions(correctness, isAgent)) {
    if (agents.size < 2) continue;
    for (const [task, vs] of questions) {
      if (vs.size < agents.size) continue;
      const values = [...vs.values()];
      const e = ((out[pack] ??= {})[typeOf.get(`${pack}\u0000${task}`) ?? 'untyped'] ??= { n: 0, differ: 0, spread: 0, allRight: 0, noneRight: 0 });
      e.n++;
      if (!same(values)) e.differ++;
      e.spread += Math.max(...values) - Math.min(...values);
      const right = values.filter((v) => v >= 1).length;
      if (right === values.length) e.allRight++;
      else if (right === 0) e.noneRight++;
    }
  }
  return out;
}

/**
 * Whether each pack's agent sample could tell the arms apart (see
 * `PackSeparability`), and every pack pooled. Null with no pack of two agent
 * arms. A pair of arms whose scores never differ has no spread to size an MDE
 * by, and is left out of the MDE.
 */
export function separabilityOf(correctness: ReadonlyMap<string, number>, sample?: AgentSample, isAgent?: (system: string) => boolean): Separability | null {
  const byPack = agentQuestions(correctness, isAgent);
  const rows: PackSeparability[] = [];
  const pooledDiffs = new Map<string, number[]>();
  const all = { n: 0, allRight: 0, noneRight: 0, differ: 0, agents: new Set<string>() };
  const mdeOf = (diffs: Map<string, number[]>) => {
    const ms = [...diffs.values()].filter((d) => d.length >= 2 && d.some((x) => Math.abs(x) > 1e-9)).map((d) => minimumDetectableEffect(d)).sort((a, b) => a - b);
    return ms.length ? { median: ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2, min: ms[0], max: ms.at(-1)! } : null;
  };
  for (const [pack, { agents, questions }] of [...byPack].sort(([a], [b]) => a.localeCompare(b))) {
    if (agents.size < 2) continue;
    const arms = [...agents].sort();
    const c = { n: 0, allRight: 0, noneRight: 0, differ: 0 };
    const diffs = new Map<string, number[]>();
    for (const vs of questions.values()) {
      if (vs.size < arms.length) continue;
      const values = arms.map((a) => vs.get(a)!);
      c.n++;
      if (!same(values)) c.differ++;
      const right = values.filter((v) => v >= 1).length;
      if (right === values.length) c.allRight++;
      else if (right === 0) c.noneRight++;
      for (let i = 0; i < arms.length; i++) {
        for (let j = i + 1; j < arms.length; j++) {
          const pair = `${arms[i]}\u0000${arms[j]}`;
          (diffs.get(pair) ?? diffs.set(pair, []).get(pair)!).push(values[i] - values[j]);
          (pooledDiffs.get(pair) ?? pooledDiffs.set(pair, []).get(pair)!).push(values[i] - values[j]);
        }
      }
    }
    if (!c.n) continue;
    for (const a of arms) all.agents.add(a);
    all.n += c.n;
    all.allRight += c.allRight;
    all.noneRight += c.noneRight;
    all.differ += c.differ;
    rows.push({ pack, agents: arms, ...c, mde: mdeOf(diffs), verdict: verdictOf(c) });
  }
  if (!rows.length) return null;
  const overall: PackSeparability = { pack: '', agents: [...all.agents].sort(), n: all.n, allRight: all.allRight, noneRight: all.noneRight, differ: all.differ, mde: mdeOf(pooledDiffs), verdict: verdictOf(all) };
  return { packs: rows, overall, ...(sample ? { sample } : {}) };
}

function verdictOf(c: { n: number; allRight: number; noneRight: number; differ: number }): string | null {
  if (c.differ) return null;
  const parts = [`${c.allRight} fully right for every arm`, `${c.noneRight} for none`, `${c.n - c.allRight - c.noneRight} the same partial score`].filter((x) => !x.startsWith('0 '));
  return `cannot separate the arms: every arm got the same score on all ${c.n} agent question(s) (${parts.join(', ')})`;
}

/**
 * Per pack and type, what earlier runs saw of the agent arms (`typeEvidenceOf`),
 * from their records, for `--agent-headroom-from`. Each source is a run
 * directory (its `scores.jsonl`, else its `report.json`), a `scores.jsonl`, a
 * `report.json` (its `discrimination.byType`: "the rest" stands for the
 * questions that differ; a run of several packs counts for every pack's
 * pooled type shares only), or a campaign's `campaign.json` (each entry's
 * `runDir`). Only `correctness` is read, as the report reads it. A run of one
 * pack is keyed by the pack directory's name its `run.json` records (two
 * versions of a pack share a manifest id), any other by manifest id.
 */
export function headroomEvidence(sources: string[]): Record<string, Record<string, TypeEvidence>> {
  return headroomRecords(sources).types;
}

/**
 * What `--agent-headroom-from` reads of earlier records: per pack and type
 * (`headroomEvidence`), and per pack and question its class over the agent
 * arms' answers, repeats included (`questionClasses`), from every source with
 * per-question scores (a `report.json` has none). A question several sources
 * scored is classed over all their answers, each source's arms its own: give
 * a run once — its re-scored copy, or the original, not both.
 */
export function headroomRecords(sources: string[]): { types: Record<string, Record<string, TypeEvidence>>; questions: Record<string, Record<string, { type: string; cls: QuestionClass }>> } {
  const out: Record<string, Record<string, TypeEvidence>> = {};
  const answers: AnswerScore[] = [];
  let source = 0;
  const add = (pack: string, type: string, e: TypeEvidence) => {
    const t = ((out[pack] ??= {})[type] ??= { n: 0, differ: 0, spread: 0, allRight: 0, noneRight: 0 });
    t.n += e.n;
    t.differ += e.differ;
    t.spread += e.spread;
    t.allRight += e.allRight;
    t.noneRight += e.noneRight;
  };
  // a run of one pack is known by its directory's name, as the run recorded it: two versions of a pack share a manifest id
  const fromScores = (file: string, as?: string) => {
    const latest = new Map<string, ScoreRecord>();
    for (const line of fileLines(file)) {
      if (!line.includes('"correctness"')) continue;
      try {
        const r = JSON.parse(line) as ScoreRecord;
        if (r.metric === 'correctness') latest.set(r.key, r);
      } catch {
        /* a line cut by a crash */
      }
    }
    const perTask = new Map<string, number[]>();
    const typeOf = new Map<string, string>();
    for (const r of latest.values()) {
      if (r.value === null || !Number.isFinite(r.value)) continue;
      const k = `${r.system}\u0000${r.pack}\u0000${r.taskId}`;
      (perTask.get(k) ?? perTask.set(k, []).get(k)!).push(r.value);
      if (r.taskType) typeOf.set(`${r.pack}\u0000${r.taskId}`, r.taskType);
    }
    const found = typeEvidenceOf(new Map([...perTask].map(([k, vs]) => [k, mean(vs)])), typeOf);
    const single = as && Object.keys(found).length === 1;
    for (const [pack, types] of Object.entries(found)) {
      for (const [type, e] of Object.entries(types)) add(single ? as : pack, type, e);
    }
    // every answer of an agent arm, repeats apart, for the question's class
    const src = source++;
    const mine = [...latest.values()].filter((r) => r.taskId !== undefined && isAgentSystem(r.system));
    const onePack = as && new Set(mine.map((r) => r.pack)).size === 1;
    for (const r of mine) answers.push({ arm: `${src}\u0000${r.system}`, pack: onePack ? as : r.pack, taskId: r.taskId!, taskType: r.taskType, value: r.value });
  };
  const fromReport = (file: string) => {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReportData>;
    if (!r.discrimination) return;
    const pack = r.packs?.length === 1 ? (r.run?.packs?.length === 1 ? r.run.packs[0] : r.packs[0]) : `(pooled) ${r.run?.id ?? path.basename(path.dirname(file))}`;
    for (const [type, c] of Object.entries(r.discrimination.byType)) add(pack, type, { n: c.n, differ: c.rest, spread: c.rest, allRight: c.allRight, noneRight: c.noneRight });
  };
  const one = (src: string) => {
    const at = path.resolve(src);
    if (!fs.existsSync(at)) throw new Error(`--agent-headroom-from: ${src} does not exist`);
    if (fs.statSync(at).isDirectory()) {
      if (fs.existsSync(path.join(at, 'scores.jsonl'))) return fromScores(path.join(at, 'scores.jsonl'), oneRunPack(at));
      if (fs.existsSync(path.join(at, 'report.json'))) return fromReport(path.join(at, 'report.json'));
      if (fs.existsSync(path.join(at, 'campaign.json'))) return one(path.join(at, 'campaign.json'));
      throw new Error(`--agent-headroom-from: ${src} holds no scores.jsonl, report.json or campaign.json`);
    }
    if (at.endsWith('.jsonl')) return fromScores(at, oneRunPack(path.dirname(at)));
    const json = JSON.parse(fs.readFileSync(at, 'utf8')) as { entries?: { runDir?: string }[]; discrimination?: unknown };
    if (Array.isArray(json.entries)) {
      for (const e of json.entries) if (e.runDir && (fs.existsSync(path.join(e.runDir, 'scores.jsonl')) || fs.existsSync(path.join(e.runDir, 'report.json')))) one(e.runDir);
      return;
    }
    return fromReport(at);
  };
  for (const src of sources) one(src);
  return { types: out, questions: questionClasses(answers) };
}

/** The pack directory's name a run of one pack recorded (`run.json` `packs`), if it is one. */
function oneRunPack(runDir: string): string | undefined {
  try {
    const packs = (JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as { packs?: string[] }).packs;
    // a pack directory's name, also where a copied run recorded its path
    return packs?.length === 1 ? path.basename(packs[0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * knode's tools as an agent used them (docs/design/33 §2), per pack and every
 * agent system whose traces call one: calls per tool, and the correctness of
 * the answers that called it against those that did not. From the bounded
 * traces on the first answers (50 entries each, so in practice all calls).
 */
export function knodeToolsOf(answers: Answers, correctness: ReadonlyMap<string, number>): Record<string, Record<string, KnodeToolRow[]>> {
  const out: Record<string, Record<string, KnodeToolRow[]>> = {};
  const groups = new Map<string, Answers>();
  for (const a of answers) {
    if (a.repeat || !Array.isArray(a.commands)) continue;
    const k = `${a.pack}\u0000${a.system}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
  }
  for (const [k, as] of groups) {
    const [pack, system] = k.split('\u0000');
    const usesOf = as.map((a) => {
      const m = new Map<string, number>();
      for (const c of a.commands!) for (const t of toolsOf(c)) if (t.startsWith('knode_')) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    });
    const tools = [...new Set(usesOf.flatMap((m) => [...m.keys()]))].sort();
    if (!tools.length) continue;
    const scored = (i: number) => correctness.get(`${system}\u0000${pack}\u0000${as[i].taskId}`);
    const rows = tools.map((tool) => {
      const used: number[] = [];
      const unused: number[] = [];
      let calls = 0;
      usesOf.forEach((m, i) => {
        calls += m.get(tool) ?? 0;
        const c = scored(i);
        if (c !== undefined) (m.has(tool) ? used : unused).push(c);
      });
      return { tool, calls, perAnswer: calls / as.length, used: cell(used), unused: cell(unused) };
    });
    rows.sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool));
    (out[pack] ??= {})[system] = rows;
  }
  return out;
}

/**
 * The separation metrics per pack and system: each over the separation
 * families (`<metric>` ) and, for stale and confident-wrong answers, over all
 * tasks too (`<metric>_all`).
 */
function separationOf(scores: ScoreRecord[]): NonNullable<ReportData['separation']> {
  const acc = new Map<string, number[]>();
  const push = (pack: string, system: string, metric: string, v: number) => {
    const k = `${pack}\u0000${system}\u0000${metric}`;
    (acc.get(k) ?? acc.set(k, []).get(k)!).push(v);
  };
  for (const s of scores) {
    if (s.value === null || !Number.isFinite(s.value) || !(SEPARATION_METRICS as readonly string[]).includes(s.metric) || s.suite === 'generation') continue;
    if (s.taskType && SEPARATION_TYPES.has(s.taskType)) push(s.pack, s.system, s.metric, s.value);
    if (s.metric === 'stale_answer' || s.metric === 'confident_wrong') push(s.pack, s.system, `${s.metric}_all`, s.value);
  }
  const out: NonNullable<ReportData['separation']> = {};
  for (const [k, vs] of acc) {
    const [pack, system, metric] = k.split('\u0000');
    ((out[pack] ??= {})[system] ??= {})[metric] = cell(vs, RATE_METRICS.includes(metric.replace(/_all$/, '')));
  }
  return out;
}

/** Weighted tokens and USD per unit of correctness (a half-right answer is half an answer), and tool calls per answer. */
export function costPerCorrectOf(answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): NonNullable<ReportData['costPerCorrect']> {
  const correct = new Map<string, number>();
  for (const s of scores) if (s.metric === 'correctness' && s.value !== null && Number.isFinite(s.value)) correct.set(`${s.pack}|${s.system}|${s.taskId}|${s.repeat ?? 0}`, s.value);
  const out: NonNullable<ReportData['costPerCorrect']> = {};
  const acc = new Map<string, { tokens: number; usd: number; correct: number; n: number; toolCalls: number }>();
  for (const a of answers) {
    const c = correct.get(`${a.pack}|${a.system}|${a.taskId}|${a.repeat ?? 0}`);
    if (c === undefined) continue;
    const k = `${a.pack}\u0000${a.system}`;
    const x = acc.get(k) ?? acc.set(k, { tokens: 0, usd: 0, correct: 0, n: 0, toolCalls: 0 }).get(k)!;
    x.tokens += a.usage.weightedTokens;
    x.usd += a.usage.costUsd;
    x.correct += c;
    x.n++;
    x.toolCalls += a.toolCalls;
  }
  for (const [k, x] of acc) {
    const [pack, system] = k.split('\u0000');
    (out[pack] ??= {})[system] = { tokens: x.correct > 0 ? x.tokens / x.correct : null, usd: x.correct > 0 ? x.usd / x.correct : null, correct: x.correct, n: x.n, toolCalls: x.n ? x.toolCalls / x.n : 0 };
  }
  return out;
}

/**
 * Paired differences between repeated systems (docs/design/33 §6.4): on the
 * tasks both answered in every repeat they share, the difference of their
 * mean correctness in each repeat, and whether it is within what rerunning
 * alone moves it. A difference counts as within the spread when the repeats
 * disagree on its sign, or when it is at most twice √(sA² + sB²), the SD a
 * single run's difference would have from the two systems' own run-to-run
 * spreads (estimated from as few as two or three repeats, so a rough bound).
 */
export function repeatPairsOf(answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): NonNullable<ReportData['repeatPairs']> {
  const repeats = new Map<string, Set<number>>();
  for (const a of answers) {
    const k = `${a.pack}\u0000${a.system}`;
    (repeats.get(k) ?? repeats.set(k, new Set()).get(k)!).add(a.repeat ?? 0);
  }
  // pack → system → task → repeat → correctness, for systems answered more than once
  const byPack = new Map<string, Map<string, Map<string, Map<number, number>>>>();
  for (const s of scores) {
    if (s.metric !== 'correctness' || s.value === null || !Number.isFinite(s.value) || !s.taskId) continue;
    if ((repeats.get(`${s.pack}\u0000${s.system}`)?.size ?? 0) < 2) continue;
    const sys = byPack.get(s.pack) ?? byPack.set(s.pack, new Map()).get(s.pack)!;
    const tasks = sys.get(s.system) ?? sys.set(s.system, new Map()).get(s.system)!;
    (tasks.get(s.taskId) ?? tasks.set(s.taskId, new Map()).get(s.taskId)!).set(s.repeat ?? 0, s.value);
  }
  const out: NonNullable<ReportData['repeatPairs']> = {};
  for (const [pack, systems] of byPack) {
    const names = [...systems.keys()].sort((x, y) => (x === BASELINE ? -1 : y === BASELINE ? 1 : x.localeCompare(y)));
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i], names[j]];
        const order = [...repeats.get(`${pack}\u0000${a}`)!].filter((r) => repeats.get(`${pack}\u0000${b}`)!.has(r)).sort((x, y) => x - y);
        if (order.length < 2) continue;
        const ta = systems.get(a)!;
        const tb = systems.get(b)!;
        const common = [...ta.keys()].filter((t) => tb.has(t) && order.every((r) => ta.get(t)!.has(r) && tb.get(t)!.has(r)));
        if (!common.length) continue;
        const meanOf = (m: Map<string, Map<number, number>>, r: number) => mean(common.map((t) => m.get(t)!.get(r)!));
        const perRepeat = order.map((r) => meanOf(ta, r) - meanOf(tb, r));
        const spreadA = sd(order.map((r) => meanOf(ta, r)));
        const spreadB = sd(order.map((r) => meanOf(tb, r)));
        const noise = Math.sqrt(spreadA ** 2 + spreadB ** 2);
        const diff = mean(perRepeat);
        const flips = perRepeat.some((d) => d > 0) && perRepeat.some((d) => d < 0);
        (out[pack] ??= []).push({ a, b, tasks: common.length, perRepeat, diff, spreadA, spreadB, noise, withinSpread: flips || Math.abs(diff) <= 2 * noise });
      }
    }
  }
  return out;
}

/** Spread between repeated answers of one system to the same tasks: across the repeats' means, and within each task. */
export function varianceOf(answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): NonNullable<ReportData['variance']> {
  const repeats = new Map<string, Set<number>>();
  for (const a of answers) {
    const k = `${a.pack}\u0000${a.system}`;
    (repeats.get(k) ?? repeats.set(k, new Set()).get(k)!).add(a.repeat ?? 0);
  }
  const out: NonNullable<ReportData['variance']> = {};
  for (const [k, rs] of repeats) {
    if (rs.size < 2) continue;
    const [pack, system] = k.split('\u0000');
    const byTask = new Map<string, Map<number, number>>();
    for (const s of scores) {
      if (s.pack !== pack || s.system !== system || s.metric !== 'correctness' || s.value === null || !s.taskId) continue;
      (byTask.get(s.taskId) ?? byTask.set(s.taskId, new Map()).get(s.taskId)!).set(s.repeat ?? 0, s.value);
    }
    const order = [...rs].sort((x, y) => x - y);
    // the tasks every repeat answered, so the repeats' means are over the same tasks
    const common = [...byTask.values()].filter((m) => order.every((r) => m.has(r)));
    if (!common.length) continue;
    const perRepeat = order.map((r) => mean(common.map((m) => m.get(r)!)));
    const within = common.map((m) => sd(order.map((r) => m.get(r)!)));
    (out[pack] ??= {})[system] = {
      repeats: order.length, perRepeat, sdAcrossRepeats: sd(perRepeat), withinTaskSd: mean(within),
      unstable: common.filter((m) => new Set(order.map((r) => m.get(r)!)).size > 1).length / common.length, tasks: common.length,
    };
  }
  return out;
}

/** Correctness per 1k query tokens, and with the build counted: break-even against agent-grep and amortized over 100 / 1000 queries. */
export function efficiencyOf(
  usage: ReportData['usage'], perQuery: ReportData['perQuery'], builds: BuildRecord[],
): ReportData['efficiency'] {
  const out: ReportData['efficiency'] = {};
  for (const [pack, bySystem] of Object.entries(perQuery)) {
    const grep = bySystem[BASELINE]?.weightedTokens;
    for (const [system, p] of Object.entries(bySystem)) {
      const correctness = usage[pack]?.[system]?.correctness?.value ?? null;
      const group = groupOf(system);
      const build = group ? builds.find((b) => b.pack === pack && b.system === group && b.ok) : undefined;
      const buildTokens = build?.usage.weightedTokens ?? 0;
      const per1k = (tokens: number) => (correctness === null || tokens <= 0 ? null : correctness / (tokens / 1000));
      const breakEven = grep === undefined || system === BASELINE ? null : p.weightedTokens < grep ? buildTokens / (grep - p.weightedTokens) : null;
      (out[pack] ??= {})[system] = {
        correctness, queryTokens: p.weightedTokens, per1k: per1k(p.weightedTokens), buildTokens,
        breakEven: system === BASELINE ? 0 : breakEven,
        amortized: Object.fromEntries(AMORTIZE_AT.map((q) => [String(q), per1k(p.weightedTokens + buildTokens / q)])),
        n: p.n,
      };
    }
  }
  return out;
}

/** Per update batch: the incremental build of every group, and correctness of the answers given after it. */
function updatesOf(builds: BuildRecord[], answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): ReportData['updates'] {
  const out: ReportData['updates'] = {};
  const batchOf = new Map<string, string>();
  for (const a of answers) if (a.batch) batchOf.set(`${a.pack}|${a.system}|${a.taskId}`, a.batch);
  const packs = new Set([...builds.filter((b) => b.system.includes('@')).map((b) => b.pack), ...answers.filter((a) => a.batch).map((a) => a.pack)]);
  for (const pack of packs) {
    const batches = [...new Set([...builds.filter((b) => b.pack === pack && b.system.includes('@')).map((b) => b.system.split('@')[1]), ...answers.filter((a) => a.pack === pack && a.batch).map((a) => a.batch!)])].sort();
    out[pack] = batches.map((batch) => {
      const acc = new Map<string, number[]>();
      for (const s of scores) {
        if (s.pack !== pack || s.metric !== 'correctness' || s.value === null || batchOf.get(`${s.pack}|${s.system}|${s.taskId}`) !== batch) continue;
        (acc.get(s.system) ?? acc.set(s.system, []).get(s.system)!).push(s.value);
      }
      return {
        batch,
        builds: builds.filter((b) => b.pack === pack && b.system.endsWith(`@${batch}`)).map((b) => ({
          group: b.system.split('@')[0], ok: b.ok, ms: b.ms, weightedTokens: b.usage.weightedTokens, embeddingTokens: b.usage.embeddingTokens, calls: b.usage.calls,
        })),
        correctness: Object.fromEntries([...acc].map(([sys, vs]) => [sys, cell(vs)])),
      };
    });
  }
  return out;
}

const fmt = (c: Cell | undefined, digits = 2) => {
  if (!c || c.value === null || !Number.isFinite(c.value)) return '—';
  const v = round(c.value, digits).toFixed(digits);
  return c.ci && Number.isFinite(c.ci[0]) ? `${v} [${round(c.ci[0], digits).toFixed(digits)}, ${round(c.ci[1], digits).toFixed(digits)}]` : v;
};
const fmtNum = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(digits));
const fmtMs = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);

function table(rows: Record<string, Record<string, Cell>>, metrics: readonly string[], digits = 2): string {
  const systems = Object.keys(rows).sort();
  const used = metrics.filter((m) => systems.some((s) => rows[s][m]));
  if (!used.length) return '';
  return mdTable(['system', ...used, 'n'], systems.map((s) => [s, ...used.map((m) => fmt(rows[s][m], digits)), String(Math.max(...used.map((m) => rows[s][m]?.n ?? 0)))]));
}

const fmtMde = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : round(x, 3).toFixed(3));

/**
 * The separation table (docs/design/28): over the separation families,
 * correctness, stale answers (the value the corpus once stated, or a
 * look-alike's), confident wrong answers, look-alike items and citation
 * precision; over all tasks, stale and confident-wrong rates; and what an
 * answer costs — tool calls per answer, tokens and USD per correct answer.
 */
function separationTable(sep: Record<string, Record<string, Cell>>, cpc: NonNullable<ReportData['costPerCorrect']>[string]): string[] {
  const systems = [...new Set([...Object.keys(sep), ...Object.keys(cpc)])].sort();
  if (!systems.length) return [];
  const cols: [string, string][] = [['correctness', 'correctness (families)'], ['stale_answer', 'stale answers'], ['confident_wrong', 'confident wrong'], ['distractor_rate', 'look-alike items'], ['citation_precision', 'citation precision'], ['stale_answer_all', 'stale answers (all)'], ['confident_wrong_all', 'confident wrong (all)']];
  const used = cols.filter(([m]) => systems.some((s) => sep[s]?.[m]));
  const out = ['### Separation: stale, confident-wrong, look-alike, citations, cost per correct answer', ''];
  out.push('Over the separation families (stale, lookalike, structured, nonlexical-hop, connection, paraphrase, cross-lingual) unless marked "all". A stale answer gives a value the corpus stated earlier (or a look-alike entity\'s) instead of the current one; confident wrong is wrong without declining. Cost per correct answer divides all of a system\'s answer tokens (and USD) by its summed correctness.', '');
  out.push(mdTable(['system', ...used.map(([, h]) => h), 'tool calls / answer', 'tokens / correct', 'USD / correct'], systems.map((s) => [
    s, ...used.map(([m]) => fmt(sep[s]?.[m])), cpc[s] ? cpc[s].toolCalls.toFixed(1) : '—', fmtNum(cpc[s]?.tokens), cpc[s]?.usd === null || cpc[s]?.usd === undefined ? '—' : cpc[s].usd!.toFixed(4),
  ])), '');
  return out;
}

/** Correctness per task type for one pack, every system, and each system's paired Δ against the baseline with its MDE. */
function typeTable(types: Record<string, Record<string, Cell>>, deltas: Record<string, Record<string, Paired>>): string[] {
  const systems = [...new Set(Object.values(types).flatMap((t) => Object.keys(t)))].sort();
  const others = systems.filter((s) => s !== BASELINE);
  const rows = Object.keys(types).sort((a, b) => Number(SEPARATION_TYPES.has(b)) - Number(SEPARATION_TYPES.has(a)) || a.localeCompare(b));
  const out = ['### Correctness by task type', '', `Separation families first. Δ is each system's paired difference from ${BASELINE} on that type, with its MDE in parentheses.`, ''];
  out.push(mdTable(['type', 'n', ...systems, ...others.map((s) => `Δ ${s} (MDE)`)], rows.map((type) => [
    type, String(Math.max(...systems.map((s) => types[type][s]?.n ?? 0))), ...systems.map((s) => fmt(types[type][s])),
    ...others.map((s) => {
      const c = deltas[type]?.[s];
      return c ? `${c.diff >= 0 ? '+' : ''}${round(c.diff, 2).toFixed(2)} (${fmtMde(c.mde)})` : '—';
    }),
  ])), '');
  return out;
}

/** Programs shown by name in the agent tool-use table, beside every knode tool used; the rest are summed as "other". */
const TOOL_COLUMNS = 8;

/**
 * Agent tool use: calls per answer, then the most used programs and knode
 * tools as uses per answer (a pipeline `rg … | head` is one call and two
 * uses), over the answers that carry a trace.
 */
function toolTable(tu: Record<string, ToolUse>): string[] {
  const systems = Object.keys(tu).sort();
  const total = new Map<string, number>();
  for (const s of systems) for (const [t, v] of Object.entries(tu[s].perTool)) total.set(t, (total.get(t) ?? 0) + v);
  const ranked = [...total].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  // knode's tools are what the table is for: never folded into "other" behind the shell agents' programs
  const shown = [...ranked.filter((t) => !t.startsWith('knode_')).slice(0, TOOL_COLUMNS), ...ranked.filter((t) => t.startsWith('knode_'))];
  const others = [...total.keys()].filter((t) => !shown.includes(t));
  const out = ['### Agent tool use', '', 'Per answer, over the answers that carry a trace: tool calls (shell commands and MCP calls), then uses of each program (shell agents) or knode tool (MCP agent). A pipeline such as `rg … | head` is one call and two uses.', ''];
  out.push(mdTable(['system', 'traced', 'calls', ...shown, ...(others.length ? ['other'] : [])], systems.map((s) => {
    const x = tu[s];
    if (!x.traced) return [s, `0/${x.n}`, '—', ...shown.map(() => '—'), ...(others.length ? ['—'] : [])];
    const f = (v: number | undefined) => (v ? v.toFixed(1) : '0');
    return [s, `${x.traced}/${x.n}`, x.calls.toFixed(1), ...shown.map((t) => f(x.perTool[t])), ...(others.length ? [f(others.reduce((sum, t) => sum + (x.perTool[t] ?? 0), 0))] : [])];
  })), '');
  const untraced = systems.filter((s) => tu[s].traced < tu[s].n);
  if (untraced.length) out.push(`No trace on ${untraced.map((s) => `${s} (${tu[s].n - tu[s].traced} of ${tu[s].n})`).join(', ')}: answers recorded before agent traces were kept, or that failed before the session ran.`, '');
  return out;
}

const signed = (x: number, digits: number) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
const LADDER_COST: [Exclude<LadderMetric, 'correctness'>, string, number][] = [['tokens', 'weighted tokens', 0], ['usd', 'USD (API prices)', 4], ['seconds', 'latency (s)', 1], ['toolCalls', 'tool calls', 1]];

/**
 * The ladder (docs/design/33 §2, §5): each declared difference the run has
 * both arms for, paired over the same questions, for correctness and then for
 * cost, each with its minimum detectable difference. A tie in correctness at
 * lower cost is a result.
 */
function ladderLines(rows: LadderRow[] | undefined): string[] {
  if (!rows?.length) return [];
  const out = ['## The ladder', ''];
  out.push(`Each row is the later arm minus the earlier (A agent-grep, B agent-rag, C agent-knode-wiki-sources, D agent-knode-full), paired over the questions both were scored on, all packs pooled; first answers only. Intervals are paired bootstrap, 95%; "significant" is after Holm's correction across the ${rows.length} row(s) shown, metric by metric. MDE is the smallest difference this many pairs could detect (α 0.05, power 0.8): a |Δ| below it does not show the arms are the same. Rows whose arms the run does not have are left out (${LADDER_DIFFERENCES.length - rows.length} of ${LADDER_DIFFERENCES.length}).`, '');
  out.push('### Correctness', '');
  out.push(mdTable(['difference', 'measures', 'questions', 'later', 'earlier', 'Δ correctness', '95% CI', 'p', 'MDE', 'significant'], rows.map((r) => {
    const c = r.metrics.correctness;
    return [`${r.name} (${r.a} − ${r.b})`, r.measures, r.n, c.meanA.toFixed(3), c.meanB.toFixed(3), signed(c.diff, 3), `[${round(c.ci[0], 3)}, ${round(c.ci[1], 3)}]`, round(c.p, 4).toString(), fmtMde(c.mde), c.significant ? 'yes' : 'no'];
  })), '');
  out.push('### Cost', '');
  out.push('Per answer: Δ of the mean (later − earlier), its MDE in parentheses, * where significant after Holm.', '');
  out.push(mdTable(['difference', 'questions', ...LADDER_COST.map(([, h]) => `Δ ${h}`), ...LADDER_COST.map(([, h]) => `${h}: later / earlier`)], rows.map((r) => [
    r.name, r.n,
    ...LADDER_COST.map(([m, , d]) => {
      const c = r.metrics[m];
      return `${signed(c.diff, d)} (${Number.isFinite(c.mde) ? c.mde.toFixed(d) : '—'})${c.significant ? ' *' : ''}`;
    }),
    ...LADDER_COST.map(([m, , d]) => `${r.metrics[m].meanA.toFixed(d)} / ${r.metrics[m].meanB.toFixed(d)}`),
  ])), '');
  return out;
}

/** The discrimination table: questions every agent got fully right, none did, and the rest, overall and per type. */
function discriminationLines(d: Discrimination | undefined): string[] {
  if (!d) return [];
  const pct = (x: number, n: number) => (n ? `${x} (${((x / n) * 100).toFixed(0)}%)` : '0');
  const row = (label: string, c: DiscriminationCounts) => [label, c.n, pct(c.allRight, c.n), pct(c.noneRight, c.n), pct(c.rest, c.n)];
  const types = Object.keys(d.byType).sort((a, b) => Number(SEPARATION_TYPES.has(b)) - Number(SEPARATION_TYPES.has(a)) || a.localeCompare(b));
  const out = ['## Which questions tell the agents apart', ''];
  out.push(`Over the questions every agent system of the run was scored on (${d.systems.join(', ')}; first answers, all packs pooled): all of them fully right (correctness 1), none of them fully right, and the rest — the only questions on which they can differ. A family whose questions are mostly in the first two columns cannot show a difference between the arms whatever its size.`, '');
  out.push(mdTable(['task type', 'questions', 'all fully right', 'none fully right', 'the rest'], [row('**all**', d.overall), ...types.map((t) => row(t, d.byType[t]))]), '');
  return out;
}

/**
 * Up front: whether each pack's agent sample could separate the arms at all
 * (the share of its questions on which they differed, the smallest
 * difference it could detect, a verdict where none differed), and how the
 * sample was drawn.
 */
function separabilityLines(d: Separability | undefined): string[] {
  if (!d) return [];
  const pct = (x: number, n: number) => (n ? `${x} (${((x / n) * 100).toFixed(0)}%)` : '0');
  const mde = (m: PackSeparability['mde']) => (m ? `${fmtMde(m.median)}${m.max - m.min > 5e-4 ? ` (${fmtMde(m.min)}–${fmtMde(m.max)})` : ''}` : '—');
  const out = ['## Can this run separate the agents?', ''];
  const blind = d.packs.filter((p) => p.verdict);
  out.push(blind.length
    ? `**${blind.length} of ${d.packs.length} pack(s) cannot separate the agent arms at all**: ${blind.map((p) => p.pack).join(', ')}. On those, no arm scored differently from another on any question, so a tie there says nothing about the arms.`
    : `Every pack had at least one question on which the agent arms scored differently.`, '');
  out.push(`Over the questions every agent arm (${d.overall.agents.join(', ')}) was scored on: those on which their correctness differed at all — the only ones that can show a difference — and the smallest paired difference between two arms the sample could detect (MDE, α 0.05, power 0.8; the median over the pairs of arms whose scores differ somewhere, the range in parentheses). Pairs that never differ have no spread and are left out of the MDE.`, '');
  const row = (label: string, p: PackSeparability) => [label, p.n, pct(p.differ, p.n), pct(p.allRight, p.n), pct(p.noneRight, p.n), mde(p.mde), p.verdict ?? ''];
  out.push(mdTable(['pack', 'agent questions', 'arms differ', 'all fully right', 'none fully right', 'MDE', 'verdict'], [...d.packs.map((p) => row(p.pack, p)), row('**all packs**', d.overall)]), '');
  const s = d.sample;
  if (s) {
    out.push(`Agent sample: ${s.allocation?.mode === 'counts' ? 'the counts below' : `${s.limit} a pack`} by ${describeAllocation(s.allocation)}${s.updateLimit !== null ? `; at most ${s.updateLimit} update tasks a pack` : '; every update task'}.`);
    const packs = Object.keys(s.byPack).sort();
    if (s.allocation && packs.length) {
      const seen = (c: TypeTaken['seen']) => (c ? ` [${SAMPLE_TIERS.filter((k) => c[k]).map((k) => `${c[k]} ${k === 'unseen' ? 'unseen' : k}`).join(', ')}]` : '');
      out.push('', mdTable(['pack', 'taken / available by type (weight) [what the records saw of those taken]', 'update tasks'], packs.map((p) => [
        p,
        Object.entries(s.byPack[p]).sort(([, a], [, b]) => b.taken - a.taken || b.available - a.available).map(([t, c]) => `${t} ${c.taken}/${c.available}${c.weight !== undefined ? ` (${round(c.weight, 2)})` : ''}${seen(c.seen)}`).join(', '),
        s.updates?.[p] ? `${s.updates[p].taken}/${s.updates[p].available}` : '—',
      ])));
      for (const p of packs) {
        const q = s.questions?.[p];
        if (!q) continue;
        out.push('', `${p}: ${q.expected !== null ? `about ${q.expected.toFixed(1)} of ${q.n} questions expected to be contested before the run` : `${q.taken.contested} of ${q.n} seen contested`}${q.suspects.length ? `; ${q.suspects.length} all-wrong question(s) left out for audit` : ''}.${q.warning ? ` Warning: ${q.warning}.` : ''}`);
      }
    }
    out.push('');
  }
  return out;
}

/** knode's tools per agent that called them: calls, and correctness of the answers that used each against the rest. */
function knodeToolLines(rows: Record<string, KnodeToolRow[]> | undefined): string[] {
  if (!rows || !Object.keys(rows).length) return [];
  const out = ['### knode tools and correctness', ''];
  out.push('Per agent that called knode\'s tools (arm D, and the MCP-only diagnostic): each tool\'s calls over its traced answers and per traced answer, then the mean correctness of the scored answers that called it at least once against the scored answers that did not. Descriptive: an agent picks a tool for a kind of question, so the two groups differ in their questions too.', '');
  for (const [system, rs] of Object.entries(rows).sort()) {
    out.push(mdTable(['system', 'tool', 'calls', 'per answer', 'scored answers using it', 'correctness using it', 'scored answers not using it', 'correctness not using it', 'Δ'], rs.map((r) => [
      system, r.tool, r.calls, r.perAnswer.toFixed(2), r.used.n, fmt(r.used), r.unused.n, fmt(r.unused),
      r.used.value !== null && r.unused.value !== null ? signed(r.used.value - r.unused.value, 2) : '—',
    ])), '');
  }
  return out;
}

/** The per-system answering table, with what a correct answer costs beside correctness. */
function usageTable(rows: Record<string, Record<string, Cell>>, cpc: NonNullable<ReportData['costPerCorrect']>[string] | undefined): string {
  const systems = Object.keys(rows).sort();
  const used = USAGE_METRICS.filter((m) => systems.some((s) => rows[s][m]));
  if (!used.length) return '';
  const at = used.indexOf('correctness') + 1;
  const headers = ['system', ...used.slice(0, at), ...(at ? ['USD / correct', 'tokens / correct'] : []), ...used.slice(at), 'n'];
  return mdTable(headers, systems.map((s) => {
    const cells = used.map((m) => fmt(rows[s][m]));
    const cost = at ? [cpc?.[s]?.usd === null || cpc?.[s]?.usd === undefined ? '—' : cpc[s].usd!.toFixed(4), fmtNum(cpc?.[s]?.tokens)] : [];
    return [s, ...cells.slice(0, at), ...cost, ...cells.slice(at), String(Math.max(...used.map((m) => rows[s][m]?.n ?? 0)))];
  }));
}

/** Where the work was published and who did it, and what was left stuck (docs/design/32). */
function placementLines(d: ReportData): string[] {
  const work = d.run?.work;
  const ran = d.ranAt ?? [];
  const stuck = d.run?.stuck ?? [];
  if (!work && !ran.length && !stuck.length) return [];
  const out = ['## Where the work ran', ''];
  if (work) {
    const local = work.local ? Object.entries(work.local).filter(([, n]) => n).map(([f, n]) => `${f}:${n}`).join(',') : '';
    out.push(`- Published to ${work.broker === 'serve' ? `serve's broker (${work.serve ?? 'this machine'})` : "the run's own broker"}; this machine's slots: ${local ? `--local ${local}${work.legacy ? ' (an old command line: sized from --slots)' : ''}` : 'none'}; pool required: ${work.pool ?? 'any'}; wait limit: ${work.waitMinutes ? `${work.waitMinutes} min` : 'none'}.`);
  }
  if (ran.length) {
    out.push('', mdTable(['pool', 'worker', 'model calls', 'agent sessions', 'replayed from cache'], ran.map((r) => [r.pool, r.worker, String(r.calls), String(r.sessions), String(r.replayed)])));
  }
  if (stuck.length) {
    out.push('', `### Stuck: ${stuck.length} piece(s) left unanswered`, '', 'Three different workers could not serve each of these. The answer, build or scoring pass it belonged to was not recorded; a resume asks it again.', '');
    out.push(mdTable(['piece', 'system', 'task', 'requires', 'workers', 'last error'], stuck.map((p) => [p.label, p.system ?? '—', p.task ?? '—', `${p.family} ${p.model || 'default'}${p.pool ? ` · pool ${p.pool}` : ''}${p.eligible === 'local' ? ' · this machine' : ''}`, p.workers.join(', '), p.lastError.slice(0, 160).replace(/\|/g, '/').replace(/\n/g, ' ')])));
  }
  out.push('');
  return out;
}

export function renderReport(d: ReportData): string {
  const meta = d.run;
  const lines: string[] = [];
  lines.push(`# Knowledge benchmark — ${meta?.id ?? ''}`, '');
  if (meta) {
    lines.push(`- Model: ${meta.model.label} (build effort ${meta.model.buildEffort}, answer effort ${meta.model.answerEffort}); judge: ${meta.judge.label}; embedder: ${meta.embedding}`);
    // knode's index backend (docs/design/31 D1): runs on PGlite and on PostgreSQL are compared, not pooled
    lines.push(`- knode index: ${meta.database?.at ?? 'pglite'}${meta.database?.poolSize ? ` (pool of ${meta.database.poolSize})` : ''}`);
    lines.push(`- Packs: ${d.packs.join(', ')}; systems: ${d.systems.join(', ')}; corpus fraction ${meta.fraction}, seed ${meta.seed}; git ${meta.gitSha?.slice(0, 10) ?? '?'}`);
    lines.push(`- Judge calls: ${d.judgeUsage.calls}`, '');
  }
  lines.push(...separabilityLines(d.separability));
  lines.push(...placementLines(d));
  lines.push('Intervals are Wilson (rates) or bootstrap (means), 95%. Correctness is the judge score scaled to 0–1. "—" means not measured or not applicable (a system that does not cite has no citation score).', '');
  lines.push(...ladderLines(d.ladder));
  lines.push(...discriminationLines(d.discrimination));

  if (d.pooled.length) {
    lines.push(`## Pooled correctness against ${BASELINE}`, '');
    lines.push('Paired over the tasks both systems answered, all packs pooled; significance after Holm correction across systems.', '');
    lines.push('MDE is the minimum detectable effect of each comparison (α 0.05, power 0.8, from the spread of its paired differences): a |Δ| below it is not evidence the systems are the same — the benchmark could not have told.', '');
    lines.push(mdTable(['system', 'Δ correctness', '95% CI', 'p', 'MDE', 'paired tasks', 'significant'], d.pooled.sort((a, b) => b.diff - a.diff).map((c) => [c.system, round(c.diff, 3).toFixed(3), `[${round(c.ci[0], 3)}, ${round(c.ci[1], 3)}]`, round(c.p, 4).toString(), fmtMde(c.mde), String(c.n), c.significant ? 'yes' : 'no'])), '');
    const sys = d.pooled.map((c) => c.system);
    lines.push(chartBlock({ type: 'hbar', title: `Correctness difference vs ${BASELINE}`, unit: 'Δ correctness (0–1)', x: sys, series: [{ name: 'Δ correctness', values: d.pooled.map((c) => round(c.diff, 3)) }], source: 'scores.jsonl' }), '');
  }

  lines.push(...judgeAuditLines(d.judgeAudit));

  for (const pack of d.packs) {
    lines.push(`## ${pack}`, '');
    const pr = d.paired?.[pack];
    if (pr?.length) {
      lines.push(`### Paired against ${BASELINE}`, '');
      lines.push(mdTable(['system', 'Δ correctness', '95% CI', 'p', 'MDE', 'paired tasks', '|Δ| ≥ MDE'], [...pr].sort((a, b) => b.diff - a.diff).map((c) => [c.system, round(c.diff, 3).toFixed(3), `[${round(c.ci[0], 3)}, ${round(c.ci[1], 3)}]`, round(c.p, 4).toString(), fmtMde(c.mde), String(c.n), Number.isFinite(c.mde) && Math.abs(c.diff) >= c.mde ? 'yes' : 'no'])), '');
    }
    const u = d.usage[pack];
    if (u) lines.push('### Use: answering', '', 'USD and tokens per correct answer divide all of a system\'s answer cost by its summed correctness (a half-right answer is half an answer).', '', usageTable(u, d.costPerCorrect?.[pack]), '');
    const sep = d.separation?.[pack];
    const cpc = d.costPerCorrect?.[pack];
    if (sep || cpc) lines.push(...separationTable(sep ?? {}, cpc ?? {}));
    const tp = d.typesByPack?.[pack];
    if (tp) lines.push(...typeTable(tp, d.typeDeltas?.[pack] ?? {}));
    const vr = d.variance?.[pack];
    if (vr && Object.keys(vr).length) {
      lines.push('### Run-to-run variance', '', 'Systems that answered the same tasks more than once (`eval run --repeat`): mean correctness of each repeat over the tasks every repeat answered, the spread across repeats, the mean spread within a task, and the share of tasks whose score changed.', '');
      lines.push(mdTable(['system', 'repeats', 'tasks', 'correctness per repeat', 'SD across repeats', 'mean within-task SD', 'unstable tasks'], Object.entries(vr).sort().map(([s, v]) => [
        s, v.repeats, v.tasks, v.perRepeat.map((x) => round(x, 3).toFixed(3)).join(' / '), fmtMde(v.sdAcrossRepeats), fmtMde(v.withinTaskSd), `${(v.unstable * 100).toFixed(0)}%`,
      ])), '');
      const rp = d.repeatPairs?.[pack];
      if (d.run?.repeat?.sample) lines.push(`Repeats after the first answered a seeded sample of ${d.run.repeat.sample} tasks, stratified by task type (\`--repeat-sample\`); the spread above is on that sample.`, '');
      if (rp?.length) {
        lines.push('#### Paired differences against the run-to-run spread', '', 'On the tasks both systems answered in every repeat: the difference of their mean correctness in each repeat, its mean, and the spread a single run\'s difference has from rerunning alone (√(SD a² + SD b²), from the repeats). Within the spread: the repeats disagree on the sign, or |Δ| ≤ 2 × that spread — the difference is not one rerunning could not produce.', '');
        lines.push(mdTable(['a', 'b', 'tasks', 'Δ per repeat', 'mean Δ', 'run-to-run spread of Δ', 'within the spread'], rp.map((p) => [
          p.a, p.b, p.tasks, p.perRepeat.map((x) => round(x, 3).toFixed(3)).join(' / '), round(p.diff, 3).toFixed(3), fmtMde(p.noise), p.withinSpread ? 'yes' : 'no',
        ])), '');
      }
    }
    const r = d.retrieval[pack];
    if (r) lines.push('### Use: retrieval', '', table(r, RETRIEVAL_METRICS), '');
    const pq = d.perQuery[pack];
    if (pq) {
      lines.push('### Per-query cost', '');
      lines.push(mdTable(['system', 'answers', 'p50 latency', 'tool calls', 'weighted tokens', 'USD (API prices)', 'capped', 'leaked', 'errors'],
        Object.entries(pq).sort().map(([s, p]) => [s, p.n, fmtMs(p.latencyP50), p.toolCalls.toFixed(1), fmtNum(p.weightedTokens), p.costUsd.toFixed(4), p.capped, p.leaked, p.errors])), '');
      const stopped = Object.entries(pq).filter(([, p]) => p.unmetered).sort();
      if (stopped.length) lines.push(`Stopped at the command cap before any usage was reported, an empty answer each: ${stopped.map(([s, p]) => `${s} ${p.unmetered} of ${p.n}`).join(', ')}. Their tokens are unknown and are left out of the means above; their correctness is 0, so a comparison of correctness between these systems also compares how often each was stopped.`, '');
      const closed = Object.entries(pq).filter(([, p]) => p.closed).sort();
      if (closed.length) lines.push(`Stopped at the command cap and answered in the closing turn (told to answer from what it had read, with no tools; docs/design/36 §5): ${closed.map(([s, p]) => `${s} ${p.closed} of ${p.n}`).join(', ')}. They count as capped; that turn's tokens are in the means above.`, '');
      const pts = Object.entries(pq).filter(([s]) => u?.[s]?.correctness);
      if (pts.length >= 2) {
        lines.push(chartBlock({ type: 'scatter', title: `${pack}: correctness vs cost per query`, x: pts.map(([s]) => s), series: [
          { name: 'weighted tokens per query', values: pts.map(([, p]) => Math.round(p.weightedTokens)) },
          { name: 'correctness', values: pts.map(([s]) => round(u![s].correctness.value ?? 0, 3)) },
        ], source: 'answers.jsonl, scores.jsonl' }), '');
      }
    }
    const tu = d.tools[pack];
    if (tu) lines.push(...toolTable(tu));
    lines.push(...knodeToolLines(d.knodeTools?.[pack]));
    const l = d.lists[pack];
    if (l) lines.push('### Use: corpus-level lists (aggregate, timeline, contradiction, profile)', '', 'Correctness here is set F1 (recall where the gold is a sample), times order accuracy for a timeline; em is a count\'s exact number.', '', table(l, LIST_METRICS), '');
    const eff = d.efficiency[pack];
    if (eff && Object.values(eff).some((x) => x.correctness !== null)) {
      lines.push('### Correctness for its cost', '');
      lines.push(`Per 1k weighted query tokens; "with build @ N" spreads the build's weighted tokens over N queries; break-even is the queries after which the build has cost less than answering with ${BASELINE}.`, '');
      lines.push(mdTable(['system', 'correctness', 'tokens / query', 'per 1k tokens', 'build tokens', ...AMORTIZE_AT.map((q) => `with build @ ${q}`), 'break-even queries'],
        Object.entries(eff).sort().map(([s, x]) => [
          s, x.correctness === null ? '—' : round(x.correctness, 3).toFixed(3), fmtNum(x.queryTokens), x.per1k === null ? '—' : round(x.per1k, 4).toFixed(4), fmtNum(x.buildTokens),
          ...AMORTIZE_AT.map((q) => (x.amortized[String(q)] === null ? '—' : round(x.amortized[String(q)]!, 4).toFixed(4))),
          s === BASELINE ? '—' : x.breakEven === null ? 'never' : fmtNum(x.breakEven),
        ])), '');
    }
    const ups = d.updates[pack];
    if (ups?.length) {
      lines.push('### Update stream', '');
      const sys = [...new Set(ups.flatMap((u) => Object.keys(u.correctness)))].sort();
      const groups = [...new Set(ups.flatMap((u) => u.builds.map((b) => b.group)))].sort();
      lines.push(mdTable(['batch', ...groups.map((g) => `${g} weighted tokens`), ...sys.map((x) => `${x} correctness`)], ups.map((u) => [
        u.batch,
        ...groups.map((g) => {
          const b = u.builds.find((x) => x.group === g);
          return b ? (b.ok ? fmtNum(b.weightedTokens) : 'failed') : '—';
        }),
        ...sys.map((x) => fmt(u.correctness[x])),
      ])), '');
    }
    const e = d.emergence[pack];
    if (e) lines.push('### Emergence', '', table(e, EMERGENCE_METRICS), '');
    const g = d.generation[pack];
    if (g) lines.push('### Knowledge generation', '', table(g, GENERATION_METRICS), '');
    const b = d.builds.filter((x) => x.pack === pack);
    if (b.length) {
      lines.push('### Build cost', '');
      lines.push(mdTable(['build', 'ok', 'wall', 'LLM time', 'calls', 'input', 'cached', 'output', 'weighted tokens', 'embedding tokens', 'USD (API prices)', 'disk', 'peak RSS', 'break-even queries'],
        b.map((x) => [
          x.system, x.ok ? 'yes' : `no: ${(x.error ?? '').slice(0, 40)}`, fmtMs(x.ms), fmtMs(x.usage.llmMs), x.usage.calls, fmtNum(x.usage.inputTokens), fmtNum(x.usage.cachedInputTokens), fmtNum(x.usage.outputTokens),
          fmtNum(x.usage.weightedTokens), fmtNum(x.usage.embeddingTokens), x.usage.costUsd.toFixed(3), `${(x.bytes / 1e6).toFixed(1)} MB`, x.peakRssBytes ? `${(x.peakRssBytes / 1e6).toFixed(0)} MB` : '—',
          d.breakEven[pack]?.[x.system] === undefined ? '—' : d.breakEven[pack][x.system] === null ? 'never' : fmtNum(d.breakEven[pack][x.system]),
        ])), '');
      const stages = b.filter((x) => Object.keys(x.stages).length);
      for (const x of stages) {
        lines.push(`<details><summary>${x.system}: usage by stage</summary>`, '', mdTable(['stage', 'calls', 'weighted tokens', 'LLM time', 'embedding tokens'], Object.entries(x.stages).map(([st, us]) => [st, us.calls, fmtNum(us.weightedTokens), fmtMs(us.llmMs), fmtNum(us.embeddingTokens)])), '', '</details>', '');
      }
    }
  }

  const types = [...new Set(Object.values(d.byType).flatMap((t) => Object.keys(t)))].sort();
  if (types.length) {
    lines.push('## Correctness by task type (all packs, descriptive)', '');
    lines.push(mdTable(['system', ...types], Object.entries(d.byType).sort().map(([s, t]) => [s, ...types.map((ty) => fmt(t[ty]))])), '');
  }
  return lines.join('\n');
}

export function writeReport(runDir: string): { md: string; json: string; data: ReportData } {
  const data = buildReportData(runDir);
  const md = path.join(runDir, 'report.md');
  const json = path.join(runDir, 'report.json');
  fs.writeFileSync(md, renderReport(data));
  fs.writeFileSync(json, JSON.stringify(data, null, 2));
  return { md, json, data };
}

/* -------------------------------- scale curves -------------------------------- */

export interface ScalePoint {
  run: string;
  fraction: number;
  documents: number | null;
  chars: number | null;
  correctness: Cell;
  /** Correctness on the corpus-level lists alone. */
  listCorrectness: Cell;
  queryTokens: number | null;
  buildTokens: number | null;
  capped: number;
  n: number;
}

/**
 * Scale curves (docs/design/23 §4): the same packs and systems run at several
 * `--fraction`s (1, 3, 10 — padding above 1), one run directory each, read
 * side by side — where agent-grep and long-context degrade, and whether a
 * wiki holds.
 */
export function buildScaleData(runDirs: string[]): Record<string, Record<string, ScalePoint[]>> {
  const out: Record<string, Record<string, ScalePoint[]>> = {};
  for (const dir of runDirs) {
    const d = buildReportData(dir);
    const fraction = Number(d.run?.fraction ?? 1);
    for (const pack of d.packs) {
      const staged = d.run?.staged?.[pack];
      const systems = new Set([...Object.keys(d.usage[pack] ?? {}), ...Object.keys(d.perQuery[pack] ?? {})]);
      for (const system of systems) {
        const pq = d.perQuery[pack]?.[system];
        ((out[pack] ??= {})[system] ??= []).push({
          run: d.run?.id ?? path.basename(dir), fraction, documents: staged?.documents ?? null, chars: staged?.chars ?? null,
          correctness: d.usage[pack]?.[system]?.correctness ?? { value: null, n: 0 },
          listCorrectness: d.lists[pack]?.[system]?.correctness ?? { value: null, n: 0 },
          queryTokens: pq?.weightedTokens ?? null, buildTokens: d.efficiency[pack]?.[system]?.buildTokens ?? null,
          capped: pq?.capped ?? 0, n: pq?.n ?? 0,
        });
      }
    }
  }
  for (const bySystem of Object.values(out)) for (const pts of Object.values(bySystem)) pts.sort((a, b) => a.fraction - b.fraction);
  return out;
}

export function renderScale(data: Record<string, Record<string, ScalePoint[]>>): string {
  const lines: string[] = ['# Knowledge benchmark — scale curves', ''];
  lines.push('One run per corpus size (`--fraction`; above 1 the pack\'s padding is added). Correctness over all usage tasks, and over the corpus-level lists alone; weighted tokens per query; the build\'s weighted tokens. A system missing at a size was not applicable there (long-context past its window) or its build failed.', '');
  for (const [pack, bySystem] of Object.entries(data).sort()) {
    const fractions = [...new Set(Object.values(bySystem).flatMap((p) => p.map((x) => x.fraction)))].sort((a, b) => a - b);
    const sizeOf = (f: number) => Object.values(bySystem).flatMap((p) => p).find((x) => x.fraction === f && x.documents !== null);
    lines.push(`## ${pack}`, '');
    lines.push(fractions.map((f) => {
      const s = sizeOf(f);
      return `- ${f}×: ${s ? `${s.documents} documents, ${fmtNum(s.chars)} characters` : 'size not recorded'}`;
    }).join('\n'), '');
    const at = (system: string, f: number) => bySystem[system].find((x) => x.fraction === f);
    const systems = Object.keys(bySystem).sort();
    lines.push(mdTable(['system', ...fractions.map((f) => `correctness @${f}×`), ...fractions.map((f) => `lists @${f}×`), ...fractions.map((f) => `tokens/query @${f}×`), ...fractions.map((f) => `build tokens @${f}×`)],
      systems.map((sys) => [
        sys,
        ...fractions.map((f) => fmt(at(sys, f)?.correctness)),
        ...fractions.map((f) => fmt(at(sys, f)?.listCorrectness)),
        ...fractions.map((f) => fmtNum(at(sys, f)?.queryTokens)),
        ...fractions.map((f) => fmtNum(at(sys, f)?.buildTokens || null)),
      ])), '');
    if (fractions.length >= 2) {
      const plotted = systems.filter((sys) => bySystem[sys].some((x) => x.correctness.value !== null)).slice(0, 8);
      lines.push(chartBlock({
        type: fractions.length >= 3 ? 'line' : 'bar', title: `${pack}: correctness by corpus size`, unit: 'correctness (0–1)', x: fractions.map((f) => `${f}×`),
        series: plotted.map((sys) => ({ name: sys, values: fractions.map((f) => (at(sys, f)?.correctness.value === null || at(sys, f) === undefined ? null : round(at(sys, f)!.correctness.value!, 3))) })),
        source: 'scores.jsonl of each run',
      }), '');
    }
  }
  return lines.join('\n');
}
