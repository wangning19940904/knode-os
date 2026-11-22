import type { RunMeta } from './runstore.js';
import type { Task } from './types.js';

/**
 * Where a run's agent sessions go (`eval run --agent-limit` and its
 * allocation over task types). Round-robin over types, as `selectTasks`
 * samples without an allocation, spends most of a pack's sessions on
 * families every arm gets right: an allocation gives those a small floor and
 * the rest of the budget to the families on which the arms can differ —
 * named weights or counts, or weights derived from a previous run's records.
 */

/**
 * How one pack's agent sample is spread over task types, when not round-robin
 * (`--agent-weights`, `--agent-counts`, `--agent-headroom-from`): relative
 * weights that share the limit, or fixed counts (the limit does not apply).
 * `'*'` stands for every type not named: weight 1, count 0 by default.
 */
export interface TypeShares {
  weights?: Record<string, number>;
  counts?: Record<string, number>;
  /** With weights: questions every type of a positive weight gets before the weights share the rest. */
  floor?: number;
}

/**
 * What a previous run saw of one task type (docs/design/33 §5): questions
 * every agent arm was scored on, those on which their correctness was not all
 * the same, the sum over the questions of how far apart the arms' scores
 * were (highest − lowest), and those all of them got fully right, or none did.
 */
export interface TypeEvidence {
  n: number;
  differ: number;
  /** Σ (highest − lowest correctness among the arms); from a report.json, its "rest" count stands in. */
  spread: number;
  allRight: number;
  noneRight: number;
}

/**
 * The agent sample's allocation over task types, as a run records it in
 * `run.json` (`agentSample.allocation`): explicit weights or counts, or
 * weights derived per pack from a previous run's records (`headroom`).
 */
export interface AgentAllocation {
  mode: 'weights' | 'counts' | 'headroom';
  weights?: Record<string, number>;
  counts?: Record<string, number>;
  floor?: number;
  /** headroom: the records the weights came from (run directories, report.json, scores.jsonl, campaign.json). */
  from?: string[];
  /** headroom: each pack's weights, and `'*'` for a pack the records do not have. */
  byPack?: Record<string, Record<string, number>>;
  /** headroom: what the records saw, per pack and type. */
  evidence?: Record<string, Record<string, TypeEvidence>>;
}

/** What `run.json` records of the agent sample: its limit, its allocation (null: round-robin) and what each pack took. */
export interface AgentSample {
  limit: number;
  /** At most this many update tasks per pack for agents; null: all of them. */
  updateLimit: number | null;
  allocation: AgentAllocation | null;
  /** Per pack and type: the tasks the pack had for agents, those taken, and the type's weight. */
  byPack: Record<string, Record<string, { available: number; taken: number; weight?: number }>>;
  /** Per pack with update tasks: how many it had, and how many agents answer. */
  updates: Record<string, { available: number; taken: number }>;
}

/** Headroom: questions of the type's pooled rate a pack's own few count for (its 3 or so a type at 30 a pack). */
export const HEADROOM_PRIOR = 5;
/** Headroom: the floor every type of a pack gets, unless the command line says otherwise. */
export const HEADROOM_FLOOR = 1;

/**
 * Weights per pack from what a previous run saw (`--agent-headroom-from`):
 * each type's weight is the mean spread of the agent arms' scores on its
 * questions (highest − lowest) — how far apart the arms came, on average, on
 * a question of the type. A family every arm gets right (or every arm gets
 * equally wrong) has none; one whose questions the arms split on has the
 * most. Not merely the share of questions that differ at all: the campaign's
 * timelines differed on 17 of 32 questions, mostly by under 0.2, and a
 * question 0.02 apart cannot carry a difference of 0.05. A pack sees few
 * questions of a type, so its own mean is shrunk toward the type's mean
 * over every pack of the records (worth `HEADROOM_PRIOR` questions), and
 * that toward ½ (Jeffreys). A type no pack saw gets the mean over everything
 * (`'*'`).
 */
export function headroomAllocation(evidence: Record<string, Record<string, TypeEvidence>>, opts: { floor?: number; from?: string[] } = {}): AgentAllocation {
  // evidence recorded before spreads were: each differing question counts as a full spread
  const spreadOf = (e: TypeEvidence) => e.spread ?? e.differ;
  const pooled = new Map<string, { n: number; spread: number }>();
  let all = { n: 0, spread: 0 };
  for (const types of Object.values(evidence)) {
    for (const [type, e] of Object.entries(types)) {
      const p = pooled.get(type) ?? pooled.set(type, { n: 0, spread: 0 }).get(type)!;
      p.n += e.n;
      p.spread += spreadOf(e);
      all = { n: all.n + e.n, spread: all.spread + spreadOf(e) };
    }
  }
  const jeffreys = (e: { n: number; spread: number }) => (e.spread + 0.5) / (e.n + 1);
  const typeRate = Object.fromEntries([...pooled].map(([t, e]) => [t, jeffreys(e)]));
  const rest = jeffreys(all);
  const byPack: Record<string, Record<string, number>> = { '*': { ...typeRate, '*': rest } };
  for (const [pack, types] of Object.entries(evidence)) {
    const w: Record<string, number> = { ...typeRate, '*': rest };
    for (const [type, e] of Object.entries(types)) w[type] = (spreadOf(e) + HEADROOM_PRIOR * typeRate[type]) / (e.n + HEADROOM_PRIOR);
    byPack[pack] = w;
  }
  const round6 = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
  return {
    mode: 'headroom', floor: opts.floor ?? HEADROOM_FLOOR, ...(opts.from ? { from: opts.from } : {}),
    byPack: Object.fromEntries(Object.entries(byPack).map(([p, w]) => [p, round6(w)])), evidence,
  };
}

/** Per type: the tasks a pack had for agents, those the sample took, and the type's weight or count under the shares. */
export function sampleByType(pool: Task[], taken: Task[], shares: TypeShares | null): AgentSample['byPack'][string] {
  const out: AgentSample['byPack'][string] = {};
  for (const t of pool) (out[t.type] ??= { available: 0, taken: 0, ...(shares ? { weight: shareOf(shares, t.type) } : {}) }).available++;
  for (const t of taken) if (out[t.type]) out[t.type].taken++;
  return out;
}

/**
 * One pack's shares under an allocation. A headroom allocation knows a pack
 * by its directory's name (a run of one pack records it so in `run.json`) or
 * its manifest id (two versions of a pack may share one): the first of
 * `names` it has, else its pooled weights.
 */
export function sharesFor(allocation: AgentAllocation, ...names: string[]): TypeShares {
  if (allocation.mode === 'counts') return { counts: allocation.counts ?? {} };
  const known = names.find((n) => allocation.byPack?.[n]);
  const weights = allocation.mode === 'headroom' ? allocation.byPack?.[known ?? '*'] ?? {} : allocation.weights ?? {};
  return { weights, floor: allocation.floor ?? (allocation.mode === 'headroom' ? HEADROOM_FLOOR : 0) };
}

/** A type's weight or count under shares: named, else `'*'`, else 1 (a weight) or 0 (a count). */
export function shareOf(shares: TypeShares, type: string): number {
  if (shares.counts) return Math.max(0, Math.trunc(shares.counts[type] ?? shares.counts['*'] ?? 0));
  return Math.max(0, shares.weights?.[type] ?? shares.weights?.['*'] ?? 1);
}

/**
 * How many tasks each type gives (types in the order given, which is the
 * seeded order `selectTasks` met them in): with counts, each type's count, at
 * most what it has; with weights, first `floor` of every type of a positive
 * weight (one round at a time while the limit lasts), then the rest of the
 * limit in proportion to the weights of the types that still have tasks,
 * whole questions by largest share, until the limit or the tasks run out. A
 * type of weight 0 gives nothing.
 */
export function typeQuotas(available: Map<string, number>, limit: number, shares: TypeShares): Map<string, number> {
  const q = new Map([...available.keys()].map((t) => [t, 0]));
  if (shares.counts) {
    for (const [t, n] of available) q.set(t, Math.min(n, shareOf(shares, t)));
    return q;
  }
  const types = [...available.keys()].filter((t) => shareOf(shares, t) > 0);
  let total = 0;
  const open = () => types.filter((t) => q.get(t)! < available.get(t)!);
  for (let r = 0; r < Math.max(0, Math.trunc(shares.floor ?? 0)); r++) {
    for (const t of open()) {
      if (total >= limit) break;
      q.set(t, q.get(t)! + 1);
      total++;
    }
  }
  while (total < limit) {
    const o = open();
    if (!o.length) break;
    const left = limit - total;
    const w = o.reduce((s, t) => s + shareOf(shares, t), 0);
    const ideal = o.map((t) => (left * shareOf(shares, t)) / w);
    let given = 0;
    o.forEach((t, i) => {
      const g = Math.min(available.get(t)! - q.get(t)!, Math.floor(ideal[i]));
      q.set(t, q.get(t)! + g);
      given += g;
    });
    total += given;
    if (given) continue;
    // every share under one question: the largest shares take one each (the earlier type on a tie)
    for (const i of o.map((_, i) => i).sort((a, b) => ideal[b] - ideal[a] || a - b)) {
      if (total >= limit) break;
      q.set(o[i], q.get(o[i])! + 1);
      total++;
    }
  }
  return q;
}

/**
 * The allocation a run samples its agents by: the one the command line gives,
 * or on a resume the one the run recorded — the same tasks again. A resume
 * may not change it (its first answers were taken by the other), nor give one
 * to a run that sampled round-robin.
 */
export function agentAllocationFor(given: AgentAllocation | null | undefined, meta: RunMeta | null): AgentAllocation | null {
  if (!meta) return given ?? null;
  const recorded = meta.agentSample?.allocation ?? null;
  if (!given) return recorded;
  const spec = (a: AgentAllocation) => JSON.stringify({ mode: a.mode, weights: a.weights ?? null, counts: a.counts ?? null, floor: a.floor ?? null, from: a.from ?? null });
  if (!recorded) throw new Error(`run ${meta.id} sampled its agent questions round-robin over task types: resume it without --agent-weights/--agent-counts/--agent-headroom-from, or start a new run`);
  if (spec(recorded) !== spec(given)) throw new Error(`run ${meta.id} sampled its agent questions by ${describeAllocation(recorded)}: resume it with that allocation (or none), or start a new run`);
  return recorded;
}

/** An allocation in a few words, for logs, errors and the report. */
export function describeAllocation(a: AgentAllocation | null): string {
  if (!a) return 'round-robin over task types';
  const pairs = (r: Record<string, number> | undefined) => Object.entries(r ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
  if (a.mode === 'counts') return `counts ${pairs(a.counts)}`;
  if (a.mode === 'weights') return `weights ${pairs(a.weights)}${a.floor ? `, floor ${a.floor}` : ''}`;
  return `headroom from ${(a.from ?? []).join(', ') || 'a previous run'}, floor ${a.floor ?? HEADROOM_FLOOR}`;
}
