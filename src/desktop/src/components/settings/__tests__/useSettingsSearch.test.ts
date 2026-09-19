// === 设置页顶部全文搜索：纯匹配逻辑单测 ===
// matchRows 与 DOM 解耦（collectRows 负责把 .sg-row / .set-group > .gt 抽成行数据），
// 因此这里不需要 jsdom：直接喂抽取好的行数组，验证命中规则与排序/截断。
import { describe, expect, it } from 'vitest'
import { matchRows, type SearchRow } from '../useSettingsSearch'

const ROWS: SearchRow[] = [
  { label: '账单', hint: '', sectionKey: 'subscription', sectionLabel: '账单' },
  { label: '账单历史', hint: '查看发票和付款记录', sectionKey: 'subscription', sectionLabel: '账单' },
  { label: '自动同步', hint: 'Clipboard sync', sectionKey: 'general', sectionLabel: '通用' },
  { label: '界面语言', hint: '中文 / English', sectionKey: 'general', sectionLabel: '通用' },
  { label: '隐私模式', hint: '失焦时遮蔽敏感内容', sectionKey: 'privacy', sectionLabel: '隐私' },
]

describe('matchRows', () => {
  it('空查询与纯空白查询不产出结果（≥1 个有效字符才搜）', () => {
    expect(matchRows(ROWS, '')).toEqual([])
    expect(matchRows(ROWS, '   ')).toEqual([])
  })

  it('按名称/副标题命中，不区分大小写且忽略首尾空格', () => {
    expect(matchRows(ROWS, '  history ').map((r) => r.label)).toEqual([])
    expect(matchRows(ROWS, 'ENGLISH').map((r) => r.label)).toEqual(['界面语言'])
    expect(matchRows(ROWS, 'clipboard').map((r) => r.label)).toEqual(['自动同步'])
  })

  it('副标题与分组名也参与匹配（命中后带上所属分组用于下拉右侧展示）', () => {
    expect(matchRows(ROWS, '失焦').map((r) => r.label)).toEqual(['隐私模式'])
    // 分组标题「账单」命中 → 组标题行 + 组内所有行（其 sectionLabel 同为「账单」）
    expect(matchRows(ROWS, '账单').map((r) => r.label)).toEqual(['账单', '账单历史'])
  })

  it('按原 DOM 顺序输出并受 limit 截断', () => {
    const many: SearchRow[] = Array.from({ length: 40 }, (_, i) => ({
      label: `同步项 ${i}`,
      hint: '',
      sectionKey: 'general',
      sectionLabel: '通用',
    }))
    const out = matchRows(many, '同步项')
    expect(out).toHaveLength(30)
    expect(out[0]?.label).toBe('同步项 0')
    expect(matchRows(many, '同步项', 3)).toHaveLength(3)
  })

  it('无命中时返回空数组（界面据此显示「无匹配设置」）', () => {
    expect(matchRows(ROWS, 'zzz-nope')).toEqual([])
  })
})
