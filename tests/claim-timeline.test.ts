import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { foldTimeline, SERIES_MIN_READINGS, TimelineRow } from '../src/graph/claim-timeline.js';
import { sync } from '../src/ingest/sync.js';
import { enumerateClaims } from '../src/search/enumerate.js';
import { claimQueryFromArgs, queryClaims } from '../src/store/claims.js';

/**
 * A subject's timeline from `knode_claims`: each change once, in date order,
 * undated restatements placed by their source's date, superseded values in,
 * short-name twins and a team's parts reachable, truncation said.
 */

let n = 0;
function row(over: Partial<TimelineRow> & { on: string | null; statement: string }): TimelineRow {
  n += 1;
  return { id: `c${n}`, subject_id: 's', object_id: null, type: 'other', attribute: null, value_num: null, value_text: null, unit: null, ...over };
}

describe('foldTimeline', () => {
  it('folds a status restated in other words into one entry and keeps the change that closes it', () => {
    const rows = [
      row({ on: '2025-03-03', type: 'risk', statement: 'Ava Rivera raised R-115.', attribute: 'status', value_text: 'logged' }),
      row({ on: '2025-03-17', type: 'risk', statement: 'R-115 is not closed.', attribute: 'status', value_text: 'not closed' }),
      row({ on: '2025-03-24', type: 'risk', statement: 'R-115 remains open.', attribute: 'status', value_text: 'open' }),
      row({ on: '2025-04-14', type: 'risk', statement: 'R-115 is in progress.', attribute: 'status', value_text: 'in progress' }),
      row({ on: '2025-07-04', type: 'risk', statement: 'R-115 was retired: replaced.', attribute: 'status', value_text: 'retired' }),
    ];
    const entries = foldTimeline(rows);
    expect(entries.map((e) => [e.kind, e.head.on, e.members.length])).toEqual([
      ['single', '2025-03-03', 1],
      ['repeat', '2025-03-17', 3],
      ['single', '2025-07-04', 1],
    ]);
  });

  it('keeps each change of a value as its own entry: 9 → 8 → 9 people is three', () => {
    const people = (on: string, v: number) => row({ on, statement: `headcount ${v}`, attribute: 'headcount', value_num: v, unit: '人' });
    const entries = foldTimeline([people('2024-01-01', 9), people('2024-01-08', 9), people('2024-01-15', 8), people('2024-01-22', 9)]);
    expect(entries.map((e) => [e.head.on, e.head.value_num, e.members.length])).toEqual([['2024-01-01', 9, 2], ['2024-01-15', 8, 1], ['2024-01-22', 9, 1]]);
  });

  it('makes a measurement series one entry with every change of value, at its first reading', () => {
    const progress = Array.from({ length: SERIES_MIN_READINGS + 2 }, (_, i) =>
      row({ on: `2024-07-${String(i + 1).padStart(2, '0')}`, statement: `${i * 10}% complete`, attribute: 'progress', value_num: i * 10, unit: '%' }));
    const launch = row({ on: '2024-07-05', type: 'event', statement: 'Launched.' });
    const entries = foldTimeline([...progress.slice(0, 5), launch, ...progress.slice(5)]);
    expect(entries.map((e) => e.kind)).toEqual(['series', 'single']);
    expect(entries[0].changes.map((c) => c.value_num)).toEqual(progress.map((p) => p.value_num));
    expect(entries[0].members).toHaveLength(progress.length);
  });

  it('folds a statement repeated without an attribute, and keeps the attribute of another object apart', () => {
    const entries = foldTimeline([
      row({ on: '2024-01-05', statement: 'Acceptance criteria were agreed.' }),
      row({ on: '2024-02-05', statement: 'acceptance criteria were agreed' }),
      row({ on: '2024-03-05', statement: 'Holds 51% of A.', attribute: 'holding', value_num: 51, object_id: 'a' }),
      row({ on: '2024-03-05', statement: 'Holds 51% of B.', attribute: 'holding', value_num: 51, object_id: 'b' }),
    ]);
    expect(entries.map((e) => [e.kind, e.head.on, e.members.length])).toEqual([['repeat', '2024-01-05', 2], ['single', '2024-03-05', 1], ['single', '2024-03-05', 1]]);
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-timeline-'));
let ctx: AppContext;

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function weekly(date: string, claims: string[], extra = ''): string {
  return `---\ntitle: 杭州平台组周报 ${date}\ndate: ${date}\n${extra}claims:\n${claims.map((c) => `  - ${c}`).join('\n')}\n---\n周报 ${date}\n`;
}

beforeAll(async () => {
  const dataDir = path.join(tmp, 'ws');
  write(dataDir, 'raw/docs/weekly/2024-03-04.md', weekly('2024-03-04', [
    '{ subject: R-9, object: 王芳, type: risk, statement: 王芳提出风险R-9, eventDate: "2024-03-04" }',
    '{ subject: R-9, type: risk, statement: R-9状态为未关闭 }',
    '{ subject: 赵明, object: 杭州平台组, type: event, statement: 赵明入职杭州平台组, eventDate: "2024-03-04" }',
    '{ subject: INC-1, type: event, statement: INC-1支付回调丢失, eventDate: "2024-03-04" }',
  ], 'entities:\n  - { name: 订单库连接池上限, type: other, aliases: ["连接池上限"] }\n  - { name: 杭州平台组, type: organization }\nrelations:\n  - { source: 赵明, target: 杭州平台组, type: member_of }\n  - { source: 极光项目, target: 杭州平台组, type: part_of }\n'));
  write(dataDir, 'raw/docs/weekly/2024-03-11.md', weekly('2024-03-11', [
    '{ subject: R-9, type: risk, statement: R-9状态为进行中 }',
    '{ subject: 极光项目, type: event, statement: 极光项目启动, eventDate: "2024-03-11" }',
    '{ subject: 订单库连接池上限, type: other, statement: 订单库连接池上限改为200个连接, eventDate: "2024-03-11" }',
  ]));
  write(dataDir, 'raw/docs/weekly/2024-03-18.md', weekly('2024-03-18', [
    '{ subject: R-9, type: risk, statement: R-9状态为未关闭 }',
    '{ subject: 孟军, object: 杭州平台组, type: event, statement: 孟军离开杭州平台组, eventDate: "2024-03-18" }',
    '{ subject: 池上限短名, type: other, statement: 池上限短名改为240个连接, eventDate: "2024-03-18" }',
    '{ subject: INC-1, type: event, statement: INC-1复盘完成, eventDate: "2024-03-18" }',
    '{ subject: INC-2, type: event, statement: INC-2数据库连接耗尽, eventDate: "2024-03-18" }',
  ]));
  write(dataDir, 'raw/docs/weekly/2024-03-25.md', weekly('2024-03-25', [
    '{ subject: R-9, type: risk, statement: R-9状态为已关闭, eventDate: "2024-03-25" }',
  ]));
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
  // a report's short name extracted as an entity of its own, which the full name's aliases list
  // (what the evaluation builds hold for "the pool cap" next to "order DB connection pool cap")
  // of the full name's type, as the evaluation builds hold them (27 of 28 twins there share their type)
  await ctx.store.query(`UPDATE entities SET name = '连接池上限', type = 'other' WHERE name = '池上限短名'`);
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('knode_claims timelines', () => {
  it('places undated restatements by their source date, folds them, and keeps superseded values in', async () => {
    const r = await queryClaims(ctx.store, claimQueryFromArgs({ subject: 'R-9', order: 'timeline' }));
    // the two identical "still open" lines are one claim with two sources (claim identity), the reworded one another
    expect(r.matched).toBe(4);
    const dates = r.claims.map((c) => c.date);
    expect(dates).toEqual([...dates].sort());
    // raised, the open state restated three times, closed — the closing last, not before the undated rows
    expect(r.claims.map((c) => c.statement)).toEqual(expect.arrayContaining(['王芳提出风险R-9', 'R-9状态为已关闭']));
    expect(r.claims[r.claims.length - 1].statement).toBe('R-9状态为已关闭');
    const open = r.claims.find((c) => c.repeats)!;
    expect(open).toMatchObject({ date: '2024-03-04', dateBasis: 'document', repeats: { count: 2, dates: ['2024-03-04', '2024-03-11'] } });
    expect(open.sources).toEqual(['raw/docs/weekly/2024-03-04.md', 'raw/docs/weekly/2024-03-11.md', 'raw/docs/weekly/2024-03-18.md']);
    expect(r.entries).toBe(3);
    expect(r.truncated).toBe(false);
    // every row on request
    expect((await queryClaims(ctx.store, claimQueryFromArgs({ subject: 'R-9', order: 'timeline', fold: false }))).claims).toHaveLength(4);
  });

  it('filters an event range on the claim date, not only on event time', async () => {
    const r = await queryClaims(ctx.store, claimQueryFromArgs({ subject: 'R-9', order: 'timeline', event_range: '2024-03-10..2024-03-20', fold: false }));
    // the merged "still open" claim is dated by its first source (03-04), so only the reworded reading is in the window
    expect(r.claims.map((c) => [c.statement, c.date])).toEqual([['R-9状态为进行中', '2024-03-11']]);
  });

  it('says when the limit cut a timeline and where to pick it up', async () => {
    const r = await queryClaims(ctx.store, claimQueryFromArgs({ subject: 'R-9', order: 'timeline', limit: 2 }));
    expect(r.truncated).toBe(true);
    expect(r.claims).toHaveLength(2);
    expect(r.note).toContain('event_range');
  });

  it("reaches a short-name twin that the full name's aliases list", async () => {
    const r = await queryClaims(ctx.store, claimQueryFromArgs({ subject: '订单库连接池上限', order: 'timeline' }));
    expect(r.claims.map((c) => c.statement)).toEqual(['订单库连接池上限改为200个连接', '池上限短名改为240个连接']);
  });

  it('takes a twin only of the same type and only from an entity the reference names exactly', async () => {
    // another type: a nickname in a company's aliases that is also the name of a concept is not the company
    await ctx.store.query(`UPDATE entities SET type = 'concept' WHERE id = '池上限短名'`);
    try {
      const r = await queryClaims(ctx.store, claimQueryFromArgs({ subject: '订单库连接池上限', order: 'timeline' }));
      expect(r.claims.map((c) => c.statement)).toEqual(['订单库连接池上限改为200个连接']);
    } finally {
      await ctx.store.query(`UPDATE entities SET type = 'other' WHERE id = '池上限短名'`);
    }
    // a loose match (the reference is a substring of the name) is still found, but nothing hops from it
    const loose = await queryClaims(ctx.store, claimQueryFromArgs({ subject: '订单库连接池', order: 'timeline' }));
    expect(loose.claims.map((c) => c.statement)).toEqual(['订单库连接池上限改为200个连接']);
  });

  it('marks the follow-ups of older subjects in a window read without first_mention', async () => {
    const r = await queryClaims(ctx.store, claimQueryFromArgs({ text: 'INC-', event_range: '2024-03-10..2024-03-31' }));
    expect(r.claims.map((c) => [c.subject, c.followUp ?? false]).sort()).toEqual([['INC-1', true], ['INC-2', false]]);
    expect(r.applied.some((a) => a.includes('1 of the 2 subjects listed were first dated before it'))).toBe(true);
    // nothing older: no mark and no note
    const all = await queryClaims(ctx.store, claimQueryFromArgs({ text: 'INC-', event_range: '2024-03-01..2024-03-31' }));
    expect(all.claims.some((c) => c.followUp)).toBe(false);
    expect(all.applied.some((a) => a.startsWith('window:'))).toBe(false);
  });

  it('adds what happened to a team through its members, parts and objects with related', async () => {
    const own = await queryClaims(ctx.store, claimQueryFromArgs({ subject: '杭州平台组', order: 'timeline' }));
    expect(own.claims).toHaveLength(0);
    const r = await queryClaims(ctx.store, claimQueryFromArgs({ subject: '杭州平台组', order: 'timeline', related: true }));
    expect(r.claims.map((c) => c.statement)).toEqual(['赵明入职杭州平台组', '极光项目启动', '孟军离开杭州平台组']);
  });

  it('counts the subjects first dated in a window with first_mention, not an older one followed up there', async () => {
    const window = { text: 'INC-', event_range: '2024-03-10..2024-03-31' };
    expect((await queryClaims(ctx.store, claimQueryFromArgs(window))).claims.map((c) => c.subject).sort()).toEqual(['INC-1', 'INC-2']);
    const first = await queryClaims(ctx.store, claimQueryFromArgs({ ...window, first_mention: true }));
    expect(first.claims.map((c) => [c.subject, c.statement])).toEqual([['INC-2', 'INC-2数据库连接耗尽']]);
    const all = await queryClaims(ctx.store, claimQueryFromArgs({ text: 'INC-', first_mention: true, order: 'timeline' }));
    expect(all.claims.map((c) => [c.subject, c.date])).toEqual([['INC-1', '2024-03-04'], ['INC-2', '2024-03-18']]);
  });

  it('folds an enumeration for Ask on request, keeping its counts over every claim', async () => {
    const [r9] = await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE name = 'R-9'`);
    const query = { entities: [r9.id], includeSuperseded: true, order: 'timeline' as const };
    const plain = await enumerateClaims(ctx.store, query);
    const folded = await enumerateClaims(ctx.store, { ...query, fold: true });
    expect(plain.claims).toHaveLength(4);
    expect(folded.claims).toHaveLength(3);
    expect(folded.matched).toBe(plain.matched);
    expect(folded.claims.find((c) => c.repeats)?.repeats?.count).toBe(2);
  });
});
