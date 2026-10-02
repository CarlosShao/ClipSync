// @vitest-environment jsdom
// P0-C C3 —— v-html 命中点的「不变式」证据。
//
// 背景：桌面端 eslint 配置曾把 vue/no-v-html 设为 'off'（= 把存储型 XSS 汇聚点规则永久静音）。
// 恢复为 'error' 后照出 12 处命中：11 处保留 v-html（内容确证经过转义或 DOMPurify），
// 1 处（PptxPreview）改成纯文本插值渲染。
//
// 本文件负责「保留 v-html」那一类里原先**没有测试**的豁免理由：
//   - highlightTemplateVars：3 处模板预览的 {{变量}} chip（原先 3 份组件内副本）
//   - highlightSearchSnippet：AI 会话搜索命中的 <mark>（原先在组件内，且配了一条**根本不生效**的行内豁免）
//   - pptxSlideTextLines：PPTX slide 文本提取（改纯文本渲染后 producer 侧的契约）
// 外加一条仪器自身的回归：vue/no-v-html 不得再被设回 off/warn。
//
// 断言口径（与 sanitize.test.ts 不同，但不是弱化）：这些路径是**转义**而非删除，
// 所以 payload 里的 `onerror=` 作为文本必然还在。判据换成「剥掉本项目自己写死的标签后，
// 输出里不允许剩任何 < 或 >」—— 任何漏网的活标签都会留下裸尖括号，比关键字模糊匹配更强。
import { describe, it, expect } from 'vitest'
import { escapeHtmlText, highlightTemplateVars, highlightSearchSnippet } from '@/utils/htmlText'
import { pptxSlideTextLines } from '@/utils/docPreview'

/** 剥掉本项目自己写的标签后不允许剩任何 `<` —— 剩下即「内容造出了活标签」 */
function assertOnlyAllowedTags(html: string, allowed: string[]) {
  let rest = html
  for (const tag of allowed) rest = rest.split(tag).join('')
  expect(rest).not.toContain('<')
}

const XSS_PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '"><img src=x onerror=alert(1)>',
  '<body onload=alert(document.cookie)>',
]

describe('vue/no-v-html —— 报警器本身不得再被拔电', () => {
  // 超时放宽到 20s：本条用例要动态 import eslint.config.js，即把整套 ESLint 工具链
  // （typescript-eslint / eslint-plugin-vue / prettier 插件…）拉起来，独占跑就要 ~4.5s，
  // 与其它 jsdom 用例并行时贴着 vitest 默认的 5s 上限（新增模型配置用例后实测 4.4–4.7s）。
  // 只放宽等待时间，断言口径一字未改。
  it('eslint 扁平配置里该规则的最终生效值必须是 error，且任何一段都不许设成 off', { timeout: 20_000 }, async () => {
    // eslint.config.js 是纯 JS 无 .d.ts（tsconfig 未开 allowJs）⇒ 这里只借它读扁平配置数组
    // @ts-expect-error TS7016: Could not find a declaration file for module '../../../eslint.config.js'
    const mod = (await import('../../../eslint.config.js')) as {
      default: { name?: string; rules?: Record<string, unknown> }[]
    }
    const flats = [mod.default].flat(Infinity as 1) as { name?: string; rules?: Record<string, unknown> }[]
    // 后声明覆盖先声明（ESLint flat config 语义）：eslint-plugin-vue 的 flat/recommended
    // 本身把 vue/no-v-html 设成 'warn'，项目块必须把它顶到 'error' 才算真的恢复报警。
    let effective: unknown
    for (const block of flats) {
      const raw = block?.rules?.['vue/no-v-html']
      if (raw === undefined) continue
      const v = Array.isArray(raw) ? String(raw[0]) : String(raw)
      // 任何一段都不许把它设成 off/0（eslint-plugin-vue 自带的 'warn' 段允许存在，
      // 因为后面的项目块会覆盖它 —— 覆盖关系由下面的 effective 断言兜住）
      expect(v, `某段配置把规则设成了 off/0：${v}`).not.toMatch(/^(off|0|false)$/)
      effective = v
    }
    // flat config 语义：后声明覆盖先声明 ⇒ 最终生效值必须是 error
    expect(effective).toBe('error')
  })
})

describe('escapeHtmlText', () => {
  it('5 个敏感字符全部转义', () => {
    expect(escapeHtmlText(`<a href="x">'&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;')
  })
  it('空值不抛异常', () => {
    expect(escapeHtmlText(undefined as unknown as string)).toBe('')
    expect(escapeHtmlText(null as unknown as string)).toBe('')
  })
})

describe('highlightTemplateVars —— 模板 {{变量}} chip（命中点 5/6/7）', () => {
  for (const p of XSS_PAYLOADS) {
    it(`payload 不会造出活标签: ${p.slice(0, 30)}`, () => {
      assertOnlyAllowedTags(highlightTemplateVars(p), ['<span class="var-hl">', '</span>'])
    })
  }

  it('「提前闭合 span」的变量名仍被封在文本里', () => {
    const out = highlightTemplateVars('{{a</span><img src=x onerror=alert(1)>}}')
    assertOnlyAllowedTags(out, ['<span class="var-hl">', '</span>'])
    expect(out.match(/<span class="var-hl">/g)?.length).toBe(1)
    expect(out.match(/<\/span>/g)?.length).toBe(1)
  })

  it('功能未被安全吃掉：chip 照常产出、变量名照常显示', () => {
    const out = highlightTemplateVars('Hi {{ name }}, 见 {{url}}')
    expect(out).toContain('<span class="var-hl">{{name}}</span>')
    expect(out).toContain('<span class="var-hl">{{url}}</span>')
    expect(out.startsWith('Hi ')).toBe(true)
  })

  it('默认压平换行；生成对话框（collapseWhitespace=false）保留换行', () => {
    expect(highlightTemplateVars('a\n b')).toBe('a b')
    expect(highlightTemplateVars('a\n b', false)).toContain('\n')
  })

  it('空内容返回空串', () => {
    expect(highlightTemplateVars('')).toBe('')
  })
})

describe('highlightSearchSnippet —— AI 搜索命中的 <mark>（命中点 2）', () => {
  it('snippet 里的 payload 只剩文本，注入的只有 <mark>', () => {
    for (const p of XSS_PAYLOADS) {
      assertOnlyAllowedTags(highlightSearchSnippet(p, 'alert'), ['<mark>', '</mark>'])
    }
  })

  it('命中确实被包进 <mark>（转义没有把功能吃掉）', () => {
    expect(highlightSearchSnippet('前面 敏感词 后面', '敏感词')).toBe('前面 <mark>敏感词</mark> 后面')
  })

  it('关键词含正则元字符：不抛异常、按字面匹配', () => {
    expect(highlightSearchSnippet('a(1)+b', 'a(1)+b')).toBe('<mark>a(1)+b</mark>')
  })

  it('关键词本身是 HTML 时两侧同走过转义 → 不产生活标签', () => {
    const out = highlightSearchSnippet('文本 <b>x</b> 尾巴', '<b>x</b>')
    assertOnlyAllowedTags(out, ['<mark>', '</mark>'])
    expect(out).toBe('文本 <mark>&lt;b&gt;x&lt;/b&gt;</mark> 尾巴')
  })

  it('内容自带 \\u0001 控制字符不会凭空多出 <mark>（旧哨兵实现的回归）', () => {
    const out = highlightSearchSnippet('\u0001abc\u0002', 'abc')
    expect(out.match(/<mark>/g)?.length).toBe(1)
    expect(out.match(/<\/mark>/g)?.length).toBe(1)
  })

  it('空关键词 → 纯转义文本，不加标签', () => {
    expect(highlightSearchSnippet('a<b', '   ')).toBe('a&lt;b')
  })
})

describe('pptxSlideTextLines —— PPTX 文本提取（命中点 11 的 producer）', () => {
  it('文件里直接写原始标签：提取不到任何文本（不会变成数据）', () => {
    expect(pptxSlideTextLines('<a:t><img src=x onerror=alert(1)></a:t>')).toEqual([])
    expect(pptxSlideTextLines('<a:t><script>alert(1)</script></a:t>')).toEqual([])
  })

  it('实体编码的 payload：解出来是纯文本，按文本插值渲染后没有活标签', () => {
    const lines = pptxSlideTextLines('<a:t>&lt;img src=x onerror=alert(1)&gt;</a:t>')
    expect(lines).toEqual(['<img src=x onerror=alert(1)>'])
    // 这就是 PptxPreview 的渲染方式：{{ line }} 由 Vue 转义，等价于 escapeHtmlText
    assertOnlyAllowedTags(escapeHtmlText(lines[0]), [])
  })

  it('数字实体也解回字符，且只当数据（不再被当标签起点）', () => {
    const lines = pptxSlideTextLines('<a:t>&#60;script&#62;alert(1)&#60;/script&#62;</a:t>')
    expect(lines).toEqual(['<script>alert(1)</script>'])
    assertOnlyAllowedTags(escapeHtmlText(lines[0]), [])
  })

  it('&amp;lt; 只解一层，不会二次解码成 <', () => {
    expect(pptxSlideTextLines('<a:t>&amp;lt;script&amp;gt;</a:t>')).toEqual(['&lt;script&gt;'])
  })

  it('正常 slide：按文档顺序提取非空文本行', () => {
    const xml =
      '<p><a:t>标题</a:t></p><a:tbl><a:t>第一行</a:t><a:t>   </a:t><a:t>第二行</a:t><a:t>tail</a:t></a:tbl>'
    expect(pptxSlideTextLines(xml)).toEqual(['标题', '第一行', '第二行', 'tail'])
  })

  it('空/无文本输入返回 []（调用方据此显示占位文案）', () => {
    expect(pptxSlideTextLines('')).toEqual([])
    expect(pptxSlideTextLines('<p><a:r><a:t></a:t></a:r></p>')).toEqual([])
  })
})
