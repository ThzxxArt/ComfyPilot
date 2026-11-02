import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  writeFileSync,
  unlinkSync
} from 'fs'
import { join, dirname, basename } from 'path'
import { createHash } from 'crypto'
import type { NodePackRecord, UpdateStepId } from '@shared/types'
import { REGISTRY_API } from '@shared/constants'
import { deleteNodePack, listNodePacks, loadSettings, upsertNodePack } from '../db'
import { isPathInside, normalizePathEverySegment } from '../security'
import { assertSafeGitUrl, applyGithubMirror, assertSafeBranch } from '../installer'
import { comfyChildEnv } from '../childEnv'
import { isPipOpActive, pipStageFromLine } from '../pipOps'
import type { NodePackHost } from './host'
import type {
  AfterInstallExtra,
  InstallInnerOptions,
  InstallInternalOptions,
  InstallOptions
} from './types'
import {
  codedError,
  detectCustomNodesRoot,
  execFileAsync,
  flattenSingleNestedDir,
  gitAvailable,
  gitRevOf,
  isAbortError,
  isStrictInside,
  moveDirIntoPlace,
  nodeTempPath,
  parseRequirementNames,
  resolveGitBinary,
  resolveInstancePython,
  resolveNestedPackDir,
  resolveRepoUrl,
  sanitizeInstallName,
  withAbort
} from './common'
import { collectIssues, readPackMeta } from './list'

/**
 * Gate remote installs against the user's security / network settings.
 * Throws an Error with a machine-readable `code` so the renderer can show a
 * localized, actionable prompt ("go to Settings → X and turn it on") instead
 * of a silent skip or a raw English stack line.
 */
export function assertInstallAllowed(
  this: NodePackHost,
  source: 'registry' | 'git' | 'manager'
): void {
  const settings = loadSettings()
  const blocked = (code: string, fallback: string): Error => {
    const e = new Error(fallback)
    ;(e as Error & { code?: string }).code = code
    return e
  }
  if (settings.networkMode === 'offline') {
    throw blocked('SETTING_OFFLINE', 'Offline mode forbids remote installs')
  }
  const level = settings.securityLevel
  // strong: forbid ALL remote node installs (git + registry + manager)
  if (level === 'strong') {
    throw blocked(
      'SETTING_SECURITY_STRONG',
      `security_level=strong forbids ${source} node installs`
    )
  }
  if (source === 'git') {
    // normal: git requires the explicit allowGitUrlInstall opt-in
    // normal-/weak: git is allowed without the extra gate
    if (level === 'normal' && !settings.allowGitUrlInstall) {
      throw blocked(
        'SETTING_GIT_INSTALL',
        'Git URL install is disabled (allow_git_url_install=false)'
      )
    }
  }
  // registry/manager allowed at normal / normal- / weak
}

export async function install(
  this: NodePackHost,
  opts: InstallOptions,
  internal?: InstallInternalOptions
): Promise<NodePackRecord> {
  this.assertInstallAllowed(opts.source)
  const guardKey = opts.instanceId || 'default'
  // Exclusivity: a standalone install must not hijack/abort a running batch
  // (registry updates call back in with reuseStream and are exempt).
  if (!internal?.reuseStream && (this.opBatches.has(guardKey) || this.opAborts.has(guardKey))) {
    throw codedError('OP_BUSY', 'Another operation is already running for this instance')
  }
  // Cross-guard (0.1.12): a dependency install (diagnosis card / audit) owns
  // the same venv — never overlap node-pack ops with it.
  if (!internal?.reuseStream && isPipOpActive(guardKey)) {
    throw codedError(
      'OP_BUSY',
      'A dependency install is running for this instance — wait for it to finish'
    )
  }
  this.emitInstallProgress({
    phase: 'start',
    packName: opts.id,
    instanceId: opts.instanceId,
    op: 'install',
    message: `Installing ${opts.id}…`
  })
  // Fresh op-progress stream for the shared modal (unless the caller owns it).
  if (!internal?.reuseStream) {
    this.opProgressMap.delete(opts.instanceId || 'default')
  }
  // Pick the first step by source so the modal never shows "Download"
  // when the user actually asked for a git install.
  const firstStep: UpdateStepId =
    opts.source === 'git' || opts.source === 'manager' ? 'clone' : 'download'
  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: firstStep,
    status: 'running',
    message: firstStep === 'clone' ? `Cloning ${opts.id}…` : `Downloading ${opts.id}…`,
    packName: opts.id
  })
  // Reuse the outer op's controller when this install is the middle of an
  // update (reuseStream) — arming a fresh one would abort the outer signal.
  const signal = internal?.signal || this.beginOpAbort(opts.instanceId)
  try {
    const rec = await this.installInner({ ...opts, signal })
    // Must emit 'done' — the UI hangs on the spinner/banner until it arrives.
    this.emitInstallProgress({
      phase: 'done',
      packName: rec.name || opts.id,
      instanceId: opts.instanceId,
      op: 'install',
      message: `Installed ${rec.name || opts.id}`
    })
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'done',
      status: 'done',
      message: `Installed ${rec.name || opts.id}`
    })
    return rec
  } catch (e) {
    // Only treat as cancelled when the error itself is an AbortError —
    // a timeout must not mask the real error.
    const cancelled = isAbortError(e)
    this.emitInstallProgress({
      phase: 'error',
      packName: opts.id,
      instanceId: opts.instanceId,
      op: 'install',
      message: e instanceof Error ? e.message : String(e)
    })
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'done',
      status: cancelled ? 'cancelled' : 'failed',
      message: e instanceof Error ? e.message : String(e)
    })
    throw cancelled ? codedError('OP_CANCELLED', 'Install cancelled') : e
  } finally {
    if (!internal?.signal) this.endOpAbort(opts.instanceId)
  }
}

export async function installInner(
  this: NodePackHost,
  opts: InstallInnerOptions
): Promise<NodePackRecord> {
  // PLAN: 安装前自动快照
  try {
    this.createSnapshot(`auto-pre-install-${sanitizeInstallName(opts.id)}`, opts.instanceId)
  } catch {
    /* snapshot is best-effort */
  }
  const root = detectCustomNodesRoot(opts.instanceId)
  if (!root) throw new Error('custom_nodes root not found — add a ComfyUI instance first')
  mkdirSync(root, { recursive: true })

  if (opts.source === 'git' || opts.source === 'manager') {
    let url = (opts.url || '').trim()
    if (!url && opts.source === 'manager') {
      // Fallback: look up the pack in the Manager channel list.
      try {
        const list = await this.managerChannelList()
        const hit = list.find(
          (n) => n.id === opts.id || n.name === opts.id || n.displayName === opts.id
        )
        url = (hit?.repository || '').trim()
      } catch {
        /* managerChannelList is best-effort — fall through to error below */
      }
    }
    if (!url) {
      if (opts.source === 'manager') throw new Error('Manager pack has no repository URL')
      url = opts.id
    }
    const safeUrl = assertSafeGitUrl(applyGithubMirror(url))
    const destName = sanitizeInstallName(
      safeUrl
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') || `pack-${Date.now()}`
    )
    const dest = join(root, normalizePathEverySegment(destName))
    // Hard guard: dest must be a real descendant of root — never root itself.
    if (!isStrictInside(dest, root)) {
      throw new Error(`Refusing to install into unsafe destination: ${dest}`)
    }
    const gitBin = resolveGitBinary()
    // Clone into a throwaway sibling, then rename — a failed clone can only
    // ever remove OUR temp dir, never a pre-existing user directory.
    const tmpDest = await nodeTempPath('clone_tmp_', root)
    if (isPathInside(tmpDest, root) && !isStrictInside(tmpDest, root)) {
      throw new Error('Refusing unsafe temp clone path')
    }
    // Version pin: clone the default branch shallow first, then check out the
    // requested tag/ref inside the temp dir so a failed checkout never touches
    // `dest`. Shallow clone hides most tags, so fetch the ref explicitly.
    const pinned = (opts.version || '').trim()
    // 0.1.17 (WP10): only claim the requested version was installed when the
    // checkout actually landed. Checkout failure is non-fatal by design, but
    // recording `pinnedVersion` anyway made the UI badge lie forever.
    let pinnedApplied = false
    const args = ['clone', '--depth', '1']
    const safeBranch = assertSafeBranch(opts.branch || '')
    if (safeBranch) args.push('--branch', safeBranch)
    args.push(safeUrl, tmpDest)
    try {
      await execFileAsync(gitBin, args, {
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024,
        env: comfyChildEnv(loadSettings()),
        signal: opts.signal
      })
      if (pinned) {
        const safeRef = assertSafeBranch(pinned)
        // Shallow clone hides tags — fetch the tag ref explicitly first.
        await execFileAsync(
          gitBin,
          [
            '-C',
            tmpDest,
            'fetch',
            '--depth',
            '1',
            'origin',
            `refs/tags/${safeRef}:refs/tags/${safeRef}`
          ],
          { timeout: 60000, env: comfyChildEnv(loadSettings()), signal: opts.signal }
        ).catch(() => undefined)
        // tags/<v> first (exact release tag), then the bare ref (branch / sha).
        // Checkout failure is NON-FATAL — fall through to default branch.
        let checkedOut = false
        try {
          await execFileAsync(gitBin, ['-C', tmpDest, 'checkout', `tags/${safeRef}`], {
            timeout: 30000,
            env: comfyChildEnv(loadSettings()),
            signal: opts.signal
          })
          checkedOut = true
        } catch {
          try {
            await execFileAsync(gitBin, ['-C', tmpDest, 'checkout', safeRef], {
              timeout: 30000,
              env: comfyChildEnv(loadSettings()),
              signal: opts.signal
            })
            checkedOut = true
          } catch {
            this.opLog?.(`tag/ref "${pinned}" not found — using default branch`, opts.instanceId)
          }
        }
        if (!checkedOut) {
          this.opLog?.(`Continuing with default branch (wanted ${pinned})`, opts.instanceId)
        }
        pinnedApplied = checkedOut
      }
      // Atomic-ish publish: only now do we touch `dest`. A cancellation that
      // arrived during tag fetch/checkout must not publish a ghost package.
      if (opts.signal?.aborted) {
        rmSync(tmpDest, { recursive: true, force: true })
        const abortErr = new Error('aborted')
        abortErr.name = 'AbortError'
        throw abortErr
      }
      if (existsSync(dest)) {
        rmSync(tmpDest, { recursive: true, force: true })
        throw new Error(`Destination already exists: ${destName}`)
      }
      moveDirIntoPlace(tmpDest, dest)
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'clone',
        status: 'done',
        message: pinned ? `Cloned @ ${pinned}` : 'Cloned'
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'download',
        status: 'skipped',
        message: 'Used git clone'
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'unpack',
        status: 'skipped',
        message: 'Used git clone'
      })
    } catch (e) {
      // Clean ONLY the temp clone we created — never a pre-existing dest.
      try {
        if (existsSync(tmpDest) && /(?:clone_tmp_|unzip_tmp_)/.test(tmpDest)) {
          rmSync(tmpDest, { recursive: true, force: true })
        }
      } catch {
        /* cleanup is best-effort */
      }
      // error is reported by the install() wrapper
      throw e
    }
    return await this.afterInstall(
      resolveNestedPackDir(dest),
      opts.source,
      opts.registryId ?? opts.id,
      opts.instanceId,
      {
        pinnedVersion: pinnedApplied ? pinned : undefined,
        installNote:
          pinned && !pinnedApplied
            ? `requested ${pinned} unavailable — installed the default branch`
            : undefined,
        signal: opts.signal
      }
    )
  }

  // ---- registry install: git clone preferred, zip fallback ----

  // Known repository from search results (passed by the renderer).
  let repoUrl = (opts.repository || '').trim()

  // session is needed by both the /install API call and the zip download.
  const { session } = await import('electron')

  // If we don't have a repo URL yet, try the /install API for it.
  let downloadUrl: string | undefined
  // 0.1.17 (WP10): a version-specific `/install/<v>` response really is that
  // version; a constructed `archive/refs/heads/main.zip` fallback is not.
  let versionedArchive = false
  if (!repoUrl || !(await gitAvailable())) {
    const versionPart = opts.version ? `/${encodeURIComponent(opts.version)}` : ''
    const apiUrl = `${REGISTRY_API}/nodes/${encodeURIComponent(opts.id)}/install${versionPart}`
    try {
      const res = await session.defaultSession.fetch(apiUrl, {
        headers: { 'User-Agent': 'ComfyPilot/0.1' },
        signal: withAbort(30000, opts.signal)
      })
      if (res.ok) {
        const data = (await res.json()) as {
          url?: string
          downloadUrl?: string
          status?: string
          repository?: string
        }
        if (data.status === 'banned') throw new Error('Node pack is banned on Registry')
        downloadUrl = data.url || data.downloadUrl
        versionedArchive = Boolean(opts.version && downloadUrl)
        if (!repoUrl) repoUrl = (data.repository || '').trim()
      } else if (res.status !== 401 && res.status !== 403) {
        throw new Error(`Registry install failed: HTTP ${res.status}`)
      }
    } catch (e) {
      if (!repoUrl && !downloadUrl) throw e
      // We have a repo URL — the API is only needed for zip download.
    }
  }

  // Resolve the full repo URL (handles archive / codeload / index lookup).
  const resolvedRepo = await resolveRepoUrl(repoUrl, downloadUrl || '', opts.id)
  const hasGit = await gitAvailable()

  // GIT CLONE PREFERRED — only fall back to zip when git is unavailable.
  if (resolvedRepo && hasGit) {
    try {
      // Mark the zip-only steps as skipped so the modal shows "Git clone"
      // instead of a phantom "Download / Unpack".
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'download',
        status: 'skipped',
        message: 'Using git clone'
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'unpack',
        status: 'skipped',
        message: 'Using git clone'
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'clone',
        status: 'running',
        message: `Cloning ${resolvedRepo}…`
      })
      // Call installInner directly — NOT install() — because install() would
      // re-check assertInstallAllowed('git') which is gated by
      // allowGitUrlInstall (default false). We already passed the registry
      // gate; the internal git clone is just a transport choice.
      const rec = await this.installInner({
        id: resolvedRepo,
        source: 'git',
        url: resolvedRepo,
        version: opts.version,
        registryId: opts.id,
        instanceId: opts.instanceId,
        signal: opts.signal
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'clone',
        status: 'done',
        message: 'Cloned'
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'verify',
        status: 'done',
        message: 'Installed via git'
      })
      return rec
    } catch (e) {
      // A cancellation must never be downgraded to a git failure (which
      // would silently retry via zip and "succeed" after the user cancelled).
      if (isAbortError(e)) throw e
      // Git clone failed — fall back to zip. This is NOT a terminal failure;
      // do NOT emit status:'failed' or the UI modal closes prematurely.
      const msg = e instanceof Error ? e.message : String(e)
      this.opLog?.(`git clone failed (${msg}) — falling back to zip`)
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'clone',
        status: 'skipped',
        message: `Git clone failed (${msg}) — using zip`
      })
    }
  } else if (!resolvedRepo) {
    this.opLog?.('Registry did not expose a repository URL — using zip download')
  } else {
    this.opLog?.('git is not available — using zip download')
  }

  // ---- zip download fallback (no git, or git clone failed) ----
  // When the /install API didn't give us a downloadUrl (401), construct a
  // GitHub archive URL from the known repository.
  if (!downloadUrl && resolvedRepo) {
    const ghMatch = resolvedRepo.match(/github\.com[/:]([^/]+)\/([^/.]+)/i)
    if (ghMatch) {
      downloadUrl = `https://github.com/${ghMatch[1]}/${ghMatch[2]}/archive/refs/heads/main.zip`
    }
  }
  if (!downloadUrl) {
    throw new Error(
      `Registry install failed: no download URL (HTTP 401) and no repository to build one from`
    )
  }
  const { isSafeExternalUrl } = await import('../security')
  if (!isSafeExternalUrl(downloadUrl)) {
    throw new Error('Blocked registry download URL scheme')
  }

  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: 'clone',
    status: 'skipped',
    message: 'Using zip download'
  })
  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: 'download',
    status: 'running',
    message: 'Downloading package…'
  })
  const zipRes = await session.defaultSession.fetch(downloadUrl, {
    signal: withAbort(30 * 60 * 1000, opts.signal)
  })
  if (!zipRes.ok) throw new Error(`Download failed: HTTP ${zipRes.status}`)
  const total = Number(zipRes.headers.get('content-length') || 0)
  const buf = Buffer.from(await zipRes.arrayBuffer())
  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: 'download',
    status: 'done',
    message: total
      ? `Downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`
      : 'Download complete'
  })
  const tmpZip = `${await nodeTempPath('install_', root)}.zip`
  writeFileSync(tmpZip, buf)
  const destName = sanitizeInstallName(opts.id)
  const dest = join(root, normalizePathEverySegment(destName))
  if (!isStrictInside(dest, root)) {
    try {
      unlinkSync(tmpZip)
    } catch {
      /* ignore */
    }
    throw new Error(`Refusing to install into unsafe destination: ${dest}`)
  }
  // Unzip into a throwaway sibling, then rename — a failed unzip can only
  // ever remove OUR temp dir, never a pre-existing user directory.
  const tmpDest = await nodeTempPath('unzip_tmp_', root)
  if (isPathInside(tmpDest, root) && !isStrictInside(tmpDest, root)) {
    try {
      unlinkSync(tmpZip)
    } catch {
      /* ignore */
    }
    throw new Error('Refusing unsafe temp unzip path')
  }
  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: 'download',
    status: 'done',
    message: 'Download complete'
  })
  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: 'unpack',
    status: 'running',
    message: 'Unpacking…'
  })
  try {
    const { safeUnzip } = await import('../zipSafe')
    await safeUnzip(tmpZip, tmpDest)
    // A cancellation that landed during extraction must not publish the pack
    // and "succeed" when there is no requirements step to notice the abort.
    if (opts.signal?.aborted) {
      const abortErr = new Error('aborted')
      abortErr.name = 'AbortError'
      throw abortErr
    }
    if (existsSync(dest)) {
      rmSync(tmpDest, { recursive: true, force: true })
      throw new Error(`Destination already exists: ${destName}`)
    }
    moveDirIntoPlace(tmpDest, dest)
    // GitHub archive zips nest a single folder (e.g. ComfyUI-KJNodes-main/).
    // Flatten it so the pack lives directly at dest/, not dest/nested/.
    flattenSingleNestedDir(dest)
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'unpack',
      status: 'done',
      message: 'Unpacked'
    })
  } catch (e) {
    try {
      unlinkSync(tmpZip)
    } catch {
      /* ignore */
    }
    // Clean ONLY the temp dir we created — never a pre-existing dest.
    try {
      if (existsSync(tmpDest) && /(?:clone_tmp_|unzip_tmp_)/.test(tmpDest)) {
        rmSync(tmpDest, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
    throw e
  }
  try {
    unlinkSync(tmpZip)
  } catch {
    /* ignore */
  }
  const packed = resolveNestedPackDir(dest)
  const rec = await this.afterInstall(
    packed,
    'registry',
    opts.registryId ?? opts.id,
    opts.instanceId,
    {
      pinnedVersion: versionedArchive ? opts.version?.trim() || undefined : undefined,
      installNote:
        opts.version && !versionedArchive
          ? `requested ${opts.version} unavailable — installed the default branch archive`
          : undefined,
      signal: opts.signal
    }
  )
  this.emitOpProgress({
    instanceId: opts.instanceId || 'default',
    step: 'verify',
    status: 'done',
    message: 'Installed'
  })
  return rec
}

export async function afterInstall(
  this: NodePackHost,
  dir: string,
  source: 'registry' | 'git' | 'manager' | 'local' = 'local',
  registryId?: string,
  instanceId?: string,
  extra?: AfterInstallExtra
): Promise<NodePackRecord> {
  const meta = readPackMeta(dir)
  const issues = collectIssues(dir, meta)
  // 0.1.17 (WP10): when the requested version could not be applied, say so as
  // a visible issue (and on the record) instead of silently reporting the
  // requested number as if it had been installed.
  if (extra?.installNote) {
    issues.push({
      code: 'version-fallback',
      severity: 'warning',
      message: extra.installNote,
      fixable: false
    })
  }
  // Requirements recorded on the pack record so uninstall can list/offer
  // residual pip deps without re-reading the (soon deleted) directory.
  let pipRequirements: string[] = []
  // Pack deps (requirements.txt). ON by default — a node pack without its
  // deps is a broken install. Settings.allowPipInstall turns this off for
  // users who want ComfyUI-Manager "manual deps" semantics.
  const reqFile = join(dir, 'requirements.txt')
  if (existsSync(reqFile)) {
    try {
      pipRequirements = parseRequirementNames(readFileSync(reqFile, 'utf-8'))
    } catch {
      pipRequirements = []
    }
    const settings = loadSettings()
    if (!settings.allowPipInstall) {
      issues.push({
        code: 'pip-disabled',
        severity: 'warning',
        message:
          'requirements.txt present but allow_pip_install is off — dependencies NOT installed',
        suggestion:
          'Enable allow_pip_install in Settings, or run pip install -r requirements.txt manually.',
        fixable: false
      })
      this.emitInstallProgress({
        phase: 'pip',
        packName: meta.name || dir,
        instanceId: instanceId,
        op: 'install',
        message: 'Dependencies skipped (allow_pip_install is off)'
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'requirements',
        status: 'skipped',
        message: 'Dependencies skipped (allow_pip_install is off)'
      })
    } else {
      // Must AWAIT: fire-and-forget meant "install done" while pip was still running,
      // and the catch below never saw async failures (dead pip-failed path).
      try {
        const vpy = resolveInstancePython(instanceId)
        if (vpy) {
          this.emitInstallProgress({
            phase: 'pip',
            packName: meta.name || dir,
            instanceId: instanceId,
            op: 'install',
            message: 'Installing Python dependencies…'
          })
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: 'running',
            message: 'Installing Python dependencies…'
          })
          // Stream pip/uv output into the progress modal line by line.
          const { installRequirements } = await import('../env')
          const { bootstrapService } = await import('../bootstrap')
          const bootstrap = await bootstrapService.ensure({
            kinds: ['uv'],
            downloadIfMissing: false
          })
          const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
          // 0.1.17 (WP2-4): no invented fraction — pip output only advances
          // the stage text; the step stays genuinely indeterminate.
          await installRequirements(
            vpy,
            reqFile,
            async (c, a, o) => {
              // fall back to a buffered run if streaming is not wired
              return execFileAsync(c, a, {
                timeout: o?.timeout ?? 10 * 60 * 1000,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
                env: comfyChildEnv(loadSettings())
              }).then((r) => r.stdout)
            },
            {
              uvPath: uvComp?.path,
              pipIndex: String(settings.pipIndex || '').trim(),
              signal: extra?.signal,
              onLine: (line) => {
                this.opLog(line, instanceId || 'default')
                const stage = pipStageFromLine(line)
                if (stage) {
                  this.setStepMessage('requirements', stage, instanceId || 'default')
                }
                this.emitInstallProgress({
                  phase: 'pip',
                  packName: meta.name || dir,
                  instanceId: instanceId,
                  op: 'install',
                  message: line.slice(0, 120)
                })
              }
            }
          )
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: 'done',
            message: 'Dependencies installed'
          })
        }
      } catch (err) {
        // Cancellation is NOT a pip failure: the abort must reach update()/
        // install() so the whole op reports OP_CANCELLED instead of finishing
        // "successfully" with a deps issue after the user pressed cancel.
        if (isAbortError(err)) throw err
        // Pip failure is NON-FATAL — the node is installed, just missing deps.
        // Emit 'skipped' not 'failed' so the modal stays open until the
        // overall install reaches its terminal state.
        this.emitOpProgress({
          instanceId: instanceId || 'default',
          step: 'requirements',
          status: 'skipped',
          message: `Deps failed: ${err instanceof Error ? err.message : String(err)}`
        })
        issues.push({
          code: 'pip-failed',
          severity: 'error',
          message: `pip install of pack requirements failed: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: 'Install requirements.txt manually in the instance environment.',
          fixable: false
        })
      }
    }
  } else {
    this.emitOpProgress({
      instanceId: instanceId || 'default',
      step: 'requirements',
      status: 'skipped',
      message: 'No requirements.txt'
    })
  }
  // Preserve user metadata (lock / tags / author / notes) across update and
  // install-over. afterInstall rebuilds the record from disk metadata, which
  // would otherwise reset those fields on every git pull / registry reinstall.
  const prevList = listNodePacks()
  const dirBase = dir.split(/[\\/]/).pop() || ''
  const prev =
    (registryId && prevList.find((p) => p.registryId === registryId)) ||
    prevList.find((p) => p.name === (meta.name || dirBase)) ||
    prevList.find(
      (p) => p.path && normalizePathEverySegment(p.path) === normalizePathEverySegment(dir)
    ) ||
    prevList.find((p) => p.id === createHash('sha1').update(dir).digest('hex').slice(0, 16))
  const rec: NodePackRecord = {
    id: createHash('sha1').update(dir).digest('hex').slice(0, 16),
    name: meta.name || dir.split(/[\\/]/).pop() || 'unknown',
    displayName: meta.displayName || 'unknown',
    description: meta.description || '',
    author: prev?.author || '',
    // An explicitly requested version wins over on-disk meta — that is what
    // "install version X" means to the user (and what the acceptance checks).
    version: extra?.pinnedVersion || meta.version || '0.0.0',
    status: 'installed',
    path: dir,
    repository: meta.repository,
    registryId: registryId ?? prev?.registryId,
    nodeCount: meta.nodeList?.length || 0,
    tags: prev?.tags || [],
    installSource: source,
    // Installing does not prove an update check ran. Only checkUpdates() may
    // advance this timestamp, otherwise the UI claims "checked just now".
    lastCheckedAt: prev?.lastCheckedAt ?? 0,
    issues,
    locked: prev?.locked || false,
    nodeList: meta.nodeList || [],
    license: meta.license,
    pythonCompatible: meta.pythonCompatible,
    notes: prev?.notes,
    pipRequirements: pipRequirements.length ? pipRequirements : prev?.pipRequirements,
    pinnedVersion: extra?.pinnedVersion || undefined,
    installNote: extra?.installNote || prev?.installNote,
    gitRev: gitRevOf(dir) ?? prev?.gitRev
  }
  upsertNodePack(rec)
  return rec
}

/** Uninstall recorded pip requirements for a pack. Returns the removed names. */
export async function removePipDeps(
  this: NodePackHost,
  names: string[],
  instanceId?: string,
  signal?: AbortSignal
): Promise<string[]> {
  const removed: string[] = []
  const vpy = resolveInstancePython(instanceId)
  if (!vpy || !names.length || signal?.aborted) return removed
  // pip may be missing in uv-created venvs — seed it first (0.1.12 WP4).
  // Previously every uninstall silently removed nothing on such venvs.
  // A failed seed throws PIP_UNAVAILABLE so the caller reports honestly.
  try {
    const { ensurePip, throwingExec } = await import('../env')
    await ensurePip(vpy, (c, a, o) => throwingExec(c, a, o))
  } catch (e) {
    if (isAbortError(e)) throw e
    throw codedError(
      'PIP_UNAVAILABLE',
      `pip is not available in ${vpy} — dependencies were NOT removed (use Doctor "Fix pip" first)`
    )
  }
  // Remove in modest batches so a giant requirements list cannot blow argv.
  const BATCH = 20
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH)
    try {
      await execFileAsync(vpy, ['-m', 'pip', 'uninstall', '-y', ...batch], {
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: comfyChildEnv(loadSettings()),
        signal
      })
      removed.push(...batch)
    } catch (e) {
      // Cancellation must propagate, never be swallowed as "not installed".
      if (isAbortError(e)) throw e
      // Some names may not be installed — keep going and report what worked.
      for (const n of batch) {
        try {
          await execFileAsync(vpy, ['-m', 'pip', 'uninstall', '-y', n], {
            timeout: 60000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
            env: comfyChildEnv(loadSettings()),
            signal
          })
          removed.push(n)
        } catch (e2) {
          if (isAbortError(e2)) throw e2
          /* not installed / already gone */
        }
      }
    }
  }
  return removed
}

export async function uninstall(
  this: NodePackHost,
  idOrName: string,
  instanceId?: string,
  opts?: { removePipDeps?: boolean }
): Promise<boolean> {
  const packs = this.list(instanceId)
  const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack?.path) return false
  if (pack.locked) throw new Error('Pack is locked — unlock before uninstall')
  const guardKey = instanceId || 'default'
  if (this.opBatches.has(guardKey) || this.opAborts.has(guardKey)) {
    throw codedError('OP_BUSY', 'Another operation is already running for this instance')
  }
  if (isPipOpActive(guardKey)) {
    throw codedError(
      'OP_BUSY',
      'A dependency install is running for this instance — wait for it to finish'
    )
  }
  // Own the busy slot (and an abort controller) for the whole uninstall —
  // pip cleanup can take minutes and must block concurrent ops.
  const uninstallSignal = this.beginOpAbort(instanceId)
  try {
    this.emitInstallProgress({
      phase: 'start',
      packName: pack.name || idOrName,
      instanceId: instanceId,
      op: 'uninstall',
      message: `Uninstalling ${pack.name || idOrName}…`
    })
    // Never clobber a running batch stream (uninstall is standalone, but the
    // guard keeps the invariant local to every stream owner).
    this.opProgressMap.delete(guardKey)
    this.emitOpProgress({
      instanceId: instanceId || 'default',
      step: 'verify',
      status: 'running',
      message: `Uninstalling ${pack.name || idOrName}…`,
      packName: pack.name || idOrName
    })
    try {
      // Snapshot before destructive ops so the user can at least see what was removed.
      try {
        this.createSnapshot(`auto-pre-uninstall-${sanitizeInstallName(pack.name)}`, instanceId)
      } catch {
        /* best-effort */
      }
      const targets = this.resolveRemovalTargets(pack.path, instanceId)
      const customRoot = detectCustomNodesRoot(instanceId)
      for (const target of targets) {
        // 0.2.0: quarantine INSIDE .disabled (ComfyUI skips it), never
        // `<name>.trash-*` next to custom_nodes — ComfyUI loads hidden
        // directories and reported IMPORT FAILED on every boot.
        const trashDir = customRoot
          ? join(customRoot, '.disabled')
          : join(dirname(target), '.disabled')
        const trash = join(trashDir, `${basename(target)}.trash-${Date.now()}`)
        try {
          mkdirSync(trashDir, { recursive: true })
          renameSync(target, trash)
          rmSync(trash, { recursive: true, force: true })
        } catch {
          try {
            rmSync(target, { recursive: true, force: true })
          } catch {
            /* the quarantined copy (if any) stays inside .disabled */
          }
        }
      }
      // Optional pip cleanup — offered by the UI after listing the residual deps.
      if (opts?.removePipDeps) {
        const deps = pack.pipRequirements?.length ? pack.pipRequirements : []
        if (deps.length) {
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: 'running',
            message: `Removing ${deps.length} pip package(s)…`
          })
          let removed: string[] = []
          let pipMissing = false
          try {
            removed = await this.removePipDeps(deps, instanceId, uninstallSignal)
          } catch (e) {
            if (isAbortError(e)) throw e
            if ((e as { code?: string }).code === 'PIP_UNAVAILABLE') {
              pipMissing = true
            } else {
              throw e
            }
          }
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: removed.length ? 'done' : 'skipped',
            message: pipMissing
              ? 'pip is unavailable — dependencies were NOT removed (use Doctor "Fix pip")'
              : removed.length
                ? `Removed pip packages: ${removed.join(', ')}`
                : 'No matching pip packages were installed'
          })
        }
      }
      deleteNodePack(pack.id)
      this.emitInstallProgress({
        phase: 'done',
        packName: pack.name || idOrName,
        instanceId: instanceId,
        op: 'uninstall',
        message: `Uninstalled ${pack.name || idOrName}`
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'done',
        status: 'done',
        message: `Uninstalled ${pack.name || idOrName}`
      })
      return true
    } catch (e) {
      this.emitInstallProgress({
        phase: 'error',
        packName: pack.name || idOrName,
        instanceId: instanceId,
        op: 'uninstall',
        message: e instanceof Error ? e.message : String(e)
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'done',
        status: 'failed',
        message: e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  } finally {
    this.endOpAbort(instanceId)
  }
}

/**
 * Directories to remove for a pack. When the pack lives in a registry-zip
 * nested layout (custom_nodes/<destShell>/<nested>/), the outer shell must go
 * too — otherwise list() picks up an empty NO_ENTRY ghost pack.
 *
 * Safety: the shell is only removed when it contains EXACTLY ONE entry (the
 * pack itself) — hidden files like `.git` count. A monorepo shell
 * (`Repo/.git` + `Repo/PackA`) is never collapsed.
 */
export function resolveRemovalTargets(
  this: NodePackHost,
  packPath: string,
  instanceId?: string
): string[] {
  const targets = [packPath]
  try {
    const parent = dirname(packPath)
    if (!parent || parent === packPath) return targets
    const customNodesRoot = detectCustomNodesRoot(instanceId)
    if (!customNodesRoot) return targets
    const parentNorm = normalizePathEverySegment(parent)
    const rootNorm = normalizePathEverySegment(customNodesRoot)
    if (parentNorm === rootNorm) return targets
    if (!isPathInside(packPath, parent)) return targets
    // parent must be exactly one level under custom_nodes
    const parentParent = dirname(parent)
    if (normalizePathEverySegment(parentParent) !== rootNorm) return targets
    // Count ALL entries, including hidden ones — a shell with .git or any
    // other residue is user/monorepo content, not our unzip artifact.
    const allSiblings = readdirSync(parent)
    const packBase = packPath.split(/[\\/]/).pop() || ''
    if (allSiblings.length === 1 && allSiblings[0] === packBase) {
      targets.push(parent)
    }
  } catch {
    /* ignore */
  }
  return [...new Set(targets)]
}

export const installMethods = {
  assertInstallAllowed,
  install,
  installInner,
  afterInstall,
  removePipDeps,
  uninstall,
  resolveRemovalTargets
}
