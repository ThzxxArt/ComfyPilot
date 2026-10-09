import { EventEmitter } from 'events'
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync, renameSync, createWriteStream } from 'fs'
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
  InstallStepByteProgress,
  StarterModel,
  TorchChannel
} from '@shared/types'
import {
  COMFY_ZIP_URL,
  STARTER_MODELS,
  TORCH_DISK_GB,
  TORCH_INDEX_PRESETS
} from '@shared/constants'
import { loadInstanceConfigs, upsertInstanceConfig, loadSettings, userDataDir, saveInstallRun, loadLatestInstallRun } from './db'
import { hasParentHop, normalizePathEverySegment, isPathInside, isSafeExternalUrl, normalizeForCompare } from './security'
import { proxyEnv } from './proxy'
import { bootstrapService } from './bootstrap'

const EXEC_OPTS = {
  timeout: 30 * 60 * 1000,
  windowsHide: true,
  maxBuffer: 20 * 1024 * 1024
} as const

const TORCH_INDEX: Record<TorchChannel, string> = {
  cu130: 'https://download.pytorch.org/whl/cu130/',
  cu126: 'https://download.pytorch.org/whl/cu126/',
  cu124: 'https://download.pytorch.org/whl/cu124/',
  rocm: 'https://download.pytorch.org/whl/rocm6.2/',
  xpu: 'https://download.pytorch.org/whl/xpu/',
  mps: 'https://download.pytorch.org/whl/cpu/',
  cpu: 'https://download.pytorch.org/whl/cpu/'
}

const COMFY_REPO = 'https://github.com/comfyanonymous/ComfyUI.git'

function nowStep(id: InstallStepId, title: string, status: InstallStep['status'] = 'pending'): InstallStep {
  return { id, title, status, detail: '', log: [] }
}

function defaultSteps(): InstallStep[] {
  return [
    nowStep('bootstrap', 'Bootstrap runtimes'),
    nowStep('preflight', 'Preflight'),
    nowStep('python', 'Locate Python'),
    nowStep('venv', 'Create isolated venv'),
    nowStep('comfyui', 'Fetch ComfyUI'),
    nowStep('torch', 'Install PyTorch'),
    nowStep('requirements', 'Install requirements'),
    nowStep('register', 'Register instance'),
    nowStep('starter', 'Starter model'),
    nowStep('done', 'Done')
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

/** Rewrite github.com URLs through the optional Settings → githubEndpoint mirror prefix. */
export function applyGithubMirror(url: string): string {
  const raw = String(url || '').trim()
  if (!raw) return raw
  let endpoint = ''
  try {
    endpoint = String(loadSettings().githubEndpoint || '').trim()
  } catch {
    endpoint = ''
  }
  if (!endpoint) return raw
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(raw)) return raw
  const isGithub =
    /github\.com/i.test(raw) || /^git@github\.com:/i.test(raw) || /ghcr\.io/i.test(raw)
  if (!isGithub) return raw
  return endpoint.replace(/\/+$/, '') + '/' + raw
}

/** Build git clone argv — exported for regression tests (arg order bugs). */
export function buildGitCloneArgs(repo: string, dest: string, branch?: string): string[] {
  const safeRepo = assertSafeGitUrl(applyGithubMirror(repo))
  const safeBranch = assertSafeBranch(branch || '')
  const args = ['clone', '--depth', '1']
  if (safeBranch) args.push('--branch', safeBranch)
  args.push(safeRepo, dest)
  return args
}

/**
 * Torch index for a channel. Always a PEP 503 simple index (trailing slash).
 * Wheel mirrors publish `<prefix>/<channel>/`; official publishes `/whl/<channel>/`.
 */
export function resolveTorchIndex(channel: TorchChannel): string {
  const base = TORCH_INDEX[channel] || TORCH_INDEX.cpu
  const mirror = String(loadSettings().torchIndexMirror || '').trim()
  if (!mirror) return base
  const isOfficialStyle = /pytorch\.org/i.test(mirror) || /\/whl\/?$/i.test(mirror)
  const prefix = mirror.replace(/\/+$/, '')
  const joined = isOfficialStyle
    ? prefix.replace(/\/whl\/?$/i, '') + base.replace('https://download.pytorch.org', '')
    : `${prefix}/${channel}`
  const cleaned = joined.replace(/\/whl\/whl\//, '/whl/').replace(/\/{3,}/g, '/')
  // uv/pip treat the URL as a PEP 503 simple index — trailing slash required.
  return cleaned.endsWith('/') ? cleaned : cleaned + '/'
}

export function officialTorchIndex(channel: TorchChannel): string {
  return TORCH_INDEX[channel] || TORCH_INDEX.cpu
}

export function listStarterModels(): StarterModel[] {
  return STARTER_MODELS
}

export class InstallerService extends EventEmitter {
  private progress: InstallProgress | null = null
  private cancelled = false
  private running = false
  private children = new Set<ChildProcess>()
  private runRejects = new Set<(err: Error) => void>()

  getStatus(): InstallProgress | null {
    if (this.progress) return this.progress
    // Restore the latest persisted run so the UI can show what happened
    // (or is still marked running) after an app restart.
    try {
      const last = loadLatestInstallRun()
      if (last && typeof last === 'object') {
        return last as unknown as InstallProgress
      }
    } catch {
      /* ignore */
    }
    return null
  }

  cancel(): boolean {
    this.cancelled = true
    // Abort in-flight runtime downloads/extracts too (bootstrap has no idea
    // about installer.run children).
    try {
      bootstrapService.cancelAll()
    } catch {
      /* ignore */
    }
    const kills: Array<Promise<void>> = []
    for (const child of this.children) {
      kills.push(this.killTree(child))
    }
    for (const rej of this.runRejects) {
      try {
        rej(new Error('Installation cancelled'))
      } catch {
        /* ignore */
      }
    }
    this.runRejects.clear()
    void Promise.allSettled(kills).then(() => this.children.clear())
    return true
  }

  private killTree(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (process.platform === 'win32' && child.pid) {
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
    // Persist so a restart can restore the run (status/percent/steps/logs).
    saveInstallRun(this.progress as unknown as { runId: string; status: string } & Record<string, unknown>)
  }

  private setBytes(bytes?: InstallStepByteProgress): void {
    if (!this.progress) return
    this.progress.bytes = bytes
    this.emitProgress(bytes?.label || '')
  }

  private setStep(
    id: InstallStepId,
    status: InstallStep['status'],
    detail?: string,
    logLine?: string,
    detailKey?: string,
    detailParams?: Record<string, string | number>
  ): void {
    if (!this.progress) return
    const step = this.progress.steps.find((s) => s.id === id)
    if (!step) return
    step.status = status
    if (detail != null) step.detail = detail
    if (detailKey) step.detailKey = detailKey
    if (detailParams) step.detailParams = detailParams
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
        let notesKey: string | undefined
        if (vendor.includes('nvidia') || /geforce|rtx|gtx|quadro|tesla/i.test(model)) {
          recommendedTorch = 'cu126'
          notes = 'NVIDIA — default cu126; RTX 20+ may use cu130'
          notesKey = 'gpu.nvidiaDefault'
          if (/\b(20|30|40|50)\d{2}\b|rtx/i.test(model)) {
            recommendedTorch = 'cu130'
            notes = 'NVIDIA RTX 20+ — recommended cu130'
            notesKey = 'gpu.nvidiaRtx'
          }
        } else if (vendor.includes('amd') || /radeon/i.test(model)) {
          recommendedTorch = process.platform === 'linux' ? 'rocm' : 'cpu'
          notes =
            process.platform === 'linux'
              ? 'AMD ROCm (Linux)'
              : 'Windows AMD needs official ROCm PyTorch — falling back to CPU unless overridden'
          notesKey = process.platform === 'linux' ? 'gpu.amdLinux' : 'gpu.amdWindows'
        } else if (vendor.includes('intel') || /arc|xe/i.test(model)) {
          recommendedTorch = process.platform === 'win32' || process.platform === 'linux' ? 'xpu' : 'cpu'
          notes = 'Intel GPU — XPU build available'
          notesKey = 'gpu.intel'
        } else if (process.platform === 'darwin') {
          recommendedTorch = 'mps'
          notes = 'Apple Silicon MPS'
          notesKey = 'gpu.apple'
        }
        out.push({ vendor: c.vendor || 'unknown', model, recommendedTorch, notes, notesKey })
      }
      if (!out.length) {
        out.push({
          vendor: 'none',
          model: 'No GPU detected',
          recommendedTorch: process.platform === 'darwin' ? 'mps' : 'cpu',
          notes: 'No discrete GPU — will install CPU torch',
          notesKey: 'gpu.none'
        })
      }
      return out
    } catch {
      return [
        {
          vendor: 'unknown',
          model: 'GPU detection failed',
          recommendedTorch: 'cpu',
          notes: 'GPU detection failed — using CPU',
          notesKey: 'gpu.failed'
        }
      ]
    }
  }

  /**
   * Pre-install checks. Missing Python/Git are NOT fatal anymore:
   * the bootstrap step can download them (fixId provided for one-click repair).
   */
  async preflight(opts: {
    installRoot: string
    useUv: boolean
    pythonPath?: string
    torchChannel?: TorchChannel
  }): Promise<{
    ok: boolean
    checks: Array<{
      id: string
      ok: boolean
      detail: string
      detailKey?: string
      detailParams?: Record<string, string | number>
      fixId?: string
      fixLabel?: string
      fixLabelKey?: string
    }>
    diskNeedGb?: number
    diskFreeGb?: number
  }> {
    const checks: Array<{
      id: string
      ok: boolean
      detail: string
      detailKey?: string
      detailParams?: Record<string, string | number>
      fixId?: string
      fixLabel?: string
      fixLabelKey?: string
    }> = []

    const root = opts.installRoot
    const rootOk = Boolean(root) && !hasParentHop(root)
    checks.push({
      id: 'root',
      ok: rootOk,
      detail: rootOk ? `Install root ${root}` : 'Invalid install root (contains .. or empty)',
      detailKey: rootOk ? 'preflight.rootOk' : 'preflight.rootBad',
      detailParams: { root }
    })

    // Disk — require torch estimate + 4GB margin for ComfyUI/venv
    const needGb = (TORCH_DISK_GB[opts.torchChannel || 'cpu'] || 3) + 4
    let freeGb = 0
    try {
      const { statfsSync } = await import('fs')
      const probeDir = existsSync(root) ? root : dirname(root)
      if (existsSync(probeDir)) {
        const st = statfsSync(probeDir)
        freeGb = (Number(st.bsize) * Number(st.bavail)) / 1024 ** 3
        checks.push({
          id: 'disk',
          ok: freeGb > needGb,
          detail: `Free ${freeGb.toFixed(1)} GB / need ~${needGb} GB (torch + deps)`,
          detailKey: 'preflight.disk',
          detailParams: { free: freeGb.toFixed(1), need: needGb }
        })
      } else {
        checks.push({
          id: 'disk',
          ok: true,
          detail: `Target dir will be created (~${needGb} GB needed)`,
          detailKey: 'preflight.diskNew',
          detailParams: { need: needGb }
        })
      }
    } catch {
      checks.push({ id: 'disk', ok: true, detail: 'Disk probe unavailable', detailKey: 'preflight.diskUnknown' })
    }

    // git — optional when using zip install (default). Only warn.
    try {
      const out = await this.run('git', ['--version'], { timeout: 5000 })
      checks.push({ id: 'git', ok: true, detail: out.trim() })
    } catch {
      checks.push({
        id: 'git',
        ok: true,
        detail: 'git not found — zip install works without Git; download portable Git for git node installs',
        detailKey: 'preflight.gitMissing',
        fixId: 'bootstrap-mingit',
        fixLabel: 'Download portable Git',
        fixLabelKey: 'install.fixGit'
      })
    }

    // python — soft-fail with bootstrap fix when missing
    const python = opts.pythonPath && opts.pythonPath.trim() ? opts.pythonPath.trim() : 'python'
    try {
      const out = await this.run(python, ['--version'], { timeout: 8000 })
      const m = out.match(/Python\s+(3)\.(\d+)/i)
      const major = m ? Number(m[1]) : 0
      const minor = m ? Number(m[2]) : -1
      const ok = major === 3 && minor >= 10
      checks.push({
        id: 'python',
        ok,
        detail: out.trim() || python,
        detailKey: ok ? undefined : 'preflight.pythonOld',
        detailParams: { python },
        fixId: ok ? undefined : 'bootstrap-python',
        fixLabel: ok ? undefined : 'Download portable Python',
        fixLabelKey: ok ? undefined : 'install.fixPython'
      })
    } catch {
      checks.push({
        id: 'python',
        ok: false,
        detail: `Interpreter not found: ${python} — one-click portable Python available`,
        detailKey: 'preflight.pythonMissing',
        detailParams: { python },
        fixId: 'bootstrap-python',
        fixLabel: 'Download portable Python',
        fixLabelKey: 'install.fixPython'
      })
    }

    if (opts.useUv) {
      // Check PATH first, then the portable uv bootstrap may have installed.
      let uvOk = false
      let uvDetail = ''
      try {
        const out = await this.run('uv', ['--version'], { timeout: 5000 })
        uvOk = true
        uvDetail = out.trim()
      } catch {
        try {
          const { findInRuntimes } = await import('./bootstrap')
          const portable = findInRuntimes('uv')
          if (portable) {
            const out = await this.run(portable, ['--version'], { timeout: 5000 })
            uvOk = true
            uvDetail = out.trim()
          }
        } catch {
          /* still missing */
        }
      }
      if (uvOk) {
        checks.push({ id: 'uv', ok: true, detail: uvDetail })
      } else {
        checks.push({
          id: 'uv',
          ok: false,
          detail: 'uv not found — one-click download, or switch to venv',
          detailKey: 'preflight.uvMissing',
          fixId: 'bootstrap-uv',
          fixLabel: 'Download uv',
          fixLabelKey: 'install.fixUv'
        })
      }
    }

    const hardFail = checks.some((c) => !c.ok && !c.fixId)
    return { ok: !hardFail, checks, diskNeedGb: needGb, diskFreeGb: freeGb }
  }

  /** Suggested install root: largest free-space fixed drive + default folder. */
  async suggestInstallRoot(): Promise<{ path: string; freeGb: number }> {
    const candidates: Array<{ path: string; freeGb: number }> = []
    const roots =
      process.platform === 'win32'
        ? ['D:\\', 'C:\\', 'E:\\', 'F:\\']
        : [join(process.env.HOME || '', 'ComfyPilotRuntimes'), '/opt/comfypilot', '/tmp']
    for (const r of roots) {
      try {
        const { statfsSync } = await import('fs')
        const probe = existsSync(r) ? r : dirname(r)
        if (!existsSync(probe)) continue
        const st = statfsSync(probe)
        const freeGb = (Number(st.bsize) * Number(st.bavail)) / 1024 ** 3
        candidates.push({ path: r, freeGb })
      } catch {
        /* skip */
      }
    }
    candidates.sort((a, b) => b.freeGb - a.freeGb)
    const best = candidates[0]
    if (!best) {
      const fallback = join(userDataDir(), 'Runtimes', 'comfy-main')
      return { path: fallback, freeGb: 0 }
    }
    const base =
      process.platform === 'win32' ? join(best.path, 'ComfyPilotRuntimes', 'comfy-main') : join(best.path, 'comfy-main')
    return { path: base, freeGb: best.freeGb }
  }

  async start(plan: InstallPlan): Promise<{ runId: string }> {
    if (this.running) throw new Error('Installer already running')
    if (!plan.installRoot || hasParentHop(plan.installRoot)) {
      throw new Error('Invalid install root')
    }
    const source = plan.comfySource === 'git' ? 'git' : 'zip'
    if (source === 'git') {
      assertSafeGitUrl(plan.comfyRepo || COMFY_REPO)
      assertSafeBranch(plan.comfyBranch || '')
    }

    this.running = true
    this.cancelled = false
    const runId = randomUUID()
    this.progress = {
      runId,
      step: 'bootstrap',
      status: 'running',
      steps: defaultSteps(),
      message: 'Install started',
      percent: 0
    }
    this.emitProgress('Install started')
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

  private pipArgs(base: string[]): string[] {
    const args = [...base]
    const pipIndex = String(loadSettings().pipIndex || '').trim()
    if (pipIndex) {
      try {
        args.push('-i', pipIndex, '--trusted-host', new URL(pipIndex).hostname)
      } catch {
        /* ignore malformed mirror */
      }
    }
    return args
  }

  private async runPlan(plan: InstallPlan): Promise<void> {
    try {
      const installRoot = resolve(normalizePathEverySegment(plan.installRoot))
      if (hasParentHop(plan.installRoot)) throw new Error('Invalid install root')
      const comfySource: 'zip' | 'git' = plan.comfySource === 'git' ? 'git' : 'zip'

      // 0. bootstrap runtimes (uv / portable Python / optional MinGit)
      this.setStep('bootstrap', 'running', 'Checking runtimes…', undefined, 'stepMsg.bootstrapRun')
      const bootstrap = await bootstrapService.ensure({
        kinds: comfySource === 'git' ? ['uv', 'python', 'mingit'] : ['uv', 'python'],
        downloadIfMissing: true
      })
      this.log('bootstrap', `python: ${bootstrap.pythonPath} (${bootstrap.pythonOrigin})`)
      const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
      // Prefer uv when asked OR when it is the only viable bootstrap path.
      // Do NOT force uv merely because it happens to be installed.
      const pythonAvailable =
        bootstrap.pythonOrigin !== 'missing' && Boolean(bootstrap.pythonPath && bootstrap.pythonPath !== 'python')
      const useUv = plan.useUv || (!pythonAvailable && Boolean(uvComp?.path))
      this.log('bootstrap', useUv ? `uv: ${uvComp?.path || 'will download'}` : 'using python -m venv')
      this.setStep('bootstrap', 'done', 'Runtimes ready', undefined, 'stepMsg.bootstrapDone')
      this.assertNotCancelled()

      // 1. preflight (soft on python/git — bootstrap already ran)
      this.setStep('preflight', 'running', 'Checking environment…', undefined, 'stepMsg.preflightRun')
      // Explicit plan.pythonPath wins over whatever bootstrap discovered.
      const pythonForPlan = this.resolvePython(plan) !== 'python'
        ? this.resolvePython(plan)
        : bootstrap.pythonOrigin !== 'missing' && bootstrap.pythonPath !== 'python'
          ? bootstrap.pythonPath
          : 'python'
      const pre = await this.preflight({
        installRoot: plan.installRoot,
        useUv: plan.useUv,
        pythonPath: pythonForPlan,
        torchChannel: plan.torchChannel
      })
      for (const c of pre.checks) this.log('preflight', `${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`)
      const hard = pre.checks.filter((c) => !c.ok && !c.fixId)
      if (hard.length) {
        throw new Error('Preflight failed: ' + hard.map((c) => c.detail).join('; '))
      }
      this.setStep('preflight', 'done', 'Preflight passed', undefined, 'stepMsg.preflightDone')
      this.assertNotCancelled()

      // 2. python
      this.setStep('python', 'running', 'Locating Python…', undefined, 'stepMsg.pythonRun')
      let python = pythonForPlan
      const pyVer = await this.run(python, ['--version'], { timeout: 8000 }).catch(() => '')
      const pythonOk = /Python\s+3\.\d+/i.test(pyVer)
      if (pythonOk) {
        this.setStep('python', 'done', pyVer.trim() || python)
      } else if (bootstrap.pythonPath && bootstrap.pythonPath !== 'python' && bootstrap.pythonPath !== python) {
        python = bootstrap.pythonPath
        const retryVer = await this.run(python, ['--version'], { timeout: 8000 }).catch(() => '')
        if (/Python\s+3\.\d+/i.test(retryVer)) {
          this.setStep('python', 'done', retryVer.trim() || python)
        } else if (useUv && uvComp?.path) {
          // uv can fetch/manange its own interpreter; keep going with uv venv.
          this.log('python', 'Using uv-managed Python')
          this.setStep('python', 'done', `via uv (${uvComp.path})`)
          python = bootstrap.pythonPath
        } else {
          throw new Error('Cannot locate Python 3.10+ (bootstrap should have provided one)')
        }
      } else if (useUv && uvComp?.path) {
        this.log('python', 'System Python unavailable — using uv-managed Python')
        this.setStep('python', 'done', `via uv (${uvComp.path})`)
        python = 'python' // uv venv --python can resolve/install a default
      } else {
        throw new Error('Cannot locate Python 3.10+ (bootstrap should have provided one)')
      }
      this.assertNotCancelled()

      // 3. venv isolated — PIN to CPython 3.13.
      // A system 3.14+ interpreter has no torch wheels yet; 3.13 is the current sweet spot.
      mkdirSync(installRoot, { recursive: true })
      const venvPath = join(installRoot, '.venv')
      this.setStep('venv', 'running', useUv ? 'uv venv…' : 'python -m venv…', undefined, useUv ? 'stepMsg.venvUv' : 'stepMsg.venvPy')
      if (useUv && uvComp?.path) {
        // Ensure uv has a 3.13 interpreter, then build the venv from it.
        try {
          await this.run(uvComp.path, ['python', 'install', '3.13'], { timeout: 180000 })
          this.log('venv', 'uv python 3.13 ready')
        } catch (e) {
          this.log('venv', `uv python install 3.13: ${e instanceof Error ? e.message : String(e)}`)
        }
        await this.run(uvComp.path, ['venv', venvPath, '--python', '3.13', '--seed'], { timeout: 180000 })
      } else {
        // Prefer an explicit 3.10–3.13 interpreter; reject nothing here but log.
        await this.run(python, ['-m', 'venv', venvPath], { timeout: 180000 })
        const verOut = await this.run(this.venvPython(venvPath), ['--version'], { timeout: 8000 }).catch(() => '')
        if (/Python\s+3\.(1[4-9]|\d{2,})/i.test(verOut)) {
          this.log(
            'venv',
            `Warning: ${verOut.trim()} may not have torch wheels — prefer Python 3.13. Re-run with uv enabled.`
          )
        }
      }
      const vpy = this.venvPython(venvPath)
      if (!existsSync(vpy)) throw new Error(`venv creation failed — missing ${vpy}`)
      this.setStep('venv', 'done', venvPath, undefined, 'stepMsg.venvDone', { path: venvPath })
      this.assertNotCancelled()

      // 4. ComfyUI source — zip (default, no Git) or git clone
      const comfyDir = join(installRoot, 'ComfyUI')
      this.setStep('comfyui', 'running', comfySource === 'git' ? 'Cloning ComfyUI…' : 'Downloading ComfyUI archive…', undefined, comfySource === 'git' ? 'stepMsg.comfyGit' : 'stepMsg.comfyZip')
      if (existsSync(join(comfyDir, 'main.py'))) {
        this.log('comfyui', 'ComfyUI already present — skipping fetch')
        if (plan.comfyBranch && comfySource === 'git') {
          this.log('comfyui', `Note: reused existing dir — did not switch to branch ${plan.comfyBranch}`)
        }
        this.setStep('comfyui', 'done', 'Reused existing ComfyUI', undefined, 'stepMsg.comfyReuse')
      } else {
        if (existsSync(comfyDir)) {
          if (!isPathInside(comfyDir, installRoot)) throw new Error('Refusing to remove ComfyUI outside install root')
          // Only remove debris WE created: either a prior ComfyPilot install
          // (marker file present) or a directory that looks like a crashed clone
          // (no foreign top-level content besides typical ComfyUI names).
          const marker = existsSync(join(installRoot, '.comfypilot-env.json'))
          const foreign = readdirSync(comfyDir).filter(
            (n) => !/^(main\.py|requirements\.txt|comfy|comfyui|app|web|custom_nodes|models|input|output|user|script_examples|\.git|\.github|LICENSE|README)/i.test(n)
          )
          if (!marker && foreign.length) {
            throw new Error(
              `Refusing to delete ${comfyDir}: directory is non-empty and not a ComfyPilot install remnant (has ${foreign.slice(0, 3).join(', ')}）`
            )
          }
          rmSync(comfyDir, { recursive: true, force: true })
          this.log('comfyui', 'Removed incomplete ComfyUI dir — re-fetching')
        }
        if (comfySource === 'git') {
          const repo = plan.comfyRepo || COMFY_REPO
          const branch = plan.comfyBranch || ''
          const args = buildGitCloneArgs(repo, comfyDir, branch)
          const gitBin = bootstrap.components.find((c) => c.kind === 'mingit' && c.installed)?.path || 'git'
          await this.run(gitBin, args, { timeout: 300000 })
        } else {
          await this.fetchComfyZip(comfyDir)
        }
        if (!existsSync(join(comfyDir, 'main.py'))) {
          // zip extracts to ComfyUI-master/ — flatten if needed
          await this.flattenArchiveRoot(comfyDir)
        }
        if (!existsSync(join(comfyDir, 'main.py'))) throw new Error('ComfyUI fetch finished but main.py is missing')
        this.setStep('comfyui', 'done', comfySource === 'git' ? 'Cloned ComfyUI' : 'Extracted ComfyUI archive', undefined, comfySource === 'git' ? 'stepMsg.comfyCloned' : 'stepMsg.comfyExtracted')
      }
      this.assertNotCancelled()

      // 5. torch — try configured index, fall back to official on "not found"
      this.setStep('torch', 'running', plan.torchChannel, undefined, 'stepMsg.torchRun', { channel: plan.torchChannel })
      const index = resolveTorchIndex(plan.torchChannel)
      const official = officialTorchIndex(plan.torchChannel)
      this.log('torch', `torch index: ${index}`)
      const installTorchWith = async (idx: string): Promise<void> => {
        if (useUv && uvComp?.path) {
          await this.run(
            uvComp.path,
            ['pip', 'install', '--python', vpy, 'torch', 'torchvision', 'torchaudio', '--index-url', idx],
            { timeout: 30 * 60 * 1000 }
          )
        } else {
          // uv-created venvs have no pip — seed it first.
          const { ensurePip } = await import('./env')
          await ensurePip(vpy, (c, a, o) => this.run(c, a, o))
          await this.run(vpy, this.pipArgs(['-m', 'pip', 'install', '--upgrade', 'pip']), { timeout: 120000 })
          await this.run(
            vpy,
            this.pipArgs(['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', idx]),
            { timeout: 30 * 60 * 1000 }
          )
        }
      }
      try {
        await installTorchWith(index)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (index === official) throw err
        this.log('torch', `index ${index} failed (${msg.slice(0, 160)}) — retrying official ${official}`)
        await installTorchWith(official)
      }
      this.setStep('torch', 'done', plan.torchChannel)
      this.assertNotCancelled()

      // 6. requirements
      this.setStep('requirements', 'running', 'Installing requirements…', undefined, 'stepMsg.reqRun')
      const reqFile = join(comfyDir, 'requirements.txt')
      if (existsSync(reqFile)) {
        // Shared helper: uv first (works without pip), then ensurepip + pip,
        // official PyPI as extra index / retry when the mirror cannot resolve.
        const { installRequirements } = await import('./env')
        await installRequirements(vpy, reqFile, (c, a, o) => this.run(c, a, o), {
          uvPath: useUv && uvComp?.path ? uvComp.path : undefined,
          pipIndex: String(loadSettings().pipIndex || '').trim()
        })
        this.setStep('requirements', 'done', 'requirements installed', undefined, 'stepMsg.reqDone')
      } else {
        this.setStep('requirements', 'skipped', 'No requirements.txt', undefined, 'stepMsg.reqSkip')
      }
      this.assertNotCancelled()

      // 7. register instance
      this.setStep('register', 'running', 'Writing instance config…', undefined, 'stepMsg.regRun')
      const existing = loadInstanceConfigs()
      const samePath = existing.find(
        (c) => normalizeForCompare(c.path) === normalizeForCompare(comfyDir)
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
        frontendVersion: '',
        pinned: false
      }
      upsertInstanceConfig(config)
      if (this.progress) {
        this.progress.instanceId = config.id
        this.emitProgress(`registered ${config.id}`)
      }

      writeFileSync(
        join(installRoot, '.comfypilot-env.json'),
        JSON.stringify(
          {
            venvPath,
            torchChannel: plan.torchChannel,
            python,
            createdAt: Date.now(),
            isolated: true,
            comfySource,
            comfyFetchedAt: Date.now()
          },
          null,
          2
        )
      )
      this.setStep('register', 'done', config.name, undefined, 'stepMsg.regDone', { name: config.name })

      if (plan.createDesktopShortcut) {
        try {
          const { createDesktopShortcut, appExecutablePath, appIconPath } = await import('./desktop')
          const shortcutPath = await createDesktopShortcut({
            targetPath: appExecutablePath(),
            name: plan.instanceName || 'ComfyPilot',
            cwd: installRoot,
            iconPath: appIconPath()
          })
          this.log('register', `Desktop shortcut: ${shortcutPath}`)
        } catch (e) {
          this.log('register', `Desktop shortcut failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 8. starter model guidance (optional download of the recommended pack)
      if (plan.skipStarter) {
        this.setStep('starter', 'skipped', 'Skipped starter model', undefined, 'stepMsg.starterSkip')
      } else {
        this.setStep('starter', 'running', 'Preparing starter models…', undefined, 'stepMsg.starterRun')
        if (plan.fullAuto) {
          // Batteries-included: kick off the recommended starter pack so the
          // user can generate right after install. Download is async (model
          // service owns progress/retry); failures are logged, never fatal.
          const recommended = STARTER_MODELS.find((s) => s.recommended) || STARTER_MODELS[0]
          if (recommended) {
            try {
              this.log('starter', `Auto-downloading starter model: ${recommended.name}`)
              await this.installStarter({ id: recommended.id, instanceId: config.id })
              this.log('starter', `Starter download started: ${recommended.name}`)
            } catch (e) {
              this.log('starter', `Starter auto-download failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        } else {
          this.log('starter', 'One-click SD1.5 / SDXL / Flux packs available in Models → Download')
        }
        this.setStep('starter', 'done', 'Starter models ready', undefined, 'stepMsg.starterDone')
      }

      // 9. done + optional auto-start
      if (plan.autoStart) {
        try {
          this.log('done', 'Auto-starting instance…')
          const { instanceService } = await import('./instance')
          await instanceService.start(config.id)
          this.setStep('done', 'done', 'Installed and started', undefined, 'stepMsg.doneStarted')
        } catch (e) {
          this.log('done', `Auto-start failed: ${e instanceof Error ? e.message : String(e)}`)
          this.setStep('done', 'done', 'Installed (auto-start failed)', undefined, 'stepMsg.doneStartFail')
        }
      } else {
        this.setStep('done', 'done', 'Installed — ready to launch', undefined, 'stepMsg.done')
      }

      if (this.progress) {
        this.progress.status = 'done'
        this.progress.percent = 100
        this.progress.message = 'Install complete'
        this.progress.bytes = undefined
      }
      this.emitProgress('Install complete')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = this.cancelled || /Installation cancelled/i.test(message)
      const cleaned: string[] = []
      try {
        const root = resolve(normalizePathEverySegment(plan.installRoot))
        const comfyDir = join(root, 'ComfyUI')
        if (isPathInside(comfyDir, root) && existsSync(comfyDir) && !existsSync(join(comfyDir, 'main.py'))) {
          // Same debris rule as the fetch step: never delete foreign content here,
          // otherwise the "refuse to delete non-install dirs" guard is defeated.
          const marker = existsSync(join(root, '.comfypilot-env.json'))
          const foreign = readdirSync(comfyDir).filter(
            (n) => !/^(main\.py|requirements\.txt|comfy|comfyui|app|web|custom_nodes|models|input|output|user|script_examples|\.git|\.github|LICENSE|README)/i.test(n)
          )
          if (marker || !foreign.length) {
            rmSync(comfyDir, { recursive: true, force: true })
            cleaned.push('ComfyUI')
          }
        }
        const venvPath = join(root, '.venv')
        if (isPathInside(venvPath, root) && existsSync(venvPath) && !existsSync(this.venvPython(venvPath))) {
          rmSync(venvPath, { recursive: true, force: true })
          cleaned.push('.venv')
        }
      } catch {
        /* cleanup is best-effort */
      }
      const cleanedNote = cleaned.length ? ` (cleaned: ${cleaned.join(', ')} — safe to retry)` : ''
      if (this.progress) {
        this.progress.status = 'failed'
        this.progress.error = cancelled ? 'Installation cancelled' : message
        this.progress.message = this.progress.error + cleanedNote
        this.progress.bytes = undefined
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

  /** Download ComfyUI GitHub archive zip into comfyDir (extracted + flattened). */
  private async fetchComfyZip(comfyDir: string): Promise<void> {
    const url = applyGithubMirror(COMFY_ZIP_URL)
    if (!isSafeExternalUrl(url)) throw new Error('Blocked ComfyUI archive URL')
    const { session } = await import('electron')
    const tmpZip = join(dirname(comfyDir), `._comfyui_${Date.now()}.zip`)
    const res = await session.defaultSession.fetch(url, {
      headers: { 'User-Agent': 'ComfyPilot/0.1' },
      signal: AbortSignal.timeout(10 * 60 * 1000)
    })
    if (!res.ok) throw new Error(`ComfyUI archive download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') || 0)
    const buf = Buffer.from(await res.arrayBuffer())
    this.setBytes({
      receivedBytes: buf.byteLength,
      totalBytes: total || buf.byteLength,
      speedBps: 0,
      label: 'ComfyUI archive'
    })
    writeFileSync(tmpZip, buf)

    mkdirSync(comfyDir, { recursive: true })
    const { safeUnzip } = await import('./zipSafe')
    await safeUnzip(tmpZip, comfyDir)
    try {
      rmSync(tmpZip, { force: true })
    } catch {
      /* ignore */
    }
    await this.flattenArchiveRoot(comfyDir)
    this.setBytes(undefined)
  }

  /** GitHub zips nest under ComfyUI-master/ — move children up so main.py sits at root. */
  private async flattenArchiveRoot(comfyDir: string): Promise<void> {
    if (existsSync(join(comfyDir, 'main.py'))) return
    try {
      const entries = readdirSync(comfyDir).filter((n) => !n.startsWith('.'))
      if (entries.length !== 1) return
      const nested = join(comfyDir, entries[0])
      if (!statSync(nested).isDirectory() || !existsSync(join(nested, 'main.py'))) return
      for (const child of readdirSync(nested)) {
        renameSync(join(nested, child), join(comfyDir, child))
      }
      // Remove the now-empty nest. Some Windows setups leave the dir handle
      // briefly busy — retry a couple of times before giving up.
      for (let i = 0; i < 3; i++) {
        try {
          rmSync(nested, { recursive: true, force: true })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      if (existsSync(nested)) {
        // Last resort: rmdir when empty
        try {
          rmSync(nested, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
        } catch {
          /* leave debris; main.py is already at root */
        }
      }
    } catch {
      /* leave as-is; caller validates main.py */
    }
  }

  /**
   * Kick off a starter-model download into the instance models/checkpoints.
   * Reuses modelService so proxy/mirror/resume all apply.
   */
  async installStarter(opts: { id: string; instanceId?: string }): Promise<unknown> {
    const starter = STARTER_MODELS.find((s) => s.id === opts.id)
    if (!starter) throw new Error(`Unknown starter model: ${opts.id}`)
    const configs = loadInstanceConfigs()
    // Explicit id wins; never silently fall back to configs[0] when an id was given.
    const config = opts.instanceId
      ? configs.find((c) => c.id === opts.instanceId)
      : configs[0]
    if (!config) {
      throw new Error(
        opts.instanceId
          ? `Instance ${opts.instanceId} not found — finish install first`
          : 'No instance registered — finish install first'
      )
    }
    const destDir = join(config.path, 'models', starter.category)
    mkdirSync(destDir, { recursive: true })
    const { modelService } = await import('./model')
    return modelService.download({ url: starter.url, destDir })
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

export { TORCH_INDEX, COMFY_REPO, STARTER_MODELS }

void spawn
void basename
void TORCH_INDEX_PRESETS
void createWriteStream
