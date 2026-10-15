/**
 * Instance capabilities (0.1.10) — runtime-probed facts about a RUNNING
 * ComfyUI instance, plus the capability flags (jobsApi / workflowMetadata)
 * reported to callers.
 *
 * Design rules:
 * - FACTS ONLY: every field is set from an actual server response; nothing is
 *   guessed from the app version.
 * - Flags prefer probes over version tables; the only version-based flag is
 *   `workflowMetadata` (confirmed present in 0.39.0, the version this was
 *   developed against — we do NOT claim a minimum for older builds).
 * - Probes are bounded (2.5s), cached (30s) and never throw.
 */
import type { ComfyInstanceConfig, InstanceCapabilities } from '@shared/types'
import { versionAtLeast } from '@shared/launchArgs'
import { loadInstanceConfigs } from './db'
import { LruCache } from './lru'

export { versionAtLeast }

const PROBE_TIMEOUT_MS = 2500
const CACHE_TTL_MS = 30_000
/** /object_info is a large payload — give it room, cache it longer. */
const OBJECT_INFO_TIMEOUT_MS = 20_000
const OBJECT_INFO_TTL_MS = 180_000

/**
 * `custom_nodes.ComfyUI-KJNodes` / `custom_nodes.ComfyUI-KJNodes.nodes.x`
 * (ComfyUI server.py injects RELATIVE_PYTHON_MODULE) → `ComfyUI-KJNodes`.
 */
export function packageFolderFromPythonModule(mod: string): string | undefined {
  const m = String(mod || '').match(/(?:^|\.)custom_nodes[./]([^.]+)/)
  return m ? m[1] : undefined
}

/**
 * Version confirmed to accept `workflow_metadata` (verified in ComfyUI 0.39.0
 * source: server.py validates it and merges it into every prompt-scoped
 * event). NOT a claim about earlier builds — when the version is unknown the
 * metadata is simply omitted and the prompt_links sidecar remains the source
 * of truth.
 */
export const WORKFLOW_METADATA_SINCE = '0.39.0'

function instanceBaseUrl(config: ComfyInstanceConfig): string {
  const port = config.port || 8188
  const listen = config.listen || '127.0.0.1'
  const host = listen === '0.0.0.0' || listen === '::' || listen === '[::]' ? '127.0.0.1' : listen
  return `http://${host}:${port}`
}

export { instanceBaseUrl }

async function fetchJson(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = (await res.json()) as unknown
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Parse /system_stats into facts (all optional; never throws). */
export function parseSystemStats(stats: Record<string, unknown> | null): {
  version?: string
  requiredFrontendVersion?: string
  installedTemplatesVersion?: string
  requiredTemplatesVersion?: string
  pythonVersion?: string
  pytorchVersion?: string
  embeddedPython?: boolean
  deployEnvironment?: string
  argv: string[]
  packages: Array<{ name: string; installed: string; required: string }>
} {
  const system = (stats?.system || {}) as Record<string, unknown>
  const packagesRaw = Array.isArray(system.comfy_package_versions)
    ? (system.comfy_package_versions as Array<Record<string, unknown>>)
    : []
  return {
    version: asString(system.comfyui_version),
    requiredFrontendVersion: asString(system.required_frontend_version),
    installedTemplatesVersion: asString(system.installed_templates_version),
    requiredTemplatesVersion: asString(system.required_templates_version),
    pythonVersion: asString(system.python_version),
    pytorchVersion: asString(system.pytorch_version),
    embeddedPython:
      typeof system.embedded_python === 'boolean' ? system.embedded_python : undefined,
    deployEnvironment: asString(system.deploy_environment),
    argv: Array.isArray(system.argv) ? (system.argv as unknown[]).map(String) : [],
    packages: packagesRaw
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        name: String(p.name || ''),
        installed: String(p.installed || ''),
        required: String(p.required || '')
      }))
      .filter((p) => p.name)
  }
}

/** /features payload shapes have changed over time — accept both wrappers. */
export function parseFeatures(features: Record<string, unknown> | null): Record<string, unknown> {
  if (!features) return {}
  const inner = features.flags
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>
  }
  return features
}

export class CapabilityService {
  private cache = new LruCache<string, { at: number; caps: InstanceCapabilities }>(200)
  /**
   * /object_info node map (0.1.12 WP6): node_type → owning custom-node folder,
   * plus the full type set for workflow preflight. Large payload (~MBs), so a
   * longer TTL; invalidated on instance stop/remove like everything else.
   */
  private objectInfoCache = new LruCache<
    string,
    { at: number; types: Set<string>; moduleByType: Map<string, string> }
  >(50)
  /**
   * Last version observed while the instance was RUNNING (0.1.11.1).
   * Deliberately has NO TTL: a running instance's reported version is a stable
   * fact, and the UI must not flip between the install stamp (a git commit
   * sha) and the online version every 30 seconds as the probe cache expires.
   * Cleared by invalidate() when the process stops / is removed, so a stopped
   * instance falls back to the install stamp.
   */
  private versionCache = new LruCache<string, string>(200)

  /** Sync peek used by instance.toInfo (no probing on hot paths). */
  cachedForUrl(baseUrl: string): InstanceCapabilities | undefined {
    const hit = this.cache.get(baseUrl)
    if (!hit) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) return undefined
    return hit.caps
  }

  /** Last known online version for a base URL (running-instance lifetime). */
  knownVersionForUrl(baseUrl: string): string | undefined {
    return this.versionCache.get(baseUrl)
  }

  invalidate(instanceId?: string): void {
    if (!instanceId) {
      this.cache.clear()
      this.versionCache.clear()
      this.objectInfoCache.clear()
      return
    }
    const configs = loadInstanceConfigs()
    const cfg = configs.find((c) => c.id === instanceId)
    if (cfg) {
      const url = instanceBaseUrl(cfg)
      this.cache.delete(url)
      this.versionCache.delete(url)
      this.objectInfoCache.delete(url)
    }
  }

  /**
   * Fetch (cache-aware) the instance's node map: all registered class types
   * plus `python_module` attribution. Returns null when /object_info is not
   * reachable — callers must treat null as "preflight unavailable", never as
   * "no nodes registered".
   */
  async nodeTypeMap(
    instanceId: string
  ): Promise<{ types: Set<string>; moduleByType: Map<string, string> } | null> {
    const cfg = loadInstanceConfigs().find((c) => c.id === instanceId)
    if (!cfg) return null
    const baseUrl = instanceBaseUrl(cfg)
    const hit = this.objectInfoCache.get(baseUrl)
    if (hit && Date.now() - hit.at < OBJECT_INFO_TTL_MS) return hit
    const data = await fetchJson(`${baseUrl}/object_info`, OBJECT_INFO_TIMEOUT_MS)
    if (!data) return null
    const types = new Set<string>()
    const moduleByType = new Map<string, string>()
    for (const [type, def] of Object.entries(data)) {
      types.add(type)
      const mod = (def as { python_module?: unknown } | null)?.python_module
      if (typeof mod === 'string' && mod) {
        const folder = packageFolderFromPythonModule(mod)
        if (folder) moduleByType.set(type, folder)
      }
    }
    const map = { at: Date.now(), types, moduleByType }
    this.objectInfoCache.set(baseUrl, map)
    return map
  }

  /** Sync attribution peek from the (possibly warm) object_info cache. */
  pythonModuleForTypeCached(instanceId: string, nodeType: string): string | undefined {
    const cfg = loadInstanceConfigs().find((c) => c.id === instanceId)
    if (!cfg) return undefined
    const hit = this.objectInfoCache.get(instanceBaseUrl(cfg))
    return hit?.moduleByType.get(nodeType)
  }

  /**
   * Probe a running instance. Returns null when the instance cannot be
   * resolved; returns a capabilities object with online:false when the server
   * does not answer (honest, cacheable state).
   */
  async probe(instanceId?: string): Promise<InstanceCapabilities | null> {
    const configs = loadInstanceConfigs()
    const cfg = instanceId
      ? configs.find((c) => c.id === instanceId)
      : configs.find((c) => c.enabled !== false) || configs[0]
    if (!cfg) return null
    const baseUrl = instanceBaseUrl(cfg)
    const cached = this.cachedForUrl(baseUrl)
    if (cached) return cached

    const [stats, features, jobsProbe, assetsProbe] = await Promise.all([
      fetchJson(`${baseUrl}/system_stats`),
      fetchJson(`${baseUrl}/features`),
      fetchJson(`${baseUrl}/api/jobs?limit=1`),
      fetchJson(`${baseUrl}/api/assets?limit=1`)
    ])

    const parsed = parseSystemStats(stats)
    const online = stats !== null && ('system' in stats || 'devices' in stats)
    const caps: InstanceCapabilities = {
      instanceId: cfg.id,
      baseUrl,
      online,
      version: parsed.version,
      requiredFrontendVersion: parsed.requiredFrontendVersion,
      installedTemplatesVersion: parsed.installedTemplatesVersion,
      requiredTemplatesVersion: parsed.requiredTemplatesVersion,
      pythonVersion: parsed.pythonVersion,
      pytorchVersion: parsed.pytorchVersion,
      embeddedPython: parsed.embeddedPython,
      deployEnvironment: parsed.deployEnvironment,
      argv: parsed.argv,
      packages: parsed.packages,
      features: parseFeatures(features),
      // jobsApi is PROBED, never version-guessed (0.1.10).
      jobsApi: Boolean(jobsProbe && Array.isArray(jobsProbe.jobs)),
      // assetsApi is PROBED via a live request (0.1.14): the route answers
      // {assets:[...]} when the assets system runs, and 503 SERVICE_DISABLED /
      // 404 (older builds) otherwise — both fail fetchJson to null.
      assetsApi: Boolean(assetsProbe && Array.isArray(assetsProbe.assets)),
      // workflow_metadata gate: confirmed on the development build (0.39.0).
      workflowMetadata: versionAtLeast(parsed.version, WORKFLOW_METADATA_SINCE),
      error: online ? undefined : 'Instance is not answering on ' + baseUrl,
      probedAt: Date.now()
    }
    this.cache.set(baseUrl, { at: Date.now(), caps })
    // Remember the online version for the instance's RUNNING lifetime.
    if (caps.online && caps.version) this.versionCache.set(baseUrl, caps.version)
    return caps
  }
}

export const capabilityService = new CapabilityService()
