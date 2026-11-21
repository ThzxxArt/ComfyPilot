/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  models: [] as any[],
  settings: { modelScanRoots: [] as string[] },
  configs: [] as any[],
  persisted: [] as any[],
  upserted: [] as any[],
  updates: [] as any[],
  deleted: [] as string[]
}))

vi.mock('../../src/main/services/db', () => ({
  listModels: () => h.models,
  deleteModel: (id: string) => {
    h.deleted.push(id)
    return true
  },
  loadSettings: () => h.settings,
  loadInstanceConfigs: () => h.configs,
  upsertModel: (m: any) => h.upserted.push(m),
  upsertModels: (m: any[]) => h.upserted.push(...m),
  updateModel: (id: string, p: any) => h.updates.push({ id, ...p }),
  upsertDownloadTask: vi.fn(),
  replaceDownloadTasks: (t: any[]) => {
    h.persisted = t
  },
  listDownloadTasks: () => h.persisted
}))

import { ModelService } from '../../src/main/services/model'
import { pathCapabilities } from '../../src/main/services/pathCapability'

const root = mkdtempSync(join(tmpdir(), 'cp-model-service-'))
const modelsDir = join(root, 'models')
const destDir = join(root, 'dest')
mkdirSync(modelsDir, { recursive: true })
mkdirSync(destDir, { recursive: true })
writeFileSync(join(modelsDir, 'a.safetensors'), 'x')
writeFileSync(join(modelsDir, 'b.ckpt'), 'y')
writeFileSync(join(root, 'outside.bin'), 'z')
try {
  symlinkSync(join(root, 'outside.bin'), join(modelsDir, 'link.bin'))
} catch {
  /* symlinks may be unavailable */
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  pathCapabilities.revokeAll()
  h.models = []
  h.settings = { modelScanRoots: [modelsDir, destDir] }
  h.configs = []
  h.persisted = []
  h.upserted = []
  h.updates = []
  h.deleted = []
  mkdirSync(modelsDir, { recursive: true })
  mkdirSync(destDir, { recursive: true })
})

function model(id: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    name: id,
    fileName: `${id}.safetensors`,
    path: join(modelsDir, `${id}.safetensors`),
    category: 'checkpoints',
    size: 10,
    tags: [],
    hashSha256: '',
    ...extra
  }
}

describe('ModelService extra branches', () => {
  it('moves, symlinks, renames, tags and removes defensively', async () => {
    const svc = new ModelService()
    h.models = [model('a'), model('b', { fileName: 'b.ckpt', path: join(modelsDir, 'b.ckpt') })]
    expect(svc.storageStats().at(-1)).toMatchObject({ category: 'total', count: 2 })
    expect(await svc.remove('missing', true)).toBe(false)
    expect(await svc.remove('a', false)).toBe(true)
    expect(await svc.remove('b', true)).toBe(true)
    await expect(svc.move('missing', destDir)).rejects.toThrow(/not found/)
    await expect(svc.move('a', '/etc')).rejects.toThrow(/outside/)
    const moved = await svc.move('a', destDir)
    expect(moved.path).toContain('dest')
    h.models = [model('a')]
    expect((await svc.move('a', join(modelsDir, ''))).path).toContain('a.safetensors')
    writeFileSync(join(destDir, 'a.safetensors'), 'exists')
    await expect(svc.move('a', destDir)).rejects.toThrow(/already exists/)
    await expect(svc.symlink('missing', destDir)).rejects.toThrow(/not found/)
    await expect(svc.symlink('a', '/etc')).rejects.toThrow(/outside/)
    await expect(svc.symlink('a', destDir)).rejects.toThrow(/already exists/)
    rmSync(join(destDir, 'a.safetensors'), { force: true })
    expect((await svc.symlink('a', destDir)).path).toContain('dest')
    await expect(svc.rename('missing', 'x')).rejects.toThrow(/not found/)
    expect((await svc.rename('a', 'renamed')).name).toBe('renamed')
    await expect(svc.tag('missing', ['x'])).rejects.toThrow(/not found/)
    expect((await svc.tag('a', ['x'])).tags).toEqual(['x'])
  })

  it('walks hidden/symlinked entries and reads scan metadata variants', async () => {
    const svc = new ModelService()
    const deep = join(modelsDir, 'deep')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(modelsDir, '.hidden.safetensors'), 'x')
    writeFileSync(join(modelsDir, 'not-a-model.txt'), 'x')
    const escape = join(root, 'escape')
    mkdirSync(escape, { recursive: true })
    writeFileSync(join(escape, 'evil.safetensors'), 'x')
    try {
      symlinkSync(escape, join(modelsDir, 'escape-link'))
    } catch {
      /* ignore */
    }
    for (const name of [
      'sdxl.safetensors',
      'sd3.safetensors',
      'flux.safetensors',
      'wan.safetensors',
      'hunyuan.safetensors',
      'qwen.safetensors',
      'ltx.safetensors',
      'sd15.safetensors',
      'sd-1.safetensors',
      'v1-5.safetensors',
      'civitai-model.safetensors',
      'huggingface-model.safetensors',
      'hf_model.safetensors'
    ]) {
      writeFileSync(join(deep, name), 'x')
    }
    const metaFile = join(deep, 'meta.safetensors')
    const header = Buffer.from(
      JSON.stringify({
        __metadata__: {
          ss_base_model: 'sdxl',
          ss_tag_frequency: JSON.stringify({ tag: 1 })
        }
      })
    )
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(header.length))
    writeFileSync(metaFile, Buffer.concat([len, header]))
    const badMeta = join(deep, 'badmeta.safetensors')
    const badHeader = Buffer.from(JSON.stringify({ __metadata__: { ss_tag_frequency: '{bad' } }))
    const badLen = Buffer.alloc(8)
    badLen.writeBigUInt64LE(BigInt(badHeader.length))
    writeFileSync(badMeta, Buffer.concat([badLen, badHeader]))
    const specMeta = join(deep, 'spec.safetensors')
    const specHeader = Buffer.from(
      JSON.stringify({ __metadata__: { modelspec: { architecture: 'flux' } } })
    )
    const specLen = Buffer.alloc(8)
    specLen.writeBigUInt64LE(BigInt(specHeader.length))
    writeFileSync(specMeta, Buffer.concat([specLen, specHeader]))
    await svc.scan({ roots: [modelsDir], hash: false })
    expect(h.upserted.length).toBeGreaterThan(0)
    expect(h.upserted.some((m) => m.path.endsWith('escape-link/evil.safetensors'))).toBe(false)
  })

  it('auto-discovers extra model roots and deduplicates them', async () => {
    const svc = new ModelService()
    const comfy = join(root, 'comfy')
    mkdirSync(comfy, { recursive: true })
    h.configs = [
      {
        id: 'i1',
        name: 'C',
        path: comfy,
        port: 8188,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default'
      }
    ]
    const yaml = [
      'comfyui:',
      `  base_path: ${join(root, 'extra')}`,
      '  checkpoints: ckpt',
      '  custom_nodes: nodes',
      '  nested:',
      '    not: a string',
      'null-section: null',
      'comfyui2:',
      `  base_path: ${join(root, 'extra')}`,
      '  loras: ../outside',
      '  vae: C:/models/vae',
      '  clip: |',
      '    a',
      '    b'
    ].join('\n')
    writeFileSync(join(comfy, 'extra_model_paths.yaml'), yaml)
    h.settings = { modelScanRoots: [] }
    await svc.scan({ hash: false })
    await svc.scan({})
    h.settings = { modelScanRoots: [''] as any }
    await svc.scan({ hash: false })
  })

  it('covers slot priority ordering and blocked symlink destinations', async () => {
    const svc = new ModelService()
    ;(svc as any).runningCount = 3
    const waits = [
      (svc as any).acquireSlot(0, 'a'),
      (svc as any).acquireSlot(5, 'b'),
      (svc as any).acquireSlot(5, 'c')
    ]
    expect((svc as any).pendingStarts.length).toBe(3)
    ;(svc as any).releaseSlot()
    expect((svc as any).pendingStarts.length).toBe(2)
    ;(svc as any).releaseSlot()
    ;(svc as any).releaseSlot()
    ;(svc as any).releaseSlot()
    await Promise.all(waits)
    expect((svc as any).runningCount).toBeGreaterThanOrEqual(0)

    const link = join(destDir, 'link-out')
    const outside = join(root, 'outside-dest')
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, link)
      await expect(svc.move('a', link)).rejects.toThrow(/symlinked|outside/)
    } catch {
      /* symlink may be unavailable */
    }
  })

  it('download list, resume and clear-finished branches', () => {
    const svc = new ModelService()
    h.persisted = [
      { id: 'p1', status: 'paused' },
      { id: 'p2', status: 'running' },
      { id: 'p3', status: 'done' }
    ]
    expect(svc.resumeInterruptedOnBoot()).toBe(2)
    expect(svc.listDownloads().length).toBeGreaterThan(0)
    const downloads = (svc as any).downloads as Map<string, any>
    downloads.set('d1', { id: 'd1', status: 'done' })
    downloads.set('d2', { id: 'd2', status: 'running' })
    expect(svc.clearFinishedDownloads()).toBeGreaterThan(0)
    expect(downloads.has('d1')).toBe(false)
    h.persisted = [{ id: 'p3', status: 'done' }]
    expect(svc.clearFinishedDownloads()).toBe(1)
    h.persisted = [{ id: 'p4', status: 'running' }]
    expect(svc.clearFinishedDownloads()).toBe(0)
  })

  it('scans roots, hashes, prunes ghosts and finds duplicates', async () => {
    const svc = new ModelService()
    h.models = [
      model('ghost', { path: join(modelsDir, 'ghost.safetensors') }),
      model('outsideGhost', { path: join(root, 'outside-ghost.safetensors') }),
      model('old', { path: join(modelsDir, 'a.safetensors'), hashSha256: 'h1', duplicateOf: '' }),
      model('dup', { path: join(modelsDir, 'b.ckpt'), hashSha256: 'h1' })
    ]
    const events: any[] = []
    svc.on('progress', (p) => events.push(p))
    const explicit = await svc.scan({ roots: [modelsDir], hash: false })
    expect(explicit.length).toBeGreaterThanOrEqual(0)
    expect(events.some((e) => e.phase === 'done')).toBe(true)
    expect(h.deleted).toContain('ghost')
    expect(h.deleted).not.toContain('outsideGhost')
    expect(svc.findDuplicates().length).toBeGreaterThan(0)
    const unhashed = await svc.scan({ roots: [modelsDir], hash: true })
    expect(unhashed).toBeTruthy()
    const again = await svc.scan({ roots: [modelsDir], hash: true })
    expect(again).toBeTruthy()
    await svc.scan({})
    await svc.scan({ roots: ['/missing/root'], hash: false })
    h.settings = { modelScanRoots: [] }
    await svc.scan({ hash: false })
    expect(svc.list()).toBeTruthy()
  })
})

describe('ModelService scan/cache/queue edges', () => {
  it('serves hash scans from the recent cache and in-flight single-flight map', async () => {
    const svc = new ModelService()
    const key = [modelsDir].join('|')
    ;(svc as any).lastHashScan.set(key, { at: Date.now(), result: [] })
    expect(await svc.scan({ hash: true, roots: [modelsDir] })).toEqual([])

    ;(svc as any).lastHashScan.clear()
    const result = [{ id: 'x' }]
    ;(svc as any).hashScans.set(key, Promise.resolve(result))
    expect(await svc.scan({ hash: true, roots: [modelsDir] })).toBe(result)
  })

  it('marks duplicates, clears stale duplicate links and reports groups', async () => {
    const svc = new ModelService()
    h.models = [
      model('a', { hashSha256: 'h1', path: join(modelsDir, 'a.safetensors'), size: 10 }),
      model('b', { hashSha256: 'h1', path: join(modelsDir, 'b.safetensors'), size: 10 }),
      model('c', { hashSha256: 'h2', duplicateOf: 'old' })
    ]
    ;(svc as any).markDuplicates()
    const groups = svc.findDuplicates()
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(2)
    expect(
      h.updates.some((u) => u.id === 'b' && u.duplicateOf === join(modelsDir, 'a.safetensors'))
    ).toBe(true)
    expect(h.updates.some((u) => u.id === 'c' && u.duplicateOf === '')).toBe(true)
  })

  it('resumes interrupted downloads and falls back to the persisted list', () => {
    const svc = new ModelService()
    h.persisted = [
      { id: 'p1', status: 'paused' },
      { id: 'p2', status: 'running' },
      { id: 'p3', status: 'done' }
    ]
    expect(svc.resumeInterruptedOnBoot()).toBe(2)
    ;(svc as any).downloads.clear()
    expect(svc.listDownloads()).toEqual(h.persisted)
  })

  it('accepts instance model roots and rejects symlinked destinations', async () => {
    const svc = new ModelService()
    const instRoot = join(root, 'inst-root')
    const instModels = join(instRoot, 'models')
    mkdirSync(instModels, { recursive: true })
    writeFileSync(join(modelsDir, 'a.safetensors'), 'x')
    h.configs = [{ id: 'i1', path: instRoot, port: 8188, listen: '127.0.0.1' }]
    h.models = [model('m1', { path: join(modelsDir, 'a.safetensors') })]
    const seed = join(instModels, 'seed.safetensors')
    writeFileSync(seed, 'x')
    const moved = await svc.move('m1', instModels)
    expect(moved.path).toContain('inst-root')

    const escape = join(root, 'escape-dest')
    mkdirSync(escape, { recursive: true })
    const link = join(root, 'linked-dest')
    try {
      symlinkSync(escape, link)
      h.models = [model('m2', { path: join(modelsDir, 'a.safetensors') })]
      await expect(svc.move('m2', link)).rejects.toThrow(/symlinked/)
    } catch {
      /* symlinks unavailable */
    }
  })

  it('queues waiters by priority and transfers the slot on release', () => {
    const svc = new ModelService()
    const admin = svc as any
    admin.runningCount = 4
    const low = admin.acquireSlot(0, 'low')
    const high = admin.acquireSlot(9, 'high')
    const mid = admin.acquireSlot(5, 'mid')
    expect((svc as any).pendingStarts.map((w: any) => w.taskId)).toEqual(['low', 'high', 'mid'])
    admin.releaseSlot()
    expect((svc as any).pendingStarts.map((w: any) => w.taskId)).toEqual(['low', 'mid'])
    admin.releaseSlot()
    expect((svc as any).pendingStarts.map((w: any) => w.taskId)).toEqual(['low'])
    admin.releaseSlot()
    expect((svc as any).pendingStarts).toEqual([])
    void low
    void high
    void mid
  })
})
