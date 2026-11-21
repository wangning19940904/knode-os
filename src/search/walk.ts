import { builtinOntology } from '../graph/ontology.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { relationSourceSql, toDateString } from '../store/temporal.js';
import { ClaimItem, SearchResult } from '../types.js';
import { keywordTerms, termCount } from './search.js';
import { asOfDate } from './claimset.js';
import { latestSourceDate, OrdinalAsk, ordinalInQuestion, pickByOrder, placeEntities, presentOf } from './walk-order.js';

/**
 * The multi-hop route of `ask` (docs/design/30 §3): resolve → relations →
 * read, for a bounded number of hops, without a model call per hop.
 *
 * From the entities the question names, each hop reads the live relations of
 * every entity on the frontier (the heaviest `READ_PER_ENTITY` of each, so a
 * hub cannot crowd out the one relation a person has), scores them, keeps the
 * best and moves to their far ends. A relation scores by
 *
 * - the question's terms its type, description and far end hold, the
 *   question's predicates widened by their synonyms (处理好 reads 修复, 名下
 *   reads 负责, "fixed" reads 修复), each term weighted by how few of this
 *   hop's relations hold it, so a word every candidate shares decides nothing;
 * - its far end lying within two relations of another entity the question
 *   names (not the one this branch started from): "（第七事业部）华鼎零售升级的那起
 *   事故" prefers the customer's incident whose group belongs to the seventh
 *   division over the customer's heavier incidents elsewhere. Each named
 *   entity weighs as a term does, by how few candidates it anchors.
 *
 * A branch may use a term only as often as the question does, so an
 * escalation leads to a second escalation only when the question asks for
 * two. Every branch takes its best step and the `FRONTIER` best of the rest
 * join it, so a hub cannot take a hop whole. Past the first hop only
 * relations that hold a term or are anchored lead on; the walk ends at
 * `maxHops`, or when none does. For every relation kept, the passage where
 * its two ends are mentioned together is read: that is the sentence that
 * states the hop. The passages come chain by chain, the best first.
 *
 * What the walk cannot do: pick "the Nth incident of the year" (an ordering,
 * not a relation), or bridge a rename the index holds as two unrelated
 * entities. Those stay with the answer's completion or with entity
 * resolution.
 *
 * What `ask` gets: the relations walked, as facts with their source; the
 * bridge passages, sharing the top of the context with the SAG search's; and the entities
 * reached, whose claims join the facts. One completion still writes the
 * answer.
 */

export interface WalkStep {
  hop: number;
  relationId: string;
  source: string;
  sourceId: string;
  target: string;
  targetId: string;
  type: string;
  description: string;
  path: string | null;
  /** The passage the relation was read from, where the store records it. */
  chunkId?: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** The scores of the relations on the way here, this one's included: a step deep on a well-matched branch scores most. */
  score: number;
  /** The step that reached this one's near end (an index into `steps`); null from an entity the question names. */
  parent: number | null;
  /** When the question ordered this hop ("今年第二起…"): how this far end was picked. */
  order?: string;
}

export interface Walk {
  steps: WalkStep[];
  /** Entities reached past the named ones. */
  reached: string[];
  /** Passages where a walked relation's two ends are mentioned together, the best-scored step's first. */
  bridges: SearchResult[];
  /** The question's ordering ("第二起", "the latest"), the hop it ordered, and each branch's pick or why there was none. */
  ordering?: { asked: string; hop: number | null; picks: string[] };
  /** The walk's time budget was spent: what it stopped before, after how long. What it had walked is returned. */
  spent?: { budgetMs: number; ms: number; before: string };
}

/** Relations kept per hop beside each branch's own best (and on the first hop, in all). */
const FRONTIER = 5;
/** Relations read per frontier entity and hop before scoring. */
const READ_PER_ENTITY = 150;
/** Relations of one entity ordered at most: more, and the walk makes no pick and says the set was too large. */
const ORDER_MAX = 2000;
/** The walk's time budget by default: past it, no further hop or ordering starts, and the walk returns what it has. */
const WALK_BUDGET_MS = 1500;

/**
 * The live relations of the given entities: the heaviest `$2` of each, and of each the `$2` whose descriptions
 * hold the most of the question's terms (`$3`, as LIKE patterns; the heaviest among equals), so an entity with more
 * heavy relations than are read cannot hide the light one the question asks about. With their ends, their source and its path
 * (a source scope's: a page knode wrote is none).
 */
const RELATIONS_OF = `SELECT f.id AS near_id, r.id, r.source_id, r.target_id, se.name AS source, te.name AS target, se.type AS source_type, te.type AS target_type,
         r.type, r.description, r.weight, r.valid_from, r.valid_to, r.document_id, r.chunk_id,
         COALESCE((SELECT d.path FROM documents d WHERE d.id = r.document_id), ${relationSourceSql('r', 'path')}) AS path
  FROM unnest($1::text[]) AS f(id)
  CROSS JOIN LATERAL (
    (SELECT * FROM relations r WHERE (r.source_id = f.id OR r.target_id = f.id) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
     ORDER BY r.weight DESC, r.id LIMIT $2)
    UNION
    (SELECT r.* FROM relations r
       CROSS JOIN LATERAL (SELECT count(*) AS held FROM unnest($3::text[]) p WHERE lower(r.description) LIKE p) h
     WHERE (r.source_id = f.id OR r.target_id = f.id) AND r.tx_to IS NULL AND r.type <> 'co_occurs' AND h.held > 0
     ORDER BY h.held DESC, r.weight DESC, r.id LIMIT $2)) r
  JOIN entities se ON se.id = r.source_id JOIN entities te ON te.id = r.target_id
  ORDER BY r.id, f.id`;

/** The question's terms as LIKE patterns for `RELATIONS_OF` (spellings of two characters or more). */
const likePatterns = (terms: WalkTerm[]) => [...new Set(terms.map((t) => t.text).filter((t) => t.length >= 2))].map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

/** Question terms scored at most: a chain question is long, and its last clause names the last hop. */
const WALK_TERMS_MAX = 64;
/** Neighbours read per entity when finding what a named entity anchors (two relations out). */
const ANCHOR_FANOUT = 60;

/**
 * Predicates the question and the relation descriptions word differently:
 * when the question holds any spelling of a family, the relation may hold any
 * other. Only spellings that mean the same in general: escalating is not
 * complaining, releasing is not going live or delivering, a hint is not
 * raising, joining is not a transfer. A knowledge base's own synonyms belong
 * to its vocabulary, not here.
 */
const PREDICATE_FAMILIES: string[][] = [
  ['修复', '修好', '处理好', '处理', '解决', '搞定', 'fixed', 'fix', 'resolved', 'resolve', 'repaired'],
  ['负责', '名下', '盯着', '跟进', '主导', '牵头', '在管', '主管', 'owner', 'owns', 'owned', 'responsible', 'in charge', 'leads'],
  ['接手', '接管', 'took over', 'take over', 'taken over', 'inherited'],
  ['提出', '预警', '提了', 'raised', 'flagged', 'warned'],
  ['风险', '隐患', 'risk', 'hazard'],
  ['事故', '故障', '宕机', 'incident', 'outage'],
  ['上线', '投产', 'went live', 'go-live', 'go live'],
  ['发布', 'released', 'release'],
  ['调到', '调入', '调往', '调去', '转到', '转岗', 'transferred', 'moved to'],
  ['升级', 'escalated', 'escalation'],
  ['客户', 'customer', 'client'],
  ['成员', '组员', 'member'],
];

/** A question term, and the key it is counted under: its own spelling, or its predicate family. */
export interface WalkTerm {
  text: string;
  key: string;
}

const isCjk = (w: string) => w.charCodeAt(0) >= 0x3400;
const occurrences = (q: string, w: string) => (isCjk(w) ? q.split(w).length - 1 : termCount(q, w));

/**
 * The question's terms with the spellings of the entities it names blanked
 * out (those are reached by the walk and weighed as anchors, and their
 * fragments — 事业部 of 第七事业部 — would match every sibling's name), the other
 * spellings of each predicate it uses, and how many times the question uses
 * each: a branch may match a term as often as the question says it
 * ("修复过一起…升级的事故…另一个组升级过事故——那一起是谁修复的" walks 升级 and 修复 twice).
 */
export function walkTerms(question: string, namedNames: string[] = []): { terms: WalkTerm[]; budget: Map<string, number> } {
  let q = question.toLowerCase();
  for (const name of [...namedNames].sort((x, y) => y.length - x.length)) if (name.length >= 2) q = q.split(name.toLowerCase()).join(' ');
  const terms = new Map<string, WalkTerm>();
  const budget = new Map<string, number>();
  for (const t of keywordTerms(q, WALK_TERMS_MAX)) {
    const text = t.toLowerCase();
    terms.set(text, { text, key: text });
    budget.set(text, Math.max(1, occurrences(q, text)));
  }
  PREDICATE_FAMILIES.forEach((family, i) => {
    // the longest spellings first, each blanked once counted: 处理好 is one use, not one of 处理好 and one of 处理
    let rest = q;
    let used = 0;
    for (const w of [...family].sort((x, y) => y.length - x.length)) {
      used += occurrences(rest, w);
      rest = rest.split(w).join(' ');
    }
    if (used === 0) return;
    const key = `family:${i}`;
    for (const w of family) terms.set(w, { text: w, key });
    budget.set(key, used);
  });
  // the kind of thing the question ends at, named in its last clause ("此人名下的那个项目是在哪一周投产的" ends at a
  // project): a far end of that type holds `type:<id>`. Only the last: a type named earlier ("调到了另一个组，并在那里
  // 接手了一个项目") would pull an early hop toward what a later one is about. A dash continues the clause: in
  // "另一个组升级过事故——那一起是谁修复的" the incident is what the question ends at
  const last = q.split(/[。？！?!，,；;]/).map((x) => x.trim()).filter(Boolean).pop() ?? '';
  for (const [type, words] of typeCues()) {
    let rest = last;
    let used = 0;
    for (const w of [...words].sort((x, y) => y.length - x.length)) {
      const word = TEAM_WORD.has(w) ? new RegExp(`(?<=[个那这该本此各哪每一两几同另])${w}(?![合织件成建装])`, 'g') : null;
      used += word ? (rest.match(word) ?? []).length : occurrences(rest, w);
      rest = word ? rest.replace(word, ' ') : rest.split(w).join(' ');
    }
    if (used > 0) budget.set(`type:${type}`, used);
  }
  return { terms: [...terms.values()], budget };
}

/** 组 names a team only as a word ("那个组", "另一个组"), not inside 组合, 组织, 组件 or 投资组合. */
const TEAM_WORD = new Set(['组']);

/** Question nouns that name an entity type beside the ontology's own labels: 组 asks for a team, 故障 for an event. */
const TYPE_NOUNS: Record<string, string[]> = {
  organization: ['组', '团队', '部门', '小组', 'team', 'group', 'department', 'company'],
  project: ['项目', 'project', 'initiative'],
  event: ['事故', '故障', '事件', 'incident', 'outage'],
};

/** Each entity type's spellings: its ontology label (人物, 项目, 事件 …) and the question nouns that point at it. */
let typeCueMap: Map<string, string[]> | null = null;
function typeCues(): Map<string, string[]> {
  if (typeCueMap) return typeCueMap;
  typeCueMap = new Map();
  let labels: { id: string; label?: string }[] = [];
  try {
    labels = builtinOntology().entityTypes;
  } catch {
    /* the nouns alone */
  }
  for (const t of labels) {
    // a person is what nearly every chain question asks for (谁, 此人): no cue tells its steps apart
    if (t.id === 'other' || t.id === 'concept' || t.id === 'person') continue;
    const words = (t.label ?? '').split('/').map((w) => w.trim()).filter((w) => w.length >= 2 && !/[（(]/.test(w));
    typeCueMap.set(t.id, [...new Set([...words, ...(TYPE_NOUNS[t.id] ?? [])])]);
  }
  for (const [id, words] of Object.entries(TYPE_NOUNS)) if (!typeCueMap.has(id)) typeCueMap.set(id, words);
  return typeCueMap;
}

interface RelRow {
  id: string; source_id: string; target_id: string; source: string; target: string; type: string; description: string;
  source_type: string; target_type: string; document_id: string | null; chunk_id: string | null;
  weight: number; path: string | null; valid_from: string | Date | null; valid_to: string | Date | null;
}

interface Candidate {
  r: RelRow;
  farId: string;
  nearId: string;
  /** The term keys the relation holds that its branch has not used up. */
  held: string[];
  /** Named entities (other than this branch's own) whose two-relation neighbourhood holds the far end. */
  anchors: string[];
  /** What the relation says, as scored: its type, its description, its far end. */
  text: string;
  score: number;
  /** The question describes its far end better than its siblings (the meaning signal gave it a bonus). */
  meant?: boolean;
  /** One of a few siblings the question describes one of. */
  described?: boolean;
  /** How the ordering step picked the far end. */
  order?: string;
}

/** How strongly the meaning signal prefers a far end, per standard deviation above its siblings' mean. */
const MEANING_WEIGHT = 1;
/**
 * The most the meaning signal adds: two points, under what a term held by few of a hop's relations weighs (a rare
 * term weighs up to ~5), however many siblings the meaning is measured against; uncapped, the nearest of 150 gained
 * about 12.
 */
const MEANING_CAP = 2;
/** The cosine to the question below which a far end is not what the question describes, however its siblings fare. */
const MEANING_FLOOR = 0.3;

/**
 * A bonus of one point per standard deviation above the group's mean, at most `cap`, for each member with a value at
 * least `floor`. Of two siblings both far from the question neither gains, and among 150 the nearest gains no more
 * than `cap`.
 */
function zBonus(group: Candidate[], value: (c: Candidate) => number | undefined, weight: number, cap: number, floor: number): void {
  const withValue = group.filter((c) => value(c) !== undefined);
  if (withValue.length < 2 || weight === 0 || cap <= 0) return;
  const v = withValue.map((c) => value(c)!);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  if (sd < 1e-6) return;
  for (const c of withValue) {
    if (value(c)! < floor) continue;
    const bonus = Math.min(cap, weight * Math.max(0, (value(c)! - mean) / sd));
    if (bonus > 0) {
      c.score += bonus;
      c.meant = true;
    }
  }
}

/**
 * Each far end's nearness to the question by meaning: the cosine of the
 * question's embedding to the entity's (its name, type, aliases and
 * description), where the entity has one of the question's model.
 */
async function meaningOf(store: Store, ids: string[], queryVector: number[] | undefined, model: string | undefined): Promise<Map<string, number>> {
  if (!queryVector || !model || ids.length === 0) return new Map();
  try {
    const rows = await store.query<{ id: string; cos: number }>(
      `SELECT ee.entity_id AS id, 1 - (ee.embedding <=> $2::${VECTOR_TYPE}) AS cos FROM entity_embeddings ee
       WHERE ee.entity_id = ANY($1::text[]) AND ee.model = $3`,
      [ids, toVectorLiteral(queryVector), model],
    );
    return new Map(rows.map((r) => [r.id, Number(r.cos)]));
  } catch {
    // a vector of another dimension than the store's: no meaning signal
    return new Map();
  }
}

/** The entities within two live relations of each named one, the named entity itself left out. */
async function anchorSets(store: Store, named: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(named.map((id) => [id, new Set<string>()]));
  if (named.length < 2) return out;
  const rows = await store.query<{ root: string; id: string }>(
    `WITH roots AS (SELECT unnest($1::text[]) AS root),
     e1 AS (
       SELECT roots.root, n.id FROM roots CROSS JOIN LATERAL (
         SELECT CASE WHEN r.source_id = roots.root THEN r.target_id ELSE r.source_id END AS id
         FROM relations r WHERE (r.source_id = roots.root OR r.target_id = roots.root) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
         ORDER BY r.weight DESC, r.id LIMIT $2) n),
     e2 AS (
       SELECT e1.root, n.id FROM e1 CROSS JOIN LATERAL (
         SELECT CASE WHEN r.source_id = e1.id THEN r.target_id ELSE r.source_id END AS id
         FROM relations r WHERE (r.source_id = e1.id OR r.target_id = e1.id) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
         ORDER BY r.weight DESC, r.id LIMIT $2) n)
     SELECT root, id FROM e1 UNION SELECT root, id FROM e2`,
    [named, ANCHOR_FANOUT],
  );
  for (const r of rows) if (r.id !== r.root) out.get(r.root)?.add(r.id);
  return out;
}

/** How much a signal held by `df` of `n` candidates tells them apart: near zero when every one holds it. */
const rarity = (df: number, n: number) => Math.log((n + 1) / (df + 0.5));

export async function walkRelations(
  store: Store,
  question: string,
  named: string[],
  opts: {
    maxHops?: number;
    /** The question's embedding and its model: far ends are then also preferred by meaning among their siblings. */
    queryVector?: number[];
    model?: string;
    /** The day a relative period ("今年") is read from (YYYY-MM-DD), as `ask`'s `now`; default the clock's. */
    now?: string;
    /** Milliseconds the walk may take before it stops starting hops and orderings (default `WALK_BUDGET_MS`). */
    budgetMs?: number;
  } = {},
): Promise<Walk> {
  const maxHops = Math.min(Math.max(opts.maxHops ?? 4, 1), 4);
  const out: Walk = { steps: [], reached: [], bridges: [] };
  if (named.length === 0) return out;
  const names = await store.query<{ name: string; aliases: unknown }>(`SELECT name, aliases FROM entities WHERE id = ANY($1::text[])`, [named]);
  const { terms, budget } = walkTerms(question, names.flatMap((e) => [e.name, ...(Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string') : [])]));
  const anchors = await anchorSets(store, named);
  const patterns = likePatterns(terms);
  const ordinal = ordinalInQuestion(question);
  // the noun the ordering is about: the first predicate family the question uses after the ordinal ("第二起…故障" → 事故)
  const orderKey = ordinal ? orderedNoun(question, ordinal, terms) : null;
  let orderedHop: number | null = null;
  const picks: string[] = [];
  let present: ReturnType<typeof presentOf> | null = null;
  let latest: string | null | undefined;
  // per entity reached: the named entities its branch descends from (a branch is not anchored by its own start),
  // and the term keys the relations on its way have used
  const origins = new Map<string, Set<string>>(named.map((id) => [id, new Set([id])]));
  const spent = new Map<string, Map<string, number>>();
  const pathScore = new Map<string, number>();
  const reachedBy = new Map<string, number>();
  const visited = new Set(named);
  const used = new Set<string>();
  let frontier = [...named];

  const started = Date.now();
  const budgetMs = opts.budgetMs ?? WALK_BUDGET_MS;
  const over = (before: string) => {
    const ms = Date.now() - started;
    if (ms < budgetMs || out.spent) return !!out.spent;
    out.spent = { budgetMs, ms, before };
    return true;
  };
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    // the first hop always runs: a walk that returns nothing for want of time would say less than a short one
    if (hop > 1 && over(`hop ${hop}`)) break;
    const rows = await store.query<RelRow & { near_id: string }>(RELATIONS_OF, [frontier, READ_PER_ENTITY, patterns]);
    const toCandidate = (r: RelRow & { near_id: string }): Candidate => {
      const nearId = r.near_id;
      const forward = r.source_id === nearId;
      const farId = forward ? r.target_id : r.source_id;
      const near = forward ? r.source : r.target;
      const far = forward ? r.target : r.source;
      // the near end's own name says nothing about where the relation leads
      const text = `${r.type.replace(/_/g, ' ')} ${near ? r.description.split(near).join(' ') : r.description} ${far}`.toLowerCase();
      const spentHere = spent.get(nearId);
      const farType = forward ? r.target_type : r.source_type;
      const held = [...new Set([...terms.filter((t) => termCount(text, t.text) > 0).map((t) => t.key), ...(budget.has(`type:${farType}`) ? [`type:${farType}`] : [])])]
        .filter((k) => (spentHere?.get(k) ?? 0) < (budget.get(k) ?? 1));
      const from = origins.get(nearId) ?? new Set<string>();
      const anchoredBy = named.filter((n) => !from.has(n) && (n === farId || anchors.get(n)?.has(farId)));
      return { r, farId, nearId, held, anchors: anchoredBy, text, score: 0 };
    };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      // a relation between two frontier entities is read once, from the first
      if (used.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push(toCandidate(r));
    }
    // a term or a named entity weighs by how few of this hop's candidates hold it
    const n = candidates.length;
    const df = new Map<string, number>();
    for (const c of candidates) for (const k of [...c.held, ...c.anchors.map((a) => `anchor:${a}`)]) df.set(k, (df.get(k) ?? 0) + 1);
    for (const c of candidates) {
      c.score = [...c.held, ...c.anchors.map((a) => `anchor:${a}`)].reduce((s, k) => s + rarity(df.get(k)!, n), 0);
    }
    // by meaning: among the relations of one type from one entity (a division's three groups), the far ends the
    // question describes best ("管基础设施的那个组" of 平台组, 支付组, 增长组), by standard deviations above their siblings
    const meaning = await meaningOf(store, [...new Set(candidates.map((c) => c.farId))], opts.queryVector, opts.model);
    const siblings = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const k = `${c.nearId}|${c.r.type}`;
      siblings.set(k, [...(siblings.get(k) ?? []), c]);
    }
    for (const group of siblings.values()) zBonus(group, (c) => meaning.get(c.farId), MEANING_WEIGHT, MEANING_CAP, MEANING_FLOOR);
    // a named entity's few siblings one of which the question describes ("第一事业部管基础设施的那个组" of a division's
    // three groups) are all walked, the described one first: the description picks among them by meaning, and the
    // later hops (an ordering, a fix) may yet tell them apart
    if (hop === 1) {
      for (const group of siblings.values()) {
        if (group.length <= FRONTIER && group.some((c) => c.meant)) for (const c of group) c.described = true;
      }
    }
    // the ordering step, at the first hop where an entity leads to several of what the question orders: each such
    // branch keeps the one the question names, by date, and drops the others it ordered (the note lists them all)
    const dropped = new Set<Candidate>();
    if (ordinal && orderKey && orderedHop === null) {
      const spellings = terms.filter((t) => t.key === orderKey).map((t) => t.text);
      const ofKind = (c: Candidate) => spellings.some((w) => termCount(c.text, w) > 0);
      const nears = over(`ordering at hop ${hop}`) ? [] : [...new Set(candidates.filter(ofKind).map((c) => c.nearId))];
      if (out.spent && out.spent.before === `ordering at hop ${hop}`) picks.push(`not ordered: ${ordinal.text}: the walk's time budget (${budgetMs} ms) was spent before it could order`);
      // every relation of those entities, not the heaviest READ_PER_ENTITY: the year's first incident may be a light one
      const full = nears.length === 0 ? [] : await store.query<RelRow & { near_id: string }>(RELATIONS_OF, [nears, ORDER_MAX + 1, patterns]);
      const pools = new Map<string, Candidate[]>();
      const byId = new Map(candidates.map((c) => [c.r.id, c]));
      for (const r of full) {
        if (used.has(r.id)) continue;
        let c = byId.get(r.id);
        if (!c) {
          c = toCandidate(r);
          byId.set(r.id, c);
          candidates.push(c);
        }
        if (c.nearId === r.near_id && ofKind(c)) pools.set(r.near_id, [...(pools.get(r.near_id) ?? []), c]);
      }
      const counts = new Map<string, number>();
      for (const r of full) counts.set(r.near_id, (counts.get(r.near_id) ?? 0) + 1);
      const ordered = [...pools.entries()].filter(([, pool]) => new Set(pool.map((c) => c.farId)).size >= 2);
      if (ordered.length > 0) {
        orderedHop = hop;
        if (ordinal.period && ordinal.period.year === null && !present) present = presentOf(asOfDate(question) ?? null, opts.now ?? null);
        // an entity with more relations than can be ordered makes no pick: its candidates are not placed
        const orderable = ordered.filter(([nearId]) => (counts.get(nearId) ?? 0) <= ORDER_MAX);
        const placed = await placeEntities(store, [...new Set(orderable.flatMap(([, pool]) => pool.map((c) => c.farId)))], { spellings, latest: ordinal.kind !== 'nth' });
        const top = Math.max(0, ...candidates.map((c) => c.score));
        for (const [nearId, pool] of ordered) {
          const nearName = pool[0].r.source_id === nearId ? pool[0].r.source : pool[0].r.target;
          if ((counts.get(nearId) ?? 0) > ORDER_MAX) {
            picks.push(`${nearName}: not ordered: ${ordinal.text} would order more than ${ORDER_MAX} relations of ${nearName}; its candidates are walked unordered`);
            continue;
          }
          const byFar = new Map(pool.map((c) => [c.farId, c]));
          const pick = pickByOrder(ordinal, [...byFar.keys()].map((id) => placed.get(id)!), present);
          if (!pick.picked) {
            // a relative period that holds nothing: say whether the knowledge base has any source in it at all
            let why = '';
            if (pick.dated === 0 && present && ordinal.period?.year === null) {
              if (latest === undefined) latest = await latestSourceDate(store, present.date);
              const start = ordinal.period.unit === 'year' ? `${present.date.slice(0, 4)}-01-01` : `${present.date.slice(0, 7)}-01`;
              if (!latest || latest < start) why = `; the knowledge base has no source dated in ${ordinal.period.unit === 'year' ? present.date.slice(0, 4) : present.date.slice(0, 7)} (its latest: ${latest ?? 'none'})`;
            }
            picks.push(`${nearName}: ${pick.note}${why}`);
            continue;
          }
          picks.push(`${nearName}: ${placed.get(pick.picked)?.name ?? pick.picked} — ${pick.note}`);
          for (const c of pool) {
            if (c.farId === pick.picked) {
              c.score += top + 1;
              c.order = pick.note;
              if (!c.held.includes(orderKey)) c.held.push(orderKey);
            } else dropped.add(c);
          }
        }
      }
    }
    // a relation leads on when it holds a term of the question or is anchored by another entity it names, and on the
    // first hop also when its far end is one of the few siblings the question describes; one that does none of these
    // is not about the question, whatever its weight
    const leads = (c: Candidate) => c.held.length > 0 || c.anchors.length > 0 || (hop === 1 && c.described === true);
    const scored = candidates
      .filter((c) => !dropped.has(c))
      .sort((a, b) => b.score - a.score || b.r.weight - a.r.weight || (a.r.id < b.r.id ? -1 : 1));
    // only relations that match the question or lead toward another entity it names go on, the first hop's too: a
    // question the walk cannot help gets nothing from it rather than the heaviest relations of what it names;
    // every branch takes its own best step, then the best of the rest fill the hop, so a hub cannot take it whole
    const eligible = scored.filter(leads);
    const chosen = new Set<Candidate>();
    if (hop > 1) {
      // the branches first whose way here scored best: an ordered pick or a well-matched chain keeps its lead
      const best = new Map<string, Candidate>();
      for (const c of eligible) if (!best.has(c.nearId)) best.set(c.nearId, c);
      const total = (c: Candidate) => (pathScore.get(c.nearId) ?? 0) + c.score;
      for (const c of [...best.values()].sort((a, b) => total(b) - total(a)).slice(0, FRONTIER)) chosen.add(c);
    }
    for (let i = 0, extra = 0; i < eligible.length && extra < FRONTIER; i++) {
      if (!chosen.has(eligible[i])) {
        chosen.add(eligible[i]);
        extra++;
      }
    }
    const kept = eligible.filter((c) => chosen.has(c));
    if (kept.length === 0) break;
    const next: string[] = [];
    for (const { r, farId, nearId, held, score, order } of kept) {
      used.add(r.id);
      const total = (pathScore.get(nearId) ?? 0) + score;
      out.steps.push({
        hop, relationId: r.id, source: r.source, sourceId: r.source_id, target: r.target, targetId: r.target_id,
        type: r.type, description: r.description, path: r.path, chunkId: r.chunk_id, validFrom: toDateString(r.valid_from), validTo: toDateString(r.valid_to), score: total,
        parent: reachedBy.get(nearId) ?? null,
        ...(order ? { order } : {}),
      });
      if (visited.has(farId)) continue;
      pathScore.set(farId, total);
      reachedBy.set(farId, out.steps.length - 1);
      visited.add(farId);
      next.push(farId);
      out.reached.push(farId);
      origins.set(farId, new Set(origins.get(nearId)));
      const was = spent.get(nearId);
      const now = new Map(was);
      for (const k of held) now.set(k, (now.get(k) ?? 0) + 1);
      spent.set(farId, now);
    }
    frontier = next;
  }

  out.bridges = await bridgePassages(store, out.steps);
  if (ordinal) out.ordering = { asked: ordinal.text, hop: orderedHop, picks };
  return out;
}

/** The term key of the first predicate family the question uses after the ordinal, within its clause. */
function orderedNoun(question: string, ordinal: OrdinalAsk, terms: WalkTerm[]): string | null {
  const rest = question.slice(ordinal.end).toLowerCase().split(/[，。？！?!；;]/)[0];
  let best: { at: number; key: string } | null = null;
  for (const t of terms) {
    if (!t.key.startsWith('family:')) continue;
    const at = rest.indexOf(t.text);
    if (at >= 0 && (!best || at < best.at)) best = { at, key: t.key };
  }
  return best?.key ?? null;
}

/**
 * The steps as chains, best first: the best-scored step with the steps that
 * led to it, from the first hop down, then the next best not yet listed.
 */
export function chainOrder(steps: WalkStep[]): number[] {
  const out: number[] = [];
  const listed = new Set<number>();
  const byScore = steps.map((_, i) => i).sort((a, b) => steps[b].score - steps[a].score || a - b);
  for (const i of byScore) {
    const chain: number[] = [];
    for (let j: number | null = i; j !== null && !listed.has(j); j = steps[j].parent) chain.push(j);
    for (const j of chain.reverse()) {
      listed.add(j);
      out.push(j);
    }
  }
  return out;
}

/**
 * For each step, the passage that states it: the chunk the relation was read from (relations record it since v20);
 * else a passage of its source document (the one it cites, stored or else read from its evidence the same
 * way, store/temporal.ts relationSource: a page knode wrote is no source) that
 * mentions both ends, or either. Only a relation with no recorded source falls back to a chunk that merely
 * mentions both ends, and that passage says so: on a knowledge base where two names appear together daily, a
 * co-mention is no statement of the relation. One bounded read per step; no document needs a date.
 */
async function bridgePassages(store: Store, steps: WalkStep[]): Promise<SearchResult[]> {
  if (steps.length === 0) return [];
  const rows = await store.query<{ i: number; rank: number; chunk_id: string; document_id: string; path: string; title: string | null; content: string; doc_date: string | Date | null }>(
    `SELECT pair.i, x.rank, c.id AS chunk_id, c.document_id, d.path, d.title, c.content, d.doc_date
     FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS pair(rid, a, b, i)
     JOIN relations r ON r.id = pair.rid
     CROSS JOIN LATERAL (
       SELECT COALESCE(r.document_id, ${relationSourceSql('r', 'id')}) AS doc
     ) src
     CROSS JOIN LATERAL (
       SELECT y.chunk_id, y.rank FROM (
         (SELECT ch.id AS chunk_id, 0 AS rank FROM chunks ch WHERE ch.id = r.chunk_id)
         UNION ALL
         (SELECT m1.chunk_id, 1 FROM entity_mentions m1
          JOIN entity_mentions m2 ON m2.chunk_id = m1.chunk_id AND m2.entity_id = pair.b
          WHERE m1.document_id = src.doc AND m1.entity_id = pair.a ORDER BY m1.chunk_id LIMIT 1)
         UNION ALL
         (SELECT m.chunk_id, 2 FROM entity_mentions m WHERE m.document_id = src.doc AND m.entity_id IN (pair.a, pair.b)
          ORDER BY m.chunk_id LIMIT 1)
         UNION ALL
         (SELECT m1.chunk_id, 3 FROM entity_mentions m1
          JOIN entity_mentions m2 ON m2.chunk_id = m1.chunk_id AND m2.entity_id = pair.b
          WHERE m1.entity_id = pair.a AND src.doc IS NULL LIMIT 1)
       ) y ORDER BY y.rank LIMIT 1
     ) x
     JOIN chunks c ON c.id = x.chunk_id
     JOIN documents d ON d.id = c.document_id`,
    [steps.map((s) => s.relationId), steps.map((s) => s.sourceId), steps.map((s) => s.targetId)],
  );
  const byStep = new Map(rows.map((r) => [Number(r.i) - 1, r]));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const i of chainOrder(steps)) {
    const r = byStep.get(i);
    if (!r || seen.has(r.chunk_id)) continue;
    seen.add(r.chunk_id);
    const step = steps[i];
    const coMention = Number(r.rank) === 3;
    out.push({
      chunkId: r.chunk_id, documentId: r.document_id, path: r.path, title: r.title,
      content: coMention ? `(mentions ${step.source} and ${step.target}; not the source of "${step.source} ${step.type.replace(/_/g, ' ')} ${step.target}") ${r.content}` : r.content,
      docDate: toDateString(r.doc_date), score: 0, signals: { structural: step.hop },
      trace: { route: 'sag', hop: step.hop, bridgeEntities: [step.source, step.target], ...(coMention ? { coMention: true } : {}) },
    });
  }
  return out;
}

/** The walked relations as facts `ask` lists: "A acquired B: description", with their source. */
export function stepsAsFacts(steps: WalkStep[]): (ClaimItem & { chunkId: string | null })[] {
  return steps.map((s) => ({
    id: `relation:${s.relationId}`,
    subject: s.source,
    object: s.target,
    type: s.type,
    statement: `${s.source} ${s.type.replace(/_/g, ' ')} ${s.target}${s.description ? `: ${s.description}` : ''}`,
    status: 'fact',
    kind: 'fact',
    startDate: s.validFrom,
    endDate: s.validTo,
    eventDate: null,
    path: s.path,
    chunkId: null,
  }));
}
