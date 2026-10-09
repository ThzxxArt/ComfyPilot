<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ExtensionPuzzleOutline, RefreshOutline, WarningOutline, CheckmarkCircleOutline,
  LockClosedOutline, LockOpenOutline, GitBranchOutline, SearchOutline,
  CloudDownloadOutline, ArrowUpCircleOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NSpace, NSpin, NTag, NSwitch, NEmpty, useMessage, useDialog,
  NCollapse, NCollapseItem, NInput, NModal, NPopconfirm, NTabs, NTabPane, NTooltip
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { useComfyUpdate } from '@/composables/useComfyUpdate'
import { useAppStore } from '@/stores/app'
import type {
  NodeNameConflict, NodePackRecord, NodeSnapshot, NodeUpdateCheckResult
} from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
const { nodeUpdatingPack, nodeInstallingPack, nodeUpdateMessage, nodeInstallMessage } = useComfyUpdate()

// Auto-refresh when a background install/update finishes — the user should not
// have to hit Refresh to see a pack that just landed.
watch(
  () => [nodeUpdatingPack.value, nodeInstallingPack.value],
  ([wasUpdating, wasInstalling], [prevUpdating, prevInstalling]) => {
    const finished =
      (prevUpdating && !wasUpdating) || (prevInstalling && !wasInstalling)
    if (finished) void refresh()
  }
)
const loading = ref(false)
const packs = ref<NodePackRecord[]>([])
const conflicts = ref<NodeNameConflict[]>([])
const snapshots = ref<NodeSnapshot[]>([])
const installedQuery = ref('')
const showInstall = ref(false)
const installUrl = ref('')
const tab = ref('installed')
const checks = ref<Record<string, NodeUpdateCheckResult>>({})
const checking = ref(false)
const updatingOne = ref<string | null>(null)
const batchRunning = ref(false)

const filteredPacks = computed(() => {
  const q = installedQuery.value.trim().toLowerCase()
  if (!q) return packs.value
  return packs.value.filter((p) =>
    [p.name, p.displayName, p.description, ...(p.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(q)
  )
})

/** True when the pack has a newer version available. Trust the check result first. */
function hasUpdatePack(pack: NodePackRecord): boolean {
  const c = checks.value[pack.name]
  if (c) return Boolean(c.updatable)
  if (pack.status === 'update-available') return true
  // Only flag string-difference when both look like numeric versions —
  // commit shas / 'detected' must not light up the badge.
  const looksNumeric = (v: string): boolean => /^v?\d/i.test(String(v || '').trim())
  if (
    pack.latestVersion &&
    pack.version &&
    looksNumeric(pack.latestVersion) &&
    looksNumeric(pack.version) &&
    pack.latestVersion !== pack.version
  ) {
    return true
  }
  return false
}

/**
 * Whether auto-update is supported at all (git / registry).
 * local packs, and manager packs without a git remote, cannot be updated.
 */
function canUpdatePack(pack: NodePackRecord): boolean {
  if (pack.locked) return false
  const c = checks.value[pack.name]
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

function describeUpdateError(err: unknown, pack?: NodePackRecord): string {
  const msg = err instanceof Error ? err.message : String(err)
  const backup = /backup at (.+)$/i.exec(msg)
  if (/rollback (also failed|FAILED)/i.test(msg) && backup) {
    return t('nodes.rollbackFailed', { path: backup[1].trim() })
  }
  if (pack?.installSource === 'registry' || /rolled back/i.test(msg)) {
    return t('nodes.rolledBack')
  }
  return t('nodes.updateFailed', { error: msg })
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const instId = store.activeInstanceId || undefined
    packs.value = await ipc('node.refresh', instId)
    conflicts.value = await ipc('node.conflicts', instId)
    snapshots.value = await ipc('node.snapshots')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function checkUpdates(): Promise<void> {
  checking.value = true
  try {
    const results = await ipc('node.checkUpdates', store.activeInstanceId || undefined)
    const map: Record<string, NodeUpdateCheckResult> = {}
    for (const r of results) {
      map[r.name] = r
      const pack = packs.value.find((p) => p.name === r.name || p.id === r.id)
      if (pack) {
        if (r.latestVersion) pack.latestVersion = r.latestVersion
        if (r.updatable) pack.status = 'update-available'
      }
    }
    checks.value = map
    if (!results.some((r) => r.updatable)) {
      message.info(t('nodes.upToDate'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    checking.value = false
  }
}

async function updatePack(pack: NodePackRecord): Promise<void> {
  updatingOne.value = pack.name
  try {
    await ipc('node.update', pack.name, undefined, store.activeInstanceId || undefined)
    message.success(t('nodes.updateDone', { name: pack.displayName || pack.name }))
    // Drop the stale check result so the "has update" badge clears.
    delete checks.value[pack.name]
    await refresh()
  } catch (err) {
    message.error(describeUpdateError(err, pack))
  } finally {
    updatingOne.value = null
  }
}

async function updateAllPacks(): Promise<void> {
  batchRunning.value = true
  try {
    const results = await ipc('node.updateAll', store.activeInstanceId || undefined)
    const ok = results.filter((r) => r.ok && !r.skipped).length
    const fail = results.filter((r) => !r.ok).length
    const skip = results.filter((r) => r.skipped).length
    const summary = t('nodes.batchDone', { ok, fail, skip })
    const failures = results.filter((r) => !r.ok)
    dialog.info({
      title: t('nodes.batchSummary'),
      content: failures.length
        ? `${summary} — ${failures.map((f) => `${f.name}: ${f.error || ''}`).join(' · ')}`
        : summary,
      positiveText: t('common.confirm')
    })
    if (fail > 0) message.warning(summary)
    else message.success(summary)
    // Drop stale check results so the "has update" badges refresh.
    checks.value = {}
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    batchRunning.value = false
  }
}

async function installGit(): Promise<void> {
  if (!installUrl.value.trim()) return
  try {
    await ipc('node.install', {
      id: installUrl.value.trim(),
      source: 'git',
      url: installUrl.value.trim(),
      instanceId: store.activeInstanceId || undefined
    })
    showInstall.value = false
    message.success(t('nodes.gitInstallDone'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function toggle(pack: NodePackRecord, enabled: boolean): Promise<void> {
  try {
    await ipc('node.toggle', pack.name, enabled, store.activeInstanceId || undefined)
    await refresh()
    message.success(enabled ? t('nodes.enabled') : t('nodes.disabled'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function lockPack(pack: NodePackRecord, locked: boolean): Promise<void> {
  try {
    await ipc('node.lock', pack.name, locked)
    await refresh()
    message.success(locked ? t('nodes.locked') : t('nodes.unlocked'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function smoke(pack: NodePackRecord): Promise<void> {
  try {
    const issues = await ipc('node.smokeTest', pack.name, store.activeInstanceId || undefined)
    message[issues.some((i) => i.severity === 'error') ? 'error' : 'success'](
      issues.length ? issues[0].message : t('nodes.smokePassed')
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function createSnapshot(): Promise<void> {
  try {
    const s = await ipc('node.createSnapshot')
    message.success(t('nodes.snapshotCreated', { name: s.name }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function restoreSnapshot(id: string): Promise<void> {
  try {
    await ipc('node.restoreSnapshot', id)
    message.success(t('nodes.snapshotRestored'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function uninstall(pack: NodePackRecord): Promise<void> {
  try {
    await ipc('node.uninstall', pack.name, store.activeInstanceId || undefined)
    message.success(t('nodes.uninstalled'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeSnapshot(id: string): Promise<void> {
  try {
    await ipc('node.deleteSnapshot', id)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => {
  void refresh()
})
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
          <template #icon><NIcon :component="CloudDownloadOutline" /></template>{{ $t('nodes.checkUpdates') }}
        </NButton>
        <NPopconfirm @positive-click="updateAllPacks">
          <template #trigger>
            <NButton secondary type="primary" :disabled="!updatablePacks.length" :loading="batchRunning">
              <template #icon><NIcon :component="ArrowUpCircleOutline" /></template>{{ $t('nodes.updateAll') }}
            </NButton>
          </template>
          {{ $t('nodes.confirmUpdateAll', { n: updatablePacks.length }) }}
        </NPopconfirm>
        <NButton secondary @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('nodes.refresh') }}
        </NButton>
        <NButton secondary @click="createSnapshot">{{ $t('nodes.createSnapshot') }}</NButton>
        <NButton type="primary" @click="showInstall = true">{{ $t('nodes.gitInstall') }}</NButton>
      </NSpace>
    </div>

    <NTabs v-model:value="tab" type="line">
      <NTabPane name="installed" :tab="$t('nodes.tabInstalled', { n: packs.length })">
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
        <div v-if="nodeUpdatingPack || nodeInstallingPack" class="updating-banner">
          <NTag size="small" type="info" round>
            {{ nodeInstallingPack ? $t('nodes.installing') : $t('nodes.updating') }}
          </NTag>
          <span class="mono">{{ nodeInstallingPack || nodeUpdatingPack }}</span>
          <span v-if="nodeInstallMessage || nodeUpdateMessage" class="hint">
            {{ nodeInstallingPack ? nodeInstallMessage : nodeUpdateMessage }}
          </span>
        </div>
        <NSpin :show="loading">
          <div v-if="filteredPacks.length" class="grid cards">
            <article v-for="pack in filteredPacks" :key="pack.id" class="card card-interactive pack">
              <div class="pack-head">
                <div class="pack-icon"><NIcon :size="22" :component="ExtensionPuzzleOutline" /></div>
                <div style="flex:1">
                  <div class="pack-name">{{ pack.displayName }}</div>
                  <div class="pack-meta">v{{ pack.version }} · {{ pack.nodeCount }} nodes</div>
                </div>
                <NPopconfirm v-if="!pack.locked" @positive-click="uninstall(pack)">
                  <template #trigger>
                    <NButton size="tiny" type="error" secondary>{{ $t('nodes.uninstall') }}</NButton>
                  </template>
                  {{ $t('nodes.confirmUninstall', { name: pack.name }) }}
                </NPopconfirm>
                <NButton size="tiny" quaternary @click="lockPack(pack, !pack.locked)">
                  <template #icon>
                    <NIcon :component="pack.locked ? LockClosedOutline : LockOpenOutline" />
                  </template>
                </NButton>
                <NSwitch :value="pack.status !== 'disabled'" :disabled="pack.locked" @update:value="(v: boolean) => toggle(pack, v)" />
              </div>
              <p class="pack-desc">{{ pack.description || $t('nodes.noDescription') }}</p>
              <div class="pack-tags">
                <NTag size="tiny" round :type="pack.status === 'disabled' ? 'default' : pack.status === 'error' ? 'error' : 'success'">
                  {{ pack.status }}
                </NTag>
                <NTag size="tiny" round>{{ pack.installSource }}</NTag>
                <NTag v-if="pack.locked" size="tiny" round type="warning">locked</NTag>
                <NTag v-if="hasUpdatePack(pack)" size="tiny" round type="warning">
                  {{ $t('nodes.hasUpdate', { version: pack.latestVersion || pack.version }) }}
                </NTag>
                <NTag v-if="!canUpdatePack(pack)" size="tiny" round>{{ $t('nodes.notUpdatable') }}</NTag>
              </div>
              <div class="pack-actions">
                <NSpace>
                  <NButton size="tiny" secondary @click="smoke(pack)">{{ $t('nodes.smokeTest') }}</NButton>
                  <NPopconfirm v-if="canUpdatePack(pack)" @positive-click="updatePack(pack)">
                    <template #trigger>
                      <NButton
                        size="tiny"
                        type="primary"
                        secondary
                        :loading="updatingOne === pack.name || nodeUpdatingPack === pack.name || nodeInstallingPack === pack.name"
                      >
                        {{ $t('nodes.update') }}
                      </NButton>
                    </template>
                    {{ $t('nodes.confirmUpdate', { name: pack.displayName || pack.name, version: pack.latestVersion || pack.version }) }}
                  </NPopconfirm>
                  <NTooltip v-else trigger="hover">
                    <template #trigger>
                      <NButton size="tiny" secondary disabled>{{ $t('nodes.update') }}</NButton>
                    </template>
                    {{ pack.locked ? $t('nodes.locked') : $t('nodes.notUpdatable') }}
                  </NTooltip>
                </NSpace>
              </div>
              <NCollapse v-if="pack.issues?.length" class="issues" :arrow="false">
                <NCollapseItem :title="$t('nodes.healthIssues', { n: pack.issues.length })" name="1">
                  <div v-for="(issue, idx) in pack.issues" :key="idx" class="issue">
                    <NIcon
                      :size="16"
                      :component="issue.severity === 'error' || issue.severity === 'warning' ? WarningOutline : CheckmarkCircleOutline"
                      :class="issue.severity === 'error' ? 'fail-ink' : issue.severity === 'warning' ? 'warn-ink' : 'pass-ink'"
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
          <NEmpty v-else :description="$t('nodes.emptyInstalled')" class="empty" />
        </NSpin>
      </NTabPane>

      <NTabPane name="conflicts" :tab="$t('nodes.tabConflicts', { n: conflicts.length })">
        <div v-if="conflicts.length" class="card">
          <div v-for="c in conflicts" :key="c.nodeName" class="conflict-row">
            <div class="mono">{{ c.nodeName }}</div>
            <div class="pack-tags">
              <NTag v-for="p in c.packs" :key="p" size="tiny" type="warning" round>{{ p }}</NTag>
            </div>
          </div>
        </div>
        <NEmpty v-else :description="$t('nodes.emptyConflicts')" />
      </NTabPane>

      <NTabPane name="snapshots" :tab="$t('nodes.tabSnapshots', { n: snapshots.length })">
        <div v-if="snapshots.length" class="card">
          <div v-for="s in snapshots" :key="s.id" class="snap-row">
            <div>
              <div class="pack-name">{{ s.name }}</div>
              <div class="pack-meta">{{ new Date(s.createdAt).toLocaleString() }} · {{ s.packs.length }} packs</div>
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
        <NEmpty v-else :description="$t('nodes.emptySnapshots')" />
      </NTabPane>
    </NTabs>

    <NModal v-model:show="showInstall" preset="card" :title="$t('nodes.gitInstallTitle')" style="width: 520px; border-radius: 20px">
      <NInput v-model:value="installUrl" placeholder="https://github.com/user/repo.git">
        <template #prefix><NIcon :component="GitBranchOutline" /></template>
      </NInput>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showInstall = false">{{ $t('nodes.cancel') }}</NButton>
          <NButton type="primary" @click="installGit">{{ $t('nodes.install') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.pack { padding: 18px; }
.pack-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.pack-icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: $gradient-soft; color: $color-primary; }
.pack-name { font-size: 15.5px; font-weight: 700; }
.pack-meta { font-size: 12px; color: $color-text-muted; margin-top: 2px; }
.pack-desc { font-size: 13px; color: $color-text-secondary; line-height: 1.55; min-height: 36px; margin: 0 0 10px; }
.pack-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.pack-actions { margin-top: 10px; }
.updating-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(79, 110, 247, 0.08);
  font-size: 12.5px;
  color: $color-text-secondary;
}
.issues { margin-top: 10px; }
.issue { display: flex; gap: 8px; padding: 8px 0; font-size: 12.5px; color: $color-text-secondary; }
.issue-msg { color: $color-text; font-weight: 600; }
.issue-fix { margin-top: 2px; color: $color-text-muted; }
.reg-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; width: 100%; }
.conflict-row, .snap-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 4px; border-bottom: 1px solid $color-border; }
.empty { padding: 48px 0; }
.meta { font-size: 12px; color: $color-text-muted; align-self: center; }
.more-row { display: flex; justify-content: center; padding: 14px 0 6px; }
.pass-ink { color: $color-success; }
.warn-ink { color: $color-warning; }
.fail-ink { color: $color-danger; }
</style>
