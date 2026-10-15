/**
 * Default-workflow import (0.1.15): client route parsing + service import with
 * the v0.41+ probe semantics (v0.40 → coded unsupported error), shape
 * validation, collision chain and the defaultWorkflow record marker.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-wf-default-${process.pid}`)

vi.mock('electron', async () => ({
  app: { getPath: () => ROOT },
  shell: {
    showItemInFolder: () => undefined,
    openExternal: async () => undefined,
    openPath: async () => ''
  }
}))

/** Canonical UI-format graph like the real /default_workflow payload. */
function defaultGraph(): Record<string, unknown> {
  return {
    last_node_id: 3,
    nodes: [
      { id: 1, type: 'KSampler', widgets_values: [42, 'fixed', 20, 7.5] },
      { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['sd15.safetensors'] }
    ],
    links: []
  }
}

describe('default workflow import (0.1.15)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const calls: string[] = []

  beforeEach(async () => {
    calls.length = 0
    fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      if (String(url).includes('/default_workflow')) {
        return new Response(JSON.stringify(defaultGraph()), { status: 200 })
      }
      return new Response('nf', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    await seedTestInstance({ id: 'wf-default-inst', path: join(ROOT, 'comfy-default') })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('ComfyApiClient.defaultWorkflow returns the object, null on 404/malformed', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    const graph = await client.defaultWorkflow()
    expect(graph).not.toBeNull()
    expect(Array.isArray(graph!.nodes)).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nf', { status: 404 }))
    )
    expect(await client.defaultWorkflow()).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[1,2,3]', { status: 200 }))
    )
    expect(await client.defaultWorkflow()).toBeNull() // array ≠ graph object

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 }))
    )
    expect(await client.defaultWorkflow()).toBeNull()
  })

  it('imports a valid graph into the instance workflows dir with the marker', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const rec = await workflowService.importDefaultFromInstance('wf-default-inst')
    expect(rec.name).toBe('default-workflow')
    expect(rec.path.endsWith('default-workflow.json')).toBe(true)
    expect(rec.path).toContain(join('user', 'default', 'workflows'))
    expect(rec.origin).toBe('instance')
    expect(rec.params.defaultWorkflow).toBe(true)
    expect(existsSync(rec.path)).toBe(true)
    // The persisted file is the real graph.
    const onDisk = JSON.parse(readFileSync(rec.path, 'utf-8')) as { nodes: unknown[] }
    expect(onDisk.nodes).toHaveLength(2)
    expect(calls.some((u) => u.endsWith('/default_workflow'))).toBe(true)
  })

  it('collides with the stable -N chain on re-import', async () => {
    // Start from a clean target dir — earlier tests may have landed files here.
    rmSync(join(ROOT, 'comfy-default', 'user', 'default', 'workflows'), {
      recursive: true,
      force: true
    })
    const { workflowService } = await import('../../src/main/services/workflow')
    const first = await workflowService.importDefaultFromInstance('wf-default-inst')
    expect(first.path.endsWith('default-workflow.json')).toBe(true)
    const second = await workflowService.importDefaultFromInstance('wf-default-inst')
    expect(second.path).not.toBe(first.path)
    expect(second.path.endsWith('default-workflow-1.json')).toBe(true)
  })

  it('supports the library target (lands under userData, not the instance)', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const rec = await workflowService.importDefaultFromInstance('wf-default-inst', 'library')
    expect(rec.origin).toBe('library')
    expect(rec.path).toContain(join('data', 'workflows'))
    expect(rec.path).not.toContain('comfy-default')
    expect(existsSync(rec.path)).toBe(true)
  })

  it('fails with the coded unsupported error when the route is absent (v0.40-)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nf', { status: 404 }))
    )
    const { workflowService } = await import('../../src/main/services/workflow')
    await expect(
      workflowService.importDefaultFromInstance('wf-default-inst')
    ).rejects.toMatchObject({ code: 'DEFAULT_WORKFLOW_UNSUPPORTED' })
  })

  it('rejects a payload that is not a ComfyUI workflow graph', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }))
    )
    const { workflowService } = await import('../../src/main/services/workflow')
    await expect(workflowService.importDefaultFromInstance('wf-default-inst')).rejects.toThrow(
      /Not a ComfyUI workflow/
    )
  })

  it('rejects an unknown instance id (no silent fallback)', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    await expect(workflowService.importDefaultFromInstance('nope')).rejects.toThrow(
      'Instance not found'
    )
  })
})
