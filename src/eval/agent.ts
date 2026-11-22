import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { LlmEffort } from '../config.js';
import { cliCommand, CODEX_SERVICES_OFF, effortFor, resolveExecutable, runProcess } from '../llm/cli.js';
import { catalogArgs, exitFailure, withCodexCatalog } from '../llm/codex-catalog.js';
import { CallUsage, readCodexEvents } from '../llm/usage.js';
import { EVAL_HOME } from './pack.js';
import { currentRemote } from './placement.js';
import { PackScope, publishAgent } from './remote.js';
import { evalTempDir } from './tmp.js';
import { AGENT_MCP_TOKEN_ENV } from './toolhost.js';
import { toolOutput, type ToolOutput } from './trace.js';

/**
 * One Codex agent session over a folder (docs/design/23 §3): the grep
 * baseline, the agents that read a generated wiki, the agent with knode's
 * MCP tools, and the llm-wiki builder are all this one runner with a
 * different folder, sandbox and tool set — so the comparison is between
 * knowledge sources, not between agent harnesses.
 *
 * `codex exec` has no turn limit; the runner counts the session's command
 * and tool events as they stream and stops it at the cap, then asks it for
 * its answer in one closing turn with no tools (`CLOSING_TURN`). Codex's read-only
 * sandbox blocks writes, not reads, so every command line is also audited:
 * a path outside the session's folder that leads into the benchmark's own
 * files (packs, runs — the gold) voids the answer.
 */

/**
 * The MCP server a session gets: a stdio command Codex starts, or a running
 * Streamable-HTTP endpoint (the run's tool host, src/eval/toolhost.ts) that
 * Codex reaches with a bearer token it reads from its environment — never
 * from its command line.
 */
export type McpServerSpec = {
  name: string;
  /** Only these tools are offered (Codex `enabled_tools`). */
  enabledTools?: string[];
} & ({ command: string; args: string[]; env?: Record<string, string> } | { url: string; token: string });

/**
 * Where agent sessions run (docs/design/23 D18): a model chain's API links
 * become a Codex model provider billed to the key, a CLI link the Codex login.
 * Set once per run by `runEval`; absent, every session uses the login.
 */
export interface AgentRouting {
  pick(): { name: string; api?: { baseUrl: string; apiKey: string; model: string } } | null;
  charge(name: string, model: string, usage: CallUsage | null): void;
  exhaust(name: string, why: string): void;
}

let routing: AgentRouting | null = null;

export function setAgentRouting(r: AgentRouting | null): void {
  routing = r;
}

let stopping: AbortSignal | null = null;

/** The run's stop signal (set by `runEval`): a session that ends while it is up was stopped, not answered. */
export function setAgentStopping(signal: AbortSignal | null): void {
  stopping = signal;
}

/** The env var a session reads its API key from: never on the command line, where `ps` would show it. */
export const AGENT_KEY_ENV = 'KNODE_EVAL_AGENT_API_KEY';

/** Codex arguments that send a session to an OpenAI-compatible API (Responses) instead of the login. */
export function apiProviderArgs(baseUrl: string): string[] {
  return [
    '-c', 'model_provider="knode_eval_api"',
    '-c', `model_providers.knode_eval_api={ name = "knode eval API", base_url = ${JSON.stringify(baseUrl.replace(/\/$/, ''))}, env_key = "${AGENT_KEY_ENV}", wire_api = "responses" }`,
  ];
}

/**
 * What a session that reaches its command cap is told in its closing turn
 * (docs/design/36 §5, "The closing turn"): one wording for every arm, so a
 * low budget compares what each arm read in its commands, not which arm
 * stops when told. The session is interrupted when it starts its
 * `maxSteps + 1`th command or tool call and resumed for this one turn without
 * a shell or knode's tools (`closingArgs`); anything it starts in that turn
 * stops it with no answer. The answer stays marked `capped`.
 */
export const CLOSING_TURN = 'You have reached your command budget. Run no more commands and call no more tools: answer the question now, from what you have already read, in the form the task asked for. If what you have read is not enough to be sure, give your best answer and say what is missing.';

/** The closing turn is one model call; this bounds a hung one. */
export const CLOSING_TIMEOUT_MS = 5 * 60_000;

/** How a capped session's closing turn went (absent: the session was not capped, or has no closing turn). */
export type ClosingOutcome =
  /** It answered: the answer is the closing turn's. */
  | 'answered'
  /** It ended without an answer (no message, a failed resume). */
  | 'no-answer'
  /** It started a command, tool call or sub-agent and was stopped: no answer. */
  | 'used-a-tool'
  /** None ran: no thread to resume, or a worker from before the closing turn stopped it (the old stop). */
  | 'not-run';

/** A Codex thread id as it may be passed back on a command line (`codex exec resume`, `codex delete`). */
export const THREAD_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$/;

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  sandbox: 'read-only' | 'workspace-write';
  model?: string;
  effort?: LlmEffort;
  /** Command and tool events before the session is stopped (default 25). */
  maxSteps?: number;
  /**
   * What a session that reaches `maxSteps` is resumed with for its answer
   * (default `CLOSING_TURN`); null: it is stopped with what it had, as a
   * builder is. A session with a closing turn is saved by Codex while it
   * runs (it can only resume a saved one) and deleted when it ends.
   */
  closing?: string | null;
  timeoutMs?: number;
  command?: string;
  mcp?: McpServerSpec;
  /** Extra roots a command may touch without voiding the answer. */
  allowRoots?: string[];
  /** What the session is for, for a remote worker's log and Tasks (a system and task). */
  label?: string;
}

export interface AgentRunResult {
  text: string;
  usage: CallUsage | null;
  /** Command lines the agent ran, in order. */
  commands: string[];
  /** What each of `commands` returned, entry for entry (null: no output came back — the session stopped first). */
  outputs: (ToolOutput | null)[];
  toolCalls: number;
  capped: boolean;
  /** How the closing turn of a capped session went. */
  closing?: ClosingOutcome;
  /** Paths outside the folder that lead into benchmark files. */
  leaked: string[];
  /** Corpus files the agent's commands named, relative to cwd. */
  filesTouched: string[];
  ms: number;
  error?: string;
  /** The remote worker that ran it (docs/design/27 §8); absent = this machine. */
  worker?: string;
  /** The CLI and model it ran on, `codex-cli:<model>` (or the API link's name). */
  backend?: string;
  /** Killed by a signal, or stopped with the run: never an answer (its `error` says so). */
  cancelled?: boolean;
  /** The pool of the worker that ran it (docs/design/32 §2). */
  pool?: string;
}

/** Tokens a session's usage counts, 0 when it reported none. */
export function usageTokens(u: CallUsage | null | undefined): number {
  return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.reasoningTokens ?? 0) : 0;
}

const toml = (v: unknown) => JSON.stringify(v);

/** The turn a capped session is resumed with: the option's, else the shared wording; null for none. */
export function closingOf(opts: Pick<AgentRunOptions, 'closing'>): string | null {
  return opts.closing === undefined ? CLOSING_TURN : opts.closing;
}

/**
 * The session's `codex exec` arguments: the one-shot call's (src/llm/cli.ts
 * `codexExecArgs`) — user config, plugins, apps and analytics off, the model
 * catalog from a local copy when `catalog` names one — with the sandbox, the
 * folder and knode's MCP server where the session has it.
 */
export function agentArgs(opts: AgentRunOptions, outFile: string, catalog: string | null = null): string[] {
  // a session that may need its closing turn is saved, since only a saved one resumes; nothing learns from it
  const saved = closingOf(opts) !== null;
  const args = [
    'exec', '--ignore-user-config', ...(saved ? ['-c', 'memories.generate_memories=false'] : ['--ephemeral']), ...CODEX_SERVICES_OFF, ...catalogArgs(catalog),
    '-c', 'web_search="disabled"', '--skip-git-repo-check', '--sandbox', opts.sandbox, '--cd', opts.cwd,
    '--output-last-message', outFile, '--json',
  ];
  if (opts.model) args.push('--model', opts.model);
  const effort = effortFor('codex-cli', opts.effort);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (opts.mcp) {
    const key = `mcp_servers.${opts.mcp.name}`;
    if ('url' in opts.mcp) {
      // as a remote worker gives a session the run's tools (worker/knode-worker.mjs): the token stays in the environment
      args.push('-c', `${key}.url=${toml(opts.mcp.url)}`, '-c', `${key}.bearer_token_env_var="${AGENT_MCP_TOKEN_ENV}"`);
    } else {
      args.push('-c', `${key}.command=${toml(opts.mcp.command)}`, '-c', `${key}.args=${toml(opts.mcp.args)}`);
      if (opts.mcp.env && Object.keys(opts.mcp.env).length) {
        args.push('-c', `${key}.env={${Object.entries(opts.mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`);
      }
    }
    if (opts.mcp.enabledTools?.length) args.push('-c', `${key}.enabled_tools=${toml(opts.mcp.enabledTools)}`);
    args.push('-c', `${key}.default_tools_approval_mode="approve"`, '-c', `${key}.tool_timeout_sec=300`);
  }
  args.push('-');
  return args;
}

/**
 * The closing turn's `codex exec resume`: the session's model, effort, catalog
 * and sandbox, its shell tool off and no MCP server, so the turn has nothing
 * to run (verified on codex-cli 0.171.0: the model then reports the shell
 * gone). Codex still offers a few tools of its own (sub-agents, patches,
 * images); the trace stops the turn at the first it starts. The closing
 * prompt goes on stdin.
 */
export function closingArgs(opts: AgentRunOptions, threadId: string, outFile: string, catalog: string | null = null): string[] {
  const args = [
    'exec', 'resume', '--ignore-user-config', '-c', 'memories.generate_memories=false', ...CODEX_SERVICES_OFF, ...catalogArgs(catalog),
    '-c', 'web_search="disabled"', '-c', `sandbox_mode=${toml(opts.sandbox)}`, '--disable', 'shell_tool', '--skip-git-repo-check',
    '--output-last-message', outFile, '--json',
  ];
  if (opts.model) args.push('--model', opts.model);
  const effort = effortFor('codex-cli', opts.effort);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  args.push(threadId, '-');
  return args;
}

/** Path-like tokens of a command line: absolute, home-relative, or climbing out with `..`. */
export function pathTokens(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s'"=(:])((?:\/|~\/|\.\.(?:\/|$))[^\s'"|;&<>()]*)/g)) out.push(m[1]);
  return out;
}

const SYSTEM_PREFIXES = ['/usr/', '/bin/', '/sbin/', '/opt/homebrew/', '/dev/', '/System/', '/Library/', '/private/etc/', '/etc/'];

/**
 * Which of a command's paths reach benchmark files: anything under the eval
 * home (packs, runs, sources) or the person's home outside the folder.
 * System binaries and devices are fine; so is the folder itself.
 */
export function leakedPaths(command: string, cwd: string, allowRoots: string[] = [], home = os.homedir()): string[] {
  const root = path.resolve(cwd);
  const leaks: string[] = [];
  for (const tok of pathTokens(command)) {
    const expanded = tok.startsWith('~/') ? path.join(home, tok.slice(2)) : tok;
    const abs = path.resolve(root, expanded);
    if (abs === root || abs.startsWith(root + path.sep)) continue;
    if (allowRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) continue;
    if (SYSTEM_PREFIXES.some((p) => abs.startsWith(p))) continue;
    // the staged folder's parent holds nothing but the folder, so climbing one level is harmless
    if (abs === path.dirname(root)) continue;
    if (abs.startsWith(EVAL_HOME) || abs.startsWith(home) || abs.includes('knode-eval')) leaks.push(tok);
  }
  return leaks;
}

/** Corpus-relative files a command names (rg/grep/cat/sed/head arguments that exist under cwd). */
export function touchedFiles(command: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const tok of command.split(/[\s'"|;&<>()]+/)) {
    if (!tok || tok.startsWith('-')) continue;
    const abs = path.resolve(cwd, tok);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue;
    try {
      if (fs.statSync(abs).isFile()) out.add(path.relative(cwd, abs).split(path.sep).join('/'));
    } catch {
      /* not a file */
    }
  }
  return [...out];
}

interface CodexItem {
  id?: string;
  type?: string;
  command?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  /** A finished command's stdout and stderr. */
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  /** A finished MCP call's result or error. */
  result?: { content?: unknown[]; structured_content?: unknown } | null;
  error?: { message?: string } | null;
  /** The output's full length when a worker cut it to its head (worker/knode-worker.mjs). */
  knode_output_chars?: number;
}

/** The text an MCP call returned: its text content blocks, else its structured content, else its error. */
function mcpText(item: CodexItem): { text: string; failed: boolean } {
  if (item.error?.message) return { text: item.error.message, failed: true };
  const blocks = Array.isArray(item.result?.content) ? item.result!.content : [];
  const texts = blocks.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : JSON.stringify(b)));
  const text = texts.length ? texts.join('\n') : item.result?.structured_content !== undefined ? JSON.stringify(item.result.structured_content) : '';
  return { text, failed: item.status === 'failed' };
}

/** What a finished command or MCP call returned, as the trace keeps it; null for any other item. */
export function itemOutput(item: CodexItem): ToolOutput | null {
  const chars = typeof item.knode_output_chars === 'number' ? item.knode_output_chars : undefined;
  if (item.type === 'command_execution') {
    const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
    return toolOutput(typeof item.aggregated_output === 'string' ? item.aggregated_output : '', { chars, failed });
  }
  if (item.type === 'mcp_tool_call') {
    const r = mcpText(item);
    return toolOutput(r.text, { chars, failed: r.failed });
  }
  return null;
}

/**
 * A session's `codex exec --json` events as they stream: its trace (command
 * lines and MCP calls), the step cap, and the leak audit. One reader for a
 * session run here and one a remote worker ran (src/eval/remote.ts), whose
 * folder paths are read as this machine's copy (`rewrite`) and whose home is
 * the worker's.
 */
export class AgentTrace {
  readonly commands: string[] = [];
  /** Entry for entry with `commands`: what each returned, once its item completed (docs/design/33 D7). */
  readonly outputs: (ToolOutput | null)[] = [];
  readonly leaked: string[] = [];
  /** Started items by Codex's id, and those of each kind still waiting for their output (events without ids). */
  private readonly byId = new Map<string, number>();
  private readonly open = new Map<string, number[]>();
  readonly touched = new Set<string>();
  steps = 0;
  capped = false;
  /** Codex's threads, as their `thread.started` events named them. */
  readonly threads: string[] = [];
  /** The session was resumed for its closing turn: a `thread.started` of a thread it already had. */
  closing = false;
  /** What the closing turn started that is no message: a command, a tool call, a sub-agent. */
  closingTools = 0;

  constructor(private readonly opts: { cwd: string; maxSteps: number; allowRoots?: string[]; home?: string; rewrite?: (command: string) => string; onCap?: () => void; onClosingTool?: () => void }) {}

  line(line: string): void {
    if (!line.startsWith('{')) return;
    let ev: { type?: string; item?: CodexItem; thread_id?: unknown };
    try {
      ev = JSON.parse(line) as { type?: string; item?: CodexItem; thread_id?: unknown };
    } catch {
      return;
    }
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      if (this.threads.includes(ev.thread_id)) this.closing = true;
      else this.threads.push(ev.thread_id);
      return;
    }
    if (!ev.item) return;
    if (ev.type === 'item.completed') return this.completed(ev.item);
    if (ev.type !== 'item.started') return;
    const item = ev.item;
    if (this.closing && item.type !== 'agent_message' && item.type !== 'reasoning') {
      // the closing turn has nothing to run: whatever it starts ends it, and is kept in the trace below
      this.closingTools++;
      if (this.closingTools === 1) this.opts.onClosingTool?.();
    }
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      this.steps++;
      this.began(item);
      this.commands.push(item.command);
      const command = this.opts.rewrite ? this.opts.rewrite(item.command) : item.command;
      this.leaked.push(...leakedPaths(command, this.opts.cwd, this.opts.allowRoots, this.opts.home));
      for (const f of touchedFiles(command, this.opts.cwd)) this.touched.add(f);
    } else if (item.type === 'mcp_tool_call') {
      this.steps++;
      this.began(item);
      this.commands.push(`mcp:${item.server ?? ''}.${item.tool ?? ''} ${JSON.stringify(item.arguments ?? {}).slice(0, 300)}`);
    }
    if (this.steps > this.opts.maxSteps && !this.capped) {
      this.capped = true;
      this.opts.onCap?.();
    }
  }

  private began(item: CodexItem): void {
    const i = this.commands.length;
    this.outputs.push(null);
    if (item.id) this.byId.set(item.id, i);
    else (this.open.get(item.type!) ?? this.open.set(item.type!, []).get(item.type!)!).push(i);
  }

  /** A finished item: its output goes beside the entry its start made (by id, else the oldest of its kind still open). */
  private completed(item: CodexItem): void {
    const out = itemOutput(item);
    if (!out) return;
    let i = item.id !== undefined ? this.byId.get(item.id) : undefined;
    if (i === undefined) i = this.open.get(item.type!)?.shift();
    if (i === undefined || this.outputs[i]) return;
    this.outputs[i] = out;
  }
}

/**
 * One agent session. Inside an evaluation run's pack it is a published piece
 * (docs/design/32): a slot that leases it runs it — the run's own, through
 * `runAgentHere`, or a worker. A run routed over an agent chain publishes its
 * sessions for this machine's slots only, since the chain's links are this
 * machine's keys and logins. Outside a run (a test, a tool) it runs here.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const scope = currentRemote<PackScope>();
  if (scope) return publishAgent(scope, opts, () => runAgentHere(opts), !routing);
  return runAgentHere(opts);
}

/** A session on this machine: what a run's own slot does with an agent piece. */
export async function runAgentHere(opts: AgentRunOptions): Promise<AgentRunResult> {
  // down the chain: an API link until its budget or credit is gone, then the next
  for (;;) {
    const link = routing?.pick() ?? null;
    if (routing && !link) throw new Error('agent sessions: every model in the chain is spent');
    const r = await runAgentOnce(opts, link?.api);
    const model = link?.api?.model ?? opts.model ?? '';
    r.backend = link?.api ? `${link.name}:${model || 'default'}` : `codex-cli:${model || 'default'}`;
    if (link) routing!.charge(link.name, model, r.usage);
    if (link && r.error && /insufficient_quota|exceeded your current quota|credit balance is too low|billing|payment required|\b402\b/i.test(r.error)) {
      routing!.exhaust(link.name, r.error.slice(0, 120));
      continue;
    }
    return r;
  }
}

/**
 * Stop a session at its cap: SIGINT, which Codex takes as an interrupt — the
 * turn is aborted, its tokens so far saved with the session, and the process
 * exits — then SIGKILL if it has not gone.
 */
function interrupt(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10_000).unref();
}

/** A saved session removed from Codex's home once it is over (`codex delete --force`); a failure only leaves it there. */
async function deleteThreads(cmd: string, ids: Iterable<string>): Promise<void> {
  for (const id of ids) {
    if (!THREAD_ID_RE.test(id)) continue;
    await runProcess(cmd, ['delete', '--force', id], '', 30_000).catch(() => {});
  }
}

async function runAgentOnce(opts: AgentRunOptions, api?: { baseUrl: string; apiKey: string; model: string }): Promise<AgentRunResult> {
  const out = evalTempDir('agent-out');
  const outDir = out.root;
  const outFile = path.join(outDir, 'answer.txt');
  const closingFile = path.join(outDir, 'closing.txt');
  const maxSteps = opts.maxSteps ?? 25;
  const closing = closingOf(opts);
  let child: ChildProcess | null = null;
  let buffer = '';
  const t0 = Date.now();
  // at the cap a session with a closing turn is interrupted, to be resumed; one without is stopped
  const newTrace = () => new AgentTrace({
    cwd: opts.cwd, maxSteps, allowRoots: opts.allowRoots,
    onCap: () => (closing !== null ? interrupt(child) : child?.kill('SIGTERM')),
    onClosingTool: () => interrupt(child),
  });
  let trace = newTrace();
  // the run stopping stops its sessions: what they had is no answer (docs/design/32 §3)
  const stopSignal = stopping;
  const onStop = () => child?.kill('SIGTERM');
  stopSignal?.addEventListener('abort', onStop, { once: true });
  let cmd: string | null = null;
  // every thread a try started, to delete when it is over
  const threads = new Set<string>();
  const feed = (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      trace.line(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  };

  try {
    let stdout = '';
    let closingStdout = '';
    let closingRan = false;
    let error: string | undefined;
    try {
      const command = cliCommand('codex-cli', opts.command ?? '');
      cmd = command;
      const sessionOpts = api ? { ...opts, model: api.model || opts.model } : opts;
      const env = api || (opts.mcp && 'url' in opts.mcp) ? {
        ...process.env,
        ...(api ? { [AGENT_KEY_ENV]: api.apiKey } : {}),
        ...(opts.mcp && 'url' in opts.mcp ? { [AGENT_MCP_TOKEN_ENV]: opts.mcp.token } : {}),
      } : undefined;
      const r = await withCodexCatalog(resolveExecutable(command), opts.model, async (catalog) => {
        // a repeat (Codex could not read the catalog copy) starts from nothing, as the first try did
        trace = newTrace();
        buffer = '';
        closingStdout = '';
        closingRan = false;
        const args = agentArgs(sessionOpts, outFile, catalog);
        if (api) args.splice(args.length - 1, 0, ...apiProviderArgs(api.baseUrl));
        const main = await runProcess(command, args, opts.prompt, opts.timeoutMs ?? 15 * 60_000, {
          cwd: opts.cwd, ...(env ? { env } : {}), onSpawn: (c) => (child = c), onStdout: feed,
        });
        for (const id of trace.threads) threads.add(id);
        const thread = trace.threads[0];
        if (trace.capped && closing !== null && thread && THREAD_ID_RE.test(thread) && !stopSignal?.aborted) {
          // the closing turn: the same thread, resumed for its answer with nothing to run
          closingRan = true;
          buffer = '';
          const cargs = closingArgs(sessionOpts, thread, closingFile, catalog);
          if (api) cargs.splice(cargs.length - 2, 0, ...apiProviderArgs(api.baseUrl));
          try {
            const c = await runProcess(command, cargs, closing, CLOSING_TIMEOUT_MS, {
              cwd: opts.cwd, ...(env ? { env } : {}), onSpawn: (p) => (child = p), onStdout: feed,
            });
            closingStdout = c.stdout;
          } catch {
            // a closing turn that could not run leaves the stop as it was: no answer
          }
        }
        return main;
      }, exitFailure);
      stdout = r.stdout;
      if (r.code !== 0 && !trace.capped) error = `codex exec exited with ${r.code}: ${readCodexEvents(r.stdout).error ?? r.stderr.slice(-300)}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // the main turn and the closing turn of one thread: Codex's last report is the thread's total (src/llm/usage.ts)
    const events = readCodexEvents(closingStdout ? `${stdout}\n${closingStdout}` : stdout);
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');
    const closingText = closingRan && trace.closing && !trace.closingTools ? read(closingFile) : '';
    // a capped session's answer is its closing turn's; with none (a builder), what the stop left
    const text = trace.capped && closing !== null ? closingText : read(outFile);
    const closingOutcome: ClosingOutcome | undefined = !trace.capped || closing === null ? undefined
      : !closingRan ? 'not-run' : trace.closingTools ? 'used-a-tool' : closingText ? 'answered' : 'no-answer';
    // killed by a signal (not at its step cap), or ended with nothing at all while the run was stopping: cancelled, asked again on resume
    const killed = (child as ChildProcess | null)?.signalCode ?? null;
    const empty = !text && trace.steps === 0 && !usageTokens(events.usage);
    const cancelled = !trace.capped
      ? (killed ? `cancelled: codex was killed by ${killed}` : empty && stopSignal?.aborted ? 'cancelled: the session ended with nothing while the run was stopping' : null)
      : closing !== null && !text && stopSignal?.aborted ? 'cancelled: the run stopped before the session\'s closing turn answered' : null;
    return {
      text,
      usage: events.usage,
      commands: trace.commands,
      outputs: trace.outputs,
      toolCalls: trace.steps,
      capped: trace.capped,
      ...(closingOutcome ? { closing: closingOutcome } : {}),
      leaked: [...new Set(trace.leaked)],
      filesTouched: [...trace.touched],
      ms: Date.now() - t0,
      ...(cancelled ? { error: cancelled, cancelled: true } : error && !text ? { error } : {}),
    };
  } finally {
    stopSignal?.removeEventListener('abort', onStop);
    out.cleanup();
    // a saved session (one with a closing turn) leaves nothing in Codex's home, however it ended
    for (const id of trace.threads) threads.add(id);
    if (cmd && closing !== null) await deleteThreads(cmd, threads);
  }
}

/** A copy of `src` in a fresh temp directory with nothing beside it, for an agent to read. */
export function isolatedCopy(src: string, name = 'kb'): { dir: string; cleanup: () => void } {
  const { root, cleanup } = evalTempDir('ro');
  const dir = path.join(root, name);
  fs.cpSync(src, dir, { recursive: true });
  return { dir, cleanup };
}
