#!/usr/bin/env node
// A stand-in for both CLIs an evaluation run uses, wherever it runs (here or on a worker; docs/design/27 §8):
//   codex exec …            a one-shot call (answers by what the prompt is for, as the eval suite's ScriptedBackend)
//                           or, with web search off (agentArgs), an agent session: a trace, a file it reads,
//                           and with CALL_MCP in the prompt real calls to the knode MCP server it was given
//   claude -p …             the judge: every item agreed with, as the eval suite's scriptedJudge
// FAKE_EVAL_SLOW_MS holds a session that long; FAKE_EVAL_TOKEN_FILE receives a session's MCP URL and token.
// STEPS=<n> in a session's prompt runs n more commands, a moment apart, so a step cap's interrupt (SIGINT: no
// turn.completed, exit 1, as codex-cli 0.171.0 does) lands among them. `codex exec resume <id> -` is a capped
// session's closing turn: it answers from the closing prompt, reporting the thread's running total, or with
// FAKE_CLOSING_TOOL=1 starts a command and waits to be stopped; `codex delete --force <id>` removes nothing.
// FAKE_CODEX_LOG receives one JSON line per invocation: its arguments and what came on stdin.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => void main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
}));

const USAGE = { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 60, reasoning_output_tokens: 10 };
/** What a resumed thread reports at its closing turn: the session's tokens before the stop and the turn's, together. */
const CLOSING_TOTAL = { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 90, reasoning_output_tokens: 12 };
const logCall = () => process.env.FAKE_CODEX_LOG && fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, stdin: prompt }) + '\n');

function oneShot() {
  if (prompt.includes('knowledge-graph extraction engine')) {
    return JSON.stringify({
      entities: [
        { name: '林晓', type: 'person', description: '数据工程师', aliases: [] },
        { name: '澜舟科技', type: 'organization', description: '林晓的新公司', aliases: ['澜舟'] },
      ],
      relations: [{ source: '林晓', target: '澜舟科技', type: 'works_at', description: '入职' }],
      claims: prompt.includes('岗位为高级数据工程师') ? [{ subject: '林晓', statement: '林晓在澜舟科技的岗位是高级数据工程师', type: 'event', status: 'fact', kind: 'fact' }] : [],
    });
  }
  if (prompt.includes('Summarize the document')) return '林晓的近况。\n\n## Key points\n\n- 林晓将入职澜舟科技';
  if (prompt.includes('You answer questions from a personal knowledge base')) return '林晓的岗位是高级数据工程师 [1]。\nFinal answer: 高级数据工程师\n{"citations":[1],"gaps":[]}';
  if (prompt.includes('"items":[{"label"')) return '三月的记录如下。\n{"items":[{"label":"5公里","confidence":0.9,"evidence":["diary/2026-03-04.md"]}]}';
  if (prompt.includes('Respond with a single JSON object only')) return '{}';
  return '林晓在澜舟科技担任高级数据工程师 [doc: email/2026-03-05.md]。\nFinal answer: 高级数据工程师';
}

async function session(cwd, out) {
  const ephemeral = args.includes('--ephemeral');
  emit({ type: 'thread.started', thread_id: ephemeral ? 'fake-thread' : crypto.randomUUID() });
  // Codex takes SIGINT as an interrupt: the turn is aborted, nothing more is said, and it exits 1
  process.on('SIGINT', () => process.exit(1));
  const slow = Number(process.env.FAKE_EVAL_SLOW_MS ?? 0);
  const url = /mcp_servers\.knode\.url="?([^"]+)"?/.exec(args.find((a) => a.startsWith('mcp_servers.knode.url=')) ?? '')?.[1];
  const token = process.env.KNODE_EVAL_MCP_TOKEN;
  if (url && process.env.FAKE_EVAL_TOKEN_FILE) fs.writeFileSync(process.env.FAKE_EVAL_TOKEN_FILE, JSON.stringify({ url, token }));
  let answer = '林晓在澜舟科技担任高级数据工程师 [doc: email/2026-03-05.md]。\nFinal answer: 高级数据工程师';
  // a command's or tool call's start and finish, with Codex's item id and what it returned (docs/design/33 D7)
  let ids = 0;
  const ran = (item, finished) => {
    const id = `item_${ids++}`;
    emit({ type: 'item.started', item: { id, ...item, status: 'in_progress' } });
    if (finished) emit({ type: 'item.completed', item: { id, ...item, ...finished } });
  };
  const enabled = JSON.parse(/^[^=]+=(.*)$/.exec(args.find((a) => a.startsWith('mcp_servers.knode.enabled_tools=')) ?? '')?.[1] ?? '[]');
  if (url && enabled.includes('search')) {
    // arm B (docs/design/33 §2): a real search over the run's RAG index, through whatever URL the session was given
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'fake-eval-cli', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const input = { query: '林晓 澜舟科技', k: 2 };
    const id = `item_${ids++}`;
    emit({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'knode', tool: 'search', arguments: input, status: 'in_progress' } });
    const r = await client.callTool({ name: 'search', arguments: input });
    await client.close();
    emit({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'knode', tool: 'search', arguments: input, status: r.isError ? 'failed' : 'completed', result: { content: r.content }, error: null } });
    const top = r.isError ? null : JSON.parse(r.content?.[0]?.text ?? '[]')[0]?.doc;
    answer = `林晓在澜舟科技担任高级数据工程师 [doc: ${top ?? 'none'}]。\nFinal answer: 高级数据工程师`;
  } else if (url && enabled.includes('knode_search') && !enabled.includes('knode_read')) {
    // arm D: a real knode_search through the session's URL, and a knode_read it was not given, which must be refused
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'fake-eval-cli', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const input = { query: '林晓', k: 2 };
    const id = `item_${ids++}`;
    emit({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'knode', tool: 'knode_search', arguments: input, status: 'in_progress' } });
    const r = await client.callTool({ name: 'knode_search', arguments: input });
    emit({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'knode', tool: 'knode_search', arguments: input, status: r.isError ? 'failed' : 'completed', result: { content: r.content }, error: null } });
    let read = 'answered';
    try {
      const x = await client.callTool({ name: 'knode_read', arguments: { path: 'raw/docs/email/2026-03-05.md' } });
      if (x.isError) read = 'refused';
    } catch {
      read = 'refused';
    }
    await client.close();
    const files = fs.readdirSync(cwd).sort().join(',');
    answer = `folder: ${files}; knode_search: ${r.isError ? 'failed' : 'answered'}; knode_read: ${read}\nFinal answer: done`;
  } else if (url) {
    ran({ type: 'mcp_tool_call', server: 'knode', tool: 'knode_resolve', arguments: { query: '林晓的岗位' } }, { status: 'completed', result: { content: [{ type: 'text', text: '{"entities":[{"name":"林晓"}]}' }] }, error: null });
    if (prompt.includes('CALL_MCP')) {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'fake-eval-cli', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      const ls = await client.callTool({ name: tools[0], arguments: { path: 'raw/docs' } });
      let secret = 'answered';
      try {
        const r = await client.callTool({ name: 'knode_secret', arguments: {} });
        if (r.isError) secret = 'refused';
      } catch {
        secret = 'refused';
      }
      await client.close();
      answer = `tools: ${tools.join(',')}; ${tools[0]}: ${ls.content?.[0]?.text}; knode_secret: ${secret}\nFinal answer: done`;
    }
  } else {
    ran({ type: 'command_execution', command: 'rg -n 林晓 .' }, { aggregated_output: 'email/2026-03-05.md:3:林晓将入职澜舟科技\n', exit_code: 0, status: 'completed' });
    // a file named by its absolute path in the session's folder: the run reads it as its own copy's; its output
    // is the file and 5,000 characters more, longer than the head of it an answer keeps
    const file = path.join(cwd, 'email', '2026-03-05.md');
    const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    ran({ type: 'command_execution', command: `cat ${file}` }, { aggregated_output: `${body}\n${'林'.repeat(5000)}`, exit_code: 0, status: 'completed' });
    if (prompt.includes('PEEK_HOME')) emit({ type: 'item.started', item: { type: 'command_execution', command: 'cat ~/notes/secret.md' } });
  }
  const steps = Number(/STEPS=(\d+)/.exec(prompt)?.[1] ?? 0);
  for (let i = 0; i < steps; i++) {
    emit({ type: 'item.started', item: { type: 'command_execution', command: `ls ${i}` } });
    await sleep(40);
  }
  if (slow) await sleep(slow);
  emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: USAGE });
  if (out) fs.writeFileSync(out, answer);
}

function judge() {
  const at = prompt.indexOf('{\n "items"');
  const end = prompt.lastIndexOf('}', prompt.indexOf('Respond with a single JSON object only') >= 0 ? prompt.indexOf('Respond with a single JSON object only') : prompt.length);
  const items = at >= 0 ? JSON.parse(prompt.slice(at, end + 1)).items : [];
  const verdicts = items.map((i) => ({ id: i.id, score: 2, keypoints: [0], abstained: false, hallucinated: false, present: true, unit: 0, verdict: 'supported', claims: ['林晓将入职澜舟科技'], pairs: [[0, 0]], correct: true, same: false, contradict: false }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ verdicts }), usage: { input_tokens: 50, output_tokens: 10 } }) + '\n');
}

/** A capped session's closing turn: the thread resumed, one answer from the closing prompt (or a tool it may not use). */
async function closingTurn(out) {
  const thread = args[args.length - 2];
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  if (process.env.FAKE_CLOSING_TOOL) {
    process.on('SIGINT', () => process.exit(1));
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will read one more file.' } });
    emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat more.md', status: 'in_progress' } });
    await sleep(20_000);
    return;
  }
  const answer = `closing turn of ${thread}: ${prompt.trim().slice(0, 40)}\nFinal answer: 高级数据工程师`;
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: CLOSING_TOTAL });
  if (out) fs.writeFileSync(out, answer);
}

async function main() {
  logCall();
  if (args[0] === 'delete') return void process.stdout.write(`Deleted session ${args[args.length - 1]}.\n`);
  if (args[0] === 'exec' && args[1] === 'resume') return closingTurn(arg('--output-last-message'));
  if (args[0] === '-p') return judge();
  if (args[0] !== 'exec') throw new Error(`fake-eval-cli: unexpected ${args.join(' ')}`);
  const out = arg('--output-last-message');
  const cwd = arg('--cd') ?? process.cwd();
  if (args.includes('web_search="disabled"')) return session(cwd, out);
  const text = oneShot();
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'turn.completed', usage: USAGE });
  if (out) fs.writeFileSync(out, text);
}
