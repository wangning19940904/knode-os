import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { writeReport } from '../src/eval/report.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import type { ChatRequest } from '../src/eval/shim.js';
import { DEFAULT_SYSTEMS, makeSystems } from '../src/eval/systems/index.js';
import { ASK_HOPS_SAG, knodeAskHops } from '../src/eval/systems/knode.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/*
 * `knode-ask-hops`: Ask with bridge terms and computed sets on, answered
 * beside the default `knode-ask` on the one knode build, so one report has
 * both. The 2026-11 campaign answered with both off.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ask-variant-'));
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

/** The scripted backend, keeping each answer prompt by the system that sent it. */
class RecordingBackend extends ScriptedBackend {
  prompts = new Map<string, string[]>();
  override async complete(req: ChatRequest) {
    if (req.tag?.stage === 'answer' && req.tag.system) {
      const text = req.messages.map((m) => m.content).join('\n');
      (this.prompts.get(req.tag.system) ?? this.prompts.set(req.tag.system, []).get(req.tag.system)!).push(text);
    }
    return super.complete(req);
  }
}

describe('knode-ask-hops', () => {
  it('is taken only when named, and says what it switches on', () => {
    expect(DEFAULT_SYSTEMS).toContain('knode-ask');
    expect(DEFAULT_SYSTEMS).not.toContain('knode-ask-hops');
    const [hops] = makeSystems(['knode-ask-hops']);
    expect(hops).toMatchObject({ id: 'knode-ask-hops', group: 'knode', kind: 'kb', answers: true });
    expect(hops.settings).toEqual({ askOptions: { computed: true }, sag: { bridgeTerms: 20, directRatio: 0.7 } });
    expect(ASK_HOPS_SAG).toEqual({ bridgeTerms: 20, directRatio: 0.7 });
    // the run's reference day as knode-ask reads it; computed sets on whatever the run's switch for knode-ask says
    expect(knodeAskHops({ KNODE_EVAL_ASK_COMPUTED: '0', KNODE_EVAL_ASK_NOW: '2026-04-30' }).settings).toEqual({
      askOptions: { computed: true, now: '2026-04-30' }, sag: ASK_HOPS_SAG,
    });
    expect(makeSystems(['knode-ask'])[0].settings).toEqual({ askOptions: {} });
  });

  it('answers beside knode-ask on the one build, both in the report', async () => {
    const runDir = path.join(tmp, 'runs', 'both');
    const chat = new RecordingBackend();
    await runEval({
      packs: [packDir], systems: ['knode-ask', 'knode-ask-hops'], runDir, quota: false, suites: ['usage'], judgeAudit: 0,
      overrides: { chat, judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(runDir);
    expect(store.allBuilds().map((b) => b.system)).toEqual(['knode']);
    const answered = (system: string) => store.allAnswers().filter((a) => a.system === system && !a.error).map((a) => a.taskId).sort();
    expect(answered('knode-ask').length).toBeGreaterThan(0);
    expect(answered('knode-ask-hops')).toEqual(answered('knode-ask'));
    // each answer's model call goes out under its own system
    expect(chat.prompts.get('knode-ask-hops')?.length).toBe(answered('knode-ask-hops').length);
    const { data } = writeReport(runDir);
    expect(data.systems).toEqual(expect.arrayContaining(['knode-ask', 'knode-ask-hops']));
    expect(Object.keys(data.usage['fixture-life'] ?? {})).toEqual(expect.arrayContaining(['knode-ask', 'knode-ask-hops']));
  }, 300_000);
});
