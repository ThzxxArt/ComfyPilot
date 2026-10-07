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
  proxy: ProxySettings
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
}

export interface PortCheckResult {
  port: number
  available: boolean
  owner?: string
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
  promptId?: string
  seed?: number
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
export interface BatchJob {
  id: string
  name: string
  workflowPath: string
  instanceId: string
  count: number
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  completed: number
  failed: number
  createdAt: number
  finishedAt?: number
  promptIds: string[]
  notes: string
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

// ---------- Installer (one-click isolated setup) ----------
export type InstallStepId =
  | 'preflight'
  | 'python'
  | 'venv'
  | 'comfyui'
  | 'torch'
  | 'requirements'
  | 'register'
  | 'done'

export type InstallStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface InstallStep {
  id: InstallStepId
  title: string
  status: InstallStepStatus
  detail: string
  log: string[]
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
}

export interface InstallProgress {
  runId: string
  step: InstallStepId
  status: InstallStepStatus
  steps: InstallStep[]
  message: string
  percent: number
  error?: string
}

export interface GpuCapability {
  vendor: string
  model: string
  recommendedTorch: TorchChannel
  notes: string
}

// ---------- IPC ----------
export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
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
  'instance.start': { args: [string]; result: ComfyInstanceInfo }
  'instance.stop': { args: [string]; result: ComfyInstanceInfo }
  'instance.restart': { args: [string]; result: ComfyInstanceInfo }
  'instance.forceKill': { args: [string]; result: ComfyInstanceInfo }
  'instance.getLogs': { args: [string, number?]; result: ComfyLogLine[] }
  'instance.clearLogs': { args: [string]; result: boolean }
  'instance.checkPort': { args: [number]; result: PortCheckResult }
  'instance.suggestPort': { args: []; result: number }
  'instance.probeEnv': { args: [string]; result: EnvProbe }
  'instance.exportDiagnostics': { args: [string]; result: DiagnosticPackage }
  'instance.copyDiagnostics': { args: [string]; result: string }

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
  'model.download': { args: [{ url: string; destDir?: string; fileName?: string }]; result: DownloadTask }
  'model.pauseDownload': { args: [string]; result: DownloadTask }
  'model.resumeDownload': { args: [string]; result: DownloadTask }
  'model.cancelDownload': { args: [string]; result: boolean }
  'model.storageStats': { args: []; result: StorageStats[] }
  'model.parseExtraPaths': { args: [string?]; result: string[] }
  'model.fetchCivitaiMeta': { args: [string]; result: Record<string, unknown> | null }
  'model.ensureThumbs': { args: []; result: number }
  'model.batchRename': { args: [{ ids: string[]; pattern: string; dryRun?: boolean }]; result: Array<{ from: string; to: string; ok: boolean; error?: string }> }

  // node packs
  'node.list': { args: []; result: NodePackRecord[] }
  'node.refresh': { args: []; result: NodePackRecord[] }
  'node.registrySearch': { args: [{ query?: string; limit?: number }?]; result: RegistryNodePack[] }
  'node.managerChannel': { args: []; result: RegistryNodePack[] }
  'node.install': { args: [{ id: string; version?: string; source: 'registry' | 'git' | 'manager'; url?: string }]; result: NodePackRecord }
  'node.uninstall': { args: [string]; result: boolean }
  'node.update': { args: [string, string?]; result: NodePackRecord }
  'node.toggle': { args: [string, boolean]; result: NodePackRecord }
  'node.lock': { args: [string, boolean]; result: NodePackRecord }
  'node.checkIssues': { args: [string]; result: NodePackIssue[] }
  'node.conflicts': { args: []; result: NodeNameConflict[] }
  'node.smokeTest': { args: [string]; result: NodePackIssue[] }
  'node.snapshots': { args: []; result: NodeSnapshot[] }
  'node.createSnapshot': { args: [string?]; result: NodeSnapshot }
  'node.restoreSnapshot': { args: [string]; result: boolean }
  'node.deleteSnapshot': { args: [string]; result: boolean }

  // workflows
  'workflow.list': { args: []; result: WorkflowRecord[] }
  'workflow.import': { args: [string]; result: WorkflowRecord }
  'workflow.launch': { args: [string, string?]; result: boolean }
  'workflow.tag': { args: [string, string[]]; result: WorkflowRecord }
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
  'installer.preflight': { args: [{ installRoot: string; useUv: boolean }]; result: { ok: boolean; checks: Array<{ id: string; ok: boolean; detail: string }> } }
  'installer.start': { args: [InstallPlan]; result: { runId: string } }
  'installer.status': { args: []; result: InstallProgress | null }
  'installer.cancel': { args: []; result: boolean }

  // batch
  'batch.list': { args: []; result: BatchJob[] }
  'batch.create': { args: [Omit<BatchJob, 'id' | 'status' | 'completed' | 'failed' | 'createdAt' | 'promptIds'>]; result: BatchJob }
  'batch.start': { args: [string]; result: BatchJob }
  'batch.cancel': { args: [string]; result: BatchJob }
  'batch.remove': { args: [string]; result: boolean }

  // output
  'output.list': { args: [{ root?: string; type?: string; limit?: number }?]; result: OutputAsset[] }
  'output.open': { args: [string]; result: boolean }
  'output.importToWorkflow': { args: [string]; result: WorkflowRecord | null }

  // remote
  'remote.list': { args: []; result: RemoteInstanceConfig[] }
  'remote.save': { args: [RemoteInstanceConfig]; result: RemoteInstanceConfig }
  'remote.remove': { args: [string]; result: boolean }
  'remote.test': { args: [string]; result: RemoteInstanceStatus }
  'remote.listStatus': { args: []; result: RemoteInstanceStatus[] }

  // market
  'market.list': { args: [{ query?: string; category?: string }?]; result: MarketItem[] }
  'market.install': { args: [string]; result: NodePackRecord }

  // shell
  'shell.openExternal': { args: [string]; result: boolean }
  'shell.openPath': { args: [string]; result: boolean }
  'shell.pickDirectory': { args: []; result: string | null }
  'shell.pickFile': { args: [{ filters?: Array<{ name: string; extensions: string[] }> }?]; result: string | null }
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
  notification: 'event:notification'
} as const

export interface AppNotification {
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  duration?: number
}
