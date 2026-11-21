import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runWorkspaceDir } from '../src/eval/root.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import type { ChatRequest } from '../src/eval/shim.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/*
 * An update batch leaves the knode build's pages as current as `serve` would:
 * after the new documents are extracted, serve's review round re-renders the
 * pages their claims dirtied (src/labeling/followup.ts). The 2026-11 campaign's
 * update batches ran sync and the document passes only, and the entity pages
 * kept the value the batch replaced.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-update-pages-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
// no agent arm runs here; should one ever be added, it meets the suite's Codex stand-in, never a real Codex
const fakeBin = path.join(tmp, 'fake-bin');
const realPath = process.env.PATH;
beforeAll(() => {
  buildFixturePack(packDir);
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
  process.env.PATH = `${fakeBin}:${realPath}`;
});
afterAll(() => {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FIRST = '林晓的入职日期是 2026 年 4 月 1 日';
const MOVED = '林晓的入职日期调整为 2026 年 4 月 8 日';
const LEAVE = '林晓 2026 年 5 月 20 日请假回杭州';

/** The scripted backend, extracting a start-date claim from the two documents that state one, and a fact from the last batch's. */
class StartDateBackend extends ScriptedBackend {
  override async complete(req: ChatRequest) {
    const res = await super.complete(req);
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (!system.includes('knowledge-graph extraction engine')) return res;
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const out = JSON.parse(res.text) as { claims: unknown[] };
    if (user.includes('入职日期为 2026 年 4 月 1 日')) out.claims.push({ subject: '林晓', statement: FIRST, type: 'state', status: 'fact', kind: 'fact' });
    if (user.includes('入职日期调整为 2026 年 4 月 8 日')) out.claims.push({ subject: '林晓', statement: MOVED, type: 'state', status: 'fact', kind: 'fact' });
    if (user.includes('那天我请假回杭州')) out.claims.push({ subject: '林晓', statement: LEAVE, type: 'event', status: 'fact', kind: 'fact' });
    return { ...res, text: JSON.stringify(out) };
  }
}

describe('an update batch', () => {
  it("re-renders the entity pages its claims change, as serve's review does", async () => {
    const runDir = path.join(tmp, 'runs', 'update');
    await runEval({
      packs: [packDir], systems: ['knode-ask'], runDir, quota: false, suites: ['update'], judgeAudit: 0,
      overrides: { chat: new StartDateBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(runDir);
    expect(store.allBuilds().map((b) => b.system)).toEqual(expect.arrayContaining(['knode', 'knode@01', 'knode@02']));

    const ws = runWorkspaceDir(runDir, 'fixture-life');
    const ctx = await createContext(ws, { readOnly: true });
    try {
      const [person] = await ctx.store.query<{ wiki_path: string | null }>(`SELECT wiki_path FROM entities WHERE name = '林晓' AND tx_to IS NULL AND canonical_id IS NULL`);
      expect(person?.wiki_path).toBeTruthy();
      const page = fs.readFileSync(path.join(ws, person.wiki_path!), 'utf8');
      // the last batch's claim is on the page: before, a batch's changes waited for the next batch's sync, and the last's for none
      expect(page).toContain(LEAVE);
      expect(page).toContain('raw/docs/chat/2026-04-02.md');
      // the first batch's document is the current state, the build's one its history
      const current = page.split('\n').find((l) => l.includes('**入职日期**'));
      expect(current).toContain('raw/docs/email/2026-03-28.md');
      expect(page).toMatch(/history: .*\(2026-03-05\)/);
      // nothing the batches dirtied is left for a sync that never comes
      const dirty = await ctx.store.query<{ path: string; kind: string }>(`SELECT path, kind FROM pages WHERE status = 'dirty'`);
      expect(dirty).toEqual([]);
    } finally {
      await ctx.store.close();
    }
  }, 300_000);
});
