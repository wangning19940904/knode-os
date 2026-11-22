import { seededKey } from '../pack.js';
import type { GoldItem, ListSpec, Task } from '../types.js';
import { CORPUS_TASK_MIN_DOCS, STRUCTURED_MIN_DOCS } from '../types.js';
import type { V3Doc } from './reports-v3-render.js';
import {
  CITY_DESC, corpusQuarters, customerNameAt, dayOf, fmtMetric, iso, KINDS, Lang, leadOf, metricActual, metricReported, MONTHS_EN, ownerAt, progressAt,
  projectNameAt, quarterName, rosterOf, settingAt, V3_CORPUS, V3Customer, V3Division, V3Incident, V3Person, V3Project, V3Setting, weekForms, weekName, weeksOfQuarter, weeksUpTo,
} from './reports-v3.js';
import { cnNum, crossLingualOf, Draft, enOrdinal, exactSetSpec, lexicalOverlap, paraphraseOf } from './separation.js';

/**
 * The question families of docs/design/33 §3 over recipe v3's script, gold
 * from the script and evidence from the keyed lines of the rendered documents
 * (no model):
 *
 * - aggregate      counts, sums, rankings and filters over every team and a period
 * - current-state  a setting or a weekly figure as of a date, under corrections and the PMO's precedence
 * - alias          an entity asked by its old name, its nickname, its code or its role
 * - hop            chains of three to seven documents whose question shares no word with the steps' lines
 * - timeline       ordered histories, and what changed between two weeks
 * - lookalike      namesakes and near-identical customers; questions the corpus cannot answer
 * - update         the latest state after each batch
 * - controls       exact lookup, paraphrase, cross-lingual
 *
 * Every question names its team as the documents do (or names none), states
 * the conventions its gold depends on, and names exact ids only where the
 * family needs them.
 */

export interface V3TaskCtx {
  lang: Lang;
  /** The division the questions are about (or two divisions merged, for the hops across them). */
  s: V3Division;
  idx: Map<string, { doc: string; text: string }[]>;
  docs: Map<string, V3Doc>;
  pathOf: (docId: string) => string;
  teamName: (id: string) => string;
}

export const V3_FAMILY_MIN: Record<string, number> = { aggregate: 60, 'current-state': 60, alias: 60, hop: 60, timeline: 60, lookalike: 60, update: 60, 'control-exact': 20, 'control-paraphrase': 20, 'control-xl': 20 };
export const V3_STRATUM_MIN: Record<string, number> = { h5: 20, h6: 20, h7: 20 };

const CONV_STATE: Record<Lang, string> = {
  zh: '（以全部材料为准：后来更正过的，以更正后的为准。）',
  en: ' (Take every document into account: a later correction means the earlier figure was wrong.)',
};
/** Where the PMO's correction decides the gold, the question says that the PMO summary prevails (as the summaries themselves say). */
const CONV_PMO: Record<Lang, string> = {
  zh: '（以全部材料为准：后来更正过的，以更正后的为准；项目管理办公室月报与周报不一致时以月报为准。）',
  en: ' (Take every document into account: a later correction means the earlier figure was wrong, and the PMO monthly summary prevails over a weekly report.)',
};
const CONV_PERIOD: Record<Lang, string> = {
  zh: '（周报按其周一的日期计入月份、季度和年份。）',
  en: " (A weekly report counts in the month, quarter and year of its Monday.)",
};

export function v3Tasks(c: V3TaskCtx, opts: { hops?: 'own' | 'cross' } = {}): Draft[] {
  if (opts.hops === 'cross') return hopTasks(c, true);
  return [
    ...aggregateTasks(c), ...stateTasks(c), ...aliasTasks(c), ...hopTasks(c, false), ...timelineTasks(c), ...lookalikeTasks(c), ...updateTasks(c),
  ].flatMap((t) => t).concat(controlTasks(c, [...stateTasks(c), ...aggregateTasks(c)]));
}

/* ------------------------------------------ helpers ------------------------------------------ */

function helpers(c: V3TaskCtx) {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const docsOf = (key: string) => (c.idx.get(key) ?? []).map((x) => x.doc);
  const linesOf = (key: string) => (c.idx.get(key) ?? []).map((x) => x.text);
  const first = (key: string) => docsOf(key)[0];
  const ev = (ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => Boolean(x)))].map((id) => ({ doc: c.pathOf(id) }));
  const paths = (ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => Boolean(x)).map(c.pathOf))];
  const team = (id: string) => s.teams.find((t) => t.id === id)!;
  const weekly = (teamId: string, w: number) => `w|${teamId}|${w}`;
  const three = zh ? `${s.teams[0].name}、${s.teams[1].name}和${s.teams[2].name}` : `${s.teams[0].name}, ${s.teams[1].name} and ${s.teams[2].name}`;
  const weekRange = (ws: number[]) => s.teams.flatMap((t) => ws.filter((w) => w <= V3_CORPUS).map((w) => weekly(t.id, w)));
  const dateName = (w: number, d = 4) => {
    const x = dayOf(w, d);
    return zh ? `${x.getUTCFullYear()}年${x.getUTCMonth() + 1}月${x.getUTCDate()}日` : `${MONTHS_EN[x.getUTCMonth() + 1]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`;
  };
  const yearOf = (w: number) => dayOf(w).getUTCFullYear();
  const pick = <T>(xs: T[], key: string): T => xs[parseInt(seededKey(s.index, key).slice(0, 8), 16) % xs.length];
  return { lang, s, zh, docsOf, linesOf, first, ev, paths, team, weekly, three, weekRange, dateName, yearOf, pick };
}

const spec = (x: Partial<ListSpec>): ListSpec => ({ match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1', ...x });

/* ------------------------------------------ aggregate ------------------------------------------ */

function aggregateTasks(c: V3TaskCtx): Draft[] {
  const h = helpers(c);
  const { lang, s, zh, three } = h;
  const out: Draft[] = [];
  const P = CONV_PERIOD[lang];
  const add = (id: string, question: string, gold: Partial<Task>, evidence: string[], goldDocs: string[], extra: Record<string, unknown> = {}) => {
    if (new Set(evidence).size < STRUCTURED_MIN_DOCS) return;
    out.push({ id, suite: 'usage', type: 'structured', lang, question, scoring: 'count', ...gold, evidence: h.ev(evidence), meta: { family: 'aggregate', goldDocs: h.paths(goldDocs), ...extra } } as Draft);
  };
  const incDoc = (i: V3Incident) => h.first(`inc:${i.id}`);
  for (const qk of corpusQuarters()) {
    const ws = weeksOfQuarter(qk);
    const [y, q] = [Number(qk.slice(0, 4)), Number(qk.slice(-1))];
    const qn = quarterName(lang, y, q);
    const all = s.incidents.filter((i) => ws.includes(i.week));
    // the weekly reports, and the quarter's reviews, which restate its counts in other words
    const docs = [...h.weekRange(ws), ...s.teams.map((t) => `qr|${t.id}|${qk}`).filter((d) => c.docs.has(d))];
    add(`ag-inc-${qk}`, zh ? `${qn}，${three}一共报告了多少起事故？${P}` : `How many incidents did ${three} report in ${qn} in all?${P}`, { answer: String(all.length) }, docs, all.map(incDoc), { aggregate: 'count', period: qk });
    const p1 = all.filter((i) => i.sev === 'P1');
    add(`ag-p1-${qk}`, zh ? `${qn}，${three}一共出过几起P1事故？${P}` : `How many P1 incidents did ${three} have in ${qn}?${P}`, { answer: String(p1.length) }, docs, p1.map(incDoc), { aggregate: 'count', period: qk });
    const esc = all.filter((i) => i.customer);
    add(`ag-esc-${qk}`, zh ? `${qn}，${three}由客户升级的事故有几起？${P}` : `In ${qn}, how many incidents of ${three} were escalated by a customer?${P}`, { answer: String(esc.length) }, docs, esc.map(incDoc), { aggregate: 'count', period: qk });
    const per = s.teams.map((t) => ({ t, n: all.filter((i) => i.team === t.id).length })).sort((a, b) => b.n - a.n);
    if (per[0].n > per[1].n) {
      add(`ag-top-${qk}`, zh ? `${qn}，${three}中哪个组报告的事故最多？给出组名和起数。${P}` : `In ${qn}, which of ${three} reported the most incidents, and how many?${P}`,
        { scoring: 'set', items: [{ label: zh ? `${per[0].t.name}：${per[0].n}起` : `${per[0].t.name}: ${per[0].n}`, aliases: [], weight: 1, fields: [[per[0].t.name], [String(per[0].n)]] }], list: exactSetSpec(1) }, docs, all.filter((i) => i.team === per[0].t.id).map(incDoc), { aggregate: 'argmax', period: qk });
    }
    const p1By = s.teams.map((t) => ({ t, n: p1.filter((i) => i.team === t.id).length }));
    const atLeast = p1By.filter((x) => x.n >= 1);
    if (atLeast.length && atLeast.length < 3) {
      add(`ag-filter-${qk}`, zh ? `${qn}，${three}中有哪些组出过P1事故？各几起？${P}` : `In ${qn}, which of ${three} had any P1 incident, and how many each?${P}`,
        { scoring: 'set', items: atLeast.map((x) => ({ label: `${x.t.name}: ${x.n}`, aliases: [], weight: 1, fields: [[x.t.name], [String(x.n)]] })), list: exactSetSpec(atLeast.length) }, docs, p1.map(incDoc), { aggregate: 'filter', period: qk });
    } else if (atLeast.length === 3) {
      const two = p1By.filter((x) => x.n >= 2);
      if (two.length && two.length < 3) {
        add(`ag-filter-${qk}`, zh ? `${qn}，${three}中有哪些组出过两起或以上P1事故？各几起？${P}` : `In ${qn}, which of ${three} had two or more P1 incidents, and how many each?${P}`,
          { scoring: 'set', items: two.map((x) => ({ label: `${x.t.name}: ${x.n}`, aliases: [], weight: 1, fields: [[x.t.name], [String(x.n)]] })), list: exactSetSpec(two.length) }, docs, p1.map(incDoc), { aggregate: 'filter', period: qk });
      }
    }
    const lastW = ws.filter((x) => x <= V3_CORPUS).at(-1)!;
    const heads = s.teams.reduce((a, t) => a + rosterOf(s.people, t.id, lastW).length, 0);
    const month = `${dayOf(lastW).getUTCFullYear()}-${String(dayOf(lastW).getUTCMonth() + 1).padStart(2, '0')}`;
    add(`ag-heads-${qk}`, zh ? `${qn}末（该季度最后一份周报那周），${three}在岗人数合计多少？${P}` : `At the end of ${qn} (the week of the quarter's last weekly report), how many people were on ${three} in total?${P}`,
      { answer: String(heads) }, [...s.teams.map((t) => h.first(`pmo:head:${t.id}:${month}`)), ...docs].filter(Boolean) as string[], s.teams.map((t) => h.weekly(t.id, lastW)), { aggregate: 'sum', period: qk });
    const pm = p1.filter((i) => h.first(`pm:${i.id}:minutes`));
    if (pm.length === p1.length && pm.length) {
      const sum = pm.reduce((a, i) => a + i.minutes!, 0);
      add(`ag-minutes-${qk}`, zh ? `${qn}，${three}所有P1事故的影响时长加起来是多少分钟？${P}` : `In ${qn}, what was the total duration of impact, in minutes, of all P1 incidents of ${three}?${P}`,
        { scoring: 'value', answer: String(sum), answers: [zh ? `${sum}分钟` : `${sum} minutes`] }, [...pm.map((i) => h.first(`pm:${i.id}:minutes`)), ...docs], pm.map((i) => h.first(`pm:${i.id}:minutes`)), { aggregate: 'sum', period: qk });
    }
  }
  for (const y of [2024, 2025]) {
    const ws = weeksUpTo(V3_CORPUS).filter((w) => h.yearOf(w) === y);
    const docs = h.weekRange(ws);
    const hired = s.people.filter((p) => p.joined > 1 && ws.includes(p.joined) && s.teams.some((t) => t.id === p.team));
    add(`ag-hired-${y}`, zh ? `${y}年，${three}一共新招了几个人？${P}` : `How many people did ${three} hire in ${y}?${P}`, { answer: String(hired.length) }, docs, hired.map((p) => h.first(`join:${p.id}`)), { aggregate: 'count', period: String(y) });
    const left = s.people.filter((p) => p.left && ws.includes(p.left));
    add(`ag-left-${y}`, zh ? `${y}年有哪些人从${three}离职？${P}` : `Who left ${three} in ${y}?${P}`,
      { scoring: 'set', items: left.map((p) => ({ label: p.name, aliases: [], weight: 1, docs: h.paths([h.first(`left:${p.id}`)]) })), list: spec({ maxItems: Math.max(10, left.length + 5) }) }, docs, left.map((p) => h.first(`left:${p.id}`)), { aggregate: 'list', period: String(y) });
    const moved = s.people.filter((p) => p.move && ws.includes(p.move.week));
    if (moved.length) add(`ag-moved-${y}`, zh ? `${y}年，${three}之间有哪些人调动？调动前后各在哪个组？${P}` : `Who moved between ${three} in ${y}, and from which team to which?${P}`,
      { scoring: 'set', items: moved.map((p) => ({ label: `${p.name}: ${c.teamName(p.team)} → ${c.teamName(p.move!.team)}`, aliases: [], weight: 1, fields: [[p.name], [c.teamName(p.move!.team)]] })), list: exactSetSpec(moved.length) }, docs, moved.map((p) => h.first(`out:${p.id}`)), { aggregate: 'list', period: String(y) });
    const p1 = s.incidents.filter((i) => i.sev === 'P1' && ws.includes(i.week) && h.first(`pm:${i.id}:minutes`));
    if (p1.length) {
      const sum = p1.reduce((a, i) => a + i.minutes!, 0);
      const pmDocs = p1.map((i) => h.first(`pm:${i.id}:minutes`));
      add(`ag-minutes-${y}`, zh ? `${y}年，${three}有复盘报告的P1事故影响时长合计多少分钟？${P}` : `In ${y}, what was the total duration of impact, in minutes, of the P1 incidents of ${three} that have a postmortem?${P}`,
        { scoring: 'value', answer: String(sum), answers: [zh ? `${sum}分钟` : `${sum} minutes`] }, [...pmDocs, ...docs], pmDocs, { aggregate: 'sum', period: String(y) });
      const longest = [...p1].sort((a, b) => b.minutes! - a.minutes!);
      if (longest[0].minutes! > longest[1]?.minutes!) {
        add(`ag-longest-${y}`, zh ? `${y}年，${three}影响时长最长的那起P1事故持续了多少分钟？${P}` : `In ${y}, how many minutes did the longest-lasting P1 incident of ${three} last?${P}`,
          { scoring: 'value', answer: String(longest[0].minutes), answers: [zh ? `${longest[0].minutes}分钟` : `${longest[0].minutes} minutes`], meta: undefined }, [...pmDocs, ...docs], [h.first(`pm:${longest[0].id}:minutes`)], { aggregate: 'max', period: String(y), stale: [String(longest[1].minutes)] });
      }
    }
    const fixes = new Map<string, V3Incident[]>();
    for (const i of s.incidents.filter((x) => ws.includes(x.week + 1))) (fixes.get(i.fixer) ?? fixes.set(i.fixer, []).get(i.fixer)!).push(i);
    const ranked = [...fixes].filter(([name]) => !s.twins.includes(name)).sort((a, b) => b[1].length - a[1].length);
    if (ranked.length > 1 && ranked[0][1].length > ranked[1][1].length) {
      add(`ag-topfixer-${y}`, zh ? `${y}年，在${three}修复事故最多的是谁？修了几起？${P}` : `Who fixed the most incidents across ${three} in ${y}, and how many?${P}`,
        { scoring: 'set', items: [{ label: `${ranked[0][0]}: ${ranked[0][1].length}`, aliases: [], weight: 1, fields: [[ranked[0][0]], [String(ranked[0][1].length)]] }], list: exactSetSpec(1) }, docs, ranked[0][1].map((i) => h.first(`fix:${i.id}`)), { aggregate: 'argmax', period: String(y) });
    }
    const esc = new Map<string, V3Incident[]>();
    for (const i of s.incidents.filter((x) => x.customer && ws.includes(x.week))) (esc.get(i.customer!) ?? esc.set(i.customer!, []).get(i.customer!)!).push(i);
    const many = [...esc].filter(([, is]) => is.length >= 2);
    if (many.length) {
      const name = (id: string) => customerNameAt(s.customers.find((x) => x.id === id)!, V3_CORPUS);
      add(`ag-custs-${y}`, zh ? `${y}年，哪些客户在${three}投诉升级过两次或以上？各几次？（客户用现在的名字）${P}` : `In ${y}, which customers escalated incidents to ${three} two or more times, and how many times each? (Use each customer's current name.)${P}`,
        { scoring: 'set', items: many.map(([id, is]) => ({ label: `${name(id)}: ${is.length}`, aliases: [], weight: 1, fields: [[name(id), s.customers.find((x) => x.id === id)!.name], [String(is.length)]] })), list: exactSetSpec(many.length) }, docs, many.flatMap(([, is]) => is.map(incDoc)), { aggregate: 'group', period: String(y) });
    }
    for (const t of s.teams) {
      // the weekly reports, the PMO's corrections of them and the quarterly reviews' checked tables
      const tw = [...ws.map((w) => h.weekly(t.id, w)), ...s.metricFixes.filter((f) => f.team === t.id && ws.includes(f.week)).map((f) => h.first(`pmo:metric:${t.id}:${f.week}`)), ...ws.map((w) => h.first(`qr:metric:${t.id}:${w}`))].filter(Boolean) as string[];
      const digits = t.metric.unit === '%' ? (t.metric.values[0] > 99 ? 3 : 2) : 0;
      const avg = ws.reduce((a, w) => a + metricActual(s, t.id, w), 0) / ws.length;
      add(`ag-avg-${t.id}-${y}`, zh ? `${t.name}在${y}年各周${t.metric.name}的平均值是多少？以项目管理办公室核对后的数字为准，保留${digits}位小数。${P}` : `What was ${t.name}'s average weekly ${t.metric.name} over ${y}? Use the figures as the PMO checked them, rounded to ${digits} decimals.${P}`,
        { scoring: 'value', answer: avg.toFixed(digits) }, tw, tw, { aggregate: 'mean', period: String(y), tolerance: 1.01 * 10 ** -digits });
    }
  }
  return out;
}

/* ---------------------------------------- current state ---------------------------------------- */

/** What a setting truly was after week `w`: the last value stated by then, put right by any later correction of it. */
export function settingTrueAt(x: V3Setting, w: number, upTo = V3_CORPUS): number | undefined {
  const known = x.history.filter((h) => h.week <= upTo);
  let i = -1;
  known.forEach((h, k) => { if (h.week <= w) i = k; });
  if (i < 0) return undefined;
  let v = known[i].value;
  for (let k = i + 1; k < known.length && known[k].how === 'correction'; k++) v = known[k].value;
  return v;
}

function stateTasks(c: V3TaskCtx): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const out: Draft[] = [];
  for (const x of s.settings) {
    const t = h.team(x.team);
    const val = (v: number) => `${v}${x.unit}`;
    const known = x.history.filter((e) => e.week <= V3_CORPUS);
    const docOfEvent = (k: number) => (known[k].by === 'pmo' ? h.first(`pmo:cfg:${x.id}:${x.history.indexOf(known[k])}`) : h.first(`cfg:${x.id}:${x.history.indexOf(known[k])}`));
    const asOf = known.map((e, k) => {
      const next = known[k + 1]?.week ?? V3_CORPUS + 1;
      return Math.min(V3_CORPUS, e.week + Math.max(1, Math.floor((next - e.week) / 2)));
    });
    asOf.push(V3_CORPUS);
    [...new Set(asOf)].forEach((w, n) => {
      const gold = settingTrueAt(x, w)!;
      const values = [...new Set(known.map((e) => e.value))].filter((v) => v !== gold);
      if (!values.length) return;
      const used = known.map((e, k) => (e.week <= w || e.how === 'correction' ? k : -1)).filter((k) => k >= 0);
      const evidence = used.map(docOfEvent).reverse();
      const date = h.dateName(w, 2);
      const C = used.some((k) => known[k].by === 'pmo') ? CONV_PMO[lang] : CONV_STATE[lang];
      out.push({ id: `st-${x.id}-${n + 1}`, suite: 'usage', type: 'stale', lang, scoring: 'value', asOf: iso(dayOf(w, 2)),
        question: zh ? `截至${date}，${t.name}的${x.name}实际是多少？${C}` : `As of ${date}, what was ${t.name}'s ${x.name} actually?${C}`,
        answer: String(gold), answers: [val(gold)], evidence: h.ev(evidence), meta: { family: 'current-state', stale: values.map(String), staleText: values.map(val), item: x.id, asOfWeek: w, pmo: known.some((e) => e.by === 'pmo' && e.week <= V3_CORPUS) } });
    });
  }
  for (const f of s.metricFixes.filter((x) => x.week <= V3_CORPUS - 4)) {
    const t = h.team(f.team);
    const pmo = h.first(`pmo:metric:${t.id}:${f.week}`);
    if (!pmo) continue;
    out.push({ id: `st-metric-${t.id}-${f.week}`, suite: 'usage', type: 'stale', lang, scoring: 'value',
      question: zh ? `${t.name}${weekName(lang, f.week)}那周的${t.metric.name}是多少？${CONV_PMO.zh}` : `What was ${t.name}'s ${t.metric.name} in ${weekName(lang, f.week)}?${CONV_PMO.en}`,
      answer: String(f.actual), answers: [fmtMetric(lang, t, f.actual)], evidence: h.ev([pmo, h.weekly(t.id, f.week), h.first(`qr:metric:${t.id}:${f.week}`)]),
      meta: { family: 'current-state', stale: [String(f.reported)], staleText: [fmtMetric(lang, t, f.reported)], precedence: 'pmo' } });
  }
  return out;
}

/* -------------------------------------------- alias -------------------------------------------- */

function aliasTasks(c: V3TaskCtx): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const out: Draft[] = [];
  const end = h.dateName(V3_CORPUS);
  const add = (id: string, question: string, gold: Partial<Task>, evidence: (string | undefined)[], extra: Record<string, unknown>) => {
    if (evidence.some((e) => !e)) return;
    out.push({ id, suite: 'usage', type: 'alias', lang, question, scoring: 'value', ...gold, evidence: h.ev(evidence), meta: { family: 'alias', ...extra } } as Draft);
  };
  for (const p of s.projects.filter((x) => x.rename && x.rename.week <= V3_CORPUS)) {
    const old = p.name;
    const rn = h.first(`rename:${p.id}`);
    add(`al-pname-${p.id}`, zh ? `${old}后来改叫什么？` : `What was ${old} renamed to?`, { answer: p.rename!.to }, [rn], { subtype: 'project-rename', old });
    if (p.launch <= V3_CORPUS) add(`al-plaunch-${p.id}`, zh ? `最初叫${old}的项目是哪一周上线的？` : `In which week did the project first called ${old} launch?`, { answer: weekForms(p.launch)[0], answers: weekForms(p.launch) }, [rn, h.first(`launch:${p.id}`)], { subtype: 'project-rename', old, stale: weekForms(p.planned).slice(0, 2) });
    else add(`al-pprog-${p.id}`, zh ? `截至${end}，最初叫${old}的项目完成度是多少？` : `As of ${end}, how far along was the project first called ${old}?`, { answer: `${progressAt(p, V3_CORPUS)}%`, answers: [String(progressAt(p, V3_CORPUS))] }, [rn, h.weekly(p.team, V3_CORPUS)], { subtype: 'project-rename', old });
    const sp = s.customers.find((x) => x.id === p.sponsor)!;
    const sd = h.first(`sponsor:${p.id}`);
    add(`al-psponsor-${p.id}`, zh ? `最初叫${old}的项目，需求方是哪家客户？（给出客户现在用的名字）` : `Which customer requested the project first called ${old}? (Give the customer's current name.)`, { answer: customerNameAt(sp, V3_CORPUS), answers: [sp.name] }, [rn, sd], { subtype: 'project-rename', old });
    const w = Math.min(V3_CORPUS, Math.max(p.rename!.week + 6, p.takeover ? p.takeover.week + 2 : 0));
    if (w < p.launch) add(`al-powner-${p.id}`, zh ? `${h.dateName(w)}时，最初叫${old}的项目由谁负责？` : `On ${h.dateName(w)}, who owned the project first called ${old}?`, { answer: ownerAt(p, w) }, [rn, h.weekly(p.team, w)], { subtype: 'project-rename', old, ...(p.takeover && p.takeover.week <= w ? { stale: [p.owner] } : {}) });
  }
  for (const cu of s.customers.filter((x) => x.rename && x.rename.week <= V3_CORPUS)) {
    const rn = h.first(`crename:${cu.id}`);
    const after = s.incidents.filter((i) => i.customer === cu.id && i.week >= cu.rename!.week && i.week <= V3_CORPUS);
    if (after.length && rn) {
      out.push({ id: `al-cafter-${cu.id}`, suite: 'usage', type: 'alias', lang, scoring: 'set', list: spec({ maxItems: after.length + 5 }),
        question: zh ? `${cu.name}改名以后，又在哪些事故上投诉升级过？列出事故编号。` : `After ${cu.name} changed its name, which incidents did it escalate? Give the incident IDs.`,
        items: after.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: h.paths([h.first(`inc:${i.id}`)]) })), evidence: h.ev([rn, ...after.map((i) => h.first(`inc:${i.id}`))]), meta: { family: 'alias', subtype: 'customer-rename', old: cu.name } });
      add(`al-cfirst-${cu.id}`, zh ? `${cu.name}改名后第一次投诉升级的事故，是哪个组报告的？` : `The first incident ${cu.name} escalated after changing its name: which team reported it?`, { answer: c.teamName(after[0].team) }, [rn, h.first(`inc:${after[0].id}`)], { subtype: 'customer-rename', old: cu.name });
    }
    if (rn) add(`al-cname-${cu.id}`, zh ? `客户${cu.name}后来改叫什么？` : `What name does the customer ${cu.name} go by now?`, { answer: cu.rename!.to }, [rn], { subtype: 'customer-rename', old: cu.name });
  }
  for (const p of s.people.filter((x) => x.nick && x.nick.week <= V3_CORPUS && s.teams.some((t) => t.id === x.team))) {
    const nd = h.first(`nick:${p.id}`);
    if (!nd) continue;
    const k = p.nick!.text;
    const q = (zhq: string, enq: string) => (zh ? zhq.replace('{k}', `“${k}”`) : enq.replace('{k}', `"${k}"`));
    add(`al-nname-${p.id}`, q('被喊作{k}的那位，真名叫什么？', 'Whom does everyone call {k}? Give the real name.'), { answer: p.name }, [nd], { subtype: 'nickname', nick: k });
    const teamNow = p.move && p.move.week <= V3_CORPUS ? p.move.team : p.team;
    if (!(p.left && p.left <= V3_CORPUS)) add(`al-nteam-${p.id}`, q(`截至${end}，{k}在哪个组？`, `As of ${end}, which team is {k} on?`), { answer: c.teamName(teamNow) }, [nd, h.weekly(teamNow, V3_CORPUS)], { subtype: 'nickname', nick: k, ...(teamNow !== p.team ? { stale: [c.teamName(p.team)] } : {}) });
    const fixed = s.incidents.filter((i) => i.fixer === p.name && i.week + 1 <= V3_CORPUS && i.week + 1 >= p.joined);
    if (fixed.length) {
      out.push({ id: `al-nfixed-${p.id}`, suite: 'usage', type: 'alias', lang, scoring: 'set', list: spec({ maxItems: fixed.length + 5 }),
        question: q('{k}修复过哪些事故？列出事故编号。', 'Which incidents has {k} fixed? Give the incident IDs.'),
        items: fixed.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: h.paths([h.first(`fix:${i.id}`)]) })), evidence: h.ev([nd, ...fixed.map((i) => h.first(`fix:${i.id}`))]), meta: { family: 'alias', subtype: 'nickname', nick: k } });
    }
    const owns = s.projects.filter((j) => j.owner === p.name || j.takeover?.to === p.name);
    if (owns.length === 1) {
      const j = owns[0];
      const w = j.takeover?.to === p.name ? j.takeover.week : j.start;
      add(`al-nproj-${p.id}`, q('{k}负责过哪个项目？（给出项目最后用的名字）', 'Which project has {k} owned? (Give the name it ended with.)'), { answer: projectNameAt(j, V3_CORPUS), answers: [j.name] }, [nd, h.first(j.takeover?.to === p.name ? `takeover:${j.id}` : `start:${j.id}`), ...(j.rename && j.rename.week > w && j.rename.week <= V3_CORPUS ? [h.first(`rename:${j.id}`)] : [])], { subtype: 'nickname', nick: k });
    }
  }
  for (const x of s.settings) {
    const t = h.team(x.team);
    add(`al-short-${x.id}`, zh ? `${t.name}周报里说的“${x.short}”，指的是哪项设置？` : `In ${t.name}'s reports, which setting is "${x.short}"?`, { answer: x.name, answers: [x.id] }, [h.first(`cfg:${x.id}:0`)], { subtype: 'setting-alias' });
  }
  for (const t of s.teams) {
    t.leadChanges.forEach((lc, n) => {
      for (const [w, tag] of [[lc.week - 6, 'before'], [Math.min(V3_CORPUS, lc.week + 8), 'after']] as const) {
        const who = leadOf(t, w);
        add(`al-lead-${t.id}-${n}-${tag}`, zh ? `${h.dateName(w)}时，${t.name}的组负责人是谁？` : `On ${h.dateName(w)}, who led ${t.name}?`, { answer: who }, [h.weekly(t.id, w), ...(tag === 'after' ? [h.first(`lead:${t.id}:${n}`)] : [])],
          { subtype: 'role', stale: [tag === 'after' ? leadOf(t, lc.week - 1) : lc.to] });
      }
    });
  }
  return out;
}

/* --------------------------------------------- hops --------------------------------------------- */

type Kind = 'P' | 'I' | 'J' | 'C' | 'R' | 'T';
interface Node { kind: Kind; id: string; known: 'name' | 'nick' | 'old' | 'new' }
interface Step { rel: string; keys: string[]; from?: Node; to?: Node }
interface Chain { anchor: { kind: string; text: Record<Lang, string>; allow: string[]; node: Node }; steps: Step[]; terminal: { rel: string; answer: string; answers: string[] } }

const LABELS: Record<Lang, string[]> = { zh: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'], en: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'] };
const CLAUSE: Record<Lang, Record<string, string>> = {
  zh: {
    fixer: '把{a}收拾好的人记作{b}', actionOwner: '{a}事后领了改进活儿的人记作{b}', escalator: '把{a}闹出来的甲方记作{b}', firstEsc: '{a}头一回闹出来的故障记作{b}',
    tookOver: '{a}换组以后挑起担子的那个项目记作{b}', owned: '{a}起初名下的那个项目记作{b}', sponsor: '{a}的活是哪个甲方给的，那个甲方记作{b}',
    mentor: '{a}刚来时跟着学的师傅记作{b}', mentee: '{a}带过的徒弟记作{b}', replacedBy: '{a}走后顶了其位置的人记作{b}', raisedRisk: '{a}头一个预警的隐患记作{b}', riskOwner: '眼下盯着{a}的人记作{b}',
  },
  en: {
    fixer: 'let {b} be whoever sorted out {a}', actionOwner: 'let {b} be whoever was handed the improvement work after {a}', escalator: 'let {b} be the client that kicked up {a}', firstEsc: 'let {b} be the earliest outage {a} ever kicked up',
    tookOver: 'let {b} be the venture {a} picked up the reins of after changing crews', owned: 'let {b} be the venture {a} originally had on their plate', sponsor: 'let {b} be the client {a} was built for',
    mentor: 'let {b} be the coach who showed {a} the ropes', mentee: 'let {b} be the apprentice {a} coached', replacedBy: "let {b} be whoever stepped into {a}'s shoes", raisedRisk: 'let {b} be the earliest hazard {a} flagged', riskOwner: 'let {b} be whoever is minding {a} now',
  },
};
const TERMINAL: Record<Lang, Record<string, string>> = {
  zh: { launch: '问：{a}是哪一周投产的？', budget: '问：{a}拨到了多少钱？', minutes: '问：{a}一共停摆了多长时间？', nick: '问：{a}的外号是什么？', name: '问：{a}叫什么名字？', team: '问：{a}后来换到了哪个组？', customer: '问：{a}如今叫什么名字？' },
  en: { launch: 'In which week did {a} go live?', budget: 'How much funding did {a} get?', minutes: 'How long was {a} down for?', nick: 'What nickname does {a} go by?', name: "What is {a}'s real name?", team: 'Which crew did {a} end up in?', customer: 'What is {a} called today?' },
};

function hopTasks(c: V3TaskCtx, cross: boolean): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const person = (name: string) => s.people.find((p) => p.name === name && !s.twins.includes(name));
  const personById = (id: string) => s.people.find((p) => p.id === id)!;
  const doc = (key: string) => h.docsOf(key);
  const project = (id: string) => s.projects.find((p) => p.id === id)!;
  const cust = (id: string) => s.customers.find((x) => x.id === id)!;
  const inc = (id: string) => s.incidents.find((x) => x.id === id)!;
  // the name a document uses for a project or customer in the week it is filed
  const docWeek = (docId: string) => c.docs.get(docId)!.week;
  const nickKnown = (p: V3Person, week: number) => Boolean(p.nick && p.nick.week < week && doc(`nick:${p.id}`).length);

  /** Edges out of a node: the relation, the fact keys (each a document), the node reached and how its document names it. */
  const edges = (n: Node): Step[] => {
    const out: Step[] = [];
    if (n.kind === 'I') {
      const i = inc(n.id);
      const f = person(i.fixer);
      if (f && doc(`fix:${i.id}`).length) out.push({ rel: 'fixer', keys: [`fix:${i.id}`, `pm:${i.id}:fixer`], to: { kind: 'P', id: f.id, known: 'name' } });
      const o = i.actionOwner ? person(i.actionOwner) : undefined;
      const pm = doc(`pm:${i.id}:owner`)[0];
      if (o && pm) out.push({ rel: 'actionOwner', keys: [`pm:${i.id}:owner`], to: { kind: 'P', id: o.id, known: nickKnown(o, docWeek(pm)) ? 'nick' : 'name' } });
      if (i.customer && doc(`inc:${i.id}`).length) {
        const cu = cust(i.customer);
        out.push({ rel: 'escalator', keys: [`inc:${i.id}`, `pm:${i.id}:customer`], to: { kind: 'C', id: cu.id, known: cu.rename && i.week >= cu.rename.week ? 'new' : 'old' } });
      }
    }
    if (n.kind === 'C') {
      const cu = cust(n.id);
      const firstI = s.incidents.filter((i) => i.customer === cu.id && i.week <= V3_CORPUS).sort((a, b) => a.week - b.week)[0];
      if (firstI) out.push({ rel: 'firstEsc', keys: [`inc:${firstI.id}`], to: { kind: 'I', id: firstI.id, known: 'name' } });
    }
    if (n.kind === 'P') {
      const p = personById(n.id);
      const took = s.projects.filter((j) => j.takeover?.to === p.name && j.takeover.week <= V3_CORPUS);
      if (took.length === 1) out.push({ rel: 'tookOver', keys: [`takeover:${took[0].id}`], to: { kind: 'J', id: took[0].id, known: took[0].rename && took[0].takeover!.week >= took[0].rename.week ? 'new' : 'old' } });
      const own = s.projects.filter((j) => j.owner === p.name);
      if (own.length === 1 && own[0].start <= V3_CORPUS) out.push({ rel: 'owned', keys: [`start:${own[0].id}`], to: { kind: 'J', id: own[0].id, known: 'old' } });
      if (p.mentor && doc(`mentor:${p.id}`).length) {
        const m = personById(p.mentor);
        out.push({ rel: 'mentor', keys: [`mentor:${p.id}`], to: { kind: 'P', id: m.id, known: nickKnown(m, docWeek(doc(`mentor:${p.id}`)[0])) ? 'nick' : 'name' } });
      }
      const apprentices = s.people.filter((x) => x.mentor === p.id && doc(`mentor:${x.id}`).length);
      if (apprentices.length === 1) out.push({ rel: 'mentee', keys: [`mentor:${apprentices[0].id}`], to: { kind: 'P', id: apprentices[0].id, known: 'name' } });
      const rep = s.people.filter((x) => x.replaces === p.id && doc(`replace:${x.id}`).length);
      if (rep.length === 1) out.push({ rel: 'replacedBy', keys: [`replace:${rep[0].id}`], to: { kind: 'P', id: rep[0].id, known: 'name' } });
      const raised = s.risks.filter((r) => r.raisedBy === p.name && r.opened <= V3_CORPUS).sort((a, b) => a.opened - b.opened);
      if (raised.length && raised[0].handover && raised[0].handover.week <= V3_CORPUS) out.push({ rel: 'raisedRisk', keys: [`risk:${raised[0].id}:new`], to: { kind: 'R', id: raised[0].id, known: 'name' } });
    }
    if (n.kind === 'R') {
      const r = s.risks.find((x) => x.id === n.id)!;
      const o = r.handover && r.handover.week <= V3_CORPUS ? person(r.handover.to) : undefined;
      if (o) out.push({ rel: 'riskOwner', keys: [`risk:${r.id}:owner`], to: { kind: 'P', id: o.id, known: 'name' } });
    }
    if (n.kind === 'J') {
      const j = project(n.id);
      if (doc(`sponsor:${j.id}`).length) {
        const sd = doc(`sponsor:${j.id}`)[0];
        const cu = cust(j.sponsor);
        out.push({ rel: 'sponsor', keys: [`sponsor:${j.id}`], to: { kind: 'C', id: cu.id, known: cu.rename && docWeek(sd) >= cu.rename.week ? 'new' : 'old' } });
      }
    }
    return out;
  };
  /** The steps a node needs before an edge can use it: the document that maps the name the chain knows to the one the edge's document uses. */
  const bridgeTo = (n: Node, key: string): Step[] | null => {
    const d = doc(key)[0];
    if (!d) return null;
    const w = docWeek(d);
    if (n.kind === 'P' && n.known === 'nick') {
      const p = personById(n.id);
      // the edge's line names the person by the nickname too: no bridge
      if (c.idx.get(key)!.some((x) => x.text.includes(p.nick!.text))) return [];
      return doc(`nick:${p.id}`).length ? [{ rel: 'alias', keys: [`nick:${p.id}`] }] : null;
    }
    if (n.kind === 'J') {
      const j = project(n.id);
      const usesNew = Boolean(j.rename && w >= j.rename.week);
      if (j.rename && usesNew !== (n.known === 'new')) return doc(`rename:${j.id}`).length ? [{ rel: 'alias', keys: [`rename:${j.id}`] }] : null;
    }
    if (n.kind === 'C') {
      const cu = cust(n.id);
      const usesNew = Boolean(cu.rename && w >= cu.rename.week);
      if (cu.rename && usesNew !== (n.known === 'new')) return doc(`crename:${cu.id}`).length ? [{ rel: 'alias', keys: [`crename:${cu.id}`] }] : null;
    }
    return [];
  };
  const terminals = (n: Node): { steps: Step[]; rel: string; answer: string; answers: string[] }[] => {
    const out: { steps: Step[]; rel: string; answer: string; answers: string[] }[] = [];
    const with_ = (key: string, rel: string, answer: string, answers: string[]) => {
      const b = bridgeTo(n, key);
      if (b) out.push({ steps: [...b, { rel, keys: [key] }], rel, answer, answers });
    };
    if (n.kind === 'J') {
      const j = project(n.id);
      if (j.launch <= V3_CORPUS && doc(`launch:${j.id}`).length) with_(`launch:${j.id}`, 'launch', weekForms(j.launch)[0], weekForms(j.launch));
      if (j.budget && doc(`budget:${j.id}`).length) with_(`budget:${j.id}`, 'budget', zh ? `${j.budget.amount}万元` : `${j.budget.amount}k`, zh ? [`${j.budget.amount}万`, `${j.budget.amount * 10000}`] : [`${j.budget.amount},000`, `${j.budget.amount * 1000}`]);
    }
    if (n.kind === 'I') {
      const i = inc(n.id);
      if (i.minutes && doc(`pm:${i.id}:minutes`).length) out.push({ steps: [{ rel: 'minutes', keys: [`pm:${i.id}:minutes`] }], rel: 'minutes', answer: zh ? `${i.minutes}分钟` : `${i.minutes} minutes`, answers: [String(i.minutes)] });
    }
    if (n.kind === 'P') {
      const p = personById(n.id);
      if (n.known === 'name' && p.nick && doc(`nick:${p.id}`).length) out.push({ steps: [{ rel: 'nick', keys: [`nick:${p.id}`] }], rel: 'nick', answer: p.nick.text, answers: [] });
      const b = n.known === 'nick' ? (doc(`nick:${p.id}`).length ? [{ rel: 'alias', keys: [`nick:${p.id}`] }] : null) : [];
      if (b) out.push({ steps: b, rel: 'name', answer: p.name, answers: [] });
      if (p.move && p.move.week <= V3_CORPUS && doc(`out:${p.id}`).length) with_(`out:${p.id}`, 'team', c.teamName(p.move.team), []);
    }
    if (n.kind === 'C') {
      const cu = cust(n.id);
      const b = cu.rename && n.known === 'old' && cu.rename.week <= V3_CORPUS ? (doc(`crename:${cu.id}`).length ? [{ rel: 'alias', keys: [`crename:${cu.id}`] }] : null) : [];
      if (b) out.push({ steps: b, rel: 'customer', answer: customerNameAt(cu, V3_CORPUS), answers: [] });
    }
    return out;
  };

  // anchors: an incident or a customer described in words no document uses, a nickname, an old name
  const anchors: Chain['anchor'][] = [];
  const divs = [...new Set(s.teams.map((t) => t.div))];
  const descOf = (div: number) => CITY_DESC[lang][div];
  for (const t of s.teams) {
    const desc = descOf(t.div);
    if (!desc) continue;
    for (const y of [2024, 2025, 2026]) {
      const p1s = s.incidents.filter((i) => i.team === t.id && i.sev === 'P1' && dayOf(i.week).getUTCFullYear() === y && i.week <= V3_CORPUS).sort((a, b) => a.week - b.week);
      p1s.forEach((i, k) => {
        if (!h.docsOf(`inc:${i.id}`).length) return;
        const ord = zh ? String(k + 1) : enOrdinal(k + 1);
        anchors.push({ kind: 'described-incident', node: { kind: 'I', id: i.id, known: 'name' }, allow: [],
          text: { zh: `${desc}办公的那几个组里，${KINDS.zh[t.kind].desc}在${y}年出的第${ord}起最严重一档的故障记作{a}`, en: `let {a} be the ${ord} top-severity outage of ${y} in ${KINDS.en[t.kind].desc} at the office ${desc}` } as Record<Lang, string> });
      });
    }
  }
  for (const div of divs) {
    const desc = descOf(div);
    if (!desc) continue;
    const mine = s.customers.filter((cu) => cu.id.startsWith(`D${div + 1}C`));
    for (const cu of mine) {
      if (mine.filter((x) => x.industry === cu.industry).length !== 1) continue;
      const ind = cu.industry;
      anchors.push({ kind: 'described-customer', node: { kind: 'C', id: cu.id, known: cu.rename ? 'old' : 'old' }, allow: [],
        text: { zh: `${desc}办公的那几个组的甲方里，${industryDescZh(ind)}那一家记作{a}`, en: `let {a} be ${industryDescEn(ind)} among the clients of the office ${desc}` } as Record<Lang, string> });
    }
  }
  for (const p of s.people.filter((x) => x.nick && h.docsOf(`nick:${x.id}`).length && !s.twins.includes(x.name))) {
    anchors.push({ kind: 'nickname', node: { kind: 'P', id: p.id, known: 'nick' }, allow: [p.nick!.text], text: { zh: `外号叫“${p.nick!.text}”的那位记作{a}`, en: `let {a} be the person nicknamed "${p.nick!.text}"` } as Record<Lang, string> });
  }
  for (const j of s.projects.filter((x) => x.rename && x.rename.week <= V3_CORPUS)) {
    anchors.push({ kind: 'old-name', node: { kind: 'J', id: j.id, known: 'old' }, allow: [j.name], text: { zh: `最初叫${j.name}的那个项目记作{a}`, en: `let {a} be the venture first named ${j.name}` } as Record<Lang, string> });
  }
  // the anchors' own document: the described incident's report, the nickname's statement
  const anchorSteps = (a: Chain['anchor']): Step[] => (a.kind === 'described-incident' ? [{ rel: 'anchor', keys: [`inc:${a.node.id}`] }] : a.kind === 'nickname' ? [{ rel: 'anchor', keys: [`nick:${a.node.id}`] }] : []);

  // every chain up to seven documents
  const chains: Chain[] = [];
  const walk = (a: Chain['anchor'], n: Node, steps: Step[], seen: Set<string>) => {
    const docCount = steps.length;
    for (const t of terminals(n)) {
      if (docCount + t.steps.length >= 3 && docCount + t.steps.length <= 7) chains.push({ anchor: a, steps: [...steps, ...t.steps], terminal: { rel: t.rel, answer: t.answer, answers: t.answers } });
    }
    if (docCount >= 6) return;
    for (const e of edges(n)) {
      if (seen.has(`${e.to!.kind}:${e.to!.id}`)) continue;
      const b = bridgeTo(n, e.keys[0]);
      if (!b) continue;
      const next = [...steps, ...b, { ...e, from: n }];
      if (next.length > 6) continue;
      walk(a, e.to!, next, new Set([...seen, `${e.to!.kind}:${e.to!.id}`]));
    }
  };
  for (const a of anchors) walk(a, a.node, anchorSteps(a), new Set([`${a.node.kind}:${a.node.id}`]));

  // keep a chain when every step needs a document of its own and its question shares no word with any step's line
  const out: Draft[] = [];
  const seenQ = new Set<string>();
  const byLen = new Map<number, Draft[]>();
  for (const ch of chains) {
    const stepDocs = ch.steps.map((st) => new Set(st.keys.flatMap((k) => h.docsOf(k))));
    if (stepDocs.some((x) => !x.size)) continue;
    // no document states two steps: a reader cannot skip one
    let shared = false;
    for (let i = 0; i < stepDocs.length && !shared; i++) for (let j = i + 1; j < stepDocs.length && !shared; j++) for (const d of stepDocs[i]) if (stepDocs[j].has(d)) shared = true;
    if (shared) continue;
    const crosses = new Set(ch.steps.flatMap((st) => st.keys.flatMap((k) => h.docsOf(k).map((d) => c.docs.get(d)!.div)))).size > 1;
    if (cross !== crosses) continue;
    const labels = LABELS[lang];
    let li = 0;
    const clauses: string[] = [];
    for (const st of ch.steps) {
      if (st.rel === 'anchor' || st.rel === 'alias' || !CLAUSE[lang][st.rel]) continue;
      clauses.push(CLAUSE[lang][st.rel].replace('{a}', labels[li]).replace('{b}', labels[li + 1]));
      li++;
    }
    const anchor = ch.anchor.text[lang].replace('{a}', labels[0]);
    const term = TERMINAL[lang][ch.terminal.rel].replace('{a}', labels[li]);
    const question = zh ? `${[anchor, ...clauses].join('；')}。${term}只回答这一问。` : `${[anchor, ...clauses].map((x, i) => (i === 0 ? x[0].toUpperCase() + x.slice(1) : x)).join('; ')}. ${term} Answer only that.`;
    const lines = ch.steps.flatMap((st) => st.keys.flatMap((k) => h.linesOf(k)));
    const overlap = lexicalOverlap(lang, question, lines, ch.anchor.allow);
    if (overlap.length) continue;
    const bridges = ch.steps.filter((st) => st.to).map((st) => bridgeName(st.to!));
    if (bridges.some((b) => b && question.includes(b))) continue;
    // the answer is in no line of the anchor's own document
    const hops = ch.steps.length;
    const id = `hop-${hops}-${seededKey('hop', question).slice(0, 10)}`;
    if (seenQ.has(question)) continue;
    seenQ.add(question);
    const evidence = ch.steps.map((st) => h.docsOf(st.keys[0])[0]);
    const d: Draft = { id, suite: 'usage', type: 'deep-hop', lang, question, scoring: 'value', answer: ch.terminal.answer, ...(ch.terminal.answers.length ? { answers: ch.terminal.answers } : {}),
      evidence: h.ev(evidence), meta: { family: 'hop', hops, stratum: `h${hops}`, bridges, chain: ch.steps.map((st) => st.rel), anchor: ch.anchor.kind, ...(cross ? { scope: 'cross-division' } : {}) } };
    (byLen.get(hops) ?? byLen.set(hops, []).get(hops)!).push(d);
  }
  function bridgeName(n: Node): string {
    if (n.kind === 'P') return personById(n.id).name;
    if (n.kind === 'J') return project(n.id).name;
    if (n.kind === 'C') return cust(n.id).name;
    return n.id;
  }
  // a stratified, seeded choice: the quotas per length, no two chains of one length from the same anchor and terminal
  const quota: Record<number, number> = cross ? { 3: 2, 4: 4, 5: 6, 6: 6, 7: 6 } : { 3: 10, 4: 14, 5: 24, 6: 24, 7: 24 };
  for (const [len, list] of [...byLen].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => seededKey(s.index, a.id).localeCompare(seededKey(s.index, b.id)));
    const used = new Map<string, number>();
    const picked: Draft[] = [];
    for (const d of sorted) {
      const k = `${d.meta!.anchor}|${(d.meta!.bridges as string[])[0] ?? ''}|${d.answer}`;
      if ((used.get(k) ?? 0) >= 1) continue;
      used.set(k, (used.get(k) ?? 0) + 1);
      picked.push(d);
      if (picked.length >= (quota[len] ?? 0)) break;
    }
    out.push(...picked);
  }
  return out;
}

const industryDescZh = (i: number) => ['开连锁超市的', '办培训班的', '送快递的', '做网约车的', '卖保单的', '放贷款的', '卖药的', '拍短视频的'][i];
const industryDescEn = (i: number) => ['the supermarket chain', 'the tutoring company', 'the parcel courier', 'the ride-hailing firm', 'the underwriter', 'the lender', 'the drug maker', 'the video studio'][i];

/* ------------------------------------------- timelines ------------------------------------------- */

function timelineTasks(c: V3TaskCtx): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const out: Draft[] = [];
  const end = h.dateName(V3_CORPUS);
  const push = (id: string, question: string, items: GoldItem[], docs: (string | undefined)[], match: ListSpec['match'], extra: Record<string, unknown>) => {
    const ds = [...new Set(docs.filter(Boolean))] as string[];
    if (ds.length < CORPUS_TASK_MIN_DOCS || items.length < 2 || items.some((it) => !it.docs?.length)) return;
    out.push({ id, suite: 'usage', type: 'timeline', lang, question, scoring: 'set', items, list: spec({ match, ordered: true, maxItems: Math.max(10, items.length + 5) }), evidence: h.ev(ds), meta: { family: 'timeline', ...extra } });
  };
  const item = (label: string, w: number, key: string, aliases: string[] = []): GoldItem => ({ label, aliases, weight: 1, date: iso(dayOf(w)), docs: h.paths([h.first(key)]) });
  for (const p of s.projects.filter((x) => x.start <= V3_CORPUS - 6)) {
    const items: GoldItem[] = [item(zh ? `${weekName(lang, p.start)}启动，负责人${p.owner}` : `started in ${weekName(lang, p.start)}, owner ${p.owner}`, p.start, `start:${p.id}`, [p.owner])];
    if (p.rename && p.rename.week <= V3_CORPUS) items.push(item(zh ? `${weekName(lang, p.rename.week)}改名为${p.rename.to}` : `renamed ${p.rename.to} in ${weekName(lang, p.rename.week)}`, p.rename.week, `rename:${p.id}`, [p.rename.to]));
    if (p.takeover && p.takeover.week <= V3_CORPUS) items.push(item(zh ? `${weekName(lang, p.takeover.week)}由${p.takeover.to}接手` : `${p.takeover.to} took over in ${weekName(lang, p.takeover.week)}`, p.takeover.week, `takeover:${p.id}`, [p.takeover.to]));
    if (p.launch > p.planned && p.planned + 1 <= V3_CORPUS) items.push({ ...item(zh ? `${weekName(lang, p.planned + 1)}起报告延期` : `reported late from ${weekName(lang, p.planned + 1)}`, p.planned + 1, `prog:${p.id}:${p.planned + 1}`, zh ? ['延期'] : ['late']) });
    if (p.launch <= V3_CORPUS) items.push(item(zh ? `${weekName(lang, p.launch)}上线` : `launched in ${weekName(lang, p.launch)}`, p.launch, `launch:${p.id}`, weekForms(p.launch).slice(0, 2)));
    items.sort((a, b) => a.date!.localeCompare(b.date!));
    const span = weeksUpTo(V3_CORPUS).filter((w) => w >= p.start && w <= Math.min(p.launch, V3_CORPUS)).filter((_, i) => i % 4 === 0).map((w) => h.weekly(p.team, w));
    push(`tl-proj-${p.id}`, zh ? `${p.name}项目从启动到${end}为止，经历了哪些节点？按时间先后列出。` : `What milestones did the ${p.name} project go through from its start up to ${end}? List them in order.`, items, [...items.flatMap((it) => it.docs!.map(() => undefined)), ...span, ...items.map((it) => idOfPath(c, it.docs![0]))], 'judge', { subject: 'project' });
  }
  for (const r of s.risks.filter((x) => x.closed && x.closed <= V3_CORPUS)) {
    const items = [
      item(zh ? `${weekName(lang, r.opened)}由${r.raisedBy}提出` : `raised by ${r.raisedBy} in ${weekName(lang, r.opened)}`, r.opened, `risk:${r.id}:new`, [r.raisedBy]),
      ...(r.handover ? [item(zh ? `${weekName(lang, r.handover.week)}负责人改为${r.handover.to}` : `handed to ${r.handover.to} in ${weekName(lang, r.handover.week)}`, r.handover.week, `risk:${r.id}:owner`, [r.handover.to])] : []),
      item(zh ? `${weekName(lang, r.closed!)}关闭：${r.resolution}` : `closed in ${weekName(lang, r.closed!)}: ${r.resolution}`, r.closed!, `risk:${r.id}:closed`, [r.resolution]),
    ];
    const span = weeksUpTo(V3_CORPUS).filter((w) => w >= r.opened && w <= r.closed!).map((w) => h.weekly(r.team, w));
    push(`tl-risk-${r.id}`, zh ? `风险${r.id}从提出到关闭经历了什么？按时间列出每一步（谁、哪一周）。` : `What happened to risk ${r.id} from first mention to closing? List each step in order (who, which week).`, items, span, 'alias', { subject: 'risk' });
  }
  for (const x of s.settings) {
    const t = h.team(x.team);
    const known = x.history.filter((e) => e.week <= V3_CORPUS);
    const items = known.map((e, k) => item(zh ? `${weekName(lang, e.week)}：${e.value}${x.unit}${e.how === 'correction' ? '（更正）' : ''}` : `${weekName(lang, e.week)}: ${e.value}${x.unit}${e.how === 'correction' ? ' (correction)' : ''}`, e.week,
      e.by === 'pmo' ? `pmo:cfg:${x.id}:${x.history.indexOf(e)}` : `cfg:${x.id}:${x.history.indexOf(e)}`, [String(e.value)]));
    if (known.length < 3) continue;
    const docs = [...items.map((it) => idOfPath(c, it.docs![0])), ...weeksUpTo(V3_CORPUS).filter((w) => w >= known[0].week && w <= known.at(-1)!.week && w % 9 === 0).map((w) => h.weekly(t.id, w))];
    const pmo = known.some((e) => e.by === 'pmo');
    push(`tl-cfg-${x.id}`, zh ? `${t.name}的${x.name}先后取过哪些值？按时间列出每一次（含更正${pmo ? '，以及项目管理办公室月报里的更正' : ''}）。` : `What values has ${t.name}'s ${x.name} taken, in order? List each one (corrections included${pmo ? ", the PMO summary's too" : ''}).`, items, docs, 'alias', { subject: 'setting' });
  }
  // what changed between two weeks of a team's reports
  for (const t of s.teams) {
    for (let k = 0; k < 15; k++) {
      const w1 = 4 + k * 8 + (t.kind * 2);
      const w2 = w1 + 7 + (k % 3);
      if (w2 > V3_CORPUS) continue;
      const items: GoldItem[] = [];
      const inRange = (w?: number) => w !== undefined && w > w1 && w <= w2;
      for (const p of s.projects.filter((x) => x.team === t.id)) {
        if (inRange(p.start)) items.push(item(zh ? `${projectNameAt(p, p.start)}启动` : `${projectNameAt(p, p.start)} started`, p.start, `start:${p.id}`, [projectNameAt(p, p.start)]));
        if (inRange(p.rename?.week)) items.push(item(zh ? `${p.name}改名为${p.rename!.to}` : `${p.name} renamed ${p.rename!.to}`, p.rename!.week, `rename:${p.id}`, [p.rename!.to]));
        if (inRange(p.takeover?.week)) items.push(item(zh ? `${p.takeover!.to}接手${projectNameAt(p, p.takeover!.week)}` : `${p.takeover!.to} took over ${projectNameAt(p, p.takeover!.week)}`, p.takeover!.week, `takeover:${p.id}`, [p.takeover!.to]));
        if (inRange(p.launch)) items.push(item(zh ? `${projectNameAt(p, p.launch)}上线` : `${projectNameAt(p, p.launch)} launched`, p.launch, `launch:${p.id}`, [projectNameAt(p, p.launch)]));
      }
      for (const p of s.people) {
        if (p.team === t.id && inRange(p.joined) && p.joined > 1) items.push(item(zh ? `${p.name}入职` : `${p.name} joined`, p.joined, `join:${p.id}`, [p.name]));
        if (p.team === t.id && inRange(p.left)) items.push(item(zh ? `${p.name}离职` : `${p.name} left`, p.left!, `left:${p.id}`, [p.name]));
        if (p.team === t.id && inRange(p.move?.week)) items.push(item(zh ? `${p.name}调往${c.teamName(p.move!.team)}` : `${p.name} moved to ${c.teamName(p.move!.team)}`, p.move!.week, `out:${p.id}`, [p.name]));
        if (p.move?.team === t.id && inRange(p.move.week)) items.push(item(zh ? `${p.name}从${c.teamName(p.team)}调入` : `${p.name} came over from ${c.teamName(p.team)}`, p.move.week, `in:${p.id}`, [p.name]));
      }
      for (const x of s.settings.filter((y) => y.team === t.id)) x.history.forEach((e, hi) => {
        if (inRange(e.week) && e.by === 'team' && e.how !== 'intro') items.push(item(zh ? `${x.id}改为${e.value}${x.unit}` : `${x.id} set to ${e.value}${x.unit}`, e.week, `cfg:${x.id}:${hi}`, [String(e.value)]));
      });
      for (const r of s.risks.filter((y) => y.team === t.id)) {
        if (inRange(r.opened)) items.push(item(zh ? `新风险${r.id}` : `new risk ${r.id}`, r.opened, `risk:${r.id}:new`, [r.id]));
        if (inRange(r.closed)) items.push(item(zh ? `${r.id}关闭` : `${r.id} closed`, r.closed!, `risk:${r.id}:closed`, [r.id]));
      }
      if (items.length < 3 || items.length > 12) continue;
      items.sort((a, b) => a.date!.localeCompare(b.date!) || a.label.localeCompare(b.label));
      const docs = weeksUpTo(w2).filter((w) => w >= w1).map((w) => h.weekly(t.id, w));
      push(`tl-diff-${t.id}-${w1}`, zh ? `对比${t.name}${weekName(lang, w1)}和${weekName(lang, w2)}的周报：这期间有哪些变化（项目、人员、设置、风险）？按先后列出。` : `Comparing ${t.name}'s reports for ${weekName(lang, w1)} and ${weekName(lang, w2)}: what changed in between (projects, people, settings, risks)? List the changes in order.`, items, docs, 'judge', { subject: 'diff', from: w1, to: w2 });
    }
  }
  return out;
}

function idOfPath(c: V3TaskCtx, p: string): string | undefined {
  for (const [id] of c.docs) if (c.pathOf(id) === p) return id;
  return undefined;
}

/* ---------------------------------- look-alikes and unanswerables ---------------------------------- */

function lookalikeTasks(c: V3TaskCtx): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const out: Draft[] = [];
  const idSpec = (n: number) => spec({ maxItems: Math.max(10, n + 5) });
  for (const twin of s.twins) {
    const pair = s.people.filter((p) => p.name === twin);
    if (pair.length !== 2) continue;
    const mention = (p: V3Person) => weeksUpTo(V3_CORPUS).map((w) => h.weekly(p.team, w)).find((d) => c.docs.get(d)!.text.includes(p.name));
    if (pair.every(mention)) out.push({ id: `la-twins-${s.twins.indexOf(twin) + 1}`, suite: 'usage', type: 'lookalike', lang, scoring: 'set', list: idSpec(2),
      question: zh ? `${twin}在哪个组？` : `Which team is ${twin} on?`, items: pair.map((p) => ({ label: c.teamName(p.team), aliases: [], weight: 1, docs: h.paths([mention(p)]) })), evidence: h.ev(pair.map(mention)), meta: { family: 'lookalike', subtype: 'namesake', readings: 2 } });
    for (const p of pair) {
      const other = pair.find((x) => x !== p)!;
      const mine = [...s.incidents.filter((i) => i.fixer === p.name && i.team === p.team && i.week + 1 <= V3_CORPUS).map((i) => ({ id: i.id, doc: h.first(`fix:${i.id}`) })),
        ...s.risks.filter((r) => r.raisedBy === p.name && r.team === p.team && r.opened <= V3_CORPUS).map((r) => ({ id: r.id, doc: h.first(`risk:${r.id}:new`) }))];
      const theirs = [...s.incidents.filter((i) => i.fixer === other.name && i.team === other.team).map((i) => i.id), ...s.risks.filter((r) => r.raisedBy === other.name && r.team === other.team).map((r) => r.id)];
      if (!mine.length) continue;
      out.push({ id: `la-twin-${p.id}`, suite: 'usage', type: 'lookalike', lang, scoring: 'set', list: idSpec(mine.length),
        question: zh ? `${c.teamName(p.team)}的那位${p.name}（不是另一个组的同名者）修复过哪些事故、提出过哪些风险？列出编号。` : `Which incidents did ${p.name} of ${c.teamName(p.team)} (not the namesake on another team) fix, and which risks did they raise? Give the IDs.`,
        items: mine.map((m) => ({ label: m.id, aliases: [], weight: 1, docs: h.paths([m.doc]) })), evidence: h.ev(mine.map((m) => m.doc)), meta: { family: 'lookalike', subtype: 'namesake', distractors: theirs } });
    }
  }
  for (const cu of s.customers.filter((x) => x.lookalikeOf || s.customers.some((y) => y.lookalikeOf === x.id))) {
    const twin = s.customers.find((y) => y.lookalikeOf === cu.id || y.id === cu.lookalikeOf)!;
    const mine = s.incidents.filter((i) => i.customer === cu.id && i.week <= V3_CORPUS);
    if (!mine.length) continue;
    out.push({ id: `la-cust-${cu.id}`, suite: 'usage', type: 'lookalike', lang, scoring: 'set', list: idSpec(mine.length),
      question: zh ? `客户${cu.name}投诉升级过哪些事故？列出事故编号。` : `Which incidents did ${cu.name} escalate? Give the incident IDs.`,
      items: mine.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: h.paths([h.first(`inc:${i.id}`)]) })), evidence: h.ev(mine.map((i) => h.first(`inc:${i.id}`))),
      meta: { family: 'lookalike', subtype: 'near-name', lookalike: twin.name, distractors: s.incidents.filter((i) => i.customer === twin.id).map((i) => i.id) } });
  }
  // unanswerable: what no document states, asked as if one did
  const un = (id: string, question: string, subtype: string) => out.push({ id, suite: 'usage', type: 'unanswerable', lang, question, scoring: 'abstain', evidence: [], meta: { family: 'lookalike', subtype: `unanswerable-${subtype}` } });
  const rich = s.people.filter((p) => !s.twins.includes(p.name) && s.teams.some((t) => t.id === p.team) && p.joined === 1 && !p.left).slice(0, 15);
  const qs = corpusQuarters();
  rich.forEach((p, n) => {
    const qk = qs[(n * 2 + 1) % qs.length];
    const [y, q] = [Number(qk.slice(0, 4)), Number(qk.slice(-1))];
    un(`un-okr-${p.id}`, zh ? `${p.name}个人在${quarterName(lang, y, q)}的OKR得分是多少？` : `What was ${p.name}'s personal OKR score in ${quarterName(lang, y, q)}?`, 'personal-okr');
  });
  s.twins.forEach((twin, n) => {
    const teams = s.people.filter((p) => p.name === twin).map((p) => p.team);
    const third = s.teams.find((t) => !teams.includes(t.id));
    if (third) un(`un-twin-${n + 1}`, zh ? `${third.name}的${twin}修复过哪些事故？` : `Which incidents did ${twin} of ${third.name} fix?`, 'namesake');
  });
  for (const t of s.teams) for (const y of [2024, 2025]) {
    const n = s.incidents.filter((i) => i.team === t.id && i.sev === 'P1' && dayOf(i.week).getUTCFullYear() === y).length;
    un(`un-ord-${t.id}-${y}`, zh ? `${t.name}在${y}年的第${cnNum(n + 1)}起P1事故是谁修复的？${CONV_PERIOD.zh}` : `Who fixed ${t.name}'s ${enOrdinal(n + 1)} P1 incident of ${y}?${CONV_PERIOD.en}`, 'false-premise');
  }
  for (const t of s.teams) for (const k of [0, 1, 2].filter((x) => x !== t.kind)) {
    const x = s.settings.find((y) => y.kind === k)!;
    un(`un-cfg-${t.id}-${k}`, zh ? `${t.name}的${x.name}是多少？` : `What is ${t.name}'s ${x.name}?`, 'other-team-setting');
  }
  for (const t of s.teams) {
    s.incidents.filter((i) => i.team === t.id && i.sev === 'P2' && i.week <= V3_CORPUS).filter((_, k) => k % 2 === 0).slice(0, 4).forEach((i) => {
      un(`un-p2-${i.id}`, zh ? `${t.name}${weekName(lang, i.week)}那起${i.title}（P2）影响时长是多少分钟？` : `How many minutes did ${t.name}'s ${i.title} (P2) in ${weekName(lang, i.week)} last?`, 'no-postmortem');
    });
  }
  for (const p of s.projects.filter((x) => !x.budget && x.start <= V3_CORPUS)) un(`un-budget-${p.id}`, zh ? `给${projectNameAt(p, V3_CORPUS)}批了多少预算？` : `What budget was approved for ${projectNameAt(p, V3_CORPUS)}?`, 'no-budget');
  for (const cu of s.customers.filter((x) => x.lookalikeOf).slice(0, 2)) {
    const fake = zh ? cu.name.slice(0, 2) + (cu.name.endsWith('零售') ? '物流' : '零售') : cu.name.split(' ')[0] + (cu.name.endsWith('Retail') ? ' Logistics' : ' Retail');
    if (!s.customers.some((x) => x.name === fake)) un(`un-cust-${cu.id}`, zh ? `客户${fake}投诉升级过哪些事故？` : `Which incidents did ${fake} escalate?`, 'no-such-customer');
  }
  return out;
}

/* --------------------------------------------- update --------------------------------------------- */

function updateTasks(c: V3TaskCtx): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const out: Draft[] = [];
  for (let b = 1; b <= 4; b++) {
    const w = V3_CORPUS + b;
    const batch = String(b).padStart(2, '0');
    const base = (id: string, question: string, answer: string, answers: string[], doc: string, stale: string[], extra: Record<string, unknown> = {}) =>
      out.push({ id: `upd-${id}-${batch}`, suite: 'update', type: 'update', lang, afterUpdate: batch, scoring: 'value', question, answer, answers, evidence: [{ doc: c.pathOf(doc) }], meta: { family: 'update', ...(stale.length ? { stale } : {}), ...extra } });
    for (const t of s.teams) {
      const v = metricReported(s, t.id, w);
      const prev = metricReported(s, t.id, w - 1);
      // the stale value with its unit too ("1839k"), so an answer at full size ("1,839,000") reads as stale
      base(`metric-${t.id}`, zh ? `${t.name}最新一周周报里的${t.metric.name}是多少？` : `What ${t.metric.name} does ${t.name}'s latest weekly report give?`, String(v), [fmtMetric(lang, t, v)], h.weekly(t.id, w), prev !== v ? [String(prev)] : [], prev !== v ? { staleText: [fmtMetric(lang, t, prev)] } : {});
      const head = rosterOf(s.people, t.id, w).length;
      const before = rosterOf(s.people, t.id, w - 1).length;
      base(`head-${t.id}`, zh ? `${t.name}现在在岗多少人？` : `How many people are on ${t.name} now?`, String(head), [zh ? `${head}人` : `${head} people`], h.weekly(t.id, w), before !== head ? [String(before)] : []);
      const x = s.settings.find((y) => y.team === t.id && y.history.some((e) => e.week > V3_CORPUS))!;
      const now = settingTrueAt(x, w, w)!;
      const was = settingAt(x, V3_CORPUS)!;
      const last = x.history.filter((e) => e.week <= w).at(-1)!;
      base(`cfg-${x.id}`, zh ? `${t.name}的${x.name}现在是多少？` : `What is ${t.name}'s ${x.name} now?`, String(now), [`${now}${x.unit}`], h.weekly(t.id, last.week), [...new Set(x.history.filter((e) => e.week <= w).map((e) => e.value))].filter((v) => v !== now).map(String), { was });
      const open = (x: number) => s.risks.filter((r) => r.team === t.id && r.opened <= x && !(r.closed && r.closed <= x)).length;
      base(`risks-${t.id}`, zh ? `按${t.name}最新一周的周报，还有几个风险没有关闭？` : `By ${t.name}'s latest weekly report, how many risks are still open?`, String(open(w)), [zh ? `${open(w)}个` : `${open(w)} risks`], h.weekly(t.id, w), open(w - 1) !== open(w) ? [String(open(w - 1))] : []);
      const latest = s.incidents.filter((i) => i.team === t.id && i.week <= w).sort((a, b) => b.week - a.week);
      base(`lastinc-${t.id}`, zh ? `${t.name}最新报告的那起事故是哪一起？给出编号。` : `Which is the newest incident ${t.name} has reported? Give its ID.`, latest[0].id, [], h.weekly(t.id, latest[0].week), latest[1] ? [latest[1].id] : []);
      const active = s.projects.filter((p) => p.team === t.id && p.start <= w && p.launch >= w).slice(0, 2);
      for (const p of active) {
        const n = progressAt(p, w);
        base(`prog-${p.id}`, zh ? `${projectNameAt(p, w)}现在的完成度是多少？` : `How far along is ${projectNameAt(p, w)} now?`, n === 100 ? (zh ? '已上线' : 'launched') : `${n}%`, n === 100 ? ['100%'] : [String(n)], h.weekly(t.id, w), [`${progressAt(p, w - 1)}%`].filter((x2) => x2 !== `${n}%`));
      }
    }
  }
  return out;
}

/* -------------------------------------------- controls -------------------------------------------- */

function controlTasks(c: V3TaskCtx, bases: Draft[]): Draft[] {
  const h = helpers(c);
  const { lang, s, zh } = h;
  const other: Lang = zh ? 'en' : 'zh';
  const out: Draft[] = [];
  const incs = s.incidents.filter((i) => i.week <= V3_CORPUS).filter((_, k) => k % 3 === 1).slice(0, 24);
  for (const i of incs) {
    out.push({ id: `cx-${i.id}`, suite: 'usage', type: 'single-hop', lang, scoring: 'value', question: zh ? `事故${i.id}是哪个组报告的？` : `Which team reported incident ${i.id}?`, answer: c.teamName(i.team), evidence: h.ev([h.first(`inc:${i.id}`)]), meta: { family: 'control-exact' } });
  }
  const pick = bases.filter((b) => b.type === 'stale' || b.scoring === 'count').filter((_, k) => k % 3 === 0).slice(0, 24);
  for (const b of pick) {
    const q = zh ? `请根据材料回答：${b.question.replace(/^截至/, '到').replace('一共', '总共').replace('实际是多少', '实际定在多少')}` : `From the documents: ${b.question.replace(/^As of/, 'At').replace('in all', 'altogether').replace('actually?', 'in practice?')}`;
    if (q === b.question) continue;
    const d = paraphraseOf(b, q);
    out.push({ ...d, meta: { ...d.meta, family: 'control-paraphrase' } });
  }
  for (const i of incs) {
    const base = out.find((x) => x.id === `cx-${i.id}`)!;
    const t = h.team(i.team);
    const d = crossLingualOf(base, other === 'en' ? `Which team reported incident ${i.id}?` : `事故${i.id}是哪个组报告的？`, other);
    out.push({ ...d, answers: [t.alt], meta: { ...d.meta, family: 'control-xl' } });
  }
  return out;
}

export type { V3Customer, V3Project };
