import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { EnvCreateRequest, EnvProbe } from '@shared/types'
import { loadSettings } from './db'
import { proxyEnv } from './proxy'

const execFileAsync = promisify(execFile)

async function safeExec(cmd: string, args: string[], cwd?: string, timeoutMs = 20000): Promise<string> {
  try {
    // Must inherit app proxy settings — previously env-created venv/pip ignored them
    // while installer.ts honored them (inconsistent failure for proxy users).
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      env: proxyEnv(loadSettings().proxy)
    })
    return stdout.trim()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const LONG_TIMEOUT_MS = 30 * 60 * 1000

type ExecLike = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<string>

/**
 * Make sure `python -m pip` works inside a venv.
 *
 * `uv venv` does NOT seed pip by default, so a ComfyPilot-created venv can
 * happily exist without pip — and every `python -m pip install` then dies with
 * "No module named pip". We prefer uv for installs (it needs no pip), but any
 * code path that falls back to `python -m pip` must call this first.
 */
export async function ensurePip(pythonPath: string, exec: ExecLike): Promise<void> {
  const probe = async (): Promise<boolean> => {
    try {
      await exec(pythonPath, ['-m', 'pip', '--version'], { timeout: 15000 })
      return true
    } catch {
      return false
    }
  }
  if (await probe()) return
  // Seed pip via the stdlib bootstrap — works on every CPython venv.
  try {
    await exec(pythonPath, ['-m', 'ensurepip', '--upgrade'], { timeout: 120000 })
  } catch {
    /* fall through to verification — some embeds disable ensurepip */
  }
  if (await probe()) return
  throw new Error(
    `pip is not available in ${pythonPath} and ensurepip could not install it. Recreate the venv or run: ${pythonPath} -m ensurepip --upgrade`
  )
}

/**
 * Install requirements.txt into a venv.
 * 1. uv (when present) — works even without pip in the venv
 * 2. ensurepip + python -m pip
 * 3. retry against official PyPI when the configured mirror cannot resolve a package
 */
export async function installRequirements(
  pythonPath: string,
  reqFile: string,
  exec: ExecLike,
  opts?: { uvPath?: string; pipIndex?: string }
): Promise<void> {
  const OFFICIAL_PYPI = 'https://pypi.org/simple'
  const pipIndex = String(opts?.pipIndex || '').trim()
  const uvPath = opts?.uvPath

  const uvInstall = async (index?: string): Promise<void> => {
    if (!uvPath) throw new Error('uv not available')
    const args = ['pip', 'install', '--python', pythonPath, '-r', reqFile]
    if (index) {
      args.push('--index-url', index)
      if (index !== OFFICIAL_PYPI) args.push('--extra-index-url', OFFICIAL_PYPI)
    }
    await exec(uvPath, args, { timeout: LONG_TIMEOUT_MS })
  }
  const pipInstall = async (index?: string): Promise<void> => {
    await ensurePip(pythonPath, exec)
    const args = ['-m', 'pip', 'install', '-r', reqFile]
    if (index) {
      args.push('-i', index)
      try {
        args.push('--trusted-host', new URL(index).hostname)
      } catch {
        /* skip */
      }
      if (index !== OFFICIAL_PYPI) args.push('--extra-index-url', OFFICIAL_PYPI)
    }
    await exec(pythonPath, args, { timeout: LONG_TIMEOUT_MS })
  }
  const tryOnce = async (index?: string): Promise<void> => {
    if (uvPath) await uvInstall(index)
    else await pipInstall(index)
  }

  try {
    await tryOnce(pipIndex || undefined)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Mirror gap must not be fatal — retry against official PyPI only.
    if (pipIndex && pipIndex !== OFFICIAL_PYPI) {
      try {
        await tryOnce(OFFICIAL_PYPI)
        return
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2)
        throw new Error(`requirements install failed (mirror and official): ${msg2.slice(0, 400)}`)
      }
    }
    throw new Error(`requirements install failed: ${msg.slice(0, 400)}`)
  }
}

export class EnvService {
  async probe(opts: { pythonPath: string; venvPath?: string }): Promise<EnvProbe> {
    const pythonPath =
      opts.venvPath && existsSync(join(opts.venvPath, 'Scripts', 'python.exe'))
        ? join(opts.venvPath, 'Scripts', 'python.exe')
        : opts.venvPath && existsSync(join(opts.venvPath, 'bin', 'python'))
          ? join(opts.venvPath, 'bin', 'python')
          : opts.pythonPath

    const errors: string[] = []
    const versionOut = await safeExec(pythonPath, ['--version'])
    const pythonVersion = versionOut
    if (!/Python/i.test(versionOut)) errors.push(versionOut || 'python not found')

    let torchVersion: string | undefined
    let cudaVersion: string | undefined
    let rocmVersion: string | undefined
    let mpsAvailable: boolean | undefined
    let npuAvailable: boolean | undefined
    const packages: Array<{ name: string; version: string }> = []

    const torchScript = [
      'import json, torch',
      'print(json.dumps({',
      '"torch": getattr(torch, "__version__", ""),',
      '"cuda": getattr(torch.version, "cuda", None),',
      '"rocm": getattr(torch.version, "hip", None),',
      '"mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),',
      '"npu": hasattr(torch, "npu") and torch.npu.is_available()',
      '}))'
    ].join(';')
    const torchOut = await safeExec(pythonPath, ['-c', torchScript])
    try {
      const data = JSON.parse(torchOut.trim().split('\n').pop() || '{}')
      torchVersion = data.torch
      cudaVersion = data.cuda || undefined
      rocmVersion = data.rocm || undefined
      mpsAvailable = Boolean(data.mps)
      npuAvailable = Boolean(data.npu)
      packages.push({ name: 'torch', version: data.torch || '' })
    } catch {
      errors.push('torch probe failed: ' + torchOut.slice(0, 120))
    }

    const pipOut = await safeExec(pythonPath, ['-m', 'pip', 'list', '--format=json'])
    try {
      const list = JSON.parse(pipOut.trim().split('\n').pop() || '[]') as Array<{
        name: string
        version: string
      }>
      packages.push(...list.slice(0, 300))
    } catch {
      /* optional */
    }

    return {
      pythonPath,
      pythonVersion,
      venvPath: opts.venvPath,
      torchVersion,
      cudaVersion,
      rocmVersion,
      mpsAvailable,
      npuAvailable,
      packages,
      ok: errors.length === 0,
      errors
    }
  }

  async createVenv(req: EnvCreateRequest): Promise<EnvProbe> {
    const { assertSafeRelativeFilename, isPathInside } = await import('./security')
    // Name must be a single safe directory segment — never `..` or a path.
    const safeName = assertSafeRelativeFilename(req.name || 'venv')
    mkdirSync(req.basePath, { recursive: true })
    const venvPath = join(req.basePath, safeName)
    if (!isPathInside(venvPath, req.basePath)) {
      throw new Error(`Invalid venv name: ${req.name}`)
    }
    if (req.useUv) {
      // --seed installs pip into the venv so `python -m pip` works later.
      await safeExec('uv', ['venv', venvPath, '--python', req.pythonPath, '--seed'], undefined, LONG_TIMEOUT_MS)
    } else {
      await safeExec(req.pythonPath, ['-m', 'venv', venvPath], undefined, LONG_TIMEOUT_MS)
    }
    const python = existsSync(join(venvPath, 'Scripts', 'python.exe'))
      ? join(venvPath, 'Scripts', 'python.exe')
      : join(venvPath, 'bin', 'python')
    if (!existsSync(python)) {
      throw new Error(`venv creation failed — no interpreter at ${python}`)
    }

    if (req.torchIndex) {
      await safeExec(
        python,
        ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', req.torchIndex],
        undefined,
        LONG_TIMEOUT_MS
      )
    }

    return this.probe({ pythonPath: python, venvPath })
  }

  async listPythons(): Promise<Array<{ path: string; version: string }>> {
    const candidates = ['python', 'python3', 'py']
    const out: Array<{ path: string; version: string }> = []
    for (const cmd of candidates) {
      const v = await safeExec(cmd, ['--version'])
      if (/Python/i.test(v)) out.push({ path: cmd, version: v })
    }
    // ComfyPilot-managed portable Python (zero-prereq bootstrap)
    try {
      const { resolveRuntimesPythonSync } = await import('./instance')
      const runtimePy = resolveRuntimesPythonSync()
      if (runtimePy) {
        const v = await safeExec(runtimePy, ['--version'])
        if (/Python/i.test(v)) out.push({ path: runtimePy, version: v })
      }
    } catch {
      /* ignore */
    }
    // Common Windows installs
    for (const p of [
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe')
    ]) {
      if (p && existsSync(p)) {
        const v = await safeExec(p, ['--version'])
        out.push({ path: p, version: v })
      }
    }
    return out
  }

  async installTorch(opts: { pythonPath: string; index: string }): Promise<boolean> {
    const out = await safeExec(
      opts.pythonPath,
      [
        '-m',
        'pip',
        'install',
        'torch',
        'torchvision',
        'torchaudio',
        '--index-url',
        opts.index
      ],
      undefined,
      LONG_TIMEOUT_MS
    )
    const ok = /Successfully installed|already satisfied|Requirement already satisfied/i.test(out)
    if (!ok) {
      throw new Error(`pip install torch failed: ${out.slice(0, 300)}`)
    }
    return true
  }

  /**
   * Repair / complete the Python environment for an already-registered instance.
   * - creates the venv when missing (or when recreateVenv is set)
   * - optionally (re)installs torch for a channel
   * - installs ComfyUI's requirements.txt into the venv
   * Returns a fresh EnvProbe of the resulting environment.
   */
  async repairEnv(opts: {
    instanceId: string
    torchChannel?: string
    recreateVenv?: boolean
  }): Promise<EnvProbe> {
    const { loadInstanceConfigs } = await import('./db')
    const { join } = await import('path')
    const { existsSync, mkdirSync, rmSync } = await import('fs')
    const config = loadInstanceConfigs().find((c) => c.id === opts.instanceId)
    if (!config) throw new Error(`Instance not found: ${opts.instanceId}`)
    const comfyDir = config.path
    if (!comfyDir || !existsSync(join(comfyDir, 'main.py'))) {
      throw new Error(`Not a ComfyUI install: ${comfyDir}`)
    }

    let venvPath = config.venvPath || ''
    if (!venvPath) {
      const { dirname } = await import('path')
      venvPath = join(dirname(comfyDir), '.venv')
    }
    const pythonInVenv = existsSync(join(venvPath, 'Scripts', 'python.exe'))
      ? join(venvPath, 'Scripts', 'python.exe')
      : join(venvPath, 'bin', 'python')

    if (opts.recreateVenv && existsSync(venvPath)) {
      rmSync(venvPath, { recursive: true, force: true })
    }

    if (!existsSync(pythonInVenv)) {
      // Create the venv using the same resolution order as the installer.
      const { bootstrapService } = await import('./bootstrap')
      const bootstrap = await bootstrapService.ensure({ kinds: ['uv', 'python'], downloadIfMissing: true })
      const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
      mkdirSync(venvPath, { recursive: true })
      mkdirSync(join(venvPath, '..'), { recursive: true })
      if (uvComp?.path) {
        try {
          await safeExec(uvComp.path, ['python', 'install', '3.13'], undefined, 180000)
        } catch {
          /* interpreter may already be present */
        }
        // --seed installs pip/setuptools/wheel — without it `python -m pip` dies.
        await safeExec(uvComp.path, ['venv', venvPath, '--python', '3.13', '--seed'], undefined, 180000)
      } else {
        const basePython = bootstrap.pythonPath && bootstrap.pythonPath !== 'python' ? bootstrap.pythonPath : 'python'
        await safeExec(basePython, ['-m', 'venv', venvPath], undefined, 180000)
      }
      if (!existsSync(pythonInVenv)) {
        throw new Error(`venv creation failed — no interpreter at ${pythonInVenv}`)
      }
    }

    // Optional torch
    if (opts.torchChannel) {
      const { resolveTorchIndex, officialTorchIndex } = await import('./installer')
      const channel = opts.torchChannel as Parameters<typeof resolveTorchIndex>[0]
      const index = resolveTorchIndex(channel)
      const official = officialTorchIndex(channel)
      const { bootstrapService } = await import('./bootstrap')
      const bootstrap = await bootstrapService.ensure({ kinds: ['uv'], downloadIfMissing: false })
      const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
      const tryInstall = async (idx: string): Promise<boolean> => {
        const out = await safeExec(
          pythonInVenv,
          ['-m', 'pip', 'install', '--upgrade', 'torch', 'torchvision', 'torchaudio', '--index-url', idx],
          undefined,
          LONG_TIMEOUT_MS
        )
        return /Successfully installed|already satisfied|Requirement already satisfied/i.test(out)
      }
      // Prefer uv (works even when the venv has no pip), fall back to pip.
      if (uvComp?.path) {
        try {
          await safeExec(
            uvComp.path,
            ['pip', 'install', '--python', pythonInVenv, '--upgrade', 'torch', 'torchvision', 'torchaudio', '--index-url', index],
            undefined,
            LONG_TIMEOUT_MS
          )
        } catch {
          if (index !== official) {
            await safeExec(
              uvComp.path,
              ['pip', 'install', '--python', pythonInVenv, '--upgrade', 'torch', 'torchvision', 'torchaudio', '--index-url', official],
              undefined,
              LONG_TIMEOUT_MS
            )
          } else {
            throw new Error(`torch install failed for channel ${opts.torchChannel}`)
          }
        }
      } else {
        await ensurePip(pythonInVenv, async (c, a, o) => safeExec(c, a, o?.cwd, o?.timeout))
        let ok = await tryInstall(index)
        if (!ok && index !== official) ok = await tryInstall(official)
        if (!ok) throw new Error(`torch install failed for channel ${opts.torchChannel}`)
      }
    }

    // requirements
    const reqFile = join(comfyDir, 'requirements.txt')
    if (existsSync(reqFile)) {
      const settings = loadSettings()
      const { bootstrapService } = await import('./bootstrap')
      const bootstrap = await bootstrapService.ensure({ kinds: ['uv'], downloadIfMissing: false })
      const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
      await installRequirements(pythonInVenv, reqFile, async (c, a, o) => safeExec(c, a, o?.cwd, o?.timeout), {
        uvPath: uvComp?.path,
        pipIndex: String(settings.pipIndex || '').trim()
      })
    }

    return this.probe({ pythonPath: pythonInVenv, venvPath })
  }
}

export const envService = new EnvService()
