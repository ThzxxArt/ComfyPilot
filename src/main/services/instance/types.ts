import type { ChildProcessWithoutNullStreams } from 'child_process'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  ComfyLogLine,
  DiagnosticPackage,
  EnvProbe,
  InstanceDiscoveryCandidate,
  InstanceStatus,
  LaunchCommandPreview,
  LaunchOptions,
  PortCheckResult,
  WaitReadyResult
} from '@shared/types'

interface RuntimeEntry {
  config: ComfyInstanceConfig
  process?: ChildProcessWithoutNullStreams
  status: InstanceStatus
  pid?: number
  startedAt?: number
  lastError?: string
  logs: ComfyLogLine[]
  /** Incremented on each start/stop so stale child handlers can be ignored. */
  generation: number
  intentionalStop: boolean
  /** True once /system_stats has answered for the current generation. */
  ready: boolean
  /** True when WE spawned the process (false when adopting an external ComfyUI). */
  managed: boolean
  readyWaiters: Array<{
    resolve: (r: WaitReadyResult) => void
    timer?: NodeJS.Timeout
  }>
  /** Interval that polls /system_stats until ready. */
  readyPollTimer?: NodeJS.Timeout
  /** Last status value pushed over IPC (change detection for pushLog). */
  lastEmittedStatus?: InstanceStatus
  /** Timestamp of the last status IPC (same-status throttle). */
  lastStatusEmitAt?: number
  /**
   * 0.1.17 (WP3): set by stop() while a start is still winding up. startInner
   * checks it after every await so a process can never appear AFTER the UI was
   * told "stopped".
   */
  cancelRequested?: boolean
  /** Structured crash classification (0.1.17 WP3), cleared on the next start. */
  lastExit?: InstanceExitReport
  /**
   * 0.1.17 (WP3): set by restart() so the following start refuses to adopt a
   * still-running old process instead of silently reusing it.
   */
  expectingStop?: boolean
}

/** Why a managed process died, in terms the UI can act on (0.1.17 WP3). */
export interface InstanceExitReport {
  kind: 'oom' | 'port' | 'dependency' | 'driver' | 'cancelled' | 'unknown'
  code: number | null
  signal: NodeJS.Signals | null
  hint: string
  at: number
}

/** Per-instance outcome of a batch start/stop so the UI can summarize.
 *  Carries full ComfyInstanceInfo (status etc.) plus ok/error for the summary. */
export type InstanceActionResult = ComfyInstanceInfo & {
  ok: boolean
  error?: string
}

/** stop/forceKill result: `adopted` marks an external process we only signalled. */
export type InstanceStopResult = ComfyInstanceInfo & {
  adopted?: boolean
  /** 0.1.17 (WP3): false = the process may still be running after the grace window. */
  exited?: boolean
}

export const LOG_CAP = 5000
/** Minimum gap between same-status IPC pushes triggered by log lines. */
export const STATUS_EMIT_MIN_MS = 1000
export const READY_POLL_MS = 500
// Cold start with modern ComfyUI + plugins can take 60–120s before the HTTP
// port binds (alembic/kitchen/aimdo imports, torch JIT, custom nodes). 45s was
// a false negative — the process was alive and listening ~20s later.
export const READY_TIMEOUT_MS = 180_000
/** If the process is still alive at the first timeout, grant one extra window. */
export const READY_EXTEND_MS = 120_000

export type { RuntimeEntry }

export interface PidLedgerEntry {
  pid: number
  path?: string
  startedAt: number
}

/**
 * Shared internal surface passed to the domain modules. The class owns every
 * field (one copy of the state) and exposes its private members through this
 * contract so the split modules can cooperate without importing each other's
 * runtime state.
 */
export interface InstanceServiceContext {
  runtimes: Map<string, RuntimeEntry>
  startingIds: Set<string>
  stopping: Map<string, Promise<InstanceStopResult>>
  logWriteCounters: Map<string, number>
  versionCache: Map<string, string | undefined>
  quitting: Promise<void>

  emit(event: string, ...args: unknown[]): boolean
  ensureRuntime(config: ComfyInstanceConfig): RuntimeEntry
  emitStatus(rt: RuntimeEntry): void
  pushLog(rt: RuntimeEntry, level: ComfyLogLine['level'], message: string): void
  appendLogFile(id: string, line: ComfyLogLine): void
  toInfo(rt: RuntimeEntry): ComfyInstanceInfo
  baseUrlOf(config: ComfyInstanceConfig): string
  probeVersion(installPath: string): string | undefined
  invalidateVersionCache(installPath?: string): void
  getLogs(id: string, limit?: number): ComfyLogLine[]
  clearLogs(id: string): boolean
  readLogFile(id: string): ComfyLogLine[]
  resolvePython(config: ComfyInstanceConfig): string
  buildArgs(config: ComfyInstanceConfig): string[]
  assertLaunchArgsValid(rt: RuntimeEntry, args: string[]): void
  previewLaunch(id: string): LaunchCommandPreview
  checkPort(port: number): Promise<PortCheckResult>
  suggestPort(): Promise<number>
  pickEphemeralPort(avoid: number): Promise<number>
  start(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo>
  launch(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo>
  waitReady(id: string, timeoutMs?: number): Promise<WaitReadyResult>
  stop(id: string): Promise<InstanceStopResult>
  clearReadyProbe(rt: RuntimeEntry, error?: string): void
  probeEnv(id: string): Promise<EnvProbe>
  exportDiagnostics(id: string): Promise<DiagnosticPackage>
  killAllNow(): void
  commonRoots(extra?: string): string[]
  scoreCandidate(path: string, out: InstanceDiscoveryCandidate[], registered?: Set<string>): void
}
