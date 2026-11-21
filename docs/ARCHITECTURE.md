# knode-os — architecture

This file describes what knode-os does **today**. It is the one place to look
for current behaviour; the numbered files in [`docs/design/`](design/README.md)
are decision records — why something was built, what was measured, what was
tried — and are not updated when the code moves on.

Rules for keeping it true:

- A change that alters behaviour described here updates this file in the same
  commit. A new design record adds its outcome here when it is built, not
  before.
- When this file and the code disagree, the code is right and this file has a
  bug. When this file and a design record disagree, this file is right.
- One name per thing. §2 fixes the vocabulary; new text uses it.
- Measurements, run logs and rejected alternatives stay in the design records.

Checked against the code at schema v21 (`src/store/migrations.ts`), 2026-11-17.

## 1. The system in one page

knode-os is a local-first knowledge base for people and coding agents. One
TypeScript process (`knode-os serve`) owns one **data root**; each workspace
under it is a folder of files plus a derived index.

```
sources (files, folders, Feishu, conversations, repositories, feeds, research captures)
   │  convert → Markdown, chunk, embed, tier-0 links
   ▼
documents + chunks ──► extraction (model) ──► entities, relations, claims
                                                │  fold, merge, claim state
                                                ▼
                         generated wiki pages (summaries, entity pages, indexes, corpus views)
   ▲                                            │
   │ research agents write pages and captures   ▼
   └────────────── search · ask · graph · SQL views · context packs
                    (CLI, HTTP /api, MCP, /remote/v1; web UI, macOS app)
```

- **Files are the truth, the index is derived.** Everything under a workspace's
  `raw/`, `wiki/`, `playbooks/` and `ledger/` is plain files; the database can
  be rebuilt from them (`knode-os rebuild`), including model output, which is
  cached in sidecars.
- **Index:** PostgreSQL + pgvector, one schema per workspace, is the default.
  Embedded PGlite (`database.kind: "pglite"`) is opt-in and single-process
  (`.knode/db.lock`). The test suite runs on PGlite.
- **Models** are reached through named connections (`connections[]`, default
  `llmUse`): OpenAI-compatible APIs, the Codex, Claude Code, Cursor and OpenCode
  CLIs, a `command`, or a plugin's provider.
- **Background work** (extraction, summaries, reviews, translation, embedding,
  research sessions, evaluation calls) is leased from one work queue to local
  slots and to remote workers (§7).

## 2. Vocabulary

Each term has one meaning in this file. Where the code or an older design uses
another word for the same thing, it is listed so it can be recognised.

| Term | Meaning | Also seen as |
| --- | --- | --- |
| **data root** | The folder `serve` owns (`--data`, default `~/.knode-os`). | "root" |
| **workspace** | One knowledge base: `users/<owner>/workspaces/<id>/` under the data root. | "tenant" |
| **run workspace** | A research session's scratch folder, `.runs/<job>`. Never just "workspace". | |
| **evaluation root** | A data root marked `server.evaluation: true` that holds evaluation builds (§8). | |
| **document** | An indexed file. `documents.root` is `docs`, `wiki`, `skills`, `traces`, `capabilities` or `codebase`. | "source" |
| **source** | Where a document came from (a folder link, a feed, a Feishu mirror). Not a synonym for document. | |
| **sidecar** | `.sidecar/<document key>/`: converted text and cached model output for one document. | "cooked", "L1", "prepare layer" (layout v2 names) |
| **scope** | The lineage unit: everything one input asserted, applied and disposed as a whole (§4). | |
| **token scope** | What a `knr_` remote token may do. Always "token scope". | "scope" |
| **claim** | A statement about a subject, with type, kind, time and evidence. | "fact" |
| **claim type / claim kind** | Type: closed list from the ontology. Kind: `fact`, `opinion`, `prediction`, `rumor`. | |
| **series** | Claims with the same subject, canonical attribute, object and kind; the newest is **current**, older ones **superseded**. | "stale", "replaced" |
| **generated page** | A wiki page written by a generator and re-rendered when its inputs change. | "view" |
| **SQL view** | A `v_*` catalog view for read-only SQL. Always "SQL view". | "view" |
| **extraction** | The model pass that reads a document's segments into entities, relations and claims. | "tier 1", "labeling", "Extract stage" |
| **tier 0** | Model-free linking of already-known entity names. | |
| **refine** | The nightly audits (`refineWiki`). | "tier 2", "Synthesize" |
| **processing** | All background model work in `serve`. | `/api/labeling/*`, `src/labeling/` |
| **route** | The connection a stage uses: `extraction.{documentLlm,entityLlm,summaryLlm,judgeLlm,translateLlm}`. | "stage model" |
| **work kind** | `extract`, `summarize`, `judge`, `translate`, `embed`, `session`, `eval-call`, `eval-session`. | |
| **piece** | One leased unit of work. | "task" (12, 32), "offer" (27) |
| **slot** | Capacity to run one piece at a time, local or on a worker. | |
| **pool** | A named group of workers. The embedding **model pool** is always written in full. | |
| **Ask** | The UI's conversation with an agent (`chat_*` tables, `chat.*` config). | "chat" |
| **`ask`** | The one-shot answer function behind `knode_ask` and `POST /api/ask`. | |
| **research job / study** | A job writes one page; a study is a job that plans and collects for several section jobs. | |
| **ontology pack / playbook pack / benchmark pack / context pack** | Four different things; always written with the qualifier. | "pack" |
| **system / track** | An evaluation system id; a track is a named list of systems. | "arm" |
| **build** | One evaluation system's index over one benchmark pack. | |
| **SAG walk / relation walk** | Chunk → entity → chunk expansion in search; entity → relation → entity traversal in `ask`. | "walk" |
| **mirror** | A read-only synced copy (linked folder, linked Feishu document, followed conversation). | "linked", "followed" |

`kind`, `tier`, `stage`, `event` and `default` are used for several unrelated
things in the code; this file always qualifies them.

## 3. A workspace on disk

```
raw/docs/         documents people and connectors put in (uploads, folder mirrors, feishu/, conversations/,
                  feeds/, research/<study>/, codebase/<name>.md cards, okf/)
raw/codebase/     repository mirrors at one commit: indexed for search, never extracted
raw/traces/, raw/skills/
.sidecar/<key>/   meta.json, content.md, tier0.json, tier1.json, usage.json,
                  views/source-summary.md (+ .parts.json), views/translations/<lang>.md
wiki/             generated and human pages: sources/, entities/, concepts/, mentions/, timelines/,
                  disagreements/, research/, dreams/, learning/, lint/, datasets/, overview.md
playbooks/        configuration as files: ontology/, concepts/, entities/corrections.yaml, packs/,
                  capabilities/, intents/, research/{profiles,sources}/, agents/, chat/, feeds/
ledger/           events.jsonl, receipts.jsonl, attic/, feeds/<id>/
.knode/           db/ (PGlite only), usage.json, mcp-token, codebases/, eval-index.json, locks
AGENTS.md, CLAUDE.md, purpose.md, schema.md
```

`src/fs/layout.ts` is the only place these names are defined. The file tree in
the clients hides `ledger/`, `playbooks/`, `wiki/lint/` and `wiki/datasets/`.

## 4. Data model

**Scopes and evidence.** Every input is a scope (`doc`, `wiki-human`, `tier1`,
`page`, `datasource`, `dataset`, `dream`, `absence`, `merge`, `claim-merge`,
`lint`, `backref`). A scope's rows are applied in one transaction
(`applyScope`) and removed as a whole (`disposeScope`); both take the ledger
lock first and never await the network. Entities, relations and claims are
shared, content-addressed rows; each scope contributes `evidence` rows, and
`foldTouched` recomputes a row from all its live evidence. Removing a document
therefore removes exactly what only it supported. `ledger/events.jsonl` records
every apply, dispose and purge; `ledger/attic/` keeps removed sidecars so
`rebuild --history` can replay them.

**Entities.** Id is the slug of the name; `entity_namesakes` parts one name
into several people or things when their contexts differ. Type is the
most-read typed reading unless `playbooks/entities/corrections.yaml` overrides
it. Merges are reversible `entity_links` on a `merge` scope. Types and relation
types come from ontology packs (`playbooks/ontology/*.yaml`; default
`core` + `organization`).

**Relations** record the one document they cite and the passage in it (schema
v20): of the documents that state the relation, the earliest by document date,
then the first by path (`relationSource`, `src/store/temporal.ts`). The choice
reads the corpus alone, never the order documents were processed in, so two
builds of one corpus cite the same document; entity pages, the relation walk
and `v_relations.source_path` all read that stored choice. When the rule
changes, stored sources are read again in place at the next open
(`src/lineage/relation-sources.ts`).
`co_occurs` is not stored; it is derived at read time (`src/graph/cooccur.ts`).

**Claims** carry `type`, `kind`, `status`, `event_at`, `observed_at`,
`valid_from`/`valid_to`, and — since schema v19 — `attribute`, `value_num`,
`value_text`, `unit`, `effective_at`. A duplicate is merged by link
(`claims.canonical_id`, `claim_links`, a `claim-merge` scope), never by
rewriting; reads show representatives only. Within a series the claim with the
newest effective date is current and the others are `superseded_by` it; a
same-day different value supersedes nothing, a correction supersedes what it
corrects. Supersession runs after every extraction round — a document pass,
and each review round in `serve` — for the subjects that round wrote claims
of, and over every claim in refine. A weekly reading has the ISO week in its
id (schema v21).

**Time.** Three independent axes: `as_of` (what the index held at a
transaction time), `valid_at`/`valid_range` (when a claim holds), `freshness`
(how recently observed). Document dates are day precision.

**Trust.** A scope is `trusted` or `quarantined`. Writes by actors named
`agent…`, `mcp…` or `api…` are quarantined until a person promotes them; a
quarantined claim that contradicts a trusted one opens a dispute. Scopes also
store an `acl` list from frontmatter. A read filters on it only when the
caller names an actor (the MCP tools and the local CLI can); a read with no
actor, and every `ask`, sees restricted scopes (§10).

**SQL access.** Catalog views `v_*` are read through a per-schema reader role
inside a rolled-back `READ ONLY` transaction, after `assertReadOnlySql`
(`src/datasource/guard.ts`) has lexed the statement.

## 5. Knowledge generation

### 5.1 From a file to chunks

1. **Arrive.** Upload, linked folder (`src/ingest/folders.ts`), Feishu document
   or wiki tree (`lark-cli --as user`; mirrors under `raw/docs/feishu/`),
   picked agent conversation (`raw/docs/conversations/<project>/`), repository
   (`raw/codebase/<name>/` + a card in `raw/docs/codebase/`), feed
   (`playbooks/feeds/<id>.yaml` → `raw/docs/feeds/<id>/`), research capture
   (`raw/docs/research/<study>/`), OKF bundle (`raw/docs/okf/`).
2. **Convert.** PDF, image (tall images in bands; mind maps as outlines,
   `type: MindMap`), HTML, EPUB and plugin converters produce Markdown into the
   sidecar's `content.md`. A reviewed transcript `<original>.md` beside an
   original replaces conversion.
3. **Apply.** `sync` reconciles declared files against the index and applies
   one `doc` scope per changed file: chunks (1200 characters, 150 overlap; mind
   maps by branch), keyword index, match-grams, and tier-0 links to known
   entity names (stoplists in `playbooks/concepts/`).
4. **Embed.** `ingest.embedding` is `inline` or `deferred`; deferred chunks are
   `embed` work for `ingest.embedSlots` (8) local slots or remote workers.

Code files (`documents.root = 'codebase'`) stop here: searchable, never
extracted, summarised or translated. Plain search excludes them; search kind
`code` includes them.

### 5.2 From chunks to knowledge

`serve` runs processing continuously through leased slots
(`src/labeling/scheduler.ts`, `src/work/*`); `knode-os extract` runs the same
stages as one batch (`runDocumentPass`).

| Stage | Route | What it does |
| --- | --- | --- |
| Extract | `documentLlm` | Reads a document in content-defined segments of `extraction.segmentChars` (12,000), cached per segment hash in `tier1.json`; short documents are batched up to 8 per call. Queue priority is (1 + heat) × freshness × importance. |
| Resolve | `entityLlm` | Deterministic resolution at write time (`review.resolution: exact`), then the incremental duplicate-entity audit right after extraction. |
| Summarize | `summaryLlm` | One summary page per `raw/docs` document of at least `extraction.summaryMinChars` (1,500). Long documents are summarised per segment and merged; past `summaryMaxSegments` (12) segments are sampled and the page says so. Cached in the sidecar. |
| Review | `judgeLlm` | Duplicate-claim pairs after a rule pre-filter; verdicts in `claim_pair_verdicts`. `review.claimMerge: auto` merges at confidence ≥ 0.9. |
| Translate | `translateLlm` | With `languages.enabled`: `raw/docs` documents into the primary language in the background; secondary languages and wiki pages on request. Translations live in the sidecar and are not indexed. |

`extraction.summaryAfterExtraction` (default true) orders summaries after
extraction so a summary may link only names the graph holds.

**After each extraction round**, both ways of running it call one model-free
step, `afterExtraction` (`src/ingest/after-extraction.ts`), once the duplicate
audits are done: supersession among the subjects of the new claims, those
claims onto their documents' summary pages, a page for each entity that claims
from two documents or more now speak of, and the pages across documents. A
pass calls it from `runDocumentPass`; `serve` calls it from its review round
(`src/labeling/followup.ts`, every `extraction.intervalMinutes`), then
reconciles views and navigation. A step that belongs after extraction is added
there, not in either caller.

**Nightly refine** (`refineWiki`), in order: entity audit → claim merge → claim
audit → claim review → retire concept-cluster pages → hot topics →
recommendations. **Dream** runs at `dream.schedule` (03:00) and writes
`wiki/dreams/<date>.md` and suggestions.

### 5.3 Generated pages

Generators in `src/wiki/pages.ts`, `nav-views.ts` and `corpus-views.ts` each
declare their inputs; a page re-renders only when its inputs' fingerprint
(`sha16`) changes, and a human-written region of a page survives re-rendering.
Kinds: source summaries (a model-written body plus a generated claims region),
entity pages, dataset pages, hot topics, the research index, navigation indexes
and `overview.md`, and the model-free corpus pages `wiki/mentions/`,
`wiki/timelines/`, `wiki/disagreements/`. `wiki/` is a native OKF v0.2 bundle
and an Obsidian vault.

### 5.4 Research

A research job is one agent session in a run workspace that reads the
workspace over MCP and writes one page through `knode_write`; agent pages are
quarantined. A **study** refines a topic (one call, no tools), collects sources
(seed captures, collectors, or deep-research mode), then runs one section job
per page and writes `wiki/research/<study>.md`. Captures keep the original
bytes. Failures are classified `quota`, `transient`, `setup` or `other`; only
`other` spends an attempt, and a quota or setup pause spreads to queued jobs on
the same agent. **Init** is a research job that reads the whole workspace and
writes `wiki/overview.md` and the root `AGENTS.md`. Profiles live in
`playbooks/research/profiles/`, agents in `playbooks/agents/`.

## 6. Retrieval and answering

### 6.1 Search

`search(store, embedder, query, { mode, k, … })` in `src/search/search.ts`.

- **Modes:** `keyword`, `vector`, `hybrid` (default), `sag`.
- **Fusion:** reciprocal rank fusion, `RRF_K = 60`, weights vector 1,
  keyword 1, graph 0.2. Heat adds a bounded boost of at most
  `heat.searchWeight` (0.05); heat has a 14-day half-life.
- **Generated pages** are capped to a share of the results so sources are not
  crowded out.
- **SAG** (`src/search/sag.ts`): the direct route's top chunks seed a chunk →
  entity → chunk walk over `entity_mentions` (`retrieval.sag`: seed chunks 12,
  entity frontier 24, chunks per entity 12, candidate pool 120, hops 2,
  direct ratio 0.5). Walk results rank after the direct route's reserved
  places; a chunk both routes found rises. `bridgeTerms` (off by default) also
  crosses on rare terms of the seed chunks.
- **Rerank** (`retrieval.rerank`, off by default; `tei` or `openai` style) can
  only reorder. `ask` and `knode_search` pass it; the web UI's search routes do
  not.
- **Filters:** `kinds` (doc, wiki, view, skill, code), `sources` (path
  prefixes), trust, actor, and the time axes.
- **Explore** (`/api/search/explore`) returns per-channel ranks and a one-hop
  graph read, with hit tracking off.

### 6.2 `ask`

`ask` classifies the question by rules (`src/search/route.ts`) into `lookup`,
`list`, `aggregate`, `timeline` or `multihop` and assembles context
accordingly:

- **lookup:** hybrid passages plus up to 24 ranked claims and excerpts.
- **list / aggregate / timeline:** enumeration over claims (scan cap 5,000,
  `retrieval.router.enumerateLimit` 150). With `retrieval.router.computedSets`
  (off by default) a set is computed from claims within a scope taken from
  recorded relations; an empty result is never presented as computed.
- **multihop:** SAG search plus the relation walk (`retrieval.router.maxHops`
  4, 1,500 ms budget, no model).
- **Second round** (`secondRound`, on): one more model-free retrieval, at most
  4 passages and 12 claims.
- A superseded claim is shown with what replaced it (`SearchResult.current`).

Agents do not use `ask`; they browse with the MCP tools (`knode_search`,
`knode_read`, `knode_grep`, `knode_graph_search`, `knode_claims`,
`knode_query`, `knode_resolve`, `knode_survey`, …). `resolve` builds a context
pack and plan from playbook packs, capabilities and intents; `knode_feedback`
writes receipts that feed the learning pages in `wiki/learning/`.

`knode_claims` (`src/store/claims.ts`) dates every claim by its event time,
else the start of its validity, else a date its text states, else its first
source, and both `event_range` and `order: "timeline"` use that date, so an
undated restatement in a weekly report is placed by its week instead of
sorting last or falling out of a window. A timeline includes superseded
values by default and folds restatements (`src/graph/claim-timeline.ts`): a
value repeated in later reports stays one entry with `repeats`, a value
change starts a new one, and a measurement series (weekly progress, a metric)
is one entry with each change in `readings`; `fold: false` lists every row,
and `truncated` / `note` say what the limit left out. A subject reaches the
entities merged into it and a short-name twin its aliases list; `related`
adds its parts and members (`part_of` / `member_of` / `works_at`) and the
claims with it as object; `first_mention` keeps each subject's earliest
claim, for counting what was new in a period. `enumerateClaims` takes the
same fold as an option (`fold`).

## 7. Work queue and remote workers

One broker (`src/work/broker.ts`) leases pieces of the eight work kinds to
slots. Local capacity is `processing.maxLocalCalls` (2) with a plan-quota floor
`processing.minQuotaPercent` (20). Remote workers
(`worker/knode-worker.mjs`) lease over
`/remote/v1/w/<owner>/<workspace>/work/{config,lease,complete,renew,release,status,calibrate}`
with a `knr_` token; the server builds every prompt, checks every result and
does every write. Token scopes: `label`, `read`, `write`, `sql`, `embed`,
`embed-keys`, `research`, `eval`.

Research sessions can leave the machine when `server.remote.offer.session` is
on: a Codex or Claude session with no sub-agents and no study MCP sources gets
no files and reaches the workspace through a per-session MCP route with a
`kms_` token. The job itself stays in `serve`.

Evaluation publishes `eval-call` and `eval-session` pieces through the loopback
producer channel `/eval/v1`; they run only on a slot — a remote worker's or the
run's own `--local codex:N,claude:M`. Pieces are keyed by content digest and
stored durably under `<root>/.knode/eval-queue/`; a piece is `stuck` after
three different machines fail it.

## 8. Evaluation

`knode-os eval` (`src/eval/`) compares knowledge-base systems on the same
sources. `src/bench/` is an older, separate harness for retrieval and
extraction spot checks.

- **Benchmark packs** are directories (`pack.json`, `corpus/`, `holdout/`,
  `gold/`, `tasks/`, `updates/`, `padding/`) under `~/knode-eval`
  (`KNODE_EVAL_HOME`). Recipes build them: synthetic weekly reports (v2 by
  default, v3 with `--options '{"version":3}'`), a life ledger, domain packs
  from real documents, and real-document recipes (Loong, MuDABench, wiki-hops,
  CRUD news). `eval pack lint` runs before every run.
- **Systems.** Track `ladder` = `agent-grep`, `agent-rag`,
  `agent-knode-wiki-sources`, `agent-knode-full`, `knode-ask`, `rag-hybrid`;
  track `single-call` = the last two. `agent-knode` and `agent-knode-wiki` are
  diagnostics that run only when named. GraphRAG, HippoRAG and LightRAG run
  through `eval/adapters/*.py`.
- **Builds** live in the evaluation root (`--root`, `KNODE_EVAL_ROOT`, default
  `~/knode-eval/server`) as `users/<owner>/workspaces/<run>-<pack>`. On
  PostgreSQL they use database `knode_eval`, one schema per build, and a run
  refuses to start against the live database. `serve` on an evaluation root is
  a read-only viewer (loopback, port 12040).
- **Answers** are metered by one shim, run in parallel with hit tracking off,
  and resume from keyed JSONL.
- **Scoring.** Model-free `value`, `exact`, `count`, `set`, `label`, `choice`
  and `abstain` scoring where the task allows it, otherwise a blind judge from
  another model family; `--judge-audit` re-asks a sample and `--repeat-sample`
  measures repeat variance. Reports carry per-type tables, minimum detectable
  effects and cost-normalised figures.
- A build that contains a gold, holdout or tasks file fails the leak check.

## 9. Surfaces and clients

| Surface | For | Notes |
| --- | --- | --- |
| CLI `knode-os …` | People and scripts | `src/cli.ts`; evaluation under `knode-os eval`. |
| HTTP `/api` | The web UI and the macOS app | `src/server/app.ts`; sessions and accounts in `src/auth/`. |
| MCP `/mcp` and stdio | Agents | `src/mcp/tools.ts`; bearer token in `.knode/mcp-token`; runs as owner, or as `agent` when the token is workspace-bound. |
| `/remote/v1` | Remote workers and other programs | Documents, sync, search, graph, claims, entities, SQL, and the work leases. |
| `/eval/v1` | Evaluation runs on the same machine | Loopback only. |

**Web UI** (`web/`, no build step) and the **macOS app** (`macos/`) share five
sections: Library, Explore (Search, Ask, Studies), Knowledge, Tasks (Queue,
Dream) and Settings. `/api/tasks` reports seven processing stages and the
scheduled checks. Charts and mind maps have one renderer each (`web/chart.js`,
`web/mindmap.js`), which the server also runs for HTML export.

**Plugins** (`plugins[]`, `KNODE_PLUGINS`; `src/plugins/`) register converters,
embedding and model providers, storage backends, feed connectors and stages,
and seven pipeline hooks through one registry; built-ins register the same way.

**Interchange.** `okf validate|migrate|import|export` for OKF v0.2 bundles;
`obsidian init|status` for opening `wiki/` as a vault.

## 10. Known gaps

Things a reader could reasonably assume exist and do not.

- **ACLs are opt-in.** `scopeAccessSql` (`src/store/resolver.ts`) applies
  `scopes.acl` only when a read passes an actor. `/api` search, `/remote/v1`
  search and `ask` pass none, and `ask` takes no trust, source or `as_of`
  filter at all.
- **No public client contract.** Design 13 (`contract/`, SDK, `known_at`,
  `available_at`) is not built; `/remote/v1` is what other programs use.
- **No entry or occurrence tables, no `time.zone`.** Of design 16 only
  claim-type normalisation exists; chunks carry no time of their own.
- **Lent embedding keys** (`lendToWorkers`, the `embed-keys` token scope) grant
  nothing yet.
- **Remote sessions** exclude Cursor and the `native` pipeline; workers have no
  quota floor of their own.
- **Evaluation** is not yet a job inside `serve`; the model overlay for
  evaluation workspaces and per-batch snapshots are not built; the PostgreSQL
  vs PGlite retrieval equivalence check has not been run.
- **Search:** no document-date range filter on `search`; no heading metadata
  on chunks; SAG phase 2 (an event table, typed structural edges) is not built;
  no settings UI for the router or rerank.
- **Feeds:** no webhook route and no Feeds screen in the web UI.
- **Repositories:** no database symbol index, module summaries or secret
  scanning.
- `heat.coldThreshold` and `server.remote.evalOfferSeconds` are still accepted
  in configuration and read by nothing.

## 11. Where the decisions are

[`docs/design/README.md`](design/README.md) lists every design record with its
status and the section of this file that now describes its outcome. How-to
guides: [`plugins.md`](plugins.md), [`feeds.md`](feeds.md),
[`remote-access.md`](remote-access.md), [`remote-labeling.md`](remote-labeling.md),
[`embedding-pools.md`](embedding-pools.md),
[`frontmatter-contract.zh-CN.md`](frontmatter-contract.zh-CN.md).
