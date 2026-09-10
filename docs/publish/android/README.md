# ClipSync 国内安卓商店上架材料包

> **产出时间**：2026-06
> **适用版本**：ClipSync 0.1.0+
> **对应清单**：`docs/product/domestic-android-publish-guide.md` §「ClipSync 上架准备清单」→
> 「技术准备」表的第 4、5、6、7 项
> **说明**：本材料包中的 4 项**均为纯产出物，不依赖软著 / ICP 备案 / APP 备案任何审核结果**，
> 资质到手后即可直接提交各商店。

---

## 目录结构

```
docs/publish/android/
├── README.md                    ← 本文件（总览与提交指引）
├── 图标/                         材料 1：应用图标（512/216/192/180/144/96 PNG）
│   ├── ic_launcher_512x512.png   ← 主提交物（vivo 明确要求 512×512 无圆角）
│   ├── ic_launcher_216x216.png
│   ├── ic_launcher_192x192.png
│   ├── ic_launcher_180x180.png
│   ├── ic_launcher_144x144.png
│   ├── ic_launcher_96x96.png
│   ├── _master_4096.png          ← 母版（后续调整用）
│   └── 满幅备选/                  ← 备选满幅版（一般不用）
├── 截图/                         材料 2：应用截图
│   └── README.md                 ← ⚠️ 未采集到（设备未连接），含拍摄方案与隐私清单
├── 应用介绍文案.md                材料 3：应用名称/简介/详细描述/更新日志/关键词
├── 权限说明.md                    材料 4：★ 逐条权限说明 + 明文流量专项分析
└── _tools/                      生成与校验脚本（可重复执行）
    ├── make_icons.py            图标生成器（复刻官网品牌视觉）
    ├── verify_icons.py          图标校验（尺寸/无圆角/品牌色）
    └── verify_permission_doc.py 权限文档完整性校验（对照 Manifest 逐条核对）
```

---

## 四项材料完成状态

| # | 材料 | 状态 | 产物 |
|---|------|------|------|
| 1 | 应用图标 | ✅ **已完成并验证** | `图标/` 6 个尺寸 × 2 变体，全部验证通过 |
| 2 | 应用截图 | ❌ **未完成**（adb 无设备） | `截图/README.md`（拍摄方案 + 隐私清单，**无真实截图**） |
| 3 | 应用介绍文案 | ✅ **已完成并核实** | `应用介绍文案.md`（含功能真实性核对表） |
| 4 | 权限说明文档 | ✅ **已完成并验证** | `权限说明.md`（17 项权限全覆盖，校验脚本通过） |

### 关于材料 2（截图）——需要用户操作

**手机未连接到本机**，`adb devices` 返回空列表，USB 设备树中也无 Android 设备。
按诚实原则**未生成任何占位图或伪造图**。
恢复步骤见 `截图/README.md` 第二节。

---

## 各商店提交指引

### 图标提交对照

| 商店 | 用哪个文件 | 说明 |
|------|------------|------|
| **vivo** | `图标/ic_launcher_512x512.png` | vivo **明确要求 512×512 PNG 无圆角** |
| 华为 | `图标/ic_launcher_216x216.png` | 应用图标位 |
| 小米 | `图标/ic_launcher_216x216.png` | 应用图标位 |
| OPPO | `图标/ic_launcher_216x216.png` | 应用图标位 |
| 应用宝 | `图标/ic_launcher_216x216.png` | 应用图标位 |

> 所有图标均为**方形、完全不透明、无圆角**，圆角由各商店客户端自行裁切。
> 图形本体缩至约 76% 居中，确保商店裁圆角/圆形时不会切到图形。

### 权限说明提交

将 `权限说明.md` 的 §2（逐条说明）与 §3（隐私声明）内容，
按商店后台的「权限说明」字段逐条粘贴。**无障碍权限（§2.15）务必完整提交**，
它是人工审核最可能被打回的一项，文档中已备好 6 条答辩要点。

### 文案提交

直接取用 `应用介绍文案.md` 各节内容。关键词部分**按商店分别取用**（§5.1–5.5）。

---

## 复现与校验（可重复执行）

```bash
cd docs/publish/android/_tools

# 重新生成图标
python make_icons.py

# 校验图标（尺寸 / 无圆角 / 品牌色）
python verify_icons.py
# → 期望输出：ALL CHECKS PASSED

# 校验权限文档覆盖了 Manifest 中每一条权限
python verify_permission_doc.py
# → 期望输出：ALL PERMISSIONS DOCUMENTED — no gaps
```

**最近一次校验结果**（2026-06）：

- `verify_icons.py` → `ALL CHECKS PASSED`（6 主产物 + 6 备选，全部 尺寸正确 / 无圆角 / 含品牌色）
- `verify_permission_doc.py` → `ALL PERMISSIONS DOCUMENTED — no gaps`
  （14 条 `uses-permission` + 3 条组件级 `android:permission` = 17 项，全部覆盖）

---

## ⚠️ 重要更正与需用户决策事项

### 更正 1：实际包名（**影响上架，务必确认**）

任务描述中的包名 `com.clipsync.clipclip_mobile` **与实际不符**。
实际读取 `src/mobile/android/app/build.gradle.kts`：

```
applicationId = "com.clipsync.clipsync_mobile"
```

**正确包名为 `com.clipsync.clipsync_mobile`**。
该值用于商店后台包名字段、APP 备案、adb 命令，填错会直接导致上架失败。

### 决策 1：`usesCleartextTraffic="true"` 整改（**未擅自修改**）

`AndroidManifest.xml` **第 28 行** `android:usesCleartextTraffic="true"` 允许全局明文 HTTP，
是安全隐患，也可能被商店安全检测标为高危导致驳回。
完整风险分析 + `networkSecurityConfig` 整改方案见 `权限说明.md` §4。

**本次未修改 Manifest**——该改动会影响真机调试链路（若 dev 后端走 `http://`，
改完真机将连不上），需项目负责人确认生产环境已全量 HTTPS 后再实施。

### 决策 2：移动端 AI 功能是否写入文案

服务端 AI 能力完整（`aiChat.js` 等十余模块 + `ai_classify` 套餐特性），
但**移动端 AI 入口为预留状态**（`feature_flags_provider.dart` 第 12 行注释）。
因此**安卓商店文案未宣称 AI 功能**。若你确认移动端 AI 已可用，可补入——
但需先能提供可演示的界面，否则不建议。详见 `应用介绍文案.md` §6.1。

### 待办：应用名称需与备案/软著一致

应用名称（`ClipSync` 或 `ClipSync 剪贴板同步`）需与**软著名称、APP 备案名称保持一致**，
否则备案可能被驳回。请在有资质结论后统一确认。

---

## 本次未修改的文件（仅读取）

按任务约束，本次**只新增 `docs/publish/android/` 下的文件**，未修改任何既有文件：

- ✅ 未修改 `src/mobile/android/app/src/main/AndroidManifest.xml`（仅读取分析）
- ✅ 未碰 `src/server/src/utils/email.js`
- ✅ 未触碰 git（无 commit / push / 分支操作）
- ✅ 未修改任何其他目录文件（避免与并行子代理冲突）
