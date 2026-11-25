# Agent 框架/Harness 的演化、模型与框架的协同、当前问题与方向

调研日期：2026-11-21。

**资料来源**
- knode-os 的 Agent Atlas 工作区：
  - 研究报告 `wiki/research/production-agent-harnesses-20252026-architecture-context-en.md`，对比了九个 harness，代码快照取于 2026-10-31 至 11-09；
  - 它的六个章节页；
  - `raw/codebase/` 下的源码；
  - 评测研究、训练研究和"前沿实验室观点"研究。
- 网上补充的资料，标在每条后面。

**可信度标记**
- **[A]**：在 Atlas 里核对过，Atlas 引用了它所抓取的原文或代码。
- **[V]**：读过网上原文。
- **[S]**：只见过搜索摘要，没读原文。
- **[M]**：凭记忆写的，未核对。

---

## 1. 架构上的演化：从"开发者编排"到"模型驱动的循环 + 厚实的外壳"

### 1.1 七个主要转变

**① 控制流：从开发者编排，到模型自己跑循环**
- 2023–24 年，控制流由开发者决定：
  - LangChain 的 AgentExecutor 和 Chain 把 ReAct 循环包在里面。2024 年 6 月，LangChain 自己称它为 "legacy"，理由是 "hides too many details" [S]。
  - LangGraph（2024-01）把循环写成显式的有环 `StateGraph`，带 checkpointer、interrupt 和人工介入（HITL）[S]。
  - Langflow 更进一步，做成可视化 DAG，每个 flow 都是一个 REST API [S]。
- 2025–26 年，九个 harness 的核心循环都只有几十行 [A]：
  - 调用模型，执行模型返回的工具调用（只读的并行，写操作串行），把结果追加回去，模型不再调工具时结束；
  - LangChain 自己也收敛到了这个形态：LangChain 1.0（2025-10）用 `create_agent` 加 middleware 取代了 `create_react_agent` [S]；
  - Deep Agents 和 DeerFlow 2 都是 `create_agent` 加一叠 middleware [A]。
- 反向的趋势：企业框架保留了确定性的图，和 agent 并存。
  - Microsoft Agent Framework（2025-10，由 AutoGen 演化而来）把 Agent Orchestration 和 typed graph Workflow 分开 [S]。
  - Google ADK 2.0 弃用了 `SequentialAgent`、`ParallelAgent` 和 `LoopAgent`，改用基于图的 workflow [S]。

**② 工具：从很多抽象，到少数几个原语工具**
- Pi 只有 read、bash、edit、write 四个工具，提示词加工具定义不到 1000 token [A]。
- mini-swe-agent 只有 bash，agent 类约 100 行 [A]。
- Codex 没有读文件工具，只靠 shell 加 `apply_patch` [A]。
- Claude Code 在 Unix 类系统上默认去掉了 Glob 和 Grep，改用 Bash 里的 find/grep [A]。
- smolagents 更极端：动作本身就是 Python 代码（CodeAgent）[A]。
- Vercel 的文章《We removed 80% of our agent's tools》也是同一个方向 [A]。

**③ 上下文：从塞进 prompt，到上下文工程**
九个 harness 用的是同一套配方 [A]：
- 前缀逐字节稳定，变化以增量追加，目的是保住 KV cache；
- 到阈值就压缩：保留最近的尾部，摘要用结构化模板；
- 大块工具输出写到文件，上下文里只放路径和预览（"可恢复压缩"）；
- 子 agent 用全新上下文，只返回一条最终消息；
- AGENTS.md 和 SKILL.md 两个目录级标准，九个 harness 全都实现了；
- MCP 工具改为懒加载：Claude Code 和 Codex 用 tool search，OpenCode 和 Pi 用 code mode。

**④ 形态：从库，到运行时加协议**
无头核心放在协议后面，TUI 只是其中一个客户端 [A]：
- Codex：Rust 写的 codex-rs（168 个 crate），app-server 是 JSON-RPC 中枢；
- OpenCode：server-first，暴露 OpenAPI；
- Claude Agent SDK：拉起闭源的 `claude` 二进制，通过 stream-json 协议通信；
- 协议层：ACP（Zed 提出，2025-08）、MCP、A2A。

**⑤ 多 agent：从固定拓扑，到按需开子 agent**
- 2023–24 年是固定拓扑：
  - AutoGen 的对话式协作 [S]；
  - CrewAI 的 role/goal/backstory，加上 Sequential 或 Hierarchical 流程 [S]；
  - Swarm 和 Agents SDK 把 handoff 做成 `transfer_to_<agent>` 工具 [A]；
  - DeerFlow v1 的 Coordinator → Planner → Researcher/Coder → Reporter [S]。
- 现在主循环把子 agent 当工具调用，主要为了隔离上下文。递归都很浅：Codex V1、OpenCode、DSH 深度为 1，Claude Code 为 3 [A]。

**⑥ 安全：沙箱和权限成为一等公民** [A]
- 各家的 OS 原语相同：Linux 上用 bubblewrap（部分加 seccomp），macOS 上用 Seatbelt。
- 截至 2026-11，只有 Codex 默认开启 OS 沙箱并断网。
- Claude Code 和 Gemini CLI 的沙箱需要手动开启。
- OpenCode 和 Pi 没有硬边界。
- 2026 年的新趋势是用模型做审批：Claude Code 的 auto 模式、Codex 的 `auto_review`。

**⑦ 核心本身插件化**
- DSH（DeepSeek Harness）：连 agent loop 本身都是插件 [A]。
- OpenCode v2：read、edit、shell 都是工具插件 [A]。
- Deep Agents：按模型提供 harness profile，例如 `_openai_codex.py`、`_anthropic_opus_4_7.py` [A]。这一点直接连到第 2 节。

### 1.2 各框架的独特设计

| 框架 | 年代 | 核心抽象 | 独特设计 |
|---|---|---|---|
| LangChain AgentExecutor | 2022–24 | Chain/Runnable，ReAct 执行器 | 把循环藏起来；2024 年中被官方称为 legacy |
| LangGraph | 2024-01 → 1.0 | 有环 StateGraph | 按 thread 做 checkpoint，支持 time travel 和 interrupt；现在是 `create_agent` 的底座 |
| Langflow | 2023– | 可视化 DAG | flow 即 API，项目即 MCP server |
| AutoGen → MS Agent Framework | 2023 → 2025-10 | 对话式多 agent → Agent 加 typed Workflow | 提供 group chat、handoff、Magentic 等模式，支持 checkpoint |
| CrewAI | 2024– | 角色化的 Crew、Task、Process | 层级式 manager；用 Flows 包裹多个 crew |
| Google ADK | 2025-04 → 2.0 | LlmAgent 树加 workflow agent | Session、State、Memory 三类服务；A2A；Vertex Agent Engine；2.0 转向图式 workflow |
| OpenAI Swarm → Agents SDK | 2024-10 → 2025-03 | Agent 加 Runner，handoff 即工具 | guardrails、tracing、sessions；2026 年增加 Sandbox Agents |
| smolagents | 2024-12 | CodeAgent | 动作就是 Python 代码，核心不到 1000 行 |
| Claude Code / Agent SDK | 2025-02 → SDK 2025-09 | 闭源 CLI 循环，SDK 走 stream-json | 33 个 hook 事件（被 Codex、Gemini CLI、Deep Agents、DSH 照搬或兼容，成了事实标准）；skills、plugins；只用精确匹配的 `str_replace`，靠先读后改保证正确；带 OTel 成本指标和硬性 USD 预算上限 |
| OpenAI Codex | 2025-04 → | Rust 核心加 app-server JSON-RPC | 默认开 OS 沙箱并断网；V4A `apply_patch`，freeform 语法，四遍容错匹配；工具调用一流完就开始执行；`/goal` 把目标存进 SQLite 并做完成审计；只支持 Responses API |
| OpenCode | 2025 → v2 | Effect 写的核心，HTTP server | 支持多家模型；**按模型切换编辑格式**（gpt- 用 patch，其他用 edit）；steer/queue 两种插话收件箱；默认 code-mode MCP |
| Gemini CLI | 2025-06 | GeminiClient 循环 | 唯一默认设硬轮数上限的（100 轮）；有循环检测和 next-speaker 判断；TOML 策略引擎分管理员层级；ACP 的参考实现 |
| Pi | 2025 → | pi-ai → agent-core → coding-agent | 刻意极简：四个工具，没有子 agent、plan mode 和权限系统；进程内扩展的事件 API 最丰富 |
| Deep Agents | 2025-07 → | `create_agent` 加固定的 middleware 栈 | 虚拟文件系统后端可插拔；`task` 子 agent；按模型的 harness profile；0.7 版默认移除了 todo 工具 |
| DeerFlow | v1 2025-05 → v2 2026-02 | v1 是 LangGraph 研究流水线；v2 是 super-agent harness | v2 与 v1 不共享代码；子 agent 池（3 个并发）；容器沙箱；`[rN]` 引用约定 |
| DeepSeek Harness (DSH) | 2026 | Cordis 插件树 | 一切皆插件；每次模型请求和每次工具调用前都做 checkpoint，fail-closed，结果未知的工具调用绝不重试，是最严格的崩溃语义 |

**一句话总结**
- 2023–24 年的框架在"替模型做决策"：链、图、角色、拓扑。
- 2025–26 年的 harness 在"替模型管环境"：上下文、缓存、工具输出、沙箱、持久化、扩展点。
- 循环本身已经不值钱了，工程量都在循环周围。

---

## 2. 模型与框架是相辅相成的：研究与社区证据

你的印象是对的。Cursor 确实写过这件事，而且模型厂商自己也承认。

### 2.1 厂商和实验室的表态

1. **Cursor，《Continually improving our agent harness》，2026-04-30，Heule & Katz** [V，本次亲自核对过原文]
   - 原话："OpenAI's models are trained to edit files using a patch-based format… Anthropic's models are trained on string replacement."
   - 两种工具任一模型都能用，但 "giving it the unfamiliar one costs extra reasoning tokens and produces more mistakes"，所以 "we provision each model with the tool format it had during training"。
   - 用户中途换模型时，Cursor 会切换到对应模型的 harness，并加说明告诉新模型它是中途接手。Cursor 也建议一个对话尽量用同一个模型，原因之一是 cache 按模型隔离。
   - **注意：这篇没有给出"用错工具掉多少分"的具体数字。**
2. **Cursor，《Improving Cursor's agent for OpenAI Codex models》，2025-12-04** [V]
   - Codex 训练时只拿到有限的几个工具，习惯用 shell 搜索、读文件和改文件。Cursor 因此把工具改名、改定义，让它们更接近 `rg` 这类 shell 命令。
   - Codex 只看工具定义不会主动调用 `read_lints`，要在 prompt 里明确要求。
   - 关键数字：在 Cursor Bench 上，**丢掉 GPT-5-Codex 的 reasoning trace 会让性能下降 30%**。作为对比，OpenAI 测 GPT-5 在 SWE-bench 上只降 3%。
3. **Cursor Composer，2025-10-29** [V]：直接用生产环境的工具和 harness 做 RL，把 RL 环境和生产环境统一起来。论坛上的官方回复说，Composer 只在 Cursor 自己的 harness 里提供。
4. **OpenAI Codex Prompting Guide** [V]
   - "strongly recommend using our exact `apply_patch` implementation as the model has been trained to excel at this diff format."
   - 自定义工具 "can work but it requires more tuning"。包装工具应当尽量贴近底层命令，好让调用 "in-distribution"。
   - 命令用一个字符串传，比用 argv 数组好。
   - 丢掉 `phase` 元数据会 "significant performance degradation"。
5. **OpenAI GPT-5.1 指南** [A]：把 `apply_patch` 从 JSON 工具改成具名的 freeform 工具后，失败率下降 35%。
6. **GPT-5-Codex 发布时（2025-09）** [S]：官方说它 "not a drop-in replacement for GPT-5"，只建议在 Codex 或类似 Codex 的环境里使用。
7. **Anthropic 文档《How tool use works》** [V]：bash、text_editor 等 Anthropic 定义的工具是 "trained-in"，模型在 "thousands of successful trajectories that use these exact tool signatures" 上优化过，比功能相同的自定义工具调用更可靠，出错后也恢复得更好。
8. **MiniMax M2，2025-11** [V]：保留与丢弃上一轮推理内容（interleaved thinking）的对比如下。它把原因归于 Chat Completions API 不支持回传 reasoning，很多兼容 Anthropic API 的实现也把它丢了。

   | 评测 | 保留 | 丢弃 |
   |---|---|---|
   | τ² | 87 | 64 |
   | BrowseComp | 44.0 | 31.4 |
   | GAIA | 75.7 | 67.9 |
   | SWE-bench Verified | 69.4 | 67.2 |

9. **国内开源模型的技术报告**都把"格式过拟合"列为问题：
   - **Qwen3-Coder-Next（2026-02）** [A]：用单一工具模板训练会过拟合，于是改用 21 种工具模板、6 种 scaffold 来训练。
   - **KAT-Coder-V2.5（快手，2026-07）** [A]：指出 "format overfitting"，即切换工具协议后解析失败率明显上升。它在 RL 中随机轮换 Claude Code、Codex、OpenClaw、OpenHands 等 harness。
   - **DeepSeek-V3.2** [A]：它在工具调用之间保留推理的规则，会破坏那些把工具轮次模拟成 user 消息的框架（报告点名了 Roo Code 和 Terminus）。
   - **Kimi K2** [A]：训练数据里刻意混入一部分 JSON 格式的工具声明，好兼容第三方框架。

### 2.2 受控实验、论文和基准

| 证据 | 结论 |
|---|---|
| **Meta CWM（2025-09）** [A] | SWE-bench Verified 上，原生 RL harness 得 53.9%；换到 OpenHands 得 42.6%，mini-SWE-agent 得 37.6%。同一套权重离开训练 harness 掉 11–18 个百分点 |
| **Harness Scaling（2026-10，人大等）** [A] | 只在单一 harness 里做 RL 会过拟合；在 18 种 harness 变体上做 RL 泛化更好，在没见过的 Claude Code 上也更强。单一团队的结果，未经复现 |
| **Terminal-Bench 2.0 论文（2026-01）** [A] | 固定模型只换 harness，分数相差 1–17 个百分点。原厂 CLI **只对 OpenAI 模型稳定占优**：GPT-5.2 在 Codex CLI 得 62.9%，在 Terminus 2 得 54.0%。Opus 4.5 反而在 Claude Code 里更低：52.1%，而 bash-only 的 Terminus 2 是 57.8%，并且 Claude Code 用了 256.9M 输入 token，Terminus 2 只用 3.9M。Gemini 2.5 Pro 在 Gemini CLI 得 19.6%，在 Terminus 2 得 32.6% |
| **Guo et al. 综述（2026-06）** [A] | 在 Terminal-Bench 2.0 排行榜上，同一模型在不同 harness 间的分数差中位数为 13.6 个百分点；20 个模型里有 14 个相差 10 个百分点以上。第三方专门 harness 比原厂 CLI 高 17–21 个百分点，例如 Gemini 3.1 Pro 在 Gemini CLI 得 59.4%，在 TongAgents 得 80.2% |
| **Stencil "hashline"（2026-02）** [V] | 只换编辑工具格式，16 个模型平均提升约 15 个百分点，Grok Code Fast 1 从 6.7% 升到 68.3%。非 OpenAI 模型用 patch 格式时失败率很高：Grok 4 为 50.7%，GLM-4.7 为 46.2%，原文说 "they just don't speak the language"。**但 GPT-5.2 Codex 几乎没提升，说明它原生的格式已经接近最优**。这是厂商自己做的基准 |
| **Zhang et al.《Stop Comparing LLM Agents Without Disclosing the Harness》（2026-05）** [A] | Opus 4.5 在 SWE-bench Pro 上，用 SEAL harness 得 45.9%，用 Claude Code 得 55.4%。论文主张 harness 带来的差异常常与模型差异相当，甚至更大，并呼吁公开 harness |
| **HAL CORE-Bench（2025-12）** [A] | Opus 4.5 在 Claude Code 得 78%，在通用 CORE-Agent 得 42%；但 Opus 4.1 反而在 CORE-Agent 里更好。说明这种效应因模型而异 |
| **LangChain deepagents（2026-02）** [A] | 固定 gpt-5.2-codex，只改 harness，Terminal-Bench 2.0 从 52.8 升到 66.5。这说明 harness 重要，但不是"模型与工具专属绑定"的证据 |
| **Aider（约 2023-12）** [V] | GPT-4 Turbo 用 SEARCH/REPLACE 格式得 20%，用 udiff 得 61%。原则是 "Choose an edit format that GPT is already familiar with"；Aider 至今仍按模型选择默认编辑格式 |
| **反例：METR（2026-02）** [A] | Claude Code 相比 ReAct，Codex 相比 Triframe，都没有显著提升；初步结果显示存在模型 × scaffold 的交互效应 |

### 2.3 社区反馈

- **Armin Ronacher，《Better Models: Worse Tools》，2026-07-04** [V]
  - 在 Pi 里，Opus 4.8 和 Sonnet 5 会给编辑工具编造字段，老模型不会；Opus 4.5 适应其他编辑工具反而很好。
  - 去掉 thinking block 后失败减半，开启 strict tool mode 后失败消失。
  - 他的推测是：模型在 Claude Code 上做后训练，而 Claude Code 会默默修复不规范的调用，所以 "tool schemas are not neutral"。
- **《The harness is in the weights》（约 2026-09）** [S]：认为最佳编辑工具"大体是在后训练阶段就决定了的"。
- **openai/codex #33405** [V]：第三方模型在 Codex CLI 里用不好 `apply_patch`。Qwen3 连续 17 次传 JSON 而不是 patch 文本；grok-4.6 三次里只有一次发出了真正的工具调用。
- **通过代理在 Codex 里跑 Claude** [S]：Anthropic 拒收 Codex 的 custom grammar 工具，返回 400（CLIProxyAPI #1671 等）。
- **harness 丢弃推理内容导致报错** [S]：DeepSeek 和 Kimi 返回 `reasoning_content is missing`（Roo Code #10171/#12196、Kilo #10986、Cline #8130）。
- **opencode #20227** [V]：GPT-5.4 在 OpenCode 里反复发出空的 `apply_patch {}`，GPT-5.3 Codex 不会。
- **Reddit** [S]：
  - "gpt-5-codex performs so bad in copilot"：很多人把原因归于 reasoning effort 设得低，混杂因素多；
  - "GPT 5.6 inside Claude Code via CLIProxyAPI… not the same as running Codex CLI"。
  - 两者都只是个人体验。

### 2.4 怎么理解

- **co-adaptation 是真实存在的，主要落在三处：**
  1. **编辑格式**：OpenAI 的 V4A patch 对 Anthropic 的 `str_replace`；
  2. **工具的形状**：shell 风格对自定义工具，freeform 对 JSON；
  3. **推理在多轮间如何保留**：reasoning trace、interleaved thinking、phase 字段。

  第三点对分数的影响最大：Cursor 测到 30%，MiniMax 在 τ² 上从 87 掉到 64。而且它在协议层面就会出错，比如被 API 拒收，或者 harness 把推理内容丢掉。
- **但"原厂 CLI 对原厂模型最好"并不成立。** 这一点只在 OpenAI 模型和 Codex 上比较稳定。Claude 在 Claude Code 里并不总是最好的，Gemini 在 Gemini CLI 里明显偏低。
- **前沿模型越来越专精于自家 harness，开源模型则主动做多 harness 泛化训练**（Qwen、KAT、Harness Scaling 论文）。两条路线正在分化。
- **对第三方 harness 的含义：**
  - 像 Cursor、OpenCode、Deep Agents 那样，按模型配置 harness profile；
  - 完整回传推理内容；
  - 用 provider 原生的 API，而不是全部走 Chat Completions。

---

## 3. Atlas 里可以继续翻的资料

- 总报告：`wiki/research/production-agent-harnesses-20252026-architecture-context-en.md`，附带六个章节页：loop、工具设计、上下文工程、长时运行与多 agent、权限沙箱、扩展性。
- harness 效应：`wiki/research/agent-evaluation-in-20252026-benchmarks-validity-harness-ef/the-harness-effect-and-score-reporting.md`
- 在 harness 中训练：`wiki/research/how-frontier-open-labs-train-agents-20252026-agentic-rl-env/harness-variation-world-models-and-reward-free-agent-learnin.md`，以及 `tool-use-and-thinking-in-tool-use-training.md`
- 展望：`wiki/research/frontier-labs-and-prominent-voices-on-ai-agents-20252026-ti/evaluating-agents-and-the-outlook.md`，以及 `single-agent-vs-multi-agent-designs.md`、`agent-security-the-lethal-trifecta-and-prompt-injection.md`
- 源码：`raw/codebase/` 下有 Codex、OpenCode、Gemini CLI、Pi、Deep Agents、DeerFlow、DSH、Claude Agent SDK、Agents SDK、smolagents、mini-swe-agent 等。

---

## 4. 当前问题与未来方向

### 4.1 大家遇到的问题

1. **评测不可比，harness 也不公开。**
   - 固定模型只换 harness，分数能差十几个百分点；只换基础设施也能差约 6 个百分点 [A]。
   - 排行榜很少公开用的是哪个 harness。
   - 核心设计选择（todo 工具、压缩策略、记忆文件、skills、工具数量、懒加载 MCP）**没有一项有独立消融实验**。厂商给的数字都是单一来源：Tool Search 把准确率从 49% 提到 74%，code execution 把 token 从 150K 降到 2K，LangChain 从 52.8 升到 66.5 [A]。
2. **模型和 harness 绑定，带来锁定和迁移成本。**
   - 见第 2 节：编辑格式、推理回传和 API 形态（Codex 只支持 Responses API）。
   - 中途换模型会导致 cache 失效，history 里还留着新模型不认识的工具调用 [V，Cursor]。
3. **token 成本。** 在 Terminal-Bench 上，Claude Code 用了 256.9M 输入 token，bash-only 的 Terminus 2 只用 3.9M [A]。厂商 CLI 普遍偏重；prompt cache 的命中率已经成了一个 SEV 级别的指标 [A]。
4. **安全。** 2025–26 年的 CVE 可以归成四类 [A]：
   - 把仓库里的配置当成可信的；
   - 拿命令字符串匹配当安全控制；
   - 边界计算出错（路径前缀、模型自选的 cwd、symlink TOCTOU）；
   - 本地控制面没有鉴权。

   此外，prompt injection 和"致命三要素"（lethal trifecta）至今没有通解。默认开沙箱的只有 Codex。
5. **长时任务和"过程"方面的经验没进 harness。** Anthropic 提出的 initializer + progress file + feature list 模式，没有一个 harness 内置；文档整理（doc gardening）、garbage collection 也都还停留在 prompt 和用户自己的仓库里 [A]。
6. **多 agent 仍有争议。** Cognition 认为"不要搞多 agent，要共享完整上下文"；Anthropic 的研究系统用多 agent 比单 agent 高 90.2%，但 token 消耗约是聊天的 15 倍 [A]。实际做法是：只读的子 agent 很常见，并行写入的 agent 只有在 worktree 或事务存储里才敢用。
7. **为当下模型的缺陷写的脚手架会过时。** todo 工具已经被 Claude Code（2.1.268 以后对新模型）和 Deep Agents 0.7 默认移除 [A]。harness 需要持续跟着模型删东西，这件事本身也没有评测来指导。
8. **评测和真实用处脱节。** 头部 benchmark 已经饱和或被污染；能通过测试的代码比可合并的代码高约 24 个百分点；开发者 RCT 的置信区间包含 0 [A]。

### 4.2 方向

1. **harness 变薄，模型变厚。** 搜索工具、todo 工具、过程脚手架都在移出默认配置；越来越多的行为被训练进模型，也就是 "the harness is in the weights"。
2. **上下文转向懒加载：** tool search、code mode、skills 的渐进披露，以及以文件系统为记忆。
3. **安全从"人工点批准"转向"沙箱 + 模型审批员"。** Claude Code 的 auto 模式、Codex 的 `auto_review`；Anthropic 说启用沙箱后权限弹窗减少了 84% [A]。悬而未决的是沙箱会不会在所有 harness 里都默认开启。
4. **标准化与互通。** AGENTS.md、Agent Skills、MCP、ACP、A2A，还有 Claude Code 的 hook 和 plugin 格式，都在成为事实上的标准。Skills 和 MCP 已经交给 AAIF 托管 [S]。
5. **训练与 harness 一体化，分成两条路：**
   - 闭源前沿模型在自家 harness 里做 RL（Composer、Codex 系列）；
   - 开源模型做多 harness、多工具模板的泛化训练。
6. **从任务到目标：主动、常驻、异步的 agent。** Harrison Chase 在 2026-11-02 提出的新问题 [A]：
   - 主动推送怎样才不打扰人；
   - 记忆该记什么；
   - 异步工具和子 agent 完成后怎样通知主 agent；
   - 长期目标的跟踪；
   - 目标被"钻空子"（specification gaming）；
   - 浏览器正在取代 bash，成为通用 agent 的主工具，而它的上下文更重。
7. **把可持久化的状态移出对话：** Codex `/goal`（SQLite）、DSH super-agent 的事务存储、ticket 队列、进度文件。
8. **评测的新方向：** 公开 harness；pass^k 可靠性；每次成功的成本；由维护者评审是否可合并；能奖励跨任务学习的基准（持续学习，CL-bench 一类）[A]。

---

### 主要链接
- Cursor：https://cursor.com/blog/continually-improving-agent-harness ；https://cursor.com/blog/codex-model-harness ；https://cursor.com/blog/composer
- OpenAI Codex Prompting Guide：https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
- Anthropic tool use：https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- MiniMax interleaved thinking：https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2
- Stencil：https://stencil.so/blog/the-harness-problem
- Armin Ronacher：https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/
- Stop Comparing LLM Agents Without Disclosing the Harness：https://arxiv.org/abs/2605.23950
- Aider unified diffs：https://aider.chat/docs/unified-diffs.html
- LangChain，New context engineering challenges in late 2026：https://www.langchain.com/blog/context-engineering-challenges-late-2026
- codex #33405：https://github.com/openai/codex/issues/33405 ；opencode #20227：https://github.com/anomalyco/opencode/issues/20227
