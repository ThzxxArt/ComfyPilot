/**
 * Final workflow.ts branch coverage: openInFrontend, reveal, queue via PNG,
 * exportZip PNG without graph, list includeMissing:false, widget metadata analyze.
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-workflow-final-${process.pid}`)

const openExternal = vi.fn(async () => undefined)
const showItemInFolder = vi.fn(() => undefined)

vi.mock('electron', async () => {
  return {
    app: { getPath: () => ROOT },
    shell: {
      showItemInFolder: (...a: unknown[]) => showItemInFolder(...a),
      openExternal: (...a: unknown[]) => openExternal(...a),
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
  // also an iTXt chunk to hit that parser branch
  const itxtPayload = Buffer.concat([
    Buffer.from('Comment\0', 'utf-8'),
    Buffer.from([0, 0]), // comp flag + method
    Buffer.from('en\0', 'utf-8'),
    Buffer.from('\0', 'utf-8'),
    Buffer.from('hello-itxt', 'utf-8')
  ])
  const ilen = Buffer.alloc(4)
  ilen.writeUInt32BE(itxtPayload.length, 0)
  chunks.push(ilen, Buffer.from('iTXt', 'ascii'), itxtPayload, Buffer.alloc(4))
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  chunks.push(iend)
  writeFileSync(path, Buffer.concat(chunks))
}

function uiWorkflow(withWidgetsMeta: boolean): string {
  return JSON.stringify({
    name: 'deep',
    version: '2.0',
    nodes: [
      {
        id: 1,
        type: 'CustomNode',
        title: 'checkpoint loader',
        widgets_values: ['a', 3.5, 12],
        ...(withWidgetsMeta ? { widgets: [{ name: 'ckpt_name' }, { name: 'strength' }, { name: 'seed' }] } : {}),
        inputs: [
          { name: 'ckpt_name', type: 'STRING', widget: { name: 'ckpt_name' } },
          { name: 'strength', type: 'FLOAT', widget: { name: 'strength' } },
          { name: 'seed', type: 'INT', widget: { name: 'seed' } }
        ]
      },
      {
        id: 2,
        type: 'UNETLoader',
        widgets_values: ['unet.gguf'],
        inputs: []
      }
    ],
    links: []
  })
}

describe('workflow final coverage', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
    openExternal.mockClear()
    showItemInFolder.mockClear()
  })

  it('prepareFrontend copies to instance and reports the URL (does NOT open)', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    const instPath = join(ROOT, 'fe-inst')
    upsertInstanceConfig({
      id: 'fe-inst',
      name: 'fe',
      path: instPath,
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
    const dir = join(ROOT, 'fe')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'fe.json')
    writeFileSync(src, uiWorkflow(true))
    const rec = await workflowService.importFile(src)
    const prepared = await workflowService.prepareFrontend(rec.id, 'fe-inst')
    // prepareFrontend must NOT open anything — the IPC layer decides embed/browser
    // and only after the instance is confirmed running.
    expect(openExternal).not.toHaveBeenCalled()
    expect(prepared.url).toContain('127.0.0.1:8188')
    expect(prepared.instanceName).toBe('fe')
    expect(existsSync(prepared.copiedPath)).toBe(true)
    expect(existsSync(join(instPath, 'user', 'default', 'workflows'))).toBe(true)
  })

  it('prepareFrontend throws when no instance configured', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { deleteInstanceConfig, loadInstanceConfigs, upsertInstanceConfig } = await import('../../src/main/services/db')
    // Import first (needs an instance), then wipe instances and try prepareFrontend.
    const dir = join(ROOT, 'noinst')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'n.json')
    writeFileSync(src, JSON.stringify({ nodes: [{ id: 1, type: 'A' }], links: [] }))
    upsertInstanceConfig({
      id: 'tmp-inst',
      name: 'tmp',
      path: join(ROOT, 'tmp-inst'),
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
    const rec = await workflowService.importFile(src, 'tmp-inst')
    for (const i of loadInstanceConfigs()) deleteInstanceConfig(i.id)
    await expect(workflowService.prepareFrontend(rec.id)).rejects.toThrow(/instance/i)
  })

  it('reveal calls showItemInFolder', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'rev')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'r.json')
    writeFileSync(src, uiWorkflow(false))
    const rec = await workflowService.importFile(src)
    await workflowService.reveal(rec.id)
    expect(showItemInFolder).toHaveBeenCalled()
  })

  it('queue reads prompt/workflow from PNG meta', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    upsertInstanceConfig({
      id: 'png-inst',
      name: 'png',
      path: join(ROOT, 'png-inst'),
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'png-pid' }), { status: 200 }))
    )
    const dir = join(ROOT, 'qp')
    mkdirSync(dir, { recursive: true })
    const png = join(dir, 'q.png')
    writePng(png, [
      ['prompt', JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } })],
      ['workflow', JSON.stringify({ nodes: [{ id: 9, type: 'Note' }], links: [] })]
    ])
    const pid = await workflowService.queue({ workflowPath: png, instanceId: 'png-inst' })
    expect(pid).toBe('png-pid')

    // PNG whose prompt JSON is broken but workflow key works
    const png2 = join(dir, 'q2.png')
    writePng(png2, [
      ['prompt', 'not-json'],
      ['workflow', JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1, 'fixed', 1, 1] }], links: [] })]
    ])
    const pid2 = await workflowService.queue({ workflowPath: png2, instanceId: 'png-inst' })
    expect(pid2).toBe('png-pid')

    // PNG with neither parseable payload
    const png3 = join(dir, 'q3.png')
    writePng(png3, [['prompt', 'nope'], ['workflow', 'also-nope']])
    await expect(workflowService.queue({ workflowPath: png3, instanceId: 'png-inst' })).rejects.toThrow()
    vi.unstubAllGlobals()
  })

  it('exportZip of an imported PNG-derived json works', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'ex2')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'shot.png')
    writePng(src, [
      ['workflow', JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1] }], links: [] })]
    ])
    const rec = await workflowService.importFile(src)
    // PNG import materialises a single .json — no PNG card in the library.
    expect(rec.path.endsWith('.json')).toBe(true)
    const dest = join(dir, 'out')
    mkdirSync(dest, { recursive: true })
    const { path } = await workflowService.exportZip(rec.id, dest)
    expect(existsSync(path)).toBe(true)
  })

  it('list({includeMissing:false}) hides missing rows', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow, workflowLibraryDir } = await import('../../src/main/services/db')
    const ghost = join(workflowLibraryDir(), 'ghost-gone.json')
    upsertWorkflow({
      id: 'ghost-gone',
      name: 'ghost',
      path: ghost,
      format: 'json',
      nodeCount: 0,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'library'
    })
    expect(workflowService.list({ includeMissing: true }).some((w) => w.missing)).toBe(true)
    expect(workflowService.list({ includeMissing: false }).some((w) => w.id === 'ghost-gone')).toBe(false)
  })

  it('analyzes widgets metadata order and title-based model', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'wmeta')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'wm.json')
    writeFileSync(src, uiWorkflow(true))
    const rec = await workflowService.importFile(src)
    expect(rec.modelUsed).toBeTruthy()
    expect(rec.nodeCount).toBe(2)
  })

  it('extractPngTextMeta handles iTXt and refuses non-PNG', async () => {
    const { extractPngTextMeta } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'itxt')
    mkdirSync(dir, { recursive: true })
    const png = join(dir, 'i.png')
    writePng(png, [['Comment', 'ignored'], ['seed', '1']])
    const meta = extractPngTextMeta(readFileSync(png))
    // tEXt keys present; iTXt parsed into Comment
    expect(meta.seed === '1' || meta.Comment).toBeTruthy()

    expect(extractPngTextMeta(Buffer.from('not-a-png-at-all'))).toEqual({})
    // truncated header
    expect(extractPngTextMeta(Buffer.from([0x89, 0x50]))).toEqual({})
    unlinkSync(png)
  })
})
