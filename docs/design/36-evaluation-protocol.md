# 36 — Evaluation protocol: what the next run must show, decided before it runs

> **Record status (2026-11-22): run started 2026-11-21 20:32 and finished 2026-11-22 05:14; all four questions answered (§5). Q1 is a tie at both budgets with knode costing more; reading it found two grading defects and wrong gold in the sample (§5, "What the reading of Q1 found").** This is a decision record for one run, not the description of the system.

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

## 5. Results

Run directory `~/knode-eval/runs/protocol36-20261121` (`run.sh`, `resume.sh`, `analyze.py`, `stages.log`); answers `spacex-aiops/gpt-6.1-sol` on the remote pool, judge `wangning/claude-sonnet-5-5[1m]`, no answer errors in any stage.

### Q3 — answered: the harness was the cause

Every update question of the two reports packs, after fresh builds whose update batches regenerated the pages they dirtied.

| arm | zh (60) | en (61) | pooled − grep (121) | stale answers |
| --- | --- | --- | --- | --- |
| `agent-grep` | 1.000 | 0.934 | — | 0 of 68 |
| `agent-knode-wiki-sources` | 1.000 | 0.918 | −0.008 (95% CI −0.025 to 0.000; 0 better, 1 worse) | 1 of 68 |
| `agent-knode-full` | 1.000 | 0.951 | +0.008 (−0.017 to +0.041; 2 better, 1 worse) | 1 of 68 |
| `knode-ask` | 0.733 | 0.689 | −0.256 (−0.347 to −0.174) | 16 of 68 |
| `rag-hybrid` | 0.700 | 0.852 | −0.190 (−0.264 to −0.116) | 17 of 68 |

The wiki arm is within 0.02 of grep with an interval that holds zero: the 14 lost update questions of the campaign were the harness leaving pages stale. Description, not a named comparison: Ask is wrong on a quarter of the update questions, by the previous value or by declining ("the current limit is unconfirmed; the last explicitly set amount was $5,000") while an agent with the same index's pages answers them all. Four English questions (`upd-metric-D1T3-01` to `-04`) are missed by every arm with different figures each: gold or question to check before they are used again.

### Q2 — as the free gate said

`knode-ask-hops` − `knode-ask`: 0.000 over 25 questions of `public-musique` (1 better, 1 worse), +0.017 over 30 of `public-musique-deep` (2 better, 2 worse).

### Q1, budget 3, `real-loong-finance` (120 questions by headroom)

| arm | correctness | − grep (paired) | weighted tokens an answer | per correct answer | median seconds |
| --- | --- | --- | --- | --- | --- |
| `agent-grep` | 0.537 | — | 34,672 | 64,507 | 186 |
| `agent-knode-full` | 0.571 | +0.033 (95% CI −0.013 to +0.083; Holm p 0.34; 8 better, 3 worse) | 49,260 | 86,294 | 262 |
| `agent-knode` (tools only) | 0.550 | +0.008 (−0.046 to +0.063; Holm p 0.85; 6 better, 6 worse) | 54,716 | 99,407 | 339 |

Neither comparison clears zero, and neither reaches the 0.05 the protocol asks for. The budget held loosely: the brief names three commands and the cap is five steps, so the arms ran 3.5, 3.7 and 4.2 commands an answer. The full arm called a knode tool in none of its 120 answers (it read `wiki/index.md` and grepped), so at this budget it is the wiki arm; the tools-only arm, which can do nothing else, ties grep at 58% more tokens and loses 3 of 11 temporal questions. Aggregation, where the headroom was (59 questions): grep 0.305, full 0.356, tools 0.362, both intervals holding zero.

The 0.537, 0.571 and 0.550 above are the scores as recorded. Two things found afterwards change how they read (below): an arm stopped at its sixth command records an empty answer (grep 4, full 7, tools-only 19 of 120), and the set questions were graded by the shape of the answer's `items` block. Read by content the three arms score 0.596, 0.588 and 0.584.

### Q1, budget 3, `real-mudabench` (107) and pooled

| arm | correctness | − grep (paired) | stopped at the sixth command |
| --- | --- | --- | --- |
| `agent-grep` | 0.416 | — | 13 of 107 |
| `agent-knode-full` | 0.374 | −0.042 (95% CI −0.121 to +0.037; 8 better, 12 worse) | 30 |
| `agent-knode` (tools only) | 0.087 (104 scored) | −0.341 (−0.433 to −0.250; 0 better, 36 worse) | 92 |

The named comparisons, pooled over both packs with `real-loong-finance` read by content: full − grep −0.024 over 227 (95% CI −0.066 to +0.018; Holm p 0.28), tools-only − grep −0.168 over 223 (−0.217 to −0.121; Holm p < 0.001). As recorded they are −0.002 and −0.155. No arm is 0.05 above grep; the tools-only arm is far below it, and not because its answers are wrong: on the questions where both it and grep wrote an answer it ties (+0.005 over 100 on `real-loong-finance`; 15 questions on `real-mudabench`). A `real-mudabench` question needs a figure from 9 to 19 annual reports; one shell command reads them all, one `knode_grep` returns a capped slice, so the tools-only arm is still reading when it is stopped. At three commands knode's tools cost steps where the protocol asked whether they buy them.

### Q1, budget 20

`real-loong-finance`, 120 questions:

| arm | recorded | read by content | − grep, by content | tokens an answer | per correct answer, against grep |
| --- | --- | --- | --- | --- | --- |
| `agent-grep` | 0.546 | 0.613 | — | 47,319 | 77,255 |
| `agent-rag` | 0.567 | 0.600 | −0.013 (−0.033 to 0.000) | 53,648 | 1.16× (1.05 to 1.28) |
| `agent-knode-wiki-sources` | 0.588 | 0.604 | −0.008 (−0.033 to +0.013) | 63,684 | 1.36× (1.25 to 1.50) |
| `agent-knode-full` | 0.592 | 0.600 | −0.013 (−0.033 to 0.000) | 64,721 | 1.40× (1.27 to 1.54) |
| `agent-knode` | 0.609 | 0.618 | 0.000 (−0.013 to +0.013; 119) | 71,134 | 1.51× (1.34 to 1.69) |

`real-mudabench`, 107 questions, as recorded:

| arm | correctness | − grep | tokens an answer | per correct answer, against grep |
| --- | --- | --- | --- | --- |
| `agent-grep` | 0.519 | — | 91,728 | 176,846 |
| `agent-rag` | 0.523 | +0.005 (−0.051 to +0.061) | 101,483 | 1.10× (0.96 to 1.25) |
| `agent-knode-wiki-sources` | 0.589 | +0.070 (+0.009 to +0.136; 10 better, 3 worse) | 102,338 | 0.98× (0.85 to 1.13) |
| `agent-knode-full` | 0.533 | +0.014 (−0.037 to +0.065) | 114,282 | 1.21× (1.08 to 1.36) |
| `agent-knode` | 0.548 (104) | +0.024 (−0.043 to +0.096) | 143,360 | 1.52× (1.28 to 1.79) |

The named comparison, tokens per correct answer, full against grep, pooled over 227: 1.29× (95% CI 1.20 to 1.39), 1.22× as recorded. Correctness is a tie: pooled, full − grep 0.000 (−0.026 to +0.026), tools-only +0.011 (−0.022 to +0.045), wiki arm +0.029 (−0.002 to +0.062). The wiki arm's +0.070 on `real-mudabench` is description, not a named comparison (Holm p 0.11 among the four), on a pack where the same arm answered twice changes 3 to 6 of 30 answers (grep's second answers average 0.117 below its first); on `real-loong-finance` the repeats change 0 to 3 of 30. The full arm called a knode tool in 2 of 120 and 4 of 107 answers and in none at budget 3, so it is the wiki arm with a different seed. The campaign's one separation, grep 0.40 against 0.52 on 30 questions of `real-mudabench`, is not there on 107: grep scores 0.519.

Single calls on every question: `knode-ask` 0.291 against `rag-hybrid` 0.123 over the 624 of `real-loong-finance` (+0.168, 95% CI +0.136 to +0.201); both 0.000 on `real-mudabench`, as in the campaign.

By the rule of §1: a tie at both budgets with knode costing more. For an agent that has the files, pages and tools add no correct answers on these two packs and cost 14% to 53% more tokens for each one.

### What the reading of Q1 found

As recorded, the three knode arms were 0.04 to 0.06 above grep on `real-loong-finance` at budget 20, intervals clear of zero. None of it is there. `~/knode-eval/runs/protocol36-20261121/rescore_sets.py` reads the same answers again without a model.

1. **Set questions are graded by the shape of the `items` block.** The gold of an aggregation question is one item a member ("亿纬锂能: 高利润"). The exact-set score pairs one returned item with one gold item, so an answer that lists a class with its members ("中利润：百亚股份、蓝晓科技") matches one member a class and scores 0 with every member in its class. Eight of grep's 65 aggregation answers were lost to this, against one or two of each knode arm's: that difference was the whole recorded gain. Read for the members and classes each label names, every answer scored 1 stays 1 and the arms are within 0.013 of each other.
2. **The gold of the sample is wrong where the headroom was.** Of the 58 aggregation questions, all five arms are right on 23, some on 3, and none on 32; on each of those 32 all five arms put the same member in a class the gold does not, through three different interfaces. Four were checked against the filings and the gold is wrong in all four: 平安银行 reports in 人民币百万元 and its 18,525 is graded as a profit under 1,000,000,000; GSE Systems reports in thousands and its $4,746 is graded "below 100,000"; 格力电器's 5,318,471,160.65 is graded a loss; 联科科技's 5,117,932.64 is graded "above 10,000,000". The allocation by headroom took its questions from where the campaign's arms had scored low, which is where the gold is wrong: 32 of the 120 can be won by no arm, and on the other 88 grep scores 0.835. On `real-mudabench` the five arms return the same items and none is scored right on 21 of 107; those were not checked.
3. **A stopped agent records nothing.** At budget 3 the agent is told three commands and its session is killed at the sixth, with an empty answer and no tokens recorded. The budget-3 score therefore mixes "can answer in five steps" with "stops when told", and the tokens of the arms that are stopped most are undercounted.

Before another run reads correctness on these packs: the exact-set score has to read a grouped item as its members; the 32 questions (and the 21) have to be checked against the filings and repaired or removed, and headroom allocation has to draw from questions at least one arm has answered; a stopped agent has to be asked for its answer, or its stop recorded as its own outcome.

## 6. The stop on 2026-11-21, and what it changed

Three stages stopped early while the driver went on: `q1-b20` on both packs (after the grep, RAG and single-call arms; before the knode arms) and `q1-b3/real-mudabench` (before its first answer). `publishAgent` packed the corpus folder for every question, at once: 107 synchronous reads of a 140 MB folder, each copy kept in memory, so the run stalled, its requests to `serve` timed out half-sent (408, and one bare 400), and the harness took the timeout for a refusal and stopped the pack. The campaign had met the same and patched it at load time in its private hook; nothing of that was in the source.

Fixed in three commits. c395e79: a folder is hashed a file at a time and its stream built only when sent (224 ms for the 140 MB folder, 7 s more to compress when it has to go up); the questions that ask together share one upload; 408, 429 and a bare 400 on the archive routes are waited out. The stages resumed on it at 01:58 and `real-mudabench` stopped again within seven minutes, this time on a 408 from the status route, which showed the cause underneath: `serve` answered 404 to every archive check, whatever it held. The check is a HEAD; the router serves a HEAD by the GET route with the body dropped, and the route was registered for HEAD only, so it never matched. Every question therefore sent the whole archive up again (57 MB compressed for `real-mudabench` with its pages), each upload stalling the run while it compressed and `serve` while it verified. 0462eef: the route is a GET; a run remembers for an hour that `serve` holds an archive, so it uploads once even against the `serve` deployed today, which is not rebuilt for this run; 408 and 429 are waited out on every producer route; the upload compresses off the event loop.

The stages resumed at 02:12 on a frozen build of 0462eef and answered, but the knode arms still uploaded once a question: they copy their pages and sources into a fresh folder for each question, the same content at another path, and the run remembered by folder. 3a2d803 remembers a held archive by its id. The three stages were resumed at 02:40 from a frozen build of that commit (`resume.sh 3a2d8037f4`); of the knode arms' answers, about 80 on `real-loong-finance` and 61 on `real-mudabench` were taken on the two builds in between. The first rule of §2 is broken to that extent: the builds differ in `src/work/eval-archive.ts`, `src/eval/remote.ts` and `src/remote/eval-producer.ts`, none of which an answer or a score passes through. `run.sh` also recorded `date`'s exit status as the stage's, so `stages.log` says "exit 0" for the stopped stages; `resume.sh` records the run's own.
