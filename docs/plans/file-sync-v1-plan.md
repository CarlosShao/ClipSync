# ClipSync 跨设备文件内容同步方案（v1）

> **状态**：**待审查**（尤其第 3 节分级配额方案，需你拍板后才进入实施）
> **日期**：2026-09-02
> **依据**：用户 PRD（文件类型双向同步）+ 三端代码调研
> **配套工单**：`docs/plans/file-sync-v1-tickets.md`

---

## 1. 背景与目标

### 1.1 现状缺陷

移动端只能同步到**文件名**，拿不到文件内容。实测现象（Android 模拟器）：文件条目详情页显示 `mobile-v1-tickets.md` · **0 B** · `text/plain`，按钮为「Copy file name」，提示「The file is saved on the source device and cannot be fetched across devices yet」。

### 1.2 目标（本方案范围）

| # | 目标 | 说明 |
|---|---|---|
| G1 | **PC 复制文件 → 移动端可用** | 主体场景。移动端能拿到**完整文件内容**并打开/分享 |
| G2 | **多文件同步** | 一次复制多个文件，移动端可逐个获取 |
| G3 | **大文件同步 + 分级限制** | 按账户等级限制单文件大小与云端容量，超限有提示与升级引导 |
| G4 | **两端能力对齐** | PC 与移动端都支持文件类型的接收与还原；移动端接收后能"粘贴"（Android 语义下=打开/分享） |

### 1.3 非目标（明确不做）

- ❌ **移动端主动复制文件给 PC**：按你的决策（第 2 点），移动端不提供"选文件上传"入口。
- ❌ 移动端后台自动采集文件。
- ❌ 文件在线编辑 / 版本管理。

---

## 2. 现状调研（三端能力盘点）

### 2.1 已具备的能力

**后端**（`src/server/src`）

| 能力 | 位置 |
|---|---|
| 文件上传（multipart 落盘 + 自建条目 + WS 广播） | `routes/media.js` `POST /api/media/file`（行 267） |
| 分片上传（大文件，含 DB 套餐校验） | `routes/chunked-upload.js`（校验见行 191-219） |
| 文件下载（含 Range） | `routes/media.js` `GET /:id/download`（行 377） |
| 文本/代码预览 | `routes/media.js` `GET /:id/text-preview`（行 587） |
| 套餐表 | `subscription_plans`（`max_file_size_mb` / `max_storage_mb` / `max_devices` / `max_clipboard_items`） |

**桌面端**（`src/desktop/src`）

| 能力 | 位置 |
|---|---|
| 剪贴板文件捕获 | `src-tauri/src/clipboard_monitor.rs`（行 391-397，emit `contentType:"file"` + `filePaths`） |
| 文件读取（明文 / base64 / 分片） | `lib/tauri.ts`（`readFileContent` / `readFileContentBase64` / `readFileRangeBase64`） |
| **上传路由（已完整实现）** | `composables/clipboardUpload.ts` 行 642-714：套餐校验 → ≤10MB multipart `/api/media/file` → >10MB 建条目 + chunked + `clipboardItemId` 转正 |
| 粘贴还原（base64 → 落临时盘 → 写回剪贴板） | `composables/useClipboard.ts:458` `tauri.saveAndCopyFile(b64, name)` |
| 套餐阈值（硬编码） | `clipboardUpload.ts:185-194` `planMaxUploadBytes()`：Free 128MB / Pro 256MB / Enterprise 1GB |

**移动端**（`src/mobile/lib`）

| 能力 | 位置 |
|---|---|
| 文件下载（已实现） | `screens/clipboard/item_detail_screen.dart:636-686` `_downloadFile()` → `GET /api/media/:id/download` → 存临时目录 |
| 降级态 UI | 同上，行 915-934：`_fileDegraded == true` → 显示「Copy file name」+「cannot be fetched」 |
| 降级触发条件 | 同上，行 171-174：`_looksLikeLocalPath(content)` → content 含 `\` 或 `/` 且非 data:/URL → 判定为"来源设备本机路径" → 降级 |
| i18n 文案（中英已备） | `app_zh.arb` / `app_en.arb`：`openDownload` / `copyFileName` / `fileDownloadHint` / `fileLocalOnlyHint` / `fileSavedTo` |

### 2.2 差距清单（要修/要补的）

| # | 差距 | 影响 | 证据 |
|---|---|---|---|
| **D1** | **文本文件走"明文随条目"通道，服务端不落盘** | 移动端 `/api/media/:id/download` 查无记录 → 下载 404 → catch → 降级为「只能复制文件名」。**这是 `.md` 文件失效的主因** | `clipboardUpload.ts:522` 注释"文本文件明文随条目上传"；`_downloadFile` 失败即 `_fileDegraded=true`（行 674-677） |
| **D2** | **前后端套餐阈值不一致** | 前端按 128MB 放行，后端按 DB 值（真实 Free 用户仅 **1MB**）拒绝 → 存为 localOnly → 移动端拿不到 | 桌面端 `planMaxUploadBytes()` 硬编码 128/256/1024；后端 `chunked-upload.js:206-208` 用 DB `max_file_size_mb`；DB seed（`012_schema_completion.sql:113-114`）Free=**1MB**、Pro=10MB、Ent=50MB |
| **D3** | **多文件被限制为 localOnly** | 一次复制多个文件**完全不同步** | `clipboardUpload.ts:527` 注释"多文件 → localOnly（已知限制）" |
| **D4** | **移动端"粘贴"语义未定义/未实现** | Android 剪贴板不支持文件二进制，当前只能"复制到临时目录"，没有打开/分享入口 | 移动端仅有 `_downloadFile` + SnackBar 提示路径，无打开/分享动作 |
| **D5** | **无云端总容量配额校验** | `max_storage_mb` 字段存在但**从没被校验**，可无限占用存储 | 全后端仅 `subscriptions.js` / `aiContext.js` 读取展示，上传路径无校验 |
| **D6** | **超限提示/升级引导不完整** | 超限仅 toast 文案，无跳转订阅页入口；移动端无对应提示 | `clipboardUpload.ts:647-650` 仅 `toast.show(...)` |

---

## 3. 分级配额方案【**需你审查拍板**】

### 3.1 设计原则

1. **单一数据源**：套餐阈值以**后端 `subscription_plans` 表为准**。前端（桌面端 + 移动端）从 `GET /api/subscriptions/current` 拉取并缓存，**禁止再硬编码**（当前桌面端硬编码是 D2 的根因）。
2. **后端强制校验**：前端校验只用于提前给友好提示，可被绕过；**后端必须在上传入口强制校验**（单文件大小、单文件数、用户总容量）。
3. **超限不静默**：任何超限都必须让用户看到**为什么**、**差多少**、**怎么解决**（升级入口）。

### 3.2 阈值提案

> 说明：桌面端当前硬编码 128/256/1024 是**实际在用**的值；DB seed 的 1/10/50MB 是**早期占位值**，明显过小（一个几十 KB 的 .md 都会超限）。故建议以**桌面端值为基准**修正 DB。

#### 方案 A（推荐，宽松，利于体验）

| 维度 | Free 免费版 | Pro 专业版 | Enterprise 企业版 | 字段 |
|---|---|---|---|---|
| 单文件大小上限 | 128 MB | 256 MB | 1 GB | `max_file_size_mb` |
| 云端文件总容量 | 1 GB | 50 GB | 500 GB | `max_storage_mb` |
| 单次多文件数量上限 | 5 个 | 20 个 | 100 个 | 新增 `max_files_per_clip` |
| 单次多文件总大小上限 | 128 MB | 256 MB | 1 GB | 同单文件上限 |
| 文件条目保留期 | 7 天 | 30 天 | 90 天 | 新增 `file_retention_days` |
| 传输路由阈值 | >10 MB 走分片（全等级一致） | 同左 | 同左 | 前端常量 |

#### 方案 B（保守，控成本）

| 维度 | Free | Pro | Enterprise |
|---|---|---|---|
| 单文件大小上限 | 20 MB | 128 MB | 512 MB |
| 云端文件总容量 | 200 MB | 20 GB | 200 GB |
| 单次多文件数量上限 | 3 个 | 10 个 | 50 个 |
| 文件条目保留期 | 3 天 | 30 天 | 90 天 |

> **请你在 A / B 之间选择，或直接给出自己的数值。** 两者都需同步修正 DB `subscription_plans` 的 seed 值。

### 3.3 超限提示策略

统一使用**结构化提示**（三要素：限制值 / 当前值 / 解决入口），两端 i18n（中/英）：

| 场景 | 提示文案（中文模板） | 动作 |
|---|---|---|
| 单文件超限 | 「{fileName}（{size}）超过{planName}单文件 {limit} 限制」 | 【升级 {nextPlan}（{nextLimit}）】→ 订阅页 |
| 多文件数量超限 | 「一次最多同步 {n} 个文件（{planName}）」 | 【升级】→ 订阅页 |
| 多文件总大小超限 | 「本次 {n} 个文件共 {total}，超过{planName} {limit} 限制」 | 【升级】或【分批复制】 |
| 云端总容量已满 | 「云端存储已满（{used}/{quota}），新文件暂不同步」 | 【管理存储】+【升级】 |
| 文件已过期 | 「该文件已超过{planName} {days} 天保留期，已清理」 | 【升级延长保留期】 |

**移动端额外规则**：移动端是接收方，超限由**上传方（PC）**产生；移动端只需展示"该文件在来源设备上超出套餐限制，未同步到云端"+【了解套餐】入口。

### 3.4 升级引导策略

1. **不阻断主流程**：超限文件仍以 `localOnly` 存在（本机可用），条目正常显示，只是标记"仅本机"+ 超限原因。
2. **升级入口直达**：提示里带按钮 → 桌面端跳订阅页；移动端跳订阅管理页（已有 `subscription_plans_screen`，v1.1 已恢复）。
3. **明确收益对比**：提示中直接写出升级后能获得什么（如「升级 Pro：单文件 256MB、云端 50GB、保留 30 天」），不做模糊引导。
4. **频率控制**：同一限制 24h 内对同一用户最多提示 1 次，避免复制大文件时刷屏（复用 `recentUploadHashes` 类似的节流机制）。

### 3.5 待确认问题（请你拍板）

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | 采用方案 A 还是 B？（或自定数值） | **A**（体验优先；你是 admin 账号，测试不受限） |
| Q2 | 是否需要**云端总容量**限制？ | **需要**（D5，当前完全无校验，有存储成本风险） |
| Q3 | 是否需要文件**保留期**自动清理？ | **需要**（否则存储只增不减）；需配套的清理定时任务 |
| Q4 | 多文件在 UI 上是"一个条目含 N 个文件"还是"N 个独立条目"？ | **一个条目含 N 个文件**（一次复制=一个条目，语义清晰，列表不刷屏） |
| Q5 | 移动端"粘贴"采用哪种？①下载到 App 目录 + 【打开】②直接调系统【分享】面板 ③两者都要 | **③两者都要**（打开用 `open_filex`，分享用 `share_plus`） |
| Q6 | 大文件（>10MB）移动端是否需要**断点续传 / 后台下载**？ | v1 **不需要**（先做前台下载 + 进度条），v1.1 再评估 |

---

## 4. 技术方案

### 4.1 数据流（PC → 服务端 → 移动端）

```
[PC 复制文件]
   │ Tauri clipboard_monitor 捕获 filePaths
   ▼
[桌面端 clipboardUpload]
   │ ① 拉后端阈值（/api/subscriptions/current，缓存 5min）
   │ ② 校验：单文件大小 / 文件数 / 单次总大小 / 用户剩余容量
   │    超限 → localOnly + 超限提示 + 升级引导
   │ ③ 按大小路由：≤10MB → multipart /api/media/file
   │              >10MB → 建条目(localOnly:true) + chunked 分片 + complete 带 clipboardItemId 转正
   ▼
[服务端]
   │ 后端**强制**二次校验（同一套阈值，来自 DB）
   │ 文件落盘 uploads/ + 写 clipboard_items(metadata.files[]) + WS 广播 new_clipboard
   ▼
[移动端]
   │ WS 收到 new_clipboard → 列表出现条目
   │ 点开详情 → metadata.files 渲染文件列表（名称/大小/mime）
   │ 点击某文件 → GET /api/media/:id/download?fileIndex=n
   │            → 存 App 临时目录 → 【打开】/【分享】
```

### 4.2 统一落盘（修复 D1）

**核心改动**：所有文件（含文本）**都落盘到服务端**，不再"明文随条目"。

- `clipboardUpload.ts` 移除文本通道的"只上传明文"分支：文本文件内容**照常走 multipart/chunked 落盘**；
- 条目 `contentEncrypted` 改为存**结构化 JSON**（文件名/大小/mime/fileId 列表），**不再存本地路径**（这是移动端 `_looksLikeLocalPath` 误判的根源）；
- 为保留桌面端 DocPreview 的文本预览能力，落盘时**额外**在 `metadata.textPreview` 存前 N KB 明文（仅文本类文件）。

### 4.3 多文件模型（修复 D3）

条目 `metadata` 结构：

```json
{
  "files": [
    { "fileId": "uuid", "name": "a.md",  "size": 12345, "mimeType": "text/markdown" },
    { "fileId": "uuid", "name": "b.zip", "size": 20971520, "mimeType": "application/zip" }
  ],
  "totalSize": 20983865,
  "totalCount": 2,
  "localOnly": false,
  "limitReason": null
}
```

- 后端 `POST /api/media/file` 支持**多文件**（`fileUpload.array('files', N)`），一次请求建**一个**条目；
- 下载接口支持 `?fileIndex=n` 指定下载第 n 个文件；不传则打包为 zip（>1 个文件时）。
- 移除 `clipboardUpload.ts` 中"多文件 → localOnly"的限制。

### 4.4 移动端接收与"粘贴"（修复 D4）

Android 剪贴板**不支持**文件二进制，故"粘贴"落地为：

1. **下载**：`GET /api/media/:id/download?fileIndex=n` → 存到 `getTemporaryDirectory()`；显示下载进度。
2. **打开**：`open_filex` 按 mime 调用系统应用打开。
3. **分享**：`share_plus` 调系统分享面板（可发给微信/邮件等其它应用）——**这是 Android 上最接近"粘贴文件"的语义**。
4. **UI**：详情页文件列表（图标/名称/大小/mime）+ 每文件一行【下载】【打开】【分享】；`_fileDegraded` 仅在**下载确实失败**时置位，不再因"content 像路径"误判（配合 4.2 修复后基本不会触发）。

### 4.5 API 变更清单

| 接口 | 变更 | 兼容 |
|---|---|---|
| `GET /api/subscriptions/current` | 响应补充 `maxFilesPerClip` / `fileRetentionDays` / `storageUsedMb` | 向前兼容（新增字段） |
| `POST /api/media/file` | 支持多文件（字段名 `files`，仍兼容单文件 `file`） | 兼容 |
| `GET /api/media/:id/download` | 新增 `?fileIndex=` 参数；多文件且未指定时返回 zip | 兼容（默认行为不变） |
| `POST /api/upload/init`（chunked） | 新增：文件数校验、用户剩余容量校验 | — |
| （新增）`GET /api/storage/usage` | 返回已用/总量，供两端展示容量进度 | 新增 |

---

## 5. 任务拆分

见配套工单 **`docs/plans/file-sync-v1-tickets.md`**，划分为：

- **Wave 0**：分级配额地基（后端单一数据源 + 强制校验）—— **依赖第 3 节审查通过**
- **Wave 1**：PC → 服务端统一落盘（文本也落盘 + 多文件）
- **Wave 2**：移动端接收 / 打开 / 分享
- **Wave 3**：两端超限提示与升级引导
- **Wave 4**：端到端联调与分级阈值验收

---

## 6. 风险与开放问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| DB seed 修正影响现有用户 | 改 `subscription_plans` 数值会影响所有该等级用户 | 用迁移脚本 `UPDATE` 而非改 seed；改前备份；Free 从 1MB 放宽是**放宽**，不会误伤 |
| 多文件打包 zip 的服务端开销 | 大文件打包占 CPU/内存 | zip 仅对 ≤100MB 的请求；超限返回"请逐个下载" |
| 移动端大文件下载体验 | Android 后台下载易被系统杀 | v1 仅前台下载 + 进度条；>50MB 提示"建议在 Wi-Fi 下下载"（Q6） |
| 文本预览与落盘双写 | 文本文件既存明文预览又存二进制，占用略增 | 预览仅存前 64KB，可忽略 |
| 端到端加密（E2EE）与文件落盘 | 若用户开启 E2EE，服务端存密文，移动端需解密 | **待确认**：当前 E2EE 是否覆盖文件类型？若覆盖，移动端下载后需解密再打开（工单需补） |
