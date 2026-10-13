/**
 * Workflow compare (0.1.11) — metadata deltas + node-set differences over
 * seeded db records.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(tmpdir(), `cp-cmp-${process.pid}`)

vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { workflowService } from '../../src/main/services/workflow'

function seed(records: unknown[]): void {
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  writeFileSync(join(ROOT, 'data', 'workflows.jsonc'), JSON.stringify(records), 'utf-8')
}

describe('workflowService.compare (0.1.11)', () => {
  it('reports field deltas and one-sided node types', () => {
    seed([
      {
        id: 'a',
        name: 'Alpha',
        path: '/x/a.json',
        format: 'json',
        nodeCount: 4,
        tags: ['t1'],
        updatedAt: 1000,
        missingNodes: [],
        version: '0.4',
        params: { nodeTypes: ['KSampler', 'CLIPTextEncode'] },
        origin: 'library'
      },
      {
        id: 'b',
        name: 'Beta',
        path: '/x/b.json',
        format: 'png',
        nodeCount: 6,
        tags: [],
        updatedAt: 2000,
        missingNodes: ['X'],
        version: '0.4',
        params: { classTypes: ['KSampler', 'VAEDecode'] },
        origin: 'instance'
      }
    ])
    const r = workflowService.compare('a', 'b')
    expect(r.a).toEqual({ id: 'a', name: 'Alpha' })
    expect(r.b).toEqual({ id: 'b', name: 'Beta' })
    const byField = Object.fromEntries(r.diffs.map((d) => [d.field, d]))
    expect(byField.name.changed).toBe(true)
    expect(byField.nodeCount.changed).toBe(true)
    expect(byField.nodeCount.a).toBe('4')
    expect(byField.nodeCount.b).toBe('6')
    // Same version on both sides → not a change.
    expect(byField.version.changed).toBe(false)
    // nodeTypes + classTypes are merged before diffing.
    expect(r.nodesOnlyA).toEqual(['CLIPTextEncode'])
    expect(r.nodesOnlyB).toEqual(['VAEDecode'])
    expect(r.missingNodes).toEqual(['X'])
    expect(() => workflowService.compare('a', 'zzz')).toThrow(/not found/)
  })
})
