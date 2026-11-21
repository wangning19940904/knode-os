# 23 — Knowledge benchmarks: comparing knowledge-base approaches on the same sources

> **Record status (2026-11-17): Built, then largely replaced by 27 §8, 28, 31, 32, 33, 35.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §8. Do not use as the evaluation reference. Stale here: the system list, serial answering, `--offer-seconds`, the PGlite evaluation workspace, the recipe list. §7 is a run log.

> Status: **implemented** (2026‑11‑04); pilot run 2026‑11‑06. Corpus-level tasks, wiki-with-sources agents, scale padding,
> the update stream and cost-normalized reporting added 2026‑11‑07 (§2.1, §4); their run is in §7 (phase 2 and the 3× scale point done 2026‑11‑08; the 1× API answers redone on Codex 2026‑11‑09). `src/eval/` (packs, shim, meter, quota, agent runner, judge,
> metrics, systems, runner, report, audit, install), `eval/adapters/*.py`; `knode-os eval pack list|build|validate`,
> `knode-os eval systems list|install`, `knode-os eval run`, `knode-os eval report`, `knode-os eval audit export|import`.
> Data lives outside the repository in `~/knode-eval/` (`$KNODE_EVAL_HOME`): `sources/` (downloads), `packs/`,
> `runs/`, `venvs/`. Tests: `tests/eval-suite.test.ts`.

## 0. What was there

knode-os had `knode-os bench` (src/bench): build timing, synthetic single-chunk QA, retrieval recall and a judged
answer score — on one workspace, against itself. Nothing compared knode with another way of building or using a
knowledge base, and nothing measured what it *generates* or what it can *infer*.

Outside, as of 2026‑11 there is no benchmark for "LLM Wiki" knowledge bases (Karpathy's April 2026 pattern of a wiki
an LLM maintains instead of retrieving afresh). There are pieces:

- Graph RAG: GraphRAG-Bench, WildGraphBench and BenchmarkQED. Their win-rate comparisons are fragile: a debiased re-run took LightRAG's 66.7% over naive RAG to 39.1%.
- Cited article writing: FreshWiki/STORM and Wiki Live Challenge.
- KG fact coverage: MINE.
- Corpus-level synthesis: DeepSynth, CorpusQA, iAgentBench.
- Multi-hop retrieval: HippoRAG 2's protocol on MuSiQue / 2Wiki / HotpotQA.
- Practitioner claims, e.g. "a wiki beats RAG at ~100 articles / 400K words".

None gives several knowledge-base builders the same sources and scores what each built, how well each is used and
at what cost. None scores emergence either: an author's style, a field's open problems, a person's mood or needs.
The 2026‑11‑03 read-only audit of the finance workspace (claims 92% supported, 29% cited the right chunk; summary
pages 98% faithful) showed what such a benchmark can find.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Packs are portable directories | `pack.json`, `corpus/`, `holdout/`, `gold/{facts,links,aliases}.jsonl`, `gold/profile.json`, `tasks/*.jsonl`, `updates/NN/`, validated by zod schemas and `validatePack`. They live in `~/knode-eval/packs`, never in the repo | Packs hold downloaded third-party text and a private finance slice. A pack can be rebuilt from its recipe, and its manifest lists every source with license and sha256 |
| D2 Nothing a system reads sits beside the gold | `stageCorpus` copies the corpus to a fresh temp directory with nothing else in its parent. Agents get a fresh copy per question. Every command an agent runs is audited, and a path into `~/knode-eval` or the home directory voids the answer | Codex's read-only sandbox blocks writes, not reads. An agent in `packs/<id>/corpus` could `cat ../tasks/usage.jsonl` |
| D3 One model for every system, metered in one place | An OpenAI-compatible shim on 127.0.0.1 (OS-assigned port, alive only during a run) answers `/v1/chat/completions` from Codex (`codex exec` per call, fresh temp dir, `--json` usage) and `/v1/embeddings` from knode's embedder. knode workspaces under test, the RAG baselines and the external Python systems all point at it. The bearer token carries the meter tag `sys=…;stage=…;task=…`. Agent sessions run Codex directly and report their own `--json` usage | An in-process knode build records no usage (only `serve`'s broker writes the call ledger). Routing every system through one gateway makes model, effort and accounting identical, with no change to knode |
| D4 Survive minutes-long calls | Headers go out at once and whitespace follows every 20 s, which beats fetch's 300 s timeout. A failure after Codex spent tokens returns 200 with an error body, never a 5xx a client would retry. `tools` and `n>1` are refused with 400; `stream:true` gets one SSE chunk | A slow Codex call paid for twice would double a build's cost and hide it |
| D5 Resumable to the item | Builds, answers and scores are keyed JSONL records. The shim's reply cache and the judge's verdict cache are on disk, and replays are counted at their original cost, marked `replayed` | A pilot spans days of plan windows. A resumed run must neither redo work nor under-report it |
| D6 Same agent, different knowledge | The grep baseline, the agent with knode's MCP retrieval tools, the agent reading knode's generated wiki and the agent reading an LLM Wiki are one runner (`runAgent`) with a different folder or tool set. At most 25 commands, then `capped` | The question is what each knowledge source is worth to the same agent, not which agent harness is better |
| D7 LLM Wiki built faithfully | A schema file plus ingest sessions of ~3 sources in date order (Codex `workspace-write` in a temp dir with `raw/` and `wiki/`). Each session writes source, entity and concept pages, `index.md` and `log.md`. `agent-wiki` reads the wiki only; `agent-wiki-sources` (and `agent-knode-wiki-sources`) reads it with `raw/` beside it | Wiki-only measures what the wiki holds. In practice a wiki is a navigation layer over the sources, and that use is a separate system, not a relaxation of the first |
| D8 Blind, batched, cross-family judge | Claude Code judges Codex's answers, ≤8 items per call. Ids are opaque, system markers are stripped, and systems are shuffled within a batch. Gold-building and the oracle check use Claude too | A judge grading its own family's answers, or one that can tell systems apart, is not a judge. Batching keeps a pilot inside a plan |
| D9 Gold without a model where possible | Synthetic life is scored from its script. CUAD, EnronQA, FinanceBench, LongMemEval and MuSiQue bring their own answers. Law cross-references come from a regex. Style comes from stylometry (log-odds terms, profile directions). Model-drafted gold has an exact quote checked against its document, and an oracle check drops any task its evidence does not answer | Gold an oracle cannot recover is noise. A quote that is not in its document is a hallucinated fact |
| D10 Contamination is measured, not hoped away | Literature names are consistently renamed (map in the holdout), the research forecast uses a 2026 holdout, and a `closed-book` reference answers every task | Models have read the classics. A pack the model answers from memory measures memory |
| D11 Generated units only | `exportKnowledge` returns what a system generated (entities, relations, claims, pages, summaries, communities), never raw passages. Coverage is looked up within a fixed budget (6,000 characters, ≤10 units) by the same BM25 + bge-m3 retrievers for every system | A system that stores chunks would otherwise cover everything by definition, and a verbose one would win by size |
| D13 Corpus-level tasks are set-scored | `aggregate`, `timeline`, `contradiction` and `profile` tasks have evidence in ≥5 documents (`validatePack` refuses fewer) and gold that is a list: matched by alias or by cited documents without a model where the gold allows, by the judge otherwise; a count is checked as a number | The pilot's tasks were 1–2-document lookups (median 2 evidence documents), where a compiled wiki cannot help. The `global` type's 0/0.5/1 keypoint grade could not separate systems on the 43 tasks that needed 3+ documents |
| D14 Padding is closed-world checked | A pack may hold `padding/`, staged only above `--fraction 1`. A corpus-level task names its closed world (terms, path prefixes); `validatePack` refuses padding that contains a term or lies under a prefix | Scale curves need more of the same kind of source without changing the gold. A padding document that lists one more run, article or company would make the task wrong at 10× and right at 1× |
| D15 The update stream is cumulative and costed | Batches apply in order up to the last one a task asks after; every group's update is a build record (`<group>@NN`) and every answer after a batch carries it | "Latest state after each batch" means batch 03's answers see 01–03, and incremental cost is the wiki pattern's selling point |
| D16 Extend, do not rebuild | `eval pack extend` adds corpus-level tasks and padding to a built pack, leaving its corpus (and version) as it is; `eval run --reuse-builds-from` copies another run's builds of the same pack versions | finance-cn is a slice of a live workspace that has grown since; rebuilding it would re-sample it. The pilot's knode and LLM Wiki builds of finance-cn, research-ai and law-cn cost ~50M weighted tokens |
| D17 Cost is part of the result | Correctness per 1k query tokens, with the build spread over 100 and 1000 queries, and break-even per system against agent-grep | A wiki that is as correct as grep at a higher query cost and never pays back its build (the pilot's agent-wiki) has not added value |
| D18 Budgeted model chains, a local embedder first | Every model role takes a chain: `openai-api:200,codex-cli` for the systems (one-shot calls through the shim, agent sessions through Codex with the API key as a custom model provider, the key only in the child's environment), `anthropic-api:100,codex-cli` for the author and the judge. A paid link is priced from reported usage into one ledger all eval processes share (`~/knode-eval/spend.jsonl`, budgets in `budgets.json`) and passed over at 95% of its budget, or at once when the provider says the credit is gone. Embeddings go to a local bge-m3 (`eval/embed_server.py`, `--embedding-endpoint … --embedding-fallback`), checked against the pool's vectors, with the pool behind it | API money is finite and shared with other work; Codex's plan is the fallback. Systems stay on one model (gpt-6.1-sol on the API and on Codex), so a switch mid-run does not change who answers; the author and judge stay in another family (D8) |
| D12 A quota guard, not a hope | Before each batch `readCodexAccount()` reads Codex's windows (no model call). A run pauses above 92% (five-hour) or 90% (weekly) and resumes after the reset. A refused judge call sleeps and retries | On 2026‑11‑04 the weekly window was 72% used with five days to its reset, and the finance workspace's extraction uses the same plan |

## 2. Packs (`src/eval/packs/`)

| Recipe | Sources (license) | Gold and tasks |
| --- | --- | --- |
| `fixture` | Template-written (no network, no model) | Every task kind once, gold by construction. For tests and smoke runs |
| `synthetic-life-zh` / `-en` | A seeded hidden script rendered by Claude | Planted facts with exact phrases, aliases, links, weekly moods (never named), latent needs, holdout future, an update batch, an injection message |
| `literature-zh` / `-en` | Gutenberg: the four classics; Austen, Dickens, Twain (public domain), renamed | Plot QA, characteristic terms (precision@10), style directions, attribution of unseen passages |
| `research-ai` | arXiv cs.CL/AI/MA 2025-H2 (abstract, introduction, conclusion via arXiv HTML); 2026 holdout | QA; recurring open problems (≥2 papers each); next-half-year themes from the holdout |
| `law-cn` / `law-us` | twang2218/chinese-law-and-regulations; CUAD (CC BY 4.0) | Article QA, model-free cross-reference links, effective dates; CUAD clause answers |
| `medicine-us` / `-zh` | PubMed abstracts + openFDA labels (public domain); Huatuo encyclopedia QA (Apache-2.0) | Published QA where present, drafted QA otherwise |
| `finance-us` / `-cn` | FinanceBench open set (CC BY-NC); a frozen local slice of the `finance` workspace (private, never shared) | FinanceBench questions; drafted QA, view-vs-fact, temporal |
| `personal-email` / `-chat` / `-diary` | EnronQA (Dasovich mailbox); LongMemEval oracle (MIT); Pepys' diary (Gutenberg) | Published QA; memory types; drafted QA |
| `public-musique` / `-multihoprag` | HippoRAG 2 MuSiQue release; MultiHop-RAG (ODC-BY) | Published multi-hop questions with supporting passages, bridge links |

Every recipe ends in `finishDocpack`: write the documents, draft facts and tasks (`gold.ts`), add the recipe's own
model-free tasks, draft corpus-level tasks (§2.1), choose padding, validate.

### 2.1 Corpus-level tasks (2026‑11‑07)

| Type | Asks | Gold | Scored |
| --- | --- | --- | --- |
| `aggregate` | list (or count) every X across the corpus | every item, each with the documents that state it | set F1; a count by its number (`count` scoring) |
| `timeline` | how an entity's state, role or figures changed | items with dates, in order | F1 × pairwise order accuracy; date accuracy reported |
| `contradiction` | which sources disagree about X, and how | each side with the documents that take it | F1, a side counts only with one of its documents cited |
| `profile` | everything the corpus says about X | distinct facts with their documents | recall (drafted gold is a sample, not all there is) |
| `deep-hop` | a 3–4-fact chain whose bridges sit in different documents | the last fact's answer | judged 0–2 |

Where the gold comes from:

- **synthetic-life-zh/-en v2** (`life-ledger.ts`, no model): a seeded ledger on top of the script — about 21 runs with distances, ten weekly
  blood-pressure readings and a drug change, nine meals out at named restaurants, seven purchases with prices, five trips home, five book-club
  meetings, job milestones, four planted disagreements (which knee, the team's size, the book club's day, the partner's hometown: one side in
  four documents, the other in one), four chains of 3–4 hops, and an update stream of four batches (start date; race date; follow-up and drug;
  the race event and a project lead). Each event is rendered in a document of its own with an exact phrase. 41 corpus-level tasks, 4 deep hops,
  10 update tasks; a rendered document that adds a distance or a reading no event planted drops that series' tasks (checked by regex).
  `--options '{"padding":10}'` renders noise (newsletters, notices, other people's chats) that names nobody in the cast.
- **law-cn** (no model): which articles of a law mention a term (lists and counts over 5–25 articles in ≥5 chapters), the laws in order of
  commencement, and 3-hop chains through internal cross-references (A cites B, B cites C, each in another chapter). 38 tasks plus 4 chains;
  drafted profiles and contradictions on top. Padding: chapters of other national laws in force (a download).
- **finance-cn, research-ai** (`corpus-tasks.ts`, author model): entities clustered once and found in the documents by name (5–30 documents);
  every statement about them swept from excerpts, each with an exact quote checked against its document; profiles, timelines and contradictions
  assembled from those statements; aggregates proposed with keywords any qualifying document must contain, every such document read, so the
  gold is complete within that bound and padding without the keywords cannot change it; chains drawn from the fact graph, written with the
  bridges unnamed, kept by the oracle check. finance-cn's padding is more of the same workspace (local).
- **public-musique-deep**: `--options '{"minHops":3}'` keeps MuSiQue's 3- and 4-hop questions only, typed `deep-hop`.
- **research-ai, field-level emergence** (`researchEmergence`, drafted at `extend`): the field's main lines of work (each paper's approach named,
  grouped into lines of ≥3 papers: the backbone of a review, set-scored with ≥2 cited papers per item), the open problems the 2026 holdout
  papers actually advance (promising directions, decided by what came next, not by the author's opinion), and a structured review graded on
  keypoints covering both.

A sixth type, `ambiguous`, asks about a name that means two things (two people, a renamed project, a redefined metric): a list of readings, or
a judged answer whose keypoints include the ambiguity.

`knode-os eval pack extend <pack>` adds all of this to a pack already built (D16).

### 2.2 A year of weekly reports (`synthetic-reports-zh/-en`, 2026‑11‑07)

Three teams of one company write a report every week and a PMO sums them up every month, all rendered from a seeded script in templates
(no model, built in under a second at any size). The script decides people (hires, departures, transfers, a lead who steps down halfway),
projects (progress each week, planned and actual launch, a rename in week 20, owners taking over), incidents (severity, customer escalations,
root cause and fixer in the next week's postmortem), risks (raised, owned, handed over, closed months later), each team's metric (one
redefined in week 30), overtime, and how each lead writes (four styles). Most of each report is everyday work — members' work items, meeting
notes, customer feedback, next week's plan — that is gold for nothing: the haystack.

- weeks 1–44 are the corpus (≈140 documents, 74k characters in Chinese, 167k in English), 45–48 four update batches, 49–52 the holdout;
- 42 corpus-level tasks (every P1 of a team, every customer that escalated, every transfer, open risks, month-end figures, project progress,
  risk lifecycles, the PMO's disagreements with the teams, profiles of people and projects);
- deep hops: five-hop chains in five reports (a customer's escalation → the incident → its fixer → their transfer → the project they took
  over → its launch; a risk → who raised it → the escalated incident they fixed → the same customer's incident in another team → its fixer)
  and four-hop ones;
- ambiguity: two people named 陈伟 (Alex Chen) in two teams, Atlas renamed Orion, weekly active users redefined;
- traceback: when and by whom a risk was first raised, 6–20 weeks before it closed;
- emergence: each team's state per quarter (健康 / 吃紧 / 透支, never named, from overtime, P1s and departures), each lead's style (a gold list
  of its features), unsigned holdout excerpts with every name blanked to attribute, and which projects will miss their week after week 44
  (the holdout decides);
- scale: `--options '{"scale":10}'` adds other teams of the same company (disjoint names, projects and customers) as padding for
  `--fraction 10` — 0.8M characters in Chinese, 1.7M in English — so long-context falls out and grep has 30 teams' reports to search.

## 3. Systems (`src/eval/systems/`)

| id | Group (built once) | What answers |
| --- | --- | --- |
| `closed-book`, `long-context` | — | The model alone; the model with the whole corpus in its prompt (only where it fits) |
| `agent-grep` | — | A Codex agent in a copy of the sources, shell tools, read-only. **The baseline** |
| `rag-hybrid` (`rag-bm25`, `rag-vector` retrieval only) | `rag` | Top-8 chunks by BM25 (CJK bigrams) + bge-m3, RRF, one answer call |
| `knode-ask` (`knode-sag` retrieval only), `agent-knode`, `agent-knode-wiki` | `knode` | knode's `ask`; the agent with knode's MCP retrieval tools (`knode_search`, `knode_graph_search`, `knode_claims`, `knode_read`, `knode_grep`, `knode_ls`); the agent in the generated wiki |
| `agent-wiki` | `llm-wiki` | The agent in the LLM Wiki |
| `agent-wiki-sources`, `agent-knode-wiki-sources` | `llm-wiki`, `knode` | The same agent with the wiki and `raw/` side by side: the wiki as a navigation layer (D7) |
| `graphrag`, `lightrag`, `hipporag` | each | Their own query through `eval/adapters/<id>.py` (JSON lines), in a uv venv, by default on 3 packs (`KNODE_EVAL_EXTERNAL_PACKS`) |

The knode build is the one `serve` runs: `sync`, document passes until the queue and summaries are done (tier-1,
dedupe audits, summaries), `generateWiki`, `refineWiki`, then `sync` again so generated pages are searchable. The
index is on the product's backend (design 31 D1): a schema of its own per build in the evaluation database
(`knode_eval`, or `--database-url`) on PostgreSQL, an embedded database in the workspace on PGlite
(`KNODE_DATABASE_KIND=pglite`, the test suite). The run opens it once per build and everything shares that context:
answers run in parallel, and agent-knode's sessions call the build's tools on a host the run serves itself (31 D4).
Answers record no hits, so no question moves another's ranking (31 D3). Runs before 2026-11-14 were on PGlite with
knode-ask and agent-knode answering one task at a time.

## 4. Metrics (`src/eval/score/`, `src/eval/metrics/`)

Each suite has one pre-registered primary metric (in bold). The rest are reported descriptively.

**Generation.** Same sources, compare what each system built:
- **Coverage within budget**: share of gold facts recoverable from the KB.
- Precision: atomic claims sampled uniformly, judged against cited sources plus the top-5 corpus passages. Verdicts: supported, valid inference, unsupported, contradicted.
- Attribution precision.
- Link precision on a sample; link recall against model-free gold.
- Duplicate rate and over-merge rate against gold aliases.
- Contradiction rate between same-subject units.
- Structure: links per page, dangling links, orphan pages.
- Compression (unit chars / corpus chars).

**Use:**
- **Correctness** (judge 0–2 scaled to 0–1), keypoint recall, EM/F1 on the `Final answer:` line (CJK as characters).
- Citation precision/recall against task evidence; N/A for systems that do not cite.
- Abstention on unanswerable tasks, false refusals, truthfulness (+1 / 0 / −1), hallucination.
- Injection success.
- Retrieval Recall@k, All@5, MRR@10, nDCG@10 over multiple gold documents. `knode-ask` is ranked by what it sends its model
  (2026‑11‑14; before, by a search of its own that dropped every hit on a page made from several documents, while an answer's `retrieved`
  and citations took such a page for every document it cites): the documents of its prompt in the prompt's order, passages first, then
  the facts by the source each shows. A source chunk is its document; a chunk of a generated page is the documents the text sent cites
  by path, or the page's one document when it was made from one; a page chunk that cites none, and an index, the log or the overview,
  count for nothing. An answer's `retrieved` is the same list uncut, and a cited `[n]` the documents of the passage it numbers.
- Latency, tool calls, weighted tokens and USD per query.

**Use: corpus-level lists** (`score/lists.ts`). Every system answers the same JSON list (`label`, `date` for a timeline, `evidence`):
- match by `alias` (a gold name occurs in the predicted label; a number is not matched inside a longer one, `8公里` ≠ `18公里`), by `docs`
  (the item cites every document of the gold item), or by the judge (`LIST_MATCH_SYSTEM`: same name, number and date; a merged entry
  matches one gold entry);
- **correctness** = set F1, or recall for a profile, × order accuracy for a timeline — so lists enter the pooled comparison with the rest;
- set precision / recall, order accuracy, date accuracy, attribution recall (share of an item's documents cited), items returned.

**Cost-normalized** (report "Correctness for its cost"): correctness per 1k weighted query tokens; the same with the build's weighted tokens
spread over 100 and 1000 queries; break-even queries per answering system against agent-grep (a system that costs more per query never
breaks even). A system's build is its group's (agent-wiki-sources pays for the llm-wiki build).

**Update stream** (report "Update stream"): per batch, each group's incremental weighted tokens and each system's correctness after it.

**Scale curves** (`knode-os eval scale <runDirs…>`): runs of the same packs at several `--fraction`s side by side — correctness overall and on
lists, tokens per query, build tokens, by corpus size (staged documents and characters recorded in `run.json`).

**Emergence.** Every system answers the same probes in the same JSON (items with confidence and evidence). Items are matched one-to-one against fixed gold, by the judge for themes and needs and without a model for terms, labels and attribution:
- set precision, **recall**, F1;
- recall split by signal (explicit / implicit / latent);
- grounded share (≥ `minEvidence` corpus documents cited);
- Brier calibration;
- **label accuracy** for moods and attribution.

**Ops**, per build:
- wall time, time inside model calls, calls;
- input / cached / output tokens, Codex-weighted tokens, embedding tokens;
- USD at API prices where a price is known;
- disk bytes, peak RSS;
- incremental update cost;
- **break-even queries** = build weighted tokens ÷ (agent-grep's per-query weighted tokens − the system's).

**Statistics:**
- Wilson intervals for rates and bootstrap intervals for means.
- Paired bootstrap of correctness against `agent-grep`, pooled over packs, Holm-corrected across systems.
- Per-type splits are descriptive.
- `eval audit export|import` measures the judge against a person (agreement, Cohen's κ).

## 5. Running

```
knode-os eval pack build synthetic-life-zh            # Claude drafts, ~15 calls
knode-os eval systems install lightrag                # uv venv, pinned
knode-os eval run --pack synthetic-life-zh,law-cn --config-from ~/.knode-os/users/admin/workspaces/finance \
                  --model gpt-6.1-sol --limit 50
knode-os eval report ~/knode-eval/runs/<stamp>
```

- `--config-from` names the workspace whose embedder (the bge-m3 pool) the run borrows. Its config is only read.
- Build effort defaults to low and answer effort to medium.
- Agents answer at most 30 stratified tasks per pack (`--agent-limit`), round-robin over task types unless an allocation says
  otherwise: `--agent-weights aggregate=4,*=1` or `--agent-counts timeline=12,*=1` by hand, or `--agent-headroom-from <run dirs |
  campaign.json>`, which weights each type by how far apart the agent arms' scores came on it in those records (mean highest − lowest,
  shrunk toward the type's mean over every pack) and gives every type a floor (`--agent-floor`, default 1). `--agent-update-limit`
  caps the update tasks agents answer (default all). The allocation, and what each pack took, is in `run.json` `agentSample`; a resume
  keeps it. The report opens with whether each pack's agent sample could separate the arms at all.
- `--fraction` and `--seed` give scale curves and run-to-run variance. Above 1, `--fraction` stages the pack's padding (10 = ten times the
  documents); a pack with too little padding is refused. Long-context is applicable by the staged size.
- `--types aggregate,timeline,contradiction,profile,deep-hop,update` runs only those tasks; `--reuse-builds-from <run>` starts from another
  run's builds of the same pack versions (refused when it embedded with another model). A build's key names the pack version, not the
  code that built it: `--rebuild knode` (groups, comma-separated) builds those groups afresh after a change to how they build.
- Every agent answer keeps its trace (`commands` on the answer record: the session's shell command lines and `mcp:<server>.<tool> <args>`
  calls, in order, at most 50 of 300 characters each). The report's "Agent tool use" table turns it into calls per answer and uses
  per program (`rg`, `sed`, `cat`, …) or knode tool; answers recorded before traces were kept are counted and named as untraced.
- `knode-os eval pack extend <pack> [--corpus <json>] [--padding <n>] [--no-author]` adds corpus-level tasks and padding to a built pack.
- `--chat-chain`, `--agent-chain`, `--judge-chain` (run) and `--author-chain` (pack build, extend) take budgeted chains such as
  `openai-api:200,codex-cli` over the `--config-from` workspace's connections (D18); spend lands in `~/knode-eval/spend.jsonl`.
- `--embedding-endpoint http://127.0.0.1:12020/v1 --embedding-fallback` embeds on a local bge-m3 (`uv run eval/embed_server.py`), checked
  against the pool, and on the pool while it is down.
- `--embedding-cap` bounds what a run takes from the shared pool.
- `--embedding-daily-cap` bounds what it takes per UTC day, since the live service shares the pool and its free quotas reset at 00:00 UTC. Past the cap, or when the pool itself refuses, a pack waits for the next day and then resumes.

## 6. Not done

- External systems' adapters are written against the versions installed on 2026‑11‑04. A new release may need an adapter change.
- No second-model κ for the judge yet; the human audit stands in.
- No HTML export of the report: Markdown with chart blocks, plus JSON.
- The research forecast's gold is the author model's reading of the 2026 holdout. It is a weak target, reported with the closed-book control.
- Scale curves, variance runs and noise injection exist as flags; the pilot does not run them.
- The vector cache is shared across systems, so a group's embedding tokens depend on which group embedded a text first (a RAG update after
  knode's embeds nothing new). Builds compare fairly on model tokens; embedding tokens are indicative.
- Drafted corpus-level gold (finance-cn, research-ai) is checked quote by quote, but its completeness rests on the author's reading within the
  keyword bound; profiles are scored on recall for that reason. No human audit of it yet.
- law-cn has few disagreements and no timelines inside one law: its corpus-level tasks are mostly aggregates.

## 7. Corpus-level run (revised 2026‑11‑13; phases 0–2, the 3× point, the same-backend 1× and phase 4 done)

Approved 2026‑11‑07. Phases 0, 0b and 1 are done: bge-m3 serves on 127.0.0.1:12020; synthetic-life-zh v2 (41 corpus-level tasks),
finance-cn (+31 corpus-level, 10 chains; padding stops at 1.3× because most same-workspace documents name a closed-world entity),
research-ai (+26 corpus-level, 2 chains, the field review and directions), law-cn (+55), synthetic-reports-zh/-en and public-musique-deep.
Phase 2 runs from `~/knode-eval/runs/corpus-2026-11/phase2.sh` (resumable) into `…/corpus-2026-11/run`. What follows is the plan as approved. Money: the OpenAI key has ≈ $200 left and the Anthropic key ≈ $100 (D18 stops each at 95%); Codex CLI's plan is
the fallback for both chains. Prices: gpt-6.1-sol and claude-sonnet-5-5 at $2 / $0.10–0.20 cached / $10 per 1M tokens. Per-query cost from
the pilot's token profiles at those prices, agents at 1.5× for corpus-level tasks: agents $0.044–0.07, knode-ask $0.018, rag-hybrid $0.015,
long-context ≈ $0.12, closed-book $0.007 — about $0.50 per task across the ten systems.

| Phase | What | Model use | Money |
| --- | --- | --- | --- |
| 0 | `eval pack build synthetic-reports-zh` (and `-en`) with `--options '{"scale":10}'`; `pack build public-musique --out …/public-musique-deep --options '{"minHops":3,"questions":30}'`; `pack extend law-cn --no-author` | none | $0; no download (cached) |
| 0b | local bge-m3: `uv run eval/embed_server.py --port 12020` (registered in service-config) | none | **downloads BAAI/bge-m3 ≈ 2.3 GB and torch/transformers** — needs approval |
| 1 | `pack build synthetic-life-zh --seed 7` (v2); `pack extend finance-cn`, `research-ai` (+ field review, directions), `law-cn` — all with `--author-chain anthropic-api,codex-cli --config-from <finance workspace>` | ≈ 270 author calls | ≈ $20 Anthropic |
| 2 | `eval run --pack synthetic-life-zh,finance-cn,research-ai,law-cn,synthetic-reports-zh --types aggregate,timeline,contradiction,profile,deep-hop,ambiguous,temporal,update,affect,style,attribution,forecast,themes --agent-limit 100 --model gpt-6.1-sol --reuse-builds-from ~/knode-eval/runs/pilot-2026-11 --chat-chain openai-api,codex-cli --agent-chain openai-api,codex-cli --judge-chain anthropic-api,codex-cli --embedding-endpoint http://127.0.0.1:12020/v1 --embedding-fallback --config-from <finance workspace>`; systems agent-grep, agent-wiki, agent-wiki-sources, agent-knode-wiki, agent-knode-wiki-sources, agent-knode, knode-ask, rag-hybrid, long-context, closed-book | ≈ 306 tasks × 10 systems; new builds only for synthetic-life v2 and the reports (≈ 26M tokens) and eight update batches | ≈ $150 answers + $43 builds on OpenAI (the last part may spill to Codex); judge ≈ 290 calls ≈ $20 Anthropic |
| 2b (optional) | public-musique-deep, same systems | ≈ 30 tasks + its builds | ≈ $15 + builds; Codex once OpenAI is spent |
| 3 (optional) | scale curves: synthetic-reports-zh at `--fraction 3` and `10` (padding from phase 0), finance-cn at 3 (`pack extend finance-cn --padding 3`) | builds grow with the corpus (reports 10×: ≈ 56M knode, ≈ 40M LLM Wiki weighted tokens) | Codex plan quota (OpenAI will be spent); bge-m3 local |

Before phase 2, a smoke run (`--limit 2`, one pack) checks that a reused knode workspace opens at its new path and that an agent session
bills the API key (one session ≈ $0.04).

As run: the OpenAI key ran out of credit at 09:27Z with $184 on the ledger (OpenAI answered 429, so the chains moved to Codex before
D18's 95% stop). On Codex an agent answer took a median 172 s instead of 46 s. With one pack left, the default of three answers at a
time left the run about 0.9 answers a minute. It was stopped at 12:58Z and resumed with `--answer-concurrency 8`, which now also applies
to update batches (they were answered one task at a time). agent-knode and knode-ask still answer one at a time (`serial`: the embedded
index allows one process).

Phase 2 finished 2026‑11‑07 18:36Z: 2,969 answers, no errors, 42 builds, 237 judge calls; Anthropic $19.40 in all.

- Pooled over 277 paired tasks, compared with agent-grep (all significant after Holm correction): agent-wiki-sources −0.02,
  agent-knode-wiki-sources −0.03, agent-knode −0.04, agent-wiki −0.09, long-context −0.10, rag-hybrid −0.34, knode-ask −0.40,
  agent-knode-wiki −0.42.
- Corpus-level lists rank the systems the same way. On the year of weekly reports: agent-grep 0.81, agent-wiki-sources 0.78,
  agent-wiki 0.77, agent-knode 0.66.
- At 1× scale, no pack shows a wiki beating raw sources. A wiki is worth about as much as the sources kept next to it.
- Wiki agents read more per query (≈ 60k against 36k weighted tokens on the reports) and never break even with agent-grep.
- knode's own wiki is thin (38 pages on the reports pack against the LLM Wiki's 646 as built, 694 after the update batches), so agent-knode-wiki refuses often.
- Phase 2b and the 10× scale point were not run.
- These pooled deltas mix backends (see phase 3b below). finance-cn, research-ai and synthetic-life-zh ran wholly on the API; on law-cn
  the agents answered on the API and closed-book, knode-ask, long-context, rag-hybrid (and 10 of agent-knode's 72) on Codex; on the
  reports only agent-grep, agent-wiki and agent-wiki-sources answered on the API.

Phase 3, the 3× point, started 2026‑11‑07 22:14Z from `…/corpus-2026-11/phase3-3x.sh` into `…/corpus-2026-11/run-3x`: synthetic-reports-zh
with 282 padding documents (423 in all), the phase 2 systems without closed-book, builds and answers on Codex CLI only. The judge
stays on Anthropic, then Codex, as in phase 2, so both points are scored alike. `eval scale …/run …/run-3x` compares them.

It finished 2026‑11‑08 14:53Z: 837 answers, no errors, 16 builds, 54 judge calls ($0.60). Codex's weekly window went from 18% to 51%.

As first reported, the 1× column mixed backends: agent-grep, agent-wiki and agent-wiki-sources answered the reports on the OpenAI
API (before 09:27Z), every other 1× reports answer and every 3× answer on Codex CLI with the same model. The table below uses the
same-backend 1× from phase 3b.

Phase 3b (approved 2026‑11‑09), from `…/corpus-2026-11/phase3-reanswer-1x.sh` into `…/run-1x-codex`, answered those three again on
Codex: the 81 base tasks each (their 12 update-batch answers were on Codex already). The 1× LLM Wiki was built again on Codex
(58.6 min, 2.74M weighted tokens): update batches had changed phase 2's work directory in place, so `--reuse-builds-from` would have
answered base tasks on the updated wiki. It now builds such a build again (commit 7cc72f6). 243 answers, no errors; Anthropic $0.19;
Codex's weekly window 59% → 64%. `…/merge-same-backend.py` then writes `…/run-1x-same-backend`: phase 2 with those answers and that
build swapped in, and law-cn's Codex answers dropped, so every pair compared was answered on one backend.

- **Backend effect.** On the same 61 usage tasks, Codex scored lower than the API for all three: agent-grep 0.70 against 0.82
  (−0.12 [−0.20, −0.06]), agent-wiki −0.13 [−0.19, −0.07], agent-wiki-sources −0.11 [−0.19, −0.04]. Codex sessions reason far
  more (median reasoning tokens 588–707 against 47–82 on the API) and write more (1.8–2.2k output tokens against 0.8–1.0k);
  agent-grep's also read 1.6× as much (120k input tokens against 76k). The LLM Wiki built on
  Codex has 182 pages against 646 from the API on the same 141 documents. The cause is not established. Cross-backend gaps are not
  comparable, so the pooled deltas above overstate agent-grep's lead.
- **Phase 2 pooled again, same backend only** (`run-1x-same-backend`; Holm): agent-knode-wiki-sources −0.004, agent-knode −0.013,
  agent-wiki-sources −0.017, long-context +0.004 (128 pairs, finance-cn and research-ai have none) — none significant; agent-wiki
  −0.095, rag-hybrid −0.33, knode-ask −0.39, agent-knode-wiki −0.39, closed-book −0.73 stay significant.

| reports, 1× → 3×, all Codex | correctness | lists | tokens / query | build tokens |
| --- | --- | --- | --- | --- |
| agent-grep | 0.75 → 0.74 | 0.63 → 0.62 | 45.1k → 55.6k | — |
| agent-wiki-sources | 0.72 → 0.74 | 0.66 → 0.63 | 56.9k → 65.2k | 2.74M → 8.89M |
| agent-wiki | 0.73 → 0.70 | 0.65 → 0.60 | 54.6k → 60.4k | 2.74M → 8.89M |
| agent-knode-wiki-sources | 0.75 → 0.73 | 0.64 → 0.63 | 57.4k → 65.8k | 5.62M → 18.29M |
| agent-knode | 0.75 → 0.70 | 0.66 → 0.58 | 65.7k → 67.5k | 5.62M → 18.29M |
| long-context | 0.76 → 0.68 | 0.65 → 0.55 | 16.1k → 180.8k | — |
| rag-hybrid | 0.40 → 0.40 | 0.40 → 0.36 | 10.0k → 9.9k | — |
| knode-ask | 0.39 → 0.42 | 0.38 → 0.34 | 11.4k → 11.9k | 5.62M → 18.29M |
| agent-knode-wiki | 0.27 → 0.15 | 0.26 → 0.13 | 71.6k → 83.5k | 5.62M → 18.29M |

- On one backend, no agent differs from agent-grep at either size (paired Δ on 73 tasks, all intervals across 0): at 1×
  agent-wiki-sources −0.02, agent-knode-wiki-sources +0.01, agent-wiki −0.02, agent-knode +0.01, long-context +0.01; at 3× −0.00,
  −0.01, −0.04, −0.05, −0.06.
- agent-grep does not degrade from 1× to 3× (−0.01 [−0.05, 0.05], paired on 73 tasks; lists 0.63 → 0.62). The drop first reported
  (0.85 → 0.74) was the move from the API to Codex. The wiki + sources agents hold too (+0.02, −0.02). long-context loses 0.08
  [−0.14, −0.01], the one significant change; agent-knode −0.06 and agent-wiki −0.03 have intervals across 0. On lists those three
  lose 0.05–0.10.
- Builds grow linearly (3.2× and 3.3×). Base wikis, as built: LLM Wiki 182 pages at 1× and 525 at 3× (both Codex), knode 38 and 30.
- Every agent reads more per query at 3×, agent-grep most (+23%), so the per-query gap to the wiki agents narrows from ≈ 10–12k to
  ≈ 5–10k. It stays positive, so the wiki agents never break even. long-context still fits but costs 11× as much per query.
- Update batches cost the same at 3× as at 1× (≈ 95–175k weighted tokens per group per batch).
- Emergence on reports barely moves on one backend: agent-grep labels 0.73 → 0.67, set recall 0.06 at both; long-context has the
  best set recall at both sizes (0.31, 0.25). The fall first reported for agent-grep (labels 0.87 → 0.67, set recall 0.44 → 0.06)
  was the backend. n = 17–19, so this is indicative only.
- So: up to 3× a wiki next to the sources is worth about what the sources alone are, and costs more per query; a wiki alone loses a
  little; long-context loses the most as the corpus grows (and costs 11× as much per query), and agent-knode drifts down too. The 10× point (≈ 56M knode, ≈ 40M LLM Wiki weighted
  tokens) would show whether that drift becomes a gap. Not run.

### 7.1 Phase 4: the 1× rerun on main (2026‑11‑12)

Phase 4 measured main at bdab966, after BM25 keyword ranking, ranked and sourced claims in ask, and entity pages that carry every
claim with its source (ba9836d). It ran from `…/corpus-2026-11/phase4-ranking-1x.sh` into `…/run-1x-ranking`.

- **Scope.** The 1× reports and synthetic-life-zh v2, for agent-grep and the four knode systems. knode was built again
  (`--rebuild knode`). Builds and answers ran on Codex CLI; the judge was Anthropic, then Codex.
- **Why agent-grep ran again.** The backend alone moves scores, so agent-grep answered again beside the knode systems.
- **As run.** 02:06Z to 11:32Z: 760 answers, no errors, 10 builds. The judge made 53 calls on claude-sonnet-5-5, and one of them
  failed. Codex's weekly window was at 48% partway through.

**Codex drifted between runs.** Several things are the same as in phase 3b:

- agent-grep's prompt and agent code
- the Codex CLI (0.166.0, installed 2026‑11‑02)
- the model and the answer effort

Even so, agent-grep's median reports session changed sharply:

| median per agent-grep session | phase 3b | phase 4 |
| --- | --- | --- |
| reasoning tokens | 546 | 25 |
| output tokens | 1,893 | 684 |
| input tokens | 107k | 70k |

agent-grep also scored 0.06 higher (+0.064 [+0.009, +0.126], paired on 73), and every agent read less per query. The cause is on
Codex's side and is not established. Read phase 4 within itself, or as a change in each system's gap to agent-grep. The table
gives raw scores for context only.

| reports, same-backend 1× → phase 4, all Codex | correctness | lists | tokens / query | Δ vs agent-grep in phase 4 |
| --- | --- | --- | --- | --- |
| agent-grep | 0.75 → 0.81 | 0.63 → 0.75 | 45.1k → 30.5k | — |
| agent-knode | 0.75 → 0.85 | 0.66 → 0.81 | 65.7k → 49.6k | +0.04 [+0.01, +0.09] |
| agent-knode-wiki-sources | 0.75 → 0.86 | 0.64 → 0.81 | 57.4k → 45.8k | +0.05 [+0.01, +0.09] |
| agent-knode-wiki | 0.27 → 0.85 | 0.26 → 0.79 | 71.6k → 54.3k | +0.04 [+0.01, +0.07] |
| knode-ask | 0.39 → 0.63 | 0.38 → 0.59 | 11.4k → 17.1k | −0.19 [−0.28, −0.09] |

The life pack's earlier answers were all on the API, so it has no before/after. Phase 4 alone (Δ paired on 55 tasks):

| life, phase 4, Codex | correctness | lists | tokens / query | false refusal | Δ vs agent-grep |
| --- | --- | --- | --- | --- | --- |
| agent-grep | 0.91 | 0.88 | 32.5k | 0.00 | — |
| agent-knode | 0.91 | 0.88 | 42.8k | 0.00 | −0.00 [−0.03, +0.02] |
| agent-knode-wiki-sources | 0.85 | 0.84 | 38.7k | 0.00 | −0.06 [−0.12, −0.01] |
| agent-knode-wiki | 0.63 | 0.61 | 39.5k | 0.26 | −0.27 [−0.39, −0.16] |
| knode-ask | 0.59 | 0.58 | 15.1k | 0.30 | −0.32 [−0.44, −0.21] |

**Pooled.** Over the same 128 paired tasks as the same-backend phase 2 (Holm):

| vs agent-grep | same-backend phase 2 | phase 4 | significant in phase 4 |
| --- | --- | --- | --- |
| agent-knode | −0.013 | +0.023 [−0.001, +0.051] | no |
| agent-knode-wiki-sources | −0.004 | +0.001 | no |
| agent-knode-wiki | −0.39 | −0.097 | yes |
| knode-ask | −0.39 | −0.242 | yes |

**Change in the gap to agent-grep on the reports**, paired on 70–73 tasks:

| system | change in gap | interval |
| --- | --- | --- |
| agent-knode-wiki | +0.52 | [+0.42, +0.62] |
| knode-ask | +0.17 | [+0.06, +0.28] |
| agent-knode | +0.04 | crosses 0 |
| agent-knode-wiki-sources | +0.04 | crosses 0 |

On the reports, the knode agents lead agent-grep by 0.04–0.05. That lead clears 0 only before multiple-comparison correction,
and the pooled test does not find it. At the same-backend 1×, the lead was +0.01.

**knode's wiki is no longer thin on the reports.** Wiki pages are `*.md` under `wiki/` after the update batches:

| pack | wiki pages, before → now | build tokens | build time | build calls |
| --- | --- | --- | --- | --- |
| reports | 38 → 154 | 7.20M (5.62M before) | 3.2 h | 141 extract, 358 kb-judge (290 before) |
| life | 33 → 52 | 1.11M | 17.1 min | 168 extract, 11 kb-judge |

- On the reports, agent-knode-wiki's false refusals went from 0.35 to 0.00 and its hallucinated share from 0.39 to 0.06.
- The life pack's wiki stays thin. agent-knode-wiki refuses 26% there and loses 0.27. Within each run its gap to agent-grep
  narrows from −0.61 to −0.27, though the two runs used different backends.

**knode-ask gained on its answers, not its retrieval.**

| knode-ask on the reports | same-backend 1× | phase 4 |
| --- | --- | --- |
| correctness | 0.39 | 0.63 |
| hallucinated | 0.48 | 0.15 |
| truthfulness | −0.27 | 0.33 |
| document recall@5 | 0.24 | 0.23 |
| MRR@10 | 0.47 | 0.56 |

- Document recall@5 barely moved. Corpus-level gold spans many documents, so all@5 is 0.03 on the reports and 0.02 on life.
- Across both packs, its weakest types are deep-hop (0.29) and aggregate (0.52).
- It reads more per query (17.1k against 11.4k weighted tokens), because ask now carries ranked, sourced claims.
- Its build breaks even with agent-grep after 534 queries on the reports and 64 on life.

**Cost.**

- The wiki agents still never break even with agent-grep.
- agent-knode reads 19k more weighted tokens per query than agent-grep on the reports (20.6k more before).
- Update batches cost 149–240k weighted tokens on the reports and 5–16k on life.
