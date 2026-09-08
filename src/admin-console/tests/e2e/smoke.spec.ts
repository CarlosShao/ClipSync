import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * E2E 冒烟（真实后端 + 真实登录）：
 * 全部断言为相对断言（元素可见 / 行数 ≥ 1 / 计数 ≥ 0），不写死任何业务数值。
 */

test.describe('admin console 冒烟（真实后端）', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('dashboard：看板可达且渲染 KPI 卡', async ({ page }) => {
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: '数据看板' })).toBeVisible();

    // KPI 卡（首个 KPI 标签为静态文案，与数据无关）+ 页面至少渲染一张 antd Card
    await expect(page.getByText('注册用户', { exact: true })).toBeVisible();
    await expect(page.locator('.ant-card').first()).toBeVisible();
  });

  test('users：用户表格渲染至少一行', async ({ page }) => {
    await page.goto('/users');
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();

    const rows = page.locator('.ant-table-tbody tr.ant-table-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
  });

  test('orders：状态 Tabs 计数渲染且表格（或空态）渲染', async ({ page }) => {
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: '订单与支付' })).toBeVisible();

    const allTab = page.locator('.ant-tabs-tab', { hasText: '全部' });
    await expect(allTab).toBeVisible();

    // 「全部」计数徽标为数字且 ≥ 0（相对断言，不写死业务数值）
    const countText = (await allTab.locator('[class*="tabCount"]').innerText()).trim();
    expect(Number(countText.replace(/,/g, ''))).toBeGreaterThanOrEqual(0);

    // antd Table 即使无数据也会渲染表格骨架（空态在表格内），可见即通过
    await expect(page.locator('.ant-table')).toBeVisible();
  });

  test('audit：审计表格渲染且导出 CSV 入口可见', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();

    await expect(page.locator('.ant-table')).toBeVisible();
    await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  });
});
