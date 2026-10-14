/**
 * PreflightService (0.1.12 WP6) — workflow/batch preflight against
 * /object_info with honest unavailable/parse-error states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  nodeTypeMap: null as null | { types: Set<string>; moduleByType: Map<string, string> }
}))

vi.mock('../../src/main/services/capabilities', () => ({
  capabilityService: {
    nodeTypeMap: vi.fn(async () => h.nodeTypeMap)
  }
}))

vi.mock('../../src/main/services/workflow', () => ({
  workflowService: {
    buildApiPrompt: vi.fn(async (p: string) => {
      if (p.includes('bad')) throw new Error('Cannot parse workflow prompt')
      return {
        '1': { class_type: 'CheckpointLoaderSimple' },
        '48': { class_type: 'PathchSageAttentionKJ' }
      }
    })
  }
}))

describe('PreflightService (0.1.12)', () => {
  beforeEach(() => {
    vi.resetModules()
    h.nodeTypeMap = {
      types: new Set(['CheckpointLoaderSimple', 'KSampler']),
      moduleByType: new Map()
    }
  })

  async function fresh(): Promise<any> {
    return (await import('../../src/main/services/preflight')).preflightService
  }

  it('workflow(): reports missing node types when object_info is reachable', async () => {
    const svc = await fresh()
    const r = await svc.workflow('C:/wf/ok.json', 'i1')
    expect(r.available).toBe(true)
    expect(r.missingTypes).toEqual(['PathchSageAttentionKJ'])
    expect(r.nodeTypes).toBe(2)
  })

  it('workflow(): available:false when object_info cannot be fetched', async () => {
    h.nodeTypeMap = null
    const svc = await fresh()
    const r = await svc.workflow('C:/wf/ok.json', 'i1')
    expect(r.available).toBe(false)
    expect(r.missingTypes).toEqual([])
    expect(String(r.error)).toContain('object_info unavailable')
  })

  it('workflow(): a parse failure keeps available:true and surfaces the error', async () => {
    const svc = await fresh()
    const r = await svc.workflow('C:/wf/bad.json', 'i1')
    expect(r.available).toBe(true)
    expect(r.missingTypes).toEqual([])
    expect(String(r.error)).toContain('Cannot parse')
  })

  it('batch(): aggregates per-workflow misses and tolerates per-file errors', async () => {
    const svc = await fresh()
    const r = await svc.batch(['C:/wf/ok.json', 'C:/wf/bad.json'], 'i1')
    expect(r.available).toBe(true)
    expect(r.missingTypes).toEqual(['PathchSageAttentionKJ'])
    expect(r.perWorkflow).toHaveLength(2)
    expect(r.perWorkflow[0].missingTypes).toEqual(['PathchSageAttentionKJ'])
    expect(r.perWorkflow[1].error).toBeTruthy()
  })

  it('batch(): unavailable object_info yields per-file unavailable entries', async () => {
    h.nodeTypeMap = null
    const svc = await fresh()
    const r = await svc.batch(['C:/wf/ok.json'], 'i1')
    expect(r.available).toBe(false)
    expect(r.perWorkflow).toHaveLength(1)
    expect(r.perWorkflow[0].error).toBe('object_info unavailable')
  })
})
