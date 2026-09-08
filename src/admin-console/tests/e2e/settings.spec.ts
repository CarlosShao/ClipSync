import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 系统设置写操作闭环（自带还原，写操作串行由 playwright workers=1 保证）：
 * 1. 系统参数回填非空（AF-01 回归：Form.Item 脱离 FormContext 会导致回填失效）
 * 2. 修改 ai_max_tokens → 保存（PATCH 200）→ 恢复原值 → 再次保存（PATCH 200）
 * 3. 功能开关「注册审核」切换 → PATCH 200 → 切回原状态 → PATCH 200
 */

const AI_MAX_TOKENS_URL = '/api/admin/configs/ai_max_tokens';
const SIGNUP_WAITLIST_URL = '/api/admin/flags/signup_waitlist';

function patchOk(url: string) {
  return (resp: { url(): string; request(): { method(): string } }) =>
    resp.url().includes(url) && resp.request().method() === 'PATCH';
}

test.describe('系统设置写操作闭环', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('系统参数回填：ai_max_tokens 输入框 value 非空（AF-01）', async ({ page }) => {
    await page.goto('/settings');
    const input = page.locator('#ai_max_tokens');
    await expect(input).toBeVisible();
    await expect(input).not.toHaveValue('');
  });

  test('修改 ai_max_tokens 保存成功并恢复原值', async ({ page }) => {
    await page.goto('/settings');
    const input = page.locator('#ai_max_tokens');
    await expect(input).toBeVisible();
    const original = (await input.inputValue()).trim();
    expect(original).not.toBe('');

    // 「AI 能力」卡内的保存按钮（antd Card head-title 为稳定类名）
    const aiCard = page
      .locator('.ant-card')
      .filter({ has: page.locator('.ant-card-head-title', { hasText: 'AI 能力' }) });
    const saveBtn = aiCard.getByRole('button', { name: '保存（记入审计）' });
    await expect(saveBtn).toBeVisible();

    // 修改 = 原值 + 1 → 保存 → 断言 PATCH ai_max_tokens 200
    const changed = String(Number(original) + 1);
    const patch1 = page.waitForResponse((r) => patchOk(AI_MAX_TOKENS_URL)(r) && r.status() === 200);
    await input.fill(changed);
    await saveBtn.click();
    await patch1;

    // 恢复原值 → 再次保存 → PATCH 200
    const patch2 = page.waitForResponse((r) => patchOk(AI_MAX_TOKENS_URL)(r) && r.status() === 200);
    await input.fill(original);
    await saveBtn.click();
    await patch2;
  });

  test('功能开关：注册审核切换成功并切回原状态', async ({ page }) => {
    await page.goto('/settings');

    // 功能开关行：内层同时包含「注册审核」名称与 Switch 的 div（不依赖 CSS Modules 哈希类名）
    const row = page
      .locator('div')
      .filter({ has: page.getByText('注册审核', { exact: true }) })
      .filter({ has: page.locator('.ant-switch') })
      .last();
    const sw = row.locator('.ant-switch');
    await expect(sw).toBeVisible();

    const initial = await sw.getAttribute('aria-checked');
    expect(initial === 'true' || initial === 'false').toBe(true);

    // 切换 → PATCH signup_waitlist 200
    const patch1 = page.waitForResponse((r) => patchOk(SIGNUP_WAITLIST_URL)(r) && r.status() === 200);
    await sw.click();
    await patch1;

    // 等开关退出 loading（mutation 未结算时 antd Switch 处于禁用态）
    await expect(sw).toBeEnabled();

    // 切回原状态 → 再次 PATCH 200，且最终状态与初始一致
    const patch2 = page.waitForResponse((r) => patchOk(SIGNUP_WAITLIST_URL)(r) && r.status() === 200);
    await sw.click();
    await patch2;

    await expect(sw).toHaveAttribute('aria-checked', initial as string);
  });
});
