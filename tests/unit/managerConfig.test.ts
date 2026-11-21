import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ComfyInstanceConfig } from '@shared/types'

const h = vi.hoisted(() => ({
  root: '',
  instances: [] as Array<Record<string, unknown>>,
  pipVersion: '',
  pipCalls: 0,
  installCalls: [] as string[],
  installResults: [] as Array<{ ok: boolean; error?: string }>
}))

vi.mock('electron', () => ({ app: { getPath: () => h.root } }))
vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.instances,
  loadSettings: () => ({ networkMode: 'offline' })
}))
vi.mock('../../src/main/services/instance', () => ({
  resolveInstancePythonPath: () => 'python-does-not-exist'
}))
vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    optsOrCb: unknown,
    maybeCb?: (e: Error | null, stdout?: string, stderr?: string) => void
  ) => {
    h.pipCalls += 1
    const done = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
      ((e: Error | null, stdout?: string, stderr?: string) => void) | undefined
    queueMicrotask(() => {
      if (!done) return
      if (h.pipVersion) {
        done(
          null,
          {
            stdout: `Name: comfyui-manager\nVersion: ${h.pipVersion}\n`,
            stderr: ''
          } as unknown as string,
          ''
        )
      } else {
        done(new Error('pip show: not found'), '', '')
      }
    })
    return { pid: 1 }
  }
}))
vi.mock('../../src/main/services/pipOps', () => ({
  pipOpsService: {
    installSpec: async (_id: string, spec: string) => {
      h.installCalls.push(spec)
      const result = h.installResults.shift() || { ok: true }
      const version = /^comfyui-manager==(.+)$/.exec(spec)?.[1]
      if (result.ok && version) h.pipVersion = version
      return {
        ok: result.ok,
        installed: [],
        unresolved: [],
        error: result.error
      }
    }
  }
}))

import {
  getManagerInfo,
  installManagerV4,
  managerConfigPaths,
  parseManagerConfig,
  setManagerSecurityLevel,
  updateManagerConfigText
} from '../../src/main/services/manager'

function cfg(path: string): ComfyInstanceConfig {
  return {
    id: 'i1',
    name: 'M',
    path,
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: ['--enable-manager'],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false
  }
}

let root = ''
let comfy = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-manager-'))
  h.root = root
  comfy = join(root, 'ComfyUI')
  mkdirSync(comfy, { recursive: true })
  mkdirSync(join(comfy, 'user', '__manager'), { recursive: true })
  h.instances = [cfg(comfy) as unknown as Record<string, unknown>]
  h.pipVersion = ''
  h.pipCalls = 0
  h.installCalls = []
  h.installResults = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Manager config.ini parser (0.2.5 WP4)', () => {
  it('parses [default] values with % literal and keeps unknown keys', () => {
    const text =
      '\uFEFF# comment\r\n[default]\r\nsecurity_level = weak\r\nnetwork_mode = private\r\nfoo = 100%\r\n[other]\r\nsecurity_level = strong\r\n'
    const parsed = parseManagerConfig(text)
    expect(parsed.securityLevel).toBe('weak')
    expect(parsed.networkMode).toBe('private')
    expect(parsed.values.foo).toBe('100%')
    expect(parsed.values.security_level).toBe('weak')
    expect(parsed.hasDefault).toBe(true)
  })

  it('updates only the requested key and preserves comments/CRLF/unknown keys', () => {
    const text =
      '# keep me\r\n[default]\r\nsecurity_level = strong\r\nnetwork_mode = public\r\nunknown = yes\r\n'
    const next = updateManagerConfigText(text, { securityLevel: 'normal' })
    expect(next).toContain('# keep me')
    expect(next).toContain('security_level = normal')
    expect(next).toContain('network_mode = public')
    expect(next).toContain('unknown = yes')
    expect(next).toContain('\r\n')
  })

  it('preserves a UTF-8 BOM and CRLF when writing', () => {
    const text = '\uFEFF# keep\r\n[default]\r\nsecurity_level = strong\r\n'
    const next = updateManagerConfigText(text, { securityLevel: 'weak' })
    expect(next.startsWith('\uFEFF')).toBe(true)
    expect(next).toContain('security_level = weak')
    expect(next).toContain('\r\n')
    expect(parseManagerConfig(next).securityLevel).toBe('weak')
  })

  it('adds a missing key under [default] without disturbing other sections', () => {
    const text = '[default]\nsecurity_level = strong\n\n[other]\nnetwork_mode = offline\n'
    const next = updateManagerConfigText(text, { networkMode: 'private' })
    expect(next).toContain('network_mode = private')
    const parsed = parseManagerConfig(next)
    expect(parsed.networkMode).toBe('private')
    expect(parsed.securityLevel).toBe('strong')
  })
})

describe('Manager facts and writes (0.2.5 WP4)', () => {
  it('prefers user/__manager/config.ini and reports legacy backup', async () => {
    const paths = managerConfigPaths(cfg(comfy))
    writeFileSync(paths.configPath, '[default]\nsecurity_level = normal\nnetwork_mode = public\n')
    const legacyDir = join(comfy, 'user', 'default', 'ComfyUI-Manager')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'config.ini'), '[default]\nsecurity_level = weak\n')
    mkdirSync(join(comfy, 'custom_nodes', 'ComfyUI-Manager'), { recursive: true })
    h.instances = [cfg(comfy) as unknown as Record<string, unknown>]

    const info = await getManagerInfo(cfg(comfy))
    expect(info.configPath).toBe(paths.configPath)
    expect(info.securityLevel).toBe('normal')
    expect(info.networkMode).toBe('public')
    expect(info.source).toBe('git')
    expect(info.legacyBackup).toBe(join(legacyDir, 'config.ini'))
    expect(info.warnings.join(' ')).toMatch(/legacy/i)
  })

  it('falls back to the legacy path when v4 config is absent', async () => {
    const paths = managerConfigPaths(cfg(comfy))
    mkdirSync(join(comfy, 'user', 'default', 'ComfyUI-Manager'), { recursive: true })
    writeFileSync(paths.legacyConfigPath, '[default]\nsecurity_level = weak\n')
    const info = await getManagerInfo(cfg(comfy))
    expect(info.configPath).toBe(paths.legacyConfigPath)
    expect(info.securityLevel).toBe('weak')
  })

  it('writes atomically with a backup and preserves unknown content', async () => {
    const paths = managerConfigPaths(cfg(comfy))
    writeFileSync(
      paths.configPath,
      '# header\n[default]\nsecurity_level = strong\nnetwork_mode = public\ncustom = v\n'
    )
    const info = await setManagerSecurityLevel(cfg(comfy), 'normal')
    expect(info.securityLevel).toBe('normal')
    const body = readFileSync(paths.configPath, 'utf-8')
    expect(body).toContain('# header')
    expect(body).toContain('custom = v')
    expect(
      readdirSync(join(comfy, 'user', '__manager')).some((n) => n.startsWith('config.ini.bak-'))
    ).toBe(true)
  })

  it('rejects an invalid level and a missing config without creating one', async () => {
    const paths = managerConfigPaths(cfg(comfy))
    await expect(setManagerSecurityLevel(cfg(comfy), 'permissive' as never)).rejects.toThrow(
      /Invalid Manager security level/i
    )
    await expect(setManagerSecurityLevel(cfg(comfy), 'normal')).rejects.toThrow(/missing/i)
    expect(existsSync(paths.configPath)).toBe(false)
  })

  it('installs 4.4.2 through pip only when missing and refreshes the cached version', async () => {
    const info = await installManagerV4(cfg(comfy))
    expect(info.ok).toBe(true)
    expect(h.installCalls).toEqual(['comfyui-manager==4.4.2'])
    expect(info.info.version).toBe('4.4.2')
    expect(info.info.source).toBe('pip')
  })

  it('does not reinstall an already-installed 4.4.2', async () => {
    h.pipVersion = '4.4.2'
    const info = await installManagerV4(cfg(comfy))
    expect(info.ok).toBe(true)
    expect(h.installCalls).toEqual([])
    expect(info.message).toMatch(/already installed/i)
  })

  it('rolls back to the previous pip version when an upgrade fails', async () => {
    h.pipVersion = '4.4.1'
    h.installResults = [{ ok: false, error: 'mirror 500' }, { ok: true }]
    const result = await installManagerV4(cfg(comfy))
    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.message).toMatch(/mirror 500/)
    expect(h.installCalls).toEqual(['comfyui-manager==4.4.2', 'comfyui-manager==4.4.1'])
    expect(result.info.version).toBe('4.4.1')
  })

  it('reports no rollback when there was no previous pip version', async () => {
    h.installResults = [{ ok: false, error: 'no network' }]
    const result = await installManagerV4(cfg(comfy))
    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(false)
    expect(h.installCalls).toEqual(['comfyui-manager==4.4.2'])
  })
})
