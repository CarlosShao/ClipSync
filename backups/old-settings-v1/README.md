# 旧版设置页归档说明

## 归档日期
2026-07-22

## 归档原因
新版设置弹窗（SettingsDialog）已完整替代旧版设置页（SettingsView），旧版从侧边栏隐藏并归档备份，以防后续需要回溯或参考。

## 归档内容

| 文件 | 原路径 | 行数 | 说明 |
|------|--------|------|------|
| `SettingsView.vue` | `src/desktop/src/components/settings/SettingsView.vue` | 554 | 旧版设置主页面，包含通用、外观、快捷键、隐私、数据、订阅、模板变量、关于等全部分组 |

## 旧版架构概述

旧版设置是一个全屏页面（`currentSub === 'settings'`），子功能通过 `emit('open-modal')` 弹出 ModalManager 的独立弹窗：

- 通用设置 → 内联在页面中
- 外观/主题 → ModalManager `themes` 弹窗
- 快捷键 → ModalManager `shortcuts` 弹窗
- 安全/2FA → ModalManager `security` 弹窗
- 会话管理 → ModalManager `sessions` 弹窗
- 通知偏好 → ModalManager `notifications` 弹窗
- 数据导出 → ModalManager `export` 弹窗
- 反馈 → ModalManager `feedback` 弹窗
- 检查更新 → ModalManager `updates` 弹窗
- 套餐/账单 → ModalManager `pricing`/`billing` 弹窗

## 新版替代方案

新版设置弹窗（`src/desktop/src/components/settings/settings-dialog/`）采用对话框 + 内联子页面架构：

- 不再依赖 ModalManager，所有子功能在弹窗内部切换
- 左侧导航栏 + 右侧内容区，支持面包屑式返回
- 18 个独立组件，每个职责单一

## 相关文件变更

| 文件 | 变更内容 |
|------|---------|
| `AppSidebar.vue` | 移除旧版 settings 导航项，v2 改为正式 settings |
| `HomeView.vue` | 移除 SettingsView 的条件渲染和 import |
| `ModalManager.vue` | 未删除任何代码（保持兼容），旧版设置相关的 modal 类型仍保留 |

## 如需回滚
1. 将 `SettingsView.vue` 复制回 `src/desktop/src/components/settings/`
2. 在 `AppSidebar.vue` 的 `accountNavItems` 中恢复 `{ key: 'settings', ... }` 项
3. 在 `HomeView.vue` 中恢复 `SettingsView` 的 import 和 `<SettingsView v-else-if="currentSub === 'settings'" />`
4. 在 `AppSidebar.vue` 中恢复旧版 settings 的导航项样式
