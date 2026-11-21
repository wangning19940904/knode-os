import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EmbeddingProvider } from '../../ingest/embeddings.js';
import { isolatedCopy, runAgent } from '../agent.js';
import { Bm25, Chunk, chunkDocs, rrf, VectorIndex } from '../retrieval.js';
import { startServedTools, ToolHost } from '../toolhost.js';
import { armBrief, GREP_HAS, agentMaxSteps } from './agents.js';
import { chat, recordAgent, SystemEnv, SystemUnderTest, taggedEmbedder } from './types.js';

/**
 * Traditional RAG: chunk the sources, retrieve the top chunks for a question
 * (BM25 with CJK bigrams, bge-m3 cosine, or both fused by RRF), and answer
 * in one call. One index per pack serves the three variants; only the hybrid
 * one answers — BM25 and vector alone are scored on retrieval.
 */

interface RagIndex {
  chunks: Chunk[];
  bm25: Bm25<Chunk>;
  vectors: VectorIndex<Chunk>;
}

const indexes = new Map<string, RagIndex>();

async function buildIndex(env: SystemEnv): Promise<RagIndex> {
  const docs = env.staged.docs.map((d) => ({ path: d.path, text: fs.readFileSync(path.join(env.staged.dir, d.path), 'utf8') }));
  const chunks = chunkDocs(docs);
  const bm25 = new Bm25(chunks, (c) => c.text);
  const vectors = await VectorIndex.build(chunks, (c) => c.text, taggedEmbedder(env, { system: 'rag', stage: 'embed' }));
  const idx = { chunks, bm25, vectors };
  indexes.set(env.workDir, idx);
  return idx;
}

async function ranked(mode: 'bm25' | 'vector' | 'hybrid', query: string, k: number, env: SystemEnv): Promise<Chunk[]> {
  const idx = indexes.get(env.workDir) ?? (await buildIndex(env));
  const byId = new Map(idx.chunks.map((c) => [c.id, c]));
  const lexical = idx.bm25.search(query, k * 3).map((h) => h.item.id);
  if (mode === 'bm25') return lexical.slice(0, k).map((id) => byId.get(id)!);
  const dense = (await idx.vectors.search(query, k * 3)).map((h) => h.item.id);
  if (mode === 'vector') return dense.slice(0, k).map((id) => byId.get(id)!);
  return rrf([lexical, dense]).slice(0, k).map((id) => byId.get(id)!);
}

function rag(mode: 'bm25' | 'vector' | 'hybrid'): SystemUnderTest {
  const id = `rag-${mode}`;
  return {
    id,
    label: { bm25: 'RAG: BM25', vector: 'RAG: dense vectors (bge-m3)', hybrid: 'RAG: BM25 + vectors (RRF)' }[mode],
    group: 'rag',
    kind: 'pipeline',
    answers: mode === 'hybrid',
    async build(env) {
      const idx = await buildIndex(env);
      return { notes: { chunks: idx.chunks.length } };
    },
    async reopen(env) {
      await buildIndex(env);
    },
    // an update batch re-indexes the staged corpus: the shim's vector cache embeds only the new chunks
    async update(_files, env) {
      await buildIndex(env);
    },
    async retrieve(query, k, env) {
      return [...new Set((await ranked(mode, query, k * 2, env)).map((c) => c.doc))].slice(0, k);
    },
    async answer(task, prompt, env) {
      const top = await ranked(mode, task.question, 8, env);
      const context = top.map((c, i) => `[${i + 1}] (doc: ${c.doc})\n${c.text}`).join('\n\n');
      const text = await chat(env, { system: id, stage: 'answer', task: task.id }, [
        { role: 'system', content: `You answer questions about a document collection using the retrieved passages below. Each passage names its document.\n\n${context}` },
        { role: 'user', content: prompt },
      ]);
      return { text, retrieved: [...new Set(top.map((c) => c.doc))] };
    },
  };
}

/* --------------------------- arm B: agent-rag --------------------------- */

/** One hit of arm B's `search`: the document's path in the agent's folder, the passage, its fused score. */
export interface PassageHit {
  doc: string;
  passage: string;
  score: number;
}

/** Passages `search` returns by default, and at most. */
export const SEARCH_DEFAULT_K = 8;
export const SEARCH_MAX_K = 20;

/**
 * The hybrid ranking `rag-hybrid` answers from (BM25 and the embedder, fused
 * by RRF over the top 3k of each), with each passage's RRF score: the same
 * index, the same fusion, the scores kept.
 */
export async function searchPassages(env: SystemEnv, query: string, k: number, embedder?: EmbeddingProvider): Promise<PassageHit[]> {
  const idx = indexes.get(env.workDir) ?? (await buildIndex(env));
  const byId = new Map(idx.chunks.map((c) => [c.id, c]));
  const lexical = idx.bm25.search(query, k * 3).map((h) => h.item.id);
  const dense = (await idx.vectors.search(query, k * 3, embedder)).map((h) => h.item.id);
  const score = new Map<string, number>();
  for (const list of [lexical, dense]) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + rank + 1)));
  return rrf([lexical, dense]).slice(0, k).map((id) => {
    const c = byId.get(id)!;
    return { doc: c.doc, passage: c.text, score: Math.round(score.get(id)! * 1e4) / 1e4 };
  });
}

/** What arm B's brief says it has beside the files (docs/design/33 §2). */
export const RAG_SEARCH_TOOL = 'search';

const searchHosts = new Map<string, Promise<ToolHost>>();

/**
 * The rag build's `search` tool for every arm-B session on it (single-flight
 * per build), served by the run over loopback HTTP as knode's tools are
 * (src/eval/toolhost.ts): a session here connects by URL, a remote worker's
 * through `serve`'s lease-bound proxy. The MCP server is named `knode` as
 * every evaluation session's is (the worker names it so); its one tool is
 * `search`. Query embeddings are metered under `agent-rag`, not the build.
 */
function searchHost(env: SystemEnv): Promise<ToolHost> {
  const had = searchHosts.get(env.workDir);
  if (had) return had;
  const embedder = taggedEmbedder(env, { system: 'agent-rag', stage: 'search' });
  const starting = startServedTools({ name: 'knode-eval-search', version: '1.0.0' }, [RAG_SEARCH_TOOL], (server) => {
    server.registerTool(
      RAG_SEARCH_TOOL,
      {
        title: 'Search the documents',
        description: `Passages of the documents that best match the query, by words (BM25) and by meaning (embeddings), fused: each hit is the document's path (as in the current directory), a passage of about 1,200 characters and its score. k: passages to return (default ${SEARCH_DEFAULT_K}, at most ${SEARCH_MAX_K}).`,
        inputSchema: {
          query: z.string().describe('What to look for, in words or as a question'),
          k: z.number().int().min(1).max(SEARCH_MAX_K).optional().describe(`Passages to return (default ${SEARCH_DEFAULT_K})`),
        },
      },
      async (args: { query: string; k?: number }) => {
        const hits = await searchPassages(env, args.query, args.k ?? SEARCH_DEFAULT_K, embedder);
        return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 1) }] };
      },
    );
  });
  searchHosts.set(env.workDir, starting);
  starting.catch(() => {
    if (searchHosts.get(env.workDir) === starting) searchHosts.delete(env.workDir);
  });
  return starting;
}

async function closeSearchHost(env: SystemEnv): Promise<void> {
  const host = searchHosts.get(env.workDir);
  searchHosts.delete(env.workDir);
  if (host) await (await host.catch(() => null))?.close();
}

/** Arm B's sentence of the shared brief: the sources, as for arm A, and the one tool beside them. */
export const AGENT_RAG_HAS = `${GREP_HAS} You also have one tool, \`${RAG_SEARCH_TOOL}\` (on the MCP server knode): ${RAG_SEARCH_TOOL}(query, k) returns the k passages of the documents that best match the query by words and by meaning, each with its document's path, the passage (about 1,200 characters) and a score. A ${RAG_SEARCH_TOOL} call counts against the budget as a command does.`;

/** Document paths named in `search` results, as far as the kept output shows them. */
function searchedDocuments(outputs: ({ text: string } | null)[] | undefined, docs: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const o of outputs ?? []) for (const m of o?.text.matchAll(/"doc":\s*"((?:[^"\\]|\\.)*)"/g) ?? []) if (docs.has(m[1])) out.push(m[1]);
  return out;
}

/**
 * Arm B (docs/design/33 §2): the grep agent — a copy of the sources, the same
 * brief, model, effort and step budget — plus one tool, `search`, over the
 * plain chunk index `rag-hybrid` builds. It is in the rag group, so it shares
 * that build (one index per pack) and builds it itself when `rag-hybrid` is
 * not in the run.
 */
export function agentRag(): SystemUnderTest {
  const index = rag('hybrid');
  return {
    id: 'agent-rag',
    label: 'Codex agent with grep over the sources and a RAG search tool',
    group: 'rag',
    kind: 'agent',
    answers: true,
    build: index.build,
    reopen: index.reopen,
    update: index.update,
    async answer(task, prompt, env) {
      if (!indexes.has(env.workDir)) await buildIndex(env);
      const host = await searchHost(env);
      await env.quota.wait();
      const copy = isolatedCopy(env.staged.dir, 'corpus');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          maxSteps: agentMaxSteps(),
          prompt: `${armBrief(AGENT_RAG_HAS)}\n\n${prompt}`,
          mcp: { name: 'knode', url: host.url, token: host.secret, enabledTools: [RAG_SEARCH_TOOL] },
        });
        recordAgent(env.meter, { system: 'agent-rag', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const retrieved = [...new Set([...r.filesTouched, ...searchedDocuments(r.outputs, docs)])];
        return { text: r.text, retrieved, toolCalls: r.toolCalls, commands: r.commands, outputs: r.outputs, capped: r.capped, leaked: r.leaked, error: r.error };
      } finally {
        copy.cleanup();
      }
    },
    async release(env) {
      await closeSearchHost(env);
    },
  };
}

export const ragBm25 = () => rag('bm25');
export const ragVector = () => rag('vector');
export const ragHybrid = () => rag('hybrid');
