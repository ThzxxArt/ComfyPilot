<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import {
  CloudDownloadOutline, SearchOutline, RefreshOutline,
  DuplicateOutline
} from '@vicons/ionicons5'
import {
  NButton, NDataTable, NIcon, NInput, NSpace, NSpin, NTag, NPopconfirm, NModal,
  useMessage, NTabs, NTabPane, NGrid, NGi, type DataTableColumns
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onDownloadProgress, onModelScanProgress } from '@/composables/useIpc'
import { formatBytes } from '@/utils/format'
import { MODEL_CATEGORY_LABELS } from '@shared/constants'
import type { DownloadTask, ModelRecord, StorageStats, DuplicateGroup } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const scanning = ref(false)
const scanProgress = ref('')
const models = ref<ModelRecord[]>([])
const keyword = ref('')
const showDownload = ref(false)
const showRename = ref(false)
const renamePattern = ref('{name}')
const renameResult = ref<Array<{ from: string; to: string; ok: boolean; error?: string }>>([])
const downloadUrl = ref('')
const downloads = ref<DownloadTask[]>([])
const storage = ref<StorageStats[]>([])
const duplicates = ref<DuplicateGroup[]>([])
const tab = ref('all')

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  let list = models.value
  if (tab.value !== 'all') list = list.filter((m) => m.category === tab.value)
  if (!k) return list
  return list.filter(
    (m) =>
      m.name.toLowerCase().includes(k) ||
      m.category.toLowerCase().includes(k) ||
      m.fileName.toLowerCase().includes(k) ||
      (m.architecture || '').toLowerCase().includes(k) ||
      m.tags.some((t) => t.toLowerCase().includes(k))
  )
})

function hTag(text: string, type: 'info' | 'success' | 'warning' = 'info') {
  return h(NTag, { size: 'tiny', round: true, bordered: false, type }, { default: () => text })
}

const columns = computed<DataTableColumns<ModelRecord>>(() => [
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  { title: '类别', key: 'category', width: 130, render: (row) => hTag(MODEL_CATEGORY_LABELS[row.category] || row.category) },
  {
    title: '架构',
    key: 'architecture',
    width: 90,
    render: (row) => (row.architecture ? hTag(row.architecture, 'success') : hTag('—', 'info'))
  },
  { title: '大小', key: 'size', width: 100, render: (row) => formatBytes(row.size) },
  {
    title: '去重',
    key: 'duplicateOf',
    width: 80,
    render: (row) => (row.duplicateOf ? hTag('重复', 'warning') : hTag('唯一', 'success'))
  },
  { title: '路径', key: 'path', ellipsis: { tooltip: true }, className: 'mono' },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render: (row) =>
      h('div', { style: 'display:flex;gap:6px' }, [
        h(
          NPopconfirm,
          {
            onPositiveClick: async () => {
              try {
                await ipc('model.delete', row.id, true)
                await refresh()
                message.success('已删除')
              } catch (err) {
                message.error(err instanceof Error ? err.message : String(err))
              }
            }
          },
          {
            trigger: () =>
              h(NButton, { size: 'tiny', type: 'error', secondary: true }, { default: () => '删除' }),
            default: () => '同时删除磁盘文件？'
          }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            secondary: true,
            onClick: async () => {
              try {
                const dir = await ipc('shell.pickDirectory')
                if (dir) {
                  await ipc('model.move', row.id, dir)
                  await refresh()
                  message.success('已移动')
                }
              } catch (err) {
                message.error(err instanceof Error ? err.message : String(err))
              }
            }
          },
          { default: () => '移动' }
        )
      ])
  }
])

async function refresh(): Promise<void> {
  loading.value = true
  try {
    models.value = await ipc('model.list')
    storage.value = await ipc('model.storageStats')
  } finally {
    loading.value = false
  }
}

async function scan(hash = false): Promise<void> {
  scanning.value = true
  try {
    const roots = store.settings?.modelScanRoots?.length
      ? store.settings.modelScanRoots
      : store.instances[0]?.path
        ? [`${store.instances[0].path.replace(/[\\/]+$/, '')}/models`]
        : []
    models.value = await ipc('model.scan', { roots, hash })
    storage.value = await ipc('model.storageStats')
    if (hash) duplicates.value = await ipc('model.findDuplicates')
    message.success(`扫描完成，共 ${models.value.length} 个模型`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    scanning.value = false
    scanProgress.value = ''
  }
}

async function findDuplicates(): Promise<void> {
  try {
    duplicates.value = await ipc('model.findDuplicates')
    message.success(`发现 ${duplicates.value.length} 组重复`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function ensureThumbs(): Promise<void> {
  try {
    const n = await ipc('model.ensureThumbs')
    message.success(`已生成/复用 ${n} 个缩略图`)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function batchRename(dryRun = true): Promise<void> {
  try {
    const ids = filtered.value.slice(0, 50).map((m) => m.id)
    renameResult.value = await ipc('model.batchRename', {
      ids,
      pattern: renamePattern.value,
      dryRun
    })
    if (!dryRun) {
      showRename.value = false
      await refresh()
      message.success('批量改名完成')
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function pauseDl(id: string): Promise<void> {
  try {
    await ipc('model.pauseDownload', id)
    downloads.value = await ipc('model.downloads')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function resumeDl(id: string): Promise<void> {
  try {
    await ipc('model.resumeDownload', id)
    downloads.value = await ipc('model.downloads')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function startDownload(): Promise<void> {
  if (!downloadUrl.value.trim()) return
  try {
    await ipc('model.download', { url: downloadUrl.value.trim() })
    showDownload.value = false
    downloadUrl.value = ''
    downloads.value = await ipc('model.downloads')
    message.success('下载任务已加入队列')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

let offScan: (() => void) | null = null
let offDl: (() => void) | null = null

onMounted(async () => {
  await refresh()
  downloads.value = await ipc('model.downloads')
  offScan = onModelScanProgress((p) => {
    const prog = p as { scanned: number; total: number; phase: string }
    scanProgress.value = `${prog.phase} ${prog.scanned}/${prog.total}`
  })
  offDl = onDownloadProgress(() => {
    void ipc('model.downloads').then((list) => (downloads.value = list))
  })
})

onUnmounted(() => {
  offScan?.()
  offDl?.()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">模型库</h1>
        <p class="page-subtitle">扫描索引、safetensors 元数据、SHA256 去重、断点下载与存储分析。</p>
      </div>
      <NSpace>
        <NInput v-model:value="keyword" clearable placeholder="搜索名称 / 架构 / 标签" style="width: 220px">
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton secondary :loading="scanning" @click="scan(false)">
          <template #icon><NIcon :component="RefreshOutline" /></template>扫描
        </NButton>
        <NButton secondary :loading="scanning" @click="scan(true)">
          <template #icon><NIcon :component="DuplicateOutline" /></template>扫描+哈希
        </NButton>
        <NButton secondary @click="ensureThumbs">生成缩略图</NButton>
        <NButton secondary @click="showRename = true">批量改名</NButton>
        <NButton type="primary" @click="showDownload = true">
          <template #icon><NIcon :component="CloudDownloadOutline" /></template>下载
        </NButton>
      </NSpace>
    </div>

    <div v-if="scanProgress" class="scan-banner card">{{ scanProgress }}</div>

    <NGrid :cols="5" :x-gap="12" class="stats">
      <NGi v-for="s in storage" :key="s.category">
        <div class="stat-mini card">
          <div class="stat-mini-val">{{ s.count }}</div>
          <div class="stat-mini-label">{{ MODEL_CATEGORY_LABELS[s.category] || s.category }}</div>
          <div class="stat-mini-sub">{{ formatBytes(s.bytes) }}</div>
        </div>
      </NGi>
    </NGrid>

    <div v-if="downloads.length" class="dl-banner card">
      <div v-for="d in downloads" :key="d.id" class="dl-row">
        <span class="dl-name">{{ d.fileName }}</span>
        <span class="chip" :class="d.status === 'done' ? 'chip-success' : d.status === 'error' ? 'chip-danger' : 'chip-warning'">{{ d.status }}</span>
        <span class="mono">{{ formatBytes(d.receivedBytes) }} / {{ formatBytes(d.totalBytes) }}</span>
        <span v-if="d.speedBps" class="mono">{{ formatBytes(d.speedBps) }}/s</span>
        <NButton v-if="d.status === 'running'" size="tiny" secondary @click="pauseDl(d.id)">暂停</NButton>
        <NButton v-if="d.status === 'paused'" size="tiny" secondary @click="resumeDl(d.id)">继续</NButton>
      </div>
    </div>

    <div class="card table-card">
      <NTabs v-model:value="tab" type="segment" class="tabs">
        <NTabPane name="all" tab="全部" />
        <NTabPane name="checkpoints" tab="Checkpoint" />
        <NTabPane name="loras" tab="LoRA" />
        <NTabPane name="diffusion_models" tab="Diffusion" />
        <NTabPane name="vae" tab="VAE" />
        <NTabPane name="controlnet" tab="ControlNet" />
      </NTabs>
      <NSpin :show="loading">
        <NDataTable :columns="columns" :data="filtered" :row-key="(row) => row.id" size="small" :bordered="false" max-height="480" />
      </NSpin>
    </div>

    <div class="card dup-card">
      <div class="dup-head">
        <div>
          <div class="panel-title">重复模型</div>
          <div class="panel-sub">基于 SHA256 哈希识别</div>
        </div>
        <NButton secondary @click="findDuplicates">分析重复</NButton>
      </div>
      <div v-if="duplicates.length">
        <div v-for="g in duplicates" :key="g.hash" class="dup-group">
          <div class="mono dup-hash">{{ g.hash.slice(0, 16) }}…</div>
          <div v-for="f in g.files" :key="f" class="mono dup-file">{{ f }}</div>
        </div>
      </div>
      <div v-else class="panel-sub">点击「分析重复」按哈希查找重复文件。</div>
    </div>

    <NModal v-model:show="showRename" preset="card" title="批量改名" style="width: 560px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="renamePattern" placeholder="命名模板，如 {category}_{index}_{name}" />
        <div class="meta">占位符：{name} {category} {index} {arch}　·　默认对当前筛选结果前 50 条生效</div>
        <div v-if="renameResult.length" class="rename-preview">
          <div v-for="(r, i) in renameResult" :key="i" class="mono">
            <span :style="{ color: r.ok ? '#059669' : '#b91c1c' }">{{ r.ok ? 'OK' : 'ERR' }}</span>
            {{ r.from }} → {{ r.to }}<span v-if="r.error"> ({{ r.error }})</span>
          </div>
        </div>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRename = false">取消</NButton>
          <NButton secondary @click="batchRename(true)">预览</NButton>
          <NButton type="primary" @click="batchRename(false)">执行改名</NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal v-model:show="showDownload" preset="card" title="下载模型" style="width: 520px; border-radius: 20px">
      <NInput v-model:value="downloadUrl" placeholder="粘贴 HuggingFace / Civitai / 直链 URL" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDownload = false">取消</NButton>
          <NButton type="primary" @click="startDownload">开始下载</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.stats { margin-bottom: 14px; }
.stat-mini { padding: 12px 14px; }
.stat-mini-val { font-size: 22px; font-weight: 750; }
.stat-mini-label { font-size: 11px; color: $color-text-muted; margin-top: 2px; }
.stat-mini-sub { font-size: 11px; color: $color-text-secondary; }
.table-card { padding: 4px 8px 12px; margin-bottom: 14px; }
.tabs { padding: 4px 8px 0; }
.scan-banner, .dl-banner { margin-bottom: 12px; padding: 12px 16px; font-size: 13px; color: $color-text-secondary; }
.dl-row { display: flex; gap: 12px; align-items: center; padding: 6px 0; }
.dl-name { font-weight: 600; color: $color-text; }
.dup-card { padding: 18px; }
.dup-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.panel-title { font-size: 15px; font-weight: 700; }
.panel-sub { font-size: 12px; color: $color-text-muted; margin-top: 2px; }
.dup-group { padding: 10px 0; border-top: 1px solid $color-border; }
.dup-hash { color: $color-primary; font-size: 12px; }
.dup-file { font-size: 11.5px; color: $color-text-muted; margin-top: 4px; word-break: break-all; }
.rename-preview {
  max-height: 220px;
  overflow: auto;
  background: $color-surface-2;
  border-radius: 10px;
  padding: 10px;
  font-size: 11.5px;
}
.meta { font-size: 12px; color: $color-text-muted; }
</style>
