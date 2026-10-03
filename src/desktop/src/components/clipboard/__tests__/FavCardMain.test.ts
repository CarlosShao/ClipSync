// @vitest-environment jsdom
// === 证据：收藏网格卡「底栏贴底 + 受保护内容改掩码黑点」 ===
//
// 用户反馈：
//  ① 「84d ago 这一行高低不一」「Protected/Unlock 灰色大块把个别卡片撑得很高」「同排卡片上下边界不齐」；
//  ② 「这既然是文字的保密，那就变成密码那种隐身的不就行了，变一个个黑点」（灰块 + 锁图标被否）。
//
// 本文件在**新抽出的展示组件 FavCardMain.vue** 上做真实 DOM 断言（业务逻辑仍在 FavoritesView：
// 解锁事件仍由父组件 openProtectionDialog 处理，本文件用源码断言钉住这层接线）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useI18n } from '@/composables/useI18n'
import FavCardMain from '@/components/clipboard/FavCardMain.vue'

const SECRET = 'ULTRA-SECRET-CONTENT-9f3c1a'
const cssSrc = () => readFileSync(resolve(process.cwd(), 'src/components/clipboard/favorites-view.css'), 'utf8')
/** 去掉注释再匹配（注释里也会出现 `}`，如 `.fav-card{height:100%}` 的说明） */
const cssNoComments = () => cssSrc().replace(/\/\*[\s\S]*?\*\//g, '')
const viewSrc = () => readFileSync(resolve(process.cwd(), 'src/components/clipboard/FavoritesView.vue'), 'utf8')

function mountCard(props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(FavCardMain as never, props as never) })
  app.mount(host)
  return {
    host,
    text: () => host.textContent || '',
    q: <T extends Element>(sel: string) => host.querySelector<T>(sel),
    unmount() {
      app.unmount()
      host.remove()
    },
  }
}

const baseProps = (over: Record<string, unknown> = {}) => ({
  type: 'text',
  locked: false,
  contentText: '',
  source: 'Desktop',
  timeText: '84d ago',
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  useI18n().setLang('en')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('网格卡：受保护内容 = 密码掩码', () => {
  it('① 受保护卡片渲染掩码黑点，且**整个卡片 DOM 不含真实内容**（安全底线）', () => {
    const m = mountCard(baseProps({ locked: true, contentText: SECRET }))
    const body = m.q<HTMLElement>('.fav-card-body')!
    expect(body.textContent || '').toContain('•')
    expect(m.text(), '真实内容绝不能进 DOM').not.toContain(SECRET)
    expect(m.text()).not.toContain('ULTRA-SECRET')
    // 掩码与普通预览同字号/行高（同一套 .fav-card-text ⇒ 高度自然接近）
    expect(m.q('.fav-card-mask')!.classList.contains('fav-card-text')).toBe(true)
    // 未解锁时不渲染任何正文分支
    expect(body.querySelector('.fav-card-link, .fav-card-file')).toBeNull()
    m.unmount()
  })

  it('② 不再渲染旧的大灰块 / Protected 按钮 / 锁图标 chip', () => {
    const m = mountCard(baseProps({ locked: true, contentText: SECRET }))
    expect(m.q('.cell-protected-mask')).toBeNull() // 旧通栏灰块
    expect(m.q('.fav-card-lock-chip')).toBeNull() // 旧锁图标 chip
    expect(m.q('.fav-card-body button')).toBeNull() // 旧「Unlock」按钮（现在只在底栏）
    m.unmount()
  })

  it('③ 「已保护」出现在**底部信息行**里（不额外占高、不用徽标）', () => {
    const m = mountCard(baseProps({ locked: true }))
    const meta = m.q<HTMLElement>('.fav-card-meta')!
    expect(meta.textContent).toContain('Protected')
    expect(meta.querySelector('[data-protected-note]')).toBeTruthy()
    // 状态小字不在内容区里
    expect(m.q<HTMLElement>('.fav-card-body')!.textContent).not.toContain('Protected')
    // 时间仍在底栏（贴底那条线上）
    expect(meta.textContent).toContain('84d ago')
    m.unmount()
  })

  it('④ 解锁入口：底栏纯文字按钮，默认不可见、hover/focus 出现，点击触发**原有**解锁逻辑', async () => {
    const m = mountCard(baseProps({ locked: true }))
    const btn = m.q<HTMLButtonElement>('.fav-card-meta [data-unlock]')
    expect(btn, '底栏应有解锁按钮').toBeTruthy()
    expect(btn!.textContent).toContain('Unlock')

    // 默认不占常驻视觉：CSS 里 opacity:0 + pointer-events:none，hover / focus-within 才显示（≤150ms）
    const css = cssSrc()
    const rule = css.match(/\.fav-card-unlock\s*\{[^}]*\}/)
    expect(rule, '应有 .fav-card-unlock 规则').toBeTruthy()
    expect(rule![0]).toContain('opacity: 0')
    expect(rule![0]).toContain('pointer-events: none')
    expect(rule![0]).toContain('150ms')
    expect(css).toContain('.fav-card:hover .fav-card-unlock')
    expect(css).toContain('.fav-card:focus-within .fav-card-unlock')

    // 点击 → emit('unlock')；父组件把它接到原有 openProtectionDialog（业务不动）
    btn!.click()
    await nextTick()
    expect(btn!.textContent).toContain('Unlock') // 仍在（父组件决定后续流程）
    expect(viewSrc()).toContain('@unlock="openProtectionDialog(item)"')

    // 未受保护的卡片没有解锁按钮/状态小字
    const plain = mountCard(baseProps({ contentText: 'hello' }))
    expect(plain.q('[data-unlock]')).toBeNull()
    expect(plain.q('[data-protected-note]')).toBeNull()
    plain.unmount()
    m.unmount()
  })

  it('⑤ 布局：同排等高 + 底栏贴底 + 预览统一 3 行（源码/类名断言，不做像素断言）', () => {
    const css = cssNoComments()
    expect(css).toMatch(/\.fav-grid\s*\{[^}]*align-items:\s*stretch/)
    expect(css).toMatch(/\.fav-card\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/\.fav-card-meta\s*\{[^}]*margin-top:\s*auto/)
    expect(css).toMatch(/\.fav-card-text\s*\{[^}]*-webkit-line-clamp:\s*3/)
    expect(css).not.toMatch(/\.fav-grid\s*\{[^}]*align-items:\s*start/)

    // 卡片结构：内容区 + 底栏（底栏在内容区之后 ⇒ 天然是"底部信息行"）
    const m = mountCard(baseProps({ contentText: 'hello world' }))
    expect(Array.from(m.host.children).map((el) => el.className)).toEqual(['fav-card-body', 'fav-card-meta'])
    m.unmount()
  })

  it('⑥ 回归：不受保护的普通卡片照常渲染正文（text / link / image）', () => {
    const text = mountCard(baseProps({ contentText: '一个普通文本条目' }))
    expect(text.text()).toContain('一个普通文本条目')
    expect(text.q('.fav-card-mask')).toBeNull()
    text.unmount()

    const link = mountCard(
      baseProps({ type: 'link', contentText: 'https://a.example/x', isLink: true, domain: 'a.example' }),
    )
    expect(link.q('.fav-card-link')).toBeTruthy()
    expect(link.text()).toContain('a.example')
    link.unmount()

    const img = mountCard(baseProps({ type: 'image', preview: 'data:image/png;base64,AAA' }))
    expect(img.q('.fav-card-media-img')).toBeTruthy()
    expect(img.q('.fav-card-body--media')).toBeTruthy()
    img.unmount()
  })
})
