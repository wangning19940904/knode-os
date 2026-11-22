import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RemoteApiConfig } from '../config.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { AppContext } from '../context.js';
import { assertSourcePath, cleanRelPath, removePath, safePath, writeFileText } from '../fs/files.js';
import { graphOverview, graphSearch } from '../graph/query.js';
import { assertNotLinked } from '../ingest/folders.js';
import { assertNotConvertedOriginal, readSourceTextCapped } from '../ingest/source.js';
import { sync } from '../ingest/sync.js';
import { FailureKind } from '../labeling/failures.js';
import { TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { sanitizeUsage } from '../llm/usage.js';
import { search, SearchMode } from '../search/search.js';
import { WorkspaceContextRegistry, resolveWorkspaceScope, WorkspaceScope } from '../server/workspaces.js';
import { CATALOG_VIEWS, catalogQuery } from '../store/catalog.js';
import { queryClaims } from '../store/claims.js';
import { listEntities } from '../store/queries.js';
import { clientInfo } from '../server/public-guard.js';
import { LeaseRequest, WorkBroker } from '../work/broker.js';
import { offeredRemotely, workerConfig } from '../work/config.js';
import { decodeVectors, EmbedSource } from '../work/embed.js';
import { ASKED_ONLY_KINDS, isWorkKind, WORK_KINDS, WorkKind } from '../work/kinds.js';
import { SessionSource } from '../work/session.js';
import { EvalSource } from '../work/eval.js';
import { POOL_RE } from './eval-producer.js';
import { isArchiveId } from '../work/eval-archive.js';
import { answerSessionMcp, describeMcpRequest, withKeepalive } from './session-mcp.js';
import { RemoteScope, RemoteTokenRecord, RemoteTokenStore, tokenAllows, tokenAllowsKind } from './tokens.js';

/**
 * The remote API: what other machines may do with this knowledge base,
 * under /remote/v1 on `serve`'s own port.
 *
 *   GET  /health                                   no auth
 *   GET  /whoami                                   the token's name, scopes and workspaces
 *   GET  /worker.mjs                               the remote worker script (worker/knode-worker.mjs)
 *   /w/<owner>/<workspace>/…                       <owner> = a username, or "team" for a team workspace
 *     work       GET work/config, POST work/lease | complete | renew | release,
 *                GET work/status — every kind of leased work (docs/design/12)       (scope label, embed or research)
 *     sessions   POST sessions/<id>/mcp — knode's tools for one research session
 *                a worker holds (docs/design/27): the session's own token, not a knr_ one
 *     eval       POST eval-sessions/<id>/mcp — the run's knode tools for one evaluation
 *                session a worker holds, proxied to the run's bridge on this machine
 *                (docs/design/27 §8): the lease's own kes_ token, its tools only
 *                GET eval-archives/<sha256> — a file agent's folder, while a session
 *                that reads it is offered or out                                     (scope eval)
 *                POST work/calibrate — an own embedding endpoint's probe vectors    (scope embed)
 *     labeling   POST labeling/lease | complete | renew | release, GET labeling/status:
 *                the same for extraction only, as workers before work/* speak it    (scope label)
 *     documents  GET documents, GET document?path=                                      (scope read)
 *                PUT document?path= {content}, DELETE document?path=, POST sync          (scope write)
 *     knowledge  GET search?q=, graph?q=, claims?…, entities?q=                          (scope read)
 *     sql        POST sql {sql, maxRows}, GET sql/views                                  (scope sql)
 *
 * Every other route needs `Authorization: Bearer knr_…` (src/remote/tokens.ts).
 * Reads are limited to the knowledge — documents, wiki, playbook content — and
 * never reach the config, the token files or the ledger. Writes go to files
 * and through a scoped sync like any other edit, attributed to the token, so
 * the files stay the record and a rebuild loses nothing. SQL runs read-only,
 * as the workspace's catalog reader (src/store/catalog.ts). Each request is
 * logged to .knode/remote-audit.jsonl.
 */

export interface RemoteApiDeps {
  rootDataDir: string;
  registry: WorkspaceContextRegistry;
  /** The work broker `serve` runs for a workspace (src/work/broker.ts); null outside `serve`. */
  work: (ctx: AppContext) => WorkBroker | null;
  /** Where evaluation archives live (src/work/eval.ts `EvalArchives`); absent outside `serve`. */
  evalArchive?: (sha256: string) => string | null;
  config?: RemoteApiConfig;
  log?: (msg: string) => void;
}

type RemoteEnv = {
  Variables: {
    token: RemoteTokenRecord;
    workspace: string;
    ctx: AppContext;
  };
};

const READABLE_ROOTS = ['raw/docs', 'raw/skills', 'wiki', 'playbooks/packs', 'playbooks/intents', 'playbooks/ontology', 'playbooks/capabilities'];
const READABLE_FILES = new Set(['purpose.md', 'schema.md', 'AGENTS.md', 'CLAUDE.md']);
const READ_MAX_BYTES = 2 * 1024 * 1024;
const AUDIT_FILE = '.knode/remote-audit.jsonl';
const AUDIT_ROTATE_BYTES = 20 * 1024 * 1024;
/** Failed authentications per client before it is turned away for a while. */
const AUTH_FAILURE_LIMIT = 10;
const AUTH_WINDOW_MS = 10 * 60_000;
const AUTH_BLOCK_MS = 15 * 60_000;

class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string) {
    super(message);
  }
}

/** A path a remote reader may open: knowledge only, never config, tokens, ledger or derived state. */
export function assertRemoteReadable(rel: string): string {
  const clean = cleanRelPath(rel);
  if (!clean) throw rel.trim() ? new HttpError(403, `${rel} is not readable remotely`) : new HttpError(400, 'path required');
  if (clean.split('/').some((segment) => segment.startsWith('.'))) throw new HttpError(403, `${clean} is not readable remotely`);
  if (READABLE_FILES.has(clean)) return clean;
  if (!READABLE_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`))) {
    throw new HttpError(403, `${clean} is not readable remotely — documents live under ${READABLE_ROOTS.join(', ')}`);
  }
  return clean;
}

/** The caller's address: the edge's word only when a proxy on this machine forwarded the request (src/server/public-guard.ts). */
function clientOf(c: Context): string {
  return clientInfo(c).ip;
}

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max);

/** Vectors as a worker sends them: base64 little-endian float32 with their dimension, or arrays of numbers. */
function vectorsOf(value: unknown, dimensions: unknown): number[][] {
  if (Array.isArray(value)) return value as number[][];
  if (typeof value !== 'string') throw new HttpError(400, 'vectors (base64 float32, or arrays) required');
  const dims = Math.floor(Number(dimensions));
  if (!(dims > 0 && dims <= 16_384)) throw new HttpError(400, 'dimensions required with base64 vectors');
  const bytes = Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (bytes % (dims * 4) !== 0) throw new HttpError(400, `the vectors are not whole ${dims}-dimension float32 rows`);
  try {
    return decodeVectors(value, bytes / (dims * 4), dims);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

export function mountRemoteApi(app: Hono<any>, deps: RemoteApiDeps): void {
  const log = deps.log ?? (() => {});
  const tokens = new RemoteTokenStore(deps.rootDataDir);
  const failures = new Map<string, { count: number; since: number; blockedUntil: number }>();
  const api = new Hono<RemoteEnv>();
  const maxBody = deps.config?.maxBodyBytes ?? 8 * 1024 * 1024;

  const audit = (entry: Record<string, unknown>) => {
    try {
      const file = path.join(deps.rootDataDir, AUDIT_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        // first entry
      }
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // auditing never fails a request
    }
  };

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  });

  api.use('*', bodyLimit({ maxSize: maxBody, onError: (c) => c.json({ error: `request body above ${maxBody} bytes` }, 413) }));

  api.get('/health', (c) => c.json({ ok: true, service: 'knode-os remote', version: 1 }));

  const blocked = (client: string) => (failures.get(client)?.blockedUntil ?? 0) > Date.now();
  /** One failed authentication: ten in ten minutes turn the client away for a while. */
  const refused = (client: string) => {
    const now = Date.now();
    const f = failures.get(client);
    const entry = f && now - f.since < AUTH_WINDOW_MS ? f : { count: 0, since: now, blockedUntil: 0 };
    entry.count++;
    if (entry.count >= AUTH_FAILURE_LIMIT) {
      entry.blockedUntil = now + AUTH_BLOCK_MS;
      log(`remote: ${client} blocked for ${AUTH_BLOCK_MS / 60_000} min after ${entry.count} failed authentications`);
    }
    failures.set(client, entry);
  };
  const presentedToken = (c: Context) => /^bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? c.req.header('x-knode-token') ?? null;
  /** A workspace by its route segments, opened through the same registry as the UI's. */
  const openWorkspace = async (owner: string, workspace: string): Promise<{ spec: string; ctx: AppContext }> => {
    const spec = `${owner}/${workspace}`.toLowerCase();
    let scope: WorkspaceScope;
    try {
      scope = owner.toLowerCase() === 'team'
        ? resolveWorkspaceScope({ user: 'remote', kind: 'team', name: workspace })
        : resolveWorkspaceScope({ user: owner, kind: 'personal', id: workspace, name: workspace });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (!deps.registry.exists(scope)) throw new HttpError(404, `no workspace ${spec}`);
    return { spec, ctx: await deps.registry.get(scope) };
  };

  // knode's tools for one research session a worker holds (docs/design/27 §4): the agent on the worker
  // presents the session's own token, minted with its lease and dropped when the lease ends — never a knr_ one
  api.all('/w/:owner/:workspace/sessions/:id/mcp', async (c) => {
    const client = clientOf(c);
    if (blocked(client)) return c.json({ error: 'too many failed authentications — try again later' }, 429);
    const { spec, ctx } = await openWorkspace(c.req.param('owner'), c.req.param('workspace'));
    const source = deps.work(ctx)?.source('session');
    const id = text(c.req.param('id'), 64);
    const binding = source instanceof SessionSource ? source.authorize(id, presentedToken(c)) : null;
    const asked = await describeMcpRequest(c.req.raw);
    if (!binding) {
      refused(client);
      audit({ client, workspace: spec, session: id, method: c.req.method, ...asked, status: 401 });
      return c.json({ error: 'no live research session with this token' }, 401);
    }
    failures.delete(client);
    const started = Date.now();
    const res = await answerSessionMcp(c.req.raw, ctx, binding);
    audit({ client, workspace: spec, session: id, job: binding.job, worker: binding.worker, method: c.req.method, ...asked, status: res.status, ms: Date.now() - started });
    return res;
  });

  // the run's knode tools for one evaluation session a worker holds (docs/design/27 §8): the lease's own token,
  // the session's tools only, proxied to the MCP bridge the run keeps on this machine — no workspace leaves it
  api.all('/w/:owner/:workspace/eval-sessions/:id/mcp', async (c) => {
    const client = clientOf(c);
    if (blocked(client)) return c.json({ error: 'too many failed authentications — try again later' }, 429);
    const { spec, ctx } = await openWorkspace(c.req.param('owner'), c.req.param('workspace'));
    const source = deps.work(ctx)?.source('eval-session');
    const id = text(c.req.param('id'), 64);
    const binding = source instanceof EvalSource ? source.authorize(id, presentedToken(c)) : null;
    const asked = await describeMcpRequest(c.req.raw);
    if (!binding) {
      refused(client);
      audit({ client, workspace: spec, evalSession: id, method: c.req.method, ...asked, status: 401 });
      return c.json({ error: 'no live evaluation session with this token' }, 401);
    }
    failures.delete(client);
    if (c.req.method !== 'POST') return c.json({ error: 'POST only' }, 405);
    if (asked.rpc === 'tools/call' && (!asked.tool || !binding.mcp.tools.includes(asked.tool))) {
      audit({ client, workspace: spec, evalSession: id, run: binding.run, worker: binding.worker, ...asked, status: 403 });
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32601, message: `this session may not call ${asked.tool ?? 'that'}` } }, 403);
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(binding.mcp.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.mcp.secret}`,
          'content-type': c.req.header('content-type') ?? 'application/json',
          accept: c.req.header('accept') ?? 'application/json, text/event-stream',
          ...(c.req.header('mcp-protocol-version') ? { 'mcp-protocol-version': c.req.header('mcp-protocol-version')! } : {}),
        },
        body: await c.req.arrayBuffer(),
        signal: c.req.raw.signal,
      });
    } catch (err) {
      audit({ client, workspace: spec, evalSession: id, run: binding.run, worker: binding.worker, ...asked, status: 502 });
      return c.json({ error: `the run's MCP bridge did not answer: ${err instanceof Error ? err.message : err}` }, 502);
    }
    audit({ client, workspace: spec, evalSession: id, run: binding.run, worker: binding.worker, method: c.req.method, ...asked, status: res.status, ms: Date.now() - started });
    const headers = new Headers();
    for (const name of ['content-type', 'cache-control']) {
      const v = res.headers.get(name);
      if (v) headers.set(name, v);
    }
    return withKeepalive(new Response(res.body, { status: res.status, headers }), () => {});
  });

  // authentication, rate-limited per client, and an audit line for every answer
  api.use('*', async (c, next) => {
    if (c.req.path.endsWith('/remote/v1/health')) return next();
    const client = clientOf(c);
    if (blocked(client)) return c.json({ error: 'too many failed authentications — try again later' }, 429);
    const presented = presentedToken(c);
    let record: RemoteTokenRecord | null = null;
    try {
      record = tokens.verify(presented);
    } catch (err) {
      log(`remote: token store unreadable: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: 'authentication unavailable' }, 503);
    }
    if (!record) {
      refused(client);
      audit({ client, method: c.req.method, path: c.req.path, status: 401 });
      return c.json({ error: 'missing or invalid token' }, 401);
    }
    failures.delete(client);
    c.set('token', record);
    const started = Date.now();
    await next();
    audit({ client, token: record.id, name: record.name, method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  // the worker script itself, so a new machine needs nothing but Node and its token
  api.get('/worker.mjs', (c) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = [path.resolve(here, '../../worker/knode-worker.mjs'), path.resolve(here, '../../../worker/knode-worker.mjs')].find((f) => fs.existsSync(f));
    if (!file) throw new HttpError(404, 'worker script not found next to this installation');
    return c.body(fs.readFileSync(file), 200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="knode-worker.mjs"' });
  });

  api.get('/whoami', (c) => {
    const t = c.get('token');
    return c.json({ id: t.id, name: t.name, scopes: t.scopes, workspaces: t.workspaces, ...(t.kinds ? { kinds: t.kinds } : {}), createdAt: t.createdAt });
  });

  // a workspace the token may use, opened through the same registry as the UI's
  api.use('/w/:owner/:workspace/*', async (c, next) => {
    const spec = `${c.req.param('owner')}/${c.req.param('workspace')}`.toLowerCase();
    const token = c.get('token');
    if (!token.workspaces.some((w) => w === '*' || w === spec)) throw new HttpError(403, `this token may not use ${spec}`);
    const opened = await openWorkspace(c.req.param('owner'), c.req.param('workspace'));
    c.set('workspace', opened.spec);
    c.set('ctx', opened.ctx);
    await next();
  });

  const need = (c: Context<RemoteEnv>, scope: RemoteScope) => {
    if (!tokenAllows(c.get('token'), scope, c.get('workspace'))) throw new HttpError(403, `this token lacks the "${scope}" scope here`);
    return c.get('ctx');
  };
  /** Leased work: model calls under `label`, embed batches under `embed`, research sessions under `research`, evaluation work under `eval`. */
  const needWork = (c: Context<RemoteEnv>) => {
    const token = c.get('token');
    if (!(['label', 'embed', 'research', 'eval'] as const).some((scope) => tokenAllows(token, scope, c.get('workspace')))) {
      throw new HttpError(403, 'this token lacks the "label", "embed", "research" or "eval" scope here');
    }
    return c.get('ctx');
  };
  const broker = (ctx: AppContext) => {
    const b = deps.work(ctx);
    if (!b) throw new HttpError(503, 'leased work runs only inside `knode-os serve`');
    return b;
  };
  /** The kinds the token may take here that the workspace offers remote workers. */
  const allowedKinds = (c: Context<RemoteEnv>): WorkKind[] =>
    WORK_KINDS.filter((k) => tokenAllowsKind(c.get('token'), k, c.get('workspace')) && offeredRemotely(c.get('ctx').config, k));
  const configFor = (c: Context<RemoteEnv>, b: WorkBroker) => {
    const ctx = c.get('ctx');
    const allowed = allowedKinds(c);
    const embed = allowed.includes('embed') && b.source('embed') ? { embedder: ctx.embedder, leaseMs: b.leaseDurationMs('embed') } : null;
    const sessionLeaseMs = b.source('session') ? b.leaseDurationMs('session') : null;
    const evalLeaseMs = b.source('eval-session') ? b.leaseDurationMs('eval-session') : b.source('eval-call') ? b.leaseDurationMs('eval-call') : null;
    return workerConfig(ctx.config, { allowed, leaseMs: b.leaseDurationMs(), shares: b.shares(), embed, sessionLeaseMs, evalLeaseMs });
  };
  const sessionSource = (b: WorkBroker): SessionSource | null => {
    const source = b.source('session');
    return source instanceof SessionSource ? source : null;
  };
  const evalSessionSource = (b: WorkBroker): EvalSource | null => {
    const source = b.source('eval-session');
    return source instanceof EvalSource ? source : null;
  };
  const embedSource = (b: WorkBroker): EmbedSource | null => {
    const source = b.source('embed');
    return source instanceof EmbedSource ? source : null;
  };
  // a worker's pool (docs/design/32 §2): the one it declares (`--pool`), else its token's name
  const whoOf = (c: Context<RemoteEnv>, body: Record<string, unknown>): WorkerIdentity => {
    const declared = typeof body.pool === 'string' ? body.pool.trim() : '';
    if (declared && !POOL_RE.test(declared)) throw new HttpError(400, 'pool must be a name: letters, digits, ".", "_" and "-", at most 64');
    return {
      worker: `${c.get('token').name}/${text(body.worker || 'worker', 80)}`,
      backend: text(body.backend || 'unknown', 80),
      remote: true,
      pool: declared || c.get('token').name,
    };
  };
  const body = async (c: Context<RemoteEnv>): Promise<Record<string, unknown>> => {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'expected a JSON object');
    return parsed as Record<string, unknown>;
  };
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => text(v, 64)).filter(Boolean).slice(0, 64) : []);

  /* ----------------------------- leased work ---------------------------- */

  const complete = (scope: 'label' | 'work') => async (c: Context<RemoteEnv>) => {
    const ctx = scope === 'label' ? need(c, 'label') : needWork(c);
    const b = await body(c);
    const id = text(b.id, 64);
    if (!id) throw new HttpError(400, 'id required');
    const kind = ['model', 'transient', 'fatal'].includes(String(b.kind)) ? (b.kind as FailureKind) : undefined;
    // what the worker's CLI or endpoint said the call used (a worker from before this sends none)
    const usage = sanitizeUsage(b.usage) ?? undefined;
    const model = b.model ? text(b.model, 120) : undefined;
    // an embed batch's vectors: base64 float32 (n × dimensions), or plain arrays
    let vectors: number[][] | undefined;
    if (b.ok === true && b.vectors !== undefined) vectors = vectorsOf(b.vectors, b.dimensions);
    // a research session's answer: the CLI's raw output since the last renewal, its exit code and stderr's end
    const session = b.ok === true && b.session && typeof b.session === 'object' && !Array.isArray(b.session)
      ? (() => {
        const v = b.session as Record<string, unknown>;
        return {
          exitCode: Number.isFinite(Number(v.exitCode)) ? Math.trunc(Number(v.exitCode)) : -1,
          output: text(v.output, 4 * 1024 * 1024),
          stderr: text(v.stderr, 64 * 1024),
          lastMessage: typeof v.lastMessage === 'string' ? text(v.lastMessage, 2 * 1024 * 1024) : null,
          // an evaluation session's: stopped at its step cap, and where it ran (for the leak audit)
          ...(v.capped === true ? { capped: true } : {}),
          // and how its closing turn went (a worker from before the closing turn sends none)
          ...(v.capped === true && ['answered', 'no-answer', 'used-a-tool', 'not-run'].includes(String(v.closing)) ? { closing: v.closing as 'answered' | 'no-answer' | 'used-a-tool' | 'not-run' } : {}),
          ...(typeof v.cwd === 'string' ? { cwd: text(v.cwd, 1024) } : {}),
          ...(typeof v.home === 'string' ? { home: text(v.home, 1024) } : {}),
        };
      })()
      : undefined;
    const outcome: TaskOutcome = b.ok === true
      ? { ok: true, text: text(b.text, 2 * 1024 * 1024), model, usage, ...(vectors ? { vectors } : {}), ...(b.endpointModel ? { endpointModel: text(b.endpointModel, 120) } : {}), ...(session ? { session } : {}) }
      : { ok: false, error: text(b.error || 'failed without a message', 2000), kind, model, usage };
    const result = await broker(ctx).complete(id, whoOf(c, b), outcome);
    return c.json(result, result.accepted ? 200 : 409);
  };
  const renew = (scope: 'label' | 'work') => async (c: Context<RemoteEnv>) => {
    const ctx = scope === 'label' ? need(c, 'label') : needWork(c);
    const b = await body(c);
    const s = broker(ctx);
    const who = whoOf(c, b);
    // a research session's stdout since the last renewal, for its transcript (docs/design/27 D10)
    // and an evaluation session's, kept for its answer
    const sessions = sessionSource(s);
    const evalSessions = evalSessionSource(s);
    if ((sessions || evalSessions) && b.output && typeof b.output === 'object' && !Array.isArray(b.output)) {
      for (const [id, chunk] of Object.entries(b.output as Record<string, unknown>).slice(0, 64)) {
        if (typeof chunk !== 'string' || !chunk) continue;
        if (!sessions?.output(text(id, 64), who, chunk)) evalSessions?.output(text(id, 64), who, chunk);
      }
    }
    return c.json(s.renew(ids(b.ids), who));
  };
  const release = (scope: 'label' | 'work') => async (c: Context<RemoteEnv>) => {
    const ctx = scope === 'label' ? need(c, 'label') : needWork(c);
    const b = await body(c);
    return c.json({ released: await broker(ctx).release(ids(b.ids), whoOf(c, b)) });
  };
  const watching = (c: Context<RemoteEnv>) => {
    const token = c.get('token');
    if (!(['label', 'embed', 'research', 'eval', 'read'] as const).some((scope) => tokenAllows(token, scope, c.get('workspace')))) {
      throw new HttpError(403, 'this token lacks the "label", "embed", "research", "eval" or "read" scope here');
    }
    return broker(c.get('ctx'));
  };

  // what a worker reads instead of being told by hand: the kinds it may take, lease, shares, model hints, the embedding identity
  api.get('/w/:owner/:workspace/work/config', (c) => c.json(configFor(c, broker(needWork(c)))));

  api.post('/w/:owner/:workspace/work/lease', async (c) => {
    const ctx = needWork(c);
    const b = await body(c);
    const s = broker(ctx);
    const allowed = allowedKinds(c);
    // embed batches and research sessions go only to a slot that asks for them: an LLM slot from before them asks for nothing in particular
    const asked = Array.isArray(b.kinds) ? b.kinds.filter(isWorkKind) : allowed.filter((k) => !ASKED_ONLY_KINDS.includes(k));
    const kinds = asked.filter((k) => allowed.includes(k));
    const who = whoOf(c, b);
    const request: LeaseRequest = { calibration: b.calibration ? text(b.calibration, 64) : undefined };
    // an embed slot on its own endpoint that is not (or no longer) calibrated is told so, and gets nothing
    let embed: { calibrate: true; reason: string; parkedUntil?: string } | undefined;
    if (kinds.includes('embed')) {
      const source = embedSource(s);
      const problem = source ? source.calibrationProblem(who, request.calibration) : { reason: 'embed work is not leased here' };
      if (problem) embed = { calibrate: true, ...problem };
    }
    // a slot that may not embed yet is not counted as asking for embed work: the audits would wait on it in vain
    const leasing = embed ? kinds.filter((k) => k !== 'embed') : kinds;
    const tasks = leasing.length ? await s.lease(who, leasing, Number(b.max ?? 1) || 1, request) : [];
    return c.json({
      configVersion: configFor(c, s).version, leaseSeconds: Math.round(s.leaseDurationMs(kinds[0] ?? 'extract') / 1000), tasks,
      ...(embed ? { embed } : {}),
    });
  });
  // an own embedding endpoint's vectors for the probe set: passing is what lets its vectors in (docs/design/12 §4.3)
  api.post('/w/:owner/:workspace/work/calibrate', async (c) => {
    const ctx = need(c, 'embed');
    if (!offeredRemotely(ctx.config, 'embed')) throw new HttpError(409, 'this workspace does not offer embed work (ingest.embedding is not "deferred", or server.remote.offer.embed is off)');
    const b = await body(c);
    const source = embedSource(broker(ctx));
    if (!source) throw new HttpError(503, 'embed work is not leased here');
    const worker = `${c.get('token').name}/${text(b.worker || 'worker', 80)}`;
    return c.json(await source.calibrate(worker, {
      model: text(b.model, 120),
      endpointModel: b.endpointModel ? text(b.endpointModel, 120) : undefined,
      vectors: vectorsOf(b.vectors, b.dimensions),
    }));
  });
  // a file agent's folder for an evaluation session (docs/design/27 §8): only while a session that reads it is offered or out
  api.get('/w/:owner/:workspace/eval-archives/:sha', (c) => {
    const ctx = need(c, 'eval');
    const sha = c.req.param('sha');
    if (!isArchiveId(sha)) throw new HttpError(400, 'an archive id is a SHA-256 in hex');
    const sessions = evalSessionSource(broker(ctx));
    const file = deps.evalArchive?.(sha) ?? null;
    if (!sessions?.wantsArchive(sha) || !file) throw new HttpError(404, `no archive ${sha.slice(0, 12)} for a live evaluation session`);
    return c.body(fs.readFileSync(file), 200, { 'content-type': 'application/gzip', 'cache-control': 'no-store' });
  });
  api.post('/w/:owner/:workspace/work/complete', complete('work'));
  api.post('/w/:owner/:workspace/work/renew', renew('work'));
  api.post('/w/:owner/:workspace/work/release', release('work'));
  api.get('/w/:owner/:workspace/work/status', async (c) => c.json(await watching(c).status()));

  // extraction only, as workers that predate work/* speak it
  api.post('/w/:owner/:workspace/labeling/lease', async (c) => {
    const ctx = need(c, 'label');
    if (!tokenAllowsKind(c.get('token'), 'extract', c.get('workspace'))) throw new HttpError(403, 'this token may not take extraction work');
    const b = await body(c);
    const s = broker(ctx);
    const tasks = await s.lease(whoOf(c, b), ['extract'], Number(b.max ?? 1) || 1);
    return c.json({ leaseSeconds: Math.round(s.leaseDurationMs('extract') / 1000), tasks });
  });
  api.post('/w/:owner/:workspace/labeling/complete', complete('label'));
  api.post('/w/:owner/:workspace/labeling/renew', renew('label'));
  api.post('/w/:owner/:workspace/labeling/release', release('label'));
  api.get('/w/:owner/:workspace/labeling/status', async (c) => {
    const extract = watching(c).source('extract');
    if (!extract) throw new HttpError(503, 'extraction is not leased here');
    return c.json(await extract.status());
  });

  /* ------------------------------ documents ----------------------------- */

  api.get('/w/:owner/:workspace/documents', async (c) => {
    const ctx = need(c, 'read');
    const prefix = cleanRelPath(c.req.query('prefix') ?? '') || '';
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 1000);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const like = `${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await ctx.store.query(
      `SELECT path, title, root, kind, status, sha256, doc_date, created_at, updated_at
       FROM documents WHERE root IN ('docs', 'wiki', 'skills') AND path LIKE $1
       ORDER BY path LIMIT $2 OFFSET $3`,
      [like, limit, offset],
    );
    return c.json({ prefix, limit, offset, documents: rows });
  });

  api.get('/w/:owner/:workspace/document', (c) => {
    const ctx = need(c, 'read');
    const rel = assertRemoteReadable(c.req.query('path') ?? '');
    if (!fs.existsSync(safePath(ctx.dataDir, rel))) throw new HttpError(404, `no file ${rel}`);
    const file = readSourceTextCapped(ctx.dataDir, rel, READ_MAX_BYTES);
    if (!file) throw new HttpError(404, `${rel} has no readable text yet`);
    return c.json({ path: rel, ...file });
  });

  api.put('/w/:owner/:workspace/document', async (c) => {
    const ctx = need(c, 'write');
    const rel = cleanRelPath(c.req.query('path') ?? '');
    const b = await body(c);
    if (typeof b.content !== 'string') throw new HttpError(400, 'content (a string) required');
    if (Buffer.byteLength(b.content) > MAX_FILE_BYTES) throw new HttpError(400, `content above ${MAX_FILE_BYTES} bytes`);
    assertSourcePath(rel);
    assertNotConvertedOriginal(rel);
    assertNotLinked(ctx.config, rel, 'write to');
    writeFileText(ctx.dataDir, rel, b.content);
    const stats = await sync(ctx, { only: [rel], actor: `remote:${c.get('token').name}` });
    return c.json({ ok: true, path: rel, indexed: stats.indexed, unchanged: stats.unchanged, errors: stats.errors });
  });

  api.delete('/w/:owner/:workspace/document', async (c) => {
    const ctx = need(c, 'write');
    const rel = cleanRelPath(c.req.query('path') ?? '');
    assertSourcePath(rel);
    assertNotLinked(ctx.config, rel, 'delete');
    if (!fs.existsSync(safePath(ctx.dataDir, rel))) throw new HttpError(404, `no file ${rel}`);
    removePath(ctx.dataDir, rel);
    const stats = await sync(ctx, { only: [rel], actor: `remote:${c.get('token').name}` });
    return c.json({ ok: true, path: rel, disposed: stats.disposed });
  });

  api.post('/w/:owner/:workspace/sync', async (c) => {
    const ctx = need(c, 'write');
    const b = await c.req.json().catch(() => ({})) as { only?: unknown };
    const only = Array.isArray(b.only) ? b.only.map((p) => cleanRelPath(String(p))).filter(Boolean) : undefined;
    const stats = await sync(ctx, { only, actor: `remote:${c.get('token').name}` });
    return c.json({ indexed: stats.indexed, unchanged: stats.unchanged, disposed: stats.disposed, errors: stats.errors, chunks: stats.chunks });
  });

  /* ------------------------------ knowledge ----------------------------- */

  api.get('/w/:owner/:workspace/search', async (c) => {
    const ctx = need(c, 'read');
    const q = c.req.query('q');
    if (!q) throw new HttpError(400, 'q required');
    const mode = (c.req.query('mode') ?? 'hybrid') as SearchMode;
    if (!['hybrid', 'vector', 'keyword', 'sag'].includes(mode)) throw new HttpError(400, `unsupported search mode: ${mode}`);
    const k = Math.min(Math.max(Number(c.req.query('k') ?? 8) || 8, 1), 50);
    return c.json(await search(ctx.store, ctx.embedder, q, { k, mode, heat: ctx.config.heat, sag: ctx.config.retrieval.sag, asOf: c.req.query('as_of') || undefined }));
  });

  api.get('/w/:owner/:workspace/graph', async (c) => {
    const ctx = need(c, 'read');
    const q = c.req.query('q');
    if (q) return c.json(await graphSearch(ctx.store, q, { depth: Math.min(Number(c.req.query('depth') ?? 2) || 2, 4), heat: ctx.config.heat }));
    return c.json(await graphOverview(ctx.store, Math.min(Number(c.req.query('limit') ?? 120) || 120, 500)));
  });

  api.get('/w/:owner/:workspace/claims', async (c) => {
    const ctx = need(c, 'read');
    return c.json(await queryClaims(ctx.store, {
      subject: c.req.query('subject') || undefined,
      object: c.req.query('object') || undefined,
      text: c.req.query('text') || undefined,
      limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 500),
    }));
  });

  api.get('/w/:owner/:workspace/entities', async (c) => {
    const ctx = need(c, 'read');
    return c.json(await listEntities(ctx.store, c.req.query('q') || undefined));
  });

  /* --------------------------------- sql -------------------------------- */

  api.get('/w/:owner/:workspace/sql/views', (c) => {
    need(c, 'sql');
    return c.json({ views: CATALOG_VIEWS });
  });

  api.post('/w/:owner/:workspace/sql', async (c) => {
    const ctx = need(c, 'sql');
    const b = await body(c);
    if (typeof b.sql !== 'string' || !b.sql.trim()) throw new HttpError(400, 'sql required');
    return c.json(await catalogQuery(ctx.store, b.sql, { maxRows: Number(b.maxRows) || undefined }));
  });

  // the UI's catch-all must not answer for an unknown API path
  api.all('*', (c) => c.json({ error: 'not found' }, 404));

  app.route('/remote/v1', api);
}
