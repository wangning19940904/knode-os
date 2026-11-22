import fs from 'node:fs';
import path from 'node:path';
import { GUIDE_FILE } from '../fs/datadir.js';

/**
 * The MCP server's `instructions`: how to use knode-os in three lines, plus
 * the knowledge base's own guide (`AGENTS.md` at the data root, written by
 * an initialization job) so an agent that connects from anywhere learns the
 * base the same way a research or chat session does. The HTTP endpoint builds
 * a server per request, so the text is cached by the guide file's mtime.
 */

const MAX_GUIDE_CHARS = 6_000;

/**
 * The preamble. Its first line routes by the kind of question (docs/design/30):
 * in the 2026-11 benchmark an agent told only to start with knode_resolve
 * called it once and then read raw documents one per call, 8.1 calls a
 * question against a grep agent's 3.7. Its second line used to tell every agent to read the guide
 * first, whether or not one existed: in a benchmark run on a base nobody had
 * initialised, the agent spent a call on `knode_read "AGENTS.md"` in two
 * questions of four and got nothing. With a guide the text follows right
 * here, so reading it again is a call for what the agent already holds.
 * The kinds on the first line are the ones the 2026-11 reports run showed to
 * matter (src/mcp/question-kinds.ts says what each won).
 */
function preamble(guide: 'none' | 'whole' | 'cut'): string {
  const second = guide === 'none'
    ? `knode_survey says what this base holds, in numbers. It has no guide of its own yet (${GUIDE_FILE}, written by an initialization).`
    : `The base's own guide (${GUIDE_FILE}: what it holds, how things are named, which tool answers which question) follows${guide === 'cut' ? ', cut short' : ''}; knode_survey has the current numbers.`;
  return [
    'knode-os is a local knowledge base: documents → entities / relations / claims → wiki pages. Pick the tool by the kind of question. How something changed (progress by month, a history): knode_claims order=timeline (restatements folded; first_mention=true with event_range counts what was new in a period). Lists, counts and rankings across the whole base: knode_query source="catalog" (SQL over v_claims / v_entities / v_relations — its description has the columns and examples) or knode_claims text=, one call for the whole set. Who did what, and chains of it (who fixed X, which project that person owns): v_relations through knode_query, one call per hop (knode_graph_search draws the graph around an entity). "Who or what is X": start with knode_resolve (its entities, claims and passages in one call), then the entity page under wiki/. Passages: knode_search (mode=sag when the answer crosses a relation). Exact strings, IDs, numbers, and a value now or as of a date (the latest source before it): knode_grep with `context`, which shows the lines around each match. Read documents several per call (`paths`), not one call each. as_of / valid_at travel in time.',
    second,
    'Writes go through knode_write (wiki/, raw/docs/, playbooks/packs/) and land quarantined until a person promotes them; a contradiction opens a dispute instead of overwriting.',
    'Web material you rely on goes in with knode_capture: knode fetches the URL itself, keeps the original under raw/docs/research/ (converted and indexed like any document) and returns the path to cite. knode_study shows multi-page research studies.',
  ].join('\n');
}

const cache = new Map<string, { key: string; text: string }>();

export function mcpInstructions(dataDir: string): string {
  const file = path.join(dataDir, GUIDE_FILE);
  let key = 'none';
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    key = 'none';
  }
  const hit = cache.get(dataDir);
  if (hit && hit.key === key) return hit.text;
  let text = preamble('none');
  if (key !== 'none') {
    try {
      const guide = fs.readFileSync(file, 'utf8').trim();
      if (guide) {
        const cut = guide.length > MAX_GUIDE_CHARS;
        const body = cut ? `${guide.slice(0, MAX_GUIDE_CHARS)}\n…（截断；完整指南用 knode_read ${GUIDE_FILE} 读取）` : guide;
        text = `${preamble(cut ? 'cut' : 'whole')}\n\n--- ${GUIDE_FILE} (this knowledge base's guide) ---\n${body}`;
      }
    } catch {
      /* unreadable guide: preamble only */
    }
  }
  cache.set(dataDir, { key, text });
  return text;
}
