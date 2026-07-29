# AI 多代理编排界面 UX 学习总结

> 研究目标：解决 ClipSync AI 侧边栏当前两个突出问题：
> 1. 用户一发问就冒出空白的“思考中”折叠卡片；
> 2. 答案已经输出完毕，“协调器”还在转圈。
>
> 学习来源：GitHub 开源项目 **Hermes Agent (NousResearch)** 与 **OpenCode UI / SST OpenCode**。以下所有结论均来自对源码与文档的实际阅读。

---

## 一、两个项目的核心思路

### 1.1 Hermes Agent —— 以事件驱动状态机为核心

Hermes 的 `agent/moa_loop.py` 与 `agent/subagent_lifecycle.py` 直接定义了多代理编排的状态与事件：

- **Aggregator（聚合器/主代理）**：真正执行工具、产出最终用户答案的模型。Hermes 不用“Coordinator/协调器”这种用户难懂的词。
- **Reference models / advisors（参考模型/顾问）**：只给建议、不行动的旁路分析模型，并行跑完后把建议喂给 aggregator。
- **Subagent（子代理）**：通过 `subagent_lifecycle.py` 管理，状态机非常清晰：
  - `PENDING` → `RUNNING` → (`SUCCEEDED` | `FAILED` | `INTERRUPTED` | `CANCELLED`)
  - 完成信号：`SubagentResult` + `completed_at` + terminal state。
- **事件流**：`moa.progress` → `moa.reference`（每个参考模型输出）→ `moa.phase=aggregator` → `moa.aggregating` → 最终答案。

**关键启示**：ClipSync 的“协调器”对应的是 Hermes 的 aggregator。应该叫 **主代理 / 聚合代理 / 总代理**，或者干脆不取名，只显示阶段标签如“任务规划中”。

### 1.2 OpenCode UI (Dojo) —— 以流式消息驱动界面

OpenCode UI 是 OpenCode 的 Next.js/React 桌面/web UI，核心组件：

- `AgentExecution.tsx`：
  - 执行中且 **还没有任何消息** 时，只显示一个 `Loader2` + “Initializing agent...”。
  - 从不提前渲染空白的思考卡片；消息来了才渲染。
  - 完成事件 `agent-complete` 到达后，立即把 `isRunning` 设为 `false`。
- `StreamMessage.tsx`：
  - 按 `message.type` 路由：`system` / `assistant` / `user` / `result`。
  - `assistant` 消息内部出现 `thinking` 类型内容时，才用 `ThinkingWidget` 渲染思考块。
  - 工具调用用独立 widget（`BashWidget`、`ReadWidget` 等）渲染，不会和答案混在一起。
  - `result` 类型消息作为最终“执行完成/失败”卡片出现。
- `AgentRunView.tsx`：历史回看页面，顶部是运行元信息，下面是按时间顺序的消息流。

**关键启示**：
1. **先显示加载态，再显示内容卡片**。在拿到第一条可渲染内容之前，只放统一的 loading indicator。
2. **思考卡片随内容出现而创建**，不是预先占位。
3. **最终答案与中间状态分离开**，`result` 是单独的消息类型。

---

## 二、推荐的 AI 编排界面状态机

结合两个项目，ClipSync 侧边栏应该呈现如下流程：

```
用户发送问题
    │
    ▼
[1] 全局加载 / 等待中
    显示：动态闪烁的 “AI 正在思考…” 或 “正在连接模型…”
    条件：未收到任何 SSE 事件 / 未开始输出
    │
    ▼
[2] 思考阶段（可选，取决于模型/编排是否返回 thinking 流）
    当且仅当收到 thinking 内容时，渲染可折叠的“思考过程”卡片
    卡片内随流追加内容
    │
    ▼
[3] 规划 / 任务分配阶段
    思考结束后，如果启用了多代理/并行编排：
    显示阶段提示：“已规划，正在分配子任务…”
    展开子代理卡片列表（每个子代理一个可折叠卡片）
    │
    ▼
[4] 子代理执行阶段
    每个子代理卡片内部显示自己的工具调用/中间结果
    子代理完成后，卡片状态变为完成/失败
    │
    ▼
[5] 最终答案输出
    主代理/聚合器输出最终结构化答案
    所有 loading spinner 必须在此时停止
    │
    ▼
[6] 完成态
    用户可继续交互；历史消息保留
```

**阶段 [1] 的“友好加载”是用户最在意的**：不要一上来就摆一个空折叠面板。先用一个轻量、动态的提示告诉用户“AI 正在处理”。

---

## 三、具体 UX 规则（可直接落地）

### 3.1 加载/等待态

- **在收到第一条有内容的事件之前**，只显示一个居中的轻量动画 + 文案。
- 文案建议：
  - “AI 正在思考…”
  - “正在分析问题…”
  - “正在规划任务…”
- 动画建议：shimmer 条、脉冲圆点、或从左到右闪烁的进度条（用户原话）。
- **不要**在这个阶段渲染折叠卡片、列表、空占位。

### 3.2 思考过程卡片

- **创建时机**：收到第一条 `thinking` / `reasoning` 内容时才创建。
- **默认状态**：可折叠，初始折叠（用户不主动展开时不占视线）。
- **内容结束**：收到 thinking 结束标记后，卡片停止 loading，但保留内容供回看。
- **不要**在用户一发问就创建两个空“思考中”卡片。

### 3.3 子代理 / 并行任务卡片

- **创建时机**：规划阶段结束后，列出所有子代理任务。
- **布局**：每个子代理一个独立卡片，垂直排列。
- **状态显示**：
  - 运行中：左侧小 spinner + 动态文案
  - 完成：绿色对勾 / 状态标签
  - 失败：红色错误标签
- **内部内容**：各自可折叠，默认折叠；展开后显示该子代理的工具调用链与中间输出。
- **命名**：不要叫“协调器”。可叫：
  - “任务规划”
  - “主代理”
  - “执行汇总”
  - 或者直接显示子代理的具体角色名（如“搜索代理”、“代码代理”）。

### 3.4 最终答案

- **独立渲染**：最终答案应该是一个独立的 assistant message bubble，不要和 thinking/agent 卡片混在一起。
- **终止所有动画**：最终答案 SSE 结束时，必须把所有 spinner、thinking indicator、子代理 loading 全部置为完成态。
- **结构化输出**：如果答案是表格/列表/步骤，使用对应 Markdown/组件渲染，而不是纯文本堆砌。

### 3.5 状态一致性

- 前端状态必须有一个明确的 `isGenerating` / `isStreaming` 标志。
- 当 SSE 正常结束、出错、或被用户中断时，都要把该标志设为 `false`。
- 子代理状态由后端事件驱动，不能仅靠前端的“静默 watchdog”兜底。

---

## 四、与 ClipSync 当前问题的对应关系

| 用户抱怨 | 根因 | 推荐修复 |
|---|---|---|
| 一发问就出现空白“思考中”卡片 | 前端在 SSE 开始前就预渲染了 thinking 占位组件 | 在收到 thinking 内容前显示统一 loading；收到内容后再创建折叠卡片 |
| 再点一下箭头出现“协调器 规划中” | 折叠卡片内嵌了 coordinator 状态，但 coordinator 的完成事件没有正确收敛 | coordinator 完成规划后应立即切换为完成态；最终答案到达后强制收敛所有未结束 agent run |
| 答案输出完了子代理还在转 | 最终答案事件没有触发 agent run 的终止；或 `coordinator:done` 事件丢失/未处理 | 在 `streamChat` 解析层增加 `done`/`complete` 事件；`useAiChat` 在 `finally` 中调用 `settleAgentRuns()` 把非终态强制置为完成 |
| “协调器”名字看不懂 | 命名不用户友好 | 改为“任务规划”/“主代理”/“执行汇总”，或直接显示子代理角色 |

---

## 五、可复用的实现模式

### 5.1 消息类型枚举（参考 OpenCode StreamMessage）

```ts
type StreamDeltaType =
  | 'loading'      // 全局加载提示
  | 'thinking'     // 可折叠思考内容
  | 'agent_plan'   // 规划/任务分配
  | 'agent_run'    // 子代理执行中
  | 'agent_done'   // 子代理完成
  | 'answer'       // 最终答案 delta
  | 'result'       // 最终答案完成/失败总结
```

### 5.2 AgentRun 状态（参考 Hermes SubagentState）

```ts
type AgentRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
```

### 5.3 渲染规则

```ts
if (isWaitingForFirstEvent) {
  return <LoadingIndicator message="AI 正在思考…" />
}

if (delta.type === 'thinking') {
  return <ThinkingCard content={delta.content} isStreaming={!delta.done} />
}

if (delta.type === 'agent_plan') {
  return <PlanCard tasks={delta.tasks} />
}

if (delta.type === 'agent_run') {
  return <AgentRunCard run={delta.run} />
}

if (delta.type === 'answer') {
  return <AnswerBubble content={delta.content} />
}

if (delta.type === 'result') {
  return <ResultCard status={delta.status} />
}
```

---

## 六、结论

- **不要预渲染空占位**：在真正拿到内容之前，只显示一个友好的加载指示器。
- **状态机要清晰**：loading → thinking → planning → agent runs → answer → done。
- **完成信号要可靠**：最终答案到达后，必须停止所有 spinner，并把未结束的 agent run 强制收敛。
- **命名要人话**：把“协调器”换成“任务规划”或“主代理”，子代理用具体角色名。

这份总结可以直接作为 ClipSync AI 侧边栏重构的需求基线。
