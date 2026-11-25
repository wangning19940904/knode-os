import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safePath, writeFileText } from '../fs/files.js';
import { PACKS_DIR } from '../fs/layout.js';
import { readMatter } from '../markdown.js';
import { DEFAULT_PLAYBOOK, parsePlaybook } from '../pack/playbook.js';
import type { Store } from '../store/db.js';
import { LearnConfig } from './config.js';
import { answerFigures, figureOnLine, numbersIn, scaleDeclaration } from './numbers.js';
import { learnedPages } from './revalidate.js';
import { documentLines, parseSourceRef, tableHeader } from './verify.js';

/**
 * How a figure is got (docs/design/38 §4.2, the third write-back): for a kind of
 * document and an attribute, the section, the table row and column, and the
 * declared unit its value stood at — read back from the lines learned pages'
 * derived facts were checked on, without a model.
 *
 * A method is proposed once the same one was checked on two documents or more
 * (one document says where *that* figure is; two say where this kind of
 * document keeps it). It goes into the playbook of the subject's entity type
 * (playbooks/packs/<type>.md, which knode_resolve's context pack hands an agent
 * verbatim), inside a region knode owns and rewrites whole:
 *   - learn.autoAccept off (default): as a `pack` suggestion with the revised
 *     file — the gate every playbook revision already takes (src/pack/learn.ts);
 *   - on: written at once.
 * A playbook a person wrote keeps everything outside the region.
 */

export const METHODS_BEGIN = '<!-- knode:learned-methods — written by knode from checked answers; edits inside this region are replaced -->';
export const METHODS_END = '<!-- /knode:learned-methods -->';

/** Distinct documents a method must have been checked on before it is proposed. */
export const METHOD_MIN_DOCS = 2;

export interface MethodObservation {
  attribute: string;
  subjectType: string;
  /** What kind of document: its title without the subject's name, numbers and parenthesized parts ("第一季度报告", "annual report"). */
  docClass: string;
  doc: string;
  line: number;
  /** The nearest heading above the line. */
  section: string;
  /** The row's label: a table row's first text cell, or the words before a text table's first figure. */
  row: string;
  /** The column the figure stood in: its header without years ("本报告期"), else its place in the table ("col:2") or among a text line's figures ("#2"). */
  column: string;
  /** The unit declaration the figure was read at ("单位：万元", "in thousands"), or ''. */
  scale: string;
}

export interface LearnedMethod extends Omit<MethodObservation, 'doc' | 'line'> {
  examples: { doc: string; line: number }[];
  docs: number;
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s*_`'"“”「」]/g, '');
const withoutYears = (s: string) => s.replace(/(19|20)\d{2}\s*(年度|年|财年|fiscal)?/gi, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

function headingAbove(lines: string[], i: number): string {
  for (let k = i; k >= 0; k--) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[k]);
    if (m) return m[1].trim();
  }
  return '';
}

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Where on its line the figure stood: row label and column. */
function placeOnLine(lines: string[], i: number, display: string, scale: number): { row: string; column: string } {
  const line = lines[i] ?? '';
  const figure = answerFigures(display)[0];
  if (/^\s*\|/.test(line)) {
    const cells = cellsOf(line);
    const row = cells.find((c) => c && numbersIn(c).every((n) => n.dateLike)) ?? '';
    const at = figure ? cells.findIndex((c) => figureOnLine(figure, c, scale)?.how === 'exact') : -1;
    const header = cellsOf(tableHeader(lines, i));
    // a header that is only a year ("2023 年") names a period, not a column a later report keeps: its place does
    return { row, column: at >= 0 ? withoutYears(header[at] ?? '') || `col:${at + 1}` : '' };
  }
  const figures = numbersIn(line).filter((n) => !n.dateLike);
  const firstAt = figures[0]?.index ?? line.length;
  const row = line.slice(0, firstAt).replace(/[$:：|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const k = figure ? figures.findIndex((n) => figureOnLine(figure, n.raw, scale)?.how === 'exact') : -1;
  return { row, column: k >= 0 ? `#${k + 1}` : '' };
}

/** The kind of document a title names, without the subject it is about. */
export function documentClass(title: string | null | undefined, subject: string | null): string {
  let t = (title ?? '').normalize('NFKC');
  if (subject) t = t.replace(new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  t = t.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\d+/g, ' ').replace(/[,，.。:：\-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(年度?|第|FY|file)\s*/i, '').replace(/\s*(file|年)$/i, '').trim();
  return t || 'document';
}

/** The type of the entity a subject names (not a mined concept), or `default`. */
async function subjectType(store: Store, subject: string, cache: Map<string, string>): Promise<string> {
  const k = subject.toLowerCase();
  const had = cache.get(k);
  if (had) return had;
  const [row] = await store.query<{ type: string }>(
    `SELECT type FROM entities WHERE lower(name) = $1 AND tx_to IS NULL AND canonical_id IS NULL AND type <> 'concept' LIMIT 1`,
    [k],
  );
  const type = row?.type && /^[a-z][a-z0-9_-]{0,40}$/i.test(row.type) ? row.type.toLowerCase() : 'default';
  cache.set(k, type);
  return type;
}

/** What every learned page's derived facts say about where their figures stood. */
export async function methodObservations(store: Store, dataDir: string): Promise<MethodObservation[]> {
  const out: MethodObservation[] = [];
  const types = new Map<string, string>();
  const titles = new Map<string, string | null>();
  for (const page of learnedPages(dataDir)) {
    let facts: { subject?: string; attribute?: string; source?: string; display?: string; scale?: number }[] = [];
    try {
      const fm = readMatter(fs.readFileSync(safePath(dataDir, page), 'utf8')).data as { facts?: typeof facts };
      facts = Array.isArray(fm.facts) ? fm.facts : [];
    } catch {
      continue;
    }
    for (const f of facts) {
      const ref = f.source ? parseSourceRef(f.source) : null;
      if (!ref?.line || !f.attribute || !f.subject || !f.display) continue;
      const lines = documentLines(dataDir, ref.path);
      if (!lines) continue;
      const i = ref.line - 1;
      if (!titles.has(ref.path)) {
        const [d] = await store.query<{ title: string | null }>(`SELECT title FROM documents WHERE path = $1 LIMIT 1`, [ref.path]);
        titles.set(ref.path, d?.title ?? null);
      }
      const decl = scaleDeclaration(lines, i);
      const { row, column } = placeOnLine(lines, i, f.display, decl?.scale ?? 1);
      out.push({
        attribute: f.attribute,
        subjectType: await subjectType(store, f.subject, types),
        docClass: documentClass(titles.get(ref.path), f.subject),
        doc: ref.path,
        line: ref.line,
        section: headingAbove(lines, i),
        row,
        column,
        scale: decl?.words ?? '',
      });
    }
  }
  return out;
}

/** Observations grouped into methods: one per kind of document, attribute and place; checked on how many documents. */
export function groupMethods(obs: MethodObservation[]): LearnedMethod[] {
  const groups = new Map<string, LearnedMethod>();
  for (const o of obs) {
    const key = JSON.stringify([o.subjectType, fold(o.docClass), fold(o.attribute), fold(o.section), fold(o.row), fold(o.column), fold(o.scale)]);
    const g = groups.get(key) ?? { ...o, examples: [], docs: 0 };
    if (!g.examples.some((e) => e.doc === o.doc)) g.examples.push({ doc: o.doc, line: o.line });
    g.docs = g.examples.length;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.docs - a.docs || a.attribute.localeCompare(b.attribute));
}

function methodLine(m: LearnedMethod): string {
  const zh = /[一-鿿]/.test(`${m.attribute}${m.section}${m.row}`);
  const where = m.examples.slice(0, 3).map((e) => `${e.doc}#L${e.line}`).join(', ');
  if (zh) {
    const parts = [
      m.section ? `「${m.section}」一节` : null,
      m.row ? `行「${m.row}」` : null,
      m.column ? (m.column.startsWith('#') ? `该行第 ${m.column.slice(1)} 个数` : m.column.startsWith('col:') ? `第 ${m.column.slice(4)} 列（表头是期间）` : `列「${m.column}」`) : null,
    ].filter(Boolean).join('，');
    return `- **${m.attribute}**（${m.docClass}）：${parts || '见示例行'}${m.scale ? `；数值按「${m.scale}」读，答案换算成元或注明单位` : '；表中未声明单位，数值即原值'}。已在 ${m.docs} 篇文档上逐行校验：${where}`;
  }
  const parts = [
    m.section ? `section "${m.section}"` : null,
    m.row ? `row "${m.row}"` : null,
    m.column ? (m.column.startsWith('#') ? `figure ${m.column.slice(1)} on the line` : m.column.startsWith('col:') ? `column ${m.column.slice(4)} (its header is the period)` : `column "${m.column}"`) : null,
  ].filter(Boolean).join(', ');
  return `- **${m.attribute}** (${m.docClass}): ${parts || 'see the example lines'}${m.scale ? `; figures are ${m.scale} — scale them, or state the unit` : '; no unit declared: figures as written'}. Checked line by line on ${m.docs} documents: ${where}`;
}

/** The region's text for these methods ('' when none). */
export function methodsRegion(methods: LearnedMethod[]): string {
  if (!methods.length) return '';
  const zh = methods.some((m) => /[一-鿿]/.test(m.attribute));
  return [
    METHODS_BEGIN,
    zh ? '## 取数方法（从逐行校验过的答案学到）' : '## Where figures are (learned from answers checked line by line)',
    '',
    zh ? '同一类文档里这些指标在哪里、按什么单位读；先去这里核对，再回原文确认那一行。' : 'Where these measures stand in this kind of document and at what unit; check there first, then confirm the line in the source.',
    '',
    ...methods.map(methodLine),
    METHODS_END,
  ].join('\n');
}

/** `content` with its region replaced by `region` (appended when it has none; removed when `region` is ''). */
export function withRegion(content: string, region: string): string {
  const a = content.indexOf(METHODS_BEGIN);
  const b = content.indexOf(METHODS_END);
  if (a >= 0 && b > a) {
    const before = content.slice(0, a).replace(/\s+$/, '');
    const after = content.slice(b + METHODS_END.length).replace(/^\s+/, '');
    return `${before}${region ? `\n\n${region}` : ''}\n${after ? `\n${after}` : ''}`;
  }
  if (!region) return content;
  return `${content.replace(/\s+$/, '')}\n\n${region}\n`;
}

/** The playbook a type's methods go into, and its text now ('' when it does not exist). */
function playbookFor(dataDir: string, type: string): { rel: string; current: string } {
  const rel = `${PACKS_DIR}/${type}.md`;
  const abs = safePath(dataDir, rel);
  return { rel, current: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '' };
}

/** A new playbook for an entity type: the default's settings and guidance, applied to that type. */
function seededPlaybook(dataDir: string, type: string): string {
  const def = path.join(safePath(dataDir, PACKS_DIR), 'default.md');
  const base = fs.existsSync(def) ? fs.readFileSync(def, 'utf8') : DEFAULT_PLAYBOOK;
  return withRegion(base, '').replace(/^appliesTo:\s*default\s*$/m, `appliesTo: ${type}`).replace(/^# Default context playbook$/m, `# ${type} context playbook`);
}

export interface MethodRefresh {
  methods: LearnedMethod[];
  /** Playbooks written (auto-accept). */
  written: string[];
  /** `pack` suggestions filed or refreshed (review). */
  suggested: string[];
}

export function methodSuggestionId(rel: string): string {
  return crypto.createHash('sha256').update(`pack|learned-methods|${rel}`).digest('hex').slice(0, 16);
}

/**
 * Bring every entity type's playbook region up to the methods the learned
 * pages support now: proposed (a `pack` suggestion) or written (auto-accept).
 * A type left without a method has its region removed the same way.
 */
export async function refreshMethodPlaybooks(store: Store, dataDir: string, cfg: Pick<LearnConfig, 'autoAccept'>): Promise<MethodRefresh> {
  const all = groupMethods(await methodObservations(store, dataDir));
  const methods = all.filter((m) => m.docs >= METHOD_MIN_DOCS);
  const byType = new Map<string, LearnedMethod[]>();
  for (const m of methods) (byType.get(m.subjectType) ?? byType.set(m.subjectType, []).get(m.subjectType)!).push(m);
  // types whose playbook holds a region now, so a method that went away leaves it too
  const dir = safePath(dataDir, PACKS_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      if (fs.readFileSync(path.join(dir, f), 'utf8').includes(METHODS_BEGIN) && !byType.has(f.slice(0, -3))) byType.set(f.slice(0, -3), []);
    }
  }
  const out: MethodRefresh = { methods, written: [], suggested: [] };
  for (const [type, ms] of byType) {
    const { rel, current } = playbookFor(dataDir, type);
    if (!current && !ms.length) continue;
    const next = withRegion(current || seededPlaybook(dataDir, type), methodsRegion(ms));
    if (next === current || !parsePlaybook(next, rel)) continue;
    if (cfg.autoAccept) {
      writeFileText(dataDir, rel, next);
      out.written.push(rel);
      continue;
    }
    const id = methodSuggestionId(rel);
    const zh = ms.some((m) => /[一-鿿]/.test(m.attribute));
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'pack', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload, status = 'pending'`,
      [
        id,
        zh ? `取数方法写入 ${rel}` : `Where figures are: revise ${rel}`,
        ms.length
          ? (zh ? `${ms.length} 条取数方法各在 ${METHOD_MIN_DOCS} 篇以上文档上逐行校验通过：${ms.map((m) => m.attribute).join('、')}。接受后写进 ${rel}，knode_resolve 的上下文包会带上。` : `${ms.length} methods each checked on ${METHOD_MIN_DOCS}+ documents: ${ms.map((m) => m.attribute).join(', ')}. Accepting writes them into ${rel}, which knode_resolve's context pack carries.`)
          : (zh ? `${rel} 里的取数方法已没有校验通过的依据（来源变了），接受后移除。` : `The methods in ${rel} no longer have checked support (their sources changed); accepting removes them.`),
        JSON.stringify(ms.flatMap((m) => m.examples.slice(0, 3).map((e) => ({ kind: 'document', path: `${e.doc}#L${e.line}` }))).slice(0, 30)),
        JSON.stringify({ path: rel, content: next }),
      ],
    );
    out.suggested.push(id);
  }
  return out;
}
