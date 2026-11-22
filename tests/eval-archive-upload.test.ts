import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServeQueue, ServeRefusedError } from '../src/eval/remote.js';
import { folderStamp, packFolder, readArchive } from '../src/work/eval-archive.js';

/**
 * A corpus folder goes to `serve` once (2026-11-22). The run of
 * docs/design/36 packed a 100M-character folder for every question at once,
 * stalled on it until `serve` timed its request out (408), and stopped as if
 * refused.
 */

let tmp: string;
let server: http.Server;
let url: string;
/** What the stand-in for serve does with the next requests, and what it saw. */
let seen: { method: string; sha: string }[];
let held: Map<string, Buffer>;
let script: { head?: number[]; put?: { status: number; body?: string }[]; status?: number[]; neverHeld?: boolean };

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-archive-upload-'));
  seen = [];
  held = new Map();
  script = {};
  server = http.createServer((req, res) => {
    const sha = (req.url ?? '').split('/').pop() ?? '';
    seen.push({ method: req.method ?? '', sha });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if ((req.url ?? '').includes('/eval/v1/status')) {
        const forced = script.status?.shift();
        res.writeHead(forced ?? 200, { 'content-type': 'application/json' }).end(forced ? '' : JSON.stringify({ offered: true, slots: { 'eval-call': [], 'eval-session': [] }, run: { waiting: 0, leased: 0 } }));
        return;
      }
      if (req.method === 'HEAD') {
        const forced = script.head?.shift();
        res.writeHead(forced ?? (held.has(sha) && !script.neverHeld ? 200 : 404)).end();
        return;
      }
      const forced = script.put?.shift();
      if (forced) {
        res.writeHead(forced.status).end(forced.body ?? '');
        return;
      }
      const gzip = Buffer.concat(chunks);
      readArchive(gzip, sha);
      held.set(sha, gzip);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function corpus(): string {
  const dir = path.join(tmp, 'corpus');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'a.md'), '林晓 2024 年报');
  fs.writeFileSync(path.join(dir, 'index.md'), 'index');
  return dir;
}

const signal = () => new AbortController().signal;

describe('packFolder', () => {
  it('names the folder without keeping its bytes, and builds the stream it named', () => {
    const dir = corpus();
    const packed = packFolder(dir);
    expect(packed.files).toBe(2);
    const entries = readArchive(packed.gzip(), packed.sha256);
    expect(entries.map((e) => e.path)).toEqual(['docs/a.md', 'index.md']);
    expect(packed.bytes).toBe('KPA1\n'.length + entries.reduce((n, e) => n + Buffer.byteLength(`${JSON.stringify({ p: e.path, n: e.data.length })}\n`) + e.data.length, 0));
  });

  it('refuses to send a folder that changed after it was named', () => {
    const dir = corpus();
    const packed = packFolder(dir);
    fs.writeFileSync(path.join(dir, 'index.md'), 'another index');
    expect(() => packed.gzip()).toThrow(/changed while it was packed/);
  });

  it('stamps a folder by its files: the same until one is written again', () => {
    const dir = corpus();
    const one = folderStamp(dir);
    expect(folderStamp(dir)).toBe(one);
    fs.writeFileSync(path.join(dir, 'index.md'), 'longer index');
    expect(folderStamp(dir)).not.toBe(one);
  });
});

describe('a run uploads its corpus folder', () => {
  it('once for the questions that ask together, and reads it once for those that ask later', async () => {
    const dir = corpus();
    const q = new ServeQueue(url, 't');
    const all = await Promise.all(Array.from({ length: 40 }, () => q.archive(dir, signal())));
    expect(new Set(all.map((a) => a.sha256)).size).toBe(1);
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT']);
    // later questions take serve's word for an hour, and nothing is asked or sent
    await q.archive(dir, signal());
    await q.archive(dir, signal());
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT']);
    q.close();
  });

  it('once, to a serve whose check says 404 whatever it holds (one built before 2026-11-22)', async () => {
    const dir = corpus();
    script.neverHeld = true;
    const q = new ServeQueue(url, 't');
    for (let i = 0; i < 5; i++) await Promise.all(Array.from({ length: 20 }, () => q.archive(dir, signal())));
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT']);
    q.close();
  });

  it('once for the copies of one folder a knode arm makes for each question', async () => {
    const dir = corpus();
    script.neverHeld = true;
    const q = new ServeQueue(url, 't');
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const copy = path.join(tmp, `copy-${i}`);
      fs.cpSync(dir, copy, { recursive: true });
      ids.add((await q.archive(copy, signal())).sha256);
    }
    expect(ids.size).toBe(1);
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT']);
    q.close();
  });

  it('packs it again once a file has changed (an update batch)', async () => {
    const dir = corpus();
    const q = new ServeQueue(url, 't');
    const before = await q.archive(dir, signal());
    fs.writeFileSync(path.join(dir, 'docs', 'b.md'), 'a new document');
    const after = await q.archive(dir, signal());
    expect(after.sha256).not.toBe(before.sha256);
    expect(readArchive(held.get(after.sha256)!, after.sha256).map((e) => e.path)).toEqual(['docs/a.md', 'docs/b.md', 'index.md']);
    q.close();
  });

  it('asks again after an hour, and sends it again when serve no longer holds it', async () => {
    const dir = corpus();
    const q = new ServeQueue(url, 't');
    const a = await q.archive(dir, signal());
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3_600_001);
    await q.archive(dir, signal());
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT', 'HEAD']);
    held.delete(a.sha256);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 2 * 3_600_001 + 1);
    await q.archive(dir, signal());
    expect(held.has(a.sha256)).toBe(true);
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT', 'HEAD', 'HEAD', 'PUT']);
    q.close();
  });

  it('takes a timed-out request as no answer, not as a refusal', async () => {
    const dir = corpus();
    const q = new ServeQueue(url, 't');
    script.head = [408];
    const first = await q.archive(dir, signal()).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(ServeRefusedError);
    script.put = [{ status: 408 }, { status: 400 }, { status: 429 }];
    for (let i = 0; i < 3; i++) {
      const err = await q.archive(dir, signal()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ServeRefusedError);
    }
    // the caller's next try goes through
    const a = await q.archive(dir, signal());
    expect(held.has(a.sha256)).toBe(true);
    q.close();
  });

  it('still stops on a refusal serve words, and on one of the check', async () => {
    const dir = corpus();
    const q = new ServeQueue(url, 't');
    script.put = [{ status: 400, body: JSON.stringify({ error: 'archive does not match its id' }) }];
    await expect(q.archive(dir, signal())).rejects.toBeInstanceOf(ServeRefusedError);
    script.head = [401];
    await expect(q.archive(dir, signal())).rejects.toBeInstanceOf(ServeRefusedError);
    script.put = [{ status: 413, body: JSON.stringify({ error: 'an archive above the limit' }) }];
    await expect(q.archive(dir, signal())).rejects.toBeInstanceOf(ServeRefusedError);
    q.close();
  });

  it('takes a timed-out status request as no answer too', async () => {
    const q = new ServeQueue(url, 't');
    script.status = [408, 429, 401];
    for (let i = 0; i < 2; i++) {
      const err = await q.status('r1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ServeRefusedError);
    }
    await expect(q.status('r1')).rejects.toBeInstanceOf(ServeRefusedError);
    expect((await q.status('r1')).offered).toBe(true);
    q.close();
  });
});
