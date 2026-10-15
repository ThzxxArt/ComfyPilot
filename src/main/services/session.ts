/**
 * Session liveness + app-level diagnostics (0.1.16).
 *
 * The app previously had no way to prove how a run had ended: a silent exit
 * left no OS event, no dump and no log line. This module writes a small
 * `<logsDir>/session.json` on start (cleanExit=false) and flips it to
 * cleanExit=true on a clean quit, so the NEXT launch can tell whether the
 * previous session died unexpectedly and offer a diagnostics export.
 *
 * Pure fs + Electron `app` — no windows, no timers.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { PreviousExitInfo } from '@shared/types'
import { logsDir, userDataDir } from './db'

interface SessionFile {
  pid?: number
  startedAt?: number
  endedAt?: number
  cleanExit?: boolean
  detail?: string
}

const SESSION_FILE = 'session.json'

function sessionPath(): string {
  return join(logsDir(), SESSION_FILE)
}

function readSession(): SessionFile | null {
  try {
    const p = sessionPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf-8')) as SessionFile
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

function writeSession(data: SessionFile): void {
  try {
    writeFileSync(sessionPath(), JSON.stringify(data, null, 2), 'utf-8')
  } catch {
    /* best effort — liveness tracking must never break startup/quit */
  }
}

/** Last derived previous-exit fact (populated by `markSessionStart`). */
let previousExit: PreviousExitInfo = { clean: true, startedAt: null, endedAt: null }

/**
 * Record the start of the current session and return how the previous one
 * ended. Call once on app ready. `now` is injectable for tests.
 */
export function markSessionStart(now = Date.now()): PreviousExitInfo {
  const prior = readSession()
  previousExit = prior
    ? {
        clean: prior.cleanExit === true,
        startedAt: prior.startedAt ?? null,
        endedAt: prior.endedAt ?? null,
        detail: prior.detail
      }
    : { clean: true, startedAt: null, endedAt: null }
  writeSession({ pid: process.pid, startedAt: now, cleanExit: false })
  return previousExit
}

export function getPreviousExitInfo(): PreviousExitInfo {
  return previousExit
}

/** Flip the current session marker to a clean exit. Call from before-quit. */
export function markSessionCleanExit(now = Date.now()): void {
  const cur = readSession() || {}
  writeSession({ ...cur, endedAt: now, cleanExit: true })
}

/** Persist a crash/fatal reason onto the session marker (kept even if we exit). */
export function recordCrashDetail(detail: string): void {
  try {
    const cur = readSession() || {}
    writeSession({ ...cur, cleanExit: false, detail: String(detail).slice(0, 2000) })
  } catch {
    /* ignore */
  }
}

/**
 * Bundle logs + session + runtime facts into a diagnostics folder and return
 * its path. Boot log is capped so the export stays small.
 */
export function exportAppDiagnostics(now = Date.now()): string {
  const dir = join(userDataDir(), 'diagnostics', `app-${now}`)
  mkdirSync(dir, { recursive: true })
  try {
    const s = sessionPath()
    if (existsSync(s)) writeFileSync(join(dir, 'session.json'), readFileSync(s))
  } catch {
    /* ignore */
  }
  try {
    const boot = join(logsDir(), 'boot.log')
    if (existsSync(boot)) {
      const tail = readFileSync(boot, 'utf-8').split('\n').slice(-3000).join('\n')
      writeFileSync(join(dir, 'boot.log'), tail, 'utf-8')
    }
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify(
        {
          appVersion: app.getVersion?.() ?? '',
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
          pid: process.pid,
          execPath: process.execPath,
          resourcesPath: process.resourcesPath,
          memory: process.memoryUsage(),
          createdAt: now
        },
        null,
        2
      ),
      'utf-8'
    )
  } catch {
    /* ignore */
  }
  try {
    appendFileSync(
      join(logsDir(), 'boot.log'),
      `[${new Date(now).toISOString()}] diagnostics exported: ${dir}\n`
    )
  } catch {
    /* ignore */
  }
  return dir
}
