import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  created: false,
  failVenv: false,
  upserts: [] as Array<Record<string, unknown>>,
  torchInstalled: 0
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
      done(h.created ? 'Python 3.13.18' : 'Python 3.12.10')
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
      writeFileSync(venvPython(dir), '')
      h.created = true
      done()
      return { pid: 1, exitCode: null, kill: () => undefined }
    }
    if (args[0] === '-c' && String(args[1]).includes('torch.__version__')) {
      done('{"v": "2.9.0+cu126"}')
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
      venvPath: join(h.root, '.venv'),
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
  findInRuntimes: () => '/fake/python3.13/python',
  bootstrapService: {
    ensure: async () => ({
      components: [{ kind: 'python', installed: true, path: '/fake/python3.13/python' }]
    })
  }
}))
vi.mock('../../src/main/services/env', () => ({
  envService: {
    probe: async () => ({ cudaVersion: '12.6', torchVersion: '2.7.0' }),
    installTorch: async () => {
      h.torchInstalled += 1
    }
  },
  installRequirements: async () => undefined
}))
vi.mock('../../src/main/services/installer', () => ({
  officialTorchIndex: () => 'https://download.pytorch.org/whl/cu126/'
}))

const root = mkdtempSync(join(tmpdir(), 'cp-pymig-'))
h.root = root
const venv = join(root, '.venv')
mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
writeFileSync(venvPython(venv), '')
mkdirSync(join(root, 'ComfyUI'), { recursive: true })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  h.created = false
  h.failVenv = false
  h.upserts = []
  h.torchInstalled = 0
  // Ensure the source venv still exists between cases.
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
