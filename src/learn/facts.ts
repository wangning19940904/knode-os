import type { Store } from '../store/db.js';
import { figureValue, NumberToken } from './numbers.js';
import { formatSourceRef, SourceRef } from './verify.js';

/**
 * Derived facts (docs/design/38 §4.2): a value an answer gave and a check
 * confirmed on its cited line — subject, attribute, period, value with its
 * unit and scale, and the line — and where they are written.
 *
 * The target is a layer of its own (`DerivedFactSink`): the default puts them
 * in the learned page's frontmatter as declared claims, so the next sync
 * writes them to `claims` with `attribute`, `value_num`, `unit` and a date,
 * read by knode_claims and Ask's facts like any other claim. What tells them
 * apart from a claim extracted from a document is their source: a learned
 * page (`isLearnedPath` on `v_claims.source_path`), applied by the
 * `tier0.frontmatter` extractor. A typed fact table can register a sink of
 * its own and take over without the write-back changing.
 */

export interface FactInput {
  subject?: string | null;
  attribute?: string | null;
  /** "2023", "2024Q1", "2024H1", "2024-05-01" … */
  period?: string | null;
  value: string | number;
  unit?: string | null;
  /** `raw/docs/x.md#L12`; absent, the answer's citations are tried. */
  source?: string | null;
  /** The cited line's text, when the caller quoted it. */
  quote?: string | null;
}

export interface VerifiedFact {
  subject: string;
  attribute: string;
  period: string | null;
  /** The value as a number, magnitude applied (1.2亿 → 120000000). */
  value: number;
  /** As the answer wrote it. */
  display: string;
  unit: string | null;
  /** The scale the cited line's figure was read at (a table's 万元 → 10000). */
  scale: number;
  ref: SourceRef;
  lineText: string;
}

export interface DerivedFactSink {
  id: string;
  /** Frontmatter fields the learned page carries for `facts` (applied by the sync that indexes the page). */
  pageFields(facts: VerifiedFact[]): Record<string, unknown>;
}

const sinks = new Map<string, DerivedFactSink>();

export function registerFactSink(sink: DerivedFactSink): void {
  sinks.set(sink.id, sink);
}

export function factSink(id: string): DerivedFactSink {
  const s = sinks.get(id);
  if (!s) throw new Error(`no derived-fact sink "${id}" (known: ${[...sinks.keys()].join(', ')})`);
  return s;
}

/** The statement of a derived claim, in the question's language. */
export function factStatement(f: Pick<VerifiedFact, 'subject' | 'attribute' | 'period' | 'display'>): string {
  const zh = /[一-鿿]/.test(`${f.subject}${f.attribute}`);
  return zh
    ? `${f.subject}${f.period ? ` ${f.period}` : ''} ${f.attribute}为${f.display}`
    : `${f.subject} ${f.attribute}${f.period ? ` (${f.period})` : ''} is ${f.display}`;
}

/** The last day of a period, ISO, or null: a claim's date. */
export function periodEnd(period: string | null | undefined): string | null {
  if (!period) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (m) return period;
  m = /^(\d{4})Q([1-4])$/.exec(period);
  if (m) return `${m[1]}-${['03-31', '06-30', '09-30', '12-31'][Number(m[2]) - 1]}`;
  m = /^(\d{4})H([12])$/.exec(period);
  if (m) return `${m[1]}-${m[2] === '1' ? '06-30' : '12-31'}`;
  m = /^(\d{4})$/.exec(period);
  if (m) return `${m[1]}-12-31`;
  return null;
}

/** The default sink: declared claims and their structured rows in the page's frontmatter. */
registerFactSink({
  id: 'page-claims',
  pageFields(facts) {
    if (!facts.length) return {};
    const subjects = [...new Set(facts.map((f) => f.subject))];
    return {
      entities: subjects.map((name) => ({ name, type: 'concept' })),
      claims: facts.map((f) => ({
        subject: f.subject,
        type: 'fact',
        statement: factStatement(f),
        attribute: f.attribute,
        value: f.value,
        ...(f.unit ? { unit: f.unit } : {}),
        ...(periodEnd(f.period) ? { eventDate: periodEnd(f.period) } : {}),
      })),
      facts: facts.map((f) => ({
        subject: f.subject, attribute: f.attribute, period: f.period, value: f.value, display: f.display, unit: f.unit, scale: f.scale,
        source: formatSourceRef(f.ref), line: f.lineText.trim().slice(0, 300),
      })),
    };
  },
});

/* ------------------------------ deriving from a question ------------------------------ */

const CN_DIGIT: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4' };

/** The period a question asks about, normalized ("2023年第一季度" → 2023Q1), and the words that named it. */
export function periodOf(question: string): { period: string; words: string } | null {
  const q = question.normalize('NFKC');
  const tries: [RegExp, (m: RegExpExecArray) => string][] = [
    [/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/, (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`],
    [/(\d{4})\s*年\s*(?:第\s*)?([一二三四1-4])\s*季度/, (m) => `${m[1]}Q${CN_DIGIT[m[2]] ?? m[2]}`],
    [/(\d{4})\s*[Qq]([1-4])\b/, (m) => `${m[1]}Q${m[2]}`],
    [/\bQ([1-4])\s*(?:of\s*)?(?:FY)?\s*(\d{4})/i, (m) => `${m[2]}Q${m[1]}`],
    [/(\d{4})\s*年\s*(上|下)半年/, (m) => `${m[1]}H${m[2] === '上' ? 1 : 2}`],
    [/(\d{4})\s*H([12])\b/, (m) => `${m[1]}H${m[2]}`],
    [/(?:FY|fiscal(?:\s+year)?)\s*(\d{4})/i, (m) => m[1]],
    [/(\d{4})\s*(?:年度|财年|年)/, (m) => m[1]],
    [/\b(?:in|for|of|during)\s+((?:19|20)\d{2})\b/i, (m) => m[1]],
  ];
  for (const [re, f] of tries) {
    const m = re.exec(q);
    if (m) return { period: f(m), words: m[0] };
  }
  return null;
}

const ZH_NOISE = [
  /（[^）]*）|\([^)]*\)/g, /请根据材料回答[:：]?/g, /^(截至|到|在)\s*/g, /(实际)?(是|为|有|定在|等于)?(多少|几|什么|哪天|哪一天|多大|多高|多长)[^，。]*$/g,
  /[?？。!！]/g, /最新(一周)?(周报|月报)?里?的?/g, /现在/g,
];
const EN_NOISE = /\b(what|which|how|much|many|is|was|are|were|the|of|for|in|on|at|did|does|do|reported|report|total|amount|value|fiscal|year|company|inc|corp|ltd|co|its|their|during)\b|'s\b|[?.,]/gi;

/** The attribute a question asks for: what is left of it without its subject, its period and the asking words. */
export function attributeOf(question: string, subject: string | null, periodWords: string | null): string | null {
  let q = question.normalize('NFKC');
  if (subject) q = q.split(subject).join(' ');
  if (periodWords) q = q.split(periodWords).join(' ');
  if (/[一-鿿]/.test(q)) {
    for (const re of ZH_NOISE) q = q.replace(re, ' ');
    q = q.replace(/^[\s的,，、]+|[\s的,，、]+$/g, '').replace(/^.*?的(?=[^的]{2,}$)/, '');
    q = q.replace(/\s+/g, '');
    return q.length >= 2 && q.length <= 30 ? q : null;
  }
  q = q.replace(EN_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return q.length >= 3 && q.length <= 60 ? q.toLowerCase() : null;
}

/**
 * The subject a question names: the longest entity of the index (not a mined
 * concept — "营业收入" is an attribute, not a company) whose name it contains.
 */
export async function subjectOf(store: Store, question: string): Promise<string | null> {
  // a parenthesized note says how to read the sources ("项目管理办公室月报与周报不一致时以月报为准"), not what is asked about:
  // found by a real model's write-back, whose fact went to 项目管理办公室 instead of the team the question named
  const asked = question.normalize('NFKC').replace(/（[^）]*）|\([^)]*\)/g, ' ');
  const rows = await store.query<{ name: string }>(
    `SELECT name FROM entities
     WHERE tx_to IS NULL AND canonical_id IS NULL AND type <> 'concept' AND length(name) BETWEEN 2 AND 40
       AND strpos(lower($1), lower(name)) > 0
     ORDER BY length(name) DESC LIMIT 1`,
    [asked],
  );
  return rows[0]?.name ?? null;
}

export function factValue(n: NumberToken): number {
  return figureValue(n);
}
