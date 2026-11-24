import { labelKey } from './labels.js';
import { documentPeriod, effectiveScale, isValueCell, parseCell, parsePeriod, Scale, scaleIn } from './values.js';

/**
 * Statement tables read into typed fact rows without a model
 * (docs/design/38 §3.2 item 1). Two layouts:
 *
 *   - Markdown pipe tables (`|货币资金|251,360,005.65|218,216,929.88|`), as
 *     PDF converters write Chinese reports: rows are cells already; what needs
 *     care is a header glued to the row above it (`…||利润表项目|本期发生额|`),
 *     a label cell written twice, text glued after the closing pipe, and a
 *     table continued on the next page;
 *   - space-aligned text tables (`Accounts payable    $   14,802   $   12,236`),
 *     as EDGAR's text renditions write 10-Ks: columns are found by where the
 *     numbers end (they are right-aligned), headers by what stands above each
 *     column, labels by what precedes the first number.
 *
 * Every non-label cell becomes a fact: its row's label as written and its
 * key (labels.ts), the column's header as the period, the value as written
 * and as a number, the unit and the scale — the table's note ("单位：元",
 * "in thousands") or a narrower one (the cell's, the row's, the column's) —
 * and the line it stands on. A text table also gets a confidence: how well
 * the columns lined up. Segments whose numbers no confident table explains
 * are what the model path (llm.ts) is for.
 */

export type TableParser = 'pipe' | 'text' | 'llm';

export interface TableFact {
  /** Ordinal of the table in the document (a continued table keeps its first part's). */
  tableNo: number;
  /** First line of the table (1-based). */
  tableLine: number;
  tableTitle: string | null;
  /** The line the value stands on (1-based, in the text as indexed). */
  line: number;
  /** Column index within the table (0 = the first value column). */
  col: number;
  /** The nearest heading row above within the table ("流动资产", "Current liabilities"). */
  section: string | null;
  label: string;
  labelKey: string;
  /** The column's header as written ("期末余额", "March 31, 2024"); '' when it has none. */
  period: string;
  /** parsePeriod's key; a `current` column of a dated table reads as that date. */
  periodKey: string | null;
  periodSpan: string | null;
  valueNum: number | null;
  valueText: string;
  unit: string | null;
  /** The scale's wording as written; null when nothing states one. */
  scale: string | null;
  scaleFactor: number;
  parser: TableParser;
  confidence: number;
}

export interface ParsedTable {
  no: number;
  parser: TableParser;
  startLine: number;
  endLine: number;
  title: string | null;
  scale: Scale | null;
  columns: string[];
  /** Lines of rows that produced at least one numeric fact. */
  valueLines: number[];
  confidence: number;
  /** The table this one continues (a page break in between), by `no`. */
  continues: number | null;
}

export interface TableParse {
  tables: ParsedTable[];
  facts: TableFact[];
  /** What the document is mainly about, read from its title or cover (the company of a report). */
  subject: string | null;
  /** The period the document reports on (values.ts documentPeriod). */
  docPeriod: string | null;
}

export interface ParseOptions {
  /** The document's title, when known (a better subject source than the text). */
  title?: string | null;
  /** Leave out text tables (pipe tables only). */
  pipeOnly?: boolean;
}

const MAX_TEXT_CELL = 500;

export function parseTables(text: string, opts: ParseOptions = {}): TableParse {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const tables: ParsedTable[] = [];
  const facts: TableFact[] = [];
  const pipe = pipeTables(lines);
  // a non-breaking space aligns columns as a space does (EDGAR's text renditions are full of them); an ideographic one is
  // two wide; a zero-width one is nothing
  const textTables = opts.pipeOnly ? [] : alignedTables(lines.map((l) => l.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\u3000/g, '  ').replace(/[\u200b-\u200d\ufeff]/g, '')));
  // one numbering in document order; a pipe table's `continues` named a pipe table by its own number
  const pipeNo = new Map<number, ParsedTable>(pipe.map((b) => [b.table.no, b.table]));
  const textNo = new Map<number, ParsedTable>(textTables.map((b) => [b.table.no, b.table]));
  const all = [...pipe, ...textTables].sort((a, b) => a.table.startLine - b.table.startLine);
  const continued = new Map<ParsedTable, ParsedTable>();
  for (const b of all) {
    if (b.table.continues === null) continue;
    const head = (b.table.parser === 'pipe' ? pipeNo : textNo).get(b.table.continues);
    if (head) continued.set(b.table, head);
  }
  all.forEach((b, i) => { b.table.no = i + 1; });
  for (const b of all) {
    const head = continued.get(b.table);
    if (head) b.table.continues = head.no;
    tables.push(b.table);
  }
  for (const b of all) {
    const owner = continued.get(b.table) ?? b.table;
    for (const f of b.facts) facts.push({ ...f, tableNo: owner.no, tableLine: owner.startLine, tableTitle: owner.title });
  }
  return { tables, facts, subject: documentSubject(text, opts.title ?? null), docPeriod: documentPeriod(text) };
}

/* ------------------------------ shared helpers ----------------------------- */

/** "□适用 区不适用", "□是 区否": a form's tick boxes, never a title. */
const CHECKBOX = /^[□■☑☒✓√区]\s*(?:适用|不适用|是|否)|(?:适用|是)\s*[□■☑☒✓√区]\s*(?:不适用|否)\s*$/;
const isBlank = (s: string | undefined) => !s || s.trim() === '';
const HEADING = /^\s{0,3}#{1,6}\s+/;

/** A line that only gives a date (a balance sheet's "2024年 03月 31日", "2024年1-3月"). */
function dateLine(s: string): { key: string; span: string | null } | null {
  const t = s.trim();
  if (!t || t.length > 40) return null;
  if (!/^(?:截至|截止)?\s*(?:19|20)\d{2}\s*年[\d\s月日\-–至~]*$/.test(t) && !/^(?:as of\s+)?[A-Za-z]+\.?\s+\d{1,2},?\s+(?:19|20)\d{2}$/i.test(t)) return null;
  const p = parsePeriod(t);
  return p.key && p.key !== 'current' && p.key !== 'prior' ? { key: p.key, span: p.span } : null;
}

function titleText(s: string): string {
  return s.replace(HEADING, '').replace(/^\s*[*_]+|[*_]+\s*$/g, '').trim().slice(0, 160);
}

/** Lines above `start` (exclusive) back to `stop` (exclusive): the title, the scale, a date that dates the table. */
function aboveTable(lines: string[], start: number, stop: number, isTableLine: (i: number) => boolean) {
  let title: string | null = null;
  let scale: Scale | null = null;
  let date: { key: string; span: string | null } | null = null;
  let seen = 0;
  for (let i = start - 1; i > stop && i >= 0 && seen < 10; i--) {
    const s = lines[i];
    if (isBlank(s)) continue;
    if (isTableLine(i)) break;
    seen++;
    if (!scale) scale = scaleIn(s);
    if (!date) date = dateLine(s);
    const plain = s.trim();
    const isNote = scaleIn(s) !== null || dateLine(s) !== null || /^(?:编制单位|币种|会计主管|法定代表人)/.test(plain) || CHECKBOX.test(plain);
    // a title is the first line above that is neither a note nor a long sentence
    if (!title && !isNote && plain.length <= 120 && !/[。.;；]$/.test(plain.replace(/[)）]$/, ''))) title = titleText(plain);
    else if (!title && !isNote && HEADING.test(s)) title = titleText(plain);
    // a heading ends the search: what is above it belongs to something else
    if (HEADING.test(s) && title) break;
  }
  return { title, scale, date };
}

/** A `current` column of a dated table is that date; the change column stays `change`. */
function resolveCurrent(p: { key: string | null; span: string | null }, date: { key: string; span: string | null } | null) {
  if (p.key === 'current' && date) return { key: date.key, span: p.span ?? date.span };
  return p;
}

function factOf(
  base: { line: number; col: number; section: string | null; label: string; period: string; periodKey: string | null; periodSpan: string | null; parser: TableParser; confidence: number },
  raw: string,
  tableScale: Scale | null,
): Omit<TableFact, 'tableNo' | 'tableLine' | 'tableTitle'> | null {
  const cell = parseCell(raw);
  if (cell.kind === 'empty') return null;
  const scale = cell.kind === 'number' ? effectiveScale(cell, base.label, base.period, tableScale) : { raw: null, factor: 1, unit: null };
  const text = cell.text.length > MAX_TEXT_CELL ? `${cell.text.slice(0, MAX_TEXT_CELL)}…` : cell.text;
  return {
    ...base,
    labelKey: labelKey(base.label),
    valueNum: cell.num,
    valueText: text,
    unit: scale.unit,
    scale: scale.raw,
    scaleFactor: scale.factor,
  };
}

interface Built {
  table: ParsedTable;
  facts: Omit<TableFact, 'tableNo' | 'tableLine' | 'tableTitle'>[];
}

/* ------------------------------- pipe tables ------------------------------- */

const PIPE_LINE = /^\s*\|.*\|/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;
const NOTE_HEADER = /^(?:附注|注释|注|附注编号|附注号|notes?|ref\.?)$/i;
const SERIAL_HEADER = /^(?:序号|编号|no\.?|#)$/i;
/** Lines that may stand between two parts of a table split by a page break. */
const PAGE_JUNK = /^\s*(?:第\s*\d+\s*页.*|-?\s*\d{1,4}\s*-?|\d+\s*\/\s*\d+|page\s+\d+(?:\s+of\s+\d+)?|<!--.*-->|---+|\*\*\*+)\s*$/i;

interface PipeRow {
  line: number;
  cells: string[];
  /** Text after the closing pipe (a heading the converter glued on). */
  trailing: string;
  sep: boolean;
}

function splitPipeRow(text: string, line: number): PipeRow {
  const t = text.trim();
  const parts = t.split(/(?<!\\)\|/);
  const trailing = parts[parts.length - 1].trim();
  const cells = parts.slice(1, -1).map((c) => c.replace(/\\\|/g, '|').trim());
  const sep = cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c.replace(/\s/g, '')));
  return { line, cells, trailing, sep };
}

interface PipeTableRaw {
  header: PipeRow | null;
  rows: PipeRow[];
  start: number;
  end: number;
}

interface PrevPipe {
  built: Built;
  raw: PipeTableRaw;
  columns: string[];
  width: number;
  header: string[] | null;
  scale: Scale | null;
  date: { key: string; span: string | null } | null;
}

function pipeTables(lines: string[]): Built[] {
  const isPipe = (i: number) => PIPE_LINE.test(lines[i] ?? '');
  // blocks of consecutive pipe lines, cut into tables at each header (a row followed by a separator)
  const raws: PipeTableRaw[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isPipe(i)) continue;
    const block: PipeRow[] = [];
    while (i < lines.length && isPipe(i)) {
      block.push(splitPipeRow(lines[i], i + 1));
      i++;
    }
    let cur: PipeTableRaw | null = null;
    for (let k = 0; k < block.length; k++) {
      const r = block[k];
      if (r.sep) continue;
      const next = block[k + 1];
      if (next?.sep) {
        const m = next.cells.length;
        if (r.cells.length > m && cur) {
          // "…|原因||利润表项目|本期发生额|…": the row above and the next table's header on one line
          const lead = r.cells.slice(0, r.cells.length - m);
          while (lead.length && lead[lead.length - 1] === '') lead.pop();
          if (lead.length) cur.rows.push({ ...r, cells: lead, trailing: '' });
          r.cells = r.cells.slice(r.cells.length - m);
        }
        // a page break the converter wrote as a new table: its "header" is a row of the table going on
        // ("|交易性金融负债|交易性金融负债|-|-|") or nothing at all ("|-|-|-|")
        if (cur && looksLikeRow(r.cells)) {
          if (r.cells.some((c, j) => j > 0 && parseCell(c).kind !== 'empty' && parseCell(c).kind !== 'dash') || !isDashRow(r.cells)) cur.rows.push(r);
          cur.end = next.line;
          k++;
          continue;
        }
        if (looksLikeRow(r.cells)) {
          // a part after a page break whose first row the converter made a header: no header, so it may continue the table above
          cur = { header: null, rows: isDashRow(r.cells) ? [] : [r], start: r.line, end: next.line };
          raws.push(cur);
          k++;
          continue;
        }
        cur = { header: r, rows: [], start: r.line, end: next.line };
        raws.push(cur);
        k++;
        continue;
      }
      if (!cur) {
        cur = { header: null, rows: [], start: r.line, end: r.line };
        raws.push(cur);
      }
      cur.rows.push(r);
      cur.end = r.line;
    }
  }

  const built: Built[] = [];
  let prev: PrevPipe | null = null as PrevPipe | null;
  for (const raw of raws) {
    let headerRows: string[][] = raw.header ? [raw.header.cells] : [];
    let body = raw.rows;
    // no separator: leading rows without a value are the header
    if (!raw.header) {
      let h = 0;
      // a header names its columns: text in them, not numbers, and not dashes (a row with nothing to report)
      const named = (cells: string[]) => {
        const kinds = cells.slice(1).map((c) => parseCell(c).kind);
        return kinds.some((k) => k === 'text') && !kinds.some((k) => k === 'number' || k === 'dash');
      };
      while (h < Math.min(2, body.length - 1) && named(body[h].cells)) h++;
      headerRows = body.slice(0, h).map((r) => r.cells);
      body = body.slice(h);
    }
    if (!body.length) continue;
    const widthCounts = new Map<number, number>();
    for (const r of body) widthCounts.set(r.cells.length, (widthCounts.get(r.cells.length) ?? 0) + 1);
    const modal = [...widthCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const width = headerRows.length ? headerRows[0].length : modal;
    if (width < 2) continue;

    // a page break: a part with no header of its own (or the same header again), the same width, only page furniture between
    const gapClean = prev !== null && lines.slice(prev.raw.end, raw.start - 1).every((l) => isBlank(l) || PAGE_JUNK.test(l));
    const sameHeader = Boolean(prev?.header) && headerRows.length > 0 && headerRows[0].join('|') === prev!.header!.join('|');
    const continues: boolean = prev !== null && gapClean && prev.width === width && (!headerRows.length || sameHeader);

    const isTableLine = (i: number) => PIPE_LINE.test(lines[i] ?? '');
    const above = aboveTable(lines, raw.start - 1, -1, isTableLine);
    // text glued after the previous table's last pipe is this table's title when nothing stands between
    if (!above.title && prev) {
      const lastRow = prev.raw.rows[prev.raw.rows.length - 1];
      const notes = lines.slice(prev.raw.end, raw.start - 1).every((l) => isBlank(l) || scaleIn(l) !== null || dateLine(l) !== null || CHECKBOX.test(l.trim()));
      if (lastRow?.trailing && notes && !/^(?:法定代表人|主管会计|会计机构负责人)/.test(lastRow.trailing)) above.title = titleText(lastRow.trailing);
    }
    const title = continues ? prev!.built.table.title : above.title;
    const scale: Scale | null = (continues ? prev!.scale : null) ?? above.scale ?? headerScale(headerRows);
    const date: { key: string; span: string | null } | null = continues ? prev!.date : above.date;
    const columns: string[] = continues && !headerRows.length ? prev!.columns : joinHeader(headerRows, width);

    const labelCol = SERIAL_HEADER.test(columns[0] ?? '') && body.every((r) => /^\d*$/.test(r.cells[0] ?? '')) ? 1 : 0;
    const skip = new Set<number>([labelCol]);
    columns.forEach((c, i) => { if (NOTE_HEADER.test(c.replace(/\s/g, ''))) skip.add(i); });
    if (labelCol === 1) skip.add(0);
    const valueCols = columns.map((_, i) => i).filter((i) => !skip.has(i));

    const no = built.length + 1;
    const table: ParsedTable = {
      no,
      parser: 'pipe',
      startLine: raw.start,
      endLine: raw.end,
      title,
      scale,
      columns: valueCols.map((i) => columns[i] ?? ''),
      valueLines: [],
      confidence: 1,
      continues: continues ? prev!.built.table.continues ?? prev!.built.table.no : null,
    };
    const facts: Built['facts'] = [];
    let section: string | null = continues ? lastSection(prev!.built) : null;
    let irregular = 0;
    for (const r of body) {
      let cells = r.cells;
      if (cells.length === width + 1 && cells[0] === cells[1]) cells = cells.slice(1);
      else if (cells.length > width && cells.slice(width).every((c) => c === '')) cells = cells.slice(0, width);
      else if (cells.length === width - 1 && r.trailing) cells = [...cells, r.trailing];
      if (cells.length !== width) irregular++;
      const label = (cells[labelCol] ?? '').trim();
      if (!label || /^[-—–]+$/.test(label)) continue;
      const values = valueCols.map((i) => cells[i] ?? '');
      const kinds = values.map((v) => parseCell(v).kind);
      if (/[：:]$/.test(label) && kinds.every((k) => k === 'dash' || k === 'empty')) {
        section = label.replace(/[：:]$/, '').trim();
        continue;
      }
      let numeric = false;
      valueCols.forEach((ci, j) => {
        const header = columns[ci] ?? '';
        const p = resolveCurrent(parsePeriod(header), date);
        const f = factOf(
          { line: r.line, col: j, section, label, period: header, periodKey: p.key, periodSpan: p.span, parser: 'pipe', confidence: 1 },
          values[j],
          scale,
        );
        if (!f) return;
        if (f.valueNum !== null) numeric = true;
        facts.push(f);
      });
      if (numeric) table.valueLines.push(r.line);
    }
    table.confidence = body.length ? Math.max(0.5, 1 - irregular / body.length / 2) : 1;
    for (const f of facts) f.confidence = table.confidence;
    const b = { table, facts };
    built.push(b);
    prev = { built: b, raw, columns, width, header: headerRows[0] ?? prev?.header ?? null, scale, date };
  }
  return built;
}

/** A header row that is a row of values (a label, then only numbers or dashes), or dashes only. */
function looksLikeRow(cells: string[]): boolean {
  const c = cells.length > 2 && cells[0] && cells[0] === cells[1] ? cells.slice(1) : cells;
  if (isDashRow(c)) return true;
  const kinds = c.slice(1).map((x) => parseCell(x).kind);
  return kinds.length > 0 && kinds.every((k) => k !== 'text') && kinds.some((k) => k === 'number' || k === 'dash');
}

function isDashRow(cells: string[]): boolean {
  return cells.every((x) => { const k = parseCell(x).kind; return k === 'dash' || k === 'empty'; });
}

function lastSection(b: Built): string | null {
  return b.facts.length ? b.facts[b.facts.length - 1].section : null;
}

function joinHeader(rows: string[][], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const parts = rows.map((r) => (r[i] ?? '').trim()).filter((p) => p && p !== '-');
    out.push([...new Set(parts)].join(' '));
  }
  return out;
}

function headerScale(rows: string[][]): Scale | null {
  for (const r of rows) {
    const s = scaleIn(r.join(' '));
    if (s) return s;
  }
  return null;
}

/* ------------------------------ aligned tables ----------------------------- */

interface Field {
  text: string;
  /** Display columns (a CJK character is two wide), end exclusive. */
  start: number;
  end: number;
  /** Where the number starts, after a currency sign standing apart ("$      101,665"). */
  numStart?: number;
}

function wide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += wide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

/** Fields of a line: runs separated by two or more spaces (or a tab); a lone "$" joins the field after it. */
function fieldsOf(line: string): Field[] {
  const out: Field[] = [];
  let col = 0;
  let cur: { text: string; start: number; end: number } | null = null;
  let spaces = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0)!;
    if (ch === '\t' || ch === ' ' || ch === ' ') {
      const w = ch === '\t' ? 8 - (col % 8) : 1;
      spaces += ch === '\t' ? 2 : 1;
      col += w;
      continue;
    }
    if (cur && spaces >= 2) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = { text: '', start: col, end: col };
    else if (spaces === 1) cur.text += ' ';
    spaces = 0;
    cur.text += ch;
    col += wide(code) ? 2 : 1;
    cur.end = col;
  }
  if (cur) out.push(cur);
  // a value and the next column's currency sign one space apart: "(0.04) $"
  for (let i = 0; i < out.length; i++) {
    const m = /^(.*[\d)%])\s(\$|US\$)$/.exec(out[i].text);
    if (!m || !isValueCell(m[1])) continue;
    const f = out[i];
    const firstEnd = f.start + displayWidth(m[1]);
    out.splice(i, 1, { text: m[1], start: f.start, end: firstEnd }, { text: m[2], start: firstEnd + 1, end: f.end });
    i++;
  }
  // "$" alone, then its number
  const merged: Field[] = [];
  for (let i = 0; i < out.length; i++) {
    const f = out[i];
    if (/^(?:\$|US\$|¥|￥|RMB|HK\$)$/.test(f.text) && out[i + 1]) {
      merged.push({ text: `${f.text} ${out[i + 1].text}`, start: f.start, end: out[i + 1].end, numStart: out[i + 1].start });
      i++;
    } else merged.push(f);
  }
  return merged;
}

interface ValueRow {
  index: number;
  label: string;
  values: Field[];
  /** The values were read token by token (single spaces between): their columns are by order only. */
  ordinal: boolean;
}

const YEAR_LABEL = /^(?:19|20)\d{2}$/;

/** The label and the values of a line, when it ends in values; null for any other line. */
function valueRow(line: string, index: number): ValueRow | null {
  if (isBlank(line) || PIPE_LINE.test(line) || HEADING.test(line)) return null;
  const fields = fieldsOf(line);
  // a line of years ("2024    2023") heads columns; it is not a row
  if (fields.length && fields.every((f) => /^(?:FY\s?)?(?:19|20)\d{2}[*]?$/i.test(f.text))) return null;
  let k = fields.length;
  while (k > 0) {
    const kind = parseCell(fields[k - 1].text).kind;
    if (kind !== 'number' && kind !== 'dash') break;
    k--;
  }
  // a year in the first field is the row's label (a table by year)
  if (k === 0 && fields.length > 1 && YEAR_LABEL.test(fields[0].text)) k = 1;
  let values = fields.slice(k);
  let labelFields = fields.slice(0, k);
  let ordinal = false;
  if (!values.some((v) => parseCell(v.text).kind === 'number')) {
    // single spaces between: "Accounts payable 14,802 12,236"
    const tokens = tokenSpans(line);
    let j = tokens.length;
    while (j > 0) {
      const kind = parseCell(tokens[j - 1].text).kind;
      if (kind !== 'number' && kind !== 'dash') break;
      j--;
    }
    const tail = tokens.slice(j);
    const label = tokens.slice(0, j).map((t) => t.text).join(' ');
    const numbers = tail.filter((t) => parseCell(t.text).kind === 'number').length;
    // two values, or one after a short label that is no sentence ("Goodwill 47,064"); two with no label are a row whose label stands above
    if (numbers < 2 && !(numbers === 1 && label.length <= 60 && !/[.。;；:：,，]\s*$/.test(label))) return null;
    if (j > 0 && !/[A-Za-z\u4e00-\u9fff]/.test(label)) return null;
    values = tail;
    labelFields = tokens.slice(0, j);
    ordinal = true;
  }
  const label = labelFields.map((f) => f.text).join(' ').trim();
  // "(unaudited)   2023", "Fiscal   2024   2023": years over columns are a header
  if (values.every((v) => /^(?:19|20)\d{2}$/.test(v.text) || parseCell(v.text).kind === 'dash')) return null;
  // a sentence that happens to end in numbers is not a row
  if (label.length > 140 || /[.。;；]\s*$/.test(label)) return null;
  if (!values.some((v) => parseCell(v.text).kind === 'number')) return null;
  return { index, label, values, ordinal };
}

/** Whitespace-separated tokens with display spans, a currency sign joined to its number. */
function tokenSpans(line: string): Field[] {
  const out: Field[] = [];
  let col = 0;
  let cur: Field | null = null;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t' || ch === ' ') {
      if (cur) out.push(cur);
      cur = null;
      col += ch === '\t' ? 8 - (col % 8) : 1;
      continue;
    }
    if (!cur) cur = { text: '', start: col, end: col };
    cur.text += ch;
    col += wide(ch.codePointAt(0)!) ? 2 : 1;
    cur.end = col;
  }
  if (cur) out.push(cur);
  // what a PDF's text layer splits: "$ 955,793", "(125,006 )", "4.00 %", "$ (1,440)"
  const merged: Field[] = [];
  for (let i = 0; i < out.length; i++) {
    let f = out[i];
    if (/^(?:\$|US\$|¥|￥)$/.test(f.text) && out[i + 1]) {
      f = { text: `${f.text} ${out[i + 1].text}`, start: f.start, end: out[i + 1].end, numStart: out[i + 1].start };
      i++;
    }
    if (/\(\s*[\d,.]+$/.test(f.text) && out[i + 1]?.text === ')') {
      f = { ...f, text: `${f.text})`, end: out[i + 1].end };
      i++;
    }
    if (/\d$/.test(f.text) && (out[i + 1]?.text === '%' || out[i + 1]?.text === '％')) {
      f = { ...f, text: `${f.text}%`, end: out[i + 1].end };
      i++;
    }
    merged.push(f);
  }
  return merged;
}

function isProse(line: string): boolean {
  const t = line.trim();
  if (t.length > 160 && !/\s{3,}/.test(t)) return true;
  if (t.length > 90 && /[.。;；:]$/.test(t) && !/\s{3,}/.test(t)) return true;
  // Chinese: a line of many characters with a sentence's punctuation, or ending in one
  const han = t.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return ((han >= 4 && /[，。；]/.test(t)) || han >= 30) && !/\s{3,}/.test(t) && !/^[\u4e00-\u9fff（）()、：:]+$/.test(t);
}

const PERIODISH = /(?:19|20)\d{2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|months|year|quarter|期末|期初|本期|上期|本年|上年|年初|年末|current|prior|total|amount|balance|%/i;

function alignedTables(lines: string[]): Built[] {
  const rows = new Map<number, ValueRow>();
  lines.forEach((l, i) => {
    const r = valueRow(l, i);
    if (r) rows.set(i, r);
  });
  const regions: { start: number; end: number; rows: ValueRow[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!rows.has(i)) continue;
    const region = { start: i, end: i, rows: [rows.get(i)!] };
    let blanks = 0;
    let others = 0;
    for (let k = i + 1; k < lines.length; k++) {
      if (isBlank(lines[k])) {
        if (++blanks > 8) break;
        continue;
      }
      blanks = 0;
      if (rows.has(k)) {
        region.rows.push(rows.get(k)!);
        region.end = k;
        others = 0;
        continue;
      }
      // a statement's name or a scale note starts another table ("2、母公司资产负债表", "单位：元")
      const t = lines[k].trim();
      if ((t.length <= 40 && NEW_STATEMENT.test(t) && !/[:：]$/.test(t) && !/[\d,]{4,}/.test(t)) || scaleIn(t)) break;
      if (PIPE_LINE.test(lines[k]) || HEADING.test(lines[k]) || isProse(lines[k]) || ++others > 5) break;
    }
    i = region.end;
    if (region.rows.filter((r) => r.values.some((v) => parseCell(v.text).kind === 'number')).length >= 2) regions.push(region);
  }

  const built: Built[] = [];
  let prevEnd = -1;
  let prev: Built | null = null;
  for (const region of regions) {
    // a statement cut in two by a page break: the part below has no note and no header of its own
    const near = prev && region.start - prev.table.endLine <= 40 ? prev : null;
    const b = alignedTable(lines, region, prevEnd, built.length + 1, near);
    prevEnd = region.end;
    if (b) {
      built.push(b);
      prev = b;
    }
  }
  return built;
}

interface Column {
  start: number;
  end: number;
  /** Right edges of the values that fall in it. */
  ends: number[];
}

function clusterColumns(rs: ValueRow[]): Column[] {
  const ends = rs.flatMap((r) => r.values.map((v) => ({ end: v.end, start: v.numStart ?? v.start }))).sort((a, b) => a.end - b.end);
  const cols: Column[] = [];
  for (const e of ends) {
    const last = cols[cols.length - 1];
    if (last && e.end - last.ends[last.ends.length - 1] <= 2) {
      last.ends.push(e.end);
      last.start = Math.min(last.start, e.start);
      last.end = Math.max(last.end, e.end);
    } else cols.push({ start: e.start, end: e.end, ends: [e.end] });
  }
  const minSupport = rs.length <= 3 ? 1 : 2;
  return cols.filter((c) => c.ends.length >= minSupport);
}

function columnOf(cols: Column[], f: Field): number {
  let best = -1;
  let dist = Infinity;
  cols.forEach((c, i) => {
    const lo = Math.min(...c.ends);
    const hi = Math.max(...c.ends);
    const d = f.end < lo ? lo - f.end : f.end > hi ? f.end - hi : 0;
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return dist <= 3 ? best : -1;
}

const TITLE_CAPS = /^[A-Z0-9 ,.'’&()\-–—/]+$/;
/** A statement's own name: where one table ends and the next begins. */
const NEW_STATEMENT = /statements? of|balance sheets?|资产负债表|利润表|损益表|现金流量表|权益变动表/i;
const STATEMENT_TITLE = /balance sheets?|statements? of|资产负债表|利润表|损益表|现金流量表|权益变动表|financial (?:position|condition)|cash flows|operations|comprehensive (?:income|loss)/i;

function alignedTable(lines: string[], region: { start: number; end: number; rows: ValueRow[] }, prevEnd: number, no: number, near: Built | null): Built | null {
  const aligned = region.rows.filter((r) => !r.ordinal);
  const ordinalShare = 1 - aligned.length / region.rows.length;
  if (ordinalShare > 0.5) return ordinalTable(lines, region, prevEnd, no, near);
  let cols = clusterColumns(aligned.length >= 2 ? aligned : region.rows);
  const modalCount = (() => {
    const c = new Map<number, number>();
    for (const r of region.rows) c.set(r.values.length, (c.get(r.values.length) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
  })();
  if (!cols.length) return null;
  const labelEdge = Math.min(...cols.map((c) => c.start));

  // what stands above the columns: header lines, read upward from the first row
  const headerLines: Field[][] = [];
  let scaleAbove: Scale | null = null;
  let titleAbove: string | null = null;
  let dateAbove: { key: string; span: string | null } | null = null;
  let sectionAbove: string | null = null;
  let seen = 0;
  // once the statement's name or an introducing sentence is passed, only the scale note and a date are still looked for
  let headerDone = false;
  let titleStrong = false;
  for (let i = region.start - 1; i > prevEnd && i >= 0 && seen < 14; i--) {
    const s = lines[i];
    if (isBlank(s)) continue;
    seen++;
    if (isProse(s) || PIPE_LINE.test(s)) break;
    scaleAbove ??= scaleIn(s);
    dateAbove ??= dateLine(s);
    if (titleStrong && scaleAbove) break;
    const fields = fieldsOf(s);
    const trimmed = s.trim();
    const single = fields.length === 1 && !scaleIn(s) && !dateLine(s) && trimmed.length <= 120 && !/^\(.*\)$/.test(trimmed);
    if (single && STATEMENT_TITLE.test(trimmed) && !titleStrong) {
      titleAbove = titleText(trimmed);
      titleStrong = true;
      headerDone = true;
      continue;
    }
    if (headerDone) continue;
    // a sentence introducing the table ("The following table summarizes …:") ends the header
    if (fields.length === 1 && (trimmed.split(/\s+/).length >= 8 || /^(?:the|a|an|following|below|as follows)\b.*[:：]$/i.test(trimmed))) {
      titleAbove ??= titleText(trimmed);
      headerDone = true;
      continue;
    }
    // what stands over the columns, a scale note there aside ("($ in thousands, except share data)")
    const over = fields.filter((f) => f.end > labelEdge - 1 && !scaleIn(f.text));
    if (over.length && !(TITLE_CAPS.test(trimmed) && !/\d/.test(trimmed) && fields.length === 1 && !PERIODISH.test(trimmed))) {
      if (headerLines.length < 6) headerLines.unshift(over);
      continue;
    }
    if (single) {
      if (TITLE_CAPS.test(trimmed) && /[A-Z]{3,}\s+[A-Z]{2,}/.test(trimmed)) {
        titleAbove = titleText(trimmed);
        headerDone = true;
        continue;
      }
      // a label in front of the first rows ("Current assets:", "ASSETS") is their section
      if (!headerLines.length && fields[0].end <= labelEdge && !sectionAbove) sectionAbove = trimmed.replace(/[：:]$/, '');
      else titleAbove ??= titleText(trimmed);
    }
  }
  const headerOf = (hl: Field[][]) => {
    const parts: string[][] = cols.map(() => []);
    for (const fs of hl) {
      // one field alone on its line heads every column ("For the three months ended", "March 31,")
      if (fs.length === 1 && cols.length > 1) {
        const f = fs[0];
        const centre = (f.start + f.end) / 2;
        const centres = cols.map((c) => (c.start + c.end) / 2);
        const spacing = (centres[centres.length - 1] - centres[0]) / (centres.length - 1) || 1;
        const reaches = cols.filter((c) => Math.min(f.end, c.end) - Math.max(f.start, c.start) > 0).length;
        const offCentre = Math.min(...centres.map((c) => Math.abs(c - centre))) > spacing * 0.2;
        if (reaches >= 2 || (offCentre && centre > centres[0] - spacing / 2 && centre < centres[centres.length - 1] + spacing / 2)) {
          for (const p of parts) p.push(f.text);
          continue;
        }
      }
      const sparse = fs.length < cols.length;
      for (const f of fs) {
        // a header stands over its column, right-aligned or centred; on a line with fewer fields than columns
        // a field heads every column it reaches ("Common Stock" over Shares and Amount)
        const overlaps = cols.map((c) => Math.min(f.end, c.end) - Math.max(f.start, c.start));
        const widths = cols.map((c) => c.end - c.start);
        let over = overlaps.map((o, i) => (o > 0 && (sparse || o >= widths[i] * 0.5 || o >= (f.end - f.start) * 0.5) ? i : -1)).filter((i) => i >= 0);
        if (!over.length) {
          const best = overlaps.reduce((b, o, i) => (o > overlaps[b] ? i : b), 0);
          if (overlaps[best] > -3) over = [best];
        }
        for (const i of over) parts[i].push(f.text);
      }
    }
    return parts.map((p) => p.join(' ').replace(/\s+/g, ' ').trim());
  };
  let header = headerOf(headerLines);
  let scale = scaleAbove ?? headerScale([headerLines.flat().map((f) => f.text)]);
  let continues: number | null = null;
  if (near && !titleStrong && !header.some((h) => h) && near.table.columns.length === cols.length) {
    header = [...near.table.columns];
    scale ??= near.table.scale;
    titleAbove = near.table.title;
    continues = near.table.continues ?? near.table.no;
  }

  const facts: Built['facts'] = [];
  const valueLines: number[] = [];
  let assigned = 0;
  let total = 0;
  let labelled = 0;
  let section: string | null = sectionAbove;
  let pendingHeader: Field[][] = [];
  let prevText: { text: string; index: number } | null = null;
  const rowsByIndex = new Map(region.rows.map((r) => [r.index, r]));
  for (let i = region.start; i <= region.end; i++) {
    const s = lines[i];
    if (isBlank(s)) continue;
    const r = rowsByIndex.get(i);
    if (!r) {
      const fields = fieldsOf(s);
      const over = fields.filter((f) => f.end > labelEdge - 1);
      if (over.length && PERIODISH.test(s)) {
        // a header again inside the table: the part after a page break, or the next statement's columns
        pendingHeader.push(over);
        continue;
      }
      if (fields.length && fields[fields.length - 1].end <= labelEdge) {
        prevText = { text: fields.map((f) => f.text).join(' '), index: i };
        section = prevText.text.replace(/[：:]$/, '').trim();
      }
      continue;
    }
    if (pendingHeader.length) {
      const next = headerOf(pendingHeader);
      if (next.some((h) => h)) header = next;
      pendingHeader = [];
    }
    let label = r.label;
    // a label wrapped onto two lines: the first part stands alone above
    if (prevText && i - prevText.index <= 2 && (/^[a-z(]/.test(label) || /(?:[,\-–(&]|\b(?:and|of|for|to|in|on|from|the|net))$/i.test(prevText.text))) {
      label = `${prevText.text} ${label}`.trim();
      section = null;
    }
    prevText = null;
    if (label) labelled++;
    const used = new Set<number>();
    const placed: { col: number; field: Field }[] = [];
    r.values.forEach((v, j) => {
      total++;
      let col = r.ordinal ? -1 : columnOf(cols, v);
      if (col < 0 && r.values.length === cols.length) col = j;
      else if (col < 0 && r.ordinal && r.values.length === modalCount && modalCount === cols.length) col = j;
      if (col < 0 || used.has(col)) return;
      used.add(col);
      assigned++;
      placed.push({ col, field: v });
    });
    if (!label) continue;
    let numeric = false;
    for (const { col, field } of placed) {
      const p = resolveCurrent(parsePeriod(header[col] ?? ''), dateAbove);
      const f = factOf(
        { line: i + 1, col, section: section && section !== label ? section : null, label, period: header[col] ?? '', periodKey: p.key, periodSpan: p.span, parser: 'text', confidence: 0 },
        field.text,
        scale,
      );
      if (!f) continue;
      if (f.valueNum !== null) numeric = true;
      facts.push(f);
    }
    if (numeric) valueLines.push(i + 1);
  }
  // a table of contents (page numbers) or a list of small counts with no header is not a statement table
  const nums = facts.filter((f) => f.valueNum !== null);
  if (!nums.length) return null;
  const headed = header.filter((h) => h).length / cols.length;
  if (!header.some((h) => PERIODISH.test(h)) && nums.every((f) => Number.isInteger(f.valueNum) && Math.abs(f.valueNum!) <= 500)) return null;
  const confidence = round2((total ? assigned / total : 0) * (0.6 + 0.4 * headed) * (0.7 + 0.3 * (labelled / region.rows.length)) * (ordinalShare > 0.5 ? 0.7 : 1));
  for (const f of facts) f.confidence = confidence;
  return {
    table: {
      no,
      parser: 'text',
      startLine: region.start + 1,
      endLine: region.end + 1,
      title: titleAbove,
      scale,
      columns: header,
      valueLines,
      confidence,
      continues,
    },
    facts,
  };
}

/* --------------------------- single-spaced tables -------------------------- */

/**
 * The periods a header line names, in order: "February 3, 2024 January 28, 2023",
 * "2023 2022", "2022 年末 2022 年初", "本期发生额 上期发生额".
 */
const PERIOD_TOKENS = /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+(?:19|20)\d{2}|(?:19|20)\d{2}\s*年\s*(?:\d{1,2}\s*月\s*\d{1,2}\s*日|[末初]|度)?|(?:FY\s?)?(?:19|20)\d{2}|本期发生额|上期发生额|本期金额|上期金额|期末余额|期初余额|期末数|期初数|本年数|上年数|本年金额|上年金额|本期|上期|本年|上年|年末|年初/gi;

const MONTH_DAY = /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?/gi;
/** Words that name a column rather than a row. */
const COLUMN_WORD = /金额|比例|比重|占|增减|变动|变化|本期|上期|期末|期初|余额|数量|附注|amount|total|change|percent|%|shares|price|balance|actual|budget/i;

function periodTokens(line: string): string[] {
  return (line.normalize('NFKC').match(PERIOD_TOKENS) ?? []).map((t) => t.replace(/\s+/g, ' ').trim());
}

const PAGE_MARK = /^\s*(?:<!--.*-->|\d{1,3}%|page \d+|(?!(?:19|20)\d{2}\s*$)\d{1,4})\s*$/i;

/**
 * A header a PDF wrote one piece per line ("September 30," / "2021" /
 * "September 30," / "2020"): the lines just above the first row that hold
 * only a period or a month and day, joined in order, when they make k periods.
 */
function stackedHeader(lines: string[], start: number, prevEnd: number, k: number): string[] | null {
  const pieces: string[] = [];
  let seen = 0;
  for (let i = start - 1; i > prevEnd && i >= 0 && seen < 2 * k + 6; i--) {
    const s = lines[i];
    if (isBlank(s) || PAGE_MARK.test(s)) continue;
    seen++;
    const t = s.trim();
    const only = (re: RegExp) => t.replace(re, '').replace(/[\s,]/g, '') === '';
    if (only(PERIOD_TOKENS) || only(MONTH_DAY)) {
      pieces.unshift(t);
      continue;
    }
    // a scale note or a section label may stand between the header and the rows
    if (pieces.length === 0 && (scaleIn(s) || /[:：]$/.test(t) || t.length <= 30)) continue;
    if (pieces.length) break;
  }
  const out: string[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev && new RegExp(`^(?:${MONTH_DAY.source})$`, 'i').test(prev.trim()) && /^(?:FY\s?)?(?:19|20)\d{2}$/i.test(p)) out[out.length - 1] = `${prev.replace(/,?\s*$/, ',')} ${p}`;
    else out.push(p);
  }
  return out.length === k ? out : null;
}

/**
 * A table whose numbers are one space apart (a PDF's text layer): columns are
 * the values' order, so a row with as many values as the table's usual count
 * is read value by value; one with fewer or more is left out (and lowers the
 * confidence: the model path is for those). Headers are the lines above that
 * name as many periods as there are columns.
 */
function ordinalTable(lines: string[], region: { start: number; end: number; rows: ValueRow[] }, prevEnd: number, no: number, near: Built | null): Built | null {
  const counts = new Map<number, number>();
  for (const r of region.rows) counts.set(r.values.length, (counts.get(r.values.length) ?? 0) + 1);
  const k = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];

  // above: the scale note, a title, and the header naming k periods (a line naming fewer groups them)
  let scale: Scale | null = null;
  let title: string | null = null;
  let date: { key: string; span: string | null } | null = null;
  let header: string[] = [];
  let group: string[] = [];
  let sectionAbove: string | null = null;
  let seen = 0;
  for (let i = region.start - 1; i > prevEnd && i >= 0 && seen < 10; i--) {
    const s = lines[i];
    if (isBlank(s) || PAGE_MARK.test(s)) continue;
    seen++;
    if (isProse(s) || PIPE_LINE.test(s)) break;
    scale ??= scaleIn(s);
    date ??= dateLine(s);
    const trimmed = s.trim();
    // "流动资产：", "Current assets:" just above the first row: its section
    if (!header.length && !sectionAbove && /[:：]$/.test(trimmed) && trimmed.length <= 40) {
      sectionAbove = trimmed.replace(/[:：]$/, '');
      continue;
    }
    const periods = periodTokens(s);
    if (!header.length && periods.length === k) {
      header = periods;
      // "January 28, January 29," over "2023 2022": the month and day stand on the line above
      const above = lines.slice(Math.max(0, i - 3), i).reverse().find((l) => !isBlank(l) && !PAGE_MARK.test(l));
      const days = above?.match(MONTH_DAY) ?? [];
      if (days.length === k && periods.every((p) => /^(?:FY\s?)?(?:19|20)\d{2}$/i.test(p))) header = periods.map((p, j) => `${days[j].replace(/,?\s*$/, ',')} ${p}`);
      continue;
    }
    if (header.length && !group.length && periods.length > 0 && periods.length < k) {
      group = periods;
      // "2022 年 2021 年 同比增减" over "金额 占比 金额 占比": a column named only on the group line comes last
      const rest = s.normalize('NFKC').replace(PERIOD_TOKENS, ' ').trim().split(/\s+/).filter((t) => t && COLUMN_WORD.test(t));
      if (header.length === k - rest.length && rest.length) header = [...header, ...rest];
      continue;
    }
    if (!header.length && !periods.length) {
      // column names without a period ("金额 占总资产比例 金额 占总资产比例 比重增减"), the label column's name first
      const tokens = s.trim().split(/\s+/);
      // one or two short of k: the rest are named on the group line above
      const named = tokens.length === k + 1 ? tokens.slice(1) : tokens.length >= k - 2 && tokens.length <= k && tokens.length > 1 ? tokens : null;
      if (named && named.every((t) => t.length <= 12 && !isValueCell(t)) && named.some((t) => COLUMN_WORD.test(t)) && !/[:：]$/.test(s.trim()) && !NEW_STATEMENT.test(s) && !STATEMENT_TITLE.test(s)) {
        header = named;
        continue;
      }
    }
    if (!title && s.trim().length <= 100 && (STATEMENT_TITLE.test(s) || !periods.length)) title = titleText(s.trim());
    if (title && STATEMENT_TITLE.test(title) && header.length) break;
  }
  if (header.length !== k) header = stackedHeader(lines, region.start, prevEnd, k) ?? [];
  if (group.length && header.length && group.length < header.length) {
    const per = Math.floor(header.length / group.length);
    header = header.map((h, i) => (i < per * group.length && !periodTokens(h).length ? `${group[Math.floor(i / per)]} ${h}` : h));
  }
  let continues: number | null = null;
  if (!header.length && near && near.table.columns.length === k) {
    header = [...near.table.columns];
    scale ??= near.table.scale;
    title = near.table.title;
    continues = near.table.continues ?? near.table.no;
  }
  scale ??= near && region.start - near.table.endLine <= 40 ? near.table.scale : null;

  const facts: Built['facts'] = [];
  const valueLines: number[] = [];
  const rowsByIndex = new Map(region.rows.map((r) => [r.index, r]));
  let resolved = 0;
  let section: string | null = sectionAbove;
  let pending: { text: string; index: number } | null = null;
  for (let i = region.start; i <= region.end; i++) {
    const s = lines[i];
    if (isBlank(s) || PAGE_MARK.test(s)) continue;
    const r = rowsByIndex.get(i);
    if (!r) {
      const periods = periodTokens(s);
      if (periods.length === k && s.trim().length <= periods.join(' ').length + 30) {
        header = periods;
        continue;
      }
      const t = s.trim();
      if (/[:：]$/.test(t) && t.length <= 80) section = t.replace(/[:：]$/, '');
      pending = { text: t, index: i };
      continue;
    }
    let label = r.label;
    // a label written above its values ("Total assets" / "$ 7,269,597 $ 7,089,513"), or wrapped onto the values' line
    if (pending && i - pending.index <= 2 && (!label || /^[a-z(]/.test(label) || /(?:[,\-–—(&]|\b(?:and|of|for|to|in|on|from|the|net))$/i.test(pending.text))) {
      label = `${pending.text} ${label}`.trim();
    }
    pending = null;
    if (!label || r.values.length !== k) continue;
    resolved++;
    let numeric = false;
    r.values.forEach((v, col) => {
      const head = header[col] ?? '';
      const p = resolveCurrent(parsePeriod(head), date);
      const f = factOf(
        { line: i + 1, col, section: section && section !== label ? section : null, label, period: head, periodKey: p.key, periodSpan: p.span, parser: 'text', confidence: 0 },
        v.text,
        scale,
      );
      if (!f) return;
      if (f.valueNum !== null) numeric = true;
      facts.push(f);
    });
    if (numeric) valueLines.push(i + 1);
  }
  const nums = facts.filter((f) => f.valueNum !== null);
  if (!nums.length) return null;
  if (!header.some((h) => PERIODISH.test(h)) && nums.every((f) => Number.isInteger(f.valueNum) && Math.abs(f.valueNum!) <= 500)) return null;
  // by order, not by position: a little less sure than an aligned table, and less again without a header
  const confidence = round2((resolved / region.rows.length) * (header.length ? 0.9 : 0.6));
  for (const f of facts) f.confidence = confidence;
  return {
    table: { no, parser: 'text', startLine: region.start + 1, endLine: region.end + 1, title, scale, columns: header.length ? header : Array.from({ length: k }, () => ''), valueLines, confidence, continues },
    facts,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/* --------------------------------- subject --------------------------------- */

/**
 * The company a report is about, without a model: frontmatter-free title
 * forms the corpora use ("# 卡莱特（301391）2024年一季度报告", "# Dolphin
 * Entertainment, Inc. annual report (Form 10-K), 2024 file"), the cover's
 * 证券简称, the registrant line of a 10-K; else the title as given.
 */
export function documentSubject(text: string, title: string | null): string | null {
  const head = text.slice(0, 8000);
  const firstHeading = /^\s{0,3}#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  for (const t of [title, firstHeading]) {
    if (!t) continue;
    const zh = /^(.{2,30}?)[（(](?:\d{6}|[A-Z]{2,5}\d*)[)）]/.exec(t);
    if (zh) return zh[1].trim();
    const en = /^(.{2,120}?)\s+(?:annual|quarterly|interim|semi-annual)\s+report\b/i.exec(t) ?? /^(.{2,120}?)\s*[(（]form\s+10-[kq]/i.exec(t);
    if (en) return en[1].trim().replace(/[,;]$/, '');
    const zhReport = /^(.{2,30}?)(?:\d{4}\s*年)?(?:第?[一二三四1-4]季度|半年度|年度)?(?:报告|年报)(?:全文|摘要)?$/.exec(t);
    if (zhReport && !/^\d/.test(zhReport[1])) return zhReport[1].replace(/\d{4}\s*年.*$/, '').trim();
  }
  // "# 002699 2023年年度报告": the stock code, with the company's name when the cover gives it
  const code = /^(\d{6})\b/.exec((title ?? firstHeading ?? '').trim());
  if (code) {
    const name = /([\u4e00-\u9fff（）()]{2,24}?(?:股份有限公司|有限责任公司|有限公司))/.exec(head);
    return name ? `${code[1]} ${name[1]}` : code[1];
  }
  const short = /证券简称\s*[：:]\s*([^\s|，,]{2,12})/.exec(head);
  if (short) return short[1];
  const registrant = /\n\s*([^\n]{3,100}?)\s*\n[\s\S]{0,200}?\(\s*exact name of registrant/i.exec(head);
  if (registrant) return registrant[1].trim().replace(/\s{2,}/g, ' ');
  return title?.trim() || firstHeading || null;
}
