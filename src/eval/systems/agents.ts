import path from 'node:path';
import { isolatedCopy, runAgent } from '../agent.js';
import type { StagedCorpus } from '../pack.js';
import { recordAgent, SystemEnv, SystemUnderTest } from './types.js';

/**
 * The grep baseline (docs/design/23 §3): a Codex agent in a copy of the
 * source documents with nothing else beside them, read-only, searching with
 * the shell tools it chooses (rg, grep, sed, cat). No index, no build — the
 * question is whether any knowledge base beats this on quality per token.
 */

/** Commands an answering agent is told it has, unless a run says otherwise (`eval run --agent-budget`). */
export const AGENT_BUDGET = 20;

/**
 * The command budget of this run's answering agents: `KNODE_EVAL_AGENT_BUDGET`
 * (set by `eval run --agent-budget`), 1 to 20, else 20. A low budget is the
 * condition under which what an arm has beside grep can pay for itself: at 20
 * every arm of the 2026-11 campaign answered in four to six commands, so the
 * budget never bound and the arms differed only in what they spent.
 */
export function agentBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KNODE_EVAL_AGENT_BUDGET);
  return Number.isInteger(n) && n >= 1 && n <= AGENT_BUDGET ? n : AGENT_BUDGET;
}

/**
 * The steps after which a session is stopped: the default (runAgent's 25) at the default budget, else the
 * budget and two more — "about n commands" leaves room for one over and the answer.
 */
export function agentMaxSteps(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const n = agentBudget(env);
  return n === AGENT_BUDGET ? undefined : n + 2;
}

export const AGENT_BRIEF = (where: string) => `You are answering a question about a document collection. ${where}
Work read-only: search and read the files with shell commands (rg, grep, ls, sed -n, head, cat). You have a budget of about ${agentBudget()} commands; answer before you run out. Do not use the network.`;

/**
 * An agent arm's brief (docs/design/33 §2): the one skeleton every file agent
 * gets, with what this arm has — the sentence saying what the folder holds and
 * which tools sit beside it — and, for an arm with knode's tools, the guide to
 * them after it. The four arms of the ladder differ in these alone
 * (src/eval/systems/briefs.ts lists them; tests/eval-briefs.test.ts shows them
 * side by side), so a comparison between two arms is a comparison of what
 * they have, not of how they were asked.
 */
export function armBrief(has: string, guide?: string): string {
  return `${AGENT_BRIEF(has)}${guide ? `\n\n${guide}` : ''}`;
}

/** Arm A's sentence: the sources, nothing else. */
export const GREP_HAS = 'The current directory holds the source documents.';

/**
 * A code localization pack's repository (docs/design/37 §3): the name of the one `codebase/<name>/`
 * folder every staged document lies in, or null for any other corpus.
 */
export function stagedRepository(staged: Pick<StagedCorpus, 'docs'>): string | null {
  const names = new Set(staged.docs.map((d) => /^codebase\/([^/]+)\//.exec(d.path)?.[1] ?? ''));
  const [name] = names;
  return names.size === 1 && name ? name : null;
}

/** Arm A's sentence on a repository: the session's working tree is the repository at its base commit. */
export const GREP_HAS_REPOSITORY = (name: string) => `The current directory is the code repository ${name}: its files as of one commit, without git history.`;

export function agentGrep(): SystemUnderTest {
  return {
    id: 'agent-grep',
    label: 'Codex agent with grep over the sources',
    group: 'agent-grep',
    kind: 'agent',
    answers: true,
    async answer(task, prompt, env: SystemEnv) {
      await env.quota.wait();
      // a fresh copy per question: nothing one session leaves behind reaches the next
      const copy = isolatedCopy(env.staged.dir, 'corpus');
      // a repository is the session's working tree, as it is for a coding agent (docs/design/37 §3)
      const repo = stagedRepository(env.staged);
      try {
        const r = await runAgent({
          cwd: repo ? path.join(copy.dir, 'codebase', repo) : copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          maxSteps: agentMaxSteps(),
          prompt: `${armBrief(repo ? GREP_HAS_REPOSITORY(repo) : GREP_HAS)}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-grep', stage: 'agent', task: task.id }, env.models.model, r);
        return { text: r.text, retrieved: repo ? r.filesTouched.map((f) => `codebase/${repo}/${f}`) : r.filesTouched, toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs, capped: r.capped, leaked: r.leaked, error: r.error };
      } finally {
        copy.cleanup();
      }
    },
  };
}
