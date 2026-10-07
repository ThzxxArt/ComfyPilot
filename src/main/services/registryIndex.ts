import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import type { MarketItem, RegistryNodePack } from '@shared/types'
import { cacheDir, loadSettings } from './db'
import { fetchRegistryPage, mapMarketItem, mapRegistryPack, matchesQuery } from './registry'

/** Lightweight row kept in the local full-catalog index. */
export interface RegistryIndexRow {
  raw: Record<string, unknown>
}

export interface RegistryIndexMeta {
  updatedAt: number
  total: number
  pages: number
  count: number
}

type IndexFile = RegistryIndexMeta & { items: Array<Record<string, unknown>> }

const INDEX_NAME = 'registry-index.json'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function indexPath(): string {
  return join(cacheDir(), INDEX_NAME)
}

function slimNode(n: Record<string, unknown>): Record<string, unknown> {
  // keep only fields used for search / mapping — drop changelog, deps, banners
  const publisher = n.publisher
  return {
    id: n.id,
    name: n.name,
    displayName: n.displayName,
    title: n.title,
    description: n.description,
    author: n.author,
    publisher:
      publisher && typeof publisher === 'object'
        ? { name: (publisher as { name?: string }).name, id: (publisher as { id?: string }).id }
        : publisher,
    category: n.category,
    tags: n.tags,
    downloads: n.downloads,
    github_stars: n.github_stars,
    stars: n.stars,
    score: n.score,
    icon: n.icon,
    status: n.status,
    repository: n.repository,
    html_url: n.html_url,
    latest_version:
      n.latest_version && typeof n.latest_version === 'object'
        ? { version: (n.latest_version as { version?: string }).version }
        : n.latest_version,
    version: n.version
  }
}

export class RegistryIndexService extends EventEmitter {
  private items: Array<Record<string, unknown>> | null = null
  private meta: RegistryIndexMeta | null = null
  private building: Promise<void> | null = null

  private loadFromDisk(): boolean {
    try {
      const p = indexPath()
      if (!existsSync(p)) return false
      const data = JSON.parse(readFileSync(p, 'utf-8')) as IndexFile
      if (!Array.isArray(data.items) || data.items.length < 50) return false
      this.items = data.items
      this.meta = {
        updatedAt: data.updatedAt || 0,
        total: data.total || data.items.length,
        pages: data.pages || 0,
        count: data.items.length
      }
      return true
    } catch {
      return false
    }
  }

  private saveToDisk(items: Array<Record<string, unknown>>, total: number, pages: number): void {
    try {
      const dir = cacheDir()
      mkdirSync(dir, { recursive: true })
      const file: IndexFile = {
        updatedAt: Date.now(),
        total,
        pages,
        count: items.length,
        items
      }
      const tmp = join(dir, `${INDEX_NAME}.tmp`)
      writeFileSync(tmp, JSON.stringify(file))
      renameSync(tmp, indexPath())
    } catch {
      /* cache is optional */
    }
  }

  status(): RegistryIndexMeta & { ready: boolean } {
    return {
      ready: Boolean(this.items),
      updatedAt: this.meta?.updatedAt || 0,
      total: this.meta?.total || 0,
      pages: this.meta?.pages || 0,
      count: this.items?.length || 0
    }
  }

  /** Ensure a full-catalog index exists. Rebuilds when missing/stale or force=true. */
  async ensure(opts?: { force?: boolean }): Promise<RegistryIndexMeta & { ready: boolean }> {
    const settings = loadSettings()
    if (settings.networkMode === 'offline') {
      if (!this.items) this.loadFromDisk()
      return this.status()
    }

    if (!opts?.force && this.items && this.meta && Date.now() - this.meta.updatedAt < MAX_AGE_MS) {
      return this.status()
    }
    if (!opts?.force && !this.items && this.loadFromDisk() && this.meta && Date.now() - this.meta.updatedAt < MAX_AGE_MS) {
      return this.status()
    }
    if (this.building) {
      await this.building
      return this.status()
    }

    this.building = this.buildFull()
      .catch((err) => {
        // keep any previous index on failure
        if (!this.items) this.loadFromDisk()
        throw err
      })
      .finally(() => {
        this.building = null
      })
    await this.building
    return this.status()
  }

  private async buildFull(): Promise<void> {
    // Discover size first
    const first = await fetchRegistryPage(1, 100)
    const pageSize = first.limit || 100
    const totalPages = first.totalPages || Math.ceil(first.total / pageSize) || 1
    const collected: Array<Record<string, unknown>> = first.nodes.map(slimNode)
    this.emit('progress', { done: 1, total: totalPages, count: collected.length })

    const concurrency = 6
    let next = 2
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const pg = next++
        if (pg > totalPages) break
        try {
          const p = await fetchRegistryPage(pg, pageSize)
          for (const n of p.nodes) collected.push(slimNode(n))
        } catch {
          /* skip failed page */
        }
        this.emit('progress', { done: Math.min(pg, totalPages), total: totalPages, count: collected.length })
      }
    })
    await Promise.all(workers)

    // de-dupe by id/name
    const seen = new Set<string>()
    const unique: Array<Record<string, unknown>> = []
    for (const n of collected) {
      const key = String(n.id || n.name || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      unique.push(n)
    }

    this.items = unique
    this.meta = {
      updatedAt: Date.now(),
      total: first.total || unique.length,
      pages: totalPages,
      count: unique.length
    }
    this.saveToDisk(unique, this.meta.total, totalPages)
    this.emit('ready', this.status())
  }

  /** Search the FULL catalog (not a single page). */
  async search(opts: {
    query: string
    page?: number
    limit?: number
  }): Promise<{
    raw: Array<Record<string, unknown>>
    total: number
    page: number
    pageSize: number
    totalPages: number
    scanned: number
    clientFiltered: boolean
  }> {
    await this.ensure()
    const all = this.items || []
    const query = String(opts.query || '').trim()
    const pageSize = Math.min(100, Math.max(1, Math.floor(opts.limit || 50)))
    const page = Math.max(1, Math.floor(opts.page || 1))
    const matched = query ? all.filter((n) => matchesQuery(n, query)) : all
    const startIdx = (page - 1) * pageSize
    return {
      raw: matched.slice(startIdx, startIdx + pageSize),
      total: matched.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(matched.length / pageSize)),
      scanned: all.length,
      clientFiltered: Boolean(query)
    }
  }

  searchPacks(query: string, limit = 200): RegistryNodePack[] {
    const all = this.items || []
    const q = String(query || '').trim()
    const matched = q ? all.filter((n) => matchesQuery(n, q)) : all
    return matched.slice(0, limit).map(mapRegistryPack)
  }

  searchMarket(query: string, installed: Set<string>, limit = 200): MarketItem[] {
    const all = this.items || []
    const q = String(query || '').trim()
    const matched = q ? all.filter((n) => matchesQuery(n, q)) : all
    return matched.slice(0, limit).map((n) => mapMarketItem(n, installed))
  }
}

export const registryIndex = new RegistryIndexService()
