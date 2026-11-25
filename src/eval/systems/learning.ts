import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import { finalLine, writeBack, writeBackAsk, WritebackResult } from '../../learn/writeback.js';
import { isolatedCopy, runAgent } from '../agent.js';
import type { Usage } from '../types.js';
import { agentMaxSteps, armBrief, GREP_HAS } from './agents.js';
import { agentKnodeFull, askOptionsFromEnv, askSystem } from './knode.js';
import { recordAgent, SystemEnv, SystemUnderTest } from './types.js';

/**
 * The systems of the learning suite (docs/design/38 §4.3, src/eval/learning).
 *
 * Each writes into what it answers from, so each has a build of its own: a
 * write-back of one must never reach another, nor the shared `knode` build the
 * other knode systems answer from. They answer one question at a time
 * (`sequential`), in the stream's order.
 *
 *   knode-ask-learn         Ask, each answer written back; verified pages take effect at once (auto-accept)
 *   knode-ask-learn-review  the same, everything waiting for review — what a person who never reviews gets
 *   agent-knode-learn       arm D (wiki, sources, knode tools), its final answer written back (auto-accept)
 *   agent-grep-notes        the fair baseline: arm A with a notes file of its own, kept from question to question
 *
 * A write-back costs no model call (the checks are deterministic); what it
 * costs — its time, and the embedding of the page it indexes — is in
 * `learn-log.jsonl` beside the build, one line per answer, which the learning
 * report adds to the system's cost.
 */

export interface LearnLogLine {
  task: string;
  status: WritebackResult['status'];
  reason?: string;
  verified?: boolean;
  checks: number;
  passed: number;
  facts: number;
  path?: string;
  ms: number;
  /** Embedding work the write-back's indexing did, metered on the build's tag. */
  embeddingTokens: number;
  weightedTokens: number;
}

export const LEARN_LOG = 'learn-log.jsonl';

function appendLog(env: SystemEnv, line: object): void {
  fs.mkdirSync(env.workDir, { recursive: true });
  fs.appendFileSync(path.join(env.workDir, LEARN_LOG), `${JSON.stringify(line)}\n`);
}

/** Write back with the build's learning set as this system has it, metering what the write-back's own indexing costs. */
async function learned(env: SystemEnv, group: string, task: { id: string }, autoAccept: boolean, ctx: AppContext, run: () => Promise<WritebackResult>): Promise<void> {
  ctx.config.learn = { enabled: true, autoAccept, ask: true, facts: true };
  const mark = env.meter.mark();
  let r: WritebackResult;
  try {
    r = await run();
  } catch (err) {
    r = { status: 'skipped', reason: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), ms: 0 };
  }
  const usage: Usage = env.meter.usage((e) => e.system === group && !e.task, mark);
  const line: LearnLogLine = {
    task: task.id, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.verified !== undefined ? { verified: r.verified } : {}),
    checks: r.checks?.length ?? 0, passed: r.checks?.filter((c) => c.ok).length ?? 0, facts: r.facts?.length ?? 0, ...(r.path ? { path: r.path } : {}),
    ms: r.ms, embeddingTokens: usage.embeddingTokens, weightedTokens: usage.weightedTokens,
  };
  appendLog(env, line);
}

function askLearner(id: string, label: string, autoAccept: boolean): SystemUnderTest {
  const s = askSystem(id, label, {
    options: askOptionsFromEnv(),
    group: id,
    after: (ctx, task, res, env) => learned(env, id, task, autoAccept, ctx, () => writeBackAsk(ctx, task.question, res, 'eval')),
  });
  return { ...s, sequential: true, settings: { ...(s.settings ?? {}), learn: { autoAccept } } };
}

export function knodeAskLearn(): SystemUnderTest {
  return askLearner('knode-ask-learn', 'knode-os ask writing its answers back (verified pages take effect at once)', true);
}

export function knodeAskLearnReview(): SystemUnderTest {
  return askLearner('knode-ask-learn-review', 'knode-os ask writing its answers back (every page waits for review)', false);
}

/** The citations an agent's answer writes, line ranges kept: `[doc: a.md#L12, b.md]`. */
export function answerCitations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[doc:\s*([^\]]+)\]/gi)) for (const part of m[1].split(/[,;，；]/)) if (part.trim()) out.push(part.trim());
  for (const m of text.matchAll(/raw\/docs\/[^\s)\]'"`，。]+/g)) out.push(m[0]);
  return [...new Set(out)];
}

export const AGENT_LEARN_HAS = 'wiki/questions/learned/ holds answers to earlier questions, each value checked against the line of the source it cites.';

export function agentKnodeLearn(): SystemUnderTest {
  const id = 'agent-knode-learn';
  const s = agentKnodeFull({
    id,
    label: 'arm D writing its answers back (verified pages take effect at once)',
    group: id,
    has: AGENT_LEARN_HAS,
    after: (ctx, task, answer, env) => learned(env, id, task, true, ctx, () => writeBack(ctx, {
      question: task.question, answer: answer.text, finalAnswer: finalLine(answer.text), citations: answerCitations(answer.text), origin: 'eval-agent',
    })),
  });
  // its build is its own, so it applies the update batches itself — as knode-ask does on the shared build
  const { update } = askSystem(id, s.label, { options: askOptionsFromEnv(), group: id });
  return { ...s, sequential: true, update };
}

/* ------------------------------------------------------------------ agent-grep-notes */

/** The notes file's name in the session's folder (another, when the corpus holds a file of that name). */
export const NOTES_FILE = 'NOTES.md';
/** What is kept of the notes between questions: the first this many characters. */
export const NOTES_MAX_CHARS = 24_000;
const NOTES_STATE = 'notes.md';
export const NOTES_LOG = 'notes-log.jsonl';

export const NOTES_GUIDE = (name: string) => `The one file you may write is ${name}, in the current directory: your own notes, kept from one question to the next of this series (it starts empty, and nothing but what you write goes into it). Read it when it may help. Before you answer, add to it what would help with a later question — where a figure stands (file and line), which table or wording holds a measure, how you computed something — and never an answer without the file and line it came from. Keep it short: only the first ${NOTES_MAX_CHARS} characters are kept.`;

export interface NotesLogLine {
  task: string;
  before: number;
  after: number;
  /** The session ended without an answer it could keep notes for (an error, cancelled): the notes stayed as they were. */
  kept: boolean;
}

export function readNotes(workDir: string): string {
  const f = path.join(workDir, NOTES_STATE);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

export function agentGrepNotes(): SystemUnderTest {
  return {
    id: 'agent-grep-notes',
    label: 'Codex agent with grep over the sources and a notes file it keeps across questions',
    group: 'agent-grep-notes',
    kind: 'agent',
    answers: true,
    // the notes go from one question to the next: never two questions at once
    sequential: true,
    async answer(task, prompt, env: SystemEnv) {
      await env.quota.wait();
      const copy = isolatedCopy(env.staged.dir, 'corpus');
      const name = fs.existsSync(path.join(copy.dir, NOTES_FILE)) ? '_agent_notes.md' : NOTES_FILE;
      const notesPath = path.join(copy.dir, name);
      const before = readNotes(env.workDir);
      fs.writeFileSync(notesPath, before);
      try {
        // writing the notes needs a writable folder; a session that writes runs on this machine (src/eval/remote.ts)
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'workspace-write',
          model: env.models.model,
          effort: env.models.answerEffort,
          maxSteps: agentMaxSteps(),
          prompt: `${armBrief(GREP_HAS, NOTES_GUIDE(name))}\n\n${prompt}`,
          label: `agent-grep-notes · ${task.id}`,
        });
        recordAgent(env.meter, { system: 'agent-grep-notes', stage: 'agent', task: task.id }, env.models.model, r);
        const keep = !r.cancelled && !r.error && fs.existsSync(notesPath);
        const after = keep ? fs.readFileSync(notesPath, 'utf8').slice(0, NOTES_MAX_CHARS) : before;
        if (keep) {
          fs.mkdirSync(env.workDir, { recursive: true });
          fs.writeFileSync(path.join(env.workDir, NOTES_STATE), after);
        }
        const line: NotesLogLine = { task: task.id, before: before.length, after: after.length, kept: keep };
        fs.appendFileSync(path.join(env.workDir, NOTES_LOG), `${JSON.stringify(line)}\n`);
        return {
          text: r.text, retrieved: r.filesTouched.filter((f) => f !== name && f !== `./${name}`),
          toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs, capped: r.capped, closing: r.closing, leaked: r.leaked, error: r.error,
        };
      } finally {
        copy.cleanup();
      }
    },
  };
}
