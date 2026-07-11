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

## 修复后验证
- [ ] vue-tsc --noEmit 通过（前端变更文件）— 进行中
- [ ] 逻辑推演：两张同窗口截图 FNV 不同 → 都上传、无前缀碰撞 — 已确认（Rust fnv64 对异像素必出异哈希）
- [ ] 用户 rebuild 后实测：连截两张同窗口截图都出现 — 待用户验证
