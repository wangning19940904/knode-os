import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSING_TURN, runAgent } from '../src/eval/agent.js';
import { agentResultOf } from '../src/eval/remote.js';
import { unmeteredStop } from '../src/eval/score/usage.js';
import { readCodexEvents } from '../src/llm/usage.js';

/**
 * The closing turn (docs/design/36 §5): an agent that reaches its command
 * cap is interrupted, then resumed once — no shell, no knode tools — to answer
 * from what it has read. The answer stays `capped`; the tokens of both turns
 * are on record. A stand-in Codex (tests/helpers/fake-eval-cli.mjs) plays the
 * CLI as codex-cli 0.171.0 was seen to behave; a worker from before the
 * closing turn is a recorded event stream.
 */

const line = (e: unknown) => JSON.stringify(e);
const THREAD = '01a20200-ed5b-7482-874e-8f771eb88ca1';

let tmp: string;
let cli: string;
let log: string;
let cwd: string;
const calls = (): { args: string[]; stdin: string }[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-closing-'));
  cwd = path.join(tmp, 'corpus');
  fs.mkdirSync(path.join(cwd, 'email'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'email', '2026-03-05.md'), '# 入职\n\n林晓将入职澜舟科技。\n');
  cli = path.join(tmp, 'codex');
  fs.writeFileSync(cli, `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-eval-cli.mjs')}" "$@"\n`, { mode: 0o755 });
  log = path.join(tmp, 'calls.jsonl');
  process.env.FAKE_CODEX_LOG = log;
});

afterAll(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CLOSING_TOOL;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a session run here that reaches its cap', () => {
  it('is interrupted, answers in its closing turn with no tools, and is deleted from Codex\'s home', async () => {
    fs.rmSync(log, { force: true });
    const r = await runAgent({ cwd, prompt: 'who is 林晓 STEPS=6', sandbox: 'read-only', command: cli, maxSteps: 2, timeoutMs: 20_000 });
    // rg, cat, then the first of the six: the third start is past the cap
    expect(r.commands).toEqual(['rg -n 林晓 .', `cat ${path.join(cwd, 'email', '2026-03-05.md')}`, 'ls 0']);
    expect(r.capped).toBe(true);
    expect(r.closing).toBe('answered');
    expect(r.error).toBeUndefined();
    const [main, closing, del] = calls();
    const thread = /closing turn of ([0-9a-f-]{36}):/.exec(r.text)?.[1];
    expect(thread).toBeTruthy();
    expect(r.text).toBe(`closing turn of ${thread}: ${CLOSING_TURN.slice(0, 40)}\nFinal answer: 高级数据工程师`);
    // the thread's running total at the closing turn, not added to anything: the interrupted turn reported none
    expect(r.usage).toMatchObject({ inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 90, reasoningTokens: 12 });
    // saved (only a saved session resumes), nothing learnt from it
    expect(main.args).not.toContain('--ephemeral');
    expect(main.args).toContain('memories.generate_memories=false');
    // the closing turn: the same thread, the shared wording, no shell and no MCP server
    expect(closing.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(closing.args.slice(-2)).toEqual([thread, '-']);
    expect(closing.stdin).toBe(CLOSING_TURN);
    expect(closing.args.join(' ')).toContain('--disable shell_tool');
    expect(closing.args.join(' ')).toContain('sandbox_mode="read-only"');
    expect(closing.args.some((a) => a.startsWith('mcp_servers.'))).toBe(false);
    expect(del.args).toEqual(['delete', '--force', thread]);
    expect(calls()).toHaveLength(3);
  }, 30_000);

  it('gives no answer when its closing turn starts a tool, and keeps the attempt in the trace', async () => {
    fs.rmSync(log, { force: true });
    process.env.FAKE_CLOSING_TOOL = '1';
    try {
      const t0 = Date.now();
      const r = await runAgent({ cwd, prompt: 'who is 林晓 STEPS=6', sandbox: 'read-only', command: cli, maxSteps: 2, timeoutMs: 20_000 });
      // stopped at the start, not after the stand-in's 20 s wait
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(r.capped).toBe(true);
      expect(r.closing).toBe('used-a-tool');
      // its message before the tool ("I will read one more file.") is no answer
      expect(r.text).toBe('');
      expect(r.commands.at(-1)).toBe('cat more.md');
      expect(calls().map((c) => c.args[0])).toEqual(['exec', 'exec', 'delete']);
    } finally {
      delete process.env.FAKE_CLOSING_TOOL;
    }
  }, 30_000);

  it('a session without a closing turn (a builder) stays ephemeral and is stopped as before', async () => {
    fs.rmSync(log, { force: true });
    const r = await runAgent({ cwd, prompt: 'who is 林晓 STEPS=6', sandbox: 'read-only', command: cli, maxSteps: 2, timeoutMs: 20_000, closing: null });
    expect(r.capped).toBe(true);
    expect(r.closing).toBeUndefined();
    expect(r.text).toBe('');
    expect(r.usage).toBeNull();
    expect(calls()).toHaveLength(1);
    expect(calls()[0].args).toContain('--ephemeral');
  }, 30_000);

  it('a session under its cap answers in its own turn, and is deleted all the same', async () => {
    fs.rmSync(log, { force: true });
    const r = await runAgent({ cwd, prompt: 'who is 林晓', sandbox: 'read-only', command: cli, maxSteps: 5, timeoutMs: 20_000 });
    expect(r.capped).toBe(false);
    expect(r.closing).toBeUndefined();
    expect(r.text).toMatch(/Final answer: 高级数据工程师/);
    expect(r.usage).toMatchObject({ inputTokens: 1200, outputTokens: 60 });
    expect(calls().map((c) => c.args[0])).toEqual(['exec', 'delete']);
  }, 30_000);
});

describe("a thread's usage across its closing turn", () => {
  const started = (id: string) => line({ type: 'thread.started', thread_id: id });
  const done = (input: number, output: number) => line({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } });

  it('is the resumed thread\'s last report, not a sum', () => {
    // codex-cli 0.171.0: interrupted at 29,112 input tokens (no report), resumed for one call of 17,918, reported 47,030
    expect(readCodexEvents([started(THREAD), started(THREAD), done(47_030, 117)].join('\n')).usage).toMatchObject({ inputTokens: 47_030, outputTokens: 117 });
    expect(readCodexEvents([started(THREAD), done(1000, 10), started(THREAD), done(1500, 20)].join('\n')).usage).toMatchObject({ inputTokens: 1500, outputTokens: 20 });
  });

  it('still adds up distinct threads and the turns of one exec', () => {
    expect(readCodexEvents([started(THREAD), done(1000, 10), started('01a20202-1d5b-7103-bb2e-557745652ac6'), done(500, 5)].join('\n')).usage).toMatchObject({ inputTokens: 1500, outputTokens: 15 });
    expect(readCodexEvents([started(THREAD), done(1000, 10), done(400, 4)].join('\n')).usage).toMatchObject({ inputTokens: 1400, outputTokens: 14 });
    expect(readCodexEvents([done(300, 3)].join('\n')).usage).toMatchObject({ inputTokens: 300, outputTokens: 3 });
  });
});

describe("a worker's capped session, read by the run", () => {
  const opts = { cwd: '/tmp/run-copy', prompt: 'q', sandbox: 'read-only' as const, maxSteps: 2 };
  const at = { worker: 'laptop/eval-codex#1', backend: 'codex-cli:gpt-test', usage: null, ms: 10 };
  const cmd = (c: string) => line({ type: 'item.started', item: { type: 'command_execution', command: c } });
  const session = [line({ type: 'thread.started', thread_id: THREAD }), cmd('rg a'), cmd('rg b'), cmd('rg c')];

  it('from a worker before the closing turn: capped with nothing, unmetered, as it always read', () => {
    const r = agentResultOf({ exitCode: 143, stdout: session.join('\n'), stderr: '', lastMessage: '', capped: true, cwd: '/w/kb', home: '/w' }, opts, at);
    expect(r).toMatchObject({ capped: true, closing: 'not-run', text: '', usage: null, toolCalls: 3 });
    expect(r.error).toBeUndefined();
    expect(r.cancelled).toBeUndefined();
    expect(unmeteredStop({ capped: r.capped, usage: { weightedTokens: 0, inputTokens: 0, outputTokens: 0 } as never })).toBe(true);
  });

  it('from a worker with it: the closing answer, both turns\' tokens, still capped', () => {
    const closing = [line({ type: 'thread.started', thread_id: THREAD }), line({ type: 'turn.started' }), line({ type: 'item.completed', item: { type: 'agent_message', text: 'Final answer: 42' } }),
      line({ type: 'turn.completed', usage: { input_tokens: 47_030, cached_input_tokens: 0, output_tokens: 117, reasoning_output_tokens: 0 } })];
    const r = agentResultOf({ exitCode: 1, stdout: [...session, ...closing].join('\n'), stderr: '', lastMessage: 'Final answer: 42', capped: true, closing: 'answered', cwd: '/w/kb', home: '/w' }, opts, at);
    expect(r).toMatchObject({ capped: true, closing: 'answered', text: 'Final answer: 42', toolCalls: 3 });
    expect(r.usage).toMatchObject({ inputTokens: 47_030, outputTokens: 117 });
    expect(r.error).toBeUndefined();
  });

  it('whatever the closing turn started voids its answer, whatever the worker said', () => {
    const closing = [line({ type: 'thread.started', thread_id: THREAD }), line({ type: 'item.started', item: { type: 'collab_tool_call', tool: 'spawn_agent' } })];
    const r = agentResultOf({ exitCode: 1, stdout: [...session, ...closing].join('\n'), stderr: '', lastMessage: 'I will ask a sub-agent.', capped: true, closing: 'answered', cwd: '/w/kb', home: '/w' }, opts, at);
    expect(r).toMatchObject({ capped: true, closing: 'used-a-tool', text: '' });
  });
});
