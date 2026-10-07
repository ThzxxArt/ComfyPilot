import { EventEmitter } from 'events'
import { createHash, randomUUID } from 'crypto'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { homedir } from 'os'
import net from 'net'
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

const execFileAsync = promisify(execFile)

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
}

const LOG_CAP = 5000
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
    this.emitStatus(rt)
    this.appendLogFile(rt.config.id, line)
  }

  private appendLogFile(id: string, line: ComfyLogLine): void {
    try {
      const file = join(logsDir(), `${id}.log`)
      writeFileSync(file, `[${new Date(line.ts).toISOString()}] ${line.level.toUpperCase()} ${line.message}\n`, {
        flag: 'a'
      })
    } catch {
      /* ignore */
    }
  }

  private emitStatus(rt: RuntimeEntry): void {
    this.emit('status', this.toInfo(rt))
  }

  private versionCache = new Map<string, string | undefined>()

  private probeVersion(installPath: string): string | undefined {
    if (this.versionCache.has(installPath)) return this.versionCache.get(installPath)
    let version: string | undefined
    try {
      const pyproject = join(installPath, 'pyproject.toml')
      if (existsSync(pyproject)) {
        const text = readFileSync(pyproject, 'utf-8')
        const m = text.match(/version\s*=\s*["']([^"']+)["']/)
        if (m) version = m[1]
      }
      if (!version && existsSync(join(installPath, 'requirements.txt'))) version = 'detected'
    } catch {
      /* ignore */
    }
    this.versionCache.set(installPath, version)
    return version
  }

  private toInfo(rt: RuntimeEntry): ComfyInstanceInfo {
    const port = rt.config.port || 8188
    const listen = rt.config.listen || '127.0.0.1'
    return {
      ...rt.config,
      // Normalize fields older JSONC records may omit
      pinned: Boolean(rt.config.pinned),
      autoStart: Boolean(rt.config.autoStart),
      extraArgs: Array.isArray(rt.config.extraArgs) ? rt.config.extraArgs : [],
      status: rt.status,
      pid: rt.pid,
      url: `http://${listen === '0.0.0.0' ? '127.0.0.1' : listen}:${port}`,
      startedAt: rt.startedAt,
      uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : undefined,
      lastError: rt.lastError,
      managerEnabled: rt.config.extraArgs?.some((a) => a.includes('enable-manager')),
      version: this.probeVersion(rt.config.path)
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
    return { python, args, cwd: config.path, commandLine }
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

    let target: string | undefined = opts?.dir
      ? join(opts.dir, baseName + ext)
      : undefined
    if (!target) {
      const win = await dialog.showSaveDialog({
        title: 'Export launch script',
        defaultPath: join(preview.cwd, baseName + ext),
        filters: kind === 'bat' ? [{ name: 'Batch', extensions: ['bat'] }] : [{ name: 'Shell', extensions: ['sh'] }]
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
      pinned: Boolean(config.pinned)
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
      settings.defaultInstancePath,
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
    const hasVenv =
      existsSync(join(path, 'venv')) ||
      existsSync(join(path, '.venv')) ||
      existsSync(join(path, 'python_embeded')) ||
      existsSync(join(path, 'python_embedded'))
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
      score: (hasMainPy ? 50 : 0) + (hasRequirements ? 20 : 0) + (hasVenv ? 30 : 0) - (isRegistered ? 100 : 0),
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
    return rt ? rt.logs.slice(-limit) : []
  }

  clearLogs(id: string): boolean {
    const rt = this.runtimes.get(id)
    if (!rt) return false
    rt.logs = []
    this.emitStatus(rt)
    return true
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
    return 9000 + Math.floor(Math.random() * 500)
  }

  async probeEnv(id: string): Promise<EnvProbe> {
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === id)
    // Same platform-aware lookup as launch (venv Scripts/bin, embeds, fallback).
    const pythonPath = config
      ? this.resolvePython(config)
      : 'python'
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

    return {
      pythonPath,
      pythonVersion,
      venvPath: config?.venvPath || undefined,
      torchVersion,
      cudaVersion,
      mpsAvailable,
      npuAvailable,
      packages,
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
          const m = line.match(/^\[([^\]]+)\]\s+(\w+)\s+(.*)$/)
          return {
            ts: m ? Date.parse(m[1]) : Date.now(),
            level: (m?.[2]?.toLowerCase() as ComfyLogLine['level']) || 'info',
            message: m?.[3] || line
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
   * Resolve the interpreter for an instance.
   * Order: venv → pythonPath → portable embeds under the install →
   * ComfyPilot runtimes (zero-prereq bootstrap) → bare `python`.
   */
  private resolvePython(config: ComfyInstanceConfig): string {
    if (config.venvPath) {
      const win = join(config.venvPath, 'Scripts', 'python.exe')
      const unix = join(config.venvPath, 'bin', 'python')
      if (existsSync(win)) return win
      if (existsSync(unix)) return unix
    }
    if (config.pythonPath) return config.pythonPath
    // Portable embeds shipped next to ComfyUI
    const embed = join(config.path, 'python_embeded', 'python.exe')
    if (existsSync(embed)) return embed
    const embed2 = join(config.path, 'python_embedded', 'python.exe')
    if (existsSync(embed2)) return embed2
    // ComfyPilot-managed portable Python (downloaded by bootstrap)
    const runtimePy = resolveRuntimesPythonSync()
    if (runtimePy) return runtimePy
    return 'python'
  }

  private buildArgs(config: ComfyInstanceConfig): string[] {
    const args = [
      join(config.path, 'main.py'),
      '--port',
      String(config.port || 8188),
      '--listen',
      config.listen || '127.0.0.1'
    ]
    const template = LAUNCH_TEMPLATES.find((t) => t.id === config.argTemplateId)
    if (template) args.push(...template.args)
    const extra = Array.isArray(config.extraArgs)
      ? config.extraArgs
      : String(config.extraArgs || '')
          .split(/\s+/)
          .filter(Boolean)
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

  async waitReady(id: string, timeoutMs = READY_TIMEOUT_MS + READY_EXTEND_MS + 5_000): Promise<WaitReadyResult> {
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
          const data = (await res.json().catch(() => null)) as { system?: unknown; devices?: unknown } | null
          if (data && typeof data === 'object' && ('system' in data || 'devices' in data)) {
            if (rt.generation !== gen) return
            rt.ready = true
            rt.status = 'running'
            if (rt.readyPollTimer) {
              clearInterval(rt.readyPollTimer)
              rt.readyPollTimer = undefined
            }
            this.pushLog(rt, 'info', `ComfyUI ready at ${base} (${Date.now() - started}ms)`)
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
        this.pushLog(
          rt,
          'warn',
          `Port ${effectivePort} is in use — relocating to ${next} (persisted to instance config)`
        )
        effectivePort = next
        const nextConfig: ComfyInstanceConfig = { ...config, port: next }
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
            const level = /error|traceback/i.test(line)
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
            this.pushLog(rt, /error|traceback/i.test(line) ? 'error' : 'warn', line)
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
        this.pushLog(rt, code === 0 || intentional ? 'info' : 'error', `Process exited code=${code} signal=${signal}`)
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

  async startAll(): Promise<ComfyInstanceInfo[]> {
    const configs = loadInstanceConfigs().filter((c) => c.enabled !== false)
    const out: ComfyInstanceInfo[] = []
    for (const c of configs) {
      try {
        out.push(await this.start(c.id))
      } catch (err) {
        this.pushLog(
          this.ensureRuntime(c),
          'error',
          `startAll: ${err instanceof Error ? err.message : String(err)}`
        )
        out.push(this.toInfo(this.ensureRuntime(c)))
      }
    }
    return out
  }

  async stopAll(): Promise<ComfyInstanceInfo[]> {
    const out: ComfyInstanceInfo[] = []
    for (const rt of this.runtimes.values()) {
      if (rt.process) {
        out.push(await this.stop(rt.config.id))
      }
    }
    return out
  }

  async stop(id: string): Promise<ComfyInstanceInfo> {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Instance not found: ${id}`)
    rt.intentionalStop = true
    rt.generation += 1
    const child = rt.process
    const wasManaged = rt.managed
    rt.process = undefined
    rt.pid = undefined
    rt.status = 'stopped'
    this.clearReadyProbe(rt, wasManaged ? 'Stopped' : 'External process left running')
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 3000)
    } else if (!wasManaged && rt.ready) {
      // We only adopted an external ComfyUI — be honest instead of pretending we killed it.
      this.pushLog(rt, 'warn', 'Stop requested for an adopted external process — it is still running outside ComfyPilot')
    }
    rt.managed = false
    this.emitStatus(rt)
    return this.toInfo(rt)
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

  async forceKill(id: string): Promise<ComfyInstanceInfo> {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Instance not found: ${id}`)
    rt.intentionalStop = true
    rt.generation += 1
    const child = rt.process
    const pid = rt.pid
    const wasManaged = rt.managed
    rt.process = undefined
    rt.pid = undefined
    this.clearReadyProbe(rt, 'Force killed')
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
    } else if (!wasManaged) {
      this.pushLog(rt, 'warn', 'Force-kill requested for an adopted external process — refusing to kill an unowned PID')
    }
    rt.status = 'stopped'
    rt.managed = false
    this.pushLog(rt, 'warn', 'Force killed')
    this.emitStatus(rt)
    return this.toInfo(rt)
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

export function hashId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

export { dirname, rmSync }
