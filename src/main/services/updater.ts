/**
 * ComfyUI in-place updater (0.1.4).
 *
 * Updates an ALREADY-REGISTERED instance's ComfyUI source tree and (optionally)
 * its Python dependencies. User data is preserved by design:
 *   custom_nodes/ models/ user/ input/ output/ extra_model_paths.yaml
 *   .comfypilot-env.json
 *
 * Source strategies:
 *   git  — git fetch + pull --ff-only (keeps history; rollback = reset --hard)
 *   zip  — download GitHub archive and overlay files that the archive contains
 *          (never deletes user-preserved dirs; stale core files listed in the
 *          archive manifest are replaced, files absent from the archive are left)
 *
 * Every destructive step is preceded by a backup under
 *   <parent-of-comfyDir>/.cp-backups/<timestamp>/
 * (deliberately OUTSIDE the git working tree — a backup dir inside comfyDir
 * makes `git status` dirty and blocks rollback) and a failed run rolls back
 * from that backup. Rollback failures are reported loudly (never swallowed).
 */
import { EventEmitter } from 'events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  cpSync
} from 'fs'
import { join, resolve, dirname } from 'path'
import { execFile, execFileSync, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type {
  ComfyUpdateInfo,
  ComfyUpdateOptions,
  ComfyInstanceConfig,
  InstallStepByteProgress,
  InstallStepStatus,
  UpdateProgress,
  UpdateStep,
  UpdateStepId
} from '@shared/types'
import { loadInstanceConfigs, loadSettings } from './db'
import { normalizePathEverySegment, hasParentHop, isSafeExternalUrl } from './security'
import { proxyEnv } from './proxy'
import { resolveTorchIndex, officialTorchIndex, applyGithubMirror } from './installer'
import { resolveGitBinary } from './nodePack'
import { bootstrapService } from './bootstrap'

const EXEC_OPTS = {
  timeout: 30 * 60 * 1000,
  windowsHide: true,
  maxBuffer: 20 * 1024 * 1024
} as const

/**
 * Directories / files that MUST survive a source update.
 * Anything not in this list is "core" and may be replaced by the new tree.
 */
export const PRESERVE_ENTRIES = new Set([
  'custom_nodes',
  'models',
  'user',
  'input',
  'output',
  'extra_model_paths.yaml',
  '.comfypilot-env.json',
  '.git', // only relevant for git installs; zip overlay skips it anyway
  '.cp-backup', // prefix handled separately
  'venv',
  '.venv',
  'python_embeded',
  'python_embedded'
])

function nowStep(id: UpdateStepId, title: string, status: UpdateStep['status'] = 'pending'): UpdateStep {
  return { id, title, status, detail: '', log: [] }
}

function defaultSteps(): UpdateStep[] {
  return [
    nowStep('preflight', 'Preflight'),
    nowStep('stop', 'Stop instance'),
    nowStep('backup', 'Back up core files'),
    nowStep('fetch', 'Fetch ComfyUI update'),
    nowStep('requirements', 'Reinstall requirements'),
    nowStep('torch', 'Reinstall torch (optional)'),
    nowStep('verify', 'Verify'),
    nowStep('rollback', 'Rollback'),
    nowStep('done', 'Done')
  ]
}

function venvPython(venvPath: string): string {
  const win = join(venvPath, 'Scripts', 'python.exe')
  const unix = join(venvPath, 'bin', 'python')
  return existsSync(win) ? win : unix
}

/**
 * Thrown when the update aborted BEFORE rewriting the tree (e.g. git pull
 * failed because of local changes). Rollback must NOT run — `reset --hard`
 * would destroy the user's uncommitted edits.
 */
class UpdateAbortedNoTreeChange extends Error {}

/**
 * Thrown when the SOURCE update succeeded but a dependency step failed.
 * Rollback must NOT run — the new source + new requirements.txt is the state
 * the user wants; dropping it would lose a good update. The user retries deps
 * via `repairEnv` (or pip manually).
 */
class UpdateDepsFailedAfterSourceOk extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateDepsFailedAfterSourceOk'
  }
}

function pipArgs(base: string[]): string[] {
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

/** Resolve the source kind for an instance install directory. */
export function detectComfySource(comfyDir: string): 'git' | 'zip' | 'unknown' {
  if (existsSync(join(comfyDir, '.git'))) return 'git'
  if (existsSync(join(comfyDir, 'main.py'))) return 'zip'
  return 'unknown'
}

/**
 * Best-effort local version string:
 *  - git: `git describe --tags --always` → falls back to short sha
 *  - zip: .comfypilot-env.json.comfyCommit / comfyFetchedAt
 *  - else: pyproject version / 'detected'
 */
export function probeComfyVersion(comfyDir: string): string {
  const source = detectComfySource(comfyDir)
  if (source === 'git') {
    try {
      const gitBin = resolveGitBinary()
      const out = execFileSync(gitBin, ['-C', comfyDir, 'describe', '--tags', '--always'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true
      })
      return out.trim() || 'git'
    } catch {
      /* fall through */
    }
  }
  try {
    const envFile = join(dirname(comfyDir), '.comfypilot-env.json')
    const alt = join(comfyDir, '.comfypilot-env.json')
    for (const f of [alt, envFile]) {
      if (!existsSync(f)) continue
      const data = JSON.parse(readFileSync(f, 'utf-8')) as {
        comfyCommit?: string
        comfyFetchedAt?: number
        comfyVersion?: string
      }
      if (data.comfyVersion) return data.comfyVersion
      if (data.comfyCommit) return data.comfyCommit.slice(0, 12)
      if (data.comfyFetchedAt) return new Date(data.comfyFetchedAt).toISOString().slice(0, 10)
    }
  } catch {
    /* ignore */
  }
  try {
    const pyproject = join(comfyDir, 'pyproject.toml')
    if (existsSync(pyproject)) {
      const text = readFileSync(pyproject, 'utf-8')
      const m = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)
      if (m) return m[1]
    }
    if (existsSync(join(comfyDir, 'requirements.txt'))) return 'detected'
  } catch {
    /* ignore */
  }
  return 'unknown'
}

/** Persist provenance next to the install so future probes can report a version. */
function stampInstallMeta(
  comfyDir: string,
  patch: { comfyCommit?: string; comfyFetchedAt?: number; comfyVersion?: string; comfySource?: string }
): void {
  try {
    const f = join(dirname(comfyDir), '.comfypilot-env.json')
    let data: Record<string, unknown> = {}
    if (existsSync(f)) {
      try {
        data = JSON.parse(readFileSync(f, 'utf-8')) as Record<string, unknown>
      } catch {
        data = {}
      }
    }
    writeFileSync(f, JSON.stringify({ ...data, ...patch }, null, 2))
  } catch {
    /* best-effort */
  }
}

export class ComfyUpdaterService extends EventEmitter {
  private progress: UpdateProgress | null = null
  private cancelled = false
  private running = false
  private children = new Set<ChildProcess>()
  private runRejects = new Set<(err: Error) => void>()
  /** Resolves when the in-flight runUpdate settles (done/failed/cancelled). */
  private currentRun: Promise<void> | null = null

  getStatus(): UpdateProgress | null {
    return this.progress
  }

  /**
   * Wait until the current run settles. Used by the IPC layer so
   * `await ipc('instance.updateComfy')` means "update finished", while
   * `start()` itself stays fire-and-forget (events stream interim progress).
   */
  async waitUntilSettled(): Promise<UpdateProgress | null> {
    if (this.currentRun) {
      try {
        await this.currentRun
      } catch {
        /* runUpdate never rejects — it records failures on progress */
      }
    }
    return this.getStatus()
  }

  cancel(): boolean {
    this.cancelled = true
    const kills: Array<Promise<void>> = []
    for (const child of this.children) kills.push(this.killTree(child))
    for (const rej of this.runRejects) {
      try {
        rej(new Error('Update cancelled'))
      } catch {
        /* ignore */
      }
    }
    this.runRejects.clear()
    void Promise.allSettled(kills).then(() => this.children.clear())
    return true
  }

  private killTree(child: ChildProcess): Promise<void> {
    return new Promise((resolveP) => {
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
            resolveP()
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
        resolveP()
      }, 500)
    })
  }

  private async run(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
    this.assertNotCancelled()
    return new Promise((resolveP, reject) => {
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
            reject(new Error('Update cancelled'))
            return
          }
          if (err) {
            reject(new Error(stderr || stdout || err.message))
            return
          }
          resolveP(stdout)
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

  private setBytes(bytes?: InstallStepByteProgress): void {
    if (!this.progress) return
    this.progress.bytes = bytes
    this.emitProgress(bytes?.label || '')
  }

  private setStep(
    id: UpdateStepId,
    status: InstallStepStatus,
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

  private log(id: UpdateStepId, line: string): void {
    if (!this.progress) return
    const step = this.progress.steps.find((s) => s.id === id)
    if (step) step.log.push(line)
    this.emitProgress(line)
  }

  private assertNotCancelled(): void {
    if (this.cancelled) throw new Error('Update cancelled')
  }

  /**
   * Run a command WITHOUT the cancel gate. Used exclusively by rollback —
   * a cancelled update must still be able to restore the previous state.
   */
  private async runRaw(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
    return new Promise((resolveP, reject) => {
      execFile(
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
          if (err) {
            reject(new Error(stderr || stdout || err.message))
            return
          }
          resolveP(stdout)
        }
      )
    })
  }

  private requireInstance(instanceId: string): ComfyInstanceConfig {
    const config = loadInstanceConfigs().find((c) => c.id === instanceId)
    if (!config) throw new Error(`Instance not found: ${instanceId}`)
    if (!config.path || hasParentHop(config.path)) throw new Error('Invalid instance path')
    return config
  }

  /** Compare local vs remote and tell the UI whether an update is worthwhile. */
  async check(instanceId: string): Promise<ComfyUpdateInfo> {
    const config = this.requireInstance(instanceId)
    const comfyDir = resolve(normalizePathEverySegment(config.path))
    const source = detectComfySource(comfyDir)
    const current = probeComfyVersion(comfyDir)
    const checkedAt = Date.now()

    if (source === 'git') {
      try {
        const gitBin = resolveGitBinary()
        // remote URL for informational purposes / mirror rewrite is NOT applied
        // to fetch (the local remote is already configured at clone time).
        await this.run(gitBin, ['-C', comfyDir, 'fetch', '--quiet', '--tags'], { timeout: 60000 })
        const behindOut = await this.run(gitBin, ['-C', comfyDir, 'rev-list', '--count', 'HEAD..@{u}'], {
          timeout: 10000
        })
        const behind = Number(behindOut.trim()) || 0
        let latestCommit = ''
        let latest = ''
        try {
          latestCommit = (await this.run(gitBin, ['-C', comfyDir, 'rev-parse', '--short', '@{u}'], { timeout: 5000 })).trim()
          latest = (await this.run(gitBin, ['-C', comfyDir, 'describe', '--tags', '--always', '@{u}'], { timeout: 5000 })).trim()
        } catch {
          latest = latestCommit || current
        }
        return {
          instanceId,
          current,
          latest: latest || undefined,
          source: 'git',
          updatable: behind > 0,
          behindCount: behind,
          latestCommit: latestCommit || undefined,
          checkedAt
        }
      } catch (e) {
        return {
          instanceId,
          current,
          source: 'git',
          updatable: false,
          checkedAt,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }

    if (source === 'zip') {
      // Compare against GitHub master archive commit via the API (lightweight).
      try {
        const url = applyGithubMirror('https://api.github.com/repos/comfyanonymous/ComfyUI/commits/master')
        const { session } = await import('electron')
        const res = await session.defaultSession.fetch(url, {
          headers: { 'User-Agent': 'ComfyPilot/0.1', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15000)
        })
        if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
        const data = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string } } }
        const latestCommit = (data.sha || '').slice(0, 12)
        const latestDate = data.commit?.committer?.date
        // Local stamp (if any) is a commit sha or a fetch date.
        let updatable = true
        if (latestCommit && current && /^[a-f0-9]{7,}$/i.test(current)) {
          updatable = !latestCommit.startsWith(current) && !current.startsWith(latestCommit)
        } else if (latestDate && current && /^\d{4}-\d{2}-\d{2}/.test(current)) {
          updatable = current < latestDate.slice(0, 10)
        }
        return {
          instanceId,
          current,
          latest: latestCommit || latestDate || undefined,
          source: 'zip',
          updatable,
          latestCommit: latestCommit || undefined,
          checkedAt
        }
      } catch (e) {
        // Offline: still allow the user to force an update (re-download).
        return {
          instanceId,
          current,
          source: 'zip',
          updatable: true,
          checkedAt,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }

    return {
      instanceId,
      current,
      source: 'unknown',
      updatable: false,
      checkedAt,
      error: 'Not a recognizable ComfyUI install (missing main.py)'
    }
  }

  async start(instanceId: string, opts?: ComfyUpdateOptions): Promise<UpdateProgress> {
    if (this.running) throw new Error('Update already running')
    const config = this.requireInstance(instanceId)
    this.running = true
    this.cancelled = false
    const runId = randomUUID()
    this.progress = {
      runId,
      instanceId,
      step: 'preflight',
      status: 'running',
      steps: defaultSteps(),
      message: 'Update started',
      percent: 0
    }
    this.emitProgress('Update started')
    this.currentRun = this.runUpdate(config, opts || {}).finally(() => {
      this.running = false
    })
    return { ...this.progress }
  }

  private async runUpdate(config: ComfyInstanceConfig, opts: ComfyUpdateOptions): Promise<void> {
    const comfyDir = resolve(normalizePathEverySegment(config.path))
    let backupPath: string | undefined
    let backupKind: 'git' | 'files' | null = null
    /** True once we actually rewrote the tree — only then is a rollback meaningful. */
    let treeModified = false
    try {
      // 0. preflight
      this.setStep('preflight', 'running', 'Checking install…', undefined, 'update.msgPreflightRun')
      if (!existsSync(join(comfyDir, 'main.py'))) {
        throw new Error(`Not a ComfyUI install: missing main.py under ${comfyDir}`)
      }
      const source = detectComfySource(comfyDir)
      if (source === 'unknown') throw new Error('Cannot determine ComfyUI source kind')
      const venvPath = config.venvPath || join(dirname(comfyDir), '.venv')
      const vpy = venvPython(venvPath)
      if (!existsSync(vpy)) {
        this.log('preflight', `Warning: venv python missing at ${vpy} — dependency steps will fail`)
      }
      this.log('preflight', `source=${source} dir=${comfyDir}`)
      this.setStep('preflight', 'done', `Source: ${source}`, undefined, 'update.msgPreflightDone', { source })
      this.assertNotCancelled()

      // 1. stop instance if running
      this.setStep('stop', 'running', 'Stopping instance…', undefined, 'update.msgStopRun')
      try {
        const { instanceService } = await import('./instance')
        const info = instanceService.list().find((i) => i.id === config.id)
        if (info && (info.status === 'running' || info.status === 'starting')) {
          await instanceService.stop(config.id)
          // wait for port to free (same pattern as instance.restart)
          const port = config.port || 8188
          for (let i = 0; i < 20; i++) {
            const check = await instanceService.checkPort(port)
            if (check.available) break
            await new Promise((r) => setTimeout(r, 150))
          }
          this.log('stop', 'Instance stopped')
        } else {
          this.log('stop', 'Instance not running — nothing to stop')
        }
        this.setStep('stop', 'done', 'Instance stopped')
      } catch (e) {
        // If stop fails because it is an adopted external process, proceed but warn.
        this.log('stop', `Stop: ${e instanceof Error ? e.message : String(e)}`)
        this.setStep('stop', 'done', 'Proceeding without stop')
      }
      this.assertNotCancelled()

      // 2. backup — keep it OUTSIDE the comfyDir git tree so it never shows up
      // as an "uncommitted local change" and blocks rollback.
      this.setStep('backup', 'running', 'Backing up core files…', undefined, 'update.msgBackupRun')
      const source2 = detectComfySource(comfyDir)
      const backupsRoot = join(dirname(comfyDir), '.cp-backups')
      mkdirSync(backupsRoot, { recursive: true })
      backupPath = join(backupsRoot, `${Date.now()}`)
      mkdirSync(backupPath, { recursive: true })
      if (source2 === 'git') {
        // git is self-versioned: record the current sha so rollback can reset.
        const gitBin = resolveGitBinary()
        const sha = (await this.run(gitBin, ['-C', comfyDir, 'rev-parse', 'HEAD'], { timeout: 5000 })).trim()
        writeFileSync(join(backupPath, 'HEAD'), sha)
        // Also snapshot user-preserved dirs' *listings* only (not the data) for audit.
        writeFileSync(
          join(backupPath, 'manifest.json'),
          JSON.stringify({ kind: 'git', sha, comfyDir, createdAt: Date.now() }, null, 2)
        )
        backupKind = 'git'
        this.log('backup', `git HEAD ${sha} recorded`)
      } else {
        // zip: copy core tree (everything except PRESERVE_ENTRIES and backups).
        const copied = this.copyCoreTree(comfyDir, backupPath)
        writeFileSync(
          join(backupPath, 'manifest.json'),
          JSON.stringify({ kind: 'files', copied, comfyDir, createdAt: Date.now() }, null, 2)
        )
        backupKind = 'files'
        this.log('backup', `copied ${copied} core entries to ${backupPath}`)
      }
      if (this.progress) this.progress.backupPath = backupPath
      this.setStep('backup', 'done', backupPath, undefined, 'update.msgBackup', { path: backupPath })
      this.assertNotCancelled()

      // 3. fetch
      if (source2 === 'git') {
        this.setStep('fetch', 'running', 'Pulling latest source…', undefined, 'update.msgFetchGit')
        const gitBin = resolveGitBinary()
        try {
          await this.run(gitBin, ['-C', comfyDir, 'pull', '--ff-only'], { timeout: 300000 })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.log('fetch', `pull --ff-only failed: ${msg}`)
          // ff-only failure means local changes or diverged history. The working
          // tree was NOT rewritten by us — do NOT rollback (reset --hard would
          // destroy the user's local edits). Report and stop.
          throw new UpdateAbortedNoTreeChange(
            `git pull --ff-only failed: ${msg}. Commit/stash local changes in ${comfyDir} and retry. Your local files were left untouched.`
          )
        }
        treeModified = true
        const sha = (await this.run(gitBin, ['-C', comfyDir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 })).trim()
        stampInstallMeta(comfyDir, { comfyCommit: sha, comfyFetchedAt: Date.now(), comfySource: 'git' })
        this.log('fetch', `updated to ${sha}`)
        this.setStep('fetch', 'done', `HEAD ${sha}`, undefined, 'update.msgFetchGitDone', { sha })
      } else {
        this.setStep('fetch', 'running', 'Downloading archive…', undefined, 'update.msgFetchZip')
        await this.fetchAndOverlayZip(comfyDir)
        treeModified = true
        stampInstallMeta(comfyDir, {
          comfyFetchedAt: Date.now(),
          comfyCommit: undefined,
          comfySource: 'zip'
        })
        this.setStep('fetch', 'done', 'Archive overlaid', undefined, 'update.msgFetchZipDone')
      }
      this.assertNotCancelled()

      // 4. requirements
      if (opts.updateDeps === false) {
        this.setStep('requirements', 'skipped', 'Skipped by user')
        this.setStep('torch', 'skipped', 'Skipped by user')
      } else {
        this.setStep('requirements', 'running', 'Installing requirements…', undefined, 'update.msgReqRun')
        const vpy2 = venvPython(config.venvPath || join(dirname(comfyDir), '.venv'))
        const reqFile = join(comfyDir, 'requirements.txt')
        if (!existsSync(reqFile)) {
          this.setStep('requirements', 'skipped', 'No requirements.txt', undefined, 'update.msgReqSkip')
        } else if (!existsSync(vpy2)) {
          throw new Error(`Cannot install requirements — venv python missing at ${vpy2}`)
        } else {
          // Requirements may reference packages missing from the configured
          // mirror (e.g. comfyui-workflow-templates-media-assets-*). Always
          // expose official PyPI as an extra index so a mirror gap is not fatal.
          const OFFICIAL_PYPI = 'https://pypi.org/simple'
          const pipIndex = String(loadSettings().pipIndex || '').trim()
          const bootstrap = await bootstrapService.ensure({ kinds: ['uv'], downloadIfMissing: false })
          const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
          const installReq = async (): Promise<void> => {
            if (uvComp?.path) {
              const uvArgs = ['pip', 'install', '--python', vpy2, '-r', reqFile]
              if (pipIndex) {
                uvArgs.push('--index-url', pipIndex)
                if (pipIndex !== OFFICIAL_PYPI) uvArgs.push('--extra-index-url', OFFICIAL_PYPI)
              }
              await this.run(uvComp.path, uvArgs, { timeout: EXEC_OPTS.timeout })
            } else {
              // uv-created venvs have no pip — seed it first.
              const { ensurePip } = await import('./env')
              await ensurePip(vpy2, (c, a, o) => this.run(c, a, o))
              const args = ['-m', 'pip', 'install', '-r', reqFile]
              if (pipIndex) {
                args.push('-i', pipIndex)
                try {
                  args.push('--trusted-host', new URL(pipIndex).hostname)
                } catch {
                  /* skip */
                }
                if (pipIndex !== OFFICIAL_PYPI) args.push('--extra-index-url', OFFICIAL_PYPI)
              }
              await this.run(vpy2, args, { timeout: EXEC_OPTS.timeout })
            }
          }
          try {
            await installReq()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            // Retry once against official PyPI only — the mirror is the usual
            // reason a package "was not found in the package registry".
            if (pipIndex && pipIndex !== OFFICIAL_PYPI) {
              this.log('requirements', `index ${pipIndex} failed (${msg.slice(0, 160)}) — retrying official PyPI`)
              try {
                if (uvComp?.path) {
                  await this.run(
                    uvComp.path,
                    ['pip', 'install', '--python', vpy2, '-r', reqFile, '--index-url', OFFICIAL_PYPI],
                    { timeout: EXEC_OPTS.timeout }
                  )
                } else {
                  await this.run(
                    vpy2,
                    ['-m', 'pip', 'install', '-r', reqFile, '-i', OFFICIAL_PYPI, '--trusted-host', 'pypi.org'],
                    { timeout: EXEC_OPTS.timeout }
                  )
                }
              } catch (err2) {
                const msg2 = err2 instanceof Error ? err2.message : String(err2)
                // Source is already updated — do NOT roll it back. Deps are
                // retried via repairEnv / pip manually.
                throw new UpdateDepsFailedAfterSourceOk(
                  `Source updated, but requirements install failed: ${msg2.slice(0, 400)}. ` +
                    `Use "Repair env" (or pip install -r ${reqFile}) to retry.`
                )
              }
            } else {
              throw new UpdateDepsFailedAfterSourceOk(
                `Source updated, but requirements install failed: ${msg.slice(0, 400)}. ` +
                  `Use "Repair env" (or pip install -r ${reqFile}) to retry.`
              )
            }
          }
          this.setStep('requirements', 'done', 'requirements installed', undefined, 'update.msgReqDone')
        }
        this.assertNotCancelled()

        // 5. optional torch
        if (opts.torchChannel) {
          this.setStep('torch', 'running', opts.torchChannel, undefined, 'update.msgTorchRun')
          const vpy3 = venvPython(config.venvPath || join(dirname(comfyDir), '.venv'))
          const index = resolveTorchIndex(opts.torchChannel)
          const official = officialTorchIndex(opts.torchChannel)
          const installTorchWith = async (idx: string): Promise<void> => {
            // uv-created venvs have no pip — seed it before the pip fallback.
            const { ensurePip } = await import('./env')
            await ensurePip(vpy3, (c, a, o) => this.run(c, a, o))
            await this.run(vpy3, pipArgs(['-m', 'pip', 'install', '--upgrade', 'torch', 'torchvision', 'torchaudio', '--index-url', idx]), {
              timeout: EXEC_OPTS.timeout
            })
          }
          try {
            await installTorchWith(index)
          } catch (err) {
            if (index === official) throw err
            this.log('torch', `index ${index} failed — retrying official`)
            await installTorchWith(official)
          }
          this.setStep('torch', 'done', opts.torchChannel, undefined, 'update.msgTorchDone')
        } else {
          this.setStep('torch', 'skipped', 'No torch channel requested')
        }
      }
      this.assertNotCancelled()

      // 6. verify
      this.setStep('verify', 'running', 'Running health check…', undefined, 'update.msgVerifyRun')
      try {
        const { doctorService } = await import('./doctor')
        const report = await doctorService.run(config.id)
        const fails = report.checks.filter((c) => c.severity === 'fail')
        if (fails.length) {
          this.log('verify', `doctor reported ${fails.length} failure(s): ${fails.map((f) => f.title).join(', ')}`)
          // Verify failures are warnings for an update — the source did change —
          // but catastrophic (missing main.py) is handled below.
          if (!existsSync(join(comfyDir, 'main.py'))) {
            throw new Error('main.py missing after update')
          }
          this.setStep('verify', 'done', `Doctor: ${fails.length} fail / ${report.summary.warn} warn`)
        } else {
          this.log('verify', `doctor pass=${report.summary.pass} warn=${report.summary.warn}`)
          this.setStep('verify', 'done', 'Health check passed', undefined, 'update.msgVerifyOk')
        }
      } catch (e) {
        if (!existsSync(join(comfyDir, 'main.py'))) throw e
        this.log('verify', `doctor unavailable: ${e instanceof Error ? e.message : String(e)}`)
        this.setStep('verify', 'done', 'Skipped (doctor unavailable)')
      }

      // 7. done — cleanup backup only when everything succeeded
      this.setStep('rollback', 'skipped', 'Not needed')
      if (backupPath && backupKind === 'files') {
        // keep git backups cheap (just a sha file); drop bulky file backups on success
        try {
          rmSync(backupPath, { recursive: true, force: true })
        } catch {
          /* keep if cleanup fails */
        }
      }
      if (opts.open && opts.open !== 'none') {
        try {
          const { instanceService } = await import('./instance')
          const info = await instanceService.launch(config.id, { open: opts.open })
          this.log('done', `relaunched at ${info.url || ''}`)
        } catch (e) {
          this.log('done', `relaunch failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      this.setStep('done', 'done', 'Update complete', undefined, 'update.msgDone')
      if (this.progress) {
        this.progress.status = 'done'
        this.progress.percent = 100
        this.progress.message = 'Update complete'
        this.progress.bytes = undefined
      }
      this.emitProgress('Update complete')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = this.cancelled || /cancelled/i.test(message)
      const noTreeChange = err instanceof UpdateAbortedNoTreeChange
      const depsFailed = err instanceof UpdateDepsFailedAfterSourceOk

      if (noTreeChange || depsFailed || !treeModified) {
        // Nothing of ours to undo (pull failed before touching the tree), OR
        // the source update itself succeeded and only deps failed — rolling
        // the source back would throw away a good update.
        this.setStep(
          'rollback',
          'skipped',
          depsFailed ? 'Not needed — source update succeeded, only deps failed' : 'Not needed — source tree was not modified',
          undefined,
          'update.msgRollbackSkip'
        )
        if (this.progress) {
          this.progress.status = 'failed'
          this.progress.error = cancelled ? 'Update cancelled' : message
          this.progress.message = this.progress.error
          this.progress.bytes = undefined
          const running = this.progress.steps.find((s) => s.status === 'running')
          if (running) {
            running.status = 'failed'
            running.detail = this.progress.error
            running.log.push('✗ ' + this.progress.error)
          }
          if (depsFailed) {
            this.log('done', 'Source kept — run Repair env to finish dependency install')
          }
        }
        this.emitProgress(message)
        return
      }

      // rollback
      this.setStep('rollback', 'running', 'Rolling back…', undefined, 'update.msgRollback')
      let rollbackOk = false
      try {
        if (backupPath && backupKind && existsSync(backupPath)) {
          rollbackOk = await this.performRollback(comfyDir, backupPath, backupKind)
        } else {
          this.log('rollback', 'No backup available — nothing to roll back')
          rollbackOk = true
        }
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr)
        this.log('rollback', `rollback failed: ${rbMsg}`)
        if (this.progress) {
          this.progress.status = 'failed'
          this.progress.error = `${cancelled ? 'Update cancelled' : message}; rollback FAILED (${rbMsg}) — backup at ${backupPath || 'n/a'}`
        }
        this.setStep('rollback', 'failed', rbMsg, undefined, 'update.msgRollbackFail', {
          path: backupPath || 'n/a'
        })
        this.emitProgress(this.progress?.error || message)
        return
      }
      if (rollbackOk) {
        this.setStep('rollback', 'done', 'Rolled back to previous version', undefined, 'update.msgRollback')
      } else {
        this.setStep('rollback', 'failed', 'Rollback incomplete', undefined, 'update.msgRollbackFail')
      }
      if (this.progress) {
        this.progress.status = 'failed'
        this.progress.error = cancelled ? 'Update cancelled' : message
        this.progress.message = this.progress.error
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

  /** Copy every non-preserved core entry from src into dest (recursive). */
  private copyCoreTree(src: string, dest: string): number {
    let count = 0
    for (const name of readdirSync(src)) {
      if (PRESERVE_ENTRIES.has(name)) continue
      if (name.startsWith('.cp-backup-')) continue
      if (name === '.git') continue
      const from = join(src, name)
      const to = join(dest, name)
      try {
        const st = statSync(from)
        if (st.isDirectory()) {
          cpSync(from, to, { recursive: true })
        } else {
          copyFileSync(from, to)
        }
        count++
      } catch {
        /* skip unreadable */
      }
    }
    return count
  }

  /**
   * Overlay a fresh GitHub archive onto comfyDir WITHOUT touching preserved
   * user dirs. Files present in the archive replace their local counterparts;
   * files absent from the archive are left alone (we never delete unknown user
   * files — same safety stance as the installer debris guard).
   */
  private async fetchAndOverlayZip(comfyDir: string): Promise<void> {
    const url = applyGithubMirror('https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip')
    if (!isSafeExternalUrl(url)) throw new Error('Blocked ComfyUI archive URL')
    const { session } = await import('electron')
    const tmpZip = join(dirname(comfyDir), `._comfyui_update_${Date.now()}.zip`)
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

    // Extract to a staging dir first, then overlay.
    const staging = join(dirname(comfyDir), `._comfyui_staging_${Date.now()}`)
    mkdirSync(staging, { recursive: true })
    try {
      const { safeUnzip } = await import('./zipSafe')
      await safeUnzip(tmpZip, staging)
      // flatten ComfyUI-master/
      let root = staging
      if (!existsSync(join(staging, 'main.py'))) {
        const entries = readdirSync(staging).filter((n) => !n.startsWith('.'))
        if (entries.length === 1) {
          const nested = join(staging, entries[0])
          if (statSync(nested).isDirectory() && existsSync(join(nested, 'main.py'))) {
            root = nested
          }
        }
      }
      if (!existsSync(join(root, 'main.py'))) throw new Error('Staged archive missing main.py')
      const overlaid = this.overlayTree(root, comfyDir)
      this.log('fetch', `overlaid ${overlaid} entries`)
      const sha = ''
      void sha
    } finally {
      try {
        rmSync(tmpZip, { force: true })
      } catch {
        /* ignore */
      }
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      this.setBytes(undefined)
    }
  }

  /**
   * Copy src → dest. PRESERVE_ENTRIES are skipped **only at the top level**
   * (`topLevel=true`) so nested core packages like `comfy/ldm/models/` are
   * still updated — those share a name with user-data dirs but are source code.
   */
  private overlayTree(src: string, dest: string, topLevel = true): number {
    let count = 0
    for (const name of readdirSync(src)) {
      if (topLevel && PRESERVE_ENTRIES.has(name)) continue
      const from = join(src, name)
      const to = join(dest, name)
      try {
        const st = statSync(from)
        if (st.isDirectory()) {
          // Recursively overlay directory contents; create if missing.
          if (!existsSync(to)) mkdirSync(to, { recursive: true })
          count += this.overlayTree(from, to, false)
        } else {
          copyFileSync(from, to)
          count++
        }
      } catch {
        /* skip unreadable */
      }
    }
    return count
  }

  /**
   * Rollback. Never goes through `this.run()` — a cancelled update must still
   * be able to restore the previous state (otherwise cancel leaves a half-
   * updated tree with no way back).
   */
  private async performRollback(comfyDir: string, backupPath: string, kind: 'git' | 'files'): Promise<boolean> {
    if (kind === 'git') {
      const shaFile = join(backupPath, 'HEAD')
      if (!existsSync(shaFile)) throw new Error('Backup HEAD missing')
      const sha = readFileSync(shaFile, 'utf-8').trim()
      const gitBin = resolveGitBinary()
      // Refuse `reset --hard` when TRACKED files differ from HEAD — those are
      // usually the user's local edits (the very reason a pull fails).
      // Untracked files (cache, our own artifacts) must NOT block rollback.
      const status = await this.runRaw(gitBin, ['-C', comfyDir, 'status', '--porcelain', '-uno'], {
        timeout: 15000
      }).catch(() => '')
      if (status.trim()) {
        this.log(
          'rollback',
          'Working tree has uncommitted changes to tracked files — refusing git reset --hard to avoid destroying local edits. ' +
            `Manual recovery: git -C ${comfyDir} reset --hard ${sha}`
        )
        throw new Error(
          `Rollback refused: uncommitted local changes in ${comfyDir}. ` +
            `Your edits were NOT destroyed. To force: git -C ${comfyDir} reset --hard ${sha}`
        )
      }
      await this.runRaw(gitBin, ['-C', comfyDir, 'reset', '--hard', sha], { timeout: 60000 })
      this.log('rollback', `git reset --hard ${sha}`)
      return true
    }
    // files: restore every entry from backup over the install (preserved dirs untouched
    // because they were never copied into the backup).
    const manifestFile = join(backupPath, 'manifest.json')
    if (!existsSync(manifestFile)) throw new Error('Backup manifest missing')
    for (const name of readdirSync(backupPath)) {
      if (name === 'manifest.json') continue
      const from = join(backupPath, name)
      const to = join(comfyDir, name)
      try {
        const st = statSync(from)
        if (st.isDirectory()) {
          rmSync(to, { recursive: true, force: true })
          cpSync(from, to, { recursive: true })
        } else {
          copyFileSync(from, to)
        }
      } catch (e) {
        throw new Error(`restore ${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.log('rollback', 'core files restored from backup')
    return true
  }
}

export const comfyUpdaterService = new ComfyUpdaterService()
