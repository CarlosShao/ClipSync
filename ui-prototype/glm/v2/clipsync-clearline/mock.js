/* mock.js — ClipSync v2「Clearline」单一数据源（业务真实感文案，无后端） */
const DB = {
  user: { name: '沈望桥', email: 'swq@clipsync.dev', plan: 'Pro', initials: 'SW' },

  /* 页面名映射：AI dock 上下文感知读取 */
  PAGE_LABEL: {
    clipboard: '剪贴板',
    favorites: '收藏',
    templates: '模板',
    devices: '设备',
    settings: '设置',
  },
  /* 各页功能简介：AI 回答"当前页面能做什么"时使用 */
  PAGE_DESC: {
    clipboard: '查看跨设备剪贴板时间流，支持类型过滤、搜索、置顶、收藏与详情查看',
    favorites: '管理收藏合集与条目，把常用片段沉淀为可复用资产',
    templates: '维护带 {{变量}} 的文本模板，一键渲染后粘贴',
    devices: '查看在线设备、扫码配对新设备、审计同步日志',
    settings: '账号、同步、快捷键、AI 模型与系统偏好设置',
  },

  clips: [
    { id: 'c01', type: 'code',  content: `git worktree add .worktrees/trae-feature-ai-ui-refactor feature/ai-ui-refactor`, lang: 'powershell', source: 'DESKTOP-工位', time: '刚刚', pinned: true, fav: false, size: '92 B' },
    { id: 'c02', type: 'text',  content: '设计评审纪要：确认 v2 Clearline 方向——低饱和办公舒适风 + 柔和蓝主线；AI 从独立页改为全局感知 dock，任意页面可携带上下文提问。', source: 'iPhone 15 Pro', time: '4 分钟前', pinned: true, fav: true, size: '186 B' },
    { id: 'c03', type: 'link',  content: 'https://lucide.dev/icons/?search=clipboard', source: 'DESKTOP-工位', time: '12 分钟前', pinned: false, fav: false, size: '45 B', title: 'Lucide Icons · Clipboard' },
    { id: 'c04', type: 'code',  content: `const ring = document.querySelector('.ring .val')\nring.style.strokeDashoffset = 264 * (1 - pct)`, lang: 'javascript', source: 'DESKTOP-工位', time: '26 分钟前', pinned: false, fav: true, size: '118 B' },
    { id: 'c05', type: 'image', content: '设计稿截图_确认卡_v3.png', source: 'MacBook Air', time: '41 分钟前', pinned: false, fav: false, dims: '2560×1440', size: '1.8 MB', hue: 38 },
    { id: 'c06', type: 'text',  content: '收件地址：上海市杨浦区创智天地 7 号楼 3 层 · 沈望桥 · 138****6621（工作日签收）', source: 'iPhone 15 Pro', time: '1 小时前', pinned: false, fav: true, size: '74 B' },
    { id: 'c07', type: 'link',  content: 'https://v2.tauri.app/develop/', source: 'DESKTOP-工位', time: '2 小时前', pinned: false, fav: false, size: '28 B', title: 'Develop | Tauri Apps' },
    { id: 'c08', type: 'text',  content: '老板，后端 Package C 的确认门控已经合了，前端 AiConfirmCard 的 SSE 接缝记得接 onMeta。', source: 'MacBook Air', time: '3 小时前', pinned: false, fav: false, size: '88 B' },
    { id: 'c09', type: 'file',  content: 'clipsync-redesign-assets.zip', source: 'DESKTOP-工位', time: '昨天 18:42', pinned: false, fav: false, size: '4.6 MB', archived: true },
    { id: 'c10', type: 'code',  content: `await clip.copyItem(item)\nwindow.close() // QuickPaste 选择后回冲并关闭`, lang: 'javascript', source: 'DESKTOP-工位', time: '昨天 17:15', pinned: false, fav: false, size: '96 B' },
    { id: 'c11', type: 'text',  content: '周报素材：本周完成 AI 前端 UI-A~G 七个工作包；修复 E 盘 MSVC 工具链盘符残留；桌面端编译链路全绿。', source: 'iPhone 15 Pro', time: '昨天 11:03', pinned: false, fav: true, size: '112 B' },
    { id: 'c12', type: 'image', content: '白板草图_三栏Shell.jpg', source: 'iPhone 15 Pro', time: '昨天 09:28', pinned: false, fav: false, dims: '3024×4032', size: '2.4 MB', hue: 210, archived: true },
    { id: 'c13', type: 'link',  content: 'https://github.com/nicholasgasior/ipc-benchmarks', source: 'MacBook Air', time: '周三 21:07', pinned: false, fav: false, size: '48 B', title: 'IPC benchmarks' },
    { id: 'c14', type: 'text',  content: '快递取件码 8-3-4417，今天 20:00 前驿站关门。', source: 'iPhone 15 Pro', time: '周三 16:55', pinned: false, fav: false, size: '38 B', archived: true },
  ],

  /* 合集：树形层级（对齐真实系统 ltree path/depth/sort_order），children 为子收藏夹 */
  collections: [
    { id: 'work', name: '工作片段', icon: 'folder', count: 3, children: [
      { id: 'work-meeting', name: '会议纪要', icon: 'file-text', count: 2 },
      { id: 'work-review', name: '评审回复', icon: 'message-square', count: 1 },
    ]},
    { id: 'addr', name: '地址与证件', icon: 'user', count: 2 },
    { id: 'snip', name: '代码速记', icon: 'code-2', count: 3 },
  ],
  /* 全局标签（含颜色，对齐真实系统 setItemTags(tags, tagColors)） */
  favTags: [
    { name: '会议', color: '#3A6BE0' },
    { name: '纪要', color: '#6E93FF' },
    { name: '地址', color: '#D97706' },
    { name: '代码', color: '#0D9488' },
    { name: '周报', color: '#D94A3A' },
  ],
  favItems: [
    { id: 'f01', cid: 'work-meeting', type: 'text', content: '设计评审纪要：确认 v2 Clearline 方向——低饱和办公舒适风 + 柔和蓝主线…', time: '4 分钟前', source: 'iPhone 15 Pro', tags: ['会议', '纪要'], sensitive: false },
    { id: 'f02', cid: 'snip', type: 'code', content: `const ring = document.querySelector('.ring .val')\nring.style.strokeDashoffset = 264 * (1 - pct)`, time: '26 分钟前', source: 'DESKTOP-工位', lang: 'javascript', tags: ['代码'], sensitive: false },
    { id: 'f03', cid: 'addr', type: 'text', content: '收件地址：上海市杨浦区创智天地 7 号楼 3 层 · 沈望桥 · 138****6621', time: '1 小时前', source: 'iPhone 15 Pro', tags: ['地址'], sensitive: true },
    { id: 'f04', cid: 'work', type: 'text', content: '周报素材：本周完成 AI 前端七个工作包；修复 E 盘 MSVC 工具链盘符残留…', time: '昨天 11:03', source: 'iPhone 15 Pro', tags: ['周报'], sensitive: false },
    { id: 'f05', cid: 'snip', type: 'code', content: `await clip.copyItem(item)\nwindow.close()`, time: '昨天 17:15', source: 'DESKTOP-工位', lang: 'javascript', tags: ['代码'], sensitive: false },
    { id: 'f06', cid: 'work-meeting', type: 'text', content: '周会结论：移动端优先保证剪贴板 + 收藏两模块体验，AI 面板走全局 dock 架构。', time: '昨天 16:20', source: 'MacBook Air', tags: ['会议'], sensitive: false },
    { id: 'f07', cid: 'work-review', type: 'text', content: 'CR 回复定稿：LGTM after fix —— 补充边界单测后即可合入。', time: '周三 15:44', source: 'DESKTOP-工位', tags: [], sensitive: false },
    { id: 'f08', cid: 'snip', type: 'code', content: `docker compose -f docker-compose.dev.yml up -d api`, time: '周三 10:02', source: 'DESKTOP-工位', lang: 'bash', tags: ['代码'], sensitive: false },
  ],

  templates: [
    { id: 't1', title: '会议纪要骨架', tag: '工作', usage: 47, updated: '2 天前',
      body: '## {{会议主题}}\\n日期：{{date}}\\n参会：{{参会人}}\\n\\n### 结论\\n- \\n\\n### 行动项\\n- [ ] {{行动项}} — {{负责人}}' },
    { id: 't2', title: 'Code Review 回复', tag: '研发', usage: 31, updated: '5 天前',
      body: '感谢提交！整体 OK，几点建议：\\n1. {{建议}}\\n2. 单测覆盖 {{模块}} 的边界情况\\n\\nLGTM after fix.' },
    { id: 't3', title: 'Bug 上报模板', tag: '研发', usage: 28, updated: '1 周前',
      body: '【环境】{{os}} / {{version}}\\n【复现】1. \\n2. \\n【期望】\\n【实际】\\n【日志】```\\n{{log}}\\n```' },
    { id: 't4', title: '周报段落', tag: '工作', usage: 19, updated: '1 周前',
      body: '本周完成：{{完成项}}\\n进行中：{{进行中}}\\n风险与依赖：{{风险}}\\n下周计划：{{计划}}' },
    { id: 't5', title: '快递取件', tag: '生活', usage: 12, updated: '2 周前',
      body: '取件码 {{取件码}}，{{驿站}}，{{截止时间}} 前取。' },
    { id: 't6', title: '请假申请', tag: '行政', usage: 6, updated: '3 周前',
      body: '{{主管}} 好，因 {{事由}} 申请 {{date}} 请假 {{时长}}，工作已交接 {{同事}}，紧急事项可电话联系。' },
  ],

  devices: [
    { id: 'd1', name: 'DESKTOP-工位', kind: 'desktop', os: 'Windows 11 24H2', status: 'online', self: true, lastSync: '本机', ip: '192.168.31.10' },
    { id: 'd2', name: 'MacBook Air', kind: 'laptop', os: 'macOS 15.4', status: 'online', self: false, lastSync: '8 秒前', ip: '192.168.31.22' },
    { id: 'd3', name: 'iPhone 15 Pro', kind: 'phone', os: 'iOS 19.1', status: 'online', self: false, lastSync: '32 秒前', ip: '192.168.31.35' },
    { id: 'd4', name: '旧 ThinkPad', kind: 'laptop', os: 'Windows 10 22H2', status: 'offline', self: false, lastSync: '3 天前', ip: '—' },
  ],
  syncLog: [
    { id: 's1', time: '刚刚', dir: 'down', summary: '文本 · 92 B', device: 'DESKTOP-工位' },
    { id: 's2', time: '4 分钟前', dir: 'down', summary: '文本 · 186 B', device: 'iPhone 15 Pro' },
    { id: 's3', time: '41 分钟前', dir: 'down', summary: '图片 · 1.8 MB', device: 'MacBook Air' },
    { id: 's4', time: '1 小时前', dir: 'up', summary: '收藏状态同步', device: '云端' },
    { id: 's5', time: '3 小时前', dir: 'down', summary: '文本 · 88 B', device: 'MacBook Air' },
    { id: 's6', time: '昨天 18:42', dir: 'up', summary: '文件 · 4.6 MB', device: 'DESKTOP-工位' },
  ],

  convos: [
    { id: 'v1', title: '总结报错日志为修复步骤', model: 'GPT-5.2', time: '10:24', count: 6 },
    { id: 'v2', title: '把地址整理成 JSON', model: 'GPT-5.2', time: '昨天', count: 4 },
    { id: 'v3', title: '周报润色（第 3 版）', model: 'Claude 4.5', time: '昨天', count: 9 },
    { id: 'v4', title: 'Rust 链接器报错排查', model: 'GPT-5.2', time: '周三', count: 12 },
  ],
  messages: {
    v1: [
      { role: 'user', text: '帮我把这段日志整理成可执行的修复步骤：', quote: 'error: linker `link.exe` not found · note: the msvc targets depend on the msvc linker…' },
      { role: 'ai', think: '用户在 Windows 上编译 Rust/Tauri 失败。根因是 cargo 找不到 MSVC 链接器。需要：①确认 VS Build Tools 是否安装；②装好后用 vcvars64 注入环境，或修复注册表盘符；③验证 cargo build。', tools: [
        { icon: 'terminal', name: 'check_msvc_toolchain', state: 'done', tt: '1.2s' },
        { icon: 'file-text', name: 'read_file · Cargo.toml', state: 'done', tt: '0.3s' },
        { icon: 'wrench', name: 'write_file · 修复环境变量', state: 'wait', tt: '等待确认' },
      ],
      confirm: { id: 'cf1', tool: 'write_file', impact: '修改系统环境变量 PATH / LIB / INCLUDE，指向 E:\\soft_home 下的 MSVC 工具链', args: '{ "target": "user-env", "keys": ["PATH","LIB","INCLUDE"], "prefix": "E:\\\\soft_home\\\\VisualStudio\\\\BuildTools\\\\VC\\\\Tools\\\\MSVC\\\\14.51.36231" }' },
      html: '<p>根因：<b>机器换盘后注册表仍指向 F 盘</b>，MSVC 工具链实际在 <code>E:\\soft_home</code>。修复分三步：</p><ol><li>修正注册表残留（Setup 的 CachePath / SharedInstallationPath、卸载项 InstallLocation）；</li><li>在当前会话注入 <code>vcvars64.bat</code> 等效环境变量；</li><li>执行 <code>cargo build</code> 验证链接。</li></ol><p>第 2 步涉及写操作，需要你在上方确认卡里批准。</p>' },
    ],
    v2: [ { role: 'user', text: '把这条地址整理成 JSON：上海市杨浦区创智天地 7 号楼 3 层，沈望桥，138****6621' },
          { role: 'ai', html: '<p>已整理：</p><pre><code>{\n  "name": "沈望桥",\n  "phone": "138****6621",\n  "address": "上海市杨浦区创智天地 7 号楼 3 层"\n}</code></pre>' } ],
    v3: [ { role: 'user', text: '周报第三段语气再干练一点' }, { role: 'ai', html: '<p>已压缩为结果导向的三句：本周交付 AI 前端七个工作包；修复编译链路阻塞；下周联调确认门控。</p>' } ],
    v4: [ { role: 'user', text: 'link.exe not found 怎么破' }, { role: 'ai', html: '<p>见当前对话的修复步骤——已在 v1 中给出完整方案。</p>' } ],
  },
  usage: { used: 18400, total: 32000, cacheHit: 62, cost: 0.42, model: 'GPT-5.2', ctx: '57%' },

  /* Agent 流演示脚本：dock 内非"页面感知"提问走这条完整流水线
     （thinking 流入 → 工具时间线 → 破坏性工具确认门控 → 封段再思考 → 正文 → 过程 chips），
     对齐真实系统 useAiChat 的 SSE 事件序：thinking → tool_call → confirm_tool_action → thinking → content */
  agentDemo: {
    thinking1: '用户想处理当前页面的内容。先读取选中条目的上下文，判断类型与可用工具，再决定执行路径。',
    tools: [
      { icon: 'clipboard-list', name: 'read_clipboard_context', tt: '0.4s', confirm: false },
      { icon: 'file-text', name: 'analyze_content · 类型识别与摘要', tt: '1.1s', confirm: false },
      { icon: 'wrench', name: 'write_file · 写入处理结果', tt: '0.6s', confirm: true,
        impact: '向工作区写入处理结果文件 result.md（写操作，按安全策略需批准后执行）',
        args: '{ "path": "result.md", "bytes": 2048, "overwrite": false }' },
    ],
    thinking2: '前两步已完成：拿到上下文并完成内容分析。第三步是写操作，等待用户批准；批准后执行并汇总结果。',
    answer: '处理完成：这条内容属于「工作纪要」类，已生成摘要并建议归档到收藏夹「工作片段 / 会议纪要」，打上「会议」标签。写文件操作已按你的选择处理。',
  },
  memories: [
    { id: 'm1', key: '偏好', value: '沟通使用中文；喜欢一键脚本化解决方案', updated: '09-08' },
    { id: 'm2', key: '环境', value: 'MSVC 工具链位于 E:\\soft_home（原 F 盘迁移）', updated: '09-12' },
    { id: 'm3', key: '项目', value: 'ClipSync 前端重构基线分支 feature/ai-ui-refactor', updated: '09-11' },
  ],

  notifications: [
    { id: 'n1', kind: 'sync', title: 'iPhone 15 Pro 已连接', desc: '局域网加密通道建立，延迟 12ms', time: '2 分钟前', read: false },
    { id: 'n2', kind: 'ai', title: 'AI 任务完成', desc: '「总结报错日志」已生成 3 步修复方案', time: '18 分钟前', read: false },
    { id: 'n3', kind: 'sys', title: 'v0.4.3 可用', desc: '包含 QuickPaste 性能优化，重启后更新', time: '2 小时前', read: true },
    { id: 'n4', kind: 'sync', title: '旧 ThinkPad 离线超 72h', desc: '如不再使用可在设备页移除', time: '昨天', read: true },
  ],
};
