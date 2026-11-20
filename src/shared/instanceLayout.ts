/**
 * Effective instance layout (0.2.5 WP1).
 *
 * ComfyUI's real port/listen/directories are decided by the FINAL argv: the
 * template, the structured launch profile and free-text `extraArgs` are
 * concatenated in that order, and argparse keeps the last value. Reading
 * `config.port` / `<instance>/models` directly therefore describes the
 * CONFIGURED start, not the one ComfyUI actually performs.
 *
 * This module is deliberately pure string logic (no fs / no `path`) so the
 * main process and the renderer resolve the same values, including Windows
 * drive paths on a POSIX test runner.
 */
import type { LaunchProfile, ResolvedInstanceDirs, EffectiveLaunch } from './types'
import { LAUNCH_TEMPLATES } from './constants'
import { renderLaunchProfile } from './launchArgs'

export type { ResolvedInstanceDirs, EffectiveLaunch } from './types'

export interface EffectiveArgSource {
  path: string
  port?: number
  listen?: string
  extraArgs?: string[] | string
  argTemplateId?: string
  launchProfile?: LaunchProfile
}

const DIRECTORY_FLAGS = {
  base: '--base-directory',
  user: '--user-directory',
  models: '--models-directory',
  input: '--input-directory',
  output: '--output-directory',
  temp: '--temp-directory',
  previews: '--previews-directory'
} as const

/** Split `--flag=value` while leaving a bare `--flag` untouched. */
export function splitFlagToken(token: string): { flag: string; value?: string } {
  const raw = String(token || '')
  if (!raw.startsWith('--')) return { flag: raw }
  const eq = raw.indexOf('=')
  if (eq <= 2) return { flag: raw }
  return { flag: raw.slice(0, eq), value: raw.slice(eq + 1) }
}

/**
 * Last value for a flag — mirrors argparse for scalar options. Supports both
 * `--flag value` and `--flag=value`; a following token that starts with `--`
 * is treated as a missing value (argparse would reject it).
 */
export function readLastFlagValue(args: string[], flag: string): string | undefined {
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] ?? '')
    const parsed = splitFlagToken(token)
    if (parsed.flag !== flag) continue
    if (parsed.value !== undefined) {
      value = parsed.value
      continue
    }
    const next = args[i + 1]
    if (next !== undefined && !String(next).startsWith('--')) value = String(next)
  }
  return value
}

/** True for POSIX absolute, Windows drive absolute and UNC paths. */
export function isAbsolutePathLike(value: string): boolean {
  const raw = String(value || '')
  return (
    raw.startsWith('/') ||
    raw.startsWith('\\\\') ||
    raw.startsWith('//') ||
    /^[a-zA-Z]:[\\/]/.test(raw) ||
    /^[a-zA-Z]:$/.test(raw)
  )
}

function separatorFor(root: string): string {
  if (root.includes('\\')) return '\\'
  return '/'
}

/** Lexically collapse `.` and `..` without touching the filesystem. */
function normalizePathLike(pathStr: string): string {
  const raw = String(pathStr || '')
  if (!raw) return ''
  const sep = separatorFor(raw)
  const drive = raw.match(/^([a-zA-Z]:)[\\/]?/)
  const unc = raw.startsWith('\\\\') || raw.startsWith('//')
  let rest = raw
  let prefix = ''
  if (drive) {
    prefix = drive[1] + sep
    rest = raw.slice(drive[0].length)
  } else if (unc) {
    prefix = sep + sep
    rest = raw.replace(/^[\\/]+/, '')
  } else if (raw.startsWith('/') || raw.startsWith('\\')) {
    prefix = sep
    rest = raw.replace(/^[\\/]+/, '')
  }
  const parts = rest.split(/[\\/]+/)
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!prefix) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join(sep)
  if (prefix) return prefix + joined
  return joined || '.'
}

/** Join a possibly relative value onto an instance root (no fs access). */
export function joinPathLike(root: string, value: string): string {
  const raw = String(value || '')
  if (!raw) return normalizePathLike(root)
  if (isAbsolutePathLike(raw)) return normalizePathLike(raw)
  const sep = separatorFor(root)
  const base = String(root || '').replace(/[\\/]+$/, '')
  return normalizePathLike(`${base}${sep}${raw}`)
}

/** `--listen` may be a comma-separated list (ComfyUI 0.46). */
export function parseListenAddresses(listen: string | undefined): string[] {
  return String(listen || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

export function isWildcardHost(host: string): boolean {
  const h = stripBrackets(String(host || '').trim()).toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '*'
}

/**
 * Pick a connectable probe host:
 * wildcard → loopback, explicit 127.0.0.1 wins, otherwise the first address.
 */
export function probeHostForListen(listen: string | undefined): string {
  const addresses = parseListenAddresses(listen)
  if (!addresses.length) return '127.0.0.1'
  if (addresses.some(isWildcardHost)) return '127.0.0.1'
  const loopback = addresses.find((h) => stripBrackets(h) === '127.0.0.1')
  if (loopback) return stripBrackets(loopback)
  return stripBrackets(addresses[0])
}

/** Build a URL with IPv6 brackets (Node's URL requires `http://[::1]:8188`). */
export function formatHostUrl(host: string, port: number): string {
  const clean = stripBrackets(String(host || '127.0.0.1'))
  const authority = clean.includes(':') ? `[${clean}]` : clean
  return `http://${authority}:${Number(port) || 8188}`
}

function templateArgsFor(config: EffectiveArgSource): string[] {
  const template = LAUNCH_TEMPLATES.find((t) => t.id === config.argTemplateId)
  return template?.args || []
}

function extraArgsFor(config: EffectiveArgSource): string[] {
  if (Array.isArray(config.extraArgs)) return config.extraArgs.map(String)
  const raw = String(config.extraArgs || '').trim()
  if (!raw) return []
  // A whitespace split is enough for effective resolution; callers that need
  // quoting semantics already parsed the free text before saving it.
  return raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^["']|["']$/g, '')) ?? []
}

/**
 * The argv prefix that decides port/listen/directories, mirroring
 * `buildArgs()` minus fs-dependent extras (`extra_model_paths` / auto-launch).
 */
export function buildEffectiveArgList(config: EffectiveArgSource): string[] {
  const args: string[] = ['--port', String(config.port || 8188)]
  const templateArgs = templateArgsFor(config)
  if (!templateArgs.includes('--listen')) args.push('--listen', config.listen || '127.0.0.1')
  args.push(...templateArgs)
  args.push(...renderLaunchProfile(config.launchProfile))
  args.push(...extraArgsFor(config))
  return args
}

export function resolveEffectivePort(config: EffectiveArgSource, args?: string[]): number {
  const argv = args ?? buildEffectiveArgList(config)
  const raw = readLastFlagValue(argv, '--port')
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  return config.port || 8188
}

export function resolveEffectiveListen(config: EffectiveArgSource, args?: string[]): string {
  const argv = args ?? buildEffectiveArgList(config)
  const raw = readLastFlagValue(argv, '--listen')
  return raw && raw.trim() ? raw.trim() : config.listen || '127.0.0.1'
}

export function resolveEffectiveDirs(config: EffectiveArgSource, args?: string[]): ResolvedInstanceDirs {
  const argv = args ?? buildEffectiveArgList(config)
  const root = config.path || '.'
  const readDir = (flag: string): string | undefined => {
    const value = readLastFlagValue(argv, flag)
    return value && value.trim() ? value.trim() : undefined
  }
  const base = joinPathLike(root, readDir(DIRECTORY_FLAGS.base) || '.')
  const user = joinPathLike(base, readDir(DIRECTORY_FLAGS.user) || 'user')
  const models = joinPathLike(base, readDir(DIRECTORY_FLAGS.models) || 'models')
  const customNodes = joinPathLike(base, 'custom_nodes')
  const input = joinPathLike(base, readDir(DIRECTORY_FLAGS.input) || 'input')
  const output = joinPathLike(base, readDir(DIRECTORY_FLAGS.output) || 'output')
  const temp = joinPathLike(base, readDir(DIRECTORY_FLAGS.temp) || 'temp')
  const previews = joinPathLike(base, readDir(DIRECTORY_FLAGS.previews) || 'previews')
  return {
    base,
    user,
    models,
    customNodes,
    input,
    output,
    temp,
    previews,
    workflows: joinPathLike(user, 'default/workflows'),
    manager: joinPathLike(user, '__manager')
  }
}

/** Resolve the effective launch facts for an instance config. */
export function resolveEffectiveInstance(config: EffectiveArgSource): EffectiveLaunch {
  const args = buildEffectiveArgList(config)
  const port = resolveEffectivePort(config, args)
  const listen = resolveEffectiveListen(config, args)
  const probeHost = probeHostForListen(listen)
  return {
    port,
    listen,
    probeHost,
    url: formatHostUrl(probeHost, port),
    dirs: resolveEffectiveDirs(config, args)
  }
}

/** Manager is enabled when template/profile/extra argv says so — not just extraArgs. */
export function isManagerEnabledInArgv(config: EffectiveArgSource): boolean {
  return buildEffectiveArgList(config).some((a) => splitFlagToken(a).flag === '--enable-manager')
}

/** First non-empty argv value, used by validators that must mirror argparse. */
export function firstFlagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const parsed = splitFlagToken(args[i])
    if (parsed.flag !== flag) continue
    if (parsed.value !== undefined) return parsed.value
    const next = args[i + 1]
    if (next !== undefined && !String(next).startsWith('--')) return String(next)
  }
  return undefined
}

export { normalizePathLike }
