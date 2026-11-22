#!/usr/bin/env node
// knode-os remote labeling worker — one file, no dependencies, Node 20+.
//
// Takes work from a knode-os server (POST /remote/v1/.../work/lease) — extraction segments,
// summary pages, judge calls, translations and batches of texts to embed — runs each call on
// a model available on this machine, and hands back the raw reply or the raw vectors
// (…/work/complete). The server builds every prompt and every embedding input, and checks
// every reply and vector; this script only runs the calls. Leases are renewed while a call
// runs and handed back when the worker stops, so a stopped or crashed worker never strands work.
//
//   KNODE_TOKEN=knr_… node knode-worker.mjs --server https://knode-os.example \
//     --workspace admin/finance --backends codex:2,cursor:2
//
// Backends (slots after the colon):
//   codex   codex exec, read-only sandbox, ~/.codex/config.toml ignored, plugins, apps and analytics off,
//           Codex's model catalog read from a local copy (--codex-model, --codex-effort, --codex-speed,
//           --codex-catalog-hours: how long a copy lasts, default 24, 0 = download it on every call)
//   cursor  cursor-agent -p in ask mode (--cursor-model)
//   claude  claude -p, one turn (--claude-model, --claude-effort)
//   api     an OpenAI-compatible /chat/completions endpoint (--api-base-url, --api-model;
//           the key comes from the variable named by --api-key-env, default OPENAI_API_KEY)
//   embed   batches of texts to embed, on an OpenAI-compatible /embeddings endpoint of this machine's
//           own: --embed-base-url http://127.0.0.1:12020/v1 --embed-model BAAI/bge-m3 (a local
//           bge-m3, TEI, vLLM, Ollama, or an account of your own; a key, if it needs one, from the
//           variable named by --embed-key-env). The token needs the "embed" scope, and the server
//           takes the vectors only for its pool's model (canonical name: BAAI/bge-m3 = bge-m3) and
//           only once the endpoint passes calibration: it embeds the server's 16 probe texts at
//           startup and after every configuration change, and every vector must come within the
//           server's cosine (0.98) of the server's own. Spot checks follow; a miss parks the slots.
//
// Research sessions (--sessions codex:1,claude:1; docs/design/27): whole agent sessions of the server's research jobs,
// run on this machine's own Codex or Claude account. The token needs the "research" scope and the workspace must offer
// them (server.remote.offer.session). The server sends the session's fields — CLI, model, effort, turn cap, tool set,
// the schema and the prompt — and this script builds the command itself; it never runs a command line the server
// wrote. Each session runs in a fresh temporary folder with knode's MCP server as its only tool server, reached at
// <server>/remote/v1/w/<workspace>/sessions/<id>/mcp with a token of the session's own; it gets no file, shell or
// edit tools (Codex: read-only sandbox, so it can still read this machine's files — run a session worker as a user
// with nothing to hide). Its stdout goes to the server with each renewal (every 30 s); a renewal the server refuses
// (the job was cancelled, the server restarted) kills the CLI. --session-timeout-ms caps a session (default: the
// server's timeout, at most 6 h).
//
// Evaluation work (--eval codex:2,claude:1; docs/design/27 §8): an evaluation run's model calls (eval-call) and, on
// codex, its agent sessions (eval-session), run on this machine's own account. The token needs the "eval" scope and
// the server must offer them (server.remote.offer.eval). A task names the CLI family and model the run uses, and this
// worker runs exactly that model, so the run's results stay on one backend. A call is the prompt on stdin, with an
// output schema when the run gave one. A session is built here from its fields, as `knode-os eval run` builds it
// (read-only sandbox, no web, the step cap counted here): a file agent's folder comes as an archive downloaded once,
// kept by its SHA-256 (in KNODE_EVAL_CACHE_DIR, default the temp folder) and unpacked fresh for each session; an
// agent with knode's tools reaches the run's tools at <server>/remote/v1/w/<workspace>/eval-sessions/<id>/mcp with a
// token of the session's own. Its stdout goes back with each renewal (--session-renew-ms) and is parsed by the run.
// --pool <name> (default: the token's name; docs/design/32 §2) is the pool this worker's slots are in: a run started
// with `eval run --pool <name>` publishes work only slots of that pool take, so a benchmark that must stay on one
// backend names it once instead of a wrapper on each worker.
//
// Kinds of work (--kinds extract,summarize,judge,translate; default: every kind the server offers this token):
//   extract    extraction segments, answered with a JSON object
//   summarize  summary pages, answered in Markdown
//   judge      a review's judge calls (are two entities, or two claims, the same?), answered with
//              a JSON object; offered only where the server turned them on
//   translate  a document's segments translated into a content language, answered in Markdown;
//              offered where the workspace has content languages on (docs/design/17)
// The rest comes from the server (GET …/work/config): the kinds it offers, how long a lease
// lasts, and how it runs each kind on codex, claude and cursor — model, effort, speed. A CLI
// backend follows those unless its model is given here. A server that predates work/* hands
// out extraction only, over …/labeling/*.
//
// Other options: --name <worker> (default: hostname), --timeout-ms <ms> (default 600000), --idle-ms <ms> (poll wait),
// --header "Name: value" (repeatable; e.g. a Cloudflare Access service token),
// --token-file <path> (instead of KNODE_TOKEN), --once (exit when there is no work),
// --extract-first (do not lease summaries while extraction is queued or in flight;
//                  recheck before each lease, without cancelling calls already running),
// --check (show what the token may do, what the server offers, which backends are installed and — for embed —
// the embedding identity and whether the endpoint passes calibration, then exit).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/* ------------------------------- options -------------------------------- */

function parseArgs(argv) {
  const opts = { headers: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const flag = ['once', 'check', 'help', 'extract-first'].includes(key);
    const value = flag ? true : inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (key === 'header') opts.headers.push(value);
    else opts[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const server = String(args.server ?? process.env.KNODE_SERVER ?? '').replace(/\/+$/, '');
const workspace = String(args.workspace ?? process.env.KNODE_WORKSPACE ?? '');
const token = (args.tokenFile ? fs.readFileSync(String(args.tokenFile), 'utf8') : process.env.KNODE_TOKEN ?? '').trim();
const workerName = String(args.name ?? process.env.KNODE_WORKER_NAME ?? os.hostname());
// the pool every slot of this worker declares; none given, the server takes the token's name
const poolName = String(args.pool ?? process.env.KNODE_POOL ?? '').trim();
if (poolName && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(poolName)) throw new Error('--pool: a name of letters, digits, ".", "_" and "-" (at most 64)');
const poolField = poolName ? { pool: poolName } : {};
const timeoutMs = Number(args.timeoutMs ?? 600_000);
const sessionSpec = String(args.sessions ?? process.env.KNODE_SESSIONS ?? '');
const evalSpec = String(args.eval ?? process.env.KNODE_EVAL ?? '');
// research sessions or evaluation work alone: no call slots unless asked for
const backendSpec = String(args.backends ?? process.env.KNODE_BACKENDS ?? (sessionSpec || evalSpec ? '' : 'codex:1'));
const idleMs = Math.max(100, Number(args.idleMs ?? 20_000));
const KINDS = ['extract', 'summarize', 'judge', 'translate'];
const kindSpec = args.kinds ?? process.env.KNODE_KINDS;
const askedKinds = kindSpec ? String(kindSpec).split(',').map((k) => k.trim()).filter(Boolean) : null;
for (const k of askedKinds ?? []) {
  if (k === 'embed') throw new Error('embed work is taken by embed slots: use --backends embed:N with --embed-base-url and --embed-model');
  if (!KINDS.includes(k)) throw new Error(`unknown kind of work "${k}" — use ${KINDS.join(', ')}`);
}
if (!server || !/^https?:\/\//.test(server)) throw new Error('--server http(s)://… required (or KNODE_SERVER)');
if (!/^[^/]+\/[^/]+$/.test(workspace)) throw new Error('--workspace <user>/<workspace-id> required (or KNODE_WORKSPACE)');
if (!token) throw new Error('a token is required: KNODE_TOKEN=knr_… or --token-file <path>');
if (server.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(server)) {
  throw new Error('refusing to send the token over plain http to a remote host — use https, or an SSH tunnel to 127.0.0.1');
}
const extraHeaders = Object.fromEntries(args.headers.map((h) => {
  const i = h.indexOf(':');
  if (i < 1) throw new Error(`--header "Name: value", got ${h}`);
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
}));
const base = `${server}/remote/v1/w/${workspace.split('/').map(encodeURIComponent).join('/')}`;

// an own embedding endpoint (the embed backend)
const isLoopback = (url) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
const embedBaseUrl = String(args.embedBaseUrl ?? process.env.KNODE_EMBED_BASE_URL ?? '').replace(/\/+$/, '');
const embedModel = String(args.embedModel ?? process.env.KNODE_EMBED_MODEL ?? '');
const embedKey = args.embedKeyEnv ? String(process.env[String(args.embedKeyEnv)] ?? '') : '';
if (embedBaseUrl && !/^https?:\/\//.test(embedBaseUrl)) throw new Error('--embed-base-url http(s)://…/v1 required');
if (embedBaseUrl && !embedModel) throw new Error('--embed-base-url needs --embed-model (the model the endpoint serves, e.g. BAAI/bge-m3)');
if (args.embedKeyEnv && !embedKey) throw new Error(`--embed-key-env names ${args.embedKeyEnv}, which is not set`);
if (embedKey && embedBaseUrl.startsWith('http://') && !isLoopback(embedBaseUrl)) {
  throw new Error('refusing to send the embedding key over plain http to a remote host — use https');
}

/* ------------------------------- logging -------------------------------- */

const log = (msg) => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${msg}`);

/* ----------------------------- server calls ----------------------------- */

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok && res.status !== 409) {
    const err = new Error(`${method} ${url.replace(server, '')} → ${res.status}: ${data.error ?? res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data };
}

/* ------------------------ the server's configuration ------------------------ */

// GET …/work/config: the kinds this token may take here, lease length, model hints per kind and CLI.
// null for a server that predates work/*: extraction only, over …/labeling/*.
let work = null;
let reading = null;

async function readWorkConfig() {
  try {
    work = (await call('GET', `${base}/work/config`)).data;
  } catch (err) {
    // an older server answers a path it does not know with a bare 404; a missing workspace says so
    if (err.status !== 404 || /no workspace/.test(err.message)) throw err;
    work = null;
  }
}

/** Read the config again (a lease answer said it changed); one read at a time, failures logged. */
function rereadWorkConfig() {
  reading ??= readWorkConfig()
    .then(() => {
      // every configuration change means calibrating again before the next embed batch
      calibration = null;
      log(`server configuration changed: ${describeKinds()}`);
    })
    .catch((err) => log(`could not read the server configuration: ${err.message}`))
    .finally(() => (reading = null));
  return reading;
}

/** The kinds the LLM slots ask for: those given with --kinds, of the ones the server offers. */
function kindsNow() {
  const offered = work ? KINDS.filter((k) => work.kinds?.[k] === true) : ['extract'];
  return askedKinds ? askedKinds.filter((k) => offered.includes(k)) : offered;
}

let extractionPhase = null;

/** A failed or incomplete status read must never open the summary gate. */
async function kindsForLease() {
  const kinds = kindsNow();
  if (!args.extractFirst || !work || !kinds.includes('summarize')) return kinds;
  if (!kinds.includes('extract')) throw new Error('--extract-first requires permission to take extraction work');
  const { data } = await call('GET', `${base}/work/status`);
  const extract = data.kinds?.extract;
  const counts = [extract?.queued, extract?.openDocuments, extract?.readySegments];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0) || !Array.isArray(extract?.leases)) {
    throw new Error('cannot confirm extraction is drained: incomplete work status');
  }
  const pending = counts.some((n) => n > 0) || extract.leases.length > 0;
  const phase = pending ? 'extract' : 'summarize';
  if (extractionPhase !== phase) {
    extractionPhase = phase;
    log(pending
      ? `extract-first: extraction pending (${extract.queued} queued, ${extract.leases.length} leased); summaries wait`
      : 'extract-first: extraction drained; summaries may run');
  }
  return pending ? kinds.filter((kind) => kind !== 'summarize') : kinds;
}

function describeKinds() {
  if (!work) return 'a server from before work/* — extraction only';
  const offered = [...KINDS, 'embed', 'session', 'eval-call', 'eval-session'].filter((k) => work.kinds?.[k] === true);
  const takes = [
    ...(backends.some((b) => b.name !== 'embed') ? kindsNow() : []),
    ...(hasEmbedSlots && work.kinds?.embed === true ? ['embed'] : []),
    ...(sessionSlots.length && work.kinds?.session === true ? ['session'] : []),
    ...(evalSlots.length && work.kinds?.['eval-call'] === true ? ['eval-call'] : []),
    ...(evalSlots.some((s) => s.family === 'codex') && work.kinds?.['eval-session'] === true ? ['eval-session'] : []),
  ];
  return `offers ${offered.join(', ') || 'nothing to this token'}; this worker takes ${takes.join(', ') || 'nothing'}`;
}

/** How the server runs this kind of work on this CLI, unless this worker was given a model of its own. */
const hintFor = (kind, backend) => work?.hints?.[kind ?? 'extract']?.[backend] ?? null;

/* ------------------------- failures and backoff ------------------------- */
// a copy of src/labeling/failures.ts

const FATAL = /cli not found|\benoent\b|not logged in|login required|please (log|sign) ?in|unauthori[sz]ed|authentication (failed|required)|invalid api key|incorrect api key|\b401\b|\b403\b|forbidden|subscription (has )?expired/;
const TRANSIENT = /rate.?limit|usage limit|out of usage|hit your \w+ limit|quota|too many requests|\b429\b|overloaded|over capacity|try again (later|in)|\b50[234]\b|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|timed? ?out|reconnecting|transport channel closed|error sending request|http\/request failed|stream (disconnected|error)|connection (reset|closed|refused|error)|failed to refresh available models|\bebadf\b|\bemfile\b|\benfile\b|spawn \S+ e[a-z]+/;
const classify = (message) => {
  const m = String(message).toLowerCase();
  return FATAL.test(m) ? 'fatal' : TRANSIENT.test(m) ? 'transient' : 'model';
};

function newHealth() {
  return { transientStreak: 0, modelStreak: 0, cooldowns: 0, fatalStreak: 0, pausedUntil: 0, calls: 0, ok: 0, failed: 0 };
}

function rest(health, kind) {
  let ms = 0;
  if (kind === 'transient') ms = Math.min(600_000, 60_000 * 2 ** health.transientStreak++);
  else if (kind === 'fatal') ms = Math.min(6 * 3_600_000, 1_800_000 * 2 ** health.fatalStreak++);
  else if (++health.modelStreak >= 5) {
    health.modelStreak = 0;
    ms = Math.min(4 * 3_600_000, 1_800_000 * 2 ** health.cooldowns++);
  }
  if (ms) health.pausedUntil = Math.max(health.pausedUntil, Date.now() + ms);
  return ms;
}

/* ------------------------------- embedding ------------------------------- */
// An embed slot's call: OpenAI-compatible /embeddings with encoding_format "float", `dimensions` when the key
// sends them and OpenRouter's provider pin when it has an upstream — a copy of PooledEmbeddingProvider's
// request (src/ingest/embedding-router.ts). The vectors go back raw, as little-endian float32 in base64;
// the server checks and finishes them. An error body is never read: it may echo the key.

async function embedRequest(endpoint, inputs) {
  const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({
      model: endpoint.model, input: inputs, encoding_format: 'float',
      ...(endpoint.sendDimensions ? { dimensions: endpoint.dimensions } : {}),
      ...(endpoint.upstream ? { provider: { only: [endpoint.upstream], allow_fallbacks: false } } : {}),
    }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)),
  });
  if (!res.ok) {
    await res.body?.cancel();
    const err = new Error(`embedding endpoint returned HTTP ${res.status}`);
    err.http = { status: res.status };
    throw err;
  }
  const body = await res.json();
  const data = Array.isArray(body?.data) ? [...body.data].sort((a, b) => a.index - b.index) : null;
  if (!data || data.length !== inputs.length) throw new Error(`embedding response has ${data?.length ?? 'no'} vectors for ${inputs.length} inputs`);
  const vectors = data.map((d) => d?.embedding);
  if (!vectors.every((v) => Array.isArray(v) && v.length > 0)) throw new Error('embedding response has a vector that is no array of numbers');
  const tokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
  return { vectors, endpointModel: typeof body.model === 'string' ? body.model : null, tokens: count(tokens) || null };
}

/** Vectors as the server takes them: little-endian float32, n × dimensions, base64. */
function encodeVectors(vectors) {
  const dims = vectors[0]?.length ?? 0;
  const buf = Buffer.alloc(vectors.length * dims * 4);
  vectors.forEach((v, i) => v.forEach((x, j) => buf.writeFloatLE(Number(x), (i * dims + j) * 4)));
  return { vectors: buf.toString('base64'), dimensions: dims };
}

const ownEndpoint = embedBaseUrl ? { baseUrl: embedBaseUrl, model: embedModel, apiKey: embedKey, sendDimensions: false, upstream: null } : null;
let calibration = null; // the id the server gave this endpoint's calibration; null until it passes
let calibrating = null;
let embedParkedUntil = 0;
let embedNote = '';

/** Embed the server's probe set on the own endpoint and hand it in; true when the server takes the endpoint. */
async function calibrate() {
  const probe = work?.embedding?.probe;
  if (!ownEndpoint || !probe?.texts?.length) return false;
  let made;
  try {
    made = await embedRequest(ownEndpoint, probe.texts);
  } catch (err) {
    log(`embed: calibration could not reach ${ownEndpoint.baseUrl}: ${err.message} — trying again in 1 min`);
    embedParkedUntil = Date.now() + 60_000;
    return false;
  }
  const { data } = await call('POST', `${base}/work/calibrate`, {
    worker: workerName, model: ownEndpoint.model, ...(made.endpointModel ? { endpointModel: made.endpointModel } : {}), ...encodeVectors(made.vectors),
  });
  if (data.ok) {
    calibration = data.calibration;
    log(`embed: ${ownEndpoint.model} passed calibration for ${work.embedding.vectorModel} (cosine ≥ ${Number(data.minCosine).toFixed(4)}, mean ${Number(data.meanCosine).toFixed(4)})`);
    return true;
  }
  calibration = null;
  const waitMs = Math.max(60_000, Number(data.retryAfterSeconds ?? 900) * 1000);
  embedParkedUntil = Date.now() + waitMs;
  embedNote = data.reason ?? 'refused';
  log(`embed: the server refused ${ownEndpoint.model} at ${ownEndpoint.baseUrl}: ${embedNote}${Number.isFinite(data.minCosine) ? ` (lowest cosine ${Number(data.minCosine).toFixed(4)})` : ''} — calibrating again in ${Math.round(waitMs / 60_000)} min`);
  return false;
}

/* ------------------------------- backends ------------------------------- */

const children = new Set();

// A one-turn `claude -p` call with no built-in tools and no MCP servers: with tools on offer the model now and then
// spends its only turn calling one, and the call fails on "Reached maximum number of turns (1)". A Claude CLI too
// old to know the flags is run without them from then on.
const CLAUDE_NO_TOOLS = ['--tools', '', '--strict-mcp-config'];
const claudeWithoutNoTools = new Set();
async function runClaudePrint(cmd, argv, stdin, cwd, limitMs = timeoutMs) {
  if (claudeWithoutNoTools.has(cmd)) return run(cmd, argv, stdin, cwd, limitMs);
  const r = await run(cmd, [...argv, ...CLAUDE_NO_TOOLS], stdin, cwd, limitMs);
  if (r.code === 0 || !(/unknown option/i.test(r.stderr) && /--tools|--strict-mcp-config/.test(r.stderr))) return r;
  claudeWithoutNoTools.add(cmd);
  return run(cmd, argv, stdin, cwd, limitMs);
}

function run(cmd, argv, stdin, cwd, limitMs = timeoutMs, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${cmd} timed out after ${Math.round(limitMs / 1000)}s`)));
    }, limitMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => finish(() => reject(err.code === 'ENOENT' ? new Error(`${cmd} CLI not found`) : err)));
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const tail = (stderr, stdout) => {
  const t = (stderr || stdout).trim();
  return t.length > 400 ? `…${t.slice(-400)}` : t;
};

/** An empty folder for one call: no repo instructions to pick up, nothing to touch. */
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knode-worker-'));
}

/* ------------------------ codex's model catalog ------------------------- */
// A copy of src/llm/codex-catalog.ts. Every codex exec downloads Codex's whole model catalog as it starts (650 KB,
// once or twice a call; it changes about once a day), so a call reads it from a local copy instead, passed as
// -c model_catalog_json. The copy is Codex's own cache ($CODEX_HOME/models_cache.json) — its whole model list —
// taken after a call without a copy, if Codex wrote it in the last ten minutes, for this binary's version, with
// the call's model in it. It belongs to one binary (real path, size, mtime) and model, lasts --codex-catalog-hours
// (default 24; 0 = off) and lives in ~/.knode-os/codex-catalog (KNODE_CODEX_CATALOG_DIR). A copy Codex cannot read
// is dropped and the call repeated once without it.

const catalogHours = (() => {
  const v = args.codexCatalogHours ?? process.env.KNODE_CODEX_CATALOG_HOURS;
  const h = v === undefined || String(v).trim() === '' ? NaN : Number(v);
  return Number.isFinite(h) && h >= 0 ? h : 24;
})();
const catalogDir = process.env.KNODE_CODEX_CATALOG_DIR || path.join(os.homedir(), '.knode-os', 'codex-catalog');
const codexVersions = new Map(); // binary stamp → Promise<last word of `codex --version`>
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function which(bin) {
  const candidates = bin.includes('/') ? [path.resolve(bin)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, bin));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Where the copy for this binary and model lives, or null (no model named, copies off, binary not found). */
function codexCatalog(bin, model) {
  if (!model || catalogHours <= 0) return null;
  const found = which(bin);
  if (!found) return null;
  try {
    const real = fs.realpathSync(found);
    const st = fs.statSync(real, { bigint: true });
    const stamp = sha(`${real}\0${st.size}\0${st.mtimeNs}`).slice(0, 16);
    return { real, stamp, model, file: path.join(catalogDir, `codex-models-${stamp}-${sha(model).slice(0, 8)}.json`) };
  } catch {
    return null;
  }
}

function pinnedCatalog(catalog) {
  if (!catalog) return null;
  try {
    const age = Date.now() - fs.statSync(catalog.file).mtimeMs;
    return age > -1000 && age < catalogHours * 3_600_000 ? catalog.file : null;
  } catch {
    return null;
  }
}

function codexVersion(real) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(real, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const words = out.trim().split(/\s+/).filter(Boolean);
      resolve(code === 0 && words.length ? words[words.length - 1] : null);
    });
  });
}

/** After a call without a copy: copy Codex's cache if it is usable. */
async function refreshCatalog(catalog) {
  if (!catalog) return;
  let cache;
  try {
    const source = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    if (Date.now() - fs.statSync(source).mtimeMs > 600_000) return;
    cache = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch {
    return;
  }
  const models = cache?.models;
  if (!Array.isArray(models) || !models.some((m) => m?.slug === catalog.model)) return;
  if (!codexVersions.has(catalog.stamp)) codexVersions.set(catalog.stamp, codexVersion(catalog.real));
  const version = await codexVersions.get(catalog.stamp);
  if (!version) codexVersions.delete(catalog.stamp);
  if (!version || cache.client_version !== version) return;
  // a temp file and a rename: other slots may be starting codex with this copy right now
  const partial = `${catalog.file}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.part`;
  try {
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(partial, JSON.stringify({ models }));
    fs.renameSync(partial, catalog.file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    log(`codex model catalog not saved: ${err.message}`);
    return;
  }
  // copies long past their lifetime (another binary's or model's), and temp files a crashed writer left
  const keep = Math.max(2 * catalogHours, catalogHours + 1) * 3_600_000;
  for (const name of fs.readdirSync(catalogDir)) {
    if (!name.startsWith('codex-models-')) continue;
    try {
      const age = Date.now() - fs.statSync(path.join(catalogDir, name)).mtimeMs;
      if (age > (name.endsWith('.part') ? 3_600_000 : keep)) fs.rmSync(path.join(catalogDir, name), { force: true });
    } catch {
      // gone already
    }
  }
  log(`codex model catalog saved for ${catalogHours} h: ${models.length} models for ${catalog.model}, codex ${version}`);
}

/** Whether a failed call failed because of its copy: Codex could not parse it (dropped) or it was gone. */
function catalogRejected(file, stderr) {
  if (stderr.includes('model_catalog_json')) {
    fs.rmSync(file, { force: true });
    return true;
  }
  return !fs.existsSync(file);
}

/* --------------------------------- usage --------------------------------- */
// What a call used, as its CLI or endpoint reported it (a copy of src/llm/usage.ts): every token read — cache
// reads and writes included — as inputTokens, every token written, reasoning included, as outputTokens. It goes
// back with the answer, so the server's estimates learn from this machine's calls too (docs/design/18).

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const counted = (u) => (u.inputTokens > 0 || u.outputTokens > 0 ? u : null);

/** codex exec --json: each turn.completed's usage added up, and a failed turn's reason. */
function readCodexEvents(stdout) {
  const u = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let error = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'turn.completed') {
      const t = event.usage ?? {};
      u.inputTokens += count(t.input_tokens);
      u.cachedInputTokens += count(t.cached_input_tokens);
      u.cacheWriteTokens += count(t.cache_write_input_tokens);
      u.outputTokens += count(t.output_tokens);
      u.reasoningTokens += count(t.reasoning_output_tokens);
    } else if (event.type === 'turn.failed' && typeof event.error?.message === 'string') error = event.error.message.trim();
    else if (event.type === 'error' && typeof event.message === 'string') error ??= event.message.trim();
  }
  return { usage: counted(u), error };
}

/** Claude's and Cursor's counts: cache reads and writes beside the input. */
function cachedUsage(input, read, write, output, cost) {
  const u = counted({ inputTokens: count(input) + count(read) + count(write), cachedInputTokens: count(read), cacheWriteTokens: count(write), outputTokens: count(output), reasoningTokens: 0 });
  if (u && count(cost)) u.costUsd = cost;
  return u;
}

/** Chat Completions' usage. */
function chatUsage(body) {
  const t = body?.usage ?? {};
  return counted({
    inputTokens: count(t.prompt_tokens), cachedInputTokens: count(t.prompt_tokens_details?.cached_tokens), cacheWriteTokens: 0,
    outputTokens: count(t.completion_tokens), reasoningTokens: count(t.completion_tokens_details?.reasoning_tokens),
  });
}

/** cursor-agent's NDJSON stream → the answer after its last tool call (a copy of src/llm/cli.ts readCursorStream). */
function readCursorStream(stdout) {
  const chunks = [];
  let result = '';
  let error;
  let usage = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      const parts = Array.isArray(event.message?.content) ? event.message.content : [];
      const text = parts.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text ?? '') : '')).join('');
      if (text.trim()) chunks.push(text);
    } else if (event.type === 'tool_call' && event.subtype === 'started') {
      chunks.length = 0;
    } else if (event.type === 'result') {
      if (event.is_error || event.subtype === 'error') error = String(event.result ?? 'unknown');
      else result = String(event.result ?? '');
      const t = event.usage ?? {};
      usage = cachedUsage(t.inputTokens, t.cacheReadTokens, t.cacheWriteTokens, t.outputTokens) ?? usage;
    }
  }
  return { text: chunks.join('\n').trim() || result.trim(), error, usage };
}

// A backend given a model here ignores the server's hint for it (an effort chosen for another model);
// otherwise the hint's model, effort and speed apply, each unless given here.
const own = (model, hint) => (model ? null : hint);

const BACKENDS = {
  codex: {
    bin: () => String(args.codexBin ?? 'codex'),
    label: (hint) => `codex:${args.codexModel ?? own(args.codexModel, hint)?.model ?? 'default'}`,
    async complete(task, hint, report) {
      const h = own(args.codexModel, hint);
      const model = args.codexModel ?? h?.model;
      const effort = args.codexEffort ?? h?.effort;
      const speed = args.codexSpeed ?? h?.speed;
      const dir = scratch();
      const out = path.join(dir, 'answer.txt');
      const ws = path.join(dir, 'workspace');
      fs.mkdirSync(ws);
      const catalog = codexCatalog(this.bin(), model ? String(model) : '');
      let pinned = pinnedCatalog(catalog);
      try {
        // plugins on would download ChatGPT's whole plugin catalog (~15 MB) on every call, apps on the apps
        // listing (~1 MB); analytics on uploads ~0.65 MB of metrics at exit. `-c`, unlike --disable, is ignored
        // by a Codex without them. The model catalog comes from the local copy when there is one (above).
        // --json prints the turn's token usage; the answer still comes from --output-last-message.
        const argv = () => [
          'exec', '--ignore-user-config', '--ephemeral', '-c', 'features.plugins=false', '-c', 'features.apps=false',
          '-c', 'analytics.enabled=false', ...(pinned ? ['-c', `model_catalog_json=${JSON.stringify(pinned)}`] : []),
          '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', ws, '--output-last-message', out, '--json',
          ...(model ? ['--model', String(model)] : []),
          ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
          ...(speed ? ['-c', `service_tier="${speed}"`] : []),
          '-',
        ];
        let r;
        for (;;) {
          try {
            r = await run(this.bin(), argv(), task.prompt, ws);
          } finally {
            if (!pinned) await refreshCatalog(catalog);
          }
          if (!pinned || r.code === 0 || !catalogRejected(pinned, r.stderr)) break;
          log(`codex could not read the saved model catalog, calling without it: ${tail(r.stderr, '')}`);
          pinned = null;
        }
        const events = readCodexEvents(r.stdout);
        if (events.usage) report(events.usage);
        if (r.code !== 0) throw new Error(`codex exec exited with code ${r.code}: ${events.error ?? tail(r.stderr, r.stdout)}`);
        const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
        if (!text) throw new Error(`codex exec finished but produced no message${events.error ? `: ${events.error}` : ''}`);
        return text;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  cursor: {
    bin: () => String(args.cursorBin ?? 'cursor-agent'),
    label: (hint) => `cursor:${args.cursorModel ?? hint?.model ?? 'default'}`,
    async complete(task, hint, report) {
      const model = args.cursorModel ?? hint?.model;
      const dir = scratch();
      try {
        const argv = ['-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', dir];
        if (model) argv.push('--model', String(model));
        const r = await run(this.bin(), argv, task.prompt, dir);
        const { text, error, usage } = readCursorStream(r.stdout);
        if (usage) report(usage);
        if (error || r.code !== 0) throw new Error(`cursor CLI error: ${error ? error.slice(0, 400) : tail(r.stderr, r.stdout)}`);
        if (!text) throw new Error('cursor-agent finished but produced no message');
        return text;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  claude: {
    bin: () => String(args.claudeBin ?? 'claude'),
    label: (hint) => `claude:${args.claudeModel ?? own(args.claudeModel, hint)?.model ?? 'default'}`,
    async complete(task, hint, report) {
      const h = own(args.claudeModel, hint);
      const model = args.claudeModel ?? h?.model;
      const effort = args.claudeEffort ?? h?.effort;
      const dir = scratch();
      try {
        const argv = ['-p', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'];
        if (model) argv.push('--model', String(model));
        if (effort) argv.push('--effort', String(effort));
        const r = await runClaudePrint(this.bin(), argv, task.prompt, dir);
        let wrapper = null;
        try {
          wrapper = JSON.parse(r.stdout);
        } catch {
          // fall through
        }
        if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
          const t = wrapper.usage ?? {};
          const usage = cachedUsage(t.input_tokens, t.cache_read_input_tokens, t.cache_creation_input_tokens, t.output_tokens, wrapper.total_cost_usd);
          if (usage) report(usage);
          if (wrapper.is_error || r.code !== 0) throw new Error(`claude CLI error: ${String(wrapper.result ?? 'unknown').slice(0, 400)}`);
          return String(wrapper.result ?? '').trim();
        }
        if (r.code !== 0) throw new Error(`claude exited with code ${r.code}: ${tail(r.stderr, r.stdout)}`);
        return r.stdout.trim();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  embed: {
    bin: () => null,
    label: () => `embed:${embedModel || 'no endpoint'}`,
    complete() {
      throw new Error('embed slots take only embed batches');
    },
  },
  api: {
    bin: () => null,
    label: () => `api:${args.apiModel ?? process.env.KNODE_API_MODEL ?? '?'}`,
    async complete(task, hint, report) {
      const baseUrl = String(args.apiBaseUrl ?? process.env.KNODE_API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
      const model = String(args.apiModel ?? process.env.KNODE_API_MODEL ?? '');
      const key = process.env[String(args.apiKeyEnv ?? 'OPENAI_API_KEY')] ?? '';
      if (!baseUrl || !model) throw new Error('api backend needs --api-base-url and --api-model (CLI not found)');
      // a summary is Markdown; only a task that wants JSON (every one from an older server) asks for JSON mode
      const json = task.json !== false;
      const request = JSON.stringify({ model, messages: task.messages, temperature: 0.2, max_tokens: task.maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) });
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: request,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`chat request failed (${res.status}): ${body.slice(0, 300)}`);
      const parsed = JSON.parse(body);
      const usage = chatUsage(parsed);
      if (usage) report({ ...usage, bytesUp: Buffer.byteLength(request), bytesDown: Buffer.byteLength(body) });
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('chat response had no content');
      return content;
    },
  },
};

const backends = backendSpec.split(',').filter((part) => part.trim()).map((part) => {
  const [name, n] = part.trim().split(':');
  if (!BACKENDS[name]) throw new Error(`unknown backend "${name}" — use ${Object.keys(BACKENDS).join(', ')}`);
  const slots = Math.max(0, Math.min(16, Number(n ?? 1)));
  if (!Number.isFinite(slots)) throw new Error(`bad slot count in "${part}"`);
  return { name, slots, impl: BACKENDS[name], health: newHealth() };
}).filter((b) => b.slots > 0);
const SESSION_FAMILIES = { codex: () => String(args.codexBin ?? 'codex'), claude: () => String(args.claudeBin ?? 'claude') };
const sessionSlots = sessionSpec.split(',').filter((part) => part.trim()).map((part) => {
  const [family, n] = part.trim().split(':');
  if (!SESSION_FAMILIES[family]) throw new Error(`research sessions run on ${Object.keys(SESSION_FAMILIES).join(' or ')}, not "${family}"`);
  const slots = Math.max(0, Math.min(8, Number(n ?? 1)));
  if (!Number.isFinite(slots)) throw new Error(`bad slot count in "${part}"`);
  return { family, slots, bin: SESSION_FAMILIES[family], health: newHealth() };
}).filter((s) => s.slots > 0);
const EVAL_FAMILIES = { codex: () => String(args.codexBin ?? 'codex'), claude: () => String(args.claudeBin ?? 'claude') };
const evalCacheDir = process.env.KNODE_EVAL_CACHE_DIR || path.join(os.tmpdir(), 'knode-worker-eval');
// sessions are Codex's: the run's agents are `codex exec` sessions
const evalKindsFor = (family) => (family === 'codex' ? ['eval-call', 'eval-session'] : ['eval-call']);
const evalSlots = evalSpec.split(',').filter((part) => part.trim()).map((part) => {
  const [family, n] = part.trim().split(':');
  if (!EVAL_FAMILIES[family]) throw new Error(`evaluation work runs on ${Object.keys(EVAL_FAMILIES).join(' or ')}, not "${family}"`);
  const slots = Math.max(0, Math.min(16, Number(n ?? 1)));
  if (!Number.isFinite(slots)) throw new Error(`bad slot count in "${part}"`);
  return { family, slots, bin: EVAL_FAMILIES[family], health: newHealth() };
}).filter((s) => s.slots > 0);
if (backends.length === 0 && sessionSlots.length === 0 && evalSlots.length === 0) throw new Error('no backend has a slot (--backends, --sessions, --eval)');
const hasEmbedSlots = backends.some((b) => b.name === 'embed');
if (hasEmbedSlots && !ownEndpoint) {
  throw new Error('embed slots need an endpoint of this machine\'s own: --embed-base-url http://…/v1 --embed-model <model> (lent keys are not taken yet)');
}

/* ------------------------------ check mode ------------------------------ */

function onPath(bin) {
  if (!bin) return true;
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

if (args.check) {
  const { data } = await call('GET', `${server}/remote/v1/whoami`);
  log(`token ${data.name} (${data.id}): scopes ${data.scopes?.join(', ')}${data.kinds ? ` (work: ${data.kinds.join(', ')})` : ''}; workspaces ${data.workspaces?.join(', ')}`);
  log(`pool ${poolName || data.name}${poolName ? '' : ' (the token\'s name; --pool names another)'}: work a run publishes for another pool is not leased here`);
  await readWorkConfig();
  log(`${workspace}: ${describeKinds()}`);
  if (work) {
    const { data: status } = await call('GET', `${base}/work/status`);
    const extract = status.kinds?.extract;
    const summaries = status.kinds?.summarize;
    if (extract) log(`extraction: ${extract.queued} documents queued, ${extract.leases?.length ?? 0} segments out`);
    if (summaries) log(`summaries: ${summaries.due} documents due at the last look, ${summaries.leases?.length ?? 0} out`);
    const judge = status.kinds?.judge;
    if (judge) log(`judge calls: ${judge.waiting} waiting on a review, ${judge.leases?.length ?? 0} out`);
    const translations = status.kinds?.translate;
    if (translations?.enabled) log(`translations into ${translations.primary}: ${translations.due} due at the last look, ${translations.leases?.length ?? 0} segments out`);
    const vectors = status.kinds?.embed;
    if (vectors?.mode === 'deferred') log(`embedding: ${vectors.backlog ?? '?'} chunks without a vector, ${vectors.leases?.length ?? 0} batches out`);
    log(`${status.workers?.length ?? 0} workers seen`);
    const emb = work.embedding;
    if (hasEmbedSlots) {
      if (!emb) log('embed: not offered to this token here (it needs the "embed" scope, and the workspace ingest.embedding "deferred")');
      else {
        log(`embed: vectors as ${emb.vectorModel} (${emb.dimensions} dimensions, batches of ${emb.batchSize}); own endpoints ${emb.ownEndpoints ? 'taken' : 'not taken for this identity'}`);
        if (emb.ownEndpoints) await calibrate();
      }
    }
  } else {
    const { data: status } = await call('GET', `${base}/labeling/status`);
    log(`${workspace}: ${status.queued} documents queued, ${status.leases?.length ?? 0} segments out, ${status.workers?.length ?? 0} workers seen`);
  }
  for (const b of backends) {
    if (b.name === 'embed') {
      log(`backend embed × ${b.slots}: ${ownEndpoint.baseUrl} (${ownEndpoint.model})${calibration ? ' — calibrated' : embedNote ? ` — refused: ${embedNote}` : ''}`);
      continue;
    }
    const runs = kindsNow().map((kind) => `${kind} on ${b.impl.label(hintFor(kind, b.name))}`);
    log(`backend ${b.name} × ${b.slots}: ${onPath(b.impl.bin()) ? 'installed' : 'NOT FOUND on PATH'} (${runs.join(', ') || b.impl.label(null)})`);
  }
  for (const s of sessionSlots) {
    const offered = work?.kinds?.session === true;
    log(`research sessions on ${s.family} × ${s.slots}: ${onPath(s.bin()) ? 'installed' : 'NOT FOUND on PATH'}; ${offered ? 'offered here' : 'not offered to this token here (it needs the "research" scope, and the workspace server.remote.offer.session)'}`);
  }
  for (const s of evalSlots) {
    const kinds = evalKindsFor(s.family).filter((k) => work?.kinds?.[k] === true);
    log(`evaluation work on ${s.family} × ${s.slots}: ${onPath(s.bin()) ? 'installed' : 'NOT FOUND on PATH'}; ${kinds.length ? `takes ${kinds.join(', ')} here` : 'not offered to this token here (it needs the "eval" scope, and server.remote.offer.eval)'}`);
    if (s.family === 'codex' && kinds.includes('eval-session')) log(`evaluation archives cached in ${evalCacheDir}`);
  }
  process.exit(0);
}

/* -------------------------------- slots --------------------------------- */

let stopping = false;
const held = new Map(); // lease id → { identity, route }, for release on shutdown
const sleepers = new Set();
const sleep = (ms) => new Promise((resolve) => {
  if (stopping) return resolve();
  const done = () => {
    clearTimeout(t);
    sleepers.delete(done);
    resolve();
  };
  const t = setTimeout(done, ms);
  sleepers.add(done);
});

/** A task for the log: the document (and part), and what is asked of it. */
function describeTask(task) {
  const doc = task.document;
  const label = task.label ?? (doc ? `${doc.path}${doc.parts > 1 ? ` [${doc.part}/${doc.parts}]` : ''}` : task.id);
  if (task.kind === 'translate') return `translation of ${label}`;
  return task.kind === 'summarize' ? `summary of ${label}` : task.kind === 'judge' ? `judge call on ${label}` : label;
}

async function slot(backend, n) {
  const identity = { worker: `${workerName}/${backend.name}#${n}`, backend: backend.impl.label(null), ...poolField };
  let idleRounds = 0;
  while (!stopping) {
    const pause = backend.health.pausedUntil - Date.now();
    if (pause > 0) {
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    if (reading) await reading;
    // work/* on a server that has it; extraction over labeling/* on one from before
    const route = work ? 'work' : 'labeling';
    let task;
    let leaseSeconds = 900;
    try {
      const kinds = await kindsForLease();
      if (kinds.length) {
        const { data } = await call('POST', `${base}/${route}/lease`, route === 'work' ? { ...identity, kinds, max: 1 } : { ...identity, max: 1 });
        task = data.tasks?.[0];
        leaseSeconds = data.leaseSeconds ?? leaseSeconds;
        if (work && data.configVersion && data.configVersion !== work.version) void rereadWorkConfig();
      }
    } catch (err) {
      log(`${identity.worker}: lease failed: ${err.message}`);
      if (err.status === 401 || err.status === 403) {
        stopping = true;
        break;
      }
      await sleep(30_000);
      continue;
    }
    if (!task) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    idleRounds = 0;
    held.set(task.id, { identity, route });
    const renew = setInterval(() => {
      call('POST', `${base}/${route}/renew`, { ...identity, ids: [task.id] }).catch((err) => log(`${identity.worker}: renew failed: ${err.message}`));
    }, Math.max(10_000, (leaseSeconds * 1000) / 3));
    const started = Date.now();
    const where = describeTask(task);
    const hint = hintFor(task.kind, backend.name);
    let outcome;
    let usage = null;
    const report = (u) => { usage = u; };
    try {
      const text = await backend.impl.complete(task, hint, report);
      outcome = { ok: true, text, model: backend.impl.label(hint) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { ok: false, error: message, kind: classify(message), model: backend.impl.label(hint) };
    } finally {
      clearInterval(renew);
    }
    if (usage) outcome.usage = usage;
    if (stopping && !outcome.ok) break; // killed on shutdown: released below
    backend.health.calls++;
    try {
      const { data } = await call('POST', `${base}/${route}/complete`, { ...identity, id: task.id, ...outcome });
      held.delete(task.id);
      const secs = Math.round((Date.now() - started) / 1000);
      if (!data.accepted) log(`${identity.worker}: ${where} not taken back: ${data.reason}`);
      else if (outcome.ok) log(`${identity.worker}: ${where} done in ${secs}s${data.documentWritten ? ' — document written' : ''}`);
      else log(`${identity.worker}: ${where} failed (${outcome.kind}) in ${secs}s: ${outcome.error.slice(0, 200)}`);
    } catch (err) {
      log(`${identity.worker}: could not hand back ${where}: ${err.message}`);
    }
    if (outcome.ok) {
      backend.health.ok++;
      Object.assign(backend.health, { transientStreak: 0, modelStreak: 0, fatalStreak: 0 });
    } else {
      backend.health.failed++;
      const ms = rest(backend.health, outcome.kind);
      if (ms) log(`${backend.name}: resting ${Math.ceil(ms / 60_000)} min after a ${outcome.kind} failure`);
    }
  }
}

/** An embed slot: lease a batch, embed it on the own endpoint, hand back the raw vectors. */
async function embedSlot(backend, n) {
  const identity = { worker: `${workerName}/embed#${n}`, backend: backend.impl.label(), ...poolField };
  let idleRounds = 0;
  while (!stopping) {
    const pause = Math.max(backend.health.pausedUntil, embedParkedUntil) - Date.now();
    if (pause > 0) {
      if (args.once && embedParkedUntil > Date.now()) break;
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    if (reading) await reading;
    if (!work?.kinds?.embed || !work.embedding) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    if (!calibration) {
      calibrating ??= calibrate().catch((err) => {
        log(`embed: calibration failed: ${err.message}`);
        embedParkedUntil = Date.now() + 60_000;
        return false;
      }).finally(() => (calibrating = null));
      if (!(await calibrating)) continue;
    }
    let task;
    let leaseSeconds = 120;
    try {
      const { data } = await call('POST', `${base}/work/lease`, { ...identity, kinds: ['embed'], max: 1, calibration });
      if (data.configVersion && data.configVersion !== work.version) void rereadWorkConfig();
      if (data.embed?.calibrate) {
        log(`embed: ${data.embed.reason}${data.embed.parkedUntil ? ` (until ${data.embed.parkedUntil})` : ''}`);
        calibration = null;
        // parked: wait it out; otherwise calibrate again, a moment later (a server that restarted forgot the calibration)
        embedParkedUntil = data.embed.parkedUntil ? Math.max(Date.now() + 60_000, Date.parse(data.embed.parkedUntil) || 0) : Date.now() + 5_000;
        if (args.once && ++idleRounds >= 2) break;
        continue;
      }
      task = data.tasks?.[0];
      leaseSeconds = data.leaseSeconds ?? leaseSeconds;
    } catch (err) {
      log(`${identity.worker}: lease failed: ${err.message}`);
      if (err.status === 401 || err.status === 403) {
        stopping = true;
        break;
      }
      await sleep(30_000);
      continue;
    }
    if (!task) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    idleRounds = 0;
    held.set(task.id, { identity, route: 'work' });
    const renew = setInterval(() => {
      call('POST', `${base}/work/renew`, { ...identity, ids: [task.id] }).catch((err) => log(`${identity.worker}: renew failed: ${err.message}`));
    }, Math.max(10_000, (leaseSeconds * 1000) / 3));
    const started = Date.now();
    let outcome;
    try {
      const made = await embedRequest(ownEndpoint, task.inputs);
      outcome = {
        ok: true, text: '', model: ownEndpoint.model, ...(made.endpointModel ? { endpointModel: made.endpointModel } : {}), ...encodeVectors(made.vectors),
        ...(made.tokens ? { usage: { inputTokens: made.tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err?.http?.status;
      const kind = status === 401 || status === 403 ? 'fatal' : status === 429 || status >= 500 ? 'transient' : classify(message);
      outcome = { ok: false, error: message, kind, model: ownEndpoint.model };
    } finally {
      clearInterval(renew);
    }
    if (stopping && !outcome.ok) break;
    backend.health.calls++;
    try {
      const { data } = await call('POST', `${base}/work/complete`, { ...identity, id: task.id, ...outcome });
      held.delete(task.id);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!data.accepted) {
        log(`${identity.worker}: ${task.label} not taken back: ${data.reason}`);
        if (/parked/.test(data.reason ?? '')) calibration = null;
      } else if (outcome.ok) log(`${identity.worker}: ${task.label} embedded in ${secs}s${data.vectorsWritten !== undefined ? ` — ${data.vectorsWritten} vectors written` : ''}`);
      else log(`${identity.worker}: ${task.label} failed (${outcome.kind}) in ${secs}s: ${outcome.error.slice(0, 200)}`);
    } catch (err) {
      log(`${identity.worker}: could not hand back ${task.label}: ${err.message}`);
    }
    if (outcome.ok) {
      backend.health.ok++;
      Object.assign(backend.health, { transientStreak: 0, modelStreak: 0, fatalStreak: 0 });
    } else {
      backend.health.failed++;
      const ms = rest(backend.health, outcome.kind);
      if (ms) log(`embed: resting ${Math.ceil(ms / 60_000)} min after a ${outcome.kind} failure`);
    }
  }
}

/* --------------------------- research sessions --------------------------- */
// A session's fields are checked one by one and the command is built here (docs/design/27 D9): a server — or
// anyone posing as one — can name a model or an effort, never a flag, a config layer or a command.

const SESSION_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SESSION_TIMEOUT_CAP_MS = 6 * 3_600_000;
const sessionTimeoutMs = Math.min(SESSION_TIMEOUT_CAP_MS, Number(args.sessionTimeoutMs ?? SESSION_TIMEOUT_CAP_MS) || SESSION_TIMEOUT_CAP_MS);
const SESSION_RENEW_MS = Math.max(1_000, Number(args.sessionRenewMs ?? 30_000));
const STDERR_KEEP = 64 * 1024;
// characters of a command's or MCP call's output an evaluation session sends back (docs/design/33 D7); the run keeps
// the same head of each, with the full length (src/eval/trace.ts TOOL_OUTPUT_HEAD)
const EVAL_OUTPUT_HEAD = 2000;

/**
 * An evaluation session's event line as it goes back to the run: a finished command or MCP call whose output is
 * longer than the head the run keeps carries only that head, with the full length in `knode_output_chars`; every
 * other line is sent as Codex wrote it. A run reads either (a worker from before this sends whole outputs).
 */
function cutEvalEvent(line) {
  if (!line.startsWith('{') || !line.includes('"item.completed"')) return line;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return line;
  }
  const item = ev.item;
  if (ev.type !== 'item.completed' || !item || typeof item !== 'object') return line;
  if (item.type === 'command_execution' && typeof item.aggregated_output === 'string' && item.aggregated_output.length > EVAL_OUTPUT_HEAD) {
    return JSON.stringify({ ...ev, item: { ...item, aggregated_output: item.aggregated_output.slice(0, EVAL_OUTPUT_HEAD), knode_output_chars: item.aggregated_output.length } });
  }
  if (item.type === 'mcp_tool_call' && item.result && Array.isArray(item.result.content)) {
    const texts = item.result.content.map((b) => (b && typeof b.text === 'string' ? b.text : JSON.stringify(b)));
    const text = texts.join('\n');
    if (text.length <= EVAL_OUTPUT_HEAD) return line;
    return JSON.stringify({ ...ev, item: { ...item, result: { content: [{ type: 'text', text: text.slice(0, EVAL_OUTPUT_HEAD) }] }, knode_output_chars: text.length } });
  }
  return line;
}

/** The session as this worker will run it, or why it will not. */
function checkSession(task, family) {
  const fail = (why) => ({ error: `refused the session: ${why}` });
  if (typeof task.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(task.id)) return fail('its id is not a lease id');
  const a = task.agent ?? {};
  if (a.family !== family) return fail(`it is for ${a.family}, this slot runs ${family}`);
  const model = String(a.model ?? '');
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]=,-]{0,119}$/.test(model)) return fail('its model name is not one');
  const effort = a.effort == null ? null : String(a.effort);
  if (effort !== null && !SESSION_EFFORTS.has(effort)) return fail(`unknown effort "${effort}"`);
  const speed = a.speed == null ? null : String(a.speed);
  if (speed !== null && !/^[a-z][a-z0-9_-]{0,30}$/.test(speed)) return fail('its speed is not one');
  const maxTurns = Math.trunc(Number(task.maxTurns));
  if (!(maxTurns >= 1 && maxTurns <= 1000)) return fail('its turn cap is out of range');
  const timeout = Math.trunc(Number(task.timeoutMs));
  if (!(timeout >= 1_000)) return fail('its timeout is out of range');
  if (task.tools !== 'read' && task.tools !== 'write') return fail('its tool set is neither read nor write');
  const web = task.web === true;
  const freshness = task.webFreshness === 'cached' ? 'cached' : 'live';
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) return fail('it has no prompt');
  if (typeof task.schema !== 'string') return fail('it has no schema');
  if (typeof task.mcpToken !== 'string' || !/^kms_[A-Za-z0-9_-]{20,200}$/.test(task.mcpToken)) return fail('it has no session token');
  return {
    session: {
      id: task.id, family, model, effort, speed, maxTurns, timeoutMs: Math.min(timeout, sessionTimeoutMs), tools: task.tools, web, freshness,
      prompt: task.prompt, schema: task.schema, token: task.mcpToken, url: `${base}/sessions/${encodeURIComponent(task.id)}/mcp`,
    },
  };
}

/** The folder a session runs in: the schema, and knode's MCP server as the only one (a 0600 file, it holds the token). */
function sessionFolder(sess) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-session-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), sess.schema);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), sess.schema);
  if (sess.family === 'claude') {
    const server = { type: 'http', url: sess.url, headers: { Authorization: `Bearer ${sess.token}` } };
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'knode-os': server } }, null, 2) + '\n', { mode: 0o600 });
  }
  return dir;
}

/** The command for a session, built from its checked fields. */
function sessionCommand(sess, dir, pinned) {
  if (sess.family === 'claude') {
    const argv = [
      '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(sess.maxTurns),
      '--mcp-config', '.mcp.json', '--strict-mcp-config',
      '--allowedTools', 'mcp__knode-os__*', ...(sess.web ? ['WebSearch', 'WebFetch'] : []),
      '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob', ...(sess.web ? [] : ['WebFetch', 'WebSearch']),
      '--permission-mode', 'dontAsk', '--no-session-persistence',
      ...(sess.effort ? ['--effort', sess.effort] : []),
      ...(sess.model ? ['--model', sess.model] : []),
    ];
    return { bin: SESSION_FAMILIES.claude(), argv, env: {}, lastMessage: null };
  }
  const lastMessage = path.join(dir, 'last-message.txt');
  const argv = [
    'exec', '-', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--cd', dir,
    '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'analytics.enabled=false',
    ...(pinned ? ['-c', `model_catalog_json=${JSON.stringify(pinned)}`] : []),
    '-c', `mcp_servers.knode-os.url=${JSON.stringify(sess.url)}`,
    '-c', 'mcp_servers.knode-os.bearer_token_env_var="KNODE_SESSION_TOKEN"',
    '-c', 'mcp_servers.knode-os.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.knode-os.tool_timeout_sec=300',
    '-c', `web_search=${JSON.stringify(sess.web ? sess.freshness : 'disabled')}`,
    ...(sess.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(sess.effort)}`] : []),
    ...(sess.speed ? ['-c', `service_tier=${JSON.stringify(sess.speed)}`] : []),
    '--output-last-message', lastMessage,
    ...(sess.model ? ['-m', sess.model] : []),
  ];
  return { bin: SESSION_FAMILIES.codex(), argv, env: { KNODE_SESSION_TOKEN: sess.token }, lastMessage };
}

/** Run a session's CLI: stdout handed to `onStdout` as it comes, stderr's end kept; `kill()` stops it. */
function runSessionProcess(cmd, argv, stdin, cwd, env, timeout, onStdout) {
  let child;
  const done = new Promise((resolve) => {
    child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stderr = '';
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stderr: error ? `${stderr}\n${error}` : stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(-1, `${cmd} timed out after ${Math.round(timeout / 1000)}s`);
    }, timeout);
    child.stdout.on('data', (d) => onStdout(d.toString('utf8')));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 2 * STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });
    child.on('error', (err) => finish(-1, err.code === 'ENOENT' ? `${cmd} CLI not found` : String(err.message ?? err)));
    child.on('close', (code) => finish(code ?? -1, null));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
  return {
    done,
    /** SIGTERM by default; an eval session at its cap gets SIGINT, Codex's interrupt, which keeps its tokens so far. */
    kill(signal = 'SIGTERM') {
      try {
        child?.kill(signal);
        setTimeout(() => child?.kill('SIGKILL'), signal === 'SIGINT' ? 10_000 : 5_000).unref?.();
      } catch {
        // gone already
      }
    },
  };
}

/** A session slot: lease a session for this CLI, run it, stream its output back, hand back how it ended. */
async function sessionSlot(slot, n) {
  const identity = { worker: `${workerName}/session-${slot.family}#${n}`, backend: slot.family, ...poolField };
  let idleRounds = 0;
  while (!stopping) {
    const pause = slot.health.pausedUntil - Date.now();
    if (pause > 0) {
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    if (reading) await reading;
    if (!work?.kinds?.session) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    let task;
    try {
      const { data } = await call('POST', `${base}/work/lease`, { ...identity, kinds: ['session'], max: 1 });
      if (data.configVersion && data.configVersion !== work.version) void rereadWorkConfig();
      task = data.tasks?.[0];
    } catch (err) {
      log(`${identity.worker}: lease failed: ${err.message}`);
      if (err.status === 401 || err.status === 403) {
        stopping = true;
        break;
      }
      await sleep(30_000);
      continue;
    }
    if (!task) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    idleRounds = 0;
    held.set(task.id, { identity, route: 'work' });
    const checked = checkSession(task, slot.family);
    if (checked.error) {
      log(`${identity.worker}: ${checked.error}`);
      await call('POST', `${base}/work/complete`, { ...identity, id: task.id, ok: false, error: checked.error, kind: 'fatal' }).catch(() => {});
      held.delete(task.id);
      continue;
    }
    const sess = checked.session;
    const started = Date.now();
    log(`${identity.worker}: session ${task.label ?? task.id} on ${slot.family}${sess.model ? ` ${sess.model}` : ''} (≤${sess.maxTurns} turns, ${sess.tools} tools${sess.web ? ', web' : ''})`);
    const dir = sessionFolder(sess);
    let pendingOut = '';
    let lost = false;
    let proc = null;
    // renewals one after another, so the transcript keeps its order
    let renewing = Promise.resolve();
    const renewOnce = () => {
      renewing = renewing.then(async () => {
        if (lost) return;
        const output = pendingOut;
        pendingOut = '';
        try {
          const { data } = await call('POST', `${base}/work/renew`, { ...identity, ids: [task.id], output: output ? { [task.id]: output } : undefined });
          if (Array.isArray(data.lost) && data.lost.includes(task.id)) {
            lost = true;
            log(`${identity.worker}: the server no longer wants ${task.label ?? task.id} (cancelled, restarted or lapsed) — stopping it`);
            proc?.kill();
          }
        } catch (err) {
          // the output is kept for the next renewal; the lease lapses on the server if this goes on
          pendingOut = output + pendingOut;
          log(`${identity.worker}: renew failed: ${err.message}`);
        }
      });
      return renewing;
    };
    const renewTimer = setInterval(() => void renewOnce(), SESSION_RENEW_MS);
    let result;
    try {
      const catalog = sess.family === 'codex' ? codexCatalog(SESSION_FAMILIES.codex(), sess.model) : null;
      const pinned = pinnedCatalog(catalog);
      const cmd = sessionCommand(sess, dir, pinned);
      proc = runSessionProcess(cmd.bin, cmd.argv, sess.prompt, dir, cmd.env, sess.timeoutMs, (text) => (pendingOut += text));
      result = await proc.done;
      if (sess.family === 'codex' && !pinned) await refreshCatalog(catalog);
      result.lastMessage = cmd.lastMessage && fs.existsSync(cmd.lastMessage) ? fs.readFileSync(cmd.lastMessage, 'utf8') : null;
    } finally {
      clearInterval(renewTimer);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await renewing;
    if (lost || stopping) {
      held.delete(task.id);
      if (stopping) break;
      continue;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    // a CLI that could not start at all is this machine's failure, not the session's
    const notStarted = result.code === -1 && /CLI not found|ENOENT/.test(result.stderr) && !pendingOut;
    const outcome = notStarted
      ? { ok: false, error: result.stderr.trim().split('\n').pop(), kind: 'fatal' }
      : { ok: true, text: '', session: { exitCode: result.code, output: pendingOut, stderr: result.stderr.slice(-STDERR_KEEP), lastMessage: result.lastMessage } };
    slot.health.calls++;
    try {
      const { data } = await call('POST', `${base}/work/complete`, { ...identity, id: task.id, model: `${slot.family}:${sess.model || 'default'}`, ...outcome });
      held.delete(task.id);
      if (!data.accepted) log(`${identity.worker}: ${task.label ?? task.id} not taken back: ${data.reason}`);
      else if (data.failure) log(`${identity.worker}: ${task.label ?? task.id} could not be served here (${data.failure}) after ${secs}s — it goes back to the server`);
      else log(`${identity.worker}: ${task.label ?? task.id} done in ${secs}s (exit ${result.code})`);
      const failure = !outcome.ok ? outcome.kind : data.failure;
      if (failure) {
        slot.health.failed++;
        const ms = rest(slot.health, failure);
        if (ms) log(`sessions on ${slot.family}: resting ${Math.ceil(ms / 60_000)} min after a ${failure} failure`);
      } else {
        slot.health.ok++;
        Object.assign(slot.health, { transientStreak: 0, modelStreak: 0, fatalStreak: 0 });
      }
    } catch (err) {
      log(`${identity.worker}: could not hand back ${task.label ?? task.id}: ${err.message}`);
    }
  }
}

/* ---------------------------- evaluation work ---------------------------- */
// An evaluation run's calls and agent sessions (docs/design/27 §8). Every field is checked and the command built here,
// as for research sessions: the run names a family, a model and an effort, never a flag. A session's `codex exec`
// mirrors the run's own (src/eval/agent.ts agentArgs): user config, plugins, apps, analytics and web search off,
// read-only sandbox in the session's folder, the last message to a file outside it, events on stdout.

const EVAL_EFFORTS = SESSION_EFFORTS;
const EVAL_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]=,-]{0,119}$/;

/** The agent a task names, checked: this slot's family, a model (never empty), a known effort. */
function checkEvalAgent(task, family) {
  if (typeof task.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(task.id)) return { error: 'its id is not a lease id' };
  const a = task.agent ?? {};
  if (a.family !== family) return { error: `it is for ${a.family}, this slot runs ${family}` };
  const model = String(a.model ?? '');
  if (!EVAL_MODEL_RE.test(model)) return { error: 'it names no model, or its model name is not one' };
  const effort = a.effort == null ? null : String(a.effort);
  if (effort !== null && !EVAL_EFFORTS.has(effort)) return { error: `unknown effort "${effort}"` };
  const speed = a.speed == null ? null : String(a.speed);
  if (speed !== null && !/^[a-z][a-z0-9_-]{0,30}$/.test(speed)) return { error: 'its speed is not one' };
  const timeout = Math.trunc(Number(task.timeoutMs));
  if (!(timeout >= 1_000)) return { error: 'its timeout is out of range' };
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) return { error: 'it has no prompt' };
  return { agent: { family, model, effort, speed }, timeoutMs: Math.min(timeout, sessionTimeoutMs) };
}

/** An eval call as this worker will run it, or why it will not. */
function checkEvalCall(task, family) {
  const fail = (why) => ({ error: `refused the eval call: ${why}` });
  const a = checkEvalAgent(task, family);
  if (a.error) return fail(a.error);
  let schema = null;
  if (task.schema != null) {
    if (family !== 'codex') return fail('an output schema is for codex');
    if (typeof task.schema !== 'object' || Array.isArray(task.schema)) return fail('its schema is not a JSON object');
    schema = JSON.stringify(task.schema);
    if (schema.length > 256 * 1024) return fail('its schema is too large');
  }
  return { call: { ...a, prompt: task.prompt, schema } };
}

/** An eval session as this worker will run it, or why it will not. */
function checkEvalSession(task, family) {
  const fail = (why) => ({ error: `refused the eval session: ${why}` });
  if (family !== 'codex') return fail('evaluation sessions run on codex');
  const a = checkEvalAgent(task, family);
  if (a.error) return fail(a.error);
  if (task.sandbox !== 'read-only') return fail('its sandbox is not read-only');
  const maxSteps = Math.trunc(Number(task.maxSteps));
  if (!(maxSteps >= 1 && maxSteps <= 1000)) return fail('its step cap is out of range');
  let archive = null;
  if (task.archive != null) {
    if (typeof task.archive.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(task.archive.sha256)) return fail('its archive id is not a SHA-256');
    archive = { sha256: task.archive.sha256, bytes: Math.max(0, Math.trunc(Number(task.archive.bytes) || 0)) };
  }
  let mcp = null;
  if (task.mcp != null) {
    if (typeof task.mcp.token !== 'string' || !/^kes_[A-Za-z0-9_-]{20,200}$/.test(task.mcp.token)) return fail('it has no session token');
    const tools = Array.isArray(task.mcp.tools) ? task.mcp.tools.map(String) : [];
    if (!tools.length || tools.length > 64 || !tools.every((t) => /^[a-z][a-z0-9_]{0,63}$/.test(t))) return fail('its tool list is not one');
    mcp = { token: task.mcp.token, tools, url: `${base}/eval-sessions/${encodeURIComponent(task.id)}/mcp` };
  }
  // the turn a capped session is resumed with for its answer (src/eval/agent.ts CLOSING_TURN); absent: a run from before
  let closing = null;
  if (task.closing != null) {
    if (typeof task.closing !== 'string' || !task.closing.trim() || task.closing.length > 2000) return fail('its closing turn is not one');
    closing = task.closing;
  }
  return { session: { ...a, id: task.id, maxSteps, prompt: task.prompt, closing, archive, mcp } };
}

/* An archive (a copy of src/work/eval-archive.ts): gzip over `KPA1\n`, then per file a JSON line {p, n} and its bytes. */
const ARCHIVE_MAX_BYTES = 2 * 1024 ** 3;
const downloads = new Map(); // sha → Promise<Buffer>

function archiveEntries(gzip, sha256) {
  const raw = zlib.gunzipSync(gzip, { maxOutputLength: ARCHIVE_MAX_BYTES + 64 * 1024 * 1024 });
  if (crypto.createHash('sha256').update(raw).digest('hex') !== sha256) throw new Error(`archive ${sha256.slice(0, 12)} does not match its id`);
  if (raw.subarray(0, 5).toString() !== 'KPA1\n') throw new Error('not a knode archive');
  const out = [];
  let at = 5;
  while (at < raw.length) {
    const nl = raw.indexOf(10, at);
    if (nl < 0) throw new Error('a torn archive entry');
    const head = JSON.parse(raw.subarray(at, nl).toString('utf8'));
    const n = Number(head.n);
    const p = head.p;
    if (!Number.isSafeInteger(n) || n < 0 || nl + 1 + n > raw.length) throw new Error('a torn archive entry');
    if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.split('/').some((x) => x === '' || x === '.' || x === '..')) {
      throw new Error(`an archive entry escapes its folder: ${String(p).slice(0, 200)}`);
    }
    out.push({ path: p, data: raw.subarray(nl + 1, nl + 1 + n) });
    at = nl + 1 + n;
  }
  return out;
}

/** The archive, from the cache when it is there, else downloaded once (concurrent sessions share the download). */
function evalArchive(sha256) {
  const file = path.join(evalCacheDir, `${sha256}.kpa`);
  if (fs.existsSync(file)) {
    const now = new Date();
    fs.utimesSync(file, now, now);
    return Promise.resolve(fs.readFileSync(file));
  }
  if (!downloads.has(sha256)) {
    downloads.set(sha256, (async () => {
      const res = await fetch(`${base}/eval-archives/${sha256}`, { headers: { authorization: `Bearer ${token}`, ...extraHeaders }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok) throw new Error(`archive ${sha256.slice(0, 12)}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const gzip = Buffer.from(await res.arrayBuffer());
      archiveEntries(gzip, sha256); // checked before it is kept
      fs.mkdirSync(evalCacheDir, { recursive: true, mode: 0o700 });
      const partial = `${file}.${process.pid}.part`;
      fs.writeFileSync(partial, gzip, { mode: 0o600 });
      fs.renameSync(partial, file);
      log(`eval: archive ${sha256.slice(0, 12)} downloaded (${Math.round(gzip.length / 1024)} KB)`);
      return gzip;
    })().finally(() => downloads.delete(sha256)));
  }
  return downloads.get(sha256);
}

/** Archives no session has read for a day go. */
function pruneEvalCache() {
  try {
    for (const name of fs.readdirSync(evalCacheDir)) {
      const f = path.join(evalCacheDir, name);
      if (Date.now() - fs.statSync(f).mtimeMs > 24 * 3_600_000) fs.rmSync(f, { force: true });
    }
  } catch {
    // no cache yet
  }
}

/** One eval call: the run's prompt on stdin, its model and effort, its schema; the raw reply back. */
async function runEvalCall(call, family, report) {
  const dir = scratch();
  try {
    if (family === 'claude') {
      const argv = ['-p', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence', '--model', call.agent.model, ...(call.agent.effort ? ['--effort', call.agent.effort] : [])];
      const r = await runClaudePrint(EVAL_FAMILIES.claude(), argv, call.prompt, dir, call.timeoutMs);
      let wrapper = null;
      try {
        wrapper = JSON.parse(r.stdout);
      } catch {
        // fall through
      }
      if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
        const t = wrapper.usage ?? {};
        const usage = cachedUsage(t.input_tokens, t.cache_read_input_tokens, t.cache_creation_input_tokens, t.output_tokens, wrapper.total_cost_usd);
        if (usage) report(usage);
        if (wrapper.is_error || r.code !== 0) throw new Error(`claude CLI error: ${String(wrapper.result ?? 'unknown').slice(0, 400)}`);
        return String(wrapper.result ?? '').trim();
      }
      if (r.code !== 0) throw new Error(`claude exited with code ${r.code}: ${tail(r.stderr, r.stdout)}`);
      return r.stdout.trim();
    }
    const out = path.join(dir, 'reply.txt');
    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws);
    const schemaFile = path.join(dir, 'schema.json');
    if (call.schema) fs.writeFileSync(schemaFile, call.schema);
    const catalog = codexCatalog(EVAL_FAMILIES.codex(), call.agent.model);
    let pinned = pinnedCatalog(catalog);
    const argv = () => [
      'exec', '--ignore-user-config', '--ephemeral', '-c', 'features.plugins=false', '-c', 'features.apps=false',
      '-c', 'analytics.enabled=false', ...(pinned ? ['-c', `model_catalog_json=${JSON.stringify(pinned)}`] : []),
      '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', ws, '--output-last-message', out, '--json',
      '--model', call.agent.model,
      ...(call.agent.effort ? ['-c', `model_reasoning_effort="${call.agent.effort}"`] : []),
      ...(call.agent.speed ? ['-c', `service_tier="${call.agent.speed}"`] : []),
      ...(call.schema ? ['--output-schema', schemaFile] : []),
      '-',
    ];
    let r;
    for (;;) {
      try {
        r = await run(EVAL_FAMILIES.codex(), argv(), call.prompt, ws, call.timeoutMs);
      } finally {
        if (!pinned) await refreshCatalog(catalog);
      }
      if (!pinned || r.code === 0 || !catalogRejected(pinned, r.stderr)) break;
      pinned = null;
    }
    const events = readCodexEvents(r.stdout);
    if (events.usage) report(events.usage);
    if (r.code !== 0) throw new Error(`codex exec exited with code ${r.code}: ${events.error ?? tail(r.stderr, r.stdout)}`);
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
    if (!text) throw new Error(`codex exec finished but produced no message${events.error ? `: ${events.error}` : ''}`);
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The `codex exec` of an eval session, built from its checked fields (src/eval/agent.ts agentArgs). */
function evalSessionCommand(sess, cwd, out, pinned) {
  const argv = [
    // a session with a closing turn is saved, since only a saved one resumes; nothing learns from it, and it is deleted
    'exec', '--ignore-user-config', ...(sess.closing ? ['-c', 'memories.generate_memories=false'] : ['--ephemeral']),
    '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'analytics.enabled=false',
    ...(pinned ? ['-c', `model_catalog_json=${JSON.stringify(pinned)}`] : []),
    '-c', 'web_search="disabled"', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd,
    '--output-last-message', out, '--json', '--model', sess.agent.model,
    ...(sess.agent.effort ? ['-c', `model_reasoning_effort="${sess.agent.effort}"`] : []),
  ];
  if (sess.mcp) {
    argv.push(
      '-c', `mcp_servers.knode.url=${JSON.stringify(sess.mcp.url)}`,
      '-c', 'mcp_servers.knode.bearer_token_env_var="KNODE_EVAL_MCP_TOKEN"',
      '-c', `mcp_servers.knode.enabled_tools=${JSON.stringify(sess.mcp.tools)}`,
      '-c', 'mcp_servers.knode.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.knode.tool_timeout_sec=300',
    );
  }
  argv.push('-');
  return { bin: EVAL_FAMILIES.codex(), argv, env: sess.mcp ? { KNODE_EVAL_MCP_TOKEN: sess.mcp.token } : {} };
}

/** A Codex thread id as it may go back on a command line (src/eval/agent.ts THREAD_ID_RE). */
const THREAD_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$/;
/** The closing turn is one model call; this bounds a hung one (src/eval/agent.ts CLOSING_TIMEOUT_MS). */
const EVAL_CLOSING_MS = 5 * 60_000;

/**
 * The closing turn of a capped eval session (src/eval/agent.ts closingArgs): the thread resumed with no shell and no
 * MCP server, the closing prompt on stdin.
 */
function evalClosingCommand(sess, threadId, out, pinned) {
  const argv = [
    'exec', 'resume', '--ignore-user-config', '-c', 'memories.generate_memories=false',
    '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'analytics.enabled=false',
    ...(pinned ? ['-c', `model_catalog_json=${JSON.stringify(pinned)}`] : []),
    '-c', 'web_search="disabled"', '-c', 'sandbox_mode="read-only"', '--disable', 'shell_tool', '--skip-git-repo-check',
    '--output-last-message', out, '--json', '--model', sess.agent.model,
    ...(sess.agent.effort ? ['-c', `model_reasoning_effort="${sess.agent.effort}"`] : []),
    threadId, '-',
  ];
  return { bin: EVAL_FAMILIES.codex(), argv, env: {} };
}

/** An eval slot: lease the run's calls (and, on codex, its sessions), run each, hand back the raw result. */
async function evalSlot(slot, n) {
  const identity = { worker: `${workerName}/eval-${slot.family}#${n}`, backend: slot.family, ...poolField };
  const kindsHere = evalKindsFor(slot.family);
  let idleRounds = 0;
  while (!stopping) {
    const pause = slot.health.pausedUntil - Date.now();
    if (pause > 0) {
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    if (reading) await reading;
    const kinds = kindsHere.filter((k) => work?.kinds?.[k] === true);
    if (!kinds.length) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    let task;
    let leaseSeconds = work?.leaseSeconds?.eval ?? 120;
    try {
      const { data } = await call('POST', `${base}/work/lease`, { ...identity, kinds, max: 1 });
      if (data.configVersion && data.configVersion !== work.version) void rereadWorkConfig();
      task = data.tasks?.[0];
      leaseSeconds = data.leaseSeconds ?? leaseSeconds;
    } catch (err) {
      log(`${identity.worker}: lease failed: ${err.message}`);
      if (err.status === 401 || err.status === 403) {
        stopping = true;
        break;
      }
      await sleep(30_000);
      continue;
    }
    if (!task) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    idleRounds = 0;
    held.set(task.id, { identity, route: 'work' });
    const isSession = task.kind === 'eval-session';
    const checked = isSession ? checkEvalSession(task, slot.family) : task.kind === 'eval-call' ? checkEvalCall(task, slot.family) : { error: `refused: ${task.kind} is no evaluation work` };
    if (checked.error) {
      log(`${identity.worker}: ${checked.error}`);
      await call('POST', `${base}/work/complete`, { ...identity, id: task.id, ok: false, error: checked.error, kind: 'fatal' }).catch(() => {});
      held.delete(task.id);
      const ms = rest(slot.health, 'fatal');
      log(`eval on ${slot.family}: resting ${Math.ceil(ms / 60_000)} min after a refused task`);
      continue;
    }
    const started = Date.now();
    const label = task.label ?? task.id;
    let outcome;
    if (!isSession) {
      const c = checked.call;
      let usage = null;
      let renewFailed = false;
      const renew = setInterval(() => {
        call('POST', `${base}/work/renew`, { ...identity, ids: [task.id] })
          .then(({ data }) => {
            if (Array.isArray(data.lost) && data.lost.includes(task.id) && !renewFailed) {
              renewFailed = true;
              log(`${identity.worker}: the run no longer wants ${label}`);
            }
          })
          .catch((err) => log(`${identity.worker}: renew failed: ${err.message}`));
      }, Math.max(1_000, (leaseSeconds * 1000) / 3));
      try {
        const text = await runEvalCall(c, slot.family, (u) => (usage = u));
        outcome = { ok: true, text, model: `${slot.family}:${c.agent.model}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outcome = { ok: false, error: message, kind: classify(message), model: `${slot.family}:${c.agent.model}` };
      } finally {
        clearInterval(renew);
      }
      if (usage) outcome.usage = usage;
    } else {
      const sess = checked.session;
      log(`${identity.worker}: eval session ${label} on codex ${sess.agent.model} (≤${sess.maxSteps} steps${sess.archive ? ', a folder' : ''}${sess.mcp ? `, knode tools: ${sess.mcp.tools.length}` : ''})`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-'));
      const cwd = path.join(dir, 'kb');
      fs.mkdirSync(cwd);
      const out = path.join(dir, 'answer.txt');
      let pendingOut = '';
      let lost = false;
      let proc = null;
      let steps = 0;
      let capped = false;
      let lineBuf = '';
      // the session's thread, and whether its closing turn (the thread resumed) started anything but a message
      let thread = null;
      let inClosing = false;
      let closingTool = false;
      const onLine = (line) => {
        if (!line.startsWith('{')) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
          thread ??= ev.thread_id;
          return;
        }
        if (ev.type !== 'item.started' || !ev.item) return;
        if (inClosing) {
          // the closing turn has nothing to run: whatever it starts ends it with no answer
          if (ev.item.type !== 'agent_message' && ev.item.type !== 'reasoning' && !closingTool) {
            closingTool = true;
            proc?.kill('SIGINT');
          }
          return;
        }
        if (ev.item.type === 'command_execution' || ev.item.type === 'mcp_tool_call') steps++;
        if (steps > sess.maxSteps && !capped) {
          capped = true;
          // with a closing turn, an interrupt (the turn's tokens are kept with the saved session); without, the old stop
          proc?.kill(sess.closing ? 'SIGINT' : 'SIGTERM');
        }
      };
      let renewing = Promise.resolve();
      const renewOnce = () => {
        renewing = renewing.then(async () => {
          if (lost) return;
          const output = pendingOut;
          pendingOut = '';
          try {
            const { data } = await call('POST', `${base}/work/renew`, { ...identity, ids: [task.id], output: output ? { [task.id]: output } : undefined });
            if (Array.isArray(data.lost) && data.lost.includes(task.id)) {
              lost = true;
              log(`${identity.worker}: the run no longer wants ${label} (cancelled, restarted or lapsed) — stopping it`);
              proc?.kill();
            }
          } catch (err) {
            pendingOut = output + pendingOut;
            log(`${identity.worker}: renew failed: ${err.message}`);
          }
        });
        return renewing;
      };
      const renewTimer = setInterval(() => void renewOnce(), SESSION_RENEW_MS);
      let result = null;
      let setupError = null;
      let closingOutcome = null;
      try {
        if (sess.archive) {
          const gzip = await evalArchive(sess.archive.sha256);
          // a fresh copy for this session, read-only: nothing one session leaves reaches the next
          for (const e of archiveEntries(gzip, sess.archive.sha256)) {
            const abs = path.join(cwd, e.path);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, e.data, { mode: 0o444 });
          }
        }
        const catalog = codexCatalog(EVAL_FAMILIES.codex(), sess.agent.model);
        const pinned = pinnedCatalog(catalog);
        const cmd = evalSessionCommand(sess, cwd, out, pinned);
        proc = runSessionProcess(cmd.bin, cmd.argv, sess.prompt, cwd, cmd.env, sess.timeoutMs, (text) => {
          lineBuf += text;
          let nl;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl);
            onLine(line);
            // whole lines go back, a long tool output cut to the head the run keeps
            pendingOut += cutEvalEvent(line) + '\n';
            lineBuf = lineBuf.slice(nl + 1);
          }
        });
        result = await proc.done;
        // a last line without its newline goes back as it is
        if (lineBuf) {
          onLine(lineBuf);
          pendingOut += cutEvalEvent(lineBuf);
          lineBuf = '';
        }
        result.lastMessage = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
        if (capped && sess.closing) {
          // the closing turn: the same thread resumed for its answer, its lines sent back after the session's
          closingOutcome = 'not-run';
          result.lastMessage = null;
          if (thread && THREAD_ID_RE.test(thread) && !lost && !stopping) {
            inClosing = true;
            const closingOut = path.join(dir, 'closing.txt');
            const c = evalClosingCommand(sess, thread, closingOut, pinned);
            proc = runSessionProcess(c.bin, c.argv, sess.closing, cwd, c.env, EVAL_CLOSING_MS, (text) => {
              lineBuf += text;
              let nl;
              while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl);
                onLine(line);
                pendingOut += cutEvalEvent(line) + '\n';
                lineBuf = lineBuf.slice(nl + 1);
              }
            });
            const closed = await proc.done;
            if (lineBuf) {
              onLine(lineBuf);
              pendingOut += cutEvalEvent(lineBuf);
              lineBuf = '';
            }
            const said = fs.existsSync(closingOut) ? fs.readFileSync(closingOut, 'utf8') : '';
            closingOutcome = closingTool ? 'used-a-tool' : said.trim() ? 'answered' : 'no-answer';
            if (closingOutcome === 'answered') result.lastMessage = said;
            if (closed.code !== 0 && closingOutcome !== 'answered') log(`${identity.worker}: ${label}: its closing turn ended with ${closed.code}: ${closed.stderr.trim().split('\n').pop() ?? ''}`.slice(0, 400));
          }
        }
        if (!pinned) await refreshCatalog(catalog);
      } catch (err) {
        setupError = err instanceof Error ? err.message : String(err);
      } finally {
        clearInterval(renewTimer);
        fs.rmSync(dir, { recursive: true, force: true });
        // a saved session leaves nothing in this machine's Codex home
        if (sess.closing && thread && THREAD_ID_RE.test(thread)) await run(EVAL_FAMILIES.codex(), ['delete', '--force', thread], '', os.tmpdir(), 30_000).catch(() => {});
      }
      await renewing;
      if (lost || stopping) {
        held.delete(task.id);
        if (stopping) break;
        continue;
      }
      const notStarted = setupError !== null || (result.code === -1 && /CLI not found|ENOENT/.test(result.stderr) && !pendingOut && !capped);
      outcome = notStarted
        ? { ok: false, error: setupError ?? result.stderr.trim().split('\n').pop(), kind: setupError ? classify(setupError) === 'transient' ? 'transient' : 'fatal' : 'fatal', model: `codex:${sess.agent.model}` }
        : {
          ok: true, text: '', model: `codex:${sess.agent.model}`,
          session: { exitCode: result.code, output: pendingOut, stderr: result.stderr.slice(-STDERR_KEEP), lastMessage: result.lastMessage, capped, ...(closingOutcome ? { closing: closingOutcome } : {}), cwd, home: os.homedir() },
        };
    }
    if (stopping && !outcome.ok) break;
    slot.health.calls++;
    try {
      const { data } = await call('POST', `${base}/work/complete`, { ...identity, id: task.id, ...outcome });
      held.delete(task.id);
      const secs = Math.round((Date.now() - started) / 1000);
      if (!data.accepted) log(`${identity.worker}: ${label} not taken back: ${data.reason}`);
      else if (data.failure) log(`${identity.worker}: ${label} could not be served here (${data.failure}) after ${secs}s — it goes back to the run${outcome.ok ? '' : `: ${outcome.error.slice(0, 200)}`}`);
      else if (outcome.ok) log(`${identity.worker}: ${label} done in ${secs}s`);
      else log(`${identity.worker}: ${label} failed (${outcome.kind}) in ${secs}s: ${outcome.error.slice(0, 200)}`);
      const failure = data.failure ?? (!outcome.ok && outcome.kind !== 'model' ? outcome.kind : null);
      if (failure) {
        slot.health.failed++;
        const ms = rest(slot.health, failure);
        if (ms) log(`eval on ${slot.family}: resting ${Math.ceil(ms / 60_000)} min after a ${failure} failure`);
      } else {
        slot.health.ok++;
        Object.assign(slot.health, { transientStreak: 0, modelStreak: 0, fatalStreak: 0 });
      }
    } catch (err) {
      log(`${identity.worker}: could not hand back ${label}: ${err.message}`);
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping — handing back ${held.size} task(s)`);
  for (const child of children) child.kill('SIGTERM');
  for (const wake of sleepers) wake();
  const byWorker = new Map();
  for (const [id, { identity, route }] of held) {
    const key = `${route} ${identity.worker}`;
    const list = byWorker.get(key) ?? { identity, route, ids: [] };
    list.ids.push(id);
    byWorker.set(key, list);
  }
  await Promise.allSettled([...byWorker.values()].map(({ identity, route, ids }) => call('POST', `${base}/${route}/release`, { ...identity, ids })));
}
process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(130)));
process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(143)));

// a server that cannot be reached yet is waited for; a token or workspace it refuses is not
for (;;) {
  try {
    await readWorkConfig();
    break;
  } catch (err) {
    if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err;
    log(`could not read the server configuration: ${err.message} — trying again in 30s`);
    await sleep(30_000);
    if (stopping) process.exit(0);
  }
}
log(`knode worker ${workerName} → ${server} ${workspace}: ${[...backends.map((b) => `${b.name} × ${b.slots}`), ...sessionSlots.map((s) => `research sessions on ${s.family} × ${s.slots}`), ...evalSlots.map((s) => `evaluation work on ${s.family} × ${s.slots}`)].join(', ')}${poolName ? `, pool ${poolName}` : ''} (run ${crypto.randomUUID().slice(0, 8)})`);
log(`${workspace}: ${describeKinds()}`);
if (args.extractFirst) log('extract-first enabled: summaries wait for the extraction queue and in-flight work to drain');
const llmSlots = backends.some((b) => b.name !== 'embed');
if (llmSlots && kindsNow().length === 0) log('nothing to take here — check --kinds, the token\'s kinds and what the server offers');
if (hasEmbedSlots && !work?.kinds?.embed) log('embed: not offered to this token here — it needs the "embed" scope, and the workspace ingest.embedding "deferred"');
if (sessionSlots.length && !work?.kinds?.session) log('research sessions: not offered to this token here — it needs the "research" scope, and the workspace server.remote.offer.session');
if (evalSlots.length && !work?.kinds?.['eval-call']) log('evaluation work: not offered to this token here — it needs the "eval" scope, and server.remote.offer.eval');
if (evalSlots.length) pruneEvalCache();
await Promise.all([
  ...backends.flatMap((b) => Array.from({ length: b.slots }, (_, i) => (b.name === 'embed' ? embedSlot(b, i + 1) : slot(b, i + 1)))),
  ...sessionSlots.flatMap((s) => Array.from({ length: s.slots }, (_, i) => sessionSlot(s, i + 1))),
  ...evalSlots.flatMap((s) => Array.from({ length: s.slots }, (_, i) => evalSlot(s, i + 1))),
]);
log('no more work — exiting');
