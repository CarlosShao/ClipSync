/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 基础路径，默认 /api */
  readonly VITE_API_BASE?: string;
  /** 是否启用 MSW mock（dev 默认 true，生产强制 false） */
  readonly VITE_ENABLE_MSW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
