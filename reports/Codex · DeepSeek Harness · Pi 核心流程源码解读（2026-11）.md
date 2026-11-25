# Codex、DeepSeek Harness、Pi 核心流程源码解读

## 读的是哪个版本

代码位置：`~/projects/playground/interview/agent-source/`

| 框架 | 仓库 | 版本 | 下文路径相对于 |
|---|---|---|---|
| Codex | openai/codex | `357fe24`，2026-11-22 | `codex/` |
| DeepSeek Harness（DSH） | deepseek-ai/deepseek-harness | `d347e70390`，2026-09-04，dsh-0.1.3-alpha.1 | `deepseek-harness/` |
| Pi | earendil-works/pi | `9c46526`，2026-11-22 | `pi-mono/` |

**注意：DSH 的本地副本比 Agent Atlas 研究所用的快照更早。** 所以本文有几处和上一份报告不一致，以本地代码为准：
- 线格式是 OpenAI 兼容的 `/chat/completions`；
- 压缩阈值是 `floor(W × 0.8)`；
- MCP 没有延迟加载。

**各结论的核对情况：**
- 带 `path:line` 的结论都来自读过的代码。
- 标「推断」的是根据代码推出来的。
- 标 ✔ 的是我亲自打开代码核对过的。其余的由子 agent 读代码给出，我抽查过一部分。

---

## 0. 三句话先抓住差异

- **Codex：拿得最多。** Rust 写成，围绕 OpenAI Responses API 深度定制。
  - 工具调用在模型流式输出的同时就开始执行；
  - 系统通过 OS 沙箱加审批决定能不能执行；
  - 上下文用 "world state" 分段做增量；
  - goal 模式由 SQLite 支撑，可以跨 turn 自动续跑。
- **DSH：一切皆插件。** 连 agent loop 本身都是插件。
  - 每个阶段都是一个可被插件改写的 waterfall；
  - 每次模型请求和每次工具调用之前都先落盘；
  - 动态上下文一律以 user message 追加。
  - plan 和 goal 两个模式都有，都由插件实现。
- **Pi：核心极简。**
  - 循环是两层 while；
  - 没有权限系统，也没有 plan、goal 和子 agent。这些都靠扩展实现，仓库里有示例。
  - 最有特色的设计：system prompt 和工具集的变化，都以 system 补丁消息的形式只追加、不重写。

---

## 1. 一条用户消息怎么被包装：tools、skills、MCP、AGENTS.md 怎么注入

### 1.1 对比

| | Codex | DSH | Pi |
|---|---|---|---|
| 入口 | app-server → `SubmissionOp::TurnInput` → `start_or_steer` | 各端调用 `agent.followup()`（下一轮 turn）或 `agent.steer()`（下一步 step），消息进 Inbox | TUI、RPC、print 三种模式都进 `AgentSession.prompt` |
| system prompt | 请求里没有 `instructions` 字段。基础指令被包成一条 developer 消息，放在 input 最前面 | 按 order 排序的若干 section 拼成 system 字符串 | 带名字的 section 拼成；变化时以 `role:"system"` 补丁追加 |
| AGENTS.md | role=user 消息，标签 `# AGENTS.md instructions` | user 消息，包在 `<system-reminder>` 里；进入新目录时补入该目录的 AGENTS.md | 放在 system prompt 的 `<project_instructions>` 段 |
| 环境信息 | `<environment_context>`（user）：cwd、shell、日期、网络 | 只有 persona 里的 model 和 cwd 变量；sandbox 和审批策略作为 user 快照，变化时才追加 | 只有 cwd，**没有日期** |
| Skills | 列表是 developer 片段，预算为窗口的 2%；正文由模型读 SKILL.md 或调用 `skills.read`；用户写 `$Name` 时整篇注入 | `<available_skills>` user 消息，按 digest 去重；正文通过 `skill` 工具返回，或用户输入 `/<name>` 注入 | 列表只有 name、description、location；正文由模型用 read 工具读，或用户输入 `/skill:name` 包成 `<skill>` 注入 |
| MCP | `mcp__ns__tool`，合成 namespace 工具；模型支持时改为 **Deferred**，再加一个 `tool_search` | `mcp__server__tool`，**全部 schema 预先加载**；唯一的折叠方式是 PTC 模式（只暴露 `run_code`） | 默认 **codemode**（不声明，在脚本里 `searchTools()`）；也可选 deferred、direct、hidden |
| 线格式 | Responses API（`store:false`，带 `include: reasoning.encrypted_content`） | OpenAI 兼容的 `/chat/completions`，回传 `reasoning_content` | 每个 provider 有自己的适配器，Anthropic、OpenAI 等 |
| 缓存稳定 | 前缀只发布一次，之后只追加 world-state 增量；`prompt_cache_key` 用 session id；WebSocket 下带 `previous_response_id` 只发新增部分 | 动态内容都作为 user 消息追加，且只在变化时追加；工具按字典序排；`exit_plan_mode` 常驻注册 | transcript 只追加；工具集保持顺序，新工具只加在末尾；Anthropic 上用 `tool_addition`/`tool_removal` 块；打三个 `cache_control` 标记 |

### 1.2 Codex

1. **提交。** `Op` 枚举里没有用户输入这一项。用户消息走单独的 `SubmissionOp::TurnInput`（`codex-rs/core/src/session/submission.rs:15-22`），有四种模式：StartOrSteer、StartIfIdle、ContinueIfIdle、Steer（`protocol/src/turn_input.rs:254-264`）。
   - `start_or_steer`（`core/src/session/turn_input.rs:468`）：如果已有活跃的 turn，就把输入塞进 `input_queue`（`:521`）；否则调用 `spawn_task(RegularTask)`（`:593`）。
   - 然后进入 `run_turn`（`core/src/tasks/regular.rs:156`）。
2. **组装上下文。** `build_world_state_for_step`（`core/src/session/world_state.rs:78`）按固定顺序生成各段：
   - model instructions；
   - token budget；
   - AgentsMd；
   - Permissions：沙箱、审批策略、exec-policy 规则；
   - CollaborationMode：plan 等协作模式；
   - Environments：cwd、shell、日期、网络；
   - apps 和 plugins；
   - Tools：列出被延迟加载的命名空间；
   - 扩展贡献的段落，例如 skills。

   `assemble_initial_context`（`session/mod.rs:5219`）把所有 developer 片段合并成一条 developer 消息，把 AGENTS.md 和 environment_context 合并成一条 user 消息。
3. **请求顺序**（`client.rs:1239`、`:1283-1292`）：
   1. base instructions（developer）
   2. 前缀：developer 大包、上下文 user 消息
   3. 本轮用户消息
   4. skill 和 plugin 的注入内容
   5. 之后按时间追加：模型输出、工具输出、每一步的 world-state 增量
4. **apply_patch 是 freeform 的 custom 工具**，用 lark 语法约束（`core/assets/tools/apply_patch.lark`；`core/src/tools/handlers/apply_patch_spec.rs:9-27`）。
5. **MCP 延迟加载。** 模型支持 `supports_search_tool` 时，MCP 工具改为 Deferred，并注册 `tool_search`（`core/src/tools/spec_plan.rs:265-289`、`:420-460`）。
6. **缓存。** 前缀只在 `try_publish_initial_context` 里发布一次（`session/mod.rs:5680-5714`）。之后每一步调用 `record_step_world_state_if_changed`（`:4303`），对比快照，用 `render_diff` 只追加变化的部分。只有压缩会重建前缀。

### 1.3 DSH

1. **入口和 Inbox。**
   - `followup` 写进 next-turn 队列，`steer` 写进 next-step 队列（`packages/core/agent-loop/src/agent.ts:125-144`）。
   - `kick()` 驱动循环（`:184-235`）。
   - 每一步开始前（preStep），先认领 inbox：取全部 next-step 消息，再加最多 1 条 next-turn 消息（`packages/core/agent/src/inbox.ts:71-74`）。
2. **system prompt。** `systemPrompt.assemble()`（`packages/core/system-prompt/src/index.ts:536-611`）按 order 拼接各段：
   - 身份句："You are an AI agent powered by DeepSeek Harness."；
   - persona：preset 里的 "coding agent powered by the {{model}} … working directory is {{cwd}}"（`packages/preset/agent-presets/presets/standard/agent.cordis.yml:22-28`）；
   - 各工具自带的段，例如 `tool:bash`；
   - plan 模式开启时的 `plan:policy`。
3. **动态内容不进 system，而是作为 user message 追加。**
   - 沙箱策略和审批策略的说明，用 "Current runtime context…" 快照追加，只在内容变化时追加（`packages/core/agent-loop/src/runtime-context.ts:64-75`）。
   - 代码注释写明，这样做是为了"不重写稳定的 system-prompt cache 前缀"（`packages/interaction/user-approval/src/index.ts:66-68`）。
4. **AGENTS.md 和 CLAUDE.md**，包括 `*.local.md` 和 `~/.dsh/AGENTS.md`，在 `agent/pre-step` 里以 `<system-reminder>` 注入（`packages/context/agent-instructions/src/index.ts:313-339`）。read、write、edit 第一次触碰某个目录时，再补入该目录下的 AGENTS.md（`:341-357`）。
5. **Skills。**
   - `<available_skills>` 以 user 消息注入，按 digest 去重，目录变化时才替换（`packages/skill/tool-skill/src/index.ts:226-298`）。
   - 正文由 `skill` 工具作为 tool result 返回（`:81-160`），或用户输入 `/<name>` 时注入（`:177-208`）。
6. **MCP。** `syncTools` 分页拉取完整的工具列表后，一次性全部注册（`packages/mcp/mcp-client/src/tools.ts:155-192`）。名字非法或超长时，追加 12 位 hash（`:112-118`）。
7. **线格式。** `POST {baseURL}/chat/completions`（`packages/llm/llm-deepseek/src/adapter.ts:643` ✔）。消息有 system、user、assistant 三种，assistant 带 `reasoning_content` 和 `tool_calls`；工具结果用 `role:'tool'`（`serialize.ts:203-276`）。

### 1.4 Pi

1. **入口。** `AgentSession.prompt`（`packages/coding-agent/src/core/agent-session.ts:2177`，下文简称 `AS`）。展开顺序：
   1. 扩展命令（`AS:2190`）
   2. 扩展的 `input` 事件，可以返回 `handled`（吞掉输入）或 `transform`（改写）（`AS:2122-2140`）
   3. `/skill:name`：整篇 SKILL.md 包成 `<skill>`（`AS:2314-2338`）
   4. `/template`
   5. 如果正在输出：进 steer 或 followUp 队列（`AS:2246-2259`）
2. **`_prepareRun`**（`AS:2011`）做四件事：
   1. 检查是否需要压缩；
   2. 发 `before_agent_start` 事件，扩展可以在这里改 sections 和工具集；
   3. 拼出 user 消息；
   4. 把新 sections 和 transcript 里当前生效的 sections 做 diff，有变化就**插入一条 system 补丁消息**（`AS:1836-1847`）。补丁的结构是 `{sections, toolsAdded, toolsRemoved}`（`packages/ai/src/types.ts:571-587`）。
3. **system prompt 的各段**（`packages/coding-agent/src/core/system-prompt.ts:128-192`）：
   - preamble；
   - `<tools>`：每个工具一行，完整 schema 不在这里，而在 `toolsAdded` 里；
   - `<rules>`：各工具的使用指南；
   - `<project_context>`：沿目录往上找，每层取第一个存在的 `AGENTS.override.md`、`AGENTS.md` 或 `CLAUDE.md`；
   - `<skills>`：只有元信息；
   - `<cwd>`。
4. **MCP** 是一个可替换的内置扩展，默认是 `codemode`（`packages/coding-agent/src/core/mcp-servers.ts:52-61`、`:177`）。
   - `deferred` 模式下，`tool_search` 用 BM25 检索，再用 `setActiveTools` 把工具加载进来（`extensions/tool-search/tool.ts:305-309`）。
5. **转成 provider 格式。**
   - 每次请求时都从 session 文件重新投影 transcript（`AS:852-870`）。
   - `convertToLlm` 把 bashExecution、compactionSummary 等自定义消息转成 user 消息（`core/messages.ts:148-196`）。
   - provider 不支持对话中途的 system 消息时，`resolveTranscript` 把所有 system 补丁合并到开头（`packages/ai/src/utils/transcript.ts:108-120`）。

---

## 2. 每一步怎么推理：何时调 LLM、何时执行工具、怎么执行

### 2.1 对比

| | Codex | DSH | Pi |
|---|---|---|---|
| 循环位置 | `run_turn` 里的 `loop`（`session/turn.rs:573`） | `ReactLoopAgent.turn()` 外层循环一个个 step；`step()` 内部负责重试 | `runLoop` 两层 while（`packages/agent/src/agent-loop.ts:172-330` ✔） |
| 何时调 LLM | 每次迭代：取出 steer 输入 → 记录 world-state 增量 → 流式采样 | 每个 step：preStep 管线 → buildRequest → `llm/stream` | 每次内层迭代：prepareNextTurn → prepareRequest → 流式调用 |
| **工具何时开始** | **流式过程中就开始**：每个工具调用的 item 一完成就 `tokio::spawn` | 整条流结束后 | 整条 assistant 消息结束后 |
| 并行规则 | `RwLock`：能并行的拿读锁，不能并行的拿写锁（`core/src/tools/parallel.rs:344-357` ✔） | 不能并发的调用单独作为屏障，能并发的进一个滚动池，最多 10 个（`constants.ts:6` ✔） | 默认并行；**只要有一个 sequential 工具，整批都串行**（✔） |
| 结果顺序 | `FuturesOrdered` 按模型给出的顺序收集 | `commitReady` 按顺序提交 | 按 assistant 消息里的原始顺序写入 |
| 权限门控 | 由 Orchestrator 决定：exec-policy、审批（hook → Guardian 自动审查 → 人工），然后进沙箱；沙箱拒绝时可以请求升级 | pre-execute 返回 ask 时请求审批，只有 `allowed-once` 能放行；拿不到沙箱时 fail-closed（`SANDBOX_UNAVAILABLE`） | **核心没有权限门控**；只能由扩展的 `tool_call` 事件返回 `block` 拦截 |
| 截断的输出（`length` / max-tokens 停止） | — | 直接结束这个 step | 消息里的所有 tool call 一律返回错误、不执行，因为参数可能被截断了（✔） |

### 2.2 Codex：边流边执行，加上沙箱编排

```
OutputItemDone
  └─ tool_router.build_tool_call (router.rs:285-361)
        FunctionCall      → ToolPayload::Function
        CustomToolCall    → Custom（apply_patch）
        ToolSearchCall    → ToolSearch
        Message/Reasoning → 不是工具，写进历史
  └─ ToolCallRuntime::handle_tool_call → tokio::spawn (parallel.rs:323)
        RwLock：读锁 = 可并行，写锁 = 独占
        registry.dispatch_any_with_state (registry.rs:794)
        ToolOrchestrator::run (orchestrator.rs:126)
          1) 确定审批要求：Skip / Forbidden / NeedsApproval
             shell 命令由 exec_policy 判定 (exec_policy.rs:345, 868-940)
          2) 第一次在沙箱里跑：macOS Seatbelt / Linux seccomp / Windows RestrictedToken
          3) 沙箱拒绝且允许升级 → 重新请求审批 → 不带沙箱重试
Completed → drain_in_flight 按顺序收集结果 (turn.rs:4003-4014)
```

- 没被识别为工具的 item（`_ => Ok(None)`）只写进历史。我没找到 `LocalShellCall` 的执行路径。

### 2.3 DSH：每个阶段都是可被插件改写的 waterfall

1. `buildRequest`：先走 `agent/request` waterfall，再调 `llm.prepareCall`（`packages/core/agent-loop/src/agent.ts:488-588`）。
2. 流式调用。`translate.ts:150-201` 把 SSE 的 `reasoning_content`、`content`、`tool_calls[index]` 分别转成 reasoning、text、tool-call 三种 block。
3. 流结束后，过滤出 tool-call 交给 `executeToolCalls`（`agent.ts:470-476`）。
   - 每个工具调用依次经过：`tool/call` 写日志 → prepare → `tools/pre-execute` waterfall → ask/审批 → guard → `tools/execute` waterfall（`packages/core/tools/src/index.ts:1454-1551`）。
   - `defineTool` 会用 JSON schema 校验参数，也会校验输出。
4. **默认不会每个工具都问。** ask 只有两个来源：Claude 格式的 hooks，以及 bash 的 `sandbox_permissions` 提权请求（`packages/sandbox/sandbox/src/escalation.ts:157-188`）。
   - 审批策略为 `never` 时直接拒绝；没有应答方时返回 `unavailable`，即 fail-closed（`packages/interaction/user-approval/src/index.ts:259-296`）。

### 2.4 Pi：工具执行管线最短

`prepareToolCall`（`agent-loop.ts:708-779`）的步骤：
1. 按名字查找工具，找不到就返回 "Tool X not found"；
2. `prepareArguments`；
3. 用 schema 校验参数，并做类型转换；
4. `beforeToolCall`：扩展的 `tool_call` 事件可以返回 block；
5. `tool.execute(id, args, signal, onUpdate)`。

另外，对同一个文件的写操作由 `file-mutation-queue` 串行化（`core/tools/file-mutation-queue.ts:30`）。

---

## 3. 工具结果怎么交给下一轮 LLM

### 3.1 对比

| | Codex | DSH | Pi |
|---|---|---|---|
| 结果格式 | `function_call_output` / `custom_tool_call_output`（apply_patch 用后者） | 内部是带 `source:{kind:'tool'}` 的 user 消息；发出时转成 `role:'tool'`，空结果填 `(no output)` | `ToolResultMessage`：`content` 给模型，`details` 给 UI |
| 大输出 | 写入历史时**掐掉中间**：头尾各保留一半预算，插入 `…N chars truncated…`；预算按模型配置，默认 10 KB × 1.2 | 超过 50000 字节就**整份落盘**，模型只看到头尾预览加文件位置（read 工具除外）；压缩时还会再修剪旧结果 | 2000 行或 50 KB（✔）；read 保留头部，bash 保留尾部，并给出完整输出文件的路径 |
| 推理内容 | 带 `include: reasoning.encrypted_content` 且 `store:false`，每次回传加密的 reasoning item | 历史从日志投影出来，每条 assistant 消息都带 `reasoning_content` 回放 | 同一模型时保留带签名的 thinking；换模型时丢弃 thinking 并去掉签名 |
| 补齐缺失结果 | 规范化时给缺结果的调用补 `"aborted"`，删掉没有对应调用的孤儿结果 | 崩溃恢复时补 `TOOL_OUTCOME_UNKNOWN`，并写明 "Do not retry blindly" | 给孤立的 tool call 补 "No result provided"，跳过 aborted 的消息 |
| 落盘 | 内存里的 `ContextManager`，同时写 rollout 文件 | **每次模型请求前、每次工具执行前、每个 step 开始前都 flush 检查点** | 写 session 文件，每次请求前重新投影 |
| 压缩阈值 | min(配置值, 0.9 × 窗口)（✔） | floor(0.8 × 窗口)（✔） | 窗口 − 16384（✔） |
| 压缩的做法 | provider 支持就走远程 compaction；否则本地生成摘要，加上最近的用户消息（不超过 20k tokens），再重建完整前缀 | 先修剪旧的工具结果；还不够就用 LLM 摘要，替换掉一段区域。**摘要请求复用原会话的前缀，能命中缓存** | 结构化模板：Goal / Constraints / Progress / Decisions / Next Steps，附上读过和改过的文件；**summarizer 关掉了缓存**，用单独的 system prompt |

### 3.2 要点

- **Codex** 在写入历史时截断，rollout 文件里保留完整内容（`core/src/context_manager/history.rs:650`、`:759-768`）。
  - 压缩有四个触发点：每轮开始前（`turn.rs:1751`）；turn 中途还需要继续且 token 已满时（`:812-845`）；turn 结束后（`:943-953`）；以及手动 `/compact`。
- **DSH** 只自动重试模型请求，**从不自动重试工具调用**（`agent.ts:432-447`）。
  - 崩溃后恢复时，`repair.ts:93-125` 给悬空的调用补上 `TOOL_OUTCOME_UNKNOWN`。这样可以避免把一个可能已经执行过的写操作再执行一遍。
- **Pi** 的压缩在三个时机触发：每个 turn 之后、run 结束时（溢出时压缩后重试一次）、新 prompt 之前。
  - 扩展可以通过 `session_before_compact` 取消压缩，或者自己提供摘要（`AS:3294-3313`）。

---

## 4. 什么时候需要用户介入，什么时候算完成

### 4.1 对比

| | Codex | DSH | Pi |
|---|---|---|---|
| **一轮的完成条件** | `needs_follow_up` 为假：没有工具调用、不是 `end_turn==false`、也没有待处理输入（`turn.rs:757`）。之后还要过 Stop hook，hook 可以阻止结束 | assistant 没有工具调用，或工具结果带 `concludesTurn`；next-step 队列为空；`agent/turn-stopping` 里 hook 可以 steer 让它继续 | 没有工具调用、没有 steer、也没有 followUp；`turn_end` 或 `agent_before_settle` 可以返回 `continue` |
| 审批 | `ExecApprovalRequest` / `ApplyPatchApprovalRequest`；策略有 untrusted、on-request（默认）、granular、never | hook 返回 ask，或 sandbox 提权时才问 | 核心不问；扩展可以用 `ctx.ui.select/confirm` 问 |
| 向用户提问的工具 | `request_user_input`：**只在 Plan 模式可用**，而且会阻塞（✔） | `ask_user_question`（standard preset 里有） | 没有，靠扩展 |
| 中断 | 已经开始的工具返回 "aborted by user after Xs"，没派发的返回 "aborted before dispatch"；历史里写入 `<turn_aborted>` | 流里只保留已有的文本和推理，丢弃工具调用；已开始的工具等它结束后记为 ABORTED，没开始的补合成结果 | 工具返回 "Operation aborted"；异常被包成一条 aborted 的 assistant 消息 |
| 中途插话 | 进 `input_queue`，下一步开头取出；开启 preempt 时可以打断正在进行的采样 | steer 在下一个 step、followup 在下一个 turn 生效；排队的消息可以编辑、删除，或提升为 steer | steer 在本轮工具执行完后注入，followUp 在本该停下时注入 |
| 步数上限 | 没有；只有一个预算闸门（开源版基本是桩代码） | 每个 turn 没有上限；重复调用同一工具时在 3、5、8 次提醒 | 核心没有 |
| 出错重试 | 网络流按 `stream_max_retries` 重试 | 只重试模型请求 | 指数退避，最多 3 次；上下文溢出时改为压缩后重试一次 |
| 下一轮怎么开始 | turn 结束 → `on_thread_idle` → 有排队输入就开新 turn；goal 模式下自动续跑 | `turn/end` 后 inbox 里还有消息就开新 turn；goal-round-driver 在空闲时投递下一轮 | 外层循环取 followUp |

### 4.2 共同结论

三家都没有设置默认的步数上限，**什么时候停由模型决定**：只要不再调用工具就停。

人能介入的位置有三类：
- **执行前审批**：Codex 最完整，DSH 只在提权时问，Pi 交给扩展。
- **中途插话**：三家都有 steer 和 followUp 两种队列。
- **结束前的 hook**：可以在 agent 要停的时候让它继续。这正是 goal 模式实现自动续跑的地方。

---

## 5. Goal 模式与 Plan 模式

### 5.1 一句话区分

- **Plan 模式**改变的是这一轮怎么协作：只读探索、提出方案，然后**停下来等人批准**。
- **Goal 模式**改变的是 turn 之间的循环：设定一个持久目标后，**agent 空闲时由系统自动发起下一轮**，直到模型自己审计确认完成、判定被阻塞，或者用完预算或轮数。

### 5.2 Codex

| | Plan 模式（协作模式 `ModeKind::Plan`） | Goal 模式（`/goal`，扩展 `codex-rs/ext/goal`） |
|---|---|---|
| 状态存在哪 | 会话里的协作模式 | SQLite `goals_1.sqlite` 的 `thread_goals` 表：objective、status、token_budget、tokens_used |
| prompt 怎么变 | `CollaborationModeState` 追加一条 developer 片段，模板是 `plan.md`：禁止修改操作，先只读探索，再用 `request_user_input` 提问，最后把方案放进 `<proposed_plan>` | 不改 system prompt。每次续跑注入一条 goal 片段（`continuation.md`），含预算、无进展自检、**Completion audit**（逐条要求有证据，证据不足就继续干）、Blocked audit（同一个阻塞连续 3 轮才允许判定 blocked） |
| 工具怎么变 | `update_plan` 在 Plan 模式下直接报错（✔ `handlers/plan.rs:87-90`）；`request_user_input` **只在 Plan 模式可用**（✔）。不准修改只写在 prompt 里，代码没有按模式移除 shell 或 apply_patch（推断） | 新增 `get_goal`、`create_goal`、`update_goal`；`update_goal` 只能设为 complete、blocked 或 paused |
| 循环怎么变 | 照常执行工具循环；`<proposed_plan>` 被解析成 PlanItem；没有工具调用时 turn 照常结束 | `on_thread_idle` → `continue_if_idle` → 以 `turn_trigger:"goal"` 再开一个 turn。单个 turn 的结束条件不变，变的是 thread 级的循环 |
| 何时结束 | 用户批准后，`prepare_approved_plan` 在**新 thread** 里以 "Implement the plan." 开始执行（`session/approved_plan.rs:25-56`） | 模型调用 `update_goal(complete/blocked/paused)`；预算耗尽变为 BudgetLimited；连续 3 轮没有任何产出时自动判定 Blocked（✔ `accounting.rs` 里的 `consecutive_empty_turns`）；或者用量受限、执行失败 |
| 两者的关系 | **互斥**：Plan 模式下不允许自动开 turn，goal 续跑会被 `NotSubmittedReason::PlanMode` 拒绝 | |

### 5.3 DSH

| | Plan 模式（`packages/plan/plan-mode`） | Goal 模式（`packages/goal/*`） |
|---|---|---|
| 进入 | `/plan [msg]`。如果 turn 正在进行，等下一个 pre-step 才切换 | `/goal <objective>` 或模型调用 `create_goal`，状态变为 active + armed |
| prompt | 开启时渲染 `plan:policy` 这个 system section（order 500）：只读探索、不改文件，并说明"对话里的同意不算批准"。**会改变 system 前缀** | 固定的 `tool:goal` section 写明 complete 和 blocked 的规则；每一轮以 `<goal_round>` user 消息续跑，带 "Round n/max" |
| 工具 | `exit_plan_mode` **常驻注册**，工具目录不变；**不在执行层拦截工具**，限制交给沙箱和审批 | `get_goal`、`create_goal`、`update_goal`。edit、pause、resume 必须由人直接要求；complete 和 blocked 可以在自动轮次里调用 |
| 循环 | 不改变循环 | goal-round-driver 在 agent 进入空闲时用 `followup` 投递下一轮，开一个新 turn。用户插话时这一轮的预留作废；用户中断时目标转为 pause |
| 结束 | 模型调用 `exit_plan_mode(plan)`，弹出 **Approve / Keep planning** 让用户选。批准后下一个 step 开始执行；选继续规划时，把用户反馈作为错误返回给模型 | 模型调用 `update_goal complete/blocked` 后，注入 `<goal_complete>`，要求写一段收尾总结且不再调用工具；或者达到 `maxGoalRounds`（默认 256），自动 block 为 `round-limit`（✔） |

### 5.4 Pi

**核心里没有** plan、goal、todo 或子 agent，这是刻意的设计。仓库里有扩展示例：
- `packages/coding-agent/examples/extensions/plan-mode/index.ts`：
  - `/plan` 命令用 `setActiveTools` 切换到只读工具集；
  - `tool_call` 拦截不在白名单里的 bash 命令；
  - `before_agent_start` 注入 `[PLAN MODE ACTIVE]`；
  - `agent_end` 从回答里抽出 "Plan:" 的各个步骤，再用 `ui.select` 让用户选择执行、继续规划或细化；
  - 执行阶段在 `turn_end` 时解析 `[DONE:n]` 标记来跟踪进度。
  - **这是三家里唯一真正在工具层收紧权限的 plan 模式。**
- `subagent/index.ts`：每个任务启动一个独立的 `pi --mode json -p` 进程，支持 single、parallel（最多 8 个任务、并发 4）和 chain 三种方式。
- `todo.ts`：todo 的状态存在 toolResult 的 `details` 里，回放 transcript 就能恢复。
- `packages/durable/test/examples/` 里也有 plan-mode、subagent、turn-limit 的例子。

**用扩展做 goal 模式**（推断，仓库里没有现成实现）：
- 用 `registerCommand("goal")` 记录目标；
- 用 `before_agent_start` 追加一个 `<goal>` section，补丁式追加，不破坏缓存；
- 在 `agent_before_settle` 里判断目标是否达成，没达成就返回 `continue`；
- 在 `turn_end` 里计数，超过上限就结束。

### 5.5 横向结论

- **Plan 是"人在环中"的模式**，结束的标志是用户批准：Codex 用 `request_user_input` 加 `<proposed_plan>`，DSH 用 `exit_plan_mode` 弹窗，Pi 用 `ui.select`。
  - 限制强度：Codex 和 DSH 只靠 prompt 约束（DSH 另有沙箱兜底）；Pi 的示例扩展真正换成了只读工具集。
- **Goal 是"自动续跑"的模式**，Codex 和 DSH 的实现几乎同构：
  - 都提供 get、create、update 三个工具；
  - 都在空闲时由一个驱动器自动发下一轮；
  - 都要求同一个阻塞持续 3 轮才能判定 blocked；
  - 停止条件都是"模型自己宣布完成"加一个硬上限（Codex 是 token 预算和 3 轮无产出，DSH 是 256 轮）。
  - Codex 多了一个 **Completion audit**，逐条要求证据，用来对抗模型过早宣布完成。
- **两者可以组合**：先用 plan 定方案，批准后交给 goal 自动执行。但在 Codex 里，Plan 模式下 goal 不会自动续跑。

---

## 附：三家整轮流程图

### Codex

```
Client turn/start ─► SubmissionOp::TurnInput ─► start_or_steer
   (已有活跃 turn → input_queue)
   spawn_task(RegularTask) ─► run_turn
     开始前压缩? ─► 发布前缀 / world-state 增量 ─► 记录用户消息 ─► 注入 skill
     loop:
       取出 steer 输入 ─► world-state Δ ─► build_prompt
       Responses API 流式（WS 增量 + previous_response_id）
         OutputItemDone: message/reasoning → 写入历史
                         function/custom/tool_search → tokio::spawn
                           RwLock(读=并行|写=独占) → handler
                           → Orchestrator: exec-policy → 审批(hook/Guardian/人) → 沙箱 → (被拒→升级)
       Completed → drain_in_flight → *_call_output(截掉中间) → 历史
       needs_follow_up = 有工具调用 || end_turn==false || 有待处理输入
         是: token 满了? → 自动压缩 → continue
         否: Stop hook(可阻止结束) → 结束后压缩 → break
   on_thread_idle ─► 有排队输入就开新 turn | Goal Active 且非 Plan → continuation.md → 新 turn
```

### DSH

```
UI/ACP/SDK/headless ─followup|steer─► Inbox(next-turn | next-step)
  kick(): turn/start
   loop step:
    preStep: 认领 inbox → assemble(system sections + tools)
      → runtime 快照(变化时才追加) → agent/pre-step waterfall
        [flush 检查点 | 压缩(≥0.8W: 先修剪 → 再摘要替换) | AGENTS.md | skills | plan/goal]
    buildRequest → llm/stream(flush 检查点) → POST /chat/completions SSE
      → reasoning/text/tool-call blocks
      出错 → llm-retry / 溢出时压缩后重试
    没有工具调用 → completed；max-tokens → 停止
    工具: [独占=屏障] / [并行池 ≤10]
      tool/call → pre-execute(hook ask → 审批 allowed-once|deny)
      → guard → execute(flush 检查点) → schema 校验 → 工具体(沙箱 fail-closed)
      → post-execute(>50KB 落盘) → 按顺序写 tool/result
    completed 且 nextStep 为空 → agent/turn-stopping(hook 可 steer) → break
  turn/end → inbox 里还有消息 → 新 turn
  空闲 → goal-round-driver 投递 <goal_round>（goal armed 时）
```

### Pi

```
TUI/RPC/print ─► AgentSession.prompt
  扩展命令 | input hook | /skill: | /template | 正在输出 → steer/followUp 队列
  _prepareRun: 检查压缩 → before_agent_start → [system 补丁] + user 消息
  runLoop:
   外层 while(true):
    内层 while(还有工具调用 || 有待处理消息):
      prepareNextTurn(阈值压缩, prompt/工具 diff) → 推入待处理消息
      prepareRequest(从 session 投影) → transformContext → convertToLlm
      → provider(resolveTranscript, transformMessages, cache_control) → 流式
      error/aborted → agent_end
      length → 所有工具调用都返回错误
      工具: prepare → 校验 → tool_call hook(可 block) → execute
            (默认并行；有一个 sequential 就整批串行) → tool_result hook
      finishTurn(turn_end: continue/end) → 取 steer 消息
    有 followUp → continue；否则 break
  run 结束后: 重试(≤3) | 溢出 → 压缩 + 继续 | agent_before_settle(continue?)
```
