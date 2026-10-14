/**
 * Lightweight PEP 440-ish helpers for dependency audits (0.1.12).
 *
 * ComfyPilot's "dependency audit" compares a pack's requirements.txt against
 * the installed package list. Full PEP 440 is out of scope; this module covers
 * the specifiers that actually appear in custom-node requirements:
 *   name, name[extra], name==1.2.3, name==2.2.*, name>=1.0, name<=2, name!=x,
 *   name~=1.4.2, comma-joined combinations, environment markers (`; …` are
 *   ignored — the audit is advisory, not installer-accurate).
 *
 * Comparison is token-based: numeric tokens compare numerically, alphabetic
 * tokens lexically; missing tokens count as 0; pre-release-ish suffixes sort
 * below their release (`1.0rc1 < 1.0`) which matches PEP 440 ordering for the
 * common cases. Epoch (`1!`) and local (`+cu130`) parts are handled.
 */

export interface PipRequirement {
  /** PEP 503-normalized name. */
  name: string
  /** Extras, e.g. `cuda` from `flash-attn[cuda]`. */
  extras: string[]
  /** Comma-joined specifier clauses WITHOUT the package name (`>=1,<2`). */
  specifier: string
  /** Original (trimmed) line. */
  raw: string
}

/** PEP 503 normalization: lowercase, runs of `-_.` → single `-`. */
export function normalizePipName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-')
}

/**
 * Strict package-spec validation for the user-facing "install missing package"
 * action (0.1.12). Only `name`, `name[extras]` and version specifiers are
 * allowed — NO URLs, paths, whitespace or shell metacharacters (URL installs
 * exist only in the curated recipe table, which pins hashes).
 */
const VALID_SPEC_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?((===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9._*+!-]+(,(===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9._*+!-]+)*)?$/

export function isValidPipSpec(spec: string): boolean {
  const s = String(spec || '').trim()
  if (!s || s.length > 200) return false
  return VALID_SPEC_RE.test(s)
}

const NAME_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)/
const EXTRAS_RE = /\[([^\]]*)\]/
const SPEC_RE = /(===|==|~=|!=|<=|>=|<|>)\s*([A-Za-z0-9.*+!_-]+)/g

/**
 * Parse one requirements.txt line. Returns null for comments / options / bare
 * URLs / VCS lines / editable installs — those cannot be audited by name.
 */
export function parsePipRequirement(line: string): PipRequirement | null {
  let raw = String(line || '').trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('-')) return null
  // Inline comment (a `#` after whitespace is a comment per pip's grammar).
  const hash = raw.indexOf(' #')
  if (hash >= 0) raw = raw.slice(0, hash).trim()
  if (!raw || raw.includes('://') || raw.startsWith('.') || raw.startsWith('/')) return null
  // Drop environment marker.
  const semi = raw.indexOf(';')
  if (semi >= 0) raw = raw.slice(0, semi).trim()

  const nameMatch = raw.match(NAME_RE)
  if (!nameMatch) return null
  const name = nameMatch[1]
  const after = raw.slice(name.length)

  let extras: string[] = []
  const ex = after.match(EXTRAS_RE)
  if (ex)
    extras = ex[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  // Specifiers can follow the extras (or the name directly).
  const specBody = ex ? after.slice((ex.index ?? 0) + ex[0].length) : after
  const clauses: string[] = []
  SPEC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SPEC_RE.exec(specBody))) {
    clauses.push(`${m[1]}${m[2]}`)
  }
  return {
    name: normalizePipName(name),
    extras,
    specifier: clauses.join(','),
    raw: raw
  }
}

interface VersionToken {
  kind: 'num' | 'alpha'
  num?: number
  text?: string
}

function tokenizeVersion(v: string): VersionToken[] {
  const out: VersionToken[] = []
  for (const part of String(v || '').match(/[0-9]+|[A-Za-z]+/g) || []) {
    if (/^[0-9]+$/.test(part)) out.push({ kind: 'num', num: Number(part) })
    else out.push({ kind: 'alpha', text: part.toLowerCase() })
  }
  return out
}

/** Strip epoch (`1!`) and local (`+cu130`) segments; keep them for compare. */
function splitVersion(v: string): { epoch: number; main: string; local: string } {
  let s = String(v || '').trim()
  let epoch = 0
  const bang = s.indexOf('!')
  if (bang > 0 && /^\d+$/.test(s.slice(0, bang))) {
    epoch = Number(s.slice(0, bang))
    s = s.slice(bang + 1)
  }
  const plus = s.indexOf('+')
  const local = plus >= 0 ? s.slice(plus + 1) : ''
  if (plus >= 0) s = s.slice(0, plus)
  return { epoch, main: s, local }
}

/**
 * Compare two version strings. Returns -1 / 0 / 1.
 * Ordering notes: numeric > alpha at the same position (1.0 > 1.0rc1);
 * a trailing pre-release token (`rc1`, `b2`, `a1`) sorts BELOW the bare
 * release (1.0rc1 < 1.0), matching PEP 440.
 */
export function comparePipVersions(a: string, b: string): number {
  const va = splitVersion(a)
  const vb = splitVersion(b)
  if (va.epoch !== vb.epoch) return va.epoch < vb.epoch ? -1 : 1
  const ta = tokenizeVersion(va.main)
  const tb = tokenizeVersion(vb.main)
  const max = Math.max(ta.length, tb.length)
  for (let i = 0; i < max; i++) {
    const x = ta[i]
    const y = tb[i]
    if (!x && !y) break
    if (!x) {
      // a ran out of tokens: if the remaining b token is a pre-release marker,
      // a is the bare release and wins; otherwise the shorter one is smaller.
      if (
        y &&
        y.kind === 'alpha' &&
        /^(a|b|c|rc|alpha|beta|pre|preview|post|dev)/.test(y.text || '')
      )
        return 1
      return -1
    }
    if (!y) {
      if (x.kind === 'alpha' && /^(a|b|c|rc|alpha|beta|pre|preview|post|dev)/.test(x.text || ''))
        return -1
      return 1
    }
    if (x.kind === 'num' && y.kind === 'num') {
      if (x.num !== y.num) return (x.num as number) < (y.num as number) ? -1 : 1
    } else if (x.kind === 'alpha' && y.kind === 'alpha') {
      const xs = x.text || ''
      const ys = y.text || ''
      if (xs !== ys) return xs < ys ? -1 : 1
    } else if (x.kind === 'num') {
      // numeric vs alpha: numeric wins (release > pre-release marker)
      return 1
    } else {
      return -1
    }
  }
  // Main parts equal — local version ordering: presence sorts after absence.
  if (va.local === vb.local) return 0
  if (!va.local) return -1
  if (!vb.local) return 1
  const la = tokenizeVersion(va.local)
  const lb = tokenizeVersion(vb.local)
  const lmax = Math.max(la.length, lb.length)
  for (let i = 0; i < lmax; i++) {
    const x = la[i]
    const y = lb[i]
    if (!x && !y) break
    if (!x) return -1
    if (!y) return 1
    if (x.kind === 'num' && y.kind === 'num') {
      if (x.num !== y.num) return (x.num as number) < (y.num as number) ? -1 : 1
    } else if (x.kind === 'alpha' && y.kind === 'alpha') {
      const xs = x.text || ''
      const ys = y.text || ''
      if (xs !== ys) return xs < ys ? -1 : 1
    } else if (x.kind === 'num') {
      return 1
    } else {
      return -1
    }
  }
  return 0
}

function satisfiesClause(installed: string, op: string, want: string): boolean {
  if (op === '===') return installed === want
  if (op === '==') {
    if (want.endsWith('.*')) {
      const prefix = want.slice(0, -2)
      return installed === prefix || installed.startsWith(prefix + '.')
    }
    return comparePipVersions(installed, want) === 0
  }
  if (op === '!=') {
    if (want.endsWith('.*')) {
      const prefix = want.slice(0, -2)
      return !(installed === prefix || installed.startsWith(prefix + '.'))
    }
    return comparePipVersions(installed, want) !== 0
  }
  if (op === '>=') return comparePipVersions(installed, want) >= 0
  if (op === '<=') return comparePipVersions(installed, want) <= 0
  if (op === '>') return comparePipVersions(installed, want) > 0
  if (op === '<') return comparePipVersions(installed, want) < 0
  if (op === '~=') {
    // ~=1.4.2  →  >=1.4.2 and ==1.4.*
    if (comparePipVersions(installed, want) < 0) return false
    const parts = want.split('.')
    const prefix = parts.slice(0, Math.max(1, parts.length - 1)).join('.')
    return installed === prefix || installed.startsWith(prefix + '.')
  }
  return true
}

/**
 * True when an installed version satisfies a comma-joined specifier string
 * (e.g. `>=1.2,<2`). Empty specifier → any installed version passes.
 * PEP 440 local-version rule: a specifier WITHOUT a local segment ignores the
 * installed version's local part (`2.9.0+cu130` satisfies `==2.9.0`).
 * Unparseable clauses are treated as satisfied (advisory audit, no false alarms).
 */
export function versionSatisfies(installed: string, specifier: string): boolean {
  const spec = String(specifier || '').trim()
  if (!spec) return true
  if (!installed) return false
  const base = spec.includes('+') ? String(installed) : String(installed).split('+')[0]
  for (const clause of spec.split(',')) {
    const m = clause.trim().match(/^(===|==|~=|!=|<=|>=|<|>)(.+)$/)
    if (!m) continue
    if (!satisfiesClause(base, m[1], m[2].trim())) return false
  }
  return true
}
