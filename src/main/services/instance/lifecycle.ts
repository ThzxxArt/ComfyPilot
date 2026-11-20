import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname, resolve, isAbsolute } from 'path'
import net from 'net'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  InstanceStatus,
  LaunchOptions,
  PortCheckResult,
  WaitReadyResult
} from '@shared/types'
import { classifyLogLine, stripAnsi } from '@shared/logLine'
import { comfyChildEnv } from '../childEnv'
import { loadInstanceConfigs, loadSettings, logsDir, upsertInstanceConfig } from '../db'
import { normalizeForCompare } from '../security'
import { killProcessTree } from '../processTree'
import { COMFY_DEFAULT_PORTS } from '@shared/constants'
import { warnLaunchArgs } from '@shared/launchArgs'
import { buildEffectiveArgList, resolveEffectiveInstance } from '@shared/instanceLayout'
import { capabilityService } from '../capabilities'
import { readCliArgsFlags } from '../launchArgCatalog'
import { pythonVersionText } from './python'
import { probeVersion } from './runtime'
import {
  READY_EXTEND_MS,
  READY_POLL_MS,
  READY_TIMEOUT_MS,
  type InstanceActionResult,
  type InstanceExitReport,
  type InstanceServiceContext,
  type InstanceStopResult,
  type PidLedgerEntry,
  type RuntimeEntry
} from './types'

const execFileAsync = promisify(execFile)

export async function checkPort(port: number): Promise<PortCheckResult> {
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

/** Ports already claimed by configured instances (effective, not just config.port). */
function configuredPorts(): Set<number> {
  const ports = new Set<number>()
  for (const c of loadInstanceConfigs()) {
    try {
      ports.add(resolveEffectiveInstance(c).port)
    } catch {
      if (c.port) ports.add(c.port)
    }
  }
  return ports
}

export async function suggestPort(ctx: InstanceServiceContext): Promise<number> {
  // 0.2.5 WP0: a port that another configured instance will use is not a
  // suggestion — batch starts then collide on the same "free" port.
  const claimed = configuredPorts()
  for (const p of COMFY_DEFAULT_PORTS) {
    if (claimed.has(p)) continue
    const check = await ctx.checkPort(p)
    if (check.available) return p
  }
  // Defaults are taken — probe a few random candidates instead of blindly
  // returning an unchecked port (the old fallback could collide).
  for (let i = 0; i < 8; i++) {
    const candidate = 9000 + Math.floor(Math.random() * 500)
    if (claimed.has(candidate)) continue
    const check = await ctx.checkPort(candidate)
    if (check.available) return candidate
  }
  // Last resort: sequential scan just above the default range.
  for (let p = 8193; p < 8223; p++) {
    if (claimed.has(p)) continue
    const check = await ctx.checkPort(p)
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
export async function pickEphemeralPort(
  ctx: InstanceServiceContext,
  avoid: number
): Promise<number> {
  const claimed = configuredPorts()
  for (let i = 0; i < 16; i++) {
    const candidate = 8310 + Math.floor(Math.random() * 600)
    if (candidate === avoid || claimed.has(candidate)) continue
    const check = await ctx.checkPort(candidate)
    if (check.available) return candidate
  }
  for (let p = 8910; p < 8960; p++) {
    if (p === avoid || claimed.has(p)) continue
    const check = await ctx.checkPort(p)
    if (check.available) return p
  }
  throw new Error('No free port found for the startup self-check')
}

export async function waitReady(
  ctx: InstanceServiceContext,
  id: string,
  timeoutMs = READY_TIMEOUT_MS + READY_EXTEND_MS + 5_000
): Promise<WaitReadyResult> {
  const rt = ctx.runtimes.get(id)
  const started = Date.now()
  if (!rt) {
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === id)
    if (!config) throw new Error(`Instance not found: ${id}`)
    return {
      ready: false,
      info: ctx.toInfo(ctx.ensureRuntime(config)),
      error: 'Instance is not running',
      elapsedMs: 0
    }
  }
  if (rt.ready && rt.status === 'running') {
    return { ready: true, info: ctx.toInfo(rt), elapsedMs: 0 }
  }
  if (rt.status === 'error') {
    return {
      ready: false,
      info: ctx.toInfo(rt),
      error: rt.lastError || 'Instance is in error state',
      elapsedMs: Date.now() - started
    }
  }
  // 0.2.5 WP0: a stopped instance with no process will never become ready.
  // The old code still created a waiter and blocked for ~305s.
  if (!rt.process && !ctx.startingIds.has(id) && rt.status !== 'starting') {
    return {
      ready: false,
      info: ctx.toInfo(rt),
      error: rt.lastError || 'Instance is not running',
      elapsedMs: Date.now() - started
    }
  }
  return new Promise<WaitReadyResult>((resolveWait) => {
    const waiter: RuntimeEntry['readyWaiters'][number] = {
      resolve: () => undefined,
      startedAt: started
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
        info: ctx.toInfo(rt),
        error: `Instance did not become ready within ${Math.round(timeoutMs / 1000)}s`,
        elapsedMs: Date.now() - started
      })
    }, timeoutMs)
    rt.readyWaiters.push(waiter)
  })
}

function settleReadyWaiters(ctx: InstanceServiceContext, rt: RuntimeEntry, error?: string): void {
  const waiters = rt.readyWaiters
  rt.readyWaiters = []
  for (const w of waiters) {
    if (w.timer) {
      clearTimeout(w.timer)
      w.timer = undefined
    }
    w.resolve({
      ready: rt.ready && rt.status === 'running',
      info: ctx.toInfo(rt),
      error,
      elapsedMs: w.startedAt ? Date.now() - w.startedAt : 0
    })
  }
}

/** Poll /system_stats until ComfyUI answers or the process dies. */
function beginReadyProbe(ctx: InstanceServiceContext, rt: RuntimeEntry, gen: number): void {
  if (rt.readyPollTimer) {
    clearInterval(rt.readyPollTimer)
    rt.readyPollTimer = undefined
  }
  const started = Date.now()
  let deadline = started + READY_TIMEOUT_MS
  let extended = false
  const base = ctx.baseUrlOf(rt.config)
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
          ctx.pushLog(rt, 'info', `ComfyUI ready at ${base} (${Date.now() - started}ms)`)
          // Establish the online-version fact immediately (0.1.11.1): before
          // this, the card showed it only inside the 30s probe window and
          // then flipped back to the install stamp (a commit sha).
          void capabilityService.probe(rt.config.id).catch(() => undefined)
          settleReadyWaiters(ctx, rt)
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
        ctx.pushLog(
          rt,
          'info',
          `Still waiting for HTTP on ${base} (process alive, ${Math.round((now - started) / 1000)}s) — extending…`
        )
        return
      }
      rt.status = 'error'
      const timeoutMsg = `ComfyUI did not answer on ${base} within ${Math.round((now - started) / 1000)}s`
      rt.lastError = timeoutMsg
      if (rt.readyPollTimer) {
        clearInterval(rt.readyPollTimer)
        rt.readyPollTimer = undefined
      }
      ctx.pushLog(rt, 'error', rt.lastError)
      // 0.1.18 (WP3 / L4): an error status with a live child is a half-state
      // — the next launch would race the old process for the port. Kill the
      // tree we started and drop the handle only once it is gone.
      const stuck = rt.process
      if (stuck && stuck.exitCode === null) {
        ctx.pushLog(rt, 'warn', 'Ready timeout — terminating the unresponsive process tree')
        // Mark the kill as ours so the exit handler does not report a crash
        // toast; the timeout reason stays visible instead.
        rt.intentionalStop = true
        void killProcessTree(stuck, { timeoutMs: 5000 }).then(() => {
          if (rt.process === stuck) rt.process = undefined
          if (stuck.exitCode !== null) forgetPid(rt.config.id)
          if (rt.status === 'stopped') rt.status = 'error'
          rt.intentionalStop = false
        })
      }
      settleReadyWaiters(ctx, rt, rt.lastError)
    }
  }
  rt.readyPollTimer = setInterval(() => {
    void tick()
  }, READY_POLL_MS)
  void tick()
}

export function clearReadyProbe(
  ctx: InstanceServiceContext,
  rt: RuntimeEntry,
  error?: string
): void {
  if (rt.readyPollTimer) {
    clearInterval(rt.readyPollTimer)
    rt.readyPollTimer = undefined
  }
  rt.ready = false
  settleReadyWaiters(ctx, rt, error ?? (rt.intentionalStop ? 'Stopped' : rt.lastError))
}

export async function start(
  ctx: InstanceServiceContext,
  id: string,
  opts?: LaunchOptions
): Promise<ComfyInstanceInfo> {
  if (ctx.startingIds.has(id)) {
    throw new Error('Instance start already in progress')
  }
  ctx.startingIds.add(id)
  try {
    return await startInner(ctx, id, opts)
  } finally {
    ctx.startingIds.delete(id)
  }
}

/**
 * Start and block until HTTP is ready (or throw).
 * Opening embed/browser is done by the IPC layer so this service stays
 * free of Electron shell/window dependencies.
 */
export async function launch(
  ctx: InstanceServiceContext,
  id: string,
  opts?: LaunchOptions
): Promise<ComfyInstanceInfo> {
  const info = await ctx.start(id, opts)
  const rt = ctx.runtimes.get(id)
  if (rt?.ready && rt.status === 'running') return info
  const waited = await ctx.waitReady(id)
  if (!waited.ready) {
    throw new Error(waited.error || 'Instance did not become ready')
  }
  return waited.info
}

async function startInner(
  ctx: InstanceServiceContext,
  id: string,
  opts?: LaunchOptions
): Promise<ComfyInstanceInfo> {
  const config = loadInstanceConfigs().find((c) => c.id === id)
  if (!config) throw new Error(`Instance not found: ${id}`)
  const rt = ctx.ensureRuntime(config)
  // 0.1.17 (WP3): clear any previous cancel request BEFORE the first await —
  // doing it at the generation bump (after the port probe) swallowed a stop()
  // that arrived while the very first checkPort was in flight.
  rt.cancelRequested = false
  if (rt.process && rt.process.exitCode === null) {
    if (rt.ready) return ctx.toInfo(rt)
    // Process is up but not ready yet — wait for the existing probe.
    const waited = await ctx.waitReady(id)
    if (!waited.ready) throw new Error(waited.error || 'Instance did not become ready')
    return waited.info
  }

  // 0.2.5 WP1: probe the port the final argv actually selects, not config.port.
  let effective = resolveEffectiveInstance(config)
  let effectivePort = effective.port
  const portFlagCount = buildEffectiveArgList(config).filter(
    (a) => a === '--port' || a.startsWith('--port=')
  ).length
  // A port injected through template/profile/extraArgs cannot be relocated by
  // writing config.port — that would only change the FIRST (overridden) value.
  const portOverriddenByArgs = portFlagCount > 1
  let portCheck = await ctx.checkPort(effectivePort)
  if (!portCheck.available && rt.expectingStop) {
    // 0.1.17 (WP3): a restart must NEVER adopt the process it just tried to
    // stop — that would silently keep the old (possibly broken) server while
    // claiming a fresh start. Wait for the port, then refuse.
    for (let i = 0; i < 20 && !portCheck.available; i++) {
      await new Promise((r) => setTimeout(r, 250))
      portCheck = await ctx.checkPort(effectivePort)
    }
    if (!portCheck.available) {
      rt.expectingStop = false
      rt.lastError = `Port ${effectivePort} is still in use after stopping — refusing to adopt the old process`
      rt.status = 'error'
      ctx.pushLog(rt, 'error', rt.lastError)
      ctx.emitStatus(rt)
      throw new Error(rt.lastError)
    }
  }
  rt.expectingStop = false
  if (!portCheck.available) {
    // Port may be occupied by a ComfyUI we can adopt (already running).
    const base = effective.url
    try {
      const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        // 0.1.18 (WP3 / L5): prove the process is OURS before adopting it.
        // Any ComfyUI answering on the port used to be treated as this
        // instance — batch runs and outputs then went to another machine's UI.
        // 0.2.5 WP0: require ledger PID + `main.py` + the instance path; a
        // reused PID whose command mentions some other ComfyUI is not ours.
        const ledger = readPids()[config.id]
        let owned = Boolean(ledger?.pid && isPidAlive(ledger.pid))
        if (owned && ledger?.pid) {
          const cmd = await processCommandLine(ledger.pid)
          const expectPath = normalizeForCompare(config.path).toLowerCase()
          const cmdNorm = normalizeForCompare(String(cmd || '')).toLowerCase()
          owned = Boolean(cmdNorm && /main\.py/.test(cmdNorm) && expectPath && cmdNorm.includes(expectPath))
        }
        if (!owned && !opts?.adoptExternal) {
          const e = new Error(
            `Port ${effectivePort} is already serving a ComfyUI this app did not start`
          ) as Error & { code?: string; suggestedPort?: number }
          e.code = 'ADOPT_CONFIRM_REQUIRED'
          e.suggestedPort = effectivePort
          rt.expectingStop = false
          throw e
        }
        rt.status = 'running'
        rt.ready = true
        // Owned ledger entry → we may stop it later; truly external → never kill.
        rt.managed = owned
        if (owned) rt.pid = ledger?.pid
        rt.startedAt = rt.startedAt ?? Date.now()
        ctx.pushLog(
          rt,
          'info',
          owned
            ? `Adopted ComfyUI at ${base} (owned by this app — stop may terminate it)`
            : `Adopted already-running ComfyUI at ${base} (external process — stop will not kill it)`
        )
        ctx.emitStatus(rt)
        return ctx.toInfo(rt)
      }
    } catch (adoptErr) {
      // A coded adoption refusal is not "port not ComfyUI" — surface it.
      if ((adoptErr as { code?: string })?.code === 'ADOPT_CONFIRM_REQUIRED') {
        rt.status = 'error'
        rt.lastError = (adoptErr as Error).message
        ctx.emitStatus(rt)
        throw adoptErr
      }
      /* not ComfyUI — real conflict */
    }
    if (opts?.relocatePort) {
      if (portOverriddenByArgs) {
        const e = new Error(
          `Port ${effectivePort} is selected by launch arguments (--port), not by the instance setting — change the overriding argument instead`
        ) as Error & { code?: string }
        e.code = 'PORT_OVERRIDDEN'
        rt.status = 'error'
        rt.lastError = e.message
        ctx.pushLog(rt, 'error', e.message)
        ctx.emitStatus(rt)
        throw e
      }
      const next = await ctx.suggestPort()
      effectivePort = next
      const nextConfig: ComfyInstanceConfig = { ...config, port: next }
      // Validate BEFORE persisting: an argparse-fatal combo must not leave a
      // half-applied port change behind when the launch is refused.
      ctx.assertLaunchArgsValid(rt, ctx.buildArgs(nextConfig))
      ctx.pushLog(
        rt,
        'warn',
        `Port ${effectivePort} is in use — relocating to ${next} (persisted to instance config)`
      )
      upsertInstanceConfig(nextConfig)
      rt.config = nextConfig
      effective = resolveEffectiveInstance(nextConfig)
    } else {
      rt.lastError = `Port ${effectivePort} is already in use`
      rt.status = 'error'
      ctx.pushLog(rt, 'error', rt.lastError)
      ctx.emitStatus(rt)
      const err = new Error(rt.lastError) as Error & { code?: string; suggestedPort?: number }
      err.code = 'PORT_IN_USE'
      err.suggestedPort = await ctx.suggestPort()
      throw err
    }
  }

  rt.generation += 1
  const gen = rt.generation
  rt.intentionalStop = false
  rt.lastExit = undefined
  rt.status = 'starting'
  rt.ready = false
  rt.managed = true
  rt.lastError = undefined
  rt.startedAt = undefined
  rt.safeMode = opts?.safeMode === true
  ctx.emitStatus(rt)

  // 0.2.5 WP0: a stop/restart may arrive while any of the awaits below are in
  // flight. Check the generation AND the cancel flag after every await, and
  // once more immediately before spawn — the old code could spawn a process
  // after the UI had already been told "stopped".
  const assertStartCurrent = (): void => {
    if (rt.generation === gen && !rt.cancelRequested) return
    if (rt.generation === gen) {
      rt.status = 'stopped'
      rt.managed = false
      clearReadyProbe(ctx, rt, 'Start cancelled')
      ctx.emitStatus(rt)
    }
    throw Object.assign(new Error('Instance start cancelled'), { code: 'START_CANCELLED' })
  }

  // 0.2.0: boot-session boundary for startup diagnostics.
  ctx.pushLog(rt, 'info', `=== ComfyPilot boot ${Date.now()} ${new Date().toISOString()} ===`)
  // Quarantine `.trash-*`/`.bak-*`/`._*` BEFORE ComfyUI scans custom_nodes.
  try {
    const { nodePackService } = await import('../nodePack')
    const moved = nodePackService.quarantineTransients(rt.config.id)
    if (moved.length) {
      ctx.pushLog(rt, 'warn', `Quarantined startup leftovers: ${moved.join(', ')}`)
    }
  } catch {
    /* quarantine is best-effort; ComfyUI still starts */
  }
  assertStartCurrent()
  // EnvMarker: launch must use the same environment the audit/install wrote.
  // A stale marker after a manual venv swap is a hard stop, not a warning.
  try {
    const markerFile = join(dirname(rt.config.path), '.comfypilot-env.json')
    if (existsSync(markerFile)) {
      const marker = JSON.parse(readFileSync(markerFile, 'utf-8')) as {
        venvPath?: string
        pythonVersion?: string
      }
      if (marker.pythonVersion && !/^3\.13\./.test(marker.pythonVersion)) {
        throw Object.assign(new Error(`ENV_MISMATCH: marker says Python ${marker.pythonVersion}`), {
          code: 'ENV_MISMATCH'
        })
      }
      if (marker.venvPath && rt.config.venvPath) {
        const a = normalizeForCompare(marker.venvPath)
        const b = normalizeForCompare(rt.config.venvPath)
        if (a !== b) {
          throw Object.assign(
            new Error(
              `ENV_MISMATCH: marker says ${marker.venvPath}, instance uses ${rt.config.venvPath}`
            ),
            { code: 'ENV_MISMATCH' }
          )
        }
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENV_MISMATCH') {
      // 0.2.5 WP0: this used to be thrown while status was still `starting`,
      // leaving the UI stuck on "启动中" forever.
      rt.status = 'error'
      rt.lastError = err instanceof Error ? err.message : String(err)
      ctx.pushLog(rt, 'error', rt.lastError)
      ctx.emitStatus(rt)
      throw err
    }
    /* a missing/corrupt marker is advisory */
  }
  const python = ctx.resolvePython(rt.config)
  // 0.2.0: refuse to spawn a non-3.13 interpreter. A Python 3.12 venv is a
  // one-way migration, not a supported runtime; 3.14+ is plainly unsupported.
  const versionText = await pythonVersionText(python)
  assertStartCurrent()
  const pyMatch = versionText.match(/Python\s+(\d+)\.(\d+)/i)
  if (!pyMatch) {
    rt.status = 'error'
    rt.lastError = `Could not determine the Python version of ${python} — refusing to launch`
    ctx.pushLog(rt, 'error', rt.lastError)
    ctx.emitStatus(rt)
    const e = new Error(rt.lastError) as Error & { code?: string }
    e.code = 'PYTHON_UNKNOWN'
    throw e
  }
  if (!(Number(pyMatch[1]) === 3 && Number(pyMatch[2]) === 13)) {
    const legacy = Number(pyMatch[1]) === 3 && Number(pyMatch[2]) === 12
    rt.config = {
      ...rt.config,
      migrationState: legacy ? 'required' : 'failed',
      migrationError: `Unsupported Python ${pyMatch[1]}.${pyMatch[2]} — 0.2.0 requires Python 3.13`
    }
    upsertInstanceConfig(rt.config)
    rt.status = 'error'
    rt.lastError = rt.config.migrationError
    ctx.pushLog(rt, 'error', rt.lastError || 'Unsupported Python version')
    ctx.emitStatus(rt)
    const e = new Error(rt.lastError) as Error & { code?: string }
    e.code = legacy ? 'PYTHON_MIGRATION_REQUIRED' : 'PYTHON_UNSUPPORTED'
    throw e
  }
  const args = ctx.buildArgs(rt.config)
  // 0.2.5 WP3: safe mode is a one-run argument — never persisted, never
  // duplicated when the user already declared it.
  if (opts?.safeMode && !args.includes('--disable-all-custom-nodes')) {
    args.push('--disable-all-custom-nodes')
  }
  // Refuse argparse-fatal combos (mutually exclusive groups) BEFORE spawn —
  // ComfyUI would otherwise exit instantly with an opaque usage error.
  ctx.assertLaunchArgsValid(rt, args)
  // Advisories never block. Two independent sources of truth keep them
  // honest on a cold start (no online version cached yet):
  //  1. the installed build's own `comfy/cli_args.py` — flag exists ⇒ supported;
  //  2. a semantic version read from disk (comfyui_version.py / pyproject)
  //     — only used when the build did not expose the flag.
  // A commit sha or `detected` must not be fed to versionAtLeast: it would
  // either warn as "old" or, for a sha starting with digits, silently pass.
  const onDiskVersion = probeVersion(ctx, rt.config.path)
  const version = /^v?\d+\.\d+/.test(onDiskVersion || '')
    ? onDiskVersion
    : capabilityService.cachedForInstance(rt.config.id)?.version
  const supportedFlags = readCliArgsFlags(rt.config.path)
  for (const w of warnLaunchArgs(args, { version, supportedFlags })) {
    ctx.pushLog(
      rt,
      w.level === 'warning' ? 'warn' : 'info',
      w.code === 'unknown-flag'
        ? `Unrecognized flag ${w.flag}`
        : w.code === 'duplicate-listen'
          ? 'Multiple --listen flags — the last one wins'
          : `Flag ${w.flag} requires a recent ComfyUI build`
    )
  }
  // 0.2.5 WP6: the watchdog probes plain HTTP. Say so instead of showing a
  // silent false "unresponsive" for a self-signed HTTPS instance.
  if (args.includes('--tls-keyfile') || args.includes('--tls-certfile')) {
    ctx.pushLog(
      rt,
      'warn',
      'TLS launch flags detected — 0.2.5 health/monitor probes do not support self-signed HTTPS; expect health warnings'
    )
  }
  // Path-valued flags that point nowhere usually mean a typo'd path; warn.
  const pathFlags = new Set([
    '--extra-model-paths-config',
    '--output-directory',
    '--input-directory',
    '--temp-directory',
    '--previews-directory',
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
      ctx.pushLog(rt, 'warn', `${args[i]} path does not exist: ${abs}`)
    }
  }

  // 0.2.5 WP10: a path is not a ComfyUI install just because it is called one.
  // Require main.py plus at least one ComfyUI fingerprint before executing it.
  const mainPy = join(rt.config.path, 'main.py')
  const fingerprints = [
    join(rt.config.path, 'comfy'),
    join(rt.config.path, 'comfyui_version.py'),
    join(rt.config.path, 'comfy_extras'),
    join(rt.config.path, 'comfy', 'cli_args.py')
  ]
  if (!existsSync(mainPy) || !fingerprints.some((p) => existsSync(p))) {
    rt.status = 'error'
    rt.lastError = `Not a ComfyUI installation (main.py + comfy fingerprint required): ${rt.config.path}`
    ctx.pushLog(rt, 'error', rt.lastError)
    ctx.emitStatus(rt)
    const e = new Error(rt.lastError) as Error & { code?: string }
    e.code = 'INSTANCE_NOT_COMFYUI'
    throw e
  }
  // Last gate before the process exists: no spawn after stop/restart.
  assertStartCurrent()
  try {
    const child = spawn(python, args, {
      cwd: rt.config.path,
      windowsHide: true,
      // UTF-8 + unbuffered + app proxy (single source: comfyChildEnv, 0.1.16).
      env: comfyChildEnv(loadSettings())
    })
    rt.process = child
    rt.pid = child.pid
    rt.startedAt = Date.now()
    if (rt.generation !== gen || rt.cancelRequested) {
      // Stop arrived while spawn() was executing — kill what we just created
      // instead of leaving an orphan the user was told had been stopped.
      rt.intentionalStop = true
      await killProcessTree(child, { timeoutMs: 5000 })
      if (rt.process === child) {
        rt.process = undefined
        rt.pid = undefined
      }
      if (rt.generation === gen) {
        rt.status = 'stopped'
        rt.managed = false
        rt.cancelRequested = false
        clearReadyProbe(ctx, rt, 'Start cancelled')
        ctx.emitStatus(rt)
      }
      throw Object.assign(new Error('Instance start cancelled'), { code: 'START_CANCELLED' })
    }
    // 0.1.17 (WP3): ledger entry so an app crash cannot orphan a 20 GB server.
    rememberPid(rt)

    // Level comes from the LINE'S OWN `[LEVEL]` token first (0.1.16) — Python
    // logging writes nearly everything to stderr, so the old "stderr ⇒ warn"
    // rule painted every INFO/DEBUG line as a warning. ANSI colour codes are
    // stripped before storage.
    const handleStream =
      (stream: 'stdout' | 'stderr') =>
      (buf: Buffer): void => {
        if (rt.generation !== gen) return
        // Bare `\r` is a real line separator in child output: ComfyUI and node
        // packs use it for progress rewrites. Leaving it inside the message
        // wrote `[ts] INFO \rtext` to disk, which readLogFile could not parse
        // (JS `.` does not match `\r`) and re-emitted with a fabricated
        // timestamp — a duplicated, double-prefixed line.
        buf
          .toString('utf-8')
          .split(/\r\n|\r|\n/)
          .forEach((raw) => {
            if (!raw.trim()) return
            const line = stripAnsi(raw)
            if (!line.trim()) return
            ctx.pushLog(rt, classifyLogLine(stream, raw), line)
          })
      }
    child.stdout.on('data', handleStream('stdout'))
    child.stderr.on('data', handleStream('stderr'))
    child.on('error', (err) => {
      if (rt.generation !== gen) return
      rt.lastError = err.message
      rt.status = 'error'
      if (rt.process === child) {
        rt.process = undefined
        rt.pid = undefined
      }
      clearReadyProbe(ctx, rt)
      ctx.pushLog(rt, 'error', err.message)
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
      // 0.1.17 (WP3): classify the crash and tell the user, instead of only
      // flipping a status chip the UI may not even be looking at.
      const unexpected = !intentional && code !== 0
      if (unexpected) {
        const report = classifyExit(rt, code, signal)
        rt.lastExit = report
        rt.lastError = `${report.hint} (exit=${code ?? '?'} signal=${signal ?? 'none'})`
        ctx.pushLog(rt, 'error', `Crash classified as ${report.kind}: ${report.hint}`)
        ctx.emit('exit', { instanceId: rt.config.id, report })
      }
      forgetPid(rt.config.id)
      clearReadyProbe(ctx, rt)
      // The process is gone — its online version is no longer "online".
      capabilityService.invalidate(rt.config.id)
      ctx.pushLog(
        rt,
        code === 0 || intentional ? 'info' : 'error',
        `Process exited code=${code} signal=${signal}`
      )
    })

    beginReadyProbe(ctx, rt, gen)
  } catch (err) {
    rt.status = 'error'
    rt.lastError = err instanceof Error ? err.message : String(err)
    clearReadyProbe(ctx, rt)
    ctx.emitStatus(rt)
    throw err
  }

  // Surface errors fast: if the process dies in the first moments, rethrow.
  await new Promise((r) => setTimeout(r, 200))
  // 0.1.17 (WP3): a stop() that arrived while we were starting wins. Without
  // this check the freshly spawned process survived the "stopped" the user
  // already saw (the old code only ignored the request when no process
  // existed yet, and stopAll skipped such instances entirely).
  if (rt.cancelRequested && rt.generation === gen) {
    const pending = rt.process
    rt.cancelRequested = false
    rt.intentionalStop = true
    await terminateChild(pending, 3000)
    if (rt.generation === gen) {
      if (rt.process === pending) {
        rt.process = undefined
        rt.pid = undefined
      }
      rt.status = 'stopped'
      rt.managed = false
      clearReadyProbe(ctx, rt, 'Start cancelled')
      ctx.pushLog(rt, 'info', 'Start cancelled before the instance became ready')
      ctx.emitStatus(rt)
    }
    throw new Error('Instance start cancelled')
  }
  const lateStatus = rt.status as InstanceStatus
  if (rt.generation === gen && lateStatus === 'error' && rt.lastError) {
    throw new Error(rt.lastError)
  }

  return ctx.toInfo(rt)
}

/**
 * Best-effort structured crash classification from the log tail (WP3).
 * Read-only: the UI uses it to offer "restart" or "lower VRAM and restart".
 */
function classifyExit(
  rt: RuntimeEntry,
  code: number | null,
  signal: NodeJS.Signals | null
): InstanceExitReport {
  const tail = (rt.logs || [])
    .slice(-200)
    .map((l) => l.message)
    .join('\n')
    .toLowerCase()
  const at = Date.now()
  if (rt.cancelRequested || rt.intentionalStop) {
    return { kind: 'cancelled', code, signal, hint: 'Stopped by request', at }
  }
  if (/out of memory|cuda error: out of memory|allocation on device|memoryerror/.test(tail)) {
    return {
      kind: 'oom',
      code,
      signal,
      hint: 'GPU/CPU ran out of memory — lower the resolution or free VRAM',
      at
    }
  }
  if (/address already in use|eaddrinuse|port \d+ is already in use/.test(tail)) {
    return { kind: 'port', code, signal, hint: 'Port was taken by another process', at }
  }
  if (/modulenotfounderror|importerror|cannot import name|no module named/.test(tail)) {
    return {
      kind: 'dependency',
      code,
      signal,
      hint: 'A Python dependency is missing or broken — run Repair env',
      at
    }
  }
  // 0.1.17 (review fix): this used to match the bare word `cuda`/`hip`, which
  // every normal start log contains ("Total VRAM … torch.cuda …"), so ANY
  // crash was reported as a GPU driver problem. Require an actual failure
  // phrase instead of a mention.
  if (
    /(cuda error|cuda failed|cuda driver|cuda runtime|no cuda-capable device|nvidia.*(error|failed|not found)|nvml.*(error|failed)|hip.*(error|failed)|rocm.*(error|failed)|driver.*(error|failed|not found))/.test(
      tail
    )
  ) {
    return {
      kind: 'driver',
      code,
      signal,
      hint: 'GPU driver/CUDA problem — check the driver or torch channel',
      at
    }
  }
  return { kind: 'unknown', code, signal, hint: `Exited with code ${code}`, at }
}

// ---------- orphan pid ledger (0.1.17 WP3) ----------

function pidsFile(): string {
  return join(logsDir(), 'pids.json')
}

function readPids(): Record<string, PidLedgerEntry> {
  try {
    const raw = JSON.parse(readFileSync(pidsFile(), 'utf-8')) as Record<string, PidLedgerEntry>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writePids(next: Record<string, PidLedgerEntry>): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
    writeFileSync(pidsFile(), JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    /* ledger is best-effort */
  }
}

/** Record a spawned process so a crashed app can find it again. */
function rememberPid(rt: RuntimeEntry): void {
  if (!rt.pid) return
  const all = readPids()
  all[rt.config.id] = { pid: rt.pid, path: rt.config.path, startedAt: Date.now() }
  writePids(all)
}

/** Drop the ledger entry (process exited or was stopped). */
function forgetPid(instanceId: string): void {
  const all = readPids()
  if (!(instanceId in all)) return
  delete all[instanceId]
  writePids(all)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the pid exists but belongs to another user.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Command line of a live pid, when the OS can tell us. Used to CONFIRM a
 * ledger entry is really our ComfyUI before killing it (PID reuse is real).
 */
async function processCommandLine(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ],
        { timeout: 8000, windowsHide: true }
      )
      return stdout.trim() || null
    }
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim() || null
  } catch {
    return null
  }
}

/**
 * Startup sweep of the ledger (0.1.17 WP3). A process we started that
 * outlived the app holds tens of GB of VRAM, so it must not be forgotten.
 * Conservative: only terminate when the command line proves it is ours;
 * anything unverifiable is reported, never killed.
 */
export async function sweepStaleProcesses(): Promise<{
  entries: number
  killed: string[]
  unverified: string[]
}> {
  const all = readPids()
  const ids = Object.keys(all)
  const killed: string[] = []
  const unverified: string[] = []
  if (!ids.length) return { entries: 0, killed, unverified }
  const next: typeof all = {}
  for (const id of ids) {
    const entry = all[id]
    if (!entry?.pid || !isPidAlive(entry.pid)) continue // gone — drop
    const cmd = await processCommandLine(entry.pid)
    const expected = String(entry.path || '')
    if (cmd && expected && cmd.includes(expected)) {
      try {
        if (process.platform === 'win32') {
          await execFileAsync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], {
            timeout: 8000,
            windowsHide: true
          })
        } else {
          process.kill(entry.pid, 'SIGKILL')
        }
        killed.push(`${id} (pid ${entry.pid})`)
        continue
      } catch {
        /* fall through to unverified */
      }
    }
    unverified.push(`${id} (pid ${entry.pid}${cmd ? '' : ', command line unavailable'})`)
    next[id] = entry
  }
  writePids(next)
  return { entries: ids.length, killed, unverified }
}

/**
 * Kill a process tree we only know by PID (adopted owned instance, 0.2.5 WP0).
 * Returns true only when the PID is observed gone — a timed-out taskkill is
 * reported as failure, never as "stopped".
 */
async function killPidTree(pid: number): Promise<boolean> {
  if (!pid || !isPidAlive(pid)) return true
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 8000
      }).catch(() => undefined)
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* already gone or permission denied */
  }
  for (let i = 0; i < 30; i++) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isPidAlive(pid)
}

/** Stop a child process tree, gracefully first (0.1.17 WP3).
 *
 * Windows has no signals: the old code called `child.kill('SIGTERM')`, which
 * Node implements as an immediate TerminateProcess — ComfyUI never got to
 * release its page-locked VRAM. `taskkill /T` (no /F) asks the whole tree to
 * close, and only escalates to `/F` after the grace window.
 *
 * @returns true when the child actually exited before the grace window ended.
 */
async function terminateChild(
  child: ChildProcessWithoutNullStreams | undefined,
  graceMs = 3000
): Promise<boolean> {
  if (!child) return true
  if (child.exitCode !== null) return true

  // 0.1.18 (WP3): the default is now a real tree kill. The old "graceful"
  // path always waited the full 3 s on Windows because `taskkill /T` (no /F)
  // does not close a console Python process.
  let mode: 'fast' | 'graceful' = 'fast'
  try {
    mode = loadSettings().stopMode === 'graceful' ? 'graceful' : 'fast'
  } catch {
    /* defaults to fast */
  }
  if (mode === 'fast') {
    const prefix = new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) return resolve(true)
      let done = false
      const finish = (v: boolean): void => {
        if (done) return
        done = true
        resolve(v)
      }
      child.once('exit', () => finish(true))
      setTimeout(() => finish(false), 1500)
    })
    await killProcessTree(child, { timeoutMs: 5000 })
    // `Promise.resolve(child.exitCode !== null)` settled immediately, so the
    // exit watcher was dead code and a successful kill was reported as
    // "still running" (breaking update/rollback right after a stop).
    if (child.exitCode !== null) return true
    return prefix
  }

  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), graceMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T'], {
      windowsHide: true,
      timeout: 5000
    }).catch(() => undefined)
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }

  if (await exited) return true

  // Escalate: the process ignored the polite request.
  if (process.platform === 'win32' && pid) {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000
    }).catch(() => undefined)
  } else {
    try {
      if (child.exitCode === null) child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  return Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(child.exitCode !== null), 1500))
  ])
}

export async function startAll(ctx: InstanceServiceContext): Promise<InstanceActionResult[]> {
  const configs = loadInstanceConfigs().filter((c) => c.enabled !== false)
  const out: InstanceActionResult[] = []
  for (const c of configs) {
    try {
      // A pack already mid-start must be WAITED for, not rejected — the old
      // path let the startingIds guard throw "already in progress" and the
      // batch summary reported a bogus failure (0.1.11).
      if (ctx.startingIds.has(c.id)) {
        const waited = await ctx.waitReady(c.id)
        out.push({
          ...waited.info,
          ok: waited.ready,
          error: waited.ready ? undefined : waited.error || 'Start did not complete'
        })
        continue
      }
      const info = await ctx.start(c.id)
      out.push({ ...info, ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.pushLog(ctx.ensureRuntime(c), 'error', `startAll: ${msg}`)
      out.push({ ...ctx.toInfo(ctx.ensureRuntime(c)), ok: false, error: msg })
    }
  }
  return out
}

export async function stopAll(ctx: InstanceServiceContext): Promise<InstanceActionResult[]> {
  const out: InstanceActionResult[] = []
  for (const rt of ctx.runtimes.values()) {
    // 0.1.17 (WP3): "starting" counts, even before the status flips — a start
    // that is still in its port probe has no process yet but is in flight.
    const live =
      Boolean(rt.process) ||
      rt.status === 'running' ||
      rt.status === 'starting' ||
      ctx.startingIds.has(rt.config.id)
    if (!live) continue
    const id = rt.config.id
    try {
      const info = await ctx.stop(id)
      // 0.2.0: a process that ignored the grace window is not a success.
      out.push({
        ...info,
        ok: info.exited !== false,
        error: info.exited === false ? 'Process did not exit within the grace window' : undefined
      })
    } catch (err) {
      out.push({
        ...ctx.toInfo(rt),
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return out
}

export async function stop(ctx: InstanceServiceContext, id: string): Promise<InstanceStopResult> {
  const rt = ctx.runtimes.get(id)
  if (!rt) throw new Error(`Instance not found: ${id}`)
  // 0.1.17 (review fix): one stop in flight per instance. Without this, a
  // second caller saw the already-cleared process handle and returned
  // `exited:true` while the first stop was still waiting for the kill —
  // the updater then overwrote a live process's files.
  const inFlight = ctx.stopping.get(id)
  if (inFlight) return inFlight
  const p = stopInner(ctx, rt)
  ctx.stopping.set(id, p)
  try {
    return await p
  } finally {
    ctx.stopping.delete(id)
  }
}

async function stopInner(
  ctx: InstanceServiceContext,
  rt: RuntimeEntry
): Promise<InstanceStopResult> {
  const id = rt.config.id
  // 0.1.17 (WP3): a start that is still in flight (port check, spawn, the
  // 200 ms settle window) must be aborted AND awaited. The old code bumped
  // the generation and returned "stopped" while startInner went on to spawn,
  // so the process reappeared seconds later.
  if (ctx.startingIds.has(id) || rt.status === 'starting') {
    rt.cancelRequested = true
    // 0.2.5 WP0: wait for the in-flight start to observe the cancel. The
    // pre-spawn + post-spawn generation gates make the remaining race safe;
    // the old 10s window could expire while `python --version` was still
    // running (8s timeout on a cold interpreter) and the start then spawned.
    const deadline = Date.now() + 30_000
    while (ctx.startingIds.has(id) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (ctx.startingIds.has(id)) {
      ctx.pushLog(rt, 'warn', 'Start did not finish within 30s — forcing stop')
    }
  }
  rt.intentionalStop = true
  rt.generation += 1
  rt.lastExit = undefined
  const child = rt.process
  const ledgerPid = rt.pid && !child ? rt.pid : undefined
  const wasManaged = rt.managed
  // Snapshot BEFORE overwriting status/ready so a second stop of an adopted
  // external process can still see that it was live.
  const wasRunning = rt.status === 'running' || rt.status === 'starting'
  const wasReady = rt.ready
  clearReadyProbe(ctx, rt, wasManaged ? 'Stopped' : 'External process left running')
  // Drop the online version — a stopped instance shows the install stamp.
  capabilityService.invalidate(id)
  let adopted = false
  let exited = true
  if (child) {
    // Awaited: the UI's "stopped" must mean the process is actually gone.
    exited = await terminateChild(child)
    if (!exited) {
      // Keep the handle: the process may still be alive, so a later stop or
      // force-kill must be able to reach it. Status says "error", not "stopped".
      rt.status = 'error'
      ctx.pushLog(
        rt,
        'warn',
        `Process ${child.pid ?? '?'} did not exit within the grace window — it may still be running`
      )
    } else {
      rt.process = undefined
      rt.pid = undefined
      rt.status = 'stopped'
    }
  } else if (ledgerPid && wasManaged && isPidAlive(ledgerPid)) {
    // 0.2.5 WP0: adopted but owned (ledger proves we spawned it). Stop must
    // actually terminate it instead of refusing because `managed` was lost.
    exited = await killPidTree(ledgerPid)
    rt.process = undefined
    rt.pid = exited ? undefined : ledgerPid
    rt.status = exited ? 'stopped' : 'error'
    ctx.pushLog(
      rt,
      exited ? 'info' : 'error',
      exited
        ? `Stopped adopted process tree (pid ${ledgerPid})`
        : `Adopted process ${ledgerPid} did not exit within the grace window`
    )
  } else {
    rt.process = undefined
    rt.pid = undefined
    rt.status = 'stopped'
    if (!wasManaged && (wasReady || wasRunning)) {
      // We only adopted an external ComfyUI — be honest instead of pretending we killed it.
      adopted = true
      ctx.pushLog(
        rt,
        'warn',
        'Stop requested for an adopted external process — it is still running outside ComfyPilot'
      )
    }
  }
  rt.managed = false
  ctx.emitStatus(rt)
  if (exited) forgetPid(id)
  const info = ctx.toInfo(rt) as InstanceStopResult
  if (adopted) info.adopted = true
  info.exited = exited
  return info
}

export async function restart(
  ctx: InstanceServiceContext,
  id: string,
  opts?: LaunchOptions
): Promise<ComfyInstanceInfo> {
  const rtBefore = ctx.runtimes.get(id)
  // 0.1.17 (WP3): tell the following start() that a stop is in progress, so it
  // waits for the port instead of adopting the process it just replaced.
  if (rtBefore) rtBefore.expectingStop = true
  await ctx.stop(id)
  // Wait until the EFFECTIVE port is free (0.2.5 WP1) so start() does not
  // race a dying process that listened on an argv-overridden port.
  const config = loadInstanceConfigs().find((c) => c.id === id)
  const port = config ? resolveEffectiveInstance(config).port : 8188
  for (let i = 0; i < 40; i++) {
    const check = await ctx.checkPort(port)
    if (check.available) break
    await new Promise((r) => setTimeout(r, 150))
  }
  // Restart must not return until the new process is actually ready.
  return ctx.launch(id, opts)
}

export async function forceKill(
  ctx: InstanceServiceContext,
  id: string
): Promise<InstanceStopResult> {
  const rt = ctx.runtimes.get(id)
  if (!rt) throw new Error(`Instance not found: ${id}`)
  rt.intentionalStop = true
  rt.generation += 1
  rt.lastExit = undefined
  const child = rt.process
  const pid = rt.pid
  const wasManaged = rt.managed
  // Snapshot readiness before clearReadyProbe zeroes it (same as stop()).
  const wasReady = rt.ready
  rt.process = undefined
  rt.pid = undefined
  clearReadyProbe(ctx, rt, 'Force killed')
  capabilityService.invalidate(id)
  let adopted = false
  let exited = true
  if (child) {
    await killProcessTree(child, { timeoutMs: 5000 })
    // killProcessTree is bounded. A process that ignored SIGKILL/taskkill is
    // still running; reporting a plain "stopped" would be a lie.
    exited = child.exitCode !== null
  } else if (pid && wasManaged) {
    // Only kill PID if we spawned it and no longer own a live child handle.
    exited = await killPidTree(pid)
  } else if (!wasManaged && (wasReady || rt.status === 'running')) {
    // Live external ComfyUI we refused to kill — tell the UI we only signalled state.
    adopted = true
    exited = false
    ctx.pushLog(
      rt,
      'warn',
      'Force-kill requested for an adopted external process — refusing to kill an unowned PID'
    )
  }
  rt.status = exited ? 'stopped' : 'error'
  rt.managed = false
  ctx.pushLog(
    rt,
    exited ? 'warn' : 'error',
    exited ? 'Force killed' : 'Force kill timed out — the process may still be running'
  )
  ctx.emitStatus(rt)
  if (exited) forgetPid(id)
  const info = ctx.toInfo(rt) as InstanceStopResult
  if (adopted) info.adopted = true
  info.exited = exited
  return info
}

/**
 * Best-effort tree kill of every live child (0.1.18 WP3).
 *
 * The old version called `child.kill()` (which on Windows only terminates the
 * direct process) and immediately forgot the PID — the grandchild ComfyUI
 * kept the port and VRAM, and the next boot had no ledger entry to sweep.
 * The ledger now survives until the process is confirmed gone; an unfinished
 * kill stays for the startup sweep.
 */
export function killAllNow(ctx: InstanceServiceContext): void {
  const tasks: Array<Promise<void>> = []
  for (const rt of ctx.runtimes.values()) {
    if (!rt.process) continue
    rt.intentionalStop = true
    rt.generation += 1
    clearReadyProbe(ctx, rt)
    const child = rt.process
    const id = rt.config.id
    rt.process = undefined
    rt.status = 'stopped'
    tasks.push(
      killProcessTree(child, { timeoutMs: 5000 }).then(() => {
        if (child.exitCode !== null) forgetPid(id)
      })
    )
  }
  // 0.1.18 (regression): only replace the in-flight quit promise when this
  // call actually had trees to kill. Tray Quit runs killAllNow() first; a
  // second call from killAllForQuit() must wait for THAT work, not overwrite
  // it with an already-resolved promise.
  if (tasks.length) {
    ctx.quitting = Promise.allSettled(tasks).then(() => undefined)
  }
}

/** Await quit kills with a hard budget so the app always exits. */
export async function killAllForQuit(ctx: InstanceServiceContext, budgetMs = 5000): Promise<void> {
  ctx.killAllNow()
  await Promise.race([ctx.quitting, new Promise<void>((resolve) => setTimeout(resolve, budgetMs))])
}
