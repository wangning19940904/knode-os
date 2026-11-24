import { agentGrep } from './agents.js';
import { LADDER_ARMS } from './briefs.js';
import { externalSystem, EXTERNAL_SYSTEMS } from './external.js';
import { agentKnode, agentKnodeFull, agentKnodeWiki, agentKnodeWikiSources, knodeAsk, knodeAskHops, knodeSag } from './knode.js';
import { agentGrepNotes, agentKnodeLearn, knodeAskLearn, knodeAskLearnReview } from './learning.js';
import { llmWiki, llmWikiSources } from './llm-wiki.js';
import { agentRag, ragBm25, ragHybrid, ragVector } from './rag.js';
import { closedBook, longContext } from './refs.js';
import type { SystemUnderTest } from './types.js';

/** Every system the suite knows, in the order a run takes them (knowledge bases first, references last). */
export const SYSTEMS: Record<string, () => SystemUnderTest> = {
  'knode-ask': knodeAsk,
  'knode-ask-hops': knodeAskHops,
  'knode-sag': knodeSag,
  'agent-knode': agentKnode,
  'agent-knode-wiki': agentKnodeWiki,
  'agent-knode-wiki-sources': agentKnodeWikiSources,
  'agent-knode-full': agentKnodeFull,
  'agent-wiki': llmWiki,
  'agent-wiki-sources': llmWikiSources,
  'agent-grep': agentGrep,
  'agent-rag': agentRag,
  'rag-hybrid': ragHybrid,
  'rag-bm25': ragBm25,
  'rag-vector': ragVector,
  'knode-ask-learn': knodeAskLearn,
  'knode-ask-learn-review': knodeAskLearnReview,
  'agent-knode-learn': agentKnodeLearn,
  'agent-grep-notes': agentGrepNotes,
  'closed-book': closedBook,
  'long-context': longContext,
  ...Object.fromEntries(EXTERNAL_SYSTEMS.map((id) => [id, () => externalSystem(id)])),
};

/** The learning suite's systems: each a build of its own, so a run takes them only when named. */
export const LEARNING_SYSTEMS = ['knode-ask-learn', 'knode-ask-learn-review', 'agent-knode-learn', 'agent-grep-notes'] as const;

/**
 * Named sets of systems `--systems` takes beside system ids (docs/design/33
 * §2): `ladder`, the headline — the four agent arms and the single-call track
 * — and `single-call` alone (knode's Ask and plain RAG, a cheap regression
 * check on every pack).
 */
export const SYSTEM_TRACKS: Record<string, readonly string[]> = {
  ladder: [...LADDER_ARMS, 'knode-ask', 'rag-hybrid'],
  'single-call': ['knode-ask', 'rag-hybrid'],
  // the learning suite (docs/design/38 §4.3): the systems that learn, the notes baseline, and two that do not as controls
  learning: [...LEARNING_SYSTEMS, 'agent-grep', 'knode-ask'],
};

/**
 * Systems a run takes only when named: the diagnostics (docs/design/33 D3) — MCP tools with no files, the wiki
 * with no sources — and Ask's variant with the hop and aggregate retrieval on, answered beside `knode-ask` on its build.
 */
export const DIAGNOSTIC_SYSTEMS = ['agent-knode', 'agent-knode-wiki', 'knode-ask-hops'] as const;

/** System ids with every track name replaced by its systems, in order, each once. */
export function expandSystems(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => SYSTEM_TRACKS[id] ?? [id]))];
}

/** A run with no `--systems`: every native system but the diagnostics and the learning suite's. */
export const DEFAULT_SYSTEMS = Object.keys(SYSTEMS).filter((id) => !EXTERNAL_SYSTEMS.includes(id as (typeof EXTERNAL_SYSTEMS)[number]) && !(DIAGNOSTIC_SYSTEMS as readonly string[]).includes(id) && !(LEARNING_SYSTEMS as readonly string[]).includes(id));

export function makeSystems(ids: string[]): SystemUnderTest[] {
  return expandSystems(ids).map((id) => {
    const f = SYSTEMS[id];
    if (!f) throw new Error(`unknown system "${id}" (known: ${Object.keys(SYSTEMS).join(', ')}; tracks: ${Object.keys(SYSTEM_TRACKS).join(', ')})`);
    return f();
  });
}
