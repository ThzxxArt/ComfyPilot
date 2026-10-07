<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowBackOutline, PlayOutline, StopOutline, OpenOutline, PulseOutline,
  TerminalOutline, CreateOutline, RefreshOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NTag, NSpace, NScrollbar, NSpin, NDescriptions, NDescriptionsItem,
  NCollapse, NCollapseItem, useMessage
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onInstanceStatus, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useI18n } from 'vue-i18n'
import type { ComfyInstanceInfo, ComfyLogLine, LaunchCommandPreview } from '@shared/types'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const message = useMessage()
const { t } = useI18n()
const { launch, stop, busy } = useLaunch()
const loading = ref(true)
const logs = ref<ComfyLogLine[]>([])
const instance = ref<ComfyInstanceInfo | null>(null)
const preview = ref<LaunchCommandPreview | null>(null)

const id = computed(() => String(route.params.id || ''))

async function doLaunch(open: 'embed' | 'browser' | 'none' = 'none'): Promise<void> {
  if (!instance.value) return
  await launch(instance.value, { open })
  await refresh()
}

async function doStop(): Promise<void> {
  if (!instance.value) return
  await stop(instance.value)
  await refresh()
}

async function refresh(): Promise<void> {
  try {
    await store.refreshInstances()
    instance.value = store.instances.find((i) => i.id === id.value) || null
    logs.value = await ipc('instance.getLogs', id.value, 400)
    if (!preview.value) {
      try {
        preview.value = await ipc('instance.previewLaunch', id.value)
      } catch {
        /* instance may be missing */
      }
    }
  } catch (err) {
    console.error(err)
  } finally {
    loading.value = false
  }
}

async function copyCommand(): Promise<void> {
  if (!preview.value) return
  await ipc('shell.writeClipboard', preview.value.commandLine)
  message.success(t('instance.launchCmdCopied'))
}

let off: (() => void) | null = null
let offLog: (() => void) | null = null

onMounted(() => {
  void refresh()
  off = onInstanceStatus(() => {
    void refresh()
  })
  // Live log tail — append without full refresh
  offLog = onIpc(IPC_EVENTS.instanceLog, (payload) => {
    const p = payload as { id: string; line: ComfyLogLine }
    if (p?.id === id.value && p.line) {
      logs.value = [...logs.value.slice(-499), p.line]
    }
  })
})

onUnmounted(() => {
  off?.()
  offLog?.()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <NButton text @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="ArrowBackOutline" />
          </template>
          {{ $t('instance.backToList') }}
        </NButton>
        <h1 class="page-title" style="margin-top: 8px">{{ instance?.name || $t('instance.detailTitle') }}</h1>
        <p class="page-subtitle mono">{{ instance?.path }}</p>
      </div>
      <NSpace>
        <NButton
          v-if="instance?.status !== 'running'"
          type="primary"
          :loading="busy[id]"
          @click="doLaunch('embed')"
        >
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          {{ $t('header.launchAndOpen') }}
        </NButton>
        <NButton v-else type="warning" secondary @click="doStop">
          <template #icon>
            <NIcon :component="StopOutline" />
          </template>
          {{ $t('header.stop') }}
        </NButton>
        <NButton secondary @click="doLaunch('none')">
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          {{ $t('instance.startOnly') }}
        </NButton>
        <NButton secondary :disabled="!instance?.url" @click="instance?.url && ipc('shell.openExternal', instance.url)">
          <template #icon>
            <NIcon :component="OpenOutline" />
          </template>
          {{ $t('header.openExternal') }}
        </NButton>
        <NButton
          type="primary"
          secondary
          :disabled="!instance?.url"
          @click="instance?.url && router.push({ path: '/embed', query: { url: instance.url } })"
        >
          <template #icon>
            <NIcon :component="PulseOutline" />
          </template>
          {{ $t('header.embed') }}
        </NButton>
        <NButton secondary @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="CreateOutline" />
          </template>
          {{ $t('common.edit') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <div class="grid layout">
        <section class="card panel">
          <div class="panel-title">{{ $t('instance.basicInfo') }}</div>
          <NDescriptions bordered size="small" :column="2" label-placement="left" class="desc">
            <NDescriptionsItem :label="$t('common.status')">
              <NTag :type="instance?.status === 'running' ? 'success' : instance?.status === 'error' ? 'error' : 'default'" round>
                {{ instance?.status }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="PID">{{ instance?.pid || '—' }}</NDescriptionsItem>
            <NDescriptionsItem :label="$t('instance.listen')">{{ instance?.listen }}:{{ instance?.port }}</NDescriptionsItem>
            <NDescriptionsItem :label="$t('common.version')">{{ instance?.version || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="Python">{{ instance?.pythonPath || 'system' }}</NDescriptionsItem>
            <NDescriptionsItem label="autoStart">{{ instance?.autoStart ? $t('common.yes') : $t('common.no') }}</NDescriptionsItem>
            <NDescriptionsItem label="URL" :span="2">
              <span class="mono">{{ instance?.url }}</span>
            </NDescriptionsItem>
          </NDescriptions>

          <NCollapse v-if="preview" class="cmd-collapse">
            <NCollapseItem :title="$t('instance.launchCmdTitle')" name="cmd">
              <div class="cmd-box">
                <div class="mono cmd-cwd">cwd: {{ preview.cwd }}</div>
                <pre class="mono cmd-line">{{ preview.commandLine }}</pre>
                <NButton size="tiny" secondary @click="copyCommand">
                  <template #icon><NIcon :component="TerminalOutline" /></template>
                  {{ $t('instance.copyCmd') }}
                </NButton>
              </div>
            </NCollapseItem>
          </NCollapse>
        </section>

        <section class="card panel logs">
          <div class="panel-head">
            <div class="panel-title">{{ $t('instance.liveLogs') }}</div>
            <NButton size="tiny" secondary @click="refresh">
              <template #icon><NIcon :component="RefreshOutline" /></template>
              {{ $t('common.refresh') }}
            </NButton>
          </div>
          <NScrollbar class="log-scroll">
            <div v-if="!logs.length" class="log-empty">{{ $t('instance.logEmptyHint') }}</div>
            <div v-for="(line, idx) in logs" :key="idx" class="log-line" :class="line.level">
              <span class="log-time">{{ new Date(line.ts).toLocaleTimeString() }}</span>
              <span class="log-msg">{{ line.message }}</span>
            </div>
          </NScrollbar>
        </section>
      </div>
    </NSpin>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.layout {
  grid-template-columns: 1.1fr 1fr;
  align-items: stretch;
}

.panel {
  padding: 20px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 12px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.desc {
  --n-td-color: transparent;
}

.cmd-collapse {
  margin-top: 14px;
}

.cmd-box {
  background: $color-surface-2;
  border-radius: 12px;
  padding: 12px;
}

.cmd-cwd {
  font-size: 11px;
  color: $color-text-muted;
  margin-bottom: 6px;
}

.cmd-line {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0 0 10px;
  line-height: 1.55;
}

.log-scroll {
  height: 420px;
  background: $color-bg-soft;
  border: 1px solid $color-border;
  border-radius: 14px;
  padding: 12px;
}

.log-line {
  display: flex;
  gap: 10px;
  font-family: $font-mono;
  font-size: 12px;
  line-height: 1.65;
  padding: 2px 0;

  &.error {
    color: $color-danger;
  }
  &.warn {
    color: $color-warning;
  }
  &.info {
    color: $color-text-secondary;
  }
}

.log-time {
  color: $color-text-muted;
  flex-shrink: 0;
}

.log-empty {
  color: $color-text-muted;
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
</style>
