# P0-C / C3 — 恢复被永久静音的 `vue/no-v-html` 并逐个处理照出来的命中点

分支：`test/admin-full-audit`
范围：只改了 `src/desktop/eslint.config.js` 与 `src/desktop/src/**`。
未碰：`src/desktop/index.html`（owner 未提交改动）、`.github/**`（邻居 C2）、`src/server/**`（邻居 C1）、
`src/admin-console/**`、`src/mobile/**`、`.worktrees/**`、任何 `package.json`/lockfile（**零新增依赖**）。
本文件随做随写，末尾为最终态。

---

## 0. 锚点复核（动手前实测）

| 锚点 | 复核结论 |
|------|----------|
| `src/desktop/eslint.config.js:34` | **成立**：`'vue/no-v-html': 'off'`，写在全局 `rules` 块（对 `**/*.{js,ts,mjs,mts,vue}` 生效），无按目录/按文件的例外 ⇒ 桌面端任何组件塞 `v-html` 都不会被拦。 |
| `src/desktop/package.json` lint 脚本 | 实际是 `"lint": "eslint ."`，**不带 `--max-warnings=0`**（带该参数的是服务端那条：`.github/workflows/ci.yml` 的 lint job）。 |
| `sanitizeHtml` | 定义在 `src/desktop/src/utils/html.ts:44`（DOMPurify，`USE_PROFILES:{html:true}` + FORBID `script/iframe/object/embed/link/meta/style/base/form` 与 12 个事件属性 + `style/srcset/formaction`）。既有测试 `src/desktop/src/utils/__tests__/sanitize.test.ts`（19 例）。**本票全部复用，未另造清洗实现。** |

### 0.1 一个票面没预料到的事实：`off` 覆盖掉的是插件自带的 `warn`

`eslint-plugin-vue` 的 `flat/recommended`（`vue3-recommended.js`）**本来就把 `vue/no-v-html` 设为 `warn`**。
实测扁平配置里该规则出现两段：

```
#8  name="vue/recommended/rules"          severity="warn"    ← 插件 recommended 带进来的
#10 name=-（项目自己那段）                 severity="error"   ← 本票改后的项目块（改前是 'off'）
```

⇒ 原先那行 `'off'` 不只是"没开一条新规则"，而是**把插件默认已经提供的告警也按下去了**：
连"响一声"的机会都没留。（另一个可选修法是整体换成 `configs['flat/recommended-error']`，
那会一次性把几十条 vue 规则升成 error，churn 太大，本票没走，只在项目块做定点 `error`。）

### 0.2 恢复规则前的 lint 基线（本机工作树实测）

```
cd src/desktop && npx eslint .
✖ 56237 problems (2 errors, 56235 warnings)     退出码 1
```

| 规则 | 条数 |
|------|------|
| prettier/prettier | 55681（几乎全是 `Delete ␍`：桌面端源码文件整体是 CRLF，prettier 期望 LF，存量噪音） |
| @typescript-eslint/no-explicit-any | 406 |
| @typescript-eslint/no-unused-vars | 111 |
| vue/require-default-prop | 19 |
| no-console | 11 |
| **no-useless-assignment** | **2 —— 唯二的 error** |
| vue/attributes-order / first-attribute-linebreak / block-order / no-required-prop-with-default | 7 |

**`npm run lint` 在本票动手之前就是红的**（2 个存量 `no-useless-assignment`，与 XSS 无关）：

- `src/components/clipboard/FavOrganizeFlow.vue:66` `let raw = ''`（三分支各自赋值，初值永不被读）
- `src/composables/usePrivacy.ts:102` `let ok = false`（if/else 各自赋值，同上）

判据要求"完成后 `npm run lint` 真过（退出码 0）"，不处理就无法区分"我的改动干净"与"本来就红"。
两处都是 `let x = 常量` → `let x: 类型` 的零行为差异改法（TS 明确赋值分析下两支都已赋值），
且都落在本票拥有的 `src/desktop/src/**` 内。已改，见 §4.6。

### 0.3 CI 面核实（只读）

`.github/workflows/` 只有 `admin-console.yml` / `ci.yml` / `deploy.yml` / `website.yml`，
**没有任何 workflow 引用桌面端** ⇒ 桌面端 `eslint` 目前只在本地/人工执行。

---

## 1. 决策：恢复成 `'error'`（不是 `'warn'`）

票面默认 `error`，实况三条都支持它：

1. lint 脚本没有 `--max-warnings=0` ⇒ 设 `warn` **不会**让 CI 变红（票面担心的副作用在本仓不存在）；
   但也**永远拦不住任何人**——仓库已有 5.6 万条 warning，再加一条 `vue/no-v-html` warning
   等于把它埋进噪音里，那就是"换个姿势把报警器再拔一次"。
2. CI 根本不跑桌面端 lint（§0.3），所以"`error` 会把 CI 弄红"这个反对理由在本仓不成立；
   `error` 的唯一效果是让本地 `npm run lint` 必须真把这 12 处处理掉。
3. 判据 3 禁止的三种交差方式（改成只警告 / 再关别的规则 / 排除目录）本票一条都没用；
   唯一使用的豁免手段是**逐行 `<!-- eslint-disable-next-line vue/no-v-html -- 理由 -->`**，共 11 行，
   每行都带具体到"谁转义了、谁消毒了、哪条用例钉住"的理由（见 §3）。

```diff
-      'vue/no-v-html': 'off',
+      // P0-C C3：此规则曾被设为 'off'（等于把存储型 XSS 汇聚点的报警器永久断电）。
+      // 恢复为 error：'warn' 在本仓无效——npm run lint 即 `eslint .`，不带 --max-warnings，
+      // 且仓库已有 5 万余条 prettier 警告，'warn' 会被噪音彻底淹没。
+      'vue/no-v-html': 'error',
```

---

## 2. 恢复那一瞬间的命中总数：**12**

`npx eslint .` → `vue/no-v-html` 命中 **12**，problems 56237 → 56252，errors 2 → 14（12 条全是 error）。
处理完的剩余命中：**0**（11 处带理由行内豁免 + 1 处删除 v-html）。

| # | 命中点（恢复时的行号） | v-html 表达式 | 上游保护 | 判定 |
|---|------------------------|---------------|----------|------|
| 1 | `components/ai/AiAgentRun.vue:93` | `renderMarkdown(run.content)` | 组件内 `sanitizeHtml(marked.parse())` | B |
| 2 | `components/ai/AiNavRail.vue:259` | `highlightSnippet(...)` + 模板里再替换 `<mark>` | `escapeHtml` 转义 5 字符 | **B（原豁免失效，见 §3.2）** |
| 3 | `components/ai/AiStreamText.vue:190` | `html`（ref） | `sanitizeHtml(marked.parse())`，catch 分支同样 sanitize | B |
| 4 | `components/clipboard/HtmlPreview.vue:25` | `html`（computed） | 两条分支都 `sanitizeHtml` | B |
| 5 | `components/clipboard/TemplateGenerateDialog.vue:201` | `hlVars(parsed.content)` | `esc()` 后只注入固定 span（副本 1） | B + 抽函数补测 |
| 6 | `components/clipboard/TemplateList.vue:42` | `hlVars(tpl.content)` | 同上（副本 2） | B + 抽函数补测 |
| 7 | `components/clipboard/TemplatesView.vue:201` | `hlVars(selected.content)` | 同上（副本 3） | B + 抽函数补测 |
| 8 | `components/doc-preview/CodePreview.vue:30` | `renderCode(content, fileName)` | highlight.js 对输入全量转义 | B |
| 9 | `components/doc-preview/DocxPreview.vue:60` | `html`（prop） | 唯一调用方 `DocPreviewModal` 赋 `sanitizeHtml(ensureHeadingIds(mammoth))` | B |
| 10 | `components/doc-preview/MarkdownPreview.vue:36` | `renderMarkdown(content)` | `utils/docPreview` 内 `sanitizeHtml` | B |
| 11 | `components/doc-preview/PptxPreview.vue:21` | `slide`（prop，`string[]`） | **组件内零保护**，只靠调用方正则"碰巧"不产出裸 `<` | **A** |
| 12 | `components/doc-preview/SpreadsheetPreview.vue:71` | `processedSheets[i].html` | `ensureThead()` 两条返回都 `sanitizeHtml` | B |

计数：**A 1 条 / B 11 条 / C 0 条**。C 为 0 不是没查：12 个宿主组件逐个查过引用，
**全部 ≥1 个真实 import 点**（`AiStreamText` 4 处、`AiNavRail` 2 处、其余各 1 处），
没有一处是挂在死组件上的死代码 ⇒ 没有"删掉算了"的便宜可占。

---

## 3. 逐条处置与理由

分类口径说明：票面的 B 写的是"内容确证不可控（例如只渲染本项目自己生成的常量字符串）"。
这 12 处里**没有一处**是"只渲染常量字符串"（唯一沾边的是 `DocPreviewModal.vue:258` 失败分支那句
常量提示，它也确实没走 sanitizeHtml）；11 条 B 落在 B 是因为"可控内容在进入这个 sink 之前
已被 DOMPurify 或转义处理过"，属于对票面三分类的一处 stretching，我把层区别写进了每一行的
豁免注释里，不做"反正都安全"的笼统断言。

### 3.1 A 类（1 条）：`PptxPreview.vue` —— 改纯文本渲染，v-html 从文件里消失

判 A 的理由（三条都成立才敢这么定）：

1. **组件自身零保护**：`defineProps<{ slides: string[] }>()` + `<div class="slide-body" v-html="slide" />`，
   收到的字符串无条件 innerHTML，没有 `sanitizeHtml`、没有转义。
2. **保护只在调用方，且是靠"正则碰巧"实现的**：`DocPreviewModal.renderPptx()` 用
   `/<a:t[^>]*>([^<]*)<\/a:t>/` 提取文本、再 `m.replace(/<[^>]+>/g,'')` 去标签、再 `` `<p>${l.replace(/</g,'&lt;')}</p>` ``。
   逐字符推演确实漏不出裸 `<`（捕获组禁 `<`；匹配串里剩下的 `<` 只能来自标签本身，被去标签一起吃掉），
   但这是一条**没有被任何测试钉住的隐式不变式**。
3. **sink 是公开类型**：prop 是 `string[]`，任何第二个调用方（或把 pptx 换成别的来源）都能直接灌远端内容。
   运行期也兜不住：`src-tauri/tauri.conf.json:30` 的 CSP 是 `script-src 'self' 'unsafe-inline'`，
   注入成功的 `onerror=` 这类内联处理器 **CSP 是允许的** ⇒ 转义/消毒是唯一防线。

处置（不新增依赖）：

- `src/desktop/src/utils/docPreview.ts`：把那段正则提取抽成纯函数
  `pptxSlideTextLines(xml): string[]`，返回**纯文本行**（并把 XML 实体 `&lt;`/`&#60;` 解回字符，
  保持与改前"innerHTML 自己解实体"一致的显示结果；只解一层，`&amp;lt;` 不会二次解码）。
- `src/desktop/src/components/modals/DocPreviewModal.vue:287-318`：`pptxSlides` 类型 `string[]` → `string[][]`，
  不再自己拼 `<p>`；空页占位文案从"父组件塞 HTML 常量"改为子组件的模板分支。
- `src/desktop/src/components/doc-preview/PptxPreview.vue`：`slides: string[][]`，
  `<p v-for="(line, li) in slide">{{ line }}</p>` ⇒ 恶意内容只能作为文本节点出现。
  顺带删掉因此变成死代码的 `:deep(strong)` / `:deep(li)` 两条样式，占位文案的颜色改由 `.slide-empty` 提供。

### 3.2 B 类里最需要单独说的一条：`AiNavRail.vue` —— 原先那行豁免**根本不生效**

恢复规则前，`AiNavRail.vue:256` 已经写着
`<!-- eslint-disable-next-line vue/no-v-html (highlightSnippet 已对 snippet 做 HTML 转义，仅注入 <mark> 标签) -->`，
但 `v-html` 属性当时跨在 259-263 行（多行写法），`*-next-line` 只对**紧邻的下一行**生效 ⇒
豁免指向的是 `<span` 那一行，而规则报在 `v-html` 所在行。
也就是说：**这是一处"看起来有豁免、实际是裸奔"的写法，因为规则被 off 掉，从来没人看见它失效**。

处置：把 `<mark>` 的注入收进 `utils/htmlText.highlightSearchSnippet()`（模板里不再做二次 replace），
表达式缩到一行，豁免注释改到紧邻上一行（现在报的就是被豁免的那一行）。
另外原实现用 `\u0001`/`\u0002` 做哨兵、在模板里再换成 `<mark>`：内容本身含这两个控制字符的
snippet 会凭空多出开标签 —— 一并改掉，并留了一条回归用例。

### 3.3 其余 10 条 B：全部保留 v-html + 逐行豁免（禁止整文件/全局关闭）

豁免行号（处理后的最终态，注释行 = 命中行 - 1）：

| # | 文件 | 豁免注释行 / v-html 行 | 豁免理由（写进代码里的那句话，摘要） |
|---|------|------------------------|--------------------------------------|
| 1 | `ai/AiAgentRun.vue` | 93 / 94 | `run.content` 远端可控，但只经本文件 `renderMarkdown()`：`marked.parse` 之后立即 `sanitizeHtml`，异常兜底同样 sanitize |
| 3 | `ai/AiStreamText.vue` | 190 / 191 | `html` 只由 `renderSlice()` 写入：`sanitizeHtml(marked.parse(...))`，catch 分支也是 `sanitizeHtml(prepared)` |
| 4 | `clipboard/HtmlPreview.vue` | 25 / 26 | `html` 是本文件 computed，两条分支（`metadata.html` 片段 / `content` 嗅探回退）都各自 `sanitizeHtml` |
| 5 | `clipboard/TemplateGenerateDialog.vue` | 193 / 194 | `highlightTemplateVars` 先整段 `escapeHtmlText` 再替换占位符，唯一活标签是本项目写死的 `<span class="var-hl">` |
| 6 | `clipboard/TemplateList.vue` | 34 / 35 | 同上（三处共用一个已测函数，不再各存副本） |
| 7 | `clipboard/TemplatesView.vue` | 193 / 194 | 同上 |
| 8 | `doc-preview/CodePreview.vue` | 30 / 31 | `renderCode` 走 hljs：对输入全文转义，产出只有 `<span class="hljs-*">`；`sanitize.test.ts` 的 renderCode 用例钉住 |
| 9 | `doc-preview/DocxPreview.vue` | 60 / 61 | `html` 只有唯一调用方 `DocPreviewModal`，其两个赋值点是 `sanitizeHtml(ensureHeadingIds(mammoth))` 与项目常量字符串 |
| 10 | `doc-preview/MarkdownPreview.vue` | 36 / 37 | `utils/docPreview.renderMarkdown` return 前一律 `sanitizeHtml`（catch 分支也转义 `< >`） |
| 12 | `doc-preview/SpreadsheetPreview.vue` | 71 / 72 | `processedSheets[].html` 由本文件 `ensureThead()` 产出，两条返回路径都以 `sanitizeHtml` 结尾（xlsx `sheet_to_html` 不转义 href，`javascript:` 能进 `<a href>`，所以这步不可省） |

（#2 `AiNavRail.vue` 的豁免在 247 / 248，见 §3.2。）

顺带记录一条 B 类里**不构成风险但值得 owner 知道**的不一致：
`DocPreviewModal.vue:258` 的失败分支 `docxHtml.value = '<p style="color:var(--danger)">…</p>'`
是常量字符串、没走 sanitizeHtml（成功分支走了）。因为 `sanitizeHtml` 的 `FORBID_ATTR` 含 `style`，
成功渲染出来的文档其实拿不到内联颜色，而失败提示能——两者显示口径不同，但都不是注入面。本票未改（改了会影响既有观感，属另一件事）。

---

## 4. 改动清单（19 个文件：17 改 + 2 新增；`git status --short -- src/desktop` 与此逐条对齐）

| 文件 | 改了什么 |
|------|----------|
| `src/desktop/eslint.config.js` | `vue/no-v-html` `off` → `error` + 理由注释 |
| `src/desktop/src/utils/htmlText.ts` | **新增**：`escapeHtmlText` / `highlightTemplateVars` / `highlightSearchSnippet`（把 4 处组件内副本收敛成 1 处，让它可被单测） |
| `src/desktop/src/utils/docPreview.ts` | **新增** `pptxSlideTextLines()` + `decodeXmlText()`（pptx 提取抽成可测纯函数） |
| `src/desktop/src/components/doc-preview/PptxPreview.vue` | A 类：`slides: string[][]`，v-html → `{{ }}` 文本插值；CSS 去掉失效的 `:deep()` |
| `src/desktop/src/components/modals/DocPreviewModal.vue` | `pptxSlides: string[][]`，改用 `pptxSlideTextLines`，不再自己拼 `<p>` |
| `src/desktop/src/components/ai/AiNavRail.vue` | 用 `highlightSearchSnippet`，修好失效的豁免位置 |
| `src/desktop/src/components/clipboard/{TemplateList,TemplatesView,TemplateGenerateDialog}.vue` | 删 3 份 esc/hlVars 副本 → 共用 util；加逐行豁免 |
| `src/desktop/src/components/ai/{AiAgentRun,AiStreamText}.vue`、`clipboard/HtmlPreview.vue`、`doc-preview/{CodePreview,DocxPreview,MarkdownPreview,SpreadsheetPreview}.vue` | 只加逐行豁免注释（内容未改） |
| `src/desktop/src/components/clipboard/FavOrganizeFlow.vue`、`src/desktop/src/composables/usePrivacy.ts` | `let x = 常量` → `let x: 类型`（清掉 2 条存量 error，见 §0.2） |
| `src/desktop/src/utils/__tests__/vhtml-invariants.test.ts` | **新增**测试文件（26 例） |

**没有**改的东西：`package.json` / lockfile / `src-tauri/**` / `index.html` / 任何别的端。

---

## 5. 测试

### 5.1 新增 26 例（`src/utils/__tests__/vhtml-invariants.test.ts`）

- `vue/no-v-html 报警器本身`（1 例）：真正 `await import('../../../eslint.config.js')` 拿扁平数组，
  按 flat config 的"后声明覆盖先声明"算出生效值，要求 = `error`，且任何一段都不许是 `off/0/false`。
  这一条同时挡住两种复发：改回 off、以及被人塞一段新的 `warn` 覆盖掉。
- `escapeHtmlText`（2 例）：5 字符转义逐字面断言、null/undefined 不抛。
- `highlightTemplateVars`（命中点 5/6/7，11 例）：7 条 XSS payload × "剥掉本项目自己写的
  `<span class="var-hl">`/`</span>` 之后不允许剩任何 `<`"；`{{a</span><img onerror>}}` 提前闭合
  尝试（并断言 span 开/闭各 1、结构没被撑坏）；chip 功能未退化；压平/保留换行两种模式；空串。
- `highlightSearchSnippet`（命中点 2，6 例）：payload 只剩文本、`<mark>` 确实包住命中、
  关键词含正则元字符、关键词本身是 HTML 时两侧同源转义、`\u0001` 哨兵回归、空关键词。
- `pptxSlideTextLines`（命中点 11，6 例）：原始标签直写 ⇒ 提取不到（`[]`）；实体编码 payload ⇒
  解出来是纯文本，再过 `escapeHtmlText`（等价 Vue 插值）后没有活标签；数字实体 `&#60;`；
  `&amp;lt;` 只解一层；正常 slide 的顺序与非空过滤；空输入。

### 5.2 断言有没有被弱化：**没有**

- 既有测试文件 `src/utils/__tests__/sanitize.test.ts` **一个字节都没改**（19 例仍全绿）。
  新逻辑没有塞进它，避免和 P0-B 的产物冲突。
- 新文件的判据不是"关键字模糊匹配"而是结构判据：`assertOnlyAllowedTags()` 剥掉本项目写死的
  允许标签后 `expect(rest).not.toContain('<')`。
- 这里刻意**没有**沿用 `sanitize.test.ts` 的 `assertInert`（那条断言输出里不许出现 `onerror`）：
  转义型 sink 的输出里 `onerror=` 作为**文本**必然还在（那是数据，不是活标签），
  用 `not.toContain('onerror')` 会假失败，用"允许标签外无 `<`"才既正确又更强。这是口径选择，不是放水。
- 变异验证（把保护改坏，看用例会红）——每条都是"临时改源文件 → 跑 → 立刻按内存里的原文还原"：

```
M1 highlightTemplateVars 不再转义（直接把原文交给 v-html） -> vitest exit=1, 1 failed
M2 highlightSearchSnippet 不转义 snippet                     -> vitest exit=1, 1 failed
M3 pptx 提取放宽捕获组（允许裸 < 进正文）                    -> vitest exit=1, 1 failed
M4 vue/no-v-html 被改回 off                                  -> vitest exit=1, 1 failed
M5 vue/no-v-html 被改成 warn                                 -> vitest exit=1, 1 failed
```
  5/5 变异被杀。还原后已复核源文件（`[^<]*` 与 `'error'` 与 `escapeHtmlText(src)` 都在原位），
  `git status` 里我碰过的文件 = §4 清单，不多不少。

---

## 6. 三件仪器实跑输出（最终态）

```
$ cd src/desktop && npm run lint        # = eslint .
✖ 56256 problems (0 errors, 56256 warnings)
  0 errors and 55707 warnings potentially fixable with the `--fix` option.
LINT_EXIT=0                      ← 判据 4 达标
vue/no-v-html 命中：恢复那一瞬间 12 → 处理完剩 0
```
警告数 56235 → 56256（+21）全是 `prettier/prettier` 的 `Delete ␍`：桌面端源码整体 CRLF，
我新增的 21 行跟着所在文件的行尾走 ⇒ 每行 1 条。逐文件核过：
我碰过的 18 个文件里**没有任何一条非 CRLF 的 prettier 意见**（也就是没有"你格式没排好"的实锤），
也没有新增任何其它规则的命中。CRLF/LF 的根因治理不属本票（要一次全仓换行 + `.gitattributes`）。

```
$ npx vue-tsc --noEmit          # 桌面端没有 typecheck 脚本，build 里就是这一条
TSC_EXIT=0

$ npx vitest run
 ✓ src/components/settings/__tests__/useSettingsSearch.test.ts (5 tests)
 ✓ src/composables/__tests__/useSubscriptionAccess.test.ts (17 tests)
 ✓ src/composables/__tests__/useMenuAccess.test.ts (17 tests)
 ✓ src/utils/__tests__/sanitize.test.ts (19 tests)
 ✓ src/utils/__tests__/vhtml-invariants.test.ts (26 tests)
 Test Files  5 passed (5)
      Tests  84 passed (84)         ← 基线 58 + 本票新增 26，0 失败 0 跳过

$ npx vite build                    # 票面没要求；因为 PptxPreview 是结构改动，加跑一次确认模板能编译
✓ built in 22.96s                   BUILD_EXIT=0
```
上面三条是**变异验证跑完之后**的最终复核（变异脚本会在内存里留原文备份并还原，还原后又用
grep 复确认 `[^<]*` / `'error'` / `escapeHtmlText(src)` 都在原位；`git diff --numstat -- src/desktop`
与 §4 清单逐文件对齐，不多不少）。
`src/desktop/index.html` 出现在 diff 里是 **owner 自己的未提交改动**，本票没有写过一个字节。
（票面基线 58 已在本机改动前复跑确认：`Test Files 4 passed (4) / Tests 58 passed (58) / 20.68s`。）

---

## 7. 未经真机/真界面验证的清单 + owner 手工验证步骤

我这边不能起桌面端（owner 自己起），**以下 6 处只做了逻辑与编译层面的验证，没有看过实际渲染**：

| 风险点 | 位置 | 需要眼睛确认什么 |
|--------|------|------------------|
| PPTX 预览改纯文本渲染（结构改动，最高优先级） | `doc-preview/PptxPreview.vue` + `modals/DocPreviewModal.vue` | 每张 slide 的段落分隔、行距、"本页无可提取文本"的灰色字是否与以前一致；文本里含 `<` `>` `&` 的 slide 现在应当显示成字符本身（以前也是） |
| AI 搜索命中高亮 | `ai/AiNavRail.vue` | 搜索关键词命中的片段仍显示黄色/高亮的 `<mark>` 效果，且没有把 `<mark>` 三个字显示出来 |
| 模板列表卡片正文 chip | `clipboard/TemplateList.vue`、`clipboard/TemplatesView.vue` | `{{变量}}` 仍是带底色的 chip；正文换行被压成一行的既有行为不变 |
| AI 生成模板预览 | `clipboard/TemplateGenerateDialog.vue` | 预览正文的换行**保持原样**（这里特意传 `false` 不压行） |
| 富文本 / Markdown / Excel / Word / 代码预览 | `HtmlPreview`、`MarkdownPreview`、`SpreadsheetPreview`、`DocxPreview`、`CodePreview` | 只是加了注释行，逻辑零改动；扫一眼确认没白屏即可 |
| 敏感内容 PIN 校验 | `composables/usePrivacy.ts`（`let ok: boolean`） | 输对 PIN 仍能解锁、输错仍被拒（编译层已确保，但这是安全路径，值得点一下） |

建议的点击顺序（一次跑完约 5 分钟，覆盖上表全部 6 行）：

1. 先在 Windows 剪贴板里放一段**带变量的文本**（例如 `Hi {{ name }}, <b>x</b> & 5 > 3`），
   打开桌面端 → 模板页：列表卡片与右栏详情都应显示 `Hi {{name}}, <b>x</b> & 5 > 3`，
   其中 `{{name}}` 是 chip；`<b>x</b>` 必须**按字面显示**（不能被加粗）。
2. 「AI 生成模板」→ 随便生成一条 → 预览区：正文里的换行数应与生成结果一致（不被压成一行），
   chip 正常，且 `<` 开头的片段仍是字面文本。
3. 造一条恶意条目验证 sink 已闭：把下面这行原文粘进剪贴板并同步/预览（文本详情弹窗）
   `<img src=x onerror=alert(1)>` ——
   期望：走 Code/文本渲染，看到的是字面字符串，**不弹任何对话框**。
4. 右键该条目 → 若被识别成 HTML 预览：预览区仍不应弹窗，`<img>` 不出现破图图标。
5. 打开一个 `.pptx`（**最好含一页只有图片没有文字的 slide**，用来触发"本页无可提取文本"占位）：
   逐页看段落间距与颜色；若手上有含 `<` 或 `&` 的 slide，确认显示为字符本身。
   若没有现成文件，可用 PowerPoint 随便打一行 `a < b & c` 存成 pptx。
6. AI 会话页 → 左侧导航条的搜索框输入一个确定命中的关键词 → 命中片段的高亮标记可见、
   且片段文本完整（这条同时验证第 2 处豁免的行为）。
7. （安全路径）设置 → 隐私/PIN：设 PIN → 锁敏感条目 → 输对能看、输错被拒。

---

## 8. 顺带核实：管理台与移动端有没有同类"把 XSS/安全 lint 规则关掉"的写法

**结论：两端都没有 `vue/no-v-html` 那种"显式关掉安全规则"的写法。** 但各有一条**同族**问题（仪器压根不存在 / 整文件关闭），
按票面要求只报不改：

| 端 | 文件 + 行号 | 规则/形态 | 判定 |
|----|-------------|-----------|------|
| 管理台 | `src/admin-console/eslint.config.js`（全文 90 行）+ `src/admin-console/package.json`（devDependencies 无 `eslint-plugin-react`） | 配置里挂的插件只有 `@eslint/js` / `typescript-eslint` / `react-hooks` / `react-refresh`；**没有任何一段把安全类规则设成 `off`**（`'off'` 一次都没出现）。但 React 版的 XSS 汇聚点规则 `react/no-danger` **压根没装** ⇒ 该端不存在"vue/no-v-html 被静音"这件事，存在的是"这台仪器从来没被接上" | 属"仪器不存在"，不是"被拔掉"。当前**无实际暴露**：`src/admin-console/src` 与 `tests` 里 `dangerouslySetInnerHTML` / `innerHTML` / `document.write` / `insertAdjacentHTML` / `javascript:` 全为 0 处。要不要补 `eslint-plugin-react`（= 新增依赖）请另开票 |
| 管理台 | `src/admin-console/eslint.config.js:89` | 末项 `prettier,` = `eslint-config-prettier` 的扁平导出，它会**批量把格式类规则设成 `off`** | 一次性关掉的是 stylistic 规则（缩进/引号/换行一类），不含安全规则；且这是"用 prettier 管格式"的标准做法。记录形态，无需处理 |
| 管理台 | `src/admin-console/src/**` 里 4 处行内豁免：`components/ErrorBoundary/index.tsx:25`(`no-console`)、`hooks/useTableQuery.ts:51`、`pages/sso/index.tsx:57`、`pages/settings/index.tsx:462`（均 `react-hooks/exhaustive-deps`） | 行内豁免 | 均与安全无关。注意 `settings/index.tsx` 与 `sso/index.tsx` 属 owner/C 票邻居正在改的文件，**只读未动** |
| 移动端 | `src/mobile/analysis_options.yaml:11-18`（`analyzer.errors`）与 `:19-22`（`analyzer.exclude`） | `errors` 把 `dead_code`/`unused_import`/`unused_local_variable`/`unnecessary_import` 降为 `warning`、`invalid_annotation_target: ignore`；`exclude` 排除 `**/*.g.dart`、`**/*.freezed.dart`、`lib/generated/**` | 都不是安全规则（`invalid_annotation_target` 是 codegen 语法噪音）。`linter.rules`（第 24 行起）是 200+ 条**全量列出**的清单，其中没有安全类规则被排除或降级 |
| 移动端 | `src/mobile/lib/l10n/app_localizations.dart:11`、`app_localizations_en.dart:5`、`app_localizations_zh.dart:5` | `// ignore_for_file: type=lint` —— **整文件关闭全部 lint**，正是票面禁止桌面端使用的那种形态 | 出现在 Flutter **生成**的本地化文件里（`flutter gen-l10n` 产物），且 Dart 侧没有 XSS 类 lint 可关；判定为可接受，登记给"生成物是否该进 git"议题（不属本票）。同两文件另有 `:1` 的 `// ignore: unused_import`（`_genL10nDelegates` 相关），也非安全规则 |
| 桌面端（自查） | 全仓只有 2 个 eslint 配置文件（`src/desktop`、`src/admin-console`），桌面端除 `vue/no-v-html` 外被关的只有 `vue/multi-word-component-names`（命名类） | — | 无其它安全规则被静音 |
| 桌面端（自查） | 除本票新增的 11 条外，仓库里原有的 `eslint-disable` 只有 3 条且都非安全规则：`modals/ShortcutsModal.vue:203` 与 `settings/.../ShortcutsSubPage.vue:157`（`no-control-regex`）、`utils/logger.ts:8`（`/* eslint-disable no-console */`，整文件）、`src/env.d.ts:5`（`@typescript-eslint/no-empty-object-type`，Vue SFC shim） | — | 记录备查，未改 |

越票观察（**不属本票，仅报告**）：`src/server` 没有 eslint 配置文件、`package.json` 里也没装 eslint，
CI 的 lint job 因此会真红——这条邻居 C2 已在 `.github/workflows/ci.yml` 的注释与其证据文件里登记，我不重复处理。

---

## 9. 未完成 / 需要 owner 拍板

| # | 项 | 状态 |
|---|----|------|
| U1 | §7 的 6 项 UI 手工验证 | **必须 owner 做**（我不能起桌面端）。PPTX 那一行是唯一有视觉回归可能的结构改动。 |
| U2 | 桌面端 CRLF → LF（消掉 5.5 万条 prettier 警告）+ 加 `.gitattributes` | 未做。不做的话 `warn` 类判据永远读不出来，也正是本票选择 `error` 的根因之一；但全仓换行属大批量改动，需单独排期与 owner 批准。 |
| U3 | 桌面端 lint 目前**没有任何 CI 覆盖**（§0.3） | 未做且不能做（`.github/**` 是 C2 的）。建议后续批次给桌面端补一条 `npm run lint` + `npx vitest run` 的 job，否则本票恢复的报警器只在有人手动跑时才响。 |
| U4 | `DocxPreview` 的 sanitize 责任在父组件（`DocPreviewModal`）身上 | 判 B 依赖"唯一调用方"这个事实（已核：全仓仅 `DocPreviewModal.vue:902` 一处 import）。若将来出现第二个调用方，这一条要改判 A（在组件内补 sanitize）。 |
| U5 | CSP `script-src 'self' 'unsafe-inline'`（`src-tauri/tauri.conf.json:30`） | 只报不动（`src-tauri` 不属本票）。它是"为什么 B 类豁免必须逐条给理由"的根因：运行期没有第二道防线。 |
| U6 | `src/desktop/src/utils/htmlText.ts` 与 `html.ts` 两个文件并存 | 分工已在文件头写明（转义型 vs DOMPurify 型）。若 owner 觉得该合并成一个 `utils/html.ts`，是一条纯机械改动，本票没顺手做以免扩大 diff。 |
