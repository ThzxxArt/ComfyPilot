import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import type { ComfyInstanceConfig, ComfyInstanceInfo, InstanceCapabilities } from '@shared/types'
import { capabilityService } from '../capabilities'
import { loadInstanceConfigs } from '../db'
import type { InstanceServiceContext, RuntimeEntry } from './types'

export function ensureRuntime(
  ctx: InstanceServiceContext,
  config: ComfyInstanceConfig
): RuntimeEntry {
  let rt = ctx.runtimes.get(config.id)
  if (!rt) {
    rt = {
      config,
      status: 'stopped',
      logs: [],
      generation: 0,
      intentionalStop: false,
      ready: false,
      managed: false,
      readyWaiters: []
    }
    ctx.runtimes.set(config.id, rt)
  } else {
    rt.config = config
  }
  return rt
}

export function emitStatus(ctx: InstanceServiceContext, rt: RuntimeEntry): void {
  rt.lastEmittedStatus = rt.status
  rt.lastStatusEmitAt = Date.now()
  ctx.emit('status', toInfo(ctx, rt))
}

/** Drop cached version for one path (or all) so post-update probes see fresh data. */
export function invalidateVersionCache(ctx: InstanceServiceContext, installPath?: string): void {
  if (installPath) ctx.versionCache.delete(installPath)
  else ctx.versionCache.clear()
}

export function probeVersion(ctx: InstanceServiceContext, installPath: string): string | undefined {
  if (ctx.versionCache.has(installPath)) return ctx.versionCache.get(installPath)
  let version: string | undefined
  try {
    // Prefer the install stamp written by installer/updater (commit sha or fetch date).
    const envCandidates = [
      join(installPath, '.comfypilot-env.json'),
      join(dirname(installPath), '.comfypilot-env.json')
    ]
    for (const f of envCandidates) {
      if (!existsSync(f)) continue
      const data = JSON.parse(readFileSync(f, 'utf-8')) as {
        comfyVersion?: string
        comfyCommit?: string
        comfyFetchedAt?: number
      }
      if (data.comfyVersion) {
        version = data.comfyVersion
        break
      }
      if (data.comfyCommit) {
        version = data.comfyCommit.slice(0, 12)
        break
      }
      if (data.comfyFetchedAt) {
        version = new Date(data.comfyFetchedAt).toISOString().slice(0, 10)
        break
      }
    }
    if (!version) {
      const pyproject = join(installPath, 'pyproject.toml')
      if (existsSync(pyproject)) {
        const text = readFileSync(pyproject, 'utf-8')
        const m = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)
        if (m) version = m[1]
      }
    }
    if (!version && existsSync(join(installPath, 'main.py'))) version = 'detected'
    if (!version && existsSync(join(installPath, 'requirements.txt'))) version = 'detected'
  } catch {
    /* ignore */
  }
  ctx.versionCache.set(installPath, version)
  return version
}

export function baseUrlOf(config: ComfyInstanceConfig): string {
  const port = config.port || 8188
  const listen = config.listen || '127.0.0.1'
  const host = listen === '0.0.0.0' || listen === '::' || listen === '[::]' ? '127.0.0.1' : listen
  return `http://${host}:${port}`
}

export function toInfo(ctx: InstanceServiceContext, rt: RuntimeEntry): ComfyInstanceInfo {
  return {
    ...rt.config,
    // Normalize fields older JSONC records may omit
    pinned: Boolean(rt.config.pinned),
    autoStart: Boolean(rt.config.autoStart),
    extraArgs: Array.isArray(rt.config.extraArgs) ? rt.config.extraArgs : [],
    status:
      rt.status === 'stopped' && rt.config.migrationState === 'failed'
        ? 'migration-failed'
        : rt.status === 'stopped' && rt.config.migrationState === 'required'
          ? 'migration-required'
          : rt.status,
    pid: rt.pid,
    // Same host normalization as probes/launch (0.0.0.0 / :: / [::] → 127.0.0.1)
    url: baseUrlOf(rt.config),
    startedAt: rt.startedAt,
    uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : undefined,
    lastError: rt.lastError,
    // 0.1.17 (WP3): structured crash reason so the UI can offer the right
    // recovery (restart vs. lower VRAM and restart).
    lastExit: rt.lastExit,
    managerEnabled: rt.config.extraArgs?.some((a) => a.includes('enable-manager')),
    version: probeVersion(ctx, rt.config.path),
    // Real version reported by the running server (0.1.10) — only set when a
    // recent capability probe hit the instance while online.
    onlineVersion: capabilityService.knownVersionForInstance(rt.config.id)
  }
}

/** Runtime capabilities of a running instance (0.1.10, probed + cached 30s). */
export async function getCapabilities(id: string): Promise<InstanceCapabilities | null> {
  const configs = loadInstanceConfigs()
  if (!configs.some((c) => c.id === id)) throw new Error(`Instance not found: ${id}`)
  return capabilityService.probe(id)
}
