import fs from 'node:fs';
import { safePath, walkFiles, writeFileText } from '../fs/files.js';
import { originOf, recordOrigin } from '../fs/sidecar.js';
import { readMatter, writeMatter } from '../markdown.js';
import { citationChanges } from '../research/cited-refresh.js';
import type { Store } from '../store/db.js';
import { LEARN_WRITER, LEARNED_DIR } from './config.js';
import { answerFigures } from './numbers.js';
import { checkRef, PageCheck, readLearnedPage } from './page.js';
import { checkCitation, documentLines, formatSourceRef } from './verify.js';
import { fileLearnSuggestion, learnSuggestionId } from './writeback.js';

/**
 * A learned page whose cited documents changed is checked again (docs/design/38
 * §4.2, design 37 §5's citation dependencies): no agent wrote its prose, so
 * unlike a research page it needs no refresh job — the same deterministic
 * check that let it in decides whether it stays.
 *
 *   - every value still on its line: the page stays;
 *   - a value moved (lines inserted above it): the page is rewritten with the
 *     new line numbers, found by the line's own text;
 *   - a value gone or changed: the page is withdrawn — removed from the
 *     index, and filed as a `learn` suggestion saying why — so nothing keeps
 *     answering from a figure the sources no longer state.
 *
 * Runs after a sync that changed something, only when learned pages exist;
 * `resync` re-indexes the pages it rewrote or removed (inside the same sync
 * chain: src/ingest/sync.ts).
 */

export interface RevalidateStats {
  checked: number;
  kept: number;
  moved: string[];
  withdrawn: string[];
}

export function hasLearnedPages(dataDir: string): boolean {
  return fs.existsSync(safePath(dataDir, LEARNED_DIR));
}

function recheck(dataDir: string, c: PageCheck): PageCheck {
  const ref = checkRef(c);
  if (!ref) return c;
  const expected = 'figure' in c.expect
    ? (() => {
      const f = answerFigures(c.expect.figure)[0];
      return f ? { figure: f } : { text: c.expect.figure };
    })()
    : { text: c.expect.text };
  // on its line still
  const here = checkCitation(dataDir, ref, expected, { attribute: c.attribute });
  if (here.ok && (!c.line || (here.lineText ?? '').trim() === c.line.trim())) return { ...c, ok: true, reason: 'ok', line: here.lineText };
  // moved: the same line's text elsewhere in the document, still stating the value
  const lines = documentLines(dataDir, ref.path);
  if (lines && c.line) {
    const want = c.line.trim();
    const at = lines.findIndex((l) => l.trim() === want);
    if (at >= 0) {
      const moved = checkCitation(dataDir, { path: ref.path, line: at + 1, lineTo: at + 1 }, expected, { attribute: c.attribute });
      if (moved.ok) return { ...c, ok: true, reason: 'ok', source: formatSourceRef(moved.ref), line: moved.lineText };
    }
  }
  return { ...c, ok: false, reason: here.ok ? 'line-mismatch' : here.reason, line: here.lineText ?? c.line };
}

export async function revalidateLearned(
  store: Store,
  dataDir: string,
  opts: { prefixes?: string[]; resync: (paths: string[]) => Promise<unknown> },
): Promise<RevalidateStats> {
  const stats: RevalidateStats = { checked: 0, kept: 0, moved: [], withdrawn: [] };
  if (!hasLearnedPages(dataDir)) return stats;
  const pages = walkFiles(dataDir, LEARNED_DIR).filter((p) => p.endsWith('.md'));
  if (!pages.length) return stats;
  const changes = await citationChanges(store, dataDir, { pages, prefixes: opts.prefixes });
  const touched: string[] = [];
  for (const change of changes) {
    const rel = change.page;
    const abs = safePath(dataDir, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const page = readLearnedPage(text);
    if (!page) continue;
    stats.checked++;
    const checks = page.checks.map((c) => (c.ok ? recheck(dataDir, c) : c));
    const failed = checks.some((c, i) => page.checks[i].ok && !c.ok);
    if (failed) {
      fs.rmSync(abs, { force: true });
      await fileLearnSuggestion(store, { id: learnSuggestionId(rel), path: rel, content: text, question: page.question, checks, verified: false, reason: 'stale' });
      stats.withdrawn.push(rel);
      touched.push(rel);
      continue;
    }
    const moved = checks.some((c, i) => c.source !== page.checks[i].source);
    if (moved) {
      const m = readMatter(text);
      const learned = { ...(m.data.learned as Record<string, unknown>), checks, recheckedAt: new Date().toISOString() };
      const map = new Map(page.checks.map((c, i) => [c.source, checks[i].source]));
      const data: Record<string, unknown> = { ...m.data, learned };
      if (Array.isArray(data.facts)) data.facts = (data.facts as { source?: string }[]).map((f) => ({ ...f, source: map.get(f.source ?? '') ?? f.source }));
      let body = m.content;
      for (const [from, to] of map) if (from && to && from !== to) body = body.split(from).join(to);
      const next = writeMatter(body, data);
      // the page stays whoever accepted it: the writer on record for the old bytes is the writer of the new
      recordOrigin(dataDir, rel, next, originOf(dataDir, rel)?.actor ?? LEARN_WRITER);
      writeFileText(dataDir, rel, next);
      stats.moved.push(rel);
      touched.push(rel);
      continue;
    }
    stats.kept++;
  }
  if (touched.length) await opts.resync(touched);
  return stats;
}

/** Learned pages on disk (for reports and tests). */
export function learnedPages(dataDir: string): string[] {
  if (!hasLearnedPages(dataDir)) return [];
  return walkFiles(dataDir, LEARNED_DIR).filter((p) => p.endsWith('.md'));
}
