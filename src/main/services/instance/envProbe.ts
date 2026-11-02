import { execFile } from 'child_process'
import { promisify } from 'util'
import type { EnvProbe } from '@shared/types'
import { loadInstanceConfigs } from '../db'
import type { InstanceServiceContext } from './types'

const execFileAsync = promisify(execFile)

export async function probeEnv(ctx: InstanceServiceContext, id: string): Promise<EnvProbe> {
  const configs = loadInstanceConfigs()
  const config = configs.find((c) => c.id === id)
  // Same platform-aware lookup as launch (venv Scripts/bin, embeds, fallback).
  const pythonPath = config ? ctx.resolvePython(config) : 'python'
  const errors: string[] = []
  let pythonVersion = ''
  let torchVersion: string | undefined
  let cudaVersion: string | undefined
  let mpsAvailable: boolean | undefined
  let npuAvailable: boolean | undefined
  const packages: Array<{ name: string; version: string }> = []

  try {
    const { stdout } = await execFileAsync(pythonPath, ['--version'], { timeout: 8000 })
    pythonVersion = stdout.trim() || (await pyVersionFallback(pythonPath))
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }

  try {
    // NOTE (0.1.12 fix): newline-joined, NOT ';'-joined. The old join(';')
    // produced `{;"torch"` — a permanent Python SyntaxError, silently caught
    // and reported as "torch probe failed" since 0.1.4.
    const script = [
      'import torch, json',
      'print(json.dumps({',
      '"torch": getattr(torch, "__version__", ""),',
      '"cuda": getattr(torch.version, "cuda", None),',
      '"mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),',
      '"npu": bool(getattr(torch, "npu", None) and hasattr(torch.npu, "is_available") and torch.npu.is_available())',
      '}))'
    ].join('\n')
    const { stdout } = await execFileAsync(pythonPath, ['-c', script], { timeout: 15000 })
    const data = JSON.parse(stdout.trim().split('\n').pop() || '{}')
    torchVersion = data.torch
    cudaVersion = data.cuda || undefined
    mpsAvailable = Boolean(data.mps)
    npuAvailable = Boolean(data.npu)
    packages.push({ name: 'torch', version: data.torch || '' })
  } catch (e) {
    errors.push('torch: ' + (e instanceof Error ? e.message : String(e)))
  }

  try {
    const { stdout } = await execFileAsync(pythonPath, ['-m', 'pip', 'list', '--format=json'], {
      timeout: 20000
    })
    const list = JSON.parse(stdout.trim()) as Array<{ name: string; version: string }>
    packages.push(...list.slice(0, 200))
  } catch {
    /* optional */
  }

  // pip availability (0.1.12 WP4) — probed and REPORTED. Previously the
  // "No module named pip" failure vanished into the catch above, so the env
  // card said OK while every manual pip path was dead.
  let pip: { present: boolean; version?: string } = { present: false }
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-m', 'pip', '--version'], {
      timeout: 15000
    })
    const m = stdout.trim().match(/\bpip\s+([0-9][^\s]*)/i)
    if (m) pip = { present: true, version: m[1] }
  } catch {
    /* probed below */
  }
  if (!pip.present) {
    errors.push(
      'pip is not available in this environment — use Doctor "Fix pip" (ensurepip) or Repair environment'
    )
  }

  return {
    pythonPath,
    pythonVersion,
    venvPath: config?.venvPath || undefined,
    torchVersion,
    cudaVersion,
    mpsAvailable,
    npuAvailable,
    packages,
    pip,
    ok: errors.length === 0 && Boolean(pythonVersion),
    errors
  }
}

async function pyVersionFallback(pythonPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], {
      timeout: 8000
    })
    return stdout.trim()
  } catch {
    return ''
  }
}
