import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * 多页模式：主页 index.html + 404.html（T-W1，构建后位于 dist 根，供静态托管直接配置
   * error_page / GitHub Pages / CNB Pages 自动识别）。
   * 404.html 为零 JS 独立页（自包含内联样式，token 摘自 styles/tokens.css）。
   * 注：相对路径由 Vite 以项目 root 解析；不引 node:path/node:url，
   * 使 devDependencies 严格保持 vite + typescript 两项（无需 @types/node）。
   */
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        '404': '404.html',
      },
    },
  },
});
