import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type {
  AppSettings,
  ComfyInstanceInfo,
  SystemSnapshot,
  ExecProgressEvent,
  DoctorReport,
  AppNotification
} from '@shared/types'
import {
  ipc,
  onInstanceStatus,
  onMonitorTick,
  onIpc,
  onNotification,
  IPC_EVENTS
} from '@/composables/useIpc'

export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const settings = ref<AppSettings | null>(null)
  const instances = ref<ComfyInstanceInfo[]>([])
  const activeInstanceId = ref<string | null>(null)
  /**
   * Bumped whenever activeInstanceId changes. Domain views watch this
   * instead of hunting for every write site — switching the header selector
   * or Workflows' selector both land here.
   */
  const instanceSwitchTick = ref(0)
  const system = ref<SystemSnapshot | null>(null)
  const wsEvents = ref<ExecProgressEvent[]>([])
  const lastWsProgress = ref<{ value: number; max: number } | null>(null)
  /** Last doctor report — survives navigation from Dashboard "one-click check" into DoctorView. */
  const doctorReport = ref<DoctorReport | null>(null)
  /** Global notification queue pushed by the main process (long-running tasks). */
  const notifications = ref<AppNotification[]>([])

  const activeInstance = computed(
    () => instances.value.find((i) => i.id === activeInstanceId.value) || instances.value[0] || null
  )

  watch(activeInstanceId, () => {
    instanceSwitchTick.value += 1
  })

  function pushNotification(n: AppNotification): void {
    notifications.value = [...notifications.value.slice(-19), n]
  }

  /** Drop a stale activeInstanceId when its instance disappeared. */
  function pruneActiveInstance(): void {
    if (!activeInstanceId.value) return
    if (!instances.value.some((i) => i.id === activeInstanceId.value)) {
      activeInstanceId.value = instances.value[0]?.id ?? null
    }
  }

  async function bootstrap(opts?: { keepSelection?: boolean }): Promise<void> {
    try {
      settings.value = await ipc('settings.get')
      instances.value = await ipc('instance.list')
      if (!opts?.keepSelection || !activeInstanceId.value) {
        activeInstanceId.value = instances.value[0]?.id ?? null
      }
      pruneActiveInstance()
      system.value = await ipc('monitor.system')
      void syncWs()
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
    pruneActiveInstance()
  }

  /**
   * WS is an app-level resource bound to the active instance.
   * Views must NOT disconnect it on unmount — that would kill progress
   * streams for pages listening in the background.
   */
  async function syncWs(): Promise<void> {
    const inst = activeInstance.value
    if (inst?.url && (inst.status === 'running' || inst.status === 'starting')) {
      try {
        await ipc('monitor.connectWs', inst.url)
      } catch {
        /* offline — polling still covers queue */
      }
    }
  }

  watch(activeInstanceId, () => {
    void syncWs()
  })

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
    const off4 = onNotification((n) => {
      pushNotification(n as AppNotification)
    })
    return () => {
      off1()
      off2()
      off3()
      off4()
    }
  }

  return {
    ready,
    settings,
    instances,
    activeInstanceId,
    instanceSwitchTick,
    system,
    wsEvents,
    lastWsProgress,
    doctorReport,
    notifications,
    activeInstance,
    bootstrap,
    refreshInstances,
    bindLive,
    pushNotification,
    pruneActiveInstance,
    syncWs
  }
})
