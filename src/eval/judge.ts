import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LlmClient } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { Meter } from './meter.js';
import { captureEither } from './placement.js';
import { QuotaGuard } from './quota.js';

/**
 * The judge (docs/design/23 §6): a model of another family than the one
 * every system answers with (Claude judging Codex), asked in batches of a few
 * items per call so a pilot fits a plan's quota. Items are anonymous — the
 * caller strips what identifies a system and mixes systems within a batch —
 * and every verdict is cached by what was asked, so a rerun never asks twice.
 *
 * Its calls run at most `width()` at once, across everything asked of it at
 * the same time (the three scorers of a pass run together): an evaluation run
 * gives the slots online that take the judge's calls (docs/design/32 §11), so
 * ten judge workers are ten calls wide; a judge with no width keeps two.
 */

export const JUDGE_SYSTEM = '__judge__';

export interface JudgeOptions {
  client: LlmClient;
  meter: Meter;
  quota?: QuotaGuard;
  cacheFile?: string;
  batchSize?: number;
  /** A fixed width: at most this many calls at once (default 2). */
  concurrency?: number;
  /** The width as it is now, read again as calls end and while some wait: the slots online that take the judge's calls. Wins over `concurrency`. */
  width?: () => number;
  /** How often the width is read again while calls wait (default 1 s). */
  widthCheckMs?: number;
}

/**
 * At most `width()` calls at once, across everything that goes through it.
 * The width is read again whenever a call ends, and on a timer while calls
 * wait: slots come online and go while a pass is under way.
 */
export class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly width: () => number, private readonly checkMs = 1_000) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((enter) => {
      this.waiting.push(enter);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private pump(): void {
    const width = Math.max(1, Math.trunc(Number(this.width()) || 0));
    while (this.waiting.length && this.active < width) {
      this.active++;
      this.waiting.shift()!();
    }
    if (this.waiting.length && !this.timer) {
      this.timer = setInterval(() => this.pump(), Math.max(10, this.checkMs));
      this.timer.unref?.();
    } else if (!this.waiting.length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

type Verdicts<T> = Map<string, T>;

/**
 * The judge audit (docs/design/33 §5): a seeded share of the verdicts of a
 * pass is asked again, in a call of its own with the items in another order,
 * and every second verdict is set beside the first. The first is the one
 * scored; the audit measures how far a verdict can be trusted.
 */
export interface JudgeAudit {
  /** Share of a pass's verdicts asked again (0 turns the audit off). */
  share: number;
  /** The run's seed: which verdicts are asked again, and in what order. */
  seed: string | number;
  /** At least this many of a pass's verdicts (default 20), or all of them when there are fewer. */
  min?: number;
  /** Every audited verdict, agreeing or not. */
  record: (r: JudgeAuditRecord) => void;
}

export interface JudgeAuditRecord {
  key: string;
  /** grade, list, match, coverage, support, link, same, contradict. */
  kind: string;
  /** The item's id (score/keys.ts judgeItemKey for an answer's grade, list or match). */
  id: string;
  /** What the judge was shown, as it was shown, long texts cut. */
  item: unknown;
  first: unknown;
  second: unknown;
  agree: boolean;
  at: string;
}

export const AUDIT_DEFAULT_SHARE = 0.05;
export const AUDIT_MIN_ITEMS = 20;

/** A stable fraction in [0, 1) from what is hashed. */
function fraction(...parts: unknown[]): number {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest().readUInt32BE(0) / 2 ** 32;
}

/**
 * The items of a pass that are judged a second time: each whose seeded hash
 * falls under `share` — so an item is picked whatever else the pass holds —
 * then, while fewer than `min` are, the next lowest hashes.
 */
export function auditSample<I>(items: I[], share: number, min: number, seed: string | number, keyOf: (item: I) => string): I[] {
  if (!(share > 0) || !items.length) return [];
  const ranked = items.map((item) => ({ item, h: fraction('audit', seed, keyOf(item)) })).sort((a, b) => a.h - b.h);
  const under = ranked.filter((r) => r.h < share).length;
  return ranked.slice(0, Math.min(items.length, Math.max(under, min))).map((r) => r.item);
}

/**
 * A list verdict's pairs as the one-to-one matching scoring makes of them (score/lists.ts canonicalPairs, kept
 * here so the judge does not import the scorer): in range, by predicted then gold index, each entry once.
 */
export function canonicalListPairs(raw: unknown, predicted: number, gold: number): [number, number][] {
  const list = (Array.isArray(raw) ? raw : []).filter((p): p is [number, number] => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= 0 && p[0] < predicted && p[1] >= 0 && p[1] < gold);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const out: [number, number][] = [];
  for (const [p, g] of [...list].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (usedP.has(p) || usedG.has(g)) continue;
    usedP.add(p);
    usedG.add(g);
    out.push([p, g]);
  }
  return out;
}

/** A long text in an audit record, cut. */
const cut = (v: unknown): unknown => (typeof v === 'string' ? (v.length > 800 ? `${v.slice(0, 800)}…` : v) : Array.isArray(v) ? v.slice(0, 20).map(cut) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)])) : v);

/**
 * A reply that did not parse (cut off at its token budget, prose around it):
 * asked again in halves. A stuck or cancelled piece is no reply at all,
 * whatever its message says, and any other error is the call's failure.
 */
function unparsable(err: unknown): boolean {
  if ((err as { final?: boolean } | null)?.final) return false;
  return err instanceof SyntaxError || /json/i.test(err instanceof Error ? err.message : String(err));
}

export class Judge {
  private readonly cache = new Map<string, unknown>();
  private readonly batchSize: number;
  /** One gate for every call of this judge, whichever `batch()` asked for it. */
  private readonly gate: Gate;

  constructor(private readonly opts: JudgeOptions) {
    this.batchSize = opts.batchSize ?? 8;
    this.gate = new Gate(opts.width ?? (() => opts.concurrency ?? 2), opts.widthCheckMs);
    if (opts.cacheFile && fs.existsSync(opts.cacheFile)) {
      for (const line of fs.readFileSync(opts.cacheFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { k: string; v: unknown };
          this.cache.set(r.k, r.v);
        } catch {
          /* torn line */
        }
      }
    }
    if (opts.cacheFile) fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
  }

  get label(): string {
    return this.opts.client.label;
  }

  private auditing: JudgeAudit | null = null;

  /** Turn the audit on (a share above 0) or off for every pass after this. */
  audit(audit: JudgeAudit | null): this {
    this.auditing = audit && audit.share > 0 ? audit : null;
    return this;
  }

  /**
   * `batch`, then the audit: a sample of the items it gave a verdict is asked
   * again under the kind `<kind>:audit` — its own cache key and meter stage,
   * so the second verdict is never the first one replayed — in a seeded order
   * of its own and under ids of its own, so no request repeats the first.
   */
  private async audited<I extends { id: string }, V>(
    kind: string, system: string, items: I[], render: (item: I) => unknown, verdicts: Verdicts<V>, view: (v: V, item: I) => unknown, size = this.batchSize,
  ): Promise<Verdicts<V>> {
    const a = this.auditing;
    if (!a) return verdicts;
    const judged = items.filter((i) => verdicts.has(i.id));
    const content = (i: I) => JSON.stringify([kind, system, render(i)]);
    const sample = auditSample(judged, a.share, a.min ?? AUDIT_MIN_ITEMS, a.seed, content);
    if (!sample.length) return verdicts;
    const order = [...sample].sort((x, y) => fraction('audit-order', a.seed, content(x)) - fraction('audit-order', a.seed, content(y)));
    const again = await this.batch<I, V>(`${kind}:audit`, system, order.map((i) => ({ ...i, id: `${i.id}~audit` })), render, size);
    const at = new Date().toISOString();
    for (const item of sample) {
      const second = again.get(`${item.id}~audit`);
      if (second === undefined) continue;
      const first = verdicts.get(item.id)!;
      a.record({
        key: crypto.createHash('sha1').update(JSON.stringify(['judge-audit', content(item)])).digest('hex').slice(0, 20),
        kind, id: item.id, item: cut(render(item)), first, second, agree: JSON.stringify(view(first, item)) === JSON.stringify(view(second, item)), at,
      });
    }
    return verdicts;
  }

  private remember(k: string, v: unknown): void {
    this.cache.set(k, v);
    if (this.opts.cacheFile) fs.appendFileSync(this.opts.cacheFile, JSON.stringify({ k, v }) + '\n');
  }

  /**
   * Ask `system` about `items` a batch at a time; `render` gives each item's
   * block, the model answers {"verdicts":[{"id":…, …}]}. Items already judged
   * come from the cache; an item the model left out comes back undefined.
   */
  async batch<I extends { id: string }, V>(kind: string, system: string, items: I[], render: (item: I) => unknown, size = this.batchSize): Promise<Verdicts<V>> {
    const out: Verdicts<V> = new Map();
    const keyOf = (item: I) => crypto.createHash('sha256').update(JSON.stringify([kind, system, render(item)])).digest('hex');
    const todo: I[] = [];
    for (const item of items) {
      const hit = this.cache.get(keyOf(item));
      if (hit !== undefined) out.set(item.id, hit as V);
      else todo.push(item);
    }
    const batches: I[][] = [];
    for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
    // a reply that does not parse (cut off at its token budget, prose around it) is asked again in halves, down to
    // one item, which is tried twice and then left unjudged: one bad reply must not stop a pack
    // the first call of this batch that failed: no call of it starts after that, and it is what the batch throws
    let failed = false;
    const ask = async (group: I[], tries = 1): Promise<void> => {
      const user = JSON.stringify({ items: group.map((item) => ({ id: item.id, ...(render(item) as object) })) }, null, 1);
      let usage: CallUsage | null = null;
      let t0 = Date.now();
      const call = () => this.opts.client.completeJson<{ verdicts?: (V & { id?: string })[] }>(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { maxTokens: 900 * group.length + 600, onUsage: (u) => (usage = u) },
      );
      let reply: { verdicts?: (V & { id?: string })[] };
      // a plan's limit can last hours: wait it out (6 h at the guard's 5-minute poll) rather than lose the batch;
      // who answered (a remote worker, src/eval/remote.ts) is noted on the way and kept with the meter event.
      // The gate is held for the call alone, never across the halves a bad reply is asked again in
      const r = await this.gate.run(async () => {
        if (failed) return null;
        t0 = Date.now();
        const got = await captureEither(() => (this.opts.quota ? this.opts.quota.retryRefused(call, 72) : call()));
        // said before the gate lets the next call in: one that waited behind a failure never starts
        if (got.error !== undefined && !unparsable(got.error)) failed = true;
        return got;
      });
      if (!r) return;
      const placed = r.placements.at(-1);
      const where = { ...(placed?.worker ? { worker: placed.worker } : {}), ...(placed?.pool ? { pool: placed.pool } : {}), backend: placed?.backend ?? this.opts.client.label };
      try {
        if ('error' in r && r.error !== undefined) throw r.error;
        reply = r.value!;
        this.opts.meter.record({ system: JUDGE_SYSTEM, stage: kind, model: this.opts.client.model || this.opts.client.label, ms: Date.now() - t0, ok: true, replayed: false, usage, ...where });
      } catch (err) {
        this.opts.meter.record({ system: JUDGE_SYSTEM, stage: kind, model: this.opts.client.model || this.opts.client.label, ms: Date.now() - t0, ok: false, replayed: false, usage, ...where });
        if (!unparsable(err)) throw err;
        if (group.length > 1) {
          const half = Math.ceil(group.length / 2);
          await ask(group.slice(0, half));
          await ask(group.slice(half));
        } else if (tries < 2) {
          await ask(group, tries + 1);
        }
        return;
      }
      const byId = new Map((reply.verdicts ?? []).filter((v) => v && typeof v.id === 'string').map((v) => [v.id as string, v]));
      for (const item of group) {
        const v = byId.get(item.id);
        if (v === undefined) continue;
        this.remember(keyOf(item), v);
        out.set(item.id, v as V);
      }
    };
    // every batch is asked for at once; the gate lets as many calls through as the judge is wide
    await Promise.all(batches.map((group) => ask(group)));
    return out;
  }

  /* --------------------------------- grading -------------------------------- */

  async gradeAnswers(items: GradeItem[]): Promise<Verdicts<GradeVerdict>> {
    const render = (i: GradeItem) => ({
      question: i.question,
      ...(i.expectAbstain ? { expectAbstain: true } : { reference: i.reference }),
      ...(i.keypoints?.length ? { keypoints: i.keypoints.map((k, n) => `${n}: ${k}`) } : {}),
      answer: i.answer.slice(0, 6000),
    });
    const clamp = (raw: Verdicts<GradeVerdict>) => {
      for (const [id, v] of raw) raw.set(id, { ...v, score: clampScore(v.score), keypoints: Array.isArray(v.keypoints) ? v.keypoints.map(Number).filter(Number.isInteger) : [] });
      return raw;
    };
    const raw = clamp(await this.batch<GradeItem, GradeVerdict>('grade', GRADE_SYSTEM, items, render));
    // two grades agree on the score; the second is clamped as the first was
    await this.audited('grade', GRADE_SYSTEM, items, render, raw, (v) => clampScore(v.score));
    return raw;
  }

  async factPresent(items: { id: string; fact: string; units: string[] }[]): Promise<Verdicts<{ present: boolean; unit?: number }>> {
    const render = (i: (typeof items)[number]) => ({ fact: i.fact, knowledge: i.units.map((u, n) => `[${n}] ${u.slice(0, 1200)}`) });
    return this.audited('coverage', COVERAGE_SYSTEM, items, render, await this.batch<(typeof items)[number], { present: boolean; unit?: number }>('coverage', COVERAGE_SYSTEM, items, render), (v) => Boolean(v.present));
  }

  async claimSupport(items: { id: string; claim: string; sources: string[] }[]): Promise<Verdicts<{ verdict: SupportVerdict }>> {
    const render = (i: (typeof items)[number]) => ({ claim: i.claim, sources: i.sources.map((s, n) => `[${n}] ${s.slice(0, 1500)}`) });
    return this.audited('support', SUPPORT_SYSTEM, items, render, await this.batch<(typeof items)[number], { verdict: SupportVerdict }>('support', SUPPORT_SYSTEM, items, render), (v) => v.verdict);
  }

  async decompose(items: { id: string; text: string }[]): Promise<Verdicts<{ claims: string[] }>> {
    return this.batch('decompose', DECOMPOSE_SYSTEM, items, (i) => ({ text: i.text.slice(0, 4000) }));
  }

  /** Themes and needs (emergence probes): one list per call and compared as matchings, as `matchList` is. */
  async matchItems(items: { id: string; predicted: string[]; gold: string[] }[]): Promise<Verdicts<{ pairs: [number, number][] }>> {
    const render = (i: (typeof items)[number]) => ({
      predicted: i.predicted.map((p, n) => `${n}: ${p}`),
      gold: i.gold.map((g, n) => `${n}: ${g}`),
    });
    const view = (v: { pairs?: unknown }, i: (typeof items)[number]) => canonicalListPairs(v?.pairs, i.predicted.length, i.gold.length);
    return this.audited('match', MATCH_SYSTEM, items, render, await this.batch<(typeof items)[number], { pairs: [number, number][] }>('match', MATCH_SYSTEM, items, render, 1), view, 1);
  }

  /**
   * Corpus-level lists (aggregate, timeline, contradiction, profile): a stricter match than themes — same name,
   * number and date. One list per call: a list's verdict depends on that list alone, not on the answers it
   * happened to share a batch with, so asking it again asks the same question. The audit compares the
   * one-to-one matchings the two replies come to (`canonicalListPairs`), not the order they were written in.
   */
  async matchList(items: { id: string; predicted: string[]; gold: string[] }[]): Promise<Verdicts<{ pairs: [number, number][] }>> {
    const render = (i: (typeof items)[number]) => ({
      predicted: i.predicted.map((p, n) => `${n}: ${p.slice(0, 400)}`),
      gold: i.gold.map((g, n) => `${n}: ${g.slice(0, 400)}`),
    });
    const view = (v: { pairs?: unknown }, i: (typeof items)[number]) => canonicalListPairs(v?.pairs, i.predicted.length, i.gold.length);
    return this.audited('list', LIST_MATCH_SYSTEM, items, render, await this.batch<(typeof items)[number], { pairs: [number, number][] }>('list', LIST_MATCH_SYSTEM, items, render, 1), view, 1);
  }

  async linkCorrect(items: { id: string; head: string; relation: string; tail: string; sources: string[] }[]): Promise<Verdicts<{ correct: boolean }>> {
    const render = (i: (typeof items)[number]) => ({ link: `${i.head} —${i.relation}→ ${i.tail}`, sources: i.sources.map((s, n) => `[${n}] ${s.slice(0, 1200)}`) });
    return this.audited('link', LINK_SYSTEM, items, render, await this.batch<(typeof items)[number], { correct: boolean }>('link', LINK_SYSTEM, items, render), (v) => Boolean(v.correct));
  }

  async samePair(items: { id: string; a: string; b: string }[]): Promise<Verdicts<{ same: boolean }>> {
    const render = (i: (typeof items)[number]) => ({ a: i.a.slice(0, 600), b: i.b.slice(0, 600) });
    return this.audited('same', SAME_SYSTEM, items, render, await this.batch<(typeof items)[number], { same: boolean }>('same', SAME_SYSTEM, items, render), (v) => Boolean(v.same));
  }

  async contradicts(items: { id: string; a: string; b: string }[]): Promise<Verdicts<{ contradict: boolean }>> {
    const render = (i: (typeof items)[number]) => ({ a: i.a.slice(0, 800), b: i.b.slice(0, 800) });
    return this.audited('contradict', CONTRADICT_SYSTEM, items, render, await this.batch<(typeof items)[number], { contradict: boolean }>('contradict', CONTRADICT_SYSTEM, items, render), (v) => Boolean(v.contradict));
  }
}

export interface GradeItem {
  id: string;
  question: string;
  reference?: string;
  keypoints?: string[];
  answer: string;
  expectAbstain?: boolean;
}

export interface GradeVerdict {
  score: 0 | 1 | 2;
  keypoints: number[];
  abstained: boolean;
  hallucinated: boolean;
  reason?: string;
}

export type SupportVerdict = 'supported' | 'inference' | 'unsupported' | 'contradicted';

function clampScore(v: unknown): 0 | 1 | 2 {
  const n = Math.round(Number(v));
  return n >= 2 ? 2 : n === 1 ? 1 : 0;
}

const JSON_SHAPE = (fields: string) => `Answer with one JSON object: {"verdicts":[{"id":"<item id>", ${fields}}, …]} — one verdict per item, in any order.`;

export const GRADE_SYSTEM = `You grade answers to questions about a private document collection. Items are independent and come from different systems in random order; judge only content, never length, style, citation format or language (answers and references may be Chinese or English).

For an item with a reference answer:
- score 2: states the reference's key information with no material error
- score 1: partly right — some key information, or a minor error or omission
- score 0: wrong, off-topic, or declines although the reference shows the question is answerable
For an item with "expectAbstain": true the sources do not contain the answer:
- score 2: clearly says the information is not available (a guess clearly labelled as one is fine)
- score 0: asserts an answer as fact
"keypoints": the indices of listed key points the answer states correctly.
"abstained": true when the answer declines or says the sources do not tell.
"hallucinated": true when it asserts something false or contradicting the reference.
${JSON_SHAPE('"score":0|1|2, "keypoints":[int], "abstained":bool, "hallucinated":bool, "reason":"≤15 words"')}`;

export const COVERAGE_SYSTEM = `For each item, decide whether the knowledge snippets state the given fact — explicitly or as a direct paraphrase or implication a reader would accept. Partial matches that lose the fact's key detail (a number, a date, who did it) do not count.
${JSON_SHAPE('"present":bool, "unit":<index of the snippet that states it, or -1>')}`;

export const SUPPORT_SYSTEM = `For each item, decide how the source passages bear on the claim:
- "supported": a passage states it (paraphrase is fine)
- "inference": no passage states it, but it follows from combining the passages
- "unsupported": the passages neither state nor imply it
- "contradicted": a passage says otherwise
${JSON_SHAPE('"verdict":"supported"|"inference"|"unsupported"|"contradicted"')}`;

export const DECOMPOSE_SYSTEM = `Split each text into atomic claims: one checkable assertion each, self-contained (resolve pronouns, keep dates and numbers), in the text's own language. Skip headings, navigation and link markup. At most 12 claims per text.
${JSON_SHAPE('"claims":["…"]')}`;

export const MATCH_SYSTEM = `Each item has predicted entries and gold entries. Pair a predicted entry with a gold entry when it expresses the same theme, need or item (wording and language may differ; a broader or vaguer entry does not match a specific gold one). Each entry is used at most once.
${JSON_SHAPE('"pairs":[[<predicted index>,<gold index>], …]')}`;

export const LIST_MATCH_SYSTEM = `Each item has the list an answer gave and the gold list (one entry per line; gold entries may give alternative names after " / " and a date in parentheses). Pair a predicted entry with a gold entry when they state the same thing: the same listed thing, fact, event, change of state or side of a disagreement. Wording and language may differ. Do not pair when the predicted entry names a different person, figure or date, when it is broader or vaguer than the gold entry, or when it merges several gold entries into one (pair it with at most one of them). Each entry is used at most once.
${JSON_SHAPE('"pairs":[[<predicted index>,<gold index>], …]')}`;

export const LINK_SYSTEM = `Each item is a link a knowledge base drew between two things, with the source passages. Decide whether the sources support that relation between them (the relation label may be loose; the connection must be real and of that kind).
${JSON_SHAPE('"correct":bool')}`;

export const SAME_SYSTEM = `Each item has two entries from a knowledge base. Decide whether they describe the same real-world entity (same person, company, product, place, concept) under different names or spellings.
${JSON_SHAPE('"same":bool')}`;

export const CONTRADICT_SYSTEM = `Each item has two statements from one knowledge base. Decide whether they contradict each other (both cannot be true at the same time; statements about different dates do not contradict).
${JSON_SHAPE('"contradict":bool')}`;
