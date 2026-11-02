/** Shared workflow library + preflight types. */

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

/** Workflow preflight against /object_info (0.1.12, WP6). */
/** 0.1.18 (WP7): model files a workflow needs vs the local index. */
export interface WorkflowModelRequirement {
  name: string
  nodeType: string
  /** Input key (ckpt_name/lora_name/…) used to disambiguate model categories. */
  inputKey?: string
  category?: string
  present: boolean
  /** Local basename that matched, when present (helps explain subfolders). */
  matchedFile?: string
}

export interface WorkflowModelPreflight {
  available: boolean
  required: number
  present: number
  missing: WorkflowModelRequirement[]
  error?: string
}

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
