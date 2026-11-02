import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { loadInstanceConfigs, loadSettings } from '../db'

export class MarketService {
  async list(opts?: {
    query?: string
    category?: string
    limit?: number
    page?: number
    instanceId?: string
  }) {
    const settings = loadSettings()
    try {
      const { searchRegistry, toPageResult, mapMarketItem, packKeyVariants } =
        await import('../registry')
      const result = await searchRegistry({
        query: opts?.query,
        limit: opts?.limit,
        page: opts?.page
      })
      // Installed detection must target the selected instance's custom_nodes.
      // Match on directory name AND pack metadata name/registryId — registry
      // `name` often differs from the folder the zip extracted to.
      let instancePath = ''
      if (opts?.instanceId) {
        const inst = loadInstanceConfigs().find((c) => c.id === opts.instanceId)
        if (inst?.path) instancePath = inst.path
      }
      const installed = collectInstalledKeys(instancePath, packKeyVariants)
      try {
        const { nodePackService } = await import('../nodePack')
        for (const p of nodePackService.list(opts?.instanceId)) {
          if (p.name) for (const v of packKeyVariants(p.name)) installed.add(v)
          if (p.registryId) for (const v of packKeyVariants(p.registryId)) installed.add(v)
        }
      } catch {
        /* nodePack unavailable — directory keys still apply */
      }
      return toPageResult(result, (n) => mapMarketItem(n, installed, opts?.category || 'tools'))
    } catch (err) {
      if (settings.networkMode === 'offline') {
        return {
          items: [],
          total: 0,
          page: opts?.page || 1,
          pageSize: opts?.limit || 50,
          totalPages: 0,
          scanned: 0,
          clientFiltered: Boolean(opts?.query)
        }
      }
      throw err
    }
  }
}

function readdirSafe(instancePath: string): string[] {
  if (!instancePath) return []
  try {
    const dir = join(instancePath, 'custom_nodes')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Keys that mark a registry item as already installed: every normalized form
 * of the directory basename. Metadata names / registryIds are merged in by the
 * caller once nodePack is loaded.
 */
function collectInstalledKeys(
  instancePath: string,
  variants: (s: string) => string[]
): Set<string> {
  const keys = new Set<string>()
  for (const n of readdirSafe(instancePath)) {
    if (n.startsWith('.') || n === '__pycache__' || n === '__MACOSX' || n === 'node_modules')
      continue
    for (const v of variants(n)) keys.add(v)
  }
  return keys
}

export const marketService = new MarketService()
