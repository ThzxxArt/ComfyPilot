/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  models: [] as any[],
  settings: { modelScanRoots: [] as string[] },
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
  loadInstanceConfigs: () => [],
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
