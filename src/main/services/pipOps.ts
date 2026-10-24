/**
 * Pip operations service (0.1.12) — the single gateway for installing Python
 * packages into an instance environment, used by:
 *  - the runtime error diagnosis card ("install missing package"),
 *  - curated fix recipes (triton-windows / sageattention wheel / onnx),
 *  - the node-pack dependency audit ("reinstall this pack's requirements").
 *
 * Design rules:
 * - uv first (`uv pip install --python …` works without pip in the venv),
 *   ensurePip + `python -m pip` fallback, mirror retry against official PyPI.
 * - One op per instance (busy guard) with full AbortError propagation.
 * - Streaming log + UpdateProgress-shaped events feed the shared pip-op modal.
 * - Recipe wheels are downloaded through the app proxy, size+sha256 verified
 *   BEFORE pip touches the file, then installed from the local path.
 */
import { EventEmitter } from 'events'
import { createHash, randomUUID } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PipOpResult, UpdateProgress, UpdateStep, UpdateStepId } from '@shared/types'
import { recipeById, recipeSupportsPlatform, type PipRecipe } from '@shared/pipRecipes'
import { isValidPipSpec, parsePipRequirement, normalizePipName } from '@shared/pipVersion'
import { loadInstanceConfigs, loadSettings } from './db'
import { resolveReadTarget } from './target'
import { resolveInstancePythonPath } from './instance'
import { bootstrapService } from './bootstrap'
import {
  installRequirements,
  ensurePip,
  throwingExec,
  runStreaming,
  outputIndicatesFailure
} from './env'
import { proxyFetch } from './proxy'

const OFFICIAL_PYPI = 'https://pypi.org/simple'
const PIP_TIMEOUT_MS = 30 * 60 * 1000
const WHEEL_TIMEOUT_MS = 10 * 60 * 1000
/** Hard ceiling for recipe downloads (MUST stay above the pinned wheel). */
const WHEEL_MAX_BYTES = 512 * 1024 * 1024

function codedError(code: string, message: string): Error {
  const e = new Error(message)
  ;(e as Error & { code?: string }).code = code
  return e
}

/**
 * Synchronously queryable mirror of running ops (0.1.12). nodePack's op
 * entries cross-check this so a pip install and a node-pack operation can
 * never mutate the same venv concurrently (pip has no cross-process lock).
 */
const activePipInstances = new Set<string>()
export function isPipOpActive(instanceId: string): boolean {
  return activePipInstances.has(instanceId)
}

interface OpContext {
  instanceId: string
  python: string
  uvPath?: string
  signal: AbortSignal
  log: (line: string) => void
  step: (
    id: UpdateStepId,
    status: 'running' | 'done' | 'skipped' | 'failed',
    message: string
  ) => void
}

interface ActiveOp {
  runId: string
  abort: AbortController
  progress: UpdateProgress
}

/**
 * Map a pip/uv output line to a human stage title (0.1.17 WP2-4).
 * Pure so the mapping is testable; returns null for lines that say nothing.
 */
export function pipStageFromLine(line: string): string | null {
  const s = String(line || '')
  if (/Collecting |Downloading |Fetching /i.test(s)) return 'Resolving and downloading packages…'
  if (/Installing collected packages|Prepared \d+ packages|Installed \d+ package/i.test(s)) {
    return 'Installing built packages…'
  }
  if (/Building wheel|Successfully built/i.test(s)) return 'Building wheels…'
  if (/Successfully installed/i.test(s)) return 'Finalizing installation…'
  return null
}

/** Extract the distribution name from an installed wheel filename. */
export function wheelPackageName(urlOrPath: string): string {
  const base =
    String(urlOrPath || '')
      .split(/[\\/]/)
      .pop() || ''
  const clean = decodeURIComponent(base).replace(/\.whl$/i, '')
  const name = clean.split('-')[0] || ''
  return normalizePipName(name)
}

export class PipOpsService extends EventEmitter {
  private ops = new Map<string, ActiveOp>()
  /**
   * Last finished op per instance (0.1.13). Kept until the NEXT op starts for
   * the same instance. Without this, `instance.pipStatus` returned null the
   * moment an op settled — the renderer's post-op resync then wiped the
   * just-received done state and the modal fell back to a 0% empty shell
   * ("installed but never shows completed").
   */
  private finished = new Map<string, { progress: UpdateProgress; finishedAt: number }>()

  busy(instanceId: string): boolean {
    return this.ops.has(instanceId)
  }

  getProgress(instanceId?: string): UpdateProgress | null {
    if (!instanceId) return null
    const active = this.ops.get(instanceId)
    if (active) return active.progress
    return this.finished.get(instanceId)?.progress || null
  }

  cancel(instanceId: string): boolean {
    const op = this.ops.get(instanceId)
    if (!op) return false
    op.abort.abort()
    return true
  }

  // ---------------------------------------------------------------- public ops

  /** Install one validated pip spec (name / name==x / name>=x,<y). */
  async installSpec(instanceId: string, spec: string): Promise<PipOpResult> {
    const s = String(spec || '').trim()
    if (!isValidPipSpec(s)) {
      throw codedError(
        'INVALID_SPEC',
        `Not a valid package spec: "${s.slice(0, 60)}" — use name / name==version (URLs are not allowed)`
      )
    }
    return this.execute(instanceId, [s], 'Installing package…', async (ctx) => {
      await ctx.resolve()
      // No wheel download in a plain spec install — close the step honestly
      // instead of leaving it pending forever in the modal (0.1.13).
      ctx.step('download', 'skipped', 'No download step')
      ctx.step('requirements', 'running', `Installing ${s}…`)
      await this.pipInstallTargets(ctx, [s])
      ctx.step('requirements', 'done', `pip install ${s} finished`)
      return this.verifyAndFinalize(ctx, [s])
    })
  }

  /** Apply a curated recipe (ordered steps; wheels hash-verified). */
  async installRecipe(instanceId: string, recipeId: string): Promise<PipOpResult> {
    const recipe = recipeById(recipeId)
    if (!recipe) throw codedError('RECIPE_NOT_FOUND', `Unknown recipe: ${recipeId}`)
    if (!recipeSupportsPlatform(recipe)) {
      throw codedError(
        'RECIPE_PLATFORM',
        `Recipe "${recipe.id}" is only verified on ${(recipe.platform || []).join(', ')}`
      )
    }
    const requested = recipe.steps.map((st) => st.spec || st.url || '')
    return this.execute(instanceId, requested, 'Applying fix recipe…', async (ctx) => {
      await ctx.resolve()
      // Pip-only recipes never download a wheel — mark the step skipped so the
      // modal shows a clean five-step flow (0.1.13).
      if (!recipe.steps.some((st) => st.kind === 'wheel')) {
        ctx.step('download', 'skipped', 'No download step')
      }
      let verifiedNames: string[] = []
      for (const [i, st] of recipe.steps.entries()) {
        if (st.kind === 'pip' && st.spec) {
          ctx.step(
            'requirements',
            'running',
            `Step ${i + 1}/${recipe.steps.length}: pip install ${st.spec}`
          )
          await this.pipInstallTargets(ctx, [st.spec])
          verifiedNames = verifiedNames.concat(await this.verifyPackages(ctx, [st.spec]))
        } else if (st.kind === 'wheel' && st.url) {
          const file = await this.downloadWheel(ctx, st.url, st.sha256, st.sizeBytes, recipe)
          try {
            ctx.step(
              'requirements',
              'running',
              `Step ${i + 1}/${recipe.steps.length}: install verified wheel`
            )
            await this.pipInstallTargets(ctx, [file])
            const name = wheelPackageName(st.url)
            if (name) verifiedNames = verifiedNames.concat(await this.verifyPackages(ctx, [name]))
          } finally {
            try {
              rmSync(file, { force: true })
              rmSync(join(file, '..'), { recursive: true, force: true })
            } catch {
              /* temp cleanup is best-effort */
            }
          }
        }
      }
      ctx.step('requirements', 'done', 'Recipe steps finished')
      ctx.step('verify', 'running', 'Verifying installed packages…')
      ctx.step('verify', 'done', verifiedNames.length ? verifiedNames.join(', ') : 'done')
      ctx.step('done', 'done', 'Done')
      return { installed: [...new Set(verifiedNames)], warning: undefined as string | undefined }
    })
  }

  /** Reinstall a pack's requirements.txt (dependency-audit action). */
  async installRequirementsFor(
    instanceId: string | undefined,
    reqFile: string,
    label?: string
  ): Promise<PipOpResult> {
    const target = this.resolveInstanceId(instanceId)
    const settings = loadSettings()
    return this.execute(
      target,
      [`-r ${label || reqFile}`],
      'Installing pack dependencies…',
      async (ctx) => {
        await ctx.resolve()
        ctx.step('download', 'skipped', 'No download step')
        ctx.step('requirements', 'running', `Installing requirements for ${label || reqFile}…`)
        // 0.1.17 (WP2-4): pip output is not a progress source. The line-count
        // fraction (pipLines / 40) was invented progress — the step is now
        // genuinely indeterminate and only the stage text changes.
        await installRequirements(ctx.python, reqFile, throwingExec, {
          uvPath: ctx.uvPath,
          pipIndex: String(settings.pipIndex || '').trim(),
          onLine: (line) => {
            ctx.log(line)
            const stage = pipStageFromLine(line)
            if (stage) ctx.step('requirements', 'running', stage)
          },
          signal: ctx.signal
        })
        ctx.step('requirements', 'done', 'Dependencies installed')
        return {
          installed: [],
          warning: 'requirements.txt installed — verify with the dependency audit'
        }
      }
    )
  }

  // ---------------------------------------------------------------- internals

  private resolveInstanceId(instanceId?: string): string {
    const configs = loadInstanceConfigs()
    if (instanceId) {
      const cfg = configs.find((c) => c.id === instanceId)
      if (!cfg) throw codedError('INSTANCE_NOT_FOUND', `Instance not found: ${instanceId}`)
      return cfg.id
    }
    const first = resolveReadTarget(undefined)
    if (!first) throw codedError('INSTANCE_NOT_FOUND', 'No instance configured')
    return first.id
  }

  private initProgress(instanceId: string, label: string): ActiveOp {
    // A new op supersedes the previous finished snapshot for this instance.
    this.finished.delete(instanceId)
    const runId = randomUUID()
    const steps: UpdateStep[] = (
      [
        ['preflight', 'Resolve environment'],
        ['download', 'Download'],
        ['requirements', 'Install packages'],
        ['verify', 'Verify'],
        ['done', 'Done']
      ] as Array<[UpdateStepId, string]>
    ).map(([id, title]) => ({ id, title, status: 'pending', detail: '', log: [] }))
    const progress: UpdateProgress = {
      runId,
      instanceId,
      step: 'preflight',
      status: 'running',
      steps,
      message: label,
      percent: 0
    }
    const abort = new AbortController()
    const op: ActiveOp = { runId, abort, progress }
    this.ops.set(instanceId, op)
    return op
  }

  /**
   * Weighted completion across the five pip-op steps. A running step counts
   * its inside-step fraction so long installs visibly move (0.1.13). Mirrors
   * nodePack's computePercent/setStepFraction behaviour.
   */
  private computePercent(p: UpdateProgress): number {
    let sum = 0
    for (const x of p.steps) {
      if (x.status === 'done' || x.status === 'skipped') sum += 1
      else if (x.status === 'running') sum += Math.max(0, Math.min(1, x.progress ?? 0))
    }
    return Math.max(0, Math.min(100, Math.round((sum / Math.max(1, p.steps.length)) * 100)))
  }

  private emitStep(
    op: ActiveOp,
    step: UpdateStepId,
    status: 'running' | 'done' | 'skipped' | 'failed' | 'cancelled',
    message: string
  ): void {
    const s = op.progress.steps.find((x) => x.id === step)
    if (s) {
      s.status = status
      if (message) s.detail = message
    }
    op.progress.step = step
    op.progress.message = message
    if (status === 'failed') op.progress.status = 'failed'
    else if (status === 'cancelled') op.progress.status = 'cancelled'
    else if (status === 'done' && step === 'done') op.progress.status = 'done'
    else op.progress.status = 'running'
    // Surface the failure text on the progress payload so the modal error
    // block (and the finished snapshot) always carry a real reason (0.1.13).
    if (op.progress.status === 'failed') op.progress.error = message
    else if (op.progress.status === 'running') op.progress.error = undefined
    if (op.progress.status === 'done') {
      // Terminal success closes every untouched step so the bar reaches 100%.
      // (0.1.13 — previously preflight stayed 'running', download stayed
      // 'pending' and a successful install ended at a bogus 60%.)
      for (const x of op.progress.steps) {
        if (x.status !== 'done' && x.status !== 'skipped') x.status = 'skipped'
      }
      op.progress.percent = 100
    } else {
      // Recompute while running; on failed/cancelled this keeps the bar AT
      // its last value (computePercent counts fractions, never rolls back).
      const next = this.computePercent(op.progress)
      op.progress.percent = Math.max(op.progress.percent, next)
    }
    this.emit('progress', { ...op.progress, steps: op.progress.steps.map((x) => ({ ...x })) })
  }

  private emitLog(op: ActiveOp, instanceId: string, line: string): void {
    const s = op.progress.steps.find((x) => x.id === op.progress.step)
    if (s) {
      s.log.push(line)
      if (s.log.length > 400) s.log.splice(0, s.log.length - 400)
    }
    this.emit('log', { runId: op.runId, instanceId, line, ts: Date.now() })
  }

  private async execute(
    instanceId: string,
    requested: string[],
    label: string,
    task: (
      ctx: OpContext & { resolve: () => Promise<void> }
    ) => Promise<{ installed: string[]; warning?: string }>
  ): Promise<PipOpResult> {
    if (this.ops.has(instanceId)) {
      throw codedError('OP_BUSY', 'Another package operation is already running for this instance')
    }
    const op = this.initProgress(instanceId, label)
    activePipInstances.add(instanceId)
    // Cross-guard (0.1.12): a node-pack op (install/update/uninstall, which may
    // itself run pip) mutates the same venv — never overlap. The busy slot is
    // claimed FIRST (synchronously) so concurrent callers still see OP_BUSY;
    // a failed guard releases it before doing any work.
    try {
      const { nodePackService } = await import('./nodePack')
      // Activity evidence (armed controller / running batch) OR a running
      // progress snapshot — either proves a node op is really in flight.
      // A stale 'running' snapshot without an active controller must not lock
      // dependency installs forever (0.1.13).
      const nodeOp = nodePackService.getOpProgress(instanceId)
      if (nodePackService.isOpActive(instanceId) || (nodeOp && nodeOp.status === 'running')) {
        throw codedError(
          'OP_BUSY',
          'A node-pack operation is running for this instance — wait for it to finish'
        )
      }
    } catch (e) {
      // Re-throw real OP_BUSY (releasing the slot); a module-load failure only
      // means the guard is unavailable (e.g. unit tests stubbing modules).
      if ((e as { code?: string }).code === 'OP_BUSY') {
        this.ops.delete(instanceId)
        activePipInstances.delete(instanceId)
        throw e
      }
    }
    let uvPath: string | undefined
    let resolved = false
    let pythonPath = ''
    const ctx: OpContext & { resolve: () => Promise<void> } = {
      instanceId,
      get python() {
        return pythonPath
      },
      get uvPath() {
        return uvPath
      },
      signal: op.abort.signal,
      log: (line) => this.emitLog(op, instanceId, line),
      step: (id, status, message) => this.emitStep(op, id, status, message),
      resolve: async () => {
        if (resolved) return
        const cfg = loadInstanceConfigs().find((c) => c.id === instanceId)
        if (!cfg) throw codedError('INSTANCE_NOT_FOUND', `Instance not found: ${instanceId}`)
        pythonPath = resolveInstancePythonPath(cfg)
        this.emitStep(op, 'preflight', 'running', `Environment: ${pythonPath}`)
        try {
          const bootstrap = await bootstrapService.ensure({
            kinds: ['uv'],
            downloadIfMissing: false
          })
          uvPath = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)?.path
        } catch {
          uvPath = undefined
        }
        this.emitLog(op, instanceId, uvPath ? `uv: ${uvPath}` : 'uv not available — pip fallback')
        // Close preflight once resolved — the old code left it 'running'
        // forever, so the modal always showed a spinning first step (0.1.13).
        this.emitStep(
          op,
          'preflight',
          'done',
          uvPath ? `Environment: ${pythonPath} (uv)` : `Environment: ${pythonPath} (pip)`
        )
        resolved = true
      }
    } as OpContext & { resolve: () => Promise<void> }

    this.emit('progress', { ...op.progress, steps: op.progress.steps.map((x) => ({ ...x })) })
    try {
      const result = await task(ctx)
      this.emitStep(op, 'done', 'done', 'Done')
      return {
        ok: true,
        instanceId,
        requested,
        installed: result.installed,
        warning: result.warning
      }
    } catch (err) {
      if (op.abort.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        this.emitStep(op, 'done', 'cancelled', 'Cancelled')
        return { ok: false, instanceId, requested, installed: [], cancelled: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.emitStep(op, 'done', 'failed', msg.slice(0, 300))
      return { ok: false, instanceId, requested, installed: [], error: msg.slice(0, 500) }
    } finally {
      // Keep the final progress as a per-instance snapshot (deep copy so later
      // mutations cannot leak into it). `instance.pipStatus` keeps answering
      // with the terminal state until the next op starts — the renderer's
      // post-op resync must never wipe a just-finished "done" into a 0% shell.
      this.finished.set(instanceId, {
        progress: {
          ...op.progress,
          steps: op.progress.steps.map((x) => ({ ...x, log: [...x.log] }))
        },
        finishedAt: Date.now()
      })
      this.ops.delete(instanceId)
      activePipInstances.delete(instanceId)
    }
  }

  private async verifyPackages(ctx: OpContext, specsOrNames: string[]): Promise<string[]> {
    const names = specsOrNames
      .map((s) => parsePipRequirement(s)?.name || normalizePipName(s))
      .filter(Boolean)
    const found: string[] = []
    for (const name of names) {
      try {
        const out = ctx.uvPath
          ? await throwingExec(ctx.uvPath, ['pip', 'show', '--python', ctx.python, name], {
              timeout: 30000
            })
          : await throwingExec(ctx.python, ['-m', 'pip', 'show', name], { timeout: 30000 })
        if (/\bName:\s*\S+/i.test(out)) found.push(name)
      } catch {
        /* not listed under this name */
      }
    }
    return found
  }

  private async verifyAndFinalize(
    ctx: OpContext,
    specs: string[]
  ): Promise<{
    installed: string[]
    warning?: string
  }> {
    ctx.step('verify', 'running', 'Verifying installed packages…')
    const installed = await this.verifyPackages(ctx, specs)
    const missing = specs.filter(
      (s) => !installed.includes(parsePipRequirement(s)?.name || normalizePipName(s))
    )
    if (installed.length) {
      ctx.step('verify', 'done', `Verified: ${installed.join(', ')}`)
    } else {
      ctx.step('verify', 'done', 'Install command finished (pip show listed nothing)')
    }
    return {
      installed,
      warning: missing.length
        ? `installed, but pip show did not list: ${missing.join(', ')}`
        : undefined
    }
  }

  /** uv-first install of arbitrary targets (specs or local wheel paths) with mirror retry. */
  private async pipInstallTargets(ctx: OpContext, targets: string[]): Promise<void> {
    const pipIndex = String(loadSettings().pipIndex || '').trim()
    const run = (c: string, a: string[], timeout: number): Promise<string> =>
      runStreaming(
        c,
        a,
        {
          timeout,
          signal: ctx.signal,
          onLine: (line) => {
            ctx.log(line)
            // 0.1.17 (WP2-4): no invented fraction — the stage text is the
            // honest signal while pip works (see pipStageFromLine).
            const stage = pipStageFromLine(line)
            if (stage) ctx.step('requirements', 'running', stage)
          }
        },
        throwingExec
      ).then((out) => {
        if (outputIndicatesFailure(out)) {
          throw new Error(out.slice(0, 400))
        }
        return out
      })

    const tryUv = async (index?: string): Promise<void> => {
      const args = ['pip', 'install', '--python', ctx.python, ...targets]
      if (index) {
        args.push('--index-url', index)
        if (index !== OFFICIAL_PYPI) args.push('--extra-index-url', OFFICIAL_PYPI)
      }
      await run(ctx.uvPath as string, args, PIP_TIMEOUT_MS)
    }
    const tryPip = async (index?: string): Promise<void> => {
      await ensurePip(ctx.python, (c, a, o) => throwingExec(c, a, o))
      const args = ['-m', 'pip', 'install', ...targets]
      if (index) {
        args.push('-i', index)
        try {
          args.push('--trusted-host', new URL(index).hostname)
        } catch {
          /* skip */
        }
        if (index !== OFFICIAL_PYPI) args.push('--extra-index-url', OFFICIAL_PYPI)
      }
      await run(ctx.python, args, PIP_TIMEOUT_MS)
    }
    const once = async (index?: string): Promise<void> => {
      if (ctx.uvPath) await tryUv(index)
      else await tryPip(index)
    }

    try {
      await once(pipIndex || undefined)
    } catch (err) {
      if (ctx.signal.aborted) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (pipIndex && pipIndex !== OFFICIAL_PYPI) {
        ctx.log(`index ${pipIndex} failed — retrying official PyPI`)
        try {
          await once(OFFICIAL_PYPI)
          return
        } catch (err2) {
          if (ctx.signal.aborted) throw err2
          const msg2 = err2 instanceof Error ? err2.message : String(err2)
          throw new Error(`install failed (mirror and official): ${msg2.slice(0, 400)}`)
        }
      }
      throw new Error(`install failed: ${msg.slice(0, 400)}`)
    }
  }

  /** Download a recipe wheel via the app proxy; verify size + sha256 BEFORE use. */
  private async downloadWheel(
    ctx: OpContext,
    url: string,
    sha256: string | undefined,
    sizeBytes: number | undefined,
    recipe: PipRecipe
  ): Promise<string> {
    if (!/^https:\/\//i.test(url)) throw new Error('Recipe wheel URL must be https')
    ctx.step('download', 'running', 'Downloading wheel…')
    ctx.log(`recipe ${recipe.id}: downloading ${url}`)
    const res = await proxyFetch(url, { timeoutMs: WHEEL_TIMEOUT_MS, signal: ctx.signal })
    if (!res.ok) throw new Error(`wheel download failed: HTTP ${res.status}`)
    const lenHeader = Number(res.headers.get('content-length') || 0)
    if (lenHeader && lenHeader > WHEEL_MAX_BYTES) {
      throw new Error(`wheel too large: ${lenHeader} bytes`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > WHEEL_MAX_BYTES) throw new Error(`wheel too large: ${buf.length} bytes`)
    if (sizeBytes && buf.length !== sizeBytes) {
      throw new Error(`wheel size mismatch: expected ${sizeBytes}, got ${buf.length}`)
    }
    if (sha256) {
      const got = createHash('sha256').update(buf).digest('hex')
      if (got !== sha256.toLowerCase()) {
        throw new Error(`wheel sha256 mismatch (download corrupt or changed): ${got}`)
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'comfypilot-wheel-'))
    const name = decodeURIComponent(url.split('/').pop() || 'package.whl').replace(/[^\w.+-]/g, '_')
    const file = join(dir, name)
    writeFileSync(file, buf)
    ctx.log(`wheel verified: ${buf.length} bytes${sha256 ? ', sha256 ok' : ''}`)
    return file
  }
}

export const pipOpsService = new PipOpsService()
