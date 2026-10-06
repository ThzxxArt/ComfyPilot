import { EventEmitter } from 'events'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname, resolve, basename } from 'path'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import si from 'systeminformation'
import type {
  ComfyInstanceConfig,
  GpuCapability,
  InstallPlan,
  InstallProgress,
  InstallStep,
  InstallStepId,
  TorchChannel
} from '@shared/types'
import { loadInstanceConfigs, upsertInstanceConfig, loadSettings } from './db'
import { hasParentHop, normalizePathEverySegment, isPathInside } from './security'
import { proxyEnv } from './proxy'

const EXEC_OPTS = {
  timeout: 30 * 60 * 1000,
  windowsHide: true,
  maxBuffer: 20 * 1024 * 1024
} as const

const TORCH_INDEX: Record<TorchChannel, string> = {
  cu130: 'https://download.pytorch.org/whl/cu130',
  cu126: 'https://download.pytorch.org/whl/cu126',
  cu124: 'https://download.pytorch.org/whl/cu124',
  rocm: 'https://download.pytorch.org/whl/rocm6.2',
  xpu: 'https://download.pytorch.org/whl/xpu',
  mps: 'https://download.pytorch.org/whl/cpu',
  cpu: 'https://download.pytorch.org/whl/cpu'
}

const COMFY_REPO = 'https://github.com/comfyanonymous/ComfyUI.git'

function nowStep(id: InstallStepId, title: string, status: InstallStep['status'] = 'pending'): InstallStep {
  return { id, title, status, detail: '', log: [] }
}

function defaultSteps(): InstallStep[] {
  return [
    nowStep('preflight', '环境预检'),
    nowStep('python', '定位 Python'),
    nowStep('venv', '创建隔离虚拟环境'),
    nowStep('comfyui', '获取 ComfyUI'),
    nowStep('torch', '安装 PyTorch'),
    nowStep('requirements', '安装 ComfyUI 依赖'),
    nowStep('register', '注册实例'),
    nowStep('done', '完成')
  ]
}

/** Validate git remote: only https/http/ssh+git@ — blocks ext:: and dash-option injection. */
export function assertSafeGitUrl(url: string): string {
  const u = String(url || '').trim()
  if (!u || u.startsWith('-')) throw new Error('Invalid git URL')
  if (/ext::/i.test(u)) throw new Error('Blocked git transport ext::')
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(u)) {
    throw new Error('Git URL must be https://, ssh:// or git@host:…')
  }
  // Authority may be [user@]host — no component may start with `-`
  let authority = ''
  const schemeMatch = u.match(/^(?:https?|ssh):\/\/([^/]+)/i)
  if (schemeMatch) authority = schemeMatch[1]
  else {
    const gitAt = u.match(/^git@([^:]+)/i)
    if (gitAt) authority = gitAt[1]
  }
  const parts = authority.split('@')
  for (const part of parts) {
    if (!part || part.startsWith('-') || /\s/.test(part)) {
      throw new Error('Invalid git host/user')
    }
  }
  return u
}

export function assertSafeBranch(branch: string): string {
  const b = String(branch || '').trim()
  if (!b) return ''
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith('-') || b.includes('..')) {
    throw new Error('Invalid git branch name')
  }
  return b
}

/** Build git clone argv — exported for regression tests (arg order bugs). */
export function buildGitCloneArgs(repo: string, dest: string, branch?: string): string[] {
  const safeRepo = assertSafeGitUrl(repo)
  const safeBranch = assertSafeBranch(branch || '')
  const args = ['clone', '--depth', '1']
  if (safeBranch) args.push('--branch', safeBranch)
  args.push(safeRepo, dest)
  return args
}

export class InstallerService extends EventEmitter {
  private progress: InstallProgress | null = null
  private cancelled = false
  private running = false
  private children = new Set<ChildProcess>()
  private runRejects = new Set<(err: Error) => void>()

  getStatus(): InstallProgress | null {
    return this.progress
  }

  cancel(): boolean {
    this.cancelled = true
    const kills: Array<Promise<void>> = []
    for (const child of this.children) {
      kills.push(this.killTree(child))
    }
    // Reject in-flight run() promises so they don't sit on 30-min timeouts
    for (const rej of this.runRejects) {
      try {
        rej(new Error('Installation cancelled'))
      } catch {
        /* ignore */
      }
    }
    this.runRejects.clear()
    // Fire-and-forget kills; children set cleared after
    void Promise.allSettled(kills).then(() => this.children.clear())
    return true
  }

  private killTree(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (process.platform === 'win32' && child.pid) {
        // Wait for taskkill /T to walk the tree BEFORE killing root
        execFile(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 8000 },
          () => {
            try {
              if (child.exitCode === null) child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
            resolve()
          }
        )
        return
      }
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 500)
    })
  }

  private async run(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
    this.assertNotCancelled()
    return new Promise((resolvePromise, reject) => {
      const onReject = (err: Error): void => {
        this.runRejects.delete(onReject)
        reject(err)
      }
      this.runRejects.add(onReject)
      const child = execFile(
        cmd,
        args,
        {
          cwd: opts?.cwd,
          timeout: opts?.timeout ?? EXEC_OPTS.timeout,
          windowsHide: true,
          maxBuffer: EXEC_OPTS.maxBuffer,
          env: proxyEnv(loadSettings().proxy)
        },
        (err, stdout, stderr) => {
          this.children.delete(child)
          this.runRejects.delete(onReject)
          if (this.cancelled) {
            reject(new Error('Installation cancelled'))
            return
          }
          if (err) {
            reject(new Error(stderr || stdout || err.message))
            return
          }
          resolvePromise(stdout)
        }
      )
      this.children.add(child)
    })
  }

  private emitProgress(message = ''): void {
    if (!this.progress) return
    const total = this.progress.steps.length
    const done = this.progress.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
    this.progress.percent = Math.round((done / total) * 100)
    this.progress.message = message
    this.emit('progress', { ...this.progress })
  }

  private setStep(id: InstallStepId, status: InstallStep['status'], detail?: string, logLine?: string): void {
    if (!this.progress) return
    const step = this.progress.steps.find((s) => s.id === id)
    if (!step) return
    step.status = status
    if (detail != null) step.detail = detail
    if (logLine) step.log.push(logLine)
    this.progress.step = id
    this.emitProgress(detail || '')
  }

  private log(id: InstallStepId, line: string): void {
    if (!this.progress) return
    const step = this.progress.steps.find((s) => s.id === id)
    if (step) step.log.push(line)
    this.emitProgress(line)
  }

  private assertNotCancelled(): void {
    if (this.cancelled) throw new Error('Installation cancelled')
  }

  async detectGpu(): Promise<GpuCapability[]> {
    try {
      const graphics = await si.graphics()
      const out: GpuCapability[] = []
      for (const c of graphics.controllers || []) {
        const model = c.model || 'Unknown GPU'
        const vendor = (c.vendor || '').toLowerCase()
        let recommendedTorch: TorchChannel = 'cpu'
        let notes = ''
        if (vendor.includes('nvidia') || /geforce|rtx|gtx|quadro|tesla/i.test(model)) {
          // Prefer cu126 for unknown-era NVIDIA (safer than cu130 for older cards)
          recommendedTorch = 'cu126'
          notes = 'NVIDIA — 默认 cu126（10 系/老卡）；20 系以上可改 cu130'
          if (/\b(20|30|40|50)\d{2}\b|rtx/i.test(model)) {
            recommendedTorch = 'cu130'
            notes = 'NVIDIA RTX 20 系及以上 — 推荐 cu130'
          }
        } else if (vendor.includes('amd') || /radeon/i.test(model)) {
          recommendedTorch = process.platform === 'linux' ? 'rocm' : 'cpu'
          notes =
            process.platform === 'linux'
              ? 'AMD ROCm（Linux）'
              : 'Windows AMD 需官方 ROCm PyTorch 包，先回退 CPU 或手动指定'
        } else if (vendor.includes('intel') || /arc|xe/i.test(model)) {
          recommendedTorch = process.platform === 'win32' || process.platform === 'linux' ? 'xpu' : 'cpu'
          notes = 'Intel GPU 可用 XPU 构建'
        } else if (process.platform === 'darwin') {
          recommendedTorch = 'mps'
          notes = 'Apple Silicon MPS'
        }
        out.push({ vendor: c.vendor || 'unknown', model, recommendedTorch, notes })
      }
      if (!out.length) {
        out.push({
          vendor: 'none',
          model: 'No GPU detected',
          recommendedTorch: process.platform === 'darwin' ? 'mps' : 'cpu',
          notes: '未检测到独立 GPU，将安装 CPU 版 torch'
        })
      }
      return out
    } catch {
      return [
        {
          vendor: 'unknown',
          model: 'GPU detection failed',
          recommendedTorch: 'cpu',
          notes: 'GPU 探测失败，使用 CPU'
        }
      ]
    }
  }

  async preflight(opts: { installRoot: string; useUv: boolean; pythonPath?: string }): Promise<{
    ok: boolean
    checks: Array<{ id: string; ok: boolean; detail: string }>
  }> {
    const checks: Array<{ id: string; ok: boolean; detail: string }> = []

    // install root safety
    const root = opts.installRoot
    const rootOk = Boolean(root) && !hasParentHop(root)
    checks.push({
      id: 'root',
      ok: rootOk,
      detail: rootOk ? `安装目录 ${root}` : '安装目录非法（含 .. 或为空）'
    })

    // disk
    try {
      const { statfsSync } = await import('fs')
      const probeDir = existsSync(root) ? root : dirname(root)
      if (existsSync(probeDir)) {
        const st = statfsSync(probeDir)
        const freeGb = (Number(st.bsize) * Number(st.bavail)) / 1024 ** 3
        checks.push({
          id: 'disk',
          ok: freeGb > 8,
          detail: `可用空间 ${freeGb.toFixed(1)} GB（建议 ≥ 8GB，含 torch 约 5–15GB）`
        })
      } else {
        checks.push({ id: 'disk', ok: true, detail: '目标目录将新建' })
      }
    } catch {
      checks.push({ id: 'disk', ok: true, detail: '磁盘检测不可用' })
    }

    // git
    try {
      const out = await this.run('git', ['--version'], { timeout: 5000 })
      checks.push({ id: 'git', ok: true, detail: out.trim() })
    } catch {
      checks.push({
        id: 'git',
        ok: false,
        detail: '未找到 git —— 源码安装需要 Git for Windows / git'
      })
    }

    // python — use the SAME interpreter the install will use
    const python = opts.pythonPath && opts.pythonPath.trim() ? opts.pythonPath.trim() : 'python'
    try {
      const out = await this.run(python, ['--version'], { timeout: 8000 })
      const m = out.match(/Python\s+(3)\.(\d+)/i)
      const major = m ? Number(m[1]) : 0
      const minor = m ? Number(m[2]) : -1
      const ok = major === 3 && minor >= 10
      checks.push({ id: 'python', ok, detail: out.trim() || python })
    } catch {
      checks.push({
        id: 'python',
        ok: false,
        detail: `未找到解释器：${python}（请安装 Python 3.10+ 或改路径）`
      })
    }

    // uv optional
    if (opts.useUv) {
      try {
        const out = await this.run('uv', ['--version'], { timeout: 5000 })
        checks.push({ id: 'uv', ok: true, detail: out.trim() })
      } catch {
        checks.push({
          id: 'uv',
          ok: false,
          detail: '选择 uv 但未安装 —— 可改用 venv 或先安装 uv'
        })
      }
    }

    return { ok: checks.every((c) => c.ok), checks }
  }

  async start(plan: InstallPlan): Promise<{ runId: string }> {
    if (this.running) throw new Error('Installer already running')
    // Validate plan up-front
    if (!plan.installRoot || hasParentHop(plan.installRoot)) {
      throw new Error('Invalid install root')
    }
    assertSafeGitUrl(plan.comfyRepo || COMFY_REPO)
    assertSafeBranch(plan.comfyBranch || '')

    this.running = true
    this.cancelled = false
    const runId = randomUUID()
    this.progress = {
      runId,
      step: 'preflight',
      status: 'running',
      steps: defaultSteps(),
      message: '开始安装',
      percent: 0
    }
    this.emitProgress('开始安装')
    void this.runPlan(plan).finally(() => {
      this.running = false
    })
    return { runId }
  }

  private resolvePython(plan: InstallPlan): string {
    if (plan.pythonPath && plan.pythonPath.trim()) return plan.pythonPath.trim()
    return 'python'
  }

  private venvPython(venvPath: string): string {
    const win = join(venvPath, 'Scripts', 'python.exe')
    const unix = join(venvPath, 'bin', 'python')
    return existsSync(win) ? win : unix
  }

  private async runPlan(plan: InstallPlan): Promise<void> {
    try {
      const installRoot = resolve(normalizePathEverySegment(plan.installRoot))
      if (hasParentHop(plan.installRoot)) throw new Error('Invalid install root')

      // 1. preflight
      this.setStep('preflight', 'running', '检查本机环境…')
      const pythonForPlan = this.resolvePython(plan)
      const pre = await this.preflight({
        installRoot: plan.installRoot,
        useUv: plan.useUv,
        pythonPath: pythonForPlan
      })
      for (const c of pre.checks) this.log('preflight', `${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`)
      if (!pre.ok) {
        throw new Error('预检未通过：' + pre.checks.filter((c) => !c.ok).map((c) => c.detail).join('; '))
      }
      this.setStep('preflight', 'done', '预检通过')
      this.assertNotCancelled()

      // 2. python
      this.setStep('python', 'running', '定位 Python…')
      const python = pythonForPlan
      const pyVer = await this.run(python, ['--version'], { timeout: 8000 })
      this.setStep('python', 'done', pyVer.trim() || python)
      this.assertNotCancelled()

      // 3. venv isolated
      mkdirSync(installRoot, { recursive: true })
      const venvPath = join(installRoot, '.venv')
      this.setStep('venv', 'running', plan.useUv ? 'uv 创建虚拟环境…' : 'python -m venv …')
      if (plan.useUv) {
        await this.run('uv', ['venv', venvPath, '--python', python], { timeout: 120000 })
      } else {
        await this.run(python, ['-m', 'venv', venvPath], { timeout: 120000 })
      }
      const vpy = this.venvPython(venvPath)
      if (!existsSync(vpy)) throw new Error(`虚拟环境创建失败，找不到 ${vpy}`)
      this.setStep('venv', 'done', `隔离环境 ${venvPath}`)
      this.assertNotCancelled()

      // 4. clone ComfyUI
      const comfyDir = join(installRoot, 'ComfyUI')
      this.setStep('comfyui', 'running', '克隆 ComfyUI…')
      if (existsSync(join(comfyDir, 'main.py'))) {
        // Reuse only if the user didn't ask for a specific different branch
        this.log('comfyui', '已存在 ComfyUI，跳过克隆')
        if (plan.comfyBranch) {
          this.log('comfyui', `注意：已复用现有目录，未切换到分支 ${plan.comfyBranch}`)
        }
        this.setStep('comfyui', 'done', '复用已有 ComfyUI')
      } else {
        const repo = plan.comfyRepo || COMFY_REPO
        const branch = plan.comfyBranch || ''
        const args = buildGitCloneArgs(repo, comfyDir, branch)
        await this.run('git', args, { timeout: 300000 })
        if (!existsSync(join(comfyDir, 'main.py'))) throw new Error('ComfyUI 克隆后未找到 main.py')
        this.setStep('comfyui', 'done', `已克隆 ${repo}`)
      }
      this.assertNotCancelled()

      // 5. torch
      this.setStep('torch', 'running', `安装 PyTorch (${plan.torchChannel})…`)
      const index = TORCH_INDEX[plan.torchChannel] || TORCH_INDEX.cpu
      if (plan.useUv) {
        await this.run(
          'uv',
          ['pip', 'install', '--python', vpy, 'torch', 'torchvision', 'torchaudio', '--index-url', index],
          { timeout: 30 * 60 * 1000 }
        )
      } else {
        await this.run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeout: 120000 })
        await this.run(
          vpy,
          ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', index],
          { timeout: 30 * 60 * 1000 }
        )
      }
      this.log('torch', `torch index: ${index}`)
      this.setStep('torch', 'done', plan.torchChannel)
      this.assertNotCancelled()

      // 6. requirements
      this.setStep('requirements', 'running', '安装 ComfyUI requirements…')
      const reqFile = join(comfyDir, 'requirements.txt')
      if (existsSync(reqFile)) {
        if (plan.useUv) {
          await this.run('uv', ['pip', 'install', '--python', vpy, '-r', reqFile], {
            timeout: 30 * 60 * 1000
          })
        } else {
          await this.run(vpy, ['-m', 'pip', 'install', '-r', reqFile], {
            timeout: 30 * 60 * 1000
          })
        }
        this.setStep('requirements', 'done', 'requirements 已安装到隔离环境')
      } else {
        this.setStep('requirements', 'skipped', '未找到 requirements.txt')
      }
      this.assertNotCancelled()

      // 7. register instance
      this.setStep('register', 'running', '写入实例配置…')
      const existing = loadInstanceConfigs()
      const samePath = existing.find(
        (c) => resolve(normalizePathEverySegment(c.path)) === resolve(comfyDir)
      )
      const config: ComfyInstanceConfig = {
        id: samePath?.id || randomUUID(),
        name: plan.instanceName || 'ComfyUI',
        path: comfyDir,
        pythonPath: '',
        venvPath,
        port: samePath?.port || (await this.pickPort()),
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true,
        notes: 'Created by ComfyPilot one-click installer (isolated venv)',
        autoStart: Boolean(plan.autoStart),
        frontendVersion: ''
      }
      upsertInstanceConfig(config)

      writeFileSync(
        join(installRoot, '.comfypilot-env.json'),
        JSON.stringify(
          {
            venvPath,
            torchChannel: plan.torchChannel,
            python,
            createdAt: Date.now(),
            isolated: true
          },
          null,
          2
        )
      )
      this.setStep('register', 'done', config.name)

      // 8. done + optional auto-start
      if (plan.autoStart) {
        try {
          this.log('done', '自动启动实例…')
          const { instanceService } = await import('./instance')
          await instanceService.start(config.id)
          this.setStep('done', 'done', '安装完成并已启动')
        } catch (e) {
          this.log('done', `自动启动失败：${e instanceof Error ? e.message : String(e)}`)
          this.setStep('done', 'done', '安装完成（自动启动失败，可手动启动）')
        }
      } else {
        this.setStep('done', 'done', '安装完成，可一键启动')
      }

      if (this.progress) {
        this.progress.status = 'done'
        this.progress.percent = 100
        this.progress.message = '安装完成'
      }
      this.emitProgress('安装完成')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = this.cancelled || message === 'Installation cancelled' || /Installation cancelled/i.test(message)
      if (this.progress) {
        this.progress.status = 'failed'
        this.progress.error = cancelled ? 'Installation cancelled' : message
        this.progress.message = this.progress.error
        const running = this.progress.steps.find((s) => s.status === 'running')
        if (running) {
          running.status = 'failed'
          running.detail = this.progress.error
          running.log.push('✗ ' + this.progress.error)
        }
      }
      this.emitProgress(message)
    } finally {
      this.children.clear()
    }
  }

  private async pickPort(): Promise<number> {
    const net = await import('net')
    const tryPort = (port: number) =>
      new Promise<boolean>((resolvePort) => {
        const server = net.createServer()
        server.once('error', () => resolvePort(false))
        server.once('listening', () => server.close(() => resolvePort(true)))
        server.listen(port, '127.0.0.1')
      })
    for (const p of [8188, 8189, 8190, 8191, 8288]) {
      if (await tryPort(p)) return p
    }
    return 8388
  }
}

export const installerService = new InstallerService()

export { TORCH_INDEX, COMFY_REPO }

void spawn
void rmSync
void basename
void isPathInside
