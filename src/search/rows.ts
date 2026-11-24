import { Store } from '../store/db.js';
import { Params, toDateString } from '../store/temporal.js';
import { SearchResult } from '../types.js';
import { quotedTerms } from './excerpts.js';

/**
 * Rows: for a question asking for a value, the lines of the documents already
 * retrieved that name the figure it asks for.
 *
 * On the 2026-11 evaluation the documents behind numeric questions were in
 * Ask's prompt for 0.96 of them, and only 45% were answered right: a filing is
 * about 87,000 characters, a passage at most 1,500, and the passage the search
 * returned was the statement's heading or the wrong period's table. What an
 * agent does is grep the filing for the line item. This does that once,
 * bounded: the question's metric words (a quoted term, else what is left of
 * the question once the things it names and its frame — "是多少", "what is
 * the … of" — are taken out), looked for in the chunks of the documents the
 * prompt already holds; each line holding one is shown with what it cannot be
 * read without — the header of its table and the line saying its unit — the
 * documents taking turns, at most `ROW_CHARS` in all. Each is an excerpt
 * passage: the prompt says such a passage holds only the lines naming what
 * the question asks about.
 */

/** Characters of rows given at most. */
export const ROW_CHARS = 6000;
/** One document's rows at most: a passage is shown up to 1,500 characters. */
export const ROW_DOC_CHARS = 1400;
/** Documents whose chunks are read for rows at most, in the prompt's order. */
export const ROW_DOCS = 16;
/** Lines of one document at most. */
const ROWS_PER_DOC = 6;
/** A line longer than this is cut to the part around its hit. */
const LINE_MAX = 420;
/** Chunks holding an anchor read at most. */
const SCAN_CAP = 240;

/**
 * Whether a question asks for a value: a figure, an amount, a comparison or a
 * trend of one. A false positive costs the rows' characters, and only when the
 * question's metric words are found in its documents.
 */
export function asksForValue(question: string): boolean {
  if (/是多少|为多少|有多少|多少[元万亿个]?|金额|数值|余额|数额|最高|最低|最多|最少|最大|最小|增长|增加|减少|下降|变化|趋势|变动|对比|比较|排序|递增|递减|划分|分类|占比|比率|比例|平均|合计|总和|总额/.test(question)) return true;
  const q = question.toLowerCase();
  return /\bwhat (?:is|was|are|were)\b|\bhow (?:much|many)\b|\b(?:highest|lowest|largest|smallest|most|least|total|amount|value|ratio|margin|per share|trend|change|increase|decrease|compare|categori[sz]e|rank)\b/.test(q);
}

/** What frames a value question in Chinese, after its subject: taken off the end of what is left, until none is left. */
const ZH_TAIL = /(?:(?:分别)?(?:是|为|有)?(?:多少|几)(?:[元万亿个次起人名天]|分钟|小时)?|(?:加起来|一共|总共|合计|累计)|在(?:这|该|各|此).*|是(?:什么|哪[个一家些]+)|呈现(?:了|出)?.*|发生了.*|有(?:何|什么)变化.*|的?(?:变化|发展)?趋势.*|的?变化(?:情况)?.*|最[高低多少大小]的.*|进行划分.*|的?(?:平均值|平均数|合计|总和|总数|最大值|最小值))$/;
/** Clauses of a Chinese question that say how to answer, not what: "以项目管理办公室核对后的数字为准", "保留3位小数", "在这两年一季度之间". */
const ZH_ASIDE = /以[^，,。？?]*为准|保留\d+位小数|在(?:这|该|各|此)[^，,。？?]{0,12}?(?:之间|期间|中|内|里)|(?:请|并)?列出.*|按[^，,。？?]{0,8}(?:顺序|排序).*/g;
/** What frames it before: "根据X的财报信息，", "考虑以下公司的2024年财报：", "请回答", "请按递增顺序列举上述每个公司". */
const ZH_HEAD = /^(?:根据|基于|按照|依据)[^，,。：:]*[，,。：:]|^考虑[^：:。]*[：:。]|^请(?:回答|问|列出|列举|按[^每]*每个公司)?|^(?:上述|以下)?(?:每个|各个?)?公司(?:的)?/;
/** Words that say nothing about which line holds the figure. */
/** A segment holding one of these is the question's frame, not a line item. */
const ZH_FRAME_WORD = /根据|依据|具体|数据|信息|报告|财报|为准|小数/;
const ZH_FRAME = new Set(['公司', '财报', '报告', '年报', '季报', '季度', '一季度', '二季度', '三季度', '四季度', '年度', '本期', '上期', '数据', '信息', '具体', '各个', '每个', '上述', '以下', '请问', '请回答', '该公司', '其']);
const EN_STOP = new Set([
  'what', 'which', 'who', 'is', 'was', 'are', 'were', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'by', 'and', 'or', 'its', 'their', 'this', 'that',
  'these', 'those', 'how', 'much', 'many', 'does', 'did', 'do', 'has', 'have', 'had', 'with', 'as', 'be', 'company', 'companies', 'report', 'reports', 'annual', 'quarterly',
  'consider', 'following', 'please', 'answer', 'listed', 'above', 'highest', 'lowest', 'largest', 'smallest', 'most', 'least', 'between', 'into', 'groups', 'group',
  'categorize', 'categorise', 'category', 'categories', 'compare', 'trend', 'change', 'observed', 'value', 'amount', 'thousands', 'millions', 'dollars', 'usd',
  'inc', 'corp', 'ltd', 'llc', 'co', 'plc', 'year', 'fiscal', 'period', 'reported', 'according', 'based', 'financial', 'statements', 'statement', 'filing', 'filings', 'form',
  'over', 'under', 'above', 'below', 'and', 'each', 'all', 'list', 'order', 'increasing', 'decreasing', 'ascending', 'descending', 'there', 'than', 'what\'s', 'one', 'two', 'three',
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/**
 * The metric words a value question asks about, longest first: its quoted
 * terms when it quotes any ('交易性金融资产', "Total Assets"), else what is left
 * once the names it gives (`names`), its years and its frame are taken out
 * ("英力特的公允价值变动收益是多少？" → 公允价值变动收益; "What is the Basic
 * Earnings Per Share of General Enterprise Ventures, Inc.?" → basic earnings
 * per share).
 */
export function metricTerms(question: string, names: string[] = []): string[] {
  const out = new Set<string>();
  const quoted = [
    ...quotedTerms(question),
    // curly single quotes always quote: ‘一年内到期的非流动负债’
    ...[...question.matchAll(/‘([^‘’\n]{2,60}?)’/g)].map((m) => m[1].trim()),
    // straight ones as a pair around a term, not an apostrophe: 'Total Operating Revenue', but not "INC.'s Net Cash … 'X'"
    ...[...question.matchAll(/(?:^|[\s(（:：,，])'([^'\n]{2,60}?)'(?=$|[\s)）?？.,，。:：;；一-鿿])/g)].map((m) => m[1].trim()),
  ].filter((t) => !names.some((n) => n && t.toLowerCase() === n.toLowerCase()));
  for (const t of quoted) out.add(t.toLowerCase());
  if (out.size > 0) return [...out];

  // the names out, longest first so a short name inside a long one does not leave half of it; a name inside a run of
  // the metric's words is part of it ("the Basic Earnings Per Share of", "Earnings Per Share" linked to an entity)
  let rest = question;
  for (const n of [...names].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(escapeRe(n), 'gi'), (hit, at: number, all: string) => (standsAlone(all, at, at + hit.length) ? '\u0000' : hit));
  }
  // asides first (a parenthesis, how to answer), then the periods
  rest = rest.replace(/（[^）]*）/g, '\u0000').replace(ZH_ASIDE, '\u0000');
  rest = rest.replace(/\d{4}\s*(?:年度?|财年)?|(?:第?[一二三四1-4]\s*季度|[上下]半年|Q[1-4])/gi, '\u0000');
  if (/[一-鿿]/.test(rest)) {
    for (const part of rest.split(/[\u0000，,。？?！!；;：:“”"‘’'（）()\n]+/)) {
      let s = part.trim().replace(ZH_HEAD, '').replace(/^(?:的|在|和|与|及|其|中|里|各|年|周|所有|全部)+/, '');
      for (let was = ''; was !== s;) {
        was = s;
        s = s.replace(ZH_TAIL, '').replace(/(?:的|在|和|与|及|是|为|中)+$/, '').trim();
      }
      const cjk = s.replace(/[^一-鿿]/g, '');
      if (cjk.length >= 3 && cjk.length <= 24 && !ZH_FRAME.has(s) && !ZH_FRAME_WORD.test(s)) out.add(s.toLowerCase());
      // "X的Y" with X not known as a name: Y, when it is long enough to be a line item rather than a word (现金)
      const tail = s.split('的').pop()!.trim();
      if (tail !== s && tail.replace(/[^一-鿿]/g, '').length >= 4 && !ZH_FRAME.has(tail)) out.add(tail.toLowerCase());
    }
  }
  // English: the runs of words that are not frame words, the longest first
  const words = rest.split(/\u0000/).flatMap((seg) => {
    const runs: string[][] = [[]];
    for (const w of seg.toLowerCase().match(/[a-z][a-z0-9&'-]*|[^\sa-z]+/g) ?? []) {
      if (/^[a-z]/.test(w) && !EN_STOP.has(w.replace(/'s$/, '')) && w.length >= 2) runs[runs.length - 1].push(w.replace(/'s$/, ''));
      else if (runs[runs.length - 1].length) runs.push([]);
    }
    return runs.filter((r) => r.length > 0 && r.length <= 8).map((r) => r.join(' '));
  });
  for (const w of words) if (w.length >= 4) out.add(w);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Characters that end a name in Chinese text: punctuation, a particle, a conjunction, the text's edge. */
const ZH_EDGE = /^$|[\s\p{P}\d的和与及、对在]/u;
/**
 * Whether the words at [start, end) of `text` stand as a name of their own rather than inside the metric's words: in
 * Latin text, a frame word or punctuation on each side ("of HARTE HANKS INC in"); in Chinese, an edge on either side
 * ("英力特的…", "：倍加洁、").
 */
export function standsAlone(text: string, start: number, end: number): boolean {
  if (/[一-鿿]/.test(text.slice(start, end))) return ZH_EDGE.test(text.slice(Math.max(0, start - 1), start)) || ZH_EDGE.test(text.slice(end, end + 1));
  const before = /([A-Za-z][\w'-]*)?\W*$/.exec(text.slice(0, start));
  const after = /^\W*([A-Za-z][\w'-]*)?/.exec(text.slice(end));
  const edge = (m: RegExpExecArray | null, side: 'before' | 'after') => {
    if (!m || !m[1]) return true;
    const gap = side === 'before' ? m[0].slice(m[1].length) : m[0].slice(0, m[0].length - m[1].length);
    return /[^\s]/.test(gap) || EN_STOP.has(m[1].toLowerCase());
  };
  return edge(before, 'before') && edge(after, 'after');
}

/** The parts of a metric phrase that a line may hold apart: "销售商品、提供劳务收到的现金" → 销售商品, 提供劳务收到, 现金. */
export function metricParts(term: string): string[] {
  const parts = term.split(/[、，,\s的及和与/]+/).map((p) => p.trim()).filter((p) => (/[一-鿿]/.test(p) ? p.length >= 2 : p.length >= 3));
  return parts.length > 1 ? parts : [];
}

/** Whether a line holds a metric: the phrase itself, or every part of it. */
function holds(line: string, term: string): boolean {
  const l = flat(line);
  if (l.includes(term)) return true;
  const parts = metricParts(term);
  return parts.length > 0 && parts.every((p) => l.includes(p));
}

const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}/;
const UNIT_LINE = /单位[：:]|币种[：:]|\bin (?:thousands|millions|billions)\b|\(in (?:thousands|millions)|\$\s*in (?:thousands|millions)|人民币元|美元/i;

/**
 * The lines of `content` that hold one of `terms` (lowercased), each behind what
 * it cannot be read without: a table row behind the table's header (the line
 * above its rule), and any line behind the nearest line above it that states a
 * unit. Long lines are cut around their hit.
 */
export function rowWindows(content: string, terms: string[]): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  const used = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || TABLE_RULE.test(line)) continue;
    const term = terms.find((t) => holds(line, t));
    if (!term) continue;
    const lead: string[] = [];
    // the table's header: the line above the rule that opens the table this row is in
    if (TABLE_ROW.test(line)) {
      let j = i - 1;
      while (j > 0 && TABLE_ROW.test(lines[j]) && !TABLE_RULE.test(lines[j])) j--;
      if (j > 0 && TABLE_RULE.test(lines[j]) && TABLE_ROW.test(lines[j - 1]) && !used.has(j - 1) && j - 1 !== i) {
        lead.push(cut(lines[j - 1], 0));
        used.add(j - 1);
      }
    }
    // the unit the figures are in
    for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
      if (UNIT_LINE.test(lines[j]) && !TABLE_ROW.test(lines[j])) {
        if (!used.has(j)) lead.unshift(cut(lines[j], 0));
        used.add(j);
        break;
      }
    }
    if (used.has(i)) continue;
    used.add(i);
    const at = Math.max(0, flat(line).indexOf(term));
    out.push([...lead, cut(line, at)].join('\n'));
  }
  return out;
}

function cut(line: string, at: number): string {
  const s = line.trim();
  if (s.length <= LINE_MAX) return s;
  const from = Math.max(0, Math.min(at - 120, s.length - LINE_MAX));
  return `${from > 0 ? '…' : ''}${s.slice(from, from + LINE_MAX)}${from + LINE_MAX < s.length ? '…' : ''}`;
}

interface Hit { id: string; document_id: string; seq: number; content: string; path: string; title: string | null; doc_date: string | Date | null }

export interface RowOptions {
  /** The names of what the question names: not metric words. */
  names?: string[];
  budget?: number;
  docs?: number;
  /** What of a passage the prompt shows (ask.ts cuts a passage to 1,500 characters, a widened one to its cap): a line past it is not shown. */
  visible?: (c: SearchResult) => string;
}

/**
 * Excerpts of the lines naming the question's metric in the source documents
 * `contexts` holds (in their order), the lines the passages already show left
 * out; documents take turns, a line each, up to the budget. Empty when the
 * question names no metric or no document holds one.
 */
export async function rowExcerpts(store: Store, question: string, contexts: SearchResult[], opts: RowOptions = {}): Promise<SearchResult[]> {
  const budget = opts.budget ?? ROW_CHARS;
  if (budget <= 0) return [];
  const terms = metricTerms(question, opts.names ?? []);
  if (terms.length === 0) return [];
  const docs: string[] = [];
  for (const c of contexts) {
    if (c.excerpt || c.generated || !c.documentId || c.path.startsWith('wiki/') || docs.includes(c.documentId)) continue;
    docs.push(c.documentId);
    if (docs.length >= (opts.docs ?? ROW_DOCS)) break;
  }
  if (docs.length === 0) return [];

  const p = new Params();
  const text = `regexp_replace(lower(c.content), '\\s+', ' ', 'g')`;
  const has = (s: string) => `strpos(${text}, ${p.add(s)}) > 0`;
  const conds = terms.map((t) => {
    const parts = metricParts(t);
    return parts.length ? `(${has(t)} OR (${parts.map(has).join(' AND ')}))` : has(t);
  });
  const rows = await store.query<Hit>(
    `SELECT c.id, c.document_id, c.seq, c.content, d.path, d.title, d.doc_date
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.document_id = ANY(${p.add(docs)}::text[]) AND d.status = 'indexed' AND (${conds.join(' OR ')})
      ORDER BY c.document_id, c.seq
      LIMIT ${p.add(SCAN_CAP)}`,
    p.list,
  );
  if (rows.length === 0) return [];

  // what the prompt shows already: a line in it is not shown twice
  const shown = contexts.map((c) => flat(opts.visible ? opts.visible(c) : c.content)).join('\n');
  const byDoc = new Map<string, { hit: Hit; texts: string[] }>();
  const seen = new Set<string>();
  for (const hit of rows) {
    for (const w of rowWindows(hit.content, terms)) {
      const key = flat(w);
      const own = flat(w.split('\n').pop() ?? w).replace(/^…|…$/g, '');
      if (seen.has(key) || shown.includes(own)) continue;
      seen.add(key);
      const entry = byDoc.get(hit.document_id) ?? byDoc.set(hit.document_id, { hit, texts: [] }).get(hit.document_id)!;
      entry.texts.push(w);
    }
  }
  // documents in the prompt's order, a line each per turn
  const order = docs.filter((d) => byDoc.has(d));
  const taken = new Map<string, string[]>();
  const size = new Map<string, number>();
  let used = 0;
  for (let turn = 0, added = true; added && used < budget && turn < ROWS_PER_DOC; turn++) {
    added = false;
    for (const d of order) {
      const w = byDoc.get(d)!.texts[turn];
      if (!w) continue;
      const cost = w.length + 3;
      if (used + cost > budget || (size.get(d) ?? 0) + cost > ROW_DOC_CHARS) continue;
      (taken.get(d) ?? taken.set(d, []).get(d)!).push(w);
      size.set(d, (size.get(d) ?? 0) + cost);
      used += cost;
      added = true;
    }
  }
  return order.filter((d) => taken.has(d)).map((d) => {
    const { hit } = byDoc.get(d)!;
    return {
      chunkId: hit.id,
      documentId: d,
      path: hit.path,
      title: hit.title,
      content: taken.get(d)!.join('\n…\n'),
      docDate: toDateString(hit.doc_date),
      score: 0,
      signals: {},
      excerpt: true,
    };
  });
}
