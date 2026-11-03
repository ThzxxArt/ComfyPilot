/**
 * Dependency audit domain module (0.2.0).
 *
 * Pure-ish collectors + one evaluator. Kept out of nodePack.ts so the audit
 * grammar (markers, -r includes, extras, aliases, pyproject) is testable and
 * the install path and audit path share the same package-list parser.
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { NodeDepsAuditPack, NodeDepsAuditUnverifiable, NodePackRecord } from '@shared/types'
import {
  evaluateMarker,
  parsePipRequirement,
  versionSatisfies,
  type PipRequirement
} from '@shared/pipVersion'
import { pipAliasCandidates } from '@shared/pipAliases'
import { throwingExec } from './env'
import { bootstrapService } from './bootstrap'

/** pip list JSON can be preceded by stderr noise; extract the array. */
export function parsePipListJson(text: string): Map<string, string> | null {
  const source = String(text || '')
  const start = source.indexOf('[')
  const end = source.lastIndexOf(']')
  const json = start >= 0 && end > start ? source.slice(start, end + 1) : source.trim() || '[]'
  try {
    const raw = JSON.parse(json) as Array<{ name?: unknown; version?: unknown }>
    if (!Array.isArray(raw)) return null
    const map = new Map<string, string>()
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const name =
        typeof item.name === 'string' ? item.name.toLowerCase().replace(/[-_.]+/g, '-') : ''
      const version = typeof item.version === 'string' ? item.version : ''
      if (name) map.set(name, version)
    }
    return map
  } catch {
    return null
  }
}

/**
 * pip options that configure the installer rather than name a package. They
 * must not become “unsupported dependencies” and keep a pack in the audit
 * forever.
 */
const PIP_OPTION_RE =
  /^(?:-i|--index-url|--extra-index-url|--no-index|-f|--find-links|--trusted-host|--no-binary|--only-binary|--prefer-binary|--pre|--require-hashes|--hash|--no-deps|--upgrade|--force-reinstall|--no-cache-dir|--timeout|--retries|--proxy|--cert|--client-cert)\b/i

/**
 * Read requirements recursively: comments, backslash continuations, `-r` and
 * `-c` includes. URL/VCS lines are returned raw so the caller can report them
 * as unsupported instead of silently dropping them.
 */
export function readRequirementLines(file: string, depth = 0, seen = new Set<string>()): string[] {
  if (depth > 5 || seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  let text = ''
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  text = text.replace(/\\\r?\n/g, ' ')
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // `-r` includes are requirements and are audited recursively. `-c`
    // constraints only bound versions; they are not packages to install, so
    // treating them as requirements produced false "missing" rows.
    const inc = trimmed.match(/^(?:-r|--requirement)\s+(.+)$/i)
    if (inc) {
      const target = inc[1].trim().replace(/^["']|["']$/g, '')
      out.push(...readRequirementLines(join(dirname(file), target), depth + 1, seen))
      continue
    }
    if (/^(?:-c|--constraint)\s+/i.test(trimmed)) continue
    if (PIP_OPTION_RE.test(trimmed)) continue
    out.push(line)
  }
  return out
}

/** Parse a minimal `dependencies = ["a>=1", "b"]` array from pyproject.toml. */
export function readPyprojectDependencies(file: string): string[] {
  if (!existsSync(file)) return []
  try {
    const text = readFileSync(file, 'utf-8')
    const block = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/i)
    if (!block) return []
    const out: string[] = []
    const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(block[1]))) {
      const raw = m[1] ?? m[2] ?? ''
      out.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    }
    return out
  } catch {
    return []
  }
}

export function requirementsForPack(pack: NodePackRecord): {
  reqs: PipRequirement[]
  unsupported: string[]
  sources: string[]
} {
  if (!pack.path) return { reqs: [], unsupported: [], sources: [] }
  const files: string[] = []
  const reqFile = join(pack.path, 'requirements.txt')
  if (existsSync(reqFile)) files.push(reqFile)
  const pyproject = join(pack.path, 'pyproject.toml')
  const pyDeps = readPyprojectDependencies(pyproject)
  const lines: string[] = []
  for (const file of files) lines.push(...readRequirementLines(file))
  lines.push(...pyDeps)
  const reqs: PipRequirement[] = []
  const unsupported: string[] = []
  for (const line of lines) {
    const parsed = parsePipRequirement(line)
    if (parsed) reqs.push(parsed)
    else if (line.trim()) unsupported.push(line.trim())
  }
  return { reqs, unsupported, sources: [...files, ...(pyDeps.length ? [pyproject] : [])] }
}

export async function installedPackages(python: string): Promise<Map<string, string> | null> {
  try {
    const bootstrap = await bootstrapService.ensure({ kinds: ['uv'], downloadIfMissing: false })
    const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
    if (uvComp?.path) {
      try {
        const out = await throwingExec(
          uvComp.path,
          ['pip', 'list', '--python', python, '--format', 'json'],
          { timeout: 60000 }
        )
        const parsed = parsePipListJson(out)
        if (parsed) return parsed
      } catch {
        /* older uv without JSON — fall through to pip */
      }
    }
    const out = await throwingExec(python, ['-m', 'pip', 'list', '--format=json'], {
      timeout: 60000
    })
    return parsePipListJson(out)
  } catch {
    return null
  }
}

export interface PipCheckResult {
  ok: boolean
  broken: string[]
}

/** `pip check` catches transitive conflicts that a per-requirement audit misses. */
export async function pipCheck(python: string, uvPath?: string): Promise<PipCheckResult> {
  // uv-created venvs may have no pip at all. Prefer uv when the caller did not
  // supply it instead of silently returning "no conflicts" for a check that
  // never ran (0.2.2).
  let uv = uvPath
  if (!uv) {
    try {
      const bootstrap = await bootstrapService.ensure({ kinds: ['uv'], downloadIfMissing: false })
      uv = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)?.path
    } catch {
      /* pip fallback below */
    }
  }
  try {
    const out = uv
      ? await throwingExec(uv, ['pip', 'check', '--python', python], { timeout: 60000 })
      : await throwingExec(python, ['-m', 'pip', 'check'], { timeout: 60000 })
    const broken = String(out || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return { ok: broken.length === 0, broken }
  } catch (err) {
    // A non-zero exit includes the broken lines in stderr on pip; throwingExec
    // rejects. Treat the message as the report rather than as "unknown".
    const text = err instanceof Error ? err.message : String(err)
    const unavailable =
      /No module named ['"]?pip|pip is not available|\bENOENT\b|not recognized/i.test(text)
    if (unavailable) {
      return { ok: false, broken: [`pip check unavailable: ${text.slice(0, 240)}`] }
    }
    const broken = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /\brequires\b|\bnot installed\b|\bconflict\b/i.test(l))
    return { ok: broken.length === 0 && !/broken requirements/i.test(text), broken }
  }
}

export interface AuditPackResult {
  /** Packs with actionable missing / mismatched declarations. */
  packs: NodeDepsAuditPack[]
  /** Packs whose only leftovers are Git/URL/local refs we cannot verify. */
  unverifiable: NodeDepsAuditUnverifiable[]
}

export function auditPackRequirements(
  targets: Array<{ pack: NodePackRecord; reqs: PipRequirement[]; unsupported?: string[] }>,
  installed: Map<string, string>
): AuditPackResult {
  const packs: NodeDepsAuditPack[] = []
  const unverifiable: NodeDepsAuditUnverifiable[] = []
  for (const { pack, reqs, unsupported } of targets) {
    const missing: string[] = []
    const mismatched: NodeDepsAuditPack['mismatched'] = []
    const skipped: string[] = []
    const unsupportedLines = [...new Set((unsupported || []).map((s) => s.trim()).filter(Boolean))]
    for (const r of reqs) {
      if (r.marker) {
        const applies = evaluateMarker(r.marker)
        if (applies === false) {
          skipped.push(r.raw)
          continue
        }
        if (applies === null) {
          // Unknown marker: not "missing". Reporting it would make a platform
          // specific dependency impossible to clear.
          skipped.push(r.raw)
          continue
        }
      }
      let have: string | undefined
      for (const candidate of pipAliasCandidates(r.name)) {
        have = installed.get(candidate)
        if (have) break
      }
      if (r.directUrl) {
        // Direct refs can be installed by pip, but their version cannot be
        // compared. If the inferred distribution is absent, report it as
        // unverifiable instead of "missing" so the audit never promises that
        // clicking “Install deps” can clear it.
        if (!have) unsupportedLines.push(r.raw)
        continue
      }
      if (!have) {
        missing.push(r.specifier ? `${r.name}${r.specifier}` : r.name)
        continue
      }
      if (r.specifier && !versionSatisfies(have, r.specifier)) {
        mismatched.push({ name: r.name, required: r.specifier, installed: have })
      }
    }
    if (missing.length || mismatched.length) {
      packs.push({
        id: pack.id,
        name: pack.name,
        declared: reqs.map((r) => r.raw),
        missing,
        mismatched,
        skipped,
        unsupported: unsupportedLines.length ? [...new Set(unsupportedLines)] : undefined
      })
    } else if (unsupportedLines.length) {
      unverifiable.push({ id: pack.id, name: pack.name, lines: [...new Set(unsupportedLines)] })
    }
  }
  return { packs, unverifiable }
}
