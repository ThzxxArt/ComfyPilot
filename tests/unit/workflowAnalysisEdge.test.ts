/**
 * Analysis, scan and service edge branches for workflow.ts: seed/model
 * extraction from UI/API graphs and PNG chunks, missing/external rows,
 * collision handling and prompt-link sidecar capping.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-wf-edge-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => ROOT },
  shell: {
    showItemInFolder: () => undefined,
    openExternal: async () => undefined,
    openPath: async () => ''
  }
}))

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

function writePng(path: string, chunks: Array<[string, Buffer | string]>): void {
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  parts.push(pngChunk('IHDR', ihdr))
  for (const [type, data] of chunks) {
    parts.push(pngChunk(type, typeof data === 'string' ? Buffer.from(data, 'utf-8') : data))
  }
  parts.push(pngChunk('IEND', Buffer.alloc(0)))
  writeFileSync(path, Buffer.concat(parts))
}

function text(key: string, value: string): Buffer {
  return Buffer.from(`${key}\0${value}`, 'utf-8')
}

function itxt(key: string, value: string, transKey = ''): Buffer {
  return Buffer.concat([
    Buffer.from(`${key}\0\0\0en\0${transKey}\0`, 'binary'),
    Buffer.from(value, 'utf-8')
  ])
}

let seq = 0
async function importGraph(graph: unknown, name?: string): Promise<any> {
  const { workflowService } = await import('../../src/main/services/workflow')
  const dir = mkdtempSync(join(tmpdir(), 'cp-wf-graph-'))
  const file = join(dir, `${name || `g${seq++}`}.json`)
  writeFileSync(file, JSON.stringify(graph))
  return workflowService.importFile(file, undefined, 'library')
}

describe('workflow analysis edge branches', () => {
  beforeEach(async () => {
    mkdirSync(ROOT, { recursive: true })
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('extracts sampler, advanced and widget-name seeds', async () => {
    expect((await importGraph({ nodes: [{ type: 'KSampler', inputs: { seed: 42 } }] })).seed).toBe(
      42
    )
    expect(
      (
        await importGraph({
          nodes: [{ class_type: 'KSamplerCustom', inputs: { noise_seed: 43 } }]
        })
      ).seed
    ).toBe(43)
    expect(
      (await importGraph({ nodes: [{ type: 'KSampler', widgets_values: [55, 'fixed'] }] })).seed
    ).toBe(55)
    expect(
      (await importGraph({ nodes: [{ type: 'KSamplerAdvanced', widgets_values: ['enable', 66] }] }))
        .seed
    ).toBe(66)
    expect(
      (
        await importGraph({
          nodes: [
            {
              type: 'SamplerEuler',
              widgets_values: ['x', 77],
              widgets: [{ name: 'foo' }, { name: 'SEED' }]
            }
          ]
        })
      ).seed
    ).toBe(77)
    // Explicit sampler seed wins over the generic first-integer heuristic.
    expect(
      (
        await importGraph({
          nodes: [
            { type: 'Other', widgets_values: [88] },
            { type: 'KSampler', inputs: { seed: 99 } }
          ]
        })
      ).seed
    ).toBe(99)
    // Non-array widgets / non-matching widget names fall through.
    expect(
      (
        await importGraph({
          nodes: [{ type: 'Other', widgets_values: 'nope', widgets: [{ name: 'seed' }] }]
        })
      ).seed
    ).toBeUndefined()
  })

  it('extracts model usage from titles and loader widgets', async () => {
    expect(
      (
        await importGraph({
          nodes: [
            { type: 'Other', title: 'My model loader' },
            { type: 'CheckpointLoaderSimple', widgets_values: ['ckpt.safetensors'] }
          ]
        })
      ).modelUsed
    ).toBe('My model loader')
    expect(
      (
        await importGraph({
          nodes: [{ type: 'CheckpointLoaderSimple', widgets_values: ['ckpt.safetensors'] }]
        })
      ).modelUsed
    ).toBe('ckpt.safetensors')
    expect(
      (await importGraph({ nodes: [{ type: 'UNETLoader', widgets_values: ['unet.gguf'] }] }))
        .modelUsed
    ).toBe('unet.gguf')
  })

  it('analyses API prompts, wrappers and invalid shapes', async () => {
    const api = await importGraph({
      '1': { class_type: 'KSampler', inputs: { seed: 7 } },
      '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
      '3': { class_type: 'VAEDecode', inputs: {} }
    })
    expect(api.seed).toBe(7)
    expect(api.modelUsed).toBe('m.safetensors')
    expect(api.nodeCount).toBe(3)

    const wrapped = await importGraph({
      prompt: { nodes: [{ type: 'KSampler', inputs: { seed: 8 } }] }
    })
    expect(wrapped.seed).toBe(8)
    const workflowWrapped = await importGraph({ workflow: { nodes: [{ type: 'Other' }] } })
    expect(workflowWrapped.nodeCount).toBe(1)

    await expect(importGraph({ foo: 'bar' })).rejects.toThrow(/Not a ComfyUI workflow/)
  })

  it('extracts seeds/models from PNG text metadata with fallbacks', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = mkdtempSync(join(tmpdir(), 'cp-wf-png-'))
    const lib = workflowService.libraryRoot()
    mkdirSync(lib, { recursive: true })
    const png = join(lib, `meta-${Date.now()}.png`)
    writePng(png, [
      ['tEXt', text('workflow', JSON.stringify({ nodes: [{ type: 'Other' }] }))],
      ['tEXt', text('seed', '1234')],
      ['tEXt', text('model', 'meta-model.safetensors')]
    ])
    const rec = workflowService.list().find((w) => w.path === png)!
    expect(rec.seed).toBe(1234)
    expect(rec.modelUsed).toBe('meta-model.safetensors')

    const itxtPng = join(lib, `itxt-${Date.now()}.png`)
    writePng(itxtPng, [
      [
        'iTXt',
        itxt('workflow', JSON.stringify({ nodes: [{ type: 'KSampler', inputs: { seed: 5 } }] }))
      ],
      ['tEXt', text('seed', 'not-a-number')]
    ])
    expect(workflowService.list().find((w) => w.path === itxtPng)!.seed).toBe(5)

    const heuristicPng = join(lib, `heuristic-${Date.now()}.png`)
    writePng(heuristicPng, [
      [
        'tEXt',
        text('workflow', JSON.stringify({ nodes: [{ type: 'Other', widgets_values: [88] }] }))
      ]
    ])
    expect(workflowService.list().find((w) => w.path === heuristicPng)!.seed).toBe(88)

    const promptOnly = join(lib, `prompt-${Date.now()}.png`)
    writePng(promptOnly, [
      ['tEXt', text('workflow', '{broken json')],
      [
        'tEXt',
        text('prompt', JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 6 } } }))
      ]
    ])
    expect(workflowService.list().find((w) => w.path === promptOnly)!.seed).toBe(6)

    const imported = await workflowService.importFile(itxtPng, undefined, 'library')
    expect(imported.params.extractedFrom).toBe(itxtPng)
    const noMeta = join(dir, 'none.png')
    writePng(noMeta, [])
    await expect(workflowService.importFile(noMeta, undefined, 'library')).rejects.toThrow(
      /no embedded workflow/
    )
  })

  it('parses PNG chunks defensively', async () => {
    const { extractPngTextMeta, readPngTextMetaFromFile, workflowService } =
      await import('../../src/main/services/workflow')
    expect(extractPngTextMeta(Buffer.from([]))).toEqual({})
    expect(extractPngTextMeta(Buffer.from('not a png'))).toEqual({})
    const proper = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('iTXt', itxt('workflow', 'abc')),
      pngChunk('tEXt', text('seed', '9')),
      pngChunk('IEND', Buffer.alloc(0))
    ])
    expect(extractPngTextMeta(proper)).toMatchObject({ workflow: 'abc', seed: '9' })
    // Malformed iTXt (no language/translated terminators) is ignored.
    const malformed = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('iTXt', Buffer.from('key\0\0\0', 'binary')),
      pngChunk('tEXt', Buffer.from('\0value', 'binary'))
    ])
    expect(extractPngTextMeta(malformed)).toEqual({})
    expect(readPngTextMetaFromFile(join(ROOT, 'missing.png'))).toEqual({})

    const dir = mkdtempSync(join(tmpdir(), 'cp-wf-png2-'))
    const empty = join(dir, 'empty.png')
    writeFileSync(empty, '')
    expect(readPngTextMetaFromFile(empty)).toEqual({})
    const txt = join(dir, 'note.txt')
    writeFileSync(txt, 'x')
    expect(await workflowService.parsePngMeta(join(ROOT, 'none.png'))).toBeNull()
    expect(await workflowService.parsePngMeta(txt)).toBeNull()
    expect(await workflowService.parsePngMeta(empty)).toBeNull()
    const valid = join(dir, 'valid.png')
    writePng(valid, [['tEXt', text('seed', '3')]])
    expect(await workflowService.parsePngMeta(valid)).toMatchObject({ seed: '3' })
  })
})

describe('workflow scan and service edge branches', () => {
  beforeEach(async () => {
    mkdirSync(ROOT, { recursive: true })
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('skips deep trees, unsupported extensions and keeps external rows', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow, deleteWorkflow, flushPendingWrites } =
      await import('../../src/main/services/db')
    const library = workflowService.libraryRoot()
    const deep = join(library, 'deep', 'a', 'b', 'c', 'd', 'e', 'f')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'too-deep.json'), JSON.stringify({ nodes: [] }))
    mkdirSync(join(library, 'skip'), { recursive: true })
    writeFileSync(join(library, 'skip', 'note.txt'), 'x')
    writeFileSync(join(library, 'skip', 'ok.json'), JSON.stringify({ nodes: [] }))
    const list = workflowService.list()
    expect(list.some((w) => w.path.includes('too-deep.json'))).toBe(false)
    expect(list.some((w) => w.path.includes('note.txt'))).toBe(false)

    const externalDir = mkdtempSync(join(tmpdir(), 'cp-wf-ext-'))
    const external = join(externalDir, 'outside.json')
    writeFileSync(external, JSON.stringify({ nodes: [{ type: 'KSampler', inputs: { seed: 1 } }] }))
    const base = {
      format: 'json' as const,
      nodeCount: 1,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'external' as const,
      missing: false
    }
    upsertWorkflow({ ...base, id: 'external-edge', name: 'outside', path: external })
    upsertWorkflow({
      ...base,
      id: 'missing-edge',
      name: 'gone',
      path: join(externalDir, 'gone.json')
    })
    const dirRow = join(externalDir, 'a-directory.json')
    mkdirSync(dirRow)
    upsertWorkflow({ ...base, id: 'dir-edge', name: 'dir', path: dirRow })
    flushPendingWrites()

    const withMissing = workflowService.list({ includeMissing: true })
    expect(withMissing.some((w) => w.path === external && !w.missing)).toBe(true)
    expect(withMissing.some((w) => w.id === 'missing-edge' && w.missing)).toBe(true)
    expect(withMissing.some((w) => w.id === 'dir-edge' && w.missing)).toBe(true)
    const withoutMissing = workflowService.list({ includeMissing: false })
    expect(withoutMissing.some((w) => w.id === 'missing-edge')).toBe(false)
    expect(withoutMissing.some((w) => w.path === external)).toBe(true)

    deleteWorkflow('external-edge')
    deleteWorkflow('missing-edge')
    deleteWorkflow('dir-edge')
  })

  it('rejects unsupported imports and reports missing targets', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = mkdtempSync(join(tmpdir(), 'cp-wf-bad-'))
    const txt = join(dir, 'note.txt')
    writeFileSync(txt, 'x')
    await expect(workflowService.importFile(txt)).rejects.toThrow(/Unsupported workflow type/)
    await expect(workflowService.importFile(join(dir, 'none.json'))).rejects.toThrow(/not found/)
    await expect(workflowService.importFile(dir)).rejects.toThrow(/Not a file/)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{oops')
    await expect(workflowService.importFile(bad)).rejects.toThrow(/not valid JSON/)

    expect(() => workflowService.instanceWorkflowsDir('nope')).toThrow(/Instance not found/)
    await expect(workflowService.tag('nope', ['x'])).rejects.toThrow(/Workflow not found/)
    await expect(workflowService.favorite('nope', true)).rejects.toThrow(/Workflow not found/)
    await expect(workflowService.rename('nope', 'x')).rejects.toThrow(/Workflow not found/)
    await expect(workflowService.reveal('nope')).rejects.toThrow(/Workflow not found/)
    await expect(workflowService.exportZip('nope')).rejects.toThrow(/Workflow not found/)
    expect(() => workflowService.compare('nope', 'nope')).toThrow(/Workflow not found/)
    const valid = await importGraph({ nodes: [{ type: 'KSampler' }] }, 'prep-valid')
    await expect(workflowService.prepareFrontend(valid.id, 'nope')).rejects.toThrow(
      /Instance not found/
    )
    await expect(workflowService.prepareFrontend('nope')).rejects.toThrow(/Workflow not found/)
    await expect(workflowService.copyToInstance('nope', 'test-inst')).rejects.toThrow(
      /Workflow not found/
    )
    expect(await workflowService.remove('nope')).toBe(false)
    const info = workflowService.libraryInfo('nope')
    expect(info.instanceName).toBe('')
    expect(info.root).toBeTruthy()
  })

  it('renames, tags and removes records with collision and source guards', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow } = await import('../../src/main/services/db')
    const a = await importGraph({ nodes: [] }, 'rename-a')
    expect((await workflowService.tag(a.id, ['  one ', 'one', '', 'two'])).tags).toEqual([
      'one',
      'two'
    ])
    expect((await workflowService.favorite(a.id, true)).favorite).toBe(true)
    expect((await workflowService.rename(a.id, 'rename-a')).path).toBe(a.path)

    const b = await importGraph({ nodes: [] }, 'rename-b')
    await expect(workflowService.rename(a.id, 'rename-b')).rejects.toThrow(/already exists/)
    const renamed = await workflowService.rename(a.id, 'rename-c')
    expect(renamed.path).toContain('rename-c.json')
    expect(existsSync(renamed.path)).toBe(true)

    await expect(workflowService.remove(b.id, { deleteSource: false })).resolves.toBe(true)
    expect(existsSync(b.path)).toBe(true)

    const externalDir = mkdtempSync(join(tmpdir(), 'cp-wf-remove-'))
    const external = join(externalDir, 'outside.json')
    writeFileSync(external, JSON.stringify({ nodes: [] }))
    upsertWorkflow({
      id: 'remove-external',
      name: 'outside',
      path: external,
      format: 'json',
      nodeCount: 0,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'external',
      missing: false
    })
    expect(await workflowService.remove('remove-external', { deleteSource: true })).toBe(true)
    expect(existsSync(external)).toBe(true)
  })

  it('exports PNG payloads and falls back when metadata is unusable', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { upsertWorkflow } = await import('../../src/main/services/db')
    const dir = mkdtempSync(join(tmpdir(), 'cp-wf-export-'))
    const png = join(dir, 'shot.png')
    writePng(png, [['tEXt', text('workflow', JSON.stringify({ nodes: [{ type: 'KSampler' }] }))]])
    const rec = await workflowService.importFile(png, undefined, 'library')
    const out = await workflowService.exportZip(rec.id, join(dir, 'out'))
    expect(existsSync(out.path)).toBe(true)

    const bare = join(dir, 'bare.png')
    writePng(bare, [])
    upsertWorkflow({
      id: 'png-bare',
      name: 'bare',
      path: bare,
      format: 'png',
      nodeCount: 0,
      tags: [],
      updatedAt: Date.now(),
      missingNodes: [],
      version: '1.0',
      params: {},
      origin: 'library',
      missing: false
    })
    const bareOut = await workflowService.exportZip('png-bare', join(dir, 'out2'))
    expect(existsSync(bareOut.path)).toBe(true)

    rmSync(rec.path, { force: true })
    await expect(workflowService.exportZip(rec.id, dir)).rejects.toThrow(/missing on disk/)
  })

  it('copies to instances with stable hashed collisions and compare diffs', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const a = await importGraph({ nodes: [{ type: 'KSampler', inputs: { seed: 1 } }] }, 'copy-a')
    const b = await importGraph({ nodes: [{ type: 'VAEDecode' }, { type: 'SaveImage' }] }, 'copy-b')
    const first = await workflowService.copyToInstance(a.id, 'test-inst')
    expect(existsSync(first.path)).toBe(true)

    // Different content at the preferred name → stable hash suffix.
    const workflowsDir = workflowService.instanceWorkflowsDir('test-inst')
    writeFileSync(join(workflowsDir, 'copy-a.json'), '{"nodes":[]}')
    const hashed = await workflowService.copyToInstance(a.id, 'test-inst')
    expect(hashed.path).toContain('.json')
    expect(hashed.path).not.toBe(first.path)
    const again = await workflowService.copyToInstance(a.id, 'test-inst')
    expect(again.path).toBe(hashed.path)
    writeFileSync(hashed.path, 'drifted')
    expect((await workflowService.copyToInstance(a.id, 'test-inst')).path).toBe(hashed.path)

    const cmp = workflowService.compare(a.id, b.id)
    expect(cmp.diffs.some((d) => d.field === 'nodeCount' && d.changed)).toBe(true)
    expect(cmp.nodesOnlyA).toContain('KSampler')
    expect(cmp.nodesOnlyB).toContain('VAEDecode')
    const same = workflowService.compare(a.id, a.id)
    expect(same.nodesOnlyA).toEqual([])
    expect(same.missingNodes).toEqual([])
  })

  it('builds API prompts from PNG/JSON and rejects unparseable files', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = mkdtempSync(join(tmpdir(), 'cp-wf-build-'))
    const validJson = join(dir, 'api.json')
    writeFileSync(validJson, JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } }))
    expect(await workflowService.buildApiPrompt(validJson)).toBeTruthy()

    const png = join(dir, 'prompt.png')
    writePng(png, [
      ['tEXt', text('prompt', JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } }))]
    ])
    expect(await workflowService.buildApiPrompt(png)).toBeTruthy()

    const fallback = join(dir, 'fallback.png')
    writePng(fallback, [
      ['tEXt', text('prompt', '{bad')],
      ['tEXt', text('workflow', JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } }))]
    ])
    expect(await workflowService.buildApiPrompt(fallback)).toBeTruthy()

    const broken = join(dir, 'broken.png')
    writePng(broken, [['tEXt', text('prompt', '{bad')]])
    await expect(workflowService.buildApiPrompt(broken)).rejects.toThrow(/Cannot parse/)
    const badJson = join(dir, 'bad.json')
    writeFileSync(badJson, '{oops')
    await expect(workflowService.buildApiPrompt(badJson)).rejects.toThrow(/Cannot parse/)

    await expect(
      workflowService.queue({ workflowPath: broken, instanceId: 'test-inst' })
    ).rejects.toThrow(/Cannot parse/)
    await expect(
      workflowService.queue({ workflowPath: validJson, instanceId: 'missing-inst' })
    ).rejects.toThrow(/Instance not found/)
  })

  it('caps and flushes the prompt-link sidecar', async () => {
    const { recordPromptWorkflowLink, lookupPromptWorkflowLink, flushPromptLinks } =
      await import('../../src/main/services/workflow')
    recordPromptWorkflowLink('', 'wf', 'name')
    expect(lookupPromptWorkflowLink('')).toBeUndefined()
    recordPromptWorkflowLink('p1', 'wf-1', 'Workflow 1')
    flushPromptLinks()
    expect(lookupPromptWorkflowLink('p1')).toEqual({
      workflowId: 'wf-1',
      workflowName: 'Workflow 1'
    })
    for (let i = 0; i < 2005; i++) recordPromptWorkflowLink(`p-${i}`, 'wf', 'w')
    flushPromptLinks()
    expect(lookupPromptWorkflowLink('p-0')).toBeUndefined()
    expect(lookupPromptWorkflowLink('p-2004')).toBeTruthy()
    // A corrupt sidecar is ignored rather than breaking the queue path.
    writeFileSync(join(ROOT, 'prompt_links.jsonc'), '{oops')
    recordPromptWorkflowLink('p-after-corrupt', 'wf-x', 'X')
    flushPromptLinks()
    expect(lookupPromptWorkflowLink('p-after-corrupt')).toBeTruthy()
  })
})
