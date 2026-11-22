/**
 * Attention-accelerator status (0.2.6).
 *
 * The instance detail card needs one honest answer for SageAttention and
 * xFormers: is the package present, is the installed version usable, and can
 * the curated install path run on this platform? The renderer already has the
 * full `EnvProbe` package list and the launch profile, so this stays a pure
 * function with no extra IPC.
 */
import type { EnvProbe, LaunchProfile } from './types'

export type AttentionPackageId = 'sageattention' | 'xformers'
export type AttentionPackageStatus =
  'unknown' | 'not-installed' | 'installed' | 'outdated' | 'unsupported'

export interface AttentionPackageState {
  id: AttentionPackageId
  status: AttentionPackageStatus
  version?: string
  /** The curated install/upgrade path is available on this platform. */
  canInstall: boolean
}

export interface AttentionOverview {
  sageattention: AttentionPackageState
  xformers: AttentionPackageState
  /** The launch profile selects `--use-sage-attention`. */
  sageActive: boolean
  /** The launch profile selects `--disable-xformers`. */
  xformersDisabled: boolean
  /** Raw launch-profile backend (`default` / `sage` / `flash` / …). */
  backend: string
}

function installedPackage(
  probe: EnvProbe | null | undefined,
  id: AttentionPackageId
): { version: string } | undefined {
  const found = probe?.packages?.find((p) => String(p.name || '').toLowerCase() === id)
  return found ? { version: String(found.version || '') } : undefined
}

function versionParts(version: string | undefined): [number, number] | undefined {
  const m = String(version || '').match(/^(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2])] : undefined
}

function torchAtLeast(probe: EnvProbe, major: number, minor: number): boolean {
  const parts = versionParts(probe.torchVersion)
  if (!parts) return false
  return parts[0] > major || (parts[0] === major && parts[1] >= minor)
}

function hasCuda13(probe: EnvProbe): boolean {
  return String(probe.cudaVersion || '').startsWith('13.')
}

function xformersPlatform(platform: string): boolean {
  return platform === 'win32' || platform === 'linux'
}

function sageAttentionState(
  probe: EnvProbe | null | undefined,
  platform: string
): AttentionPackageState {
  const id: AttentionPackageId = 'sageattention'
  if (!probe) return { id, status: 'unknown', canInstall: false }
  // The curated wheel is Windows + cu130 + torch 2.10+. Other platforms can
  // still have SageAttention installed manually; we only gate auto-install.
  const installable = platform === 'win32' && hasCuda13(probe) && torchAtLeast(probe, 2, 10)
  const installed = installedPackage(probe, id)
  if (!installed) {
    return {
      id,
      status: installable ? 'not-installed' : 'unsupported',
      canInstall: installable
    }
  }
  const parts = versionParts(installed.version)
  const outdated = !parts || parts[0] < 2 || (parts[0] === 2 && parts[1] < 2)
  return {
    id,
    status: outdated ? 'outdated' : 'installed',
    version: installed.version || undefined,
    canInstall: installable
  }
}

function xformersState(
  probe: EnvProbe | null | undefined,
  platform: string
): AttentionPackageState {
  const id: AttentionPackageId = 'xformers'
  if (!probe) return { id, status: 'unknown', canInstall: false }
  const installable = xformersPlatform(platform) && torchAtLeast(probe, 2, 10)
  const installed = installedPackage(probe, id)
  if (!installed) {
    return {
      id,
      status: installable ? 'not-installed' : 'unsupported',
      canInstall: installable
    }
  }
  return {
    id,
    status: 'installed',
    version: installed.version || undefined,
    canInstall: installable
  }
}

export function attentionOverview(
  probe: EnvProbe | null | undefined,
  profile: LaunchProfile | undefined,
  platform: string,
  extraArgs: string[] = []
): AttentionOverview {
  const flags = new Set(extraArgs || [])
  const backend = String(profile?.attention || 'default')
  return {
    backend,
    sageActive: backend === 'sage' || flags.has('--use-sage-attention'),
    xformersDisabled: Boolean(profile?.disableXformers) || flags.has('--disable-xformers'),
    sageattention: sageAttentionState(probe, platform),
    xformers: xformersState(probe, platform)
  }
}
