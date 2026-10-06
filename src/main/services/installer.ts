import { EventEmitter } from 'events'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import si from 'systeminformation'
import type {
  GpuCapability,
  InstallPlan,
  InstallProgress,
  InstallStep,
  InstallStepId,
  TorchChannel
} from '@shared/types'
import { loadInstanceConfigs, upsertInstanceConfig } from './db'
import type { ComfyInstanceConfig } from '@shared/types'

const execFileAsync = promisify(execFile)

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

export class InstallerService extends EventEmitter {
  private progress: InstallProgress | null = null
  private cancelled = false
  private running = false

  getStatus(): InstallProgress | null {
    return this.progress
  }

  cancel(): boolean {
    this.cancelled = true
    return true
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
          recommendedTorch = 'cu130'
          notes = 'NVIDIA CUDA — 推荐 cu130（20 系及以上）'
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

  async preflight(opts: { installRoot: string; useUv: boolean }): Promise<{
    ok: boolean
    checks: Array<{ id: string; ok: boolean; detail: string }>
  }> {
    const checks: Array<{ id: string; ok: boolean; detail: string }> = []

    // disk space on target
    try {
      const { statfsSync } = await import('fs')
      const probeDir = existsSync(opts.installRoot) ? opts.installRoot : dirname(opts.installRoot)
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
      const { stdout } = await execFileAsync('git', ['--version'], { timeout: 5000 })
      checks.push({ id: 'git', ok: true, detail: stdout.trim() })
    } catch {
      checks.push({
        id: 'git',
        ok: false,
        detail: '未找到 git —— 源码安装需要 Git for Windows / git'
      })
    }

    // python
    try {
      const { stdout } = await execFileAsync('python', ['--version'], { timeout: 5000 })
      const ok = /3\.(1[0-9])/.test(stdout)
      checks.push({ id: 'python', ok, detail: stdout.trim() || 'python' })
    } catch {
      checks.push({
        id: 'python',
        ok: false,
        detail: '未找到 python 3.10+（可安装 Python 3.12/3.13）'
      })
    }

    // uv optional
    if (opts.useUv) {
      try {
        const { stdout } = await execFileAsync('uv', ['--version'], { timeout: 5000 })
        checks.push({ id: 'uv', ok: true, detail: stdout.trim() })
      } catch {
        checks.push({
          id: 'uv',
          ok: false,
          detail: '选择 uv 但未安装 —— 可改用 venv 或先安装 uv'
        })
      }
    }

    const ok = checks.every((c) => c.ok)
    return { ok, checks }
  }

  async start(plan: InstallPlan): Promise<{ runId: string }> {
    if (this.running) throw new Error('Installer already running')
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

    // Run async — progress via events
    void this.runPlan(plan).finally(() => {
      this.running = false
    })

    return { runId }
  }

  private assertNotCancelled(): void {
    if (this.cancelled) throw new Error('Installation cancelled')
  }

  private resolvePython(plan: InstallPlan): string {
    if (plan.pythonPath && existsSync(plan.pythonPath)) return plan.pythonPath
    return 'python'
  }

  private venvPython(venvPath: string): string {
    const win = join(venvPath, 'Scripts', 'python.exe')
    const unix = join(venvPath, 'bin', 'python')
    return existsSync(win) ? win : unix
  }

  private async runPlan(plan: InstallPlan): Promise<void> {
    try {
      // 1. preflight
      this.setStep('preflight', 'running', '检查本机环境…')
      const pre = await this.preflight({ installRoot: plan.installRoot, useUv: plan.useUv })
      for (const c of pre.checks) this.log('preflight', `${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`)
      if (!pre.checks.every((c) => c.ok)) {
        throw new Error('预检未通过：' + pre.checks.filter((c) => !c.ok).map((c) => c.detail).join('; '))
      }
      this.setStep('preflight', 'done', '预检通过')
      this.assertNotCancelled()

      // 2. python
      this.setStep('python', 'running', '定位 Python…')
      const python = this.resolvePython(plan)
      const pyVer = await execFileAsync(python, ['--version'], { timeout: 8000 })
      this.setStep('python', 'done', pyVer.stdout.trim() || python)
      this.assertNotCancelled()

      // 3. venv isolated
      const installRoot = plan.installRoot
      mkdirSync(installRoot, { recursive: true })
      const venvPath = join(installRoot, '.venv')
      this.setStep('venv', 'running', plan.useUv ? 'uv 创建虚拟环境…' : 'python -m venv …')
      if (plan.useUv) {
        await execFileAsync('uv', ['venv', venvPath, '--python', python], {
          timeout: 120000,
          windowsHide: true
        })
      } else {
        await execFileAsync(python, ['-m', 'venv', venvPath], { timeout: 120000, windowsHide: true })
      }
      const vpy = this.venvPython(venvPath)
      if (!existsSync(vpy)) throw new Error(`虚拟环境创建失败，找不到 ${vpy}`)
      this.setStep('venv', 'done', `隔离环境 ${venvPath}`)
      this.assertNotCancelled()

      // 4. clone ComfyUI
      const comfyDir = join(installRoot, 'ComfyUI')
      this.setStep('comfyui', 'running', '克隆 ComfyUI…')
      if (existsSync(join(comfyDir, 'main.py'))) {
        this.log('comfyui', '已存在 ComfyUI，跳过克隆')
        this.setStep('comfyui', 'done', '复用已有 ComfyUI')
      } else {
        const repo = plan.comfyRepo || COMFY_REPO
        const args = ['clone', '--depth', '1', repo, comfyDir]
        if (plan.comfyBranch) args.splice(2, 0, '--branch', plan.comfyBranch)
        await execFileAsync('git', args, { timeout: 300000, windowsHide: true })
        if (!existsSync(join(comfyDir, 'main.py'))) throw new Error('ComfyUI 克隆后未找到 main.py')
        this.setStep('comfyui', 'done', `已克隆 ${repo}`)
      }
      this.assertNotCancelled()

      // 5. torch
      this.setStep('torch', 'running', `安装 PyTorch (${plan.torchChannel})…`)
      const index = TORCH_INDEX[plan.torchChannel] || TORCH_INDEX.cpu
      const pipArgs = plan.useUv
        ? ['pip', 'install', '--python', vpy, 'torch', 'torchvision', 'torchaudio', '--index-url', index]
        : [vpy, '-m', 'pip', 'install', '--upgrade', 'pip']
      if (plan.useUv) {
        await execFileAsync('uv', pipArgs, { timeout: 30 * 60 * 1000, windowsHide: true })
      } else {
        await execFileAsync(python === vpy ? vpy : vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
          timeout: 120000,
          windowsHide: true
        })
        await execFileAsync(vpy, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', index], {
          timeout: 30 * 60 * 1000,
          windowsHide: true
        })
      }
      this.log('torch', `torch index: ${index}`)
      this.setStep('torch', 'done', plan.torchChannel)
      this.assertNotCancelled()

      // 6. requirements
      this.setStep('requirements', 'running', '安装 ComfyUI requirements…')
      const reqFile = join(comfyDir, 'requirements.txt')
      if (existsSync(reqFile)) {
        if (plan.useUv) {
          await execFileAsync('uv', ['pip', 'install', '--python', vpy, '-r', reqFile], {
            timeout: 30 * 60 * 1000,
            windowsHide: true
          })
        } else {
          await execFileAsync(vpy, ['-m', 'pip', 'install', '-r', reqFile], {
            timeout: 30 * 60 * 1000,
            windowsHide: true
          })
        }
        this.setStep('requirements', 'done', 'requirements 已安装到隔离环境')
      } else {
        this.setStep('requirements', 'skipped', '未找到 requirements.txt')
      }
      this.assertNotCancelled()

      // 7. register instance
      this.setStep('register', 'running', '写入实例配置…')
      const config: ComfyInstanceConfig = {
        id: randomUUID(),
        name: plan.instanceName || 'ComfyUI',
        path: comfyDir,
        pythonPath: '',
        venvPath,
        port: await this.pickPort(),
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true,
        notes: 'Created by ComfyPilot one-click installer (isolated venv)',
        autoStart: Boolean(plan.autoStart),
        frontendVersion: ''
      }
      const existing = loadInstanceConfigs()
      if (existing.some((c) => c.path === comfyDir)) {
        // update instead of duplicate
        const prev = existing.find((c) => c.path === comfyDir)!
        upsertInstanceConfig({ ...config, id: prev.id })
      } else {
        upsertInstanceConfig(config)
      }

      // write isolation marker
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

      // 8. done
      this.setStep('done', 'done', '安装完成，可一键启动')
      if (this.progress) {
        this.progress.status = 'done'
        this.progress.percent = 100
        this.progress.message = '安装完成'
      }
      this.emitProgress('安装完成')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.progress) {
        this.progress.status = this.cancelled ? 'failed' : 'failed'
        this.progress.error = message
        this.progress.message = message
      }
      // mark current running step failed
      if (this.progress) {
        const running = this.progress.steps.find((s) => s.status === 'running')
        if (running) {
          running.status = 'failed'
          running.detail = message
          running.log.push('✗ ' + message)
        }
      }
      this.emitProgress(message)
    }
  }

  private async pickPort(): Promise<number> {
    const net = await import('net')
    const tryPort = (port: number) =>
      new Promise<boolean>((resolve) => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => server.close(() => resolve(true)))
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

// silence unused
void spawn
void rmSync
