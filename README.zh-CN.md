# knode-os

> 面向 coding agent 的本地优先知识操作系统 —— 在你的文档、agent 执行 trace 和用过的 skills 之上,自动构建 **wiki** + **知识图谱** + **向量召回**。一个进程、一个文件夹、一个 PostgreSQL + pgvector 索引。

[English](./README.md) · [架构（当前实现，英文）](./docs/ARCHITECTURE.md) · [设计记录](./docs/design/README.md) · [Agent Context Database（v2 重设计）](./docs/design/05-agent-context-db.zh-CN.md) · [OKF 兼容设计](./docs/design/02-okf-compatibility.md) · [Obsidian 兼容设计](./docs/design/03-obsidian-vault.md)

knode-os 结合了两个项目的核心思想:[llm_wiki](https://github.com/nashsu/llm_wiki) 的"让 LLM 维护一个持久、互链的 wiki,而不是每次从零做 RAG",以及 [gbrain](https://github.com/garrytan/gbrain) 的"Markdown 是事实源,Postgres 只是可随时重建的派生索引"——并把它们对准 coding agent 留下的资产:文档、会话 trace、skills。

## 特性

- **一条命令**:`knode-os serve` 同时启动 Web 页面、REST API、文件监听、trace 定时同步和夜间 dream。
- **文件系统即数据库。** 数据目录(`raw/` + `wiki/`)就是普通的 markdown 文件,可以直接读、改、grep、`git init`。索引放在 PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) 里,每个工作区一个 schema,由这些文件派生,随时可用 `knode-os rebuild` 重建。想零配置,也可以改用内嵌在 `.knode/db` 的 [PGlite](https://pglite.dev)(WASM 版 Postgres + pgvector)。
- **自动收集 agent trace。** Claude Code(`~/.claude/projects`)与 Codex CLI(`~/.codex/sessions`)的会话记录自动镜像到 `raw/traces/`,用过的 skills 进 `raw/skills/`。trace 供夜间 dream 分析使用;打开 `trace.episodes` 后会把每段会话备成可检索的 episode，在此之前不进检索索引。skills 一直可被检索。
- **混合检索**:pgvector 余弦召回 + Postgres 全文检索 + 图谱信号,RRF 融合,并叠加温和的使用热度加权。开箱即用、完全离线(内置哈希 embedder);配置任意 OpenAI 兼容的 embedding 接口可获得生产级效果。
- **分层知识图谱**:tier 0 在每次摄入时做确定性布线(`[[wikilink]]` + NLP 概念共现,不需要 LLM);变更文档进入 tier-1 队列,由 `serve` 后台(或 `knode-os extract`)按热度优先做 LLM 实体/关系/断言抽取;每轮抽取后随即检查这一轮写到的实体有没有重复(合并可撤销),并给这些文档写摘要页。抽取结果持久化到文档 sidecar,重建索引不会重复付费。支持多跳图搜索与图谱洞察(枢纽节点、孤立节点)。
- **真实登录,随处可访问**:账号保存在服务端(管理员,以及管理员创建的成员),Web 页面与 macOS 应用都要登录——同一台 Mac 上也一样。其他机器可以经域名(Cloudflare Tunnel)、应用自己维持的 SSH 隧道,或 IP 地址上的 HTTPS 监听访问;每个账号从外部只能用允许它的 API 分组,还可以把本机其他服务的部分 API 发布在 `/gw/<id>` 下,用同一套登录保护。详见 [docs/remote-access.md](docs/remote-access.md)。
- **开始之前先估算**:点「开始处理」或「开始研究」时，先说明这项任务要花多少——模型调用次数、输入与输出 token、在领取它的槽位上要跑多久、数据传输量、按 API 价格的费用——以及占用各个套餐多少：Codex 的每周与 5 小时窗口按 Codex 自己报告的用量读取(经 `codex app-server`，不发起模型调用)，并用账号自己的 token 历史校准；Cursor 与 Claude Code 按其套餐包含的额度计算。每次完成的调用都会被计量(各 CLI 与接口自报的 token 数、耗时与字节数)，所以下一次估算依据的是本机实测数据而非默认值。命令行：`knode-os estimate`。详见 [设计 18](docs/design/18-estimates.md)。
- **标注即租约,可在任意机器上跑**:管理员启动处理之后(在应用、Web 页面或 `POST /api/labeling/start` 中启动——`serve` 不会自行启动),`serve` 把抽取分段、摘要页和去重审查的判定调用交给本机的工作槽位(可同时跑多个 agent,例如 Codex 与 Cursor,见 `extraction.workers`),也交给远程工作者:`worker/knode-worker.mjs` 在别的机器上调用 Codex、Cursor、Claude Code 或 OpenAI 兼容 API,凭每台机器各自的 token 经 SSH 隧道或公网 HTTPS 访问 `/remote/v1`,能接哪些工作、各阶段在各 CLI 上用什么模型,都从服务端读取。慢调用不拖住别人,限流只让该后端暂停而不消耗重试次数,租约过期的工作会重新排队。同一套 API 还能读取、搜索、写入知识并回答只读 SQL。详见 [docs/remote-labeling.md](docs/remote-labeling.md)。
- **`/dream`**:每晚(或手动)分析近期 agent 会话——问了什么、哪些工具失败、什么在重复——产出对 **skills**、**memory**、**知识库** 的改进建议,在页面上一键接受/拒绝。
- **实时数据源 —— 一个逻辑数据库。** 注册 MySQL、TimescaleDB、parquet/CSV 目录(DuckDB,模拟 HDFS)、JSON HTTP 端点、Prometheus 指标和对象目录:knode-os 把它们内省成知识图谱里的 capability(`datasource`/`dataset` 实体,按实体列采样生成 `appears_in` 边与 locator;端点和指标的绑定由已知的表和别名推导),并生成 `wiki/datasets/` 页面——行数据留在原系统、查询时实时获取。提到一个公司,图谱同时知道*哪些文档提到它*、*哪些表包含它*、*哪个 API 端点能查它*。
- **Context Pack。** `knode-os pack "<语句>"`(或 MCP 工具 `knode_context_pack`)自动匹配语句中的实体,沿图谱展开(文档 chunk、带 `STALE`/`CONFLICT` 标记的时效断言、关联的实时表),按 playbook 执行实时探针查询(带 asOf 时间戳、短 TTL 缓存、绝不落库),并输出缺口分析和可直接执行的后续 SQL。
- **会学习的 playbook。** Context pack 由 agent 可编辑的 `playbooks/packs/*.md` 工作流驱动;每次构建记录到 `pack_events`,`knode-os pack-optimize`(也随夜间 dream 运行)把失败/缺口模式转化为完整的 playbook 修订建议——接受后直接写回 `playbooks/packs/`,下一次查询就跑在更好的脚本上。
- **MCP 服务**:Claude Code / Codex(命令行或 App)可直接搜索、提问、读写、grep、对实时数据源执行原生 SQL、构建 context pack。
- **模型、存储与处理阶段皆可插拔。** 一个插件模块(`knode.config.json` 的 `plugins`)可以注册 LLM provider、embedding provider、存储后端、文档转换器,以及各处理阶段的用户自定义钩子 —— 哈希前去掉模板文字、换一种切块、过滤 tier-0 概念词、给每次抽取提示词加规则、后处理模型返回的结果、改写摘要风格、文档落库时得到通知。内建实现用的是同一套 API;`command` provider 则不用写代码就能把任意可执行文件当作模型。见 [docs/plugins.md](docs/plugins.md)。
- **Google OKF v0.2 原生兼容**:`wiki/` 本身就是一个可移植的 Open Knowledge Format bundle；支持规范校验、版本路由、旧库迁移、外部 bundle 无损导入/导出，OKF 普通 Markdown 链接会进入知识图谱。v0.2 的溯源/信任/生命周期字段(`generated`、`verified`、`status`、`stale_after`)会被识别,v0.1 bundle 仍按规范给出的回退路径读取。未知类型、扩展 frontmatter 和断链按规范宽容处理。
- **原生 Obsidian Vault**:`wiki/` 可直接在 Obsidian 中作为 Vault 打开，内置 Vault 配置与附件目录；支持 Properties、别名、标签、`[[Wikilink]]`、路径链接、标题/块引用和 `![[嵌入]]`。OKF 导入和导出的每个知识 bundle 也自动是独立 Vault。
- **`ask`**:基于知识库的带引用问答,并显式列出"知识库还缺什么"。
- **研究课题(study)**:给一个主题——比如"从 Anthropic 最新的招股书出发,看它的收入与成本结构、上下游、竞争对手、外界评价与前景"——选谁来研究(Codex、Claude Code、Cursor、内置 agent,或深度研究模型)、能看哪些来源(知识库、网络、你自己的 MCP 服务器 / API / 站点)。规划员先把它改写成一份可编辑的研究简报(更具体的问题、要写的页面、起始来源、要问你的澄清问题);开始后,收集员找资料并**存下来**:每一份被依赖的网页、PDF、数据文件都由 knode 自己抓取,原件放进 `raw/docs/research/<课题>/`,像其他文档一样被转换(HTML / PDF → Markdown)和索引。每个部分一页、外加一页总报告写进 `wiki/research/`,引用这些文件,图表是 ` ```chart ` 数据块,网页端和 macOS 应用都直接画出来(柱状、折线、面积、堆叠柱、横向柱,以及做比较用的:100% 堆叠的份额图、两个指标的散点图、桥图(waterfall)、各家代际的时间线)。**导出**把一个课题合成一个自包含的 HTML 文件——先总报告、后各页,带目录、编号的图表及其来源——任何浏览器都能看,打印成 PDF 也干净。见 [设计 15](docs/design/15-research-studies.md)。
- **内容语言**：给工作区指定一个主语言（以及若干次要语言），`raw/docs` 下用其他语言写的文档会在后台被翻译成主语言——翻译的是 Markdown，原件不动：PDF、网页保留原文件——按段落分段交给 Translate 阶段的 agent（Codex、Claude Code、Cursor 或任一模型），链接、被引用的锚点和代码不交给模型、译完再核对放回。网页和 macOS app 都有阅读语言切换（原文或译文）；次要语言在读者请求时才翻译。摘要页用主语言写。界面语言仍是每位读者自己的设置。见 [设计 17](docs/design/17-content-languages.md)。

## 快速开始

```bash
pnpm install && pnpm build

# 索引放在装有 pgvector 扩展的 PostgreSQL 里,默认连 127.0.0.1:5432,可在 knode.config.json 的
# `database` 段改(见「配置模型」)。没有 PostgreSQL 服务器?初始化时改用
# `KNODE_DATABASE_KIND=pglite node dist/cli.js init …`,即得到内嵌的零配置索引。

# 初始化数据目录(默认 ~/.knode-os,可用 --data <path> 或 $KNODE_OS_DATA)
node dist/cli.js init --data ~/knode-data

# 往 <data>/raw/docs 放一些 markdown/文本,然后
node dist/cli.js ingest --data ~/knode-data
node dist/cli.js search "向量召回" --data ~/knode-data

# 启动全部服务(Web 页面 http://127.0.0.1:9100)
node dist/cli.js serve --data ~/knode-data

# 创建第一个账号——或者在本机打开 Web 页面,在首屏创建
node dist/cli.js user add admin --admin --data ~/knode-data
```

全局安装(`npm link` 或 `pnpm add -g .`)后可直接使用 `knode-os` 命令。

### 数据目录

```
<data>/
├── knode.config.json   # embedding / llm / server / dream 配置
├── purpose.md          # 这个知识库是干什么的
├── schema.md           # wiki 结构规则
├── raw/                # 原始输入,永不改写;raw 路径就是每个源的键
│   ├── docs/           # 用户上传的文档(文本、PDF、HTML、图片);research/<课题>/ 是研究课题收集的资料
│   ├── traces/         # claude/ + codex/ 会话记录(自动同步)
│   └── skills/         # agent 用过的 skills 与 prompts(自动同步)
├── .sidecar/           # 派生状态,每个源一个目录,镜像上面的目录树 —— 请保留
│   └── raw/docs/<文件>/  # content.md(PDF/图片转换出的 Markdown)、meta.json(哈希、chunk 清单)、
│                         # tier0.json / tier1.json(抽取结果)、usage.json(热度)、views/(LLM 摘要缓存，
│                         # translations/<lang>.md——内容语言的译文，见设计 17)
├── wiki/                 # 原生 OKF v0.2 bundle + Obsidian Vault
│   ├── .obsidian/        # Vault 配置(已有设置绝不覆盖)
│   ├── attachments/      # Obsidian 附件
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/  datasets/
├── playbooks/          # agent 可编辑的配置（在 设置 → Playbooks 里编辑）
│   ├── packs/          # context-pack playbook(由学习闭环修订)
│   ├── capabilities/   # 对实时数据源能力的语义注释
│   └── intents/        # intent 规格:一个答案需要哪些槽位
├── plugins/            # 可选:knode.config.json 里点名的插件模块(provider、转换器、钩子)
├── ledger/             # events.jsonl(机器真相)+ attic/(被删源的 sidecar)
└── .knode/             # 本地状态;用 PGlite 时索引本身也在这里(db/)
```

搜索结果里的引用路径就是 `raw/docs/...`,即你上传的原件。文本文件直接从 `raw/` 索引,不再复制;PDF 或图片只转换一次,结果放在 `.sidecar/raw/docs/<文件>/content.md`,在页面或 `knode_read` 里打开这样的命中看到的就是这份 Markdown。与索引不同,`.sidecar/` 不是可弃的:它保存付费的 LLM 抽取结果和使用热度,重建索引时免费回放。

通过 Web UI 使用 `serve` 时，`--data` 是所有 Workspace 的根目录。一个用户可以拥有多个 Workspace；每个 Workspace 都有一套完整、独立的上述目录结构：

```
<data>/
├── users/<username>/workspaces/<workspace-id>/  # 私有文件、配置和 Wiki;索引是它在 PostgreSQL 中的独立 schema
└── teams/<team-name>/                         # 选择同名 Team 的用户共享
```

可在 Workspace 菜单中创建和切换空间。使用 **设置 → 清空 Workspace** 时，服务会先关闭该空间的后台任务，再永久删除整个目录（文件、数据库、图谱、trace 和配置），最后在原名称下重建一棵干净的空目录树。新建或刚清空的空间会暂停历史 trace 自动同步；在 **资料 → 导入数据 → Agent 轨迹**（或 **任务 → Dream → 收集 agent 轨迹**）主动同步一次后，才会导入历史并恢复定时同步。

原来直接位于 `<data>/raw`、`<data>/wiki`、`<data>/.knode` 的数据会原样保留，不会自动迁移。CLI 命令可以直接指定某个隔离目录，例如 `--data ~/.knode-os/users/admin/workspaces/default`。

### 配置模型

每个 Web 工作空间都有独立的模型配置。切换到目标个人或 Team 工作空间后，可在 **Settings** 中配置，也可以直接编辑对应文件：

- 用户 Workspace：`<data>/users/<username>/workspaces/<workspace-id>/knode.config.json`
- Team 空间：`<data>/teams/<team-name>/knode.config.json`

只通过 CLI 使用的独立数据目录仍然读取 `<data>/knode.config.json`：

```jsonc
{
  "embedding": {
    "provider": "openai",            // 默认为 "local":离线哈希 embedder,384 维
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",  // 或直接填 key
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "database": {                      // 派生索引存在哪
    "kind": "postgres",              // 默认 PostgreSQL + pgvector(共用一个库,按工作区分 schema);"pglite" = 内嵌、零配置
    "host": "127.0.0.1", "port": 5432,
    "user": "", "password": "",      // password 同样支持 "env:VAR";trust/peer 认证留空
    "url": "",                       // 或改用一条连接串(postgres://…,也支持 "env:VAR"),配合 "ssl": "require" 与 "poolSize"
    "database": "knode",             // 所有工作区共用一个库,首次打开时创建
    "schemaPrefix": "ws"             // 每个工作区一个 schema:<prefix>_<workspace>_<hash>
  },
  "llm": {
    "provider": "openai",            // 也可用 "codex-cli" / "claude-cli" / "cursor-cli"、"command"(任意可执行文件)或插件注册的 provider
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "protocol": "auto",              // auto = 优先 Responses,端点没有该路由则退回 Chat Completions
    "model": "gpt-4.1-mini"          // 留空 = 关闭 LLM 功能,走启发式
  },
  "extraction": {
    "entityLlm": { "provider": "codex-cli", "model": "" },
    "documentLlm": { "provider": "codex-cli", "model": "" }, // 视觉模型/API/Codex/Claude Code
    "summaryLlm": { "provider": "codex-cli", "model": "" },  // 每篇文档一页摘要
    "judgeLlm": { "provider": "claude-cli", "model": "" },   // knode_ask、Dream、重复实体与断言复核
    "translateLlm": { "provider": "codex-cli", "model": "" } // 把文档译成主内容语言（初始为 summaryLlm 的副本）
  },
  "languages": {                     // 内容语言（设计 17），默认关闭
    "enabled": true,
    "primary": "zh",                 // 知识库的阅读语言：其他语言的文档都译成它
    "secondary": ["en"],             // 出现在读者的切换器里，读者请求时才翻译
    "maxChars": 200000               // 更长的文档只在请求时翻译；0 = 不限
  },
  "dream": { "schedule": "03:00", "lookbackDays": 7 },
  "plugins": [                       // provider、存储后端、转换器与钩子 —— 见 docs/plugins.md
    { "module": "./plugins/house-rules.mjs", "options": { "redact": ["CONFIDENTIAL"] } }
  ]
}
```

索引默认放在带 pgvector 的 PostgreSQL 中:所有工作区共用一个库,按 schema 隔离,各自在首次打开时创建 —— 服务器上还没有这个库或 `vector` 扩展时也会一并创建,所以服务器上要装好 pgvector。PGlite 是可选的替代:把同一套 schema 内嵌在进程里,放在 `<workspace>/.knode/db`,什么都不用装 —— 首次运行前设 `KNODE_DATABASE_KIND=pglite`,或把 `database.kind` 改成 `pglite`;测试套件用的也是它。它只适合小工作区:单进程 32 位 WASM,承载上限约百万 chunk,同一时间只能有一个进程打开索引,而且查询在 Node 的事件循环上执行,一条长查询会让整个服务在此期间停止响应。用 schema 而非独立库来隔离是刻意的:独立库会给每个工作区带上一份约 8 MB 的系统目录;而把所有工作区塞进同一张表、用 workspace 列区分,则会直接失去向量索引 —— HNSW 沿着按距离排序的邻居图游走,标量列上的等值条件无法下推进这次游走,优化器只能退回顺序扫描。向量列使用 `halfvec` 存储:pgvector 的索引条目上限是一个 8 KB 页,`vector` 对应 2000 维而 `halfvec` 对应 4000 维,所以半精度正是 1536/2048 维下 HNSW 索引仍然可用的前提,同时表体积减半。已有库在两种列类型之间切换会原地转换,不需要重新嵌入。

任何 OpenAI 兼容端点都可以(Ollama、vLLM、硅基流动等)。`protocol` 决定用哪条线路说话:默认 `auto` 先探测端点有没有 `/responses`,有就走 Responses(推理模型在这条线上把思考作为独立的 output item 返回,而 Chat Completions 只能塞进各家拼写不一的 `message.reasoning_content`),没有则退回 `/chat/completions`;探测每个端点每进程只做一次,且不消耗 token。也可以钉成 `responses` 或 `chat`。embedding 另外支持 `"provider": "ark-multimodal"`,对接火山方舟的 `/embeddings/multimodal`(`doubao-embedding-vision-*`)。该接口不是 OpenAI 形态:每次请求只返回一个融合后的向量,因此 `baseUrl` 写到 `/api/v3` 为止,`model` 填接入点 id(`ep-…`),`batchSize` 的含义变为单条请求的并发数。文档视觉转换、实体提取、文档摘要和判断（`knode_ask`、Dream、重复实体与 claim 复核）各有独立路由，可以指向一个模型或一个 agent；留空的路由会被写成它原本会跑的默认。文本型 PDF 在本地提取；图片和扫描型 PDF 可使用支持视觉的 OpenAI 兼容模型、Codex CLI 或 Claude Code CLI 转成 Markdown。修改 `dimensions` 会在下次启动时重建 embedding 表。也可以在 Web 页面的 **Settings** 标签里编辑并测试各条模型路由。

**插件。** `provider` 与 `database.kind` 填的是注册表里的 id,内建实现只是其中最早的几项([docs/design/11](docs/design/11-plugins-and-udfs.zh-CN.md))。`plugins` 里(或环境变量 `KNODE_PLUGINS`)列出的模块可以注册 knode-os 不会说的厂商 API 的 LLM provider、embedding provider、以另一种方式到达 Postgres 的存储后端、其他文件类型(`.docx`、`.epub` 等)的转换器,以及各处理阶段的钩子(用户自定义函数):`source.text`、`chunk`、`tier0.concepts`、`extract.request`、`extract.result`、`summary.request`、`document.applied`。`command` provider 不需要写插件:`cliPath` 指向一个可执行文件,它从标准输入读到 `{ messages, model, json, maxTokens, images }`,把回答写到标准输出,连接的 key 以 `KNODE_LLM_API_KEY` 传入。`database.url` 接受连接串(也可写 `env:DATABASE_URL`),配合 `ssl` 与 `poolSize`;`database.path` 可以移动 PGlite 索引的位置。`knode-os plugins` 与 `GET /api/config/providers` 列出已注册的一切。示例与指南:[docs/plugins.md](docs/plugins.md)、[demo/plugins](demo/plugins/README.md)。

其他配置块(用 `knode-os config` 查看完整默认值):`ingest`(分块大小/重叠、文件监听)、`extraction`(后台文档轮次的批大小与间隔、tier-1 模型、是否抽取断言)、`heat`(热度半衰期、搜索加权、冷判定阈值)、`trace`(Claude/Codex trace 目录、skill 目录、同步间隔)、`server`(host/port)。

配置 LLM 后解锁:tier-1 实体/关系/断言抽取及紧随其后的重复实体复核、每篇文档一页摘要、`ask` 问答、夜间断言复核、LLM 级 dream 分析;概念页由研究 agent 来写([docs/design/09](docs/design/09-ingest-stage-rework.zh-CN.md))。不配置时所有功能仍以确定性/启发式路径运行。

## CLI

```
knode-os init                 创建数据目录与数据库
knode-os serve [-p port]      Web 页面 + API + 文件监听 + trace 同步 + 后台文档轮次
                              (抽取 → 重复实体复核 → 摘要)
                              + 热度回写 + 夜间 dream 与 tier-2
knode-os sync [--only p..] [--verify] [--no-llm] [--no-datasources]
                              把声明态(raw/docs、wiki、skills、数据源配置)与索引对账:变更文件作为
                              scope 应用,被删除的源 dispose(它产生的所有效果全部撤销),依赖它们的
                              wiki 视图再生或归档。`ingest` 是别名。
knode-os lineage show <entity|relation|claim|page|document> <id>
                              某条图数据背后的证据(来源 scope、抽取器、系统时间窗口)
knode-os history <path>       一个源的 apply / dispose / purge 历史
knode-os forget <path>        删除源、dispose 并清除其历史(不可逆)
knode-os purge [--before iso] [--archived]  物理清除已 dispose 的历史 / 归档页面
knode-os rebuild [--history]  删除索引(该 workspace 在 PostgreSQL 中的 schema;用 PGlite 时为 .knode/db)并从文件 + ledger 重建
knode-os extract [--batch n]  跑一轮后台文档轮次:抽取一批、复核重复实体、写摘要
knode-os translate <path…> [--lang zh] | --status   立即在 Translate 路由上翻译文档 / 按语言列出译文
knode-os remote token create --name <机器> --scope label,read,write,sql --workspace <用户>/<workspace>
                              为远程 API 签发每台机器各自的 token(另有 `remote token list | revoke`)
knode-os user add <名字> [--admin] [--read-only] [--team t] [--remote-apis 分组] [--gateway id]
                              可以登录的账号(另有 `user list | set | passwd | signout | remove | token | sessions`)
knode-os gateway add <id> <http://127.0.0.1:端口/路径>   把本机服务发布在 /gw/<id> 下(另有 `gateway list | remove`)
knode-os tls init [--host IP或域名]   为 HTTPS 监听(server.tls)生成自签名证书
knode-os datasource list|sync             查看已注册实时表 / 重新内省 schema 进图谱
knode-os datasource query <id> <sql>      对数据源执行只读原生 SQL
knode-os pack <语句> [--json] [--as-of iso] [--valid-at iso]
                                          构建 context pack(实体+证据+实时探针+缺口建议)
knode-os pack-optimize [--apply]          从 pack_events 学习 → playbook 修订建议
knode-os demo seed-stock                  股票分析 demo 数据(见 demo/stock/README.md)
knode-os search <q> [-m hybrid|vector|keyword|sag] [-k n] [--as-of iso] [--json]
knode-os ask <问题>           带引用的问答 + 知识缺口(需配置 llm.model)
knode-os graph [q] [--depth n] [--as-of iso] [--valid-at iso] [--insights] [--json]
                              (无查询时输出高频实体概览;--as-of 从 evidence 现算当时的图)
knode-os obsidian init [dir]           初始化/修复 Obsidian Vault(默认 <data>/wiki)
knode-os obsidian status [dir]         检查 Vault 是否可直接打开
knode-os okf validate [bundle] [--json]  校验 OKF v0.2(默认校验 <data>/wiki)
knode-os okf migrate [--dry-run]         将旧版 wiki 结构迁移到 OKF v0.2
knode-os okf import <bundle> [--name n]  无损导入到 raw/docs/okf/<name>
knode-os folders import <文件夹> [--to d] [--replace]  把本机一个文件夹按原目录结构复制到 raw/docs/<名字> 并索引
                              （只带走文本、PDF、图片）
knode-os folders link <文件夹> [--to d]    同上但记住它：`serve` 监听该文件夹，新增、修改、删除都即时镜像进索引
knode-os folders list | sync [dest] | unlink <dest> [--remove-files]
knode-os okf export <dir>                校验并导出原生 wiki bundle
knode-os wiki generate        补齐缺失的文档摘要页与实体页（逐条主张附来源）及实体页索引
knode-os wiki refine          tier-2:断言审计 + 全量重复实体审计 + 断言复核 + 热门话题块 + 研究推荐
knode-os trace sync           拉取新的 Claude Code / Codex trace 与 skills
knode-os dream [--lookback d] 先同步 trace,再分析 → skills/memory/知识库建议
knode-os research study new "<主题>" [--agent codex-cli] [--no-web] [--sources a,b] [--deep-research 连接:模型] [--start | --now]
                              研究课题:主题 → 研究简报(问题、页面、起始来源);--start 排队,--now 在本进程跑完 收集 → 分页 → 总报告
                              (另有 study refine <id> [意见] [--answer "问题=回答"]、study start | run | show | list [--archived] | cancel | retry | resume | archive | unarchive | remove；
                              agent 额度用完时任务会暂停到额度重置再自动继续，不算失败——见设计 22)
knode-os research capture <url> [--study <id>]   把网页 / PDF / 数据文件存进 raw/docs/research,转换并索引
knode-os research sources     playbooks/research/sources 下的研究来源(MCP 服务器、API、站点、数据源)
knode-os research init [--now]  初始化知识库:先索引与抽取,再由 agent 写出 wiki/overview.md 与
                              AGENTS.md / CLAUDE.md 指南,并把值得单独成页的主题排进队列
knode-os chat "<消息>" [-c <会话>]  和配置好的 CLI 聊知识库(它经 MCP 回答,并把你教的内容写成隔离笔记);
                              chat list 查看最近的会话
knode-os mcp                  在 stdio 上运行 MCP 服务
knode-os connect claude|codex 把 MCP 服务注册到 agent CLI
knode-os config               查看当前配置(密钥已脱敏)
knode-os plugins [--json]     列出本数据目录加载的插件,以及它们和内建实现提供的 provider、后端、转换器与钩子
knode-os ls|tree|stat|read|grep [path]   把 Workspace 当文件系统用:列目录、画树、看属性、打印文件(PDF 与图片打印
                              其派生的 Markdown)、搜索文件内容
knode-os stats | survey | entities list|show   知识库的数字概览;实体列表与详情

knode-os login <server> [--user u] [--workspace finance]   从另一台机器登录 knode-os 服务端:上面这些命令,以及
                              search、ask、graph、claims、sync、研究与 chat,都改由服务端的 Workspace 作答
knode-os whoami | workspaces | use <workspace> | logout   当前的服务端、账号与 Workspace;切换;退出登录
knode-os get <path…> | put <file…> [--to raw/docs/x] | write | mkdir | mv | rm   在服务端下载、上传、改动文件
knode-os tasks | sessions | password | api <route>   服务端在做什么;自己的会话与密码;调用任意 REST 接口
```

所有命令都支持 `--data <path>`(或设置 `KNODE_OS_DATA`);登录了服务端时,它也让命令留在本机。从其他机器使用 CLI 见 [docs/remote-access.md](docs/remote-access.md#from-the-command-line-on-another-machine)。

## 在 Claude Code / Codex 中使用

> `serve` 运行时会在 `/mcp` 提供 Streamable HTTP 的 MCP 端点（token 在 `<data>/.knode/mcp-token`），`knode-os connect claude|codex|cursor` 默认注册它（`--stdio` 才是独立进程）；`review` 配置块控制审核强度（写入时只按精确拼写合并、LLM 复核合并候选与争议断言、`verify` 任务可联网核实）；`research.pipeline: team` 让研究任务按「规划、并行调查、综合、评审、修订」五个阶段跑（`native` 则把角色注册为 CLI 的原生子代理）；`research.profile` 选一份研究 profile（`playbooks/research/profiles/*.yaml`：推理强度、联网新鲜度、核实门槛，以及每个子代理的 CLI、模型、工具与提示词，内置 default / quick / thorough / native，可在 Settings → Research 里编辑）；`research.agent` / `chat.agent` 现在指向 `playbooks/agents/` 下的具名 agent（Settings → Providers & Agents，内置一个 `deep-agent` 模板）——跑在某个模型上的 deepagents，或带自己路径、模型与推理强度的编码 agent CLI；改动前那种直接写 CLI 名或连接 id 的配置继续可用；
> `knode-os research queue entity 宁德时代 --now` 让配置好的 agent（`research.agent`：一个 coding-agent CLI，或跑在 OpenAI 兼容连接上的内置 agent）研究并写出 wiki 页，页面以隔离状态入库，审核后提升；
> `knode-os entities dedupe|merge|unmerge|correct`、`knode-os wiki lint`、`knode-os research recommend`、`knode-os research profiles` 见 [docs/design/06](docs/design/06-wiki-research-agent.zh-CN.md);
> 知识库初始化(`research init`)、对话入口(`chat`)与研究 agent 的后续改进见 [docs/design/07](docs/design/07-init-and-chat.zh-CN.md)。

```bash
knode-os connect claude   # 执行 claude mcp add --scope user knode-os -- node <cli> mcp --data <dir>
knode-os connect codex    # 在 ~/.codex/config.toml 追加 [mcp_servers.knode-os]
```

暴露的 MCP 工具:`knode_resolve`(优先调这个,见下)、`knode_capture`(把网页 / PDF / 数据文件存进 raw/docs/research 作为来源,返回可引用的路径)、`knode_web_fetch`、`knode_web_search`(配置了 `research.web.search` 时)、`knode_api`(调用配置好的 API 来源)、`knode_chart`(检查图表块:bar、hbar、line、area、stacked-bar、share、scatter、waterfall、timeline)、`knode_study`(研究课题)、`knode_plan`、`knode_feedback`、`knode_capabilities`、`knode_checkout` / `knode_commit` / `knode_worksets`(为长任务锚定一致视图,结束时把结论写回为 Source)、`knode_absences`(查过但没找到的东西)、`knode_disputes` / `knode_trust`(矛盾,以及提升被隔离的写入)、`knode_subscribe`(订阅实体/源/意图的变化)、`knode_learning`(planner 学到了什么)、`knode_search`、`knode_graph_search`、`knode_claims`、`knode_ask`、`knode_ls`、`knode_read`(路径以 `/` 开头则读虚拟文件系统;raw/docs 下的 PDF/图片返回其派生 Markdown)、`knode_write`(仅限 wiki/、raw/docs 与 playbooks/packs/)、`knode_grep`、`knode_ingest` / `knode_sync`、`knode_lineage`、`knode_history`、`knode_forget`、`knode_okf_validate`、`knode_graph_insights`、`knode_survey`(这个库里有什么,全是数字——陌生工作区的第一个调用)、`knode_suggestions`、`knode_context_pack`、`knode_datasources`、`knode_query`(只读原生 SQL,`source="catalog"` 可查知识库自身的 `v_*` 视图)。三条时间轴互相独立:`as_of`(系统时间:当时相信什么)、`valid_at` / `valid_range`(世界时间:断言何时成立)、`freshness`(实时读最多可以多旧);`kinds` / `sources` 限定哪些源可以作答。

**用 `knode_resolve` 取代 search。** search 返回的是「文本长得像」的东西;resolve 会先算出这**类**问题的答案需要哪些槽位(`playbooks/intents/*.yaml` 里声明),把本地索引能答的部分直接答掉,剩下的编译成一份 plan 交给 agent 执行。填不上的必需槽位会出现在 `unknowns` 里,而不是用几篇看起来相关的文档糊过去。执行完用 `knode_feedback` 带上 receipt id 回报,下一次同类问题就会更准。

**闭环是真的闭上了。** feedback 喂给一个 ranker,它学习「哪个能力真正回答了哪个槽位」——评分依据是调用方**留下了什么**,而不是有没有返回行——并用 Thompson 采样做探索,让第一次抛硬币输了的源仍有机会被再试。反复奏效的 plan 形状会被蒸馏成 recipe 提案:先拿它派生自的 receipt 离线重放,再做只读安全检查,最后等人接受——**任何东西都不会自动发布**。`knode-os learning` 打印全部结果,`wiki/learning/` 让这些数字可复核。

**agent 的写入默认被隔离(quarantined)。** 它可检索、可引用、可归因,但不能悄悄变成知识库的立场:与 trusted claim 冲突时会开一条 dispute,而不是覆盖它。人复核后用 `knode_trust` 提升。空查询会被记成带过期窗口的负知识,于是同一条无果查询不会每个 session 重跑一遍——窗口一过又会重新尝试。

典型闭环:agent 在重新推导项目知识前先搜索;把新结论通过 `knode_write` 写进 `wiki/concepts/…`;下一个会话直接搜到。

## Web 页面

`knode-os serve` → http://127.0.0.1:9100 ——用服务端的账号登录(第一个账号在本机创建:`knode-os user add`,或首屏)。同一套页面也能从其他机器经域名、SSH 隧道或 HTTPS 监听打开([docs/remote-access.md](docs/remote-access.md))。设置里的 **Access / 权限** 用于改自己的密码、管理会话;管理员还能在这里管理用户与网关。成员看到的设置是只读的。

五个一级区，每区自带二级 tab（[设计 20](docs/design/20-explore-and-tasks.md)）。每个视图顶部的搜索框（⌘K 或 `/`）边输入边按名称提示实体和文件，并可把输入的内容交给 **搜索**、**问答** 或 **研究**。

- **Library / 资料** —— 盒子里有什么
  - **Files / 文件** —— 浏览目录树、Markdown 编辑与预览，上传文本/PDF/图片到 raw/docs(自动转换和摄入;PDF/图片命中打开的是转换出的 Markdown);开启内容语言后，文档按读者的阅读语言打开——工具栏里的切换器选原文或译文（按浏览器记住），还没有译文时给出 **translate**（译文只读）;**导入数据** 把资料带进来——从磁盘上传文件或文件夹、按路径导入这台 Mac 上的文件夹并保留目录结构（复制一次，或链接后由 `serve` 与原文件夹保持同步；链接的文件夹在目录树中显示 🔗 且只读），以及把你的 Claude Code 与 Codex 会话收集到 `raw/traces/`；**＋ new** 新建文件或文件夹;打开 `raw/docs` 下的文件时，顶部列出引用它的 wiki 页面(**cited by**:来自它们的 `[[raw/docs/…]]` 与 Markdown 链接、`sources:`(derived from)以及 `tested_by` 等 `relations:`，[写法见此](docs/frontmatter-contract.zh-CN.md))；目录树不列系统目录——`ledger/`、`playbooks/`（在 **设置 → Playbooks** 里编辑），以及 `wiki/lint/` 和 `wiki/datasets/`（它们的消息改由通知送达）——并在 knode-os 建的每个目录旁写明它的用途；`purpose.md` 和 `schema.md` 可在这里直接编辑，agent 不会改写它们
- **Explore / 探索** —— 三种深度的查找
  - **Search / 搜索** —— 一个查询按各通道分别命中了什么：每段内容在语义、关键词、实体三个通道里各排第几（多跳检索则显示它经由哪些实体到达），以及融合分数的由来；各通道命中数，可点击筛选；关键词与实体匹配所用的检索词；可按文档分组；旁边是查询命中的实体——并说明是按名称、别名还是描述命中——一跳关系内的实体、它们之间的关系和相关论断。可限定在「文件」里选中的目录
  - **Ask / 问答** —— 一个问题，一次 agent 会话。配置好的 agent 通过 MCP 作答，跨多轮追查线索，并把你教它的内容写成隔离笔记（确认后采纳）。没有指定 agent 时跑 01 区的默认连接，所以只要配了模型 Ask 就能用；连这个也没配时，界面会直接说清楚要去配什么。
  - **Research / 研究** —— 研究课题，一个主题研究成几页：写下你想弄清楚什么,选 agent(或深度研究模型)、深度与来源,点"规划":简报带着更具体的问题、计划的页面、起始来源和要问你的问题回来;编辑、回答、再规划,然后开始。运行中的课题显示各阶段、已收集的资料(标题、站点、日期、文件)、收集笔记、每个分页与总报告——一键提升页面或资料的信任级别,查看各会话日志,并可 **Export ↗** 把总报告和各页导出成一个 HTML 文件,用来阅读、保存或打印成 PDF
- **Knowledge / 知识** —— 从资料里长出来的东西
  - **Graph / 图谱** —— 力导向图谱浏览 + 洞察(枢纽/孤立节点/类型分布)
  - **Wiki** —— 一个按钮完成知识库初始化(通读 → 总览页 + AGENTS.md 指南 + 排队的主题页),并在此发起与审阅深度研究页
- **Tasks / 任务** —— 正在运行什么、在等什么
  - **Queue / 队列** —— 处理开关（开始前先估算代价，可随时停止）与逐阶段的流水线——索引、向量、抽取、摘要、翻译、复核——各自在等多少、正在处理多少、最近一小时完成多少；当前每个模型调用的文档、分段和持有它的 worker；本机的处理槽位与远程 worker（在线、忙碌、暂停及原因）；研究、课题与问答任务；后台同步与导入；以及定时任务——Dream、tier-2、轨迹收集、数据源、链接文件夹。页头的处理状态标签显示是否在运行、有多少在处理，点击即打开这里
  - **Dream / 夜间分析** —— 下次运行时间，立即运行，审阅并接受/拒绝建议，以及它读取的 agent 轨迹（点一行即可打开 `raw/traces/` 下的镜像文件）
- **Settings / 设置** —— **Providers & Agents**（每个模型端点与密钥只配一次，embedding 与 LLM 同在一张表——`llmUse` 标出哪个 LLM 是默认，所有没有自己指定 provider 的任务都跟着它走；下面第二张表是 agent：跑在这些模型之一上的 deepagents，或带自己路径、模型与推理强度的编码 agent CLI（Claude Code / Codex / Cursor）。CLI 是 agent 而不是模型）、**Ingest / 预处理**（独立的 Entity / Concept / 文档视觉阶段路由，以及带内容语言设置的 Translate 阶段，每个阶段写明自己跑在哪个模型或 agent 上——任一 agent 都按单次调用使用，阶段不再跟随默认；保存后按需重建 embedding 或刷新转换）、**Research / 研究**、**Sources / 来源**（网络设置(给没有自带搜索的 agent 用的搜索 API、User-Agent、代理)与你自己的来源:MCP 服务器、声明了端点的 JSON API、带种子 URL 的可信站点、实时数据源）、**Ask / 问答**（由哪个 agent 回答、每次回复带上最近几条消息、保留多少个对话）、**Playbooks**（`playbooks/` 下的文件，按 knode-os 读取它们的方式分组——研究模版与阶段提示词、context pack、intent、本体包、概念停用词表、能力说明、Ask 的协议与每轮提示词——每个文件都能编辑、撤销，或重置为 knode-os 自带的版本，保存前会检查 YAML 与模版；agent、研究 profile 与研究来源指向编辑它们的页面）、**Workspace**。中间三页按知识在工作区里的流向排列：进来先预处理，再研究成 wiki，最后用来回答问题

**通知**（页头的 ⚑）告诉你工作区需要你做什么，每条带一个对应操作：最近一次 wiki 检查（按类别的问题数、与上一份报告相比的变化，**Open report**）、上次同步失败的数据源（**Retry**）、仍在等你同意的 trace 采集（**Collect traces**，会说明要复制多少个会话）、仍是模版的 `purpose.md`（**Edit purpose.md**），以及从未初始化的 wiki（**Go to Initialize**）。关掉的通知在内容变化后会再次出现。

## REST API

`GET /api/health · /api/config · /api/config/providers · /api/plugins · /api/stats · /api/notices · /api/playbooks · /api/playbooks/file?path · /api/tree[?path&depth&dirs] · /api/file · /api/file/citations?path · /api/search · /api/search/explore?q[&mode&k&sources]（各通道排名的段落、查询命中的实体、它们的关系与论断） · /api/search/suggest?q[&limit] · /api/tasks（队列：阶段、在途调用、worker、任务、后台工作、定时任务） · /api/graph[?limit&types&edges]（每个节点带所属 `community`，并列出图谱视图画成“岛”的 `communities`） · /api/graph/insights · /api/entities[?q&type&sort&order&offset&limit&merged] · /api/documents · /api/okf/validate · /api/traces · /api/suggestions`
内容语言：`GET /api/languages` · `GET /api/file?path&lang`（有译文时返回该语言的文档，`languages` 说明各译文进度） · `POST /api/file/translate`（`{ path, lang, cancel? }`）
`PUT /api/config` · `PUT /api/file` · `PUT /api/playbooks/file` · `DELETE /api/playbooks/file`（重置为自带版本） · `DELETE /api/file` · `POST /api/config/test | /api/upload | /api/ingest | /api/ask | /api/mv | /api/mkdir | /api/traces/sync | /api/dream | /api/wiki/generate | /api/suggestions/:id/status`

每个接口都需要登录会话——已登录浏览器的 cookie,或 `Authorization: Bearer knu_…`(应用的,或 `knode-os user token` 签发给脚本的)——以及该接口所属 API 分组的权限;登录本身在 `/api/auth/*` 下([docs/remote-access.md](docs/remote-access.md))。Workspace 范围内的数据 API 另需请求头 `X-Knode-Workspace-Kind`（`personal` 或 `team`）、`X-Knode-Workspace-ID` 和 `X-Knode-Workspace-Name`；Workspace 的主人就是已登录的账号(只有关闭登录时才看 `X-Knode-User`)。`DELETE /api/workspace` 会彻底清空所选 Workspace。

## 开发

```bash
pnpm dev -- serve --data ./.dev-data   # tsx 直跑,无需构建
pnpm typecheck && pnpm test            # tsc + vitest
```

## 安全说明

服务只绑定 `127.0.0.1`，并要求每个客户端登录——浏览器、应用和脚本，本机也不例外(`src/auth`)：密码用 scrypt 哈希，会话只存哈希，登录按地址和用户名限速，浏览器的写操作有 CSRF 防护。来自其他机器的请求必须走 HTTPS(经隧道,或 `server.tls` 监听)，且只能使用账号允许从外部使用的 API 分组；`/mcp` 只对本机开放；`serve` 拒绝在其他机器能以明文 HTTP 访问的地址上监听。成员不能修改设置，只能打开自己的 Workspace 和分配给他们的 Team;只读成员什么都不能改——但 Ask 与 Research 会在服务所在的机器上运行编码 agent，只开放给你信得过的人。远程标注工作者在 `/remote/v1` 上使用每台机器各自的 token(哈希存储、按 workspace 与能力限定、限速、留审计日志)，详见 [docs/remote-access.md](docs/remote-access.md) 与 [docs/remote-labeling.md](docs/remote-labeling.md)。API key 支持 `env:VAR` 引用，配置文件可不落盘密钥。文件 API 被限制在当前 Workspace 目录内（防路径穿越）；写入、移动和删除操作（HTTP 与 MCP 一致）仅限 `wiki/`、`raw/docs/` 与 `playbooks/packs/`（另外 `purpose.md` 和 `schema.md` 只能经 HTTP 写，其余 playbook 只能由管理员在设置里写），且永远不会落到系统专有的 `.sidecar/` 目录。对已配置数据源的原生 SQL 由数据库本身保证只读，而不只靠文本检查：守卫按数据源自己的词法规则读语句（MySQL 用 MySQL 的，TimescaleDB 与 DuckDB 用 PostgreSQL 的），先行拒绝——只允许一条语句、以 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 开头、不含写关键字；连接器随后让它单独执行，放在一个总会回滚的只读事务里，带语句超时，返回行数有上限；DuckDB 数据源只能读取自己视图背后的文件。即便如此，仍请给 knode-os 配只读的数据库账号：能伸到事务之外的东西（dblink、服务器上的文件）只受数据库用户权限的约束；在 MariaDB 上，一条语句还能自行解除只读（`SET STATEMENT … FOR`、`BEGIN NOT ATOMIC … END`），这只有守卫会拒绝。

## License

MIT
