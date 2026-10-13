import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import type { MarketItem, RegistryNodePack } from '@shared/types'
import { cacheDir, loadSettings } from './db'
import { fetchRegistryPage, mapMarketItem, mapRegistryPack, matchesQuery } from './registry'

export interface RegistryIndexMeta {
  updatedAt: number
  total: number
  pages: number
  count: number
  /** Pages that failed to fetch during the last full build. */
  skippedPages: number
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
        count: data.items.length,
        skippedPages: data.skippedPages || 0
      }
      return true
    } catch {
      return false
    }
  }

  private saveToDisk(
    items: Array<Record<string, unknown>>,
    total: number,
    pages: number,
    skippedPages = 0
  ): void {
    try {
      const dir = cacheDir()
      mkdirSync(dir, { recursive: true })
      const file: IndexFile = {
        updatedAt: Date.now(),
        total,
        pages,
        count: items.length,
        skippedPages,
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
      count: this.items?.length || 0,
      skippedPages: this.meta?.skippedPages || 0
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
    if (
      !opts?.force &&
      !this.items &&
      this.loadFromDisk() &&
      this.meta &&
      Date.now() - this.meta.updatedAt < MAX_AGE_MS
    ) {
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
    // `done` is a high-water mark: 6 workers report page numbers out of order.
    let maxDone = 1
    let skippedPages = 0
    this.emit('progress', { done: maxDone, total: totalPages, count: collected.length })

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
          skippedPages++
        }
        if (pg > maxDone) maxDone = pg
        this.emit('progress', { done: maxDone, total: totalPages, count: collected.length })
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
      count: unique.length,
      skippedPages
    }
    this.saveToDisk(unique, this.meta.total, totalPages, skippedPages)
    this.emit('ready', this.status())
    if (skippedPages > 0) {
      // Surface skipped pages — a silently partial index looks like missing packs.
      void import('../ipc/handlers')
        .then(({ broadcastNotification }) => {
          broadcastNotification({
            type: 'warning',
            title: 'Registry index incomplete',
            titleKey: 'notify.indexWarning',
            message: `${skippedPages} of ${totalPages} catalog pages failed to fetch and were skipped. Search results may be incomplete — retry "Refresh full index" later.`,
            duration: 10000
          })
        })
        .catch(() => {
          /* notification is best-effort */
        })
    }
  }

  /** Search the FULL catalog (not a single page). */
  async search(opts: { query: string; page?: number; limit?: number }): Promise<{
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

  /**
   * Look up a catalog entry by git repository URL. Tolerates the common URL
   * spellings (https / scp-style ssh / git+ / trailing .git / trailing slash)
   * so a manually cloned pack can still be matched to its registry entry.
   */
  findByRepository(repository: string): RegistryNodePack | null {
    const needle = normalizeRepositoryUrl(repository)
    if (!needle) return null
    for (const n of this.items || []) {
      const repo = normalizeRepositoryUrl(String(n.repository || n.html_url || ''))
      if (repo && repo === needle) return mapRegistryPack(n)
    }
    return null
  }

  searchMarket(query: string, installed: Set<string>, limit = 200): MarketItem[] {
    const all = this.items || []
    const q = String(query || '').trim()
    const matched = q ? all.filter((n) => matchesQuery(n, q)) : all
    return matched.slice(0, limit).map((n) => mapMarketItem(n, installed))
  }
}

export const registryIndex = new RegistryIndexService()

/** Canonical form of a git URL for equality matching. */
export function normalizeRepositoryUrl(url: string): string {
  let s = String(url || '')
    .trim()
    .toLowerCase()
  if (!s) return ''
  s = s.replace(/^git\+/, '')
  // scp-style: git@github.com:owner/repo(.git)
  const scp = /^git@([^:]+):(.+)$/.exec(s)
  if (scp) s = `https://${scp[1]}/${scp[2]}`
  s = s.replace(/^ssh:\/\/git@/, 'https://').replace(/^git:\/\//, 'https://')
  // Order matters: `repo.git/` must collapse to `repo` too.
  s = s.replace(/\/+$/, '')
  s = s.replace(/\.git$/, '')
  s = s.replace(/\/+$/, '')
  return s
}
