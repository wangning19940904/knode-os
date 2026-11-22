import fs from 'node:fs';
import { CODEBASE_CARDS, RAW_CODEBASE } from '../fs/layout.js';
import { safePath } from '../fs/files.js';
import { loadSourceText, sha256 } from '../ingest/source.js';
import { parseFrontmatter } from '../markdown.js';
import { Queryable } from '../store/migrations.js';
import { DepDecl } from './types.js';

/**
 * A written wiki page's citations of files, as dependencies (docs/design/37 §5).
 *
 * Research agents cite in prose — `（来源：raw/docs/…）`, `(Source: raw/codebase/<repo>/<path>#L12-L40; …)`,
 * a `sources:` list, a claim's `source:` — and none of that is a link the
 * citation rows of src/graph/citations.ts read. Here every `raw/docs/…` and
 * `raw/codebase/…` path the page's text names, in the body or the
 * frontmatter, with or without a `#L…` range, becomes one `deps` row of the
 * page on the cited document, under artifact kind `cites` (src/lineage/types.ts,
 * so `propagate` never acts on it and the comparison reads these rows alone):
 * `required: false` (a removed file never archives
 * a page an agent wrote) and the document's content hash, which is what a
 * later change is detected against (src/research/cited-refresh.ts).
 *
 * Parsing is one regular-expression pass over the text; resolving is one
 * query for the documents the index holds and a file read for those it does
 * not hold yet — a wiki page is applied before the repositories in a sync
 * (src/lineage/declared.ts walks wiki/ first), so the hash of a file not yet
 * indexed is the hash its apply will record (src/ingest/source.ts). The same
 * page text over the same files therefore yields the same rows whichever
 * order a sync or a rebuild applies them in.
 *
 * A repository card (`raw/docs/codebase/<repo>.md`) is never a dependency:
 * it is re-rendered on every commit, so citing it would make every update
 * look like a change. What a page was checked against is the repository's
 * commit, recorded separately (`commits`).
 */

/** Bump when these rules change: a wiki page applied under an older version is read again once (src/ingest/apply.ts). */
export const CITE_DEPS_VERSION = 1;

/** More distinct paths than this on one page are not followed: a page that long is a list, not an argument. */
const MAX_CITED = 2000;

// a path starts at raw/docs/ or raw/codebase/ not glued to a longer word (a `../../raw/docs/x` link counts) and runs
// until whitespace or a delimiter prose puts around a citation: brackets, quotes, separators, a `#` fragment
const CITED_RE = /(^|[^A-Za-z0-9_.-])((?:\.sidecar\/)?raw\/(?:docs|codebase)\/[^\s()（）[\]{}<>"'`|#,，;；、]+)/g;

/** The paths a text names under raw/docs or raw/codebase, as written (trailing sentence punctuation kept), first-seen order. */
export function citedPathCandidates(text: string): string[] {
  if (!text.includes('raw/')) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(CITED_RE)) {
    out.add(m[2]);
    if (out.size >= MAX_CITED) break;
  }
  return [...out];
}

/** The spellings a candidate may name, best first: as written, without trailing punctuation, with `.md`, URL-decoded. */
function spellings(candidate: string): string[] {
  let c = candidate;
  // a converted original's Markdown names the original: .sidecar/raw/docs/x.pdf/content.md → raw/docs/x.pdf
  if (c.startsWith('.sidecar/')) c = c.slice('.sidecar/'.length).replace(/\/content\.md$/, '');
  const trimmed = c.replace(/[.。:：!！?？*~]+$/, '');
  const out = [c, trimmed];
  if (/%[0-9A-Fa-f]{2}/.test(trimmed)) {
    try {
      out.push(decodeURIComponent(trimmed));
    } catch {
      /* not an escape */
    }
  }
  for (const s of [...out]) if (!/\.[A-Za-z0-9]{1,8}$/.test(s)) out.push(`${s}.md`);
  return [...new Set(out.filter((s) => /^raw\/(docs|codebase)\/./.test(s) && !s.includes('/../') && !s.endsWith('/')))];
}

/** `raw/docs/codebase/<repo>.md`: a repository card. */
export function isRepositoryCard(file: string): boolean {
  return file.startsWith(`${CODEBASE_CARDS}/`) && file.endsWith('.md') && !file.slice(CODEBASE_CARDS.length + 1).includes('/');
}

/** The repository a `raw/codebase/<repo>/…` path lies in. */
export function repositoryOf(file: string): string | null {
  if (!file.startsWith(`${RAW_CODEBASE}/`)) return null;
  const name = file.slice(RAW_CODEBASE.length + 1).split('/', 1)[0];
  return name || null;
}

/** The commit a repository's card says its mirror holds, read from the card's frontmatter. */
export function mirrorCommit(dataDir: string, repo: string): string | null {
  try {
    const text = fs.readFileSync(safePath(dataDir, `${CODEBASE_CARDS}/${repo}.md`), 'utf8');
    const commit = parseFrontmatter(text).frontmatter.commit;
    return typeof commit === 'string' && commit.trim() ? commit.trim() : null;
  } catch {
    return null;
  }
}

export interface CitationDepsPlan {
  deps: (DepDecl & { kind: 'document'; sha: string })[];
  /** Repository → the commit its mirror held when the page was applied, for each repository the page cites. */
  commits: Record<string, string>;
  /** Candidates that named no readable file: a typo, a folder, a file since removed, a conversion not made. */
  unresolved: string[];
}

function rootOf(file: string): 'codebase' | 'docs' {
  return file.startsWith(`${RAW_CODEBASE}/`) ? 'codebase' : 'docs';
}

function isFile(dataDir: string, rel: string): boolean {
  try {
    return fs.statSync(safePath(dataDir, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * The dependency rows a page's text declares. Reads only: one query, and a
 * file read for each cited file the index does not hold yet. Pure preparation,
 * run before the page's scope transaction.
 */
export async function planCitationDeps(q: Queryable, dataDir: string, text: string): Promise<CitationDepsPlan> {
  const candidates = citedPathCandidates(text);
  const plan: CitationDepsPlan = { deps: [], commits: {}, unresolved: [] };
  if (candidates.length === 0) return plan;
  const options = candidates.map(spellings);
  const all = [...new Set(options.flat())];
  const indexed = new Map(
    (await q.query<{ path: string; sha256: string }>(
      `SELECT path, sha256 FROM documents WHERE path = ANY($1::text[]) AND status <> 'disposed' AND sha256 IS NOT NULL`,
      [all],
    )).map((r) => [r.path, r.sha256]),
  );
  const seen = new Set<string>();
  const repos = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    let file: string | null = null;
    let sha: string | null = null;
    for (const s of options[i]) {
      const known = indexed.get(s);
      if (known) {
        file = s;
        sha = known;
        break;
      }
    }
    if (!file) {
      for (const s of options[i]) {
        if (!isFile(dataDir, s)) continue;
        const loaded = loadSourceText(dataDir, s, rootOf(s));
        if (loaded) {
          file = s;
          sha = sha256(loaded.text);
        }
        break;
      }
    }
    if (!file || !sha) {
      plan.unresolved.push(candidates[i]);
      continue;
    }
    if (isRepositoryCard(file) || seen.has(file)) continue;
    seen.add(file);
    plan.deps.push({ kind: 'document', id: file, required: false, sha });
    const repo = repositoryOf(file);
    if (repo) repos.add(repo);
  }
  for (const repo of [...repos].sort()) {
    const commit = mirrorCommit(dataDir, repo);
    if (commit) plan.commits[repo] = commit;
  }
  return plan;
}

/**
 * A page re-applied with the same text (`sync --reapply`, a new embedding
 * model, a version bump of these rules or of the citation rows) has been
 * checked against nothing new, so it keeps its baseline. For each file it
 * still cites, the hash recorded before stays, and so do the commits it was
 * applied against. `since` is when the page's text last changed, which is
 * what the audit counts repository updates from: the previous scope's own
 * `citedSince`, else that scope's `applied_at`. Only a page whose text
 * changed takes a new baseline (the caller does not call this then).
 */
export function carryCitationBaseline(
  plan: CitationDepsPlan,
  prev: { input_kind: string; input_id: string; input_sha: string | null }[],
  live: { meta: Record<string, unknown>; applied_at: string | Date },
): CitationDepsPlan & { since: string } {
  const before = new Map(prev.filter((d) => d.input_kind === 'document' && d.input_sha).map((d) => [d.input_id, d.input_sha!]));
  const recorded = live.meta.citedCommits && typeof live.meta.citedCommits === 'object' ? (live.meta.citedCommits as Record<string, string>) : {};
  const commits: Record<string, string> = {};
  for (const repo of Object.keys(plan.commits)) commits[repo] = recorded[repo] ?? plan.commits[repo];
  const since = typeof live.meta.citedSince === 'string' ? live.meta.citedSince : new Date(live.applied_at).toISOString();
  return {
    ...plan,
    deps: plan.deps.map((d) => ({ ...d, sha: before.get(d.id) ?? d.sha })),
    commits,
    since,
  };
}
