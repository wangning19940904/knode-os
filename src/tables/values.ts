/**
 * Reading the parts of a statement table that are not layout: a cell's value,
 * the scale a table states its amounts in, and the period a column header
 * names (docs/design/38 §3.2 item 1). Pure functions, no model.
 *
 * The scale is kept apart from the value, with its wording as written: a
 * table "单位：万元" holds 1,234 as value 1234, scale "单位：万元", factor 10⁴.
 * Most wrong answers on statement questions are off by exactly that factor,
 * so it is never folded into the value silently.
 */

export type CellKind = 'number' | 'dash' | 'empty' | 'text';

export interface CellValue {
  kind: CellKind;
  /** The signed number as written (no scale applied); null unless `kind` is number. */
  num: number | null;
  /** The cell as written, trimmed. */
  text: string;
  /** '%' for a percentage; a currency or count unit the cell itself writes. */
  unit: string | null;
  /** A scale the cell writes itself ("1.2亿", "3 million"): its factor and wording. */
  scale: { raw: string; factor: number } | null;
}

const DASH = /^[-－—–―‐−~～]{1,3}$/;
const EMPTY_WORDS = /^(?:n\/?a|none|nil|不适用|无|—|\*)$/i;
const CURRENCY_PREFIX = /^(?:US\$|HK\$|RMB|CNY|USD|HKD|[$¥￥€£])\s*/i;
const CELL_SCALE: { re: RegExp; factor: number }[] = [
  { re: /\s*(?:亿元|亿)$/, factor: 1e8 },
  { re: /\s*(?:万元|万)$/, factor: 1e4 },
  { re: /\s*(?:billion|bn)$/i, factor: 1e9 },
  { re: /\s*(?:million|mn|m)$/i, factor: 1e6 },
  { re: /\s*(?:thousand|k)$/i, factor: 1e3 },
];
const PLAIN_NUMBER = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^\d+(?:\.\d+)?$|^\.\d+$/;

/** The value of one table cell. Parentheses and a leading minus are negative; a dash is an empty value. */
export function parseCell(raw: string): CellValue {
  const text = (raw ?? '').replace(/ /g, ' ').trim();
  const out = (kind: CellKind, num: number | null = null, unit: string | null = null, scale: CellValue['scale'] = null): CellValue =>
    ({ kind, num, text, unit, scale });
  if (!text) return out('empty');
  if (DASH.test(text) || /^\$\s*[-—–]$/.test(text)) return out('dash');
  if (EMPTY_WORDS.test(text)) return out('dash');

  let s = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // a footnote mark or a trailing note reference: "1,234*", "1,234 (1)"
  s = s.replace(/\s*(?:\*+|\(\d\)|\[\d\])$/, '');
  let negative = false;
  let unit: string | null = null;
  let currency: string | null = null;
  // "$ (1,310,714)", "(1,310,714)", "-$0.04", "$(0.91)"
  for (let pass = 0; pass < 3; pass++) {
    const m = CURRENCY_PREFIX.exec(s);
    if (m) {
      currency = currencyOf(m[0].trim());
      s = s.slice(m[0].length).trim();
    }
    if (/^\(.*\)$/.test(s)) {
      negative = !negative;
      s = s.slice(1, -1).trim();
      continue;
    }
    if (/^[-−–]\s*/.test(s) && s.length > 1) {
      negative = !negative;
      s = s.replace(/^[-−–]\s*/, '');
      continue;
    }
    if (s.startsWith('+')) {
      s = s.slice(1).trim();
      continue;
    }
    if (!m) break;
  }
  if (/%$/.test(s)) {
    unit = '%';
    s = s.slice(0, -1).trim();
    // "(5.2)%" keeps its parentheses inside the percent sign
    if (/^\(.*\)$/.test(s)) {
      negative = !negative;
      s = s.slice(1, -1).trim();
    }
  }
  let scale: CellValue['scale'] = null;
  if (!unit) {
    for (const c of CELL_SCALE) {
      const m = c.re.exec(s);
      if (m && PLAIN_NUMBER.test(s.slice(0, m.index).trim())) {
        scale = { raw: m[0].trim(), factor: c.factor };
        s = s.slice(0, m.index).trim();
        break;
      }
    }
  }
  if (!PLAIN_NUMBER.test(s)) return out('text');
  const num = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(num)) return out('text');
  return out('number', negative ? -num : num, unit ?? currency, scale);
}

function currencyOf(prefix: string): string {
  const p = prefix.toUpperCase();
  if (p === '$' || p === 'US$' || p === 'USD') return 'USD';
  if (p === '¥' || p === '￥' || p === 'RMB' || p === 'CNY') return 'CNY';
  if (p === 'HK$' || p === 'HKD') return 'HKD';
  if (p === '€') return 'EUR';
  if (p === '£') return 'GBP';
  return p;
}

/** Whether a cell reads as a value (a number or a dash standing for none). */
export function isValueCell(raw: string): boolean {
  const k = parseCell(raw).kind;
  return k === 'number' || k === 'dash';
}

/* --------------------------------- scale --------------------------------- */

export interface Scale {
  /** The wording as the document writes it: "单位：元", "(in thousands, except per share data)". */
  raw: string;
  factor: number;
  /** The unit the wording names: 元, USD, 股, shares … */
  unit: string | null;
  /** "except per share" (and "except share"): those rows are as written. */
  exceptPerShare: boolean;
  exceptShares: boolean;
}

const ZH_SCALE = /(?:金额)?单位\s*(?:[：:]|均为|为)\s*(?:人民币|美元|港币|港元)?\s*(元|千元|万元|百万元|千万元|亿元|股|万股|亿股|%|％|美元|千美元|百万美元|港元|千港元)/;
const ZH_FACTOR: Record<string, { factor: number; unit: string }> = {
  元: { factor: 1, unit: '元' }, 千元: { factor: 1e3, unit: '元' }, 万元: { factor: 1e4, unit: '元' },
  百万元: { factor: 1e6, unit: '元' }, 千万元: { factor: 1e7, unit: '元' }, 亿元: { factor: 1e8, unit: '元' },
  股: { factor: 1, unit: '股' }, 万股: { factor: 1e4, unit: '股' }, 亿股: { factor: 1e8, unit: '股' }, '%': { factor: 1, unit: '%' }, '％': { factor: 1, unit: '%' },
  美元: { factor: 1, unit: 'USD' }, 千美元: { factor: 1e3, unit: 'USD' }, 百万美元: { factor: 1e6, unit: 'USD' },
  港元: { factor: 1, unit: 'HKD' }, 千港元: { factor: 1e3, unit: 'HKD' },
};
const EN_SCALE = /\(?[^()\n]{0,40}?\b(?:in|amounts in|dollars in|\$\s*in|expressed in|stated in)\s+(?:u\.?s\.?\s+)?(?:dollars\s+)?(thousands|millions|billions)\b[^()\n]{0,80}\)?/i;
const EN_SHORT = /\(\s*(?:\$|US\$|RMB|¥)?\s*(000|000s|000's|'000|mm|mn|m)\s*\)/i;
const EN_FACTOR: Record<string, number> = { thousands: 1e3, millions: 1e6, billions: 1e9 };

/** A scale stated in a line of text (a table's note, its header, a heading over it), or null. */
export function scaleIn(line: string): Scale | null {
  // matched on the line as written, so `raw` keeps its spelling (full-width colon and brackets included)
  const t = line;
  const zh = ZH_SCALE.exec(t);
  if (zh) {
    const f = ZH_FACTOR[zh[1]];
    if (f) return { raw: zh[0].trim(), factor: f.factor, unit: f.unit, exceptPerShare: false, exceptShares: false };
  }
  const zhParen = /[（(]\s*(?:单位\s*[：:])?\s*(人民币)?\s*(千元|万元|百万元|亿元)\s*[）)]/.exec(t);
  if (zhParen) {
    const f = ZH_FACTOR[zhParen[2]];
    return { raw: zhParen[0].trim(), factor: f.factor, unit: f.unit, exceptPerShare: false, exceptShares: false };
  }
  // a statement's heading line "2021 年度 人民币百万元": the currency and scale alone, no "单位"
  const bare = t.trim().length <= 30 ? /(?:^|\s)(人民币\s*(元|千元|万元|百万元|亿元))\s*$/.exec(t.trim()) : null;
  if (bare) {
    const f = ZH_FACTOR[bare[2]];
    return { raw: bare[1], factor: f.factor, unit: f.unit, exceptPerShare: false, exceptShares: false };
  }
  const en = EN_SCALE.exec(t);
  if (en) {
    const raw = en[0].trim();
    const currency = /\$|dollar/i.test(raw) ? 'USD' : /RMB|renminbi|yuan/i.test(raw) ? 'CNY' : null;
    return {
      raw,
      factor: EN_FACTOR[en[1].toLowerCase()],
      unit: currency,
      exceptPerShare: /except[^)]*per[- ]share/i.test(raw),
      exceptShares: /except[^)]*\bshares?\b(?![- ]?(?:data|amounts?)?\s*per)/i.test(raw.replace(/per[- ]share/gi, '')),
    };
  }
  const short = EN_SHORT.exec(t);
  if (short) {
    const k = short[1].toLowerCase();
    const factor = k.startsWith('m') ? 1e6 : 1e3;
    return { raw: short[0].trim(), factor, unit: /\$/.test(short[0]) ? 'USD' : null, exceptPerShare: false, exceptShares: false };
  }
  return null;
}

/** A unit a row label or a column header writes for itself: "营业收入（元）", "基本每股收益（元/股）", "Revenue ($ in millions)". */
export function ownUnit(text: string): { raw: string; unit: string; factor: number } | null {
  const t = text;
  const zh = /[（(]\s*(元[/／]股|元|千元|万元|百万元|亿元|[%％]|股|万股|人|个|次|倍|美元[/／]股)\s*[）)]\s*$/.exec(t) ?? /[（(]\s*(元[/／]股|[%％]|美元[/／]股)\s*[）)]/.exec(t);
  if (zh) {
    const u = zh[1].normalize('NFKC');
    if (u === '元/股') return { raw: zh[0].trim(), unit: '元/股', factor: 1 };
    if (u === '美元/股') return { raw: zh[0].trim(), unit: 'USD/股', factor: 1 };
    const f = ZH_FACTOR[u];
    return { raw: zh[0].trim(), unit: f?.unit ?? u, factor: f?.factor ?? 1 };
  }
  const s = scaleIn(t);
  if (s) return { raw: s.raw, unit: s.unit ?? '', factor: s.factor };
  return null;
}

const PER_SHARE = /per\s+(?:common\s+|ordinary\s+)?share|per\s+unit|\beps\b|每股/i;
const SHARE_COUNT = /\bshares?\b|\bunits\b|股数|股本数/i;
const RATIO = /率|比例|比率|ratio|margin|\brate\b|\byield\b/i;

/**
 * The scale a cell's value is in: the cell's own word, the row label's unit,
 * the column header's, the table's note — the nearest one that applies. Per
 * share rows and percentages are as written whatever the table says.
 */
export function effectiveScale(
  cell: CellValue,
  label: string,
  column: string,
  table: Scale | null,
): { raw: string | null; factor: number; unit: string | null } {
  if (cell.unit === '%') return { raw: null, factor: 1, unit: '%' };
  if (cell.scale) return { raw: cell.scale.raw, factor: cell.scale.factor, unit: cell.unit ?? table?.unit ?? null };
  const row = ownUnit(label);
  if (row) return { raw: row.raw, factor: row.factor, unit: row.unit || cell.unit || table?.unit || null };
  const col = ownUnit(column);
  if (col) return { raw: col.raw, factor: col.factor, unit: col.unit || cell.unit || table?.unit || null };
  if (table) {
    if (table.factor !== 1 && table.exceptPerShare && PER_SHARE.test(label)) return { raw: `${table.raw} (per share: as written)`, factor: 1, unit: table.unit ? `${table.unit}/share` : null };
    if (table.factor !== 1 && table.exceptShares && SHARE_COUNT.test(label) && !PER_SHARE.test(label)) return { raw: `${table.raw} (shares: as written)`, factor: 1, unit: 'shares' };
    if (table.factor !== 1 && RATIO.test(label) && cell.num !== null && Math.abs(cell.num) < 100 && !Number.isInteger(cell.num)) {
      // a ratio row in an amounts table ("毛利率 23.5") is not in thousands either; kept as written, wording noted
      return { raw: `${table.raw} (ratio: as written)`, factor: 1, unit: null };
    }
    return { raw: table.raw, factor: table.factor, unit: cell.unit ?? table.unit };
  }
  return { raw: null, factor: 1, unit: cell.unit };
}

/* --------------------------------- period -------------------------------- */

export interface Period {
  /** An ISO date (period end, or the balance date), a year, a quarter (2024-Q1), a half (2024-H1); or current / prior / change. */
  key: string | null;
  /** The length of a duration column: 3M, 6M, 9M, 12M; null for a balance date or when not stated. */
  span: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, '0');

const CURRENT = /本期|本报告期|本年|本季度|期末|本期末|报告期末|本年末|年末余额|期末余额|期末数|本年累计|年初至报告期末|本期金额|本期发生额|current\s+(?:year|period|quarter)/i;
const PRIOR = /上期|上年|上季度|去年|期初|年初|上年度末|上年末|同期|上期金额|上期发生额|prior\s+(?:year|period)|previous\s+(?:year|period)/i;
const CHANGE = /增减|变动|变化|增长率|同比|环比|比上年|change|increase|decrease|variance/i;

/** The period a column header names. */
export function parsePeriod(header: string): Period {
  const t = header.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!t) return { key: null, span: null };
  const span = spanOf(t);
  // a change column names the periods it compares: it is the change, not either period
  if (CHANGE.test(t) && !/^\s*(?:for the )?(?:three|six|nine|twelve)/i.test(t)) return { key: 'change', span: null };
  // 2024年3月31日, 2024年 03月 31日, 2024-03-31, 2024/3/31, 2024.03.31
  const zhDate = /((?:19|20)\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/.exec(t);
  if (zhDate) return { key: `${zhDate[1]}-${pad(+zhDate[2])}-${pad(+zhDate[3])}`, span };
  // March 31, 2024 / Mar. 31, 2024 / 31 March 2024
  const en = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i.exec(t)
    ?? (() => {
      const m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d{2})\b/i.exec(t);
      return m ? ([m[0], m[2], m[1], m[3]] as unknown as RegExpExecArray) : null;
    })();
  if (en) return { key: `${en[3]}-${pad(MONTHS[en[1].toLowerCase().slice(0, 3)])}-${pad(+en[2])}`, span };
  // 2024年第一季度 / Q1 2024 / 2024 Q1
  const q = /((?:19|20)\d{2})\s*年?\s*(?:第?\s*([一二三四1-4])\s*季度|Q([1-4]))/i.exec(t) ?? /\bQ([1-4])\s*((?:19|20)\d{2})\b/i.exec(t);
  if (q) {
    if (/^Q/i.test(q[0])) return { key: `${q[2]}-Q${q[1]}`, span: '3M' };
    const n = q[3] ?? ({ 一: '1', 二: '2', 三: '3', 四: '4' } as Record<string, string>)[q[2]] ?? q[2];
    return { key: `${q[1]}-Q${n}`, span: '3M' };
  }
  // 2024年1-3月 → the period ending with its last month
  const range = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*[-–至~]\s*(\d{1,2})\s*月/.exec(t);
  if (range) {
    const end = +range[3];
    const months = end - +range[2] + 1;
    return { key: `${range[1]}-${pad(end)}-${pad(lastDay(+range[1], end))}`, span: `${months}M` };
  }
  if (/半年/.test(t)) {
    const y = /((?:19|20)\d{2})/.exec(t);
    if (y) return { key: `${y[1]}-H1`, span: '6M' };
  }
  // a bare year: 2024, 2024年, 2024年度, FY2024, Fiscal 2024
  const years = t.match(/(?:19|20)\d{2}/g);
  if (years && years.length === 1 && /^(?:fy|fiscal(?: year)?)?\s*(?:19|20)\d{2}\s*(?:年度?|年末|年初|fy)?$/i.test(t.replace(/[()（）*]/g, '').trim())) {
    return { key: years[0], span: /年末|年初/.test(t) ? null : span };
  }
  if (years && years.length === 1 && !/\d{1,2}\s*[月日]/.test(t) && t.length <= 24) return { key: years[0], span };
  if (CURRENT.test(t)) return { key: 'current', span };
  if (PRIOR.test(t)) return { key: 'prior', span };
  return { key: null, span };
}

function spanOf(t: string): string | null {
  const m = /\b(three|six|nine|twelve|3|6|9|12)[- ]months?\b/i.exec(t);
  if (m) {
    const n = ({ three: 3, six: 6, nine: 9, twelve: 12 } as Record<string, number>)[m[1].toLowerCase()] ?? Number(m[1]);
    return `${n}M`;
  }
  if (/\b(?:fiscal\s+)?year(?:s)?\s+ended\b|\bannual\b|年度/i.test(t)) return '12M';
  if (/quarter\s+ended|季度/i.test(t)) return '3M';
  return null;
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The period a document reports on, as the ISO date it ends: "2024年一季度报告"
 * → 2024-03-31, "For the quarterly period ended March 31, 2024" → 2024-03-31,
 * "2023年年度报告" → 2023-12-31. A column read as `current` is that period.
 */
export function documentPeriod(text: string): string | null {
  const head = text.slice(0, 6000).normalize('NFKC');
  const en = /for the (?:quarterly |fiscal |transition )?(?:period|year|quarter)\s+ended:?\s+([A-Za-z]+\.?\s+\d{1,2},?\s+(?:19|20)\d{2})/i.exec(head);
  if (en) {
    const p = parsePeriod(en[1]);
    if (p.key && /^\d{4}-\d{2}-\d{2}$/.test(p.key)) return p.key;
  }
  const zh = /((?:19|20)\d{2})\s*年\s*(第一季度|一季度|第1季度|半年度|中期|第三季度|三季度|第3季度|年度)报告/.exec(head);
  if (zh) {
    const y = zh[1];
    const which = zh[2];
    if (/一|1/.test(which)) return `${y}-03-31`;
    if (/半年|中期/.test(which)) return `${y}-06-30`;
    if (/三|3/.test(which)) return `${y}-09-30`;
    return `${y}-12-31`;
  }
  const annual = /annual report[^\n]{0,60}?\b((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s+annual report/i.exec(head);
  if (annual) return `${annual[1] ?? annual[2]}-12-31`;
  return null;
}
