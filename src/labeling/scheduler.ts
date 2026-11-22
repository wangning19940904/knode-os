import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { RawExtractReply } from '../graph/llm-extract.js';
import { loadOntology, Ontology } from '../graph/ontology.js';
import {
  checkExtractReply,
  DocPlan,
  finishPlan,
  pendingOf,
  persistPlan,
  planQueuedDocument,
  queuedDocuments,
  recordPlanProgress,
  recordSegmentOutcome,
  refreshQueuePriorities,
  segmentExtractRequest,
  settled,
} from '../graph/tier1.js';
import { ChatMessage, jsonFromReply } from '../llm/client.js';
import { renderCliPrompt } from '../llm/cli.js';
import type { CallUsage } from '../llm/usage.js';
import { Store } from '../store/db.js';
import { claimDocument, heldDocuments, releaseDocument } from './claims.js';
import { classifyFailure, FailureKind } from './failures.js';

/**
 * The labeling scheduler — tier-1 extraction as leased work.
 *
 * One per workspace in `serve`. It takes documents off the extraction queue
 * (holding them in the in-process registry the batch pass also respects),
 * plans their segments, and hands segments out one at a time as leases: the
 * prompt to run, and how long the worker may take. Whoever holds a lease —
 * one of `serve`'s own worker slots (src/labeling/local.ts) or a worker on
 * another machine through the remote API (src/remote) — runs the call on its
 * own model and returns the raw reply. The reply is checked here, recorded in
 * the document's sidecar after every call, and once a document's last segment
 * is in, the document is written to the graph exactly as the batch pass would.
 *
 * Nothing waits for a slow call: every slot takes the next segment as soon as
 * it is free, a long document's later segments go to several workers at once,
 * and a lease that lapses (a worker that died) puts its segment back in line.
 * A failure costs the segment an attempt only when the answer itself was bad
 * (src/labeling/failures.ts); a rate limit or a dropped connection does not.
 */

export interface LabelingTask {
  id: string;
  kind: 'extract';
  /** The document and part, for a worker's log. */
  label: string;
  document: { path: string; title: string; part: number; parts: number };
  messages: ChatMessage[];
  /** The same messages flattened the way a one-shot CLI takes them, JSON directive included. */
  prompt: string;
  /** The answer is a JSON object. */
  json: true;
  maxTokens: number;
  leaseExpiresAt: string;
}

export interface WorkerIdentity {
  /** Unique per slot: who holds a lease. */
  worker: string;
  /** What runs the call: codex, cursor, claude, api, or a route id. */
  backend: string;
  remote: boolean;
  /**
   * An evaluation run's own slot (docs/design/32 §3): it takes only that
   * run's pieces, since it runs them with the run's own backends.
   */
  run?: string;
  /**
   * The pool the slot's worker declared (`knode-worker --pool`, default its
   * token's name; a run's own slots: `local` or the run's `--pool`). A task
   * that names a pool goes only to a slot of it (docs/design/32 §2).
   */
  pool?: string;
}

/**
 * `usage` is what the provider said the call used, when it said (src/llm/usage.ts).
 * An embed task answers with `vectors` (one per input, raw as the endpoint made
 * them) and an empty `text`; `http` is what an embedding endpoint answered
 * when it refused (src/work/embed.ts).
 */
/** What a worker hands back for a research session (docs/design/27): the CLI's raw output, parsed on the server. */
export interface SessionAnswer {
  exitCode: number;
  /** stdout since the last renewal (the rest is in the transcript already). */
  output: string;
  /** The end of stderr. */
  stderr: string;
  /** Codex's --output-last-message, when it wrote one. */
  lastMessage: string | null;
  /** An evaluation session (src/work/eval.ts): the worker stopped it at its step cap. */
  capped?: boolean;
  /** An evaluation session's closing turn after its cap, as the worker ran it. */
  closing?: 'answered' | 'no-answer' | 'used-a-tool' | 'not-run';
  /** An evaluation session: the folder it ran in and the worker's home, for the leak audit (src/eval/agent.ts). */
  cwd?: string;
  home?: string;
}

export type TaskOutcome =
  | { ok: true; text: string; model?: string; usage?: CallUsage; vectors?: number[][]; endpointModel?: string; session?: SessionAnswer }
  | { ok: false; error: string; kind?: FailureKind; model?: string; usage?: CallUsage; http?: { status: number; retryAfterMs?: number } };

export interface CompleteResult {
  accepted: boolean;
  reason?: string;
  /** The answer was the document's last segment and the document is now in the graph. */
  documentWritten?: boolean;
  /** An embed batch of backlog chunks: how many of its vectors were written (src/work/embed.ts). */
  vectorsWritten?: number;
}

export interface SchedulerOptions {
  /** How long a worker may hold a segment before it goes back in line (renewable). */
  leaseMs?: number;
  /** Documents opened in one go when nothing open is ready. */
  openPerRound?: number;
  priorityRefreshMs?: number;
  /** Wait before a segment goes out again after a bad answer (× its attempts so far). */
  modelRetryMs?: number;
  /** Wait before a segment goes out again after a transient failure. */
  transientRetryMs?: number;
}

/** What the post-processing after extraction needs: what was written since it last asked. */
export interface FinishedBatch {
  documents: string[];
  entityIds: string[];
  claimIds: string[];
  written: number;
  failed: number;
}

/**
 * Paths and ids kept for the next review, per list; past this the oldest go
 * first. The reviews take them only while processing is started
 * (src/labeling/followup.ts), and remote workers write while it is stopped:
 * finance kept every claim id written since the start, 35k in two hours on
 * 2026-11-02, and would have until the next restart.
 */
export const FINISHED_KEEP = 100_000;

interface Finished {
  documents: Set<string>;
  entityIds: Set<string>;
  claimIds: Set<string>;
  written: number;
  failed: number;
}

const noneFinished = (): Finished => ({ documents: new Set(), entityIds: new Set(), claimIds: new Set(), written: 0, failed: 0 });

/** Add `items` as the newest of `kept` (an entity named by many documents is kept once), dropping the oldest past FINISHED_KEEP. */
export function keepNewest(kept: Set<string>, items: Iterable<string>): void {
  for (const item of items) {
    kept.delete(item);
    kept.add(item);
  }
  while (kept.size > FINISHED_KEEP) kept.delete(kept.values().next().value!);
}

export interface LabelingStatus {
  queued: number;
  openDocuments: number;
  readySegments: number;
  leases: { id: string; worker: string; backend: string; remote: boolean; document: string; part: number; parts: number; ageSeconds: number; expiresInSeconds: number }[];
  workers: { worker: string; backend: string; remote: boolean; lastSeen: string; leased: number; ok: number; failed: number }[];
  totals: { calls: number; ok: number; failed: Record<FailureKind, number>; leasesExpired: number; documentsWritten: number; documentsFailed: number; replayed: number; stale: number };
  lastHour: { calls: number; documentsWritten: number };
}

interface Lease {
  id: string;
  docId: string;
  index: number;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  request: { withClaims: boolean; askSubject: boolean };
  /** Kept a while after expiry so a late answer can still land when nobody else took the segment. */
  expired: boolean;
}

interface OpenDoc {
  plan: DocPlan;
  ready: Set<number>;
  /** Segment → lease id. */
  leased: Map<number, string>;
  /** Segment → earliest time it may go out again after a failure. */
  notBefore: Map<number, number>;
  /** Segment → transient failures and lapsed leases since its last counted attempt. */
  strikes: Map<number, number>;
}

interface WorkerRecord {
  backend: string;
  remote: boolean;
  lastSeen: number;
  ok: number;
  failed: number;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
/** Transient failures (or lapsed leases) of one segment that count as one real attempt. */
const STRIKE_LIMIT = 5;
const MODEL_RETRY_MS = 30_000;
const TRANSIENT_RETRY_MS = 15_000;
const EXPIRED_GRACE_MS = 10 * 60_000;
/** Rounds of opening documents one lease call may spend before it answers "nothing yet". */
const OPEN_ROUNDS = 3;
const ONTOLOGY_TTL_MS = 5 * 60_000;

export interface SchedulerContext {
  dataDir: string;
  store: Store;
  /** Read on every use: a settings save swaps the config. */
  config: () => KnodeConfig;
  log?: (msg: string) => void;
  /** A document's extraction was written to the graph: its summary page is due (src/work/summarize.ts). */
  onWritten?: (path: string) => void;
}

export class LabelingScheduler {
  /** The kind of work it hands out (src/work/broker.ts). */
  readonly kind = 'extract' as const;
  private readonly owner = `labeling:${crypto.randomUUID()}`;
  private readonly open = new Map<string, OpenDoc>();
  private readonly leases = new Map<string, Lease>();
  private readonly workers = new Map<string, WorkerRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private applyChain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private priorityRefreshedAt = 0;
  private ontology: { at: number; value: Ontology } | null = null;
  private finished = noneFinished();
  private readonly totals: LabelingStatus['totals'] = {
    calls: 0, ok: 0, failed: { model: 0, transient: 0, fatal: 0 }, leasesExpired: 0, documentsWritten: 0, documentsFailed: 0, replayed: 0, stale: 0,
  };
  private readonly recentCalls: number[] = [];
  private readonly recentDocs: number[] = [];
  private readonly leaseMs: number;
  private readonly openPerRound: number;
  private readonly priorityRefreshMs: number;
  private readonly modelRetryMs: number;
  private readonly transientRetryMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly ctx: SchedulerContext, opts: SchedulerOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.openPerRound = Math.max(1, opts.openPerRound ?? 4);
    this.priorityRefreshMs = opts.priorityRefreshMs ?? 5 * 60_000;
    this.modelRetryMs = opts.modelRetryMs ?? MODEL_RETRY_MS;
    this.transientRetryMs = opts.transientRetryMs ?? TRANSIENT_RETRY_MS;
    this.log = ctx.log ?? (() => {});
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  /** Whether a task id is one of this scheduler's leases, live or lately expired. */
  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** Up to `max` segments for `who` to run now; empty when nothing is due. */
  async lease(who: WorkerIdentity, max = 1): Promise<LabelingTask[]> {
    if (this.stopped) return [];
    this.seen(who);
    const want = Math.max(1, Math.min(8, Math.floor(max)));
    return this.locked(async () => {
      this.expireLeases();
      await this.refreshPriorities();
      const out: LabelingTask[] = [];
      let rounds = 0;
      while (out.length < want && !this.stopped) {
        const pick = this.nextReady();
        if (pick) {
          out.push(await this.issue(pick.doc, pick.index, who));
          continue;
        }
        if (rounds++ >= OPEN_ROUNDS || !(await this.openMore())) break;
      }
      return out;
    });
  }

  /** Hand back a call's outcome. A lapsed lease is still accepted while nobody else has the segment. */
  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult> {
    this.seen(who);
    const step = await this.locked(async (): Promise<CompleteResult & { finish?: OpenDoc }> => {
      const lease = this.leases.get(taskId);
      if (!lease) return { accepted: false, reason: 'unknown or long-expired lease' };
      if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
      const doc = this.open.get(lease.docId);
      const holder = doc?.leased.get(lease.index);
      if (!doc || (lease.expired ? holder !== undefined || settled(doc.plan.results[lease.index]) : holder !== lease.id)) {
        this.leases.delete(taskId);
        return { accepted: false, reason: lease.expired ? 'lease expired and the segment moved on' : 'segment no longer leased to this worker' };
      }
      this.leases.delete(taskId);
      doc.leased.delete(lease.index);
      await this.record(who, doc, lease, outcome);
      if (!settled(doc.plan.results[lease.index]) && !doc.leased.has(lease.index)) doc.ready.add(lease.index);
      if (lease.index === 0 && doc.plan.segments.length > 1 && settled(doc.plan.results[0])) {
        for (const i of pendingOf(doc.plan)) if (!doc.leased.has(i)) doc.ready.add(i);
      }
      if (pendingOf(doc.plan).length === 0 && doc.leased.size === 0) {
        this.open.delete(lease.docId);
        return { accepted: true, finish: doc };
      }
      await recordPlanProgress(this.ctx.store, doc.plan).catch(() => {});
      return { accepted: true };
    });
    if (step.finish) return { accepted: true, documentWritten: await this.finish(step.finish) };
    return { accepted: step.accepted, reason: step.reason };
  }

  /** Extend `who`'s leases; returns the ones it still holds. */
  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.expired && lease.who.worker === who.worker) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else {
        lost.push(id);
      }
    }
    if (renewed.length) this.seen(who);
    return { renewed, lost };
  }

  /** Give leases back unanswered (a worker shutting down): the segments go straight back in line. */
  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    return this.locked(async () => {
      let n = 0;
      for (const id of taskIds) {
        const lease = this.leases.get(id);
        if (!lease || lease.who.worker !== who.worker) continue;
        this.leases.delete(id);
        const doc = this.open.get(lease.docId);
        if (doc?.leased.get(lease.index) === id) {
          doc.leased.delete(lease.index);
          if (!settled(doc.plan.results[lease.index])) doc.ready.add(lease.index);
        }
        n++;
      }
      return n;
    });
  }

  /** What was written (or given up on) since the last call — the duplicate review's and the summaries' input. */
  takeFinished(): FinishedBatch {
    const { documents, entityIds, claimIds, written, failed } = this.finished;
    this.finished = noneFinished();
    return { documents: [...documents], entityIds: [...entityIds], claimIds: [...claimIds], written, failed };
  }

  async status(): Promise<LabelingStatus> {
    const now = Date.now();
    this.trim(now);
    const [row] = await this.ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue`);
    const leased = new Map<string, number>();
    for (const l of this.leases.values()) if (!l.expired) leased.set(l.who.worker, (leased.get(l.who.worker) ?? 0) + 1);
    let ready = 0;
    for (const d of this.open.values()) ready += d.ready.size;
    return {
      queued: row?.n ?? 0,
      openDocuments: this.open.size,
      readySegments: ready,
      leases: [...this.leases.values()].filter((l) => !l.expired).map((l) => {
        const doc = this.open.get(l.docId);
        return {
          id: l.id, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote,
          document: doc?.plan.row.path ?? '?', part: l.index + 1, parts: doc?.plan.segments.length ?? 1,
          ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
        };
      }),
      workers: [...this.workers.entries()].map(([worker, w]) => ({
        worker, backend: w.backend, remote: w.remote, lastSeen: new Date(w.lastSeen).toISOString(), leased: leased.get(worker) ?? 0, ok: w.ok, failed: w.failed,
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
      lastHour: { calls: this.recentCalls.length, documentsWritten: this.recentDocs.length },
    };
  }

  /** Stop leasing, wait for writes in flight, and give every held document back to the queue. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.locked(async () => {});
    await this.applyChain;
    for (const doc of this.open.values()) releaseDocument(this.ctx.dataDir, doc.plan.row.document_id, this.owner);
    this.open.clear();
    this.leases.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private seen(who: WorkerIdentity): void {
    const w = this.workers.get(who.worker) ?? { backend: who.backend, remote: who.remote, lastSeen: 0, ok: 0, failed: 0 };
    w.backend = who.backend;
    w.lastSeen = Date.now();
    this.workers.set(who.worker, w);
  }

  private trim(now: number): void {
    const hourAgo = now - 3_600_000;
    while (this.recentCalls.length && this.recentCalls[0] < hourAgo) this.recentCalls.shift();
    while (this.recentDocs.length && this.recentDocs[0] < hourAgo) this.recentDocs.shift();
  }

  private ontologyNow(): Ontology {
    const now = Date.now();
    if (!this.ontology || now - this.ontology.at > ONTOLOGY_TTL_MS) {
      this.ontology = { at: now, value: loadOntology(this.ctx.dataDir, this.ctx.config().graph?.ontologyPacks) };
    }
    return this.ontology.value;
  }

  private async refreshPriorities(): Promise<void> {
    const now = Date.now();
    if (now - this.priorityRefreshedAt < this.priorityRefreshMs) return;
    this.priorityRefreshedAt = now;
    try {
      await refreshQueuePriorities(this.ctx.store, this.ctx.config());
    } catch (err) {
      this.log(`labeling: refreshing queue priorities failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private nextReady(): { doc: OpenDoc; index: number } | null {
    const now = Date.now();
    for (const doc of this.open.values()) {
      for (const index of [...doc.ready].sort((a, b) => a - b)) {
        if ((doc.notBefore.get(index) ?? 0) <= now) return { doc, index };
      }
    }
    return null;
  }

  /** Open the next queued documents; false once the queue has nothing this scheduler may take. */
  private async openMore(): Promise<boolean> {
    const config = this.ctx.config();
    const rows = await queuedDocuments(this.ctx.store, { exclude: heldDocuments(this.ctx.dataDir), limit: this.openPerRound });
    if (rows.length === 0) return false;
    for (const row of rows) {
      if (!claimDocument(this.ctx.dataDir, row.document_id, this.owner)) continue;
      let planned: Awaited<ReturnType<typeof planQueuedDocument>>;
      try {
        planned = await planQueuedDocument(this.ctx.store, config, row, { onProgress: this.log });
      } catch (err) {
        releaseDocument(this.ctx.dataDir, row.document_id, this.owner);
        this.log(`labeling: could not open ${row.path}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (planned.kind !== 'plan') {
        if (planned.kind === 'replayed') {
          this.totals.replayed++;
          this.noteWritten(row.path, planned.applied);
        } else if (planned.kind === 'stale') {
          this.totals.stale++;
        }
        releaseDocument(this.ctx.dataDir, row.document_id, this.owner);
        continue;
      }
      const plan = planned.plan;
      const doc: OpenDoc = { plan, ready: new Set(), leased: new Map(), notBefore: new Map(), strikes: new Map() };
      const pending = pendingOf(plan);
      if (pending.length === 0) {
        // every segment was cached: nothing to run, only to write
        void this.finish(doc);
        continue;
      }
      // a long document's first segment names its subject for the rest
      if (plan.segments.length > 1 && !settled(plan.results[0])) doc.ready.add(0);
      else for (const i of pending) doc.ready.add(i);
      this.open.set(row.document_id, doc);
    }
    return true;
  }

  private async issue(doc: OpenDoc, index: number, who: WorkerIdentity): Promise<LabelingTask> {
    const config = this.ctx.config();
    const request = await segmentExtractRequest(this.ctx.store, config, doc.plan, index, this.ontologyNow());
    const now = Date.now();
    const lease: Lease = {
      id: crypto.randomUUID(), docId: doc.plan.row.document_id, index, who,
      issuedAt: now, expiresAt: now + this.leaseMs,
      request: { withClaims: request.withClaims, askSubject: request.askSubject },
      expired: false,
    };
    this.leases.set(lease.id, lease);
    doc.ready.delete(index);
    doc.leased.set(index, lease.id);
    const parts = doc.plan.segments.length;
    return {
      id: lease.id,
      kind: 'extract',
      label: `${doc.plan.row.path}${parts > 1 ? ` [${index + 1}/${parts}]` : ''}`,
      document: { path: doc.plan.row.path, title: doc.plan.page.title, part: index + 1, parts },
      messages: request.messages,
      prompt: renderCliPrompt(request.messages, true),
      json: true,
      maxTokens: request.maxTokens,
      leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
    };
  }

  private async record(who: WorkerIdentity, doc: OpenDoc, lease: Lease, outcome: TaskOutcome): Promise<void> {
    const now = Date.now();
    const plan = doc.plan;
    const label = plan.segments.length > 1 ? ` [${lease.index + 1}/${plan.segments.length}]` : '';
    const model = who.remote ? `remote:${outcome.model || who.backend}` : outcome.model || who.backend;
    const worker = this.workers.get(who.worker);
    this.totals.calls++;
    this.recentCalls.push(now);
    let failure: { kind: FailureKind; error: string } | null = null;
    if (outcome.ok) {
      try {
        const reply = jsonFromReply<RawExtractReply>(outcome.text);
        const result = await checkExtractReply(reply, lease.request, { dataDir: this.ctx.dataDir, plan, index: lease.index, model });
        recordSegmentOutcome(plan, lease.index, { ok: true, result }, model);
        doc.strikes.delete(lease.index);
        doc.notBefore.delete(lease.index);
      } catch (err) {
        failure = { kind: 'model', error: `unusable reply: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      failure = { kind: outcome.kind ?? classifyFailure(outcome.error), error: outcome.error || 'failed without a message' };
    }
    if (!failure) {
      this.totals.ok++;
      if (worker) worker.ok++;
    } else {
      this.totals.failed[failure.kind]++;
      if (worker) worker.failed++;
      const strikes = (doc.strikes.get(lease.index) ?? 0) + 1;
      if (failure.kind === 'model' || strikes >= STRIKE_LIMIT) {
        recordSegmentOutcome(plan, lease.index, { ok: false, error: failure.error }, model);
        doc.strikes.delete(lease.index);
        const attempts = plan.results[lease.index]?.attempts ?? 1;
        doc.notBefore.set(lease.index, now + this.modelRetryMs * attempts);
      } else {
        doc.strikes.set(lease.index, strikes);
        doc.notBefore.set(lease.index, now + this.transientRetryMs);
      }
      this.log(`labeling: ${plan.row.path}${label} failed on ${who.worker} (${failure.kind}): ${failure.error.slice(0, 240)}`);
    }
    persistPlan(this.ctx.dataDir, plan, model);
  }

  private expireLeases(): void {
    const now = Date.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expired) {
        if (now - lease.expiresAt > EXPIRED_GRACE_MS) this.leases.delete(lease.id);
        continue;
      }
      if (lease.expiresAt > now) continue;
      lease.expired = true;
      this.totals.leasesExpired++;
      const doc = this.open.get(lease.docId);
      if (!doc || doc.leased.get(lease.index) !== lease.id) continue;
      doc.leased.delete(lease.index);
      const strikes = (doc.strikes.get(lease.index) ?? 0) + 1;
      if (strikes >= STRIKE_LIMIT) {
        recordSegmentOutcome(doc.plan, lease.index, { ok: false, error: `no answer from ${STRIKE_LIMIT} workers in a row` }, lease.who.backend);
        doc.strikes.delete(lease.index);
        persistPlan(this.ctx.dataDir, doc.plan, lease.who.backend);
      } else {
        doc.strikes.set(lease.index, strikes);
      }
      if (!settled(doc.plan.results[lease.index])) doc.ready.add(lease.index);
      this.log(`labeling: lease on ${doc.plan.row.path} [${lease.index + 1}/${doc.plan.segments.length}] held by ${lease.who.worker} expired`);
      if (pendingOf(doc.plan).length === 0 && doc.leased.size === 0) {
        this.open.delete(lease.docId);
        void this.finish(doc);
      }
    }
  }

  /** Write a settled document — unless it changed since it was opened, in which case its new text goes back in line. */
  private finish(doc: OpenDoc): Promise<boolean> {
    const plan = doc.plan;
    const run = this.applyChain.then(async () => {
      try {
        const [current] = await this.ctx.store.query<{ sha256: string; status: string }>(`SELECT sha256, status FROM documents WHERE id = $1`, [plan.row.document_id]);
        if (!current || current.sha256 !== plan.row.sha256 || current.status !== 'indexed') {
          // a sync replaced (or removed) the document while it was being read: its segments stay
          // cached in the sidecar by their text, so reopening it re-reads only what changed
          this.totals.stale++;
          return false;
        }
        const fallback = [...plan.results].reverse().find((r) => r?.model)?.model ?? 'labeling';
        const done = await finishPlan(this.ctx.store, plan, fallback);
        if (done.kind === 'stale') {
          // the same, landing after the look above: finishPlan looks again under the ledger lock every re-index takes
          this.totals.stale++;
          return false;
        }
        if (done.kind === 'failed') {
          this.totals.documentsFailed++;
          this.finished.failed++;
          this.log(`labeling: gave up on ${plan.row.path}: every segment failed`);
          return false;
        }
        this.noteWritten(plan.row.path, done.applied);
        const { segments, failedSegments, applied } = done;
        this.log(`tier1 wrote ${plan.row.path} (${segments === 1 ? 'one call' : `${segments} segments${failedSegments.length ? `, ${failedSegments.length} failed` : ''}`}; ${applied.entities} entities, ${applied.claims} claims; ${done.model})`);
        return true;
      } catch (err) {
        this.log(`labeling: writing ${plan.row.path} failed: ${err instanceof Error ? err.message : err}`);
        return false;
      } finally {
        releaseDocument(this.ctx.dataDir, plan.row.document_id, this.owner);
      }
    });
    this.applyChain = run.catch(() => false);
    return run;
  }

  private noteWritten(path: string, applied: { entityIds: string[]; claimIds: string[] }): void {
    this.totals.documentsWritten++;
    this.recentDocs.push(Date.now());
    this.finished.written++;
    keepNewest(this.finished.documents, [path]);
    keepNewest(this.finished.entityIds, applied.entityIds);
    keepNewest(this.finished.claimIds, applied.claimIds);
    this.ctx.onWritten?.(path);
  }
}
