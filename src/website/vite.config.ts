import { defineConfig, loadEnv } from 'vite';

/**
 * ICP 备案号占位标记（T-W3）。
 * index.html 的 footer 里保留这对注释作为「锚点」，构建期在这里注入备案号；
 * 未配置时注入空串 —— 保证 <a> 与逗号分隔符都不产出，页面上不会出现空的
 * 「ICP备」字样，更不会出现假备案号。
 */
const ICP_ANCHOR = '<!--icp-filing-->';

/**
 * 从环境变量读取备案号。
 * 只读 loadEnv 的返回值（它已合并 .env 文件与进程环境），不直接引用 process ——
 * 该包刻意不装 @types/node（见下方注释），任何 node 全局都会让 tsc --noEmit 报 TS2591。
 */
function resolveIcpLicense(env: Record<string, string>): string {
  return (env.VITE_ICP_LICENSE || '').trim();
}

export default defineConfig(({ mode }) => {
  // 第三个参数传 '' 以加载全部前缀（默认只加载 VITE_ 前缀）
  const env = loadEnv(mode, '', '');
  const icpLicense = resolveIcpLicense(env);

  return {
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
    plugins: [
      {
        name: 'clipsync-icp-filing',
        /**
         * 构建期把备案号写进 footer 的锚点位置。
         * 已配置 → 渲染「<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">京ICP备XXXXXXXX号-1</a>」
         * 未配置 → 整段替换为空，footer 不会留下任何备案痕迹。
         */
        transformIndexHtml(html: string): string {
          const block = icpLicense
            ? ` · <a class="beian" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${icpLicense.replace(
                /[<>&"]/g,
                (c) =>
                  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string,
              )}</a>`
            : '';

          if (!html.includes(ICP_ANCHOR)) return html;
          return html.split(ICP_ANCHOR).join(block);
        },
      },
    ],
  };
});
