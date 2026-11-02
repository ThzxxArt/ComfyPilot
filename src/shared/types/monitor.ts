/** Shared monitor/telemetry types: system, queue, logs, execution progress. */

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
  /** Requested names still not present after the install (0.2.0 receipt). */
  unresolved?: string[]
  cancelled?: boolean
  error?: string
  /** Non-fatal caveat (e.g. installed but not listed by pip show). */
  warning?: string
}
