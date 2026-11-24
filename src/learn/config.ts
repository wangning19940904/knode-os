/**
 * Learning from use (docs/design/38 §4): what an answer leaves behind in the
 * knowledge base. Absent from a config, or `enabled: false`, nothing is
 * written back and every path behaves as before.
 */
export interface LearnConfig {
  /** Off by default. */
  enabled: boolean;
  /**
   * What a write-back whose every check passed does. false (the default):
   * it waits for a person like any other agent write (a `learn` suggestion,
   * outside the index until accepted). true: it takes effect at once. A
   * write-back with a failed check waits for a person either way.
   */
  autoAccept: boolean;
  /** Write back Ask's answers (the HTTP /api/ask and MCP knode_ask) — default true once enabled. */
  ask: boolean;
  /** Derive facts (subject, attribute, period, value, line) from the answers written back — default true. */
  facts: boolean;
  /** Where derived facts go (src/learn/facts.ts `registerFactSink`); default `page-claims`. */
  factSink: string;
}

export const DEFAULT_LEARN: LearnConfig = { enabled: false, autoAccept: false, ask: true, facts: true, factSink: 'page-claims' };

export function learnConfig(config: { learn?: Partial<LearnConfig> | null }): LearnConfig {
  return { ...DEFAULT_LEARN, ...(config.learn ?? {}) };
}

/** Where learned question pages live: beside the researched ones, in a folder of their own. */
export const LEARNED_DIR = 'wiki/questions/learned';

/** Who writes them: no agent prefix, so a page that took effect is trusted (src/lineage/trust.ts `tierForActor`). */
export const LEARN_WRITER = 'knode/learn';

/** A source key is a learned page — its claims are derived from an answer, not extracted from a document. */
export function isLearnedPath(p: string | null | undefined): boolean {
  return Boolean(p && (p === LEARNED_DIR || p.startsWith(`${LEARNED_DIR}/`)));
}
