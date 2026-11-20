/**
 * Instance health watchdog (0.2.5 WP2).
 *
 * A process that still holds the port is not a working ComfyUI: when the
 * asyncio event loop is blocked by a native op, the kernel keeps LISTENING and
 * new HTTP connections time out. The watchdog combines HTTP, TCP, process,
 * log and queue/progress evidence instead of trusting one boolean.
 */
import { EventEmitter } from 'events'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import net from 'net'
import type { InstanceHealth, HealthState } from '@shared/types'
import { DEFAULT_HEALTH_RECOVERY_POLICY } from '@shared/types'
import { resolveEffectiveInstance } from '@shared/instanceLayout'
import { loadInstanceConfigs, loadSettings, logsDir } from '../db'
import { monitorService } from '../monitor'
import type { InstanceServiceContext, RuntimeEntry } from './types'

export interface HealthFacts {
  now: number
  httpOk: boolean
  latencyMs?: number
  portListening: boolean
  processAlive: boolean
  lastLogAt?: number
  lastProgressAt?: number
  queueRunning: number
  queuePending: number
  startedAt?: number
  staleMs: number
}

export interface HealthDecision {
  state: HealthState
  consecutiveFailures: number
  evidence: string[]
  message?: string
}

/**
 * Pure state transition — exported so threshold/recovery tests use the same
 * rules as production. `failures` is the count BEFORE this probe.
 */
export function decideHealth(
  prev: InstanceHealth | undefined,
  facts: HealthFacts,
  failuresBefore: number
): HealthDecision {
  const evidence: string[] = []
  const lastProgress = Math.max(facts.lastProgressAt || 0, facts.lastLogAt || 0)
  const silentFor = facts.now - Math.max(lastProgress, facts.startedAt || 0)

  if (!facts.processAlive) {
    return { state: 'stopped', consecutiveFailures: 0, evidence: ['process-gone'] }
  }
  evidence.push('process-alive')

  if (facts.httpOk) {
    evidence.push('http-ok')
    const busy =
      facts.queueRunning > 0 && facts.lastProgressAt !== undefined
        ? facts.now - facts.lastProgressAt < 30_000
        : false
    if (busy) evidence.push('queue-running', 'recent-progress')
    return {
      state: busy ? 'busy' : 'healthy',
      consecutiveFailures: 0,
      evidence
    }
  }

  const failures = failuresBefore + 1
  evidence.push(facts.latencyMs === undefined ? 'http-timeout' : 'http-error')
  if (facts.portListening) evidence.push('port-listening')
  else evidence.push('port-not-listening')

  if (!facts.portListening) {
    // A process that never binds the port within 10s is crashed, not slow.
    if (facts.startedAt && facts.now - facts.startedAt > 10_000) {
      return {
        state: 'crashed',
        consecutiveFailures: failures,
        evidence,
        message: 'The process is alive but the HTTP port is not listening'
      }
    }
    return { state: 'suspect', consecutiveFailures: failures, evidence }
  }

  if (facts.queueRunning > 0) {
    evidence.push('queue-running')
    if (facts.lastProgressAt && facts.now - facts.lastProgressAt < 30_000) {
      return { state: 'busy', consecutiveFailures: failures, evidence }
    }
  }
  if (facts.lastLogAt && facts.now - facts.lastLogAt < facts.staleMs) {
    evidence.push('recent-log')
  } else {
    evidence.push('log-stale')
  }

  if (failures >= 6 && silentFor >= facts.staleMs) {
    return {
      state: 'unresponsive',
      consecutiveFailures: failures,
      evidence: [...evidence, 'no-ws-progress'],
      message: 'HTTP is timing out while the process is alive and the port is still listening'
    }
  }
  if (failures >= 3) {
    return { state: 'suspect', consecutiveFailures: failures, evidence }
  }
  return {
    state: prev?.state === 'unresponsive' ? 'suspect' : (prev?.state ?? 'unknown'),
    consecutiveFailures: failures,
    evidence
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface WatchEntry {
  health?: InstanceHealth
  timer?: NodeJS.Timeout
  inflight?: Promise<InstanceHealth>
}

export class InstanceHealthService extends EventEmitter {
  private ctx: InstanceServiceContext | null = null
  private readonly entries = new Map<string, WatchEntry>()
  private disposed = false

  /** Start/refresh one timer per configured local instance. */
  start(ctx: InstanceServiceContext): void {
    this.ctx = ctx
    this.disposed = false
    this.refresh()
  }

  refresh(): void {
    if (this.disposed || !this.ctx) return
    let configs: ReturnType<typeof loadInstanceConfigs> = []
    try {
      configs = loadInstanceConfigs()
    } catch {
      return
    }
    const valid = new Set(configs.map((c) => c.id))
    for (const [id, entry] of this.entries) {
      if (valid.has(id)) continue
      if (entry.timer) clearTimeout(entry.timer)
      this.entries.delete(id)
    }
    for (const c of configs) {
      const entry = this.entries.get(c.id) ?? {}
      this.entries.set(c.id, entry)
      if (!entry.timer) this.schedule(c.id, entry, 0)
    }
  }

  stop(): void {
    this.disposed = true
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer)
    this.entries.clear()
  }

  get(instanceId: string): InstanceHealth | undefined {
    return this.entries.get(instanceId)?.health
  }

  async check(instanceId: string): Promise<InstanceHealth> {
    const entry = this.entries.get(instanceId) ?? {}
    this.entries.set(instanceId, entry)
    if (entry.inflight) return entry.inflight
    const p = this.probe(instanceId)
      .then((health) => {
        const prev = entry.health
        entry.health = health
        if (!prev || prev.state !== health.state) {
          this.logTransition(health)
          this.emit('health', { instanceId, health })
        }
        return health
      })
      .finally(() => {
        entry.inflight = undefined
      })
    entry.inflight = p
    return p
  }

  private schedule(instanceId: string, entry: WatchEntry, delayMs: number): void {
    if (this.disposed) return
    const settings = this.settings()
    if (!settings.enabled) return
    const jitter = 0.8 + Math.random() * 0.4
    const wait = delayMs || Math.round(settings.intervalMs * jitter)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.check(instanceId)
        .catch(() => undefined)
        .finally(() => {
          const rt = this.ctx?.runtimes.get(instanceId)
          if (rt && (rt.status === 'running' || rt.status === 'starting' || rt.process)) {
            this.schedule(instanceId, entry, 0)
          } else {
            // Stopped instances stay on a slow poll so a manual start is
            // picked up without a status event.
            this.schedule(instanceId, entry, Math.round(settings.intervalMs * 2))
          }
        })
    }, wait)
    entry.timer.unref?.()
  }

  private settings(): {
    enabled: boolean
    intervalMs: number
    timeoutMs: number
    staleMs: number
  } {
    let s: ReturnType<typeof loadSettings>
    try {
      s = loadSettings()
    } catch {
      s = {} as ReturnType<typeof loadSettings>
    }
    return {
      enabled: s.healthCheckEnabled !== false,
      intervalMs: Math.min(60_000, Math.max(1000, Number(s.healthCheckIntervalMs) || 5000)),
      timeoutMs: Math.min(30_000, Math.max(250, Number(s.healthCheckTimeoutMs) || 2000)),
      staleMs: Math.min(1_800_000, Math.max(60_000, Number(s.healthStaleMs) || 180_000))
    }
  }

  recoveryPolicy(): typeof DEFAULT_HEALTH_RECOVERY_POLICY {
    let s: ReturnType<typeof loadSettings>
    try {
      s = loadSettings()
    } catch {
      return DEFAULT_HEALTH_RECOVERY_POLICY
    }
    return {
      enabled: s.autoRecover === true,
      action: 'restart',
      afterMs: 60_000,
      maxAttempts: Math.max(1, Number(s.autoRecoverMaxAttempts) || 3),
      cooldownMs: Math.max(10_000, Number(s.autoRecoverCooldownMs) || 300_000),
      killRunningJobs: false
    }
  }

  private async probe(instanceId: string): Promise<InstanceHealth> {
    const now = Date.now()
    const config = loadInstanceConfigs().find((c) => c.id === instanceId)
    const entry = this.entries.get(instanceId)
    const previous = entry?.health
    const rt: RuntimeEntry | undefined = this.ctx?.runtimes.get(instanceId)
    if (!config) {
      return {
        instanceId,
        state: 'unknown',
        checkedAt: now,
        since: previous?.since ?? now,
        consecutiveFailures: 0,
        queueRunning: 0,
        queuePending: 0,
        portListening: false,
        processAlive: false,
        evidence: ['instance-not-found']
      }
    }
    const effective = resolveEffectiveInstance(config)
    const processAlive = Boolean(
      (rt?.process && rt.process.exitCode === null) || pidAlive(rt?.pid)
    )
    if (!processAlive) {
      const state: HealthState = rt?.status === 'starting' ? 'suspect' : 'stopped'
      return {
        instanceId,
        state,
        checkedAt: now,
        since: previous?.state === state ? previous.since : now,
        consecutiveFailures: 0,
        lastOkAt: previous?.lastOkAt,
        lastLogAt: rt?.lastLogAt,
        lastProgressAt: monitorService.lastProgressAt(effective.url),
        queueRunning: 0,
        queuePending: 0,
        portListening: false,
        processAlive: false,
        evidence: ['process-gone']
      }
    }

    const settings = this.settings()
    const timeout = AbortSignal.timeout(settings.timeoutMs)
    const started = Date.now()
    const [stats, queue, portListening] = await Promise.all([
      (async () => {
        try {
          const res = await fetch(`${effective.url}/system_stats`, { signal: timeout })
          return res.ok ? res : null
        } catch {
          return null
        }
      })(),
      (async () => {
        try {
          const res = await fetch(`${effective.url}/queue`, { signal: timeout })
          if (!res.ok) return null
          return (await res.json()) as {
            queue_running?: unknown[]
            queue_pending?: unknown[]
          }
        } catch {
          return null
        }
      })(),
      tcpProbe(effective.probeHost, effective.port, Math.min(1500, settings.timeoutMs))
    ])
    const latencyMs = stats ? Date.now() - started : undefined
    const lastProgressAt = monitorService.lastProgressAt(effective.url)
    const decision = decideHealth(
      previous,
      {
        now,
        httpOk: Boolean(stats),
        latencyMs,
        portListening,
        processAlive,
        lastLogAt: rt?.lastLogAt,
        lastProgressAt,
        queueRunning: Array.isArray(queue?.queue_running) ? queue!.queue_running!.length : 0,
        queuePending: Array.isArray(queue?.queue_pending) ? queue!.queue_pending!.length : 0,
        startedAt: rt?.startedAt,
        staleMs: settings.staleMs
      },
      previous?.consecutiveFailures ?? 0
    )
    return {
      instanceId,
      state: decision.state,
      checkedAt: now,
      since: previous?.state === decision.state ? previous.since : now,
      latencyMs,
      consecutiveFailures: decision.consecutiveFailures,
      lastOkAt: stats ? now : previous?.lastOkAt,
      lastLogAt: rt?.lastLogAt,
      lastProgressAt,
      queueRunning: Array.isArray(queue?.queue_running) ? queue!.queue_running!.length : 0,
      queuePending: Array.isArray(queue?.queue_pending) ? queue!.queue_pending!.length : 0,
      portListening,
      processAlive,
      evidence: decision.evidence,
      message: decision.message
    }
  }

  private logTransition(health: InstanceHealth): void {
    try {
      mkdirSync(logsDir(), { recursive: true })
      appendFileSync(
        join(logsDir(), 'health.log'),
        `${new Date(health.checkedAt).toISOString()} ${health.instanceId} ${health.state} ${health.evidence.join(',')}\n`,
        'utf-8'
      )
    } catch {
      /* health logging must never break the watchdog */
    }
  }
}

export const instanceHealthService = new InstanceHealthService()
