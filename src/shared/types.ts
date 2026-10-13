/** Shared domain types between main / preload / renderer — full PLAN coverage */

// ---------- App ----------
export type AppLocale = 'zh-CN' | 'en-US'

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
}

/** stop/forceKill result — `adopted` marks an external process we only signalled. */
export interface InstanceStopResult extends ComfyInstanceInfo {
  adopted?: boolean
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
}

export interface OutputAsset {
  id: string
  path: string
  fileName: string
  type: 'image' | 'video' | 'audio' | 'other'
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
export type BatchJobStatus = 'queued' | 'submitting' | 'running' | 'done' | 'error' | 'cancelled'
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

export type InstallStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

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
  /** Commits behind upstream (git installs only). */
  behindCount?: number
  /** Short sha of remote head (git installs only). */
  latestCommit?: string
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
  /** 0..1 progress within the step (git object %, pip line heuristics). */
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
  'instance.startAll': { args: []; result: InstanceActionResult[] }
  'instance.stopAll': { args: []; result: InstanceActionResult[] }
  'instance.getLogs': { args: [string, number?]; result: ComfyLogLine[] }
  'instance.clearLogs': { args: [string]; result: boolean }
  'instance.checkPort': { args: [number]; result: PortCheckResult }
  'instance.suggestPort': { args: []; result: number }
  'instance.probeEnv': { args: [string]; result: EnvProbe }
  'instance.exportDiagnostics': { args: [string]; result: DiagnosticPackage }
  'instance.copyDiagnostics': { args: [string]; result: string }
  'instance.checkComfyUpdate': { args: [string]; result: ComfyUpdateInfo }
  'instance.updateComfy': { args: [string, ComfyUpdateOptions?]; result: UpdateProgress }
  'instance.updateStatus': { args: []; result: UpdateProgress | null }
  'instance.cancelUpdate': { args: []; result: boolean }
  'instance.repairEnv': { args: [string, RepairEnvOptions?]; result: EnvProbe }
  'instance.capabilities': { args: [string]; result: InstanceCapabilities | null }
  'instance.runStartupSelfCheck': {
    args: [string]
    result: { ok: boolean; exitCode: number | null; output: string }
  }

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
  'node.updateAll': { args: [string?]; result: NodeUpdateAllResult[] }
  'node.loadReport': { args: [string?]; result: NodeLoadReport | null }

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

  // monitor
  'monitor.system': { args: []; result: SystemSnapshot }
  'monitor.queue': { args: [string?]; result: QueueSnapshot }
  'monitor.history': { args: [string?]; result: QueueSnapshot }
  'monitor.jobs': { args: [string?]; result: ComfyJobSummary[] | null }
  'monitor.connectWs': { args: [string]; result: boolean }
  'monitor.disconnectWs': { args: []; result: boolean }

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
  'batch.cancel': { args: [string]; result: BatchJob }
  'batch.cancelItem': { args: [string, string]; result: BatchJob }
  'batch.remove': { args: [string]; result: boolean }

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
        sort?: 'createdAt' | 'size' | 'name'
        order?: 'asc' | 'desc'
        createdFrom?: number
        createdTo?: number
      }?
    ]
    result: { items: OutputAsset[]; total: number; truncated: boolean }
  }
  'output.open': { args: [string]; result: boolean }
  'output.reveal': { args: [string]; result: boolean }
  'output.favorite': { args: [string, boolean]; result: boolean }
  'output.delete': { args: [string, boolean]; result: boolean }
  'output.importToWorkflow': { args: [string, string?]; result: WorkflowRecord | null }
  'output.exportZip': { args: [string[], string?]; result: { path: string } }

  // remote
  'remote.list': { args: []; result: RemoteInstanceConfig[] }
  'remote.save': { args: [RemoteInstanceConfig]; result: RemoteInstanceConfig }
  'remote.remove': { args: [string]; result: boolean }
  'remote.test': { args: [string]; result: RemoteInstanceStatus }
  'remote.listStatus': { args: []; result: RemoteInstanceStatus[] }

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
  nodeOperationProgress: 'event:node-operation-progress'
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
