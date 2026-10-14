/**
 * Runtime execution-error parsing (0.1.12).
 *
 * ComfyUI prints execution failures to the console as:
 *   `!!! Exception during processing !!! <short reason>`   (execution.py:639 in 0.40)
 * followed by a Python traceback block. This module turns that raw text into
 * structured facts — error type, message, missing module, owning custom-node
 * folder — so the UI can explain "which node/pack, which module is missing"
 * and offer a fix (pip install / recipe) instead of a wall of log lines.
 *
 * Hard rules:
 * - Facts only: every field comes from an actual matched line, never guessed.
 * - ANSI escapes (ComfyUI's ColoredFormatter writes them unconditionally) are
 *   stripped before matching.
 * - Attribution uses the traceback file paths (`custom_nodes\<Folder>\…`).
 */
import type { ComfyLogLine } from './types'

export interface ParsedExecError {
  /** Timestamp of the trigger line. */
  at: number
  errorType: string
  message: string
  /** Extracted from `No module named 'x'` when present. */
  missingModule?: string
  /** custom_nodes sub-folder the failing file lives in (pack attribution). */
  packFolder?: string
  /** ANSI-stripped follow-up lines of the block (bounded, includes traceback). */
  traceback: string[]
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return String(text || '').replace(ANSI_RE, '')
}

const TRIGGER_RE = /!!!\s*Exception during processing\s*!!!\s*(.*)$/i
/** Python exception line: `ModuleNotFoundError: No module named 'x'`. */
const EXC_LINE_RE =
  /^([A-Za-z_][A-Za-z0-9_.]*Error|Exception[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*Exception)\s*:\s*(.*)$/
const MISSING_MODULE_RE = /No module named\s+['"]([^'"]+)['"]/i
/** Windows + POSIX traceback file paths inside custom_nodes. */
const NODE_FILE_RE = /File\s+"([^"]*custom_nodes[\\/][^\\/"]+[\\/][^"]*)"/i
/** Block terminators — a fresh log statement that is NOT part of the traceback. */
const BLOCK_END_RE = /^(Prompt executed|got prompt|Startup|ComfyUI ready)\b/i
/** Leveled lines after ANSI strip look like `[INFO] …` / `[DEBUG] …`. */
const LEVELED_RE = /^\[(INFO|DEBUG|WARNING|DETAIL)\]\s/
/**
 * ComfyUI's logger prefixes EVERY record with `[LEVEL] ` (app/logger.py).
 * The first traceback line and the final exception line carry that prefix —
 * matching must strip it (the raw text stays in the traceback output).
 */
const LEVEL_PREFIX_RE = /^\s*\[(ERROR|WARNING|INFO|DEBUG|CRITICAL|DETAIL)\]\s*/
const MAX_BLOCK_LINES = 200
const MAX_BLOCK_MS = 20_000

function firstCustomNodeFolder(path: string): string | undefined {
  const m = path.match(/custom_nodes[\\/]([^\\/]+)/i)
  return m ? m[1] : undefined
}

/**
 * Parse a log slice into structured execution errors (oldest → newest).
 * Multiple failures inside one slice produce multiple entries.
 */
export function parseExecErrors(lines: ComfyLogLine[] | string[]): ParsedExecError[] {
  const norm: Array<{ ts: number; text: string }> = []
  for (const l of lines || []) {
    if (typeof l === 'string') norm.push({ ts: 0, text: stripAnsi(l) })
    else norm.push({ ts: l.ts || 0, text: stripAnsi(l.message || '') })
  }

  const out: ParsedExecError[] = []
  const clean = (t: string): string => t.replace(LEVEL_PREFIX_RE, '')
  for (let i = 0; i < norm.length; i++) {
    const trigger = clean(norm[i].text).match(TRIGGER_RE)
    if (!trigger) continue
    const at = norm[i].ts || Date.now()
    const tail = (trigger[1] || '').trim()

    // Collect the block: up to the first line that clearly belongs to a new
    // log statement (fresh leveled INFO/DEBUG, "Prompt executed", another
    // trigger) or after a wall-clock gap (tracebacks print within seconds).
    const block: Array<{ ts: number; text: string }> = []
    for (let j = i + 1; j < norm.length && block.length < MAX_BLOCK_LINES; j++) {
      const line = norm[j]
      if (line.ts && at && line.ts - at > MAX_BLOCK_MS) break
      if (TRIGGER_RE.test(clean(line.text))) break
      if (BLOCK_END_RE.test(clean(line.text))) break
      // A leveled INFO/DEBUG/WARNING line only ends the block when it is NOT a
      // traceback continuation (`File "…"`, `  …`, `Traceback`, `  ^^^`).
      if (
        LEVELED_RE.test(line.text) &&
        !/^\[(INFO|DEBUG|WARNING)\]\s*(Traceback|\s|File |\^|\w+Error|Exception)/.test(line.text)
      ) {
        break
      }
      block.push(line)
    }

    // Exception line: the LAST `<Something>Error: msg` in the block (PEP
    // tracebacks end with the exception). Fall back to the trigger tail.
    let errorType = ''
    let message = ''
    for (const line of block) {
      const m = clean(line.text).match(EXC_LINE_RE)
      if (m) {
        errorType = m[1]
        message = m[2].trim()
      }
    }
    if (!errorType && tail) {
      const m = tail.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*:\s*(.*)$/)
      if (m) {
        errorType = m[1]
        message = m[2].trim()
      } else {
        errorType = 'Exception'
        message = tail
      }
    }
    if (!errorType) continue

    let missingModule: string | undefined
    let packFolder: string | undefined
    for (const line of block) {
      if (!missingModule) {
        const mm = line.text.match(MISSING_MODULE_RE)
        if (mm) missingModule = mm[1]
      }
      if (!packFolder) {
        const nf = line.text.match(NODE_FILE_RE)
        if (nf) packFolder = firstCustomNodeFolder(nf[1])
      }
    }
    if (!missingModule) {
      const mm = (message || tail).match(MISSING_MODULE_RE)
      if (mm) missingModule = mm[1]
    }

    out.push({
      at,
      errorType,
      message: message || tail || errorType,
      missingModule,
      packFolder,
      traceback: block
        .map((b) => b.text)
        .filter((t) => t.trim())
        .slice(0, 60)
    })
    i = i + block.length // continue after the consumed block
  }
  return out
}

/** Human-readable failure report for clipboard / diagnostics. */
export function formatExecErrorReport(e: {
  at: number
  errorType: string
  message: string
  missingModule?: string
  packFolder?: string
  nodeType?: string
  nodeId?: string
  promptId?: string
  traceback?: string[]
}): string {
  const lines = [
    `Execution failed at ${new Date(e.at).toISOString()}`,
    `Type: ${e.errorType}`,
    `Message: ${e.message}`
  ]
  if (e.missingModule) lines.push(`Missing module: ${e.missingModule}`)
  if (e.packFolder) lines.push(`Custom node pack: ${e.packFolder}`)
  if (e.nodeType) lines.push(`Node: ${e.nodeType}${e.nodeId ? ` (id ${e.nodeId})` : ''}`)
  if (e.promptId) lines.push(`Prompt: ${e.promptId}`)
  if (e.traceback?.length) lines.push('', '--- traceback ---', ...e.traceback)
  return lines.join('\n')
}
