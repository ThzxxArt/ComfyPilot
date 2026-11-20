/**
 * Single discrete message/dialog API for the renderer shell.
 *
 * `App.vue` and `useLaunch()` both need toasts/dialogs outside Naive providers.
 * Two separate `createDiscreteApi` instances produced two themed roots
 * (different CSS variables after theme changes). Keep one lazy singleton.
 */
import { createDiscreteApi, type DialogApi, type MessageApi } from 'naive-ui'

let api: { message: MessageApi; dialog: DialogApi } | null = null

export function discreteUi(): { message: MessageApi; dialog: DialogApi } {
  if (!api) api = createDiscreteApi(['message', 'dialog'])
  return api
}
