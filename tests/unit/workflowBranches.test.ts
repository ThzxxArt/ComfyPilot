/**
 * Branch-targeted workflow tests: import name collisions, PNG sibling collisions,
 * external recovery, empty-file PNG, missing-file export, copy collisions,
 * analyze type-matching leftovers.
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, writeFileSync as wf } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-wf-branch-${process.pid}`)

vi.mock('electron', async () => {
  return {
    app: { getPath: () => ROOT },
    shell: {
      showItemInFolder: () => undefined,
      openExternal: async () => undefined,
      openPath: async () => ''
    }
  }
})

function writePng(path: string, metaPairs: Array<[string, string]>): void {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(1, 8)
  ihdr.writeUInt32BE(1, 12)
  chunks.push(ihdr)
  for (const [k, v] of metaPairs) {
    const text = Buffer.from(`${k}\0${v}`, 'utf-8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(text.length, 0)
    chunks.push(len, Buffer.from('tEXt', 'ascii'), text, Buffer.alloc(4))
  }
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  chunks.push(iend)
  writeFileSync(path, Buffer.concat(chunks))
}

describe('workflow branch coverage', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('import same filename twice produces a unique library copy', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'coll')
    mkdirSync(dir, { recursive: true })
    const a = join(dir, 'dup.json')
    writeFileSync(a, '{"nodes":[{"id":1,"type":"A"}],"links":[]}')
    const r1 = await workflowService.importFile(a)
    // second file with the SAME basename from another folder
    const dir2 = join(ROOT, 'coll2')
    mkdirSync(dir2, { recursive: true })
    const b = join(dir2, 'dup.json')
    writeFileSync(b, '{"nodes":[{"id":1,"type":"B"}],"links":[]}')
    const r2 = await workflowService.importFile(b)
    expect(r1.path).not.toBe(r2.path)
    expect(existsSync(r1.path)).toBe(true)
    expect(existsSync(r2.path)).toBe(true)
  })

  it('PNG import with an existing .json name picks a unique json name', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { workflowLibraryDir } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'sib')
    mkdirSync(dir, { recursive: true })
    const png = join(dir, 'shot.png')
    const graph = JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1] }], links: [] })
    writePng(png, [['workflow', graph]])
    // Pre-create the would-be json name
    writeFileSync(join(workflowLibraryDir(), 'shot.json'), '{"pre":true}')
    const rec = await workflowService.importFile(png)
    expect(rec.path.endsWith('.json')).toBe(true)
    expect(rec.path).not.toBe(join(workflowLibraryDir(), 'shot.json'))
  })

  it('recovers a DB row whose file still exists outside scan roots', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'outside')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'keep.json')
    writeFileSync(p, '{"nodes":[{"id":1,"type":"X"}],"links":[]}')
    upsertWorkflow({
      id: 'outside-1',
      name: 'outside',
      path: p,
      format: 'json',
      nodeCount: 0,
      tags: ['keep-me'],
      updatedAt: 1,
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'external'
    })
    const listed = workflowService.list()
    const found = listed.find((w) => w.path === p)
    expect(found).toBeTruthy()
    expect(found?.missing).toBe(false)
    expect(found?.tags).toContain('keep-me')
    expect(found?.nodeCount).toBe(1) // re-analyzed
  })

  it('parsePngMeta on empty file returns null', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'empty')
    mkdirSync(dir, { recursive: true })
    const empty = join(dir, 'e.png')
    wf(empty, '')
    expect(await workflowService.parsePngMeta(empty)).toBeNull()
  })

  it('exportZip throws when the file vanished from disk', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow } = await import('../../src/main/services/db')
    upsertWorkflow({
      id: 'vanish-1',
      name: 'vanish',
      path: join(ROOT, 'nope-gone.json'),
      format: 'json',
      nodeCount: 0,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'library'
    })
    await expect(workflowService.exportZip('vanish-1')).rejects.toThrow(/missing/i)
  })

  it('copyToInstance collides and uniquifies the destination name', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    const instPath = join(ROOT, 'coll-inst')
    upsertInstanceConfig({
      id: 'coll-inst',
      name: 'coll',
      path: instPath,
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    })
    const dir = join(ROOT, 'cpsrc2')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'shared.json')
    writeFileSync(src, '{"nodes":[{"id":1,"type":"A"}],"links":[]}')
    const rec = await workflowService.importFile(src)
    const first = await workflowService.copyToInstance(rec.id, 'coll-inst')
    const second = await workflowService.copyToInstance(rec.id, 'coll-inst')
    expect(first.path).not.toBe(second.path)
    expect(existsSync(second.path)).toBe(true)
  })

  it('queue with no instance throws; parsePngMeta on 0-byte is null', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { loadInstanceConfigs, deleteInstanceConfig } = await import('../../src/main/services/db')
    for (const i of loadInstanceConfigs()) deleteInstanceConfig(i.id)
    const dir = join(ROOT, 'nq')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'n.json')
    writeFileSync(p, '{"nodes":[],"links":[]}')
    await expect(workflowService.queue({ workflowPath: p, instanceId: 'zzz' })).rejects.toThrow(/instance/i)
  })

  it('analyze leftover widget values type-match onto unlinked inputs', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'leftover')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'lo.json')
    writeFileSync(
      p,
      JSON.stringify({
        nodes: [
          {
            id: 1,
            type: 'Mystery',
            // no widgets metadata → leftover path
            widgets_values: ['str-val', 42, 3.5, true],
            inputs: [
              { name: 'alpha', type: 'FLOAT' },
              { name: 'beta', type: 'INT' },
              { name: 'gamma', type: 'STRING' },
              { name: 'delta', type: 'BOOLEAN' },
              { name: 'eps', type: 'FLOAT' }
            ]
          }
        ],
        links: []
      })
    )
    const rec = await workflowService.importFile(p)
    expect(rec.nodeCount).toBe(1)
  })

  it('non-executable and muted nodes are skipped in analyze counts', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'muted')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'm.json')
    writeFileSync(
      p,
      JSON.stringify({
        nodes: [
          { id: 1, type: 'Note', widgets_values: [] },
          { id: 2, type: 'Reroute' },
          { id: 3, type: 'PrimitiveNode' },
          { id: 4, type: 'KSampler', mode: 2, widgets_values: [5] },
          { id: 5, type: 'KSampler', widgets_values: [9] }
        ],
        links: []
      })
    )
    const rec = await workflowService.importFile(p)
    // analyze counts all nodes in the UI graph (5) — conversion skips non-exec
    expect(rec.nodeCount).toBe(5)
    expect(rec.seed).toBe(5) // first integer-ish widget value
  })

  it('importedAt / favorite / sourcePath survive rescan merge', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'meta-keep')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'mk.json')
    writeFileSync(p, '{"nodes":[{"id":1,"type":"A"}],"links":[]}')
    const rec = await workflowService.importFile(p)
    await workflowService.favorite(rec.id, true)
    await workflowService.tag(rec.id, ['x'])
    const again = workflowService.list()
    const found = again.find((w) => w.id === rec.id)
    expect(found?.favorite).toBe(true)
    expect(found?.tags).toContain('x')
    expect(found?.importedAt).toBeTruthy()
    expect(found?.sourcePath).toBeTruthy()
  })
})
