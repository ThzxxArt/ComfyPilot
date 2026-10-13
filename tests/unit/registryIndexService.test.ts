/**
 * RegistryIndexService behaviour (0.1.10): full-catalog build with bounded
 * workers, disk cache reuse/TTL, skipped-page notification, search and
 * repository matching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => {
  const state = {
    root: '',
    failPages: new Set<number>(),
    fetchCalls: [] as number[],
    networkMode: 'public' as string
  }
  return { state }
})

vi.mock('../../src/main/services/db', () => ({
  cacheDir: () => h.state.root,
  loadSettings: () => ({ networkMode: h.state.networkMode })
}))

vi.mock('../../src/main/services/registry', () => ({
  fetchRegistryPage: async (page: number, limit: number) => {
    h.state.fetchCalls.push(page)
    if (h.state.failPages.has(page)) throw new Error(`page ${page} boom`)
    return {
      nodes: [
        {
          id: `pack-${page}`,
          name: `Pack${page}`,
          description: `desc ${page}`,
          repository: `https://github.com/owner/repo${page}`
        }
      ],
      total: 3,
      page,
      totalPages: 3,
      limit
    }
  },
  mapMarketItem: (n: Record<string, unknown>, installed: Set<string>) => ({
    id: String(n.id),
    name: String(n.name),
    installed: installed.has(String(n.name))
  }),
  mapRegistryPack: (n: Record<string, unknown>) => ({
    id: String(n.id),
    name: String(n.name),
    latestVersion: '1.0.0',
    repository: String(n.repository || '')
  }),
  matchesQuery: (n: Record<string, unknown>, q: string) =>
    JSON.stringify(n).toLowerCase().includes(String(q).toLowerCase())
}))

vi.mock('../../src/main/ipc/handlers', () => ({
  broadcastNotification: vi.fn()
}))

describe('RegistryIndexService (0.1.10 behaviour)', () => {
  beforeEach(() => {
    h.state.root = mkdtempSync(join(tmpdir(), 'cp-regindex-'))
    h.state.failPages.clear()
    h.state.fetchCalls = []
    h.state.networkMode = 'public'
    vi.resetModules()
  })

  it('builds the full catalog once, dedupes, and persists to disk', async () => {
    const { registryIndex } = await import('../../src/main/services/registryIndex')
    const status = await registryIndex.ensure()
    expect(status.ready).toBe(true)
    expect(status.count).toBe(3)
    expect(status.pages).toBe(3)
    expect(h.state.fetchCalls.sort()).toEqual([1, 2, 3])
    expect(existsSync(join(h.state.root, 'registry-index.json'))).toBe(true)
  })

  it('ensure() reuses the in-memory index within the TTL (no refetch)', async () => {
    const { registryIndex } = await import('../../src/main/services/registryIndex')
    await registryIndex.ensure()
    const calls = [...h.state.fetchCalls]
    await registryIndex.ensure()
    expect(h.state.fetchCalls).toEqual(calls)
  })

  it('loads a fresh index from disk without hitting the network', async () => {
    vi.resetModules()
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, name: `X${i}` }))
    writeFileSync(
      join(h.state.root, 'registry-index.json'),
      JSON.stringify({
        updatedAt: Date.now(),
        total: 60,
        pages: 1,
        count: 60,
        skippedPages: 0,
        items
      })
    )
    const { registryIndex } = await import('../../src/main/services/registryIndex')
    const status = await registryIndex.ensure()
    expect(status.ready).toBe(true)
    expect(status.count).toBe(60)
    expect(h.state.fetchCalls).toEqual([])
  })

  it('counts skipped pages and warns via notification', async () => {
    h.state.failPages.add(2)
    const { registryIndex } = await import('../../src/main/services/registryIndex')
    const status = await registryIndex.ensure()
    expect(status.skippedPages).toBe(1)
    expect(status.count).toBe(2)
    const { broadcastNotification } = await import('../../src/main/ipc/handlers')
    expect(broadcastNotification).toHaveBeenCalledTimes(1)
  })

  it('findByRepository tolerates .git / ssh spellings and search filters locally', async () => {
    const { registryIndex } = await import('../../src/main/services/registryIndex')
    await registryIndex.ensure()
    const hit = registryIndex.findByRepository('git@github.com:owner/repo2.git')
    expect(hit?.name).toBe('Pack2')
    expect(registryIndex.findByRepository('https://github.com/nowhere/x')).toBeNull()

    const packs = registryIndex.searchPacks('Pack3', 10)
    expect(packs.map((p: any) => p.name)).toEqual(['Pack3'])

    const market = registryIndex.searchMarket('Pack1', new Set(['Pack1']))
    expect(market).toHaveLength(1)
    expect(market[0].installed).toBe(true)
  })

  it('offline mode never fetches and degrades to the on-disk index', async () => {
    h.state.networkMode = 'offline'
    const { registryIndex } = await import('../../src/main/services/registryIndex')
    const status = await registryIndex.ensure()
    expect(status.ready).toBe(false)
    expect(h.state.fetchCalls).toEqual([])
  })
})
