import { Context, Hono } from 'hono';
import type { KnodeConfig } from '../config.js';
import { clientInfo } from '../server/public-guard.js';
import type { EvalAgent } from '../work/broker.js';
import { readArchive } from '../work/eval-archive.js';
import type { FailureKind } from '../labeling/failures.js';
import type { TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { DEFAULT_TASK_TTL_MS, EVAL_FAMILIES, EvalFamily, EvalRunStatus, EvalSpec, EvalWork } from '../work/eval.js';
import { EvalStoreFullError } from '../work/eval-store.js';
import { isEvalKind } from '../work/kinds.js';
import { offeredRemotely } from '../work/config.js';
import { tokenMatches } from '../digest.js';

/**
 * The producer channel of evaluation work (docs/design/27 §8): how a
 * `knode-os eval run` on this machine offers its model work to remote workers
 * through `serve`, and gets the outcome back.
 *
 *   GET  /eval/v1/status[?run=<id>]      whether eval work is offered to remote workers, the slots online per kind
 *                                        (each with its CLI, whether it is on this machine and whose run it serves),
 *                                        the run's pieces waiting and out, and `tasks`: where tasks are kept
 *                                        (docs/design/32 §5; a serve from stage 1 has no `tasks`)
 *   POST /eval/v1/tasks                  {run, scope?, deadlineMs?, specs: [...]}: publish a batch (at most 200);
 *                                        each answer is its task's state, or the result kept for its key
 *   POST /eval/v1/tasks/poll             {run, keys, waitMs?}: what became of them, held (at most 25 s) until
 *                                        one is done; keys serve does not have come back as `missing`
 *   POST /eval/v1/runs/<run>/detach      the run went away: what only it can serve is dropped, the rest stays
 *   DELETE /eval/v1/runs/<run>[?scope=]  `eval drop`: every task and result of the run removed
 *   POST /eval/v1/offer                  stage 1's held offer, kept for a run from before stage 2: {spec},
 *                                        held open (whitespace every 10 s) until the piece is answered, stuck
 *                                        or cancelled; closing it cancels the piece
 *   HEAD|PUT /eval/v1/archives/<sha256>  a file agent's folder (src/work/eval-archive.ts), before its session is offered
 *   POST /eval/v1/runs/<run>/cancel      every piece of a run: leases end at the next renewal, session tokens now
 *   POST /eval/v1/slots/lease|complete|renew|release
 *                                        a run's own slots on this machine (`eval run --local`, docs/design/32 §3):
 *                                        the same lease protocol as a worker's, bound to their run
 *
 * This machine only, as `/mcp` is: a request from anywhere else gets a 404,
 * and every request carries the data root's MCP token (`.knode/mcp-token`),
 * which only this machine's own clients can read.
 */

const KEEPALIVE_MS = 10_000;
const MAX_BATCH = 200;
const MAX_POLL_KEYS = 5_000;
const MAX_POLL_MS = 25_000;
/** The protocol of `/eval/v1/tasks` (docs/design/32 §5): a run that finds no `tasks.version` in status uses `/offer`. */
export const EVAL_TASKS_VERSION = 2;
const MAX_ARCHIVE_UPLOAD = 1024 ** 3;
const MAX_TIMEOUT_MS = 6 * 3_600_000;

export interface EvalProducerDeps {
  work: EvalWork;
  /** The data root's MCP token. */
  token: string;
  /** The server's settings (eval work is the server's, not a workspace's). */
  config: () => KnodeConfig;
  log?: (msg: string) => void;
}

class BadSpec extends Error {}

const text = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]=,-]{0,119}$/;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;

function agentOf(v: unknown): EvalAgent {
  const a = (v ?? {}) as Record<string, unknown>;
  const family = String(a.family ?? '') as EvalFamily;
  if (!EVAL_FAMILIES.includes(family)) throw new BadSpec(`agent.family must be ${EVAL_FAMILIES.join(' or ')}`);
  const model = String(a.model ?? '');
  // a run offers only work whose model it names: another machine's CLI default may be another model
  if (!MODEL_RE.test(model)) throw new BadSpec('agent.model must name a model');
  const effort = a.effort == null ? null : String(a.effort);
  if (effort !== null && !EFFORTS.has(effort)) throw new BadSpec(`unknown effort "${effort}"`);
  const speed = a.speed == null ? null : String(a.speed);
  if (speed !== null && !/^[a-z][a-z0-9_-]{0,30}$/.test(speed)) throw new BadSpec('agent.speed is not one');
  return { family, model, effort, speed };
}

const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A pool's name (docs/design/32 §2): a worker's `--pool`, a token's name, or `local`. */
export const POOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A spec as the run sent it, checked field by field. */
export function evalSpecOf(body: Record<string, unknown>): EvalSpec {
  const s = (body.spec ?? {}) as Record<string, unknown>;
  const run = text(s.run, 120);
  if (!RUN_RE.test(run)) throw new BadSpec('spec.run must be a run id');
  const key = text(s.key, 64);
  if (!KEY_RE.test(key)) throw new BadSpec('spec.key must be the run\'s key for the piece');
  const eligible = s.eligible === 'local' ? 'local' : 'any';
  const pool = s.pool == null || s.pool === '' ? null : text(s.pool, 64);
  if (pool !== null && !POOL_RE.test(pool)) throw new BadSpec('spec.pool must name a pool');
  const label = text(s.label, 300);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(Number(s.timeoutMs) || 15 * 60_000)));
  if (eligible === 'local') {
    // only the run's own slots take it, and they run it from the run's own copy: nothing here is executed
    const agent = agentOf({ ...(s.agent as object ?? {}), model: String((s.agent as Record<string, unknown> | undefined)?.model ?? '') || 'default' });
    if (s.kind === 'eval-call') return { kind: 'eval-call', run, key, eligible, pool, label, agent, prompt: '', schema: null, timeoutMs };
    if (s.kind !== 'eval-session') throw new BadSpec('spec.kind must be eval-call or eval-session');
    return { kind: 'eval-session', run, key, eligible, pool, label, agent, sandbox: s.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only', maxSteps: 1, timeoutMs, prompt: '', archive: null, mcp: null };
  }
  const agent = agentOf(s.agent);
  if (typeof s.prompt !== 'string' || !s.prompt.trim()) throw new BadSpec('spec.prompt required');
  if (s.kind === 'eval-call') {
    return { kind: 'eval-call', run, key, eligible, pool, label, agent, prompt: s.prompt, schema: s.schema ?? null, timeoutMs };
  }
  if (s.kind !== 'eval-session') throw new BadSpec('spec.kind must be eval-call or eval-session');
  if (agent.family !== 'codex') throw new BadSpec('eval sessions run on codex');
  if (s.sandbox !== 'read-only') throw new BadSpec('only read-only sessions leave this machine');
  const maxSteps = Math.trunc(Number(s.maxSteps));
  if (!(maxSteps >= 1 && maxSteps <= 1000)) throw new BadSpec('spec.maxSteps out of range');
  const a = s.archive as Record<string, unknown> | null | undefined;
  const archive = a ? { sha256: text(a.sha256, 64), bytes: Math.max(0, Math.trunc(Number(a.bytes) || 0)) } : null;
  if (archive && !/^[0-9a-f]{64}$/.test(archive.sha256)) throw new BadSpec('spec.archive.sha256 must be a SHA-256');
  const m = s.mcp as Record<string, unknown> | null | undefined;
  let mcp: { url: string; secret: string; tools: string[] } | null = null;
  if (m) {
    const url = text(m.url, 300);
    // the bridge is the run's, on this machine: never anywhere else
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/_-]*$/.test(url)) throw new BadSpec('spec.mcp.url must be a loopback http URL');
    const tools = Array.isArray(m.tools) ? m.tools.map(String) : [];
    if (!tools.length || tools.length > 64 || !tools.every((t) => TOOL_RE.test(t))) throw new BadSpec('spec.mcp.tools must name the tools');
    const secret = text(m.secret, 200);
    if (secret.length < 16) throw new BadSpec('spec.mcp.secret required');
    mcp = { url, secret, tools };
  }
  // the closing turn's wording, the same for every arm (src/eval/agent.ts CLOSING_TURN); a run from before sends none
  const closing = typeof s.closing === 'string' && s.closing.trim() ? text(s.closing, 2000) : null;
  return { kind: 'eval-session', run, key, eligible, pool, label, agent, sandbox: 'read-only', maxSteps, timeoutMs, prompt: s.prompt, ...(closing ? { closing } : {}), archive, mcp };
}

/** A run's pieces in both sources. */
export function runStatusOf(work: EvalWork, run: string): EvalRunStatus {
  const a = work.calls.runStatus(run);
  const b = work.sessions.runStatus(run);
  return { waiting: a.waiting + b.waiting, leased: a.leased + b.leased };
}

export function mountEvalProducer(app: Hono<any>, deps: EvalProducerDeps): void {
  const log = deps.log ?? (() => {});
  const api = new Hono();

  api.use('*', async (c, next) => {
    if (!clientInfo(c).local) return c.json({ error: 'not found' }, 404);
    const presented = /^bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null;
    if (!tokenMatches(presented, deps.token)) return c.json({ error: 'eval: missing or invalid bearer token (the data root\'s .knode/mcp-token)' }, 401);
    await next();
  });
  // the store at its bound is serve's to say plainly: 507, and the run stops with it
  api.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, err instanceof BadSpec ? 400 : err instanceof EvalStoreFullError ? 507 : 500));

  const offered = () => offeredRemotely(deps.config(), 'eval-call');

  api.get('/status', (c) => {
    const run = c.req.query('run');
    if (run && RUN_RE.test(run)) deps.work.attach(run);
    return c.json({
      tasks: { version: EVAL_TASKS_VERSION, ...deps.work.storeStatus() },
      offered: offered(),
      online: {
        'eval-call': Object.fromEntries(EVAL_FAMILIES.map((f) => [f, deps.work.calls.online(f)])),
        'eval-session': Object.fromEntries(EVAL_FAMILIES.map((f) => [f, deps.work.sessions.online(f)])),
      },
      slots: { 'eval-call': deps.work.calls.slotsOnline(), 'eval-session': deps.work.sessions.slotsOnline() },
      ...(run && RUN_RE.test(run) ? { run: runStatusOf(deps.work, run) } : {}),
    });
  });

  // a run's own slots (`eval run --local`): they lease like a worker, on this machine, and only their run's pieces
  const slotOf = (b: Record<string, unknown>): WorkerIdentity => {
    const run = text(b.run, 120);
    if (!RUN_RE.test(run)) throw new BadSpec('run must be a run id');
    const family = String(b.family ?? '') as EvalFamily;
    if (!EVAL_FAMILIES.includes(family)) throw new BadSpec(`family must be ${EVAL_FAMILIES.join(' or ')}`);
    const name = text(b.worker, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._#-]{0,79}$/.test(name)) throw new BadSpec('worker must name the slot');
    const pool = b.pool == null || b.pool === '' ? 'local' : text(b.pool, 64);
    if (!POOL_RE.test(pool)) throw new BadSpec('pool must name a pool');
    return { worker: `local/${run}/${name}`, backend: family, remote: false, run, pool };
  };
  const json = async (c: Context) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadSpec('expected a JSON object');
    return b;
  };
  const idsOf = (v: unknown) => (Array.isArray(v) ? v.map((x) => text(x, 64)).filter(Boolean).slice(0, 64) : []);
  api.post('/slots/lease', async (c) => {
    const b = await json(c);
    const who = slotOf(b);
    const kinds = Array.isArray(b.kinds) ? b.kinds.filter(isEvalKind) : [];
    for (const kind of kinds) deps.work.source(kind).noteAsked(who, kinds);
    for (const kind of kinds) {
      const tasks = await deps.work.source(kind).lease(who, 1, { kinds });
      if (tasks.length) return c.json({ tasks });
    }
    return c.json({ tasks: [] });
  });
  api.post('/slots/complete', async (c) => {
    const b = await json(c);
    const who = slotOf(b);
    const id = text(b.id, 64);
    const source = deps.work.sources.find((x) => x.holds(id));
    if (!source) return c.json({ accepted: false, reason: 'unknown or expired lease' }, 409);
    const kind = ['model', 'transient', 'fatal'].includes(String(b.kind)) ? (b.kind as FailureKind) : undefined;
    const outcome: TaskOutcome = b.ok === true
      ? { ok: true, text: text(b.text, 2 * 1024 * 1024) }
      : { ok: false, error: text(b.error || 'failed without a message', 2000), kind };
    const result = await source.complete(id, who, outcome);
    return c.json(result, result.accepted ? 200 : 409);
  });
  api.post('/slots/renew', async (c) => {
    const b = await json(c);
    const who = slotOf(b);
    const ids = idsOf(b.ids);
    const renewed: string[] = [];
    const lost: string[] = [];
    for (const source of deps.work.sources) {
      const r = source.renew(ids.filter((id) => source.holds(id)), who);
      renewed.push(...r.renewed);
      lost.push(...r.lost);
    }
    lost.push(...ids.filter((id) => !deps.work.sources.some((x) => x.holds(id))));
    return c.json({ renewed, lost });
  });
  api.post('/slots/release', async (c) => {
    const b = await json(c);
    const who = slotOf(b);
    const ids = idsOf(b.ids);
    let released = 0;
    for (const source of deps.work.sources) released += await source.release(ids.filter((id) => source.holds(id)), who);
    return c.json({ released });
  });

  const runOf = (v: unknown) => {
    const run = text(v, 120);
    if (!RUN_RE.test(run)) throw new BadSpec('run must be a run id');
    return run;
  };
  const scopeOf = (v: unknown) => {
    if (v == null || v === '') return null;
    const scope = text(v, 64);
    if (!/^[0-9a-f]{8,64}$/.test(scope)) throw new BadSpec('scope must be a hex digest');
    return scope;
  };

  api.post('/tasks', async (c) => {
    const b = await json(c);
    const run = runOf(b.run);
    const scope = scopeOf(b.scope);
    if (!Array.isArray(b.specs) || b.specs.length > MAX_BATCH) throw new BadSpec(`specs must be a list of at most ${MAX_BATCH}`);
    const specs = b.specs.map((spec) => evalSpecOf({ spec }));
    for (const spec of specs) {
      if (spec.run !== run) throw new BadSpec(`spec ${spec.key} is of run ${spec.run}, not ${run}`);
      if (spec.kind === 'eval-session' && spec.archive && !deps.work.archives.file(spec.archive.sha256)) {
        throw new BadSpec(`archive ${spec.archive.sha256.slice(0, 12)} is not here: upload it first`);
      }
    }
    const ttl = Math.min(7 * 24 * 3_600_000, Math.max(1_000, Math.trunc(Number(b.deadlineMs) || DEFAULT_TASK_TTL_MS)));
    deps.work.attach(run);
    const published = deps.work.publish(specs, { deadline: Date.now() + ttl, scope });
    return c.json({ tasks: published.map(({ key, published: p }) => ({ key, state: p.state, ...(p.outcome ? { outcome: p.outcome } : {}) })) });
  });

  api.post('/tasks/poll', async (c) => {
    const b = await json(c);
    const run = runOf(b.run);
    const keys = Array.isArray(b.keys) ? b.keys.map((k) => text(k, 64)).filter((k) => KEY_RE.test(k)) : [];
    if (keys.length > MAX_POLL_KEYS) throw new BadSpec(`at most ${MAX_POLL_KEYS} keys a poll`);
    const waitMs = Math.min(MAX_POLL_MS, Math.max(0, Math.trunc(Number(b.waitMs) || 0)));
    deps.work.attach(run);
    let found = deps.work.collect(run, keys);
    if (!found.done.length && !found.missing.length && waitMs > 0 && keys.length) {
      await deps.work.settled(run, keys, waitMs, c.req.raw.signal);
      deps.work.attach(run);
      found = deps.work.collect(run, keys);
    }
    return c.json(found);
  });

  api.post('/runs/:run/detach', (c) => {
    const run = runOf(c.req.param('run'));
    const n = deps.work.detachRun(run);
    if (n) log(`eval run ${run} went away: ${n} piece(s) only it could serve dropped; the rest wait for its resume`);
    return c.json({ dropped: n });
  });

  api.delete('/runs/:run', (c) => {
    const run = runOf(c.req.param('run'));
    const removed = deps.work.dropRun(run, scopeOf(c.req.query('scope')));
    if (removed) log(`eval run ${run} dropped: ${removed} task(s) and their results removed`);
    return c.json({ removed });
  });

  api.post('/offer', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new BadSpec('expected a JSON object');
    const spec = evalSpecOf(body);
    // with eval work not offered to remote workers (server.remote.offer.eval off) a piece still waits here for a run's own slots
    if (spec.kind === 'eval-session' && spec.archive && !deps.work.archives.file(spec.archive.sha256)) {
      throw new BadSpec(`archive ${spec.archive.sha256.slice(0, 12)} is not here: upload it first`);
    }
    // a piece waits until a slot takes it (docs/design/32 D3): a run from before that sends `offerSeconds`, which no longer applies
    const abort = new AbortController();
    const offer = deps.work.source(spec.kind).offer(spec, { signal: abort.signal });
    // the answer can take as long as the piece: headers now, whitespace while it waits, the outcome last
    const enc = new TextEncoder();
    let timer: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          try {
            controller.enqueue(enc.encode(' '));
          } catch {
            abort.abort();
          }
        }, KEEPALIVE_MS);
        timer.unref?.();
        void offer.result.then((outcome) => {
          if (timer) clearInterval(timer);
          try {
            controller.enqueue(enc.encode(JSON.stringify(outcome)));
            controller.close();
          } catch {
            // the run went away first
          }
        });
      },
      cancel() {
        // the run closed the request (stopped, killed): the piece is no longer wanted
        if (timer) clearInterval(timer);
        abort.abort();
      },
    });
    c.req.raw.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  });

  // the check is a HEAD, and the router serves a HEAD by the GET route with its body dropped: registered as HEAD it never matched, and every check said 404
  api.get('/archives/:sha', (c) => {
    const f = deps.work.archives.file(c.req.param('sha'));
    return c.body(null, f ? 200 : 404);
  });

  api.put('/archives/:sha', async (c) => {
    const sha = c.req.param('sha');
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_ARCHIVE_UPLOAD) return c.json({ error: `an archive above ${MAX_ARCHIVE_UPLOAD} bytes` }, 413);
    const gzip = Buffer.from(await c.req.arrayBuffer());
    if (gzip.length > MAX_ARCHIVE_UPLOAD) return c.json({ error: `an archive above ${MAX_ARCHIVE_UPLOAD} bytes` }, 413);
    try {
      await deps.work.archives.put(sha, gzip, readArchive);
    } catch (err) {
      throw new BadSpec(err instanceof Error ? err.message : String(err));
    }
    return c.json({ ok: true, sha256: sha, bytes: gzip.length });
  });

  api.post('/runs/:run/cancel', (c) => {
    const run = c.req.param('run');
    const n = deps.work.calls.cancelRun(run) + deps.work.sessions.cancelRun(run);
    if (n) log(`eval run ${run} cancelled: ${n} piece(s) withdrawn`);
    return c.json({ cancelled: n });
  });

  api.all('*', (c: Context) => c.json({ error: 'not found' }, 404));

  app.route('/eval/v1', api);
}
