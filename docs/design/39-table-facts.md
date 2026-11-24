# 39 — Table facts: every cell of the statement tables, typed and queryable

> Status: **implemented** on branch `claude/table-facts-typed-rows-1e03e6` (2026‑11‑24), not merged or deployed;
> behind `extraction.tableFacts.enabled` (default off). The model path is built and stub-tested only: no model
> call has been made with it, so its quality and real cost are not known.
> Code: `src/tables/` (`values.ts` cells, scales, periods; `labels.ts` label keys; `parse.ts` the two layouts;
> `llm.ts` the model path; `store.ts` the sync pass, label pass, model pass and `knode_table`'s matrix), schema v22
> in `src/store/migrations.ts`, the `tables` scope kind (`src/lineage`), `knode_table` (`src/mcp/tools.ts`).
> Measurement: `scripts/table-facts-coverage.mts`. Tests: `tests/table-facts-parse.test.ts`,
> `tests/table-facts-store.test.ts`.

## 0. Why

On `real-loong-finance` (the 2026‑11 build, 574 reports) the gold number of the single-document numeric questions
was in the text for 115/117, in the document's claims for 28 and on its summary page for 33. Extraction caps claims
at 25 a call (`EXTRACT_CAPS.claims`), a balance sheet has a hundred rows, and nothing turned a table into data. The
knowledge base could not hold what the questions ask, whatever retrieval did.

## 1. Parsing (no model)

- **Pipe tables** (Chinese reports as converted): rows are cells. What needs care is the converter's damage: a
  header glued to the row above it (`…|原因||利润表项目|本期发生额|`), a label written twice
  (`|永续债|永续债|-|-|`), text after the closing pipe (taken as the next table's title), and a page break written
  as a new table whose "header" is a data row or dashes — such a part, and a headerless part of the same width after
  page furniture only, continue the table above (its header, scale and title).
- **Space-aligned text tables** (EDGAR 10-K/10-Q renditions): a row is a label followed by value fields (runs
  separated by two or more spaces; non-breaking and zero-width spaces normalized; a `$` apart from its number joins
  it). Columns are clusters of where the numbers *end* (they are right-aligned); headers are the fields above that
  overlap a column, a lone field centred over several heading each; a line of years is a header, never a row; a
  wrapped label joins its first half; a statement split by a page break inherits the scale note and header.
- **Single-spaced rows** (a PDF text layer, `real-mudabench`): columns by order; a row whose value count is not the
  table's usual one is left out. Headers: a line naming as many periods as there are columns, one split as month-day
  over years, one written a piece per line, or column names with a group line above.
- Every non-label cell is a fact: label as written, its key, the column header as written (`period`) and its key
  (an ISO date, year, `2024-Q1`, or `current` / `prior` / `change`; a dated statement's `current` column reads as its
  date), the value as written and as a number (parentheses and a leading minus negative, a dash no value,
  thousands separators, `%`), unit, **scale as its own field with its wording** (`单位：元`, `in thousands, except per
  share data`), scale factor, section, table number/title/first line, the row's line, parser and confidence.
  Precedence of scale: the cell's own word (`1.2亿`), the row's unit (`（元/股）`), the column's, the table's note;
  per-share and share-count rows are as written where the note says "except per share"; a percentage is a percentage.
  No derived figure is computed.
- **Line numbers count in the text an agent reads at the path** — the file itself, or a converted original's derived
  Markdown — not the indexed text, which carries OKF frontmatter the file may not have.
- The document's subject: the title forms the corpora use (`卡莱特（301391）…`, `X, Inc. annual report (Form 10-K)`,
  a six-digit code with the company name from the cover), else `证券简称`, the 10-K registrant line, the title.

## 2. The model path (stubbed)

A segment (the extraction segmenter's cut) goes to a model only when it is dense with table-shaped numeric lines and
confident tables (≥ 0.7) explain less than 60 % of them. The request numbers the lines; the reply is JSON Lines, one
value cell a line, no cap. A row is kept only if its value is written on the named line (or the next) and its label
start near it; a scale only if the segment states it; scale and period are then read the deterministic way. Replies
are kept in the sidecar's `tables` part by segment hash and replayed while `extraction.tableFacts.model` is on.
`runTableModelPass` makes the calls; nothing schedules it.

## 3. Storage

A separate table, `table_facts`, written by a `tables` scope — a child of the document's `doc` scope, sha = content
sha + parser version (+ replayed segments). Claims were not reused: claims are folded, deduplicated, judged,
superseded and listed on entity pages, each with a cost and a cap, and a report's hundreds of cells would swamp
them; a cell also has fields a claim lacks (period header, scale wording, table, column, line) and needs none of the
claim machinery. Replacing a document disposes the child, which deletes its rows (no `tx_to`: they are re-derivable
from the text, which has its own history); the next sync parses the new text. Turning the switch on parses existing
documents on the next sync without re-applying them; a parser change (`TABLE_PARSER_VERSION`) re-parses once.
`table_label_keys` maps a label key no synonym group holds onto a canonical one, once per distinct key.

## 4. Labels

`labelKey`: numbering, lead words (其中：/减：/Less:), `（损失以“－”号填列）`, bracketed units, `, net`, `(loss)` go;
then ~90 line-item groups holding Chinese and English spellings under one key (`营业收入` = `Revenues` = `revenue`),
then the claim attributes' synonym heads (design 29). The rest can go to a `LabelNormalizer` once per distinct key
(`normalizeTableLabels`; a model normalizer exists, stub-tested); answers land in `table_label_keys` and the view
reads through it. The raw label is always kept and queries match it.

## 5. Query

`v_table_facts` (catalog, read-only; listed in the guide and in `knode_datasources` only while the switch is on), and
`knode_table` (registered only while it is on): metrics × subjects × periods → one row per subject (document) and
metric, one column per period; each cell has the value as written, unit, scale wording and factor, `valueScaled`,
`ref` = `path#Lline`, the matching label and header, and up to three alternatives (another table — a parent-company
statement after the consolidated one — or another column under the same period). `missing` lists the pairs nothing
matched. Ask (`src/search/`) is not wired to it.

## 6. Measured (2026‑11‑24, no model, no build: the parser over the corpus files)

`real-loong-finance`, `numeric` + `single-hop` questions with one evidence document (128; 127 in `packs-next`):
the gold number is among the evidence document's facts — at the gold's scale where it states one — for
**123/128 (0.961)**; zh (pipe) 72/75, en (text) 51/53. The five not covered: two whose number is in no table the
parser reads (a table written one cell per line — model path), two whose gold number is not in the document's text,
and one in a statement with no scale note while the gold says "in thousands".

Model-path segments (12k-character segments): loong 238 of 4,185 (2.7 M characters, 145 documents); mudabench 1,771
of 10,000 (19.4 M characters, 292 documents; zh 1,360, mostly PDF layers with cells broken over lines). Estimate at
~1 token per Han character, ~4 other characters a token, ~35 output tokens a cell: loong ≈ 0.7 M in / 0.7 M out,
mudabench ≈ 8.5 M in / 30 M out. Unmeasured.
