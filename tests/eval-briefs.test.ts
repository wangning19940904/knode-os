import { describe, expect, it } from 'vitest';
import { AGENT_BRIEF } from '../src/eval/systems/agents.js';
import { LADDER_ARMS, ladderBriefs } from '../src/eval/systems/briefs.js';
import { KNODE_FULL_TOOLS } from '../src/eval/systems/knode.js';

/**
 * The ladder's four arms get one brief (docs/design/33 §2): the same
 * skeleton — opening, read-only shell work, budget, no network — with only
 * what each arm has in its place. Shown side by side here, so an edit to one
 * arm's brief that is not an edit to what it has fails this test.
 */

const SKELETON = `You are answering a question about a document collection. <HAS>
Work read-only: search and read the files with shell commands (rg, grep, ls, sed -n, head, cat). You have a budget of about 20 commands; answer before you run out. Do not use the network.`;

const HAS = {
  // A: the sources
  'agent-grep': 'The current directory holds the source documents.',
  // B: A, plus search over the rag index
  'agent-rag': 'The current directory holds the source documents. You also have one tool, `search` (on the MCP server knode): search(query, k) returns the k passages of the documents that best match the query by words and by meaning, each with its document\'s path, the passage (about 1,200 characters) and a score. A search call counts against the budget as a command does.',
  // C: A, plus the knode wiki (the sources moved to where the pages' links point)
  'agent-knode-wiki-sources': 'The current directory holds a wiki compiled from the documents (wiki/, generated pages; wiki/sources/ holds one summary per document; start from wiki/index.md) and the source documents themselves (raw/docs/). Use the wiki to find your way — which sources bear on the question and how they connect — and open the sources to check details or find what the wiki leaves out. Cite source documents by their paths under raw/docs/.',
  // D: C, plus knode's retrieval tools
  'agent-knode-full': 'The current directory holds a wiki compiled from the documents (wiki/, generated pages; wiki/sources/ holds one summary per document; start from wiki/index.md) and the source documents themselves (raw/docs/). Use the wiki to find your way — which sources bear on the question and how they connect — and open the sources to check details or find what the wiki leaves out. Cite source documents by their paths under raw/docs/. You also have knode\'s retrieval tools (on the MCP server knode) over an index built from the same documents: knode_search, knode_graph_search, knode_claims, knode_query, knode_resolve, knode_survey. Their results name documents as raw/docs/<path> and pages as wiki/<page>, the paths of the current directory. A tool call counts against the budget as a command does.',
} as const;

describe('the ladder\'s briefs', () => {
  const briefs = ladderBriefs();

  it('are one skeleton, the arms differing only in what they have', () => {
    expect(Object.keys(briefs)).toEqual([...LADDER_ARMS]);
    expect(AGENT_BRIEF('<HAS>')).toBe(SKELETON);
    for (const arm of LADDER_ARMS) {
      expect(briefs[arm].has, arm).toBe(HAS[arm]);
      const rest = briefs[arm].guide ? `\n\n${briefs[arm].guide}` : '';
      expect(briefs[arm].text, arm).toBe(SKELETON.replace('<HAS>', HAS[arm]) + rest);
    }
  });

  it('each add one thing to the arm below', () => {
    // B and C start from A's sentence (C names the sources' new place), D from C's
    expect(HAS['agent-rag'].startsWith(HAS['agent-grep'])).toBe(true);
    expect(HAS['agent-knode-full'].startsWith(HAS['agent-knode-wiki-sources'])).toBe(true);
    expect(briefs['agent-grep'].guide).toBeUndefined();
    expect(briefs['agent-rag'].guide).toBeUndefined();
    expect(briefs['agent-knode-wiki-sources'].guide).toBeUndefined();
  });

  it('give arm D the question-kind guide with shell wording, and name only its tools', () => {
    const guide = briefs['agent-knode-full'].guide!;
    expect(guide).toMatch(/^Pick the tool by the kind of question:/);
    expect(guide).toContain('rg in the shell (rg -n -C3 "<string>" raw/docs wiki)');
    expect(guide).toContain('Reading: the shell (sed -n, head or cat; several files in one command)');
    // the catalog's schema, for knode_query
    expect(guide).toContain('v_claims(');
    // never a tool arm D does not have
    for (const missing of ['knode_grep', 'knode_read', 'knode_ls']) expect(briefs['agent-knode-full'].text, missing).not.toContain(missing);
    const named = new Set([...briefs['agent-knode-full'].text.matchAll(/knode_[a-z_]+/g)].map((m) => m[0]));
    expect([...named].filter((t) => !KNODE_FULL_TOOLS.includes(t))).toEqual([]);
  });
});

describe('the agents\' command budget', () => {
  it('is 20 unless a run sets another, which the brief says and the session is held to', async () => {
    const { AGENT_BRIEF, agentBudget, agentMaxSteps } = await import('../src/eval/systems/agents.js');
    expect(agentBudget({})).toBe(20);
    expect(agentMaxSteps({})).toBeUndefined();
    expect(agentBudget({ KNODE_EVAL_AGENT_BUDGET: '3' })).toBe(3);
    expect(agentMaxSteps({ KNODE_EVAL_AGENT_BUDGET: '3' })).toBe(5);
    // not a budget: the default
    for (const bad of ['0', '21', '2.5', 'x']) expect(agentBudget({ KNODE_EVAL_AGENT_BUDGET: bad })).toBe(20);
    const before = process.env.KNODE_EVAL_AGENT_BUDGET;
    try {
      process.env.KNODE_EVAL_AGENT_BUDGET = '3';
      expect(AGENT_BRIEF('X.')).toContain('a budget of about 3 commands');
      delete process.env.KNODE_EVAL_AGENT_BUDGET;
      expect(AGENT_BRIEF('X.')).toContain('a budget of about 20 commands');
    } finally {
      if (before === undefined) delete process.env.KNODE_EVAL_AGENT_BUDGET;
      else process.env.KNODE_EVAL_AGENT_BUDGET = before;
    }
  });
});
