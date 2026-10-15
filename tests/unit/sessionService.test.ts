import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => h.dir,
    getVersion: () => '0.1.16'
  }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-session-'))
h.dir = root

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('session service (0.1.16)', () => {
  it('marks a first run as a clean prior exit', async () => {
    const s = await import('../../src/main/services/session')
    const prev = s.markSessionStart(1000)
    expect(prev.clean).toBe(true)
    expect(prev.startedAt).toBeNull()
  })

  it('detects an unclean previous exit', async () => {
    const s = await import('../../src/main/services/session')
    s.markSessionStart(2000) // writes cleanExit:false
    const prev = s.markSessionStart(3000)
    expect(prev.clean).toBe(false)
    expect(prev.startedAt).toBe(2000)
    expect(s.getPreviousExitInfo()).toEqual(prev)
  })

  it('a clean exit is recognised on the next start', async () => {
    const s = await import('../../src/main/services/session')
    s.markSessionStart(4000)
    s.markSessionCleanExit(5000)
    const prev = s.markSessionStart(6000)
    expect(prev.clean).toBe(true)
    expect(prev.endedAt).toBe(5000)
  })

  it('recordCrashDetail persists a reason onto the session', async () => {
    const s = await import('../../src/main/services/session')
    s.markSessionStart(7000)
    s.recordCrashDetail('boom')
    const prev = s.markSessionStart(8000)
    expect(prev.clean).toBe(false)
    expect(prev.detail).toBe('boom')
  })

  it('exportAppDiagnostics writes a folder with runtime.json', async () => {
    const s = await import('../../src/main/services/session')
    s.markSessionStart(9000)
    const out = s.exportAppDiagnostics(10000)
    expect(existsSync(join(out, 'runtime.json'))).toBe(true)
    const rt = JSON.parse(readFileSync(join(out, 'runtime.json'), 'utf-8')) as {
      appVersion: string
    }
    expect(rt.appVersion).toBe('0.1.16')
  })
})
