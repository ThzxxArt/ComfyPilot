import { EventEmitter } from 'events'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  ComfyLogLine,
  DiagnosticPackage,
  EnvProbe,
  InstanceCapabilities,
  InstanceDiscoveryCandidate,
  InstanceStartupIssues,
  LaunchCommandPreview,
  LaunchOptions,
  PortCheckResult,
  WaitReadyResult
} from '@shared/types'
import * as diagnostics from './diagnostics'
import * as discovery from './discovery'
import * as envProbe from './envProbe'
import * as launchArgs from './launchArgs'
import * as lifecycle from './lifecycle'
import * as logs from './logs'
import * as python from './python'
import * as runtime from './runtime'
import * as selfcheck from './selfcheck'
import { READY_EXTEND_MS, READY_TIMEOUT_MS } from './types'
import type {
  InstanceActionResult,
  InstanceServiceContext,
  InstanceStopResult,
  RuntimeEntry
} from './types'

export class InstanceService extends EventEmitter {
  // One copy of every piece of shared state. The domain modules only ever see
  // these through `ctx`, never through module-level copies.
  /** @internal */ runtimes = new Map<string, RuntimeEntry>()
  /** @internal */ startingIds = new Set<string>()
  /** One stop in flight per instance; concurrent callers await the same kill. */
  /** @internal */ stopping = new Map<string, Promise<InstanceStopResult>>()
  /** @internal */ logWriteCounters = new Map<string, number>()
  /** @internal */ versionCache = new Map<string, string | undefined>()
  /** @internal */ quitting: Promise<void> = Promise.resolve()

  private get ctx(): InstanceServiceContext {
    return this as unknown as InstanceServiceContext
  }

  /** @internal */
  ensureRuntime(config: ComfyInstanceConfig): RuntimeEntry {
    return runtime.ensureRuntime(this.ctx, config)
  }

  /** @internal */
  pushLog(rt: RuntimeEntry, level: ComfyLogLine['level'], message: string): void {
    logs.pushLog(this.ctx, rt, level, message)
  }

  /** @internal */
  appendLogFile(id: string, line: ComfyLogLine): void {
    logs.appendLogFile(this.ctx, id, line)
  }

  /** @internal */
  emitStatus(rt: RuntimeEntry): void {
    runtime.emitStatus(this.ctx, rt)
  }

  /** Drop cached version for one path (or all) so post-update probes see fresh data. */
  invalidateVersionCache(installPath?: string): void {
    runtime.invalidateVersionCache(this.ctx, installPath)
  }

  /** @internal */
  probeVersion(installPath: string): string | undefined {
    return runtime.probeVersion(this.ctx, installPath)
  }

  /** @internal */
  toInfo(rt: RuntimeEntry): ComfyInstanceInfo {
    return runtime.toInfo(this.ctx, rt)
  }

  /** Public URL used for readiness probes and opening the frontend. @internal */
  baseUrlOf(config: ComfyInstanceConfig): string {
    return runtime.baseUrlOf(config)
  }

  previewLaunch(id: string): LaunchCommandPreview {
    return launchArgs.previewLaunch(this.ctx, id)
  }

  /**
   * Write a runnable launch script (.bat / .sh) for an instance.
   * Uses the same resolved command as previewLaunch so what you see is what runs.
   */
  async exportLaunchScript(
    id: string,
    opts?: { dir?: string; kind?: 'bat' | 'sh' }
  ): Promise<{ path: string }> {
    return launchArgs.exportLaunchScript(this.ctx, id, opts)
  }

  /** Runtime capabilities of a running instance (0.1.10, probed + cached 30s). */
  async getCapabilities(id: string): Promise<InstanceCapabilities | null> {
    return runtime.getCapabilities(id)
  }

  /**
   * One-shot boot self-check (0.1.10): runs ComfyUI with `--quick-test-for-ci
   * --cpu` — ComfyUI loads every custom node and exits.
   * Output lines are streamed into the instance log VERBATIM (no prefix):
   * the "Import times for custom nodes" block must stay byte-compatible with
   * a real boot log so `node.loadReport` can parse it afterwards.
   */
  async runStartupSelfCheck(
    id: string
  ): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
    return selfcheck.runStartupSelfCheck(this.ctx, id)
  }

  list(): ComfyInstanceInfo[] {
    return discovery.list(this.ctx)
  }

  save(config: ComfyInstanceConfig): ComfyInstanceInfo {
    return discovery.save(this.ctx, config)
  }

  async remove(id: string): Promise<boolean> {
    return discovery.remove(this.ctx, id)
  }

  /** @internal */
  commonRoots(extra?: string): string[] {
    return discovery.commonRoots(extra)
  }

  discover(root?: string): InstanceDiscoveryCandidate[] {
    return discovery.discover(this.ctx, root)
  }

  /** @internal */
  scoreCandidate(path: string, out: InstanceDiscoveryCandidate[], registered?: Set<string>): void {
    discovery.scoreCandidate(this.ctx, path, out, registered)
  }

  getLogs(id: string, limit = 500): ComfyLogLine[] {
    return logs.getLogs(this.ctx, id, limit)
  }

  clearLogs(id: string): boolean {
    return logs.clearLogs(this.ctx, id)
  }

  /**
   * Custom-node packs that failed to import, parsed from the instance log
   * (0.1.16). Read-only — the UI decides whether to offer a dependency fix.
   */
  analyzeStartupIssues(id: string): InstanceStartupIssues {
    return selfcheck.analyzeStartupIssues(this.ctx, id)
  }

  async checkPort(port: number): Promise<PortCheckResult> {
    return lifecycle.checkPort(port)
  }

  async suggestPort(): Promise<number> {
    return lifecycle.suggestPort(this.ctx)
  }

  /**
   * Free port for a concurrent one-shot run (startup self-check) — random
   * high range first (0.1.11), sequential fallback, never the instance's own.
   */
  /** @internal */
  async pickEphemeralPort(avoid: number): Promise<number> {
    return lifecycle.pickEphemeralPort(this.ctx, avoid)
  }

  async probeEnv(id: string): Promise<EnvProbe> {
    return envProbe.probeEnv(this.ctx, id)
  }

  async exportDiagnostics(id: string): Promise<DiagnosticPackage> {
    return diagnostics.exportDiagnostics(this.ctx, id)
  }

  /** @internal */
  readLogFile(id: string): ComfyLogLine[] {
    return logs.readLogFile(id)
  }

  async copyDiagnostics(id: string): Promise<string> {
    return diagnostics.copyDiagnostics(this.ctx, id)
  }

  /**
   * Export the instance log to a file (0.1.11). Bounded, not unlimited: the
   * in-memory buffer is capped at 100k lines and readLogFile only reads the
   * tail of each generation (MAX_LOG_READ_BYTES). The comment used to claim
   * "ENTIRE" while doing exactly this — now it says what it does (0.1.17).
   */
  async exportLogs(id: string): Promise<{ path: string }> {
    return logs.exportLogs(this.ctx, id)
  }

  /**
   * Resolve the interpreter for an instance (shared implementation —
   * instance launch / env probe / node-pack pip all use the same rules).
   */
  /** @internal */
  resolvePython(config: ComfyInstanceConfig): string {
    return python.resolvePython(config)
  }

  /**
   * Throw codedError-style LAUNCH_ARGS_INVALID when the final argv contains
   * argparse-fatal conflicts. Shared by the spawn path and the port-relocation
   * path (which must validate before persisting the new port).
   */
  /** @internal */
  assertLaunchArgsValid(rt: RuntimeEntry, args: string[]): void {
    launchArgs.assertLaunchArgsValid(this.ctx, rt, args)
  }

  /** @internal */
  buildArgs(config: ComfyInstanceConfig): string[] {
    return launchArgs.buildArgs(config)
  }

  async start(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    return lifecycle.start(this.ctx, id, opts)
  }

  /**
   * Start and block until HTTP is ready (or throw).
   * Opening embed/browser is done by the IPC layer so this service stays
   * free of Electron shell/window dependencies.
   */
  async launch(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    return lifecycle.launch(this.ctx, id, opts)
  }

  async waitReady(
    id: string,
    timeoutMs = READY_TIMEOUT_MS + READY_EXTEND_MS + 5_000
  ): Promise<WaitReadyResult> {
    return lifecycle.waitReady(this.ctx, id, timeoutMs)
  }

  /** @internal */
  clearReadyProbe(rt: RuntimeEntry, error?: string): void {
    lifecycle.clearReadyProbe(this.ctx, rt, error)
  }

  async startAll(): Promise<InstanceActionResult[]> {
    return lifecycle.startAll(this.ctx)
  }

  async stopAll(): Promise<InstanceActionResult[]> {
    return lifecycle.stopAll(this.ctx)
  }

  async stop(id: string): Promise<InstanceStopResult> {
    return lifecycle.stop(this.ctx, id)
  }

  async restart(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    return lifecycle.restart(this.ctx, id, opts)
  }

  async forceKill(id: string): Promise<InstanceStopResult> {
    return lifecycle.forceKill(this.ctx, id)
  }

  async sweepStaleProcesses(): Promise<{
    entries: number
    killed: string[]
    unverified: string[]
  }> {
    return lifecycle.sweepStaleProcesses()
  }

  /**
   * Best-effort tree kill of every live child (0.1.18 WP3).
   *
   * The old version called `child.kill()` (which on Windows only terminates the
   * direct process) and immediately forgot the PID — the grandchild ComfyUI
   * kept the port and VRAM, and the next boot had no ledger entry to sweep.
   * The ledger now survives until the process is confirmed gone; an unfinished
   * kill stays for the startup sweep.
   */
  killAllNow(): void {
    lifecycle.killAllNow(this.ctx)
  }

  /** Await quit kills with a hard budget so the app always exits. */
  async killAllForQuit(budgetMs = 5000): Promise<void> {
    return lifecycle.killAllForQuit(this.ctx, budgetMs)
  }
}

export {
  normalizeLaunchProfile,
  quoteCommandLineArg,
  escapeForBat,
  escapeForSh
} from './launchArgs'
export { resolveInstancePythonPath, resolveRuntimesPythonSync } from './python'
export type { InstanceActionResult, InstanceExitReport, InstanceStopResult } from './types'

export const instanceService = new InstanceService()
