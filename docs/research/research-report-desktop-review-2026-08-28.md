# ClipSync 桌面端功能客观审查报告（面向移动端决策）

## Executive Summary

基于对桌面端全部前端代码（`src/desktop/src/`）、Rust 层（`src-tauri/src/`）与后端 API（`src/server/src/routes/`）的实际代码审查（而非文档），核心结论是：ClipSync 桌面端的"单机剪贴板体验"已达到较高完成度——捕获、去重、搜索、收藏、组织、AI 辅助均真实可用且细节扎实；但作为产品立身之本的"跨设备同步"，其实时链路存在三处已验证的断裂（前端从不发送 WS 注册、前后端事件名不匹配、生产环境缺少 CSRF 握手），意味着"实时同步"目前主要靠用户交互触发的刷新兜底，而非真正的推送。此外缺少 refresh token、删除无墓碑、增量同步接口后端已有但前端从未调用。综合判断：**桌面端尚未达到可以转向移动端的阶段**，必须先修复同步链路这一定义性缺陷，再补齐会话长期化与增量补拉两项移动端硬依赖。

## 1. 核心功能完整性

按剪贴板工具的主场景逐项核对代码实现，桌面端已覆盖的功能面相当完整。

捕获链路（Rust `clipboard_monitor.rs`）支持纯文本（CF_UNICODETEXT，含 UTF-16 解码容错）、图片（DIB/DIBV5/PNG 三优先级，独立 worker 线程编码，FNV 哈希去重）、文件（CF_HDROP）；前端有事件 + 10 秒轮询双保险、三层去重（Rust echo guard、前端 TTL Map、上传哈希库）、串行上传队列、断网离线队列（localStorage，200 条上限）。历史浏览有 50 条分页、类型过滤 tab、设备/日期高级筛选、并发受控的图片异步加载队列（429 自动暂停 60 秒）、localStorage 本地缓存（LRU + TTL + 配额折半重试）、归档视图（即回收站）。搜索是后端 PostgreSQL 全文检索（tsvector + ts_rank，OCR 文本参与检索）加 ILIKE 兜底，配 300ms 防抖、服务端持久化的搜索历史、基于使用频率的粘贴预测。组织能力有收藏、集合/文件夹、标签（附颜色与按标签过滤）、批量删除（前后端链路完整）、条目密码保护与隐私遮蔽。输出侧有点击回写剪贴板（长文本自动从 `/content` 拉全量）、快速粘贴面板（含独立窗口形态与本地固定条目）、全局快捷键（可自定义）。AI 模块提供对话、上下文摘要、剪贴板批量建议、OCR、工具调用（含 AI 执行批量删除/打标签）。后端还实现了二维码设备配对（5 分钟一次性 token + 免登录兑换）、分享链接、数据同步增量接口。

主要缺口有三：其一，**富文本/HTML 剪贴板格式未捕获**——Rust 侧只读文本/图片/文件三种格式，从浏览器复制网页得到的是降级后的纯文本，格式信息全部丢失，这对 2026 年的剪贴板工具是显性短板；其二，主列表**无置顶**（固定仅存在于快速粘贴面板且为 localStorage 本地态，不跨设备、不作用于主列表），也**无按日期分组**浏览；其三，分片上传在应用重启后进度丢失，只能重新选择文件。

## 2. 功能深度与细节：能用，多数好用，但异常路径有明显暗坑

细节层面大量地方做得比"能用"好得多：乐观插入 + 失败回滚、429 解析 `Retry-After` 并弹倒计时 toast、图片 blob URL 自动回收防泄漏、空页自动修正防 `hasMore` 卡死、加载失败推进页码防卡页、WS 指数退避重连 + 25s/35s 心跳看门狗防假连接、文本 9MB 预判拦截（预留后端 10MB 余量）、IDempotency-Key 自动生成防重复提交。这些是打磨过的痕迹。

但异常路径上有四个实质性暗坑。第一，**所有 fetch 均未设置超时**（无 AbortSignal），后端悬挂时 UI 加载态可能永久挂起。第二，**401 无任何统一出口**：无 refresh token、无响应拦截器，JWT 过期后用户停留在主界面，每个操作各自弹"Token expired"错误，不会登出也不会跳转登录页；部分代码（configStore）还绕过统一 client 用裸 fetch，彻底没有 401 处理。第三，**多设备实时链路实际是断的**（详见第 4 节，这也是最严重的问题）。第四，"加载更多"失败页数据静默丢失、断网瞬间在飞的请求无任何用户提示、首次安装后未取到 deviceId 就断网时文本直接丢弃（仅 console.warn）。

## 3. 冗余与价值判断

存在四处明显的资源错配。最突出的是**两套文档预览并存**：`DocumentDrawer.vue`（约 1300 行，自带全套类型检测/渲染逻辑，携带 pdfjs/xlsx/mammoth/highlight.js/jszip/marked 重型依赖）与 `DocPreviewModal.vue`（862 行）+ `doc-preview/` 六组件（445 行）+ `utils/docPreview.ts`（239 行），两者功能高度重叠，应裁撤一套。其次是**主题系统超配**：7 套主题 × 明暗 = 14 份完整 CSS 变量组，占 globals.css 约 85% 篇幅，而产品定位只需"浅色/深色/跟随系统"——且"跟随系统"在 `useTheme.ts` 中根本没有实现，types 里的 `ThemeMode` 甚至不含 system。第三，**满意度调查是循环骚扰**：30 天冷却后再次弹出，且后端 `/api/surveys/stats` 与 `/my` 两个接口前端从未调用、无任何查看界面——收集了数据没有消费。第四，`CoachMarks`、`OnboardingView`、`SatisfactionSurvey` 三个组件在 HomeView 中与其他组件的懒加载策略相反，全部首屏同步 import。

与此形成对照的是 AI 模块的体量：前端约 14,000 行（ai/ 目录约 9,900 行 + composables 约 1,550 行 + api/ai.ts 765 行 + 设置页），后端 AI 相关代码约 458KB，占 routes 目录字节的 65%，`aiTools.js` 单文件 207KB 为全项目最大。这不是"冗余"，但投入权重已明显超过一个剪贴板工具的主业——同步链路断裂至今未修，而 AI 工具链已做到让 AI 替用户批量删除、打标签。模板系统（前后端约 1,100 行 + 独立一级导航）与剪贴板联动很浅（只能读取当前系统剪贴板作为变量，不能引用历史条目，产物不回写同步历史），价值存疑但尚可自洽为轻量附属功能。

真正值得补的核心能力按价值排序：富文本/HTML 捕获（补齐输入侧最大缺口）、主列表置顶与跨设备固定（剪贴板工具的高频刚需，QuickPaste 已有雏形）、批量收藏/批量移动集合（批量删除已有，组织侧不对称）、请求超时与 401 统一处理（低成本高收益的稳健性）。

## 4. 与移动端的衔接：数据模型友好，同步协议必须重做

有利基础是扎实的。`devices` 表显式预留了 `device_type IN ('desktop','mobile','tablet','browser')` 与 `platform IN ('windows','macos','linux','ios','android','browser')`；二维码配对 API（`/api/devices/pairing/init` + `/pairing/redeem`，redeem 接受 deviceType/platform 并直接签发 JWT + 注册设备）就是为移动端扫码登录设计的；REST API 纯 Bearer 即可访问（CSRF 中间件对 Bearer 放行）；列表接口返回 5000 字符截断的 preview 而非全文、`/:id/content` 提供轻量正文接口，适合移动流量场景；搜索/收藏/集合/标签接口与设备无关；前端对 Tauri 的依赖已收敛到 `lib/tauri.ts` 抽象层（业务组件直接 invoke 的仅剩文档预览与快速粘贴窗口等少数几处）。

但同步协议层面有三个硬伤，恰好都在移动端最依赖的位置上。第一，**实时推送链路目前完全断裂**：后端要求客户端连接后发送 `{type:'register', deviceId}` 才进入广播表（10 秒未注册即被踢），前端 `useWebSocket.ts` 全文从不发送 register，只发 ping；后端广播的事件名是 `new_clipboard` / `clipboard_updated` / `clipboard_deleted`，前端监听的却是 `new_clip` / `sync` / `clipboard_update`——三个名字全部对不上；生产环境 WS 还强制一次性 `csrf_token` 查询参数（缺失即 4006 拒绝），客户端也未传。三者叠加的结果是：设备永远进不了广播表，收不到任何推送，"实时同步"实际靠用户切换分类/搜索/重启触发的列表刷新兜底，HomeView 里那段"收到新剪贴 → 刷新 + 弹系统通知"的代码从未真正生效。第二，**删除无墓碑**：DELETE 是硬删，后端增量接口（`/api/clipboard/sync/:deviceId`、`/api/sync/pull`）都只按 `created_at` 游标拉新增，不存在删除流水；桌面端断线期间其他设备删掉的条目永远无法感知，移动端场景下这种不一致会更刺眼。第三，**无 refresh token**：生产 JWT 24 小时过期，移动端用户不可接受"每天重新扫码登录"；且 token 走 WS URL 查询串会进访问日志，每用户 5 连接上限对移动端后台策略也不友好。此外事件模型假设"客户端持有长连接才收事件"，没有任何推送（APNs/FCM）位置，移动端后台收同步通知需要另起炉灶。

## 5. 结论与建议

**明确判断：当前桌面端尚未达到转向移动端的阶段。** 理由不是功能数量不足——单机功能面已经相当完整——而是产品定义性能力"跨设备同步"的实时链路处于断裂状态，以及移动端三项硬依赖（长期会话、增量补拉含删除、离线兜底）在现有后端契约中缺失或未接通。在这个状态下开移动端，等于把一个半成品协议复制到第二个平台，之后两端都要返工。

优先补齐顺序建议如下。第一优先（移动端前置条件）：修复 WS 注册与事件名对齐（前端发 register、统一事件契约、处理 csrf 握手），让"实时同步"从兜底刷新变成真推送——这是已写好的代码，只差接通；补删除墓碑或 `deleted_since` 增量通道；引入 refresh token / 长期会话机制。第二优先（补齐核心价值）：富文本/HTML 捕获、主列表置顶（跨设备）、请求超时与 401 统一登出处理。第三优先（清理减负再上移动端）：两套文档预览裁撤一套、满意度调查改为一次性、7 主题收敛为深浅色 + 跟随系统（后者 README 本就承诺却未实现）。完成第一优先后即可启动移动端，第二优先可与移动端并行推进。

## Limitations

本报告基于静态代码审查与后端契约核对，未做长时间真机多设备实测（例如生产环境 WS 握手在 dev/生产配置差异下的实际表现、防火墙对心跳的影响）；部分被截断的子调查（导入导出、分享链接的前端消费完整度）仅依据间接证据推断。建议在修复同步链路时用两台真实设备做端到端联调验证。

## References

1. [clipboard_monitor.rs — Rust 剪贴板捕获](d:/work/java/AI-workspace/ClipSync/src/desktop/src-tauri/src/clipboard_monitor.rs)
2. [useWebSocket.ts — 前端 WS 客户端（无 register 发送）](d:/work/java/AI-workspace/ClipSync/src/desktop/src/composables/useWebSocket.ts)
3. [ws/server.js — 后端 WS 服务（register 强制 + 10s 踢出）](d:/work/java/AI-workspace/ClipSync/src/server/src/ws/server.js)
4. [HomeView.vue:204 — 前端事件名匹配点](d:/work/java/AI-workspace/ClipSync/src/desktop/src/views/HomeView.vue)
5. [clipboard.js — 后端剪贴板路由（广播 new_clipboard / 增量 sync 接口）](d:/work/java/AI-workspace/ClipSync/src/server/src/routes/clipboard.js)
6. [sync.js — 增量同步接口（仅新增游标，无删除墓碑）](d:/work/java/AI-workspace/ClipSync/src/server/src/routes/sync.js)
7. [client.ts — 前端 API 层（无超时、401 无统一处理）](d:/work/java/AI-workspace/ClipSync/src/desktop/src/api/client.ts)
8. [migrate.js — devices 表 device_type/platform 预留 mobile](d:/work/java/AI-workspace/ClipSync/src/server/src/db/migrate.js)
9. [device.js — 二维码配对 init/redeem](d:/work/java/AI-workspace/ClipSync/src/server/src/routes/device.js)
10. [cleanup.js — 过期条目定时清理](d:/work/java/AI-workspace/ClipSync/src/server/src/db/cleanup.js)
11. [useTheme.ts / globals.css — 7 主题 × 14 变量组](d:/work/java/AI-workspace/ClipSync/src/desktop/src/composables/useTheme.ts)
12. [DocumentDrawer.vue / DocPreviewModal.vue — 两套文档预览并存](d:/work/java/AI-workspace/ClipSync/src/desktop/src/components/DocumentDrawer.vue)
13. [offlineQueue.ts — 离线操作队列（200 条上限）](d:/work/java/AI-workspace/ClipSync/src/desktop/src/utils/offlineQueue.ts)
14. [useClipboard.ts — 捕获双保险/乐观更新/批量删除](d:/work/java/AI-workspace/ClipSync/src/desktop/src/composables/useClipboard.ts)
