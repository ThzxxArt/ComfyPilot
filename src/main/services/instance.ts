import { EventEmitter } from 'events'
import { createHash, randomUUID } from 'crypto'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import net from 'net'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  ComfyLogLine,
  DiagnosticPackage,
  EnvProbe,
  InstanceDiscoveryCandidate,
  InstanceStatus,
  PortCheckResult
} from '@shared/types'
import {
  deleteInstanceConfig,
  loadInstanceConfigs,
  logsDir,
  upsertInstanceConfig,
  userDataDir
} from './db'
import { COMFY_DEFAULT_PORTS, LAUNCH_TEMPLATES } from '@shared/constants'

const execFileAsync = promisify(execFile)

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
}

const LOG_CAP = 5000

export class InstanceService extends EventEmitter {
  private runtimes = new Map<string, RuntimeEntry>()

  private ensureRuntime(config: ComfyInstanceConfig): RuntimeEntry {
    let rt = this.runtimes.get(config.id)
    if (!rt) {
      rt = { config, status: 'stopped', logs: [], generation: 0, intentionalStop: false }
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

  list(): ComfyInstanceInfo[] {
    return loadInstanceConfigs().map((c) => this.toInfo(this.ensureRuntime(c)))
  }

  save(config: ComfyInstanceConfig): ComfyInstanceInfo {
    const id = config.id || randomUUID()
    const next: ComfyInstanceConfig = { ...config, id }
    upsertInstanceConfig(next)
    return this.toInfo(this.ensureRuntime(next))
  }

  remove(id: string): boolean {
    const rt = this.runtimes.get(id)
    if (rt?.process) {
      rt.process.kill()
      rt.process = undefined
    }
    this.runtimes.delete(id)
    return deleteInstanceConfig(id)
  }

  private commonRoots(extra?: string): string[] {
    const candidates = [
      extra,
      process.env.COMFYUI_PATH,
      'D:\\ComfyUI',
      'C:\\ComfyUI',
      'D:\\AI\\ComfyUI',
      join(process.env.USERPROFILE || '', 'ComfyUI'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'comfyui-desktop')
    ].filter(Boolean) as string[]
    return [...new Set(candidates)]
  }

  discover(root?: string): InstanceDiscoveryCandidate[] {
    const found: InstanceDiscoveryCandidate[] = []
    for (const p of this.commonRoots(root)) {
      if (!p || !existsSync(p)) continue
      let entries: string[] = []
      try {
        entries = readdirSync(p)
      } catch {
        continue
      }
      // root itself may be a ComfyUI install
      this.scoreCandidate(p, found)
      // or contain sub-installs
      for (const name of entries.slice(0, 40)) {
        const child = join(p, name)
        try {
          if (statSync(child).isDirectory()) this.scoreCandidate(child, found)
        } catch {
          /* skip */
        }
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, 20)
  }

  private scoreCandidate(path: string, out: InstanceDiscoveryCandidate[]): void {
    const hasMainPy = existsSync(join(path, 'main.py'))
    const hasRequirements = existsSync(join(path, 'requirements.txt'))
    const hasVenv =
      existsSync(join(path, 'venv')) ||
      existsSync(join(path, '.venv')) ||
      existsSync(join(path, 'python_embeded')) ||
      existsSync(join(path, 'python_embedded'))
    if (!hasMainPy && !hasRequirements) return
    if (out.some((c) => c.path === path)) return
    out.push({
      path,
      score: (hasMainPy ? 50 : 0) + (hasRequirements ? 20 : 0) + (hasVenv ? 30 : 0),
      reason: hasMainPy ? 'Found main.py' : 'Found requirements.txt',
      hasMainPy,
      hasRequirements,
      hasVenv,
      estimatedVersion: this.probeVersion(path)
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
    const pythonPath = config?.venvPath
      ? join(config.venvPath, 'Scripts', 'python.exe')
      : config?.pythonPath || 'python'
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

  private resolvePython(config: ComfyInstanceConfig): string {
    if (config.venvPath) {
      const win = join(config.venvPath, 'Scripts', 'python.exe')
      const unix = join(config.venvPath, 'bin', 'python')
      if (existsSync(win)) return win
      if (existsSync(unix)) return unix
    }
    if (config.pythonPath) return config.pythonPath
    // Portable embeds
    const embed = join(config.path, 'python_embeded', 'python.exe')
    if (existsSync(embed)) return embed
    const embed2 = join(config.path, 'python_embedded', 'python.exe')
    if (existsSync(embed2)) return embed2
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

  async start(id: string): Promise<ComfyInstanceInfo> {
    const config = loadInstanceConfigs().find((c) => c.id === id)
    if (!config) throw new Error(`Instance not found: ${id}`)
    const rt = this.ensureRuntime(config)
    if (rt.process && rt.process.exitCode === null) return this.toInfo(rt)

    const portCheck = await this.checkPort(config.port || 8188)
    if (!portCheck.available) {
      rt.lastError = `Port ${config.port} is already in use`
      rt.status = 'error'
      this.pushLog(rt, 'error', rt.lastError)
      throw new Error(rt.lastError)
    }

    rt.generation += 1
    const gen = rt.generation
    rt.intentionalStop = false
    rt.status = 'starting'
    rt.lastError = undefined
    this.emitStatus(rt)

    const python = this.resolvePython(config)
    const args = this.buildArgs(config)

    try {
      const child = spawn(python, args, {
        cwd: config.path,
        windowsHide: true,
        env: { ...process.env }
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
        this.pushLog(rt, code === 0 || intentional ? 'info' : 'error', `Process exited code=${code} signal=${signal}`)
      })

      setTimeout(() => {
        if (rt.generation === gen && rt.process && rt.status === 'starting') {
          rt.status = 'running'
          this.pushLog(rt, 'info', `ComfyUI listening at ${this.toInfo(rt).url}`)
        }
      }, 1500)
    } catch (err) {
      rt.status = 'error'
      rt.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus(rt)
      throw err
    }

    return this.toInfo(rt)
  }

  async stop(id: string): Promise<ComfyInstanceInfo> {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Instance not found: ${id}`)
    rt.intentionalStop = true
    rt.generation += 1
    const child = rt.process
    rt.process = undefined
    rt.pid = undefined
    rt.status = 'stopped'
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
    }
    this.emitStatus(rt)
    return this.toInfo(rt)
  }

  async restart(id: string): Promise<ComfyInstanceInfo> {
    await this.stop(id)
    // Wait until port is free (or timeout) so start() does not race a dying process.
    const config = loadInstanceConfigs().find((c) => c.id === id)
    const port = config?.port || 8188
    for (let i = 0; i < 20; i++) {
      const check = await this.checkPort(port)
      if (check.available) break
      await new Promise((r) => setTimeout(r, 150))
    }
    return this.start(id)
  }

  async forceKill(id: string): Promise<ComfyInstanceInfo> {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Instance not found: ${id}`)
    rt.intentionalStop = true
    rt.generation += 1
    const child = rt.process
    const pid = rt.pid
    rt.process = undefined
    rt.pid = undefined
    if (child) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    } else if (pid) {
      // Only kill PID if we no longer own a live child handle (avoid PID reuse races).
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
    rt.status = 'stopped'
    this.pushLog(rt, 'warn', 'Force killed')
    this.emitStatus(rt)
    return this.toInfo(rt)
  }

  stopAll(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.process) {
        rt.intentionalStop = true
        rt.generation += 1
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
