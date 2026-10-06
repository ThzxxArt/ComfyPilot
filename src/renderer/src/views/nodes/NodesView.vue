<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  ExtensionPuzzleOutline, RefreshOutline, WarningOutline, CheckmarkCircleOutline,
  DownloadOutline, LockClosedOutline, LockOpenOutline, GitBranchOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NSpace, NSpin, NTag, NSwitch, NEmpty, useMessage,
  NCollapse, NCollapseItem, NInput, NModal, NPopconfirm, NTabs, NTabPane, NList, NListItem
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import type { NodeNameConflict, NodePackRecord, NodeSnapshot, RegistryNodePack } from '@shared/types'

const message = useMessage()
const loading = ref(false)
const packs = ref<NodePackRecord[]>([])
const conflicts = ref<NodeNameConflict[]>([])
const snapshots = ref<NodeSnapshot[]>([])
const registry = ref<RegistryNodePack[]>([])
const registryQuery = ref('')
const showInstall = ref(false)
const installUrl = ref('')
const tab = ref('installed')

async function refresh(): Promise<void> {
  loading.value = true
  try {
    packs.value = await ipc('node.refresh')
    conflicts.value = await ipc('node.conflicts')
    snapshots.value = await ipc('node.snapshots')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function searchRegistry(): Promise<void> {
  try {
    registry.value = await ipc('node.registrySearch', { query: registryQuery.value, limit: 40 })
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function installRegistry(p: RegistryNodePack): Promise<void> {
  try {
    await ipc('node.install', { id: p.id, source: 'registry' })
    message.success(`已安装 ${p.name}`)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function installGit(): Promise<void> {
  if (!installUrl.value.trim()) return
  try {
    await ipc('node.install', { id: installUrl.value.trim(), source: 'git', url: installUrl.value.trim() })
    showInstall.value = false
    message.success('Git 安装完成')
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function toggle(pack: NodePackRecord, enabled: boolean): Promise<void> {
  try {
    await ipc('node.toggle', pack.name, enabled)
    await refresh()
    message.success(enabled ? '已启用' : '已禁用')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function lockPack(pack: NodePackRecord, locked: boolean): Promise<void> {
  await ipc('node.lock', pack.name, locked)
  await refresh()
  message.success(locked ? '已锁定' : '已解锁')
}

async function smoke(pack: NodePackRecord): Promise<void> {
  const issues = await ipc('node.smokeTest', pack.name)
  message[issues.some((i) => i.severity === 'error') ? 'error' : 'success'](
    issues.length ? issues[0].message : '冒烟测试通过'
  )
}

async function createSnapshot(): Promise<void> {
  const s = await ipc('node.createSnapshot')
  message.success(`快照：${s.name}`)
  await refresh()
}

async function restoreSnapshot(id: string): Promise<void> {
  await ipc('node.restoreSnapshot', id)
  message.success('快照已恢复（启用/禁用语义）')
  await refresh()
}

async function uninstall(pack: NodePackRecord): Promise<void> {
  try {
    await ipc('node.uninstall', pack.name)
    message.success('已卸载')
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeSnapshot(id: string): Promise<void> {
  try {
    await ipc('node.deleteSnapshot', id)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => {
  void refresh()
  void searchRegistry()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">节点管理</h1>
        <p class="page-subtitle">本地扫描、Registry 浏览安装、冲突检测、快照回滚。</p>
      </div>
      <NSpace>
        <NButton secondary @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>刷新
        </NButton>
        <NButton secondary @click="createSnapshot">创建快照</NButton>
        <NButton type="primary" @click="showInstall = true">Git 安装</NButton>
      </NSpace>
    </div>

    <NTabs v-model:value="tab" type="line">
      <NTabPane name="installed" :tab="`已安装 (${packs.length})`">
        <NSpin :show="loading">
          <div v-if="packs.length" class="grid cards">
            <article v-for="pack in packs" :key="pack.id" class="card card-interactive pack">
              <div class="pack-head">
                <div class="pack-icon"><NIcon :size="22" :component="ExtensionPuzzleOutline" /></div>
                <div style="flex:1">
                  <div class="pack-name">{{ pack.displayName }}</div>
                  <div class="pack-meta">v{{ pack.version }} · {{ pack.nodeCount }} nodes</div>
                </div>
                <NPopconfirm v-if="!pack.locked" @positive-click="uninstall(pack)">
                  <template #trigger>
                    <NButton size="tiny" type="error" secondary>卸载</NButton>
                  </template>
                  确认卸载 {{ pack.name }}？目录将被删除。
                </NPopconfirm>
                <NButton size="tiny" quaternary @click="lockPack(pack, !pack.locked)">
                  <template #icon>
                    <NIcon :component="pack.locked ? LockClosedOutline : LockOpenOutline" />
                  </template>
                </NButton>
                <NSwitch :value="pack.status !== 'disabled'" :disabled="pack.locked" @update:value="(v: boolean) => toggle(pack, v)" />
              </div>
              <p class="pack-desc">{{ pack.description || '暂无描述' }}</p>
              <div class="pack-tags">
                <NTag size="tiny" round :type="pack.status === 'disabled' ? 'default' : pack.status === 'error' ? 'error' : 'success'">
                  {{ pack.status }}
                </NTag>
                <NTag size="tiny" round>{{ pack.installSource }}</NTag>
                <NTag v-if="pack.locked" size="tiny" round type="warning">locked</NTag>
              </div>
              <div class="pack-actions">
                <NButton size="tiny" secondary @click="smoke(pack)">冒烟测试</NButton>
              </div>
              <NCollapse v-if="pack.issues?.length" class="issues" :arrow="false">
                <NCollapseItem :title="`健康提示（${pack.issues.length}）`" name="1">
                  <div v-for="(issue, idx) in pack.issues" :key="idx" class="issue">
                    <NIcon
                      :size="16"
                      :component="issue.severity === 'error' || issue.severity === 'warning' ? WarningOutline : CheckmarkCircleOutline"
                      :style="{ color: issue.severity === 'error' ? '#ef4444' : issue.severity === 'warning' ? '#f59e0b' : '#10b981' }"
                    />
                    <div>
                      <div class="issue-msg">{{ issue.message }}</div>
                      <div v-if="issue.suggestion" class="issue-fix">{{ issue.suggestion }}</div>
                    </div>
                  </div>
                </NCollapseItem>
              </NCollapse>
            </article>
          </div>
          <NEmpty v-else description="未发现 custom_nodes 节点包" class="empty" />
        </NSpin>
      </NTabPane>

      <NTabPane name="registry" tab="Registry 市场">
        <NSpace style="margin-bottom: 12px">
          <NInput v-model:value="registryQuery" placeholder="搜索 Registry 节点包" style="width: 280px" @keyup.enter="searchRegistry" />
          <NButton type="primary" secondary @click="searchRegistry">搜索</NButton>
        </NSpace>
        <NList bordered>
          <NListItem v-for="r in registry" :key="r.id">
            <div class="reg-row">
              <div>
                <div class="pack-name">{{ r.displayName }}</div>
                <div class="pack-desc">{{ r.description }}</div>
                <div class="pack-tags">
                  <NTag size="tiny" round>{{ r.author }}</NTag>
                  <NTag size="tiny" round>{{ r.latestVersion }}</NTag>
                  <NTag size="tiny" round>{{ r.downloads }} downloads</NTag>
                  <NTag v-if="r.status === 'flagged'" size="tiny" round type="warning">flagged</NTag>
                </div>
              </div>
              <NButton type="primary" secondary :disabled="r.status === 'banned'" @click="installRegistry(r)">
                <template #icon><NIcon :component="DownloadOutline" /></template>
                安装
              </NButton>
            </div>
          </NListItem>
        </NList>
      </NTabPane>

      <NTabPane name="conflicts" :tab="`冲突 (${conflicts.length})`">
        <div v-if="conflicts.length" class="card">
          <div v-for="c in conflicts" :key="c.nodeName" class="conflict-row">
            <div class="mono">{{ c.nodeName }}</div>
            <div class="pack-tags">
              <NTag v-for="p in c.packs" :key="p" size="tiny" type="warning" round>{{ p }}</NTag>
            </div>
          </div>
        </div>
        <NEmpty v-else description="未发现节点名冲突" />
      </NTabPane>

      <NTabPane name="snapshots" :tab="`快照 (${snapshots.length})`">
        <div v-if="snapshots.length" class="card">
          <div v-for="s in snapshots" :key="s.id" class="snap-row">
            <div>
              <div class="pack-name">{{ s.name }}</div>
              <div class="pack-meta">{{ new Date(s.createdAt).toLocaleString() }} · {{ s.packs.length }} packs</div>
            </div>
            <NSpace>
              <NButton size="small" secondary @click="restoreSnapshot(s.id)">恢复</NButton>
              <NPopconfirm @positive-click="removeSnapshot(s.id)">
                <template #trigger>
                  <NButton size="small" type="error" secondary>删除</NButton>
                </template>
                删除快照？
              </NPopconfirm>
            </NSpace>
          </div>
        </div>
        <NEmpty v-else description="尚无快照，安装节点前建议先创建" />
      </NTabPane>
    </NTabs>

    <NModal v-model:show="showInstall" preset="card" title="Git URL 安装" style="width: 520px; border-radius: 20px">
      <NInput v-model:value="installUrl" placeholder="https://github.com/user/repo.git">
        <template #prefix><NIcon :component="GitBranchOutline" /></template>
      </NInput>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showInstall = false">取消</NButton>
          <NButton type="primary" @click="installGit">安装</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.pack { padding: 18px; }
.pack-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.pack-icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: $gradient-soft; color: $color-primary; }
.pack-name { font-size: 15.5px; font-weight: 720; }
.pack-meta { font-size: 12px; color: $color-text-muted; margin-top: 2px; }
.pack-desc { font-size: 13px; color: $color-text-secondary; line-height: 1.55; min-height: 36px; margin: 0 0 10px; }
.pack-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.pack-actions { margin-top: 10px; }
.issues { margin-top: 10px; }
.issue { display: flex; gap: 8px; padding: 8px 0; font-size: 12.5px; color: $color-text-secondary; }
.issue-msg { color: $color-text; font-weight: 600; }
.issue-fix { margin-top: 2px; color: $color-text-muted; }
.reg-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; width: 100%; }
.conflict-row, .snap-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 4px; border-bottom: 1px solid $color-border; }
.empty { padding: 48px 0; }
</style>
