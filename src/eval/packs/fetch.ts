import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../../llm/cli.js';
import { sourcesDir } from '../pack.js';
import type { SourceRecord } from '../types.js';

/**
 * Downloads for pack recipes (docs/design/23 §2): each URL is fetched once
 * into `~/knode-eval/sources/<host>/<name>` with curl (which honours the
 * machine's proxy settings, as Node's fetch does not), checked against a size
 * cap, and recorded with its sha256 and license — the pack manifest lists
 * exactly what it was built from.
 */

export interface FetchOptions {
  /** File name in the cache (default: derived from the URL). */
  name?: string;
  license: string;
  maxBytes?: number;
  headers?: Record<string, string>;
  /** Re-download even when cached. */
  fresh?: boolean;
  timeoutMs?: number;
}

export interface Fetched {
  file: string;
  record: SourceRecord;
}

const safeName = (url: string) => url.replace(/^https?:\/\//, '').replace(/[^\w.\-]+/g, '_').slice(0, 180);

export async function fetchCached(url: string, opts: FetchOptions): Promise<Fetched> {
  const host = new URL(url).host;
  const file = path.join(sourcesDir(), host, opts.name ?? safeName(url));
  const metaFile = `${file}.meta.json`;
  if (!opts.fresh && fs.existsSync(file) && fs.existsSync(metaFile)) {
    return { file, record: JSON.parse(fs.readFileSync(metaFile, 'utf8')) as SourceRecord };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  const args = ['-sSL', '--fail', '--retry', '3', '--retry-delay', '2', '-o', tmp, '--max-filesize', String(opts.maxBytes ?? 300 * 1024 * 1024)];
  for (const [k, v] of Object.entries(opts.headers ?? {})) args.push('-H', `${k}: ${v}`);
  args.push(url);
  const r = await runProcess('curl', args, '', opts.timeoutMs ?? 30 * 60_000);
  if (r.code !== 0) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`download failed (${r.code}) ${url}: ${r.stderr.slice(-300)}`);
  }
  fs.renameSync(tmp, file);
  const bytes = fs.statSync(file).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const record: SourceRecord = { url, license: opts.license, sha256, bytes, retrievedAt: new Date().toISOString() };
  fs.writeFileSync(metaFile, JSON.stringify(record, null, 2));
  return { file, record };
}

/**
 * A dataset file: fetched once into the cache, or, when the recipe was given a local copy of the dataset
 * (`from`: an offline build, a test fixture), read from there and hashed here.
 */
export async function datasetFile(opts: FetchOptions & { url: string; from?: string; rel: string }): Promise<Fetched> {
  if (!opts.from) return fetchCached(opts.url, opts);
  const file = path.join(opts.from, opts.rel);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: a local copy of the dataset holds ${opts.rel}`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { file, record: { url: `file://${file}`, license: opts.license, sha256, bytes: fs.statSync(file).size, note: `local copy of ${opts.url}` } };
}

export async function fetchText(url: string, opts: FetchOptions): Promise<{ text: string; record: SourceRecord }> {
  const f = await fetchCached(url, opts);
  return { text: fs.readFileSync(f.file, 'utf8'), record: f.record };
}

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<{ json: T; record: SourceRecord }> {
  const f = await fetchText(url, opts);
  return { json: JSON.parse(f.text) as T, record: f.record };
}

/**
 * Rows of a Hugging Face dataset through the datasets-server API — JSON
 * pages of up to 100 rows, so no parquet reader is needed. `where` filters
 * server-side (`"user"='dasovich-j'`), `query` searches full text.
 */
export async function hfRows<T>(dataset: string, opts: { split?: string; config?: string; where?: string; query?: string; limit: number; license: string; offset?: number }): Promise<{ rows: T[]; record: SourceRecord }> {
  const rows: T[] = [];
  let offset = opts.offset ?? 0;
  const endpoint = opts.where ? 'filter' : opts.query ? 'search' : 'rows';
  let first: SourceRecord | null = null;
  while (rows.length < opts.limit) {
    const length = Math.min(100, opts.limit - rows.length);
    const params = new URLSearchParams({ dataset, config: opts.config ?? 'default', split: opts.split ?? 'train', offset: String(offset), length: String(length) });
    if (opts.where) params.set('where', opts.where);
    if (opts.query) params.set('query', opts.query);
    const url = `https://datasets-server.huggingface.co/${endpoint}?${params.toString()}`;
    const { json, record } = await fetchJson<{ rows: { row: T }[]; num_rows_total?: number }>(url, { license: opts.license, name: `${dataset.replace('/', '__')}__${endpoint}__${crypto.createHash('sha1').update(params.toString()).digest('hex').slice(0, 12)}.json` });
    first ??= record;
    rows.push(...json.rows.map((r) => r.row));
    offset += json.rows.length;
    if (!json.rows.length || (json.num_rows_total !== undefined && offset >= json.num_rows_total)) break;
  }
  return { rows, record: { ...(first ?? { url: `https://huggingface.co/datasets/${dataset}`, license: opts.license }), url: `https://huggingface.co/datasets/${dataset}`, note: `${rows.length} rows via datasets-server${opts.where ? ` where ${opts.where}` : ''}${opts.query ? ` query ${opts.query}` : ''}` } };
}

/** Plain text of an HTML page: scripts and styles dropped, block ends kept as line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
