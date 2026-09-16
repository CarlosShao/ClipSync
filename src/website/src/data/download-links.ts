/**
 * 官网下载链接单一来源（T-W1）。
 *
 * 卡片接线逻辑见 `src/main.ts` 的 initDownloadLinks()：
 *   - href 为真实 http(s) 地址 → 赋 href，新标签打开（自动带 noopener）
 *   - href 为 '#'（占位）      → 置禁用态并提示「即将开放」，不赋 href
 *
 * 接入真实产物时**只改本文件**，页面逻辑自动切换。
 *
 * ── 托管方式（2026-09-16 决策）──
 * 安装包托管在**自有域名** `https://www.clipchain.top/downloads/`，
 * 而不是 GitHub Releases。原因：
 *   1. GitHub 在国内访问不稳定，用户下载体验差；
 *   2. 支付宝「电脑网站支付」审核要求网站**有真实商品/交付物**，
 *      同域下载链接更直观；
 *   3. 审查时不必把用户引到第三方站。
 * 上传方式：`scp` 到服务器 `/opt/clipsync/downloads/`（nginx 以 /downloads/ 暴露）。
 * 发版流程见 `docs/deploy/production-server-runbook.md`。
 *
 * ⚠️ 文件名必须与 `npm run tauri build` 的真实产物一致，否则 404。
 * 当前产物：src-tauri/target/release/bundle/nsis/ClipSync_<version>_x64-setup.exe
 */

/** 自建下载站前缀（结尾无斜杠） */
const DOWNLOAD_BASE = 'https://www.clipchain.top/downloads';

export interface DownloadLink {
  /** 与 index.html 中 a.dl-cell[data-platform] 的取值一致 */
  platform: 'windows' | 'macos' | 'linux' | 'android';
  /** 真实地址，或 '#' 表示尚未开放 */
  href: string;
  /** 可选的展示用版本号/说明 */
  note?: string;
}

export const DOWNLOAD_LINKS: readonly DownloadLink[] = [
  {
    platform: 'windows',
    // 真实产物：ClipSync_0.1.1_x64-setup.exe（NSIS，已用 Tauri 更新密钥签名）
    href: `${DOWNLOAD_BASE}/ClipSync_0.1.1_x64-setup.exe`,
    note: 'v0.1.1 · 64 位',
  },
  {
    platform: 'macos',
    // 未构建 macOS 产物（tauri.conf.json 的 bundle.targets 目前仅 nsis）
    href: '#',
  },
  {
    platform: 'linux',
    // 未构建 Linux 产物
    href: '#',
  },
  {
    platform: 'android',
    // 待国内应用商店上架后替换为商店链接（材料见 docs/publish/android/）
    href: '#',
  },
];
