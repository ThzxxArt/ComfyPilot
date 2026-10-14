import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync
} from 'fs'
import { join, dirname, resolve, isAbsolute } from 'path'
import { homedir } from 'os'
import net from 'net'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  ComfyLogLine,
  DiagnosticPackage,
  EnvProbe,
  InstanceCapabilities,
  InstanceDiscoveryCandidate,
  InstanceStatus,
  LaunchCommandPreview,
  LaunchOptions,
  LaunchProfile,
  PortCheckResult,
  WaitReadyResult
} from '@shared/types'
import {
  deleteInstanceConfig,
  loadInstanceConfigs,
  loadSettings,
  logsDir,
  upsertInstanceConfig,
  userDataDir
} from './db'
import { resolveInsideAnyRoot } from './security'
import { proxyEnv } from './proxy'
import { findInRuntimes } from './bootstrap'
import { COMFY_DEFAULT_PORTS, LAUNCH_TEMPLATES } from '@shared/constants'
import { renderLaunchProfile, validateLaunchArgs, warnLaunchArgs } from '@shared/launchArgs'
import { capabilityService } from './capabilities'

const execFileAsync = promisify(execFile)

/** Drop undefined/default-only fields so instances.jsonc stays readable. */
export function normalizeLaunchProfile(profile?: LaunchProfile): LaunchProfile | undefined {
  if (!profile) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined || value === null || value === '') continue
    if (value === 'default') continue
    // Explicit `false` is KEPT: for toggle fields (e.g. disableAutoLaunch) it
    // is a real user decision, distinct from "unset".
    out[key] = value
  }
  return Object.keys(out).length ? (out as LaunchProfile) : undefined
}

/** Quote a single argv for display in a command-line preview (exported for tests). */
export function quoteCommandLineArg(s: string): string {
  return /[\s"&|<>^%]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** Escape a value for a Windows .bat line (cmd.exe). Not for display. */
export function escapeForBat(value: string): string {
  // % must become %% before any quoting; then escape cmd metacharacters.
  let s = String(value).replace(/%/g, '%%')
  // Double quotes inside a quoted arg: cmd uses "" doubling, not backslash.
  s = s.replace(/"/g, '""')
  // Escape remaining metacharacters that survive inside quotes poorly.
  s = s.replace(/([&|<>^!])/g, '^$1')
  return `"${s}"`
}

/** Escape a value for a POSIX shell single-quoted string. */
export function escapeForSh(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Synchronous lookup of the portable Python installed under userData/runtimes.
 * Kept sync so resolvePython (used on hot spawn paths) does not need await.
 * Delegates to bootstrap.findInRuntimes so nested install_only layouts match.
 */
export function resolveRuntimesPythonSync(): string | null {
  try {
    return findInRuntimes('python')
  } catch {
    return null
  }
}

/**
 * Shared interpreter resolution for an instance config.
 * Order: venv → explicit pythonPath → portable embeds (incl. AKI/绘世 sibling
 * `<root>/python/`) → ComfyPilot-managed runtime → bare `python`.
 * Used by instance launch, env probe and node-pack pip installs so all three
 * agree on one interpreter.
 */
export function resolveInstancePythonPath(config: ComfyInstanceConfig): string {
  if (config.venvPath) {
    const win = join(config.venvPath, 'Scripts', 'python.exe')
    const unix = join(config.venvPath, 'bin', 'python')
    if (existsSync(win)) return win
    if (existsSync(unix)) return unix
  }
  if (config.pythonPath) return config.pythonPath
  const parent = dirname(config.path)
  const candidates = [
    join(config.path, 'python_embeded', 'python.exe'),
    join(config.path, 'python_embedded', 'python.exe'),
    join(config.path, 'python', 'python.exe'),
    join(config.path, 'python', 'bin', 'python3'),
    join(parent, 'python', 'python.exe'),
    join(parent, 'python', 'bin', 'python3'),
    join(parent, 'python_embeded', 'python.exe'),
    join(parent, 'python_embedded', 'python.exe')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  const runtimePy = resolveRuntimesPythonSync()
  if (runtimePy) return runtimePy
  return 'python'
}

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
}

/** Per-instance outcome of a batch start/stop so the UI can summarize.
 *  Carries full ComfyInstanceInfo (status etc.) plus ok/error for the summary. */
export type InstanceActionResult = ComfyInstanceInfo & {
  ok: boolean
  error?: string
}

/** stop/forceKill result: `adopted` marks an external process we only signalled. */
export type InstanceStopResult = ComfyInstanceInfo & { adopted?: boolean }

const LOG_CAP = 5000
/** Minimum gap between same-status IPC pushes triggered by log lines. */
const STATUS_EMIT_MIN_MS = 1000
const READY_POLL_MS = 500
// Cold start with modern ComfyUI + plugins can take 60–120s before the HTTP
// port binds (alembic/kitchen/aimdo imports, torch JIT, custom nodes). 45s was
// a false negative — the process was alive and listening ~20s later.
const READY_TIMEOUT_MS = 180_000
/** If the process is still alive at the first timeout, grant one extra window. */
const READY_EXTEND_MS = 120_000

export class InstanceService extends EventEmitter {
  private runtimes = new Map<string, RuntimeEntry>()
  private startingIds = new Set<string>()

  private ensureRuntime(config: ComfyInstanceConfig): RuntimeEntry {
    let rt = this.runtimes.get(config.id)
    if (!rt) {
      rt = {
        config,
        status: 'stopped',
        logs: [],
        generation: 0,
        intentionalStop: false,
        ready: false,
        managed: false,
        readyWaiters: []
      }
      this.runtimes.set(config.id, rt)
    } else {
      rt.config = config
    }
    return rt
  }

  private pushLog(rt: RuntimeEntry, level: ComfyLogLine['level'], message: string): void {
    const line: ComfyLogLine = { ts: Date.now(), level, message, source: 'comfy' }
    rt.logs.push(line)
    if (rt.logs.length > LOG_CAP) rt.logs.splice(0, rt.logs.length - LOG_CAP)
    this.emit('log', rt.config.id, line)
    // Log lines arrive in bursts during startup — emitting full status per line
    // floods the IPC bridge. Only push when status changed, else at most 1/s.
    const now = Date.now()
    const changed = rt.lastEmittedStatus !== rt.status
    if (changed || now - (rt.lastStatusEmitAt ?? 0) >= STATUS_EMIT_MIN_MS) {
      this.emitStatus(rt)
    }
    this.appendLogFile(rt.config.id, line)
  }

  private appendLogFile(id: string, line: ComfyLogLine): void {
    try {
      const file = join(logsDir(), `${id}.log`)
      writeFileSync(
        file,
        `[${new Date(line.ts).toISOString()}] ${line.level.toUpperCase()} ${line.message}\n`,
        {
          flag: 'a'
        }
      )
    } catch {
      /* ignore */
    }
  }

  private emitStatus(rt: RuntimeEntry): void {
    rt.lastEmittedStatus = rt.status
    rt.lastStatusEmitAt = Date.now()
    this.emit('status', this.toInfo(rt))
  }

  private versionCache = new Map<string, string | undefined>()

  /** Drop cached version for one path (or all) so post-update probes see fresh data. */
  invalidateVersionCache(installPath?: string): void {
    if (installPath) this.versionCache.delete(installPath)
    else this.versionCache.clear()
  }

  private probeVersion(installPath: string): string | undefined {
    if (this.versionCache.has(installPath)) return this.versionCache.get(installPath)
    let version: string | undefined
    try {
      // Prefer the install stamp written by installer/updater (commit sha or fetch date).
      const envCandidates = [
        join(installPath, '.comfypilot-env.json'),
        join(dirname(installPath), '.comfypilot-env.json')
      ]
      for (const f of envCandidates) {
        if (!existsSync(f)) continue
        const data = JSON.parse(readFileSync(f, 'utf-8')) as {
          comfyVersion?: string
          comfyCommit?: string
          comfyFetchedAt?: number
        }
        if (data.comfyVersion) {
          version = data.comfyVersion
          break
        }
        if (data.comfyCommit) {
          version = data.comfyCommit.slice(0, 12)
          break
        }
        if (data.comfyFetchedAt) {
          version = new Date(data.comfyFetchedAt).toISOString().slice(0, 10)
          break
        }
      }
      if (!version) {
        const pyproject = join(installPath, 'pyproject.toml')
        if (existsSync(pyproject)) {
          const text = readFileSync(pyproject, 'utf-8')
          const m = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)
          if (m) version = m[1]
        }
      }
      if (!version && existsSync(join(installPath, 'main.py'))) version = 'detected'
      if (!version && existsSync(join(installPath, 'requirements.txt'))) version = 'detected'
    } catch {
      /* ignore */
    }
    this.versionCache.set(installPath, version)
    return version
  }

  private toInfo(rt: RuntimeEntry): ComfyInstanceInfo {
    return {
      ...rt.config,
      // Normalize fields older JSONC records may omit
      pinned: Boolean(rt.config.pinned),
      autoStart: Boolean(rt.config.autoStart),
      extraArgs: Array.isArray(rt.config.extraArgs) ? rt.config.extraArgs : [],
      status: rt.status,
      pid: rt.pid,
      // Same host normalization as probes/launch (0.0.0.0 / :: / [::] → 127.0.0.1)
      url: this.baseUrlOf(rt.config),
      startedAt: rt.startedAt,
      uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : undefined,
      lastError: rt.lastError,
      managerEnabled: rt.config.extraArgs?.some((a) => a.includes('enable-manager')),
      version: this.probeVersion(rt.config.path),
      // Real version reported by the running server (0.1.10) — only set when a
      // recent capability probe hit the instance while online.
      onlineVersion: capabilityService.knownVersionForUrl(this.baseUrlOf(rt.config))
    }
  }

  /** Public URL used for readiness probes and opening the frontend. */
  private baseUrlOf(config: ComfyInstanceConfig): string {
    const port = config.port || 8188
    const listen = config.listen || '127.0.0.1'
    const host = listen === '0.0.0.0' || listen === '::' || listen === '[::]' ? '127.0.0.1' : listen
    return `http://${host}:${port}`
  }

  previewLaunch(id: string): LaunchCommandPreview {
    const config = loadInstanceConfigs().find((c) => c.id === id)
    if (!config) throw new Error(`Instance not found: ${id}`)
    const python = this.resolvePython(config)
    const args = this.buildArgs(config)
    const commandLine = [python, ...args].map(quoteCommandLineArg).join(' ')
    return {
      python,
      args,
      cwd: config.path,
      commandLine,
      validationErrors: validateLaunchArgs(args),
      validationWarnings: warnLaunchArgs(args, {
        version: capabilityService.knownVersionForUrl(this.baseUrlOf(config))
      })
    }
  }

  /**
   * Write a runnable launch script (.bat / .sh) for an instance.
   * Uses the same resolved command as previewLaunch so what you see is what runs.
   */
  async exportLaunchScript(
    id: string,
    opts?: { dir?: string; kind?: 'bat' | 'sh' }
  ): Promise<{ path: string }> {
    const preview = this.previewLaunch(id)
    const kind = opts?.kind || (process.platform === 'win32' ? 'bat' : 'sh')
    const ext = kind === 'bat' ? '.bat' : '.sh'
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === id)
    const baseName = `launch-${(config?.name || 'comfyui').replace(/[^\w.-]+/g, '_').slice(0, 40)}`
    const { dialog } = await import('electron')
    const { writeFileSync, mkdirSync } = await import('fs')
    const { dirname, join } = await import('path')

    let target: string | undefined = opts?.dir ? join(opts.dir, baseName + ext) : undefined
    if (!target) {
      const win = await dialog.showSaveDialog({
        title: 'Export launch script',
        defaultPath: join(preview.cwd, baseName + ext),
        filters:
          kind === 'bat'
            ? [{ name: 'Batch', extensions: ['bat'] }]
            : [{ name: 'Shell', extensions: ['sh'] }]
      })
      if (win.canceled || !win.filePath) throw new Error('Cancelled')
      target = win.filePath
    }
    mkdirSync(dirname(target), { recursive: true })
    // Platform-correct escaping — quoteCommandLineArg is display-only and unsafe here.
    const body =
      kind === 'bat'
        ? `@echo off\r\nREM Generated by ComfyPilot\r\ncd /d ${escapeForBat(preview.cwd)}\r\n${escapeForBat(preview.python)} ${preview.args.map(escapeForBat).join(' ')}\r\n`
        : `#!/usr/bin/env bash\n# Generated by ComfyPilot\ncd ${escapeForSh(preview.cwd)}\n${escapeForSh(preview.python)} ${preview.args.map(escapeForSh).join(' ')}\n`
    writeFileSync(target, body, 'utf-8')
    return { path: target }
  }

  /** Runtime capabilities of a running instance (0.1.10, probed + cached 30s). */
  async getCapabilities(id: string): Promise<InstanceCapabilities | null> {
    const configs = loadInstanceConfigs()
    if (!configs.some((c) => c.id === id)) throw new Error(`Instance not found: ${id}`)
    return capabilityService.probe(id)
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
    const config = loadInstanceConfigs().find((c) => c.id === id)
    if (!config) throw new Error(`Instance not found: ${id}`)
    const rt = this.ensureRuntime(config)
    const running = Boolean(rt.process && rt.process.exitCode === null)
    if (!existsSync(join(config.path, 'main.py'))) {
      throw new Error(`main.py not found under ${config.path}`)
    }
    const python = this.resolvePython(config)
    // 0.1.11: a running instance no longer blocks the self-check. The runner
    // keeps its port and GPU; the check loads nodes on CPU with
    // --quick-test-for-ci on an ephemeral port and exits. Only the user/db
    // files are shared (same trade-off ComfyUI makes for concurrent runs).
    const args = [join(config.path, 'main.py'), '--quick-test-for-ci', '--cpu']
    if (running) {
      const port = await this.pickEphemeralPort(config.port || 8188)
      args.push('--port', String(port))
    }
    this.pushLog(
      rt,
      'info',
      running
        ? `Startup self-check (instance keeps running; check uses its own port): ${[python, ...args].join(' ')}`
        : `Startup self-check: ${[python, ...args].join(' ')}`
    )
    const result = await new Promise<{ ok: boolean; exitCode: number | null; output: string }>(
      (resolveP) => {
        execFile(
          python,
          args,
          {
            cwd: config.path,
            timeout: 180_000,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, ...proxyEnv(loadSettings().proxy) }
          },
          (err, stdout, stderr) => {
            const output = `${stdout || ''}${stderr || ''}`
            const rawCode = err ? (err as { code?: number | string }).code : 0
            const exitCode = typeof rawCode === 'number' ? rawCode : err ? 1 : 0
            resolveP({ ok: !err, exitCode, output })
          }
        )
      }
    )
    for (const line of result.output.split(/\r?\n/)) {
      if (!line.trim()) continue
      this.pushLog(rt, /error|traceback|failed/i.test(line) ? 'error' : 'info', line)
    }
    this.pushLog(
      rt,
      result.ok ? 'info' : 'error',
      result.ok
        ? 'Startup self-check passed'
        : `Startup self-check failed (exit ${result.exitCode})`
    )
    return result
  }

  list(): ComfyInstanceInfo[] {
    return loadInstanceConfigs()
      .map((c) => this.toInfo(this.ensureRuntime(c)))
      .sort((a, b) => {
        // Pinned first, then running, then name
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        const aRun = a.status === 'running' ? 0 : 1
        const bRun = b.status === 'running' ? 0 : 1
        if (aRun !== bRun) return aRun - bRun
        return a.name.localeCompare(b.name)
      })
  }

  save(config: ComfyInstanceConfig): ComfyInstanceInfo {
    const id = config.id || randomUUID()
    // Persist ONLY config fields — never runtime status/pid/url/uptime.
    const next: ComfyInstanceConfig = {
      id,
      name: config.name,
      path: config.path,
      pythonPath: config.pythonPath || '',
      venvPath: config.venvPath || '',
      port: config.port || 8188,
      listen: config.listen || '127.0.0.1',
      extraArgs: Array.isArray(config.extraArgs) ? config.extraArgs : [],
      argTemplateId: config.argTemplateId || 'default',
      enabled: config.enabled !== false,
      notes: config.notes || '',
      autoStart: Boolean(config.autoStart),
      frontendVersion: config.frontendVersion || '',
      pinned: Boolean(config.pinned),
      launchProfile: normalizeLaunchProfile(config.launchProfile)
    }
    upsertInstanceConfig(next)
    return this.toInfo(this.ensureRuntime(next))
  }

  remove(id: string): boolean {
    const rt = this.runtimes.get(id)
    if (rt?.process) {
      rt.intentionalStop = true
      rt.generation += 1
      this.clearReadyProbe(rt)
      try {
        rt.process.kill()
      } catch {
        /* ignore */
      }
      rt.process = undefined
    }
    // A removed instance must not keep a stale online version around.
    capabilityService.invalidate(id)
    this.runtimes.delete(id)
    return deleteInstanceConfig(id)
  }

  private commonRoots(extra?: string): string[] {
    const settings = loadSettings()
    const home = homedir()
    const candidates = [
      extra,
      process.env.COMFYUI_PATH,
      'D:\\ComfyUI',
      'C:\\ComfyUI',
      'D:\\AI\\ComfyUI',
      home,
      join(home, 'Desktop'),
      join(home, 'Documents'),
      join(home, 'Downloads'),
      join(process.env.USERPROFILE || '', 'ComfyUI'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'comfyui-desktop'),
      ...settings.modelScanRoots
    ].filter(Boolean) as string[]
    return [...new Set(candidates)]
  }

  discover(root?: string): InstanceDiscoveryCandidate[] {
    const found: InstanceDiscoveryCandidate[] = []
    const registered = new Set(
      loadInstanceConfigs().map((c) => {
        try {
          return resolve(c.path).toLowerCase()
        } catch {
          return c.path.toLowerCase()
        }
      })
    )
    // Renderer-supplied root must resolve inside an allow-listed tree; ignore otherwise.
    const safeRoot = root ? resolveInsideAnyRoot(root, this.commonRoots()) : null
    for (const p of this.commonRoots(safeRoot ?? undefined)) {
      if (!p || !existsSync(p)) continue
      let entries: string[] = []
      try {
        entries = readdirSync(p)
      } catch {
        continue
      }
      // root itself may be a ComfyUI install
      this.scoreCandidate(p, found, registered)
      // or contain sub-installs
      for (const name of entries.slice(0, 40)) {
        const child = join(p, name)
        try {
          if (statSync(child).isDirectory()) this.scoreCandidate(child, found, registered)
        } catch {
          /* skip */
        }
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, 20)
  }

  private scoreCandidate(
    path: string,
    out: InstanceDiscoveryCandidate[],
    registered?: Set<string>
  ): void {
    const hasMainPy = existsSync(join(path, 'main.py'))
    const hasRequirements = existsSync(join(path, 'requirements.txt'))
    // venv / portable embeds — including the AKI/绘世 sibling `python/` folder.
    // Only real interpreter layout counts (named dirs with python.exe/bin/python3),
    // never a bare `bin/python3` which would false-positive on ordinary projects.
    const embeddedDirs = ['python', 'python_embeded', 'python_embedded']
    const hasLocalPython = embeddedDirs.some(
      (d) => existsSync(join(path, d, 'python.exe')) || existsSync(join(path, d, 'bin', 'python3'))
    )
    const parent = dirname(path)
    const hasParentPython = embeddedDirs.some(
      (d) =>
        existsSync(join(parent, d, 'python.exe')) || existsSync(join(parent, d, 'bin', 'python3'))
    )
    const hasVenv =
      hasLocalPython ||
      hasParentPython ||
      existsSync(join(path, 'venv')) ||
      existsSync(join(path, '.venv'))
    if (!hasMainPy && !hasRequirements) return
    if (out.some((c) => c.path === path)) return
    let isRegistered = false
    try {
      isRegistered = Boolean(registered?.has(resolve(path).toLowerCase()))
    } catch {
      isRegistered = Boolean(registered?.has(path.toLowerCase()))
    }
    out.push({
      path,
      score:
        (hasMainPy ? 50 : 0) +
        (hasRequirements ? 20 : 0) +
        (hasVenv ? 30 : 0) -
        (isRegistered ? 100 : 0),
      reason: isRegistered
        ? 'Already registered'
        : hasMainPy
          ? 'Found main.py'
          : 'Found requirements.txt',
      hasMainPy,
      hasRequirements,
      hasVenv,
      estimatedVersion: this.probeVersion(path),
      registered: isRegistered
    })
  }

  getLogs(id: string, limit = 500): ComfyLogLine[] {
    const rt = this.runtimes.get(id)
    const mem = rt?.logs ?? []
    // Memory only holds the current process session; past runs live in the log file.
    const file = this.readLogFile(id)
    if (!file.length) return mem.slice(-limit)
    if (!mem.length) return file.slice(-limit)
    // pushLog writes to both sinks, so memory duplicates the file tail — drop
    // memory lines already present in the file and append only the remainder.
    const fileKeys = new Set(file.map((l) => `${l.ts}|${l.message}`))
    const extra = mem.filter((l) => !fileKeys.has(`${l.ts}|${l.message}`))
    return [...file, ...extra].slice(-limit)
  }

  clearLogs(id: string): boolean {
    const rt = this.runtimes.get(id)
    if (rt) rt.logs = []
    // Wipe the on-disk history too — getLogs merges the file back in, so leaving
    // it would make "Clear logs" a no-op on the next read. Also clear when there
    // is no live runtime (after an app restart the file is the only history).
    let removed = false
    try {
      const file = join(logsDir(), `${id}.log`)
      if (existsSync(file)) {
        rmSync(file)
        removed = true
      }
    } catch {
      /* ignore */
    }
    if (rt) this.emitStatus(rt)
    return Boolean(rt) || removed
  }

  async checkPort(port: number): Promise<PortCheckResult> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', (err: NodeJS.ErrnoException) => {
        resolve({
          port,
          available: false,
          owner: err.code === 'EADDRINUSE' ? 'port in use' : err.message
        })
      })
      server.once('listening', () => {
        server.close(() => resolve({ port, available: true }))
      })
      server.listen(port, '127.0.0.1')
    })
  }

  async suggestPort(): Promise<number> {
    for (const p of COMFY_DEFAULT_PORTS) {
      const check = await this.checkPort(p)
      if (check.available) return p
    }
    // Defaults are taken — probe a few random candidates instead of blindly
    // returning an unchecked port (the old fallback could collide).
    for (let i = 0; i < 8; i++) {
      const candidate = 9000 + Math.floor(Math.random() * 500)
      const check = await this.checkPort(candidate)
      if (check.available) return candidate
    }
    // Last resort: sequential scan just above the default range.
    for (let p = 8193; p < 8223; p++) {
      const check = await this.checkPort(p)
      if (check.available) return p
    }
    // Nothing free among the probed candidates — throw rather than hand back a
    // known-busy port (8188) that would silently fail to start.
    throw new Error('No free port found in the probed ranges')
  }

  /**
   * Free port for a concurrent one-shot run (startup self-check) — random
   * high range first (0.1.11), sequential fallback, never the instance's own.
   */
  private async pickEphemeralPort(avoid: number): Promise<number> {
    for (let i = 0; i < 16; i++) {
      const candidate = 8310 + Math.floor(Math.random() * 600)
      if (candidate === avoid) continue
      const check = await this.checkPort(candidate)
      if (check.available) return candidate
    }
    for (let p = 8910; p < 8960; p++) {
      if (p === avoid) continue
      const check = await this.checkPort(p)
      if (check.available) return p
    }
    throw new Error('No free port found for the startup self-check')
  }

  async probeEnv(id: string): Promise<EnvProbe> {
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === id)
    // Same platform-aware lookup as launch (venv Scripts/bin, embeds, fallback).
    const pythonPath = config ? this.resolvePython(config) : 'python'
    const errors: string[] = []
    let pythonVersion = ''
    let torchVersion: string | undefined
    let cudaVersion: string | undefined
    let mpsAvailable: boolean | undefined
    let npuAvailable: boolean | undefined
    const packages: Array<{ name: string; version: string }> = []

    try {
      const { stdout } = await execFileAsync(pythonPath, ['--version'], { timeout: 8000 })
      pythonVersion = stdout.trim() || (await this.pyVersionFallback(pythonPath))
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }

    try {
      const script = [
        'import torch, json',
        'print(json.dumps({',
        '"torch": getattr(torch, "__version__", ""),',
        '"cuda": getattr(torch.version, "cuda", None),',
        '"mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),',
        '"npu": bool(getattr(torch, "npu", None) and hasattr(torch.npu, "is_available") and torch.npu.is_available())',
        '}))'
      ].join(';')
      const { stdout } = await execFileAsync(pythonPath, ['-c', script], { timeout: 15000 })
      const data = JSON.parse(stdout.trim().split('\n').pop() || '{}')
      torchVersion = data.torch
      cudaVersion = data.cuda || undefined
      mpsAvailable = Boolean(data.mps)
      npuAvailable = Boolean(data.npu)
      packages.push({ name: 'torch', version: data.torch || '' })
    } catch (e) {
      errors.push('torch: ' + (e instanceof Error ? e.message : String(e)))
    }

    try {
      const { stdout } = await execFileAsync(pythonPath, ['-m', 'pip', 'list', '--format=json'], {
        timeout: 20000
      })
      const list = JSON.parse(stdout.trim()) as Array<{ name: string; version: string }>
      packages.push(...list.slice(0, 200))
    } catch {
      /* optional */
    }

    // pip availability (0.1.12 WP4) — probed and REPORTED. Previously the
    // "No module named pip" failure vanished into the catch above, so the env
    // card said OK while every manual pip path was dead.
    let pip: { present: boolean; version?: string } = { present: false }
    try {
      const { stdout } = await execFileAsync(pythonPath, ['-m', 'pip', '--version'], {
        timeout: 15000
      })
      const m = stdout.trim().match(/\bpip\s+([0-9][^\s]*)/i)
      if (m) pip = { present: true, version: m[1] }
    } catch {
      /* probed below */
    }
    if (!pip.present) {
      errors.push(
        'pip is not available in this environment — use Doctor "Fix pip" (ensurepip) or Repair environment'
      )
    }

    return {
      pythonPath,
      pythonVersion,
      venvPath: config?.venvPath || undefined,
      torchVersion,
      cudaVersion,
      mpsAvailable,
      npuAvailable,
      packages,
      pip,
      ok: errors.length === 0 && Boolean(pythonVersion),
      errors
    }
  }

  private async pyVersionFallback(pythonPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], {
        timeout: 8000
      })
      return stdout.trim()
    } catch {
      return ''
    }
  }

  async exportDiagnostics(id: string): Promise<DiagnosticPackage> {
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === id)
    const createdAt = Date.now()
    const dir = join(userDataDir(), 'diagnostics', `${id}-${createdAt}`)
    mkdirSync(dir, { recursive: true })
    const contents: string[] = []

    // config
    writeFileSync(join(dir, 'instance.json'), JSON.stringify(config, null, 2))
    contents.push('instance.json')

    // logs
    const rt = this.runtimes.get(id)
    const logs = rt?.logs || this.readLogFile(id)
    writeFileSync(
      join(dir, 'console.log'),
      logs.map((l) => `[${new Date(l.ts).toISOString()}] ${l.level} ${l.message}`).join('\n')
    )
    contents.push('console.log')

    // env probe
    try {
      const probe = await this.probeEnv(id)
      writeFileSync(join(dir, 'env.json'), JSON.stringify(probe, null, 2))
      contents.push('env.json')
    } catch {
      /* ignore */
    }

    // extra_model_paths
    if (config?.path) {
      const emp = join(config.path, 'extra_model_paths.yaml')
      if (existsSync(emp)) {
        writeFileSync(join(dir, 'extra_model_paths.yaml'), readFileSync(emp, 'utf-8'))
        contents.push('extra_model_paths.yaml')
      }
      const custom = join(config.path, 'custom_nodes')
      if (existsSync(custom)) {
        writeFileSync(join(dir, 'custom_nodes.txt'), readdirSync(custom).join('\n'))
        contents.push('custom_nodes.txt')
      }
    }

    // Online facts (0.1.10): /system_stats + /features give offline diagnosis
    // the exact version/packages/argv/feature-flag surface of the instance.
    if (config?.port) {
      const base = this.baseUrlOf(config)
      for (const [file, path] of [
        ['system-stats.json', '/system_stats'],
        ['features.json', '/features']
      ] as const) {
        try {
          const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2500) })
          if (res.ok) {
            writeFileSync(join(dir, file), JSON.stringify(await res.json(), null, 2))
            contents.push(file)
          }
        } catch {
          /* offline — the diagnostics package simply omits this file */
        }
      }
    }

    // Attribution facts (0.1.10): the prompt↔workflow sidecar plus a batch
    // linkage summary, so offline diagnosis can explain output provenance.
    try {
      const linksFile = join(userDataDir(), 'prompt_links.jsonc')
      let linksCount = 0
      if (existsSync(linksFile)) {
        writeFileSync(join(dir, 'prompt-links.json'), readFileSync(linksFile, 'utf-8'))
        contents.push('prompt-links.json')
        try {
          linksCount = Object.keys(JSON.parse(readFileSync(linksFile, 'utf-8')) as object).length
        } catch {
          linksCount = 0
        }
      }
      const { listBatchJobs } = await import('./db')
      const jobs = listBatchJobs()
      writeFileSync(
        join(dir, 'attribution.json'),
        JSON.stringify(
          {
            promptLinks: linksCount,
            batchJobs: jobs.length,
            batchOutputLinks: jobs.reduce(
              (s, j) => s + j.items.reduce((x, it) => x + (it.outputPaths?.length || 0), 0),
              0
            )
          },
          null,
          2
        )
      )
      contents.push('attribution.json')
    } catch {
      /* attribution is best-effort */
    }

    let size = 0
    for (const f of contents) {
      try {
        size += statSync(join(dir, f)).size
      } catch {
        /* ignore */
      }
    }

    return { path: dir, createdAt, size, contents }
  }

  private readLogFile(id: string): ComfyLogLine[] {
    try {
      const file = join(logsDir(), `${id}.log`)
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          // Write format is `[ISO] LEVEL message` with exactly one space after
          // the level. A greedy `\s+` would swallow leading spaces from the
          // message and break ts|message dedupe against in-memory lines
          // (Python traceback indent lines would be duplicated).
          const m = line.match(/^\[([^\]]+)\] (\w+) (.*)$/)
          return {
            ts: m ? Date.parse(m[1]) : Date.now(),
            level: (m?.[2]?.toLowerCase() as ComfyLogLine['level']) || 'info',
            // `??` (not `||`) so an empty message stays empty instead of
            // falling back to the raw line and missing the dedupe key.
            message: m ? m[3] : line
          }
        })
    } catch {
      return []
    }
  }

  async copyDiagnostics(id: string): Promise<string> {
    const pkg = await this.exportDiagnostics(id)
    return pkg.path
  }

  /**
   * Export the full instance log to a file (0.1.11). Unlike the clipboard
   * copy, this streams the ENTIRE buffer + log file to disk and reveals it.
   */
  async exportLogs(id: string): Promise<{ path: string }> {
    const lines = this.getLogs(id, 100_000)
    const dir = join(userDataDir(), 'exports')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // Human-readable instance name first (0.1.12 — `id-timestamp` files were
    // indistinguishable); unicode letters/numbers kept, separators collapsed.
    const cfg = loadInstanceConfigs().find((c) => c.id === id)
    const base =
      String(cfg?.name || id)
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || id
    const file = join(dir, `${base}-${stamp}.log`)
    writeFileSync(
      file,
      lines
        .map((l) => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.message}`)
        .join('\n') + '\n',
      'utf-8'
    )
    return { path: file }
  }

  /**
   * Resolve the interpreter for an instance (shared implementation —
   * instance launch / env probe / node-pack pip all use the same rules).
   */
  private resolvePython(config: ComfyInstanceConfig): string {
    return resolveInstancePythonPath(config)
  }

  /**
   * Throw codedError-style LAUNCH_ARGS_INVALID when the final argv contains
   * argparse-fatal conflicts. Shared by the spawn path and the port-relocation
   * path (which must validate before persisting the new port).
   */
  private assertLaunchArgsValid(rt: RuntimeEntry, args: string[]): void {
    const argErrors = validateLaunchArgs(args)
    if (!argErrors.length) return
    const err = new Error(
      `Invalid launch arguments: ${argErrors
        .map((e) => (e.flag ? `${e.code} (${e.flag})` : e.code))
        .join(', ')}`
    ) as Error & { code?: string }
    err.code = 'LAUNCH_ARGS_INVALID'
    rt.lastError = err.message
    rt.status = 'error'
    this.pushLog(rt, 'error', err.message)
    this.emitStatus(rt)
    throw err
  }

  private buildArgs(config: ComfyInstanceConfig): string[] {
    const args = [join(config.path, 'main.py'), '--port', String(config.port || 8188)]
    const template = LAUNCH_TEMPLATES.find((t) => t.id === config.argTemplateId)
    const templateArgs = template?.args || []
    // Dedupe `--listen`: the lan template brings its own 0.0.0.0 — pushing the
    // configured listen first made the printed command line ambiguous.
    if (!templateArgs.includes('--listen')) args.push('--listen', config.listen || '127.0.0.1')
    args.push(...templateArgs)
    // Structured tuning renders before free-text extraArgs so an explicit
    // override in extraArgs still wins by being last.
    const profileArgs = renderLaunchProfile(config.launchProfile)
    args.push(...profileArgs)
    const extra = Array.isArray(config.extraArgs)
      ? config.extraArgs
      : String(config.extraArgs || '')
          .split(/\s+/)
          .filter(Boolean)
    // Explicitly load the instance's extra_model_paths.yaml when it exists, so
    // a custom cwd / --base-directory can never silently lose the model paths.
    const yamlPath = join(config.path, 'extra_model_paths.yaml')
    const declared = [...templateArgs, ...profileArgs, ...extra].includes(
      '--extra-model-paths-config'
    )
    if (!declared && existsSync(yamlPath)) {
      args.push('--extra-model-paths-config', yamlPath)
    }
    // Default: ComfyUI must not open a browser tab on its own — ComfyPilot owns
    // window/browser opening. Skipped when the user declared either side of the
    // flag explicitly (template / profile / free text) and when the profile
    // explicitly opted out (disableAutoLaunch=false keeps ComfyUI's own default).
    const autoLaunchDeclared = [...templateArgs, ...profileArgs, ...extra].some(
      (a) => a === '--auto-launch' || a === '--disable-auto-launch'
    )
    if (!autoLaunchDeclared && config.launchProfile?.disableAutoLaunch !== false) {
      args.push('--disable-auto-launch')
    }
    if (extra.length) args.push(...extra)
    return args
  }

  async start(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    if (this.startingIds.has(id)) {
      throw new Error('Instance start already in progress')
    }
    this.startingIds.add(id)
    try {
      return await this.startInner(id, opts)
    } finally {
      this.startingIds.delete(id)
    }
  }

  /**
   * Start and block until HTTP is ready (or throw).
   * Opening embed/browser is done by the IPC layer so this service stays
   * free of Electron shell/window dependencies.
   */
  async launch(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    const info = await this.start(id, opts)
    const rt = this.runtimes.get(id)
    if (rt?.ready && rt.status === 'running') return info
    const waited = await this.waitReady(id)
    if (!waited.ready) {
      throw new Error(waited.error || 'Instance did not become ready')
    }
    return waited.info
  }

  async waitReady(
    id: string,
    timeoutMs = READY_TIMEOUT_MS + READY_EXTEND_MS + 5_000
  ): Promise<WaitReadyResult> {
    const rt = this.runtimes.get(id)
    const started = Date.now()
    if (!rt) {
      const configs = loadInstanceConfigs()
      const config = configs.find((c) => c.id === id)
      if (!config) throw new Error(`Instance not found: ${id}`)
      return {
        ready: false,
        info: this.toInfo(this.ensureRuntime(config)),
        error: 'Instance is not running',
        elapsedMs: 0
      }
    }
    if (rt.ready && rt.status === 'running') {
      return { ready: true, info: this.toInfo(rt), elapsedMs: 0 }
    }
    if (rt.status === 'error') {
      return {
        ready: false,
        info: this.toInfo(rt),
        error: rt.lastError || 'Instance is in error state',
        elapsedMs: Date.now() - started
      }
    }
    return new Promise<WaitReadyResult>((resolveWait) => {
      const waiter: RuntimeEntry['readyWaiters'][number] = {
        resolve: () => undefined
      }
      const finish = (result: WaitReadyResult): void => {
        if (waiter.timer) {
          clearTimeout(waiter.timer)
          waiter.timer = undefined
        }
        rt.readyWaiters = rt.readyWaiters.filter((w) => w !== waiter)
        resolveWait(result)
      }
      waiter.resolve = finish
      waiter.timer = setTimeout(() => {
        finish({
          ready: false,
          info: this.toInfo(rt),
          error: `Instance did not become ready within ${Math.round(timeoutMs / 1000)}s`,
          elapsedMs: Date.now() - started
        })
      }, timeoutMs)
      rt.readyWaiters.push(waiter)
    })
  }

  private settleReadyWaiters(rt: RuntimeEntry, error?: string): void {
    const waiters = rt.readyWaiters
    rt.readyWaiters = []
    for (const w of waiters) {
      if (w.timer) {
        clearTimeout(w.timer)
        w.timer = undefined
      }
      w.resolve({
        ready: rt.ready && rt.status === 'running',
        info: this.toInfo(rt),
        error,
        elapsedMs: 0
      })
    }
  }

  /** Poll /system_stats until ComfyUI answers or the process dies. */
  private beginReadyProbe(rt: RuntimeEntry, gen: number): void {
    if (rt.readyPollTimer) {
      clearInterval(rt.readyPollTimer)
      rt.readyPollTimer = undefined
    }
    const started = Date.now()
    let deadline = started + READY_TIMEOUT_MS
    let extended = false
    const base = this.baseUrlOf(rt.config)
    const tick = async (): Promise<void> => {
      if (rt.generation !== gen) {
        if (rt.readyPollTimer) {
          clearInterval(rt.readyPollTimer)
          rt.readyPollTimer = undefined
        }
        return
      }
      if (!rt.process || rt.process.exitCode !== null) {
        // Process vanished without going through exit() — stop polling.
        if (rt.readyPollTimer) {
          clearInterval(rt.readyPollTimer)
          rt.readyPollTimer = undefined
        }
        return
      }
      try {
        const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(1200) })
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as {
            system?: unknown
            devices?: unknown
          } | null
          if (data && typeof data === 'object' && ('system' in data || 'devices' in data)) {
            if (rt.generation !== gen) return
            rt.ready = true
            rt.status = 'running'
            if (rt.readyPollTimer) {
              clearInterval(rt.readyPollTimer)
              rt.readyPollTimer = undefined
            }
            this.pushLog(rt, 'info', `ComfyUI ready at ${base} (${Date.now() - started}ms)`)
            // Establish the online-version fact immediately (0.1.11.1): before
            // this, the card showed it only inside the 30s probe window and
            // then flipped back to the install stamp (a commit sha).
            void capabilityService.probe(rt.config.id).catch(() => undefined)
            this.settleReadyWaiters(rt)
            return
          }
        }
      } catch {
        /* not up yet */
      }
      const now = Date.now()
      if (now > deadline) {
        if (rt.generation !== gen) return
        // Process still alive → give it one more window. Cold start with
        // plugins routinely exceeds 45s before the HTTP port binds.
        const stillAlive = rt.process && rt.process.exitCode === null
        if (stillAlive && !extended) {
          extended = true
          deadline = now + READY_EXTEND_MS
          this.pushLog(
            rt,
            'info',
            `Still waiting for HTTP on ${base} (process alive, ${Math.round((now - started) / 1000)}s) — extending…`
          )
          return
        }
        rt.status = 'error'
        rt.lastError = `ComfyUI did not answer on ${base} within ${Math.round((now - started) / 1000)}s`
        if (rt.readyPollTimer) {
          clearInterval(rt.readyPollTimer)
          rt.readyPollTimer = undefined
        }
        this.pushLog(rt, 'error', rt.lastError)
        this.settleReadyWaiters(rt, rt.lastError)
      }
    }
    rt.readyPollTimer = setInterval(() => {
      void tick()
    }, READY_POLL_MS)
    void tick()
  }

  private clearReadyProbe(rt: RuntimeEntry, error?: string): void {
    if (rt.readyPollTimer) {
      clearInterval(rt.readyPollTimer)
      rt.readyPollTimer = undefined
    }
    rt.ready = false
    this.settleReadyWaiters(rt, error ?? (rt.intentionalStop ? 'Stopped' : rt.lastError))
  }

  private async startInner(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    const config = loadInstanceConfigs().find((c) => c.id === id)
    if (!config) throw new Error(`Instance not found: ${id}`)
    const rt = this.ensureRuntime(config)
    if (rt.process && rt.process.exitCode === null) {
      if (rt.ready) return this.toInfo(rt)
      // Process is up but not ready yet — wait for the existing probe.
      const waited = await this.waitReady(id)
      if (!waited.ready) throw new Error(waited.error || 'Instance did not become ready')
      return waited.info
    }

    let effectivePort = config.port || 8188
    const portCheck = await this.checkPort(effectivePort)
    if (!portCheck.available) {
      // Port may be occupied by a ComfyUI we can adopt (already running).
      const base = this.baseUrlOf({ ...config, port: effectivePort })
      try {
        const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          rt.status = 'running'
          rt.ready = true
          rt.managed = false
          rt.startedAt = rt.startedAt ?? Date.now()
          this.pushLog(
            rt,
            'info',
            `Adopted already-running ComfyUI at ${base} (external process — stop will not kill it)`
          )
          this.emitStatus(rt)
          return this.toInfo(rt)
        }
      } catch {
        /* not ComfyUI — real conflict */
      }
      if (opts?.relocatePort) {
        const next = await this.suggestPort()
        effectivePort = next
        const nextConfig: ComfyInstanceConfig = { ...config, port: next }
        // Validate BEFORE persisting: an argparse-fatal combo must not leave a
        // half-applied port change behind when the launch is refused.
        this.assertLaunchArgsValid(rt, this.buildArgs(nextConfig))
        this.pushLog(
          rt,
          'warn',
          `Port ${effectivePort} is in use — relocating to ${next} (persisted to instance config)`
        )
        upsertInstanceConfig(nextConfig)
        rt.config = nextConfig
      } else {
        rt.lastError = `Port ${effectivePort} is already in use`
        rt.status = 'error'
        this.pushLog(rt, 'error', rt.lastError)
        this.emitStatus(rt)
        const err = new Error(rt.lastError) as Error & { code?: string; suggestedPort?: number }
        err.code = 'PORT_IN_USE'
        err.suggestedPort = await this.suggestPort()
        throw err
      }
    }

    rt.generation += 1
    const gen = rt.generation
    rt.intentionalStop = false
    rt.status = 'starting'
    rt.ready = false
    rt.managed = true
    rt.lastError = undefined
    rt.startedAt = undefined
    this.emitStatus(rt)

    const python = this.resolvePython(rt.config)
    const args = this.buildArgs(rt.config)
    // Refuse argparse-fatal combos (mutually exclusive groups) BEFORE spawn —
    // ComfyUI would otherwise exit instantly with an opaque usage error.
    this.assertLaunchArgsValid(rt, args)
    // Advisories never block: unknown/recent flags may still be perfectly valid
    // (version drift), so they only land in the instance log. When the online
    // version is known, confirmed-recent flags are silenced entirely.
    for (const w of warnLaunchArgs(args, {
      version: capabilityService.cachedForUrl(this.baseUrlOf(rt.config))?.version
    })) {
      this.pushLog(
        rt,
        'warn',
        w.code === 'unknown-flag'
          ? `Unrecognized flag ${w.flag}`
          : w.code === 'duplicate-listen'
            ? 'Multiple --listen flags — the last one wins'
            : `Flag ${w.flag} requires a recent ComfyUI build`
      )
    }
    // Path-valued flags that point nowhere usually mean a typo'd path; warn.
    const pathFlags = new Set([
      '--extra-model-paths-config',
      '--output-directory',
      '--input-directory',
      '--temp-directory',
      '--base-directory',
      '--user-directory',
      '--models-directory'
    ])
    for (let i = 0; i < args.length - 1; i++) {
      if (!pathFlags.has(args[i])) continue
      const p = args[i + 1]
      if (!p || p.startsWith('--')) continue
      const abs = isAbsolute(p) ? p : resolve(rt.config.path, p)
      if (!existsSync(abs)) {
        this.pushLog(rt, 'warn', `${args[i]} path does not exist: ${abs}`)
      }
    }

    try {
      const child = spawn(python, args, {
        cwd: rt.config.path,
        windowsHide: true,
        // Honor app proxy so ComfyUI-internal network calls (API nodes) see the same
        // proxy the rest of ComfyPilot uses. Falls back cleanly when proxy is off.
        env: { ...process.env, ...proxyEnv(loadSettings().proxy) }
      })
      rt.process = child
      rt.pid = child.pid
      rt.startedAt = Date.now()

      child.stdout.on('data', (buf: Buffer) => {
        if (rt.generation !== gen) return
        buf
          .toString('utf-8')
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((line) => {
            // "Exception"/"!!!" added in 0.1.12: ComfyUI's execution failure
            // banner (`!!! Exception during processing !!!`) contains neither
            // "error" nor "traceback" and used to render as plain white info.
            const level = /error|traceback|exception|!!!/i.test(line)
              ? 'error'
              : /warn/i.test(line)
                ? 'warn'
                : 'info'
            this.pushLog(rt, level, line)
          })
      })
      child.stderr.on('data', (buf: Buffer) => {
        if (rt.generation !== gen) return
        buf
          .toString('utf-8')
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((line) =>
            this.pushLog(rt, /error|traceback|exception|!!!/i.test(line) ? 'error' : 'warn', line)
          )
      })
      child.on('error', (err) => {
        if (rt.generation !== gen) return
        rt.lastError = err.message
        rt.status = 'error'
        if (rt.process === child) {
          rt.process = undefined
          rt.pid = undefined
        }
        this.clearReadyProbe(rt)
        this.pushLog(rt, 'error', err.message)
      })
      child.on('exit', (code, signal) => {
        // Stale handler from a previous generation must not clobber a newer process.
        if (rt.generation !== gen) return
        if (rt.process === child) {
          rt.process = undefined
          rt.pid = undefined
        }
        const intentional = rt.intentionalStop || signal === 'SIGTERM' || signal === 'SIGKILL'
        rt.status = intentional ? 'stopped' : code === 0 ? 'stopped' : 'error'
        if (!intentional && code !== 0) rt.lastError = `Exited with code ${code}`
        this.clearReadyProbe(rt)
        // The process is gone — its online version is no longer "online".
        capabilityService.invalidate(rt.config.id)
        this.pushLog(
          rt,
          code === 0 || intentional ? 'info' : 'error',
          `Process exited code=${code} signal=${signal}`
        )
      })

      this.beginReadyProbe(rt, gen)
    } catch (err) {
      rt.status = 'error'
      rt.lastError = err instanceof Error ? err.message : String(err)
      this.clearReadyProbe(rt)
      this.emitStatus(rt)
      throw err
    }

    // Surface errors fast: if the process dies in the first moments, rethrow.
    await new Promise((r) => setTimeout(r, 200))
    const lateStatus = rt.status as InstanceStatus
    if (rt.generation === gen && lateStatus === 'error' && rt.lastError) {
      throw new Error(rt.lastError)
    }

    return this.toInfo(rt)
  }

  async startAll(): Promise<InstanceActionResult[]> {
    const configs = loadInstanceConfigs().filter((c) => c.enabled !== false)
    const out: InstanceActionResult[] = []
    for (const c of configs) {
      try {
        // A pack already mid-start must be WAITED for, not rejected — the old
        // path let the startingIds guard throw "already in progress" and the
        // batch summary reported a bogus failure (0.1.11).
        if (this.startingIds.has(c.id)) {
          const waited = await this.waitReady(c.id)
          out.push({
            ...waited.info,
            ok: waited.ready,
            error: waited.ready ? undefined : waited.error || 'Start did not complete'
          })
          continue
        }
        const info = await this.start(c.id)
        out.push({ ...info, ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.pushLog(this.ensureRuntime(c), 'error', `startAll: ${msg}`)
        out.push({ ...this.toInfo(this.ensureRuntime(c)), ok: false, error: msg })
      }
    }
    return out
  }

  async stopAll(): Promise<InstanceActionResult[]> {
    const out: InstanceActionResult[] = []
    for (const rt of this.runtimes.values()) {
      if (!rt.process) continue
      const id = rt.config.id
      try {
        const info = await this.stop(id)
        out.push({ ...info, ok: true })
      } catch (err) {
        out.push({
          ...this.toInfo(rt),
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return out
  }

  async stop(id: string): Promise<InstanceStopResult> {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Instance not found: ${id}`)
    rt.intentionalStop = true
    rt.generation += 1
    const child = rt.process
    const wasManaged = rt.managed
    // Snapshot BEFORE overwriting status/ready so a second stop of an adopted
    // external process can still see that it was live.
    const wasRunning = rt.status === 'running' || rt.status === 'starting'
    const wasReady = rt.ready
    rt.process = undefined
    rt.pid = undefined
    rt.status = 'stopped'
    this.clearReadyProbe(rt, wasManaged ? 'Stopped' : 'External process left running')
    // Drop the online version — a stopped instance shows the install stamp.
    capabilityService.invalidate(id)
    let adopted = false
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          // `killed` is true after ANY successful kill() (including SIGTERM), so it
          // cannot gate escalation — only exitCode tells us the child is gone.
          if (child.exitCode === null) child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 3000)
    } else if (!wasManaged && (wasReady || wasRunning)) {
      // We only adopted an external ComfyUI — be honest instead of pretending we killed it.
      adopted = true
      this.pushLog(
        rt,
        'warn',
        'Stop requested for an adopted external process — it is still running outside ComfyPilot'
      )
    }
    rt.managed = false
    this.emitStatus(rt)
    const info = this.toInfo(rt) as InstanceStopResult
    if (adopted) info.adopted = true
    return info
  }

  async restart(id: string, opts?: LaunchOptions): Promise<ComfyInstanceInfo> {
    await this.stop(id)
    // Wait until port is free (or timeout) so start() does not race a dying process.
    const config = loadInstanceConfigs().find((c) => c.id === id)
    const port = config?.port || 8188
    for (let i = 0; i < 20; i++) {
      const check = await this.checkPort(port)
      if (check.available) break
      await new Promise((r) => setTimeout(r, 150))
    }
    // Restart must not return until the new process is actually ready.
    return this.launch(id, opts)
  }

  async forceKill(id: string): Promise<InstanceStopResult> {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Instance not found: ${id}`)
    rt.intentionalStop = true
    rt.generation += 1
    const child = rt.process
    const pid = rt.pid
    const wasManaged = rt.managed
    // Snapshot readiness before clearReadyProbe zeroes it (same as stop()).
    const wasReady = rt.ready
    rt.process = undefined
    rt.pid = undefined
    this.clearReadyProbe(rt, 'Force killed')
    capabilityService.invalidate(id)
    let adopted = false
    if (child) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    } else if (pid && wasManaged) {
      // Only kill PID if we spawned it and no longer own a live child handle (avoid PID reuse races).
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    } else if (!wasManaged && (wasReady || rt.status === 'running')) {
      // Live external ComfyUI we refused to kill — tell the UI we only signalled state.
      adopted = true
      this.pushLog(
        rt,
        'warn',
        'Force-kill requested for an adopted external process — refusing to kill an unowned PID'
      )
    }
    rt.status = 'stopped'
    rt.managed = false
    this.pushLog(rt, 'warn', 'Force killed')
    this.emitStatus(rt)
    const info = this.toInfo(rt) as InstanceStopResult
    if (adopted) info.adopted = true
    return info
  }

  /** Synchronous best-effort kill used on app quit. */
  killAllNow(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.process) {
        rt.intentionalStop = true
        rt.generation += 1
        this.clearReadyProbe(rt)
        try {
          rt.process.kill()
        } catch {
          /* ignore */
        }
        rt.process = undefined
        rt.status = 'stopped'
      }
    }
  }
}

export const instanceService = new InstanceService()

export { dirname, rmSync }
