<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  MedkitOutline,
  CheckmarkCircleOutline,
  WarningOutline,
  CloseCircleOutline,
  FlashOutline,
  ConstructOutline
} from '@vicons/ionicons5'
import { NButton, NIcon, NSpace, NSpin, NTag, useMessage, NEmpty, NProgress } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { reportMatchesInstance, useInstanceScope } from '@/composables/useInstanceScope'
import { ipc, onDoctorProgress } from '@/composables/useIpc'
import ListSkeleton from '@/components/ListSkeleton.vue'
import type { DoctorCheck, DoctorReport } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const { t, te } = useI18n()
const running = ref(false)
const fixing = ref(false)
/** Honest progress payload (0.1.15): checked count + phase title, no fake total. */
const progress = ref<{ done?: number; title?: string } | null>(null)
// Persisted in the app store so Dashboard "one-click doctor" survives the route change.
const report = ref<DoctorReport | null>(store.doctorReport)
/**
 * 0.1.17 (WP9): a report belongs to the instance it was produced for. Showing
 * (or worse, "fixing" from) another instance's report was possible before —
 * switching instances left the old report on screen.
 */
const reportIsCurrent = computed(() =>
  reportMatchesInstance(report.value?.instanceId, store.activeInstanceId)
)

useInstanceScope(() => {
  // Report, progress and any in-flight fix belong to the previous instance.
  report.value = null
  store.doctorReport = null
  progress.value = null
  fixing.value = false
})

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

/** Localized severity chip (raw enum must not leak). */
function sevLabel(s: DoctorCheck['severity']): string {
  if (s === 'pass') return t('doctor.pass')
  if (s === 'warn') return t('doctor.warn')
  if (s === 'fail') return t('doctor.fail')
  return t('doctor.info')
}

/** Localized check group (main emits English group names). */
function groupLabel(g: string): string {
  const key = `doctor.group.${g}`
  return te(key) ? t(key) : g
}

/** Guards against a slow report landing after the user switched instances. */
let runSeq = 0

async function run(): Promise<void> {
  const id = store.activeInstanceId
  if (!id) {
    message.warning(t('common.needRunningInstance'))
    return
  }
  const seq = ++runSeq
  running.value = true
  try {
    const result = await ipc('doctor.run', id)
    // 0.1.17 (review fix): switching instance clears the report, but the
    // in-flight run used to write the OLD instance's report back afterwards.
    if (seq !== runSeq || id !== store.activeInstanceId) return
    report.value = result
    store.doctorReport = result
    message.success(
      t('doctor.runComplete', {
        pass: result.summary.pass,
        warn: result.summary.warn,
        fail: result.summary.fail
      })
    )
  } catch (err) {
    if (seq !== runSeq || id !== store.activeInstanceId) return
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    if (seq === runSeq) running.value = false
  }
}

async function fix(check: DoctorCheck): Promise<void> {
  if (!check.fixId) return
  const id = store.activeInstanceId
  if (!id) {
    message.warning(t('common.needRunningInstance'))
    return
  }
  // 0.1.17 (WP9): never apply a fix derived from another instance's report.
  if (!reportIsCurrent.value) {
    message.warning(t('doctor.reportStale'))
    return
  }
  fixing.value = true
  try {
    const res = await ipc('doctor.fix', id, check.fixId)
    message[res.ok ? 'success' : 'error'](res.message)
    await run()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    fixing.value = false
  }
}

let offProgress: (() => void) | null = null
onMounted(() => {
  offProgress = onDoctorProgress((p) => {
    const info = p as { done?: number; title?: string }
    progress.value = info
  })
})
onUnmounted(() => offProgress?.())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ t('doctor.title') }}</h1>
        <p class="page-subtitle">{{ t('doctor.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton type="primary" :loading="running" @click="run">
          <template #icon><NIcon :component="FlashOutline" /></template>
          {{ t('doctor.run') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <div v-if="running && progress" class="doctor-progress card">
        <!-- Indeterminate bar: the check set is conditional, so a percentage
             would be fabricated. The honest signal is the checked COUNT. -->
        <NProgress type="line" :percentage="100" :height="8" :show-indicator="false" processing />
        <div class="doctor-progress-meta">
          {{ progress.title || t('doctor.run') }}
          <span v-if="progress.done"> — {{ t('doctor.checkedCount', { n: progress.done }) }}</span>
        </div>
      </div>
      <NSpin :show="(running || fixing) && !!report" :stroke-width="0">
        <ListSkeleton v-if="(running || fixing) && !report" :rows="6" variant="card" />
        <template v-else-if="report">
          <div class="summary card">
            <div class="sum-item">
              <div class="sum-num pass-ink">{{ report.summary.pass }}</div>
              <div class="sum-label">{{ t('doctor.pass') }}</div>
            </div>
            <div class="sum-item">
              <div class="sum-num warn-ink">{{ report.summary.warn }}</div>
              <div class="sum-label">{{ t('doctor.warn') }}</div>
            </div>
            <div class="sum-item">
              <div class="sum-num fail-ink">{{ report.summary.fail }}</div>
              <div class="sum-label">{{ t('doctor.fail') }}</div>
            </div>
            <div class="sum-item">
              <div class="sum-num">{{ (report.durationMs / 1000).toFixed(1) }}s</div>
              <div class="sum-label">{{ t('doctor.duration') }}</div>
            </div>
          </div>

          <div class="grid checks">
            <article v-for="check in report.checks" :key="check.id" class="card check">
              <div class="check-top">
                <div class="check-icon" :class="check.severity">
                  <NIcon :size="20" :component="iconFor(check.severity)" />
                </div>
                <div class="check-main">
                  <div class="check-title">{{ check.title }}</div>
                  <div class="check-group">
                    <NTag size="tiny" round>{{ groupLabel(check.group) }}</NTag>
                    <span class="chip" :class="toneFor(check.severity)">{{
                      sevLabel(check.severity)
                    }}</span>
                  </div>
                </div>
                <NButton
                  v-if="check.fixable && check.fixId"
                  size="tiny"
                  type="primary"
                  secondary
                  :disabled="fixing || running"
                  @click="fix(check)"
                >
                  <template #icon><NIcon :component="ConstructOutline" /></template>
                  {{ t('doctor.fix') }}
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
        <NEmpty v-else :description="t('doctor.empty')" class="empty">
          <template #icon>
            <NIcon :size="48" :component="MedkitOutline" class="medkit-icon" />
          </template>
        </NEmpty>
      </NSpin>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  padding: 20px;
  margin-bottom: 16px;
  text-align: center;
}
.doctor-progress {
  padding: 12px 16px;
  margin-bottom: 12px;
}
.doctor-progress-meta {
  margin-top: 6px;
  font-size: 12px;
  color: $color-text-muted-ink;
}
.sum-num {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.sum-label {
  margin-top: 4px;
  font-size: 12.5px;
  color: $color-text-muted-ink;
}
.checks {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  grid-auto-rows: 1fr;
}
.check {
  padding: 18px;
  display: flex;
  flex-direction: column;
}
.check-top {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 10px;
}
.check-main {
  flex: 1;
  min-width: 0;
}
.check-top > .n-button {
  flex-shrink: 0;
}
.check-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  &.pass {
    background: rgba($color-success, 0.14);
    color: $color-success;
  }
  &.warn,
  &.info {
    background: rgba($color-warning, 0.16);
    color: $color-warning;
  }
  &.fail {
    background: rgba($color-danger, 0.12);
    color: $color-danger;
  }
}
.check-title {
  font-size: 15px;
  font-weight: 700;
}
.check-group {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  align-items: center;
}
.check-detail {
  font-size: 12.5px;
  color: $color-text-secondary;
  background: $color-surface-2;
  border-radius: 10px;
  padding: 10px 12px;
  line-height: 1.55;
  word-break: break-all;
  margin-top: auto;
}
.check-fix {
  margin-top: 10px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12.5px;
  color: $color-primary;
  line-height: 1.5;
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
.medkit-icon {
  color: $color-primary-2;
}
.empty {
  padding: 64px 0;
}
</style>
