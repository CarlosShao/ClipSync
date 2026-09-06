/**
 * ClipSync Admin Console 提交规范
 * 沿用仓库 conventional commits 风格：type(scope): subject，如 feat(admin): xxx
 * scope 枚举为提醒级（warn），避免阻塞编排者的合法提交。
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'admin',
        'admin-console',
        'server',
        'mobile',
        'desktop',
        'website',
        'deps',
        'docs',
        'ci',
        'release',
        'repo',
      ],
    ],
  },
};
