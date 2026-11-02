import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  mkdirSync
} from 'fs'
import { join, dirname, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  NodeCheckProgressEvent,
  NodePackRecord,
  NodeSnapshot,
  NodeUpdateAllOptions,
  NodeUpdateAllResult,
  NodeUpdateCheckResult
} from '@shared/types'
import { compareVersions, isUpdateAvailable } from '@shared/version'
import {
  deleteNodePack,
  listNodePacks,
  listSnapshots,
  insertSnapshot,
  deleteSnapshot as dbDeleteSnapshot,
  getSnapshot,
  loadSettings,
  snapshotDir,
  upsertNodePack
} from '../db'
import { sanitizeId, isPathInside } from '../security'
import { runStreaming } from '../env'
import { comfyChildEnv } from '../childEnv'
import { isPipOpActive } from '../pipOps'
import type { NodePackHost } from './host'
import {
  codedError,
  detectCustomNodesRoot,
  execFileAsync,
  gitRevOf,
  isAbortError,
  isStrictInside,
  resolveGitBinary,
  sanitizeInstallName
} from './common'

/**
 * Check every installed pack for an available update. 0.1.9 guarantees a
 * result row for EVERY pack (including disabled/locked/failed) with an
 * explicit `checkStatus` — a failed check must never read as "up to date".
 * - registry packs: Registry latest_version (id → repository URL → unique name)
 * - git packs (or packs with .git): git fetch + rev-list behind count
 * git checks run with bounded concurrency (4) and report progress.
 */
export async function checkUpdates(
  this: NodePackHost,
  instancePathOrId?: string
): Promise<NodeUpdateCheckResult[]> {
  const packs = this.list(instancePathOrId)
  const registryLatest = new Map<string, string>()
  const registryMatches = new Map<string, { id?: string; latestVersion?: string }>()

  // Warm registry latest versions for packs that have a registryId or match by name/repo.
  // Live page-1 hints (network) — a failure here must NOT skip the local index.
  try {
    const page = await this.registrySearch({ limit: 100, page: 1 })
    for (const item of page.items) {
      // Only accept entries that actually carry a version — an empty value
      // would mark the key as "resolved" and suppress the local index peek.
      if (item.id && item.latestVersion) registryLatest.set(item.id, item.latestVersion)
      if (item.name && item.latestVersion) registryLatest.set(item.name, item.latestVersion)
    }
  } catch {
    /* offline / registry down — the local index can still resolve matches */
  }
  // Peek at the local full-catalog index for anything not on page 1.
  try {
    const { registryIndex } = await import('../registryIndex')
    await registryIndex.ensure({ allowBuild: false })
    for (const p of packs) {
      if (registryLatest.has(p.registryId || '') || registryLatest.has(p.name)) continue
      // 1) Exact repository URL match — survives renamed folders / local copies.
      if (p.repository) {
        const byRepo = registryIndex.findByRepository(p.repository)
        if (byRepo) {
          registryMatches.set(p.name, { id: byRepo.id, latestVersion: byRepo.latestVersion })
          if (byRepo.latestVersion) {
            registryLatest.set(p.name, byRepo.latestVersion)
            continue
          }
          // No version on the repo hit → fall through to the name match.
        }
      }
      // 2) Unique exact name match (ambiguous names are never trusted).
      const hits = registryIndex.searchPacks(p.name, 5)
      const exact = hits.filter((h) => h.name === p.name || (p.registryId && h.id === p.registryId))
      if (exact.length === 1 && exact[0].latestVersion) {
        registryLatest.set(p.name, exact[0].latestVersion)
        registryMatches.set(p.name, {
          id: exact[0].id,
          latestVersion: exact[0].latestVersion
        })
      }
    }
  } catch {
    /* index optional */
  }

  const total = packs.length
  const results: Array<NodeUpdateCheckResult | undefined> = new Array(total)
  let done = 0
  const queue = packs.map((pack, index) => ({ pack, index }))
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (!item) break
      try {
        results[item.index] = await this.checkOnePack(
          item.pack,
          registryLatest,
          registryMatches.get(item.pack.name)
        )
      } catch (e) {
        // Defensive: one pack's unexpected throw must not kill the pass —
        // every pack still gets an explicit row.
        results[item.index] = {
          name: item.pack.name,
          id: item.pack.id,
          currentVersion: item.pack.version,
          updatable: false,
          updateSource: 'none',
          checkStatus: 'check-failed',
          reason: 'Check crashed',
          error: e instanceof Error ? e.message : String(e)
        }
      }
      done += 1
      this.emit('check-progress', {
        done,
        total,
        packName: item.pack.name,
        instanceId: instancePathOrId || 'default',
        ts: Date.now()
      } satisfies NodeCheckProgressEvent)
    }
  }
  // Bounded concurrency: git fetches dominate the runtime and each can burn
  // up to 30s on a dead remote — 4 workers keep the pass responsive.
  const workers = Math.max(1, Math.min(4, total))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results.filter((r): r is NodeUpdateCheckResult => Boolean(r))
}

/** Single-pack check used by checkUpdates (runs in a 4-worker pool). */
export async function checkOnePack(
  this: NodePackHost,
  pack: NodePackRecord,
  registryLatest: Map<string, string>,
  registryMatch?: { id?: string; latestVersion?: string }
): Promise<NodeUpdateCheckResult> {
  const base = { name: pack.name, id: pack.id, currentVersion: pack.version }

  if (pack.status === 'disabled') {
    // A registry update would reinstall into custom_nodes and silently
    // re-enable it — report it explicitly instead of hiding the row.
    return {
      ...base,
      updatable: false,
      updateSource: 'none',
      checkStatus: 'skipped-disabled',
      reason: 'Pack is disabled — enable it before updating',
      reasonKey: 'nodes.packDisabledUpdate'
    }
  }
  if (pack.locked) {
    return {
      ...base,
      latestVersion: pack.latestVersion,
      updatable: false,
      updateSource: 'none',
      checkStatus: 'locked',
      reason: 'Pack is locked',
      reasonKey: 'nodes.locked'
    }
  }

  const gitLike =
    pack.installSource === 'git' ||
    pack.installSource === 'manager' ||
    Boolean(pack.path && existsSync(join(pack.path, '.git')))

  if (gitLike && pack.path && existsSync(join(pack.path, '.git'))) {
    try {
      const gitBin = resolveGitBinary()
      const gitEnv = comfyChildEnv(loadSettings())
      await execFileAsync(gitBin, ['-C', pack.path, 'fetch', '--quiet'], {
        timeout: 30000,
        env: gitEnv
      })
      // Prefer the configured upstream; manually copied clones often have
      // origin but no tracking branch — fall back to origin/<current branch>.
      let compareRef = '@{u}'
      try {
        await execFileAsync(
          gitBin,
          ['-C', pack.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          { timeout: 10000, env: gitEnv }
        )
      } catch {
        const { stdout: branchOut } = await execFileAsync(
          gitBin,
          ['-C', pack.path, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { timeout: 10000, env: gitEnv }
        )
        const branch = branchOut.trim()
        let fallback = ''
        if (branch && branch !== 'HEAD') {
          const cand = `origin/${branch}`
          try {
            await execFileAsync(
              gitBin,
              ['-C', pack.path, 'rev-parse', '--verify', '--quiet', cand],
              { timeout: 10000, env: gitEnv }
            )
            fallback = cand
          } catch {
            /* origin branch missing */
          }
        }
        if (!fallback) {
          return {
            ...base,
            latestVersion: pack.latestVersion,
            updatable: false,
            updateSource: 'git',
            checkStatus: 'check-failed',
            reason: 'Git checkout has no upstream or origin branch',
            error: 'Git checkout has no upstream or origin branch'
          }
        }
        compareRef = fallback
      }
      const { stdout: behindOut } = await execFileAsync(
        gitBin,
        ['-C', pack.path, 'rev-list', '--count', `HEAD..${compareRef}`],
        { timeout: 10000, env: gitEnv }
      )
      const behind = Number(behindOut.trim()) || 0
      // `describe` on a --depth 1 clone routinely resolves to an OLD tag at
      // the shallow boundary. Only trust it when it is actually NEWER than
      // the local version; otherwise report the behind count honestly and
      // never rewrite the stored latestVersion (0.1.11).
      const { stdout: remoteVer } = await execFileAsync(
        gitBin,
        ['-C', pack.path, 'describe', '--tags', '--abbrev=0', compareRef],
        { timeout: 10000, env: gitEnv }
      ).catch(() => ({ stdout: '' }))
      const described = remoteVer.trim()
      // Only trust the tag when there are ALSO new commits: a same-commit
      // build whose pyproject lags behind the tag would otherwise light a
      // phantom "update available" that a pull can never satisfy (0.1.11).
      const trustworthy =
        behind > 0 && Boolean(described) && compareVersions(described, pack.version) > 0
      const latest = trustworthy ? described : pack.latestVersion
      const result: NodeUpdateCheckResult = {
        ...base,
        latestVersion: latest,
        updatable: behind > 0,
        updateSource: 'git',
        behindCount: behind,
        checkStatus: behind > 0 ? 'updatable' : 'up-to-date',
        reason: behind > 0 ? `${behind} commit(s) behind` : 'Up to date',
        reasonKey: behind > 0 ? undefined : 'nodes.upToDate'
      }
      this.persistCheck(pack, trustworthy ? described : undefined)
      return result
    } catch (e) {
      // A fetch failure is a FAILED CHECK — never silently "not updatable".
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ...base,
        latestVersion: pack.latestVersion,
        updatable: false,
        updateSource: 'git',
        checkStatus: 'check-failed',
        reason: `Git check failed: ${msg.slice(0, 200)}`,
        error: msg.slice(0, 400)
      }
    }
  }

  // Registry matching policy (locked by tests, 0.1.11): an exact repository
  // URL match wins over a unique exact-name match; ambiguous names are never
  // trusted; a version is persisted only when the update is CONFIRMED.
  const remote =
    (pack.registryId && registryLatest.get(pack.registryId)) ||
    registryLatest.get(pack.name) ||
    registryMatch?.latestVersion ||
    pack.latestVersion
  const resolvedRegistryId = pack.registryId || registryMatch?.id
  if (!remote) {
    return {
      ...base,
      updatable: false,
      updateSource: 'none',
      checkStatus: 'unsupported',
      reason: 'No remote version information',
      reasonKey: 'nodes.notUpdatable'
    }
  }
  const canRegistry = pack.installSource === 'registry' && Boolean(resolvedRegistryId)
  const updatable = canRegistry && isUpdateAvailable(pack.version, remote)
  if (canRegistry) {
    this.persistCheck(pack, remote, resolvedRegistryId)
  }
  return {
    ...base,
    latestVersion: remote,
    updatable,
    updateSource: canRegistry ? 'registry' : gitLike ? 'git' : 'none',
    checkStatus: updatable ? 'updatable' : canRegistry ? 'up-to-date' : 'unsupported',
    reason: updatable
      ? `Update available: ${remote}`
      : canRegistry
        ? 'Up to date'
        : gitLike
          ? 'Git checkout is missing — cannot pull'
          : 'Pack is not updatable via Registry or git',
    reasonKey: updatable ? 'nodes.hasUpdate' : canRegistry ? 'nodes.upToDate' : 'nodes.notUpdatable'
  }
}

/** Persist check results so list() can flag update-available without another round-trip. */
export function persistCheck(
  this: NodePackHost,
  pack: NodePackRecord,
  latestVersion?: string,
  registryId?: string
): void {
  try {
    const known = listNodePacks().find((p) => p.id === pack.id || p.name === pack.name)
    if (!known) return
    const next: NodePackRecord = { ...known, lastCheckedAt: Date.now() }
    if (latestVersion) next.latestVersion = latestVersion
    if (registryId && !known.registryId) next.registryId = registryId
    if (
      next.latestVersion !== known.latestVersion ||
      next.registryId !== known.registryId ||
      !known.lastCheckedAt
    ) {
      upsertNodePack(next)
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Sequentially update every updatable pack. 0.1.9: a batch context makes
 * EVERY pack's progress carry `batchIndex/batchTotal/aggregatePercent`, and
 * lifecycle events (`event:node-update-batch`) let the renderer show the
 * queue, the current pack and a monotonic overall bar. Cancel stops the
 * remaining queue after aborting the in-flight pack.
 */
export async function updateAll(
  this: NodePackHost,
  instancePathOrId?: string,
  opts?: NodeUpdateAllOptions
): Promise<NodeUpdateAllResult[]> {
  const key = instancePathOrId || 'default'
  // One batch per instance: a second concurrent "update all" (or a batch
  // started while a single op is in flight) would abort/clobber the other
  // operation's controller and misroute cancel.
  if (this.opBatches.has(key) || this.opAborts.has(key)) {
    throw codedError('OP_BUSY', 'Another operation is already running for this instance')
  }
  if (isPipOpActive(key)) {
    throw codedError(
      'OP_BUSY',
      'A dependency install is running for this instance — wait for it to finish'
    )
  }
  const batchId = randomUUID()
  // Reserve the batch slot BEFORE the (slow) check pass: without this, a
  // single op started during checkUpdates would arm its controller and get
  // abort-clobbered when the batch loop begins; two updateAlls could also
  // interleave their check phases.
  const state = {
    batchId,
    index: 0,
    total: 0,
    current: undefined as string | undefined,
    cancelled: false
  }
  this.opBatches.set(key, state)
  const out: NodeUpdateAllResult[] = []
  try {
    // Terminal event BEFORE the (slow) check pass: the modal must show a
    // cancellable "checking" state instead of looking stuck.
    this.emitBatch({
      batchId,
      instanceId: key,
      phase: 'checking',
      index: 0,
      total: 0
    })
    const checks = await this.checkUpdates(instancePathOrId)
    // `includeCheckFailed` (0.1.11): a flaky git fetch must not silently
    // exclude a pack the user clearly wants updated. Only packs whose
    // transport is known are retried; each outcome is reported per pack.
    const attempted = checks.filter(
      (c) =>
        c.updatable ||
        (opts?.includeCheckFailed === true &&
          c.checkStatus === 'check-failed' &&
          // Any pack with a known transport is retried; `none` has nothing
          // to pull from (0.1.11 — the earlier git/registry whitelist had an
          // unreachable registry arm).
          c.updateSource !== 'none')
    )
    const attemptedNames = new Set(attempted.map((c) => c.name))
    state.total = attempted.length
    this.emitBatch({
      batchId,
      instanceId: key,
      phase: 'start',
      index: 0,
      total: attempted.length
    })
    // No snapshot for a no-op / already-cancelled batch.
    if (attempted.length && !state.cancelled) {
      try {
        this.createSnapshot('auto-pre-update-all', instancePathOrId)
      } catch {
        /* best-effort */
      }
    }
    for (const c of attempted) {
      if (state.cancelled) {
        out.push({ name: c.name, ok: false, error: 'cancelled', skipped: true })
        continue
      }
      state.index += 1
      state.current = c.name
      this.emitBatch({
        batchId,
        instanceId: key,
        phase: 'pack-start',
        index: state.index,
        total: state.total,
        packName: c.name
      })
      try {
        // 0.2.0: ids are stable; names can collide/change after a reinstall.
        await this.update(c.id || c.name, undefined, instancePathOrId, { fromBatch: true })
        out.push({ name: c.name, ok: true, checkStatus: c.checkStatus })
        this.emitBatch({
          batchId,
          instanceId: key,
          phase: 'pack-done',
          index: state.index,
          total: state.total,
          packName: c.name,
          ok: true
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        out.push({ name: c.name, ok: false, error: msg, checkStatus: c.checkStatus })
        this.emitBatch({
          batchId,
          instanceId: key,
          phase: 'pack-done',
          index: state.index,
          total: state.total,
          packName: c.name,
          ok: false,
          error: msg
        })
        if ((e as { code?: string })?.code === 'OP_CANCELLED') state.cancelled = true
      }
    }
    // Preserve the legacy shape: one entry per non-updatable check.
    for (const c of checks) {
      if (!c.updatable && !attemptedNames.has(c.name)) {
        out.push({ name: c.name, ok: true, skipped: true, checkStatus: c.checkStatus })
      }
    }
  } catch (e) {
    // A failure before/during the queue (bad check pass, listener throw)
    // reports a terminal batch event once, then cleans the slot.
    this.emitBatch({
      batchId,
      instanceId: key,
      phase: 'batch-error',
      index: state.index,
      total: state.total,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  } finally {
    this.opBatches.delete(key)
  }
  const ok = out.filter((r) => r.ok && !r.skipped).length
  const fail = out.filter((r) => !r.ok && !r.skipped).length
  const skip = out.filter((r) => r.skipped).length
  // Skipped check-failures only — retried-but-updated packs are successes,
  // matching the renderer summary (0.1.11).
  const checkFailed = out.filter((r) => r.skipped && r.checkStatus === 'check-failed').length
  this.emitBatch({
    batchId,
    instanceId: key,
    phase: 'batch-done',
    index: state.index,
    total: state.total,
    ok: fail === 0,
    summary: { ok, fail, skip, cancelled: state.cancelled, checkFailed }
  })
  return out
}

export async function update(
  this: NodePackHost,
  idOrName: string,
  version?: string,
  instanceId?: string,
  internal?: { fromBatch?: boolean }
): Promise<NodePackRecord> {
  const guardKey = instanceId || 'default'
  // Exclusivity: while a batch (or another op) runs for this instance, a
  // second entry point must not abort it, clobber its stream, or inherit
  // its batch context. updateAll passes {fromBatch:true} for its own calls.
  if (!internal?.fromBatch && (this.opBatches.has(guardKey) || this.opAborts.has(guardKey))) {
    throw codedError('OP_BUSY', 'Another operation is already running for this instance')
  }
  if (!internal?.fromBatch && isPipOpActive(guardKey)) {
    throw codedError(
      'OP_BUSY',
      'A dependency install is running for this instance — wait for it to finish'
    )
  }
  this.emitInstallProgress({
    phase: 'start',
    packName: idOrName,
    instanceId: instanceId,
    op: 'update',
    message: `Updating ${idOrName}…`
  })
  // Fresh op-progress stream so the shared modal can finish (git-pull path
  // never emitted a terminal 'done' before). Inside a running batch the
  // stream is reset IN PLACE instead — runId + terminal log continuity.
  const key = instanceId || 'default'
  if (this.opBatches.has(key)) this.resetOpSteps(key, idOrName)
  else this.opProgressMap.delete(key)
  this.emitOpProgress({
    instanceId: instanceId || 'default',
    step: 'clone',
    status: 'running',
    message: `Updating ${idOrName}…`,
    packName: idOrName
  })
  const signal = this.beginOpAbort(instanceId)
  try {
    const rec = await this.updateInner(idOrName, version, instanceId, signal)
    this.emitInstallProgress({
      phase: 'done',
      packName: rec.name || idOrName,
      instanceId: instanceId,
      op: 'update',
      message: `Updated ${rec.name || idOrName}`
    })
    this.emitOpProgress({
      instanceId: instanceId || 'default',
      step: 'done',
      status: 'done',
      message: `Updated ${rec.name || idOrName}`
    })
    return rec
  } catch (e) {
    // Only treat as cancelled when the error itself is an AbortError.
    // `signal.aborted` alone is too broad — a timeout must NOT mask the
    // real error (e.g. HTTP 502) with "Update cancelled".
    const cancelled = isAbortError(e)
    this.emitInstallProgress({
      phase: 'error',
      packName: idOrName,
      instanceId: instanceId,
      op: 'update',
      message: e instanceof Error ? e.message : String(e)
    })
    this.emitOpProgress({
      instanceId: instanceId || 'default',
      step: 'done',
      status: cancelled ? 'cancelled' : 'failed',
      message: e instanceof Error ? e.message : String(e)
    })
    throw cancelled ? codedError('OP_CANCELLED', 'Update cancelled') : e
  } finally {
    this.endOpAbort(instanceId)
  }
}

/**
 * Run a git command with live output: lines stream into the op log, and
 * "Receiving objects: N%" / "Resolving deltas: N%" drive the step fraction
 * so the progress bar moves during a long fetch instead of sitting at 0%.
 */
export async function gitRunStreaming(
  this: NodePackHost,
  gitBin: string,
  args: string[],
  instanceId: string | undefined,
  opts: { timeout: number; onPercent?: (pct: number) => void; signal?: AbortSignal }
): Promise<string> {
  const sink = (line: string): void => {
    this.opLog(line, instanceId)
    const recv = /Receiving objects:\s+(\d+)%/.exec(line)
    if (recv && opts.onPercent) opts.onPercent(Number(recv[1]))
    const delta = /Resolving deltas:\s+(\d+)%/.exec(line)
    if (delta && opts.onPercent) opts.onPercent(60 + Math.round(Number(delta[1]) * 0.4))
  }
  return runStreaming(
    gitBin,
    args,
    { timeout: opts.timeout, onLine: sink, signal: opts.signal },
    async (c, a, o) =>
      execFileAsync(c, a, {
        timeout: o?.timeout,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env: comfyChildEnv(loadSettings())
      }).then((r) => r.stdout)
  )
}

/**
 * Bring a git pack up to date: `pull --ff-only` when a tracking branch is
 * configured; manually copied clones (origin exists, no upstream) fall back
 * to `fetch origin` + `merge --ff-only origin/<branch>`.
 */
export async function gitPullOrMerge(
  this: NodePackHost,
  gitBin: string,
  cwd: string,
  instanceId?: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const mapPct = (pct: number): void => onProgress?.(0.1 + (pct / 100) * 0.85)
  try {
    await this.gitRunStreaming(gitBin, ['-C', cwd, 'pull', '--ff-only'], instanceId, {
      timeout: 60000,
      onPercent: mapPct,
      signal
    })
    return
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const noUpstream = /no tracking information|does not have a tracking/i.test(msg)
    if (!noUpstream || isAbortError(e)) throw e
    const { stdout: branchOut } = await execFileAsync(
      gitBin,
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 10000, env: comfyChildEnv(loadSettings()), signal }
    )
    const branch = branchOut.trim()
    if (!branch || branch === 'HEAD') throw e
    await this.gitRunStreaming(gitBin, ['-C', cwd, 'fetch', 'origin', '--quiet'], instanceId, {
      timeout: 60000,
      onPercent: mapPct,
      signal
    })
    await this.gitRunStreaming(
      gitBin,
      ['-C', cwd, 'merge', '--ff-only', `origin/${branch}`],
      instanceId,
      { timeout: 60000, onPercent: mapPct, signal }
    )
    this.opLog(`pull had no upstream — fast-forwarded to origin/${branch}`, instanceId)
  }
}

export async function updateInner(
  this: NodePackHost,
  idOrName: string,
  version?: string,
  instanceId?: string,
  signal?: AbortSignal
): Promise<NodePackRecord> {
  const packs = this.list(instanceId)
  const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack) throw new Error('Pack not found')
  if (pack.locked) throw new Error('Pack is locked')
  if (pack.status === 'disabled') {
    // Updating a disabled pack would move it back into custom_nodes (registry
    // reinstall) and silently enable it — refuse and tell the user why.
    throw codedError('NODE_DISABLED', 'Pack is disabled — enable it before updating')
  }
  // Snapshot before update so enable/disable state can be aligned later.
  try {
    this.createSnapshot(`auto-pre-update-${sanitizeInstallName(pack.name)}`, instanceId)
  } catch {
    /* best-effort */
  }
  const isGitPack =
    pack.installSource === 'git' || Boolean(pack.path && existsSync(join(pack.path, '.git')))
  if (isGitPack && pack.path) {
    const gitBin = resolveGitBinary()
    // Capture the pre-update rev so a failed pull can be hard-reset back to
    // a consistent tree (partial fetch/index state must not survive).
    let oldRev = ''
    try {
      const { stdout } = await execFileAsync(gitBin, ['-C', pack.path, 'rev-parse', 'HEAD'], {
        timeout: 10000,
        env: comfyChildEnv(loadSettings())
      })
      oldRev = stdout.trim()
    } catch {
      /* no rev — skip the reset safety net */
    }
    try {
      await this.gitPullOrMerge(
        gitBin,
        pack.path,
        instanceId,
        (fraction) => this.setStepFraction('clone', fraction, instanceId),
        signal
      )
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'clone',
        status: 'done',
        message: 'Repository updated',
        packName: pack.name
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (oldRev) {
        try {
          await execFileAsync(gitBin, ['-C', pack.path, 'reset', '--hard', oldRev], {
            timeout: 30000,
            env: comfyChildEnv(loadSettings())
          })
          this.opLog?.(`git pull failed — reset --hard ${oldRev.slice(0, 12)}`, instanceId)
        } catch {
          /* reset is best-effort; the original error still surfaces */
        }
      }
      if (isAbortError(e)) {
        throw codedError('OP_CANCELLED', 'Update cancelled')
      }
      throw new Error(`git pull failed for ${pack.name}: ${msg}`)
    }
    return await this.afterInstall(
      pack.path,
      pack.installSource === 'registry' ? 'git' : pack.installSource,
      pack.registryId,
      instanceId,
      { signal }
    )
  }
  if (pack.installSource === 'registry' && pack.registryId && pack.path) {
    const trash = `${pack.path}.bak-${Date.now()}`
    const root = detectCustomNodesRoot(instanceId)
    // Remember pre-update root entries so a failed reinstall can sweep any
    // orphan destName the git-prefer path created under a different folder
    // name than the old pack.path (restore of .bak alone leaves it behind).
    const preEntries = (() => {
      try {
        return root && existsSync(root) ? new Set(readdirSync(root)) : new Set<string>()
      } catch {
        return new Set<string>()
      }
    })()
    renameSync(pack.path, trash)
    try {
      // The reinstall is the middle of THIS update op: reuse the stream so the
      // modal doesn't reset (runId/log) halfway, and close the inapplicable
      // git step accordingly. Signal ownership stays with the outer op.
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'clone',
        status: 'skipped',
        message: 'Reinstalling from registry…',
        packName: pack.name
      })
      const next = await this.install(
        {
          id: pack.registryId,
          version,
          source: 'registry',
          instanceId
        },
        { reuseStream: true, signal }
      )
      // Clean backup only after successful reinstall
      try {
        rmSync(trash, { recursive: true, force: true })
      } catch {
        this.emitInstallProgress({
          phase: 'done',
          packName: pack.name,
          instanceId: instanceId,
          message: `Updated, but backup cleanup failed — kept ${trash}`
        })
      }
      // Drop the OLD record only when the id changed — afterInstall already
      // upserted (possibly under the same id) with locked/tags/author/notes
      // preserved. Deleting unconditionally would wipe the fresh record.
      if (pack.id !== next.id) deleteNodePack(pack.id)
      return next
    } catch (e) {
      // rollback — failures here MUST surface, never silently swallow.
      // First sweep orphan dirs the failed install published under a new
      // destName (git-prefer names from the repo URL, not the registry id).
      if (root && existsSync(root)) {
        try {
          for (const name of readdirSync(root)) {
            if (preEntries.has(name)) continue
            const cand = join(root, name)
            if (cand === pack.path || cand === trash) continue
            if (!isStrictInside(cand, root)) continue
            try {
              rmSync(cand, { recursive: true, force: true })
              this.opLog?.(`removed orphan install dir ${name}`, instanceId)
            } catch {
              /* best-effort */
            }
          }
        } catch {
          /* sweep is best-effort */
        }
      }
      let rolledBack = false
      try {
        if (existsSync(pack.path)) rmSync(pack.path, { recursive: true, force: true })
        renameSync(trash, pack.path)
        rolledBack = true
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr)
        this.emitInstallProgress({
          phase: 'error',
          packName: pack.name,
          instanceId: instanceId,
          message: `Update failed AND rollback failed (${rbMsg}) — backup kept at ${trash}`
        })
        throw new Error(
          `Update failed for ${pack.name}: ${e instanceof Error ? e.message : String(e)}; rollback also failed (${rbMsg}) — backup at ${trash}`
        )
      }
      this.emitInstallProgress({
        phase: 'error',
        packName: pack.name,
        instanceId: instanceId,
        message: rolledBack ? `Update failed — rolled back to previous version` : 'Update failed'
      })
      throw e
    }
  }
  throw new Error('Pack is not updatable via Registry or git')
}

export function toggle(
  this: NodePackHost,
  idOrName: string,
  enabled: boolean,
  instanceId?: string
): NodePackRecord | undefined {
  const packs = this.list(instanceId)
  const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack?.path) return undefined
  const root = detectCustomNodesRoot(instanceId)
  if (!root) return undefined
  let dir = pack.path
  if (!enabled) {
    // Real disable semantics (recognized by both ComfyUI and ComfyUI-Manager):
    // move the pack into `<custom_nodes>/.disabled/<name>`.
    // ComfyUI skips any entry ending in `.disabled`; Manager reads children of
    // the `.disabled/` folder. A marker FILE inside the pack is invisible to
    // both loaders — never rely on it again (kept below only for legacy reads).
    if (!dir.endsWith('.disabled') && basename(dirname(dir)) !== '.disabled') {
      const disabledRoot = join(root, '.disabled')
      mkdirSync(disabledRoot, { recursive: true })
      const target = join(disabledRoot, basename(dir))
      if (existsSync(target)) {
        throw codedError('DISABLE_CONFLICT', `Disable target already exists: ${target}`)
      }
      renameSync(dir, target)
      dir = target
    }
    pack.path = dir
    pack.status = 'disabled'
  } else {
    // Enable: undo whichever disabled form this pack uses.
    if (basename(dirname(dir)) === '.disabled') {
      const target = join(root, basename(dir))
      if (existsSync(target)) {
        throw codedError('ENABLE_CONFLICT', `Enable target already exists: ${target}`)
      }
      renameSync(dir, target)
      dir = target
    } else if (dir.endsWith('.disabled')) {
      const target = dir.slice(0, -'.disabled'.length)
      if (existsSync(target)) {
        throw codedError('ENABLE_CONFLICT', `Enable target already exists: ${target}`)
      }
      renameSync(dir, target)
      dir = target
    }
    // Legacy marker file cleanup (from pre-0.1.8 versions).
    const legacyMarker = join(dir, '.disabled')
    if (existsSync(legacyMarker)) unlinkSync(legacyMarker)
    pack.path = dir
    pack.status = 'installed'
  }
  // The directory identity (= pack id) changed with the move: recompute so the
  // DB row, the next list() and deleteNodePack(id) all agree on one id.
  pack.id = createHash('sha1').update(dir).digest('hex').slice(0, 16)
  upsertNodePack(pack)
  return pack
}

export function lock(
  this: NodePackHost,
  idOrName: string,
  locked: boolean,
  instanceId?: string
): NodePackRecord | undefined {
  const packs = this.list(instanceId)
  const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack) return undefined
  pack.locked = locked
  upsertNodePack(pack)
  return pack
}

export function snapshots(this: NodePackHost, instanceId?: string): NodeSnapshot[] {
  const all = listSnapshots()
  // Legacy snapshots carry no instanceId — keep them visible everywhere so
  // older auto-pre-* backups are never silently lost after an instance switch.
  if (!instanceId) return all
  return all.filter((s) => !s.instanceId || s.instanceId === instanceId)
}

/**
 * Prune `auto-pre-*` snapshots so the list cannot grow without bound.
 * Keeps the most recent 10 auto snapshots for the given instance (legacy
 * snapshots without an instanceId share the same bucket).
 */
export function pruneAutoSnapshots(this: NodePackHost, instanceId?: string): void {
  const MAX_AUTO = 10
  try {
    const all = listSnapshots()
    const auto = all
      .filter(
        (s) =>
          s.name.startsWith('auto-pre-') &&
          // Legacy snapshots (no instanceId) share every bucket so they
          // cannot accumulate forever.
          (s.instanceId == null || s.instanceId === (instanceId || ''))
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    for (const s of auto.slice(MAX_AUTO)) {
      this.deleteSnapshot(s.id, instanceId)
    }
  } catch {
    /* pruning is best-effort */
  }
}

export function createSnapshot(
  this: NodePackHost,
  name?: string,
  instanceId?: string
): NodeSnapshot {
  // Record version AND git rev per pack so a rollback can pin the exact
  // source state that existed when the snapshot was taken.
  const packs = this.list(instanceId).map((p) => ({
    name: p.name,
    version: p.version,
    path: p.path || '',
    source: p.status === 'disabled' ? `${p.installSource}@disabled` : p.installSource,
    gitRev: (p.path && gitRevOf(p.path)) || p.gitRev
  }))
  const snapshot: NodeSnapshot = {
    id: randomUUID(),
    name: name || `snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    createdAt: Date.now(),
    packs,
    notes: '',
    instanceId
  }
  // Snapshot creation is best-effort on the persistence side — a DB or disk
  // failure must not lose the in-memory snapshot the caller is about to use.
  try {
    insertSnapshot(snapshot)
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(join(snapshotDir(), `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2))
  } catch {
    /* ignore */
  }
  if (name?.startsWith('auto-pre-')) {
    this.pruneAutoSnapshots(instanceId)
  }
  return snapshot
}

/**
 * Align enable/disable state with a snapshot.
 * NOTE: this does NOT reinstall missing packs or roll back versions — it only
 * toggles `.disabled` markers to match the snapshot. UI must say so.
 */
export function restoreSnapshot(this: NodePackHost, id: string, instanceId?: string): boolean {
  const snap = getSnapshot(id)
  if (!snap) return false
  // Symmetric with deleteSnapshot: never restore an instance's snapshot
  // against a different instance.
  if (instanceId && snap.instanceId && snap.instanceId !== instanceId) return false
  const current = this.list(instanceId)
  const currentNames = new Set(current.map((p) => p.name))
  const snapNames = new Set(snap.packs.map((p) => p.name))
  // Snapshot records disabled state via source suffix "@disabled"
  const snapDisabled = new Set(
    snap.packs.filter((p) => p.source.endsWith('@disabled')).map((p) => p.name)
  )
  const snapEnabled = new Set(
    snap.packs.filter((p) => !p.source.endsWith('@disabled')).map((p) => p.name)
  )

  for (const p of current) {
    if (!snapNames.has(p.name)) {
      this.toggle(p.name, false, instanceId)
    } else if (snapDisabled.has(p.name)) {
      this.toggle(p.name, false, instanceId)
    } else if (snapEnabled.has(p.name)) {
      this.toggle(p.name, true, instanceId)
    }
  }
  for (const s of snap.packs) {
    if (currentNames.has(s.name) || !s.path || !existsSync(s.path)) continue
    try {
      let dir = s.path
      if (snapDisabled.has(s.name)) {
        // Use a form ComfyUI actually honors: `<dir>.disabled` rename.
        // (A marker file inside the pack is invisible to the loader.)
        if (!dir.endsWith('.disabled') && basename(dirname(dir)) !== '.disabled') {
          const target = `${dir}.disabled`
          if (!existsSync(target)) {
            renameSync(dir, target)
            dir = target
          } else {
            writeFileSync(join(dir, '.disabled'), String(Date.now()))
          }
        }
      } else if (snapEnabled.has(s.name)) {
        // Undo both real disabled forms; the legacy marker is removed too.
        if (basename(dirname(dir)) === '.disabled') {
          const target = join(dirname(dirname(dir)), basename(dir))
          if (!existsSync(target)) {
            renameSync(dir, target)
            dir = target
          }
        } else if (dir.endsWith('.disabled')) {
          const target = dir.slice(0, -'.disabled'.length)
          if (!existsSync(target)) {
            renameSync(dir, target)
            dir = target
          }
        }
        const legacyMarker = join(dir, '.disabled')
        if (existsSync(legacyMarker)) unlinkSync(legacyMarker)
      }
    } catch {
      /* ignore */
    }
  }
  return true
}

export function deleteSnapshot(this: NodePackHost, id: string, instanceId?: string): boolean {
  const safe = sanitizeId(id)
  // Scope deletes to the instance when one is given — a snapshot taken on
  // another instance must not disappear because someone cleaned up here.
  if (instanceId) {
    const snap = getSnapshot(safe)
    if (snap?.instanceId && snap.instanceId !== instanceId) return false
  }
  try {
    const file = join(snapshotDir(), `${safe}.json`)
    if (existsSync(file) && isPathInside(file, snapshotDir())) unlinkSync(file)
  } catch {
    /* ignore */
  }
  return dbDeleteSnapshot(safe)
}

export const updateMethods = {
  checkUpdates,
  checkOnePack,
  persistCheck,
  updateAll,
  update,
  gitRunStreaming,
  gitPullOrMerge,
  updateInner,
  toggle,
  lock,
  snapshots,
  pruneAutoSnapshots,
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot
}
