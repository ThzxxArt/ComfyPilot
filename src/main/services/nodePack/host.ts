import type {
  NodeDepsAudit,
  NodeLoadReport,
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  NodeRecoveryEntry,
  NodeSnapshot,
  NodeUpdateAllOptions,
  NodeUpdateAllResult,
  NodeUpdateBatchEvent,
  NodeUpdateCheckResult,
  PipOpResult,
  RegistryNodePack,
  RegistryPageResult,
  UpdateProgress,
  UpdateStepId
} from '@shared/types'
import type {
  AfterInstallExtra,
  InstallInnerOptions,
  InstallInternalOptions,
  InstallOptions,
  InstallProgressPayload,
  OpBatchState
} from './types'

/**
 * Public surface merged into the NodePackService class type. Kept separate
 * from NodePackHost so the class does not advertise its internal helpers.
 */
export interface NodePackPublicApi {
  isOpActive(instanceId?: string): boolean
  cancelOp(instanceId?: string): boolean
  cancelUpdateBatch(instanceId?: string): boolean
  getOpProgress(instanceId?: string): UpdateProgress | null
  list(instancePathOrId?: string): NodePackRecord[]
  refresh(instancePathOrId?: string): Promise<NodePackRecord[]>
  managerChannelList(): Promise<RegistryNodePack[]>
  registrySearch(opts?: {
    query?: string
    limit?: number
    page?: number
  }): Promise<RegistryPageResult<RegistryNodePack>>
  install(opts: InstallOptions, internal?: InstallInternalOptions): Promise<NodePackRecord>
  pipDeps(idOrName: string, instanceId?: string): string[]
  uninstall(
    idOrName: string,
    instanceId?: string,
    opts?: { removePipDeps?: boolean }
  ): Promise<boolean>
  checkUpdates(instancePathOrId?: string): Promise<NodeUpdateCheckResult[]>
  updateAll(instancePathOrId?: string, opts?: NodeUpdateAllOptions): Promise<NodeUpdateAllResult[]>
  update(
    idOrName: string,
    version?: string,
    instanceId?: string,
    internal?: { fromBatch?: boolean }
  ): Promise<NodePackRecord>
  toggle(idOrName: string, enabled: boolean, instanceId?: string): NodePackRecord | undefined
  lock(idOrName: string, locked: boolean, instanceId?: string): NodePackRecord | undefined
  checkIssues(idOrName: string, instanceId?: string): NodePackIssue[]
  loadReport(instanceId?: string): NodeLoadReport | null
  depsAudit(instanceId?: string): Promise<NodeDepsAudit>
  installDeps(idOrName: string, instanceId?: string, specs?: string[]): Promise<PipOpResult>
  conflicts(instanceId?: string): NodeNameConflict[]
  smokeTest(idOrName: string, instanceId?: string): Promise<NodePackIssue[]>
  snapshots(instanceId?: string): NodeSnapshot[]
  createSnapshot(name?: string, instanceId?: string): NodeSnapshot
  restoreSnapshot(id: string, instanceId?: string): boolean
  deleteSnapshot(id: string, instanceId?: string): boolean
  scanRecovery(instanceId?: string): NodeRecoveryEntry[]
  quarantineTransients(instanceId?: string): string[]
  restoreRecovery(name: string, instanceId?: string): NodeRecoveryEntry
  cleanRecovery(name: string, instanceId?: string): boolean
  cleanAllRecovery(instanceId?: string): { removed: number; failed: string[] }
}

/**
 * `this` contract shared by the domain mixins. It intentionally includes the
 * cross-domain helpers each module calls; the concrete fields live once on
 * the NodePackService class in index.ts.
 */
export interface NodePackHost extends NodePackPublicApi {
  opProgressMap: Map<string, UpdateProgress & { updatedAt?: number }>
  opBatches: Map<string, OpBatchState>
  opAborts: Map<string, AbortController>
  listCache: Map<string, { sig: string; packs: NodePackRecord[] }>

  emit(event: string | symbol, ...args: unknown[]): boolean

  emitInstallProgress(payload: InstallProgressPayload): void
  beginOpAbort(instanceId?: string): AbortSignal
  endOpAbort(instanceId?: string): void
  emitBatch(payload: Omit<NodeUpdateBatchEvent, 'ts'>): void
  progressSnapshot(p: UpdateProgress): UpdateProgress
  computePercent(p: UpdateProgress): number
  resetOpSteps(key: string, packName?: string): void
  emitOpProgress(opts: {
    instanceId: string
    step: UpdateStepId
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
    message: string
    logLine?: string
    detailKey?: string
    packName?: string
  }): void
  attachBatchContext(key: string, p: UpdateProgress): void
  setStepFraction(step: UpdateStepId, fraction: number, instanceId?: string): void
  setStepMessage(step: UpdateStepId, message: string, instanceId?: string): void
  opLog(line: string, instanceId?: string): void

  listSignature(root: string, known: Map<string, NodePackRecord>): string
  assertInstallAllowed(source: 'registry' | 'git' | 'manager'): void
  installInner(opts: InstallInnerOptions): Promise<NodePackRecord>
  afterInstall(
    dir: string,
    source?: 'registry' | 'git' | 'manager' | 'local',
    registryId?: string,
    instanceId?: string,
    extra?: AfterInstallExtra
  ): Promise<NodePackRecord>
  removePipDeps(names: string[], instanceId?: string, signal?: AbortSignal): Promise<string[]>
  resolveRemovalTargets(packPath: string, instanceId?: string): string[]
  checkOnePack(
    pack: NodePackRecord,
    registryLatest: Map<string, string>,
    registryMatch?: { id?: string; latestVersion?: string }
  ): Promise<NodeUpdateCheckResult>
  persistCheck(pack: NodePackRecord, latestVersion?: string, registryId?: string): void
  gitRunStreaming(
    gitBin: string,
    args: string[],
    instanceId: string | undefined,
    opts: { timeout: number; onPercent?: (pct: number) => void; signal?: AbortSignal }
  ): Promise<string>
  gitPullOrMerge(
    gitBin: string,
    cwd: string,
    instanceId?: string,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal
  ): Promise<void>
  updateInner(
    idOrName: string,
    version?: string,
    instanceId?: string,
    signal?: AbortSignal
  ): Promise<NodePackRecord>
  pruneAutoSnapshots(instanceId?: string): void
  scanRecoveryAt(root: string): NodeRecoveryEntry[]
  recoveryEntry(root: string, name: string): NodeRecoveryEntry | undefined
}
