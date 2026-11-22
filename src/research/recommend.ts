import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { safePath } from '../fs/files.js';
import { coOccurringEntities } from '../graph/cooccur.js';
import { writeDeps } from '../lineage/deps.js';
import { parseFrontmatter } from '../markdown.js';
import { queryTerms } from '../search/search.js';
import { toIso } from '../store/temporal.js';
import { hotEntities } from '../wiki/pages.js';
import { detectCommunities } from '../wiki/refine.js';
import { citationPayloadOf, wikiSuggestionId } from './cited-refresh.js';
import { listJobs, queueJob } from './jobs.js';
import { ResearchKind, researchSlug } from './templates.js';

/**
 * Which pages are worth an agent's time. Signals, each normalized to 0..1
 * over the candidate set and weighted:
 *
 *   mentions + heat      what the corpus and retrieval keep touching (hotEntities)
 *   demand               what agents asked about (receipts.entities, last N days)
 *   degree               hubs of the graph
 *   trouble              open disputes, superseded / expired facts — pages that need an editor
 *   page state           no page at all (or only a generated stub) > a fresh research page;
 *                        a research page older than the newest evidence about its subject
 *                        becomes a *refresh* candidate instead
 *
 * Plus two non-entity kinds: hot communities without a concept page, and
 * questions agents keep asking (recurring receipts.query) without an answer
 * page. Recommendations are filed as `wiki` suggestions so a person accepts
 * them into jobs — or `research.auto` accepts the top few per day.
 */

export interface Recommendation {
  kind: ResearchKind;
  target: string;
  score: number;
  reasons: string[];
  entityId?: string;
  pagePath?: string | null;
  suggestionId?: string;
}

export interface RecommendOptions {
  limit?: number;
  lookbackDays?: number;
}

export { wikiSuggestionId };

function norm(v: number, max: number): number {
  return max > 0 ? Math.min(1, v / max) : 0;
}

interface PageState {
  kind: 'none' | 'stub' | 'human' | 'research';
  path: string | null;
  researchAt: string | null;
}

async function pageStateFor(ctx: AppContext, wikiPath: string | null): Promise<PageState> {
  if (!wikiPath) return { kind: 'none', path: null, researchAt: null };
  let text: string;
  try {
    text = fs.readFileSync(safePath(ctx.dataDir, wikiPath), 'utf8');
  } catch {
    return { kind: 'none', path: null, researchAt: null };
  }
  const [view] = await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE path = $1 AND tx_to IS NULL`, [wikiPath]);
  if (view) return { kind: 'stub', path: wikiPath, researchAt: null };
  const fm = parseFrontmatter(text).frontmatter;
  const research = fm.research && typeof fm.research === 'object' ? (fm.research as Record<string, unknown>) : null;
  if (typeof fm.actor === 'string' && /^agent\b/i.test(fm.actor) && research) {
    return { kind: 'research', path: wikiPath, researchAt: toIso(typeof research.at === 'string' ? research.at : null) };
  }
  return { kind: 'human', path: wikiPath, researchAt: null };
}

export async function recommendWikiTopics(ctx: AppContext, opts: RecommendOptions = {}): Promise<Recommendation[]> {
  const { store } = ctx;
  const limit = opts.limit ?? 20;
  const since = new Date(Date.now() - (opts.lookbackDays ?? 30) * 24 * 3600 * 1000).toISOString();
  const out: Recommendation[] = [];

  const open = new Set((await listJobs(store, { status: ['queued', 'running', 'validating'], limit: 500 })).map((j) => `${j.kind}|${j.target ?? j.query ?? ''}`));
  const push = (r: Recommendation) => {
    if (open.has(`${r.kind}|${r.target}`)) return;
    out.push(r);
  };

  /* ---- entities ---- */
  const hot = await hotEntities(store, 80);
  if (hot.length > 0) {
    const ids = hot.map((e) => e.id);
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const demandRows = await store.query<{ entity_id: string; n: number }>(
      `SELECT elem AS entity_id, count(*)::int AS n FROM receipts r, jsonb_array_elements_text(r.entities) elem
       WHERE r.created_at >= $${ids.length + 1}::timestamptz AND elem IN (${ph}) GROUP BY elem`,
      [...ids, since],
    );
    const degreeRows = await store.query<{ id: string; n: number }>(
      `SELECT e.id, count(r.id)::int AS n FROM entities e
       LEFT JOIN relations r ON (r.source_id = e.id OR r.target_id = e.id) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
       WHERE e.id IN (${ph}) GROUP BY e.id`,
      ids,
    );
    const disputeRows = await store.query<{ subject_id: string; n: number }>(
      `SELECT c.subject_id, count(*)::int AS n FROM disputes d JOIN claims c ON c.id = d.claim_id
       WHERE d.status = 'open' AND c.subject_id IN (${ph}) GROUP BY c.subject_id`,
      ids,
    );
    const troubleRows = await store.query<{ subject_id: string; n: number }>(
      `SELECT subject_id, count(*)::int AS n FROM claims
       WHERE tx_to IS NULL AND canonical_id IS NULL AND subject_id IN (${ph}) AND (superseded_by IS NOT NULL OR (valid_to IS NOT NULL AND valid_to < now()))
       GROUP BY subject_id`,
      ids,
    );
    const latestRows = await store.query<{ id: string; at: string | Date | null }>(
      `SELECT e.id, GREATEST(
          (SELECT max(tx_from) FROM claims c WHERE c.subject_id = e.id AND c.tx_to IS NULL),
          (SELECT max(tx_from) FROM relations r WHERE (r.source_id = e.id OR r.target_id = e.id) AND r.tx_to IS NULL)
        ) AS at
       FROM entities e WHERE e.id IN (${ph})`,
      ids,
    );
    const wikiRows = await store.query<{ id: string; wiki_path: string | null }>(`SELECT id, wiki_path FROM entities WHERE id IN (${ph})`, ids);
    const demand = new Map(demandRows.map((r) => [r.entity_id, r.n]));
    const degree = new Map(degreeRows.map((r) => [r.id, r.n]));
    const disputes = new Map(disputeRows.map((r) => [r.subject_id, r.n]));
    const trouble = new Map(troubleRows.map((r) => [r.subject_id, r.n]));
    const latest = new Map(latestRows.map((r) => [r.id, toIso(r.at)]));
    const wiki = new Map(wikiRows.map((r) => [r.id, r.wiki_path]));
    const maxMention = Math.max(...hot.map((e) => e.mention_count), 1);
    const maxHeat = Math.max(...hot.map((e) => e.heat), 0);
    const maxDemand = Math.max(...demand.values(), 0);
    const maxDegree = Math.max(...degree.values(), 0);

    for (const e of hot) {
      if (e.type === 'concept' && e.name.length < 4) continue; // tier-0 fragments are not topics
      const reasons: string[] = [];
      let score = 0;
      const m = norm(Math.log1p(e.mention_count), Math.log1p(maxMention));
      score += 0.3 * m;
      if (e.mention_count >= 3) reasons.push(`${e.mention_count} 次提及`);
      if (maxHeat > 0 && e.heat > 0) {
        score += 0.2 * norm(e.heat, maxHeat);
        reasons.push(`检索热度 ${e.heat.toFixed(2)}`);
      }
      const d = demand.get(e.id) ?? 0;
      if (d > 0) {
        score += 0.25 * norm(d, maxDemand);
        reasons.push(`近期被 agent 问到 ${d} 次`);
      }
      const deg = degree.get(e.id) ?? 0;
      if (deg > 0) {
        score += 0.1 * norm(deg, maxDegree);
        if (deg >= 3) reasons.push(`图中 ${deg} 条关系`);
      }
      const dis = disputes.get(e.id) ?? 0;
      if (dis > 0) {
        score += 0.15;
        reasons.push(`${dis} 条未解决的矛盾`);
      }
      const tr = trouble.get(e.id) ?? 0;
      if (tr > 0) {
        score += 0.1;
        reasons.push(`${tr} 条已过期或被替代的事实`);
      }
      const state = await pageStateFor(ctx, wiki.get(e.id) ?? null);
      if (state.kind === 'none') {
        score += 0.25;
        reasons.push('还没有页面');
        push({ kind: 'entity', target: e.name, score, reasons, entityId: e.id, pagePath: null });
      } else if (state.kind === 'stub') {
        score += 0.15;
        reasons.push('只有自动生成的存根页');
        push({ kind: 'entity', target: e.name, score, reasons, entityId: e.id, pagePath: state.path });
      } else if (state.kind === 'research') {
        const newest = latest.get(e.id);
        if (newest && state.researchAt && newest > state.researchAt) {
          score += 0.2;
          reasons.push(`页面写于 ${state.researchAt.slice(0, 10)}，之后有新证据（${newest.slice(0, 10)}）`);
          push({ kind: 'refresh', target: state.path!, score, reasons, entityId: e.id, pagePath: state.path });
        }
      }
      // human pages are left alone: the person who wrote them decides when to refresh
    }

    /* ---- concept communities ---- */
    // typed edges plus the co-occurrence derived among the hot entities (the
    // bulk of what used to be stored co_occurs rows, which readers now ignore)
    const rels = await store.query<{ source_id: string; target_id: string; weight: number }>(
      `SELECT source_id, target_id, weight FROM relations WHERE source_id IN (${ph}) AND target_id IN (${ph}) AND type <> 'co_occurs' AND tx_to IS NULL`,
      ids,
    );
    const links = rels.map((r) => ({ source: r.source_id, target: r.target_id, weight: r.weight }));
    const seenPair = new Set<string>();
    for (const x of await coOccurringEntities(store, ids, { among: ids, maxDocuments: 50 })) {
      const [a, b] = x.source < x.target ? [x.source, x.target] : [x.target, x.source];
      if (seenPair.has(`${a}|${b}`)) continue;
      seenPair.add(`${a}|${b}`);
      links.push({ source: a, target: b, weight: x.weight });
    }
    const byId = new Map(hot.map((e) => [e.id, e]));
    const groups = [...detectCommunities(ids, links).values()]
      .filter((g) => g.length >= 4)
      .sort((a, b) => b.length - a.length)
      .slice(0, 5);
    for (const group of groups) {
      const members = group.map((id) => byId.get(id)!).sort((a, b) => b.mention_count - a.mention_count);
      const anchor = members[0];
      const pagePath = `wiki/concepts/${researchSlug(anchor.name)}.md`;
      let exists = false;
      try {
        exists = fs.existsSync(safePath(ctx.dataDir, pagePath));
      } catch {
        exists = false;
      }
      if (exists) continue;
      push({
        kind: 'concept',
        target: anchor.name,
        score: 0.3 + 0.1 * Math.min(5, members.length - 3) / 5,
        reasons: [`${members.length} 个相关实体形成一个热点簇（${members.slice(0, 4).map((m) => m.name).join('、')}…）`, '没有综述页'],
        entityId: anchor.id,
        pagePath: null,
      });
    }
  }

  /* ---- recurring questions ---- */
  const receipts = await store.query<{ query: string; gaps: unknown; created_at: string | Date }>(
    `SELECT query, gaps, created_at FROM receipts WHERE created_at >= $1::timestamptz AND kind = 'resolve' ORDER BY created_at DESC LIMIT 500`,
    [since],
  );
  const clusters = new Map<string, { count: number; latest: string; gaps: number }>();
  for (const r of receipts) {
    const q = r.query.trim();
    if (q.length < 6) continue;
    const key = queryTerms(q, 8).sort().join(' ');
    if (!key) continue;
    const cur = clusters.get(key) ?? { count: 0, latest: q, gaps: 0 };
    cur.count++;
    if (Array.isArray(r.gaps) && r.gaps.length > 0) cur.gaps++;
    clusters.set(key, cur);
  }
  for (const [, c] of clusters) {
    if (c.count < 2 && c.gaps === 0) continue;
    const pagePath = `wiki/questions/${researchSlug(c.latest)}.md`;
    let exists = false;
    try {
      exists = fs.existsSync(safePath(ctx.dataDir, pagePath));
    } catch {
      exists = false;
    }
    if (exists) continue;
    const reasons: string[] = [];
    if (c.count >= 2) reasons.push(`${c.count} 次被问到`);
    if (c.gaps > 0) reasons.push(`${c.gaps} 次本地回答不完整`);
    push({ kind: 'question', target: c.latest, score: 0.25 + 0.1 * Math.min(5, c.count) + 0.1 * Math.min(3, c.gaps), reasons, pagePath: null });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Recompute and file recommendations as `wiki` suggestions (pending until a person accepts, or auto mode does). */
export async function refreshRecommendations(ctx: AppContext, opts: RecommendOptions = {}): Promise<{ recommendations: Recommendation[]; suggested: number }> {
  const recommendations = await recommendWikiTopics(ctx, opts);
  let suggested = 0;
  for (const r of recommendations) {
    const id = wikiSuggestionId(r.kind, r.target);
    r.suggestionId = id;
    const [existing] = await ctx.store.query<{ status: string }>(`SELECT status FROM suggestions WHERE id = $1`, [id]);
    if (existing && (existing.status === 'rejected' || existing.status === 'accepted')) continue;
    const label = r.kind === 'refresh' ? `刷新页面：${path.posix.basename(r.target, '.md')}` : r.kind === 'question' ? `归档问答：${r.target}` : `${r.kind === 'concept' ? '概念综述' : '实体档案'}：${r.target}`;
    await ctx.store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'wiki', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence,
         -- a refresh filed for changed cited files keeps what it carries for the job's brief (src/research/cited-refresh.ts)
         payload = EXCLUDED.payload || CASE WHEN suggestions.payload ? 'citations' THEN jsonb_build_object('citations', suggestions.payload -> 'citations') ELSE '{}'::jsonb END,
         status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
      [
        id, label,
        `建议让研究 agent ${r.kind === 'refresh' ? '刷新' : '撰写'}这一页。依据：${r.reasons.join('；')}。接受后会排入研究队列（research.agent 配置的 CLI 执行），页面以隔离状态入库，审核后可提升为可信。`,
        JSON.stringify(r.reasons),
        JSON.stringify({ kind: r.kind, target: r.target, score: Number(r.score.toFixed(3)), reasons: r.reasons, entityId: r.entityId ?? null, pagePath: r.pagePath ?? null }),
      ],
    );
    if (r.entityId) await writeDeps(ctx.store, { kind: 'suggestion', id }, [{ kind: 'entity', id: r.entityId, required: true }]);
    suggested++;
  }
  return { recommendations, suggested };
}

/** Accepting a `wiki` suggestion queues the job it describes. */
export async function queueFromSuggestion(ctx: AppContext, payload: Record<string, unknown> | null | undefined, requestedBy = 'suggestion') {
  const kind = typeof payload?.kind === 'string' ? (payload.kind as ResearchKind) : 'entity';
  const target = typeof payload?.target === 'string' ? payload.target : '';
  if (!target) throw new Error('wiki suggestion has no target');
  // a refresh filed because cited files changed carries them into the job's brief (src/research/workspace.ts)
  const citations = kind === 'refresh' ? citationPayloadOf(payload) : null;
  return queueJob(ctx.store, kind === 'question' ? { kind, query: target, requestedBy } : { kind, target, requestedBy, ...(citations ? { payload: { citations } } : {}) });
}

/** Auto mode: accept the best pending recommendations, at most `dailyJobs` per day. */
export async function autoAcceptRecommendations(ctx: AppContext, dailyJobs: number): Promise<number> {
  const [row] = await ctx.store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM research_jobs WHERE requested_by = 'auto' AND created_at >= date_trunc('day', now())`,
  );
  let budget = Math.max(0, dailyJobs - (row?.n ?? 0));
  if (budget === 0) return 0;
  const pending = await ctx.store.query<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id, payload FROM suggestions WHERE kind = 'wiki' AND status = 'pending' ORDER BY (payload ->> 'score')::float DESC NULLS LAST LIMIT $1`,
    [budget],
  );
  let queued = 0;
  for (const s of pending) {
    try {
      const { created } = await queueFromSuggestion(ctx, s.payload, 'auto');
      await ctx.store.query(`UPDATE suggestions SET status = 'accepted' WHERE id = $1`, [s.id]);
      if (created) {
        queued++;
        budget--;
      }
    } catch {
      /* a malformed suggestion is skipped */
    }
    if (budget <= 0) break;
  }
  return queued;
}
