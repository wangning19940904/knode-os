import { attributeHead, sameValue } from './claim-state.js';

/**
 * A subject's chronology from its claims, each event once.
 *
 * Weekly and monthly reports restate a subject's state in every issue: a risk
 * "still open" fourteen weeks running, a project's progress every Friday, the
 * owner in each report. Listed row by row, those readings bury the few changes
 * a timeline is asked for — the start, the rename, the new owner, the first
 * week late, the launch — and an agent that reads them lists every restatement
 * as a step. Folding keeps every reading and source but shows the subject's
 * changes as entries:
 *
 * - readings of one attribute (and object) that give the same value fold into
 *   the first of the run, which carries how often and on which dates it was
 *   restated; a changed value starts a new entry, so 9 → 8 → 9 people is
 *   three entries
 * - a measurement series — many readings, the value changing at most of them
 *   (progress, a weekly metric) — is one entry at its first reading, with
 *   every change of value listed as a reading, rather than forty entries
 * - the same statement repeated without an attribute folds the same way
 *
 * Nothing is dropped: an entry's `members` are all the rows it stands for.
 */

export interface TimelineRow {
  id: string;
  subject_id: string;
  object_id: string | null;
  type: string;
  statement: string;
  attribute?: string | null;
  value_num?: number | null;
  value_text?: string | null;
  unit?: string | null;
  /** The date the timeline places the claim at (event time, else validity start, else its source's date); null = undated. */
  on: string | null;
}

export type TimelineEntryKind = 'single' | 'repeat' | 'series';

export interface TimelineEntry<T extends TimelineRow> {
  kind: TimelineEntryKind;
  /** The first row of the entry: the one shown. */
  head: T;
  /** Every row the entry stands for, the head first, in date order. */
  members: T[];
  /** For a series: the first reading of each value, in date order. */
  changes: T[];
}

/** Readings an attribute needs before a run of changing values reads as a series rather than as events. */
export const SERIES_MIN_READINGS = 8;
/** Share of readings that change the value, at or above which an attribute's readings are a series. */
export const SERIES_CHANGE_SHARE = 0.5;

/**
 * Values of a status that say the same thing — still open — in different
 * words; a run of them is one state, not a change at each wording.
 */
const OPEN_STATES = new Set([
  'open', 'opened', 'not closed', 'still open', 'remains open', 'remained open', 'in progress', 'ongoing', 'active', 'pending', 'unresolved', 'not resolved',
  '未关闭', '仍未关闭', '尚未关闭', '进行中', '处理中', '跟进中', '未解决', '开放', '持续中', '仍在处理',
]);

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

function stateOf(r: TimelineRow): string | null {
  if (r.value_text == null) return null;
  const head = attributeHead(r.attribute ?? null);
  if (head !== 'status' && head !== '状态') return null;
  const v = norm(r.value_text);
  return OPEN_STATES.has(v) ? 'open' : null;
}

/** The two rows give the same value of their attribute. */
function sameReading(a: TimelineRow, b: TimelineRow): boolean {
  const sa = stateOf(a);
  if (sa && sa === stateOf(b)) return true;
  const ma = { valueNum: a.value_num ?? null, valueText: a.value_text ?? null, unit: a.unit ?? null };
  const mb = { valueNum: b.value_num ?? null, valueText: b.value_text ?? null, unit: b.unit ?? null };
  if (ma.valueNum === null && ma.valueText === null && mb.valueNum === null && mb.valueText === null) {
    return norm(a.statement) === norm(b.statement);
  }
  return sameValue(ma, mb);
}

function groupKey(r: TimelineRow, acrossSubjects: boolean): string {
  const attr = r.attribute ? attributeHead(r.attribute) : null;
  return attr
    ? `a\u0000${acrossSubjects ? '' : r.subject_id}\u0000${norm(attr)}\u0000${r.object_id ?? ''}`
    : `s\u0000${r.subject_id}\u0000${r.type}\u0000${norm(r.statement)}`;
}

/**
 * Fold rows already in timeline order into entries, in the order of their
 * first rows. `acrossSubjects`: the rows' subjects are one thing under several
 * entities — a project before and after its rename, a short name extracted
 * apart — so one attribute of theirs is one series. `series: false` keeps each
 * change of a measurement series an entry of its own (only restatements fold).
 */
export function foldTimeline<T extends TimelineRow>(rows: T[], opts: { acrossSubjects?: boolean; series?: boolean } = {}): TimelineEntry<T>[] {
  const position = new Map<T, number>();
  rows.forEach((r, i) => position.set(r, i));
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = groupKey(r, opts.acrossSubjects ?? false);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const entries: TimelineEntry<T>[] = [];
  for (const [key, members] of groups) {
    if (!key.startsWith('a\u0000')) {
      entries.push({ kind: members.length > 1 ? 'repeat' : 'single', head: members[0], members, changes: [] });
      continue;
    }
    const runs: T[][] = [];
    for (const r of members) {
      const run = runs[runs.length - 1];
      if (run && sameReading(run[0], r)) run.push(r);
      else runs.push([r]);
    }
    const numeric = members.filter((r) => r.value_num != null).length * 2 >= members.length;
    if (opts.series !== false && members.length >= SERIES_MIN_READINGS && numeric && runs.length >= members.length * SERIES_CHANGE_SHARE) {
      entries.push({ kind: 'series', head: members[0], members, changes: runs.map((run) => run[0]) });
      continue;
    }
    for (const run of runs) entries.push({ kind: run.length > 1 ? 'repeat' : 'single', head: run[0], members: run, changes: [] });
  }
  return entries.sort((a, b) => position.get(a.head)! - position.get(b.head)!);
}
