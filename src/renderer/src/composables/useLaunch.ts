import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { createDiscreteApi, type MessageApi, type DialogApi } from 'naive-ui'
import { ipc, ComfyPilotIpcError } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import { i18n } from '@/i18n'
import type { ComfyInstanceInfo, LaunchOptions } from '@shared/types'

const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.global.t(key, params as never)

/**
 * Discrete APIs so the launcher works from App.vue (outside NMessageProvider)
 * as well as from views inside the providers.
 */
let discrete: { message: MessageApi; dialog: DialogApi } | null = null
function ui(): { message: MessageApi; dialog: DialogApi } {
  if (!discrete) {
    discrete = createDiscreteApi(['message', 'dialog'])
  }
  return discrete
}

export interface LaunchOpts extends LaunchOptions {
  open?: 'embed' | 'browser' | 'none'
}

/**
 * Shared launcher flow used by App header, Instances, Dashboard, Detail.
 * - waits until ComfyUI is actually ready (instance.launch blocks on readiness)
 * - handles PORT_IN_USE with an explicit relocate confirmation
 * - performs embed/browser open itself so callers stay navigation-agnostic
 *
 * `busy` is module-shared so two views cannot start the same instance at once.
 */
const sharedBusy = ref<Record<string, boolean>>({})

export function useLaunch() {
  const store = useAppStore()
  const router = useRouter()
  const busy = sharedBusy

  function setBusy(id: string, v: boolean): void {
    busy.value = { ...busy.value, [id]: v }
  }

  async function openFrontend(
    info: ComfyInstanceInfo,
    open: NonNullable<LaunchOpts['open']>
  ): Promise<void> {
    if (open === 'none') return
    if (!info.url) throw new Error(t('launch.noUrl'))
    if (open === 'browser') {
      await ipc('shell.openExternal', info.url)
      return
    }
    await router.push({ path: '/embed', query: { url: info.url } })
  }

  async function launch(info: ComfyInstanceInfo, opts?: LaunchOpts): Promise<boolean> {
    const id = info.id
    if (busy.value[id]) return false
    setBusy(id, true)
    const open = opts?.open ?? 'none'
    try {
      // Never let main auto-relocate silently — PORT_IN_USE must surface to the user first.
      const result = await ipc('instance.launch', id, { ...opts, open: 'none', relocatePort: false })
      await store.refreshInstances()
      await openFrontend(result, open)
      ui().message.success(t('launch.ready', { name: result.name }))
      return true
    } catch (err) {
      await handleLaunchError(err, info, opts)
      return false
    } finally {
      setBusy(id, false)
    }
  }

  async function handleLaunchError(
    err: unknown,
    info: ComfyInstanceInfo,
    opts?: LaunchOpts
  ): Promise<void> {
    const e = err as ComfyPilotIpcError
    const text = e?.message || String(err)
    const open = opts?.open ?? 'none'
    if (e?.code === 'PORT_IN_USE' && e.suggestedPort) {
      const suggested = e.suggestedPort
      ui().dialog.warning({
        title: t('launch.portBusyTitle'),
        content: t('launch.portBusyBody', {
          port: info.port,
          suggested,
          name: info.name
        }),
        positiveText: t('launch.usePort', { port: suggested }),
        negativeText: t('common.cancel'),
        onPositiveClick: () => {
          void (async () => {
            setBusy(info.id, true)
            try {
              // Persist the new port first so the UI/config stay consistent.
              await ipc('instance.save', {
                id: info.id,
                name: info.name,
                path: info.path,
                pythonPath: info.pythonPath || '',
                venvPath: info.venvPath || '',
                port: suggested,
                listen: info.listen || '127.0.0.1',
                extraArgs: info.extraArgs || [],
                argTemplateId: info.argTemplateId || 'default',
                enabled: info.enabled !== false,
                notes: info.notes || '',
                autoStart: Boolean(info.autoStart),
                frontendVersion: info.frontendVersion || '',
                pinned: Boolean(info.pinned)
              })
              await store.refreshInstances()
              const result = await ipc('instance.launch', info.id, {
                relocatePort: true,
                open: 'none'
              })
              await store.refreshInstances()
              await openFrontend(result, open)
              ui().message.success(t('launch.readyOnPort', { name: info.name, port: suggested }))
            } catch (err2) {
              ui().message.error(err2 instanceof Error ? err2.message : String(err2))
            } finally {
              setBusy(info.id, false)
            }
          })()
        }
      })
      return
    }
    ui().message.error(text)
  }

  async function stop(info: ComfyInstanceInfo): Promise<void> {
    try {
      await ipc('instance.stop', info.id)
      await store.refreshInstances()
      ui().message.success(t('launch.stopped', { name: info.name }))
    } catch (err) {
      ui().message.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function restart(info: ComfyInstanceInfo, opts?: LaunchOpts): Promise<void> {
    const open = opts?.open ?? 'none'
    if (busy.value[info.id]) return
    setBusy(info.id, true)
    try {
      await ipc('instance.restart', info.id, { ...opts, open: 'none', relocatePort: false })
      await store.refreshInstances()
      const after = store.instances.find((i) => i.id === info.id) || info
      await openFrontend(after, open)
      ui().message.success(t('launch.restarted', { name: info.name }))
    } catch (err) {
      await handleLaunchError(err, info, opts)
    } finally {
      setBusy(info.id, false)
    }
  }

  async function forceKill(info: ComfyInstanceInfo): Promise<void> {
    try {
      await ipc('instance.forceKill', info.id)
      await store.refreshInstances()
      ui().message.warning(t('launch.forceKilled', { name: info.name }))
    } catch (err) {
      ui().message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return { busy, launch, stop, restart, forceKill, handleLaunchError }
}
