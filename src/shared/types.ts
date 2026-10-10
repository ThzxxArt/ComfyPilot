/** Shared domain types between main / preload / renderer — full PLAN coverage */

// ---------- App ----------
export type AppTheme = 'light' | 'system'
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
  theme: AppTheme
  locale: AppLocale
  defaultInstancePath: string
  extraModelPathsFile: string
  modelScanRoots: string[]
  downloadDir: string
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
  outputIndexRoot: string
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
}

// ---------- Instance ----------
export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'error' | 'unknown'

export interface LaunchArgTemplate {
  id: string
  name: string
  args: string[]
  description: string
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
}

export interface ComfyInstanceInfo extends ComfyInstanceConfig {
  status: InstanceStatus
  pid?: number
  version?: string
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

export interface DiagnosticPackage {
  path: string
  createdAt: number
  size: number
  contents: string[]
}

// ---------- Model ----------
export type ModelCategory =
  | 'checkpoints'
  | 'diffusion_models'
  | 'loras'
  | 'vae'
  | 'clip'
  | 'controlnet'
  | 'upscale_models'
  | 'embeddings'
  | 'text_encoders'
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
  | 'installed'
  | 'update-available'
  | 'disabled'
  | 'error'
  | 'not-installed'
  | 'installing'

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
  packs: Array<{ name: string; version: string; path: string; source: string }>
  notes: string
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

export interface ComfyLogLine {
  ts: number
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source?: string
}

export interface ExecProgressEvent {
  type: 'progress' | 'executing' | 'executed' | 'status' | 'execution_error' | 'preview'
  nodeId?: string
  value?: number
  max?: number
  promptId?: string
  image?: string
  text?: string
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
  failed: number
  promptIds: string[]
  seeds: number[]
  /** Absolute output file paths linked after generation. */
  outputPaths: string[]
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
  /** Images linked from history for successful prompts. */
  produced: number
  createdAt: number
  finishedAt?: number
  notes: string
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

export type InstallStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

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

export type TorchChannel =
  | 'cu130'
  | 'cu126'
  | 'cu124'
  | 'rocm'
  | 'xpu'
  | 'mps'
  | 'cpu'

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
}

export interface NodeUpdateAllResult {
  name: string
  ok: boolean
  error?: string
  skipped?: boolean
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
  'proxy.test': { args: [{ url?: string }?]; result: { ok: boolean; via: string; ms: number; error?: string } }

  // instances
  'instance.list': { args: []; result: ComfyInstanceInfo[] }
  'instance.discover': { args: [string?]; result: InstanceDiscoveryCandidate[] }
  'instance.save': { args: [ComfyInstanceConfig]; result: ComfyInstanceInfo }
  'instance.remove': { args: [string]; result: boolean }
  'instance.start': { args: [string, LaunchOptions?]; result: ComfyInstanceInfo }
  'instance.launch': { args: [string, LaunchOptions?]; result: ComfyInstanceInfo }
  'instance.waitReady': { args: [string, number?]; result: WaitReadyResult }
  'instance.previewLaunch': { args: [string]; result: LaunchCommandPreview }
  'instance.stop': { args: [string]; result: ComfyInstanceInfo }
  'instance.restart': { args: [string, LaunchOptions?]; result: ComfyInstanceInfo }
  'instance.forceKill': { args: [string]; result: ComfyInstanceInfo }
  'instance.startAll': { args: []; result: ComfyInstanceInfo[] }
  'instance.stopAll': { args: []; result: ComfyInstanceInfo[] }
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
  'model.storageStats': { args: []; result: StorageStats[] }
  'model.parseExtraPaths': { args: [string?]; result: string[] }
  'model.fetchCivitaiMeta': { args: [string]; result: Record<string, unknown> | null }
  'model.ensureThumbs': { args: []; result: number }
  'model.batchRename': { args: [{ ids: string[]; pattern: string; dryRun?: boolean }]; result: Array<{ from: string; to: string; ok: boolean; error?: string }> }

  // node packs
  'node.list': { args: [string?]; result: NodePackRecord[] }
  'node.refresh': { args: [string?]; result: NodePackRecord[] }
  'node.registrySearch': {
    args: [{ query?: string; limit?: number; page?: number; scanPages?: number }?]
    result: RegistryPageResult<RegistryNodePack>
  }
  'registry.indexStatus': {
    args: []
    result: { ready: boolean; updatedAt: number; total: number; pages: number; count: number }
  }
  'registry.refreshIndex': {
    args: []
    result: { ready: boolean; updatedAt: number; total: number; pages: number; count: number }
  }
  'registry.ensureIndex': {
    args: []
    result: { ready: boolean; updatedAt: number; total: number; pages: number; count: number }
  }
  'node.managerChannel': { args: []; result: RegistryNodePack[] }
  'node.install': {
    args: [{ id: string; version?: string; source: 'registry' | 'git' | 'manager'; url?: string; instanceId?: string }]
    result: NodePackRecord
  }
  'node.uninstall': { args: [string, string?]; result: boolean }
  'node.update': { args: [string, string?, string?]; result: NodePackRecord }
  'node.toggle': { args: [string, boolean, string?]; result: NodePackRecord }
  'node.lock': { args: [string, boolean]; result: NodePackRecord }
  'node.checkIssues': { args: [string, string?]; result: NodePackIssue[] }
  'node.conflicts': { args: [string?]; result: NodeNameConflict[] }
  'node.smokeTest': { args: [string, string?]; result: NodePackIssue[] }
  'node.snapshots': { args: []; result: NodeSnapshot[] }
  'node.createSnapshot': { args: [string?]; result: NodeSnapshot }
  'node.restoreSnapshot': { args: [string]; result: boolean }
  'node.deleteSnapshot': { args: [string]; result: boolean }
  'node.checkUpdates': { args: [string?]; result: NodeUpdateCheckResult[] }
  'node.updateAll': { args: [string?]; result: NodeUpdateAllResult[] }

  // workflows
  'workflow.list': { args: [{ includeMissing?: boolean }?]; result: WorkflowRecord[] }
  'workflow.import': { args: [string, string?]; result: WorkflowRecord }
  'workflow.importMany': { args: [string[], string?]; result: WorkflowRecord[] }
  'workflow.launch': { args: [string, string?]; result: boolean }
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
  'workflow.queue': { args: [{ workflowPath: string; instanceId: string; seed?: number }]; result: string | null }
  'workflow.parsePngMeta': { args: [string]; result: Record<string, unknown> | null }

  // monitor
  'monitor.system': { args: []; result: SystemSnapshot }
  'monitor.queue': { args: [string?]; result: QueueSnapshot }
  'monitor.history': { args: [string?]; result: QueueSnapshot }
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
    args: [{ installRoot: string; useUv: boolean; pythonPath?: string; torchChannel?: TorchChannel }?]
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
      probes: Array<{ id: string; label: string; url: string; ok: boolean; latencyMs: number; error?: string }>
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
      }?
    ]
    result: { items: OutputAsset[]; total: number; truncated: boolean }
  }
  'output.open': { args: [string]; result: boolean }
  'output.reveal': { args: [string]; result: boolean }
  'output.favorite': { args: [string, boolean]; result: boolean }
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
    args: [{ query?: string; category?: string; limit?: number; page?: number; scanPages?: number; instanceId?: string }?]
    result: RegistryPageResult<MarketItem>
  }
  'market.install': { args: [string, string?]; result: NodePackRecord }

  // shell
  'shell.openExternal': { args: [string]; result: boolean }
  'shell.openPath': { args: [string]; result: boolean }
  'shell.reveal': { args: [string]; result: boolean }
  'shell.pickDirectory': { args: []; result: string | null }
  'shell.pickFile': { args: [{ filters?: Array<{ name: string; extensions: string[] }> }?]; result: string | null }
  'shell.pickFiles': { args: [{ filters?: Array<{ name: string; extensions: string[] }> }?]; result: string[] }
  'shell.writeClipboard': { args: [string]; result: boolean }

  // frontend embed
  'embed.open': { args: [{ url: string; title?: string }]; result: boolean }
  'embed.close': { args: []; result: boolean }
  'embed.resize': { args: [{ x: number; y: number; width: number; height: number }]; result: boolean }
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
  repairProgress: 'event:repair-progress',
  nodeOperationProgress: 'event:node-operation-progress'
} as const

export interface AppNotification {
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  duration?: number
}
