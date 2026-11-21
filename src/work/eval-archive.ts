import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A folder as one content-addressed archive (docs/design/27 §8): how an
 * evaluation run's file agent gets its staged folder onto a worker.
 *
 * The format is the simplest a worker with nothing but Node can read: gzip
 * over `KPA1\n`, then per file, in path order, one JSON line
 * `{"p":"<relative path>","n":<bytes>}` and the file's bytes. No modes, times
 * or links, so the same folder always makes the same stream, and its id —
 * the SHA-256 of the stream before compression — names it wherever it goes.
 * A worker downloads an archive once, keeps it by that id, and unpacks a
 * fresh copy for each session (worker/knode-worker.mjs keeps its own reader).
 */

const MAGIC = 'KPA1\n';
/** Above these the folder is no agent's corpus. */
export const ARCHIVE_MAX_BYTES = 2 * 1024 ** 3;
export const ARCHIVE_MAX_FILES = 200_000;

export interface PackedFolder {
  sha256: string;
  /** Size before compression. */
  bytes: number;
  files: number;
  /** Compressed on first use: a folder the server holds already is never compressed. */
  gzip(): Buffer;
}

function walk(root: string, rel = '', out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/**
 * Pack a folder: its files in path order, as described above. The id is
 * hashed a file at a time and the stream is only built when `gzip()` is
 * called: a corpus of hundreds of megabytes that the server holds already
 * costs one read, and nothing of it stays in memory.
 */
export function packFolder(dir: string): PackedFolder {
  const files = walk(dir).sort();
  if (files.length > ARCHIVE_MAX_FILES) throw new Error(`${dir}: ${files.length} files, more than an archive takes (${ARCHIVE_MAX_FILES})`);
  const hash = crypto.createHash('sha256').update(MAGIC);
  let bytes = Buffer.byteLength(MAGIC);
  let total = 0;
  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel));
    total += data.length;
    if (total > ARCHIVE_MAX_BYTES) throw new Error(`${dir}: more than ${ARCHIVE_MAX_BYTES} bytes, more than an archive takes`);
    const head = Buffer.from(`${JSON.stringify({ p: rel, n: data.length })}\n`);
    hash.update(head).update(data);
    bytes += head.length + data.length;
  }
  const sha256 = hash.digest('hex');
  let gzip: Buffer | null = null;
  return {
    sha256,
    bytes,
    files: files.length,
    gzip: () => {
      if (gzip) return gzip;
      const parts: Buffer[] = [Buffer.from(MAGIC)];
      for (const rel of files) {
        const data = fs.readFileSync(path.join(dir, rel));
        parts.push(Buffer.from(`${JSON.stringify({ p: rel, n: data.length })}\n`), data);
      }
      const raw = Buffer.concat(parts);
      // read a second time: the bytes sent must be the bytes named
      if (crypto.createHash('sha256').update(raw).digest('hex') !== sha256) throw new Error(`${dir} changed while it was packed`);
      return (gzip = zlib.gzipSync(raw, { level: 6 }));
    },
  };
}

/**
 * What a folder's files are without reading them: every path with its size
 * and modification time. Two equal stamps are the same folder for packing; a
 * file written again differs in one of the two.
 */
export function folderStamp(dir: string): string {
  const hash = crypto.createHash('sha256');
  for (const rel of walk(dir).sort()) {
    const st = fs.statSync(path.join(dir, rel));
    hash.update(`${rel}\0${st.size}\0${st.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

/** A path inside the archive's folder, or an error: no absolute path, no climbing out, nothing hidden at the top that a CLI reads as its own. */
export function archivePath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 1024) throw new Error('an archive entry has no usable path');
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) throw new Error(`an archive entry escapes its folder: ${p}`);
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`an archive entry escapes its folder: ${p}`);
  return p;
}

/** The entries of an archive's raw (decompressed) stream, checked against its id. */
export function readArchive(gzip: Buffer, sha256: string): { path: string; data: Buffer }[] {
  const raw = zlib.gunzipSync(gzip, { maxOutputLength: ARCHIVE_MAX_BYTES + 64 * 1024 * 1024 });
  const got = crypto.createHash('sha256').update(raw).digest('hex');
  if (got !== sha256) throw new Error(`archive ${sha256.slice(0, 12)} does not match its id (${got.slice(0, 12)})`);
  if (raw.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error('not a knode archive');
  const out: { path: string; data: Buffer }[] = [];
  let at = MAGIC.length;
  while (at < raw.length) {
    const nl = raw.indexOf(10, at);
    if (nl < 0) throw new Error('a torn archive entry');
    const head = JSON.parse(raw.subarray(at, nl).toString('utf8')) as { p?: unknown; n?: unknown };
    const n = Number(head.n);
    if (!Number.isSafeInteger(n) || n < 0 || nl + 1 + n > raw.length) throw new Error('a torn archive entry');
    out.push({ path: archivePath(head.p), data: raw.subarray(nl + 1, nl + 1 + n) });
    at = nl + 1 + n;
    if (out.length > ARCHIVE_MAX_FILES) throw new Error('too many archive entries');
  }
  return out;
}

/** Unpack an archive into `dest` (created). */
export function unpackArchive(gzip: Buffer, sha256: string, dest: string): number {
  const entries = readArchive(gzip, sha256);
  for (const e of entries) {
    const abs = path.join(dest, e.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data);
  }
  return entries.length;
}

export const isArchiveId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
