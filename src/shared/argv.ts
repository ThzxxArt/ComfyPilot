/**
 * argv parsing/formatting for free-form ComfyUI launch arguments (0.2.0).
 *
 * The old UI used `split(/\s+/)`, which shredded `--base-directory "D:\My
 * Models"` into three arguments. This parser is deliberately shell-like but
 * cross-platform: single/double quotes group, backslashes are literal except
 * for escaped quotes, and an unclosed quote is a hard error (never a silent
 * truncation).
 */

export interface ParsedArgv {
  tokens: string[]
  errors: string[]
}

export function parseArgv(input: string): ParsedArgv {
  const text = String(input ?? '')
  const tokens: string[] = []
  const errors: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === '"') {
      if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        cur += text[i + 1]
        i++
      } else if (c === '"') {
        quote = null
      } else {
        cur += c
      }
      continue
    }
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started || cur) {
        tokens.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === "'" || text[i + 1] === ' ')) {
      cur += text[i + 1]
      started = true
      i++
      continue
    }
    cur += c
    started = true
  }
  if (quote) errors.push(`unclosed ${quote} quote`)
  if (started || cur) tokens.push(cur)
  return { tokens, errors }
}

const SAFE_SHELL_ARG = /^[A-Za-z0-9_./:=+,@%^~-]+$/

export function quoteArgvToken(token: string): string {
  const s = String(token ?? '')
  if (s && SAFE_SHELL_ARG.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function formatArgv(tokens: string[]): string {
  return (tokens || []).map(quoteArgvToken).join(' ')
}

/** Split `--flag=value` into its flag and value (value undefined for bare flags). */
export function splitFlagArg(token: string): { flag: string; value?: string } {
  const s = String(token || '')
  if (!s.startsWith('-')) return { flag: s }
  const eq = s.indexOf('=')
  if (eq < 0) return { flag: s }
  return { flag: s.slice(0, eq), value: s.slice(eq + 1) }
}
