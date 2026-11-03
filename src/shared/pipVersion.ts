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
  /** Environment marker (`; python_version < "3.12"`), when present. */
  marker?: string
  /** Original (trimmed) line. */
  raw: string
  /**
   * 0.2.2: PEP 508 direct reference (`name @ git+https://…`) or a bare VCS /
   * wheel URL. These can be installed by pip but cannot be version-checked
   * like a PyPI requirement; the audit verifies the distribution name only.
   */
  directUrl?: string
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

/** Infer a distribution name from a direct URL/VCS line (best effort). */
function inferDirectName(line: string): string | null {
  const egg = line.match(/[#&]egg=([A-Za-z0-9._-]+)/i)
  if (egg) return normalizePipName(egg[1])
  const noHash = line.split('#')[0].split('?')[0].replace(/\/+$/, '')
  const base = decodeURIComponent(noHash.split(/[\\/]/).pop() || '')
  if (!base || base === '.' || base === '..') return null
  if (/\.whl$/i.test(base)) {
    const wheel = base.replace(/\.whl$/i, '').split('-')[0]
    return wheel ? normalizePipName(wheel) : null
  }
  // git+https://host/org/repo.git@ref → repo
  const repo = base.replace(/@.*$/, '').replace(/\.git$/i, '')
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) ? normalizePipName(repo) : null
}

/**
 * Parse one requirements.txt line. Returns null for comments / options /
 * editable installs / unnameable URLs. Named direct references and VCS or
 * wheel URLs keep their inferred distribution name so the audit can check
 * whether they are installed instead of reporting them as permanently missing.
 */
export function parsePipRequirement(line: string): PipRequirement | null {
  let raw = String(line || '').trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('-')) return null
  // Inline comment (a `#` after whitespace is a comment per pip's grammar).
  const hash = raw.indexOf(' #')
  if (hash >= 0) raw = raw.slice(0, hash).trim()
  if (!raw) return null
  // 0.2.0: keep the environment marker for evaluation by the target
  // interpreter. Dropping it made every platform-specific requirement look
  // missing forever.
  let marker: string | undefined
  const semi = raw.indexOf(';')
  if (semi >= 0) {
    marker = raw.slice(semi + 1).trim() || undefined
    raw = raw.slice(0, semi).trim()
  }
  if (!raw) return null

  // PEP 508 direct reference: name[extras] @ URL.
  const direct = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([^\]]*)\])?\s*@\s*(\S+)$/)
  if (direct) {
    return {
      name: normalizePipName(direct[1]),
      extras: (direct[2] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      specifier: '',
      marker,
      raw,
      directUrl: direct[3]
    }
  }
  // Bare VCS or wheel URL. Other URLs stay unsupported because their package
  // name cannot be inferred reliably.
  if (/^(?:git|hg|svn|bzr)\+/i.test(raw) || /^https?:\/\/\S+\.whl(?:#.*)?$/i.test(raw)) {
    const name = inferDirectName(raw)
    if (!name) return null
    return { name, extras: [], specifier: '', marker, raw, directUrl: raw }
  }
  if (raw.includes('://') || raw.startsWith('.') || raw.startsWith('/')) return null

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
    marker,
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

interface ParsedVersion {
  epoch: number
  release: number[]
  /** 0=dev, 1=a, 2=b, 3=rc, 4=release, 5=post */
  phase: number
  phaseNum: number
  local: string
}

/**
 * PEP 440 parser for the subset that appears in ComfyUI custom-node
 * requirements. It is deliberately small but gets the ordering rules right:
 * dev < a < b < rc < release < post, trailing zeros are insignificant
 * (`1.0 == 1.0.0`), and local segments compare last.
 */
function parseVersion(v: string): ParsedVersion {
  let s = String(v || '')
    .trim()
    .toLowerCase()
  let epoch = 0
  const bang = s.indexOf('!')
  if (bang > 0 && /^\d+$/.test(s.slice(0, bang))) {
    epoch = Number(s.slice(0, bang))
    s = s.slice(bang + 1)
  }
  let local = ''
  const plus = s.indexOf('+')
  if (plus >= 0) {
    local = s.slice(plus + 1)
    s = s.slice(0, plus)
  }
  const m = s.match(
    /^(\d+(?:\.\d+)*)(?:(a|alpha|b|beta|c|rc|pre|preview)(\d*))?(?:\.?(post|rev|r)(\d*))?(?:\.?(dev)(\d*))?/
  )
  const release = (m?.[1] || '0').split('.').map((n) => Number(n) || 0)
  while (release.length > 1 && release[release.length - 1] === 0) release.pop()
  let phase = 4
  let phaseNum = 0
  if (m?.[6] === 'dev') {
    phase = 0
    phaseNum = Number(m[7] || 0)
  } else if (m?.[2]) {
    const pre = m[2]
    phase = pre === 'a' || pre === 'alpha' ? 1 : pre === 'b' || pre === 'beta' ? 2 : 3
    phaseNum = Number(m[3] || 0)
  } else if (m?.[4]) {
    phase = 5
    phaseNum = Number(m[5] || 0)
  }
  return { epoch, release, phase, phaseNum, local }
}

function compareLocal(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return -1
  if (!b) return 1
  const ta = tokenizeVersion(a)
  const tb = tokenizeVersion(b)
  const max = Math.max(ta.length, tb.length)
  for (let i = 0; i < max; i++) {
    const x = ta[i]
    const y = tb[i]
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

/**
 * Compare two version strings. Returns -1 / 0 / 1.
 * `1.0 == 1.0.0`, `1.0rc1 < 1.0`, `1.0 < 1.0.post1`, `1.0.dev1 < 1.0a1`.
 */
export function comparePipVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va.epoch !== vb.epoch) return va.epoch < vb.epoch ? -1 : 1
  const max = Math.max(va.release.length, vb.release.length)
  for (let i = 0; i < max; i++) {
    const x = va.release[i] ?? 0
    const y = vb.release[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (va.phase !== vb.phase) return va.phase < vb.phase ? -1 : 1
  if (va.phaseNum !== vb.phaseNum) return va.phaseNum < vb.phaseNum ? -1 : 1
  return compareLocal(va.local, vb.local)
}

export interface MarkerEnv {
  pythonVersion?: string
  sysPlatform?: string
  platformSystem?: string
  osName?: string
}

function markerValue(name: string, env: MarkerEnv): string | null {
  switch (name) {
    case 'python_version':
    case 'python_full_version':
      return env.pythonVersion || '3.13.18'
    case 'sys_platform':
      return (
        env.sysPlatform ||
        (process.platform === 'win32'
          ? 'win32'
          : process.platform === 'darwin'
            ? 'darwin'
            : 'linux')
      )
    case 'platform_system':
      return (
        env.platformSystem ||
        (process.platform === 'win32'
          ? 'Windows'
          : process.platform === 'darwin'
            ? 'Darwin'
            : 'Linux')
      )
    case 'os_name':
      return env.osName || (process.platform === 'win32' ? 'nt' : 'posix')
    default:
      // `extra` and implementation-specific markers are not decidable here.
      return null
  }
}

/**
 * Evaluate a PEP 508 environment marker. Returns null when the marker uses a
 * variable/operator this lightweight evaluator does not understand — callers
 * must treat null as "unknown", never as "missing".
 */
export function evaluateMarker(marker: string, env: MarkerEnv = {}): boolean | null {
  const text = String(marker || '').trim()
  if (!text) return true
  // Split only on top-level and/or (markers here are flat; parentheses are
  // handled by the conservative unknown fallback below).
  const parts = text.split(/\s+(and|or)\s+/i)
  if (parts.length > 1) {
    let result: boolean | null = evaluateMarker(parts[0], env)
    for (let i = 1; i < parts.length; i += 2) {
      const op = parts[i].toLowerCase()
      const rhs = evaluateMarker(parts[i + 1], env)
      if (op === 'and') {
        if (result === false || rhs === false) result = false
        else if (result === null || rhs === null) result = null
        else result = true
      } else {
        if (result === true || rhs === true) result = true
        else if (result === null || rhs === null) result = null
        else result = false
      }
    }
    return result
  }
  const m = text.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(===|==|!=|<=|>=|<|>|~=|not\s+in|in)\s*["']([^"']*)["']$/
  )
  if (!m) return null
  const name = m[1].toLowerCase()
  const value = markerValue(name, env)
  if (value === null) return null
  const op = m[2].replace(/\s+/g, ' ').toLowerCase()
  const want = m[3]
  if (op === 'in') return value.includes(want)
  if (op === 'not in') return !value.includes(want)
  // Platform/os markers are opaque strings, not PEP 440 versions. Comparing
  // `linux` and `win32` as versions made every string equality true.
  if (!name.startsWith('python_')) {
    if (op === '===' || op === '==') return value === want
    if (op === '!=') return value !== want
    if (op === '<') return value < want
    if (op === '<=') return value <= want
    if (op === '>') return value > want
    if (op === '>=') return value >= want
    return null
  }
  if (op === '===') return value === want
  if (op === '==') return comparePipVersions(value, want) === 0
  if (op === '!=') return comparePipVersions(value, want) !== 0
  if (op === '<') return comparePipVersions(value, want) < 0
  if (op === '<=') return comparePipVersions(value, want) <= 0
  if (op === '>') return comparePipVersions(value, want) > 0
  if (op === '>=') return comparePipVersions(value, want) >= 0
  if (op === '~=') {
    if (comparePipVersions(value, want) < 0) return false
    const partsWant = want.split('.')
    const prefix = partsWant.slice(0, Math.max(1, partsWant.length - 1)).join('.')
    return value === prefix || value.startsWith(prefix + '.')
  }
  return null
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
