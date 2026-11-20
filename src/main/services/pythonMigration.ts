/**
 * 0.2.0 Python 3.13 one-way migration.
 *
 * A 0.1.18 instance may point at a Python 3.12 venv. 0.2.0 refuses to launch
 * it. This module performs the explicit migration:
 *   stop → archive old venv → create 3.13 venv → torch → requirements →
 *   verify → write config. A failure restores the archived venv and leaves the
 *   instance in `migration-failed` (never silently runs 3.12).
 */
import { execFile } from 'child_process'
import { existsSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { ComfyInstanceConfig, TorchChannel } from '@shared/types'
import { loadInstanceConfigs, upsertInstanceConfig } from './db'
import { findInRuntimes, bootstrapService } from './bootstrap'
import { envService, installRequirements } from './env'
import { acquireEnvLock } from './envLock'
import { resolveTorchIndex } from './installer'

const execFileAsync = promisify(execFile)

export interface PythonMigrationResult {
  ok: boolean
  instanceId: string
  venvPath: string
  fromVersion: string
  toVersion: string
  channel: TorchChannel
  archivedVenv?: string
  warnings: string[]
}

function venvPython(venvPath: string): string {
  const win = join(venvPath, 'Scripts', 'python.exe')
  const unix = join(venvPath, 'bin', 'python')
  return process.platform === 'win32' ? win : unix
}

function resolveVenvPath(config: ComfyInstanceConfig): string {
  if (config.venvPath) return config.venvPath
  for (const candidate of [join(config.path, '.venv'), join(config.path, 'venv')]) {
    if (existsSync(venvPython(candidate))) return candidate
  }
  // Embedded-Python installs (AKI/绘世) have no venv. Create one inside the
  // instance; the old embedded interpreter is left untouched for rollback.
  return join(config.path, '.venv')
}

async function versionOf(python: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(python, ['--version'], {
      timeout: 8000,
      windowsHide: true,
      signal
    })
    return `${String(stdout || '')}\n${String(stderr || '')}`.trim()
  } catch {
    return ''
  }
}

/** "Python 3.13.18" → "3.13.18"; undefined when unparseable. */
function parseVersion(versionText: string): string | undefined {
  const m = String(versionText).match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i)
  return m ? m[1] : undefined
}

function is313(versionText: string): boolean {
  return /Python\s+3\.13(\.|$)/i.test(versionText)
}

async function chooseChannel(
  venvPath: string,
  oldPython: string,
  warnings: string[]
): Promise<TorchChannel> {
  try {
    const probe = await envService.probe({ pythonPath: oldPython, venvPath })
    if (probe.rocmVersion) return process.platform === 'win32' ? 'rocm10.0' : 'rocm7.2'
    if (probe.mpsAvailable) return 'mps'
    if (probe.npuAvailable) return 'xpu'
    if (probe.cudaVersion) {
      if (probe.cudaVersion.startsWith('13')) return 'cu130'
      if (probe.cudaVersion.startsWith('12')) return 'cu126'
    }
    if (probe.torchVersion) return 'cpu'
  } catch (err) {
    warnings.push(`torch probe failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const { installerService } = await import('./installer')
    const gpus = await installerService.detectGpu()
    const rec = gpus[0]?.recommendedTorch
    if (rec) return rec
  } catch {
    /* fall through */
  }
  return 'cpu'
}

async function installTorchAndRequirements(
  python: string,
  channel: TorchChannel,
  requirementsFile: string,
  warnings: string[],
  signal?: AbortSignal
): Promise<void> {
  // 0.2.5 WP0: respect the configured torch mirror, not only the official index.
  const index = resolveTorchIndex(channel)
  await envService.installTorch({ pythonPath: python, index })
  const { stdout } = await execFileAsync(
    python,
    ['-c', 'import json,torch;print(json.dumps({"v":torch.__version__}))'],
    { timeout: 60000, windowsHide: true, signal }
  )
  const line =
    String(stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop() || '{}'
  let version = ''
  try {
    version = String((JSON.parse(line) as { v?: string }).v || '')
  } catch {
    /* handled below */
  }
  const m = version.split('+')[0].match(/^(\d+)\.(\d+)/)
  const major = m ? Number(m[1]) : 0
  const minor = m ? Number(m[2]) : 0
  if (major < 2 || (major === 2 && minor < 7)) {
    throw new Error(`migrated torch ${version || '?'} is below ComfyUI's minimum 2.7`)
  }
  if (existsSync(requirementsFile)) {
    await installRequirements(
      python,
      requirementsFile,
      async (cmd, args, opts) => {
        const res = await execFileAsync(cmd, args, {
          cwd: opts?.cwd,
          timeout: opts?.timeout ?? 30 * 60 * 1000,
          windowsHide: true,
          maxBuffer: 20 * 1024 * 1024,
          signal
        })
        return `${res.stdout || ''}\n${res.stderr || ''}`
      },
      {}
    )
  } else {
    warnings.push('requirements.txt not found — only torch was installed')
  }
}

export async function migrateInstancePython(
  instanceId: string,
  opts?: { signal?: AbortSignal }
): Promise<PythonMigrationResult> {
  const config = loadInstanceConfigs().find((c) => c.id === instanceId)
  if (!config) throw new Error(`Instance not found: ${instanceId}`)
  const signal = opts?.signal
  const checkAbort = (): void => {
    if (!signal?.aborted) return
    const e = new Error('Python migration cancelled')
    e.name = 'AbortError'
    throw e
  }
  checkAbort()
  const venvPath = resolveVenvPath(config)
  const oldPython = venvPython(venvPath)
  const fromVersion = (await versionOf(oldPython, signal)) || 'unknown'
  if (is313(fromVersion)) {
    return {
      ok: true,
      instanceId,
      venvPath,
      fromVersion,
      toVersion: fromVersion,
      channel: 'cpu',
      warnings: ['already 3.13 — nothing to do']
    }
  }
  if (opts?.signal?.aborted) throw new Error('Python migration cancelled')

  const warnings: string[] = []
  const channel = await chooseChannel(venvPath, oldPython, warnings)

  // 0.2.5 WP0: migration writes the same venv as repair/install — one lock.
  const releaseEnvLock = acquireEnvLock(instanceId, 'python-migration')
  try {
  upsertInstanceConfig({ ...config, migrationState: 'migrating', migrationError: undefined })

  // 1. Base interpreter: portable 3.13, or download it. This resolution used
  // to sit outside any try, so a download failure left the instance stuck in
  // `migrating` forever (0.2.5 WP0).
  let basePython: string | null = findInRuntimes('python')
  try {
    if (!basePython) {
      const status = await bootstrapService.ensure({
        kinds: ['python'],
        downloadIfMissing: true,
        signal
      })
      basePython = status.components.find((c) => c.kind === 'python' && c.installed)?.path || null
    }
    if (!basePython) throw new Error('PYTHON_UNSUPPORTED: no Python 3.13 runtime available')
    checkAbort()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    upsertInstanceConfig({ ...config, migrationState: 'failed', migrationError: message })
    throw err
  }

  // 2. Archive the old venv. Never delete it before the new one is verified.
  const archivedVenv = `${venvPath}.pre-313-${new Date().toISOString().replace(/[:.]/g, '-')}`
  let archived = false
  try {
    if (existsSync(venvPath)) {
      renameSync(venvPath, archivedVenv)
      archived = true
    }
    checkAbort()
    // 3. Create the 3.13 venv.
    await execFileAsync(basePython, ['-m', 'venv', venvPath], {
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      signal
    })
    checkAbort()
    const newPython = venvPython(venvPath)
    if (!existsSync(newPython)) throw new Error(`venv creation failed — missing ${newPython}`)
    const newVersion = await versionOf(newPython, signal)
    const parsedNewVersion = parseVersion(newVersion)
    if (!is313(newVersion) || !parsedNewVersion) {
      throw new Error(`venv reports ${newVersion || 'unknown'} — expected Python 3.13`)
    }

    // 4. Install torch + requirements.
    await installTorchAndRequirements(
      newPython,
      channel,
      join(config.path, 'requirements.txt'),
      warnings,
      signal
    )
    checkAbort()

    // 5. Only now write the config + EnvMarker. A stale marker from the old
    // 3.12 era would block the next launch with ENV_MISMATCH.
    try {
      writeFileSync(
        join(dirname(config.path), '.comfypilot-env.json'),
        JSON.stringify(
          {
            venvPath,
            pythonPath: newPython,
            pythonVersion: parsedNewVersion,
            migratedAt: Date.now()
          },
          null,
          2
        )
      )
    } catch {
      warnings.push('could not update .comfypilot-env.json')
    }
    upsertInstanceConfig({
      ...config,
      venvPath,
      pythonPath: '',
      pythonVersion: parsedNewVersion,
      migrationState: 'none',
      migrationError: undefined
    })
    return {
      ok: true,
      instanceId,
      venvPath,
      fromVersion,
      toVersion: newVersion,
      channel,
      archivedVenv: archived ? archivedVenv : undefined,
      warnings
    }
  } catch (err) {
    // Restore the old environment and keep the instance blocked but intact.
    try {
      if (existsSync(venvPath)) rmSync(venvPath, { recursive: true, force: true })
      if (archived && existsSync(archivedVenv)) renameSync(archivedVenv, venvPath)
    } catch {
      warnings.push('could not restore the archived venv automatically')
    }
    const message = err instanceof Error ? err.message : String(err)
    upsertInstanceConfig({ ...config, migrationState: 'failed', migrationError: message })
    throw err
  }
  } finally {
    releaseEnvLock()
  }
}
