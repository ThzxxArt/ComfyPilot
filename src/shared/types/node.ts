/** Shared custom-node pack types: records, audits, updates, recovery. */

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
  /**
   * Honest note when the requested version could not be applied (0.1.17).
   * The record then keeps the on-disk `version` and does NOT set
   * `pinnedVersion`, so the UI can show what actually landed.
   */
  installNote?: string
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

/**
 * 0.1.18 (WP3 / L9): a leftover inside `custom_nodes/` that a crashed or
 * cancelled update left behind. Backups (`.bak-<ts>`) hold a real previous
 * version and can be restored; temp unzip dirs and duplicate `.disabled`
 * copies can only be cleaned.
 */
export type NodeRecoveryKind = 'backup' | 'temp' | 'duplicate' | 'trash'

export interface NodeRecoveryEntry {
  kind: NodeRecoveryKind
  /** On-disk entry name inside `custom_nodes/` (a single path segment). */
  name: string
  /** Package name a backup belongs to ('' for temp/duplicate entries). */
  packName: string
  /** Absolute path of the leftover entry. */
  path: string
  /** Where the pack would live after a restore. */
  livePath: string
  /** True when a pack already occupies `livePath`. */
  liveExists: boolean
  mtimeMs: number
  /** Approximate on-disk size (bounded walk; 0 when unreadable). */
  sizeBytes?: number
}

/** Per-pack dependency audit entry (0.1.12). */
export interface NodeDepsAuditPack {
  id: string
  name: string
  declared: string[]
  missing: string[]
  mismatched: Array<{ name: string; required: string; installed: string }>
  /** 0.2.0: markers that evaluate to false/unknown (not missing). */
  skipped?: string[]
  /** 0.2.0: URL/VCS/editable lines the lightweight audit cannot prove. */
  unsupported?: string[]
}

/** Node-pack dependency audit result (requirements.txt vs venv pip list). */
export interface NodeDepsAudit {
  ok: boolean
  pipAvailable: boolean
  checkedPacks: number
  packs: NodeDepsAuditPack[]
  error?: string
  /** 0.2.0: `pip check` conflicts (transitive, not just declared). */
  pipCheck?: { ok: boolean; broken: string[] }
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
  /** Git packs: commits behind the upstream ref (0.1.11 — honest "latest" signal). */
  behindCount?: number
}

export interface NodeUpdateAllOptions {
  /**
   * Also attempt packs whose pre-check failed (git fetch timeout etc.).
   * Default false in main; the UI opts in explicitly (0.1.11).
   */
  includeCheckFailed?: boolean
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
