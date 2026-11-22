import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gold, holdout and task files never enter a build's workspace (docs/design/35
 * D7): the agent arms read that folder, and a gold file in it would hand them
 * the answers. A run copies only the staged corpus there; this check is what
 * holds it to that, after staging and after every update batch.
 *
 * A file of the workspace leaks when its content is byte for byte a file
 * under the pack's `gold/`, `holdout/` or `tasks/`. Sizes are compared first
 * (a stat each), so a workspace of many gigabytes is walked, not read: only a
 * file as long as some gold file is hashed.
 */

export const GUARDED_PACK_DIRS = ['gold', 'holdout', 'tasks'] as const;

export interface Leak {
  /** The workspace file, relative to the workspace. */
  file: string;
  /** The pack file it repeats, relative to the pack. */
  matches: string;
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every regular file under `dir`, relative to it; symbolic links are not followed. */
function* walk(dir: string, rel = ''): Generator<{ rel: string; abs: string; size: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile()) {
      const abs = path.join(dir, r);
      try {
        yield { rel: r, abs, size: fs.statSync(abs).size };
      } catch {
        // gone meanwhile
      }
    }
  }
}

/** The files of `ws` whose content is a gold, holdout or task file of the pack at `packDir`. */
export function leakedFiles(ws: string, packDir: string): Leak[] {
  // pack files by size; hashed only when a workspace file of that size turns up
  const guarded = new Map<number, { rel: string; abs: string; hash?: string }[]>();
  for (const sub of GUARDED_PACK_DIRS) {
    for (const f of walk(path.join(packDir, sub))) {
      // an empty file is no content to leak
      if (f.size === 0) continue;
      (guarded.get(f.size) ?? guarded.set(f.size, []).get(f.size)!).push({ rel: `${sub}/${f.rel}`, abs: f.abs });
    }
  }
  if (!guarded.size) return [];
  const leaks: Leak[] = [];
  for (const f of walk(ws)) {
    const same = guarded.get(f.size);
    if (!same) continue;
    const hash = sha256(f.abs);
    for (const g of same) {
      g.hash ??= sha256(g.abs);
      if (g.hash === hash) {
        leaks.push({ file: f.rel, matches: g.rel });
        break;
      }
    }
  }
  return leaks;
}

/** The frontmatter `date` of a Markdown file, from its first 4 KB; null without one. */
function frontmatterDate(abs: string): string | null {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    const m = fm && /^date:\s*["']?([0-9][0-9T:.+\-Z ]*?)["']?\s*$/m.exec(fm[1]);
    return m ? m[1] : null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Source documents of a workspace dated after `cutoff` (docs/design/37 §2): Markdown under `raw/` whose
 * frontmatter `date` is later. A code localization pack's corpus is a repository at its base commit, so
 * anything later — a newer card, release notes, a changelog — would tell an agent what changed next.
 */
export function datedAfter(ws: string, cutoff: string): { file: string; date: string }[] {
  const limit = Date.parse(cutoff);
  if (!Number.isFinite(limit)) return [];
  const out: { file: string; date: string }[] = [];
  for (const f of walk(path.join(ws, 'raw'))) {
    if (!f.rel.endsWith('.md')) continue;
    const d = frontmatterDate(f.abs);
    if (d && Date.parse(d) > limit) out.push({ file: `raw/${f.rel}`, date: d });
  }
  return out;
}

/**
 * Throw when the workspace holds a gold, holdout or task file of the pack, or (with `cutoff`) a source
 * document dated after the pack's cutoff: the build or batch fails.
 */
export function assertNoLeak(ws: string, packDir: string, when: string, cutoff?: string): void {
  if (cutoff) {
    const late = datedAfter(ws, cutoff);
    if (late.length) throw new Error(`documents dated after the pack's cutoff ${cutoff} are in the workspace ${when} (docs/design/37 §2): ${late.slice(0, 5).map((l) => `${l.file} (${l.date})`).join(', ')}${late.length > 5 ? ', …' : ''}`);
  }
  const leaks = leakedFiles(ws, packDir);
  if (!leaks.length) return;
  const shown = leaks.slice(0, 5).map((l) => `${l.file} (= ${l.matches})`).join(', ');
  throw new Error(`gold leaked into the workspace ${when} (docs/design/35 D7): ${leaks.length} file(s) are the pack's own gold, holdout or task files: ${shown}${leaks.length > 5 ? ', …' : ''}`);
}
