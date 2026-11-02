/** Shared batch job + remote instance + plugin market types. */

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
  /** 0.2.0: base URL the apiKey was entered for; a changed endpoint clears it. */
  credentialOrigin?: string
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
  /**
   * 0.1.18 (WP4/F6): search needs the local full-catalog index, which is NOT
   * built implicitly. The UI offers to build it (with progress + cancel).
   */
  needsIndex?: boolean
}
