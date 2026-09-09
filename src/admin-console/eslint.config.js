import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'public/mockServiceWorker.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.es2022 },
    },
    extends: [...tseslint.configs.recommendedTypeChecked],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // 页面之间禁止互相 import：跨页逻辑必须下沉 components/ 或 utils/
    files: ['src/pages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/pages', '@/pages/**'],
              message: '页面之间禁止互相 import；跨页逻辑必须下沉 components/ 或 utils/。',
            },
          ],
        },
      ],
    },
  },
  {
    // AN-21：占位文案禁止裸写在业务代码里——未实现功能统一登记 src/placeholders.ts
    // 并走占位组件渲染（disabled + Tooltip），让占位在静态层面可识别、可清点。
    // 详见 src/placeholders.ts 头部说明与 run-audit.mjs 的 placeholders 阶段。
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/placeholders.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/后续版本/], TemplateElement[value.raw=/后续版本/]",
          message:
            'AN-21：禁止裸写「后续版本」占位文案；未实现功能请登记到 src/placeholders.ts，或接真实功能。',
        },
      ],
    },
  },
  prettier,
);
