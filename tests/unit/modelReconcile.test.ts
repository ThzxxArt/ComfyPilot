/**
 * Model reconciliation (0.1.10): experiment endpoint preferred, legacy
 * fallback, legacy folder aliases, uncovered scan roots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('../../src/main/services/db', () => {
  const models: any[] = []
  const settings: any = { modelScanRoots: [] }
  const instances: any[] = [
    {
      id: 'inst-1',
      name: 'Inst',
      path: 'C:/fake/ComfyUI',
      listen: '127.0.0.1',
      port: 8188,
      enabled: true
    }
  ]
  return {
    listModels: () => models,
    loadSettings: () => settings,
    loadInstanceConfigs: () => instances,
    findModelByPath: () => null,
    deleteModel: () => true,
    upsertModel: () => undefined,
    updateModel: () => undefined,
    upsertDownloadTask: () => undefined,
    listDownloadTasks: () => [],
    stringifyJsonc: (v: unknown) => JSON.stringify(v),
    userDataDir: () => 'C:/fake/data'
  }
})

function modelRecord(fileName: string, category: string): any {
  return { id: fileName, fileName, name: fileName, category, path: `C:/m/${fileName}` }
}

describe('ModelService.reconcile (0.1.10)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const routes = new Map<string, (url: string) => Response>()

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  beforeEach(() => {
    routes.clear()
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      // Exact pathname matching — includes() would let '/models' swallow
      // '/experiment/models' and poison the source detection.
      const url = new URL(String(input))
      const route = routes.get(url.pathname)
      if (route) return route(String(input))
      return new Response('nope', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers /experiment/models and reports diffs with directory + extensions', async () => {
    const { modelService } = await import('../../src/main/services/model')
    const db = await import('../../src/main/services/db')
    // Seed the local index through the mocked mutable store.
    const local = [
      modelRecord('a.safetensors', 'checkpoints'),
      modelRecord('d.safetensors', 'diffusion_models'),
      modelRecord('e.ckpt', 'diffusion_models'),
      modelRecord('f.safetensors', 'diffusion_models'),
      modelRecord('t.safetensors', 'text_encoders')
    ]
    ;(db as any).listModels = () => local

    routes.set('/experiment/models/checkpoints', () =>
      json([{ name: 'a.safetensors' }, { name: 'b.safetensors' }])
    )
    routes.set('/experiment/models/diffusion_models', () => json([{ name: 'd.safetensors' }]))
    routes.set('/experiment/models/clip', () => json([{ name: 't.safetensors' }]))
    routes.set('/experiment/models', () =>
      json([
        {
          name: 'checkpoints',
          folders: ['D:/shared/models/checkpoints'],
          extensions: ['.safetensors', '.ckpt']
        },
        {
          name: 'diffusion_models',
          folders: [],
          extensions: ['.safetensors']
        },
        { name: 'clip', folders: [], extensions: ['.safetensors'] }
      ])
    )

    const result = await modelService.reconcile('inst-1')
    expect(result.ok).toBe(true)
    expect(result.source).toBe('experiment')
    const byFolder = new Map(result.folders.map((f: any) => [f.folder, f]))
    // Legacy alias: clip → text_encoders, no diff.
    expect(byFolder.has('text_encoders')).toBe(true)
    expect((byFolder.get('text_encoders') as any).missingLocally).toEqual([])
    // checkpoints: instance-only b.safetensors.
    expect((byFolder.get('checkpoints') as any).missingLocally).toEqual(['b.safetensors'])
    // diffusion_models: e.ckpt hidden by extensions, f.safetensors extra locally.
    expect((byFolder.get('diffusion_models') as any).formatHidden).toEqual(['e.ckpt'])
    expect((byFolder.get('diffusion_models') as any).extraLocally).toEqual(['f.safetensors'])
    // Directory not covered by scan roots.
    expect(result.uncoveredRoots).toEqual(['D:/shared/models/checkpoints'])
  })

  it('falls back to /models + /models/<folder> when experiment routes 404', async () => {
    const { modelService } = await import('../../src/main/services/model')
    const db = await import('../../src/main/services/db')
    ;(db as any).listModels = () => [modelRecord('x.safetensors', 'loras')]

    routes.set('/models/loras', () => json(['x.safetensors', 'y.safetensors']))
    routes.set('/models', () => json(['loras']))

    const result = await modelService.reconcile('inst-1')
    expect(result.source).toBe('legacy')
    const loras = result.folders.find((f: any) => f.folder === 'loras')
    expect(loras?.missingLocally).toEqual(['y.safetensors'])
    expect(loras?.instanceFolders).toEqual([])
  })

  it('reports ok:false when no listing endpoint answers', async () => {
    const { modelService } = await import('../../src/main/services/model')
    const result = await modelService.reconcile('inst-1')
    expect(result.ok).toBe(false)
    expect(result.source).toBe('none')
    expect(result.error).toBeTruthy()
  })

  it('returns ok:false with the accurate reason for an unresolvable id (0.1.13)', async () => {
    const { modelService } = await import('../../src/main/services/model')
    const result = await modelService.reconcile('missing-inst')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Instance not found: missing-inst')
  })
})

describe('category hints (0.1.11)', () => {
  it('categorize prefers the hint, then path segments, then other', async () => {
    const { categorize, categoryHintForRoot } = await import('../../src/main/services/model')
    expect(categorize('D:/models/foo/bar.safetensors', 'loras')).toBe('loras')
    expect(categorize('D:/models/checkpoints/x.safetensors')).toBe('checkpoints')
    expect(categorize('D:/models/unet/x.safetensors')).toBe('diffusion_models')
    expect(categorize('D:/random/x.safetensors')).toBe('other')
    expect(categoryHintForRoot('D:/models/loras/')).toBe('loras')
    expect(categoryHintForRoot('D:/models/loras')).toBe('loras')
    expect(categoryHintForRoot('D:/models/ckpt')).toBeUndefined()
  })

  it('parseExtraModelPathsDetailed keeps the yaml-key category hint', async () => {
    const { mkdtempSync, writeFileSync: wf } = await import('fs')
    const { tmpdir: td } = await import('os')
    const { join: j } = await import('path')
    const dir = mkdtempSync(j(td(), 'cp-yaml-'))
    const yaml = j(dir, 'extra_model_paths.yaml')
    wf(
      yaml,
      [
        'my_models:',
        '  loras: |',
        '    D:/loras',
        '  checkpoints: D:/ckpts',
        '  custom_nodes: D:/nodes',
        ''
      ].join('\n')
    )
    const { parseExtraModelPathsDetailed, parseExtraModelPaths } =
      await import('../../src/main/services/model')
    const roots = parseExtraModelPathsDetailed(yaml, true, { modelOnly: true })
    const loras = roots.find((r) => r.path.includes('D:/loras'))
    expect(loras?.categoryHint).toBe('loras')
    expect(roots.find((r) => r.path.includes('D:/ckpts'))?.categoryHint).toBe('checkpoints')
    // modelOnly skips custom_nodes entirely.
    expect(roots.some((r) => r.path.includes('D:/nodes'))).toBe(false)
    // The legacy wrapper returns plain path strings (back-compat).
    expect(parseExtraModelPaths(yaml, true, { modelOnly: true })).toContain(loras!.path)
  })
})
