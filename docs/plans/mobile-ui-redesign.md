# ClipSync 移动端 UI 深度重构 — 落地方案

> **版本**：v2.0 设计系统（代号 "Obsidian"）
> **性质**：UI 全推翻重构——逻辑层（Provider/Service/API）零改动，视觉层 100% 重写
> **分支**：`feature/mobile-ui-v2`（基于 `feature/mobile-v1.1-debug`）
> **参照**：Raycast（信息架构）/ Paste（卡片语义）/ 1Password Knox（安全语义）/ Linear mobile（分层材质与动效）/ Gboard（剪贴板心智）

---

## 一、设计定位

**专业效率为骨、消费级质感为皮。**

- **骨**：单列密集流、搜索即导航、行级密度 56-64dp、类型 leading 图标区分——效率工具黄金标准（Raycast 模式）
- **皮**：M3E tonal 色彩层级 + 28dp 大圆角弹层 + spring 物理动效 + 等宽字体安全语义——高端消费级质感
- **红线**：不堆装饰、不牺牲密度、不做玩具感 expressive 形状

**品牌紫 #5A4BD1 只做强调**（主按钮/选中/焦点），不参与类型识别。暗色是默认设计起点（先暗后亮）。

---

## 二、现状问题清单（真机验收实证）

| # | 问题 | 位置 | 根因 |
|---|---|---|---|
| 1 | 卡片扁平无层次，与设置页视觉无区分度 | 全列表 | 0 阴影+1px 描边在亮暗模式都是"纸片"，无 tonal 层级 |
| 2 | 类型区分仅靠小色块+文字标签，扫读效率低 | clipboard_card | 缺类型专属预览形态（链接无富卡、图片无缩略、代码无等宽） |
| 3 | 底部导航是 M2 惯性，无视觉锚点 | NavigationBar | 无指示器强调、无中央操作入口 |
| 4 | 搜索/筛选折叠过深，核心动作（复制）不突出 | clipboard_screen | 操作藏在 ⋮ 菜单里 |
| 5 | 弹层/对话框 16dp 圆角显旧 | dialog/bottomsheet | M3E 标准 28dp |
| 6 | 动效全部固定曲线，无物理感 | 全局 | AppDurations 固定时长无 spring |
| 7 | 密码保护条目无安全语义（仅文本标记） | clipboard_card/detail | 缺等宽字体+遮罩+锁形语义 |
| 8 | 登录/锁屏/onboarding 视觉单薄 | auth 页 | 纯表单堆叠，无品牌表达 |
| 9 | 英文环境下大量中文硬编码残留 | 多页面 | i18n 只接了骨架（417 key 但页面级未覆盖完） |
| 10 | 设备 tab 密度低、信息层级平 | devices | 设备/会话两组内容无视觉分组 |

---

## 三、设计系统 v2 "Obsidian" — Token 定义

### 3.1 色彩体系

```
品牌种子：#5A4BD1（不变）

新增 Token（app_colors_v2.dart）：
├── 表面层级（tonal，替代阴影——暗色优先设计）
│   ├── surfaceBase      : fromSeed surface          (#FAFAFA / #0E0E10)
│   ├── surfaceLow       : surfaceContainerLow       (卡片底色)
│   ├── surfaceMid       : surfaceContainer          (浮层/弹层)
│   ├── surfaceHigh      : surfaceContainerHigh      (悬浮控件/选中底)
│   └── surfaceHighest   : surfaceContainerHighest   (最高强调面)
├── 类型识别色（fixed，6 色，不随 seed 变——paste/收藏板颜色编码模式）
│   ├── typeText    : #7C6FE8 (紫，品牌延伸)  / dark: #A78BFA
│   ├── typeLink    : #0EA5E9 (天蓝)           / dark: #38BDF8
│   ├── typeImage   : #F59E0B (琥珀)           / dark: #FBBF24
│   ├── typeFile    : #EC4899 (粉红)           / dark: #F472B6
│   ├── typeColor   : #14B8A6 (青绿)           / dark: #2DD4BF
│   └── typeCode    : #64748B (石墨)           / dark: #94A3B8
├── 安全语义（1Password Knox 模式）
│   ├── secureContainer : surfaceContainerLow + 锁图标（不透明，防偷窥）
│   ├── secureAccent    : #64748B (石墨——安全态不用品牌紫)
│   └── danger          : #DC2626 / dark: #F87171（仅真实错误）
└── 动效强调
    └── syncGlow : 品牌紫 12% 透明（同步完成脉冲动画用）
```

### 3.2 形状体系（M3E corner scale）

```
shapeScale:
├── xs  : 8   （Chip、小徽章、骨架块）
├── sm  : 12  （按钮、输入框、嵌入缩略图）
├── md  : 16  （标准卡片、列表项容器）
├── lg  : 20  （大卡片、NavigationBar 指示器）★ 新增
├── xl  : 28  （对话框、底部弹层、全屏 sheet）★ 新增（M3E extra-large）
└── pill: 999 （FAB、类型徽章、搜索栏）
```

### 3.3 字体体系

```
字族：
├── 默认：系统栈（Roboto/苹方/微软雅黑）——CJK 标题 letterSpacing=0
└── mono：JetBrains Mono（密码/代码/颜色值/路径专用）——1Password 语义

阶梯（对齐 M3 type scale + CJK 修正）：
├── displaySmall  : 36/44  w700  （onboarding 大标题、空状态锚点）★ 新增
├── headlineSmall : 24/32  w600  （页面大标题）
├── titleLarge    : 20/28  w600  （区块标题）
├── titleMedium   : 16/24  w600  （卡片标题）
├── bodyLarge     : 16/24  w400  （正文展开）
├── bodyMedium    : 14/20  w400  （列表主文本）
├── bodySmall     : 12/16  w400  （元数据、来源设备）
└── labelSmall    : 11/16  w500  （徽章、时间戳）
```

### 3.4 动效体系（M3E spring 物理动效）

```
EasingToken（替换固定曲线）：
├── emphasized    : Cubic(0.2, 0.0, 0.0, 1.0)   （位移类默认）
├── decelerateE   : Cubic(0.05, 0.7, 0.1, 1.0)   （入场）
├── accelerateE   : Cubic(0.3, 0.0, 0.8, 0.15)   （出场）
└── spring        : SpringDescription(damping: 1.0, stiffness: 400)（swipe/微交互）
    └── springBouncy : damping: 0.65（庆祝时刻，如"已同步"脉冲——克制使用）

时长体系（重构）：
├── micro   : 100ms  （色彩/透明度切换）
├── fast    : 150ms  （按压反馈）
├── normal  : 200ms  （选中态）
├── slow    : 350ms  （面板出入场）★ 从 250 上调
└── morph   : 450ms  （容器变换、大面板）★ 新增
```

### 3.5 Elevation 体系

```
0dp   : 基础屏（列表、设置）——纯 tonal 面 + 1px 辅助描边
0dp   : 卡片（surfaceContainerLow 底色已是层级）
3dp   : 浮动控件（FAB、悬浮工具条、拖拽中的卡片）
6dp   : 弹出菜单、下拉浮层
```

---

## 四、组件体系 v2

### 4.1 重写组件（6 个）

| 组件 | 变更 | 关键设计 |
|---|---|---|
| **AppCard v2** | 新增 `elevation`/`surfaceTier`/`gradient` 参数 | 支持三级 surface（Low/Mid/High）+ 可选类型色渐变顶边（1px 高亮线，Paste 模式） |
| **ClipboardCard v2** | 全重写（核心卡片） | 见 5.2 详规 |
| **EmptyState v2** | displaySmall 大图标 + spring 入场 | 支持 illustration 变体（剪贴板/设备/收藏各自专属图标+色彩） |
| **ErrorState v2** | 重试按钮改 FilledButton.tonal + 错误码透出 | en/zh 双语文案经 l10n |
| **SkeletonList v2** | 骨架块加 shimmer 微光（M3E loading indicator 语义） | 替换纯灰块 |
| **SyncPulseIndicator** | 新建：同步完成时品牌紫 12% 脉冲一次（syncGlow） | 300ms，一次性，克制 |

### 4.2 新建组件（8 个）

| 组件 | 用途 | 设计要点 |
|---|---|---|
| **TypeBadge** | 统一类型徽章（6 色系） | pill 形 + leading icon + 语义色，替代散落的色块代码 |
| **MonoText** | 等宽文本（密码/代码/路径） | JetBrains Mono，安全条目遮罩态专用 |
| **GlassPanel** | 毛玻璃浮层容器 | BackdropFilter blur(24) + 白 8% 描边，仅用于浮层/快捷面板 |
| **SwipeActionRow** | 列表条目滑动手势 | 右滑=收藏（品牌紫）、左滑=删除（error 红）、松手 spring 回弹 |
| **DeviceChip** | 来源设备标识 | leading 设备类型 icon + 设备名 + 在线状态点 |
| **SectionDivider** | 区块分隔（tonal） | 左侧标签文字 + 右侧渐隐线（Notion/Linear 模式） |
| **Breadcrumb** | 收藏夹树形路径导航 | pill 分段，当前级加粗 |
| **QuickPasteDock** | 底部常驻快速粘贴 dock | 3-5 个最近条目横滑 Chips（Gboard 模式），点击即复制 |

---

## 五、逐页面重构规格

### 5.1 登录页 (`login_screen.dart` → 重写)

```
布局（竖直居中，含品牌区）：
├── 品牌区：ClipSync 字标（logo 32dp + displaySmall 品牌名）
│   └── 背景：品牌紫 8%→0% 垂直渐变（不遮内容）
├── 表单区：手机号（OutlinedTextInput 圆角 12）
│          验证码（行内：输入框 + 「获取验证码」TextButton，60s 倒计时）
│          [2FA] 6 位动态码（居中，等宽字体，光标自动前进）
│          登录按钮（FilledButton，全宽 56dp 高）
├── 分隔线「或」（左右渐隐线）
├── 密码登录入口（TextButton 切换）
├── 底部：服务状态点（syncGlow 绿=在线）+ 服务器地址配置入口
└── 键盘适配：resizeToAvoidBottomInset，表单区 SingleChildScrollView
```

### 5.2 锁屏 (`lock_screen.dart` → 重写)

```
├── 全屏品牌紫 4%→12% 渐变（锁定语义：视觉上"上锁"）
├── 居中：锁形大图标（96dp，app_lock 语义色）
├── 「应用已锁定」headlineSmall
├── 「验证身份以继续」bodyMedium
├── 解锁按钮（FilledButton.tonal 图标+文字，spring 按压）
└── 验证失败：error 红 inline 提示 + spring shake（水平 ±8dp × 3）
```

### 5.3 首页/剪贴板流 (`clipboard_screen.dart` → 重构)

```
├── SliverAppBar（大标题模式）：
│   ├── collapsed：搜索栏 + 筛选 chips（横滑，含 Filters 徽标 chip）
│   └── expanded：「Clipboard」displaySmall + 最后同步时间（syncGlow 点）
├── 列表主体（单列，行高 72dp）：
│   └── ClipboardCard v2：
│       ├── leading 44dp：类型专属预览
│       │   ├── text → 2 行文本预览（bodyMedium，首行加粗）
│       │   ├── link → 富链接卡（favicon + 域名 + 标题）
│       │   ├── image → 48dp 缩略图（cached_network_image，圆角 sm）
│       │   ├── file → 类型图标 + 文件名 + 大小
│       │   └── code → MonoText 等宽预览
│       ├── title：类型徽章 TypeBadge + 来源设备 DeviceChip + 相对时间
│       ├── subtitle：内容预览 2 行省略
│       ├── trailing：时间戳 + ⋮ 菜单
│       └── swipe：SwipeActionRow（右收藏/左删除）
├── 置顶区：置顶条目独立分组在列表顶部（SectionDivider「Pinned」）
├── 底部：QuickPasteDock（最近 3 条，点击即复制）
├── 新内容浮条：毛玻璃 GlassPanel（替代纯黑胶囊）
└── 空态：EmptyState v2 + 「去桌面端复制第一条内容」引导
```

### 5.4 详情页 (`item_detail_screen.dart` → 重构)

```
├── AppBar：返回 + 类型 TypeBadge + 时间 + ⋮（分享/收藏/删除/更多）
├── 内容区（按类型）：
│   ├── image → PhotoView（沉浸式：AppBar 自动隐藏，黑底）
│   ├── file → 文件卡片（图标+名称+大小+类型+下载进度条）
│   ├── text/link → 全文（SelectionArea）+ 字数统计
│   └── code → MonoText + 语法高亮（可选，依赖已删需重加）
├── 元数据区：来源设备/创建时间/大小/标签 chips（可编辑）
├── 操作栏：复制（FilledButton 主）+ 分享 + 收藏 + 删除（icon row）
└── 受保护条目：MonoText 遮罩 → 解锁按钮 → 密码对话框 → 揭示动画
```

### 5.5 收藏夹 (`favorites_screen.dart` → 树形导航重设计)

```
├── 根页：顶层分组卡片列表
│   ├── 卡片：类型色圆标（paste pinboard 模式：分组可自定义颜色）+
│   │         名称 + 「N items · M folders」+ ⋮ 菜单
│   └── 点击 → 推入子层（下钻），非压栈
├── 子层页：面包屑 Breadcrumb + 子分组区 + 条目区（两段式）
│   └── ReorderableListView 保留
├── 新建：FAB → BottomSheet（名称 + 图标选择 + 颜色选择 + 父级显示）
└── 视觉：分组圆标用**分组专属色**（用户可选或按名称 hash 派生——Paste 模式）
```

### 5.6 设备页 (`home_screen devices tab` → 重构)

```
├── 设备区：DeviceCard v2
│   ├── 设备类型大图标（tonal 容器 48dp）+ 设备名 + 平台版本
│   ├── 在线状态：容器色面积表达（在线=successContainer/离线=surfaceContainer）
│   ├── 当前设备：Badge「本机」
│   └── 长按：解绑（确认对话框）
├── 会话区（SectionDivider「活跃会话」）：SessionsSection 保留，样式对齐 v2
└── Bento 区（可选）：同步统计卡片（今日同步 N 条 / 本周 N 条 / 存储占用）
```

### 5.7 设置页 (`settings_screen.dart` → 重构)

```
├── 账号区块（C6 已有，样式 v2：头像 64dp + 套餐徽标 + 昵称 + 邮箱）
├── 分组列表（每组 SectionDivider + ListTile）：
│   ├── 外观：主题（三态 seg）/ 语言 / 字号 / 字体
│   ├── 同步：采集开关 / 自动回写开关 / 同步间隔
│   ├── 安全：生物锁 / 密码保护条目数
│   ├── 数据：模板库 / 共享链接 / 通知中心 / 清缓存 / 导出
│   ├── 订阅：当前套餐 + 管理入口
│   └── 关于：版本（getVersion）/ 检查更新 / 反馈 / 隐私政策
└── 样式：每组间 SectionDivider + ListTile 内 trailing 全对齐
```

### 5.8 快速粘贴面板 (`quick_paste_panel` → 重写)

```
├── GlassPanel 毛玻璃容器（浮层专属）
├── 搜索框（顶部，auto-focus）
├── 最近条目：横滑 Chips（Gboard 模式）或紧凑列表（视面板尺寸）
├── 点击即复制 + SnackBar；长按打开详情
└── 底部：清空剪贴板 / 设置入口
```

---

## 六、动效规范（v2 全局）

| 场景 | 动效 | 参数 |
|---|---|---|
| 页面 push/pop | M3 容器变换（共享轴 X 轴） | 450ms morph emphasized |
| tab 切换 | Crossfade | 200ms normal |
| 卡片入场 | 首次交错 fade+translateY(16) | stagger 50ms，emphasized decelerate |
| 按压反馈 | scale 0.98 | spring normal 150ms |
| swipe 手势 | 滑动跟手 + 松手 spring 回弹 | springBouncy |
| 删除 | size→0 + fade | accelerateE 200ms |
| 置顶 | 移动到首位（隐式动画列表） | spring 400ms |
| 同步完成 | SyncPulse 脉冲一次 | syncGlow 300ms |
| 下拉刷新 | M3 圆形指示器（默认） | 系统自带 |
| 浮层出入 | fade + scale(0.95→1) | slow 350ms decelerate |
| FAB 点击 | morph 展开为面板 | morph 450ms |

**禁令**：不用 LinearProgressIndicator 横扫、不用 bounce>1.0、任何动画时长不超 500ms。

---

## 七、暗色模式规范

| 层 | 亮色 | 暗色 |
|---|---|---|
| 基础屏 | #FAFAFA | #0E0E10 |
| 卡片 | #FFFFFF | surfaceContainerLow (#1A1A1E) |
| 浮层 | #FFFFFF | surfaceContainer (#232328) |
| 品牌强调 | #5A4BD1 | #C3B6FF |
| 类型色 | 6 色标准版 | 6 色提亮版（+20% L） |
| 描边 | #E4E4E7 | #2A2A30 |
| 分隔线 | outlineVariant 50% | outlineVariant 30% |

规则：暗色不是亮色的灰色反转——每个 surface 层独立定义，品牌色提亮保持对比度 ≥4.5:1。

---

## 八、实施波次（2 并发）

### Wave R1 — 设计系统 v2 落地（2 并行）
- **R1.1** Token 体系：app_theme.dart 重写（ColorScheme.fromSeed 全角色 + AppColors v2 + shapeScale + spring tokens + 兼容层保证存量编译）+ lib/theme/tokens_v2.dart 新文件
- **R1.2** 组件体系 v2：重写 6 个基础组件 + 新建 8 个新组件（4.2 清单）； Arb 补 key
- **验收**：analyze 0 error + 现有页面在新主题下无布局破坏（golden test 或截图对比）

### Wave R2 — 核心页面重构（2 并行 × 2 轮）
- **R2.1** 登录页 + 锁屏 + onboarding 重写
- **R2.2** 首页剪贴板流重构（SliverAppBar + ClipboardCard v2 + SwipeActionRow + QuickPasteDock）
- **R2.3** 详情页重构（按类型分发 + 受保护条目安全语义）
- **R2.4** 收藏夹树形导航视觉重做（分组色 + TypeBadge + 面包屑样式）
- **验收**：真机截图对比重构前后

### Wave R3 — 次级页面 + 动效统一（2 并行）
- **R3.1** 设备页 + 设置页 + 会话区块（Bento 统计卡可选）
- **R3.2** 模板 / 共享链接 / 通知中心 / 权限引导 / 订阅管理（统一 v2 样式）
- **R3.3** 全局动效统一（swipe spring / SyncPulse / 容器变换）+ 暗色审查
- **验收**：en/zh 双语全页面审查 + 性能（60fps 滚动）

### Wave R4 — 收尾（1 并行）
- R4.1 全页面 l10n 残留清零 + 暗色模式全量截图审查 + analyze/build 双门禁

---

## 九、验收标准

1. `flutter analyze` 零 error（持续）
2. `flutter build apk --debug` 通过（每波末尾）
3. 暗色模式下全页面截图审查：无硬编码白色底、对比度 ≥4.5:1、类型色在暗色不失饱和
4. 60fps 滚动（DevTools performance overlay 验证）
5. en/zh 切换后核心页面无裸中文
6. 真机体验：与 Paste/1Password 同屏对比不落下风（主观验收，用户拍板）

---

## 十、明确不做

- 动态取色（Material You）——安全语义色不允许被动态色覆盖，后续可做可选开关
- iOS 适配（继续 Android 先行）
- M3E 官方未落地组件的自造（button group/split button——等 Flutter 官方）
- 换字体包（保持系统字体栈，CJK 场景收益低风险高）
