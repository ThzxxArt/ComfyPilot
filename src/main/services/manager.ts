/**
 * ComfyUI-Manager v4.4 integration (0.2.5 WP4).
 *
 * Manager moved its config to `user/__manager/config.ini` in v3.38. Reading a
 * hardcoded `user/default/ComfyUI-Manager` path made the UI show stale/missing
 * security levels, and ComfyPilot's own install policy was mislabelled as
 * Manager's `security_level`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  ComfyInstanceConfig,
  ManagerInfo,
  ManagerInstallResult,
  ManagerNetworkMode,
  ManagerSecurityLevel
} from '@shared/types'
import { resolveEffectiveInstance } from '@shared/instanceLayout'
import { resolveInstancePythonPath } from './instance'
import { loadInstanceConfigs } from './db'

const execFileAsync = promisify(execFile)

const SECURITY_LEVELS: ManagerSecurityLevel[] = ['strong', 'normal', 'normal-', 'weak']
const NETWORK_MODES: ManagerNetworkMode[] = ['public', 'private', 'offline', 'personal_cloud']

export interface ParsedManagerConfig {
  securityLevel?: ManagerSecurityLevel
  networkMode?: ManagerNetworkMode
  /** Key/value pairs of the [default] section (raw text, `%` is literal). */
  values: Record<string, string>
  hasDefault: boolean
}

/** Line-level INI parser that keeps comments/unknown keys for round-tripping. */
export function parseManagerConfig(text: string): ParsedManagerConfig {
  const values: Record<string, string> = {}
  let section = ''
  let hasDefault = false
  for (const rawLine of String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1].trim()
      if (section === 'default') hasDefault = true
      continue
    }
    if (section !== 'default') continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    values[key] = value
  }
  const security = values.security_level
  const network = values.network_mode
  return {
    securityLevel: SECURITY_LEVELS.includes(security as ManagerSecurityLevel)
      ? (security as ManagerSecurityLevel)
      : undefined,
    networkMode: NETWORK_MODES.includes(network as ManagerNetworkMode)
      ? (network as ManagerNetworkMode)
      : undefined,
    values,
    hasDefault
  }
}

/**
 * Update ONLY the requested keys in `[default]`, preserving comments, unknown
 * keys, key order and the file's original newline style. `%` is never
 * interpreted (Manager 4.4.2 treats it literally).
 */
export function updateManagerConfigText(
  text: string,
  patch: { securityLevel?: ManagerSecurityLevel; networkMode?: ManagerNetworkMode }
): string {
  const source = String(text ?? '')
  // Keep a BOM some Windows editors add; parsing strips it, writing should not.
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const raw = source.replace(/^\uFEFF/, '')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const updates = new Map<string, string>()
  if (patch.securityLevel !== undefined) updates.set('security_level', patch.securityLevel)
  if (patch.networkMode !== undefined) updates.set('network_mode', patch.networkMode)

  let section = ''
  let defaultStart = -1
  let defaultEnd = lines.length
  const found = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const sec = trimmed.match(/^\[([^\]]+)\]$/)
    if (sec) {
      if (section === 'default' && defaultEnd === lines.length) defaultEnd = i
      section = sec[1].trim()
      if (section === 'default') defaultStart = i
      continue
    }
    if (section !== 'default') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!updates.has(key)) continue
    const indent = lines[i].match(/^\s*/)?.[0] || ''
    lines[i] = `${indent}${key} = ${updates.get(key)}`
    found.add(key)
  }
  for (const [key, value] of updates) {
    if (found.has(key)) continue
    const line = `${key} = ${value}`
    if (defaultStart >= 0) {
      lines.splice(defaultEnd, 0, line)
      defaultEnd += 1
    } else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('')
      lines.push('[default]', line)
      defaultStart = lines.length - 2
      defaultEnd = lines.length
    }
  }
  return bom + lines.join(eol)
}

interface PipCacheEntry {
  at: number
  version?: string
}
const pipCache = new Map<string, PipCacheEntry>()

async function pipManagerVersion(config: ComfyInstanceConfig): Promise<string | undefined> {
  const python = resolveInstancePythonPath(config)
  const key = `${python}|${config.path}`
  const cached = pipCache.get(key)
  if (cached && Date.now() - cached.at < 60_000) return cached.version
  let version: string | undefined
  try {
    const { stdout } = await execFileAsync(python, ['-m', 'pip', 'show', 'comfyui-manager'], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const m = String(stdout || '').match(/^Version:\s*(\S+)/im)
    if (m) version = m[1]
  } catch {
    version = undefined
  }
  pipCache.set(key, { at: Date.now(), version })
  return version
}

/** Drop the cached `pip show` answer for this interpreter (after install). */
function invalidatePipCache(config: ComfyInstanceConfig): void {
  const python = resolveInstancePythonPath(config)
  pipCache.delete(`${python}|${config.path}`)
}

function gitManagerVersion(dir: string): string | undefined {
  try {
    const pyproject = join(dir, 'pyproject.toml')
    if (existsSync(pyproject)) {
      const m = readFileSync(pyproject, 'utf-8').match(/^\s*version\s*=\s*["']([^"']+)["']/m)
      if (m) return m[1]
    }
    const init = join(dir, '__init__.py')
    if (existsSync(init)) {
      const m = readFileSync(init, 'utf-8').match(/__version__\s*=\s*["']([^"']+)["']/)
      if (m) return m[1]
    }
  } catch {
    /* version is optional */
  }
  return undefined
}

export function managerConfigPaths(config: ComfyInstanceConfig): {
  userDir: string
  managerDir: string
  configPath: string
  legacyDir: string
  legacyConfigPath: string
} {
  const dirs = resolveEffectiveInstance(config).dirs
  const managerDir = dirs.manager
  const legacyDir = join(dirs.user, 'default', 'ComfyUI-Manager')
  return {
    userDir: dirs.user,
    managerDir,
    configPath: join(managerDir, 'config.ini'),
    legacyDir,
    legacyConfigPath: join(legacyDir, 'config.ini')
  }
}

export async function getManagerInfo(config: ComfyInstanceConfig): Promise<ManagerInfo> {
  const paths = managerConfigPaths(config)
  const warnings: string[] = []
  const gitDir = join(resolveEffectiveInstance(config).dirs.customNodes, 'ComfyUI-Manager')
  const gitInstalled = existsSync(gitDir)
  const pipVersion = await pipManagerVersion(config)
  const installed = Boolean(pipVersion || gitInstalled)
  const source: ManagerInfo['source'] = pipVersion ? 'pip' : gitInstalled ? 'git' : 'none'
  const version = pipVersion || (gitInstalled ? gitManagerVersion(gitDir) : undefined)

  const newConfig = existsSync(paths.configPath)
  const legacyConfig = existsSync(paths.legacyConfigPath)
  const configPath = newConfig
    ? paths.configPath
    : legacyConfig
      ? paths.legacyConfigPath
      : paths.configPath
  let parsed: ParsedManagerConfig = { values: {}, hasDefault: false }
  if (existsSync(configPath)) {
    try {
      parsed = parseManagerConfig(readFileSync(configPath, 'utf-8'))
    } catch (err) {
      warnings.push(
        `config.ini could not be read: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  } else if (installed) {
    warnings.push('Manager is installed but config.ini was not found')
  }
  if (legacyConfig && newConfig) {
    warnings.push('legacy Manager config still exists at user/default/ComfyUI-Manager')
  }
  if (legacyConfig && !newConfig) {
    warnings.push('legacy Manager path in use — v4.4 migrates to user/__manager on next start')
  }
  if (gitInstalled && pipVersion) {
    warnings.push('Manager is installed both via pip and git — remove one to avoid version drift')
  }
  if (
    installed &&
    version &&
    /^v?4\./.test(version) === false &&
    !/^3\.(3[89]|[4-9]\d)/.test(version)
  ) {
    warnings.push(`Manager ${version} predates the v4.4 API/security model`)
  }
  const snapshotsDir = join(paths.managerDir, 'snapshots')

  return {
    installed,
    version,
    source,
    configPath,
    configExists: existsSync(configPath),
    securityLevel: parsed.securityLevel,
    networkMode: parsed.networkMode,
    snapshotsDir,
    legacyBackup: legacyConfig ? paths.legacyConfigPath : undefined,
    legacyConfigPath: legacyConfig ? paths.legacyConfigPath : undefined,
    warnings
  }
}

/**
 * Explicit pip install of ComfyUI-Manager 4.4.2 (0.2.5 WP4). Never silent:
 * the renderer must confirm first, pip runs through the normal mirror/proxy
 * pipeline, and a failed upgrade is rolled back to the previously installed
 * version when one is known.
 */
export async function installManagerV4(config: ComfyInstanceConfig): Promise<ManagerInstallResult> {
  const target = 'comfyui-manager==4.4.2'
  const before = await getManagerInfo(config)
  if (before.source === 'pip' && before.version === '4.4.2') {
    return { ok: true, info: before, message: 'ComfyUI-Manager 4.4.2 is already installed' }
  }
  const { pipOpsService } = await import('./pipOps')
  const result = await pipOpsService.installSpec(config.id, target)
  invalidatePipCache(config)
  if (!result.ok) {
    let rolledBack = false
    if (before.source === 'pip' && before.version && before.version !== '4.4.2') {
      try {
        const rollback = await pipOpsService.installSpec(
          config.id,
          `comfyui-manager==${before.version}`
        )
        rolledBack = rollback.ok
        invalidatePipCache(config)
      } catch {
        rolledBack = false
      }
    }
    const info = await getManagerInfo(config)
    return {
      ok: false,
      info,
      message: result.error || 'pip install comfyui-manager==4.4.2 failed',
      rolledBack
    }
  }
  return { ok: true, info: await getManagerInfo(config) }
}

/**
 * Write Manager security level. Requires an existing config, backs up first
 * and uses a temp file + fsync + rename; a failed write never truncates the
 * original.
 */
export async function setManagerSecurityLevel(
  config: ComfyInstanceConfig,
  level: ManagerSecurityLevel
): Promise<ManagerInfo> {
  if (!SECURITY_LEVELS.includes(level)) throw new Error(`Invalid Manager security level: ${level}`)
  const info = await getManagerInfo(config)
  const path = info.configPath
  if (!path || !existsSync(path)) {
    throw new Error('Manager config.ini is missing — start ComfyUI-Manager once to create it')
  }
  const text = readFileSync(path, 'utf-8')
  const next = updateManagerConfigText(text, { securityLevel: level })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${path}.bak-${stamp}`
  copyFileSync(path, backup)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, next, 'utf-8')
    // fsync the temp file before the atomic replace where available.
    try {
      const fd = await import('fs').then((m) => m.openSync(tmp, 'r+'))
      try {
        const fsm = await import('fs')
        fsm.fsyncSync(fd)
      } finally {
        const fsm = await import('fs')
        fsm.closeSync(fd)
      }
    } catch {
      /* fsync is best-effort on platforms without it */
    }
    renameSync(tmp, path)
  } catch (err) {
    try {
      const fsm = await import('fs')
      fsm.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw new Error(
      `Manager config write failed (original left intact; backup ${backup}): ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return getManagerInfo(config)
}

/** True when the legacy directory exists but the v4 directory does not. */
export function managerNeedsLegacyMigration(config: ComfyInstanceConfig): boolean {
  const p = managerConfigPaths(config)
  return existsSync(p.legacyDir) && !existsSync(p.managerDir)
}

export function managerInfoForId(instanceId: string): Promise<ManagerInfo> {
  const config = loadInstanceConfigs().find((c) => c.id === instanceId)
  if (!config) throw new Error(`Instance not found: ${instanceId}`)
  return getManagerInfo(config)
}

export function ensureManagerDir(config: ComfyInstanceConfig): string {
  const p = managerConfigPaths(config)
  if (!existsSync(p.managerDir)) mkdirSync(p.managerDir, { recursive: true })
  return p.managerDir
}

/** File facts used by tests/diagnostics without spawning pip. */
export function managerFileFacts(config: ComfyInstanceConfig): {
  configPath: string
  configExists: boolean
  configSize?: number
  legacyConfigExists: boolean
  gitInstalled: boolean
  gitVersion?: string
  snapshotsExists: boolean
} {
  const p = managerConfigPaths(config)
  const gitDir = join(resolveEffectiveInstance(config).dirs.customNodes, 'ComfyUI-Manager')
  const gitInstalled = existsSync(gitDir)
  let configSize: number | undefined
  try {
    configSize = statSync(p.configPath).size
  } catch {
    configSize = undefined
  }
  return {
    configPath: p.configPath,
    configExists: existsSync(p.configPath),
    configSize,
    legacyConfigExists: existsSync(p.legacyConfigPath),
    gitInstalled,
    gitVersion: gitInstalled ? gitManagerVersion(gitDir) : undefined,
    snapshotsExists: existsSync(join(p.managerDir, 'snapshots'))
  }
}
