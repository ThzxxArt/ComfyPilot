/** Shared domain types between main / preload / renderer — full PLAN coverage */
import type { PipRecipe } from './pipRecipes'
import type { OutputType } from './mediaTypes'

// ---------- App ----------
export type AppLocale = 'zh-CN' | 'en-US'

/** Manual app self-update check (0.1.11 — makes the auto-update channel visible). */
export interface AppUpdateStatus {
  /** unsupported = dev build / updater unavailable. */
  status:
    | 'unsupported'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'not-available'
    | 'error'
  currentVersion: string
  /** Version offered by the update server, when available. */
  availableVersion?: string
  /** Live download progress (present while `downloading`, 0.1.13). */
  progress?: {
    percent: number
    bytesPerSecond?: number
    transferred?: number
    total?: number
  }
  error?: string
  checkedAt: number
}

/**
 * Previous-session exit facts (0.1.16).
 * Written to `<logsDir>/session.json` on start / clean exit so the next launch
 * can tell the user "last run did not exit cleanly" and offer a diagnostics
 * export — the app previously had no way to prove how it had ended.
 */
export interface PreviousExitInfo {
  /** True when the previous session wrote a clean-exit marker. */
  clean: boolean
  /** Epoch ms of the previous session's start (null on first run). */
  startedAt: number | null
  /** Epoch ms of the clean exit (null when the session ended uncleanly). */
  endedAt: number | null
  /** Optional last recorded reason (e.g. an uncaught-exception summary). */
  detail?: string
}

/** A single custom-node pack that failed to import at boot (0.1.16). */
export interface InstanceStartupIssue {
  /** Custom-node pack folder name, or 'unknown'. */
  pack: string
  /** Human-readable failure summary (verbatim from the log, trimmed). */
  summary: string
  /** Missing import names parsed from the log (best effort, may be empty). */
  missingModules: string[]
}

/** Startup issues surfaced after an instance boots (0.1.16). */
export interface InstanceStartupIssues {
  instanceId: string
  /** True when at least one pack failed to import. */
  hasIssues: boolean
  issues: InstanceStartupIssue[]
  scannedAt: number
}

export type ProxyProtocol = 'http' | 'https' | 'socks5'

export interface ProxySettings {
  enabled: boolean
  protocol: ProxyProtocol
  host: string
  port: number
  username: string
  password: string
  /** Comma/space separated hosts that bypass proxy (localhost always bypassed) */
  bypass: string
}

export interface AppSettings {
  locale: AppLocale
  modelScanRoots: string[]
  githubEndpoint: string
  hfEndpoint: string
  civitaiEndpoint: string
  enableAutoCheckUpdates: boolean
  embedFrontend: boolean
  securityLevel: 'strong' | 'normal' | 'normal-' | 'weak'
  allowGitUrlInstall: boolean
  allowPipInstall: boolean
  networkMode: 'public' | 'private' | 'offline' | 'personal_cloud'
  aria2Path: string
  useAria2: boolean
  /** Start ComfyPilot at OS login */
  launchOnBoot: boolean
  /** Closing the window hides to tray instead of quitting */
  minimizeToTray: boolean
  /** On app ready, start every instance whose autoStart is true */
  autoStartInstancesOnLaunch: boolean
  proxy: ProxySettings
  /** PyPI index URL for pip/uv installs (empty = official). e.g. https://pypi.tuna.tsinghua.edu.cn/simple */
  pipIndex: string
  /** Optional torch wheel index override (empty = download.pytorch.org per channel) */
  torchIndexMirror: string
  /** Output-library scan depth under the output root (0.1.9, default 4, 2..10). */
  outputScanDepth: number
}

// ---------- Instance ----------
export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'error' | 'unknown'

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

// ---------- Model ----------
/**
 * Canonical category set = ComfyUI's registered model folders (folder_paths.py)
 * minus non-model internals. `clip` / `unet` are legacy aliases kept readable
 * for old DB records only — scan() now maps them to text_encoders / diffusion_models.
 */
export type ModelCategory =
  | 'checkpoints'
  | 'diffusion_models'
  | 'loras'
  | 'vae'
  | 'text_encoders'
  | 'clip_vision'
  | 'controlnet'
  | 'upscale_models'
  | 'embeddings'
  | 'style_models'
  | 'diffusers'
  | 'vae_approx'
  | 'gligen'
  | 'latent_upscale_models'
  | 'photomaker'
  | 'classifiers'
  | 'model_patches'
  | 'audio_encoders'
  | 'hypernetworks'
  | 'background_removal'
  | 'frame_interpolation'
  | 'geometry_estimation'
  | 'optical_flow'
  | 'detection'
  // Legacy aliases (pre-0.1.8 records only)
  | 'clip'
  | 'unet'
  | 'other'

export interface ModelRecord {
  id: string
  name: string
  fileName: string
  category: ModelCategory
  path: string
  size: number
  hashSha256?: string
  modifiedAt: number
  architecture?: string
  source: 'local' | 'civitai' | 'huggingface' | 'imported'
  thumbnail?: string
  tags: string[]
  metadata: Record<string, unknown>
  baseModel?: string
  trainedWords: string[]
  duplicateOf?: string
  pathRoot: string
}

export interface ModelScanProgress {
  scanned: number
  total: number
  currentPath: string
  phase: 'walk' | 'hash' | 'meta' | 'done'
}

export interface DownloadTask {
  id: string
  url: string
  destPath: string
  fileName: string
  totalBytes: number
  receivedBytes: number
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  error?: string
  startedAt: number
  finishedAt?: number
  speedBps?: number
  resumedFrom?: number
  source: 'huggingface' | 'civitai' | 'direct'
  /** Expected SHA256 from remote manifest (if provided) — verified on completion. */
  expectedSha256?: string
  /** Computed SHA256 after a successful download (when verification ran). */
  actualSha256?: string
  /** 'length' = Content-Length match only; 'sha256' = hash verified. */
  verified?: 'length' | 'sha256' | 'failed'
}

export interface StorageStats {
  category: ModelCategory | 'total'
  count: number
  bytes: number
}

export interface DuplicateGroup {
  hash: string
  size: number
  files: string[]
}

// ---------- Node Pack ----------
export type NodePackStatus =
  'installed' | 'update-available' | 'disabled' | 'error' | 'not-installed' | 'installing'

export interface NodePackRecord {
  id: string
  name: string
  displayName: string
  description: string
  author: string
  version: string
  latestVersion?: string
  status: NodePackStatus
  path?: string
  repository?: string
  registryId?: string
  nodeCount: number
  tags: string[]
  pythonCompatible?: string
  installSource: 'local' | 'registry' | 'manager' | 'git'
  lastCheckedAt?: number
  issues: NodePackIssue[]
  locked: boolean
  nodeList: string[]
  license?: string
  icon?: string
  /** Free-form user note kept across update / reinstall. */
  notes?: string
  /** PEP 503 package names parsed from requirements.txt at install time. */
  pipRequirements?: string[]
  /** Version explicitly requested at install time — wins over on-disk meta. */
  pinnedVersion?: string
  /**
   * Honest note when the requested version could not be applied (0.1.17).
   * The record then keeps the on-disk `version` and does NOT set
   * `pinnedVersion`, so the UI can show what actually landed.
   */
  installNote?: string
  /** Git HEAD sha recorded at install/snapshot time (git-managed packs). */
  gitRev?: string
}

export interface NodePackIssue {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  suggestion?: string
  fixable: boolean
  fixId?: string
}

export interface RegistryNodePack {
  id: string
  name: string
  displayName: string
  description: string
  author: string
  latestVersion: string
  repository: string
  tags: string[]
  downloads: number
  score: number
  icon?: string
  status?: 'active' | 'flagged' | 'banned'
}

export interface NodeSnapshot {
  id: string
  name: string
  createdAt: number
  packs: Array<{ name: string; version: string; path: string; source: string; gitRev?: string }>
  notes: string
  /** Instance this snapshot was taken against. */
  instanceId?: string
}

export interface NodeNameConflict {
  nodeName: string
  packs: string[]
}

// ---------- Workflow ----------
/** Where a workflow file physically lives. */
export type WorkflowOrigin = 'library' | 'instance' | 'external'

export interface WorkflowRecord {
  id: string
  name: string
  path: string
  format: 'json' | 'png' | 'embed'
  nodeCount: number
  tags: string[]
  description?: string
  updatedAt: number
  thumbnail?: string
  missingNodes: string[]
  version: string
  seed?: number
  modelUsed?: string
  params: Record<string, unknown>
  /** library = ComfyPilot workflow library; instance = ComfyUI user workflows; external = scanned elsewhere */
  origin: WorkflowOrigin
  /** Original path before import-copy (library records only) */
  sourcePath?: string
  /** Set when the file is no longer on disk */
  missing?: boolean
  favorite?: boolean
  importedAt?: number
  /** Transient content fingerprint (computed on workflow.list, never persisted). */
  contentHash?: string
}

/** Side-by-side comparison of two workflow records (0.1.11). */
export interface WorkflowCompareDiff {
  /** Field label key (stable machine id; renderer maps to i18n). */
  field: string
  a: string
  b: string
  /** True when the values differ. */
  changed: boolean
}

export interface WorkflowCompareResult {
  a: { id: string; name: string }
  b: { id: string; name: string }
  diffs: WorkflowCompareDiff[]
  /** Node-class types only present in A / only in B. */
  nodesOnlyA: string[]
  nodesOnlyB: string[]
  missingNodes: string[]
}

// ---------- Monitor ----------
export interface GpuInfo {
  index: number
  model: string
  vendor: string
  vramTotal: number
  vramUsed: number
  utilization: number
  temperature?: number
  powerDraw?: number
  /** Windows GPU Adapter Memory "Shared Usage" — system RAM shared with the GPU (0.1.11). */
  sharedUsed?: number
  /** Windows GPU Adapter Memory "Shared Limit" (0.1.11). */
  sharedTotal?: number
}

export interface SystemSnapshot {
  cpuUsage: number
  ramTotal: number
  ramUsed: number
  diskFree: number
  diskTotal: number
  gpus: GpuInfo[]
  timestamp: number
}

export interface QueueItem {
  promptId: string
  nodeId?: string
  progress?: number
  status: 'running' | 'pending' | 'done' | 'error'
}

export interface QueueSnapshot {
  running: QueueItem[]
  pending: QueueItem[]
  doneCount: number
  history: Array<{ promptId: string; status: string; completedAt?: number }>
}

/** Normalized /api/jobs list entry (ComfyUI 0.39+). */
export interface ComfyJobSummary {
  id: string
  status: string
  workflowId?: string
  createdAt?: number
}

export interface ComfyLogLine {
  ts: number
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source?: string
}

/** Per-node execution progress from the `progress_state` WS event (0.39+). */
export interface ExecNodeProgress {
  nodeId: string
  value: number
  max: number
  /** pending | running | finished | error */
  state: string
  promptId?: string
  displayNodeId?: string
}

export interface ExecProgressEvent {
  type:
    | 'progress'
    | 'executing'
    | 'executed'
    | 'status'
    | 'execution_error'
    | 'preview'
    | 'progress_state'
    | 'execution_start'
    | 'execution_success'
    | 'execution_interrupted'
    | 'execution_cached'
  nodeId?: string
  value?: number
  max?: number
  promptId?: string
  /** Preview frame as a data: URL (both legacy and metadata frame formats). */
  image?: string
  text?: string
  /** progress_state payload: nodeId → progress. */
  nodes?: Record<string, ExecNodeProgress>
  /** execution_cached payload. */
  cachedNodes?: string[]
  // ---------- execution_error payload pass-through (0.1.12) ----------
  /** Class type of the failing node (ComfyUI `node_type`). */
  nodeType?: string
  /** exception_type from the WS payload, e.g. ModuleNotFoundError. */
  errorType?: string
  /** exception_message from the WS payload. */
  errorMessage?: string
  /** Bounded traceback tail from the WS payload. */
  errorTraceback?: string[]
  /** Main-process routing only: which base URL produced this event. */
  baseUrl?: string
}

// ---------- Execution failure diagnosis (0.1.12) ----------
/** One recorded runtime failure — WS payload (ComfyPilot submissions) or log-parsed. */
export interface ExecFailure {
  id: string
  instanceId: string
  source: 'ws' | 'log'
  at: number
  promptId?: string
  nodeId?: string
  nodeType?: string
  errorType: string
  message: string
  missingModule?: string
  /** custom_nodes folder the failing file belongs to (pack attribution). */
  packFolder?: string
  traceback?: string[]
}

/** Result of a pip/recipe install op (0.1.12). */
export interface PipOpResult {
  ok: boolean
  instanceId: string
  /** Requested specs / recipe id (for the result summary). */
  requested: string[]
  /** Package names verified installed afterwards (pip show). */
  installed: string[]
  cancelled?: boolean
  error?: string
  /** Non-fatal caveat (e.g. installed but not listed by pip show). */
  warning?: string
}

/** Per-pack dependency audit entry (0.1.12). */
export interface NodeDepsAuditPack {
  id: string
  name: string
  declared: string[]
  missing: string[]
  mismatched: Array<{ name: string; required: string; installed: string }>
}

/** Node-pack dependency audit result (requirements.txt vs venv pip list). */
export interface NodeDepsAudit {
  ok: boolean
  pipAvailable: boolean
  checkedPacks: number
  packs: NodeDepsAuditPack[]
  error?: string
}

/** Workflow preflight against /object_info (0.1.12, WP6). */
export interface WorkflowPreflight {
  /** False when object_info could not be fetched (offline/old server). */
  available: boolean
  missingTypes: string[]
  nodeTypes: number
  error?: string
}

/** Batch preflight across multiple workflow files. */
export interface BatchPreflight {
  available: boolean
  missingTypes: string[]
  perWorkflow: Array<{ workflowPath: string; name: string; missingTypes: string[]; error?: string }>
  error?: string
}

export interface OutputAsset {
  id: string
  path: string
  fileName: string
  /** Classified via `@shared/mediaTypes::classifyOutputType` (0.1.14: adds '3d'). */
  type: OutputType
  size: number
  createdAt: number
  width?: number
  height?: number
  workflowId?: string
  workflowName?: string
  batchJobId?: string
  promptId?: string
  seed?: number
  favorite?: boolean
  params: Record<string, unknown>
  thumbnail?: string
  /** Full-resolution safe media URL for lightbox/detail (never a bare fs path). */
  mediaUrl?: string
}

/**
 * Read-only mirror of one ComfyUI assets-system record matching an output
 * (0.1.14). Produced on demand by `output.assetsMatch`; never persisted.
 */
export interface OutputAssetMatch {
  id: string
  name: string
  loaderPath?: string
  /** Prompt id this record was created for (assets `job_id`). */
  jobId?: string
  /** Workflow attribution resolved through the local prompt-links sidecar. */
  workflowId?: string
  workflowName?: string
  tags: string[]
  /** Absolute URL of the server-side preview (EXR etc.), when offered. */
  previewUrl?: string
  size?: number
  createdAt?: string
}

// ---------- Doctor ----------
export type DoctorSeverity = 'pass' | 'warn' | 'fail' | 'info'

export interface DoctorCheck {
  id: string
  group: string
  title: string
  severity: DoctorSeverity
  detail: string
  suggestion?: string
  fixable: boolean
  fixId?: string
}

export interface DoctorReport {
  id: string
  instanceId: string
  createdAt: number
  durationMs: number
  checks: DoctorCheck[]
  summary: { pass: number; warn: number; fail: number; info: number }
}

// ---------- Backup ----------
export interface BackupManifest {
  id: string
  name: string
  createdAt: number
  path: string
  size: number
  includes: {
    settings: boolean
    instances: boolean
    nodePacks: boolean
    modelManifest: boolean
    workflows: boolean
    workflowFiles?: boolean
    nodeSnapshots?: boolean
  }
  notes: string
}

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

// ---------- Batch ----------
export type BatchJobStatus =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  /**
   * 0.1.17 (WP5): persisted as submitting/running but no run is alive (app
   * exited). Resume submits only the legs that never completed.
   */
  | 'interrupted'
export type SeedMode = 'random' | 'increment' | 'fixed'

/** One workflow leg inside a multi-workflow batch job. */
export interface BatchJobItem {
  workflowId?: string
  workflowName: string
  workflowPath: string
  count: number
  submitted: number
  completed: number
  /** Total failures = submitFailed + execFailed (kept for display compat). */
  failed: number
  /** Prompts never accepted by ComfyUI (queue refused / build error). */
  submitFailed: number
  /** Prompts accepted but failed during execution. */
  execFailed: number
  promptIds: string[]
  seeds: number[]
  /** Absolute output file paths linked after generation. */
  outputPaths: string[]
  /** Per-item cancel — skip remaining submits and dequeue pending prompts. */
  cancelled?: boolean
}

export interface BatchParamOverrides {
  seedMode?: SeedMode
  baseSeed?: number
  width?: number
  height?: number
  steps?: number
  cfg?: number
}

export interface BatchJob {
  id: string
  name: string
  instanceId: string
  /** Multi-workflow legs. Legacy single-path jobs migrate into items[0]. */
  items: BatchJobItem[]
  status: BatchJobStatus
  /** Sum of item counts — total prompts this job should submit. */
  count: number
  /** Prompts successfully handed to ComfyUI (sum of item.submitted). */
  submitted: number
  /** Prompts that settled successfully (sum of item.completed). */
  completed: number
  /** Submit + exec failures (sum of item.failed). */
  failed: number
  /** Prompts never accepted by ComfyUI. */
  submitFailed: number
  /** Prompts accepted but failed during execution. */
  execFailed: number
  /**
   * Output FILES actually linked from history (unique paths pushed to
   * item.outputPaths). A prompt that settled "success" but whose files were
   * missing on disk counts as produced=0, never as a success-image.
   */
  produced: number
  createdAt: number
  finishedAt?: number
  notes: string
  /** Concise failure summary (first errors / timeouts) for the UI card. */
  errorSummary?: string
  params: BatchParamOverrides
  /** 0.1.17 (WP5): identity + start time of the run that produced this state. */
  runId?: string
  startedAt?: number
  /** Display path of the primary workflow (items[0]). */
  workflowPath: string
}

// ---------- Remote ----------
export interface RemoteInstanceConfig {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  label: string
  enabled: boolean
  /**
   * 0.1.17 (review fix): the stored API key could not be decrypted on this
   * machine (profile moved / keychain unavailable). The UI should ask for it
   * again; saving an empty key keeps the ciphertext instead of erasing it.
   */
  apiKeyLocked?: boolean
}

export interface RemoteInstanceStatus {
  id: string
  online: boolean
  version?: string
  queueRunning: number
  queuePending: number
  error?: string
}

// ---------- Plugin Market ----------
export interface MarketItem {
  id: string
  name: string
  displayName: string
  description: string
  author: string
  version: string
  category: string
  tags: string[]
  downloads: number
  stars: number
  installed: boolean
  repository: string
  icon?: string
  rating: number
}

/** Paged registry/market result. API has no server-side search — query is filtered after fetch. */
export interface RegistryPageResult<T> {
  items: T[]
  /** total registry size when browsing; matched count when searching */
  total: number
  page: number
  pageSize: number
  totalPages: number
  /** how many remote items were scanned to produce this page (search mode) */
  scanned: number
  /** true when the query had to be applied client-side */
  clientFiltered: boolean
}

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

export type TorchChannel = 'cu130' | 'cu126' | 'cu124' | 'rocm' | 'xpu' | 'mps' | 'cpu'

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
}

export interface BootstrapStatus {
  runtimesDir: string
  components: RuntimeComponentStatus[]
  /** Best resolved python for creating venvs (system or portable). */
  pythonPath: string
  pythonOrigin: RuntimeComponentStatus['origin']
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

// ---------- Node install progress ----------

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
}

export interface RepairEnvOptions {
  torchChannel?: TorchChannel
  /** Force recreate the venv even when one exists. */
  recreateVenv?: boolean
}

// ---------- Node update checking ----------
/**
 * Explicit outcome of a check. 0.1.9: every installed pack gets a row — a
 * failed check must never masquerade as "up to date" or "unsupported".
 */
export type NodeCheckStatus =
  'updatable' | 'up-to-date' | 'unsupported' | 'check-failed' | 'skipped-disabled' | 'locked'

export interface NodeUpdateCheckResult {
  name: string
  id: string
  currentVersion: string
  latestVersion?: string
  updatable: boolean
  updateSource: 'registry' | 'git' | 'none'
  /** Why it cannot be updated (locked / manager / local / no remote). */
  reason?: string
  reasonKey?: string
  checkStatus: NodeCheckStatus
  /** Populated when checkStatus === 'check-failed'. */
  error?: string
  /** Git packs: commits behind the upstream ref (0.1.11 — honest "latest" signal). */
  behindCount?: number
}

export interface NodeUpdateAllOptions {
  /**
   * Also attempt packs whose pre-check failed (git fetch timeout etc.).
   * Default false in main; the UI opts in explicitly (0.1.11).
   */
  includeCheckFailed?: boolean
}

export interface NodeUpdateAllResult {
  name: string
  ok: boolean
  error?: string
  skipped?: boolean
  /** Check outcome from the batch's initial pass (drives "all checks failed" UX). */
  checkStatus?: NodeCheckStatus
}

/** Batch update lifecycle event (event:node-update-batch). */
export interface NodeUpdateBatchEvent {
  batchId: string
  phase: 'checking' | 'start' | 'pack-start' | 'pack-done' | 'batch-done' | 'batch-error'
  index: number
  total: number
  packName?: string
  ok?: boolean
  error?: string
  summary?: {
    ok: number
    fail: number
    skip: number
    cancelled?: boolean
    /** Packs whose pre-check failed (not updatable this round). */
    checkFailed?: number
  }
  /** Stream owner (instance key) — renderer keeps per-instance state. */
  instanceId?: string
  ts: number
}

/** Streaming log line for a node install/update (event:node-op-log). */
export interface NodeOpLogEvent {
  runId: string
  packName?: string
  line: string
  /** Stream owner (instance key) — renderer buckets logs per instance. */
  instanceId?: string
  ts: number
}

/** Progress of a running check-updates pass (event:node-check-progress). */
export interface NodeCheckProgressEvent {
  done: number
  total: number
  packName?: string
  /** Stream owner (instance key) — labels must not cross instances. */
  instanceId?: string
  ts: number
}

// ---------- IPC ----------
export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** Machine-readable error code (e.g. PORT_IN_USE) */
  code?: string
  /** When code is PORT_IN_USE, a free port the UI may offer */
  suggestedPort?: number
}

export type IpcChannelMap = {
  // settings
  'settings.get': { args: []; result: AppSettings }
  'settings.set': { args: [Partial<AppSettings>]; result: AppSettings }
  'settings.launchTemplates': { args: []; result: LaunchArgTemplate[] }
  'settings.dataDir': { args: []; result: string }
  /** Global app log directory (userData/logs) — 0.1.15, for the Settings button. */
  'settings.logsDir': { args: []; result: string }
  'proxy.apply': { args: []; result: { enabled: boolean; url: string; bypass: string } }
  'proxy.test': {
    args: [{ url?: string }?]
    result: { ok: boolean; via: string; ms: number; error?: string }
  }

  // instances
  'instance.list': { args: []; result: ComfyInstanceInfo[] }
  'instance.discover': { args: [string?]; result: InstanceDiscoveryCandidate[] }
  'instance.save': { args: [ComfyInstanceConfig]; result: ComfyInstanceInfo }
  'instance.remove': { args: [string]; result: boolean }
  'instance.launch': { args: [string, LaunchOptions?]; result: ComfyInstanceInfo }
  'instance.previewLaunch': { args: [string]; result: LaunchCommandPreview }
  'instance.stop': { args: [string]; result: InstanceStopResult }
  'instance.restart': { args: [string, LaunchOptions?]; result: ComfyInstanceInfo }
  'instance.forceKill': { args: [string]; result: InstanceStopResult }
  'instance.sweepStale': {
    args: []
    result: { entries: number; killed: string[]; unverified: string[] }
  }
  'instance.startAll': { args: []; result: InstanceActionResult[] }
  'instance.stopAll': { args: []; result: InstanceActionResult[] }
  'instance.getLogs': { args: [string, number?]; result: ComfyLogLine[] }
  'instance.clearLogs': { args: [string]; result: boolean }
  'instance.checkPort': { args: [number]; result: PortCheckResult }
  'instance.suggestPort': { args: []; result: number }
  'instance.probeEnv': { args: [string]; result: EnvProbe }
  'instance.exportDiagnostics': { args: [string]; result: DiagnosticPackage }
  'instance.copyDiagnostics': { args: [string]; result: string }
  'instance.exportLogs': { args: [string]; result: { path: string } }
  'instance.checkComfyUpdate': { args: [string]; result: ComfyUpdateInfo }
  'instance.updateJournal': { args: [string]; result: UpdateJournal | null }
  'instance.rollbackUpdate': { args: [string]; result: boolean }
  'instance.updateComfy': { args: [string, ComfyUpdateOptions?]; result: UpdateProgress }
  'instance.updateStatus': { args: []; result: UpdateProgress | null }
  'instance.cancelUpdate': { args: []; result: boolean }
  'instance.repairEnv': { args: [string, RepairEnvOptions?]; result: EnvProbe }
  /** Current repair-op snapshot (modal hydration after renderer reloads). */
  'instance.repairStatus': { args: []; result: UpdateProgress | null }
  'instance.capabilities': { args: [string]; result: InstanceCapabilities | null }
  'instance.runStartupSelfCheck': {
    args: [string]
    result: { ok: boolean; exitCode: number | null; output: string }
  }
  /** Install one pip spec into the instance venv (0.1.12 — diagnosis fix). */
  'instance.pipInstall': { args: [string, string]; result: PipOpResult }
  /** Apply a curated fix recipe (triton/sageattention/onnx) to the instance venv. */
  'instance.applyRecipe': { args: [string, string]; result: PipOpResult }
  /** Cancel the running pip op for an instance. */
  'instance.pipCancel': { args: [string]; result: boolean }
  /** Current pip-op progress snapshot (modal hydration after view remounts). */
  'instance.pipStatus': { args: [string?]; result: UpdateProgress | null }
  /** Recorded execution failures (WS + log-parsed), newest first. */
  'instance.execFailures': { args: [string]; result: ExecFailure[] }
  /** Dismiss recorded failures (log-derived ones up to now). */
  'instance.clearExecFailures': { args: [string]; result: boolean }
  /** Custom-node packs that failed to import (parsed from the boot log, 0.1.16). */
  'instance.startupIssues': { args: [string]; result: InstanceStartupIssues }

  // models
  'model.list': { args: []; result: ModelRecord[] }
  'model.scan': { args: [{ roots?: string[]; hash?: boolean }?]; result: ModelRecord[] }
  'model.delete': { args: [string, boolean]; result: boolean }
  'model.move': { args: [string, string]; result: ModelRecord }
  'model.symlink': { args: [string, string]; result: ModelRecord }
  'model.rename': { args: [string, string]; result: ModelRecord }
  'model.tag': { args: [string, string[]]; result: ModelRecord }
  'model.findDuplicates': { args: []; result: DuplicateGroup[] }
  'model.downloads': { args: []; result: DownloadTask[] }
  'model.download': {
    args: [{ url: string; destDir?: string; fileName?: string; expectedSha256?: string }]
    result: DownloadTask
  }
  'model.pauseDownload': { args: [string]; result: DownloadTask }
  'model.resumeDownload': { args: [string]; result: DownloadTask }
  'model.cancelDownload': { args: [string]; result: boolean }
  'model.clearFinishedDownloads': { args: []; result: number }
  'model.storageStats': { args: []; result: StorageStats[] }
  'model.parseExtraPaths': { args: [string?]; result: string[] }
  'model.fetchCivitaiMeta': { args: [string]; result: Record<string, unknown> | null }
  'model.ensureThumbs': { args: []; result: number }
  'model.reconcile': { args: [string?]; result: ModelReconcileResult }
  'model.batchRename': {
    args: [{ ids: string[]; pattern: string; dryRun?: boolean }]
    result: Array<{ from: string; to: string; ok: boolean; error?: string }>
  }

  // node packs
  'node.list': { args: [string?]; result: NodePackRecord[] }
  'node.refresh': { args: [string?]; result: NodePackRecord[] }
  'registry.indexStatus': {
    args: []
    result: {
      ready: boolean
      updatedAt: number
      total: number
      pages: number
      count: number
      skippedPages?: number
    }
  }
  'registry.refreshIndex': {
    args: []
    result: {
      ready: boolean
      updatedAt: number
      total: number
      pages: number
      count: number
      skippedPages?: number
    }
  }
  'registry.ensureIndex': {
    args: []
    result: {
      ready: boolean
      updatedAt: number
      total: number
      pages: number
      count: number
      skippedPages?: number
    }
  }
  'node.managerChannel': { args: []; result: RegistryNodePack[] }
  'node.install': {
    args: [
      {
        id: string
        version?: string
        source: 'registry' | 'git' | 'manager'
        url?: string
        branch?: string
        instanceId?: string
      }
    ]
    result: NodePackRecord
  }
  'node.uninstall': {
    args: [string, string?, { removePipDeps?: boolean }?]
    result: boolean
  }
  'node.uninstallDeps': { args: [string, string?]; result: string[] }
  'node.cancelOp': { args: [string?]; result: boolean }
  'node.cancelBatch': { args: [string?]; result: boolean }
  'node.update': { args: [string, string?, string?]; result: NodePackRecord }
  'node.toggle': { args: [string, boolean, string?]; result: NodePackRecord }
  'node.lock': { args: [string, boolean, string?]; result: NodePackRecord }
  'node.checkIssues': { args: [string, string?]; result: NodePackIssue[] }
  'node.conflicts': { args: [string?]; result: NodeNameConflict[] }
  'node.smokeTest': { args: [string, string?]; result: NodePackIssue[] }
  'node.snapshots': { args: [string?]; result: NodeSnapshot[] }
  'node.createSnapshot': { args: [string?, string?]; result: NodeSnapshot }
  'node.restoreSnapshot': { args: [string, string?]; result: boolean }
  'node.deleteSnapshot': { args: [string, string?]; result: boolean }
  'node.checkUpdates': { args: [string?]; result: NodeUpdateCheckResult[] }
  'node.updateAll': { args: [string?, NodeUpdateAllOptions?]; result: NodeUpdateAllResult[] }
  'node.loadReport': { args: [string?]; result: NodeLoadReport | null }
  /** requirements.txt vs venv pip list audit (0.1.12). */
  'node.depsAudit': { args: [string?]; result: NodeDepsAudit }
  /** (Re)install one pack's requirements into the instance venv (0.1.12). */
  'node.installDeps': { args: [string, string?]; result: PipOpResult }
  /** Current node-op snapshot (modal hydration after renderer reloads). */
  'node.opStatus': { args: [string?]; result: UpdateProgress | null }

  // workflows
  'workflow.list': { args: [{ includeMissing?: boolean }?]; result: WorkflowRecord[] }
  'workflow.import': { args: [string, string?, ('instance' | 'library')?]; result: WorkflowRecord }
  'workflow.importMany': {
    args: [string[], string?, ('instance' | 'library')?]
    result: {
      ok: WorkflowRecord[]
      errors: Array<{ path: string; message: string }>
    }
  }
  'workflow.tag': { args: [string, string[]]; result: WorkflowRecord }
  'workflow.favorite': { args: [string, boolean]; result: WorkflowRecord }
  'workflow.rename': { args: [string, string]; result: WorkflowRecord }
  'workflow.delete': { args: [string, { deleteSource?: boolean }?]; result: boolean }
  'workflow.exportZip': { args: [string, string?]; result: { path: string } }
  'workflow.copyToInstance': { args: [string, string]; result: { path: string } }
  'workflow.openInFrontend': {
    args: [string, string?]
    result: {
      opened: boolean
      mode: 'embed' | 'browser'
      instanceName: string
      url: string
    }
  }
  'workflow.reveal': { args: [string]; result: boolean }
  'workflow.libraryInfo': {
    args: [string?]
    result: {
      /** Instance workflows folder — where imports land. */
      root: string
      instanceName: string
      count: number
      missing: number
    }
  }
  'workflow.queue': {
    args: [{ workflowPath: string; instanceId: string; seed?: number }]
    result: string | null
  }
  'workflow.parsePngMeta': { args: [string]; result: Record<string, unknown> | null }
  'workflow.compare': { args: [string, string]; result: WorkflowCompareResult }
  /** Preflight one workflow file against the instance /object_info (0.1.12). */
  'workflow.preflight': { args: [string, string]; result: WorkflowPreflight }
  /**
   * Import the running LOCAL instance's built-in default workflow (0.1.15).
   * Requires ComfyUI v0.41+ (`GET /default_workflow`), where v0.40 and older
   * fail with code DEFAULT_WORKFLOW_UNSUPPORTED.
   */
  'workflow.importDefault': {
    args: [{ instanceId: string; target?: 'instance' | 'library' }]
    result: WorkflowRecord
  }

  // monitor
  'monitor.system': { args: []; result: SystemSnapshot }
  'monitor.queue': { args: [string?]; result: QueueSnapshot }
  'monitor.history': { args: [string?]; result: QueueSnapshot }
  'monitor.jobs': { args: [string?]; result: ComfyJobSummary[] | null }
  'monitor.connectWs': { args: [string]; result: boolean }
  'monitor.disconnectWs': { args: []; result: boolean }
  // Runtime operations (0.1.15) — standard ComfyUI queue/memory actions.
  'monitor.clearQueue': { args: [string]; result: { ok: boolean; error?: string } }
  'monitor.interrupt': { args: [string, string?]; result: { ok: boolean; error?: string } }
  'monitor.freeMemory': { args: [string]; result: { ok: boolean; error?: string } }

  // doctor
  'doctor.run': { args: [string]; result: DoctorReport }
  'doctor.fix': { args: [string, string]; result: { ok: boolean; message: string } }

  // backup
  'backup.list': { args: []; result: BackupManifest[] }
  'backup.create': { args: [{ name: string; notes?: string }]; result: BackupManifest }
  'backup.restore': { args: [string]; result: boolean }
  'backup.delete': { args: [string]; result: boolean }
  'backup.openFolder': { args: [string]; result: boolean }

  // env
  'env.probe': { args: [{ pythonPath: string; venvPath?: string }]; result: EnvProbe }
  'env.createVenv': { args: [EnvCreateRequest]; result: EnvProbe }
  'env.listPythons': { args: []; result: Array<{ path: string; version: string }> }
  'env.installTorch': { args: [{ pythonPath: string; index: string }]; result: boolean }
  /** Curated dependency-fix recipes (0.1.12, WP7). */
  'deps.recipes': { args: []; result: PipRecipe[] }

  // installer
  'installer.detectGpu': { args: []; result: GpuCapability[] }
  'installer.preflight': {
    args: [
      { installRoot: string; useUv: boolean; pythonPath?: string; torchChannel?: TorchChannel }?
    ]
    result: {
      ok: boolean
      checks: Array<{
        id: string
        ok: boolean
        detail: string
        /** i18n key — renderer translates; detail is English log fallback. */
        detailKey?: string
        detailParams?: Record<string, string | number>
        /** When set, UI can offer a one-click repair action. */
        fixId?: string
        fixLabel?: string
        fixLabelKey?: string
      }>
      /** Disk requirement estimate for the selected torch channel. */
      diskNeedGb?: number
      diskFreeGb?: number
    }
  }
  'installer.start': { args: [InstallPlan]; result: { runId: string } }
  'installer.status': { args: []; result: InstallProgress | null }
  'installer.cancel': { args: []; result: boolean }
  'installer.reset': { args: []; result: boolean }
  'installer.suggestInstallRoot': { args: []; result: { path: string; freeGb: number } }
  'installer.starterModels': { args: []; result: StarterModel[] }
  'installer.installStarter': { args: [{ id: string; instanceId?: string }]; result: DownloadTask }

  // runtime bootstrap
  'bootstrap.status': { args: []; result: BootstrapStatus }
  'bootstrap.ensure': {
    args: [{ kinds?: RuntimeKind[]; downloadIfMissing?: boolean }?]
    result: BootstrapStatus
  }
  'bootstrap.download': { args: [RuntimeKind]; result: RuntimeComponentStatus }

  // network probe
  'net.recommendMirrors': {
    args: []
    result: {
      pipIndex: string
      pipLabel: string
      torchIndexMirror: string
      torchLabel: string
      githubEndpoint: string
      githubLabel: string
      probes: Array<{
        id: string
        label: string
        url: string
        ok: boolean
        latencyMs: number
        error?: string
      }>
    }
  }

  // launch script export
  'instance.exportLaunchScript': {
    args: [string, { dir?: string; kind?: 'bat' | 'sh' }?]
    result: { path: string }
  }

  // batch
  'batch.list': { args: []; result: BatchJob[] }
  'batch.create': {
    args: [
      {
        name: string
        instanceId: string
        items: Array<{
          workflowId?: string
          workflowName?: string
          workflowPath: string
          count: number
        }>
        notes?: string
        params?: BatchParamOverrides
      }
    ]
    result: BatchJob
  }
  'batch.start': { args: [string]; result: BatchJob }
  'batch.resume': { args: [string]; result: BatchJob }
  'batch.retryFailed': { args: [string]; result: BatchJob }
  // 0.1.17 (WP5-7): start/resume/retry now return the accepted snapshot;
  // `batch.wait` settles on the terminal job without polling.
  'batch.wait': { args: [string]; result: BatchJob | null }
  'batch.cancel': { args: [string]; result: BatchJob }
  'batch.cancelItem': { args: [string, string]; result: BatchJob }
  'batch.remove': { args: [string]; result: boolean }
  /** Preflight all item workflows of a batch against the target /object_info. */
  'batch.preflight': {
    args: [{ workflowPaths: string[]; instanceId: string }]
    result: BatchPreflight
  }

  // output
  'output.list': {
    args: [
      {
        root?: string
        type?: string
        limit?: number
        offset?: number
        favorite?: boolean
        batchJobId?: string
        workflowId?: string
        /** Any-of match across workflow records (0.1.11 — duplicate-name copies). */
        workflowIds?: string[]
        sort?: 'createdAt' | 'size' | 'name'
        order?: 'asc' | 'desc'
        createdFrom?: number
        createdTo?: number
      }?
    ]
    result: { items: OutputAsset[]; total: number; truncated: boolean }
  }
  /** 0.1.17 (WP7): explicit disk scan; listing stays index-only. */
  'output.scan': { args: [{ root?: string }?]; result: { scanned: number; cancelled: boolean } }
  'output.scanCancel': { args: []; result: boolean }
  /**
   * Read-only lookup against the instance's ComfyUI assets system (0.1.14).
   * null = assets API unavailable/failed; [] = answered, nothing matched.
   */
  'output.assetsMatch': { args: [string, string]; result: OutputAssetMatch[] | null }
  'output.open': { args: [string]; result: boolean }
  'output.reveal': { args: [string]; result: boolean }
  'output.favorite': { args: [string, boolean]; result: boolean }
  'output.delete': { args: [string, boolean]; result: boolean }
  /** Batch delete (0.1.15) — per-id failures reported, never an all-or-nothing lie. */
  'output.batchDelete': {
    args: [string[], boolean]
    result: { ok: number; failed: Array<{ id: string; label: string; error: string }> }
  }
  'output.importToWorkflow': { args: [string, string?]; result: WorkflowRecord | null }
  'output.exportZip': { args: [string[], string?]; result: { path: string } }

  // remote
  'remote.list': { args: []; result: RemoteInstanceConfig[] }
  'remote.save': { args: [RemoteInstanceConfig]; result: RemoteInstanceConfig }
  'remote.remove': { args: [string]; result: boolean }
  'remote.test': { args: [string]; result: RemoteInstanceStatus }
  'remote.listStatus': { args: []; result: RemoteInstanceStatus[] }
  /** POST /free {unload_models, free_memory} against a remote instance (0.1.11). */
  'remote.freeMemory': { args: [string]; result: { ok: boolean; error?: string } }
  /** App self-update check (electron-updater); dev builds report unsupported. */
  'app.checkUpdate': { args: []; result: AppUpdateStatus }
  /** Last known self-update status (seeds the Settings view, 0.1.11). */
  'app.updateStatus': { args: []; result: AppUpdateStatus }
  /** Quit-and-install a DOWNLOADED update (0.1.13). */
  'app.installUpdate': { args: []; result: { ok: boolean; error?: string } }
  /** How the previous session ended (0.1.16) — powers the unclean-exit hint. */
  'app.previousExit': { args: []; result: PreviousExitInfo }
  /** Bundle logs + session + runtime facts into a diagnostics folder (0.1.16). */
  'app.exportDiagnostics': { args: []; result: { path: string } }

  // market
  'market.list': {
    args: [
      { query?: string; category?: string; limit?: number; page?: number; instanceId?: string }?
    ]
    result: RegistryPageResult<MarketItem>
  }
  'market.install': {
    args: [{ id: string; version?: string; repository?: string; instanceId?: string }]
    result: NodePackRecord
  }

  // shell
  'shell.openExternal': { args: [string]; result: boolean }
  'shell.openPath': { args: [string]; result: boolean }
  'shell.reveal': { args: [string]; result: boolean }
  'shell.pickDirectory': { args: []; result: string | null }
  'shell.pickFile': {
    args: [{ filters?: Array<{ name: string; extensions: string[] }> }?]
    result: string | null
  }
  'shell.pickFiles': {
    args: [{ filters?: Array<{ name: string; extensions: string[] }> }?]
    result: string[]
  }
  'shell.writeClipboard': { args: [string]; result: boolean }

  // frontend embed
  'embed.open': { args: [{ url: string; title?: string }]; result: boolean }
  'embed.close': { args: []; result: boolean }
  'embed.resize': {
    args: [{ x: number; y: number; width: number; height: number }]
    result: boolean
  }
}

export type IpcChannel = keyof IpcChannelMap

/**
 * Runtime list of every invoke channel (0.1.16).
 *
 * TypeScript types are erased at runtime, so the preload cannot derive the
 * channel whitelist from `IpcChannelMap`. This array is that runtime mirror;
 * `tests/unit/ipcRegistration.test.ts` asserts it exactly matches the keys
 * registered by `registerIpcHandlers`, so the list can never silently drift.
 */
export const IPC_CHANNELS = [
  'app.checkUpdate',
  'app.exportDiagnostics',
  'app.installUpdate',
  'app.previousExit',
  'app.updateStatus',
  'backup.create',
  'backup.delete',
  'backup.list',
  'backup.openFolder',
  'backup.restore',
  'batch.cancel',
  'batch.cancelItem',
  'batch.create',
  'batch.list',
  'batch.preflight',
  'batch.remove',
  'batch.start',
  'batch.resume',
  'batch.retryFailed',
  'batch.wait',
  'bootstrap.download',
  'bootstrap.ensure',
  'bootstrap.status',
  'deps.recipes',
  'doctor.fix',
  'doctor.run',
  'embed.close',
  'embed.open',
  'embed.resize',
  'env.createVenv',
  'env.installTorch',
  'env.listPythons',
  'env.probe',
  'installer.cancel',
  'installer.detectGpu',
  'installer.installStarter',
  'installer.preflight',
  'installer.reset',
  'installer.start',
  'installer.starterModels',
  'installer.status',
  'installer.suggestInstallRoot',
  'instance.applyRecipe',
  'instance.cancelUpdate',
  'instance.capabilities',
  'instance.checkComfyUpdate',
  'instance.updateJournal',
  'instance.rollbackUpdate',
  'instance.checkPort',
  'instance.clearExecFailures',
  'instance.clearLogs',
  'instance.copyDiagnostics',
  'instance.discover',
  'instance.execFailures',
  'instance.exportDiagnostics',
  'instance.exportLaunchScript',
  'instance.exportLogs',
  'instance.forceKill',
  'instance.sweepStale',
  'instance.getLogs',
  'instance.launch',
  'instance.list',
  'instance.pipCancel',
  'instance.pipInstall',
  'instance.pipStatus',
  'instance.previewLaunch',
  'instance.probeEnv',
  'instance.remove',
  'instance.repairEnv',
  'instance.repairStatus',
  'instance.restart',
  'instance.runStartupSelfCheck',
  'instance.save',
  'instance.startAll',
  'instance.startupIssues',
  'instance.stop',
  'instance.stopAll',
  'instance.suggestPort',
  'instance.updateComfy',
  'instance.updateStatus',
  'market.install',
  'market.list',
  'model.batchRename',
  'model.cancelDownload',
  'model.clearFinishedDownloads',
  'model.delete',
  'model.download',
  'model.downloads',
  'model.ensureThumbs',
  'model.fetchCivitaiMeta',
  'model.findDuplicates',
  'model.list',
  'model.move',
  'model.parseExtraPaths',
  'model.pauseDownload',
  'model.reconcile',
  'model.rename',
  'model.resumeDownload',
  'model.scan',
  'model.storageStats',
  'model.symlink',
  'model.tag',
  'monitor.clearQueue',
  'monitor.connectWs',
  'monitor.disconnectWs',
  'monitor.freeMemory',
  'monitor.history',
  'monitor.interrupt',
  'monitor.jobs',
  'monitor.queue',
  'monitor.system',
  'net.recommendMirrors',
  'node.cancelBatch',
  'node.cancelOp',
  'node.checkIssues',
  'node.checkUpdates',
  'node.conflicts',
  'node.createSnapshot',
  'node.deleteSnapshot',
  'node.depsAudit',
  'node.install',
  'node.installDeps',
  'node.list',
  'node.loadReport',
  'node.lock',
  'node.managerChannel',
  'node.opStatus',
  'node.refresh',
  'node.restoreSnapshot',
  'node.smokeTest',
  'node.snapshots',
  'node.toggle',
  'node.uninstall',
  'node.uninstallDeps',
  'node.update',
  'node.updateAll',
  'output.assetsMatch',
  'output.batchDelete',
  'output.delete',
  'output.exportZip',
  'output.favorite',
  'output.importToWorkflow',
  'output.list',
  'output.scan',
  'output.scanCancel',
  'output.open',
  'output.reveal',
  'proxy.apply',
  'proxy.test',
  'registry.ensureIndex',
  'registry.indexStatus',
  'registry.refreshIndex',
  'remote.freeMemory',
  'remote.list',
  'remote.listStatus',
  'remote.remove',
  'remote.save',
  'remote.test',
  'settings.dataDir',
  'settings.get',
  'settings.launchTemplates',
  'settings.logsDir',
  'settings.set',
  'shell.openExternal',
  'shell.openPath',
  'shell.pickDirectory',
  'shell.pickFile',
  'shell.pickFiles',
  'shell.reveal',
  'shell.writeClipboard',
  'workflow.compare',
  'workflow.copyToInstance',
  'workflow.delete',
  'workflow.exportZip',
  'workflow.favorite',
  'workflow.import',
  'workflow.importDefault',
  'workflow.importMany',
  'workflow.libraryInfo',
  'workflow.list',
  'workflow.openInFrontend',
  'workflow.parsePngMeta',
  'workflow.preflight',
  'workflow.queue',
  'workflow.rename',
  'workflow.reveal',
  'workflow.tag'
] as const

export const IPC_EVENTS = {
  instanceStatus: 'event:instance-status',
  instanceLog: 'event:instance-log',
  modelScanProgress: 'event:model-scan-progress',
  downloadProgress: 'event:download-progress',
  monitorTick: 'event:monitor-tick',
  monitorWs: 'event:monitor-ws',
  doctorProgress: 'event:doctor-progress',
  batchProgress: 'event:batch-progress',
  nodeInstallProgress: 'event:node-install-progress',
  installProgress: 'event:install-progress',
  registryIndexProgress: 'event:registry-index-progress',
  notification: 'event:notification',
  runtimeProgress: 'event:runtime-progress',
  comfyUpdateProgress: 'event:comfy-update-progress',
  nodeUpdateProgress: 'event:node-update-progress',
  nodeUpdateBatch: 'event:node-update-batch',
  nodeOpLog: 'event:node-op-log',
  nodeCheckProgress: 'event:node-check-progress',
  repairProgress: 'event:repair-progress',
  nodeOperationProgress: 'event:node-operation-progress',
  appUpdate: 'event:app-update',
  /** Recorded execution failure (0.1.12) — payload: ExecFailure. */
  execError: 'event:exec-error',
  /** Streaming log line for pip/recipe ops (0.1.12). */
  pipOpLog: 'event:pip-op-log',
  /** UpdateProgress-shaped stream for pip/recipe ops (0.1.12). */
  pipOpProgress: 'event:pip-op-progress',
  /**
   * Embedded frontend lifecycle (0.1.17 WP9): `{ state: 'ready' | 'failed',
   * url?, errorCode?, errorDescription?, validatedURL? }`. Without this the
   * embed pane just stayed blank on a failed load.
   */
  embedState: 'event:embed-state',
  /** Output scan progress (0.1.17 review fix) — {scanned,total,done,cancelled}. */
  outputScanProgress: 'event:output-scan-progress'
} as const

export interface AppNotification {
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  duration?: number
  /** i18n key for the title — renderer translates when present (title is fallback). */
  titleKey?: string
  /** i18n key for the message — renderer translates when present (message is fallback). */
  messageKey?: string
  /** Interpolation params for titleKey / messageKey. */
  params?: Record<string, string | number>
}
