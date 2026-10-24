<script setup lang="ts">
/**
 * 0.1.18 (WP2): one banner for "local-only page whose active target is remote
 * (or unset)". Without it, these pages silently showed/edited local assets
 * while the header pointed at another machine.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert } from 'naive-ui'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { t } = useI18n()

const mode = computed<'remote' | 'none' | null>(() => {
  if (store.isRemoteActive) return 'remote'
  if (!store.localTargetId) return 'none'
  return null
})
</script>

<template>
  <NAlert
    v-if="mode"
    :type="mode === 'remote' ? 'warning' : 'info'"
    :bordered="false"
    class="target-banner"
  >
    {{ t(`target.${mode}Banner`) }}
  </NAlert>
</template>

<style scoped>
.target-banner {
  margin-bottom: 12px;
  border-radius: 12px;
}
</style>
