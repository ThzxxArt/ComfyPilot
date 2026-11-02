<script setup lang="ts">
/**
 * IssueCenter (0.2.0): every problem has one place, one status and at least
 * one executable action. Fix buttons are deep links into the exact
 * instance/pack view, or IPC actions (install module / clean leftover).
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NEmpty,
  NIcon,
  NList,
  NListItem,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { AlertCircleOutline, RefreshOutline } from '@vicons/ionicons5'
import { ipc, onIssuesChanged } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import type { AppIssue } from '@shared/types'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const message = useMessage()
const store = useAppStore()

const issues = ref<AppIssue[]>([])
const showResolved = ref(false)
const loading = ref(false)
const scanning = ref(false)
const actionBusy = ref('')
const severityFilter = ref<'all' | AppIssue['severity']>('all')
const kindFilter = ref<'all' | AppIssue['kind']>('all')

const instanceFilter = computed(() => String(route.query.instanceId || ''))
const instanceOptions = computed(() => [
  { label: t('issues.allInstances'), value: '' },
  ...store.instances.map((i) => ({ label: i.name, value: i.id }))
])
const severityOptions = computed(() => [
  { label: t('issues.allSeverities'), value: 'all' },
  { label: t('issues.severity_error'), value: 'error' },
  { label: t('issues.severity_warning'), value: 'warning' },
  { label: t('issues.severity_info'), value: 'info' }
])
const kindOptions = computed(() => [
  { label: t('issues.allKinds'), value: 'all' },
  ...(['startup', 'node-load', 'deps', 'doctor', 'exec'] as const).map((kind) => ({
    label: t(`issues.kind_${kind}`),
    value: kind
  }))
])

const visible = computed(() =>
  issues.value.filter(
    (i) =>
      (!instanceFilter.value || i.instanceId === instanceFilter.value) &&
      (severityFilter.value === 'all' || i.severity === severityFilter.value) &&
      (kindFilter.value === 'all' || i.kind === kindFilter.value)
  )
)
const openCount = computed(() => visible.value.filter((i) => i.status === 'open').length)
const groups = computed(() => {
  const map = new Map<AppIssue['kind'], AppIssue[]>()
  for (const issue of visible.value) {
    const list = map.get(issue.kind) || []
    list.push(issue)
    map.set(issue.kind, list)
  }
  return [...map.entries()].map(([kind, items]) => ({ kind, items }))
})

async function load(): Promise<void> {
  loading.value = true
  try {
    issues.value = await ipc('issue.list', showResolved.value)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function scan(): Promise<void> {
  scanning.value = true
  try {
    issues.value = await ipc('issue.scan', instanceFilter.value || undefined)
    message.success(t('issues.scanDone', { n: issues.value.length }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    scanning.value = false
  }
}

function setInstance(id: string): void {
  void router.replace({
    path: '/issues',
    query: id ? { instanceId: id } : {}
  })
  void load()
}

async function runAction(issue: AppIssue, target: string): Promise<void> {
  if (target.startsWith('/')) {
    await router.push(target)
    return
  }
  actionBusy.value = issue.id
  try {
    const call = ipc as unknown as (
      channel: string,
      ...args: unknown[]
    ) => Promise<{ ok?: boolean; message?: string }>
    const result = await call(target, issue.id)
    if (result?.ok === false) message.error(result.message || t('issues.actionUnavailable'))
    else if (result?.message) message.success(result.message)
    await load()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    actionBusy.value = ''
  }
}

async function restore(issue: AppIssue): Promise<void> {
  await ipc('issue.restore', issue.id)
  await load()
}

async function dismiss(issue: AppIssue): Promise<void> {
  await ipc('issue.dismiss', issue.id)
  await load()
}

async function resolveIssue(issue: AppIssue): Promise<void> {
  await ipc('issue.resolve', issue.id)
  await load()
}

async function ignoreAll(): Promise<void> {
  for (const issue of visible.value.filter((i) => i.status === 'open')) {
    await ipc('issue.dismiss', issue.id)
  }
  await load()
}

function severityType(s: AppIssue['severity']): 'error' | 'warning' | 'info' {
  return s
}

let offIssues: (() => void) | null = null
onMounted(async () => {
  await store.refreshInstances()
  await load()
  offIssues = onIssuesChanged(() => {
    void load()
  })
})
onUnmounted(() => {
  offIssues?.()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">
          <NIcon :component="AlertCircleOutline" /> {{ t('issues.title') }}
        </h1>
        <div class="page-sub">{{ t('issues.subtitle') }}</div>
      </div>
      <NSpace align="center">
        <span class="meta">{{ t('issues.showResolved') }}</span>
        <NSwitch v-model:value="showResolved" @update:value="load" />
        <NButton type="primary" :loading="scanning" @click="scan">
          <template #icon><NIcon :component="RefreshOutline" /></template>
          {{ t('issues.scan') }}
        </NButton>
      </NSpace>
    </div>

    <div class="filters card">
      <NSelect
        :value="instanceFilter"
        :options="instanceOptions"
        style="width: 190px"
        @update:value="setInstance"
      />
      <NSelect v-model:value="severityFilter" :options="severityOptions" style="width: 150px" />
      <NSelect v-model:value="kindFilter" :options="kindOptions" style="width: 150px" />
      <span class="meta">{{ t('issues.openCount', { n: openCount }) }}</span>
      <NButton size="small" secondary type="warning" :disabled="!openCount" @click="ignoreAll">
        {{ t('issues.ignoreAll') }}
      </NButton>
    </div>

    <NSpin :show="loading">
      <NEmpty v-if="!visible.length" :description="t('issues.empty')" />
      <div v-for="group in groups" v-else :key="group.kind" class="issue-group">
        <div class="group-title">
          {{ t(`issues.kind_${group.kind}`) }}
          <span class="meta">{{ group.items.length }}</span>
        </div>
        <NList bordered class="issue-list">
          <NListItem v-for="issue in group.items" :key="issue.id">
            <div class="issue-row">
              <div class="issue-main">
                <NSpace align="center" :size="8">
                  <NTag size="tiny" :type="severityType(issue.severity)">
                    {{ t(`issues.severity_${issue.severity}`) }}
                  </NTag>
                  <span v-if="issue.status !== 'open'" class="meta">
                    {{ t(`issues.status_${issue.status}`) }}
                  </span>
                  <span v-if="issue.pack" class="chip mono">{{ issue.pack }}</span>
                </NSpace>
                <div class="issue-title">{{ issue.title }}</div>
                <div v-if="issue.detail" class="issue-detail">{{ issue.detail }}</div>
              </div>
              <NSpace vertical align="end">
                <NButton
                  v-for="action in issue.actions"
                  :key="action.id"
                  size="small"
                  secondary
                  type="primary"
                  :loading="actionBusy === issue.id"
                  @click="runAction(issue, action.target)"
                >
                  {{ t(action.labelKey) }}
                </NButton>
                <NButton
                  v-if="issue.status === 'open'"
                  size="small"
                  secondary
                  @click="resolveIssue(issue)"
                >
                  {{ t('issues.resolve') }}
                </NButton>
                <NButton
                  v-if="issue.status === 'open'"
                  size="small"
                  secondary
                  type="warning"
                  @click="dismiss(issue)"
                >
                  {{ t('issues.ignore') }}
                </NButton>
                <NButton v-else size="small" secondary @click="restore(issue)">
                  {{ t('issues.restore') }}
                </NButton>
              </NSpace>
            </div>
          </NListItem>
        </NList>
      </div>
    </NSpin>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.issue-group {
  margin-bottom: 16px;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  margin: 0 0 8px 2px;
}
.issue-list {
  border-radius: 14px;
}
.issue-row {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
}
.issue-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.issue-title {
  font-weight: 600;
  font-size: 14px;
}
.issue-detail {
  font-size: 12.5px;
  color: $color-text-secondary;
  white-space: pre-wrap;
}
.meta {
  font-size: 12px;
  color: $color-text-muted-ink;
}
.chip {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.14);
}
</style>
