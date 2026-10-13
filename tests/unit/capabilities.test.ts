/**
 * Capabilities service (0.1.10) — probe parsing, gates, caching.
 * Facts-only contract: fields appear only when the server reported them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const instanceConfigs = [
  {
    id: 'inst-a',
    name: 'A',
    path: 'C:/fake/ComfyUI',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    enabled: true
  }
]

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => instanceConfigs
}))

type FetchRoute = (url: string) => Response | Promise<Response>

const routes = new Map<string, FetchRoute>()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('capabilityService (0.1.10)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    routes.clear()
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      for (const [needle, route] of routes) {
        if (url.includes(needle)) return route(url)
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function fresh() {
    vi.resetModules()
    return import('../../src/main/services/capabilities')
  }

  const fullStats = {
    system: {
      os: 'win32',
      ram_total: 1,
      ram_free: 1,
      comfyui_version: '0.39.0',
      required_frontend_version: '1.55.14',
      installed_templates_version: '0.11.78',
      required_templates_version: '0.11.78',
      comfy_package_versions: [
        { name: 'comfyui-frontend-package', installed: '1.55.14', required: '1.55.14' }
      ],
      python_version: '3.13.0',
      pytorch_version: '2.9.0',
      embedded_python: true,
      deploy_environment: 'local-git',
      argv: ['main.py', '--port', '8188']
    },
    devices: [{ name: 'cuda:0', type: 'cuda' }]
  }

  it('versionAtLeast compares dotted versions (incl. shorter/longer forms)', async () => {
    const { versionAtLeast } = await fresh()
    expect(versionAtLeast('0.39.0', '0.39.0')).toBe(true)
    expect(versionAtLeast('0.39.1', '0.39.0')).toBe(true)
    expect(versionAtLeast('0.40', '0.39.0')).toBe(true)
    expect(versionAtLeast('0.38.9', '0.39.0')).toBe(false)
    expect(versionAtLeast('1.0', '0.39.0')).toBe(true)
    expect(versionAtLeast(undefined, '0.39.0')).toBe(false)
    expect(versionAtLeast('dev', '0.39.0')).toBe(false)
    expect(versionAtLeast('v0.39.0', '0.39.0')).toBe(true)
  })

  it('remembers the online version for the running lifetime and clears on invalidate (0.1.11.1)', async () => {
    const { capabilityService } = await fresh()
    routes.set('/system_stats', () => json(fullStats))
    routes.set('/features', () => json({}))
    routes.set('/api/jobs', () => json({ jobs: [] }))
    await capabilityService.probe('inst-a')
    const base = 'http://127.0.0.1:8188'
    expect(capabilityService.knownVersionForUrl(base)).toBe('0.39.0')

    // Stopping the instance drops it (the card falls back to the install stamp).
    capabilityService.invalidate('inst-a')
    expect(capabilityService.knownVersionForUrl(base)).toBeUndefined()

    // A fresh probe after a restart re-establishes the fact.
    await capabilityService.probe('inst-a')
    expect(capabilityService.knownVersionForUrl(base)).toBe('0.39.0')
  })

  it('parses /system_stats facts exactly as reported', async () => {
    const { capabilityService } = await fresh()
    routes.set('/system_stats', () => json(fullStats))
    routes.set('/features', () => json({ flags: { supports_preview_metadata: true } }))
    routes.set('/api/jobs', () => json({ jobs: [], pagination: {} }))

    const caps = await capabilityService.probe('inst-a')
    expect(caps).not.toBeNull()
    expect(caps!.online).toBe(true)
    expect(caps!.version).toBe('0.39.0')
    expect(caps!.requiredFrontendVersion).toBe('1.55.14')
    expect(caps!.pythonVersion).toBe('3.13.0')
    expect(caps!.pytorchVersion).toBe('2.9.0')
    expect(caps!.embeddedPython).toBe(true)
    expect(caps!.deployEnvironment).toBe('local-git')
    expect(caps!.argv).toEqual(['main.py', '--port', '8188'])
    expect(caps!.packages).toHaveLength(1)
    expect(caps!.packages[0].name).toBe('comfyui-frontend-package')
    expect(caps!.features).toEqual({ supports_preview_metadata: true })
    expect(caps!.jobsApi).toBe(true)
    expect(caps!.workflowMetadata).toBe(true)
  })

  it('leaves optional fields undefined when the server omits them', async () => {
    const { capabilityService } = await fresh()
    routes.set('/system_stats', () => json({ system: { comfyui_version: '0.30.0' }, devices: [] }))
    routes.set('/features', () => json({}))
    routes.set('/api/jobs', () => new Response('go away', { status: 404 }))

    const caps = await capabilityService.probe('inst-a')
    expect(caps!.online).toBe(true)
    expect(caps!.version).toBe('0.30.0')
    expect(caps!.requiredFrontendVersion).toBeUndefined()
    expect(caps!.argv).toEqual([])
    expect(caps!.packages).toEqual([])
    expect(caps!.jobsApi).toBe(false)
    // Version known but older than the confirmed build → metadata off.
    expect(caps!.workflowMetadata).toBe(false)
  })

  it('reports offline honestly and never throws', async () => {
    const { capabilityService } = await fresh()
    // No routes → everything 404s.
    const caps = await capabilityService.probe('inst-a')
    expect(caps!.online).toBe(false)
    expect(caps!.jobsApi).toBe(false)
    expect(caps!.workflowMetadata).toBe(false)
    expect(caps!.error).toBeTruthy()
  })

  it('caches probes for 30s and invalidate() clears them', async () => {
    const { capabilityService } = await fresh()
    routes.set('/system_stats', () => json(fullStats))
    routes.set('/features', () => json({}))
    routes.set('/api/jobs', () => json({ jobs: [] }))

    const first = await capabilityService.probe('inst-a')
    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await capabilityService.probe('inst-a')
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
    expect(second).toBe(first)

    capabilityService.invalidate('inst-a')
    await capabilityService.probe('inst-a')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('cachedForUrl only returns fresh entries', async () => {
    const { capabilityService } = await fresh()
    routes.set('/system_stats', () => json(fullStats))
    routes.set('/features', () => json({}))
    routes.set('/api/jobs', () => json({ jobs: [] }))
    await capabilityService.probe('inst-a')
    expect(capabilityService.cachedForUrl('http://127.0.0.1:8188')?.version).toBe('0.39.0')
    expect(capabilityService.cachedForUrl('http://127.0.0.1:9999')).toBeUndefined()
  })

  it('cachedForUrl expires after the 30s TTL (fake clock)', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    try {
      const { capabilityService } = await fresh()
      routes.set('/system_stats', () => json(fullStats))
      routes.set('/features', () => json({}))
      routes.set('/api/jobs', () => json({ jobs: [] }))
      await capabilityService.probe('inst-a')
      expect(capabilityService.cachedForUrl('http://127.0.0.1:8188')).toBeDefined()
      vi.setSystemTime(1_000_000 + 31_000)
      expect(capabilityService.cachedForUrl('http://127.0.0.1:8188')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('probe returns null when no instance resolves', async () => {
    const { capabilityService } = await fresh()
    expect(await capabilityService.probe('missing-inst')).toBeNull()
  })
})
