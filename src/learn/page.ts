import crypto from 'node:crypto';
import { readMatter, writeMatter } from '../markdown.js';
import { researchSlug } from '../research/templates.js';
import { LEARN_WRITER, LEARNED_DIR } from './config.js';
import { factSink, VerifiedFact } from './facts.js';
import { CheckReason, formatSourceRef, parseSourceRef, SourceRef } from './verify.js';

/**
 * A learned question page (docs/design/38 §4.2): the question, the answer and
 * the lines it was checked against, under wiki/questions/learned/. It is an
 * ordinary wiki page: searchable, read by knode_search and Ask, its citations
 * dependencies of the page (src/lineage/page-deps.ts) so a changed source is
 * noticed, and its frontmatter carries what a re-check needs (`learned.checks`).
 */

export interface PageCheck {
  /** What was checked: a figure as the answer wrote it, or the answer's text. */
  expect: { figure: string } | { text: string };
  attribute: string | null;
  ok: boolean;
  reason: CheckReason;
  /** `raw/docs/x.md#L12` as checked (the line found, when located). */
  source: string | null;
  located: boolean;
  /** The cited line's text when the check ran: what a re-check looks for if the line moved. */
  line: string | null;
}

export interface LearnedPage {
  path: string;
  question: string;
  answer: string;
  origin: string;
  mode: 'auto' | 'review';
  checks: PageCheck[];
  facts: VerifiedFact[];
  at: string;
}

/** A page path per question: its slug and a short hash (two questions with one slug stay two pages). */
export function learnedPathFor(question: string): string {
  const norm = question.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const slug = researchSlug(norm) || 'question';
  const h = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 8);
  return `${LEARNED_DIR}/${slug.slice(0, 48)}-${h}.md`;
}

export function renderLearnedPage(p: LearnedPage, sinkId: string): string {
  const zh = /[一-鿿]/.test(p.question);
  const sources = [...new Set(p.checks.filter((c) => c.ok && c.source).map((c) => c.source!))];
  const docs = [...new Set(sources.map((s) => parseSourceRef(s)?.path).filter((s): s is string => Boolean(s)))];
  const fields = factSink(sinkId).pageFields(p.facts);
  const data: Record<string, unknown> = {
    type: 'question',
    title: p.question.length > 120 ? `${p.question.slice(0, 117)}…` : p.question,
    question: p.question,
    actor: LEARN_WRITER,
    sources: docs,
    learned: {
      origin: p.origin,
      mode: p.mode,
      at: p.at,
      checks: p.checks.map((c) => ({ ...c, expect: c.expect })),
    },
    ...fields,
  };
  const lines: string[] = [];
  lines.push(`# ${p.question}`, '');
  lines.push(zh ? '## 答案' : '## Answer', '', p.answer.trim(), '');
  lines.push(zh ? '## 引用（逐行校验）' : '## Sources (checked line by line)', '');
  for (const c of p.checks) {
    if (!c.ok || !c.source) continue;
    const what = 'figure' in c.expect ? c.expect.figure : c.expect.text;
    lines.push(`- ${c.source}${c.located ? (zh ? '（按数值定位）' : ' (located by its value)') : ''} — ${what}: \`${(c.line ?? '').trim().slice(0, 200).replace(/`/g, "'")}\``);
  }
  if (p.facts.length) {
    lines.push('', zh ? '## 派生事实' : '## Derived facts', '');
    lines.push(zh ? '| 主体 | 指标 | 期间 | 数值 | 来源 |' : '| Subject | Attribute | Period | Value | Source |', '| --- | --- | --- | --- | --- |');
    for (const f of p.facts) lines.push(`| ${f.subject} | ${f.attribute} | ${f.period ?? ''} | ${f.display} | ${formatSourceRef(f.ref)} |`);
  }
  lines.push('');
  return writeMatter(lines.join('\n'), data);
}

/** What a learned page's frontmatter says, for a re-check; null for a file that is not one. */
export function readLearnedPage(text: string): { question: string; checks: PageCheck[]; mode: string; origin: string } | null {
  try {
    const m = readMatter(text);
    const l = m.data.learned as { checks?: PageCheck[]; mode?: string; origin?: string } | undefined;
    if (!l || !Array.isArray(l.checks)) return null;
    return { question: String(m.data.question ?? ''), checks: l.checks, mode: String(l.mode ?? ''), origin: String(l.origin ?? '') };
  } catch {
    return null;
  }
}

/** A check's reference, parsed. */
export function checkRef(c: Pick<PageCheck, 'source'>): SourceRef | null {
  return c.source ? parseSourceRef(c.source) : null;
}
