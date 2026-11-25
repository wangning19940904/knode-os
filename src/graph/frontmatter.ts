import type { RawDocTarget } from './citations.js';
import { normalizePredicate, Ontology } from './ontology.js';
import { CLAIM_STATUS, ExtractedClaim, ExtractedEntity, ExtractedRelation, normalizeClaimKind } from './store.js';

/**
 * Tier-0 declarative extraction: documents may carry explicit `entities:`,
 * `relations:` and `claims:` lists in their YAML frontmatter (news feeds,
 * imported facts, seed data, agent-written wiki pages). They are applied
 * through the same path as tier-1 LLM extraction, so typed / time-bound
 * relations and claim status work without any LLM configured.
 *
 * ```yaml
 * entities:
 *   - { name: 宁德时代, type: organization, aliases: ["300750", "CATL"] }
 * relations:                         # list form: explicit source
 *   - { source: 宁德时代, target: 时代上汽, type: parent_of, from: "2017-01-01" }
 * relations:                         # map form (gbrain style): the page's own entity is the source
 *   supplies_to: ["[[特斯拉]]", "蔚来"]
 *   competes_with: [比亚迪]
 * claims:
 *   - subject: 宁德时代
 *     statement: 2026Q2 净利润 120 亿元
 *     status: disputed
 *     startDate: "2026-08-10"
 * ```
 */

export interface DeclaredExtraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  claims: ExtractedClaim[];
  /** Relations naming a raw/docs file, diverted when `citationTarget` is given. */
  citations: DeclaredCitation[];
}

export interface DeclaredCitation extends RawDocTarget {
  /** The predicate as written; relationCitation (src/graph/citations.ts) normalizes it. */
  type: string;
  /** The file was the relation's source and the page its target. */
  fileIsSource: boolean;
}

export interface DeclaredOptions {
  /** Source of map-form relations and of list entries without `source` (the page's own entity). */
  defaultSource?: string;
  /** When given, relation predicates are checked against the ontology and unknown ones reported. */
  ontology?: Ontology;
  /**
   * The raw/docs file a relation endpoint names, if any (a wiki page's
   * citations, src/graph/citations.ts). A relation between the page itself —
   * `source` absent or `defaultSource` — and such a file becomes a citation
   * rather than an edge to an entity named after the file. Paired with another
   * entity, or with a second file, it is dropped: there is no node to put it on.
   */
  citationTarget?: (value: string) => RawDocTarget | null;
}

/** `[[Name|label]]` → `Name`; plain strings pass through. */
export function wikilinkName(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = /^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/.exec(v);
  return (m ? m[1] : v).trim();
}

function dateStr(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

export function frontmatterExtraction(fm: Record<string, unknown>, opts: DeclaredOptions = {}): DeclaredExtraction | null {
  const rawClaims = Array.isArray(fm.claims) ? fm.claims : [];
  const rawEntities = Array.isArray(fm.entities) ? fm.entities : [];
  const rawRelations = fm.relations;
  const hasRelations = Array.isArray(rawRelations) ? rawRelations.length > 0 : Boolean(rawRelations && typeof rawRelations === 'object');
  if (rawClaims.length === 0 && rawEntities.length === 0 && !hasRelations) return null;

  const entities: ExtractedEntity[] = [];
  const known = new Set<string>();
  const addEntity = (e: ExtractedEntity) => {
    const key = e.name.trim().toLowerCase();
    if (!key || known.has(key)) return;
    known.add(key);
    entities.push(e);
  };

  for (const raw of rawEntities) {
    if (typeof raw === 'string' && raw.trim()) {
      addEntity({ name: wikilinkName(raw), type: 'concept' });
    } else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      const name = typeof o.name === 'string' ? wikilinkName(o.name) : '';
      if (!name) continue;
      addEntity({
        name,
        type: typeof o.type === 'string' ? o.type : 'concept',
        description: typeof o.description === 'string' ? o.description : undefined,
        aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : undefined,
      });
    }
  }

  const relations: ExtractedRelation[] = [];
  const citations: DeclaredCitation[] = [];
  const addRelation = (source: string, target: string, type: string, extra: Record<string, unknown> = {}) => {
    if (opts.citationTarget) {
      const fromFile = opts.citationTarget(source);
      const toFile = opts.citationTarget(target);
      if (fromFile || toFile) {
        const other = wikilinkName(toFile ? source : target).toLowerCase();
        const isPage = !other || other === (opts.defaultSource ?? '').trim().toLowerCase();
        const ty = typeof type === 'string' ? type.trim() : '';
        if (ty && isPage && !(fromFile && toFile)) citations.push({ ...(toFile ?? fromFile)!, type: ty, fileIsSource: !toFile });
        return;
      }
    }
    const s = wikilinkName(source);
    const t = wikilinkName(target);
    const ty = typeof type === 'string' ? type.trim() : '';
    if (!s || !t || !ty || s.toLowerCase() === t.toLowerCase()) return;
    if (opts.ontology && normalizePredicate(opts.ontology, ty).unknown) {
      // still recorded — the writer keeps the raw spelling and counts it
    }
    relations.push({
      source: s,
      target: t,
      type: ty,
      description: typeof extra.description === 'string' ? extra.description : undefined,
      validFrom: dateStr(extra.validFrom ?? extra.valid_from ?? extra.from ?? extra.since),
      validTo: dateStr(extra.validTo ?? extra.valid_to ?? extra.to ?? extra.until),
    });
    // endpoints must exist as entities for the edge to be written
    addEntity({ name: s, type: 'concept' });
    addEntity({ name: t, type: 'concept' });
  };
  if (Array.isArray(rawRelations)) {
    for (const raw of rawRelations) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const source = typeof o.source === 'string' ? o.source : opts.defaultSource ?? '';
      const target = typeof o.target === 'string' ? o.target : '';
      const type = typeof o.type === 'string' ? o.type : typeof o.predicate === 'string' ? o.predicate : '';
      addRelation(source, target, type, o);
    }
  } else if (rawRelations && typeof rawRelations === 'object') {
    for (const [type, targets] of Object.entries(rawRelations as Record<string, unknown>)) {
      const list = Array.isArray(targets) ? targets : [targets];
      for (const t of list) {
        if (typeof t === 'string') addRelation(opts.defaultSource ?? '', t, type);
        else if (t && typeof t === 'object') {
          const o = t as Record<string, unknown>;
          addRelation(typeof o.source === 'string' ? o.source : opts.defaultSource ?? '', typeof o.target === 'string' ? o.target : '', type, o);
        }
      }
    }
  }

  const claims: ExtractedClaim[] = [];
  for (const raw of rawClaims) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const subject = typeof o.subject === 'string' ? wikilinkName(o.subject) : opts.defaultSource ?? '';
    const statement = typeof o.statement === 'string' ? o.statement.trim() : '';
    if (!subject || !statement) continue;
    const status = typeof o.status === 'string' && (CLAIM_STATUS as readonly string[]).includes(o.status) ? o.status : 'fact';
    claims.push({
      subject,
      object: typeof o.object === 'string' ? wikilinkName(o.object) : null,
      type: typeof o.type === 'string' && o.type.trim() ? o.type.trim() : 'fact',
      statement,
      status: status as ExtractedClaim['status'],
      ...(typeof o.kind === 'string' ? { kind: normalizeClaimKind(o.kind) } : {}),
      startDate: dateStr(o.startDate ?? o.start_date ?? o.validFrom ?? o.valid_from),
      endDate: dateStr(o.endDate ?? o.end_date ?? o.validTo ?? o.valid_to),
      eventDate: dateStr(o.eventDate ?? o.event_date ?? o.date),
      // a measure declared with its parts (a learned page's derived facts, src/learn/facts.ts): the attribute, value and unit as given
      ...(typeof o.attribute === 'string' && o.attribute.trim() ? { attribute: o.attribute.trim() } : {}),
      ...(typeof o.value === 'number' || (typeof o.value === 'string' && o.value.trim()) ? { value: o.value as number | string } : {}),
      ...(typeof o.unit === 'string' && o.unit.trim() ? { unit: o.unit.trim() } : {}),
    });
    // claim subjects must resolve to an extracted entity, so ensure one exists
    addEntity({ name: subject, type: 'concept' });
    if (typeof o.object === 'string' && wikilinkName(o.object)) addEntity({ name: wikilinkName(o.object), type: 'concept' });
  }

  if (entities.length === 0 && claims.length === 0 && relations.length === 0 && citations.length === 0) return null;
  return { entities, relations, claims, citations };
}
