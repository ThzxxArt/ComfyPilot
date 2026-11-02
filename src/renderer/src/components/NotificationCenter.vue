<script setup lang="ts">
/**
 * 0.1.18 (WP6): persistent in-app notification center.
 *
 * Toasts were the only channel: miss one and the information was gone forever
 * (the store kept 20 in memory and nothing on disk). This keeps the last 200
 * notices, persists them, and exposes unread state.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NBadge, NButton, NDrawer, NDrawerContent, NEmpty, NIcon, NTag } from 'naive-ui'
import { NotificationsOutline } from '@vicons/ionicons5'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const router = useRouter()
const store = useAppStore()
const show = ref(false)

const items = computed(() => [...store.notifications].reverse())

function titleOf(n: (typeof store.notifications)[number]): string {
  return n.titleKey ? t(n.titleKey, n.params || {}) : n.title
}
function messageOf(n: (typeof store.notifications)[number]): string {
  return n.messageKey ? t(n.messageKey, n.params || {}) : n.message
}

const unread = computed(() => store.unreadCount)

const TYPE_KEYS: Record<'info' | 'success' | 'warning' | 'error', string> = {
  info: 'notifications.type_info',
  success: 'notifications.type_success',
  warning: 'notifications.type_warning',
  error: 'notifications.type_error'
}

function open(): void {
  show.value = true
  // Opening the center acknowledges everything currently visible. New notices
  // arriving while it is open are marked read immediately by the watcher below.
  store.markAllRead()
}

function markRead(): void {
  store.markAllRead()
}

function runAction(n: (typeof store.notifications)[number]): void {
  const action = n.action
  if (!action || action.type === 'none') return
  if (action.type === 'navigate' && action.target?.startsWith('/')) {
    show.value = false
    void router.push(action.target)
  }
}

// A notice arriving while the drawer is open is considered read.
watch(
  () => store.notificationSeq,
  () => {
    if (show.value) store.markAllRead()
  }
)
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
      <div v-if="items.length" class="notice-actions">
        <NButton size="tiny" secondary :disabled="unread === 0" @click="markRead">
          {{ t('notifications.markAllRead') }}
        </NButton>
      </div>
      <NEmpty v-if="!items.length" :description="t('notifications.empty')" />
      <div v-for="n in items" :key="n.id" class="notice-row">
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
        <div v-if="n.action && n.action.type !== 'none'" class="notice-action">
          <NButton size="tiny" secondary type="primary" @click="runAction(n)">
            {{
              n.action.labelKey
                ? t(n.action.labelKey, n.action.params || {})
                : t('notifications.openAction')
            }}
          </NButton>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.notice-btn {
  color: $color-text-secondary;
}
.notice-actions {
  display: flex;
  justify-content: flex-end;
  padding-bottom: 8px;
}
.notice-action {
  margin-top: 4px;
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
