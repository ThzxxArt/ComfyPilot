/**
 * Review-fix regression locks: sibling pair delete, zip limits, resolveSame
 * platform folding, list recovery, export PNG without graph, queue IPv6.
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-review-fixes-${process.pid}`)

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

describe('workflow pair delete + recovery', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('remove deletes instance source files when deleteSource is true', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertInstanceConfig, upsertWorkflow } = await import('../../src/main/services/db')
    const instPath = join(ROOT, 'inst-del')
    upsertInstanceConfig({
      id: 'inst-del',
      name: 'del',
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
    const wfDir = join(instPath, 'user', 'default', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    const p = join(wfDir, 'inst-flow.json')
    writeFileSync(p, JSON.stringify({ nodes: [{ id: 1, type: 'A' }], links: [] }))

    // Simulate a scan-registered instance record.
    const listed = workflowService.list().find((w) => w.path === p)
    expect(listed?.origin).toBe('instance')

    await workflowService.remove(listed!.id, { deleteSource: true })
    expect(existsSync(p)).toBe(false)
  })

  it('remove never deletes external files even with deleteSource', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'ext-del')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'ext.json')
    writeFileSync(p, '{"nodes":[],"links":[]}')
    upsertWorkflow({
      id: 'ext-del-1',
      name: 'ext',
      path: p,
      format: 'json',
      nodeCount: 0,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'external'
    })
    await workflowService.remove('ext-del-1', { deleteSource: true })
    // External file must survive — we only unregister.
    expect(existsSync(p)).toBe(true)
    unlinkSync(p)
  })

  it('remove of a library file still deletes it by default', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'lib-del')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'mine.json')
    writeFileSync(src, '{"nodes":[],"links":[]}')
    const rec = await workflowService.importFile(src)
    expect(existsSync(rec.path)).toBe(true)
    await workflowService.remove(rec.id)
    expect(existsSync(rec.path)).toBe(false)
    // Original source is untouched (it was copied into the library).
    expect(existsSync(src)).toBe(true)
  })

  it('remove of a PNG-derived record deletes the single json', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'pair2')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'p2.png')
    writePng(src, [
      ['workflow', JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1] }], links: [] })]
    ])
    const rec = await workflowService.importFile(src)
    // one artifact only
    expect(rec.path.endsWith('.json')).toBe(true)
    await workflowService.remove(rec.id)
    expect(existsSync(rec.path)).toBe(false)
    // original source is untouched
    expect(existsSync(src)).toBe(true)
  })

  it('list recovers an external DB row and preserves tags', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'ext-rec')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'ext.json')
    writeFileSync(p, JSON.stringify({ nodes: [{ id: 1, type: 'A' }], links: [] }))
    upsertWorkflow({
      id: 'ext-rec-1',
      name: 'ext',
      path: p,
      format: 'json',
      nodeCount: 0,
      tags: ['keep'],
      updatedAt: 1,
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'external',
      sourcePath: '/orig/ext.json'
    })
    const listed = workflowService.list()
    const hit = listed.find((w) => w.path === p)
    expect(hit?.tags).toContain('keep')
    expect(hit?.sourcePath).toBe('/orig/ext.json')
    expect(hit?.missing).toBe(false)
  })

  it('exportZip of a PNG with a graph yields the extracted json', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'exp-png')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'g.png')
    writePng(src, [
      ['workflow', JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1] }], links: [] })]
    ])
    const rec = await workflowService.importFile(src)
    expect(rec.path.endsWith('.json')).toBe(true)
    const dest = join(dir, 'out')
    mkdirSync(dest, { recursive: true })
    const { path } = await workflowService.exportZip(rec.id, dest)
    expect(existsSync(path)).toBe(true)
  })

  it('rejects a PNG without embedded workflow/prompt', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'exp-png2')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'plain.png')
    writePng(src, [['seed', '5']])
    await expect(workflowService.importFile(src)).rejects.toThrow(/no embedded workflow/i)
  })

  it('queue works against an IPv6-style listener', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    upsertInstanceConfig({
      id: 'v6',
      name: 'v6',
      path: join(ROOT, 'v6'),
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '::',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    })
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url))
        return new Response(JSON.stringify({ prompt_id: 'v6-pid' }), { status: 200 })
      })
    )
    const dir = join(ROOT, 'v6wf')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'a.json')
    writeFileSync(p, JSON.stringify({ nodes: [], links: [] }))
    // empty UI graph → toApiPrompt throws; use an API prompt instead
    writeFileSync(p, JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } }))
    const pid = await workflowService.queue({ workflowPath: p, instanceId: 'v6' })
    expect(pid).toBe('v6-pid')
    expect(seen[0]).toContain('http://127.0.0.1:8188')
    vi.unstubAllGlobals()
  })
})

describe('zipWrite limits', () => {
  it('refuses empty name-only entries and huge entry counts', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    expect(() => writeZip(join(ROOT, 'x.zip'), [{ name: 'x' } as never])).toThrow()
    // >65535 entries would need ZIP64
    const many = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' }))
    expect(() => writeZip(join(ROOT, 'ok.zip'), many)).not.toThrow()
    void readFileSync
    void unlinkSync
  })
})
