import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { CLOSING_TURN, runAgent } from '../src/eval/agent.js';
import { Meter } from '../src/eval/meter.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { withRemote } from '../src/eval/placement.js';
import { agentResultOf, PackScope, packMayLeave, RemoteEval, WaitLimitError } from '../src/eval/remote.js';
import { runEval, scoreRun } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { writeReport } from '../src/eval/report.js';
import { evalPassSettings, evalWorkspaceConfig, KNODE_EVAL_BATCH, KNODE_EVAL_CONCURRENCY } from '../src/eval/systems/knode.js';
import { loadPack } from '../src/eval/pack.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { RemoteTokenStore } from '../src/remote/tokens.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { startToolHost } from '../src/eval/toolhost.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { WorkBroker } from '../src/work/broker.js';
import { packFolder, readArchive, unpackArchive } from '../src/work/eval-archive.js';
import { EvalSessionSpec, EvalWork } from '../src/work/eval.js';

/**
 * An evaluation run's model work on remote workers (docs/design/27 §8): the
 * run stays here and offers its calls, agent sessions and judge calls to
 * `serve` over the loopback producer channel; a spawned worker on loopback
 * runs them with a stand-in CLI (tests/helpers/fake-eval-cli.mjs) and hands
 * back the raw result, which the run meters and parses as its own.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeCli = path.join(helpers, 'fake-eval-cli.mjs');
const workerScript = path.resolve(helpers, '..', '..', 'worker', 'knode-worker.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-remote-eval-'));
const root = path.join(tmp, 'data');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const packDir = path.join(tmp, 'packs', 'fixture-life');
const privateDir = path.join(tmp, 'packs', 'fixture-private');
const runs = path.join(tmp, 'runs');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let httpServer: Server;
let base = '';
let producerToken = '';
let evalToken = '';
/** Who the sources leased each piece to (`eval call <run> <label> → <worker>`). */
const sourceLog: string[] = [];
// a slot that stops asking is offline after 1.5 s, so a worker that goes away is gone soon
const evalWork = new EvalWork(root, { retryMs: 0, onlineMs: 1_500, log: (m) => sourceLog.push(m) });
const workers: ChildProcess[] = [];
const logs = new Map<string, string[]>();
const oldEnv = { PATH: process.env.PATH, KNODE_CODEX_CATALOG_HOURS: process.env.KNODE_CODEX_CATALOG_HOURS, CODEX_HOME: process.env.CODEX_HOME };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

/** A worker on loopback with evaluation slots, its CLIs the stand-in. */
function startWorker(name: string, env: Record<string, string> = {}, slots = 'codex:4,claude:2', extra: string[] = []): ChildProcess {
  const child = spawn(process.execPath, [
    workerScript, '--server', base, '--workspace', 'admin/default', '--eval', slots, '--name', name,
    '--codex-bin', path.join(tmp, 'bin', 'codex'), '--claude-bin', path.join(tmp, 'bin', 'claude'), '--idle-ms', '150', '--session-renew-ms', '300', ...extra,
  ], {
    env: { ...process.env, KNODE_TOKEN: evalToken, KNODE_EVAL_CACHE_DIR: path.join(tmp, `cache-${name}`), KNODE_CODEX_CATALOG_HOURS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  logs.set(name, lines);
  child.stdout!.on('data', (d) => {
    lines.push(...String(d).split('\n').filter(Boolean));
    if (process.env.DEBUG_REMOTE_EVAL) process.stderr.write(`[${name}] ${d}`);
  });
  child.stderr!.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  workers.push(child);
  return child;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

const remoteOpts = (over: Record<string, unknown> = {}) => ({ serveUrl: base, token: producerToken, refreshMs: 200, ...over });
const status = async () => (await (await fetch(`${base}/eval/v1/status`, { headers: { authorization: `Bearer ${producerToken}` } })).json()) as { offered: boolean; online: Record<string, Record<string, number>> };
const common = { onProgress: (m: string) => process.env.DEBUG_REMOTE_EVAL && process.stderr.write(`  run: ${m}\n`), model: 'gpt-test', judgeProvider: 'claude-cli', judgeModel: 'claude-test', quota: false, suites: ['usage' as const], limit: 3, agentLimit: 2, overrides: { embedder } };

beforeAll(async () => {
  // the stand-in answers wherever a piece runs: here (on PATH) or on the worker (--codex-bin)
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec node "${fakeCli}" "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${oldEnv.PATH}`;
  process.env.KNODE_CODEX_CATALOG_HOURS = '0';
  process.env.CODEX_HOME = path.join(tmp, 'codex-home');

  expect(buildFixturePack(packDir).errors).toEqual([]);
  fs.cpSync(packDir, privateDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(privateDir, 'pack.json'), 'utf8'));
  manifest.id = 'fixture-private';
  manifest.sources = [...(manifest.sources ?? []), { url: 'file:///nowhere', license: 'private: the owner\'s own notes' }];
  fs.writeFileSync(path.join(privateDir, 'pack.json'), JSON.stringify(manifest, null, 2));

  rootCtx = await createContext(root);
  rootCtx.config.server.remote = { ...rootCtx.config.server.remote!, offer: { ...rootCtx.config.server.remote!.offer, eval: true } };
  registry = new WorkspaceContextRegistry(root, {
    templateConfig: rootCtx.config,
    // what `serve` wires: the server's eval sources behind every workspace's broker
    onCreate: (wctx) => {
      const broker = new WorkBroker(evalWork.sources);
      brokers.set(wctx.dataDir, broker);
      return async () => broker.stop();
    },
  });
  const brokers = new Map<string, WorkBroker>();
  const app = createApp(rootCtx, () => {}, registry, {
    services: (wctx) => ({ mcp: () => null, kickResearch: () => {}, track: (job) => job, work: brokers.get(wctx.dataDir) ?? null }),
    evalWork,
  });
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  const ctx = await registry.get(scope);
  ctx.config.server.remote = { ...ctx.config.server.remote!, offer: { ...ctx.config.server.remote!.offer, eval: true } };
  producerToken = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    }) as Server;
  });
  evalToken = new RemoteTokenStore(root).create({ name: 'laptop', scopes: ['eval'], workspaces: ['admin/default'] }).token;
}, 60_000);

afterAll(async () => {
  for (const w of workers) await stopWorker(w);
  evalWork.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  process.env.PATH = oldEnv.PATH;
  if (oldEnv.KNODE_CODEX_CATALOG_HOURS === undefined) delete process.env.KNODE_CODEX_CATALOG_HOURS;
  else process.env.KNODE_CODEX_CATALOG_HOURS = oldEnv.KNODE_CODEX_CATALOG_HOURS;
  if (oldEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldEnv.CODEX_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('archives', () => {
  it('packs a folder into the same content-addressed stream every time, and refuses one that climbs out', () => {
    const dir = path.join(tmp, 'arch');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'x.md'), '林晓');
    fs.writeFileSync(path.join(dir, 'y.md'), 'y');
    const one = packFolder(dir);
    expect(packFolder(dir).sha256).toBe(one.sha256);
    const out = path.join(tmp, 'arch-out');
    expect(unpackArchive(one.gzip(), one.sha256, out)).toBe(2);
    expect(fs.readFileSync(path.join(out, 'a', 'b', 'x.md'), 'utf8')).toBe('林晓');
    expect(() => readArchive(one.gzip(), '0'.repeat(64))).toThrow(/does not match its id/);
    const evil = Buffer.concat([Buffer.from('KPA1\n'), Buffer.from(`${JSON.stringify({ p: '../escape.md', n: 1 })}\n`), Buffer.from('x')]);
    const sha = crypto.createHash('sha256').update(evil).digest('hex');
    expect(() => readArchive(zlib.gzipSync(evil), sha)).toThrow(/escapes its folder/);
  });

  it('knows a private pack', () => {
    expect(packMayLeave(loadPack(packDir))).toBe(true);
    expect(packMayLeave(loadPack(privateDir))).toBe(false);
  });
});

describe('the producer channel', () => {
  it('answers this machine with the data root\'s token only, and checks a spec field by field', async () => {
    expect((await fetch(`${base}/eval/v1/status`)).status).toBe(401);
    expect((await fetch(`${base}/eval/v1/status`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // a request a proxy forwarded from elsewhere is not this machine's
    expect((await fetch(`${base}/eval/v1/status`, { headers: { authorization: `Bearer ${producerToken}`, 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(404);
    expect((await status()).offered).toBe(true);
    const offer = (spec: unknown) => fetch(`${base}/eval/v1/offer`, { method: 'POST', headers: { authorization: `Bearer ${producerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ spec }) });
    const good = { kind: 'eval-session', run: 'r1', label: 'x', agent: { family: 'codex', model: 'gpt-test', effort: 'low', speed: null }, sandbox: 'read-only', maxSteps: 5, timeoutMs: 60_000, prompt: 'p', archive: null, mcp: null };
    expect((await offer({ ...good, agent: { ...good.agent, model: '' } })).status).toBe(400);
    expect((await offer({ ...good, sandbox: 'workspace-write' })).status).toBe(400);
    expect((await offer({ ...good, mcp: { url: 'http://example.com/mcp', secret: 'x'.repeat(20), tools: ['knode_ls'] } })).status).toBe(400);
    expect((await offer({ ...good, archive: { sha256: 'a'.repeat(64), bytes: 1 } })).status).toBe(400);
  });

  it('says whether it holds an archive: 404 before the upload, 200 after', async () => {
    const dir = path.join(tmp, 'held');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    const packed = packFolder(dir);
    const at = `${base}/eval/v1/archives/${packed.sha256}`;
    const auth = { authorization: `Bearer ${producerToken}` };
    expect((await fetch(at, { method: 'HEAD', headers: auth })).status).toBe(404);
    expect((await fetch(at, { method: 'PUT', headers: { ...auth, 'content-type': 'application/gzip' }, body: packed.gzip() })).status).toBe(200);
    expect((await fetch(at, { method: 'HEAD', headers: auth })).status).toBe(200);
  });

  it('lets an eval token lease only eval work, and a label token none of it', async () => {
    const tokens = new RemoteTokenStore(root);
    const label = tokens.create({ name: 'labeler', scopes: ['label'], workspaces: ['admin/default'] }).token;
    const config = async (t: string) => (await (await fetch(`${base}/remote/v1/w/admin/default/work/config`, { headers: { authorization: `Bearer ${t}` } })).json()) as { kinds: Record<string, boolean> };
    expect((await config(evalToken)).kinds).toMatchObject({ 'eval-call': true, 'eval-session': true, extract: false, session: false });
    expect((await config(label)).kinds).toMatchObject({ 'eval-call': false, 'eval-session': false });
    expect(() => tokens.create({ name: 'x', scopes: ['label'], workspaces: ['*'], kinds: ['eval-call'] })).toThrow(/scope of its own/);
  });
});

describe('the worker', () => {
  it('says with --check what it takes of the server\'s eval work', async () => {
    const child = spawn(process.execPath, [workerScript, '--server', base, '--workspace', 'admin/default', '--eval', 'codex:1,claude:1', '--codex-bin', path.join(tmp, 'bin', 'codex'), '--claude-bin', path.join(tmp, 'bin', 'claude'), '--check'], {
      env: { ...process.env, KNODE_TOKEN: evalToken }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    expect(await new Promise((resolve) => child.on('exit', resolve))).toBe(0);
    expect(out).toMatch(/scopes eval/);
    expect(out).toMatch(/evaluation work on codex × 1: installed; takes eval-call, eval-session here/);
    expect(out).toMatch(/evaluation work on claude × 1: installed; takes eval-call here/);
  }, 30_000);
});

describe('an evaluation run with remote workers', () => {
  let w1: ChildProcess;
  const e2eDir = path.join(runs, 'remote');

  it('runs on its own slots through serve with --local while no worker is online', async () => {
    const before = (await evalWork.calls.status()).totals.offered;
    const res = await runEval({ ...common, packs: [packDir], systems: ['closed-book', 'agent-grep'], runDir: path.join(runs, 'alone'), remote: remoteOpts(), local: { codex: 2, claude: 1 } });
    const store = new RunStore(res.runDir);
    const answers = store.allAnswers();
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error)).toEqual([]);
    expect(new Set(answers.map((a) => a.worker))).toEqual(new Set(['local']));
    expect(new Set(answers.map((a) => a.backend))).toEqual(new Set(['codex-cli:gpt-test']));
    // a session on the run's own slot keeps what its commands returned, as a worker's does
    const grep = answers.find((a) => a.system === 'agent-grep')!;
    expect(grep.outputs?.map((o) => o?.chars)).toEqual([grep.outputs![0]!.text.length, expect.any(Number)]);
    expect(grep.outputs![1]!.text.length).toBe(2000);
    expect(store.meta()!.remote).toEqual({ serve: base, calls: true, judge: true });
    expect(store.allScores().some((s) => s.worker === 'local' && s.backend === 'claude-cli:claude-test')).toBe(true);
    // published to serve and taken there by the run's own slots: one path either way
    expect((await evalWork.calls.status()).totals.offered).toBeGreaterThan(before);
    // with serve gone, the run publishes to a broker of its own
    expect(await RemoteEval.connect({ serveUrl: 'http://127.0.0.1:9', token: producerToken, run: 'x' })).toBeNull();
  }, 120_000);

  it('builds, answers and scores a fixture pack entirely on a worker', async () => {
    w1 = startWorker('w1');
    await until(async () => (await status()).online['eval-call'].codex > 0 && (await status()).online['eval-session'].codex > 0 && (await status()).online['eval-call'].claude > 0);
    const res = await runEval({ ...common, packs: [packDir], systems: ['knode-ask', 'closed-book', 'agent-grep', 'agent-knode'], runDir: e2eDir, remote: remoteOpts() });
    const store = new RunStore(res.runDir);
    const knode = store.allBuilds().find((b) => b.system === 'knode')!;
    expect(knode.ok).toBe(true);
    expect(knode.usage.calls).toBeGreaterThan(0);
    expect([knode.worker, knode.backend]).toEqual(['laptop/w1', 'codex-cli:gpt-test']);
    // the build sent as many calls at once as the slots online, never fewer than an old command line's six
    const callSlots = (await status()).online['eval-call'].codex;
    const notes = knode.notes as Record<string, number>;
    expect(notes.passConcurrency).toBe(Math.max(KNODE_EVAL_CONCURRENCY, callSlots));
    expect(notes.passBatch).toBeGreaterThanOrEqual(KNODE_EVAL_BATCH);
    // and its reviews' judge calls as wide as a pass
    expect(notes.judgeConcurrency).toBe(notes.passConcurrency);
    const answers = store.allAnswers();
    for (const s of ['knode-ask', 'closed-book', 'agent-grep', 'agent-knode']) expect(answers.filter((a) => a.system === s).length, s).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error).map((a) => `${a.system}: ${a.error}`)).toEqual([]);
    expect(answers.map((a) => [a.worker, a.backend]).filter(([w, b]) => w !== 'laptop/w1' || b !== 'codex-cli:gpt-test')).toEqual([]);
    // an agent's session parsed here: its trace, and the file it read named by the worker's path, read as this run's copy
    const grep = answers.find((a) => a.system === 'agent-grep')!;
    expect(grep.toolCalls).toBe(2);
    expect(grep.commands![0]).toBe('rg -n 林晓 .');
    expect(grep.retrieved).toContain('email/2026-03-05.md');
    expect(grep.leaked ?? []).toEqual([]);
    expect(grep.usage.calls).toBe(1);
    expect(answers.find((a) => a.system === 'agent-knode')!.commands).toEqual(['mcp:knode.knode_resolve {"query":"林晓的岗位"}']);
    // what each command returned, beside it (docs/design/33 D7): the worker sent the long one cut to its head, with its length
    expect(grep.outputs![0]).toEqual({ text: 'email/2026-03-05.md:3:林晓将入职澜舟科技\n', chars: 'email/2026-03-05.md:3:林晓将入职澜舟科技\n'.length });
    expect(grep.outputs![1]!.text.length).toBe(2000);
    expect(grep.outputs![1]!.chars).toBeGreaterThan(5000);
    expect(answers.find((a) => a.system === 'agent-knode')!.outputs).toEqual([{ text: '{"entities":[{"name":"林晓"}]}', chars: 28 }]);
    // the judge's calls went to the worker's claude slot
    const scored = store.allScores().filter((s) => s.worker);
    expect(scored.length).toBeGreaterThan(0);
    expect(new Set(scored.map((s) => `${s.worker} ${s.backend}`))).toEqual(new Set(['laptop/w1 claude-cli:claude-test']));
    // nothing here but embeddings: every model call and session ran on the worker
    const meter = new Meter(path.join(res.runDir, 'meter.jsonl'));
    expect(meter.all((e) => !e.embeddingCalls && !e.worker)).toEqual([]);
    // the corpus went to the worker once, and every session read a fresh copy of it
    expect(logs.get('w1')!.filter((l) => /archive [0-9a-f]{12} downloaded/.test(l)).length).toBe(1);
  }, 180_000);

  it('answers a repeat as a new answer, under its own key, and scores it under its system with the repeat on the score', async () => {
    const res = await runEval({ ...common, packs: [packDir], systems: ['knode-ask', 'closed-book', 'agent-grep', 'agent-knode'], runDir: e2eDir, remote: remoteOpts(), repeat: 2, repeatSystems: ['closed-book'] });
    const store = new RunStore(res.runDir);
    const closed = store.allAnswers().filter((a) => a.system === 'closed-book');
    const firsts = closed.filter((a) => !a.repeat);
    const seconds = closed.filter((a) => a.repeat === 2);
    expect(seconds.length).toBe(firsts.length);
    expect(new Set(seconds.map((a) => a.key)).size).toBe(seconds.length);
    expect(seconds.every((a) => !firsts.some((f) => f.key === a.key))).toBe(true);
    // asked again, not replayed from the reply cache
    expect(seconds.every((a) => a.usage.calls > a.usage.replayedCalls)).toBe(true);
    expect(store.allScores().some((s) => s.system === 'closed-book' && s.repeat === 2)).toBe(true);
    expect(store.allAnswers().filter((a) => a.system === 'agent-grep' && a.repeat)).toEqual([]);
  }, 120_000);

  it('makes a knode build as wide as the call slots online, never narrower than an old command line\'s', async () => {
    const here = { concurrency: KNODE_EVAL_CONCURRENCY, batchSize: KNODE_EVAL_BATCH };
    expect(evalPassSettings()).toEqual(here);
    expect(await withRemote(null, async () => evalPassSettings())).toEqual(here);
    expect(await withRemote({ callSlots: () => 0 }, async () => evalPassSettings())).toEqual(here);
    expect(await withRemote({ callSlots: () => KNODE_EVAL_CONCURRENCY }, async () => evalPassSettings())).toEqual(here);
    const twenty = await withRemote({ callSlots: () => 20 }, async () => evalPassSettings());
    expect(twenty.concurrency).toBe(20);
    expect(twenty.batchSize).toBe(Math.ceil((20 * KNODE_EVAL_BATCH) / KNODE_EVAL_CONCURRENCY));
  });

  it('lets a build\'s reviews send judge calls as wide as its passes', async () => {
    const env = { shim: { baseUrl: 'http://127.0.0.1:9', embedder: null }, pack: {} } as unknown as Parameters<typeof evalWorkspaceConfig>[0];
    const here = evalWorkspaceConfig(env);
    expect(here.review?.directConcurrency).toBe(KNODE_EVAL_CONCURRENCY);
    const wide = await withRemote({ callSlots: () => 20 }, async () => evalWorkspaceConfig(env));
    expect(wide.review?.directConcurrency).toBe(20);
    expect(wide.extraction.concurrency).toBe(20);
  });

  it('keeps a private pack on this machine\'s slots while a worker is online', async () => {
    const res = await runEval({ ...common, packs: [privateDir], systems: ['closed-book', 'agent-grep'], runDir: path.join(runs, 'private'), remote: remoteOpts(), local: { codex: 2, claude: 1 } });
    const store = new RunStore(res.runDir);
    expect(store.allAnswers().length).toBeGreaterThan(0);
    expect(new Set(store.allAnswers().map((a) => a.worker))).toEqual(new Set(['local']));
    expect(store.allScores().filter((s) => s.worker && s.worker !== 'local')).toEqual([]);
    // published to serve, and the worker online took none of it
    const mine = sourceLog.filter((l) => / private /.test(l) && / → /.test(l));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((l) => !/→ local\/private\//.test(l))).toEqual([]);
  }, 120_000);

  it('resumes after the run is stopped, without a record twice', async () => {
    const dir = path.join(runs, 'restart');
    const ac = new AbortController();
    const answersFile = path.join(dir, 'answers.jsonl');
    const watch = setInterval(() => {
      if (fs.existsSync(answersFile) && fs.readFileSync(answersFile, 'utf8').trim().split('\n').length >= 2) ac.abort();
    }, 20);
    await expect(runEval({ ...common, limit: 6, packs: [packDir], systems: ['closed-book', 'agent-grep'], runDir: dir, remote: remoteOpts(), signal: ac.signal })).rejects.toThrow(/cancelled/);
    clearInterval(watch);
    const partial = new RunStore(dir).allAnswers().length;
    await runEval({ ...common, limit: 6, packs: [packDir], systems: ['closed-book', 'agent-grep'], runDir: dir, remote: remoteOpts() });
    const lines = fs.readFileSync(answersFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string; error?: string });
    expect(lines.filter((l) => l.error)).toEqual([]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
    expect(lines.length).toBeGreaterThan(partial);
    // scoring from the records alone, its judge calls on the worker too
    expect(await scoreRun(dir, { judgeProvider: 'claude-cli', judgeModel: 'claude-test', remote: remoteOpts() })).toBe(0);
  }, 180_000);

  it('gives an MCP agent the run\'s tools through serve, filtered to its own', async () => {
    const remote = (await RemoteEval.connect({ ...remoteOpts(), run: 'mcp-test' }))!;
    const empty = fs.mkdtempSync(path.join(tmp, 'mcp-'));
    // the run's tool host on a workspace it holds open (docs/design/31 D4); serve proxies the session's calls to it
    fs.mkdirSync(path.join(root, 'raw', 'docs', 'email'), { recursive: true });
    fs.writeFileSync(path.join(root, 'raw', 'docs', 'email', '2026-03-05.md'), '# 入职\n');
    const host = await startToolHost(async () => rootCtx, ['knode_ls']);
    try {
      const r = await withRemote(new PackScope(remote, true, 'any'), () => runAgent({
        cwd: empty, sandbox: 'read-only', model: 'gpt-test', prompt: 'CALL_MCP',
        mcp: { name: 'knode', url: host.url, token: host.secret, enabledTools: ['knode_ls'] },
      }));
      expect(r.worker).toBe('laptop/w1');
      expect(r.error).toBeUndefined();
      expect(r.text).toMatch(/^tools: knode_ls; knode_ls: .*email.*; knode_secret: refused/s);
    } finally {
      remote.close();
      await host.close();
    }
    // every call through the route is audited, never its content
    const audit = fs.readFileSync(path.join(root, '.knode', 'remote-audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"evalSession":"[0-9a-f-]{36}".*"tool":"knode_ls"/);
    expect(audit).toMatch(/"tool":"knode_secret".*"status":403/);
  }, 60_000);

  it('gives arm B\'s search over the rag index to a session on a worker, through serve', async () => {
    const res = await runEval({ ...common, packs: [packDir], systems: ['agent-rag'], runDir: path.join(runs, 'agent-rag'), remote: remoteOpts() });
    const answers = new RunStore(res.runDir).allAnswers();
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error).map((a) => a.error)).toEqual([]);
    for (const a of answers) {
      expect(a.worker).toBe('laptop/w1');
      expect(a.commands![0]).toBe('mcp:knode.search {"query":"林晓 澜舟科技","k":2}');
      // the hits came back from the run's index over serve's lease-bound route, and the answer cites the first
      const hits = JSON.parse(a.outputs![0]!.text) as { doc: string; passage: string; score: number }[];
      expect(hits).toHaveLength(2);
      expect(a.text).toContain(`[doc: ${hits[0].doc}]`);
      expect(a.retrieved).toContain(hits[0].doc);
    }
    const audit = fs.readFileSync(path.join(root, '.knode', 'remote-audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"evalSession":"[0-9a-f-]{36}".*"tool":"search"/);
  }, 120_000);

  it('runs arm D on a worker: the wiki and the sources as its folder, knode\'s six retrieval tools through serve and no other', async () => {
    const res = await runEval({ ...common, packs: [packDir], systems: ['agent-knode-full'], runDir: path.join(runs, 'agent-knode-full'), remote: remoteOpts(), reuseBuildsFrom: e2eDir });
    const answers = new RunStore(res.runDir).allAnswers();
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error).map((a) => a.error)).toEqual([]);
    for (const a of answers) {
      expect(a.worker).toBe('laptop/w1');
      expect(a.text).toMatch(/^folder: raw,wiki; knode_search: answered; knode_read: refused/);
      expect(a.commands).toEqual(['mcp:knode.knode_search {"query":"林晓","k":2}']);
      expect(a.outputs![0]!.chars).toBeGreaterThan(0);
    }
    const audit = fs.readFileSync(path.join(root, '.knode', 'remote-audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"tool":"knode_read".*"status":403/);
  }, 120_000);

  it('revokes a session\'s token and stops it on the worker when the run is cancelled', async () => {
    await stopWorker(w1);
    const tokenFile = path.join(tmp, 'session-token.json');
    const w2 = startWorker('w2', { FAKE_EVAL_SLOW_MS: '60000', FAKE_EVAL_TOKEN_FILE: tokenFile }, 'codex:1');
    const ac = new AbortController();
    const run = runEval({ ...common, packs: [packDir], systems: ['agent-knode'], runDir: path.join(runs, 'cancel'), remote: remoteOpts(), reuseBuildsFrom: e2eDir, signal: ac.signal });
    await until(() => fs.existsSync(tokenFile), 60_000);
    const { url, token } = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as { url: string; token: string };
    const list = () => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect((await list()).status).not.toBe(401);
    ac.abort();
    await expect(run).rejects.toThrow(/cancelled/);
    expect((await list()).status).toBe(401);
    await until(() => logs.get('w2')!.some((l) => /no longer wants .* stopping it/.test(l)), 10_000);
    expect((await evalWork.sessions.status()).leases).toEqual([]);
    expect(new RunStore(path.join(runs, 'cancel')).allAnswers()).toEqual([]);
    workers.push(w2);
  }, 120_000);

  it('has a worker refuse a malformed task before anything runs', async () => {
    const spec: EvalSessionSpec = {
      kind: 'eval-session', run: 'bad', key: 'bad-piece-1', eligible: 'any', label: 'bad', agent: { family: 'codex', model: '--config=evil', effort: null, speed: null },
      sandbox: 'read-only', maxSteps: 5, timeoutMs: 60_000, prompt: 'p', archive: null, mcp: null,
    };
    // offered straight to the source, past the producer's own checks: the worker checks every field again
    const offer = evalWork.sessions.offer(spec);
    try {
      await until(() => logs.get('w2')!.some((l) => /refused the eval session/.test(l)), 20_000);
      // the worker's refusal is its failure: the piece goes back in line (it never comes back to the run as an answer)
      await until(() => sourceLog.some((l) => /eval bad bad: .* could not serve it \(fatal; .*refused the eval session: it names no model, or its model name is not one/.test(l)), 10_000);
    } finally {
      // a piece no worker will serve would wait for ever: the next test's workers must not find it
      offer.cancel();
    }
    expect(await offer.result).toEqual({ outcome: 'cancelled' });
  }, 30_000);
});

describe('a run that waits for workers (docs/design/32 §3)', () => {
  const runStatus = async (run: string) => (await (await fetch(`${base}/eval/v1/status?run=${run}`, { headers: { authorization: `Bearer ${producerToken}` } })).json()) as { run: { waiting: number; leased: number } };
  const stopAll = async () => {
    for (const w of workers) await stopWorker(w);
  };

  it('waits with no worker and no --local, and goes on when a worker appears', async () => {
    await stopAll();
    const runDir = path.join(runs, 'waits');
    const run = runEval({ ...common, packs: [packDir], systems: ['closed-book'], runDir, remote: remoteOpts() });
    await until(async () => (await runStatus('waits')).run.waiting > 0, 30_000);
    await sleep(500);
    // nothing ran in the run's process meanwhile
    expect(fs.existsSync(path.join(runDir, 'answers.jsonl'))).toBe(false);
    startWorker('w4', {}, 'codex:2,claude:1');
    await run;
    const answers = new RunStore(runDir).allAnswers();
    expect(answers.length).toBe(3);
    expect(new Set(answers.map((a) => a.worker))).toEqual(new Set(['laptop/w4']));
    expect(new Meter(path.join(runDir, 'meter.jsonl')).all((e) => !e.embeddingCalls && !e.worker)).toEqual([]);
  }, 120_000);

  it('leaves a piece waiting when its worker goes away, and runs nothing in the run process', async () => {
    await stopAll();
    const runDir = path.join(runs, 'gone');
    const w5 = startWorker('w5', { FAKE_EVAL_SLOW_MS: '60000' }, 'codex:1,claude:1');
    const run = runEval({ ...common, packs: [packDir], systems: ['agent-grep'], runDir, remote: remoteOpts() });
    // the worker took a session, then goes away holding it
    await until(() => logs.get('w5')!.some((l) => /eval session/.test(l)), 60_000);
    await stopWorker(w5);
    await until(async () => (await runStatus('gone')).run.waiting > 0 && (await status()).online['eval-session'].codex === 0, 30_000);
    await sleep(1_000);
    expect(fs.existsSync(path.join(runDir, 'answers.jsonl'))).toBe(false);
    startWorker('w6', {}, 'codex:1,claude:1');
    await run;
    const answers = new RunStore(runDir).allAnswers();
    expect(answers.length).toBe(2);
    expect(answers.filter((a) => a.error)).toEqual([]);
    expect(new Set(answers.map((a) => a.worker))).toEqual(new Set(['laptop/w6']));
    expect(new Meter(path.join(runDir, 'meter.jsonl')).all((e) => !e.embeddingCalls && !e.worker)).toEqual([]);
  }, 180_000);

  it('stops at the wait limit when the workers it needs are gone, and a resume finishes it', async () => {
    await stopAll();
    const runDir = path.join(runs, 'limit');
    const err = await runEval({ ...common, packs: [packDir], systems: ['closed-book'], runDir, remote: remoteOpts(), waitMinutes: 0.03, waitCheckMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(WaitLimitError);
    expect(new RunStore(runDir).allAnswers()).toEqual([]);
    // its pieces stay in serve, which keeps them (docs/design/32 §5): a worker may take them, and the resume collects them
    expect((await runStatus('limit')).run.waiting).toBeGreaterThan(0);
    startWorker('w7', {}, 'codex:2,claude:1');
    await runEval({ ...common, packs: [packDir], systems: ['closed-book'], runDir, remote: remoteOpts() });
    const lines = fs.readFileSync(path.join(runDir, 'answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string; error?: string });
    expect(lines.length).toBe(3);
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);
    expect(lines.filter((l) => l.error)).toEqual([]);
  }, 120_000);

  it('marks a piece three different workers could not serve as stuck, records nothing for it, and ends incomplete', async () => {
    await stopAll();
    // three machines whose Codex is missing: each one's failure is its own, never the piece's answer
    for (const name of ['wa', 'wb', 'wc']) startWorker(name, {}, 'codex:1', ['--codex-bin', path.join(tmp, 'bin', 'no-codex')]);
    const runDir = path.join(runs, 'stuck');
    const res = await runEval({ ...common, limit: 1, packs: [packDir], systems: ['closed-book'], runDir, remote: remoteOpts(), skipScoring: true });
    expect(res.stuck).toBe(1);
    expect(new RunStore(runDir).allAnswers()).toEqual([]);
    const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; workers?: string[]; system?: string });
    const stuck = events.find((e) => e.event === 'piece stuck')!;
    expect(stuck.system).toBe('closed-book');
    expect([...stuck.workers!].sort()).toEqual(['laptop/wa', 'laptop/wb', 'laptop/wc']);
    // run.json and the report list it
    expect(new RunStore(runDir).meta()!.stuck).toHaveLength(1);
    expect(fs.readFileSync(writeReport(runDir).md, 'utf8')).toMatch(/### Stuck: 1 piece\(s\) left unanswered[\s\S]*closed-book · answer[\s\S]*laptop\/w[abc]/);
    // a resume with a worker that can answers it
    await stopAll();
    startWorker('wd', {}, 'codex:1');
    const again = await runEval({ ...common, limit: 1, packs: [packDir], systems: ['closed-book'], runDir, remote: remoteOpts(), skipScoring: true });
    expect(again.stuck).toBe(0);
    expect(new RunStore(runDir).allAnswers().map((a) => a.worker)).toEqual(['laptop/wd']);
  }, 120_000);

  it('gives a run that names a pool only to workers of that pool', async () => {
    await stopAll();
    startWorker('wp', {}, 'codex:2,claude:1', ['--pool', 'gateway']);
    startWorker('wq', {}, 'codex:2,claude:1');
    await until(async () => (await status()).online['eval-call'].codex >= 4);
    const res = await runEval({ ...common, packs: [packDir], systems: ['closed-book'], runDir: path.join(runs, 'pooled'), remote: remoteOpts(), pool: 'gateway' });
    const store = new RunStore(res.runDir);
    expect(new Set(store.allAnswers().map((a) => a.worker))).toEqual(new Set(['laptop/wp']));
    expect(new Set(store.allScores().filter((x) => x.worker).map((x) => x.worker))).toEqual(new Set(['laptop/wp']));
    // the report says which pool and worker did the work
    expect(writeReport(res.runDir).data.ranAt!.filter((r) => r.calls + r.sessions > 0).map((r) => `${r.pool} ${r.worker}`)).toEqual(['gateway laptop/wp']);
    expect(store.meta()!.work).toMatchObject({ broker: 'serve', serve: base, local: null, pool: 'gateway', waitMinutes: 30, legacy: false });
    // a worker that declares no pool is in its token's
    const byToken = await runEval({ ...common, packs: [packDir], systems: ['closed-book'], runDir: path.join(runs, 'pooled-token'), remote: remoteOpts(), pool: 'laptop', skipScoring: true });
    expect(new Set(new RunStore(byToken.runDir).allAnswers().map((a) => a.worker))).toEqual(new Set(['laptop/wq']));
    // and a pool nobody is in waits, then stops naming it
    const err = await runEval({ ...common, packs: [packDir], systems: ['closed-book'], runDir: path.join(runs, 'pooled-none'), remote: remoteOpts(), pool: 'nowhere', waitMinutes: 0.03, waitCheckMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(WaitLimitError);
    expect(err.message).toMatch(/a model call on codex gpt-test in pool nowhere/);
  }, 120_000);
});

describe('a session that reaches its cap on a worker (docs/design/36 §5, the closing turn)', () => {
  const offer = async (spec: Record<string, unknown>) => (await (await fetch(`${base}/eval/v1/offer`, {
    method: 'POST', headers: { authorization: `Bearer ${producerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ spec }),
  })).text()).trim();
  const spec = (key: string, extra: Record<string, unknown> = {}) => ({
    kind: 'eval-session', run: 'closing', key, label: key, agent: { family: 'codex', model: 'gpt-test', effort: 'low', speed: null },
    sandbox: 'read-only', maxSteps: 2, timeoutMs: 60_000, prompt: 'who is 林晓 STEPS=6', archive: null, mcp: null, ...extra,
  });
  const calls = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin: string });

  it('is interrupted, resumed with the run\'s closing turn through serve, and answers with both turns\' tokens', async () => {
    for (const w of workers) await stopWorker(w);
    const callLog = path.join(tmp, 'closing-calls.jsonl');
    startWorker('wc', { FAKE_CODEX_LOG: callLog }, 'codex:1');
    const outcome = JSON.parse(await offer(spec('closing-0001', { closing: CLOSING_TURN })));
    expect(outcome).toMatchObject({ outcome: 'answered', worker: 'laptop/wc/eval-codex#1' });
    expect(outcome.session).toMatchObject({ capped: true, closing: 'answered' });
    const r = agentResultOf(outcome.session, { cwd: path.join(tmp, 'here'), prompt: 'p', sandbox: 'read-only', maxSteps: 2 }, { worker: outcome.worker, backend: outcome.backend, usage: outcome.usage, ms: 1 });
    expect(r).toMatchObject({ capped: true, closing: 'answered', toolCalls: 3 });
    expect(r.text).toMatch(/^closing turn of [0-9a-f-]{36}: You have reached your command budget/);
    // serve read the thread's last report (the closing turn's running total), not a sum
    expect(r.usage).toMatchObject({ inputTokens: 3000, outputTokens: 90 });
    const [main, closing, del] = calls(callLog).filter((c) => c.args[0] !== '-p' && !c.args.includes('debug'));
    expect(main.args).not.toContain('--ephemeral');
    expect(closing.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(closing.stdin).toBe(CLOSING_TURN);
    expect(closing.args).toContain('shell_tool');
    expect(closing.args.some((a) => a.startsWith('mcp_servers.'))).toBe(false);
    expect(del.args.slice(0, 2)).toEqual(['delete', '--force']);
    expect(del.args[2]).toBe(closing.args.at(-2));
  }, 60_000);

  it('from a run before the closing turn is stopped there as it always was', async () => {
    const callLog = path.join(tmp, 'closing-calls.jsonl');
    fs.rmSync(callLog, { force: true });
    const outcome = JSON.parse(await offer(spec('closing-0002')));
    expect(outcome.session.capped).toBe(true);
    expect(outcome.session.closing).toBeUndefined();
    const r = agentResultOf(outcome.session, { cwd: path.join(tmp, 'here'), prompt: 'p', sandbox: 'read-only', maxSteps: 2, closing: null }, { worker: outcome.worker, backend: outcome.backend, usage: outcome.usage, ms: 1 });
    expect(r).toMatchObject({ capped: true, text: '', usage: null });
    const runs = calls(callLog);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toContain('--ephemeral');
  }, 60_000);
});
