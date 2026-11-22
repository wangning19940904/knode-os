import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VectorCache } from '../src/eval/shim.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-cache-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('VectorCache.reload', () => {
  it('sees vectors another run copied into the file after the cache was opened', () => {
    const file = path.join(tmp, 'vectors.jsonl');
    // the run's state opens the cache before reuseBuilds copies the other run's vectors
    const mine = new VectorCache(file);
    expect(mine.get('k1')).toBeUndefined();
    const other = path.join(tmp, 'other.jsonl');
    new VectorCache(other).put('k1', [0.5, 0.25]);
    fs.copyFileSync(other, file);
    expect(mine.get('k1')).toBeUndefined();
    mine.reload();
    expect(mine.get('k1')).toEqual([0.5, 0.25]);
    // what it held before stays
    mine.put('k2', [1, 0]);
    mine.reload();
    expect(mine.get('k2')).toEqual([1, 0]);
  });
});
