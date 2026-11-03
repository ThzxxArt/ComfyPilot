import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  issues: [] as Array<Record<string, unknown>>,
  packs: [] as Array<Record<string, unknown>>,
  startup: [] as Array<Record<string, unknown>>,
  recovery: [] as Array<Record<string, unknown>>,
  installed: [] as string[],
  recipes: [] as string[],
  cleaned: [] as string[]
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [{ id: 'i1', name: 'One', path: h.root, enabled: true }],
  listIssues: () => h.issues,
  replaceIssues: (items: Array<Record<string, unknown>>) => {
    h.issues = items
  }
}))
vi.mock('../../src/main/services/instance', () => ({
  instanceService: {
    analyzeStartupIssues: () => ({
      instanceId: 'i1',
      bootId: 'b1',
      hasIssues: h.startup.length > 0,
      issues: h.startup,
      scannedAt: Date.now()
    })
  }
}))
vi.mock('../../src/main/services/nodePack', () => ({
  nodePackService: {
    list: () => h.packs,
    loadReport: () => null,
    scanRecovery: () => h.recovery,
    cleanRecovery: (name: string) => {
      h.cleaned.push(name)
      return true
    },
    depsAudit: async () => ({
      ok: true,
      pipAvailable: true,
      checkedPacks: 0,
      packs: []
    })
  }
}))
vi.mock('../../src/main/services/execDiagnostics', () => ({
  execDiagnosticsService: { list: () => [] }
}))
vi.mock('../../src/main/services/doctor', () => ({
  doctorService: {
    run: async () => ({ checks: [] })
  }
}))
vi.mock('../../src/main/services/pipOps', () => ({
  pipOpsService: {
    installSpec: async (_id: string, spec: string) => {
      h.installed.push(spec)
      return { ok: true, instanceId: 'i1', requested: [spec], installed: [spec] }
    },
    installRecipe: async (_id: string, recipeId: string) => {
      h.recipes.push(recipeId)
      return { ok: true, instanceId: 'i1', requested: [recipeId], installed: [recipeId] }
    }
  }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-issuehub-'))
h.root = root
const packDir = join(root, 'custom_nodes', 'Pack')
mkdirSync(packDir, { recursive: true })
writeFileSync(join(packDir, '__init__.py'), 'x')

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  h.issues = []
  h.packs = [{ id: 'p1', name: 'Pack', displayName: 'Pack', path: packDir }]
  h.startup = [
    { pack: 'Pack', summary: 'Missing dependency: requests', missingModules: ['requests'] }
  ]
  h.recovery = []
  h.installed = []
  h.recipes = []
  h.cleaned = []
})

describe('IssueHubService (0.2.0)', () => {
  it('aggregates startup issues with an executable action set', async () => {
    const { issueHubService } = await import('../../src/main/services/issueHub')
    const list = await issueHubService.scan('i1')
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('startup')
    expect(list[0].module).toBe('requests')
    expect(list[0].actions.map((a) => a.id)).toContain('install-module')
    expect(list[0].actions.map((a) => a.id)).toContain('run-audit')
    expect(list[0].fingerprint).toContain('Pack')
  })

  it('does not resurrect an issue for a pack that no longer exists', async () => {
    h.packs = []
    const { issueHubService } = await import('../../src/main/services/issueHub')
    expect(await issueHubService.scan('i1')).toEqual([])
  })

  it('uses a curated recipe when the missing module has one', async () => {
    h.startup = [
      { pack: 'Pack', summary: 'Missing dependency: triton', missingModules: ['triton'] }
    ]
    const { issueHubService } = await import('../../src/main/services/issueHub')
    const [issue] = await issueHubService.scan('i1')
    const result = await issueHubService.installModule(issue.id)
    expect(result.ok).toBe(true)
    // `pip install triton` has no Windows wheel; the recipe installs
    // triton-windows (and any follow-up wheel) instead.
    expect(h.recipes).toEqual(['triton'])
    expect(h.installed).toEqual([])
  })

  it('persists ignore/restore/resolve lifecycle', async () => {
    const { issueHubService } = await import('../../src/main/services/issueHub')
    const [issue] = await issueHubService.scan('i1')
    expect(issueHubService.dismiss(issue.id)?.status).toBe('ignored')
    expect(issueHubService.list()).toEqual([])
    expect(issueHubService.list(true)).toHaveLength(1)
    expect(issueHubService.restore(issue.id)?.status).toBe('open')
    expect(issueHubService.list()).toHaveLength(1)
    expect(issueHubService.resolve(issue.id)?.status).toBe('resolved')
    expect(issueHubService.list()).toEqual([])
  })

  it('installs the missing module and resolves the issue', async () => {
    const { issueHubService } = await import('../../src/main/services/issueHub')
    const [issue] = await issueHubService.scan('i1')
    const result = await issueHubService.installModule(issue.id)
    expect(result.ok).toBe(true)
    expect(h.installed).toEqual(['requests'])
    expect(issueHubService.list(true)[0].status).toBe('resolved')
  })

  it('cleans a quarantined leftover referenced by an issue', async () => {
    h.packs = []
    h.startup = []
    h.recovery = [
      {
        kind: 'trash',
        name: '.disabled/Pack.trash-1',
        packName: '',
        path: join(root, 'custom_nodes', '.disabled', 'Pack.trash-1'),
        livePath: '',
        liveExists: false,
        mtimeMs: Date.now() - 8 * 24 * 60 * 60 * 1000,
        sizeBytes: 10
      }
    ]
    const { issueHubService } = await import('../../src/main/services/issueHub')
    const [issue] = await issueHubService.scan('i1')
    expect(issue.pack).toBe('.disabled/Pack.trash-1')
    expect(issue.actions.map((a) => a.id)).toContain('clean-leftover')
    expect(issueHubService.cleanLeftover(issue.id).ok).toBe(true)
    expect(h.cleaned).toEqual(['.disabled/Pack.trash-1'])
  })
})
