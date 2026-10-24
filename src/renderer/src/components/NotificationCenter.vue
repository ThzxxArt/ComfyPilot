<script setup lang="ts">
/**
 * 0.1.18 (WP6): persistent in-app notification center.
 *
 * Toasts were the only channel: miss one and the information was gone forever
 * (the store kept 20 in memory and nothing on disk). This keeps the last 200
 * notices, persists them, and exposes unread state.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NBadge, NButton, NDrawer, NDrawerContent, NEmpty, NIcon, NTag } from 'naive-ui'
import { NotificationsOutline } from '@vicons/ionicons5'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const store = useAppStore()
const show = ref(false)
const READ_KEY = 'cp.notifications.readSeq'
const readSeq = ref(0)

const items = computed(() => [...store.notifications].reverse())

function titleOf(n: (typeof store.notifications)[number]): string {
  return n.titleKey ? t(n.titleKey, n.params || {}) : n.title
}
function messageOf(n: (typeof store.notifications)[number]): string {
  return n.messageKey ? t(n.messageKey, n.params || {}) : n.message
}

const unread = computed(() => Math.max(0, store.notificationSeq - readSeq.value))

const TYPE_KEYS: Record<'info' | 'success' | 'warning' | 'error', string> = {
  info: 'notifications.type_info',
  success: 'notifications.type_success',
  warning: 'notifications.type_warning',
  error: 'notifications.type_error'
}

function open(): void {
  show.value = true
  readSeq.value = store.notificationSeq
  try {
    localStorage.setItem(READ_KEY, String(readSeq.value))
  } catch {
    /* storage may be unavailable — unread badge resets next launch */
  }
}

// A new notice while the drawer is open counts as read.
watch(
  () => store.notificationSeq,
  (seq) => {
    if (!show.value) return
    readSeq.value = seq
    try {
      localStorage.setItem(READ_KEY, String(seq))
    } catch {
      /* ignore */
    }
  }
)

onMounted(() => {
  try {
    const raw = Number(localStorage.getItem(READ_KEY) || 0)
    if (Number.isFinite(raw) && raw > 0) readSeq.value = raw
  } catch {
    /* ignore */
  }
})
</script>

<template>
  <NBadge :value="unread" :show="unread > 0" :max="99">
    <NButton
      text
      class="notice-btn"
      :title="t('notifications.open')"
      :aria-label="t('notifications.open')"
      @click="open"
    >
      <template #icon><NIcon :component="NotificationsOutline" /></template>
    </NButton>
  </NBadge>

  <NDrawer v-model:show="show" :width="400" placement="right">
    <NDrawerContent :title="t('notifications.title')" closable>
      <NEmpty v-if="!items.length" :description="t('notifications.empty')" />
      <div v-for="(n, i) in items" :key="i" class="notice-row">
        <div class="notice-head">
          <NTag
            size="tiny"
            :type="
              n.type === 'error'
                ? 'error'
                : n.type === 'warning'
                  ? 'warning'
                  : n.type === 'success'
                    ? 'success'
                    : 'info'
            "
          >
            {{ t(TYPE_KEYS[n.type]) }}
          </NTag>
        </div>
        <div class="notice-title">{{ titleOf(n) }}</div>
        <div v-if="messageOf(n)" class="notice-body">{{ messageOf(n) }}</div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.notice-btn {
  color: $color-text-secondary;
}
.notice-row {
  padding: 10px 0;
  border-bottom: 1px solid $color-border;
  display: flex;
  flex-direction: column;
  gap: 4px;
  &:last-child {
    border-bottom: none;
  }
}
.notice-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.notice-time {
  font-size: 11.5px;
  color: $color-text-muted-ink;
}
.notice-title {
  font-size: 13px;
  font-weight: 600;
}
.notice-body {
  font-size: 12.5px;
  color: $color-text-secondary;
  word-break: break-word;
}
</style>
