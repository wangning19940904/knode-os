#!/usr/bin/env node
// codex stand-in for the eval suite's agent sessions: reads the prompt on stdin,
// prints `codex exec --json` events, writes the last message where --output-last-message says.
// An ingest prompt (llm-wiki build) writes a page per source into wiki/; anything else answers.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = arg('--output-last-message');
const cwd = arg('--cd') ?? process.cwd();
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
/**
 * knode's tools over HTTP, as Codex reaches the run's tool host (`mcp_servers.knode.url`, the bearer token in the
 * env var `bearer_token_env_var` names): the calls the trace shows are made for real, and one that fails fails the
 * session. FAKE_CODEX_MCP_LOG, when set, receives a line per call; FAKE_CODEX_TOOLS_LOG a line per session listing the
 * tools the server offered it.
 */
async function callTools(calls, emit) {
  const config = (key) => /^[^=]+=(.*)$/.exec(args.find((a) => a.startsWith(`mcp_servers.knode.${key}=`)) ?? '')?.[1];
  const url = JSON.parse(config('url'));
  const token = process.env[JSON.parse(config('bearer_token_env_var') ?? '""')];
  if (!token) throw new Error('no bearer token in the environment');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'fake-codex', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    if (process.env.FAKE_CODEX_TOOLS_LOG) fs.appendFileSync(process.env.FAKE_CODEX_TOOLS_LOG, `${(await client.listTools()).tools.map((t) => t.name).sort().join(',')}\n`);
    for (const [i, [tool, input]] of calls.entries()) {
      const r = await client.callTool({ name: tool, arguments: input });
      if (r.isError) throw new Error(`${tool} failed: ${r.content?.[0]?.text}`);
      // the call as Codex reports it once it finished: what it returned (docs/design/33 D7)
      emit({ type: 'item.completed', item: { id: `mcp_${i}`, type: 'mcp_tool_call', server: 'knode', tool, arguments: input, status: 'completed', result: { content: r.content }, error: null } });
      if (process.env.FAKE_CODEX_MCP_LOG) fs.appendFileSync(process.env.FAKE_CODEX_MCP_LOG, `${tool} ${String(r.content?.[0]?.text ?? '').length}\n`);
    }
  } finally {
    await client.close();
  }
}

/**
 * The calls a session with knode's MCP server makes: from the tools it was given (`enabled_tools`), so arm B calls
 * `search`, arm D the retrieval tools it has, and an agent given every tool (or none named) the usual two.
 */
function mcpCalls() {
  const enabled = JSON.parse(/^[^=]+=(.*)$/.exec(args.find((a) => a.startsWith('mcp_servers.knode.enabled_tools=')) ?? '')?.[1] ?? 'null');
  if (enabled?.includes('search')) return [['search', { query: '林晓 澜舟科技 岗位', k: 3 }]];
  if (enabled && !enabled.includes('knode_read')) return [['knode_resolve', { query: '林晓的岗位' }], ['knode_search', { query: '林晓 岗位', k: 3 }]];
  return [['knode_resolve', { query: '林晓的岗位' }], ['knode_read', { path: 'raw/docs/email/2026-03-05.md' }]];
}

process.stdin.on('end', async () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  // a saved session removed when it is over (src/eval/agent.ts): nothing to remove here
  if (args[0] === 'delete') return void process.stdout.write(`Deleted session ${args[args.length - 1]}.\n`);
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  // FAKE_CODEX_SESSION_MS: a session takes this long, as an agent thinking would; FAKE_CODEX_SESSION_LOG gets its start and end
  const sessionLog = process.env.FAKE_CODEX_SESSION_LOG;
  // FAKE_CODEX_PROMPT_LOG: each session's prompt as one JSON line (the briefs an arm's sessions got)
  if (process.env.FAKE_CODEX_PROMPT_LOG) fs.appendFileSync(process.env.FAKE_CODEX_PROMPT_LOG, `${JSON.stringify(prompt)}\n`);
  if (sessionLog) fs.appendFileSync(sessionLog, `start ${Date.now()}\n`);
  if (Number(process.env.FAKE_CODEX_SESSION_MS ?? 0) > 0) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_SESSION_MS)));
  // the session's trace: knode's tools when it has the MCP server, and a search and a wrapped pipeline when its folder has files
  if (args.some((a) => a.startsWith('mcp_servers.knode.'))) {
    const calls = mcpCalls();
    calls.forEach(([tool, input], i) => emit({ type: "item.started", item: { id: `mcp_${i}`, type: "mcp_tool_call", server: "knode", tool, arguments: input } }));
    if (args.some((a) => a.startsWith('mcp_servers.knode.url='))) {
      try {
        await callTools(calls, emit);
      } catch (err) {
        process.stderr.write(`knode tools: ${err instanceof Error ? err.message : err}\n`);
        process.exit(1);
      }
    }
  }
  if (!args.some((a) => a.startsWith('mcp_servers.knode.')) || (fs.existsSync(cwd) && fs.readdirSync(cwd).length > 0)) {
    emit({ type: 'item.started', item: { type: 'command_execution', command: 'rg -n 林晓 .' } });
    emit({ type: 'item.started', item: { type: 'command_execution', command: `/bin/zsh -lc "rg -l '林晓' . | head -n 5"` } });
  }
  // a notes file the session may write (agent-grep-notes): FAKE_CODEX_NOTES_LOG gets what it held at the start, and a line is added
  const notes = /The one file you may write is ([\w.-]+), in the current directory/.exec(prompt);
  if (notes) {
    const file = path.join(cwd, notes[1]);
    const held = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (process.env.FAKE_CODEX_NOTES_LOG) fs.appendFileSync(process.env.FAKE_CODEX_NOTES_LOG, `${JSON.stringify(held)}\n`);
    emit({ type: 'item.started', item: { type: 'command_execution', command: `cat ${notes[1]}` } });
    fs.appendFileSync(file, `- note ${held.split('\n').filter(Boolean).length + 1}: 岗位见 email/2026-03-05.md 第 5 行\n`);
  }
  let answer;
  const ingest = /Ingest these new sources into the wiki now: (.+)\./.exec(prompt);
  if (ingest) {
    const files = ingest[1].split(',').map((s) => s.trim().replace(/^raw\//, ''));
    const index = path.join(cwd, 'wiki', 'index.md');
    for (const f of files) {
      const name = f.replace(/[/.]/g, '-');
      const text = fs.readFileSync(path.join(cwd, 'raw', f), 'utf8');
      fs.mkdirSync(path.join(cwd, 'wiki', 'sources'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'wiki', 'sources', `${name}.md`), `# ${f}\n\n${text.split('\n').slice(2, 6).join('\n')} (raw/${f})\n\nSee [[林晓]].\n`);
      fs.appendFileSync(index, `- [[${name}]] — ${f}\n`);
    }
    fs.mkdirSync(path.join(cwd, 'wiki', 'entities'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'wiki', 'entities', '林晓.md'), '# 林晓\n\n林晓将入职澜舟科技，岗位为高级数据工程师 (raw/email/2026-03-05.md)。\n');
    answer = `updated ${files.length} source pages`;
  } else {
    answer = '林晓在澜舟科技担任高级数据工程师 [doc: email/2026-03-05.md]。\nFinal answer: 高级数据工程师';
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 60, reasoning_output_tokens: 10 } });
  if (out) fs.writeFileSync(out, answer);
  if (sessionLog) fs.appendFileSync(sessionLog, `end ${Date.now()}\n`);
});
