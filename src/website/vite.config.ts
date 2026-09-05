import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * 多页模式：当前官网 v1 为单页（index.html），
   * rollupOptions.input 以对象形式预留多页扩展点（未来可加 changelog.html / guide.html 等，
   * 见 design/04-官网开发工程方案.md §1「未来可无痛加页」）。
   * 注：相对路径由 Vite 以项目 root 解析；不引 node:path/node:url，
   * 使 devDependencies 严格保持 vite + typescript 两项（无需 @types/node）。
   */
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
});
