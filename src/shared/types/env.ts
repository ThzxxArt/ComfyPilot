/** Shared environment probe / creation types. */
import type { TorchChannel } from './installer'

// ---------- Environment ----------
export interface EnvProbe {
  pythonPath: string
  pythonVersion: string
  venvPath?: string
  torchVersion?: string
  cudaVersion?: string
  rocmVersion?: string
  mpsAvailable?: boolean
  npuAvailable?: boolean
  packages: Array<{ name: string; version: string }>
  /**
   * pip availability inside this interpreter (0.1.12). Probed, not guessed —
   * `present:false` means `python -m pip` fails ("No module named pip").
   */
  pip?: { present: boolean; version?: string }
  ok: boolean
  errors: string[]
}

/** One optional attention package after an in-venv self-test (0.2.6). */
export interface AttentionSelfTestPackage {
  installed: boolean
  version?: string
  ok: boolean
  error?: string
}

/** Fixed-script SageAttention / xFormers probe result (0.2.6). */
export interface AttentionSelfTestResult {
  ok: boolean
  testedAt: number
  pythonVersion?: string
  torchVersion?: string
  cudaVersion?: string
  gpuName?: string
  computeCapability?: string
  cudaAvailable: boolean
  sageattention: AttentionSelfTestPackage
  xformers: AttentionSelfTestPackage
  error?: string
}

export interface EnvCreateRequest {
  basePath: string
  pythonPath: string
  useUv: boolean
  torchIndex?: string
  name: string
}

export interface RepairEnvOptions {
  torchChannel?: TorchChannel
  /** Force recreate the venv even when one exists. */
  recreateVenv?: boolean
}
