<script setup lang="ts">
import { ref } from 'vue'
import {
  MedkitOutline, CheckmarkCircleOutline, WarningOutline, CloseCircleOutline,
  FlashOutline, ConstructOutline
} from '@vicons/ionicons5'
import { NButton, NIcon, NSpace, NSpin, NTag, useMessage, NEmpty } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import type { DoctorCheck, DoctorReport } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const running = ref(false)
const fixing = ref(false)
const report = ref<DoctorReport | null>(null)

function iconFor(s: DoctorCheck['severity']) {
  if (s === 'pass') return CheckmarkCircleOutline
  if (s === 'warn' || s === 'info') return WarningOutline
  return CloseCircleOutline
}

function toneFor(s: DoctorCheck['severity']): string {
  if (s === 'pass') return 'chip-success'
  if (s === 'warn' || s === 'info') return 'chip-warning'
  return 'chip-danger'
}

async function run(): Promise<void> {
  running.value = true
  try {
    const id = store.activeInstanceId || 'default'
    report.value = await ipc('doctor.run', id)
    message.success(
      `体检完成：通过 ${report.value.summary.pass} · 警告 ${report.value.summary.warn} · 失败 ${report.value.summary.fail}`
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    running.value = false
  }
}

async function fix(check: DoctorCheck): Promise<void> {
  if (!check.fixId) return
  fixing.value = true
  try {
    const res = await ipc('doctor.fix', store.activeInstanceId || 'default', check.fixId)
    message[res.ok ? 'success' : 'error'](res.message)
    await run()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    fixing.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">健康诊断</h1>
        <p class="page-subtitle">Python / Torch / 路径 / 端口 / Registry 全项体检，可一键修复。</p>
      </div>
      <NSpace>
        <NButton type="primary" :loading="running" @click="run">
          <template #icon><NIcon :component="FlashOutline" /></template>
          开始体检
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="running || fixing">
      <template v-if="report">
        <div class="summary card">
          <div class="sum-item">
            <div class="sum-num" style="color: #059669">{{ report.summary.pass }}</div>
            <div class="sum-label">通过</div>
          </div>
          <div class="sum-item">
            <div class="sum-num" style="color: #b45309">{{ report.summary.warn }}</div>
            <div class="sum-label">警告</div>
          </div>
          <div class="sum-item">
            <div class="sum-num" style="color: #b91c1c">{{ report.summary.fail }}</div>
            <div class="sum-label">失败</div>
          </div>
          <div class="sum-item">
            <div class="sum-num">{{ (report.durationMs / 1000).toFixed(1) }}s</div>
            <div class="sum-label">耗时</div>
          </div>
        </div>

        <div class="grid checks">
          <article v-for="check in report.checks" :key="check.id" class="card check">
            <div class="check-top">
              <div class="check-icon" :class="check.severity">
                <NIcon :size="20" :component="iconFor(check.severity)" />
              </div>
              <div style="flex:1">
                <div class="check-title">{{ check.title }}</div>
                <div class="check-group">
                  <NTag size="tiny" round>{{ check.group }}</NTag>
                  <span class="chip" :class="toneFor(check.severity)">{{ check.severity }}</span>
                </div>
              </div>
              <NButton
                v-if="check.fixable && check.fixId"
                size="tiny"
                type="primary"
                secondary
                @click="fix(check)"
              >
                <template #icon><NIcon :component="ConstructOutline" /></template>
                一键修复
              </NButton>
            </div>
            <div class="check-detail mono">{{ check.detail }}</div>
            <div v-if="check.suggestion" class="check-fix">
              <NIcon :size="14" :component="MedkitOutline" />
              {{ check.suggestion }}
            </div>
          </article>
        </div>
      </template>
      <NEmpty v-else description="点击右上角「开始体检」，对当前 ComfyUI 实例做一次全面检查" class="empty">
        <template #icon>
          <NIcon :size="48" :component="MedkitOutline" style="color: #7c5cfc" />
        </template>
      </NEmpty>
    </NSpin>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.summary { display: grid; grid-template-columns: repeat(4, 1fr); padding: 20px; margin-bottom: 16px; text-align: center; }
.sum-num { font-size: 30px; font-weight: 750; letter-spacing: -0.03em; }
.sum-label { margin-top: 4px; font-size: 12.5px; color: $color-text-muted; }
.checks { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.check { padding: 18px; }
.check-top { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.check-icon {
  width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
  &.pass { background: rgba(16, 185, 129, 0.14); color: #059669; }
  &.warn, &.info { background: rgba(245, 158, 11, 0.16); color: #b45309; }
  &.fail { background: rgba(239, 68, 68, 0.12); color: #b91c1c; }
}
.check-title { font-size: 15px; font-weight: 720; }
.check-group { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.check-detail { font-size: 12.5px; color: $color-text-secondary; background: $color-surface-2; border-radius: 10px; padding: 10px 12px; line-height: 1.55; word-break: break-all; }
.check-fix { margin-top: 10px; display: flex; gap: 6px; align-items: flex-start; font-size: 12.5px; color: #4f6ef7; line-height: 1.5; }
.empty { padding: 72px 0; }
</style>
