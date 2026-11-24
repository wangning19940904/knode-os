import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { safePath, writeFileText } from '../fs/files.js';
import { recordOrigin } from '../fs/sidecar.js';
import { sync } from '../ingest/sync.js';
import type { AskResult } from '../search/ask.js';
import type { Store } from '../store/db.js';
import { LEARN_WRITER, learnConfig, LearnConfig } from './config.js';
import { attributeOf, FactInput, factValue, periodOf, subjectOf, VerifiedFact } from './facts.js';
import { answerFigures, NumberToken, numbersIn } from './numbers.js';
import { refreshMethodPlaybooks } from './methods.js';
import { LearnedPage, learnedPathFor, PageCheck, renderLearnedPage } from './page.js';
import { checkCitation, CitationCheck, documentLines, Expected, formatSourceRef, parseSourceRef, SourceRef } from './verify.js';

/**
 * Write an answer back (docs/design/38 §4): after Ask or an agent answered,
 * keep the question, the answer and the lines it rests on as a learned page,
 * and the values it confirmed as derived facts — so the next time the same
 * or a nearby question is asked, the knowledge base already holds it.
 *
 * Every write-back is checked first (src/learn/verify.ts): each value's cited
 * line exists and states it. Then, by `learn.autoAccept`:
 *   - false (default): the page waits for a person as a `learn` suggestion —
 *     outside the index, so nothing reads it until it is accepted (which
 *     writes it, src/pack/learn.ts `applySuggestion`);
 *   - true: a page whose every check passed is written and indexed at once;
 *     one with a failed check still waits.
 * Off (`learn.enabled` false), nothing is written.
 */

export interface WritebackInput {
  question: string;
  answer: string;
  /** The answer's final line; read from `Final answer:` (else the whole answer) when absent. */
  finalAnswer?: string;
  /** What the answer cites: `raw/docs/x.md#L12`, `raw/docs/x.md`, a corpus path `x.md`. */
  citations: string[];
  /** Structured facts, from a caller that has them (an agent through knode_writeback). */
  facts?: FactInput[];
  /** Lines a cited document's passage covered (1-based), to prefer when locating a value: Ask's chunks. */
  near?: Record<string, { from: number; to: number }>;
  /** Who answered: ask, agent, eval … recorded on the page. */
  origin: string;
}

export type WritebackStatus = 'disabled' | 'skipped' | 'applied' | 'pending';

export interface WritebackResult {
  status: WritebackStatus;
  /** Why it was skipped. */
  reason?: string;
  path?: string;
  /** The `learn` suggestion it waits as (pending). */
  suggestionId?: string;
  /** Every check passed. */
  verified?: boolean;
  checks?: PageCheck[];
  facts?: VerifiedFact[];
  /** Playbooks the learned methods were written to, or the suggestions they wait as (src/learn/methods.ts). */
  methods?: { written: string[]; suggested: string[] };
  ms: number;
}

const REFUSAL = /(无法|不能|未能)(确定|回答|找到|判断)|没有(提到|找到|相关|给出|说明)|未(提及|提到|说明|披露|找到)|资料(中)?(没有|未)|not (stated|mentioned|found|specified|available|provided|disclosed)|cannot (be )?(determine|answer|find)|(do|does) not (say|state|mention|contain)|no (information|mention)|unknown|insufficient/i;

/** The line after `Final answer:`, or the answer itself. */
export function finalLine(answer: string): string {
  const m = /final answer\s*[:：]\s*(.+)/i.exec(answer);
  return (m ? m[1] : answer).trim();
}

/** The suggestion id of a learned page: one per page, whatever answer it holds now. */
export function learnSuggestionId(pagePath: string): string {
  return crypto.createHash('sha256').update(`learn|${pagePath}`).digest('hex').slice(0, 16);
}

interface Expectation {
  expected: Expected;
  label: string;
  attribute: string | null;
  fact: { subject: string | null; period: string | null; unit: string | null; figure: NumberToken } | null;
  refs: SourceRef[];
  quote: string | null;
}

/** What a write-back must confirm: its facts' values, else the figures of the final answer, else its short text. */
async function expectationsOf(store: Store, input: WritebackInput, cfg: LearnConfig, refs: SourceRef[]): Promise<Expectation[]> {
  const out: Expectation[] = [];
  if (input.facts?.length) {
    for (const f of input.facts.slice(0, 12)) {
      const figure = answerFigures(`${f.value}${f.unit && !String(f.value).includes(f.unit) ? f.unit : ''}`)[0] ?? null;
      const source = f.source ? parseSourceRef(f.source) : null;
      const label = String(f.value);
      out.push({
        expected: figure ? { figure } : { text: label },
        label,
        attribute: f.attribute ?? null,
        fact: figure && cfg.facts && f.subject && f.attribute ? { subject: f.subject, period: f.period ?? null, unit: f.unit ?? figure.unit, figure } : null,
        refs: source ? [source] : refs,
        quote: f.quote ?? null,
      });
    }
    return out;
  }
  const final = input.finalAnswer ?? finalLine(input.answer);
  const figures = answerFigures(final).slice(0, 3);
  const period = periodOf(input.question);
  const subject = cfg.facts ? await subjectOf(store, input.question) : null;
  const attribute = attributeOf(input.question, subject, period?.words ?? null);
  if (figures.length) {
    for (const figure of figures) {
      out.push({
        expected: { figure }, label: figure.raw, attribute,
        fact: cfg.facts && subject && attribute ? { subject, period: period?.period ?? null, unit: figure.unit, figure } : null,
        refs, quote: null,
      });
    }
    return out;
  }
  // a short text answer (a name, a team, a date): its words on a cited line
  const text = final.replace(/\[doc:[^\]]*\]|\[\d+\]/g, '').replace(/[。.!！\s]+$/u, '').trim();
  if (text.length >= 2 && text.length <= 40 && numbersIn(text).every((n) => n.dateLike)) {
    out.push({ expected: { text }, label: text, attribute, fact: null, refs, quote: null });
  }
  return out;
}

function pageCheck(e: Expectation, c: CitationCheck | null): PageCheck {
  return {
    expect: 'figure' in e.expected ? { figure: e.expected.figure.raw } : { text: e.expected.text },
    attribute: e.attribute,
    ok: Boolean(c?.ok),
    reason: c?.reason ?? 'not-found',
    source: c && (c.ok || c.ref.line) ? formatSourceRef(c.ref) : c?.ref.path ?? null,
    located: Boolean(c?.located),
    line: c?.lineText ?? null,
  };
}

/** Rank failures: a wrong line or an unknown scale says more than a document that does not state it at all. */
const FAILURE_RANK: Record<string, number> = { 'line-mismatch': 5, 'quote-mismatch': 5, 'scale-unknown': 4, ambiguous: 3, 'no-such-line': 2, 'not-found': 1, 'no-document': 0 };

export async function writeBack(ctx: Pick<AppContext, 'store' | 'config' | 'dataDir'> & Partial<AppContext>, input: WritebackInput): Promise<WritebackResult> {
  const t0 = Date.now();
  const cfg = learnConfig(ctx.config);
  const done = (r: Omit<WritebackResult, 'ms'>): WritebackResult => ({ ...r, ms: Date.now() - t0 });
  if (!cfg.enabled) return done({ status: 'disabled' });
  const question = input.question.trim();
  if (!question || !input.answer.trim()) return done({ status: 'skipped', reason: 'empty' });
  const final = input.finalAnswer ?? finalLine(input.answer);
  if (!input.facts?.length && REFUSAL.test(final)) return done({ status: 'skipped', reason: 'refusal' });

  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const c of input.citations) {
    const r = parseSourceRef(c);
    if (!r) continue;
    const k = formatSourceRef(r);
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push(r);
    if (refs.length >= 12) break;
  }
  if (!refs.length && !input.facts?.some((f) => f.source)) return done({ status: 'skipped', reason: 'no-citations' });

  const expectations = await expectationsOf(ctx.store, input, cfg, refs);
  if (!expectations.length) return done({ status: 'skipped', reason: 'nothing-to-check' });

  const checks: PageCheck[] = [];
  const facts: VerifiedFact[] = [];
  for (const e of expectations) {
    let best: CitationCheck | null = null;
    for (const ref of e.refs) {
      const c = checkCitation(ctx.dataDir, ref, e.expected, { attribute: e.attribute, quote: e.quote, near: input.near?.[ref.path] ?? null });
      if (c.ok) {
        best = c;
        break;
      }
      if (!best || (FAILURE_RANK[c.reason] ?? 0) > (FAILURE_RANK[best.reason] ?? 0)) best = c;
    }
    checks.push(pageCheck(e, best));
    if (best?.ok && e.fact) {
      facts.push({
        subject: e.fact.subject!, attribute: e.attribute!, period: e.fact.period, value: factValue(e.fact.figure),
        display: e.fact.figure.raw, unit: e.fact.unit, scale: best.scale ?? 1, ref: best.ref, lineText: best.lineText ?? '',
      });
    }
  }
  const verified = checks.length > 0 && checks.every((c) => c.ok);
  const mode: LearnedPage['mode'] = cfg.autoAccept && verified ? 'auto' : 'review';
  const rel = learnedPathFor(question);
  const content = renderLearnedPage({ path: rel, question, answer: input.answer, origin: input.origin, mode, checks, facts, at: new Date().toISOString() }, cfg.factSink);
  const id = learnSuggestionId(rel);

  if (mode === 'auto') {
    recordOrigin(ctx.dataDir, rel, content, LEARN_WRITER);
    writeFileText(ctx.dataDir, rel, content);
    // a page waiting for review is moot once this one took effect
    await ctx.store.query(`UPDATE suggestions SET status = 'stale' WHERE id = $1 AND status = 'pending'`, [id]);
    if (ctx.embedder && ctx.llm) await sync(ctx as AppContext, { only: [rel], llmGraph: false, datasources: false, actor: LEARN_WRITER });
    // a fact that took effect may make a method checked on a second document: the playbook follows
    const methods = cfg.methods && facts.length ? await refreshMethodPlaybooks(ctx.store, ctx.dataDir, cfg) : null;
    return done({ status: 'applied', path: rel, verified, checks, facts, ...(methods ? { methods: { written: methods.written, suggested: methods.suggested } } : {}) });
  }
  await fileLearnSuggestion(ctx.store, { id, path: rel, content, question, checks, verified, reason: verified ? 'review' : 'failed-check' });
  return done({ status: 'pending', path: rel, suggestionId: id, verified, checks, facts });
}

/** File (or refresh) the `learn` suggestion a page waits as. */
export async function fileLearnSuggestion(
  store: Store,
  s: { id: string; path: string; content: string; question: string; checks: PageCheck[]; verified: boolean; reason: 'review' | 'failed-check' | 'stale' },
): Promise<void> {
  const failed = s.checks.filter((c) => !c.ok);
  const title = s.reason === 'stale' ? `已学问答的来源变了：${s.question.slice(0, 60)}` : `写回问答：${s.question.slice(0, 60)}`;
  const body = s.reason === 'stale'
    ? `这一页引用的文档变了，重新校验没有通过（${failed.map((c) => `${c.source ?? '?'}：${c.reason}`).join('；')}），页面已撤下。接受会按原样写回；拒绝则丢弃。`
    : s.verified
      ? `答案的 ${s.checks.length} 处引用全部通过逐行校验。接受后写成 ${s.path}，可被检索和 Ask 读到。`
      : `有 ${failed.length}/${s.checks.length} 处引用没有通过逐行校验（${failed.map((c) => `${c.source ?? '无来源'}：${c.reason}`).join('；')}）。核对后再接受。`;
  await store.query(
    `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
     VALUES ($1, 'learn', $2, $3, $4::jsonb, 'pending', $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload, status = 'pending'`,
    [
      s.id, title, body,
      JSON.stringify(s.checks.filter((c) => c.source).slice(0, 20).map((c) => ({ kind: 'document', path: c.source, ok: c.ok, reason: c.reason }))),
      JSON.stringify({ path: s.path, content: s.content, question: s.question, verified: s.verified, reason: s.reason }),
    ],
  );
}

/** Accepting a `learn` suggestion: its page written as a person's (trusted), for the next sync to index. */
export function writeAcceptedPage(dataDir: string, payload: { path?: unknown; content?: unknown } | null): string | null {
  if (!payload || typeof payload.path !== 'string' || typeof payload.content !== 'string') return null;
  if (!payload.path.startsWith('wiki/questions/')) return null;
  writeFileText(dataDir, payload.path, payload.content);
  return payload.path;
}

/* ------------------------------------------------ Ask */

/**
 * The write-back of an Ask answer: what it cited ([n] → the passage's or the
 * fact's document), each passage's lines preferred when a value is located,
 * plus any path the answer wrote itself.
 */
export async function writeBackAsk(ctx: AppContext, question: string, res: Pick<AskResult, 'answer' | 'citations' | 'contexts'>, origin = 'ask'): Promise<WritebackResult> {
  const near: Record<string, { from: number; to: number }> = {};
  const citations: string[] = [];
  for (const c of res.citations) {
    const passage = res.contexts[c.ref - 1];
    const p = passage?.path ?? c.path;
    if (!p || !p.startsWith('raw/')) continue;
    citations.push(p);
    if (passage?.content && !near[p]) {
      const span = passageLines(ctx.dataDir, p, passage.content);
      if (span) near[p] = span;
    }
  }
  for (const m of res.answer.matchAll(/raw\/docs\/[^\s)\]'"`，。]+/g)) citations.push(m[0]);
  return writeBack(ctx, { question, answer: res.answer, citations, near, origin });
}

/** The lines of `doc` a passage covers (1-based), found by its first substantial line; null when not found. */
export function passageLines(dataDir: string, doc: string, content: string): { from: number; to: number } | null {
  const lines = documentLines(dataDir, doc);
  if (!lines) return null;
  const parts = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 8);
  if (!parts.length) return null;
  const first = parts[0];
  const at = lines.findIndex((l) => l.trim() === first || l.includes(first));
  if (at < 0) return null;
  return { from: at + 1, to: at + content.split(/\r?\n/).length };
}

/** Whether the page a write-back would have written exists now (it took effect). */
export function learnedPageExists(dataDir: string, rel: string): boolean {
  return fs.existsSync(safePath(dataDir, rel));
}
