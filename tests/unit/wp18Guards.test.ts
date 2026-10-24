/**
 * 0.1.18 WP1/WP5 guards: settings validation and long-operation classification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ logs: '' }))

vi.mock('../../src/main/services/db', () => ({
  logsDir: () => h.logs,
  userDataDir: () => h.logs
}))

describe('assertSafeSettingsPatch (WP1)', () => {
  it('rejects an unknown securityLevel / networkMode', async () => {
    const { assertSafeSettingsPatch } = await import('../../src/main/services/security')
    expect(() => assertSafeSettingsPatch({ securityLevel: 'off' })).toThrow(/securityLevel/)
    expect(() => assertSafeSettingsPatch({ networkMode: 'anything' })).toThrow(/networkMode/)
    expect(() => assertSafeSettingsPatch({ stopMode: 'polite' })).toThrow(/stopMode/)
    expect(() => assertSafeSettingsPatch({ securityLevel: 'strong' })).not.toThrow()
  })

  it('rejects non-boolean and out-of-range values', async () => {
    const { assertSafeSettingsPatch } = await import('../../src/main/services/security')
    expect(() => assertSafeSettingsPatch({ allowPipInstall: 'yes' })).toThrow(/boolean/)
    expect(() => assertSafeSettingsPatch({ outputScanDepth: 99 })).toThrow(/outputScanDepth/)
    expect(() => assertSafeSettingsPatch({ proxy: { port: 70000 } })).toThrow(/proxy\.port/)
  })

  it('rejects model roots that do not exist on this machine', async () => {
    const { assertSafeSettingsPatch } = await import('../../src/main/services/security')
    expect(() =>
      assertSafeSettingsPatch({ modelScanRoots: [join(tmpdir(), 'cp-definitely-missing-xyz')] })
    ).toThrow(/does not exist/)
    const dir = mkdtempSync(join(tmpdir(), 'cp-root-'))
    try {
      expect(() => assertSafeSettingsPatch({ modelScanRoots: [dir] })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('slowOps long-operation classification (WP5)', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cp-slow-'))
    mkdirSync(join(root, 'logs'), { recursive: true })
    h.logs = join(root, 'logs')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.resetModules()
  })

  it('records launch/update as LONG without freeze or toast', async () => {
    const mod = await import('../../src/main/services/slowOps')
    mod.resetSlowOpsForTest()
    const listener = vi.fn()
    mod.setSlowOpListener(listener)
    const entry = mod.recordSlowOp('instance.launch', 60_000, [])
    expect(entry?.long).toBe(true)
    expect(entry?.freeze).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('still flags a genuine synchronous freeze', async () => {
    const mod = await import('../../src/main/services/slowOps')
    mod.resetSlowOpsForTest()
    const listener = vi.fn()
    mod.setSlowOpListener(listener)
    const entry = mod.recordSlowOp('backup.restore', 7000, [])
    expect(entry?.freeze).toBe(true)
    expect(entry?.long).toBeFalsy()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('writes long operations to long-ops.log, not slow-ops.log', async () => {
    const mod = await import('../../src/main/services/slowOps')
    mod.resetSlowOpsForTest()
    mod.recordSlowOp('node.checkUpdates', 9000, [])
    const { existsSync, readFileSync } = await import('fs')
    const long = join(h.logs, 'long-ops.log')
    expect(existsSync(long)).toBe(true)
    expect(readFileSync(long, 'utf-8')).toContain('node.checkUpdates')
  })
})
