# ClipSync 跨设备文件内容同步 v1 — 任务工单

> **依据**：`docs/plans/file-sync-v1-plan.md`（完整方案，含分级配额设计）
> **状态**：⏸ **等待审查**——第 3 节「分级配额方案」与 Wave 0 / Wave 3 需用户拍板后才开工；Wave 1 / Wave 2 不依赖分级数值，可先行
> **日期**：2026-09-02
> **分支**：建议 `feature/file-sync-v1`（基于当前 dev）
> **并发纪律**：最多 2 个 subagent 并行；同波工单「独占文件」互斥；子代理禁止 git 操作

---

## 一、全局约束（对所有执行子代理）

1. **文件所有权**：只允许修改本工单「独占文件」清单内的文件；越界改动须在交付报告中说明，由编排者处理。
2. **禁止 git 操作**：子代理不执行任何 git commit / push / checkout；只改代码、跑验证、输出交付报告。
3. **验证门禁**（每张工单自查，波次结束编排者复验）：
   - 后端：`cd src/server && node --check <file>` 通过 + 现有测试通过
   - 桌面端：`cd src/desktop && npm run build` 通过（或 `vue-tsc --noEmit`）
   - 移动端：`cd src/mobile && flutter analyze` 零 error + `flutter build apk --debug` 通过
   - 涉及后端的工单：`docker restart clipsync` 后 `docker logs clipsync` 无新增 `EISDIR` / `uncaughtException`
4. **行为红线**：
   - 不改动既有 API 的**请求**契约（只能新增字段/参数，保持向后兼容）
   - **所有 `createReadStream(...).pipe(res)` 必须挂 `.on('error')`**（EISDIR 崩溃根因，见 2026-09-02 事故记录）；新增代码同样适用
   - 套餐阈值**禁止硬编码**，一律从后端 `GET /api/subscriptions/current` 获取
   - 文案需中/英双语（桌面端 `src/desktop/src/locales/*.json`；移动端 `src/mobile/lib/l10n/app_zh.arb` + `app_en.arb`）
5. **桌面端教训**：禁止「观察者回调里再改被观察属性」的样式重算模式（桌面端黑屏根因）。

---

## 二、现状基线（调研结论摘要）

- **已具备**：后端 `POST /api/media/file`（multipart 落盘）、chunked 分片上传、`GET /:id/download`（Range）；桌面端上传路由完整（`clipboardUpload.ts:642-714`，套餐校验 → ≤10MB multipart → >10MB chunked + `clipboardItemId` 转正）、`saveAndCopyFile` 粘贴还原；移动端 `_downloadFile()` 已实现（`item_detail_screen.dart:636-686`）。
- **六个差距**：
  - **D1** 文本文件走"明文随条目"不落盘 → 移动端下载 404 → 降级为「只能复制文件名」（**`.md` 失效主因**）
  - **D2** 前后端阈值不一致：桌面端硬编码 128/256/1024MB，后端按 DB（真实 Free 仅 **1MB**）
  - **D3** 多文件被限制为 localOnly，完全不同步
  - **D4** 移动端"粘贴"语义未实现（Android 剪贴板不支持文件二进制）
  - **D5** `max_storage_mb` 字段存在但**从未校验**
  - **D6** 超限提示无升级引导入口，移动端无对应提示

---

## 三、Wave 0 — 分级配额地基 ⏸ **依赖方案第 3 节审查通过**

### F0.1 [P0][后端][迁移] 修正套餐阈值 seed 并新增字段
- **独占文件**：`src/server/src/db/migrations/` 下新建迁移文件（如 `037_file_sync_plan_limits.sql`）
- **要求**：
  1. 按审查通过的数值 `UPDATE subscription_plans` 的 `max_file_size_mb` / `max_storage_mb`（**用 UPDATE 而非改旧 seed**，避免影响历史迁移链）
  2. 新增列 `max_files_per_clip INTEGER`（单次多文件数上限）、`file_retention_days INTEGER`（文件条目保留天数）
  3. 迁移幂等（`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`）
- **验收**：迁移在现有库上可重复执行不报错；`SELECT name, max_file_size_mb, max_storage_mb, max_files_per_clip, file_retention_days FROM subscription_plans` 返回审查通过的数值

### F0.2 [P0][后端] 上传入口强制配额校验
- **独占文件**：`src/server/src/routes/media.js`、`src/server/src/routes/chunked-upload.js`
- **要求**：
  1. 抽出公共校验函数（建议 `src/server/src/utils/planLimits.js`，新建）：一次性校验 **单文件大小 / 文件数 / 单次总大小 / 用户已用容量**，返回 `{ allowed, reason, limit, used }`
  2. `POST /api/media/file` 与 `POST /api/upload/init` **都调用**该校验（当前仅 chunked 有校验，且只看单文件）
  3. 超限返回 **HTTP 413** + 结构化 body：`{ error, code: 'FILE_SIZE_EXCEEDED'|'TOO_MANY_FILES'|'STORAGE_QUOTA_EXCEEDED', limit, current, plan, upgradeTo }`
  4. 统计用户已用容量：`SELECT COALESCE(SUM(content_size),0) FROM clipboard_items WHERE user_id=$1 AND content_type='file'`（或按实际文件字节）
- **验收**：构造 Free 账号上传超限文件 → 返回 413 且 `code` 正确；未超限正常上传

### F0.3 [P0][后端] 容量用量查询接口
- **独占文件**：`src/server/src/routes/storage.js`（新建）、`src/server/src/index.js`（或路由注册处）
- **要求**：`GET /api/storage/usage`（需鉴权）返回 `{ usedBytes, quotaBytes, fileCount, plan }`
- **验收**：接口返回与 DB 实际用量一致；未登录返回 401

### F0.4 [P0][桌面端] 前端阈值改为后端下发
- **独占文件**：`src/desktop/src/composables/clipboardUpload.ts`、`src/desktop/src/composables/useClipboard.ts`、`src/desktop/src/composables/useFileUpload.ts`
- **要求**：
  1. 删除 `planMaxUploadBytes()` 的硬编码分支（行 185-194）与 `useClipboard.uploadFileItem` 内的 `planLimits` 硬编码（行 816-829）
  2. 统一从 `GET /api/subscriptions/current` 读取阈值（已有响应含 `maxFileSizeMb` / `maxStorageMb`），缓存 5 分钟
  3. 上传前用后端返回的阈值做**预校验**（体验优化，后端 F0.2 仍会二次校验）
- **验收**：改 Free 套餐 DB 值 → 桌面端重启后提示的限制值随之变化（不再恒为 128MB）

---

## 四、Wave 1 — PC → 服务端统一落盘（不依赖分级数值，可先行）

### F1.1 [P0][桌面端] 文本文件也落盘，content 不再存本地路径
- **独占文件**：`src/desktop/src/composables/clipboardUpload.ts`
- **问题**：文本文件走"明文随条目"通道（行 522 注释），服务端不落盘 → 移动端下载 404 → 降级（D1）；且 `contentEncrypted` 存本地路径 → 移动端 `_looksLikeLocalPath` 误判（D1 次生）
- **要求**：
  1. 移除"文本只传明文"分支：文本文件与二进制**同样走** multipart / chunked 落盘
  2. `contentEncrypted` 改为结构化 JSON：`{ files:[{fileId,name,size,mimeType}], totalSize, totalCount }`，**绝不存本地路径**
  3. 文本类文件额外在 `metadata.textPreview` 存前 64KB 明文，保住桌面端 DocPreview 预览与全文搜索
- **验收**：PC 复制一个 `.md` 文件 → 服务端 `uploads/` 出现该文件；`content_encrypted` 是 JSON 而非路径；桌面端 DocPreview 仍能预览文本

### F1.2 [P0][后端] media/file 支持多文件 + 单条目聚合
- **独占文件**：`src/server/src/routes/media.js`
- **要求**：
  1. `fileUpload` 改为 `.array('files', N)`（N 取套餐 `max_files_per_clip`，默认 5；**仍需兼容**单文件字段名 `file`）
  2. 一次请求建立**一个** clipboard 条目，`metadata.files[]` 记录每个文件的 fileId / name / size / mimeType，`metadata.totalSize` / `totalCount`
  3. 落盘目录沿用 `uploads/files/`（或 `uploads/images/` 按 mime 分流，保持现有逻辑）
  4. WS 广播仍为单条 `new_clipboard`（一个条目）
  5. **新增的下载逻辑必须挂 `.on('error')`**（见全局约束第 4 条）
- **验收**：一次 POST 两个文件 → 只产生 1 个 clipboard 条目，metadata.files 长度为 2；WS 只广播 1 次

### F1.3 [P0][后端] download 支持 fileIndex 与打包
- **独占文件**：`src/server/src/routes/media.js`
- **要求**：
  1. `GET /api/media/:id/download?fileIndex=n` 下载第 n 个文件
  2. 多文件且未指定 fileIndex → 打包为 zip 流式返回（zip 总大小 ≤100MB，超限返回 400 提示"请指定 fileIndex 逐个下载"）
  3. 所有 `createReadStream` 必须挂 `.on('error')` + `res.destroy()`
- **验收**：`fileIndex=0` 与 `fileIndex=1` 下载到的是不同文件；不传参返回 zip；路径异常时**后端不崩**（返回 4xx/5xx，进程存活）

### F1.4 [P0][桌面端] 解除多文件 localOnly 限制
- **独占文件**：`src/desktop/src/composables/clipboardUpload.ts`
- **要求**：移除"多文件 → localOnly"分支（行 527 注释处），多文件走 F1.2 的批量上传；超限按 F3.1 提示
- **验收**：PC 一次复制 3 个文件 → 服务端产生 1 个含 3 文件的条目；移动端可见

---

## 五、Wave 2 — 移动端接收 / 打开 / 分享

### F2.1 [P0][移动端] 文件条目详情页改造（多文件列表）
- **独占文件**：`src/mobile/lib/screens/clipboard/item_detail_screen.dart`、`src/mobile/lib/models/clipboard_item.dart`
- **要求**：
  1. 模型支持解析 `metadata.files[]`（`fileId` / `name` / `size` / `mimeType`）与 `totalSize` / `totalCount`
  2. 详情页渲染文件列表（图标 + 名称 + 大小 + mime），每个文件一行操作区
  3. 单文件（totalCount=1）保持现有卡片样式，仅把按钮从「打开（下载到本机）」升级为【下载】【打开】【分享】
  4. **`_fileDegraded` 判定收窄**：仅在**下载确实失败**时置位（配合 F1.1 后 content 不再是路径，误判自然消失）；保留 `_copyFileName` 作为下载失败后的兜底动作
- **验收**：模拟器打开一个单文件条目与一个多文件条目，列表正确渲染大小/名称；点击下载能存到临时目录

### F2.2 [P0][移动端] 下载后打开与分享
- **独占文件**：`src/mobile/lib/screens/clipboard/item_detail_screen.dart`、`src/mobile/lib/utils/file_opener.dart`（新建）、`pubspec.yaml`
- **要求**：
  1. 下载：`GET /api/media/:id/download?fileIndex=n`（Bearer）→ 存 `getTemporaryDirectory()`，显示进度（`_downloadBusy` 已有骨架）
  2. **打开**：`open_filex`（或 `open_file`）按 mime 调系统应用
  3. **分享**：`share_plus` 调系统分享面板（Android 上最接近"粘贴文件"的语义）
  4. 权限：Android 侧无需额外存储权限（存 App 私有临时目录 + 用 FileProvider 分享）
- **验收**：下载完成后点【打开】能被系统应用打开；点【分享】能唤起系统分享面板并发出文件

### F2.3 [P1][移动端] 多文件打包下载
- **独占文件**：`src/mobile/lib/screens/clipboard/item_detail_screen.dart`
- **要求**：多文件条目提供【全部下载（zip）】，调用不带 `fileIndex` 的 download，解压后逐个可打开/分享
- **验收**：3 文件条目点【全部下载】得到 zip 并可解压出 3 个文件

---

## 六、Wave 3 — 超限提示与升级引导 ⏸ **依赖方案第 3 节审查通过**

### F3.1 [P0][桌面端] 超限提示 + 升级引导
- **独占文件**：`src/desktop/src/composables/clipboardUpload.ts`、`src/desktop/src/composables/useClipboard.ts`、`src/desktop/src/locales/zh.json`、`src/desktop/src/locales/en.json`
- **要求**：
  1. 捕获后端 413 的结构化 body，按 `code` 展示对应文案（见方案 3.3 表格）
  2. toast / 通知带【升级 {nextPlan}】按钮 → 跳订阅页；并写明升级后收益（如「升级 Pro：单文件 256MB、云端 50GB」）
  3. 超限文件仍以 `localOnly` 保留（本机可用），条目标记"仅本机"+ 超限原因
  4. **频率控制**：同一 `code` 24h 内同用户最多提示 1 次
- **验收**：Free 账号复制超限文件 → 看到含升级按钮的提示；点击跳订阅页；24h 内不重复刷屏

### F3.2 [P0][移动端] 超限 / 不可同步提示 + 套餐入口
- **独占文件**：`src/mobile/lib/screens/clipboard/item_detail_screen.dart`、`src/mobile/lib/l10n/app_zh.arb`、`src/mobile/lib/l10n/app_en.arb`
- **要求**：
  1. 条目 `metadata.limitReason` 有值时，详情页展示"该文件在来源设备超出套餐限制，未同步到云端"+【了解套餐】→ 订阅页
  2. 文案中英双语
- **验收**：构造一个带 `limitReason` 的条目，移动端显示对应提示且按钮可跳订阅页

### F3.3 [P1][后端] 文件保留期清理任务
- **独占文件**：`src/server/src/services/` 或 `src/server/src/utils/` 下新建清理任务、`src/server/src/index.js`（注册）
- **要求**：按套餐 `file_retention_days` 定期清理过期文件条目与其磁盘文件（复用现有 cleanup 定时任务模式）
- **验收**：插入一条超过保留期的文件条目 → 定时任务执行后条目与磁盘文件均被清理

---

## 七、Wave 4 — 端到端联调与验收

### F4.1 [P0][联调] 主体场景端到端
- **要求**：PC 复制以下样本，移动端均能获取完整内容并打开/分享：
  1. 小文本文件（`.md` / `.txt`，< 1MB）—— **回归 D1**
  2. 小二进制（`.png` / `.zip`，< 10MB）
  3. 大文件（> 10MB，走分片）
  4. 多文件（3~5 个，混合类型）—— **回归 D3**
- **验收**：四组全部成功；移动端 `_fileDegraded` **不触发**（或仅在真实失败时触发）；后端日志无 `EISDIR` / `uncaughtException`

### F4.2 [P0][联调] 分级阈值行为验证
- **要求**：用 Free / Pro / Enterprise（及 admin）账号分别验证：
  1. 未超限 → 正常同步
  2. 单文件超限 → 413 + `FILE_SIZE_EXCEEDED` + 升级引导
  3. 文件数超限 → `TOO_MANY_FILES`
  4. 容量超限 → `STORAGE_QUOTA_EXCEEDED`
- **验收**：四种行为符合方案 3.2 / 3.3

### F4.3 [P1][回归] 存量条目兼容
- **要求**：F1.1 上线前的历史条目（`content_encrypted` 为本地路径）不应崩溃，应走降级态显示"文件在来源设备本机"
- **验收**：打开历史文件条目不崩溃，显示降级提示

---

## 八、待确认（阻塞项，需用户/编排者拍板）

| # | 阻塞项 | 影响 |
|---|---|---|
| B1 | 方案第 3.2 节阈值选 **A 还是 B**（或自定） | 阻塞 Wave 0 全部 + Wave 3 全部 |
| B2 | 是否需要**云端总容量**限制（Q2） | 阻塞 F0.2 / F3.3 |
| B3 | 是否需要文件**保留期**自动清理（Q3） | 阻塞 F3.3 |
| B4 | 多文件 UI 形态：**一条目含 N 文件** 还是 **N 个独立条目**（Q4） | 阻塞 F1.2 / F2.1（当前按"一条目含 N 文件"设计） |
| B5 | 移动端"粘贴"：打开 / 分享 / 都要（Q5） | 阻塞 F2.2（当前按"都要"设计） |
| B6 | **E2EE 是否覆盖文件类型**？若覆盖，移动端下载后需先解密才能打开 | 若覆盖，F2.2 需补解密步骤，**未确认前不要开工 F2.2** |
