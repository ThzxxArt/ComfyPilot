<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  ExtensionPuzzleOutline,
  RefreshOutline,
  WarningOutline,
  CheckmarkCircleOutline,
  LockClosedOutline,
  LockOpenOutline,
  GitBranchOutline,
  SearchOutline,
  CloudDownloadOutline,
  ArrowUpCircleOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NSpace,
  NSpin,
  NTag,
  NSwitch,
  NEmpty,
  useMessage,
  useDialog,
  NCollapse,
  NCollapseItem,
  NInput,
  NModal,
  NPopconfirm,
  NCheckbox,
  NTabs,
  NTabPane,
  NTooltip
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import {
  useComfyUpdate,
  describeNodeError,
  hasDepsSkippedIssue
} from '@/composables/useComfyUpdate'
import { usePipOps } from '@/composables/usePipOps'
import NodeOpProgressModal from '@/components/NodeOpProgressModal.vue'
import { useAppStore } from '@/stores/app'
import { packLoadStatusOf, packLoadFailureOf, type PackLoadStatus } from '@shared/nodeLoadReport'
import type {
  NodeCheckStatus,
  NodeDepsAudit,
  NodeDepsAuditPack,
  NodeLoadReport,
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  NodeSnapshot,
  NodeUpdateCheckResult
} from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const router = useRouter()
const route = useRoute()
const message = useMessage()
const dialog = useDialog()
const {
  startPackDeps,
  activeInstances: pipActiveInstances,
  modalVisible: pipModalVisible,
  viewedInstanceId: pipViewedInstanceId,
  openFor: openPipFor,
  refreshStatus: refreshPipStatus
} = usePipOps()

/** Dependency installs (0.1.12) — banner + reopen entry on this page too. */
const pipBannerVisible = computed(
  () =>
    Boolean(store.activeInstanceId) &&
    pipActiveInstances.value.includes(store.activeInstanceId || '') &&
    (!pipModalVisible.value || pipViewedInstanceId.value !== store.activeInstanceId)
)
function openPipProgress(): void {
  if (store.activeInstanceId) void openPipFor(store.activeInstanceId)
}
const {
  nodeUpdatingPack,
  nodeInstallingPack,
  nodeUpdateMessage,
  nodeInstallMessage,
  nodeBatchActive,
  nodeBatch,
  nodeCheck,
  selectNodeOpInstance
} = useComfyUpdate()

// Auto-refresh when a background install/update finishes — the user should not
// have to hit Refresh to see a pack that just landed.
watch(
  () => [nodeUpdatingPack.value, nodeInstallingPack.value],
  ([wasUpdating, wasInstalling], [prevUpdating, prevInstalling]) => {
    const finished = (prevUpdating && !wasUpdating) || (prevInstalling && !wasInstalling)
    if (finished) void refresh()
  }
)
const loading = ref(false)
const packs = ref<NodePackRecord[]>([])
const conflicts = ref<NodeNameConflict[]>([])
const snapshots = ref<NodeSnapshot[]>([])
const installedQuery = ref('')
const showInstall = ref(false)
const showOpModal = ref(false)
const opModalTitle = ref('')
const opModalMode = ref<'single' | 'batch'>('single')
const installUrl = ref('')
const installBranch = ref('')
const tab = ref('installed')
const checks = ref<Record<string, NodeUpdateCheckResult>>({})
const checking = ref(false)
const updatingOne = ref<string | null>(null)
const lockingOne = ref<string | null>(null)
const batchRunning = ref(false)
/** "Update all" also retries packs whose pre-check failed (default on, 0.1.11). */
const includeCheckFailed = ref(true)
// node.checkIssues modal state
const showIssues = ref(false)
const issuesLoading = ref(false)
/** Identity used for the per-card spinner — must be unique (name is). */
const issuesPackId = ref('')
/** Display title for the modal. */
const issuesPackTitle = ref('')
const issuesList = ref<NodePackIssue[]>([])
/** Boot-log load report (0.1.10) — what ComfyUI actually loaded last start. */
const loadReport = ref<NodeLoadReport | null>(null)
const selfChecking = ref(false)
/** Filter toggle: show only packs that failed to load on the last boot. */
const loadFailedOnly = ref(false)
const loadFailedCount = computed(
  () =>
    packs.value.filter(
      (p) => packLoad(p) === 'import-failed' || packLoad(p) === 'prestartup-failed'
    ).length
)

/** Folder identity for load-report matching (`.disabled` forms normalized). */
function packFolder(pack: NodePackRecord): string {
  const base =
    (pack.path || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || ''
  return base.endsWith('.disabled') ? base.slice(0, -'.disabled'.length) : base
}

function packLoad(pack: NodePackRecord): PackLoadStatus {
  // Disabled packs are never loaded by ComfyUI — do not badge them as failed.
  if (pack.status === 'disabled') return 'unknown'
  return packLoadStatusOf(packFolder(pack), loadReport.value)
}

function packLoadError(pack: NodePackRecord): string {
  return packLoadFailureOf(packFolder(pack), loadReport.value)?.error || ''
}

const loadSummary = computed(() => {
  const entries = loadReport.value?.available ? loadReport.value.entries : null
  if (!entries) return null
  const fail = entries.filter((e) => !e.ok).length
  return { ok: entries.length - fail, fail }
})

/** One-click boot self-check: ComfyUI loads every custom node then exits.
 *  0.1.11: a running instance no longer blocks it (own ephemeral port). */
async function runSelfCheck(): Promise<void> {
  const inst = store.activeInstance
  if (!inst) return
  if (inst.status === 'running' || inst.status === 'starting') {
    message.info(t('nodes.selfCheckConcurrent'))
  }
  selfChecking.value = true
  try {
    const r = await ipc('instance.runStartupSelfCheck', inst.id)
    if (r.ok) message.success(t('nodes.selfCheckPassed'))
    else message.error(t('nodes.selfCheckFailed', { code: r.exitCode ?? '?' }))
    try {
      loadReport.value = await ipc('node.loadReport', inst.id)
    } catch {
      /* keep the previous report */
    }
  } catch (err) {
    message.error(describeNodeError(t, err))
  } finally {
    selfChecking.value = false
  }
}

/** Card title: fall back to the directory name when displayName is empty. */
function packTitle(pack: NodePackRecord): string {
  return pack.displayName || pack.name
}

/** Localized pack status tag (raw enums must never leak to the UI). */
function packStatusLabel(pack: NodePackRecord): string {
  if (pack.status === 'disabled') return t('nodes.disabled')
  if (pack.status === 'error') return t('nodes.sevError')
  if (pack.status === 'not-installed') return t('nodes.statusNotInstalled')
  if (pack.status === 'installing') return t('nodes.statusInstalling')
  return t('nodes.enabled')
}

/** Localized install source tag. */
function packSourceLabel(pack: NodePackRecord): string {
  switch (pack.installSource) {
    case 'registry':
      return t('nodes.sourceRegistry')
    case 'git':
      return t('nodes.sourceGit')
    case 'manager':
      return t('nodes.sourceManager')
    case 'local':
      return t('nodes.sourceLocal')
    default:
      return String(pack.installSource || '—')
  }
}

function clearSearch(): void {
  installedQuery.value = ''
}

const filteredPacks = computed(() => {
  let list = packs.value
  if (loadFailedOnly.value) {
    list = list.filter(
      (p) => packLoad(p) === 'import-failed' || packLoad(p) === 'prestartup-failed'
    )
  }
  const q = installedQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((p) =>
    [p.name, p.displayName, p.description, ...(p.tags || [])].join(' ').toLowerCase().includes(q)
  )
})

/** True when the pack has a newer version available. Trust the check result first. */
function hasUpdatePack(pack: NodePackRecord): boolean {
  // Disabled packs are intentionally not updatable (a registry reinstall would
  // silently re-enable them) — never light the badge or include them in "update all".
  if (pack.status === 'disabled') return false
  const c = checks.value[pack.id]
  if (c) return Boolean(c.updatable)
  // 0.1.11: the old direct `latestVersion` fallback was REMOVED. Only two
  // facts may light the badge now — a fresh check result, or the main
  // process's own direction-aware status from list(). Rows without a check
  // show "not checked" instead of a guess.
  return pack.status === 'update-available'
}

/** Update badge text: honest commit distance for git packs (0.1.11). */
function updateBadgeText(pack: NodePackRecord): string {
  const c = checks.value[pack.id]
  if (c?.updateSource === 'git' && typeof c.behindCount === 'number' && c.behindCount > 0) {
    return t('nodes.behindCommits', { n: c.behindCount })
  }
  return t('nodes.hasUpdate', { version: pack.latestVersion || pack.version })
}

/**
 * Whether auto-update is supported at all (git / registry).
 * local packs, and manager packs without a git remote, cannot be updated.
 */
function canUpdatePack(pack: NodePackRecord): boolean {
  if (pack.locked) return false
  // Disabled packs must be enabled first (update would silently re-enable them).
  if (pack.status === 'disabled') return false
  const c = checks.value[pack.id]
  if (c) return c.updateSource === 'git' || c.updateSource === 'registry'
  if (pack.installSource === 'git') return true
  if (pack.installSource === 'registry' && pack.registryId) return true
  // manager packs only when they look like a git checkout
  if (pack.installSource === 'manager') {
    return Boolean(pack.repository && /\.git($|\s)|github\.com/i.test(pack.repository))
  }
  return false
}

const updatablePacks = computed(() => packs.value.filter(hasUpdatePack))

function describeUpdateError(err: unknown, _pack?: NodePackRecord): string {
  const msg = err instanceof Error ? err.message : String(err)
  const backup = /backup at (.+)$/i.exec(msg)
  if (/rollback (also failed|FAILED)/i.test(msg) && backup) {
    return t('nodes.rollbackFailed', { path: backup[1].trim() })
  }
  // Only claim a rollback when the message actually says one happened — a
  // plain registry/network error must NOT read as "rolled back".
  if (/rolled back/i.test(msg)) {
    return t('nodes.rolledBack')
  }
  return t('nodes.updateFailed', { error: msg })
}

// 0.1.9: the node-op modal NEVER auto-closes. Success and failure both keep
// it open with the final log; the user closes it manually (ComfyUI-Manager
// terminal behaviour). The banner below can reopen it while an op runs.

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const instId = store.activeInstanceId || undefined
    packs.value = await ipc('node.refresh', instId)
    conflicts.value = await ipc('node.conflicts', instId)
    snapshots.value = await ipc('node.snapshots', instId)
    try {
      loadReport.value = await ipc('node.loadReport', instId)
    } catch {
      loadReport.value = null
    }
    // Restore dependency-install banner/modal state (0.1.12).
    if (instId) void refreshPipStatus(instId)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function checkUpdates(): Promise<void> {
  checking.value = true
  nodeCheck.value = null
  const forInst = store.activeInstanceId || undefined
  try {
    const results = await ipc('node.checkUpdates', forInst)
    // The user may have switched instances while the pass ran — results belong
    // to the old instance and must not relabel/overwrite the new one's state.
    if ((store.activeInstanceId || undefined) !== forInst) return
    const map: Record<string, NodeUpdateCheckResult> = {}
    for (const r of results) {
      map[r.id] = r
      const pack = packs.value.find((p) => p.name === r.name || p.id === r.id)
      if (pack) {
        // Only trust a reported version when the update is CONFIRMED (0.1.11):
        // an unconfirmed value (stale shallow tag / failed fetch) must not
        // overwrite the stored latestVersion and light a false badge.
        if (r.updatable && r.latestVersion) pack.latestVersion = r.latestVersion
        if (r.updatable) pack.status = 'update-available'
      }
    }
    checks.value = map
    // "All up to date" is only honest when every check actually completed.
    const anyFailed = results.some((r) => r.checkStatus === 'check-failed')
    if (!results.some((r) => r.updatable) && !anyFailed) {
      message.info(t('nodes.upToDate'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    checking.value = false
  }
}

/** Counts of every check outcome so "couldn't check" is visible at a glance. */
const checkSummary = computed(() => {
  const out: Record<NodeCheckStatus, number> = {
    updatable: 0,
    'up-to-date': 0,
    unsupported: 0,
    'check-failed': 0,
    'skipped-disabled': 0,
    locked: 0
  }
  for (const r of Object.values(checks.value)) out[r.checkStatus] = (out[r.checkStatus] || 0) + 1
  return out
})

/** Check-failed packs the "try anyway" option can still reach (0.1.11) —
 *  keeps "update all" clickable when a flaky fetch is the ONLY finding. */
const checkFailRetryable = computed(
  () => includeCheckFailed.value && checkSummary.value['check-failed'] > 0
)

/** Per-card check reason (tooltip) — never blank when a check ran. */
function checkReason(pack: NodePackRecord): string {
  const c = checks.value[pack.id]
  if (!c) return ''
  return c.reasonKey ? t(c.reasonKey) : c.reason || ''
}

function checkFailed(pack: NodePackRecord): boolean {
  return checks.value[pack.id]?.checkStatus === 'check-failed'
}

/** A pack that just updated successfully IS up to date — flip its check row
 *  in place so the summary counters move (0.1.11.1: dropping the row left
 *  "已最新 N" frozen and re-lit the "待检查" badge on just-updated packs). */
function markPackUpdated(pack: NodePackRecord): void {
  const current = checks.value[pack.id]
  if (!current) return
  checks.value = {
    ...checks.value,
    [pack.id]: {
      ...current,
      updatable: false,
      checkStatus: 'up-to-date',
      latestVersion: pack.version,
      reason: undefined,
      reasonKey: 'nodes.upToDate'
    }
  }
}

async function updatePack(pack: NodePackRecord): Promise<void> {
  updatingOne.value = pack.name
  opModalTitle.value = t('nodes.updating')
  opModalMode.value = 'single'
  showOpModal.value = true
  try {
    // Pass the unique id (not the name): duplicate names can exist on disk
    // (e.g. `Foo` + `.disabled/Foo`) and name lookup would be ambiguous.
    await ipc('node.update', pack.id, undefined, store.activeInstanceId || undefined)
    message.success(t('nodes.updateDone', { name: pack.displayName || pack.name }))
    await refresh()
    // The pack is now up to date — flip its check row (0.1.11.1). Prefer the
    // stable path-derived id; a registry reinstall may have renamed the folder,
    // so fall back to the (usually stable) pack name.
    const refreshed =
      packs.value.find((p) => p.id === pack.id) || packs.value.find((p) => p.name === pack.name)
    if (refreshed) markPackUpdated(refreshed)
  } catch (err) {
    // The modal stays open (0.1.9): it holds the full failure log + rollback
    // state. Only a toast summarizes the error. OP_BUSY means nothing started,
    // so the stale stream must not stay on screen.
    const code = (err as { code?: string })?.code
    if (code === 'OP_BUSY') showOpModal.value = false
    message.error(code ? describeNodeError(t, err) : describeUpdateError(err, pack))
  } finally {
    updatingOne.value = null
  }
}

async function updateAllPacks(): Promise<void> {
  batchRunning.value = true
  opModalTitle.value = t('nodes.updateAll')
  opModalMode.value = 'batch'
  showOpModal.value = true
  try {
    const results = await ipc('node.updateAll', store.activeInstanceId || undefined, {
      includeCheckFailed: includeCheckFailed.value
    })
    const ok = results.filter((r) => r.ok && !r.skipped).length
    const fail = results.filter((r) => !r.ok && !r.skipped).length
    const skip = results.filter((r) => r.skipped).length
    const checkFailed = results.filter((r) => r.skipped && r.checkStatus === 'check-failed').length
    const cancelled = results.some((r) => !r.ok && r.skipped && r.error === 'cancelled')
    const summary =
      t('nodes.batchDone', { ok, fail, skip }) +
      (checkFailed ? ` — ${t('nodes.batchCheckFailed', { n: checkFailed })}` : '')
    // The modal keeps the per-pack queue + log; a toast carries the summary.
    if (cancelled) message.warning(t('nodes.batchCancelled'))
    else if (fail > 0 || checkFailed > 0) message.warning(summary)
    else message.success(summary)
    // Flip successfully-updated packs to "up to date" AFTER the refresh so the
    // summary counters move and the "待检查" badge stays off (0.1.11.1).
    const updatedNames = new Set(results.filter((r) => r.ok && !r.skipped).map((r) => r.name))
    await refresh()
    for (const p of packs.value) {
      if (updatedNames.has(p.name)) markPackUpdated(p)
    }
  } catch (err) {
    message.error(describeNodeError(t, err))
    // Nothing started (busy) — the stale stream must not linger on screen.
    if ((err as { code?: string })?.code === 'OP_BUSY' && !nodeBatchActive.value) {
      showOpModal.value = false
    }
  } finally {
    // Check rows are per-pack facts — a half-error must not erase what the
    // earlier pass actually verified (0.1.11).
    batchRunning.value = false
  }
}

function reopenOpModal(): void {
  showOpModal.value = true
}

async function installGit(): Promise<void> {
  if (!installUrl.value.trim()) return
  opModalTitle.value = t('nodes.installing')
  opModalMode.value = 'single'
  showOpModal.value = true
  try {
    const branch = installBranch.value.trim()
    const rec = await ipc('node.install', {
      id: installUrl.value.trim(),
      source: 'git',
      url: installUrl.value.trim(),
      branch: branch || undefined,
      instanceId: store.activeInstanceId || undefined
    })
    showInstall.value = false
    installBranch.value = ''
    if (hasDepsSkippedIssue(rec?.issues)) {
      dialog.warning({
        title: t('nodes.depsNotInstalled'),
        content: `${t('nodes.depsNotInstalledBody', { name: rec?.name || installUrl.value })}\n${t('nodes.depsNotInstalledFix')}`,
        positiveText: t('common.confirm')
      })
    } else {
      message.success(t('nodes.gitInstallDone'))
    }
    await refresh()
  } catch (err) {
    // Modal stays open so the failure log remains reviewable — except OP_BUSY,
    // where the op never started and the old stream would be misleading.
    if ((err as { code?: string })?.code === 'OP_BUSY') showOpModal.value = false
    message.error(describeNodeError(t, err))
  }
}

async function toggle(pack: NodePackRecord, enabled: boolean): Promise<void> {
  try {
    await ipc('node.toggle', pack.id, enabled, store.activeInstanceId || undefined)
    await refresh()
    message.success(enabled ? t('nodes.enabled') : t('nodes.disabled'))
  } catch (err) {
    // Localize conflict errors (DISABLE_CONFLICT / ENABLE_CONFLICT) instead of
    // surfacing the English fallback text.
    message.error(describeNodeError(t, err))
  }
}

async function lockPack(pack: NodePackRecord, locked: boolean): Promise<void> {
  if (lockingOne.value) return
  lockingOne.value = pack.name
  try {
    await ipc('node.lock', pack.id, locked, store.activeInstanceId || undefined)
    await refresh()
    message.success(locked ? t('nodes.locked') : t('nodes.unlocked'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    lockingOne.value = null
  }
}

async function smoke(pack: NodePackRecord): Promise<void> {
  try {
    const issues = await ipc('node.smokeTest', pack.id, store.activeInstanceId || undefined)
    if (!issues.length) {
      message.success(t('nodes.smokePassed'))
      return
    }
    // Show EVERY issue — the old single-message toast hid all but the first.
    const hasError = issues.some((i) => i.severity === 'error')
    const text = issues.map((i) => i.message).join(' · ')
    if (hasError) message.error(text, { duration: 8000, closable: true })
    else message.warning(text, { duration: 8000, closable: true })
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Run node.checkIssues and surface the full NodePackIssue[] in a modal. */
async function checkIssues(pack: NodePackRecord): Promise<void> {
  issuesPackId.value = pack.id
  issuesPackTitle.value = packTitle(pack)
  issuesList.value = []
  showIssues.value = true
  issuesLoading.value = true
  try {
    issuesList.value = await ipc('node.checkIssues', pack.id, store.activeInstanceId || undefined)
  } catch (err) {
    showIssues.value = false
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    issuesLoading.value = false
  }
}

function issueSeverityType(sev: NodePackIssue['severity']): 'error' | 'warning' | 'info' {
  return sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info'
}

function issueSeverityLabel(sev: NodePackIssue['severity']): string {
  return sev === 'error'
    ? t('nodes.sevError')
    : sev === 'warning'
      ? t('nodes.sevWarning')
      : t('nodes.sevInfo')
}

// ---------- 0.1.12: issue fixes (fixId outlet) + dependency audit ----------
const fixingIssue = ref(false)

/** Execute a fixable issue's fixId (e.g. TORCH_PIN → unpin-torch). */
async function runIssueFix(issue: NodePackIssue): Promise<void> {
  if (!issue.fixable || !issue.fixId) return
  fixingIssue.value = true
  try {
    const r = await ipc('doctor.fix', store.activeInstanceId || '', issue.fixId)
    if (r.ok) {
      message.success(r.message)
      showIssues.value = false
      await refresh()
    } else {
      message.error(r.message)
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    fixingIssue.value = false
  }
}

const showDepsAudit = ref(false)
const depsAuditLoading = ref(false)
const depsAudit = ref<NodeDepsAudit | null>(null)

async function runDepsAudit(): Promise<void> {
  showDepsAudit.value = true
  depsAuditLoading.value = true
  depsAudit.value = null
  try {
    depsAudit.value = await ipc('node.depsAudit', store.activeInstanceId || undefined)
  } catch (err) {
    showDepsAudit.value = false
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    depsAuditLoading.value = false
  }
}

/** Reinstall one pack's requirements via the pip-op modal (0.1.13: fully
 *  error-handled — the old fire-and-forget call left OP_BUSY rejections
 *  invisible and the modal stuck as an empty 0% shell). */
async function fixPackDeps(p: NodeDepsAuditPack): Promise<void> {
  try {
    const r = await startPackDeps(store.activeInstanceId || '', p.id)
    if (r.ok) {
      // Refresh the audit so the just-installed pack leaves the missing list
      // immediately instead of still showing its removed entries.
      await runDepsAudit()
      if (r.warning) message.warning(r.warning)
      return
    }
    if (r.cancelled) return
    if (r.error) message.error(r.error)
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'OP_BUSY') {
      // A dependency install is already running — open its live progress.
      if (store.activeInstanceId) void openPipFor(store.activeInstanceId)
      message.warning(t('deps.opBusy'))
      return
    }
    if (code === 'REMOTE_NOT_SUPPORTED') {
      message.warning(t('deps.remoteUnsupported'))
      return
    }
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** ?focus=<folder> from the failure-diagnosis card pre-filters the list. */
function applyFocus(): void {
  const f = String(route.query.focus || '').trim()
  if (f) {
    installedQuery.value = f
    tab.value = 'installed'
  }
}

async function createSnapshot(): Promise<void> {
  try {
    const s = await ipc('node.createSnapshot', undefined, store.activeInstanceId || undefined)
    message.success(t('nodes.snapshotCreated', { name: s.name }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function restoreSnapshot(id: string): Promise<void> {
  try {
    await ipc('node.restoreSnapshot', id, store.activeInstanceId || undefined)
    message.success(t('nodes.snapshotRestored'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function uninstall(pack: NodePackRecord): Promise<void> {
  try {
    // List residual pip deps recorded at install time and let the user opt in
    // to removing them alongside the pack directory.
    let deps: string[] = []
    try {
      deps = await ipc('node.uninstallDeps', pack.id, store.activeInstanceId || undefined)
    } catch {
      deps = []
    }
    const run = (removePipDeps: boolean) => {
      // Same terminal-modal semantics as install/update (0.1.9): the op modal
      // stays open on success and failure until the user closes it.
      opModalTitle.value = t('nodes.uninstalling', { name: pack.displayName || pack.name })
      opModalMode.value = 'single'
      showOpModal.value = true
      return ipc('node.uninstall', pack.id, store.activeInstanceId || undefined, { removePipDeps })
        .then(async () => {
          message.success(
            removePipDeps && deps.length ? t('nodes.uninstalledWithDeps') : t('nodes.uninstalled')
          )
          await refresh()
        })
        .catch((err) => {
          if ((err as { code?: string })?.code === 'OP_BUSY') showOpModal.value = false
          message.error(describeNodeError(t, err))
        })
    }

    if (!deps.length) {
      await run(false)
      return
    }
    dialog.warning({
      title: t('nodes.uninstallDepsTitle', { name: pack.displayName || pack.name }),
      content: t('nodes.uninstallDepsBody', { name: pack.displayName || pack.name }),
      positiveText: t('nodes.uninstallWithDeps'),
      negativeText: t('nodes.uninstallKeepDeps'),
      onPositiveClick: () => run(true),
      onNegativeClick: () => run(false)
    })
  } catch (err) {
    message.error(describeNodeError(t, err))
  }
}

async function removeSnapshot(id: string): Promise<void> {
  try {
    await ipc('node.deleteSnapshot', id, store.activeInstanceId || undefined)
    message.success(t('nodes.snapshotDeleted'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => {
  applyFocus()
  selectNodeOpInstance(store.activeInstanceId || '')
  void refresh()
})

// Switching the active instance must re-scan packs/conflicts/snapshots.
watch(
  () => store.instanceSwitchTick,
  () => {
    // Check results are per-instance: stale rows would mislabel same-named
    // packs on the new instance and could enable "update all" wrongly.
    checks.value = {}
    selectNodeOpInstance(store.activeInstanceId || '')
    // Reset AFTER the select mirror — a fresh instance must not inherit the
    // previous one's check counter (0.1.11).
    nodeCheck.value = null
    void refresh()
  }
)

// Deep links (e.g. from the failure-diagnosis card) may arrive while mounted.
watch(
  () => route.query.focus,
  () => applyFocus()
)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('nodes.title') }}</h1>
        <p class="page-subtitle">{{ $t('nodes.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton secondary :loading="checking" @click="checkUpdates">
          <template #icon><NIcon :component="CloudDownloadOutline" /></template
          >{{
            checking
              ? $t('nodes.checkingProgress', {
                  done: nodeCheck?.done || 0,
                  total: nodeCheck?.total || packs.length
                })
              : $t('nodes.checkUpdates')
          }}
        </NButton>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              secondary
              :loading="selfChecking"
              :disabled="!store.activeInstance"
              @click="runSelfCheck"
            >
              {{ $t('nodes.selfCheck') }}
            </NButton>
          </template>
          {{ $t('nodes.selfCheckTip') }}
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              secondary
              :loading="depsAuditLoading"
              :disabled="!store.activeInstance"
              @click="runDepsAudit"
            >
              {{ $t('nodes.depsAudit') }}
            </NButton>
          </template>
          {{ $t('nodes.depsAuditTip') }}
        </NTooltip>
        <NPopconfirm @positive-click="updateAllPacks">
          <template #trigger>
            <NButton
              secondary
              type="primary"
              :disabled="
                (!updatablePacks.length && !checkFailRetryable) ||
                Boolean(updatingOne || nodeUpdatingPack) ||
                nodeBatchActive
              "
              :loading="batchRunning"
            >
              <template #icon><NIcon :component="ArrowUpCircleOutline" /></template
              >{{ $t('nodes.updateAll') }}
            </NButton>
          </template>
          <div class="confirm-update-all">
            <div>{{ $t('nodes.confirmUpdateAll', { n: updatablePacks.length }) }}</div>
            <div v-if="checkSummary['check-failed']" class="meta">
              {{ $t('nodes.checkFailedCount', { n: checkSummary['check-failed'] }) }}
            </div>
            <NCheckbox v-model:checked="includeCheckFailed">
              {{ $t('nodes.tryCheckFailed') }}
            </NCheckbox>
          </div>
        </NPopconfirm>
        <NButton secondary @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('nodes.refresh') }}
        </NButton>
        <NButton secondary @click="createSnapshot">{{ $t('nodes.createSnapshot') }}</NButton>
        <NButton type="primary" @click="showInstall = true">{{ $t('nodes.gitInstall') }}</NButton>
      </NSpace>
    </div>

    <NTabs v-model:value="tab" type="line">
      <NTabPane
        key="installed"
        name="installed"
        :tab="$t('nodes.tabInstalled', { n: packs.length })"
      >
        <NSpace style="margin-bottom: 12px" justify="space-between">
          <NInput
            v-model:value="installedQuery"
            :placeholder="$t('nodes.searchPlaceholder')"
            clearable
            style="width: 320px"
          >
            <template #prefix><NIcon :component="SearchOutline" /></template>
          </NInput>
          <span class="meta">{{ filteredPacks.length }} / {{ packs.length }}</span>
        </NSpace>
        <div
          v-if="nodeUpdatingPack || nodeInstallingPack || nodeBatchActive"
          class="updating-banner"
        >
          <NTag size="small" type="info" round>
            {{
              nodeBatchActive
                ? $t('nodes.updateAll')
                : nodeInstallingPack
                  ? $t('nodes.installing')
                  : $t('nodes.updating')
            }}
          </NTag>
          <span v-if="nodeBatchActive && nodeBatch" class="mono">
            {{
              $t('nodes.batchProgress', {
                index: nodeBatch.index || 0,
                total: nodeBatch.total || 0,
                name: nodeBatch.packName || ''
              })
            }}
          </span>
          <span v-else class="mono">{{ nodeInstallingPack || nodeUpdatingPack }}</span>
          <span v-if="nodeInstallMessage || nodeUpdateMessage" class="hint">
            {{ nodeInstallingPack ? nodeInstallMessage : nodeUpdateMessage }}
          </span>
          <NButton size="tiny" secondary @click="reopenOpModal">
            {{ $t('nodes.viewProgress') }}
          </NButton>
        </div>
        <div v-if="pipBannerVisible" class="updating-banner">
          <NTag size="small" type="info" round>{{ $t('deps.pipOpRunning') }}</NTag>
          <span class="meta">{{ $t('deps.pipOpBannerHint') }}</span>
          <NButton size="tiny" secondary @click="openPipProgress">
            {{ $t('nodes.viewProgress') }}
          </NButton>
        </div>
        <NSpace
          v-if="loadSummary || packs.length"
          align="center"
          style="margin-bottom: 10px"
          :wrap="true"
        >
          <NTag
            v-if="loadSummary"
            size="small"
            round
            :type="loadSummary.fail ? 'error' : 'success'"
            :title="
              loadSummary.fail
                ? packs
                    .filter(
                      (p) => packLoad(p) === 'import-failed' || packLoad(p) === 'prestartup-failed'
                    )
                    .map((p) => `${packTitle(p)}: ${packLoadError(p)}`)
                    .join('\n')
                : ''
            "
          >
            {{ $t('nodes.loadSummary', { ok: loadSummary.ok, fail: loadSummary.fail }) }}
          </NTag>
          <span v-else class="hint">{{ $t('nodes.loadUnknownHint') }}</span>
          <NButton
            size="small"
            secondary
            :type="loadFailedOnly ? 'primary' : 'default'"
            :disabled="!loadFailedCount && !loadFailedOnly"
            @click="loadFailedOnly = !loadFailedOnly"
          >
            {{ $t('nodes.filterLoadFailed', { n: loadFailedCount }) }}
          </NButton>
        </NSpace>
        <NSpace
          v-if="Object.keys(checks).length"
          align="center"
          style="margin-bottom: 10px"
          :wrap="true"
        >
          <NTag v-if="checkSummary.updatable" size="small" round type="warning">
            {{ $t('nodes.checkUpdatable', { n: checkSummary.updatable }) }}
          </NTag>
          <NTag v-if="checkSummary['up-to-date']" size="small" round type="success">
            {{ $t('nodes.checkUpToDate', { n: checkSummary['up-to-date'] }) }}
          </NTag>
          <NTag v-if="checkSummary.unsupported" size="small" round>
            {{ $t('nodes.checkUnsupportedCount', { n: checkSummary.unsupported }) }}
          </NTag>
          <NTag v-if="checkSummary['check-failed']" size="small" round type="error">
            {{ $t('nodes.checkFailedCount', { n: checkSummary['check-failed'] }) }}
          </NTag>
          <NTag v-if="checkSummary['skipped-disabled']" size="small" round>
            {{ $t('nodes.checkDisabledCount', { n: checkSummary['skipped-disabled'] }) }}
          </NTag>
          <NTag v-if="checkSummary.locked" size="small" round type="warning">
            {{ $t('nodes.checkLockedCount', { n: checkSummary.locked }) }}
          </NTag>
        </NSpace>
        <NSpin :show="loading">
          <div v-if="filteredPacks.length" class="grid cards">
            <article
              v-for="pack in filteredPacks"
              :key="pack.id"
              class="card card-interactive pack"
            >
              <div class="pack-head">
                <div class="pack-icon">
                  <NIcon :size="22" :component="ExtensionPuzzleOutline" />
                </div>
                <div class="pack-main">
                  <div class="pack-name" :title="packTitle(pack)">{{ packTitle(pack) }}</div>
                  <div class="pack-meta">
                    <template v-if="pack.version">v{{ pack.version }} · </template
                    >{{ $t('nodes.nodeCount', { n: pack.nodeCount }) }}
                  </div>
                </div>
                <NPopconfirm v-if="!pack.locked" @positive-click="uninstall(pack)">
                  <template #trigger>
                    <NButton size="tiny" type="error" secondary>{{
                      $t('nodes.uninstall')
                    }}</NButton>
                  </template>
                  {{ $t('nodes.confirmUninstall', { name: pack.name }) }}
                </NPopconfirm>
                <NButton
                  size="tiny"
                  quaternary
                  :loading="lockingOne === pack.name"
                  :title="pack.locked ? $t('nodes.unlocked') : $t('nodes.locked')"
                  :aria-label="pack.locked ? $t('nodes.unlocked') : $t('nodes.locked')"
                  @click="lockPack(pack, !pack.locked)"
                >
                  <template #icon>
                    <NIcon :component="pack.locked ? LockClosedOutline : LockOpenOutline" />
                  </template>
                </NButton>
                <NSwitch
                  :value="pack.status !== 'disabled'"
                  :disabled="pack.locked"
                  @update:value="(v: boolean) => toggle(pack, v)"
                />
              </div>
              <p class="pack-desc clamp-2" :title="pack.description || $t('nodes.noDescription')">
                {{ pack.description || $t('nodes.noDescription') }}
              </p>
              <div class="pack-tags">
                <NTag
                  size="tiny"
                  round
                  :type="
                    pack.status === 'disabled'
                      ? 'default'
                      : pack.status === 'error'
                        ? 'error'
                        : 'success'
                  "
                >
                  {{ packStatusLabel(pack) }}
                </NTag>
                <NTag
                  v-if="packLoad(pack) === 'import-failed'"
                  size="tiny"
                  round
                  type="error"
                  :title="packLoadError(pack)"
                >
                  {{ $t('nodes.loadFailed') }}
                </NTag>
                <NTag
                  v-else-if="packLoad(pack) === 'prestartup-failed'"
                  size="tiny"
                  round
                  type="warning"
                  :title="packLoadError(pack)"
                >
                  {{ $t('nodes.loadPrestartupFailed') }}
                </NTag>
                <NTag size="tiny" round>{{ packSourceLabel(pack) }}</NTag>
                <NTag v-if="pack.locked" size="tiny" round type="warning">{{
                  $t('nodes.locked')
                }}</NTag>
                <NTag v-if="hasUpdatePack(pack)" size="tiny" round type="warning">
                  {{ updateBadgeText(pack) }}
                </NTag>
                <NTag v-else-if="!checks[pack.id] && canUpdatePack(pack)" size="tiny" round>
                  {{ $t('nodes.notChecked') }}
                </NTag>
                <NTag
                  v-if="checkFailed(pack)"
                  size="tiny"
                  round
                  type="error"
                  :title="checkReason(pack)"
                >
                  {{ $t('nodes.checkFailed') }}
                </NTag>
                <NTag
                  v-else-if="!canUpdatePack(pack)"
                  size="tiny"
                  round
                  :title="checkReason(pack)"
                  >{{ $t('nodes.notUpdatable') }}</NTag
                >
              </div>
              <div class="pack-actions">
                <NSpace>
                  <NButton size="tiny" secondary @click="smoke(pack)">{{
                    $t('nodes.smokeTest')
                  }}</NButton>
                  <NButton
                    size="tiny"
                    secondary
                    :loading="issuesLoading && issuesPackId === pack.id"
                    @click="checkIssues(pack)"
                  >
                    {{ $t('nodes.checkIssues') }}
                  </NButton>
                  <NPopconfirm v-if="canUpdatePack(pack)" @positive-click="updatePack(pack)">
                    <template #trigger>
                      <NButton
                        size="tiny"
                        type="primary"
                        secondary
                        :disabled="batchRunning"
                        :loading="
                          updatingOne === pack.name ||
                          nodeUpdatingPack === pack.name ||
                          nodeInstallingPack === pack.name
                        "
                      >
                        {{ $t('nodes.update') }}
                      </NButton>
                    </template>
                    {{
                      $t('nodes.confirmUpdate', {
                        name: pack.displayName || pack.name,
                        version: pack.latestVersion || pack.version
                      })
                    }}
                  </NPopconfirm>
                  <NTooltip v-else trigger="hover">
                    <template #trigger>
                      <span class="btn-wrap">
                        <NButton size="tiny" secondary disabled>{{ $t('nodes.update') }}</NButton>
                      </span>
                    </template>
                    {{
                      pack.locked
                        ? $t('nodes.locked')
                        : pack.status === 'disabled'
                          ? $t('nodes.packDisabledUpdate')
                          : $t('nodes.notUpdatable')
                    }}
                  </NTooltip>
                </NSpace>
              </div>
              <NCollapse v-if="pack.issues?.length" class="issues" :arrow="false">
                <NCollapseItem
                  :title="$t('nodes.healthIssues', { n: pack.issues.length })"
                  name="1"
                >
                  <div v-for="(issue, idx) in pack.issues" :key="idx" class="issue">
                    <NIcon
                      :size="16"
                      :component="
                        issue.severity === 'error' || issue.severity === 'warning'
                          ? WarningOutline
                          : CheckmarkCircleOutline
                      "
                      :class="
                        issue.severity === 'error'
                          ? 'fail-ink'
                          : issue.severity === 'warning'
                            ? 'warn-ink'
                            : 'pass-ink'
                      "
                    />
                    <div>
                      <div class="issue-msg">{{ issue.message }}</div>
                      <div v-if="issue.suggestion" class="issue-fix">{{ issue.suggestion }}</div>
                    </div>
                  </div>
                </NCollapseItem>
              </NCollapse>
            </article>
          </div>
          <NEmpty
            v-else
            :description="installedQuery.trim() ? $t('common.noMatch') : $t('nodes.emptyInstalled')"
            class="empty"
          >
            <template #extra>
              <NButton v-if="installedQuery.trim()" secondary @click="clearSearch">{{
                $t('common.clearFilters')
              }}</NButton>
              <NButton v-else type="primary" @click="router.push('/market')">{{
                $t('nav.market')
              }}</NButton>
            </template>
          </NEmpty>
        </NSpin>
      </NTabPane>

      <NTabPane
        key="conflicts"
        name="conflicts"
        :tab="$t('nodes.tabConflicts', { n: conflicts.length })"
      >
        <NSpin :show="loading">
          <div v-if="conflicts.length" class="card">
            <div v-for="c in conflicts" :key="c.nodeName" class="conflict-row">
              <div class="mono conflict-name" :title="c.nodeName">{{ c.nodeName }}</div>
              <div class="pack-tags conflict-tags">
                <NTag v-for="p in c.packs" :key="p" size="tiny" type="warning" round>{{ p }}</NTag>
              </div>
            </div>
          </div>
          <NEmpty v-else :description="$t('nodes.emptyConflicts')" class="empty" />
        </NSpin>
      </NTabPane>

      <NTabPane
        key="snapshots"
        name="snapshots"
        :tab="$t('nodes.tabSnapshots', { n: snapshots.length })"
      >
        <NSpin :show="loading">
          <div v-if="snapshots.length" class="card">
            <div v-for="s in snapshots" :key="s.id" class="snap-row">
              <div class="snap-main">
                <div class="pack-name" :title="s.name">{{ s.name }}</div>
                <div class="pack-meta">
                  {{ new Date(s.createdAt).toLocaleString() }} ·
                  {{ $t('nodes.snapPackCount', { n: s.packs.length }) }}
                </div>
              </div>
              <NSpace>
                <NPopconfirm @positive-click="restoreSnapshot(s.id)">
                  <template #trigger>
                    <NButton size="small" secondary>{{ $t('nodes.restore') }}</NButton>
                  </template>
                  {{ $t('nodes.restoreHint') }}
                </NPopconfirm>
                <NPopconfirm @positive-click="removeSnapshot(s.id)">
                  <template #trigger>
                    <NButton size="small" type="error" secondary>{{ $t('nodes.delete') }}</NButton>
                  </template>
                  {{ $t('nodes.deleteSnapshot') }}
                </NPopconfirm>
              </NSpace>
            </div>
          </div>
          <NEmpty v-else :description="$t('nodes.emptySnapshots')" class="empty" />
        </NSpin>
      </NTabPane>
    </NTabs>

    <NModal
      v-model:show="showInstall"
      preset="card"
      :title="$t('nodes.gitInstallTitle')"
      style="width: 520px; border-radius: 20px"
    >
      <NSpace vertical>
        <NInput v-model:value="installUrl" placeholder="https://github.com/user/repo.git">
          <template #prefix><NIcon :component="GitBranchOutline" /></template>
        </NInput>
        <NInput
          v-model:value="installBranch"
          :placeholder="$t('nodes.branchPlaceholder')"
          clearable
        >
          <template #prefix><NIcon :component="GitBranchOutline" /></template>
        </NInput>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showInstall = false">{{ $t('nodes.cancel') }}</NButton>
          <NButton type="primary" @click="installGit">{{ $t('nodes.install') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- node.checkIssues results -->
    <NModal
      v-model:show="showIssues"
      preset="card"
      :title="$t('nodes.checkIssuesTitle', { name: issuesPackTitle })"
      style="width: 560px; border-radius: 20px"
    >
      <NSpin :show="issuesLoading">
        <div v-if="issuesList.length" class="issues-modal">
          <div v-for="(issue, idx) in issuesList" :key="idx" class="issue">
            <NTag size="small" round :type="issueSeverityType(issue.severity)">
              {{ issueSeverityLabel(issue.severity) }}
            </NTag>
            <div class="issue-body">
              <div class="issue-msg">{{ issue.message }}</div>
              <div v-if="issue.code" class="issue-code">
                {{ $t('nodes.issueCode') }}: {{ issue.code }}
              </div>
              <div v-if="issue.suggestion" class="issue-fix">{{ issue.suggestion }}</div>
            </div>
            <NButton
              v-if="issue.fixable && issue.fixId"
              size="tiny"
              type="primary"
              secondary
              :loading="fixingIssue"
              @click="runIssueFix(issue)"
            >
              {{ $t('nodes.issueFix') }}
            </NButton>
          </div>
        </div>
        <NEmpty v-else-if="!issuesLoading" :description="$t('nodes.checkIssuesEmpty')" />
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showIssues = false">{{ $t('common.close') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 0.1.12: dependency audit (requirements.txt vs venv pip list) -->
    <NModal
      v-model:show="showDepsAudit"
      preset="card"
      :title="$t('nodes.depsAuditTitle')"
      style="width: 640px; border-radius: 20px"
    >
      <NSpin :show="depsAuditLoading">
        <template v-if="depsAudit">
          <div v-if="!depsAudit.ok" class="deps-error">
            <NTag size="small" type="error" round>{{ $t('nodes.depsAuditUnavailable') }}</NTag>
            <div class="issue-msg" style="margin-top: 6px">{{ depsAudit.error || '' }}</div>
          </div>
          <div v-else-if="!depsAudit.packs.length" class="deps-empty">
            <NEmpty :description="$t('nodes.depsAuditEmpty')" />
          </div>
          <div v-else class="deps-list">
            <div class="deps-summary meta">
              {{
                $t('nodes.depsAuditSummary', {
                  checked: depsAudit.checkedPacks,
                  bad: depsAudit.packs.length
                })
              }}
            </div>
            <div v-for="p in depsAudit.packs" :key="p.id" class="deps-pack">
              <div class="deps-pack-head">
                <span class="deps-pack-name mono" :title="p.name">{{ p.name }}</span>
                <NButton size="tiny" type="primary" secondary @click="fixPackDeps(p)">
                  {{ $t('nodes.depsReinstall') }}
                </NButton>
              </div>
              <div v-if="p.missing.length" class="deps-line">
                <NTag size="tiny" round type="error">{{ $t('nodes.depsMissing') }}</NTag>
                <span class="mono deps-items">{{ p.missing.join(', ') }}</span>
              </div>
              <div v-if="p.mismatched.length" class="deps-line">
                <NTag size="tiny" round type="warning">{{ $t('nodes.depsMismatch') }}</NTag>
                <span class="mono deps-items">
                  {{
                    p.mismatched
                      .map((m) => `${m.name}${m.required} (installed ${m.installed})`)
                      .join(', ')
                  }}
                </span>
              </div>
            </div>
            <div class="deps-scope hint">{{ $t('nodes.depsAuditScope') }}</div>
          </div>
        </template>
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton secondary :loading="depsAuditLoading" @click="runDepsAudit">
            {{ $t('common.refresh') }}
          </NButton>
          <NButton @click="showDepsAudit = false">{{ $t('common.close') }}</NButton>
        </NSpace>
      </template>
    </NModal>
    <NodeOpProgressModal v-model:show="showOpModal" :title="opModalTitle" :mode="opModalMode" />
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  grid-auto-rows: 1fr;
}

/* 0.1.12: dependency-audit modal */
.deps-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.deps-summary {
  margin-bottom: 2px;
}

.deps-pack {
  border: 1px solid $color-border;
  border-radius: 12px;
  padding: 10px 12px;
  background: $color-bg-soft;
}

.deps-pack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.deps-pack-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.deps-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
}

.deps-items {
  font-size: 12px;
  color: $color-text-secondary;
  word-break: break-all;
}

.deps-scope {
  margin-top: 4px;
}

.deps-error {
  padding: 8px 2px;
}

.deps-empty {
  padding: 12px 0;
}
.pack {
  padding: 18px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pack-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
/* 关键：内容列必须 min-width:0，否则长包名会把右侧开关挤出卡片（flex 子项默认最小尺寸=内容宽度） */
.pack-main {
  flex: 1;
  min-width: 0;
}
.pack-head .n-button,
.pack-head .n-switch {
  flex-shrink: 0;
}
.pack-icon {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: $gradient-soft;
  color: $color-primary;
  flex-shrink: 0;
}
.pack-name {
  font-size: 15.5px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-meta {
  font-size: 12px;
  color: $color-text-muted-ink;
  margin-top: 2px;
}
/* 描述固定两行（clamp 在全局 .clamp-2），行高精确对齐，卡片跨行也等齐 */
.pack-desc {
  font-size: 13px;
  color: $color-text-secondary;
  line-height: 1.55;
  height: calc(2 * 1.55em);
  margin: 0 0 10px;
}
/* 标签区固定单行，超出的标签裁切而不是撑高卡片 */
.pack .pack-tags {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow: hidden;
}
.pack .pack-tags .n-tag {
  flex-shrink: 0;
}
.pack-actions {
  margin-top: auto;
  padding-top: 10px;
}
.updating-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba($color-primary, 0.08);
  font-size: 12.5px;
  color: $color-text-secondary;
}
.updating-banner .mono {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-wrap {
  display: inline-flex;
}
.issues {
  margin-top: 10px;
}
.issues-modal {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.issue {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  font-size: 12.5px;
  color: $color-text-secondary;
}
.issue-body {
  flex: 1;
  min-width: 0;
}
.issue-msg {
  color: $color-text;
  font-weight: 600;
}
.issue-code {
  margin-top: 2px;
  font-size: 11.5px;
  color: $color-text-muted;
  font-family: monospace;
}
.issue-fix {
  margin-top: 2px;
  color: $color-text-muted;
}
.conflict-row,
.snap-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 4px;
  border-bottom: 1px solid $color-border;
}
.conflict-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-tags {
  flex-wrap: wrap;
}
.snap-main {
  min-width: 0;
  flex: 1;
}
.empty {
  padding: 64px 0;
}
.confirm-update-all {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 280px;
  line-height: 1.55;
}
.meta {
  font-size: 12px;
  color: $color-text-muted-ink;
  align-self: center;
}
.pass-ink {
  color: $color-success;
}
.warn-ink {
  color: $color-warning;
}
.fail-ink {
  color: $color-danger;
}
</style>
