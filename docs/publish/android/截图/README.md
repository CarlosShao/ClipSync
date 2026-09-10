# ClipSync 应用截图 —— 截图说明与拍摄方案

> **状态：⚠️ 未采集到截图（设备未连接）** —— 本目录**没有真实截图文件**，
> 原因与用户需要执行的操作见下方「一、实际情况」。
> **本文件不含任何占位图或伪造图**，仅包含拍摄方案，供设备就绪后执行。

---

## 一、实际情况（诚实报告）

### 1.1 尝试过程与结果

| 检查项 | 命令 | 结果 |
|--------|------|------|
| adb 版本 | `adb version` | ✅ Android Debug Bridge 1.0.41 / 37.0.0-14910828，位于 `D:\work\base\Android\Sdk\platform-tools\adb.exe` |
| 设备列表 | `adb devices -l` | ❌ `List of devices attached` —— **空**，无任何设备 |
| 设备状态 | `adb get-state` | ❌ `error: no devices/emulators found` |
| 服务重启后重试 | `adb kill-server` → `adb start-server` → `adb devices` | ❌ 仍然为空（已排除 adb server 状态问题） |
| USB 设备树 | `Get-PnpDevice` 查 `USB\VID_*` | ❌ **未发现任何 Android 设备**。已连接的 USB 设备仅有：键盘（VID_048D）、鼠标（VID_258A）、摄像头（VID_5986）、蓝牙适配器（VID_8087）、USB Hub（VID_1A40）——**没有手机** |
| 应用是否已安装 | `adb shell pm list packages` | ⛔ 无法执行（无设备） |

### 1.2 结论

**手机没有物理连接到这台电脑**，或连接了但未被系统识别为 USB 设备。
这不是软件层面的问题（adb 本身工作正常，server 可正常启停），
而是**数据线未插 / 未授权 / 驱动未装**这一类连接层问题。

因此**本次没有产出任何截图**。按任务要求，不伪造、不使用占位图。

### 1.3 📌 重要更正：实际包名与任务描述不一致

任务描述中给出的应用 ID 是 `com.clipsync.clipclip_mobile`，
但**实际读取 `src/mobile/android/app/build.gradle.kts` 后确认为**：

```kotlin
namespace = "com.clipsync.clipsync_mobile"
applicationId = "com.clipsync.clipsync_mobile"
```

即实际包名为 **`com.clipsync.clipsync_mobile`**（`clipsync_mobile`，非 `clipclip_mobile`）。
这一结论同时由源码交叉验证：`SyncForegroundService.kt` 第 64 行
`ACTION_STOP = "com.clipsync.clipsync_mobile.action.STOP_SYNC"`、
`QuickSyncActivity` 所在包 `com.clipsync.clipsync_mobile`。

> 该包名后续需用于：各商店开发者后台的包名填写、APP 备案的包名字段、
> 以及下面的 adb 截图命令。**填写错误会直接导致上架失败**，请以此为准。

---

## 二、设备恢复连接后：用户需要做什么

### 步骤 1：确认设备已连接

1. 用 **支持数据传输的 USB 线**（非仅充电线）连接手机与电脑
2. 手机上选择 **「传输文件 / MTP」** 模式（部分机型需在通知栏切换）
3. 打开 **开发者选项 → USB 调试**（若未开启：设置 → 关于手机 → 连点「版本号」7 次）
4. 手机弹出 **「允许 USB 调试吗？」** → 勾选「始终允许」→ 确定

### 步骤 2：验证连接

```bash
adb devices
```

**期望输出**（设备序列号 + `device` 状态）：

```
List of devices attached
XXXXXXXXXXXX    device
```

- 显示 `unauthorized` → 手机上未点「允许」，重新插拔并确认弹窗
- 显示 `offline` → 执行 `adb kill-server && adb start-server`
- 列表仍为空 → 换 USB 线 / 换 USB 口（优先主板直连口）/ 安装厂商 USB 驱动

### 步骤 3：确认应用已安装

```bash
adb shell pm list packages | findstr clipsync
```

**期望输出**：`package:com.clipsync.clipsync_mobile`

若未安装，需先构建并安装 debug 版：

```bash
cd src/mobile
flutter build apk --debug
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

### 步骤 4：⚠️ 隐私清理（**采集前必须做**）

截图会进入公开的应用商店页面，**绝不能包含真实隐私数据**。开始前请：

- [ ] **退出真实账号**，改用专用测试账号（避免截图带出真实手机号/邮箱/头像）
- [ ] **清空剪贴板历史**，仅保留准备演示的**虚构示例内容**
      （例如 `ClipSync 示例文本`，不要用真实密码、验证码、聊天记录）
- [ ] 确认列表里**没有真实手机号、邮箱、身份证号、地址、银行卡号**
- [ ] 若有设备名包含真实姓名/手机号，改为「我的手机」「办公电脑」
- [ ] 关闭系统状态栏的**通知预览**，或拍摄前下拉清空通知
      （避免微信/短信预览泄露真实内容）

> 建议在 `设置 → 清空缓存` 后，用**全新的测试账号**重新演示，
> 这样列表内容完全可控。

### 步骤 5：采集截图

```bash
# 确保应用在前台且处于目标界面，然后：
adb exec-out screencap -p > 01_剪贴板列表.png
```

`adb exec-out screencap -p` 是 Android 原生截图，**分辨率等于设备真实物理分辨率**
（例如 1080×2400），无需额外缩放。

---

## 三、推荐拍摄方案（5 张，覆盖核心卖点）

> 每张附**推荐配文**（可直接用于商店截图文案）。
> 拍摄顺序建议与下表一致，保证叙事连贯。

### 截图 1：剪贴板列表（主界面）
- **界面**：`homeClipboard` 路由 / 底部导航「剪贴板」
  （`src/mobile/lib/screens/home_screen.dart` + `clipboard/clipboard_screen.dart`）
- **要体现**：多类型条目（文本/链接/图片/代码）、来源设备标签、
  同步状态指示、类型徽标
- **配文**：**「所有设备，一个剪贴板」**
  副文案：手机复制的文字，电脑上直接 Ctrl+V

### 截图 2：搜索与筛选
- **界面**：`clipboard/clipboard_search_bar.dart` + `filter_panel.dart` +
  `type_filter_chips.dart`
- **要体现**：搜索框输入关键词、类型筛选芯片（全部/文本/图片/链接/代码）已选中态
- **配文**：**「一搜就到，不再翻聊天记录」**
  副文案：按类型、设备、时间快速定位历史内容

### 截图 3：跨设备设备列表
- **界面**：`homeDevices` 路由 / `device_card.dart` + `sessions_section.dart`
- **要体现**：多台设备卡片（手机/电脑/平板）、在线状态、最后活跃时间
- **配文**：**「手机、电脑、平板，实时互通」**
  副文案：登录同一账号，即自动组网

### 截图 4：设置页 —— 权限与安全
- **界面**：`homeSettings` 路由 / `settings_screen.dart`（账号/服务器/通用/外观/
  安全/数据/通知/订阅分组）+ `permission_guide_screen.dart`
- **要体现**：**生物识别锁开关**（安全卖点）、同步开关、权限引导项
- **配文**：**「端到端加密 + 生物识别锁」**
  副文案：剪贴板内容加密传输，指纹/面容保护你的历史

### 截图 5：AI / 收藏 或 模板（任选，体现高阶能力）
- **选项 A（推荐）**：收藏夹 —— `homeFavorites` / `favorites_screen.dart`
  + `collection_items_screen.dart`
  - **配文**：**「收藏常用内容，随时取用」**
- **选项 B**：模板 —— `templates_screen.dart`
  - **配文**：**「常用回复存成模板，一键复制」**

> ⚠️ **关于 AI 功能截图的提醒**：移动端 **AI 入口目前是预留状态**
> （`src/mobile/lib/providers/feature_flags_provider.dart` 第 12 行注释明确：
> "AI 入口（桌面端底部导航/侧栏 AI 入口；**移动端预留**）"；
> 第 28–29 行 `featureAiCategories` 对应服务端 `ai_classify` 套餐特性）。
> **若移动端当前没有可实际操作的 AI 界面，请勿把 AI 功能放进截图**——
> 商店审核可能要求截图中展示的功能可用。建议移动端截图聚焦
> 剪贴板/同步/搜索/安全这些**已实现**的能力，AI 相关表达放到文案里
> 并明确标注适用端（详见 `应用介绍文案.md`）。

---

## 四、采集后的收尾检查

- [ ] 逐张**肉眼复核**：无真实手机号、邮箱、姓名、头像、真实剪贴板内容
- [ ] 确认状态栏干净（无微信/短信通知预览）
- [ ] 确认无调试字样（如 `Debug` 角标、服务器地址显示内网 IP）
      —— 截图 4 若展示「服务器地址」，**改为官方域名**，勿暴露测试 IP
- [ ] 横向对比各商店尺寸要求（见下表），必要时补拍
- [ ] 文件命名统一为 `序号_场景名.png`，放入本目录

## 五、各商店截图规格要求

| 商店 | 张数 | 尺寸要求 | 备注 |
|------|------|----------|------|
| 华为 | 3–5 张 | 建议 1080×1920 或以上，16:9 或 9:16 | 不支持透明通道 |
| 小米 | 3–8 张 | 建议 1080×1920，比例 3:4 ~ 16:9 | — |
| OPPO | 3–5 张 | 建议 1080×1920 | — |
| vivo | 3–5 张 | 建议 1080×1920 | 与图标一样要求无圆角方图 |
| 应用宝 | 3–5 张 | 建议 1080×1920 | 腾讯云测试会校验 |

> 真机 `screencap` 出来的图通常是 1080×2400 等**长屏比例**，
> 各商店一般可接受；若某商店严格限制 16:9，需用工具补边（加背景色留白），
> **不要拉伸变形**。

---

## 六、待办清单（设备就绪后）

| # | 任务 | 负责 |
|---|------|------|
| 1 | 用数据线连接手机，开启 USB 调试并授权 | **用户** |
| 2 | 确认 `adb devices` 显示 `device` | 用户（agent 可代验） |
| 3 | 准备专用测试账号 + 清理隐私数据 | **用户**（必须） |
| 4 | 按第三节方案采集 5 张截图 | agent（设备可连后自动执行） |
| 5 | 隐私复核 + 按商店规格裁剪 | agent + 用户确认 |
