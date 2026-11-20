<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HealthState, InstanceHealth } from '@shared/types'

const props = defineProps<{
  health?: InstanceHealth
  /** Status fallback when the watchdog has not produced a health fact yet. */
  status?: string
}>()

const { t } = useI18n()

const state = computed<HealthState>(() => {
  if (props.health) return props.health.state
  if (props.status === 'error') return 'crashed'
  if (props.status === 'starting') return 'suspect'
  if (props.status === 'running') return 'unknown'
  return 'stopped'
})

const cls = computed(() => `health-${state.value}`)
const label = computed(() => t(`health.state.${state.value}`))

const tip = computed(() => {
  const h = props.health
  if (!h) return label.value
  const bits = [
    label.value,
    h.latencyMs !== undefined ? `${h.latencyMs}ms` : '',
    h.consecutiveFailures ? `failures=${h.consecutiveFailures}` : '',
    ...h.evidence
  ].filter(Boolean)
  return bits.join(' · ')
})
</script>

<template>
  <span class="health-badge" :class="cls" :title="tip" :aria-label="tip">
    <span class="dot" aria-hidden="true" />
    <span class="text">{{ label }}</span>
  </span>
</template>

<style scoped>
.health-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.health-healthy {
  color: #18a058;
  border-color: rgba(24, 160, 88, 0.35);
  background: rgba(24, 160, 88, 0.08);
}
.health-busy {
  color: #2080f0;
  border-color: rgba(32, 128, 240, 0.35);
  background: rgba(32, 128, 240, 0.08);
}
.health-suspect,
.health-unknown {
  color: #f0a020;
  border-color: rgba(240, 160, 32, 0.35);
  background: rgba(240, 160, 32, 0.08);
}
.health-unresponsive,
.health-crashed {
  color: #d03050;
  border-color: rgba(208, 48, 80, 0.35);
  background: rgba(208, 48, 80, 0.08);
}
.health-stopped {
  color: #909399;
  border-color: rgba(144, 147, 153, 0.3);
  background: rgba(144, 147, 153, 0.06);
}
</style>
