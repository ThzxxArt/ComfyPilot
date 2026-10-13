/** Compare zh-CN vs en-US locale key trees. */
const path = require('path')
// Use ts via simple eval is hard — parse exports with regex from the TS files as objects via Function
const fs = require('fs')

function loadKeys(file) {
  const src = fs.readFileSync(file, 'utf8')
  // strip export default and evaluate as object literal-ish
  const body = src.replace(/export\s+default\s*/, 'module.exports = ')
  const m = { exports: {} }
  const fn = new Function('module', 'exports', body)
  fn(m, m.exports)
  const keys = []
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? prefix + '.' + k : k
      if (v && typeof v === 'object') walk(v, p)
      else keys.push(p)
    }
  }
  walk(m.exports, '')
  return new Set(keys)
}

const zh = loadKeys(path.join(__dirname, '../src/renderer/src/i18n/locales/zh-CN.ts'))
const en = loadKeys(path.join(__dirname, '../src/renderer/src/i18n/locales/en-US.ts'))
const onlyZh = [...zh].filter((k) => !en.has(k))
const onlyEn = [...en].filter((k) => !zh.has(k))
console.log('zh keys', zh.size, 'en keys', en.size)
if (onlyZh.length) console.log('ONLY ZH:', onlyZh.join(', '))
if (onlyEn.length) console.log('ONLY EN:', onlyEn.join(', '))
if (!onlyZh.length && !onlyEn.length) console.log('PARITY OK')
// Key-tree drift is a hard failure — it silently produces raw keys in the UI.
if (onlyZh.length || onlyEn.length) process.exitCode = 1
// Now scan for $t('x') / t('x') usages and check they exist in zh
const used = new Set()
function scanDir(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) scanDir(p)
    else if (/\.(vue|ts)$/.test(ent.name)) {
      const src = fs.readFileSync(p, 'utf8')
      for (const m of src.matchAll(/[$]?t\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) used.add(m[1])
    }
  }
}
scanDir(path.join(__dirname, '../src/renderer/src'))
const missing = [...used].filter((k) => !zh.has(k) && !k.startsWith('$'))
console.log('used keys', used.size)
if (missing.length) console.log('MISSING IN ZH:', missing.join(', '))
else console.log('ALL USED KEYS PRESENT')
// A used-but-missing key renders as the raw key — fail the gate.
if (missing.length) process.exitCode = 1

// Dynamic key domains (template-literal t() calls are invisible to the regex above)
function has(path) {
  return zh.has(path) && en.has(path)
}
const dynamicDomains = {
  'status.*': ['stopped', 'starting', 'running', 'error', 'unknown', 'remote'],
  'launchTpl.*.name': [
    'default',
    'preview-taesd',
    'manager',
    'offline',
    'lan',
    'lowvram',
    'vram-save',
    'cache-none',
    'cpu'
  ],
  'launchTpl.*.desc': [
    'default',
    'preview-taesd',
    'manager',
    'offline',
    'lan',
    'lowvram',
    'vram-save',
    'cache-none',
    'cpu'
  ],
  'launchArgs.*': [
    'warnUnknownFlag',
    'warnRecentFlag',
    'warnDuplicateListen',
    'errVramConflict',
    'errCacheConflict',
    'errAttentionConflict',
    'errUnetConflict',
    'errVaeConflict',
    'errTextEncConflict',
    'errFpConflict',
    'errUpcastConflict',
    'errCudaMallocConflict',
    'errInvalidNumber',
    'errGeneric'
  ],
  'starterModels.*.desc': ['sd15', 'sdxl', 'flux'],
  'install.torchChannels.*': ['cu130', 'cu126', 'cu124', 'rocm', 'xpu', 'mps', 'cpu'],
  'stepMsg.*': [
    'bootstrapRun',
    'bootstrapDone',
    'preflightRun',
    'preflightDone',
    'pythonRun',
    'venvUv',
    'venvPy',
    'venvDone',
    'comfyGit',
    'comfyZip',
    'comfyReuse',
    'comfyCloned',
    'comfyExtracted',
    'torchRun',
    'reqRun',
    'reqDone',
    'reqSkip',
    'regRun',
    'regDone',
    'starterSkip',
    'starterRun',
    'starterDone',
    'doneStarted',
    'doneStartFail',
    'done'
  ],
  // Must match detailKey strings emitted by src/main/services/installer.ts
  'preflight.*': [
    'rootOk',
    'rootBad',
    'disk',
    'diskNew',
    'diskUnknown',
    'gitMissing',
    'pythonOld',
    'pythonMissing',
    'uvMissing'
  ],
  'update.*': [
    'stepPreflight',
    'stepVenv',
    'stepStop',
    'stepBackup',
    'stepFetch',
    'stepDownload',
    'stepClone',
    'stepUnpack',
    'stepRequirements',
    'stepTorch',
    'stepVerify',
    'stepRollback',
    'stepDone',
    'msgRun',
    'msgDone',
    'msgBackup',
    'msgFetchGit',
    'msgFetchZip',
    'msgReqRun',
    'msgReqDone',
    'msgTorchRun',
    'msgTorchDone',
    'msgVerifyRun',
    'msgVerifyOk',
    'msgRollback',
    'msgRollbackFail',
    'msgDoneStarted',
    'msgDoneStartFail'
  ],
  'nodes.*': [
    'checkUpdates',
    'checking',
    'update',
    'updateAll',
    'updating',
    'updateDone',
    'updateFailed',
    'upToDate',
    'hasUpdate',
    'notUpdatable',
    'rolledBack',
    'rollbackFailed',
    'confirmUpdate',
    'confirmUpdateAll',
    'batchDone',
    'restoreHint'
  ],
  'gpu.*': [
    'nvidiaDefault',
    'nvidiaRtx',
    'amdLinux',
    'amdWindows',
    'intel',
    'apple',
    'none',
    'failed'
  ],
  // Must match BatchJobStatus in src/shared/types.ts
  'batch.status.*': ['queued', 'submitting', 'running', 'done', 'error', 'cancelled'],
  // Must match DoctorCheck.group values emitted by src/main/services/doctor.ts
  'doctor.group.*': ['Environment', 'Runtime', 'Storage', 'Extensions', 'Network'],
  // Must match DownloadTask.status in src/shared/types.ts
  'models.dlStatus.*': ['queued', 'running', 'paused', 'done', 'error', 'cancelled'],
  // Must match InstallStepStatus in src/shared/types.ts
  'install.stepStatus.*': ['pending', 'running', 'done', 'failed', 'skipped', 'cancelled'],
  // Must match InstallView FIX_LABEL_KEY (bootstrap fix ids)
  'install.fix*': ['Python', 'Git', 'Uv'],
  // Must match netProbe mirror labels used via `settings.${k}`
  'settings.*': [
    'pipOfficial',
    'pipTsinghua',
    'mirrorAliyun',
    'pipUstc',
    'torchOfficial',
    'torchSjtu',
    'githubOfficial',
    'githubGhproxy'
  ],
  // Must match titleKey/messageKey emitted by the main-process notifier
  'notify.*': [
    'nodeInstalled',
    'nodeUninstalled',
    'nodeUpdated',
    'batchDone',
    'batchFailed',
    'batchCancelled',
    'downloadDone',
    'downloadFailed',
    'indexWarning',
    'backupRestored',
    'restartRequired',
    'postUpdateNodeCheck'
  ],
  // Must match ModelsView CATEGORY_KEYS (ComfyUI folder_paths registry)
  'models.cat.*': [
    'checkpoints',
    'diffusion_models',
    'loras',
    'vae',
    'text_encoders',
    'clip_vision',
    'controlnet',
    'upscale_models',
    'embeddings',
    'style_models',
    'diffusers',
    'vae_approx',
    'gligen',
    'latent_upscale_models',
    'photomaker',
    'classifiers',
    'model_patches',
    'audio_encoders',
    'hypernetworks',
    'background_removal',
    'frame_interpolation',
    'geometry_estimation',
    'optical_flow',
    'detection',
    'clip',
    'unet',
    'other'
  ],
  // Must match /api/jobs statuses handled by MonitorView.jobStatusLabel
  'monitor.job.*': ['pending', 'in_progress', 'completed', 'failed', 'cancelled']
}
let dynBad = 0
for (const [pattern, leafs] of Object.entries(dynamicDomains)) {
  const prefix = pattern.split('*')[0]
  for (const leaf of leafs) {
    const key = prefix.endsWith('.') ? prefix + leaf : pattern.replace('*', leaf)
    // launchTpl.default.name style
    const full = pattern.includes('.*.') ? prefix + leaf + pattern.split('*')[1] : key
    if (!has(full)) {
      console.log('MISSING DYNAMIC KEY:', full)
      dynBad++
    }
  }
}
if (!dynBad) console.log('ALL DYNAMIC DOMAINS PRESENT')
else process.exitCode = 1
