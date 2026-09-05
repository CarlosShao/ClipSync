import type { ThemeConfig } from 'antd';

/**
 * antd 主题单一来源（03 方案 §5）
 * 视觉基线：design/mockups/admin-v2-light.html（Daylight 亮色）
 */
export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: '#5a4bd1',
    colorInfo: '#5a4bd1',
    colorLink: '#5a4bd1',
    borderRadius: 8,
    colorBgLayout: '#f4f5fa',
    colorTextBase: '#22252e',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  components: {
    Table: {
      headerBg: '#f7f8fc',
    },
    Card: {
      headerFontSize: 14,
    },
  },
};
