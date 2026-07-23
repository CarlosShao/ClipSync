// TSV / CSV 表格检测与解析工具
// 设计：表格预览是「渲染层」能力，不改变后端 content_type（content_type 列有
// CHECK 约束，且表格本质是文本的一种呈现方式）。检测与解析都在前端完成，
// 与既有 detectContentType('code'/'url') 仅影响渲染样式、不改 content_type 的思路一致。

export interface ParsedTable {
  delimiter: '\t' | ',' | ';'
  headers: string[]
  rows: string[][]
  hasHeader: boolean
}

/** 按分隔符拆分单行；逗号分隔支持引号包裹字段（标准 CSV）。 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  if (delimiter !== ',') {
    return line.split(delimiter).map((c) => c.trim())
  }
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

/**
 * 检测内容是否为表格（TSV / CSV / 分号分隔），并返回解析结果。
 * 非表格（普通文本、代码、URL）返回 null。
 *
 * 判定阈值：
 * - 至少 2 行、至少 2 列
 * - 多数行的列数一致（tab 容忍度 0.6，逗号/分号 0.7）
 * - 逗号/分号分隔需更强信号（一致列数 ≥3 或行数 ≥3），避免把带逗号的散文误判为表格
 */
export function parseTable(content: string): ParsedTable | null {
  if (!content || content.length < 4) return null
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return null

  const delimiters = ['\t', ',', ';'] as const
  for (const d of delimiters) {
    const rows = lines.map((l) => splitCsvLine(l, d))
    const colCounts = rows.map((r) => r.length)
    const maxCols = Math.max(...colCounts)
    if (maxCols < 2) continue

    // 模态列数（出现最多的列数）
    const freq: Record<number, number> = {}
    for (const c of colCounts) freq[c] = (freq[c] || 0) + 1
    const sorted = Object.entries(freq).sort((a, b) => Number(b[1]) - Number(a[1]))
    const modalCols = Number(sorted[0][0])
    const modalFreq = sorted[0][1]
    if (modalCols < 2) continue

    const ratio = modalFreq / lines.length
    const minRatio = d === '\t' ? 0.6 : 0.7
    if (ratio < minRatio) continue
    if (d !== '\t' && modalCols < 3 && lines.length < 3) continue

    const aligned = rows.filter((r) => r.length === modalCols)
    const first = aligned[0]

    // 首行是否为表头：数据行中存在「数值」而首行对应列为非数值，则视为表头
    let hasHeader = false
    const dataRows = aligned.slice(1)
    if (dataRows.length > 0) {
      for (let col = 0; col < modalCols; col++) {
        const headVal = (first[col] || '').trim()
        const headIsNum = /^-?\d+(\.\d+)?$/.test(headVal)
        const dataHasNum = dataRows.some((r) => /^-?\d+(\.\d+)?$/.test((r[col] || '').trim()))
        if (!headIsNum && dataHasNum) {
          hasHeader = true
          break
        }
      }
    }

    return {
      delimiter: d,
      headers: hasHeader ? first : [],
      rows: hasHeader ? dataRows : aligned,
      hasHeader,
    }
  }
  return null
}
