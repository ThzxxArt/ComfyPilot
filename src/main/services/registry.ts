import type { MarketItem, RegistryNodePack, RegistryPageResult } from '@shared/types'
import { REGISTRY_API } from '@shared/constants'
import { loadSettings } from './db'

type RawNode = Record<string, unknown>

export interface RegistryPageFetch {
  nodes: RawNode[]
  total: number
  page: number
  totalPages: number
  limit: number
}

/**
 * Comfy Registry (api.comfy.org/nodes) supports `page` + `limit` + `sort_by`.
 * It IGNORES search query params — callers must filter client-side.
 */
export async function fetchRegistryPage(page: number, limit: number): Promise<RegistryPageFetch> {
  const safePage = Math.max(1, Math.floor(page) || 1)
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 50))
  const url = `${REGISTRY_API}/nodes?limit=${safeLimit}&page=${safePage}&sort_by=downloads`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ComfyPilot/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`Registry HTTP ${res.status}`)
  const data = (await res.json()) as {
    nodes?: RawNode[]
    items?: RawNode[]
    total?: number
    page?: number
    totalPages?: number
    limit?: number
  }
  const nodes = data.nodes || data.items || []
  const total = Number(data.total || nodes.length)
  const limitOut = Number(data.limit || safeLimit)
  const pageOut = Number(data.page || safePage)
  const totalPages = Number(data.totalPages || Math.max(1, Math.ceil(total / (limitOut || safeLimit))))
  return { nodes, total, page: pageOut, totalPages, limit: limitOut }
}

function textOf(n: RawNode): string {
  const tags = Array.isArray(n.tags) ? (n.tags as unknown[]).map(String).join(' ') : ''
  return [
    n.id,
    n.name,
    n.displayName,
    n.title,
    n.description,
    (n.publisher as { name?: string } | undefined)?.name,
    n.author,
    n.category,
    tags
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function matchesQuery(n: RawNode, query: string): boolean {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  // support multi-word AND
  return q.split(/\s+/).every((w) => textOf(n).includes(w))
}

function asVersion(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return String(o.version || o.name || o.tag || o.id || '')
  }
  return ''
}

function asName(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return String(o.name || o.id || o.displayName || '')
  }
  return String(v)
}

export function mapRegistryPack(n: RawNode): RegistryNodePack {
  return {
    id: String(n.id || n.name),
    name: String(n.name || ''),
    displayName: String(n.displayName || n.title || n.name),
    description: String(n.description || ''),
    author: asName((n.publisher as unknown) || n.author),
    latestVersion: asVersion(n.latest_version) || asVersion(n.version),
    repository: String(n.repository || n.html_url || n.homepage || ''),
    tags: Array.isArray(n.tags) ? (n.tags as unknown[]).map(String) : [],
    downloads: Number(n.downloads || n.downloadsTotal || 0),
    score: Number(n.score || n.github_stars || 0),
    icon: n.icon ? String(n.icon) : undefined,
    status: (n.status as RegistryNodePack['status']) || 'active'
  }
}

/**
 * All comparable identity forms for a pack name/id.
 * Registry `name`, folder basenames and local metadata drift apart in the wild
 * (ComfyUI-KJNodes / comfyui-kjnodes / kjnodes / ComfyUI_KJNodes). Matching
 * must compare the same normalized forms on BOTH sides or installs show as
 * "not installed" and the Install button stays clickable.
 */
export function packKeyVariants(s: string): string[] {
  const raw = String(s || '').trim()
  if (!raw) return []
  const lower = raw.toLowerCase()
  const stripped = lower.replace(/^comfyui[-_]/, '')
  const noSep = stripped.replace(/[-_\s]/g, '')
  return [...new Set([raw, lower, stripped, noSep].filter(Boolean))]
}

export function mapMarketItem(n: RawNode, installed: Set<string>, categoryFallback = 'tools'): MarketItem {
  const name = String(n.name || '')
  const id = String(n.id || name)
  const display = String(n.displayName || n.title || name)
  // Match against every normalized form of name / id / displayName.
  const isInstalled =
    [...packKeyVariants(name), ...packKeyVariants(id), ...packKeyVariants(display)].some((k) =>
      installed.has(k)
    )
  return {
    id,
    name,
    displayName: display,
    description: String(n.description || ''),
    author: asName((n.publisher as unknown) || n.author),
    version: asVersion(n.latest_version) || asVersion(n.version),
    category: String(n.category || categoryFallback || 'tools'),
    tags: Array.isArray(n.tags) ? (n.tags as unknown[]).map(String) : [],
    downloads: Number(n.downloads || 0),
    stars: Number(n.github_stars || n.stars || n.score || 0),
    installed: isInstalled,
    repository: String(n.repository || n.html_url || ''),
    icon: n.icon ? String(n.icon) : undefined,
    rating: Number(n.rating || 0)
  }
}

export interface SearchOpts {
  query?: string
  page?: number
  limit?: number
  /** how many remote pages to scan when filtering client-side */
  scanPages?: number
}

/**
 * Browse or search the registry.
 * - no query → one live server page (`page`/`limit`)
 * - with query → match against the FULL catalog via local index
 *   (api.comfy.org has no working search parameter)
 */
export async function searchRegistry(opts: SearchOpts = {}): Promise<{
  raw: RawNode[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  scanned: number
  clientFiltered: boolean
}> {
  const settings = loadSettings()
  const query = String(opts.query || '').trim()
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.limit || 50)))
  const page = Math.max(1, Math.floor(opts.page || 1))

  if (settings.networkMode === 'offline' && !query) {
    return { raw: [], total: 0, page, pageSize, totalPages: 0, scanned: 0, clientFiltered: false }
  }

  // Search mode: full-catalog local index (all ~5.8k packs)
  if (query) {
    const { registryIndex } = await import('./registryIndex')
    return registryIndex.search({ query, page, limit: pageSize })
  }

  // Browse mode: a single remote page
  try {
    const p = await fetchRegistryPage(page, pageSize)
    return {
      raw: p.nodes,
      total: p.total,
      page: p.page,
      pageSize: p.limit || pageSize,
      totalPages: p.totalPages,
      scanned: p.nodes.length,
      clientFiltered: false
    }
  } catch (err) {
    if (settings.networkMode === 'offline') {
      return { raw: [], total: 0, page, pageSize, totalPages: 0, scanned: 0, clientFiltered: false }
    }
    throw err
  }
}

export function toPageResult<T>(
  o: { raw: RawNode[]; total: number; page: number; pageSize: number; totalPages: number; scanned: number; clientFiltered: boolean },
  map: (n: RawNode) => T
): RegistryPageResult<T> {
  return {
    items: o.raw.map(map),
    total: o.total,
    page: o.page,
    pageSize: o.pageSize,
    totalPages: o.totalPages,
    scanned: o.scanned,
    clientFiltered: o.clientFiltered
  }
}
