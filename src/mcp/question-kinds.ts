/**
 * Which tool answers which kind of question, for an agent's brief
 * (docs/design/30 §5). The kinds are the ones the 2026-11 reports benchmark
 * (10×, 1,420 weekly reports) showed to matter, checked on its built index
 * without a model:
 *
 *   - a timeline of one entity (progress at each month-end): knode_claims
 *     order=timeline answered in one call; the agent that started there scored
 *     0.93 on those questions, the grep agent 0.43;
 *   - who did what, and chains of it (the engineer who fixed X, the project
 *     that person owns): one v_relations query per entity lists every such
 *     edge with the sentence stating it; deep-hop answers that began with a
 *     structured call scored 1.00, those that only grepped 0.43;
 *   - lists and counts across the whole collection (who moved teams, which
 *     customers escalated, P1 incidents company-wide): one query or one
 *     knode_claims text= call returns the set, where grepping took up to 15
 *     calls;
 *   - a value as of a date: grep, not the claims. The documents change a
 *     setting under a code or short name after its first mention, and the
 *     claims kept only the first value ("最初定为15分钟"), so a claim there is
 *     a stale answer.
 *
 * `grep` and `read` name the tools the agent has for those two jobs: the MCP
 * knode_grep / knode_read, or a shell when the agent works on the files
 * themselves, so the same guide serves an agent that has grep and one that has
 * only the structured tools beside a shell.
 */
export function questionKindGuide(tools: { grep: string; read: string } = { grep: 'knode_grep with context=3', read: 'knode_read with paths=[…] (several documents in one call, never one per call)' }): string {
  return `Pick the tool by the kind of question:
- How something changed over time (a metric or progress by week or month-end, a risk from raised to closed, a history): knode_claims subject=<entity> order="timeline" — its changes with their dates and sources, oldest first: replaced values are included, a value restated in later reports is one entry with its \`repeats\`, a weekly series one entry with its \`readings\` (fold=false lists every claim). One call gives the chronology; related=true adds what happened to the subject's members and parts.
- Who did what (fixed, raised, owns, escalated, moved), a chain of such hops ("the engineer who fixed X — which project do they own now?"), or everything about one person or project: knode_query with source="catalog" on v_relations (example below) lists every relation of an entity with the sentence that states it. Take a chain one entity per call instead of grepping for each name.
- Lists, counts and rankings across the whole collection (every team, division or customer: "which people moved teams", "how many P1 incidents company-wide"): one knode_query (count / GROUP BY over v_claims, v_relations, v_entities) or knode_claims text="<word>". To count what was new in a period (incidents reported, risks raised, hires in a quarter): knode_claims with event_range and first_mention=true — a plain event_range also returns later follow-ups of older ones, marked followUp. Say which sources a count rests on: summaries and the reports they summarise can disagree.
- A value now or as of a date (a setting, a threshold, the latest metric): ${tools.grep}. Later documents change a value under a code or short name that the extracted claims may miss: find the latest source at or before the date and read it.
- An exact string, ID, name or number: ${tools.grep}.
- "Who or what is X" for something you have not met yet: knode_resolve on the question; a passage that says something in other words: knode_search.
- Reading: ${tools.read}.
Structured results are extracted from the documents: quote and cite the source document they name, and read it when the answer turns on one line.`;
}
