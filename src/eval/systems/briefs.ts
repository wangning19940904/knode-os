import { armBrief, GREP_CATALOG_HAS, GREP_HAS } from './agents.js';
import { AGENT_KNODE_FULL_HAS, KNODE_WIKI_FIRST_HAS, KNODE_WIKI_SOURCES_HAS, knodeFullGuide } from './knode.js';
import { AGENT_RAG_HAS } from './rag.js';

/**
 * The ladder's four agent arms (docs/design/33 §2), each a superset of the one
 * before it: A the sources, B A plus a RAG search tool, C A plus the knode
 * wiki, D C plus knode's retrieval tools.
 */
export const LADDER_ARMS = ['agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full'] as const;
export type LadderArm = (typeof LADDER_ARMS)[number];

export interface LadderBrief {
  /** The arm's letter in design 33. */
  arm: 'A' | 'B' | 'C' | 'D';
  /** The sentence of the shared skeleton saying what the arm has. */
  has: string;
  /** The guide to its knode tools, after the skeleton (arm D only). */
  guide?: string;
  /** The brief as the arm's sessions get it, before the question. */
  text: string;
}

/** Each arm's brief, built from the same parts the arms build theirs from. */
export function ladderBriefs(): Record<LadderArm, LadderBrief> {
  const brief = (arm: LadderBrief['arm'], has: string, guide?: string): LadderBrief => ({ arm, has, ...(guide ? { guide } : {}), text: armBrief(has, guide) });
  return {
    'agent-grep': brief('A', GREP_HAS),
    'agent-rag': brief('B', AGENT_RAG_HAS),
    'agent-knode-wiki-sources': brief('C', KNODE_WIKI_SOURCES_HAS),
    'agent-knode-full': brief('D', AGENT_KNODE_FULL_HAS, knodeFullGuide()),
  };
}

/**
 * Arms that change one thing of a ladder arm (docs/design/38 §5.2), each run only when named: arm A with a catalog
 * of its documents, arm C with leave to answer from the pages. Their briefs are the ladder's skeleton with their
 * own sentence of what they have.
 */
export const VARIANT_ARMS = ['agent-grep-catalog', 'agent-knode-wiki-first'] as const;
export type VariantArm = (typeof VARIANT_ARMS)[number];

export interface VariantBrief {
  /** The ladder arm it varies, and what it changes. */
  of: LadderArm;
  changes: string;
  has: string;
  text: string;
}

export function variantBriefs(): Record<VariantArm, VariantBrief> {
  const brief = (of: LadderArm, changes: string, has: string): VariantBrief => ({ of, changes, has, text: armBrief(has) });
  return {
    'agent-grep-catalog': brief('agent-grep', 'a catalog file of the documents: path, title, date', GREP_CATALOG_HAS()),
    'agent-knode-wiki-first': brief('agent-knode-wiki-sources', 'may answer from a page that states the fact and its source, and cite the page', KNODE_WIKI_FIRST_HAS),
  };
}
