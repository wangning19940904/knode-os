/**
 * What one model call used, as its provider reported it (docs/design/18).
 *
 * Every provider counts in its own way, and the readers here bring them to
 * one: `inputTokens` is every token the model read — what came from its
 * prompt cache and what was written to it included — and `outputTokens`
 * every token it wrote, its reasoning included. Codex and the OpenAI wires
 * count that way already; Claude and Cursor count cache reads and writes
 * beside `input`, so theirs are added up here.
 *
 * Measured usage is what an estimate learns from: a CLI wraps every prompt
 * in instructions of its own (about 15k tokens for both Codex and Cursor,
 * measured 2026-10-28) and a reasoning model writes far more than its answer,
 * neither of which can be seen in the text that goes in and comes out.
 */
export interface CallUsage {
  inputTokens: number;
  /** Of `inputTokens`, read from the provider's prompt cache (priced at about a tenth). */
  cachedInputTokens: number;
  /** Of `inputTokens`, written to the prompt cache (Anthropic prices those above plain input). */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Of `outputTokens`, the model's reasoning. */
  reasoningTokens: number;
  /** What the provider says the call cost in US dollars — Claude Code reports it. */
  costUsd?: number;
  /** Request and response bodies, where the backend sends them itself (an HTTP endpoint). */
  bytesUp?: number;
  bytesDown?: number;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Nothing counted: a usage with no tokens at all is no measurement. */
function counted(u: CallUsage): CallUsage | null {
  return u.inputTokens > 0 || u.outputTokens > 0 ? u : null;
}

/**
 * The usage in an OpenAI-compatible response, from the Responses wire
 * (`input_tokens`, `output_tokens` and their details) or Chat Completions
 * (`prompt_tokens`, `completion_tokens` and theirs). Null when the endpoint
 * sent none, as some relays and local servers do.
 */
export function usageFromOpenAi(body: unknown): CallUsage | null {
  const u = obj(obj(body).usage);
  const responses = 'input_tokens' in u || 'output_tokens' in u;
  const inDetails = obj(responses ? u.input_tokens_details : u.prompt_tokens_details);
  const outDetails = obj(responses ? u.output_tokens_details : u.completion_tokens_details);
  return counted({
    inputTokens: num(responses ? u.input_tokens : u.prompt_tokens),
    cachedInputTokens: num(inDetails.cached_tokens),
    cacheWriteTokens: 0,
    outputTokens: num(responses ? u.output_tokens : u.completion_tokens),
    reasoningTokens: num(outDetails.reasoning_tokens),
  });
}

/**
 * Claude Code's `--output-format json` wrapper: `usage` counts input beside
 * the cache's reads and writes, and `total_cost_usd` is the call priced at
 * the API's rates — what it would have cost on a key, plan or not.
 */
export function usageFromClaudeResult(wrapper: unknown): CallUsage | null {
  const w = obj(wrapper);
  const u = obj(w.usage);
  const cached = num(u.cache_read_input_tokens);
  const written = num(u.cache_creation_input_tokens);
  const usage = counted({
    inputTokens: num(u.input_tokens) + cached + written,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: num(u.output_tokens),
    reasoningTokens: 0,
  });
  const cost = num(w.total_cost_usd);
  if (usage && cost) usage.costUsd = cost;
  return usage;
}

/** cursor-agent's `result` event (stream-json): camel-cased, cache reads and writes beside `inputTokens`. */
export function usageFromCursorResult(event: unknown): CallUsage | null {
  const u = obj(obj(event).usage);
  const cached = num(u.cacheReadTokens ?? u.cache_read_input_tokens);
  const written = num(u.cacheWriteTokens ?? u.cache_creation_input_tokens);
  return counted({
    inputTokens: num(u.inputTokens ?? u.input_tokens) + cached + written,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: num(u.outputTokens ?? u.output_tokens),
    reasoningTokens: num(u.reasoningTokens ?? u.reasoning_output_tokens),
  });
}

export interface CodexEvents {
  /** Every turn's usage added up (a one-shot exec runs one); a resumed thread's last report (see below). */
  usage: CallUsage | null;
  /** What a failed run said: an `error` event, or the `turn.failed` one. */
  error: string | null;
  threadId: string | null;
}

/**
 * `codex exec --json` prints one event per line: `thread.started`, the
 * turn's items, and `turn.completed` with its usage — or `turn.failed` /
 * `error` with the reason (a usage limit, an expired login).
 *
 * The usage a `turn.completed` reports is the thread's running total. In one
 * exec that is its one turn; a `codex exec resume` of a thread starts from the
 * total its saved session recorded (verified on codex-cli 0.171.0: a session
 * stopped at 29,112 input tokens, resumed for one call of 17,918, reported
 * 47,030). So a stdout that holds a thread and then its resume (an agent's
 * closing turn, src/eval/agent.ts) counts that thread by its last report, not
 * by the sum; distinct threads still add up.
 */
export function readCodexEvents(stdout: string): CodexEvents {
  const zero = (): CallUsage => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  const threads = new Map<string, { usage: CallUsage; resumed: boolean }>();
  let error: string | null = null;
  let threadId: string | null = null;
  let current = { usage: zero(), resumed: false };
  threads.set('', current);
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      const seen = threads.get(event.thread_id);
      if (seen) seen.resumed = true;
      else threads.set(event.thread_id, { usage: zero(), resumed: false });
      current = threads.get(event.thread_id)!;
    } else if (event.type === 'turn.completed') {
      const u = obj(event.usage);
      const turn: CallUsage = {
        inputTokens: num(u.input_tokens),
        cachedInputTokens: num(u.cached_input_tokens),
        cacheWriteTokens: num(u.cache_write_input_tokens),
        outputTokens: num(u.output_tokens),
        reasoningTokens: num(u.reasoning_output_tokens),
      };
      // a resumed thread's report is its running total: it replaces what the thread had, never adds to it
      if (current.resumed) current.usage = turn;
      else for (const k of Object.keys(turn) as (keyof CallUsage)[]) current.usage[k] = (current.usage[k] ?? 0) + (turn[k] ?? 0);
    } else if (event.type === 'turn.failed') {
      const message = obj(event.error).message;
      if (typeof message === 'string' && message.trim()) error = message.trim();
    } else if (event.type === 'error' && typeof event.message === 'string' && event.message.trim()) {
      // an error event may precede turn.failed with the same text; the first one is kept
      error ??= event.message.trim();
    }
  }
  const total = zero();
  for (const t of threads.values()) for (const k of Object.keys(total) as (keyof CallUsage)[]) total[k] = (total[k] ?? 0) + (t.usage[k] ?? 0);
  return { usage: counted(total), error, threadId };
}

/** A usage a remote worker sent, held to the shape above: numbers only, nothing negative, nothing absurd. */
export function sanitizeUsage(value: unknown): CallUsage | null {
  const u = obj(value);
  const cap = (v: unknown, max: number) => Math.min(num(v), max);
  const usage = counted({
    inputTokens: cap(u.inputTokens, 50_000_000),
    cachedInputTokens: cap(u.cachedInputTokens, 50_000_000),
    cacheWriteTokens: cap(u.cacheWriteTokens, 50_000_000),
    outputTokens: cap(u.outputTokens, 10_000_000),
    reasoningTokens: cap(u.reasoningTokens, 10_000_000),
  });
  if (!usage) return null;
  usage.cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  usage.cacheWriteTokens = Math.min(usage.cacheWriteTokens, usage.inputTokens - usage.cachedInputTokens);
  usage.reasoningTokens = Math.min(usage.reasoningTokens, usage.outputTokens);
  const cost = cap(u.costUsd, 1_000);
  if (cost) usage.costUsd = cost;
  // bodies an endpoint backend sent and received; a CLI's are not countable
  if (u.bytesUp !== undefined || u.bytesDown !== undefined) {
    usage.bytesUp = cap(u.bytesUp, 1e9);
    usage.bytesDown = cap(u.bytesDown, 1e9);
  }
  return usage;
}
