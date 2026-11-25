import { agentGrep, agentGrepCatalog } from './agents.js';
import { LADDER_ARMS } from './briefs.js';
import { externalSystem, EXTERNAL_SYSTEMS } from './external.js';
import { agentKnode, agentKnodeFull, agentKnodeWiki, agentKnodeWikiFirst, agentKnodeWikiSources, knodeAsk, knodeAskHops, knodeSag } from './knode.js';
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
  'agent-knode-wiki-first': agentKnodeWikiFirst,
  'agent-knode-full': agentKnodeFull,
  'agent-wiki': llmWiki,
  'agent-wiki-sources': llmWikiSources,
  'agent-grep': agentGrep,
  'agent-grep-catalog': agentGrepCatalog,
  'agent-rag': agentRag,
  'rag-hybrid': ragHybrid,
  'rag-bm25': ragBm25,
  'rag-vector': ragVector,
  'closed-book': closedBook,
  'long-context': longContext,
  ...Object.fromEntries(EXTERNAL_SYSTEMS.map((id) => [id, () => externalSystem(id)])),
};

/**
 * Named sets of systems `--systems` takes beside system ids (docs/design/33
 * §2): `ladder`, the headline — the four agent arms and the single-call track
 * — and `single-call` alone (knode's Ask and plain RAG, a cheap regression
 * check on every pack).
 */
export const SYSTEM_TRACKS: Record<string, readonly string[]> = {
  ladder: [...LADDER_ARMS, 'knode-ask', 'rag-hybrid'],
  'single-call': ['knode-ask', 'rag-hybrid'],
};

/**
 * Systems a run takes only when named: the diagnostics (docs/design/33 D3) — MCP tools with no files, the wiki
 * with no sources — Ask's variant with the hop and aggregate retrieval on, answered beside `knode-ask` on its build,
 * and the two arms that each change one thing of a ladder arm (docs/design/38 §5.2): arm C with leave to answer
 * from the pages, and arm A with a catalog of its documents.
 */
export const DIAGNOSTIC_SYSTEMS = ['agent-knode', 'agent-knode-wiki', 'knode-ask-hops', 'agent-knode-wiki-first', 'agent-grep-catalog'] as const;

/** System ids with every track name replaced by its systems, in order, each once. */
export function expandSystems(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => SYSTEM_TRACKS[id] ?? [id]))];
}

/** A run with no `--systems`: every native system but the diagnostics. */
export const DEFAULT_SYSTEMS = Object.keys(SYSTEMS).filter((id) => !EXTERNAL_SYSTEMS.includes(id as (typeof EXTERNAL_SYSTEMS)[number]) && !(DIAGNOSTIC_SYSTEMS as readonly string[]).includes(id));

export function makeSystems(ids: string[]): SystemUnderTest[] {
  return expandSystems(ids).map((id) => {
    const f = SYSTEMS[id];
    if (!f) throw new Error(`unknown system "${id}" (known: ${Object.keys(SYSTEMS).join(', ')}; tracks: ${Object.keys(SYSTEM_TRACKS).join(', ')})`);
    return f();
  });
}
