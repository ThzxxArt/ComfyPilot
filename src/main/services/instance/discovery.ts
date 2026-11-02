import { randomUUID } from 'crypto'
import { existsSync, readdirSync, statSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { homedir } from 'os'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  InstanceDiscoveryCandidate
} from '@shared/types'
import {
  deleteInstanceConfig,
  loadInstanceConfigs,
  loadSettings,
  upsertInstanceConfig
} from '../db'
import { resolveInsideAnyRoot } from '../security'
import { killProcessTree } from '../processTree'
import { capabilityService } from '../capabilities'
import { normalizeLaunchProfile } from './launchArgs'
import type { InstanceServiceContext } from './types'

export function commonRoots(extra?: string): string[] {
  const settings = loadSettings()
  const home = homedir()
  const candidates = [
    extra,
    process.env.COMFYUI_PATH,
    'D:\\ComfyUI',
    'C:\\ComfyUI',
    'D:\\AI\\ComfyUI',
    home,
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Downloads'),
    join(process.env.USERPROFILE || '', 'ComfyUI'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'comfyui-desktop'),
    ...settings.modelScanRoots
  ].filter(Boolean) as string[]
  return [...new Set(candidates)]
}

export function discover(ctx: InstanceServiceContext, root?: string): InstanceDiscoveryCandidate[] {
  const found: InstanceDiscoveryCandidate[] = []
  const registered = new Set(
    loadInstanceConfigs().map((c) => {
      try {
        return resolve(c.path).toLowerCase()
      } catch {
        return c.path.toLowerCase()
      }
    })
  )
  // Renderer-supplied root must resolve inside an allow-listed tree; ignore otherwise.
  const safeRoot = root ? resolveInsideAnyRoot(root, ctx.commonRoots()) : null
  for (const p of ctx.commonRoots(safeRoot ?? undefined)) {
    if (!p || !existsSync(p)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(p)
    } catch {
      continue
    }
    // root itself may be a ComfyUI install
    ctx.scoreCandidate(p, found, registered)
    // or contain sub-installs
    for (const name of entries.slice(0, 40)) {
      const child = join(p, name)
      try {
        if (statSync(child).isDirectory()) ctx.scoreCandidate(child, found, registered)
      } catch {
        /* skip */
      }
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 20)
}

export function scoreCandidate(
  ctx: InstanceServiceContext,
  path: string,
  out: InstanceDiscoveryCandidate[],
  registered?: Set<string>
): void {
  const hasMainPy = existsSync(join(path, 'main.py'))
  const hasRequirements = existsSync(join(path, 'requirements.txt'))
  // venv / portable embeds — including the AKI/绘世 sibling `python/` folder.
  // Only real interpreter layout counts (named dirs with python.exe/bin/python3),
  // never a bare `bin/python3` which would false-positive on ordinary projects.
  const embeddedDirs = ['python', 'python_embeded', 'python_embedded']
  const hasLocalPython = embeddedDirs.some(
    (d) => existsSync(join(path, d, 'python.exe')) || existsSync(join(path, d, 'bin', 'python3'))
  )
  const parent = dirname(path)
  const hasParentPython = embeddedDirs.some(
    (d) =>
      existsSync(join(parent, d, 'python.exe')) || existsSync(join(parent, d, 'bin', 'python3'))
  )
  const hasVenv =
    hasLocalPython ||
    hasParentPython ||
    existsSync(join(path, 'venv')) ||
    existsSync(join(path, '.venv'))
  if (!hasMainPy && !hasRequirements) return
  if (out.some((c) => c.path === path)) return
  let isRegistered = false
  try {
    isRegistered = Boolean(registered?.has(resolve(path).toLowerCase()))
  } catch {
    isRegistered = Boolean(registered?.has(path.toLowerCase()))
  }
  out.push({
    path,
    score:
      (hasMainPy ? 50 : 0) +
      (hasRequirements ? 20 : 0) +
      (hasVenv ? 30 : 0) -
      (isRegistered ? 100 : 0),
    reason: isRegistered
      ? 'Already registered'
      : hasMainPy
        ? 'Found main.py'
        : 'Found requirements.txt',
    hasMainPy,
    hasRequirements,
    hasVenv,
    estimatedVersion: ctx.probeVersion(path),
    registered: isRegistered
  })
}

export function list(ctx: InstanceServiceContext): ComfyInstanceInfo[] {
  return loadInstanceConfigs()
    .map((c) => ctx.toInfo(ctx.ensureRuntime(c)))
    .sort((a, b) => {
      // Pinned first, then running, then name
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const aRun = a.status === 'running' ? 0 : 1
      const bRun = b.status === 'running' ? 0 : 1
      if (aRun !== bRun) return aRun - bRun
      return a.name.localeCompare(b.name)
    })
}

export function save(ctx: InstanceServiceContext, config: ComfyInstanceConfig): ComfyInstanceInfo {
  const id = config.id || randomUUID()
  // Persist ONLY config fields — never runtime status/pid/url/uptime.
  const next: ComfyInstanceConfig = {
    id,
    name: config.name,
    path: config.path,
    pythonPath: config.pythonPath || '',
    venvPath: config.venvPath || '',
    port: config.port || 8188,
    listen: config.listen || '127.0.0.1',
    extraArgs: Array.isArray(config.extraArgs) ? config.extraArgs : [],
    argTemplateId: config.argTemplateId || 'default',
    enabled: config.enabled !== false,
    notes: config.notes || '',
    autoStart: Boolean(config.autoStart),
    frontendVersion: config.frontendVersion || '',
    pinned: Boolean(config.pinned),
    launchProfile: normalizeLaunchProfile(config.launchProfile),
    pythonVersion: config.pythonVersion,
    migrationState: config.migrationState,
    migrationError: config.migrationError
  }
  upsertInstanceConfig(next)
  return ctx.toInfo(ctx.ensureRuntime(next))
}

export async function remove(ctx: InstanceServiceContext, id: string): Promise<boolean> {
  const rt = ctx.runtimes.get(id)
  if (rt?.process) {
    rt.intentionalStop = true
    rt.generation += 1
    ctx.clearReadyProbe(rt)
    // 0.2.0: same tree-kill guarantee as stop() — a launcher's children must
    // be gone before the runtime directory is deleted.
    await killProcessTree(rt.process, { timeoutMs: 5000 })
    rt.process = undefined
    rt.pid = undefined
  }
  // A removed instance must not keep a stale online version around.
  capabilityService.invalidate(id)
  ctx.runtimes.delete(id)
  return deleteInstanceConfig(id)
}
