/**
 * Workflow library root-cause tests:
 *  - import COPIES into the library and the record is visible in list()
 *  - list() merges DB rows and marks missing files
 *  - PNG import extracts a real .json sibling
 *  - delete only removes library-owned files
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-workflow-lib-test-${process.pid}`)

vi.mock('electron', async () => {
  return {
    app: { getPath: () => ROOT },
    shell: { showItemInFolder: () => undefined, openExternal: async () => undefined, openPath: async () => '' }
  }
})

function writeUiWorkflow(path: string, name = 'demo'): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        name,
        version: '1.0',
        nodes: [
          { id: 1, type: 'KSampler', title: 'sampler', widgets_values: [42, 'fixed', 20, 7.5] },
          { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['sd15.safetensors'] },
          { id: 3, type: 'MissingSomething', widgets_values: [] }
        ],
        links: []
      },
      null,
      2
    ),
    'utf-8'
  )
}

/** Minimal valid PNG with a tEXt workflow chunk. */
function writePngWithWorkflow(path: string, workflow: unknown): void {
  const text = Buffer.from(`workflow\0${JSON.stringify(workflow)}`, 'utf-8')
  // chunk: length(4) + type(4) + data + crc(4)
  const type = Buffer.from('tEXt', 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(text.length, 0)
  // CRC over type+data — PNG decoders that verify CRC would reject a wrong one,
  // but our extractor only walks chunks, so a zero CRC is fine for tests.
  const crc = Buffer.alloc(4)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(1, 8) // width
  ihdr.writeUInt32BE(1, 12) // height
  const iend = Buffer.alloc(12)
  iend.writeUInt32BE(0, 0)
  iend.write('IEND', 4, 'ascii')
  writeFileSync(path, Buffer.concat([sig, ihdr, len, type, text, crc, iend]))
}

describe('workflow library', () => {
  const instPath = join(ROOT, 'inst')
  beforeAll(async () => {
    vi.resetModules()
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: instPath })
  })

  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: instPath })
  })

  it('import lands exactly one json in the instance workflows folder', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { listWorkflows } = await import('../../src/main/services/db')

    const srcDir = join(ROOT, 'downloads')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'my-flow.json')
    writeUiWorkflow(src)

    const rec = await workflowService.importFile(src)
    expect(rec.origin).toBe('instance')
    expect(rec.sourcePath).toBe(src)
    expect(existsSync(rec.path)).toBe(true)
    // File lives in the instance workflows folder, not the download folder.
    const wfDir = join(instPath, 'user', 'default', 'workflows')
    expect(rec.path.startsWith(wfDir)).toBe(true)
    expect(rec.path).not.toBe(src)
    expect(rec.path.endsWith('.json')).toBe(true)

    // THE BUG FIX: list() must include the imported record.
    const listed = workflowService.list()
    expect(listed.some((w) => w.id === rec.id || w.path === rec.path)).toBe(true)

    // And it is persisted in the DB.
    expect(listWorkflows().some((w) => w.path === rec.path)).toBe(true)
  })

  it('import parses nodeCount / missingNodes / seed / model', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const srcDir = join(ROOT, 'downloads2')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'meta-flow.json')
    writeUiWorkflow(src, 'meta-flow')

    const rec = await workflowService.importFile(src)
    expect(rec.nodeCount).toBe(3)
    expect(rec.missingNodes).toContain('MissingSomething')
    expect(rec.seed).toBe(42)
    expect(rec.modelUsed).toBe('sd15.safetensors')
  })

  it('PNG import yields exactly ONE json artifact in the instance folder', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')

    const srcDir = join(ROOT, 'imgs')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'gen.png')
    writePngWithWorkflow(src, {
      nodes: [{ id: 1, type: 'KSampler', widgets_values: [7, 'fixed', 10, 7] }]
    })

    const rec = await workflowService.importFile(src)
    // ONE artifact: a real .json in the instance workflows folder. The PNG is NOT copied.
    expect(rec.format).toBe('json')
    expect(rec.path.endsWith('.json')).toBe(true)
    expect(existsSync(rec.path)).toBe(true)
    const wfDir = join(instPath, 'user', 'default', 'workflows')
    expect(rec.path.startsWith(wfDir)).toBe(true)
    const parsed = JSON.parse(readFileSync(rec.path, 'utf-8')) as { nodes?: unknown[] }
    expect(Array.isArray(parsed.nodes)).toBe(true)

    // The list must show exactly one entry for this import.
    const listed = workflowService.list()
    const hits = listed.filter((w) => w.name.includes('gen'))
    expect(hits.length).toBe(1)
  })

  it('preserves tags across list() rescans', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const srcDir = join(ROOT, 'tagsrc')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'tagged.json')
    writeUiWorkflow(src)

    const rec = await workflowService.importFile(src)
    await workflowService.tag(rec.id, ['portrait', 'sdxl'])

    const again = workflowService.list()
    const found = again.find((w) => w.id === rec.id)
    expect(found?.tags).toEqual(expect.arrayContaining(['portrait', 'sdxl']))
  })

  it('marks missing files instead of dropping them', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const { loadSettings, saveSettings } = await import('../../src/main/services/db')
    const { unlinkSync } = await import('fs')

    const srcDir = join(ROOT, 'gone')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'ephemeral.json')
    writeUiWorkflow(src)

    // Import then remove the library copy to simulate a vanished file.
    const rec = await workflowService.importFile(src)
    unlinkSync(rec.path)

    const listed = workflowService.list({ includeMissing: true })
    const found = listed.find((w) => w.id === rec.id)
    expect(found?.missing).toBe(true)
    void loadSettings
    void saveSettings
  })

  it('delete removes library-owned files but never external sources', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const srcDir = join(ROOT, 'del')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'keep-me.json')
    writeUiWorkflow(src)

    const rec = await workflowService.importFile(src)
    expect(existsSync(rec.path)).toBe(true)
    await workflowService.remove(rec.id)
    expect(existsSync(rec.path)).toBe(false)
    // Original source untouched.
    expect(existsSync(src)).toBe(true)
  })

  it('rename moves the library file and updates the record', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const srcDir = join(ROOT, 'rn')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'oldname.json')
    writeUiWorkflow(src)

    const rec = await workflowService.importFile(src)
    const renamed = await workflowService.rename(rec.id, 'brand-new')
    expect(renamed.name).toBe('brand-new')
    expect(existsSync(renamed.path)).toBe(true)
    expect(renamed.path.endsWith('brand-new.json')).toBe(true)

    const listed = workflowService.list()
    expect(listed.some((w) => w.id === renamed.id)).toBe(true)
  })

  it('libraryInfo reports root and counts', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const info = workflowService.libraryInfo()
    expect(info.root).toBeTruthy()
    expect(info.count).toBeGreaterThan(0)
  })

  it('importMany reports per-file success and collects failures', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const srcDir = join(ROOT, 'many')
    mkdirSync(srcDir, { recursive: true })
    const a = join(srcDir, 'a.json')
    writeUiWorkflow(a, 'a')
    const b = join(srcDir, 'b.json')
    writeFileSync(b, 'not-json{{{', 'utf-8')
    const c = join(srcDir, 'c.json')
    writeFileSync(c, '{"hello":"world"}', 'utf-8') // valid JSON, NOT a workflow

    // b is not JSON; c is JSON but not a ComfyUI workflow — both must fail.
    const out = await workflowService.importMany([a, b, c])
    expect(out.length).toBe(1)
    expect(out[0].name).toBe('a')
  })
})

describe('zipWrite', () => {
  it('creates a readable zip with sanitized names', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    const out = join(ROOT, 'test.zip')
    writeZip(out, [
      { name: '../evil.json', content: '{"ok":true}' },
      { name: 'README.txt', content: 'hello' }
    ])
    expect(existsSync(out)).toBe(true)
    const buf = readFileSync(out)
    // Local file header signature
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    // Traversal basename is stripped
    expect(buf.includes(Buffer.from('evil.json'))).toBe(true)
    expect(!buf.includes(Buffer.from('../evil'))).toBe(true)
  })

  it('refuses empty archives', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    expect(() => writeZip(join(ROOT, 'empty.zip'), [])).toThrow()
    void readdirSync
  })
})
