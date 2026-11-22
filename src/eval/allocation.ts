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
  /**
   * Headroom: what the records saw of this pack's questions (`QuestionClass`, by task id). With it the
   * sample is drawn in tiers (`SAMPLE_TIERS`): contested questions first, then those never seen, then
   * those every arm agreed on; all-wrong ones only up to `suspects`.
   */
  classes?: Record<string, QuestionClass>;
  /** Headroom: all-wrong questions the sample may take, after every other one (default 0). */
  suspects?: number;
  /** Headroom: the share of a type's seen questions that were contested, for this pack (`'*'`: the rest). */
  contested?: Record<string, number>;
}

/**
 * What earlier records saw of one question, over the agent arms' answers,
 * repeats included:
 * - `contested`: two arms scored it differently, or one arm's repeat answers
 *   did. Only on these can a paired difference between arms show.
 * - `right`: every answer fully right; `partial`: every answer the same
 *   partial score. Neither carries information about which arm is better.
 * - `wrong`: every answer of two or more arms scored 0. Suspect: wrong gold,
 *   or not answerable from the corpus, until a person reads it (`eval pack
 *   lint --answers` lists them).
 */
export type QuestionClass = 'contested' | 'right' | 'partial' | 'wrong';

/**
 * The order the sample is drawn in when the records saw the questions, each
 * tier by the type quotas over what the tiers before it left of the limit.
 * Contested questions come first: on the 2026-11 records 9 of the campaign's
 * 11 contested questions on `real-loong-finance` and `real-mudabench` were
 * contested again in the next run (protocol 36), against 23 of the 171 it
 * asked that the campaign had not. Questions never seen come next, by the type
 * weights. Agreed ones only when nothing else is left: 25 of 27 the campaign
 * saw all right were all right again. All-wrong ones (`wrong`) are left out
 * and listed for audit unless `--agent-suspects` lets a few in: 14 of 17
 * stayed all-wrong with the same arms, and of the 41 all-wrong questions of
 * the next run's `real-loong-finance` sample 26 were all right, the answers
 * unchanged, once the gold and the set grading were repaired (2 more were
 * removed as unanswerable; docs/design/36 §5). A suspect question costs the sessions
 * of a live one and cannot move a paired difference; reading it against its
 * passage costs no model call, and a repaired question comes back as seen
 * under the re-scored records.
 */
export const SAMPLE_TIERS: readonly (QuestionClass | 'unseen')[] = ['contested', 'unseen', 'right', 'partial', 'wrong'];

/**
 * A question's class from its scores, one list per agent arm (each arm's
 * repeat answers): null when the records cannot say — fewer than two arms
 * scored it, unless one arm's repeats already disagree.
 */
export function questionClassOf(arms: number[][]): QuestionClass | null {
  const answered = arms.filter((a) => a.length);
  const all = answered.flat();
  const differ = all.length > 1 && Math.max(...all) - Math.min(...all) >= 1e-9;
  if (answered.length < 2) return differ ? 'contested' : null;
  if (differ) return 'contested';
  if (all[0] >= 1) return 'right';
  return all[0] <= 0 ? 'wrong' : 'partial';
}

/** One score of an answer, as `questionClasses` reads it: `arm` names the arm (a system, or a source and system). */
export interface AnswerScore {
  arm: string;
  pack: string;
  taskId: string;
  taskType?: string;
  value: number | null;
}

/** Per pack and task: the question's type and class (`questionClassOf`), over the scores given; unclassed questions are left out. */
export function questionClasses(scores: Iterable<AnswerScore>): Record<string, Record<string, { type: string; cls: QuestionClass }>> {
  const by = new Map<string, Map<string, { type?: string; arms: Map<string, number[]> }>>();
  for (const s of scores) {
    if (s.value === null || !Number.isFinite(s.value)) continue;
    const p = by.get(s.pack) ?? by.set(s.pack, new Map()).get(s.pack)!;
    const q = p.get(s.taskId) ?? p.set(s.taskId, { arms: new Map() }).get(s.taskId)!;
    q.type ??= s.taskType;
    (q.arms.get(s.arm) ?? q.arms.set(s.arm, []).get(s.arm)!).push(s.value);
  }
  const out: Record<string, Record<string, { type: string; cls: QuestionClass }>> = {};
  for (const [pack, qs] of by) {
    for (const [task, q] of qs) {
      const cls = questionClassOf([...q.arms.values()]);
      if (cls) (out[pack] ??= {})[task] = { type: q.type ?? 'untyped', cls };
    }
  }
  return out;
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
  /** headroom: each question's class in the records, per pack and task id (records with per-question scores only). */
  questions?: Record<string, Record<string, QuestionClass>>;
  /** headroom: per pack (`'*'`: one the records do not have) and type, the share of seen questions that were contested. */
  contested?: Record<string, Record<string, number>>;
  /** headroom: all-wrong questions a pack's sample may take (default 0: none, they are listed for audit). */
  suspects?: number;
  /** headroom: how never-seen questions are spread over types: by the records' spread (default) or evenly (plain stratified). */
  types?: 'spread' | 'even';
  /** headroom: questions reworded since the records answered them, whose classes were dropped (`--agent-headroom-stale`). */
  stale?: string[];
}

/** What `run.json` records of the agent sample: its limit, its allocation (null: round-robin) and what each pack took. */
export interface AgentSample {
  limit: number;
  /** At most this many update tasks per pack for agents; null: all of them. */
  updateLimit: number | null;
  allocation: AgentAllocation | null;
  /** Per pack and type: the tasks the pack had for agents, those taken, and the type's weight. */
  byPack: Record<string, Record<string, TypeTaken>>;
  /** Per pack with update tasks: how many it had, and how many agents answer. */
  updates: Record<string, { available: number; taken: number }>;
  /** Per pack, when the records saw its questions: what the sample is expected to hold (`sampleReportOf`). */
  questions?: Record<string, SampleReport>;
}

/** One type of a pack's agent sample: available, taken, its weight, and (headroom) the taken questions by what the records saw. */
export interface TypeTaken {
  available: number;
  taken: number;
  weight?: number;
  seen?: Partial<Record<QuestionClass | 'unseen', number>>;
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
export function headroomAllocation(
  evidence: Record<string, Record<string, TypeEvidence>>,
  opts: { floor?: number; from?: string[]; questions?: Record<string, Record<string, { type: string; cls: QuestionClass }>>; suspects?: number; types?: 'spread' | 'even'; stale?: string[] } = {},
): AgentAllocation {
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
  // plain stratified: every type the same weight, whatever the records saw
  const weights = opts.types === 'even' ? Object.fromEntries(Object.keys(byPack).map((p) => [p, { '*': 1 }])) : byPack;
  const q = opts.questions && Object.keys(opts.questions).length ? opts.questions : null;
  return {
    mode: 'headroom', floor: opts.floor ?? HEADROOM_FLOOR, ...(opts.from ? { from: opts.from } : {}),
    byPack: Object.fromEntries(Object.entries(weights).map(([p, w]) => [p, round6(w)])), evidence,
    ...(q
      ? {
          questions: Object.fromEntries(Object.entries(q).map(([p, ts]) => [p, Object.fromEntries(Object.entries(ts).map(([t, c]) => [t, c.cls]))])),
          contested: Object.fromEntries(Object.entries(contestedShares(q)).map(([p, r]) => [p, round6(r)])),
        }
      : {}),
    ...(opts.suspects ? { suspects: opts.suspects } : {}),
    ...(opts.types === 'even' ? { types: 'even' as const } : {}),
    ...(opts.stale?.length ? { stale: opts.stale } : {}),
  };
}

/**
 * Per pack and type, the share of the questions the records saw that were
 * contested, shrunk as the headroom weights are (a pack's own toward the
 * type's over every pack, worth `HEADROOM_PRIOR` questions, that toward ½);
 * `'*'` for a type or pack the records do not have. What the sample report
 * expects of a question never seen.
 */
export function contestedShares(questions: Record<string, Record<string, { type: string; cls: QuestionClass }>>): Record<string, Record<string, number>> {
  const count = (qs: Iterable<{ type: string; cls: QuestionClass }>) => {
    const m = new Map<string, { n: number; c: number }>();
    for (const q of qs) {
      const e = m.get(q.type) ?? m.set(q.type, { n: 0, c: 0 }).get(q.type)!;
      e.n++;
      if (q.cls === 'contested') e.c++;
    }
    return m;
  };
  const pooled = count(Object.values(questions).flatMap((ts) => Object.values(ts)));
  const all = [...pooled.values()].reduce((a, e) => ({ n: a.n + e.n, c: a.c + e.c }), { n: 0, c: 0 });
  const jeffreys = (e: { n: number; c: number }) => (e.c + 0.5) / (e.n + 1);
  const typeRate: Record<string, number> = Object.fromEntries([...pooled].map(([t, e]) => [t, jeffreys(e)]));
  const out: Record<string, Record<string, number>> = { '*': { ...typeRate, '*': jeffreys(all) } };
  for (const [pack, ts] of Object.entries(questions)) {
    const r: Record<string, number> = { ...typeRate, '*': jeffreys(all) };
    for (const [type, e] of count(Object.values(ts))) r[type] = (e.c + HEADROOM_PRIOR * typeRate[type]) / (e.n + HEADROOM_PRIOR);
    out[pack] = r;
  }
  return out;
}

/** Per type: the tasks a pack had for agents, those the sample took, and the type's weight or count under the shares. */
export function sampleByType(pool: Task[], taken: Task[], shares: TypeShares | null): AgentSample['byPack'][string] {
  const out: AgentSample['byPack'][string] = {};
  for (const t of pool) (out[t.type] ??= { available: 0, taken: 0, ...(shares ? { weight: shareOf(shares, t.type) } : {}), ...(shares?.classes ? { seen: {} } : {}) }).available++;
  for (const t of taken) {
    const e = out[t.type];
    if (!e) continue;
    e.taken++;
    if (e.seen) {
      const c = shares!.classes![t.id] ?? 'unseen';
      e.seen[c] = (e.seen[c] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * What a pack's agent sample holds by what the records saw of it, before
 * any model is called: per type the questions taken by class, the all-wrong
 * questions left out (for audit), and how many of the sample are expected to
 * be contested — those seen contested, and each never-seen question at its
 * type's contested share (`contestedShares`). A paired difference between
 * two arms can show only on contested questions; with C of them in n, whole
 * questions flipping, the smallest difference of the sample's mean a pair can
 * detect is about 2.8·√C / n (α 0.05, power 0.8), and one arm must win about
 * (1 + 2.8/√C) / 2 of the contests it is in.
 */
export interface SampleReport {
  /** Questions taken, and the questions the pack had for agents. */
  n: number;
  available: number;
  /** Taken questions by class (`unseen`: the records did not see them). */
  taken: Record<QuestionClass | 'unseen', number>;
  /** All-wrong questions of the pack the sample did not take, by task id. */
  suspects: string[];
  /** Expected contested questions in the sample; null when the records give no contested shares. */
  expected: number | null;
  /** Smallest detectable difference of the sample's mean at that many contested questions (whole questions flipping); null when there are none. */
  mde: number | null;
  /** Share of its contests one arm must win to show at that many. */
  mustWin: number | null;
  warning: string | null;
}

export function sampleReportOf(pool: Task[], taken: Task[], shares: TypeShares): SampleReport | null {
  if (!shares.classes) return null;
  const cls = (t: Task): QuestionClass | 'unseen' => shares.classes![t.id] ?? 'unseen';
  const count = { contested: 0, unseen: 0, right: 0, partial: 0, wrong: 0 };
  let expected: number | null = shares.contested ? 0 : null;
  for (const t of taken) {
    const c = cls(t);
    count[c]++;
    if (expected !== null && c === 'contested') expected++;
    else if (expected !== null && c === 'unseen') expected += shares.contested![t.type] ?? shares.contested!['*'] ?? 0;
  }
  const chosen = new Set(taken.map((t) => t.id));
  const suspects = pool.filter((t) => cls(t) === 'wrong' && !chosen.has(t.id)).map((t) => t.id).sort();
  const n = taken.length;
  const e = expected ?? count.contested;
  const mde = e > 0 && n ? (2.8 * Math.sqrt(e)) / n : null;
  const mustWin = e > 0 ? Math.min(1, (1 + 2.8 / Math.sqrt(e)) / 2) : null;
  const uninformative = count.right + count.partial + count.wrong;
  const warning = n && e < n / 2
    ? `mostly uninformative: about ${Math.round(e)} of ${n} questions are expected to be contested (${count.contested} seen contested${count.unseen ? `, ${count.unseen} never seen` : ''}${uninformative ? `, ${uninformative} seen agreed or all wrong` : ''}); a difference between two arms shows only on those, and ${mustWin === null ? 'with none it cannot show at all' : `then only if one arm wins ${Math.round(mustWin * 100)}% of the contests (about ${mde!.toFixed(3)} on the sample's mean)`}`
    : null;
  const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  return { n, available: pool.length, taken: count, suspects, expected: round3(expected), mde: round3(mde), mustWin: round3(mustWin), warning };
}

/** A sample report as the lines `eval run` prints before it starts: per type, then the totals, the suspects and the warning. */
export function formatSampleReport(pack: string, byType: AgentSample['byPack'][string], r: SampleReport): string[] {
  const part = (seen: TypeTaken['seen']) => SAMPLE_TIERS.filter((c) => seen?.[c]).map((c) => `${seen![c]} ${c === 'unseen' ? 'never seen' : c === 'contested' ? 'contested' : `all ${c}`}`).join(', ');
  const lines = [`[${pack}] agent sample by what the records saw: ${r.n} of ${r.available} — ${part(r.taken) || 'none'}${r.expected !== null ? `; about ${r.expected.toFixed(1)} expected contested` : ''}`];
  for (const [type, c] of Object.entries(byType).sort(([, a], [, b]) => b.taken - a.taken)) if (c.taken) lines.push(`  ${type} ${c.taken}/${c.available}: ${part(c.seen)}`);
  if (r.suspects.length) lines.push(`  ${r.suspects.length} all-wrong question(s) left out, to read against their passages (eval pack lint --answers lists them): ${r.suspects.slice(0, 12).join(', ')}${r.suspects.length > 12 ? ', …' : ''}`);
  if (r.warning) lines.push(`  warning: ${r.warning}`);
  return lines;
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
  const shares: TypeShares = { weights, floor: allocation.floor ?? (allocation.mode === 'headroom' ? HEADROOM_FLOOR : 0) };
  if (allocation.mode !== 'headroom' || !allocation.questions) return shares;
  // a pack the records never saw is drawn as all-unseen: the tiers change nothing but stay on, so its report says so
  const seen = names.find((n) => allocation.questions![n]);
  return {
    ...shares,
    classes: seen ? allocation.questions[seen] : {},
    suspects: allocation.suspects ?? 0,
    ...(allocation.contested ? { contested: allocation.contested[seen ?? ''] ?? allocation.contested['*'] } : {}),
  };
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
 * type of weight 0 gives nothing. `have`: what earlier tiers of the sample
 * already took of each type, which counts toward its floor.
 */
export function typeQuotas(available: Map<string, number>, limit: number, shares: TypeShares, have?: ReadonlyMap<string, number>): Map<string, number> {
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
      // a type an earlier tier already gave this many has its floor
      if ((have?.get(t) ?? 0) > r) continue;
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
  const spec = (a: AgentAllocation) => JSON.stringify({ mode: a.mode, weights: a.weights ?? null, counts: a.counts ?? null, floor: a.floor ?? null, from: a.from ?? null, suspects: a.suspects ?? 0, types: a.types ?? 'spread', stale: a.stale ?? [] });
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
  const how = [a.types === 'even' ? 'types even' : '', a.questions ? `by question${a.suspects ? `, up to ${a.suspects} all-wrong` : ''}` : ''].filter(Boolean).join(', ');
  return `headroom from ${(a.from ?? []).join(', ') || 'a previous run'}, floor ${a.floor ?? HEADROOM_FLOOR}${how ? `, ${how}` : ''}`;
}
