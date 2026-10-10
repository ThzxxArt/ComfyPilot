/**
 * Deep workflow-service coverage: queue, export, copyToInstance, openInFrontend,
 * parsePngMeta, analyze graph shapes, rename collisions, remove non-library.
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-workflow-deep-${process.pid}`)

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

function writeApiPrompt(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { seed: 123, steps: 20 } },
      '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } }
    }),
    'utf-8'
  )
}

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

describe('workflow analyze shapes', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('analyzes API prompt form', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'api')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'api.json')
    writeApiPrompt(src)
    const rec = await workflowService.importFile(src)
    expect(rec.nodeCount).toBe(2)
    expect(rec.seed).toBe(123)
    expect(rec.modelUsed).toBe('model.safetensors')
  })

  it('analyzes wrapped {workflow:{nodes}} form', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'wrap')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'wrap.json')
    writeFileSync(
      src,
      JSON.stringify({
        workflow: {
          name: 'wrapped',
          nodes: [{ id: 1, type: 'Note', widgets_values: [] }],
          links: []
        }
      })
    )
    const rec = await workflowService.importFile(src)
    expect(rec.nodeCount).toBe(1)
    expect(rec.description).toBe('wrapped')
  })

  it('png meta without workflow/prompt is REJECTED', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'pngplain')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'plain.png')
    writePng(src, [['seed', '99'], ['model', 'x.safetensors']])
    await expect(workflowService.importFile(src)).rejects.toThrow(/no embedded workflow/i)
  })
})

describe('workflow queue / meta', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('parsePngMeta returns keys and rejects non-png / missing', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'meta')
    mkdirSync(dir, { recursive: true })
    const png = join(dir, 'm.png')
    writePng(png, [['prompt', '{"1":{"class_type":"KSampler","inputs":{"seed":5}}}']])
    const meta = await workflowService.parsePngMeta(png)
    expect(meta?.prompt).toBeTruthy()

    expect(await workflowService.parsePngMeta(join(dir, 'nope.png'))).toBeNull()
    const jpg = join(dir, 'a.jpg')
    writeFileSync(jpg, 'x')
    expect(await workflowService.parsePngMeta(jpg)).toBeNull()
  })

  it('queue posts to ComfyUI and returns prompt id', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { loadInstanceConfigs, upsertInstanceConfig } = await import('../../src/main/services/db')

    upsertInstanceConfig({
      id: 'q-inst',
      name: 'q',
      path: join(ROOT, 'q-inst'),
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '0.0.0.0',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    })
    expect(loadInstanceConfigs().some((i) => i.id === 'q-inst')).toBe(true)

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/prompt')) {
        expect(init?.method).toBe('POST')
        return new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const dir = join(ROOT, 'qwf')
    mkdirSync(dir, { recursive: true })
    const wf = join(dir, 'q.json')
    writeApiPrompt(wf)

    const pid = await workflowService.queue({ workflowPath: wf, instanceId: 'q-inst', seed: 7 })
    expect(pid).toBe('pid-1')
    vi.unstubAllGlobals()
  })

  it('queue throws on parse failure and on ComfyUI rejection', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'qerr')
    mkdirSync(dir, { recursive: true })
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, 'not-json')
    await expect(
      workflowService.queue({ workflowPath: bad, instanceId: 'q-inst' })
    ).rejects.toThrow(/parse|Unrecognized/i)

    const ok = join(dir, 'ok.json')
    writeApiPrompt(ok)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 }))
    )
    await expect(workflowService.queue({ workflowPath: ok, instanceId: 'q-inst' })).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('workflow export / copy / remove edges', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('exportZip writes a zip with README and json payload', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'exp')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'e.json')
    writeApiPrompt(src)
    const rec = await workflowService.importFile(src)
    const dest = join(dir, 'out')
    mkdirSync(dest, { recursive: true })
    const { path: zipPath } = await workflowService.exportZip(rec.id, dest)
    expect(existsSync(zipPath)).toBe(true)
    expect(readFileSync(zipPath).readUInt32LE(0)).toBe(0x04034b50)
  })

  it('exportZip of PNG with embedded workflow emits JSON payload', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'exppng')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'p.png')
    writePng(src, [
      ['workflow', JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1] }], links: [] })]
    ])
    const rec = await workflowService.importFile(src)
    const dest = join(dir, 'out')
    mkdirSync(dest, { recursive: true })
    const { path: zipPath } = await workflowService.exportZip(rec.id, dest)
    expect(existsSync(zipPath)).toBe(true)
  })

  it('copyToInstance places a file under user/default/workflows', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    const instPath = join(ROOT, 'inst-copy')
    upsertInstanceConfig({
      id: 'copy-inst',
      name: 'copy',
      path: instPath,
      pythonPath: '',
      venvPath: '',
      port: 8199,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    })
    const dir = join(ROOT, 'cpsrc')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'c.json')
    writeApiPrompt(src)
    const rec = await workflowService.importFile(src)
    const { path } = await workflowService.copyToInstance(rec.id, 'copy-inst')
    expect(existsSync(path)).toBe(true)
    expect(path.includes('user')).toBe(true)
  })

  it('remove of a non-library external record only drops the DB row', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow, listWorkflows } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'ext')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'ext.json')
    writeApiPrompt(src)
    upsertWorkflow({
      id: 'ext-1',
      name: 'ext',
      path: src,
      format: 'json',
      nodeCount: 1,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'external'
    })
    expect(listWorkflows().some((w) => w.id === 'ext-1')).toBe(true)
    await workflowService.remove('ext-1')
    expect(listWorkflows().some((w) => w.id === 'ext-1')).toBe(false)
    expect(existsSync(src)).toBe(true)
    unlinkSync(src)
  })

  it('rename collision throws; missing id throws', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'rnc')
    mkdirSync(dir, { recursive: true })
    const a = join(dir, 'a.json')
    writeApiPrompt(a)
    const rec = await workflowService.importFile(a)
    // Collision must be created in the SAME folder as the record (instance
    // workflows dir now that imports land there).
    writeFileSync(join(dirname(rec.path), 'brand-new.json'), '{}')
    await expect(workflowService.rename(rec.id, 'brand-new')).rejects.toThrow()
    await expect(workflowService.rename('no-such-id', 'x')).rejects.toThrow()
  })

  it('favorite and tag errors on unknown id', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    await expect(workflowService.favorite('missing', true)).rejects.toThrow()
    await expect(workflowService.tag('missing', ['a'])).rejects.toThrow()
    await expect(workflowService.remove('missing')).resolves.toBe(false)
    await expect(workflowService.exportZip('missing')).rejects.toThrow()
    await expect(workflowService.copyToInstance('missing', 'copy-inst')).rejects.toThrow()
    await expect(workflowService.reveal('missing')).rejects.toThrow()
  })

  it('importMany surfaces aggregated errors when every file fails', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    await expect(workflowService.importMany(['/definitely/missing/a.json'])).rejects.toThrow()
  })

  it('rejects unsupported extension and directories', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'badext')
    mkdirSync(dir, { recursive: true })
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'x')
    await expect(workflowService.importFile(txt)).rejects.toThrow(/Unsupported/)
    await expect(workflowService.importFile(dir)).rejects.toThrow(/Not a file|Unsupported/)
    await expect(workflowService.importFile(join(dir, 'nope.json'))).rejects.toThrow(/not found/i)
  })
})
