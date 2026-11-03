import { describe, expect, it, vi, afterAll } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'cp-filter-electron') }
}))
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({})
}))

const root = mkdtempSync(join(tmpdir(), 'cp-req-filter-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('filterTorchRequirements (0.2.1)', () => {
  it('removes torch/torchvision/torchaudio but keeps everything else', async () => {
    const { filterTorchRequirements } = await import('../../src/main/services/env')
    const req = join(root, 'requirements.txt')
    writeFileSync(
      req,
      [
        'torch',
        'torchvision==0.29.2',
        'torchaudio>=2.9',
        'numpy>=1.25',
        'torchsde',
        '--extra-index-url https://example.com/simple',
        'torch; sys_platform == "win32"'
      ].join('\n')
    )
    const filtered = filterTorchRequirements(req)
    expect(filtered.removed).toHaveLength(4)
    expect(filtered.file).not.toBe(req)
    const text = readFileSync(filtered.file, 'utf-8')
    expect(text).toContain('numpy>=1.25')
    expect(text).toContain('torchsde')
    expect(text).toContain('--extra-index-url')
    expect(text.split('\n').map((l) => l.trim())).not.toContain('torch')
    expect(text).not.toContain('torchvision')
    expect(text).not.toContain('torchaudio')
    filtered.cleanup()
    expect(() => readFileSync(filtered.file, 'utf-8')).toThrow()
  })

  it('leaves a requirements file without torch packages untouched', async () => {
    const { filterTorchRequirements } = await import('../../src/main/services/env')
    const req = join(root, 'plain.txt')
    writeFileSync(req, 'numpy>=1.25\npillow\n')
    const filtered = filterTorchRequirements(req)
    expect(filtered.file).toBe(req)
    expect(filtered.removed).toEqual([])
    filtered.cleanup()
  })

  it.skipIf(process.platform === 'win32')(
    'fails loudly instead of installing the original file when it cannot write the filtered copy',
    async () => {
      const { filterTorchRequirements } = await import('../../src/main/services/env')
      const dir = join(root, 'read-only')
      mkdirSync(dir, { recursive: true })
      const req = join(dir, 'requirements.txt')
      writeFileSync(req, 'torch\nnumpy>=1.25\n')
      chmodSync(dir, 0o555)
      try {
        expect(() => filterTorchRequirements(req)).toThrow(
          /Cannot prepare a torch-free requirements file/
        )
      } finally {
        chmodSync(dir, 0o755)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
