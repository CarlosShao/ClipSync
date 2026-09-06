/**
 * 审计详情解析：契约中 AuditLog.details 为摘要字符串（后端 audit_logs.details JSONB 落库前
 * 的展示形态，如 `amount=9.90, reason="用户重复支付"`）。
 * 详情弹窗统一以 JSON 形式展示：优先按 JSON 解析；否则按 key=value 摘要语法转成对象。
 */
export function parseDetailsToJson(details: string): Record<string, unknown> {
  const trimmed = details.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非 JSON，走 key=value 摘要解析
    }
  }

  const out: Record<string, unknown> = {};
  // key=value 摘要：值可为带引号短语（可含逗号）或裸词，以逗号分隔
  const pairRe = /([\w.-]+)\s*=\s*("([^"]*)"|[^\s,]+(?: [^\s,]+)*)/g;
  for (const match of details.matchAll(pairRe)) {
    const key = match[1];
    if (!key) continue;
    const quoted = match[3];
    out[key] = quoted !== undefined ? quoted : (match[2] ?? '').trim();
  }
  return out;
}
