// === 上传配额 413 提示 + 升级引导（工单 F3.1）===
// 后端 media.js / chunked-upload.js 在套餐配额拒绝时统一返回 413 + quotaHttpBody：
//   { error, code, limit, current, plan, upgradeTo }
//   code ∈ FILE_SIZE_EXCEEDED（字节）/ TOO_MANY_FILES（个数）/
//          FILE_TOTAL_EXCEEDED（字节）/ STORAGE_QUOTA_EXCEEDED（字节）
//   upgradeTo ∈ 'Pro' | 'Enterprise' | null（后端 UPGRADE_PATH：Free→Pro、Pro→Enterprise）
// 本模块职责：
//   1. handleQuotaResponse(err)：识别结构化 413（api()/apiForm() 的 ApiResponse）或
//      chunked init 抛错（initUpload throw 后 body 被丢，按后端固定英文文案反查 code），
//      按 code 弹「升级引导」toast；返回 true 表示已处理，调用方跳过通用 upload_fail。
//   2. 24h 节流：同一 code 24h 内最多弹 1 次。节流只控制弹窗；localOnly 兜底与
//      条目标记由调用方每次照常执行，本函数不干预条目状态。
//   3. markHandledQuota / isHandledQuotaError：uploadFileItem 内已提示的 413 在
//      throw 给 useFileUpload 时打标记，避免同一错误双 toast。
// 提示形态：vue-sonner warning toast + action 按钮（升级 → /app/subscription），
// 不引入新依赖（vue-sonner 为项目既有依赖，v2 原生支持 action）。
// 红线遵守：升级收益数值一律来自 GET /api/subscriptions/plans，绝不硬编码。
import { toast } from 'vue-sonner'
import router from '@/router'
import { api } from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import { useConfigStore } from '@/stores/configStore'
import { getPlanLimits, getUpgradePlanBenefits } from './usePlanLimits'

const QUOTA_CODES = [
  'FILE_SIZE_EXCEEDED',
  'TOO_MANY_FILES',
  'FILE_TOTAL_EXCEEDED',
  'STORAGE_QUOTA_EXCEEDED',
] as const
export type QuotaCode = (typeof QUOTA_CODES)[number]

// 后端 planLimits.js QUOTA_ERROR_MESSAGES 的固定英文文案：chunked 分片路径的
// /api/upload/init 返回 413 后被 initUpload throw 成 Error（body 丢失），
// 只能按 message 反查 code 做降级识别。后端改文案只会让识别退化为 false
//（走通用 upload_fail），不会误报。
const SERVER_QUOTA_MESSAGES: Record<QuotaCode, string> = {
  FILE_SIZE_EXCEEDED: 'File exceeds the maximum size allowed for your plan',
  TOO_MANY_FILES: 'Too many files for a single upload on your plan',
  FILE_TOTAL_EXCEEDED: 'Total upload size exceeds the limit for your plan',
  STORAGE_QUOTA_EXCEEDED: 'Storage quota exceeded, please delete files or upgrade your plan',
}

export interface QuotaNoticeCtx {
  /** 批次首个 / 当前文件名（quotaHttpBody 不含文件名，由调用方补充） */
  fileName?: string
  /** 本次文件个数（FILE_TOTAL_EXCEEDED 的 {count} 参数，body 的 current 是字节） */
  fileCount?: number
  /** 当前文件字节数（Error 降级路径丢失 body.current 时兜底 size 参数） */
  sizeBytes?: number
}

// 24h 提示节流。key 对齐项目既有 clipsync- 前缀 kebab 风格
//（clipsync-device-id / clipsync-chunked-upload 等）；
// 独立命名空间，绝不触碰 recentUploadHashes 上传去重节流。
const NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000
const noticeKey = (code: QuotaCode) => `clipsync-quota-notice-${code}`

function shouldNotify(code: QuotaCode): boolean {
  try {
    const ts = Number(localStorage.getItem(noticeKey(code)) || 0)
    return !ts || Date.now() - ts >= NOTICE_THROTTLE_MS
  } catch {
    return true
  }
}

function markNotified(code: QuotaCode): void {
  try {
    localStorage.setItem(noticeKey(code), String(Date.now()))
  } catch {
    /* localStorage 不可用时放弃节流（每次都提示，仍不阻塞上传流程） */
  }
}

/** 字节数 → 人类可读（B/KB/MB/GB），存储 20GB 级别不至于显示成 20480MB。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** MB → 展示串：≥1024MB 折算 GB（20480MB → 20GB），与升级收益文案一致。 */
function fmtMb(mb: number): string {
  if (!Number.isFinite(mb)) return '∞'
  return mb >= 1024 ? `${Number((mb / 1024).toFixed(1))}GB` : `${mb}MB`
}

/** Error 降级路径的当前套餐名（configStore.user 由 fetchUserProfile 维护，缺省 Free）。 */
function currentPlanName(): string {
  try {
    return String(useConfigStore().user?.plan || 'Free')
  } catch {
    return 'Free'
  }
}

/**
 * 下一档推断（仅 Error 降级路径用；与后端 planLimits.js UPGRADE_PATH 同构：
 * Free→Pro、Pro→Enterprise）。未知套餐名保守返回 null → 按钮退化为「知道了」，
 * 绝不给用户展示无法兑现的收益数值（数值真实来源仍是 /api/subscriptions/plans）。
 */
function inferUpgradeTo(planName: string): string | null {
  const key = planName.toLowerCase()
  if (key === 'free') return 'Pro'
  if (key === 'pro') return 'Enterprise'
  return null
}

/** 已处理的配额错误标记：uploadFileItem 内已提示，上层 catch 不再重复 toast。 */
const HANDLED_QUOTA = new WeakSet<object>()
export function markHandledQuota<T>(e: T): T {
  if (typeof e === 'object' && e !== null) HANDLED_QUOTA.add(e as object)
  return e
}
export function isHandledQuotaError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && HANDLED_QUOTA.has(e as object)
}

/** 识别输入是否为结构化 413（api()/apiForm() 的 ApiResponse 鸭子类型：{ status, data }）。 */
function asQuotaBody(e: unknown): Record<string, any> | null {
  if (typeof e !== 'object' || e === null) return null
  const anyErr = e as { status?: unknown; data?: unknown }
  if (anyErr.status !== 413 || typeof anyErr.data !== 'object' || anyErr.data === null) return null
  const body = anyErr.data as Record<string, unknown>
  return (QUOTA_CODES as readonly string[]).includes(String(body.code)) ? body : null
}

/** Error 降级路径：message 反查后端固定文案 → code。 */
function asQuotaError(e: unknown): QuotaCode | null {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (!msg) return null
  for (const code of QUOTA_CODES) {
    if (msg.includes(SERVER_QUOTA_MESSAGES[code])) return code
  }
  return null
}

/** 升级按钮：label 写明下一档收益（数值来自 /api/subscriptions/plans）；拿不到时退化为不带数值的文案。 */
async function buildUpgradeAction(
  upgradeTo: string | null | undefined,
): Promise<{ label: string; onClick: (e: MouseEvent) => void } | null> {
  const target = upgradeTo ? String(upgradeTo).trim() : ''
  if (!target) return null
  const benefits = await getUpgradePlanBenefits(target).catch(() => null)
  const { t } = useI18n()
  const label = benefits
    ? t('quota_upgrade_with_benefits', {
        name: benefits.name || target,
        fileLimit: fmtMb(benefits.maxFileSizeMb),
        storageLimit: fmtMb(benefits.maxStorageMb),
      })
    : t('quota_upgrade_generic')
  return {
    label,
    onClick: () => {
      router.push('/app/subscription')
    },
  }
}

/** Error 降级路径：从本地套餐限额缓存（5min TTL）近似恢复限制值展示串；拿不到返回空串。 */
async function localLimitText(key: 'maxFileSizeMb' | 'maxFilesPerClip'): Promise<string> {
  try {
    const limits = await getPlanLimits()
    const v = limits[key]
    if (!Number.isFinite(v)) return ''
    return key === 'maxFileSizeMb' ? fmtMb(v) : String(v)
  } catch {
    return ''
  }
}

/**
 * 按 code 构造主提示文案（工单 F3.1 文案表）。
 * - body 路径：limit/current/plan/upgradeTo 全部来自服务端 413 响应体，权威准确；
 * - Error 降级路径（chunked init 413 丢 body）：plan 取 configStore、limit 取本地
 *   套餐限额缓存（5min TTL 可能滞后，仅提示用）、size 取调用方传入的 sizeBytes；
 *   参数仍拼不齐时退化为 quota_error_generic，绝不显示残缺句子。
 */
async function buildMainText(
  code: QuotaCode,
  body: Record<string, any> | null,
  ctx: QuotaNoticeCtx,
): Promise<string> {
  const { t } = useI18n()
  const plan = body?.plan != null ? String(body.plan) : currentPlanName()

  switch (code) {
    case 'FILE_SIZE_EXCEEDED': {
      const size = body?.current ?? ctx.sizeBytes
      const limit = body?.limit != null ? formatBytes(Number(body.limit)) : await localLimitText('maxFileSizeMb')
      if (size == null || !limit || !ctx.fileName) return t('quota_error_generic')
      return t('quota_file_size_exceeded', {
        fileName: ctx.fileName,
        size: formatBytes(Number(size)),
        plan,
        limit,
      })
    }
    case 'TOO_MANY_FILES': {
      // limit 是文件个数（quotaHttpBody 对该码回 limitCount）
      if (body?.limit == null) return t('quota_error_generic')
      return t('quota_too_many_files', { limit: String(body.limit), plan })
    }
    case 'FILE_TOTAL_EXCEEDED': {
      const total = body?.current
      const limit = body?.limit
      if (total == null || limit == null || !ctx.fileCount) return t('quota_error_generic')
      return t('quota_file_total_exceeded', {
        count: String(ctx.fileCount),
        total: formatBytes(Number(total)),
        plan,
        limit: formatBytes(Number(limit)),
      })
    }
    case 'STORAGE_QUOTA_EXCEEDED': {
      if (body?.limit == null) return t('quota_error_generic')
      const quota = formatBytes(Number(body.limit))
      // used 不在 quotaHttpBody 里（current 是本次请求字节），从 /api/subscriptions/current
      // 的 storageUsedMb（F0.3 已下发）补齐；拉取失败退化显示满格（"已满"语义仍成立）
      let used = quota
      try {
        const cur = await api('GET', '/api/subscriptions/current')
        if (cur.ok && cur.data?.storageUsedMb != null) {
          used = formatBytes(Number(cur.data.storageUsedMb) * 1024 * 1024)
        }
      } catch {
        /* 退化满格 */
      }
      return t('quota_storage_exceeded', { used, quota })
    }
    default:
      return t('quota_error_generic')
  }
}

/**
 * 识别上传失败中的 413 配额拒绝并弹出升级引导。
 *
 * @param err api()/apiForm() 的失败响应（{ status: 413, data: quotaHttpBody }）
 *            或 chunked init 抛出的 Error（按后端固定文案反查）
 * @param ctx  调用方补充的上下文（文件名 / 文件数 / 字节数）
 * @returns true = 已识别为配额拒绝（弹窗受 24h 节流），调用方跳过通用 upload_fail，
 *          并照常执行 localOnly 兜底；false = 非 413 配额错误，走原失败提示。
 */
export async function handleQuotaResponse(err: unknown, ctx: QuotaNoticeCtx = {}): Promise<boolean> {
  const body = asQuotaBody(err)
  const code: QuotaCode | null = body ? ((body.code as QuotaCode) ?? null) : asQuotaError(err)
  if (!code) return false

  // 24h 节流：同一 code 命中节流时静默返回 true（仍算"已处理"，跳过 upload_fail）
  if (!shouldNotify(code)) return true
  markNotified(code)

  const mainText = await buildMainText(code, body, ctx)
  // 升级按钮：upgradeTo 由 413 body 权威下发；Error 降级路径按当前套餐名推断
  const upgradeTo = body ? (body.upgradeTo ?? null) : inferUpgradeTo(currentPlanName())
  const upgradeAction = await buildUpgradeAction(upgradeTo)
  const { t } = useI18n()
  const action = upgradeAction ?? { label: t('quota_ok'), onClick: () => {} }

  toast.warning(mainText, { action, duration: 8000 })
  return true
}
