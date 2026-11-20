/**
 * Out-of-band instance control (0.2.5 WP3).
 *
 * `ComfyPilot.exe --rescue <id>` is the lock-screen escape hatch: the second
 * process cannot get the single-instance lock, so it forwards argv to the
 * running app via `second-instance`. Only a fixed command set is accepted —
 * never an arbitrary shell command.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { InstanceHealth, InstanceStatus } from '@shared/types'
import { instanceService } from './services/instance'
import { instanceHealthService } from './services/instance/health'
import { logsDir, loadInstanceConfigs, userDataDir } from './services/db'
import { sanitizeId } from './services/security'

export type ControlAction = 'rescue' | 'safe-rescue' | 'stop' | 'start' | 'status'

export interface ControlCommand {
  action: ControlAction
  instanceId?: string
}

export interface ControlResult {
  ok: boolean
  action: ControlAction
  instanceId?: string
  status?: InstanceStatus
  exited?: boolean
  merged?: boolean
  error?: string
  statuses?: Array<{ id: string; name: string; status: InstanceStatus; health?: InstanceHealth }>
}

const ACTIONS = new Set<ControlAction>(['rescue', 'safe-rescue', 'stop', 'start', 'status'])

/** Parse only the documented flags; anything else is a normal app launch. */
export function parseControlArgv(argv: string[]): ControlCommand | null {
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i] ?? '')
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    const flag = eq > 2 ? raw.slice(2, eq) : raw.slice(2)
    const inline = eq > 2 ? raw.slice(eq + 1) : undefined
    if (flag === 'status') return { action: 'status' }
    if (!ACTIONS.has(flag as ControlAction)) continue
    const value = inline ?? argv[i + 1]
    return {
      action: flag as ControlAction,
      instanceId: value && !String(value).startsWith('--') ? String(value) : undefined
    }
  }
  return null
}

const cooldownMs = 30_000
const lastAttempt = new Map<string, { at: number; result: ControlResult }>()
const inflight = new Map<string, Promise<ControlResult>>()

function controlLog(line: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
    appendFileSync(join(logsDir(), 'control.log'), `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    /* control logging must never break the command */
  }
}

function writeStatus(statuses: ControlResult['statuses']): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
    writeFileSync(
      join(logsDir(), 'control-status.json'),
      JSON.stringify({ at: Date.now(), statuses }, null, 2),
      'utf-8'
    )
  } catch {
    /* best-effort */
  }
}

function reject(action: ControlAction, instanceId: string | undefined, error: string): ControlResult {
  const result: ControlResult = { ok: false, action, instanceId, error }
  controlLog(`${action} ${instanceId || '-'} rejected: ${error}`)
  return result
}

async function runCommand(cmd: ControlCommand): Promise<ControlResult> {
  const action = cmd.action
  if (action === 'status') {
    const statuses = loadInstanceConfigs().map((c) => {
      const info = instanceService.list().find((i) => i.id === c.id)
      return {
        id: c.id,
        name: c.name,
        status: info?.status ?? 'unknown',
        health: instanceHealthService.get(c.id)
      }
    })
    writeStatus(statuses)
    controlLog('status ok')
    return { ok: true, action, statuses }
  }

  const rawId = String(cmd.instanceId || '')
  if (!rawId) return reject(action, undefined, 'Missing instance id')
  if (rawId.startsWith('remote:')) return reject(action, rawId, 'Remote instances cannot be rescued')
  const id = sanitizeId(rawId)
  if (id !== rawId) return reject(action, rawId, 'Invalid instance id')
  const info = instanceService.list().find((i) => i.id === id)
  if (!info) return reject(action, id, `Unknown instance: ${id}`)
  if (info.status === 'starting') return reject(action, id, 'Instance is still starting')

  const rt = (
    instanceService as unknown as {
      runtimes: Map<string, { managed: boolean; process?: unknown; ready?: boolean }>
    }
  ).runtimes.get(id)
  const adoptedExternal = Boolean(rt && !rt.managed && rt.ready && !rt.process)
  if (adoptedExternal) {
    return reject(action, id, 'Adopted external instances are never stopped or restarted')
  }

  if (action === 'stop') {
    const stopped = await instanceService.stop(id)
    const ok = stopped.exited !== false
    const result: ControlResult = {
      ok,
      action,
      instanceId: id,
      status: stopped.status,
      exited: stopped.exited
    }
    controlLog(
      `stop ${id} ${ok ? 'ok' : 'did-not-exit'} (exited=${String(stopped.exited)})` +
        (ok ? '' : ' — refusing to report success')
    )
    return result
  }

  if (action === 'start') {
    if (info.status === 'running') return reject(action, id, 'Instance is already running')
    const started = await instanceService.launch(id)
    controlLog(`start ${id} ok`)
    return { ok: true, action, instanceId: id, status: started.status, exited: true }
  }

  // rescue / safe-rescue
  const now = Date.now()
  const previous = lastAttempt.get(id)
  if (previous && now - previous.at < cooldownMs) {
    controlLog(`${action} ${id} merged into recent attempt`)
    return { ...previous.result, merged: true }
  }
  const killed = await instanceService.forceKill(id)
  if (killed.exited === false) {
    const result = reject(action, id, 'Process did not exit — refusing to launch a second copy')
    controlLog(`rescue ${id} aborted: process still alive`)
    return result
  }
  const launched = await instanceService.launch(id, { safeMode: action === 'safe-rescue' })
  const result: ControlResult = {
    ok: true,
    action,
    instanceId: id,
    status: launched.status,
    exited: true
  }
  lastAttempt.set(id, { at: now, result })
  controlLog(`${action} ${id} ok (safeMode=${action === 'safe-rescue'})`)
  return result
}

/** Execute one control command with 30s per-instance coalescing. */
export async function executeControlCommand(cmd: ControlCommand): Promise<ControlResult> {
  const key = `${cmd.action}:${cmd.instanceId || ''}`
  const running = inflight.get(key)
  if (running) return { ...(await running), merged: true }
  const p = runCommand(cmd)
    .catch((err) => reject(cmd.action, cmd.instanceId, err instanceof Error ? err.message : String(err)))
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Write a double-clickable rescue script for the current user. */
export function exportRescueScript(instanceId: string): { path: string } {
  const id = sanitizeId(instanceId)
  const info = instanceService.list().find((i) => i.id === id)
  if (!info) throw new Error(`Unknown instance: ${id}`)
  const dir = join(userDataDir(), 'control')
  mkdirSync(dir, { recursive: true })
  const exe = process.execPath
  const bat = [
    '@echo off',
    'REM ComfyPilot rescue script — works from the Windows lock screen.',
    `"${exe}" --rescue ${JSON.stringify(id)}`,
    'if errorlevel 1 pause',
    ''
  ].join('\r\n')
  const target = join(dir, `rescue-${id}.bat`)
  writeFileSync(target, bat, 'utf-8')
  controlLog(`exported rescue script ${target}`)
  return { path: target }
}

// ---------- automatic recovery (WP3) ----------

interface RecoveryState {
  timer?: NodeJS.Timeout
  attempts: number[]
  circuitOpenUntil?: number
}

const recoveryStates = new Map<string, RecoveryState>()

/**
 * Default policy is notify-only. When the user opts in, a sustained
 * `unresponsive` state triggers a bounded restart; adopted external instances
 * and instances with running jobs (unless explicitly allowed) are never killed.
 */
export function noteHealthForRecovery(health: InstanceHealth): void {
  const policy = instanceHealthService.recoveryPolicy()
  const state = recoveryStates.get(health.instanceId) ?? { attempts: [] }
  recoveryStates.set(health.instanceId, state)
  if (!policy.enabled || health.state !== 'unresponsive') {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    return
  }
  if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) return
  const now = Date.now()
  state.attempts = state.attempts.filter((t) => now - t < 10 * 60 * 1000)
  if (state.attempts.length >= policy.maxAttempts) {
    state.circuitOpenUntil = now + policy.cooldownMs
    controlLog(`recovery ${health.instanceId} circuit open after ${state.attempts.length} attempts`)
    return
  }
  if (health.queueRunning > 0 && !policy.killRunningJobs) {
    controlLog(`recovery ${health.instanceId} skipped: queue is running`)
    return
  }
  if (state.timer) return
  const wait = Math.max(0, health.since + policy.afterMs - now)
  state.timer = setTimeout(() => {
    state.timer = undefined
    const latest = instanceHealthService.get(health.instanceId)
    if (!latest || latest.state !== 'unresponsive') return
    state.attempts.push(Date.now())
    controlLog(`recovery ${health.instanceId} attempting ${policy.action}`)
    void executeControlCommand({
      action: policy.action === 'safe-restart' ? 'safe-rescue' : 'rescue',
      instanceId: health.instanceId
    }).then((r) => {
      if (!r.ok) controlLog(`recovery ${health.instanceId} failed: ${r.error || 'unknown'}`)
    })
  }, Math.min(wait, policy.cooldownMs))
  state.timer.unref?.()
}

export function resetRecoveryStateForTest(): void {
  for (const state of recoveryStates.values()) if (state.timer) clearTimeout(state.timer)
  recoveryStates.clear()
  lastAttempt.clear()
  inflight.clear()
}
