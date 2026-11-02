<script setup lang="ts">
/**
 * IssueCenter (0.2.0): every problem has one place, one status and at least
 * one action. Fix buttons are deep links into the exact instance/pack view.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NEmpty,
  NIcon,
  NList,
  NListItem,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { AlertCircleOutline, RefreshOutline } from '@vicons/ionicons5'
import { ipc } from '@/composables/useIpc'
import type { AppIssue } from '@shared/types'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const message = useMessage()

const issues = ref<AppIssue[]>([])
const showResolved = ref(false)
const loading = ref(false)
const scanning = ref(false)

const instanceFilter = computed(() => String(route.query.instanceId || ''))

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

async function runAction(target: string): Promise<void> {
  if (target.startsWith('/')) {
    await router.push(target)
    return
  }
  message.warning(t('issues.actionUnavailable'))
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

function severityType(s: AppIssue['severity']): 'error' | 'warning' | 'info' {
  return s
}

onMounted(load)
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

    <NSpin :show="loading">
      <NEmpty v-if="!issues.length" :description="t('issues.empty')" />
      <NList v-else bordered class="issue-list">
        <NListItem v-for="issue in issues" :key="issue.id">
          <div class="issue-row">
            <div class="issue-main">
              <NSpace align="center" :size="8">
                <NTag size="tiny" :type="severityType(issue.severity)">
                  {{ t(`issues.severity_${issue.severity}`) }}
                </NTag>
                <NTag size="tiny" round>{{ t(`issues.kind_${issue.kind}`) }}</NTag>
                <span v-if="issue.status !== 'open'" class="meta">
                  {{ t(`issues.status_${issue.status}`) }}
                </span>
              </NSpace>
              <div class="issue-title">{{ issue.title }}</div>
              <div v-if="issue.detail" class="issue-detail">{{ issue.detail }}</div>
              <div v-if="issue.pack" class="meta mono">{{ issue.pack }}</div>
            </div>
            <NSpace vertical align="end">
              <NButton
                v-for="action in issue.actions"
                :key="action.id"
                size="small"
                secondary
                type="primary"
                @click="runAction(action.target)"
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
    </NSpin>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
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
</style>
