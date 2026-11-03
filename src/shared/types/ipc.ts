/** Shared IPC contract: channel map, runtime channel list, event names. */
import type { PipRecipe } from '../pipRecipes'
import type {
  AppIssue,
  AppSettings,
  AppSettingsView,
  AppUpdateStatus,
  InstanceStartupIssues,
  PreviousExitInfo,
  ProxySettingsView,
  RemoteInstanceSummary
} from './app'
import type {
  BatchJob,
  BatchParamOverrides,
  MarketItem,
  RegistryPageResult,
  RemoteInstanceConfig,
  RemoteInstanceStatus
} from './batch'
import type {
  BackupManifest,
  BackupRestorePreview,
  BackupRestoreSection,
  BackupRestoreResult
} from './backup'
import type { DoctorReport } from './doctor'
import type { EnvCreateRequest, EnvProbe, RepairEnvOptions } from './env'
import type {
  BootstrapStatus,
  ComfyUpdateInfo,
  ComfyUpdateOptions,
  GpuCapability,
  InstallPlan,
  InstallProgress,
  RuntimeComponentStatus,
  RuntimeKind,
  StarterModel,
  TorchChannel,
  UpdateJournal,
  UpdateProgress
} from './installer'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  DiagnosticPackage,
  InstanceActionResult,
  InstanceCapabilities,
  InstanceDiscoveryCandidate,
  InstanceStopResult,
  LaunchArgTemplate,
  LaunchCommandPreview,
  LaunchOptions,
  ModelReconcileResult,
  NodeLoadReport,
  PortCheckResult
} from './instance'
import type {
  DownloadTask,
  DuplicateGroup,
  ModelRecord,
  OutputAsset,
  OutputAssetMatch,
  StorageStats
} from './model'
import type {
  ComfyJobSummary,
  ComfyLogLine,
  ExecFailure,
  PipOpResult,
  QueueSnapshot,
  SystemSnapshot
} from './monitor'
import type {
  NodeDepsAudit,
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  NodeRecoveryEntry,
  NodeSnapshot,
  NodeUpdateAllOptions,
  NodeUpdateAllResult,
  NodeUpdateCheckResult,
  RegistryNodePack
} from './node'
import type {
  BatchPreflight,
  WorkflowCompareResult,
  WorkflowModelPreflight,
  WorkflowPreflight,
  WorkflowRecord
} from './workflow'

// ---------- IPC ----------
export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** Machine-readable error code (e.g. PORT_IN_USE) */
  code?: string
  /** When code is PORT_IN_USE, a free port the UI may offer */
  suggestedPort?: number
  /** 0.2.0: localizable error message (renderer falls back to `error`). */
  messageKey?: string
  params?: Record<string, string | number>
  /** Extra diagnostic text safe to show in a details disclosure. */
  detail?: string
  /** True when retrying the same call can succeed (network/timeout/busy). */
  retryable?: boolean
}

/** 0.1.18 (WP5): a long-running operation visible in the shell task center. */
export type BackgroundOpKind =
  | 'install'
  | 'comfy-update'
  | 'env-repair'
  | 'node-op'
  | 'node-batch'
  | 'batch'
  | 'output-scan'
  | 'registry-index'

export interface BackgroundOp {
  id: string
  kind: BackgroundOpKind
  /** Instance id, `remote:<id>`, a batch job id or 'local'. */
  target: string
  /** Optional context (pack name / batch name). */
  title?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** 0..100, or null when the op has no real denominator. */
  percent: number | null
  detail: string
  cancellable: boolean
  startedAt: number
  finishedAt?: number
  error?: string
  /** Update/install run identity, when the underlying service has one. */
  runId?: string
}

/** Full-catalog index status (0.1.18: exposes live crawl progress). */
export interface RegistryIndexStatus {
  ready: boolean
  updatedAt: number
  total: number
  pages: number
  count: number
  skippedPages?: number
  /** True while a full crawl is running in this process. */
  building?: boolean
  /** Pages fetched so far / total pages (only meaningful while building). */
  done?: number
  totalPages?: number
}

export type IpcChannelMap = {
  // settings
  'settings.get': { args: []; result: AppSettingsView }
  'settings.set': { args: [Partial<AppSettings>]; result: AppSettingsView }
  'settings.setProxyPassword': { args: [string]; result: { ok: boolean } }
  'settings.clearProxyPassword': { args: []; result: { ok: boolean } }
  /** 0.1.18 (WP1/S6): which stored secrets need re-entry (undecryptable). */
  'settings.exportConfig': {
    args: []
    result: {
      version: number
      schemaVersion: number
      exportedAt: number
      settings: Partial<AppSettings>
    }
  }
  'settings.importConfig': {
    args: [Record<string, unknown>]
    result: { settings: AppSettingsView; applied: string[]; warnings?: string[] }
  }
  'settings.credentialStatus': {
    args: []
    result: {
      proxyPasswordUnreadable: boolean
      proxyCredentialBackend: ProxySettingsView['backend']
      lockedRemoteIds: string[]
    }
  }
  'data.migrationState': {
    args: []
    result: { ok: boolean; snapshot?: string; migratedFiles: number; error?: string }
  }
  'data.retryMigration': {
    args: []
    result: { ok: boolean; snapshot?: string; migratedFiles: number; error?: string }
  }
  'issue.list': { args: [boolean?]; result: AppIssue[] }
  'issue.scan': { args: [string?]; result: AppIssue[] }
  'issue.dismiss': { args: [string]; result: AppIssue | null }
  'issue.restore': { args: [string]; result: AppIssue | null }
  'issue.resolve': { args: [string]; result: AppIssue | null }
  'issue.installModule': { args: [string]; result: { ok: boolean; message: string } }
  'issue.cleanLeftover': { args: [string]; result: { ok: boolean; message: string } }
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
  'instance.launchArgCatalog': { args: [string?]; result: string[] }
  'instance.migratePython': {
    args: [string]
    result: {
      ok: boolean
      instanceId: string
      venvPath: string
      fromVersion: string
      toVersion: string
      channel: string
      archivedVenv?: string
      warnings: string[]
    }
  }
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
  /** 0.1.18 (WP3/L7): abort a running environment repair (pip can take 30 min). */
  'instance.repairCancel': { args: []; result: boolean }
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
  /** 0.1.18 (WP7): move a queued download ahead of the rest. */
  'model.prioritizeDownload': { args: [string]; result: DownloadTask }
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
  'registry.indexStatus': { args: []; result: RegistryIndexStatus }
  'registry.refreshIndex': { args: []; result: RegistryIndexStatus }
  'registry.ensureIndex': { args: [{ force?: boolean }?]; result: RegistryIndexStatus }
  /** 0.1.18 (WP4/F6): abort an in-flight full-catalog crawl. */
  'registry.cancelIndex': { args: []; result: boolean }
  /** 0.1.18 (WP5): shell task center. */
  'ops.list': { args: []; result: BackgroundOp[] }
  'ops.cancel': { args: [string]; result: boolean }
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
  'node.installDeps': { args: [string, string?, string[]?]; result: PipOpResult }
  /** Current node-op snapshot (modal hydration after renderer reloads). */
  'node.opStatus': { args: [string?]; result: UpdateProgress | null }
  /** 0.1.18 (WP3): leftovers from an interrupted update (.bak-/._unzip_tmp_). */
  'node.recoveryScan': { args: [string?]; result: NodeRecoveryEntry[] }
  'node.recoveryRestore': { args: [string, string?]; result: NodeRecoveryEntry }
  'node.recoveryClean': { args: [string, string?]; result: boolean }
  'node.recoveryCleanAll': {
    args: [string?]
    result: { removed: number; failed: string[] }
  }

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
  /** 0.1.18 (WP7): which model files this workflow needs and which are absent. */
  'workflow.checkModels': { args: [string, string?]; result: WorkflowModelPreflight }
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
  /** 0.1.18 (WP7): 10-minute CPU/RAM/VRAM series (2 s cadence, capped 300). */
  'monitor.series': {
    args: []
    result: Array<{ ts: number; cpu: number; ram: number; vram: number }>
  }
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
  /** 0.1.18 (WP6): abort a running health check at the next probe boundary. */
  'doctor.cancel': { args: []; result: boolean }
  'doctor.fix': { args: [string, string]; result: { ok: boolean; message: string } }

  // backup
  'backup.list': { args: []; result: BackupManifest[] }
  'backup.create': { args: [{ name: string; notes?: string }]; result: BackupManifest }
  'backup.preview': {
    args: [string]
    result: BackupRestorePreview
  }
  'backup.restore': {
    args: [string, { sections?: BackupRestoreSection[] }?]
    result: BackupRestoreResult
  }
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
      { installRoot: string; useUv: boolean; pythonPath?: string; torchChannel?: TorchChannel }
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
  'bootstrap.deleteLegacy': {
    args: []
    result: { removed: string[]; failed: string[] }
  }

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
  'output.thumb': { args: [string]; result: { url?: string } }
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
  'remote.list': { args: []; result: RemoteInstanceSummary[] }
  'remote.save': { args: [RemoteInstanceConfig]; result: RemoteInstanceSummary }
  'remote.setApiKey': { args: [string, string]; result: { ok: boolean } }
  'remote.clearApiKey': { args: [string]; result: { ok: boolean } }
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
  'backup.preview',
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
  'bootstrap.deleteLegacy',
  'bootstrap.ensure',
  'bootstrap.status',
  'deps.recipes',
  'doctor.cancel',
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
  'instance.repairCancel',
  'instance.repairEnv',
  'instance.repairStatus',
  'instance.restart',
  'instance.runStartupSelfCheck',
  'instance.launchArgCatalog',
  'instance.migratePython',
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
  'model.prioritizeDownload',
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
  'monitor.series',
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
  'node.recoveryClean',
  'node.recoveryCleanAll',
  'node.recoveryRestore',
  'node.recoveryScan',
  'node.refresh',
  'node.restoreSnapshot',
  'node.smokeTest',
  'node.snapshots',
  'node.toggle',
  'node.uninstall',
  'node.uninstallDeps',
  'node.update',
  'node.updateAll',
  'output.thumb',
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
  'registry.cancelIndex',
  'ops.cancel',
  'ops.list',
  'registry.ensureIndex',
  'registry.indexStatus',
  'registry.refreshIndex',
  'remote.freeMemory',
  'remote.list',
  'remote.clearApiKey',
  'remote.listStatus',
  'remote.remove',
  'remote.save',
  'remote.setApiKey',
  'remote.test',
  'settings.dataDir',
  'data.migrationState',
  'data.retryMigration',
  'issue.cleanLeftover',
  'issue.dismiss',
  'issue.installModule',
  'issue.list',
  'issue.resolve',
  'issue.restore',
  'issue.scan',
  'settings.get',
  'settings.launchTemplates',
  'settings.logsDir',
  'settings.credentialStatus',
  'settings.exportConfig',
  'settings.importConfig',
  'settings.set',
  'settings.setProxyPassword',
  'settings.clearProxyPassword',
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
  'workflow.checkModels',
  'workflow.preflight',
  'workflow.queue',
  'workflow.rename',
  'workflow.reveal',
  'workflow.tag'
] as const

export const IPC_EVENTS = {
  instanceStatus: 'event:instance-status',
  instanceLog: 'event:instance-log',
  /** Batched log lines (0.2.0) — one IPC message per 100ms instead of per line. */
  instanceLogBatch: 'event:instance-log-batch',
  /** IssueCenter changed (0.2.0) — payload: AppIssue[]. */
  issuesChanged: 'event:issues-changed',
  modelScanProgress: 'event:model-scan-progress',
  downloadProgress: 'event:download-progress',
  monitorTick: 'event:monitor-tick',
  monitorWs: 'event:monitor-ws',
  doctorProgress: 'event:doctor-progress',
  batchProgress: 'event:batch-progress',
  nodeInstallProgress: 'event:node-install-progress',
  installProgress: 'event:install-progress',
  registryIndexProgress: 'event:registry-index-progress',
  /** A background operation changed (one op per event, 0.1.18 WP5). */
  opChanged: 'event:op-changed',
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
