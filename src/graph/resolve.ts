import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, ReviewResolution } from '../config.js';
import { Queryable } from '../store/migrations.js';
import { EntityCorrections, refusedKeys, refuses } from './corrections.js';
import { codeOf, codesKey, codesOf, MentionContext, namesakeFor, namesakeName, NamesakeRule } from './identity.js';
import { entityKeys, mentionKeys, nameKey, typesCompatible } from './normalize.js';
import { slugify } from './store.js';

/**
 * Write-time entity resolution. Before the writer assigns `slugify(name)` as
 * a new entity's id it asks whether the graph already knows that thing under
 * another spelling: an explicit `sameAs` from the extractor, an existing row
 * with the same slug, or a name / alias key match (see normalize.ts). A match
 * returns the *canonical* id, so mentions of an entity that was merged into
 * another land on the survivor — unless a person said that entity does not
 * answer to the mention's spelling (src/graph/corrections.ts).
 *
 * Only exact key equality merges here. Near-duplicates are the nightly
 * audit's job (dedupe.ts), which proposes rather than decides.
 *
 * A name is not always one thing (identity.ts). Where the entity a mention
 * lands on was parted into several by refine (entity_namesakes: a person and
 * a namesake, a setting ten divisions each have), the mention's code, its
 * team or parent and its document's organizations say which of them it
 * means. Nothing is parted here: one document cannot tell, and the order
 * documents arrive in must not decide. A mention with no such context
 * resolves as it always did.
 */

export interface ResolveInput {
  name: string;
  type?: string;
  aliases?: string[];
  /** Canonical name the extractor believes this entity is the same as. */
  sameAs?: string | null;
  /** What the mention's document says about it: its team or parent, the document's own names (identity.ts). */
  context?: MentionContext;
}

export interface ResolvedEntity {
  id: string;
  /** Current name of the entity the mention resolved to (undefined for a new id). */
  name?: string;
  /** Set when the mention resolved to an entity other than `slugify(name)`. */
  resolvedFrom?: string;
  /** Set when the name was parted and this is the one of its entities the mention means. */
  namesake?: NamesakeRule;
}

interface CandidateRow {
  id: string;
  name: string;
  type: string;
  canonical_id: string | null;
  mention_count: number;
  aliases: string[] | null;
}

async function rowById(q: Queryable, id: string): Promise<CandidateRow | null> {
  const rows = await q.query<CandidateRow>(`SELECT id, name, type, canonical_id, mention_count, aliases FROM entities WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The entities names were parted into (entity_namesakes), read once for a
 * run of resolutions: the table is small and most mentions land on a name
 * that was never parted.
 */
export class NamesakeIndex {
  private byBase: Map<string, NamesakeRule[]> | null = null;
  private baseOf = new Map<string, string>();

  private async load(q: Queryable): Promise<Map<string, NamesakeRule[]>> {
    if (this.byBase) return this.byBase;
    const rows = await q.query<NamesakeRule>(`SELECT id, base_id, name, label, anchors, base_anchors, documents FROM entity_namesakes ORDER BY created_at, id`);
    const byBase = new Map<string, NamesakeRule[]>();
    for (const r of rows) this.put(byBase, r);
    this.byBase = byBase;
    return byBase;
  }

  private put(byBase: Map<string, NamesakeRule[]>, r: NamesakeRule): void {
    (byBase.get(r.base_id) ?? byBase.set(r.base_id, []).get(r.base_id)!).push(r);
    this.baseOf.set(r.id, r.base_id);
  }

  /** The base entity of the family `id` belongs to and the entities parted from it; null when `id` was never parted. */
  async family(q: Queryable, id: string): Promise<{ baseId: string; rules: NamesakeRule[] } | null> {
    const byBase = await this.load(q);
    const baseId = byBase.has(id) ? id : this.baseOf.get(id);
    return baseId ? { baseId, rules: byBase.get(baseId) ?? [] } : null;
  }
}

async function canonicalOf(q: Queryable, row: CandidateRow): Promise<CandidateRow> {
  if (!row.canonical_id) return row;
  const target = await rowById(q, row.canonical_id);
  return target ?? row;
}

/**
 * The identifier a name is, when the name is one: "INC-020-D3T3", "R-71",
 * "事故INC-020-D3T3" (a kind word of up to four characters before it).
 */
export function nameCode(name: string): ReturnType<typeof codeOf> {
  const t = name.normalize('NFKC').trim();
  return codeOf(t) ?? codeOf(t.replace(/^\p{Script=Han}{1,4}/u, '').replace(/\p{Script=Han}{1,4}$/u, ''));
}

/** An identifier of a numbered series: letters, a separator, a counter, and what follows ("INC-020-D3T3", "R-71"). */
export interface SeriesCode {
  prefix: string;
  counter: string;
  rest: string;
}

/**
 * The numbered series a name is one of, or null. Only an identifier made of
 * letters, a separator and a counter is one — INC-001-T1, R-07, GPT-4 — not a
 * model or contract code that runs letters into digits (H100, X100, CU2501,
 * FY24, 24Q3): those are not counted, and a brand or exchange in front
 * (vivoX100, SHFE.CU2501) is not another series.
 */
export function seriesCode(name: string): SeriesCode | null {
  const c = nameCode(name);
  if (!c) return null;
  const m = /^([A-Z]+)[-_](\d+)(.*)$/.exec(c.value);
  return m ? { prefix: m[1], counter: m[2], rest: m[3] } : null;
}

/**
 * Two names that are each an identifier of one numbered series with
 * different values (INC-017-D7T3, INC-020-D3T3; R-01, R-02) are two things,
 * whatever spellings they share. An extraction lists an incident's title as
 * its alias ("活动页白屏"), every team's incident of that title carries it, and
 * the first such incident took the later ones' claims (11 of 210 incidents on
 * the 10× benchmark). Only the two names count, so the order documents arrive
 * in decides nothing. Codes outside a numbered series are never kept apart by
 * this: vivoX100 and X100, ChatGPT-4 and GPT-4, FY24 and FY2024 may be one.
 */
export function namesApartByCode(a: string, b: string): boolean {
  const x = seriesCode(a);
  const y = seriesCode(b);
  // INC-006 and INC-006-T1: one written without its tail is not another member (it may be that one)
  return Boolean(x && y && x.prefix === y.prefix && (x.counter !== y.counter || (x.rest !== '' && y.rest !== '' && x.rest !== y.rest)));
}

/** Whether an entity carries one of these identifier keys among its spellings. */
async function answersToCode(q: Queryable, id: string, codeKeys: string[]): Promise<boolean> {
  if (codeKeys.length === 0) return false;
  const rows = await q.query(`SELECT 1 FROM entity_alias_keys WHERE entity_id = $1 AND alias_key = ANY($2::text[]) LIMIT 1`, [id, codeKeys]);
  return rows.length > 0;
}

async function byKeys(q: Queryable, keys: Set<string>, type: string | undefined, mode: ReviewResolution, refusing?: (id: string) => boolean, mention?: string): Promise<CandidateRow | null> {
  if (keys.size === 0) return null;
  const list = [...keys];
  const ph = list.map((_, i) => `$${i + 1}`).join(',');
  // 'exact' mode ignores the suffix-stripped keys the audit keeps for itself
  const kindCond = mode === 'suffix' ? '' : " AND k.kind = 'exact'";
  const rows = await q.query<CandidateRow>(
    `SELECT DISTINCT e.id, e.name, e.type, e.canonical_id, e.mention_count, e.aliases
     FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
     WHERE k.alias_key IN (${ph}) AND e.tx_to IS NULL${kindCond}
     ORDER BY e.mention_count DESC, e.id`,
    list,
  );
  // an entity one of the spellings names comes before a bigger one that only carries it as an alias
  const names = (r: CandidateRow) => {
    const own = nameKey(r.name);
    return keys.has(own.key) || (mode === 'suffix' && keys.has(own.bare));
  };
  // the mention's spellings that are identifiers: what a series-named entity may be reached by
  const codeKeys = mention ? [...keys].filter((k) => nameCode(k)) : [];
  for (const r of [...rows.filter(names), ...rows.filter((r) => !names(r))]) {
    if (!typesCompatible(type, r.type)) continue;
    // an entity named by a series identifier is reached by that identifier only: "登录失败事故", the title
    // every team's incident of that kind carries as an alias, is not INC-001-T1 because it was mentioned first
    if (mention && seriesCode(r.name) && !names(r) && !(await answersToCode(q, r.id, codeKeys))) continue;
    if (mention && namesApartByCode(mention, r.name)) continue;
    const canonical = await canonicalOf(q, r);
    if (mention && canonical.id !== r.id && namesApartByCode(mention, canonical.name)) continue;
    if (!refusing?.(canonical.id)) return canonical;
  }
  return null;
}

/**
 * Which entity a mention means once its name landed on `landed`, where that
 * entity belongs to a name refine parted (identity.ts, namesakeFor): another
 * entity of that name, or null when it stays where it landed. Reads only.
 */
export async function followNamesake(
  q: Queryable,
  landed: { id: string; name: string },
  mention: { name: string; spellings: readonly string[]; context?: MentionContext },
  namesakes: NamesakeIndex,
  refusing?: (id: string) => boolean,
): Promise<{ id: string; name: string; rule?: NamesakeRule } | null> {
  const family = await namesakes.family(q, landed.id);
  if (!family) return null;
  // a mention that names a parted entity by its own name means that one
  if (landed.id !== family.baseId && nameKey(landed.name).key === nameKey(mention.name).key) return null;
  const rules = family.rules.filter((r) => !refusing?.(r.id));
  const base = landed.id === family.baseId ? landed : (await rowById(q, family.baseId)) ?? landed;
  const context = mention.context;
  // which entity each roof is: an alias of a team, or a team merged into another, is that team
  const roofs = [...new Set([...rules.flatMap((r) => [...r.anchors, ...r.base_anchors]), ...(context?.owners ?? []), ...(context?.documentNames ?? [])])];
  const known = await entitiesNamed(q, roofs);
  const same = (n: string) => known.get(n)?.id ?? `~${nameKey(n).key}`;
  // a spelling only one of the name's entities answers to — and that one a parted entity — means it
  const keys = [...mentionKeys(mention.name, mention.spellings, 'exact')];
  const members = [family.baseId, ...rules.filter((r) => r.id !== r.base_id).map((r) => r.id)];
  const carried = keys.length === 0 ? [] : await q.query<{ entity_id: string; alias_key: string }>(
    `SELECT DISTINCT entity_id, alias_key FROM entity_alias_keys WHERE entity_id = ANY($1::text[]) AND alias_key = ANY($2::text[]) AND kind = 'exact'`,
    [members, keys],
  );
  const carriers = new Map<string, Set<string>>();
  for (const r of carried) (carriers.get(r.alias_key) ?? carriers.set(r.alias_key, new Set()).get(r.alias_key)!).add(r.entity_id);
  const alone = new Set([...carriers.values()].filter((c) => c.size === 1).map((c) => [...c][0]).filter((id) => id !== family.baseId));
  const only = alone.size === 1 ? [...alone][0] : null;
  const chosen = namesakeFor(rules, { codes: codesOf(mention.spellings), baseCodes: codesOf([base.name]), only, context }, same);
  if (!chosen) return base.id === landed.id ? null : { id: base.id, name: base.name };
  // a parted entity a person merged back resolves to where it was merged
  const row = await rowById(q, chosen.id);
  const target = row ? await canonicalOf(q, row) : null;
  if (target && target.id !== chosen.id) return target.id === landed.id ? null : { id: target.id, name: target.name };
  return chosen.id === landed.id ? null : { id: chosen.id, name: namesakeName(chosen), rule: chosen };
}

export async function resolveEntityId(
  q: Queryable,
  input: ResolveInput,
  cache?: Map<string, ResolvedEntity>,
  /**
   * `corrections`: a person's (src/graph/corrections.ts) — a spelling an entity refuses never resolves onto it.
   * `namesakes`: the parted names, read once by a caller that resolves many mentions.
   */
  opts: { mode?: ReviewResolution; corrections?: EntityCorrections; namesakes?: NamesakeIndex } = {},
): Promise<ResolvedEntity> {
  const mode = opts.mode ?? 'exact';
  const name = input.name.trim();
  const slug = slugify(name);
  const codes = codesOf([name, ...(input.aliases ?? [])]);
  const cacheKey = `${slug}|${input.sameAs ?? ''}|${mode}|${codesKey(codes)}`;
  const hit = cache?.get(cacheKey);
  if (hit) return hit;

  const finish = (r: ResolvedEntity): ResolvedEntity => {
    cache?.set(cacheKey, r);
    return r;
  };
  const refusing = opts.corrections?.size ? (id: string) => refuses(refusedKeys(opts.corrections!.get(id)), name) : undefined;
  const namesakes = opts.namesakes ?? new NamesakeIndex();

  /** The entity the name stands for, once it landed on `landed`: one of those it was parted into, else `landed`. */
  const settle = async (landed: CandidateRow): Promise<ResolvedEntity> => {
    const asIs: ResolvedEntity = landed.id === slug ? { id: slug } : { id: landed.id, name: landed.name, resolvedFrom: name };
    const meant = await followNamesake(q, landed, { name, spellings: [name, ...(input.aliases ?? [])], context: input.context }, namesakes, refusing);
    if (!meant) return asIs;
    return meant.id === slug ? { id: slug } : { id: meant.id, name: meant.name, resolvedFrom: name, ...(meant.rule ? { namesake: meant.rule } : {}) };
  };

  // 1. the extractor named the canonical entity outright
  if (input.sameAs && input.sameAs.trim() && input.sameAs.trim().toLowerCase() !== name.toLowerCase()) {
    const target = (await rowById(q, slugify(input.sameAs))) ?? (await byKeys(q, entityKeys(input.sameAs), input.type, 'suffix'));
    if (target && target.id !== slug) {
      const canonical = await canonicalOf(q, target);
      if (!refusing?.(canonical.id)) return finish(await settle(canonical));
    }
  }

  // 2. the slug itself is already a row (possibly merged into another)
  const own = await rowById(q, slug);
  if (own) return finish(await settle(await canonicalOf(q, own)));

  // 3. name / alias key match against live entities of a compatible type (exact spellings, or suffix-stripped too in 'suffix' mode)
  // a series identifier ("INC-006-T1") is that thing by its identifier alone: its other spellings (the
  // incident's title) are what every incident of the kind is called. It lands on whatever carries exactly it.
  if (seriesCode(name)) {
    const byNumber = await byKeys(q, mentionKeys(name, [], mode), input.type, mode, refusing, name);
    return finish(byNumber ? await settle(byNumber) : { id: slug });
  }
  const match = await byKeys(q, mentionKeys(name, input.aliases ?? [], mode), input.type, mode, refusing, name);
  if (match) return finish(await settle(match));

  return finish({ id: slug });
}

/** id → canonical id for every id that was merged into another entity. */
export async function canonicalMap(q: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids)];
  if (list.length === 0) return out;
  // a graph search asks about every endpoint a hop reached: one array parameter, not an IN list
  const rows = await q.query<{ id: string; canonical_id: string }>(
    `SELECT id, canonical_id FROM entities WHERE id = ANY($1::text[]) AND canonical_id IS NOT NULL`,
    [list],
  );
  for (const r of rows) out.set(r.id, r.canonical_id);
  return out;
}

/** canonical id → live entities merged into it. */
export async function membersOf(q: Queryable, canonicalIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const list = [...new Set(canonicalIds)];
  if (list.length === 0) return out;
  const rows = await q.query<{ id: string; canonical_id: string }>(
    `SELECT id, canonical_id FROM entities WHERE canonical_id = ANY($1::text[]) AND tx_to IS NULL`,
    [list],
  );
  for (const r of rows) (out.get(r.canonical_id) ?? out.set(r.canonical_id, []).get(r.canonical_id)!).push(r.id);
  return out;
}

/** The ids plus everything merged into them (for reads that must see a merged entity's evidence under the survivor). */
export async function expandGroups(q: Queryable, ids: readonly string[]): Promise<string[]> {
  const members = await membersOf(q, ids);
  const out = new Set(ids);
  for (const list of members.values()) for (const id of list) out.add(id);
  return [...out];
}

/** An entity with more aliases than this is a sector or a theme, not a setting a report names two ways: no twins are read for it. */
export const TWIN_ALIASES_MAX = 16;

/**
 * The short-name twins of entities already resolved: a live entity of the same type, merged into nothing, that goes
 * by one of their names or aliases (by exact lookup key) when no other entity does. A report that defines a setting
 * once with its code and short name ("new daily push cap: 3 pushes (code GRW1-C1, short name the push quota)") and
 * changes it later under the short name ("the push quota moves to 6 pushes") has the current value extracted onto
 * an entity of its own, which the full name's aliases list and nothing merged (the rule `knode_claims` reaches
 * twins by, src/store/claims.ts, on the alias keys: indexed, where alias lists on 164k entities are not).
 */
export async function shortNameTwins(q: Queryable, ids: readonly string[]): Promise<string[]> {
  const list = [...new Set(ids)];
  if (list.length === 0) return [];
  const rows = await q.query<{ id: string }>(
    `WITH own AS MATERIALIZED (
       SELECT e.id, e.type, k.alias_key
         FROM entities e JOIN entity_alias_keys k ON k.entity_id = e.id AND k.kind = 'exact'
        WHERE e.id = ANY($1::text[]) AND e.tx_to IS NULL
          AND jsonb_array_length(CASE WHEN jsonb_typeof(e.aliases) = 'array' THEN e.aliases ELSE '[]'::jsonb END) <= $2),
     hit AS MATERIALIZED (
       SELECT own.id AS owner, own.type AS owner_type, own.alias_key, t.id, t.type, t.canonical_id, t.tx_to
         FROM own JOIN entity_alias_keys k ON k.alias_key = own.alias_key AND k.kind = 'exact' AND k.entity_id <> own.id
         JOIN entities t ON t.id = k.entity_id)
     SELECT DISTINCT h.id FROM hit h
      WHERE h.tx_to IS NULL AND h.canonical_id IS NULL AND h.type = h.owner_type
        AND NOT EXISTS (SELECT 1 FROM hit o WHERE o.owner = h.owner AND o.alias_key = h.alias_key AND o.id <> h.id
                          AND o.tx_to IS NULL AND o.canonical_id IS DISTINCT FROM h.owner)`,
    [list, TWIN_ALIASES_MAX],
  );
  const named = new Set(list);
  return rows.map((r) => r.id).filter((id) => !named.has(id));
}

/** The live entity a name stands for. */
export interface NamedEntity {
  id: string;
  name: string;
  type: string;
  wikiPath: string | null;
}

const NAMED_BATCH = 5_000;

/**
 * The live entity each name stands for — its own spelling or an alias, exact
 * keys only — under the survivor of a merge: what a [[link]] to a name no page
 * answers to points at. Where several entities answer to one spelling a typed
 * one beats a mined concept, then the entity the spelling names beats one
 * that carries it as an alias, then the most mentioned wins. Names no entity
 * answers to are absent from the map, and so are entities the graph knows
 * only from links to them — the concept a link to an unwritten page leaves
 * (wire.ts) — or every link would be its own target.
 */
export async function entitiesNamed(q: Queryable, names: readonly string[]): Promise<Map<string, NamedEntity>> {
  const keyByName = new Map<string, string>();
  for (const n of new Set(names)) {
    const { key } = nameKey(n);
    if (key.length >= 2) keyByName.set(n, key);
  }
  const keys = [...new Set(keyByName.values())];
  const byKey = new Map<string, NamedEntity & { canonicalId: string | null; rank: number }>();
  for (let i = 0; i < keys.length; i += NAMED_BATCH) {
    const rows = await q.query<{ alias_key: string; id: string; name: string; type: string; wiki_path: string | null; canonical_id: string | null }>(
      `SELECT k.alias_key, e.id, e.name, e.type, e.wiki_path, e.canonical_id
       FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
       WHERE k.alias_key = ANY($1::text[]) AND k.kind = 'exact' AND e.tx_to IS NULL
         AND (e.wiki_path IS NOT NULL OR e.canonical_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM evidence ev WHERE ev.kind = 'entity' AND ev.target_id = e.id AND ev.tx_to IS NULL AND ev.extractor <> 'tier0.wikilink'))
       ORDER BY e.mention_count DESC, e.id`,
      [keys.slice(i, i + NAMED_BATCH)],
    );
    for (const r of rows) {
      const rank = (r.type === 'concept' ? 2 : 0) + (nameKey(r.name).key === r.alias_key ? 0 : 1);
      const best = byKey.get(r.alias_key);
      if (!best || rank < best.rank) byKey.set(r.alias_key, { id: r.id, name: r.name, type: r.type, wikiPath: r.wiki_path ?? null, canonicalId: r.canonical_id, rank });
    }
  }
  const merged = [...new Set([...byKey.values()].flatMap((e) => (e.canonicalId ? [e.canonicalId] : [])))];
  if (merged.length > 0) {
    const survivors = await q.query<{ id: string; name: string; type: string; wiki_path: string | null }>(
      `SELECT id, name, type, wiki_path FROM entities WHERE id = ANY($1::text[]) AND tx_to IS NULL`,
      [merged],
    );
    const byId = new Map(survivors.map((s) => [s.id, s]));
    for (const [key, e] of byKey) {
      const s = e.canonicalId ? byId.get(e.canonicalId) : undefined;
      if (s) byKey.set(key, { id: s.id, name: s.name, type: s.type, wikiPath: s.wiki_path ?? null, canonicalId: null, rank: e.rank });
    }
  }
  const out = new Map<string, NamedEntity>();
  for (const [n, key] of keyByName) {
    const e = byKey.get(key);
    if (e) out.set(n, { id: e.id, name: e.name, type: e.type, wikiPath: e.wikiPath });
  }
  return out;
}

const modeCache = new Map<string, { stamp: string; mode: ReviewResolution }>();

/** `review.resolution` for a data dir, re-read when knode.config.json changes. */
export function resolutionMode(dataDir: string): ReviewResolution {
  const file = path.join(dataDir, CONFIG_FILE);
  let stamp = 'none';
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // no config file: defaults apply
  }
  const hit = modeCache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit.mode;
  let mode: ReviewResolution = 'exact';
  try {
    const cfg = loadConfig(dataDir);
    mode = cfg.review?.resolution === 'suffix' ? 'suffix' : 'exact';
  } catch {
    mode = 'exact';
  }
  modeCache.set(dataDir, { stamp, mode });
  return mode;
}
