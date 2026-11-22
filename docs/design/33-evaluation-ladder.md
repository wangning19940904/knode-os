# 33 — The evaluation as a ladder: what search adds, what the wiki adds, what knode's tools add

> **Record status (2026-11-17): Stages 1–3 built; stages 4 and 5 not done.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §8. Stale here: "stages 3–5 are not" (stage 3 — format-tolerant scoring, `--judge-audit`, `--repeat-sample` — is built); the team names of §4 (city names, §11).

Status: design (2026-11-14); stage 1 (§10) and stage 2 (recipe v3, the families of §3, pack lint: §11) built 2026-11-15. Stages 3–5 are not.

## 0. Why

The separation benchmark (design 28) ran at 1× and 10× on 2026-11-14 (`~/knode-eval/runs/separation-2026-11`). What it showed, and why it cannot answer the question it was built for:

- **The arms do not isolate anything.** Six systems differ in several things at once: agent or single call, files or tools, sources or wiki. `agent-knode-wiki-sources` has everything `agent-grep` has plus the wiki and scored the same (0.89 against 0.90) — the one clean comparison in the set, found by accident.
- **Most questions cannot tell agents apart.** Of 261 questions at 10×, all four agents were fully right on 168 and none on 56. Only 37 (14%) discriminate. Each type has 18 questions, so a type's minimum detectable difference is 0.15–0.3.
- **The corpus suits grep.** 1,420 reports under 800 characters each, one folder per team with 44 files, the team's name in the folder name. 94% of questions name the division and 79% carry an exact name or id. The first grep hits a gold document in 81% of answers.
- **Artifacts moved the numbers.** A question prefix ("（第N事业部）") that occurs only in monthly summaries; claim dates exported without a year; `knode-ask`'s retrieval scored from a list that drops wiki hits; update questions that say "平台组" when ten divisions have one. Of the 67 answers `agent-grep` got less than right, most were scoring or format, not retrieval.
- **Tool outputs are not recorded**, so every diagnosis needed a replay.

The user's proposal, which this design adopts: compare four agent setups that each add one thing to the one before, and rebuild the questions and datasets around what each addition should buy.

## 1. Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | The headline is a ladder of four agent arms, each a superset of the one before | A paired difference between neighbours measures one addition |
| D2 | `knode-ask` and `rag-hybrid` leave the headline and become a single-call track | They are not comparable to agents, but `knode-ask` is the product's own answer path and the only place retrieval quality shows directly |
| D3 | `agent-knode` (tools, no files) and `agent-knode-wiki` (wiki, no sources) become optional diagnostics | Their questions are answered more cleanly by the ladder; each stays useful for one narrow question |
| D4 | Fewer question families, each aimed at one capability, with at least 60 questions | A family must be able to detect a difference of 0.1 |
| D5 | The same questions are asked at every corpus size | A scale curve needs like-for-like questions |
| D6 | Find the size where grep degrades with the cheap arms before paying for a knode build at that size | A knode build at 100× is about ten times the 10× build: roughly 55 hours of model time and $500 at API prices |
| D7 | Every pack passes a lint before it is run, and every answer records what its tools returned | Both would have caught or shortened today's diagnoses |

## 2. The arms

Same model, effort, question prompt, step budget and backend for all four. The brief differs only by the sentence that says what is available.

| Arm | Has | Id | State |
| --- | --- | --- | --- |
| A | shell over the raw sources | `agent-grep` | exists |
| B | A, plus one tool: `search(query, k)` over a plain chunk index of the sources (the `rag-hybrid` index: 1,200-character chunks, BM25 and bge-m3, fused) | `agent-rag` | new |
| C | A, plus the generated wiki as files beside the sources | `agent-knode-wiki-sources` | exists |
| D | C, plus knode's retrieval tools: `knode_search`, `knode_graph_search`, `knode_claims`, `knode_query`, `knode_resolve`, `knode_survey` | `agent-knode-full` | new |

D does not get `knode_grep`, `knode_read` or `knode_ls`: the shell does that, and leaving them out means every knode tool call in D is a use of something grep cannot do.

Comparisons, declared before a run (paired over the same questions, Holm-corrected):

| Difference | What it measures |
| --- | --- |
| B − A | semantic search over the sources |
| C − A | the wiki itself |
| D − C | knode's retrieval: hybrid search, graph, claims, SQL |
| D − A | the product as a whole |
| D − B | the product against an agent with plain RAG |

Each difference is reported for correctness and for cost (tokens, USD at API prices, latency, tool calls). A tie in correctness at lower cost is a result.

**Outside the ladder**

- **Single-call track:** `knode-ask` and `rag-hybrid`, with retrieval metrics scored from the contexts actually sent. Cheap (13 s and $0.04 a question), run on every pack as a regression check on the product's Ask.
- **Diagnostics, off by default:** `agent-knode` when the question is "what can an agent do through MCP alone, with no file access"; `agent-knode-wiki` when the question is "does the wiki alone hold the answer".
- **Reference:** `long-context` where the corpus fits a context window.

**Telemetry (all agent arms):** each tool call's output is kept, cut to its first 2,000 characters with the full length, beside the command. For D the report adds: calls per knode tool, and correctness of answers that used each tool against those that did not.

## 3. Question families

Each family targets one thing a compiled knowledge base should do better than search, or is a control. At least 60 questions per family per pack; controls 20.

| Family | What it asks | Who should win, and how |
| --- | --- | --- |
| Company-wide aggregates | counts, sums, rankings and filters across every team over a period ("which teams had three or more P1 incidents in Q2") | D through `knode_claims` or SQL; grep must read hundreds of files |
| Current state | a setting or metric as of a date, with corrections and a monthly summary that disagrees; the corpus states which source prevails | C and D, if the wiki compiles state; A must find every mention and apply the rule |
| Renames and aliases | an entity renamed once, then referred to only by the new name, a role or a nickname | C and D, if resolution works |
| Hops without shared words | three to five steps across teams where no step shares a keyword with the question | B and D |
| Timelines and diffs | ordered events for an entity; what changed between two weeks | D |
| Look-alikes and unanswerables | same-named people and settings in other teams; questions the corpus cannot answer | whoever does not merge them; abstention is scored |
| Update stream | state questions after each batch of new documents | measures staleness of C and D against A |
| Controls | exact lookup, paraphrase, cross-lingual | expected tie; a difference here means a harness fault |

The emergence suite (themes, planted connections) stays as it is.

Rules for every question:

- It names its team as the documents do ("七部平台组"), never by a qualifier the documents do not use. A third of the questions name no team: they identify their subject by a project, person or customer.
- Its gold is unique under the question's own words. A date convention the gold depends on is stated in the question.
- Exact ids appear in at most a third of the questions outside the controls.
- Division 1's questions are identical at every size (D5).

## 4. Datasets

**Synthetic reports, recipe v3** (`src/eval/packs/reports.ts`; gold from the script, no model):

- **Layout:** files by week, not by team (`周报/2025-W34/<hash>.md`), so the path says nothing about the team. `layout: "by-team"` keeps the old one for comparison.
- **Long documents:** quarterly reviews, incident postmortems and meeting minutes of 5,000–20,000 characters that carry facts found nowhere else, so a match is not the whole document.
- **More than one year:** two or three years of weeks, so a team has 100–150 reports and "latest" needs a date, not a sort of 44 files.
- **Sizes:** 1× (3 teams), 10× (30), 100× (300; the recipe already builds it: 14,200 documents, 8.4M characters).
- No question prefix; update questions name their team in full.

**Real documents:** two packs chosen for the longest documents and the least structure, from those already on disk (`~/knode-eval/packs`) or newly downloaded (the user approved downloading new corpora on 2026-11-15).

**Pack lint** (`eval pack lint <dir>`, run by `eval run` before anything is spent):

- a word of a question that occurs in only one class of document;
- a question whose gold is not unique among documents matching its qualifiers;
- a question answerable from file names alone;
- a family with fewer questions than its minimum;
- two questions with the same text and different gold.

## 5. Scoring and the report

- List answers are parsed tolerantly: an unclosed JSON array, "1,000" and "135万" for the same number.
- A sample of 5% of judge verdicts is judged twice; disagreements are listed.
- The report opens with the ladder table (five differences, correctness and cost, with each one's minimum detectable difference), then a discrimination table: questions every arm got right, none got right, and the rest.
- Per family: each arm's correctness and the neighbours' differences.
- Scale curve: correctness and cost per arm at each size, on division 1's questions.

## 6. Protocol

1. 1× and 10×: all four arms, the single-call track, 300 questions sampled by family. One backend, pinned by pool (design 32); the index on PostgreSQL (design 31).
2. 100×: arms A and B only. No knode build.
3. If A degrades at 100× (correctness, or cost per correct answer), build knode at 100× and run C and D. If it does not, the result is that this kind of corpus does not need a knowledge base at this size, and the next step is a different kind of corpus, not a larger one.
4. Sixty questions are answered three times by every arm, for run-to-run variance.

Cost at API prices, from the 10× run: an agent answer is $0.08–0.18, so four arms on 300 questions is about $150 per size; the knode build was $5 at 1× and $51 at 10×.

## 7. Stages

| Stage | What | Size | Depends on |
| --- | --- | --- | --- |
| 1 | Arms B and D, tool-output telemetry, the ladder and discrimination tables | small to medium | the evaluation artifact fixes (running, 2026-11-14) |
| 2 | Recipe v3, the families of §3, pack lint | medium to large | — |
| 3 | Scoring changes of §5 | small | — |
| 4 | Runs of §6 steps 1 and 2 | model time | stages 1–3; the entity-resolution and search fixes merged, or the run measures known defects |
| 5 | The 100× decision and, if taken, the build | large | stage 4 |

## 8. Decided by the user (2026-11-15)

- Arm B's index is the plain `rag-hybrid` one, not knode's own search over sources: B measures "any RAG", and D − C stays knode's retrieval alone.
- New corpora may be downloaded for the real-document packs.

## 9. Open items

- Whether the MCP-only diagnostic (`agent-knode`) is a deployment that matters: if agents reach a workspace only through `/mcp`, it belongs in the headline for that product path.
- Which real-document packs: two from those on disk, or new corpora chosen for long, unstructured documents.
- Whether the long documents and extra years should also go into the life recipe, whose documents cost model calls to write.

## 10. Stage 1 as built (2026-11-15)

`eval run --systems ladder` runs `agent-grep`, `agent-rag`, `agent-knode-wiki-sources`, `agent-knode-full`, `knode-ask` and `rag-hybrid` (`--systems single-call`: the last two). The default set no longer has `agent-knode` or `agent-knode-wiki`; both run when named.

**Arm B, `agent-rag`** (`src/eval/systems/rag.ts`). In the rag group, so it shares `rag-hybrid`'s build, and builds it itself when `rag-hybrid` is not in the run. Its one tool, `search(query, k)` (k 8 by default, at most 20), is the hybrid ranking `rag-hybrid` answers from, returned as JSON: each hit's document path (as in the agent's folder), the 1,200-character passage and its RRF score. The run serves it over loopback HTTP behind a per-host secret (`startServedTools`, `src/eval/toolhost.ts`), as it serves knode's tools, so a worker's session reaches it through `serve`'s lease-bound route unchanged. The MCP server is named `knode`, as every evaluation session's is on a worker. Query embeddings are metered under `agent-rag` without a task, so an answer's own usage leaves them out (on a local bge-m3 they cost nothing).

**Arm D, `agent-knode-full`** (`src/eval/systems/knode.ts`). Arm C's folder (`wiki/` and `raw/docs/`, where the pages' links point) and the six tools of §2, on the shared knode build. A build now keeps one tool host per tool set, so the host serves D only its six; `serve`'s route refuses anything else from a worker's session. Its guide is `questionKindGuide` with grep and reading done in the shell, then the catalog schema, without the catalog guide's pointer to `knode_datasources` (a tool D does not have).

**Briefs.** One skeleton (`armBrief`, `src/eval/systems/agents.ts`): the existing agent brief, with each arm's "what you have" in its place and D's guide after it. Arm A asks exactly as in the 2026-11 runs. Arms C and D did until 2026-11-21: their sentence now names `wiki/index.md` and `wiki/sources/` by their paths, because "start from its index.md" sent 630 of 843 arm D sessions of the 2026-11 campaign to a failing `cat index.md` first; answers of C and D from before that date were asked in the earlier words. `src/eval/systems/briefs.ts` lists the four; `tests/eval-briefs.test.ts` shows them side by side, and `tests/eval-ladder.test.ts` checks every prompt the arms' sessions got is that brief and the question.

**Telemetry.** An answer record's `outputs` is entry for entry with `commands`: `{ text, chars, failed? }`, the first 2,000 characters of what the command or tool call returned and the full length, or null where nothing came back. It is read from Codex's `item.completed` events (a command's `aggregated_output`; an MCP call's text content, else its structured content, else its error), paired with the start by item id, else by kind in order. A worker sends a longer output cut to that head with `knode_output_chars`, so `serve` keeps less per lease; an older worker's whole outputs are read the same way, and records without `outputs` report as before.

**Report** (`src/eval/report.ts`), first after the run's facts:

- *The ladder*: the five differences of §2 for which the run answered with both arms, paired over the questions both were scored on (first answers; all packs pooled, a question per pack and task). Correctness, weighted tokens, USD at API prices, latency and tool calls each get Δ, a paired-bootstrap interval and p, the MDE (α 0.05, power 0.8, unadjusted) and significance after Holm across the rows shown, metric by metric.
- *Which questions tell the agents apart*: over the questions every agent system of the run was scored on, all fully right (correctness 1), none fully right, and the rest, overall and per task type. On run-10x's records this gives 168, 56 and 37 of 261, the figures of §0.
- USD and tokens per correct answer beside correctness in each pack's answering table.
- *knode tools and correctness*, per pack and every agent that called knode's tools (D, and `agent-knode` when it runs): calls per tool, and mean correctness of the scored answers that called it against those that did not. Descriptive: the groups differ in their questions too.

Not shown without a model-backed run: whether agents use `search` or knode's tools much when grep is beside them, whether Codex's `item.completed` events carry outputs in exactly the fields read here (the reader tolerates missing ones, which leave `outputs` absent), and every number the ladder will report.

## 11. Stage 2 as built: recipe v3 and the pack lint (2026-11-15)

Code: `src/eval/packs/reports-v3.ts` (the script), `reports-v3-render.ts` (documents), `reports-v3-tasks.ts`
(families), `reports-v3-build.ts` (layout and pack), `src/eval/lint.ts`, `src/eval/grepability.ts`. Tests:
`tests/eval-reports-v3.test.ts`, `tests/eval-pack-lint.test.ts`.

**Building.** `knode-os eval pack build synthetic-reports-zh --options '{"version":3,"size":10}'` (also `en`;
`layout: "by-team"` for the old layout, `taskDivisions` for more divisions' own questions). Without `version` the
recipe builds the v2 pack of design 28 byte for byte; a test pins main's digests of v2's tasks, gold and corpus.
Packs: `synthetic-reports-{zh,en}-v3[-x10|-x100]`.

**The corpus.**

- 130 weeks, 2024-W01 … 2026-W26 (ISO weeks): weeks 1–122 the corpus (a team's 122 reports), 123–126 four update
  batches, 127–130 the holdout. A report counts in the month, quarter and year of its Monday, and every question whose
  gold depends on that says so.
- Files by week: `周报/2025-W34/<hash>.md`, `季度复盘/2025-Q2/`, `事故复盘/2025-04/`, `会议纪要/2025-04/`, `月报/2025-04/`
  (English: `weekly/`, `quarterly/`, `postmortems/`, `minutes/`, `monthly/`).
- Teams are named after their division's city ("杭州平台组", "Oslo Platform"). The design's "七部平台组" would put
  "一部平台组" inside "十一部平台组"; city names leave no team's name inside another's at 100 divisions.
- Long documents, 5,000–12,500 characters: a quarterly review per team and quarter (OKR score, budget execution,
  each project's sponsor and each hire's mentor are stated only here; counts, launches and moves repeated in other
  words; the week-by-week table as the PMO checked it), a postmortem per P1 (duration, impact, how it was found and
  the owner of the follow-up only here), the division's monthly minutes (budgets approved, a customer's new name, some
  nicknames, actions owned by nickname).
- Precedence: every PMO summary opens by saying its figures are checked and prevail over the weekly reports, and it
  corrects four weekly figures a team and one setting a team. A correction (a team's or the PMO's) says the earlier
  value was wrong: the state as of a date between the two is the corrected one. State questions say so, and name the
  PMO's precedence only where the PMO decides the gold (a clause naming it everywhere was a one-class word, below).
- Renames (two projects a team, one customer a division) and nicknames (three people a team) are stated once, then the
  new name or the nickname is used alone in the documents that follow; a mentor or a follow-up owner is often given by
  nickname only.
- Divisions are drawn in order from one stream and customers belong to their division, so the first division — its
  documents and its questions — is the same at 1×, 10× and 100× (tested). From 3×, someone of each team of divisions 2
  and 3 (4 and 5 …) moves to the other division late and takes over a project there; division 1 is never linked.

**The questions.** By default only the first division's own questions (D5), plus, from 10×, company-wide aggregates
(`co-`) and, from 3×, hops that cross divisions (`x-`). Families are `meta.family`; the minimums are in the manifest
(`lint.families`, `lint.strata`) so the lint checks them.

| Family | Type | What is asked |
| --- | --- | --- |
| aggregate | structured | per quarter and year over the three teams: incidents, P1s, escalations, the team with most, teams with P1s, P1 minutes (postmortems), headcount at quarter end; hires, departures, moves, top fixer, repeat escalators, yearly means |
| current-state | stale | a setting as of dates between its changes and at the end, by its first name (later changes use its code or short alias); a weekly figure the PMO corrected |
| alias | alias | old project and customer names, nicknames, short aliases, the lead by role and date |
| hop | deep-hop | 3–7 documents (§ below) |
| timeline | timeline | a project's milestones, a risk's life, a setting's values with corrections, what changed between two weeks of a team |
| lookalike | lookalike, unanswerable | namesakes in two teams, near-identical customers; questions no document answers (a person's OKR, a third namesake, a P1 that did not happen, another kind of team's setting, a P2's duration, a budget never approved, a customer that does not exist) |
| update | update | after each batch: latest figure, headcount, a setting changed (and corrected) in the stream, progress, open risks, the newest incident |
| controls | single-hop, paraphrase, cross-lingual | 24 each |

Hops, as decided here where the design left room:

- A step is a document. A chain's steps are the documents that state each link (`fix:`, `takeover:`, `sponsor:`,
  `mentor:` … lines), and no document may state two steps, so none can be skipped. Where a document names a bridge by
  another name (a nickname, a project's or customer's other name), the document that maps the names is a step of its
  own. `meta.hops` is the number of documents, `meta.stratum` `h3`…`h7`, `meta.chain` the links, `meta.bridges` the
  entities passed through, `meta.anchor` how the first one is named.
- No word of the question is on any step's line, beyond the anchor's own name. Anchors are either named (a nickname,
  a project's first name) or described in words no document uses: an incident by its team's job, its year and its rank
  among the top-severity ones, in a division described by where it sits ("西湖边办公的那几个组里，管收款的那个组在2025年
  出的第1起最严重一档的故障"), a customer by its business. Those questions name no team — the one family that does not
  name its team as the documents do, since naming it would be a shared word.
- Entities are labelled (甲乙丙…, A B C…) so a seven-link question stays unambiguous.

**The pack lint** (`knode-os eval pack lint <dirs...>`; `eval run` runs it on its packs first and stops unless
`--no-lint`): one-class words, ambiguous subjects (against the alias gold), file-name answers (a path segment, or the
file count of a folder the question names), family and stratum minimums, duplicate questions with different gold, hop
shortcuts (the answer on one line beside a question word held by at most 0.5% of documents). Chinese "words" are
two-character sequences without a function character (的, 一, 个, 起 …): "起事" of "几起事故" is no word anyone
searches for. On the v2 10× pack the 2026-11-14 run used, the lint finds 1,679 questions with the PMO-only "事业部"
prefix and 74 that say "平台组" where ten teams have that name — the two artifacts §0 names.

**Grep-ability** (`knode-os eval pack grepability <dirs...>`, no model): per family, the share of questions whose gold
documents all hold a literal term of the question (a word, a name of the alias gold, or an id held by at most 5% of
documents), the share whose first-step document does, and the same two for the ten documents a BM25 search on the
question ranks first. Any question that names its team reaches that team's reports by the team's name, so the
literal-term shares change little where the rules require naming the team; the BM25 columns and the hop rows are where
v3 differs.

**The packs built (2026-11-15, seed 0), all lint-clean:**

| Pack | Documents | Characters | Questions | Hops h3 / h4 / h5 / h6 / h7 |
| --- | --- | --- | --- | --- |
| `synthetic-reports-zh-v3` | 473 (366 weekly, 28 PMO, 28 minutes, 27 quarterly, 24 postmortems) | 0.88M | 564 | 10 / 14 / 24 / 24 / 24 |
| `synthetic-reports-en-v3` | 473 | 1.15M | 567 | 10 / 14 / 24 / 24 / 24 |
| `synthetic-reports-zh-v3-x10` | 4,730 | 8.7M | 607 | 10 / 17 / 30 / 30 / 30 (21 cross-division) |
| `synthetic-reports-zh-v3-x100` | 47,300 | 88.4M | 607 | as 10× |

Per family at 1× (zh): aggregate 71, current-state 66, alias 69, hop 96, timeline 70, lookalike 60 (47 of them
unanswerable), update 60, each control 24; 10× and 100× add 22 company-wide aggregates.

**Grep-ability at 10× (zh)**, the share of questions whose gold documents all / whose first-step document hold a
rare literal term, then whose gold documents all / first-step document BM25 ranks in its top 10. "v2" is the current
v2 recipe built afresh (the pack the 2026-11-14 run used still has the PMO-only prefix, which sends BM25 to the
monthly summaries: 0% almost everywhere).

| Family | v2 10× | v3 10× |
| --- | --- | --- |
| aggregate | 61% · 62% · 1% · 7% | 76% · 76% · 0% · 6% |
| current-state | 90% · 92% · 0% · 84% | 100% · 100% · 0% · 32% |
| alias | — | 49% · 100% · 28% · 52% |
| hop | 2% · 35% · 0% · 8% | 0% · 21% · 0% · 3% |
| timeline | 97% · 97% · 3% · 12% | 91% · 100% · 1% · 40% |
| lookalike (answerable ones) | 54% · 72% · 38% · 48% | 77% · 77% · 31% · 38% |

v3 is harder to look up where it was built to be — the hops and the current state behind corrections — and is not
harder on aggregates (neither pack's gold is reachable by one search) or timelines (v3 names its project, and the
project's start is one search away).

**Not done.** No model has answered a v3 question; the gold is checked by tests against the script, the hop chains by
hand on samples. English 3× and 10× packs have few cross-division hops (the English script's people are busy until
late, so few can move). The life recipe has neither the long documents nor the extra years (§9).
