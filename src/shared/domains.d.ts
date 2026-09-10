/**
 * src/shared/domains.js 的类型声明。
 *
 * 让 TS 消费方（admin-console / website）在 import '../shared/domains.js' 时
 * 获得完整类型提示，同时保持运行时为零依赖的 ESM JS（不需要构建步骤）。
 *
 * ⚠️ 修改 domains.js 时请同步本文件。
 */

export declare const ROOT_DOMAIN: 'clipchain.top';

export declare const DOMAINS: Readonly<{
  api: string;
  ws: string;
  updates: string;
  www: string;
  admin: string;
  root: string;
}>;

export declare const ORIGINS: Readonly<{
  api: string;
  ws: string;
  updates: string;
  www: string;
  admin: string;
  root: string;
}>;

export declare const EMAIL_LOCAL_PARTS: Readonly<{
  support: 'support';
  privacy: 'privacy';
  dpo: 'dpo';
  noreply: 'noreply';
}>;

export declare function email(localPart: string): string;

export declare const EMAILS: Readonly<{
  support: string;
  privacy: string;
  dpo: string;
  noreply: string;
}>;

export declare const LEGAL_PATHS: Readonly<{
  termsOfService: string;
  privacyPolicy: string;
}>;

export declare const LEGAL_URLS: Readonly<{
  termsOfService: string;
  privacyPolicy: string;
}>;

export declare const UPDATE_ENDPOINT_TEMPLATE: string;

export declare const ALLOWED_ORIGINS: readonly string[];

declare const _default: {
  ROOT_DOMAIN: typeof ROOT_DOMAIN;
  DOMAINS: typeof DOMAINS;
  ORIGINS: typeof ORIGINS;
  EMAILS: typeof EMAILS;
  EMAIL_LOCAL_PARTS: typeof EMAIL_LOCAL_PARTS;
  email: typeof email;
  LEGAL_PATHS: typeof LEGAL_PATHS;
  LEGAL_URLS: typeof LEGAL_URLS;
  UPDATE_ENDPOINT_TEMPLATE: typeof UPDATE_ENDPOINT_TEMPLATE;
  ALLOWED_ORIGINS: typeof ALLOWED_ORIGINS;
};
export default _default;
