import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type {
  AppSettings,
  ComfyInstanceInfo,
  SystemSnapshot,
  DoctorReport,
  AppNotification,
  RemoteInstanceConfig,
  TargetRef
} from '@shared/types'
import { ipc, onInstanceStatus, onMonitorTick, onNotification } from '@/composables/useIpc'

/**
 * 0.1.18 (regression): the notification center claimed to persist notices but
 * only the read cursor was stored — the next launch started at seq 0, so the
 * badge was suppressed for the first N notices. Persist seq + items together.
 */
const NOTICE_STORE_KEY = 'cp.notifications.v1'

function loadNoticeStore(): { seq: number; items: AppNotification[] } {
  try {
    const raw = globalThis.localStorage?.getItem(NOTICE_STORE_KEY)
    if (!raw) return { seq: 0, items: [] }
    const parsed = JSON.parse(raw) as { seq?: unknown; items?: unknown }
    const items = Array.isArray(parsed.items)
      ? (parsed.items as AppNotification[])
          .filter((n) => n && typeof n === 'object')
          .slice(-200)
      : []
    const seq = Number.isFinite(Number(parsed.seq))
      ? Math.max(0, Number(parsed.seq))
      : items.length
    return { seq, items }
  } catch {
    return { seq: 0, items: [] }
  }
}

function persistNoticeStore(seq: number, items: AppNotification[]): void {
  try {
    globalThis.localStorage?.setItem(NOTICE_STORE_KEY, JSON.stringify({ seq, items }))
  } catch {
    /* storage may be unavailable (private mode / tests) */
  }
}

export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const settings = ref<AppSettings | null>(null)
  const instances = ref<ComfyInstanceInfo[]>([])
  const activeInstanceId = ref<string | null>(null)
  /** Remote ComfyUI instances (LAN / cloud) — read-only targets. */
  const remotes = ref<RemoteInstanceConfig[]>([])
  const activeRemoteId = ref<string | null>(null)
  /**
   * Bumped whenever activeInstanceId changes. Domain views watch this
   * instead of hunting for every write site — switching the header selector
   * or Workflows' selector both land here.
   */
  const instanceSwitchTick = ref(0)
  /** Last bootstrap failure (0.1.17 WP9) — views can show it instead of a blank page. */
  const bootstrapError = ref('')
  const system = ref<SystemSnapshot | null>(null)
  /** Last doctor report — survives navigation from Dashboard "one-click check" into DoctorView. */
  const doctorReport = ref<DoctorReport | null>(null)
  /** Global notification queue pushed by the main process (long-running tasks). */
  const noticeInitial = loadNoticeStore()
  const notifications = ref<AppNotification[]>(noticeInitial.items)
  /**
   * Monotonic counter — the ONLY reliable cursor for consumers.
   * `notifications.length` is capped at 20, so a length-based watcher
   * silently stops firing after the 20th toast. Watch this seq instead.
   */
  const notificationSeq = ref(noticeInitial.seq)

  /**
   * 0.1.18 (WP2): exactly one place defines "the active target".
   *
   * The old computed fell back to `instances[0]` whenever `activeInstanceId`
   * was null. Selecting a remote nulls the local id, so every `|| undefined`
   * call site silently meant "the first local instance" — the root cause of
   * P0-3. There is no fallback any more: no id means no active local instance.
   */
  const activeInstance = computed(() => {
    if (activeRemoteId.value) return null
    if (!activeInstanceId.value) return null
    return instances.value.find((i) => i.id === activeInstanceId.value) || null
  })

  /** Explicit target for destructive local operations (null in remote context). */
  const localTargetId = computed<string | null>(() =>
    activeRemoteId.value ? null : (activeInstance.value?.id ?? null)
  )

  /** Single cross-view target descriptor. */
  const activeTarget = computed<TargetRef>(() => {
    if (activeRemoteId.value) return { kind: 'remote', id: activeRemoteId.value }
    if (activeInstance.value) return { kind: 'local', id: activeInstance.value.id }
    return { kind: 'none' }
  })

  /** The selected remote (null when a local instance is active). */
  const activeRemote = computed(
    () => remotes.value.find((r) => r.id === activeRemoteId.value) || null
  )

  /** True when a remote is selected — local-only features should be disabled. */
  const isRemoteActive = computed(() => Boolean(activeRemoteId.value))

  /**
   * URL to use for monitor / queue / WS / workflow-queue.
   * Remote baseUrl when a remote is active, else the local instance URL.
   */
  const activeTargetUrl = computed(() => {
    if (activeRemote.value) return activeRemote.value.baseUrl
    return activeInstance.value?.url || null
  })

  watch([activeInstanceId, activeRemoteId], () => {
    instanceSwitchTick.value += 1
  })

  function pushNotification(n: AppNotification): void {
    // 0.1.18 (WP6): keep 200 for the notification center (toasts still only
    // consume what is new via notificationSeq).
    notifications.value = [...notifications.value.slice(-199), n]
    notificationSeq.value += 1
    persistNoticeStore(notificationSeq.value, notifications.value)
  }

  /**
   * Drop a stale activeInstanceId when its instance disappeared.
   * Never auto-select a local instance while a remote is active — that would
   * make both `activeInstance` and `activeRemote` truthy at once.
   */
  function pruneActiveInstance(): void {
    if (!activeInstanceId.value) return
    if (!instances.value.some((i) => i.id === activeInstanceId.value)) {
      activeInstanceId.value = activeRemoteId.value ? null : (instances.value[0]?.id ?? null)
    }
  }

  async function bootstrap(opts?: { keepSelection?: boolean }): Promise<void> {
    try {
      settings.value = await ipc('settings.get')
      instances.value = await ipc('instance.list')
      remotes.value = await ipc('remote.list')
      if (!opts?.keepSelection || !activeInstanceId.value) {
        if (!activeRemoteId.value) activeInstanceId.value = instances.value[0]?.id ?? null
      }
      pruneActiveInstance()
      system.value = await ipc('monitor.system')
      void syncWs()
    } catch (err) {
      // 0.1.17 (WP9): a failed bootstrap used to be console-only — the UI looked
      // empty with no explanation. Surface it as an app notification too.
      console.error('bootstrap failed', err)
      bootstrapError.value = err instanceof Error ? err.message : String(err)
      pushNotification({
        type: 'error',
        title: 'ComfyPilot could not load its data',
        titleKey: 'notify.bootstrapFailed',
        message: bootstrapError.value,
        messageKey: 'notify.bootstrapFailedMsg',
        params: { error: bootstrapError.value },
        duration: 10000
      })
    } finally {
      ready.value = true
    }
  }

  async function refreshInstances(): Promise<void> {
    instances.value = await ipc('instance.list')
    if (!activeInstanceId.value && !activeRemoteId.value && instances.value[0]) {
      activeInstanceId.value = instances.value[0].id
    }
    pruneActiveInstance()
  }

  async function refreshRemotes(): Promise<void> {
    remotes.value = await ipc('remote.list')
    if (activeRemoteId.value && !remotes.value.some((r) => r.id === activeRemoteId.value)) {
      activeRemoteId.value = null
    }
  }

  /**
   * WS is an app-level resource bound to the active instance.
   * Views must NOT disconnect it on unmount — that would kill progress
   * streams for pages listening in the background.
   * 0.1.11: the socket follows the instance STATUS — running/starting keeps it
   * connected, anything else drops it. Before this, a launch after app start
   * never triggered a connect and previews/progress stayed empty forever.
   */
  async function syncWs(): Promise<void> {
    const url = activeTargetUrl.value
    const inst = activeInstance.value
    // Local: only connect when running/starting. Remote: always try.
    if (isRemoteActive.value) {
      if (url) {
        try {
          await ipc('monitor.connectWs', url)
        } catch {
          /* offline — polling still covers queue */
        }
      }
      return
    }
    if (url && inst && (inst.status === 'running' || inst.status === 'starting')) {
      try {
        await ipc('monitor.connectWs', url)
      } catch {
        /* offline — polling still covers queue */
      }
    } else {
      // Target gone / stopped — drop the socket and its reconnect loop; the
      // next running transition reconnects via the status watch below.
      try {
        await ipc('monitor.disconnectWs')
      } catch {
        /* ignore */
      }
    }
  }

  watch([activeInstanceId, activeRemoteId], () => {
    void syncWs()
  })

  // Status transitions drive the socket too (0.1.11) — the header's
  // start/stop button and the tray both mutate status outside the store.
  watch(
    () =>
      instances.value
        .map((i) => `${i.id}:${i.status}`)
        .sort()
        .join('|'),
    () => {
      void syncWs()
    }
  )

  function bindLive(): () => void {
    const off1 = onInstanceStatus((info) => {
      const next = info as ComfyInstanceInfo
      const idx = instances.value.findIndex((i) => i.id === next.id)
      if (idx >= 0) instances.value[idx] = { ...instances.value[idx], ...next }
    })
    const off2 = onMonitorTick((snap) => {
      system.value = snap as SystemSnapshot
    })
    const off4 = onNotification((n) => {
      pushNotification(n as AppNotification)
    })
    return () => {
      off1()
      off2()
      off4()
    }
  }

  return {
    ready,
    settings,
    instances,
    activeInstanceId,
    instanceSwitchTick,
    remotes,
    activeRemoteId,
    activeRemote,
    isRemoteActive,
    localTargetId,
    activeTarget,
    activeTargetUrl,
    system,
    doctorReport,
    notifications,
    notificationSeq,
    activeInstance,
    bootstrap,
    bootstrapError,
    refreshInstances,
    refreshRemotes,
    bindLive,
    pushNotification,
    pruneActiveInstance,
    syncWs
  }
})
