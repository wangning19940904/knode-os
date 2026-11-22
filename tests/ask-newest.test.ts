import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { shortNameTwins } from '../src/graph/resolve.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask, passageLabel } from '../src/search/ask.js';
import { factsForQuestion, namedEntities } from '../src/search/facts.js';
import { asksLatest, newestSources, topicTerms } from '../src/search/newest.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * Update questions (docs/design/36 §5, Q3): after a batch of weekly reports
 * changed a value, Ask gave the previous value or declined on 32 of 117, while
 * an agent reading the same index's pages answered them. Replayed without a
 * model on the run's builds, the prompts lacked the answer:
 *
 * - "By Oslo Platform's latest weekly report, how many risks are still open?",
 *   "Which is the newest incident Oslo Platform has reported?" — the newest
 *   report was in none of the 26 prompts: nothing ordered sources by date
 *   (search/newest.ts);
 * - "What is Oslo Growth's daily push cap now?" — the current value was stated
 *   under the setting's short name ("the push quota moves to 6 pushes") and
 *   extracted onto that twin entity, which Ask's named entities did not reach,
 *   and the team's hundreds of claims outranked the setting's few
 *   (search/facts.ts, graph/resolve.ts `shortNameTwins`).
 *
 * The documents below are the run's reports (synthetic-reports-en-v3 and -zh-v3), cut.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-ask-newest-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}
const embedder = new FixtureEmbedder();
let store: Store;

async function addEntity(id: string, name: string, type = 'organization', aliases: string[] = []): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, $4::jsonb, '')`, [id, name, type, JSON.stringify(aliases)]);
  for (const [key, kind] of entityKeyKinds(name, aliases)) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, key, kind]);
  }
}

/** A source document of one chunk per part, dated, mentioning `mentions` in every chunk. */
async function addDoc(id: string, docPath: string, title: string, date: string, parts: string[], mentions: string[]): Promise<void> {
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, kind, doc_date) VALUES ($1, $2, 'docs', $3, $4, 10, 'indexed', 'source', $5)`,
    [id, docPath, title, `sha-${id}`, `${date}T00:00:00Z`]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', now())`, [`s-${id}`, docPath, `sha-${id}`]);
  for (const [seq, content] of parts.entries()) {
    const chunk = `${id}-${seq}`;
    await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, $3, $4, 3, to_tsvector('simple', $4))`, [chunk, id, seq, content]);
    await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [chunk, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
    for (const e of mentions) await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [e, chunk, id]);
  }
}

async function addClaim(id: string, subject: string, statement: string, doc: string, validFrom: string | null = null): Promise<void> {
  await store.query(
    `INSERT INTO claims (id, subject_id, type, statement, status, kind, valid_from, chunk_id, document_id, primary_scope_id, tx_from)
     VALUES ($1, $2, 'fact', $3, 'fact', 'fact', $4, $5, $6, $7, now())`,
    [id, subject, statement, validFrom, `${doc}-0`, doc, `s-${doc}`],
  );
}

const weekly = (week: number, body: string) => `# Oslo Platform weekly report · week ${week} of 2026\n\n${body}`;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addEntity('oslo-platform', 'Oslo Platform');
  // fourteen older weekly reports, each with an incident line and risks "still open"
  for (let w = 5; w <= 18; w++) {
    await addDoc(`w${w}`, `raw/docs/weekly/2026-W${String(w).padStart(2, '0')}/r.md`, `Oslo Platform weekly report · week ${w} of 2026`, new Date(Date.UTC(2026, 0, 30 + 7 * (w - 5))).toISOString().slice(0, 10),
      [weekly(w, `**Metrics**\n- ✅ service availability: 99.97${w % 10}%\n\n**Incidents**\n- ⚠️ INC-11${String(w).padStart(2, '0')} (P2) data lag\n\n**Risks**\n- ⚠️ R-116 still open (owner Ava Rivera)\n- ⚠️ R-117 still open (owner Ivan Rowe)`)], ['oslo-platform']);
  }
  // the monthly minutes: newer than most reports, an incident count, no incident named
  await addDoc('minutes-04', 'raw/docs/minutes/2026-04/m.md', 'Oslo monthly operations meeting · April 2026', '2026-04-30',
    ['# Oslo monthly operations meeting · April 2026\n\nOslo Platform: 0 incidents this month; no launches. Release windows stay on Tuesday and Thursday afternoons.'], ['oslo-platform']);
  // the update batches: a new incident, its fix, then a week with none
  await addDoc('w20', 'raw/docs/weekly/2026-W20/14e1251037.md', 'Oslo Platform weekly report · week 20 of 2026', '2026-05-15',
    [weekly(20, '2026-05-11 ~ 2026-05-15 · Jack Grant\n\n**Metrics**\n- ✅ service availability came in at 99.999%\n\n**Incidents**\n- ⚠️ INC-1125 (P1) cache stampede, raised by Summitport Retail as a complaint\n\n**Risks**\n- ⚠️ R-118 not closed; Noah Chen on it')], ['oslo-platform']);
  await addDoc('w21', 'raw/docs/weekly/2026-W21/2161cec57c.md', 'Oslo Platform weekly report · week 21 of 2026', '2026-05-22',
    [weekly(21, '2026-05-18 ~ 2026-05-22 · Jack Grant\n\n**Metrics**\n- ✅ service availability this week: 99.999%\n\n**Incidents**\n- ⚠️ INC-1125 resolved by Kurt Taylor; root cause: a missed data migration\n\n**Risks**\n- ⚠️ R-118 in progress, owner Noah Chen')], ['oslo-platform']);
  await addDoc('w22', 'raw/docs/weekly/2026-W22/7bda1f7403.md', 'Oslo Platform weekly report · week 22 of 2026', '2026-05-29',
    [weekly(22, '2026-05-25 ~ 2026-05-29 · Jack Grant\n\n**Metrics**\n- ✅ service availability this week: 99.998%\n\n**Risks**\n- ⚠️ R-118 in progress, owner Noah Chen\n\n**People**\n- ✅ headcount 9')], ['oslo-platform']);
  // the postmortem of an older incident: "incident" in its title, newer than most reports, not the team's report
  await addDoc('pm-1124', 'raw/docs/postmortems/2026-04/pm.md', 'Incident postmortem: INC-1124 certificate rotation break', '2026-05-12',
    ['# Incident postmortem: INC-1124 certificate rotation break\n\nTeam: Oslo Platform. The incident was reported in week 14; the cause was a code defect.'], ['oslo-platform']);
  // undated: never "the newest"
  await addDoc('undated', 'raw/docs/notes/platform.md', 'Oslo Platform notes', '2026-01-01', ['Oslo Platform risks and incidents, still open items.'], ['oslo-platform']);
  await store.query(`UPDATE documents SET doc_date = NULL WHERE id = 'undated'`);

  // the zh pack's 杭州平台组: its weekly reports, and monthly minutes whose words cross the question's ("一起事故")
  await addEntity('杭州平台组', '杭州平台组');
  for (const [w, date, body] of [
    [20, '2026-05-15', '**事故**\n- ⚠️ 新增P1事故INC-1125：缓存击穿\n\n**风险**\n- ⚠️ R-118没有关闭（赵强跟进）'],
    [21, '2026-05-22', '**事故**\n- ⚠️ INC-1125已修复（段平）\n\n**风险**\n- ⚠️ R-118仍未关闭，负责人赵强'],
    [22, '2026-05-29', '**指标**\n- ✅ 本周服务可用性为99.999%\n\n**事故**\n- ⚠️ INC-1125已修复（段平），原因：数据迁移遗漏\n\n**风险**\n- ⚠️ R-118跟进中，负责人赵强'],
  ] as [number, string, string][]) {
    await addDoc(`zh${w}`, `raw/docs/周报/2026-W${w}/zh.md`, `杭州平台组周报 · 2026年第${w}周`, date, [`# 杭州平台组周报 · 2026年第${w}周\n\n${body}`], ['杭州平台组']);
  }
  await addDoc('zhpm', 'raw/docs/事故复盘/2026-05/pm.md', '事故复盘报告：INC-1122 数据延迟', '2026-05-20',
    ['# 事故复盘报告：INC-1122 数据延迟\n\n杭州平台组报告的这起事故编号INC-1122，原因是上游数据断流。'], ['杭州平台组']);
  for (let m = 1; m <= 4; m++) {
    await addDoc(`zhm${m}`, `raw/docs/会议纪要/2026-0${m}/m.md`, `杭州经营例会纪要 · 2026年${m}月`, `2026-0${m}-28`,
      [`# 杭州经营例会纪要 · 2026年${m}月\n\n杭州平台组本月共报告一起事故，给出了复盘编号；风险没有关闭的有几个，另行跟进。`], ['杭州平台组']);
  }

  // a setting named by its full name, changed under its short name (en: daily push cap / push quota)
  await addEntity('oslo-growth', 'Oslo Growth');
  await addEntity('daily-push-cap', 'daily push cap', 'other', ['daily push cap', 'GRW1-C1', 'push quota']);
  await addEntity('push-quota', 'push quota', 'other');
  // an alias two other entities go by is no twin; nor is an entity of another type
  await addEntity('gift-cap', 'gift cap', 'other', ['the cap']);
  await addEntity('the-cap-a', 'the cap', 'other');
  await addEntity('the-cap-b', 'The Cap', 'other');
  await addEntity('grw1-c1', 'GRW1-C1', 'component');
  await addDoc('g-2024-w06', 'raw/docs/weekly/2024-W06/g.md', 'Oslo Growth weekly report · week 6 of 2024', '2024-02-09',
    ['new daily push cap: 3 pushes (code GRW1-C1, short name the push quota).'], ['oslo-growth', 'daily-push-cap']);
  await addDoc('g-2026-w04', 'raw/docs/weekly/2026-W04/g.md', 'Oslo Growth weekly report · week 4 of 2026', '2026-01-23',
    ['- ⚠️ the push quota moves to 6 pushes from this week'], ['oslo-growth', 'push-quota']);
  await addDoc('g-2026-w18', 'raw/docs/weekly/2026-W18/g.md', 'Oslo Growth weekly report · week 18 of 2026', '2026-05-01',
    ['- ✅ note: the daily push cap started at 3 pushes'], ['oslo-growth', 'daily-push-cap']);
  await addClaim('cap-new', 'daily-push-cap', 'The new daily push cap, GRW1-C1, is 3 pushes.', 'g-2024-w06', '2024-02-05');
  await addClaim('cap-initial', 'daily-push-cap', 'The daily push cap was initially set at 3 pushes per day.', 'g-2026-w18');
  await addClaim('quota-6', 'push-quota', 'The push quota is set to 6 pushes from this week.', 'g-2026-w04', '2026-01-19');
  // the team's own claims, many of them with the question's "now"
  for (let i = 0; i < 40; i++) {
    const doc = `g-team-${i}`;
    await addDoc(doc, `raw/docs/weekly/2025-W${String(10 + i).padStart(2, '0')}/g.md`, `Oslo Growth weekly report · week ${10 + i} of 2025`, `2025-0${1 + (i % 9)}-15`,
      [`Oslo Growth now runs canary steps of five percent, item ${i}; daily standup notes.`], ['oslo-growth']);
    await addClaim(`team-${i}`, 'oslo-growth', `Oslo Growth now runs canary steps of five percent, item ${i}.`, doc);
  }
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('asksLatest', () => {
  it('reads a question asking for the newest source or what it says', () => {
    for (const q of [
      "By Oslo Platform's latest weekly report, how many risks are still open?",
      'Which is the newest incident Oslo Platform has reported? Give its ID.',
      "What service availability does Oslo Platform's most recent weekly report give?",
      '按杭州平台组最新一周的周报，还有几个风险没有关闭？',
      '杭州支付组最新报告的那起事故是哪一起？给出编号。',
      '杭州平台组最近一次报告的事故是哪一起？',
    ]) expect(asksLatest(q), q).toBe(true);
  });

  it('not a current value: it is in the source that last changed it, not in the newest (2026-11-22 model check)', () => {
    for (const q of [
      "What is Oslo Growth's daily push cap now?",
      'Who currently leads the team?',
      '杭州增长组的每日推送上限现在是多少？',
      '杭州支付组的单笔退款审批上限现在是多少？',
      '目前谁负责R-118？',
      '杭州平台组当前在岗多少人？',
    ]) expect(asksLatest(q), q).toBe(false);
  });

  it('not a balance-sheet "current", a period, or a known date', () => {
    for (const q of [
      "What was the company's current ratio in fiscal 2023?",
      'What were total current liabilities at year end?',
      '最近三个月有几起事故？',
      'How many risks were open in week 12 of 2026?',
      'Which incidents did Oslo Platform report in 2025?',
    ]) expect(asksLatest(q), q).toBe(false);
  });
});

describe('topicTerms', () => {
  it('keeps what to look for: not the names, the recency words or how to answer', () => {
    expect(topicTerms("By Oslo Platform's latest weekly report, how many risks are still open?", ['Oslo Platform'])).toEqual(['weekly', 'report', 'risk', 'open']);
    expect(topicTerms('Which is the newest incident Oslo Platform has reported? Give its ID.', ['Oslo Platform'])).toEqual(['incident', 'report']);
    const zh = topicTerms('按杭州平台组最新一周的周报，还有几个风险没有关闭？', ['杭州平台组']);
    expect(zh).toEqual(expect.arrayContaining(['周报', '风险', '关闭']));
    expect(zh.join()).not.toMatch(/杭州|平台|最新/);
  });
});

describe('newestSources', () => {
  it('gives the latest report though it says "in progress" where the question says "still open", and the newest that says it', async () => {
    const out = await newestSources(store, "By Oslo Platform's latest weekly report, how many risks are still open?", ['oslo-platform']);
    expect(out.map((c) => c.documentId)).toEqual(['w22', 'w18']);
    expect(out.map((c) => c.newest)).toEqual([{ rank: 1 }, { rank: 2, full: true }]);
    expect(out[0].docDate).toBe('2026-05-29');
    expect(out[0].content).toContain('R-118 in progress');
  });

  it('gives the newest reports that hold what is asked: an incident, not the newest report without one, nor an old incident\'s postmortem', async () => {
    const out = await newestSources(store, 'Which is the newest incident Oslo Platform has reported? Give its ID.', ['oslo-platform']);
    expect(out.map((c) => c.documentId)).toEqual(['w22', 'w21']);
    expect(out[1].newest).toEqual({ rank: 2, full: true });
    expect(out[1].content).toContain('INC-1125');
  });

  it('reads the reference day: what was the newest then', async () => {
    const out = await newestSources(store, "By Oslo Platform's latest weekly report, how many risks are still open?", ['oslo-platform'], { now: '2026-05-16' });
    expect(out.map((c) => c.documentId)).toEqual(['w20', 'w18']);
  });

  it('zh: the team\'s latest weekly report, not minutes whose bigrams cross the question\'s words', async () => {
    const risks = await newestSources(store, '按杭州平台组最新一周的周报，还有几个风险没有关闭？', ['杭州平台组']);
    expect(risks[0].documentId).toBe('zh22');
    const incident = await newestSources(store, '杭州平台组最新报告的那起事故是哪一起？给出编号。', ['杭州平台组']);
    expect(incident.map((c) => c.documentId)).toEqual(['zh22', 'zh21']);
  });

  it('nothing for a question naming nothing', async () => {
    expect(await newestSources(store, 'What is the latest weekly report?', [])).toEqual([]);
  });
});

describe('ask on a question asking for the latest state', () => {
  const capture = () => {
    const prompts: { system: string; user: string }[] = [];
    const llm: LlmClient = {
      enabled: true,
      model: 'capture',
      async complete(messages: ChatMessage[]) {
        prompts.push({ system: messages[0].content, user: messages[1].content });
        return 'Answer.\n{"citations":[1],"gaps":[]}';
      },
    } as unknown as LlmClient;
    return { prompts, llm };
  };

  it('leads the passages with the newest report, dated and marked, and says how to read it', async () => {
    const { prompts, llm } = capture();
    const res = await ask(store, defaultConfig(), embedder, llm, "By Oslo Platform's latest weekly report, how many risks are still open?", { mode: 'keyword', track: false });
    expect(res.route.newest?.map((n) => n.path)).toEqual(['raw/docs/weekly/2026-W22/7bda1f7403.md', 'raw/docs/weekly/2026-W18/r.md']);
    expect(prompts[0].user).toContain('[1] (raw/docs/weekly/2026-W22/7bda1f7403.md, 2026-05-29, newest');
    expect(prompts[0].user).toContain("[2] (raw/docs/weekly/2026-W18/r.md, 2026-05-01, newest with all the question's words");
    expect(prompts[0].system).toContain('A chunk marked "newest"');
  });

  it('as before when switched off, and for a question that does not ask for the latest state', async () => {
    const off = capture();
    const a = await ask(store, defaultConfig(), embedder, off.llm, "By Oslo Platform's latest weekly report, how many risks are still open?", { mode: 'keyword', track: false, newest: false });
    expect(a.route.newest).toBeUndefined();
    expect(off.prompts[0].system).not.toContain('A chunk marked "newest"');
    const past = capture();
    const b = await ask(store, defaultConfig(), embedder, past.llm, 'How many risks did Oslo Platform list in week 12 of 2026?', { mode: 'keyword', track: false });
    expect(b.route.newest).toBeUndefined();
    // a current value: the team's newest reports, not naming the cap, led its prompt and it was answered from an older one
    const now = capture();
    const c = await ask(store, defaultConfig(), embedder, now.llm, "What is Oslo Growth's daily push cap now?", { mode: 'keyword', track: false });
    expect(c.route.newest).toBeUndefined();
    expect(now.prompts[0].system).not.toContain('A chunk marked "newest"');
  });

  it('labels a passage with its date', () => {
    expect(passageLabel({ chunkId: 'c', documentId: 'd', path: 'raw/docs/a.md', title: null, content: '', docDate: '2026-05-01', score: 0, signals: {}, widened: { seqs: [0], of: 1 } })).toBe('raw/docs/a.md, 2026-05-01, widened');
    expect(passageLabel({ chunkId: 'c', documentId: 'd', path: 'wiki/x.md', title: null, content: '', score: 0, signals: {}, excerpt: true })).toBe('wiki/x.md, excerpt');
  });
});

describe('a setting changed under its short name', () => {
  it('a twin is an entity of the same type going by the alias, when no third entity does', async () => {
    expect(await shortNameTwins(store, ['daily-push-cap'])).toEqual(['push-quota']);
    // "the cap": two entities go by it; GRW1-C1 is a component, not a setting of the same type
    expect(await shortNameTwins(store, ['gift-cap'])).toEqual([]);
  });

  it('the question\'s named entities reach the twin', async () => {
    const named = await namedEntities(store, "What is Oslo Growth's daily push cap now?");
    expect(named).toEqual(expect.arrayContaining(['oslo-growth', 'daily-push-cap', 'push-quota']));
    expect(named).not.toContain('grw1-c1');
  });

  it('the current value under the short name is among the facts, before the team\'s claims', async () => {
    const q = "What is Oslo Growth's daily push cap now?";
    const facts = await factsForQuestion(store, q, [], { named: await namedEntities(store, q), limit: 8 });
    const ids = facts.map((f) => f.id);
    expect(ids).toContain('quota-6');
    expect(ids.indexOf('quota-6')).toBeLessThan(4);
    expect(ids.slice(0, 3).every((id) => !id.startsWith('team-'))).toBe(true);
  });
});
