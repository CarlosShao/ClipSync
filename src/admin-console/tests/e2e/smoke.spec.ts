import { expect, test } from '@playwright/test';

/**
 * E2E 冒烟 5 步（登录 → 看板 → 用户列表 → 开抽屉 → 退款弹窗）
 *
 * 当前状态：注释态（test.skip），原因：
 * 1. 需要先 `npx playwright install chromium` 安装浏览器；
 * 2. 订单页退款弹窗将在 Wave 3 T-A4 落地，第 5 步暂以页面骨架可达代替；
 * 3. MSW 模式下 `npm run dev` 即可支撑前 4 步真实运行。
 * 启用方式：删除各用例前的 test.skip 标注后 `npm run e2e`。
 */

// 统一注释态开关：置为 false 并安装浏览器后即可真跑
const SMOKE_ENABLED = false;

test.describe('admin console 冒烟', () => {
  test.skip(!SMOKE_ENABLED, 'E2E 冒烟为注释态：需 npx playwright install chromium 后放开');

  test('步骤 1：登录成功并跳转数据看板', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await page.getByPlaceholder('carlos@clipstream.work').fill('carlos@clipstream.work');
    await page.locator('input[type="password"]').fill('demo-password');
    await page.getByPlaceholder('——————').fill('482917');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: '数据看板' })).toBeVisible();
  });

  test('步骤 2：看板渲染 KPI 卡与待处理事项', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText('12,847', { exact: true })).toBeVisible();
    await expect(page.getByText('¥41,286')).toBeVisible();
    await expect(page.getByText('¥12,480')).toBeVisible();
    await expect(page.getByText('348', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '待处理事项' })).toBeVisible();
    await expect(page.getByText('退款申请待审核 × 2')).toBeVisible();
    // ECharts 柱状图 canvas 已渲染
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('步骤 3：用户列表展示与筛选栏', async ({ page }) => {
    await page.goto('/users');
    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    await expect(page.getByText('林清和')).toBeVisible();
    await expect(page.getByText('chen_ming')).toBeVisible();
    await expect(page.getByPlaceholder('搜索手机号 / 昵称 / 用户 ID')).toBeVisible();
  });

  test('步骤 4：行点击打开用户抽屉（资料 / 设备 / 审计时间线）', async ({ page }) => {
    await page.goto('/users');
    await page.getByText('林清和').first().click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('设备（4 台）')).toBeVisible();
    await expect(drawer.getByText('最近动态')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '停用账号' })).toBeVisible();
    // 打开停用确认弹窗（原因必填）
    await drawer.getByRole('button', { name: '停用账号' }).click();
    await expect(page.getByRole('heading', { name: '停用账号' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('步骤 5：订单页骨架可达（退款弹窗待 T-A4 后补充交互断言）', async ({ page }) => {
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: '订单与支付' })).toBeVisible();
    // TODO(T-A4): 订单表格渲染后在此打开「执行退款」弹窗并断言原因必填校验
  });
});
