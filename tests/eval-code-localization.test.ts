import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { datedAfter } from '../src/eval/leak.js';
import { loadPack, validatePack } from '../src/eval/pack.js';
import { buildCodeLocalizationPack, isHousekeeping, isSourceFile, messageBody, messageNamesSymbol, stratumOf } from '../src/eval/packs/code-localization.js';
import { taskPrompt } from '../src/eval/prompts.js';
import { matchByAlias, splitListedItems } from '../src/eval/score/lists.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-codeloc-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BODY = 'This paragraph explains the change at length, the way a squash-merged pull request carries its description.';

function repo(): string {
  const dir = path.join(tmp, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg: string) => {
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg);
  };
  g('init', '-q', '-b', 'main');
  write('src/session.ts', 'export function resumeSession(id: string) {\n  return id;\n}\n');
  write('src/approval.ts', 'export class ApprovalPolicy {}\n');
  write('src/render.ts', 'export function draw() {}\n');
  write('tests/session.test.ts', 'test("x", () => {});\n');
  write('README.md', '# demo\n');
  commit('base');
  // plain: two kept files, a source file among them, a long body
  write('src/session.ts', 'export function resumeSession(id: string) {\n  return id.trim();\n}\n');
  write('src/render.ts', 'export function draw() { return 1; }\n');
  commit(`Keep a continued conversation where it stopped\n\n${BODY}`);
  // symbol: the message names an identifier one gold file defines
  write('src/approval.ts', 'export class ApprovalPolicy { strict = true }\n');
  write('tests/session.test.ts', 'test("y", () => {});\n');
  commit(`Make \`ApprovalPolicy\` strict by default\n\n${BODY}`);
  // named: the message holds a gold file's basename
  write('src/render.ts', 'export function draw() { return 2; }\n');
  write('README.md', '# demo 2\n');
  commit(`Speed up render.ts\n\n${BODY}`);
  // rejected: short body
  write('src/render.ts', 'export function draw() { return 3; }\n');
  write('src/session.ts', 'export function resumeSession(id: string) {\n  return id;\n}\n');
  commit('Tidy');
  // rejected: creates a file after the base
  write('src/new.ts', 'export const x = 1;\n');
  write('src/render.ts', 'export function draw() { return 4; }\n');
  commit(`Add a module\n\n${BODY}`);
  // rejected: only documentation and tests
  write('README.md', '# demo 3\n');
  write('tests/session.test.ts', 'test("z", () => {});\n');
  commit(`Document the session tests\n\n${BODY}`);
  // rejected: a release
  write('src/render.ts', 'export function draw() { return 5; }\n');
  write('src/approval.ts', 'export class ApprovalPolicy {}\n');
  commit(`release: v1.2.3\n\n${BODY}`);
  return dir;
}

describe('code-localization recipe (docs/design/37 §2)', () => {
  it('reads strata, filters and the message frame', () => {
    expect(isHousekeeping('Revert "x"')).toBe('revert');
    expect(isHousekeeping('chore(deps): bump serde from 1.0 to 1.1')).toBe('dependency');
    expect(isHousekeeping('release: v0.3.1')).toBe('release');
    expect(isHousekeeping('Keep the TUI cursor visible (#63056)')).toBeNull();
    expect(messageBody('Subject\n\nBody text\n\nCo-authored-by: a <a@b>')).toBe('Body text');
    expect(isSourceFile('codex-rs/core/src/lib.rs')).toBe(true);
    expect(isSourceFile('codex-rs/core/tests/suite/x.rs')).toBe(false);
    expect(isSourceFile('src/a.test.ts')).toBe(false);
    expect(isSourceFile('docs/a.md')).toBe(false);
    // identifier-shaped names count anywhere; a lower-case word only as code; two code spans are not one
    expect(messageNamesSymbol('Raise the cap for spawn_agent', 'spawn_agent')).toBe(true);
    expect(messageNamesSymbol('Open the config panel', 'panel')).toBe(false);
    expect(messageNamesSymbol('Use `spawn` and `x` in the config panel', 'panel')).toBe(false);
    expect(messageNamesSymbol('Call `panel` first', 'panel')).toBe(true);
    expect(messageNamesSymbol('Call new() now', 'new')).toBe(false);
    expect(stratumOf('fix src/a.ts', ['src/a.ts'], () => []).stratum).toBe('named');
    expect(stratumOf('fix a thing', ['src/a.ts'], () => ['ToolRouter']).stratum).toBe('plain');
  });

  it('builds a pack whose tasks are the commits that pass, with gold paths and strata', async () => {
    const dir = repo();
    const out = path.join(tmp, 'pack');
    const issues = await buildCodeLocalizationPack(out, { log: () => {}, options: { from: dir, name: 'demo', window: 7, minPlain: 1 } });
    expect(issues.errors).toEqual([]);
    const pack = loadPack(out);
    expect(pack.manifest.cutoff).toBe('2026-01-01T00:00:00Z');
    expect(pack.docs.map((d) => d.path).sort()).toEqual(['codebase/demo/README.md', 'codebase/demo/src/approval.ts', 'codebase/demo/src/render.ts', 'codebase/demo/src/session.ts', 'codebase/demo/tests/session.test.ts']);
    const byStratum = Object.fromEntries(pack.tasks.map((t) => [t.meta!.stratum, t]));
    expect(pack.tasks).toHaveLength(3);
    expect(byStratum.plain.items!.map((i) => i.label).sort()).toEqual(['src/render.ts', 'src/session.ts']);
    expect(byStratum.symbol.meta!.namedSymbols).toEqual(['ApprovalPolicy']);
    expect(byStratum.named.meta!.namedPaths).toEqual(['src/render.ts']);
    expect(byStratum.plain.question).toContain('Keep a continued conversation where it stopped');
    expect(byStratum.plain.list).toMatchObject({ match: 'alias', primary: 'f1' });
    const prof = JSON.parse(fs.readFileSync(path.join(out, 'gold', 'profile.json'), 'utf8'));
    expect(prof.rejected).toMatchObject({ 'short body': 1, 'a file created after the base': 1, 'no source file': 1, release: 1 });
    expect(taskPrompt(byStratum.plain)).toContain('relative to the repository root');
  });

  it('matches answers by path, whatever folder they are written from', () => {
    const gold = [{ label: 'codex-rs/core/src/lib.rs', aliases: [], weight: 1 }, { label: 'codex-rs/tui/src/app.rs', aliases: [], weight: 1 }];
    expect(matchByAlias(['codebase/openai-codex/codex-rs/tui/src/app.rs', 'codex-rs/core/src/lib.rs', 'codex-rs/core/src/main.rs'], gold)).toEqual([[0, 1], [1, 0]]);
    // a path is not a list: its slashes do not split it
    expect(splitListedItems([{ label: 'codex-rs/core/src/lib.rs' }], gold)).toHaveLength(1);
  });

  it('refuses documents dated after the cutoff', () => {
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(ws, 'raw', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'raw', 'docs', 'late.md'), '---\ndate: 2026-02-01\n---\nlater\n');
    fs.writeFileSync(path.join(ws, 'raw', 'docs', 'early.md'), '---\ndate: 2025-12-01\n---\nearlier\n');
    expect(datedAfter(ws, '2026-01-01T00:00:00Z').map((l) => l.file)).toEqual(['raw/docs/late.md']);
    const out = path.join(tmp, 'pack');
    const pack = loadPack(out);
    pack.docs[0] = { ...pack.docs[0], date: '2027-01-01' };
    expect(validatePack(pack).errors.join('\n')).toContain('dated after the cutoff');
  });
});
