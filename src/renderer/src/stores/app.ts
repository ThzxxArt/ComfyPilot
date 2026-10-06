import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AppSettings, ComfyInstanceInfo, SystemSnapshot, ExecProgressEvent } from '@shared/types'
import { ipc, onInstanceStatus, onMonitorTick, onIpc, IPC_EVENTS } from '@/composables/useIpc'

export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const settings = ref<AppSettings | null>(null)
  const instances = ref<ComfyInstanceInfo[]>([])
  const activeInstanceId = ref<string | null>(null)
  const system = ref<SystemSnapshot | null>(null)
  const wsEvents = ref<ExecProgressEvent[]>([])
  const lastWsProgress = ref<{ value: number; max: number } | null>(null)

  const activeInstance = computed(
    () => instances.value.find((i) => i.id === activeInstanceId.value) || instances.value[0] || null
  )

  async function bootstrap(opts?: { keepSelection?: boolean }): Promise<void> {
    try {
      settings.value = await ipc('settings.get')
      instances.value = await ipc('instance.list')
      if (!opts?.keepSelection || !activeInstanceId.value) {
        activeInstanceId.value = instances.value[0]?.id ?? null
      }
      system.value = await ipc('monitor.system')
    } catch (err) {
      console.error('bootstrap failed', err)
    } finally {
      ready.value = true
    }
  }

  async function refreshInstances(): Promise<void> {
    instances.value = await ipc('instance.list')
    if (!activeInstanceId.value && instances.value[0]) {
      activeInstanceId.value = instances.value[0].id
    }
  }

  function bindLive(): () => void {
    const off1 = onInstanceStatus((info) => {
      const next = info as ComfyInstanceInfo
      const idx = instances.value.findIndex((i) => i.id === next.id)
      if (idx >= 0) instances.value[idx] = { ...instances.value[idx], ...next }
    })
    const off2 = onMonitorTick((snap) => {
      system.value = snap as SystemSnapshot
    })
    const off3 = onIpc(IPC_EVENTS.monitorWs, (...args: unknown[]) => {
      const evt = args[0] as ExecProgressEvent
      wsEvents.value = [...wsEvents.value.slice(-80), evt]
      if (evt.type === 'progress' && evt.value != null) {
        lastWsProgress.value = { value: evt.value, max: evt.max || 1 }
      }
    })
    return () => {
      off1()
      off2()
      off3()
    }
  }

  return {
    ready,
    settings,
    instances,
    activeInstanceId,
    system,
    wsEvents,
    lastWsProgress,
    activeInstance,
    bootstrap,
    refreshInstances,
    bindLive
  }
})
