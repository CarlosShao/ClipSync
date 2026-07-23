/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Vue SFC shim
  const component: DefineComponent<{}, {}, any>
  export default component
}
