/**
 * 0.1.17 (WP1-5): one owner for "kill this child AND its descendants".
 *
 * On Windows `child.kill()` only signals the direct process — a python launcher
 * spawns `python.exe`, which spawns subprocesses, and the tree survives. Every
 * long-running child (install, update, pip streaming) must go through
 * `taskkill /T` so a cancelled install never leaves a worker holding the venv
 * directory open.
 */
import { execFile, execFileSync } from 'child_process'
import type { ChildProcess } from 'child_process'

/** True while `pid` exists (EPERM still means it exists). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 0.1.18 (review): SIGKILL is asynchronous. Returning immediately let callers
 * (stop/update/uninstall) delete a venv while the worker still held it open.
 * Wait for the process to actually disappear, or for the child's own exit
 * event — whichever comes first — bounded by `ms`.
 */
function waitForGone(child: ChildProcess, pid: number, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      resolve()
    }
    const poll = setInterval(() => {
      if (child.exitCode !== null || !isAlive(pid)) finish()
    }, 50)
    const deadline = setTimeout(finish, ms)
    try {
      child.once('exit', finish)
    } catch {
      /* a non-EventEmitter fake: the poll still bounds the wait */
    }
  })
}

/**
 * Resolve after the tree is gone (best effort — never throws).
 * `graceMs` asks the child to exit (SIGTERM) before the hard kill; Windows has
 * no graceful tree signal here, so it always goes straight to `taskkill /T /F`.
 */
export function killProcessTree(
  child: ChildProcess,
  opts?: { timeoutMs?: number; graceMs?: number; waitMs?: number }
): Promise<void> {
  const timeout = opts?.timeoutMs ?? 8000
  const grace = opts?.graceMs ?? 0
  return new Promise((resolve) => {
    const pid = child.pid
    if (!pid) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve()
      return
    }
    if (process.platform === 'win32') {
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout },
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
    // POSIX: children are not detached, so there is no process group to signal
    // (kill(-pid) would target an unrelated group on pid reuse). Descendants are
    // collected explicitly with `ps` — a Python launcher spawns python.exe which
    // spawns workers, and killing only the direct child left those alive.
    const descendants = (): number[] => {
      if (process.platform === 'darwin') return [] // `ps -o --ppid` is GNU-only
      try {
        const out = execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], {
          timeout: 1500,
          encoding: 'utf-8'
        })
        const direct = out
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== pid)
        const nested: number[] = []
        for (const d of direct) {
          try {
            const sub = execFileSync('ps', ['-o', 'pid=', '--ppid', String(d)], {
              timeout: 1000,
              encoding: 'utf-8'
            })
            for (const line of sub.split('\n')) {
              const n = Number(line.trim())
              if (Number.isInteger(n) && n > 0 && n !== d) nested.push(n)
            }
          } catch {
            /* best effort */
          }
        }
        return [...direct, ...nested]
      } catch {
        return []
      }
    }
    const waitMs = opts?.waitMs ?? 3000
    const sweep = (signal: NodeJS.Signals): void => {
      for (const p of descendants()) {
        try {
          process.kill(p, signal)
        } catch {
          /* already gone */
        }
      }
    }
    const killTreePosix = (signal: NodeJS.Signals): void => {
      sweep(signal)
      try {
        child.kill(signal)
      } catch {
        /* ignore */
      }
    }
    if (grace <= 0) {
      killTreePosix('SIGKILL')
      // Only resolve once the process is really gone (bounded by waitMs): a
      // caller may delete the venv right after this resolves.
      void waitForGone(child, pid, waitMs).then(() => {
        sweep('SIGKILL')
        resolve()
      })
      return
    }
    // Graceful first: ask the child to exit, escalate if it ignores us.
    if (child.exitCode !== null) {
      resolve()
      return
    }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(sweeper)
      resolve()
    }
    // New descendants can appear during the grace period (a launcher spawning
    // workers); keep sweeping instead of signalling the tree exactly once.
    const sweeper = setInterval(() => sweep('SIGTERM'), 100)
    const timer = setTimeout(() => {
      killTreePosix('SIGKILL')
      void waitForGone(child, pid, waitMs).then(() => {
        sweep('SIGKILL')
        finish()
      })
    }, grace)
    try {
      child.once('exit', () => {
        // The direct child exited; descendants it left behind must still die.
        sweep('SIGKILL')
        finish()
      })
    } catch {
      /* a non-EventEmitter fake: just wait for the timer */
    }
    killTreePosix('SIGTERM')
  })
}
