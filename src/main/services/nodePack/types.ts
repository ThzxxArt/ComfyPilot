import type { NodePackRecord, UpdateStepId } from '@shared/types'

/** Internal pack metadata parsed from disk. */
export type PackMeta = Partial<NodePackRecord> & { nodeList?: string[] }

/** One running "update all" batch, keyed per instance. */
export interface OpBatchState {
  batchId: string
  index: number
  total: number
  current?: string
  cancelled: boolean
}

export interface InstallOptions {
  id: string
  version?: string
  source: 'registry' | 'git' | 'manager'
  url?: string
  branch?: string
  instanceId?: string
  /** Known repository URL from search results — fallback when /install API returns 401. */
  repository?: string
}

export interface InstallInternalOptions {
  /**
   * Keep the CURRENT stream (runId + steps) instead of starting a new one.
   * Used by updateInner's registry path: the reinstall is the middle of an
   * update op and must not reset the modal mid-flight.
   */
  reuseStream?: boolean
  /** Reuse the outer op's abort signal instead of arming a new controller. */
  signal?: AbortSignal
}

export interface InstallInnerOptions {
  id: string
  version?: string
  source: 'registry' | 'git' | 'manager'
  url?: string
  branch?: string
  instanceId?: string
  /** Registry/manager catalog id — preserved as record.registryId even on the git transport. */
  registryId?: string
  /** Known repository URL from search results — fallback when /install API returns 401. */
  repository?: string
  signal?: AbortSignal
}

export interface AfterInstallExtra {
  pinnedVersion?: string
  installNote?: string
  signal?: AbortSignal
}

export interface InstallProgressPayload {
  phase: 'start' | 'download' | 'unzip' | 'pip' | 'done' | 'error'
  packName: string
  message?: string
  /** What kind of operation this is — the UI labels install vs update differently. */
  op?: 'install' | 'update' | 'uninstall'
  /** Stream owner so the renderer's banner never shows another instance's pack. */
  instanceId?: string
}

/** Relative weights of the fixed node-op steps — percent advances mid-step. */
export const STEP_WEIGHTS: ReadonlyArray<[UpdateStepId, number]> = [
  ['download', 15],
  ['clone', 25],
  ['unpack', 15],
  ['requirements', 35],
  ['verify', 5],
  ['done', 5]
]
