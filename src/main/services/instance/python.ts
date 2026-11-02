import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import type { ComfyInstanceConfig } from '@shared/types'
import { findInRuntimes } from '../bootstrap'

const execFileAsync = promisify(execFile)

/**
 * Synchronous lookup of the portable Python installed under userData/runtimes.
 * Kept sync so resolvePython (used on hot spawn paths) does not need await.
 * Delegates to bootstrap.findInRuntimes so nested install_only layouts match.
 */
export function resolveRuntimesPythonSync(): string | null {
  try {
    return findInRuntimes('python')
  } catch {
    return null
  }
}

/**
 * Shared interpreter resolution for an instance config.
 * Order: venv → explicit pythonPath → portable embeds (incl. AKI/绘世 sibling
 * `<root>/python/`) → ComfyPilot-managed runtime → bare `python`.
 * Used by instance launch, env probe and node-pack pip installs so all three
 * agree on one interpreter.
 */
export function resolveInstancePythonPath(config: ComfyInstanceConfig): string {
  if (config.venvPath) {
    const win = join(config.venvPath, 'Scripts', 'python.exe')
    const unix = join(config.venvPath, 'bin', 'python')
    if (existsSync(win)) return win
    if (existsSync(unix)) return unix
  }
  // 0.2.0: instances created outside ComfyPilot often have their venv inside
  // the ComfyUI directory. Ignoring it made launch/pip/audit use a completely
  // different interpreter than the user's environment.
  for (const local of [join(config.path, '.venv'), join(config.path, 'venv')]) {
    const win = join(local, 'Scripts', 'python.exe')
    const unix = join(local, 'bin', 'python')
    if (existsSync(win)) return win
    if (existsSync(unix)) return unix
  }
  if (config.pythonPath) return config.pythonPath
  const parent = dirname(config.path)
  const candidates = [
    join(config.path, 'python_embeded', 'python.exe'),
    join(config.path, 'python_embedded', 'python.exe'),
    join(config.path, 'python', 'python.exe'),
    join(config.path, 'python', 'bin', 'python3'),
    join(parent, 'python', 'python.exe'),
    join(parent, 'python', 'bin', 'python3'),
    join(parent, 'python_embeded', 'python.exe'),
    join(parent, 'python_embedded', 'python.exe')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  const runtimePy = resolveRuntimesPythonSync()
  if (runtimePy) return runtimePy
  return 'python'
}

/** Instance-local alias kept for the launch/env-probe call sites. */
export function resolvePython(config: ComfyInstanceConfig): string {
  return resolveInstancePythonPath(config)
}

export async function pythonVersionText(python: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(python, ['--version'], {
      timeout: 8000,
      windowsHide: true
    })
    return String(stdout || '').trim()
  } catch {
    return ''
  }
}
