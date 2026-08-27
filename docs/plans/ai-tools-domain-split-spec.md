# aiTools 分域拆分 Spec（split-ai-tools-domains）

## Why

`src/server/src/routes/aiTools.js` 已达 4978 行单文件，承载 100+ 工具的**定义（TOOLS 数组）、handler 执行（executeToolInner 巨型 switch）、确认/ask_user 双门控、审计包装器**四类职责。单体文件导致：多人并行开发冲突面大、领域边界模糊、单段 case 改动易引入跨域回归。目标：按业务域拆分为 `src/server/src/ai/tools/`，**纯重构（纯移动），不改任何业务逻辑**，保持现有导入与导出面完全兼容。

## What Changes

- 新建 `src/server/src/ai/tools/` 目录，按 9 个业务域拆分：
  - `definitions/`：TOOLS 数组各段定义（每个域一个文件，含该域工具的 case/配置）
  - `handlers/`：各域 handler 注册表（executeToolInner switch 中 case 的执行函数逐字迁移）
  - `gates/confirmGate.js`、`gates/askUserGate.js`：确认门控、ask_user 门控
  - `execute.js`：审计包装器（logToolAudit + executeToolInner）
  - `index.js`：聚合导出，**命名导出与原文件完全一致**
- `routes/aiTools.js` 瘦身为兼容 re-export 薄壳（或删除并更新 3 处 import）
- **BREAKING（仅内部组织变更，对外零破坏）**：`aiChat.js` / `aiOrchestrator.js` / `aiStream.js` 的 import 路径不变（继续从 `./aiTools.js` 导入，由薄壳 re-export）；若删除老文件，则统一更新这 3 处 import 指向 `../ai/tools/index.js`。

## Impact

- Affected specs：无（本 spec 是独立重构，不依赖 `rebuild-ai-agent-ui`）
- Affected code：
  - `src/server/src/ai/tools/**`（新增）
  - `src/server/src/routes/aiTools.js`（瘦身/删除）
  - `src/server/src/routes/aiChat.js`、`aiOrchestrator.js`、`aiStream.js`（仅 import 路径，若保留薄壳则不动）
  - `src/server/tests/ai-orchestration.test.js`、`ai-agent-ops.test.js`、`ai-rbac.test.js`、`ai-gates.test.js`（仅用于验收，不改）

## 并行策略（本 spec 与交接文档差异说明）

交接文档要求"严格按序、每迁一域跑测试"，但用户要求工单"适合各 agent 并行"。已核验 `executeToolInner` 为单一巨型 switch（2250 行起）——若多个 agent 同时从同一源文件剪切 case 必然冲突。

因此采用**「并行产出 + 串行集成」**模式：

1. **并行域工单（T1~T9）**：每个域 agent **只新增独立文件**（definitions + handlers），**不修改 `aiTools.js`、不修改 `executeToolInner`**。因未被引用，现有 52 测试仍全绿——即为该工单独立验收基线。
2. **门控工单（T10）**：迁移 confirmGate/askUserGate 时在 `routes/aiTools.js` 保留 re-export 行，与域工单改动行不重叠，可并行。
3. **集成工单（T11，串行最后）**：唯一修改者。将 `executeToolInner` 改造为从各域注册表聚合分发、删除已迁出 case 体、更新 index.js 与 3 处 import。

## ADDED Requirements

### Requirement: 域文件独立可验收

系统 SHALL 使每个业务域（A~I 共 9 域）的 handler 与定义独立成文件，且每个域工单完成时可独立跑 4 个 AI 测试文件验收（关键：并行期间域文件未被引用，测试必须保持全绿）。

#### Scenario: 域 B 工单完成
- **WHEN** agent 完成 `collectionsTags` 域的 handlers/definitions 新增
- **THEN** 4 个测试文件（orchestration / agent-ops / rbac / gates）运行结果与拆分前一致（全绿），且该域每个 case 的实现行与原 `aiTools.js` 中对应 case **逐字一致**（git diff 校验无逻辑变化）

### Requirement: 导出面完全兼容

系统 SHALL 保持 `aiTools.js` 的命名导出面不变：`TOOLS`、`WRITE_TOOL_NAMES`、`READONLY_TOOLS`、`WORKER_BLOCKED_TOOLS`、`getWorkerTools`、`DESTRUCTIVE_CONFIRM_NEEDED`、`approveToolRequest`、`runAskUserGate`、`respondAskUserRequest`、`cancelPendingForStream`、`abortPendingConfirm`、`peekPendingConfirmTool`、`cancelPendingForUser`、`executeTool`、default router。

#### Scenario: 依赖方导入
- **WHEN** `aiChat.js` / `aiOrchestrator.js` / `aiStream.js` 按现有路径导入
- **THEN** 全部命名符号与 default router 均可用，运行时行为与拆分前一致

### Requirement: 纯移动零逻辑改动

系统 SHALL 保证拆分是纯重构：每个 `case 'x'` 的实现体、TOOLS 定义条目、门控函数体、审计包装器逻辑逐字迁移，禁止改写业务逻辑、禁止改参数签名、禁止改返回值结构。

#### Scenario: 逻辑等价校验
- **WHEN** 对拆分前后执行同一组 AI 测试与一次端到端删除收藏夹/创建子收藏夹调用
- **THEN** 结果一致；`git diff` 中业务实现行无内容变化（仅文件增删、import 路径、分发方式）

## REMOVED Requirements

### Requirement: 单体文件 `aiTools.js` 承担全部职责
**Reason**: 4978 行单文件导致并行冲突面大、领域边界模糊。
**Migration**: 由 `src/server/src/ai/tools/index.js` 聚合导出替代；`routes/aiTools.js` 降为 re-export 薄壳（最终可删除）。