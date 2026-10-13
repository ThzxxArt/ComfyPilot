/**
 * Workflow fingerprint reverse matching (0.1.11).
 *
 * Real db files + real fs in a temp userData dir; electron is mocked so
 * `app.getPath('userData')` points there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(tmpdir(), `cp-fp-${process.pid}`)

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import {
  fingerprintOf,
  fingerprintOfWorkflowFile,
  lookupWorkflowByFingerprint,
  resetFingerprintCaches
} from '../../src/main/services/workflowFingerprint'
import { toApiPrompt } from '../../src/main/services/workflowConvert'

const uiGraph = (seed: number): Record<string, unknown> => ({
  nodes: [
    {
      id: 1,
      type: 'KSampler',
      widgets_values: [seed, 'fixed', 20, 7, 'euler', 'normal', 1]
    },
    { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['sd15.safetensors'] }
  ],
  links: [],
  version: 0.4
})

function writeWorkflowFile(name: string, graph: unknown): string {
  const dir = join(ROOT, 'wf')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(graph), 'utf-8')
  return p
}

function seedDb(records: Array<{ id: string; name: string; path: string }>): void {
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  writeFileSync(
    join(ROOT, 'data', 'workflows.jsonc'),
    JSON.stringify(
      records.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        format: 'json',
        nodeCount: 2,
        tags: [],
        updatedAt: Date.now(),
        missingNodes: [],
        version: '0.4',
        params: {},
        origin: 'library'
      }))
    ),
    'utf-8'
  )
}

describe('fingerprintOf (0.1.11)', () => {
  it('fingerprints UI graphs and their API form identically (v1: prefix)', () => {
    const g = uiGraph(42)
    const h1 = fingerprintOf(g)
    expect(h1).toMatch(/^v1:[0-9a-f]{40}$/)
    // Key order must not matter (JSON object semantics).
    const shuffled = { version: 0.4, links: [], nodes: g.nodes } as Record<string, unknown>
    expect(fingerprintOf(shuffled)).toBe(h1)
    // The API form produced by the shared converter must hash identically —
    // PNG-embedded `prompt` blocks and .json UI graphs must match each other.
    expect(fingerprintOf(toApiPrompt(g))).toBe(h1)
    expect(fingerprintOf(null)).toBeNull()
    expect(fingerprintOf({ hello: 'world' })).toBeNull()
  })

  it('fingerprintOfWorkflowFile hashes on-disk files with the same rule (0.1.11)', () => {
    const aPath = writeWorkflowFile('direct.json', uiGraph(42))
    expect(fingerprintOfWorkflowFile(aPath)).toBe(fingerprintOf(uiGraph(42)))
    expect(fingerprintOfWorkflowFile(join(ROOT, 'wf', 'nope.json'))).toBeNull()
  })
})

describe('lookupWorkflowByFingerprint (0.1.11)', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    resetFingerprintCaches()
  })

  it('matches disk workflows by content, including duplicate copies', () => {
    const aPath = writeWorkflowFile('a.json', uiGraph(42))
    const bPath = writeWorkflowFile('b.json', uiGraph(99))
    seedDb([
      { id: 'wa', name: 'Alpha', path: aPath },
      { id: 'wb', name: 'Beta', path: bPath }
    ])
    expect(lookupWorkflowByFingerprint(uiGraph(42))).toEqual([
      { workflowId: 'wa', workflowName: 'Alpha' }
    ])
    expect(lookupWorkflowByFingerprint(uiGraph(99))).toEqual([
      { workflowId: 'wb', workflowName: 'Beta' }
    ])
    // A copy of Alpha under a new record id → both ids are reported.
    const copy = writeWorkflowFile('a-copy.json', uiGraph(42))
    seedDb([
      { id: 'wa', name: 'Alpha', path: aPath },
      { id: 'wc', name: 'Alpha copy', path: copy }
    ])
    resetFingerprintCaches()
    expect(
      lookupWorkflowByFingerprint(uiGraph(42))
        .map((h) => h.workflowId)
        .sort()
    ).toEqual(['wa', 'wc'])
    // Unknown content → no hits (never a guess).
    expect(lookupWorkflowByFingerprint(uiGraph(7))).toEqual([])
  })

  it('indexes PNG-embedded graphs, skips missing rows and caches within TTL', () => {
    // PNG workflow with a tEXt `workflow` chunk (a first-class library format).
    const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
    const ihdr = Buffer.alloc(25)
    ihdr.writeUInt32BE(13, 0)
    ihdr.write('IHDR', 4, 'ascii')
    ihdr.writeUInt32BE(1, 8)
    ihdr.writeUInt32BE(1, 12)
    chunks.push(ihdr)
    {
      const text = Buffer.from(`workflow\0${JSON.stringify(uiGraph(42))}`, 'utf-8')
      const len = Buffer.alloc(4)
      len.writeUInt32BE(text.length, 0)
      chunks.push(len, Buffer.from('tEXt', 'ascii'), text, Buffer.alloc(4))
    }
    const iend = Buffer.alloc(12)
    iend.write('IEND', 4, 'ascii')
    chunks.push(iend)
    const dir = join(ROOT, 'wf')
    mkdirSync(dir, { recursive: true })
    const pngPath = join(dir, 'embedded.png')
    writeFileSync(pngPath, Buffer.concat(chunks))

    seedDb([
      { id: 'wp', name: 'PngFlow', path: pngPath },
      { id: 'wmiss', name: 'Missing', path: join(dir, 'never-written.json') }
    ])
    resetFingerprintCaches()
    expect(lookupWorkflowByFingerprint(uiGraph(42))).toEqual([
      { workflowId: 'wp', workflowName: 'PngFlow' }
    ])
    // Second lookup inside the TTL window serves the cached index.
    expect(lookupWorkflowByFingerprint(uiGraph(42))).toHaveLength(1)
  })
})
