/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  settings: { networkMode: 'public' } as any,
  fetch: vi.fn() as any,
  search: vi.fn() as any
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.settings
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyFetch: (...a: unknown[]) => h.fetch(...a)
}))

vi.mock('../../src/main/services/registryIndex', () => ({
  registryIndex: {
    search: (...a: unknown[]) => h.search(...a)
  }
}))

import {
  fetchRegistryPage,
  mapMarketItem,
  mapRegistryPack,
  matchesQuery,
  packKeyVariants,
  searchRegistry,
  toPageResult
} from '../../src/main/services/registry'

function response(body: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => body }
}

beforeEach(() => {
  h.settings = { networkMode: 'public' }
  h.fetch.mockReset()
  h.search.mockReset()
})

describe('registry service', () => {
  it('fetches pages with sanitised paging and response defaults', async () => {
    h.fetch.mockResolvedValueOnce(
      response({
        nodes: [{ id: 'a' }],
        total: 10,
        page: 2,
        totalPages: 5,
        limit: 20
      })
    )
    expect(await fetchRegistryPage(2, 20)).toMatchObject({ total: 10, page: 2, totalPages: 5 })
    h.fetch.mockResolvedValueOnce(response({ items: [{ id: 'b' }] }))
    expect(await fetchRegistryPage(0, 0)).toMatchObject({ total: 1, page: 1, limit: 50 })
    h.fetch.mockResolvedValueOnce(response({ nodes: [], total: 200, limit: 0 }))
    expect((await fetchRegistryPage(NaN, 1000)).totalPages).toBe(2)
    h.fetch.mockResolvedValueOnce(response({}, false, 503))
    await expect(fetchRegistryPage(1, 50)).rejects.toThrow(/503/)
  })

  it('matches multi-word queries across fields and tags', () => {
    const n = {
      id: 'id1',
      name: 'Name',
      displayName: 'Display',
      title: 'Title',
      description: 'A description',
      publisher: { name: 'Publisher' },
      author: 'Author',
      category: 'Category',
      tags: ['TagOne', 2]
    }
    expect(matchesQuery(n, '')).toBe(true)
    expect(matchesQuery(n, '   ')).toBe(true)
    expect(matchesQuery(n, 'name display')).toBe(true)
    expect(matchesQuery(n, 'tagone 2')).toBe(true)
    expect(matchesQuery(n, 'publisher')).toBe(true)
    expect(matchesQuery(n, 'missing')).toBe(false)
    expect(matchesQuery({ id: 'x', tags: 'not-array' }, 'x')).toBe(true)
  })

  it('maps registry packs across value shapes', () => {
    expect(
      mapRegistryPack({
        id: 'a',
        name: 'A',
        displayName: 'Display',
        description: 'D',
        publisher: { name: 'P' },
        latest_version: { version: '1.0' },
        repository: 'repo',
        tags: ['t', 2],
        downloads: 3,
        score: 4,
        icon: 'i',
        status: 'flagged'
      })
    ).toMatchObject({
      id: 'a',
      author: 'P',
      latestVersion: '1.0',
      tags: ['t', '2'],
      downloads: 3,
      score: 4,
      icon: 'i',
      status: 'flagged'
    })
    expect(mapRegistryPack({ name: 'B', title: 'T', version: 2 })).toMatchObject({
      id: 'B',
      displayName: 'T',
      latestVersion: '2'
    })
    expect(mapRegistryPack({})).toMatchObject({ id: 'undefined', tags: [], status: 'active' })
    expect(
      mapRegistryPack({
        author: { name: 'N' },
        latest_version: { name: 'n' },
        downloadsTotal: 9,
        github_stars: 8
      })
    ).toMatchObject({ author: 'N', latestVersion: 'n', downloads: 9, score: 8 })
    expect(
      mapRegistryPack({ author: { id: 'id' }, latest_version: { tag: 'tag' }, html_url: 'u' })
    ).toMatchObject({ author: 'id', latestVersion: 'tag', repository: 'u' })
    expect(
      mapRegistryPack({ author: { displayName: 'D' }, latest_version: { id: 'i' }, homepage: 'h' })
    ).toMatchObject({ author: 'D', latestVersion: 'i', repository: 'h' })
    expect(
      mapRegistryPack({ publisher: {}, latest_version: true, author: 7, repository: 8 })
    ).toBeTruthy()
  })

  it('normalises pack keys and market items', () => {
    expect(packKeyVariants('')).toEqual([])
    expect(packKeyVariants(' Ab ')).toEqual(['Ab', 'ab'])
    expect(packKeyVariants('Ab')).toEqual(['Ab', 'ab'])
    const installed = new Set(['pack', 'id'])
    expect(
      mapMarketItem({ name: 'Pack', id: 'ID', displayName: 'Display' }, installed)
    ).toMatchObject({ id: 'ID', installed: true })
    expect(mapMarketItem({ name: 'Other' }, new Set(), '')).toMatchObject({
      id: 'Other',
      category: 'tools'
    })
    expect(
      mapMarketItem(
        {
          name: 'N',
          title: 'T',
          publisher: { name: 'P' },
          latest_version: { version: '1' },
          category: 'cat',
          tags: ['x'],
          downloads: 1,
          github_stars: 2,
          repository: 'r',
          icon: 'i',
          rating: 3
        },
        new Set()
      )
    ).toMatchObject({ displayName: 'T', author: 'P', version: '1', stars: 2 })
    expect(
      mapMarketItem(
        {
          name: 'N',
          author: { id: 'a' },
          version: '2',
          stars: 4,
          html_url: 'h',
          rating: 5
        },
        new Set()
      )
    ).toMatchObject({ author: 'a', version: '2', stars: 4, repository: 'h' })
    expect(
      mapMarketItem(
        { name: 'N', author: { displayName: 'D' }, latest_version: { name: 'n' }, score: 6 },
        new Set()
      )
    ).toMatchObject({ author: 'D', version: 'n', stars: 6 })
    expect(
      mapMarketItem({ name: 'N', latest_version: 3, author: 1, rating: 0 }, new Set())
    ).toBeTruthy()
  })

  it('searches offline, via index and live with error handling', async () => {
    h.settings = { networkMode: 'offline' }
    expect(await searchRegistry({})).toMatchObject({ raw: [], total: 0 })
    h.settings = { networkMode: 'public' }
    h.search.mockResolvedValueOnce({ raw: [], total: 0, page: 1 })
    expect(await searchRegistry({ query: 'q', page: 0, limit: 0 })).toMatchObject({ page: 1 })
    h.fetch.mockResolvedValueOnce(response({ nodes: [{ id: 'a' }] }))
    expect(await searchRegistry({})).toMatchObject({ scanned: 1 })
    h.settings = { networkMode: 'offline' }
    h.fetch.mockResolvedValueOnce(response({}, false, 500))
    expect(await searchRegistry({ page: -2 })).toMatchObject({ page: 1 })
    h.settings = { networkMode: 'public' }
    h.fetch.mockResolvedValueOnce(response({}, false, 500))
    await expect(searchRegistry({})).rejects.toThrow(/500/)
  })

  it('projects page results with optional index flag', () => {
    const base = {
      raw: [{ id: 'a' }],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    }
    expect(toPageResult(base, (n) => n.id)).toEqual({
      items: ['a'],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    expect(toPageResult({ ...base, needsIndex: true }, (n) => n.id)).toMatchObject({
      needsIndex: true
    })
  })
})
