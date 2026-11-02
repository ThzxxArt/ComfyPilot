import { describe, expect, it } from 'vitest'
import { resolveOutputDir } from '@shared/outputDir'

describe('resolveOutputDir (0.2.0 shared)', () => {
  it('reads structured launchProfile.outputDirectory', () => {
    expect(
      resolveOutputDir({
        path: 'D:/ComfyUI',
        launchProfile: { outputDirectory: 'D:/renders' }
      })
    ).toBe('D:/renders')
  })

  it('reads both --output-directory forms from extraArgs', () => {
    expect(
      resolveOutputDir({ path: '/x/ComfyUI', extraArgs: ['--output-directory', 'out2'] })
    ).toBe('/x/ComfyUI/out2')
    expect(
      resolveOutputDir({ path: '/x/ComfyUI', extraArgs: ['--output-directory=/mnt/out'] })
    ).toBe('/mnt/out')
  })

  it('falls back to <instance>/output', () => {
    expect(resolveOutputDir({ path: 'C:\\ComfyUI', extraArgs: [] })).toBe('C:\\ComfyUI\\output')
  })
})
