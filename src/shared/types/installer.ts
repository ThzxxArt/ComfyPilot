/** Shared installer / runtime bootstrap / ComfyUI update types. */
import type { ModelCategory } from './model'

// ---------- Installer (one-click isolated setup) ----------
export type InstallStepId =
  | 'bootstrap'
  | 'preflight'
  | 'python'
  | 'venv'
  | 'comfyui'
  | 'torch'
  | 'requirements'
  | 'register'
  | 'starter'
  | 'done'

export type InstallStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  /**
   * 0.1.17 (WP1): a run that was `running` when the app died is not running any
   * more — persisted runs are relabelled on load so the UI cannot deadlock on a
   * ghost run.
   */
  | 'interrupted'

export interface InstallStep {
  id: InstallStepId
  title: string
  status: InstallStepStatus
  detail: string
  log: string[]
  /** i18n key for UI display of detail (renderer translates). */
  detailKey?: string
  detailParams?: Record<string, string | number>
}

export type TorchChannel = 'cu130' | 'cu126' | 'rocm' | 'xpu' | 'mps' | 'cpu'

export interface InstallPlan {
  installRoot: string
  instanceName: string
  useUv: boolean
  pythonPath: string
  torchChannel: TorchChannel
  comfyRepo: string
  comfyBranch: string
  createDesktopShortcut: boolean
  autoStart: boolean
  /** 'zip' downloads a GitHub archive (no Git needed). 'git' uses git clone. */
  comfySource?: 'zip' | 'git'
  /** Skip the post-install starter-model step. */
  skipStarter?: boolean
  /** One-click mode: use defaults for everything not explicitly set. */
  fullAuto?: boolean
}

export interface InstallStepByteProgress {
  /** Bytes transferred in the current sub-download (torch wheel, archive, etc.) */
  receivedBytes: number
  totalBytes: number
  speedBps: number
  label: string
}

export interface InstallProgress {
  runId: string
  step: InstallStepId
  status: InstallStepStatus
  steps: InstallStep[]
  message: string
  percent: number
  error?: string
  /** Set once register step completes — authoritative instance id for this run. */
  instanceId?: string
  /** Fine-grained download progress inside the active step, when applicable. */
  bytes?: InstallStepByteProgress
}

export interface GpuCapability {
  vendor: string
  model: string
  recommendedTorch: TorchChannel
  notes: string
  /** i18n key for UI (renderer translates); notes is a log-only English fallback. */
  notesKey?: string
  notesParams?: Record<string, string | number>
}

// ---------- Runtime bootstrap (zero-prerequisite) ----------
export type RuntimeKind = 'uv' | 'python' | 'mingit' | 'aria2'

export interface RuntimeComponentStatus {
  kind: RuntimeKind
  /** Absolute path to the executable once installed. */
  path: string
  installed: boolean
  version?: string
  /** Source used: system PATH vs downloaded into userData/runtimes. */
  origin: 'system' | 'runtimes' | 'missing'
  /** Legacy Python found but not usable by 0.2.0 (archived, never resolved). */
  legacyVersion?: string
}

export interface BootstrapStatus {
  runtimesDir: string
  components: RuntimeComponentStatus[]
  /** Best resolved python for creating venvs (system or portable). */
  pythonPath: string
  pythonOrigin: RuntimeComponentStatus['origin']
  /** 0.2.0: exactly one supported Python runtime. */
  pythonVersion: string
  supportedPython: '3.13'
  legacyPython?: string
  /** True when zip-based ComfyUI fetch is available (no Git needed). */
  zipInstallReady: boolean
}

export interface RuntimeDownloadProgress {
  kind: RuntimeKind
  receivedBytes: number
  totalBytes: number
  speedBps: number
  phase: 'download' | 'extract' | 'done' | 'error'
  message?: string
}

// ---------- Starter models (post-install guided download) ----------
export interface StarterModel {
  id: string
  name: string
  description: string
  /** Direct or HF/Civitai URL — model.download handles expansion. */
  url: string
  category: ModelCategory
  approxBytes: number
  /** Human label e.g. "SD 1.5" / "SDXL" / "Flux.1-schnell" */
  family: string
  recommended?: boolean
}

// ---------- ComfyUI update (0.1.4) ----------
export interface ComfyUpdateInfo {
  instanceId: string
  /** Local version / commit currently installed. */
  current: string
  /** Remote latest version / commit when discoverable. */
  latest?: string
  source: 'git' | 'zip' | 'unknown'
  updatable: boolean
  /**
   * The check could not determine freshness (offline / API error). UI must not
   * render `updatable: false` as "up to date" in this case (0.1.17).
   */
  unknown?: boolean
  /** Commits behind upstream (git installs only). */
  behindCount?: number
  /** Short sha of remote head (git installs only). */
  latestCommit?: string
  /**
   * Latest official GitHub RELEASE (0.1.14) — informational only. ComfyUI
   * ships weekly releases (v0.40.0 …) while zip installs track master, so
   * "master is X commits ahead of the last release" is the honest framing.
   */
  latestRelease?: { tag: string; publishedAt?: string }
  checkedAt: number
  error?: string
}

export type UpdateStepId =
  | 'preflight'
  | 'venv'
  | 'stop'
  | 'backup'
  | 'fetch'
  | 'download'
  | 'clone'
  | 'unpack'
  | 'requirements'
  | 'torch'
  | 'verify'
  | 'rollback'
  | 'done'

export interface UpdateStep {
  id: UpdateStepId
  title: string
  status: InstallStepStatus
  detail: string
  log: string[]
  detailKey?: string
  detailParams?: Record<string, string | number>
  /**
   * 0..1 progress within the step. Only set when the tool reports a REAL
   * fraction (git object %). pip output has no total, so its step stays
   * indeterminate (0.1.17 WP2-4 removed the invented line-count fraction).
   */
  progress?: number
  /**
   * 0.1.18 (WP3): monotonic item counts for work measured in files/entries
   * (zip overlay, core copy). `workTotal=0` means "not measured" — never a
   * fake denominator. Real `0` is a valid value.
   */
  workDone?: number
  workTotal?: number
}

export interface UpdateProgress {
  runId: string
  instanceId: string
  step: UpdateStepId
  status: InstallStepStatus
  steps: UpdateStep[]
  message: string
  percent: number
  error?: string
  /** 0.1.18 (WP2): machine-readable failure cause (e.g. PORT_IN_USE). */
  errorCode?: string
  /** Absolute path of the backup dir when the backup step completed. */
  backupPath?: string
  bytes?: InstallStepByteProgress
  /** 0.1.9: pack context so batch updates can label the running pack. */
  packName?: string
  batchIndex?: number
  batchTotal?: number
  /** Overall percent across ALL packs in the running batch (monotonic). */
  aggregatePercent?: number
}

export interface ComfyUpdateOptions {
  /** Also reinstall requirements.txt after the source update. Default true. */
  updateDeps?: boolean
  /** Optionally reinstall torch with a (new) channel. */
  torchChannel?: TorchChannel
  /** Open embed/browser after a successful update+optional restart. */
  open?: 'embed' | 'browser' | 'none'
}

/**
 * On-disk record of an update that started but did not finish (0.1.17 WP4).
 * Written next to the ComfyUI dir; deleted on success or a completed rollback.
 */
export interface UpdateJournal {
  instanceId: string
  comfyDir: string
  backupPath: string
  backupKind: 'git' | 'files'
  startedAt: number
  /**
   * 0.1.18 (WP3): `verify-failed` keeps the journal (and therefore the UI's
   * rollback entry) after a health-check failure. The backup survived but the
   * journal used to be cleared, so the only recovery point became invisible.
   */
  status?: 'in-progress' | 'verify-failed'
}
