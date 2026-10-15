/**
 * Bounded instance-log file access (0.1.16).
 *
 * Instance logs used to grow without limit and `getLogs`/`readLogFile` read
 * the WHOLE file synchronously (and re-parsed every line) on every status
 * event — a long-running instance could make the main process stutter badly.
 * These helpers keep both ends bounded: reads take only the tail, writes
 * rotate once the file exceeds a size limit.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'

/** Rotate the live log once it reaches this size. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024
/** Maximum bytes `readTextTail` will pull from a file. */
export const MAX_LOG_READ_BYTES = 2 * 1024 * 1024

/**
 * Read at most `maxBytes` from the END of a UTF-8 file. A partial first line
 * (when the tail started mid-line) is dropped. Returns '' when the file is
 * missing or unreadable.
 */
export function readTextTail(file: string, maxBytes: number): string {
  let fd: number | undefined
  try {
    if (!existsSync(file)) return ''
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size <= 0) return ''
    const start = Math.max(0, size - Math.max(0, maxBytes))
    const length = size - start
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, start)
    let text = buf.toString('utf-8')
    // If we started mid-file, the first line may be truncated — drop it.
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    return text
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Rotate `file` → `file.1` → … when it exceeds `limit`. At most `keep`
 * archives are retained. Returns true when a rotation happened.
 */
export function rotateLogIfTooLarge(file: string, limit = LOG_ROTATE_BYTES, keep = 1): boolean {
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size < limit) return false
    for (let i = keep; i >= 1; i--) {
      const dst = `${file}.${i}`
      const src = i === 1 ? file : `${file}.${i - 1}`
      try {
        if (existsSync(dst)) rmSync(dst)
      } catch {
        /* ignore */
      }
      try {
        if (existsSync(src)) renameSync(src, dst)
      } catch {
        /* ignore */
      }
    }
    return true
  } catch {
    return false
  }
}
