# 36 — Evaluation protocol: what the next run must show, decided before it runs

> **Record status (2026-11-22): run started 2026-11-21 20:32 and finished 2026-11-22 05:14; all four questions answered (§5). Q1 is a tie at both budgets with knode costing more; reading it found two grading defects and wrong gold in the sample, since fixed and the run read again (§5, "What the reading of Q1 found" and "Fixed, and the run read again").** This is a decision record for one run, not the description of the system.

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

#### Why Ask lost them (2026-11-22, no model)

Ask's prompts replayed on the run's builds (read-only, the run's question vectors, a model stub that keeps the prompt). 117 questions (the four above left out), 34 scored 0:

| class | n | Ask said | lost at |
| --- | --- | --- | --- |
| "By X's latest weekly report, how many risks are still open?" | 17 | declined | retrieval: the latest report was in none of the 17 prompts; nothing in the search, the facts or the enumeration orders sources by date |
| "Which is the newest incident X has reported?" | 9 | the incident before | retrieval: the new incident's id was in none of the 9 prompts (neither passage nor fact); the newest incident shown was the one a monthly summary names |
| "What is X's daily push cap / per-refund approval limit now?" | 6 | an older value (4); declined, quoting the initial value (2) | entity identity: the current value is stated under the setting's code or short name ("the push quota moves to 6 pushes") and extracted onto that twin entity, which Ask's named entities did not reach (`knode_claims` does); the setting's own entity holds the initial value, restated weekly |
| graded wrong, answer right | 2 | "One risk—R-128—is still open" (gold 1); "released" (gold "launched") | value scoring |

Ruled out: supersession (the new values are live, the old ones superseded where they share an entity); the 2026-11-21 answer rules (every decline had a prompt without the answer); wiki pages crowding the update's document (it was not ranked at all). Three `cfg` questions per pack (`GRW1-C1-01`, `-02`, `PAY1-C1-01`) ask for a value set before the batches: they test the current value, not the update.

Fixed on branch `claude/ask-stale-update-answers-c8e221`:
- `search/newest.ts`: a question asking for the latest or current state ("latest", "newest", "now", "最新", "目前", "现在"; not "current ratio", not "最近三个月") gets the newest dated sources about what it names, before the passages: of the entity's own sources (titled with its name) whose titles hold the question's words best, the newest, and the newest holding the question's other words (each weighted by the share of candidates holding it, so cross-word bigrams count for little). Marked `newest` with the date; a rule says the newest source decides and a restated initial value is history.
- Every passage header carries its source's date.
- `graph/resolve.ts` `shortNameTwins`: the named entities include short-name twins, by exact alias key (indexed), for entities with at most 16 aliases; a twin's claims are ranked under its owner's name too; claims about a specific named entity (≤ 30 candidates) rank by that beside words and embedding; "now"/"最新" no longer rank claims.

Measured, same replay, before → after, the newest sources read at each batch's date (the search still sees the final build):

| | before | after |
| --- | --- | --- |
| risks (17 wrong): the batch's report among the passages | 0 | 17, each first and marked newest |
| incidents (9 wrong): the new incident's id in the prompt | 0 | 9 |
| settings (6 wrong): the current value's claim in the prompt, dated | 0 | 5 (the sixth, zh `PAY1-C1-01`, was superseded by batch 02 in the final build and cannot be shown) |
| all 117: the evidence document among the passages | 15 | 97 (82 first) |
| prompt characters, mean | 27,985 | 30,215 |

The 83 questions Ask got right keep the evidence they had (every incident id and setting value present before is present after). The packs' other 916 questions with evidence (the campaign's vectors), share of evidence documents in the prompt: 0.698 → 0.738, 90 better, 13 worse; by type alias 0.608 → 0.773, stale 0.839 → 0.904, timeline 0.790 → 0.821, paraphrase 0.894 → 0.936, deep-hop 0.207 → 0.200 (4 better, 12 worse: a chain's facts give way to the claims of the specific entities it names), the rest unchanged; the newest sources fired on 15 of them; median replay 116 → 111 ms. Not handled: a source titled with the entity and newer than its last report that counts incidents without naming them would be taken as the newest. On `ws_finance_a8349022` (read-only) twins take 2–35 ms and the newest sources 85–550 ms under a machine load of about 45. Whether the answers follow needs a model run: both Ask builds over the 121 questions, rebuilt from the run's cached replies, under the protocol's rules with local Codex and a local Claude judge.

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

### Fixed, and the run read again (2026-11-22)

- **Grading** (de7b6c1): a field-matched entry that names several gold items of one class counts as that many; a class may be named short ("— high" for "high liabilities") when the label holds that one short name and no other outside the company's name; "this group is empty" is not an item; a grouping question now says how to write its items. A stopped session's tokens are null, not 0, and the report says how many were stopped. It is still not asked for its answer: that needs the workers' code, and its stop is recorded as its own outcome instead. (It is now: "The closing turn" below.)
- **Gold.** Every company the five arms placed against the gold (84, in 29 questions) was read again in its filing by auditors that saw neither the gold nor the answers, each reading with its line and unit, each quoted line checked at its line number. 69 contradict the gold and agree with the arms, 14 confirm it (one question, whose gold lacked a fifteenth company the question lists), 1 is ambiguous. `~/knode-eval/packs-next/real-loong-finance` (version 2): 62 companies moved in 27 questions, one added, 4 questions removed. `~/knode-eval/packs-next/real-mudabench` (version 2): of the 21 suspect questions, 7 were audited and none can be answered as the gold has it from the corpus supplied (a calendar-year filer's report is filed under the following year; two reports lost their Chinese text; "inventory intensity" and "other business revenue" are not reported figures) and are removed; 14 questions that ask "which companies achieved the highest …" with a gold of three now ask for three; 4 large ones are unchecked and left. `packs-next/REPAIRS.md` lists every change with its line.
- **The same answers under both** (`rescored-20261122/` in the run folder; no model called, the judge's verdicts from the run's cache; no score fell):

| | grep | wiki + sources | full | tools only | RAG agent |
| --- | --- | --- | --- | --- | --- |
| `real-loong-finance`, budget 20 (118) | 0.852 | 0.852 | 0.847 | 0.850 | 0.839 |
| − grep | — | 0.000 (−0.017 to +0.017) | −0.004 (−0.013 to 0.000) | 0.000 (−0.013 to +0.013) | −0.013 (−0.034 to 0.000) |
| tokens per correct answer, against grep | — | 1.34× | 1.37× (1.25 to 1.51) | 1.51× | 1.15× |
| `real-mudabench`, budget 20 (100) | 0.555 | 0.630 | 0.570 | 0.588 | 0.560 |
| − grep | — | +0.075 (+0.010 to +0.145) | +0.015 (−0.040 to +0.070) | +0.026 (−0.046 to +0.103) | +0.005 |
| `real-loong-finance`, budget 3 (118) | 0.818 | — | 0.792 | 0.739 | — |
| `real-mudabench`, budget 3 (100) | 0.445 | — | 0.400 | 0.093 | — |

112 of the 118 `real-loong-finance` questions now get the same score from all five arms, and aggregation is 0.93 for every arm where it was recorded as 0.31 to 0.43. The named comparisons do not change their answer: tokens per correct answer, full against grep, 1.28× pooled (1.19 to 1.37); at budget 3, full − grep −0.034 (−0.083 to +0.014), tools-only − grep −0.208 (−0.264 to −0.154; stopped on 101 of 214 against grep's 15). The wiki arm's pooled +0.034 (+0.002 to +0.067) is all `real-mudabench`, where the 14 reworded questions were answered under the old wording (every arm 0 on them) and a repeat of the same arm changes 3 to 6 of 30 answers: the one thing here worth a second look, not a result. Ask on `real-loong-finance` is 0.304 over 620 against the agents' 0.85 on their sample, and 0.08 on aggregation.

Still open: `real-loong-finance` on its 118-question sample is now at 0.85 for every arm with 13 questions none gets right (5 comparisons, 2 trends, 2 lookups and 4 groupings not yet read against the filings), so it has little room left to separate agents; headroom allocation still draws from where every arm failed; the MuDABench corpus heads a calendar-year filer's report with the wrong year.

### The second pass (2026-11-22)

Read the same way, blind auditors and every quoted line checked (626 quotes, none wrong); every change is in `packs-next/REPAIRS.md`.

- **MuDABench report years.** MuDABench files a US report under the year it was filed, while its per-report values are the named year's own. That is right for the 190 reports whose fiscal year ends January to October and wrong for the corpus's three calendar-year filers (UAA "2021" and TG "2021" are the 10-Ks for 2020, TG "2022" the 10-K for 2021): 3 of 397. None of the 204 Chinese reports is misdated (231 of the dataset's 233 amounts are in the report it names; the other two are in a scan). 13 questions used the three. The recipe now dates a US report by its cover and heads it with that year; a question about a year reads that year's report, drops a company the corpus has no report for when the gold does not name it, and is left out when it does (`redateRows`). Version 3 of the copy: TG's 2021 re-pointed in 4 questions, TG out of the scope of 4.
- **The 13 `real-loong-finance` questions none got right**: 8 gold changed, each to what all five arms answered (units again, a sign, and two trends whose gold numbered each year by the report filed in it); 4 removed as underdetermined (a royalty trust's expense reserve as a liability, a "total current liabilities" two of three filers do not report, "the cash flow" of a trust with no cash-flow statement); 1 right, lost to the scorer. **The four large MuDABench questions**: 2 removed (a weighted score that does not say whether cost growth counts for or against; one also needs a scanned report), 2 with the gold right and reworded (a record date "of 2022" means the 2022 distribution's; an auditor "changed in 2022–2023" means the 2023 report names another firm). Two duplicates of questions removed in version 2 removed too. **`upd-metric-D1T3-01` to `-04`**: the gold is right and so were the agents ("1,837,000" for 1837k); the value scorer did not read a number at its scale and now does (`src/eval/score/values.ts`).
- **Read again** (`rescored-20261122-v3/`, no model; the six Loong questions whose judged gold changed have no verdict in the cache and are left unscored until a judge reads them; the five arms' answers there agree with the new gold, one of them leaving a year out):

| | grep | wiki + sources | full | tools only | RAG agent |
| --- | --- | --- | --- | --- | --- |
| `real-loong-finance`, budget 20 (108 scored) | 0.958 | 0.949 | 0.954 | 0.958 | 0.935 |
| `real-mudabench`, budget 20 (96) | 0.578 | 0.656 | 0.594 | 0.596 | 0.583 |
| `real-loong-finance`, budget 3 (108) | 0.921 | — | 0.870 | 0.827 | — |
| `real-mudabench`, budget 3 (96) | 0.464 | — | 0.417 | 0.095 | — |
| `synthetic-reports-en-v3`, update (61) | 1.000 | 0.984 | 0.984 | — | — |

No `real-loong-finance` question is now missed by every arm, and 99 of the 107 that all five answered get the same score from each: as a sample to separate agents it is spent. `real-mudabench` keeps 28 of 94 that no arm gets right; the wiki arm's +0.078 (+0.010 to +0.151) over grep stands, as before not a result on its own.

### The closing turn (2026-11-22)

An agent that reaches its cap is now asked for its answer, the same way for every arm, so a low budget measures what an arm can learn in its commands rather than whether it stops when told. When the session starts its `maxSteps + 1`th command or tool call (the budget's sixth at budget 3), it is interrupted with SIGINT instead of being killed. Codex treats SIGINT as an interrupt: it aborts the turn, records "aborted by user" for the call in flight, saves the turn's tokens so far and exits. The runner then resumes the same thread once with `codex exec resume <id>`, `--disable shell_tool` and no MCP server, and sends `CLOSING_TURN` (`src/eval/agent.ts`) on stdin: *You have reached your command budget. Run no more commands and call no more tools: answer the question now, from what you have already read, in the form the task asked for. If what you have read is not enough to be sure, give your best answer and say what is missing.* Codex still offers that turn a few tools of its own (sub-agents, patches, images). If the turn starts any item other than a message, it is interrupted and records no answer (`closing: used-a-tool`).

The answer stays `capped`. `closing` on the record says how the turn went: `answered`, `no-answer`, `used-a-tool`, or `not-run`, which is the old stop with nothing. The report counts the capped answers given in the closing turn. A resumed turn's `turn.completed` reports the thread's running total, so usage is read as that thread's last report, not as a sum (`readCodexEvents`). With that, the stopped session's tokens and the closing turn's are on record; only the response that was cut off at the interrupt is not, since Codex never received its usage. A resume needs a saved session, so answering sessions run without `--ephemeral` and with `memories.generate_memories=false`, and `codex delete --force` removes the thread when the session ends. The llm-wiki builder keeps the old stop (`closing: null`).

Checked against codex-cli 0.171.0 on a six-file fixture at budget 2, on the login:
- On the local path, the run was interrupted at its third command and answered in its closing turn from the one file it had read, with 47,162 input tokens on record (about 29k before the stop and about 18k in the closing turn).
- The worker's own argv gave the same result.
- With the shell disabled, the closing turn could not read a file when asked to.
- No session was left in `~/.codex`.
- The call in flight at the interrupt may still finish running: its output reaches the trace, but the model's history records it as aborted.

None of this was run on the remote pool. The new behaviour needs all three of the following; with any one missing, the session is stopped as before, and it is read and scored as it was after de7b6c1:
- the run's build (`src/eval`);
- `serve` (`src/remote/eval-producer.ts`, `src/work/eval.ts`, `src/remote/api.ts`), which carries the spec's `closing` to the worker and the worker's `closing` back;
- each worker's `worker/knode-worker.mjs`, which acts only on a task that carries `closing`.

A run's own slots (`--local`) run the session in the run's process and need only the run.


### Sampling by question (2026-11-22)

Headroom allocation read only per-type means of the earlier records, so it sent the sample to a type whose questions the arms had split on, and then drew that type's questions at random. On `real-loong-finance` that type was aggregation, where most of the gold was wrong. `--agent-headroom-from` now reads each question's scores, where the records have them (`scores.jsonl`, the run directories of a `campaign.json`; a `report.json` has only types). Code: `src/eval/allocation.ts` (`questionClassOf`, `SAMPLE_TIERS`, `sampleReportOf`) and `selectTasks` in `src/eval/run.ts`.

**The rule.** Each question gets a class from every agent arm's answers in the records, repeats included:

- *contested*: two arms scored it differently, or one arm's repeats did;
- *all right*, or *the same partial score* from every arm;
- *all wrong*: every answer of two or more arms scored 0. These are suspect.

The sample is drawn in tiers, each by the type quotas over what the tiers before it left of `--agent-limit`, and a type's floor counts what an earlier tier gave it:

1. contested questions;
2. questions the records never saw, spread over types by the records' spread (as before) or evenly (`--agent-headroom-types even`, plain stratified);
3. agreed questions, only when nothing else is left;
4. all-wrong questions, only up to `--agent-suspects n` (default 0).

The order inside a tier is the seeded order `selectTasks` always used, so a seed gives one sample. With no allocation flag the sample is round-robin over types, as before. `--agent-headroom-stale <ids|file>` drops what the records saw of questions reworded since (MuDABench's 14 "which three companies" questions were answered under the old wording), and they are sampled as never seen. A run of one pack is now known by its directory's name even where a copied run records the pack's path (`rescored-20261122/*/run.json` does; before this, its evidence fell back to the pooled weights).

**Suspects are left out and listed, not capped.** A suspect costs a live question's sessions and cannot move a paired difference. Reading it against its passage costs no model call. With the same arms they stay dead (below), and a repaired question comes back: as seen, once its records are re-scored against the new gold, or as never seen, if it was reworded. `--agent-suspects` exists for a run whose arms are new to the records, the one case where a question every old arm missed can still be won.

**Before any model is called.**

- `eval run` prints each pack's sample by class, per type, with the suspects it left out and how many questions are expected to be contested: those seen contested, plus each never-seen question at its type's contested share in the records, shrunk as the weights are. It warns when fewer than half are expected to be contested, and says how lopsided a contest must be to show: with C contested of n, one arm must win (1 + 2.8/√C)/2 of them, about 2.8·√C/n on the sample's mean, counting whole questions.
- `eval run … --agent-sample-only` prints the same and stops.
- `run.json` (`agentSample.questions`) and the report record it.
- `eval pack lint --answers <runs>` lists the same all-wrong questions (`none-right`) beside `abstain-answered`.

Both commands, because they answer different questions. The sample report belongs to a sample (limit, seed, allocation) and is printed where the sample is drawn. The suspect list is a fact about a pack's gold against a run's answers, and goes where the other gold checks are.

**Measured on the recorded data, no model called** (`questionClasses` over each run's agent arms; "dead" = all wrong in this sense: every answer of all five arms, repeats included, scored 0, which counts 41 questions on `real-loong-finance` where the Q1 reading's "none right" counted 32 aggregation questions). The recorded allocation reproduces protocol 36's 120 and 107 questions exactly.

How a class carries from the campaign (4 arms) to protocol 36 (5 arms, same gold), on the 56 questions both asked:

| class in the campaign | questions | same class in protocol 36 | became contested |
| --- | --- | --- | --- |
| contested | 11 | 9 | — |
| all right | 27 | 25 | 2 |
| all wrong | 17 | 14 | 3 |
| never seen (the rest of protocol 36's samples) | 171 | — | 23 (13%); 82 all right, 65 dead |

What the rule would have drawn for protocol 36 from `campaign.json`:

| pack | sample | dead in it (original gold / repaired) | dead avoided | report before the run | contested in fact |
| --- | --- | --- | --- | --- | --- |
| `real-loong-finance`, spread | 120: aggregation 59, comparison 27, numeric 21, temporal 11, single-hop 2; 99 in protocol 36's sample | 38 of 41 / 10 of 12 | 3 (the campaign's 5 suspects; the other 2 were contested in protocol 36) | about 34 expected contested; warning | — |
| `real-loong-finance`, even | 120, 24 or so a type; 51 not answered in protocol 36 | 19 of 41 / 9 of 12, among the 69 answered | unknown for the other 51 | about 24; warning | — |
| protocol 36's own sample, as the report would have read it | 120 | 41 / 12 | — | about 30 expected contested; warning | 15 (original gold), 8 (repaired) |
| `real-mudabench` | 95 of 107: the 12 suspects left out | 28 of 39 / 24 of 32 | 11 (of the 12 left out, 11 were dead in protocol 36, 3 of them since removed as unanswerable; 1 was contested) | about 18 expected contested; warning | 21 of those 95 |

From the campaign's records the rule could avoid only what the campaign had seen: 30 questions a pack, and 94 of protocol 36's 120 `real-loong-finance` questions had never been asked. Its type weights still put 59 questions on aggregation, because the campaign saw 2 of its 6 aggregation questions contested, partly through the set grading fixed since. What it adds there is the warning, before any spend. The warning was right, and if anything too hopeful on `real-loong-finance`: the report would have expected about 30 contested, and protocol 36 found 15 under the original gold and 8 under the repaired. On `real-mudabench` it expected 18 and found 21 among the 95.

The campaign's single calls answered every question, but they do not find dead gold. All 41 dead questions were missed by both `knode-ask` and `rag-hybrid`, and so were 47 that the agents got right or split on. They are not used.

The next run, on `packs-next` with the re-scored records (`rescored-20261122/q1-b20`):

| pack | old rule (type weights only) | new rule, spread | new rule, even |
| --- | --- | --- | --- |
| `real-loong-finance`, 120 of 620 | 91 never seen, 20 all right, 1 partial, 6 contested, 2 dead | 8 contested + 112 never seen (temporal 73, single-hop 30, aggregation 11, comparison 4, numeric 2); 12 dead listed; about 43 expected contested | 8 contested + 112 never seen (27, 24, 23, 23, 23); 12 dead listed; about 23 expected |
| `real-mudabench`, limit 107 of 100 | all 100: 46 all right, 32 dead, 22 contested | 68: 22 contested, 46 all right; 32 dead listed | the same |
| `real-mudabench`, the 14 reworded marked stale | — | 82: 22 contested, 14 never seen, 46 all right; 18 dead listed; about 25 expected | the same |

**Argued, not measured.**

- *Selecting by disagreement keeps a paired test valid.* The rule picks questions by whether the arms disagreed, not by which arm won, so under the null it is symmetric in the arms. But the estimate is a difference on contested questions, not a pack mean. A tiered sample's scores are not comparable with an unweighted run's.
- *The expected-contested count is an upper bound where the records are thin or pooled across packs.* On `real-loong-finance` it was 2 to 4 times too high.
- *Spread weights follow thin evidence.* Spread put 73 of 100 temporal questions in the next sample on the strength of 10 seen, 5 of them contested. With one run of records, even is the safer choice.
- *Agreed questions earn their place only for arms new to the records.* They fill the limit last; a lower `--agent-limit` leaves them out.

On these two packs, the repaired gold leaves little room for these agents. One arm must win about 79% of the contested questions on the next `real-loong-finance` sample, and 80% on `real-mudabench`, for a difference to show. The rule cannot make room that the pack does not have, but it says so before anything is spent.

## 6. The stop on 2026-11-21, and what it changed

Three stages stopped early while the driver went on: `q1-b20` on both packs (after the grep, RAG and single-call arms; before the knode arms) and `q1-b3/real-mudabench` (before its first answer). `publishAgent` packed the corpus folder for every question, at once: 107 synchronous reads of a 140 MB folder, each copy kept in memory, so the run stalled, its requests to `serve` timed out half-sent (408, and one bare 400), and the harness took the timeout for a refusal and stopped the pack. The campaign had met the same and patched it at load time in its private hook; nothing of that was in the source.

Fixed in three commits. c395e79: a folder is hashed a file at a time and its stream built only when sent (224 ms for the 140 MB folder, 7 s more to compress when it has to go up); the questions that ask together share one upload; 408, 429 and a bare 400 on the archive routes are waited out. The stages resumed on it at 01:58 and `real-mudabench` stopped again within seven minutes, this time on a 408 from the status route, which showed the cause underneath: `serve` answered 404 to every archive check, whatever it held. The check is a HEAD; the router serves a HEAD by the GET route with the body dropped, and the route was registered for HEAD only, so it never matched. Every question therefore sent the whole archive up again (57 MB compressed for `real-mudabench` with its pages), each upload stalling the run while it compressed and `serve` while it verified. 0462eef: the route is a GET; a run remembers for an hour that `serve` holds an archive, so it uploads once even against the `serve` deployed today, which is not rebuilt for this run; 408 and 429 are waited out on every producer route; the upload compresses off the event loop.

The stages resumed at 02:12 on a frozen build of 0462eef and answered, but the knode arms still uploaded once a question: they copy their pages and sources into a fresh folder for each question, the same content at another path, and the run remembered by folder. 3a2d803 remembers a held archive by its id. The three stages were resumed at 02:40 from a frozen build of that commit (`resume.sh 3a2d8037f4`); of the knode arms' answers, about 80 on `real-loong-finance` and 61 on `real-mudabench` were taken on the two builds in between. The first rule of §2 is broken to that extent: the builds differ in `src/work/eval-archive.ts`, `src/eval/remote.ts` and `src/remote/eval-producer.ts`, none of which an answer or a score passes through. `run.sh` also recorded `date`'s exit status as the stage's, so `stages.log` says "exit 0" for the stopped stages; `resume.sh` records the run's own.
