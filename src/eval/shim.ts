import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { LlmEffort, LlmSpeed } from '../config.js';
import { estimateEmbeddingTokens } from '../ingest/embedding-tokens.js';
import type { EmbeddingProvider } from '../ingest/embeddings.js';
import { cliCommand, codexExecArgs, renderCliPrompt, resolveExecutable, runProcess } from '../llm/cli.js';
import type { ChatMessage, LlmClient } from '../llm/client.js';
import { exitFailure, withCodexCatalog } from '../llm/codex-catalog.js';
import { CallUsage, readCodexEvents } from '../llm/usage.js';
import { isRefusal } from '../estimate/ledger.js';
import { classifyFailure } from '../labeling/failures.js';
import { Meter, MeterTag, parseTag } from './meter.js';
import type { EmbeddingBudget } from './quota.js';
import { fileLines } from './runstore.js';
import { evalTempDir } from './tmp.js';

/**
 * The model gateway every system under test talks to (docs/design/23 §4).
 *
 * An OpenAI-compatible server on 127.0.0.1 (an OS-assigned port, alive for
 * the length of a run) that answers `/v1/chat/completions` from one backend —
 * Codex in a benchmark run — and `/v1/embeddings` from knode's embedding
 * provider. knode workspaces under test and the external Python systems are
 * all pointed at it, so they all use the same model and are all metered the
 * same way: the bearer token carries the tag (`sys=…;stage=…;task=…`) that
 * says which system, stage and task a call belongs to.
 *
 * A Codex call can take minutes. Headers go out at once and whitespace keeps
 * the body alive (fetch's body timeout is 300 s), and a failure after Codex
 * spent tokens is reported in a 200 body, never a 5xx a client would retry.
 * A failure that spent nothing and should pass (the model at capacity, the
 * network) is tried again here, outside the slot, after a backoff.
 */

export interface ChatRequest {
  messages: ChatMessage[];
  json: boolean;
  /** A strict JSON schema for the reply (Codex `--output-schema`). */
  schema?: unknown;
  effort?: LlmEffort;
  /** Which system, stage and task the call is for (a remote worker's log, Tasks). */
  tag?: MeterTag;
}

export interface ChatResult {
  text: string;
  usage: CallUsage | null;
  /** The model that answered, for pricing. */
  model: string;
  /** The remote worker that answered (docs/design/27 §8); absent = this machine. */
  worker?: string;
  /** The CLI and model it ran on; absent = the backend's label. */
  backend?: string;
  /** The pool of the worker that answered (docs/design/32 §2). */
  pool?: string;
}

export interface ChatBackend {
  readonly label: string;
  /** It bounds its own work here (src/eval/remote.ts): the shim does not hold one of its slots for it. */
  readonly selfLimiting?: boolean;
  complete(req: ChatRequest): Promise<ChatResult>;
}

/** One `codex exec` per call, in a fresh empty directory, read-only. */
export class CodexBackend implements ChatBackend {
  readonly label: string;

  constructor(private readonly opts: { model?: string; command?: string; timeoutMs?: number; speed?: LlmSpeed } = {}) {
    this.label = `codex-cli:${opts.model || 'default'}`;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const tmp = evalTempDir('codex');
    const cwd = tmp.root;
    const outFile = path.join(cwd, 'reply.txt');
    try {
      const schemaFile = path.join(cwd, 'schema.json');
      if (req.schema) fs.writeFileSync(schemaFile, JSON.stringify(req.schema));
      const cmd = cliCommand('codex-cli', this.opts.command ?? '');
      // the model catalog from a local copy (src/llm/codex-catalog.ts): a run can make a thousand calls an hour
      const r = await withCodexCatalog(resolveExecutable(cmd), this.opts.model, (catalog) => {
        const args = codexExecArgs({ outFile, cwd, model: this.opts.model, effort: req.effort, speed: this.opts.speed, catalog });
        if (req.schema) args.splice(args.length - 1, 0, '--output-schema', schemaFile);
        return runProcess(cmd, args, renderCliPrompt(req.messages, req.json), this.opts.timeoutMs ?? 900_000);
      }, exitFailure);
      const events = readCodexEvents(r.stdout);
      const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
      if (r.code !== 0 || !text) {
        const err = new Error(`codex exec failed (${r.code}): ${events.error ?? r.stderr.slice(-300)}`) as Error & { usage?: CallUsage | null };
        err.usage = events.usage;
        throw err;
      }
      return { text, usage: events.usage, model: this.opts.model || 'codex' };
    } finally {
      tmp.cleanup();
    }
  }
}

/** Any knode LLM client as a backend — the tests' fake endpoint, or another model. */
export class ClientBackend implements ChatBackend {
  readonly label: string;

  constructor(private readonly client: LlmClient) {
    this.label = client.label;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    let usage: CallUsage | null = null;
    const messages = req.schema
      ? [...req.messages, { role: 'user' as const, content: `Reply with JSON matching this schema:\n${JSON.stringify(req.schema)}` }]
      : req.messages;
    const text = await this.client.complete(messages, { json: req.json || Boolean(req.schema), effort: req.effort, onUsage: (u) => (usage = u) });
    return { text, usage, model: this.client.model };
  }
}

/** Counting semaphore: at most `n` backend calls at once across every system. */
export class Slots {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly n: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface CachedReply {
  k: string;
  text: string;
  usage: CallUsage | null;
  model: string;
  ms: number;
  worker?: string;
  backend?: string;
}

/** Replies already paid for, keyed by what was asked. A resumed run replays them at their original cost. */
export class ReplyCache {
  private map = new Map<string, CachedReply>();

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      for (const line of fileLines(file)) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as CachedReply;
          this.map.set(r.k, r);
        } catch {
          /* torn line */
        }
      }
    }
  }

  get(k: string): CachedReply | undefined {
    return this.map.get(k);
  }

  put(r: CachedReply): void {
    this.map.set(r.k, r);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(r) + '\n');
  }
}

/** The vector cache's key for a text under an embedding identity. */
export function vectorKey(model: string, text: string): string {
  return crypto.createHash('sha256').update(`${model}|${text}`).digest('hex');
}

/**
 * Vectors by text, shared by every system so the shared embedding pool embeds
 * each text once per run. They are kept as the Float32 they are stored as: a
 * pilot's cache holds over a hundred thousand.
 */
export class VectorCache {
  private map = new Map<string, Float32Array>();

  constructor(private readonly file: string | null) {
    this.reload();
  }

  /**
   * Read the file again: vectors another run's copy put there after this cache was opened (`reuseBuilds`
   * copies them once the run's state exists). Without it a run that reuses builds checked its embedding
   * endpoint against an empty cache on its first start and fell back to the workspace's embedder.
   */
  reload(): void {
    const file = this.file;
    if (!file || !fs.existsSync(file)) return;
    for (const line of fileLines(file)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { k: string; v: string };
        this.map.set(r.k, float32Of(r.v));
      } catch {
        /* torn line */
      }
    }
  }

  get(k: string): number[] | undefined {
    const v = this.map.get(k);
    return v && Array.from(v);
  }

  put(k: string, v: number[]): void {
    const f = Float32Array.from(v);
    this.map.set(k, f);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify({ k, v: Buffer.from(f.buffer).toString('base64') }) + '\n');
  }
}

/** A base64 Float32 vector — read from the buffer's own bytes, not the pool Node may have put it in. */
function float32Of(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function decodeVector(b64: string): number[] {
  return Array.from(float32Of(b64));
}

/** An embedder that consults the run's vector cache and meters what it actually sends. */
export class MeteredEmbedder implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly cache: VectorCache,
    private readonly meter: Meter,
    private readonly tag: () => MeterTag,
    private readonly cap: { tokens: number; used: number } = { tokens: Infinity, used: 0 },
    private readonly budget: EmbeddingBudget | null = null,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.embedAs(this.tag(), texts);
  }

  async embedAs(tag: MeterTag, texts: string[]): Promise<number[][]> {
    const keys = texts.map((t) => vectorKey(this.inner.model, t));
    const missing = [...new Set(keys.filter((k) => !this.cache.get(k)))];
    if (missing.length) {
      const byKey = new Map(keys.map((k, i) => [k, texts[i]]));
      const batch = missing.map((k) => byKey.get(k)!);
      const tokens = batch.reduce((s, t) => s + estimateEmbeddingTokens(t), 0);
      if (this.cap.used + tokens > this.cap.tokens) throw new Error(`embedding token cap reached (${this.cap.tokens} for this run)`);
      const why = this.budget?.check(tokens);
      if (why) throw this.budget!.refuse(why);
      const t0 = Date.now();
      let vectors: number[][];
      try {
        vectors = await this.inner.embed(batch);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/daily quota|pool unavailable|\b429\b/i.test(msg)) this.budget?.poolRefused(msg);
        throw err;
      }
      this.cap.used += tokens;
      missing.forEach((k, i) => this.cache.put(k, vectors[i]));
      this.meter.record({ ...tag, model: this.inner.model, ms: Date.now() - t0, ok: true, replayed: false, usage: null, embeddingTokens: tokens, embeddingCalls: 1 });
    }
    return keys.map((k) => this.cache.get(k)!);
  }
}

/**
 * What two shims of one run share (docs/design/27 §8): the reply and vector
 * caches, this machine's slots and the embedding cap — one shim offers calls
 * to remote workers, the other, for a private pack, never does.
 */
export interface ShimState {
  replies: ReplyCache;
  vectors: VectorCache;
  slots: Slots;
  cap: { tokens: number; used: number };
}

export function shimState(opts: { cacheDir?: string; slots?: number; embeddingTokenCap?: number }): ShimState {
  return {
    replies: new ReplyCache(opts.cacheDir ? path.join(opts.cacheDir, 'replies.jsonl') : null),
    vectors: new VectorCache(opts.cacheDir ? path.join(opts.cacheDir, 'vectors.jsonl') : null),
    slots: new Slots(opts.slots ?? 6),
    cap: { tokens: opts.embeddingTokenCap ?? Infinity, used: 0 },
  };
}

/** A task id's repeat marker (`<task>~r<n>`, `eval run --repeat`): part of a reply's cache key, so a repeat asks again. */
export function repeatOf(task: string | undefined): string | null {
  return task ? /~r\d+$/.exec(task)?.[0] ?? null : null;
}

export interface ShimOptions {
  backend: ChatBackend;
  /** Caches, slots and cap shared with another shim of the run; absent, this shim's own. */
  state?: ShimState;
  embedder?: EmbeddingProvider;
  meter: Meter;
  /** Where the reply and vector caches live (the run's cache/); none = no cache. */
  cacheDir?: string;
  slots?: number;
  /** Reasoning effort by stage; `answer`, `agent` and `judge-answer` stages default to `answerEffort`. */
  buildEffort?: LlmEffort;
  answerEffort?: LlmEffort;
  embeddingTokenCap?: number;
  /** A daily budget on a shared embedding pool; refused embeddings are counted on it. */
  embeddingBudget?: EmbeddingBudget;
  keepAliveMs?: number;
  /** Tries again after a passing failure: the first wait, doubling up to 5 min (default 30 s). */
  retryBaseMs?: number;
  retries?: number;
}

export interface Shim {
  url: string;
  /** `http://127.0.0.1:<port>/v1` — what an OpenAI client takes as its base URL. */
  baseUrl: string;
  embedder: MeteredEmbedder | null;
  vectors: VectorCache;
  close: () => Promise<void>;
}

/** How long the shim keeps an idle connection open: past any client's own idle timeout (undici's is 4 s, or the hint less 2 s). */
export const KEEP_ALIVE_MS = 120_000;

const ANSWER_STAGES = new Set(['answer', 'agent', 'query', 'emergence']);

/**
 * Worth another try: Codex spent nothing and the cause should pass. A quota
 * refusal is not — the quota guard waits that out between batches.
 */
export function retryableFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // a piece the run left stuck, or stopped, is not asked again by the shim (docs/design/32 §3)
  if ((err as { final?: boolean } | null)?.final) return false;
  if ((err as { usage?: CallUsage | null }).usage || isRefusal(msg)) return false;
  return /at capacity/i.test(msg) || classifyFailure(msg) === 'transient';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  }
  return '';
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startShim(opts: ShimOptions): Promise<Shim> {
  const { slots, replies, vectors, cap } = opts.state ?? shimState(opts);
  const keepAlive = opts.keepAliveMs ?? 20_000;
  const retryBase = opts.retryBaseMs ?? 30_000;
  const retries = opts.retries ?? 5;
  const embedder = opts.embedder ? new MeteredEmbedder(opts.embedder, vectors, opts.meter, () => ({ system: 'unknown', stage: 'embed' }), cap, opts.embeddingBudget ?? null) : null;

  // requests being answered now, by cache key: an identical one joins the call instead of making another
  const inflight = new Map<string, Promise<CachedReply>>();
  const chat = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const modelName = typeof body.model === 'string' ? body.model : '';
    const tag = parseTag((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), modelName.includes('@') ? modelName.split('@')[1] : 'call');
    if (Array.isArray(body.tools) && body.tools.length) return sendJson(res, 400, { error: { message: 'tool calls are not supported by the eval shim', type: 'invalid_request_error' } });
    if (typeof body.n === 'number' && body.n > 1) return sendJson(res, 400, { error: { message: 'n > 1 is not supported by the eval shim', type: 'invalid_request_error' } });
    const raw = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
    const messages: ChatMessage[] = raw.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' || m.role === 'developer' ? 'system' : 'user',
      content: textOf(m.content),
    }));
    const format = (body.response_format ?? {}) as { type?: string; json_schema?: { schema?: unknown; strict?: boolean } };
    const strictSchema = format.type === 'json_schema' && format.json_schema?.strict ? format.json_schema.schema : undefined;
    if (format.type === 'json_schema' && !strictSchema && format.json_schema?.schema) {
      messages.push({ role: 'user', content: `Reply with JSON matching this schema:\n${JSON.stringify(format.json_schema.schema)}` });
    }
    const request: ChatRequest = {
      messages,
      json: format.type === 'json_object' || format.type === 'json_schema',
      schema: strictSchema,
      effort: ANSWER_STAGES.has(tag.stage) ? opts.answerEffort : opts.buildEffort,
      tag,
    };
    const stream = body.stream === true;
    const repeat = repeatOf(tag.task);
    const key = crypto.createHash('sha256').update(JSON.stringify([tag.system, messages, request.json, strictSchema ?? null, request.effort ?? null, ...(repeat ? [repeat] : [])])).digest('hex');

    // headers now: a Codex call can outlast any client's header timeout
    res.writeHead(200, stream ? { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } : { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write(stream ? ': ping\n\n' : ' '), keepAlive);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    try {
      let reply = replies.get(key);
      if (reply) {
        opts.meter.record({ ...tag, model: reply.model, ms: reply.ms, ok: true, replayed: true, usage: reply.usage, ...(reply.worker ? { worker: reply.worker } : {}), backend: reply.backend ?? opts.backend.label });
      } else if (inflight.has(key)) {
        // the same request is being answered already (a client that lost its connection and asked again): one call for both
        reply = await inflight.get(key)!;
      } else {
        const answered = askBackend();
        inflight.set(key, answered);
        try {
          reply = await answered;
        } finally {
          inflight.delete(key);
        }
      }
      async function askBackend(): Promise<CachedReply> {
        let reply: CachedReply | undefined;
        for (let attempt = 0; !reply; attempt++) {
          const t0 = Date.now();
          try {
            const r = opts.backend.selfLimiting ? await opts.backend.complete(request) : await slots.run(() => opts.backend.complete(request));
            const backend = r.backend ?? opts.backend.label;
            reply = { k: key, text: r.text, usage: r.usage, model: r.model, ms: Date.now() - t0, ...(r.worker ? { worker: r.worker } : {}), backend };
            replies.put(reply);
            opts.meter.record({ ...tag, model: r.model, ms: reply.ms, ok: true, replayed: false, usage: r.usage, ...(r.worker ? { worker: r.worker } : {}), ...(r.pool ? { pool: r.pool } : {}), backend });
          } catch (err) {
            opts.meter.record({ ...tag, model: opts.backend.label, ms: Date.now() - t0, ok: false, replayed: false, usage: (err as { usage?: CallUsage | null }).usage ?? null, backend: opts.backend.label });
            if (attempt >= retries || !retryableFailure(err)) throw err;
            await new Promise((resolve) => setTimeout(resolve, Math.min(5 * 60_000, retryBase * 2 ** attempt)));
          }
        }
        return reply;
      }
      const usage = { prompt_tokens: reply.usage?.inputTokens ?? 0, completion_tokens: reply.usage?.outputTokens ?? 0, total_tokens: (reply.usage?.inputTokens ?? 0) + (reply.usage?.outputTokens ?? 0) };
      if (stream) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelName, choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }], usage }));
      }
    } catch (err) {
      // 200 with an error body: the tokens are spent, and a client must not retry on its own
      const error = { message: err instanceof Error ? err.message : String(err), type: 'backend_error' };
      res.end(stream ? `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n` : JSON.stringify({ error }));
    } finally {
      clearInterval(timer);
    }
  };

  const embeddings = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!embedder) return sendJson(res, 404, { error: { message: 'no embedder configured for this run' } });
    const body = JSON.parse((await readBody(req)) || '{}') as { input?: unknown; model?: string; encoding_format?: string };
    const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
    const tag = parseTag((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), 'embed');
    try {
      const vectors = await embedder.embedAs(tag, inputs);
      const base64 = body.encoding_format === 'base64';
      const tokens = inputs.reduce((s, t) => s + estimateEmbeddingTokens(t), 0);
      sendJson(res, 200, {
        object: 'list',
        model: body.model ?? embedder.model,
        data: vectors.map((v, index) => ({ object: 'embedding', index, embedding: base64 ? Buffer.from(new Float32Array(v).buffer).toString('base64') : v })),
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // a refusal of a run that spends nothing (--replay-only) is final: a 429 would have the workspace's client try again
      sendJson(res, /\(--replay-only\)/.test(message) ? 422 : 429, { error: { message, type: 'embedding_error' } });
    }
  };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').replace(/\?.*$/, '').replace(/^\/v1/, '');
    const handle = async () => {
      if (req.method === 'GET' && url === '/models') {
        return sendJson(res, 200, { object: 'list', data: [{ id: 'codex', object: 'model', owned_by: 'knode-eval' }] });
      }
      if (req.method === 'POST' && url === '/chat/completions') return chat(req, res);
      if (req.method === 'POST' && url === '/embeddings') return embeddings(req, res);
      sendJson(res, 404, { error: { message: `no route ${req.method} ${req.url}` } });
    };
    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: { message: err instanceof Error ? err.message : String(err) } });
      else res.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  // an idle connection is closed by the client, not under it: Node's 5 s default raced the workspace's clients, which
  // reuse a connection idle for a few seconds, and lost a request to ECONNRESET now and then (the 10× build's end)
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    baseUrl: `${url}/v1`,
    embedder,
    vectors,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
