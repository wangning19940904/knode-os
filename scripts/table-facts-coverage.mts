/**
 * How many single-document numeric questions the table facts answer, without
 * a model, a build or a database (docs/design/38 §3.2 item 5): parse every
 * evidence document of a pack with src/tables/parse.ts and look for the gold
 * number among the facts parsed from it.
 *
 *   npx tsx scripts/table-facts-coverage.mts --pack <pack dir> [--types numeric,single-hop] [--list] [--json out.json]
 *   npx tsx scripts/table-facts-coverage.mts --docs <pack dir> [--sample 10]    # per-document fact counts and model-path segments
 *
 * A question counts as covered when a fact of its evidence document holds
 * the gold number: as written (its digits at the gold's precision, sign
 * aside) when the gold names no scale, and at the gold's scale when it does
 * ("$10,135 in thousands" needs a fact 10,135 in a thousands table, or
 * 10,135,000 as written). An uncovered question is put in one of:
 *
 *   - not in text      the gold number is nowhere in the document;
 *   - prose            it is, but on lines no table holds;
 *   - missed row       it is on a table-looking line no parsed table produced a fact for;
 *   - scale            a fact has the digits, at another scale than the gold states;
 *   - other            a fact on the line, with another number (a mis-assigned column).
 *
 * The baseline it is read against (real-loong-finance, the 2026-11 build): the
 * gold number in the text 115/117, in the document's claims 28/117, on its
 * summary page 33/117.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTables, TableFact } from '../src/tables/parse.ts';
import { segmentText } from '../src/graph/segment.ts';
import { modelPathSegments } from '../src/tables/llm.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

interface Gold {
  num: number;
  decimals: number;
  factor: number;
  raw: string;
}

/** The gold numbers of an answer: "-$0.04", "$(0.91)", "$10,135 in thousands", "144,480.00", "1.2亿元", "$273 thousand". */
function goldNumbers(answer: string): Gold[] {
  const out: Gold[] = [];
  const re = /(\(?[-−–]?\s*\$?\s*\(?\s*)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*\)?)\s*(%|in thousands|thousands?|in millions|millions?|billions?|亿元|亿|万元|万)?/gi;
  for (const m of answer.matchAll(re)) {
    const digits = m[2];
    const num = Number(digits.replace(/,/g, ''));
    const negative = /[-−–(]/.test(m[1]) || /\)/.test(m[3]);
    const word = (m[4] ?? '').toLowerCase();
    const factor = /thousand/.test(word) ? 1e3 : /million/.test(word) ? 1e6 : /billion/.test(word) ? 1e9 : /亿/.test(word) ? 1e8 : /万/.test(word) ? 1e4 : 1;
    out.push({ num: negative ? -num : num, decimals: (digits.split('.')[1] ?? '').length, factor, raw: m[0].trim() });
  }
  return out;
}

const roundTo = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const asWritten = (f: TableFact, g: Gold) => f.valueNum !== null && roundTo(Math.abs(f.valueNum), g.decimals) === Math.abs(g.num);
const atScale = (f: TableFact, g: Gold) =>
  f.valueNum !== null && Math.abs(Math.abs(f.valueNum * f.scaleFactor) - Math.abs(g.num * g.factor)) <= 0.5 * g.factor * 10 ** -g.decimals + 1e-9;

/** Every number written in the text, as written (sign aside), with the lines it is on. */
function textNumbers(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
      const k = m[0].replace(/,/g, '');
      (out.get(k) ?? out.set(k, []).get(k)!).push(i + 1);
    }
  });
  return out;
}

function inText(nums: Map<string, number[]>, g: Gold): number[] {
  const lines: number[] = [];
  for (const [k, ls] of nums) {
    const v = Number(k);
    if (roundTo(v, g.decimals) === Math.abs(g.num) && (k.split('.')[1] ?? '').length >= g.decimals) lines.push(...ls);
  }
  return lines;
}

const cache = new Map<string, { text: string; facts: TableFact[]; parse: ReturnType<typeof parseTables> }>();
function parsed(file: string) {
  let c = cache.get(file);
  if (!c) {
    const text = fs.readFileSync(file, 'utf8');
    const parse = parseTables(text);
    c = { text, facts: parse.facts, parse };
    cache.set(file, c);
  }
  return c;
}

function coverage(pack: string): void {
  const types = new Set((opt('types') ?? 'numeric,single-hop').split(','));
  const tasks = fs.readFileSync(path.join(pack, 'tasks/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rows: { id: string; lang: string; layout: string; outcome: string; answer: string; doc: string; detail: string }[] = [];
  for (const t of tasks) {
    if (!types.has(t.type) || !Array.isArray(t.evidence) || t.evidence.length !== 1) continue;
    const doc = path.join(pack, 'corpus', t.evidence[0].doc);
    if (!fs.existsSync(doc)) continue;
    const answers: string[] = [t.answer, ...(Array.isArray(t.answers) ? t.answers : [])].filter((a) => typeof a === 'string');
    const golds = answers.flatMap(goldNumbers).filter((g) => g.num !== 0 || g.decimals > 0);
    if (!golds.length) continue;
    const { text, facts, parse } = parsed(doc);
    const layout = parse.tables.some((x) => x.parser === 'pipe') ? 'pipe' : parse.tables.length ? 'text' : 'none';
    let outcome = '';
    let detail = '';
    const strict = facts.find((f) => golds.some((g) => (g.factor === 1 ? asWritten(f, g) || atScale(f, g) : atScale(f, g))));
    if (strict) {
      outcome = 'covered';
      detail = `L${strict.line} ${strict.label} | ${strict.period} | ${strict.valueText} ${strict.scale ?? ''}`;
    } else {
      const digits = facts.find((f) => golds.some((g) => asWritten(f, g)));
      const nums = textNumbers(text);
      const lines = [...new Set(golds.flatMap((g) => inText(nums, g)))];
      if (digits) {
        outcome = 'scale';
        detail = `L${digits.line} ${digits.label} ${digits.valueText} scale=${digits.scale ?? '-'} vs gold ${golds[0].raw}`;
      } else if (!lines.length) {
        outcome = 'not in text';
      } else {
        const tableLine = (n: number) => parse.tables.some((tb) => n >= tb.startLine && n <= tb.endLine);
        const looksTabular = (n: number) => {
          const l = text.split('\n')[n - 1] ?? '';
          return /^\s*\|/.test(l) || /\S\s{2,}[$(]?\s*[\d(]/.test(l);
        };
        const onFact = lines.find((n) => facts.some((f) => f.line === n));
        if (onFact) {
          outcome = 'other';
          detail = `L${onFact}: ${(text.split('\n')[onFact - 1] ?? '').trim().slice(0, 140)}`;
        } else if (lines.some((n) => tableLine(n) || looksTabular(n))) {
          outcome = 'missed row';
          const n = lines.find((x) => tableLine(x) || looksTabular(x))!;
          detail = `L${n}: ${(text.split('\n')[n - 1] ?? '').trim().slice(0, 140)}`;
        } else {
          outcome = 'prose';
          detail = `L${lines[0]}: ${(text.split('\n')[lines[0] - 1] ?? '').trim().slice(0, 140)}`;
        }
      }
    }
    // the baseline's measure: the gold number anywhere in the text
    const nums = textNumbers(text);
    const found = golds.some((g) => inText(nums, g).length > 0);
    rows.push({ id: t.id, lang: t.lang, layout, outcome, answer: t.answer, doc: t.evidence[0].doc, detail: `${found ? '' : '[not in text] '}${detail}` });
  }

  const groups = new Map<string, typeof rows>();
  const add = (k: string, r: (typeof rows)[number]) => (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  for (const r of rows) {
    add('all', r);
    add(`lang=${r.lang}`, r);
    add(`layout=${r.layout}`, r);
  }
  const outcomes = ['covered', 'scale', 'other', 'missed row', 'prose', 'not in text'];
  console.log(`pack ${path.basename(pack)} — ${rows.length} single-document numeric questions (${[...types].join(', ')})`);
  console.log(['group', 'n', 'in text', ...outcomes, 'share'].join('\t'));
  for (const [k, rs] of groups) {
    const intext = rs.filter((r) => !r.detail.startsWith('[not in text]')).length;
    const counts = outcomes.map((o) => rs.filter((r) => r.outcome === o).length);
    console.log([k, rs.length, intext, ...counts, (counts[0] / rs.length).toFixed(3)].join('\t'));
  }
  if (flag('list')) for (const r of rows.filter((x) => x.outcome !== 'covered')) console.log(`${r.outcome}\t${r.id}\t${r.lang}\t${r.answer}\t${r.doc}\t${r.detail}`);
  const out = opt('json');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 2));
}

function documents(pack: string): void {
  const corpus = path.join(pack, 'corpus');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|txt)$/.test(e.name)) files.push(p);
    }
  };
  walk(corpus);
  files.sort();
  const segmentChars = Number(opt('segment-chars') ?? 12_000);
  let totalFacts = 0;
  let totalSegments = 0;
  let modelSegments = 0;
  let modelChars = 0;
  let pipeDocs = 0;
  let textDocs = 0;
  const per: { file: string; chars: number; tables: number; facts: number; numeric: number; segments: number; model: number; minConf: number | null }[] = [];
  for (const f of files) {
    const { text, parse } = parsed(f);
    const segs = segmentText(text, segmentChars);
    const model = modelPathSegments(text, segs, parse);
    totalFacts += parse.facts.length;
    totalSegments += segs.length;
    modelSegments += model.length;
    modelChars += model.reduce((s, m) => s + m.chars, 0);
    if (parse.tables.some((t) => t.parser === 'pipe')) pipeDocs++;
    else if (parse.tables.length) textDocs++;
    const confs = parse.tables.filter((t) => t.parser === 'text').map((t) => t.confidence);
    per.push({
      file: path.relative(corpus, f), chars: text.length, tables: parse.tables.length, facts: parse.facts.length,
      numeric: parse.facts.filter((x) => x.valueNum !== null).length, segments: segs.length, model: model.length,
      minConf: confs.length ? Math.min(...confs) : null,
    });
  }
  console.log(`pack ${path.basename(pack)} — ${files.length} documents, ${pipeDocs} with pipe tables, ${textDocs} with text tables only`);
  console.log(`facts ${totalFacts} (${per.reduce((s, p) => s + p.numeric, 0)} numeric); segments ${totalSegments} at ${segmentChars} chars; model-path segments ${modelSegments} (${modelChars.toLocaleString()} chars) in ${per.filter((p) => p.model).length} documents`);
  const sample = Number(opt('sample') ?? 0);
  if (sample) {
    console.log(['file', 'chars', 'tables', 'facts', 'numeric', 'segments', 'model', 'minConf'].join('\t'));
    for (const p of per.slice(0, sample)) console.log([p.file, p.chars, p.tables, p.facts, p.numeric, p.segments, p.model, p.minConf ?? '-'].join('\t'));
  }
  const out = opt('json');
  if (out) fs.writeFileSync(out, JSON.stringify(per, null, 2));
}

const pack = opt('pack');
const docs = opt('docs');
if (pack) coverage(pack);
else if (docs) documents(docs);
else {
  console.error('usage: --pack <pack dir> | --docs <pack dir>');
  process.exit(2);
}
