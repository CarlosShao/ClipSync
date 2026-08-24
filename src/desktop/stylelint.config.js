/**
 * UI-A style discipline config (token-first styling).
 *
 * Rules are intentionally scoped to the AI component directory only
 * (via overrides) so the existing codebase is not flooded with errors.
 * Cleanup of legacy hex/z-index usages is owned by UI-C/D/E packages.
 *
 * Rules enforced on src/components/ai/**:
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
      files: ['src/components/ai/**/*.css'],
      rules: {
        'color-no-hex': true,
        'declaration-property-value-disallowed-list': {
          'z-index': ['/^-?\\d/'],
        },
      },
    },
    {
      files: ['src/components/ai/**/*.vue'],
      customSyntax: 'postcss-html',
      rules: {
        'color-no-hex': true,
        'declaration-property-value-disallowed-list': {
          'z-index': ['/^-?\\d/'],
        },
      },
    },
  ],
};
