import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { effortFor, renderCliPrompt } from '../llm/cli.js';
import { jsonFromReply, LlmClient } from '../llm/client.js';
import type { ChatMessage } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { readCodexEvents } from '../llm/usage.js';
import { MCP_TOKEN_FILE } from '../server/mcp-http.js';
import type { WorkerIdentity } from '../labeling/scheduler.js';
import { WorkBroker } from '../work/broker.js';
import type { EvalAgent, WorkTask } from '../work/broker.js';
import { folderStamp, packFolder } from '../work/eval-archive.js';
import { EVAL_FAMILIES, EvalSource, machineOf } from '../work/eval.js';
import type { EvalCallSpec, EvalEligible, EvalFamily, EvalOutcome, EvalRunStatus, EvalSessionAnswer, EvalSessionSpec, EvalSlotSeen, EvalSourceOptions, EvalSpec } from '../work/eval.js';
import type { EvalKind } from '../work/kinds.js';
import type { AgentRunOptions, AgentRunResult, ClosingOutcome } from './agent.js';
import { AgentTrace, closingOf } from './agent.js';
import type { LoadedPack } from './pack.js';
import { currentPieceTag, notePlacement } from './placement.js';
import type { PieceTag } from './placement.js';
import type { QuotaGuard } from './quota.js';
import type { ChatBackend, ChatRequest, ChatResult } from './shim.js';

/**
 * An evaluation run's model work as published work (docs/design/32, on the
 * lease protocol of docs/design/27 §8).
 *
 * The run only publishes. Every model call of a system (the shim's backend,
 * `PublishedChatBackend`), every judge call (`remoteJudgeClient`) and every
 * agent session (`runAgent`, src/eval/agent.ts) becomes a piece in a queue,
 * and slots that lease from that queue do the work:
 *
 *   - the queue is `serve`'s broker when the run reaches it on this machine
 *     (`--remote`, over the loopback producer channel, src/remote/eval-producer.ts),
 *     and otherwise one the run starts in its own process (`RemoteEval.own`);
 *   - remote workers lease from `serve`'s like any other kind of work;
 *   - the run's own slots (`--local codex:6,claude:1`) lease from either like a
 *     worker, and run a piece with the run's own backends (its stand-ins,
 *     chains, connections and agent routing), found by the piece's key.
 *
 * A piece that may not leave this machine (a pack with a `private:` source,
 * a model the run does not name, a backend only the run has, a session that
 * writes) is published `eligible: local`: only a slot on this machine takes
 * it. With no slot for a piece, it waits.
 */

export type RemoteOutcome = EvalOutcome | { outcome: 'unreachable'; error: string } | { outcome: 'refused'; status: number; error: string };

/** The outcomes this run knows; anything else comes from a `serve` of another version. */
const KNOWN_OUTCOMES = new Set(['answered', 'error', 'stuck', 'cancelled', 'stopped']);

/** A producer-channel run id (`[A-Za-z0-9][A-Za-z0-9._-]*`, at most 120) for a run directory of any name: itself when it is one. */
export function queueRunId(name: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)) return name;
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'run';
  return `${slug}-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

/** A run's own slot as the queue knows it: its name, its CLI, its run, its pool. */
export interface LocalSlotIdentity {
  name: string;
  family: EvalFamily;
  run: string;
  pool: string;
}

export type LocalOutcome = { ok: true } | { ok: false; error: string };

interface QueueStatus {
  /** Whether `serve` offers eval work to remote workers at all. */
  offered: boolean;
  slots: Record<EvalKind, EvalSlotSeen[]>;
  run: EvalRunStatus;
  /** Where serve keeps tasks (docs/design/32 §5); null: a serve from stage 1, which holds one request per piece. */
  tasks?: { version: number; durable: boolean; reason: string | null } | null;
}

/** Where a run publishes: `serve`'s broker or its own. One code path either way. */
export interface EvalQueue {
  readonly where: 'serve' | 'own';
  readonly origin: string | null;
  publish(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome>;
  status(run: string): Promise<QueueStatus>;
  /** The slots online now, where the queue can say without a request (the run's own broker). */
  slotsNow?(): Record<EvalKind, EvalSlotSeen[]>;
  /** A folder a worker's session reads: only `serve` hands archives to workers. */
  archive(dir: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number } | null>;
  /**
   * The run went away (stopped, killed, at its wait limit): what only it can
   * serve is withdrawn and the rest is left for its resume, where tasks are
   * durable; elsewhere (and where absent) the same as `cancelRun`.
   */
  detach?(run: string): Promise<void>;
  lease(who: LocalSlotIdentity, kinds: EvalKind[]): Promise<WorkTask[]>;
  complete(who: LocalSlotIdentity, id: string, outcome: LocalOutcome): Promise<void>;
  renew(who: LocalSlotIdentity, ids: string[]): Promise<void>;
  release(who: LocalSlotIdentity, ids: string[]): Promise<void>;
  cancelRun(run: string): Promise<void>;
  close(): void;
}

const localWho = (who: LocalSlotIdentity): WorkerIdentity => ({ worker: `local/${who.run}/${who.name}`, backend: who.family, remote: false, run: who.run, pool: who.pool });

/** The run's own broker, in its own process: no remote worker can reach it, the run's own slots lease from it. */
export class OwnQueue implements EvalQueue {
  readonly where = 'own' as const;
  readonly origin = null;
  readonly calls: EvalSource;
  readonly sessions: EvalSource;
  private readonly broker: WorkBroker;

  constructor(opts: EvalSourceOptions = {}) {
    this.calls = new EvalSource('eval-call', opts);
    this.sessions = new EvalSource('eval-session', opts);
    EvalSource.link([this.calls, this.sessions]);
    this.broker = new WorkBroker([this.calls, this.sessions]);
  }

  private source(kind: EvalKind): EvalSource {
    return kind === 'eval-call' ? this.calls : this.sessions;
  }

  publish(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome> {
    return this.source(spec.kind).offer(spec, { signal }).result;
  }

  slotsNow(): Record<EvalKind, EvalSlotSeen[]> {
    return { 'eval-call': this.calls.slotsOnline(), 'eval-session': this.sessions.slotsOnline() };
  }

  async status(run: string): Promise<QueueStatus> {
    const a = this.calls.runStatus(run);
    const b = this.sessions.runStatus(run);
    return {
      offered: false,
      slots: { 'eval-call': this.calls.slotsOnline(), 'eval-session': this.sessions.slotsOnline() },
      run: { waiting: a.waiting + b.waiting, leased: a.leased + b.leased },
    };
  }

  async archive(): Promise<null> {
    return null;
  }

  lease(who: LocalSlotIdentity, kinds: EvalKind[]): Promise<WorkTask[]> {
    return this.broker.lease(localWho(who), kinds, 1);
  }

  async complete(who: LocalSlotIdentity, id: string, outcome: LocalOutcome): Promise<void> {
    await this.broker.complete(id, localWho(who), outcome.ok ? { ok: true, text: '' } : { ok: false, error: outcome.error, kind: 'model' });
  }

  async renew(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    this.broker.renew(ids, localWho(who));
  }

  async release(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    await this.broker.release(ids, localWho(who));
  }

  async cancelRun(run: string): Promise<void> {
    this.calls.cancelRun(run);
    this.sessions.cancelRun(run);
  }

  /** In memory: nothing outlives the run, so going away cancels everything. */
  detach(run: string): Promise<void> {
    return this.cancelRun(run);
  }

  close(): void {
    this.calls.close();
    this.sessions.close();
  }
}

/** A piece the run waits for in serve's durable queue: published (or not yet), and who waits for it. */
interface Wanted {
  spec: EvalSpec;
  resolve: ((o: RemoteOutcome) => void)[];
  published: boolean;
  sending: boolean;
}

/** The longest a poll is held in serve, and the batch the run publishes at once. */
const POLL_WAIT_MS = 20_000;
const PUBLISH_BATCH = 100;
const POLL_KEYS = 4_000;

/**
 * Whether a 4xx is `serve` refusing the request. 408 and 429 are not: the
 * request did not arrive whole (a run or a `serve` that stalled for a
 * minute), or too many did. Nor is a 400 with nothing in it where `serve`
 * words every refusal of its own (`bare`: the archive upload): that one is
 * the HTTP server giving up on a request cut short. Those are waited out
 * and sent again, as no answer is.
 */
function finalRefusal(status: number, bare = false): boolean {
  if (status < 400 || status >= 500) return false;
  if (status === 408 || status === 429) return false;
  return !(status === 400 && bare);
}

/** How long an archive `serve` confirmed is taken as held without asking again: `serve` keeps one a day after its last use. */
const ARCHIVE_HELD_MS = 3_600_000;

/** `serve`'s broker, over the loopback producer channel and the data root's MCP token. */
export class ServeQueue implements EvalQueue {
  readonly where = 'serve' as const;
  /** Serve keeps tasks itself (docs/design/32 §5): the run publishes in batches and polls, instead of one held request a piece. */
  durable = false;
  /** Serve keeps them in memory only (another serve holds the folder): said once. */
  storeReason: string | null = null;
  private readonly wanted = new Map<string, Wanted>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private polling = false;
  private pollAbort: AbortController | null = null;
  private readonly watched = new WeakSet<AbortSignal>();
  private closedQueue = false;

  constructor(private readonly serveUrl: string, private readonly token: string, private readonly opts: { scope?: string | null; deadlineMs?: number } = {}) {}

  get origin(): string {
    return this.serveUrl;
  }

  private headers(json = true): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  private async post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.serveUrl}/eval/v1/${route}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) });
    const text = (await res.text()).trim();
    let parsed: (T & { error?: string }) | null = null;
    try {
      parsed = text ? JSON.parse(text) as T & { error?: string } : null;
    } catch {
      // not JSON: a proxy's page, a server mid-restart
    }
    // a refusal (and the queue at its bound, 507) is serve's answer: asking again gets the same
    if ((finalRefusal(res.status) && res.status !== 409) || res.status === 507) throw new ServeRefusedError(route, res.status, parsed?.error ?? text.slice(0, 200));
    if (!parsed || (!res.ok && res.status !== 409)) throw new Error(`${route}: ${res.status} ${parsed?.error ?? text.slice(0, 200)}`);
    return parsed;
  }

  /**
   * Publish a piece and wait for what becomes of it. On a serve that keeps
   * tasks (stage 2) the piece joins a batch, and one poll waits for all the
   * run's pieces; on a serve from stage 1 it is one held request.
   */
  publish(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome> {
    if (!this.durable) return this.offer(spec, signal);
    if (signal.aborted || this.closedQueue) return Promise.resolve({ outcome: 'cancelled' });
    this.watch(signal);
    return new Promise<RemoteOutcome>((resolve) => {
      const had = this.wanted.get(spec.key);
      if (had) {
        had.spec = spec;
        had.resolve.push(resolve);
        had.published = false;
      } else this.wanted.set(spec.key, { spec, resolve: [resolve], published: false, sending: false });
      this.scheduleFlush();
    });
  }

  /** The run's signal ends every piece it waits for, once (one listener, however many pieces). */
  private watch(signal: AbortSignal): void {
    if (this.watched.has(signal)) return;
    this.watched.add(signal);
    signal.addEventListener('abort', () => {
      for (const key of [...this.wanted.keys()]) this.settle(key, { outcome: 'cancelled' });
      this.pollAbort?.abort();
    }, { once: true });
  }

  private settle(key: string, outcome: RemoteOutcome): void {
    const w = this.wanted.get(key);
    if (!w) return;
    this.wanted.delete(key);
    for (const r of w.resolve) r(outcome);
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 20);
    this.flushTimer.unref?.();
  }

  /** Publish what waits to be published, a batch at a time; then (re)start the one poll for all of them. */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        if (this.closedQueue) return;
        const batch = [...this.wanted.values()].filter((w) => !w.published && !w.sending).slice(0, PUBLISH_BATCH);
        if (!batch.length) break;
        for (const w of batch) w.sending = true;
        try {
          const r = await this.post<{ tasks?: { key: string; state: string; outcome?: RemoteOutcome }[] }>('tasks', {
            run: batch[0].spec.run, scope: this.opts.scope ?? null, deadlineMs: this.opts.deadlineMs, specs: batch.map((w) => w.spec),
          });
          for (const w of batch) w.sending = false;
          for (const t of r.tasks ?? []) {
            const w = this.wanted.get(t.key);
            if (!w) continue;
            if (t.outcome) this.settle(t.key, this.known(t.outcome));
            else w.published = true;
          }
        } catch (err) {
          for (const w of batch) w.sending = false;
          const outcome: RemoteOutcome = err instanceof ServeRefusedError
            ? { outcome: 'refused', status: err.status, error: err.reason }
            : { outcome: 'unreachable', error: err instanceof Error ? err.message : String(err) };
          for (const w of batch) this.settle(w.spec.key, outcome);
        }
      }
    } finally {
      this.flushing = false;
    }
    // the keys changed: the poll held now asks after the old ones, so it starts again with all of them
    this.pollAbort?.abort();
    if (!this.polling) void this.poll();
  }

  /** An outcome this run knows, or a refusal naming the other version. */
  private known(o: RemoteOutcome): RemoteOutcome {
    if (KNOWN_OUTCOMES.has(o.outcome)) return o;
    return { outcome: 'refused', status: 200, error: `serve answered "${o.outcome}", which this run does not know: serve on this machine runs another version — restart it on this build` };
  }

  /** One poll for every piece published and not yet done: held in serve until one is done. */
  private async poll(): Promise<void> {
    this.polling = true;
    try {
      while (!this.closedQueue) {
        const keys = [...this.wanted.values()].filter((w) => w.published).map((w) => w.spec.key).slice(0, POLL_KEYS);
        if (!keys.length) return;
        const run = this.wanted.get(keys[0])!.spec.run;
        const ac = new AbortController();
        this.pollAbort = ac;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, POLL_WAIT_MS + 15_000);
        timer.unref?.();
        try {
          const r = await this.post<{ done?: { key: string; outcome: RemoteOutcome }[]; missing?: string[] }>('tasks/poll', { run, keys, waitMs: POLL_WAIT_MS }, ac.signal);
          for (const d of r.done ?? []) this.settle(d.key, this.known(d.outcome));
          // serve does not have it (it lost it, or never had it): published again
          let again = false;
          for (const key of r.missing ?? []) {
            const w = this.wanted.get(key);
            if (w) {
              w.published = false;
              again = true;
            }
          }
          if (again) this.scheduleFlush();
        } catch (err) {
          // started again for a new set of keys, or the run is closing
          if (ac.signal.aborted && !timedOut) continue;
          const outcome: RemoteOutcome = err instanceof ServeRefusedError
            ? { outcome: 'refused', status: err.status, error: err.reason }
            : { outcome: 'unreachable', error: timedOut ? 'serve held a poll past its time' : err instanceof Error ? err.message : String(err) };
          // every piece published waits for serve and is published again (serve kept it: the same task)
          for (const key of keys) this.settle(key, outcome);
        } finally {
          clearTimeout(timer);
          if (this.pollAbort === ac) this.pollAbort = null;
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Stage 1's way, for a serve from before stage 2: one request held open until the piece is answered. */
  private async offer(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome> {
    try {
      const res = await fetch(`${this.serveUrl}/eval/v1/offer`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify({ spec }), signal,
      });
      const text = (await res.text()).trim();
      let body: (RemoteOutcome & { error?: string }) | null = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // not JSON: a proxy's page, a server mid-restart
      }
      // a refusal is final (a spec serve will not take, a token it does not know); only a server error or no answer is waited out
      if (finalRefusal(res.status)) return { outcome: 'refused', status: res.status, error: body?.error ?? text.slice(0, 300) };
      if (!res.ok || !body || !('outcome' in body)) throw new Error(`${res.status}: ${body?.error ?? text.slice(0, 200)}`);
      if (!KNOWN_OUTCOMES.has(body.outcome)) return { outcome: 'refused', status: res.status, error: `serve answered "${body.outcome}", which this run does not know: serve on this machine runs another version — restart it on this build` };
      return body;
    } catch (err) {
      if (signal.aborted) return { outcome: 'cancelled' };
      return { outcome: 'unreachable', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async status(run: string, first = false): Promise<QueueStatus> {
    const res = await fetch(`${this.serveUrl}/eval/v1/status?run=${encodeURIComponent(run)}`, { headers: this.headers(false), signal: AbortSignal.timeout(first ? 5_000 : 10_000) });
    // a refusal first (a token serve does not know, a route it lacks): that is serve answering, not serve gone
    if (finalRefusal(res.status)) throw new ServeRefusedError('status', res.status, (await res.text()).slice(0, 200));
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as Partial<QueueStatus>;
    // a serve from before docs/design/32 has no slots for a run's own and would withdraw pieces: refuse it plainly
    if (!body.slots) throw new ServeRefusedError('status', res.status, 'serve on this machine is older than this run (no slots in /eval/v1/status): restart it on this build, or run without --remote');
    const tasks = body.tasks && typeof body.tasks.version === 'number' ? body.tasks : null;
    // the first answer decides the protocol; a serve restarted on stage 1 later refuses /tasks plainly (404)
    if (first) {
      this.durable = Boolean(tasks && tasks.version >= 2);
      this.storeReason = tasks && !tasks.durable ? tasks.reason ?? 'serve keeps its tasks in memory' : null;
    }
    return { offered: Boolean(body.offered), slots: { 'eval-call': body.slots?.['eval-call'] ?? [], 'eval-session': body.slots?.['eval-session'] ?? [] }, run: body.run ?? { waiting: 0, leased: 0 }, tasks };
  }

  /** A folder packed once: its id by what its files were (`folderStamp`). */
  private readonly packed = new Map<string, { stamp: string; sha256: string; bytes: number }>();
  /**
   * When `serve` last confirmed holding an archive, by its id and not by its
   * folder: the knode arms give every question a fresh copy of the same
   * pages and sources, a new folder each time with the same content.
   */
  private readonly heldAt = new Map<string, number>();
  /** The upload under way for a folder: the questions that ask together wait for the one. */
  private readonly uploading = new Map<string, Promise<{ sha256: string; bytes: number }>>();

  /**
   * Packed, and uploaded unless `serve` holds it already: a folder every
   * question reads is read once and goes up once. The packing is remembered
   * while no file of the folder has changed, and `serve`'s word that it
   * holds an archive for an hour (`ARCHIVE_HELD_MS`), by the archive's id,
   * so a copy of the folder made for the next question (same content,
   * another path) is hashed and not sent: a `serve` built
   * before 2026-11-22 answers every check with 404 (its check was routed
   * as HEAD, which the router serves by the GET route, and there was
   * none), and asking it for every question sent the whole corpus up each
   * time.
   */
  archive(dir: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number }> {
    let pending = this.uploading.get(dir);
    if (!pending) {
      pending = this.upload(dir, signal).finally(() => {
        if (this.uploading.get(dir) === pending) this.uploading.delete(dir);
      });
      this.uploading.set(dir, pending);
    }
    return pending;
  }

  private async upload(dir: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number }> {
    const stamp = folderStamp(dir);
    let held = this.packed.get(dir);
    let folder: ReturnType<typeof packFolder> | null = null;
    if (held?.stamp !== stamp) {
      folder = packFolder(dir);
      held = { stamp, sha256: folder.sha256, bytes: folder.bytes };
      this.packed.set(dir, held);
    }
    const at = { sha256: held.sha256, bytes: held.bytes };
    if (Date.now() - (this.heldAt.get(at.sha256) ?? 0) < ARCHIVE_HELD_MS) return at;
    const head = await fetch(`${this.serveUrl}/eval/v1/archives/${at.sha256}`, { method: 'HEAD', headers: this.headers(false), signal });
    if (head.ok) {
      this.heldAt.set(at.sha256, Date.now());
      return at;
    }
    if (head.status !== 404) {
      if (finalRefusal(head.status)) throw new ServeRefusedError('archives', head.status, 'serve refused the archive check');
      throw new Error(`archive check failed: ${head.status}`);
    }
    folder ??= packFolder(dir);
    if (folder.sha256 !== at.sha256) {
      this.packed.delete(dir);
      throw new Error(`${dir} changed while its archive was checked`);
    }
    const res = await fetch(`${this.serveUrl}/eval/v1/archives/${at.sha256}`, {
      method: 'PUT', headers: { ...this.headers(false), 'content-type': 'application/gzip' }, body: await folder.gzipped(), signal,
    });
    if (res.ok) {
      this.heldAt.set(at.sha256, Date.now());
      return at;
    }
    const text = (await res.text()).slice(0, 200);
    if (finalRefusal(res.status, !text.trim())) throw new ServeRefusedError('archives', res.status, text);
    throw new Error(`archive upload failed: ${res.status} ${text}`);
  }

  async lease(who: LocalSlotIdentity, kinds: EvalKind[]): Promise<WorkTask[]> {
    const r = await this.post<{ tasks?: WorkTask[] }>('slots/lease', { worker: who.name, family: who.family, run: who.run, pool: who.pool, kinds });
    return r.tasks ?? [];
  }

  async complete(who: LocalSlotIdentity, id: string, outcome: LocalOutcome): Promise<void> {
    await this.post('slots/complete', { worker: who.name, family: who.family, run: who.run, pool: who.pool, id, ...(outcome.ok ? { ok: true, text: '' } : { ok: false, error: outcome.error, kind: 'model' }) });
  }

  async renew(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    await this.post('slots/renew', { worker: who.name, family: who.family, run: who.run, pool: who.pool, ids });
  }

  async release(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    await this.post('slots/release', { worker: who.name, family: who.family, run: who.run, pool: who.pool, ids });
  }

  async cancelRun(run: string): Promise<void> {
    await fetch(`${this.serveUrl}/eval/v1/runs/${encodeURIComponent(run)}/cancel`, { method: 'POST', headers: this.headers(false), signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }

  /** Durable: only what needs the run is withdrawn, the rest waits for its resume. Stage 1: everything is. */
  async detach(run: string): Promise<void> {
    if (!this.durable) return this.cancelRun(run);
    await fetch(`${this.serveUrl}/eval/v1/runs/${encodeURIComponent(run)}/detach`, { method: 'POST', headers: this.headers(false), signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }

  close(): void {
    this.closedQueue = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const key of [...this.wanted.keys()]) this.settle(key, { outcome: 'cancelled' });
    this.pollAbort?.abort();
  }
}

export interface RemoteEvalOptions {
  /** The run's id: pieces carry it, and cancelling the run withdraws them. */
  run: string;
  /**
   * The run's directory (docs/design/32 §5): part of every piece's key, so a
   * resumed run finds its own pieces in serve's store and another run of the
   * same name never does. Absent: the run's id alone.
   */
  scope?: string;
  /** The run's quota guard: a run's own Codex slot waits for this machine's plan before it runs a piece. */
  quota?: QuotaGuard | null;
  /** How often the slots online are read again from `serve` (default 15 s). */
  refreshMs?: number;
  /** How often a run's own slot renews the lease of a piece it runs (default 20 s). */
  renewMs?: number;
  /**
   * The pool every piece of the run requires (`eval run --pool`, docs/design/32
   * §2); the run's own slots are in it too. Absent: pieces take any slot that
   * meets them, and the run's own slots are pool `local`.
   */
  pool?: string | null;
  /**
   * How long a piece may wait while no slot online meets its requirements
   * before the run stops (default 30; 0: no limit). Fractions are minutes too.
   */
  waitMinutes?: number;
  /** How often waiting is checked (default 5 s) and logged (default once a minute). */
  checkMs?: number;
  logEveryMs?: number;
  /** The wait limit passed, or serve refused the run: the run stops, cleanly. */
  onStop?: (why: RunStoppedError) => void;
  /** The first wait before a piece is published again while serve does not answer (default 1 s, doubling to 15 s). */
  backoffMs?: number;
  /** A piece three different workers could not serve (for the run's events). */
  onStuck?: (piece: StuckPiece) => void;
  log?: (msg: string) => void;
}

/** What a waiting piece requires, as the run's wait and its log say it. */
interface Requirement {
  kind: EvalKind;
  family: EvalFamily;
  model: string;
  eligible: EvalEligible;
  pool: string | null;
}

const requirementKey = (r: Requirement) => `${r.kind}|${r.family}|${r.model}|${r.eligible}|${r.pool ?? ''}`;

/** A requirement in words: what a run waits for. */
export function describeRequirement(r: Pick<Requirement, 'family' | 'model' | 'eligible' | 'pool'> & { kind?: EvalKind }): string {
  const what = r.kind === 'eval-session' ? 'an agent session' : r.kind === 'eval-call' ? 'a model call' : 'work';
  return `${what} on ${r.family}${r.model ? ` ${r.model}` : ''} in ${r.pool ? `pool ${r.pool}` : 'any pool'}${r.eligible === 'local' ? ", on this machine's slots only" : ''}`;
}

/** A piece three different workers could not serve, as the run reports it. */
export interface StuckPiece {
  kind: EvalKind;
  label: string;
  family: EvalFamily;
  model: string;
  eligible: EvalEligible;
  pool: string | null;
  /** The system and task it was for (a build's: no task; the judge's: `__judge__`). */
  system: string | null;
  task: string | null;
  workers: string[];
  lastError: string;
  at: string;
}

/** A piece left unanswered because three different workers could not serve it: the answer or build it was for is not recorded. */
export class PieceStuckError extends Error {
  /** Never tried again by the shim: the run reports it and leaves it for a resume. */
  readonly final = true;

  constructor(readonly piece: StuckPiece) {
    super(`stuck: ${piece.workers.length} workers could not serve ${piece.label} (${piece.workers.join(', ')}): ${piece.lastError.slice(0, 300)}`);
  }
}

/** Why a run stopped before its end, cleanly: nothing in flight is recorded, and a resume continues. */
export abstract class RunStoppedError extends Error {
  /** The run directory to resume (set by the run). */
  runDir?: string;
  /** Never tried again by the shim or the judge. */
  readonly final = true;
}

/** `serve` refused what the run sent (a 4xx): asking again would get the same answer, so the run stops with serve's word. */
export class ServeRefusedError extends RunStoppedError {
  constructor(readonly route: string, readonly status: number, readonly reason: string) {
    super(`serve refused ${route} (${status}): ${reason}`);
  }
}

/** The run waited `--wait-minutes` for a slot that meets a piece's requirements, and stopped. */
export class WaitLimitError extends RunStoppedError {
  constructor(readonly requirement: Requirement, readonly minutes: number) {
    super(`waited ${minutes} min for a slot that takes ${describeRequirement(requirement)}, and none came online: the run stopped, with nothing recorded for the pieces still waiting — start a worker (or pass --local) and resume with --run-dir`);
  }
}

/** Whether a pack's work may leave this machine: none of its sources is private. */
export function packMayLeave(pack: Pick<LoadedPack, 'manifest'>): boolean {
  return !pack.manifest.sources.some((s) => s.license.trim().toLowerCase().startsWith('private:'));
}

/** `serve`'s origin and token for this machine's data root (`--serve-url` overrides the origin). */
export function localServe(dataRoot: string, serveUrl?: string): { serveUrl: string; token: string } {
  const tokenFile = path.join(dataRoot, MCP_TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) throw new Error(`--remote: no ${MCP_TOKEN_FILE} under ${dataRoot} — start \`knode-os serve\` once, or pass --data`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (serveUrl) return { serveUrl: serveUrl.replace(/\/+$/, ''), token };
  const config = loadConfig(dataRoot);
  const host = !config.server.host || config.server.host === '0.0.0.0' || config.server.host === '::' ? '127.0.0.1' : config.server.host;
  return { serveUrl: `http://${host}:${config.server.port}`, token };
}

export { machineOf };

/**
 * `eval drop <run-dir>`: the run's tasks and results in serve's queue
 * (docs/design/32 §5), for its answers and its scoring — through serve when it
 * answers (it holds the store), straight from the data root's folder when no
 * serve does. Says what it did, one line each.
 */
export async function dropQueuedRun(runDir: string, dataRoot: string, opts: { serveUrl?: string; log?: (m: string) => void } = {}): Promise<number> {
  const { dropStoredRun } = await import('../work/eval-store.js');
  const dir = path.resolve(runDir);
  const name = path.basename(dir);
  const parts = [{ run: queueRunId(name), scope: scopeOf(dir) }, { run: queueRunId(`${name}-score`), scope: scopeOf(`${dir}#score`) }];
  let at: { serveUrl: string; token: string } | null = null;
  try {
    at = localServe(dataRoot, opts.serveUrl);
  } catch {
    // no serve was ever started on this data root: nothing holds its folder
  }
  let removed = 0;
  for (const { run, scope } of parts) {
    let n: number | null = null;
    if (at) {
      const res = await fetch(`${at.serveUrl}/eval/v1/runs/${encodeURIComponent(run)}?scope=${scope}`, { method: 'DELETE', headers: { authorization: `Bearer ${at.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (res?.ok) n = ((await res.json()) as { removed?: number }).removed ?? 0;
      else if (res && res.status >= 400) {
        // serve answers but from before durable tasks: it keeps nothing of the run past its requests
        const stale = res.status === 404;
        if (!stale) throw new Error(`serve refused to drop ${run}'s tasks (${res.status}): ${(await res.text()).slice(0, 200)}`);
        n = 0;
      }
    }
    // serve is not answering: the folder, unless a serve still holds it
    n ??= dropStoredRun(dataRoot, run, scope);
    if (n === null) throw new Error(`a serve holds the evaluation queue of ${dataRoot} but does not answer: start it again and drop the run, or stop it first`);
    if (n) opts.log?.(`${run}: dropped ${n} task(s) and their results from serve's queue`);
    removed += n;
  }
  return removed;
}

/** What a piece came back as: run by one of the run's own slots (its value or what it threw), or by a worker. */
export type Published<T> =
  | { local: true; value: T }
  | { local: true; error: unknown }
  | { local: false; outcome: Extract<EvalOutcome, { outcome: 'answered' | 'error' }> };

interface Entry {
  exec: () => Promise<unknown>;
  /** One of the run's own slots runs it now: another that leases the piece waits for this, never runs it again. */
  running?: Promise<void>;
  done?: { value: unknown } | { error: unknown };
}

/** Run a piece's work once, whichever of the run's own slots gets to it first. */
function runOnce(entry: Entry): Promise<void> {
  entry.running ??= (async () => {
    try {
      entry.done = { value: await entry.exec() };
    } catch (error) {
      entry.done = { error };
    }
  })();
  return entry.running;
}

/** A run's scope as serve keeps it: a digest of its directory. */
export function scopeOf(dir: string): string {
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 24);
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    resolve();
  }, { once: true });
});

/** The kinds a run's own slot of a CLI takes: agent sessions run on Codex only. */
const LOCAL_KINDS: Record<EvalFamily, EvalKind[]> = { codex: ['eval-call', 'eval-session'], claude: ['eval-call'] };

export class RemoteEval {
  private status: QueueStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private readonly log: (msg: string) => void;
  private cancelling: Promise<void> | null = null;
  private closed = false;
  private readonly entries = new Map<string, Entry>();
  /** Pieces published by what they are: the n-th of the same gets its own key. */
  private readonly seen = new Map<string, number>();
  private readonly local: Record<EvalFamily, number> = { codex: 0, claude: 0 };
  private readonly loops: Promise<void>[] = [];
  private wake: (() => void) | null = null;
  private wakeAt: Promise<void> | null = null;
  private unreachableSaid = false;
  private readonly outstanding = new Map<string, { requirement: Requirement; n: number }>();
  private readonly unmetSince = new Map<string, number>();
  private waitTimer: NodeJS.Timeout | null = null;
  private lastWaitLog = 0;
  /** Set when the run stopped: its wait limit passed, or serve refused it. */
  stopped: RunStoppedError | null = null;
  /** Whether the queue answered lately (the run's own broker always does). */
  private reachable = true;
  /** Pieces three different workers could not serve, in the order they stuck. */
  readonly stuck: StuckPiece[] = [];
  /** Pieces published, and who served them, for the run's log. */
  readonly counts = { published: 0, workers: 0, local: 0 };

  private constructor(readonly queue: EvalQueue, private readonly opts: RemoteEvalOptions) {
    this.log = opts.log ?? (() => {});
    this.waitTimer = setInterval(() => this.checkWaiting(), Math.max(50, opts.checkMs ?? 5_000));
    this.waitTimer.unref?.();
    const refreshMs = queue.where === 'own' ? Math.min(opts.refreshMs ?? 1_000, 1_000) : opts.refreshMs ?? 15_000;
    this.timer = setInterval(() => void this.refresh(), Math.max(20, refreshMs));
    this.timer.unref?.();
  }

  /** The wait limit, in minutes (0: none). */
  get waitMinutes(): number {
    const n = Number(this.opts.waitMinutes ?? 30);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** `serve`'s broker on this machine; null (and a log line) when it is not answering; refused when it is another version. */
  static async connect(opts: RemoteEvalOptions & { serveUrl: string; token: string; deadlineMs?: number }): Promise<RemoteEval | null> {
    const queue = new ServeQueue(opts.serveUrl, opts.token, { scope: scopeOf(opts.scope ?? opts.run), deadlineMs: opts.deadlineMs });
    let status: QueueStatus;
    try {
      status = await queue.status(opts.run, true);
    } catch (err) {
      if (err instanceof ServeRefusedError) throw err;
      opts.log?.(`remote: ${opts.serveUrl} is not answering (${err instanceof Error ? err.message : err})`);
      return null;
    }
    const r = new RemoteEval(queue, opts);
    r.status = status;
    if (!status.offered) r.log('remote: serve does not offer evaluation work to remote workers (server.remote.offer.eval is off): only this run\'s own slots will take its pieces');
    if (!queue.durable) r.log('remote: serve on this machine is from before durable tasks (docs/design/32 stage 1): each piece is one request held open, and a restart of serve publishes them again');
    else if (queue.storeReason) r.log(`remote: serve keeps this run's tasks in memory only (${queue.storeReason}): a restart of serve publishes them again`);
    return r;
  }

  /** A broker in the run's own process: only the run's own slots lease from it. */
  static own(opts: RemoteEvalOptions & { source?: EvalSourceOptions }): RemoteEval {
    const r = new RemoteEval(new OwnQueue({ retryMs: 1_000, ...opts.source }), opts);
    void r.refresh();
    return r;
  }

  get run(): string {
    return this.opts.run;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get where(): 'serve' | 'own' {
    return this.queue.where;
  }

  /** The run's own slots, by CLI. */
  get localSlots(): Record<EvalFamily, number> {
    return { ...this.local };
  }

  hasLocal(family: EvalFamily): boolean {
    return this.local[family] > 0;
  }

  /**
   * Slots online that could take a piece of this kind, CLI and eligibility
   * from this run: the run's own (always), and the ones `serve` saw ask lately.
   */
  width(kind: EvalKind, family: EvalFamily, eligible: EvalEligible): number {
    if (this.abort.signal.aborted) return 0;
    // the run's own slots lease from the queue: while serve does not answer they can take nothing either
    const own = LOCAL_KINDS[family].includes(kind) && this.reachable ? this.local[family] : 0;
    const slots = this.queue.slotsNow?.() ?? this.status?.slots;
    const pool = this.pool;
    const others = (slots?.[kind] ?? []).filter((s) => s.family === family && !s.run && (!pool || s.pool === pool) && (eligible === 'any' || s.local));
    return own + others.length;
  }

  /** The pool every piece of the run requires, or null. */
  get pool(): string | null {
    return this.opts.pool || null;
  }

  /** The pool the run's own slots are in. */
  get localPool(): string {
    return this.opts.pool || 'local';
  }

  /** Start the run's own slots: they lease from the queue like a worker's, and run a piece with the run's backends. */
  startLocal(slots: Partial<Record<EvalFamily, number>>): void {
    for (const family of EVAL_FAMILIES) {
      const n = Math.max(0, Math.trunc(slots[family] ?? 0));
      for (let i = 1; i <= n; i++) {
        this.local[family]++;
        this.loops.push(this.slot({ name: `eval-${family}#${this.local[family]}`, family, run: this.run, pool: this.localPool }));
      }
    }
  }

  /**
   * Publish one piece and wait for what becomes of it. `exec` is how the
   * run's own slot does it; a worker does it from the spec.
   */
  async publish<T>(spec: Omit<EvalCallSpec, 'run' | 'key' | 'pool'> | Omit<EvalSessionSpec, 'run' | 'key' | 'pool'>, exec: () => Promise<T>, tag: PieceTag | null = currentPieceTag(), identity?: unknown): Promise<Published<T>> {
    if (this.abort.signal.aborted) throw new RunCancelledError();
    const key = this.keyOf(spec, tag, identity);
    const entry: Entry = { exec };
    this.entries.set(key, entry);
    this.counts.published++;
    const full = { ...spec, run: this.opts.run, key, pool: this.pool } as EvalSpec;
    const requirement: Requirement = { kind: spec.kind, family: spec.agent.family, model: spec.agent.model, eligible: spec.eligible, pool: this.pool };
    const release = this.hold(requirement);
    let again = 0;
    try {
      for (let backoff = this.opts.backoffMs ?? 1_000; ;) {
        this.poke();
        const o = await this.queue.publish(full, this.abort.signal);
        if (o.outcome !== 'unreachable') this.reachable = true;
        if (entry.done) {
          // one of the run's own slots did it (perhaps before serve went away): its result is the piece's
          this.counts.local++;
          return 'error' in entry.done ? { local: true, error: entry.done.error } : { local: true, value: entry.done.value as T };
        }
        if ((o.outcome === 'answered' || o.outcome === 'error') && o.local && again < 3) {
          // one of this run's own slots did it in a process before this one: the value went with that process, so it is asked again
          again++;
          continue;
        }
        if (o.outcome === 'answered' || o.outcome === 'error') {
          this.counts.workers++;
          // records name the machine, not the slot on it: `<token>/<worker>`
          return { local: false, outcome: { ...o, worker: machineOf(o.worker) } };
        }
        if (o.outcome === 'cancelled' || o.outcome === 'stopped' || this.abort.signal.aborted) throw this.stopped ?? new RunCancelledError();
        if (o.outcome === 'refused') throw this.stop(new ServeRefusedError('the piece', o.status, o.error));
        if (o.outcome === 'unreachable') {
          // one of the run's own slots is doing it: its result is the piece's, and it is not published again for a worker to run too
          if (entry.running) {
            await entry.running;
            const done = entry.done as unknown as { value: unknown } | { error: unknown };
            this.counts.local++;
            return 'error' in done ? { local: true, error: done.error } : { local: true, value: done.value as T };
          }
          // serve went away: the piece waits for it as it would for a slot, and is published again
          this.unreachable(o.error);
          await sleep(backoff, this.abort.signal);
          backoff = Math.min(15_000, backoff * 2);
          continue;
        }
        this.unreachableSaid = false;
        // three different workers could not serve it: reported, left unanswered, and the run goes on with the rest
        const piece: StuckPiece = {
          kind: spec.kind, label: spec.label, family: spec.agent.family, model: spec.agent.model, eligible: spec.eligible, pool: this.pool,
          system: tag?.system ?? null, task: tag?.task ?? null, workers: o.workers, lastError: o.lastError, at: new Date().toISOString(),
        };
        this.stuck.push(piece);
        const error = new PieceStuckError(piece);
        this.log(error.message);
        this.opts.onStuck?.(piece);
        throw error;
      }
    } finally {
      this.entries.delete(key);
      release();
    }
  }

  /**
   * A piece's key (docs/design/32 §5): what the piece is — the run's
   * directory, its kind, CLI, model, pool, label, the system and task it is
   * for (a repeat's task carries `~r<n>`), and its content (the prompt as the
   * caller has it, the schema, the folder's archive, the tools) — and how many
   * pieces just like it this process published before. A resumed run that asks
   * what its records lack, in the order it asks, finds the same keys: a piece
   * done while it was away is that result, not a second piece.
   */
  private keyOf(spec: Omit<EvalCallSpec, 'run' | 'key' | 'pool'> | Omit<EvalSessionSpec, 'run' | 'key' | 'pool'>, tag: PieceTag | null, identity: unknown): string {
    const content = spec.kind === 'eval-call'
      ? [spec.prompt, spec.schema ?? null]
      : [spec.prompt, spec.sandbox, spec.maxSteps, spec.archive?.sha256 ?? null, spec.mcp?.tools ?? null];
    const what = crypto.createHash('sha256').update(JSON.stringify([
      this.opts.scope ?? this.opts.run, spec.kind, spec.agent.family, spec.agent.model, spec.agent.effort ?? null, spec.agent.speed ?? null, spec.eligible,
      this.pool, spec.label, tag?.system ?? null, tag?.task ?? null, identity ?? null, content,
    ])).digest('base64url').slice(0, 40);
    const n = this.seen.get(what) ?? 0;
    this.seen.set(what, n + 1);
    return n ? `${what}-${n}` : what;
  }

  /** Pieces stuck since `since` (an index into `stuck`) for this system (and task, when given). */
  stuckFor(since: number, system: string, task?: string): StuckPiece[] {
    return this.stuck.slice(since).filter((p) => p.system === system && (task === undefined || p.task === task));
  }

  /** The run's own slots finish what they are doing (at most `ms`). */
  async drained(ms = 10_000): Promise<void> {
    await Promise.race([Promise.allSettled(this.loops), sleep(ms)]);
  }

  /**
   * A folder a worker's session reads, as an archive `serve` holds; null on
   * the run's own broker. While serve does not answer the upload waits, as a
   * piece does (and counts as one for the wait limit); a refusal stops the run.
   */
  async archive(dir: string, agent: { family: EvalFamily; model: string } = { family: 'codex', model: '' }): Promise<{ sha256: string; bytes: number } | null> {
    const release = this.hold({ kind: 'eval-session', family: agent.family, model: agent.model, eligible: 'any', pool: this.pool });
    try {
      for (let backoff = this.opts.backoffMs ?? 1_000; ;) {
        if (this.abort.signal.aborted) throw this.stopped ?? new RunCancelledError();
        try {
          const a = await this.queue.archive(dir, this.abort.signal);
          this.reachable = true;
          return a;
        } catch (err) {
          if (this.abort.signal.aborted) throw this.stopped ?? new RunCancelledError();
          if (err instanceof ServeRefusedError) throw this.stop(err);
          this.unreachable(err instanceof Error ? err.message : String(err));
          await sleep(backoff, this.abort.signal);
          backoff = Math.min(15_000, backoff * 2);
        }
      }
    } finally {
      release();
    }
  }

  /** Stop the run cleanly (once): pieces are withdrawn, nothing in flight is recorded. Returns the error to throw. */
  stop(why: RunStoppedError): RunStoppedError {
    if (this.stopped) return this.stopped;
    this.stopped = why;
    this.log(why.message);
    this.opts.onStop?.(why);
    void this.cancel();
    return why;
  }

  private unreachable(error: string): void {
    if (this.queue.where !== 'serve') return;
    this.reachable = false;
    if (!this.unreachableSaid) this.log(`remote: serve is not answering (${error}): pieces wait and are published again when it answers`);
    this.unreachableSaid = true;
  }

  /** Count a requirement as waiting, for the wait limit, until the returned function is called. */
  private hold(requirement: Requirement): () => void {
    const rk = requirementKey(requirement);
    const held = this.outstanding.get(rk) ?? { requirement, n: 0 };
    held.n++;
    this.outstanding.set(rk, held);
    return () => {
      if (--held.n <= 0) {
        this.outstanding.delete(rk);
        this.unmetSince.delete(rk);
      }
    };
  }

  /**
   * The run stops here (a signal, its wait limit, a refusal, its caller's
   * cancel): what only it can serve is withdrawn and session tokens die at
   * once; on a serve that keeps tasks the rest stays, and a resume collects
   * what workers finished meanwhile (docs/design/32 §5). Every call waits for
   * the one withdrawal, so a run that ends on its cancellation ends after the
   * tokens are revoked.
   */
  cancel(): Promise<void> {
    this.cancelling ??= (async () => {
      this.abort.abort();
      await (this.queue.detach ? this.queue.detach(this.opts.run) : this.queue.cancelRun(this.opts.run)).catch(() => {});
      this.close();
    })();
    return this.cancelling;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
    this.poke();
    this.queue.close();
  }

  /* ------------------------------ internals ------------------------------ */

  private async refresh(): Promise<void> {
    try {
      this.status = await this.queue.status(this.opts.run);
      this.reachable = true;
      this.unreachableSaid = false;
    } catch (err) {
      // serve refusing the run is no outage: the run stops with its word
      if (err instanceof ServeRefusedError) {
        this.stop(err);
        return;
      }
      // serve is not answering: nothing is online, the run's own slots included (they lease from it)
      if (this.status) this.status = { ...this.status, slots: { 'eval-call': [], 'eval-session': [] } };
      this.unreachable(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Waiting (docs/design/32 §3): a piece whose requirements no slot online
   * meets is logged once a minute with what it waits for; past the wait limit
   * the run stops cleanly. A piece some slot online could take waits for it
   * however long, as any work behind a busy slot does.
   */
  private checkWaiting(): void {
    if (this.abort.signal.aborted || !this.outstanding.size) return;
    const now = Date.now();
    const unmet: { requirement: Requirement; n: number; since: number }[] = [];
    for (const [rk, { requirement, n }] of this.outstanding) {
      if (this.width(requirement.kind, requirement.family, requirement.eligible) > 0) {
        this.unmetSince.delete(rk);
        continue;
      }
      const since = this.unmetSince.get(rk) ?? now;
      this.unmetSince.set(rk, since);
      unmet.push({ requirement, n, since });
    }
    if (unmet.length && now - this.lastWaitLog >= (this.opts.logEveryMs ?? 60_000)) {
      this.lastWaitLog = now;
      const limit = this.waitMinutes ? `; the run stops after ${this.waitMinutes} min` : '';
      for (const u of unmet) this.log(`waiting: ${u.n} piece(s) for ${describeRequirement(u.requirement)} — no slot online takes them (for ${Math.round((now - u.since) / 60_000)} min${limit})`);
    }
    const limitMs = this.waitMinutes * 60_000;
    const over = limitMs ? unmet.find((u) => now - u.since >= limitMs) : undefined;
    if (!over) return;
    this.stop(new WaitLimitError(over.requirement, this.waitMinutes));
  }

  /** Wake the run's own slots: a piece was published. */
  private poke(): void {
    this.wake?.();
    this.wake = null;
    this.wakeAt = null;
  }

  private idle(ms: number): Promise<void> {
    this.wakeAt ??= new Promise<void>((resolve) => (this.wake = resolve));
    return Promise.race([this.wakeAt, sleep(ms)]);
  }

  /** One of the run's own slots: lease, find the piece's work by its key, do it, hand back. */
  private async slot(who: LocalSlotIdentity): Promise<void> {
    const kinds = LOCAL_KINDS[who.family];
    while (!this.closed) {
      // this machine's plan, before the slot takes anything: a Codex slot never holds a lease while it waits for it
      if (who.family === 'codex') await this.opts.quota?.waitLocal({ cacheMs: 60_000 });
      if (this.closed || this.abort.signal.aborted) break;
      let task: WorkTask | undefined;
      try {
        task = (await this.queue.lease(who, kinds))[0];
      } catch (err) {
        if (err instanceof ServeRefusedError) {
          this.stop(err);
          break;
        }
        await this.idle(2_000);
        continue;
      }
      if (!task) {
        await this.idle(this.queue.where === 'own' ? 1_000 : 500);
        continue;
      }
      const key = 'key' in task ? task.key : '';
      const entry = this.entries.get(key);
      if (!entry) {
        // not one of this run's pieces any more (it settled meanwhile)
        await this.queue.release(who, [task.id]).catch(() => {});
        continue;
      }
      const renew = setInterval(() => void this.queue.renew(who, [task!.id]).catch(() => {}), Math.max(200, this.opts.renewMs ?? 20_000));
      renew.unref?.();
      try {
        // a piece whose lease lapsed while it ran (or that serve has again after a restart) is not run a second time
        await runOnce(entry);
        if (this.abort.signal.aborted) continue;
        const done = entry.done!;
        const outcome: LocalOutcome = 'error' in done && task.kind === 'eval-call'
          ? { ok: false, error: done.error instanceof Error ? done.error.message : String(done.error) }
          : { ok: true };
        await this.queue.complete(who, task.id, outcome).catch(() => {});
      } finally {
        clearInterval(renew);
      }
    }
  }
}

/** A pack's placement, carried along its async calls (src/eval/placement.ts): the queue, and whether its work may leave. */
export class PackScope {
  constructor(readonly remote: RemoteEval, readonly leaves: boolean, readonly calls: EvalEligible) {}

  /** Slots online for a build's or a system's model calls: what a knode build's passes may fill. */
  callSlots(): number {
    return this.remote.width('eval-call', 'codex', this.calls);
  }

  sessionSlots(eligible: EvalEligible): number {
    return this.remote.width('eval-session', 'codex', eligible);
  }
}

/** Every call of this piece of work stopped because the run was cancelled. */
export class RunCancelledError extends Error {
  readonly final = true;

  constructor() {
    super('the run was cancelled');
  }
}

/**
 * The shim's backend as published work: every model call is a piece, done by
 * a slot that leases it — the run's own (with `local`, the run's backend) or,
 * when the run names its model on its own Codex, a worker running exactly that
 * model, so the records stay on one backend (`codex-cli:<model>`).
 */
export class PublishedChatBackend implements ChatBackend {
  readonly selfLimiting = true;

  constructor(
    private readonly local: ChatBackend,
    private readonly remote: RemoteEval,
    private readonly agent: { model: string; speed?: string | null; eligible: EvalEligible },
  ) {}

  get label(): string {
    return this.local.label;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const tag = req.tag;
    const leaves = this.agent.eligible === 'any';
    const p = await this.remote.publish({
      kind: 'eval-call',
      eligible: this.agent.eligible,
      label: tag ? [tag.system, tag.stage, tag.task].filter(Boolean).join(' · ') : 'call',
      agent: { family: 'codex', model: this.agent.model, effort: effortFor('codex-cli', req.effort) ?? null, speed: this.agent.speed ?? null },
      // a piece only the run's own slots take carries nothing a worker would run
      prompt: leaves ? renderCliPrompt(req.messages, req.json) : '',
      schema: leaves ? req.schema ?? null : null,
      timeoutMs: 900_000,
    }, () => this.local.complete(req), tag ? { system: tag.system, ...(tag.task ? { task: tag.task } : {}) } : null, [tag?.stage ?? null, req.messages, req.json ?? null, req.schema ?? null, req.effort ?? null]);
    if (p.local) {
      if ('error' in p) throw p.error;
      return p.value;
    }
    const o = p.outcome;
    if (o.outcome === 'answered') return { text: o.text.trim(), usage: o.usage, model: o.model, worker: o.worker, backend: o.backend, ...(o.pool ? { pool: o.pool } : {}) };
    throw Object.assign(new Error(`codex exec failed on ${o.worker}: ${o.error}`), { usage: o.usage });
  }
}

/**
 * The judge's client as published work: its calls go to a slot of the judge's
 * CLI. Who answered is noted for the judge's meter (src/eval/placement.ts).
 */
export function remoteJudgeClient(client: LlmClient, remote: RemoteEval, judge: { family: EvalFamily; model: string; effort: string | null; eligible: EvalEligible; backend: string | null }): LlmClient {
  const publish = async <T>(messages: ChatMessage[], opts: { json?: boolean; onUsage?: (u: CallUsage) => void }, here: () => Promise<T>, fromText: (text: string) => T): Promise<T> => {
    const leaves = judge.eligible === 'any';
    const p = await remote.publish({
      kind: 'eval-call', eligible: judge.eligible, label: 'judge', agent: { family: judge.family, model: judge.model, effort: judge.effort, speed: null },
      prompt: leaves ? renderCliPrompt(messages, Boolean(opts.json)) : '', schema: null, timeoutMs: 600_000,
    }, here, { system: '__judge__' }, [messages, Boolean(opts.json)]);
    if (p.local) {
      if (judge.backend) notePlacement({ backend: judge.backend });
      if ('error' in p) throw p.error;
      return p.value;
    }
    const o = p.outcome;
    if (o.usage) opts.onUsage?.(o.usage);
    notePlacement({ worker: o.worker, backend: o.backend, ...(o.pool ? { pool: o.pool } : {}) });
    if (o.outcome === 'answered') return fromText(o.text);
    throw new Error(`${judge.family} CLI error on ${o.worker}: ${o.error}`);
  };
  const wrapped = Object.create(client) as LlmClient;
  // a real client's completeJson goes through complete; a stand-in that has only completeJson is published as it is
  if (typeof client.complete === 'function') {
    wrapped.complete = (messages, opts = {}) => publish(messages, opts, () => client.complete(messages, opts), (t) => t.trim());
  }
  if (typeof client.completeJson === 'function' && client.completeJson !== LlmClient.prototype.completeJson) {
    wrapped.completeJson = (<T>(messages: ChatMessage[], opts: Parameters<LlmClient['completeJson']>[1] = {}) =>
      publish<T>(messages, { ...opts, json: true }, () => client.completeJson<T>(messages, opts), (t) => jsonFromReply<T>(t))) as LlmClient['completeJson'];
  }
  return wrapped;
}

/** The CLI family a judge provider runs on, for its pieces' requirements: a chain or a stand-in is the run's own (Claude's slots). */
export function judgeFamily(provider: string): EvalFamily {
  return provider === 'codex-cli' ? 'codex' : 'claude';
}

/** The judge's family and model as a remote worker would run them, or null when its calls stay here. */
export function judgeAgent(provider: string, model: string, effort?: string): { family: EvalFamily; model: string; effort: string | null } | null {
  const family: EvalFamily | null = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : null;
  if (!family || !model.trim()) return null;
  return { family, model: model.trim(), effort: effortFor(provider, effort as never) ?? null };
}

/* ------------------------------ agent sessions ----------------------------- */

/**
 * One `runAgent` session as a published piece. It may go to a worker only
 * when its pack may leave, the run names its model, it reads (a session that
 * writes, the llm-wiki build, stays), its knode tools are the build's tool
 * host (a URL with its tools named) and it is not routed over an agent chain
 * (`leaves` false: those links are this machine's keys and logins); otherwise
 * it is published for this machine's slots only. `here` is how the run's own
 * slot runs it.
 */
export async function publishAgent(scope: PackScope, opts: AgentRunOptions, here: () => Promise<AgentRunResult>, leaves: boolean): Promise<AgentRunResult> {
  const remote = scope.remote;
  const toolsLeave = !opts.mcp || ('url' in opts.mcp && Boolean(opts.mcp.enabledTools?.length));
  const eligible: EvalEligible = leaves && scope.leaves && opts.sandbox === 'read-only' && Boolean(opts.model) && toolsLeave ? 'any' : 'local';
  const t0 = Date.now();
  let archive: { sha256: string; bytes: number } | null = null;
  let mcp: EvalSessionSpec['mcp'] = null;
  if (eligible === 'any') {
    const hasFiles = fs.existsSync(opts.cwd) && fs.readdirSync(opts.cwd).length > 0;
    archive = hasFiles ? await remote.archive(opts.cwd, { family: 'codex', model: opts.model ?? '' }) : null;
    mcp = opts.mcp && 'url' in opts.mcp ? { url: opts.mcp.url, secret: opts.mcp.token, tools: [...(opts.mcp.enabledTools ?? [])] } : null;
  }
  const p = await remote.publish({
    kind: 'eval-session',
    eligible,
    label: `agent${opts.label ? ` · ${opts.label}` : ''}`,
    agent: { family: 'codex', model: opts.model ?? '', effort: effortFor('codex-cli', opts.effort) ?? null, speed: null },
    sandbox: opts.sandbox,
    maxSteps: opts.maxSteps ?? 25,
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    prompt: eligible === 'any' ? opts.prompt : '',
    // a worker resumes a capped session with it; one from before stops the session there, which agentResultOf reads as before
    ...(eligible === 'any' && closingOf(opts) ? { closing: closingOf(opts) } : {}),
    archive,
    mcp,
  }, here, undefined, [opts.prompt, opts.sandbox, opts.maxSteps ?? 25, opts.label ?? null]);
  if (p.local) {
    if ('error' in p) throw p.error;
    return p.value;
  }
  const o = p.outcome;
  if (o.outcome !== 'answered' || !o.session) throw new Error(`the session failed on ${o.worker}: ${o.outcome === 'error' ? o.error : 'no session came back'}`);
  return { ...agentResultOf(o.session, opts, { worker: o.worker, backend: o.backend, usage: o.usage, ms: Date.now() - t0 }), ...(o.pool ? { pool: o.pool } : {}) };
}

/**
 * A worker's session parsed as `runAgentOnce` parses its own: the trace, the
 * step cap, the leak audit (with the worker's folder and home), the closing
 * turn. A worker from before the closing turn kills a capped session and
 * sends no turn after it: that reads as it always did, capped with what the
 * stop left and no usage (`closing: 'not-run'`).
 */
export function agentResultOf(s: EvalSessionAnswer, opts: AgentRunOptions, at: { worker: string; backend: string; usage: CallUsage | null; ms: number }): AgentRunResult {
  // the worker's folder stands for this one: its paths are read as the local copy's, everything else as the worker's home
  const rewrite = s.cwd ? (cmd: string) => cmd.split(s.cwd).join(opts.cwd) : (cmd: string) => cmd;
  const trace = new AgentTrace({ cwd: opts.cwd, maxSteps: opts.maxSteps ?? 25, allowRoots: opts.allowRoots, home: s.home || os.homedir(), rewrite });
  for (const line of s.stdout.split('\n')) trace.line(line);
  const capped = trace.capped || s.capped;
  // the closing turn is in the stream (the thread resumed); whatever it started voids its answer, whatever the worker said
  const closing: ClosingOutcome | undefined = !capped || !closingOf(opts) ? undefined
    : !trace.closing ? 'not-run' : trace.closingTools ? 'used-a-tool' : s.closing === 'answered' && (s.lastMessage ?? '').trim() ? 'answered' : 'no-answer';
  const text = capped && closing && closing !== 'answered' && closing !== 'not-run' ? '' : (s.lastMessage ?? '').trim();
  // a worker's session that ended on a signal (no exit code: -1; or 128 + the signal) with nothing to show: cancelled, asked again on resume
  const killed = !capped && !text && (s.exitCode === -1 || s.exitCode === 130 || s.exitCode === 137 || s.exitCode === 143);
  const error = killed ? `cancelled: the session on ${at.worker} was killed (exit ${s.exitCode})`
    : s.exitCode !== 0 && !capped ? `codex exec exited with ${s.exitCode} on ${at.worker}: ${readCodexEvents(s.stdout).error ?? s.stderr.slice(-300)}` : undefined;
  return {
    text,
    usage: at.usage ?? readCodexEvents(s.stdout).usage,
    commands: trace.commands,
    outputs: trace.outputs,
    toolCalls: trace.steps,
    capped,
    ...(closing ? { closing } : {}),
    leaked: [...new Set(trace.leaked)],
    filesTouched: [...trace.touched],
    ms: at.ms,
    worker: at.worker,
    backend: at.backend,
    ...(error && !text ? { error } : {}),
    ...(killed ? { cancelled: true } : {}),
  };
}

export type { EvalAgent };
