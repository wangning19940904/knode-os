import crypto from 'node:crypto';
import { applyClaimMerge } from '../graph/claim-merge.js';
import { applyMerge } from '../graph/merge.js';
import { queueJob } from '../research/jobs.js';
import { ResearchKind } from '../research/templates.js';
import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { assertWritablePath, writeFileText } from '../fs/files.js';
import { LlmClient } from '../llm/client.js';
import { readMatter, writeMatter } from '../markdown.js';
import { Store } from '../store/db.js';
import { getSuggestion } from '../store/queries.js';
import { SuggestionRow } from '../types.js';
import { parsePlaybook } from './playbook.js';
import { writeAcceptedPage } from '../learn/writeback.js';

/**
 * The pack learning loop — dream's trace analysis, pointed at pack_events:
 * every context-pack build leaves behind which playbook ran, which probes
 * failed, how much evidence came back and what gaps remained. This module
 * turns that stream into *concrete playbook revisions* (kind 'pack'
 * suggestions carrying the full revised file), which are written back to
 * playbooks/packs/*.md on accept — so the next query runs a better script.
 */

interface PackEventRow {
  id: string;
  utterance: string;
  entities: { id: string; name: string; type: string }[];
  playbooks: string[];
  datasets: string[];
  probes: { id: string; source: string; ok: boolean; ms: number | null; error: string | null }[];
  gaps: string[];
  doc_count: number;
  claim_count: number;
  stale_count: number;
  conflict_count: number;
  created_at: string;
}

interface PlaybookStats {
  path: string;
  uses: number;
  zeroDocEvents: number;
  probeRuns: Map<string, { runs: number; failures: number; lastError: string | null; source: string }>;
  gapCounts: Map<string, number>;
  sampleUtterances: string[];
}

export interface OptimizeResult {
  events: number;
  suggestions: SuggestionRow[];
}

export async function optimizePacks(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { lookbackDays?: number; onProgress?: (msg: string) => void } = {},
): Promise<OptimizeResult> {
  const progress = opts.onProgress ?? (() => {});
  const since = new Date(Date.now() - (opts.lookbackDays ?? 14) * 86_400_000).toISOString();
  const events = await store.query<PackEventRow>(
    `SELECT * FROM pack_events WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 200`,
    [since],
  );
  if (events.length === 0) return { events: 0, suggestions: [] };
  progress(`optimizing playbooks over ${events.length} pack events`);

  const byPlaybook = aggregate(events);
  const proposals: Omit<SuggestionRow, 'id' | 'status' | 'created_at' | 'report_path'>[] = [];

  for (const stats of byPlaybook.values()) {
    const abs = path.join(store.dataDir, stats.path);
    if (!fs.existsSync(abs)) continue;
    const current = fs.readFileSync(abs, 'utf8');

    let revised: { content: string; rationale: string; evidence: string[] } | null = null;
    if (llm.enabled && stats.uses >= 2) {
      try {
        revised = await llmRevision(llm, stats, current);
      } catch (err) {
        progress(`llm playbook revision failed for ${stats.path}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!revised) revised = heuristicRevision(stats, current);
    if (!revised) continue;
    if (revised.content.trim() === current.trim()) continue;
    if (!parsePlaybook(revised.content, stats.path)) {
      progress(`revision for ${stats.path} does not parse as a playbook — skipped`);
      continue;
    }
    proposals.push({
      kind: 'pack',
      title: `Revise playbook ${stats.path}`,
      body: revised.rationale,
      evidence: revised.evidence,
      payload: { path: stats.path, content: revised.content },
    });
  }

  // knowledge-gap signal independent of any single playbook
  const zeroDoc = events.filter((e) => e.entities.length > 0 && e.doc_count === 0);
  if (zeroDoc.length >= 3) {
    proposals.push({
      kind: 'knowledge',
      title: 'Context packs repeatedly found entities without documents',
      body: `${zeroDoc.length} recent context packs matched entities but retrieved zero documents. The knowledge base lacks material on: ${[...new Set(zeroDoc.flatMap((e) => e.entities.map((x) => x.name)))].slice(0, 8).join(', ')}. Add reports/notes under raw/docs and re-ingest.`,
      evidence: zeroDoc.slice(0, 3).map((e) => e.utterance),
      payload: null,
    });
  }

  const rows: SuggestionRow[] = [];
  for (const p of proposals) {
    const id = crypto.createHash('sha256').update(`${p.kind}|${p.title}`).digest('hex').slice(0, 16);
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload, status = 'pending'`,
      [id, p.kind, p.title, p.body, JSON.stringify(p.evidence ?? []), p.payload ? JSON.stringify(p.payload) : null],
    );
    rows.push({ id, status: 'pending', created_at: new Date().toISOString(), report_path: null, ...p });
  }
  progress(`pack optimization: ${rows.length} suggestions`);
  return { events: events.length, suggestions: rows };
}

/**
 * Apply a machine-actionable suggestion. Kinds 'pack' and 'recipe' write a
 * file back under playbooks/packs/ — the "accept" that actually changes what the next
 * query does (plain dream suggestions remain advisory). A distilled recipe
 * goes through exactly this gate, which is why nothing distillation proposes
 * takes effect until a person says so.
 */
export async function applySuggestion(
  store: Store,
  dataDir: string,
  id: string,
): Promise<{ applied: boolean; path?: string; merged?: { entityId: string; canonicalId: string }; job?: { id: string; kind: string } }> {
  const s = await getSuggestion(store, id);
  if (!s) return { applied: false };
  if (s.kind === 'wiki') {
    // a recommended page: accepting queues the research job
    const p = s.payload as { kind?: string; target?: string } | null;
    if (!p?.target) return { applied: false };
    const kind = (p.kind ?? 'entity') as ResearchKind;
    const { job } = await queueJob(store, kind === 'question' ? { kind, query: p.target, requestedBy: 'suggestion' } : { kind, target: p.target, requestedBy: 'suggestion' });
    return { applied: true, job: { id: job.id, kind: job.kind } };
  }
  if (s.kind === 'claim-merge') {
    // a duplicate-claim proposal (docs/design/10): accepting records the reversible link
    const p = s.payload as { claimId?: string; canonicalId?: string; kind?: 'same_as' | 'contains'; reason?: string; confidence?: number } | null;
    if (!p?.claimId || !p?.canonicalId) return { applied: false };
    const r = await applyClaimMerge(store, { claimId: p.claimId, canonicalId: p.canonicalId, kind: p.kind, reason: p.reason ?? `suggestion ${id}`, confidence: p.confidence ?? null, actor: 'user' });
    return { applied: true, merged: { entityId: r.claimId, canonicalId: r.canonicalId } };
  }
  if (s.kind === 'merge') {
    // a duplicate-entity proposal: accepting records the reversible link
    const p = s.payload as { entityId?: string; canonicalId?: string; reason?: string } | null;
    if (!p?.entityId || !p?.canonicalId) return { applied: false };
    const r = await applyMerge(store, { entityId: p.entityId, canonicalId: p.canonicalId, reason: p.reason ?? `suggestion ${id}`, actor: 'user' });
    return { applied: true, merged: { entityId: r.entityId, canonicalId: r.canonicalId } };
  }
  if (s.kind === 'learn') {
    // a learned question page that waited for review (src/learn/writeback.ts): accepting writes it, a person's, for the sync to index
    const written = writeAcceptedPage(dataDir, s.payload as { path?: unknown; content?: unknown } | null);
    return written ? { applied: true, path: written } : { applied: false };
  }
  const writable = s.kind === 'pack' || s.kind === 'recipe';
  if (!writable || !s.payload?.path || typeof s.payload.content !== 'string') return { applied: false };
  assertWritablePath(s.payload.path);
  writeFileText(dataDir, s.payload.path, s.payload.content);
  return { applied: true, path: s.payload.path };
}

/* -------------------------------- aggregate ------------------------------- */

function aggregate(events: PackEventRow[]): Map<string, PlaybookStats> {
  const byPlaybook = new Map<string, PlaybookStats>();
  for (const e of events) {
    for (const pb of e.playbooks) {
      if (!byPlaybook.has(pb)) {
        byPlaybook.set(pb, { path: pb, uses: 0, zeroDocEvents: 0, probeRuns: new Map(), gapCounts: new Map(), sampleUtterances: [] });
      }
      const s = byPlaybook.get(pb)!;
      s.uses++;
      if (e.doc_count === 0) s.zeroDocEvents++;
      if (s.sampleUtterances.length < 5) s.sampleUtterances.push(e.utterance);
      for (const probe of e.probes) {
        if (!s.probeRuns.has(probe.id)) s.probeRuns.set(probe.id, { runs: 0, failures: 0, lastError: null, source: probe.source });
        const pr = s.probeRuns.get(probe.id)!;
        pr.runs++;
        if (!probe.ok) {
          pr.failures++;
          pr.lastError = probe.error;
        }
      }
      for (const gap of e.gaps) s.gapCounts.set(gap, (s.gapCounts.get(gap) ?? 0) + 1);
    }
  }
  return byPlaybook;
}

/* -------------------------------- heuristics ------------------------------- */

/** No-LLM path: drop probes that keep failing (source gone / SQL rotted). */
function heuristicRevision(stats: PlaybookStats, current: string): { content: string; rationale: string; evidence: string[] } | null {
  const broken = [...stats.probeRuns.entries()].filter(([, r]) => r.runs >= 2 && r.failures / r.runs >= 0.5);
  if (broken.length === 0) return null;
  const brokenIds = new Set(broken.map(([probeId]) => probeId));
  const parsed = readMatter(current);
  const probes = Array.isArray(parsed.data.probes) ? parsed.data.probes : [];
  const kept = probes.filter((p: { id?: string }) => !p?.id || !brokenIds.has(p.id));
  if (kept.length === probes.length) return null;
  const content = writeMatter(parsed.content, { ...parsed.data, probes: kept });
  return {
    content,
    rationale: `Probes ${[...brokenIds].join(', ')} failed in ≥50% of recent context packs (${stats.uses} uses). Removing them until the source is fixed keeps packs fast and noise-free.`,
    evidence: broken.map(([probeId, r]) => `${probeId}: ${r.failures}/${r.runs} failures — ${r.lastError ?? 'unknown error'}`),
  };
}

/* ----------------------------------- LLM ----------------------------------- */

const REVISE_SYSTEM = `You maintain "playbooks" — markdown files with YAML frontmatter that drive an agent context-pack engine.
Frontmatter fields: type: playbook (required), appliesTo, retrieval: {k, mode}, probes: [{id, source, table, description, sql}], suggestions: [strings].
Probe SQL may use {name} / {symbol} / {alias} placeholders and MUST be a single read-only SELECT.
The body is guidance text handed to agents verbatim.

You get the current playbook plus usage statistics from recent context packs (probe failures, evidence counts, recurring gaps, sample utterances).
Revise the playbook to make the NEXT queries better: remove or fix broken probes, add probes for recurring needs, tighten retrieval k, update guidance and suggestions. Keep it valid and minimal. Keep the same appliesTo unless clearly wrong. Write guidance in the dominant language of the sample utterances.

Respond JSON only: {"revised": "<full markdown file including frontmatter>", "rationale": "<2-4 sentences why>"}`;

async function llmRevision(llm: LlmClient, stats: PlaybookStats, current: string): Promise<{ content: string; rationale: string; evidence: string[] } | null> {
  const probeLines = [...stats.probeRuns.entries()]
    .map(([probeId, r]) => `${probeId} (${r.source}): ${r.runs} runs, ${r.failures} failures${r.lastError ? `, last error: ${r.lastError.slice(0, 120)}` : ''}`);
  const gapLines = [...stats.gapCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g, n]) => `${g} ×${n}`);
  const user = `# Current playbook (${stats.path})
${current}

# Usage over recent context packs
uses: ${stats.uses}, zero-document packs: ${stats.zeroDocEvents}
probes:
${probeLines.join('\n') || '(none)'}
recurring gaps:
${gapLines.join('\n') || '(none)'}
sample utterances:
${stats.sampleUtterances.map((u) => '- ' + u).join('\n')}`;

  const res = await llm.completeJson<{ revised?: string; rationale?: string }>([
    { role: 'system', content: REVISE_SYSTEM },
    { role: 'user', content: user },
  ], { maxTokens: 3000 });
  if (!res.revised || typeof res.revised !== 'string') return null;
  return {
    content: res.revised,
    rationale: res.rationale?.trim() || `LLM revision based on ${stats.uses} recent pack builds.`,
    evidence: [...probeLines.slice(0, 3), ...gapLines.slice(0, 3)],
  };
}
