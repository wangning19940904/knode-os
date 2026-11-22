import fs from 'node:fs';
import path from 'node:path';
import { RESEARCH_DIR } from '../fs/layout.js';
import { parseFrontmatter, stringList } from '../markdown.js';
import { slugify } from '../graph/store.js';
import type { RolePhase } from './profile.js';

/**
 * Research templates — what an external agent is told when knode-os asks it
 * to write a wiki page. "Thin harness, fat skills": the runner only prepares
 * a workspace, launches the CLI and validates the result; everything about
 * *how* to research and *what* a good page looks like lives in these Markdown
 * files under playbooks/research/, which the user edits like any playbook.
 *
 * `AGENTS.md` holds the protocol every kind shares; `<kind>.md` adds the
 * page-specific instructions and the output contract (path pattern, required
 * frontmatter keys and sections) the validator enforces.
 */

export type ResearchKind = 'entity' | 'concept' | 'comparison' | 'timeline' | 'question' | 'refresh' | 'verify' | 'init' | 'study' | 'section';

/** The kinds a job can be queued as directly. */
export const RESEARCH_KINDS: ResearchKind[] = ['entity', 'concept', 'comparison', 'timeline', 'question', 'refresh', 'verify', 'init'];

/**
 * The kinds of a study (docs/design/15), which only the study service
 * creates: `study` is the study itself and its report page, `section` one of
 * the pages it plans. Their outlines come from the study's brief.
 */
export const STUDY_KINDS: ResearchKind[] = ['study', 'section'];

/** Every kind a template may declare. */
export const ALL_RESEARCH_KINDS: ResearchKind[] = [...RESEARCH_KINDS, ...STUDY_KINDS];

/** A second file a template asks the agent to write next to the page (the knowledge-base guide for `init`). */
export interface TemplateCompanion {
  /** Relative to the data dir; must be a writable path (see fs/files isWritablePath). */
  path: string;
  /** Headings the file must carry. */
  sections: string[];
}

export interface ResearchTemplate {
  /** File stem under playbooks/research/. */
  name: string;
  kind: ResearchKind;
  /** Output path pattern; `{slug}` `{date}` `{kind}` are substituted. Empty = the job's target path (refresh). */
  output: string;
  maxTurns: number | null;
  requires: { frontmatter: string[]; sections: string[] };
  /** The instructions the agent reads, with `{target}` `{query}` `{output}` `{actor}` `{research}` placeholders. */
  body: string;
  path: string;
  /** Extra output files with their own required sections (validated like the page's sections). */
  companions: TemplateCompanion[];
  /** Phase prompts this kind runs instead of the profile's (relative to playbooks/research/). */
  phases: Partial<Record<RolePhase, string>>;
}

export const PROTOCOL_FILE = 'AGENTS.md';

const PROTOCOL = `# knode-os 研究协议（所有研究任务共用）

你在为一个本地知识库（knode-os）撰写或刷新一页 wiki。知识库通过名为 \`knode-os\` 的 MCP 服务器暴露给你；文件系统里以**只读**方式挂载了 \`raw/docs\`（原始文档）、\`raw/codebase\`（代码仓库，每个仓库一个目录，固定在一个 commit；仓库概览卡片在 \`raw/docs/codebase/<仓库>.md\`）、\`wiki\`（现有页面）和 \`.sidecar\`（PDF / 图片转出的 Markdown，在 \`.sidecar/<原路径>/content.md\`）。

## 工作流程

0. 不熟悉这个知识库时先看它的自述：\`knode_read\` 读数据目录根的 \`AGENTS.md\`（知识库指南：有什么、怎么命名、哪类问题先调哪个工具；本文件末尾也附有一份），再 \`knode_survey\` 看当前的目录、实体类型、谓词与时间范围。
1. 先读 \`brief.md\`：目标、输出路径、必需的 frontmatter 键与章节、可用的关系谓词、已有页面（如有）、上一次被退回的原因（如有）。
2. 起步：调用 \`knode_resolve\`（query 用 brief 的目标，带上 brief 给的 \`workset\`），拿到匹配实体、已知事实（facts）、相关文档、缺口（unknowns）和 receiptId；必要时再 \`knode_context_pack\`。
3. 深挖，直到每个章节都有依据：
   - \`knode_search\`（mode=sag 做多跳检索）找相关段落；
   - \`knode_graph_search\` 看实体的关系网（可带 valid_at / valid_range 看某个时点的关系）；
   - \`knode_claims\`（order=timeline 看时间线，include_superseded=true 看被替换的旧事实，subject 传实体名或别名）；
   - \`knode_read\` 读原文（\`raw/docs/...\`；PDF 读 \`.sidecar/<路径>/content.md\`；\`/entities/<id>.md\` 是实体的机器视图）；\`knode_grep\` 查精确字符串、代码、代号；
   - 代码问题读代码本身：先读仓库卡片 \`raw/docs/codebase/<仓库>.md\`（布局、依赖、代码地图），再 \`knode_grep\`（path="raw/codebase/<仓库>"）查符号、\`knode_search\`（kinds=["code"]）按语义找实现，\`knode_read\` 读文件；默认检索不含代码。
   - \`knode_disputes\` 看已记录的矛盾，\`knode_absences\` 看已知"查过但没有"的空档。
   所有读取都带 brief 给的 \`workset\`，这样整个任务看到的是同一时刻的知识库。
4. 写页：**只**用 \`knode_write\` 写到 brief 指定的输出路径。不要用文件工具写，不要写到别的路径，不要修改 raw/docs 或其他 wiki 页。
5. 收尾：\`knode_feedback\`（receipt_id 来自 knode_resolve；used_ids 填你真正用到的 id；outcome 写 answered / partial）→ \`knode_commit\`（workset，content 写一段 3–5 句的研究日志：看了什么、结论、没找到什么）。

## 写作规范

- 每条事实给出来源：正文里写 \`（来源：raw/docs/…）\`；出自代码的写文件路径和行号 \`（来源：raw/codebase/<仓库>/<路径>#L12-L40）\`；引用其他 wiki 页用 \`[[实体名]]\`。找不到证据的判断写成"疑似 / 据称"，并在 frontmatter 的 claims 里标 \`status: suspected\`。
- frontmatter 必须包含 brief 列出的键。其中：
  - \`aliases\`：别名、简称、英文名、股票代码等；
  - \`relations\`：只写有证据的关系，谓词用 brief 列出的本体 id（如 subsidiary_of / supplies_to / competes_with），方向读作"本页实体 <谓词> 目标"，可带 \`from\` / \`to\`；映射写法：\`supplies_to: ["[[特斯拉]]", { target: 蔚来, from: "2020-01-01" }]\`；
  - \`claims\`：可核查的断言列表：\`{ statement, type, status, eventDate, startDate, endDate }\`，subject 缺省为本页实体；
  - \`sources\`：引用过的路径列表（相对数据目录），至少一条。
- 日期一律 ISO（YYYY-MM-DD / YYYY-MM / YYYY-Qn）；相对时间（去年、本季度）按来源文档的日期折算，折算不了就写清楚"截至文档日期"。
- 若输出路径上已有页面（brief 会附上全文），人写的段落（不在 \`<!-- knode:begin … -->\` 区域内的正文）必须原样保留，只能补充或纠正机器可核查的部分。
- 语言与知识库资料一致（brief 中资料是中文就写中文）；术语、公司名保留原文。

## 联网核实（仅当 brief 写明"联网核实：允许"）

- 优先官方来源：公司公告、监管披露、官网、权威数据库；新闻只作旁证。
- 每条外部事实在 \`sources\` 里写完整 URL，正文标注核实日期（"截至 2026-09-15 核实"）。
- 只有单一外部来源支持的事实，claims 用 \`status: suspected\`；两个独立来源一致才写 \`fact\`。
- 不整段粘贴外部文本，只转述与引用要点。
- 核实身份时把结论写进 frontmatter：\`sameAs: [已知实体名]\`（确认同一实体）、\`notSameAs: [已知实体名]\`（确认不是），名字用知识库里的规范名。

## 禁止

- 不编造来源、数字和日期；不确定的进"争议与缺口"。
- 不运行 shell 命令；不访问互联网，除非 brief 写明允许。
- 不在输出契约之外新建文件。
`;

const ENTITY = `---
type: research-template
kind: entity
output: wiki/entities/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, aliases, sources, actor, research]
  sections: ["## 概要", "## 关键事实", "## 关系", "## 时间线", "## 争议与缺口", "## 来源"]
---
# 实体研究页：{target}

为实体 **{target}** 写一页档案，目标是"读这一页就知道知识库里关于它的一切、以及哪些还不知道"。

## 步骤

1. **身份**：规范名、别名（含英文名 / 简称 / 代码）、类型（用本体里的实体类型）、一句话定义。用 \`knode_graph_search\` 和 \`/entities/<id>.md\` 确认知识库已知的别名与邻居。
2. **关键事实**：从 \`knode_claims\`（order=timeline）和检索到的段落里挑出对理解该实体最重要的 5–15 条事实，每条带日期与来源；被新事实替代的旧事实放进时间线而不是这里。
3. **关系**：上下游（supplies_to / customer_of）、股权与从属（subsidiary_of / owns / invested_in）、竞争与合作（competes_with / partner_of）、人事（works_at / founded）等，只写有证据的，并写进 frontmatter 的 relations。
4. **时间线**：按 eventDate 升序列出关键事件（成立、融资、并购、业绩、人事、重大合同）。
5. **争议与缺口**：\`knode_disputes\` 里的矛盾、来源互相不一致之处、过期或未核实的说法、明显缺失的信息（例如"没有 2026 年之后的财务数据"）。
6. **来源**：列出引用过的每个路径。

## 页面骨架

\`\`\`markdown
---
type: organization            # 或 person / product / project / technology / event / location …
title: {target}
aliases: []
description: 一句话定义
relations:
  supplies_to: []
  subsidiary_of: []
claims:
  - { statement: "…", type: revenue, status: fact, eventDate: "2026-04-01" }
sources: []
actor: {actor}
research: {research}
---
# {target}

## 概要
## 关键事实
## 关系
## 时间线
## 争议与缺口
## 来源
\`\`\`
`;

const CONCEPT = `---
type: research-template
kind: concept
output: wiki/concepts/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, aliases, sources, actor, research]
  sections: ["## 概要", "## 核心观点", "## 相关实体", "## 演变", "## 争议与缺口", "## 来源"]
---
# 概念研究页：{target}

为概念 / 主题 **{target}** 写一页综述：它是什么、知识库里的资料怎么说、涉及哪些实体、观点如何随时间变化。

## 步骤

1. 用 \`knode_search\`（mode=sag）和 \`knode_graph_search\` 找到讨论该概念的段落与实体簇；用 \`knode_read\` 读最重要的 3–8 篇原文。
2. **核心观点**：归纳 3–7 个要点，每个要点后面给出支持它的来源；不同来源的分歧单列。
3. **相关实体**：以 \`[[实体名]]\` 链接，并在 frontmatter 的 relations 里用 related_to / uses / depends_on / part_of 等谓词记录（本页实体是概念本身）。
4. **演变**：按时间列出该概念在资料中的出现与变化（首次提出、关键节点、最新进展）。
5. **争议与缺口**：矛盾、过期、缺证据的地方。

frontmatter：\`type: concept\`，其余同实体页。
`;

const COMPARISON = `---
type: research-template
kind: comparison
output: wiki/comparisons/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 概要", "## 对比维度", "## 逐项对比", "## 结论", "## 来源"]
---
# 对比页：{target}

对 **{target}** 中列出的对象（用 " vs " 或 "、" 分隔）做结构化对比。

## 步骤

1. 对每个对象分别 \`knode_resolve\` / \`knode_claims\`，确认它们在知识库里的规范名与可比事实。
2. **对比维度**：选 4–8 个资料真正支持的维度（规模、业务、财务、技术路线、时间线、风险 …）。
3. **逐项对比**：用表格，每格给出数值 / 描述与来源；缺数据的格子明确写"无资料"。
4. **结论**：基于对比得出的判断，并说明不确定性。

frontmatter：\`type: comparison\`；relations 里可用 competes_with / partner_of 记录对象之间的关系；claims 记录对比中用到的关键数字。
`;

const TIMELINE = `---
type: research-template
kind: timeline
output: wiki/timelines/{slug}.md
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 概要", "## 时间线", "## 来源"]
---
# 时间线页：{target}

把知识库里关于 **{target}** 的事件按时间整理成一条可核查的时间线。

## 步骤

1. \`knode_claims\`（subject={target}，order=timeline，include_superseded=true）拿到所有带日期的断言；\`knode_search\` 补充没有进入 claims 的事件。
2. **时间线**：每行 \`- YYYY-MM-DD · 事件 · （来源：…）\`，同一天多个事件分行；日期精度按资料（年 / 月 / 季 / 日）。
3. 被后来事实替代的条目保留并标注 "（后被 … 替代）"。
4. 把每个事件写进 frontmatter 的 claims（eventDate 必填）。

frontmatter：\`type: timeline\`。
`;

const QUESTION = `---
type: research-template
kind: question
output: wiki/questions/{slug}.md
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 问题", "## 结论", "## 论据", "## 缺口", "## 来源"]
---
# 问答归档页：{query}

回答问题 **{query}**，并把答案归档成一页，供以后直接查阅（知识复利：同样的问题不必再查一遍）。

## 步骤

1. \`knode_resolve\`（query 原样）→ 看 slots / facts / unknowns，弄清答案需要哪些信息、本地已有哪些。
2. 逐项取证：\`knode_claims\`、\`knode_search\`、\`knode_read\`；每个论据带来源与日期。
3. **结论**：直接回答，先说结论再说条件与不确定性；用 "截至 <最新资料日期>" 限定时效。
4. **缺口**：回答不了或只能部分回答的部分，以及下一步该找什么资料。
5. frontmatter：\`type: question\`，\`question\` 键写原问题；relations 可空；claims 写结论依赖的关键断言。
`;

const REFRESH = `---
type: research-template
kind: refresh
output: ""
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: []
---
# 刷新页面：{target}

页面 **{target}** 依据的事实或它引用的文件已经变化（brief 里列出了变化）。重新核对并更新它，而不是重写。

## 步骤

1. 读 brief 附上的现有页面全文与"变化清单"（新增 / 过期 / 被替代的事实、新的矛盾）。
2. brief 有"引用的文件已变化"一节时，本次刷新的范围就是它：只重新核对引用了那些文件的陈述，用 \`knode_read\` 读文件的当前版本，改正说法与行号；引用了已删除文件的陈述，找到新位置改引，找不到就移到"未核实"或"争议与缺口"；其余段落原样保留。该节要求审计时，再从头列一遍入口并与页面对比。
3. 没有那一节时：用 \`knode_claims\`（include_superseded=true）和 \`knode_search\` 核对每一节；改正过时的数字与说法，补充新事实，更新时间线。
4. 人写的段落原样保留；只改机器可核查的内容；在 "## 争议与缺口" 记录本次仍未解决的问题。
5. 更新 frontmatter 的 claims / relations / sources；\`research\` 键用 brief 给的新值。frontmatter 有 \`repositories: [{ name, commit }]\` 时，把重新核对过的仓库的 \`commit\` 改成 brief 列出的镜像当前 commit，没核对的仓库保持原值。
`;

const VERIFY = `---
type: research-template
kind: verify
output: wiki/reviews/{slug}.md
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 核实对象", "## 别名与代码", "## 结构关系", "## 核实结论", "## 来源"]
---
# 核实：{target}

核实知识库里关于 **{target}** 的身份信息：它是谁、有哪些别名与代码、和哪些实体是同一个 / 不是同一个、母子公司与关键人物是否属实。brief 会说明是否允许联网；允许时按协议的"联网核实"一节做。

## 步骤

1. \`knode_graph_search\` 与 \`/entities/<id>.md\` 看知识库当前对它的认识（别名、关系、断言）；\`knode_suggestions\` 看是否有待审的合并建议涉及它。
2. **别名与代码**：逐条核实规范名、英文名、简称、股票代码 / 统一社会信用代码等，标注来源。
3. **结构关系**：母公司、子公司、控股股东、上下游关键对手方、董事长 / CEO；只写有来源的，写进 frontmatter 的 relations。
4. **核实结论**：明确列出 \`sameAs\`（与知识库里哪些实体是同一个）和 \`notSameAs\`（容易混淆但不是同一个的实体），并写进 frontmatter。
5. claims 里记录核实过的关键事实（含 eventDate / startDate），外部单一来源用 suspected。

frontmatter：\`type: review\`，\`title: 核实：{target}\`，另有 \`sameAs\`、\`notSameAs\`、\`relations\`、\`claims\`、\`sources\`。
`;

const INIT = `---
type: research-template
kind: init
output: wiki/overview.md
maxTurns: 60
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 知识库是什么", "## 主题地图", "## 核心实体", "## 资料概况", "## 时间范围与时效", "## 缺口与建议", "## 来源"]
companions:
  - path: AGENTS.md
    sections: ["## 知识库是什么", "## 资料与目录", "## 本体与命名", "## 如何查询", "## 如何写入与学习", "## 已知缺口", "## 人工备注"]
phases:
  plan: phases/init-plan.md
  research: phases/init-research.md
  synthesize: phases/init-synthesize.md
---
# 知识库初始化

这不是研究某个实体，而是给**整个知识库**做一次初始化：写一页总览（\`{output}\`）和一份给后来 agent 看的指南（数据目录根的 \`AGENTS.md\`）。目标是：一个从没见过这个知识库的 agent，读完这两份文件就知道库里有什么、按什么规范组织、遇到什么问题先调哪个工具、怎么把新知识写回来。

## 步骤

1. **摸底**：brief 附有系统预先整理的「知识库概况」（文档目录、实体类型与谓词、claims、时间范围、已有 wiki 页、本体包）。用 \`knode_survey\` 取最新数字，\`knode_ls\` / \`knode_read\` 看目录与代表性文档，\`knode_graph_insights\` / \`knode_graph_search\` 看实体簇与枢纽，\`knode_claims\`（order=timeline）看时间跨度，\`knode_query\`（source=catalog）在需要精确计数时写 SQL。
2. **主题地图**：把资料按主题分成 3–8 块，每块写清代表文档、涉及实体、时间范围。值得单独成页的主题在规划阶段列成 topics（系统会把它们作为后续研究任务排队）；总览里用 \`[[页面名]]\` 链接已有页面，未成页的写"（待研究）"。
3. **核心实体**：按类型列出提及最多、关系最密的实体（用规范名，附别名），说明它们之间最重要的关系。
4. **资料概况**：目录含义、文件类型、数量、来源渠道、更新节奏；PDF / 图片的转换文本在 \`.sidecar/<路径>/content.md\`。
5. **时间范围与时效**：资料覆盖的时段、最新资料日期、哪些内容可能过期。
6. **缺口与建议**：没有资料的时段 / 主题、抽取明显缺失（extraction_queue 未清空、未知谓词、待合并实体）、互相矛盾的地方、建议下一步研究什么。
7. **指南**：按下面的骨架写 \`AGENTS.md\`，每节 3–12 行，只写可操作、可核查的内容（路径、工具名、谓词 id、命名规范），不写泛泛的工具说明；\`## 人工备注\` 只写标题，正文由系统从上一版原样保留。

## 总览页骨架

\`\`\`markdown
---
type: overview
title: 知识库总览
description: 一句话说明这个知识库是什么
selfEntity: false
sources: []
actor: {actor}
research: {research}
---
# 知识库总览

## 知识库是什么
## 主题地图
## 核心实体
## 资料概况
## 时间范围与时效
## 缺口与建议
## 来源
\`\`\`

## 指南骨架（AGENTS.md，数据目录根）

\`\`\`markdown
# 知识库指南

## 知识库是什么
领域、用途、规模（文档 / 实体 / claims 数）、更新节奏。

## 资料与目录
raw/docs 各子目录放什么、时间范围、代表文档路径；wiki 各目录；.sidecar 的用法。

## 本体与命名
实体类型与关系谓词 id（来自本体包）、规范名与别名习惯、容易混淆的实体。

## 如何查询
按问题类型给出工具顺序（knode_resolve → knode_search mode=sag / knode_claims / knode_graph_search / knode_query source=catalog）、好用的关键词、workset 用法。

## 如何写入与学习
knode_write 的路径约定、必需 frontmatter、quarantine 与 promote、dispute。

## 已知缺口
没有资料的时段 / 主题、抽取缺失、未知谓词、待合并实体。

## 人工备注
\`\`\`
`;

/**
 * How the four comparison types read the shape (src/research/chart.ts), for
 * the templates a workspace is seeded with — and, since those are never
 * refreshed, for the study document every page and report is briefed with.
 */
export const CHART_TYPE_GUIDE = `- share：份额随时间变化（每列画成 100%）。x 是时期，每家一个 series；值是 % 时每列应合计 100（缺的部分加一个"其他" series），也可以直接给金额，图会按列折算成份额。
- scatter：两个指标的散点，如估值对增速。x 是各点的名字；正好两个 series，先横轴指标、后纵轴指标，单位写进 series 名（"Forward P/E, ×"）。
- waterfall：桥图，如毛利率从上一季到这一季的拆解。只有一个 series：第一根和最后一根是水平值，中间是变动（可正可负）；中间还有小计时，用 "totals": ["Q2", "毛利", "Q3"] 按 x 标签列出所有水平值。变动加起来要等于下一个水平值。
- timeline：代际或里程碑的时间线，如各家 HBM3E → HBM4 → HBM4E。x 按先后列出代际，每家一个 series，值是时间："2025"、"2025-03"、"2025-Q4"、"2026-H1"（或 2025 这样的数字），还没有就写 null。
- 颜色按 series 区分；一个 series 只表示一类东西（一家公司、一个指标），不要用颜色表示名次。`;

/** The chart block every study page may carry (src/research/chart.ts); the viewers draw it, Obsidian shows the JSON. */
const CHART_RULES = `## 图表（\`\`\`chart 块）

有一组可比的数字（按年份的收入、成本构成、各方份额、估值对比……）时，在相关章节放一个图表块；数字必须来自你引用的来源，图下用一两句话说明它说明了什么。不要为画图而画图，一页 1–4 个足够。写之前可以用 knode_chart 检查格式。

\`\`\`\`markdown
\`\`\`chart
{"type": "bar", "title": "图题", "unit": "USD bn", "x": ["2023", "2024", "2025"],
 "series": [{"name": "收入", "values": [0.1, 0.9, 4.5]}],
 "source": "raw/docs/research/<课题>/files/<文件>", "note": "口径说明（可选）"}
\`\`\`
\`\`\`\`

- type：bar（类别对比）/ hbar（类别名长或做排名）/ stacked-bar（构成，值不能为负）/ line、area（时间序列，至少 3 个点）/ share、scatter、waterfall、timeline（见下）。
- x 与每个 series.values 一样长；缺的值写 null；最多 8 个 series、60 个类别；一张图只用一个单位、一根纵轴（量纲不同就画两张）。
- source 必填：数字出自哪些 raw/docs 路径（或 URL）。
${CHART_TYPE_GUIDE}`;

const SECTION = `---
type: research-template
kind: section
output: wiki/research/{slug}.md
maxTurns: 60
requires:
  frontmatter: [type, title, study, sources, actor, research]
  sections: []
---
# 研究课题分页：{target}

这一页是一个研究课题（study）的一部分。brief 的「研究课题」一节写明课题的目标、范围、**本页要回答的问题**、本页的必需章节、输出语言，以及收集阶段已经存进知识库的资料：\`raw/docs/research/<课题>/\` 下的网页（web/）、文件（files/：PDF、数据）、收集员的笔记（notes/）和资料登记表（sources.md）。

## 步骤

1. **读已收集的资料**：knode_read 读本课题的 sources.md 与 notes/ 里和本页有关的笔记；knode_search（sources 限定 \`raw/docs/research/<课题>\`，mode=sag）找段落。长文档（招股书、年报）用 knode_read 的 \`section\`（章节标题）或 \`offset\` / \`limit\`（行）分段读，不要整篇读。
2. **逐个回答本页的问题**：每个结论都写出处——引用 raw/docs/... 路径（正文 \`（来源：raw/docs/…）\` 或脚注），而不是只给 URL。资料不够时：brief 允许联网就继续搜索，要引用的网页 / PDF 先用 **knode_capture** 保存（带 study 参数），引用它返回的路径；不允许联网就写进缺口。
3. **区分事实与观点**：公司自己披露的数字、监管文件、审计数据是事实；分析师、媒体、投资人的判断是观点，写明是谁、何时说的（claims 里 kind 用 opinion / prediction）。互相矛盾的数字并列写出并说明口径。
4. **数字与图表**：见下文图表规则。
5. **写页**：用 knode_write 写到输出路径。frontmatter：\`type: research-page\`，\`title\`，\`study\`（课题 id，见 brief），\`sources\`（每一个引用过的 raw/docs 路径），\`relations\`（谓词用本体 id，本页的主语是 brief 指定的主体实体），\`claims\`（关键数字与判断，带日期），\`actor\` / \`research\` 用 brief 给的值。
6. **与其他分页互链**：brief 列出了本课题的其他页面，相关处用 \`[[页面名]]\` 指过去，不要重复它们的内容。

${CHART_RULES}
`;

const STUDY = `---
type: research-template
kind: study
output: wiki/research/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, study, sources, actor, research]
  sections: []
---
# 研究报告（课题总页）：{target}

这是一个研究课题（study）的总页：分页已经写好（brief 的「本课题的页面」列出了它们的路径、标题与状态），资料也已存进知识库。你的任务是写一页**能单独读懂**的研究报告：先回答最初的问题，再把读者引到各分页。

## 步骤

1. knode_read 读每一个已完成的分页（只读，不要改它们），和本课题的 sources.md；需要时 knode_search 补充。
2. **摘要**：用 5–10 句话直接回答用户最初的研究请求（brief 的「原始请求」），先结论后条件；数字带日期和出处。
3. **关键发现**：8–15 条，每条一句话 + 出处（分页的 [[链接]] 或 raw/docs 路径）。
4. **本研究的页面**：每个分页一行：\`[[页面名]]\` — 它回答了什么。没写成的分页如实说明。
5. **图表**：挑 1–3 个最能说明问题的数字序列（分页里的图表可以复用）。
6. **待解问题**：资料缺口、互相矛盾的数字、只有单一来源的说法、需要后续跟踪的事件与日期。
7. **方法与来源**：研究日期、用了哪些来源（知识库 / 网络 / 自定义来源）、收集了多少份资料、主要一手来源是什么。
8. 用 knode_write 写到输出路径；frontmatter：\`type: research-report\`、\`title\`、\`study\`、\`sources\`（引用过的 raw/docs 路径与分页路径）、\`actor\` / \`research\` 用 brief 给的值。

${CHART_RULES}
`;

const BUILTIN: Record<ResearchKind, string> = { entity: ENTITY, concept: CONCEPT, comparison: COMPARISON, timeline: TIMELINE, question: QUESTION, refresh: REFRESH, verify: VERIFY, init: INIT, study: STUDY, section: SECTION };

export type PhaseName = 'plan' | 'research' | 'synthesize' | 'review' | 'revise' | 'orchestrate' | 'init-plan' | 'init-research' | 'init-synthesize' | 'refine' | 'collect';

/**
 * The team pipeline's phase prompts (research.pipeline = "team"). Each is a
 * plain Markdown file under playbooks/research/phases/ with `{placeholders}`;
 * the first line names the phase so a harness (or a test double) can tell
 * them apart. Edit them like any playbook.
 */
export const PHASES: Record<PhaseName, string> = {
  plan: `<!-- knode-phase: plan -->
# 阶段 1：规划

你是研究团队的负责人。先读后面附上的任务简报，用 knode_resolve / knode_graph_search / knode_search 快速摸底（不超过 {maxTurns} 轮），然后给出研究提纲：把页面拆成 3–6 个可以并行调查的子任务，每个子任务对应一个章节，写清要回答的问题、建议的检索词和涉及的实体。

只输出一个 JSON 对象，不要其他文字：
{"sections":[{"title":"## 章节标题","questions":["…"],"queries":["…"],"entities":["…"]}],"notes":"整体判断，一两句"}

章节标题必须覆盖简报里列出的必需章节（可以增加，不能遗漏）；"来源"章节由主笔汇总，不必单列。
`,
  research: `<!-- knode-phase: research -->
# 阶段 2：调查「{section}」

你是研究团队的一名研究员，只负责这一个章节。用 knode_search（mode=sag）、knode_graph_search、knode_claims（order=timeline，include_superseded=true）、knode_read、knode_grep 取证；所有读取都带 workset \`{workset}\`。**不要写任何页面**（不要调用 knode_write / knode_commit）。

要回答的问题：
{questions}

建议检索词：{queries}

输出 Markdown（不要 frontmatter），固定结构：

## 发现
- 每条一行：结论 · 日期 ·（来源：路径）

## 候选 claims
- {"statement":"…","type":"…","status":"fact|suspected","eventDate":"…","startDate":"…","endDate":"…","source":"路径"}

## 候选 relations
- {"target":"实体名","type":"本体谓词","from":"…","to":"…","source":"路径"}

## 缺口
- 没找到什么、哪里互相矛盾
`,
  synthesize: `<!-- knode-phase: synthesize -->
# 阶段 3：综合成页

你是主笔。后面附上任务简报与各研究员的发现。按简报的输出契约与模版把发现综合成最终页面，用 knode_write 写到 \`{output}\`（只写这一处）。规则：
- 发现里没有依据的事实不写；每条事实保留来源路径；矛盾与缺口写进相应章节。
- 候选 claims / relations 经你核对后写进 frontmatter（谓词用本体 id，日期 ISO）；frontmatter 必须包含简报列出的必需键。
- 简报里标注为人写的段落原样保留。
写完后 knode_feedback（receipt 见简报）并 knode_commit（workset \`{workset}\`，content 写一段研究日志）。
`,
  review: `<!-- knode-phase: review -->
# 阶段 4：评审

你是评审。对照简报的输出契约与写作规范检查页面 \`{output}\`（用 knode_read 读取；抽查 2–3 条事实的来源是否属实）。只输出一个 JSON 对象：
{"pass":true|false,"issues":[{"where":"章节或 frontmatter 键","problem":"…","fix":"…"}],"summary":"一句话"}

不通过的情形：事实无来源或与来源不符、日期或数字错误、必需章节缺失或空洞、frontmatter 缺键或谓词不在本体内、人写段落被删。小问题（措辞、排版）只写进 issues，不影响 pass。
`,
  revise: `<!-- knode-phase: revise -->
# 阶段 5：修订

评审与校验发现了下面的问题。用 knode_read 读取当前页 \`{output}\`，逐条修正后用 knode_write 重新写入**同一路径**，其余内容和人写段落保持不变。

问题清单：
{issues}
`,
  orchestrate: `<!-- knode-phase: orchestrate -->
# 主管（原生子代理模式）

你是研究团队的负责人，也是主笔。CLI 已经为你注册了下面这些子代理，按需派发任务（互不依赖的任务并行派发），最后由你自己核对发现并用 knode_write 把页面写到 \`{output}\`（只写这一处）：

{agents}

流程：先 knode_resolve 摸底（workset \`{workset}\`）→ 把页面拆成 3–6 个章节 → 每个章节派给一个研究员子代理，任务里写清要回答的问题、建议检索词、涉及实体和 workset → 汇总发现写页（每条事实带来源；候选 claims / relations 核对后进 frontmatter）→ 派评审子代理检查页面 → 按评审意见修订 → knode_feedback → knode_commit（workset \`{workset}\`，content 写一段研究日志）。

子代理没有 knode_write；只有你写页。子代理返回的内容没有来源就不要采用。
`,
  refine: `<!-- knode-phase: refine -->
# 研究课题规划

你是研究规划员。用户给了一个想研究的主题。你的任务是把它变成一份可以直接执行的研究简报：改写成清楚的研究问题，补上用户可能没想到但重要的方面，拆成可以分头调查的问题，并规划要写的 wiki 页面。你**不做研究本身**，也不调用任何工具——只根据下面给出的信息规划。

今天是 {today}。输出语言：{language}（简报里所有面向读者的文字——标题、目标、问题、页面标题与章节——都用这个语言）。最多规划 {maxPages} 个分页（另有一页总报告，不必列入 pages）。

{context}

规划规则：
- objective 用一段话说清：要回答什么、为什么、读者读完能做什么判断。restatement 把用户原话改写成结构清楚的研究请求。
- 用户点名的方面一个都不能漏；再补 2–5 个用户没提但懂行的人一定会看的方面（风险、监管、会计口径、关键人物、时间节点、数据可得性……），在 why 里说明为什么重要。
- questions：12–30 个具体、可回答、可查证的问题，每个归属一个分页（page 填分页 id），queries 给 2–4 个检索词（含英文原名、代码、常见别称）。
- pages：3–{maxPages} 个分页，按读者阅读顺序排；每页 4–7 个章节（"## " 开头的标题，用输出语言；不要写"来源 / Sources"章节，系统会加）；charts 写本页适合画的图（数据是什么）；entities 列本页涉及的主要实体（规范名）。
- 资料是否可得要现实：知识库里已有什么见下文；需要联网的地方在 seedUrls 给出你确信存在的一手来源 URL（监管文件、公司官网 / 投资者关系、官方博客），不确定的 URL 不要写，交给检索。
- clarifications：最多 4 个真正会改变研究方向的问题（例如"最新招股书"指哪一份、关注的时间范围、要不要覆盖某类竞争对手），每个给 2–4 个选项；没有就留空数组。已经回答过的问题不要再问，按回答调整计划。
- 如果下面给出了上一版简报和用户的修改意见，在上一版的基础上按意见修改，保留没被否定的部分。

只输出一个 JSON 对象，不要其他文字：
{"title":"…","language":"{language}","objective":"…","restatement":"…","scope":{"include":["…"],"exclude":["…"],"timeframe":"…","asOf":"{today}"},"assumptions":["…"],"clarifications":[{"question":"…","options":["…","…"]}],"questions":[{"id":"q1","text":"…","why":"…","page":"p1","queries":["…"]}],"pages":[{"id":"p1","title":"…","purpose":"…","sections":["## …"],"questions":["q1"],"charts":["…"],"entities":["…"]}],"entities":["…"],"seedUrls":[{"url":"https://…","why":"…"}],"searchQueries":["…"],"report":{"title":"…","sections":["## …"]}}
`,
  collect: `<!-- knode-phase: collect -->
# 收集资料：「{page}」

你是研究课题「{title}」的资料收集员，只负责下面这一部分。你的产出是两样东西：**存进知识库的原始资料**（用 knode_capture），和一份**带出处的发现笔记**（你的最终回复）。你不写 wiki 页（不要调用 knode_write / knode_commit）。

课题 id：\`{study}\`（每次 knode_capture 都带上 study="{study}"）
课题目标：{objective}
本部分要回答的问题：
{questions}
建议检索词：{queries}
输出语言：{language}

## 步骤

1. **先查知识库**：knode_resolve / knode_search（mode=sag）/ knode_claims。已经在库里的资料不必再收集，直接引用它的路径。库里有代码仓库时（raw/codebase，卡片在 raw/docs/codebase），实现层面的问题直接读代码：knode_grep（path="raw/codebase/<仓库>"）、knode_search（kinds=["code"]）、knode_read，引用 raw/codebase/… 路径与行号。
2. **再查网络与其他来源**（见 brief 的「资料来源」）：一手资料优先——监管文件（如 SEC EDGAR 的 S-1 / 10-K / 424B）、公司公告与招股书、财报、官方博客与投资者关系页、权威数据库；其次是可靠媒体、研究机构与分析师报告。时间敏感的信息以最新日期为准，并记下日期。
3. **保存要依赖的资料**：每一份你会引用的网页 / PDF / 数据，用 knode_capture（url、study="{study}"、why 一句话）。它返回的 path（raw/docs/research/…）就是以后引用的来源；返回的 outline 是文档的章节，长文档用 knode_read 的 section 分段读。抓取失败（403、需要登录、只有脚本）时换一个来源（同一文件的 PDF / 其他镜像），实在不行再把你读到的要点作为 content 传给 knode_capture，存成摘录。
4. **不要保存**搜索结果页、目录页、与问题无关的页面；同一事实已有一手来源就不必再存转载。最多保存 {maxCaptures} 份。
5. 每个问题都尽量给出答案；答不了的写进缺口，说明查过哪里。

## 输出（Markdown，不要 frontmatter，固定结构）

## 发现
- 每条一行：结论（含数字与日期）·（来源：raw/docs/research/… 路径）
## 数据
- 可以画图的数字序列，每条一行：名称 · 单位 · 各期数值（期间=数值，…）·（来源：路径）
## 观点
- 别人怎么看：谁、何时、什么判断 ·（来源：路径）
## 缺口
- 没找到什么、互相矛盾之处、哪些说法只有单一来源
`,
  'init-plan': `<!-- knode-phase: plan -->
# 阶段 1：规划知识库初始化

你是研究团队的负责人。这个任务不是研究某个实体，而是给**整个知识库**写一页总览（{output}）和一份给后来 agent 看的指南（数据目录根的 AGENTS.md）。先读后面附上的简报——「知识库概况」里有文档目录、实体类型与谓词、claims、时间范围、已有页面与缺口——再用 knode_survey / knode_ls / knode_graph_insights / knode_search（mode=sag）快速摸底，不超过 {maxTurns} 轮。

只输出一个 JSON 对象，不要其他文字：
{"sections":[{"title":"## 主题地图","questions":["资料按主题能分成哪几块？每块的代表文档是什么？"],"queries":["…"],"entities":["…"]}],"topics":[{"kind":"concept|entity|timeline|comparison","target":"…","why":"为什么值得单独写一页"}],"notes":"整体判断，一两句"}

规则：
- sections 必须覆盖简报列出的必需章节（可以增加，不能遗漏）；「来源」由主笔汇总，不必单列。每个 section 是一个可以独立调查的领域：questions 写清要回答什么，queries 给检索词，entities 列涉及的实体。
- topics 给 4–12 条，按"读者最先需要懂什么"排序：一组文档共同讨论的主题 → concept；提及多、关系密但还没有研究页的实体 → entity；有连续事件的对象 → timeline；总被放在一起比较的对象 → comparison。target 用知识库里的规范名。
`,
  'init-research': `<!-- knode-phase: research -->
# 阶段 2：调查「{section}」（知识库初始化）

你是研究团队的一名研究员，只负责总览页的这一节。调查对象是整个知识库，不是某个实体：用 knode_survey 看总体数字，knode_ls / knode_read 看目录与代表性文档，knode_graph_search / knode_graph_insights 看实体簇与枢纽，knode_claims（order=timeline）看时间跨度，knode_query（source=catalog）在需要精确计数时写 SQL；所有读取都带 workset \`{workset}\`。**不要写任何页面**（不要调用 knode_write / knode_commit）。

要回答的问题：
{questions}

建议检索词：{queries}

输出 Markdown（不要 frontmatter），固定结构：

## 发现
- 每条一行：结论 · 依据（路径，或工具名 + 参数）

## 值得单独成页的主题
- {"kind":"concept|entity|timeline|comparison","target":"…","why":"…"}

## 给指南的提示
- 后来的 agent 查这一块该先用什么工具、什么关键词、哪些目录最有用、有什么坑

## 缺口
- 没有资料 / 资料互相矛盾 / 抽取明显缺失的地方
`,
  'init-synthesize': `<!-- knode-phase: synthesize -->
# 阶段 3：写总览与指南

你是主笔。后面附上任务简报（含「知识库概况」与上一版指南，如有）和各研究员的发现。用 knode_write 写**两个文件**，然后收尾：

1. \`{output}\`：知识库总览页，按简报的输出契约与模版骨架写；frontmatter 保留 \`selfEntity: false\`；主题地图用 \`[[页面名]]\` 链接已有页面，尚未成页的主题写"（待研究）"；每条判断给依据（来源路径或工具）；sources 列出引用过的路径。
2. \`AGENTS.md\`（数据目录根，knode_write 的 path 就是 \`AGENTS.md\`）：给后来 agent 的指南，章节固定为简报列出的指南必需章节。每节 3–12 行，只写可操作的内容——目录路径、实体类型与谓词 id、规范名 / 别名习惯、按问题类型该先调哪个 knode_* 工具、写页与写笔记的路径约定与 frontmatter、明确的空白与陷阱。\`## 人工备注\` 只写标题，正文由系统从上一版原样保留。

规则：发现里没有依据的事实不写；矛盾与缺口写进「缺口与建议」/「已知缺口」；简报里标注为人写的段落原样保留。写完后 knode_feedback（receipt 见简报，若有）并 knode_commit（workset \`{workset}\`，content 写一段初始化日志：看了什么、总览与指南各写了什么、还缺什么）。
`,
};

/**
 * What knode-os seeds at `playbooks/research/<rel>` — `AGENTS.md`, `<kind>.md`
 * or `phases/<name>.md` — so Settings can reset an edited copy; undefined for
 * a file it never seeds.
 */
export function builtinResearchText(rel: string): string | undefined {
  if (rel === PROTOCOL_FILE) return PROTOCOL;
  const phase = /^phases\/([^/]+)\.md$/.exec(rel);
  if (phase) return Object.hasOwn(PHASES, phase[1]) ? PHASES[phase[1] as PhaseName] : undefined;
  const kind = /^([^/]+)\.md$/.exec(rel);
  return kind && Object.hasOwn(BUILTIN, kind[1]) ? BUILTIN[kind[1] as ResearchKind] : undefined;
}

/** Seed the phase prompts once (never overwrites user edits). */
export function ensureDefaultPhases(dataDir: string): string[] {
  const created: string[] = [];
  const dir = path.join(dataDir, RESEARCH_DIR, 'phases');
  for (const [name, text] of Object.entries(PHASES)) {
    const file = path.join(dir, `${name}.md`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    created.push(`${RESEARCH_DIR}/phases/${name}.md`);
  }
  return created;
}

/** A phase prompt with its placeholders filled. */
export function loadPhasePrompt(dataDir: string, name: PhaseName, vars: Record<string, string>): string {
  ensureDefaultPhases(dataDir);
  const file = path.join(dataDir, RESEARCH_DIR, 'phases', `${name}.md`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : PHASES[name];
  return text.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

/** Seed the protocol and one template per kind (never overwrites user edits). */
export function ensureDefaultResearchTemplates(dataDir: string): string[] {
  const created: string[] = [];
  const dir = path.join(dataDir, RESEARCH_DIR);
  const protocol = path.join(dir, PROTOCOL_FILE);
  if (!fs.existsSync(protocol)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(protocol, PROTOCOL);
    created.push(`${RESEARCH_DIR}/${PROTOCOL_FILE}`);
  }
  for (const [kind, text] of Object.entries(BUILTIN)) {
    const file = path.join(dir, `${kind}.md`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    created.push(`${RESEARCH_DIR}/${kind}.md`);
  }
  created.push(...ensureDefaultPhases(dataDir));
  return created;
}

/** A path inside the data dir / playbooks/research: posix, no `..`, no absolute paths; '' when unusable. */
function cleanRelPath(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/\\/g, '/') : '';
  if (!s) return '';
  const norm = path.posix.normalize(s);
  if (norm.startsWith('/') || norm.startsWith('..') || norm === '.' || /(^|\/)\.\.(\/|$)/.test(norm)) return '';
  return norm;
}

function parseCompanions(v: unknown): TemplateCompanion[] {
  if (!Array.isArray(v)) return [];
  const out: TemplateCompanion[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const p = cleanRelPath(o.path);
    if (!p) continue;
    out.push({ path: p, sections: stringList(o.sections) });
  }
  return out;
}

const TEMPLATE_PHASE_KEYS = ['plan', 'research', 'synthesize', 'review', 'revise'] as const;

function parsePhases(v: unknown): Partial<Record<RolePhase, string>> {
  const out: Partial<Record<RolePhase, string>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const phase of TEMPLATE_PHASE_KEYS) {
    const p = cleanRelPath((v as Record<string, unknown>)[phase]);
    if (p) out[phase] = p;
  }
  return out;
}

export function parseResearchTemplate(text: string, name: string, filePath: string): ResearchTemplate | null {
  const { frontmatter: fm, body } = parseFrontmatter(text);
  if (fm.type !== 'research-template') return null;
  const kind = typeof fm.kind === 'string' && (ALL_RESEARCH_KINDS as string[]).includes(fm.kind) ? (fm.kind as ResearchKind) : null;
  if (!kind) return null;
  const requires = (fm.requires ?? {}) as Record<string, unknown>;
  const maxTurns = Number(fm.maxTurns);
  return {
    name,
    kind,
    output: typeof fm.output === 'string' ? fm.output.trim() : '',
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : null,
    requires: { frontmatter: stringList(requires.frontmatter), sections: stringList(requires.sections) },
    body: body.trim(),
    path: filePath,
    companions: parseCompanions(fm.companions),
    phases: parsePhases(fm.phases),
  };
}

/** What a job is about, for prompts and the brief: an init job is about the whole base. */
export function subjectOf(job: { kind: ResearchKind; target: string | null; query: string | null }): string {
  if (job.kind === 'init') return job.target ?? '本知识库';
  // a study's target is its slug, a page's `<study>/<page>`: the title (query) is what it is about
  if (job.kind === 'study' || job.kind === 'section') return job.query ?? job.target ?? '';
  return job.kind === 'question' ? job.query ?? job.target ?? '' : job.target ?? job.query ?? '';
}

/** Every template under playbooks/research (built-ins seeded if missing), keyed by file stem. */
export function loadResearchTemplates(dataDir: string): Map<string, ResearchTemplate> {
  ensureDefaultResearchTemplates(dataDir);
  const dir = path.join(dataDir, RESEARCH_DIR);
  const out = new Map<string, ResearchTemplate>();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md') || entry === PROTOCOL_FILE) continue; // phases/ is a directory and is skipped
    const rel = `${RESEARCH_DIR}/${entry}`;
    try {
      const t = parseResearchTemplate(fs.readFileSync(path.join(dir, entry), 'utf8'), entry.replace(/\.md$/, ''), rel);
      if (t) out.set(t.name, t);
    } catch {
      // a broken template is skipped, not fatal
    }
  }
  return out;
}

export function loadResearchProtocol(dataDir: string): string {
  ensureDefaultResearchTemplates(dataDir);
  return fs.readFileSync(path.join(dataDir, RESEARCH_DIR, PROTOCOL_FILE), 'utf8');
}

/** Resolve the template a job uses: an explicit name, else the kind's default. */
export function templateFor(dataDir: string, kind: ResearchKind, name?: string | null): ResearchTemplate {
  const all = loadResearchTemplates(dataDir);
  if (name && all.has(name)) return all.get(name)!;
  const byKind = [...all.values()].find((t) => t.name === kind) ?? [...all.values()].find((t) => t.kind === kind);
  if (!byKind) throw new Error(`no research template for kind "${kind}" under ${RESEARCH_DIR}/`);
  return byKind;
}

/** A path-safe slug for a target or question (keeps CJK, trims long questions). */
export function researchSlug(text: string): string {
  const cleaned = text.trim().replace(/[?？!！。，,、；;:："'“”‘’()（）]+/g, ' ').replace(/\s+/g, ' ').trim();
  const slug = slugify(cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned);
  return slug;
}

export function renderOutputPath(template: ResearchTemplate, job: { kind: ResearchKind; target: string | null; query: string | null }): string {
  if (template.kind === 'refresh' || !template.output) {
    if (!job.target) throw new Error('a refresh job needs the page path as its target');
    return job.target.replace(/\\/g, '/').replace(/^\/+/, '');
  }
  const subject = subjectOf(job);
  const date = new Date().toISOString().slice(0, 10);
  // a study names its pages itself (`<study>/<page>`, already slugs); everything else is slugged from its subject
  const slug = (job.kind === 'study' || job.kind === 'section') && job.target
    ? job.target.split('/').map((part) => researchSlug(part)).filter(Boolean).join('/')
    : researchSlug(subject);
  return template.output
    .replace(/\{slug\}/g, slug || 'untitled')
    .replace(/\{kind\}/g, job.kind)
    .replace(/\{date\}/g, date);
}
