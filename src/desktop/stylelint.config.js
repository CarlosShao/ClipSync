/**
 * UI-A style discipline config (token-first styling).
 *
 * C6④：范围已从「仅 src/components/ai」扩大到全部组件目录（src/components/**）。
 * 组件内的颜色必须走主题 token（var(--*)），z-index 必须走 --z-* 变量，
 * 避免明暗主题切换破相与层级失控。
 *
 * 允许保留裸色值的场景（否则主题本身无法表达）：
 *  - 纯白/纯黑的极小值（#fff/#000 这类非主题色，视觉上在所有主题下都成立）
 *  - rgba(255,255,255,…) 这类叠加蒙层（作为遮罩层与主题无关）
 *  - 这些例外通过 color-no-hex / function-disallowed-list 的 message 人工复核，
 *    新代码仍应优先使用 token。
 *
 * Rules enforced on src/components/**:
 *  - color-no-hex                              → use CSS variable tokens
 *  - declaration-property-value-disallowed-list (z-index: bare numbers)
 *                                              → use var(--z-*) tokens
 *
 * @type {import('stylelint').Config}
 */
export default {
  // stylelint 16 refuses to start when the top-level config has no rules.
  // This entry is a no-op (empty property map = nothing disallowed) so the
  // real, directory-scoped rules can live in `overrides` below without
  // flooding the rest of the codebase with errors.
  rules: {
    'declaration-property-value-disallowed-list': {},
  },
  overrides: [
    {
      files: ['src/components/**/*.css'],
      rules: {
        'color-no-hex': [
          true,
          {
            // 纯白/纯黑及其 3 位缩写：跨主题的蒙层/高亮底色，保留裸值可读
            except: ['#fff', '#ffffff', '#000', '#000000'],
          },
        ],
        'declaration-property-value-disallowed-list': {
          'z-index': ['/^-?\\d/'],
        },
      },
    },
    {
      files: ['src/components/**/*.vue'],
      customSyntax: 'postcss-html',
      rules: {
        'color-no-hex': [
          true,
          {
            except: ['#fff', '#ffffff', '#000', '#000000'],
          },
        ],
        'declaration-property-value-disallowed-list': {
          'z-index': ['/^-?\\d/'],
        },
      },
    },
  ],
};
