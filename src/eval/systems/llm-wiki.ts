import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedCopy, runAgent } from '../agent.js';
import { listFiles } from '../pack.js';
import { citationsIn } from '../prompts.js';
import type { KnowledgeUnit } from '../types.js';
import { AGENT_BRIEF } from './agents.js';
import type { MeterEvent } from '../meter.js';
import { recordAgent, SystemEnv, SystemUnderTest } from './types.js';
import { evalTempDir } from '../tmp.js';

/**
 * The LLM Wiki pattern (Karpathy, April 2026) built faithfully and plainly
 * (docs/design/23 §3): the sources sit in `raw/`, an agent maintains a wiki
 * of Markdown pages beside them — one page per source, pages for the
 * entities and concepts they mention, an `index.md` that lists every page
 * and a `log.md` of what each ingest changed — following a schema file, and
 * ingests a few sources per session in date order, so later sources update
 * pages earlier ones wrote. Answers come from the same Codex agent as the
 * grep baseline, reading the wiki alone (`agent-wiki`) — or reading the wiki
 * as a navigation layer with the sources beside it (`agent-wiki-sources`), the
 * way a maintained wiki is used in practice.
 */

export const WIKI_SCHEMA = `# Wiki maintenance rules

You maintain a wiki in \`wiki/\` that compiles the knowledge in the source documents under \`raw/\` (read-only; never edit them).

Pages (Markdown, one topic per page):
- \`wiki/sources/<name>.md\` — one per source: what it says, its date and author when known, the key facts with numbers and dates kept exact.
- \`wiki/entities/<name>.md\` — a person, organization, product, place, law or other named thing: what the sources say about it, across sources.
- \`wiki/concepts/<name>.md\` — a theme, method, problem or recurring idea: a synthesis across sources, including disagreements and open questions.
- \`wiki/index.md\` — every page with a one-line description, grouped by kind. Keep it complete.
- \`wiki/log.md\` — append one line per ingest: date, sources ingested, pages created or updated.

Conventions:
- Link pages with [[wikilinks]] (the page name without .md).
- Cite every statement's source as (raw/<path>), the source file's path.
- When a new source updates or contradicts a page, revise the page and say what changed and according to which source.
- Write in the language of the sources (keep names and terms as the sources write them).`;

const INGEST_PROMPT = (files: string[]) => `${WIKI_SCHEMA}

Ingest these new sources into the wiki now: ${files.map((f) => `raw/${f}`).join(', ')}.
Read each one, write its source page, create or update the entity and concept pages it bears on, update wiki/index.md and append to wiki/log.md. Edit files with shell commands (e.g. cat > file <<'EOF', or apply a patch). Do not touch raw/. When done, reply with one line listing the pages you changed.`;

const wikiDirs = new Map<string, string>();

function wikiDir(env: SystemEnv): string {
  return wikiDirs.get(env.workDir) ?? path.join(env.workDir, 'wiki');
}

/** Sources in the order they were written (date, then path), so the wiki grows the way a person's would. */
function ingestOrder(env: SystemEnv): string[] {
  return [...env.staged.docs].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.path.localeCompare(b.path)).map((d) => d.path);
}

export function llmWikiBuild(env: SystemEnv, perSession = 3): Promise<{ notes: Record<string, unknown>; kbDir: string }> {
  return buildWiki(env, perSession);
}

/** How far a build got: the sources ingested from the front of the order, and what each finished session used. */
interface WikiProgress {
  order: string;
  done: number;
  failed: number;
  capped: number;
  sessions: Omit<MeterEvent, 'at'>[];
}

/**
 * Each build works in a fixed directory beside a progress file, so a run that
 * stops mid-build goes on from the last finished session instead of starting
 * over; the sessions it skips are metered again as replays at their original
 * cost, as the shim does for cached replies, so the build reports its full cost.
 */
async function buildWiki(env: SystemEnv, perSession: number): Promise<{ notes: Record<string, unknown>; kbDir: string }> {
  const root = path.join(os.tmpdir(), `knode-eval-wiki-${crypto.createHash('sha256').update(env.workDir).digest('hex').slice(0, 16)}`);
  const progressFile = `${root}.progress.json`;
  const order = ingestOrder(env);
  const fingerprint = crypto.createHash('sha256').update(order.join('\n')).digest('hex');
  let progress = readProgress(progressFile);
  if (!progress || progress.order !== fingerprint || !fs.existsSync(path.join(root, 'wiki', 'index.md'))) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(env.staged.dir, path.join(root, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(root, 'wiki', 'sources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), WIKI_SCHEMA + '\n');
    fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Index\n');
    fs.writeFileSync(path.join(root, 'wiki', 'log.md'), '# Log\n');
    progress = { order: fingerprint, done: 0, failed: 0, capped: 0, sessions: [] };
  } else {
    env.log(`llm-wiki: resuming at ${progress.done}/${order.length} sources`);
    for (const ev of progress.sessions) env.meter.record({ ...ev, replayed: true });
  }
  for (let i = progress.done; i < order.length; i += perSession) {
    const files = order.slice(i, i + perSession);
    await env.quota.wait();
    const r = await runAgent({
      cwd: root,
      sandbox: 'workspace-write',
      model: env.models.model,
      effort: env.models.buildEffort,
      maxSteps: 80,
      // a builder has nothing to answer: at its cap it stops with what it wrote
      closing: null,
      timeoutMs: 30 * 60_000,
      prompt: INGEST_PROMPT(files),
    });
    recordAgent(env.meter, { system: 'llm-wiki', stage: 'build' }, env.models.model, r);
    // a session killed or stopped with the run ingested nothing to count on: the build stops here and resumes at this batch
    if (r.cancelled) throw new Error(`${r.error} (llm-wiki ingest of sources ${i + 1}–${i + files.length}; the build resumes there)`);
    progress.done = i + files.length;
    if (r.error) progress.failed++;
    if (r.capped) progress.capped++;
    progress.sessions.push({ system: 'llm-wiki', stage: 'build', model: env.models.model || 'codex', ms: r.ms, ok: !r.error, replayed: false, usage: r.usage });
    fs.writeFileSync(progressFile, JSON.stringify(progress));
    if (progress.sessions.length % 5 === 0) env.log(`llm-wiki: ${progress.done}/${order.length} sources ingested`);
  }
  const out = path.join(env.workDir, 'wiki');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'wiki'), out, { recursive: true });
  wikiDirs.set(env.workDir, out);
  const pages = listFiles(out).filter((f) => f.endsWith('.md'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(progressFile, { force: true });
  return { kbDir: out, notes: { sessions: progress.sessions.length, failedSessions: progress.failed, cappedSessions: progress.capped, pages: pages.length } };
}

function readProgress(file: string): WikiProgress | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WikiProgress;
  } catch {
    return null;
  }
}

export function llmWiki(): SystemUnderTest {
  return {
    id: 'agent-wiki',
    label: 'LLM Wiki (Karpathy pattern), Codex agent reading it',
    group: 'llm-wiki',
    kind: 'kb',
    answers: true,
    // five sources a session: the pattern's ingest, at a cost a pilot can carry (each session is a long agent run)
    build: (env) => buildWiki(env, Number(process.env.KNODE_EVAL_WIKI_PER_SESSION ?? 5)),
    async reopen(env) {
      const dir = path.join(env.workDir, 'wiki');
      if (!fs.existsSync(dir)) throw new Error(`no llm-wiki build to reopen at ${dir}`);
      wikiDirs.set(env.workDir, dir);
    },
    async answer(task, prompt, env) {
      await env.quota.wait();
      const copy = isolatedCopy(wikiDir(env), 'wiki');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${AGENT_BRIEF('The current directory is a wiki compiled from the documents: start from index.md. The source documents themselves are not here; pages cite them as raw/<path> — cite those paths.')}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-wiki', stage: 'agent', task: task.id }, env.models.model, r);
        return { text: r.text, citations: citationsIn(r.text, new Set(env.staged.docs.map((d) => d.path))), toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs, capped: r.capped, closing: r.closing, leaked: r.leaked, error: r.error };
      } finally {
        copy.cleanup();
      }
    },
    async exportKnowledge(env) {
      const dir = wikiDir(env);
      const docs = new Set(env.staged.docs.map((d) => d.path));
      const units: KnowledgeUnit[] = [];
      for (const rel of listFiles(dir).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md')) {
        const text = fs.readFileSync(path.join(dir, rel), 'utf8').trim();
        if (!text) continue;
        const kind: KnowledgeUnit['kind'] = rel.startsWith('sources/') ? 'summary' : rel.startsWith('concepts/') ? 'community' : 'page';
        units.push({
          id: `page:${rel}`,
          kind,
          title: rel,
          text,
          sources: citationsIn(text, docs).map((c) => c.doc),
          links: [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => `page:${m[1].trim()}`),
        });
      }
      return units;
    },
    async update(files, env) {
      // ingest the new or changed sources into the existing wiki, as the pattern does
      const tmp = evalTempDir('wiki');
      const root = tmp.root;
      try {
        fs.cpSync(env.staged.dir, path.join(root, 'raw'), { recursive: true });
        fs.cpSync(wikiDir(env), path.join(root, 'wiki'), { recursive: true });
        fs.writeFileSync(path.join(root, 'AGENTS.md'), WIKI_SCHEMA + '\n');
        await env.quota.wait();
        const r = await runAgent({ cwd: root, sandbox: 'workspace-write', model: env.models.model, effort: env.models.buildEffort, maxSteps: 80, closing: null, timeoutMs: 30 * 60_000, prompt: INGEST_PROMPT(files) });
        recordAgent(env.meter, { system: 'llm-wiki', stage: 'update' }, env.models.model, r);
        // a cancelled session leaves the wiki as it was, and the update for a resume
        if (r.cancelled) throw new Error(r.error ?? 'cancelled: the update session');
        fs.rmSync(wikiDir(env), { recursive: true, force: true });
        fs.cpSync(path.join(root, 'wiki'), wikiDir(env), { recursive: true });
      } finally {
        tmp.cleanup();
      }
    },
  };
}

/** Brief for an agent that has a wiki and the sources it was compiled from. */
/** What an agent with a wiki and the sources beside it has: the sentence of the shared brief that says so. */
export const WIKI_SOURCES_HAS = (wiki: string, raw: string, index = 'its index.md') => `The current directory holds a wiki compiled from the documents (${wiki}; start from ${index}) and the source documents themselves (${raw}). Use the wiki to find your way — which sources bear on the question and how they connect — and open the sources to check details or find what the wiki leaves out. Cite source documents by their paths under ${raw}.`;

/**
 * `WIKI_SOURCES_HAS` with one thing changed (docs/design/38 §5.2): where a page states a fact and the document it
 * came from, the agent may answer from the page and cite it, opening the sources only for what the pages leave
 * out — instead of being sent to the index first and to the sources to check. The two sentences differ in that
 * alone (tests/eval-briefs.test.ts shows them side by side).
 */
export const WIKI_FIRST_HAS = (wiki: string, raw: string, index: string) => `The current directory holds a wiki compiled from the documents (${wiki}; ${index} lists every page) and the source documents themselves (${raw}). Where a page states a fact and the document it comes from, you may answer from the page and cite the page by its path; open the sources for what the pages leave out. Cite source documents by their paths under ${raw}.`;

export const WIKI_SOURCES_BRIEF = (wiki: string, raw: string) => AGENT_BRIEF(WIKI_SOURCES_HAS(wiki, raw));

/**
 * A wiki and the sources side by side in a fresh directory with nothing else
 * beside it: `<root>/kb/<wikiAs>` and `<root>/kb/<rawAs>`, as the wiki's own
 * links expect them.
 */
export function wikiWithSources(wiki: string, sources: string, wikiAs: string, rawAs: string): { dir: string; cleanup: () => void } {
  const { root, cleanup } = evalTempDir('ro');
  const dir = path.join(root, 'kb');
  fs.cpSync(wiki, path.join(dir, wikiAs), { recursive: true });
  fs.cpSync(sources, path.join(dir, rawAs), { recursive: true });
  return { dir, cleanup };
}

/**
 * `agent-wiki-sources`: the same LLM Wiki build, read by the same agent, which
 * may also open `raw/` — the wiki as a navigation layer (D7 forbids this for
 * `agent-wiki`, which measures the wiki alone).
 */
export function llmWikiSources(): SystemUnderTest {
  const base = llmWiki();
  return {
    ...base,
    id: 'agent-wiki-sources',
    label: 'LLM Wiki as a navigation layer, Codex agent reading it and the sources',
    async answer(task, prompt, env) {
      await env.quota.wait();
      const copy = wikiWithSources(wikiDir(env), env.staged.dir, 'wiki', 'raw');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${WIKI_SOURCES_BRIEF('wiki/', 'raw/')}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-wiki-sources', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const opened = r.filesTouched.filter((f) => f.startsWith('raw/')).map((f) => f.slice('raw/'.length)).filter((f) => docs.has(f));
        return { text: r.text, citations: citationsIn(r.text, docs), retrieved: [...new Set(opened)], toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs, capped: r.capped, closing: r.closing, leaked: r.leaked, error: r.error };
      } finally {
        copy.cleanup();
      }
    },
  };
}
