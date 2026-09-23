import js from '@eslint/js'
import ts from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import pluginPrettier from 'eslint-plugin-prettier'
import globals from 'globals'

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    files: ['**/*.{js,ts,mjs,mts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: {
      prettier: pluginPrettier,
    },
    rules: {
      'prettier/prettier': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      // P0-C C3：此规则曾被设为 'off'（等于把存储型 XSS 汇聚点的报警器永久断电）。
      // 恢复为 error：'warn' 在本仓无效——npm run lint 即 `eslint .`，不带 --max-warnings，
      // 且仓库已有 5 万余条 prettier 警告，'warn' 会被噪音彻底淹没。
      'vue/no-v-html': 'error',
    },
  },
  {
    ignores: ['dist', 'node_modules', 'src-tauri', 'public', 'vite.config.ts.timestamp-*'],
  },
]
