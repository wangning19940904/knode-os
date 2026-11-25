# Design records

These files record decisions: the problem at the time, what was chosen and why,
what was measured. They are **not** kept in step with the code. The current
behaviour of the system is described in one place,
[`../ARCHITECTURE.md`](../ARCHITECTURE.md); when a record and that file
disagree, that file is right.

Each record opens with a status line dated 2026-11-17 that says whether it was
built, which later record replaced parts of it, and what in it is stale.

| # | Record | Status | Now described in |
| --- | --- | --- | --- |
| 00 | [knode-os — design overview](00-overview.md) | Built; mostly current | §1, §5, §6 |
| 01 | [文档处理系统：面向海量文本的 Graph Wiki 方案](01-doc-processing-graph-wiki.md) (zh) | Built, then revised | §3, §5.1, §5.2 |
| 02 | [Google Open Knowledge Format（OKF）v0.2 兼容设计](02-okf-compatibility.md) (zh) | Built; current | §5.3, §9 |
| 03 | [Obsidian Vault 原生兼容设计](03-obsidian-vault.md) (zh) | Built; current | §5.3, §9 |
| 04 | [SAG 查询时事件检索](04-sag-query-time-events.md) (zh) | Phase 1 built; phase 2 not built | §6.1 |
| 05 | [Agent Context Database: redesigning the knowledge base for agents](05-agent-context-db.md) | Built (phases 1–6) | §4, §6.2 |
| 05 | [Agent Context Database：面向 agent 的知识库重设计](05-agent-context-db.zh-CN.md) (zh) | Built (phases 1–6) | §4, §6.2 |
| 06 | [Wiki research agents and graph upgrades: ontology / entity resolution / time / recommendations / lint](06-wiki-research-agent.md) | Built | §4, §5.4 |
| 07 | [Initializing a knowledge base, and talking to it: overview + AGENTS.md guide / chat / runner improvements](07-init-and-chat.md) | Built | §5.4, §9 |
| 08 | [碎片化知识的导入规范：消息流 → 知识单元 → 文档](08-fragment-import.zh-CN.md) (zh) | Proposal — never accepted as written | §5.1, §10 |
| 09 | [Reworking the ingest stages: resolve right after extraction, summaries up front, pages to research](09-ingest-stage-rework.md) | Built, then extended | §5.2 |
| 10 | [Extracting long documents in segments, merging duplicate claims](10-long-docs-and-claim-merge.md) | Built | §4, §5.2 |
| 11 | [Plugins: pluggable processing stages, storage and models](11-plugins-and-udfs.md) | Built; current | §9 |
| 12 | [Remote processing: embeddings, summaries and reviews on remote workers](12-remote-processing.md) | Phases 1–4 built, except lent keys | §7 |
| 13 | [The client contract: how other projects use knode-os, starting with rookie-trade](13-client-contract.md) | Proposal — not built | §9, §10 |
| 14 | [Summary pages worth their cost: a size threshold, the document's language, the graph's names, whole documents](14-summary-pages-worth-their-cost.md) | Built; current | §5.2, §5.3 |
| 15 | [Research studies: from a topic to a set of wiki pages, with the sources kept](15-research-studies.md) | Built | §5.4 |
| 16 | [Time in the knowledge base: entries, mention timelines, measures and market data](16-time.md) | Proposal — only phase A (§5.4, claim-type normalisation) built | §4, §10 |
| 17 | [Content languages: a primary language to read in, translations kept beside the originals](17-content-languages.md) | Built; current | §5.2 |
| 18 | [Estimates before a task starts: time, tokens, transfer, cost, and each plan's share](18-estimates.md) | Built | §7 |
| 19 | [Mind maps: pictures of trees read as outlines, drawn as maps, joined to the graph](19-mind-maps.md) | Built; current | §5.1 |
| 20 | [Explore and Tasks: one place to look things up, one place to see what runs](20-explore-and-tasks.md) | Built | §6.1, §9 |
| 21 | [Feishu documents: imported once or kept in sync, pictures included](21-feishu-documents.md) | Built; current | §5.1 |
| 22 | [Research that waits out a usage limit, resumes where it stopped, and is put away](22-research-pauses-and-housekeeping.md) | Built | §5.4 |
| 23 | [Knowledge benchmarks: comparing knowledge-base approaches on the same sources](23-knowledge-benchmarks.md) | Built, then largely replaced by 27 §8, 28, 31, 32, 33, 35 | §8 |
| 24 | [Agent conversations: picked one by one, kept in sync, read as dialogue](24-agent-conversations.md) | Built; current | §5.1 |
| 25 | [Code repositories as a source (`raw/codebase`)](25-codebases.md) | Built; current | §5.1, §10 |
| 26 | [Feeds: connectors, filter and transform layers, and a protocol to push and pull](26-feeds.md) | Phase 1 built; current | §5.1, §10 |
| 27 | [Research sessions on remote workers, and evaluation runs on other machines](27-remote-research-and-eval.md) | Phase 1 and evaluation leasing built; phase 2 not built | §7 |
| 28 | [Benchmark separation: tasks a compiled knowledge base should win](28-benchmark-separation.md) | Built | §8 |
| 29 | [Claim state: current values with history, supersession in every domain, a judge that pays only for doubt](29-claim-state.md) | Built, including §2.1 and §9 | §4 |
| 30 | [Answer routing, batched agent tools, and a rerank stage](30-answer-routing.md) | Built | §6 |
| 31 | [Evaluation on PostgreSQL, and knode answers in parallel](31-eval-on-postgres-parallel-answers.md) | D1–D4 built; D5 step 2 (backend equivalence) not run | §8 |
| 32 | [One work queue: producers publish, work waits, workers decide where it runs](32-unified-work-queue.md) | Stages 1 and 2 built and merged; stage 3 not built | §7 |
| 33 | [The evaluation as a ladder: what search adds, what the wiki adds, what knode's tools add](33-evaluation-ladder.md) | Stages 1–3 built; stages 4 and 5 not done | §8 |
| 34 | [Ask: sets and states computed from the claims, and a second round when the first is thin](34-ask-from-claims.md) | Built | §6.2 |
| 35 | [Evaluation workspaces: a run's knowledge bases open in the app](35-evaluation-workspaces.md) | Stages 1 and 2 built and merged (396fe1e); stages 3 and 4 not built | §8 |
| 36 | [Evaluation protocol: what the next run must show, decided before it runs](36-evaluation-protocol.md) | Prepared 2026-11-21; pilot and run not started | §8 |
| 37 | [Behaviour pages for code, kept true by diffs, and an evaluation that asks where a change lands](37-behaviour-pages-and-localization-eval.md) | Stopped 2026-11-22 at the failed stage-1 gate (grep F1 0.86 on 60 plain codex tasks): stage 0 built, stages 2 and 4 not built, no further pack planned; stage 3 built and reviewed | §8, §5.4 |
| 39 | [Table facts: every cell of the statement tables, typed and queryable](39-table-facts.md) | Built on its branch behind `extraction.tableFacts` (off by default), not merged; model path stub-tested only | — |

## Reading order for a newcomer

1. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — the whole system as it is.
2. For the reasoning behind a part: 05 (scopes, evidence, time), 10 and 29
   (claims), 30 and 34 (answering), 12 and 32 (the work queue), 33 and 35
   (evaluation).
3. Proposals that were not built — 08, 13, 16 — are kept for their analysis,
   not as plans. ARCHITECTURE.md §10 lists what does not exist.

## Writing a new record

- Number it next in sequence and open with a status line: `proposed`, then
  `built` with the date when it is.
- Say which earlier records it changes, by number and section.
- When it is built, put its outcome into ARCHITECTURE.md in the same change,
  and add a row here. Do not go back and rewrite older records; add to their
  status line what replaced them.
- One language per record. Translations drifted from their originals (six were
  removed on 2026-11-17 for that reason); `05-agent-context-db.zh-CN.md` is kept
  because it holds as-built sections its English file lacks.
