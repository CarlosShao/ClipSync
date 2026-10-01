/**
 * fx 层主题变量守卫：用到的主题变量必须在**所有**主题块里存在，否则使用处必须带 fallback。
 *
 * 为什么要这个测试 —— 同一类 bug 已经犯了两次，而且都不是"样式调得不好看"，
 * 而是"变量在用户当前主题里根本不存在"：
 *   ① .pl-btn--acc 用 var(--accent-fg, #ffffff)：--accent-fg 在 16 个主题块里从未定义
 *      → 永远回退白色 → mono 暗色（accent 是浅色）下白底白字，按钮文字消失。
 *   ② FxSpringCheck 用 var(--border-strong)：它只定义在 html.theme-clearline.light/.dark
 *      两个块里 → 其余 14 个主题下 var() 解析失败，整条 box-shadow 成为无效声明
 *      → 勾选框彻底不画（"能点但看不见"）。
 *
 * 规则：fx/ 下组件里每个 var(--x) 用法，要么 x 在每个主题块（或 :root 基础块）里都有定义，
 * 要么写法自带兜底 var(--x, <fallback>)。组件内联/局部定义的变量（--sc-* 等）不计入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// 用 fs 直接读源码：比 Vite 的 ?raw 稳定（?raw 读 .css 在整套跑时会被 tailwind 插件
// 处理成空串，单跑又正常 —— 这种随运行顺序变化的行为不能用来做守卫）。
const here = path.dirname(fileURLToPath(import.meta.url))
const FX_DIR = path.resolve(here, '..')
const GLOBALS = path.resolve(here, '../../../styles/globals.css')
const fxSources: Record<string, string> = Object.fromEntries(
  fs
    .readdirSync(FX_DIR)
    .filter((f: string) => f.endsWith('.vue'))
    .map((f: string) => [`../${f}`, fs.readFileSync(path.join(FX_DIR, f), 'utf8')]),
)

interface Block {
  selector: string
  vars: Set<string>
}

/** 解析 globals.css 的顶层块 → 各自定义的 CSS 变量。
 *  依赖该文件的排版约定：顶层选择器顶格且以 `{` 结尾（允许选择器跨行，如 ":root," 单独一行），
 *  块体内部的声明缩进，块以顶格的 `}` 结束。缩进的嵌套块（如 @media）因此被自然跳过。 */
function parseBlocks(css: string): Block[] {
  const lines = css.split(/\r?\n/)
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    // 块起始：从 i 起最多 3 行内出现顶格且以 { 结尾的行（前几行只能是选择器续行）
    let open = -1
    for (let j = i; j < lines.length && j <= i + 2; j++) {
      const raw = lines[j]
      if (!raw.trim()) continue
      if (/^\S/.test(raw) && raw.trim().endsWith('{')) {
        open = j
        break
      }
      // 续行必须是纯选择器文本（不含声明/注释/at-rule）
      if (raw.includes(';') || raw.trim().startsWith('@') || raw.includes('/*')) break
    }
    if (open < 0) {
      i++
      continue
    }
    const selector = lines
      .slice(i, open + 1)
      .join(' ')
      .slice(0, lines.slice(i, open + 1).join(' ').lastIndexOf('{'))
      .trim()
      .replace(/\s+/g, ' ')
    const vars = new Set<string>()
    let j = open + 1
    while (j < lines.length && !/^\}/.test(lines[j])) {
      for (const m of lines[j].matchAll(/(--[a-z0-9-]+)\s*:/g)) vars.add(m[1])
      j++
    }
    if (selector && !selector.startsWith('@') && vars.size > 0) blocks.push({ selector, vars })
    i = j + 1
  }
  return blocks
}

const css = fs.readFileSync(GLOBALS, 'utf8')
const blocks = parseBlocks(css)
// ":root, html.theme-xxx { … }" 这个块对 :root 生效 ⇒ 其中的变量在所有主题下都可用
const baseBlock = blocks.find((b) => b.selector.includes(':root'))
const themedBlocks = blocks.filter((b) => b !== baseBlock)

/** 该变量是否在所有主题下都存在（基础块里有，或在每个主题块里都有） */
function isUniversal(name: string): boolean {
  if (baseBlock?.vars.has(name)) return true
  return themedBlocks.length > 0 && themedBlocks.every((b) => b.vars.has(name))
}

const fxFiles = Object.keys(fxSources).map((k) => k.replace('../', ''))

describe('fx 主题变量守卫', () => {
  it('globals.css 能解析出主题块与 :root 基础块（守卫本身有效）', () => {
    expect(blocks.length).toBeGreaterThan(10)
    expect(baseBlock).toBeTruthy()
    expect(themedBlocks.length).toBeGreaterThan(10)
  })

  it('守卫逻辑自证：--border-strong 只在 clearline 两块里定义，必须被判为"非全主题"', () => {
    // 这条同时钉住了血泪教训 ② 的事实依据；若将来 clearline 的 token 被补齐成全主题，
    // 会在这里失败 —— 那时应当更新注释而不是删掉守卫。
    expect(isUniversal('--border-strong')).toBe(false)
    expect(isUniversal('--accent')).toBe(true)
    expect(isUniversal('--text-tertiary')).toBe(true)
    expect(isUniversal('--text-inverse')).toBe(true)
  })

  for (const file of fxFiles) {
    it(`${file}：用到的主题变量都有全主题定义，或自带 fallback`, () => {
      const raw = fxSources[`../${file}`] ?? ""
      // 先把注释剥掉：注释里出现的 var(--x) 只是说明文字，不构成真实依赖
      // （曾被误报：FxSpringCheck 的注释里写了 var(--border-strong)，StarBorder 的注释里写了 var(--primary)）
      // 注意：JS 的 // 行注释也要剥（前面要求空白或行首，避免误伤 https:// 这类 URL）
      const src = raw
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/[^\n]*/g, '$1')
      // 组件自己定义/内联设置的变量（含 <style> 块里的声明与 '--x': 赋值），不参与检查
      const local = new Set([
        ...[...src.matchAll(/(--[a-z0-9-]+)['"]?\s*:/g)].map((m) => m[1]),
        // 运行时经 setProperty 注入的（JellyRadio 用这种方式写 --jr-pad-x/y）也算组件自有
        ...[...src.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)/g)].map((m) => m[1]),
      ])

      const offenders = new Set<string>()
      for (const m of src.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)) {
        const name = m[1]
        const hasFallback = !!m[2]
        if (local.has(name) || hasFallback) continue
        if (!isUniversal(name)) {
          const missing = themedBlocks.filter((b) => !b.vars.has(name)).length
          offenders.add(`${name}（${missing}/${themedBlocks.length} 个主题块里没有定义，且使用处无 fallback）`)
        }
      }
      expect([...offenders]).toEqual([])
    })
  }
})
