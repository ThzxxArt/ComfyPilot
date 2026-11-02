/** Shared instance types: configuration, launch, capabilities, load reports. */

// ---------- Instance ----------
export type InstanceStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error'
  | 'unknown'
  /** 0.2.0: the instance's venv is not Python 3.13 and must be migrated. */
  | 'migration-required'
  | 'migration-failed'

export interface LaunchArgTemplate {
  id: string
  name: string
  args: string[]
  description: string
}

/**
 * Structured ComfyUI launch tuning (0.1.9). Every field maps to well-known
 * `comfy/cli_args.py` flags; the renderer edits this object, the main process
 * renders it to argv via `@shared/launchArgs`. Free-text `extraArgs` stays as
 * the escape hatch appended last.
 */
export interface LaunchProfile {
  vram?: 'default' | 'gpu-only' | 'highvram' | 'lowvram' | 'novram' | 'cpu'
  /** --reserve-vram (GB) */
  reserveVram?: number
  /** --vram-headroom (GB) */
  vramHeadroom?: number
  cache?: 'default' | 'classic' | 'lru' | 'none' | 'high-ram'
  /** --cache-lru N */
  cacheLru?: number
  previewMethod?: 'none' | 'auto' | 'latent2rgb' | 'taesd'
  previewSize?: number
  attention?: 'default' | 'split' | 'quad' | 'pytorch' | 'sage' | 'flash' | 'ck'
  disableXformers?: boolean
  attentionUpcast?: 'default' | 'force' | 'disable'
  unetPrecision?:
    'default' | 'fp32' | 'fp64' | 'bf16' | 'fp16' | 'fp8_e4m3fn' | 'fp8_e5m2' | 'fp8_e8m0fnu'
  vaePrecision?: 'default' | 'fp16' | 'fp32' | 'bf16'
  textEncoderPrecision?: 'default' | 'fp8_e4m3fn' | 'fp8_e5m2' | 'fp16' | 'fp32' | 'bf16'
  asyncOffload?: 'default' | 'on' | 'off'
  fastDisk?: boolean
  disablePinnedMemory?: boolean
  mmapTorchFiles?: boolean
  disableCudaGraphs?: boolean
  disableSmartMemory?: boolean
  /** --enable-cors-header [ORIGIN]; '*' emits the bare flag. */
  corsHeader?: string
  /** --max-upload-size (MB) */
  maxUploadSize?: number
  multiUser?: boolean
  offline?: boolean
  /** --disable-auto-launch — recommended: ComfyPilot opens the window itself. */
  disableAutoLaunch?: boolean
  verbose?: boolean
  // ---------- 0.1.10: base directories + device + runtime toggles ----------
  /** --base-directory: share one source tree while keeping user/output separate. */
  baseDirectory?: string
  /** --user-directory: per-instance user dir (settings/workflows/db). */
  userDirectory?: string
  /** --models-directory: relocate the models root. */
  modelsDirectory?: string
  /** --default-device N: preferred CUDA device index in multi-GPU hosts. */
  defaultDevice?: number
  /** --enable-triton-backend / --disable-triton-backend. */
  tritonBackend?: 'default' | 'on' | 'off'
  /** --disable-nvml-pressure (DynamicVRAM falls back to CUDA pressure checks). */
  disableNvmlPressure?: boolean
  /** --enable-assets / --disable-assets (assets DB, default off upstream). */
  assets?: boolean
  /** --enable-asset-hashing (content hashing for the assets DB). */
  assetHashing?: boolean
  // ---------- 0.1.14: storage directories (output/input/temp/previews) ----------
  /** --output-directory: relocate generated outputs. */
  outputDirectory?: string
  /** --input-directory: relocate uploaded inputs. */
  inputDirectory?: string
  /** --temp-directory: relocate the scratch area (large intermediates). */
  tempDirectory?: string
  /** --previews-directory: assets-system preview storage (ComfyUI 0.40+). */
  previewsDirectory?: string
}

export interface ComfyInstanceConfig {
  id: string
  name: string
  path: string
  pythonPath: string
  venvPath: string
  port: number
  listen: string
  extraArgs: string[]
  argTemplateId: string
  enabled: boolean
  notes: string
  autoStart: boolean
  frontendVersion: string
  /** Pinned instances sort first in lists */
  pinned: boolean
  /** Structured launch tuning (0.1.9) — absent for pre-0.1.9 records. */
  launchProfile?: LaunchProfile
  /** 0.2.0: Python version detected for the resolved interpreter (e.g. 3.13.18). */
  pythonVersion?: string
  /** 0.2.0: one-way migration state; 3.12 instances cannot start until migrated. */
  migrationState?: 'none' | 'required' | 'migrating' | 'failed'
  migrationError?: string
}

export interface ComfyInstanceInfo extends ComfyInstanceConfig {
  status: InstanceStatus
  pid?: number
  version?: string
  /** Real version reported by the running instance (/system_stats), when known. */
  onlineVersion?: string
  managerEnabled?: boolean
  url?: string
  startedAt?: number
  uptimeMs?: number
  lastError?: string
  /**
   * 0.1.17 (WP3): classified reason for the last unexpected exit. Absent when
   * the process is alive or was stopped on purpose.
   */
  lastExit?: {
    kind: 'oom' | 'port' | 'dependency' | 'driver' | 'cancelled' | 'unknown'
    code: number | null
    signal: string | null
    hint: string
    at: number
  }
}

/**
 * Cross-view operation target (0.1.18 WP2).
 *
 * `none` means no local instance is selected; destructive local channels
 * refuse it with `TARGET_REQUIRED` instead of silently using `instances[0]`.
 */
export interface TargetRef {
  kind: 'local' | 'remote' | 'none'
  id?: string
}

export interface InstanceDiscoveryCandidate {
  path: string
  score: number
  reason: string
  hasMainPy: boolean
  hasRequirements: boolean
  hasVenv: boolean
  estimatedVersion?: string
  /** Already registered as a configured instance */
  registered?: boolean
}

export interface PortCheckResult {
  port: number
  available: boolean
  owner?: string
}

/** Resolved spawn command for an instance — used by the UI preview + copy. */
export interface LaunchCommandPreview {
  python: string
  args: string[]
  cwd: string
  commandLine: string
  /** argparse-fatal conflicts detected in the final argv (0.1.9). */
  validationErrors?: Array<{ code: string; flag?: string }>
  /** Non-blocking advisories (unknown/recent flags) (0.1.9). */
  validationWarnings?: Array<{ code: string; flag: string; level: 'info' | 'warning' }>
}

export interface LaunchOptions {
  /** After the instance is ready, where to take the user. Default 'none'. */
  open?: 'embed' | 'browser' | 'none'
  /** When the configured port is busy, pick a free port, persist it, then start. */
  relocatePort?: boolean
  /**
   * 0.1.18 (WP3): allow adopting a ComfyUI this app did not start. The first
   * attempt without it fails with ADOPT_CONFIRM_REQUIRED so the UI can ask.
   */
  adoptExternal?: boolean
}

export interface WaitReadyResult {
  ready: boolean
  info: ComfyInstanceInfo
  error?: string
  elapsedMs: number
}

// ---------- Instance capabilities (0.1.10) ----------
/**
 * Runtime-probed facts about a RUNNING ComfyUI instance. Kept deliberately
 * factual: fields are only set when the server actually reported them.
 */
export interface InstanceCapabilities {
  instanceId: string
  baseUrl: string
  online: boolean
  /** system.comfyui_version */
  version?: string
  requiredFrontendVersion?: string
  installedTemplatesVersion?: string
  requiredTemplatesVersion?: string
  pythonVersion?: string
  pytorchVersion?: string
  embeddedPython?: boolean
  deployEnvironment?: string
  /** Launch argv exactly as the server reported it. */
  argv: string[]
  /** comfy_package_versions[] (name/installed/required). */
  packages: Array<{ name: string; installed: string; required: string }>
  /** /features feature-flag map (shape tolerated). */
  features: Record<string, unknown>
  /** /api/jobs answered a probe request (probed, not version-guessed). */
  jobsApi: boolean
  /** /api/assets answered a probe request (0.1.14; assets system, 0.40+). */
  assetsApi: boolean
  /** workflow_metadata is only sent on builds known to support it (0.39.0+). */
  workflowMetadata: boolean
  error?: string
  probedAt: number
}

// ---------- Node load report (0.1.10) ----------
/** One custom-node import entry parsed from the boot log block. */
export interface NodeLoadEntry {
  /** Absolute module path as printed by ComfyUI. */
  modulePath: string
  /** Directory basename (`.disabled` stripped) — matches on-disk pack folders. */
  folder: string
  seconds: number
  ok: boolean
  prestartup: boolean
  /** First traceback / error line related to this module, when parseable. */
  error?: string
}

export interface NodeLoadReport {
  /** False when no "Import times" block exists in the available logs. */
  available: boolean
  entries: NodeLoadEntry[]
  /**
   * Packs refused by ComfyUI's signed governance policy (0.1.14). These never
   * reach the Import-times block — `nodes.py` skips them before loading — and
   * only leave a warning line in the boot log.
   */
  policyRefused?: Array<{ folder: string; reason: 'policy' | 'manager' }>
  /** When the block was observed (log line ts), for staleness hints. */
  observedAt?: number
}

// ---------- Model reconciliation (0.1.10) ----------
export interface ModelReconcileFolder {
  /** Canonical folder type (legacy clip/unet already mapped). */
  folder: string
  /** Absolute search paths the instance actually uses for this folder. */
  instanceFolders: string[]
  extensions: string[]
  /** Names visible to the instance but absent from the local index (unscanned). */
  missingLocally: string[]
  /** Local index entries the instance cannot see (dir not indexed / not found). */
  extraLocally: string[]
  /** Local entries whose extension the instance does not list for this folder. */
  formatHidden: string[]
  error?: string
}

export interface ModelReconcileResult {
  ok: boolean
  /** Which endpoint answered: experiment (richer) → legacy → none. */
  source: 'experiment' | 'legacy' | 'none'
  error?: string
  folders: ModelReconcileFolder[]
  /** Instance search paths not covered by the app's scan roots (offer to add). */
  uncoveredRoots: string[]
}

/** Result of startAll/stopAll — per-instance outcome so the UI can summarize. */
export interface InstanceActionResult extends ComfyInstanceInfo {
  ok: boolean
  error?: string
  /**
   * 0.1.17 (review fix): stopAll surfaces whether each process actually exited;
   * `false` means it may still be running and must not be counted as stopped.
   */
  exited?: boolean
}

/** stop/forceKill result — `adopted` marks an external process we only signalled. */
export interface InstanceStopResult extends ComfyInstanceInfo {
  adopted?: boolean
  /**
   * 0.1.17 (WP3): whether the process was observed to exit inside the grace
   * window. `false` means it may still be running — the UI must say so.
   */
  exited?: boolean
}

export interface DiagnosticPackage {
  path: string
  createdAt: number
  size: number
  contents: string[]
}
