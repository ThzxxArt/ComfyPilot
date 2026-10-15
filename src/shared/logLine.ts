/**
 * Log-line classification shared by the main process (ingest) and the
 * renderer (display filtering) — 0.1.16.
 *
 * ComfyUI / Python / custom nodes write almost everything to STDERR (Python
 * `logging` defaults to stderr). The old ingest heuristic ("stderr ⇒ warn")
 * therefore painted every INFO/DEBUG line as a warning, and ANSI colour codes
 * leaked straight into the log text. This module fixes both:
 *
 *  - `stripAnsi` removes colour/control sequences before storage.
 *  - `classifyLogLine` trusts the line's OWN `[LEVEL]` token first and only
 *    falls back to severity-keyword / stream heuristics when none is present.
 *
 * Pure functions only — no I/O, no Electron — so both processes and the unit
 * tests can share one definition of "what level is this line".
 */
import type { ComfyLogLine } from './types'

export type LogLineLevel = ComfyLogLine['level']

/**
 * Matches ANSI escape sequences: CSI (`\u001B[...`), OSC and the common
 * single-character escapes. Equivalent in behaviour to the `ansi-regex`
 * package, inlined to avoid a runtime dependency.
 */
/* eslint-disable no-control-regex -- ANSI stripping needs the control-char class */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
  return String(text ?? '').replace(ANSI_PATTERN, '')
}

/** Bracketed level token at/near the start, e.g. `[INFO]`, `[WARNING]`, `[DEBUG]`. */
const LEVEL_TOKEN = /\[(trace|debug|info|warn(?:ing)?|error|critical|fatal)\]/i

/** Severity keywords for the no-token fallback (order matters: error first). */
const ERROR_HINT = /\b(error|traceback|exception|fatal|critical|modulenotfounderror)\b/i
const WARN_HINT = /\bwarn(?:ing)?\b/i

function tokenToLevel(token: string): LogLineLevel | null {
  const t = token.toLowerCase()
  if (t === 'trace' || t === 'debug') return 'debug'
  if (t === 'info') return 'info'
  if (t === 'warn' || t === 'warning') return 'warn'
  if (t === 'error' || t === 'critical' || t === 'fatal') return 'error'
  return null
}

/**
 * Decide a line's level from its content, using the emitting stream only as a
 * last-resort fallback. `raw` may contain ANSI codes; they are ignored.
 */
export function classifyLogLine(stream: 'stdout' | 'stderr', raw: string): LogLineLevel {
  const text = stripAnsi(raw)
  const token = LEVEL_TOKEN.exec(text)
  if (token) {
    const lvl = tokenToLevel(token[1])
    if (lvl) return lvl
  }
  if (ERROR_HINT.test(text)) return 'error'
  if (WARN_HINT.test(text)) return 'warn'
  // Nothing declared — stderr is *usually* diagnostics, stdout *usually* chatter.
  return stream === 'stderr' ? 'warn' : 'info'
}

/**
 * Known high-volume DEBUG chatter that ComfyUI/node packs emit per-file during
 * startup. Hidden by default in the log viewer (still stored verbatim) so the
 * terminal shows signal, not noise. The user can reveal them with a toggle.
 */
const NOISE_PATTERNS: RegExp[] = [
  /^\s*Trying to load custom node\b/i,
  /^\s*recursive file list on directory\b/i,
  /^\s*found \d+ files?\b/i,
  /^\s*Using proactor:/i,
  /^\s*setup plugin alembic\b/i,
  /^\s*Popen\(\[/i,
  /^\s*matplotlib data path:/i,
  /^\s*CONFIGDIR=/i,
  /^\s*CACHEDIR=/i,
  /^\s*interactive is False\b/i,
  /^\s*platform is win32\b/i,
  /^\s*Using fontManager instance from\b/i,
  /^\s*Loaded backend Agg version\b/i,
  /^\s*DWPose:\s/i
]

/** True when a line is pure debug noise that the viewer hides by default. */
export function isNoiseLogLine(level: LogLineLevel, message: string): boolean {
  if (level === 'debug') return true
  // Drop a leading `[LEVEL]` token so patterns match the payload text.
  const text = stripAnsi(message)
    .replace(/^\s*\[[a-z]+\]\s*/i, '')
    .trim()
  if (!text) return false
  return NOISE_PATTERNS.some((re) => re.test(text))
}
