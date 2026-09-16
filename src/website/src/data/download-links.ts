/**
 * 官网下载链接单一来源（T-W1）。
 *
 * 卡片接线逻辑见 `src/main.ts` 的 initDownloadLinks()：
 *   - href 为真实 http(s) 地址 → 赋 href，新标签打开（自动带 noopener）
 *   - href 为 '#'（占位）      → 置禁用态并提示「即将开放」，不赋 href
 *
 * 接入真实产物时**只改本文件**，页面逻辑自动切换。
 * 桌面端安装包托管在 GitHub Releases（发布流程见
 * docs/deploy/desktop-release-process.md），下载地址形态为
 *   https://github.com/CarlosShao/ClipSync/releases/latest/download/<文件名>
 * 文件名需与 tauri 打包产物一致，否则 404。
 */

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
    // TODO(发布时补)：产物名以 src/desktop/src-tauri 实际打包结果为准，
    // 形如 ClipSync_<version>_x64-setup.exe，文件名不符会 404。
    href: '#',
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
