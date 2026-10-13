<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCollapse,
  NCollapseItem,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NTag,
  NText
} from 'naive-ui'
import type { LaunchProfile } from '@shared/types'
import {
  LAUNCH_ARG_ERROR_KEYS,
  launchArgWarningKey,
  renderLaunchProfile,
  validateLaunchArgs,
  warnLaunchArgs
} from '@shared/launchArgs'

/**
 * Structured ComfyUI launch tuning editor (0.1.9).
 * Every control maps to `comfy/cli_args.py` flags; mutually-exclusive groups
 * are modeled as single selects, and the live validation line catches
 * conflicts coming from free-text extraArgs (passed in via `extraArgs`).
 */
const props = defineProps<{ extraArgs?: string[] }>()
const profile = defineModel<LaunchProfile>({ required: true })
const { t } = useI18n()

const opt = (label: string, value: string): { label: string; value: string } => ({
  label: t(label),
  value
})

const vramOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optGpuOnly', 'gpu-only'),
  opt('launchArgs.optHighvram', 'highvram'),
  opt('launchArgs.optLowvram', 'lowvram'),
  opt('launchArgs.optNovram', 'novram'),
  opt('launchArgs.optCpu', 'cpu')
])
const cacheOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optCacheClassic', 'classic'),
  opt('launchArgs.optCacheLru', 'lru'),
  opt('launchArgs.optCacheNone', 'none'),
  opt('launchArgs.optCacheHighRam', 'high-ram')
])
const previewOptions = computed(() => [
  { label: t('launchArgs.optPreviewNone'), value: 'none' },
  opt('launchArgs.optPreviewAuto', 'auto'),
  opt('launchArgs.optPreviewLatent', 'latent2rgb'),
  opt('launchArgs.optPreviewTaesd', 'taesd')
])
const attentionOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optAttnSplit', 'split'),
  opt('launchArgs.optAttnQuad', 'quad'),
  opt('launchArgs.optAttnPytorch', 'pytorch'),
  opt('launchArgs.optAttnSage', 'sage'),
  opt('launchArgs.optAttnFlash', 'flash'),
  opt('launchArgs.optAttnCk', 'ck')
])
const upcastOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optUpcastForce', 'force'),
  opt('launchArgs.optUpcastDisable', 'disable')
])
const unetOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optUnetFp32', 'fp32'),
  opt('launchArgs.optUnetFp64', 'fp64'),
  opt('launchArgs.optUnetBf16', 'bf16'),
  opt('launchArgs.optUnetFp16', 'fp16'),
  opt('launchArgs.optUnetFp8e4', 'fp8_e4m3fn'),
  opt('launchArgs.optUnetFp8e5', 'fp8_e5m2'),
  opt('launchArgs.optUnetFp8e8', 'fp8_e8m0fnu')
])
const vaeOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optVaeFp16', 'fp16'),
  opt('launchArgs.optVaeFp32', 'fp32'),
  opt('launchArgs.optVaeBf16', 'bf16')
])
const textEncOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optTeFp8e4', 'fp8_e4m3fn'),
  opt('launchArgs.optTeFp8e5', 'fp8_e5m2'),
  opt('launchArgs.optTeFp16', 'fp16'),
  opt('launchArgs.optTeFp32', 'fp32'),
  opt('launchArgs.optTeBf16', 'bf16')
])
const asyncOptions = computed(() => [
  { label: t('launchArgs.optDefault'), value: 'default' },
  opt('launchArgs.optAsyncOn', 'on'),
  opt('launchArgs.optAsyncOff', 'off')
])

const fullArgs = computed(() => [...renderLaunchProfile(profile.value), ...(props.extraArgs || [])])
const errors = computed(() => validateLaunchArgs(fullArgs.value))
const warnings = computed(() => warnLaunchArgs(fullArgs.value))

function warningText(w: { code: string; flag: string }): string {
  return t(launchArgWarningKey(w.code), { flag: w.flag })
}

function errorText(e: { code: string; flag?: string }): string {
  if (e.code === 'invalid-number') return t('launchArgs.errInvalidNumber', { flag: e.flag || '' })
  return t(LAUNCH_ARG_ERROR_KEYS[e.code] || 'launchArgs.errGeneric', { flag: e.flag || '' })
}
</script>

<template>
  <NCollapse class="profile-editor" :default-expanded-names="[]">
    <NCollapseItem :title="t('launchArgs.title')" name="profile">
      <NText depth="3" class="pe-note">{{ t('launchArgs.intro') }}</NText>

      <NCollapse :default-expanded-names="['vram']" class="pe-groups">
        <NCollapseItem :title="t('launchArgs.gVram')" name="vram">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fVram')" class="pe-field">
              <NSelect v-model:value="profile.vram" :options="vramOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fReserveVram')" class="pe-field">
              <NInputNumber
                v-model:value="profile.reserveVram"
                :min="0"
                :max="1024"
                :step="0.5"
                clearable
              />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fVramHeadroom')" class="pe-field">
              <NInputNumber
                v-model:value="profile.vramHeadroom"
                :min="0"
                :max="1024"
                :step="0.5"
                clearable
              />
            </NFormItem>
          </div>
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fFastDisk')" class="pe-field">
              <NSwitch v-model:value="profile.fastDisk" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fDisableSmartMemory')" class="pe-field">
              <NSwitch v-model:value="profile.disableSmartMemory" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fDisableCudaGraphs')" class="pe-field">
              <NSwitch v-model:value="profile.disableCudaGraphs" />
            </NFormItem>
          </div>
          <NText depth="3" class="pe-hint">{{ t('launchArgs.vramNote') }}</NText>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gPreview')" name="preview">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fPreview')" class="pe-field">
              <NSelect v-model:value="profile.previewMethod" :options="previewOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fPreviewSize')" class="pe-field">
              <NInputNumber v-model:value="profile.previewSize" :min="16" :max="8192" clearable />
            </NFormItem>
          </div>
          <NText depth="3" class="pe-hint">{{ t('launchArgs.previewNote') }}</NText>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gCache')" name="cache">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fCache')" class="pe-field">
              <NSelect v-model:value="profile.cache" :options="cacheOptions" />
            </NFormItem>
            <NFormItem
              v-if="profile.cache === 'lru'"
              :label="t('launchArgs.fCacheLru')"
              class="pe-field"
            >
              <NInputNumber v-model:value="profile.cacheLru" :min="1" :max="100000" clearable />
            </NFormItem>
          </div>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gAttention')" name="attention">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fAttention')" class="pe-field">
              <NSelect v-model:value="profile.attention" :options="attentionOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fUpcast')" class="pe-field">
              <NSelect v-model:value="profile.attentionUpcast" :options="upcastOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fDisableXformers')" class="pe-field">
              <NSwitch v-model:value="profile.disableXformers" />
            </NFormItem>
          </div>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gPrecision')" name="precision">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fUnet')" class="pe-field">
              <NSelect v-model:value="profile.unetPrecision" :options="unetOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fVae')" class="pe-field">
              <NSelect v-model:value="profile.vaePrecision" :options="vaeOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fTextEnc')" class="pe-field">
              <NSelect v-model:value="profile.textEncoderPrecision" :options="textEncOptions" />
            </NFormItem>
          </div>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gIo')" name="io">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fAsyncOffload')" class="pe-field">
              <NSelect v-model:value="profile.asyncOffload" :options="asyncOptions" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fDisablePinnedMemory')" class="pe-field">
              <NSwitch v-model:value="profile.disablePinnedMemory" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fMmapTorchFiles')" class="pe-field">
              <NSwitch v-model:value="profile.mmapTorchFiles" />
            </NFormItem>
          </div>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gNetwork')" name="network">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fCors')" class="pe-field">
              <NInput
                v-model:value="profile.corsHeader"
                :placeholder="t('launchArgs.fCorsPlaceholder')"
                clearable
              />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fMaxUpload')" class="pe-field">
              <NInputNumber
                v-model:value="profile.maxUploadSize"
                :min="0.1"
                :max="1000000"
                clearable
              />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fMultiUser')" class="pe-field">
              <NSwitch v-model:value="profile.multiUser" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fOffline')" class="pe-field">
              <NSwitch v-model:value="profile.offline" />
            </NFormItem>
          </div>
        </NCollapseItem>

        <NCollapseItem :title="t('launchArgs.gMisc')" name="misc">
          <div class="pe-row">
            <NFormItem :label="t('launchArgs.fDisableAutoLaunch')" class="pe-field">
              <NSwitch v-model:value="profile.disableAutoLaunch" />
            </NFormItem>
            <NFormItem :label="t('launchArgs.fVerbose')" class="pe-field">
              <NSwitch v-model:value="profile.verbose" />
            </NFormItem>
          </div>
          <NText depth="3" class="pe-hint">{{ t('launchArgs.autoLaunchNote') }}</NText>
        </NCollapseItem>
      </NCollapse>

      <div class="pe-result">
        <div class="pe-result-title">
          {{ t('launchArgs.resultPreview') }}
          <NTag v-if="errors.length" size="tiny" type="error" round>
            {{ t('launchArgs.conflictCount', { n: errors.length }) }}
          </NTag>
        </div>
        <code class="pe-result-args mono">
          {{ fullArgs.length ? fullArgs.join(' ') : t('launchArgs.noExtraArgs') }}
        </code>
        <div v-if="errors.length" class="pe-errors">
          <div v-for="(e, i) in errors" :key="i" class="pe-error">• {{ errorText(e) }}</div>
        </div>
        <div v-if="warnings.length" class="pe-warns">
          <div v-for="(w, i) in warnings" :key="i" class="pe-warn">• {{ warningText(w) }}</div>
        </div>
      </div>
    </NCollapseItem>
  </NCollapse>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.profile-editor {
  margin-bottom: 4px;
}

.pe-note,
.pe-hint {
  font-size: 12px;
  display: block;
  margin-bottom: 8px;
  line-height: 1.6;
}

.pe-groups {
  margin-bottom: 8px;
}

.pe-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.pe-field {
  min-width: 210px;
  flex: 1;
}

.pe-result {
  border: 1px solid $color-border;
  border-radius: 12px;
  padding: 10px 12px;
  background: $color-bg-soft;
}

.pe-result-title {
  font-size: 12.5px;
  font-weight: 600;
  color: $color-text-secondary;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.pe-result-args {
  display: block;
  font-size: 11.5px;
  color: $color-text-secondary;
  word-break: break-all;
  white-space: pre-wrap;
}

.pe-errors {
  margin-top: 6px;
}

.pe-error {
  font-size: 12px;
  color: $color-danger;
  line-height: 1.7;
}

.pe-warns {
  margin-top: 4px;
}

.pe-warn {
  font-size: 12px;
  color: $color-warning;
  line-height: 1.7;
}
</style>
