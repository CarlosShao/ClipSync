import type { Page } from '@playwright/test';

/**
 * 真实登录 helper（验证码模式，dev 后端固定码）：
 * /login → 填手机号 → 发送验证码 → 等 1.2s（发送节流/提示渲染）→ 填验证码 → 提交 → 等 /dashboard
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');

  const phoneInput = page.locator('#login-phone-input');
  await phoneInput.waitFor({ state: 'visible' });
  await phoneInput.fill('13505110772');

  await page.getByRole('button', { name: '发送验证码' }).click();
  await page.waitForTimeout(1200);

  // 验证码输入框：maxlength=8（手机号框为 maxlength=11，不会误中）
  const codeInput = page.locator('input[maxlength="8"]');
  await codeInput.fill('888888');

  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}
