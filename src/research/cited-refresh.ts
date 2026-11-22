import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha16 } from '../digest.js';
import { safePath } from '../fs/files.js';
import { CODEBASE_CARDS } from '../fs/layout.js';
import { writeDeps } from '../lineage/deps.js';
import { mirrorCommit, repositoryOf } from '../lineage/page-deps.js';
import { parseFrontmatter } from '../markdown.js';
import { Store } from '../store/db.js';

/**
 * A changed cited file files a refresh suggestion (docs/design/37 §5, D5).
 *
 * An agent's page depends on the files it cites (src/lineage/page-deps.ts:
 * one `deps` row per cited document, with the hash it had when the page was
 * applied). No generator owns such a page — it has no `pages` row — so
 * `propagate` marks nothing when a cited document changes and
 * `reconcileViews` never sees it: it is neither re-rendered nor archived, and
 * must not be, because its prose is an agent's and has to be re-verified by
 * one. What this module does instead, after a sync, is compare each page's
 * recorded hashes with the documents the index holds now, and file one
 * `refresh` suggestion per page that differs: the same suggestion id the
 * entity signals of src/research/recommend.ts use, so a page gets one
 * suggestion however many of its files changed and whichever signal came
 * first. Comparing instead of listening to `propagate` is what makes the
 * count right: a repository update re-indexes each changed file in its own
 * transaction, and only once the sync is over is "3 of 14 changed" known.
 *
 * The audit: a page that cites a repository and whose text has not changed for
 * `research.auditAfterUpdates` new versions of that repository's card gets a
 * suggestion even if none of its own files changed, and its brief asks for
 * the entry points to be listed again from scratch.
 *
 * Reads, then plain writes on `suggestions` and `deps` — no ledger lock, no network.
 */

export function wikiSuggestionId(kind: string, target: string): string {
  return crypto.createHash('sha256').update(`wiki|${kind}|${target}`).digest('hex').slice(0, 16);
}

export interface RepositoryChange {
  name: string;
  /** The commit the page was checked against: its `repositories` frontmatter, else the mirror's commit when the page was applied. */
  from: string | null;
  /** The commit the mirror holds now. */
  to: string | null;
  cited: number;
  changed: number;
  removed: number;
}

export interface CitationChange {
  page: string;
  /** Documents the page depends on through its citations. */
  cited: number;
  changed: string[];
  removed: string[];
  repositories: RepositoryChange[];
  /** Set when the audit is due: the repository updated most often since the page was written. */
  audit: { repository: string; updates: number } | null;
  /** Identifies this state of the page's sources, so a person's reject is not undone by the next sync. */
  fingerprint: string;
}

interface DepState {
  page: string;
  path: string;
  input_sha: string | null;
  sha256: string | null;
  status: string | null;
}

/** SQL for `matchesPrefixes` over `col`: one `starts_with` per prefix (a scoped sync names a few), each bound in `params`. */
// A prefix that names a file (a watcher event, mostly) is matched by equality alone, which the indexes serve
// (deps_input_idx for an input, deps_pkey for a page); only a folder needs starts_with, a filter on the cites range.
function underPrefixes(col: string, prefixes: string[], params: unknown[], dataDir: string): string {
  params.push(prefixes);
  const exact = `${col} = ANY($${params.length}::text[])`;
  const below = prefixes.filter((p) => isFolderPrefix(dataDir, p)).map((p) => {
    params.push(`${p}/`);
    return `starts_with(${col}, $${params.length})`;
  });
  return `(${[exact, ...below].join(' OR ')})`;
}

/** A folder on disk, or a path whose last part has no extension (a folder already removed): anything else is a file. */
function isFolderPrefix(dataDir: string, prefix: string): boolean {
  try {
    return fs.statSync(safePath(dataDir, prefix)).isDirectory();
  } catch {
    return !/\.[A-Za-z0-9]{1,8}$/.test(prefix);
  }
}

/**
 * A page's citation deps, joined to the documents they name. `artifact_kind = 'cites'` is the leading primary-key
 * column, so this reads only citation rows, never the generated pages' inputs (an index range scan, then one
 * `documents_path_idx` probe per row). Whether a page has become a view since is checked afterwards, for the few
 * pages that differ, not with an anti-join over every `pages` row.
 */
const DEP_STATE_SQL = `
  SELECT dp.artifact_id AS page, dp.input_id AS path, dp.input_sha, d.sha256, d.status
  FROM deps dp
  LEFT JOIN documents d ON d.path = dp.input_id
  WHERE dp.artifact_kind = 'cites' AND dp.input_kind = 'document'`;

const DIFFERS = `(d.path IS NULL OR d.status = 'disposed' OR d.sha256 IS DISTINCT FROM dp.input_sha)`;

export interface CitationChangeOptions {
  /** Only these pages. */
  pages?: string[];
  /** Only pages that cite something under these prefixes, or lie under them (a scoped sync). */
  prefixes?: string[];
  /** Repository updates after which the audit is due; 0 or unset = no audit. */
  auditAfter?: number;
}

/** The pages whose cited files changed or went since they were applied, and those the audit is due for. */
export async function citationChanges(store: Store, dataDir: string, opts: CitationChangeOptions = {}): Promise<CitationChange[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (opts.pages) {
    params.push(opts.pages);
    conds.push(`dp.artifact_id = ANY($${params.length}::text[])`);
  }
  if (opts.prefixes) {
    conds.push(`(${underPrefixes('dp.input_id', opts.prefixes, params, dataDir)} OR ${underPrefixes('dp.artifact_id', opts.prefixes, params, dataDir)})`);
  }
  const where = conds.length ? ` AND ${conds.join(' AND ')}` : '';
  const touched = new Set(
    (await store.query<{ page: string }>(`SELECT DISTINCT page FROM (${DEP_STATE_SQL} AND ${DIFFERS}${where}) x`, params)).map((r) => r.page),
  );

  // the audit is due where a cited repository's card has had `auditAfter` new versions since the page's own apply
  const audits = new Map<string, { repository: string; updates: number }>();
  const auditAfter = opts.auditAfter ?? 0;
  // a repository update is a new card: a scoped sync that touched no card cannot have made an audit due
  const auditScoped = !opts.prefixes || opts.prefixes.some((p) => `${CODEBASE_CARDS}/`.startsWith(`${p}/`) || p.startsWith(`${CODEBASE_CARDS}/`));
  if (auditAfter > 0 && auditScoped) {
    const ap: unknown[] = [auditAfter];
    let pageCond = '';
    if (opts.pages) {
      ap.push(opts.pages);
      pageCond = ` AND dp.artifact_id = ANY($${ap.length}::text[])`;
    }
    const rows = await store.query<{ page: string; repo: string; updates: number }>(
      `WITH cited AS (
         SELECT DISTINCT dp.artifact_id AS page, split_part(substr(dp.input_id, 14), '/', 1) AS repo
         FROM deps dp
         WHERE dp.artifact_kind = 'cites' AND dp.input_kind = 'document' AND starts_with(dp.input_id, 'raw/codebase/')${pageCond}
       )
       , since AS (
         SELECT c.page, c.repo, COALESCE((ps.meta->>'citedSince')::timestamptz, ps.applied_at) AS at
         FROM cited c
         JOIN scopes ps ON ps.kind = 'doc' AND ps.key = c.page AND ps.status = 'active' AND ps.parent_id IS NULL
       )
       -- a card version counts once, and only when it is new: a re-apply of a version the card already had then is no update
       SELECT s.page, s.repo, count(DISTINCT cs.sha)::int AS updates
       FROM since s
       JOIN scopes cs ON cs.kind = 'doc' AND cs.parent_id IS NULL AND cs.key = '${CODEBASE_CARDS}/' || s.repo || '.md' AND cs.applied_at > s.at
       WHERE NOT EXISTS (SELECT 1 FROM scopes old WHERE old.kind = 'doc' AND old.parent_id IS NULL AND old.key = cs.key AND old.sha = cs.sha AND old.applied_at <= s.at)
       GROUP BY s.page, s.repo
       HAVING count(DISTINCT cs.sha) >= $1`,
      ap,
    );
    for (const r of rows) {
      const cur = audits.get(r.page);
      if (!cur || r.updates > cur.updates) audits.set(r.page, { repository: r.repo, updates: r.updates });
      touched.add(r.page);
    }
  }
  if (touched.size === 0) return [];
  // a page that has become a view (a live pages row) belongs to its generator now
  for (const r of await store.query<{ path: string }>(`SELECT path FROM pages WHERE path = ANY($1::text[]) AND tx_to IS NULL`, [[...touched]])) {
    touched.delete(r.path);
  }
  if (touched.size === 0) return [];

  const pages = [...touched].sort();
  const states = await store.query<DepState>(`${DEP_STATE_SQL} AND dp.artifact_id = ANY($1::text[]) ORDER BY dp.artifact_id, dp.input_id`, [pages]);
  const scopes = new Map(
    (await store.query<{ key: string; id: string; meta: Record<string, unknown>; applied_at: string | Date }>(
      `SELECT key, id, meta, applied_at FROM scopes WHERE kind = 'doc' AND key = ANY($1::text[]) AND status = 'active' AND parent_id IS NULL`,
      [pages],
    )).map((r) => [r.key, r]),
  );
  const byPage = new Map<string, DepState[]>();
  for (const s of states) {
    const list = byPage.get(s.page) ?? [];
    list.push(s);
    byPage.set(s.page, list);
  }
  const mirrors = new Map<string, string | null>();
  const mirror = (repo: string) => {
    if (!mirrors.has(repo)) mirrors.set(repo, mirrorCommit(dataDir, repo));
    return mirrors.get(repo)!;
  };

  const out: CitationChange[] = [];
  for (const page of pages) {
    const deps = byPage.get(page) ?? [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const d of deps) {
      if (d.status === 'disposed') removed.push(d.path);
      else if (d.status === null) {
        // never indexed: it went if its file did, else the index has not caught up and there is nothing to say
        if (!fileExists(dataDir, d.path)) removed.push(d.path);
      } else if (d.sha256 !== d.input_sha) changed.push(d.path);
    }
    const audit = audits.get(page) ?? null;
    if (changed.length === 0 && removed.length === 0 && !audit) continue;
    const scope = scopes.get(page);
    const recorded = (scope?.meta.citedCommits ?? {}) as Record<string, string>;
    const declared = declaredCommits(dataDir, page);
    const repos = new Map<string, RepositoryChange>();
    for (const d of deps) {
      const name = repositoryOf(d.path);
      if (!name) continue;
      const r = repos.get(name) ?? { name, from: declared[name] ?? recorded[name] ?? null, to: mirror(name), cited: 0, changed: 0, removed: 0 };
      r.cited++;
      if (changed.includes(d.path)) r.changed++;
      if (removed.includes(d.path)) r.removed++;
      repos.set(name, r);
    }
    const repositories = [...repos.values()].filter((r) => r.changed || r.removed || r.name === audit?.repository);
    const current = new Map(deps.map((d) => [d.path, d.sha256]));
    out.push({
      page,
      cited: deps.length,
      changed,
      removed,
      repositories,
      audit,
      fingerprint: sha16({ changed: changed.map((p) => [p, current.get(p)]), removed, audit: audit ? textSince(scope) ?? page : null }),
    });
  }
  return out;
}

/** When the page's text last changed: a re-apply of the same text keeps it (src/lineage/page-deps.ts carryCitationBaseline). */
function textSince(scope: { meta: Record<string, unknown>; applied_at: string | Date } | undefined): string | null {
  if (!scope) return null;
  return typeof scope.meta.citedSince === 'string' ? scope.meta.citedSince : new Date(scope.applied_at).toISOString();
}

function fileExists(dataDir: string, rel: string): boolean {
  try {
    return fs.existsSync(safePath(dataDir, rel));
  } catch {
    return false;
  }
}

/** `repositories: [{ name, commit }]` from a behaviour page's frontmatter (docs/design/37 §4). */
function declaredCommits(dataDir: string, page: string): Record<string, string> {
  const fm = pageFrontmatter(dataDir, page);
  const out: Record<string, string> = {};
  if (Array.isArray(fm?.repositories)) {
    for (const r of fm.repositories) {
      if (r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string' && (r as { commit?: unknown }).commit !== undefined) {
        out[(r as { name: string }).name] = String((r as { commit: unknown }).commit);
      }
    }
  }
  return out;
}

function pageFrontmatter(dataDir: string, page: string): Record<string, unknown> | null {
  try {
    return parseFrontmatter(fs.readFileSync(safePath(dataDir, page), 'utf8')).frontmatter;
  } catch {
    return null;
  }
}

function isAgentPage(fm: Record<string, unknown> | null): boolean {
  return typeof fm?.actor === 'string' && /^agent\b/i.test(fm.actor);
}

const short = (commit: string | null) => (commit ? commit.slice(0, 7) : '?');

/** Why the page needs a refresh, the strongest reason first. */
export function citationReasons(c: CitationChange): string[] {
  const removed: string[] = [];
  const changed: string[] = [];
  const between = (r: RepositoryChange) => (r.from && r.to && r.from !== r.to ? `在 ${short(r.from)} 与 ${short(r.to)} 之间` : r.to ? `（镜像现在是 ${short(r.to)}）` : '');
  for (const r of c.repositories) {
    if (r.removed) removed.push(`${r.name}：引用的 ${r.cited} 个文件中 ${r.removed} 个${between(r)}被删除，页面可能在描述已经不存在的代码`);
    if (r.changed) changed.push(`${r.name}：引用的 ${r.cited} 个文件中 ${r.changed} 个${between(r)}改变`);
  }
  const docs = c.cited - c.repositories.reduce((n, r) => n + r.cited, 0);
  const docsRemoved = c.removed.filter((p) => !repositoryOf(p)).length;
  const docsChanged = c.changed.filter((p) => !repositoryOf(p)).length;
  if (docsRemoved) removed.push(`引用的 ${docs} 份文档中 ${docsRemoved} 份已被删除`);
  if (docsChanged) changed.push(`引用的 ${docs} 份文档中 ${docsChanged} 份已改变`);
  const out = [...removed, ...changed];
  if (c.audit) out.push(`${c.audit.repository} 自本页写成后更新了 ${c.audit.updates} 次，本页一直没有刷新：从头重列入口`);
  return out;
}

function citationScore(c: CitationChange): number {
  const share = c.cited ? Math.min(1, (c.changed.length + c.removed.length) / c.cited) : 0;
  return Number((0.45 + 0.35 * share + (c.removed.length ? 0.15 : 0) + (c.audit && !share ? -0.05 : 0)).toFixed(3));
}

/** What a refresh job's payload carries about its page's cited files. */
export interface CitationPayload {
  cited: number;
  changed: string[];
  removed: string[];
  repositories: RepositoryChange[];
  audit: { repository: string; updates: number } | null;
  fingerprint: string;
}

function payloadOf(c: CitationChange): CitationPayload {
  return { cited: c.cited, changed: c.changed, removed: c.removed, repositories: c.repositories, audit: c.audit, fingerprint: c.fingerprint };
}

export interface CitationRefreshStats {
  /** Suggestion ids filed or brought up to date. */
  filed: string[];
  /** Pages with changed sources that got nothing: a person's page, an open job, the same state already decided. */
  skipped: number;
  /** Pending citation-only suggestions whose page is up to date again (rewritten since), now stale. */
  retired: string[];
}

/**
 * File (or bring up to date) the refresh suggestions of the pages whose cited
 * files changed — after a sync, scoped by its prefixes. Only an agent's page
 * gets one: a person decides when their own page is refreshed, as
 * src/research/recommend.ts already has it. A page with a refresh job still
 * open, or whose suggestion a person already accepted or rejected in this very
 * state, is left alone.
 */
export async function fileCitationRefreshes(
  ctx: { store: Store; dataDir: string; config: { research: { auditAfterUpdates?: number } } },
  opts: { prefixes?: string[]; pages?: string[] } = {},
): Promise<CitationRefreshStats> {
  const { store, dataDir } = ctx;
  const stats: CitationRefreshStats = { filed: [], skipped: 0, retired: [] };
  const changes = await citationChanges(store, dataDir, { prefixes: opts.prefixes, pages: opts.pages, auditAfter: ctx.config.research.auditAfterUpdates ?? 0 });
  const open = changes.length === 0 ? new Set<string>() : new Set(
    (await store.query<{ page: string }>(
      `SELECT COALESCE(output_path, target) AS page FROM research_jobs
       WHERE status IN ('queued', 'running', 'validating') AND (kind = 'refresh' OR output_path IS NOT NULL)`,
    )).map((r) => r.page),
  );
  const seen = new Set<string>();
  for (const c of changes) {
    seen.add(c.page);
    if (!isAgentPage(pageFrontmatter(dataDir, c.page)) || open.has(c.page)) {
      stats.skipped++;
      continue;
    }
    const id = wikiSuggestionId('refresh', c.page);
    const [existing] = await store.query<{ status: string; payload: Record<string, unknown> | null }>(`SELECT status, payload FROM suggestions WHERE id = $1`, [id]);
    const decided = existing && (existing.status === 'accepted' || existing.status === 'rejected');
    if (decided && (existing.payload?.citations as CitationPayload | undefined)?.fingerprint === c.fingerprint) {
      stats.skipped++;
      continue;
    }
    const reasons = citationReasons(c);
    const payload = {
      kind: 'refresh', target: c.page, score: citationScore(c), reasons, pagePath: c.page,
      entityId: typeof existing?.payload?.entityId === 'string' ? existing.payload.entityId : null,
      citations: payloadOf(c),
    };
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'wiki', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence,
         payload = COALESCE(suggestions.payload, '{}'::jsonb) || EXCLUDED.payload, status = 'pending'`,
      [
        id, `刷新页面：${path.posix.basename(c.page, '.md')}`,
        `建议让研究 agent 刷新这一页。依据：${reasons.join('；')}。接受后会排入研究队列，任务只重新核对引用了变化文件的陈述${c.audit ? '，并从头重列入口' : ''}；页面以隔离状态入库，审核后可提升为可信。`,
        JSON.stringify([...c.removed, ...c.changed].slice(0, 50).map((p) => ({ kind: 'document', path: p }))),
        JSON.stringify(payload),
      ],
    );
    // a page removed meanwhile takes its suggestion with it (propagate marks it stale)
    await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'document', id: c.page, required: true }]);
    stats.filed.push(id);
  }

  // a pending citation suggestion whose page was rewritten since (by a refresh, a person, another job) is moot
  const pending = await store.query<{ id: string; page: string; entity: string | null }>(
    `SELECT id, payload->>'target' AS page, payload->>'entityId' AS entity FROM suggestions
     WHERE kind = 'wiki' AND status = 'pending' AND payload ? 'citations' AND payload->>'kind' = 'refresh'`,
  );
  const recheck = pending.filter((s) => !seen.has(s.page) && (!opts.pages || opts.pages.includes(s.page)));
  if (recheck.length) {
    const still = new Set((await citationChanges(store, dataDir, { pages: recheck.map((s) => s.page), auditAfter: ctx.config.research.auditAfterUpdates ?? 0 })).map((c) => c.page));
    for (const s of recheck) {
      if (still.has(s.page)) continue;
      if (s.entity) await store.query(`UPDATE suggestions SET payload = payload - 'citations' WHERE id = $1`, [s.id]);
      else await store.query(`UPDATE suggestions SET status = 'stale' WHERE id = $1 AND status = 'pending'`, [s.id]);
      stats.retired.push(s.id);
    }
  }
  return stats;
}

/** Read a job payload's citation part back, or null. */
export function citationPayloadOf(payload: Record<string, unknown> | null | undefined): CitationPayload | null {
  const c = payload?.citations;
  if (!c || typeof c !== 'object') return null;
  const p = c as Partial<CitationPayload>;
  return {
    cited: Number(p.cited) || 0,
    changed: Array.isArray(p.changed) ? p.changed.map(String) : [],
    removed: Array.isArray(p.removed) ? p.removed.map(String) : [],
    repositories: Array.isArray(p.repositories) ? (p.repositories as RepositoryChange[]) : [],
    audit: p.audit && typeof p.audit === 'object' ? p.audit : null,
    fingerprint: typeof p.fingerprint === 'string' ? p.fingerprint : '',
  };
}

/**
 * The brief section of a refresh job about its page's cited files: what
 * changed, what went, which commits, and what to do about each. Empty when
 * nothing the page cites changed and no audit is due.
 */
export function citationBrief(c: CitationPayload | null): string[] {
  if (!c || (c.changed.length === 0 && c.removed.length === 0 && !c.audit)) return [];
  const lines: string[] = ['## 引用的文件已变化（本次刷新的范围）', ''];
  const n = c.changed.length + c.removed.length;
  if (n) lines.push(`本页上次写成后，它引用的 ${c.cited} 个文件中有 ${c.changed.length} 个改变${c.removed.length ? `、${c.removed.length} 个被删除` : ''}。`, '');
  for (const r of c.repositories) {
    lines.push(`- 仓库 \`${r.name}\`：本页核对于 \`${r.from ?? '（未记录）'}\`，镜像现在是 \`${r.to ?? '（未知）'}\`（见 \`${CODEBASE_CARDS}/${r.name}.md\`）；引用 ${r.cited} 个文件，${r.changed} 个改变，${r.removed} 个删除`);
  }
  if (c.repositories.length) lines.push('');
  const list = (title: string, paths: string[]) => {
    if (!paths.length) return;
    lines.push(title, '', ...paths.slice(0, 200).map((p) => `- \`${p}\``), ...(paths.length > 200 ? [`- …另 ${paths.length - 200} 个`] : []), '');
  };
  list('### 改变的文件', c.changed);
  list('### 已删除的文件', c.removed);
  lines.push(
    '### 怎么做',
    '',
    '1. 只重新核对**引用了上面这些文件**的陈述：用 `knode_read` 读文件的当前版本，按现在的内容改正说法与行号范围；不必重新研究其他内容，其余段落原样保留。',
    '2. 引用了已删除文件的陈述：在仓库里找到它现在的位置（`knode_grep` / `knode_search` kinds=["code"]）并改引新路径；找不到就把这条陈述移到"未核实"或"争议与缺口"，不要留着旧引用。',
    '3. frontmatter 有 `repositories: [{ name, commit }]` 时：把你重新核对过的每个仓库的 `commit` 改成上面列出的镜像当前 commit；没有核对的仓库保持原值（它对未改变的文件仍然成立）。没有这个键的页面跳过这一步。',
  );
  if (c.audit) {
    lines.push(
      `4. **审计**：\`${c.audit.repository}\` 自本页写成后已更新 ${c.audit.updates} 次。只沿着已有引用核对，永远发现不了页面漏掉的路径：先不看页面现有的入口清单，从头搜索并列出所有入口（命令、路由、事件、定时任务、配置开关），再与页面对比，补上漏掉的、删去已经不存在的，并重新核对它们的引用。`,
    );
  }
  // one block: the brief drops empty lines between its parts, and these need theirs
  return [lines.join('\n').trimEnd() + '\n'];
}
