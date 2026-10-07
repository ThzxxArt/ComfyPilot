<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ExtensionPuzzleOutline, RefreshOutline, WarningOutline, CheckmarkCircleOutline,
  LockClosedOutline, LockOpenOutline, GitBranchOutline, SearchOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NSpace, NSpin, NTag, NSwitch, NEmpty, useMessage,
  NCollapse, NCollapseItem, NInput, NModal, NPopconfirm, NTabs, NTabPane
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import type {
  NodeNameConflict, NodePackRecord, NodeSnapshot
} from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const packs = ref<NodePackRecord[]>([])
const conflicts = ref<NodeNameConflict[]>([])
const snapshots = ref<NodeSnapshot[]>([])
const installedQuery = ref('')
const showInstall = ref(false)
const installUrl = ref('')
const tab = ref('installed')

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
              </div>
              <div class="pack-actions">
                <NButton size="tiny" secondary @click="smoke(pack)">{{ $t('nodes.smokeTest') }}</NButton>
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
              <NButton size="small" secondary @click="restoreSnapshot(s.id)">{{ $t('nodes.restore') }}</NButton>
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
