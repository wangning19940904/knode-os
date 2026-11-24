import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { KNODE_FULL_TOOLS } from '../src/eval/systems/knode.js';
import { LADDER_ARMS, ladderBriefs, VARIANT_ARMS, variantBriefs } from '../src/eval/systems/briefs.js';
import { taskPrompt } from '../src/eval/prompts.js';
import { listFiles, loadPack, stageCorpus, validatePack } from '../src/eval/pack.js';
import { leakedFiles } from '../src/eval/leak.js';
import { catalogText } from '../src/eval/systems/agents.js';
import { citationScores } from '../src/eval/metrics/retrieval.js';
import { writeReport } from '../src/eval/report.js';
import { DEFAULT_SYSTEMS, expandSystems, makeSystems, SYSTEM_TRACKS } from '../src/eval/systems/index.js';
import { Command } from 'commander';
import { registerEvalCommands } from '../src/eval/cli.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * The evaluation ladder (docs/design/33 §2) end to end on the fixture pack,
 * with a stand-in Codex: arm D, `agent-knode-full`, is arm C's folder (the
 * knode wiki and the sources) plus knode's six retrieval tools, on the knode
 * build the other knode systems share.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ladder-'));
const packDir = path.join(tmp, 'pack');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const toolsLog = path.join(tmp, 'tools.log');
const promptLog = path.join(tmp, 'prompts.jsonl');
const oldPath = process.env.PATH;

beforeAll(() => {
  buildFixturePack(packDir);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_CODEX_TOOLS_LOG = toolsLog;
  process.env.FAKE_CODEX_PROMPT_LOG = promptLog;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CODEX_TOOLS_LOG;
  delete process.env.FAKE_CODEX_PROMPT_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('arm D: agent-knode-full', () => {
  it('reads the wiki and the sources with the shell and calls only knode\'s retrieval tools, on the shared knode build', async () => {
    const res = await runEval({
      packs: [packDir], systems: ['agent-knode-wiki-sources', 'agent-knode-full'], runDir: path.join(tmp, 'runs', 'd'), quota: false, suites: ['usage'], judgeAudit: 0,
      overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(res.runDir);
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => [b.system, b.ok])).toEqual([['knode', true]]);
    const answers = store.allAnswers().filter((a) => a.system === 'agent-knode-full');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error).map((a) => `${a.taskId}: ${a.error}`)).toEqual([]);
    const a = answers.find((x) => x.taskId === 'q1')!;
    expect(a.commands).toEqual([
      'mcp:knode.knode_resolve {"query":"林晓的岗位"}', 'mcp:knode.knode_search {"query":"林晓 岗位","k":3}',
      'rg -n 林晓 .', `/bin/zsh -lc "rg -l '林晓' . | head -n 5"`,
    ]);
    // both calls reached the build's index and came back
    expect(a.outputs!.slice(0, 2).every((o) => o && o.chars > 0 && !o.failed)).toBe(true);
    // every session's server offered the six retrieval tools, and nothing the shell does
    const offered = new Set(fs.readFileSync(toolsLog, 'utf8').trim().split('\n'));
    expect(offered).toEqual(new Set([[...KNODE_FULL_TOOLS].sort().join(',')]));
    expect(KNODE_FULL_TOOLS).not.toContain('knode_grep');
    expect(KNODE_FULL_TOOLS).not.toContain('knode_read');
    expect(KNODE_FULL_TOOLS).not.toContain('knode_ls');
  }, 180_000);
});

describe('the ladder track', () => {
  it('is the four arms and the single-call track; the diagnostics leave the default set but stay available', () => {
    expect(expandSystems(['ladder'])).toEqual(['agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full', 'knode-ask', 'rag-hybrid']);
    expect(SYSTEM_TRACKS['single-call']).toEqual(['knode-ask', 'rag-hybrid']);
    // a track beside ids: in order, each system once
    expect(expandSystems(['closed-book', 'ladder', 'agent-grep', 'agent-knode'])).toEqual(['closed-book', 'agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full', 'knode-ask', 'rag-hybrid', 'agent-knode']);
    expect(makeSystems(['ladder']).map((s) => s.id)).toEqual(expandSystems(['ladder']));
    for (const id of expandSystems(['ladder'])) expect(DEFAULT_SYSTEMS, id).toContain(id);
    expect(DEFAULT_SYSTEMS).not.toContain('agent-knode');
    expect(DEFAULT_SYSTEMS).not.toContain('agent-knode-wiki');
    // the two arms that each change one thing of a ladder arm: run when named, never by default or with the ladder
    for (const id of VARIANT_ARMS) {
      expect(DEFAULT_SYSTEMS, id).not.toContain(id);
      expect(expandSystems(['ladder']), id).not.toContain(id);
    }
    expect(makeSystems(['agent-knode-wiki-first', 'agent-grep-catalog']).map((s) => [s.id, s.group, s.kind])).toEqual([
      ['agent-knode-wiki-first', 'knode', 'agent'], ['agent-grep-catalog', 'agent-grep', 'agent'],
    ]);
    expect(makeSystems(['agent-knode', 'agent-knode-wiki']).map((s) => s.kind)).toEqual(['agent', 'agent']);
    expect(() => makeSystems(['nope'])).toThrow(/tracks: ladder, single-call/);
  });

  it('is listed by `eval systems list` and named in `eval run --help`', async () => {
    const program = new Command().exitOverride();
    registerEvalCommands(program);
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    try {
      await program.parseAsync(['node', 'knode-os', 'eval', 'systems', 'list']);
    } finally {
      console.log = log;
    }
    expect(out.join('\n')).toMatch(/^ladder\s+agent-grep, agent-rag, agent-knode-wiki-sources, agent-knode-full, knode-ask, rag-hybrid$/m);
    const run = program.commands.find((c) => c.name() === 'eval')!.commands.find((c) => c.name() === 'run')!;
    expect(run.options.find((o) => o.long === '--systems')!.description).toContain('ladder = agent-grep,agent-rag,agent-knode-wiki-sources,agent-knode-full,knode-ask,rag-hybrid');
  });
});

describe('the four arms', () => {
  it('ask every question with the same brief, apart from what each arm has; the report opens with all five differences', async () => {
    fs.rmSync(promptLog, { force: true });
    const res = await runEval({
      packs: [packDir], systems: ['ladder'], runDir: path.join(tmp, 'runs', 'arms'), quota: false, suites: ['usage'], judgeAudit: 0,
      overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(res.runDir);
    expect(store.allAnswers().filter((a) => a.error).map((a) => `${a.system} ${a.taskId}: ${a.error}`)).toEqual([]);
    const briefs = ladderBriefs();
    const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    const questions = new Set(loadPack(packDir).tasks.map((t) => taskPrompt(t)));
    // every session's prompt is one arm's brief, then the question as every system gets it
    const byArm = new Map<string, number>();
    for (const p of prompts) {
      const arm = LADDER_ARMS.find((a) => p.startsWith(`${briefs[a].text}\n\n`) && questions.has(p.slice(briefs[a].text.length + 2)));
      expect(arm, p.slice(0, 200)).toBeDefined();
      byArm.set(arm!, (byArm.get(arm!) ?? 0) + 1);
    }
    for (const arm of LADDER_ARMS) expect(byArm.get(arm), arm).toBe(store.allAnswers().filter((a) => a.system === arm).length);
    // the single-call track answered beside them, on the same two builds
    for (const s of ['knode-ask', 'rag-hybrid']) expect(store.allAnswers().some((a) => a.system === s), s).toBe(true);
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => b.system).sort()).toEqual(['knode', 'rag']);
    const report = writeReport(res.runDir);
    expect(report.data.ladder!.map((r) => r.name)).toEqual(['B − A', 'C − A', 'D − C', 'D − A', 'D − B']);
    expect(report.data.ladder!.every((r) => r.n > 0)).toBe(true);
    expect(report.data.discrimination!.systems).toEqual([...LADDER_ARMS].sort());
    expect(report.data.knodeTools!['fixture-life']['agent-knode-full'].map((t) => t.tool).sort()).toEqual(['knode_resolve', 'knode_search']);
    const md = fs.readFileSync(report.md, 'utf8');
    expect(md.indexOf('## The ladder')).toBeLessThan(md.indexOf('## Which questions tell the agents apart'));
  }, 180_000);
});

describe('the variant arms', () => {
  it('agent-knode-wiki-first reads arm C\'s folder and may cite a page; agent-grep-catalog reads arm A\'s with a catalog', async () => {
    const cwdLog = path.join(tmp, 'cwd.jsonl');
    fs.rmSync(promptLog, { force: true });
    process.env.FAKE_CODEX_CWD_LOG = cwdLog;
    process.env.FAKE_CODEX_CITE_PAGE = '1';
    let runDir: string;
    try {
      const res = await runEval({
        packs: [packDir], systems: ['agent-knode-wiki-first', 'agent-grep-catalog'], runDir: path.join(tmp, 'runs', 'variants'), quota: false, suites: ['usage'], judgeAudit: 0,
        overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
      });
      runDir = res.runDir;
    } finally {
      delete process.env.FAKE_CODEX_CWD_LOG;
      delete process.env.FAKE_CODEX_CITE_PAGE;
    }
    const store = new RunStore(runDir);
    const pack = loadPack(packDir);
    expect(store.allAnswers().filter((a) => a.error).map((a) => `${a.system} ${a.taskId}: ${a.error}`)).toEqual([]);
    // wiki-first answers on the shared knode build; the catalog arm builds nothing
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => b.system)).toEqual(['knode']);

    // every session's prompt is its arm's brief, then the question
    const briefs = variantBriefs();
    const questions = new Set(pack.tasks.map((t) => taskPrompt(t)));
    const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    const byArm = new Map<string, number>();
    for (const p of prompts) {
      const arm = VARIANT_ARMS.find((a) => p.startsWith(`${briefs[a].text}\n\n`) && questions.has(p.slice(briefs[a].text.length + 2)));
      expect(arm, p.slice(0, 200)).toBeDefined();
      byArm.set(arm!, (byArm.get(arm!) ?? 0) + 1);
    }
    for (const arm of VARIANT_ARMS) expect(byArm.get(arm), arm).toBe(store.allAnswers().filter((a) => a.system === arm).length);

    // each session's folder
    const sessions = fs.readFileSync(cwdLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { prompt: string; files: string[]; catalog: string | null });
    const corpus = pack.docs.map((d) => d.path).sort();
    const catalogSessions = sessions.filter((x) => x.prompt.includes('CATALOG.md'));
    const wikiSessions = sessions.filter((x) => !x.prompt.includes('CATALOG.md'));
    expect(catalogSessions.length).toBe(byArm.get('agent-grep-catalog'));
    expect(wikiSessions.length).toBe(byArm.get('agent-knode-wiki-first'));
    for (const x of catalogSessions) {
      // arm A's folder, the sources and nothing else, plus the catalog
      expect(x.files).toEqual([...corpus, 'CATALOG.md'].sort());
      expect(x.catalog).toBe(catalogText(pack.docs));
    }
    const catalog = catalogSessions[0].catalog!;
    for (const d of pack.docs) expect(catalog).toContain(`| ${d.path} |  | ${d.date ?? ''} |`);
    // nothing of a question or its gold in it
    for (const t of pack.tasks) {
      expect(catalog, t.id).not.toContain(t.question);
      for (const g of [t.answer, ...(t.answers ?? [])].filter((x): x is string => !!x && x.length > 3)) expect(catalog, t.id).not.toContain(g);
    }
    for (const x of wikiSessions) {
      // arm C's folder: the pages and the sources where their links point, no catalog
      expect(x.catalog).toBeNull();
      expect(x.files.filter((f) => f.startsWith('raw/docs/')).map((f) => f.slice('raw/docs/'.length))).toEqual(corpus);
      expect(x.files.filter((f) => !f.startsWith('raw/docs/')).every((f) => f.startsWith('wiki/'))).toBe(true);
      expect(x.files).toContain('wiki/index.md');
    }

    // the leak audit holds with the catalog beside the sources, and the pack is still valid
    const staged = stageCorpus(pack);
    try {
      fs.writeFileSync(path.join(staged.dir, 'CATALOG.md'), catalogText(staged.docs));
      expect(listFiles(staged.dir)).toContain('CATALOG.md');
      expect(leakedFiles(staged.dir, packDir)).toEqual([]);
    } finally {
      staged.cleanup();
    }
    expect(validatePack(pack).errors).toEqual([]);

    // a wiki-first answer that cites a page naming the email (the fixture's build has its entity pages) is scored on the
    // documents the page stands for
    const q1 = store.allAnswers().find((a) => a.system === 'agent-knode-wiki-first' && a.taskId === 'q1')!;
    expect(q1.citations).toEqual([]);
    const [page, index] = q1.pageCitations!;
    expect(page.page).toMatch(/^wiki\/(sources|entities)\/.+\.md$/);
    expect(page.docs).toContain('email/2026-03-05.md');
    expect(index).toEqual({ page: 'wiki/index.md', docs: [] });
    expect(q1.pageCitations).toHaveLength(2);
    const score = (system: string, metric: string) => store.allScores().find((r) => r.system === system && r.taskId === 'q1' && r.metric === metric)?.value;
    const evidence = pack.tasks.find((t) => t.id === 'q1')!.evidence.map((e) => e.doc);
    expect(evidence).toContain('email/2026-03-05.md');
    const expected = citationScores(page.docs, evidence);
    expect(expected.recall).toBeGreaterThan(0);
    expect(score('agent-knode-wiki-first', 'citation_recall')).toBe(expected.recall);
    expect(score('agent-knode-wiki-first', 'citation_precision')).toBe(expected.precision);
    expect(score('agent-knode-wiki-first', 'cited_page')).toBe(1);
    expect(score('agent-knode-wiki-first', 'unmapped_page_citations')).toBe(1);
    // the catalog arm cites documents, and records no pages
    expect(score('agent-grep-catalog', 'citation_recall')).toBe(1 / evidence.length);
    expect(score('agent-grep-catalog', 'cited_page')).toBeUndefined();
    const grepAnswer = store.allAnswers().find((a) => a.system === 'agent-grep-catalog' && a.taskId === 'q1')!;
    expect(grepAnswer.pageCitations).toBeUndefined();
  }, 180_000);
});
