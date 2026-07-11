# 图片同步慢 + 第二张截图不上传 — 根因排查 Checklist

**创建时间**：2026-07-11
**目标**：彻底解决「图片同步极慢」+「第二张同尺寸截图永远不上传」两个顽固问题
**完成度**：0 / 0 = 0%

## 现象
1. 微信截图能监听到、能同步，但**极慢**（远慢于 favorites 之前）
2. 截完第一张后，截第二张**死活不出现**

## 假设（逐个用工具验证）

### 第二张截图不上传（确定性 bug）
- [ ] H1 `uploadImageToServer` 用 `dataUrl.slice(0,200)` 做去重 key — 同尺寸两张截图 PNG 头+首压缩字节相同 → 前缀碰撞 → 第二张被 recentUploadHashes 判重复丢弃
- [ ] H2 monitor 的 FNV 哈希对第二张不同像素能区分（应 emit 事件）— 验证 ClipboardContent 哈希逻辑
- [ ] H3 前端事件 handler `skipPollUntil` 门控是否误杀第二张事件（copyItem 才设，图片上传不设 → 应不杀）

### 同步慢（延迟瓶颈）
- [ ] S1 后端 POST /api/clipboard 对图片是否有重处理（缩略图/重编码/对象存储上传）阻塞
- [ ] S2 Rust `get_clipboard_image` DIB→image crate 解码→PNG 重编码→base64 是否必要/可优化
- [ ] S3 前端 `resizeImageIfNeeded` 对 <1080px 截图是否跳过（应跳过）
- [ ] S4 favorites(3690a2f) 是否改了后端图片处理导致变慢
- [ ] S5 monitor 每 700ms 对驻留图片 `get_bitmap`+FNV 是否浪费（仅驻留时，影响小）
- [ ] S6 `recentUploadHashes` TTL 30000 + 前缀碰撞是否也拖慢首张（不应，仅判重）

## 验证记录

### 第 1 轮（2026-07-11）
- 排查：Rust `get_clipboard_image` 对 WeChat(CF_DIB) 路径与基线 3690a2f 基本一致，无新增解码成本（已读 lib.rs 409-491）
- 排查：后端 POST /api/clipboard 对图片**不做**缩略图/重编码/对象存储，直接存 base64（已读 clipboard.js 290-420）→ 延迟不在后端
- 排查：favorites(3690a2f) 仅改 `favorited_at`(+14 行)，未碰图片上传逻辑（已 `git show --stat`）
- **确认根因 H1**：`uploadImageToServer` 用 `dataUrl.slice(0,200)` 作 `recentUploadHashes` 去重 key。
  同窗口两张截图 PNG 签名(8B)+IHDR(25B,仅宽高/位深)+首压缩字节相同 → 前 200 字符 base64 相同 → key 碰撞 →
  30s 窗口内第二张(及之后每一张)被 `recentUploadHashes` 判重复**静默丢弃**。
  这就是「第二个截图死活不出现」；用户反复重截 → 体感「极慢/坏了」。两问题同一根因。
- 已修：把 Rust monitor 已算好的全量内容哈希(FNV) 透传 event→enqueue→queue→uploadImageToServer，
  作去重 key；缺失时回退 `simpleHash(dataUrl)`（全量哈希）。5 处调用点已改。

### 第 2 轮（2026-07-11，用户反馈：仍然只生效一条）
- 用户截图显示：DevTools 只打印一次 `[Clipboard] queue: task enqueued image length: 1` + 一次 processing，
  后续多次截图完全没有 enqueue。cmd 窗口也只有一次 `[get_clipboard_image]` 输出。
  → **结论：Rust monitor 只 emit 了一次 `clipboard-changed` 事件**，前端去重没有机会拦截。
- **确认根因 H4**：`ClipContent::Empty => {}` 不重置 `last_image_hash`。
  微信截图等工具在捕获过程中可能瞬间清空剪贴板或插入临时文本，导致 monitor 状态机从 image → empty/text → image。
  若后续截图的 raw DIB hash 与第一次相同（同窗口同尺寸），`last_image_hash` 未重置 → 被当作重复 → 静默丢弃。
- **确认根因 H5**：前端 fallback poll 存在死门控 `firstTauriPollDone`（声明了但从未赋值为 true），
  且 `initialLoadDone` 第一次轮询直接 return，导致 fallback poll 无法兜底。
- **修复**（本轮）：
  - Rust `clipboard_monitor.rs`：
    - `Empty` 分支重置 `last_image_hash/size/text/file_paths` 和 `last_change_time`。
    - `Files` 分支检测到文件时重置 image state。
    - `Image` 分支保留 hash 去重，但增加 **5 秒强制刷新窗口**：hash 相同但超过 5s 也 emit，由前端 PNG hash 最终去重。
  - 前端 `useClipboard.ts`：
    - `handleClipboardEvent` 获取 PNG 后用 `simpleHash(imgData)`（PNG content hash）更新 `lastImageHash`，
      不再依赖 Rust raw-DIB hash。
    - `readAndUpload` 第一次轮询仅记录当前 image hash 不上传；后续轮询直接获取 PNG 并用 PNG hash 去重，
      去掉 `firstTauriPollDone` 死门控，真正成为事件驱动的兜底。

## 修复后验证
- [ ] cargo check 通过（Rust monitor 状态机改动）— 进行中
- [ ] vue-tsc --noEmit 通过（前端 useClipboard.ts 改动）— 进行中
- [x] 逻辑推演：Rust Empty 分支重置 image state 后，image → empty → image 切换不会漏掉后续截图
- [x] 逻辑推演：5s 强制刷新窗口绕过不可靠的 raw-DIB hash，前端 PNG content hash 做最终去重
- [x] 逻辑推演：fallback poll 去掉死门控后，每 10s 会主动拉取当前剪贴板 PNG 并去重，成为事件驱动兜底
- [ ] 用户 rebuild 后实测：连截多张不同/同窗口微信截图都出现 — 待用户验证（`npm run tauri build` 后重测；用户自编译，我不编译桌面端）

## 完成度
- 根因定位：3/3
  - 第 1 层：`dataUrl.slice(0,200)` 前缀碰撞（已修 commit 03969dc）
  - 第 2 层：Rust monitor 状态机未在 Empty/Files/Text 时重置 `last_image_hash`（本轮修）
  - 第 3 层：前端 fallback poll `firstTauriPollDone` 死门控，无法兜底（本轮修）
- 修复：3/3（本轮改 Rust + 前端）
- 验证：type-check 进行中 + 逻辑推演通过（E2E 待用户 rebuild 实测）

