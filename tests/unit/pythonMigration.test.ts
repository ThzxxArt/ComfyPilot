import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  venvPath: '',
  created: false,
  failVenv: false,
  upserts: [] as Array<Record<string, unknown>>,
  torchInstalled: 0,
  version: 'Python 3.12.10',
  newVersion: 'Python 3.13.18',
  failBootstrap: false,
  components: [] as any[],
  basePython: '/fake/python3.13/python' as string | null,
  probe: { cudaVersion: '12.6', torchVersion: '2.7.0' } as any,
  probeThrows: false,
  torchJson: '{"v": "2.9.0+cu126"}',
  gpus: [] as any[],
  gpuThrows: false,
  missingNewPython: false,
  requirements: true,
  installThrows: false
}))

function venvPython(venv: string): string {
  return process.platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python')
}

vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: Error | null, out: unknown, err: unknown) => void
  ) => {
    // The real execFile has a custom promisify symbol returning {stdout,stderr}.
    // The mock supplies the same resolved shape directly.
    const done = (out = ''): void => queueMicrotask(() => cb(null, { stdout: out, stderr: '' }, ''))
    if (args[0] === '--version') {
      done(h.created ? h.newVersion : h.version)
      return { pid: 1, exitCode: null, kill: () => undefined }
    }
    if (args[0] === '-m' && args[1] === 'venv') {
      if (h.failVenv) {
        queueMicrotask(() => cb(new Error('venv creation failed'), '', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      const dir = args[2]
      mkdirSync(join(dir, process.platform === 'win32' ? 'Scripts' : 'bin'), {
        recursive: true
      })
      if (!h.missingNewPython) writeFileSync(venvPython(dir), '')
      h.created = true
      done()
      return { pid: 1, exitCode: null, kill: () => undefined }
    }
    if (args[0] === '-c' && String(args[1]).includes('torch.__version__')) {
      done(h.torchJson)
      return { pid: 1, exitCode: null, kill: () => undefined }
    }
    done()
    return { pid: 1, exitCode: null, kill: () => undefined }
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [
    {
      id: 'i1',
      name: 'One',
      path: join(h.root, 'ComfyUI'),
      venvPath: h.venvPath,
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false,
      pythonPath: ''
    }
  ],
  upsertInstanceConfig: (c: Record<string, unknown>) => h.upserts.push(c)
}))
vi.mock('../../src/main/services/bootstrap', () => ({
  findInRuntimes: () => h.basePython,
  bootstrapService: {
    ensure: async () => {
      if (h.failBootstrap) throw new Error('bootstrap failed')
      return { components: h.components }
    }
  }
}))
vi.mock('../../src/main/services/env', () => ({
  envService: {
    probe: async () => {
      if (h.probeThrows) throw new Error('probe failed')
      return h.probe
    },
    installTorch: async () => {
      h.torchInstalled += 1
    }
  },
  installRequirements: async () => {
    if (h.installThrows) throw new Error('requirements failed')
  }
}))
vi.mock('../../src/main/services/installer', () => ({
  officialTorchIndex: () => 'https://download.pytorch.org/whl/cu126/',
  resolveTorchIndex: () => 'https://download.pytorch.org/whl/cu126/',
  installerService: {
    detectGpu: async () => {
      if (h.gpuThrows) throw new Error('gpu failed')
      return h.gpus
    }
  }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-pymig-'))
h.root = root
h.venvPath = join(root, '.venv')
const venv = h.venvPath
mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
writeFileSync(venvPython(venv), '')
mkdirSync(join(root, 'ComfyUI'), { recursive: true })

afterAll(() => rmSync(root, { recursive: true, force: true }))

function cleanArchives(): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    if (name.startsWith('.venv.pre-313-'))
      rmSync(join(root, name), { recursive: true, force: true })
  }
}

beforeEach(() => {
  cleanArchives()
  h.created = false
  h.failVenv = false
  h.upserts = []
  h.torchInstalled = 0
  h.version = 'Python 3.12.10'
  h.newVersion = 'Python 3.13.18'
  h.failBootstrap = false
  h.components = [{ kind: 'python', installed: true, path: '/fake/python3.13/python' }]
  h.basePython = '/fake/python3.13/python'
  h.probe = { cudaVersion: '12.6', torchVersion: '2.7.0' }
  h.probeThrows = false
  h.torchJson = '{"v": "2.9.0+cu126"}'
  h.gpus = []
  h.gpuThrows = false
  h.missingNewPython = false
  h.requirements = true
  h.installThrows = false
  if (h.requirements) writeFileSync(join(root, 'ComfyUI', 'requirements.txt'), 'x')
  else rmSync(join(root, 'ComfyUI', 'requirements.txt'), { force: true })
  mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
  writeFileSync(venvPython(venv), '')
})

describe('migrateInstancePython (0.2.0)', () => {
  it('archives 3.12, creates 3.13, installs torch and writes the config', async () => {
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    const result = await migrateInstancePython('i1')
    expect(result.ok).toBe(true)
    expect(result.fromVersion).toContain('3.12')
    expect(result.toVersion).toContain('3.13')
    expect(result.channel).toBe('cu126')
    expect(h.torchInstalled).toBe(1)
    expect(result.archivedVenv && existsSync(result.archivedVenv)).toBe(true)
    const final = h.upserts.at(-1) as Record<string, unknown>
    expect(final.migrationState).toBe('none')
    expect(final.pythonVersion).toBe('3.13.18')
  })

  it('short-circuits when the interpreter is already 3.13', async () => {
    h.version = 'Python 3.13.5'
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    const result = await migrateInstancePython('i1')
    expect(result.ok).toBe(true)
    expect(result.warnings[0]).toContain('already 3.13')
    expect(h.upserts).toHaveLength(0)
  })

  it('rejects unknown instances and pre-aborted migrations', async () => {
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    await expect(migrateInstancePython('missing')).rejects.toThrow(/not found/)
    const controller = new AbortController()
    controller.abort()
    await expect(migrateInstancePython('i1', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('selects the right torch channel from every probe shape', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { rocmVersion: '7', torchVersion: '2.9' },
        process.platform === 'win32' ? 'rocm10.0' : 'rocm7.2'
      ],
      [{ mpsAvailable: true, torchVersion: '2.9' }, 'mps'],
      [{ npuAvailable: true, torchVersion: '2.9' }, 'xpu'],
      [{ cudaVersion: '13.0', torchVersion: '2.9' }, 'cu130'],
      [{ cudaVersion: '12.1', torchVersion: '2.9' }, 'cu126'],
      [{ torchVersion: '2.9' }, 'cpu'],
      [{}, 'cpu']
    ]
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    for (const [probe, channel] of cases) {
      h.probe = probe
      h.failVenv = true
      await expect(migrateInstancePython('i1')).rejects.toThrow(/venv creation failed/)
      const failed = h.upserts.at(-1) as Record<string, unknown>
      expect(failed.migrationState).toBe('failed')
      h.failVenv = false
      h.created = false
      mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
      writeFileSync(venvPython(venv), '')
      h.upserts = []
      const success = await migrateInstancePython('i1')
      expect(success.channel).toBe(channel)
      rmSync(join(root, '.comfypilot-env.json'), { force: true })
      cleanArchives()
      h.created = false
      mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
      writeFileSync(venvPython(venv), '')
      h.upserts = []
    }
  })

  it('falls back to GPU detection when probing throws', async () => {
    h.probeThrows = true
    h.gpus = [{ recommendedTorch: 'cu130' }]
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    const result = await migrateInstancePython('i1')
    expect(result.channel).toBe('cu130')
    h.created = false
    cleanArchives()
    mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
    writeFileSync(venvPython(venv), '')
    h.gpuThrows = true
    const cpu = await migrateInstancePython('i1')
    expect(cpu.channel).toBe('cpu')
  })

  it('fails honestly when the 3.13 runtime cannot be resolved', async () => {
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    h.basePython = null
    h.components = []
    await expect(migrateInstancePython('i1')).rejects.toThrow(/PYTHON_UNSUPPORTED/)
    expect((h.upserts.at(-1) as any).migrationState).toBe('failed')
    h.failBootstrap = true
    h.basePython = null
    await expect(migrateInstancePython('i1')).rejects.toThrow(/bootstrap failed/)
  })

  it('rejects a missing or wrong new interpreter', async () => {
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    h.missingNewPython = true
    await expect(migrateInstancePython('i1')).rejects.toThrow(/venv creation failed/)
    h.missingNewPython = false
    h.created = false
    cleanArchives()
    mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
    writeFileSync(venvPython(venv), '')
    h.newVersion = 'Python 3.12.9'
    await expect(migrateInstancePython('i1')).rejects.toThrow(/expected Python 3.13/)
  })

  it('rejects an old or unparseable torch build and bad requirements', async () => {
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    h.torchJson = '{"v": "2.6.0"}'
    await expect(migrateInstancePython('i1')).rejects.toThrow(/below ComfyUI/)
    h.created = false
    cleanArchives()
    mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
    writeFileSync(venvPython(venv), '')
    h.torchJson = 'not json'
    await expect(migrateInstancePython('i1')).rejects.toThrow(/below ComfyUI/)
    h.created = false
    cleanArchives()
    mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
    writeFileSync(venvPython(venv), '')
    h.torchJson = '{"v": "2.9.0"}'
    h.installThrows = true
    await expect(migrateInstancePython('i1')).rejects.toThrow(/requirements failed/)
  })

  it('warns when requirements.txt is missing', async () => {
    h.requirements = false
    rmSync(join(root, 'ComfyUI', 'requirements.txt'), { force: true })
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    const result = await migrateInstancePython('i1')
    expect(result.warnings.join(' ')).toContain('requirements.txt')
  })

  it('restores the archived venv and marks migration-failed when venv creation fails', async () => {
    h.failVenv = true
    const { migrateInstancePython } = await import('../../src/main/services/pythonMigration')
    await expect(migrateInstancePython('i1')).rejects.toThrow(/venv creation failed/)
    expect(existsSync(venvPython(venv))).toBe(true)
    const final = h.upserts.at(-1) as Record<string, unknown>
    expect(final.migrationState).toBe('failed')
    expect(String(final.migrationError)).toContain('venv creation failed')
    // The source venv is restored (the success-path archive from the previous
    // test is intentionally kept for rollback, so only its presence is not an
    // error here).
  })
})
