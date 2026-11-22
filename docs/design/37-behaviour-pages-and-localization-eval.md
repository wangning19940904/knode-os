# 37 — Behaviour pages for code, kept true by diffs, and an evaluation that asks where a change lands

Status: stage 0 built and stage 1 run (2026-11-22, branch `claude/localization-eval-a7f48b`): the gate failed — `agent-grep` scores mean F1 0.859 on 60 `plain` codex tasks, 3 under 0.5 (§11) — so stages 2 and 4 were not built. On 2026-11-22 the user chose to stop the evaluation here: stages 2 and 4 are not built, and no issue-based or redacted pack is planned. Stage 3 was finished separately on `claude/citation-deps-refresh-827c12` (tip 7746831). Number 36 is `36-evaluation-protocol.md`, on the same branch line, not on main yet.

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

## 11. Results

Run folder `~/knode-eval/runs/localization-20261122/` (`run.sh`, `status.sh`, `analyze.py`, `ESTIMATES.md`, `stages.log`; `stage0/` holds the drift measure). Frozen build `~/knode-eval/builds/bfe036ce70` (commit bfe036c).

### Stage 0 — the pack (2026-11-22, no model)

Built: the `code-localization` recipe (`src/eval/packs/code-localization.ts`, tests in `tests/eval-code-localization.test.ts`). Decisions the record left open, as built:

- **Base and tip.** The tip is the clone's `origin/HEAD` as fetched; the base is the commit `window` (300) first-parent commits before it, the latest that leaves a full window. Both are recorded in `pack.json`, so the same options build the same pack.
- **Kept files.** A touched path counts when design 25's path rules keep it; every such path must exist in the base tree, and the gold is those of them in the corpus (a file at the base that `planCodebase` leaves out as too large or generated cannot be named from the corpus). Rename detection is off (`--no-renames`): it would fetch blobs, and a rename is a delete plus a file created after the base, which the filter rejects anyway.
- **Source file.** A code language (not prose or configuration) outside test paths (`tests/`, `__tests__`, `*_test.rs`, `*.test.ts` …). Test files touched by the commit stay in the gold.
- **Strata.** `named`: the message holds a gold path, or a gold basename not inside a longer path or word. `symbol`: the message holds a name `extractSymbols` finds in a gold file at the base, when the name is at least four characters and either identifier-shaped (an underscore, a digit, or a capital after the first letter) or written as code (inside a backtick span, before `(` or `::`). A one-word lower-case name (`panel`, `session`) found in prose is an English word and does not count; nor does any three-character name (`new`, `run`).
- **The question** is the message unchanged inside one fixed frame: "You have the code repository openai-codex as it was on 2026-11-17. A change to it was later described by the commit message below. Which existing files of the repository does that change modify?" The list rules ask for paths relative to the repository root, at most 20 items, matched by alias (a predicted label holding the gold path as a whole term, so `codebase/openai-codex/x.rs` and `./x.rs` both match `x.rs`'s full path) and scored by set F1.
- **The leak rule on dates** is `pack.json` `cutoff` (the base's commit date): `validatePack` refuses a corpus document dated later, and a knode build's leak check after staging refuses a `raw/` Markdown file whose frontmatter `date` is later.
- **Harness.** `eval run --strata plain` keeps the tasks of named strata; on a pack whose corpus is one `codebase/<repo>/`, `agent-grep` runs in the repository's own tree with the sentence "The current directory is the code repository openai-codex: its files as of one commit, without git history."

| | `openai-codex` | `anomalyco-opencode` |
| --- | --- | --- |
| base → tip | 9a5a78925d55 (2026-11-17 05:52Z) → d4014cb19d23 (2026-11-21) | 5db3553efa5d (2026-11-17 17:37Z) → d03cb4a02420 (2026-11-21) |
| files at the base / kept | 10,410 / 8,194 (109 MB) | 11,537 / 8,378 |
| commits in the window → tasks | 300 → 126 | 300 → 1 |
| named · symbol · plain | 0 · 32 · 94 | 0 · 0 · 1 |
| rejected | too many kept files 68, a file created after the base 64, too few kept files 33, no source file 7, release 1, dependency 1 | short body 297, too many kept files 2 |

**opencode does not serve.** Its pull requests are squash-merged with the title alone: 297 of the 300 commits have no body of 80 characters, and only 121 of its last 3,000 do. No base gives it 60 tasks.

**Open question 1 (does the message give the answer away?).** On codex, rarely by name: no message names a gold path or basename, a quarter (32 of 126) name an identifier a gold file defines. The messages are long (median 770 characters, a "What changed / Testing" template) and written in behaviour words with configuration keys in code spans. They do describe the solution ("Escape installation directories in the generated `PATH` export"), and a description of the tests is often there, which points at test files.

**Gold.** On `plain`, 2 to 15 files (median 5, mean 5.8; 21 tasks of 2 files, 21 of 9 or more); 60% of the gold files are source, 36% are tests.

**Grepability** (`eval pack grepability`, terms from the message without the frame):

| stratum | n | every gold file holds a rare message term | first gold file does | BM25 top 10 holds every gold file | holds the first |
| --- | --- | --- | --- | --- | --- |
| plain | 94 | 93% | 99% | 2% | 18% |
| symbol | 32 | 78% | 94% | 3% | 25% |

The first two columns say little here: a 770-character message has dozens of words found in at most 5% of 8,194 files, so almost any file holds one. The ranking columns are the informative ones: a lexical ranking of whole files puts the complete gold in its top ten for 2 of 94 `plain` tasks.

**Open question 2 (gold against the base tree by distance).** For every first-parent commit after a base, the share of its kept touched files that exist at the base (the recall, and F1 with precision 1, of "the files at the base" as an answer), by distance; trees only (`stage0/drift.mts`, base = tip~1200, no blobs fetched):

| commits after the base | codex: share at base · all at base · F1 | opencode: share · all · F1 |
| --- | --- | --- |
| 1–100 | 0.93 · 0.69 · 0.96 | 0.79 · 0.39 · 0.89 |
| 101–200 | 0.86 · 0.52 · 0.92 | 0.57 · 0.08 · 0.73 |
| 201–300 | 0.87 · 0.48 · 0.93 | 0.64 · 0.36 · 0.78 |
| 301–400 | 0.85 · 0.49 · 0.92 | 0.48 · 0.38 · 0.64 |
| 401–600 | 0.81–0.92 · 0.48–0.58 | 0.55–0.66 · 0.35–0.51 |
| 601–1,200 | 0.80–0.88 · 0.43–0.49 · 0.89–0.93 | 0.50–0.70 · 0.23–0.49 · 0.67–0.83 |

On codex the tree holds up: after the first hundred commits the share settles near 0.85 and does not keep falling, so the 300-commit window costs few tasks to drift (64 of 300 rejected for a file created after the base, most of them new test files). opencode moves faster (a large refactor 100–200 commits after its base). Within a 300-commit window on codex, task F1 by distance is reported with stage 1.

### Stage 1 — the gate (2026-11-22): failed; stage 2 not built

`agent-grep` alone, budget 20, on 60 `plain` tasks of `code-localization-openai-codex` (`--strata plain --agent-limit 60 --seed 0`), answers `spacex-aiops/gpt-6.1-sol` on the remote pool (all 60 served by workers), run directory `stage1/code-localization-openai-codex`, 09:22 to 09:35. Estimate written before it ran: 60 sessions of the record's 120 (`ESTIMATES.md`); spent 60 sessions, about 6.1M weighted tokens, no judge call (set scoring by path, model-free), no build, no embedding. A two-task pilot (`pilot/`) ran first.

| | value |
| --- | --- |
| mean F1 | **0.859** (95% CI 0.816 to 0.897) |
| tasks under 0.5 | **3 of 60 (5%)** |
| F1 = 1 | 24 of 60 |
| precision · recall | 0.892 · 0.856 |
| commands an answer · weighted tokens an answer | 9.7 · 101,026 |
| empty, capped, errors, leaked | 0, 0, 0, 0 |

| | n | F1 |
| --- | --- | --- |
| 2 gold files | 14 | 0.905 |
| 3–4 | 18 | 0.883 |
| 5–8 | 20 | 0.826 |
| 9–15 | 8 | 0.805 |
| commits 1–100 after the base | 19 | 0.922 |
| 101–200 | 22 | 0.805 |
| 201–300 | 19 | 0.857 |

**The gate: mean F1 under 0.7 and at least a third of tasks under 0.5. Both fail by a wide margin** (0.859; 5%). By §2 the pack does not separate, so behaviour pages (§3, §4, §6, §7) were not built and arms B–D did not run. Stage 4 needs stage 2's pages and did not run either.

What was checked by reading, without a model:

- **Scoring is clean.** All 253 matched pairs are the gold path itself, written from the repository root; no match came from one path holding another. Precision is below 1 on 22 answers, each an extra file named (usually a neighbouring test or a sibling module).
- **It is search, not memory.** 252 of the 253 correctly named gold paths appear in the session's own commands, the heads of their outputs, or the files it touched. The PRs are dated 2026-11-17 to 2026-11-21.
- **Why grep finds the files.** `plain` excludes names a gold file *defines*, but a codex message carries the strings the code *uses*: configuration keys, event and method names, flags, error texts, in code spans. Of the 94 `plain` messages, 61 have a code span of four characters or more, and in 46 of them a span occurs verbatim in a gold file (`features.guardianv3.message_board_in_memory`, `server/discover`, `lsof`). The first command of 24 of the 60 sessions already lists a gold path in the first 2,000 characters of its output. The agents then follow callers and the matching `_tests.rs` files, which is how they reach test files the message never names.
- **The three tasks under 0.5** (0.40 to 0.47) are partly right, not lost: 4 of 13 files for a rollout-budget change, 6 of 8 with 5 extras for a Guardian message board, 1 of 2 for a queued-message fix.

**Held back.** The other 34 `plain` codex tasks (94 in all, not 100) are unasked: they become the rest of the gate sample if the gate is to rest on codex alone. For all 94 to pass the gate, those 34 would need a mean F1 under 0.42 with 29 of them under 0.5.

**The second repository did not run.** opencode yields one task (its squash commits have no bodies). The user then approved one more clone, google-gemini/gemini-cli (`~/knode-eval/sources/git/google-gemini-gemini-cli`, 22 MB): it yields none. Its 300-commit window reaches back from 2026-11-20 to 2026-08-05 (base 761f604c1675; 2,449 kept files), and 285 of the 300 commits have no body of 80 characters once trailers are removed; the 15 that do are 13 releases and 2 dependency bumps. Of its last 3,000 commits, 318 have 80 characters of body counting `Co-authored-by` trailers. The fallback (openai-agents-python) was not cloned: it needs the user's word again. Whatever the second repository, it would not change the decision: for the pooled 120 tasks to pass, the second repository's 60 would need a mean F1 under 0.54 with 37 of them under 0.5, against 0.86 and 3 here with the same model and harness.

**What this says about the design.** On a repository whose change requests are written by its own engineers, grep is not the weak arm: the request already holds the code's words, as every question of the protocol-36 packs did. Behaviour pages would be built on the guess §2 warned against. A test that could still show their value needs requests that do not carry the code's strings: a user's report or a product requirement (an issue body written before the change, not the commit message written after it), or the message with its code spans removed. Either is a new pack, not a rerun of this one: the issue route needs a download and a link from each commit to its issue; the redacted route rewrites the question, which §2 chose not to do.

**Stopped.** On 2026-11-22 the user chose to stop after the stage-1 gate failed. Stages 2 and 4 are not built, and no issue-based or redacted pack is planned. Stage 3 (keeping pages true by diffs, §5) was finished separately on `claude/citation-deps-refresh-827c12` (tip 7746831) and is not merged here.
