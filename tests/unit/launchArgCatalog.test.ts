import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/services/target', () => ({
  resolveReadTarget: () => ({ id: 'i1', path: 'C:/fake/ComfyUI' })
}))

describe('launchArgCatalog (0.2.0)', () => {
  it('falls back to the static ComfyUI flags when cli_args.py is absent', async () => {
    const { launchArgCatalog } = await import('../../src/main/services/launchArgCatalog')
    const flags = launchArgCatalog('i1')
    expect(flags).toContain('--listen')
    expect(flags).toContain('--output-directory')
    expect(flags).toContain('--enable-agent')
    expect(flags).toEqual([...flags].sort())
  })
})
