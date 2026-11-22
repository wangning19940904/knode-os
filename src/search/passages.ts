import { Store } from '../store/db.js';
import { SearchResult } from '../types.js';
import { keywordTerms } from './search.js';

/**
 * Widened passages: more of the documents `ask` already found, before its one
 * completion.
 *
 * A search returns chunks, and a chunk is a cut of its document made without
 * knowing the question. On the evaluation campaign of 2026-11-17 about half the
 * answers Ask got wrong had every gold document retrieved, and most of those
 * failed on the cut, not on the document: a 10-K page's cash-flow statement
 * is three chunks and the search returned the one with the heading, so the
 * capital expenditures row the question needed sat in the next chunk; a
 * quarterly filing is a hundred chunks and the one holding "一年内到期的非流动资产"
 * was not among those returned; a document reached only through its wiki
 * summary page was shown as the summary, which leaves out most figures. The
 * answer step then said the knowledge base lacked what it had.
 *
 * This reads further into the documents behind the first few passages — the
 * document of a source chunk, and the source document of a summary page — and
 * shows each as one passage: the whole document when it is short; otherwise
 * the chunks shown, the chunk after any that looks like a table (a table runs
 * on), and the chunk of the document that best matches the question's terms,
 * weighted by how rare each term is within that document (its own name is in
 * every chunk and counts for nothing). Bounded by a character budget, taken in
 * the passages' order.
 */

/** Characters the widening may add to the prompt at most. */
export const WIDEN_BUDGET = 12000;
/** One widened passage's characters at most. */
export const PASSAGE_MAX = 4000;
/** A document at most this long is shown whole. */
export const WHOLE_DOC_MAX = 4800;
/** Documents widened at most, in the passages' order. */
export const WIDEN_DOCS = 6;
/** Chunks read of one document at most: a longer one is matched over its first this many. */
const DOC_CHUNK_CAP = 800;
/** The best-matching chunk is added when it matches at least this share of the best a chunk of the document could. */
const MATCH_SHARE = 0.35;

export interface WidenOptions {
  budget?: number;
  docs?: number;
}

export interface Widened {
  contexts: SearchResult[];
  /** Documents whose passage grew, and the characters added in all. */
  documents: number;
  chars: number;
}

interface DocChunk { id: string; document_id: string; seq: number; content: string; path: string; title: string | null }

/** Whether a chunk reads as a table or a run of figures: a statement, a schedule, a list of amounts. */
export function tableLike(content: string): boolean {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  if (lines.filter((l) => l.startsWith('|')).length >= 3) return true;
  const figures = lines.filter((l) => /\d[\d,.]*\d|\(\d/.test(l)).length;
  return figures / lines.length >= 0.4;
}

/** Adjacent chunks joined, the overlap the splitter repeats at their seam said once. */
export function joinChunks(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!out) { out = part; continue; }
    let overlap = 0;
    for (let n = Math.min(400, out.length, part.length); n >= 20; n--) {
      if (out.endsWith(part.slice(0, n))) { overlap = n; break; }
    }
    out = overlap ? out + part.slice(overlap) : `${out}\n${part}`;
  }
  return out;
}

/** Consecutive word pairs of the question ("accounts payable", "cash equivalents"): a phrase names a line item that its words alone do not. */
function phrases(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z][a-z0-9&.-]*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i].length >= 3 && words[i + 1].length >= 3 && !PHRASE_STOP.has(words[i]) && !PHRASE_STOP.has(words[i + 1])) out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}
const PHRASE_STOP = new Set(['the', 'and', 'for', 'what', 'which', 'was', 'were', 'are', 'how', 'does', 'did', 'has', 'have', 'its', 'from', 'with', 'that', 'this', 'based', 'according']);

/** Text matched word for word: case and runs of whitespace (a line break inside a table row) do not count. */
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/**
 * The question's terms weighted by how rare each is among a document's chunks: a term in every chunk (the company,
 * the report) says nothing about which chunk answers; one in a single chunk says the most. A term on the document's
 * cover (its first chunk: the company, the report's name) names the document rather than the line asked for, and
 * counts for a quarter; a phrase of the question counts double.
 */
export function termWeights(question: string, chunks: string[]): Map<string, number> {
  const lower = chunks.map(flat);
  const n = chunks.length;
  const cover = lower[0] ?? '';
  const out = new Map<string, number>();
  const add = (t: string, factor: number) => {
    const df = lower.filter((c) => c.includes(t)).length;
    // absent, or in every chunk: says nothing about which chunk answers
    if (df === 0 || df >= n) return;
    const w = Math.log((n + 1) / (df + 0.5)) * factor * (n > 1 && cover.includes(t) ? 0.25 : 1);
    if (w > 0) out.set(t, w);
  };
  for (const t of keywordTerms(question, 64)) add(t, Math.min(4, t.length) / 2);
  for (const t of phrases(question)) add(t, 4);
  return out;
}

const scoreOf = (content: string, weights: Map<string, number>) => {
  const c = flat(content);
  let s = 0;
  for (const [t, w] of weights) if (c.includes(t)) s += w;
  return s;
};

/** The source documents behind a summary page each wiki context is of, by the page's declared inputs. */
async function summarySources(store: Store, paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const rows = await store.query<{ page: string; id: string }>(
    `SELECT p.path AS page, d.id
       FROM pages p
       JOIN deps x ON x.artifact_kind = 'page' AND x.artifact_id = p.path AND x.input_kind = 'document'
       JOIN documents d ON d.path = x.input_id AND d.status = 'indexed'
      WHERE p.path = ANY($1::text[]) AND p.kind = 'source_summary' AND p.status = 'active'`,
    [paths],
  ).catch(() => []);
  const out = new Map<string, string>();
  // a summary of one document: one built from several is not this document's summary
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.page, (count.get(r.page) ?? 0) + 1);
  for (const r of rows) if (count.get(r.page) === 1) out.set(r.page, r.id);
  return out;
}

/**
 * The contexts with the documents behind the first `docs` of them read further: a source chunk's passage becomes
 * its widened document passage (marked `widened`), and a summary page is followed by its document's passage.
 * Excerpts and generated pages other than summaries are left as they are.
 */
export async function widenPassages(store: Store, question: string, contexts: SearchResult[], opts: WidenOptions = {}): Promise<Widened> {
  const budget = opts.budget ?? WIDEN_BUDGET;
  const maxDocs = opts.docs ?? WIDEN_DOCS;
  if (budget <= 0 || maxDocs <= 0 || contexts.length === 0) return { contexts, documents: 0, chars: 0 };

  const wikiPaths = [...new Set(contexts.filter((c) => !c.excerpt && c.path.startsWith('wiki/')).map((c) => c.path))];
  const summaries = await summarySources(store, wikiPaths);
  // the documents to widen, in the order their first passage comes
  const order: string[] = [];
  const anchor = new Map<string, number>();
  contexts.forEach((c, i) => {
    if (c.excerpt) return;
    const doc = c.path.startsWith('wiki/') ? summaries.get(c.path) : c.generated ? undefined : c.documentId;
    if (!doc || anchor.has(doc) || order.length >= maxDocs) return;
    order.push(doc);
    anchor.set(doc, i);
  });
  if (order.length === 0) return { contexts, documents: 0, chars: 0 };

  const rows = await store.query<DocChunk>(
    `SELECT c.id, c.document_id, c.seq, c.content, d.path, d.title
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.document_id = ANY($1::text[]) AND d.status = 'indexed' AND c.seq < $2
      ORDER BY c.document_id, c.seq`,
    [order, DOC_CHUNK_CAP],
  ).catch(() => [] as DocChunk[]);
  const byDoc = new Map<string, DocChunk[]>();
  for (const r of rows) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);

  const shownIds = new Set(contexts.map((c) => c.chunkId));
  const replace = new Map<number, SearchResult>();
  const after = new Map<number, SearchResult>();
  /** Chunks a widened passage now holds: their own contexts are dropped. */
  const absorbed = new Set<string>();
  let left = budget;
  let documents = 0;
  for (const doc of order) {
    const chunks = byDoc.get(doc);
    if (!chunks || chunks.length === 0) continue;
    const at = anchor.get(doc)!;
    const isSummary = contexts[at].path.startsWith('wiki/');
    const shown = chunks.filter((c) => shownIds.has(c.id));
    const total = chunks.reduce((n, c) => n + c.content.length, 0);
    let pick: DocChunk[];
    if (total <= WHOLE_DOC_MAX) {
      pick = chunks;
    } else {
      const index = new Map(chunks.map((c) => [c.seq, c]));
      const weights = termWeights(question, chunks.map((c) => c.content));
      const best = Math.max(0, ...chunks.map((c) => scoreOf(c.content, weights)));
      const possible = [...weights.values()].reduce((a, b) => a + b, 0);
      const shownSeqs = new Set(shown.map((c) => c.seq));
      const top = chunks
        .filter((c) => !shownSeqs.has(c.seq))
        .map((c) => ({ c, s: scoreOf(c.content, weights) }))
        .sort((a, b) => b.s - a.s || a.c.seq - b.c.seq)[0];
      // what the passage holds, most needed first, filled up to its cap: a document's title chunk (it says what the
      // passage is from), the chunk naming what is asked and the row after it, the chunk the search returned, the
      // rest shown, and the row after each table shown (a table runs on past the chunk boundary)
      const wanted: number[] = [];
      const head = index.get(0);
      if (head && head.content.length <= 200) wanted.push(0);
      if (top && top.s > 0 && top.s >= MATCH_SHARE * possible && top.s >= 0.6 * best) {
        wanted.push(top.c.seq);
        if (tableLike(top.c.content)) wanted.push(top.c.seq + 1);
      }
      const anchorSeq = isSummary ? undefined : shown.find((c) => c.id === contexts[at].chunkId)?.seq;
      if (anchorSeq !== undefined) wanted.push(anchorSeq);
      for (const c of shown) wanted.push(c.seq);
      for (const c of shown) if (tableLike(c.content)) wanted.push(c.seq + 1);
      const seqs = new Set<number>();
      let size = 0;
      for (const seq of wanted) {
        const c = index.get(seq);
        if (!c || seqs.has(seq)) continue;
        // the first chunk past the title always fits (it is cut to the cap below if it alone is longer)
        if (size + c.content.length > PASSAGE_MAX && seqs.size > (seqs.has(0) ? 1 : 0)) continue;
        seqs.add(seq);
        size += c.content.length;
      }
      pick = [...seqs].sort((a, b) => a - b).map((s) => index.get(s)!);
    }
    // nothing more than what is shown, and shown as one passage already
    if (pick.every((c) => shownIds.has(c.id)) && shown.length <= 1) continue;
    // contiguous runs joined, gaps marked
    const runs: DocChunk[][] = [];
    for (const c of pick) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1].seq === c.seq - 1) last.push(c);
      else runs.push([c]);
    }
    let text = runs.map((r) => joinChunks(r.map((c) => c.content))).join('\n[…]\n');
    if (text.length > PASSAGE_MAX) text = `${text.slice(0, PASSAGE_MAX)}…`;
    // the chunks of the document already shown that the passage holds are folded into it
    const held = new Set(pick.map((c) => c.id));
    const folded = shown.filter((c) => held.has(c.id));
    const was = folded.reduce((n, c) => n + Math.min(c.content.length, 1500), 0);
    const cost = text.length - was;
    if (cost > left) continue;
    left -= cost;
    documents++;
    const head = chunks[0];
    const passage: SearchResult = {
      chunkId: isSummary || !held.has(contexts[at].chunkId) ? (pick[0]?.id ?? head.id) : contexts[at].chunkId,
      documentId: doc,
      path: head.path,
      title: head.title,
      content: text,
      docDate: isSummary ? undefined : contexts[at].docDate,
      score: contexts[at].score,
      signals: contexts[at].signals,
      widened: { seqs: pick.map((c) => c.seq), of: chunks.length },
      ...(contexts[at].newest && !isSummary ? { newest: contexts[at].newest } : {}),
    };
    // a source chunk's passage takes its place when it holds it, and follows it otherwise; a summary's follows it
    if (isSummary || !held.has(contexts[at].chunkId)) after.set(at, passage);
    else replace.set(at, passage);
    for (const c of folded) if (c.id !== contexts[at].chunkId || isSummary) absorbed.add(c.id);
  }
  if (documents === 0) return { contexts, documents: 0, chars: 0 };
  const out: SearchResult[] = [];
  contexts.forEach((c, i) => {
    const own = replace.get(i);
    if (own) out.push(own);
    else if (!(absorbed.has(c.chunkId) && !c.excerpt)) out.push(c);
    const next = after.get(i);
    if (next) out.push(next);
  });
  return { contexts: out, documents, chars: budget - left };
}
