/**
 * Mirror recommendation + launch script export contracts.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: () => path.join(os.tmpdir(), 'cp-net-probe-test'),
      getAppPath: () => path.join(os.tmpdir(), 'cp-net-probe-test'),
      isPackaged: false
    },
    session: {
      defaultSession: {
        fetch: async () => {
          throw new Error('offline in unit test')
        },
        setProxy: async () => undefined
      }
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: true, filePath: undefined })
    }
  }
})
vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

// Instant failure so probes don't wait on real network timeouts.
vi.stubGlobal('fetch', async () => {
  throw new Error('offline in unit test')
})

describe('netProbe mirror candidates', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('returns a structured recommendation even when all probes fail', async () => {
    const { recommendMirrors } = await import('../../src/main/services/netProbe')
    const rec = await recommendMirrors()
    expect(rec).toBeTruthy()
    expect(typeof rec.pipIndex).toBe('string')
    expect(typeof rec.torchIndexMirror).toBe('string')
    expect(typeof rec.githubEndpoint).toBe('string')
    expect(Array.isArray(rec.probes)).toBe(true)
    expect(rec.probes.length).toBeGreaterThanOrEqual(9)
  })
})

describe('launch script export', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('preview command quoting is reused (same quoteCommandLineArg)', async () => {
    const { quoteCommandLineArg } = await import('../../src/main/services/instance')
    const line = ['C:\\py\\python.exe', 'main.py', '--listen', '127.0.0.1']
      .map(quoteCommandLineArg)
      .join(' ')
    expect(line).toBe('C:\\py\\python.exe main.py --listen 127.0.0.1')
  })
})
