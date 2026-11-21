# 36 — Evaluation protocol: what the next run must show, decided before it runs

> **Record status (2026-11-22): run started 2026-11-21 20:32; Q2, Q3 and Q4 answered (§5); Q1 answered at budget 3 on one pack, the rest resumed after a stop (§6).** This is a decision record for one run, not the description of the system.

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

## 6. The stop on 2026-11-21, and what it changed

Three stages stopped early while the driver went on: `q1-b20` on both packs (after the grep, RAG and single-call arms; before the knode arms) and `q1-b3/real-mudabench` (before its first answer). `publishAgent` packed the corpus folder for every question, at once: 107 synchronous reads of a 140 MB folder, each copy kept in memory, so the run stalled, its requests to `serve` timed out half-sent (408, and one bare 400), and the harness took the timeout for a refusal and stopped the pack. The campaign had met the same and patched it at load time in its private hook; nothing of that was in the source.

Fixed in three commits. c395e79: a folder is hashed a file at a time and its stream built only when sent (224 ms for the 140 MB folder, 7 s more to compress when it has to go up); the questions that ask together share one upload; 408, 429 and a bare 400 on the archive routes are waited out. The stages resumed on it at 01:58 and `real-mudabench` stopped again within seven minutes, this time on a 408 from the status route, which showed the cause underneath: `serve` answered 404 to every archive check, whatever it held. The check is a HEAD; the router serves a HEAD by the GET route with the body dropped, and the route was registered for HEAD only, so it never matched. Every question therefore sent the whole archive up again (57 MB compressed for `real-mudabench` with its pages), each upload stalling the run while it compressed and `serve` while it verified. 0462eef: the route is a GET; a run remembers for an hour that `serve` holds an archive, so it uploads once even against the `serve` deployed today, which is not rebuilt for this run; 408 and 429 are waited out on every producer route; the upload compresses off the event loop.

The stages resumed at 02:12 on a frozen build of 0462eef and answered, but the knode arms still uploaded once a question: they copy their pages and sources into a fresh folder for each question, the same content at another path, and the run remembered by folder. 3a2d803 remembers a held archive by its id. The three stages were resumed at 02:40 from a frozen build of that commit (`resume.sh 3a2d8037f4`); of the knode arms' answers, about 80 on `real-loong-finance` and 61 on `real-mudabench` were taken on the two builds in between. The first rule of §2 is broken to that extent: the builds differ in `src/work/eval-archive.ts`, `src/eval/remote.ts` and `src/remote/eval-producer.ts`, none of which an answer or a score passes through. `run.sh` also recorded `date`'s exit status as the stage's, so `stages.log` says "exit 0" for the stopped stages; `resume.sh` records the run's own.
