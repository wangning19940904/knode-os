import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyFailure, FailureKind } from '../labeling/failures.js';
import { CompleteResult, SessionAnswer, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import type { CallUsage } from '../llm/usage.js';
import { readCodexEvents } from '../llm/usage.js';
import { EvalAgent, EvalCallWorkTask, EvalSessionWorkTask, LeaseRequest, noFailures, SourceStatus, WorkSource, WorkTask } from './broker.js';
import { isArchiveId } from './eval-archive.js';
import { EvalStoreBusyError, EvalTaskStore } from './eval-store.js';
import type { EvalStoreOptions, StoredTask } from './eval-store.js';
import { isEvalKind } from './kinds.js';
import type { EvalKind, WorkKind } from './kinds.js';
import { tokenMatches } from '../digest.js';

/**
 * An evaluation run's model work as leased work (docs/design/27 §8).
 *
 * `knode-os eval run` stays a process of its own on this machine: it keeps
 * the run directory, the keyed records, resume, the quota guard and the
 * report. Only its model work leaves, and only through `serve`: the run offers
 * a piece over the loopback producer channel (src/remote/eval-producer.ts),
 * `serve` leases it to a worker through the same lease protocol, tokens and
 * audit as every other kind, and the outcome goes back to the run, which
 * meters and parses it as it would its own.
 *
 *   eval-call     one model call: the prompt as the CLI takes it on stdin, the
 *                 CLI family and model the run names, an optional output schema;
 *   eval-session  one agent session (`runAgent`, src/eval/agent.ts): the fields
 *                 the worker builds `codex exec` from, never argv (D9); a file
 *                 agent's folder as a content-addressed archive, an MCP agent's
 *                 tools through `…/eval-sessions/<id>/mcp` on a token of the
 *                 lease's own, proxied to the run's MCP bridge on this machine.
 *
 * The work is the server's, not a workspace's: one source per kind serves
 * every workspace's broker, and a worker leases it through whichever
 * workspace its token names (with the `eval` scope).
 *
 * The run only publishes (docs/design/32): a piece waits until a slot that
 * takes it leases it — a remote worker's, or one of the run's own on this
 * machine — and never comes back for the run to do itself. A worker's failure
 * is the worker's (D11): a usage limit, a lost login, a missing CLI, a lapsed
 * lease puts the piece back in line. A model's own error on a call (an answer
 * that is no answer) is the call's, and goes back as `error`, as the run's own
 * backend would throw it.
 */

export type EvalFamily = 'codex' | 'claude';
export const EVAL_FAMILIES: readonly EvalFamily[] = ['codex', 'claude'];

/** Where a piece may run (docs/design/32 §2): any slot that meets it, or only a slot on this machine. */
export type EvalEligible = 'any' | 'local';

export interface EvalCallSpec {
  kind: 'eval-call';
  /** The run's id, for cancelling and for Tasks. */
  run: string;
  /** The run's own key for the piece: its local slots find the piece's work by it. */
  key: string;
  /** `local`: leased only to a slot on this machine (a pack with private sources, a backend only the run has). */
  eligible: EvalEligible;
  /** Only a slot of this pool takes it (`eval run --pool`); null: any slot that meets `agent`. */
  pool: string | null;
  label: string;
  agent: EvalAgent;
  prompt: string;
  schema: unknown;
  timeoutMs: number;
}

export interface EvalSessionSpec {
  kind: 'eval-session';
  run: string;
  key: string;
  eligible: EvalEligible;
  pool: string | null;
  label: string;
  agent: EvalAgent;
  /** Only a read-only session may go to another machine; a run's own slots also run the llm-wiki builder's. */
  sandbox: 'read-only' | 'workspace-write';
  maxSteps: number;
  timeoutMs: number;
  prompt: string;
  /**
   * What the session is resumed with when it reaches `maxSteps` (src/eval/agent.ts CLOSING_TURN); absent or
   * null, a worker stops it with what it had. A spec from a run before the closing turn has none.
   */
  closing?: string | null;
  archive: { sha256: string; bytes: number } | null;
  /** The run's MCP bridge on this machine (never sent to a worker) and the tools it may call. */
  mcp: { url: string; secret: string; tools: string[] } | null;
}

export type EvalSpec = EvalCallSpec | EvalSessionSpec;

/** What a session hands back: its whole stdout (every renewal's and the last), parsed by the run. */
export interface EvalSessionAnswer {
  exitCode: number;
  stdout: string;
  stderr: string;
  lastMessage: string | null;
  capped: boolean;
  /** How a capped session's closing turn went on the worker; absent from a worker that has none (src/eval/agent.ts ClosingOutcome). */
  closing?: 'answered' | 'no-answer' | 'used-a-tool' | 'not-run';
  /** The worker's folder and home, for the leak audit. */
  cwd: string;
  home: string;
}

export type EvalOutcome =
  /** `local`: one of the run's own slots did it, and the value is in that run's process (docs/design/32 §12). */
  | { outcome: 'answered'; worker: string; backend: string; pool?: string | null; text: string; usage: CallUsage | null; model: string; session?: EvalSessionAnswer; local?: boolean }
  | { outcome: 'error'; worker: string; backend: string; pool?: string | null; error: string; usage: CallUsage | null; local?: boolean }
  /** Three different machines could not serve it (docs/design/32 §3): it is left unanswered, never answered another way. */
  | { outcome: 'stuck'; workers: string[]; lastError: string }
  | { outcome: 'cancelled' }
  | { outcome: 'stopped' };

/** What the MCP route may do for a session's token, while its lease lives. */
export interface EvalSessionBinding {
  run: string;
  label: string;
  worker: string;
  mcp: { url: string; secret: string; tools: string[] };
}

export interface EvalLeaseStatus {
  id: string;
  kind: EvalKind;
  class: 'eval';
  /** The pool the piece requires (null: any) and the one its slot is in. */
  pool: string | null;
  workerPool: string | null;
  worker: string;
  backend: string;
  remote: boolean;
  run: string;
  label: string;
  model: string;
  ageSeconds: number;
  expiresInSeconds: number;
}

/** A slot that asked for this kind lately, as a run reads it to know what could take its pieces. */
export interface EvalSlotSeen {
  worker: string;
  family: EvalFamily;
  /** On this machine: `serve`'s own or a run's (never a worker over /remote/v1). */
  local: boolean;
  /** A run's own slot takes only that run's pieces. */
  run: string | null;
  /** The pool its worker declared; null for a slot that declared none. */
  pool: string | null;
}

/** One run's pieces as the source holds them. */
export interface EvalRunStatus {
  waiting: number;
  leased: number;
}

/** A run's pieces of one kind as the Tasks view lists them: waiting, out, and finished results not yet collected. */
export interface EvalRunPieces {
  run: string;
  waiting: number;
  leased: number;
  /** Done (or stuck), its result kept until the run collects it. */
  uncollected: number;
  /** The oldest still waiting, in seconds. */
  oldestSeconds: number | null;
}

/** Where a source's pieces are kept (docs/design/32 §5). */
export interface EvalStoreStatus {
  /** In the root data folder, surviving a restart; false: in memory (another process holds the folder, or a run's own broker). */
  durable: boolean;
  /** Why not durable, when `serve` would be. */
  reason: string | null;
  tasks: number;
  bytes: number;
  maxBytes: number;
}

export interface EvalStatus extends SourceStatus {
  /** Published and waiting for a slot. */
  waiting: number;
  leases: EvalLeaseStatus[];
  totals: { offered: number; answered: number; stuck: number; failed: Record<FailureKind, number>; leasesExpired: number };
  /** By run: what waits, what is out, what is done and not collected. */
  runs: EvalRunPieces[];
  store: EvalStoreStatus | null;
}

/** What publishing a piece found: a task waiting or out, or the result the store kept for its key. */
export type EvalPublished =
  | { id: string; state: 'waiting' | 'leased'; outcome?: undefined }
  | { id: string; state: 'done'; outcome: EvalOutcome };

interface Pending {
  id: string;
  spec: EvalSpec;
  /** Who waits for what becomes of it (a held offer); a durable task may have no one. */
  listeners: Set<(outcome: EvalOutcome) => void>;
  publishedAt: number;
  /** When it is dropped if still waiting; a producer that polls pushes it on by `ttl`. */
  deadline: number;
  ttl: number;
  done: boolean;
  lease: string | null;
  strikes: number;
  /** The machines that could not serve it (`<token>/<worker>`, not their slots), and how often each. */
  failedBy: Map<string, number>;
  lastError: string;
  notBefore: number;
}

interface EvalLease {
  id: string;
  token: string | null;
  pending: Pending;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  deadline: number;
  output: string[];
  outputBytes: number;
}

export interface EvalSourceOptions {
  leaseMs?: number;
  retryMs?: number;
  /** Different machines that could not serve a piece before it is `stuck`, and failures by each machine online that make it so (default 3). */
  maxStrikes?: number;
  /** How long a slot that asked counts as online (default 2 min). */
  onlineMs?: number;
  /** Where published tasks and their results are kept (docs/design/32 §5); absent: nowhere but this object. */
  store?: EvalTaskStore | null;
  /** Whether a run's producer is attached (polled lately): a session that calls the run's tools waits for it. */
  present?: (run: string) => boolean;
  /** A task of a run was done, stuck or dropped. */
  onSettled?: (run: string, key: string) => void;
  log?: (msg: string) => void;
}

const DEFAULT_LEASE_MS = 120_000;
const RETRY_MS = 5_000;
const DEADLINE_GRACE_MS = 5 * 60_000;
/** A worker's bound on a session's closing turn (worker/knode-worker.mjs EVAL_CLOSING_MS), and a minute more. */
const CLOSING_GRACE_MS = 6 * 60_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const ONLINE_MS = 2 * 60_000;
/** Failures of one piece, on any machines, after which it is stuck whatever is online. */
const MAX_ATTEMPTS = 10;
/** How long a published task waits for a slot when its producer says nothing (pushed on each time it polls). */
export const DEFAULT_TASK_TTL_MS = 24 * 3_600_000;
const MAX_TASK_TTL_MS = 7 * 24 * 3_600_000;

/** A piece only its run can serve: its own slots' (eligible local), or a session that calls the run's tools. */
export function needsProducer(spec: EvalSpec): boolean {
  return spec.eligible === 'local' || (spec.kind === 'eval-session' && spec.mcp !== null);
}

const taskId = (run: string, key: string) => `${run}\u0000${key}`;

/**
 * Whether a slot may take a piece (docs/design/32 §2): its CLI (the model,
 * effort and speed the slot runs as the piece says, and a reply from another
 * model is the slot's failure), the piece's pool, a piece that must stay on
 * this machine only to a slot here, and a run's own slot only its run's pieces.
 */
export function takes(who: WorkerIdentity, family: EvalFamily, spec: EvalSpec): boolean {
  if (spec.agent.family !== family) return false;
  if (spec.pool && spec.pool !== who.pool) return false;
  if (spec.eligible === 'local' && who.remote) return false;
  if (who.run && spec.run !== who.run) return false;
  return true;
}

/** A slot's identity as a record keeps it: the machine (`<token>/<worker>`), not its slot (`…/eval-codex#2`). */
export function machineOf(worker: string): string {
  return worker.replace(/\/[^/]*#\d+$/, '');
}

/** The CLI family a worker's backend names ("codex", "claude:…"). */
export function evalFamilyOf(backend: string): EvalFamily | null {
  const family = backend.split(':')[0].trim().toLowerCase();
  return (EVAL_FAMILIES as readonly string[]).includes(family) ? (family as EvalFamily) : null;
}

/** The backend a piece ran on, as records keep it: the CLI and the model, whoever's account. */
export function evalBackend(agent: Pick<EvalAgent, 'family' | 'model'>): string {
  return `${agent.family}-cli:${agent.model || 'default'}`;
}

/** Why a session's answer is the worker's failure (D11), or null when it is a result, however poor. */
export function evalSessionFailure(answer: Pick<EvalSessionAnswer, 'exitCode' | 'stdout' | 'stderr' | 'capped'>): { kind: 'transient' | 'fatal'; message: string } | null {
  if (answer.capped || answer.exitCode === 0) return null;
  const message = readCodexEvents(answer.stdout).error ?? answer.stderr.trim().split('\n').slice(-3).join(' ').slice(-400);
  const kind = classifyFailure(message);
  return kind === 'model' ? null : { kind, message: message || `exit ${answer.exitCode}` };
}

export class EvalSource implements WorkSource {
  private readonly pending: Pending[] = [];
  /** The pieces not yet settled, by run and key: publishing a key again finds its task. */
  private readonly byKey = new Map<string, Pending>();
  private readonly store: EvalTaskStore | null;
  private readonly present: (run: string) => boolean;
  private readonly onSettled: (run: string, key: string) => void;
  private readonly leases = new Map<string, EvalLease>();
  /** Who asked for this kind lately: slot → what it is, the evaluation kinds it takes, and when. */
  private readonly asked = new Map<string, EvalSlotSeen & { kinds: EvalKind[]; at: number }>();
  /** This source and the other evaluation kind's: a slot online for one is online for each kind it takes. */
  private peers: EvalSource[] = [this];

  /** Share who is online between the sources of the two evaluation kinds. */
  static link(sources: EvalSource[]): void {
    for (const s of sources) s.peers = sources;
  }
  private readonly totals: EvalStatus['totals'] = { offered: 0, answered: 0, stuck: 0, failed: noFailures(), leasesExpired: 0 };
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly maxStrikes: number;
  private readonly onlineMs: number;
  private readonly log: (msg: string) => void;
  private sweeper: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(readonly kind: EvalKind, opts: EvalSourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.maxStrikes = Math.max(1, opts.maxStrikes ?? 3);
    this.onlineMs = Math.max(1, opts.onlineMs ?? ONLINE_MS);
    this.log = opts.log ?? (() => {});
    this.store = opts.store ?? null;
    this.present = opts.present ?? (() => true);
    this.onSettled = opts.onSettled ?? (() => {});
    // the tasks a store kept: waiting again, whatever lease they had (leases are not durable)
    if (this.store) {
      const now = Date.now();
      for (const t of this.store.waiting(kind)) this.add(t.spec!, { publishedAt: t.publishedAt, deadline: t.deadline, ttl: Math.max(1_000, Math.min(MAX_TASK_TTL_MS, t.deadline - t.publishedAt)) }, now);
      if (this.pending.length) this.startSweeper();
    }
  }

  /** Whether its tasks survive a restart. */
  get durable(): boolean {
    return this.store?.durable === true;
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** Slots of this CLI that asked for this kind within `withinMs`. */
  online(family: EvalFamily, withinMs = this.onlineMs): number {
    return this.slotsOnline(withinMs).filter((s) => s.family === family).length;
  }

  /** Every slot that asked for this kind within `withinMs`, or holds one of its leases now (a slot at work asks nothing). */
  slotsOnline(withinMs = this.onlineMs): EvalSlotSeen[] {
    const since = Date.now() - withinMs;
    // a slot asked of either source, or holds a lease of either, for every evaluation kind it takes
    const busy = new Set(this.peers.flatMap((p) => [...p.leases.values()].filter((l) => !l.pending.done).map((l) => l.who.worker)));
    const seen = new Map<string, EvalSlotSeen & { kinds: EvalKind[]; at: number }>();
    for (const p of this.peers) {
      for (const s of p.asked.values()) {
        const had = seen.get(s.worker);
        seen.set(s.worker, had ? { ...(had.at >= s.at ? had : s), kinds: [...new Set([...had.kinds, ...s.kinds])], at: Math.max(had.at, s.at) } : s);
      }
    }
    return [...seen.values()].filter((s) => s.kinds.includes(this.kind) && (s.at >= since || busy.has(s.worker))).map(({ at: _at, kinds: _kinds, ...s }) => s);
  }

  /** A slot asked for work it takes, `kinds` among it (the broker calls this for each kind a slot asks for). */
  noteAsked(who: WorkerIdentity, kinds: readonly WorkKind[] = [this.kind]): void {
    const family = evalFamilyOf(who.backend);
    if (!family) return;
    const evalKinds = kinds.filter(isEvalKind);
    this.asked.set(who.worker, { worker: who.worker, family, local: !who.remote, run: who.run ?? null, pool: who.pool ?? null, kinds: evalKinds.length ? evalKinds : [this.kind], at: Date.now() });
  }

  /** A run's pieces here: waiting for a slot, or out with one. */
  runStatus(run: string): EvalRunStatus {
    const mine = this.pending.filter((p) => !p.done && p.spec.run === run);
    return { waiting: mine.filter((p) => p.lease === null).length, leased: mine.filter((p) => p.lease !== null).length };
  }

  /**
   * Publish a piece by its run and key (docs/design/32 §2, §5). A key that is
   * waiting or out is that task (its spec takes the newer inputs, its deadline
   * the later one); a key the store holds a result for is that result, never a
   * second task — unless the result was a run's own slot's (its value lived in
   * that run's process), or the piece was stuck or dropped: then it waits again.
   * Throws `EvalStoreFullError` when the store is at its bound.
   */
  publish(spec: EvalSpec, opts: { deadline?: number; scope?: string | null } = {}): EvalPublished {
    const now = Date.now();
    const deadline = Math.min(now + MAX_TASK_TTL_MS, opts.deadline ?? now + DEFAULT_TASK_TTL_MS);
    const ttl = Math.max(1_000, deadline - now);
    const live = this.byKey.get(taskId(spec.run, spec.key));
    if (live) {
      // the same task, published again: a resumed run's tools endpoint, a later deadline
      live.spec = spec;
      live.ttl = ttl;
      live.deadline = Math.max(live.deadline, deadline);
      this.store?.update(spec.run, spec.key, { spec, deadline: live.deadline });
      return { id: live.id, state: live.lease ? 'leased' : 'waiting' };
    }
    if (this.closed) return { id: '', state: 'done', outcome: { outcome: 'stopped' } };
    if (this.store) {
      const had = this.store.get(spec.run, spec.key);
      if (had && had.kind !== spec.kind) throw new Error(`key ${spec.key} of run ${spec.run} is a task of ${had.kind}, not ${spec.kind}`);
      if (had?.state === 'done' && !had.local) {
        const outcome = this.store.result(spec.run, spec.key);
        if (outcome) {
          this.store.collected(spec.run, spec.key);
          return { id: had.key, state: 'done', outcome };
        }
      }
      this.store.ensureRoom(Buffer.byteLength(JSON.stringify(spec)));
      this.store.put(spec, { deadline, scope: opts.scope ?? null, now });
    }
    const p = this.add(spec, { publishedAt: now, deadline, ttl }, now);
    this.totals.offered++;
    this.startSweeper();
    return { id: p.id, state: 'waiting' };
  }

  /**
   * Publish a piece and wait for what becomes of it (the held offer of a run
   * from stage 1, and the run's own broker). It waits until a slot that takes
   * it leases it (D3); `signal` (the run went away) cancels it wherever it is.
   */
  offer(spec: EvalSpec, opts: { signal?: AbortSignal } = {}): { id: string; result: Promise<EvalOutcome>; cancel: () => void } {
    if (opts.signal?.aborted) return { id: '', result: Promise.resolve({ outcome: 'cancelled' }), cancel: () => {} };
    const r = this.publish(spec);
    if (r.state === 'done') return { id: r.id, result: Promise.resolve(r.outcome), cancel: () => {} };
    const p = this.byKey.get(taskId(spec.run, spec.key))!;
    let resolve: (o: EvalOutcome) => void = () => {};
    const result = new Promise<EvalOutcome>((res) => (resolve = res));
    const onAbort = () => this.settle(p, { outcome: 'cancelled' }, 'the run closed its offer');
    const listener = (o: EvalOutcome) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(o);
    };
    p.listeners.add(listener);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    return { id: p.id, result, cancel: () => this.settle(p, { outcome: 'cancelled' }, 'withdrawn') };
  }

  /** A task waiting or out now, by run and key (null: settled, or never published here). */
  live(run: string, key: string): 'waiting' | 'leased' | null {
    const p = this.byKey.get(taskId(run, key));
    return p && !p.done ? (p.lease ? 'leased' : 'waiting') : null;
  }

  /** Its producer asked after it: it is wanted for another `ttl`. */
  extend(run: string, key: string, now = Date.now()): void {
    const p = this.byKey.get(taskId(run, key));
    if (!p || p.done) return;
    const next = now + p.ttl;
    // the store's copy follows when it would otherwise run out within half the span (a restart reads it)
    if (this.store && p.deadline - now < p.ttl / 2) this.store.update(run, key, { deadline: next });
    p.deadline = Math.max(p.deadline, next);
  }

  /**
   * A run's producer went away (it stopped, was killed or waited its limit):
   * the pieces only it can serve are dropped — its own slots', and sessions
   * that call its tools, whose tokens end now. The rest stay: a worker may do
   * them, and their results wait for the run's resume.
   */
  detachRun(run: string): number {
    let n = 0;
    for (const p of [...this.pending]) {
      if (p.spec.run !== run || !needsProducer(p.spec)) continue;
      this.settle(p, { outcome: 'cancelled' }, 'its run went away');
      n++;
    }
    return n;
  }

  /** Cancel every piece of a run: its leases end at the next renewal and its session tokens now. */
  cancelRun(run: string, only?: (key: string) => boolean): number {
    let n = 0;
    for (const p of [...this.pending]) {
      if (p.spec.run !== run || (only && !only(p.spec.key))) continue;
      this.settle(p, { outcome: 'cancelled' }, 'its run was cancelled');
      n++;
    }
    return n;
  }

  /** Whether an archive belongs to a session offered or out now: only those may be downloaded. */
  wantsArchive(sha256: string): boolean {
    return this.pending.some((p) => !p.done && p.spec.kind === 'eval-session' && p.spec.archive?.sha256 === sha256);
  }

  async lease(who: WorkerIdentity, max = 1, request?: LeaseRequest): Promise<WorkTask[]> {
    if (this.closed || max < 1) return [];
    const family = evalFamilyOf(who.backend);
    if (!family) return [];
    this.noteAsked(who, request?.kinds ?? this.asked.get(who.worker)?.kinds ?? [this.kind]);
    this.sweep();
    const now = Date.now();
    // a machine that could not serve a piece gets it again only when nothing else waits for it
    // a session that calls its run's tools waits while its run is not attached (its bridge is gone with it)
    const open = this.pending.filter((x) => !x.done && x.lease === null && x.notBefore <= now && takes(who, family, x.spec)
      && (x.listeners.size > 0 || !(x.spec.kind === 'eval-session' && x.spec.mcp) || this.present(x.spec.run)));
    const machine = machineOf(who.worker);
    const p = open.find((x) => !x.failedBy.has(machine)) ?? open[0];
    if (!p) return [];
    const lease: EvalLease = {
      id: crypto.randomUUID(),
      token: p.spec.kind === 'eval-session' && p.spec.mcp ? `kes_${crypto.randomBytes(24).toString('base64url')}` : null,
      pending: p, who, issuedAt: now, expiresAt: now + this.leaseMs,
      // a session with a closing turn may take that turn's time beyond its own
      deadline: now + p.spec.timeoutMs + DEADLINE_GRACE_MS + (p.spec.kind === 'eval-session' && p.spec.closing ? CLOSING_GRACE_MS : 0),
      output: [], outputBytes: 0,
    };
    this.leases.set(lease.id, lease);
    p.lease = lease.id;
    this.log(`eval ${p.spec.kind === 'eval-call' ? 'call' : 'session'} ${p.spec.run} ${p.spec.label} → ${who.worker} (${evalBackend(p.spec.agent)})`);
    const base = {
      id: lease.id, label: `${p.spec.run} · ${p.spec.label}`.slice(0, 200), leaseExpiresAt: new Date(lease.expiresAt).toISOString(), run: p.spec.run, key: p.spec.key,
      agent: { ...p.spec.agent }, class: 'eval' as const, requires: { ...p.spec.agent }, pool: p.spec.pool, eligible: p.spec.eligible,
    };
    if (p.spec.kind === 'eval-call') {
      const task: EvalCallWorkTask = { ...base, kind: 'eval-call', prompt: p.spec.prompt, schema: p.spec.schema ?? null, timeoutMs: p.spec.timeoutMs };
      return [task];
    }
    const task: EvalSessionWorkTask = {
      ...base, kind: 'eval-session', sandbox: p.spec.sandbox, maxSteps: p.spec.maxSteps, timeoutMs: p.spec.timeoutMs, prompt: p.spec.prompt,
      ...(p.spec.closing ? { closing: p.spec.closing } : {}),
      archive: p.spec.archive ? { ...p.spec.archive } : null,
      mcp: p.spec.mcp && lease.token ? { token: lease.token, tools: [...p.spec.mcp.tools] } : null,
    };
    return [task];
  }

  /** What a presented session token opens, while its lease lives; null otherwise. */
  authorize(taskId: string, presented: string | null): EvalSessionBinding | null {
    if (!presented) return null;
    this.sweep();
    const lease = this.leases.get(taskId);
    if (!lease || !lease.token || lease.pending.done || lease.pending.lease !== lease.id) return null;
    if (!tokenMatches(presented, lease.token)) return null;
    const spec = lease.pending.spec;
    if (spec.kind !== 'eval-session' || !spec.mcp) return null;
    return { run: spec.run, label: spec.label, worker: lease.who.worker, mcp: { ...spec.mcp, tools: [...spec.mcp.tools] } };
  }

  /** Stdout a worker sent with a renewal, kept for the answer. */
  output(taskId: string, who: WorkerIdentity, text: string): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.who.worker !== who.worker || lease.pending.done || lease.pending.lease !== lease.id) return false;
    this.keep(lease, text);
    return true;
  }

  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult & { failure?: 'transient' | 'fatal' }> {
    const lease = this.leases.get(taskId);
    if (!lease) return { accepted: false, reason: 'unknown or expired lease' };
    if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
    this.leases.delete(taskId);
    const p = lease.pending;
    if (p.done) return { accepted: false, reason: 'the run no longer wants it' };
    if (p.lease !== lease.id) return { accepted: false, reason: 'it moved on' };
    p.lease = null;
    const now = Date.now();
    const backend = evalBackend(p.spec.agent);
    if (!outcome.ok) {
      // a worker that could not run the CLI at all, or whose account refused: back in line (D11)
      const kind = outcome.kind === 'transient' ? 'transient' : outcome.kind === 'fatal' || p.spec.kind === 'eval-session' ? 'fatal' : null;
      if (kind) {
        this.strike(p, kind, outcome.error || 'failed without a message', who.worker, now);
        return { accepted: true, failure: kind };
      }
      // the model's own failure on a call: the call's, as the run's own backend would throw it
      this.totals.answered++;
      this.settle(p, { outcome: 'error', worker: who.worker, backend, pool: who.pool ?? null, error: outcome.error || 'failed without a message', usage: outcome.usage ?? null, ...(who.run ? { local: true } : {}) });
      return { accepted: true };
    }
    if (outcome.model && outcome.model !== `${p.spec.agent.family}:${p.spec.agent.model}`) {
      // a worker that ran another model would mix backends silently
      this.strike(p, 'fatal', `${who.worker} ran ${outcome.model}, not ${p.spec.agent.family}:${p.spec.agent.model}`, who.worker, now);
      return { accepted: true, failure: 'fatal' };
    }
    if (p.spec.kind === 'eval-call') {
      this.totals.answered++;
      this.settle(p, { outcome: 'answered', worker: who.worker, backend, pool: who.pool ?? null, text: outcome.text, usage: outcome.usage ?? null, model: p.spec.agent.model, ...(who.run ? { local: true } : {}) });
      return { accepted: true };
    }
    const s: SessionAnswer = outcome.session ?? { exitCode: 0, output: outcome.text ?? '', stderr: '', lastMessage: null };
    this.keep(lease, s.output);
    const answer: EvalSessionAnswer = {
      exitCode: s.exitCode, stdout: lease.output.join(''), stderr: s.stderr, lastMessage: s.lastMessage,
      capped: s.capped === true, ...(s.capped === true && s.closing ? { closing: s.closing } : {}), cwd: s.cwd ?? '', home: s.home ?? '',
    };
    const failure = evalSessionFailure(answer);
    if (failure) {
      this.strike(p, failure.kind, failure.message, who.worker, now);
      return { accepted: true, failure: failure.kind };
    }
    this.totals.answered++;
    this.settle(p, { outcome: 'answered', worker: who.worker, backend, pool: who.pool ?? null, text: answer.lastMessage ?? '', usage: outcome.usage ?? readCodexEvents(answer.stdout).usage, model: p.spec.agent.model, session: answer, ...(who.run ? { local: true } : {}) });
    return { accepted: true };
  }

  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    this.sweep();
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.pending.done && lease.pending.lease === id && lease.who.worker === who.worker && now < lease.deadline) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else lost.push(id);
    }
    return { renewed, lost };
  }

  /** A worker shutting down hands its pieces back: straight back in line, no strike. */
  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    let n = 0;
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (!lease || lease.who.worker !== who.worker) continue;
      this.leases.delete(id);
      if (lease.pending.lease === id) lease.pending.lease = null;
      n++;
    }
    return n;
  }

  async status(): Promise<EvalStatus> {
    this.sweep();
    const now = Date.now();
    const runs = new Map<string, EvalRunPieces>();
    const row = (run: string) => {
      let r = runs.get(run);
      if (!r) runs.set(run, (r = { run, waiting: 0, leased: 0, uncollected: 0, oldestSeconds: null }));
      return r;
    };
    for (const p of this.pending) {
      const r = row(p.spec.run);
      if (p.lease) r.leased++;
      else {
        r.waiting++;
        const age = Math.round((now - p.publishedAt) / 1000);
        r.oldestSeconds = Math.max(r.oldestSeconds ?? 0, age);
      }
    }
    if (this.store) {
      for (const run of this.store.runIds) {
        for (const t of this.store.ofRun(run)) if (t.kind === this.kind && (t.state === 'done' || t.state === 'stuck') && t.collectedAt === null && !t.local) row(run).uncollected++;
      }
    }
    return {
      runs: [...runs.values()].sort((a, b) => a.run.localeCompare(b.run)),
      store: this.store ? { durable: this.store.durable, reason: null, ...this.store.usage() } : null,
      waiting: this.pending.filter((p) => p.lease === null).length,
      leases: [...this.leases.values()].map((l) => ({
        id: l.id, kind: this.kind, class: 'eval' as const, pool: l.pending.spec.pool, workerPool: l.who.pool ?? null, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote,
        run: l.pending.spec.run, label: l.pending.spec.label, model: evalBackend(l.pending.spec.agent),
        ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
    };
  }

  /** A workspace's broker stopping does not stop the server's eval work: `close` does, when `serve` stops. */
  async stop(): Promise<void> {}

  /** No new leases; every offer ends `stopped` and every token is dropped. A durable task stays waiting in its store. */
  close(): void {
    this.closed = true;
    for (const p of [...this.pending]) this.settle(p, { outcome: 'stopped' });
    this.leases.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /* ------------------------------ internals ------------------------------ */

  private add(spec: EvalSpec, at: { publishedAt: number; deadline: number; ttl: number }, _now: number): Pending {
    const p: Pending = {
      id: `e_${crypto.randomBytes(6).toString('hex')}`, spec, listeners: new Set(), publishedAt: at.publishedAt, deadline: at.deadline, ttl: at.ttl,
      done: false, lease: null, strikes: 0, failedBy: new Map(), lastError: '', notBefore: 0,
    };
    this.pending.push(p);
    this.byKey.set(taskId(spec.run, spec.key), p);
    return p;
  }

  /**
   * What became of a piece: kept in the store (a result, or why it was
   * dropped), told to whoever waits for it. `stopped` (`serve` stopping)
   * leaves a durable task waiting where it is kept.
   */
  private settle(p: Pending, outcome: EvalOutcome, why = 'cancelled'): void {
    if (p.done) return;
    p.done = true;
    const at = this.pending.indexOf(p);
    if (at !== -1) this.pending.splice(at, 1);
    const id = taskId(p.spec.run, p.spec.key);
    if (this.byKey.get(id) === p) this.byKey.delete(id);
    if (p.lease) this.leases.delete(p.lease);
    p.lease = null;
    if (this.store) {
      if (outcome.outcome === 'answered' || outcome.outcome === 'error' || outcome.outcome === 'stuck') {
        this.store.finish(p.spec.run, p.spec.key, outcome, { local: 'local' in outcome && outcome.local === true });
      } else if (outcome.outcome === 'cancelled') this.store.drop(p.spec.run, p.spec.key, why);
      // a held offer had its answer: collected
      if (p.listeners.size && outcome.outcome !== 'cancelled' && outcome.outcome !== 'stopped') this.store.collected(p.spec.run, p.spec.key);
    }
    for (const l of p.listeners) l(outcome);
    p.listeners.clear();
    if (outcome.outcome !== 'stopped') this.onSettled(p.spec.run, p.spec.key);
  }

  private keep(lease: EvalLease, text: string): void {
    if (!text || lease.outputBytes >= MAX_STDOUT_BYTES) return;
    lease.output.push(text);
    lease.outputBytes += Buffer.byteLength(text);
  }

  private strike(p: Pending, kind: 'transient' | 'fatal', error: string, worker: string, now: number): void {
    this.totals.failed[kind]++;
    p.strikes++;
    p.lastError = error;
    const machine = machineOf(worker);
    p.failedBy.set(machine, (p.failedBy.get(machine) ?? 0) + 1);
    this.log(`eval ${p.spec.run} ${p.spec.label}: ${worker} could not serve it (${kind}; ${p.strikes} failure(s) on ${p.failedBy.size} machine(s)): ${error.slice(0, 240)}`);
    if (this.isStuck(p)) {
      // left for the run to report, never answered another way
      this.totals.stuck++;
      this.settle(p, { outcome: 'stuck', workers: [...p.failedBy.keys()], lastError: error });
      return;
    }
    p.notBefore = now + this.retryMs;
  }

  /**
   * When a piece is stuck (docs/design/32 §3): three different machines could
   * not serve it; or every machine online that takes it has failed it three
   * times (two judge workers, one machine with ten slots); or it failed ten
   * times in all, however the machines online came and went.
   */
  private isStuck(p: Pending): boolean {
    if (p.failedBy.size >= this.maxStrikes) return true;
    if (p.strikes >= MAX_ATTEMPTS) return true;
    const able = new Set(this.slotsOnline()
      .filter((s) => takes({ worker: s.worker, backend: s.family, remote: !s.local, run: s.run ?? undefined, pool: s.pool ?? undefined }, s.family, p.spec))
      .map((s) => machineOf(s.worker)));
    return able.size > 0 && [...able].every((m) => (p.failedBy.get(m) ?? 0) >= this.maxStrikes);
  }

  /** Lapsed leases go back in line with a strike; a task still waiting at its deadline is dropped, never run. */
  private sweep(): void {
    const now = Date.now();
    for (const p of [...this.pending]) {
      if (!p.done && p.lease === null && p.listeners.size === 0 && p.deadline <= now) {
        this.log(`eval ${p.spec.run} ${p.spec.label}: dropped at its deadline, never run`);
        this.settle(p, { outcome: 'cancelled' }, 'its deadline passed');
      }
    }
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt > now && lease.deadline > now) continue;
      this.leases.delete(lease.id);
      this.totals.leasesExpired++;
      const p = lease.pending;
      if (p.done || p.lease !== lease.id) continue;
      p.lease = null;
      // a run's own slot is the run's backend, not a worker: its lapse is no strike against the piece
      if (lease.who.run) continue;
      this.strike(p, 'transient', `${lease.who.worker} ${lease.deadline <= now ? 'outran its timeout' : 'stopped renewing its lease'}`, lease.who.worker, now);
    }
    if (this.pending.length === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 500);
    this.sweeper.unref?.();
  }
}

/**
 * The archives eval sessions read (src/work/eval-archive.ts), kept by id in
 * `<data root>/.knode/eval-archives/`. A run uploads one before it offers the
 * session that needs it; a worker downloads it only while such a session is
 * offered or out. Archives no session has needed for a day are removed.
 */
export class EvalArchives {
  readonly dir: string;
  private readonly used = new Map<string, number>();

  /** An archive a task still waiting or out needs: kept however old (a durable task can wait for days). */
  inUse: (sha256: string) => boolean = () => false;

  constructor(rootDataDir: string, private readonly keepMs = 24 * 3_600_000) {
    this.dir = path.join(rootDataDir, '.knode', 'eval-archives');
  }

  file(sha256: string): string | null {
    if (!isArchiveId(sha256)) return null;
    const f = path.join(this.dir, `${sha256}.kpa`);
    return fs.existsSync(f) ? f : null;
  }

  touch(sha256: string): void {
    this.used.set(sha256, Date.now());
  }

  /** Store an upload, checked against its id; old ones go. */
  async put(sha256: string, gzip: Buffer, check: (gzip: Buffer, sha256: string) => unknown): Promise<void> {
    if (!isArchiveId(sha256)) throw new Error('an archive id is a SHA-256 in hex');
    check(gzip, sha256);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.${sha256}.${process.pid}.${crypto.randomUUID()}.part`);
    fs.writeFileSync(tmp, gzip, { mode: 0o600 });
    fs.renameSync(tmp, path.join(this.dir, `${sha256}.kpa`));
    this.touch(sha256);
    this.prune();
  }

  prune(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const f = path.join(this.dir, name);
      try {
        const sha = name.replace(/\.kpa$/, '');
        if (this.inUse(sha)) continue;
        const last = Math.max(this.used.get(sha) ?? 0, fs.statSync(f).mtimeMs);
        if (now - last > this.keepMs) fs.rmSync(f, { force: true });
      } catch {
        // gone already
      }
    }
  }
}

/** What a producer's poll finds for its keys (docs/design/32 §5). */
export interface EvalCollected {
  /** Done, stuck or dropped (as `cancelled`): what became of it. */
  done: { key: string; outcome: EvalOutcome }[];
  waiting: string[];
  leased: string[];
  /** Not here at all (a `serve` that lost it, or never had it): the producer publishes it again. */
  missing: string[];
}

export interface EvalWorkOptions extends EvalSourceOptions {
  sessionLeaseMs?: number;
  /**
   * Keep tasks and results in the root data folder (docs/design/32 §5;
   * default on). False: in memory only. When another process holds the
   * folder the work is kept in memory and `storeReason` says why.
   */
  durable?: boolean | EvalStoreOptions;
  /** How long a run's producer counts as attached after it last polled (default 60 s). */
  presentMs?: number;
}

const PRESENT_MS = 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;

/** `serve`'s evaluation work: one source per kind for every workspace's broker, the store, and the archives. */
export class EvalWork {
  readonly calls: EvalSource;
  readonly sessions: EvalSource;
  readonly archives: EvalArchives;
  readonly store: EvalTaskStore;
  /** Why the store is in memory when it was asked to be durable (another process holds the folder). */
  readonly storeReason: string | null;
  private readonly seen = new Map<string, number>();
  private readonly presentMs: number;
  private readonly waiters = new Set<{ run: string; keys: Set<string>; wake: () => void }>();
  private pruner: NodeJS.Timeout | null = null;

  constructor(rootDataDir: string, opts: EvalWorkOptions = {}) {
    const log = opts.log ?? (() => {});
    const storeOpts: EvalStoreOptions = { log, ...(typeof opts.durable === 'object' ? opts.durable : {}) };
    let store: EvalTaskStore;
    let reason: string | null = null;
    if (opts.durable === false) store = EvalTaskStore.memory(storeOpts);
    else {
      try {
        store = EvalTaskStore.open(rootDataDir, storeOpts);
      } catch (err) {
        if (!(err instanceof EvalStoreBusyError)) throw err;
        // two serve processes on one data root: the second never touches the first's tasks
        reason = err.message;
        log(reason);
        store = EvalTaskStore.memory(storeOpts);
      }
    }
    this.store = store;
    this.storeReason = reason;
    this.presentMs = opts.presentMs ?? PRESENT_MS;
    const shared: EvalSourceOptions = {
      ...opts, store,
      present: (run) => now() - (this.seen.get(run) ?? -Infinity) < this.presentMs,
      onSettled: (run, key) => {
        for (const w of [...this.waiters]) if (w.run === run && w.keys.has(key)) w.wake();
      },
    };
    const now = () => Date.now();
    this.calls = new EvalSource('eval-call', shared);
    this.sessions = new EvalSource('eval-session', { ...shared, leaseMs: opts.sessionLeaseMs ?? opts.leaseMs });
    EvalSource.link([this.calls, this.sessions]);
    this.archives = new EvalArchives(rootDataDir);
    this.archives.inUse = (sha) => this.sessions.wantsArchive(sha);
    this.pruner = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    this.pruner.unref?.();
  }

  get sources(): EvalSource[] {
    return [this.calls, this.sessions];
  }

  source(kind: EvalKind): EvalSource {
    return kind === 'eval-call' ? this.calls : this.sessions;
  }

  /** Where the tasks are kept, as `/eval/v1/status` and the Tasks view say it. */
  storeStatus(): EvalStoreStatus {
    return { durable: this.store.durable, reason: this.storeReason, ...this.store.usage() };
  }

  /** A run's producer is attached: it published or polled now. */
  attach(run: string): void {
    this.seen.set(run, Date.now());
  }

  /** Publish a batch of a run's pieces; each answer is its task's state or its stored result. */
  publish(specs: EvalSpec[], opts: { deadline?: number; scope?: string | null } = {}): { key: string; published: EvalPublished }[] {
    return specs.map((spec) => ({ key: spec.key, published: this.source(spec.kind).publish(spec, opts) }));
  }

  /** What became of a run's pieces by key; those still waiting or out are wanted for another while. */
  collect(run: string, keys: string[]): EvalCollected {
    const r: EvalCollected = { done: [], waiting: [], leased: [], missing: [] };
    const now = Date.now();
    for (const key of keys) {
      const live = this.calls.live(run, key) ? this.calls : this.sessions.live(run, key) ? this.sessions : null;
      if (live) {
        (live.live(run, key) === 'leased' ? r.leased : r.waiting).push(key);
        live.extend(run, key, now);
        continue;
      }
      const t: StoredTask | undefined = this.store.get(run, key);
      if (!t) r.missing.push(key);
      else if (t.state === 'dropped') r.done.push({ key, outcome: { outcome: 'cancelled' } });
      else if (t.state === 'waiting') r.missing.push(key);
      else {
        const outcome = this.store.result(run, key);
        if (!outcome) r.missing.push(key);
        else {
          this.store.collected(run, key, now);
          r.done.push({ key, outcome });
        }
      }
    }
    return r;
  }

  /** Wait (at most `ms`) until one of these keys of a run is done, stuck or dropped. */
  settled(run: string, keys: string[], ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const w = { run, keys: new Set(keys), wake: () => finish() };
      const timer = setTimeout(() => finish(), Math.max(0, ms));
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(w);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.waiters.add(w);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  /** The run went away: what only it can serve is dropped, the rest stays for its resume. */
  detachRun(run: string): number {
    this.seen.delete(run);
    return this.calls.detachRun(run) + this.sessions.detachRun(run);
  }

  cancelRun(run: string): number {
    return this.calls.cancelRun(run) + this.sessions.cancelRun(run);
  }

  /** A run dropped (`eval drop`): its pieces cancelled, its tasks and results removed (of its scope, when given). */
  dropRun(run: string, scope?: string | null): number {
    // a task of another scope (another run directory of the same name) is not this run's
    const mine = (key: string) => !scope || !this.store.get(run, key)?.scope || this.store.get(run, key)?.scope === scope;
    this.calls.cancelRun(run, mine);
    this.sessions.cancelRun(run, mine);
    if (!scope) this.seen.delete(run);
    return this.store.removeRun(run, scope);
  }

  /** Results and finished tasks by age (the store says how old), and archives nothing needs. */
  prune(now = Date.now()): number {
    const n = this.store.prune(now);
    this.archives.prune();
    return n;
  }

  close(): void {
    this.calls.close();
    this.sessions.close();
    for (const w of [...this.waiters]) w.wake();
    if (this.pruner) clearInterval(this.pruner);
    this.pruner = null;
    this.store.close();
  }
}
