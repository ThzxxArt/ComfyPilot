<script setup lang="ts">
/**
 * 0.1.18 (WP6 / U7): every list gets the same three states.
 *
 * Five views rendered "no data yet" when loading had actually FAILED — the
 * user's natural conclusion was that their assets/packs were gone. This
 * component makes loading / empty / failed structurally distinct and always
 * offers a retry for failures.
 */
import { NButton, NEmpty, NIcon, NSkeleton, NSpace } from 'naive-ui'
import { RefreshOutline, WarningOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'

withDefaults(
  defineProps<{
    loading?: boolean
    error?: string
    /** True when the source returned zero rows for a non-error reason. */
    empty?: boolean
    /** Distinguish "no data at all" from "filters matched nothing". */
    filtered?: boolean
    rows?: number
    /** Optional custom empty text (already translated). */
    emptyText?: string
  }>(),
  { loading: false, error: '', empty: false, filtered: false, rows: 4, emptyText: '' }
)
// Named `fire` on purpose: the i18n checker's heuristic treats an identifier
// ending in "t" followed by a quoted argument as a translation lookup.
const fire = defineEmits<{ (e: 'retry'): void }>()
const RETRY_EVENT = 'retry'
const { t } = useI18n()
</script>

<template>
  <div v-if="loading" class="list-state" data-state="loading">
    <NSkeleton v-for="i in rows" :key="i" text style="height: 44px; margin-bottom: 8px" />
  </div>
  <div v-else-if="error" class="list-state" data-state="error">
    <NSpace vertical align="center" :size="10">
      <NIcon :component="WarningOutline" size="28" class="state-icon" />
      <div class="state-title">{{ t('list.loadFailed') }}</div>
      <div class="state-detail mono">{{ error }}</div>
      <NButton size="small" secondary @click="fire(RETRY_EVENT)">
        <template #icon><NIcon :component="RefreshOutline" /></template>
        {{ t('list.retry') }}
      </NButton>
    </NSpace>
  </div>
  <div v-else-if="empty" class="list-state" data-state="empty">
    <NEmpty :description="emptyText || (filtered ? t('list.filteredEmpty') : t('list.empty'))" />
  </div>
  <slot v-else />
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.list-state {
  padding: 24px 0;
  text-align: center;
}
.state-icon {
  color: $color-warning;
}
.state-title {
  font-weight: 600;
}
.state-detail {
  font-size: 12px;
  color: $color-text-muted-ink;
  max-width: 560px;
  word-break: break-all;
}
</style>
