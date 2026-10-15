/**
 * assetsApi service (0.1.14) — read-only assets-system lookup.
 * Contract: null = unavailable/failed (UI hides), [] = answered but no match.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const instanceConfigs = [
  {
    id: 'inst-a',
    name: 'A',
    path: 'C:/fake/ComfyUI',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    enabled: true
  }
]

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => instanceConfigs
}))

const links = new Map<string, { workflowId: string; workflowName?: string }>()
vi.mock('../../src/main/services/workflow', () => ({
  lookupPromptWorkflowLink: (pid: string) => links.get(pid)
}))

import { matchAssetsByFileName } from '../../src/main/services/assetsApi'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('matchAssetsByFileName (0.1.14)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let handler: (url: string) => Response

  beforeEach(() => {
    links.clear()
    handler = () => json({ assets: [], total: 0, has_more: false })
    fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null for an unknown instance without touching the network', async () => {
    const r = await matchAssetsByFileName('nope', 'a.png')
    expect(r).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when the assets system answers disabled (503)', async () => {
    handler = () => json({ error: { code: 'SERVICE_DISABLED' } }, 503)
    expect(await matchAssetsByFileName('inst-a', 'a.png')).toBeNull()
  })

  it('returns null on network failure instead of throwing', async () => {
    fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await matchAssetsByFileName('inst-a', 'a.png')).toBeNull()
  })

  it('returns [] when the API answered without matches', async () => {
    expect(await matchAssetsByFileName('inst-a', 'a.png')).toEqual([])
  })

  it('URL-encodes the file name into name_contains', async () => {
    await matchAssetsByFileName('inst-a', 'my render 001.png')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('name_contains=my%20render%20001.png')
  })

  it('maps an exact match with preview/url composition and tags', async () => {
    handler = () =>
      json({
        assets: [
          {
            id: 'asset-1',
            name: 'shot.png',
            loader_path: 'output/shot.png',
            job_id: 'prompt-1',
            tags: ['output', 'preview'],
            preview_url: '/api/assets/asset-1/content',
            size: 123,
            created_at: '2026-10-15T00:00:00Z'
          },
          { id: 'asset-2', name: 'other.png' }
        ],
        total: 2,
        has_more: false
      })
    const r = await matchAssetsByFileName('inst-a', 'shot.png')
    expect(r).toHaveLength(1)
    expect(r![0]).toMatchObject({
      id: 'asset-1',
      name: 'shot.png',
      loaderPath: 'output/shot.png',
      jobId: 'prompt-1',
      tags: ['output', 'preview'],
      previewUrl: 'http://127.0.0.1:8188/api/assets/asset-1/content',
      size: 123
    })
  })

  it('keeps absolute preview URLs untouched', async () => {
    handler = () =>
      json({
        assets: [{ id: 'a', name: 'x.exr', preview_url: 'https://cdn.example/x.webp' }]
      })
    const r = await matchAssetsByFileName('inst-a', 'x.exr')
    expect(r![0].previewUrl).toBe('https://cdn.example/x.webp')
  })

  it('resolves the workflow attribution through the local sidecar', async () => {
    links.set('prompt-9', { workflowId: 'wf-1', workflowName: 'Portrait' })
    handler = () => json({ assets: [{ id: 'a', name: 'p.png', job_id: 'prompt-9' }] })
    const r = await matchAssetsByFileName('inst-a', 'p.png')
    expect(r![0].workflowId).toBe('wf-1')
    expect(r![0].workflowName).toBe('Portrait')
  })

  it('falls back to the contains-filtered list when no exact name matches', async () => {
    handler = () => json({ assets: [{ id: 'a', name: 'shot_00001_.png' }] })
    const r = await matchAssetsByFileName('inst-a', 'shot.png')
    expect(r).toHaveLength(1)
    expect(r![0].id).toBe('a')
  })

  it('drops malformed records without an id', async () => {
    handler = () => json({ assets: [{ name: 'no-id.png' }, { id: 'ok', name: 'no-id.png' }] })
    const r = await matchAssetsByFileName('inst-a', 'no-id.png')
    expect(r!.map((x) => x.id)).toEqual(['ok'])
  })

  it('caps the returned hits at five', async () => {
    handler = () =>
      json({
        assets: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, name: 'dup.png' }))
      })
    const r = await matchAssetsByFileName('inst-a', 'dup.png')
    expect(r).toHaveLength(5)
  })
})
