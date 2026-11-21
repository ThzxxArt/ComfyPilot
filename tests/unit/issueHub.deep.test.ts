/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  configs: [] as any[],
  issues: [] as any[],
  startup: { issues: [] as any[] },
  packs: [] as any[],
  report: null as any,
  recovery: [] as any[],
  failures: [] as any[],
  audit: { ok: true, packs: [] as any[] } as any,
  doctor: { checks: [] as any[] } as any,
  pipResult: { ok: true } as any,
  installRecipe: vi.fn(async () => h.pipResult),
  installSpec: vi.fn(async () => h.pipResult),
  cleanRecovery: vi.fn(),
  fail: { list: false, report: false, recovery: false, audit: false, exec: false, doctor: false }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.configs,
  listIssues: () => h.issues,
  replaceIssues: (next: any[]) => {
    h.issues = next
  }
}))

vi.mock('../../src/main/services/instance', () => ({
  instanceService: {
    analyzeStartupIssues: () => h.startup
  }
}))

vi.mock('../../src/main/services/nodePack', () => ({
  nodePackService: {
    list: () => {
      if (h.fail.list) throw new Error('list fail')
      return h.packs
    },
    loadReport: () => {
      if (h.fail.report) throw new Error('report fail')
      return h.report
    },
    scanRecovery: () => {
      if (h.fail.recovery) throw new Error('recovery fail')
      return h.recovery
    },
    depsAudit: async () => {
      if (h.fail.audit) throw new Error('audit fail')
      return h.audit
    },
    cleanRecovery: (name: string, id?: string) => h.cleanRecovery(name, id)
  }
}))

vi.mock('../../src/main/services/execDiagnostics', () => ({
  execDiagnosticsService: {
    list: () => {
      if (h.fail.exec) throw new Error('exec fail')
      return h.failures
    }
  }
}))

vi.mock('../../src/main/services/doctor', () => ({
  doctorService: {
    run: async () => {
      if (h.fail.doctor) throw new Error('doctor fail')
      return h.doctor
    }
  }
}))

vi.mock('../../src/main/services/pipOps', () => ({
  pipOpsService: {
    installRecipe: (...a: any[]) => (h.installRecipe as any)(...a),
    installSpec: (...a: any[]) => (h.installSpec as any)(...a)
  }
}))

vi.mock('@shared/pipAliases', () => ({ resolvePipAlias: (n: string) => `spec:${n}` }))
vi.mock('@shared/pipRecipes', () => ({
  recipeForModule: (n: string) => (n === 'triton' ? { id: 'recipe-triton' } : undefined),
  recipeSupportsPlatform: () => true
}))

import { IssueHubService } from '../../src/main/services/issueHub'

function issue(id: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    fingerprint: id,
    kind: 'startup',
    instanceId: 'i1',
    pack: 'Pack',
    severity: 'error',
    title: id,
    detail: 'detail',
    actions: [],
    status: 'open',
    firstSeen: 1,
    lastSeen: 1,
    updatedAt: 1,
    ...extra
  }
}

beforeEach(() => {
  h.configs = [{ id: 'i1' }, { id: 'i2' }]
  h.issues = []
  h.startup = { issues: [] }
  h.packs = []
  h.report = null
  h.recovery = []
  h.failures = []
  h.audit = { ok: true, packs: [] }
  h.doctor = { checks: [] }
  h.pipResult = { ok: true }
  h.installRecipe.mockClear()
  h.installSpec.mockClear()
  h.cleanRecovery.mockClear()
  h.fail = { list: false, report: false, recovery: false, audit: false, exec: false, doctor: false }
})

describe('issueHub service', () => {
  it('filters and sorts issues', () => {
    h.issues = [
      issue('a', { severity: 'warning', lastSeen: 2 }),
      issue('b', { severity: 'error', lastSeen: 1 }),
      issue('c', { severity: 'info', lastSeen: 3 }),
      issue('d', { status: 'resolved', severity: 'error' }),
      issue('e', { status: 'ignored', severity: 'error' })
    ]
    const svc = new IssueHubService()
    expect(svc.list().map((i) => i.id)).toEqual(['b', 'a', 'c'])
    expect(svc.list(true).length).toBe(5)
    h.issues = [
      issue('x', { severity: 'error', lastSeen: 1 }),
      issue('y', { severity: 'error', lastSeen: 2 })
    ]
    expect(svc.list().map((i) => i.id)).toEqual(['y', 'x'])
  })

  it('scans every advisory source and builds actions', async () => {
    h.packs = [
      { name: 'Pack', path: '/tmp/pack' },
      { name: 'Gone', path: '/tmp/gone' }
    ]
    h.startup = {
      issues: [
        { pack: 'Pack', missingModules: ['mod'], summary: 'startup' },
        { pack: 'Unknown', missingModules: [], summary: 'no modules' },
        { pack: 'Gone', missingModules: ['x'], summary: 'deleted' },
        { pack: '', missingModules: [], summary: 'empty' },
        { pack: '.trash-old', missingModules: [], summary: 'transient' },
        { pack: 'Pack', summary: 'no modules array' }
      ]
    }
    h.report = {
      entries: [
        { ok: true, folder: 'Pack' },
        { ok: false, folder: 'Pack', modulePath: 'm.py', prestartup: false, error: 'err' },
        { ok: false, folder: 'Unknown', prestartup: true },
        { ok: false, folder: 'Gone' }
      ],
      policyRefused: [
        { folder: 'Pack', reason: 'policy' },
        { folder: 'Gone', reason: 'gone' }
      ]
    }
    h.packs.push({ name: 'NoPath' })
    const now = Date.now()
    h.recovery = [
      { kind: 'trash', name: 'old', mtimeMs: now - 8 * 24 * 60 * 60 * 1000, path: '/tmp/old' },
      { kind: 'trash', name: 'new', mtimeMs: now, path: '/tmp/new' },
      { kind: 'backup', name: 'bak', mtimeMs: 0, path: '/tmp/bak' }
    ]
    h.failures = [
      { packFolder: 'Pack', missingModule: 'mod', errorType: 'E', message: 'm', nodeType: 'T' },
      { packFolder: '', missingModule: '', errorType: 'E2', message: 'm2', nodeType: 'T2' },
      { packFolder: 'Gone', missingModule: 'g', errorType: 'E3', message: 'm3' },
      { packFolder: 'Pack', missingModule: 'mod', errorType: 'E4', message: 'm4' },
      { packFolder: '', missingModule: '', message: 'm5' }
    ]
    h.audit = {
      ok: true,
      packs: [
        {
          name: 'Pack',
          missing: ['a'],
          mismatched: [{ name: 'b', required: '1', installed: '2' }]
        },
        { name: 'Gone', missing: ['c'], mismatched: [] },
        { name: 'Deleted', missing: [], mismatched: [] }
      ]
    }
    h.doctor = {
      checks: [
        { severity: 'fail', id: 'fail', detail: 'd', title: 'F', suggestion: 'fix' },
        { severity: 'warn', id: 'warn', detail: 'd2', title: 'W' },
        { severity: 'pass', id: 'pass', detail: 'd3', title: 'P' }
      ]
    }
    h.issues = [
      issue('old-startup', { kind: 'startup', fingerprint: 'old-startup', status: 'ignored' }),
      issue('old-deps', { kind: 'deps', fingerprint: 'old-deps' }),
      issue('old-doctor', { kind: 'doctor', fingerprint: 'old-doctor' }),
      issue('other', { kind: 'startup', fingerprint: 'other', instanceId: 'i2' }),
      issue('unknown-kind', { kind: 'custom' as any, fingerprint: 'unknown-kind' })
    ]
    const svc = new IssueHubService()
    const list = await svc.scan('i1')
    expect(list.length).toBeGreaterThan(0)
    const firstIssues = h.issues.slice()
    const generated = h.issues.filter((i) => i.instanceId === 'i1')
    h.issues = h.issues.map((i) => (i.instanceId === 'i1' ? { ...i, status: 'resolved' } : i))
    const second = await svc.scan('i1')
    expect(second.length).toBeGreaterThan(0)
    h.issues = h.issues.map((i) => (i.instanceId === 'i1' ? { ...i, status: 'ignored' } : i))
    await svc.scan('i1')
    expect(generated.length).toBeGreaterThan(0)
    expect(firstIssues.some((i) => i.title.includes('Missing'))).toBe(true)
    expect(list.some((i) => i.title.includes('Quarantined'))).toBe(true)
    expect(firstIssues.some((i) => i.id === 'old-startup' && i.status === 'ignored')).toBe(true)
    expect(firstIssues.some((i) => i.id === 'old-deps' && i.status === 'resolved')).toBe(true)
    expect(firstIssues.some((i) => i.id === 'old-doctor' && i.status === 'resolved')).toBe(true)
    expect(firstIssues.some((i) => i.id === 'other')).toBe(true)
    expect(firstIssues.some((i) => i.id === 'unknown-kind')).toBe(true)

    const transient = firstIssues.find((i) => String(i.pack).includes('.trash-'))
    expect(transient?.actions.some((a: any) => a.id === 'clean-leftover')).toBe(true)
    const withModule = firstIssues.find((i) => i.kind === 'startup' && i.title.includes('Missing'))
    expect(withModule?.actions.some((a: any) => a.id === 'install-module')).toBe(true)
  })

  it('keeps previous issues when advisory sources fail', async () => {
    h.configs = [{ id: 'i1' }]
    h.issues = [issue('old-deps', { kind: 'deps' }), issue('old-doctor', { kind: 'doctor' })]
    h.fail = { list: true, report: true, recovery: true, audit: true, exec: true, doctor: true }
    const svc = new IssueHubService()
    const list = await svc.scan()
    h.fail = {
      list: false,
      report: false,
      recovery: false,
      audit: false,
      exec: false,
      doctor: false
    }
    h.configs = [{ id: 'i1' }]
    h.report = {}
    h.audit = { ok: true }
    h.doctor = {}
    await svc.scan()
    expect(list.some((i) => i.id === 'old-deps')).toBe(true)
    expect(list.some((i) => i.id === 'old-doctor')).toBe(true)
  })

  it('rejects unknown instances', async () => {
    const svc = new IssueHubService()
    await expect(svc.scan('missing')).rejects.toThrow(/not found/)
  })

  it('installs modules through recipes and specs', async () => {
    h.issues = [
      issue('no-instance', { instanceId: '' }),
      issue('no-module', { module: '' }),
      issue('triton', { module: 'triton.foo' }),
      issue('generic', { module: 'numpy.x' })
    ]
    const svc = new IssueHubService()
    await expect(svc.installModule('missing')).rejects.toThrow(/not found/)
    await expect(svc.installModule('no-instance')).rejects.toThrow(/no local instance/)
    await expect(svc.installModule('no-module')).rejects.toThrow(/no missing module/)
    h.pipResult = { ok: true }
    expect(await svc.installModule('triton')).toMatchObject({ ok: true })
    expect(h.installRecipe).toHaveBeenCalled()
    expect(await svc.installModule('generic')).toMatchObject({ ok: true })
    expect(h.installSpec).toHaveBeenCalled()
    expect(h.issues.find((i) => i.id === 'generic')?.status).toBe('resolved')
    h.pipResult = { ok: false, error: 'failed' }
    expect(await svc.installModule('generic')).toMatchObject({ ok: false, message: 'failed' })
    h.pipResult = { ok: false }
    expect((await svc.installModule('generic')).message).toContain('Could not install')
  })

  it('cleans quarantined leftovers by name, substring or detail path', () => {
    h.recovery = [
      { name: 'a', path: '/tmp/a' },
      { name: 'b', path: '/tmp/b' },
      { name: 'c', path: '/tmp/c' }
    ]
    h.issues = [
      issue('no-instance', { instanceId: '' }),
      issue('by-name', { pack: 'a', detail: '' }),
      issue('by-sub', { pack: 'xxbxx', detail: '' }),
      issue('by-detail', { pack: 'zzz', detail: 'at /tmp/c' }),
      issue('no-pack', { pack: undefined, detail: 'at /tmp/c' }),
      issue('none', { pack: 'nope', detail: '' })
    ]
    const svc = new IssueHubService()
    expect(() => svc.cleanLeftover('absent')).toThrow(/not found/)
    expect(() => svc.cleanLeftover('no-instance')).toThrow(/no local instance/)
    expect(svc.cleanLeftover('by-name').ok).toBe(true)
    expect(svc.cleanLeftover('by-sub').ok).toBe(true)
    expect(svc.cleanLeftover('by-detail').ok).toBe(true)
    expect(h.cleanRecovery).toHaveBeenCalledTimes(3)
    expect(() => svc.cleanLeftover('none')).toThrow(/no longer exists/)
  })

  it('dismisses, restores and resolves issues', () => {
    h.issues = [issue('a')]
    const svc = new IssueHubService()
    expect(svc.dismiss('a')?.status).toBe('ignored')
    expect(svc.restore('a')?.status).toBe('open')
    expect(svc.resolve('a')?.status).toBe('resolved')
    expect(svc.dismiss('missing')).toBeNull()
  })
})
