/** Shared domain types between main / preload / renderer — barrel export. */
export type {
  AppLocale,
  AppUpdateStatus,
  PreviousExitInfo,
  AppIssueKind,
  AppIssueStatus,
  AppIssueAction,
  AppIssue,
  InstanceStartupIssue,
  InstanceStartupIssues,
  ProxyProtocol,
  ProxySettings,
  ProxySettingsView,
  RemoteInstanceSummary,
  AppSettingsView,
  AppSettings,
  NotificationAction,
  AppNotification,
  AppNotificationInput
} from './app'

export type {
  InstanceStatus,
  LaunchArgTemplate,
  LaunchProfile,
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  TargetRef,
  InstanceDiscoveryCandidate,
  PortCheckResult,
  LaunchCommandPreview,
  LaunchOptions,
  WaitReadyResult,
  InstanceCapabilities,
  NodeLoadEntry,
  NodeLoadReport,
  ModelReconcileFolder,
  ModelReconcileResult,
  InstanceActionResult,
  InstanceStopResult,
  DiagnosticPackage
} from './instance'

export type {
  ModelCategory,
  ModelRecord,
  ModelScanProgress,
  DownloadTask,
  StorageStats,
  DuplicateGroup,
  OutputAsset,
  OutputAssetMatch
} from './model'

export type {
  NodePackStatus,
  NodePackRecord,
  NodePackIssue,
  RegistryNodePack,
  NodeSnapshot,
  NodeNameConflict,
  NodeRecoveryKind,
  NodeRecoveryEntry,
  NodeDepsAuditPack,
  NodeDepsAudit,
  NodeCheckStatus,
  NodeUpdateCheckResult,
  NodeUpdateAllOptions,
  NodeUpdateAllResult,
  NodeUpdateBatchEvent,
  NodeOpLogEvent,
  NodeCheckProgressEvent
} from './node'

export type {
  WorkflowOrigin,
  WorkflowRecord,
  WorkflowCompareDiff,
  WorkflowCompareResult,
  WorkflowModelRequirement,
  WorkflowModelPreflight,
  WorkflowPreflight,
  BatchPreflight
} from './workflow'

export type {
  GpuInfo,
  SystemSnapshot,
  QueueItem,
  QueueSnapshot,
  ComfyJobSummary,
  ComfyLogLine,
  ExecNodeProgress,
  ExecProgressEvent,
  ExecFailure,
  PipOpResult
} from './monitor'

export type { DoctorSeverity, DoctorCheck, DoctorReport } from './doctor'

export type {
  BackupManifest,
  BackupRestoreSection,
  BackupWorkflowFilePreview,
  BackupRestorePreview,
  BackupRestoreResult
} from './backup'

export type { EnvProbe, EnvCreateRequest, RepairEnvOptions } from './env'

export type {
  BatchJobStatus,
  SeedMode,
  BatchJobItem,
  BatchParamOverrides,
  BatchJob,
  RemoteInstanceConfig,
  RemoteInstanceStatus,
  MarketItem,
  RegistryPageResult
} from './batch'

export type {
  InstallStepId,
  InstallStepStatus,
  InstallStep,
  TorchChannel,
  InstallPlan,
  InstallStepByteProgress,
  InstallProgress,
  GpuCapability,
  RuntimeKind,
  RuntimeComponentStatus,
  BootstrapStatus,
  RuntimeDownloadProgress,
  StarterModel,
  ComfyUpdateInfo,
  UpdateStepId,
  UpdateStep,
  UpdateProgress,
  ComfyUpdateOptions,
  UpdateJournal
} from './installer'

export type {
  IpcResult,
  BackgroundOpKind,
  BackgroundOp,
  RegistryIndexStatus,
  IpcChannelMap,
  IpcChannel
} from './ipc'

export { IPC_CHANNELS, IPC_EVENTS } from './ipc'
