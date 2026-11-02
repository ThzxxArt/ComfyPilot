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
