/**
 * ClipSync AI 大管家 —— 项目元知识库
 *
 * 这些函数返回「关于 ClipSync 这个项目本身」的结构化知识，供 AI 工具调用后转述给用户。
 * 内容都是静态、可公开给已登录用户的产品/工程知识（不含密钥、不含未公开的内网信息）。
 * 让 Agent 成为一个真正了解本应用的功能、隐私模型、如何启动与部署的「统筹大管家」。
 */

const FEATURES = {
  clipboard_sync: {
    title: '剪贴板同步',
    summary: '跨设备实时同步文本/图片/文件/链接/代码，本地监控 + 服务端中转。',
    details:
      '桌面端通过系统剪贴板事件（Windows 的 WM_CLIPBOARDUPDATE + 序列号轮询）捕获变更，' +
      '去重后加密上传到服务端，再由 WebSocket 推送到其它已登录设备。' +
      '图片/文件按内容哈希去重，避免重复上传；大体积内容走分块上传。',
  },
  favorites: {
    title: '收藏',
    summary: '把重要条目标记为收藏（is_favorite），可跨设备长期保留。',
    details: '收藏项不会被自动清理策略删除；可结合收藏夹进行分类管理。',
  },
  collections: {
    title: '收藏夹',
    summary: '树形收藏夹，对收藏项做分类归档（favorite_collections / favorite_collection_items）。',
    details: '支持嵌套路径、拖拽整理；每个收藏夹显示条目计数。',
  },
  templates: {
    title: '快捷模板',
    summary: '预设常用文本片段，支持 {{变量}} 占位符，一键粘贴。',
    details: '模板可绑定快捷键；变量分「局部（每次手填）」与「全局（预设默认值，可记住上次输入）」两种。',
  },
  template_variables: {
    title: '模板全局变量',
    summary: '全局变量（如 {{name}}、{{email}}），插入模板时自动预填。',
    details: '变量按 (user_id, name) 隔离持久化；解析在前端完成，后端只存 name→value。',
  },
  shared_links: {
    title: '共享链接',
    summary: '把某条剪贴板内容生成公开链接，他人可凭访问码查看/下载。',
    details: '可设置有效期（expires_at）；链接内容服务端加密存储，公开页面走独立路由。',
  },
  devices_pairing: {
    title: '设备配对',
    summary: '扫码 / 配对码把多台设备加入同一账号，实时互相同步。',
    details: '配对分 init（生成码）与 redeem（兑换）两步；新设备上线会推送 device_online 通知。',
  },
  subscriptions_plans: {
    title: '订阅与套餐',
    summary: '免费 / Pro / 企业三档，限制设备数、历史条数、单文件大小、总存储。',
    details: '套餐定义在 subscription_plans，用户的生效套餐在 user_subscriptions（status=active）。',
  },
  security_2fa: {
    title: '两步验证 (2FA)',
    summary: '账号可开启 TOTP 两步验证，登录时额外校验动态码。',
    details: '2FA 状态在 users.two_factor_enabled；开启后登录流程会出现 challenge。',
  },
  item_protection: {
    title: '条目密码保护',
    summary: '单条剪贴板可设 PIN 或高级密码保护，保护敏感内容。',
    details:
      'protection_level 有三种：none / pin / advanced。' +
      'pin 仅控制客户端展示，服务端内容仍可被解密；' +
      'advanced 用独立 DEK 二次加密，DEK 由用户密码（及恢复密钥）包裹，' +
      '服务端无密码无法还原明文——这就是 AI 需要你提供密码才能读出明文的原因。',
  },
  notifications: {
    title: '通知',
    summary: '设备上线、异地登录、订阅变更等事件推送站内通知。',
    details: '通知落 notification_history（服务端持久化），前端经 WebSocket 实时接收并显示未读角标。',
  },
  ai_agent: {
    title: 'AI 大管家（本功能）',
    summary: '内置 AI 助手，可查阅你的数据、执行整理操作、解释产品与工程细节。',
    details:
      'Agent 默认只能看到元数据（类型/预览/大小/时间），读取完整明文需显式调用 read_clip_content；' +
      '高级密码保护的条目必须你提供密码才可解密。Agent 还能讲解功能、隐私模型、如何启动与部署。',
  },
  archive: {
    title: '归档',
    summary: '把不再常用但不想删除的条目归档（archived=true），从主列表隐藏。',
    details: '归档项可随时恢复或彻底删除；统计中单独计数。',
  },
  search_filters: {
    title: '搜索与筛选',
    summary: '按关键词、类型（文本/图片/文件/链接/代码）、收藏、标签、设备多维筛选。',
    details: '搜索在服务端按 content / content_preview 做 ILIKE 模糊匹配；列表默认 limit=50 分页。',
  },
  encryption_model: {
    title: '加密与隐私模型',
    summary: '服务端静态加密 + 本地条目隔离 + 条目级高级密码。',
    details:
      '普通条目：content_encrypted 由服务端主密钥（ENCRYPTION_KEY）做 AES-256-GCM 静态加密，' +
      '服务端可解密用于同步；本地条目（local-/text-/img- 临时 ID）内容根本不上传服务端，AI 无法读取。' +
      '高级密码保护条目：用独立 DEK 加密，必须用户密码/恢复密钥才能还原。',
  },
}

export function getFeatureDoc(feature) {
  if (feature && FEATURES[feature]) {
    const f = FEATURES[feature]
    return `## ${f.title}\n${f.summary}\n\n${f.details}`
  }
  const list = Object.entries(FEATURES)
    .map(([k, v]) => `- ${k}：${v.title} —— ${v.summary}`)
    .join('\n')
  return (
    'ClipSync 主要功能清单（调用 explain_feature 并传入对应 key 可查看详情）：\n\n' + list
  )
}

export function getPrivacyModelDoc() {
  return [
    '## ClipSync 数据隐私与加密模型',
    '',
    '**1. 服务端静态加密（普通条目）**',
    '所有同步到服务端的剪贴板内容都以 `content_encrypted` 存储，使用服务端主密钥（环境变量 `ENCRYPTION_KEY`，AES-256-GCM）加密。',
    '服务端本身持有主密钥，因此可为同步/AI 读取等用途解密。这属于「传输与存储加密」，不是「只有用户本人能解」。',
    '',
    '**2. 本地条目（AI 读不到）**',
    '仅存在于你本机的剪贴板条目使用 `local-` / `text-` / `img-` 这类临时 ID，**不会上传到服务端**。',
    '这类内容 AI 无法读取——遇到时它会明确告诉你「这是本地条目，请在应用内查看」。',
    '',
    '**3. 高级密码保护（advanced）**',
    '条目可开启高级密码保护：内容用独立的 DEK 二次加密，DEK 由你的密码（及恢复密钥）包裹存储。',
    '**服务端没有你的密码，无法还原这类明文**。当你向 AI 提供正确密码（或恢复密钥）时，AI 才能解密读出。',
    'PIN 保护（pin）仅控制客户端展示，服务端内容仍可被解密。',
    '',
    '**4. AI 能 / 不能做什么**',
    '- 能：查看所有条目的元数据（类型、预览、大小、时间、收藏/归档状态、来源设备）。',
    '- 能（需你授权/提供密码）：读取普通条目与 pin 条目的完整明文；读取 advanced 条目的明文（需密码）。',
    '- 不能：读取未上传服务端的本地条目内容；在不知道密码的情况下还原 advanced 受保护明文。',
    '',
    '**5. 如何查看明文**',
    '- 在应用内：直接点开条目，受保护条目走解锁流程（密码或恢复密钥）。',
    '- 通过 AI：让 AI 调用 read_clip_content 并提供密码（高级保护条目），或直接说「帮我看这条内容」。',
    '',
    '**6. 其它隐私控制**',
    '- 两步验证（2FA）保护账号登录；异地登录会推送安全告警。',
    '- 数据可按规定导出（GDPR 类导出）；注销/删除会级联清理该用户数据。',
  ].join('\n')
}

export function getDeploymentDoc() {
  return [
    '## ClipSync 如何启动与部署',
    '',
    '**一、本地开发（dev）**',
    '1. 依赖：Node.js（建议 20+）、Rust 工具链（cargo，Tauri 需要）、PostgreSQL、Redis。',
    '2. 启动后端：项目用 docker-compose（dev 配置）拉起 server + PostgreSQL + Redis；',
    '   源码通过 `./src/server/src:/app/src:ro` 挂载，改完后端代码重启容器即生效。',
    '   后端监听 `0.0.0.0:3001`。',
    '3. 启动桌面端：在 `src/desktop` 执行 `npm install` 后 `npm run dev`（Vite 热更新）；',
    '   若要跑进 Tauri 原生窗口用 `npm run tauri dev`。',
    '4. 开发拓扑：桌面端在 dev 下**直连 `http://localhost:3001`**，不经过 nginx；',
    '   关键环境变量 `ENCRYPTION_KEY`（生产必须设置且 ≥32 字符，禁止用默认值）。',
    '',
    '**二、构建与打包**',
    '- 桌面端：`npm run tauri build` 产出各平台安装包（Windows 为 .msi/.exe）。',
    '- 后端：以 Node 服务运行，配合 nginx 反向代理（生产环境）。',
    '',
    '**三、生产部署要点**',
    '- 必须设置强 `ENCRYPTION_KEY`，否则启动时直接 fatal 退出。',
    '- `ENCRYPTION_IV` 建议显式设置（12 字节）；RSA 密钥用于密钥分发场景。',
    '- nginx 需配置 `client_max_body_size`（文件上传上限）、SSE 不透传 gzip 缓冲、',
    '  `X-Accel-Buffering: no` 以保证 AI 流式响应不被缓冲。',
    '- 限流、审计、连接池、通知保留期等已在服务端做加固（SYSTEM_AUDIT 记录）。',
    '',
    '**四、常见排查**',
    '- AI 思考「卡一下再蹦出来」：先查服务端 aiChat 路由是否因 SSE 写入已结束的流而崩溃（ERR_STREAM_WRITE_AFTER_END）；',
    '  已通过 safeFinish 幂等关闭修复。',
    '- 上游模型超时：默认 180s 整体超时保护。',
  ].join('\n')
}

export function getArchitectureDoc() {
  return [
    '## ClipSync 技术架构',
    '',
    '**客户端（桌面端）**',
    '- Tauri v2（Rust 壳）+ Vue 3 + Vite 5 + TypeScript + Tailwind CSS v4 + Pinia。',
    '- UI 组件：shadcn-vue（基于 reka-ui）；图标 lucide-vue-next。',
    '- 剪贴板监控在 Rust 侧：事件驱动 + 序列号轮询去重，PNG 编码放独立线程，',
    '  大图走事件总线只传哈希，字节存本地缓存由前端按需拉取。',
    '',
    '**服务端**',
    '- Express 5（Node.js）+ PostgreSQL + Redis。',
    '- 路由按域划分：auth / clipboard / devices / favorites / templates / sharedLinks /',
    '  protection / notifications / ai 等。',
    '- AI 代理：`/api/ai/chat` 做 SSE 流式代理，支持多轮 tool calling；',
    '  工具定义在 `routes/aiTools.js`，执行时携带 `req.userId` 做数据隔离。',
    '- 加密：`utils/encryption.js`（主密钥静态加密）、`utils/protectionCrypto.js`（条目级 DEK）。',
    '',
    '**实时与同步**',
    '- WebSocket（经 Redis Pub/Sub 支持多实例）推送剪贴板变更、通知、设备状态。',
    '- 设备配对：init → redeem 两步；CSRF token 持久化在 localStorage（5 分钟过期）。',
  ].join('\n')
}

export default { getFeatureDoc, getPrivacyModelDoc, getDeploymentDoc, getArchitectureDoc, FEATURES }
