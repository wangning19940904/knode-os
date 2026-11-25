import type { ChatMessage } from '../llm/client.js';
import type { Segment } from '../graph/segment.js';
import { labelKey } from './labels.js';
import type { TableFact, TableParse } from './parse.js';
import { effectiveScale, parseCell, parsePeriod, scaleIn, Scale } from './values.js';

/**
 * The model path for tables the layout reading cannot vouch for
 * (docs/design/38 §3.2 item 1): one call per segment, rows out as JSON
 * lines, no cap on how many — unlike tier-1 extraction's 25 claims a call —
 * and only for segments dense with numbers that no confident table explains.
 *
 * What a reply says is checked against the text before it becomes a fact:
 * the value must be written on the line the model names (or the line below,
 * for a wrapped label), and a scale must be wording the segment holds. A row
 * that fails is dropped. Scale and period are then read the way the
 * deterministic path reads them, so the model contributes only which number
 * belongs to which label and column.
 *
 * Not run by sync, and not wired into a background pass yet: `segmentsForModel`
 * says which segments would go, `tableModelMessages` / `parseTableModelReply`
 * are the call, and the replies are kept in the document's sidecar (`tables`
 * part, by segment hash) for `buildTableFacts` to replay.
 */

export interface ModelPathOptions {
  /** A segment with fewer numeric lines is not sent. */
  minNumericLines?: number;
  /** Nor one where numeric lines are a smaller share of its non-blank lines. */
  minNumericShare?: number;
  /** A segment is sent when confident tables explain less than this share of its numeric lines. */
  minExplained?: number;
  /** A table below this confidence explains nothing. */
  minConfidence?: number;
}

export const MODEL_PATH_DEFAULTS: Required<ModelPathOptions> = { minNumericLines: 8, minNumericShare: 0.2, minExplained: 0.6, minConfidence: 0.7 };

const NUMBER_TOKEN = /\(?[-−]?\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|(?<![\d.])\d+\.\d+%?|(?<![\d,.])(?!(?:19|20)\d{2}(?![\d,.]))\d{3,}(?![\d,.])/g;

/**
 * A line shaped like a table row with amounts on it (years and short
 * integers aside): two or more amounts set apart by runs of spaces, tabs or
 * pipes, or a short line of them, or one amount alone on its line (a table a
 * converter wrote one cell per line). A sentence with amounts in it is not one.
 */
export function isNumericLine(line: string): boolean {
  const t = line.replace(/[\u00a0\u3000]/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  if (!t) return false;
  const amounts = t.match(NUMBER_TOKEN) ?? [];
  if (!amounts.length) return false;
  if (amounts.length === 1) return t.replace(/[$¥￥()\s,.%\-\u2212]/g, '').replace(/\d/g, '') === '';
  if (/\s{2,}|\t|\|/.test(t)) return true;
  // a sentence: many words, or many Chinese characters (a row's label is a few)
  const words = t.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const han = t.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return t.length <= 100 && words <= 8 && han <= 16;
}

export interface ModelSegment {
  index: number;
  sha: string;
  startLine: number;
  endLine: number;
  chars: number;
  numericLines: number;
  /** Numeric lines a confident table produced a fact for. */
  explained: number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** The 1-based line a character offset is on. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The segments the model path would read: dense with numbers, and mostly unexplained by confident tables. */
export function modelPathSegments(text: string, segments: Segment[], parse: TableParse, opts: ModelPathOptions = {}): ModelSegment[] {
  const o = { ...MODEL_PATH_DEFAULTS, ...opts };
  const confident = new Set(parse.tables.filter((t) => t.confidence >= o.minConfidence).map((t) => t.no));
  const explainedLines = new Set(parse.facts.filter((f) => f.valueNum !== null && confident.has(f.tableNo)).map((f) => f.line));
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const out: ModelSegment[] = [];
  for (const s of segments) {
    const startLine = lineAt(starts, s.start);
    const endLine = lineAt(starts, Math.max(s.start, s.end - 1));
    let numeric = 0;
    let nonBlank = 0;
    let explained = 0;
    for (let n = startLine; n <= endLine; n++) {
      const l = lines[n - 1] ?? '';
      if (!l.trim()) continue;
      nonBlank++;
      if (!isNumericLine(l)) continue;
      numeric++;
      if (explainedLines.has(n)) explained++;
    }
    if (numeric < o.minNumericLines || numeric < nonBlank * o.minNumericShare) continue;
    if (explained >= numeric * o.minExplained) continue;
    out.push({ index: s.index, sha: s.sha, startLine, endLine, chars: s.end - s.start, numericLines: numeric, explained });
  }
  return out;
}

/* ------------------------------- the call ------------------------------- */

export interface ModelRow {
  line: number;
  label: string;
  column: string;
  value: string;
  scale: string | null;
}

/** The messages one segment's call sends: its lines numbered as in the document. */
export function tableModelMessages(text: string, seg: { startLine: number; endLine: number }, ctx: { subject?: string | null; title?: string | null } = {}): ChatMessage[] {
  const lines = text.split('\n');
  const body: string[] = [];
  for (let n = seg.startLine; n <= seg.endLine; n++) body.push(`${n}| ${lines[n - 1] ?? ''}`);
  const about = [ctx.title ? `Document: ${ctx.title}` : null, ctx.subject ? `Reporting entity: ${ctx.subject}` : null].filter(Boolean).join('\n');
  return [
    {
      role: 'system',
      content: `You read the tables in a passage of a financial report and write out every value cell, one JSON object per line (JSON Lines, no array, no commentary):
{"line": <the number before "|" of the line the value is on>, "label": <the row's label as written; a label wrapped over two lines joined>, "column": <the column's header as written, all header lines joined, e.g. "Three Months Ended March 31, 2024">, "value": <the cell exactly as written, e.g. "(1,310,714)", "-", "12.5%">, "scale": <the table's unit note as written, e.g. "in thousands, except per share data", "单位：万元", or null>}
Rules:
- Every row of every table, every value column. There is no limit on the number of lines; do not summarize, skip or merge rows.
- Copy values exactly; never compute, convert or round. A dash is a value.
- Leave out prose that is not in a table.`,
    },
    { role: 'user', content: `${about ? `${about}\n\n` : ''}${body.join('\n')}` },
  ];
}

const squash = (s: string) => s.normalize('NFKC').replace(/[\s 　]+/g, '').toLowerCase();

/**
 * The rows of a reply that the text bears out. Tolerates a truncated reply
 * (every complete line counts) and a reply wrapped in a code fence.
 */
export function parseTableModelReply(reply: string, text: string, seg: { startLine: number; endLine: number }): ModelRow[] {
  const lines = text.split('\n');
  const segText = squash(lines.slice(seg.startLine - 1, seg.endLine).join('\n'));
  const out: ModelRow[] = [];
  for (const raw of reply.split('\n')) {
    const t = raw.trim().replace(/,$/, '');
    if (!t.startsWith('{')) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(t);
    } catch {
      continue;
    }
    const line = Number(r.line);
    const value = typeof r.value === 'string' ? r.value.trim() : typeof r.value === 'number' ? String(r.value) : '';
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!Number.isInteger(line) || line < seg.startLine || line > seg.endLine || !value || !label) continue;
    // grounding: the value is written on that line (or the next, when the model named a wrapped label's first line)
    const at = [line, line + 1].find((n) => n <= seg.endLine && squash(lines[n - 1] ?? '').includes(squash(value)));
    if (at === undefined) continue;
    // and the label's start is written there or just above
    const near = squash(lines.slice(Math.max(0, at - 3), at).join(' '));
    if (!near.includes(squash(label).slice(0, 8))) continue;
    const scale = typeof r.scale === 'string' && r.scale.trim() && segText.includes(squash(r.scale)) ? r.scale.trim() : null;
    out.push({ line: at, label, column: typeof r.column === 'string' ? r.column.trim() : '', value, scale });
  }
  return out;
}

/** Facts from checked model rows; scale read from the row's own note, else the nearest note above in the text. */
export function modelRowsToFacts(rows: ModelRow[], text: string, tableNo: number): TableFact[] {
  const lines = text.split('\n');
  const noteAbove = (line: number): Scale | null => {
    for (let n = line - 1; n >= Math.max(1, line - 60); n--) {
      const s = scaleIn(lines[n - 1] ?? '');
      if (s) return s;
    }
    return null;
  };
  const out: TableFact[] = [];
  const firstLine = rows.length ? Math.min(...rows.map((r) => r.line)) : 0;
  const seen = new Set<string>();
  rows.forEach((r) => {
    const key = `${r.line}|${r.column}|${r.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const cell = parseCell(r.value);
    if (cell.kind === 'empty') return;
    const tableScale = (r.scale ? scaleIn(r.scale) : null) ?? noteAbove(r.line);
    const scale = cell.kind === 'number' ? effectiveScale(cell, r.label, r.column, tableScale) : { raw: null, factor: 1, unit: null };
    const p = parsePeriod(r.column);
    out.push({
      tableNo,
      tableLine: firstLine,
      tableTitle: null,
      line: r.line,
      col: -1,
      section: null,
      label: r.label,
      labelKey: labelKey(r.label),
      period: r.column,
      periodKey: p.key,
      periodSpan: p.span,
      valueNum: cell.num,
      valueText: cell.text,
      unit: scale.unit,
      scale: scale.raw,
      scaleFactor: scale.factor,
      parser: 'llm',
      confidence: 0.8,
    });
  });
  return out;
}
