import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

const readSrc = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ IPC channels: every channel has type + handler ============
describe('IPC channel coverage', () => {
  const typesSrc = readSrc('src/shared/types.ts')
  const handlersSrc = readSrc('src/main/ipc/handlers.ts')

  // Extract all channel names from IpcChannelMap
  const mapMatch = typesSrc.match(/export type IpcChannelMap = \{([\s\S]*?)\n\}/)
  const channels = [...(mapMatch?.[1] || '').matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1])

  it('found at least 130 channels', () => {
    expect(channels.length).toBeGreaterThanOrEqual(130)
  })

  // Generate a test for each channel
  for (const ch of channels.slice(0, 60)) {
    it(`channel '${ch}' is registered in handlers`, () => {
      expect(handlersSrc).toContain(`'${ch}'`)
    })
  }

  // Second batch
  for (const ch of channels.slice(60)) {
    it(`channel '${ch}' is registered in handlers`, () => {
      expect(handlersSrc).toContain(`'${ch}'`)
    })
  }
})

// ============ IPC_EVENTS: every event used in renderer ============
describe('IPC events used in renderer', () => {
  const appSrc = readSrc('src/renderer/src/stores/app.ts')
  const useIpcSrc = readSrc('src/renderer/src/composables/useIpc.ts')

  it('bindLive subscribes to instanceStatus', () => {
    expect(appSrc).toContain('onInstanceStatus')
    expect(useIpcSrc).toContain('onInstanceStatus')
  })

  it('bindLive subscribes to monitorTick', () => {
    expect(appSrc).toContain('onMonitorTick')
  })

  it('monitor WS events are consumed by the views that use them (0.1.12)', () => {
    // The store no longer buffers a dead wsEvents array; MonitorView and the
    // exec-diagnostics composable subscribe directly.
    const monitorSrc = readSrc('src/renderer/src/views/monitor/MonitorView.vue')
    expect(monitorSrc).toContain('IPC_EVENTS.monitorWs')
    const diagSrc = readSrc('src/renderer/src/composables/useExecDiagnostics.ts')
    expect(diagSrc).toContain('IPC_EVENTS.execError')
  })

  it('bindLive subscribes to notification', () => {
    expect(appSrc).toContain('onNotification')
  })
})

// ============ i18n key count parity ============
describe('i18n key parity', () => {
  const zh = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
  const en = readSrc('src/renderer/src/i18n/locales/en-US.ts')

  it('zh-CN has more than 900 keys', () => {
    const keys = [...zh.matchAll(/:\s*['"`]/g)].length
    expect(keys).toBeGreaterThan(900)
  })

  it('en-US has more than 900 keys', () => {
    const keys = [...en.matchAll(/:\s*['"`]/g)].length
    expect(keys).toBeGreaterThan(900)
  })

  it('both have similar key counts', () => {
    const zhCount = [...zh.matchAll(/:\s*['"`]/g)].length
    const enCount = [...en.matchAll(/:\s*['"`]/g)].length
    // Allow small variance (comments etc.)
    expect(Math.abs(zhCount - enCount)).toBeLessThan(20)
  })
})

// ============ Event wiring completeness ============
describe('main/index.ts event wiring', () => {
  const src = readSrc('src/main/index.ts')
  const events = [
    'IPC_EVENTS.instanceStatus',
    'IPC_EVENTS.instanceLog',
    'IPC_EVENTS.modelScanProgress',
    'IPC_EVENTS.downloadProgress',
    'IPC_EVENTS.monitorWs',
    'IPC_EVENTS.batchProgress',
    'IPC_EVENTS.installProgress',
    'IPC_EVENTS.runtimeProgress',
    'IPC_EVENTS.nodeInstallProgress',
    'IPC_EVENTS.nodeUpdateProgress',
    'IPC_EVENTS.nodeOperationProgress',
    'IPC_EVENTS.comfyUpdateProgress',
    'IPC_EVENTS.repairProgress',
    'IPC_EVENTS.doctorProgress',
    'IPC_EVENTS.registryIndexProgress'
  ]
  for (const e of events) {
    it(`broadcasts ${e.split('.').pop()}`, () => {
      expect(src).toContain(e)
    })
  }

  it('notification is broadcast via broadcastNotification', () => {
    // Notification goes through broadcastNotification in handlers.ts,
    // which is called from model/node/batch services via IPC_EVENTS.notification
    const handlersSrc = readSrc('src/main/ipc/handlers.ts')
    expect(handlersSrc).toContain('broadcastNotification')
    expect(handlersSrc).toContain('IPC_EVENTS.notification')
  })
})

// ============ Service singleton exports ============
describe('service singleton pattern', () => {
  const services = [
    'instanceService',
    'modelService',
    'nodePackService',
    'workflowService',
    'monitorService',
    'doctorService',
    'bootstrapService',
    'backupService',
    'envService',
    'batchService',
    'outputService',
    'remoteService',
    'marketService',
    'installerService',
    'comfyUpdaterService',
    'thumbnailService',
    'renameService',
    'aria2Service',
    'registryIndex'
  ]
  for (const s of services) {
    it(`${s} is exported`, () => {
      // Check at least one source file exports it
      const found = [
        'src/main/services/instance.ts',
        'src/main/services/model.ts',
        'src/main/services/nodePack.ts',
        'src/main/services/workflow.ts',
        'src/main/services/monitor.ts',
        'src/main/services/doctor.ts',
        'src/main/services/bootstrap.ts',
        'src/main/services/backup.ts',
        'src/main/services/env.ts',
        'src/main/services/p1p2.ts',
        'src/main/services/installer.ts',
        'src/main/services/updater.ts',
        'src/main/services/media.ts',
        'src/main/services/registryIndex.ts'
      ].some((f) => readSrc(f).includes(`export const ${s}`))
      expect(found, `${s} not found in any service`).toBe(true)
    })
  }
})

// ============ Settings field usage verification ============
describe('settings fields are used in business logic', () => {
  const fields = [
    'locale',
    'modelScanRoots',
    'githubEndpoint',
    'hfEndpoint',
    'civitaiEndpoint',
    'enableAutoCheckUpdates',
    'embedFrontend',
    'securityLevel',
    'allowGitUrlInstall',
    'allowPipInstall',
    'networkMode',
    'aria2Path',
    'useAria2',
    'launchOnBoot',
    'minimizeToTray',
    'autoStartInstancesOnLaunch',
    'pipIndex',
    'torchIndexMirror'
  ]
  const mainSrc = [
    'src/main/services/model.ts',
    'src/main/services/nodePack.ts',
    'src/main/services/installer.ts',
    'src/main/services/updater.ts',
    'src/main/services/bootstrap.ts',
    'src/main/services/proxy.ts',
    'src/main/services/registry.ts',
    'src/main/services/registryIndex.ts',
    'src/main/services/p1p2.ts',
    'src/main/index.ts',
    'src/main/ipc/handlers.ts'
  ]
    .map((f) => readSrc(f))
    .join('\n')

  for (const field of fields) {
    it(`'${field}' is read in main process`, () => {
      expect(mainSrc, `field ${field} not found`).toContain(field)
    })
  }
})

// ============ Error code consistency ============
describe('error codes are machine-readable', () => {
  const codes = [
    'PORT_IN_USE',
    'SETTING_OFFLINE',
    'SETTING_GIT_INSTALL',
    'SETTING_SECURITY_STRONG',
    'OP_CANCELLED'
  ]
  const allSrc = [
    'src/main/services/instance.ts',
    'src/main/services/nodePack.ts',
    'src/main/services/installer.ts',
    'src/main/services/updater.ts',
    'src/main/ipc/handlers.ts'
  ]
    .map((f) => readSrc(f))
    .join('\n')

  for (const code of codes) {
    it(`error code '${code}' exists`, () => {
      expect(allSrc).toContain(code)
    })
  }
})

// ============ Workflow: all origin types used ============
describe('workflow origins', () => {
  it('library, instance, external origins are defined', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain("'library'")
    expect(src).toContain("'instance'")
    expect(src).toContain("'external'")
    expect(src).toContain('WorkflowOrigin')
  })
})

// ============ Batch: all status types used ============
describe('batch statuses', () => {
  it('all statuses are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const statuses = ['queued', 'submitting', 'running', 'done', 'error', 'cancelled']
    for (const s of statuses) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('BatchJobStatus')
  })
})

// ============ Install: all step types used ============
describe('install steps', () => {
  it('all install step IDs are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const steps = [
      'bootstrap',
      'preflight',
      'python',
      'venv',
      'comfyui',
      'torch',
      'requirements',
      'register',
      'starter',
      'done'
    ]
    for (const s of steps) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('InstallStepId')
  })

  it('all update step IDs are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const steps = [
      'preflight',
      'venv',
      'stop',
      'backup',
      'fetch',
      'download',
      'clone',
      'unpack',
      'requirements',
      'torch',
      'verify',
      'rollback',
      'done'
    ]
    for (const s of steps) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('UpdateStepId')
  })
})

// ============ Model categories ============
describe('model categories', () => {
  it('all categories are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const cats = [
      'checkpoints',
      'diffusion_models',
      'loras',
      'vae',
      'clip',
      'controlnet',
      'upscale_models',
      'embeddings',
      'text_encoders',
      'unet',
      'other'
    ]
    for (const c of cats) {
      expect(src).toContain(`'${c}'`)
    }
    expect(src).toContain('ModelCategory')
  })
})

// ============ GPU channels ============
describe('torch channels', () => {
  it('all channels are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const channels = ['cu130', 'cu126', 'cu124', 'rocm', 'xpu', 'mps', 'cpu']
    for (const c of channels) {
      expect(src).toContain(`'${c}'`)
    }
    expect(src).toContain('TorchChannel')
  })
})

// ============ NodePack statuses ============
describe('node pack statuses', () => {
  it('all statuses are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const statuses = [
      'installed',
      'update-available',
      'disabled',
      'error',
      'not-installed',
      'installing'
    ]
    for (const s of statuses) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('NodePackStatus')
  })
})

// ============ Download statuses ============
describe('download statuses', () => {
  it('all statuses are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const statuses = ['queued', 'running', 'paused', 'done', 'error', 'cancelled']
    for (const s of statuses) {
      expect(src).toContain(`'${s}'`)
    }
  })
})

// ============ Instance statuses ============
describe('instance statuses', () => {
  it('all statuses are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const statuses = ['stopped', 'starting', 'running', 'error', 'unknown']
    for (const s of statuses) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('InstanceStatus')
  })
})

// ============ Doctor severities ============
describe('doctor severities', () => {
  it('all severities are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const sevs = ['pass', 'warn', 'fail', 'info']
    for (const s of sevs) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('DoctorSeverity')
  })
})

// ============ Security level values ============
describe('security levels', () => {
  it('all levels are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const levels = ['strong', 'normal', 'normal-', 'weak']
    for (const l of levels) {
      expect(src).toContain(`'${l}'`)
    }
  })
})

// ============ Network modes ============
describe('network modes', () => {
  it('all modes are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const modes = ['public', 'private', 'offline', 'personal_cloud']
    for (const m of modes) {
      expect(src).toContain(`'${m}'`)
    }
  })
})

// ============ Proxy protocols ============
describe('proxy protocols', () => {
  it('all protocols are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const protocols = ['http', 'https', 'socks5']
    for (const p of protocols) {
      expect(src).toContain(`'${p}'`)
    }
    expect(src).toContain('ProxyProtocol')
  })
})

// ============ Seed modes ============
describe('seed modes', () => {
  it('all modes are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const modes = ['random', 'increment', 'fixed']
    for (const m of modes) {
      expect(src).toContain(`'${m}'`)
    }
    expect(src).toContain('SeedMode')
  })
})

// ============ Runtime kinds ============
describe('runtime kinds', () => {
  it('all kinds are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const kinds = ['uv', 'python', 'mingit', 'aria2']
    for (const k of kinds) {
      expect(src).toContain(`'${k}'`)
    }
    expect(src).toContain('RuntimeKind')
  })
})

// ============ Install source types ============
describe('install sources', () => {
  it('all sources are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const sources = ['local', 'registry', 'manager', 'git']
    for (const s of sources) {
      expect(src).toContain(`'${s}'`)
    }
  })
})

// ============ Model source types ============
describe('model sources', () => {
  it('all sources are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const sources = ['local', 'civitai', 'huggingface', 'imported']
    for (const s of sources) {
      expect(src).toContain(`'${s}'`)
    }
  })
})

// ============ Output asset types ============
describe('output asset types', () => {
  it('all types are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const types = ['image', 'video', 'audio', 'other']
    for (const t of types) {
      expect(src).toContain(`'${t}'`)
    }
  })
})

// ============ Workflow format types ============
describe('workflow formats', () => {
  it('all formats are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const formats = ['json', 'png', 'embed']
    for (const f of formats) {
      expect(src).toContain(`'${f}'`)
    }
  })
})

// ============ App locale types ============
describe('app locales', () => {
  it('both locales defined', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain("'zh-CN'")
    expect(src).toContain("'en-US'")
    expect(src).toContain('AppLocale')
  })
})

// ============ Notification types ============
describe('notification types', () => {
  it('all types are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const types = ['info', 'success', 'warning', 'error']
    for (const t of types) {
      expect(src).toContain(`'${t}'`)
    }
  })
})

// ============ Node issue severities ============
describe('node issue severities', () => {
  it('all severities are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const sevs = ['info', 'warning', 'error']
    for (const s of sevs) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('NodePackIssue')
  })
})

// ============ Update source types ============
describe('update source types', () => {
  it('all sources are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const sources = ['git', 'zip', 'unknown']
    for (const s of sources) {
      expect(src).toContain(`'${s}'`)
    }
    expect(src).toContain('ComfyUpdateInfo')
  })
})

// ============ Runtime origin types ============
describe('runtime origin types', () => {
  it('all origins are defined', () => {
    const src = readSrc('src/shared/types.ts')
    const origins = ['system', 'runtimes', 'missing']
    for (const o of origins) {
      expect(src).toContain(`'${o}'`)
    }
    expect(src).toContain('RuntimeComponentStatus')
  })
})
