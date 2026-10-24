<script setup lang="ts">
/**
 * 0.1.18 (WP6): global command palette (Ctrl/Cmd+K).
 *
 * The app had three keyboard shortcuts and no way to reach a view, instance or
 * common action without the mouse. This palette is deliberately small and
 * honest: every entry maps to a real route or IPC call.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NEmpty, NIcon, NInput, NModal, useMessage } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import { ipc } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import { useLaunch } from '@/composables/useLaunch'

const { t } = useI18n()
const message = useMessage()
const router = useRouter()
const store = useAppStore()
const { launch, stop } = useLaunch()

const show = ref(false)
const query = ref('')
const active = ref(0)

interface Command {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

const VIEWS: Array<{ path: string; key: string }> = [
  { path: '/', key: 'nav.dashboard' },
  { path: '/instances', key: 'nav.instances' },
  { path: '/install', key: 'nav.install' },
  { path: '/models', key: 'nav.models' },
  { path: '/nodes', key: 'nav.nodes' },
  { path: '/market', key: 'nav.market' },
  { path: '/workflows', key: 'nav.workflows' },
  { path: '/batch', key: 'nav.batch' },
  { path: '/output', key: 'nav.output' },
  { path: '/monitor', key: 'nav.monitor' },
  { path: '/doctor', key: 'nav.doctor' },
  { path: '/backup', key: 'nav.backup' },
  { path: '/settings', key: 'nav.settings' }
]

const commands = computed<Command[]>(() => {
  const list: Command[] = VIEWS.map((v) => ({
    id: `view:${v.path}`,
    label: t(v.key),
    hint: t('palette.view'),
    run: async () => {
      await router.push(v.path)
    }
  }))
  for (const inst of store.instances) {
    list.push({
      id: `instance:${inst.id}`,
      label: `${t('palette.switchInstance')} · ${inst.name}`,
      hint: inst.path,
      run: () => {
        // Selecting a local instance must clear a remote selection, otherwise
        // activeInstance stays null and the command appears to do nothing.
        store.activeRemoteId = null
        store.activeInstanceId = inst.id
        void router.push('/instances')
      }
    })
  }
  if (store.activeInstance) {
    list.push({
      id: 'action:launch',
      label: t('palette.launch'),
      hint: store.activeInstance.name,
      run: () => void launch(store.activeInstance!)
    })
    list.push({
      id: 'action:stop',
      label: t('palette.stop'),
      hint: store.activeInstance.name,
      run: () => void stop(store.activeInstance!)
    })
  }
  list.push({
    id: 'action:logs',
    label: t('palette.openLogs'),
    run: async () => {
      try {
        const dir = await ipc('settings.logsDir')
        if (dir) await ipc('shell.openPath', dir)
      } catch (err) {
        // An IPC failure used to become an unhandled rejection: the palette
        // closed and nothing opened, indistinguishable from success.
        message.error(err instanceof Error ? err.message : String(err))
      }
    }
  })
  return list
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter(
    (c) => c.label.toLowerCase().includes(q) || (c.hint || '').toLowerCase().includes(q)
  )
})

async function run(cmd: Command | undefined): Promise<void> {
  if (!cmd) return
  show.value = false
  query.value = ''
  await cmd.run()
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    show.value = !show.value
    query.value = ''
    active.value = 0
    return
  }
  if (!show.value) return
  if (e.key === 'Escape') {
    show.value = false
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = Math.min(active.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = Math.max(active.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void run(filtered.value[active.value])
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- No local @keydown: the window listener already handles every key while
       open. Having both made Enter run the selected command twice. -->
  <NModal v-model:show="show" :mask-closable="true" display-directive="show">
    <div class="palette" role="dialog" :aria-label="t('palette.title')">
      <NInput
        v-model:value="query"
        :placeholder="t('palette.placeholder')"
        autofocus
        clearable
        @update:value="active = 0"
      >
        <template #prefix><NIcon :component="SearchOutline" /></template>
      </NInput>
      <div class="palette-list">
        <NEmpty v-if="!filtered.length" :description="t('common.noMatch')" />
        <button
          v-for="(cmd, i) in filtered"
          :key="cmd.id"
          type="button"
          class="palette-item"
          :class="{ active: i === active }"
          @mouseenter="active = i"
          @click="run(cmd)"
        >
          <span class="palette-label">{{ cmd.label }}</span>
          <span v-if="cmd.hint" class="palette-hint mono">{{ cmd.hint }}</span>
        </button>
      </div>
    </div>
  </NModal>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.palette {
  width: min(620px, 92vw);
  margin: 12vh auto 0;
  border-radius: 16px;
  background: $color-surface;
  border: 1px solid $color-border;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  padding: 14px;
}
.palette-list {
  margin-top: 10px;
  max-height: 50vh;
  overflow-y: auto;
}
.palette-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: $color-text;
  text-align: left;
  cursor: pointer;
  &.active,
  &:hover {
    background: $color-surface-2;
  }
}
.palette-label {
  font-size: 13px;
}
.palette-hint {
  font-size: 11.5px;
  color: $color-text-muted-ink;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
}
</style>
