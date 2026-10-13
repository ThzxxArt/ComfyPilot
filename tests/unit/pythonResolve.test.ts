/**
 * Py interpreter resolution tests — AKI/绘世 integration layout:
 * `<root>/python/python.exe` sits beside the `ComfyUI/` source directory.
 * The same resolver feeds instance launch, env probes and node-pack pip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ComfyInstanceConfig } from '../../src/shared/types'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return { app: { getPath: () => path.join(os.tmpdir(), 'cp-pythonresolve-userdata') } }
})

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-pyres-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cfg(partial: Partial<ComfyInstanceConfig>): ComfyInstanceConfig {
  return {
    id: 'test',
    name: 'test',
    path: '',
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false,
    ...partial
  }
}

describe('resolveInstancePythonPath', () => {
  it('resolves the AKI sibling <root>/python/python.exe when ComfyUI/ is the instance root', async () => {
    const { resolveInstancePythonPath } = await import('../../src/main/services/instance')
    const akiRoot = join(dir, 'aki-sibling')
    const comfy = join(akiRoot, 'ComfyUI')
    mkdirSync(join(akiRoot, 'python'), { recursive: true })
    mkdirSync(comfy, { recursive: true })
    writeFileSync(join(akiRoot, 'python', 'python.exe'), '')
    expect(resolveInstancePythonPath(cfg({ path: comfy }))).toBe(
      join(akiRoot, 'python', 'python.exe')
    )
  })

  it('resolves <root>/python/python.exe when the AKI root itself is registered', async () => {
    const { resolveInstancePythonPath } = await import('../../src/main/services/instance')
    const akiRoot = join(dir, 'aki-root')
    mkdirSync(join(akiRoot, 'python'), { recursive: true })
    writeFileSync(join(akiRoot, 'python', 'python.exe'), '')
    expect(resolveInstancePythonPath(cfg({ path: akiRoot }))).toBe(
      join(akiRoot, 'python', 'python.exe')
    )
  })

  it('prefers an existing venv over embedded Python', async () => {
    const { resolveInstancePythonPath } = await import('../../src/main/services/instance')
    const akiRoot = join(dir, 'aki-venv')
    const comfy = join(akiRoot, 'ComfyUI')
    const venv = join(dir, 'aki-venv', '.venv')
    mkdirSync(join(akiRoot, 'python'), { recursive: true })
    mkdirSync(join(venv, 'Scripts'), { recursive: true })
    mkdirSync(comfy, { recursive: true })
    writeFileSync(join(akiRoot, 'python', 'python.exe'), '')
    writeFileSync(join(venv, 'Scripts', 'python.exe'), '')
    expect(resolveInstancePythonPath(cfg({ path: comfy, venvPath: venv }))).toBe(
      join(venv, 'Scripts', 'python.exe')
    )
  })

  it('honors an explicit pythonPath before embedded discovery', async () => {
    const { resolveInstancePythonPath } = await import('../../src/main/services/instance')
    const akiRoot = join(dir, 'aki-explicit')
    mkdirSync(join(akiRoot, 'python'), { recursive: true })
    writeFileSync(join(akiRoot, 'python', 'python.exe'), '')
    expect(
      resolveInstancePythonPath(cfg({ path: akiRoot, pythonPath: 'C:/custom/python.exe' }))
    ).toBe('C:/custom/python.exe')
  })

  it('falls back to bare python when nothing exists', async () => {
    const { resolveInstancePythonPath } = await import('../../src/main/services/instance')
    expect(resolveInstancePythonPath(cfg({ path: join(dir, 'missing-install') }))).toBe('python')
  })
})
