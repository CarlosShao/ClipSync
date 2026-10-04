import { describe, expect, test } from 'vitest';
import { ALIPAY_NO_DETAIL_HINT, alipayProblemList } from './alipayStatus';

/**
 * 「支付宝渠道状态」卡的问题清单渲染分支。
 *
 * 锁三件事：ok=true 不渲染问题（成功态不能被问题区污染）、ok=false 逐条保留可操作信息、
 * 以及服务端文案里的 markdown 粗体不会把星号露到页面上（运营是照着条目改环境变量的）。
 */
describe('alipayProblemList —— 渠道异常问题清单', () => {
  test('ok=true 恒为空：成功态不渲染任何问题条目', () => {
    expect(alipayProblemList({ ok: true, problems: [] })).toEqual([]);
    // 服务端若在 ok=true 时仍带了残留条目，也不该展示（成功态以 ok 为准）
    expect(alipayProblemList({ ok: true, problems: ['不应展示'] })).toEqual([]);
  });

  test('ok=false 逐条保留：运营要照着条目改环境变量', () => {
    const problems = alipayProblemList({
      ok: false,
      problems: [
        'ALIPAY_PUBLIC_KEY 未配置 —— 回调无法验签，create-order 会拒绝收钱',
        'ALIPAY_PRIVATE_KEY 无法用于签名',
      ],
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('ALIPAY_PUBLIC_KEY 未配置');
    expect(problems[1]).toContain('无法用于签名');
  });

  test('去掉 markdown 粗体标记，页面不露星号（保留被强调的措辞）', () => {
    const [problem] = alipayProblemList({
      ok: false,
      problems: [
        'ALIPAY_PUBLIC_KEY 看起来是**应用公钥**（与 ALIPAY_PRIVATE_KEY 成对）——这里要填的是**支付宝公钥**',
      ],
    });
    expect(problem).not.toContain('**');
    expect(problem).toContain('看起来是应用公钥');
    expect(problem).toContain('要填的是支付宝公钥');
  });

  test('ok=false 但无有效条目（空数组 / 全空白 / 缺字段）→ 回落兜底，不留空白红卡', () => {
    expect(alipayProblemList({ ok: false, problems: [] })).toEqual([ALIPAY_NO_DETAIL_HINT]);
    expect(alipayProblemList({ ok: false, problems: ['  ', ''] })).toEqual([ALIPAY_NO_DETAIL_HINT]);
    expect(alipayProblemList({ ok: false })).toEqual([ALIPAY_NO_DETAIL_HINT]);
    expect(alipayProblemList({ ok: false, problems: null })).toEqual([ALIPAY_NO_DETAIL_HINT]);
  });
});
