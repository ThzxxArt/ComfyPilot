import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { EnvCreateRequest, EnvProbe } from '@shared/types'

const execFileAsync = promisify(execFile)

async function safeExec(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: 20000, windowsHide: true })
    return stdout.trim()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
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
    mkdirSync(req.basePath, { recursive: true })
    const venvPath = join(req.basePath, req.name)
    if (req.useUv) {
      await safeExec('uv', ['venv', venvPath, '--python', req.pythonPath])
    } else {
      await safeExec(req.pythonPath, ['-m', 'venv', venvPath])
    }
    const python = existsSync(join(venvPath, 'Scripts', 'python.exe'))
      ? join(venvPath, 'Scripts', 'python.exe')
      : join(venvPath, 'bin', 'python')

    if (req.torchIndex) {
      await safeExec(python, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', req.torchIndex])
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
    const out = await safeExec(opts.pythonPath, [
      '-m',
      'pip',
      'install',
      'torch',
      'torchvision',
      'torchaudio',
      '--index-url',
      opts.index
    ])
    const ok = /Successfully installed|already satisfied|Requirement already satisfied/i.test(out)
    if (!ok) {
      throw new Error(`pip install torch failed: ${out.slice(0, 300)}`)
    }
    return true
  }
}

export const envService = new EnvService()
