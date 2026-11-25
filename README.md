# knode-os

> Local-first knowledge OS for coding agents — an auto-built **wiki** + **knowledge graph** + **vector recall** over your documents, your agents' traces, and the skills they use. One process, one folder, one PostgreSQL + pgvector index.

[简体中文](./README.zh-CN.md) · [Architecture](./docs/ARCHITECTURE.md) · [Design records](./docs/design/README.md) · [Agent Context Database (v2)](./docs/design/05-agent-context-db.md) · [OKF compatibility](./docs/design/02-okf-compatibility.md) · [Obsidian compatibility](./docs/design/03-obsidian-vault.md)

knode-os combines two ideas — [llm_wiki](https://github.com/nashsu/llm_wiki)'s "the LLM maintains a persistent, interlinked wiki instead of doing RAG from scratch every time" and [gbrain](https://github.com/garrytan/gbrain)'s "markdown is the system of record, Postgres is a disposable derived index" — and points them at what coding agents leave behind: docs, session traces, and skills.

## Highlights

- **One command**: `knode-os serve` starts the web UI, the REST API, a file watcher, periodic trace sync, and the nightly dream.
- **Your filesystem is the database.** A plain data directory (`raw/` + `wiki/`) you can read, edit, grep, and `git init`. The index — PostgreSQL with [pgvector](https://github.com/pgvector/pgvector), one schema per workspace — is derived from it and can be rebuilt at any time with `knode-os rebuild`. For zero setup, opt into the embedded [PGlite](https://pglite.dev) (Postgres + pgvector in WASM) under `.knode/db` instead.
- **Agent traces, collected automatically.** Claude Code (`~/.claude/projects`) and Codex CLI (`~/.codex/sessions`) session transcripts are mirrored into `raw/traces/`; used skills into `raw/skills/`. Traces feed the nightly dream analysis; they stay out of search until `trace.episodes` is on, which prepares each transcript as a searchable episode. Skills are searchable.
- **Hybrid retrieval**: pgvector cosine recall + Postgres full-text + knowledge-graph signals, fused with RRF, with usage heat as a tie-break (it adds at most a few percent to a score). Works offline out of the box (built-in hashing embedder); plug in any OpenAI-compatible embedding endpoint for production quality.
- **SAG multi-hop retrieval**: opt-in `chunk → entity → chunk` event expansion over the existing graph, vector coarse ranking, direct-route fallback, and an inspectable bridge-entity trace for every structural hit.
- **Tiered knowledge graph**: tier 0 wires `[[wikilinks]]` and mines NLP concepts deterministically on every ingest (no LLM); entity co-occurrence is derived from chunk mentions at query time rather than stored. Changed docs are queued for tier-1 LLM entity/relation/claim extraction, which runs in the background while `serve` is up (or via `knode-os extract`), hottest documents first; each pass then checks the entities it wrote for duplicates (a merge stays reversible) and writes the documents' summary pages. Results are persisted to per-document sidecars so a rebuild never re-pays LLM cost. Multi-hop graph search and graph insights (hubs, isolated nodes).
- **Sign-in, and access from anywhere**: accounts on the server (an administrator and the members they create), a sign-in in the web UI and the macOS app, everywhere — on the same Mac too. Other machines come in through a domain (Cloudflare Tunnel), an SSH tunnel the app keeps open itself, or an HTTPS listener on an IP address — with the web UI, the app, or the CLI (`knode-os login <server>`, then `ls`, `read`, `get`, `put`, `grep`, `search`, `ask`, studies, chat and `api` against the server's workspace); each account may use only the API groups allowed it from outside, and selected APIs of other local services can be published under `/gw/<id>` behind the same sign-in. See [docs/remote-access.md](docs/remote-access.md).
- **Estimates before you start**: Start processing and Start research first say what the task will take — model calls, tokens in and out, wall time on the slots that take it, data transfer, cost at API prices — and how much of each plan it uses: Codex's weekly and five-hour windows as Codex itself reports them (read through `codex app-server`, no model call), calibrated on the account's own token history; Cursor and Claude Code against what their plans include. Every answered call is measured (each CLI's and endpoint's own token count, its time and bytes), so the next estimate rests on this machine's numbers rather than defaults. `knode-os estimate`. See [design 18](docs/design/18-estimates.md).
- **Labeling as leased work, on any machine**: processing starts with the service in every workspace (an administrator can stop and start it again in the app, the web UI or `POST /api/labeling/stop|start`, until the next restart); `serve` hands extraction segments, summary pages and the duplicate reviews' judge calls to worker slots — several agents side by side, e.g. Codex and Cursor (`extraction.workers`) — and to remote workers: `worker/knode-worker.mjs` runs Codex, Cursor, Claude Code or an OpenAI-compatible API on another machine and talks to `/remote/v1` with a per-machine token, over an SSH tunnel or public HTTPS. It reads what it may take and how the server runs each stage on each CLI from the server itself. A slow call holds up nothing, rate limits pause a backend instead of burning attempts, a lapsed lease puts its work back in line. Processing and the stage models are one setting for the whole server, kept in the root config and copied into every workspace ([server-wide settings](docs/remote-labeling.md#server-wide-settings)): this machine's slots run at most `processing.maxLocalCalls` calls at once, every workspace together (default 2), and while a Codex or Claude Code plan has less than `processing.minQuotaPercent` left (default 20%) the background work on it — processing, research, Dream and the tier-2 pass — waits until the window resets; Ask still answers. The same API reads, searches and writes the knowledge and answers read-only SQL. See [docs/remote-labeling.md](docs/remote-labeling.md).
- **`/dream`**: every night (or on demand) it digests recent agent sessions — what was asked, which tools failed, what repeats — and proposes improvements to your **skills**, **memory**, and **knowledge base**, queued for one-click accept/reject.
- **Live data sources — one logical database.** Register MySQL, TimescaleDB, parquet/CSV directories (DuckDB, an HDFS stand-in), JSON-over-HTTP endpoints, Prometheus metrics and object stores; knode-os introspects them into the knowledge graph as capabilities (`datasource` / `dataset` entities, `appears_in` links and locators from sampled entity columns — endpoints and metrics get theirs derived from the tables and aliases already known) and generates `wiki/datasets/` pages — while the rows stay in their source systems and are fetched live. Mention a company and the graph knows *which documents*, *which tables* and *which API endpoints* can answer for it.
- **Context packs.** `knode-os pack "<utterance>"` (or the `knode_context_pack` MCP tool) matches entities in the utterance, expands the graph (doc chunks, time-bound claims flagged `STALE`/`CONFLICT`, linked live tables), executes playbook-declared probe queries against the live sources (asOf-stamped, short-TTL cached, never persisted), and returns gap analysis with ready-to-run follow-up SQL.
- **Playbooks that learn.** Context packs are driven by agent-editable `playbooks/packs/*.md` workflows. Every build is logged to `pack_events`; `knode-os pack-optimize` (also part of the nightly dream) turns failure/gap patterns into full playbook revisions — accepted suggestions are written back to `playbooks/packs/`, so the next query runs a better script.
- **MCP server** so Claude Code / Codex (CLI or app) can search, ask, read, write, grep, run native SQL against live sources, and build context packs directly.
- **Pluggable models, storage and stages.** A plugin module (`plugins` in `knode.config.json`) adds LLM providers, embedding providers, storage backends, document converters and user-defined hooks at every processing stage — strip boilerplate before hashing, change chunking, filter tier-0 terms, add a rule to every extraction prompt, post-process what the model returned, restyle summaries, get told when a document lands. The built-ins are registered through the same API; a `command` provider runs any executable as a model with no code at all. See [docs/plugins.md](docs/plugins.md).
- **Native Google OKF v0.2 compatibility**: `wiki/` is itself a portable Open Knowledge Format bundle, with validation, version routing, legacy migration, lossless bundle import/export, and graph wiring for ordinary OKF markdown links. The v0.2 provenance/trust/lifecycle families (`generated`, `verified`, `status`, `stale_after`) are understood, and v0.1 bundles are still read through the spec's documented fallbacks. Unknown types, extension frontmatter and broken links are consumed permissively as the specification requires.
- **Native Obsidian Vault**: open `wiki/` directly in Obsidian. Vault-local settings and an attachment directory are preconfigured; Properties, aliases, tags, `[[wikilinks]]`, vault paths, heading/block references and `![[embeds]]` work natively. Every imported or exported OKF knowledge bundle is also initialized as its own Vault.
- **`ask`**: cited answers from your knowledge base with an explicit "what's missing" gap list.
- **Knowledge benchmarks**: `knode-os eval` gives several knowledge-base approaches the same sources — knode itself, an LLM Wiki in Karpathy's pattern, BM25 / vector / hybrid RAG, GraphRAG, LightRAG, HippoRAG 2, a Codex agent with grep over the raw files, long context and closed book — on packs across research (AI, medicine, law, finance), personal life (chats, email, a diary, a synthetic life with a hidden script) and literature. It scores what each **generated** (fact coverage within a budget, precision, attribution, links, duplicates), how well it is **used** (correctness, citations, abstention, retrieval), what **emerges** (an author's style, a field's open problems, a person's mood and needs), and what it **cost** (build time, tokens, break-even queries). Every system uses the same model through one metered gateway, a Claude judge grades blind, and runs resume item by item. See [design 23](docs/design/23-knowledge-benchmarks.md).
- **Research studies**: give a topic — "starting with Anthropic's latest prospectus, its revenue and cost structure, its value chain, its competitors, what others think" — pick who researches it (Codex, Claude Code, Cursor, the built-in agent, or a deep-research model) and where it may look (the knowledge base, the web, your own MCP servers, APIs and sites). A refiner turns it into a brief you edit — sharper questions, the pages to write, the sources to start from — then collectors gather the material and **keep it**: knode fetches every page, PDF and data file they rely on into `raw/docs/research/<study>/` as originals the pipeline converts (HTML and PDF to Markdown) and indexes like any document. One page per part and a report land in `wiki/research/`, citing those files, with charts as ` ```chart ` data blocks that the web viewer and the macOS app both draw (bar, line, area, stacked bar, horizontal bar, and for comparisons: market share as 100% bars, a scatter of two measures, a waterfall bridge, a timeline of generations by maker). **Export** turns a study into one self-contained HTML file — the report, then its pages, a table of contents, numbered figures with their sources — that reads in any browser and prints to a clean PDF. See [design 15](docs/design/15-research-studies.md).
- **Content languages**: name a primary language for a workspace (and any secondary ones) and every document under `raw/docs` written in another language is translated into it in the background — the Markdown, never the original: a PDF or a web page keeps its file — segment by segment on the Translate stage's agent (Codex, Claude Code, Cursor or any model), with links, cited anchors and code held out of the model's reach and checked back in. The web viewer and the macOS app get a reading-language switcher (the original, or a translation); a secondary language is translated when a reader asks. Summary pages are written in the primary language. The interface language stays each reader's own. See [design 17](docs/design/17-content-languages.md).
- **Feishu documents**: paste Feishu Docs or wiki links — several at once — under **Library → Import data** (or `knode-os feishu import|link <url...>`) and each document lands in `raw/docs/feishu/` as Markdown with its pictures and PDF/text attachments beside it — each picture read by the vision model, a long phone screenshot read in bands rather than squeezed unreadable. A wiki page can bring the pages under it, and a wiki space all of its pages, as folders that keep the wiki's structure. Import once, or link: `serve` asks Feishu once a day which linked documents and wiki pages were edited and re-fetches only those, and **Tasks → Check now** (web UI and app) asks at once. Reading goes through [lark-cli](https://github.com/larksuite/cli) as your Feishu account, authorized once from the app with a device-flow link; no bot is needed, shared documents included. See [design 21](docs/design/21-feishu-documents.md).
- **Feeds**: follow sources that keep producing — Feishu group chats, IMAP mailboxes, X accounts, new arXiv papers, GitHub releases/issues/commits, RSS and every RSSHub route, OpenCLI sites read through your browser, web pages, or a program of yours — with a **filter** layer (is this worth keeping?) and a **transform** layer (what should it look like?) built from rules, your own functions or scripts, models or agents. Chats are judged as conversation windows, mail as threads; what is kept becomes dated Markdown under `raw/docs/feeds/`, and everything pulled stays in a ledger with each stage's decision, so filters can be audited and re-run. `knode-os feeds add|preview|run|items`, a push API (`POST /api/feeds/<id>/items`) and the `knode-feed/1` protocol for your own connectors. See [docs/feeds.md](docs/feeds.md) and [design 26](docs/design/26-feeds.md).
- **Agent conversations**: pick the Claude Code and Codex sessions worth keeping — search this machine's conversations by title and prompt under **Library → Import data → Agent conversations** (or `knode-os conversations list <words>` and `conversations import <id> --follow`) — and each lands in `raw/docs/conversations/<project>/` as dialogue: your prompts, the agent's replies, the answers you gave it and a line naming the tools it used and the files it changed; its thinking, tool output and injected context left out, secrets redacted. Import once, or follow: `serve` looks at followed transcripts every ten minutes and adds new exchanges once a conversation has been quiet, and because earlier exchanges render byte for byte the same, only the new ones are embedded and extracted. One-shot runs by programs (`claude -p`, `codex exec`) are hidden. See [design 24](docs/design/24-agent-conversations.md).
- **Code repositories**: `knode-os codebase add openai/codex` (or any git URL, or a working copy on this machine) fetches one commit — shallow, a branch, tag or commit — and keeps the files a reader of the code needs under `raw/codebase/<name>/`: source in ~60 languages, configuration and prose, never dependencies, build output, lockfiles, generated or binary files. Code is cut along its definitions, each chunk headed by its file and enclosing definition, embedded and keyword-indexed, but never sent to a model file by file; plain search leaves it out, `kinds: ["code"]` (or a `raw/codebase/…` source) asks for it, `knode_grep` and `knode_read` reach it, and research agents read it directly. Each repository also gets a **card** at `raw/docs/codebase/<name>.md` — README, packages and dependencies, layout, documentation index and a code map of the definitions the rest of the code imports most — and its documentation (README, `docs/`) is copied beside it; those go through extraction and summaries like any document. `--follow` has `serve` fetch it again daily and index only what changed. See [design 25](docs/design/25-codebases.md).
- **Books (EPUB)**: an `.epub` under `raw/docs` becomes one Markdown text, its chapters in reading order — titled and leveled by the book's own table of contents (EPUB 3 nav or EPUB 2 NCX), notes the text points at as footnotes, pictures by their path inside the book (shown from inside it, never copied out), title, authors, language, publisher, date and ISBN in the frontmatter. Only the chapters are read, so a 170 MB photo book costs what its text does (EPUBs up to 512 MB are taken); a download cut off before its zip directory is still read, a DRM-protected book is refused by name. The web viewer opens a book whole with a **Contents** jump list; the macOS app adds a Contents menu and opens the original in Books.
- **Mind maps**: drop in a picture of a mind map — an industry chain, a trader's framework — and the vision model reads it back as an outline, not a description: the root as a heading, each branch a bullet under its parent, labels verbatim. Search pieces carry their branch's path (`华为 › 华为智驾 › 液冷超充`), names the graph knows join it as edges to the nearest named node above them (a company `belongs_to_sector` its theme, `produces` its product), and the web viewer draws the tree with folding, its picture beside it, and every known name a link into the graph. A misread label is fixed by editing a transcript kept next to the picture (`map.webp.md`), which is read instead of the model from then on. See [design 19](docs/design/19-mind-maps.md).

## Quickstart

```bash
pnpm install && pnpm build

# the index lives in PostgreSQL with the pgvector extension, on 127.0.0.1:5432 unless the `database`
# block of knode.config.json says otherwise (see Configure models). No server? Run init as
# `KNODE_DATABASE_KIND=pglite node dist/cli.js init …` for the embedded zero-setup index instead.

# initialize a data directory (default ~/.knode-os, or --data <path> / $KNODE_OS_DATA)
node dist/cli.js init --data ~/knode-data

# drop some markdown/text into <data>/raw/docs, then
node dist/cli.js ingest --data ~/knode-data
node dist/cli.js search "vector recall" --data ~/knode-data

# start everything (web UI at http://127.0.0.1:9100)
node dist/cli.js serve --data ~/knode-data

# the first account — or open the web UI on this machine and create it there
node dist/cli.js user add admin --admin --data ~/knode-data
```

Install globally (`npm link` or `pnpm add -g .`) to use the `knode-os` binary directly.

### Data directory

```
<data>/
├── knode.config.json   # embedding / llm / server / dream settings
├── purpose.md          # what this knowledge base is for
├── schema.md           # wiki structure rules
├── raw/                # originals, never rewritten; the raw path is the key of every source
│   ├── docs/           # your uploads (text, PDF, HTML, EPUB, images); research/<study>/ holds what studies captured
│   ├── traces/         # claude/ + codex/ session transcripts (auto-synced)
│   ├── codebase/       # code repositories, one folder each at one commit (`knode-os codebase add`)
│   └── skills/         # skills & prompts your agents used (auto-synced)
├── .sidecar/           # derived state, one directory per source, mirroring the tree above — keep it
│   └── raw/docs/<file>/  # content.md (Markdown converted from a PDF/EPUB/image), meta.json (hashes, chunk map),
│                         # tier0.json / tier1.json (extraction), usage.json (heat), views/ (cached LLM summaries,
│                         # translations/<lang>.md — the text in a content language, docs/design/17)
├── wiki/                 # native OKF v0.2 bundle + Obsidian Vault
│   ├── .obsidian/        # vault settings (never overwrites existing settings)
│   ├── attachments/      # Obsidian attachments
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/  datasets/  research/ (studies: a report + its pages)
├── playbooks/          # agent-editable configuration (edited in Settings → Playbooks)
│   ├── packs/          # context-pack playbooks (revised by the learning loop)
│   ├── concepts/       # tier-0 concept stop list (stoplist.yaml, editable) + learned frequent terms
│   ├── capabilities/   # semantic notes over live datasource capabilities
│   ├── research/       # research templates, phase prompts, profiles; sources/ = MCP servers, APIs, sites a study may use
│   └── intents/        # intent specs: the slots an answer needs
├── plugins/            # optional: plugin modules named in knode.config.json (providers, converters, hooks)
├── ledger/             # events.jsonl (machine truth) + attic/ (sidecars of removed sources)
└── .knode/             # local state; with PGlite also the index itself (db/)
```

Search results cite `raw/docs/...` paths — exactly what you uploaded. Text files are indexed from `raw/` directly (no copies); a PDF or image is converted once into `.sidecar/raw/docs/<file>/content.md`, and opening such a hit in the UI or through `knode_read` shows that Markdown. Unlike the index, the `.sidecar/` tree is not disposable: it holds paid LLM extraction results and usage history, and a rebuild replays them for free.

When `serve` is used with the web UI, `--data` is the workspace root. A user can own multiple workspaces; every workspace is a complete independent data directory with the layout above:

```
<data>/
├── users/<username>/workspaces/<workspace-id>/  # private files, config and wiki; the index is its own PostgreSQL schema
└── teams/<team-name>/                         # shared by users who select the same Team name
```

Create and switch workspaces from the workspace menu. **Settings → Clear workspace** closes its background services, permanently removes the entire workspace directory (files, database, graph, traces and config), then recreates a clean empty skeleton under the same name. Historical trace auto-sync stays paused after creation/clearing; use **Library → Import data → Agent traces** (or **Tasks → Dream → Collect agent traces**) once to import history and resume periodic syncing.

Existing files directly under `<data>/raw`, `<data>/wiki`, and `<data>/.knode` are left untouched and are not migrated automatically. CLI commands such as `ingest` and `search` can target a scoped directory directly, for example `--data ~/.knode-os/users/admin/workspaces/default`.

### Configure models

Each web workspace owns its model config. Use **Settings** after selecting the
Personal or Team workspace, or edit the scoped file directly:

- User workspace: `<data>/users/<username>/workspaces/<workspace-id>/knode.config.json`
- Team: `<data>/teams/<team-name>/knode.config.json`

CLI-only data directories continue to use `<data>/knode.config.json`:

```jsonc
{
  "embedding": {
    "provider": "openai",            // default is "local": offline hashing embedder, 384 dims
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",  // or a literal key
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "database": {                      // where the derived index lives
    "kind": "postgres",              // default: PostgreSQL + pgvector (one shared database, a schema per workspace); "pglite" = embedded, zero setup
    "host": "127.0.0.1", "port": 5432,
    "user": "", "password": "",      // password also takes "env:VAR"; empty for trust/peer auth
    "url": "",                       // or one connection string instead (postgres://…, "env:VAR" too), with "ssl": "require" and "poolSize"
    "database": "knode",             // one shared database, created on first open
    "schemaPrefix": "ws"             // one schema per workspace: <prefix>_<workspace>_<hash>
  },
  "llm": {
    "provider": "openai",            // also: "codex-cli" / "claude-cli" / "cursor-cli", "command" (any executable), or a plugin's
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "gpt-4.1-mini"          // empty = LLM features off, heuristics used
  },
  "extraction": {
    "entityLlm": { "provider": "codex-cli", "model": "" },
    "documentLlm": { "provider": "codex-cli", "model": "" }, // vision: API / Codex / Claude Code
    "summaryLlm": { "provider": "codex-cli", "model": "" },  // one summary page per document
    "judgeLlm": { "provider": "claude-cli", "model": "" },   // knode_ask, Dream, duplicate-entity and claim reviews
    "translateLlm": { "provider": "codex-cli", "model": "" } // documents into the primary content language (starts as summaryLlm)
  },
  "languages": {                     // content languages (docs/design/17); off by default
    "enabled": true,
    "primary": "zh",                 // what the knowledge base is read in: everything else is translated into it
    "secondary": ["en"],             // offered in the readers' switcher, translated on request
    "maxChars": 200000               // longer documents only on request; 0 = no limit
  },
  "retrieval": {
    "sag": { "seedChunks": 12, "entityFrontier": 24, "maxEventsPerEntity": 12, "candidatePool": 120, "maxHops": 2, "directRatio": 0.5 }
  },
  "dream": { "schedule": "03:00", "lookbackDays": 7 },
  "datasources": [                   // live external tables — schema goes into the graph, rows stay put
    { "id": "market-mysql", "kind": "mysql", "host": "127.0.0.1", "port": 3307,
      "user": "knode", "password": "env:MYSQL_PWD", "database": "market",
      "tables": [
        { "name": "companies",
          "entityColumns": [{ "column": "name", "entityType": "organization", "aliasColumns": ["symbol"] }] },
        { "name": "daily_quotes",
          "entityColumns": [{ "column": "symbol", "entityType": "organization" }] }
      ] },
    { "id": "ticks-tsdb", "kind": "timescale", "port": 5433, "database": "market" },
    { "id": "hist-parquet", "kind": "duckdb", "path": "datasets/hdfs" },   // *.parquet and *.csv become views
    { "id": "quote-api", "kind": "http-json", "baseUrl": "https://api.example.com", "freshness": "15s", "cost": 2,
      "headers": { "Authorization": "env:QUOTE_API_KEY" },
      "endpoints": [{ "name": "quote", "path": "/v1/quote", "params": [{ "name": "symbol", "required": true }],
                      "resultPath": "data", "entityParams": [{ "column": "symbol", "entityType": "organization" }] }] }
  ],
  "pack": { "maxEntities": 4, "maxDocs": 6, "maxProbes": 6, "liveTtlSeconds": 30, "staleNewsDays": 7 },
  "plugins": [                       // providers, storage backends, converters and hooks — see docs/plugins.md
    { "module": "./plugins/house-rules.mjs", "options": { "redact": ["CONFIDENTIAL"] } }
  ]
}
```

Any OpenAI-compatible endpoint works (Ollama, vLLM, SiliconFlow, …). `protocol` picks the wire: the default `auto` probes once per endpoint (tokenlessly) for a `/responses` route and prefers it — reasoning models return their thinking as a first-class output item there, while Chat Completions can only smuggle it through a non-standard `message.reasoning_content` — and falls back to `/chat/completions` when there is none. Pin it to `responses` or `chat` to skip the probe. For embeddings, `"provider": "ark-multimodal"` additionally targets Volcengine Ark's `/embeddings/multimodal` route (`doubao-embedding-vision-*`), which is not OpenAI-shaped: it returns one fused vector per request, so `baseUrl` ends at `/api/v3`, `model` is the endpoint id (`ep-…`), and `batchSize` becomes the concurrency window over single-text calls. Document vision, entity extraction, document summaries and judging (`knode_ask`, Dream, the duplicate-entity and claim reviews) each have their own route, which names a model or an agent; a route left empty is written down as the default it would have run on. Image/scanned-PDF conversion supports a vision-capable OpenAI-compatible model, Codex CLI or Claude Code CLI. Text PDFs are extracted locally without an LLM. Changing `dimensions` drops and rebuilds the embedding table on next start. Everything can also be edited from the web UI's **Settings** tab (with route tests).

**Plugins.** `provider` and `database.kind` name ids from a registry, and the built-ins are only its first entries ([docs/design/11](docs/design/11-plugins-and-udfs.md)). A module listed under `plugins` (or in `KNODE_PLUGINS`) may register an LLM provider for a vendor API knode-os does not speak, an embedding provider, a storage backend that reaches a Postgres some other way, a converter for another file type (`.docx`, `.mobi`, …), and hooks at the processing stages: `source.text`, `chunk`, `tier0.concepts`, `extract.request`, `extract.result`, `summary.request`, `document.applied`. The `command` provider needs no plugin: `cliPath` names an executable that gets `{ messages, model, json, maxTokens, images }` on stdin and answers on stdout, with the connection's key in `KNODE_LLM_API_KEY`. `database.url` takes a connection string (`env:DATABASE_URL` too) with `ssl` and `poolSize`; `database.path` moves a PGlite index. `knode-os plugins` and `GET /api/config/providers` show what is registered. Walkthrough and examples: [docs/plugins.md](docs/plugins.md), [demo/plugins](demo/plugins/README.md).

The index lives in PostgreSQL with pgvector by default: all workspaces share one database and are isolated by schema, each created on first open — so are the database and the `vector` extension when the server lacks them, which is why pgvector must be installed there. PGlite is the opt-in alternative: the same schema embedded in the process under `<workspace>/.knode/db`, with nothing to install — set `KNODE_DATABASE_KIND=pglite` before the first run, or `database.kind: "pglite"`; the test suite runs on it too. It suits small workspaces: it is a single-process 32-bit WASM build that tops out around a million chunks, lets one process at a time open the index (enforced: a second open, in the same process or another, fails naming the holder; the lock is `<workspace>/.knode/db.lock`, and one left by a killed process is reclaimed on the next open), and answers queries on Node's event loop, so a long query holds up the whole server meanwhile. Schema-level isolation is deliberate — a database would carry its own ~8 MB catalog per workspace, while folding every workspace into shared tables keyed by a workspace column would cost the vector index outright: HNSW walks a distance-ordered neighbour graph, so an equality predicate on a scalar column cannot be pushed into the walk and the planner falls back to a sequential scan. Embedding vectors are stored as `halfvec`: pgvector caps an index entry at one 8 KB page, which is 2000 dims for `vector` but 4000 for `halfvec`, so half precision is what keeps the HNSW index reachable at 1536/2048 dims — and halves the table. Switching an existing database between the two column types converts in place without re-embedding.

Further config blocks (see `knode-os config` for the full active set with defaults): `ingest` (chunk size/overlap, file watching, `linkedFolders` — the folders `knode-os folders link` mirrors under raw/docs), `extraction` (batch size and interval of the background document pass, tier-1 model, claims on/off, `workers` — the labeling slots `serve` runs per agent —, `summaryConcurrency` and `summaryAfterExtraction` — false writes summary pages before extraction is done), `retrieval.sag` (seed/frontier/candidate limits, hop count, direct-route ratio), `heat` (usage-heat half-life; `searchWeight`, the most heat can add to a fused search score — 0.05 = +5%, enough to break near-ties, never to lift a result above a clearly better match; cold threshold), `trace` (Claude/Codex trace directories, skill dirs, sync interval), `server` (host/port, `server.mcp` — the Streamable HTTP MCP endpoint `serve` hosts at `/mcp` —, `server.remote` — the token-authenticated remote API at `/remote/v1`: `enabled`, `leaseMinutes`, `maxBodyBytes` —, `server.auth` — sign-in: `enabled`, `sessionDays`, `allowInsecureRemote` —, `server.tls` — an HTTPS listener beside the main one: `port`, `host`, `cert`, `key` — and `server.embed.allowedOrigins` — the exact origins whose pages may frame the reader at `/embed/v1` and import `/embed/sdk.js`, see [docs/remote-access.md](docs/remote-access.md#embedding-a-reader-in-another-app)), `graph.ontologyPacks` (which `playbooks/ontology/*.yaml` packs define entity and relation types; built-ins `core`, `organization` and the opt-in `finance` — markets, indices, securities, funds, sectors, themes, indicators, policies and who holds, recommends or forecasts what), `research` (which agent writes deep-research wiki pages: `agent` = a named agent from `playbooks/agents/` (Settings → Providers & Agents) — deepagents on one of the models, or a coding-agent CLI with its own path, model and effort — or, as configs written before named agents have it, `claude-cli` / `codex-cli` / `cursor-cli`, a connection id, or `default` for the section-01 connection — an OpenAI-compatible one runs the built-in agent, so no coding-agent CLI is needed; empty = not configured, `model`, `profile` = a research profile under `playbooks/research/profiles/` (reasoning effort, web search freshness, verification bar and the sub-agent roles, each with its own CLI, model, tools and prompt — built-ins `default` / `quick` / `thorough` / `native`, editable in Settings → Research), `pipeline` = `team` (plan, parallel research, synthesize, review, revise), `native` (one session with the roles as the CLI's own sub-agents) or `single`, `maxTurns`, `timeoutMs`, `concurrency`, `readDirs`, `researchers`, `reviewRounds`, `auto.enabled` / `auto.dailyJobs`), `research.init` (the initialize button always first extracts what the tier-1 queue still holds, for up to `extractionMaxMs` — edited with the Extract stage under Settings → Ingest — then queues up to `followUps` topic pages), `chat` (the agent behind Ask: `agent` — a named agent, a connection id, a CLI, or `default` for the section-01 connection, which is also the shipped value — plus `model`, `historyTurns` and `keep`; model, effort and web access come from the agent's own `playbooks/agents/<name>.yaml`, and the turn cap, timeout and tools are the same for every agent) and `review` (how much checking sits between extraction and the graph: `resolution` = `exact` | `suffix` for write-time merges, `llmJudge` = `off` | `suggest` | `auto` with `llmMinConfidence` / `autoMergeMinConfidence`, `claims` = `off` | `suggest`, `external` = `off` | `verify` | `research` for the agent's web tools). See [docs/design/06](docs/design/06-wiki-research-agent.md) and [docs/design/07](docs/design/07-init-and-chat.md).

The LLM unlocks: tier-1 entity/relation/claim extraction into the graph with a duplicate-entity review right after it, one summary page per document, `ask` answers, the nightly claim review, and LLM-grade dream analysis; concept pages come from research agents ([docs/design/09](docs/design/09-ingest-stage-rework.md)). Without it, everything still runs on deterministic/heuristic paths.

## CLI

```
knode-os init                 create the data directory layout + database
knode-os serve [-p port]      web UI + API + watcher + trace sync + background document pass
                              (extract → resolve duplicates → summarize)
                              + usage-stats flush + nightly dream & tier-2 pass
knode-os sync [--only p..] [--verify] [--no-llm] [--no-datasources] [--reapply] [--defer-embeddings]
                                      # --reapply: recompute tier-0 for unchanged documents too (chunks and vectors kept)
knode-os concepts learn [--ratio 0.02]  # learn the corpus-frequent stop terms into playbooks/concepts/frequent.yaml
                              reconcile declared sources (raw/docs, wiki, skills, datasources) with
                              the index: apply changed files as scopes, dispose removed ones (every
                              effect reverted), regenerate dependent wiki views. `ingest` is an alias.
knode-os lineage show <entity|relation|claim|page|document> <id>
                              evidence behind a graph row (source scope, extractor, time window)
knode-os history <path>       apply / dispose / purge history of a source
knode-os forget <path>        delete a source, dispose it and purge its history (irreversible)
knode-os purge [--before iso] [--archived]  erase disposed history / archived pages
knode-os rebuild [--history]  drop the index (the workspace's PostgreSQL schema, or .knode/db with PGlite) and
                              reconstruct it from files + ledger
knode-os datasource list|sync             registered live tables / re-introspect schemas into the graph
knode-os datasource query <id> <sql>      read-only native SQL against a configured source
knode-os pack <utterance> [--json] [--as-of iso] [--valid-at iso]
                                          build a context pack (entities + evidence + live probes + gaps)
knode-os pack-optimize [--apply]          learn from pack_events → playbook revision suggestions
knode-os demo seed-stock                  stock-analysis demo data (see demo/stock/README.md)
knode-os estimate [processing | study <id>] [--json]  what a task would take before it starts: calls, tokens,
                              time, transfer, cost at API prices, and each plan's share (Codex, Cursor, Claude Code)
knode-os extract [--batch n] [--concurrency n]  one document pass: extract a batch, resolve duplicates, summarize
knode-os translate <path…> [--lang zh] | --status   translate documents now on the Translate route / translations by language
knode-os remote token create --name <machine> --scope label,read,write,sql --workspace <user>/<ws>
                              per-machine tokens for the remote API (also: `remote token list | revoke`)
knode-os user add <name> [--admin] [--read-only] [--team t] [--remote-apis groups] [--gateway id]
                              accounts that may sign in (also: `user list | set | passwd | signout | remove | token | sessions`)
knode-os gateway add <id> <http://127.0.0.1:port/path>   publish a local service under /gw/<id> (also: `gateway list | remove`)
knode-os tls init [--host ip-or-name]   self-signed certificate for the HTTPS listener (server.tls)
knode-os bench build          full build (ingest → tier-1 drain → wiki) with per-stage timing report
knode-os bench qa-gen [--n]   generate a QA eval set (eval/qa.jsonl) from stratified chunk samples
knode-os bench retrieval      recall@k / MRR / NDCG@10 for vector|keyword|hybrid|sag|graph over the QA set
knode-os bench answer [--n]   end-to-end ask() quality, graded by an LLM judge
knode-os bench extract-compare [--backends ..]  same-doc extraction shootout: openai vs codex-cli vs claude-cli
knode-os eval pack build <recipe>   build a benchmark pack (corpus, gold, tasks) into ~/knode-eval/packs (also: `pack list | validate`)
knode-os eval systems install <id>  GraphRAG / LightRAG / HippoRAG 2 in an isolated uv venv (also: `systems list`)
knode-os eval run --pack a,b [--systems ..] [--config-from <ws>] [--model m]   compare knowledge-base approaches on the same sources
knode-os eval report <runDir>       leaderboard, build cost, break-even, paired tests vs the grep agent (also: `audit export | import`)
knode-os search <q> [-m hybrid|vector|keyword|sag] [-k n] [--as-of iso] [--json]
knode-os ask <question> [-m hybrid|vector|keyword|sag]  cited answer + gaps (needs llm.model)
knode-os graph [q] [--depth n] [--as-of iso] [--valid-at iso] [--insights] [--json]
                              (no query: top-entity overview; --as-of recomputes from evidence)
knode-os obsidian init [dir]           initialize/repair a Vault (default: <data>/wiki)
knode-os obsidian status [dir]         check whether a Vault is ready to open
knode-os okf validate [bundle] [--json]  validate OKF v0.2 (defaults to <data>/wiki)
knode-os okf migrate [--dry-run]         migrate a legacy wiki structure to OKF v0.2
knode-os okf import <bundle> [--name n]  losslessly import under raw/docs/okf/<name>
knode-os okf export <dir>                validate and export the native wiki bundle
knode-os folders import <folder> [--to d] [--replace]  copy a folder from this machine into raw/docs/<name>,
                              its tree intact, and index it (only text, PDF, EPUB and image files travel)
knode-os folders link <folder> [--to d]   the same, remembered: `serve` watches the folder and mirrors every
                              change — adds, edits, deletions — into the index as it happens
knode-os folders list | sync [dest] | unlink <dest> [--remove-files]
knode-os codebase add <owner/repo|url|path> [--ref r] [--include g] [--exclude g] [--follow] [--no-docs]
                              keep one commit of a code repository under raw/codebase/<name> (code searchable as kind
                              "code"), its card and documentation under raw/docs/codebase (also: update [name] | list |
                              edit <name> | remove <name> [--keep-files]; design 25)
knode-os wiki generate        summary pages still missing + entity pages (every claim with its source) and their index
knode-os wiki refine          tier-2: claim audit + full duplicate audit + claim review + hot topics + research recommendations
knode-os trace sync           pull new Claude Code / Codex traces + skills
knode-os dream [--lookback d] sync traces, then analyze → skills/memory/knowledge suggestions
knode-os mcp                  MCP server on stdio (standalone; next to a running serve use --http below)
knode-os connect claude|codex|cursor [--stdio]  register the MCP endpoint serve hosts (Streamable HTTP; --stdio for a standalone process)
knode-os research init [--now]   initialize the knowledge base: sync + extraction, then the agent writes
                              wiki/overview.md and the AGENTS.md / CLAUDE.md guide later agents read, and queues topic pages
knode-os research queue <kind> <target> [--now]   have the research agent write a wiki page (entity|concept|comparison|timeline|question|refresh|init)
knode-os research ask "<question>"   answer a question and file it as wiki/questions/<slug>.md
knode-os research list|show|run|cancel|retry|resume|recommend|templates|export|reclaim
knode-os research profiles | profile <name> [--use]   research profiles: effort, web search, verification, sub-agent roles and prompts
knode-os research study new "<topic>" [--agent codex-cli] [--no-web] [--sources a,b] [--deep-research conn:model] [--start | --now]
                              a study: the topic refined into a brief (questions, pages, seed sources); --start queues it,
                              --now runs collect → pages → report here (also: study refine <id> [feedback] [--answer "q=a"],
                              study start | run | show | list [--archived] | cancel | retry | resume | archive | unarchive | remove;
                              a run refused for a spent usage limit waits for its reset instead of failing — design 22)
knode-os research capture <url> [--study <id>]   keep a web page / PDF / data file under raw/docs/research, converted and indexed
knode-os research sources     the research sources under playbooks/research/sources (MCP servers, APIs, sites, datasources)
knode-os chat "<message>" [-c <conversation>]   talk to the configured CLI about the knowledge base (it answers over MCP
                              and writes what you teach it as a quarantined note); `chat list` shows recent conversations
knode-os entities merge|unmerge|merges|dedupe|resolve   entity resolution: reversible merges and the duplicate audit
knode-os entities relink       recompute every document's tier-0 links after a stop-list edit or a surface-rule change
knode-os entities correct <entity> [--type t] [--not-alias s...] [--clear]   correct one entity by hand: its type, spellings it
                              does not answer to (playbooks/entities/corrections.yaml); `entities corrections` lists them
knode-os review entities|claims   the review passes (LLM judge over duplicate candidates; verdicts on disputed / suspected claims)
knode-os wiki lint             orphans, broken links, stale / unreviewed research pages, expired and superseded text
knode-os wiki prune-summaries [--dry-run] [--min-chars n]   archive the summary pages of documents under extraction.summaryMinChars
knode-os config               show active config (redacted)
knode-os plugins [--json]     the plugins this data directory loads and what they — and the built-ins — provide
knode-os ls|tree|stat|read|grep [path]   the workspace as a filesystem: list, draw, describe, print (PDFs and pictures
                              by their derived Markdown), search contents
knode-os stats | survey | entities list|show   the base in numbers; its entities

knode-os login <server> [--user u] [--workspace finance]   sign in to a knode-os server from another machine: the
                              commands above, search, ask, graph, claims, sync, studies and chat then answer from it
knode-os whoami | workspaces | use <workspace> | logout   which server, account and workspace; switch; sign out
knode-os get <path…> | put <file…> [--to raw/docs/x] | write | mkdir | mv | rm   download, upload and change files on it
knode-os tasks | sessions | password | api <route>   what it works on; your sessions and password; any REST route
```

Every command takes `--data <path>` (or set `KNODE_OS_DATA`), which also keeps it on this machine while signed in to a
server. Using the CLI from another machine: [docs/remote-access.md](docs/remote-access.md#from-the-command-line-on-another-machine).

## Use from Claude Code / Codex

```bash
knode-os connect claude   # registers http://127.0.0.1:9100/mcp (Streamable HTTP; bearer token in <data>/.knode/mcp-token) with claude mcp add
knode-os connect codex    # codex mcp add --url … --bearer-token-env-var KNODE_MCP_TOKEN (export the token in your shell)
knode-os connect cursor   # writes the endpoint into ~/.cursor/mcp.json
knode-os connect claude --stdio   # without a running serve: a standalone `knode-os mcp` process (opens the index itself)
```

MCP tools exposed: `knode_resolve` (the one to call first — see below), `knode_capture` (keep a web page / PDF / data file as a source under raw/docs/research and get the path to cite), `knode_web_fetch`, `knode_web_search` (when `research.web.search` names a provider), `knode_api` (a configured API source), `knode_chart` (check a chart block: bar, hbar, line, area, stacked-bar, share, scatter, waterfall or timeline), `knode_study` (research studies), `knode_plan`, `knode_feedback`, `knode_capabilities`, `knode_checkout` / `knode_commit` / `knode_worksets` (pin a consistent view for a long task, then write conclusions back as a source), `knode_absences` (what we looked for and did not find), `knode_disputes` / `knode_trust` (contradictions, and promoting a quarantined write), `knode_subscribe` (watch an entity, source or intent), `knode_learning` (what the planner has learned), `knode_search`, `knode_graph_search`, `knode_claims`, `knode_ask`, `knode_ls`, `knode_read` (a path starting with `/` reads the virtual filesystem; a PDF or image under raw/docs returns its derived Markdown), `knode_write` (wiki/, raw/docs and playbooks/packs/ only), `knode_grep`, `knode_ingest` / `knode_sync`, `knode_lineage`, `knode_history`, `knode_forget`, `knode_okf_validate`, `knode_graph_insights`, `knode_survey` (what this base holds, in numbers — the orientation call for an unfamiliar workspace), `knode_suggestions`, `knode_context_pack`, `knode_datasources`, `knode_query` (read-only native SQL; `source="catalog"` queries the knowledge base's own `v_*` views). The MCP server also hands every client the base's own guide (`AGENTS.md`) as its instructions. Three independent time axes: `as_of` (system time — what was believed then), `valid_at` / `valid_range` (world time — when a claim holds), and `freshness` (how old a live read may be); `kinds` / `sources` bound which sources may answer.

**`knode_resolve` instead of search.** Search returns whatever text matches. `resolve` works out what an answer to this *kind* of question needs — the slots declared in `playbooks/intents/*.yaml` — fills everything the local index can answer, and compiles what is left into a plan of tool calls the agent executes. A required slot nothing can fill comes back in `unknowns` rather than being papered over with plausible documents. Report back with `knode_feedback` and the receipt id, and the next resolve for that kind of question is better.

**The loop actually closes.** Feedback feeds a ranker that learns which capability answers which slot — scored on what the caller *kept*, not on what returned rows — and explores with Thompson sampling so a source that lost one coin flip still gets tried again. Plan shapes that keep working are distilled into recipe proposals, replayed offline against the receipts they came from and checked for read-only safety, then held for human approval; nothing is published automatically. `knode-os learning` prints all of it, and `wiki/learning/` keeps it reviewable.

**Agent writes are quarantined.** Anything an agent commits is indexed, searchable and attributable, but cannot silently become the knowledge base's position: where it disagrees with a trusted claim, a dispute is opened rather than the claim overwritten. Promote it with `knode_trust` once a person has looked. Empty lookups are recorded as negative knowledge with an expiry, so the same fruitless query is not re-run every session — and starts being tried again once the window closes.

Typical loop: your agent searches before re-deriving project knowledge, writes new conclusions to `wiki/concepts/…` via `knode_write`, and the next session finds them.

## Web UI

`knode-os serve` → http://127.0.0.1:9100 — sign in with an account of the server (the first one is created on this machine, with `knode-os user add` or on the first screen). The same UI works from other machines through a domain, an SSH tunnel or the HTTPS listener ([docs/remote-access.md](docs/remote-access.md)).

Five sections, each with its own tabs ([design 20](docs/design/20-explore-and-tasks.md)). The search box at the top of every view (⌘K or `/`) offers entities and files by name as you type, and sends the text to **Search**, **Ask** or **Research**.

- **Library** — what is in the box
  - **Files** — browse the tree, edit markdown with preview, upload text/PDF/EPUB/images to `raw/docs` (auto-converts and ingests; PDF, image, web-page and book hits open as the Markdown derived from them, and **original ↗** opens the file itself in a new tab — a saved page with its script off; a book (EPUB) opens whole, with its pictures read from inside it, a **Contents** list of its chapters and sections, and **original ↓** to save the .epub); with content languages on, a document opens in the reader's language — the switcher in its toolbar picks the original or a translation, remembered per browser, and offers **translate** where none exists yet (a translation is read-only); **Import data** brings material in — files or a folder uploaded from disk, a folder from this Mac by its path with its directory structure kept (copied once, or linked so that `serve` keeps the copy in sync with the original; a linked folder shows 🔗 in the tree and is read-only there), and your Claude Code and Codex sessions into `raw/traces/`; **＋ new** makes a file or a folder; a file under `raw/docs` lists the wiki pages that cite it — **cited by**, from their `[[raw/docs/…]]` and Markdown links, `sources:` (derived from) and `relations:` such as `tested_by` ([how to write them](docs/frontmatter-contract.zh-CN.md)); the tree leaves the system folders out — `ledger/`, `playbooks/` (edited in **Settings → Playbooks**), and `wiki/lint/` and `wiki/datasets/`, whose news arrives as notices — and shows beside each folder knode-os makes what it is for; `purpose.md` and `schema.md` open for editing here, and no agent writes them
- **Explore** — look things up, at three depths
  - **Search** — what a query matches, channel by channel: every passage with its rank in the semantic, keyword and entity channels (or, multi-hop, the entities it was reached through) and why the fused score came out as it did; the channels' hit counts, which filter the list; the terms keyword and entity matching looked for; passages grouped by document on request; and beside them the entities the query names — by name, alias or description, it says which — the entities one relation away, the relations between them and the claims about them. Scopable to the folder picked in Files
  - **Ask** — one question, one agent session. The configured agent answers over MCP, follows leads across turns, and writes what you teach it as a quarantined note you can adopt. With nothing named it runs on the section-01 default connection, so Ask works as soon as any model is configured; the screen says what to configure when even that is unset.
  - **Research** — studies, a topic researched into several pages: describe what you want to understand, pick the agent (or a deep-research model), the depth and the sources, and refine: the brief comes back with sharper questions, the pages it plans and the sources it starts from, plus questions for you; edit it, answer, refine again, start. A running study shows its stages, the sources it captured (title, site, date, file), the collectors' notes, each page and the report — promote the pages or the sources in one click, read the sessions' logs, and **Export ↗** the report and pages as one HTML file to read, save or print to PDF
- **Knowledge** — what the system made of it
  - **Graph** — the knowledge graph the way Obsidian draws one: a force layout that settles and sleeps (the same d3-force parameters as the web graph, so both settle alike), nodes sized by their links and coloured by type, the reply's communities laid out as islands of their own (each titled with its hub and listed in the side panel; a setting turns it off), hover isolates a neighbourhood, zoom/pan/drag, labels that fade in with zoom, a legend that hides types, and a settings popover for filters, display and forces (kept across launches); an empty search is the overview, a name is the local graph around it; plus insights (hubs / isolated / types)
  - **Entities** — every entity in a table the service pages, filters and sorts: mentions, documents, relations, evidence and which extractors wrote it; a name opens its local graph, a row's wiki page opens in Files
  - **Wiki** — one button initializes the knowledge base (survey → overview page + `AGENTS.md` guide + queued topic pages), then queue and review deep-research pages
- **Tasks** — what runs, and what it is waiting on
  - **Queue** — processing (started after an estimate of what it will take, and stopped) and the pipeline stage by stage — index, embed, extract, summarize, translate, review — with what waits, what is out and what was done in the last hour; every model call out now with its document, its part and the worker holding it; this machine's slots and the remote workers (online, busy, resting and why); research, studies and Ask turns; background syncs and imports; and the schedule — Dream, the tier-2 pass, trace collection, datasources, linked folders. The header's processing pill says whether it runs and how much is out, and opens it
  - **Dream** — when it runs next, run it now, review and accept/reject its suggestions, and the agent traces it reads (a row opens its mirrored file under `raw/traces/`)
- **Settings** — **Providers & Agents** (every model endpoint and key once, embedding and LLM in one table — `llmUse` marks which LLM is the default, and every job that names no provider of its own follows it — and the agents in a second table below: deepagents on one of those models, or a coding-agent CLI (Claude Code / Codex / Cursor) with its own path, model and effort. A CLI is an agent, not a model), **Ingest** (independently routed entity/concept/document-vision stages — and Translate, with the content languages — each naming the model or agent it runs on — any agent is called one-shot, and a stage no longer follows the default; saving re-embeds or refreshes conversions when needed), **Research**, **Sources** (the web settings (a search API for agents without their own, User-Agent, proxy) and your own sources: MCP servers, JSON APIs with declared endpoints, trusted sites with seed URLs, live datasources), **Ask** (which agent answers, how many recent messages each reply replays, how many conversations are kept), **Playbooks** (the files under `playbooks/`, grouped the way knode-os reads them — research templates and phases, context packs, intents, ontology packs, the concept stop list, capability notes, Ask's protocol and turn prompt — each editable, revertable and resettable to the version knode-os ships, with YAML and templates checked before a save; agents, research profiles and sources point to the page that edits them), **Workspace**, **Access** (your password and sessions; for an administrator, the users of the server and the gateways it publishes). The middle three follow knowledge through the workspace: processed as it comes in, researched into the wiki, used to answer. Members see settings read-only

**Notices** (⚑ in the header) say what the workspace needs from you, each with its one action: the latest wiki check (findings by kind, the change since the report before, **Open report**), datasources that failed on the last sync (**Retry**), trace collection still waiting for a yes (**Collect traces**, which says how many sessions it copies), a `purpose.md` that is still the template (**Edit purpose.md**) and a wiki never initialized (**Go to Initialize**). A dismissed notice returns when it changes.

## REST API

`GET /api/health · /api/config · /api/config/providers · /api/plugins · /api/stats · /api/notices · /api/playbooks · /api/playbooks/file?path · /api/tree[?path&depth&dirs] · /api/file · /api/file/citations?path · /api/file/original?path (the PDF, picture or saved page itself; a link may name the workspace as `kind`, `id`, `name`) · /api/search[?as_of] · /api/search/explore?q[&mode&k&sources] (passages with each channel's rank, the entities the query names, their relations and claims) · /api/search/suggest?q[&limit] · /api/tasks (the queue: stages, calls out, workers, jobs, background work, schedule) · /api/grep · /api/graph[?as_of&valid_at&limit&types&edges] (each node with its `community`, and the `communities` the view draws as islands) · /api/graph/insights · /api/entities[?q&type&sort&order&offset&limit&merged] · /api/documents · /api/datasources · /api/okf/validate · /api/traces · /api/suggestions · /api/lineage?kind&id · /api/history?path`
Research studies: `GET/POST /api/research/studies` · `GET/PUT/DELETE /api/research/studies/:id` · `POST /api/research/studies/:id/refine | start | cancel | retry | promote` · `GET /api/research/studies/:id/log?label` · `GET /api/research/studies/:id/export[?download=1]` (one HTML file) · `POST /api/research/capture` · `GET /api/research/captures` · `GET /api/research/sources` · `PUT/DELETE /api/research/sources/:id`
Content languages: `GET /api/languages` · `GET /api/file?path&lang` (the document in that language where a translation exists, with `languages` saying where each one stands) · `POST /api/file/translate` (`{ path, lang, cancel? }`)
`PUT /api/config` · `PUT /api/file` · `PUT /api/playbooks/file` · `DELETE /api/playbooks/file` (resets to the built-in) · `DELETE /api/file` (disposes the source) · `POST /api/config/test | /api/upload | /api/ingest | /api/sync | /api/forget | /api/purge | /api/rebuild | /api/ask | /api/pack | /api/mv | /api/mkdir | /api/datasources/sync | /api/datasources/:id/query | /api/traces/sync | /api/dream | /api/wiki/generate | /api/suggestions/:id/status` · folders from this machine: `GET /api/folders` · `POST /api/folders/preview | /api/folders/import` (`{ source, dest?, mode: copy | link, replace? }`) `| /api/folders/sync` · `DELETE /api/folders?dest=…&removeFiles=1`

Every route needs a session — a signed-in browser's cookie, or `Authorization: Bearer knu_…` (the app's, or a script's from `knode-os user token`) — and the route's API group; sign-in itself is under `/api/auth/*` ([docs/remote-access.md](docs/remote-access.md)). Workspace-scoped data APIs also take `X-Knode-Workspace-Kind` (`personal` or `team`), `X-Knode-Workspace-ID`, and `X-Knode-Workspace-Name`; the workspace's owner is the signed-in account (`X-Knode-User` names it only with sign-in off). `DELETE /api/workspace` completely clears the selected workspace.

## Development

```bash
pnpm dev -- serve --data ./.dev-data   # tsx, no build
pnpm typecheck && pnpm test            # tsc + vitest
```

## Security notes

The server binds to `127.0.0.1` and asks every client to sign in — the browser, the app and scripts, local or not (`src/auth`): scrypt-hashed passwords, sessions stored as hashes, sign-in throttled per address and per name, CSRF-guarded browser writes. Requests from other machines must arrive over HTTPS (through a tunnel, or the `server.tls` listener) and reach only the API groups their account is allowed from outside; `/mcp` answers this machine only; `serve` refuses to listen where other machines would reach it over plain HTTP. Members never change settings, and open only their own workspaces and the Teams given them; a read-only member changes nothing at all — but Ask and Research run coding agents on the server's machine, so give those only to people you trust with it. Remote labeling workers use per-machine tokens on `/remote/v1` (hashed at rest, scoped by workspace and capability, rate-limited, audited) — see [docs/remote-access.md](docs/remote-access.md) and [docs/remote-labeling.md](docs/remote-labeling.md). API keys can be referenced as `env:VAR` so the config file stays secret-free. File APIs are confined to the selected workspace directory (path-traversal guarded); write/move/delete operations — both HTTP and MCP — are restricted to `wiki/`, `raw/docs/` and `playbooks/packs/` (plus `purpose.md` and `schema.md` over HTTP only, and the other playbooks through Settings by an administrator), and never reach the system-owned `.sidecar/` tree. Native SQL against configured datasources is kept read-only by the database, not only by a text check: a guard that reads the statement by the source's own lexical rules (MySQL's for MySQL, PostgreSQL's for TimescaleDB and DuckDB) refuses early — one statement, SELECT/SHOW/DESCRIBE/EXPLAIN/WITH, no write keyword — and the connector then runs it alone, in a read-only transaction that is always rolled back, under a statement timeout, with rows capped; a DuckDB source can read only the files behind its own views. Still, point knode-os at read-only database credentials: what reaches outside the transaction (dblink, the server's files) is only as limited as the database user, and on MariaDB a single statement can lift the read-only mode for itself (`SET STATEMENT … FOR`, `BEGIN NOT ATOMIC … END`), which only the guard refuses.

## License

MIT
