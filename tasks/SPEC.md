# 任务写入约定（Task Board）

本文件定义 agent / 协作者在本项目写入任务时必须遵守的格式。
看板（task-board）会扫描 `tasks/` 下各优先级目录中的 markdown 文件并展示，并按 frontmatter 的 `batchId` 自动归类到对应批次——未在 `batches.json` 登记的 `batchId` 看板也会自动合成一个批次展示，任务绝不会消失。

## 行为规则（重要）

当你被要求「分析 / 优化 / 规划 / 修复」时：

1. **不要直接开始改代码。**
2. 先阅读本文件和 `schema.json`。
3. 将每条建议拆成**一个** markdown 文件，放入对应优先级目录：
   - `tasks/p0-now/`   最紧急、阻塞、线上问题
   - `tasks/p1-next/`   尽快处理
   - `tasks/p2-later/`  已排期、不紧急
   - `tasks/p3-icebox/` 暂不动
   - `tasks/done/`      已完成（归档，不删）
4. 文件名：`YYYY-MM-DD-{kebab-title}.md`（如 `2026-07-26-fix-theme-crash.md`）。
5. 文件头 frontmatter 必须包含字段：`id, title, priority, status, source, module, assignee, estimate, progress, tags`（详见 schema.json）。强烈建议同时写 `batchId`（所属批次，任意字符串即可，看板自动识别分组；同一批任务用同一个值）与可选 `batchName`（批次显示名，方便看板展示）。
6. 正文必须包含：
   - `## 目标`：一句话说清要做什么
   - `## 验收标准`：用 `- [ ]` 勾选列表描述完成条件
   - `## 备注`（可选）
7. 写完后回复用户：「任务已写入 tasks/，请在看板中确认优先级与分配后再执行。」
8. **校验反馈**：看板会按 `schema.json` 校验每个文件的 frontmatter。缺必填字段、priority/status 不合法、progress 越界、tags 非数组，都会让该任务卡片**标红并显示具体错误**。若被标红，按错误修正文件后看板会自动刷新（约 3 秒）。

## frontmatter 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | 全局唯一，建议 `项目缩写-日期-序号` 或 UUID |
| title | 是 | 任务标题 |
| priority | 是 | p0-now / p1-next / p2-later / p3-icebox / done |
| status | 是 | todo / in_progress / review / done / blocked |
| source | 是 | 来源：kimi-cli / workbuddy / manual / lifecycle |
| module | 否 | 模块：desktop-ui / desktop-frontend / api / ... |
| assignee | 否 | 负责人：me / agent 名，留空表示未分配 |
| estimate | 否 | 预估工时，如 `2h` / `1d` |
| progress | 否 | 0-100 整数；留空则由勾选框自动计算 |
| tags | 否 | 标签数组，如 `[tauri, theme]` |
| batchId | 建议 | 所属批次 ID，任意字符串（如 `batch-2026-07-26-refactor`）；看板自动识别并分组，无需预登记 |
| batchName | 否 | 批次显示名（可选），如 `本次重构拆分`；缺省时看板用 batchId 生成可读名 |

## 示例

```markdown
---
id: clipsync-2026-07-26-001
title: 修复 Linear/Raycast light 模式崩溃
priority: p0-now
status: todo
source: kimi-cli
module: desktop-ui
assignee: ""
estimate: "2h"
progress: 0
tags: [tauri, theme, crash]
batchId: batch-2026-07-26-001
batchName: 主题崩溃修复
---

## 目标
修复 Linear/Raycast light 模式下的崩溃。

## 验收标准
- [ ] 复现崩溃
- [ ] 添加 .light 变体或禁用对应 toggle
- [ ] 切换主题不再崩溃
```
