/**
 * Replay Ask's prompts over a built evaluation index, read-only and without a model: every question goes
 * through `ask` with a model stub that keeps the prompt it is sent and answers nothing, and the question's
 * vector comes from the run's cache. What is measured is what the answering model would have been shown
 * (docs/design/36 "Why Ask lost them", docs/design/38 §6):
 *
 *   - the share of a question's gold documents among the prompt's passages (`passages`), and among its
 *     passages and the sources of its facts (`withFacts`); `all` when every one of them is there;
 *   - for a question with a gold value (`answer` / `answers`), whether the value is in the prompt text
 *     (`value`): a figure written with or without its thousands separators, in the units the gold gives;
 *   - the prompt's characters.
 *
 *   npx tsx scripts/replay-ask-prompts.mts --ws <workspace dir as built> --tasks <tasks.jsonl> --vectors <vectors.jsonl>
 *     [--database '<DatabaseConfig json>'] [--types numeric,comparison] [--per-type 60] [--suite usage]
 *     [--model pool:bge-m3:1024:l2-v1] [--dimensions 1024] [--now YYYY-MM-DD] [--out rows.jsonl] [--label before]
 *     [--ids a,b,c] [--shard i/n] [--no-subjects] [--no-rows]   (the last two turn off search/subjects.ts and search/rows.ts)
 *
 * The store is opened read-only (`Store.open(…, { readOnly: true })`: on PostgreSQL every transaction is
 * read-only), `ask` is called with `track: false`, and the vectors file is a copy of the run's cache filtered
 * to the questions: nothing is written to the run or to the index. A text the cache lacks (no question's
 * vector) makes `ask` fall back to the keyword and graph channels, as it does when its embedder is down.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { defaultConfig } from '../src/config.js';
import type { DatabaseConfig, KnodeConfig } from '../src/config.js';
import type { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { Store } from '../src/store/db.js';

const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const need = (name: string) => {
  const v = flag(name);
  if (!v) { console.error(`--${name} is required`); process.exit(2); }
  return v;
};

const WS = need('ws');
const model = flag('model') ?? 'pool:bge-m3:1024:l2-v1';
const dimensions = Number(flag('dimensions') ?? 1024);
const database = flag('database') ? (JSON.parse(flag('database')!) as DatabaseConfig) : undefined;
const types = flag('types') ? new Set(flag('types')!.split(',')) : null;
const perType = Number(flag('per-type') ?? 1e9);
const suite = flag('suite');
const label = flag('label') ?? 'replay';
const only = flag('ids') ? new Set(flag('ids')!.split(',')) : null;

interface Task { id: string; suite: string; type: string; question: string; answer?: unknown; answers?: unknown[]; evidence?: { doc: string }[]; afterUpdate?: unknown }
const tasks: Task[] = fs.readFileSync(need('tasks'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const keyOf = (text: string) => crypto.createHash('sha256').update(`${model}|${text}`).digest('hex');
const vectors = new Map<string, number[]>();
for await (const line of readline.createInterface({ input: fs.createReadStream(need('vectors')), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line) as { k: string; v: string };
    const buf = Buffer.from(r.v, 'base64');
    vectors.set(r.k, Array.from(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))));
  } catch { /* a torn line */ }
}
const embedder = {
  model, dimensions,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = vectors.get(keyOf(t));
      if (!v) throw new Error('no cached vector for this text');
      return v;
    });
  },
} as unknown as EmbeddingProvider;

let prompt = '';
const llm = {
  enabled: true, label: 'stub', model: 'stub',
  async complete(messages: { role: string; content: string }[]) {
    prompt = messages.map((m) => m.content).join('\n\n');
    return '{"citations":[],"gaps":[]}';
  },
} as unknown as LlmClient;

const config: KnodeConfig = { ...defaultConfig(), database: database ?? defaultConfig().database };
const store = await Store.open(WS, dimensions, database, { readOnly: true });

/** The forms a gold value may be written in: as given, without separators, and its number alone. */
function valueForms(v: unknown): string[] {
  const s = String(v ?? '').trim();
  if (!s) return [];
  const out = new Set<string>([s]);
  const num = /-?\(?\$?\s*[\d,]+(?:\.\d+)?\)?/.exec(s)?.[0];
  if (num) {
    const digits = num.replace(/[^\d.]/g, '');
    if (digits.replace(/\D/g, '').length >= 3) {
      out.add(digits);
      out.add(Number(digits).toLocaleString('en-US', { maximumFractionDigits: 6 }));
      const trimmed = digits.replace(/\.0+$/, '');
      out.add(trimmed);
      out.add(Number(trimmed).toLocaleString('en-US', { maximumFractionDigits: 6 }));
    }
  }
  return [...out].filter((x) => x.replace(/\D/g, '').length >= 3 || x.length >= 4);
}
const flatText = (s: string) => s.replace(/\s+/g, ' ');

const picked: Task[] = [];
const taken = new Map<string, number>();
for (const t of tasks) {
  if (only && !only.has(t.id)) continue;
  if (suite && t.suite !== suite) continue;
  if (types && !types.has(t.type)) continue;
  if (t.afterUpdate) continue;
  if ((taken.get(t.type) ?? 0) >= perType) continue;
  taken.set(t.type, (taken.get(t.type) ?? 0) + 1);
  picked.push(t);
}
// --shard i/n: the i-th of n interleaved parts, for running parts side by side
const shard = /^(\d+)\/(\d+)$/.exec(flag('shard') ?? '');
if (shard) {
  const [i, n] = [Number(shard[1]), Number(shard[2])];
  picked.splice(0, picked.length, ...picked.filter((_, j) => j % n === i));
}
const out = flag('out') ? fs.createWriteStream(flag('out')!) : null;
for (const t of picked) {
  prompt = '';
  const t0 = Date.now();
  const gold = [...new Set((t.evidence ?? []).map((e) => e.doc))];
  try {
    const off = { ...(process.argv.includes('--no-subjects') ? { subjects: false } : {}), ...(process.argv.includes('--no-rows') ? { rows: false } : {}) };
    const res = await ask(store, config, embedder, llm, t.question, { mode: 'hybrid', track: false, ...off, ...(flag('now') ? { now: flag('now') } : {}) });
    const docOf = (p: string | null | undefined) => (p && p.startsWith('raw/docs/') ? p.slice('raw/docs/'.length) : null);
    const passageDocs = [...new Set(res.contexts.map((c) => docOf(c.path)).filter((d): d is string => !!d))];
    const factDocs = [...new Set(res.facts.flatMap((f) => [f.path, ...((f as { sources?: string[] }).sources ?? [])]).map(docOf).filter((d): d is string => !!d))];
    const share = (docs: string[]) => (gold.length ? gold.filter((g) => docs.includes(g)).length / gold.length : null);
    const forms = [...(t.answers ?? []), ...(t.answer !== undefined && typeof t.answer !== 'object' ? [t.answer] : [])].flatMap(valueForms);
    const text = flatText(prompt);
    const row = {
      label, id: t.id, type: t.type, gold: gold.length,
      passages: share(passageDocs), withFacts: share([...passageDocs, ...factDocs]),
      all: gold.length ? (gold.every((g) => passageDocs.includes(g)) ? 1 : 0) : null,
      value: forms.length ? (forms.some((f) => text.includes(flatText(f))) ? 1 : 0) : null,
      chars: prompt.length, passagesN: res.contexts.length, docs: passageDocs.length, facts: res.facts.length,
      kind: res.route.kind, by: res.route.by, ms: Date.now() - t0,
      route: { enumerated: res.route.enumerated, widened: res.route.widened, second: res.route.second ? { chunks: res.route.second.chunks, facts: res.route.second.facts } : undefined, ...(res.route as { subjects?: unknown }).subjects ? { subjects: (res.route as { subjects?: unknown }).subjects } : {}, ...(res.route as { rows?: unknown }).rows ? { rows: (res.route as { rows?: unknown }).rows } : {} },
      missing: gold.filter((g) => !passageDocs.includes(g)),
    };
    out?.write(`${JSON.stringify(row)}\n`);
    process.stderr.write('.');
  } catch (err) {
    out?.write(`${JSON.stringify({ label, id: t.id, type: t.type, error: String(err).slice(0, 300) })}\n`);
    process.stderr.write('x');
  }
}
out?.end();
await store.close();
process.stderr.write(`\n${picked.length} questions\n`);
