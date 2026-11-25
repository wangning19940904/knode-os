import { z } from 'zod';

/**
 * The benchmark suite's data model (docs/design/23).
 *
 * A pack is a portable directory: the sources every system reads, the gold
 * no system sees, and the tasks they are scored on. Everything a run produces
 * — builds, answers, scores — is a JSONL record keyed so that a resumed run
 * skips what is done.
 */

export const SUITES = ['generation', 'usage', 'emergence', 'update', 'robustness', 'learning'] as const;
export type Suite = (typeof SUITES)[number];

export const TASK_TYPES = [
  'single-hop', 'multi-hop', 'aggregation', 'comparison', 'temporal', 'unanswerable', 'global', 'numeric',
  'style', 'attribution', 'themes', 'forecast', 'affect', 'needs',
  'update', 'conflict', 'injection', 'cross-lingual', 'counterfactual',
  // corpus-level use (docs/design/23 §2.1): evidence spread over at least CORPUS_TASK_MIN_DOCS documents
  'aggregate', 'timeline', 'contradiction', 'profile',
  // 3–5 hops whose bridge entities sit in different documents
  'deep-hop',
  // a name that means two things (two people, a renamed project, a redefined metric): the answer must say so
  'ambiguous',
  // benchmark separation (docs/design/28):
  // a value a later document corrected or retracted without repeating the entity's name: current or as-of value
  'stale',
  // namesakes, near-identical names and renames: the question names one real entity, the corpus holds look-alikes
  'lookalike',
  // filter + aggregate + group-by over more than STRUCTURED_MIN_DOCS documents, exact gold
  'structured',
  // a 3–4 hop chain whose question shares no words with the bridges' evidence
  'nonlexical-hop',
  // a planted connection between entities whose documents share no words for it
  'connection',
  // an existing question asked in other words (cross-lingual covers another language)
  'paraphrase',
  // design 33 §3: an entity asked by a name the corpus states once and then drops (an old name, a nickname, a code)
  'alias',
  // design 37 §2: a change request (a commit message); the answer is the files the change touches
  'localization',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Task types that ask about the corpus as a whole: what a compiled wiki should answer better than a lookup. */
export const CORPUS_TASK_TYPES: readonly TaskType[] = ['aggregate', 'timeline', 'contradiction', 'profile'];
/** The fewest distinct documents a corpus-level task's evidence may span. */
export const CORPUS_TASK_MIN_DOCS = 5;
/** The fewest hops (and distinct evidence documents) of a deep-hop task. */
export const DEEP_HOP_MIN = 3;
/** A structured query's evidence spans more than this many documents (docs/design/28 §c). */
export const STRUCTURED_MIN_DOCS = 21;
/** Task types of the separation families (docs/design/28), reported family by family. */
export const SEPARATION_TASK_TYPES: readonly TaskType[] = ['stale', 'lookalike', 'structured', 'nonlexical-hop', 'connection', 'paraphrase', 'cross-lingual'];

/**
 * How a task is scored:
 * - judge      the judge grades the answer 0–2 against `answer` (and `keypoints`)
 * - exact      EM/F1 of the `Final answer:` line against `answer` / `answers`, judge as fallback
 * - count      the first number on the `Final answer:` line equals `answer` (a count), judge as fallback
 * - keypoints  share of `keypoints` the answer covers (judged)
 * - set        the answer's JSON items matched one-to-one against `items` (how: `list`)
 * - label      one categorical label (an emotion, a valence) compared without a model
 * - choice     one of `choices` (authorship attribution), compared without a model
 * - abstain    the right answer is to say the sources do not tell
 * - value      model-free: the `Final answer:` line names `answer` (or one of `answers`) as a whole
 *              term and none of the stale values in `meta.stale` (numbers within `meta.tolerance`)
 */
export const SCORINGS = ['judge', 'exact', 'count', 'keypoints', 'set', 'label', 'choice', 'abstain', 'value'] as const;

export const DOMAINS = ['research', 'medicine', 'law', 'finance', 'literature', 'personal', 'synthetic', 'public', 'code', 'fixture'] as const;

export const SourceRecordSchema = z.object({
  url: z.string(),
  license: z.string(),
  sha256: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  retrievedAt: z.string().optional(),
  note: z.string().optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const PackManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.number().int().positive(),
  title: z.string(),
  domain: z.enum(DOMAINS),
  languages: z.array(z.string()).min(1),
  description: z.string(),
  builder: z.object({ recipe: z.string(), options: z.record(z.string(), z.unknown()).default({}), builtAt: z.string() }),
  sources: z.array(SourceRecordSchema).default([]),
  stats: z.object({ documents: z.number(), chars: z.number(), tasks: z.number(), facts: z.number(), paddingDocuments: z.number(), paddingChars: z.number() }).partial().optional(),
  /** What the holdout holds and why no system may see it. */
  holdout: z.string().optional(),
  /**
   * What `eval pack lint` holds the pack to (docs/design/33 §4): the fewest questions per family
   * (`meta.family`) and per stratum (`meta.stratum`, the hops' lengths).
   */
  lint: z.object({ families: z.record(z.string(), z.number()).default({}), strata: z.record(z.string(), z.number()).default({}) }).optional(),
  /**
   * Nothing dated after this (ISO 8601) may enter a build (docs/design/37 §2, the leak rule): a code
   * localization pack's base commit date. `validatePack` refuses a corpus document dated later, and the
   * leak check a workspace document whose frontmatter `date` is later.
   */
  cutoff: z.string().optional(),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

export const CorpusDocSchema = z.object({
  /** Relative to corpus/ — also the document's id in every citation. */
  path: z.string(),
  title: z.string().optional(),
  date: z.string().optional(),
  author: z.string().optional(),
  lang: z.string().optional(),
  source: z.string().optional(),
  kind: z.string().optional(),
});
export type CorpusDoc = z.infer<typeof CorpusDocSchema>;

export const EvidenceRefSchema = z.object({ doc: z.string(), quote: z.string().optional() });

/** How directly a synthetic signal is written into the sources. */
export const SIGNALS = ['explicit', 'implicit', 'latent'] as const;

export const GoldFactSchema = z.object({
  id: z.string(),
  text: z.string(),
  doc: z.string(),
  quote: z.string().optional(),
  entities: z.array(z.string()).default([]),
  date: z.string().optional(),
  kind: z.string().optional(),
  signal: z.enum(SIGNALS).optional(),
});
export type GoldFact = z.infer<typeof GoldFactSchema>;

export const GoldLinkSchema = z.object({
  head: z.string(),
  relation: z.string(),
  tail: z.string(),
  doc: z.string().optional(),
  /** model-free (a regex, a dataset's own annotation), planted (synthetic), or model (extracted, verified). */
  origin: z.enum(['model-free', 'planted', 'model']),
});
export type GoldLink = z.infer<typeof GoldLinkSchema>;

/**
 * One real entity and every name the sources give it. Namesakes share a name:
 * their clusters carry `context` (a team, a role) that tells them apart, and
 * `kind` says what the entity is (person, project, customer, item).
 */
export const GoldAliasSchema = z.object({
  canonical: z.string(),
  aliases: z.array(z.string()).min(1),
  kind: z.string().optional(),
  context: z.array(z.string()).optional(),
});
export type GoldAlias = z.infer<typeof GoldAliasSchema>;

/** One expected item of a set-scored task: a theme, a need, a characteristic word, a listed fact or event. */
export const GoldItemSchema = z.object({
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  signal: z.enum(SIGNALS).optional(),
  weight: z.number().positive().default(1),
  /** When the item holds (timeline): YYYY, YYYY-MM or YYYY-MM-DD. */
  date: z.string().optional(),
  /** Corpus (or update) documents that state the item. */
  docs: z.array(z.string()).optional(),
  /**
   * Structured matching (`list.match` fields): every group must have one of
   * its terms in the predicted label — a team, a quarter and a count, say.
   */
  fields: z.array(z.array(z.string()).min(1)).optional(),
});
export type GoldItem = z.infer<typeof GoldItemSchema>;

/**
 * How a set-scored usage task's list is read and matched (docs/design/23 §4):
 * - match      judge (same item in other words), alias (label or an alias occurs in the
 *              predicted label, numbers bounded — no model), docs (the predicted item's
 *              evidence covers every document the gold item names — no model)
 * - ordered    the items form a timeline: order accuracy over matched pairs, dates compared
 * - maxItems   how many items the answer may list
 * - requireDocs a match also needs one of the gold item's documents among the predicted
 *              item's evidence ("which sources disagree" is part of the answer)
 * - primary    which set metric is the task's correctness: f1, or recall where the gold
 *              is not exhaustive (a profile drafted from sampled statements), or exact
 *              (structured queries: the whole set or nothing), or complete (every gold
 *              item and no entry naming one of the task's `meta.distractors`: RAMDocs's
 *              "all valid answers, no wrong one"; other extra entries do not count against it)
 * - fields     (match) every item's `fields` groups must each have a term in the predicted label
 */
export const ListSpecSchema = z.object({
  match: z.enum(['judge', 'alias', 'docs', 'fields']).default('judge'),
  ordered: z.boolean().default(false),
  maxItems: z.number().int().positive().max(60).default(10),
  requireDocs: z.boolean().default(false),
  /**
   * exact: correctness is 1 only when the predicted set equals the gold set (structured queries).
   * complete: 1 only when every gold item is matched and no entry names a distractor (`meta.distractors`).
   */
  primary: z.enum(['f1', 'recall', 'exact', 'complete']).default('f1'),
});
export type ListSpec = z.infer<typeof ListSpecSchema>;

/**
 * What a task's gold depends on not occurring anywhere else: a padding document
 * (scale curves, `--fraction` above 1) may contain none of `terms` and lie under
 * none of `prefixes`, so adding it cannot change the task's gold.
 */
export const ClosedWorldSchema = z.object({
  terms: z.array(z.string()).default([]),
  prefixes: z.array(z.string()).default([]),
});

export const TaskSchema = z.object({
  id: z.string(),
  suite: z.enum(SUITES),
  type: z.enum(TASK_TYPES),
  question: z.string(),
  lang: z.string().optional(),
  answer: z.string().optional(),
  answers: z.array(z.string()).optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
  asOf: z.string().optional(),
  keypoints: z.array(z.string()).optional(),
  items: z.array(GoldItemSchema).optional(),
  choices: z.array(z.string()).optional(),
  scoring: z.enum(SCORINGS),
  /** Set-scored usage tasks: how the answer's list is matched (default: judge, at most 10 items). */
  list: ListSpecSchema.optional(),
  /** Corpus-level tasks whose gold padding must not touch (see ClosedWorldSchema). */
  closedWorld: ClosedWorldSchema.optional(),
  /** The suite's pre-registered primary metric is computed over tasks marked primary (all, when none is). */
  primary: z.boolean().optional(),
  /** Update tasks: the batch (updates/NN) that must be applied before asking. */
  afterUpdate: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/* ------------------------------ run records ------------------------------ */

/** What a system's model calls used, summed — the shim fills it for every system the same way. */
export interface Usage {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Codex's plan weighting (src/estimate/codex.ts weightedTokens). */
  weightedTokens: number;
  /** At published API prices, where the model has one. */
  costUsd: number;
  /** Time spent inside model calls (summed across concurrent calls). */
  llmMs: number;
  embeddingTokens: number;
  embeddingCalls: number;
  /** Calls answered from the response cache: counted at their original cost. */
  replayedCalls: number;
}

export function emptyUsage(): Usage {
  return {
    calls: 0, failedCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    weightedTokens: 0, costUsd: 0, llmMs: 0, embeddingTokens: 0, embeddingCalls: 0, replayedCalls: 0,
  };
}

export interface Citation {
  /** A corpus document path. */
  doc: string;
  quote?: string;
}

/**
 * A generated page an answer cited (docs/design/38 §7, E6): `wiki/<page>` as the answer wrote it, and the corpus
 * documents it stands for — a summary page's `source:`, else what the page declares it was made from, else the
 * documents its lines cite. Empty: a page that stands for no document (an index, the log, a path the build has no
 * page at); such a citation counts for nothing, as it did before pages were mapped.
 */
export interface PageCitation {
  page: string;
  docs: string[];
}

export interface Answer {
  text: string;
  /** The line after `Final answer:`, or the whole text when there is none. */
  finalAnswer: string;
  citations: Citation[];
  /**
   * The wiki pages it cited, each mapped to its documents (`PageCitation`); citation precision and recall count
   * those documents beside `citations`. Present (if empty) on the answers of an arm that reads knode's pages, from
   * 2026-11-24 on; absent on every answer before, whose `citations` are what they were scored on.
   */
  pageCitations?: PageCitation[];
  /** Documents the system looked at or retrieved, best first (agents: files they read). */
  retrieved: string[];
  toolCalls: number;
  /**
   * An agent's trace: its command lines and `mcp:<server>.<tool> <args>`
   * calls, in order, at most 50 of 300 characters each (src/eval/trace.ts).
   * Absent on non-agent systems and on records written before traces were kept.
   */
  commands?: string[];
  /**
   * What each entry of `commands` returned, at the same index: the first
   * 2,000 characters and the full length (src/eval/trace.ts `ToolOutput`),
   * null where nothing came back. Absent on records written before outputs
   * were kept (2026-11-15) and on sessions a worker ran without sending them.
   */
  outputs?: ({ text: string; chars: number; failed?: boolean } | null)[];
  /** An agent stopped at its step cap. */
  capped?: boolean;
  /**
   * How a capped agent's closing turn went (docs/design/36 §5): `answered`,
   * the text is the answer it gave when told to stop; `no-answer` or
   * `used-a-tool`, it gave none; `not-run`, it was stopped with nothing, as
   * every capped agent was before 2026-11-22 (a worker from before still does).
   */
  closing?: 'answered' | 'no-answer' | 'used-a-tool' | 'not-run';
  /** An agent touched a path outside its corpus copy: the answer is void. */
  leaked?: string[];
  error?: string;
  /** The agent session behind it was killed or stopped with the run (docs/design/32 §3): asked again on resume, never an empty answer. */
  cancelled?: boolean;
  usage: Usage;
  ms: number;
}

export interface AnswerRecord extends Answer {
  key: string;
  pack: string;
  system: string;
  taskId: string;
  /** The update batch applied (cumulatively) before this answer, for update tasks. */
  batch?: string;
  /** `eval run --repeat`: which answer to the same task this is (2, 3 …); absent on the first. */
  repeat?: number;
  at: string;
  /** Where its model calls ran (docs/design/27 §8): "local", a remote worker's name, or "mixed". */
  worker?: string;
  /** The CLI and model they ran on, e.g. `codex-cli:gpt-6.1-sol` — the same for every account. */
  backend?: string;
}

export interface BuildRecord {
  key: string;
  pack: string;
  system: string;
  ok: boolean;
  error?: string;
  /** Wall time of the build. */
  ms: number;
  usage: Usage;
  /** Usage per stage (extract, summary, judge, wiki, embed …). */
  stages: Record<string, Usage>;
  /** Bytes the built knowledge base takes on disk. */
  bytes: number;
  /** Peak resident memory of the build process, when measured. */
  peakRssBytes?: number;
  notes?: Record<string, unknown>;
  at: string;
  /** Where its model calls ran (docs/design/27 §8): "local", a remote worker's name, or "mixed". */
  worker?: string;
  /** The CLI and model they ran on. */
  backend?: string;
}

export interface ScoreRecord {
  key: string;
  pack: string;
  system: string;
  suite: Suite | 'ops';
  metric: string;
  /** Per-task scores carry the task; aggregate scores do not. */
  taskId?: string;
  taskType?: TaskType;
  value: number | null;
  n?: number;
  ci?: [number, number];
  detail?: Record<string, unknown>;
  /** The answer's repeat index, when the run repeats answers (absent: the first). */
  repeat?: number;
  at: string;
  /** Where the judge calls of its scoring pass ran (docs/design/27 §8): "local", a remote worker's name, or "mixed". */
  worker?: string;
  /** The judge's CLI and model. */
  backend?: string;
}

/** A unit of what a system generated — never a raw source passage (docs/design/23 §5). */
export interface KnowledgeUnit {
  id: string;
  kind: 'page' | 'claim' | 'entity' | 'relation' | 'summary' | 'community';
  title?: string;
  text: string;
  /** Corpus documents the unit says it comes from. */
  sources: string[];
  /** Ids of the units it links to. */
  links: string[];
  /** For relation units: the two ends, by name. */
  head?: string;
  tail?: string;
  relation?: string;
}
