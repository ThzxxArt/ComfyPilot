/// <reference types="vite/client" />

declare const __APP_VERSION__: string | undefined

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
