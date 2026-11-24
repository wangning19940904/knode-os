import { MAX_FILE_BYTES } from '../constants.js';
import { readSourceTextCapped } from '../ingest/source.js';
import { declaredScale, figureOnLine, NumberToken, numbersIn } from './numbers.js';

/**
 * The deterministic check every write-back takes (docs/design/38 §4.2): the
 * cited line is on that document at that line number, and it states the value
 * the answer gives (thousands separators, magnitude words and a table's
 * declared scale considered). No model reads anything here — what passes is
 * what a person could confirm with one `sed -n`.
 *
 * A citation that names no line is located: the one line of the document that
 * states the value *and* names the attribute. Located is weaker than cited,
 * so the check says which it was; a citation whose given line does not state
 * the value fails outright — it is not moved to a line that happens to.
 */

export interface SourceRef {
  /** Source key, `raw/docs/<path>`. */
  path: string;
  /** 1-based first line cited; null when the citation named none. */
  line: number | null;
  /** Last line of a cited range (inclusive); equals `line` for one line. */
  lineTo: number | null;
}

/** `raw/docs/x.md#L12`, `raw/docs/x.md#L12-L14`, `x.md:12`, `x.md` → a reference (a bare corpus path is under raw/docs). */
export function parseSourceRef(spec: string): SourceRef | null {
  const s = spec.trim().replace(/^\[?doc:\s*/i, '').replace(/[\])]$/, '').replace(/^\.\//, '');
  const m = /^(.+?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)?$/.exec(s);
  if (!m || !m[1]) return null;
  let p = m[1].trim();
  if (!p.startsWith('raw/')) p = `raw/docs/${p.replace(/^corpus\//, '')}`;
  if (!/^raw\/(docs|codebase)\/./.test(p) || p.includes('/../')) return null;
  const from = m[2] ?? m[4];
  const to = m[3] ?? m[5];
  const line = from ? Number(from) : null;
  return { path: p, line, lineTo: line === null ? null : to ? Math.max(line, Number(to)) : line };
}

export function formatSourceRef(r: Pick<SourceRef, 'path' | 'line' | 'lineTo'>): string {
  if (!r.line) return r.path;
  return r.lineTo && r.lineTo !== r.line ? `${r.path}#L${r.line}-L${r.lineTo}` : `${r.path}#L${r.line}`;
}

/** What a check is asked to confirm on the cited line: a figure, or a short text. */
export type Expected = { figure: NumberToken } | { text: string };

export type CheckReason =
  | 'ok'
  | 'no-document'
  | 'no-such-line'
  | 'line-mismatch'
  | 'not-found'
  | 'ambiguous'
  | 'scale-unknown'
  | 'quote-mismatch';

export interface CitationCheck {
  ok: boolean;
  reason: CheckReason;
  /** The reference as checked: the line found, when the citation named none. */
  ref: SourceRef;
  /** The line was found by the value, not given. */
  located: boolean;
  /** The text of the line that states the value. */
  lineText: string | null;
  /** The scale the line's figure was read at (1, or a table's declared 1e4 …). */
  scale: number | null;
  /** The line (or its table's header) names the attribute. */
  attributeOnLine: boolean;
}

/** A document's indexed text, split into lines, or null (a document this workspace does not hold). */
export function documentLines(dataDir: string, key: string): string[] | null {
  try {
    const t = readSourceTextCapped(dataDir, key, MAX_FILE_BYTES);
    return t ? t.content.split(/\r?\n/) : null;
  } catch {
    return null;
  }
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s,，*_`|]/g, '');

/**
 * The attribute's words on a line: the whole term (spaces and separators
 * ignored), or for a term of several English words all of them, or for a long
 * CJK term most of its two-character pieces.
 */
export function namesAttribute(line: string, attribute: string | null | undefined): boolean {
  if (!attribute) return false;
  const l = fold(line);
  const a = fold(attribute);
  if (!a) return false;
  if (l.includes(a)) return true;
  const words = attribute.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length >= 2 && words.every((w) => l.includes(w))) return true;
  const cjk = attribute.replace(/[^一-鿿]/g, '');
  if (cjk.length >= 4) {
    const grams = new Set<string>();
    for (let i = 0; i + 2 <= cjk.length; i++) grams.add(cjk.slice(i, i + 2));
    const hit = [...grams].filter((g) => l.includes(g)).length;
    return hit / grams.size >= 0.6;
  }
  return false;
}

function checkLine(lines: string[], i: number, expected: Expected): { ok: boolean; scale: number | null; guess: boolean } {
  const text = lines[i] ?? '';
  if ('text' in expected) return { ok: fold(text).includes(fold(expected.text)), scale: null, guess: false };
  const m = figureOnLine(expected.figure, text, declaredScale(lines, i));
  if (!m) return { ok: false, scale: null, guess: false };
  return { ok: m.how === 'exact', scale: m.scale, guess: m.how === 'scale-guess' };
}

export interface CheckOptions {
  /** The attribute the value is of: a located line must name it (on the line, or in the header of its table). */
  attribute?: string | null;
  /** The text the citation quoted, which the line must contain. */
  quote?: string | null;
  /** Lines (1-based) to prefer when locating: a passage the answer was made from. */
  near?: { from: number; to: number } | null;
}

/** The header row of the table a line is in (the nearest line above that starts a pipe table), or ''. */
export function tableHeader(lines: string[], i: number): string {
  for (let k = i - 1; k >= 0 && k >= i - 400; k--) {
    const s = lines[k];
    if (!/^\s*\|/.test(s)) return '';
    if (/^\s*\|?\s*:?-{3,}/.test(s)) return lines[k - 1] ?? '';
  }
  return '';
}

/**
 * Check one cited value against its document. Given a line (or range), the
 * value must be on it. Given none, it is located: the lines that state the
 * value, narrowed to those naming the attribute (or whose table header does),
 * then to `near`; exactly one must remain.
 */
export function checkCitation(dataDir: string, ref: SourceRef, expected: Expected, opts: CheckOptions = {}): CitationCheck {
  const fail = (reason: CheckReason, extra: Partial<CitationCheck> = {}): CitationCheck => ({ ok: false, reason, ref, located: false, lineText: null, scale: null, attributeOnLine: false, ...extra });
  const lines = documentLines(dataDir, ref.path);
  if (!lines) return fail('no-document');
  const named = (i: number) => namesAttribute(lines[i], opts.attribute) || namesAttribute(tableHeader(lines, i), opts.attribute) || namesAttribute(`${lines[i - 1] ?? ''} ${lines[i - 2] ?? ''}`, opts.attribute);
  const quoteOk = (i: number) => !opts.quote || fold(lines.slice(Math.max(0, i - 1), i + 2).join('\n')).includes(fold(opts.quote));

  if (ref.line !== null) {
    const from = ref.line - 1;
    const to = (ref.lineTo ?? ref.line) - 1;
    if (from < 0 || to >= lines.length) return fail('no-such-line');
    let guessAt: number | null = null;
    for (let i = from; i <= Math.min(to, from + 50); i++) {
      const c = checkLine(lines, i, expected);
      if (c.ok) {
        if (!quoteOk(i)) return fail('quote-mismatch', { lineText: lines[i] });
        return { ok: true, reason: 'ok', ref: { ...ref, line: i + 1, lineTo: i + 1 }, located: false, lineText: lines[i], scale: c.scale, attributeOnLine: named(i) };
      }
      if (c.guess && guessAt === null) guessAt = i;
    }
    if (guessAt !== null) return fail('scale-unknown', { lineText: lines[guessAt], ref: { ...ref, line: guessAt + 1, lineTo: guessAt + 1 } });
    return fail('line-mismatch', { lineText: lines[from] });
  }

  // locate: every line that states it
  const hits: number[] = [];
  const guesses: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = checkLine(lines, i, expected);
    if (c.ok) hits.push(i);
    else if (c.guess) guesses.push(i);
  }
  const narrow = (cands: number[]): number[] => {
    let out = cands;
    if (opts.quote) out = out.filter(quoteOk);
    if ('figure' in expected) {
      const withAttr = out.filter(named);
      out = withAttr;
    }
    if (out.length > 1 && opts.near) {
      const inside = out.filter((i) => i + 1 >= opts.near!.from && i + 1 <= opts.near!.to);
      if (inside.length) out = inside;
    }
    return out;
  };
  const found = narrow(hits);
  if (found.length === 1) {
    const i = found[0];
    const c = checkLine(lines, i, expected);
    return { ok: true, reason: 'ok', ref: { path: ref.path, line: i + 1, lineTo: i + 1 }, located: true, lineText: lines[i], scale: c.scale, attributeOnLine: named(i) };
  }
  if (found.length > 1) {
    // one value stated on several lines naming the attribute (a summary table and a note repeating it): the first is the citation
    const distinct = new Set(found.map((i) => fold(lines[i])));
    const i = found[0];
    // a text answer is the same words wherever they stand: its first line is the citation
    if (distinct.size === 1 || 'text' in expected) return { ok: true, reason: 'ok', ref: { path: ref.path, line: i + 1, lineTo: i + 1 }, located: true, lineText: lines[i], scale: checkLine(lines, i, expected).scale, attributeOnLine: true };
    return fail('ambiguous', { lineText: lines[i], ref: { path: ref.path, line: i + 1, lineTo: i + 1 }, located: true });
  }
  const guessed = narrow(guesses);
  if (guessed.length) return fail('scale-unknown', { lineText: lines[guessed[0]], ref: { path: ref.path, line: guessed[0] + 1, lineTo: guessed[0] + 1 }, located: true });
  return fail('not-found');
}

/** The first figure in `text` that is not a date, or null. */
export function firstFigure(text: string): NumberToken | null {
  return numbersIn(text).find((n) => !n.dateLike) ?? null;
}
