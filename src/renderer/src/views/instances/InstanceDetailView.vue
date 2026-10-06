<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowBackOutline, PlayOutline, StopOutline, OpenOutline, PulseOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NTag, NSpace, NScrollbar, NSpin, NDescriptions, NDescriptionsItem, useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onInstanceStatus } from '@/composables/useIpc'
import type { ComfyInstanceInfo, ComfyLogLine } from '@shared/types'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const message = useMessage()
const loading = ref(true)
const logs = ref<ComfyLogLine[]>([])
const instance = ref<ComfyInstanceInfo | null>(null)

const id = computed(() => String(route.params.id || ''))

async function start(): Promise<void> {
  try {
    await ipc('instance.start', id.value)
    await refresh()
    message.success('启动中…')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function stop(): Promise<void> {
  try {
    await ipc('instance.stop', id.value)
    await refresh()
    message.success('已停止')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function refresh(): Promise<void> {
  try {
    await store.refreshInstances()
    instance.value = store.instances.find((i) => i.id === id.value) || null
    logs.value = await ipc('instance.getLogs', id.value, 400)
  } catch (err) {
    console.error(err)
  } finally {
    loading.value = false
  }
}

let off: (() => void) | null = null

onMounted(() => {
  void refresh()
  off = onInstanceStatus(() => {
    void refresh()
  })
})

onUnmounted(() => off?.())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <NButton text @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="ArrowBackOutline" />
          </template>
          返回实例列表
        </NButton>
        <h1 class="page-title" style="margin-top: 8px">{{ instance?.name || '实例详情' }}</h1>
        <p class="page-subtitle mono">{{ instance?.path }}</p>
      </div>
      <NSpace>
        <NButton v-if="instance?.status !== 'running'" type="primary" @click="start">
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          启动
        </NButton>
        <NButton v-else type="warning" secondary @click="stop">
          <template #icon>
            <NIcon :component="StopOutline" />
          </template>
          停止
        </NButton>
        <NButton secondary :disabled="!instance?.url" @click="instance?.url && ipc('shell.openExternal', instance.url)">
          <template #icon>
            <NIcon :component="OpenOutline" />
          </template>
          外链打开
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
          内嵌 Frontend
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="loading">
      <div class="grid layout">
        <section class="card panel">
          <div class="panel-title">基本信息</div>
          <NDescriptions bordered size="small" :column="2" label-placement="left" class="desc">
            <NDescriptionsItem label="状态">
              <NTag :type="instance?.status === 'running' ? 'success' : instance?.status === 'error' ? 'error' : 'default'" round>
                {{ instance?.status }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="PID">{{ instance?.pid || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="监听">{{ instance?.listen }}:{{ instance?.port }}</NDescriptionsItem>
            <NDescriptionsItem label="版本">{{ instance?.version || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="Python">{{ instance?.pythonPath || 'system' }}</NDescriptionsItem>
            <NDescriptionsItem label="URL" :span="2">
              <span class="mono">{{ instance?.url }}</span>
            </NDescriptionsItem>
          </NDescriptions>
        </section>

        <section class="card panel logs">
          <div class="panel-head">
            <div class="panel-title">实时日志</div>
            <NButton size="tiny" secondary @click="refresh">刷新</NButton>
          </div>
          <NScrollbar class="log-scroll">
            <div v-if="!logs.length" class="log-empty">启动实例后，日志会实时出现在这里。</div>
            <div v-for="(line, idx) in logs" :key="idx" class="log-line" :class="line.level">
              <span class="log-time">{{ new Date(line.ts).toLocaleTimeString() }}</span>
              <span class="log-msg">{{ line.message }}</span>
            </div>
          </NScrollbar>
        </section>
      </div>
    </NSpin>
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

.log-scroll {
  height: 420px;
  background: #fbfcff;
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
    color: #b91c1c;
  }
  &.warn {
    color: #b45309;
  }
  &.info {
    color: #334155;
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
