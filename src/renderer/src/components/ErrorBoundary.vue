<script setup lang="ts">
/**
 * Route-level error boundary (0.2.0).
 *
 * A render error in one view used to blank the whole shell. This catches it,
 * keeps the sidebar usable, and offers a retry that remounts the subtree.
 */
import { onErrorCaptured, ref } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { AlertCircleOutline, RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const error = ref<Error | null>(null)
const key = ref(0)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  // Stop propagation: the shell must stay alive.
  return false
})

function retry(): void {
  error.value = null
  key.value += 1
}
</script>

<template>
  <div v-if="error" class="error-boundary card">
    <div class="error-title">
      <NIcon :component="AlertCircleOutline" />
      {{ t('errorBoundary.title') }}
    </div>
    <div class="error-body">{{ t('errorBoundary.body') }}</div>
    <pre class="error-detail mono">{{ error.message }}</pre>
    <NButton type="primary" @click="retry">
      <template #icon><NIcon :component="RefreshOutline" /></template>
      {{ t('errorBoundary.retry') }}
    </NButton>
  </div>
  <div v-else :key="key" class="error-boundary-slot">
    <slot />
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.error-boundary {
  margin: 24px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}
.error-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 16px;
  color: $color-danger;
}
.error-body {
  font-size: 13px;
  color: $color-text-secondary;
}
.error-detail {
  font-size: 12px;
  padding: 10px;
  border-radius: 8px;
  background: $color-bg-soft;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
}
.error-boundary-slot {
  display: contents;
}
</style>
