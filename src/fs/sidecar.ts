import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LEGACY_EXTRACT_CHARS, SEGMENTER_VERSION } from '../constants.js';
import { safePath } from './files.js';
import { SIDECAR_ROOT, sidecarRelFor } from './layout.js';

/**
 * Sidecars — one directory per source under `<data>/.sidecar/<key>/`, split
 * by lifecycle so each writer touches only its own file:
 *
 *   content.md               converted Markdown (PDF / image / trace episode); text sources have none
 *   meta.json                identity: source + content hashes, conversion cache key, chunk map
 *   tier0.json               zero-LLM extraction (concepts, wikilinks, declared frontmatter facts)
 *   tier1.json               LLM extraction, replayable while `contentSha` matches
 *   usage.json               heat snapshot, flushed hourly from the DB
 *   views/source-summary.md  cached LLM source summary (frontmatter = cache key)
 *   views/translations/      the indexed text translated, per language: <lang>.md (frontmatter = cache key)
 *                            and <lang>.parts.json (one translation per segment, by segment hash)
 *
 * The sidecar extends gbrain's "files are truth" rule to derived data that is
 * expensive to rebuild: deleting `.knode/` and re-ingesting never re-pays LLM
 * cost and never loses heat history. Every file is written atomically
 * (tmp + rename); the tmp name is unique per writer so the tier-1 loop, the
 * usage flush and an apply can run concurrently on the same directory.
 */

export const SIDECAR_VERSION = 2;

export interface SidecarChunkMeta {
  id: string;
  seq: number;
  tokenCount: number;
}

export interface SidecarConversion {
  /** Cache identity of the conversion (converter version + model + limits). */
  key: string;
  kind: string;
  model: string;
  warnings?: string[];
}

export interface SidecarMeta {
  version: typeof SIDECAR_VERSION;
  /** The source key, e.g. raw/docs/report.pdf. */
  rawPath: string;
  sourceType: string;
  /** sha256 of the original bytes. */
  sourceSha256: string;
  /** sha256 of the indexed text — the scope sha; differs from sourceSha256 after conversion / normalization. */
  contentSha256: string;
  /** Byte length of the indexed text (documents.bytes). */
  contentBytes: number;
  /** Version of the frontmatter normalizer baked into contentSha256. */
  normalizer: number;
  conversion?: SidecarConversion;
  title: string | null;
  /** The source's reference date (frontmatter date or a date in the path), ISO; null when none was found. */
  docDate?: string | null;
  ingestedAt: string;
  chunks: SidecarChunkMeta[];
}

export interface SidecarEntity {
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
  sameAs?: string | null;
  /** Segments of a long document it was extracted from. */
  segments?: number[];
}

export interface SidecarRelation {
  source: string;
  target: string;
  type: string;
  description?: string;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface SidecarClaim {
  subject: string;
  object?: string | null;
  type: string;
  statement: string;
  status: 'fact' | 'suspected' | 'disputed' | 'absent';
  /** fact | opinion | prediction | rumor; absent in sidecars written before claims had a kind (read as fact). */
  kind?: 'fact' | 'opinion' | 'prediction' | 'rumor';
  startDate?: string | null;
  endDate?: string | null;
  /** When the asserted event happened (as opposed to the window the statement holds for). */
  eventDate?: string | null;
  /** Segment of a long document it was extracted from. */
  segment?: number;
}

/**
 * One segment of a long document (docs/design/10): its own extraction, kept
 * under the hash of its text so an edit re-extracts only the segments it
 * changed and an interrupted document resumes where it stopped.
 */
export interface SidecarSegment {
  i: number;
  sha: string;
  /** Character offsets into the document text. */
  start: number;
  end: number;
  heading?: string | null;
  /** 'failed' with `attempts` below the retry limit is retried by a later pass. */
  status: 'done' | 'failed';
  attempts?: number;
  entities: SidecarEntity[];
  relations: SidecarRelation[];
  claims: SidecarClaim[];
  /** First segment only: the entity the whole document is mainly about, null when it covers many. */
  subject?: { name: string; type: string } | null;
  model: string;
  extractedAt: string;
  error?: string;
}

export interface SidecarTier0 {
  /** sha256 of the content the extraction was computed from. */
  contentSha: string;
  /** Terms the zero-LLM miner kept (placeholders until tier-1 reads the document; replayed by a history rebuild). */
  concepts: string[];
  /** Names of typed entities the graph already knew that this document was linked to (informational). */
  linked?: string[];
  wikilinks: string[];
  extractedAt: string;
  /** Frontmatter-declared entities / claims (tier 0.5), kept so a removed source can be replayed from the attic. */
  declared?: { entities: SidecarEntity[]; relations?: SidecarRelation[]; claims: SidecarClaim[] } | null;
}

export interface SidecarTier1 {
  /** 'partial': segments of the current content are still pending (not replayable). */
  status: 'pending' | 'partial' | 'done' | 'failed';
  /** The document-level result (segments merged); what a replay applies. */
  entities: SidecarEntity[];
  relations: SidecarRelation[];
  claims?: SidecarClaim[];
  model: string;
  /** sha256 of the content the extraction was computed from. */
  contentSha: string;
  extractedAt: string;
  error?: string;
  /** Version of the segment cutter (SEGMENTER_VERSION); absent = one call over the first LEGACY_EXTRACT_CHARS. */
  segmenter?: number;
  /** Per-segment results of a document longer than one call (absent for a single-call document). */
  segments?: SidecarSegment[];
  /** Segments given up on after repeated failures; the rest was written. */
  failedSegments?: number[];
}

export interface SidecarUsage {
  firstSeenAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  heat: number;
  chunkHits: Record<string, { count: number; lastAt: string }>;
  flushedAt: string | null;
}

/**
 * How much of a long document its summary read (docs/design/14): the text was
 * cut into `parts` segments, `read` of them were summarized, holding `share`
 * of the characters and `sectionsRead` of the `sections` sub-headings.
 */
export interface SourceSummaryCoverage {
  chars: number;
  parts: number;
  read: number;
  share: number;
  sections: number;
  sectionsRead: number;
}

/** Cached LLM source summary, keyed by the content it was derived from. */
export interface SourceSummaryCache {
  contentSha: string;
  model: string;
  generatedAt: string;
  body: string;
  /** The language the summary was written in (zh, en, …); absent in caches written before docs/design/14. */
  language?: string;
  /** Present when the document was summarized in segments. */
  coverage?: SourceSummaryCoverage;
}

/** One segment's summary of a long document, cached by the segment's text hash so an edit keeps the others. */
export interface SourceSummaryPart {
  body: string;
  model: string;
  generatedAt: string;
}

/** The assembled in-memory view of a sidecar directory. */
export interface Sidecar {
  version: typeof SIDECAR_VERSION;
  meta: SidecarMeta;
  extraction: {
    tier0?: SidecarTier0;
    tier1?: SidecarTier1;
  };
  usage: SidecarUsage;
}

export type SidecarPart = 'meta' | 'tier0' | 'tier1' | 'usage' | 'tables';

export interface SidecarParts {
  meta: SidecarMeta;
  tier0: SidecarTier0;
  tier1: SidecarTier1;
  usage: SidecarUsage;
  tables: SidecarTables;
}

/**
 * The table model path's replies (src/tables/llm.ts), by segment text hash: the
 * rows a call returned that the text bore out. Replayed for free while the
 * segment's text is unchanged, as tier-1 segments are.
 */
export interface SidecarTables {
  segments: Record<string, { model: string; at: string; rows: { line: number; label: string; column: string; value: string; scale: string | null }[] }>;
}

const PART_FILES: Record<SidecarPart, string> = {
  meta: 'meta.json',
  tier0: 'tier0.json',
  tier1: 'tier1.json',
  usage: 'usage.json',
  tables: 'tables.json',
};
const CONTENT_FILE = 'content.md';
const ORIGIN_FILE = 'origin.json';
const VIEWS_DIR = 'views';
const SOURCE_SUMMARY_FILE = `${VIEWS_DIR}/source-summary.md`;
const SOURCE_SUMMARY_PARTS_FILE = `${VIEWS_DIR}/source-summary.parts.json`;
const SOURCE_SUMMARY_FAILED_FILE = `${VIEWS_DIR}/source-summary.failed.json`;
const TRANSLATIONS_DIR = `${VIEWS_DIR}/translations`;

/* ------------------------------ low level ------------------------------ */

/** Atomic write: unique tmp file in the same directory, then rename. */
export function writeAtomic(abs: string, data: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

function readJson<T>(abs: string): T | null {
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8')) as T;
  } catch {
    return null; // corrupt part — treated as absent, regenerated by its writer
  }
}

/**
 * Markdown cache file: a frontmatter block of JSON-quoted strings carries the
 * cache key, the body is the cached text verbatim. Written and read by this
 * module only, with a deliberately tiny format: JSON-quoted values can never
 * form a `---` line, so a body that itself opens with a fence survives, and
 * ISO timestamps stay strings instead of being coerced into YAML dates.
 */
export function writeMarkdownCache(abs: string, frontmatter: Record<string, string>, body: string): void {
  const head = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeAtomic(abs, `---\n${head}\n---\n${body}${body.endsWith('\n') ? '' : '\n'}`);
}

export function readMarkdownCache(abs: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf8');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const frontmatter: Record<string, unknown> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(': ');
    if (at === -1) continue;
    try {
      frontmatter[line.slice(0, at)] = JSON.parse(line.slice(at + 2));
    } catch {
      return null; // not one of ours — regenerated by its writer
    }
  }
  return { frontmatter, body: text.slice(end + 5).replace(/\n$/, '') };
}

/** Frontmatter string value of a cache file, or null when missing / not a string. */
export function cacheString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/* ------------------------------ locations ------------------------------ */

/** Absolute sidecar directory for a source key. */
export function sidecarDir(dataDir: string, key: string): string {
  return safePath(dataDir, sidecarRelFor(key));
}

/** A sidecar exists once its meta.json does. */
export function hasSidecar(dataDir: string, key: string): boolean {
  return isFile(path.join(sidecarDir(dataDir, key), PART_FILES.meta));
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/* -------------------------------- parts -------------------------------- */

function readPartFrom<P extends SidecarPart>(absDir: string, part: P): SidecarParts[P] | null {
  const value = readJson<SidecarParts[P]>(path.join(absDir, PART_FILES[part]));
  if (!value || typeof value !== 'object') return null;
  if (part === 'meta') {
    const m = value as SidecarMeta;
    if (m.version !== SIDECAR_VERSION || typeof m.rawPath !== 'string' || typeof m.contentSha256 !== 'string') return null;
  }
  return value;
}

export function readSidecarPart<P extends SidecarPart>(dataDir: string, key: string, part: P): SidecarParts[P] | null {
  return readPartFrom(sidecarDir(dataDir, key), part);
}

export function writeSidecarPart<P extends SidecarPart>(dataDir: string, key: string, part: P, value: SidecarParts[P]): void {
  writeAtomic(path.join(sidecarDir(dataDir, key), PART_FILES[part]), JSON.stringify(value, null, 2) + '\n');
}

/**
 * Read-mutate-write one part. Returns null without writing when the sidecar
 * does not exist (no meta.json), so writers never create orphan directories.
 * `cur` is null when that part has not been written yet (never for `meta`).
 */
export function updateSidecarPart<P extends SidecarPart>(
  dataDir: string,
  key: string,
  part: P,
  mutate: (cur: SidecarParts[P] | null) => SidecarParts[P],
): SidecarParts[P] | null {
  if (!hasSidecar(dataDir, key)) return null;
  const next = mutate(readSidecarPart(dataDir, key, part));
  writeSidecarPart(dataDir, key, part, next);
  return next;
}

/* ------------------------------ assembled ------------------------------ */

/** Assemble the sidecar from its parts; null unless a valid meta.json exists. */
export function readSidecarFromDir(absDir: string): Sidecar | null {
  const meta = readPartFrom(absDir, 'meta');
  if (!meta) return null;
  const tier0 = readPartFrom(absDir, 'tier0') ?? undefined;
  const tier1 = readPartFrom(absDir, 'tier1') ?? undefined;
  const usage = readPartFrom(absDir, 'usage') ?? emptyUsage(meta.ingestedAt);
  return { version: SIDECAR_VERSION, meta, extraction: { tier0, tier1 }, usage };
}

/**
 * Remove everything this sidecar owns. Only the known files and `views/` are
 * deleted, so a nested sidecar of a longer key (`raw/docs/notes` next to
 * `raw/docs/notes/x.md`) survives; empty parents are pruned up to the root.
 */
export function removeSidecar(dataDir: string, key: string): void {
  const dir = sidecarDir(dataDir, key);
  if (!fs.existsSync(dir)) return;
  for (const file of [...Object.values(PART_FILES), CONTENT_FILE, ORIGIN_FILE]) fs.rmSync(path.join(dir, file), { force: true });
  fs.rmSync(path.join(dir, VIEWS_DIR), { recursive: true, force: true });
  pruneEmpty(dir, safePath(dataDir, SIDECAR_ROOT));
}

/**
 * Whether a sidecar holds work that took model calls to make: a tier-1
 * extraction (finished or in part), a cached source summary, or a conversion
 * a vision model wrote (a PDF's own text layer costs nothing to redo).
 */
export function sidecarHoldsPaidWork(dataDir: string, key: string): boolean {
  const dir = sidecarDir(dataDir, key);
  if (isFile(path.join(dir, PART_FILES.tier1)) || isFile(path.join(dir, SOURCE_SUMMARY_FILE)) || isFile(path.join(dir, SOURCE_SUMMARY_PARTS_FILE))) return true;
  if (translationLanguages(dataDir, key).length > 0) return true;
  if (!isFile(path.join(dir, CONTENT_FILE))) return false;
  return readPartFrom(dir, 'meta')?.conversion?.kind !== 'pdf-text';
}

/** Move a sidecar along with its source (`/api/mv`), so a moved PDF is not converted again. */
export function moveSidecar(dataDir: string, fromKey: string, toKey: string): boolean {
  const src = sidecarDir(dataDir, fromKey);
  if (!fs.existsSync(src)) return false;
  const dst = sidecarDir(dataDir, toKey);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  pruneEmpty(path.dirname(src), safePath(dataDir, SIDECAR_ROOT));
  return true;
}

function pruneEmpty(dir: string, stopAt: string): void {
  let cur = dir;
  while (cur.startsWith(stopAt + path.sep)) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/* ------------------------------- content ------------------------------- */

export function readContent(dataDir: string, key: string): string | null {
  const abs = path.join(sidecarDir(dataDir, key), CONTENT_FILE);
  return isFile(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

export function writeContent(dataDir: string, key: string, text: string): void {
  writeAtomic(path.join(sidecarDir(dataDir, key), CONTENT_FILE), text);
}

export function hasContent(dataDir: string, key: string): boolean {
  return isFile(path.join(sidecarDir(dataDir, key), CONTENT_FILE));
}

/* -------------------------------- origin ------------------------------- */

/**
 * Who wrote a source's bytes, when it was not a person at the filesystem: an
 * agent through MCP (knode_write, knode_commit), a research run stamping the
 * page its agent wrote. Trust is capped by it (src/ingest/apply.ts) — the
 * file cannot be the record, its frontmatter is the writer's to write and it
 * may be no Markdown at all — so it is kept here: out of the writer's reach
 * (the sidecar tree is system-owned), moved with the file, kept by a rebuild.
 *
 * A record holds for exactly the bytes that were written, by hash. Whoever
 * edits the file afterwards, in the UI or an editor, is its writer from then
 * on; a system rewrite that keeps the writer's text (a managed region
 * refreshed) carries the record over (`carryOrigin`). The last few writes are
 * kept, so a file restored to an earlier version gets that version's writer.
 */
export interface SourceOrigin {
  actor: string;
  sha256: string;
  at: string;
}

const ORIGINS_KEPT = 16;

const bytesSha = (content: string | Uint8Array) => crypto.createHash('sha256').update(content).digest('hex');

function readOrigins(dataDir: string, key: string): SourceOrigin[] {
  const raw = readJson<{ writes?: unknown }>(path.join(sidecarDir(dataDir, key), ORIGIN_FILE));
  return Array.isArray(raw?.writes)
    ? (raw.writes as Partial<SourceOrigin>[]).filter((w): w is SourceOrigin => typeof w?.actor === 'string' && typeof w.sha256 === 'string')
    : [];
}

/** Record that `actor` wrote `content` to `key`. Call it before writing the file, so no reader sees the bytes unattributed. */
export function recordOrigin(dataDir: string, key: string, content: string | Uint8Array, actor: string): void {
  const sha256 = bytesSha(content);
  const writes = [{ actor, sha256, at: new Date().toISOString() }, ...readOrigins(dataDir, key).filter((w) => w.sha256 !== sha256)];
  writeAtomic(path.join(sidecarDir(dataDir, key), ORIGIN_FILE), `${JSON.stringify({ writes: writes.slice(0, ORIGINS_KEPT) }, null, 2)}\n`);
}

/** Who wrote the bytes `key` holds now, when a recorded writer did; null for anything else. */
export function originOf(dataDir: string, key: string): SourceOrigin | null {
  const writes = readOrigins(dataDir, key);
  if (writes.length === 0) return null;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(safePath(dataDir, key));
  } catch {
    return null;
  }
  const sha256 = bytesSha(bytes);
  return writes.find((w) => w.sha256 === sha256) ?? null;
}

/** A system rewrite of `key` from `before` to `after` keeps whoever wrote `before`. */
export function carryOrigin(dataDir: string, key: string, before: string | Uint8Array, after: string | Uint8Array): void {
  const sha256 = bytesSha(before);
  const writer = readOrigins(dataDir, key).find((w) => w.sha256 === sha256);
  if (writer) recordOrigin(dataDir, key, after, writer.actor);
}

/* -------------------------------- views -------------------------------- */

export function readSourceSummary(dataDir: string, key: string): SourceSummaryCache | null {
  const cache = readMarkdownCache(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FILE));
  if (!cache) return null;
  const contentSha = cacheString(cache.frontmatter.contentSha);
  const model = cacheString(cache.frontmatter.model);
  const generatedAt = cacheString(cache.frontmatter.generatedAt);
  if (contentSha === null || model === null || generatedAt === null) return null;
  const coverage = parseCoverage(cacheString(cache.frontmatter.coverage));
  const language = cacheString(cache.frontmatter.language);
  return { contentSha, model, generatedAt, body: cache.body, ...(language ? { language } : {}), ...(coverage ? { coverage } : {}) };
}

export function writeSourceSummary(dataDir: string, key: string, cache: SourceSummaryCache): void {
  writeMarkdownCache(
    path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FILE),
    {
      contentSha: cache.contentSha,
      model: cache.model,
      generatedAt: cache.generatedAt,
      ...(cache.language ? { language: cache.language } : {}),
      // the cache file's values are strings: the coverage rides along as JSON
      ...(cache.coverage ? { coverage: JSON.stringify(cache.coverage) } : {}),
    },
    cache.body,
  );
}

function parseCoverage(raw: string | null): SourceSummaryCoverage | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<SourceSummaryCoverage>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const chars = n(c.chars);
    const parts = n(c.parts);
    const read = n(c.read);
    const share = n(c.share);
    if (chars === null || parts === null || read === null || share === null) return null;
    return { chars, parts, read, share, sections: n(c.sections) ?? 0, sectionsRead: n(c.sectionsRead) ?? 0 };
  } catch {
    return null;
  }
}

/**
 * The part summaries of a long document (docs/design/14), by the hash of the
 * segment each one summarizes — the same hash the segmented extractor keys
 * its results by, so an edit re-summarizes only the segments it changed and
 * an interrupted document resumes with the parts it has.
 */
export function readSourceSummaryParts(dataDir: string, key: string): Map<string, SourceSummaryPart> {
  const raw = readJson<{ parts?: Record<string, Partial<SourceSummaryPart>> }>(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_PARTS_FILE));
  const out = new Map<string, SourceSummaryPart>();
  if (!raw || typeof raw.parts !== 'object' || raw.parts === null) return out;
  for (const [sha, p] of Object.entries(raw.parts)) {
    if (typeof p?.body === 'string' && p.body.trim()) out.set(sha, { body: p.body, model: String(p.model ?? ''), generatedAt: String(p.generatedAt ?? '') });
  }
  return out;
}

/** Keep one part; parts of segments the document no longer has (not in `keep`) are dropped with it. */
export function writeSourceSummaryPart(dataDir: string, key: string, sha: string, part: SourceSummaryPart, keep?: Iterable<string>): void {
  const parts = readSourceSummaryParts(dataDir, key);
  parts.set(sha, part);
  if (keep) {
    const current = new Set(keep);
    for (const s of [...parts.keys()]) if (!current.has(s)) parts.delete(s);
  }
  writeAtomic(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_PARTS_FILE), `${JSON.stringify({ parts: Object.fromEntries(parts) }, null, 2)}\n`);
}

/**
 * Failed attempts at a document's summary page, counted for the content they
 * were made on, so the background pass stops retrying a document that keeps
 * failing until its content changes.
 */
export interface SourceSummaryFailure {
  contentSha: string;
  attempts: number;
  error: string;
  at: string;
}

export function readSourceSummaryFailure(dataDir: string, key: string): SourceSummaryFailure | null {
  const raw = readJson<Partial<SourceSummaryFailure>>(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FAILED_FILE));
  if (!raw || typeof raw.contentSha !== 'string' || typeof raw.attempts !== 'number') return null;
  return { contentSha: raw.contentSha, attempts: raw.attempts, error: String(raw.error ?? ''), at: String(raw.at ?? '') };
}

/** One more failure on this content; a failure on different content starts the count over. */
export function recordSourceSummaryFailure(dataDir: string, key: string, contentSha: string, error: string): SourceSummaryFailure {
  const prev = readSourceSummaryFailure(dataDir, key);
  const next: SourceSummaryFailure = {
    contentSha,
    attempts: prev?.contentSha === contentSha ? prev.attempts + 1 : 1,
    error: error.slice(0, 300),
    at: new Date().toISOString(),
  };
  writeAtomic(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FAILED_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function clearSourceSummaryFailure(dataDir: string, key: string): void {
  fs.rmSync(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FAILED_FILE), { force: true });
}

/* ----------------------------- translations ----------------------------- */

/**
 * A document's indexed text in another language (docs/design/17): the whole
 * translation, written once every segment is in, keyed by the content it
 * translates. The original is never touched; a reader switches to this.
 */
export interface TranslationCache {
  contentSha: string;
  /** The language translated from, as detected. */
  source: string;
  language: string;
  /** Who translated it; the models of a long document's parts, comma-joined when they differ. */
  model: string;
  generatedAt: string;
  parts: number;
  body: string;
}

/** One segment translated, by the hash of the segment's text. */
export interface TranslationPart {
  body: string;
  model: string;
  generatedAt: string;
}

/** A language code as a file name: `zh-Hant` stays readable, anything odd cannot climb out of the directory. */
const languageFile = (language: string) => language.replace(/[^A-Za-z0-9-]/g, '_');

const translationFile = (dataDir: string, key: string, language: string) =>
  path.join(sidecarDir(dataDir, key), TRANSLATIONS_DIR, `${languageFile(language)}.md`);
const translationPartsFile = (dataDir: string, key: string, language: string) =>
  path.join(sidecarDir(dataDir, key), TRANSLATIONS_DIR, `${languageFile(language)}.parts.json`);

export function readTranslation(dataDir: string, key: string, language: string): TranslationCache | null {
  const cache = readMarkdownCache(translationFile(dataDir, key, language));
  if (!cache) return null;
  const contentSha = cacheString(cache.frontmatter.contentSha);
  const source = cacheString(cache.frontmatter.source);
  const model = cacheString(cache.frontmatter.model);
  const generatedAt = cacheString(cache.frontmatter.generatedAt);
  if (contentSha === null || source === null || model === null || generatedAt === null) return null;
  const parts = Number(cacheString(cache.frontmatter.parts) ?? '1');
  return { contentSha, source, language, model, generatedAt, parts: Number.isFinite(parts) && parts >= 1 ? parts : 1, body: cache.body };
}

export function writeTranslation(dataDir: string, key: string, cache: TranslationCache): void {
  writeMarkdownCache(
    translationFile(dataDir, key, cache.language),
    { contentSha: cache.contentSha, source: cache.source, language: cache.language, model: cache.model, generatedAt: cache.generatedAt, parts: String(cache.parts) },
    cache.body,
  );
}

export function readTranslationParts(dataDir: string, key: string, language: string): Map<string, TranslationPart> {
  const raw = readJson<{ parts?: Record<string, Partial<TranslationPart>> }>(translationPartsFile(dataDir, key, language));
  const out = new Map<string, TranslationPart>();
  if (!raw || typeof raw.parts !== 'object' || raw.parts === null) return out;
  for (const [sha, p] of Object.entries(raw.parts)) {
    if (typeof p?.body === 'string') out.set(sha, { body: p.body, model: String(p.model ?? ''), generatedAt: String(p.generatedAt ?? '') });
  }
  return out;
}

/** Keep one translated segment; segments the document no longer has (not in `keep`) are dropped with it. */
export function writeTranslationPart(dataDir: string, key: string, language: string, sha: string, part: TranslationPart, keep?: Iterable<string>): void {
  const parts = readTranslationParts(dataDir, key, language);
  parts.set(sha, part);
  if (keep) {
    const current = new Set(keep);
    for (const s of [...parts.keys()]) if (!current.has(s)) parts.delete(s);
  }
  writeAtomic(translationPartsFile(dataDir, key, language), `${JSON.stringify({ parts: Object.fromEntries(parts) }, null, 2)}\n`);
}

/** The languages a document has a translation (whole or begun) into. */
export function translationLanguages(dataDir: string, key: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(sidecarDir(dataDir, key), TRANSLATIONS_DIR));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const name of names) {
    const m = /^(.+?)(?:\.parts\.json|\.md)$/.exec(name);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/* ------------------------------- helpers ------------------------------- */

/**
 * Tier-1 extraction that can be replayed for free: status is done and the
 * content hash still matches. Shared by ingest replay and the tier-1 queue.
 */
/**
 * A tier-1 result that can be applied without calling a model: finished, for
 * this content, and covering the whole document — written by the segmented
 * extractor, or by the old single call for a document that fit in it.
 */
export function replayableTier1(t1: SidecarTier1 | null | undefined, contentSha: string, textChars: number): SidecarTier1 | null {
  if (!t1 || t1.status !== 'done' || t1.contentSha !== contentSha) return null;
  if (t1.segmenter === SEGMENTER_VERSION) return t1;
  return textChars <= LEGACY_EXTRACT_CHARS ? t1 : null;
}

/**
 * A finished single-call extraction of a document longer than that call read
 * (written before segmented extraction): it has to be extracted again.
 */
export function truncatedTier1(t1: SidecarTier1 | null | undefined, contentSha: string, textChars: number): boolean {
  return Boolean(t1 && t1.status === 'done' && t1.contentSha === contentSha && t1.segmenter === undefined && textChars > LEGACY_EXTRACT_CHARS);
}

export function emptyUsage(now = new Date().toISOString()): SidecarUsage {
  return { firstSeenAt: now, lastAccessedAt: null, accessCount: 0, heat: 0, chunkHits: {}, flushedAt: null };
}
