<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpace, NSwitch, NTag } from 'naive-ui'
import type {
  AttentionSelfTestResult,
  ComfyInstanceInfo,
  EnvProbe,
  LaunchProfile
} from '@shared/types'
import {
  attentionOverview,
  type AttentionPackageId,
  type AttentionPackageState,
  type AttentionPackageStatus
} from '@shared/attention'
import { currentPlatform } from '@shared/pipRecipes'

const props = withDefaults(
  defineProps<{
    instance: ComfyInstanceInfo
    probe: EnvProbe | null
    selfTest: AttentionSelfTestResult | null
    probing?: boolean
    testing?: boolean
    installing?: AttentionPackageId | ''
    platform?: string
  }>(),
  { probing: false, testing: false, installing: '', platform: '' }
)

const emit = defineEmits<{
  (e: 'probe'): void
  (e: 'self-test'): void
  (e: 'install', id: AttentionPackageId): void
  (e: 'toggle-sage', active: boolean): void
  (e: 'toggle-xformers', disabled: boolean): void
}>()

/** Named events avoid inline event-name strings: the i18n scanner treats the
 * tail of an emit call as a translation key. */
const EVENTS = {
  probe: 'probe',
  selfTest: 'self-test',
  install: 'install',
  toggleSage: 'toggle-sage',
  toggleXformers: 'toggle-xformers'
} as const

const { t } = useI18n()

function requestProbe(): void {
  emit(EVENTS.probe)
}

function requestSelfTest(): void {
  emit(EVENTS.selfTest)
}

function installPackage(id: AttentionPackageId): void {
  emit(EVENTS.install, id)
}

function toggleSage(active: boolean): void {
  emit(EVENTS.toggleSage, active)
}

function toggleXformers(disabled: boolean): void {
  emit(EVENTS.toggleXformers, disabled)
}
const overview = computed(() =>
  attentionOverview(
    props.probe,
    props.instance.launchProfile as LaunchProfile | undefined,
    props.platform || currentPlatform(),
    props.instance.extraArgs
  )
)

const STATUS_KEYS: Record<AttentionPackageStatus, string> = {
  unknown: 'attention.status.unknown',
  'not-installed': 'attention.status.notInstalled',
  installed: 'attention.status.installed',
  outdated: 'attention.status.outdated',
  unsupported: 'attention.status.unsupported'
}

function statusText(state: AttentionPackageState): string {
  return t(STATUS_KEYS[state.status])
}

function tagType(state: AttentionPackageState): 'default' | 'success' | 'warning' | 'error' {
  if (state.status === 'installed') return 'success'
  if (state.status === 'outdated' || state.status === 'unsupported') return 'warning'
  if (state.status === 'unknown') return 'default'
  return 'default'
}

function installLabel(state: AttentionPackageState): string {
  if (state.status === 'outdated') return t('attention.upgrade')
  if (state.status === 'installed') return t('attention.reinstall')
  return t('attention.install')
}

function canToggleSage(): boolean {
  return overview.value.sageattention.status === 'installed' || overview.value.sageActive
}

function canToggleXformers(): boolean {
  return overview.value.xformers.status === 'installed'
}

function packageError(pkg: { ok: boolean; error?: string }): string {
  return pkg.ok ? '' : pkg.error || t('attention.fail')
}
</script>

<template>
  <div class="attention-card">
    <div class="attention-head">
      <div>
        <div class="attention-title">{{ t('attention.title') }}</div>
        <div class="attention-sub">{{ t('attention.subtitle') }}</div>
      </div>
      <NSpace :size="6">
        <NButton size="tiny" secondary :loading="probing" @click="requestProbe">
          {{ t('attention.probe') }}
        </NButton>
        <NButton
          size="tiny"
          secondary
          :loading="testing"
          :disabled="!probe"
          @click="requestSelfTest"
        >
          {{ t('attention.selfTest') }}
        </NButton>
      </NSpace>
    </div>

    <div v-if="!probe" class="attention-empty">{{ t('attention.probeHint') }}</div>

    <template v-else>
      <div class="attention-env">
        <span>Python {{ probe.pythonVersion || '—' }}</span>
        <span>torch {{ probe.torchVersion || '—' }}</span>
        <span v-if="probe.cudaVersion">CUDA {{ probe.cudaVersion }}</span>
      </div>

      <div class="attention-row">
        <div class="attention-name">SageAttention</div>
        <NTag size="small" round :type="tagType(overview.sageattention)">
          {{ statusText(overview.sageattention) }}
        </NTag>
        <span class="attention-version mono">{{
          overview.sageattention.version || t('attention.noVersion')
        }}</span>
        <NSpace :size="6" class="attention-actions">
          <NButton
            v-if="overview.sageattention.canInstall"
            size="tiny"
            secondary
            :loading="installing === 'sageattention'"
            @click="installPackage('sageattention')"
          >
            {{ installLabel(overview.sageattention) }}
          </NButton>
          <label class="attention-switch">
            <span>{{ t('attention.useSage') }}</span>
            <NSwitch
              :value="overview.sageActive"
              :disabled="!canToggleSage()"
              @update:value="toggleSage"
            />
          </label>
        </NSpace>
      </div>
      <div class="attention-hint">{{ t('attention.sageHint') }}</div>

      <div class="attention-row">
        <div class="attention-name">xFormers</div>
        <NTag size="small" round :type="tagType(overview.xformers)">
          {{ statusText(overview.xformers) }}
        </NTag>
        <span class="attention-version mono">{{
          overview.xformers.version || t('attention.noVersion')
        }}</span>
        <NSpace :size="6" class="attention-actions">
          <NButton
            v-if="overview.xformers.canInstall"
            size="tiny"
            secondary
            :loading="installing === 'xformers'"
            @click="installPackage('xformers')"
          >
            {{ installLabel(overview.xformers) }}
          </NButton>
          <label class="attention-switch">
            <span>{{ t('attention.disableXformers') }}</span>
            <NSwitch
              :value="overview.xformersDisabled"
              :disabled="!canToggleXformers()"
              @update:value="toggleXformers"
            />
          </label>
        </NSpace>
      </div>
      <div class="attention-hint">{{ t('attention.xformersHint') }}</div>

      <div v-if="selfTest" class="attention-selftest">
        <div class="attention-selftest-title">{{ t('attention.selfTestResult') }}</div>
        <div class="attention-env">
          <span v-if="selfTest.gpuName">{{ selfTest.gpuName }}</span>
          <span v-if="selfTest.computeCapability"
            >sm{{ selfTest.computeCapability.replace('.', '') }}</span
          >
          <span v-if="selfTest.torchVersion">torch {{ selfTest.torchVersion }}</span>
        </div>
        <div class="attention-selftest-row">
          <span>SageAttention</span>
          <NTag size="tiny" :type="selfTest.sageattention.ok ? 'success' : 'error'">
            {{ selfTest.sageattention.ok ? t('attention.pass') : t('attention.fail') }}
          </NTag>
          <span v-if="selfTest.sageattention.version" class="mono">
            {{ selfTest.sageattention.version }}
          </span>
          <span v-if="!selfTest.sageattention.ok" class="attention-error">
            {{ packageError(selfTest.sageattention) }}
          </span>
        </div>
        <div class="attention-selftest-row">
          <span>xFormers</span>
          <NTag size="tiny" :type="selfTest.xformers.ok ? 'success' : 'error'">
            {{ selfTest.xformers.ok ? t('attention.pass') : t('attention.fail') }}
          </NTag>
          <span v-if="selfTest.xformers.version" class="mono">
            {{ selfTest.xformers.version }}
          </span>
          <span v-if="!selfTest.xformers.ok" class="attention-error">
            {{ packageError(selfTest.xformers) }}
          </span>
        </div>
        <div v-if="selfTest.error" class="attention-error">{{ selfTest.error }}</div>
      </div>

      <div class="attention-hint">{{ t('attention.restartHint') }}</div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.attention-card {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: $color-surface-2;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attention-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.attention-title {
  font-size: 13px;
  font-weight: 700;
  color: $color-text-muted-ink;
}

.attention-sub,
.attention-empty,
.attention-hint {
  font-size: 12px;
  color: $color-text-secondary;
  line-height: 1.5;
}

.attention-env {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: $color-text-secondary;
}

.attention-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(128, 128, 128, 0.16);
}

.attention-name {
  min-width: 96px;
  font-size: 12.5px;
  font-weight: 600;
}

.attention-version {
  min-width: 100px;
  font-size: 12px;
  color: $color-text-secondary;
}

.attention-actions {
  margin-left: auto;
  align-items: center;
}

.attention-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $color-text-secondary;
}

.attention-selftest {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(128, 128, 128, 0.08);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.attention-selftest-title {
  font-size: 12px;
  font-weight: 700;
  color: $color-text-muted-ink;
}

.attention-selftest-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.attention-error {
  color: $color-danger;
  font-size: 12px;
  word-break: break-word;
}
</style>
