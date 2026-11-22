import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { resolve } from '../compiler/resolve.js';
import { checkout } from '../compiler/workset.js';
import { GUIDE_FILE, isSeedTemplate, readGuide } from '../fs/datadir.js';
import { safePath } from '../fs/files.js';
import { loadOntology, promptFragment } from '../graph/ontology.js';
import { parseFrontmatter } from '../markdown.js';
import { archivePage } from '../wiki/pages.js';
import { stripRegions } from '../wiki/regions.js';
import { citationBrief, citationChanges, citationPayloadOf, CitationPayload } from './cited-refresh.js';
import { ResearchJob } from './jobs.js';
import { loadResearchProtocol, renderOutputPath, ResearchTemplate, subjectOf } from './templates.js';
import { profileBrief, requiredSections, ResearchProfile } from './profile.js';
import type { ExtraMcpServer } from './sources.js';

/**
 * The run workspace an agent CLI is launched in: `<data>/<runsDir>/<jobId>/`.
 *
 *   CLAUDE.md / AGENTS.md   the schema: protocol + template + the wiki's own purpose/schema notes
 *   brief.md                this job: target, output contract, a context seed from knode_resolve,
 *                           the existing page (for refresh / overwrite), previous rejection reasons
 *   .mcp.json               MCP endpoint for Claude Code (headers carry token + workspace)
 *   .cursor/mcp.json        the same for cursor-agent
 *   .cursor/cli.json        cursor-agent's permissions: knode's MCP tools allowed, file writes and shell denied
 *   transcript.jsonl        stdout of the run (stream-json / NDJSON)
 *   result.json             what the runner concluded
 *
 * Nothing the agent writes here reaches the knowledge base: pages go through
 * `knode_write` over MCP, which enforces the writable roots.
 */

export interface McpEndpoint {
  url: string;
  token: string;
  /** Workspace routing headers (x-knode-user / x-knode-workspace-*). */
  headers: Record<string, string>;
}

/** A second output file the template asks for (the guide of an init job), with its pre-run backup. */
export interface RunCompanion {
  path: string;
  sections: string[];
  /** Copy of the file as it was before the run (`.runs/<id>/existing-<name>`), null when it did not exist. */
  backupPath: string | null;
}

export interface RunWorkspace {
  dir: string;
  briefPath: string;
  outputPath: string;
  /** The agent's actor string, e.g. agent/claude-cli. */
  actor: string;
  /** Value of the page's `research` frontmatter key. */
  research: Record<string, unknown>;
  worksetId: string;
  existingPage: string | null;
  humanParagraphs: string[];
  companions: RunCompanion[];
}

/** The guide section a person owns: the runner carries it over verbatim when the guide is regenerated. */
export const HUMAN_NOTES_HEADING = '## 人工备注';

export function runsRoot(dataDir: string, runsDir: string): string {
  return safePath(dataDir, runsDir || '.runs');
}

function isAgentAuthored(text: string): boolean {
  const actor = parseFrontmatter(text).frontmatter.actor;
  return typeof actor === 'string' && /^(agent|mcp|api)\b/i.test(actor);
}

/** Paragraphs a person wrote on an existing page (outside managed regions), long enough to be worth protecting. */
export function humanParagraphsOf(text: string): string[] {
  const { body } = parseFrontmatter(text);
  return stripRegions(body)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40 && !p.startsWith('#'));
}

async function contextSeed(ctx: AppContext, query: string, worksetId: string): Promise<string> {
  try {
    const pack = await resolve(ctx, query, { record: false, actor: 'research' });
    const lines: string[] = [];
    if (pack.intent.entities.length) {
      lines.push('### 匹配到的实体', '');
      for (const e of pack.intent.entities.slice(0, 8)) lines.push(`- ${e.name} (${e.type}${e.aliases.length ? `; 别名: ${e.aliases.join(', ')}` : ''}${e.wikiPath ? `; 页面: ${e.wikiPath}` : ''}) — ${e.description || ''}`.trim());
      lines.push('');
    }
    if (pack.facts.length) {
      lines.push('### 已知事实（前 20 条）', '');
      for (const f of pack.facts.slice(0, 20)) {
        const when = f.eventDate ?? f.startDate;
        lines.push(`- ${when ? `${when} · ` : ''}${f.statement} [${f.status}${f.stale ? ', stale' : ''}]${f.path ? ` （来源：${f.path}）` : ''}`);
      }
      lines.push('');
    }
    if (pack.documents.length) {
      lines.push('### 相关文档', '');
      for (const d of pack.documents.slice(0, 12)) lines.push(`- ${d.path}${d.title ? ` — ${d.title}` : ''}`);
      lines.push('');
    }
    if (pack.unknowns.length) {
      lines.push('### 本地回答不了的缺口', '');
      for (const u of pack.unknowns.slice(0, 8)) lines.push(`- ${u.question}（默认假设：${u.defaultAssumption}；风险 ${u.risk}）`);
      lines.push('');
    }
    if (pack.availableNextQueries.length) {
      lines.push('### 值得先跑的查询', '');
      for (const n of pack.availableNextQueries.slice(0, 6)) lines.push(`- ${n.capability}: ${n.reason}`);
      lines.push('');
    }
    lines.push(`（以上由 knode_resolve 预先整理；receiptId ${pack.receiptId}；workset ${worksetId}）`);
    return lines.join('\n');
  } catch (err) {
    return `（knode_resolve 预整理失败：${err instanceof Error ? err.message : err}；请自行调用）`;
  }
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(target|query|output|actor|research|slug)\}/g, (m, key: string) => vars[key] ?? m);
}

/**
 * The `# 知识库自述` block every agent session gets: the base's own guide
 * (AGENTS.md at the data root, when one exists), then purpose.md and schema.md.
 * `guide: null` leaves the guide out (an init job sees it in its brief instead).
 */
export function knowledgeNotes(dataDir: string, opts: { guide?: string | null } = {}): string {
  const notes: string[] = [];
  const guide = opts.guide === undefined ? readGuide(dataDir) : opts.guide;
  if (guide) notes.push(`## ${GUIDE_FILE}（知识库指南）\n\n${guide.trim()}`);
  for (const f of ['purpose.md', 'schema.md']) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) notes.push(`## ${f}\n\n${fs.readFileSync(p, 'utf8').trim()}`);
  }
  return notes.length ? `# 知识库自述\n\n${notes.join('\n\n')}` : '';
}

/**
 * cursor-agent's permissions for a session in this workspace (`.cursor/cli.json`).
 * In print mode it rejects every MCP tool call that is not allow-listed — even
 * with --approve-mcps — while its own edit and shell tools stay usable, so
 * without this file an agent cannot read the knowledge base and saves the page
 * straight to disk. Allowed: knode's tools; denied: file writes and shell, so
 * pages travel through knode_write as for every other CLI.
 */
export const CURSOR_PERMISSIONS = { permissions: { allow: ['Mcp(knode-os:*)'], deny: ['Write(**)', 'Shell(*)'] } };

/**
 * The files a CLI session reads from its cwd: the schema, the MCP endpoint (Claude Code and Cursor forms), Cursor's permissions, a README.
 * A study's sources add their MCP servers next to knode's (`extraMcp`); their
 * secrets live in these files, which only the session's own user can read.
 */
export function writeAgentFiles(dir: string, input: { schema: string; mcp: McpEndpoint; readme: string; extraMcp?: ExtraMcpServer[] }): void {
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), input.schema);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), input.schema);
  const server = { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}`, ...input.mcp.headers } };
  const extra = input.extraMcp ?? [];
  const claudeExtra = Object.fromEntries(extra.map((s) => [s.id, s.url
    ? { type: 'http', url: s.url, headers: s.headers ?? {} }
    : { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} }]));
  const cursorExtra = Object.fromEntries(extra.map((s) => [s.id, s.url
    ? { url: s.url, headers: s.headers ?? {} }
    : { command: s.command, args: s.args ?? [], env: s.env ?? {} }]));
  const write = (rel: string, data: unknown) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  write('.mcp.json', { mcpServers: { 'knode-os': server, ...claudeExtra } });
  write(path.join('.cursor', 'mcp.json'), { mcpServers: { 'knode-os': { url: input.mcp.url, headers: server.headers }, ...cursorExtra } });
  const permissions = extra.length
    ? { permissions: { ...CURSOR_PERMISSIONS.permissions, allow: [...CURSOR_PERMISSIONS.permissions.allow, ...extra.map((s) => `Mcp(${s.id}:*)`)] } }
    : CURSOR_PERMISSIONS;
  fs.writeFileSync(path.join(dir, '.cursor', 'cli.json'), JSON.stringify(permissions, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), input.readme);
}

export interface PrepareRunOptions {
  runsDir: string;
  provider: string;
  mcp: McpEndpoint;
  readDirs: string[];
  dir?: string;
  allowNetwork?: boolean;
  profile?: ResearchProfile | null;
  /** Replaces the knode_resolve context seed in the brief (init: the rendered survey). */
  seed?: string;
  /** Guide text for the schema; undefined = the data root's AGENTS.md, null = none. */
  guide?: string | null;
  /** Extra brief sections appended before the closing line. */
  extraBrief?: string[];
  /** MCP servers of a study's research sources, written next to knode's into the session config files. */
  extraMcp?: ExtraMcpServer[];
}

export async function prepareRunWorkspace(ctx: AppContext, job: ResearchJob, template: ResearchTemplate, opts: PrepareRunOptions): Promise<RunWorkspace> {
  const dir = opts.dir ?? path.join(runsRoot(ctx.dataDir, opts.runsDir), job.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });

  const outputPath = renderOutputPath(template, job);
  const actor = `agent/${opts.provider}`;
  const worksetId = job.worksetId ?? (await checkout(ctx.store, { actor, note: `research ${job.id}: ${job.kind} ${job.target ?? job.query ?? ''}` })).id;
  const research = { job: job.id, kind: job.kind, template: template.name, at: new Date().toISOString(), agent: opts.provider, workset: worksetId };
  const subject = subjectOf(job);
  // a study's target is a slug (`<study>/<page>`): its pages and report are about their title
  const titled = job.kind === 'study' || job.kind === 'section';
  const vars = { target: titled ? subject : job.target ?? subject, query: job.query ?? subject, output: outputPath, actor, research: JSON.stringify(research), slug: path.posix.basename(outputPath, '.md') };

  const abs = safePath(ctx.dataDir, outputPath);
  let existingPage = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  // a generated stub (a view) at the output path is archived first: the page the
  // agent writes is a Source, and a live pages row would classify it as a view
  const [view] = await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE path = $1 AND tx_to IS NULL`, [outputPath]);
  if (view) {
    existingPage = existingPage ?? null;
    await archivePage(ctx, outputPath, 'research');
  } else if (existingPage) {
    // a source page (human or agent) the agent will overwrite through knode_write:
    // kept here so a rejected draft can be rolled back to it
    fs.writeFileSync(path.join(dir, 'existing.md'), existingPage);
  }
  // prose to protect: what a person wrote. A page an agent authored is rewritten wholesale on
  // refresh, and a file that is still the seed template holds nothing of anyone's.
  const humanParagraphs = existingPage && !isAgentAuthored(existingPage) && !isSeedTemplate(outputPath, existingPage) ? humanParagraphsOf(existingPage) : [];
  // companion outputs (the guide of an init job): backed up so a rejected run restores them
  const companions: RunCompanion[] = (template.companions ?? []).map((c) => {
    const absC = safePath(ctx.dataDir, c.path);
    let backupPath: string | null = null;
    if (fs.existsSync(absC)) {
      backupPath = path.join(dir, `existing-${path.posix.basename(c.path)}`);
      fs.copyFileSync(absC, backupPath);
    }
    return { path: c.path, sections: c.sections, backupPath };
  });
  const ontology = loadOntology(ctx.dataDir);
  const vocab = promptFragment(ontology, { documentLinks: true });

  const schema = [
    loadResearchProtocol(ctx.dataDir).trim(),
    '',
    `# 本任务的模版（${template.path}）`,
    '',
    fill(template.body, vars),
    '',
    knowledgeNotes(ctx.dataDir, { guide: opts.guide }),
  ].filter(Boolean).join('\n');

  const previous = Array.isArray(job.payload.rejections) ? (job.payload.rejections as string[]) : [];
  // a refresh of a page whose cited files changed is told which, read again now: more may have changed since it was queued
  const cited = job.kind === 'refresh' ? await citedFilesNow(ctx, outputPath, citationPayloadOf(job.payload)) : [];
  const closing = job.kind === 'init'
    ? '开始吧：先按「知识库概况」摸底（knode_survey / knode_ls / knode_graph_insights），然后按模版逐节取证，最后 knode_write 总览与指南 → knode_feedback → knode_commit。'
    : '开始吧：先 knode_resolve，然后按模版逐节取证，最后 knode_write → knode_feedback → knode_commit。';
  const brief = [
    `# 研究任务 ${job.id}`,
    '',
    `- 类型：${job.kind}`,
    `- 目标：${subject}`,
    job.query ? `- 问题：${job.query}` : null,
    `- 输出路径（只写这里，用 knode_write）：\`${outputPath}\``,
    ...companions.map((c) => `- 附加输出（也用 knode_write 写，path 就是 \`${c.path}\`）：\`${c.path}\`；必需章节：${c.sections.join(' / ') || '（无固定章节）'}`),
    `- workset：\`${worksetId}\`（所有 knode_* 读取都带上它）`,
    `- frontmatter 必需键：${template.requires.frontmatter.join(', ') || '（无额外要求）'}`,
    `- 必需章节：${requiredSections(template, opts.profile, job).join(' / ') || '（无固定章节）'}`,
    `- frontmatter 固定值：\`actor: ${actor}\`；\`research: ${JSON.stringify(research)}\``,
    `- 只读资料目录：${opts.readDirs.join(', ')}`,
    `- 联网核实：${opts.allowNetwork ? '允许（WebSearch / WebFetch 可用；来源写 URL，单一外部来源的断言用 suspected）' : '不允许（只用知识库与只读资料）'}`,
    '',
    ...(opts.profile ? [...profileBrief(opts.profile, { allowNetwork: Boolean(opts.allowNetwork) }), ''] : []),
    '## 可用的关系谓词（frontmatter relations 的键）',
    '',
    vocab.relationTypes,
    '',
    'cites / derived_from / tested_by 的目标可以是 raw/docs 下的文件路径（如 `tested_by: [raw/docs/backtests/x.md]`）：它记为本页对该文件的引用，打开那个文件时会列出本页。frontmatter `sources` 里的 raw/docs 路径按 derived_from 记。',
    '',
    '实体类型：',
    vocab.entityTypes,
    '',
    previous.length ? `## 上一次提交被退回，原因\n\n${previous.map((r) => `- ${r}`).join('\n')}\n` : '',
    existingPage ? `## 输出路径上已有页面（${humanParagraphs.length} 段人写内容必须原样保留）\n\n\`\`\`markdown\n${existingPage.trim()}\n\`\`\`\n` : '',
    ...companions.filter((c) => c.backupPath).map((c) => `## ${c.path} 上一版（可以重写；「${HUMAN_NOTES_HEADING.replace(/^#+\s*/, '')}」段由系统原样保留，你只需保留该标题）\n\n\`\`\`markdown\n${fs.readFileSync(c.backupPath!, 'utf8').trim()}\n\`\`\`\n`),
    ...cited,
    ...(opts.seed !== undefined ? [opts.seed.trim(), ''] : ['## 知识库预整理', '', await contextSeed(ctx, subject, worksetId), '']),
    ...(opts.extraBrief ?? []),
    closing,
  ].filter((l) => l !== null && l !== '').join('\n');
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, brief);

  writeAgentFiles(dir, { schema, mcp: opts.mcp, extraMcp: opts.extraMcp, readme: `Run workspace for research job ${job.id}. brief.md is the prompt; CLAUDE.md / AGENTS.md the schema; transcript.jsonl the agent's output.\n` });

  return { dir, briefPath, outputPath, actor, research, worksetId, existingPage, humanParagraphs, companions };
}

/**
 * The cited-files section of a refresh brief: the page's citation state now,
 * joined with what the queued job carried (an audit, files that changed
 * again in the meantime). Empty when neither says anything changed.
 */
async function citedFilesNow(ctx: AppContext, page: string, queued: CitationPayload | null): Promise<string[]> {
  const [now] = await citationChanges(ctx.store, ctx.dataDir, { pages: [page], auditAfter: ctx.config.research.auditAfterUpdates ?? 0 }).catch(() => []);
  if (!now && !queued) return [];
  if (!now) return citationBrief(queued);
  const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];
  return citationBrief({
    cited: now.cited,
    changed: union(now.changed, queued?.changed.filter((p) => !now.removed.includes(p))),
    removed: union(now.removed, queued?.removed),
    repositories: now.repositories.length ? now.repositories : queued?.repositories ?? [],
    audit: now.audit ?? queued?.audit ?? null,
    fingerprint: now.fingerprint,
  });
}

/** Keep only the newest `keep` run directories. */
export function pruneRuns(dataDir: string, runsDir: string, keep: number): number {
  const root = runsRoot(dataDir, runsDir);
  if (!fs.existsSync(root)) return 0;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'chat') // .runs/chat holds conversation workspaces, pruned by the chat store
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const e of entries.slice(Math.max(0, keep))) {
    fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
