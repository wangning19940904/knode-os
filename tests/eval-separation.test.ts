import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Judge } from '../src/eval/judge.js';
import { entityResolution } from '../src/eval/metrics/entities.js';
import { minimumDetectableEffect } from '../src/eval/metrics/stats.js';
import { docText, LoadedPack, loadPack, validatePack } from '../src/eval/pack.js';
import { recipe } from '../src/eval/packs/index.js';
import '../src/eval/packs/recipes.js';
import { lexicallyDisjoint, lexicalOverlap, lexicalTokens } from '../src/eval/packs/separation.js';
import { CORPUS_WEEKS, makeReportWorld, monthOf } from '../src/eval/packs/reports.js';
import { makeScript } from '../src/eval/packs/synthetic.js';
import { ledgerTasks } from '../src/eval/packs/life-ledger.js';
import { buildReportData, renderReport } from '../src/eval/report.js';
import { Bm25, chunkDocs } from '../src/eval/retrieval.js';
import { selectTasks } from '../src/eval/run.js';
import { recordKey, RunStore } from '../src/eval/runstore.js';
import { matchByFields, namesDistractor, scoreLists } from '../src/eval/score/lists.js';
import { scoreKey, scoreUsage } from '../src/eval/score/usage.js';
import { emptyUsage, STRUCTURED_MIN_DOCS, type AnswerRecord, type ScoreRecord, type Task } from '../src/eval/types.js';

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sep-'));
  await build('zh', 'synthetic-reports-zh');
  await build('en', 'synthetic-reports-en');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const script = (p: LoadedPack) => JSON.parse(fs.readFileSync(path.join(p.dir, 'holdout', 'script.json'), 'utf8'));

describe('weekly reports: the month-end gold', () => {
  it('a month is the month of the report\'s own date (its Monday)', () => {
    // week 13 runs Mon 31 March – Fri 4 April 2025: a March report
    expect(monthOf(13)).toBe(3);
    expect(monthOf(14)).toBe(4);
  });

  it('every month-end gold item is the last report dated in that calendar month', () => {
    for (const name of ['zh', 'en']) {
      const p = packs[name];
      const dateOf = new Map(p.docs.map((d) => [d.path, d.date!]));
      const tasks = p.tasks.filter((t) => /^t-(metric|prog)-/.test(t.id));
      expect(tasks.length).toBeGreaterThan(5);
      for (const t of tasks) {
        for (const it of t.items!) {
          const doc = it.docs![0];
          const team = path.dirname(doc);
          const month = it.date!.slice(0, 7);
          expect(dateOf.get(doc)!.slice(0, 7), `${t.id} ${it.label}`).toBe(month);
          const sameMonth = p.docs.filter((d) => d.kind === 'weekly-report' && path.dirname(d.path) === team && d.date!.slice(0, 7) === month).map((d) => d.date!).sort();
          expect(dateOf.get(doc), `${t.id} ${month}`).toBe(sameMonth.at(-1));
        }
      }
    }
  });
});

describe('weekly reports: building', () => {
  it('passes validatePack with the new options, and names no week or date in file names', async () => {
    const p = packs.zh;
    expect(validatePack(p).errors).toEqual([]);
    expect(p.manifest.version).toBe(3);
    for (const d of p.docs.filter((x) => x.kind === 'weekly-report')) {
      expect(d.path).not.toMatch(/\d{4}-\d{2}-\d{2}|\/\d{2}-/);
      expect(docText(p, d.path)).toMatch(/\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/);
    }
    const dated = await build('dated', 'synthetic-reports-zh', { datedPaths: true });
    expect(dated.docs.filter((d) => d.kind === 'weekly-report').every((d) => /\/\d{2}-\d{4}-\d{2}-\d{2}\.md$/.test(d.path))).toBe(true);
  });

  it('builds the same pack from the same seed, and 10× natively with gold', async () => {
    const again = await build('zh-again', 'synthetic-reports-zh');
    const hash = (p: LoadedPack, f: string) => crypto.createHash('sha1').update(fs.readFileSync(path.join(p.dir, f))).digest('hex');
    for (const f of ['corpus.jsonl', 'tasks/usage.jsonl', 'tasks/emergence.jsonl', 'gold/aliases.jsonl']) expect(hash(again, f)).toBe(hash(packs.zh, f));
    const t0 = Date.now();
    const big = await build('x10', 'synthetic-reports-en', { size: 10 });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(big.manifest.id).toBe('synthetic-reports-en-x10');
    expect(big.docs.filter((d) => d.kind === 'weekly-report')).toHaveLength(10 * 3 * CORPUS_WEEKS);
    expect(new Set(big.docs.map((d) => d.path)).size).toBe(big.docs.length);
    // the company-wide count over every division's reports
    const p1 = big.tasks.find((t) => t.id === 'sq-company-p1')!;
    const world = makeReportWorld('en', 0, { size: 10 });
    expect(Number(p1.answer)).toBe(world.divisions.flatMap((s) => s.incidents.filter((i) => i.sev === 'P1' && i.week <= CORPUS_WEEKS)).length);
    // division questions say which division they ask about, by a team of it or by all three
    const second = world.divisions[1].teams.map((t) => t.name);
    expect(second).toEqual(['Platform 2', 'Payments 2', 'Growth 2']);
    for (const t of big.tasks.filter((x) => x.id.startsWith('d2-'))) expect(t.type === 'cross-lingual' ? t.question.includes('二部') : second.some((n) => t.question.includes(n)), t.question).toBe(true);
    expect(big.tasks.some((t) => t.question.startsWith('(Platform 2, Payments 2 and Growth 2) '))).toBe(true);
    expect(big.tasks.filter((t) => /Division \d|事业部/.test(t.question))).toEqual([]);
  });

  it('names a division in its weekly reports\' words, so a keyword search is not sent to the monthly summaries', async () => {
    // four divisions: the smallest company whose company-wide structured query spans its 21 documents
    const p = await build('x4', 'synthetic-reports-zh', { size: 4 });
    const weekly = p.docs.filter((d) => d.kind === 'weekly-report');
    const monthly = new Set(p.docs.filter((d) => d.kind === 'pmo-summary').map((d) => d.path));
    const world = makeReportWorld('zh', 0, { size: 4 });
    expect(world.divisions.map((s) => s.division.scope)).toEqual(['一部', '二部', '三部', '四部']);
    // what the PMO calls a division is in its summaries and in no weekly report; the scope is the prefix of its teams' names
    // (the first division's teams carry none: "一部" is in no document at all)
    expect(weekly.some((d) => docText(p, d.path).includes('事业部'))).toBe(false);
    expect([...monthly].every((d) => docText(p, d).includes('事业部'))).toBe(true);
    expect(p.docs.some((d) => docText(p, d.path).includes('一部'))).toBe(false);
    for (const s of world.divisions.slice(1)) {
      const mine = weekly.filter((d) => s.teams.some((t) => d.path.startsWith(`周报/${t.name}/`)));
      expect(mine).toHaveLength(3 * CORPUS_WEEKS);
      expect(mine.every((d) => docText(p, d.path).includes(s.division.scope))).toBe(true);
    }
    // no question of a division opens with the PMO's name; it names a team of the division, or the division by its scope
    const company = new Set(['sq-company-p1', 'sq-company-q2-divisions']);
    for (const t of p.tasks.filter((x) => !company.has(x.id) && x.type !== 'attribution' && !x.afterUpdate)) {
      const s = world.divisions[Number(/^d(\d+)-/.exec(t.id)?.[1] ?? 1) - 1];
      expect(t.question, t.id).not.toMatch(/事业部|Division/);
      const names = t.type === 'cross-lingual' ? s.teams.map((x) => x.alt) : [s.division.scope, ...s.teams.map((x) => x.name)];
      expect(names.some((n) => t.question.includes(n)), `${t.id}: ${t.question}`).toBe(true);
      // the qualifier in front only where no team is named
      if (t.question.startsWith(`（${s.division.scope}）`)) expect(s.teams.some((x) => t.question.includes(x.name)), t.question).toBe(false);
    }
    expect(p.tasks.find((t) => t.id === 'd2-r-n-p1')!.question).toBe(`截至第${CORPUS_WEEKS}周，二部的三个组一共出过几起P1事故？`);
    expect(p.tasks.find((t) => t.id === 'd2-r-p1-D2T1')!.question).toBe(`二部平台组今年（截至第${CORPUS_WEEKS}周）出过哪些P1事故？列出事故编号和名称。`);
    expect(p.tasks.find((t) => t.id === 'sq-company-p1')!.question).not.toContain('事业部');
    // one division alone is asked as before: no scope anywhere
    expect(packs.zh.tasks.some((t) => /[一二]部/.test(t.question))).toBe(false);
    expect(packs.zh.tasks.find((t) => t.id === 'r-n-p1')!.question).toBe(`截至第${CORPUS_WEEKS}周，三个组一共出过几起P1事故？`);

    // by keyword (the harness's own BM25) the second division's questions reach its weekly reports; with the PMO's
    // name in front, as the pack was built before, the top five were monthly summaries for nearly every one
    const bm25 = new Bm25(chunkDocs(p.docs.map((d) => ({ path: d.path, text: docText(p, d.path) }))), (c) => c.text);
    const top5 = (q: string) => [...new Set(bm25.search(q, 20).map((h) => h.item.doc))].slice(0, 5);
    const asked = p.tasks.filter((t) => t.id.startsWith('d2-') && t.suite === 'usage' && t.evidence.length && t.type !== 'cross-lingual');
    const share = (question: (t: Task) => string) => {
      const tops = asked.map((t) => ({ top: top5(question(t)), gold: new Set(t.evidence.map((e) => e.doc)) }));
      return { summaries: tops.filter((x) => x.top.every((d) => monthly.has(d))).length / tops.length, hit: tops.filter((x) => x.top.some((d) => x.gold.has(d))).length / tops.length };
    };
    const now = share((t) => t.question);
    const before = share((t) => `（第二事业部）${t.question.replace(/^（二部）/, '')}`);
    expect(asked.length).toBeGreaterThan(100);
    expect(before.summaries).toBeGreaterThan(0.8);
    expect(before.hit).toBeLessThan(0.1);
    expect(now.summaries).toBeLessThan(0.2);
    expect(now.hit).toBeGreaterThan(0.4);
  });

  it('samples deep hops in proportion to their chains at any size and limit', async () => {
    const chain = (t: Task) => t.id.replace(/^d\d+-/, '').split('-')[0];
    const mix = (ts: Task[]) => {
      const deep = ts.filter((t) => t.type === 'deep-hop');
      return Object.fromEntries(['h4', 'h5', 'h5r'].map((k) => [k, deep.filter((t) => chain(t) === k).length]));
    };
    const x4 = packs.x4 ?? (await build('x4', 'synthetic-reports-zh', { size: 4 }));
    for (const p of [packs.zh, packs.en, x4]) for (const t of p.tasks.filter((x) => x.type === 'deep-hop')) expect(t.meta?.stratum, t.id).toBe(chain(t));
    const suites = new Set(['usage', 'emergence']);
    const all = mix(packs.zh.tasks);
    expect(all).toEqual({ h4: 3, h5: 2, h5r: 2 });
    const scaled = mix(x4.tasks);
    expect(scaled.h4 + scaled.h5 + scaled.h5r).toBeGreaterThan(3 * 7);
    // the 1× pack whole, and 4× under limits: the same shares, to within a task
    const total = all.h4 + all.h5 + all.h5r;
    for (const limit of [60, 120, 200, 300]) {
      const picked = mix(selectTasks(x4.tasks.filter((t) => !t.afterUpdate), suites, limit, 0));
      const n = picked.h4 + picked.h5 + picked.h5r;
      expect(n, `limit ${limit}`).toBeGreaterThan(2);
      for (const k of ['h4', 'h5', 'h5r'] as const) expect(Math.abs(picked[k] - (n * all[k]) / total), `limit ${limit}: ${JSON.stringify(picked)}`).toBeLessThanOrEqual(1);
    }
    // a pack built before the chains were named samples as it did: primaries first, so no four-hop chain at all
    const unnamed = x4.tasks.map((t) => (t.type === 'deep-hop' ? { ...t, meta: { ...t.meta, stratum: undefined } } : t));
    expect(mix(selectTasks(unnamed.filter((t) => !t.afterUpdate), suites, 120, 0)).h4).toBe(0);
  });

  it('interleaves the strata of a type in proportion, primaries first within each, and leaves other types as they were', () => {
    const task = (id: string, type: string, stratum?: string, primary = false): Task => ({ id, suite: 'usage', type: type as Task['type'], question: id, scoring: 'judge', evidence: [], ...(stratum ? { meta: { stratum } } : {}), ...(primary ? { primary } : {}) });
    const tasks = [
      ...Array.from({ length: 12 }, (_, i) => task(`a${i}`, 'deep-hop', 'a')),
      ...Array.from({ length: 6 }, (_, i) => task(`b${i}`, 'deep-hop', 'b', i < 2)),
      ...Array.from({ length: 6 }, (_, i) => task(`c${i}`, 'deep-hop', 'c', true)),
      ...Array.from({ length: 24 }, (_, i) => task(`t${i}`, 'temporal', undefined, i % 5 === 0)),
    ];
    const suites = new Set(['usage']);
    for (const limit of [4, 8, 16, 24, 40]) {
      const picked = selectTasks(tasks, suites, limit, 7);
      const deep = picked.filter((t) => t.type === 'deep-hop');
      expect(deep).toHaveLength(limit / 2);
      const of = (k: string) => deep.filter((t) => t.meta?.stratum === k);
      expect(Math.abs(of('a').length - deep.length / 2), `limit ${limit}`).toBeLessThanOrEqual(1);
      expect(Math.abs(of('b').length - deep.length / 4), `limit ${limit}`).toBeLessThanOrEqual(1);
      expect(Math.abs(of('c').length - deep.length / 4), `limit ${limit}`).toBeLessThanOrEqual(1);
      // b's two primaries are the first two of b taken
      expect(of('b').slice(0, 2).every((t) => t.primary) || of('b').length < 2 ? true : false, `limit ${limit}`).toBe(true);
      // a type with no stratum: primaries first, as before
      const plain = picked.filter((t) => t.type === 'temporal');
      const firstOther = plain.findIndex((t) => !t.primary);
      expect(firstOther < 0 || plain.slice(firstOther).every((t) => !t.primary), `limit ${limit}`).toBe(true);
      expect(plain.filter((t) => t.primary)).toHaveLength(Math.min(5, plain.length));
    }
  });

  it('phrases each kind of fact several ways, so one pattern does not find them all', () => {
    const p = packs.zh;
    const s = script(p);
    const firstLines = s.incidents.map((i: { id: string }) => {
      for (const d of p.docs) {
        const line = docText(p, d.path).split('\n').find((l) => l.includes(i.id));
        if (line) return line;
      }
      return '';
    });
    const v1 = firstLines.filter((l: string) => /INC-\d{3}-T\d（P\d）/.test(l)).length;
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThan(firstLines.length);
    // some postmortems name the incident only by what happened
    expect(p.docs.some((d) => /上周那起.+已由.+修复/.test(docText(p, d.path)))).toBe(true);
  });

  it('counts tasks per type for each language', () => {
    for (const name of ['zh', 'en']) {
      const by = (type: string) => packs[name].tasks.filter((t) => t.type === type).length;
      expect(by('stale'), name).toBeGreaterThanOrEqual(12);
      expect(by('lookalike'), name).toBeGreaterThanOrEqual(8);
      expect(by('structured'), name).toBeGreaterThanOrEqual(8);
      expect(by('nonlexical-hop'), name).toBeGreaterThanOrEqual(5);
      expect(by('connection'), name).toBeGreaterThanOrEqual(30);
      expect(by('paraphrase'), name).toBeGreaterThanOrEqual(8);
      expect(by('cross-lingual'), name).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('weekly reports: the separation families', () => {
  it('stale traps: a setting\'s name only ever carries its first value; the answer is not among the stale values', () => {
    for (const name of ['zh', 'en']) {
      const p = packs[name];
      const s = script(p);
      for (const x of s.tracked as { name: string; unit: string; history: { value: number; via: string }[] }[]) {
        const later = x.history.slice(1).map((h) => `${h.value}${x.unit}`).filter((v) => v !== `${x.history[0].value}${x.unit}`);
        for (const d of p.docs) {
          const text = docText(p, d.path);
          if (!text.includes(x.name)) continue;
          for (const v of later) expect(text.includes(v), `${d.path} names ${x.name} beside ${v}`).toBe(false);
        }
        expect(x.history.slice(1).every((h) => h.via !== 'name')).toBe(true);
      }
      const stale = p.tasks.filter((t) => t.type === 'stale');
      for (const t of stale) {
        expect((t.meta!.stale as string[]).length).toBeGreaterThan(0);
        expect(t.meta!.stale as string[]).not.toContain(t.answer);
      }
      expect(stale.some((t) => t.asOf)).toBe(true);
    }
  });

  it('look-alikes: namesakes get two alias clusters told apart by team; near-identical names are not inside each other', () => {
    const p = packs.zh;
    const twins = p.aliases.filter((a) => a.kind === 'person' && a.context?.length);
    const byName = new Map<string, number>();
    for (const a of twins) byName.set(a.aliases[0], (byName.get(a.aliases[0]) ?? 0) + 1);
    expect([...byName.values()].filter((n) => n === 2).length).toBeGreaterThanOrEqual(3);
    const renamed = p.aliases.filter((a) => a.kind === 'project' && a.aliases.length > 1);
    expect(renamed.length).toBeGreaterThanOrEqual(3);
    for (const t of p.tasks.filter((x) => x.type === 'lookalike' && x.meta?.lookalike)) {
      const a = t.question;
      expect(a.includes(String(t.meta!.lookalike))).toBe(false);
    }
    const la = p.tasks.filter((t) => t.meta?.subtype === 'near-name' && t.meta?.distractors);
    expect(la.length).toBeGreaterThanOrEqual(2);
  });

  it('structured queries: more than 20 documents, gold recounted from the rendered corpus', () => {
    const p = packs.zh;
    for (const t of p.tasks.filter((x) => x.type === 'structured')) expect(new Set(t.evidence.map((e) => e.doc)).size).toBeGreaterThanOrEqual(STRUCTURED_MIN_DOCS);
    // recount incidents per team and quarter from the reports themselves: an ID's first report is when it happened
    const first = new Map<string, { team: string; date: string }>();
    for (const d of [...p.docs].filter((x) => x.kind === 'weekly-report').sort((a, b) => a.date!.localeCompare(b.date!))) {
      for (const m of docText(p, d.path).matchAll(/INC-\d{3}-(T\d)/g)) if (!first.has(m[0])) first.set(m[0], { team: path.basename(path.dirname(d.path)), date: d.date! });
    }
    const counts = new Map<string, number>();
    for (const { team, date } of first.values()) {
      const k = `${team} Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const task = p.tasks.find((t) => t.id === 'sq-inc-team-quarter')!;
    expect(new Map(task.items!.map((it) => [it.label.split('：')[0], Number(it.label.match(/(\d+)起$/)![1])]))).toEqual(counts);
  });

  it('non-lexical hops: the question shares no word with the bridges and names none of them', () => {
    for (const name of ['zh', 'en']) {
      const p = packs[name];
      const hops = p.tasks.filter((t) => t.type === 'nonlexical-hop');
      for (const t of hops) {
        expect(t.meta!.overlap).toEqual([]);
        for (const b of t.meta!.bridges as string[]) {
          expect(t.question.includes(b)).toBe(false);
          expect(t.evidence.some((e) => docText(p, e.doc).includes(b)), `${t.id}: ${b} in its evidence`).toBe(true);
        }
      }
    }
    expect(lexicalOverlap('zh', '是谁处理好的', ['由王芳修复'])).toEqual([]);
    expect(lexicalOverlap('en', 'who sorted out the outage', ['fixed by Emma Smith'])).toEqual([]);
    expect([...lexicalTokens('zh', '缓存击穿')]).toEqual(['缓存', '存击', '击穿']);
  });

  it('connections: at least 30 per pack, linked by causes and risks written in disjoint words', () => {
    for (const name of ['zh', 'en']) {
      const p = packs[name];
      const s = script(p);
      const cause = new Map<string, string>(s.incidents.map((i: { id: string; cause: string }) => [i.id, i.cause]));
      const risk = new Map<string, string>(s.risks.map((r: { id: string; text: string }) => [r.id, r.text]));
      const conn = p.tasks.filter((t) => t.type === 'connection');
      expect(conn.length).toBeGreaterThanOrEqual(30);
      for (const t of conn) {
        const self = t.id.replace(/^x-(cause|risk)-/, '');
        const text = (id: string) => cause.get(id) ?? risk.get(id)!;
        for (const it of t.items!) expect(lexicallyDisjoint(p.manifest.languages[0] as 'zh' | 'en', text(self), text(it.label)), `${self} ~ ${it.label}`).toBe(true);
      }
    }
  });

  it('paraphrased and cross-lingual copies keep the gold of the task they copy', () => {
    const p = packs.zh;
    for (const t of p.tasks.filter((x) => x.type === 'paraphrase' || x.type === 'cross-lingual')) {
      const base = p.tasks.find((x) => x.id === t.meta!.of)!;
      expect(base, String(t.meta!.of)).toBeTruthy();
      expect(t.answer).toBe(base.answer);
      expect(t.items).toEqual(base.items);
      expect(t.question).not.toBe(base.question);
      if (t.type === 'cross-lingual') expect(t.lang).toBe('en');
    }
  });
});

describe('the synthetic life: separation tasks from its ledger', () => {
  it('adds structured run queries, paraphrases and cross-lingual counts, and stale values to its update stream', () => {
    const s = makeScript('zh', 7);
    const docOf = new Map(s.events.map((e, i) => [e.id, `doc/${String(i).padStart(3, '0')}.md`]));
    const { tasks } = ledgerTasks({ lang: 'zh', cast: s.cast, events: s.events, extras: s.extras }, docOf);
    const km = tasks.find((t) => t.id === 'sq-km-month')!;
    const runs = s.events.filter((e) => e.cat === 'run');
    expect(km.items!.reduce((sum, it) => sum + Number(it.fields![1][0]), 0)).toBe(runs.reduce((sum, e) => sum + (e.value ?? 0), 0));
    expect(tasks.find((t) => t.id === 'sq-km-total')!.answer).toBe(String(runs.reduce((sum, e) => sum + (e.value ?? 0), 0)));
    expect(tasks.filter((t) => t.type === 'paraphrase').length).toBeGreaterThanOrEqual(3);
    expect(tasks.filter((t) => t.type === 'cross-lingual').every((t) => t.lang === 'en')).toBe(true);
    expect(s.updates.flatMap((b) => b.tasks).filter((t) => t.stale?.length).length).toBeGreaterThanOrEqual(5);
  });
});

/* --------------------------------- scoring --------------------------------- */

const answer = (taskId: string, text: string, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  key: recordKey('answer', 'p', 'sys', taskId, extra.repeat ?? 0), pack: 'p', system: 'sys', taskId, text, finalAnswer: '', citations: [], retrieved: [], toolCalls: 2,
  usage: { ...emptyUsage(), weightedTokens: 1000, costUsd: 0.01 }, ms: 10, at: new Date().toISOString(), ...extra,
});
const noJudge = { gradeAnswers: async () => new Map(), matchList: async () => new Map(), matchItems: async () => new Map() } as unknown as Judge;
const metric = (rs: ScoreRecord[], taskId: string, m: string, repeat?: number) => rs.find((r) => r.taskId === taskId && r.metric === m && r.repeat === repeat)?.value;

describe('scoring the separation families', () => {
  const stale: Task = { id: 'st', suite: 'usage', type: 'stale', question: 'q', answer: '240', answers: ['240个连接'], scoring: 'value', evidence: [], meta: { stale: ['200'] } };
  const avg: Task = { id: 'avg', suite: 'usage', type: 'structured', question: 'q', answer: '99.921', scoring: 'value', evidence: [], meta: { tolerance: 0.00101 } };
  const tasks = new Map([stale, avg].map((t) => [`p|${t.id}`, t]));

  it('scores a value without a model: right, stale, declined, confidently wrong', async () => {
    const rs = await scoreUsage({ answers: [
      answer('st', '…\nFinal answer: 240个连接（原先的200已更正）'),
      answer('st', 'Final answer: 200个连接', { repeat: 1 }),
      answer('st', 'Final answer: 资料中没有提到', { repeat: 2 }),
      answer('st', 'Final answer: 320', { repeat: 3 }),
      answer('avg', 'Final answer: 99.92%'),
    ], tasks, citing: new Set() }, noJudge);
    expect(metric(rs, 'st', 'correctness')).toBe(1);
    expect(metric(rs, 'st', 'stale_answer')).toBe(0);
    expect(metric(rs, 'st', 'correctness', 1)).toBe(0);
    expect(metric(rs, 'st', 'stale_answer', 1)).toBe(1);
    expect(metric(rs, 'st', 'confident_wrong', 1)).toBe(1);
    expect(metric(rs, 'st', 'false_refusal', 2)).toBe(1);
    expect(metric(rs, 'st', 'confident_wrong', 2)).toBe(0);
    expect(metric(rs, 'st', 'stale_answer', 3)).toBe(0);
    expect(metric(rs, 'st', 'confident_wrong', 3)).toBe(1);
    expect(metric(rs, 'avg', 'correctness')).toBe(1);
  });

  it('keys a repeat apart from the first answer, which keeps the keys runs had before', () => {
    const a = answer('st', 'x');
    expect(scoreKey(a, 'correctness')).toBe(recordKey('score', 'p', 'sys', 'st', 'correctness'));
    expect(scoreKey({ ...a, repeat: 1 }, 'correctness')).not.toBe(scoreKey(a, 'correctness'));
  });

  it('matches a structured query by fields and scores the whole set or nothing; counts a look-alike\'s items', async () => {
    const gold = [
      { label: '平台组 Q1：3起', aliases: [], weight: 1, fields: [['平台组'], ['Q1', '第一季度'], ['3']] },
      { label: '平台组 Q2：2起', aliases: [], weight: 1, fields: [['平台组'], ['Q2', '第二季度'], ['2']] },
    ];
    expect(matchByFields(['平台组第一季度：3起', '平台组 Q2: 2'], gold)).toEqual([[0, 0], [1, 1]]);
    expect(matchByFields(['平台组第一季度：4起'], gold)).toEqual([]);
    const sq: Task = { id: 'sq', suite: 'usage', type: 'structured', question: 'q', scoring: 'set', items: gold, list: { match: 'fields', ordered: false, maxItems: 10, requireDocs: false, primary: 'exact' }, evidence: [] };
    const la: Task = { id: 'la', suite: 'usage', type: 'lookalike', question: 'q', scoring: 'set', items: [{ label: 'INC-001-T1', aliases: [], weight: 1 }], list: { match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1' }, evidence: [], meta: { distractors: ['INC-009-T1'] } };
    const json = (labels: string[]) => `Final answer: see list\n{"items":[${labels.map((l) => `{"label":"${l}","confidence":0.9,"evidence":[]}`).join(',')}]}`;
    const rs = await scoreLists({ answers: [
      answer('sq', json(['平台组第一季度：3起', '平台组 Q2: 2'])),
      answer('sq', json(['平台组第一季度：3起', '平台组 Q2: 2', '平台组 Q3: 1']), { repeat: 1 }),
      answer('la', json(['INC-001-T1', 'INC-009-T1'])),
    ], tasks: new Map([sq, la].map((t) => [`p|${t.id}`, t])), corpusDocs: new Map() }, noJudge);
    expect(metric(rs, 'sq', 'correctness')).toBe(1);
    expect(metric(rs, 'sq', 'correctness', 1)).toBe(0);
    expect(metric(rs, 'sq', 'set_f1', 1)).toBeCloseTo(0.8, 5);
    expect(metric(rs, 'la', 'distractor_rate')).toBe(0.5);
    expect(metric(rs, 'la', 'stale_answer')).toBe(1);
  });

  it('scores a complete list: every gold item and no distractor, other extras let pass', async () => {
    const t: Task = {
      id: 'born', suite: 'usage', type: 'ambiguous', question: 'In which year was Michael Jordan born?', scoring: 'set', evidence: [],
      items: [{ label: '1963', aliases: [], weight: 1 }, { label: '1956', aliases: [], weight: 1 }],
      list: { match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'complete' }, meta: { distractors: ['1998', '195'] },
    };
    const json = (labels: string[]) => `{"items":[${labels.map((l) => `{"label":"${l}","confidence":0.9,"evidence":[]}`).join(',')}]}`;
    const cases = [
      ['the basketball player: February 17, 1963', 'the scientist: 1956'], // both, in sentences
      ['1963', '1956', 'one source gives no year'], // an extra that names no wrong answer
      ['1963', '1956', '1998'], // a wrong answer beside them
      ['1963 (one source says 1998)', '1956'], // a wrong answer inside a right entry
      ['1963'], // one reading missing
      ['1963, 1956'], // both in one entry
    ];
    const rs = await scoreLists({ answers: cases.map((c, i) => answer('born', json(c), i ? { repeat: i } : {})), tasks: new Map([['p|born', t]]), corpusDocs: new Map() }, noJudge);
    expect(cases.map((_, i) => metric(rs, 'born', 'correctness', i || undefined))).toEqual([1, 1, 0, 0, 0, 1]);
    expect(metric(rs, 'born', 'distractor_rate', 2)).toBeCloseTo(1 / 3, 5);
    // a gold name that holds a distractor's ("195" in no year here; "New York" in "New York City") is not the distractor
    expect(namesDistractor('New York City', [{ label: 'New York City', aliases: [], weight: 1 }], ['New York'])).toBe(false);
    expect(namesDistractor('New York City, not New York', [{ label: 'New York City', aliases: [], weight: 1 }], ['New York'])).toBe(true);
    // and a distractor that holds the gold's name is still one
    expect(namesDistractor('New York City', [{ label: 'New York', aliases: [], weight: 1 }], ['New York City'])).toBe(true);
  });

  it('scores entity resolution as B-cubed against the gold alias clusters', () => {
    const gold = [
      { canonical: '陈伟 (平台组)', aliases: ['陈伟'], context: ['平台组'] },
      { canonical: '陈伟 (支付组)', aliases: ['陈伟'], context: ['支付组'] },
      { canonical: 'Atlas', aliases: ['Atlas', 'Orion'] },
    ];
    const perfect = entityResolution(gold, [
      { id: 'a', title: '陈伟（平台组）', text: '平台组的后端工程师' },
      { id: 'b', title: '陈伟（支付组）', text: '支付组' },
      { id: 'c', title: 'Orion', text: 'aliases: Atlas' },
    ])!;
    expect(perfect.precision).toBe(1);
    expect(perfect.recall).toBe(1);
    const merged = entityResolution(gold, [{ id: 'a', title: '陈伟', text: '平台组和支付组' }, { id: 'c', title: 'Atlas', text: '' }, { id: 'd', title: 'Orion', text: '' }])!;
    expect(merged.precision).toBeLessThan(1);
    expect(merged.recall).toBeLessThan(1);
    expect(merged.merged).toBe(1);
    expect(merged.split).toBe(1);
  });

  it('prints the minimum detectable effect beside paired deltas, cost per correct answer, and run-to-run variance', () => {
    expect(minimumDetectableEffect(Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1)))).toBeCloseTo(2.8016 * 1.005 / 10, 2);
    const dir = path.join(tmp, 'run');
    const store = new RunStore(dir);
    const at = new Date().toISOString();
    const put = (system: string, taskId: string, value: number, repeat?: number, type: Task['type'] = 'stale') => {
      const a = { ...answer(taskId, 'x', repeat ? { repeat } : {}), system, key: recordKey('answer', system, taskId, repeat ?? 0) };
      store.putAnswer(a);
      store.putScore({ key: scoreKey(a, 'correctness'), pack: 'p', system, suite: 'usage', taskId, taskType: type, metric: 'correctness', value, at, ...(repeat ? { repeat } : {}) });
      store.putScore({ key: scoreKey(a, 'stale_answer'), pack: 'p', system, suite: 'usage', taskId, taskType: type, metric: 'stale_answer', value: value ? 0 : 1, at, ...(repeat ? { repeat } : {}) });
    };
    for (let i = 0; i < 12; i++) {
      put('agent-grep', `t${i}`, i % 3 ? 1 : 0);
      put('agent-knode', `t${i}`, i % 4 ? 1 : 0);
      put('agent-knode', `t${i}`, i % 2 ? 1 : 0, 1);
    }
    const d = buildReportData(dir);
    expect(d.pooled[0].mde).toBeGreaterThan(0);
    expect(d.paired!.p[0].system).toBe('agent-knode');
    expect(d.variance!.p['agent-knode'].repeats).toBe(2);
    expect(d.variance!.p['agent-grep']).toBeUndefined();
    expect(d.costPerCorrect!.p['agent-grep'].tokens).toBeCloseTo(12_000 / 8, 5);
    expect(d.separation!.p['agent-grep'].stale_answer.value).toBeCloseTo(4 / 12, 5);
    expect(d.typesByPack!.p.stale['agent-knode'].n).toBe(12);
    const md = renderReport(d);
    expect(md).toContain('MDE');
    expect(md).toContain('### Run-to-run variance');
    expect(md).toContain('### Separation');
    expect(md).toContain('### Correctness by task type');
  });
});
