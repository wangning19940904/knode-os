import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grepability } from '../src/eval/grepability.js';
import { lintPack } from '../src/eval/lint.js';
import { docText, LoadedPack, loadPack, validatePack } from '../src/eval/pack.js';
import { recipe } from '../src/eval/packs/index.js';
import '../src/eval/packs/recipes.js';
import { settingTrueAt, V3_FAMILY_MIN, V3_STRATUM_MIN } from '../src/eval/packs/reports-v3-tasks.js';
import { isoWeek, makeV3World, V3_CORPUS, weekLabel } from '../src/eval/packs/reports-v3.js';
import { lexicalOverlap } from '../src/eval/packs/separation.js';
import { readValue } from '../src/eval/score/values.js';
import type { Task } from '../src/eval/types.js';

let tmp: string;
const packs: Record<string, LoadedPack> = {};
const build = async (name: string, id: string, options: Record<string, unknown> = {}) => {
  const out = path.join(tmp, name);
  const issues = await recipe(id).build(out, { seed: 0, log: () => {}, options });
  expect(issues.errors).toEqual([]);
  packs[name] = loadPack(out);
  return packs[name];
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-v3-'));
  await build('zh', 'synthetic-reports-zh', { version: 3 });
  await build('en', 'synthetic-reports-en', { version: 3 });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Task ids, questions and gold: what "the same questions" means. */
const gold = (t: Task) => JSON.stringify([t.id, t.question, t.answer ?? null, t.answers ?? null, (t.items ?? []).map((i) => [i.label, i.aliases, i.docs ?? null]), t.evidence.map((e) => e.doc)]);
const digest = (p: LoadedPack) => crypto.createHash('sha1').update(p.tasks.map(gold).join('\n')).digest('hex');
const fileHash = (p: LoadedPack, f: string) => crypto.createHash('sha1').update(fs.readFileSync(path.join(p.dir, f))).digest('hex');

describe('weekly reports v2 stays reachable', () => {
  it('builds the same tasks, gold and corpus as main did before recipe v3 (7f44c8f)', async () => {
    // recorded from main at 7f44c8f with the same digest: a change here changes every v2 pack
    const expected: [string, Record<string, unknown>, number, string, string][] = [
      ['synthetic-reports-zh', {}, 208, '4501135f620adead743a244edc6339aaa7adbcae', '6f929cc3f938d272146dc52c8291a53a7780cf51'],
      ['synthetic-reports-en', {}, 210, '015fda517debe931a022851a8387e1731cee0d7c', 'af2ccb0be4de523babca22823ad42153cb15bfb1'],
      ['synthetic-reports-zh', { size: 10 }, 1896, '0b3d6e98ae6ca7ec1fbbf30658ec274d11a4c0bc', '1296d94637221435dd13bfa7d545a8e9e1e166f0'],
    ];
    for (const [id, opts, n, tasks, corpus] of expected) {
      const p = await build(`v2-${id}-${JSON.stringify(opts).replace(/\W/g, '')}`, id, opts);
      expect(p.tasks).toHaveLength(n);
      expect(digest(p)).toBe(tasks);
      expect(fileHash(p, 'corpus.jsonl')).toBe(corpus);
    }
  });
});

describe('weekly reports v3: the corpus', () => {
  it('files reports by week, so a path says nothing about the team; by-team keeps the old layout', async () => {
    for (const p of [packs.zh, packs.en]) {
      const world = makeV3World(p.manifest.languages[0] as 'zh', 0, 1);
      const teams = world.divisions[0].teams.map((t) => t.name);
      for (const d of p.docs) {
        expect(teams.some((t) => d.path.includes(t)), d.path).toBe(false);
        if (d.kind === 'weekly-report') expect(d.path).toMatch(/^(周报|weekly)\/\d{4}-W\d{2}\/[0-9a-f]{10}\.md$/);
      }
    }
    const byTeam = await build('by-team', 'synthetic-reports-zh', { version: 3, layout: 'by-team' });
    expect(byTeam.manifest.id).toBe('synthetic-reports-zh-v3-by-team');
    expect(byTeam.docs.filter((d) => d.kind === 'weekly-report').every((d) => /^周报\/杭州(平台|支付|增长)组\//.test(d.path))).toBe(true);
    // the same questions, about documents at other paths
    expect(byTeam.tasks.map((t) => t.id)).toEqual(packs.zh.tasks.map((t) => t.id));
  });

  it('spans two and a half years: 122 reports a team in the corpus, ISO weeks across three years', () => {
    const weekly = packs.zh.docs.filter((d) => d.kind === 'weekly-report');
    expect(weekly).toHaveLength(3 * V3_CORPUS);
    expect(weekLabel(1)).toBe('2024-W01');
    expect(weekLabel(53)).toBe('2025-W01');
    expect(isoWeek(105)).toEqual({ year: 2026, week: 1 });
    expect(new Set(weekly.map((d) => d.date!.slice(0, 4)))).toEqual(new Set(['2024', '2025', '2026']));
    expect(fs.readdirSync(path.join(packs.zh.dir, 'updates'))).toEqual(['01', '02', '03', '04']);
  });

  it('holds long documents of 5,000–20,000 characters, and PMO summaries that say they prevail', () => {
    for (const p of [packs.zh, packs.en]) {
      for (const kind of ['quarterly-review', 'postmortem', 'minutes']) {
        const lens = p.docs.filter((d) => d.kind === kind).map((d) => docText(p, d.path).length);
        expect(lens.length, kind).toBeGreaterThan(10);
        expect(Math.min(...lens), kind).toBeGreaterThanOrEqual(5000);
        expect(Math.max(...lens), kind).toBeLessThanOrEqual(20000);
      }
      const pmo = p.docs.filter((d) => d.kind === 'pmo-summary');
      expect(pmo.every((d) => /以本月报为准|this summary prevails/.test(docText(p, d.path)))).toBe(true);
    }
  });

  it('states a rename once, then uses the new name alone', () => {
    const s = makeV3World('zh', 0, 1).divisions[0];
    const p = packs.zh;
    const byWeek = new Map(p.docs.filter((d) => d.kind === 'weekly-report').map((d) => [d.path, d]));
    for (const j of s.projects.filter((x) => x.rename && x.rename.week < V3_CORPUS - 2)) {
      const later = [...byWeek.values()].filter((d) => d.date! > p.docs.find((x) => x.title?.includes(`第${isoWeek(j.rename!.week).week}周`) && x.date!.startsWith(String(isoWeek(j.rename!.week).year)))!.date!);
      expect(later.some((d) => docText(p, d.path).includes(j.rename!.to))).toBe(true);
      expect(later.filter((d) => docText(p, d.path).includes(j.name))).toEqual([]);
    }
  });

  it('keeps the first division the same at every size', async () => {
    const big = await build('zh-x10', 'synthetic-reports-zh', { version: 3, size: 10 });
    expect(big.manifest.id).toBe('synthetic-reports-zh-v3-x10');
    expect(big.docs.length).toBe(10 * packs.zh.docs.length);
    const own = (p: LoadedPack) => p.tasks.filter((t) => !t.id.startsWith('co-') && !t.id.startsWith('x-'));
    expect(own(big).map(gold)).toEqual(own(packs.zh).map(gold));
    // and so are its documents
    for (const d of packs.zh.docs) expect(docText(big, d.path)).toBe(docText(packs.zh, d.path));
    // the company-wide questions name no division (the PMO's word)
    const co = big.tasks.filter((t) => t.id.startsWith('co-'));
    expect(co.length).toBeGreaterThan(10);
    expect(co.filter((t) => /事业部|division/i.test(t.question))).toEqual([]);
  });

  it('draws a hundred divisions with every customer, project and person id its own', () => {
    for (const lang of ['zh', 'en'] as const) {
      const w = makeV3World(lang, 0, 100);
      const customers = w.divisions.flatMap((s) => s.customers.map((c) => c.name));
      expect(new Set(customers).size).toBe(customers.length);
      const projects = w.divisions.flatMap((s) => s.projects.flatMap((p) => [p.name, ...(p.rename ? [p.rename.to] : [])]));
      expect(new Set(projects).size).toBe(projects.length);
      const teams = w.divisions.flatMap((s) => s.teams.map((t) => t.name));
      expect(teams.filter((t) => teams.some((u) => u !== t && u.includes(t)))).toEqual([]);
    }
  });

  it('builds the same pack from the same seed', async () => {
    const again = await build('zh-again', 'synthetic-reports-zh', { version: 3 });
    for (const f of ['corpus.jsonl', 'tasks/usage.jsonl', 'tasks/update.jsonl', 'gold/aliases.jsonl']) expect(fileHash(again, f)).toBe(fileHash(packs.zh, f));
  });
});

describe('weekly reports v3: the questions', () => {
  it('meets every family minimum and the hop strata, and lints clean', () => {
    for (const p of [packs.zh, packs.en]) {
      const r = lintPack(p);
      expect(r.findings).toEqual([]);
      for (const [f, n] of Object.entries(V3_FAMILY_MIN)) expect(r.families[f] ?? 0, f).toBeGreaterThanOrEqual(n);
      for (const [s, n] of Object.entries(V3_STRATUM_MIN)) expect(r.strata[s] ?? 0, s).toBeGreaterThanOrEqual(n);
      expect(validatePack(p).errors).toEqual([]);
    }
  });

  it('keeps design 33\'s rules: a third name no team, ids in at most a third, conventions stated', () => {
    for (const p of [packs.zh, packs.en]) {
      const rest = p.tasks.filter((t) => !String(t.meta?.family).startsWith('control'));
      expect(rest.filter((t) => !t.meta?.namesTeam).length / rest.length).toBeGreaterThanOrEqual(1 / 3);
      expect(rest.filter((t) => t.meta?.exactId).length / rest.length).toBeLessThanOrEqual(1 / 3);
      // a period's gold depends on how a report is dated: the question says so
      for (const t of p.tasks.filter((x) => x.meta?.family === 'aggregate' && x.meta?.period)) expect(t.question).toMatch(/周一|Monday/);
      for (const t of p.tasks.filter((x) => x.type === 'stale')) expect(t.question).toMatch(/更正|correction/);
    }
  });

  it('plants hops whose every step needs its own document and shares no word with the question', () => {
    const s = makeV3World('zh', 0, 1).divisions[0];
    const p = packs.zh;
    const hops = p.tasks.filter((t) => t.meta?.family === 'hop');
    for (const t of hops) {
      const n = Number(t.meta!.hops);
      expect(t.meta!.stratum).toBe(`h${n}`);
      expect(new Set(t.evidence.map((e) => e.doc)).size, t.id).toBe(n);
      expect((t.meta!.chain as string[]).length).toBe(n);
      // no bridge is named in the question
      for (const b of t.meta!.bridges as string[]) expect(t.question.includes(b), `${t.id} ${b}`).toBe(false);
    }
    expect(new Set(hops.map((t) => t.meta!.anchor))).toEqual(new Set(['described-incident', 'described-customer', 'nickname', 'old-name']));
    // a described anchor's question shares with its steps' whole documents (not only the stated lines) no word that
    // would narrow a search: whatever they share is in at least 5% of the corpus
    const described = hops.filter((t) => String(t.meta!.anchor).startsWith('described'));
    expect(described.length).toBeGreaterThan(20);
    const names = [...s.teams.map((x) => x.name), ...s.people.map((x) => x.name)];
    const all = p.docs.map((d) => docText(p, d.path));
    const df = (w: string) => all.filter((x) => x.includes(w)).length;
    for (const t of described.slice(0, 30)) {
      const docs = t.evidence.map((e) => docText(p, e.doc));
      expect(names.some((nm) => t.question.includes(nm))).toBe(false);
      // (words as the lint counts them: no function character, as in "的活" of "丙的活")
      for (const w of lexicalOverlap('zh', t.question, docs).filter((x) => !/[的了是个起在有和这那也就都与着或被把给从到对为以之其几么吗呢里一]/.test(x))) expect(df(w), `${t.id} ${w}`).toBeGreaterThanOrEqual(0.05 * all.length);
    }
  });

  it('answers the current state with corrections and the PMO\'s precedence applied', () => {
    const s = makeV3World('zh', 0, 1).divisions[0];
    const corrected = s.settings.find((x) => x.history.some((h, i) => h.how === 'correction' && i > 0 && x.history[i - 1].week + 2 < h.week))!;
    const k = corrected.history.findIndex((h, i) => h.how === 'correction' && i > 0);
    const before = corrected.history[k - 1];
    // between the wrong figure and its correction, the truth is the corrected value
    expect(settingTrueAt(corrected, before.week + 1)).toBe(corrected.history[k].value);
    const pmo = packs.zh.tasks.filter((t) => t.id.startsWith('st-metric-') && t.type === 'stale');
    expect(pmo.length).toBeGreaterThanOrEqual(10);
    for (const t of pmo) {
      const f = s.metricFixes.find((x) => t.id === `st-metric-${x.team}-${x.week}`)!;
      expect(t.answer).toBe(String(f.actual));
      expect(t.meta!.stale).toEqual([String(f.reported)]);
      expect(t.question).toContain('以月报为准');
    }
  });
});

describe('weekly reports v3: update questions', () => {
  it('reads a metric given at full size as the gold or as the stale value (upd-metric-*, protocol 36)', () => {
    const ups = packs.en.tasks.filter((t) => t.id.startsWith('upd-metric-') && (t.answers ?? []).some((a) => /^\d+k$/.test(a)));
    expect(ups.length).toBeGreaterThan(0);
    for (const t of ups) {
      const full = (k: string) => (Number(k.replace(/k$/, '')) * 1000).toLocaleString('en-US');
      const unit = (t.answers ?? []).find((a) => /^\d+k$/.test(a))!;
      expect(readValue(t, `Final answer: ${full(unit)} weekly active users.`).gold).toBe(true);
      const stale = (t.meta?.staleText as string[] | undefined)?.[0];
      if (!stale) continue;
      expect(stale).toBe(`${t.meta!.stale![0]}k`);
      expect(readValue(t, `Final answer: ${full(stale)}.`)).toMatchObject({ gold: false, stale: true });
    }
  });
});

describe('grep-ability', () => {
  it('finds the v3 hops much harder to reach by a literal term than its controls', () => {
    const r = grepability(packs.zh);
    const row = (f: string) => r.rows.find((x) => x.family === f)!;
    expect(row('hop').allGold).toBeLessThan(0.1);
    expect(row('control-exact').firstStep).toBe(1);
  });
});
