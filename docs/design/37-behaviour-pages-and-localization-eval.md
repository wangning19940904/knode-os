# 37 — Behaviour pages for code, kept true by diffs, and an evaluation that asks where a change lands

Status: proposed (2026-11-22). Stage 3 built and reviewed (2026-11-22, branch `claude/citation-deps-refresh-827c12`; §5.1); the other stages are not. Number 36 is taken by `36-evaluation-protocol.md` on branch `claude/kb-evaluation-analysis-f16ece`, which is not on main yet.

Extends design 25 (its "Not done" list: module summaries, pinned citations), design 15 (a new study profile and page template) and design 33 (a new question family and a new report split). Changes none of their decisions.

## 0. Why

Two things met on 2026-11-22.

**Our own runs keep ending in a tie.** In the protocol-36 run, pooled over 227 questions at budget 20, `agent-knode-full` minus `agent-grep` is 0.000 and the knode arms cost 1.29× the tokens per correct answer. At budget 3 the full arm called a knode tool in 0 of 120 answers. Every real-pack question has a literal term in its evidence (`measure.json`), so an agent with a shell finds the evidence by searching for the question's own words.

**A published system reports a large gain on a different kind of task.** Taobao's live-streaming team describes LiveX Wiki (<https://mp.weixin.qq.com/s/N_D1fo-S8KomtfaLQG68Gg>, 2026-11-20): Markdown pages in a Git repository, one per business scenario, each tracing a behaviour from its interface to its bottom dependencies across repositories. Their test hands a coding agent a raw requirement and scores the code it writes. They report +39% over no knowledge base and +30% over their vector RAG, averaged over two batches (+54.5% and +23.8%; +44.3% and +15.9%).

The size of their figure should not be taken at face value: it is a relative change on undisclosed raw scores, with no sample count, a spread of 30 points between batches, and pages written from the same kind of material the tests are built from. What transfers is the shape of the task. A requirement says what should change in business words; the code says it in identifiers. The agent cannot search for words it does not have, and cannot know when it has found every affected place. That is a task where compiled knowledge can win and a shell cannot simply read its way to the answer.

knode-os holds 14 repositories in the agent-atlas workspace and has nothing that describes a behaviour across files. Design 25 indexes every file and renders a card; it lists module summaries and pinned citations as not done.

## 1. Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | Measure before building: a localization pack from git history, run with `agent-grep` alone first | If grep already finds the files, behaviour pages have no room to help and are not worth their model cost |
| D2 | The new task is localization: given a change request, name the files that change | Gold comes from the real diff, scoring needs no judge, and it is the step LiveX's own routing test isolates |
| D3 | A behaviour page is an agent-written wiki page, produced by a study, one per behaviour | The research machinery (drafts a person accepts, section jobs, quarantine) already does this; only the template is new |
| D4 | A page records the commit it was checked against, once per repository, and cites `raw/codebase/<repo>/<path>#L…` | The mirror holds exactly one commit, so a commit per page is as precise as a commit per citation |
| D5 | A written page's citations become `deps` rows; a changed cited file makes the page a refresh suggestion, never a re-render | `propagate` already marks dependents of changed documents; agent prose must be re-verified by an agent, not regenerated |
| D6 | One generated index lists the behaviour pages, and the workspace guide fixes the reading order | In our runs agents ignore tools they are merely offered; LiveX makes the index the entry |
| D7 | Every report splits tasks by whether a page covers their gold | Separates "the knowledge is missing" from "the knowledge is there and was not used" |

## 2. The localization pack (stage 0 and 1)

A new recipe, `code-localization`, registered like the others (`src/eval/packs/index.ts`). It needs no author model.

**Sources.** For each repository, a clone with history but without blobs (`git clone --filter=blob:none`) into `~/knode-eval/sources`. The shallow working clones under `.knode/codebases` are depth 1 and cannot serve. This is a download and needs the user's word before it runs.

**Base commit and tasks.** One base commit per repository. The corpus is the repository's files at the base, chosen by the same rules as design 25 D2 (`planCodebase`). Tasks are the commits after the base that pass every filter:

- touches 2 to 15 kept files, all of which exist at the base (a file created after the base cannot be found);
- at least one touched file is source code, not only documentation, tests or lockfiles;
- the commit message has a body of at least 80 characters (squash-merged pull requests carry the description);
- not a merge, revert, release or dependency bump;
- within 300 commits of the base, so the tree has not drifted far.

The question is the commit message, unchanged. Gold `items` are the touched paths, one item per file, matched with `list.match: alias` and `primary: f1`, which is model-free today (`src/eval/types.ts`). Paths named in the message are not removed: they are counted instead (below).

**Strata, in `meta.stratum`.** `named` when the message holds a gold file's path or basename; `symbol` when it holds an identifier defined in a gold file (from `symbols.ts`); `plain` otherwise. `plain` is the stratum the design is about. `eval pack lint` holds the pack to at least 60 `plain` tasks.

**Leak rule.** Nothing dated after the base may enter a build: no later commit, no changelog, no release notes. The existing leak check gains the base date.

**Memorisation.** The repositories are public and the answering model may have seen their history. Take the base as late as the filters allow and record every commit date. Memorisation lifts all arms alike, so it shrinks differences rather than inventing them; a pack whose `agent-grep` score is high for that reason fails the gate below.

**Stage 0, the free gate.** Build the pack for two repositories (suggested: `openai-codex` and `anomalyco-opencode`; any two with enough commits passing the filters serve). Run the grepability measure (`src/eval/grepability.ts`) over it. No model.

**Stage 1, the cheap gate.** Run `agent-grep` only, on 60 `plain` tasks per repository at budget 20. Proceed to §3 only if mean F1 is under 0.7 and at least a third of tasks score under 0.5. Otherwise stop and record why: the pack does not separate, and behaviour pages would be built on a guess.

## 3. Repositories in an evaluation build

Evaluation builds put the pack's corpus under `raw/docs`, where every file would get extraction and a summary. A pack directory `corpus/codebase/<repo>/` is therefore brought in through `addCodebase` with the local path (the CLI already allows one), which yields the mirror under `raw/codebase/<repo>/`, the card, and the documentation copy.

The arms keep their meaning from design 33:

| Arm | Has |
| --- | --- |
| A `agent-grep` | the repository tree |
| B `agent-rag` | A plus `search` over definition-cut chunks of the same files |
| C `agent-knode-wiki-sources` | A plus `wiki/`, which now holds the card's summary page and the behaviour pages |
| D `agent-knode-full` | C plus knode's tools, with `knode_search` allowed kind `code` |

C − A is the headline: what the pages add.

## 4. Behaviour pages (stage 2)

**What one is.** A page about one thing the software does, as a user or caller would name it: "resuming a session", "approving a tool call", "compacting context". Not a directory, not a class.

**Where the list comes from.** A study profile `codebase-behaviours`. Its draft is written from the card (layout, code map, documentation index) and proposes 10 to 25 behaviours for a repository, each with a one-line scope. A study's draft already waits for a person; the person edits or accepts the list. That is the equivalent of LiveX's human-set boundary, at the cost of reading one list per repository. For evaluation builds the draft is accepted unedited, so a run measures what the system produces unaided.

**The page** (`wiki/code/<repo>/<slug>.md`, quarantined like any agent page):

```yaml
---
type: Behaviour
title: Resuming a session
aliases: [continue a conversation, restore, rollout replay]   # the words a request would use
repositories:
  - { name: openai-codex, commit: 4f1c2ab9d0e1 }             # what the page was checked against
depends_on: ["[[Rollout files]]", "[[Approval policy]]"]
actor: agent-…
research: { at: … }
---
## What it does          two or three sentences, in the caller's words
## Entry points          every way in: command, route, event, schedule
## Path                  entry → orchestration → core modules → what it finally reads or writes
## Controls              configuration keys, flags, environment variables that change the path
## Also affected         callers and other behaviours that share these modules
## Not verified          what the agent suspected and could not confirm
```

Each statement under Entry points, Path and Controls carries `（来源：raw/codebase/<repo>/<path>#L12-L40）`, as the research protocol already asks (`src/research/templates.ts`). The template's `requires:` already checks frontmatter keys and sections. Two checks are new: each of those three sections holds at least one such citation, and each `repositories` commit is the one the mirror holds.

**How the agent investigates**, added to the template, taken from LiveX's production rules:

1. Search twice. First by the behaviour's words and the strings a user sees; then by the identifiers the first pass confirmed, which finds the parts named differently.
2. Trace forward from each entry point, then backward: who calls these functions, where are they registered, which other implementations of the same interface exist.
3. One implementation found proves it exists, not that the picture is complete. List every entry before writing the path.
4. What cannot be confirmed in the code goes under "Not verified" and into no claim.

**Whether `Behaviour` needs an ontology entry** is open: a wiki page's `type` becomes its entity's type, and the default packs are `core` and `organization`.

## 5. Keeping pages true (stage 3)

Today a research page becomes a refresh candidate only when newer evidence about its entity arrives (`src/research/recommend.ts`). Nothing connects it to the files it cites.

- **On write.** `knode_write` parses the page's `raw/codebase/…` and `raw/docs/…` citations and writes one `deps` row per cited document with its content hash, `required: false`, artifact kind `page`.
- **On update.** `codebase update` already re-indexes only changed files, so their documents change and `propagate` (`src/lineage/deps.ts`) lists the page among the dirty ones. A dirty page that no generator owns must not be re-rendered; it gets a `refresh` suggestion instead (how `reconcileViews` treats such a page today is not yet checked), with the reason "3 of 14 cited files changed between 4f1c2ab and 9d0e771" and the changed paths in the job's brief.
- **A cited file removed** files the same suggestion with a stronger reason; the page is not archived.
- **The refresh job** re-reads only the changed files' citations, corrects the page, and sets `repositories[].commit` to the new commit. A page whose cited files did not change keeps its old commit, which stays true for those files.
- **Audit.** A page older than a set number of repository updates with no refresh gets one anyway, with the instruction to list entry points again from scratch. Following only known citations never finds a path the page missed.

Followed repositories update daily at 05:00, so suggestions would arrive in the ordinary queue under the quota floor. `research.auto` decides whether they run unasked.

This also applies to every agent page that cites `raw/docs`, not only behaviour pages.

### 5.1 As built (stage 3, 2026-11-22)

**What `reconcileViews` does with a dirty page no generator owns: nothing, because such a page is never dirty.** An agent's page has no `pages` row (`classify` in `src/ingest/apply.ts` treats a page with one as a view, so research never writes one). `propagate` marks dependents by `UPDATE pages … WHERE path = $1`, which matches no row: the page is neither marked dirty nor archived, and `reconcileViews`, which reads only `pages`, never sees it. A `pages` row whose kind has no generator (`GENERATORS[kind]` undefined) is skipped by the dirty loop (`if (!gen) continue`) and stays dirty forever, but is still archived when a required input goes. Neither path re-renders agent prose, and stage 3 keeps it so: the dependency rows are `required: false` and are written only for pages with no `pages` row.

**Why the suggestion is not filed from `propagate`.** A repository update re-indexes each changed file in its own scope transaction, so `propagate` sees one file at a time and cannot count "3 of 14". Instead, after every sync (`src/ingest/sync.ts`, right after `reconcileViews`), `fileCitationRefreshes` (`src/research/cited-refresh.ts`) compares each page's recorded hashes with the documents the index holds now, scoped by the sync's prefixes. It reads, then writes `suggestions` and `deps` rows; it takes no ledger lock and calls nothing over the network. `propagate` and the apply/dispose paths are unchanged.

**Citations become dependencies** (`src/lineage/page-deps.ts`). When a wiki page no generator owns is applied (`knode_write` then sync, or an edit on disk), one regular-expression pass finds every `raw/docs/…` and `raw/codebase/…` path in its text, body and frontmatter, with or without `#L…`. Each resolves to a document as written, without trailing punctuation, with `.md` added, or URL-decoded; `.sidecar/<original>/content.md` names its original. The page's doc scope writes one `deps` row per document (`artifact_kind: cites`, `input_kind: document`, `required: false`, the document's `sha256`), through the writer's `deps` effect, so replacing or removing the page restores or drops the set. The hash comes from the index when the document is there, otherwise from the file through `loadSourceText`. A sync walks `wiki/` before `raw/codebase/`, so this fallback is what makes a rebuild produce the same rows. A repository card is never a dependency: it is re-rendered on every commit. The commit each cited repository's card names is kept in the page scope's `meta.citedCommits`. A page applied before this existed is re-applied once (`meta.citeDeps`, as `CITATIONS_VERSION` does for citation rows); that re-apply is the backfill. No schema change was needed.

The rows use their own artifact kind, `cites`, rather than `page` as §5 first said. `propagate` acts only on `page` and `suggestion` artifacts, so it never touches them. Every other reader of `artifact_kind = 'page'` joins `pages`, so none of them changes. And `cites` leads the primary key, so the comparison reads citation rows alone and not the generated pages' inputs. `lineageOf` lists both kinds for a page.

**A re-apply of the same text keeps the baseline** (review, 2026-11-22). `applyDocScope` re-applies an unchanged page on `sync --reapply`, on a new embedding model and on a version bump (`CITATIONS_VERSION`, `CITE_DEPS_VERSION`, the mind-map planner). When the live scope's `sha` equals the new one, `carryCitationBaseline` keeps the recorded hash of every file the page still cites, keeps `meta.citedCommits`, and sets `meta.citedSince` to when the text last changed (the previous scope's own `citedSince`, else its `applied_at`). A page whose cited files changed therefore stays changed through such a re-apply, and its pending suggestion stays pending. Only a page whose text changed takes a new baseline. Same text gives the same chunk ids, so a re-apply embeds nothing again; the test checks that the `embeddings` count is unchanged.

**The suggestion.** Only a page whose frontmatter `actor` starts with `agent` gets one; a person's page gets the dependency rows and no suggestion, as `recommend.ts` already leaves human pages alone. A page gets one suggestion, the id `wikiSuggestionId('refresh', page)` that the entity signal also uses, so a page that both signals name still has one row. Per repository the reason reads `acme-tool：引用的 14 个文件中 3 个在 4f1c2ab 与 9d0e771 之间改变` ("3 of 14 cited files changed between 4f1c2ab and 9d0e771"). The old commit is the page's `repositories[].commit`, or `citedCommits` when the page has no such key; the new one is the card's. A removed file gives the reason `…被删除，页面可能在描述已经不存在的代码` ("removed; the page may describe code that no longer exists"), listed first, and a higher score. Documents under `raw/docs` are counted without commits. The payload carries the changed and removed paths, the commits and a fingerprint of the state. Nothing is filed while a refresh job for the page is queued, running or validating. A suggestion a person accepted or rejected is reopened only by a state with a different fingerprint, so a reject holds until another file changes. A pending suggestion whose page has been rewritten since (and is clean now) goes stale. Accepting it queues a `refresh` job with `payload.citations`. Its brief (`src/research/workspace.ts`) re-reads the state at run time and lists the changed and removed files, both commits and the steps below. The brief, not the template, carries those steps, because a workspace keeps the template files it was seeded with.

**The refresh job** re-checks only the statements that cite the listed files, moves a statement whose file was removed to its new place or out to "Not verified", leaves the rest, and sets `repositories[].commit` of each repository it re-verified to the mirror's commit (`REFRESH` in `src/research/templates.ts`).

**The audit.** `research.auditAfterUpdates` (default 30, `0` = off) counts the new versions of a cited repository's card applied since the page's text last changed (`citedSince`, else the scope's `applied_at`). A card version already applied before then does not count, so a re-apply of the card, or a return to an older commit, is no update. A daily follow makes that about a month without a rewrite. When the count reaches the setting, the page gets a suggestion even with no changed file, and its brief asks for the entry points to be listed again from scratch.

**Cost of the comparison, measured on the live finance index** (2026-11-22, with the user's permission). The connection was read-only (`default_transaction_read_only=on`, 60 s statement timeout) and ran SELECT and `EXPLAIN (ANALYZE, BUFFERS)` only, in schema `ws_finance_a8349022`. That schema holds 853,406 `deps` rows (664,039 page→claim, 115,599 page→document, 35,576 page→relation, the rest on suggestions), 70,793 documents and 28,028 `pages` rows. It has no `cites` rows yet.
- **The first version (65e9718)** read page→document rows before filtering out generated pages. It took 891 ms cold and 102 ms warm: a bitmap scan of 136,609 rows through `deps_input_idx`, an anti-join over `pages` and a hash join over every document. That would have run after every sync, which is why the rows got their own kind.
- **The current query, unscoped:** 2.9 ms today, with no `cites` rows. With the ~7,600 rows finance will hold, I ran the same query shape over 7,600 real page→document rows as a stand-in. It took 62 ms warm: a hash join that seq-scans all 70,793 documents (26 ms) plus the hash build. Forcing a nested loop with one index probe per row is slower (340 ms). `serve` runs an unscoped sync only once, at startup, over the whole workspace, so this is paid once per start.
- **Scoped syncs** are what `serve` runs on every change (the watcher, folder links, repository updates, research jobs):
  - A scoped sync that applied and removed nothing now skips the comparison.
  - A prefix that names a file is matched by equality, which uses the indexes: 6.5 ms on live finance (a BitmapOr of `deps_input_idx` and `deps_pkey`, then a `documents_path_idx` probe).
  - Only a folder prefix (a repository update, a folder link) filters the `cites` range with `starts_with`. Reading 7,600 rows of a key range took 22 ms on finance, and the `cites` range is contiguous. It costs 1.4 ms in the PGlite benchmark below.
- **Synthetic PGlite at the same scale** (7,589 `cites` rows, 500,000 `page` rows, 30,000 documents, 20,000 `pages` rows): unscoped 7.6 ms, 9.6 ms with one page's 3 files changed, 13 ms with the audit; one repository 1.4 ms, one file 0.4 ms.

Restructurings, in place of an index:
- The rows have their own kind, so the comparison never reads generated pages' inputs.
- The check that a page has not become a view runs only on the pages that differ, not as an anti-join over `pages`.
- Prefixes use one `starts_with` per folder prefix and equality for files, not `unnest`.
- A scoped sync with no applies or removals skips the comparison.

No index or migration is needed: every scoped shape already uses an existing index or a short range.

**The one-time backfill on finance.** 271 wiki pages are sources whose indexed text names a raw path. 153 of them are `wiki/sources/by-folder/…/index.md` shelf listings, reserved index files that stage 3 neither re-applies nor gives rows. That leaves 118 pages: the 115 agent pages (63 `wiki/research`, 40 `wiki/concepts`, 7 `wiki/entities`, 5 `wiki/timelines`) plus `overview.md`, `purpose.md` and `schema.md`. They would hold 7,497 citation rows, at most 242 on one page, and 60 of their citations resolve to nothing. The re-apply re-embeds nothing: same text gives the same chunk ids, and finance embeds deferred anyway.

**Limits.** A rebuild drops the index, so every page's baseline becomes the files as they are then; a change no sync had filed before the rebuild is no longer seen. The first backfill has the same property: a page applied before this stage starts clean against today's files and mirrors, whatever commit it was written from, unless its frontmatter `repositories[].commit` names that commit (then the reason still names it, but which files changed in between is not known). A cited path is cut at whitespace or at a full-width bracket, quote or separator (`（）`, `，`, `；`, `、`), so a file whose name contains one of those ends up unresolved. A file a page cites that was already gone when the page was applied cannot become a row. Measured read-only on agent-atlas: of 49 research pages, all 49 get rows (2,080 rows, 721 on repository files). 2,509 distinct citation spellings reduce to 2,080 documents, 28 card citations and about 370 duplicates differing only in trailing punctuation. 31 resolve to nothing: 16 folders, 11 abbreviated as `raw/codebase/<repo>/…`, and 4 files the mirrors no longer hold. Those 4 are statements already out of date that no dependency can flag.

## 6. The index and the reading order (stage 2)

**Index.** A generated page `wiki/code/index.md` (a navigation generator with document inputs, `src/wiki/nav-views.ts`): per repository, one line per behaviour page with its title, aliases and first sentence. The card stays as it is; it is rendered from the commit alone and must not depend on the wiki.

**Order**, written into the workspace `AGENTS.md` by Init and into the evaluation brief for arms C and D:

1. Read `wiki/code/index.md`. Pick the behaviours the request touches by title and aliases.
2. Read each picked page whole. Follow `depends_on` only where the request reaches that far.
3. Open the cited files and confirm what the page says against them. The page is a map; the files are the fact.
4. Stop when every part of the request has a confirmed place. If the index names nothing relevant, say so and search the tree directly.

## 7. What the report adds

- **Coverage split.** After a build, a task is `covered` when some behaviour page cites at least one of its gold files. Computed with no model and reported per arm. C − A on uncovered tasks should be near zero (a control); on covered tasks it is the value of a page; the share covered is the reach of production.
- **Use.** From the recorded commands: the share of C and D sessions that opened the index, and that opened a covering page. A covered task answered wrong without the page opened is a reading-order failure; with it opened, a page-quality failure.
- **Strata.** Every figure by `named`, `symbol` and `plain`.
- **Cost.** Build cost of the pages (model tokens per repository) beside tokens per correct answer, as in design 33.

Declared comparisons, paired and Holm-corrected: C − A overall, C − A on `plain`, C − A on covered, D − C.

## 8. Stages and what each costs

| Stage | What | Model spend | Needs the user's word |
| --- | --- | --- | --- |
| 0 | Recipe, two repositories, grepability measure | none | cloning history (a download) |
| 1 | `agent-grep` on 120 `plain` tasks | about 120 sessions | yes |
| 2 | Behaviour study on the two repositories, index, reading order, arms A–D on the same tasks | about 50 page jobs, then about 480 sessions | yes; choose the effort before starting (the 2026-11-09 studies spent a five-hour window in ten minutes at xhigh) |
| 3 | Citation dependencies and refresh suggestions | none to build | no |
| 4 | Update test: move the base forward 100 commits, refresh, re-ask the tasks whose gold changed | refresh jobs plus sessions | yes |

Stage 3 does not depend on stages 1 and 2 passing: it is worth having for the research pages agent-atlas already holds.

## 9. Not doing

- **Scoring generated code.** LiveX's main test grades code against a reference on four qualities with an evaluator. That needs either test execution or a judge on code, and their own article lists unstable scores as an open problem.
- **Person-owned boundaries outside code.** A person accepting a list of 20 behaviours per repository is affordable. The same for a document workspace with 1.47 million claims is not.
- **Git branches and review for pages.** Quarantine and promotion already put a person between an agent's page and trusted knowledge, and the ledger records every change.
- **A symbol index.** Still not built (design 25). If stage 1 shows `symbol` tasks are easy and `plain` ones hard, it stays unneeded.

## 10. Open questions

1. Is a commit message a fair stand-in for a requirement? It is written after the change and may describe the solution. Stage 0 shows how often: the `named` and `symbol` shares.
2. One base commit per repository keeps the build count at one, but later tasks apply to a tree that has moved. The 300-commit window is a guess; stage 0 should report F1 of the gold against the base tree by distance.
3. Should a behaviour page span repositories? LiveX's do, because one team's feature crosses client and server. The agent-atlas repositories are independent projects, so the first version is one repository per page, and `repositories` is a list for later.
4. Does the reading order help or only add steps on tasks where the index names nothing? The coverage split answers it.
