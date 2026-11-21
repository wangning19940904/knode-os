# 36 — Evaluation protocol: what the next run must show, decided before it runs

> **Record status (2026-11-21): prepared; pilot and run not started.** This is a decision record for one run, not the description of the system.

## 0. Why

The 2026-11 campaign (26 of 31 packs, 4,210 agent sessions, 826M weighted tokens of knode builds) could not tell the systems apart: 785 of 912 agent questions got the same score from all four arms, each pack gave its agents about 30 questions, and several of its numbers were artifacts of the harness or the gold. A run is worth its cost only if its result, whichever way it falls, changes what we build. So this run is specified first: its questions, the packs and sample that can answer them, the checks that cost nothing and must pass before a model is called, and the rule each result is read by.

## 1. The questions

### Q1. Does what knode adds let an agent answer at lower cost?

At a budget of 20 commands every arm answers in four to six, so the budget never binds and the arms differ only in what they spend (grep 37k weighted tokens an answer, the full knode arm 61k). Two conditions:

- **Budget 3** (`--agent-budget 3`): `agent-grep`, `agent-knode-full` and `agent-knode` (knode's tools, no files). Primary metric: correctness, paired against `agent-grep`.
- **Budget 20**: the four ladder arms and `agent-knode`. Primary metric: weighted tokens per correct answer; correctness as before.

Packs: `real-loong-finance` (574 documents, 44M characters, grep 0.73) and `real-mudabench` (397 documents, 101M characters, grep 0.40): the two finished packs that are large and not at the ceiling. Both builds are reused from the campaign. `real-wiki-hops-300` joins only if stage 1 shows a difference: its build is unfinished.

Sample: 120 questions of `real-loong-finance` by headroom allocation (`--agent-headroom-from`), all 107 of `real-mudabench`. With the spread seen in the campaign that detects about 0.07 on a pack and 0.05 pooled.

Read as: an arm at least 0.05 above grep at budget 3, interval clear of zero after Holm → knode's tools buy steps, and the tool path is worth building on. A tie at both budgets with knode costing more tokens → for an agent with the files, knode adds nothing here, and the work goes to Ask (Q4) and to corpora grep cannot hold.

### Q2. Does Ask with the hop retrieval on beat default Ask? — closed by the free gate

Replayed without a model on the campaign's builds (`~/knode-eval/prep-20261121/hop-replay.mts`, 295 questions): bridge terms change what Ask retrieves on 19 of them, 11 for the better and 8 for the worse.

| pack | family | n | recall@10 default → hops |
| --- | --- | --- | --- |
| public-musique | multi-hop | 25 | 0.600 → 0.640 |
| public-musique-deep | deep-hop | 30 | 0.589 → 0.639 |
| real-loong-finance-300 | aggregation | 40 | 0.450 → 0.458 |
| real-loong-finance-300 | comparison | 40 | 0.775 → 0.750 |
| synthetic-reports-en-v3 | deep-hop | 40 | 0.085 → 0.085 |
| synthetic-reports-en-v3 | structured | 40 | 0.049 → 0.049 |
| synthetic-reports-zh-v3 | deep-hop | 40 | 0.070 → 0.051 |
| synthetic-reports-zh-v3 | structured | 40 | 0.085 → 0.085 |

(Source documents among the first ten passages; wiki pages are not counted, the same for both.) No model run is spent on this question. `knode-ask-hops` answers the 55 MuSiQue questions beside `knode-ask` as a cheap record, and nothing is concluded from it. What the replay does show is where Ask's hop problem is: on the reports packs a single retrieval finds almost none of a chain's documents, whatever the setting.

### Q3. Does the wiki arm stop losing update questions?

In the campaign `agent-knode-wiki-sources` lost 14 of 260 update questions to `agent-grep` and won none, because the harness left pages stale after an update batch. Packs: `synthetic-reports-zh-v3` and `synthetic-reports-en-v3`, built again (their builds were updated in place), every update question (60 and 61) for `agent-grep`, `agent-knode-wiki-sources` and `agent-knode-full`.

Read as: wiki arm within 0.02 of grep, interval holding zero → the harness was the cause. Still behind → pages are stale for a reason in the product, and the stale answers name the pages to look at.

### Q4. Is the new Ask better than the old? — measured first, on one backend

`~/knode-eval/runs/ask-check-20261121`: the same questions answered by main's build (a32393a) and by the fix branch, same Codex backend, same judge. `finance-us`, 60 questions: 0.750 → 0.833 (+0.083, 95% CI 0.017 to 0.158; 7 better, 1 worse), false refusals 0.18 → 0.12. The `real-loong-finance-300` half is recorded in the same folder. In the run `knode-ask` and `rag-hybrid` answer every question of every pack named above (single calls).

## 2. Rules of measurement

- **One build.** A frozen copy of the commit under `~/knode-eval/builds/<sha>/`; the run records the sha. Nothing is rebuilt in place while a run is alive.
- **One answer backend and one judge model** for the whole run, named on the command line and recorded. The campaign changed judge four times and one worker's provider once.
- **Noise floor.** `--repeat 2 --repeat-sample 30` on each pack: a difference is read against the spread of the same arm answered twice.
- **Grading.** As of the frozen commit: key points by recall, lists paired by their own terms before the judge, one list a judge call, 5% audit with key points audited.
- **Packs.** Repaired copies from `~/knode-eval/packs-next/` where one exists (15 questions removed for wrong gold, each checked against the passage; `REPAIRS.md`).
- **Comparisons are named here, not found afterwards.** Q1: full − grep and tools-only − grep at budget 3; tokens per correct answer, full against grep, at budget 20. Q3: wiki − grep on update questions. Paired bootstrap, 95%, Holm across the comparisons of a question. Everything else in the report is description.
- **Embeddings** on the local bge-m3 endpoint (port 12020), checked against the vectors the run holds; the shared pool is out of quota.

## 3. Before any spend

1. Free gates (done 2026-11-21): the hop replay above; the no-judge part of the new grading leaves the campaign's pooled result where it was (agents within ±0.010 of grep over 903 questions).
2. Pilot through the remote workers: the `fixture` pack, every arm of the run, both budgets. It passes when the workers serve work published by the frozen build; `agent-knode-full`'s tool results carry the new claim fields; the update batch logs pages regenerated; `run.json` records the budget, the allocation and the Ask settings; and no answer errors.
3. A written estimate of sessions and calls, and the count at which the run stops if it has not finished.

## 4. Estimate

| part | agent sessions | single calls | builds |
| --- | --- | --- | --- |
| Q1, budget 20 (5 arms, 227 questions, 30 repeated a pack) | 1,435 | — | reused |
| Q1, budget 3 (3 arms, 227 questions) | 681 | — | reused |
| Q3 (3 arms, 121 update questions) | 363 | — | two knode builds, about 26M weighted tokens and 3.5 hours in the campaign |
| Q4 and the single-call track (2 systems) | — | about 3,700 | — |

About 2,500 agent sessions against the campaign's 4,210, on four packs instead of 26.
