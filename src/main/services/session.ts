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
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'fs'
import { dirname, join } from 'path'
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

/**
 * 0.2.0: atomic + fsync. A crash in the middle of `writeFileSync` used to leave
 * a truncated session.json; the next launch then treated a real crash as a
 * clean exit (or vice versa). Write to a sibling temp file, fsync it, then
 * rename over the target.
 */
function writeSession(data: SessionFile): void {
  const target = sessionPath()
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  let fd: number | undefined
  try {
    mkdirSync(dirname(target), { recursive: true })
    fd = openSync(tmp, 'w')
    writeSync(fd, JSON.stringify(data, null, 2), null, 'utf-8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, target)
  } catch {
    /* best effort — liveness tracking must never break startup/quit */
    try {
      if (fd !== undefined) closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
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
  // 0.1.17 (WP6): ship the slow-IPC attribution log with the diagnostics so a
  // freeze report has its channel/duration evidence attached.
  try {
    const slow = join(logsDir(), 'slow-ops.log')
    if (existsSync(slow)) {
      const tail = readFileSync(slow, 'utf-8').split('\n').slice(-1000).join('\n')
      writeFileSync(join(dir, 'slow-ops.log'), tail, 'utf-8')
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
