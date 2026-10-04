import type { AlipayStatus } from '@/api/ops';

/**
 * 「支付宝渠道状态」只读卡的文案与渲染分支（纯函数，便于单测）。
 *
 * 为什么把文案抽出来：这张卡唯一的价值是让运营一眼分清**三种**状态，且三者不得互相冒充——
 *   ① 凭据正常（能收钱）；② 凭据异常（收不了钱，逐条告诉他要改哪一项）；
 *   ③ 读取失败（管理台自己没读到，**不代表**渠道异常）。
 * ③ 若复用 ② 的文案，运营会把「读不到」误判成「渠道坏了」而去动生产环境变量。
 */

/** ok=true 的结论：渠道凭据齐全，用户能正常下单付款 */
export const ALIPAY_OK_TITLE = '支付宝渠道凭据正常';

/** ok=false 的结论：直接说清后果（用户当下付不了款），而不是只报「配置有误」 */
export const ALIPAY_BROKEN_TITLE = '支付宝渠道异常：当前无法收款';

/** ok=false 但服务端没给出条目时的兜底——不能让运营对着一张空白红卡无从下手 */
export const ALIPAY_NO_DETAIL_HINT =
  '服务端未返回具体原因：请核对 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY 是否齐全，改完重启 API 服务后回本页确认';

/**
 * 渲染用的 problem 列表：
 *  - ok=true 恒为空数组（调用方据此不渲染问题区）
 *  - 去掉服务端文案里的 markdown 粗体标记（`**…**`）：它是给日志/告警渠道看的，
 *    原样塞进页面会露出星号
 *  - 丢弃空白条目；全部为空时回落到兜底提示，避免 ok=false 却一片空白
 */
export function alipayProblemList(
  status: Pick<AlipayStatus, 'ok'> & { problems?: string[] | null }
): string[] {
  if (status.ok) return [];
  const problems = (status.problems ?? [])
    .map((item) => item.replace(/\*\*(.+?)\*\*/g, '$1').trim())
    .filter(Boolean);
  return problems.length > 0 ? problems : [ALIPAY_NO_DETAIL_HINT];
}
